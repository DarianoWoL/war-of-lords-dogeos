// One-time, manually-run reset for the Room/Round architecture split. Run this ONCE, with the
// server stopped, when deploying that change: `node scripts/resetRoundsForRelease.js`.
//
// Wipes ALL Room and Round documents (old-shape rooms from before this change are incompatible with
// the new schema and would crash the server on read) plus the now-retired flat JSON session store.
// Deliberately does NOT touch User accounts, WoLcoin balances, Skill Points, MultiAccountIncident,
// MatchPairStat, or WoLcoinTransaction — those are historical/player data, safe to keep even with
// now-dangling roomId/roundId references.
//
// After running this, every room template must be recreated from scratch in the admin panel.
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const Room = require('../src/models/Room');
const Round = require('../src/models/Round');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/strategic_game';

async function main() {
  await mongoose.connect(MONGO_URI, {});
  console.log('Connected to', MONGO_URI);

  const roomsDeleted = await Room.deleteMany({});
  console.log('Rooms deleted:', roomsDeleted.deletedCount);

  const roundsDeleted = await Round.deleteMany({});
  console.log('Rounds deleted:', roundsDeleted.deletedCount);

  const sessionStorePath = path.resolve(__dirname, '..', 'data', 'game_sessions.json');
  if (fs.existsSync(sessionStorePath)) {
    fs.rmSync(sessionStorePath, { force: true });
    console.log('Removed legacy session store:', sessionStorePath);
  } else {
    console.log('No legacy session store file found (already clean).');
  }

  await mongoose.disconnect();
  console.log('Reset complete. Recreate room templates in the admin panel before letting players in.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Reset script failed:', err);
  process.exit(1);
});
