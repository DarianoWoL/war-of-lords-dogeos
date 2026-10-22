const mongoose = require('mongoose');

// One row per (tournament, finalist) — the durable, auditable record of every VPLN prize payout
// ever made. Created by tournamentEngine.payoutFinalPrizes() the moment the Final room completes
// (see handleRoundFinished, roundNumber === 6). The unique index below is the idempotency guard: a
// payout for the same player in the same tournament edition can never be double-inserted, so the
// balance credit tied to it (see tournamentEngine.js) can never be double-applied either.
const TournamentResultsSchema = new mongoose.Schema({
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true, index: true },
  // Denormalized copy of Tournament.monthKey for cheap admin/audit queries without a populate.
  monthKey: { type: String, required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // Snapshot at payout time — survives later username changes, same pattern as
  // Tournament.participants/semifinalists and TournamentRoom.results.
  username: { type: String, required: true },
  // 1-10, taken directly from the Final TournamentRoom's results[].positionOverall — the player's
  // actual finishing placement, not re-derived here.
  placement: { type: Number, required: true, min: 1, max: 10 },
  // Paid out 100% gross — no tax is withheld (the Usługodawca is a private individual, not a
  // registered "płatnik" under art. 41 ustawy o PIT; the winner self-reports, see regulamin.html §5b).
  vplnAwarded: { type: Number, required: true, min: 0 },
  awardedAt: { type: Date, default: Date.now }
}, { timestamps: true });

TournamentResultsSchema.index({ tournamentId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('TournamentResults', TournamentResultsSchema);
