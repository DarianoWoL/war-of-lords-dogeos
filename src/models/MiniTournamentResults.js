const mongoose = require('mongoose');

// Audit trail of every Mini-Tournament VPLN prize payout — one row per (round, player). Created by
// the mini-tournament round-finish hook in server.js right after a round belonging to an
// isMiniTournament Room finishes. The unique index is the idempotency guard: a retried/duplicate
// payout attempt for the same player in the same round can never double-insert, so the balance
// credit tied to it can never be double-applied either — same pattern as TournamentResults.js.
const MiniTournamentResultsSchema = new mongoose.Schema({
  roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', required: true, index: true },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  username: { type: String, required: true },
  placement: { type: Number, required: true, min: 1, max: 3 },
  // Paid out 100% gross — no tax is withheld (see TournamentResults.js's identical comment).
  vplnAwarded: { type: Number, required: true, min: 0 },
  awardedAt: { type: Date, default: Date.now }
}, { timestamps: true });

MiniTournamentResultsSchema.index({ roundId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('MiniTournamentResults', MiniTournamentResultsSchema);
