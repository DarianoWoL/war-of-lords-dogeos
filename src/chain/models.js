// Modele Mongo dla integracji z DogeOS testnet (patrz src/chain/index.js).
const mongoose = require('mongoose');
const { Schema } = mongoose;

// Voucher EIP-712 wydany graczowi przez serwer (bilet / zaklad) - kazdy dziala raz (nonce).
const ChainVoucher = mongoose.model('ChainVoucher', new Schema({
  nonce: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, enum: ['monthly', 'mini', 'bet'], required: true },
  marketId: { type: String, default: null },
  outcome: { type: String, default: null },
  amountWei: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null }
}, { timestamps: true }));

// Zdarzenia kontraktu przetworzone przez serwer (idempotentnie: txHash + logIndex).
const ChainEvent = mongoose.model('ChainEvent', new Schema({
  txHash: { type: String, required: true },
  logIndex: { type: Number, required: true },
  name: { type: String, required: true },
  blockNumber: { type: Number, required: true },
  args: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true }).index({ txHash: 1, logIndex: 1 }, { unique: true }));

const ChainState = mongoose.model('ChainState', new Schema({
  key: { type: String, unique: true },
  lastBlock: { type: Number, default: 0 }
}));

// Rynek zakladow: kto wygra dana runde turniejowa.
const ChainMarket = mongoose.model('ChainMarket', new Schema({
  marketId: { type: String, required: true, unique: true }, // bytes32 hex
  roundId: { type: String, required: true, index: true },
  title: { type: String, required: true },
  outcomes: [{ _id: false, outcome: String, userId: String, username: String }],
  status: { type: String, enum: ['opening', 'open', 'closed', 'resolved', 'cancelled'], default: 'opening', index: true },
  closesAt: { type: Date, required: true },
  roundEndsAt: { type: Date, default: null },
  result: { type: Schema.Types.Mixed, default: null },
  bonusCap: { type: Number, default: 0 }, // max bonus zwyciezcy gry (DOGE) = polowa pierwszej nagrody
  winnerOutcome: { type: String, default: null },
  winnerName: { type: String, default: null },
  txs: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true }));

const ChainBet = mongoose.model('ChainBet', new Schema({
  marketId: { type: String, required: true, index: true },
  bettor: { type: String, required: true, index: true }, // adres
  userId: { type: String, default: null },
  outcome: { type: String, required: true },
  amountWei: { type: String, required: true },
  txHash: { type: String, required: true },
  logIndex: { type: Number, required: true }
}, { timestamps: true }).index({ txHash: 1, logIndex: 1 }, { unique: true }));

// Nagrody zaksiegowane w kontrakcie (albo - gdy gracz bez portfela / pula pusta - na saldzie gry).
const ChainPrize = mongoose.model('ChainPrize', new Schema({
  ref: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  username: String,
  address: { type: String, default: null },
  placement: Number,
  amountGame: Number,
  amountWei: { type: String, default: '0' },
  where: { type: String, enum: ['chain', 'balance'], required: true },
  txHash: { type: String, default: null }
}, { timestamps: true }));

module.exports = { ChainVoucher, ChainEvent, ChainState, ChainMarket, ChainBet, ChainPrize };
