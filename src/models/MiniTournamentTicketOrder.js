const mongoose = require('mongoose');

// Mini-Tournament equivalent of TicketOrder.js — deliberately a separate model (not a generalized
// TicketOrder with a product discriminator) so the existing Monthly Tournament ticket flow can never
// be affected by anything here. Always quantity 1 (a player can only ever hold ONE unused ticket at
// a time, see User.hasUnusedMiniTournamentTicket), so there's no `quantity` field.
const MiniTournamentTicketOrderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  grossAmountZl: { type: Number, required: true },
  currency: { type: String, default: 'PLN' },
  hotpayPaymentId: { type: String, default: null, index: true },
  status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending', index: true },
  paidAt: { type: Date, default: null },
  lastHotpayStatus: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('MiniTournamentTicketOrder', MiniTournamentTicketOrderSchema);
