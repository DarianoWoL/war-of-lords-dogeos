// Jednorazowe przeliczenie waluty gry z VPLN (1 VPLN = 1 zl) na DOGE.
//
//   node scripts/migrate-vpln-to-doge.js --rate 2.5           -> tylko podglad, nic nie zmienia
//   node scripts/migrate-vpln-to-doge.js --rate 2.5 --apply   -> zapisuje zmiany
//
// --rate = ile DOGE za 1 VPLN (czyli za 1 zl). Przeliczane jest wszystko, co bylo kwota w VPLN/zl:
//  - salda graczy: vplnBalance -> dogeBalance (vplnBalance = 0), konto systemowe "Skarbiec VPLN" -> "Skarbiec DOGE",
//  - ustawienia: cena Biletu do Mini-Turnieju, minimalna wyplata, domyslna cena Biletu Turniejowego,
//    nagroda pocieszenia rankingu (10) i nagroda za polecenia (10),
//  - nagrody w pokojach Mini-Turniejow,
//  - cena biletu i nagrody turniejow, ktore jeszcze sie nie zakonczyly (status inny niz COMPLETED).
// Historia (wyplacone nagrody, zamowienia, dawne wyplaty) zostaje w VPLN - to zapis tego, co sie stalo.
// Skrypt mozna wykonac tylko raz (Settings.vplnToDogeMigratedAt). Przed --apply zrob kopie bazy (mongodump).
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Room = require('../src/models/Room');
const Tournament = require('../src/models/Tournament');
const { getSettings } = require('../src/models/Settings');
const { roundDoge } = require('../src/doge');

const DEFAULT_TICKET_PRICE = 10; // DEFAULT_TICKET_PRICE_PLN w server.js
const DEFAULT_FIXED_REWARD = 10; // nagroda pocieszenia rankingu i za polecenia (dawniej 10 VPLN na sztywno)

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const rate = Number(argValue('--rate'));
  const apply = process.argv.includes('--apply');
  if (!Number.isFinite(rate) || rate <= 0) {
    console.error('Podaj kurs: --rate <ile DOGE za 1 VPLN>, np. --rate 2.5');
    process.exit(1);
  }
  const conv = (value) => roundDoge((Number(value) || 0) * rate);
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/strategic_game');

  const settings = await getSettings();
  if (settings.vplnToDogeMigratedAt) {
    console.error(`Przeliczenie bylo juz wykonane ${settings.vplnToDogeMigratedAt.toISOString()} (kurs ${settings.vplnToDogeRate}). Przerywam.`);
    process.exit(1);
  }

  console.log(`Kurs: 1 VPLN = ${rate} DOGE. Tryb: ${apply ? 'ZAPIS' : 'podglad (dodaj --apply, aby zapisac)'}\n`);

  // 1. Salda graczy
  const holders = await User.find({ vplnBalance: { $ne: 0 } }).select('username vplnBalance dogeBalance isSystemAccount');
  let totalVpln = 0;
  let totalDoge = 0;
  for (const u of holders) {
    const added = conv(u.vplnBalance);
    totalVpln += u.vplnBalance;
    totalDoge += added;
    if (apply) {
      await User.updateOne({ _id: u._id, vplnBalance: u.vplnBalance }, { $inc: { dogeBalance: added }, $set: { vplnBalance: 0 } });
    }
  }
  console.log(`Salda: ${holders.length} kont, ${totalVpln} VPLN -> ${roundDoge(totalDoge)} DOGE`);
  holders.slice(0, 10).forEach((u) => console.log(`  ${u.username}: ${u.vplnBalance} VPLN -> +${conv(u.vplnBalance)} DOGE`));
  if (holders.length > 10) console.log(`  ... i ${holders.length - 10} wiecej`);
  const bank = await User.findOne({ isSystemAccount: true, username: 'Skarbiec VPLN' }).select('_id');
  if (bank) {
    console.log('Konto systemowe: "Skarbiec VPLN" -> "Skarbiec DOGE"');
    if (apply) await User.updateOne({ _id: bank._id }, { $set: { username: 'Skarbiec DOGE' } });
  }

  // 2. Ustawienia
  const newSettings = {
    miniTournamentTicketPricePLN: conv(settings.miniTournamentTicketPricePLN),
    minWithdrawalVpln: conv(settings.minWithdrawalVpln || 100),
    tournamentTicketPriceDoge: conv(DEFAULT_TICKET_PRICE),
    freeRankingConsolationDoge: conv(DEFAULT_FIXED_REWARD),
    referralRewardDoge: conv(DEFAULT_FIXED_REWARD)
  };
  console.log('\nUstawienia:');
  console.log(`  cena Biletu do Mini-Turnieju: ${settings.miniTournamentTicketPricePLN} zl -> ${newSettings.miniTournamentTicketPricePLN} DOGE`);
  console.log(`  minimalna wyplata: ${settings.minWithdrawalVpln || 100} VPLN -> ${newSettings.minWithdrawalVpln} DOGE`);
  console.log(`  domyslna cena Biletu Turniejowego: ${DEFAULT_TICKET_PRICE} zl -> ${newSettings.tournamentTicketPriceDoge} DOGE`);
  console.log(`  nagroda pocieszenia / za polecenia: ${DEFAULT_FIXED_REWARD} VPLN -> ${newSettings.freeRankingConsolationDoge} DOGE`);

  // 3. Pokoje Mini-Turniejow
  const rooms = await Room.find({
    $or: [{ 'miniTournamentPrizes.place1VPLN': { $gt: 0 } }, { 'miniTournamentPrizes.place2VPLN': { $gt: 0 } }, { 'miniTournamentPrizes.place3VPLN': { $gt: 0 } }]
  }).select('roomName miniTournamentPrizes');
  console.log(`\nPokoje z nagrodami: ${rooms.length}`);
  for (const room of rooms) {
    const p = room.miniTournamentPrizes;
    const next = { place1VPLN: conv(p.place1VPLN), place2VPLN: conv(p.place2VPLN), place3VPLN: conv(p.place3VPLN) };
    console.log(`  ${room.roomName}: ${p.place1VPLN}/${p.place2VPLN}/${p.place3VPLN} -> ${next.place1VPLN}/${next.place2VPLN}/${next.place3VPLN} DOGE`);
    if (apply) {
      await Room.updateOne({ _id: room._id }, { $set: {
        'miniTournamentPrizes.place1VPLN': next.place1VPLN,
        'miniTournamentPrizes.place2VPLN': next.place2VPLN,
        'miniTournamentPrizes.place3VPLN': next.place3VPLN
      } });
    }
  }

  // 4. Turnieje, ktore sie jeszcze nie zakonczyly
  const tournaments = await Tournament.find({ status: { $ne: 'COMPLETED' } }).select('name status ticketPricePLN prizesConfig');
  console.log(`\nTurnieje w toku / zaplanowane: ${tournaments.length}`);
  for (const t of tournaments) {
    const pc = t.prizesConfig || {};
    const set = {
      'prizesConfig.place1VPLN': conv(pc.place1VPLN),
      'prizesConfig.place2VPLN': conv(pc.place2VPLN),
      'prizesConfig.place3VPLN': conv(pc.place3VPLN),
      'prizesConfig.place4to10VPLN': conv(pc.place4to10VPLN)
    };
    if (t.ticketPricePLN) set.ticketPricePLN = conv(t.ticketPricePLN);
    console.log(`  ${t.name || t._id} (${t.status}): bilet ${t.ticketPricePLN || '-'} -> ${set.ticketPricePLN || '-'}, nagrody ${pc.place1VPLN}/${pc.place2VPLN}/${pc.place3VPLN}/${pc.place4to10VPLN} -> ${set['prizesConfig.place1VPLN']}/${set['prizesConfig.place2VPLN']}/${set['prizesConfig.place3VPLN']}/${set['prizesConfig.place4to10VPLN']} DOGE`);
    if (apply) await Tournament.updateOne({ _id: t._id }, { $set: set });
  }

  if (apply) {
    Object.assign(settings, newSettings, { vplnToDogeRate: rate, vplnToDogeMigratedAt: new Date() });
    await settings.save();
    console.log('\nZapisano. Waluta gry: DOGE.');
  } else {
    console.log('\nPodglad - nic nie zostalo zmienione.');
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
