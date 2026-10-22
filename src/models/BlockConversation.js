const mongoose = require('mongoose');

// One thread per account, used while (or after) they're blocked: the reason is shown separately
// from User.blockReason, this only holds the back-and-forth messages between the player and admin —
// see GET/POST /api/me/block-status* and the admin mailbox endpoints in src/server.js.
const BlockConversationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  username: String,
  messages: [{
    sender: { type: String, enum: ['player', 'admin'], required: true },
    text: { type: String, required: true },
    at: { type: Date, default: Date.now }
  }],
  // Set whenever the player sends a new message, cleared once an admin replies or opens the thread —
  // drives the unread badge on the admin panel's mailbox button.
  hasUnreadFromPlayer: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('BlockConversation', BlockConversationSchema);
