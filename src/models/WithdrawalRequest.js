const mongoose = require('mongoose');

// One document per player request to convert VPLN balance into a real bank transfer. The VPLN
// amount is debited from the player's vplnBalance ATOMICALLY at request time (see POST
// /api/withdrawals/request in server.js, findOneAndUpdate with a vplnBalance $gte guard) — not
// when an admin later processes it — so a player can never spend/withdraw the same VPLN twice
// while a request is pending.
//
// Paid out at 100% gross — the Usługodawca (a private individual, not registered as a business) is
// not a "płatnik" under art. 41 ustawy o PIT and has no legal standing to withhold tax or file
// PIT-8AR. Full tax responsibility sits with the winner (art. 20 ust. 1 ustawy o PIT — przychód z
// innych źródeł, self-reported on their own annual PIT-37/PIT-36) — see regulamin.html §5b.
// taxResponsibilityAcknowledgedAt/transferTitle below exist specifically to document that shift of
// responsibility, protecting the Usługodawca if it's ever questioned.
//
// There is no payment-gateway integration for outbound bank transfers — an admin executes the real
// transfer manually (bank details are captured below) and then marks the request COMPLETED or, if
// something is wrong (bad account details, suspected fraud, etc.), REJECTED — which refunds the
// vplnAmount back onto the player's balance.
const WithdrawalRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // Snapshot at request time — survives later username changes, same pattern as TournamentResults.
  username: { type: String, required: true },
  vplnAmount: { type: Number, required: true, min: 1 },
  bankAccountNumber: { type: String, required: true, trim: true },
  accountHolderName: { type: String, required: true, trim: true },
  // Suggested bank transfer title, computed once at request time (see POST /api/withdrawals/request)
  // — e.g. "Wypłata wygranej w grze War of Lords - login: Nick123". Shown to the admin in
  // admin-wyplaty.html so every real transfer carries the player's login for traceability.
  transferTitle: { type: String, required: true },
  // Timestamp of the player explicitly ticking the "I understand I must self-report this winning on
  // my own annual PIT return" checkbox for THIS specific request (see profile.html) — required,
  // never null; the durable proof that the player was informed each time they cashed out.
  taxResponsibilityAcknowledgedAt: { type: Date, required: true },
  // Legal-capacity declaration required for every withdrawal (real bank transfer) — a minor (16-17)
  // has limited legal capacity under Polish civil law (art. 10-22 KC), so the request must be
  // explicitly attributed to either an adult acting for themselves, or a legal guardian consenting
  // on a minor's behalf. Mutually exclusive by design (radio choice, not a checkbox) — see
  // profile.html. ageConfirmedAt is the durable proof this declaration was made for THIS request.
  ageConfirmationType: { type: String, enum: ['ADULT', 'GUARDIAN_CONSENT'], required: true },
  ageConfirmedAt: { type: Date, required: true },
  status: { type: String, enum: ['PENDING', 'COMPLETED', 'REJECTED'], default: 'PENDING', index: true },
  requestedAt: { type: Date, default: Date.now },
  processedAt: { type: Date, default: null },
  processedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Required when rejecting (shown to the player), optional free-text note when completing (e.g.
  // bank transfer reference number) — see PUT /api/admin/withdrawals/:id/complete|reject.
  adminNote: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('WithdrawalRequest', WithdrawalRequestSchema);
