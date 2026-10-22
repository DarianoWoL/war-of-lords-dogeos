const mongoose = require('mongoose');

// Announcements shown to players in the "co nowego" popup on the main dashboard (index.html) — see
// GET /api/news/unread, POST /api/news/mark-read and User.lastNewsReadAt in server.js. Managed by
// admins via admin-news.html / POST + DELETE /api/admin/news.
const NewsItemSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  body: { type: String, required: true, trim: true, maxlength: 2000 },
  createdBy: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('NewsItem', NewsItemSchema);
