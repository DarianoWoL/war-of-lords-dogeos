// Authoritative, server-only game round manager. Exactly one in-memory `state` object exists per
// active ROUND (never one per connected browser, and never one per Room template) — this is the
// single source of truth for villages, players, attacks and reports for that one specific match.
// Clients never mutate it directly; they send commands over Socket.io (see the io.on('connection',
// ...) handlers in server.js) and only ever render whatever this module broadcasts back.
//
// Backed by the Round Mongo model (src/models/Round.js) instead of a flat JSON file — every
// persist() replaces that round's entire `state` field via a plain `updateOne` (not a fetched
// Mongoose document + .save()), which sidesteps the well-known Mixed-field "in-place mutation isn't
// auto-detected" pitfall entirely, since updateOne always sends the full $set payload regardless of
// Mongoose's change tracking.
const GameEngine = require('../public/gameEngine.js');
const Round = require('./models/Round');
const TeamMapLayout = require('./models/TeamMapLayout');

// roundId -> live authoritative state
const sessions = new Map();

// Admin-editable village position overrides for the team map (see the map editor in admin.html +
// PUT /api/admin/team-map-layout in server.js) — applied ON TOP of GameEngine's own hardcoded
// defaults, matched by village id, so an unsaved/never-edited node just keeps its built-in position.
async function loadTeamMapNodesWithOverrides() {
  const defaults = GameEngine.createTeamMapNodes();
  const override = await TeamMapLayout.findOne().lean();
  if (!override || !Array.isArray(override.nodes) || !override.nodes.length) return defaults;
  const overrideById = new Map(override.nodes.map((n) => [n.id, n]));
  return defaults.map((node) => {
    const o = overrideById.get(node.id);
    return o ? { ...node, x: o.x, y: o.y } : node;
  });
}

function buildPlayerFromWaitingEntry(entry, index, roomType) {
  const isTeamMode = roomType === 'team';
  const teamId = isTeamMode && Number.isFinite(Number(entry.teamId)) ? Number(entry.teamId) : null;
  return {
    userId: entry.userId ? entry.userId.toString() : null,
    name: entry.username,
    // Team mode: every member of a team shares ONE color (see GameEngine.colorForTeam) instead of
    // each player getting their own — that's how the client visually shows "same team" on the map.
    color: isTeamMode ? GameEngine.colorForTeam(teamId) : (entry.color || GameEngine.colorForSlot(index)),
    teamId,
    isBot: !!entry.isBot,
    points: 0,
    kills: 0,
    killsAsAttacker: 0,
    killsAsDefender: 0,
    gold: GameEngine.STARTING_GOLD
  };
}

// Called exactly once, right after a Round document is created (the moment a room's waiting-queue
// threshold is reached) — this is the ONLY place villages get randomly assigned to players, see
// GameEngine.assignVillagesToPlayers for why doing this per-client used to corrupt the shared map.
function createSessionState(round, waitingPlayers, teamMapNodes) {
  const isTeamMode = round.roomType === 'team';
  const villages = isTeamMode ? GameEngine.createTeamVillages() : GameEngine.createDefaultVillages();
  if (!isTeamMode) GameEngine.ensureSubVillages(villages);
  const state = {
    roundId: round._id.toString(),
    roomId: round.roomId.toString(),
    roomName: round.roomName,
    roundStatus: 'active',
    isTrial: !!round.isTrial,
    // 'team' (50 main villages, no subs, shared team colors/support) vs 'classic' (today's 10 main
    // + 20 sub villages) — read by GameEngine.sendSupport and by ensureSubVillages/hydration below
    // so team-mode sessions never get sub-villages conjured onto their W1..W50 ids.
    mapType: isTeamMode ? 'team' : 'classic',
    players: (waitingPlayers || []).map((entry, index) => buildPlayerFromWaitingEntry(entry, index, round.roomType)),
    villages,
    // Team mode: `teamMapNodes` (pre-fetched in startSession, since Mongo lookups are async and this
    // function isn't) already has any admin map-editor overrides merged in; falls back to
    // GameEngine's own defaults if the caller didn't pass any (e.g. direct createSessionState calls
    // in tests).
    mapNodes: isTeamMode ? (teamMapNodes || GameEngine.createTeamMapNodes()) : GameEngine.createDefaultMapNodes(),
    attacks: [],
    reports: [],
    // Snapshotted once at round start purely so the server's behavioral/win-trading detection
    // (processConquestReports in server.js) can tell whether a village capture happened in the
    // round's final stretch, without re-fetching the Round document on every tick.
    roundStartedAt: round.roundStartedAt ? new Date(round.roundStartedAt).getTime() : Date.now(),
    roundEndsAt: round.roundEndsAt ? new Date(round.roundEndsAt).getTime() : null,
    // Monthly Tournament rounds only (see src/tournamentEngine.js) — every other room leaves this
    // unset, which GameEngine treats as 1 (no change to build/recruit/travel/gold pacing).
    timeScaleFactor: Number(round.timeScaleFactor) || 1
  };
  if (isTeamMode) GameEngine.assignVillagesToPlayersTeamMode(state);
  else GameEngine.assignVillagesToPlayers(state);
  return state;
}

// Rebuilds the in-memory state from a Round document's own persisted `state` field — used after a
// server restart (Round IS the durable store now, no separate disk file to fall back to).
function hydrateFromRound(round) {
  const saved = round.state;
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.players) || !saved.players.length) return null;
  const isTeamMode = round.roomType === 'team';
  const villages = saved.villages && typeof saved.villages === 'object' && Object.keys(saved.villages).length
    ? saved.villages
    : (isTeamMode ? GameEngine.createTeamVillages() : GameEngine.createDefaultVillages());
  if (!isTeamMode) GameEngine.ensureSubVillages(villages);
  Object.values(villages).forEach((village) => GameEngine.ensureVillageGarrison(village));
  return {
    roundId: round._id.toString(),
    roomId: round.roomId.toString(),
    roomName: round.roomName,
    roundStatus: round.status === 'finished' ? 'finished' : 'active',
    prizeResults: round.prizeResults || null,
    isTrial: !!round.isTrial,
    mapType: saved.mapType || (isTeamMode ? 'team' : 'classic'),
    players: saved.players,
    villages,
    mapNodes: Array.isArray(saved.mapNodes) && saved.mapNodes.length
      ? saved.mapNodes
      : (isTeamMode ? GameEngine.createTeamMapNodes() : GameEngine.createDefaultMapNodes()),
    attacks: Array.isArray(saved.attacks) ? saved.attacks : [],
    reports: Array.isArray(saved.reports) ? saved.reports : [],
    roundStartedAt: Number.isFinite(new Date(round.roundStartedAt).getTime()) ? new Date(round.roundStartedAt).getTime() : null,
    roundEndsAt: round.roundEndsAt ? new Date(round.roundEndsAt).getTime() : null,
    // Sourced fresh from the Round document itself (not from `saved`) — it's a fixed-at-creation
    // value, never mutated during play, so there's nothing to persist/restore inside `state` for it.
    timeScaleFactor: Number(round.timeScaleFactor) || 1
  };
}

async function persist(roundId) {
  const state = sessions.get(roundId);
  if (!state) return;
  try {
    await Round.updateOne({ _id: roundId }, {
      $set: {
        status: state.roundStatus === 'finished' ? 'finished' : 'active',
        state: {
          players: state.players,
          villages: state.villages,
          mapNodes: state.mapNodes,
          mapType: state.mapType,
          attacks: state.attacks,
          reports: state.reports
        }
      }
    });
  } catch (err) {
    console.error('gameSession persist error', roundId, err);
  }
}

async function startSession(round, waitingPlayers) {
  const roundId = round._id.toString();
  const teamMapNodes = round.roomType === 'team' ? await loadTeamMapNodesWithOverrides() : null;
  const state = createSessionState(round, waitingPlayers, teamMapNodes);
  sessions.set(roundId, state);
  await persist(roundId);
  return state;
}

function getSession(roundId) {
  return sessions.get(roundId) || null;
}

// Used when a browser connects/reconnects (including after a refresh) to join a round's live game,
// and when the server restarts mid-round. Every caller already has the Round document in hand
// (game:join and restoreActiveRoundTimers both fetch it first), so this is just: return the cached
// state, or rebuild it from the Round's own persisted `state` field.
function ensureSessionForRound(roundId, round) {
  let state = sessions.get(roundId);
  if (!state && round) {
    state = hydrateFromRound(round);
    if (state) sessions.set(roundId, state);
  }
  return state;
}

function endSession(roundId) {
  sessions.delete(roundId);
}

// Test/admin-only: directly overwrites points/kills stats for specific players in a LIVE round's
// in-memory state — used by the tournament simulation harness to inject synthetic performance
// numbers for bot accounts that never issue real attacks (so GameEngine.tick would otherwise leave
// them at 0 forever). Writing straight to the Round document instead of here would be pointless:
// tickAll() persists the in-memory session back over Mongo every second, so only a live-session
// mutation actually survives to round-finish time. statsByUserId: { [userId]: {points?,
// killsAsAttacker?, killsAsDefender?, kills?} }.
function setPlayerStats(roundId, statsByUserId) {
  const state = sessions.get(roundId);
  if (!state) return { applied: 0, total: Object.keys(statsByUserId).length };
  let applied = 0;
  state.players.forEach((p) => {
    const stats = statsByUserId[p.userId];
    if (!stats) return;
    if (Number.isFinite(stats.points)) p.points = stats.points;
    if (Number.isFinite(stats.killsAsAttacker)) p.killsAsAttacker = stats.killsAsAttacker;
    if (Number.isFinite(stats.killsAsDefender)) p.killsAsDefender = stats.killsAsDefender;
    if (Number.isFinite(stats.kills)) p.kills = stats.kills;
    else p.kills = (p.killsAsAttacker || 0) + (p.killsAsDefender || 0);
    applied += 1;
  });
  return { applied, total: Object.keys(statsByUserId).length };
}

// Admin-only: toggles a live player's ability to do ANYTHING (build, recruit, attack/recon,
// support, recall, claim a village) without touching their seat in the round — used as the
// tournament rooms panel's safety valve for a round that's already ACTIVE (see PUT
// /api/admin/tournament/rooms/:id/players/:userId/block in server.js), where fully removing a
// seated player isn't practical. Their villages stay fully attackable by everyone else — only their
// own actions are frozen. The flag lives directly on the player object inside `state.players`, so
// it's picked up by the existing persist()/hydrateFromRound round-trip for free — no schema change
// needed — and is read back by every player-action function in public/gameEngine.js.
function setPlayerBlockedByAdmin(roundId, userId, blocked) {
  const state = sessions.get(roundId);
  if (!state) return { ok: false, error: 'Runda nie jest obecnie aktywna w tym procesie serwera.' };
  const player = state.players.find((p) => p.userId === String(userId));
  if (!player) return { ok: false, error: 'Gracz nie znaleziony w tej rundzie.' };
  player.blockedByAdmin = !!blocked;
  return { ok: true };
}

async function finishSession(roundId) {
  const state = sessions.get(roundId);
  if (state) {
    state.roundStatus = 'finished';
    await persist(roundId);
  }
}

// One authoritative tick for every currently-active round, called once per second by server.js.
// `onRoundTicked(roundId, state)` is invoked after each round's state changes so the caller can
// broadcast it over Socket.io. Persist is fire-and-forget here (tickAll itself is synchronous,
// driven by setInterval) — errors are logged inside persist() itself.
function tickAll(onRoundTicked) {
  sessions.forEach((state, roundId) => {
    if (state.roundStatus === 'finished') return;
    GameEngine.tick(state);
    persist(roundId);
    if (typeof onRoundTicked === 'function') onRoundTicked(roundId, state);
  });
}

module.exports = {
  startSession,
  getSession,
  ensureSessionForRound,
  endSession,
  finishSession,
  persist,
  tickAll,
  setPlayerStats,
  setPlayerBlockedByAdmin
};
