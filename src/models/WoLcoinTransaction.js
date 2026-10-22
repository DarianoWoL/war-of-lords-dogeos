const mongoose = require('mongoose');

// Append-only audit log of every WoLcoin (premiumPoints) balance change, however it happened —
// shop purchase, room entry fee, lobby refund, round reward, or a manual admin adjustment. Written
// via logWoLcoinTransaction in src/server.js right alongside the actual balance mutation, never
// read back to compute the balance itself (User.premiumPoints stays the single source of truth for
// that) — this is purely the "how did this number get here" trail for the admin panel.
const WoLcoinTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amount: { type: Number, required: true }, // positive = credited, negative = spent
  balanceAfter: { type: Number, default: null },
  reason: { type: String, required: true },
  category: {
    type: String,
    enum: ['shop_purchase', 'room_entry_fee', 'room_refund', 'round_reward', 'admin_adjustment'],
    required: true
  },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
  // Only populated for 'round_reward' — the only category that happens after a Round exists.
  // Entry-fee/refund transactions are pre-round and only ever have a roomId.
  roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', default: null },
  // Only set for 'shop_purchase' — the timestamp at which the player ticked the required
  // "I accept starting the service immediately and losing my withdrawal right" checkbox in the
  // purchase-consent modal (see public/purchase-consent-modal.js) for THIS specific transaction.
  consentAcceptedAt: { type: Date, default: null },
  at: { type: Date, default: Date.now }
}, { timestamps: true });

// Collection name pinned to the pre-rename name (this model used to be called BlitzCoinTransaction)
// so existing transaction history keeps showing up in the admin log instead of being silently
// orphaned in the old collection.
module.exports = mongoose.model('WoLcoinTransaction', WoLcoinTransactionSchema, 'blitzcointransactions');
