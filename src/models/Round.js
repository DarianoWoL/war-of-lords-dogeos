const mongoose = require('mongoose');

// A single, independent battle instance spawned from a Room template once its waiting queue fills
// up — see performRoomJoin/startCountdown in src/server.js. Many Rounds from the same roomId can be
// active simultaneously; ending one never touches the Room or any other Round. Metadata needed for
// admin listing/filters are real schema fields; the actual authoritative game state (villages,
// attacks, reports, live player stats) is one opaque `state` blob, mirroring exactly what
// src/gameSession.js builds/ticks — kept as Mixed so nothing GameEngine dynamically adds to a player
// object (villageId, aiProfile, nextAttackAt, pointsAchievedAt, hasLeft...) is ever silently dropped
// by a rigid sub-schema. Mongoose does NOT auto-detect in-place mutation of a Mixed field — every
// write to `state` must either reassign it wholesale or call `.markModified('state')` first.
const RoundSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  roomName: { type: String, required: true },
  roomType: { type: String, enum: ['standard', 'percentage', 'team'], default: 'standard' },
  entryFee: { type: Number, default: 0 },
  // Snapshot of the room's settings at the moment this round started — a later edit to the Room
  // template must never retroactively change an in-progress round's rules.
  settings: {
    dlugoscRundySekundy: { type: Number, default: 3600 },
    modyfikatorCzasuEkonomii: { type: Number, default: 0 },
    modyfikatorCzasuWojska: { type: Number, default: 0 },
    nagrodaTop1: { type: Number, default: 500 },
    nagrodaTop2: { type: Number, default: 250 },
    nagrodaTop3: { type: Number, default: 100 },
    nagrodaAgresor: { type: Number, default: 300 }
  },
  status: { type: String, enum: ['active', 'finished'], default: 'active', index: true },
  // The one-time free practice round against bots (see POST /api/trial/start) — no entry fee, no
  // WoLcoin payout, no Skill Points change on finish OR on forfeit, purely for trying the game.
  isTrial: { type: Boolean, default: false },
  // Snapshot of the parent Room's isTournament flag (see Room.js) — copied once at round start in
  // startCountdown so admin's "Rundy Turniejowe" listing keeps working even if the Room template is
  // edited/deleted later.
  isTournament: { type: Boolean, default: false },
  // Same snapshot idea, for the parent Room's isMiniTournament flag — used by payoutRoundRewards in
  // server.js to exclude Mini-Turniej rounds from the overall Skill Points / Ranking Ogólny, exactly
  // like isTournament above already excludes Monthly Tournament qualification rounds.
  isMiniTournament: { type: Boolean, default: false },
  // Set only by src/tournamentEngine.js (roundDurationMinutes / 120) when it creates a Monthly
  // Tournament round — read by public/gameEngine.js (via src/gameSession.js) to proportionally
  // speed up or slow down every timed mechanic (building, recruiting, travel, gold) for that round
  // only. Every other round (including old ad-hoc admin-turnieje.html tournament rooms) stays at
  // the default 1 = unaffected.
  timeScaleFactor: { type: Number, default: 1 },
  // Persisted copy of whatever runRoundFinishHooks (server.js) returned when this round ended —
  // without this, a client that loads/reloads game.html AFTER the round already finished (a
  // disconnect, a late tab, a refresh) would rebuild its state purely from hydrateFromRound
  // (gameSession.js) and never see the prize breakdown that was only ever attached to the one-time
  // live `game:state` broadcast at the moment of ending.
  prizeResults: { type: mongoose.Schema.Types.Mixed, default: null },
  poolPP: { type: Number, default: 0 },
  roundStartedAt: { type: Date, default: Date.now },
  roundEndsAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  state: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
}, { timestamps: true });

module.exports = mongoose.model('Round', RoundSchema);
