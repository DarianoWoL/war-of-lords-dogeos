const mongoose = require('mongoose');

// Wplaty i wyplaty DOGE (on-chain). Wplata: gracz wysyla DOGE na adres gry i zglasza hash
// transakcji - saldo rosnie dopiero, gdy administrator potwierdzi ja w sieci (status completed).
// Wyplata: saldo jest pobierane od razu przy zgloszeniu, administrator wysyla DOGE i wpisuje hash;
// odrzucona wyplata (failed) zwraca kwote na saldo.
const DogeTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  username: { type: String, required: true },
  type: { type: String, enum: ['deposit', 'withdrawal'], required: true },
  amount: { type: Number, required: true, min: 0 },
  txHash: { type: String, default: null, trim: true, lowercase: true },
  // Wyplata: adres gracza. Wplata: adres gry, na ktory gracz wyslal DOGE.
  address: { type: String, default: null, trim: true },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending', index: true },
  // Wyplata: oswiadczenia gracza (jak przy dawnych wyplatach VPLN na konto bankowe).
  taxResponsibilityAcknowledgedAt: { type: Date, default: null },
  ageConfirmationType: { type: String, enum: ['ADULT', 'GUARDIAN_CONSENT', null], default: null },
  processedAt: { type: Date, default: null },
  processedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  adminNote: { type: String, default: null }
}, { timestamps: true });

// Jeden hash = jedna transakcja (nie da sie zglosic tej samej wplaty dwa razy).
DogeTransactionSchema.index({ txHash: 1 }, { unique: true, partialFilterExpression: { txHash: { $type: 'string' } } });

module.exports = mongoose.model('DogeTransaction', DogeTransactionSchema);
