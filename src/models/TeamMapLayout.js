const mongoose = require('mongoose');

// Single persistent document overriding GameEngine.createTeamMapNodes()'s built-in (x,y) positions
// for the team-mode map (public/mapa druzyna.png) — lets an admin fine-tune each village marker to
// sit exactly on its hand-drawn castle icon via the map editor (admin.html), without touching code.
// Only present once a first save happens; until then every team round just uses GameEngine's own
// hardcoded defaults untouched (see mergeTeamMapNodeOverrides in src/gameSession.js).
const TeamMapLayoutSchema = new mongoose.Schema({
  nodes: [{
    id: { type: String, required: true },
    x: { type: Number, required: true },
    y: { type: Number, required: true }
  }],
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('TeamMapLayout', TeamMapLayoutSchema);
