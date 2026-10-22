const mongoose = require('mongoose');

// Audit trail of the flat VPLN consolation prize paid to the Top 5 of the Free-Server-Ranking's
// CURRENT window at calendar month-end (see grantFreeRankingConsolationPrize in server.js). That
// window is either:
//   - the "trailing days" after a tournament's qualification rounds finish that month — see
//     tournamentEngine.finalizeQualifications(), which locks in the semifinal wildcards from
//     User.regularRoundsMmrPoints and then resets it to 0 so this separate prize can never reward
//     the exact same rounds twice, or
//   - the whole calendar month's points, in a month where no tournament ever ran (the reset above
//     never happened, so nothing else has consumed those points yet).
// One row per (monthKey, player); the unique index is the idempotency guard against a retried
// grant double-crediting the same player — same pattern as MiniTournamentResults.js.
const FreeRankingConsolationResultsSchema = new mongoose.Schema({
  monthKey: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  rank: { type: Number, required: true, min: 1, max: 5 },
  pointsGained: { type: Number, required: true },
  // Paid out 100% gross — no tax is withheld (see MiniTournamentResults.js's identical comment).
  vplnAwarded: { type: Number, required: true, min: 0 },
  awardedAt: { type: Date, default: Date.now }
}, { timestamps: true });

FreeRankingConsolationResultsSchema.index({ monthKey: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('FreeRankingConsolationResults', FreeRankingConsolationResultsSchema);
