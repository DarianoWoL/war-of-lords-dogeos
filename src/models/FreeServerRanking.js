const mongoose = require('mongoose');

// A durable, once-per-month SNAPSHOT of the "Ranking Serwerów Darmowych" (Free Server Ranking) —
// the Top 5 players by Skill Points gained from regular, free Pokoje Bitewne rounds between the
// 1st of the month and the moment qualification rounds finish.
//
// IMPORTANT: this is NOT the live source of truth for that ranking day-to-day — the live,
// continuously-updated version is User.regularRoundsMmrPoints (monthly-scoped, accumulated in
// payoutRoundRewards, src/server.js), queried on demand via getMmrWindowLeaderboard(). This
// collection only ever gets written ONCE per month, at the exact moment
// tournamentEngine.finalizeQualifications() freezes the Top 5 for that month's semifinal
// selection (see Tournament.semifinalists, source: 'freeServerRanking') — it exists purely so that
// month's frozen semifinal-qualifying snapshot survives even if regular play continues afterward
// and shuffles the live leaderboard around. Think of it as an audit/history record, not a query
// target for "what's the ranking right now".
const FreeServerRankingSchema = new mongoose.Schema({
  monthKey: { type: String, required: true },
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  snapshotAt: { type: Date, default: Date.now },
  entries: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    rank: { type: Number, required: true }, // 1-5
    pointsGained: { type: Number, required: true } // regularRoundsMmrPoints at snapshot time
  }]
}, { timestamps: true });

FreeServerRankingSchema.index({ monthKey: 1 }, { unique: true });

module.exports = mongoose.model('FreeServerRanking', FreeServerRankingSchema);
