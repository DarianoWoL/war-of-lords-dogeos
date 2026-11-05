// Shared, authoritative game-logic module. Loaded by the SERVER (via require()) to run the one
// real simulation for a room, and by the CLIENT (via <script src="./gameEngine.js">) purely to
// reuse the same constants/formulas for read-only previews (e.g. "next level costs X gold").
// The client must never call the mutator functions below directly — only the server does, inside
// src/gameSession.js. This file has ZERO knowledge of DOM, sockets, or HTTP; it only touches the
// `state` object explicitly passed into every function.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GameEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STARTING_GOLD = 1845;

  const UNIT_DEFS = [
    { id: 'archer', label: 'Włócznik', cost: 20, recruitTime: 4, attackValue: 15, defenseAgainstInfantry: 35.7, defenseAgainstCavalry: 51.0 },
    { id: 'shield', label: 'Tarczownik', cost: 18, recruitTime: 5, attackValue: 10, defenseAgainstInfantry: 66.3, defenseAgainstCavalry: 25.5 },
    { id: 'axe', label: 'Topornik', cost: 24, recruitTime: 8, attackValue: 55, defenseAgainstInfantry: 15.3, defenseAgainstCavalry: 5.1 },
    // Scout defends ONLY against enemy recon (raw garrison.scout count vs incoming scout count, see
    // the direction === 'recon' branch in processActiveAttacks) - it contributes no defensive power
    // against a real attack (archers/cavalry/etc.), hence 0/0 here rather than a positive value.
    { id: 'scout', label: 'Zwiadowca', cost: 32, recruitTime: 5, attackValue: 0, defenseAgainstInfantry: 0, defenseAgainstCavalry: 0 },
    { id: 'cavalry', label: 'Jazda', cost: 48, recruitTime: 12, attackValue: 180, defenseAgainstInfantry: 61.2, defenseAgainstCavalry: 40.8 },
    { id: 'ram', label: 'Taran', cost: 80, recruitTime: 15, attackValue: 40, defenseAgainstInfantry: 30.6, defenseAgainstCavalry: 30.6 },
    { id: 'lord', label: 'Lord', cost: 1500, recruitTime: 300, attackValue: 0, defenseAgainstInfantry: 0, defenseAgainstCavalry: 0 }
  ];

  // User-specified 10-color set (2026-07-20): ciemnoniebieski, ciemnozielony, pomarańczowy,
  // fioletowy, czerwony, żółty, czarny, brązowy, jasnoniebieski, jasnozielony — order matches
  // teamId/slot 1-10. "czarny" is rendered as a dark neutral grey (#71717a) rather than literal
  // #000000: this color is also used directly as CSS `color:` for team-name text (see
  // updateTeamRanking in game.js) against this UI's dark navy backgrounds, where true black text
  // would be unreadable — same alpha-blended-border treatment as every other color otherwise. Must
  // stay in sync with the two identical copies in poczekalnia.html (colorPalette/TEAM_COLOR_PALETTE).
  const PLAYER_COLORS = ['#1e3a8a', '#14532d', '#f97316', '#8b5cf6', '#dc2626', '#eab308', '#71717a', '#92400e', '#38bdf8', '#4ade80'];

  const buildingConfig = {
    townHall: { baseCost: 125, costGrowth: 1.28, baseTime: 55, timeGrowth: 1.23 },
    barracks: { baseCost: 200, costGrowth: 1.18, baseTime: 48, timeGrowth: 1.18 },
    castle: { baseCost: 500, costGrowth: 1.42, baseTime: 200, timeGrowth: 1.35 },
    goldMine: { baseCost: 95, costGrowth: 1.32, baseTime: 52, timeGrowth: 1.28 },
    tavern: { baseCost: 180, costGrowth: 1.40, baseTime: 58, timeGrowth: 1.22 },
    wall: { baseCost: 320, costGrowth: 1.35, baseTime: 65, timeGrowth: 1.29 },
    garrison: { baseCost: 0, costGrowth: 1, baseTime: 0, timeGrowth: 1 }
  };

  const buildingPoints = {
    townHall: [80, 95, 110, 125, 145, 170, 195, 220, 245, 315],
    barracks: [45, 55, 65, 75, 85, 95, 105, 115, 125, 235],
    castle: [250, 275, 300, 325, 350],
    goldMine: [40, 45, 50, 55, 60, 65, 70, 75, 80, 360],
    tavern: [30, 35, 40, 45, 50, 55, 60, 65, 70, 350],
    wall: [20, 25, 30, 35, 40, 45, 50, 55, 60, 290],
    garrison: [3]
  };

  const unitPopulationCost = { archer: 1, shield: 1, axe: 1, scout: 2, cavalry: 3, ram: 4, lord: 100 };

  const attackTravelTimes = { archer: 75, shield: 106, axe: 106, scout: 55, cavalry: 65, ram: 205, lord: 330 };

  // Level 1 = 5, level 10 = 35 (user-specified caps), levels 2-9 linearly interpolated between them.
  const goldMineProductionRates = [0, 5, 8, 12, 15, 18, 22, 25, 28, 32, 35];
  // 0.5 base + a further 20% reduction (x0.8) requested by the user for all room types.
  const buildTimeMultiplier = 0.4;
  const recruitTimeMultiplier = 0.8;

  // --- Monthly Tournament time scaling ---------------------------------------------------------
  // Every real room plays at these speeds unchanged (factor stays 1). Only rounds
  // src/tournamentEngine.js creates carry a non-1 `state.timeScaleFactor` (roundDurationMinutes /
  // 120 — 120 minutes is the baseline every existing duration/rate constant in this file is tuned
  // for), so a 60-minute Monthly Tournament round runs at 0.5x durations / 2x rates: buildings,
  // recruiting, Lord training and army travel all take half as long, gold/resources accumulate
  // twice as fast, and bots build/recruit/attack on a proportionally compressed schedule — the
  // whole game's pace scales together instead of, say, combat staying full-speed while the economy
  // stays slow.
  //
  // Implemented as a module-scope "current factor" (set by setActiveTimeScaleFactor(state) at the
  // top of tick() and every player-command entry point below that queues something with a
  // duration) rather than threading a new parameter through every helper function, mirroring how
  // buildTimeMultiplier/recruitTimeMultiplier above are already read directly instead of passed
  // around. Safe because everything in this file is synchronous — there is no `await` anywhere
  // between a setter call and the calculations that read it, so two different rounds' ticks can
  // never interleave and see each other's factor.
  let activeTimeScaleFactor = 1;
  function setActiveTimeScaleFactor(state) {
    const factor = Number(state?.timeScaleFactor);
    activeTimeScaleFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  }
  // Rates (gold/resource production, anything "per second") move the OPPOSITE way from durations —
  // a shorter round means things finish faster (smaller duration factor) but resources should pile
  // up faster too (bigger rate factor), so this is always exactly the reciprocal.
  function activeRateScaleFactor() {
    return 1 / activeTimeScaleFactor;
  }

  const auxiliaryVillageCost = 4000;
  const villageDefaultLoyalty = 100;
  const lordLoyaltyDamage = 50;
  const ATTACK_GRACE_MS = 5000;

  const tavernPopulationByLevel = (function () {
    const levels = [];
    levels[1] = 50;
    const level9 = 3500;
    const level10 = 4500;
    for (let lvl = 2; lvl <= 8; lvl += 1) {
      const t = (lvl - 1) / (9 - 1);
      levels[lvl] = Math.round(levels[1] + (level9 - levels[1]) * t);
    }
    levels[9] = level9;
    levels[10] = level10;
    for (let i = 2; i <= 10; i += 1) {
      if (!levels[i] || levels[i] <= levels[i - 1]) levels[i] = levels[i - 1] + 1;
    }
    return levels;
  })();

  const botAiProfiles = {
    economic: {
      label: 'Ekonomiczny',
      buildPriority: ['goldMine', 'tavern', 'townHall', 'wall', 'barracks', 'castle'],
      recruitUnitWeights: { archer: 3, shield: 3, axe: 1, scout: 1, cavalry: 1, ram: 1 },
      attackIntervalMs: [100000, 200000],
      attackForceShare: 0.3,
      lordChance: 0.02
    },
    aggressive: {
      label: 'Agresywny',
      buildPriority: ['barracks', 'castle', 'townHall', 'goldMine', 'wall', 'tavern'],
      recruitUnitWeights: { axe: 4, cavalry: 3, archer: 1, shield: 1, ram: 2, scout: 1 },
      attackIntervalMs: [30000, 75000],
      attackForceShare: 0.6,
      lordChance: 0.12
    },
    balanced: {
      label: 'Zbalansowany',
      buildPriority: ['townHall', 'goldMine', 'barracks', 'tavern', 'wall', 'castle'],
      recruitUnitWeights: { archer: 2, shield: 2, axe: 2, cavalry: 2, ram: 1, scout: 1 },
      attackIntervalMs: [60000, 130000],
      attackForceShare: 0.45,
      lordChance: 0.06
    },
    defensive: {
      label: 'Defensywny',
      buildPriority: ['wall', 'townHall', 'goldMine', 'tavern', 'barracks', 'castle'],
      recruitUnitWeights: { shield: 4, archer: 3, axe: 1, cavalry: 1, ram: 1, scout: 1 },
      attackIntervalMs: [130000, 260000],
      attackForceShare: 0.25,
      lordChance: 0.03
    }
  };
  const botAiProfileKeys = Object.keys(botAiProfiles);

  function colorForSlot(index) {
    return PLAYER_COLORS[index % PLAYER_COLORS.length];
  }

  // --- Villages / map --------------------------------------------------------

  function defaultVillageGarrison() {
    return UNIT_DEFS.reduce((acc, unit) => { acc[unit.id] = 0; return acc; }, {});
  }

  function defaultVillageBuildings() {
    const byId = (id, label, max, base, level) => ({ id, label, level, maxLevel: max, baseCost: base });
    return [
      byId('townHall', 'Ratusz', 10, 240, 1),
      byId('barracks', 'Koszary', 10, 180, 1),
      byId('garrison', 'Garnizon', 1, 0, 1),
      byId('castle', 'Zamek', 5, 400, 0),
      byId('goldMine', 'Kopalnia złota', 10, 150, 1),
      byId('tavern', 'Gospoda', 10, 120, 1),
      byId('wall', 'Mur obronny', 10, 140, 1)
    ];
  }

  function createDefaultVillages() {
    const villages = {};
    for (let i = 1; i <= 10; i += 1) {
      const id = `W${i}`;
      villages[id] = {
        id, label: `Wioska ${i}`, type: 'main', parent: null, owner: null, color: null,
        loyalty: villageDefaultLoyalty, garrison: defaultVillageGarrison(), reinforcements: [],
        buildings: defaultVillageBuildings(), buildQueue: [], recruitQueue: []
      };
      villages[`A${i}`] = {
        id: `A${i}`, label: `A${i}`, type: 'sub', parent: id, owner: null, color: null,
        loyalty: villageDefaultLoyalty, garrison: defaultVillageGarrison(), reinforcements: [],
        buildings: defaultVillageBuildings(), buildQueue: [], recruitQueue: []
      };
      villages[`B${i}`] = {
        id: `B${i}`, label: `B${i}`, type: 'sub', parent: id, owner: null, color: null,
        loyalty: villageDefaultLoyalty, garrison: defaultVillageGarrison(), reinforcements: [],
        buildings: defaultVillageBuildings(), buildQueue: [], recruitQueue: []
      };
    }
    return villages;
  }

  function createDefaultMapNodes() {
    return [
      { id: 'W1', label: '1', type: 'main', x: 25.609756097560975, y: 19.444444444444446, parent: null },
      { id: 'A1', label: 'A1', type: 'sub', x: 19.235033259423503, y: 23.456790123456788, parent: 'W1' },
      { id: 'B1', label: 'B1', type: 'sub', x: 31.762749445676274, y: 23.765432098765434, parent: 'W1' },
      { id: 'W2', label: '2', type: 'main', x: 50.49889135254989, y: 18.67283950617284, parent: null },
      { id: 'A2', label: 'A2', type: 'sub', x: 44.40133037694014, y: 22.685185185185187, parent: 'W2' },
      { id: 'B2', label: 'B2', type: 'sub', x: 56.04212860310421, y: 22.839506172839506, parent: 'W2' },
      { id: 'W3', label: '3', type: 'main', x: 73.89135254988913, y: 19.598765432098766, parent: null },
      { id: 'A3', label: 'A3', type: 'sub', x: 68.34811529933481, y: 23.30246913580247, parent: 'W3' },
      { id: 'B3', label: 'B3', type: 'sub', x: 79.65631929046563, y: 23.30246913580247, parent: 'W3' },
      { id: 'W4', label: '4', type: 'main', x: 15.465631929046564, y: 47.0679012345679, parent: null },
      { id: 'A4', label: 'A4', type: 'sub', x: 9.146341463414634, y: 51.23456790123457, parent: 'W4' },
      { id: 'B4', label: 'B4', type: 'sub', x: 21.784922394678492, y: 51.388888888888886, parent: 'W4' },
      { id: 'W5', label: '5', type: 'main', x: 37.86031042128603, y: 47.53086419753087, parent: null },
      { id: 'A5', label: 'A5', type: 'sub', x: 31.87361419068736, y: 50.92592592592593, parent: 'W5' },
      { id: 'B5', label: 'B5', type: 'sub', x: 43.62527716186253, y: 51.54320987654321, parent: 'W5' },
      { id: 'W6', label: '6', type: 'main', x: 59.92239467849224, y: 47.0679012345679, parent: null },
      { id: 'A6', label: 'A6', type: 'sub', x: 54.268292682926834, y: 51.080246913580254, parent: 'W6' },
      { id: 'B6', label: 'B6', type: 'sub', x: 65.68736141906874, y: 51.23456790123457, parent: 'W6' },
      { id: 'W7', label: '7', type: 'main', x: 83.86917960088692, y: 47.376543209876544, parent: null },
      { id: 'A7', label: 'A7', type: 'sub', x: 77.54988913525499, y: 51.23456790123457, parent: 'W7' },
      { id: 'B7', label: 'B7', type: 'sub', x: 90.29933481152993, y: 50.92592592592593, parent: 'W7' },
      { id: 'W8', label: '8', type: 'main', x: 23.226164079822617, y: 76.08024691358025, parent: null },
      { id: 'A8', label: 'A8', type: 'sub', x: 17.017738359201772, y: 79.78395061728395, parent: 'W8' },
      { id: 'B8', label: 'B8', type: 'sub', x: 29.656319290465632, y: 79.62962962962963, parent: 'W8' },
      { id: 'W9', label: '9', type: 'main', x: 47.50554323725055, y: 76.08024691358025, parent: null },
      { id: 'A9', label: 'A9', type: 'sub', x: 41.4079822616408, y: 79.93827160493827, parent: 'W9' },
      { id: 'B9', label: 'B9', type: 'sub', x: 53.60310421286031, y: 80.40123456790124, parent: 'W9' },
      { id: 'W10', label: '10', type: 'main', x: 71.67405764966742, y: 76.23456790123457, parent: null },
      { id: 'A10', label: 'A10', type: 'sub', x: 65.57649667405765, y: 79.93827160493827, parent: 'W10' },
      { id: 'B10', label: 'B10', type: 'sub', x: 77.77161862527716, y: 80.40123456790124, parent: 'W10' }
    ];
  }

  // --- Team mode map (roomType 'team') ---------------------------------------
  // A completely separate map generator from createDefaultVillages/createDefaultMapNodes above,
  // which stay untouched and keep serving 'standard'/'percentage' rooms exactly as before. Team
  // mode has 50 main villages, NO sub/auxiliary villages, grouped into 10 fixed regions of 5
  // adjacent villages each (TEAM_REGIONS) so a team's members can be placed next to each other on
  // the map (see assignVillagesToPlayersTeamMode). Travel time depends only on unit composition
  // (getAttackTravelTimeMs), never on map distance, so the exact layout is purely visual, not a
  // balance concern — BUT the coordinates below are NOT arbitrary: they're measured pixel positions
  // (converted to % of the 1448x1086 source image) of the actual castle icons already painted onto
  // "mapa druzyna.png" (see .map-team in game.html), so each clickable node lands exactly on top of
  // its hand-drawn castle. The 50 castles were grouped into 10 regions of 5 by nearest-neighbor
  // spatial clustering (capacity-constrained k-means), not by numbering order in the image.
  const TEAM_REGION_COUNT = 10;
  const TEAM_REGION_SIZE = 5;
  const TEAM_VILLAGE_COUNT = TEAM_REGION_COUNT * TEAM_REGION_SIZE;

  const teamMapLayout = (function buildTeamMapLayout() {
    // [villageNumber, regionId, xPercent, yPercent] — xPercent/yPercent measured directly off the
    // castle icons in public/mapa druzyna.png (1448x1086px source).
    const raw = [
      [1, 1, 11.26, 16.39], [2, 1, 3.80, 34.25], [3, 1, 13.47, 48.53], [4, 1, 20.37, 60.50], [5, 1, 4.14, 60.96],
      [6, 2, 20.03, 19.80], [7, 2, 35.36, 23.94], [8, 2, 27.42, 33.79], [9, 2, 20.03, 34.25], [10, 2, 35.70, 40.24],
      [11, 3, 51.04, 2.76], [12, 3, 38.12, 6.91], [13, 3, 26.73, 14.27], [14, 3, 47.10, 15.19], [15, 3, 47.10, 26.70],
      [16, 4, 75.69, 11.97], [17, 4, 58.29, 14.27], [18, 4, 64.85, 24.40], [19, 4, 73.83, 28.08], [20, 4, 63.47, 38.86],
      [21, 5, 87.78, 8.29], [22, 5, 83.29, 20.26], [23, 5, 95.03, 24.40], [24, 5, 94.68, 35.17], [25, 5, 77.76, 37.02],
      [26, 6, 72.79, 49.45], [27, 6, 87.78, 49.45], [28, 6, 81.22, 61.42], [29, 6, 63.47, 62.80], [30, 6, 89.85, 70.35],
      [31, 7, 70.03, 71.73], [32, 7, 76.04, 78.64], [33, 7, 63.81, 82.78], [34, 7, 88.12, 89.23], [35, 7, 72.10, 92.45],
      [36, 8, 33.98, 70.81], [37, 8, 45.72, 74.95], [38, 8, 38.81, 91.07], [39, 8, 51.38, 91.99], [40, 8, 27.07, 95.21],
      [41, 9, 52.07, 35.64], [42, 9, 48.14, 47.61], [43, 9, 53.80, 50.83], [44, 9, 38.81, 57.27], [45, 9, 49.17, 61.88],
      [46, 10, 22.79, 69.43], [47, 10, 4.83, 70.81], [48, 10, 11.40, 80.02], [49, 10, 20.03, 86.00], [50, 10, 4.49, 89.23]
    ];
    const nodes = [];
    const regions = {};
    raw.forEach(([villageNumber, regionId, x, y]) => {
      const villageId = `W${villageNumber}`;
      nodes.push({ id: villageId, label: String(villageNumber), type: 'main', x, y, parent: null, regionId });
      (regions[regionId] = regions[regionId] || []).push(villageId);
    });
    return { nodes, regions };
  })();

  const TEAM_REGIONS = teamMapLayout.regions;

  function createTeamVillages() {
    const villages = {};
    for (let i = 1; i <= TEAM_VILLAGE_COUNT; i += 1) {
      const id = `W${i}`;
      villages[id] = {
        id, label: `Wioska ${i}`, type: 'main', parent: null, owner: null, color: null,
        loyalty: villageDefaultLoyalty, garrison: defaultVillageGarrison(), reinforcements: [],
        buildings: defaultVillageBuildings(), buildQueue: [], recruitQueue: []
      };
    }
    return villages;
  }

  function createTeamMapNodes() {
    return teamMapLayout.nodes.map((node) => ({ ...node }));
  }

  function colorForTeam(teamId) {
    if (!Number.isFinite(Number(teamId))) return null;
    return PLAYER_COLORS[(Number(teamId) - 1) % PLAYER_COLORS.length];
  }

  function isSameTeam(state, player, otherOwnerName) {
    if (!player || player.teamId == null || !otherOwnerName) return false;
    const otherPlayer = state.players.find((p) => p.name === otherOwnerName);
    return !!otherPlayer && otherPlayer.teamId != null && otherPlayer.teamId === player.teamId;
  }

  // Team mode only: which team ids currently own at least one village - used by server.js to detect
  // when a match has effectively been decided (every OTHER team wiped off the map) so the round can
  // finish early instead of always running the full timer. Ownership only ever transfers between
  // players (setVillageOwner), never reverts to unowned once claimed, so in practice this can only
  // ever shrink toward exactly 1 as one team absorbs the rest - never 0.
  function getActiveTeamIds(state) {
    if (!state || state.mapType !== 'team') return [];
    const teamIdByPlayerName = new Map();
    (state.players || []).forEach((p) => {
      if (p.teamId != null) teamIdByPlayerName.set(p.name, p.teamId);
    });
    const active = new Set();
    Object.values(state.villages || {}).forEach((village) => {
      if (!village.owner) return;
      const teamId = teamIdByPlayerName.get(village.owner);
      if (teamId != null) active.add(teamId);
    });
    return [...active];
  }

  // Classic (non-team) mode counterpart to getActiveTeamIds above: how many distinct players
  // currently own at least one village - used by server.js to end an individual round early once
  // only one player (human or bot) remains standing, instead of always running the full timer out.
  // A player who loses their last village can never get a new one (buyVillage requires an already-
  // owned neighboring village to expand from), so this can only ever shrink toward exactly 1, same
  // guarantee getActiveTeamIds relies on.
  function getActivePlayerCount(state) {
    if (!state) return 0;
    const owners = new Set();
    Object.values(state.villages || {}).forEach((village) => {
      if (village.owner) owners.add(village.owner);
    });
    return owners.size;
  }

  // Team-mode counterpart to assignVillagesToPlayers below: instead of drawing from the whole map,
  // each player is only ever assigned a free village from THEIR OWN team's region (TEAM_REGIONS),
  // which is what physically guarantees teammates start next to each other. Relies on the lobby-side
  // invariant that a team never exceeds TEAM_REGION_SIZE (5) members (enforced by lobby:setTeam in
  // server.js), so the player's region always has a free slot left for them.
  function assignVillagesToPlayersTeamMode(state) {
    state.players.forEach((player) => {
      if (!player.color) player.color = colorForTeam(player.teamId);
      const ownedMainVillages = Object.values(state.villages).filter((village) => village.owner === player.name && village.type === 'main');
      if (ownedMainVillages.length > 0) {
        const stillOwnsAssignedVillage = ownedMainVillages.some((village) => village.id === player.villageId);
        player.villageId = stillOwnsAssignedVillage ? player.villageId : ownedMainVillages[0].id;
        return;
      }
      if (player.villageId) return;
      const regionVillageIds = TEAM_REGIONS[player.teamId] || [];
      const availableInRegion = villagesInFixedOrder(regionVillageIds.filter((id) => !state.villages[id]?.owner));
      const availableVillage = availableInRegion.pop();
      if (availableVillage) {
        const village = state.villages[availableVillage];
        player.villageId = availableVillage;
        if (village) {
          village.owner = player.name;
          village.color = player.color;
        }
      }
    });
  }

  function ensureVillageGarrison(village) {
    if (!village || typeof village !== 'object') return;
    const normalized = defaultVillageGarrison();
    if (village.garrison && typeof village.garrison === 'object') {
      Object.keys(village.garrison).forEach((unitId) => {
        if (Object.prototype.hasOwnProperty.call(normalized, unitId)) {
          normalized[unitId] = Number(village.garrison[unitId]) || 0;
        }
      });
    }
    village.garrison = normalized;
    // Reinforcements (troops sent here to support, from one of the SAME player's own other
    // villages) are kept separate from the native garrison on purpose: they still belong to —
    // and still occupy population capacity at — their home village, and this village's owner
    // cannot use them to attack from here. See sendSupport/recallSupport/applyDefenderLosses.
    village.reinforcements = Array.isArray(village.reinforcements)
      ? village.reinforcements
        .map((batch) => ({
          id: batch?.id,
          sourceVillageId: batch?.sourceVillageId,
          sourceLabel: batch?.sourceLabel,
          ownerName: batch?.ownerName,
          units: (batch?.units && typeof batch.units === 'object') ? { ...batch.units } : {}
        }))
        .filter((batch) => batch.sourceVillageId && Object.values(batch.units).some((count) => Number(count) > 0))
      : [];
  }

  function ensureSubVillages(villages) {
    if (!villages || typeof villages !== 'object') return;
    const mainIds = Object.keys(villages).filter((key) => /^W\d+$/.test(key));
    mainIds.forEach((mainId) => {
      const parentVillage = villages[mainId];
      if (!parentVillage) return;
      parentVillage.type = parentVillage.type || 'main';
      parentVillage.parent = null;
      parentVillage.owner = parentVillage.owner || null;
      parentVillage.color = parentVillage.color || null;
      parentVillage.loyalty = Number.isFinite(parentVillage.loyalty) ? parentVillage.loyalty : villageDefaultLoyalty;
      parentVillage.buildings = Array.isArray(parentVillage.buildings) ? parentVillage.buildings : defaultVillageBuildings();
      ensureVillageGarrison(parentVillage);
      parentVillage.buildQueue = Array.isArray(parentVillage.buildQueue) ? parentVillage.buildQueue : [];
      parentVillage.recruitQueue = Array.isArray(parentVillage.recruitQueue) ? parentVillage.recruitQueue : [];

      ['A', 'B'].forEach((prefix) => {
        const subId = `${prefix}${mainId.slice(1)}`;
        if (!villages[subId]) {
          villages[subId] = {
            id: subId, label: subId, type: 'sub', parent: mainId, owner: null, color: null,
            loyalty: villageDefaultLoyalty, garrison: defaultVillageGarrison(), reinforcements: [],
            buildings: defaultVillageBuildings(), buildQueue: [], recruitQueue: []
          };
        } else {
          const subVillage = villages[subId];
          subVillage.type = subVillage.type || 'sub';
          subVillage.parent = subVillage.parent || mainId;
          subVillage.owner = subVillage.owner || null;
          subVillage.color = subVillage.color || null;
          subVillage.loyalty = Number.isFinite(subVillage.loyalty) ? subVillage.loyalty : villageDefaultLoyalty;
          subVillage.buildings = Array.isArray(subVillage.buildings) ? subVillage.buildings : defaultVillageBuildings();
          ensureVillageGarrison(subVillage);
          subVillage.buildQueue = Array.isArray(subVillage.buildQueue) ? subVillage.buildQueue : [];
          subVillage.recruitQueue = Array.isArray(subVillage.recruitQueue) ? subVillage.recruitQueue : [];
        }
      });
    });
  }

  // Przydzial wiosek startowych bez losowania (Regulamin §1a): wolne wioski w stalej kolejnosci
  // numerow (W1, W2, ...), gracze w kolejnosci dolaczenia do pokoju. Lista jest odwrocona, bo
  // wywolujacy pobieraja kolejne wioski przez pop() - pierwszy gracz dostaje najnizszy numer.
  // Wszystkie wioski startowe maja identyczne parametry, a czas marszu nie zalezy od polozenia.
  function villagesInFixedOrder(ids) {
    const num = (id) => Number(String(id).replace(/\D/g, '')) || 0;
    return ids.slice().sort((a, b) => num(b) - num(a) || String(b).localeCompare(String(a)));
  }

  function getOwnedVillages(state, ownerName) {
    if (!ownerName) return [];
    return Object.values(state.villages).filter((village) => village.owner === ownerName);
  }

  // Runs exactly ONCE, authoritatively, on the server whenever a session is (re)initialized or a
  // player is added mid-round. This used to run independently inside every player's own browser
  // with client-side Math.random(), which is exactly what let two browsers disagree about who owns
  // an unclaimed village — the last save to reach the server won the race and silently overwrote
  // the other player's assignment. Running it once, only here, removes that race entirely.
  function assignVillagesToPlayers(state) {
    const mainVillageIds = Object.keys(state.villages).filter((id) => state.villages[id]?.type === 'main');
    const assignedVillageIds = new Set(mainVillageIds.filter((id) => state.villages[id]?.owner));
    const availableVillageIds = villagesInFixedOrder(mainVillageIds.filter((id) => !assignedVillageIds.has(id)));
    state.players.forEach((player, index) => {
      if (!player.color) player.color = colorForSlot(index);
      const ownedMainVillages = Object.values(state.villages).filter((village) => village.owner === player.name && village.type === 'main');
      if (ownedMainVillages.length > 0) {
        const stillOwnsAssignedVillage = ownedMainVillages.some((village) => village.id === player.villageId);
        player.villageId = stillOwnsAssignedVillage ? player.villageId : ownedMainVillages[0].id;
        return;
      }
      if (player.villageId) return;
      const availableVillage = availableVillageIds.pop();
      if (availableVillage) {
        const village = state.villages[availableVillage];
        assignedVillageIds.add(availableVillage);
        player.villageId = availableVillage;
        if (village) {
          village.owner = player.name;
          village.color = player.color;
        }
      }
    });
  }

  function getVillageParentId(village) {
    if (!village) return null;
    if (village.parent) return village.parent;
    if (typeof village.id !== 'string') return null;
    const match = village.id.match(/^[AB](\d+)$/);
    return match ? `W${match[1]}` : null;
  }

  function getVillageMapInfo(state, villageId) {
    const village = state.villages && state.villages[villageId];
    // village.owner is the live, authoritative field (updated by setVillageOwner on every capture);
    // player.villageId is only each player's ORIGINAL round-start home village and is never updated
    // afterward - looking that up first used to keep showing the previous owner's name forever on
    // any village that changed hands via conquest (until it became ownerless again), since whoever's
    // villageId happened to match would still "win" the lookup even after losing the village.
    let player = village?.owner ? state.players.find((p) => p.name === village.owner) : null;
    if (!player) {
      player = state.players.find((p) => p.villageId === villageId) || null;
    }
    const points = computeVillagePoints(village);
    return { village, player, points };
  }

  function canAttackVillage(village, playerName) {
    return Boolean(village && village.owner && playerName && village.owner !== playerName);
  }

  function setVillageOwner(village, ownerName, ownerColor) {
    if (!village) return;
    const previousOwner = village.owner;
    village.owner = ownerName || null;
    if (ownerColor) {
      village.color = ownerColor;
    } else if (!ownerName) {
      village.color = null;
    }
    if (previousOwner !== ownerName) {
      if (village.garrison && Number(village.garrison.lord || 0) > 0) village.garrison.lord = 0;
      village.loyalty = villageDefaultLoyalty;
    }
  }

  function getVillageLoyalty(village) {
    return Number.isFinite(village?.loyalty) ? village.loyalty : villageDefaultLoyalty;
  }

  function getVillageCastleLevel(village) {
    if (!village || !Array.isArray(village.buildings)) return 0;
    const castle = village.buildings.find((b) => b.id === 'castle');
    return Number(castle?.level) || 0;
  }

  function getVillageLordCount(village) {
    if (!village || !village.garrison) return 0;
    return Number(village.garrison.lord || 0);
  }

  function isLordAwayFromVillage(village) {
    return Number(village?.housingUnits?.lord || 0) > 0;
  }

  function canRecruitLord(village) {
    return getVillageCastleLevel(village) >= 5 && getVillageLordCount(village) < 1 && !isLordAwayFromVillage(village);
  }

  function syncUnitHousing(village, unitId, amount, mode) {
    if (!village || !unitId || !Number.isFinite(amount) || amount <= 0) return;
    village.housingUnits = village.housingUnits || {};
    village.housingUnits[unitId] = Number(village.housingUnits[unitId] || 0);
    if (mode === 'occupy') {
      village.housingUnits[unitId] += amount;
    } else if (mode === 'release') {
      village.housingUnits[unitId] = Math.max(0, village.housingUnits[unitId] - amount);
    }
  }

  function getHousingUsage(village) {
    if (!village || !village.housingUnits) return 0;
    return Object.entries(village.housingUnits).reduce((sum, [unitId, value]) => {
      return sum + Number(value || 0) * (unitPopulationCost[unitId] || 0);
    }, 0);
  }

  function getAvailableAttackUnits(village) {
    if (!village || !village.garrison) return [];
    return UNIT_DEFS
      .map((unit) => ({ ...unit, count: Number(village.garrison[unit.id] || 0) }))
      .filter((unit) => unit.count > 0);
  }

  // --- Points / kills ----------------------------------------------------------

  function computeVillagePoints(village) {
    if (!village || !Array.isArray(village.buildings)) return 0;
    return village.buildings.reduce((sum, building) => {
      const pointsForBuilding = buildingPoints[building.id] || [];
      const level = Math.max(0, Math.min(building.level || 0, pointsForBuilding.length));
      return sum + pointsForBuilding.slice(0, level).reduce((acc, value) => acc + value, 0);
    }, 0);
  }

  function computePlayerPoints(state, player) {
    if (!player) return 0;
    return getOwnedVillages(state, player.name).reduce((sum, village) => sum + computeVillagePoints(village), 0);
  }

  function creditKills(state, playerName, amount, role) {
    const count = Math.max(0, Math.round(Number(amount) || 0));
    if (!playerName || count <= 0) return;
    const player = state.players.find((p) => p.name === playerName);
    if (!player) return;
    if (role === 'attacker') {
      player.killsAsAttacker = (Number(player.killsAsAttacker) || 0) + count;
    } else if (role === 'defender') {
      player.killsAsDefender = (Number(player.killsAsDefender) || 0) + count;
    }
    player.kills = (Number(player.killsAsAttacker) || 0) + (Number(player.killsAsDefender) || 0);
  }

  // pointsAchievedAt records WHEN a player's point total last changed to its current value — it
  // only moves forward when points actually change, so two players tied on points can still be
  // ranked by who got there first (see comparePlayersByRank).
  function refreshAllPlayerPoints(state) {
    const now = Date.now();
    state.players.forEach((player) => {
      const newPoints = computePlayerPoints(state, player);
      const previousPoints = Number.isFinite(player.points) ? player.points : null;
      if (previousPoints === null || newPoints !== previousPoints) {
        player.pointsAchievedAt = now;
      }
      player.points = newPoints;
    });
  }

  // Ranking order used everywhere players are ranked by points: highest points first, and on an
  // exact tie, whoever reached that point total earlier (smaller pointsAchievedAt) ranks higher.
  function comparePlayersByRank(a, b) {
    const pointsA = Number(a?.points) || 0;
    const pointsB = Number(b?.points) || 0;
    if (pointsB !== pointsA) return pointsB - pointsA;
    const achievedA = Number.isFinite(a?.pointsAchievedAt) ? a.pointsAchievedAt : Infinity;
    const achievedB = Number.isFinite(b?.pointsAchievedAt) ? b.pointsAchievedAt : Infinity;
    return achievedA - achievedB;
  }

  // Ranking-position component of the per-round Skill Points (MMR) adjustment. Rank is 1-indexed;
  // ranks past 10 only occur in rooms bigger than the standard 10 slots.
  function skillPointsForRank(rank) {
    if (rank === 1) return 20;
    if (rank === 2) return 15;
    if (rank === 3) return 10;
    if (rank <= 7) return 0;
    if (rank === 8) return -5;
    if (rank === 9) return -10;
    if (rank === 10) return -15;
    return -20;
  }

  // Computes the end-of-round Skill Points delta for every REAL (non-bot) player, keyed by userId.
  // The aggressor bonus is scoped to real players only — a bot having the most kills never costs a
  // human player their bonus — and stacks additively with the ranking-position component (e.g. rank
  // 10 + top real aggressor = -15 + 5 = -10). Players who forfeited mid-round (`hasLeft`, set by
  // "Opuść rozgrywkę") are excluded entirely — they already took their fixed -20 penalty the moment
  // they quit (see removePlayerFromRoom in server.js) and no longer count toward anyone's ranking
  // position, including their own.
  //
  // isTeamMode (per the user's explicit spec, 2026-07-21): the RANKING-POSITION component ranks
  // whole TEAMS by their combined points (same aggregation payoutRoundRewards uses for the WoLcoin
  // split in server.js) instead of individual players, then gives EVERY real member of a team the
  // same skillPointsForRank(teamRank) delta - e.g. every player on the TOP1 team gets +20, not just
  // whoever personally scored highest. The aggressor +5 bonus deliberately stays INDIVIDUAL in both
  // modes - the user's request was scoped to "miejsce w rankingu" (ranking position) only.
  function computeSkillPointsDeltas(players, isTeamMode) {
    const deltas = new Map();
    const allPlayers = Array.isArray(players) ? players : [];
    const realPlayers = allPlayers.filter((p) => p && !p.isBot && p.userId && !p.hasLeft);
    if (!realPlayers.length) return deltas;

    if (isTeamMode) {
      // Team totals include EVERY member (bots included) - same aggregation payoutRoundRewards
      // uses for the WoLcoin split, so a team's ranking position is identical whichever reward
      // system is looking at it. Only hasLeft players are excluded from the totals (never count
      // toward anyone's ranking); bots are excluded only from RECEIVING a delta below, same as the
      // classic-mode branch already does.
      const eligibleForRanking = allPlayers.filter((p) => p && !p.hasLeft);
      const teamsById = new Map();
      eligibleForRanking.forEach((p) => {
        if (p.teamId == null) return;
        if (!teamsById.has(p.teamId)) teamsById.set(p.teamId, []);
        teamsById.get(p.teamId).push(p);
      });
      const teams = [...teamsById.entries()].map(([teamId, members]) => ({
        teamId,
        members,
        totalPoints: members.reduce((sum, p) => sum + (Number(p.points) || 0), 0),
        earliestPointsAchievedAt: members.reduce((min, p) => {
          const at = Number(p.pointsAchievedAt) || Infinity;
          return at < min ? at : min;
        }, Infinity)
      }));
      const rankedTeams = teams.sort((a, b) => (
        b.totalPoints - a.totalPoints || a.earliestPointsAchievedAt - b.earliestPointsAchievedAt
      ));
      rankedTeams.forEach((team, index) => {
        const delta = skillPointsForRank(index + 1);
        team.members.forEach((p) => {
          if (p.isBot || !p.userId) return;
          deltas.set(p.userId, delta);
        });
      });
    } else {
      const rankedRealPlayers = [...realPlayers].sort(comparePlayersByRank);
      rankedRealPlayers.forEach((player, index) => {
        deltas.set(player.userId, skillPointsForRank(index + 1));
      });
    }

    // Same "strictly by attacking" rule as the PP aggressor prize, but among real players only.
    const topRealAggressor = [...realPlayers].sort((a, b) => (Number(b.killsAsAttacker) || 0) - (Number(a.killsAsAttacker) || 0))[0];
    if (topRealAggressor && (Number(topRealAggressor.killsAsAttacker) || 0) > 0) {
      deltas.set(topRealAggressor.userId, (deltas.get(topRealAggressor.userId) || 0) + 5);
    }

    return deltas;
  }

  // --- Buildings ---------------------------------------------------------------

  function getProjectedBuildingLevel(village, buildingId) {
    if (!village || !Array.isArray(village.buildings) || !Array.isArray(village.buildQueue)) return 0;
    const building = village.buildings.find((b) => b.id === buildingId);
    let level = typeof building?.level === 'number' ? building.level : 0;
    village.buildQueue.forEach((item) => { if (item.buildingId === buildingId) level += 1; });
    return level;
  }

  function getBuildingCost(building, nextLevel) {
    if (!building || !buildingConfig[building.id]) return 0;
    const config = buildingConfig[building.id];
    if (nextLevel <= 1) return config.baseCost;
    return Math.round(config.baseCost * Math.pow(config.costGrowth, nextLevel - 1));
  }

  function getBuildingTime(building, nextLevel) {
    if (!building || !buildingConfig[building.id]) return 0;
    const config = buildingConfig[building.id];
    const baseSeconds = nextLevel <= 1 ? config.baseTime : config.baseTime * Math.pow(config.timeGrowth, nextLevel - 1);
    return Math.max(1, Math.round(baseSeconds * buildTimeMultiplier * activeTimeScaleFactor));
  }

  // 2026-10-02, player UX feedback ("nie mam pojęcia po co rozbudowuję budynki, który upgrade ile
  // mi daje") — a short, human-readable current->next description per building, reusing the exact
  // same formulas/tables the engine itself uses (goldMineProductionRates, tavernPopulationByLevel,
  // the barracks speed formula, the wall's flat +2%/level, the castle/townHall unlock thresholds)
  // so this can never drift out of sync with the real numbers. Read-only preview helper, same
  // spirit as getBuildingCost/getBuildingTime above — client calls it to label the upgrade table.
  function getBuildingEffectDescription(buildingId, currentLevel, nextLevel) {
    const curLevel = Number(currentLevel) || 0;
    const nxtLevel = Number(nextLevel) || curLevel;
    switch (buildingId) {
      case 'goldMine': {
        // 2026-10-02, player bug report: this used to show the BASE (x1-speed) table values
        // directly, while the real, displayed gold/sek in the top bar multiplies
        // getGoldProductionRate() by activeRateScaleFactor() (the room's speed setting, e.g. x2
        // speed -> rate x2) - see run_equity-ish gold/sek calc further down this file. Applying the
        // same factor here keeps this preview consistent with what the player actually earns.
        const rateScale = activeRateScaleFactor();
        const cur = (goldMineProductionRates[curLevel] || 0) * rateScale;
        const next = (goldMineProductionRates[nxtLevel] || (goldMineProductionRates[curLevel] || 0)) * rateScale;
        const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(1));
        return `wydobycie złota: +${fmt(cur)} zł/sek → +${fmt(next)} zł/sek`;
      }
      case 'tavern': {
        const cur = curLevel > 0 ? (tavernPopulationByLevel[curLevel] || 0) : 0;
        const next = tavernPopulationByLevel[nxtLevel] || cur;
        return `pojemność populacji: ${formatIntForEngine(cur)} → ${formatIntForEngine(next)}`;
      }
      case 'barracks': {
        const speedPct = (lvl) => Math.round((1 - (1 - ((Math.max(1, Math.min(lvl, 10)) - 1) / 9) * 0.5)) * 100);
        return `szybsza rekrutacja: +${speedPct(curLevel)}% → +${speedPct(nxtLevel)}%`;
      }
      case 'wall':
        return `obrona wioski: +${curLevel * 2}% → +${nxtLevel * 2}%`;
      case 'castle':
        return curLevel >= 5 ? 'odblokowany: rekrutacja Lorda' : `na poziomie 5 odblokuje rekrutację Lorda (teraz: ${curLevel}/5)`;
      case 'townHall':
        return curLevel >= 10 ? 'odblokowany: budowa Zamku' : `na poziomie 10 odblokuje budowę Zamku (teraz: ${curLevel}/10)`;
      default:
        return '';
    }
  }

  function formatIntForEngine(n) {
    return Math.round(Number(n) || 0).toLocaleString('pl-PL');
  }

  function getGoldProductionRate(village) {
    if (!village || !Array.isArray(village.buildings)) return 0;
    const mine = village.buildings.find((b) => b.id === 'goldMine');
    if (!mine || typeof mine.level !== 'number') return 0;
    return goldMineProductionRates[mine.level] || 0;
  }

  function getTavernLevel(village) {
    if (!village || !Array.isArray(village.buildings)) return 0;
    const tavern = village.buildings.find((b) => b.id === 'tavern');
    return Math.max(0, Number(tavern?.level) || 0);
  }

  function getVillagePopulationCapacity(village) {
    const level = getTavernLevel(village);
    if (level <= 0) return 0;
    return tavernPopulationByLevel[level] || 0;
  }

  function computeVillagePopulationUsed(village) {
    if (!village || !village.garrison) return 0;
    const garrisonUsage = Object.keys(village.garrison).reduce((sum, unitId) => {
      return sum + (Number(village.garrison[unitId]) || 0) * (unitPopulationCost[unitId] || 0);
    }, 0);
    return garrisonUsage + getHousingUsage(village);
  }

  function computeVillageReservedPopulation(village) {
    if (!village) return 0;
    const reserveFromQueue = (queue) => (Array.isArray(queue) ? queue : []).reduce((sum, item) => {
      const remaining = Number(item.remainingUnits) || Number(item.count) || 0;
      return sum + remaining * (unitPopulationCost[item.unitId] || 0);
    }, 0);
    // The Lord trains on its own independent lordQueue (see recruitUnit) rather than the shared
    // recruitQueue, but its population cost must still count against capacity, so both are summed.
    return reserveFromQueue(village.recruitQueue) + reserveFromQueue(village.lordQueue);
  }

  function getQueueItemDurationSeconds(item) {
    if (!item) return 1;
    const durationSeconds = Number(item.buildDurationSeconds);
    if (Number.isFinite(durationSeconds) && durationSeconds >= 1) return durationSeconds;
    return Math.max(1, Math.round(Math.max(1, item.endTime - item.startTime) / 1000));
  }

  function normalizeBuildQueueTimes(village) {
    if (!village || !Array.isArray(village.buildQueue) || !village.buildQueue.length) return;
    const now = Date.now();
    village.buildQueue.forEach((item, index) => {
      const durationMs = getQueueItemDurationSeconds(item) * 1000;
      if (index === 0) {
        // Only reset the front item's start time if it hasn't actually started building yet (it
        // was just promoted from a later slot because the previous front item finished/was
        // cancelled). An item already mid-build must keep its original startTime - otherwise
        // cancelling a LATER queue item would wrongly restart its progress from zero.
        if (!Number.isFinite(item.startTime) || item.startTime > now) {
          item.startTime = now;
        }
        item.endTime = item.startTime + durationMs;
      } else {
        item.startTime = village.buildQueue[index - 1].endTime;
        item.endTime = item.startTime + durationMs;
      }
    });
  }

  function getBarracksRecruitSpeedFactor(village) {
    if (!village || !Array.isArray(village.buildings)) return 1;
    const barracks = village.buildings.find((b) => b.id === 'barracks');
    const level = Math.max(1, Math.min(Number(barracks?.level) || 1, 10));
    return 1 - ((level - 1) / 9) * 0.5;
  }

  function getRecruitTime(unit, village) {
    if (!unit || typeof unit.recruitTime !== 'number') return 0;
    return Math.max(1, Math.round(unit.recruitTime * getBarracksRecruitSpeedFactor(village) * recruitTimeMultiplier * activeTimeScaleFactor));
  }

  function getRecruitQueueItemDurationSeconds(item) {
    if (!item) return 1;
    const durationSeconds = Number(item.unitDurationSeconds);
    if (Number.isFinite(durationSeconds) && durationSeconds >= 1) return durationSeconds;
    return Math.max(1, Math.round(Math.max(1, item.endTime - item.startTime) / 1000));
  }

  // A recruit-queue item can be a batch of several units trained one at a time - item.endTime only
  // ever covers the NEXT single unit (see processRecruitQueue), not the whole batch. Anything that
  // needs to know when a queue item's ENTIRE remaining batch finishes (e.g. to schedule the item
  // queued right after it) must use this instead of item.endTime directly.
  function getRecruitQueueItemBatchEndTime(item) {
    const duration = Math.max(1, Number(item.unitDurationSeconds) || 1);
    const remaining = Math.max(0, Number(item.remainingUnits) || 0);
    return (Number(item.startTime) || Date.now()) + remaining * duration * 1000;
  }

  function normalizeRecruitQueueTimes(village) {
    if (!village || !Array.isArray(village.recruitQueue) || !village.recruitQueue.length) return;
    const now = Date.now();
    let nextStart = now;
    village.recruitQueue.forEach((item, index) => {
      const unitDuration = Math.max(1, Number(item.unitDurationSeconds) || 1);
      if (index === 0) {
        // Only reset the front item's start time if it hasn't actually started training yet (it
        // was just promoted from a later slot). An item already mid-training must keep its
        // original startTime - otherwise cancelling a LATER queue item would wrongly restart its
        // progress from zero (same fix as normalizeBuildQueueTimes above).
        if (!Number.isFinite(item.startTime) || item.startTime > now) {
          item.startTime = now;
        }
      } else {
        item.startTime = nextStart;
      }
      item.endTime = item.startTime + unitDuration * 1000;
      nextStart = getRecruitQueueItemBatchEndTime(item);
    });
  }

  function rescaleRecruitQueueForBarracks(village) {
    if (!village || !Array.isArray(village.recruitQueue) || !village.recruitQueue.length) return;
    const now = Date.now();
    let cursor = now;
    village.recruitQueue.forEach((item, index) => {
      const unit = UNIT_DEFS.find((u) => u.id === item.unitId);
      const newUnitDuration = unit ? getRecruitTime(unit, village) : Math.max(1, Number(item.unitDurationSeconds) || 1);
      const remainingUnits = Number(item.remainingUnits) || 0;
      if (index === 0) {
        const elapsedMs = Math.max(0, now - Number(item.startTime || now));
        const remainingMs = Math.max(0, newUnitDuration * 1000 - elapsedMs);
        item.unitDurationSeconds = newUnitDuration;
        item.startTime = now - elapsedMs;
        item.endTime = now + remainingMs;
        cursor = item.endTime + Math.max(0, remainingUnits - 1) * newUnitDuration * 1000;
      } else {
        item.unitDurationSeconds = newUnitDuration;
        item.startTime = cursor;
        item.endTime = cursor + newUnitDuration * 1000;
        cursor = item.startTime + remainingUnits * newUnitDuration * 1000;
      }
    });
  }

  // The Lord's lordQueue is a separate, independent timer (see recruitUnit) so a barracks upgrade
  // must rescale it too, on top of rescaleRecruitQueueForBarracks above - otherwise a Lord already
  // mid-training would keep training at the old (slower) barracks speed forever.
  function rescaleLordQueueForBarracks(village) {
    if (!village || !Array.isArray(village.lordQueue) || !village.lordQueue.length) return;
    const now = Date.now();
    const item = village.lordQueue[0];
    const unit = UNIT_DEFS.find((u) => u.id === 'lord');
    const newUnitDuration = unit ? getRecruitTime(unit, village) : Math.max(1, Number(item.unitDurationSeconds) || 1);
    const elapsedMs = Math.max(0, now - Number(item.startTime || now));
    const remainingMs = Math.max(0, newUnitDuration * 1000 - elapsedMs);
    item.unitDurationSeconds = newUnitDuration;
    item.startTime = now - elapsedMs;
    item.endTime = now + remainingMs;
  }

  // --- Mutators (server-only; validated against the requesting player) --------

  function findPlayer(state, playerId) {
    return state.players.find((p) => p.userId === playerId) || null;
  }

  const BLOCKED_BY_ADMIN_ERROR = 'Zablokowany przez administratora — nie możesz teraz wykonywać żadnych akcji.';

  function queueBuilding(state, playerId, villageId, buildingId) {
    if (state.roundStatus === 'finished') return { ok: false, error: 'Runda zakończona.' };
    setActiveTimeScaleFactor(state);
    const player = findPlayer(state, playerId);
    if (player && player.blockedByAdmin) return { ok: false, error: BLOCKED_BY_ADMIN_ERROR };
    const village = state.villages && state.villages[villageId];
    if (!player || !village || village.owner !== player.name) return { ok: false, error: 'Brak dostępu do tej wioski.' };
    processVillageQueue(state, village);
    const building = village.buildings.find((b) => b.id === buildingId);
    if (!building) return { ok: false, error: 'Nieznany budynek.' };
    village.buildQueue = village.buildQueue || [];
    // Must check the PROJECTED level (current + whatever's already queued), not just the
    // building's already-COMPLETED level - otherwise two queueBuilding calls arriving in quick
    // succession (e.g. a fast double-click before the client has re-rendered to reflect the first
    // one) can each pass a `building.level >= maxLevel` check independently, since neither one has
    // actually finished building yet. The second one would then queue an invalid level beyond max,
    // silently wasting the player's gold once that queue item completes and
    // processVillageQueue's own `building.level < building.maxLevel` guard correctly refuses to
    // apply it - the queue entry just vanishes with nothing to show for the cost that was paid.
    const projectedLevel = getProjectedBuildingLevel(village, buildingId);
    if (projectedLevel >= building.maxLevel) return { ok: false, error: 'Budynek jest już na maksymalnym poziomie (lub ma już zaplanowany maksymalny poziom w kolejce).' };
    if (village.buildQueue.length >= 3) return { ok: false, error: 'Kolejka budowy jest już pełna. Maksymalnie 3 zadania.' };
    if (buildingId === 'castle') {
      const townHall = village.buildings.find((b) => b.id === 'townHall');
      if (!townHall || townHall.level < 10) return { ok: false, error: 'Zamek wymaga Ratusza na poziomie 10.' };
    }
    const nextLevel = projectedLevel + 1;
    const cost = getBuildingCost(building, nextLevel);
    if ((Number(player.gold) || 0) < cost) return { ok: false, error: 'Brak wystarczającej ilości złota.' };
    player.gold = (Number(player.gold) || 0) - cost;
    const timeSeconds = getBuildingTime(building, nextLevel);
    const now = Date.now();
    const lastQueueItem = village.buildQueue.length > 0 ? village.buildQueue[village.buildQueue.length - 1] : null;
    const startTime = lastQueueItem && lastQueueItem.endTime > now ? lastQueueItem.endTime : now;
    village.buildQueue.push({
      buildingId, name: building.label, targetLevel: nextLevel, cost,
      buildDurationSeconds: timeSeconds, startTime, endTime: startTime + timeSeconds * 1000
    });
    return { ok: true };
  }

  function cancelBuildQueueItem(state, playerId, villageId, queueIndex) {
    if (state.roundStatus === 'finished') return { ok: false, error: 'Runda zakończona.' };
    const player = findPlayer(state, playerId);
    if (player && player.blockedByAdmin) return { ok: false, error: BLOCKED_BY_ADMIN_ERROR };
    const village = state.villages && state.villages[villageId];
    if (!player || !village || village.owner !== player.name) return { ok: false, error: 'Brak dostępu do tej wioski.' };
    if (!Array.isArray(village.buildQueue) || queueIndex < 0 || queueIndex >= village.buildQueue.length) {
      return { ok: false, error: 'Nieprawidłowy element kolejki.' };
    }
    const [removed] = village.buildQueue.splice(queueIndex, 1);
    if (!removed) return { ok: false, error: 'Nieprawidłowy element kolejki.' };
    player.gold = (Number(player.gold) || 0) + removed.cost;
    renumberBuildQueueTargetLevels(village, player, removed.buildingId);
    normalizeBuildQueueTimes(village);
    return { ok: true };
  }

  // Cancelling an earlier queue item (e.g. removing queued levels 3 and 4, leaving level 5) must
  // not leave the remaining item(s) pointing at their original, now-stale targetLevel - otherwise
  // processVillageQueue's `building.level = current.targetLevel` jumps straight to that stale
  // level, skipping every level in between. Re-derive targetLevel for every queue item of the
  // affected building, in queue order, starting from the building's actual current level - so a
  // remaining "level 5" item correctly becomes "level 3" (the next level up) after its
  // predecessors are cancelled. Cost/duration are re-derived too and any gold overpaid for the
  // now-abandoned higher level is refunded - only the sequence position changed, but a stale
  // level 5 item would otherwise still charge/take as long as level 5 while only ever building to
  // level 3. Renumbering can only ever lower a level (removing earlier items shortens the chain),
  // never raise one, so the refund is always >= 0 and never risks pushing gold negative.
  function renumberBuildQueueTargetLevels(village, player, buildingId) {
    const building = village.buildings.find((b) => b.id === buildingId);
    if (!building) return;
    let level = typeof building.level === 'number' ? building.level : 0;
    village.buildQueue.forEach((item) => {
      if (item.buildingId !== buildingId) return;
      level += 1;
      if (item.targetLevel === level) return;
      item.targetLevel = level;
      const newCost = getBuildingCost(building, level);
      const refund = (Number(item.cost) || 0) - newCost;
      if (player && refund !== 0) player.gold = (Number(player.gold) || 0) + refund;
      item.cost = newCost;
      item.buildDurationSeconds = getBuildingTime(building, level);
    });
  }

  function recruitUnit(state, playerId, villageId, unitId, count) {
    if (state.roundStatus === 'finished') return { ok: false, error: 'Runda zakończona.' };
    setActiveTimeScaleFactor(state);
    const player = findPlayer(state, playerId);
    if (player && player.blockedByAdmin) return { ok: false, error: BLOCKED_BY_ADMIN_ERROR };
    const village = state.villages && state.villages[villageId];
    if (!player || !village || village.owner !== player.name) return { ok: false, error: 'Brak dostępu do tej wioski.' };
    const safeCount = Math.floor(Number(count));
    if (!Number.isFinite(safeCount) || safeCount <= 0) return { ok: false, error: 'Wprowadź poprawną ilość jednostek.' };
    const unit = UNIT_DEFS.find((item) => item.id === unitId);
    if (!unit) return { ok: false, error: 'Nieznana jednostka.' };
    const isLordUnit = unit.id === 'lord';
    if (isLordUnit) {
      village.lordQueue = Array.isArray(village.lordQueue) ? village.lordQueue : [];
      if (!canRecruitLord(village) || village.lordQueue.length > 0) {
        return { ok: false, error: 'Lorda można rekrutować tylko gdy wioska ma zamek poziom 5 i nie ma jeszcze lorda w garnizonie lub w kolejce.' };
      }
      if (safeCount !== 1) return { ok: false, error: 'Lorda rekrutuje się pojedynczo.' };
    }
    village.recruitQueue = Array.isArray(village.recruitQueue) ? village.recruitQueue : [];
    const recruitTime = getRecruitTime(unit, village);
    const totalCost = unit.cost * safeCount;
    if ((Number(player.gold) || 0) < totalCost) return { ok: false, error: 'Brak wystarczającej ilości złota.' };
    const used = computeVillagePopulationUsed(village);
    const reserved = computeVillageReservedPopulation(village);
    const capacity = getVillagePopulationCapacity(village);
    const needed = (unitPopulationCost[unitId] || 0) * safeCount;
    if (used + reserved + needed > capacity) return { ok: false, error: 'Brak dostępnej populacji w wiosce.' };
    player.gold = (Number(player.gold) || 0) - totalCost;
    const now = Date.now();
    // The Lord trains on its own independent timer, completely separate from the shared
    // recruitQueue - it must never wait behind (or block) whatever army units are already queued.
    if (isLordUnit) {
      village.lordQueue.push({
        unitId, name: unit.label, count: safeCount, trainedUnits: 0, remainingUnits: safeCount,
        cost: totalCost, unitDurationSeconds: recruitTime, startTime: now, endTime: now + recruitTime * 1000
      });
      return { ok: true };
    }
    const lastQueueItem = village.recruitQueue.length > 0 ? village.recruitQueue[village.recruitQueue.length - 1] : null;
    // Must wait for the LAST item's whole batch (all its remainingUnits), not just its next single
    // unit (item.endTime) - otherwise a newly-queued item's displayed countdown would be wrong
    // whenever an earlier item trains more than one unit.
    const startTime = lastQueueItem ? Math.max(now, getRecruitQueueItemBatchEndTime(lastQueueItem)) : now;
    village.recruitQueue.push({
      unitId, name: unit.label, count: safeCount, trainedUnits: 0, remainingUnits: safeCount,
      cost: totalCost, unitDurationSeconds: recruitTime, startTime, endTime: startTime + recruitTime * 1000
    });
    return { ok: true };
  }

  function cancelRecruitQueueItem(state, playerId, villageId, queueIndex) {
    if (state.roundStatus === 'finished') return { ok: false, error: 'Runda zakończona.' };
    const player = findPlayer(state, playerId);
    if (player && player.blockedByAdmin) return { ok: false, error: BLOCKED_BY_ADMIN_ERROR };
    const village = state.villages && state.villages[villageId];
    if (!player || !village || village.owner !== player.name) return { ok: false, error: 'Brak dostępu do tej wioski.' };
    if (!Array.isArray(village.recruitQueue) || queueIndex < 0 || queueIndex >= village.recruitQueue.length) {
      return { ok: false, error: 'Nieprawidłowy element kolejki.' };
    }
    const [removed] = village.recruitQueue.splice(queueIndex, 1);
    if (!removed) return { ok: false, error: 'Nieprawidłowy element kolejki.' };
    player.gold = (Number(player.gold) || 0) + removed.cost;
    normalizeRecruitQueueTimes(village);
    return { ok: true };
  }

  // The Lord lives on its own separate lordQueue (see recruitUnit), so cancelling it needs its own
  // mutator instead of reusing cancelRecruitQueueItem's recruitQueue-only index lookup.
  function cancelLordRecruit(state, playerId, villageId) {
    if (state.roundStatus === 'finished') return { ok: false, error: 'Runda zakończona.' };
    const player = findPlayer(state, playerId);
    if (player && player.blockedByAdmin) return { ok: false, error: BLOCKED_BY_ADMIN_ERROR };
    const village = state.villages && state.villages[villageId];
    if (!player || !village || village.owner !== player.name) return { ok: false, error: 'Brak dostępu do tej wioski.' };
    if (!Array.isArray(village.lordQueue) || !village.lordQueue.length) {
      return { ok: false, error: 'Brak rekrutowanego Lorda do anulowania.' };
    }
    const [removed] = village.lordQueue.splice(0, 1);
    if (!removed) return { ok: false, error: 'Brak rekrutowanego Lorda do anulowania.' };
    player.gold = (Number(player.gold) || 0) + removed.cost;
    return { ok: true };
  }

  function buyVillage(state, playerId, villageId) {
    if (state.roundStatus === 'finished') return { ok: false, error: 'Runda zakończona.' };
    const player = findPlayer(state, playerId);
    if (player && player.blockedByAdmin) return { ok: false, error: BLOCKED_BY_ADMIN_ERROR };
    const village = state.villages && state.villages[villageId];
    if (!player || !village) return { ok: false, error: 'Nieznana wioska.' };
    if (village.owner) return { ok: false, error: 'Ta wioska ma już właściciela.' };
    const parentId = getVillageParentId(village);
    const parentVillage = parentId ? state.villages[parentId] : null;
    if (!parentVillage || parentVillage.owner !== player.name) return { ok: false, error: 'Możesz wykupić tylko wioskę sąsiadującą z Twoją.' };
    if ((Number(player.gold) || 0) < auxiliaryVillageCost) return { ok: false, error: 'Nie masz wystarczająco złota, aby wykupić wioskę.' };
    player.gold = (Number(player.gold) || 0) - auxiliaryVillageCost;
    setVillageOwner(village, player.name, player.color);
    village.type = 'main';
    return { ok: true };
  }

  // Changes only the village's own display name (village.label) — never the map node's label
  // (mapNodes[].label, the short "1"/"A1"-style text drawn ON the map itself), which stays fixed so
  // renaming never disturbs map layout/readability. 8-char cap matches the fixed-width name slot in
  // the UI (see .village-name in game.html) so the switcher's prev/next arrows never shift position
  // regardless of what the player names their village.
  function renameVillage(state, playerId, villageId, newLabel) {
    if (state.roundStatus === 'finished') return { ok: false, error: 'Runda zakończona.' };
    const player = findPlayer(state, playerId);
    if (player && player.blockedByAdmin) return { ok: false, error: BLOCKED_BY_ADMIN_ERROR };
    const village = state.villages && state.villages[villageId];
    if (!player || !village || village.owner !== player.name) return { ok: false, error: 'Brak dostępu do tej wioski.' };
    const trimmed = String(newLabel == null ? '' : newLabel).trim();
    if (!trimmed) return { ok: false, error: 'Nazwa nie może być pusta.' };
    if (trimmed.length > 8) return { ok: false, error: 'Nazwa może mieć maksymalnie 8 znaków.' };
    village.label = trimmed;
    return { ok: true, label: trimmed };
  }

  function getAttackTravelTime(unitId) {
    const baseSeconds = Number(attackTravelTimes[unitId]) || 90;
    return Math.max(1, Math.round(baseSeconds * activeTimeScaleFactor));
  }

  function getAttackUnitsPayload(attack) {
    if (Array.isArray(attack?.units) && attack.units.length) {
      return attack.units.filter((entry) => entry && entry.unitId && Number(entry.count) > 0);
    }
    return [];
  }

  function getAttackTravelTimeMs(attack) {
    const attackUnits = getAttackUnitsPayload(attack);
    if (!attackUnits.length) return 0;
    return attackUnits.reduce((maxMs, entry) => Math.max(maxMs, getAttackTravelTime(entry.unitId) * 1000), 0);
  }

  function addBattleReport(state, report) {
    state.reports = state.reports || [];
    // timestamp alone isn't a safe unique key: every report generated within the same server tick
    // shares the exact same Date.now() value (see the single `now` captured once per
    // processActiveAttacks() call), which would make two different reports indistinguishable to
    // the client's "keep this one expanded across re-renders" logic. A random suffix guarantees
    // each report has its own identity regardless of how many resolve in the same tick.
    report.id = report.id || `${report.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    state.reports.unshift(report);
    if (state.reports.length > 300) state.reports.length = 300;
  }

  function sendAttack(state, playerId, { sourceVillageId, targetVillageId, selectedUnits, mode }) {
    if (state.roundStatus === 'finished') return { ok: false, error: 'Runda zakończona.' };
    setActiveTimeScaleFactor(state);
    const player = findPlayer(state, playerId);
    // Admin safety-valve for an ACTIVE tournament room (see gameSession.setPlayerBlockedByAdmin) -
    // fully neutralizes a player who shouldn't be in the match without touching their seat: every
    // player-initiated action (build, recruit, attack/recon, support, recall, claim) is blocked the
    // same way (see the matching check in each of those functions below) — their villages stay
    // fully attackable by everyone else, only their OWN ability to act is frozen. Doesn't apply to
    // bots, which never call any of these functions at all (bot AI pushes state directly).
    if (player && player.blockedByAdmin) return { ok: false, error: BLOCKED_BY_ADMIN_ERROR };
    const sourceVillage = state.villages && state.villages[sourceVillageId];
    const targetVillage = state.villages && state.villages[targetVillageId];
    if (!player || !sourceVillage || sourceVillage.owner !== player.name) return { ok: false, error: 'Brak dostępu do wioski źródłowej.' };
    if (!targetVillage) return { ok: false, error: 'Nieznana wioska docelowa.' };
    const entries = Object.entries(selectedUnits || {}).filter(([, count]) => Number(count) > 0);
    if (!entries.length) return { ok: false, error: 'Wybierz przynajmniej jedną jednostkę.' };

    const garrison = sourceVillage.garrison || defaultVillageGarrison();
    const isRecon = mode === 'recon';
    if (isRecon && entries.some(([unitId]) => unitId !== 'scout')) {
      return { ok: false, error: 'Zwiad może korzystać tylko ze zwiadowców.' };
    }
    // Team mode only: an ownerless village (sitting in a region no team claimed this round) can
    // also be targeted, even though canAttackVillage rejects any village with no owner — see the
    // matching capture branch in processActiveAttacks below.
    const isNeutralTeamVillage = state.mapType === 'team' && !targetVillage.owner;
    if (!isRecon && !canAttackVillage(targetVillage, player.name) && !isNeutralTeamVillage) {
      return { ok: false, error: 'Nie możesz zaatakować tej wioski.' };
    }

    const chosenUnits = [];
    for (const [unitId, count] of entries) {
      const unit = UNIT_DEFS.find((item) => item.id === unitId);
      if (!unit) continue;
      const available = Number(garrison[unitId] || 0);
      const requested = Math.min(Math.floor(Number(count)) || 0, available);
      if (requested <= 0) continue;
      chosenUnits.push({ unitId: unit.id, count: requested });
    }
    if (!chosenUnits.length) return { ok: false, error: 'Brak dostępnych jednostek do wysłania.' };

    chosenUnits.forEach(({ unitId, count }) => {
      garrison[unitId] = Math.max(0, (garrison[unitId] || 0) - count);
      syncUnitHousing(sourceVillage, unitId, count, 'occupy');
    });
    sourceVillage.garrison = garrison;

    const travelTimeMs = getAttackTravelTimeMs({ units: chosenUnits });
    const sentAt = Date.now();
    state.attacks = state.attacks || [];
    state.attacks.push({
      id: `${sentAt}-${isRecon ? 'recon' : 'attack'}-${playerId}-${Math.random().toString(36).slice(2, 8)}`,
      sourceVillageId, targetVillageId,
      attackerName: player.name,
      targetPlayerName: targetVillage.owner,
      sentAt,
      arrivesAt: sentAt + travelTimeMs,
      travelTimeMs,
      status: 'traveling',
      direction: isRecon ? 'recon' : 'attack',
      units: chosenUnits
    });
    return { ok: true };
  }

  function cancelOutgoingAttack(state, playerId, attackId) {
    if (state.roundStatus === 'finished') return { ok: false, error: 'Runda zakończona.' };
    const player = findPlayer(state, playerId);
    if (player && player.blockedByAdmin) return { ok: false, error: BLOCKED_BY_ADMIN_ERROR };
    if (!player) return { ok: false, error: 'Brak gracza.' };
    const index = (state.attacks || []).findIndex((attack) => attack && attack.id === attackId);
    if (index === -1) return { ok: false, error: 'Nie znaleziono ataku.' };
    const attack = state.attacks[index];
    if (attack.direction === 'return' || attack.attackerName !== player.name) return { ok: false, error: 'Nie możesz odwołać tego ataku.' };
    const now = Date.now();
    if (attack.arrivesAt <= now) return { ok: false, error: 'Atak już dotarł do celu.' };
    const departureTime = attack.arrivesAt - (Number(attack.travelTimeMs) || 0);
    const elapsedMs = Math.max(0, now - departureTime);
    state.attacks.splice(index, 1);
    state.attacks.push({
      id: `${attack.id}-cancelled`,
      sourceVillageId: attack.targetVillageId,
      targetVillageId: attack.sourceVillageId,
      attackerName: attack.attackerName,
      targetPlayerName: null,
      sentAt: now,
      arrivesAt: now + elapsedMs,
      travelTimeMs: elapsedMs,
      status: 'returning',
      direction: 'return',
      units: (attack.units || []).map((entry) => ({ ...entry }))
    });
    return { ok: true };
  }

  // --- Village support (reinforcements) -------------------------------------
  // Sending support works exactly like sending an attack (same travel time, same garrison
  // deduction, same population-housing bookkeeping) except the destination must be one of the
  // SAME player's own villages, and on arrival the units are added to the target's `reinforcements`
  // list instead of resolving a battle. They keep counting against the SOURCE village's population
  // (via syncUnitHousing 'occupy', already set at send time) until they die or are recalled home —
  // the hosting village's own population/attack-unit lists never see them.

  function sendSupport(state, playerId, { sourceVillageId, targetVillageId, selectedUnits }) {
    if (state.roundStatus === 'finished') return { ok: false, error: 'Runda zakończona.' };
    setActiveTimeScaleFactor(state);
    const player = findPlayer(state, playerId);
    if (player && player.blockedByAdmin) return { ok: false, error: BLOCKED_BY_ADMIN_ERROR };
    const sourceVillage = state.villages && state.villages[sourceVillageId];
    const targetVillage = state.villages && state.villages[targetVillageId];
    if (!player || !sourceVillage || sourceVillage.owner !== player.name) return { ok: false, error: 'Brak dostępu do wioski źródłowej.' };
    if (!targetVillage) return { ok: false, error: 'Wsparcie można wysłać tylko do własnej wioski.' };
    // Team mode additionally allows supporting a TEAMMATE's village, not just your own — see
    // isSameTeam. Classic rooms (state.mapType !== 'team') keep the exact original owner-only rule.
    const isAllyVillage = state.mapType === 'team' && targetVillage.owner !== player.name && isSameTeam(state, player, targetVillage.owner);
    if (targetVillage.owner !== player.name && !isAllyVillage) {
      return { ok: false, error: 'Wsparcie można wysłać tylko do własnej wioski.' };
    }
    if (targetVillageId === sourceVillageId) return { ok: false, error: 'Wybierz inną wioskę docelową.' };
    const entries = Object.entries(selectedUnits || {}).filter(([unitId, count]) => unitId !== 'lord' && Number(count) > 0);
    if (!entries.length) return { ok: false, error: 'Wybierz przynajmniej jedną jednostkę (Lord nie może wspierać).' };

    const garrison = sourceVillage.garrison || defaultVillageGarrison();
    const chosenUnits = [];
    for (const [unitId, count] of entries) {
      const unit = UNIT_DEFS.find((item) => item.id === unitId);
      if (!unit) continue;
      const available = Number(garrison[unitId] || 0);
      const requested = Math.min(Math.floor(Number(count)) || 0, available);
      if (requested <= 0) continue;
      chosenUnits.push({ unitId: unit.id, count: requested });
    }
    if (!chosenUnits.length) return { ok: false, error: 'Brak dostępnych jednostek do wysłania.' };

    chosenUnits.forEach(({ unitId, count }) => {
      garrison[unitId] = Math.max(0, (garrison[unitId] || 0) - count);
      syncUnitHousing(sourceVillage, unitId, count, 'occupy');
    });
    sourceVillage.garrison = garrison;

    const travelTimeMs = getAttackTravelTimeMs({ units: chosenUnits });
    const sentAt = Date.now();
    state.attacks = state.attacks || [];
    state.attacks.push({
      id: `${sentAt}-support-${playerId}-${Math.random().toString(36).slice(2, 8)}`,
      sourceVillageId, targetVillageId,
      attackerName: player.name,
      targetPlayerName: targetVillage.owner,
      sentAt,
      arrivesAt: sentAt + travelTimeMs,
      travelTimeMs,
      status: 'traveling',
      direction: 'support',
      units: chosenUnits
    });
    return { ok: true };
  }

  // Sends every reinforcement currently stationed at `villageId` back to its own home village —
  // each batch travels home independently (same one-way travel time as it took to arrive) and is
  // only actually released back into the home garrison (and its reserved population slot fully
  // reconciled) once it lands there, reusing the existing 'return' arrival handling below.
  // If reinforcementId is given, only that ONE batch (i.e. the support from one specific home
  // village) is sent home — support from any other village stationed here is left untouched. With
  // no reinforcementId (kept for backward compatibility), every batch is recalled at once.
  function recallSupport(state, playerId, villageId, reinforcementId) {
    if (state.roundStatus === 'finished') return { ok: false, error: 'Runda zakończona.' };
    setActiveTimeScaleFactor(state);
    const player = findPlayer(state, playerId);
    if (player && player.blockedByAdmin) return { ok: false, error: BLOCKED_BY_ADMIN_ERROR };
    const village = state.villages && state.villages[villageId];
    if (!player || !village || village.owner !== player.name) return { ok: false, error: 'Brak dostępu do tej wioski.' };
    const allBatches = Array.isArray(village.reinforcements) ? village.reinforcements : [];
    if (!allBatches.length) return { ok: false, error: 'Brak wsparcia do odwołania w tej wiosce.' };
    const batches = reinforcementId ? allBatches.filter((batch) => batch.id === reinforcementId) : allBatches;
    if (!batches.length) return { ok: false, error: 'Nie znaleziono tego wsparcia.' };

    state.attacks = state.attacks || [];
    batches.forEach((batch) => {
      const units = Object.entries(batch.units || {})
        .filter(([, count]) => Number(count) > 0)
        .map(([unitId, count]) => ({ unitId, count: Number(count) }));
      if (!units.length) return;
      const travelTimeMs = getAttackTravelTimeMs({ units });
      const sentAt = Date.now();
      state.attacks.push({
        id: `${sentAt}-recall-${batch.id || Math.random().toString(36).slice(2)}`,
        sourceVillageId: villageId,
        targetVillageId: batch.sourceVillageId,
        attackerName: batch.ownerName || player.name,
        targetPlayerName: null,
        sentAt,
        arrivesAt: sentAt + travelTimeMs,
        travelTimeMs,
        status: 'returning',
        direction: 'return',
        units
      });
    });
    const recalledIds = new Set(batches.map((batch) => batch.id));
    village.reinforcements = allBatches.filter((batch) => !recalledIds.has(batch.id));
    return { ok: true };
  }

  // --- Combat resolution ---------------------------------------------------

  function getCombatClass(unitId) {
    return unitId === 'scout' || unitId === 'cavalry' ? 'cavalry' : 'infantry';
  }

  // Reinforcements stationed at a village fight alongside its native garrison when defending, but
  // remain listed separately (see ensureVillageGarrison) so they never show up as attackable from
  // here and never count toward this village's own population.
  function getCombinedDefenderCounts(village) {
    const counts = {};
    const garrison = village.garrison || {};
    UNIT_DEFS.forEach((unit) => { counts[unit.id] = Number(garrison[unit.id] || 0); });
    (Array.isArray(village.reinforcements) ? village.reinforcements : []).forEach((batch) => {
      Object.entries(batch.units || {}).forEach(([unitId, count]) => {
        counts[unitId] = (counts[unitId] || 0) + (Number(count) || 0);
      });
    });
    return counts;
  }

  function getTotalDefenderCount(village) {
    const counts = getCombinedDefenderCounts(village);
    return Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  }

  // Applies defender losses of a single unit type, taking from the native garrison FIRST and only
  // reaching into reinforcement batches once the native supply of that unit is exhausted. Any
  // reinforcement unit that dies here releases the population slot it was reserving back at its
  // OWN home village (see sendSupport) — that village never had these units counted against its
  // own capacity in the first place, so there is nothing to release locally.
  function applyDefenderLosses(state, village, unitId, lossCount) {
    let remaining = Math.max(0, Math.round(Number(lossCount) || 0));
    if (remaining <= 0) return;
    village.garrison = village.garrison || defaultVillageGarrison();
    const nativeAvailable = Number(village.garrison[unitId] || 0);
    const takenFromNative = Math.min(nativeAvailable, remaining);
    village.garrison[unitId] = nativeAvailable - takenFromNative;
    remaining -= takenFromNative;
    if (remaining <= 0) return;

    const batches = Array.isArray(village.reinforcements) ? village.reinforcements : [];
    batches.forEach((batch) => {
      if (remaining <= 0) return;
      const available = Number(batch.units?.[unitId] || 0);
      if (available <= 0) return;
      const taken = Math.min(available, remaining);
      batch.units[unitId] = available - taken;
      remaining -= taken;
      const homeVillage = state.villages[batch.sourceVillageId];
      if (homeVillage) {
        syncUnitHousing(homeVillage, unitId, taken, 'release');
      }
    });
    village.reinforcements = batches
      .map((batch) => ({ ...batch, units: Object.fromEntries(Object.entries(batch.units || {}).filter(([, count]) => Number(count) > 0)) }))
      .filter((batch) => Object.keys(batch.units).length > 0);
  }

  function getVillageWallLevel(village) {
    if (!village || !Array.isArray(village.buildings)) return 0;
    const wall = village.buildings.find((b) => b.id === 'wall');
    return Number(wall?.level) || 0;
  }

  // Each wall level adds a flat 2% to the village's total defense power (level 10 -> +20%).
  function getWallDefenseMultiplier(village) {
    return 1 + getVillageWallLevel(village) * 0.02;
  }

  // Rams permanently grind down the target village's wall level based on how many were actually
  // sent in this attack AND how much of the defending garrison actually died (user's explicit
  // follow-up spec, 2026-07-24: "licz od strat obrońcy, proporcjonalnie ile procent stracił wojska
  // tyle obniż mur") — ONE unified rule for both a won and a lost attack, replacing the earlier
  // two-regime version (survival-gated full wipe on a win / flat 4-level cap on a loss), which
  // under-damaged the wall on a costly-but-close loss. `ramPotential = min(1, ramsSent / 100)` (100
  // rams = full potential) is multiplied by `defenderLossFraction` (the defender's own casualties as
  // a % of its pre-battle garrison) to get the fraction of the CURRENT wall level knocked off. Since
  // a WIN always wipes the defender's garrison 100% in this engine's all-or-nothing combat model,
  // defenderLossFraction is trivially 1 on any win — so 100 rams always fully zeroes the wall on a
  // win, regardless of the attacker's own survival rate (no more 50%-survival gate). On a LOSS,
  // defenderLossFraction is whatever fraction of the defender's garrison the attacker still managed
  // to kill before being wiped out itself — a near-draw loss grinds the wall down almost as hard as
  // a win would, a lopsided loss barely touches it.
  // Returns {levelBefore, levelAfter} when the wall actually lost a level, otherwise null.
  function applyRamWallDamage(targetVillage, ramsSent, defenderLossFraction) {
    if (!targetVillage || !Array.isArray(targetVillage.buildings) || ramsSent <= 0) return null;
    const wall = targetVillage.buildings.find((b) => b.id === 'wall');
    const levelBefore = Number(wall?.level) || 0;
    if (!wall || levelBefore <= 0) return null;
    const ramPotential = Math.min(1, ramsSent / 100);
    const destructionFraction = ramPotential * Math.min(1, Math.max(0, defenderLossFraction));
    if (destructionFraction <= 0) return null;
    const levelAfter = Math.max(0, Math.round(levelBefore * (1 - destructionFraction)));
    if (levelAfter === levelBefore) return null;
    wall.level = levelAfter;
    return { levelBefore, levelAfter };
  }

  // Deterministic combat, no randomness anywhere: total attack power (sum of count * attackValue)
  // is weighed against total defense power (sum of count * effective defense, where "effective
  // defense" blends defenseAgainstInfantry/defenseAgainstCavalry by how much of the attack came
  // from each class, then multiplied by the wall bonus) — whichever total is bigger wins outright.
  // There is no outcome where both sides keep survivors and nobody is defeated: the LOSING side's
  // committed troops are wiped out completely; the WINNING side's losses are only ever proportional
  // to how close the fight actually was (losses = opponent's power / own power).
  function resolveAttackBattle(state, attack, targetVillage) {
    // Note: a Lord sent with NO escort produces an empty attackUnits array here (the Lord itself is
    // filtered out above) — this is intentionally NOT special-cased into an automatic loss anymore.
    // It used to hard-return attackerWins:false unconditionally, which made the "unowned team
    // territory falls to a single unescorted Lord strike" feature (see the villageWasCaptured branch
    // for state.mapType === 'team' further below) unreachable, since that branch requires
    // battle.attackerWins to ever be true. Letting 0 attack power flow through the normal power
    // comparison below means a Lord alone still loses to ANY real garrison (0 can't beat positive
    // defense power) but correctly wins against a genuinely undefended target (see the
    // defenderEntries.length === 0 override below), matching that feature's intent.
    const attackUnits = getAttackUnitsPayload(attack).filter((entry) => entry.unitId !== 'lord');

    const combinedCounts = getCombinedDefenderCounts(targetVillage);
    const defenderEntries = UNIT_DEFS
      .map((unit) => ({ ...unit, count: Number(combinedCounts[unit.id] || 0) }))
      .filter((unit) => unit.count > 0);
    // Full pre-battle defending force, independent of defenderLossBreakdown below (which only ever
    // lists units that took losses, and omits units that fully survived) - consumed by the client to
    // show "how many troops did the defender have" on a report, but only ever surfaced to whichever
    // side actually won the battle (see renderReports in game.js).
    const defenderGarrisonBeforeBattle = defenderEntries.map((unit) => ({ unitId: unit.id, label: unit.label, count: unit.count }));

    let infantryAttackPower = 0;
    let cavalryAttackPower = 0;
    const attackDetails = attackUnits.map((entry) => {
      const unit = UNIT_DEFS.find((item) => item.id === entry.unitId);
      const count = Math.max(0, Math.round(Number(entry.count) || 0));
      const attackValue = unit ? Number(unit.attackValue || 0) : 0;
      const power = count * attackValue;
      if (unit && getCombatClass(unit.id) === 'cavalry') cavalryAttackPower += power; else infantryAttackPower += power;
      return { unitId: entry.unitId, count, power };
    });
    const totalAttackPower = infantryAttackPower + cavalryAttackPower;
    const infantryShare = totalAttackPower > 0 ? infantryAttackPower / totalAttackPower : 0;
    const cavalryShare = totalAttackPower > 0 ? cavalryAttackPower / totalAttackPower : 0;

    const wallMultiplier = getWallDefenseMultiplier(targetVillage);
    let totalDefensePower = 0;
    defenderEntries.forEach((unit) => {
      const effectiveDefense = (Number(unit.defenseAgainstInfantry || 0) * infantryShare) + (Number(unit.defenseAgainstCavalry || 0) * cavalryShare);
      totalDefensePower += unit.count * effectiveDefense;
    });
    totalDefensePower *= wallMultiplier;

    // A tie between two POSITIVE power totals is resolved in the defender's favor — breaking in
    // requires strictly MORE power than the defense, not merely matching it. The one exception is a
    // target with literally zero defenders (defenderEntries empty, so totalDefensePower is also 0):
    // there is nothing to contest, so even a Lord sent with no escort (0 attack power) takes it —
    // this is what makes the unowned-team-territory instant-capture feature above actually reachable.
    const attackerWins = defenderEntries.length === 0 || totalAttackPower > totalDefensePower;

    if (attackerWins) {
      const attackerLossFraction = totalAttackPower > 0 ? Math.min(1, totalDefensePower / totalAttackPower) : 0;
      defenderEntries.forEach((unit) => applyDefenderLosses(state, targetVillage, unit.id, unit.count));
      const attackerResults = attackDetails.map(({ unitId, count }) => {
        const losses = Math.min(count, Math.round(count * attackerLossFraction));
        return { unitId, count, survivingCount: Math.max(0, count - losses), losses };
      });
      const defenderLossBreakdown = defenderEntries.map((unit) => ({ unitId: unit.id, label: unit.label, lost: unit.count }));
      return { attackerResults, defenderLossBreakdown, attackerWins: true, totalAttackPower, totalDefensePower, defenderGarrisonBeforeBattle };
    }

    // A zero-power attack (e.g. scouts alone, attackValue 0) must never damage the defender even in
    // this "attacker lost" branch: the `: 1` fallback below exists for the case of a defended village
    // whose defenders happen to sum to 0 effective defense power (a real attack overwhelming it
    // completely despite technically not out-pacing 0 defense) - it was NOT meant to also fire when
    // totalAttackPower itself is 0, which the ratio alone can't distinguish from that case.
    const defenderLossFraction = totalAttackPower <= 0 ? 0 : (totalDefensePower > 0 ? Math.min(1, totalAttackPower / totalDefensePower) : 1);
    const defenderLossBreakdown = [];
    defenderEntries.forEach((unit) => {
      const losses = Math.min(unit.count, Math.round(unit.count * defenderLossFraction));
      if (losses > 0) {
        applyDefenderLosses(state, targetVillage, unit.id, losses);
        defenderLossBreakdown.push({ unitId: unit.id, label: unit.label, lost: losses });
      }
    });
    // Defeated attackers never return home — every committed unit is lost, not just "most of them".
    const attackerResults = attackDetails.map(({ unitId, count }) => ({ unitId, count, survivingCount: 0, losses: count }));
    return { attackerResults, defenderLossBreakdown, attackerWins: false, totalAttackPower, totalDefensePower, defenderGarrisonBeforeBattle };
  }

  function getAttackSentAt(attack) {
    if (Number.isFinite(attack?.sentAt)) return attack.sentAt;
    // Older, already-in-flight entries saved before `sentAt` existed: derive a best-effort
    // estimate from when they must have departed to be arriving when they do.
    return (Number(attack?.arrivesAt) || 0) - (Number(attack?.travelTimeMs) || 0);
  }

  function processActiveAttacks(state) {
    const now = Date.now();
    const returningAttacksToQueue = [];
    // Two moves that happen to become ready to resolve in the same tick (e.g. a fast unit sent
    // later and a slow one sent earlier both landing within the same second) must still be
    // processed in the order they were actually SENT, not whatever order they happen to sit in the
    // array — this also determines who "hits first" when several attacks land on the same village.
    state.attacks = (Array.isArray(state.attacks) ? state.attacks : []).slice().sort((a, b) => getAttackSentAt(a) - getAttackSentAt(b));
    state.attacks = state.attacks.filter((attack) => {
      if (!attack || attack.arrivesAt > now) return true;

      if (attack.direction === 'return') {
        const homeVillage = state.villages[attack.targetVillageId];
        if (homeVillage) {
          const homeGarrison = homeVillage.garrison || defaultVillageGarrison();
          getAttackUnitsPayload(attack).forEach((entry) => {
            const count = Number(entry.count) || 0;
            if (count <= 0) return;
            homeGarrison[entry.unitId] = Number(homeGarrison[entry.unitId] || 0) + count;
            syncUnitHousing(homeVillage, entry.unitId, count, 'release');
          });
          homeVillage.garrison = homeGarrison;
        }
        return false;
      }

      if (attack.direction === 'support') {
        const targetVillage = state.villages[attack.targetVillageId];
        const arrivingUnits = getAttackUnitsPayload(attack);
        if (targetVillage && arrivingUnits.length) {
          targetVillage.reinforcements = Array.isArray(targetVillage.reinforcements) ? targetVillage.reinforcements : [];
          const sourceVillage = state.villages[attack.sourceVillageId];
          targetVillage.reinforcements.push({
            id: attack.id,
            sourceVillageId: attack.sourceVillageId,
            sourceLabel: sourceVillage?.label || attack.sourceVillageId,
            ownerName: attack.attackerName,
            units: arrivingUnits.reduce((acc, entry) => { acc[entry.unitId] = Number(entry.count) || 0; return acc; }, {})
          });
          // Population for these units stays reserved at the SOURCE village the whole time they
          // are away supporting (see sendSupport) — nothing to release here on arrival.
        }
        return false;
      }

      if (attack.direction === 'recon') {
        const sourceVillage = state.villages[attack.sourceVillageId];
        const targetVillage = state.villages[attack.targetVillageId];
        if (sourceVillage && targetVillage) {
          const reconUnits = getAttackUnitsPayload(attack);
          const scoutsSent = reconUnits.reduce((sum, entry) => sum + (Number(entry.count) || 0), 0);
          const defenderScouts = Number(targetVillage.garrison?.scout || 0);
          const success = scoutsSent > defenderScouts;
          const defenderName = targetVillage.owner || 'Neutralne';
          const sourceVillageLabel = sourceVillage.label || attack.sourceVillageId;
          const targetVillageLabel = targetVillage.label || 'Wioska';

          if (success) {
            const lossRatio = defenderScouts > 0 ? Math.min(0.5, defenderScouts / scoutsSent) : 0;
            const scoutsLost = Math.min(scoutsSent, Math.round(scoutsSent * lossRatio));
            const scoutsSurvived = scoutsSent - scoutsLost;
            addBattleReport(state, {
              timestamp: now, type: 'recon', attackerName: attack.attackerName || 'Nieznany', defenderName,
              sourceVillageLabel, targetVillageLabel, success: true, scoutsSent, scoutsLost, scoutsSurvived,
              intel: {
                buildings: (targetVillage.buildings || []).map((b) => ({ id: b.id, label: b.label, level: b.level, maxLevel: b.maxLevel })),
                garrison: { ...(targetVillage.garrison || {}) }
              },
              outcome: 'Zwiad udany'
            });
            if (scoutsSurvived > 0) {
              // The captured portion (scoutsLost) is never coming home, so nothing else would ever
              // release the population slot it reserved back home — only the survivors get that
              // release later, when their 'return' trip actually lands (below).
              if (scoutsLost > 0) syncUnitHousing(sourceVillage, 'scout', scoutsLost, 'release');
              const returnTravelTimeMs = Number(attack.travelTimeMs) || getAttackTravelTimeMs({ units: [{ unitId: 'scout', count: scoutsSurvived }] });
              returningAttacksToQueue.push({
                id: `${attack.id || now}-return`, sourceVillageId: attack.targetVillageId, targetVillageId: attack.sourceVillageId,
                attackerName: attack.attackerName, targetPlayerName: null, sentAt: now, arrivesAt: now + returnTravelTimeMs, travelTimeMs: returnTravelTimeMs,
                status: 'returning', direction: 'return', units: [{ unitId: 'scout', count: scoutsSurvived }]
              });
            } else {
              syncUnitHousing(sourceVillage, 'scout', scoutsSent, 'release');
            }
          } else {
            syncUnitHousing(sourceVillage, 'scout', scoutsSent, 'release');
            addBattleReport(state, {
              timestamp: now, type: 'recon', attackerName: attack.attackerName || 'Nieznany', defenderName,
              sourceVillageLabel, targetVillageLabel, success: false, scoutsSent, scoutsLost: scoutsSent, scoutsSurvived: 0,
              intel: null, outcome: 'Zwiad nieudany — zwiadowcy schwytani'
            });
          }
        }
        return false;
      }

      const sourceVillage = state.villages[attack.sourceVillageId];
      const targetVillage = state.villages[attack.targetVillageId];
      if (sourceVillage && targetVillage) {
        const attackUnits = getAttackUnitsPayload(attack);
        const lordEntry = attackUnits.find((entry) => entry.unitId === 'lord' && Number(entry.count) > 0) || null;
        const escortUnits = attackUnits.filter((entry) => entry.unitId !== 'lord');
        const battle = resolveAttackBattle(state, attack, targetVillage);
        const ramsSent = escortUnits.find((entry) => entry.unitId === 'ram')?.count || 0;
        const escortSentTotal = escortUnits.reduce((sum, entry) => sum + (Number(entry.count) || 0), 0);
        const escortLossTotal = battle.attackerResults.reduce((sum, result) => sum + (Number(result.losses) || 0), 0);
        const survivorUnits = [];
        battle.attackerResults.forEach((result) => {
          if (result.survivingCount > 0) survivorUnits.push({ unitId: result.unitId, count: result.survivingCount });
          // A unit that died attacking is gone for good — it was never going to come home and
          // trigger the 'return' handling's release, so nothing else ever freed the population
          // slot it was reserving at its OWN home village. Without this, every lost attacker unit
          // permanently occupied population back home forever, for every player, in every village.
          if (result.losses > 0) syncUnitHousing(sourceVillage, result.unitId, result.losses, 'release');
        });

        const defenderName = targetVillage.owner || 'Neutralne';
        const sourceVillageLabel = sourceVillage.label || attack.sourceVillageId;
        const targetVillageLabel = targetVillage.label || 'Wioska';
        const totalDefenderLosses = battle.defenderLossBreakdown.reduce((sum, item) => sum + (Number(item.lost) || 0), 0);
        const totalDefenderPreBattleCount = battle.defenderGarrisonBeforeBattle.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
        // An empty garrison has no losses to compute a % from, but per the user's explicit follow-up
        // (2026-07-24 - "jeżeli obrońca ma pusty garnizon to mur niszczy się do 0") a defenseless
        // village should still take the FULL ram-based effect, not zero - so this counts as a trivial
        // 100% defender-loss rather than falling back to 0%. Still scales with ramsSent via
        // applyRamWallDamage's ramPotential (100+ rams needed to actually reach 0), it's only the "%
        // of the garrison lost" side of the formula that's pinned to 100% here.
        const defenderLossFraction = totalDefenderPreBattleCount > 0 ? totalDefenderLosses / totalDefenderPreBattleCount : 1;
        const wallDamage = applyRamWallDamage(targetVillage, ramsSent, defenderLossFraction);

        if (escortUnits.length) {
          creditKills(state, defenderName, escortLossTotal, 'defender');
          creditKills(state, attack.attackerName, totalDefenderLosses, 'attacker');
        }
        targetVillage.lastAttackAt = now;
        targetVillage.lastAttackFrom = attack.attackerName;

        // Escort troops and an escorting Lord marched in together as ONE force, so they get ONE
        // combined report instead of two separate ones — the escort's row(s) come first, with a
        // "Lord" row appended when a Lord rode along, and the Lord's own fate (captured the
        // village / reduced loyalty / died / came home safely) is folded into the same outcome text.
        const attackerRows = escortUnits.map((entry) => {
          const result = battle.attackerResults.find((item) => item.unitId === entry.unitId);
          const unit = UNIT_DEFS.find((item) => item.id === entry.unitId);
          return { label: unit ? unit.label : entry.unitId, sent: Number(entry.count) || 0, lost: Number(result?.losses) || 0, survived: Number(result?.survivingCount) || 0 };
        });
        let lordOutcomeText = null;
        let lordAttackerLosses = 0;
        let lordDefenderPointsBonus = 0;
        // How much loyalty this Lord actually removed (0 unless the loyalty-grind branch below
        // runs) - reported to the client separately from the outcome text, see addBattleReport.
        let lordLoyaltyDamageDealt = 0;
        // Explicit flag for "did this attack capture the village" - independent of lordOutcomeText's
        // exact wording now that it also carries the loyalty-damage number (used by
        // processConquestReports in src/server.js for win-trading detection, and by the
        // capturedVillage report field below).
        let villageWasCaptured = false;

        if (lordEntry) {
          const lordCount = Number(lordEntry.count) || 1;
          // The battle result itself is now the single source of truth for "is the village
          // cleared" — an attacker win means every defender (native garrison AND any ally
          // reinforcements) was just wiped out by resolveAttackBattle above.
          const villageFullyCleared = battle.attackerWins;
          const lordSurvivesBattle = escortSentTotal > 0
            ? (escortLossTotal / (escortSentTotal + lordCount)) <= 0.7
            : villageFullyCleared;
          let lordConsumed = false;
          let lordSurvivedCount = lordCount;

          if (villageFullyCleared && targetVillage.owner && targetVillage.owner !== attack.attackerName) {
            const loyaltyBeforeHit = getVillageLoyalty(targetVillage);
            const newLoyalty = Math.max(0, loyaltyBeforeHit - lordLoyaltyDamage);
            // Clamped to what was actually left (e.g. a village already at 30% only loses 30, not
            // the full 50) - this is the real number to show the player, not the flat constant.
            lordLoyaltyDamageDealt = loyaltyBeforeHit - newLoyalty;
            targetVillage.loyalty = newLoyalty;
            if (newLoyalty <= 0) {
              lordConsumed = true;
              lordSurvivedCount = 0;
              const attackerPlayer = state.players.find((p) => p.name === attack.attackerName);
              setVillageOwner(targetVillage, attack.attackerName, attackerPlayer?.color || null);
              targetVillage.loyalty = villageDefaultLoyalty;
              villageWasCaptured = true;
              lordOutcomeText = `Wioska przejęta! (-${lordLoyaltyDamageDealt} lojalności)`;
            } else if (lordSurvivesBattle) {
              lordOutcomeText = `Lojalność obniżona o ${lordLoyaltyDamageDealt} (do ${newLoyalty}%)`;
            } else {
              lordConsumed = true;
              lordSurvivedCount = 0;
              creditKills(state, defenderName, lordCount, 'defender');
              lordDefenderPointsBonus = lordCount;
              lordOutcomeText = `Lojalność obniżona o ${lordLoyaltyDamageDealt} (do ${newLoyalty}%) — Lord poległ w walce`;
            }
          } else if (villageFullyCleared && !targetVillage.owner && state.mapType === 'team') {
            // Team mode only: a village with no owner at all (an unused region's leftover
            // territory) has zero defenders by definition — one successful Lord strike captures
            // it outright, no loyalty grind needed (per the user's explicit "pierwsze uderzenie"
            // spec, 2026-07-20), unlike conquering an actual enemy-owned village above.
            lordConsumed = true;
            lordSurvivedCount = 0;
            const attackerPlayer = state.players.find((p) => p.name === attack.attackerName);
            setVillageOwner(targetVillage, attack.attackerName, attackerPlayer?.color || null);
            targetVillage.loyalty = villageDefaultLoyalty;
            villageWasCaptured = true;
            lordOutcomeText = 'Wioska przejęta!';
          } else if (!lordSurvivesBattle) {
            lordConsumed = true;
            lordSurvivedCount = 0;
            creditKills(state, defenderName, lordCount, 'defender');
            lordDefenderPointsBonus = lordCount;
            lordOutcomeText = 'Lord poległ w walce';
          } else {
            lordOutcomeText = 'Lord wrócił bezpiecznie';
          }

          lordAttackerLosses = lordConsumed ? lordCount : 0;
          attackerRows.push({ label: 'Lord', sent: lordCount, lost: lordAttackerLosses, survived: lordSurvivedCount });

          if (lordConsumed) {
            syncUnitHousing(sourceVillage, 'lord', lordCount, 'release');
          } else {
            survivorUnits.push({ unitId: 'lord', count: lordCount });
          }
        }

        if (attackerRows.length) {
          const outcomeLabel = battle.attackerWins ? 'Zwycięstwo' : 'Porażka';
          addBattleReport(state, {
            timestamp: now, type: 'battle', attackerName: attack.attackerName || 'Nieznany', defenderName,
            sourceVillageLabel, targetVillageLabel,
            attackers: attackerRows,
            defenders: battle.defenderLossBreakdown.map((item) => ({ label: item.label, lost: item.lost })),
            // Full pre-battle defending force (garrison + reinforcements) - the client only ever
            // shows this to whichever side actually won the battle, see renderReports in game.js.
            defenderGarrisonBeforeBattle: battle.defenderGarrisonBeforeBattle,
            attackerLosses: escortLossTotal + lordAttackerLosses, defenderLosses: totalDefenderLosses,
            attackerPoints: totalDefenderLosses, defenderPoints: escortLossTotal + lordDefenderPointsBonus,
            outcome: lordOutcomeText ? `${outcomeLabel} — ${lordOutcomeText}` : outcomeLabel,
            success: battle.attackerWins,
            // How much loyalty the Lord actually removed this strike, if any - shown on the report
            // alongside the Lord row (see renderReports in game.js).
            lordLoyaltyDamageDealt,
            // Consumed by the server's win-trading/behavioral detection (see processConquestReports
            // in src/server.js) to spot one-sided village hand-offs — never read by the client UI.
            capturedVillage: villageWasCaptured,
            defensePowerAtBattle: battle.totalDefensePower,
            attackPowerAtBattle: battle.totalAttackPower,
            // Set only when rams actually knocked the wall down a level this strike - see
            // applyRamWallDamage and renderReports in game.js for the "💥 Tarany..." note.
            wallLevelBefore: wallDamage ? wallDamage.levelBefore : null,
            wallLevelAfter: wallDamage ? wallDamage.levelAfter : null
          });
        }

        if (survivorUnits.length) {
          const returnTravelTimeMs = Number(attack.travelTimeMs) || getAttackTravelTimeMs({ units: survivorUnits });
          returningAttacksToQueue.push({
            id: `${attack.id || now}-return`, sourceVillageId: attack.targetVillageId, targetVillageId: attack.sourceVillageId,
            attackerName: attack.attackerName, targetPlayerName: null, sentAt: now, arrivesAt: now + returnTravelTimeMs, travelTimeMs: returnTravelTimeMs,
            status: 'returning', direction: 'return', units: survivorUnits
          });
        }
      }
      return false;
    });

    if (returningAttacksToQueue.length) {
      state.attacks.push(...returningAttacksToQueue);
    }
  }

  function processVillageQueue(state, village) {
    if (!village || !Array.isArray(village.buildQueue)) return false;
    const now = Date.now();
    let changed = false;
    while (village.buildQueue.length > 0 && village.buildQueue[0].endTime <= now) {
      const current = village.buildQueue.shift();
      const building = village.buildings.find((b) => b.id === current.buildingId);
      if (building && building.level < building.maxLevel) {
        building.level = current.targetLevel;
        if (current.buildingId === 'barracks') {
          rescaleRecruitQueueForBarracks(village);
          rescaleLordQueueForBarracks(village);
        }
      }
      changed = true;
    }
    if (changed) normalizeBuildQueueTimes(village);
    return changed;
  }

  function processBuildQueues(state) {
    Object.values(state.villages).forEach((village) => processVillageQueue(state, village));
  }

  function processRecruitQueue(village) {
    if (!village || !Array.isArray(village.recruitQueue)) return false;
    const now = Date.now();
    let changed = false;
    while (village.recruitQueue.length > 0 && village.recruitQueue[0].endTime <= now) {
      const current = village.recruitQueue[0];
      village.garrison = village.garrison || defaultVillageGarrison();
      village.garrison[current.unitId] = (village.garrison[current.unitId] || 0) + 1;
      current.trainedUnits += 1;
      current.remainingUnits -= 1;
      changed = true;
      if (current.remainingUnits > 0) {
        current.startTime = current.endTime;
        current.endTime = current.startTime + Math.max(1, Number(current.unitDurationSeconds) || 1) * 1000;
      } else {
        village.recruitQueue.shift();
      }
    }
    if (changed) normalizeRecruitQueueTimes(village);
    return changed;
  }

  function processRecruitQueues(state) {
    Object.values(state.villages).forEach((village) => processRecruitQueue(village));
  }

  // The Lord always trains alone (count is always 1, enforced in recruitUnit/botQueueRecruit), so
  // unlike processRecruitQueue there's no multi-unit batch loop to run here.
  function processLordQueue(village) {
    if (!village || !Array.isArray(village.lordQueue) || !village.lordQueue.length) return false;
    const now = Date.now();
    const current = village.lordQueue[0];
    if (current.endTime > now) return false;
    village.garrison = village.garrison || defaultVillageGarrison();
    village.garrison.lord = (village.garrison.lord || 0) + 1;
    village.lordQueue.shift();
    return true;
  }

  function processLordQueues(state) {
    Object.values(state.villages).forEach((village) => processLordQueue(village));
  }

  function produceGoldForAllPlayers(state) {
    // Rates move opposite to durations — see activeRateScaleFactor() — so a compressed (shorter)
    // Monthly Tournament round produces gold proportionally FASTER, keeping economic pace matched
    // to how much real time is actually available.
    const rateScale = activeRateScaleFactor();
    state.players.forEach((player) => {
      const goldPerSec = getOwnedVillages(state, player.name).reduce((sum, village) => sum + getGoldProductionRate(village), 0) * rateScale;
      if (goldPerSec > 0) {
        player.gold = (Number(player.gold) || 0) + goldPerSec;
      }
    });
  }

  // --- Bot AI ------------------------------------------------------------------

  // Relies solely on the explicit isBot flag (always set — true or false — by gameSession.js when a
  // player entry is built, see `isBot: !!entry.isBot`). A name-pattern fallback used to live here
  // (`/^Bot[-_]/i.test(player.name)`) but that let a REAL player who simply registered a username
  // like "Bot_Legend" get permanently misclassified as a bot the moment runBotAi first saw them
  // (ensureBotAiState then hard-sets player.isBot = true) — silently stripping them of WoLcoin
  // rewards, roundsWon/roundsPlayed credit, and Skill Points for every round they played, since
  // payoutRoundRewards/computeSkillPointsDeltas both filter on isBot. No name heuristic is needed:
  // the flag is never ambiguous.
  function isBotPlayer(player) {
    // Demo_ accounts of the public demo are real user accounts played by the bot runner; they get the same built-in AI.
    return !!(player && (player.isBot || /^Demo_/.test(String(player.name || ''))));
  }

  // Boty bez przypadku (Regulamin §1a): decyzje botow pochodza z deterministycznego generatora
  // (mulberry32) z ziarnem wyliczonym z identyfikatora rundy; stan generatora jest czescia stanu gry
  // (state.botRngState), wiec przebieg rundy z botami da sie w calosci odtworzyc. Boty wystepuja
  // wylacznie w darmowych pokojach bez nagrod.
  let botRand = () => 0.5;
  function seedFromText(text) {
    let h = 2166136261;
    for (const ch of String(text || 'war-of-lords')) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function useBotRng(state) {
    if (!Number.isFinite(state.botRngState)) state.botRngState = seedFromText(state.roundId);
    botRand = () => {
      let a = (state.botRngState + 0x6D2B79F5) >>> 0;
      state.botRngState = a;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pickWeighted(weights) {
    const entries = Object.entries(weights);
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    if (total <= 0) return entries[0]?.[0] || null;
    let roll = botRand() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return key;
    }
    return entries[entries.length - 1][0];
  }

  // Bots hold off their very first attack scan until this much REAL ROUND TIME has passed (measured
  // from state.roundStartedAt, not from whenever the bot happened to be created) — confirmed by the
  // user as an explicit "peaceful" opening phase before bots start raiding (originally 45 minutes,
  // raised to 65 on 2026-07-23 along with the per-round attack cap below).
  const BOT_FIRST_ATTACK_DELAY_MS = 65 * 60 * 1000;
  // Hard cap on real attacks (not recon) a single bot can send across an entire round — confirmed by
  // the user 2026-07-23. Recon scouting is deliberately NOT counted against this: it's a much lower-
  // impact action than a raid and the user's request was specifically about "ataki" (attacks).
  const BOT_MAX_ATTACKS_PER_ROUND = 3;

  function ensureBotAiState(state, player) {
    if (!player.isBot) player.isBot = true;
    if (!player.aiProfile || !botAiProfiles[player.aiProfile]) {
      player.aiProfile = botAiProfileKeys[Math.floor(botRand() * botAiProfileKeys.length)];
    }
    if (!Number.isFinite(player.gold)) player.gold = 300 + Math.floor(botRand() * 400);
    if (!Number.isFinite(player.attacksSentThisRound)) player.attacksSentThisRound = 0;
    if (!Number.isFinite(player.nextAttackAt)) {
      const roundStart = Number.isFinite(state?.roundStartedAt) ? state.roundStartedAt : Date.now();
      player.nextAttackAt = roundStart + (BOT_FIRST_ATTACK_DELAY_MS + botRand() * 40000) * activeTimeScaleFactor;
    }
  }

  function botDecideBuilding(profile, village) {
    const buildings = village.buildings || [];
    if ((village.buildQueue || []).length >= 3) return null;
    const townHall = buildings.find((b) => b.id === 'townHall');
    // Must filter on the PROJECTED level (current + whatever's already queued), not just the
    // building's already-COMPLETED level - otherwise the bot keeps re-queuing the same building
    // on every tick it still has a free queue slot, since .level doesn't increment until each
    // queued item actually finishes. That let a bot's queue stack up target levels beyond
    // maxLevel (e.g. townHall queued to level 11/12), matching queueBuilding's own guard below.
    const eligible = profile.buildPriority
      .map((buildingId) => buildings.find((b) => b.id === buildingId))
      .filter((building) => building && getProjectedBuildingLevel(village, building.id) < building.maxLevel)
      .filter((building) => building.id !== 'castle' || (townHall && townHall.level >= 10));
    if (!eligible.length) return null;
    if (botRand() < 0.7) return eligible[0];
    return eligible[Math.floor(botRand() * eligible.length)];
  }

  function botQueueBuilding(player, village, building) {
    const projectedLevel = getProjectedBuildingLevel(village, building.id);
    if (projectedLevel >= building.maxLevel) return false;
    const nextLevel = projectedLevel + 1;
    const cost = getBuildingCost(building, nextLevel);
    if ((player.gold || 0) < cost) return false;
    player.gold -= cost;
    const timeSeconds = getBuildingTime(building, nextLevel);
    const now = Date.now();
    village.buildQueue = village.buildQueue || [];
    const lastQueueItem = village.buildQueue.length > 0 ? village.buildQueue[village.buildQueue.length - 1] : null;
    const startTime = lastQueueItem && lastQueueItem.endTime > now ? lastQueueItem.endTime : now;
    village.buildQueue.push({
      buildingId: building.id, name: building.label, targetLevel: nextLevel, cost,
      buildDurationSeconds: timeSeconds, startTime, endTime: startTime + timeSeconds * 1000
    });
    return true;
  }

  function botDecideRecruit(profile, village) {
    if ((village.recruitQueue || []).length >= 3) return null;
    if (profile.lordChance > 0 && botRand() < profile.lordChance && canRecruitLord(village)
      && !(village.lordQueue || []).length) {
      return { unitId: 'lord', count: 1 };
    }
    const unitId = pickWeighted(profile.recruitUnitWeights);
    if (!unitId) return null;
    return { unitId, count: 2 + Math.floor(botRand() * 4) };
  }

  function botQueueRecruit(player, village, unitId, count) {
    const unit = UNIT_DEFS.find((item) => item.id === unitId);
    if (!unit) return false;
    const recruitTime = getRecruitTime(unit, village);
    const totalCost = unit.cost * count;
    if ((player.gold || 0) < totalCost) return false;
    const used = computeVillagePopulationUsed(village);
    const reserved = computeVillageReservedPopulation(village);
    const capacity = getVillagePopulationCapacity(village);
    if (used + reserved + (unitPopulationCost[unitId] || 0) * count > capacity) return false;
    player.gold -= totalCost;
    const now = Date.now();
    if (unitId === 'lord') {
      village.lordQueue = village.lordQueue || [];
      village.lordQueue.push({
        unitId, name: unit.label, count, trainedUnits: 0, remainingUnits: count,
        cost: totalCost, unitDurationSeconds: recruitTime, startTime: now, endTime: now + recruitTime * 1000
      });
      return true;
    }
    village.recruitQueue = village.recruitQueue || [];
    const lastQueueItem = village.recruitQueue.length > 0 ? village.recruitQueue[village.recruitQueue.length - 1] : null;
    const startTime = lastQueueItem ? Math.max(now, getRecruitQueueItemBatchEndTime(lastQueueItem)) : now;
    village.recruitQueue.push({
      unitId, name: unit.label, count, trainedUnits: 0, remainingUnits: count,
      cost: totalCost, unitDurationSeconds: recruitTime, startTime, endTime: startTime + recruitTime * 1000
    });
    return true;
  }

  function botConsiderAttack(state, player, profile, now) {
    if (!Number.isFinite(player.nextAttackAt) || now < player.nextAttackAt) return;
    // Once a bot has used up its per-round attack budget, stop rescheduling entirely instead of
    // repeatedly hitting this gate every tick for the rest of the round.
    if ((player.attacksSentThisRound || 0) >= BOT_MAX_ATTACKS_PER_ROUND) return;
    const [minDelay, maxDelay] = profile.attackIntervalMs;
    player.nextAttackAt = now + (minDelay + botRand() * (maxDelay - minDelay)) * activeTimeScaleFactor;

    const ownedVillages = getOwnedVillages(state, player.name);
    if (!ownedVillages.length) return;

    const sourceCandidates = ownedVillages
      .map((village) => ({ village, units: getAvailableAttackUnits(village).filter((unit) => unit.id !== 'lord') }))
      .filter((entry) => entry.units.length > 0);
    if (!sourceCandidates.length) return;
    const { village: sourceVillage, units: availableUnits } = sourceCandidates[Math.floor(botRand() * sourceCandidates.length)];

    // canAttackVillage alone allows friendly fire (by design, for real players who choose it
    // themselves - see the "Team mode: a teammate's village is still attackable" comment on the
    // client). Bots have no such intent, so in team mode they're additionally barred from ever
    // picking a teammate's village as an attack (or recon) target - covers both below since recon
    // also draws from this same filtered list.
    const enemyVillages = Object.values(state.villages).filter((village) => {
      if (!canAttackVillage(village, player.name)) return false;
      if (state.mapType === 'team' && isSameTeam(state, player, village.owner)) return false;
      return true;
    });
    if (!enemyVillages.length) return;

    const scoutsAvailable = Number(sourceVillage.garrison?.scout || 0);
    if (scoutsAvailable > 0 && botRand() < 0.2) {
      const reconTarget = enemyVillages[Math.floor(botRand() * enemyVillages.length)];
      const sendCount = Math.max(1, Math.floor(scoutsAvailable * 0.5));
      const garrison = sourceVillage.garrison;
      garrison.scout = Math.max(0, scoutsAvailable - sendCount);
      syncUnitHousing(sourceVillage, 'scout', sendCount, 'occupy');
      const reconUnits = [{ unitId: 'scout', count: sendCount }];
      const reconTravelTimeMs = getAttackTravelTimeMs({ units: reconUnits });
      state.attacks.push({
        id: `${now}-bot-recon-${player.name}`, sourceVillageId: sourceVillage.id, targetVillageId: reconTarget.id,
        attackerName: player.name, targetPlayerName: reconTarget.owner, sentAt: now, arrivesAt: now + reconTravelTimeMs,
        travelTimeMs: reconTravelTimeMs, status: 'traveling', direction: 'recon', units: reconUnits
      });
      return;
    }

    const targetVillage = enemyVillages[Math.floor(botRand() * enemyVillages.length)];
    const attackUnits = availableUnits
      .map((unit) => {
        const sendable = Math.max(1, Math.floor(unit.count * profile.attackForceShare));
        return sendable > 0 ? { unitId: unit.id, count: Math.min(unit.count, sendable) } : null;
      })
      .filter(Boolean);
    if (!attackUnits.length) return;

    const garrison = sourceVillage.garrison || defaultVillageGarrison();
    attackUnits.forEach(({ unitId, count }) => {
      garrison[unitId] = Math.max(0, (garrison[unitId] || 0) - count);
      syncUnitHousing(sourceVillage, unitId, count, 'occupy');
    });
    sourceVillage.garrison = garrison;

    const finalUnits = [...attackUnits];
    const lordAvailable = Number(garrison.lord || 0) > 0;
    if (lordAvailable && targetVillage.owner && botRand() < 0.4) {
      garrison.lord = 0;
      syncUnitHousing(sourceVillage, 'lord', 1, 'occupy');
      finalUnits.push({ unitId: 'lord', count: 1 });
    }

    const travelTimeMs = getAttackTravelTimeMs({ units: finalUnits });
    state.attacks.push({
      id: `${now}-bot-${player.name}`, sourceVillageId: sourceVillage.id, targetVillageId: targetVillage.id,
      attackerName: player.name, targetPlayerName: targetVillage.owner, sentAt: now, arrivesAt: now + travelTimeMs,
      travelTimeMs, status: 'traveling', direction: 'attack', units: finalUnits
    });
    player.attacksSentThisRound = (player.attacksSentThisRound || 0) + 1;
  }

  function runBotAi(state) {
    if (state.roundStatus === 'finished') return;
    useBotRng(state);
    const now = Date.now();
    state.players.forEach((player) => {
      if (!isBotPlayer(player)) return;
      ensureBotAiState(state, player);
      const profile = botAiProfiles[player.aiProfile];
      const ownedVillages = getOwnedVillages(state, player.name);
      if (!ownedVillages.length) return;

      ownedVillages.forEach((village) => {
        if (!Number.isFinite(village.nextBotBuildCheckAt) || now >= village.nextBotBuildCheckAt) {
          village.nextBotBuildCheckAt = now + (8000 + botRand() * 12000) * activeTimeScaleFactor;
          const building = botDecideBuilding(profile, village);
          if (building) botQueueBuilding(player, village, building);
        }
        if (!Number.isFinite(village.nextBotRecruitCheckAt) || now >= village.nextBotRecruitCheckAt) {
          village.nextBotRecruitCheckAt = now + (6000 + botRand() * 10000) * activeTimeScaleFactor;
          const recruitChoice = botDecideRecruit(profile, village);
          if (recruitChoice) botQueueRecruit(player, village, recruitChoice.unitId, recruitChoice.count);
        }
      });

      botConsiderAttack(state, player, profile, now);
    });
  }

  // --- One authoritative tick, called by the server once per second per room ----

  function tick(state) {
    if (state.roundStatus === 'finished') return;
    setActiveTimeScaleFactor(state);
    processBuildQueues(state);
    processRecruitQueues(state);
    processLordQueues(state);
    produceGoldForAllPlayers(state);
    processActiveAttacks(state);
    runBotAi(state);
    refreshAllPlayerPoints(state);
  }

  return {
    STARTING_GOLD,
    UNIT_DEFS,
    PLAYER_COLORS,
    buildingConfig,
    buildingPoints,
    unitPopulationCost,
    attackTravelTimes,
    tavernPopulationByLevel,
    auxiliaryVillageCost,
    villageDefaultLoyalty,
    colorForSlot,

    defaultVillageGarrison,
    defaultVillageBuildings,
    createDefaultVillages,
    createDefaultMapNodes,
    ensureVillageGarrison,
    ensureSubVillages,
    assignVillagesToPlayers,

    TEAM_REGIONS,
    TEAM_REGION_COUNT,
    TEAM_REGION_SIZE,
    createTeamVillages,
    createTeamMapNodes,
    colorForTeam,
    isSameTeam,
    getActiveTeamIds,
    getActivePlayerCount,
    assignVillagesToPlayersTeamMode,

    getOwnedVillages,
    getVillageParentId,
    getVillageMapInfo,
    canAttackVillage,
    setVillageOwner,
    getVillageLoyalty,
    getVillageCastleLevel,
    getVillageLordCount,
    canRecruitLord,
    getAvailableAttackUnits,

    computeVillagePoints,
    computePlayerPoints,
    refreshAllPlayerPoints,
    comparePlayersByRank,
    computeSkillPointsDeltas,

    setActiveTimeScaleFactor,

    getProjectedBuildingLevel,
    getBuildingCost,
    getBuildingTime,
    getGoldProductionRate,
    getBuildingEffectDescription,
    getTavernLevel,
    getVillagePopulationCapacity,
    computeVillagePopulationUsed,
    computeVillageReservedPopulation,
    getBarracksRecruitSpeedFactor,
    getRecruitTime,
    getAttackTravelTime,
    getAttackUnitsPayload,
    getAttackTravelTimeMs,

    queueBuilding,
    cancelBuildQueueItem,
    recruitUnit,
    cancelRecruitQueueItem,
    cancelLordRecruit,
    buyVillage,
    renameVillage,
    sendAttack,
    cancelOutgoingAttack,
    sendSupport,
    recallSupport,
    getCombinedDefenderCounts,
    getTotalDefenderCount,

    tick,
    processBuildQueues,
    processRecruitQueues,
    processLordQueues,
    processActiveAttacks,
    produceGoldForAllPlayers,
    runBotAi
  };
});
