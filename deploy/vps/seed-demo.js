// Zasiewa baze wersji demo (wol_dogeos) na VPS: ustawienia, pokoje mini-turniejowe i konto admina z portfelem wlasciciela.
// Uruchamiane przez deploy.sh:  ADMIN_WALLET=0x... node deploy/vps/seed-demo.js
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));

  // ustawienia: zerujemy liczniki sprzedazy, reszta jak lokalnie (cena biletu mini 20, sklep wlaczony)
  const settings = read('seed-settings.json');
  Object.assign(settings, { tournamentTicketsSoldThisMonth: 0, miniTournamentTicketsSoldThisMonth: 0, hotpayRevenueThisMonthPLN: 0 });
  await db.collection('settings').updateOne({ singleton: 'main' }, { $set: settings }, { upsert: true });

  // pokoje mini-turniejowe (tylko gdy jeszcze ich nie ma)
  for (const room of read('seed-rooms.json')) {
    if (await db.collection('rooms').findOne({ roomName: room.roomName })) continue;
    delete room._id;
    await db.collection('rooms').insertOne({ ...room, waitingPlayers: [], createdAt: new Date(), updatedAt: new Date() });
    console.log('pokoj dodany:', room.roomName);
  }

  // boty demo (Demo_*): zawsze czyste statystyki - graja tylko na prosbe gracza i nigdy nie trafiaja do rankingow
  const reset = await db.collection('users').updateMany({ username: /^Demo_/ }, { $set: { roundsPlayed: 0, roundsWon: 0, skillPoints: 1200, tournamentMMR: 1000, qualificationPoints: 0, qualificationRoundUses: 0, regularRoundsMmrPoints: 0 } });
  console.log('boty demo wyzerowane:', reset.modifiedCount);

  // pokoje testowe do usuniecia (seed-remove-rooms.json) - tylko gdy nie trwa w nich runda
  const removeList = fs.existsSync(path.join(__dirname, 'seed-remove-rooms.json')) ? read('seed-remove-rooms.json') : [];
  for (const name of removeList) {
    const room = await db.collection('rooms').findOne({ roomName: name });
    if (!room) continue;
    const active = await db.collection('rounds').countDocuments({ status: 'active', roomName: name });
    if (active) { console.log('pokoj NIE usuniety (trwa runda):', name); continue; }
    await db.collection('rooms').deleteOne({ _id: room._id });
    console.log('pokoj usuniety:', name);
  }

  // konto admina Dariano z portfelem wlasciciela (logowanie tylko portfelem; haslo losowe i nieuzywane)
  const wallet = String(process.env.ADMIN_WALLET || '').toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(wallet)) {
    const now = new Date();
    const exists = await db.collection('users').findOne({ username: 'Dariano' });
    if (!exists) {
      await db.collection('users').insertOne({
        username: 'Dariano', passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10), walletAddress: wallet, needsUsername: false,
        isAdmin: true, isBlocked: false, isBot: false, tournamentMMR: 1000, skillPoints: 1200, dogeBalance: 0, tournamentTickets: 0,
        termsAcceptedAt: now, privacyAcceptedAt: now, createdAt: now, updatedAt: now
      });
      console.log('konto admina Dariano utworzone, portfel', wallet);
    } else console.log('konto Dariano juz istnieje');
  } else console.log('UWAGA: brak ADMIN_WALLET - konto admina nie zostalo utworzone');
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
