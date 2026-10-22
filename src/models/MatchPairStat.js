const mongoose = require('mongoose');

// One document per unordered pair of real (non-bot) players who have ever shared a round, tracking
// how often they land in the same match together and any one-sided village hand-offs between them
// (win-trading / village-gifting detection) — see recordGamesTogetherForRound / recordOneSidedCapture
// and processConquestReports in src/server.js. `pairKey` is the two userIds sorted and joined so the
// pair is looked up the same way regardless of who is "A" and who is "B" in a given round.
const MatchPairStatSchema = new mongoose.Schema({
  pairKey: { type: String, required: true, unique: true },
  userIdA: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  usernameA: String,
  userIdB: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  usernameB: String,
  // Deduplicated via the caller checking membership first, so re-processing the same round's
  // payout never double-counts.
  roundIdsTogether: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Round' }],
  oneSidedCaptures: [{
    roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round' },
    timestamp: { type: Date, default: Date.now },
    aggressorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    aggressorUsername: String,
    defenderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    defenderUsername: String,
    attackPower: Number,
    defensePower: Number,
    lateGame: Boolean
  }],
  totalOneSidedCaptures: { type: Number, default: 0 },
  lastIncidentAt: { type: Date, default: null },
  adminReviewed: { type: Boolean, default: false },
  warningIssued: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('MatchPairStat', MatchPairStatSchema);
