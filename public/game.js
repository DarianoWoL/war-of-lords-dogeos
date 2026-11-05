// Thin client renderer. This file has NO game simulation in it anymore — no gold ticking, no
// build/recruit queue processing, no combat resolution, no bot AI, and no local Math.random
// village assignment. All of that now runs exactly once, authoritatively, on the server (see
// src/gameSession.js + public/gameEngine.js). This file only:
//   1. Connects a Socket.io session bound to the logged-in account (survives refresh/reconnect).
//   2. Renders whatever `game:state` the server sends — including the local player's own village,
//      unconditionally, exactly like everyone else's.
//   3. Sends the player's intent (build, recruit, attack, ...) as a command and waits for the
//      server's confirmed state to actually show it.
const GameEngine = window.GameEngine;

const state = {
  units: GameEngine.UNIT_DEFS,
  gold: 0,
  goldPerSec: 0,
  players: [],
  villages: {},
  mapNodes: [],
  roundStatus: 'lobby',
  roundFinishedShown: false,
  rankingMode: 'points',
  // Team mode only: which team's row (if any) is currently expanded to show its per-player
  // breakdown in the ranking panel - see updateTeamRanking().
  expandedTeamId: null,
  reportsMode: 'attack',
  attacks: [],
  reports: [],
  currentVillageId: null,
  pendingAttack: null,
  mapActionContext: null,
  roundRemainingSeconds: undefined
};

let myUserId = null;

const selectors = {
  goldAmount: document.getElementById('goldAmount'),
  goldProduction: document.getElementById('goldProduction'),
  populationAmount: document.getElementById('populationAmount'),
  villageTitle: document.getElementById('villageTitle'),
  myColorSwatch: document.getElementById('myColorSwatch'),
  villagePrevBtn: document.getElementById('villagePrevBtn'),
  villageNextBtn: document.getElementById('villageNextBtn'),
  rankingList: document.getElementById('rankingList'),
  rankingPanelTitle: document.getElementById('rankingPanelTitle'),
  rankingModeToggle: document.getElementById('rankingModeToggle'),
  rankingKillsHeader: document.getElementById('rankingKillsHeader'),
  recruitTableBody: document.querySelector('#recruitTable tbody'),
  garrisonTableBody: document.querySelector('#garrisonTable tbody'),
  lordRecruitSection: document.getElementById('lordRecruitSection'),
  lordRecruitItem: document.getElementById('lordRecruitItem'),
  reinforcementsSection: document.getElementById('reinforcementsSection'),
  reinforcementsList: document.getElementById('reinforcementsList'),
  villageImage: document.getElementById('villageImage'),
  imageCard: document.getElementById('imageCard'),
  upgradeModal: document.getElementById('upgradeModal'),
  upgradeModalVillageName: document.getElementById('upgradeModalVillageName'),
  villageRenameInput: document.getElementById('villageRenameInput'),
  villageRenameBtn: document.getElementById('villageRenameBtn'),
  upgradeModalVillagePrevBtn: document.getElementById('upgradeModalVillagePrevBtn'),
  upgradeModalVillageNextBtn: document.getElementById('upgradeModalVillageNextBtn'),
  villagePointsDisplay: document.getElementById('villagePointsDisplay'),
  upgradeTableBody: document.querySelector('#upgradeTable tbody'),
  mapCanvas: document.getElementById('mapCanvas'),
  mapTooltip: document.getElementById('mapTooltip'),
  mapActionPanel: document.getElementById('mapActionPanel'),
  playerNameDisplay: document.getElementById('playerNameDisplay'),
  buildQueueList: document.getElementById('buildQueueList'),
  recruitmentQueueList: document.getElementById('recruitmentQueueList'),
  showRecruitQueueBtn: document.getElementById('showRecruitQueueBtn'),
  recruitQueueModal: document.getElementById('recruitQueueModal'),
  closeRecruitQueueModal: document.getElementById('closeRecruitQueueModal'),
  villageListModal: document.getElementById('villageListModal'),
  closeVillageListModal: document.getElementById('closeVillageListModal'),
  villageListContainer: document.getElementById('villageListContainer'),
  activeAttacksList: document.getElementById('activeAttacksList'),
  showReportsBtn: document.getElementById('showReportsBtn'),
  reportsModal: document.getElementById('reportsModal'),
  closeReportsModal: document.getElementById('closeReportsModal'),
  reportsList: document.getElementById('reportsList'),
  reportsModeAttackBtn: document.getElementById('reportsModeAttackBtn'),
  reportsModeDefenseBtn: document.getElementById('reportsModeDefenseBtn'),
  roundTimerDisplay: document.getElementById('roundTimerDisplay'),
  realTimeDisplay: document.getElementById('realTimeDisplay'),
  roundResultModal: document.getElementById('roundResultModal'),
  pointsResultsTableBody: document.querySelector('#pointsResultsTable tbody'),
  killsResultsTableBody: document.querySelector('#killsResultsTable tbody'),
  prizeResultsRow: document.getElementById('prizeResultsRow'),
  prizeResultsTableBody: document.querySelector('#prizeResultsTable tbody'),
  teamResultsRow: document.getElementById('teamResultsRow'),
  teamResultsTableBody: document.querySelector('#teamResultsTable tbody'),
  teamAggressorResultsTableBody: document.querySelector('#teamAggressorResultsTable tbody'),
  roundEndingOverlay: document.getElementById('roundEndingOverlay'),
  roundEndingCountdown: document.getElementById('roundEndingCountdown'),
  teamChatWindow: document.getElementById('teamChatWindow'),
  teamChatHeader: document.getElementById('teamChatHeader'),
  teamChatMinimizeBtn: document.getElementById('teamChatMinimizeBtn'),
  teamChatMessages: document.getElementById('teamChatMessages'),
  teamChatForm: document.getElementById('teamChatForm'),
  teamChatInput: document.getElementById('teamChatInput')
};

function getCurrentRoundIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('roundId') || null;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString(wolLocale());
}

function formatClock(value) {
  const total = Math.max(0, Math.floor(value));
  const hours = String(Math.floor(total / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatMinSec(totalSeconds) {
  const total = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes <= 0) return i18n.t('game.sec', { s: seconds });
  if (seconds === 0) return i18n.t('game.min', { m: minutes });
  return i18n.t('game.minSec', { m: minutes, s: seconds });
}

function hexToRgba(hex, alpha = 1) {
  if (!hex) return `rgba(0,0,0,${alpha})`;
  const cleaned = hex.replace('#', '').trim();
  const bigint = parseInt(cleaned, 16);
  if (cleaned.length === 3) {
    const r = (bigint >> 8) & 0xf;
    const g = (bigint >> 4) & 0xf;
    const b = bigint & 0xf;
    return `rgba(${(r << 4) | r}, ${(g << 4) | g}, ${(b << 4) | b}, ${alpha})`;
  }
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// --- Identity: "who am I" is resolved ONLY from the logged-in account (myUserId, bound to the
// socket by the server via JWT), never from array position — this is what guarantees a player
// always sees and controls their OWN village, no matter what order players joined in or which
// browser/device they're on. -------------------------------------------------------------------

function getCurrentPlayer() {
  if (!myUserId) return null;
  return state.players.find((p) => p.userId === myUserId) || null;
}

function getCurrentPlayerVillage() {
  const player = getCurrentPlayer();
  if (state.currentVillageId && state.villages[state.currentVillageId]) {
    return state.villages[state.currentVillageId];
  }
  return player && player.villageId ? state.villages[player.villageId] : null;
}

function ensureLocalVillageSelection() {
  const me = getCurrentPlayer();
  if (!me) return;
  const current = state.currentVillageId ? state.villages[state.currentVillageId] : null;
  if (!current || current.owner !== me.name) {
    state.currentVillageId = me.villageId || state.currentVillageId;
  }
}

function getOwnedVillages(ownerName) {
  return GameEngine.getOwnedVillages(state, ownerName);
}

function getAttackSourceVillage(player) {
  if (!player) return null;
  const current = getCurrentPlayerVillage();
  if (current && current.owner === player.name) return current;
  return getOwnedVillages(player.name)[0] || null;
}

function canAttackVillage(village, playerName) {
  return GameEngine.canAttackVillage(village, playerName);
}

// Team mode only: is this village owned by a DIFFERENT player who's on the same team as me? Used
// to also surface the "Wyślij wsparcie" button on a teammate's village (support already worked
// server-side via GameEngine.sendSupport's isSameTeam check — this is just the missing UI trigger).
function isTeammateVillage(village, currentPlayer) {
  if (state.mapType !== 'team' || !village?.owner || !currentPlayer) return false;
  if (village.owner === currentPlayer.name) return false;
  const ownerPlayer = state.players.find((p) => p.name === village.owner);
  return !!ownerPlayer && ownerPlayer.teamId != null && ownerPlayer.teamId === currentPlayer.teamId;
}

// --- Socket / server sync -----------------------------------------------------------------------

const token = localStorage.getItem('authToken') || localStorage.getItem('token');
if (!token) {
  window.location.href = '/login.html';
}

// Connects to whatever origin served this page — works unchanged on localhost, on the LAN, or
// through an ngrok tunnel, since it never hardcodes a host/port.
const deviceId = window.WLBFingerprint ? window.WLBFingerprint.getDeviceId() : null;
const socket = io(window.location.origin, { auth: { token, deviceId } });

function applyServerState(newState) {
  if (!newState) return;
  state.villages = newState.villages || {};
  state.players = newState.players || [];
  state.mapNodes = newState.mapNodes || [];
  // 'team' (50-village team map) vs 'classic' (today's 10 main + 20 sub villages) — only used to
  // pick the map background image below, see updateMapDisplay/.map-team in game.html.
  state.mapType = newState.mapType || 'classic';
  state.attacks = newState.attacks || [];
  state.reports = newState.reports || [];
  state.roundStatus = newState.roundStatus || state.roundStatus;
  state.timeScaleFactor = newState.timeScaleFactor;
  // Only present on the one game:state push that flips roundStatus to 'finished' for a
  // Mini-Tournament round or the Monthly Tournament Final (see server.js's endRound). Explicitly
  // cleared while the round is still active so a stale prize breakdown can never carry over if this
  // page instance somehow lives across two different rounds (it normally doesn't — each round is
  // its own page load — but this keeps renderRoundResults correct either way).
  state.prizeResults = newState.roundStatus === 'finished' ? (newState.prizeResults || null) : null;
  // Keeps GameEngine's read-only preview helpers (getBuildingTime/getRecruitTime/getAttackTravelTime,
  // used to show "czas: Xs" before the player actually queues anything) in sync with this round's
  // real pacing — without this the preview always shows the untouched 120-min-baseline duration
  // even though the actual queued duration (computed server-side) is already correctly scaled.
  GameEngine.setActiveTimeScaleFactor(state);
  ensureLocalVillageSelection();
  renderAll();
}

// The server pushes a fresh game:state ~once/sec (the authoritative tick) regardless of whether
// anything in any given panel actually changed, and several panels below rebuild their buttons via
// innerHTML on every single one of those pushes. If a click's mousedown and mouseup happen to
// straddle one of those rebuilds, the button under the pointer gets destroyed mid-click and the
// browser silently drops the click - the "sometimes I have to click twice" symptom. This skips the
// rebuild (leaving existing buttons/listeners untouched) whenever the data that would produce the
// HTML hasn't actually changed since the last render, which is true for the vast majority of ticks.
function renderIfChanged(container, signatureInput, buildFn) {
  if (!container) return false;
  const signature = JSON.stringify([signatureInput, window.i18n ? window.i18n.getLang() : '']);
  if (container.dataset.renderSig === signature) return false;
  container.dataset.renderSig = signature;
  buildFn();
  return true;
}

// Same idea as renderIfChanged, for panels whose HTML bakes in a live per-second countdown (queue
// timers, attack arrival clocks) alongside otherwise-static content and a cancel button. A full
// rebuild only happens when the STRUCTURAL data changes (items added/removed/reordered, unit/cost
// changed, etc, via signatureInput) - every tick in between just patches the countdown text/progress
// bar in place via patchFn, so the cancel button is never destroyed just because a second ticked over.
function renderStructuralIfChanged(container, signatureInput, buildFn, patchFn) {
  if (!container) return;
  const rebuilt = renderIfChanged(container, signatureInput, buildFn);
  if (!rebuilt && patchFn) patchFn();
}

// Short notification "ping" synthesized via Web Audio API rather than an audio file, so the chat
// alert doesn't depend on shipping/loading a sound asset. Lazily creates the AudioContext on first
// use since browsers block autoplay of audio contexts created before any user interaction.
let chatNotifyAudioCtx = null;
function playChatNotificationSound() {
  try {
    if (!chatNotifyAudioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      chatNotifyAudioCtx = new Ctx();
    }
    const ctx = chatNotifyAudioCtx;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.25);
  } catch (err) {
    // Audio is a non-critical nicety - never let it break chat rendering.
  }
}

// In-round team chat: builds each row via createElement/textContent (never innerHTML with raw
// message text) so a message containing HTML-looking text can't inject markup into the page.
function renderTeamChatMessage(message) {
  if (!selectors.teamChatMessages || !message) return;
  const row = document.createElement('div');
  row.className = 'team-chat-row';
  const time = new Date(message.at || Date.now()).toLocaleTimeString(wolLocale(), { hour: '2-digit', minute: '2-digit' });
  const timeSpan = document.createElement('span');
  timeSpan.className = 'team-chat-time';
  timeSpan.textContent = time;
  const userSpan = document.createElement('span');
  userSpan.className = 'team-chat-user';
  userSpan.textContent = `${message.username || '?'}:`;
  const textSpan = document.createElement('span');
  textSpan.className = 'team-chat-text';
  textSpan.textContent = message.text || '';
  row.appendChild(timeSpan);
  row.appendChild(userSpan);
  row.appendChild(textSpan);
  selectors.teamChatMessages.appendChild(row);
  selectors.teamChatMessages.scrollTop = selectors.teamChatMessages.scrollHeight;
}

// Team chat only exists for team-mode rounds - hidden entirely otherwise. Toggled every render
// (cheap: just a class check) rather than once at game:join, since mapType is only known once the
// first server state arrives.
function updateTeamChatVisibility() {
  if (!selectors.teamChatWindow) return;
  selectors.teamChatWindow.classList.toggle('visible', state.mapType === 'team');
}

// Zmiana jezyka: caly widok gry rysujemy od nowa (panele maja jezyk w podpisie, wiec nie pominą zmiany).
document.addEventListener('wol:langchange', () => {
  if (typeof hideMapActionPanel === 'function') hideMapActionPanel();
  renderAll();
  updateGameClocks();
});

function renderAll() {
  renderPlayerSelect();
  updateHeader();
  updateRanking();
  updateRecruitment();
  updateGarrison();
  renderRecruitmentQueue();
  renderActiveAttacks();
  renderReports();
  checkForNewReports();
  updateMapDisplay();
  updateTeamChatVisibility();
  if (selectors.upgradeModal && selectors.upgradeModal.classList.contains('active')) {
    renderUpgradeTable();
  }
  if (selectors.villageListModal && selectors.villageListModal.classList.contains('active')) {
    renderVillageListModal();
  }
  if (state.roundStatus === 'finished') {
    showRoundResults();
  }
}

function emitCommand(eventName, payload) {
  return new Promise((resolve) => {
    socket.emit(eventName, payload, (ack) => {
      if (ack && ack.error) {
        alert(ack.error);
      }
      resolve(ack);
    });
  });
}

socket.on('connect', () => {
  const roundId = getCurrentRoundIdFromUrl();
  if (!roundId) return;
  socket.emit('game:join', { roundId });
});

socket.on('game:init', ({ state: serverState, myUserId: uid }) => {
  myUserId = uid;
  applyServerState(serverState);
  attachEventHandlersOnce();
  setActiveMenu('btnMap');
});

socket.on('game:state', (serverState) => {
  applyServerState(serverState);
});

socket.on('game:error', (message) => {
  alert(message || i18n.t('game.gameError'));
});

// In-round team chat (team mode only) - server sends the team's recent history right after
// game:join (see server.js), then one game:teamChatMessage per new message from any teammate.
socket.on('game:teamChatHistory', (messages) => {
  if (!selectors.teamChatMessages) return;
  selectors.teamChatMessages.innerHTML = '';
  (messages || []).forEach(renderTeamChatMessage);
});

socket.on('game:teamChatMessage', (message) => {
  renderTeamChatMessage(message);
  const me = getCurrentPlayer();
  if (!me || !message || message.username !== me.name) {
    playChatNotificationSound();
  }
});

// The server just blocked this account (multi-account detection or an admin ban) and is about to
// disconnect this socket — go straight to the main page, which shows the reason + a way to message
// admin instead of leaving the player stuck on a game screen that no longer does anything.
socket.on('account:blocked', () => {
  window.location.href = '/index.html';
});

// The round timer just hit zero server-side: show the big countdown while the server finishes up
// (see ROUND_ENDING_BUFFER_MS in server.js) — results appear on their own via game:state/roundFinished.
socket.on('roundEnding', ({ countdownSeconds, reason }) => {
  showRoundEndingOverlay(countdownSeconds, reason);
});

// Safety net alongside the game:state broadcast the server sends when a round ends: if that
// update is ever missed, this still flips the round to finished and shows the podium/rewards.
socket.on('roundFinished', () => {
  state.roundStatus = 'finished';
  renderAll();
});

socket.on('connect_error', () => {
  // transient — socket.io retries automatically
});

// --- Points / map info (pure display helpers over server-provided data) -------------------------

function computeVillagePoints(village) {
  return GameEngine.computeVillagePoints(village);
}

function getVillageMapInfo(villageId) {
  return GameEngine.getVillageMapInfo(state, villageId);
}

function getVillageParentId(village) {
  return GameEngine.getVillageParentId(village);
}

function getVillageLoyalty(village) {
  return GameEngine.getVillageLoyalty(village);
}

function getAvailableAttackUnits(village) {
  return GameEngine.getAvailableAttackUnits(village);
}

// --- Rendering -----------------------------------------------------------------------------------

function renderPlayerSelect() {
  const player = getCurrentPlayer();
  if (selectors.playerNameDisplay) {
    selectors.playerNameDisplay.textContent = player ? player.name : i18n.t('game.noPlayer');
  }
}

function updateGoldProduction() {
  const player = getCurrentPlayer();
  state.gold = player ? Number(player.gold) || 0 : 0;
  // Mirrors produceGoldForAllPlayers' own rateScale in gameEngine.js: rates move opposite to
  // durations, so a faster-paced round (timeScaleFactor < 1, e.g. a 2x-speed room) piles up gold
  // proportionally FASTER, not just faster in wall-clock time. Without this factor the displayed
  // "+X zł/sek" showed the nominal per-building rate — correct-looking only for a 1x-speed round
  // (like Mini-Turniej rounds, which is why this bug went unnoticed there), but wrong everywhere
  // the round's actual speed differs from 1x.
  const rateScale = 1 / (Number(state.timeScaleFactor) || 1);
  state.goldPerSec = player ? getOwnedVillages(player.name).reduce((sum, v) => sum + GameEngine.getGoldProductionRate(v), 0) * rateScale : 0;
}

function updateHeader() {
  const player = getCurrentPlayer();
  const village = getCurrentPlayerVillage();
  updateGoldProduction();
  selectors.goldAmount.textContent = i18n.t('game.gold', { n: formatNumber(state.gold) });
  selectors.goldProduction.textContent = i18n.t('game.goldPerSec', { n: formatNumber(state.goldPerSec) });
  if (village) {
    const used = GameEngine.computeVillagePopulationUsed(village);
    const reserved = GameEngine.computeVillageReservedPopulation(village);
    const capacity = GameEngine.getVillagePopulationCapacity(village);
    const totalUsed = used + reserved;
    const reservedText = reserved > 0 ? ` (+${formatNumber(reserved)})` : '';
    selectors.populationAmount.textContent = `${formatNumber(totalUsed)}${reservedText}/${formatNumber(capacity)}`;
    selectors.populationAmount.title = i18n.t('game.populationTitle', { used: formatNumber(used), reserved: formatNumber(reserved), capacity: formatNumber(capacity) });
  } else {
    selectors.populationAmount.textContent = '0';
    selectors.populationAmount.title = '';
  }
  // Village name only (no more "— gracz" suffix) — the name box is a fixed 8-character width (see
  // .village-name in game.html) so the prev/next arrows beside it never shift; concatenating a
  // player name of unpredictable length back in would defeat that entirely.
  selectors.villageTitle.textContent = village ? i18n.tText(village.label) : i18n.t('game.noVillage');
  // 2026-10-02, player UX feedback: always-visible swatch of the player's own map color — see
  // .my-color-swatch in game.html.
  if (selectors.myColorSwatch) {
    if (village?.color) {
      selectors.myColorSwatch.style.backgroundColor = village.color;
      selectors.myColorSwatch.style.display = 'inline-block';
    } else {
      selectors.myColorSwatch.style.display = 'none';
    }
  }
  const ownedVillageCount = player ? getOwnedVillages(player.name).length : 0;
  if (selectors.villagePrevBtn) selectors.villagePrevBtn.disabled = ownedVillageCount <= 1;
  if (selectors.villageNextBtn) selectors.villageNextBtn.disabled = ownedVillageCount <= 1;
  if (selectors.upgradeModalVillageName) selectors.upgradeModalVillageName.textContent = village ? i18n.tText(village.label) : i18n.t('game.noVillage');
  if (selectors.upgradeModalVillagePrevBtn) selectors.upgradeModalVillagePrevBtn.disabled = ownedVillageCount <= 1;
  if (selectors.upgradeModalVillageNextBtn) selectors.upgradeModalVillageNextBtn.disabled = ownedVillageCount <= 1;
  // Keep the rename field showing the CURRENT village's name — but never overwrite it while the
  // player is actively typing into it (same reasoning as the recruitment quantity inputs: a
  // rebuild mid-keystroke would otherwise silently reset whatever they'd already typed).
  if (selectors.villageRenameInput && document.activeElement !== selectors.villageRenameInput) {
    selectors.villageRenameInput.value = village ? village.label : '';
  }
  if (selectors.upgradeModal && selectors.upgradeModal.classList.contains('active')) {
    renderUpgradeTable();
  }
}

function cycleVillage(direction) {
  if (state.roundStatus === 'finished') return;
  const player = getCurrentPlayer();
  if (!player) return;
  const ownedVillages = getOwnedVillages(player.name);
  if (ownedVillages.length <= 1) return;
  const currentIndex = ownedVillages.findIndex((village) => village.id === state.currentVillageId);
  const baseIndex = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex = (baseIndex + direction + ownedVillages.length) % ownedVillages.length;
  state.currentVillageId = ownedVillages[nextIndex].id;
  updateHeader();
  updateRecruitment();
  updateGarrison();
  renderRecruitmentQueue();
  renderMapNodes();
}

async function submitVillageRename() {
  const village = getCurrentPlayerVillage();
  const input = selectors.villageRenameInput;
  if (!village || !input) return;
  const label = input.value.trim();
  if (!label) return;
  const ack = await emitCommand('game:renameVillage', { villageId: village.id, label });
  if (ack && ack.ok) input.blur();
}

function toggleRankingMode() {
  state.rankingMode = state.rankingMode === 'points' ? 'kills' : 'points';
  updateRanking();
}

function updateRanking() {
  if (selectors.rankingPanelTitle) {
    selectors.rankingPanelTitle.textContent = state.rankingMode === 'kills' ? i18n.t('game.ranking.kills') : (state.mapType === 'team' ? i18n.t('game.ranking.teams') : i18n.t('game.ranking.players'));
  }
  if (selectors.rankingModeToggle) {
    selectors.rankingModeToggle.textContent = state.rankingMode === 'kills' ? i18n.t('game.ranking.showPoints') : i18n.t('game.ranking.showKills');
  }
  if (selectors.rankingKillsHeader) {
    selectors.rankingKillsHeader.classList.toggle('active', state.rankingMode === 'kills');
  }
  if (!selectors.rankingList) return;

  if (state.mapType === 'team') {
    updateTeamRanking();
    return;
  }

  selectors.rankingList.innerHTML = '';
  const rankedPlayers = [...state.players]
    .map((player) => ({
      ...player,
      killsAsAttacker: Number(player.killsAsAttacker) || 0,
      killsAsDefender: Number(player.killsAsDefender) || 0,
      points: Number(player.points) || 0
    }))
    .sort((a, b) => {
      // On an exact points tie, whoever reached that total earlier ranks higher (see
      // GameEngine.comparePlayersByRank / pointsAchievedAt) — checked before falling back to kills.
      if (state.rankingMode === 'kills') return b.killsAsAttacker - a.killsAsAttacker || GameEngine.comparePlayersByRank(a, b);
      return GameEngine.comparePlayersByRank(a, b) || b.killsAsAttacker - a.killsAsAttacker;
    });

  rankedPlayers.slice(0, 10).forEach((player, index) => {
    const color = player.color || '#94a3b8';
    const li = document.createElement('li');
    li.style.borderLeftColor = color;
    // "Pokonane" mode breaks the single kill count down into Atak / Obrona / Razem (see the
    // .ranking-kills-header column labels in game.html) so a player can tell at a glance whether
    // their kills came from attacking or from successfully defending.
    const valueMarkup = state.rankingMode === 'kills'
      ? `<span class="ranking-kills-cols">
          <span>${formatNumber(player.killsAsAttacker)}</span>
          <span>${formatNumber(player.killsAsDefender)}</span>
          <span>${formatNumber(player.killsAsAttacker + player.killsAsDefender)}</span>
        </span>`
      : `<span>${i18n.t('game.results.pts', { n: formatNumber(player.points) })}</span>`;
    // A player who forfeited via "Opuść rozgrywkę" (hasLeft) stays visible — their villages are
    // still being attacked/simulated — but struck through since they no longer compete for the
    // round's podium (see the hasLeft filters in payoutRoundRewards / computeSkillPointsDeltas).
    const nameStyle = `color: ${color};${player.hasLeft ? ' text-decoration: line-through; opacity: 0.6;' : ''}`;
    li.innerHTML = `
      <span><strong>${index + 1}.</strong> <span class="player-name" style="${nameStyle}">${player.name}${player.hasLeft ? i18n.t('game.ranking.left') : ''}</span></span>
      ${valueMarkup}
    `;
    selectors.rankingList.appendChild(li);
  });
}

// Team mode: groups players by teamId and computes each team's combined stats (points/kills), plus
// each member's own points/village count/kills-as-attacker - shared by the live ranking panel
// (updateTeamRanking) and the round-end results modal (renderRoundResults).
function computeTeamStandings() {
  const byTeam = new Map();
  state.players.forEach((player) => {
    if (player.teamId == null) return;
    if (!byTeam.has(player.teamId)) byTeam.set(player.teamId, []);
    byTeam.get(player.teamId).push(player);
  });
  return [...byTeam.entries()].map(([teamId, members]) => ({
    teamId,
    color: members[0]?.color || '#94a3b8',
    totalPoints: members.reduce((sum, p) => sum + (Number(p.points) || 0), 0),
    totalKillsAsAttacker: members.reduce((sum, p) => sum + (Number(p.killsAsAttacker) || 0), 0),
    totalKillsAsDefender: members.reduce((sum, p) => sum + (Number(p.killsAsDefender) || 0), 0),
    earliestPointsAchievedAt: members.reduce((min, p) => {
      const at = Number(p.pointsAchievedAt) || Infinity;
      return at < min ? at : min;
    }, Infinity),
    members: members.map((p) => ({
      name: p.name,
      points: Number(p.points) || 0,
      killsAsAttacker: Number(p.killsAsAttacker) || 0,
      killsAsDefender: Number(p.killsAsDefender) || 0,
      villageCount: getOwnedVillages(p.name).length,
      hasLeft: !!p.hasLeft
    }))
  }));
}

// Team mode: the ranking panel groups players by teamId and ranks TEAMS (by combined points or
// combined kills, matching the same tie-break server.js's payoutRoundRewards uses for the reward
// split), labeled "Drużyna N" with a "(Twoja)" suffix on whichever team the logged-in player
// belongs to — never individual player rows, per the user's explicit request for team mode. Clicking
// a team expands a per-player breakdown (points/villages/kills-as-attacker) below it.
function updateTeamRanking() {
  const myTeamId = getCurrentPlayer()?.teamId ?? null;
  const teams = computeTeamStandings();

  teams.sort((a, b) => {
    if (state.rankingMode === 'kills') return b.totalKillsAsAttacker - a.totalKillsAsAttacker;
    return b.totalPoints - a.totalPoints || a.earliestPointsAchievedAt - b.earliestPointsAchievedAt;
  });

  const topTeams = teams.slice(0, 10);
  // renderIfChanged guard: this panel re-renders on every ~1s server tick like everything else, and
  // now has a clickable row (expand/collapse) - without this, a click's mousedown/mouseup could
  // straddle a same-second rebuild and get silently dropped, the exact bug fixed elsewhere today.
  const signature = {
    mode: state.rankingMode, expanded: state.expandedTeamId,
    teams: topTeams.map((t) => ({ id: t.teamId, points: t.totalPoints, kills: t.totalKillsAsAttacker, defKills: t.totalKillsAsDefender, members: t.members }))
  };
  renderIfChanged(selectors.rankingList, signature, () => {
    selectors.rankingList.innerHTML = '';
    topTeams.forEach((team, index) => {
      const isMyTeam = myTeamId != null && team.teamId === myTeamId;
      const isExpanded = state.expandedTeamId === team.teamId;
      // "Pokonane" mode breaks the team total down into Atak / Obrona / Razem, matching the same
      // column labels the individual (non-team) ranking panel shows - see .ranking-kills-cols.
      const valueMarkup = state.rankingMode === 'kills'
        ? `<span class="ranking-kills-cols">
            <span>${formatNumber(team.totalKillsAsAttacker)}</span>
            <span>${formatNumber(team.totalKillsAsDefender)}</span>
            <span>${formatNumber(team.totalKillsAsAttacker + team.totalKillsAsDefender)}</span>
          </span>`
        : `<span>${i18n.t('game.results.pts', { n: formatNumber(team.totalPoints) })}</span>`;
      // A table with many columns doesn't fit the narrow sidebar (long usernames + numbers got
      // clipped) - a stacked name-then-stats line wraps naturally at any sidebar width instead.
      const membersRows = team.members.map((m) => `
        <div class="team-member-row${m.hasLeft ? ' left' : ''}">
          <div class="team-member-name">${m.name}${m.hasLeft ? i18n.t('game.ranking.left') : ''}</div>
          <div class="team-member-stats">${i18n.t('game.ranking.memberStats', { points: formatNumber(m.points), villages: formatNumber(m.villageCount), attack: formatNumber(m.killsAsAttacker), defense: formatNumber(m.killsAsDefender), total: formatNumber(m.killsAsAttacker + m.killsAsDefender) })}</div>
        </div>
      `).join('');
      const li = document.createElement('li');
      li.className = `ranking-team-row${isExpanded ? ' expanded' : ''}`;
      li.style.borderLeftColor = team.color;
      li.dataset.teamId = String(team.teamId);
      li.innerHTML = `
        <div class="ranking-team-header">
          <span><strong>${index + 1}.</strong> <span class="player-name" style="color: ${team.color};">${i18n.t('game.results.teamName', { n: team.teamId })}${isMyTeam ? i18n.t('game.ranking.yours') : ''}</span></span>
          ${valueMarkup}
        </div>
        ${isExpanded ? `<div class="team-members-list">${membersRows}</div>` : ''}
      `;
      selectors.rankingList.appendChild(li);
    });
  });
}

function showMapTooltip(node, villageId) {
  if (!selectors.mapTooltip) return;
  const { village, player, points } = getVillageMapInfo(villageId);
  const loyaltyLine = village?.owner ? `<br>${i18n.t('game.map.loyalty', { n: getVillageLoyalty(village) })}` : '';
  // 2026-10-02, player UX feedback: the map circle is too small (54px, 27px on mobile) to ever fit
  // a real custom village name, but the tooltip has room — it previously showed player/points/
  // loyalty but never the village's own (possibly renamed) label at all. Also flags "(Twoja)"
  // directly in text, instead of relying on the player having memorized their own border color.
  const currentPlayerName = getCurrentPlayer()?.name;
  const ownershipTag = village?.owner && currentPlayerName && village.owner === currentPlayerName ? i18n.t('game.map.yours') : '';
  const nameLine = village ? `${i18n.t('game.map.village', { name: i18n.tText(village.label) })}${ownershipTag}<br>` : '';
  selectors.mapTooltip.innerHTML = `${nameLine}${i18n.t('game.map.player', { name: player ? player.name : i18n.t('game.none') })}<br>${i18n.t('game.map.points', { n: formatNumber(points) })}${loyaltyLine}`;
  selectors.mapTooltip.style.display = 'block';
  const rect = node.getBoundingClientRect();
  const parentRect = selectors.mapCanvas.getBoundingClientRect();
  const nodeCenterX = rect.left - parentRect.left + rect.width / 2;
  const top = rect.top - parentRect.top - 10;
  // The tooltip's `left` is its LEFT edge, so by default it grows to the right of the node — for
  // villages near the map's right edge (e.g. the team map's rightmost clusters, roughly ids 21-34)
  // that pushed it partly off the visible canvas. Flip it to grow LEFTWARD from the node instead
  // whenever there isn't enough room to the right; `offsetWidth` reads the actual rendered width
  // now that display/innerHTML are already set above.
  const tooltipWidth = selectors.mapTooltip.offsetWidth || 220;
  const left = (nodeCenterX + tooltipWidth > parentRect.width - 12)
    ? nodeCenterX - tooltipWidth
    : nodeCenterX;
  selectors.mapTooltip.style.left = `${Math.min(Math.max(left, 12), parentRect.width - 12)}px`;
  selectors.mapTooltip.style.top = `${Math.max(top, 12)}px`;
}

function hideMapTooltip() {
  if (!selectors.mapTooltip) return;
  selectors.mapTooltip.style.display = 'none';
}

// Renders EVERY node the server sent, for EVERY owner — including the local player's own village.
// There is deliberately no filter here on villageId/ownerName/userId: whatever the server says
// exists on the map gets drawn, exactly the same way on every connected browser.
function renderMapNodes() {
  const nodesLayer = document.getElementById('mapNodesLayer');
  if (!nodesLayer) return;
  nodesLayer.innerHTML = '';
  // 2026-10-02, player UX feedback: "kolor gracza, który aktualnie gra, widział swój kolor
  // bardziej intensywnie a pozostałe mniej" — every owned village used to render at the exact
  // same border strength regardless of whose it was, so your own color never stood out from
  // anyone else's. Comparing against the PLAYER (not just the currently viewed village) so ALL
  // of your villages are highlighted, not only the one you're currently looking at.
  const myPlayerName = getCurrentPlayer()?.name;
  state.mapNodes.forEach((node) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `map-node ${node.type}`;
    element.dataset.nodeId = node.id;
    element.dataset.x = node.x;
    element.dataset.y = node.y;
    element.style.left = `${node.x}%`;
    element.style.top = `${node.y}%`;
    // 2026-10-02, explicit request: removed the coordinate text (e.g. "B10") that used to render
    // INSIDE each circle - the name label above (see .map-node-label below) replaces it visually.
    // node.id itself is untouched/still set above (dataset.nodeId) and used everywhere else in the
    // code (tooltips, click handlers, reports, map info) exactly as before - only the visible text
    // drawn inside the circle element is gone.
    const village = state.villages[node.id];
    // 2026-10-02, player request: the circle itself is too small to ever fit a real village name
    // (stays showing the coordinate, e.g. "B10") - this adds the name as a separate label ABOVE the
    // circle instead. Only for owned villages (a name only means something once someone's renamed
    // it or it belongs to a real player) - pointer-events:none so it never steals the hover/click
    // that's meant for the circle underneath it.
    if (village && village.owner && village.label) {
      const label = document.createElement('span');
      label.className = 'map-node-label';
      label.textContent = i18n.tText(village.label);
      label.style.pointerEvents = 'none';
      element.appendChild(label);
    }
    // Free neighbouring village the player can buy: small "Buy · 4,000 gold" tag under the circle.
    if (village && !village.owner && myPlayerName) {
      const buyParentId = getVillageParentId(village);
      const buyParent = buyParentId ? state.villages[buyParentId] : null;
      if (buyParent && buyParent.owner === myPlayerName) {
        const tag = document.createElement('span');
        tag.className = 'map-node-buy';
        tag.textContent = i18n.t('game.map.buyTag', { cost: formatNumber(GameEngine.auxiliaryVillageCost) });
        tag.style.pointerEvents = 'none';
        element.appendChild(tag);
        element.classList.add('map-node-buyable');
      }
    }
    if (village && village.owner && village.color) {
      const isMine = myPlayerName && village.owner === myPlayerName;
      // Fill fully transparent (0 alpha) so the map art (esp. the team map's hand-painted castles)
      // shows through completely — only the border carries the owner's color. Own villages get a
      // near-opaque, thick, slightly glowing border; everyone else's is thinner and noticeably
      // dimmer, so your own territory visually pops out of the crowd at a glance.
      // border-WIDTH and box-shadow come from the .map-node-mine/.map-node-other CSS classes (see
      // game.html) rather than inline styles, so the mobile @media (max-width: 700px) rule can
      // still shrink them back down — only the dynamic per-owner COLOR is set inline here.
      element.classList.add(isMine ? 'map-node-mine' : 'map-node-other');
      element.style.backgroundColor = isMine ? hexToRgba(village.color, 0.14) : 'transparent';
      element.style.borderColor = hexToRgba(village.color, isMine ? 1 : 0.5);
      if (isMine) element.style.setProperty('--mine-glow', hexToRgba(village.color, 0.65));
      element.style.color = '#f8fafc';
      element.style.textShadow = '0 1px 3px rgba(0,0,0,0.9), 0 0 4px rgba(0,0,0,0.9)';
    }
    if (node.id === state.currentVillageId) {
      element.classList.add('map-node-active');
      const pulseColor = (village && village.color) || '#38bdf8';
      // Stronger pulse (2026-10-02 feedback: "żeby pulsowanie było lepiej widoczne") — higher peak
      // opacity and a wider ring than before; see the matching villageActivePulse keyframes in
      // game.html for the bigger box-shadow spread.
      element.style.setProperty('--pulse-color-strong', hexToRgba(pulseColor, 0.9));
      element.style.setProperty('--pulse-color-soft', hexToRgba(pulseColor, 0));
    }
    element.addEventListener('mouseenter', () => showMapTooltip(element, node.id));
    element.addEventListener('mouseleave', hideMapTooltip);
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      // Touch screens simulate a "mouseenter" right before the click (so hover-based tooltips still
      // sort of work), but never fire a matching "mouseleave" afterward - without this, the tooltip
      // stayed on screen forever alongside the action panel opened below, showing two info windows
      // at once for the same village.
      hideMapTooltip();
      showMapActionPanel(element, node.id);
    });
    nodesLayer.appendChild(element);
  });
}

function renderVillageListModal() {
  if (!selectors.villageListContainer) return;
  const player = getCurrentPlayer();
  const villages = player ? getOwnedVillages(player.name) : [];
  if (villages.length === 0) {
    selectors.villageListContainer.innerHTML = `<div class="queue-empty">${i18n.t('game.villages.noneOwned')}</div>`;
    return;
  }
  const rows = villages.map((village) => {
    const garrison = (village.garrison && typeof village.garrison === 'object') ? village.garrison : {};
    const garrisonSummary = state.units
      .map((unit) => ({ label: wolUnitName(unit), count: Number(garrison[unit.id]) || 0 }))
      .filter((entry) => entry.count > 0)
      .map((entry) => `${entry.label} x${formatNumber(entry.count)}`)
      .join(', ');
    return {
      id: village.id, label: i18n.tText(village.label), isActive: village.id === state.currentVillageId,
      points: computeVillagePoints(village), garrisonSummary
    };
  });
  renderIfChanged(selectors.villageListContainer, rows, () => {
    selectors.villageListContainer.innerHTML = rows.map((row) => `
      <div class="village-card">
        <div>
          <strong>${row.label}</strong>${row.isActive ? i18n.t('game.villages.active') : ''}
          <div class="village-card-points">${i18n.t('game.villages.points', { n: formatNumber(row.points) })}</div>
          <div class="village-card-garrison">${i18n.t('game.villages.garrison', { list: row.garrisonSummary || i18n.t('game.garrison.noTroops') })}</div>
        </div>
        <button class="select-village-button" data-village="${row.id}">${i18n.t('game.villages.select')}</button>
      </div>
    `).join('');
    selectors.villageListContainer.querySelectorAll('.select-village-button').forEach((button) => {
      button.addEventListener('click', () => {
        const villageId = button.dataset.village;
        if (!villageId) return;
        state.currentVillageId = villageId;
        if (selectors.villageListModal) selectors.villageListModal.classList.remove('active');
        updateHeader();
        updateRecruitment();
        updateGarrison();
        renderRecruitmentQueue();
        renderMapNodes();
      });
    });
  });
}

function showMapActionPanel(node, villageId) {
  if (!selectors.mapActionPanel) return;
  // Any live arrival countdown belongs to whatever stage/panel was showing before this rebuild;
  // it's restarted below only if we're still on the confirm stage after rebuilding.
  clearPendingArrivalCountdown();
  if (state.roundStatus === 'finished') {
    selectors.mapActionPanel.innerHTML = `
      <h4>${i18n.t('game.map.roundOver')}</h4>
      <p>${i18n.t('game.map.roundOverHint')}</p>
    `;
    selectors.mapActionPanel.style.display = 'block';
    selectors.mapActionPanel.style.position = 'fixed';
    selectors.mapActionPanel.style.left = '50%';
    selectors.mapActionPanel.style.top = '50%';
    selectors.mapActionPanel.style.transform = 'translate(-50%, -50%)';
    return;
  }
  state.mapActionContext = { node, villageId };
  const { village, player, points } = getVillageMapInfo(villageId);
  const villageName = village ? i18n.tText(village.label) : i18n.tText('Nieznana wioska');
  const playerName = player ? player.name : i18n.t('game.noPlayer');
  const currentPlayer = getCurrentPlayer();
  const parentId = getVillageParentId(village);
  const parentVillage = parentId ? state.villages[parentId] : null;
  const canPurchaseSubVillage = Boolean(village && !village.owner && parentVillage && parentVillage.owner === currentPlayer?.name);
  const isOwnedByPlayer = Boolean(village && village.owner === currentPlayer?.name);
  // Team mode only: an ownerless village (an unused region's leftover territory) has zero
  // defenders — a Lord can capture it in one strike, same as attacking a real enemy village, see
  // GameEngine.sendAttack/processActiveAttacks.
  const isCapturableNeutralVillage = Boolean(village && !village.owner && state.mapType === 'team');
  const canAttackTargetVillage = canAttackVillage(village, currentPlayer?.name) || isCapturableNeutralVillage;
  const attackSourceVillage = getAttackSourceVillage(currentPlayer);
  const isTeammateOwned = isTeammateVillage(village, currentPlayer);
  const canSelectVillage = isOwnedByPlayer && village.id !== state.currentVillageId;
  const pendingAttack = state.pendingAttack && state.pendingAttack.targetVillageId === villageId ? state.pendingAttack : null;
  let content = '';
  const isReconMode = pendingAttack?.mode === 'recon';
  const isSupportMode = pendingAttack?.mode === 'support';

  if (pendingAttack?.stage === 'confirm') {
    const selectedEntries = Object.entries(pendingAttack.selectedUnits || {}).filter(([, count]) => Number(count) > 0);
    const summary = selectedEntries.length > 0
      ? selectedEntries.map(([unitId, count]) => {
          const unit = state.units.find((item) => item.id === unitId);
          return i18n.t('game.map.unitsCount', { unit: unit ? wolUnitName(unit) : unitId, n: count });
        }).join('<br>')
      : i18n.t('game.map.noneSelected');
    const selectedLabel = isReconMode ? i18n.t('game.map.selectedScouts') : (isSupportMode ? i18n.t('game.map.selectedSupport') : i18n.t('game.map.selectedTroops'));
    const confirmAction = isReconMode ? 'recon-confirm' : (isSupportMode ? 'support-confirm' : 'attack-confirm');
    const confirmLabel = isReconMode ? i18n.t('game.map.confirmRecon') : (isSupportMode ? i18n.t('game.map.confirmSupport') : i18n.t('game.map.confirmAttack'));
    // Lets the player line up multiple attacks from different villages to land at the same
    // moment: both the exact clock time of arrival and a live countdown, refreshed every second
    // (see startPendingArrivalCountdown) so the number stays accurate the whole time this
    // confirmation screen is open, not just at the instant it was opened.
    const travelUnitsForPreview = selectedEntries.map(([unitId, count]) => ({ unitId, count: Number(count) }));
    const travelTimeMsPreview = GameEngine.getAttackTravelTimeMs({ units: travelUnitsForPreview });
    content = `
      <h4>${villageName}</h4>
      <p>${i18n.t('game.map.playerPoints', { name: playerName, n: formatNumber(points) })}</p>
      <div class="attack-preview">
        <strong>${selectedLabel}</strong><br>${summary}
      </div>
      <div class="attack-arrival-info">
        ${i18n.t('game.map.arrivesAt')} <strong id="pendingArrivalClock">--:--:--</strong><br>
        ${i18n.t('game.map.travelTime')} <span id="pendingArrivalCountdown">--:--:--</span>
      </div>
      <div class="action-buttons">
        <button class="confirm" data-action="${confirmAction}">${confirmLabel}</button>
        <button class="cancel" data-action="attack-cancel">${i18n.t('game.map.back')}</button>
      </div>
    `;
    requestAnimationFrame(() => startPendingArrivalCountdown(travelTimeMsPreview));
  } else if (pendingAttack?.stage === 'select') {
    const sourceVillage = state.villages[pendingAttack.sourceVillageId];
    const availableUnits = sourceVillage ? getAvailableAttackUnits(sourceVillage) : [];
    const attackableUnits = isReconMode
      ? availableUnits.filter((unit) => unit.id === 'scout')
      : (isSupportMode ? availableUnits.filter((unit) => unit.id !== 'lord') : availableUnits);
    const emptyLabel = isReconMode ? i18n.t('game.map.noScouts') : (isSupportMode ? i18n.t('game.map.noSupportUnits') : i18n.t('game.map.noAttackUnits'));
    const sendAction = isReconMode ? 'recon-send' : (isSupportMode ? 'support-send' : 'attack-send');
    const sendLabel = isReconMode ? i18n.t('game.map.sendRecon') : (isSupportMode ? i18n.t('game.map.sendSupport') : i18n.t('game.map.sendAttack'));
    // 2026-10-02, player UX feedback ("wybrałem przypadkiem zero jednostek"): the send button must
    // start disabled when nothing is selected yet (and the input listener below keeps it in sync
    // live as the player types/clears quantities), instead of only rejecting via alert() on click.
    const hasAnySelected = Object.values(pendingAttack.selectedUnits || {}).some((count) => Number(count) > 0);
    content = `
      <h4>${villageName}</h4>
      <p>${i18n.t('game.map.playerPoints', { name: playerName, n: formatNumber(points) })}</p>
      <div class="attack-unit-list">
        ${attackableUnits.length > 0 ? attackableUnits.map((unit) => `
          <label class="attack-unit-row">
            <span>${wolUnitName(unit)}</span>
            <span>${i18n.t('game.map.pcs', { n: unit.count })}</span>
            <input type="number" min="0" max="${unit.count}" value="${Number(pendingAttack.selectedUnits?.[unit.id] || 0)}" data-attack-count data-unit-id="${unit.id}">
          </label>
        `).join('') : `<span>${emptyLabel}</span>`}
      </div>
      <div class="action-buttons">
        ${attackableUnits.length > 0 ? `<button class="select" data-action="attack-select-all">${i18n.t('game.map.selectAll')}</button>` : ''}
        <button class="attack" data-action="${sendAction}" ${hasAnySelected ? '' : 'disabled'} title="${hasAnySelected ? '' : i18n.t('game.map.selectOne')}">${sendLabel}</button>
        <button class="cancel" data-action="attack-cancel">${i18n.t('common.cancel')}</button>
      </div>
    `;
  } else if (canPurchaseSubVillage) {
    content = `
      <h4>${villageName}</h4>
      <p>${i18n.t('game.map.playerPoints', { name: playerName, n: formatNumber(points) })}</p>
      <div class="action-buttons">
        <button class="buy" data-action="buy">${i18n.t('game.map.buy', { cost: formatNumber(GameEngine.auxiliaryVillageCost) })}</button>
      </div>
    `;
  } else if (canAttackTargetVillage && attackSourceVillage) {
    // Team mode: a teammate's village is still attackable (friendly fire is allowed), but also
    // gets the "Wyślij wsparcie" option alongside attack/recon — see isTeammateVillage.
    const ownershipTag = isTeammateOwned
      ? i18n.t('game.map.ally')
      : (isCapturableNeutralVillage ? i18n.t('game.map.neutral') : '');
    // 2026-10-02, player UX feedback: "Wyślij atak"/"Wyślij zwiad" used to render fully active
    // even with zero attackable units/scouts in the source village — clicking did nothing but an
    // easy-to-miss alert(), looking like a broken button rather than "nothing to send". Same
    // checks the click handler below already used, just moved up so the button is visibly inert
    // beforehand instead of only failing silently-ish after the click.
    const canSendAttack = getAvailableAttackUnits(attackSourceVillage).length > 0;
    const canSendRecon = Number(attackSourceVillage.garrison?.scout || 0) > 0;
    content = `
      <h4>${villageName}${ownershipTag}</h4>
      <p>${i18n.t('game.map.playerPoints', { name: playerName, n: formatNumber(points) })}<br>${i18n.t('game.map.loyalty', { n: getVillageLoyalty(village) })}</p>
      <div class="action-buttons">
        <button class="attack" data-action="attack-start" ${canSendAttack ? '' : 'disabled'} title="${canSendAttack ? '' : i18n.t('game.map.noAttackHere')}">${i18n.t('game.map.sendAttack')}</button>
        <button class="attack" data-action="recon-start" ${canSendRecon ? '' : 'disabled'} title="${canSendRecon ? '' : i18n.t('game.map.noScoutsHere')}">${i18n.t('game.map.sendRecon')}</button>
        ${isTeammateOwned ? `<button class="support" data-action="support-start">${i18n.t('game.map.sendSupport')}</button>` : ''}
      </div>
    `;
  } else if (isOwnedByPlayer) {
    content = `
      <h4>${villageName}</h4>
      <p>${i18n.t('game.map.playerPoints', { name: playerName, n: formatNumber(points) })}</p>
      <div class="action-buttons">
        <button class="support" data-action="support-start">${i18n.t('game.map.sendSupport')}</button>
      </div>
    `;
  } else {
    content = `
      <h4>${villageName}</h4>
      <p>${i18n.t('game.map.playerPoints', { name: playerName, n: formatNumber(points) })}</p>
      <div class="action-buttons">
        <span>${i18n.t('game.map.noActions')}</span>
      </div>
    `;
  }

  if (canSelectVillage) {
    content += `
      <div class="action-buttons" style="margin-top: 8px;">
        <button class="select" data-action="select">${i18n.t('game.map.goTo')}</button>
      </div>
    `;
  }

  const nodeToUse = state.mapActionContext?.node || node;

  selectors.mapActionPanel.innerHTML = content;
  selectors.mapActionPanel.style.display = 'block';
  selectors.mapActionPanel.style.position = 'fixed';
  selectors.mapActionPanel.style.left = '50%';
  selectors.mapActionPanel.style.top = '50%';
  selectors.mapActionPanel.style.transform = 'translate(-50%, -50%)';
  selectors.mapActionPanel.style.maxWidth = 'min(320px, calc(100vw - 24px))';
  selectors.mapActionPanel.style.maxHeight = 'min(82vh, 560px)';
  selectors.mapActionPanel.style.width = 'min(320px, calc(100vw - 24px))';
  selectors.mapActionPanel.style.overflowY = 'auto';

  selectors.mapActionPanel.querySelectorAll('button[data-action]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.action;
      if (action === 'attack-start' && village && currentPlayer) {
        const sourceVillage = getAttackSourceVillage(currentPlayer);
        if (!sourceVillage) return alert(i18n.t('game.map.noOwnVillageAttack'));
        if (!getAvailableAttackUnits(sourceVillage).length) return alert(i18n.t('game.map.noAttackUnitsAlert'));
        state.pendingAttack = { targetVillageId: village.id, targetVillageName: villageName, sourceVillageId: sourceVillage.id, selectedUnits: {}, stage: 'select', mode: 'attack' };
        requestAnimationFrame(() => showMapActionPanel(nodeToUse, village.id));
        return;
      } else if (action === 'recon-start' && village && currentPlayer) {
        const sourceVillage = getAttackSourceVillage(currentPlayer);
        if (!sourceVillage) return alert(i18n.t('game.map.noOwnVillageRecon'));
        if (Number(sourceVillage.garrison?.scout || 0) <= 0) return alert(i18n.t('game.map.noScouts'));
        state.pendingAttack = { targetVillageId: village.id, targetVillageName: villageName, sourceVillageId: sourceVillage.id, selectedUnits: {}, stage: 'select', mode: 'recon' };
        requestAnimationFrame(() => showMapActionPanel(nodeToUse, village.id));
        return;
      } else if (action === 'support-start' && village && currentPlayer) {
        const sourceVillage = getAttackSourceVillage(currentPlayer);
        if (!sourceVillage) return alert(i18n.t('game.map.noOtherVillageSupport'));
        if (sourceVillage.id === village.id) return alert(i18n.t('game.map.switchVillageSupport'));
        if (!getAvailableAttackUnits(sourceVillage).some((unit) => unit.id !== 'lord')) return alert(i18n.t('game.map.noSupportLord'));
        state.pendingAttack = { targetVillageId: village.id, targetVillageName: villageName, sourceVillageId: sourceVillage.id, selectedUnits: {}, stage: 'select', mode: 'support' };
        requestAnimationFrame(() => showMapActionPanel(nodeToUse, village.id));
        return;
      } else if (action === 'attack-select-all' && village && currentPlayer) {
        const pending = state.pendingAttack;
        if (!pending) return;
        const sourceVillage = state.villages[pending.sourceVillageId];
        const availableUnits = sourceVillage ? getAvailableAttackUnits(sourceVillage) : [];
        const attackableUnits = pending.mode === 'recon'
          ? availableUnits.filter((unit) => unit.id === 'scout')
          : (pending.mode === 'support' ? availableUnits.filter((unit) => unit.id !== 'lord') : availableUnits);
        pending.selectedUnits = {};
        attackableUnits.forEach((unit) => {
          pending.selectedUnits[unit.id] = unit.count;
        });
        requestAnimationFrame(() => showMapActionPanel(nodeToUse, village.id));
        return;
      } else if ((action === 'attack-send' || action === 'recon-send' || action === 'support-send') && village && currentPlayer) {
        const pending = state.pendingAttack;
        if (!pending) return;
        const selectedEntries = Object.entries(pending.selectedUnits || {}).filter(([, count]) => Number(count) > 0);
        if (!selectedEntries.length) {
          const label = pending.mode === 'recon' ? i18n.t('game.map.oneScout') : (pending.mode === 'support' ? i18n.t('game.map.oneSupport') : i18n.t('game.map.oneAttack'));
          alert(i18n.t('game.map.selectAtLeast', { what: label }));
          return;
        }
        pending.stage = 'confirm';
        requestAnimationFrame(() => showMapActionPanel(nodeToUse, village.id));
        return;
      } else if ((action === 'recon-confirm' || action === 'attack-confirm' || action === 'support-confirm') && village && currentPlayer) {
        const pending = state.pendingAttack;
        if (!pending) return;
        if (pending.mode === 'support') {
          emitCommand('game:sendSupport', {
            sourceVillageId: pending.sourceVillageId,
            targetVillageId: pending.targetVillageId,
            selectedUnits: pending.selectedUnits
          });
        } else {
          emitCommand('game:sendAttack', {
            sourceVillageId: pending.sourceVillageId,
            targetVillageId: pending.targetVillageId,
            selectedUnits: pending.selectedUnits,
            mode: pending.mode
          });
        }
        state.pendingAttack = null;
        hideMapActionPanel();
        return;
      } else if (action === 'attack-cancel') {
        state.pendingAttack = null;
        hideMapActionPanel();
        return;
      } else if (action === 'buy' && village) {
        emitCommand('game:buyVillage', { villageId: village.id }).then((ack) => {
          if (ack && ack.ok) {
            state.currentVillageId = village.id;
          }
        });
      } else if (action === 'select' && village) {
        state.currentVillageId = village.id;
        updateHeader();
        updateRecruitment();
        updateGarrison();
        renderRecruitmentQueue();
        renderMapNodes();
      }
      hideMapActionPanel();
    });
  });

  selectors.mapActionPanel.querySelectorAll('input[data-attack-count]').forEach((input) => {
    input.addEventListener('input', () => {
      if (state.pendingAttack) {
        const unitId = input.dataset.unitId;
        const maxValue = Number(input.max || 0);
        const nextValue = Math.min(Math.max(Number(input.value || 0), 0), maxValue || 0);
        state.pendingAttack.selectedUnits = state.pendingAttack.selectedUnits || {};
        state.pendingAttack.selectedUnits[unitId] = nextValue;
        input.value = String(nextValue);
        // 2026-10-02, player UX feedback: keep the send button's disabled state in sync live as
        // quantities change, without needing a full panel re-render (which would drop focus).
        const sendButton = selectors.mapActionPanel.querySelector('button[data-action$="-send"]');
        if (sendButton) {
          const hasAnySelected = Object.values(state.pendingAttack.selectedUnits || {}).some((count) => Number(count) > 0);
          sendButton.disabled = !hasAnySelected;
          sendButton.title = hasAnySelected ? '' : i18n.t('game.map.selectOne');
        }
      }
    });
  });
}

function hideMapActionPanel() {
  if (!selectors.mapActionPanel) return;
  selectors.mapActionPanel.style.display = 'none';
  state.pendingAttack = null;
  clearPendingArrivalCountdown();
}

let pendingArrivalIntervalId = null;

function clearPendingArrivalCountdown() {
  if (pendingArrivalIntervalId) {
    clearInterval(pendingArrivalIntervalId);
    pendingArrivalIntervalId = null;
  }
}

// Keeps the "Dotrze o:" clock time and countdown on the attack-confirmation screen accurate to the
// current second for as long as that screen stays open, so timing several attacks from different
// villages to land together doesn't rely on a number that was only correct the instant it was drawn.
function updatePendingArrivalDisplay(travelTimeMs) {
  const clockEl = document.getElementById('pendingArrivalClock');
  const countdownEl = document.getElementById('pendingArrivalCountdown');
  if (!clockEl || !countdownEl) {
    clearPendingArrivalCountdown();
    return;
  }
  const arrivesAt = Date.now() + travelTimeMs;
  clockEl.textContent = new Date(arrivesAt).toLocaleTimeString(wolLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  countdownEl.textContent = formatClock(travelTimeMs / 1000);
}

function startPendingArrivalCountdown(travelTimeMs) {
  clearPendingArrivalCountdown();
  updatePendingArrivalDisplay(travelTimeMs);
  pendingArrivalIntervalId = setInterval(() => updatePendingArrivalDisplay(travelTimeMs), 1000);
}

function updateGameClocks() {
  if (selectors.realTimeDisplay) {
    selectors.realTimeDisplay.textContent = new Date().toLocaleTimeString(wolLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  if (selectors.roundTimerDisplay) {
    const remaining = Number.isFinite(state.roundRemainingSeconds) ? state.roundRemainingSeconds : null;
    if (remaining === null) {
      selectors.roundTimerDisplay.textContent = '--:--:--';
      selectors.roundTimerDisplay.title = i18n.t('game.waitingRoundTime');
    } else if (state.roundStatus === 'finished') {
      selectors.roundTimerDisplay.textContent = i18n.t('game.roundFinishedShort');
      selectors.roundTimerDisplay.title = i18n.t('game.results.title');
    } else {
      selectors.roundTimerDisplay.textContent = formatClock(remaining);
      selectors.roundTimerDisplay.title = i18n.t('game.roundEndsIn', { time: formatClock(remaining) });
    }
  }
}

function renderRoundResults() {
  // Prize breakdown (Mini-Tournament / Monthly Tournament Final only) — comes straight from the
  // server (see server.js's endRound/runRoundFinishHooks), never re-derived client-side, since the
  // Final's actual payout placement uses a different tie-break rule (userId compare) than this
  // page's own points ranking (earliest pointsAchievedAt) — merging by table row index could show
  // the wrong prize next to the wrong name on an exact points tie.
  const prizeResults = Array.isArray(state.prizeResults) ? state.prizeResults : [];
  if (selectors.prizeResultsRow) selectors.prizeResultsRow.style.display = prizeResults.length ? 'grid' : 'none';
  if (selectors.prizeResultsTableBody && prizeResults.length) {
    const ordered = [...prizeResults].sort((a, b) => a.placement - b.placement);
    selectors.prizeResultsTableBody.innerHTML = ordered.map((p) => `
      <tr><td>${p.placement}</td><td>${p.username}</td><td>${i18n.t('game.results.prize', { n: formatNumber(p.vplnAwarded) })}</td></tr>
    `).join('');
  }

  // Final podium: an exact points tie goes to whoever reached that total earlier (see
  // GameEngine.comparePlayersByRank / pointsAchievedAt), same rule used for the TOP1-3 payouts.
  const rankedByPoints = [...state.players].map((p) => ({ ...p, points: Number(p.points) || 0, killsAsAttacker: Number(p.killsAsAttacker) || 0 }))
    .sort((a, b) => GameEngine.comparePlayersByRank(a, b) || b.killsAsAttacker - a.killsAsAttacker).slice(0, 3);
  const rankedByKills = [...state.players].map((p) => ({ ...p, points: Number(p.points) || 0, killsAsAttacker: Number(p.killsAsAttacker) || 0 }))
    .sort((a, b) => b.killsAsAttacker - a.killsAsAttacker || GameEngine.comparePlayersByRank(a, b)).slice(0, 3);

  if (selectors.pointsResultsTableBody) {
    selectors.pointsResultsTableBody.innerHTML = rankedByPoints.map((player, index) => `
      <tr><td>${index + 1}</td><td>${player.name}</td><td>${i18n.t('game.results.pts', { n: formatNumber(player.points) })}</td></tr>
    `).join('');
  }
  if (selectors.killsResultsTableBody) {
    selectors.killsResultsTableBody.innerHTML = rankedByKills.map((player, index) => `
      <tr><td>${index + 1}</td><td>${player.name}</td><td>${formatNumber(player.killsAsAttacker)}</td></tr>
    `).join('');
  }

  // Team mode: the headline result is which TEAMS won, shown above the individual TOP3 tables -
  // points ranking matches payoutRoundRewards' TOP1-3 team split, kills ranking matches its
  // Agresor (drużyna) bonus (byTeamKillsAsAttacker in server.js) - same combined-per-team totals.
  const isTeamMode = state.mapType === 'team';
  if (selectors.teamResultsRow) selectors.teamResultsRow.style.display = isTeamMode ? 'grid' : 'none';
  if (isTeamMode) {
    const teams = computeTeamStandings();
    if (selectors.teamResultsTableBody) {
      const rankedByTeamPoints = [...teams]
        .sort((a, b) => b.totalPoints - a.totalPoints || a.earliestPointsAchievedAt - b.earliestPointsAchievedAt)
        .slice(0, 3);
      selectors.teamResultsTableBody.innerHTML = rankedByTeamPoints.map((team, index) => `
        <tr><td>${index + 1}</td><td style="color:${team.color};">${i18n.t('game.results.teamName', { n: team.teamId })}</td><td>${i18n.t('game.results.pts', { n: formatNumber(team.totalPoints) })}</td></tr>
      `).join('');
    }
    if (selectors.teamAggressorResultsTableBody) {
      const rankedByTeamKills = [...teams]
        .sort((a, b) => b.totalKillsAsAttacker - a.totalKillsAsAttacker)
        .slice(0, 3);
      selectors.teamAggressorResultsTableBody.innerHTML = rankedByTeamKills.map((team, index) => `
        <tr><td>${index + 1}</td><td style="color:${team.color};">${i18n.t('game.results.teamName', { n: team.teamId })}</td><td>${formatNumber(team.totalKillsAsAttacker)}</td></tr>
      `).join('');
    }
  }
}

// Koniec rundy: zamyka wszystkie otwarte okna gry (rozbudowa, rekrutacja, raporty, lista wiosek...), zeby nie zaslanialy wyniku.
function closeAllGameModals() {
  document.querySelectorAll('.modal-backdrop.active').forEach((el) => el.classList.remove('active'));
  if (selectors.upgradeModal && selectors.upgradeModal.classList.contains('active')) selectors.upgradeModal.classList.remove('active');
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) { /* ignore */ }
}

function showRoundResults() {
  closeAllGameModals();
  hideRoundEndingOverlay();
  if (!selectors.roundResultModal || state.roundFinishedShown) return;
  renderRoundResults();
  selectors.roundResultModal.classList.add('active');
  state.roundFinishedShown = true;
}

let roundEndingIntervalId = null;

// Shown the instant the server announces the round timer hit zero — a big visible countdown
// while the server settles the last tick/payout/final snapshot, instead of the podium just
// appearing abruptly. The server's OWN delay (see ROUND_ENDING_BUFFER_MS in server.js) is what
// actually determines when results show up (via game:state/roundFinished, which always calls
// showRoundResults -> hideRoundEndingOverlay above); this local countdown is only cosmetic.
function showRoundEndingOverlay(seconds, reason) {
  if (!selectors.roundEndingOverlay || !selectors.roundEndingCountdown) return;
  try { console.log('[game] roundEnding', seconds, reason); } catch (e) { /* ignore */ }
  // Keep the countdown on <html>, above every panel and window (.page-shell has its own zoom).
  if (selectors.roundEndingOverlay.parentNode !== document.documentElement) document.documentElement.appendChild(selectors.roundEndingOverlay);
  selectors.roundEndingOverlay.style.zIndex = '2147480000';
  closeAllGameModals();
  clearRoundEndingInterval();
  let remaining = Math.max(1, Math.round(Number(seconds) || 5));
  selectors.roundEndingCountdown.textContent = String(remaining);
  const sublabel = document.getElementById('roundEndingSublabel');
  if (sublabel) {
    if (reason === 'elimination_team') {
      sublabel.textContent = i18n.t('game.results.enemyTeamDefeated');
    } else if (reason === 'elimination_solo') {
      sublabel.textContent = i18n.t('game.results.allDefeated');
    } else {
      sublabel.textContent = i18n.t('game.results.counting');
    }
  }
  selectors.roundEndingOverlay.classList.add('active');
  roundEndingIntervalId = setInterval(() => {
    remaining -= 1;
    selectors.roundEndingCountdown.textContent = String(Math.max(0, remaining));
    if (remaining <= 0) clearRoundEndingInterval();
  }, 1000);
}

function clearRoundEndingInterval() {
  if (roundEndingIntervalId) {
    clearInterval(roundEndingIntervalId);
    roundEndingIntervalId = null;
  }
}

function hideRoundEndingOverlay() {
  clearRoundEndingInterval();
  if (selectors.roundEndingOverlay) selectors.roundEndingOverlay.classList.remove('active');
}

function closeRoundResults() {
  if (selectors.roundResultModal) selectors.roundResultModal.classList.remove('active');
  // Po zamknieciu wynikow gra nie jest juz potrzebna - wracamy od razu do menu glownego.
  window.location.href = '/index.html';
}

function updateRecruitment() {
  if (!selectors.recruitTableBody) return;
  // A fresh game:state arrives roughly once a second (the server tick) and used to rebuild this
  // whole table every time — destroying the quantity <input> the player was actively typing into
  // mid-keystroke (cursor/focus lost, typing stops working). While one of this table's inputs is
  // focused, skip the rebuild and just refresh button enabled/disabled state instead; the table is
  // rebuilt again as soon as focus moves elsewhere (e.g. the player confirms by clicking Rekrutuj).
  const focused = document.activeElement;
  if (focused && focused.tagName === 'INPUT' && selectors.recruitTableBody.contains(focused)) {
    refreshRecruitButtonStates();
    return;
  }
  const village = getCurrentPlayerVillage();
  const rows = state.units.map((unit) => {
    const recruitTime = GameEngine.getRecruitTime(unit, village);
    const isLordUnit = unit.id === 'lord';
    const canRecruit = state.roundStatus === 'finished' ? false : (isLordUnit ? GameEngine.canRecruitLord(village) : true);
    const buttonLabel = isLordUnit && !canRecruit ? i18n.t('game.recruit.unavailable') : i18n.t('game.recruit.button');
    return { id: unit.id, label: wolUnitName(unit), cost: unit.cost, recruitTime, canRecruit, buttonLabel };
  });
  renderIfChanged(selectors.recruitTableBody, { villageId: village?.id, rows }, () => {
    selectors.recruitTableBody.innerHTML = '';
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.dataset.unitRow = row.id;
      tr.innerHTML = `
        <td>
          <div class="unit-name">${row.label}</div>
          <div class="unit-meta">${i18n.t('game.recruit.meta', { cost: formatNumber(row.cost), time: row.recruitTime })}</div>
        </td>
        <td><div class="unit-max-hint" data-max-for="${row.id}"></div><input type="number" min="0" placeholder="0" data-unit="${row.id}" /></td>
        <td><button class="recruit-button" data-unit="${row.id}" ${row.canRecruit ? '' : 'disabled'}>${row.buttonLabel}</button></td>
      `;
      selectors.recruitTableBody.appendChild(tr);
    });
  });
  refreshRecruitButtonStates();
}

function updateRecruitButtonState(unitId) {
  const village = getCurrentPlayerVillage();
  const unit = state.units.find((item) => item.id === unitId);
  if (!village || !unit || !selectors.recruitTableBody) return;
  const input = selectors.recruitTableBody.querySelector(`input[data-unit="${unitId}"]`);
  const button = selectors.recruitTableBody.querySelector(`button[data-unit="${unitId}"]`);
  const maxHint = selectors.recruitTableBody.querySelector(`[data-max-for="${unitId}"]`);
  if (!input || !button) return;
  // How many of this unit gold/population currently allow, regardless of whatever quantity is
  // typed in the input — purely a client-side read of state already pushed by the ~1s server tick
  // (state.gold, village population), so refreshing this every tick costs the server nothing extra.
  if (maxHint) {
    const used = GameEngine.computeVillagePopulationUsed(village);
    const reserved = GameEngine.computeVillageReservedPopulation(village);
    const capacity = GameEngine.getVillagePopulationCapacity(village);
    const popCostPerUnit = GameEngine.unitPopulationCost[unitId] || 0;
    const goldLimit = unit.cost > 0 ? Math.floor(state.gold / unit.cost) : Infinity;
    const popLimit = popCostPerUnit > 0 ? Math.floor((capacity - used - reserved) / popCostPerUnit) : Infinity;
    let maxAffordable = Math.max(0, Math.min(goldLimit, popLimit));
    // A village can hold only one Lord: show 1 when one can be recruited right now, otherwise 0.
    if (unitId === 'lord') maxAffordable = GameEngine.canRecruitLord(village) && !(village.lordQueue || []).length && maxAffordable >= 1 ? 1 : 0;
    maxHint.textContent = `(${formatNumber(maxAffordable)})`;
    maxHint.dataset.maxValue = String(maxAffordable);
  }
  const isLordUnit = unit.id === 'lord';
  if (state.roundStatus === 'finished' || (isLordUnit && !GameEngine.canRecruitLord(village))) {
    button.disabled = true;
    // 2026-10-02, player UX feedback: the Lord recruit button was greyed out but gave zero
    // explanation of WHY it's unavailable at game start — a title tooltip showing the actual
    // missing requirement (same check as GameEngine.canRecruitLord) fixes that without
    // needing any new server-side data.
    if (isLordUnit && state.roundStatus !== 'finished') {
      const castleLevel = GameEngine.getVillageCastleLevel(village);
      if (castleLevel < 5) {
        button.title = i18n.t('game.recruit.needCastle', { n: castleLevel });
      } else if (GameEngine.getVillageLordCount(village) >= 1) {
        button.title = i18n.t('game.recruit.lordInVillage');
      } else {
        button.title = i18n.t('game.recruit.lordAway');
      }
    } else {
      button.title = '';
    }
    return;
  }
  button.title = '';
  const count = Number(input.value) || 0;
  if (count <= 0) {
    // 2026-10-02, player UX feedback ("mogę sobie radośnie rekrutować po zero"): a count of 0
    // is never a valid recruit order — the button must be disabled, not silently do nothing.
    button.disabled = true;
    return;
  }
  const totalCost = unit.cost * count;
  const used = GameEngine.computeVillagePopulationUsed(village);
  const reserved = GameEngine.computeVillageReservedPopulation(village);
  const capacity = GameEngine.getVillagePopulationCapacity(village);
  const needed = (GameEngine.unitPopulationCost[unitId] || 0) * count;
  button.disabled = state.gold < totalCost || used + reserved + needed > capacity;
}

function refreshRecruitButtonStates() {
  if (!selectors.recruitTableBody) return;
  state.units.forEach((unit) => updateRecruitButtonState(unit.id));
}

function updateGarrison() {
  if (!selectors.garrisonTableBody) return;
  selectors.garrisonTableBody.innerHTML = '';
  const village = getCurrentPlayerVillage();
  const garrison = (village && village.garrison && typeof village.garrison === 'object') ? village.garrison : GameEngine.defaultVillageGarrison();
  state.units.forEach((unit) => {
    const row = document.createElement('tr');
    row.dataset.unitRow = unit.id;
    row.innerHTML = `
      <td>${wolUnitName(unit)}</td>
      <td>${formatMinSec(GameEngine.getAttackTravelTime(unit.id))}</td>
      <td>${formatNumber(garrison[unit.id] || 0)}</td>
    `;
    selectors.garrisonTableBody.appendChild(row);
  });
  renderLordRecruitStatus(village);
  renderReinforcements(village);
}

// The Lord trains on its own independent timer (see GameEngine.recruitUnit/village.lordQueue),
// so it gets its own small status box next to the garrison table instead of showing up in the
// regular recruitment queue with the rest of the army.
function buildLordRecruitItemHtml(item, villageId) {
  const remaining = Math.max(0, Math.ceil((item.endTime - Date.now()) / 1000));
  return `
    <div class="lord-recruit-info">${i18n.t('game.recruit.lordArrives', { time: formatClock(remaining) })}</div>
    <button class="lord-recruit-cancel" data-village="${villageId}">${i18n.t('common.cancel')}</button>
  `;
}

function patchLordRecruitCountdown(item) {
  const el = selectors.lordRecruitItem && selectors.lordRecruitItem.querySelector('[data-lord-countdown]');
  if (!el) return;
  const remaining = Math.max(0, Math.ceil((item.endTime - Date.now()) / 1000));
  el.textContent = formatClock(remaining);
}

function renderLordRecruitStatus(village) {
  if (!selectors.lordRecruitSection || !selectors.lordRecruitItem) return;
  const item = (village && Array.isArray(village.lordQueue)) ? village.lordQueue[0] : null;
  if (!item) {
    selectors.lordRecruitSection.style.display = 'none';
    selectors.lordRecruitItem.innerHTML = '';
    return;
  }
  selectors.lordRecruitSection.style.display = 'block';
  renderStructuralIfChanged(
    selectors.lordRecruitItem,
    { villageId: village.id, startTime: item.startTime, endTime: item.endTime },
    () => {
      selectors.lordRecruitItem.innerHTML = buildLordRecruitItemHtml(item, village.id);
    },
    () => patchLordRecruitCountdown(item)
  );
}

function cancelLordRecruit(villageId) {
  if (state.roundStatus === 'finished') return;
  emitCommand('game:cancelLordRecruit', { villageId });
}

// Reinforcements (troops another of your own villages sent here to help defend) are shown
// separately from the native garrison above — this village can't send them out on an attack.
// Each home village that sent support gets its OWN "Wycofaj wsparcie" button, so you can recall
// one village's troops while leaving another's support in place (see game:recallSupport).
function renderReinforcements(village) {
  if (!selectors.reinforcementsSection || !selectors.reinforcementsList) return;
  const batches = (village && Array.isArray(village.reinforcements)) ? village.reinforcements : [];
  if (!batches.length) {
    selectors.reinforcementsSection.style.display = 'none';
    selectors.reinforcementsList.innerHTML = '';
    return;
  }
  selectors.reinforcementsSection.style.display = 'block';
  const myName = getCurrentPlayer()?.name;
  const rows = batches.map((batch) => {
    const summary = Object.entries(batch.units || {})
      .filter(([, count]) => Number(count) > 0)
      .map(([unitId, count]) => {
        const unit = state.units.find((item) => item.id === unitId);
        return `${unit ? wolUnitName(unit) : unitId} x${count}`;
      }).join(', ');
    // Team mode: support can now arrive from a teammate's own village, not just your own other
    // villages — call out the sender's name whenever it isn't you, so it reads as "wsparcie od
    // sojusznika" rather than looking like your own reinforcement.
    const fromAlly = batch.ownerName && batch.ownerName !== myName ? i18n.t('game.garrison.fromAlly', { name: batch.ownerName }) : '';
    return { id: batch.id, label: i18n.tText(batch.sourceLabel) || batch.sourceVillageId, fromAlly, summary };
  });
  renderIfChanged(selectors.reinforcementsList, rows, () => {
    selectors.reinforcementsList.innerHTML = rows.map((row) => `
      <div class="reinforcements-item">
        <div class="reinforcements-item-info">${row.label}${row.fromAlly}: ${row.summary || i18n.t('game.garrison.none')}</div>
        <button type="button" class="recall-support-button" data-reinforcement-id="${row.id}">${i18n.t('game.garrison.recallSupport')}</button>
      </div>
    `).join('');
  });
}

// The map is always the central panel now ("Przegląd wioski" — a village-overview placeholder that
// never actually rendered an image — was removed entirely). This just keeps the team-map-specific
// classes/aspect-ratio in sync and refreshes the node layer on every state tick.
function updateMapDisplay() {
  selectors.villageImage.classList.toggle('map-team', state.mapType === 'team');
  // Reshapes the shared #imageCard box to the team map image's own aspect ratio.
  if (selectors.imageCard) selectors.imageCard.classList.toggle('map-team-active', state.mapType === 'team');
  renderMapNodes();
}

function openUpgradeModal() {
  renderUpgradeTable();
  updateHeader();
  selectors.upgradeModal.classList.add('active');
}

function closeUpgradeModal() {
  selectors.upgradeModal.classList.remove('active');
}

function renderUpgradeTable() {
  const player = getCurrentPlayer();
  const village = getCurrentPlayerVillage();
  if (!player || !village) {
    renderIfChanged(selectors.upgradeTableBody, 'no-village', () => {
      selectors.upgradeTableBody.innerHTML = '';
      const row = document.createElement('tr');
      row.innerHTML = `<td colspan="4">${i18n.t('game.upgrade.noVillage')}</td>`;
      selectors.upgradeTableBody.appendChild(row);
    });
    renderBuildQueue();
    return;
  }
  const buildings = village.buildings || [];
  const queueSize = (village.buildQueue || []).length;
  const villagePoints = computeVillagePoints(village);
  if (selectors.villagePointsDisplay) {
    selectors.villagePointsDisplay.textContent = i18n.t('game.upgrade.points', { n: formatNumber(villagePoints) });
  }
  const rows = buildings.map((building) => {
    const projectedLevel = GameEngine.getProjectedBuildingLevel(village, building.id);
    const nextLevel = projectedLevel + 1;
    const cost = GameEngine.getBuildingCost(building, nextLevel);
    const time = GameEngine.getBuildingTime(building, nextLevel);
    const canBuildCastle = building.id !== 'castle' || (village.buildings.find((b) => b.id === 'townHall')?.level >= 10);
    const roundFinished = state.roundStatus === 'finished';
    const disabled = projectedLevel >= building.maxLevel || queueSize >= 3 || state.gold < cost || !canBuildCastle || roundFinished;
    const canAfford = !roundFinished && projectedLevel < building.maxLevel && state.gold >= cost && queueSize < 3 && canBuildCastle;
    const buttonLabel = projectedLevel < building.maxLevel ? (canBuildCastle ? i18n.t('game.upgrade.upgradeBtn') : i18n.t('game.upgrade.needsTownHall')) : i18n.t('game.upgrade.max');
    // 2026-10-02, player UX feedback ("nie mam pojęcia po co rozbudowuję budynki, który upgrade
    // ile mi daje") — short current->next effect line, same formulas the engine itself uses.
    const effect = GameEngine.getBuildingEffectDescription(building.id, building.level, projectedLevel + 1);
    return { id: building.id, label: wolBuildingName(building), level: building.level, maxLevel: building.maxLevel, cost, time, disabled, canAfford, buttonLabel, effect };
  });
  renderIfChanged(selectors.upgradeTableBody, { villageId: village.id, rows }, () => {
    selectors.upgradeTableBody.innerHTML = '';
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div class="unit-name">${row.label}</div>
          ${row.effect ? `<div class="unit-meta">${i18n.tText(row.effect)}</div>` : ''}
        </td>
        <td>${row.level}/${row.maxLevel}</td>
        <td>${i18n.t('game.gold', { n: formatNumber(row.cost) })}</td>
        <td>${row.time}s</td>
        <td><button class="upgrade-button ${row.canAfford ? 'can-afford' : 'cannot-afford'}" data-village="${village.id}" data-building="${row.id}" ${row.disabled ? 'disabled' : ''}>${row.buttonLabel}</button></td>
      `;
      selectors.upgradeTableBody.appendChild(tr);
    });
  });
  renderBuildQueue();
}

function buildBuildQueueItemHtml(item, index, villageId) {
  const isCurrent = index === 0;
  const durationSeconds = Number(item.buildDurationSeconds) || 1;
  return `
    <div class="queue-item ${isCurrent ? 'current' : 'waiting'}" data-queue-index="${index}">
      <div class="queue-item-details">
        <strong>${index + 1}. ${i18n.tText(item.name)}</strong>
        <div class="queue-item-meta">
          <div>${i18n.t('game.queue.level', { n: item.targetLevel })}</div>
          <div>${i18n.t('game.queue.cost', { n: formatNumber(item.cost) })}</div>
          <div>${i18n.t('game.queue.buildTime', { n: durationSeconds })}</div>
        </div>
        ${isCurrent ? `<div class="progress-bar"><div class="progress-fill" data-progress-fill></div></div>` : `<div class="queue-waiting">${i18n.t('game.queue.waiting')}</div>`}
      </div>
      <div class="queue-actions">
        <div class="queue-time" data-queue-time></div>
        <button class="queue-cancel" data-village="${villageId}" data-index="${index}">${i18n.t('common.cancel')}</button>
      </div>
    </div>
  `;
}

function patchBuildQueueCountdowns(queue) {
  const queueContainer = selectors.buildQueueList;
  if (!queueContainer) return;
  const now = Date.now();
  queue.forEach((item, index) => {
    const itemEl = queueContainer.querySelector(`.queue-item[data-queue-index="${index}"]`);
    if (!itemEl) return;
    const isCurrent = index === 0;
    const timeEl = itemEl.querySelector('[data-queue-time]');
    if (timeEl) {
      timeEl.textContent = isCurrent ? `${Math.max(0, Math.ceil((item.endTime - now) / 1000))}s` : 'oczekuje';
    }
    if (isCurrent) {
      const durationMs = (Number(item.buildDurationSeconds) || 1) * 1000;
      const elapsed = Math.max(0, Math.min(now - item.startTime, durationMs));
      const progressFill = itemEl.querySelector('[data-progress-fill]');
      if (progressFill) progressFill.style.width = `${Math.round((elapsed / durationMs) * 100)}%`;
    }
  });
}

function renderBuildQueue() {
  const queueContainer = selectors.buildQueueList;
  if (!queueContainer) return;
  const village = getCurrentPlayerVillage();
  if (!village) {
    renderIfChanged(queueContainer, 'no-village', () => {
      queueContainer.innerHTML = `<div class="queue-empty">${i18n.t('game.upgrade.noActiveVillage')}</div>`;
    });
    return;
  }
  const queue = village.buildQueue || [];
  if (queue.length === 0) {
    renderIfChanged(queueContainer, 'empty', () => {
      queueContainer.innerHTML = `<div class="queue-empty">${i18n.t('game.upgrade.emptyQueue')}</div>`;
    });
    return;
  }
  // Structural signature deliberately excludes anything that changes every second on its own
  // (countdown text/progress %) - see renderStructuralIfChanged.
  const signature = queue.map((item) => ({
    name: item.name, targetLevel: item.targetLevel, cost: item.cost,
    buildDurationSeconds: item.buildDurationSeconds, startTime: item.startTime, endTime: item.endTime
  }));
  renderStructuralIfChanged(
    queueContainer,
    { villageId: village.id, signature },
    () => {
      queueContainer.innerHTML = queue.map((item, index) => buildBuildQueueItemHtml(item, index, village.id)).join('');
      patchBuildQueueCountdowns(queue);
    },
    () => patchBuildQueueCountdowns(queue)
  );
}

function renderRecruitmentQueue() {
  const queueContainer = selectors.recruitmentQueueList;
  if (!queueContainer) return;
  const village = getCurrentPlayerVillage();
  if (!village) {
    renderIfChanged(queueContainer, 'no-village', () => {
      queueContainer.innerHTML = `<div class="queue-empty">${i18n.t('game.upgrade.noActiveVillage')}</div>`;
    });
    return;
  }
  const queue = village.recruitQueue || [];
  if (queue.length === 0) {
    renderIfChanged(queueContainer, 'empty', () => {
      queueContainer.innerHTML = `<div class="queue-empty">${i18n.t('game.recruit.emptyQueue')}</div>`;
    });
    return;
  }
  // Structural signature deliberately excludes anything that changes every second on its own
  // (countdown text/progress %) - see renderStructuralIfChanged. remainingUnits IS included since
  // it changes the "unitIndex" header (e.g. "2/3") whenever a single unit finishes training.
  const signature = queue.map((item) => ({
    unitId: item.unitId, name: item.name, count: item.count, remainingUnits: item.remainingUnits,
    cost: item.cost, unitDurationSeconds: item.unitDurationSeconds, startTime: item.startTime, endTime: item.endTime
  }));
  renderStructuralIfChanged(
    queueContainer,
    { villageId: village.id, signature },
    () => {
      queueContainer.innerHTML = queue.map((item, index) => buildRecruitQueueItemHtml(item, index, village.id)).join('');
      patchRecruitQueueCountdowns(queue);
    },
    () => patchRecruitQueueCountdowns(queue)
  );
}

function buildRecruitQueueItemHtml(item, index, villageId) {
  const isCurrent = index === 0;
  const unitDurationSeconds = Number(item.unitDurationSeconds) || 1;
  const totalDurationSeconds = unitDurationSeconds * item.count;
  const remainingUnits = Number.isFinite(item.remainingUnits) ? item.remainingUnits : item.count;
  const reservedPopulation = remainingUnits * (GameEngine.unitPopulationCost[item.unitId] || 0);
  const unitIndex = item.count - item.remainingUnits + 1;
  return `
    <div class="queue-item ${isCurrent ? 'current' : 'waiting'}" data-queue-index="${index}">
      <div class="queue-item-details">
        <strong>${index + 1}. ${i18n.tText(item.name)} ${isCurrent ? `${unitIndex}/${item.count}` : `x${item.count}`}</strong>
        <div>${i18n.t('game.queue.cost', { n: formatNumber(item.cost) })}</div>
        <div>${i18n.t('game.queue.population', { n: formatNumber(reservedPopulation) })} ${remainingUnits > 0 ? i18n.t('game.queue.reservedFor', { n: remainingUnits }) : ''}</div>
        <div>${i18n.t('game.queue.unitTime', { n: unitDurationSeconds })}</div>
        <div>${i18n.t('game.queue.totalTime', { n: totalDurationSeconds })}</div>
        ${isCurrent ? `<div class="progress-bar"><div class="progress-fill" data-progress-fill></div></div>` : `<div class="queue-waiting">${i18n.t('game.queue.waiting')}</div>`}
      </div>
      <div class="queue-actions">
        <div class="queue-time" data-queue-time></div>
        <button class="queue-cancel" data-village="${villageId}" data-index="${index}">${i18n.t('common.cancel')}</button>
      </div>
    </div>
  `;
}

function patchRecruitQueueCountdowns(queue) {
  const queueContainer = selectors.recruitmentQueueList;
  if (!queueContainer) return;
  const now = Date.now();
  queue.forEach((item, index) => {
    const itemEl = queueContainer.querySelector(`.queue-item[data-queue-index="${index}"]`);
    if (!itemEl) return;
    const isCurrent = index === 0;
    const unitDurationSeconds = Number(item.unitDurationSeconds) || 1;
    const timeEl = itemEl.querySelector('[data-queue-time]');
    if (isCurrent) {
      const currentUnitRemaining = Math.max(0, Math.ceil((item.endTime - now) / 1000));
      const remainingUnits = Number.isFinite(item.remainingUnits) ? item.remainingUnits : item.count;
      const wholeRemainingSeconds = currentUnitRemaining + Math.max(0, (remainingUnits - 1) * unitDurationSeconds);
      const readyClock = new Date(now + wholeRemainingSeconds * 1000).toLocaleTimeString(wolLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      if (timeEl) timeEl.textContent = `gotowe o ${readyClock} (za ${wholeRemainingSeconds}s)`;
      const durationMs = unitDurationSeconds * 1000;
      const elapsed = Math.max(0, Math.min(now - item.startTime, durationMs));
      const progressFill = itemEl.querySelector('[data-progress-fill]');
      if (progressFill) progressFill.style.width = `${Math.round((elapsed / durationMs) * 100)}%`;
    } else {
      const remainingUnits = Number.isFinite(item.remainingUnits) ? item.remainingUnits : item.count;
      const batchEndTime = item.startTime + remainingUnits * unitDurationSeconds * 1000;
      const readyClock = new Date(batchEndTime).toLocaleTimeString(wolLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      if (timeEl) timeEl.textContent = `gotowe o ${readyClock}`;
    }
  });
}

// --- Active attacks / reports (pure display filters — never mutate state) -----------------------

function isAttackVisibleToPlayer(attack, playerName) {
  if (!attack || !playerName) return false;
  if (attack.attackerName === playerName) return true;
  if (attack.direction === 'return') return false;
  const targetVillage = state.villages[attack.targetVillageId];
  if (targetVillage?.owner === playerName) return true;
  if (attack.targetPlayerName === playerName) return true;
  return false;
}

function buildActiveAttackItemHtml(attack, meta) {
  // Line 1 always leads with WHAT is happening and to/from WHICH village — that's the thing a
  // player scanning this list actually needs first ("czy ktoś atakuje MOJĄ wioskę X?"), not buried
  // after the unit list. Line 2 is everything secondary (units, arrival time). Still exactly the
  // same two lines as before — nothing here makes the panel any taller, just reordered/reworded.
  const icon = meta.attackKind === 'return' ? '↩️' : (meta.attackKind === 'outgoing' ? '⚔️' : '🛡️');
  const headline = meta.attackKind === 'return' ? `Wraca do: ${meta.targetLabel}`
    : meta.attackKind === 'outgoing' ? i18n.t('game.attacks.youAttack', { target: i18n.tText(meta.targetLabel) })
    : i18n.t('game.attacks.attackOn', { target: i18n.tText(meta.targetLabel) });
  const metaParts = [`Z: ${meta.sourceLabel}`];
  if (meta.unitSummary.length) metaParts.push(meta.unitSummary.join(', '));
  metaParts.push(`przybycie ${meta.arrivalClock}`);
  return `
    <div class="active-attack-item ${meta.columnClass}" data-attack-item-id="${attack.id}">
      <div class="active-attack-header">
        <strong>${icon} ${headline}</strong>
        <span class="active-attack-time" data-attack-time></span>
      </div>
      <div class="active-attack-meta">${metaParts.join(' · ')}</div>
      ${meta.isCancellable ? `<button type="button" class="active-attack-cancel" data-attack-id="${attack.id}">${i18n.t('common.cancel')}</button>` : ''}
    </div>
  `;
}

function patchActiveAttacksCountdowns(activeAttacks) {
  const container = selectors.activeAttacksList;
  if (!container) return;
  const now = Date.now();
  activeAttacks.forEach((attack) => {
    const itemEl = container.querySelector(`.active-attack-item[data-attack-item-id="${attack.id}"]`);
    const timeEl = itemEl ? itemEl.querySelector('[data-attack-time]') : null;
    if (timeEl) timeEl.textContent = formatClock(Math.ceil(Math.max(0, attack.arrivesAt - now) / 1000));
  });
}

function renderActiveAttacks() {
  if (!selectors.activeAttacksList) return;
  // This panel rebuilds on every ~1s server tick, which used to reset both scrollable columns
  // (outgoing/incoming) back to the top mid-scroll. Remember where the user had scrolled to and
  // restore it after rebuilding — same fix as the recruitment input / reports expand-state.
  const scrollPositions = Array.from(selectors.activeAttacksList.querySelectorAll('.active-attacks-column-list'))
    .map((el) => el.scrollTop);
  const currentPlayer = getCurrentPlayer();
  const currentVillage = getCurrentPlayerVillage();
  const activeAttacks = (state.attacks || [])
    .filter((attack) => attack && attack.arrivesAt && attack.arrivesAt > Date.now())
    .filter((attack) => isAttackVisibleToPlayer(attack, currentPlayer?.name))
    // Ties on arrival time (down to the same second) are broken by send order, so lining up
    // several attacks from different villages to land together shows them in a sensible order.
    .sort((a, b) => (a.arrivesAt - b.arrivesAt) || ((a.sentAt || 0) - (b.sentAt || 0)));
  if (!activeAttacks.length) {
    renderIfChanged(selectors.activeAttacksList, 'empty', () => {
      selectors.activeAttacksList.innerHTML = `<div class="active-attack-empty">${i18n.t('game.attacks.none')}</div>`;
    });
    return;
  }

  const outgoingEntries = [];
  const incomingEntries = [];
  const signature = [];

  activeAttacks.forEach((attack) => {
    const sourceVillage = state.villages[attack.sourceVillageId];
    const targetVillage = state.villages[attack.targetVillageId];
    const isReturning = attack.direction === 'return';
    const isOutgoing = isReturning
      ? (targetVillage?.owner === currentPlayer?.name || targetVillage?.id === currentVillage?.id)
      : (sourceVillage?.owner === currentPlayer?.name || sourceVillage?.id === currentVillage?.id);
    const directionLabel = isReturning ? i18n.t('game.attacks.returning') : (isOutgoing ? i18n.t('game.attacks.sending') : i18n.t('game.attacks.incoming'));
    const sourceLabel = i18n.tText(sourceVillage?.label) || attack.sourceVillageId;
    const targetLabel = i18n.tText(targetVillage?.label) || attack.targetVillageId;
    // The defender must not see what an incoming attack is made of — only that it's coming.
    const unitSummary = (isOutgoing || isReturning)
      ? (attack.units || []).map((entry) => {
          const unit = state.units.find((item) => item.id === entry.unitId);
          return `${unit ? wolUnitName(unit) : entry.unitId} x${entry.count}`;
        }).filter(Boolean)
      : [];
    const arrivalClock = new Date(attack.arrivesAt).toLocaleTimeString(wolLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const isCancellable = isOutgoing && !isReturning;
    const columnClass = isOutgoing || isReturning ? 'outgoing' : 'incoming';
    const attackKind = isReturning ? 'return' : (isOutgoing ? 'outgoing' : 'incoming');
    const meta = { directionLabel, unitSummary, sourceLabel, targetLabel, arrivalClock, isCancellable, columnClass, attackKind };
    (columnClass === 'outgoing' ? outgoingEntries : incomingEntries).push({ attack, meta });
    // Structural signature deliberately excludes the live countdown (formatClock(remainingSeconds))
    // - see renderStructuralIfChanged - patchActiveAttacksCountdowns keeps that updated every tick.
    signature.push({ id: attack.id, ...meta });
  });

  renderStructuralIfChanged(
    selectors.activeAttacksList,
    signature,
    () => {
      const outgoingHtml = outgoingEntries.length
        ? outgoingEntries.map(({ attack, meta }) => buildActiveAttackItemHtml(attack, meta)).join('')
        : `<div class="active-attack-empty">${i18n.t('game.attacks.noneSent')}</div>`;
      const incomingHtml = incomingEntries.length
        ? incomingEntries.map(({ attack, meta }) => buildActiveAttackItemHtml(attack, meta)).join('')
        : `<div class="active-attack-empty">${i18n.t('game.attacks.noneIncoming')}</div>`;
      selectors.activeAttacksList.innerHTML = `
        <div class="active-attacks-columns">
          <div class="active-attacks-column outgoing">
            <div class="active-attacks-column-title">${i18n.t('game.attacks.sentCol')}</div>
            <div class="active-attacks-column-list">${outgoingHtml}</div>
          </div>
          <div class="active-attacks-column incoming">
            <div class="active-attacks-column-title">${i18n.t('game.attacks.incomingCol')}</div>
            <div class="active-attacks-column-list">${incomingHtml}</div>
          </div>
        </div>
      `;
      selectors.activeAttacksList.querySelectorAll('.active-attacks-column-list').forEach((el, index) => {
        if (scrollPositions[index]) el.scrollTop = scrollPositions[index];
      });
      patchActiveAttacksCountdowns(activeAttacks);
    },
    () => patchActiveAttacksCountdowns(activeAttacks)
  );
}

function normalizeReportForDisplay(report) {
  if (!report) return null;
  if (Array.isArray(report.attackers) || report.type === 'recon') return report;
  const hasDefender = report.defenderUnitLabel && report.defenderUnitLabel !== 'brak' && report.defenderUnitLabel !== 'brak obrońców';
  return {
    id: report.id || `legacy-${report.timestamp}`,
    timestamp: report.timestamp,
    type: 'battle',
    attackerName: report.attackerName || 'Nieznany',
    defenderName: null,
    sourceVillageLabel: null,
    targetVillageLabel: report.targetVillageLabel || 'Wioska',
    attackers: [{ label: report.attackerUnitLabel || 'Wojsko', sent: Number(report.attackerCount) || 0, lost: Number(report.attackerLosses) || 0, survived: Number(report.survivingCount) || 0 }],
    defenders: hasDefender ? [{ label: report.defenderUnitLabel, lost: Number(report.defenderLosses) || 0 }] : [],
    attackerLosses: Number(report.attackerLosses) || 0,
    defenderLosses: Number(report.defenderLosses) || 0,
    attackerPoints: Number(report.defenderLosses) || 0,
    defenderPoints: Number(report.attackerLosses) || 0,
    outcome: report.success ? 'Zwycięstwo' : 'Porażka',
    success: Boolean(report.success)
  };
}

function isReportVisibleToPlayer(report, playerName) {
  if (!report || !playerName) return false;
  if (report.attackerName === playerName) return true;
  if (report.defenderName && report.defenderName === playerName) return true;
  return false;
}

function isReportInSelectedMode(report, playerName, mode) {
  if (!report || !playerName) return false;
  if (mode === 'defense') return report.defenderName === playerName;
  return report.attackerName === playerName;
}

function setReportsMode(mode) {
  state.reportsMode = mode === 'defense' ? 'defense' : 'attack';
  if (selectors.reportsModeAttackBtn) selectors.reportsModeAttackBtn.classList.toggle('active', state.reportsMode === 'attack');
  if (selectors.reportsModeDefenseBtn) selectors.reportsModeDefenseBtn.classList.toggle('active', state.reportsMode === 'defense');
  const byMode = visibleReportsByMode();
  markModeSeen(state.reportsMode, byMode);
  updateReportModeBadges(byMode);
  renderReports();
}

function renderReports() {
  if (!selectors.reportsList) return;
  const openReportKeys = Array.from(selectors.reportsList.querySelectorAll('details[open]'))
    .map((el) => el.dataset.reportKey)
    .filter(Boolean);
  const currentPlayer = getCurrentPlayer();
  const visibleReports = state.reports
    .map((rawReport) => normalizeReportForDisplay(rawReport))
    .filter((report) => report && isReportVisibleToPlayer(report, currentPlayer?.name))
    .filter((report) => isReportInSelectedMode(report, currentPlayer?.name, state.reportsMode));
  if (!visibleReports.length) {
    renderIfChanged(selectors.reportsList, `empty:${state.reportsMode}`, () => {
      selectors.reportsList.innerHTML = state.reportsMode === 'defense' ? `<div class="report-empty">${i18n.t('game.reports.noDefense')}</div>` : `<div class="report-empty">${i18n.t('game.reports.noAttack')}</div>`;
    });
    return;
  }
  // Report contents never change after the fact (each is a frozen snapshot of a past battle), so a
  // plain id-list signature is enough to skip the rebuild entirely on ticks where nothing new
  // arrived - avoiding the destroy/recreate cycle on every <details>/<summary> below.
  const reportsSignature = { mode: state.reportsMode, ids: visibleReports.map((r) => r.id || r.timestamp) };
  renderIfChanged(selectors.reportsList, reportsSignature, () => {
    selectors.reportsList.innerHTML = visibleReports.map((report) => {
    const timeLabel = new Date(report.timestamp).toLocaleString(wolLocale());
    const isViewerDefender = currentPlayer?.name !== report.attackerName && currentPlayer?.name === report.defenderName;
    const viewerWon = isViewerDefender ? !report.success : report.success;
    const headerLabel = report.type === 'battle' ? (viewerWon ? i18n.t('game.reports.victory') : i18n.t('game.reports.defeat')) : (i18n.tText(report.outcome) || (report.success ? i18n.t('game.reports.victory') : i18n.t('game.reports.defeat')));
    const summaryBar = `
      <summary class="report-summary">
        <div class="report-header">
          <strong>${headerLabel}</strong>
          <span class="report-time">${timeLabel}</span>
        </div>
        <div class="report-sides">
          <div class="report-side">
            <div class="report-side-role">${i18n.t('game.reports.attacker')}</div>
            <div class="report-side-name">${i18n.tText(report.attackerName)}</div>
            ${report.sourceVillageLabel ? `<div class="report-side-village">${i18n.tText(report.sourceVillageLabel)}</div>` : ''}
          </div>
          <div class="report-side-arrow">→</div>
          <div class="report-side">
            <div class="report-side-role">${i18n.t('game.reports.defender')}</div>
            <div class="report-side-name">${report.defenderName || i18n.tText('Nieznany')}</div>
            <div class="report-side-village">${i18n.tText(report.targetVillageLabel)}</div>
          </div>
        </div>
      </summary>
    `;

    if (report.type === 'recon') {
      const isViewerAttacker = currentPlayer?.name === report.attackerName;
      const noteText = report.success
        ? (isViewerAttacker
          ? i18n.t('game.reports.reconOk', { sent: formatNumber(report.scoutsSent), lost: formatNumber(report.scoutsLost), back: formatNumber(report.scoutsSurvived) })
          : i18n.t('game.reports.reconAgainstYou'))
        : i18n.t('game.reports.reconFailed', { lost: formatNumber(report.scoutsLost) });
      const intelSection = (report.success && isViewerAttacker && report.intel)
        ? `
          <div class="report-tables">
            <div class="report-table-block">
              <div class="report-table-title">${i18n.t('game.reports.buildings')}</div>
              <table class="report-mini-table">
                <thead><tr><th>${i18n.t('game.upgrade.building')}</th><th>${i18n.t('game.upgrade.level')}</th></tr></thead>
                <tbody>${report.intel.buildings.map((building) => `<tr><td>${wolBuildingName(building)}</td><td>${building.level}/${building.maxLevel}</td></tr>`).join('')}</tbody>
              </table>
            </div>
            <div class="report-table-block">
              <div class="report-table-title">${i18n.t('game.reports.garrison')}</div>
              <table class="report-mini-table">
                <thead><tr><th>${i18n.t('game.reports.unit')}</th><th>${i18n.t('game.reports.count')}</th></tr></thead>
                <tbody>${state.units.map((unit) => `<tr><td>${wolUnitName(unit)}</td><td>${formatNumber(report.intel.garrison[unit.id] || 0)}</td></tr>`).join('')}</tbody>
              </table>
            </div>
          </div>
        `
        : `<p class="report-recon-note">${noteText}</p>`;
      return `<details class="report-item ${viewerWon ? 'report-win' : 'report-loss'}" data-report-key="${report.id || report.timestamp}">${summaryBar}<div class="report-details">${intelSection}</div></details>`;
    }

    const attackers = Array.isArray(report.attackers) ? report.attackers : [];
    const defenders = Array.isArray(report.defenders) ? report.defenders : [];
    const attackersRows = attackers.length
      ? attackers.map((unit) => `<tr><td>${i18n.tText(unit.label)}</td><td>${formatNumber(unit.sent)}</td><td class="report-loss-cell">${unit.lost > 0 ? `-${formatNumber(unit.lost)}` : '—'}</td></tr>`).join('')
      : `<tr><td colspan="3">${i18n.t('game.reports.noData')}</td></tr>`;

    // Whoever WON the battle (attacker or defender, from their own point of view) also gets to see
    // how many troops of each type the defender actually had before the fight - not just which
    // ones took losses. Falls back to the old loss-only table when that data isn't on the report
    // (older reports generated before this field existed) or the viewer didn't win.
    const garrisonBeforeBattle = Array.isArray(report.defenderGarrisonBeforeBattle) ? report.defenderGarrisonBeforeBattle : null;
    let defendersHeader = `<tr><th>${i18n.t('game.reports.unit')}</th><th>${i18n.t('game.reports.losses')}</th></tr>`;
    let defendersRows;
    if (viewerWon && garrisonBeforeBattle && garrisonBeforeBattle.length) {
      defendersHeader = `<tr><th>${i18n.t('game.reports.unit')}</th><th>${i18n.t('game.reports.state')}</th><th>${i18n.t('game.reports.losses')}</th></tr>`;
      defendersRows = garrisonBeforeBattle.map((unit) => {
        const lossEntry = defenders.find((item) => item.label === unit.label);
        const lost = Number(lossEntry?.lost) || 0;
        return `<tr><td>${i18n.tText(unit.label)}</td><td>${formatNumber(unit.count)}</td><td class="report-loss-cell">${lost > 0 ? `-${formatNumber(lost)}` : '—'}</td></tr>`;
      }).join('');
    } else {
      defendersRows = defenders.length
        ? defenders.map((unit) => `<tr><td>${i18n.tText(unit.label)}</td><td class="report-loss-cell">${unit.lost > 0 ? `-${formatNumber(unit.lost)}` : '—'}</td></tr>`).join('')
        : `<tr><td colspan="2">${i18n.t('game.reports.noDefenders')}</td></tr>`;
    }

    // A capture is always the Lord's DOING - if that same strike also ground down loyalty (the
    // normal case, vs. the team-mode "unowned village" instant capture which skips the loyalty
    // grind entirely), say both in one line instead of leaving the capture itself unmentioned here.
    let lordLoyaltyNote = '';
    if (report.capturedVillage) {
      lordLoyaltyNote = Number(report.lordLoyaltyDamageDealt) > 0
        ? `<div class="report-lord-loyalty">${i18n.t('game.reports.lordCapturedAfter', { n: formatNumber(report.lordLoyaltyDamageDealt) })}</div>`
        : `<div class="report-lord-loyalty">${i18n.t('game.reports.lordCaptured')}</div>`;
    } else if (Number(report.lordLoyaltyDamageDealt) > 0) {
      lordLoyaltyNote = `<div class="report-lord-loyalty">${i18n.t('game.reports.lordReduced', { n: formatNumber(report.lordLoyaltyDamageDealt) })}</div>`;
    }

    // Rams only show up here on strikes that actually ground the wall down a level - see
    // applyRamWallDamage in gameEngine.js for the 100-rams/50%-survival formula behind this.
    const wallDamageNote = (Number.isFinite(report.wallLevelBefore) && Number.isFinite(report.wallLevelAfter) && report.wallLevelAfter < report.wallLevelBefore)
      ? `<div class="report-lord-loyalty">${i18n.t('game.reports.ramsWall', { before: report.wallLevelBefore, after: report.wallLevelAfter })}</div>`
      : '';

    return `
      <details class="report-item ${viewerWon ? 'report-win' : 'report-loss'}" data-report-key="${report.id || report.timestamp}">
        ${summaryBar}
        <div class="report-details">
          ${lordLoyaltyNote}
          ${wallDamageNote}
          <div class="report-tables">
            <div class="report-table-block">
              <div class="report-table-title">${i18n.t('game.reports.attackingTroops')}</div>
              <table class="report-mini-table"><thead><tr><th>${i18n.t('game.reports.unit')}</th><th>${i18n.t('game.reports.sent')}</th><th>${i18n.t('game.reports.losses')}</th></tr></thead><tbody>${attackersRows}</tbody></table>
            </div>
            <div class="report-table-block">
              <div class="report-table-title">${i18n.t('game.reports.defendingTroops')}</div>
              <table class="report-mini-table"><thead>${defendersHeader}</thead><tbody>${defendersRows}</tbody></table>
            </div>
          </div>
          <div class="report-footer">
            <span>${i18n.t('game.reports.lossesLine', { a: formatNumber(report.attackerLosses), d: formatNumber(report.defenderLosses) })}</span>
            <span>${i18n.t('game.reports.pointsLine', { a: formatNumber(report.attackerPoints), d: formatNumber(report.defenderPoints) })}</span>
          </div>
        </div>
      </details>
    `;
  }).join('');
    // Restore whichever reports were open right before this rebuild, matched by their
    // (effectively unique) timestamp key - a fresh innerHTML always starts every <details> closed.
    openReportKeys.forEach((key) => {
      const el = selectors.reportsList.querySelector(`details[data-report-key="${key}"]`);
      if (el) el.open = true;
    });
  });
}

let lastSeenReportId;
// False until the very first checkForNewReports() call completes - that call always just
// establishes the baseline (whatever's newest at that moment, even if nothing has arrived yet)
// without blinking, so a backlog of reports that already existed before this session opened never
// blinks. Tracked separately from lastSeenReportId itself (rather than reusing its `undefined`
// state as the "not initialized yet" marker) because a brand-new round starts with ZERO reports:
// that first check would see newest===null, leave lastSeenReportId at undefined, and then the
// genuinely first-ever report to arrive would be misread as "still initializing" and skip its
// highlight - exactly the reported "first report doesn't blink, second one does" bug.
let reportsBaselineInitialized = false;

function findNewestVisibleReport() {
  const currentPlayer = getCurrentPlayer();
  if (!currentPlayer) return null;
  for (const rawReport of state.reports) {
    const normalized = normalizeReportForDisplay(rawReport);
    if (normalized && isReportVisibleToPlayer(normalized, currentPlayer.name)) return normalized;
  }
  return null;
}

// Puts a pulsing highlight on the "Raporty" button the moment a NEW report the player can see
// arrives (state.reports is newest-first, see addBattleReport) while they aren't already looking
// at the reports modal - cleared again in markReportsAsSeen() once they open it.
// Per-tab tracking (Attack / Defence inside the reports window): a report counts as "seen" once its
// own tab was shown. notifiedReportIds = reports that existed when the window was last opened (the
// main "Reports" button only lights up again for reports that arrived after that).
const seenReportIds = new Set();
const notifiedReportIds = new Set();
const reportKey = (report) => String(report.id || report.timestamp);

function visibleReportsByMode() {
  const currentPlayer = getCurrentPlayer();
  const out = { attack: [], defense: [] };
  if (!currentPlayer) return out;
  for (const rawReport of state.reports) {
    const r = normalizeReportForDisplay(rawReport);
    if (!r || !isReportVisibleToPlayer(r, currentPlayer.name)) continue;
    if (isReportInSelectedMode(r, currentPlayer.name, 'attack')) out.attack.push(r);
    if (isReportInSelectedMode(r, currentPlayer.name, 'defense')) out.defense.push(r);
  }
  return out;
}

function updateReportModeBadges(byMode) {
  const unseen = (mode) => byMode[mode].some((r) => !seenReportIds.has(reportKey(r)));
  if (selectors.reportsModeAttackBtn) selectors.reportsModeAttackBtn.classList.toggle('has-new-report', unseen('attack'));
  if (selectors.reportsModeDefenseBtn) selectors.reportsModeDefenseBtn.classList.toggle('has-new-report', unseen('defense'));
}

function markModeSeen(mode, byMode) {
  (byMode[mode] || []).forEach((r) => seenReportIds.add(reportKey(r)));
}

function checkForNewReports() {
  if (!selectors.showReportsBtn) return;
  const byMode = visibleReportsByMode();
  const all = byMode.attack.concat(byMode.defense);
  if (!reportsBaselineInitialized) {
    reportsBaselineInitialized = true;
    all.forEach((r) => { seenReportIds.add(reportKey(r)); notifiedReportIds.add(reportKey(r)); });
    updateReportModeBadges(byMode);
    return;
  }
  const modalOpen = selectors.reportsModal && selectors.reportsModal.classList.contains('active');
  if (modalOpen) {
    markModeSeen(state.reportsMode, byMode);
    all.forEach((r) => notifiedReportIds.add(reportKey(r)));
  } else if (all.some((r) => !notifiedReportIds.has(reportKey(r)))) {
    selectors.showReportsBtn.classList.add('has-new-report');
  }
  updateReportModeBadges(byMode);
}

function markReportsAsSeen() {
  if (!selectors.showReportsBtn) return;
  selectors.showReportsBtn.classList.remove('has-new-report');
  const byMode = visibleReportsByMode();
  byMode.attack.concat(byMode.defense).forEach((r) => notifiedReportIds.add(reportKey(r)));
  // Open on the tab that has something new (attack first), so the new report is shown straight away.
  const unseenIn = (mode) => byMode[mode].some((r) => !seenReportIds.has(reportKey(r)));
  if (!unseenIn(state.reportsMode)) {
    if (unseenIn('attack')) state.reportsMode = 'attack';
    else if (unseenIn('defense')) state.reportsMode = 'defense';
  }
  if (selectors.reportsModeAttackBtn) selectors.reportsModeAttackBtn.classList.toggle('active', state.reportsMode === 'attack');
  if (selectors.reportsModeDefenseBtn) selectors.reportsModeDefenseBtn.classList.toggle('active', state.reportsMode === 'defense');
  markModeSeen(state.reportsMode, byMode);
  updateReportModeBadges(byMode);
}

// --- Commands (the only way the client ever changes shared game state) --------------------------

function queueBuilding(villageId, buildingId) {
  if (state.roundStatus === 'finished') return Promise.resolve(null);
  return emitCommand('game:queueBuilding', { villageId, buildingId });
}

function cancelBuildQueueItem(villageId, queueIndex) {
  if (state.roundStatus === 'finished') return;
  emitCommand('game:cancelBuilding', { villageId, index: queueIndex });
}

function recruitUnit(unitId) {
  if (state.roundStatus === 'finished') return;
  const input = selectors.recruitTableBody.querySelector(`input[data-unit="${unitId}"]`);
  if (!input) return;
  const count = Number(input.value);
  if (!Number.isFinite(count) || count <= 0) {
    alert(i18n.t('game.recruit.badAmount'));
    return;
  }
  const village = getCurrentPlayerVillage();
  if (!village) return;
  emitCommand('game:recruitUnit', { villageId: village.id, unitId, count });
  input.value = '';
}

function cancelRecruitQueueItem(villageId, queueIndex) {
  if (state.roundStatus === 'finished') return;
  emitCommand('game:cancelRecruit', { villageId, index: queueIndex });
}

function cancelOutgoingAttack(attackId) {
  if (!attackId || state.roundStatus === 'finished') return;
  emitCommand('game:cancelAttack', { attackId });
}

// --- Event wiring ---------------------------------------------------------------------------

let eventsAttached = false;
function attachEventHandlersOnce() {
  if (eventsAttached) return;
  eventsAttached = true;
  attachEventHandlers();
}

function attachEventHandlers() {
  const btnUpgrade = document.getElementById('btnUpgrade');
  const btnMap = document.getElementById('btnMap');
  const btnVillages = document.getElementById('btnVillages');

  if (selectors.villagePrevBtn) selectors.villagePrevBtn.addEventListener('click', () => cycleVillage(-1));
  if (selectors.villageNextBtn) selectors.villageNextBtn.addEventListener('click', () => cycleVillage(1));
  if (selectors.upgradeModalVillagePrevBtn) selectors.upgradeModalVillagePrevBtn.addEventListener('click', () => cycleVillage(-1));
  if (selectors.upgradeModalVillageNextBtn) selectors.upgradeModalVillageNextBtn.addEventListener('click', () => cycleVillage(1));
  if (selectors.villageRenameBtn) selectors.villageRenameBtn.addEventListener('click', submitVillageRename);
  if (selectors.villageRenameInput) {
    selectors.villageRenameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitVillageRename();
    });
  }

  // 2026-10-02, explicit request: removed the "Wersja przeglądarkowa/mobilna" forced-desktop-view
  // toggle entirely - the page now always renders the desktop layout (scaled to fit, see
  // #layoutGridScaleWrapper in game.html), so there is no separate mobile mode left to toggle.

  if (btnUpgrade) {
    btnUpgrade.addEventListener('click', () => {
      setActiveMenu('btnUpgrade');
      openUpgradeModal();
      renderUpgradeTable();
    });
  }
  if (btnMap) {
    btnMap.addEventListener('click', () => {
      setActiveMenu('btnMap');
    });
  }
  if (btnVillages) {
    btnVillages.addEventListener('click', () => {
      setActiveMenu('btnVillages');
      if (selectors.villageListModal) {
        selectors.villageListModal.classList.add('active');
        renderVillageListModal();
      }
    });
  }
  // Closes on ANY click outside the panel, not just clicks inside #mapCanvas - a tap landing on the
  // sidebar/menu/topBar (very reachable on a single-column mobile layout) used to leave the panel
  // stuck open since #mapCanvas never saw that click. The node click handler and the panel's own
  // click handler both call stopPropagation(), so this never fires for the click that opens it.
  document.addEventListener('click', (event) => {
    hideMapTooltip();
    if (!selectors.mapActionPanel || selectors.mapActionPanel.style.display === 'none') return;
    if (!selectors.mapActionPanel.contains(event.target)) hideMapActionPanel();
  });
  if (selectors.mapActionPanel) {
    selectors.mapActionPanel.addEventListener('click', (event) => event.stopPropagation());
  }
  selectors.upgradeModal.addEventListener('click', (event) => {
    if (event.target === selectors.upgradeModal || event.target.id === 'closeUpgradeModal') closeUpgradeModal();
  });
  selectors.upgradeModal.querySelector('#closeUpgradeModal').addEventListener('click', closeUpgradeModal);
  selectors.recruitTableBody.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-unit]');
    if (button) {
      recruitUnit(button.dataset.unit);
      return;
    }
    // Clicking the "(max affordable)" hint fills the quantity input with that exact number instead
    // of making the player type/copy it themselves.
    const maxHint = event.target.closest('[data-max-for]');
    if (maxHint) {
      const input = selectors.recruitTableBody.querySelector(`input[data-unit="${maxHint.dataset.maxFor}"]`);
      if (input) {
        input.value = maxHint.dataset.maxValue || '0';
        input.focus();
        updateRecruitButtonState(maxHint.dataset.maxFor);
      }
    }
  });
  selectors.recruitTableBody.addEventListener('input', (event) => {
    const input = event.target.closest('input[data-unit]');
    if (!input) return;
    updateRecruitButtonState(input.dataset.unit);
  });
  selectors.upgradeTableBody.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-village][data-building]');
    if (!button || button.disabled) return;
    // Immediate feedback: disable the button THE INSTANT it's clicked, rather than waiting for the
    // next game:state push to confirm the change (that round trip is what made the button feel
    // unresponsive/"laggy" - see queueBuilding's own gameEngine.js-side fix for what an impatient
    // double-click could do in that window on a building one level from max). The next real
    // re-render (once the server confirms the queue changed) fully re-decides the correct
    // enabled/disabled state either way, so this is purely a responsiveness improvement, not a
    // substitute for server-side validation.
    button.disabled = true;
    queueBuilding(button.dataset.village, button.dataset.building).then((ack) => {
      // If the command was REJECTED, nothing about the game state actually changed, so the next
      // renderUpgradeTable() call would be skipped by renderIfChanged (identical signature to
      // before) and this button would stay stuck disabled forever with no real re-render ever
      // coming to fix it - re-enable it directly so a rejected click doesn't lock out the very
      // next attempt.
      if (ack && ack.error) button.disabled = false;
    });
  });
  if (selectors.buildQueueList) {
    selectors.buildQueueList.addEventListener('click', (event) => {
      const button = event.target.closest('button.queue-cancel');
      if (!button) return;
      cancelBuildQueueItem(button.dataset.village, Number(button.dataset.index));
    });
  }
  if (selectors.recruitmentQueueList) {
    selectors.recruitmentQueueList.addEventListener('click', (event) => {
      const button = event.target.closest('button.queue-cancel');
      if (!button) return;
      cancelRecruitQueueItem(button.dataset.village, Number(button.dataset.index));
    });
  }
  if (selectors.activeAttacksList) {
    selectors.activeAttacksList.addEventListener('click', (event) => {
      const button = event.target.closest('button.active-attack-cancel');
      if (!button) return;
      cancelOutgoingAttack(button.dataset.attackId);
    });
  }
  if (selectors.showRecruitQueueBtn) {
    selectors.showRecruitQueueBtn.addEventListener('click', () => {
      selectors.recruitQueueModal.classList.add('active');
      renderRecruitmentQueue();
    });
  }
  if (selectors.lordRecruitItem) {
    selectors.lordRecruitItem.addEventListener('click', (event) => {
      const button = event.target.closest('button.lord-recruit-cancel');
      if (!button) return;
      cancelLordRecruit(button.dataset.village);
    });
  }
  if (selectors.reinforcementsList) {
    selectors.reinforcementsList.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-reinforcement-id]');
      if (!button) return;
      const village = getCurrentPlayerVillage();
      if (!village) return;
      emitCommand('game:recallSupport', { villageId: village.id, reinforcementId: button.dataset.reinforcementId });
    });
  }
  if (selectors.showReportsBtn) {
    selectors.showReportsBtn.addEventListener('click', () => {
      markReportsAsSeen();
      if (selectors.reportsModal) {
        // Size the reports window to match the map's ACTUAL rendered box, not just its own aspect
        // ratio/cap - the map's own size varies with viewport width (it's a flex item inside the
        // sidebar layout grid, not centered on the full page like a modal), so only measuring it
        // live gets an exact match rather than an approximation.
        // On mobile the map is deliberately short (its own locked aspect ratio at a narrow width),
        // so mirroring its height here left too little room for reports - only ~1 fit on screen.
        // Below 700px, skip the copy and let #reportsModal .modal-content's own CSS height
        // (min(650px, calc(100vh - 60px)) - most of the viewport) take over instead.
        const modalContent = selectors.reportsModal.querySelector('.modal-content');
        if (modalContent && selectors.imageCard) {
          if (window.innerWidth > 700) {
            const mapRect = selectors.imageCard.getBoundingClientRect();
            modalContent.style.width = `${Math.round(mapRect.width)}px`;
            modalContent.style.height = `${Math.round(mapRect.height)}px`;
          } else {
            modalContent.style.width = '';
            modalContent.style.height = '';
          }
        }
        selectors.reportsModal.classList.add('active');
        renderReports();
      }
    });
  }
  if (selectors.closeReportsModal) {
    selectors.closeReportsModal.addEventListener('click', () => {
      if (selectors.reportsModal) selectors.reportsModal.classList.remove('active');
    });
  }
  if (selectors.reportsModeAttackBtn) selectors.reportsModeAttackBtn.addEventListener('click', () => setReportsMode('attack'));
  if (selectors.reportsModeDefenseBtn) selectors.reportsModeDefenseBtn.addEventListener('click', () => setReportsMode('defense'));
  if (selectors.reportsModal) {
    selectors.reportsModal.addEventListener('click', (event) => {
      if (event.target === selectors.reportsModal) selectors.reportsModal.classList.remove('active');
    });
  }
  if (selectors.closeRecruitQueueModal) {
    selectors.closeRecruitQueueModal.addEventListener('click', () => selectors.recruitQueueModal.classList.remove('active'));
  }
  if (selectors.recruitQueueModal) {
    selectors.recruitQueueModal.addEventListener('click', (event) => {
      if (event.target === selectors.recruitQueueModal) selectors.recruitQueueModal.classList.remove('active');
    });
  }
  if (selectors.villageListModal) {
    selectors.villageListModal.addEventListener('click', (event) => {
      if (event.target === selectors.villageListModal) selectors.villageListModal.classList.remove('active');
    });
  }
  if (selectors.closeVillageListModal) {
    selectors.closeVillageListModal.addEventListener('click', () => selectors.villageListModal.classList.remove('active'));
  }
  if (selectors.rankingModeToggle) selectors.rankingModeToggle.addEventListener('click', toggleRankingMode);
  // Team mode only (classic mode's ranking rows have no .ranking-team-row class, so this simply
  // never matches there): click a team row to expand/collapse its per-player breakdown.
  if (selectors.rankingList) {
    selectors.rankingList.addEventListener('click', (event) => {
      const row = event.target.closest('.ranking-team-row');
      if (!row) return;
      const teamId = Number(row.dataset.teamId);
      state.expandedTeamId = state.expandedTeamId === teamId ? null : teamId;
      updateRanking();
    });
  }
  const closeRoundResultsButton = document.getElementById('closeRoundResultModal');
  if (closeRoundResultsButton) closeRoundResultsButton.addEventListener('click', closeRoundResults);
  if (selectors.roundResultModal) {
    selectors.roundResultModal.addEventListener('click', (event) => {
      if (event.target === selectors.roundResultModal) closeRoundResults();
    });
  }

  if (selectors.teamChatForm) {
    selectors.teamChatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = selectors.teamChatInput;
      const text = (input?.value || '').trim();
      if (!text) return;
      socket.emit('game:teamChatMessage', text);
      if (input) input.value = '';
    });
  }
  if (selectors.teamChatMinimizeBtn && selectors.teamChatWindow) {
    selectors.teamChatMinimizeBtn.addEventListener('click', () => {
      selectors.teamChatWindow.classList.toggle('minimized');
    });
  }
  initTeamChatDrag();
}

// Lets the player drag the team chat window by its header and drop it anywhere on screen; the
// chosen position is remembered in localStorage so it stays put across reloads/reconnects. Plain
// mouse events (no library) - this UI is desktop-sidebar-only already (see the rest of game.html),
// so touch support isn't needed here either.
function initTeamChatDrag() {
  const win = selectors.teamChatWindow;
  const handle = selectors.teamChatHeader;
  if (!win || !handle) return;

  const saved = JSON.parse(localStorage.getItem('teamChatPosition') || 'null');
  if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
    win.style.left = `${saved.left}px`;
    win.style.top = `${saved.top}px`;
    win.style.right = 'auto';
    win.style.bottom = 'auto';
  }

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  handle.addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) return; // don't start a drag from the minimize button
    dragging = true;
    const rect = win.getBoundingClientRect();
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const maxLeft = Math.max(0, window.innerWidth - win.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - win.offsetHeight);
    const left = Math.min(Math.max(0, event.clientX - offsetX), maxLeft);
    const top = Math.min(Math.max(0, event.clientY - offsetY), maxTop);
    win.style.left = `${left}px`;
    win.style.top = `${top}px`;
    win.style.right = 'auto';
    win.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    const rect = win.getBoundingClientRect();
    localStorage.setItem('teamChatPosition', JSON.stringify({ left: rect.left, top: rect.top }));
  });
}

function setActiveMenu(activeId) {
  document.querySelectorAll('.button-list button').forEach((button) => {
    button.classList.toggle('active', button.id === activeId);
  });
}

// --- Round timer (unrelated to the village session — kept as a lightweight REST poll) -----------

async function syncRoundState() {
  const roundId = getCurrentRoundIdFromUrl();
  try {
    const response = await fetch(roundId ? `/api/game/state?roundId=${encodeURIComponent(roundId)}` : '/api/game/state', {
      headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }
    });
    if (!response.ok) return;
    const data = await response.json();
    const roundState = data?.state || null;
    if (roundState && Number.isFinite(Number(roundState.remainingSeconds))) {
      state.roundRemainingSeconds = Number(roundState.remainingSeconds);
    } else if (roundState?.endsAt) {
      state.roundRemainingSeconds = Math.max(0, Math.floor((new Date(roundState.endsAt).getTime() - Date.now()) / 1000));
    }
    updateGameClocks();
  } catch (error) {
    console.error('Błąd synchronizacji czasu rundy:', error);
  }
}

function initialize() {
  const roundId = getCurrentRoundIdFromUrl();
  if (!roundId) {
    alert(i18n.t('game.noRoundId'));
    window.location.href = '/index.html';
    return;
  }
  updateGameClocks();
  void syncRoundState();
  setInterval(() => {
    updateGameClocks();
    void syncRoundState();
  }, 1000);
}

window.addEventListener('DOMContentLoaded', initialize);
