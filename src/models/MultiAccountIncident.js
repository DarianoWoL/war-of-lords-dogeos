const mongoose = require('mongoose');

// One document per blocked game:join attempt where the server's dual verification (hardware
// fingerprint match, or shared-IP-within-7-days match against an account already in the round)
// caught a likely multi-account. See performMultiAccountCheck in src/server.js.
const MultiAccountIncidentSchema = new mongoose.Schema({
  roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', required: true },
  // "Main" = whoever was already in the room first; "Secondary" = whoever's join attempt was
  // blocked just now. Naming is purely about detection order, not an accusation of which is the
  // "real" account.
  mainUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  mainUsername: String,
  secondaryUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  secondaryUsername: String,
  reason: { type: String, enum: ['device_id_match', 'shared_ip_history', 'pinned_hardware_id_match'], required: true },
  sharedDeviceId: { type: String, default: null },
  sharedIp: { type: String, default: null },
  detectedAt: { type: Date, default: Date.now },
  resolved: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('MultiAccountIncident', MultiAccountIncidentSchema);
