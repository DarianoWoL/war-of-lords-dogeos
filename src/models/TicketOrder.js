const mongoose = require('mongoose');

// One document per tournament-ticket purchase attempt, created the moment the player confirms the
// consent modal and BEFORE they're redirected to HotPay — this is what the payment notification
// webhook (POST /api/payments/hotpay/notify in server.js) looks up BY ITS OWN _id (sent to HotPay
// as ID_ZAMOWIENIA at creation) to know which user/quantity to grant once HotPay confirms the money
// actually arrived. Never trust the quantity/amount from the client at notification time — only
// what was recorded here at creation.
const TicketOrderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  quantity: { type: Number, required: true },
  grossAmountZl: { type: Number, required: true },
  currency: { type: String, default: 'PLN' },
  // Only known once HotPay's notification arrives (their "Inicjalizacja płatności" response never
  // returns a payment id, only a redirect URL) — kept for support/troubleshooting and to cross-
  // reference against HotPay's own merchant panel, never used to look up the order itself.
  hotpayPaymentId: { type: String, default: null, index: true },
  // 'pending' until a notification confirms a terminal HotPay status; 'paid' is the only state
  // that has ever granted tournamentTickets — checked before granting so a retried/duplicate
  // notification for the same payment can't double-credit.
  status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending', index: true },
  paidAt: { type: Date, default: null },
  // Raw last-seen HotPay STATUS string (SUCCESS / PENDING / FAILURE) — kept for support/
  // troubleshooting ("why didn't my tickets show up"); HotPay has no endpoint to re-query it.
  lastHotpayStatus: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('TicketOrder', TicketOrderSchema);
