// Stali wirtualni gracze do testow mini-turnieju na lokalnej grze (konta Demo_*, bez prawdziwych pieniedzy).
// Dzialaja bez konca: wchodza do kolejki, akceptuja znaleziony mecz, a po zakonczeniu rundy wracaja do kolejki
// (bilet dostaja za darmo). Dzieki temu jeden prawdziwy gracz zawsze znajdzie mecz.
// Uzycie: node scripts/demo-players.js [nazwaPokoju] [liczbaBotow]
// Uwaga: liczba botow musi byc MNIEJSZA niz wielkosc grupy w pokoju (maxPlayers), inaczej zagraja same ze soba.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const mongoose = require('../../node_modules/mongoose');
const jwt = require('../../node_modules/jsonwebtoken');
const bcrypt = require('../../node_modules/bcrypt');
const { io } = require('socket.io-client');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
// Wersja demo na VPS jest zamknieta linkiem z kluczem - skrypty podaja klucz w ciasteczku.
const INVITE = process.env.INVITE_TOKEN ? { cookie: 'wol_invite=' + encodeURIComponent(process.env.INVITE_TOKEN) } : {};
const ROOM = process.argv[2] || 'Mini Turniej #1';
const COUNT = Math.min(Number(process.argv[3]) || 3, 8 - Number(process.env.NAME_OFFSET || 0));
const OFFSET = Number(process.env.NAME_OFFSET || 0);
const NAMES = ['Demo_Aldric', 'Demo_Morwen', 'Demo_Grimm', 'Demo_Elara', 'Demo_Thorne', 'Demo_Vesper', 'Demo_Kael', 'Demo_Sable'];
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const room = await db.collection('rooms').findOne({ roomName: ROOM, isMiniTournament: true });
  if (!room) throw new Error('Brak pokoju mini-turniejowego: ' + ROOM);
  const roomId = String(room._id);
  if (COUNT >= (room.maxPlayers || 10)) log(`UWAGA: ${COUNT} botow przy grupie ${room.maxPlayers} - zagraja same ze soba. Zmniejsz liczbe botow albo zwieksz maxPlayers.`);
  log(`Pokoj ${ROOM}: grupa ${room.maxPlayers}, runda ${room.settings && room.settings.dlugoscRundySekundy} s, boty: ${COUNT}`);

  const bots = [];
  for (let i = 0; i < COUNT; i += 1) {
    const username = NAMES[i + OFFSET];
    let u = await db.collection('users').findOne({ username });
    if (!u) {
      const passwordHash = await bcrypt.hash('demo-' + Math.random(), 10);
      const now = new Date();
      const r = await db.collection('users').insertOne({ username, passwordHash, tournamentMMR: 1000, skillPoints: 1200, dogeBalance: 0, tournamentTickets: 0, isAdmin: false, isBlocked: false, isBot: false, termsAcceptedAt: now, privacyAcceptedAt: now, createdAt: now, updatedAt: now });
      u = { _id: r.insertedId, username };
    }
    const id = String(u._id);
    const token = jwt.sign({ id }, process.env.JWT_SECRET || 'change_this_secret');
    const socket = io(BASE, { auth: { token }, reconnection: true, extraHeaders: INVITE });
    socket.on('connect', () => socket.emit('matchmaking:join', { id, roomId }));
    socket.on('matchmaking:matchFound', ({ matchId }) => {
      log(`${username}: znaleziono mecz, akceptuje za 2 s`);
      setTimeout(() => socket.emit('matchmaking:accept', { roomId, matchId }), 2000);
    });
    socket.on('gameStarted', (g) => log(`${username}: gra wystartowala (runda ${g.roundId})`));
    socket.on('matchmaking:removed', (m) => log(`${username}: usuniety z kolejki (${m.reason})`));
    bots.push({ username, id, token, socket });
  }

  // Co 20 s: kazdy bot, ktory nie gra i nie czeka w kolejce, dostaje bilet i wraca do kolejki.
  async function keepSearching() {
    for (const b of bots) {
      try {
        const playing = await db.collection('rounds').countDocuments({ status: 'active', 'state.players': { $elemMatch: { userId: b.id, hasLeft: { $ne: true } } } });
        if (playing) continue;
        await db.collection('users').updateOne({ _id: new mongoose.Types.ObjectId(b.id) }, { $set: { hasUnusedMiniTournamentTicket: true, tournamentMMR: 1000 } });
        const res = await fetch(`${BASE}/api/rooms/${roomId}/join`, { method: 'POST', headers: { authorization: 'Bearer ' + b.token, 'content-type': 'application/json', ...INVITE } });
        if (res.ok) {
          log(`${b.username}: wrocil do kolejki`);
          if (b.socket.connected) b.socket.emit('matchmaking:join', { id: b.id, roomId });
        }
        // 400 "juz szukasz gry" / "oczekujacy mecz" = wszystko w porzadku, bot juz jest w kolejce
      } catch (err) { log(`${b.username}: blad (${err.message}) - sprobuje ponownie`); }
    }
  }
  // Tryb ONDEMAND=1: boty NIE szukaja gry same. Wchodza do kolejki dopiero na prosbe gracza
  // (przycisk "Fill the remaining places with bots" w poczekalni zapisuje prosbe w demo_fill_requests).
  if (process.env.ONDEMAND === '1') {
    const joinBot = async (b) => {
      await db.collection('users').updateOne({ _id: new mongoose.Types.ObjectId(b.id) }, { $set: { hasUnusedMiniTournamentTicket: true, tournamentMMR: 1000 } });
      const res = await fetch(`${BASE}/api/rooms/${roomId}/join`, { method: 'POST', headers: { authorization: 'Bearer ' + b.token, 'content-type': 'application/json', ...INVITE } });
      if (res.ok && b.socket.connected) b.socket.emit('matchmaking:join', { id: b.id, roomId });
      return res.ok;
    };
    const handleRequests = async () => {
      try {
        const reqs = await db.collection('demo_fill_requests').find({ roomId, done: false }).sort({ createdAt: 1 }).toArray();
        for (const r of reqs) {
          await db.collection('demo_fill_requests').updateOne({ _id: r._id }, { $set: { done: true } });
          if (Date.now() - new Date(r.createdAt).getTime() > 60000) continue; // stara prosba - pomijamy
          let left = r.need;
          for (const b of bots) {
            if (left <= 0) break;
            const playing = await db.collection('rounds').countDocuments({ status: 'active', 'state.players': { $elemMatch: { userId: b.id, hasLeft: { $ne: true } } } });
            if (playing) continue;
            if (await joinBot(b)) { left -= 1; log(`${b.username}: wszedl do kolejki na prosbe gracza`); }
          }
          if (left > 0) log(`Brakuje ${left} wolnych botow`);
        }
      } catch (err) { log('blad obslugi prosby: ' + err.message); }
    };
    setInterval(handleRequests, 1500);
    log('Boty czekaja na prosbe gracza (tryb ONDEMAND).');
    return;
  }
  await keepSearching();
  setInterval(keepSearching, 20000);
  log('Boty pracuja. Zatrzymanie: zamknij proces node (demo-players).');
})().catch((e) => { console.error(e); process.exit(1); });
