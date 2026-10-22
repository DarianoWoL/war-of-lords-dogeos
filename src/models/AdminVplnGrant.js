const mongoose = require('mongoose');

// Manual VPLN grant by an admin for miscellaneous merit (e.g. a bug-report reward selected at the
// Administration's own discretion — see regulamin.html §1/§5b and the Discord regulamin's §4 for
// the same discretionary framing) that doesn't fit any of the automatic reward paths
// (TournamentResults, MiniTournamentResults, ReferralReward, FreeRankingConsolationResults).
// Denormalizes both usernames at creation time, matching this codebase's existing reward-ledger
// models, so /api/admin/vpln-balances and the prize-ledger export never need extra joins.
const AdminVplnGrantSchema = new mongoose.Schema({
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  targetUsername: { type: String, required: true },
  adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  adminUsername: { type: String, required: true },
  amountVpln: { type: Number, required: true },
  reason: { type: String, default: '' },
  awardedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AdminVplnGrant', AdminVplnGrantSchema);
