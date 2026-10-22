const mongoose = require('mongoose');

// One document per (tournament, round, room number) — 35 rooms x 4 qualification rounds = 140 per
// monthly tournament, PLUS roundNumber 5 (the 4 permanent semifinal rooms, roomNumber 1-4) and
// roundNumber 6 (the 1 permanent final room, roomNumber 1) once qualification wraps up — see
// tournamentEngine.seedSemifinalRooms/maybeAdvanceToFinal. Named "TournamentRoom" (not "Room") to
// avoid colliding with the existing src/models/Room.js, which is a completely different concept (a
// permanent matchmaking template players join queues on) — for rounds 1-4 a Monthly Tournament room
// is the opposite: a one-shot, pre-assigned 10-player batch that tournamentEngine.js creates and
// starts automatically, never joined manually. Rounds 5-6 DO reuse a real, permanent Room.js
// document (gameRoomId) since the 4 semifinal rooms + 1 final room are fixed/reused every month —
// this document is still the one durable bookkeeping wrapper either way (which 10 players, what
// their final TP/positions were). `roundDbId` links to the real, playable src/models/Round.js
// document (and thus to a real gameSession) once the room's round actually starts — all the real
// gameplay/combat happens there exactly like any other round.
const TournamentRoomSchema = new mongoose.Schema({
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true, index: true },
  // 1-4: qualification. 5: semifinal (roomNumber 1-4, one of the 4 permanent Półfinał rooms).
  // 6: final (roomNumber always 1, the permanent Finał room).
  roundNumber: { type: Number, required: true, min: 1, max: 6 },
  // Upper bound is deliberately not fixed at 35 — room count per round is
  // Tournament.maxParticipants/10, which is admin-configurable per month (see
  // tournamentEngine.scheduleTournament).
  roomNumber: { type: Number, required: true, min: 1 },

  // The 10 players assigned here by tournamentAssignment.assignPlayersToRooms() before the round
  // starts.
  players: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true }
  }],

  status: { type: String, enum: ['PENDING', 'ACTIVE', 'COMPLETED'], default: 'PENDING', index: true },

  // The real game Room/Round this tournament room's actual battle runs as — created the moment
  // this TournamentRoom transitions PENDING -> ACTIVE (see tournamentEngine.startRoundRoom()).
  gameRoomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
  roundDbId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', default: null },

  // Filled in at COMPLETED — one entry per player, produced by
  // tournamentScoring.computeRoomRoundResults() from the finished Round's final player stats
  // (points / killsAsAttacker / kills). This is the durable record of this room's outcome; the
  // underlying Round.state itself is not guaranteed to stay queryable forever.
  results: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    points: { type: Number, default: 0 },
    killsAsAttacker: { type: Number, default: 0 },
    killsAsDefender: { type: Number, default: 0 },
    kills: { type: Number, default: 0 },
    positionOverall: { type: Number, required: true },     // 1-10
    positionAggressor: { type: Number, required: true },   // 1-10
    positionUnitsDestroyed: { type: Number, required: true }, // 1-10
    roundTP: { type: Number, required: true },              // 90-300
    // Used as a fair, deterministic tie-break level (see tournamentScoring.compareByStatCascade) —
    // when to real money/advancement decisions need to be settled, "reached the same score a moment
    // earlier" is an explainable skill/speed criterion; an account id sort order is not.
    pointsAchievedAt: { type: Date, default: null },
    // Snapshotted from the live session at round-finish time (see handleRoundFinished) — whether
    // this player had forfeited (left) the round. payoutFinalPrizes excludes anyone with hasLeft
    // true (or whose account is isBlocked) from receiving a Final placement/prize, same way a
    // regular round's podium already excludes forfeited players elsewhere in the codebase.
    hasLeft: { type: Boolean, default: false }
  }]
}, { timestamps: true });

TournamentRoomSchema.index({ tournamentId: 1, roundNumber: 1, roomNumber: 1 }, { unique: true });

module.exports = mongoose.model('TournamentRoom', TournamentRoomSchema);
