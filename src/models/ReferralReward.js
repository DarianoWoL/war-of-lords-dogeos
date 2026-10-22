const mongoose = require('mongoose');

// One row per (referrer, milestone) — the durable, auditable record of every referral VPLN bonus
// ever paid. `milestone` is a multiple of 10 (10, 20, 30...): the Nth row means "this referrer had
// already reached N referred-players-with-a-purchased-ticket at least once". The unique index is
// the idempotency guard — see maybeGrantReferralReward in server.js, which re-derives the referrer's
// CURRENT qualifying count from User.hasBoughtMiniTournamentTicket every time a referred player buys
// a ticket, so this table (not a running counter on User) is the only thing that prevents the same
// milestone being paid twice.
const ReferralRewardSchema = new mongoose.Schema({
  referrerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  milestone: { type: Number, required: true },
  // Gross bonus (always 10) — paid out in full, no tax withheld (see TournamentResults.js's
  // identical comment).
  vplnAwarded: { type: Number, required: true, min: 0 },
  awardedAt: { type: Date, default: Date.now }
}, { timestamps: true });

ReferralRewardSchema.index({ referrerUserId: 1, milestone: 1 }, { unique: true });

module.exports = mongoose.model('ReferralReward', ReferralRewardSchema);
