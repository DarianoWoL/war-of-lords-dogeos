const mongoose = require('mongoose');

// Persistent history for the global player chat on the main dashboard (index.html). `expires: 86400`
// creates a Mongo TTL index that auto-deletes each message 24h after it was sent — so the chat
// survives server restarts/deploys, but never grows unbounded.
const GlobalChatMessageSchema = new mongoose.Schema({
  username: { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
  text: { type: String, required: true },
  at: { type: Date, default: Date.now, expires: 86400 }
});

module.exports = mongoose.model('GlobalChatMessage', GlobalChatMessageSchema);
