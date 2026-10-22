// Monthly Tournament orchestrator — the state machine + scheduler described in the spec:
//   SCHEDULED -> ROUND_1 -> BREAK_1 -> ROUND_2 -> PAUSE_DAY -> ROUND_3 -> BREAK_2 -> ROUND_4
//   -> CALCULATION_BREAK -> COMPLETED
//
// Deliberately dependency-injected (see init() below) rather than `require('./server')` — server.js
// already owns the live Mongoose connection, Socket.IO instance, GameEngine, gameSession, and the
// existing free-server-ranking helpers; this module needs to call INTO those while server.js also
// needs to call INTO this module (registerParticipant on ticket purchase, a round-finish hook), so
// passing dependencies in through init() avoids a circular require entirely.
//
// Pure, easily-testable logic (room assignment, per-room scoring) lives in
// src/tournamentAssignment.js and src/tournamentScoring.js — this file is the stateful glue that
// drives real Tournament/TournamentRoom documents and real game Rounds through the schedule.
'use strict';

const Tournament = require('./models/Tournament');
const TournamentRoom = require('./models/TournamentRoom');
const TournamentResults = require('./models/TournamentResults');
const FreeServerRanking = require('./models/FreeServerRanking');
const { assignPlayersToRooms, PLAYERS_PER_ROOM, DEFAULT_MAX_PARTICIPANTS } = require('./tournamentAssignment');
const { computeRoomRoundResults, compareByStatCascade } = require('./tournamentScoring');

// Fallback defaults when a Tournament doc predates these fields, or an admin never touched them —
// the actual values used at runtime always come from the Tournament doc itself (see
// breakBetweenQualRoundsMinutes/calculationBreakMinutes/delayToSemifinalMinutes/
// delayToFinalMinutes in Tournament.js).
const DEFAULT_BREAK_MINUTES = 30;              // Dzień 1 przerwa / Dzień 2 przerwa: exactly 30 min
const DEFAULT_CALCULATION_BREAK_MINUTES = 120; // 2h between Round 4 finishing and results
// Upper bound for all 4 admin-configurable break/delay fields, in minutes — well under the ~24.8
// day ceiling where Node's raw setTimeout (see scheduleAt below) silently fires almost immediately
// instead of waiting.
const MAX_BREAK_MINUTES = 10080; // 7 days
const QUALIFICATION_SEMIFINAL_SLOTS = 35;
const FREE_SERVER_SEMIFINAL_SLOTS = 5;
// The round length every existing GameEngine timing constant is already balanced around — see
// public/gameEngine.js's activeTimeScaleFactor. Changing this changes what "1.0x speed" means for
// every future tournament; it does not retroactively change already-completed rounds.
const QUALIFICATION_ROUND_BASELINE_MINUTES = 120;

let deps = null; // set by init()
const armedTimers = new Map(); // tournamentId -> Timeout, so a re-init/restart never double-arms

function log(...args) {
  console.log('[tournamentEngine]', ...args);
}

/**
 * Wires this module up to the live server infrastructure it needs. Call once at server startup,
 * after Mongo is connected. See the injected-function docs inline below for what each must do —
 * all of them already exist in src/server.js today.
 */
function init(injected) {
  deps = injected;
  // `deps` shape:
  //   io                          — the Socket.IO server (for broadcasting round-start/finish)
  //   User, Room, Round           — existing Mongoose models
  //   gameSession                 — src/gameSession.js (startSession, getSession)
  //   GameEngine                  — public/gameEngine.js (only used indirectly via gameSession)
  //   currentMonthKey()           — "YYYY-MM" helper already in server.js
  //   registerRoundFinishHook(fn) — appends fn(round) to the list server.js calls right after
  //                                  every payoutRoundRewards(round), whether the round finished
  //                                  via its own timer or an admin's manual "end round".
  //   startRoundTimer(roundId)    — arms the existing per-round countdown/finish machinery
  //   startCountdown(roomId)      — the existing "queue is full, start the round" trigger; used by
  //                                  seedBracketRoom() to auto-start a semifinal/final room the
  //                                  moment it's both seeded AND already unpaused.
  //   maybeGrantRegularRoundsMmrReward() — the existing Free-Server-Ranking Top-5 direct-pass grant
  //   getMmrWindowLeaderboard(limit)     — the existing regularRoundsMmrPoints leaderboard reader
  deps.registerRoundFinishHook(handleRoundFinished);
  resumeInFlightTournaments().catch((err) => log('resumeInFlightTournaments error', err));
}

// --- Scheduling (admin) --------------------------------------------------------------------------

/**
 * Admin action: create/update a month's ticket pool (and, optionally, its start date) in ONE call
 * — kept for convenience/backward-compat, but `maxParticipants` and `scheduledStartAt` are fully
 * independent fields under the hood (see Tournament.js) and either can be provided without the
 * other. Typical flow this enables: call this with just {monthKey, maxParticipants} to OPEN ticket
 * sales with no committed date yet; once the pool sells out (or whenever you're ready), call
 * setStartDate() — a separate function/endpoint — to actually pick "T" and kick the schedule off.
 */
async function scheduleTournament({ monthKey, scheduledStartAt, day2StartAt, roundDurationMinutes, maxParticipants, title, ticketPricePLN, prizesConfig, semifinalScheduledAt, finalScheduledAt, breakBetweenQualRoundsMinutes, calculationBreakMinutes, delayToSemifinalMinutes, delayToFinalMinutes }) {
  if (!monthKey) throw new Error('monthKey is required');
  let poolSize;
  if (maxParticipants !== undefined && maxParticipants !== null && maxParticipants !== '') {
    poolSize = Number(maxParticipants);
    if (!Number.isInteger(poolSize) || poolSize <= 0 || poolSize % PLAYERS_PER_ROOM !== 0) {
      throw new Error(`maxParticipants must be a positive multiple of ${PLAYERS_PER_ROOM} (got ${maxParticipants})`);
    }
  }
  let price;
  if (ticketPricePLN !== undefined && ticketPricePLN !== null && ticketPricePLN !== '') {
    price = Number(ticketPricePLN);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`ticketPricePLN must be a positive number (got ${ticketPricePLN})`);
  }
  if (prizesConfig) {
    for (const key of ['place1VPLN', 'place2VPLN', 'place3VPLN', 'place4to10VPLN']) {
      const v = Number(prizesConfig[key]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`prizesConfig.${key} must be a non-negative number`);
    }
  }
  const breakFields = { breakBetweenQualRoundsMinutes, calculationBreakMinutes, delayToSemifinalMinutes, delayToFinalMinutes };
  for (const [key, value] of Object.entries(breakFields)) {
    if (value === undefined || value === null || value === '') continue;
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0 || v > MAX_BREAK_MINUTES) {
      throw new Error(`${key} must be between 0 and ${MAX_BREAK_MINUTES} minutes (got ${value})`);
    }
  }

  let tournament = await Tournament.findOne({ monthKey });
  if (tournament && tournament.status !== 'SCHEDULED') {
    throw new Error(`Tournament for ${monthKey} is already past scheduling (status: ${tournament.status})`);
  }
  // Prizes/price are the guaranteed, pre-set numbers a player already saw before buying a ticket —
  // once the first ticket for this edition has sold, they can never change again. Checked against
  // participants.length, NOT status, because ticket sales run the entire time status is still
  // SCHEDULED (scheduledStartAt is a separate, later commitment — see setStartDate above).
  if ((prizesConfig || price !== undefined) && tournament && tournament.participants.length > 0) {
    throw new Error('Nie można zmieniać puli nagród ani ceny biletu po sprzedaniu pierwszego biletu tej edycji.');
  }

  if (!tournament) {
    tournament = await Tournament.create({
      monthKey,
      maxParticipants: poolSize !== undefined ? poolSize : DEFAULT_MAX_PARTICIPANTS,
      roundDurationMinutes: roundDurationMinutes || 60
    });
    log(`Tournament ${monthKey} created: ${tournament.maxParticipants} tickets (${tournament.maxParticipants / PLAYERS_PER_ROOM} rooms/round). Registration is open — no start date set yet.`);
  } else {
    if (poolSize !== undefined) tournament.maxParticipants = poolSize;
    if (roundDurationMinutes) tournament.roundDurationMinutes = roundDurationMinutes;
  }

  if (title !== undefined) tournament.title = title;
  if (price !== undefined) tournament.ticketPricePLN = price;
  if (semifinalScheduledAt !== undefined) tournament.semifinalScheduledAt = semifinalScheduledAt || null;
  if (finalScheduledAt !== undefined) tournament.finalScheduledAt = finalScheduledAt || null;
  if (breakBetweenQualRoundsMinutes !== undefined && breakBetweenQualRoundsMinutes !== null && breakBetweenQualRoundsMinutes !== '') tournament.breakBetweenQualRoundsMinutes = Number(breakBetweenQualRoundsMinutes);
  if (calculationBreakMinutes !== undefined && calculationBreakMinutes !== null && calculationBreakMinutes !== '') tournament.calculationBreakMinutes = Number(calculationBreakMinutes);
  if (delayToSemifinalMinutes !== undefined && delayToSemifinalMinutes !== null && delayToSemifinalMinutes !== '') tournament.delayToSemifinalMinutes = Number(delayToSemifinalMinutes);
  if (delayToFinalMinutes !== undefined && delayToFinalMinutes !== null && delayToFinalMinutes !== '') tournament.delayToFinalMinutes = Number(delayToFinalMinutes);
  if (prizesConfig) {
    tournament.prizesConfig = {
      place1VPLN: Number(prizesConfig.place1VPLN),
      place2VPLN: Number(prizesConfig.place2VPLN),
      place3VPLN: Number(prizesConfig.place3VPLN),
      place4to10VPLN: Number(prizesConfig.place4to10VPLN),
      configuredAt: new Date()
    };
  }
  await tournament.save();

  if (scheduledStartAt) {
    return setStartDate({ monthKey, scheduledStartAt, day2StartAt });
  }
  return tournament;
}

// Manual pause/resume of NEW ticket sales — see the salesPausedByAdmin comment in Tournament.js for
// why this is a separate lever from maxParticipants (can't go to 0) and registrationClosedAt
// (automatic). Toggleable any time the tournament is still SCHEDULED; a no-op has no side effects.
async function setSalesPaused(monthKey, paused) {
  if (!monthKey) throw new Error('monthKey is required');
  const tournament = await Tournament.findOne({ monthKey });
  if (!tournament) throw new Error(`No tournament found for ${monthKey}`);
  if (tournament.status !== 'SCHEDULED') {
    throw new Error(`Tournament for ${monthKey} is no longer accepting registrations (status: ${tournament.status})`);
  }
  tournament.salesPausedByAdmin = !!paused;
  await tournament.save();
  return tournament;
}

// Simplified 3-state view for player/admin-facing API responses ONLY — never stored. The real
// state machine (10 granular statuses) stays the single source of truth everywhere internally;
// this is purely a display mapping.
const ACTIVE_STATUSES = ['ROUND_1', 'BREAK_1', 'ROUND_2', 'PAUSE_DAY', 'ROUND_3', 'BREAK_2', 'ROUND_4', 'CALCULATION_BREAK'];
function toSimplifiedStatus(status) {
  if (status === 'SCHEDULED') return 'UPCOMING';
  if (status === 'COMPLETED') return 'COMPLETED';
  if (ACTIVE_STATUSES.includes(status)) return 'ACTIVE';
  return 'UNKNOWN';
}

/**
 * Sets (or updates, while still SCHEDULED) Round 1's start time "T" — completely separate action
 * from opening ticket sales above, so it can be called AFTER the pool has already sold out (the
 * exact workflow this was built for: open sales with just a ticket count, wait for it to fill,
 * THEN decide/announce when Round 1 actually starts). `day2StartAt` defaults to
 * `scheduledStartAt + 24h` if omitted.
 */
async function setStartDate({ monthKey, scheduledStartAt, day2StartAt }) {
  const startAt = new Date(scheduledStartAt);
  if (Number.isNaN(startAt.getTime())) throw new Error('invalid scheduledStartAt');
  const tournament = await Tournament.findOne({ monthKey });
  if (!tournament) throw new Error(`No tournament found for ${monthKey} — open ticket sales first (set maxParticipants).`);
  if (tournament.status !== 'SCHEDULED') {
    throw new Error(`Tournament for ${monthKey} is already past scheduling (status: ${tournament.status})`);
  }
  tournament.scheduledStartAt = startAt;
  tournament.day2StartAt = day2StartAt ? new Date(day2StartAt) : new Date(startAt.getTime() + 24 * 60 * 60 * 1000);
  await tournament.save();
  // Fires tryStartRound1 at (or immediately, if the date is already in the past — e.g. the pool
  // sold out a while ago and this call is the admin finally picking a date) — that function itself
  // re-checks the participant count, so this is safe to call whether or not the pool is full yet.
  armRegistrationCloseTimer(tournament);
  log(`Tournament ${monthKey}: start date set — Round 1 at ${tournament.scheduledStartAt.toISOString()}, Round 3 at ${tournament.day2StartAt.toISOString()}.`);
  return tournament;
}

/**
 * Admin action: end + fully reset a tournament back to "never configured" — deletes the Tournament
 * document outright (and any TournamentRoom rows it owns) and disarms its timer. Only allowed while
 * still SCHEDULED (nothing has actually started yet — no real game Rounds/players committed) so
 * this can never discard an in-progress or finished tournament's results. Ticket purchases made
 * against it are NOT refunded or un-registered — this only clears the tournament's OWN schedule/
 * roster state, exactly what "zakończ i zresetuj ustawienia turnieju" asks for.
 */
async function cancelTournament(monthKey) {
  const tournament = await Tournament.findOne({ monthKey });
  if (!tournament) throw new Error(`No tournament found for ${monthKey}.`);
  if (tournament.status !== 'SCHEDULED') {
    throw new Error(`Tournament for ${monthKey} already has rounds running or finished (status: ${tournament.status}) — cannot reset.`);
  }
  const key = String(tournament._id);
  const timer = armedTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    armedTimers.delete(key);
  }
  await TournamentRoom.deleteMany({ tournamentId: tournament._id }); // should be none yet at SCHEDULED, but tidy up regardless
  await Tournament.deleteOne({ _id: tournament._id });
  log(`Tournament ${monthKey} cancelled and reset (was ${tournament.participants.length} registered participants).`);
}

// --- Registration (called from the ticket-purchase success path in server.js) --------------------

/**
 * Registers a real, ticket-holding player as a Monthly Tournament participant. Best-effort/no-op
 * (never throws) if there's currently no SCHEDULED tournament still accepting registrations, or if
 * this user is already registered for it — the existing ticket system (see finalizeTicketOrder in
 * server.js) always succeeds independently of this; tournament registration is purely additive.
 *
 * Selling out the pool here ONLY closes registration (marks registrationClosedAt, stops accepting
 * more participants) — it does NOT itself start Round 1. That's a deliberate split: an admin can
 * open ticket sales with just a pool size and no start date yet (see scheduleTournament), let it
 * sell out, and only decide/announce "T" afterwards via setStartDate() — Round 1 only ever starts
 * once scheduledStartAt is set AND arrives (see armRegistrationCloseTimer/tryStartRound1), whether
 * that timer was armed before or after the pool actually filled up.
 */
async function registerParticipant(userId, ticketPurchasedAt) {
  try {
    const tournament = await Tournament.findOne({ status: 'SCHEDULED' }).sort({ createdAt: 1 });
    if (!tournament) {
      log(`No open tournament to register user ${userId} into (ticket purchase still succeeds independently).`);
      return null;
    }
    if (tournament.participants.some((p) => String(p.userId) === String(userId))) return tournament;
    if (tournament.participants.length >= tournament.maxParticipants) return tournament; // pool already full, shouldn't normally happen

    const user = await deps.User.findById(userId).select('username').lean();
    if (!user) return tournament;
    const username = user.username;

    tournament.participants.push({ userId, username, ticketPurchasedAt: ticketPurchasedAt || new Date() });
    if (tournament.participants.length >= tournament.maxParticipants && !tournament.registrationClosedAt) {
      tournament.registrationClosedAt = new Date();
      log(`Tournament ${tournament.monthKey}: ticket pool sold out (${tournament.participants.length}/${tournament.maxParticipants}). Waiting on a start date${tournament.scheduledStartAt ? ` (already set: ${tournament.scheduledStartAt.toISOString()})` : ' (none set yet)'}.`);
    }
    await tournament.save();
    log(`Registered ${username} for ${tournament.monthKey} (${tournament.participants.length}/${tournament.maxParticipants}).`);
    return tournament;
  } catch (err) {
    log('registerParticipant error', err);
    return null;
  }
}

// Arms (or re-arms, replacing any previous timer for this tournament) a timer that fires
// tryStartRound1 at tournament.scheduledStartAt — if that moment has already passed (e.g. the
// admin is only setting a date now, after the pool sold out a while ago), the delay just comes out
// to 0 and it fires on the next tick of the event loop instead of literally instantly, which is
// fine here.
function armRegistrationCloseTimer(tournament) {
  if (!tournament.scheduledStartAt) return; // nothing to arm yet — see setStartDate
  const key = String(tournament._id);
  const existing = armedTimers.get(key);
  if (existing) clearTimeout(existing);
  const delay = Math.max(0, tournament.scheduledStartAt.getTime() - Date.now());
  const timer = setTimeout(() => {
    tryStartRound1(tournament._id).catch((err) => log('tryStartRound1 error', err));
  }, delay);
  armedTimers.set(key, timer);
}

// --- Round 1 ---------------------------------------------------------------------------------------

async function tryStartRound1(tournamentId) {
  const tournament = await Tournament.findById(tournamentId);
  if (!tournament || tournament.status !== 'SCHEDULED') return;

  if (!tournament.registrationClosedAt) tournament.registrationClosedAt = new Date();

  if (tournament.participants.length !== tournament.maxParticipants) {
    // Starting with fewer than maxParticipants would leave some rooms short of the fixed
    // 10-per-room requirement assignPlayersToRooms() enforces. Rather than silently running a
    // broken/partial tournament, this logs loudly and leaves the tournament SCHEDULED — an admin
    // can lower maxParticipants to match how many actually registered, or wait for more sales and
    // call setStartDate() again with a later time.
    log(`Tournament ${tournament.monthKey}: only ${tournament.participants.length}/${tournament.maxParticipants} registered at start time T — NOT starting. Lower maxParticipants to match, or set a later start date.`);
    await tournament.save();
    return;
  }

  tournament.status = 'ROUND_1';
  tournament.round1StartedAt = new Date();
  await tournament.save();
  await startRound(tournament, 1);
}

// --- Running a round: create (maxParticipants/10) TournamentRooms + real, immediately-active
// game Rounds ---------------------------------------------------------------------------------

async function startRound(tournament, roundNumber) {
  const roomsPerRound = tournament.maxParticipants / PLAYERS_PER_ROOM;
  log(`Tournament ${tournament.monthKey}: starting Round ${roundNumber} (${roomsPerRound} rooms).`);
  // participants[] order (push order = ticket purchase order) is the deterministic input to
  // assignPlayersToRooms — never re-sorted, so re-deriving the same round's assignment later
  // (e.g. for an audit) always reproduces the exact same rooms.
  const orderedPlayers = tournament.participants.map((p) => ({ userId: String(p.userId), username: p.username }));
  const rooms = assignPlayersToRooms(orderedPlayers, roundNumber);

  for (let i = 0; i < roomsPerRound; i += 1) {
    const roomNumber = i + 1;
    const roomPlayers = rooms[i];
    const tournamentRoom = await TournamentRoom.create({
      tournamentId: tournament._id,
      roundNumber,
      roomNumber,
      players: roomPlayers.map((p) => ({ userId: p.userId, username: p.username })),
      status: 'PENDING'
    });
    await startRoundRoom(tournament, tournamentRoom, roomPlayers);
  }

  deps.io.emit('tournament:roundStarted', { monthKey: tournament.monthKey, roundNumber });
}

/**
 * Turns one PENDING TournamentRoom into a real, immediately-active game Round with exactly its 10
 * pre-assigned players — deliberately bypasses the normal queue-based Room.waitingPlayers/
 * performRoomJoin/startCountdown flow (players never "join" a Monthly Tournament room themselves;
 * the schedule places them automatically), reusing only the parts of that machinery that matter:
 * a real Room document to hang the Round off of, and gameSession.startSession to actually run it.
 */
async function startRoundRoom(tournament, tournamentRoom, roomPlayers) {
  const { Room, Round, User, gameSession } = deps;
  const users = await User.find({ _id: { $in: roomPlayers.map((p) => p.userId) } })
    .select('username isBot').lean();
  const usernameById = new Map(users.map((u) => [String(u._id), u.username]));
  // Real ticket-holders are never isBot on their User doc, so this is a no-op for every genuine
  // tournament — it only matters for isBot:true test/exhibition accounts, letting the existing
  // GameEngine.runBotAi drive them for real instead of sitting idle at 0 points all round.
  const isBotById = new Map(users.map((u) => [String(u._id), !!u.isBot]));

  const roomName = `Turniej Miesięczny ${tournament.monthKey} — Runda ${tournamentRoom.roundNumber} — Pokój ${tournamentRoom.roomNumber}`;
  const gameRoom = await Room.create({
    roomName,
    isTournament: true,
    tournamentStage: 'qualification',
    isPaused: false,
    roomType: 'standard',
    maxPlayers: PLAYERS_PER_ROOM,
    settings: { dlugoscRundySekundy: tournament.roundDurationMinutes * 60, modyfikatorCzasuEkonomii: 0, modyfikatorCzasuWojska: 0 }
  });

  const roundStartedAt = new Date();
  const roundEndsAt = new Date(roundStartedAt.getTime() + tournament.roundDurationMinutes * 60 * 1000);
  // Every existing GameEngine duration/rate constant is tuned for a 120-minute round (see
  // public/gameEngine.js's activeTimeScaleFactor docs) — this is the ONLY place that baseline is
  // applied, so a Monthly Tournament round set to e.g. 60 minutes runs at exactly half those
  // durations / double those rates, and a 120-minute one is untouched (factor 1).
  const timeScaleFactor = tournament.roundDurationMinutes / QUALIFICATION_ROUND_BASELINE_MINUTES;
  const round = await Round.create({
    roomId: gameRoom._id,
    roomName,
    roomType: 'standard',
    isTournament: true,
    entryFee: 0,
    settings: gameRoom.settings,
    status: 'active',
    poolPP: 0,
    roundStartedAt,
    roundEndsAt,
    timeScaleFactor,
    state: {}
  });

  // Same waitingPlayers shape gameSession.startSession/buildPlayerFromWaitingEntry expects from the
  // normal join flow — color assignment reuses simple round-robin by seat index since every one of
  // these 10 slots is filled from the start (no join-order race to resolve, unlike a normal queue).
  const PLAYER_COLORS = ['#3b82f6', '#ef4444', '#f59e0b', '#10b981', '#a78bfa', '#f472b6', '#06b6d4', '#8b5cf6', '#fb7185', '#f97316'];
  const waitingPlayers = roomPlayers.map((p, idx) => ({
    userId: p.userId,
    username: usernameById.get(p.userId) || p.username,
    isBot: !!isBotById.get(String(p.userId)),
    color: PLAYER_COLORS[idx % PLAYER_COLORS.length]
  }));

  await gameSession.startSession(round, waitingPlayers);
  deps.startRoundTimer(round._id.toString());

  tournamentRoom.gameRoomId = gameRoom._id;
  tournamentRoom.roundDbId = round._id;
  tournamentRoom.status = 'ACTIVE';
  await tournamentRoom.save();
}

// --- Round-finish hook (registered onto server.js's shared payoutRoundRewards call sites) --------

/**
 * Called by server.js right after payoutRoundRewards(round) for EVERY round that finishes, tournament
 * or not — first thing it does is check whether `round` actually belongs to a Monthly Tournament
 * room at all, and returns immediately (no-op) if not, so this is safe to register unconditionally.
 *
 * Reads the exact same combat/points stats payoutRoundRewards itself already reads —
 * `player.points` (village points, kept live by GameEngine.refreshAllPlayerPoints every tick) and
 * `player.killsAsAttacker` / `player.killsAsDefender` / `player.kills` (kept live by GameEngine.
 * creditKills — see public/gameEngine.js — every time a battle resolves in processActiveAttacks).
 * Nothing needed to change in the live game engine to support this: those counters already existed
 * and were already being correctly maintained per-player, per-round; this is simply the first place
 * anything actually persists them into a durable, cross-round-summed tournament ranking.
 *
 * Shared by all 3 stages (roundNumber 1-4 qualification, 5 semifinal, 6 final) for the
 * results-computation + COMPLETED bookkeeping; only the "what happens next" tail differs per stage.
 */
async function handleRoundFinished(round) {
  if (!deps) return null;
  const tournamentRoom = await TournamentRoom.findOne({ roundDbId: round._id, status: 'ACTIVE' });
  if (!tournamentRoom) return null; // not a Monthly Tournament room — nothing to do

  const { gameSession, User } = deps;
  const roundId = round._id.toString();
  const liveState = gameSession.getSession(roundId);
  const finalPlayers = liveState?.players || round.state?.players || [];
  const byId = new Map(finalPlayers.map((p) => [String(p.userId), p]));

  const roomPlayers = tournamentRoom.players.map((seat) => {
    const live = byId.get(String(seat.userId)) || {};
    return {
      userId: String(seat.userId),
      username: seat.username,
      points: Number(live.points) || 0,
      killsAsAttacker: Number(live.killsAsAttacker) || 0,
      killsAsDefender: Number(live.killsAsDefender) || 0,
      kills: Number(live.kills) || 0,
      // Captured for the fair tie-break cascade (tournamentScoring.compareByStatCascade) used by
      // the Final's payout and the Semifinal's advancement picks — never used by
      // computeRoomRoundResults itself, which doesn't need it.
      pointsAchievedAt: live.pointsAchievedAt || null,
      // Carried through to tournamentRoom.results so payoutFinalPrizes can exclude a forfeited
      // player from receiving a Final placement/prize entirely, instead of silently still ranking
      // and paying them on whatever frozen stats they had when they left.
      hasLeft: !!live.hasLeft
    };
  });

  const results = computeRoomRoundResults(roomPlayers);

  tournamentRoom.results = results.map((r) => {
    const src = roomPlayers.find((p) => p.userId === r.userId);
    return { ...r, points: src.points, killsAsAttacker: src.killsAsAttacker, killsAsDefender: src.killsAsDefender, kills: src.kills, pointsAchievedAt: src.pointsAchievedAt, hasLeft: src.hasLeft };
  });
  tournamentRoom.status = 'COMPLETED';
  await tournamentRoom.save();

  const tournamentDoc = await Tournament.findById(tournamentRoom.tournamentId).select('monthKey title prizesConfig');
  const monthKey = tournamentDoc ? tournamentDoc.monthKey : null;

  if (tournamentRoom.roundNumber <= 4) {
    // --- Qualification round (1-4): existing behavior, unchanged ---
    for (const r of tournamentRoom.results) {
      await Tournament.updateOne(
        { _id: tournamentRoom.tournamentId, 'participants.userId': r.userId },
        { $inc: { 'participants.$.totalTP': r.roundTP, 'participants.$.totalUnitsDestroyed': r.kills } }
      );
      // payoutRoundRewards() (which already ran, right before this hook fires — see
      // registerRoundFinishHook in server.js) unconditionally added this player's raw village
      // `points` into User.qualificationPoints for every isTournament round, including this one —
      // that's the OLD/simple accumulation the 3-category roundTP is meant to replace for Monthly
      // Tournament rounds specifically. Rather than touching that shared function (used by every
      // other kind of tournament room too, e.g. ad-hoc ones from admin-turnieje.html), this applies
      // a correction on top: -points (undo what it added) +roundTP (add what should have been
      // added), landing qualificationPoints exactly on sum-of-roundTP for these rounds while leaving
      // payoutRoundRewards itself, and every non-Monthly-Tournament room's accumulation, untouched.
      await User.updateOne({ _id: r.userId }, { $inc: { qualificationPoints: r.roundTP - r.points } });
    }
    deps.io.emit('tournament:roomFinished', { monthKey, roundNumber: tournamentRoom.roundNumber, roomNumber: tournamentRoom.roomNumber });
    await maybeAdvanceRound(tournamentRoom.tournamentId, tournamentRoom.roundNumber);
  } else if (tournamentRoom.roundNumber === 5) {
    // --- Semifinal room (one of the 4 permanent Półfinał rooms) finished ---
    deps.io.emit('tournament:roomFinished', { monthKey, roundNumber: tournamentRoom.roundNumber, roomNumber: tournamentRoom.roomNumber });
    await maybeAdvanceToFinal(tournamentRoom.tournamentId);
  } else if (tournamentRoom.roundNumber === 6) {
    // --- Final finished — tournament fully concluded. The Final round's own podium (village
    // points, same as any round) IS the tournament result; nothing further to auto-advance. Payout
    // happens BEFORE the completion broadcast so any client refreshing off tournament:completed
    // already sees updated balances/history.
    const prizeResults = await payoutFinalPrizes(tournamentRoom, tournamentDoc);
    deps.io.emit('tournament:completed', { monthKey, final: true });
    log(`Tournament ${monthKey}: FINAL complete.`);
    return prizeResults;
  }
  return null;
}

/**
 * Credits each of the 10 Final finishers the pre-set, guaranteed VPLN amount for their placement
 * and records one idempotent TournamentResults row per player. Skips entirely (no payout, no error)
 * if this edition's prizesConfig was never configured by an admin — a Final can technically finish
 * without prizes only if an admin scheduled/started it without ever setting them, which shouldn't
 * happen given the ticket-purchase guard in server.js, but this must never throw either way.
 *
 * Placement is re-derived here via tournamentScoring.compareByStatCascade('points') rather than
 * trusting `r.positionOverall` (computeRoomRoundResults' points-only sub-ranking) directly — that
 * ranking breaks an exact points tie by comparing account ids alphabetically, which would decide
 * real money by whoever's database id happens to sort first. A game of skill can't have its prize
 * money hinge on that (see regulamin.html §1a), so an exact points tie cascades through the other
 * combat stats (kills, killsAsAttacker, killsAsDefender) and then earliest pointsAchievedAt instead —
 * every level a real, explainable performance metric, never contaminating a genuine points lead.
 *
 * Per-player try/catch (not one try/catch around the whole loop) so one bad row — a genuine
 * duplicate-key hit on retry, or an unrelated per-player error — can never block the other 9 players
 * from getting paid. The audit row is inserted BEFORE the balance is credited: if the process dies
 * in between, the worst case is a recorded-but-uncredited row (recoverable), never a silently
 * double-credited balance on a retry.
 */
async function payoutFinalPrizes(tournamentRoom, tournamentDoc) {
  const prizes = tournamentDoc && tournamentDoc.prizesConfig;
  if (!prizes || !prizes.configuredAt) {
    log(`Tournament ${tournamentDoc ? tournamentDoc.monthKey : '?'}: FINAL complete but prizesConfig was never set — skipping payout.`);
    return null;
  }
  const { User } = deps;
  const amountForPlacement = (place) => {
    if (place === 1) return prizes.place1VPLN || 0;
    if (place === 2) return prizes.place2VPLN || 0;
    if (place === 3) return prizes.place3VPLN || 0;
    return prizes.place4to10VPLN || 0; // 4-10
  };

  // A player who forfeited (hasLeft) mid-Final, or whose account is banned by the time the Final
  // ends, is excluded entirely from the paid placements — not just "moved down" but removed from
  // consideration altogether, so the remaining eligible players shift up to fill the vacated spot
  // (e.g. if the true #1 left, the true #2 becomes #1 and is paid the 1st-place prize instead).
  // Found and fixed after an explicit check whether a banned/left player could still collect a
  // Final prize on frozen stats from before they left — they could, before this fix.
  const blockedUserIds = new Set(
    (await User.find({ _id: { $in: tournamentRoom.results.map((r) => r.userId) }, isBlocked: true }).select('_id')).map((u) => String(u._id))
  );
  const eligibleResults = tournamentRoom.results.filter((r) => !r.hasLeft && !blockedUserIds.has(String(r.userId)));

  const fairlyRanked = [...eligibleResults].sort(compareByStatCascade('points'));

  const prizeResults = [];
  for (let i = 0; i < fairlyRanked.length; i += 1) {
    const r = fairlyRanked[i];
    const placement = i + 1;
    const vplnAwarded = amountForPlacement(placement);
    if (vplnAwarded > 0) prizeResults.push({ placement, userId: r.userId, username: r.username, vplnAwarded });
    // Paid out at 100% gross — the Usługodawca is a private individual (osoba fizyczna
    // nieprowadząca działalności gospodarczej), not a registered "płatnik" under art. 41 ustawy o
    // PIT, and has no legal standing to withhold tax or file PIT-8AR. Full tax responsibility sits
    // with the winner (art. 20 ust. 1 ustawy o PIT — przychód z innych źródeł, self-reported on
    // their own annual PIT-37/PIT-36) — see regulamin.html §5b.
    try {
      await TournamentResults.create({
        tournamentId: tournamentDoc._id,
        monthKey: tournamentDoc.monthKey,
        userId: r.userId,
        username: r.username,
        placement,
        vplnAwarded
      });
      await User.updateOne({ _id: r.userId }, { $inc: { dogeBalance: vplnAwarded } });
    } catch (err) {
      if (err && err.code === 11000) {
        log(`Tournament ${tournamentDoc.monthKey}: payout for ${r.username} already recorded, skipping (idempotent).`);
        continue;
      }
      log(`Tournament ${tournamentDoc.monthKey}: FINAL prize payout error for ${r.username}: ${err.message}`);
    }
  }
  return prizeResults.length ? prizeResults : null;
}

/**
 * Shared by both auto-advance points (qualification -> semifinal, semifinal -> final): pushes
 * `players` (already-decided, pre-qualified — never gated by a ticket) straight into a permanent
 * bracket Room's waitingPlayers, and records the matching PENDING TournamentRoom bookkeeping row so
 * handleRoundFinished can find its way back once the round the admin eventually starts finishes.
 * Deliberately does NOT start the round itself — "admin ustala jedynie kiedy ma się odbyć [...]
 * półfinał i final" (the admin decides WHEN, the system decides WHO) — but if the room happens to
 * already be unpaused (e.g. the admin unpaused it ahead of time, before this stage's roster was
 * even known), starts it immediately since the queue is already full at that point.
 */
async function seedBracketRoom(roundNumber, roomNumber, tournament, room, players) {
  const tournamentRoom = await TournamentRoom.create({
    tournamentId: tournament._id,
    roundNumber,
    roomNumber,
    players: players.map((p) => ({ userId: p.userId, username: p.username })),
    status: 'PENDING',
    gameRoomId: room._id
  });
  // Same isBot passthrough as startRoundRoom (qualification rooms) - a no-op for every genuine
  // tournament (real ticket-holders are never isBot), only relevant for isBot:true test accounts.
  const users = await deps.User.find({ _id: { $in: players.map((p) => p.userId) } }).select('isBot').lean();
  const isBotById = new Map(users.map((u) => [String(u._id), !!u.isBot]));
  room.waitingPlayers = players.map((p) => ({ userId: p.userId, username: p.username, isBot: !!isBotById.get(String(p.userId)) }));
  await room.save();
  if (!room.isPaused && room.roomType === 'standard' && room.waitingPlayers.length >= room.maxPlayers) {
    deps.startCountdown(room._id.toString());
  }
  return tournamentRoom;
}

/**
 * Auto-seeds the 40 just-computed semifinalists (tournament.semifinalists — 35 qualification +
 * 5 free-server-ranking, see finalizeQualifications) into the 4 permanent semifinal rooms, 10 each,
 * simple round-robin (semifinalists[i] -> room[i % 4]) so ranked-1 and ranked-2 never land in the
 * same room together. Guarded against re-running (e.g. a restart) by checking no roundNumber:5
 * TournamentRoom rows exist yet for this tournament.
 */
async function seedSemifinalRooms(tournament) {
  const already = await TournamentRoom.countDocuments({ tournamentId: tournament._id, roundNumber: 5 });
  if (already > 0) {
    log(`seedSemifinalRooms: ${tournament.monthKey} already seeded — skipping.`);
    return;
  }
  const rooms = await deps.Room.find({ isTournament: true, tournamentStage: 'semifinal' }).sort({ roomName: 1 });
  if (rooms.length !== 4) {
    log(`seedSemifinalRooms: expected 4 semifinal rooms, found ${rooms.length} — cannot auto-seed ${tournament.monthKey}.`);
    return;
  }
  const groups = [[], [], [], []];
  tournament.semifinalists.forEach((p, i) => groups[i % 4].push({ userId: p.userId, username: p.username }));
  for (let i = 0; i < 4; i += 1) {
    await seedBracketRoom(5, i + 1, tournament, rooms[i], groups[i]);
  }
  log(`Tournament ${tournament.monthKey}: auto-seeded ${tournament.semifinalists.length} semifinalists into the 4 semifinal rooms.`);
}

/**
 * Once all 4 semifinal rooms have COMPLETED for this tournament, picks the 10 finalists exactly per
 * the spec: the top 2 (by village points, i.e. positionOverall 1 and 2) from EACH of the 4 rooms
 * (8 players) + the single best aggressor (highest killsAsAttacker) across all 4 rooms not already
 * picked + the single best defender (highest killsAsDefender) across all 4 rooms not already picked
 * — then auto-seeds them into the permanent Final room the exact same way. Guarded against
 * re-running by checking no roundNumber:6 TournamentRoom exists yet for this tournament.
 */
async function maybeAdvanceToFinal(tournamentId) {
  const stillRunning = await TournamentRoom.countDocuments({ tournamentId, roundNumber: 5, status: { $ne: 'COMPLETED' } });
  if (stillRunning > 0) return; // not all 4 semifinal rooms are done yet

  // Atomic claim — same TOCTOU class as maybeAdvanceRound's race, just with N=4 concurrent semifinal
  // rooms instead of N=35 qualification ones. semifinalCompletedAt starts null and is only ever set
  // once; whichever of the (up to 4) concurrent handleRoundFinished() calls wins this update is the
  // only one that proceeds to pick finalists and seed the Final room.
  const claimed = await Tournament.findOneAndUpdate(
    { _id: tournamentId, semifinalCompletedAt: null },
    { $set: { semifinalCompletedAt: new Date() } },
    { new: true }
  );
  if (!claimed) return; // another concurrent call already claimed this transition

  const alreadyFinal = await TournamentRoom.countDocuments({ tournamentId, roundNumber: 6 });
  if (alreadyFinal > 0) return; // already seeded (or an admin already started the final by hand)

  const semifinalRooms = await TournamentRoom.find({ tournamentId, roundNumber: 5 }).sort({ roomNumber: 1 });
  if (semifinalRooms.length !== 4) {
    log(`maybeAdvanceToFinal: expected 4 completed semifinal rooms, found ${semifinalRooms.length} — cannot pick finalists.`);
    return;
  }

  const allResults = semifinalRooms.flatMap((room) => room.results.map((r) => r.toObject ? r.toObject() : r));
  const finalistIds = new Set();
  const finalists = [];

  // 1) Top 2 per room by village points. Sorted here via compareByStatCascade('points') rather
  // than trusting the room's own stored positionOverall (computeRoomRoundResults' points-only
  // sub-ranking, which breaks an exact tie by comparing account ids) — advancing to the Final is
  // exactly the kind of decision that must never hinge on that (see regulamin.html §1a).
  semifinalRooms.forEach((room) => {
    const roomResults = room.results.map((r) => r.toObject ? r.toObject() : r);
    [...roomResults]
      .sort(compareByStatCascade('points'))
      .slice(0, 2)
      .forEach((r) => {
        finalistIds.add(String(r.userId));
        finalists.push({ userId: r.userId, username: r.username });
      });
  });

  // 2) + 3) Best aggressor, then best defender, across ALL 4 rooms — each excludes whoever's
  // already been picked so far, guaranteeing exactly 10 distinct finalists (never a repeat seat).
  // Same fair cascade as above instead of an account-id tiebreak.
  const pickBest = (statKey) => {
    const candidates = allResults
      .filter((r) => !finalistIds.has(String(r.userId)))
      .sort(compareByStatCascade(statKey));
    return candidates[0] || null;
  };
  const aggressor = pickBest('killsAsAttacker');
  if (aggressor) { finalistIds.add(String(aggressor.userId)); finalists.push({ userId: aggressor.userId, username: aggressor.username }); }
  const defender = pickBest('killsAsDefender');
  if (defender) { finalistIds.add(String(defender.userId)); finalists.push({ userId: defender.userId, username: defender.username }); }

  const finalRoom = await deps.Room.findOne({ isTournament: true, tournamentStage: 'final' });
  if (!finalRoom) {
    log(`maybeAdvanceToFinal: no final room found — cannot seat ${finalists.length} finalists for ${claimed.monthKey}.`);
    return;
  }

  await seedBracketRoom(6, 1, claimed, finalRoom, finalists);
  deps.io.emit('tournament:completed', { monthKey: claimed.monthKey, finalistCount: finalists.length, stage: 'final-seeded' });
  log(`Tournament ${claimed.monthKey}: ${finalists.length} finalists auto-seeded into the Final room.`);

  // Fully-automatic final start — no admin action required, per the tournament's own configured
  // delay (0 = start as soon as the final room is seeded). semifinalCompletedAt (already claimed
  // atomically above) is the durable anchor resumeInFlightTournaments() re-arms this timer against
  // after a server restart.
  const finalDelayMs = (claimed.delayToFinalMinutes ?? 0) * 60 * 1000;
  scheduleAt(claimed.semifinalCompletedAt.getTime() + finalDelayMs, () => autoStartBracketStage(claimed._id, 6));
}

/**
 * Called from src/server.js's startCountdown() the moment it creates a real Round for a room whose
 * tournamentStage is semifinal/final — bridges that freshly-created Round back to the PENDING
 * TournamentRoom bookkeeping row seedBracketRoom() left waiting for it, so handleRoundFinished()
 * can find it again once this round finishes. No-op (returns null) for any other room, so this is
 * safe for startCountdown to call unconditionally on every tournament-stage room.
 */
async function linkBracketRound(roomId, roundId) {
  const tournamentRoom = await TournamentRoom.findOne({ gameRoomId: roomId, status: 'PENDING' }).sort({ createdAt: -1 });
  if (!tournamentRoom) return null;
  tournamentRoom.roundDbId = roundId;
  tournamentRoom.status = 'ACTIVE';
  await tournamentRoom.save();
  return tournamentRoom;
}

/** Once every one of a round's 35 TournamentRooms is COMPLETED, advance the state machine. */
async function maybeAdvanceRound(tournamentId, roundNumber) {
  const stillRunning = await TournamentRoom.countDocuments({
    tournamentId, roundNumber, status: { $ne: 'COMPLETED' }
  });
  if (stillRunning > 0) return;

  // Atomic claim against the race where all N rooms of a round finish within the same instant:
  // handleRoundFinished() fires once per room, so up to N concurrent calls can all pass the
  // stillRunning check above before any of them has actually transitioned the tournament's status.
  // Found via the 350-bot Monthly Tournament load test (2026-08-24): with N=35 qualification rooms
  // this raced constantly, causing finalizeQualifications() to fire many times concurrently — most
  // attempts then failed on Tournament.save()'s version check or a duplicate FreeServerRanking key,
  // and since neither failure was ever guaranteed to land on the one attempt that also reached
  // seedSemifinalRooms(), the semifinal stage could end up never seeded at all. The conditional
  // findOneAndUpdate below (status must still match this round's own in-progress value) ensures only
  // the FIRST caller to reach here actually advances the tournament — every other concurrent caller
  // gets null back and returns as a safe no-op.
  const now = new Date();
  const statusUpdateByRound = {
    1: { round1EndedAt: now, status: 'BREAK_1' },
    2: { round2EndedAt: now, status: 'PAUSE_DAY' },
    3: { round3EndedAt: now, status: 'BREAK_2' },
    4: { round4EndedAt: now, status: 'CALCULATION_BREAK' }
  };
  const update = statusUpdateByRound[roundNumber];
  if (!update) return;

  const tournament = await Tournament.findOneAndUpdate(
    { _id: tournamentId, status: `ROUND_${roundNumber}` },
    { $set: update },
    { new: true }
  );
  if (!tournament) return; // another concurrent call already advanced this round

  const breakMs = (tournament.breakBetweenQualRoundsMinutes ?? DEFAULT_BREAK_MINUTES) * 60 * 1000;
  const calculationBreakMs = (tournament.calculationBreakMinutes ?? DEFAULT_CALCULATION_BREAK_MINUTES) * 60 * 1000;

  if (roundNumber === 1) {
    scheduleAt(now.getTime() + breakMs, () => runNextRound(tournamentId, 2, 'ROUND_2'));
  } else if (roundNumber === 2) {
    // Round 3 fires at the tournament's own day2StartAt (day 2, same clock time T) rather than a
    // fixed offset from when Round 2 happened to finish — matches "Start kolejnego dnia o
    // ustalonej godzinie T" in the spec exactly, regardless of how long Round 2 actually ran.
    const delay = Math.max(0, tournament.day2StartAt.getTime() - Date.now());
    scheduleAt(Date.now() + delay, () => runNextRound(tournamentId, 3, 'ROUND_3'));
  } else if (roundNumber === 3) {
    scheduleAt(now.getTime() + breakMs, () => runNextRound(tournamentId, 4, 'ROUND_4'));
  } else if (roundNumber === 4) {
    scheduleAt(now.getTime() + calculationBreakMs, () => finalizeQualifications(tournamentId));
  }
}

function scheduleAt(timestampMs, fn) {
  const delay = Math.max(0, timestampMs - Date.now());
  setTimeout(() => fn().catch((err) => log('scheduled transition error', err)), delay);
}

async function runNextRound(tournamentId, roundNumber, statusName) {
  const tournament = await Tournament.findById(tournamentId);
  if (!tournament) return;
  tournament.status = statusName;
  tournament[`round${roundNumber}StartedAt`] = new Date();
  await tournament.save();
  await startRound(tournament, roundNumber);
}

// --- Semifinal selection: Top 35 (this tournament's qualification ranking) + Top 5 (Free Server) --

async function finalizeQualifications(tournamentId) {
  const { User, currentMonthKey, maybeGrantRegularRoundsMmrReward, getMmrWindowLeaderboard } = deps;
  const tournament = await Tournament.findById(tournamentId);
  if (!tournament) return;

  // Freezes the Free-Server-Ranking Top 5 as direct semifinal passes NOW (qualifications just
  // finished) instead of waiting on ticket-pool exhaustion, which is a separate, unrelated trigger
  // that may never fire in a month where the pool doesn't sell out. Idempotent (month-key guarded).
  await maybeGrantRegularRoundsMmrReward();
  const monthKey = currentMonthKey();

  // This tournament's own Top 35, using the full deterministic tie-break chain from
  // src/tournamentScoring.js (Total_TP -> total units destroyed -> earliest ticket purchase).
  const { compareForFinalRanking } = require('./tournamentScoring');
  const fullyRanked = tournament.participants
    .map((p) => ({ userId: p.userId, username: p.username, totalTP: p.totalTP, totalUnitsDestroyed: p.totalUnitsDestroyed, ticketPurchasedAt: p.ticketPurchasedAt }))
    .sort(compareForFinalRanking);
  const ranked = fullyRanked.slice(0, QUALIFICATION_SEMIFINAL_SLOTS);
  const rankedUserIds = new Set(ranked.map((p) => String(p.userId)));

  // Free-Server-Ranking Top 5 (whole ranking fetched, not just top 5 — see cascade below) with
  // usernames resolved to userIds up front so the cascade can check each candidate against
  // rankedUserIds by userId (usernames alone aren't a safe identity check).
  const freeServerLeaderboardFull = (await getMmrWindowLeaderboard(1000)).filter((e) => !e.isBot && e.gained > 0);
  const freeServerUsers = await User.find({ username: { $in: freeServerLeaderboardFull.map((e) => e.username) } }).select('username').lean();
  const usernameToId = new Map(freeServerUsers.map((u) => [u.username, u._id]));

  // Cascade / fall-back: a Free-Server-Ranking Top-5 player who ALREADY secured a semifinal seat
  // via the ticket/qualification path (rank 1-35 above) never occupies a wildcard slot too — the
  // wildcard passes to the next-ranked free-ranking player (6th, 7th, ...) instead, until 5 genuine
  // (non-duplicate) wildcard seats are filled or the free-ranking pool runs out.
  const freeServerWildcards = [];
  for (const entry of freeServerLeaderboardFull) {
    if (freeServerWildcards.length >= FREE_SERVER_SEMIFINAL_SLOTS) break;
    const userId = usernameToId.get(entry.username);
    if (!userId || rankedUserIds.has(String(userId))) continue; // already has a qualification seat
    freeServerWildcards.push({ username: entry.username, gained: entry.gained, userId });
  }

  // A month with fewer than 5 eligible Free-Server-Ranking wildcards (or none at all) must never
  // leave a semifinal room short of its 10-player auto-start threshold — seedSemifinalRooms'
  // round-robin split relies on exactly 40 semifinalists, and autoStartBracketStage's timer only
  // ever fires once (no retry), so an under-filled room would silently never auto-start. Backfill
  // the shortfall with the next-best qualifiers (rank 36+) straight off this tournament's own ranking.
  const wildcardShortfall = FREE_SERVER_SEMIFINAL_SLOTS - freeServerWildcards.length;
  const backfill = wildcardShortfall > 0 ? fullyRanked.slice(QUALIFICATION_SEMIFINAL_SLOTS, QUALIFICATION_SEMIFINAL_SLOTS + wildcardShortfall) : [];

  // The Top 5 above are now permanently locked in as this month's semifinal wildcards. Reset the
  // live counter to 0 for everyone right now (keeping regularRoundsMmrPointsMonthKey unchanged, so
  // payoutRoundRewards' own monthKey-match check still just adds onto this 0 for the rest of the
  // month rather than treating it as a new month) — this starts a clean, clearly-visible "second
  // window" for the separate flat-VPLN consolation prize paid at calendar month-end (see
  // grantFreeRankingConsolationPrize in server.js) covering the trailing days between now and
  // month-end. Without this, points already spent on winning the wildcard above would silently
  // carry over and double-count toward that second, distinct reward.
  await User.updateMany({ regularRoundsMmrPointsMonthKey: monthKey }, { $set: { regularRoundsMmrPoints: 0 } });

  tournament.semifinalists = [
    ...ranked.map((p, i) => ({ userId: p.userId, username: p.username, source: 'qualification', rank: i + 1 })),
    ...freeServerWildcards.map((e, i) => ({ userId: e.userId, username: e.username, source: 'freeServerRanking', rank: i + 1 })),
    ...backfill.map((p, i) => ({ userId: p.userId, username: p.username, source: 'qualification', rank: QUALIFICATION_SEMIFINAL_SLOTS + i + 1 }))
  ];
  tournament.status = 'COMPLETED';
  tournament.resultsAnnouncedAt = new Date();
  await tournament.save();

  await FreeServerRanking.create({
    monthKey,
    tournamentId: tournament._id,
    entries: freeServerWildcards.map((e, i) => ({ userId: e.userId, username: e.username, rank: i + 1, pointsGained: e.gained }))
  });

  deps.io.emit('tournament:completed', { monthKey: tournament.monthKey, semifinalistCount: tournament.semifinalists.length });
  log(`Tournament ${tournament.monthKey} COMPLETED — ${tournament.semifinalists.length} semifinalists computed.`);

  await seedSemifinalRooms(tournament);

  // Fully-automatic semifinal start — no admin action required, per the tournament's own
  // configured delay (0 = start as soon as the rooms are seeded).
  const semifinalDelayMs = (tournament.delayToSemifinalMinutes ?? 0) * 60 * 1000;
  scheduleAt(tournament.resultsAnnouncedAt.getTime() + semifinalDelayMs, () => autoStartBracketStage(tournament._id, 5));
}

// --- Startup resume (server restart mid-tournament) -----------------------------------------------

/**
 * On boot, re-arms whatever timer the current Tournament state needs — a plain in-memory
 * setTimeout (as used throughout this module) doesn't survive a server restart, so without this a
 * tournament that was mid-BREAK_1 (say) when the process restarted would just silently stall
 * forever. Rounds already ACTIVE don't need special handling here: their underlying game Rounds
 * are resumed by the server's own existing restoreActiveRoundTimers(), and this module's
 * handleRoundFinished() hook fires exactly the same way for them whenever they do finish.
 */
async function resumeInFlightTournaments() {
  const openTournaments = await Tournament.find({ status: { $nin: ['COMPLETED'] } });
  for (const tournament of openTournaments) {
    const breakMs = (tournament.breakBetweenQualRoundsMinutes ?? DEFAULT_BREAK_MINUTES) * 60 * 1000;
    const calculationBreakMs = (tournament.calculationBreakMinutes ?? DEFAULT_CALCULATION_BREAK_MINUTES) * 60 * 1000;
    switch (tournament.status) {
      case 'SCHEDULED':
        armRegistrationCloseTimer(tournament);
        break;
      case 'BREAK_1':
        scheduleAt(tournament.round1EndedAt.getTime() + breakMs, () => runNextRound(tournament._id, 2, 'ROUND_2'));
        break;
      case 'PAUSE_DAY':
        scheduleAt(tournament.day2StartAt.getTime(), () => runNextRound(tournament._id, 3, 'ROUND_3'));
        break;
      case 'BREAK_2':
        scheduleAt(tournament.round3EndedAt.getTime() + breakMs, () => runNextRound(tournament._id, 4, 'ROUND_4'));
        break;
      case 'CALCULATION_BREAK':
        scheduleAt(tournament.round4EndedAt.getTime() + calculationBreakMs, () => finalizeQualifications(tournament._id));
        break;
      // ROUND_1..ROUND_4: nothing to re-arm here — see docstring above.
      default:
        break;
    }
  }

  // Bracket-stage auto-start timers (semifinal/final) stay armed while status is still COMPLETED
  // (qualification finishing doesn't change Tournament.status further — see toSimplifiedStatus),
  // so they need their own pass across EVERY tournament, not just the non-COMPLETED ones above.
  const tournamentsWithResults = await Tournament.find({ resultsAnnouncedAt: { $ne: null } });
  for (const tournament of tournamentsWithResults) {
    const pendingSemifinalRooms = await TournamentRoom.countDocuments({ tournamentId: tournament._id, roundNumber: 5, status: 'PENDING' });
    if (pendingSemifinalRooms > 0) {
      const delayMs = (tournament.delayToSemifinalMinutes ?? 0) * 60 * 1000;
      scheduleAt(tournament.resultsAnnouncedAt.getTime() + delayMs, () => autoStartBracketStage(tournament._id, 5));
    }
    if (tournament.semifinalCompletedAt) {
      const pendingFinalRooms = await TournamentRoom.countDocuments({ tournamentId: tournament._id, roundNumber: 6, status: 'PENDING' });
      if (pendingFinalRooms > 0) {
        const delayMs = (tournament.delayToFinalMinutes ?? 0) * 60 * 1000;
        scheduleAt(tournament.semifinalCompletedAt.getTime() + delayMs, () => autoStartBracketStage(tournament._id, 6));
      }
    }
  }
}

/**
 * Programmatic equivalent of an admin manually unpausing a permanent semifinal/final Room via
 * PUT /api/rooms/:id/pause (server.js) — same isPaused flip + startCountdown trigger, just called
 * from a timer instead of the admin API. Idempotent: only acts on TournamentRooms still PENDING
 * with their underlying Room still paused, so re-running it (e.g. after a restart re-arms the
 * timer) is always safe.
 */
async function autoStartBracketStage(tournamentId, roundNumber) {
  const pendingRooms = await TournamentRoom.find({ tournamentId, roundNumber, status: 'PENDING' });
  for (const tournamentRoom of pendingRooms) {
    const room = await deps.Room.findById(tournamentRoom.gameRoomId);
    if (!room || !room.isPaused) continue;
    room.isPaused = false;
    await room.save();
    if (room.roomType === 'standard' && room.waitingPlayers.length >= room.maxPlayers) {
      deps.startCountdown(room._id.toString());
    }
  }
}

// --- Read-only accessors for API endpoints (see server.js) ----------------------------------------

async function getCurrentTournament() {
  // Sorted by createdAt (always set) rather than scheduledStartAt, which can be null for a
  // tournament whose ticket pool is open but hasn't had a start date set yet (see setStartDate).
  const active = await Tournament.findOne({ status: { $ne: 'COMPLETED' } }).sort({ createdAt: -1 });
  if (active) return active;

  // finalizeQualifications() sets status to COMPLETED the moment qualifications end, but the
  // semifinal and final bracket stages only START at that point (auto-started minutes/hours later,
  // see autoStartBracketStage) - excluding COMPLETED entirely would make every caller of this
  // function (the admin rooms panel, GET /api/tournament/my-room, /tile, /my-status, /leaderboard)
  // go completely blind to the bracket stages for their whole duration, right when semifinalists and
  // finalists most need to find their room. Fall back to the most recently completed tournament as
  // long as its Final hasn't actually finished yet (or hasn't been seeded at all yet, meaning the
  // semifinal itself is still in progress).
  const recentCompleted = await Tournament.findOne({ status: 'COMPLETED' }).sort({ resultsAnnouncedAt: -1 });
  if (!recentCompleted) return null;
  const finalRoom = await TournamentRoom.findOne({ tournamentId: recentCompleted._id, roundNumber: 6 });
  if (finalRoom && finalRoom.status === 'COMPLETED') return null;
  return recentCompleted;
}

async function getMyRoom(userId) {
  const tournament = await getCurrentTournament();
  if (!tournament) return null;
  const room = await TournamentRoom.findOne({
    tournamentId: tournament._id,
    'players.userId': userId
  }).sort({ roundNumber: -1 });
  if (!room) return null;
  return { tournament, room };
}

/** Full participant roster of a given (or, if omitted, the current) tournament — admin panel view. */
async function getParticipants(tournamentId) {
  const tournament = tournamentId ? await Tournament.findById(tournamentId) : await getCurrentTournament();
  if (!tournament) return { tournament: null, participants: [] };
  // Sorted by running Total_TP for a quick "who's currently leading" glance — the participants
  // array itself stays in registration order (that's the deterministic assignPlayersToRooms input,
  // see startRound), this is purely a display-order copy.
  const participants = tournament.participants.slice().sort((a, b) => b.totalTP - a.totalTP);
  return { tournament, participants };
}

/** All TournamentRooms for one round of a given (or current) tournament — admin panel view, same
 * shape of information admins already get for regular/ad-hoc tournament rounds via
 * admin-turnieje.html's room tiles (who's in it, live status, final per-room results once done). */
async function getRoundRooms(roundNumber, tournamentId) {
  const tournament = tournamentId ? await Tournament.findById(tournamentId) : await getCurrentTournament();
  if (!tournament) return { tournament: null, rooms: [] };
  const rooms = await TournamentRoom.find({ tournamentId: tournament._id, roundNumber: Number(roundNumber) }).sort({ roomNumber: 1 });
  return { tournament, rooms };
}

module.exports = {
  init,
  scheduleTournament,
  setStartDate,
  setSalesPaused,
  cancelTournament,
  registerParticipant,
  getCurrentTournament,
  getMyRoom,
  getParticipants,
  getRoundRooms,
  linkBracketRound,
  seedSemifinalRooms,
  maybeAdvanceToFinal,
  toSimplifiedStatus,
  QUALIFICATION_SEMIFINAL_SLOTS,
  FREE_SERVER_SEMIFINAL_SLOTS,
  QUALIFICATION_ROUND_BASELINE_MINUTES
};
