require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const User = require('./models/User');
const Room = require('./models/Room');
const Round = require('./models/Round');
const { Settings, getSettings } = require('./models/Settings');
const MultiAccountIncident = require('./models/MultiAccountIncident');
const MatchPairStat = require('./models/MatchPairStat');
const BlockConversation = require('./models/BlockConversation');
const GlobalChatMessage = require('./models/GlobalChatMessage');
const NewsItem = require('./models/NewsItem');
const TeamMapLayout = require('./models/TeamMapLayout');
const TicketOrder = require('./models/TicketOrder');
const MiniTournamentTicketOrder = require('./models/MiniTournamentTicketOrder');
const MiniTournamentResults = require('./models/MiniTournamentResults');
const ReferralReward = require('./models/ReferralReward');
const AdminVplnGrant = require('./models/AdminVplnGrant');
const WithdrawalRequest = require('./models/WithdrawalRequest');
const DogeTransaction = require('./models/DogeTransaction');
const doge = require('./doge');
const TournamentResults = require('./models/TournamentResults');
const Tournament = require('./models/Tournament');
const TournamentRoom = require('./models/TournamentRoom');
const FreeRankingConsolationResults = require('./models/FreeRankingConsolationResults');
const GameEngine = require('../public/gameEngine.js');
const gameSession = require('./gameSession');
const hotpay = require('./hotpay');
const multer = require('multer');
const tournamentEngine = require('./tournamentEngine');
const { computeRoomRoundResultsForAnyCount } = require('./tournamentScoring');

const app = express();

// Express 4 nie przechwytuje bledow z funkcji async - odrzucona obietnica (np. CastError przy
// /api/game/state?roundId=zly-id) konczyla CALY proces serwera. Kazda trasa przekazuje teraz blad
// do obslugi bledow na koncu (odpowiedz 400/500), a serwer dziala dalej.
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const register = app[method].bind(app);
  app[method] = (path, ...handlers) => {
    if (!handlers.length) return register(path); // app.get('ustawienie')
    return register(path, ...handlers.map((handler) => (typeof handler !== 'function' || handler.length > 3 ? handler : (req, res, next) => {
      try {
        const result = handler(req, res, next);
        if (result && typeof result.catch === 'function') result.catch(next);
      } catch (err) {
        next(err);
      }
    })));
  };
}
// Wersja demo dla jury: dostep tylko z linku z kluczem (INVITE_TOKEN w .env) - patrz src/inviteGate.js.
app.use(require('./inviteGate')(process.env.INVITE_TOKEN));
app.use(cors());
app.use(express.json());
// Tlumaczenie komunikatow (error/message) wg jezyka gracza - ciasteczko wol_lang, domyslnie polski.
const i18n = require('./i18n');
app.use(i18n.expressMiddleware);
// Deployed behind ngrok (see [[project-warlord-blitz]]) — without trust proxy, req.ip would always
// resolve to the local tunnel agent's address instead of the real visitor, breaking the multi-account
// IP-history check below (every remote player would look like they share one IP).
app.set('trust proxy', true);
// Parses HotPay's notification POST — express.json() above only handles application/json, so
// without this the webhook route would see an empty req.body no matter what HotPay actually sent.
// HotPay's own docs just say "POST typu form-data" without pinning down multipart/form-data vs.
// application/x-www-form-urlencoded (PHP's $_POST transparently handles either, which is likely why
// their docs don't distinguish) — both parsers are chained so whichever Content-Type HotPay
// actually sends is the one that populates req.body; the other silently no-ops since Content-Type
// won't match it.
const hotpayNotifyParser = [express.urlencoded({ extended: true }), multer().none()];

// Runs automatically for every route with a `:paramName` matching one of these, regardless of
// which handler registers it (Express app.param semantics) — rejects a malformed id with a clean
// 400 instead of letting an invalid string reach Mongoose and blow up as an uncaught CastError
// (500 + a raw stack trace). Found via a malformed manual request to /api/rooms/:id during the
// 350-bot Monthly Tournament load test (2026-08-24) — the literal, un-interpolated placeholder
// string was sent as the id, which is exactly the kind of input this should turn into a normal
// 400 for. Deliberately excludes non-ObjectId path params like :monthKey (a plain "YYYY-MM" string).
function validateObjectIdParam(paramName) {
  return (req, res, next, value) => {
    if (!mongoose.Types.ObjectId.isValid(value)) {
      return res.status(400).json({ error: `Nieprawidłowy identyfikator (${paramName}).` });
    }
    next();
  };
}
['id', 'userId', 'orderId', 'tournamentRoomId'].forEach((paramName) => {
  app.param(paramName, validateObjectIdParam(paramName));
});

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip;
}

function getSocketIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return socket.handshake.address;
}

const LOGIN_HISTORY_MAX = 50;
const MULTIACCOUNT_IP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 dni

async function pushLoginHistory(user, ip, deviceId) {
  user.loginHistory = user.loginHistory || [];
  user.loginHistory.unshift({ ip: ip || null, deviceId: deviceId || null, at: new Date() });
  if (user.loginHistory.length > LOGIN_HISTORY_MAX) user.loginHistory.length = LOGIN_HISTORY_MAX;
  await user.save();
}

// --- Rejestracja: limity nazwy użytkownika i hasła ------------------------------------------------
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 16;
const USERNAME_MAX_SPACES = 2;
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 20;

// Shared by every registration endpoint (both the current /api/auth/register and the legacy
// /api/register) so the limits can never be bypassed by hitting the older route directly. Returns
// a Polish error message string, or null if everything is valid. Does not touch the database.
function validateUsernameAndPassword(rawUsername, password) {
  if (!rawUsername || !password) return 'Wymagane pola: nazwa użytkownika i hasło.';
  const username = String(rawUsername).trim();
  if (username.length < USERNAME_MIN_LENGTH) return `Nazwa użytkownika musi mieć co najmniej ${USERNAME_MIN_LENGTH} znaki.`;
  if (username.length > USERNAME_MAX_LENGTH) return `Nazwa użytkownika może mieć maksymalnie ${USERNAME_MAX_LENGTH} znaków.`;
  const spaceCount = (username.match(/ /g) || []).length;
  if (spaceCount > USERNAME_MAX_SPACES) return `Nazwa użytkownika może zawierać maksymalnie ${USERNAME_MAX_SPACES} spacje.`;
  if (password.length < PASSWORD_MIN_LENGTH) return `Hasło musi mieć co najmniej ${PASSWORD_MIN_LENGTH} znaków.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Hasło może mieć maksymalnie ${PASSWORD_MAX_LENGTH} znaków.`;
  return null;
}

// --- Logowanie: blokada konta po nieudanych próbach -----------------------------------------------
// Every 3rd consecutive wrong-password attempt escalates to the next tier below, each with a longer
// cooldown; the 3rd tier repeats for any further escalation (4th+ group of 3 failures also gets 24h,
// not something longer — no tier beyond this was specified). A successful login always resets the
// counter and any active lockout back to zero, exactly like a normal brute-force-lockout scheme.
const LOGIN_ATTEMPTS_PER_TIER = 3;
const LOGIN_LOCKOUT_DURATIONS_MS = [30 * 1000, 30 * 60 * 1000, 24 * 60 * 60 * 1000];

function formatLockoutDuration(ms) {
  if (ms < 60 * 1000) return `${Math.ceil(ms / 1000)} sekund`;
  if (ms < 60 * 60 * 1000) return `${Math.ceil(ms / (60 * 1000))} minut`;
  return `${Math.ceil(ms / (60 * 60 * 1000))} godzin`;
}

// Shared by every login endpoint (both /api/auth/login and the legacy /api/login) — looks up the
// user, checks/enforces the lockout, verifies the password, and records the outcome (increment +
// maybe lock on failure; full reset on success). Returns { status, error } on any failure (400 for
// plain wrong credentials, 423 Locked while a cooldown is active or was just triggered), or
// { user } on success — callers still do their own pushLoginHistory/JWT-issuing/response shaping.
async function attemptLogin(rawUsername, password) {
  if (!rawUsername || !password) return { status: 400, error: 'missing fields' };
  const user = await User.findOne({ username: rawUsername });
  if (!user) return { status: 400, error: 'invalid credentials' };

  const now = new Date();
  if (user.loginLockedUntil && user.loginLockedUntil > now) {
    const remaining = formatLockoutDuration(user.loginLockedUntil.getTime() - now.getTime());
    return { status: 423, error: `Konto tymczasowo zablokowane po zbyt wielu nieudanych próbach logowania. Spróbuj ponownie za ${remaining}.` };
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const attempts = (user.failedLoginAttempts || 0) + 1;
    const update = { failedLoginAttempts: attempts };
    let justLockedFor = null;
    if (attempts % LOGIN_ATTEMPTS_PER_TIER === 0) {
      const tier = Math.min(attempts / LOGIN_ATTEMPTS_PER_TIER, LOGIN_LOCKOUT_DURATIONS_MS.length);
      const durationMs = LOGIN_LOCKOUT_DURATIONS_MS[tier - 1];
      update.loginLockoutTier = tier;
      update.loginLockedUntil = new Date(now.getTime() + durationMs);
      justLockedFor = formatLockoutDuration(durationMs);
    }
    await User.updateOne({ _id: user._id }, update);
    if (justLockedFor) {
      return { status: 423, error: `Nieprawidłowe dane logowania. Konto zablokowane na ${justLockedFor} po zbyt wielu nieudanych próbach.` };
    }
    return { status: 400, error: 'invalid credentials' };
  }

  if (user.failedLoginAttempts || user.loginLockoutTier || user.loginLockedUntil) {
    await User.updateOne({ _id: user._id }, { failedLoginAttempts: 0, loginLockoutTier: 0, loginLockedUntil: null });
  }
  return { user };
}

// Must match the client-side palette in public/game.js and public/poczekalnia.html so a player's
// color is decided once here (by join order) and never recomputed/guessed independently per client.
const PLAYER_COLORS = ['#3b82f6', '#ef4444', '#f59e0b', '#10b981', '#a78bfa', '#f472b6', '#06b6d4', '#8b5cf6', '#fb7185', '#f97316'];
function colorForSlot(index) {
  return PLAYER_COLORS[index % PLAYER_COLORS.length];
}

// Picking a color by array-length/index breaks once anyone leaves and rejoins: a bot added at
// index 1 keeps its color even after the human at index 0 leaves and the bot shifts down to index
// 0, so a rejoining player computed purely from the new (shorter) length collides with a color
// already in use. Instead, hand out the first color in the palette nobody currently in the room is
// using, so it's always distinct regardless of join/leave order.
function nextAvailableColor(players) {
  const used = new Set((players || []).map((p) => p.color).filter(Boolean));
  const free = PLAYER_COLORS.find((color) => !used.has(color));
  return free || colorForSlot((players || []).length);
}

// Number(x) || fallback treats an explicit 0 the same as "not provided" (0 is falsy), which
// silently replaced an admin's intentional "no prize" / "free entry" 0 with the hardcoded default
// — this caught out both entryFee and the nagroda* reward fields. Number.isFinite distinguishes a
// real (possibly zero) number from anything that didn't parse.
function numberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/strategic_game';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';

// "YYYY-MM" for the current calendar month, in server local time — the shared reset key for the
// global monthly tournament-ticket pool. Compares its stored key against this and lazily zeroes
// the counter on a mismatch, so nothing needs a cron job to "reset on the 1st" — the reset happens
// the moment the first purchase of the new month is attempted.
function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
// The calendar month immediately before the current one, server local time — used by the
// automatic Free-Server-Ranking month-close watcher (see startFreeRankingMonthCloseWatcher) to
// grant the just-ended month's wildcard reward once the server rolls into a new month.
function previousMonthKey() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
}
// Midnight on the 1st of the current calendar month, server local time — the per-player ticket
// purchase cap (see POST /api/payments/tickets/create) resets exactly here, every month, with no
// stored "month key" bookkeeping needed: it's just "does a paid order exist on/after this date".
function startOfCurrentMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}
const TOURNAMENT_TICKETS_MONTHLY_POOL = 350;

async function initDatabase(){
  await mongoose.connect(MONGO_URI, { });
  console.log('Mongo connected');
  await ensureAdmin();
  await ensureSemifinalRooms();
  await ensureFinalRoom();
}

async function ensureAdmin(){
  const admin = await User.findOne({ username: 'Dariano' });
  if(!admin){
    // No hardcoded fallback password here on purpose — a known default baked into source control
    // would mean anyone with read access to the repo knows the initial admin password. Refuse to
    // silently create the account with a guessable value; require it to be set explicitly instead.
    if (!process.env.ADMIN_PASSWORD) {
      console.error('ADMIN_PASSWORD is not set — refusing to auto-create the admin account "Dariano". Set ADMIN_PASSWORD in .env and restart.');
      return;
    }
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
    await User.create({ username: 'Dariano', passwordHash: hash, isAdmin: true, skillPoints: 1200 });
    console.log('Admin Dariano created');
  }
}

// Creates the 4 permanent semifinal rooms the very first time the server ever starts (idempotent —
// checked by name, so re-running on every subsequent boot is a no-op once they exist). Starts
// paused: an admin unpauses each one manually from the Turnieje page's Półfinał tab once that
// month's qualification rounds have wrapped up — there's no automatic "qualifications are over"
// detection, this is a deliberate manual admin action.
const SEMIFINAL_ROOM_NAMES = ['Półfinał 1', 'Półfinał 2', 'Półfinał 3', 'Półfinał 4'];
async function ensureSemifinalRooms() {
  for (const roomName of SEMIFINAL_ROOM_NAMES) {
    const exists = await Room.findOne({ roomName });
    if (exists) continue;
    await Room.create({
      roomName,
      isTournament: true,
      tournamentStage: 'semifinal',
      isPaused: true,
      roomType: 'standard',
      maxPlayers: 10,
      settings: { dlugoscRundySekundy: 3600, modyfikatorCzasuEkonomii: 0, modyfikatorCzasuWojska: 0 }
    });
    console.log(`Semifinal room "${roomName}" created`);
  }
}

// The single permanent final room — same idempotent-by-name pattern as the semifinal rooms above.
// Also starts paused; an admin unpauses it (and manually places the 10 finalists into it) once
// they're known. Finalist SELECTION logic (top 2 per semifinal room + aggressor/defender wildcards)
// isn't automated yet — this is just the room the 10 finalists eventually play in.
const FINAL_ROOM_NAME = 'Finał';
async function ensureFinalRoom() {
  const exists = await Room.findOne({ roomName: FINAL_ROOM_NAME });
  if (exists) return;
  await Room.create({
    roomName: FINAL_ROOM_NAME,
    isTournament: true,
    tournamentStage: 'final',
    isPaused: true,
    roomType: 'standard',
    maxPlayers: 10,
    settings: { dlugoscRundySekundy: 3600, modyfikatorCzasuEkonomii: 0, modyfikatorCzasuWojska: 0 }
  });
  console.log(`Final room "${FINAL_ROOM_NAME}" created`);
}

async function authMiddleware(req, res, next){
  const auth = req.headers.authorization;
  if(!auth) return res.status(401).json({error:'missing token'});
  const token = auth.split(' ')[1];
  try{
    const data = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(data.id);
    if(!user) return res.status(401).json({ error: 'invalid token' });
    if(user.isBlocked) return res.status(403).json({ error: 'user blocked', blocked: true, blockReason: user.blockReason || null });
    req.userId = user._id;
    next();
  }catch(e){
    return res.status(401).json({error:'invalid token'});
  }
}

// Same as authMiddleware but never rejects a blocked account — used ONLY by the small set of routes
// a blocked player still needs (checking their own block reason/conversation, and writing to admin
// about it). Every other route keeps using authMiddleware's hard rejection.
// Jak authMiddleware, ale bez tokenu przepuszcza (gosc) - dla publicznych list, np. gier do obstawiania.
function authOptional(req, res, next){
  if (!req.headers.authorization) return next();
  return authMiddleware(req, res, next);
}

async function authMiddlewareAllowBlocked(req, res, next){
  const auth = req.headers.authorization;
  if(!auth) return res.status(401).json({error:'missing token'});
  const token = auth.split(' ')[1];
  try{
    const data = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(data.id);
    if(!user) return res.status(401).json({ error: 'invalid token' });
    req.userId = user._id;
    next();
  }catch(e){
    return res.status(401).json({error:'invalid token'});
  }
}

// Room is now purely a permanent matchmaking template — see src/models/Room.js. `waitingPlayers`
// is whoever is currently queued for the NEXT round to start; it has nothing to do with any round
// actually in progress (those live entirely in Round documents, see formatRound below).
function formatRoom(room) {
  if (!room) return null;
  const safeRoom = room.toObject ? room.toObject() : room;
  const waitingPlayers = safeRoom.waitingPlayers || [];
  const durationMinutes = (safeRoom.settings?.dlugoscRundySekundy || 3600) / 60;
  return {
    ...safeRoom,
    waitingPlayers,
    waitingCount: waitingPlayers.length,
    maxGraczy: safeRoom.maxPlayers,
    entryFeePremium: safeRoom.entryFee,
    nazwaPokoju: safeRoom.roomName,
    isPaused: safeRoom.isPaused || false,
    enabled: safeRoom.enabled !== false,
    // What this room's actual game pace will be once a round starts (see startCountdown) — a
    // 120-minute round is the 1x baseline every GameEngine build/recruit/travel/gold constant is
    // tuned for; shorter rounds run proportionally faster, longer ones proportionally slower.
    // Inverted on purpose: durationMinutes/baseline is the internal DURATION-scale factor
    // (gameEngine.js's timeScaleFactor, where a 60-minute room's 0.5 means "durations take half as
    // long") — this field is instead the player-facing SPEED (baseline/durationMinutes), so a
    // 60-minute room correctly shows "2x" (twice as fast) instead of "0.5x" (which reads as half
    // speed, the opposite of reality).
    speedFactor: Math.round((tournamentEngine.QUALIFICATION_ROUND_BASELINE_MINUTES / durationMinutes) * 100) / 100,
    ustawienia: {
      dlugoscRundySekundy: safeRoom.settings?.dlugoscRundySekundy || 3600,
      modyfikatorCzasuEkonomii: safeRoom.settings?.modyfikatorCzasuEkonomii ?? 0,
      modyfikatorCzasuWojska: safeRoom.settings?.modyfikatorCzasuWojska ?? 0,
      nagrodaTop1: safeRoom.settings?.nagrodaTop1 ?? 0,
      nagrodaTop2: safeRoom.settings?.nagrodaTop2 ?? 0,
      nagrodaTop3: safeRoom.settings?.nagrodaTop3 ?? 0,
      nagrodaAgresor: safeRoom.settings?.nagrodaAgresor ?? 0,
    }
  };
}

// A Round is one independent battle instance spawned from a Room template (see src/models/Round.js).
// Player roster/live stats live inside the round's own `state.players` (mirrored from the in-memory
// gameSession); this just lifts it up to a top-level `players` field for API/admin convenience.
function formatRound(round) {
  if (!round) return null;
  const safeRound = round.toObject ? round.toObject() : round;
  const players = safeRound.state?.players || [];
  return {
    _id: safeRound._id,
    roomId: safeRound.roomId,
    roomName: safeRound.roomName,
    roomType: safeRound.roomType,
    isTournament: safeRound.isTournament === true,
    entryFee: safeRound.entryFee,
    settings: safeRound.settings,
    status: safeRound.status,
    poolPP: safeRound.poolPP,
    // Same inversion as formatRoom's speedFactor above: safeRound.timeScaleFactor is the internal
    // DURATION-scale factor, this field is the player-facing SPEED (its reciprocal).
    speedFactor: Math.round((1 / (Number(safeRound.timeScaleFactor) || 1)) * 100) / 100,
    players,
    currentPlayersCount: players.length,
    roundStartedAt: safeRound.roundStartedAt,
    roundEndsAt: safeRound.roundEndsAt,
    finishedAt: safeRound.finishedAt
  };
}

// Resolves a join click into an atomic push onto the Room's waiting-player queue. No sibling
// rooms/instances anymore — the Room itself never fills up in a lasting sense, since crossing the
// threshold immediately spins off a Round and empties the queue back to zero (see startCountdown).
async function performRoomJoin(roomId, userId) {
  const room = await Room.findById(roomId);
  if (!room) return { error: 'room not found', status: 404 };
  if (room.enabled === false || room.isPaused) return { error: 'room not joinable', status: 400 };
  const user = await User.findById(userId);
  if (!user) return { error: 'user not found', status: 404 };
  // Just a possession check here — a round-entry is only actually spent once the round really
  // starts (see startCountdown), not at the moment of joining the queue, so leaving the queue
  // before then costs nothing. tournamentTickets only drops once every 4th qualification round
  // (see qualificationRoundUses in User.js), so "has a ticket" is still the right gate for every
  // one of those 4 entries — it isn't decremented until the last one.
  // Tickets only gate qualification rounds — semifinal/final rooms are reserved for players who
  // already qualified (see the ranking panels on turnieje.html), not something you buy your way
  // into with a ticket.
  if (room.isTournament && room.tournamentStage !== 'semifinal' && (user.tournamentTickets || 0) < 1) {
    return { error: 'Potrzebujesz biletu turniejowego, żeby dołączyć do tej rundy. Kup go w Sklepie.', status: 400 };
  }
  // Mini-Tournaments: same "possession check only, not spent until the round actually starts" idea
  // as tournamentTickets above — consumed right after the atomic join below, refunded in
  // leaveWaitingRoom if they back out before the round starts.
  if (room.isMiniTournament && room.requiresMiniTournamentTicket && !user.hasUnusedMiniTournamentTicket) {
    return { error: 'Potrzebujesz Biletu do Mini-Turnieju, żeby dołączyć do tego pokoju. Kup go w Sklepie.', status: 400 };
  }

  // A player already fighting in an active round elsewhere must leave/finish that one first —
  // otherwise they'd end up controlling two simultaneous games from the same account. Player
  // userIds inside a Round's state are stored as plain strings (see gameSession.js), so compare
  // against a stringified id, not the ObjectId itself. Explicitly excludes players who already
  // forfeited (hasLeft:true) via "Opuść rozgrywkę" — forfeiting frees them up to join elsewhere
  // immediately, they're just excluded from that old round's podium, not still "stuck" in it.
  const activeElsewhere = await Round.findOne({ status: 'active', 'state.players': { $elemMatch: { userId: user._id.toString(), hasLeft: { $ne: true } } } });
  if (activeElsewhere) return { error: 'Jesteś już w trakcie innej rozgrywki. Wróć do niej lub ją opuść, zanim dołączysz do nowej.', status: 400 };

  // Also block queuing in a SECOND room while already waiting in one — without this, a player could
  // sit in two different rooms' queues at once (the check above only catches an already-ACTIVE round,
  // which neither queue is yet) and, if both happen to fill and start around the same time, end up
  // controlling two simultaneous rounds — exactly what the check above exists to prevent, just via
  // the queue instead of an active round.
  const queuedElsewhere = await Room.findOne({ _id: { $ne: room._id }, 'waitingPlayers.userId': user._id });
  if (queuedElsewhere) return { error: 'Jesteś już w kolejce innego pokoju. Opuść go, zanim dołączysz do kolejnego.', status: 400 };

  // Once the countdown to round start has begun, the roster is meant to be locked — leaving is
  // already blocked at this point (see the /leave route), but joining wasn't, so a 'percentage'/
  // 'team' room counting down with e.g. 5/10 ready players could still get a fresh, unvetted, never
  // ready-checked player swept into the round in the last second (startCountdown re-reads
  // waitingPlayers fresh right when it hits zero). Treat "counting down" the same as "already
  // started" for join purposes.
  if (roomCountdowns.has(roomId)) {
    return { error: 'Runda właśnie się rozpoczyna — nie można już dołączyć do tego pokoju.', status: 400 };
  }

  let updated = await Room.findOneAndUpdate(
    {
      _id: room._id,
      isPaused: false,
      $expr: { $lt: [{ $size: '$waitingPlayers' }, '$maxPlayers'] },
      'waitingPlayers.userId': { $ne: user._id }
    },
    {
      $push: { waitingPlayers: { userId: user._id, username: user.username, isBot: false, color: nextAvailableColor(room.waitingPlayers) } }
    },
    { new: true }
  );
  if (!updated) return { error: 'already in room or could not join, please retry', status: 409 };

  if (room.isMiniTournament && room.requiresMiniTournamentTicket) {
    await User.updateOne({ _id: user._id }, { hasUnusedMiniTournamentTicket: false });
  }

  // nextAvailableColor above was computed from the pre-push `room` snapshot, not atomically with
  // the $push itself — two joins landing at the same instant can both read the same "first free"
  // color and both push it. Self-healing check: if the color we just got collides with someone
  // else already in the (now up-to-date) room, atomically reassign just our own entry to whatever
  // is actually free, re-reading fresh room state so the fix itself doesn't repeat the same race.
  const myColor = updated.waitingPlayers.find((p) => p.userId && p.userId.toString() === user._id.toString())?.color;
  const collision = myColor && updated.waitingPlayers.filter((p) => p.color === myColor).length > 1;
  if (collision) {
    const freshRoom = await Room.findById(room._id);
    const othersColors = (freshRoom?.waitingPlayers || []).filter((p) => p.userId?.toString() !== user._id.toString());
    const fixedColor = nextAvailableColor(othersColors);
    const fixed = await Room.findOneAndUpdate(
      { _id: room._id },
      { $set: { 'waitingPlayers.$[elem].color': fixedColor } },
      { arrayFilters: [{ 'elem.userId': user._id }], new: true }
    );
    if (fixed) updated = fixed;
  }

  if (updated.roomType !== 'percentage' && updated.roomType !== 'team' && updated.waitingPlayers.length >= updated.maxPlayers) {
    startCountdown(updated._id.toString());
  }
  return { room: updated };
}

// --- Blind matchmaking for Mini-Tournament rooms --------------------------------------------------
// Replaces performRoomJoin above for isMiniTournament rooms: instead of pushing straight onto
// Room.waitingPlayers (visible to everyone in the lobby via lobby:update_list), the player enters an
// in-memory, per-room queue (miniTournamentQueues) that nobody else can see. runMatchingTick groups
// players by tournamentMMR with a search-time-expanding range, then a 15s blind accept window
// (pendingMatches) runs before anyone's identity is revealed or their ticket is spent — only once
// every matched player accepts does resolveMatch() push the real roster onto waitingPlayers and hand
// off to the existing startCountdown/Round-creation machinery, completely unchanged.

async function joinMiniTournamentQueue(roomId, userId) {
  const room = await Room.findById(roomId);
  if (!room) return { error: 'room not found', status: 404 };
  if (room.enabled === false || room.isPaused) return { error: 'room not joinable', status: 400 };
  if (!room.isMiniTournament) return { error: 'not a mini-tournament room', status: 400 };
  const user = await User.findById(userId);
  if (!user) return { error: 'user not found', status: 404 };

  // Possession check only — the ticket is spent in resolveMatch(), only once every matched player
  // has accepted, per the spec ("Bilet zostaje ostatecznie zużyty dopiero po komplecie akceptacji").
  if (room.requiresMiniTournamentTicket && !user.hasUnusedMiniTournamentTicket) {
    return { error: 'Potrzebujesz Biletu do Mini-Turnieju, żeby szukać gry. Kup go w Sklepie.', status: 400 };
  }

  // Same "already fighting elsewhere" guard as performRoomJoin (copied verbatim — see its comment).
  const activeElsewhere = await Round.findOne({ status: 'active', 'state.players': { $elemMatch: { userId: user._id.toString(), hasLeft: { $ne: true } } } });
  if (activeElsewhere) return { error: 'Jesteś już w trakcie innej rozgrywki. Wróć do niej lub ją opuść, zanim dołączysz do nowej.', status: 400 };

  // Cross-room dedupe — performRoomJoin's queuedElsewhere check only looks at Room.waitingPlayers in
  // Mongo, which the blind queue deliberately never touches pre-accept, so it must be replicated here
  // against the in-memory structures too (across EVERY mini-tournament room, not just this one) —
  // otherwise a player could queue in two rooms at once and end up seated in two Rounds simultaneously.
  const uidStr = user._id.toString();
  for (const queue of miniTournamentQueues.values()) {
    if (queue.some((p) => p.userId === uidStr)) return { error: 'Już szukasz gry w innym pokoju Mini-Turniejowym.', status: 400 };
  }
  for (const pm of pendingMatches.values()) {
    if (pm.players.some((p) => p.userId === uidStr)) return { error: 'Masz już oczekujący mecz do zaakceptowania.', status: 400 };
  }
  const queuedElsewhere = await Room.findOne({ 'waitingPlayers.userId': user._id });
  if (queuedElsewhere) return { error: 'Jesteś już w kolejce innego pokoju. Opuść go, zanim dołączysz do kolejnego.', status: 400 };

  if (!miniTournamentQueues.has(roomId)) miniTournamentQueues.set(roomId, []);
  miniTournamentQueues.get(roomId).push({
    userId: uidStr, username: user.username, tournamentMMR: user.tournamentMMR ?? 1000,
    queuedAt: Date.now(), socketId: null, disconnectedAt: null
  });
  return { room };
}

async function leaveMiniTournamentQueue(roomId, userId) {
  const uidStr = userId.toString();
  const pm = pendingMatches.get(roomId);
  if (pm && pm.players.some((p) => p.userId === uidStr)) {
    return { error: 'Nie można anulować w trakcie akceptacji meczu — zaakceptuj lub poczekaj na upłynięcie czasu.', status: 400 };
  }
  const queue = miniTournamentQueues.get(roomId);
  if (queue) {
    const idx = queue.findIndex((p) => p.userId === uidStr);
    if (idx !== -1) queue.splice(idx, 1);
  }
  return { ok: true };
}

function pruneDisconnectedFromQueue(queue) {
  const now = Date.now();
  for (let i = queue.length - 1; i >= 0; i--) {
    const p = queue[i];
    if (!p.socketId && p.disconnectedAt && (now - p.disconnectedAt) > MM_QUEUE_DISCONNECT_GRACE_MS) {
      queue.splice(i, 1);
    }
  }
}

// Longest-waiting player anchors the search; its own elapsed queue time sets the MMR range used to
// pull in the rest of the group. One pass per tick (no retry with the next-longest anchor if this
// one comes up short) — plenty responsive at this server's scale (a 2s tick, queues in the tens).
function tryFormGroup(queue, need) {
  const anchors = [...queue].sort((a, b) => a.queuedAt - b.queuedAt);
  for (const anchor of anchors) {
    const waited = Date.now() - anchor.queuedAt;
    const range = waited >= MM_TIER2_MS ? Infinity : waited >= MM_TIER1_MS ? MM_TIER2_RANGE : MM_TIER1_RANGE;
    const pool = queue
      .filter((p) => p !== anchor && Math.abs(p.tournamentMMR - anchor.tournamentMMR) <= range)
      .sort((a, b) => Math.abs(a.tournamentMMR - anchor.tournamentMMR) - Math.abs(b.tournamentMMR - anchor.tournamentMMR));
    if (pool.length + 1 >= need) return [anchor, ...pool.slice(0, need - 1)];
  }
  return null;
}

async function runMatchingTick() {
  for (const [roomId, queue] of miniTournamentQueues) {
    pruneDisconnectedFromQueue(queue);
    if (!queue.length || pendingMatches.has(roomId)) continue; // one match forming per room at a time
    const room = await Room.findById(roomId).select('maxPlayers isPaused enabled isMiniTournament');
    if (!room || !room.isMiniTournament || room.isPaused || room.enabled === false) continue;
    const need = room.maxPlayers || 10;
    const group = tryFormGroup(queue, need);
    if (group) {
      group.forEach((p) => { const i = queue.indexOf(p); if (i !== -1) queue.splice(i, 1); });
      startPendingMatch(roomId, group);
    }
  }
}

function startPendingMatch(roomId, players) {
  const matchId = uuidv4();
  const deadlineAt = Date.now() + MM_ACCEPT_WINDOW_MS;
  const timer = setTimeout(() => resolveMatch(roomId, matchId).catch((err) => console.error('resolveMatch (timeout) error', err)), MM_ACCEPT_WINDOW_MS);
  pendingMatches.set(roomId, { matchId, players, acceptedUserIds: new Set(), deadlineAt, timer });
  players.forEach((p) => io.sockets.sockets.get(p.socketId)?.emit('matchmaking:matchFound', { matchId, deadlineAt }));
}

async function resolveMatch(roomId, matchId) {
  const pm = pendingMatches.get(roomId);
  if (!pm || pm.matchId !== matchId) return; // already resolved by the other trigger (accept vs timeout)
  pendingMatches.delete(roomId);
  clearTimeout(pm.timer);

  const accepted = pm.players.filter((p) => pm.acceptedUserIds.has(p.userId));
  const notAccepted = pm.players.filter((p) => !pm.acceptedUserIds.has(p.userId));
  notAccepted.forEach((p) => io.sockets.sockets.get(p.socketId)?.emit('matchmaking:removed', { reason: 'not_accepted' }));

  if (notAccepted.length === 0) {
    const room = await Room.findById(roomId);
    if (!room) {
      accepted.forEach((p) => io.sockets.sockets.get(p.socketId)?.emit('matchmaking:removed', { reason: 'room_gone' }));
      return;
    }
    // Defensive re-check — should never actually filter anyone out in normal operation, but a ticket
    // could theoretically be revoked/altered between queue-join and this exact moment. Only applies
    // to rooms that actually require a ticket in the first place (room.requiresMiniTournamentTicket)
    // — free/no-ticket Mini-Turniej rooms never required hasUnusedMiniTournamentTicket at queue-join
    // (see joinMiniTournamentQueue), so demanding it here unconditionally made EVERY match in such a
    // room fail with reason:'ticket_lost' right after a full, successful accept from every player —
    // a match that had nothing to do with tickets got reported to players as "you didn't accept".
    if (room.requiresMiniTournamentTicket) {
      const stillTicketed = await User.find({ _id: { $in: accepted.map((p) => p.userId) }, hasUnusedMiniTournamentTicket: true }).select('_id');
      if (stillTicketed.length !== accepted.length) {
        accepted.forEach((p) => io.sockets.sockets.get(p.socketId)?.emit('matchmaking:removed', { reason: 'ticket_lost' }));
        return;
      }
    }
    const entries = [];
    accepted.forEach((p) => entries.push({ userId: p.userId, username: p.username, isBot: false, color: nextAvailableColor(entries) }));
    room.waitingPlayers.push(...entries);
    await room.save();
    // Only spend a ticket for rooms that actually required one — a free Mini-Turniej room burning
    // an unrelated ticket the player happens to hold (for some other, paid Mini-Turniej) would be a
    // real loss for them with nothing to show for it.
    if (room.requiresMiniTournamentTicket) {
      await User.updateMany({ _id: { $in: accepted.map((p) => p.userId) } }, { hasUnusedMiniTournamentTicket: false });
    }
    io.to(roomId).emit('roomUpdated', room);
    io.to(roomId).emit('lobby:update_list', room.waitingPlayers);
    startCountdown(roomId, 5); // fully reused, unmodified — existing Round-creation/reveal/start flow
    return;
  }

  // Partial accept: the accepters go back to the FRONT of the queue with top priority — backdating
  // queuedAt past MM_TIER2_MS immediately qualifies them for the widest ("any player") MMR range.
  if (!miniTournamentQueues.has(roomId)) miniTournamentQueues.set(roomId, []);
  const queue = miniTournamentQueues.get(roomId);
  accepted.forEach((p) => {
    p.queuedAt = Date.now() - (MM_TIER2_MS + 1);
    p.disconnectedAt = null;
    queue.unshift(p);
    io.sockets.sockets.get(p.socketId)?.emit('matchmaking:requeued', {});
  });
}

async function requireAdmin(req, res, next) {
  const user = await User.findById(req.userId);
  if(!user || !user.isAdmin) return res.status(403).json({ error: 'admin only' });
  req.user = user;
  next();
}

// Anti-farming guard shared with forfeitRound below: below this many real (non-bot) competitors, a
// free round simply doesn't move User.skillPoints for anyone, win OR lose — playing 1 real player +
// bots would otherwise trivially "win" the ranking every time. forfeitRound's -20 leave penalty uses
// the exact same threshold so leaving a mostly-bot round never costs Skill Points either — the
// deduction rule has to match the awarding rule, or bots become a way to grief your own rank.
const MIN_PLAYERS_FOR_SKILL_POINTS = 5;

async function payoutRoundRewards(round) {
  try {
    // Trial rounds never affect Skill Points or the roundsPlayed/roundsWon counters — it's pure
    // practice against bots, not a real match. WoLcoin round-end rewards were removed entirely —
    // rounds are free to join and no longer pay out any currency, win or lose (see Room.js).
    if (round.isTrial) return;
    const roundId = round._id.toString();
    // Prefer the LIVE in-memory session (most current — the round timer's finishSession() runs
    // right before this and persists it, but reading the in-memory copy directly avoids any
    // possible staleness) falling back to the round's own persisted state.
    const liveState = gameSession.getSession(roundId);
    const players = liveState?.players || round.state?.players || [];
    if (!players.length) return;

    // Players who forfeited via "Opuść rozgrywkę" (hasLeft) never compete for the podium — they
    // already took their fixed -20 Skill Points penalty the moment they quit (see forfeitRound) —
    // but they stay in `players` for the roundsPlayed credit below and
    // GameEngine.computeSkillPointsDeltas applies the same hasLeft exclusion independently.
    const podiumEligiblePlayers = players.filter((p) => !p.hasLeft);
    // Individual points ranking — used below for the roundsWon credit, on an exact tie whoever
    // reached that total earlier wins (see GameEngine.comparePlayersByRank / pointsAchievedAt).
    const byPoints = [...podiumEligiblePlayers].sort(GameEngine.comparePlayersByRank);

    // Every real (non-bot) participant gets a played-round credit; whoever finished #1 by
    // points also gets a win credit — this is purely for stats/ranking, no currency involved.
    const winnerId = byPoints[0] && !byPoints[0].isBot ? byPoints[0].userId : null;
    const skillPointsDeltas = GameEngine.computeSkillPointsDeltas(players, round.roomType === 'team');

    // Tournament rounds ("rundy kwalifikacyjne") feed the qualification leaderboard — each
    // player's final in-game points (village points, same number as byPoints above) get added to
    // their running monthly qualificationPoints total, which is what decides the TOP 35 who
    // advance to the semifinals (see getQualificationLeaderboard). Counts every participant, not
    // just podium-eligible ones, matching roundsPlayed's scope right below.
    //
    // REGULAR (non-tournament, Pokoje Bitewne) rounds instead feed the OTHER monthly ranking —
    // regularRoundsMmrPoints ("Miesięczny Ranking Darmowy") — using the exact same 3-category
    // Tournament Points algorithm as Monthly Tournament qualification rounds (village points +
    // attacker kills + total units destroyed, see src/tournamentScoring.js), generalized to any
    // room size via computeRoomRoundResultsForAnyCount. Deliberately mutually exclusive with
    // qualificationPoints above: a round is either a tournament round or a regular one, never both.
    const monthKey = currentMonthKey();

    // Ranking Ogólny (User.skillPoints) only ever moves from genuinely free rounds — Monthly
    // Tournament qualification rounds feed qualificationPoints instead (below), and Mini-Turniej
    // rounds don't feed any monthly/overall ranking at all (their only reward is the VPLN prize).
    const isFreeRound = !round.isTournament && !round.isMiniTournament;

    // Anti-farming guard: a free round only feeds the monthly wildcard ranking if at least this
    // many REAL (non-bot) players actually competed (didn't leave) — counting bots toward the
    // threshold would let one real player farm wildcard rank alongside 7 bot seats, defeating the
    // point of the guard. Below the threshold, the round's result is invisible to this ranking
    // entirely (no roundTP computed, no accumulation), exactly as specified. Bots still take part
    // in the actual ranking computation below (they occupy real seats and affect real players'
    // relative placement) — they're just never credited any points for it (see the isBot skip in
    // the per-player loop below).
    const MIN_PLAYERS_FOR_FREE_RANKING = 8;
    const realCompetitorCount = podiumEligiblePlayers.filter((p) => !p.isBot && p.userId).length;
    let freeRoundTPByUserId = null;
    // Ranking Serwerow Darmowych prowadzi do nagrod (DOGE, bezposredni awans do polfinalu), a boty
    // dzialaja losowo - runda z choc jednym botem nie liczy sie do tego rankingu (Regulamin §1a:
    // na wynik premiowany wplywaja wylacznie decyzje prawdziwych graczy).
    const roundHadBots = players.some((p) => p.isBot);
    if (isFreeRound && !roundHadBots && realCompetitorCount >= MIN_PLAYERS_FOR_FREE_RANKING) {
      freeRoundTPByUserId = new Map(
        computeRoomRoundResultsForAnyCount(podiumEligiblePlayers).map((r) => [String(r.userId), r.roundTP])
      );
    }
    for (const player of players) {
      if (player.isBot || !player.userId) continue;
      const update = { $inc: { roundsPlayed: 1 } };
      if (player.userId === winnerId) update.$inc.roundsWon = 1;
      const skillPointsDelta = skillPointsDeltas.get(player.userId) || 0;
      if (isFreeRound && realCompetitorCount >= MIN_PLAYERS_FOR_SKILL_POINTS && skillPointsDelta !== 0) update.$inc.skillPoints = skillPointsDelta;
      // Mini-Tournament-only MMR (blind matchmaking) — same rank-based delta, just credited to a
      // dedicated field instead of skillPoints so casual and Mini-Tournament performance never mix.
      if (round.isMiniTournament && skillPointsDelta !== 0) update.$inc.tournamentMMR = skillPointsDelta;
      await User.updateOne({ _id: player.userId }, update);

      if (round.isTournament) {
        const pointsEarned = Number(player.points) || 0;
        await User.updateOne({ _id: player.userId }, [
          { $set: {
              qualificationPoints: {
                $cond: [
                  { $eq: [{ $ifNull: ['$qualificationPointsMonthKey', null] }, monthKey] },
                  { $add: [{ $ifNull: ['$qualificationPoints', 0] }, pointsEarned] },
                  pointsEarned
                ]
              },
              qualificationPointsMonthKey: monthKey
            }
          }
        ]);
      } else if (isFreeRound && freeRoundTPByUserId && freeRoundTPByUserId.has(String(player.userId))) {
        const roundTP = freeRoundTPByUserId.get(String(player.userId));
        await User.updateOne({ _id: player.userId }, [
          { $set: {
              regularRoundsMmrPoints: {
                $cond: [
                  { $eq: [{ $ifNull: ['$regularRoundsMmrPointsMonthKey', null] }, monthKey] },
                  { $add: [{ $ifNull: ['$regularRoundsMmrPoints', 0] }, roundTP] },
                  roundTP
                ]
              },
              regularRoundsMmrPointsMonthKey: monthKey
            }
          }
        ]);
      }
    }

    await recordGamesTogetherForRound(roundId, players);
  } catch (err) {
    console.error('payoutRoundRewards error', err);
  }
}

// Anything that needs to react to a round finishing (currently just tournamentEngine.js, tapping
// in to score Monthly Tournament rooms) registers here instead of this file reaching INTO that
// module directly at both finish call sites — keeps the two finish-call-sites below simple and
// lets tournamentEngine.js stay a plain dependency-injected module with no circular require back
// into this file. Registered functions receive the same freshly-finished `round` document
// payoutRoundRewards itself just read from, called right after it, before the round's live
// session is torn down.
// DogeOS testnet (src/chain) - przypisane przy starcie serwera nizej; do tego czasu atrapa.
let chainApi = { enabled: false, onRoundStarted: async () => {}, onRoundFinished: async () => {}, creditRoundPrizes: async () => new Set() };

const roundFinishHooks = [];
function registerRoundFinishHook(fn) {
  roundFinishHooks.push(fn);
}
// Returns whatever the first hook that actually returns something hands back (currently: the
// Mini-Tournament payout hook below, or tournamentEngine's Final-prize hook — never both at once,
// since a round is either a Mini-Tournament round or a Monthly Tournament round, never neither/
// both) — used by endRound() to attach a `prizeResults` breakdown onto the finished round's
// broadcast state so the client can show "1st place: X VPLN" etc. immediately, without needing to
// re-derive placement itself (which wouldn't match the Final's tie-break rule, see
// tournamentScoring.js's userId-based tie-break vs the client's pointsAchievedAt-based one).
async function runRoundFinishHooks(round) {
  let prizeResults = null;
  for (const fn of roundFinishHooks) {
    try {
      const result = await fn(round);
      if (result && !prizeResults) prizeResults = result;
    } catch (err) {
      console.error('roundFinishHook error', err);
    }
  }
  return prizeResults;
}

// Mini-Tournament VPLN payout — registered as an ordinary round-finish hook (see
// registerRoundFinishHook below) rather than built on the Monthly Tournament's TournamentRoom/
// Tournament machinery: a mini-tournament room's Round already carries everything needed
// (round.state.players' points), so this just re-derives 1st/2nd/3rd place the same way
// payoutRoundRewards derives the winner, then pays out via the same audit-record-before-balance-
// credit idempotent pattern as tournamentEngine.payoutFinalPrizes.
registerRoundFinishHook(async (round) => {
  const room = await Room.findById(round.roomId).select('isMiniTournament miniTournamentPrizes');
  if (!room || !room.isMiniTournament) return null;
  // hasLeft already excludes a real player's forfeit, but a BANNED account never gets hasLeft set
  // if it's a bot (forfeitRound no-ops for bots — see blockUserAccount) — checked and fixed
  // alongside the same gap in tournamentEngine.payoutFinalPrizes, so a banned account can't still
  // collect a Mini-Turniej placement prize on frozen stats from before the ban either.
  const notLeft = (round.state?.players || []).filter((p) => !p.hasLeft);
  const blockedUserIds = new Set(
    (await User.find({ _id: { $in: notLeft.map((p) => p.userId) }, isBlocked: true }).select('_id')).map((u) => String(u._id))
  );
  const podiumEligiblePlayers = notLeft.filter((p) => !blockedUserIds.has(String(p.userId)));
  const ranked = [...podiumEligiblePlayers].sort(GameEngine.comparePlayersByRank);
  const prizeByPlacement = {
    1: room.miniTournamentPrizes?.place1VPLN || 0,
    2: room.miniTournamentPrizes?.place2VPLN || 0,
    3: room.miniTournamentPrizes?.place3VPLN || 0
  };
  const prizeResults = [];
  const chainEntries = [];
  for (let i = 0; i < Math.min(3, ranked.length); i += 1) {
    const placement = i + 1;
    const vplnAwarded = prizeByPlacement[placement];
    const p = ranked[i];
    if (!vplnAwarded || !p?.userId) continue;
    prizeResults.push({ placement, userId: p.userId, username: p.name, vplnAwarded });
    // Paid out 100% gross — no tax withheld (see regulamin.html §5b / TournamentResults.js comment).
    try {
      await MiniTournamentResults.create({ roundId: round._id, roomId: room._id, userId: p.userId, username: p.name, placement, vplnAwarded });
      chainEntries.push({ userId: p.userId, username: p.name, placement, amountGame: vplnAwarded });
    } catch (err) {
      if (err && err.code === 11000) continue; // already paid for this round (idempotent retry)
      console.error(`Mini-tournament payout error (round ${round._id}, placement ${placement})`, err);
    }
  }
  // Gracze z podlaczonym portfelem dostaja nagrode w kontrakcie DogeOS (odbior przyciskiem Claim);
  // pozostali (bez portfela, pusta pula, blad sieci) - na saldo w grze, jak dotychczas.
  const paidOnChain = await chainApi.creditRoundPrizes(round._id, chainEntries).catch((err) => { console.error('chain creditRoundPrizes error', err); return new Set(); });
  for (const e of chainEntries) {
    if (paidOnChain.has(String(e.userId))) continue;
    await User.updateOne({ _id: e.userId }, { $inc: { dogeBalance: e.amountGame } });
  }
  return prizeResults.length ? prizeResults : null;
});

// Rozliczenie rynku zakladow (DogeOS) - zwyciezca liczony tak samo jak w wyplacie Mini-Turnieju.
registerRoundFinishHook(async (round) => {
  const notLeft = (round.state?.players || []).filter((p) => !p.hasLeft && p.userId);
  const blocked = new Set((await User.find({ _id: { $in: notLeft.map((p) => p.userId) }, isBlocked: true }).select('_id')).map((u) => String(u._id)));
  const ranked = notLeft.filter((p) => !blocked.has(String(p.userId))).sort(GameEngine.comparePlayersByRank);
  await chainApi.onRoundFinished({ round, winnerUserId: ranked[0] ? ranked[0].userId : null });
  return null;
});

// --- Behavioral / win-trading detection ------------------------------------------------------
// Resource transfer between players is blocked, so the only way one account can gift a village to
// another is by defending it with nothing when the "attack" lands. These helpers watch every
// village capture for exactly that signature and track how often any two real accounts keep ending
// up in the same ROUND together, for the admin panel's "Podejrzane Powiązania" tab.

function pairKeyFor(idA, idB) {
  return [String(idA), String(idB)].sort().join('_');
}

async function getOrCreatePairStat(userIdA, usernameA, userIdB, usernameB) {
  const pairKey = pairKeyFor(userIdA, userIdB);
  let doc = await MatchPairStat.findOne({ pairKey });
  if (!doc) {
    doc = await MatchPairStat.create({ pairKey, userIdA, usernameA, userIdB, usernameB });
  }
  return doc;
}

async function recordGamesTogetherForRound(roundId, players) {
  const realPlayers = (players || []).filter((p) => p.userId && !p.isBot);
  for (let i = 0; i < realPlayers.length; i++) {
    for (let j = i + 1; j < realPlayers.length; j++) {
      const a = realPlayers[i], b = realPlayers[j];
      const doc = await getOrCreatePairStat(a.userId, a.name, b.userId, b.name);
      const alreadyCounted = doc.roundIdsTogether.some((id) => id.toString() === roundId);
      if (!alreadyCounted) {
        doc.roundIdsTogether.push(roundId);
        await doc.save();
      }
    }
  }
}

async function recordOneSidedCapture({ roundId, aggressorId, aggressorUsername, defenderId, defenderUsername, attackPower, defensePower, lateGame }) {
  const doc = await getOrCreatePairStat(aggressorId, aggressorUsername, defenderId, defenderUsername);
  doc.oneSidedCaptures.push({ roundId, aggressorId, aggressorUsername, defenderId, defenderUsername, attackPower, defensePower, lateGame, timestamp: new Date() });
  if (doc.oneSidedCaptures.length > 50) doc.oneSidedCaptures = doc.oneSidedCaptures.slice(-50);
  doc.totalOneSidedCaptures = (doc.totalOneSidedCaptures || 0) + 1;
  doc.lastIncidentAt = new Date();
  await doc.save();
}

// A capture in the round's final 20% of its duration is the classic "hand the crown over right
// before the round ends" win-trading pattern.
function isLateGamePhase(state, timestamp) {
  if (!Number.isFinite(state.roundEndsAt) || !Number.isFinite(state.roundStartedAt)) return false;
  const totalDurationMs = state.roundEndsAt - state.roundStartedAt;
  if (totalDurationMs <= 0) return false;
  return (state.roundEndsAt - timestamp) <= totalDurationMs * 0.2;
}

// roundId -> id of the newest state.reports[] entry already inspected, so each tick only looks at
// reports generated since the last tick instead of re-scanning the whole (up to 300-entry) log.
const lastSeenReportId = new Map();

// Clears every per-round in-memory Map entry (this one, multiAccountScanFlags, and
// roundLiveConnections — all declared further below but referenced here since this is the shared
// cleanup called from every round-ending path). None of these used to have a matching
// `.delete(roundId)` anywhere, so a server that's been running for weeks kept one entry per round
// EVER played (not per currently-active round) resident in memory for the life of the process.
// Safe to call defensively even if a Map isn't populated for this roundId.
function cleanupRoundMemory(roundId) {
  lastSeenReportId.delete(roundId);
  multiAccountScanFlags.delete(roundId);
  roundLiveConnections.delete(roundId);
  // teamChatHistory is keyed `${roundId}:${teamId}`, not just roundId, so every team's channel for
  // this round needs its own delete.
  for (const key of [...teamChatHistory.keys()]) {
    if (key.startsWith(`${roundId}:`)) teamChatHistory.delete(key);
  }
}

async function processConquestReports(roundId, state) {
  try {
    const reports = Array.isArray(state.reports) ? state.reports : [];
    if (!reports.length) return;
    const lastId = lastSeenReportId.get(roundId);
    const newReports = [];
    for (const report of reports) {
      if (report.id === lastId) break;
      newReports.push(report);
    }
    lastSeenReportId.set(roundId, reports[0].id);
    if (!newReports.length) return;
    newReports.reverse(); // oldest-first, matching the order they actually happened in

    for (const report of newReports) {
      if (!report.capturedVillage) continue;
      const aggressor = state.players.find((p) => p.name === report.attackerName);
      const defender = state.players.find((p) => p.name === report.defenderName);
      if (!aggressor || !defender || !aggressor.userId || !defender.userId || aggressor.isBot || defender.isBot) continue;
      const attackPower = Number(report.attackPowerAtBattle) || 0;
      const defensePower = Number(report.defensePowerAtBattle) || 0;
      const isZeroOrSymbolic = defensePower <= 0 || (attackPower > 0 && (defensePower / attackPower) < 0.05);
      if (!isZeroOrSymbolic) continue;
      await recordOneSidedCapture({
        roundId,
        aggressorId: aggressor.userId, aggressorUsername: aggressor.name,
        defenderId: defender.userId, defenderUsername: defender.name,
        attackPower, defensePower,
        lateGame: isLateGamePhase(state, report.timestamp || Date.now())
      });
    }
  } catch (err) {
    console.error('processConquestReports error', err);
  }
}

// Ends a round: marks it finished, cancels its timer, pays out rewards (unless already finished),
// broadcasts the frozen final state (for the podium) to everyone still connected to it, then tears
// down the in-memory session. The Room this round came from is never touched — it was never
// "in" this round to begin with.
async function endRound(roundId) {
  // Atomic compare-and-swap on status ('active' -> 'finished') instead of a plain findById + save —
  // this is the one and only place that's allowed to run payoutRoundRewards, whether the round ends
  // via this admin-triggered path or via startRoundTimer's own setTimeout finish callback. A plain
  // read-then-write here raced with that timer callback (both could read status:'active' before
  // either write committed, if an admin clicked "end round" during the 5s ROUND_ENDING_BUFFER_MS
  // window right after roundEnding was broadcast) — this CAS makes only whichever caller's update
  // actually flips 'active'->'finished' the one that gets to pay out; the loser sees a null match
  // and skips payout entirely, so WoLcoin/Skill Points/roundsPlayed can never be double-applied.
  const now = new Date();
  const wonRace = await Round.findOneAndUpdate(
    { _id: roundId, status: 'active' },
    { status: 'finished', finishedAt: now, roundEndsAt: now },
    { new: true }
  );
  const round = wonRace || await Round.findById(roundId);
  if (!round) return null;
  cancelRoundTimer(roundId);
  let prizeResults = null;
  if (wonRace) {
    await payoutRoundRewards(round);
    prizeResults = await runRoundFinishHooks(round);
    // Persist alongside the live broadcast below — a client that only loads/reloads game.html
    // after this point (round already finished) rebuilds its state from this Round document via
    // gameSession.hydrateFromRound, not from the one-time broadcast, so it needs its own copy here.
    if (prizeResults) await Round.updateOne({ _id: roundId }, { $set: { prizeResults } });
    // Bots exist only to fill out a room's headcount for this one round. By this point every hook
    // above has already read whatever it needed from them (payouts, qualification points, hasLeft/
    // isBlocked checks) and round.state.players/TournamentRoom.results already carry their own
    // persisted snapshot (username, stats) for later display — nothing needs the bot's User document
    // to keep existing. Deleting it here means bot accounts never again pile up unbounded the way
    // hundreds of them had to be manually purged from the database after this session's load tests.
    const finishedPlayers = gameSession.getSession(roundId)?.players || round.state?.players || [];
    const botUserIds = finishedPlayers.filter((p) => p.isBot).map((p) => p.userId);
    if (botUserIds.length) {
      await User.deleteMany({ _id: { $in: botUserIds }, isBot: true }).catch((err) => console.error('post-round bot cleanup error', err));
    }
  }
  const finalState = gameSession.getSession(roundId);
  if (finalState) {
    finalState.roundStatus = 'finished';
    // Only Mini-Tournament rounds and the Monthly Tournament Final ever return anything here (see
    // runRoundFinishHooks) — every other round type broadcasts with no prizeResults field at all,
    // exactly as before this change.
    if (prizeResults) finalState.prizeResults = prizeResults;
    io.to(roundId).emit('game:state', finalState);
  }
  io.to(roundId).emit('roundFinished', { roundId, status: round.status });
  gameSession.endSession(roundId);
  cleanupRoundMemory(roundId);
  return formatRound(await Round.findById(roundId));
}

// Admin/test-data cleanup: force-removes a Round document outright (no payout, no broadcast) —
// used for tidying up test rounds, not part of the normal round lifecycle.
async function deleteRound(roundId) {
  const round = await Round.findById(roundId);
  if (!round) return null;
  await round.deleteOne();
  gameSession.endSession(roundId);
  cancelRoundTimer(roundId);
  cleanupRoundMemory(roundId);
  return { success: true, deleted: 'round' };
}

app.post('/api/register', async (req, res) => {
  const { username, password, email, termsAccepted, marketingOptIn } = req.body;
  const validationError = validateUsernameAndPassword(username, password);
  if (validationError) return res.status(400).json({ error: validationError });
  const trimmedUsername = username.trim();
  const normalizedEmail = (email || '').trim().toLowerCase();
  if(!normalizedEmail || !normalizedEmail.includes('@')) return res.status(400).json({ error: 'invalid email' });
  if(termsAccepted !== true) return res.status(400).json({ error: 'Musisz zaakceptować Regulamin i Politykę Prywatności.' });
  const exists = await User.findOne({ username: trimmedUsername });
  if(exists) return res.status(400).json({ error: 'username taken' });
  const emailTaken = await User.findOne({ email: normalizedEmail });
  if(emailTaken) return res.status(400).json({ error: 'email already registered' });
  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  const user = await User.create({
    username: trimmedUsername, email: normalizedEmail, passwordHash,
    termsAcceptedAt: now, privacyAcceptedAt: now,
    marketingOptIn: marketingOptIn === true, marketingOptInAt: marketingOptIn === true ? now : null
  });
  const token = jwt.sign({ id: user._id }, JWT_SECRET);
  res.json({ token, user: { id: user._id, username: user.username, skillPoints: user.skillPoints, isAdmin: user.isAdmin } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  // Blocked accounts are still allowed to log in (unlike every OTHER protected route, which still
  // rejects them via authMiddleware) — the client shows a dedicated blocked screen with the reason
  // and a way to message admin, instead of just bouncing them back to the login page. The lockout
  // below is orthogonal to that — it's about wrong-password brute-forcing, not admin blocks.
  const attempt = await attemptLogin(username, password);
  if (attempt.error) return res.status(attempt.status).json({ error: attempt.error });
  const user = attempt.user;
  await pushLoginHistory(user, getClientIp(req), req.body?.deviceId);
  const token = jwt.sign({ id: user._id }, JWT_SECRET);
  res.json({ token, user: { id: user._id, username: user.username, skillPoints: user.skillPoints, isAdmin: user.isAdmin } });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId).select('-passwordHash');
  res.json({ user });
});

// One-time gate: index.html shows a full-screen overlay until this is called, then never shows it
// again for this account.
app.post('/api/me/accept-rules', authMiddleware, async (req, res) => {
  await User.updateOne({ _id: req.userId }, { hasAcceptedRules: true });
  res.json({ success: true });
});

// "Co nowego" announcements popup — index.html calls this after the rules/blocked gates pass and
// shows a modal for anything created after the account's lastNewsReadAt. Never checked from
// game.html, so it never interrupts an actual round.
app.get('/api/news/unread', authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId).select('lastNewsReadAt');
  const query = user?.lastNewsReadAt ? { createdAt: { $gt: user.lastNewsReadAt } } : {};
  const items = await NewsItem.find(query).sort({ createdAt: 1 }).lean();
  res.json({ items });
});

app.post('/api/news/mark-read', authMiddleware, async (req, res) => {
  await User.updateOne({ _id: req.userId }, { lastNewsReadAt: new Date() });
  res.json({ success: true });
});

app.get('/api/admin/news', authMiddleware, requireAdmin, async (req, res) => {
  const items = await NewsItem.find().sort({ createdAt: -1 }).lean();
  res.json({ items });
});

app.post('/api/admin/news', authMiddleware, requireAdmin, async (req, res) => {
  const title = (req.body?.title || '').trim();
  const body = (req.body?.body || '').trim();
  if (!title || !body) return res.status(400).json({ error: 'Tytuł i treść są wymagane.' });
  const admin = await User.findById(req.userId).select('username');
  const item = await NewsItem.create({ title, body, createdBy: admin?.username || null });
  res.json({ success: true, item });
});

app.delete('/api/admin/news/:id', authMiddleware, requireAdmin, async (req, res) => {
  await NewsItem.deleteOne({ _id: req.params.id });
  res.json({ success: true });
});

// The one pair of routes a BLOCKED account can still use — checking why they were blocked and
// writing to admin about it. index.html calls the GET on load, before anything else, specifically
// so a blocked player never gets bounced through the normal 403->clear-token->login.html path.
app.get('/api/me/block-status', authMiddlewareAllowBlocked, async (req, res) => {
  const user = await User.findById(req.userId).select('isBlocked blockReason username');
  if (!user) return res.status(404).json({ error: 'user not found' });
  const conversation = await BlockConversation.findOne({ userId: user._id });
  res.json({
    isBlocked: user.isBlocked,
    blockReason: user.blockReason || null,
    messages: conversation ? conversation.messages : []
  });
});

app.post('/api/me/block-status/message', authMiddlewareAllowBlocked, async (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'missing message' });
  const user = await User.findById(req.userId).select('username');
  if (!user) return res.status(404).json({ error: 'user not found' });
  let conversation = await BlockConversation.findOne({ userId: user._id });
  if (!conversation) conversation = new BlockConversation({ userId: user._id, username: user.username, messages: [] });
  conversation.messages.push({ sender: 'player', text, at: new Date() });
  conversation.hasUnreadFromPlayer = true;
  await conversation.save();
  res.json({ success: true, messages: conversation.messages });
});

app.get('/api/admin/mailbox', authMiddleware, requireAdmin, async (req, res) => {
  const conversations = await BlockConversation.find({ 'messages.0': { $exists: true } }).sort({ updatedAt: -1 }).lean();
  const userIds = conversations.map((c) => c.userId);
  const users = await User.find({ _id: { $in: userIds } }).select('isBlocked blockReason username').lean();
  const usersById = new Map(users.map((u) => [String(u._id), u]));
  res.json(conversations.map((c) => {
    const user = usersById.get(String(c.userId));
    return {
      _id: c._id,
      userId: c.userId,
      username: c.username,
      isBlocked: user?.isBlocked || false,
      blockReason: user?.blockReason || null,
      messages: c.messages,
      hasUnreadFromPlayer: c.hasUnreadFromPlayer,
      updatedAt: c.updatedAt
    };
  }));
});

app.post('/api/admin/mailbox/:userId/reply', authMiddleware, requireAdmin, async (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'missing message' });
  const user = await User.findById(req.params.userId).select('username');
  if (!user) return res.status(404).json({ error: 'user not found' });
  let conversation = await BlockConversation.findOne({ userId: user._id });
  if (!conversation) conversation = new BlockConversation({ userId: user._id, username: user.username, messages: [] });
  conversation.messages.push({ sender: 'admin', text, at: new Date() });
  conversation.hasUnreadFromPlayer = false;
  await conversation.save();
  res.json({ success: true, messages: conversation.messages });
});

app.post('/api/admin/mailbox/:userId/mark-read', authMiddleware, requireAdmin, async (req, res) => {
  const conversation = await BlockConversation.findOne({ userId: req.params.userId });
  if (conversation && conversation.hasUnreadFromPlayer) {
    conversation.hasUnreadFromPlayer = false;
    await conversation.save();
  }
  res.json({ success: true });
});

// --- Monthly "regular rounds MMR" competition for the left-hand Turnieje ranking panel ---------
// Ranks everyone by Skill Points GAINED from regular (non-tournament, Pokoje Bitewne) rounds only
// this calendar month — accumulated directly in payoutRoundRewards as regularRoundsMmrPoints,
// never from tournament rounds. When the global ticket pool (see below) sells out, the top 5 by
// that measure get a direct semifinal pass, bypassing qualification rounds entirely — see
// maybeGrantRegularRoundsMmrReward.
async function getMmrWindowLeaderboard(limit, monthKey) {
  const targetMonthKey = monthKey || currentMonthKey();
  const users = await User.find({ regularRoundsMmrPointsMonthKey: targetMonthKey })
    .select('username regularRoundsMmrPoints isBot')
    .lean();
  // Bots always display (and rank) at 0 gained here — they can't win the direct-pass reward this
  // ranking exists to preview (see maybeGrantRegularRoundsMmrReward's own isBot filter), so showing
  // their real accumulated points would just be confusing/misleading on a competitive leaderboard.
  // Sorted/limited here in JS (not the DB query) because zeroing happens after the fetch.
  return users
    .map((u) => ({ username: u.username, isBot: !!u.isBot, gained: u.isBot ? 0 : (u.regularRoundsMmrPoints || 0) }))
    .sort((a, b) => b.gained - a.gained || a.username.localeCompare(b.username))
    .slice(0, limit);
}

// Called right after a ticket purchase brings the global pool to 0 — an atomic
// findOneAndUpdate claim (keyed on mmrRewardGrantedMonthKey still NOT matching this month) means
// two purchases that exhaust the pool in the same instant can't both grant the reward twice. Only
// REAL players who actually gained > 0 this window qualify — bots can appear on the displayed
// ranking (see getMmrWindowLeaderboard) but never get an actual semifinal pass, and running out
// the clock at 0 gained doesn't count as "competing" either. Fewer than 5 may qualify; that's
// fine, nobody undeserving skips qualification just to round out the list. The trigger point
// (ticket pool exhaustion) is shared with the qualification/ticket system purely because that's
// the only existing "this period is ending" signal — this reward itself has nothing to do with
// tickets otherwise.
async function maybeGrantRegularRoundsMmrReward(monthKey) {
  const targetMonthKey = monthKey || currentMonthKey();
  const claimed = await Settings.findOneAndUpdate(
    { singleton: 'main', mmrRewardGrantedMonthKey: { $ne: targetMonthKey } },
    { $set: { mmrRewardGrantedMonthKey: targetMonthKey } }
  );
  if (!claimed) return; // someone else already claimed it (or it's already been granted this month)

  // Generous limit so bots occupying top slots on the displayed ranking can't push real winners
  // out of consideration here — this runs once a month at most, performance isn't a concern.
  const top5 = (await getMmrWindowLeaderboard(1000, targetMonthKey)).filter((entry) => !entry.isBot && entry.gained > 0).slice(0, 5);
  if (!top5.length) return;
  await User.updateMany(
    { username: { $in: top5.map((e) => e.username) } },
    { $set: { semifinalDirectPass: true, semifinalDirectPassMonthKey: targetMonthKey } }
  );
  console.log(`Direct semifinal pass granted for ${targetMonthKey} to:`, top5.map((e) => `${e.username} (+${e.gained})`).join(', '));
}

// Flat consolation prize for the Free-Server-Ranking Top 5, paid at calendar month-end — separate
// from (and independent of) the semifinal wildcard pass above. Rewards whatever's in
// regularRoundsMmrPoints RIGHT NOW for the target month: if a tournament's qualification rounds
// finished this month, tournamentEngine.finalizeQualifications() already reset that counter to 0
// the moment it locked in the wildcards, so this only ever pays out the trailing days between that
// freeze and month-end; if no tournament ran at all this month, the counter was never reset, so
// this simply rewards the whole month — exactly the same fallback behavior maybeGrantRegularRoundsMmrReward
// already has, just with a real VPLN payout instead of an unusable semifinal-pass flag. Idempotent
// per month via Settings.freeRankingConsolationGrantedMonthKey, same CAS pattern as
// maybeGrantRegularRoundsMmrReward, plus MiniTournamentResults-style unique-index protection on the
// actual per-player payout so a retried call can never double-credit anyone.
// Nagroda pocieszenia w DOGE - Settings.freeRankingConsolationDoge (ustawiane przy przeliczeniu VPLN -> DOGE).
const FREE_RANKING_CONSOLATION_DEFAULT = 10;
async function grantFreeRankingConsolationPrize(monthKey) {
  const targetMonthKey = monthKey || currentMonthKey();
  const FREE_RANKING_CONSOLATION_VPLN = (await getSettings()).freeRankingConsolationDoge ?? FREE_RANKING_CONSOLATION_DEFAULT;
  const claimed = await Settings.findOneAndUpdate(
    { singleton: 'main', freeRankingConsolationGrantedMonthKey: { $ne: targetMonthKey } },
    { $set: { freeRankingConsolationGrantedMonthKey: targetMonthKey } }
  );
  if (!claimed) return;

  const top5 = (await getMmrWindowLeaderboard(1000, targetMonthKey)).filter((entry) => !entry.isBot && entry.gained > 0).slice(0, 5);
  if (!top5.length) return;
  const users = await User.find({ username: { $in: top5.map((e) => e.username) } }).select('username').lean();
  const usernameToId = new Map(users.map((u) => [u.username, u._id]));
  for (let i = 0; i < top5.length; i += 1) {
    const entry = top5[i];
    const userId = usernameToId.get(entry.username);
    if (!userId) continue;
    try {
      await FreeRankingConsolationResults.create({
        monthKey: targetMonthKey,
        userId,
        username: entry.username,
        rank: i + 1,
        pointsGained: entry.gained,
        vplnAwarded: FREE_RANKING_CONSOLATION_VPLN
      });
      await User.updateOne({ _id: userId }, { $inc: { dogeBalance: FREE_RANKING_CONSOLATION_VPLN } });
    } catch (err) {
      if (err && err.code === 11000) continue; // already paid for this month (idempotent retry)
      console.error(`Free-ranking consolation payout error (month ${targetMonthKey}, user ${entry.username})`, err);
    }
  }
  console.log(`Free-ranking consolation prize (${FREE_RANKING_CONSOLATION_VPLN} DOGE) granted for ${targetMonthKey} to:`, top5.map((e) => `${e.username} (+${e.gained})`).join(', '));
}

// Automatic monthly close for the Free-Server-Ranking wildcard reward: runs on a plain recurring
// interval (never a single long-delay setTimeout — this codebase has already hit raw setTimeout
// overflow past ~24.8 days on far-future delays, see armRegistrationCloseTimer) so it survives
// server restarts and any calendar-month length with no per-tournament scheduling involved. As
// soon as the server-local calendar rolls into a new month, the wildcard reward for the month that
// JUST ended is granted — idempotent via mmrRewardGrantedMonthKey inside
// maybeGrantRegularRoundsMmrReward — independent of ticket-pool exhaustion or qualification
// timing, which may finish any time during the month, or not run at all in a given month.
const FREE_RANKING_MONTH_CLOSE_POLL_MS = 15 * 60 * 1000;
function startFreeRankingMonthCloseWatcher() {
  const check = () => {
    maybeGrantRegularRoundsMmrReward(previousMonthKey()).catch((err) => console.error('Free-ranking month-close watcher error', err));
    grantFreeRankingConsolationPrize(previousMonthKey()).catch((err) => console.error('Free-ranking consolation watcher error', err));
  };
  check(); // catches a rollover that happened while the server was down
  setInterval(check, FREE_RANKING_MONTH_CLOSE_POLL_MS);
}

// The ticket pool size is admin-configurable per month now (see tournamentEngine.scheduleTournament
// -> Tournament.maxParticipants), since the room-assignment algorithm scales room count with it
// (always maxParticipants/10 rooms — see tournamentAssignment.js). Falls back to the fixed default
// below only when no tournament is currently open for registration (e.g. nothing scheduled yet).
async function getTicketPoolSize() {
  const tournament = await tournamentEngine.getCurrentTournament();
  if (tournament && tournament.status === 'SCHEDULED') return tournament.maxParticipants;
  return TOURNAMENT_TICKETS_MONTHLY_POOL;
}

const DEFAULT_TICKET_PRICE_PLN = 10;

// Same shape/fallback pattern as getTicketPoolSize() above — the current edition's own price if
// one is open for registration and has a price configured, otherwise the fixed platform default.
async function getTicketPricePLN() {
  const tournament = await tournamentEngine.getCurrentTournament();
  if (tournament && tournament.status === 'SCHEDULED' && tournament.ticketPricePLN) return tournament.ticketPricePLN;
  return (await getSettings()).tournamentTicketPriceDoge ?? DEFAULT_TICKET_PRICE_PLN;
}

// Resets `settings.tournamentTicketsSoldThisMonth` to 0 in place if the stored month key is
// stale, and returns how many of the GLOBAL monthly pool are left — this is one shared pool
// across every player, not a per-player allowance (see Settings.js).
async function remainingMonthlyTicketPool(settings) {
  const monthKey = currentMonthKey();
  if (settings.tournamentTicketsMonthKey !== monthKey) {
    settings.tournamentTicketsMonthKey = monthKey;
    settings.tournamentTicketsSoldThisMonth = 0;
  }
  const poolSize = await getTicketPoolSize();
  return poolSize - (settings.tournamentTicketsSoldThisMonth || 0);
}

// Mini-Tournament equivalent — a single, always-admin-configurable global pool (no per-edition
// override, unlike the Monthly Tournament one above). Only PURCHASES count against it; joining a
// room, leaving it (refund), and joining again are unlimited and untracked by date entirely — see
// User.hasUnusedMiniTournamentTicket, which has no monthKey of its own.
function remainingMiniTournamentTicketPool(settings) {
  const monthKey = currentMonthKey();
  if (settings.miniTournamentTicketsMonthKey !== monthKey) {
    settings.miniTournamentTicketsMonthKey = monthKey;
    settings.miniTournamentTicketsSoldThisMonth = 0;
  }
  return settings.miniTournamentTicketsMonthlyPool - (settings.miniTournamentTicketsSoldThisMonth || 0);
}

// Admin safety net: a hard cap on total REAL PLN collected via HotPay in a calendar month,
// independent of the ticket price/pool settings above — protects against a misconfigured price or
// pool still letting through more real-money revenue than intended, even if the price/pool math
// itself has a bug. Returns Infinity when no limit is set (0/null), so callers can compare a
// purchase amount against it uniformly. VPLN-settled purchases never count toward this.
function remainingHotpayRevenueLimit(settings) {
  const monthKey = currentMonthKey();
  if (settings.hotpayRevenueMonthKey !== monthKey) {
    settings.hotpayRevenueMonthKey = monthKey;
    settings.hotpayRevenueThisMonthPLN = 0;
  }
  if (!settings.hotpayMonthlyRevenueLimitPLN) return Infinity;
  return settings.hotpayMonthlyRevenueLimitPLN - (settings.hotpayRevenueThisMonthPLN || 0);
}

// --- Reserved "house" account for VPLN spent on tickets -----------------------------------------
// A player can pay for a ticket either with real money (HotPay, below) or by spending their own
// VPLN balance 1:1 (see the *-vpln endpoints further down, and regulamin.html §5c). Debited VPLN
// is credited here rather than simply destroyed, so the total VPLN "in the system" stays visible
// and auditable (via Panel Graczy, since this is an ordinary User document) instead of silently
// disappearing from the economy.
const VPLN_BANK_USERNAME = 'Skarbiec DOGE';
// Zakupy oplacone saldem gry (dawniej VPLN, teraz DOGE) - nie licza sie do przychodu HotPay.
const BALANCE_CURRENCIES = ['VPLN', 'DOGE'];
let vplnBankAccountIdCache = null;
async function getOrCreateVplnBankAccount() {
  if (vplnBankAccountIdCache) return vplnBankAccountIdCache;
  let acc = await User.findOne({ isSystemAccount: true });
  if (!acc) {
    acc = await User.create({
      username: VPLN_BANK_USERNAME,
      passwordHash: await bcrypt.hash(uuidv4() + uuidv4(), 10),
      isSystemAccount: true
    });
  }
  vplnBankAccountIdCache = acc._id;
  return acc._id;
}

// Sklep przyjmuje tylko saldo DOGE (ceny w DOGE) - kod HotPay zostaje, ale nowe platnosci PLN sa zablokowane.
const BALANCE_ONLY_SHOP = true;

// --- Real-money tournament ticket purchases via HotPay ------------------------------------------
// Replaces the old placeholder that granted tickets for free. Flow: create a pending TicketOrder
// + HotPay hosted-payment transaction (POST /tickets/create, "API zaawansowane z walidacją
// parametrów" per dokumentacja.hotpay.pl) -> player pays on HotPay's own page -> HotPay
// independently POSTs a server-to-server notification to /hotpay/notify carrying our own order id
// back as ID_ZAMOWIENIA. HotPay exposes no endpoint to re-query a payment's status — the
// notification is the ONLY source of truth, so the return-page status poll
// (GET /tickets/:orderId/status) just reads whatever this webhook has already recorded.

// Side effects of a Monthly Tournament TicketOrder just having been confirmed 'paid' — shared by
// both the HotPay path (applyTicketOrderNotification below) and the instant VPLN payment path
// (POST /tickets/create-vpln). Takes the already-claimed (status:'paid') order document; never
// re-checks eligibility itself, that's the caller's job before the order was even created/claimed.
async function grantTournamentTicketOrder(claimed) {
  const settings = await getSettings();
  const remainingPool = await remainingMonthlyTicketPool(settings);
  // Referral count only ever needs checking the FIRST time this account ever buys a Monthly
  // Tournament ticket — a repeat purchase (already hasBoughtTournamentTicket) can't newly cross
  // any threshold. Same pattern as grantMiniTournamentTicketOrder below.
  const buyer = await User.findById(claimed.userId).select('hasBoughtTournamentTicket referredBy');
  await User.updateOne({ _id: claimed.userId }, { $inc: { tournamentTickets: claimed.quantity }, $set: { hasBoughtTournamentTicket: true } });
  settings.tournamentTicketsSoldThisMonth = (settings.tournamentTicketsSoldThisMonth || 0) + claimed.quantity;
  // Revenue safety-net counter — only real HotPay money counts, never VPLN-settled purchases.
  if (!BALANCE_CURRENCIES.includes(claimed.currency)) {
    remainingHotpayRevenueLimit(settings); // lazy monthKey reset, if needed
    settings.hotpayRevenueThisMonthPLN = (settings.hotpayRevenueThisMonthPLN || 0) + claimed.grossAmountZl;
  }
  await settings.save();
  if (remainingPool - claimed.quantity <= 0) {
    maybeGrantRegularRoundsMmrReward().catch((err) => console.error('maybeGrantRegularRoundsMmrReward error', err));
  }
  if (buyer && !buyer.hasBoughtTournamentTicket && buyer.referredBy) {
    maybeGrantReferralReward(buyer.referredBy).catch((err) => console.error('maybeGrantReferralReward error', err));
  }
  // A confirmed ticket purchase also registers the buyer for this month's Monthly Tournament,
  // if one is currently open for registration (see tournamentEngine.js) — no-op, never throws,
  // if there isn't one scheduled yet, so the ticket purchase itself always still succeeds.
  tournamentEngine.registerParticipant(claimed.userId, claimed.paidAt).catch((err) => console.error('tournamentEngine.registerParticipant error', err));
}

// Applies a HotPay notification's outcome to a still-pending order and grants the tickets exactly
// once if (and only if) HotPay reported STATUS SUCCESS. Never grants based on anything the caller
// merely claims — this is only ever invoked from the signature-verified webhook below. Atomic
// claim via findOneAndUpdate's `status: 'pending'` guard means a retried/duplicate notification
// for the same payment can't double-credit. Returns the up-to-date order document.
async function applyTicketOrderNotification(order, { hotpayStatus, hotpayPaymentId, notifiedAmountZl }) {
  if (!order || order.status !== 'pending') return order;
  // Sanity check only, never blocking — the HASH already cryptographically binds KWOTA to our
  // shared secret, so a mismatch here can't be a forged notification, only a HotPay-side surprise
  // worth flagging for bookkeeping (see the tax-record retention comment above buildPaymentsQuery).
  if (hotpayStatus === 'SUCCESS' && Number(notifiedAmountZl) !== order.grossAmountZl) {
    console.error(`HotPay notification amount mismatch for order ${order._id}: expected ${order.grossAmountZl}, HotPay reported ${notifiedAmountZl}`);
  }
  if (hotpayStatus === 'SUCCESS') {
    const claimed = await TicketOrder.findOneAndUpdate(
      { _id: order._id, status: 'pending' },
      { status: 'paid', paidAt: new Date(), hotpayPaymentId, lastHotpayStatus: hotpayStatus },
      { new: true }
    );
    if (claimed) {
      await grantTournamentTicketOrder(claimed);
    }
    return claimed || (await TicketOrder.findById(order._id));
  }
  if (hotpayStatus === 'FAILURE') {
    order.status = 'failed';
    order.hotpayPaymentId = hotpayPaymentId;
    order.lastHotpayStatus = hotpayStatus;
    await order.save();
    return order;
  }
  // PENDING — leave the order pending, just record the latest known status/payment id.
  order.hotpayPaymentId = hotpayPaymentId;
  order.lastHotpayStatus = hotpayStatus;
  await order.save();
  return order;
}

// Lets sklep-bilety.html disable the buy button and explain why BEFORE the player clicks (rather
// than only finding out after submitting), without duplicating the actual limit-check logic —
// this reuses the exact same query as the enforcement check in POST /tickets/create below.
app.get('/api/payments/tickets/eligibility', authMiddleware, async (req, res) => {
  const alreadyPurchasedThisMonth = await TicketOrder.findOne({
    userId: req.userId,
    status: 'paid',
    paidAt: { $gte: startOfCurrentMonth() }
  });
  const now = new Date();
  const nextResetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  res.json({ canPurchase: !alreadyPurchasedThisMonth, nextResetAt });
});

app.post('/api/payments/tickets/create', authMiddleware, async (req, res) => {
  // Ceny sa w DOGE - platnosc w PLN pobralaby zla kwote.
  if (BALANCE_ONLY_SHOP) return res.status(410).json({ error: 'Płatności w PLN są wyłączone — kup bilet za saldo DOGE.' });
  if (!hotpay.isConfigured()) {
    return res.status(503).json({ error: 'Płatności są chwilowo niedostępne. Spróbuj później.' });
  }
  const settings = await getSettings();
  if (!settings.shopEnabled) return res.status(403).json({ error: 'Sklep jest tymczasowo wyłączony.' });
  // Guaranteed-prize-pool requirement: a ticket can only be bought while there's a currently open
  // edition whose VPLN prize breakdown has actually been configured by an admin — a player must
  // always be able to see the exact prize they're competing for before buying (see
  // GET /api/settings/tournament-tickets and turnieje.html's prize card).
  const openTournament = await tournamentEngine.getCurrentTournament();
  if (!openTournament || openTournament.status !== 'SCHEDULED' || !openTournament.prizesConfig || !openTournament.prizesConfig.configuredAt) {
    return res.status(400).json({ error: 'Turniej nie jest obecnie otwarty do zapisów.' });
  }
  if (openTournament.salesPausedByAdmin) {
    return res.status(400).json({ error: 'Sprzedaż biletów turniejowych jest tymczasowo wstrzymana przez administrację.' });
  }
  const { quantity, consentAccepted } = req.body;
  if (consentAccepted !== true) return res.status(400).json({ error: 'Wymagana jest akceptacja zgody na natychmiastowe rozpoczęcie świadczenia usługi.' });
  const qty = Number(quantity);
  // Only single-ticket purchases are on sale right now — packages of 2-5 are disabled in the shop
  // UI (see sklep-bilety.html) and rejected here too, so the restriction can't be bypassed by
  // calling this endpoint directly.
  if (qty !== 1) return res.status(400).json({ error: 'W tej chwili można kupić tylko 1 bilet na raz.' });
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  // Per-player cap: one ticket per calendar month, resetting the 1st (separate from the GLOBAL
  // monthly pool checked below, which limits total tickets sold across everyone).
  const alreadyPurchasedThisMonth = await TicketOrder.findOne({
    userId: user._id,
    status: 'paid',
    paidAt: { $gte: startOfCurrentMonth() }
  });
  if (alreadyPurchasedThisMonth) {
    return res.status(400).json({ error: 'Możesz kupić tylko jeden bilet turniejowy w miesiącu kalendarzowym. Limit odnawia się 1. dnia kolejnego miesiąca.' });
  }
  const remainingPool = await remainingMonthlyTicketPool(settings);
  await settings.save(); // persists the lazy monthly-key reset from remainingMonthlyTicketPool, even though sold count only changes on actual payment
  if (qty > remainingPool) {
    return res.status(400).json({ error: `Miesięczna pula biletów turniejowych się kończy. Dostępnych: ${Math.max(0, remainingPool)}.` });
  }
  const grossAmountZl = qty * (await getTicketPricePLN());
  // Safety-net check, independent of the ticket-pool check above — protects against a misconfigured
  // price/pool still letting through more real-money revenue than the admin intends this month.
  const remainingRevenue = remainingHotpayRevenueLimit(settings);
  await settings.save(); // persists the lazy monthly-key reset from remainingHotpayRevenueLimit
  if (grossAmountZl > remainingRevenue) {
    return res.status(400).json({ error: 'Miesięczny limit wpłat został osiągnięty. Spróbuj ponownie w kolejnym miesiącu lub skontaktuj się z administracją.' });
  }
  const order = await TicketOrder.create({ userId: user._id, quantity: qty, grossAmountZl });
  const baseUrl = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  try {
    const payment = await hotpay.createPayment({
      serviceName: `War of Lords — ${qty} ${qty === 1 ? 'bilet turniejowy' : 'biletów turniejowych'}`,
      amountZl: grossAmountZl,
      returnUrl: `${baseUrl}/platnosc-status.html?order=${order._id}`,
      orderId: order._id.toString(),
      email: user.email || undefined
    });
    res.json({ orderId: order._id, redirectUrl: payment.url });
  } catch (err) {
    console.error('HotPay createPayment error', err);
    order.status = 'failed';
    await order.save();
    res.status(502).json({ error: 'Nie udało się rozpocząć płatności. Spróbuj ponownie później.' });
  }
});

// Alternative to the HotPay flow above: pay for the exact same Bilet Turniejowy by spending owned
// VPLN balance instead, 1:1 with the real-money price (see regulamin.html §5c) — no redirect, no
// external gateway, granted instantly. Every eligibility rule is identical to the real-money path
// (shop enabled, tournament open for registration, sales not paused, per-month cap, monthly pool) —
// paying with VPLN is just a different way to settle the SAME purchase, not a separate quota.
app.post('/api/payments/tickets/create-vpln', authMiddleware, async (req, res) => {
  const settings = await getSettings();
  if (!settings.shopEnabled) return res.status(403).json({ error: 'Sklep jest tymczasowo wyłączony.' });
  const openTournament = await tournamentEngine.getCurrentTournament();
  if (!openTournament || openTournament.status !== 'SCHEDULED' || !openTournament.prizesConfig || !openTournament.prizesConfig.configuredAt) {
    return res.status(400).json({ error: 'Turniej nie jest obecnie otwarty do zapisów.' });
  }
  if (openTournament.salesPausedByAdmin) {
    return res.status(400).json({ error: 'Sprzedaż biletów turniejowych jest tymczasowo wstrzymana przez administrację.' });
  }
  const { consentAccepted } = req.body;
  if (consentAccepted !== true) return res.status(400).json({ error: 'Wymagana jest akceptacja zgody na natychmiastowe rozpoczęcie świadczenia usługi.' });
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const alreadyPurchasedThisMonth = await TicketOrder.findOne({
    userId: user._id,
    status: 'paid',
    paidAt: { $gte: startOfCurrentMonth() }
  });
  if (alreadyPurchasedThisMonth) {
    return res.status(400).json({ error: 'Możesz kupić tylko jeden bilet turniejowy w miesiącu kalendarzowym. Limit odnawia się 1. dnia kolejnego miesiąca.' });
  }
  const remainingPool = await remainingMonthlyTicketPool(settings);
  await settings.save();
  if (remainingPool < 1) {
    return res.status(400).json({ error: `Miesięczna pula biletów turniejowych się kończy. Dostępnych: ${Math.max(0, remainingPool)}.` });
  }
  const priceVpln = await getTicketPricePLN();
  // Atomic debit — the $gte guard means a race between two simultaneous VPLN spends (a ticket
  // purchase racing a withdrawal request, say) can never let the balance go negative.
  const debited = await User.findOneAndUpdate(
    { _id: user._id, dogeBalance: { $gte: priceVpln } },
    { $inc: { dogeBalance: -priceVpln } },
    { new: true }
  );
  if (!debited) return res.status(400).json({ error: 'Niewystarczające saldo DOGE.' });
  const bankAccountId = await getOrCreateVplnBankAccount();
  await User.updateOne({ _id: bankAccountId }, { $inc: { dogeBalance: priceVpln } });
  const claimed = await TicketOrder.create({
    userId: user._id, quantity: 1, grossAmountZl: priceVpln, currency: 'DOGE',
    status: 'paid', paidAt: new Date()
  });
  await grantTournamentTicketOrder(claimed);
  res.json({ success: true, orderId: claimed._id, dogeBalance: debited.dogeBalance, tournamentTickets: (user.tournamentTickets || 0) + 1 });
});

// Player-facing: platnosc-status.html polls this after being redirected back from HotPay. HotPay
// has no endpoint to actively re-query a payment's status, so this just reads whatever the
// signature-verified webhook below has already recorded — no re-check happens here.
app.get('/api/payments/tickets/:orderId/status', authMiddleware, async (req, res) => {
  const order = await TicketOrder.findOne({ _id: req.params.orderId, userId: req.userId });
  if (!order) return res.status(404).json({ error: 'order not found' });
  res.json({ status: order.status, quantity: order.quantity, grossAmountZl: order.grossAmountZl });
});

// Server-to-server: HotPay calls this directly (not through the player's browser) the moment a
// transaction's status changes. Per HotPay's official spec (dokumentacja.hotpay.pl, "API
// zaawansowane z walidacją parametrów"), every notification is a POST with multipart/form-data
// fields SEKRET/KWOTA/STATUS/ID_ZAMOWIENIA/ID_PLATNOSCI/SECURE/HASH — ID_ZAMOWIENIA is exactly the
// order id we sent HotPay at creation, so orders are looked up by their own _id here, not by a
// separate payment id (HotPay never hands one back until this notification). Public route (no
// authMiddleware — HotPay isn't a logged-in player) but every request is signature-verified before
// anything is trusted, and HotPay has no status-query endpoint to fall back on if this is missed —
// this webhook is the ONLY source of truth for a payment's outcome.
app.post('/api/payments/hotpay/notify', hotpayNotifyParser, async (req, res) => {
  const { SEKRET, KWOTA, STATUS, ID_ZAMOWIENIA, ID_PLATNOSCI, SECURE, HASH } = req.body || {};
  if (!hotpay.verifyNotificationSignature({ kwota: KWOTA, idPlatnosci: ID_PLATNOSCI, idZamowienia: ID_ZAMOWIENIA, status: STATUS, secure: SECURE, sekret: SEKRET, hash: HASH })) {
    // Diagnostic dump — never logs either configured secret's raw value, only whether specific
    // hypotheses (wrong SEKRET echoed back, a whitespace-trim fix) would explain the mismatch.
    console.error('HotPay notification: signature verification failed', {
      idZamowienia: ID_ZAMOWIENIA, ip: req.ip, contentType: req.headers['content-type'],
      kwota: KWOTA, status: STATUS, idPlatnosci: ID_PLATNOSCI,
      diagnosis: hotpay.diagnoseNotificationMismatch({ kwota: KWOTA, idPlatnosci: ID_PLATNOSCI, idZamowienia: ID_ZAMOWIENIA, status: STATUS, secure: SECURE, sekret: SEKRET, hash: HASH })
    });
    return res.status(400).send('invalid signature');
  }
  try {
    const order = await TicketOrder.findById(ID_ZAMOWIENIA).catch(() => null);
    if (order) {
      await applyTicketOrderNotification(order, { hotpayStatus: STATUS, hotpayPaymentId: ID_PLATNOSCI, notifiedAmountZl: KWOTA });
    } else {
      // Not a Monthly Tournament ticket — check whether it's a Mini-Tournament one instead. Both
      // product types share this one HotPay webhook URL rather than needing a second one
      // registered separately in HotPay's panel.
      const miniOrder = await MiniTournamentTicketOrder.findById(ID_ZAMOWIENIA).catch(() => null);
      if (miniOrder) await applyMiniTicketOrderNotification(miniOrder, { hotpayStatus: STATUS, hotpayPaymentId: ID_PLATNOSCI, notifiedAmountZl: KWOTA });
      else console.error('HotPay notification: no matching order for ID_ZAMOWIENIA', ID_ZAMOWIENIA);
    }
  } catch (err) {
    console.error('HotPay notification handling error', err);
  }
  res.status(200).send('OK');
});

// --- Mini-Tournament tickets via HotPay ----------------------------------------------------------
// Same create -> pay-on-HotPay -> notify -> finalize shape as the Monthly Tournament ticket
// flow just above, deliberately duplicated rather than parameterized: the two products have
// different eligibility rules (max ONE unused ticket at a time vs. once-per-month-per-pool) and
// different post-payment side effects (referral-milestone check vs. tournament registration), and
// keeping them as separate, independently-readable code paths means a future change to one can
// never silently affect the other.

// Milestone reward check — called every time a REFERRED player's Mini-Tournament ticket purchase is
// confirmed paid. Re-derives the referrer's current qualifying count fresh each time (distinct
// referred users with hasBoughtMiniTournamentTicket:true) rather than trusting a running counter, so
// the only thing preventing a double-payout is the ReferralReward unique index — see that model's
// comment. Awards every milestone of 10 the referrer has reached but not yet been paid for (almost
// always just one, but a loop covers the rare case of catching up after a gap).
async function maybeGrantReferralReward(referrerUserId) {
  if (!referrerUserId) return;
  // Either ticket type qualifies (Monthly Tournament OR Mini-Turniej) — a referred player only ever
  // needs to buy ONE ticket, of either kind, to count. $or with countDocuments still counts each
  // matching USER once, even if they happen to satisfy both conditions.
  const qualifyingCount = await User.countDocuments({
    referredBy: referrerUserId,
    $or: [{ hasBoughtMiniTournamentTicket: true }, { hasBoughtTournamentTicket: true }]
  });
  const highestReachedMilestone = Math.floor(qualifyingCount / 10) * 10;
  if (highestReachedMilestone < 10) return;
  const alreadyPaid = await ReferralReward.find({ referrerUserId, milestone: { $lte: highestReachedMilestone } }).select('milestone');
  const paidMilestones = new Set(alreadyPaid.map((r) => r.milestone));
  for (let milestone = 10; milestone <= highestReachedMilestone; milestone += 10) {
    if (paidMilestones.has(milestone)) continue;
    // Paid out 100% gross — no tax withheld (see regulamin.html §5b / TournamentResults.js comment).
    try {
      const reward = (await getSettings()).referralRewardDoge ?? 10;
      await ReferralReward.create({ referrerUserId, milestone, vplnAwarded: reward });
      await User.updateOne({ _id: referrerUserId }, { $inc: { dogeBalance: reward } });
    } catch (err) {
      if (err && err.code === 11000) continue; // another concurrent call already claimed this milestone
      console.error('maybeGrantReferralReward error', err);
    }
  }
}

// Side effects of a Mini-Tournament ticket order just having been confirmed 'paid' — shared by both
// the HotPay path (applyMiniTicketOrderNotification below) and the instant VPLN payment path
// (POST /mini-tickets/create-vpln). Same "no eligibility re-check" contract as
// grantTournamentTicketOrder above.
async function grantMiniTournamentTicketOrder(claimed) {
  const user = await User.findById(claimed.userId).select('hasBoughtMiniTournamentTicket referredBy');
  await User.updateOne({ _id: claimed.userId }, { hasUnusedMiniTournamentTicket: true, hasBoughtMiniTournamentTicket: true });
  const settings = await getSettings();
  remainingMiniTournamentTicketPool(settings); // lazy monthKey reset, if needed
  settings.miniTournamentTicketsSoldThisMonth = (settings.miniTournamentTicketsSoldThisMonth || 0) + 1;
  if (!BALANCE_CURRENCIES.includes(claimed.currency)) {
    remainingHotpayRevenueLimit(settings); // lazy monthKey reset, if needed
    settings.hotpayRevenueThisMonthPLN = (settings.hotpayRevenueThisMonthPLN || 0) + claimed.grossAmountZl;
  }
  await settings.save();
  // Referral count only ever needs checking the FIRST time this account ever buys a ticket —
  // a repeat purchase (already hasBoughtMiniTournamentTicket) can't newly cross any threshold.
  if (user && !user.hasBoughtMiniTournamentTicket && user.referredBy) {
    maybeGrantReferralReward(user.referredBy).catch((err) => console.error('maybeGrantReferralReward error', err));
  }
}

async function applyMiniTicketOrderNotification(order, { hotpayStatus, hotpayPaymentId, notifiedAmountZl }) {
  if (!order || order.status !== 'pending') return order;
  if (hotpayStatus === 'SUCCESS' && Number(notifiedAmountZl) !== order.grossAmountZl) {
    console.error(`HotPay notification amount mismatch for mini-ticket order ${order._id}: expected ${order.grossAmountZl}, HotPay reported ${notifiedAmountZl}`);
  }
  if (hotpayStatus === 'SUCCESS') {
    const claimed = await MiniTournamentTicketOrder.findOneAndUpdate(
      { _id: order._id, status: 'pending' },
      { status: 'paid', paidAt: new Date(), hotpayPaymentId, lastHotpayStatus: hotpayStatus },
      { new: true }
    );
    if (claimed) {
      await grantMiniTournamentTicketOrder(claimed);
    }
    return claimed || (await MiniTournamentTicketOrder.findById(order._id));
  }
  if (hotpayStatus === 'FAILURE') {
    order.status = 'failed';
    order.hotpayPaymentId = hotpayPaymentId;
    order.lastHotpayStatus = hotpayStatus;
    await order.save();
    return order;
  }
  order.hotpayPaymentId = hotpayPaymentId;
  order.lastHotpayStatus = hotpayStatus;
  await order.save();
  return order;
}

app.post('/api/payments/mini-tickets/create', authMiddleware, async (req, res) => {
  if (BALANCE_ONLY_SHOP) return res.status(410).json({ error: 'Płatności w PLN są wyłączone — kup bilet za saldo DOGE.' });
  if (!hotpay.isConfigured()) {
    return res.status(503).json({ error: 'Płatności są chwilowo niedostępne. Spróbuj później.' });
  }
  const settings = await getSettings();
  if (!settings.shopEnabled) return res.status(403).json({ error: 'Sklep jest tymczasowo wyłączony.' });
  const { consentAccepted } = req.body;
  if (consentAccepted !== true) return res.status(400).json({ error: 'Wymagana jest akceptacja zgody na natychmiastowe rozpoczęcie świadczenia usługi.' });
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (user.hasUnusedMiniTournamentTicket) {
    return res.status(400).json({ error: 'Masz już niewykorzystany Bilet do Mini-Turnieju — możesz mieć tylko jeden naraz.' });
  }
  // sklep-bilety.html's checkMiniTournamentAvailability already hides the buy button client-side
  // when GET /api/rooms?miniTournament=1 returns none, but this endpoint itself never enforced it —
  // a player could still spend real money (or VPLN) on a ticket usable in zero currently-open rooms.
  // The mobile app's shop never even had the client-side check, so this was the only real guard.
  const anyMiniTournamentRoomOpen = await Room.exists({ enabled: { $ne: false }, isMiniTournament: true });
  if (!anyMiniTournamentRoomOpen) {
    return res.status(400).json({ error: 'Brak aktualnie dostępnych Mini-Turniejów. Spróbuj ponownie, gdy administracja utworzy nowy pokój.' });
  }
  const remainingPool = remainingMiniTournamentTicketPool(settings);
  await settings.save(); // persists the lazy monthly-key reset above, even though the sold count only changes on actual payment
  if (remainingPool <= 0) {
    return res.status(400).json({ error: 'Miesięczna pula Biletów do Mini-Turnieju się wyczerpała. Spróbuj ponownie w kolejnym miesiącu.' });
  }
  const grossAmountZl = settings.miniTournamentTicketPricePLN;
  // Safety-net check, independent of the ticket-pool check above — see the equivalent check in
  // POST /tickets/create for why this exists.
  const remainingRevenue = remainingHotpayRevenueLimit(settings);
  await settings.save();
  if (grossAmountZl > remainingRevenue) {
    return res.status(400).json({ error: 'Miesięczny limit wpłat został osiągnięty. Spróbuj ponownie w kolejnym miesiącu lub skontaktuj się z administracją.' });
  }
  const order = await MiniTournamentTicketOrder.create({ userId: user._id, grossAmountZl });
  const baseUrl = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  try {
    const payment = await hotpay.createPayment({
      serviceName: 'War of Lords — Bilet do Mini-Turnieju',
      amountZl: grossAmountZl,
      returnUrl: `${baseUrl}/platnosc-status.html?order=${order._id}&type=mini`,
      orderId: order._id.toString(),
      email: user.email || undefined
    });
    res.json({ orderId: order._id, redirectUrl: payment.url });
  } catch (err) {
    console.error('HotPay createPayment (mini-ticket) error', err);
    order.status = 'failed';
    await order.save();
    res.status(502).json({ error: 'Nie udało się rozpocząć płatności. Spróbuj ponownie później.' });
  }
});

// VPLN equivalent of the HotPay flow above — same eligibility rules, no redirect, granted
// instantly. See the Monthly Tournament ticket's create-vpln endpoint above for the shared pattern.
app.post('/api/payments/mini-tickets/create-vpln', authMiddleware, async (req, res) => {
  const settings = await getSettings();
  if (!settings.shopEnabled) return res.status(403).json({ error: 'Sklep jest tymczasowo wyłączony.' });
  const { consentAccepted } = req.body;
  if (consentAccepted !== true) return res.status(400).json({ error: 'Wymagana jest akceptacja zgody na natychmiastowe rozpoczęcie świadczenia usługi.' });
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (user.hasUnusedMiniTournamentTicket) {
    return res.status(400).json({ error: 'Masz już niewykorzystany Bilet do Mini-Turnieju — możesz mieć tylko jeden naraz.' });
  }
  // Same guard as the HotPay create endpoint above - see its comment.
  const anyMiniTournamentRoomOpen = await Room.exists({ enabled: { $ne: false }, isMiniTournament: true });
  if (!anyMiniTournamentRoomOpen) {
    return res.status(400).json({ error: 'Brak aktualnie dostępnych Mini-Turniejów. Spróbuj ponownie, gdy administracja utworzy nowy pokój.' });
  }
  const remainingPool = remainingMiniTournamentTicketPool(settings);
  await settings.save();
  if (remainingPool <= 0) {
    return res.status(400).json({ error: 'Miesięczna pula Biletów do Mini-Turnieju się wyczerpała. Spróbuj ponownie w kolejnym miesiącu.' });
  }
  const priceVpln = settings.miniTournamentTicketPricePLN;
  const debited = await User.findOneAndUpdate(
    { _id: user._id, dogeBalance: { $gte: priceVpln } },
    { $inc: { dogeBalance: -priceVpln } },
    { new: true }
  );
  if (!debited) return res.status(400).json({ error: 'Niewystarczające saldo DOGE.' });
  const bankAccountId = await getOrCreateVplnBankAccount();
  await User.updateOne({ _id: bankAccountId }, { $inc: { dogeBalance: priceVpln } });
  const claimed = await MiniTournamentTicketOrder.create({
    userId: user._id, grossAmountZl: priceVpln, currency: 'DOGE',
    status: 'paid', paidAt: new Date()
  });
  await grantMiniTournamentTicketOrder(claimed);
  res.json({ success: true, orderId: claimed._id, dogeBalance: debited.dogeBalance });
});

app.get('/api/payments/mini-tickets/:orderId/status', authMiddleware, async (req, res) => {
  const order = await MiniTournamentTicketOrder.findOne({ _id: req.params.orderId, userId: req.userId });
  if (!order) return res.status(404).json({ error: 'order not found' });
  res.json({ status: order.status, grossAmountZl: order.grossAmountZl });
});

// --- VPLN -> PLN withdrawals ---------------------------------------------------------------------
// Lets a player convert VPLN prize money (paid out 100% gross, no tax withheld — the Usługodawca
// is a private individual, not a "płatnik" under art. 41 ustawy o PIT; the winner self-reports, see
// regulamin.html §5b) into an actual bank transfer. There is no payment-gateway integration for
// outbound transfers, so this is an admin-mediated queue: the VPLN is debited immediately
// (atomically, see the $gte guard below) so it can never be double-spent while a request sits
// pending, and an admin executes the real transfer manually before marking it COMPLETED (or
// REJECTED, which refunds the balance) — see the admin endpoints further down.

app.post('/api/withdrawals/request', authMiddleware, async (req, res) => {
  // Wyplaty na konto bankowe zastapione wyplatami DOGE (POST /api/doge/withdraw).
  if (BALANCE_ONLY_SHOP) return res.status(410).json({ error: 'Wypłaty na konto bankowe zostały zastąpione wypłatami DOGE (Portfel).' });
  const { vplnAmount, bankAccountNumber, accountHolderName, taxResponsibilityAccepted, ageConfirmationType } = req.body;
  const amount = Math.round(Number(vplnAmount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Nieprawidłowa kwota.' });
  }
  const account = String(bankAccountNumber || '').trim();
  const holderName = String(accountHolderName || '').trim();
  if (!account) return res.status(400).json({ error: 'Podaj numer konta bankowego.' });
  if (!holderName) return res.status(400).json({ error: 'Podaj imię i nazwisko właściciela konta.' });
  // Required, timestamped acknowledgment that the full gross amount is being paid out and the
  // player alone is responsible for declaring it on their own PIT return (see regulamin.html §5b
  // and WithdrawalRequest.js) — the Usługodawca is a private individual with no płatnik status.
  if (taxResponsibilityAccepted !== true) {
    return res.status(400).json({ error: 'Wymagane jest potwierdzenie, że samodzielnie rozliczysz tę wygraną w swoim zeznaniu PIT.' });
  }
  // Required legal-capacity declaration — a real bank transfer, unlike ordinary gameplay, needs an
  // explicit statement of who is legally receiving the money (see WithdrawalRequest.js).
  if (!['ADULT', 'GUARDIAN_CONSENT'].includes(ageConfirmationType)) {
    return res.status(400).json({ error: 'Wymagane jest potwierdzenie pełnoletności albo zgody opiekuna prawnego.' });
  }

  const settings = await getSettings();
  const minWithdrawal = settings.minWithdrawalVpln || 100;
  if (amount < minWithdrawal) {
    return res.status(400).json({ error: `Minimalna kwota wypłaty to ${minWithdrawal} VPLN.` });
  }

  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'user not found' });

  // Atomic debit — the $gte guard means a race between two simultaneous withdrawal requests (or a
  // withdrawal racing a ticket purchase) can never let the balance go negative.
  const debited = await User.findOneAndUpdate(
    { _id: user._id, vplnBalance: { $gte: amount } },
    { $inc: { vplnBalance: -amount } },
    { new: true }
  );
  if (!debited) return res.status(400).json({ error: 'Niewystarczające saldo DOGE.' });

  const request = await WithdrawalRequest.create({
    userId: user._id,
    username: user.username,
    vplnAmount: amount,
    bankAccountNumber: account,
    accountHolderName: holderName,
    transferTitle: `Wyplata wygranej w grze War of Lords - login: ${user.username}`,
    taxResponsibilityAcknowledgedAt: new Date(),
    ageConfirmationType,
    ageConfirmedAt: new Date()
  });
  res.json({ requestId: request._id, status: request.status, vplnBalance: debited.vplnBalance });
});

app.get('/api/withdrawals/my', authMiddleware, async (req, res) => {
  const requests = await WithdrawalRequest.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(100);
  res.json({ requests });
});


// --- Portfel DOGE: wplaty i wyplaty on-chain ------------------------------------------------------
// Saldo gracza (User.dogeBalance) jest wirtualne - prawdziwe DOGE leza na portfelu gry
// (DOGE_DEPOSIT_ADDRESS w .env). Klucze prywatne NIGDY nie trafiaja do kodu ani bazy: wplaty
// i wyplaty potwierdza administrator po sprawdzeniu transakcji w sieci (panel /admin/doge).
//  - wplata: gracz wysyla DOGE na adres gry i zglasza hash transakcji -> pending; saldo rosnie,
//    gdy administrator potwierdzi kwote widoczna w sieci (completed),
//  - wyplata: saldo pobierane od razu (atomowo, jak dawne wyplaty VPLN) -> pending; administrator
//    wysyla DOGE i wpisuje hash (completed) albo odrzuca z powodem (failed, kwota wraca na saldo).
const MAX_PENDING_DEPOSITS = 5;

function dogeDepositAddress() {
  const address = String(process.env.DOGE_DEPOSIT_ADDRESS || '').trim();
  return doge.isValidDogeAddress(address) ? address : null;
}

function publicDogeTransaction(t) {
  return {
    _id: t._id, type: t.type, amount: t.amount, status: t.status, txHash: t.txHash,
    address: t.address, adminNote: t.adminNote, createdAt: t.createdAt, processedAt: t.processedAt
  };
}

app.get('/api/doge/wallet', authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId).select('dogeBalance dogeAddress');
  if (!user) return res.status(404).json({ error: 'user not found' });
  const [settings, transactions] = await Promise.all([
    getSettings(),
    DogeTransaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(50).lean()
  ]);
  res.json({
    dogeBalance: user.dogeBalance || 0,
    dogeAddress: user.dogeAddress || null,
    depositAddress: dogeDepositAddress(),
    minWithdrawal: settings.minWithdrawalVpln || 100,
    transactions: transactions.map(publicDogeTransaction)
  });
});

app.post('/api/doge/deposit', authMiddleware, async (req, res) => {
  const depositAddress = dogeDepositAddress();
  if (!depositAddress) return res.status(503).json({ error: 'Wpłaty DOGE są chwilowo niedostępne.' });
  const txHash = String(req.body.txHash || '').trim().toLowerCase();
  const amount = doge.roundDoge(req.body.amount);
  if (!doge.isValidTxHash(txHash)) return res.status(400).json({ error: 'Nieprawidłowy hash transakcji (64 znaki 0-9, a-f).' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Nieprawidłowa kwota.' });
  const user = await User.findById(req.userId).select('username');
  if (!user) return res.status(404).json({ error: 'user not found' });
  const pending = await DogeTransaction.countDocuments({ userId: user._id, type: 'deposit', status: 'pending' });
  if (pending >= MAX_PENDING_DEPOSITS) {
    return res.status(400).json({ error: 'Masz już 5 wpłat czekających na potwierdzenie. Poczekaj na ich weryfikację.' });
  }
  try {
    const tx = await DogeTransaction.create({ userId: user._id, username: user.username, type: 'deposit', amount, txHash, address: depositAddress });
    res.json({ success: true, transaction: publicDogeTransaction(tx) });
  } catch (err) {
    if (err && err.code === 11000) return res.status(400).json({ error: 'Ta transakcja została już zgłoszona.' });
    throw err;
  }
});

app.post('/api/doge/withdraw', authMiddleware, async (req, res) => {
  const { taxResponsibilityAccepted, ageConfirmationType } = req.body;
  const address = String(req.body.address || '').trim();
  const amount = doge.roundDoge(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Nieprawidłowa kwota.' });
  if (!doge.isValidDogeAddress(address)) return res.status(400).json({ error: 'Nieprawidłowy adres DOGE.' });
  if (address === dogeDepositAddress()) return res.status(400).json({ error: 'Nie można wypłacić na adres portfela gry.' });
  if (taxResponsibilityAccepted !== true) {
    return res.status(400).json({ error: 'Wymagane jest potwierdzenie, że samodzielnie rozliczysz tę wygraną w swoim zeznaniu PIT.' });
  }
  if (!['ADULT', 'GUARDIAN_CONSENT'].includes(ageConfirmationType)) {
    return res.status(400).json({ error: 'Wymagane jest potwierdzenie pełnoletności albo zgody opiekuna prawnego.' });
  }
  const settings = await getSettings();
  const minWithdrawal = settings.minWithdrawalVpln || 100;
  if (amount < minWithdrawal) return res.status(400).json({ error: `Minimalna kwota wypłaty to ${minWithdrawal} DOGE.` });

  const user = await User.findById(req.userId).select('username');
  if (!user) return res.status(404).json({ error: 'user not found' });
  // Atomowe pobranie - dwie rownoczesne wyplaty (albo wyplata i zakup) nie zejda ponizej zera.
  const debited = await User.findOneAndUpdate(
    { _id: user._id, dogeBalance: { $gte: amount } },
    { $inc: { dogeBalance: -amount }, $set: { dogeAddress: address } },
    { new: true }
  );
  if (!debited) return res.status(400).json({ error: 'Niewystarczające saldo DOGE.' });
  const tx = await DogeTransaction.create({
    userId: user._id, username: user.username, type: 'withdrawal', amount, address,
    taxResponsibilityAcknowledgedAt: new Date(), ageConfirmationType
  });
  res.json({ success: true, dogeBalance: debited.dogeBalance, transaction: publicDogeTransaction(tx) });
});

app.get('/api/admin/doge/transactions', authMiddleware, requireAdmin, async (req, res) => {
  const query = {};
  if (['pending', 'completed', 'failed'].includes(req.query.status)) query.status = req.query.status;
  if (['deposit', 'withdrawal'].includes(req.query.type)) query.type = req.query.type;
  const transactions = await DogeTransaction.find(query).sort({ createdAt: -1 }).limit(500).lean();
  res.json({ transactions, depositAddress: dogeDepositAddress() });
});

// Potwierdzenie: wplata - administrator wpisuje kwote faktycznie widoczna w sieci (moze roznic sie
// od zgloszonej) i dopiero wtedy saldo rosnie; wyplata - wymagany hash wyslanej transakcji.
app.put('/api/admin/doge/transactions/:id/complete', authMiddleware, requireAdmin, async (req, res) => {
  const tx = await DogeTransaction.findById(req.params.id);
  if (!tx || tx.status !== 'pending') return res.status(404).json({ error: 'Transakcja nie istnieje lub została już przetworzona.' });
  const update = { status: 'completed', processedAt: new Date(), processedByAdminId: req.user._id };
  if (tx.type === 'withdrawal') {
    const txHash = String(req.body.txHash || '').trim().toLowerCase();
    if (!doge.isValidTxHash(txHash)) return res.status(400).json({ error: 'Nieprawidłowy hash transakcji (64 znaki 0-9, a-f).' });
    update.txHash = txHash;
  } else {
    const amount = doge.roundDoge(req.body.amount ?? tx.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Nieprawidłowa kwota.' });
    update.amount = amount;
  }
  // Zmiana statusu jest blokada przed podwojnym kliknieciem - saldo tylko gdy to wywolanie ja wygralo.
  let claimed;
  try {
    claimed = await DogeTransaction.findOneAndUpdate({ _id: tx._id, status: 'pending' }, update, { new: true });
  } catch (err) {
    if (err && err.code === 11000) return res.status(400).json({ error: 'Ta transakcja została już zgłoszona.' });
    throw err;
  }
  if (!claimed) return res.status(404).json({ error: 'Transakcja nie istnieje lub została już przetworzona.' });
  if (claimed.type === 'deposit') await User.updateOne({ _id: claimed.userId }, { $inc: { dogeBalance: claimed.amount } });
  res.json({ success: true, transaction: claimed });
});

app.put('/api/admin/doge/transactions/:id/reject', authMiddleware, requireAdmin, async (req, res) => {
  const adminNote = String(req.body.adminNote || '').trim();
  if (!adminNote) return res.status(400).json({ error: 'Podaj powód odrzucenia — zobaczy go gracz.' });
  const claimed = await DogeTransaction.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    { status: 'failed', processedAt: new Date(), processedByAdminId: req.user._id, adminNote },
    { new: true }
  );
  if (!claimed) return res.status(404).json({ error: 'Transakcja nie istnieje lub została już przetworzona.' });
  // Odrzucona wyplata - DOGE nie wyszly z portfela gry, wiec kwota wraca na saldo gracza.
  if (claimed.type === 'withdrawal') await User.updateOne({ _id: claimed.userId }, { $inc: { dogeBalance: claimed.amount } });
  res.json({ success: true, transaction: claimed });
});

app.get('/api/settings/withdrawal', authMiddleware, async (req, res) => {
  const settings = await getSettings();
  res.json({ minWithdrawalVpln: settings.minWithdrawalVpln || 100, currency: 'DOGE' });
});

app.put('/api/admin/settings/withdrawal', authMiddleware, requireAdmin, async (req, res) => {
  const value = doge.roundDoge(req.body.minWithdrawalVpln);
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'Nieprawidłowa kwota.' });
  const settings = await getSettings();
  settings.minWithdrawalVpln = value;
  await settings.save();
  res.json({ success: true, minWithdrawalVpln: settings.minWithdrawalVpln });
});

// Admin-only safety-net cap on real HotPay revenue per month (see remainingHotpayRevenueLimit) —
// shown/edited in admin-platnosci.html, alongside how much has already been collected this month.
app.get('/api/admin/settings/hotpay-revenue-limit', authMiddleware, requireAdmin, async (req, res) => {
  const settings = await getSettings();
  const remaining = remainingHotpayRevenueLimit(settings);
  await settings.save(); // persists the lazy monthly-key reset, if it just happened
  res.json({
    limitPLN: settings.hotpayMonthlyRevenueLimitPLN || 0,
    revenueThisMonthPLN: settings.hotpayRevenueThisMonthPLN || 0,
    remainingPLN: Number.isFinite(remaining) ? remaining : null
  });
});

app.put('/api/admin/settings/hotpay-revenue-limit', authMiddleware, requireAdmin, async (req, res) => {
  const value = Math.round(Number(req.body.limitPLN));
  // 0 explicitly disables the cap (unlimited) — not a validation error, unlike the withdrawal
  // floor above which must always be positive.
  if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: 'Nieprawidłowa kwota.' });
  const settings = await getSettings();
  settings.hotpayMonthlyRevenueLimitPLN = value;
  await settings.save();
  res.json({ success: true, limitPLN: settings.hotpayMonthlyRevenueLimitPLN });
});

// --- Admin: process pending withdrawal requests --------------------------------------------------
// Same shape as buildPaymentsQuery above (date-range + status filter) — this is the direct payout-
// side counterpart of the "wpłaty" (deposits) ledger, letting the admin pull e.g. one calendar
// month's worth of withdrawal requests for bookkeeping the same way as with deposits.
function buildWithdrawalsQuery(req) {
  const query = {};
  if (req.query.status && ['PENDING', 'COMPLETED', 'REJECTED'].includes(req.query.status)) query.status = req.query.status;
  const dateField = req.query.dateField === 'processedAt' ? 'processedAt' : 'requestedAt';
  const range = {};
  if (req.query.from) range.$gte = new Date(req.query.from);
  if (req.query.to) range.$lte = new Date(req.query.to);
  if (Object.keys(range).length) query[dateField] = range;
  return query;
}

app.get('/api/admin/withdrawals', authMiddleware, requireAdmin, async (req, res) => {
  const query = buildWithdrawalsQuery(req);
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
  const requests = await WithdrawalRequest.find(query).sort({ requestedAt: -1 }).limit(limit);
  const totals = await WithdrawalRequest.aggregate([
    { $match: { ...query, status: 'COMPLETED' } },
    { $group: { _id: null, count: { $sum: 1 }, vplnAmount: { $sum: '$vplnAmount' } } }
  ]);
  res.json({
    requests,
    completedTotals: totals[0] ? { count: totals[0].count, vplnAmount: totals[0].vplnAmount } : { count: 0, vplnAmount: 0 }
  });
});

app.get('/api/admin/withdrawals/export', authMiddleware, requireAdmin, async (req, res) => {
  const query = buildWithdrawalsQuery(req);
  const requests = await WithdrawalRequest.find(query).sort({ requestedAt: 1 });

  const header = ['ID zgloszenia', 'Data zgloszenia', 'Data przetworzenia', 'Uzytkownik', 'Kwota VPLN', 'Numer konta', 'Wlasciciel konta', 'Tytul przelewu', 'Zgoda PIT (data)', 'Deklaracja wieku', 'Deklaracja wieku (data)', 'Status', 'Notatka admina'];
  const rows = requests.map((r) => [
    String(r._id), r.requestedAt ? r.requestedAt.toISOString() : '', r.processedAt ? r.processedAt.toISOString() : '',
    r.username, r.vplnAmount, r.bankAccountNumber, r.accountHolderName, r.transferTitle,
    r.taxResponsibilityAcknowledgedAt ? r.taxResponsibilityAcknowledgedAt.toISOString() : '',
    r.ageConfirmationType || '', r.ageConfirmedAt ? r.ageConfirmedAt.toISOString() : '',
    r.status, r.adminNote || ''
  ].map(csvEscape).join(';'));
  const csv = '﻿' + [header.join(';'), ...rows].join('\r\n');

  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="rejestr-wyplat-vpln-${stamp}.csv"`);
  res.send(csv);
});

app.put('/api/admin/withdrawals/:id/complete', authMiddleware, requireAdmin, async (req, res) => {
  const { adminNote } = req.body;
  const request = await WithdrawalRequest.findOneAndUpdate(
    { _id: req.params.id, status: 'PENDING' },
    { status: 'COMPLETED', processedAt: new Date(), processedByAdminId: req.user._id, adminNote: adminNote || null },
    { new: true }
  );
  if (!request) return res.status(404).json({ error: 'Zgłoszenie nie istnieje lub zostało już przetworzone.' });
  res.json({ success: true, request });
});

app.put('/api/admin/withdrawals/:id/reject', authMiddleware, requireAdmin, async (req, res) => {
  const { adminNote } = req.body;
  if (!adminNote || !String(adminNote).trim()) {
    return res.status(400).json({ error: 'Podaj powód odrzucenia — zobaczy go gracz.' });
  }
  // Claim the request first (status flip is the idempotency guard), only refund if we actually won
  // the claim — otherwise a retried/duplicate reject click could double-refund the balance.
  const request = await WithdrawalRequest.findOneAndUpdate(
    { _id: req.params.id, status: 'PENDING' },
    { status: 'REJECTED', processedAt: new Date(), processedByAdminId: req.user._id, adminNote: String(adminNote).trim() },
    { new: true }
  );
  if (!request) return res.status(404).json({ error: 'Zgłoszenie nie istnieje lub zostało już przetworzone.' });
  // Dawne zgloszenie w VPLN: po przeliczeniu waluty zwrot trafia na saldo DOGE po tym samym kursie.
  const { vplnToDogeRate } = await getSettings();
  if (vplnToDogeRate) await User.updateOne({ _id: request.userId }, { $inc: { dogeBalance: doge.roundDoge(request.vplnAmount * vplnToDogeRate) } });
  else await User.updateOne({ _id: request.userId }, { $inc: { vplnBalance: request.vplnAmount } });
  res.json({ success: true, request });
});

// --- Admin: rejestr wypłaconych nagród VPLN --------------------------------------------------
// Read-only aggregation across all three VPLN-prize sources — internal record-keeping only (the
// Usługodawca withholds nothing and files no tax declaration, see regulamin.html §5b), useful for
// the organizer's own bookkeeping and to answer a player's question about their own past winnings.
app.get('/api/admin/prize-ledger', authMiddleware, requireAdmin, async (req, res) => {
  const range = {};
  if (req.query.from) range.$gte = new Date(req.query.from);
  if (req.query.to) range.$lte = new Date(req.query.to);
  const dateFilter = Object.keys(range).length ? { awardedAt: range } : {};

  const [tournamentRows, miniRows, referralRows, consolationRows] = await Promise.all([
    TournamentResults.find(dateFilter).sort({ awardedAt: -1 }).lean(),
    MiniTournamentResults.find(dateFilter).sort({ awardedAt: -1 }).lean(),
    ReferralReward.find(dateFilter).sort({ awardedAt: -1 }).lean(),
    FreeRankingConsolationResults.find(dateFilter).sort({ awardedAt: -1 }).lean()
  ]);
  const referrers = await User.find({ _id: { $in: referralRows.map((r) => r.referrerUserId) } }).select('username').lean();
  const referrerUsernameById = new Map(referrers.map((u) => [String(u._id), u.username]));

  const rows = [
    ...tournamentRows.map((r) => ({ source: 'Turniej Miesięczny', username: r.username, placement: r.placement, vplnAwarded: r.vplnAwarded, awardedAt: r.awardedAt })),
    ...miniRows.map((r) => ({ source: 'Mini-Turniej', username: r.username, placement: r.placement, vplnAwarded: r.vplnAwarded, awardedAt: r.awardedAt })),
    ...referralRows.map((r) => ({ source: 'Program Poleceń', username: referrerUsernameById.get(String(r.referrerUserId)) || null, placement: `Kamień milowy ${r.milestone}`, vplnAwarded: r.vplnAwarded, awardedAt: r.awardedAt })),
    ...consolationRows.map((r) => ({ source: 'Ranking Serwerów Darmowych', username: r.username, placement: `Miejsce ${r.rank}`, vplnAwarded: r.vplnAwarded, awardedAt: r.awardedAt }))
  ].sort((a, b) => new Date(b.awardedAt) - new Date(a.awardedAt));

  const totals = rows.reduce((acc, r) => acc + r.vplnAwarded, 0);
  res.json({ rows, totalVplnAwarded: totals });
});

// Admin: "kto ile ma VPLN i skąd" — komplementarny widok do powyższego rejestru przyznanych nagród
// (ktory pokazuje HISTORIE zdarzen) - ten pokazuje AKTUALNE saldo kazdego uzytkownika PLUS zrodlo
// kazdego wplywu, zaciagniete z tych samych czterech modeli audytowych plus wyplat. Czysto
// read-only, nic nie zmienia.
app.get('/api/admin/vpln-balances', authMiddleware, requireAdmin, async (req, res) => {
  const [holders, tournamentRows, miniRows, referralRows, consolationRows, withdrawalRows, adminGrantRows] = await Promise.all([
    User.find({ dogeBalance: { $ne: 0 } }).select('username isBot dogeBalance').sort({ dogeBalance: -1 }).lean(),
    TournamentResults.find().lean(),
    MiniTournamentResults.find().lean(),
    ReferralReward.find().lean(),
    FreeRankingConsolationResults.find().lean(),
    WithdrawalRequest.find({ status: { $in: ['PENDING', 'COMPLETED'] } }).lean(),
    AdminVplnGrant.find().lean()
  ]);
  const referrers = await User.find({ _id: { $in: referralRows.map((r) => r.referrerUserId) } }).select('username').lean();
  const referrerUsernameById = new Map(referrers.map((u) => [String(u._id), u.username]));

  const historyByUsername = new Map();
  const pushEntry = (username, entry) => {
    if (!username) return;
    if (!historyByUsername.has(username)) historyByUsername.set(username, []);
    historyByUsername.get(username).push(entry);
  };
  tournamentRows.forEach((r) => pushEntry(r.username, { source: 'Turniej Miesięczny', change: r.vplnAwarded, at: r.awardedAt }));
  miniRows.forEach((r) => pushEntry(r.username, { source: 'Mini-Turniej', change: r.vplnAwarded, at: r.awardedAt }));
  consolationRows.forEach((r) => pushEntry(r.username, { source: 'Ranking Serwerów Darmowych', change: r.vplnAwarded, at: r.awardedAt }));
  referralRows.forEach((r) => pushEntry(referrerUsernameById.get(String(r.referrerUserId)), { source: 'Program Poleceń', change: r.vplnAwarded, at: r.awardedAt }));
  withdrawalRows.forEach((r) => {
    pushEntry(r.username, { source: r.status === 'COMPLETED' ? 'Wypłata (zrealizowana)' : 'Wypłata (oczekująca)', change: -r.vplnAmount, at: r.requestedAt });
  });
  adminGrantRows.forEach((r) => pushEntry(r.targetUsername, { source: r.reason ? `Przyznanie ręczne (${r.reason})` : 'Przyznanie ręczne', change: r.amountVpln, at: r.awardedAt }));
  for (const list of historyByUsername.values()) list.sort((a, b) => new Date(a.at) - new Date(b.at));

  const balances = holders.map((u) => ({
    username: u.username,
    isBot: !!u.isBot,
    // Saldo DOGE (klucz vplnBalance zostal dla zgodnosci z panelem admina).
    vplnBalance: u.dogeBalance,
    history: historyByUsername.get(u.username) || []
  }));
  const totalHeld = balances.reduce((acc, b) => acc + b.vplnBalance, 0);
  res.json({ balances, totalHeld, currency: 'DOGE', generatedAt: new Date() });
});

app.get('/api/admin/prize-ledger/export', authMiddleware, requireAdmin, async (req, res) => {
  const range = {};
  if (req.query.from) range.$gte = new Date(req.query.from);
  if (req.query.to) range.$lte = new Date(req.query.to);
  const dateFilter = Object.keys(range).length ? { awardedAt: range } : {};

  const [tournamentRows, miniRows, referralRows, consolationRows, adminGrantRows] = await Promise.all([
    TournamentResults.find(dateFilter).sort({ awardedAt: -1 }).lean(),
    MiniTournamentResults.find(dateFilter).sort({ awardedAt: -1 }).lean(),
    ReferralReward.find(dateFilter).sort({ awardedAt: -1 }).lean(),
    FreeRankingConsolationResults.find(dateFilter).sort({ awardedAt: -1 }).lean(),
    AdminVplnGrant.find(dateFilter).sort({ awardedAt: -1 }).lean()
  ]);
  const referrers = await User.find({ _id: { $in: referralRows.map((r) => r.referrerUserId) } }).select('username').lean();
  const referrerUsernameById = new Map(referrers.map((u) => [String(u._id), u.username]));
  const rows = [
    ...tournamentRows.map((r) => ({ source: 'Turniej Miesięczny', username: r.username, placement: r.placement, vplnAwarded: r.vplnAwarded, awardedAt: r.awardedAt })),
    ...miniRows.map((r) => ({ source: 'Mini-Turniej', username: r.username, placement: r.placement, vplnAwarded: r.vplnAwarded, awardedAt: r.awardedAt })),
    ...referralRows.map((r) => ({ source: 'Program Poleceń', username: referrerUsernameById.get(String(r.referrerUserId)) || null, placement: `Kamień milowy ${r.milestone}`, vplnAwarded: r.vplnAwarded, awardedAt: r.awardedAt })),
    ...consolationRows.map((r) => ({ source: 'Ranking Serwerów Darmowych', username: r.username, placement: `Miejsce ${r.rank}`, vplnAwarded: r.vplnAwarded, awardedAt: r.awardedAt })),
    ...adminGrantRows.map((r) => ({ source: 'Przyznanie ręczne', username: r.targetUsername, placement: r.reason ? `${r.reason} (przyznał: ${r.adminUsername})` : `Przyznał: ${r.adminUsername}`, vplnAwarded: r.amountVpln, awardedAt: r.awardedAt }))
  ].sort((a, b) => new Date(a.awardedAt) - new Date(b.awardedAt));

  const header = ['Zrodlo', 'Uzytkownik', 'Miejsce/Kamien milowy', 'Kwota VPLN (brutto, w calosci)', 'Data przyznania'];
  const csvRows = rows.map((r) => [
    r.source, r.username || '', r.placement, r.vplnAwarded, r.awardedAt ? new Date(r.awardedAt).toISOString() : ''
  ].map(csvEscape).join(';'));
  const csv = '﻿' + [header.join(';'), ...csvRows].join('\r\n');

  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="rejestr-nagrod-vpln-${stamp}.csv"`);
  res.send(csv);
});

// Public — read-only. Powers the ranking window on the left of the Turnieje panel: everyone's
// (players AND bots) Skill Points gained from REGULAR rounds only since the start of the current
// month, highest first. Each entry also reports `isBot`. `directPassSlots` is how many of the top
// entries get a direct semifinal pass once the ticket pool empties (see
// maybeGrantRegularRoundsMmrReward) — not a ticket.
app.get('/api/tournament/mmr-leaderboard', async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const leaderboard = await getMmrWindowLeaderboard(limit);
  res.json({ leaderboard, directPassSlots: 5 });
});

// How many players advance from qualification rounds to the semifinals.
const QUALIFICATION_SEMIFINAL_SLOTS = 35;

// Top players AND bots by summed in-game points across this month's qualification (tournament)
// rounds — see the qualificationPoints accumulation in payoutRoundRewards. Sorted/limited in the
// DB query itself (unlike the MMR leaderboard) since qualificationPoints is already the exact
// ranked value, no per-request "gained since baseline" computation needed. Bots are included so
// they show up on the ranking panel like everyone else; there's no real reward tied to this
// leaderboard yet (advancing to semifinals is purely a display highlight for now), so unlike the
// MMR ticket reward there's no separate bot-exclusion step needed here.
async function getQualificationLeaderboard(limit) {
  const monthKey = currentMonthKey();
  const users = await User.find({ qualificationPointsMonthKey: monthKey })
    .select('username qualificationPoints isBot')
    .lean();
  // Bots always display (and rank) at 0 points — they aren't real semifinal contenders, so showing
  // their real accumulated qualification points would be misleading on a ranking real players are
  // competing on. Sorted/limited here in JS (not the DB query) because zeroing happens after the fetch.
  return users
    .map((u) => ({ username: u.username, points: u.isBot ? 0 : (u.qualificationPoints || 0), isBot: !!u.isBot }))
    .sort((a, b) => b.points - a.points || a.username.localeCompare(b.username))
    .slice(0, limit);
}

app.get('/api/tournament/qualification-leaderboard', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || QUALIFICATION_SEMIFINAL_SLOTS));
  const leaderboard = await getQualificationLeaderboard(limit);
  // TOP 5 of the regular-rounds MMR ranking (see maybeGrantRegularRoundsMmrReward) skip
  // qualification entirely — surfaced here too since this is the "who's going to the semifinals"
  // panel, and a direct-pass winner may not even appear in the points leaderboard above at all
  // (they might never have played a single qualification round).
  const monthKey = currentMonthKey();
  const directPassUsers = await User.find({ semifinalDirectPass: true, semifinalDirectPassMonthKey: monthKey })
    .select('username isBot')
    .lean();
  res.json({
    leaderboard,
    semifinalSlots: QUALIFICATION_SEMIFINAL_SLOTS,
    directPassPlayers: directPassUsers.map((u) => ({ username: u.username, isBot: !!u.isBot }))
  });
});

// Public "who's playing there and what's the score" for the semifinal (4 rooms) / final (1 room)
// bracket — each of those is a normal Room (see ensureSemifinalRooms/ensureFinalRoom) that spins up
// a Round exactly like any Pokój Bitewny once its queue fills, so this just surfaces whichever Round
// is most recent per room: live if one is in progress, otherwise the last finished one (frozen
// state, i.e. the final result). Falls back to the room's waiting queue (no points yet) if no round
// has ever started there. Village-points ranking only (GameEngine.comparePlayersByRank), same as any
// round's live podium — matches how Zasady Turnieju describes semifinal/final scoring.
app.get('/api/tournament/bracket-results', async (req, res) => {
  const stage = req.query.stage === 'final' ? 'final' : 'semifinal';
  const rooms = await Room.find({ isTournament: true, tournamentStage: stage }).sort({ roomName: 1 });
  const results = await Promise.all(rooms.map(async (room) => {
    const round = await Round.findOne({ roomId: room._id }).sort({ roundStartedAt: -1 });
    if (round) {
      const players = (round.state?.players || [])
        .filter((p) => !p.hasLeft)
        .slice()
        .sort(GameEngine.comparePlayersByRank)
        // Round.state.players entries use `name` (see buildPlayerFromWaitingEntry/gameEngine.js),
        // never `username` — this read the wrong field, so every semifinal/final bracket panel
        // showed blank player names for the entire duration of the round despite live-updating points.
        .map((p) => ({ username: p.name, points: Math.round(p.points || 0), isBot: !!p.isBot }));
      return { roomId: room._id, roomName: room.roomName, status: round.status, players };
    }
    const players = (room.waitingPlayers || []).map((p) => ({ username: p.username, points: 0, isBot: !!p.isBot }));
    return { roomId: room._id, roomName: room.roomName, status: 'waiting', players };
  }));
  res.json({ stage, rooms: results });
});

// --- Monthly Tournament (see src/tournamentEngine.js) -------------------------------------------
// Ticket purchase itself stays exactly where it already was (POST /api/payments/tickets/create,
// HotPay-backed) — a confirmed purchase also registers the buyer into whatever Monthly
// Tournament is currently open (see the tournamentEngine.registerParticipant call inside
// grantTournamentTicketOrder above). These three read-only endpoints expose that tournament's state.

app.get('/api/tournament/status', async (req, res) => {
  const tournament = await tournamentEngine.getCurrentTournament();
  if (!tournament) return res.json({ tournament: null });
  res.json({
    tournament: {
      monthKey: tournament.monthKey,
      status: tournament.status,
      scheduledStartAt: tournament.scheduledStartAt,
      day2StartAt: tournament.day2StartAt,
      participantsCount: tournament.participants.length,
      maxParticipants: tournament.maxParticipants,
      registrationClosedAt: tournament.registrationClosedAt,
      round1StartedAt: tournament.round1StartedAt,
      round2StartedAt: tournament.round2StartedAt,
      round3StartedAt: tournament.round3StartedAt,
      round4StartedAt: tournament.round4StartedAt,
      resultsAnnouncedAt: tournament.resultsAnnouncedAt
    }
  });
});

// This player's most recent Monthly Tournament room assignment (whichever round is latest) — lets
// the client show "you're in Room 14 of Round 2" without needing to know the room id in advance.
app.get('/api/tournament/my-room', authMiddleware, async (req, res) => {
  const found = await tournamentEngine.getMyRoom(req.userId);
  if (!found) return res.json({ room: null });
  const { tournament, room } = found;
  res.json({
    room: {
      monthKey: tournament.monthKey,
      roundNumber: room.roundNumber,
      roomNumber: room.roomNumber,
      status: room.status,
      players: room.players,
      roundId: room.roundDbId,
      results: room.status === 'COMPLETED' ? room.results : null
    }
  });
});

// Public, single payload for the big player-facing tournament tile (public/tournaments.html) —
// name, ticket pool, full stage schedule, and the guaranteed VPLN prize breakdown. Deliberately
// separate from GET /api/settings/tournament-tickets (which three other pages already poll for
// just the ticket counter) — this one's shape/purpose is the stage schedule + prizes, not tickets.
app.get('/api/tournament/tile', async (req, res) => {
  const tournament = await tournamentEngine.getCurrentTournament();
  if (!tournament) return res.json({ available: false });
  const prizes = (tournament.prizesConfig && tournament.prizesConfig.configuredAt) ? {
    place1: tournament.prizesConfig.place1VPLN,
    place2: tournament.prizesConfig.place2VPLN,
    place3: tournament.prizesConfig.place3VPLN,
    place4to10: tournament.prizesConfig.place4to10VPLN
  } : null;
  res.json({
    available: true,
    monthKey: tournament.monthKey,
    title: tournament.title || null,
    simplifiedStatus: tournamentEngine.toSimplifiedStatus(tournament.status),
    tickets: {
      total: tournament.maxParticipants,
      remaining: Math.max(0, tournament.maxParticipants - tournament.participants.length)
    },
    ticketPricePLN: await getTicketPricePLN(),
    schedule: {
      qualification: { startAt: tournament.scheduledStartAt, durationMinutes: tournament.roundDurationMinutes },
      semifinal: { startAt: tournament.semifinalScheduledAt },
      final: { startAt: tournament.finalScheduledAt }
    },
    prizes
  });
});

// Authenticated — does the logged-in player already have a ticket/participant slot in the current
// tournament? Same participants.some(...) membership check tournamentEngine.registerParticipant
// already uses to avoid double-registering a buyer — one source of truth, no separate collection.
app.get('/api/tournament/my-status', authMiddleware, async (req, res) => {
  const tournament = await tournamentEngine.getCurrentTournament();
  const hasTicket = !!(tournament && tournament.participants.some((p) => String(p.userId) === String(req.userId)));
  res.json({ hasTicket });
});

// Combines this tournament's qualification results with the Free Server Ranking top 5 into one
// response — the two existing endpoints above (qualification-leaderboard / mmr-leaderboard)
// already serve each half individually for the Turnieje page's own panels; this is the single
// combined view the spec's GET /api/tournament/leaderboard describes.
app.get('/api/tournament/leaderboard', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || QUALIFICATION_SEMIFINAL_SLOTS));
  const [qualification, freeServer] = await Promise.all([
    getQualificationLeaderboard(limit),
    getMmrWindowLeaderboard(tournamentEngine.FREE_SERVER_SEMIFINAL_SLOTS)
  ]);
  const tournament = await tournamentEngine.getCurrentTournament();
  res.json({
    monthKey: tournament ? tournament.monthKey : currentMonthKey(),
    tournamentStatus: tournament ? tournament.status : null,
    qualification,
    freeServerRanking: freeServer,
    semifinalists: tournament && tournament.status === 'COMPLETED' ? tournament.semifinalists : null
  });
});

// Admin: sets/reschedules Round 1's start time "T" (and, by default, Round 3's start 24h later)
// for a given month's Monthly Tournament — see scheduleTournament in tournamentEngine.js. Creating
// one is the only way tournamentEngine.registerParticipant() has anything to register buyers into.
// Opens/updates a month's ticket pool (maxParticipants) — deliberately does NOT require a start
// date (scheduledStartAt is optional here): lets an admin open ticket sales now and decide the
// actual start time later, e.g. once the pool has sold out (see POST .../start-date below).
app.post('/api/admin/tournament/schedule', authMiddleware, requireAdmin, async (req, res) => {
  const { monthKey, scheduledStartAt, day2StartAt, roundDurationMinutes, maxParticipants, title, ticketPricePLN, prizes, semifinalScheduledAt, finalScheduledAt, breakBetweenQualRoundsMinutes, calculationBreakMinutes, delayToSemifinalMinutes, delayToFinalMinutes } = req.body;
  if (!monthKey) return res.status(400).json({ error: 'monthKey is required' });
  try {
    const tournament = await tournamentEngine.scheduleTournament({ monthKey, scheduledStartAt, day2StartAt, roundDurationMinutes, maxParticipants, title, ticketPricePLN, prizesConfig: prizes, semifinalScheduledAt, finalScheduledAt, breakBetweenQualRoundsMinutes, calculationBreakMinutes, delayToSemifinalMinutes, delayToFinalMinutes });
    res.json({ success: true, tournament });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Sets/updates ONLY Round 1's start time "T" (and, by default, Round 3's 24h later) for a tournament
// that already exists (see above) — safe to call whether the ticket pool is still open or already
// sold out; if it's already full, this is what actually kicks Round 1 off (immediately if the given
// date is already in the past, otherwise at the given time).
app.put('/api/admin/tournament/sales-pause', authMiddleware, requireAdmin, async (req, res) => {
  const { monthKey, paused } = req.body;
  if (!monthKey) return res.status(400).json({ error: 'monthKey is required' });
  try {
    const tournament = await tournamentEngine.setSalesPaused(monthKey, paused === true);
    res.json({ success: true, salesPausedByAdmin: tournament.salesPausedByAdmin });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/tournament/start-date', authMiddleware, requireAdmin, async (req, res) => {
  const { monthKey, scheduledStartAt, day2StartAt } = req.body;
  if (!monthKey || !scheduledStartAt) return res.status(400).json({ error: 'monthKey and scheduledStartAt are required' });
  try {
    const tournament = await tournamentEngine.setStartDate({ monthKey, scheduledStartAt, day2StartAt });
    res.json({ success: true, tournament });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Ends + fully resets a tournament that hasn't started any rounds yet (SCHEDULED only) — deletes
// it outright so the admin panel goes back to "nothing configured". See
// tournamentEngine.cancelTournament for exactly what this does and doesn't touch.
app.delete('/api/admin/tournament/:monthKey', authMiddleware, requireAdmin, async (req, res) => {
  try {
    await tournamentEngine.cancelTournament(req.params.monthKey);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Full participant roster (admin only — includes real names in bulk) of the current/most recent
// Monthly Tournament, sorted by running Total_TP.
app.get('/api/admin/tournament/participants', authMiddleware, requireAdmin, async (req, res) => {
  const { tournament, participants } = await tournamentEngine.getParticipants();
  if (!tournament) return res.json({ tournament: null, participants: [] });
  res.json({
    monthKey: tournament.monthKey,
    status: tournament.status,
    simplifiedStatus: tournamentEngine.toSimplifiedStatus(tournament.status),
    title: tournament.title || null,
    maxParticipants: tournament.maxParticipants,
    roundDurationMinutes: tournament.roundDurationMinutes,
    scheduledStartAt: tournament.scheduledStartAt,
    day2StartAt: tournament.day2StartAt,
    semifinalScheduledAt: tournament.semifinalScheduledAt,
    finalScheduledAt: tournament.finalScheduledAt,
    breakBetweenQualRoundsMinutes: tournament.breakBetweenQualRoundsMinutes,
    calculationBreakMinutes: tournament.calculationBreakMinutes,
    delayToSemifinalMinutes: tournament.delayToSemifinalMinutes,
    delayToFinalMinutes: tournament.delayToFinalMinutes,
    semifinalCompletedAt: tournament.semifinalCompletedAt,
    ticketPricePLN: tournament.ticketPricePLN,
    prizesConfig: tournament.prizesConfig,
    salesPausedByAdmin: !!tournament.salesPausedByAdmin,
    participants: participants.map((p) => ({
      username: p.username,
      ticketPurchasedAt: p.ticketPurchasedAt,
      totalTP: p.totalTP,
      totalUnitsDestroyed: p.totalUnitsDestroyed
    }))
  });
});

// All 35-(or maxParticipants/10-)room tiles for one round — same "who's in it / live status /
// final per-room results" view admins already get for ad-hoc tournament rounds via
// admin-turnieje.html, just for Monthly Tournament rounds instead.
// roundNumber 1-4 = qualification, 5 = semifinal (4 permanent rooms), 6 = final (1 permanent room)
// — all backed identically by TournamentRoom, see tournamentEngine.getRoundRooms. Exposes
// gameRoomId/roundDbId/isPaused so the admin room-management panel (public/admin-rooms*.html) can
// drive the existing generic pause/end-round endpoints directly, without any new mutating routes.
app.get('/api/admin/tournament/rooms', authMiddleware, requireAdmin, async (req, res) => {
  const roundNumber = Number(req.query.roundNumber);
  if (![1, 2, 3, 4, 5, 6].includes(roundNumber)) return res.status(400).json({ error: 'roundNumber must be 1-6' });
  const { tournament, rooms } = await tournamentEngine.getRoundRooms(roundNumber);
  if (!tournament) return res.json({ tournament: null, rooms: [] });
  const pendingGameRoomIds = rooms.filter((r) => r.status === 'PENDING' && r.gameRoomId).map((r) => r.gameRoomId);
  const pausedById = new Map();
  if (pendingGameRoomIds.length) {
    const gameRooms = await Room.find({ _id: { $in: pendingGameRoomIds } }).select('isPaused');
    gameRooms.forEach((gr) => pausedById.set(String(gr._id), !!gr.isPaused));
  }
  // For an ACTIVE room, per-player blockedByAdmin only exists on the live in-memory session
  // (see gameSession.setPlayerBlockedByAdmin) - not on the TournamentRoom document itself - so the
  // roster tile can show each player's current block state and toggle it correctly.
  const blockedByRoundId = new Map();
  rooms.filter((r) => r.status === 'ACTIVE' && r.roundDbId).forEach((r) => {
    const session = gameSession.getSession(String(r.roundDbId));
    if (!session) return;
    const blockedIds = session.players.filter((p) => p.blockedByAdmin).map((p) => p.userId);
    blockedByRoundId.set(String(r.roundDbId), new Set(blockedIds));
  });

  res.json({
    monthKey: tournament.monthKey,
    roundNumber,
    rooms: rooms.map((r) => {
      const blockedSet = r.roundDbId ? blockedByRoundId.get(String(r.roundDbId)) : null;
      return {
        tournamentRoomId: String(r._id),
        roomNumber: r.roomNumber,
        status: r.status,
        players: r.players.map((p) => ({ ...p.toObject(), blockedByAdmin: blockedSet ? blockedSet.has(String(p.userId)) : false })),
        results: r.status === 'COMPLETED' ? r.results : null,
        gameRoomId: r.gameRoomId || null,
        roundDbId: r.roundDbId || null,
        isPaused: r.gameRoomId ? (pausedById.get(String(r.gameRoomId)) ?? null) : null
      };
    })
  });
});

// --- Manual roster fixes for a tournament room (admin safety valve) -----------------------------
// Two different tools for two different situations, matching what actually went wrong and how it
// can actually be fixed at each stage:
//  - PENDING room (not started yet): the roster itself can still be freely edited — add/remove
//    straight from TournamentRoom.players + the underlying Room.waitingPlayers, same shape
//    tournamentEngine's own seeding uses.
//  - ACTIVE room (round already running): the roster is locked in by the live game session, so
//    there's no clean way to fully remove a seated player - instead this offers a block/unblock
//    toggle that freezes EVERY action of theirs (see gameSession.setPlayerBlockedByAdmin / the
//    blockedByAdmin check in every player-action function in GameEngine), which neutralizes them
//    without touching the live session's player list — their villages stay fully attackable.
const TOURNAMENT_ROOM_PLAYER_COLORS = ['#3b82f6', '#ef4444', '#f59e0b', '#10b981', '#a78bfa', '#f472b6', '#06b6d4', '#8b5cf6', '#fb7185', '#f97316'];

app.post('/api/admin/tournament/rooms/:tournamentRoomId/players', authMiddleware, requireAdmin, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const tr = await TournamentRoom.findById(req.params.tournamentRoomId);
  if (!tr) return res.status(404).json({ error: 'tournament room not found' });
  if (tr.status !== 'PENDING') return res.status(400).json({ error: 'Ręczne dodawanie graczy jest możliwe tylko w pokoju, który jeszcze się nie rozpoczął.' });

  const tournament = await Tournament.findById(tr.tournamentId);
  const user = await User.findOne({ username });
  if (!user) return res.status(404).json({ error: 'Nie znaleziono gracza o takiej nazwie.' });
  const isTicketHolder = tournament.participants.some((p) => String(p.userId) === String(user._id));
  if (!isTicketHolder) return res.status(400).json({ error: 'Gracz musi mieć wykupiony bilet na ten turniej, żeby dało się go dodać.' });
  if (tr.players.some((p) => String(p.userId) === String(user._id))) return res.status(400).json({ error: 'Gracz już jest w tym pokoju.' });

  const room = tr.gameRoomId ? await Room.findById(tr.gameRoomId) : null;
  if (!room) return res.status(404).json({ error: 'game room not found' });
  if (room.waitingPlayers.length >= room.maxPlayers) return res.status(400).json({ error: 'Pokój jest już pełny.' });

  tr.players.push({ userId: user._id, username: user.username });
  await tr.save();
  room.waitingPlayers.push({
    userId: user._id, username: user.username, isBot: !!user.isBot,
    color: TOURNAMENT_ROOM_PLAYER_COLORS[room.waitingPlayers.length % TOURNAMENT_ROOM_PLAYER_COLORS.length]
  });
  await room.save();
  if (!room.isPaused && room.roomType === 'standard' && room.waitingPlayers.length >= room.maxPlayers) {
    startCountdown(room._id.toString());
  }
  res.json({ success: true });
});

app.delete('/api/admin/tournament/rooms/:tournamentRoomId/players/:userId', authMiddleware, requireAdmin, async (req, res) => {
  const tr = await TournamentRoom.findById(req.params.tournamentRoomId);
  if (!tr) return res.status(404).json({ error: 'tournament room not found' });
  if (tr.status !== 'PENDING') return res.status(400).json({ error: 'Ręczne usuwanie graczy jest możliwe tylko w pokoju, który jeszcze się nie rozpoczął.' });

  tr.players = tr.players.filter((p) => String(p.userId) !== req.params.userId);
  await tr.save();
  const room = tr.gameRoomId ? await Room.findById(tr.gameRoomId) : null;
  if (room) {
    room.waitingPlayers = room.waitingPlayers.filter((p) => String(p.userId) !== req.params.userId);
    await room.save();
  }
  res.json({ success: true });
});

app.put('/api/admin/tournament/rooms/:tournamentRoomId/players/:userId/block', authMiddleware, requireAdmin, async (req, res) => {
  const tr = await TournamentRoom.findById(req.params.tournamentRoomId);
  if (!tr) return res.status(404).json({ error: 'tournament room not found' });
  if (tr.status !== 'ACTIVE' || !tr.roundDbId) return res.status(400).json({ error: 'Blokada dotyczy tylko trwającej rundy.' });
  if (!tr.players.some((p) => String(p.userId) === req.params.userId)) return res.status(400).json({ error: 'Gracz nie bierze udziału w tym pokoju.' });

  const blocked = !!req.body.blocked;
  const result = gameSession.setPlayerBlockedByAdmin(String(tr.roundDbId), req.params.userId, blocked);
  if (!result.ok) return res.status(400).json(result);
  res.json({ success: true, blocked });
});

// Test-only utility for the tournament simulation harness — directly overwrites a LIVE round's
// in-memory player stats (points/kills), since bot accounts never issue real attacks and would
// otherwise finish every round at 0. Admin-gated; a no-op on any round that isn't currently live
// in this process's gameSession map (e.g. already finished, or server restarted since it started).
app.post('/api/admin/test/round-stats', authMiddleware, requireAdmin, async (req, res) => {
  const { roundId, players } = req.body;
  if (!roundId || !Array.isArray(players)) return res.status(400).json({ error: 'roundId and players[] are required' });
  const statsByUserId = {};
  players.forEach((p) => { if (p && p.userId) statsByUserId[String(p.userId)] = p; });
  const result = gameSession.setPlayerStats(roundId, statsByUserId);
  res.json({ success: true, ...result });
});

// Test-only utility for the tournament simulation harness — bulk-registers already-existing bot
// User accounts into the currently-open (status SCHEDULED) Monthly Tournament, bypassing the real
// HotPay ticket-purchase flow entirely. Calls the exact same tournamentEngine.registerParticipant()
// the real purchase path calls, so the resulting Tournament.participants[] entries and the eventual
// room assignment/scoring/prize logic are indistinguishable from a real registration. Admin-gated.
app.post('/api/admin/test/tournament-register-bots', authMiddleware, requireAdmin, async (req, res) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) return res.status(400).json({ error: 'userIds[] is required' });
  let registered = 0;
  let tournament = null;
  for (const userId of userIds) {
    tournament = await tournamentEngine.registerParticipant(userId, new Date());
    if (!tournament) return res.status(400).json({ error: 'No SCHEDULED tournament to register into.', registered });
    registered += 1;
  }
  res.json({ success: true, registered, participantsCount: tournament.participants.length, maxParticipants: tournament.maxParticipants });
});

// Public — read-only, no auth needed. Powers the "ile biletów zostało" info on the homepage and
// the ticket shop page. Doesn't persist the lazy month reset itself (that only happens inside an
// actual purchase, see remainingMonthlyTicketPool above) — this just reports what the count WOULD
// be right now, so a page load never needs a write.
app.get('/api/settings/tournament-tickets', async (req, res) => {
  const settings = await getSettings();
  const monthKey = currentMonthKey();
  const sold = settings.tournamentTicketsMonthKey === monthKey ? (settings.tournamentTicketsSoldThisMonth || 0) : 0;
  const total = await getTicketPoolSize();
  const tournament = await tournamentEngine.getCurrentTournament();
  const prizes = (tournament && tournament.prizesConfig && tournament.prizesConfig.configuredAt) ? {
    place1: tournament.prizesConfig.place1VPLN,
    place2: tournament.prizesConfig.place2VPLN,
    place3: tournament.prizesConfig.place3VPLN,
    place4to10: tournament.prizesConfig.place4to10VPLN
  } : null;
  res.json({
    total,
    sold,
    remaining: Math.max(0, total - sold),
    title: (tournament && tournament.title) || null,
    ticketPricePLN: await getTicketPricePLN(),
    prizes,
    salesPausedByAdmin: !!(tournament && tournament.salesPausedByAdmin),
    // exists: any current/recent tournament record at all (drives the homepage tile — "is there
    // anything to look at"). open: registration is actually accepting new tickets right now (drives
    // the shop's buy button — matches the exact guard in POST /api/payments/tickets/create).
    exists: !!tournament,
    open: !!(tournament && tournament.status === 'SCHEDULED')
  });
});

app.get('/api/settings/shop', async (req, res) => {
  const settings = await getSettings();
  res.json({ enabled: settings.shopEnabled });
});

app.put('/api/admin/settings/shop', authMiddleware, requireAdmin, async (req, res) => {
  const { enabled } = req.body;
  const settings = await getSettings();
  settings.shopEnabled = !!enabled;
  await settings.save();
  res.json({ success: true, enabled: settings.shopEnabled });
});

// Public — read-only. Powers the ticket card on mini-tournaments.html: price, and how many of this
// month's purchase pool are left (see remainingMiniTournamentTicketPool — admin-configured cap on
// PURCHASES only, ticket usage/refunding has no date tracked at all).
app.get('/api/settings/mini-tournament-ticket-price', async (req, res) => {
  const settings = await getSettings();
  const remaining = remainingMiniTournamentTicketPool(settings);
  await settings.save(); // persists the lazy monthly-key reset, if this happened to trigger one
  res.json({
    priceZl: settings.miniTournamentTicketPricePLN,
    poolSize: settings.miniTournamentTicketsMonthlyPool,
    remaining: Math.max(0, remaining)
  });
});

app.put('/api/admin/settings/mini-tournament-ticket-price', authMiddleware, requireAdmin, async (req, res) => {
  const settings = await getSettings();
  if (req.body.priceZl !== undefined) {
    const priceZl = Number(req.body.priceZl);
    if (!Number.isFinite(priceZl) || priceZl < 0) return res.status(400).json({ error: 'priceZl must be a non-negative number' });
    settings.miniTournamentTicketPricePLN = priceZl;
  }
  if (req.body.poolSize !== undefined) {
    const poolSize = Number(req.body.poolSize);
    if (!Number.isFinite(poolSize) || poolSize < 0) return res.status(400).json({ error: 'poolSize must be a non-negative number' });
    settings.miniTournamentTicketsMonthlyPool = poolSize;
  }
  await settings.save();
  res.json({
    success: true,
    priceZl: settings.miniTournamentTicketPricePLN,
    poolSize: settings.miniTournamentTicketsMonthlyPool
  });
});

app.get('/api/settings/team-mode', async (req, res) => {
  const settings = await getSettings();
  res.json({ enabled: settings.teamModeEnabled !== false });
});

app.put('/api/admin/settings/team-mode', authMiddleware, requireAdmin, async (req, res) => {
  const { enabled } = req.body;
  const settings = await getSettings();
  settings.teamModeEnabled = !!enabled;
  await settings.save();
  res.json({ success: true, enabled: settings.teamModeEnabled });
});

// Shows/hides the "Pobierz aplikację" button on index.html — see appDownloadEnabled in Settings.js.
app.get('/api/settings/app-download', async (req, res) => {
  const settings = await getSettings();
  res.json({ enabled: !!settings.appDownloadEnabled });
});

app.put('/api/admin/settings/app-download', authMiddleware, requireAdmin, async (req, res) => {
  const { enabled } = req.body;
  const settings = await getSettings();
  settings.appDownloadEnabled = !!enabled;
  await settings.save();
  res.json({ success: true, enabled: settings.appDownloadEnabled });
});

// --- Admin: team-map village position editor -------------------------------------------------
// Lets an admin fine-tune where each of the 50 team-mode village markers sits on top of
// "mapa druzyna.png" without touching code — see public/edytor_mapy_druzynowej.html. The saved
// override (TeamMapLayout, a single document) is applied on top of GameEngine's own hardcoded
// defaults at the moment a team round actually starts (gameSession.loadTeamMapNodesWithOverrides),
// so editing it never affects an already-running round's frozen mapNodes snapshot.

app.get('/api/admin/team-map-layout', authMiddleware, requireAdmin, async (req, res) => {
  const defaults = GameEngine.createTeamMapNodes();
  const override = await TeamMapLayout.findOne().lean();
  if (!override || !Array.isArray(override.nodes) || !override.nodes.length) {
    return res.json({ nodes: defaults, isCustom: false });
  }
  const overrideById = new Map(override.nodes.map((n) => [n.id, n]));
  const nodes = defaults.map((node) => {
    const o = overrideById.get(node.id);
    return o ? { ...node, x: o.x, y: o.y } : node;
  });
  res.json({ nodes, isCustom: true });
});

app.put('/api/admin/team-map-layout', authMiddleware, requireAdmin, async (req, res) => {
  const { nodes } = req.body;
  if (!Array.isArray(nodes) || !nodes.length) return res.status(400).json({ error: 'invalid nodes payload' });
  const cleanNodes = nodes
    .filter((n) => n && typeof n.id === 'string' && Number.isFinite(Number(n.x)) && Number.isFinite(Number(n.y)))
    .map((n) => ({ id: n.id, x: Math.max(0, Math.min(100, Number(n.x))), y: Math.max(0, Math.min(100, Number(n.y))) }));
  await TeamMapLayout.findOneAndUpdate({}, { nodes: cleanNodes, updatedAt: new Date() }, { upsert: true });
  res.json({ success: true, nodes: cleanNodes });
});

app.delete('/api/admin/team-map-layout', authMiddleware, requireAdmin, async (req, res) => {
  await TeamMapLayout.deleteMany({});
  res.json({ success: true, nodes: GameEngine.createTeamMapNodes() });
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId).select('-passwordHash');
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json({
    _id: user._id,
    username: user.username,
    tournamentTickets: user.tournamentTickets || 0,
    vplnBalance: user.vplnBalance || 0,
    dogeBalance: user.dogeBalance || 0,
    dogeAddress: user.dogeAddress || null,
    skillPoints: user.skillPoints,
    tournamentMMR: user.tournamentMMR ?? 1000,
    roundsPlayed: user.roundsPlayed,
    roundsWon: user.roundsWon,
    isAdmin: user.isAdmin,
    role: user.isAdmin ? 'ADMIN' : 'PLAYER',
    hasUnusedMiniTournamentTicket: !!user.hasUnusedMiniTournamentTicket
  });
});

// Lazily generated on first request rather than at registration, so accounts created before this
// feature existed still get a code the first time they open their profile. Matches the existing
// `uuidv4().slice(N)` short-code idiom used elsewhere in this file (e.g. bot display names) —
// retries on the astronomically unlikely event of a collision against the unique index.
async function getOrCreateReferralCode(user) {
  if (user.referralCode) return user.referralCode;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase();
    try {
      user.referralCode = code;
      await user.save();
      return code;
    } catch (err) {
      if (err && err.code === 11000) continue; // collision, retry with a fresh code
      throw err;
    }
  }
  throw new Error('Could not generate a unique referral code after 5 attempts.');
}

// Player-facing: powers the referral card on profile.html — the player's own invite code/link,
// how many referred players already qualify (bought a Mini-Tournament ticket), and progress toward
// the next 10-referral / 10 VPLN milestone (see maybeGrantReferralReward).
app.get('/api/referral/status', authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const referralCode = await getOrCreateReferralCode(user);
  const qualifyingCount = await User.countDocuments({ referredBy: user._id, hasBoughtMiniTournamentTicket: true });
  const totalReferred = await User.countDocuments({ referredBy: user._id });
  const rewards = await ReferralReward.find({ referrerUserId: user._id }).sort({ milestone: 1 });
  const vplnEarnedFromReferrals = rewards.reduce((sum, r) => sum + r.vplnAwarded, 0);
  const nextMilestone = (Math.floor(qualifyingCount / 10) + 1) * 10;
  return res.json({
    referralCode,
    totalReferred,
    qualifyingCount,
    nextMilestone,
    progressToNextMilestone: qualifyingCount % 10,
    vplnEarnedFromReferrals,
    milestonesReached: rewards.map((r) => r.milestone)
  });
});

// Admin support utility: manually re-runs the referral-milestone check for one referrer — for the
// rare case a player reports a missing referral bonus (e.g. a referred friend's ticket purchase
// landed while this exact check was mid-flight and something transient made it error out). Safe to
// call any number of times — maybeGrantReferralReward always re-derives the count fresh and the
// ReferralReward unique index makes every payout idempotent regardless of how it's triggered.
app.post('/api/admin/referral/recheck', authMiddleware, requireAdmin, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  await maybeGrantReferralReward(userId);
  res.json({ success: true });
});

app.post('/api/auth/register', async (req, res) => {
  const { username, password, email, termsAccepted, marketingOptIn, ref } = req.body;
  const validationError = validateUsernameAndPassword(username, password);
  if (validationError) return res.status(400).json({ error: validationError });
  const trimmedUsername = username.trim();
  const normalizedEmail = (email || '').trim().toLowerCase();
  if(!normalizedEmail || !normalizedEmail.includes('@')) return res.status(400).json({ error: 'invalid email' });
  if(termsAccepted !== true) return res.status(400).json({ error: 'Musisz zaakceptować Regulamin i Politykę Prywatności.' });
  const exists = await User.findOne({ username: trimmedUsername });
  if(exists) return res.status(400).json({ error: 'username taken' });
  const emailTaken = await User.findOne({ email: normalizedEmail });
  if(emailTaken) return res.status(400).json({ error: 'email already registered' });
  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  // Referral: an invalid/unknown/self ?ref= code is silently ignored rather than rejecting the
  // whole registration — this field is never shown to or required from the player, it's just an
  // optional bonus for whoever's link they followed (see maybeGrantReferralReward).
  let referredBy = null;
  if (ref && typeof ref === 'string') {
    const referrer = await User.findOne({ referralCode: ref.trim().toUpperCase() }).select('_id');
    if (referrer) referredBy = referrer._id;
  }
  const user = await User.create({
    username: trimmedUsername, email: normalizedEmail, passwordHash,
    termsAcceptedAt: now, privacyAcceptedAt: now,
    marketingOptIn: marketingOptIn === true, marketingOptInAt: marketingOptIn === true ? now : null,
    referredBy
  });
  const token = jwt.sign({ id: user._id }, JWT_SECRET);
  res.json({ token, username: user.username });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password, identifier } = req.body;
  const loginName = username || identifier;
  // Blocked accounts can still log in — see the matching comment on /api/login above. The lockout
  // below is orthogonal to that — it's about wrong-password brute-forcing, not admin blocks.
  const attempt = await attemptLogin(loginName, password);
  if (attempt.error) return res.status(attempt.status).json({ error: attempt.error });
  const user = attempt.user;
  await pushLoginHistory(user, getClientIp(req), req.body?.deviceId);
  const token = jwt.sign({ id: user._id }, JWT_SECRET);
  res.json({ token, username: user.username });
});

app.post('/api/rooms', authMiddleware, requireAdmin, async (req, res) => {
  const { name, maxPlayers, isPaused, settings, roomType, teamCount, playersCanAddBots, isTournament, isMiniTournament, miniTournamentPrizes, requiresMiniTournamentTicket } = req.body;
  const resolvedIsMiniTournament = Boolean(isMiniTournament);
  // Tournament rounds only ever support the 'standard' room type — created exclusively from the
  // dedicated admin subpage (admin-turnieje.html), which never sends roomType at all.
  const resolvedIsTournament = Boolean(isTournament);
  const resolvedRoomType = resolvedIsTournament ? 'standard' : (roomType === 'percentage' ? 'percentage' : (roomType === 'team' ? 'team' : 'standard'));
  if (resolvedRoomType === 'team') {
    const globalSettings = await getSettings();
    if (globalSettings.teamModeEnabled === false) {
      return res.status(403).json({ error: 'Tryb drużynowy jest tymczasowo wyłączony.' });
    }
  }
  // Admin picks how many of the map's 10 fixed regions this room actually uses (2-10) — maxPlayers
  // is derived from that (teamCount * 5), not admin-set directly, so it can never exceed what the
  // chosen team count can actually seat.
  const resolvedTeamCount = Math.min(GameEngine.TEAM_REGION_COUNT, Math.max(2, Number(teamCount) || 2));
  try {
    const room = await Room.create({
      roomName: name || `Room-${uuidv4().slice(0,6)}`,
      // Rounds are free to join and no longer pay out WoLcoin rewards — entryFee and nagroda* are
      // forced to 0 regardless of what the admin form sends (see Room.js).
      entryFee: 0,
      maxPlayers: resolvedRoomType === 'team' ? resolvedTeamCount * GameEngine.TEAM_REGION_SIZE : numberOrDefault(maxPlayers, 10),
      isPaused: Boolean(isPaused),
      roomType: resolvedRoomType,
      isTournament: resolvedIsTournament,
      isMiniTournament: resolvedIsMiniTournament,
      miniTournamentPrizes: {
        place1VPLN: numberOrDefault(miniTournamentPrizes?.place1VPLN, 0),
        place2VPLN: numberOrDefault(miniTournamentPrizes?.place2VPLN, 0),
        place3VPLN: numberOrDefault(miniTournamentPrizes?.place3VPLN, 0)
      },
      requiresMiniTournamentTicket: resolvedIsMiniTournament ? Boolean(requiresMiniTournamentTicket) : false,
      teamCount: resolvedTeamCount,
      playersCanAddBots: resolvedRoomType === 'team' ? false : Boolean(playersCanAddBots),
      settings: {
        dlugoscRundySekundy: numberOrDefault(settings?.dlugoscRundySekundy, 3600),
        modyfikatorCzasuEkonomii: numberOrDefault(settings?.modyfikatorCzasuEkonomii, 0),
        modyfikatorCzasuWojska: numberOrDefault(settings?.modyfikatorCzasuWojska, 0),
        nagrodaTop1: 0,
        nagrodaTop2: 0,
        nagrodaTop3: 0,
        nagrodaAgresor: 0,
      }
    });
    res.json({ room: formatRoom(room) });
  } catch (err) {
    // roomName has a unique index (Room.js) — Room.create() rejecting here previously had no
    // catch at all, so the rejection was never turned into a response: the request just hung
    // until nginx's own proxy timeout returned a bare 504 with no explanation, minutes later, no
    // matter what the admin tried next. Confirmed live: creating a room whose name already exists
    // (e.g. clicking "create" twice, or recreating "PvP" after the first attempt already
    // succeeded) reproduced this exact hang on production.
    if (err && err.code === 11000) {
      return res.status(400).json({ error: 'Pokój o tej nazwie już istnieje. Wybierz inną nazwę.' });
    }
    console.error('POST /api/rooms error', err);
    res.status(500).json({ error: 'Nie udało się utworzyć pokoju.' });
  }
});

// Public listing: every enabled Room template — always visible, never masked/reset. A Room is
// never conflated with any round happening underneath it, so there's nothing to hide here anymore.
// Paused rooms stay in this list too (see room.isPaused) — the client renders them locked/greyed
// out with a disabled join button instead of hiding them outright, so players can still see a
// paused room exists and admins can still find it here to unpause/edit/delete it.
// Tournament rooms default to the 'qualification' stage (see Room.js) unless ?stage=semifinal or
// ?stage=final is requested explicitly — keeps the Kwalifikacje tab's existing ?tournament=1
// callers unaffected now that the semifinal/final permanent rooms exist alongside qualification
// ones. Shared by the public and admin room-listing endpoints below.
function resolveTournamentStageFilter(stageParam) {
  if (stageParam === 'semifinal' || stageParam === 'final') return { tournamentStage: stageParam };
  // Default/'qualification': everything that ISN'T semifinal or final — covers rooms with no
  // tournamentStage set at all (pre-existing data) as well as ones explicitly 'qualification'.
  return { tournamentStage: { $nin: ['semifinal', 'final'] } };
}

// `?tournament=1` flips this to ONLY tournament rooms (used by the public "Turnieje" tab) — the
// default (no param, used by "Pokoje Bitewne") excludes them entirely, so the two listings never
// overlap. See Room.js `isTournament`.
app.get('/api/rooms', async (req, res) => {
  const wantsTournament = req.query.tournament === '1' || req.query.tournament === 'true';
  const wantsMiniTournament = req.query.miniTournament === '1' || req.query.miniTournament === 'true';
  // $ne (not strict equality) so Rooms created before isTournament existed — which have no such
  // field in Mongo at all — still count as "not a tournament" instead of vanishing from both lists.
  const tournamentFilter = wantsTournament ? { isTournament: true } : { isTournament: { $ne: true } };
  const stageFilter = wantsTournament ? resolveTournamentStageFilter(req.query.stage) : {};
  // Mini-Tournament rooms get their own dedicated listing (public/mini-tournaments.html), just like
  // Monthly Tournament rooms do — excluded from the default "Pokoje Bitewne" listing below so the
  // two never mix, same $ne reasoning as isTournament above.
  const miniTournamentFilter = wantsMiniTournament ? { isMiniTournament: true } : { isMiniTournament: { $ne: true } };
  const rooms = await Room.find({ enabled: { $ne: false }, ...tournamentFilter, ...stageFilter, ...miniTournamentFilter }).sort({ createdAt: -1 }).limit(50);
  const formatted = rooms.map(formatRoom);
  if (wantsTournament) {
    // Tournament rounds (qualification especially) never go through the normal join flow — all 10
    // seats are assigned at once by tournamentEngine.startRoundRoom(), bypassing Room.waitingPlayers
    // entirely — so waitingCount stays 0 forever on these Room docs, even while a round is live and
    // actually full. Overridden here from the real, live Round roster so the Turnieje page shows
    // "10/10" for as long as the round is actually running, instead of a permanent, misleading "0/10"
    // right alongside live-changing points.
    const activeRounds = await Round.find({ roomId: { $in: formatted.map((r) => r._id) }, status: 'active' })
      .select('roomId state.players').lean();
    const livePlayerCountByRoomId = new Map(
      activeRounds.map((r) => [String(r.roomId), (r.state?.players || []).filter((p) => !p.hasLeft).length])
    );
    formatted.forEach((r) => {
      const liveCount = livePlayerCountByRoomId.get(String(r._id));
      if (liveCount !== undefined) r.waitingCount = liveCount;
    });
  }
  res.json(formatted);
});

// Admin sees every Room template, including disabled/paused ones (for settings editing) — this is
// intentionally template-only now; live rounds have their own endpoint below. Same `?tournament=1`
// split as the public listing above — the main admin panel's room lists default to excluding
// tournament rooms, which are managed exclusively from admin-turnieje.html instead.
app.get('/api/admin/rooms', authMiddleware, requireAdmin, async (req, res) => {
  const wantsTournament = req.query.tournament === '1' || req.query.tournament === 'true';
  const wantsMiniTournament = req.query.miniTournament === '1' || req.query.miniTournament === 'true';
  const tournamentFilter = wantsTournament ? { isTournament: true } : { isTournament: { $ne: true } };
  const stageFilter = wantsTournament ? resolveTournamentStageFilter(req.query.stage) : {};
  // Same isolation as the public listing (see /api/rooms above) — lets a dedicated admin view show
  // ONLY Mini-Tournament rooms instead of them being buried in the full Zwykłe Rundy list.
  const miniTournamentFilter = wantsMiniTournament ? { isMiniTournament: true } : {};
  const rooms = await Room.find({ ...tournamentFilter, ...stageFilter, ...miniTournamentFilter }).sort({ createdAt: -1 }).limit(150);
  res.json(rooms.map(formatRoom));
});

// "Trwające rundy": only actually-started rounds, each with its own id/roster/timing — completely
// separate from the Room template list above. Same `?tournament=1` split, backed by the Round's own
// isTournament snapshot (copied from the Room at round start, see startCountdown). Round has no
// tournamentStage of its own, so `?stage=` (only meaningful alongside tournament=1) is resolved by
// first finding which Rooms match that stage, same as the /api/admin/rooms endpoint above.
app.get('/api/admin/rounds', authMiddleware, requireAdmin, async (req, res) => {
  const wantsTournament = req.query.tournament === '1' || req.query.tournament === 'true';
  const tournamentFilter = wantsTournament ? { isTournament: true } : { isTournament: { $ne: true } };
  let roomIdFilter = {};
  if (wantsTournament) {
    const stageRooms = await Room.find(resolveTournamentStageFilter(req.query.stage)).select('_id');
    roomIdFilter = { roomId: { $in: stageRooms.map((r) => r._id) } };
  }
  const rounds = await Round.find({ status: 'active', ...tournamentFilter, ...roomIdFilter })
    .select('roomId roomName roomType isTournament entryFee status poolPP roundStartedAt roundEndsAt state.players')
    .sort({ roundStartedAt: -1 })
    .limit(150);
  res.json(rounds.map(formatRound));
});

app.get('/api/admin/users', authMiddleware, requireAdmin, async (req, res) => {
  const users = await User.find({ isBot: { $ne: true } }).select('-passwordHash').sort({ createdAt: 1 });
  res.json(users.map((u) => ({ ...u.toObject(), isOnline: isUserOnline(u._id) })));
});

// Panel Graczy details modal: full profile (never passwordHash) + ticket purchase history.
app.get('/api/admin/users/:id/details', authMiddleware, requireAdmin, async (req, res) => {
  const user = await User.findById(req.params.id).select('-passwordHash');
  if (!user) return res.status(404).json({ error: 'user not found' });
  const ticketOrders = await TicketOrder.find({ userId: user._id }).sort({ createdAt: -1 }).limit(100);
  const vplnGrants = await AdminVplnGrant.find({ targetUserId: user._id }).sort({ awardedAt: -1 }).limit(100);
  res.json({ user, ticketOrders, vplnGrants });
});

// Manual VPLN grant "za różne zasługi" (bug-report rewards, community contributions, etc.) — see
// regulamin.html §1/§5b, discretionary and admin-selected, same framing as the Discord regulamin's
// own §4. Credits the target directly, same as every other reward source (Tournament/Mini-
// Tournament/Referral/Free-Ranking) — never debited from anywhere else, since it's newly-created
// VPLN, not a transfer. Every grant is permanently logged in AdminVplnGrant for the exact same
// audit-trail reasons the rest of this session's VPLN accounting was built around.
app.post('/api/admin/users/:id/grant-vpln', authMiddleware, requireAdmin, async (req, res) => {
  const amount = Math.round(Number(req.body.amount));
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Podaj dodatnią kwotę DOGE.' });
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
  const targetUser = await User.findById(req.params.id).select('username');
  if (!targetUser) return res.status(404).json({ error: 'user not found' });
  const admin = await User.findById(req.userId).select('username');
  const updated = await User.findOneAndUpdate({ _id: targetUser._id }, { $inc: { dogeBalance: amount } }, { new: true }).select('dogeBalance');
  const grant = await AdminVplnGrant.create({
    targetUserId: targetUser._id, targetUsername: targetUser.username,
    adminUserId: req.userId, adminUsername: admin?.username || 'admin',
    amountVpln: amount, reason
  });
  res.json({ success: true, vplnBalance: updated.dogeBalance, dogeBalance: updated.dogeBalance, grant });
});

// --- Rejestr wpłat (payment ledger) --------------------------------------------------------------
// Every ticket purchase attempt already lives forever in TicketOrder (nothing in this codebase ever
// deletes one - see the model comment) — this just exposes that existing record as an admin-facing
// ledger with a CSV export, so an accountant/auditor can be handed the full transaction history for
// any period at any time. Retention: kept indefinitely, which comfortably covers the 5-year minimum
// for accounting evidence under art. 73-74 ustawy o rachunkowości / art. 32 i 86 Ordynacji podatkowej
// (period counted from the end of the calendar year the transaction falls in); RODO doesn't set its
// own separate ceiling here since this processing's legal basis is exactly that statutory retention
// duty, not consent — so there's no earlier point at which these records would need to be erased.
function buildPaymentsQuery(req) {
  const query = {};
  if (req.query.status && ['pending', 'paid', 'failed'].includes(req.query.status)) query.status = req.query.status;
  const dateField = req.query.dateField === 'paidAt' ? 'paidAt' : 'createdAt';
  const range = {};
  if (req.query.from) range.$gte = new Date(req.query.from);
  if (req.query.to) range.$lte = new Date(req.query.to);
  if (Object.keys(range).length) query[dateField] = range;
  return query;
}

app.get('/api/admin/payments', authMiddleware, requireAdmin, async (req, res) => {
  const query = buildPaymentsQuery(req);
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 200));
  // Both Monthly Tournament AND Mini-Tournament tickets go through the exact same HotPay/VPLN
  // payment rails (see POST /tickets/create and /mini-tickets/create) — this ledger previously only
  // ever queried TicketOrder, silently omitting every Mini-Tournament purchase from the admin's
  // "rejestr wpłat" (found live: a real, confirmed-paid Mini-Tournament order was invisible here).
  const [ticketOrders, miniOrders] = await Promise.all([
    TicketOrder.find(query).sort({ createdAt: -1 }).limit(limit).lean(),
    MiniTournamentTicketOrder.find(query).sort({ createdAt: -1 }).limit(limit).lean()
  ]);
  const orders = [
    ...ticketOrders.map((o) => ({ ...o, product: 'Bilet Turniejowy' })),
    ...miniOrders.map((o) => ({ ...o, product: 'Bilet Mini-Turniejowy', quantity: 1 }))
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
  const users = await User.find({ _id: { $in: orders.map((o) => o.userId) } }).select('username email').lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));
  // Grouped BY currency, not a single blanket sum — a paid order can now be settled either in real
  // PLN (via HotPay) or in VPLN (see POST .../tickets/create-vpln), and mixing the two into one
  // "revenue" figure would silently overstate real-money income for accounting/tax purposes (see
  // the legal retention comment above buildPaymentsQuery). paidTotals stays PLN-only, matching what
  // admin-platnosci.html has always shown as "Suma wpłat brutto"; paidTotalsVpln is the separate,
  // clearly-labeled VPLN figure. Combines both order types for the same reason as the list above.
  const totalsMatch = { ...query, status: 'paid' };
  const [ticketTotals, miniTotals] = await Promise.all([
    TicketOrder.aggregate([{ $match: totalsMatch }, { $group: { _id: '$currency', count: { $sum: 1 }, grossAmountZl: { $sum: '$grossAmountZl' } } }]),
    MiniTournamentTicketOrder.aggregate([{ $match: totalsMatch }, { $group: { _id: '$currency', count: { $sum: 1 }, grossAmountZl: { $sum: '$grossAmountZl' } } }])
  ]);
  const totalsByCurrency = new Map();
  for (const t of [...ticketTotals, ...miniTotals]) {
    const existing = totalsByCurrency.get(t._id) || { count: 0, grossAmountZl: 0 };
    totalsByCurrency.set(t._id, { count: existing.count + t.count, grossAmountZl: existing.grossAmountZl + t.grossAmountZl });
  }
  const plnTotals = [...totalsByCurrency.entries()].filter(([currency]) => !BALANCE_CURRENCIES.includes(currency))
    .reduce((acc, [, v]) => ({ count: acc.count + v.count, grossAmountZl: acc.grossAmountZl + v.grossAmountZl }), { count: 0, grossAmountZl: 0 });
  const vplnTotals = totalsByCurrency.get('VPLN') || { count: 0, grossAmountZl: 0 };
  const dogeTotals = totalsByCurrency.get('DOGE') || { count: 0, grossAmountZl: 0 };
  res.json({
    orders: orders.map((o) => ({
      ...o,
      username: userById.get(String(o.userId))?.username || null,
      email: userById.get(String(o.userId))?.email || null
    })),
    paidTotals: plnTotals,
    paidTotalsVpln: { count: vplnTotals.count, vplnAmount: vplnTotals.grossAmountZl },
    paidTotalsDoge: { count: dogeTotals.count, dogeAmount: dogeTotals.grossAmountZl }
  });
});

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n;]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

app.get('/api/admin/payments/export', authMiddleware, requireAdmin, async (req, res) => {
  const query = buildPaymentsQuery(req);
  // See GET /api/admin/payments above for why both order types are combined here.
  const [ticketOrders, miniOrders] = await Promise.all([
    TicketOrder.find(query).sort({ createdAt: 1 }).lean(),
    MiniTournamentTicketOrder.find(query).sort({ createdAt: 1 }).lean()
  ]);
  const orders = [
    ...ticketOrders.map((o) => ({ ...o, product: 'Bilet Turniejowy' })),
    ...miniOrders.map((o) => ({ ...o, product: 'Bilet Mini-Turniejowy', quantity: 1 }))
  ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const users = await User.find({ _id: { $in: orders.map((o) => o.userId) } }).select('username email').lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  const header = ['ID zamowienia', 'Produkt', 'Data utworzenia', 'Data zaplaty', 'Uzytkownik', 'Email', 'Ilosc biletow', 'Kwota brutto', 'Waluta', 'Status', 'ID platnosci HotPay', 'Status HotPay'];
  const rows = orders.map((o) => {
    const u = userById.get(String(o.userId));
    return [
      String(o._id), o.product, o.createdAt ? o.createdAt.toISOString() : '', o.paidAt ? o.paidAt.toISOString() : '',
      u?.username || '', u?.email || '', o.quantity, o.grossAmountZl, o.currency, o.status,
      o.hotpayPaymentId || '', o.lastHotpayStatus || ''
    ].map(csvEscape).join(';');
  });
  const csv = '﻿' + [header.join(';'), ...rows].join('\r\n');

  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="rejestr-wplat-${stamp}.csv"`);
  res.send(csv);
});

app.put('/api/admin/users/:id/block', authMiddleware, requireAdmin, async (req, res) => {
  const { blocked, reason } = req.body;
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (blocked) {
    await blockUserAccount(user._id, reason);
  } else {
    await unblockUserAccount(user._id);
  }
  const refreshed = await User.findById(user._id);
  res.json({ success: true, isBlocked: refreshed.isBlocked, userId: refreshed._id, username: refreshed.username });
});

// --- Admin: multi-account & win-trading detection panels --------------------------------------

app.get('/api/admin/multi-accounts', authMiddleware, requireAdmin, async (req, res) => {
  const incidents = await MultiAccountIncident.find().sort({ detectedAt: -1 }).limit(200).lean();
  const userIds = [...new Set(incidents.flatMap((i) => [String(i.mainUserId), String(i.secondaryUserId)]))];
  const users = await User.find({ _id: { $in: userIds } }).select('isBlocked username').lean();
  const blockedById = new Map(users.map((u) => [String(u._id), u.isBlocked]));
  res.json(incidents.map((i) => ({
    ...i,
    mainUserBlocked: blockedById.get(String(i.mainUserId)) || false,
    secondaryUserBlocked: blockedById.get(String(i.secondaryUserId)) || false
  })));
});

app.post('/api/admin/multi-accounts/:id/action', authMiddleware, requireAdmin, async (req, res) => {
  const { action } = req.body;
  const incident = await MultiAccountIncident.findById(req.params.id);
  if (!incident) return res.status(404).json({ error: 'incident not found' });
  const actionMap = {
    block_main: { targets: [incident.mainUserId], blocked: true },
    unblock_main: { targets: [incident.mainUserId], blocked: false },
    block_secondary: { targets: [incident.secondaryUserId], blocked: true },
    unblock_secondary: { targets: [incident.secondaryUserId], blocked: false },
    block_both: { targets: [incident.mainUserId, incident.secondaryUserId], blocked: true },
    unblock_both: { targets: [incident.mainUserId, incident.secondaryUserId], blocked: false }
  };
  const config = actionMap[action];
  if (!config) return res.status(400).json({ error: 'invalid action' });
  const reason = `Ręczna blokada administratora — wykryte multikonto (${incident.reason}).`;
  for (const targetId of config.targets) {
    if (config.blocked) await blockUserAccount(targetId, reason);
    else await unblockUserAccount(targetId);
  }
  incident.resolved = true;
  await incident.save();
  res.json({ success: true });
});

// Dev/testing escape hatch: clears the permanently-pinned hardwareId on BOTH accounts named in this
// incident, so a confirmed-but-no-longer-wanted pairing (e.g. a false positive from testing) stops
// tripping the pinned_hardware_id_match check in future rounds — see performMultiAccountCheck. Note
// this clears the whole field, not just this one pairing: if either account's hardwareId also ties
// it to a DIFFERENT incident, that link is cleared too (hardwareId is a single value per account,
// not a list of every account it's ever matched).
app.post('/api/admin/multi-accounts/:id/unpin', authMiddleware, requireAdmin, async (req, res) => {
  const incident = await MultiAccountIncident.findById(req.params.id);
  if (!incident) return res.status(404).json({ error: 'incident not found' });
  await User.updateMany({ _id: { $in: [incident.mainUserId, incident.secondaryUserId] } }, { $set: { hardwareId: null } });
  incident.resolved = true;
  await incident.save();
  res.json({ success: true });
});

app.get('/api/admin/suspicious-links', authMiddleware, requireAdmin, async (req, res) => {
  const pairs = await MatchPairStat.find({ totalOneSidedCaptures: { $gt: 0 } })
    .sort({ totalOneSidedCaptures: -1, lastIncidentAt: -1 }).limit(200).lean();
  const userIds = [...new Set(pairs.flatMap((p) => [String(p.userIdA), String(p.userIdB)]))];
  const users = await User.find({ _id: { $in: userIds } }).select('isBlocked roundsPlayed username').lean();
  const usersById = new Map(users.map((u) => [String(u._id), u]));
  res.json(pairs.map((p) => {
    const userA = usersById.get(String(p.userIdA));
    const userB = usersById.get(String(p.userIdB));
    const gamesTogether = (p.roundIdsTogether || []).length;
    // Conservative percentage: relative to whichever of the two has played FEWER total rounds, so
    // a smurf/farm account that plays almost exclusively against one other account shows near 100%.
    const fewestRounds = Math.min(userA?.roundsPlayed || 0, userB?.roundsPlayed || 0);
    const gamesTogetherPercent = fewestRounds > 0 ? Math.round((gamesTogether / fewestRounds) * 100) : null;
    return {
      _id: p._id,
      usernameA: p.usernameA, usernameB: p.usernameB,
      userIdA: p.userIdA, userIdB: p.userIdB,
      userABlocked: userA?.isBlocked || false, userBBlocked: userB?.isBlocked || false,
      gamesTogether, gamesTogetherPercent,
      totalOneSidedCaptures: p.totalOneSidedCaptures,
      lastIncidentAt: p.lastIncidentAt,
      adminReviewed: p.adminReviewed, warningIssued: p.warningIssued,
      oneSidedCaptures: (p.oneSidedCaptures || []).slice().reverse() // newest first for display
    };
  }));
});

app.post('/api/admin/suspicious-links/:id/warn', authMiddleware, requireAdmin, async (req, res) => {
  const pair = await MatchPairStat.findById(req.params.id);
  if (!pair) return res.status(404).json({ error: 'pair not found' });
  pair.warningIssued = true;
  await pair.save();
  res.json({ success: true });
});

app.post('/api/admin/suspicious-links/:id/review', authMiddleware, requireAdmin, async (req, res) => {
  const pair = await MatchPairStat.findById(req.params.id);
  if (!pair) return res.status(404).json({ error: 'pair not found' });
  pair.adminReviewed = true;
  await pair.save();
  res.json({ success: true });
});

app.post('/api/admin/suspicious-links/:id/ban', authMiddleware, requireAdmin, async (req, res) => {
  const { target } = req.body; // 'A' | 'B' | 'both'
  const pair = await MatchPairStat.findById(req.params.id);
  if (!pair) return res.status(404).json({ error: 'pair not found' });
  const targets = [];
  if (target === 'A' || target === 'both') targets.push(pair.userIdA);
  if (target === 'B' || target === 'both') targets.push(pair.userIdB);
  if (!targets.length) return res.status(400).json({ error: 'invalid target' });
  const reason = 'Zbanowano za podejrzane powiązanie behawioralne (jednostronne przejęcia wiosek / win-trading).';
  for (const targetId of targets) await blockUserAccount(targetId, reason);
  pair.adminReviewed = true;
  await pair.save();
  res.json({ success: true });
});

app.get('/api/rooms/:id', async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found' });
  res.json(formatRoom(room));
});

app.put('/api/rooms/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { nazwaPokoju, maxGraczy, roundDurationMinutes, economyTimeModifier, militaryTimeModifier, playersCanAddBots } = req.body;
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found' });
  if (nazwaPokoju) room.roomName = nazwaPokoju;
  // Rounds are free to join and no longer pay out WoLcoin rewards — entryFee and nagroda* are
  // pinned at 0 and no longer admin-editable (see Room.js).
  room.entryFee = 0;
  // Team rooms derive maxPlayers from teamCount * TEAM_REGION_SIZE (see POST /api/rooms) — it's
  // never admin-set directly, same treatment as playersCanAddBots right below. Without this guard,
  // an admin editing an existing team room could set maxPlayers higher than teamCount can actually
  // seat: extra players join the queue but can never successfully pick a team (every team already
  // caps at TEAM_REGION_SIZE), leaving them stuck in the queue until they manually leave.
  if (Number.isFinite(Number(maxGraczy)) && room.roomType !== 'team') room.maxPlayers = Number(maxGraczy);
  if (typeof playersCanAddBots === 'boolean' && room.roomType !== 'team') room.playersCanAddBots = playersCanAddBots;
  room.settings = {
    ...room.settings,
    // Number(x) ? ... : fallback is the falsy-zero bug this project has hit before (see
    // feedback_warlord_workflow.md) — an admin explicitly setting 0 minutes fell through to the old/
    // default duration instead of being honored. Number.isFinite distinguishes "not provided" from
    // an explicit 0, matching numberOrDefault's convention used everywhere else in this handler.
    dlugoscRundySekundy: Number.isFinite(Number(roundDurationMinutes)) ? Number(roundDurationMinutes) * 60 : numberOrDefault(room.settings?.dlugoscRundySekundy, 3600),
    modyfikatorCzasuEkonomii: numberOrDefault(economyTimeModifier, numberOrDefault(room.settings?.modyfikatorCzasuEkonomii, 0)),
    modyfikatorCzasuWojska: numberOrDefault(militaryTimeModifier, numberOrDefault(room.settings?.modyfikatorCzasuWojska, 0)),
    nagrodaTop1: 0,
    nagrodaTop2: 0,
    nagrodaTop3: 0,
    nagrodaAgresor: 0,
  };
  try {
    await room.save();
    res.json(formatRoom(room));
  } catch (err) {
    // Same unique-roomName hang as POST /api/rooms above, reachable here too via a rename to an
    // already-taken name - now returns immediately instead of the request hanging until nginx's
    // proxy timeout.
    if (err && err.code === 11000) {
      return res.status(400).json({ error: 'Pokój o tej nazwie już istnieje. Wybierz inną nazwę.' });
    }
    console.error('PUT /api/rooms/:id error', err);
    res.status(500).json({ error: 'Nie udało się zapisać zmian w pokoju.' });
  }
});

app.put('/api/rooms/:id/pause', authMiddleware, requireAdmin, async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found' });
  room.isPaused = !room.isPaused;
  await room.save();
  // Unpausing a 'standard' room whose queue is already full (this is exactly how the permanent
  // semifinal/final rooms are used: auto-seeded full by tournamentEngine while still paused, the
  // admin's unpause is the actual "go" signal) needs the same trigger a normal join gets once the
  // threshold is crossed — nothing else would ever start it, since these rooms are never joined.
  if (!room.isPaused && room.roomType === 'standard' && room.waitingPlayers.length >= room.maxPlayers) {
    startCountdown(room._id.toString());
  }
  res.json(formatRoom(room));
});

app.put('/api/rounds/:id/end', authMiddleware, requireAdmin, async (req, res) => {
  const ended = await endRound(req.params.id);
  if (!ended) return res.status(404).json({ error: 'round not found' });
  res.json(ended);
});

// Admin/test-data cleanup for a Round document — separate from ending it normally (no payout,
// no broadcast, just gone).
app.delete('/api/rounds/:id', authMiddleware, requireAdmin, async (req, res) => {
  const removed = await deleteRound(req.params.id);
  if (!removed) return res.status(404).json({ error: 'round not found' });
  res.json(removed);
});

app.post('/api/rounds/:id/forfeit', authMiddleware, async (req, res) => {
  const ok = await forfeitRound(req.params.id, req.userId.toString());
  if (!ok) return res.status(404).json({ error: 'round not found or not a member' });
  res.json({ success: true, message: 'Opuszczono rozgrywkę.' });
});

app.delete('/api/rooms/:id', authMiddleware, requireAdmin, async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found' });
  await room.deleteOne();
  // Any Round spawned from this room is untouched — it has its own snapshot of settings/name and
  // no runtime dependency on the parent Room document still existing.
  res.json({ success: true, deleted: 'room' });
});

app.post('/api/rooms/:id/leave', authMiddleware, async (req, res) => {
  const roomId = req.params.id;
  const userId = req.userId;
  // Mini-Tournament rooms: before a match is fully accepted, the player is never actually in
  // waitingPlayers (see joinMiniTournamentQueue) — "leaving" at that stage means canceling the
  // blind-queue search instead of the normal waitingPlayers removal below. Once accepted (present
  // in waitingPlayers), it's an ordinary room again and falls through to the existing path, which is
  // also what admin lobby:kick relies on during the post-accept countdown.
  const room = await Room.findById(roomId);
  const alreadyInWaitingPlayers = room && room.waitingPlayers.some((p) => p.userId && p.userId.toString() === userId.toString());
  if (room && room.isMiniTournament && !alreadyInWaitingPlayers) {
    const result = await leaveMiniTournamentQueue(roomId, userId.toString());
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.json({ success: true, message: 'Anulowano szukanie gry.' });
  }
  // Once the countdown to round start has begun, the roster is effectively locked — leaving now
  // would either shrink a "ready" percentage room back below its threshold after everyone already
  // committed, or vacate a slot in a standard room a split second before it starts.
  if (roomCountdowns.has(roomId)) {
    return res.status(400).json({ error: 'Trwa odliczanie do startu rundy — nie można już opuścić poczekalni.' });
  }
  await leaveWaitingRoom(roomId, userId.toString(), true);
  res.json({ success: true, message: 'Opuszczono pokój.' });
});

app.get('/api/ranking', async (req, res) => {
  // No limit here on purpose — public/ranking.html fetches this once and does its own client-side
  // search (filterRanking()) over the full list. A hardcoded .limit(20) here silently made every
  // player outside the top 20 by Skill Points impossible to find via that search, including the
  // admin's own account despite it genuinely existing.
  const ranking = await User.find({ isBot: false, isSystemAccount: { $ne: true } }).sort({ skillPoints: -1 }).select('username skillPoints roundsPlayed roundsWon');
  res.json(ranking.map((item, index) => ({
    nick: item.username,
    mmr: item.skillPoints,
    rank: index + 1,
    sumaGier: item.roundsPlayed || 0,
    wygrane: item.roundsWon || 0
  })));
});

app.get('/api/game/verify-entry', authMiddleware, async (req, res) => {
  const room = await Room.findOne({ 'waitingPlayers.userId': req.userId });
  if (!room) return res.json({ allowed: false });
  res.json({ allowed: true, roomId: room._id.toString() });
});

// Two shapes: with ?roundId=, resolve that specific round directly. Without one ("my active game"
// resume-banner case), the only thing that counts as "trwająca rozgrywka" is an actual active
// Round — sitting in a Room's waiting queue is not a "game in progress", so it deliberately isn't
// surfaced here (poczekalnia.html / the room browser are how you check queue status).
app.get('/api/game/state', authMiddleware, async (req, res) => {
  const roundId = req.query.roundId;
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'user not found' });

  if (roundId) {
    const round = await Round.findById(roundId);
    if (!round) return res.status(404).json({ error: 'round not found' });

    const players = round.state?.players || [];
    const currentUserId = String(req.userId);
    const canAccess = user.isAdmin || players.some((p) => p.userId && String(p.userId) === currentUserId);
    if (!canAccess) return res.status(403).json({ error: 'forbidden' });

    const roundEndsAt = round.roundEndsAt || null;
    const remainingSeconds = round.status === 'active' && roundEndsAt
      ? Math.max(0, Math.floor((new Date(roundEndsAt).getTime() - Date.now()) / 1000))
      : null;

    return res.json({
      state: {
        status: round.status,
        roundId: round._id.toString(),
        roomId: round.roomId ? round.roomId.toString() : null,
        roomName: round.roomName,
        endsAt: roundEndsAt ? new Date(roundEndsAt).toISOString() : null,
        remainingSeconds,
        roundDurationSeconds: Number(round.settings?.dlugoscRundySekundy) || 3600,
        players,
        poolPP: round.poolPP || 0
      }
    });
  }

  // Excludes players who already forfeited (hasLeft:true) -- otherwise the resume banner would
  // keep reappearing forever for a round they explicitly left via "Opuść rozgrywkę".
  const activeRound = await Round.findOne({ status: 'active', 'state.players': { $elemMatch: { userId: String(req.userId), hasLeft: { $ne: true } } } });
  if (!activeRound) return res.status(404).json({ error: 'no active game' });
  const roundEndsAt = activeRound.roundEndsAt || null;
  res.json({
    state: {
      status: 'active',
      roundId: activeRound._id.toString(),
      roomId: activeRound.roomId ? activeRound.roomId.toString() : null,
      roomName: activeRound.roomName,
      endsAt: roundEndsAt ? new Date(roundEndsAt).toISOString() : null,
      remainingSeconds: roundEndsAt ? Math.max(0, Math.floor((new Date(roundEndsAt).getTime() - Date.now()) / 1000)) : null,
      roundDurationSeconds: Number(activeRound.settings?.dlugoscRundySekundy) || 3600,
      players: activeRound.state?.players || [],
      poolPP: activeRound.poolPP || 0
    }
  });
});

// save/load editor layout
app.post('/api/game/layout', authMiddleware, async (req, res) => {
  try {
    const layout = req.body;
    const dataDir = path.resolve(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const filePath = path.join(dataDir, 'game_layout.json');
    fs.writeFileSync(filePath, JSON.stringify(layout, null, 2), 'utf8');
    res.json({ success: true, path: '/data/game_layout.json' });
  } catch (err) {
    console.error('Failed to save layout', err);
    res.status(500).json({ error: 'failed to save layout' });
  }
});

app.get('/api/game/layout', authMiddleware, async (req, res) => {
  try {
    const filePath = path.resolve(__dirname, '..', 'data', 'game_layout.json');
    if (!fs.existsSync(filePath)) return res.json({ layout: null });
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ layout: JSON.parse(content) });
  } catch (err) {
    console.error('Failed to load layout', err);
    res.status(500).json({ error: 'failed to load layout' });
  }
});

// ---- Demo only (DEMO_FILL=on): a waiting player can ask for the remaining places to be filled with bots.
// The bot runner (chain/scripts/demo-players.js, ONDEMAND=1) polls the demo_fill_requests collection and
// puts that many idle bots into the queue. Off by default, so a normal deployment never sees this.
const DEMO_FILL_ROOMS = (process.env.DEMO_FILL_ROOMS || 'Mini Turniej #1').split(',').map((x) => x.trim());
app.get('/api/demo/config', (req, res) => res.json({ fill: process.env.DEMO_FILL === 'on' }));
app.post('/api/demo/fill-bots', authMiddleware, async (req, res) => {
  try {
    if (process.env.DEMO_FILL !== 'on') return res.status(403).json({ error: 'Not available.' });
    const roomId = String(req.body.roomId || '');
    const room = await Room.findById(roomId).select('roomName maxPlayers isMiniTournament');
    if (!room || !room.isMiniTournament) return res.status(404).json({ error: 'Room not found.' });
    if (!DEMO_FILL_ROOMS.includes(room.roomName)) return res.status(400).json({ error: 'Bots are not available in this room.' });
    const queue = miniTournamentQueues.get(roomId) || [];
    if (!queue.some((p) => p.userId === String(req.userId))) return res.status(400).json({ error: 'Join the queue first.' });
    if (pendingMatches.has(roomId)) return res.status(400).json({ error: 'A match is already forming.' });
    const need = (room.maxPlayers || 10) - queue.length;
    if (need <= 0) return res.json({ ok: true, need: 0 });
    await mongoose.connection.db.collection('demo_fill_requests').insertOne({ roomId, need, createdAt: new Date(), done: false });
    res.json({ ok: true, need });
  } catch (err) {
    console.error('demo fill error', err);
    res.status(500).json({ error: 'Failed.' });
  }
});

app.post('/api/rooms/:id/join', authMiddleware, async (req, res) => {
  try {
    const roomId = req.params.id;
    const room = await Room.findById(roomId);
    if (!room) return res.status(404).json({ error: 'room not found' });
    // Mini-Tournament rooms: enter the blind matchmaking queue instead of Room.waitingPlayers
    // directly — see joinMiniTournamentQueue. Nothing broadcast here (nobody else should learn a
    // new player is searching), the client just redirects into poczekalnia.html as usual and picks
    // up its queue state over the matchmaking:join socket event.
    if (room.isMiniTournament) {
      const result = await joinMiniTournamentQueue(roomId, req.userId);
      if (result.error) return res.status(result.status).json({ error: result.error });
      return res.json({ room: formatRoom(result.room) });
    }
    const result = await performRoomJoin(roomId, req.userId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const joinedRoomId = result.room._id.toString();
    io.to(joinedRoomId).emit('roomUpdated', result.room);
    io.to(joinedRoomId).emit('lobby:update_list', result.room.waitingPlayers || []);
    res.json({ room: formatRoom(result.room) });
  } catch (err) {
    console.error('join room error', err);
    res.status(500).json({ error: 'join failed' });
  }
});

app.post('/api/rooms/:id/add-bots', authMiddleware, async (req, res) => {
  const room = await Room.findById(req.params.id);
  if(!room) return res.status(404).json({ error: 'room not found' });
  const admin = await User.findById(req.userId);
  if(!admin || !admin.isAdmin) return res.status(403).json({ error: 'admin only' });
  // Team rooms are self-organized by the real players who join (they pick their own teams via
  // lobby:setTeam) — a bot has no team to be assigned to and would permanently block the
  // ready-check (maybeStartReadyRoom requires every waiting player to have a teamId).
  if (room.roomType === 'team') return res.status(400).json({ error: 'Nie można dodawać botów do pokoju drużynowego.' });
  // Monthly Tournament and Mini-Tournament rooms never get bots in real play — every seat must be
  // a real, qualified/ticketed player. This bulk endpoint has no admin-panel button anywhere in the
  // product; it only ever gets called directly (e.g. for load-testing), which is the one legitimate
  // use left now that live rooms are hard-blocked.
  if (room.isTournament) return res.status(400).json({ error: 'Nie można dodawać botów do rund Turnieju Miesięcznego.' });
  if (room.isMiniTournament) return res.status(400).json({ error: 'Nie można dodawać botów do pokoi Mini-Turniejowych.' });
  while(room.waitingPlayers.length < room.maxPlayers){
    const botName = `Bot_${uuidv4().slice(0, 8)}`;
    const bot = await User.create({ username: botName, passwordHash: 'bot', isBot: true });
    room.waitingPlayers.push({ userId: bot._id, username: bot.username, isBot: true, color: nextAvailableColor(room.waitingPlayers) });
  }
  await room.save();
  res.json({ room: formatRoom(room) });
});

// One persistent, hidden Room template that every trial Round references as its roomId (Round.roomId
// is required) — never shown in any listing (enabled:false), never joined through the normal
// matchmaking flow, only ever used as an anchor for the trial-round snapshot below.
async function getOrCreateTrialRoomTemplate() {
  let room = await Room.findOne({ roomName: '__TRIAL_TEMPLATE__' });
  if (!room) {
    room = await Room.create({
      roomName: '__TRIAL_TEMPLATE__',
      enabled: false,
      isPaused: true,
      entryFee: 0,
      maxPlayers: 10,
      roomType: 'standard',
      settings: { dlugoscRundySekundy: 7200, modyfikatorCzasuEkonomii: 0, modyfikatorCzasuWojska: 0, nagrodaTop1: 0, nagrodaTop2: 0, nagrodaTop3: 0, nagrodaAgresor: 0 }
    });
  }
  return room;
}

// The one free practice round every account gets (see freeTrialUsed on User) — 1 real player + 9
// bots, started immediately (no waiting queue/countdown), free entry, 2 hours long, and completely
// inert economically: payoutRoundRewards/forfeitRound both check round.isTrial and skip WoLcoin,
// rewards and Skill Points entirely.
app.post('/api/trial/start', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'user not found' });
    if (user.freeTrialUsed) return res.status(400).json({ error: 'Darmowa rozgrywka próbna została już wykorzystana.' });

    const activeElsewhere = await Round.findOne({ status: 'active', 'state.players': { $elemMatch: { userId: user._id.toString(), hasLeft: { $ne: true } } } });
    if (activeElsewhere) return res.status(400).json({ error: 'Jesteś już w trakcie innej rozgrywki. Wróć do niej lub ją opuść, zanim zaczniesz rozgrywkę próbną.' });

    const trialRoom = await getOrCreateTrialRoomTemplate();

    const players = [{ userId: user._id, username: user.username, isBot: false, color: nextAvailableColor([]) }];
    for (let i = 0; i < 9; i++) {
      const botName = `Bot_${uuidv4().slice(0, 8)}`;
      const bot = await User.create({ username: botName, passwordHash: 'bot', isBot: true });
      players.push({ userId: bot._id, username: bot.username, isBot: true, color: nextAvailableColor(players) });
    }

    const roundStartedAt = new Date();
    const roundEndsAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const round = await Round.create({
      roomId: trialRoom._id,
      roomName: 'Rozgrywka próbna',
      roomType: 'standard',
      entryFee: 0,
      settings: trialRoom.settings,
      status: 'active',
      isTrial: true,
      poolPP: 0,
      roundStartedAt,
      roundEndsAt,
      state: {}
    });
    const roundId = round._id.toString();
    startRoundTimer(roundId);
    await gameSession.startSession(round, players);

    user.freeTrialUsed = true;
    await user.save();

    res.json({ roundId });
  } catch (err) {
    console.error('trial start error', err);
    res.status(500).json({ error: 'nie udało się rozpocząć rozgrywki próbnej' });
  }
});

// serve the provided background image from public assets
app.get('/assets/background.png', (req, res) => {
  const imagePath = path.resolve(__dirname, '..', 'public', 'tło.png');
  res.sendFile(imagePath);
});

// Clean URL for the player-facing tournament tile page (public/tournaments.html) — the homepage
// dashboard tile and the post-payment return page link here without the .html extension.
app.get('/tournaments', (req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'tournaments.html'));
});

app.get('/mini-tournaments', (req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'mini-tournaments.html'));
});

// Admin room-management hub + its 4 stage views. The 3 tournament-stage routes deliberately serve
// the SAME file (admin-rooms-tournament.html) — qualification/semifinal/final are structurally
// identical (a list of TournamentRoom docs with pause/end-round actions), only the roundNumber(s)
// and copy differ; the page reads its stage from location.pathname.
// no-store: these admin pages change shape often during active development, and being reachable
// via browser back/forward must always show the current version, never a cached stale one.
function sendFreshFile(fileName) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.resolve(__dirname, '..', 'public', fileName));
  };
}
app.get('/admin/rooms', sendFreshFile('admin-rooms.html'));
app.get('/admin/rooms/regular', sendFreshFile('admin-rooms-regular.html'));
app.get(['/admin/rooms/qualifiers', '/admin/rooms/semifinals', '/admin/rooms/final'], sendFreshFile('admin-rooms-tournament.html'));
app.get('/admin/rooms/players', sendFreshFile('admin-players.html'));
app.get('/admin/rooms/mini-tournaments', sendFreshFile('admin-rooms-mini-tournament.html'));
app.get('/admin/settings/shop', sendFreshFile('admin-settings-shop.html'));
app.get('/admin/settings/team-mode', sendFreshFile('admin-settings-team-mode.html'));
app.get('/admin/settings/app-download', sendFreshFile('admin-settings-app-download.html'));
app.get('/admin/platnosci', sendFreshFile('admin-platnosci.html'));
app.get('/admin/wyplaty', sendFreshFile('admin-wyplaty.html'));
app.get('/admin/doge', sendFreshFile('admin-doge.html'));
app.get('/admin/dogeos', sendFreshFile('admin-dogeos.html'));
app.get('/symulacja', sendFreshFile('symulacja.html')); // publiczna symulacja turnieju miesiecznego (prezentacja)
app.get('/admin/limity-biletow', sendFreshFile('admin-limity-biletow.html'));
app.get('/admin/news', sendFreshFile('admin-news.html'));

// Admin pages served directly as static files (admin.html, admin-turniej-miesieczny.html,
// admin-turnieje.html) get the same no-store treatment as the routes above — browser back/forward
// through the admin panel must never show a stale cached copy from before the last change.
app.use((req, res, next) => {
  if (/^\/admin[a-z0-9-]*\.html$/i.test(req.path)) res.set('Cache-Control', 'no-store');
  next();
});

// --- DogeOS testnet: bilety / nagrody / zaklady przez portfel (src/chain) ---------------------------
// Te same reguly zakupu co przy zakupie za saldo (create-vpln), tylko platnosc idzie z portfela.
async function chainMonthlyEligibility(user) {
  const settings = await getSettings();
  if (!settings.shopEnabled) return { status: 403, error: 'The shop is temporarily disabled.' };
  const openTournament = await tournamentEngine.getCurrentTournament();
  if (!openTournament || openTournament.status !== 'SCHEDULED' || !openTournament.prizesConfig || !openTournament.prizesConfig.configuredAt) {
    return { error: 'The tournament is not open for registration right now.' };
  }
  if (openTournament.salesPausedByAdmin) return { error: 'Ticket sales are paused by the administration.' };
  const already = await TicketOrder.findOne({ userId: user._id, status: 'paid', paidAt: { $gte: startOfCurrentMonth() } });
  if (already) return { error: 'You can buy only one Monthly Tournament ticket per calendar month.' };
  const remainingPool = await remainingMonthlyTicketPool(settings);
  await settings.save();
  if (remainingPool < 1) return { error: 'The monthly ticket pool is exhausted.' };
  return { priceGame: await getTicketPricePLN() };
}
async function chainMiniEligibility(user) {
  const settings = await getSettings();
  if (!settings.shopEnabled) return { status: 403, error: 'The shop is temporarily disabled.' };
  if (user.hasUnusedMiniTournamentTicket) return { error: 'You already hold an unused Mini-Tournament ticket.' };
  if (!(await Room.exists({ enabled: { $ne: false }, isMiniTournament: true }))) return { error: 'No Mini-Tournament is available right now.' };
  const remainingPool = remainingMiniTournamentTicketPool(settings);
  await settings.save();
  if (remainingPool <= 0) return { error: 'The monthly Mini-Tournament ticket pool is exhausted.' };
  return { priceGame: settings.miniTournamentTicketPricePLN };
}
// Logowanie portfelem: konto bez hasla, tworzone przy pierwszym podpisie (nazwa Lord_xxxxxx).
async function chainCreateWalletUser(address) {
  const now = new Date();
  const passwordHash = await bcrypt.hash(uuidv4() + uuidv4(), 10); // losowe haslo - wejscie tylko przez portfel
  for (let i = 0; i < 6; i += 1) {
    const username = `Lord_${address.slice(2, 8)}${i ? Math.floor(Math.random() * 900 + 100) : ''}`.slice(0, 16);
    if (await User.exists({ username })) continue;
    return User.create({ username, passwordHash, walletAddress: address, needsUsername: true, termsAcceptedAt: now, privacyAcceptedAt: now });
  }
  throw new Error('could not allocate a username');
}
chainApi = require('./chain').init({
  app, authMiddleware, authOptional, requireAdmin, User, Room, Round, TicketOrder, MiniTournamentTicketOrder,
  auth: {
    createWalletUser: chainCreateWalletUser,
    validateUsername: (raw) => {
      const name = String(raw || '').trim();
      if (name.length < USERNAME_MIN_LENGTH) return `The player name must have at least ${USERNAME_MIN_LENGTH} characters.`;
      if (name.length > USERNAME_MAX_LENGTH) return `The player name can have at most ${USERNAME_MAX_LENGTH} characters.`;
      if ((name.match(/ /g) || []).length > USERNAME_MAX_SPACES) return `The player name can contain at most ${USERNAME_MAX_SPACES} spaces.`;
      if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) return 'Use only letters, digits, spaces, dots, dashes and underscores.';
      return null;
    },
    issueToken: (user) => jwt.sign({ id: user._id }, JWT_SECRET),
    onLogin: (req, user) => pushLoginHistory(user, getClientIp(req), req.body?.deviceId)
  },
  eligibility: { monthly: chainMonthlyEligibility, mini: chainMiniEligibility },
  grant: { monthly: grantTournamentTicketOrder, mini: grantMiniTournamentTicketOrder }
});

// serve static client
app.use('/', express.static('public'));

// Bledy z tras (patrz opakowanie przy tworzeniu app): zly identyfikator -> 400, reszta -> 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const badId = err && (err.name === 'CastError' || err.name === 'BSONError');
  if (!badId) console.error(`${req.method} ${req.originalUrl} error`, err);
  res.status(badId ? 400 : 500).json({ error: badId ? 'Nieprawidłowy identyfikator.' : 'Błąd serwera.' });
});

// Ostatnia linia obrony (np. bledy w obsludze socketow): zapis w logu zamiast wylaczenia serwera.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection', reason);
});

const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: '*' } });

// In-memory trackers
const roomCountdowns = new Map(); // lobby-scoped: roomId -> countdown state
const roundTimers = new Map(); // roundId -> timer state
const socketToInfo = new Map(); // socketId -> { userId, roomId } (lobby membership only)

// --- Blind matchmaking queue for Mini-Tournament rooms (see joinMiniTournamentQueue et al.) -----
// In-memory only, exactly like roomCountdowns above — a server restart just means queued players
// need to click "search" again, which costs nothing since no ticket is ever consumed pre-accept.
// roomId (string) -> Array<{ userId, username, tournamentMMR, queuedAt, socketId, disconnectedAt }>
const miniTournamentQueues = new Map();
// roomId (string) -> { matchId, players: [...same shape as above], acceptedUserIds: Set<string>, deadlineAt, timer }
const pendingMatches = new Map();
const MM_TIER1_MS = 30000, MM_TIER1_RANGE = 50;
const MM_TIER2_MS = 60000, MM_TIER2_RANGE = 150;
const MM_ACCEPT_WINDOW_MS = 15000;
const MM_QUEUE_DISCONNECT_GRACE_MS = 30000;
const MM_TICK_MS = 2000;
// roundId -> Map(socketId -> { userId, deviceId, ip }) for every socket CURRENTLY joined to that
// ROUND's live game (populated in game:join, cleaned up on disconnect) — this is what the
// multi-account check queries for "is another account already connected in this specific match
// right now". Deliberately scoped to a round, not a room template: two accounts landing in
// different parallel rounds spawned from the same room are not "in the same match".
const roundLiveConnections = new Map();
// userId -> Set(socketId) for EVERY authenticated socket connected anywhere on the site (not just
// inside a round's live game) — powers the online/offline dot in the admin panel's player list. A
// user counts as online as long as at least one of their sockets/tabs is still connected.
const onlineUserSockets = new Map();
function isUserOnline(userId) {
  const sockets = onlineUserSockets.get(String(userId));
  return !!sockets && sockets.size > 0;
}

// Global player chat shown on the main dashboard (index.html) — persisted to Mongo (GlobalChatMessage)
// so it survives server restarts/deploys; a TTL index on the model auto-deletes each message 24h
// after it was sent, so history never grows unbounded and old chatter naturally ages out.
const GLOBAL_CHAT_HISTORY_LIMIT = 300;

// In-round team chat for team-mode rounds — each team gets its own private channel (a
// `team:{roundId}:{teamId}` Socket.io room, joined in game:join) so teammates can coordinate
// during the actual battle, completely separate from the lobby's shared pre-round chat
// (lobby:chatMessage) which everyone in the room sees regardless of team. Same ephemeral,
// in-memory-only pattern as globalChatHistory above — nothing persisted to Mongo.
const teamChatHistory = new Map(); // `${roundId}:${teamId}` -> array of messages
const TEAM_CHAT_HISTORY_MAX = 50;

// Binds every socket to the logged-in account BEFORE any handler runs (socket.userId = user._id),
// so a refresh/reconnect from the same browser always re-attaches to the same player identity
// instead of the server having to guess it from event payloads. The client sends its JWT (the same
// one already stored in localStorage for REST calls) as `auth.token` when constructing the socket,
// alongside `auth.deviceId` — the browser fingerprint from public/fingerprint.js — used below by
// the game:join multi-account check.
// Bledy wysylane graczowi przez socket.io w jego jezyku (j.w.).
io.use((socket, next) => { i18n.attachToSocket(socket); next(); });
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    socket.deviceId = socket.handshake.auth?.deviceId || null;
    if (token) {
      const data = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(data.id);
      if (user && !user.isBlocked) {
        socket.userId = user._id.toString();
        socket.username = user.username;
        socket.isAdmin = !!user.isAdmin;
      }
    }
  } catch (e) {
    // invalid/expired token: leave socket.userId unset, individual handlers enforce what they need
  }
  next();
});

// Pins a Device ID permanently onto BOTH accounts involved in a confirmed multi-account attempt
// (kept even if one of them later plays from a different machine, so admins retain the evidence
// trail) and writes the audit-trail document the admin panel's "Wykryte Multikonta" tab reads.
async function recordMultiAccountIncident({ roundId, mainUserId, secondaryUserId, reason, deviceId, sharedIp }) {
  const [mainUser, secondaryUser] = await Promise.all([User.findById(mainUserId), User.findById(secondaryUserId)]);
  if (!mainUser || !secondaryUser) return;
  const deviceIdToPin = deviceId || mainUser.hardwareId || secondaryUser.hardwareId || null;
  if (deviceIdToPin) {
    let changed = false;
    if (!mainUser.hardwareId) { mainUser.hardwareId = deviceIdToPin; changed = true; }
    if (!secondaryUser.hardwareId) { secondaryUser.hardwareId = deviceIdToPin; changed = true; }
    if (changed) await Promise.all([mainUser.save(), secondaryUser.save()]);
  }
  await MultiAccountIncident.create({
    roundId, mainUserId, mainUsername: mainUser.username, secondaryUserId, secondaryUsername: secondaryUser.username,
    reason, sharedDeviceId: deviceIdToPin, sharedIp: sharedIp || null
  });
  console.warn(`[MultiAccount] ${reason}: ${mainUser.username} <-> ${secondaryUser.username} in round ${roundId}`);
}

// Tells every currently-open socket a user has (game.html, pokoje.html, poczekalnia.html — anything
// tracked in onlineUserSockets, not just a game-room-scoped one) that their account was just blocked,
// then disconnects them. The client listens for 'account:blocked' and navigates to index.html, which
// shows the reason + conversation with admin via GET /api/me/block-status instead of the normal
// dashboard — see the matching client-side handler in game.js/pokoje.html/poczekalnia.html.
function notifyAndDisconnectAllSockets(userId, reason) {
  const socketIds = onlineUserSockets.get(String(userId));
  if (!socketIds) return;
  for (const socketId of [...socketIds]) {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.emit('account:blocked', { reason });
      targetSocket.disconnect(true);
    }
  }
}

// Scoped counterpart to notifyAndDisconnectAllSockets: forcibly drops only this user's socket(s)
// connected to THIS one round (via roundLiveConnections, populated on game:join), without touching
// any other session they might have open (dashboard, a different room's lobby). Needed because
// forfeitRound only used to flip hasLeft in Mongo — a still-open game.html tab for the forfeited
// round kept working normally (queueBuilding/sendAttack/etc. never check hasLeft), so a player could
// forfeit round A and immediately join round B while a stale tab kept controlling round A for free,
// exactly the "two simultaneous games" outcome performRoomJoin's activeElsewhere check exists to
// prevent. The disconnect handler (see socket.on('disconnecting')) already removes the socket's own
// roundLiveConnections entry, so nothing further to clean up here.
function kickUserFromRoundLiveGame(roundId, userId, message) {
  const connections = roundLiveConnections.get(roundId);
  if (!connections) return;
  const uid = String(userId);
  for (const [socketId, info] of [...connections.entries()]) {
    if (info.userId !== uid) continue;
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.emit('game:error', message);
      targetSocket.disconnect(true);
    }
  }
}

// Single source of truth for blocking an account, used by every block site (multi-account
// auto-detection, the admin "Zablokuj" toggle, the multi-account/suspicious-links ban buttons):
// marks isBlocked + stores the reason the player will see, forces them out of wherever they
// currently are (a room's waiting queue and/or an active round — genuinely two different possible
// places now), and immediately notifies+disconnects any of their live sockets so they don't keep
// playing as if nothing happened.
async function blockUserAccount(userId, reason) {
  const user = await User.findById(userId);
  if (!user) return;
  const finalReason = reason || 'Zablokowano przez administrację.';
  user.isBlocked = true;
  user.blockReason = finalReason;
  await user.save();

  // Notify+disconnect FIRST, before anything else here gets a chance to touch this user's live
  // socket(s) — forfeitRound below calls kickUserFromRoundLiveGame, which ALSO emits its own
  // message ('Opuściłeś tę rozgrywkę.') and force-disconnects the same socket. When that ran
  // first, it always won the race: by the time this function's own emit('account:blocked', ...)
  // ran against an already-disconnected socket, Socket.IO silently drops it (no error, no queue) —
  // so the player's client never actually learned they'd been blocked, it just saw a generic
  // "you left this round" and a dead connection. Doing this first means the real reason is always
  // what the client receives; forfeitRound's own kick then finds nothing left to disconnect,
  // which is correct — there's no reason to show a second, redundant message after this one.
  notifyAndDisconnectAllSockets(user._id.toString(), finalReason);

  const waitingRoom = await Room.findOne({ 'waitingPlayers.userId': user._id });
  if (waitingRoom) {
    await leaveWaitingRoom(waitingRoom._id.toString(), user._id.toString(), false);
  }
  const activeRound = await Round.findOne({ status: 'active', 'state.players': { $elemMatch: { userId: user._id.toString(), hasLeft: { $ne: true } } } });
  if (activeRound) {
    await forfeitRound(activeRound._id.toString(), user._id.toString());
  }
}

async function unblockUserAccount(userId) {
  await User.updateOne({ _id: userId }, { $set: { isBlocked: false, blockReason: null } });
}

// Real in-round penalty for a confirmed multi-account, applied to BOTH accounts via blockUserAccount
// (permanently blocked, forced out of the match, entry fee lost). Admin accounts are never
// auto-blocked/kicked here, matching the existing, explicit decision to always let an admin's own
// join through this check unconditionally.
async function applyMultiAccountConsequences(mainUserId, secondaryUserId, roundId) {
  // Zwykłe rundy nie mają wpisowego/biletu, więc dla nich pomijamy całe zdanie o nim — dotyczy ono
  // wyłącznie rund turniejowych/mini-turniejowych, gdzie gracz faktycznie zapłacił za bilet wejściowy.
  const round = roundId ? await Round.findById(roundId).select('isTournament isMiniTournament') : null;
  const isTicketedRound = !!(round && (round.isTournament || round.isMiniTournament));
  const reason = 'Wykryto próbę wielokrotnego logowania (multikonto) w tym samym pokoju gry. Konto zostało zablokowane'
    + (isTicketedRound ? ', a bilet nie podlega zwrotowi.' : '.');
  for (const uid of [String(mainUserId), String(secondaryUserId)]) {
    try {
      const user = await User.findById(uid);
      if (!user || user.isAdmin) continue;
      await blockUserAccount(uid, reason);
    } catch (err) {
      console.error('applyMultiAccountConsequences error for user', uid, err);
    }
  }
}

// Runs the moment a player's game:join is about to be granted — see the two checks required:
// (a) a HARD device-fingerprint match against anyone already live-connected to this SAME ROUND,
// (b) a network/history match: the joining account shared an IP with an already-connected account
// at any point in the last 7 days (covers "same house, different network right now" as well as
// "literally the same network right now"). Either match blocks the join and logs an incident.
// Returns every live-connections roundId that should be compared together for multi-account
// purposes. For a Monthly Tournament round this is every OTHER room in the SAME tournament edition
// and the SAME stage — all ~35 qualification rooms across ALL 4 qualification rounds together, or
// all 4 semifinal rooms together — not just the one room a player happens to be in. Without this,
// two colluding accounts could deliberately spread across different qualification/semifinal rooms
// and never once share a room's roundLiveConnections map, riding the entire qualification stage
// (and possibly semifinals) completely undetected — only ever risking exposure in the Final's
// single room, by which point they've already unfairly gained an advantage through the whole
// tournament. Falls back to just [roundId] for any round that isn't part of a Monthly Tournament at
// all (regular Pokoje Bitewne, Mini-Turniej, ad-hoc admin tournament rooms).
async function getMultiAccountCheckScopeRoundIds(roundId) {
  const tournamentRoom = await TournamentRoom.findOne({ roundDbId: roundId }).select('tournamentId roundNumber');
  if (!tournamentRoom) return [roundId];
  const stageFilter = tournamentRoom.roundNumber <= 4
    ? { tournamentId: tournamentRoom.tournamentId, roundNumber: { $lte: 4 } } // whole qualification stage (rounds 1-4)
    : { tournamentId: tournamentRoom.tournamentId, roundNumber: tournamentRoom.roundNumber }; // semifinal (4 rooms) or final (1 room, no-op)
  const siblingRooms = await TournamentRoom.find(stageFilter).select('roundDbId');
  const ids = siblingRooms.map((r) => r.roundDbId?.toString()).filter(Boolean);
  return ids.length ? ids : [roundId];
}

async function performMultiAccountCheck({ roundId, userId, deviceId, ip }) {
  const scopeRoundIds = await getMultiAccountCheckScopeRoundIds(roundId);
  const others = [];
  for (const rid of scopeRoundIds) {
    const connections = roundLiveConnections.get(rid);
    if (!connections) continue;
    for (const info of connections.values()) {
      if (info.userId && info.userId !== userId) others.push(info);
    }
  }
  if (!others.length) return { blocked: false };

  if (deviceId) {
    const deviceMatch = others.find((info) => info.deviceId && info.deviceId === deviceId);
    if (deviceMatch) {
      await recordMultiAccountIncident({ roundId, mainUserId: deviceMatch.userId, secondaryUserId: userId, reason: 'device_id_match', deviceId });
      await applyMultiAccountConsequences(deviceMatch.userId, userId, roundId);
      return { blocked: true, message: 'Wykryto próbę dołączenia z tego samego urządzenia co inne konto już obecne w tej rozgrywce. Oba konta zostały zablokowane i wykluczone z dalszej gry.' };
    }
  }

  const since = new Date(Date.now() - MULTIACCOUNT_IP_WINDOW_MS);
  const me = await User.findById(userId).select('hardwareId loginHistory');
  const myIps = new Set((me?.loginHistory || []).filter((h) => h.at && h.at >= since).map((h) => h.ip).filter(Boolean));
  if (ip) myIps.add(ip);

  for (const info of others) {
    const otherUser = await User.findById(info.userId).select('hardwareId loginHistory');
    if (!otherUser) continue;

    // Permanent check: this account (or the other one) was already pinned to the SAME hardwareId by
    // a past confirmed incident, regardless of what device/network either side is using right now —
    // once two accounts are confirmed linked, that pairing stays blocked in future rounds too, not
    // just for as long as the original matching IP/device happens to still be in use.
    if (me?.hardwareId && otherUser.hardwareId && me.hardwareId === otherUser.hardwareId) {
      await recordMultiAccountIncident({ roundId, mainUserId: info.userId, secondaryUserId: userId, reason: 'pinned_hardware_id_match', deviceId: me.hardwareId });
      await applyMultiAccountConsequences(info.userId, userId, roundId);
      return { blocked: true, message: 'To konto zostało już wcześniej trwale powiązane z innym kontem obecnym w tej rozgrywce. Oba konta zostały zablokowane i wykluczone z dalszej gry.' };
    }

    if (myIps.size) {
      const otherIps = new Set((otherUser.loginHistory || []).filter((h) => h.at && h.at >= since).map((h) => h.ip).filter(Boolean));
      if (info.ip) otherIps.add(info.ip);
      const shared = [...myIps].find((candidate) => otherIps.has(candidate));
      if (shared) {
        await recordMultiAccountIncident({ roundId, mainUserId: info.userId, secondaryUserId: userId, reason: 'shared_ip_history', deviceId, sharedIp: shared });
        await applyMultiAccountConsequences(info.userId, userId, roundId);
        return { blocked: true, message: 'Wykryto powiązanie sieciowe (wspólny adres IP w ciągu ostatnich 7 dni) z innym kontem już obecnym w tej rozgrywce. Oba konta zostały zablokowane i wykluczone z dalszej gry.' };
      }
    }
  }

  return { blocked: false };
}

// Safety-net re-scans, on top of the join-time check: a round's whole live roster gets re-compared
// pairwise partway through the round and again near its end, catching anything the join-time check
// could have missed. Cheap by construction — real rounds have at most a handful of live connections,
// this runs at most twice per round's whole lifetime (not per tick), and performMultiAccountCheck's
// own DB lookups are all single-document _id lookups.
async function scanRoundForMultiAccounts(roundId) {
  try {
    const connections = roundLiveConnections.get(roundId);
    if (!connections || connections.size < 2) return;
    // One representative connection per distinct account (a user could have >1 socket/tab open).
    const byUserId = new Map();
    for (const info of connections.values()) {
      if (info.userId && !byUserId.has(info.userId)) byUserId.set(info.userId, info);
    }
    for (const [userId, info] of byUserId.entries()) {
      // A prior pair match earlier in this same scan may have already kicked this account out of
      // roundLiveConnections entirely — performMultiAccountCheck handles that gracefully (it just
      // finds no `others` left for them), so no extra bookkeeping is needed here.
      await performMultiAccountCheck({ roundId, userId, deviceId: info.deviceId, ip: info.ip });
    }
  } catch (err) {
    console.error('scanRoundForMultiAccounts error', err);
  }
}

const MULTIACCOUNT_EARLY_SCAN_MS = 5 * 60 * 1000; // 5 minut po starcie rundy
const MULTIACCOUNT_LATE_SCAN_WINDOW_MS = 5 * 60 * 1000; // ostatnie 5 minut przed końcem rundy
// Keyed by plain roundId — a Round's _id is never reused/recycled the way a Room used to be, so
// (unlike the old room-based version of this map) there's no need for a compound key to guard
// against stale "already scanned" flags surviving into a new round.
const multiAccountScanFlags = new Map();

function maybeScanRoundForMultiAccounts(roundId, state) {
  if (!Number.isFinite(state.roundStartedAt) || !Number.isFinite(state.roundEndsAt)) return;
  const flags = multiAccountScanFlags.get(roundId) || { earlyDone: false, lateDone: false };
  const now = Date.now();
  let changed = false;
  if (!flags.earlyDone && (now - state.roundStartedAt) >= MULTIACCOUNT_EARLY_SCAN_MS) {
    flags.earlyDone = true;
    changed = true;
    scanRoundForMultiAccounts(roundId);
  }
  if (!flags.lateDone && now < state.roundEndsAt && (state.roundEndsAt - now) <= MULTIACCOUNT_LATE_SCAN_WINDOW_MS) {
    flags.lateDone = true;
    changed = true;
    scanRoundForMultiAccounts(roundId);
  }
  if (changed) multiAccountScanFlags.set(roundId, flags);
}

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}${socket.userId ? ` (user ${socket.username})` : ''}`);

  if (socket.userId) {
    if (!onlineUserSockets.has(socket.userId)) onlineUserSockets.set(socket.userId, new Set());
    onlineUserSockets.get(socket.userId).add(socket.id);
    GlobalChatMessage.find().sort({ at: -1 }).limit(GLOBAL_CHAT_HISTORY_LIMIT).lean()
      .then((rows) => {
        const history = rows.reverse().map((row) => ({ username: row.username, isAdmin: row.isAdmin, text: row.text, at: row.at.getTime() }));
        socket.emit('globalChat:history', history);
      })
      .catch((err) => console.error('globalChat:history load error', err));
  }

  // Global player chat (main dashboard) — anyone with a valid session can post; text is trimmed and
  // capped the same way as the team-lobby chat above. Broadcast happens immediately; the Mongo write
  // is fire-and-forget so a slow DB never delays message delivery.
  socket.on('globalChat:send', (text) => {
    try {
      if (!socket.userId) return socket.emit('error', 'Musisz być zalogowany, aby pisać na czacie.');
      const trimmed = String(text || '').trim().slice(0, 300);
      if (!trimmed) return;
      const message = { username: socket.username, isAdmin: !!socket.isAdmin, text: trimmed, at: Date.now() };
      io.emit('globalChat:message', message);
      GlobalChatMessage.create({ username: message.username, isAdmin: message.isAdmin, text: message.text, at: new Date(message.at) })
        .catch((err) => console.error('globalChat:send persist error', err));
    } catch (err) {
      console.error('globalChat:send error', err);
      socket.emit('error', 'Błąd podczas wysyłania wiadomości.');
    }
  });

  socket.on('lobby:join', async ({ id, username, roomId }) => {
    try {
      const uid = id;
      if (!uid || !roomId) return socket.emit('error', 'Brak identyfikatora użytkownika lub pokoju.');
      const room = await Room.findById(roomId);
      const user = await User.findById(uid);
      if (!room || !user) return socket.emit('error', 'Nie znaleziono pokoju lub użytkownika.');
      socket.join(roomId);
      socketToInfo.set(socket.id, { userId: uid, roomId });
      io.to(roomId).emit('lobby:update_list', room.waitingPlayers || []);
    } catch (err) {
      console.error('lobby:join error', err);
      socket.emit('error', 'Błąd podczas dołączania do lobby.');
    }
  });

  // Mini-Tournament equivalent of lobby:join — sent instead of it for isMiniTournament rooms.
  // Always replies with an explicit matchmaking:state so the client renders the right phase
  // regardless of whether this is a fresh page load, a reconnect mid-search, a reconnect mid-accept,
  // or a reconnect after the match already fully resolved (waitingPlayers already populated).
  socket.on('matchmaking:join', async ({ id, roomId }) => {
    try {
      const uid = id;
      if (!uid || !roomId) return socket.emit('error', 'Brak identyfikatora użytkownika lub pokoju.');
      const room = await Room.findById(roomId);
      if (!room || !room.isMiniTournament) return socket.emit('error', 'Nieprawidłowy pokój.');
      socket.join(roomId);
      socketToInfo.set(socket.id, { userId: uid, roomId });

      if (room.waitingPlayers.some((p) => p.userId && p.userId.toString() === uid)) {
        return io.to(roomId).emit('lobby:update_list', room.waitingPlayers || []); // already matched & revealed
      }
      const pm = pendingMatches.get(roomId);
      const pmEntry = pm?.players.find((p) => p.userId === uid);
      if (pmEntry) {
        pmEntry.socketId = socket.id;
        return socket.emit('matchmaking:state', { phase: 'matchFound', matchId: pm.matchId, deadlineAt: pm.deadlineAt, alreadyAccepted: pm.acceptedUserIds.has(uid) });
      }
      const queue = miniTournamentQueues.get(roomId) || [];
      const qEntry = queue.find((p) => p.userId === uid);
      if (qEntry) {
        qEntry.socketId = socket.id;
        qEntry.disconnectedAt = null;
        return socket.emit('matchmaking:state', { phase: 'searching', queuedAt: qEntry.queuedAt });
      }
      socket.emit('matchmaking:state', { phase: 'idle' });
    } catch (err) {
      console.error('matchmaking:join error', err);
      socket.emit('error', 'Błąd podczas dołączania do kolejki.');
    }
  });

  socket.on('matchmaking:accept', ({ roomId, matchId }) => {
    try {
      const info = socketToInfo.get(socket.id);
      const uid = info?.userId;
      if (!uid || !roomId || !matchId) return;
      const pm = pendingMatches.get(roomId);
      if (!pm || pm.matchId !== matchId) return; // stale/expired — ignore silently
      if (!pm.players.some((p) => p.userId === uid)) return;
      pm.acceptedUserIds.add(uid);
      if (pm.acceptedUserIds.size === pm.players.length) {
        clearTimeout(pm.timer);
        resolveMatch(roomId, matchId).catch((err) => console.error('resolveMatch (full accept) error', err));
      }
    } catch (err) {
      console.error('matchmaking:accept error', err);
    }
  });

  socket.on('lobby:addBot', async (roomId) => {
    try {
      const info = socketToInfo.get(socket.id);
      const uid = info?.userId;
      if (!uid || !roomId) return socket.emit('error', 'Brak identyfikatora pokoju lub użytkownika.');
      const user = await User.findById(uid);
      if (!user) return socket.emit('error', 'Nie znaleziono użytkownika.');
      const room = await Room.findById(roomId);
      if (!room) return socket.emit('error', 'Nie znaleziono pokoju.');
      if (room.roomType === 'team') return socket.emit('error', 'Nie można dodawać botów do pokoju drużynowego.');
      if (room.isMiniTournament) return socket.emit('error', 'Ta funkcja jest niedostępna w pokojach Mini-Turniejowych.');
      // Monthly Tournament rooms (qualification/semifinal/final) never allow bots in real play —
      // every seat there must be a real player who actually bought/qualified for it. No exception
      // for admins either: this is a hard product rule, not a permissions gate.
      if (room.isTournament) return socket.emit('error', 'Ta funkcja jest niedostępna w rundach Turnieju Miesięcznego.');
      if (!user.isAdmin && !room.playersCanAddBots) return socket.emit('error', 'Brak uprawnień administratora.');
      if (room.waitingPlayers.length >= room.maxPlayers) return socket.emit('error', 'Brak wolnych miejsc');
      // Adds exactly ONE bot per click — admins fill seats one at a time, never an auto-fill-to-max.
      const botName = `Bot_${uuidv4().slice(0, 8)}`;
      const bot = await User.create({ username: botName, passwordHash: 'bot', isBot: true });
      room.waitingPlayers.push({ userId: bot._id, username: bot.username, isBot: true, color: nextAvailableColor(room.waitingPlayers) });
      await room.save();
      io.to(roomId).emit('roomUpdated', room);
      io.to(roomId).emit('lobby:update_list', room.waitingPlayers || []);
      if (room.roomType === 'percentage') {
        maybeStartReadyRoom(room);
      } else if (room.waitingPlayers.length >= room.maxPlayers) {
        startCountdown(roomId);
      }
    } catch (err) {
      console.error('lobby:addBot error', err);
      socket.emit('error', 'Błąd podczas dodawania bota.');
    }
  });

  // Removes a single bot from a room's queue — same permission gate as lobby:addBot (admin, or any
  // player when room.playersCanAddBots is set), but restricted to bot targets only: use lobby:kick
  // for removing a real player (admin-only). Unlike a real player leaving, the bot's own User
  // document is deleted outright rather than just pulled from waitingPlayers — a bot that never
  // even got to play has no history worth keeping, and leaving it behind would just recreate the
  // exact kind of throwaway-account buildup that was recently cleaned out of the database.
  socket.on('lobby:removeBot', async ({ roomId, targetUserId }) => {
    try {
      const info = socketToInfo.get(socket.id);
      const uid = info?.userId;
      if (!uid || !roomId || !targetUserId) return socket.emit('error', 'Brak identyfikatora pokoju lub bota.');
      const user = await User.findById(uid);
      if (!user) return socket.emit('error', 'Nie znaleziono użytkownika.');
      const room = await Room.findById(roomId);
      if (!room) return socket.emit('error', 'Nie znaleziono pokoju.');
      if (!user.isAdmin && !room.playersCanAddBots) return socket.emit('error', 'Brak uprawnień administratora.');
      if (roomCountdowns.has(roomId)) return socket.emit('error', 'Trwa odliczanie do startu rundy — nie można już usunąć bota.');
      const target = room.waitingPlayers.find((p) => p.userId && p.userId.toString() === targetUserId);
      if (!target || !target.isBot) return socket.emit('error', 'Nie znaleziono tego bota w pokoju.');
      await leaveWaitingRoom(roomId, targetUserId);
      await User.deleteOne({ _id: targetUserId, isBot: true });
    } catch (err) {
      console.error('lobby:removeBot error', err);
      socket.emit('error', 'Błąd podczas usuwania bota.');
    }
  });

  socket.on('lobby:kick', async ({ roomId, targetUserId }) => {
    try {
      const info = socketToInfo.get(socket.id);
      const uid = info?.userId;
      if (!uid || !roomId || !targetUserId) return socket.emit('error', 'Brak identyfikatora pokoju lub gracza.');
      const user = await User.findById(uid);
      if (!user || !user.isAdmin) return socket.emit('error', 'Brak uprawnień administratora.');
      await leaveWaitingRoom(roomId, targetUserId, true);
    } catch (err) {
      console.error('lobby:kick error', err);
      socket.emit('error', 'Błąd podczas wyrzucania gracza.');
    }
  });

  // Percentage- and team-mode rooms only — a real player toggles their own ready state; once every
  // non-bot player in the queue is ready (plus the mode-specific minimum, see maybeStartReadyRoom),
  // the round starts automatically the same way a full 'standard' room does (10s countdown).
  socket.on('lobby:toggleReady', async (roomId) => {
    try {
      const info = socketToInfo.get(socket.id);
      const uid = info?.userId;
      if (!uid || !roomId) return socket.emit('error', 'Brak identyfikatora pokoju lub użytkownika.');
      const room = await Room.findById(roomId);
      if (!room) return socket.emit('error', 'Nie znaleziono pokoju.');
      if (room.roomType !== 'percentage' && room.roomType !== 'team') return socket.emit('error', 'Ten pokój nie używa systemu gotowości.');
      // Once the countdown has started, the ready flags are locked — nobody can un-ready and
      // sabotage the round that's already committed to starting.
      if (roomCountdowns.has(roomId)) return socket.emit('error', 'Trwa odliczanie do startu rundy — nie można już zmienić statusu gotowości.');
      const player = room.waitingPlayers.find((p) => p.userId && p.userId.toString() === uid);
      if (!player || player.isBot) return socket.emit('error', 'Nie jesteś w tym pokoju.');
      // Team mode: a player must pick a team before they can ready up — otherwise
      // assignVillagesToPlayersTeamMode would have nowhere to place them once the round starts.
      if (room.roomType === 'team' && player.teamId == null) return socket.emit('error', 'Wybierz najpierw drużynę.');
      player.ready = !player.ready;
      await room.save();
      io.to(roomId).emit('roomUpdated', room);
      io.to(roomId).emit('lobby:update_list', room.waitingPlayers || []);
      maybeStartReadyRoom(room);
    } catch (err) {
      console.error('lobby:toggleReady error', err);
      socket.emit('error', 'Błąd podczas zmiany statusu gotowości.');
    }
  });

  // Percentage rooms only — the ready-check has no time limit, so a single real player who never
  // clicks "Gotowy" (AFK, or deliberately griefing) can block the room forever with no admin
  // around to fix it. Lets any other real player already queued vote to remove them; needs
  // VOTE_KICK_THRESHOLD distinct votes to actually happen — set equal to the room's own
  // minimum-to-start headcount (5) so a successful kick can never itself be the reason too few
  // players remain to start (kicking 1 out of exactly 5 always still leaves people free to keep
  // playing/waiting for a 5th, same as before anyone joined). Deliberately NOT offered in
  // 'standard'/'team' rooms per spec: standard needs 10 and starts regardless of activity once
  // full, team rooms have no fixed minimum and players self-organize instead.
  const VOTE_KICK_THRESHOLD = 5;
  socket.on('lobby:voteKick', async ({ roomId, targetUserId }) => {
    try {
      const info = socketToInfo.get(socket.id);
      const uid = info?.userId;
      if (!uid || !roomId || !targetUserId) return socket.emit('error', 'Brak identyfikatora pokoju lub gracza.');
      if (uid === targetUserId) return socket.emit('error', 'Nie możesz zagłosować na wyrzucenie samego siebie.');
      const room = await Room.findById(roomId);
      if (!room) return socket.emit('error', 'Nie znaleziono pokoju.');
      if (room.roomType !== 'percentage') return socket.emit('error', 'Głosowanie na wyrzucenie działa tylko w pokojach z systemem gotowości.');
      if (roomCountdowns.has(roomId)) return socket.emit('error', 'Trwa odliczanie do startu rundy — nie można już głosować.');
      const voter = room.waitingPlayers.find((p) => p.userId && p.userId.toString() === uid);
      if (!voter || voter.isBot) return socket.emit('error', 'Nie jesteś w tym pokoju.');
      const target = room.waitingPlayers.find((p) => p.userId && p.userId.toString() === targetUserId);
      if (!target || target.isBot) return socket.emit('error', 'Nie znaleziono tego gracza w pokoju.');
      if ((target.kickVotes || []).some((v) => v.toString() === uid)) {
        return socket.emit('error', 'Już zagłosowałeś na wyrzucenie tego gracza.');
      }
      target.kickVotes.push(uid);
      if (target.kickVotes.length >= VOTE_KICK_THRESHOLD) {
        await room.save();
        await leaveWaitingRoom(roomId, targetUserId);
        maybeStartReadyRoom(await Room.findById(roomId));
        return;
      }
      await room.save();
      io.to(roomId).emit('roomUpdated', room);
      io.to(roomId).emit('lobby:update_list', room.waitingPlayers || []);
    } catch (err) {
      console.error('lobby:voteKick error', err);
      socket.emit('error', 'Błąd podczas głosowania na wyrzucenie gracza.');
    }
  });

  // Team mode: a real player picks (or switches to) one of the room's admin-chosen `teamCount`
  // (2-10) team slots, capped at TEAM_REGION_SIZE (5) members each — that cap is what guarantees
  // assignVillagesToPlayersTeamMode always finds a free village in the team's region once the round
  // starts. Switching teams while already marked ready un-readies the player (a fresh choice
  // shouldn't silently carry over an old "I'm ready" state).
  socket.on('lobby:setTeam', async ({ roomId, teamId }) => {
    try {
      const info = socketToInfo.get(socket.id);
      const uid = info?.userId;
      const parsedTeamId = Number(teamId);
      if (!uid || !roomId) return socket.emit('error', 'Brak identyfikatora pokoju lub użytkownika.');
      if (!Number.isInteger(parsedTeamId) || parsedTeamId < 1) return socket.emit('error', 'Nieprawidłowa drużyna.');
      const room = await Room.findById(roomId);
      if (!room) return socket.emit('error', 'Nie znaleziono pokoju.');
      if (room.roomType !== 'team') return socket.emit('error', 'Ten pokój nie obsługuje wyboru drużyny.');
      if (parsedTeamId > (room.teamCount || 2)) return socket.emit('error', 'Nieprawidłowa drużyna.');
      if (roomCountdowns.has(roomId)) return socket.emit('error', 'Trwa odliczanie do startu rundy — nie można już zmienić drużyny.');
      const player = room.waitingPlayers.find((p) => p.userId && p.userId.toString() === uid);
      if (!player || player.isBot) return socket.emit('error', 'Nie jesteś w tym pokoju.');
      if (player.teamId === parsedTeamId) return;
      // Atomic capacity check + assignment in one findOneAndUpdate — a plain "count members, then
      // save" (like the rest of this handler above) has a TOCTOU race: two players (or a player and
      // an admin's lobby:addBotToTeam) reading the same 4-member count at once can both pass the
      // "<5" check and both save, leaving the team with 6 members. assignVillagesToPlayersTeamMode
      // then has only 5 region slots for that team, so the 6th member gets no village at all.
      const updated = await Room.findOneAndUpdate(
        {
          _id: roomId,
          $expr: {
            $lt: [
              { $size: { $filter: { input: '$waitingPlayers', as: 'p', cond: { $eq: ['$$p.teamId', parsedTeamId] } } } },
              GameEngine.TEAM_REGION_SIZE
            ]
          }
        },
        { $set: { 'waitingPlayers.$[elem].teamId': parsedTeamId, 'waitingPlayers.$[elem].ready': false } },
        { arrayFilters: [{ 'elem.userId': player.userId }], new: true }
      );
      if (!updated) return socket.emit('error', 'Ta drużyna jest już pełna (max 5 graczy).');
      io.to(roomId).emit('roomUpdated', updated);
      io.to(roomId).emit('lobby:update_list', updated.waitingPlayers || []);
    } catch (err) {
      console.error('lobby:setTeam error', err);
      socket.emit('error', 'Błąd podczas wyboru drużyny.');
    }
  });

  // Admin-only: seat a bot directly into a specific team slot (bypasses the generic lobby:addBot,
  // which is blocked entirely for 'team' rooms since it has no team to assign — see the guard
  // below). Bots are always pre-marked ready since they can't click the button themselves.
  socket.on('lobby:addBotToTeam', async ({ roomId, teamId }) => {
    try {
      const info = socketToInfo.get(socket.id);
      const uid = info?.userId;
      const parsedTeamId = Number(teamId);
      if (!uid || !roomId) return socket.emit('error', 'Brak identyfikatora pokoju lub użytkownika.');
      const user = await User.findById(uid);
      if (!user || !user.isAdmin) return socket.emit('error', 'Brak uprawnień administratora.');
      if (!Number.isInteger(parsedTeamId) || parsedTeamId < 1) return socket.emit('error', 'Nieprawidłowa drużyna.');
      const room = await Room.findById(roomId);
      if (!room) return socket.emit('error', 'Nie znaleziono pokoju.');
      if (room.roomType !== 'team') return socket.emit('error', 'Ten pokój nie obsługuje drużyn.');
      if (parsedTeamId > (room.teamCount || 2)) return socket.emit('error', 'Nieprawidłowa drużyna.');
      if (room.waitingPlayers.length >= room.maxPlayers) return socket.emit('error', 'Brak wolnych miejsc');
      const botName = `Bot_${uuidv4().slice(0, 8)}`;
      const bot = await User.create({ username: botName, passwordHash: 'bot', isBot: true });
      // Same atomic capacity check as lobby:setTeam above — closes the TOCTOU race between this
      // handler and a concurrent lobby:setTeam/lobby:addBotToTeam call both reading the same
      // under-5 count before either write commits.
      const updated = await Room.findOneAndUpdate(
        {
          _id: roomId,
          $expr: {
            $lt: [
              { $size: { $filter: { input: '$waitingPlayers', as: 'p', cond: { $eq: ['$$p.teamId', parsedTeamId] } } } },
              GameEngine.TEAM_REGION_SIZE
            ]
          }
        },
        { $push: { waitingPlayers: { userId: bot._id, username: bot.username, isBot: true, color: nextAvailableColor(room.waitingPlayers), teamId: parsedTeamId, ready: true } } },
        { new: true }
      );
      if (!updated) {
        await User.deleteOne({ _id: bot._id });
        return socket.emit('error', 'Ta drużyna jest już pełna (max 5 graczy).');
      }
      io.to(roomId).emit('roomUpdated', updated);
      io.to(roomId).emit('lobby:update_list', updated.waitingPlayers || []);
      maybeStartReadyRoom(updated);
    } catch (err) {
      console.error('lobby:addBotToTeam error', err);
      socket.emit('error', 'Błąd podczas dodawania bota do drużyny.');
    }
  });

  // Team mode lobby chat — purely ephemeral (live broadcast only, nothing persisted to Mongo) so
  // players waiting together can agree on how many teams/players-per-team they want to play before
  // marking ready. Anyone currently queued in that room's waitingPlayers can post.
  socket.on('lobby:chatMessage', async ({ roomId, text }) => {
    try {
      const info = socketToInfo.get(socket.id);
      const uid = info?.userId;
      if (!uid || !roomId) return socket.emit('error', 'Brak identyfikatora pokoju lub użytkownika.');
      const trimmed = String(text || '').trim().slice(0, 300);
      if (!trimmed) return;
      const room = await Room.findById(roomId);
      if (!room) return socket.emit('error', 'Nie znaleziono pokoju.');
      const player = room.waitingPlayers.find((p) => p.userId && p.userId.toString() === uid);
      if (!player || player.isBot) return socket.emit('error', 'Nie jesteś w tym pokoju.');
      io.to(roomId).emit('lobby:chatMessage', { username: player.username, text: trimmed, at: Date.now() });
    } catch (err) {
      console.error('lobby:chatMessage error', err);
      socket.emit('error', 'Błąd podczas wysyłania wiadomości.');
    }
  });

  socket.on('game:start', async (roomId) => {
    try {
      const info = socketToInfo.get(socket.id);
      const uid = info?.userId;
      if (!uid || !roomId) return socket.emit('game:error', 'Brak identyfikatora pokoju lub użytkownika.');
      const user = await User.findById(uid);
      if (!user || !user.isAdmin) return socket.emit('game:error', 'Brak uprawnień administratora.');
      const room = await Room.findById(roomId);
      if (!room) return socket.emit('game:error', 'Nie znaleziono pokoju.');
      if (room.isMiniTournament) return socket.emit('game:error', 'Ta funkcja jest niedostępna w pokojach Mini-Turniejowych.');
      if (!room.waitingPlayers.length) return socket.emit('game:error', 'Pokój jest pusty.');
      // Team rooms: admin can force-start at any moment (no ready-check/team-count minimum needed) —
      // the only hard requirement is that every waiting player already picked a team, since
      // assignVillagesToPlayersTeamMode has nowhere to place someone with no teamId.
      if (room.roomType === 'team' && room.waitingPlayers.some((p) => p.teamId == null)) {
        return socket.emit('game:error', 'Nie wszyscy gracze wybrali drużynę.');
      }
      startCountdown(roomId);
    } catch (err) {
      console.error('game:start error', err);
      socket.emit('game:error', 'Błąd podczas rozpoczynania gry.');
    }
  });

  socket.on('adminAddBots', async ({ roomId, token } = {}) => {
    try {
      // Tozsamosc tylko z zalogowanego polaczenia (albo podpisanego tokenu) - nigdy z pola adminId
      // przyslanego przez klienta (wczesniej dowolny gracz mogl podac cudze ID admina).
      let aid = socket.userId;
      if (!aid && token) {
        const data = jwt.verify(token, JWT_SECRET);
        aid = data.id;
      }
      if (!aid) return socket.emit('error', 'Brak uprawnień administratora.');
      const user = await User.findById(aid);
      if (!user || (user.username !== 'Dariano' && !user.isAdmin)) {
        return socket.emit('error', 'Brak uprawnień administratora.');
      }

      const room = await Room.findById(roomId);
      if (!room) return socket.emit('error', 'Nie znaleziono pokoju.');
      if (room.roomType === 'team') return socket.emit('error', 'Nie można dodawać botów do pokoju drużynowego.');
      if (room.isMiniTournament) return socket.emit('error', 'Ta funkcja jest niedostępna w pokojach Mini-Turniejowych.');
      // Pokoje z nagrodami: tylko prawdziwi gracze (boty dzialaja losowo - patrz Regulamin §1a).
      if (room.isTournament) return socket.emit('error', 'Ta funkcja jest niedostępna w rundach Turnieju Miesięcznego.');

      const freeSlots = room.maxPlayers - room.waitingPlayers.length;
      if (freeSlots <= 0) return socket.emit('error', 'Brak wolnych miejsc');

      for (let i = 0; i < freeSlots; i++) {
        const botName = `Bot_${uuidv4().slice(0, 8)}`;
        const bot = await User.create({ username: botName, passwordHash: 'bot', isBot: true });
        room.waitingPlayers.push({ userId: bot._id, username: bot.username, isBot: true, color: nextAvailableColor(room.waitingPlayers) });
      }

      await room.save();
      io.to(roomId).emit('roomUpdated', room);

      if (room.roomType === 'percentage') {
        maybeStartReadyRoom(room);
      } else if (room.waitingPlayers.length >= room.maxPlayers) {
        startCountdown(roomId);
      }
    } catch (err) {
      console.error('adminAddBots error', err);
      socket.emit('error', 'Błąd podczas dodawania botów.');
    }
  });

  socket.on('disconnecting', () => {
    try {
      const info = socketToInfo.get(socket.id);
      if (info) {
        // leaveWaitingRoom is a safe no-op if this user isn't (or is no longer) in that room's
        // queue, so there's no need to pre-check anything here — unlike the old dual-purpose
        // removePlayerFromRoom, this function only ever touches the waiting queue.
        leaveWaitingRoom(info.roomId, info.userId, true).catch((err) => console.error('disconnect leave error', err));
        // Blind matchmaking queue: don't remove on disconnect (a page refresh or brief WiFi blip
        // shouldn't cost someone their place in line) — just mark the socket gone; runMatchingTick's
        // pruneDisconnectedFromQueue sweeps anyone still disconnected after MM_QUEUE_DISCONNECT_GRACE_MS.
        // A pendingMatches entry is deliberately left alone here too — the 15s accept timer is the
        // only resolution trigger, so a brief disconnect mid-accept doesn't cost the other 9 players.
        const queueEntry = miniTournamentQueues.get(info.roomId)?.find((p) => p.userId === info.userId);
        if (queueEntry) {
          queueEntry.socketId = null;
          queueEntry.disconnectedAt = Date.now();
        }
        socketToInfo.delete(socket.id);
      }
      if (socket.currentGameRoundId) {
        roundLiveConnections.get(socket.currentGameRoundId)?.delete(socket.id);
      }
      if (socket.userId) {
        const sockets = onlineUserSockets.get(socket.userId);
        if (sockets) {
          sockets.delete(socket.id);
          if (sockets.size === 0) onlineUserSockets.delete(socket.userId);
        }
      }
    } catch(e){ console.error('disconnecting handler error', e); }
  });

  // --- Live game (post-lobby) realtime sync -------------------------------------------------
  // Everything below replaces the old REST polling (GET/POST /api/game/session/:roomId) that used
  // to run once per browser per second. The server is now the only place that ever mutates a
  // round's game state; clients only ever send an intent ("I want to queue this building") and
  // render whatever game:state broadcast comes back.

  socket.on('game:join', async ({ roundId }) => {
    try {
      if (!socket.userId) return socket.emit('game:error', 'Musisz być zalogowany.');
      if (!roundId) return socket.emit('game:error', 'Brak identyfikatora rundy.');
      const round = await Round.findById(roundId);
      if (!round) return socket.emit('game:error', 'Nie znaleziono rundy.');
      const players = round.state?.players || [];
      const isMember = players.some((p) => p.userId && String(p.userId) === socket.userId);
      if (!isMember && !socket.isAdmin) return socket.emit('game:error', 'Nie jesteś graczem w tej rundzie.');

      // Multi-account gate: runs for every real player claiming a seat, INCLUDING an admin who is
      // themselves also a player (e.g. Dariano) — otherwise an admin joining AFTER a non-admin
      // already in the round would never get compared against anyone (their own join was always
      // exempt from rejection), and that non-admin would never get checked either, since nobody else
      // was in the round yet at the moment THEY joined. Running the check unconditionally closes
      // that order-dependent gap: a match is still recorded and punished
      // (applyMultiAccountConsequences already skips isAdmin accounts when handing out
      // blocks/kicks), only the admin's OWN join is still never rejected below.
      if (isMember) {
        const socketIp = getSocketIp(socket);
        const check = await performMultiAccountCheck({ roundId, userId: socket.userId, deviceId: socket.deviceId, ip: socketIp });
        if (check.blocked && !socket.isAdmin) return socket.emit('game:error', check.message);
      }

      const state = gameSession.ensureSessionForRound(roundId, round);
      if (!state) return socket.emit('game:error', 'Runda jeszcze się nie rozpoczęła.');

      socket.join(roundId);
      socket.currentGameRoundId = roundId;
      if (!roundLiveConnections.has(roundId)) roundLiveConnections.set(roundId, new Map());
      roundLiveConnections.get(roundId).set(socket.id, { userId: socket.userId, deviceId: socket.deviceId, ip: getSocketIp(socket) });

      // Team-mode in-round chat: join this player's own team's private room (see teamChatHistory
      // above) and hand them whatever their team already said before this socket connected. A
      // spectating admin who isn't actually a player on any team (me undefined) just gets no team
      // channel — nothing to join, nothing to send them.
      const me = (state.players || []).find((p) => p.userId && String(p.userId) === socket.userId);
      socket.currentTeamId = null;
      if (state.mapType === 'team' && me && me.teamId != null) {
        socket.currentTeamId = me.teamId;
        const teamRoom = `team:${roundId}:${me.teamId}`;
        socket.join(teamRoom);
        socket.emit('game:teamChatHistory', teamChatHistory.get(`${roundId}:${me.teamId}`) || []);
      }

      socket.emit('game:init', { state, myUserId: socket.userId });
    } catch (err) {
      console.error('game:join error', err);
      socket.emit('game:error', 'Błąd serwera podczas dołączania do gry.');
    }
  });

  // In-round team chat send — was previously entirely missing: game.js already joins the private
  // `team:{roundId}:{teamId}` room and emits this exact event on submit (see teamChatForm's submit
  // handler), and the server already joined players to that room + handed back history on game:join,
  // but nothing ever listened for the message itself, so the chat window rendered and accepted input
  // yet no message ever reached a teammate. socket.currentTeamId is set once in game:join (team-mode
  // players only; never changes mid-round since team picks are locked once a round starts).
  socket.on('game:teamChatMessage', (text) => {
    try {
      const roundId = socket.currentGameRoundId;
      const teamId = socket.currentTeamId;
      if (!roundId || teamId == null) return;
      const trimmed = String(text || '').trim().slice(0, 300);
      if (!trimmed) return;
      const key = `${roundId}:${teamId}`;
      const message = { username: socket.username, text: trimmed, at: Date.now() };
      const history = teamChatHistory.get(key) || [];
      history.push(message);
      if (history.length > TEAM_CHAT_HISTORY_MAX) history.shift();
      teamChatHistory.set(key, history);
      io.to(`team:${roundId}:${teamId}`).emit('game:teamChatMessage', message);
    } catch (err) {
      console.error('game:teamChatMessage error', err);
    }
  });

  // Applies a mutator from GameEngine against the caller's OWN authoritative round session, then
  // broadcasts the fresh state to everyone in that round (including the caller — nobody's own click
  // is ever rendered from an optimistic local guess, only from this same server-confirmed payload).
  function registerGameCommand(eventName, mutate) {
    socket.on(eventName, (payload, ack) => {
      try {
        if (!socket.userId || !socket.currentGameRoundId) {
          if (typeof ack === 'function') ack({ ok: false, error: 'Brak aktywnej sesji gry.' });
          return;
        }
        const state = gameSession.getSession(socket.currentGameRoundId);
        if (!state) {
          if (typeof ack === 'function') ack({ ok: false, error: 'Sesja gry nie istnieje.' });
          return;
        }
        const result = mutate(state, socket.userId, payload || {}) || { ok: true };
        if (result.ok) {
          gameSession.persist(socket.currentGameRoundId);
          io.to(socket.currentGameRoundId).emit('game:state', state);
        }
        if (typeof ack === 'function') ack(result);
      } catch (err) {
        console.error(`${eventName} error`, err);
        if (typeof ack === 'function') ack({ ok: false, error: 'Błąd serwera.' });
      }
    });
  }

  registerGameCommand('game:queueBuilding', (state, userId, { villageId, buildingId }) => GameEngine.queueBuilding(state, userId, villageId, buildingId));
  registerGameCommand('game:cancelBuilding', (state, userId, { villageId, index }) => GameEngine.cancelBuildQueueItem(state, userId, villageId, index));
  registerGameCommand('game:recruitUnit', (state, userId, { villageId, unitId, count }) => GameEngine.recruitUnit(state, userId, villageId, unitId, count));
  registerGameCommand('game:cancelRecruit', (state, userId, { villageId, index }) => GameEngine.cancelRecruitQueueItem(state, userId, villageId, index));
  registerGameCommand('game:cancelLordRecruit', (state, userId, { villageId }) => GameEngine.cancelLordRecruit(state, userId, villageId));
  registerGameCommand('game:buyVillage', (state, userId, { villageId }) => GameEngine.buyVillage(state, userId, villageId));
  registerGameCommand('game:renameVillage', (state, userId, { villageId, label }) => GameEngine.renameVillage(state, userId, villageId, label));
  registerGameCommand('game:sendAttack', (state, userId, payload) => GameEngine.sendAttack(state, userId, payload));
  registerGameCommand('game:cancelAttack', (state, userId, { attackId }) => GameEngine.cancelOutgoingAttack(state, userId, attackId));
  registerGameCommand('game:sendSupport', (state, userId, payload) => GameEngine.sendSupport(state, userId, payload));
  registerGameCommand('game:recallSupport', (state, userId, { villageId, reinforcementId }) => GameEngine.recallSupport(state, userId, villageId, reinforcementId));
});

// 'percentage' rooms never auto-start on "queue full" — instead every real (non-bot) player must
// mark themselves ready via lobby:toggleReady, with at least 5 players (bots included) present.
// Bots are always treated as ready since they can never click the button themselves. Called after
// every action that could complete the condition: a player toggling ready, or a bot being added
// while everyone already-present was ready.
//
// 'team' rooms use the same ready-check mechanism but with a deliberately looser, flexible
// threshold (per the user's explicit spec): no minimum headcount and no fixed team count/size —
// players agree among themselves (via lobby:chatMessage) how many teams and how many per team they
// want, then everyone present marks ready. The only hard requirements are at least 2 distinct teams
// occupied (otherwise there's no opposing side) and every waiting player has actually picked a team
// (enforced already in lobby:toggleReady, checked again here defensively).
function maybeStartReadyRoom(room) {
  if (!room) return;
  if (room.roomType === 'percentage') {
    if (room.waitingPlayers.length < 5) return;
    const allReady = room.waitingPlayers.every((p) => p.isBot || p.ready);
    if (allReady) startCountdown(room._id.toString(), 10);
    return;
  }
  if (room.roomType === 'team') {
    if (!room.waitingPlayers.length) return;
    if (!room.waitingPlayers.every((p) => p.teamId != null)) return;
    const distinctTeams = new Set(room.waitingPlayers.map((p) => p.teamId));
    if (distinctTeams.size < 2) return;
    const allReady = room.waitingPlayers.every((p) => p.isBot || p.ready);
    if (allReady) startCountdown(room._id.toString(), 10);
  }
}

function startCountdown(roomId, seconds = 10) {
  if (roomCountdowns.has(roomId)) return;

  let remaining = seconds;
  const intervalId = setInterval(async () => {
    remaining -= 1;
    const countdownRecord = roomCountdowns.get(roomId);
    if (countdownRecord) {
      countdownRecord.remaining = remaining;
    }
    io.to(roomId).emit('countdown', { remaining });
    if (remaining <= 0) {
      clearInterval(intervalId);
      roomCountdowns.delete(roomId);
      const room = await Room.findById(roomId);
      if (!room || !room.waitingPlayers.length) return; // e.g. emptied via a kick during countdown

      // Snapshot the waiting queue into a brand-new, fully independent Round, then immediately
      // empty the queue back to zero — the Room is available for the NEXT round right away, and
      // this round runs completely on its own from here on (see gameSession.startSession).
      const roundStartedAt = new Date();
      const roundDurationSeconds = Math.max(1, Number(room.settings?.dlugoscRundySekundy) || 3600);
      const roundEndsAt = new Date(Date.now() + roundDurationSeconds * 1000);
      // Every room's pacing (build/recruit/travel/gold rates) now scales proportionally to its own
      // round length, exactly like Monthly Tournament qualification rounds already did — a 120-minute
      // round is the baseline (factor 1), a 60-minute room runs at 0.5x (half the real-world build
      // times, so the SAME proportion of a full economy is still reachable in the shorter time), a
      // 240-minute room at 2x, and so on. This is what "Prędkość: Nx" on every room tile actually
      // reflects (see formatRoom) — it was previously only true for tournament/mini-tournament rooms,
      // every plain Pokoje Bitewne room always ran at a flat, duration-independent pace before this.
      const timeScaleFactor = (roundDurationSeconds / 60) / tournamentEngine.QUALIFICATION_ROUND_BASELINE_MINUTES;
      const round = await Round.create({
        roomId: room._id,
        roomName: room.roomName,
        roomType: room.roomType,
        isTournament: room.isTournament === true,
        isMiniTournament: room.isMiniTournament === true,
        entryFee: room.entryFee,
        settings: room.settings,
        status: 'active',
        poolPP: room.poolPP,
        roundStartedAt,
        roundEndsAt,
        timeScaleFactor,
        state: {}
      });
      // Bridges this fresh Round back to the Monthly Tournament's PENDING semifinal/final
      // bookkeeping row (see tournamentEngine.seedBracketRoom/linkBracketRound) — no-op for every
      // other room (regular Pokoje Bitewne, ad-hoc admin-turnieje.html rooms, qualification rooms
      // which never go through this path at all), so safe to call unconditionally here.
      if (room.isTournament && (room.tournamentStage === 'semifinal' || room.tournamentStage === 'final')) {
        await tournamentEngine.linkBracketRound(room._id, round._id).catch((err) => console.error('linkBracketRound error', err));
      }
      const waitingPlayersSnapshot = room.waitingPlayers;
      room.waitingPlayers = [];
      room.poolPP = 0;
      await room.save();

      // A qualification round-entry is spent HERE, not at join time (see performRoomJoin) — every
      // real (non-bot) player in the snapshot already had at least 1 ticket to have gotten into
      // the queue at all, so this just claims one use of it now that the round is actually
      // starting. One ticket covers 4 round entries: qualificationRoundUses cycles 0→1→2→3→0, and
      // only wrapping back to 0 (the 4th use) actually consumes a whole tournamentTickets.
      if (room.isTournament) {
        const realPlayerIds = waitingPlayersSnapshot.filter((p) => !p.isBot && p.userId).map((p) => p.userId);
        if (realPlayerIds.length) {
          await User.updateMany({ _id: { $in: realPlayerIds } }, [
            { $set: {
                qualificationRoundUses: { $mod: [{ $add: [{ $ifNull: ['$qualificationRoundUses', 0] }, 1] }, 4] },
                tournamentTickets: {
                  $cond: [
                    { $eq: [{ $mod: [{ $add: [{ $ifNull: ['$qualificationRoundUses', 0] }, 1] }, 4] }, 0] },
                    { $subtract: [{ $ifNull: ['$tournamentTickets', 0] }, 1] },
                    { $ifNull: ['$tournamentTickets', 0] }
                  ]
                }
              }
            }
          ]);
        }
      }

      const roundId = round._id.toString();
      startRoundTimer(roundId);
      // Creates the ONE authoritative session for this round (villages assigned once, server-side —
      // see gameSession.startSession) before any client even has a chance to connect and simulate
      // its own guess of who owns what.
      await gameSession.startSession(round, waitingPlayersSnapshot);
      if (room.isMiniTournament) {
        chainApi.onRoundStarted({ round, roomName: room.roomName, players: waitingPlayersSnapshot }).catch((err) => console.error('chain onRoundStarted error', err));
      }
      io.to(roomId).emit('lobby:update_list', []);
      io.to(roomId).emit('gameStarted', {
        redirectUrl: '/game.html',
        roundId,
        roomId: room._id.toString(),
        roomName: room.roomName
      });
    }
  }, 1000);

  roomCountdowns.set(roomId, { intervalId, remaining });
  io.to(roomId).emit('countdown', { remaining });
}

function cancelCountdown(roomId) {
  const rec = roomCountdowns.get(roomId);
  if (!rec) return;
  clearInterval(rec.intervalId);
  roomCountdowns.delete(roomId);
  io.to(roomId).emit('countdownCancelled');
}

// Gives the server a clear beat to settle everything (last tick, payout, final state snapshot)
// before the podium appears, and gives players a visible "runda się kończy" moment instead of the
// results just popping up abruptly the instant the timer hits zero.
const ROUND_ENDING_BUFFER_MS = 5000;

function startRoundTimer(roundId) {
  if (roundTimers.has(roundId)) return;

  const intervalId = setInterval(async () => {
    try {
      const round = await Round.findById(roundId);
      if (!round || round.status !== 'active') {
        clearInterval(intervalId);
        roundTimers.delete(roundId);
        return;
      }

      const endsAt = round.roundEndsAt ? new Date(round.roundEndsAt) : null;
      const timeIsUp = !endsAt || Date.now() >= endsAt.getTime();
      // Team mode: the match is effectively decided the moment every OTHER team has been wiped off
      // the map (their last village captured) - end it right away instead of always running the
      // full timer out. getActiveTeamIds reads the live in-memory session (already ticking every
      // second regardless), not a fresh Mongo fetch, so this costs nothing extra per check.
      const liveState = gameSession.getSession(roundId);
      const oneTeamRemains = round.roomType === 'team' && !!liveState && GameEngine.getActiveTeamIds(liveState).length <= 1;
      // Classic (individual) mode counterpart: end early once only one player - human or bot -
      // still owns any village, i.e. every opponent has been fully eliminated (their last village
      // captured). Guarded by players.length > 1 so a genuine single-player-with-no-bots test round
      // (only ever owns its own starting village) doesn't instantly "end by elimination" at tick 1.
      const onePlayerRemains = round.roomType !== 'team' && !!liveState && (liveState.players || []).length > 1 && GameEngine.getActivePlayerCount(liveState) <= 1;
      if (timeIsUp || oneTeamRemains || onePlayerRemains) {
        clearInterval(intervalId);
        roundTimers.delete(roundId);
        // Tell everyone the round is ending NOW (client shows a big 5s countdown) — the session
        // keeps ticking normally in the background (gameSession.tickAll doesn't know anything
        // changed yet) for these last few seconds, then the actual finish runs below.
        const endReason = timeIsUp ? 'time' : (oneTeamRemains ? 'elimination_team' : 'elimination_solo');
        io.to(roundId).emit('roundEnding', { roundId, countdownSeconds: Math.round(ROUND_ENDING_BUFFER_MS / 1000), reason: endReason });
        setTimeout(async () => {
          try {
            // Same atomic CAS as endRound() (status 'active' -> 'finished') — guards against this
            // timer callback racing an admin's manual "end round" click during the 5s ending buffer.
            // A null match means someone else (endRound) already finished it first; skip payout.
            const now = new Date();
            const freshRound = await Round.findOneAndUpdate(
              { _id: roundId, status: 'active' },
              { status: 'finished', finishedAt: now, roundEndsAt: now },
              { new: true }
            );
            if (!freshRound) return;
            await gameSession.finishSession(roundId);
            await payoutRoundRewards(freshRound);
            const prizeResults = await runRoundFinishHooks(freshRound);
            // Same as endRound(): persist alongside the live broadcast below — a client that only
            // loads/reloads game.html after this point rebuilds its state from this Round document
            // via gameSession.hydrateFromRound, not from the one-time broadcast, so it needs its own
            // copy here too. Without this, VPLN prizes were genuinely paid out (runRoundFinishHooks'
            // side effects always ran) but the round-result screen's "Nagrody VPLN" table never had
            // anything to show, since prizeResults was silently discarded on this path.
            if (prizeResults) await Round.updateOne({ _id: roundId }, { $set: { prizeResults } });
            // gameSession.tickAll() deliberately stops broadcasting once a session is finished, so
            // this is the ONE final game:state push with the frozen points/kills the podium reads
            // from — without it, connected clients never learn the round ended until they refresh.
            const finalState = gameSession.getSession(roundId);
            if (finalState) {
              if (prizeResults) finalState.prizeResults = prizeResults;
              io.to(roundId).emit('game:state', finalState);
            }
            io.to(roundId).emit('roundFinished', { roundId, status: freshRound.status });
            // This path (the normal "round ended by the timer") used to be the one case that never
            // called gameSession.endSession — finishSession only flips roundStatus, it doesn't
            // remove the entry from the in-memory sessions Map. tickAll() already skips finished
            // sessions so this wasn't burning CPU, but every round ever played (not just the active
            // ones) stayed resident in memory for the life of the process. cleanupRoundMemory clears
            // the matching lastSeenReportId/multiAccountScanFlags/roundLiveConnections entries too.
            gameSession.endSession(roundId);
            cleanupRoundMemory(roundId);
          } catch (err) {
            console.error('round finish (after ending buffer) error', err);
          }
        }, ROUND_ENDING_BUFFER_MS);
        return;
      }

      const remainingSeconds = Math.max(0, Math.floor((endsAt.getTime() - Date.now()) / 1000));
      io.to(roundId).emit('roundTimeUpdate', { roundId, remainingSeconds, endsAt: endsAt.toISOString() });
    } catch (error) {
      console.error('round timer error', error);
    }
  }, 1000);

  roundTimers.set(roundId, { intervalId });
}

function cancelRoundTimer(roundId) {
  const rec = roundTimers.get(roundId);
  if (!rec) return;
  clearInterval(rec.intervalId);
  roundTimers.delete(roundId);
}

async function restoreActiveRoundTimers() {
  const activeRounds = await Round.find({ status: 'active' });
  activeRounds.forEach((round) => {
    const roundId = round._id.toString();
    startRoundTimer(roundId);
    // Rehydrates the authoritative in-memory session from the Round's own persisted `state` field
    // so a server restart mid-round never loses villages/players.
    gameSession.ensureSessionForRound(roundId, round);
  });
}

// Leaving a Room's WAITING QUEUE — either voluntarily ("Opuść poczekalnię"), via an admin kick, or
// a socket disconnecting while still queued. Refund is unconditional now (a Room has no other state
// to gate it on — unlike the old dual-purpose function, this only ever touches the queue, never an
// in-progress round).
async function leaveWaitingRoom(roomId, userId) {
  // Atomic $pull instead of findById+splice+save — two players disconnecting from the same room's
  // queue within the same tick used to race on room.save()'s optimistic-concurrency version check
  // (Mongoose VersionError: "No matching document found ... modifiedPaths waitingPlayers"), silently
  // dropping the second removal. findOneAndUpdate can never lose that race.
  let room = await Room.findOneAndUpdate(
    { _id: roomId, 'waitingPlayers.userId': userId },
    { $pull: { waitingPlayers: { userId } } },
    { new: true }
  );
  if (!room) return;
  if (room.roomType === 'percentage') {
    // Strip this departed player's kick-vote(s) against everyone else remaining — a vote cast by
    // someone no longer in the room shouldn't keep counting toward VOTE_KICK_THRESHOLD (see
    // lobby:voteKick). $[] applies the $pull to every waitingPlayers entry's kickVotes at once.
    room = await Room.findOneAndUpdate(
      { _id: roomId },
      { $pull: { 'waitingPlayers.$[].kickVotes': userId } },
      { new: true }
    );
  }
  if (room.isMiniTournament && room.requiresMiniTournamentTicket) {
    // Refund: the ticket was only ever spent on actually PLAYING a round, not on queuing for one.
    await User.updateOne({ _id: userId }, { hasUnusedMiniTournamentTicket: true });
  }
  io.to(roomId).emit('roomUpdated', room);
  io.to(roomId).emit('lobby:update_list', room.waitingPlayers || []);

  if (room.waitingPlayers.length < room.maxPlayers) {
    cancelCountdown(roomId);
  }
}

// "Opuść rozgrywkę" mid-round: a forfeit, not a lobby cancellation — the player's villages/queues
// keep simulating exactly as before (still owned, still attackable, still building/recruiting) and
// they stay visible in the live ranking — just struck through — but they no longer count toward the
// round's TOP1-3/Agresor podium or its end-of-round Skill Points ranking (see the `hasLeft` filters
// in payoutRoundRewards and GameEngine.computeSkillPointsDeltas). They also take an immediate, fixed
// MMR penalty right now, separate from that ranking — but only under the exact same conditions
// payoutRoundRewards would have awarded/deducted Skill Points for finishing this round normally: a
// free round (not tournament/mini-tournament) with at least MIN_PLAYERS_FOR_SKILL_POINTS real
// competitors still in it. Leaving a round that's mostly bots costs nothing, same as winning one
// grants nothing. Returns false if the round/player wasn't found.
async function forfeitRound(roundId, userId) {
  const liveSession = gameSession.getSession(roundId);
  const sessionPlayer = liveSession?.players.find((p) => p.userId === userId.toString());
  if (!liveSession || !sessionPlayer) return false;
  if (sessionPlayer.isBot) return false;

  if (!sessionPlayer.hasLeft) {
    // Counted BEFORE hasLeft flips below, so the leaving player still counts toward their own
    // round's real-competitor total (matching how payoutRoundRewards counts everyone not-yet-left
    // at the single moment it runs).
    const realCompetitorCount = liveSession.players.filter((p) => !p.hasLeft && !p.isBot && p.userId).length;
    sessionPlayer.hasLeft = true;
    await gameSession.persist(roundId);
    // Trial rounds are pure practice — leaving one carries no Skill Points consequence.
    if (!liveSession.isTrial) {
      try {
        const round = await Round.findById(roundId).select('isTournament isMiniTournament').lean();
        const isFreeRound = !round?.isTournament && !round?.isMiniTournament;
        if (isFreeRound && realCompetitorCount >= MIN_PLAYERS_FOR_SKILL_POINTS) {
          await User.updateOne({ _id: userId }, { $inc: { skillPoints: -20 } });
        }
      } catch (e) {
        console.error('forfeitRound penalty error', e);
      }
    }
    // Revoke live access NOW — hasLeft alone doesn't stop queueBuilding/sendAttack/etc. from still
    // working for a socket that stays connected to this round (see kickUserFromRoundLiveGame).
    kickUserFromRoundLiveGame(roundId, userId, 'Opuściłeś tę rozgrywkę.');
  }
  return true;
}

async function startApp() {
  await initDatabase();
  await restoreActiveRoundTimers();
  // Self-healing safety net: startRoundTimer() is idempotent (no-ops if a timer is already armed for
  // that roundId, see roundTimers.has() guard), so it's always safe to re-sweep. Found via the
  // 350-bot Monthly Tournament load test (2026-08-24): under load, an occasional room's timer never
  // got armed after startRoundRoom()/restoreActiveRoundTimers() ran (root cause not pinned down —
  // rare, ~2/35 rooms per round, both freshly-started rounds and restart-recovered ones) leaving that
  // round's status stuck at 'active' forever past its roundEndsAt, with no payout and no tournament
  // advancement for it. This sweep re-arms any orphaned active round within a minute regardless of
  // cause, without needing every possible race to be understood.
  setInterval(() => {
    Round.find({ status: 'active' }).select('_id').lean()
      .then((rounds) => rounds.forEach((r) => startRoundTimer(r._id.toString())))
      .catch((err) => console.error('active-round timer sweep error', err));
  }, 60 * 1000);
  tournamentEngine.init({
    io, User, Room, Round, gameSession, GameEngine,
    currentMonthKey, registerRoundFinishHook, startRoundTimer, startCountdown,
    maybeGrantRegularRoundsMmrReward, getMmrWindowLeaderboard
  });
  startFreeRankingMonthCloseWatcher();
  setInterval(() => { runMatchingTick().catch((err) => console.error('runMatchingTick error', err)); }, MM_TICK_MS);
  // The one authoritative simulation tick: economy, build/recruit queues, combat and bot AI for
  // every active round, computed exactly once here (never inside a browser), then broadcast to
  // every socket in that round so all clients — including the player who didn't cause the change —
  // stay in sync.
  setInterval(() => {
    gameSession.tickAll((roundId, state) => {
      processConquestReports(roundId, state);
      maybeScanRoundForMultiAccounts(roundId, state);
      io.to(roundId).emit('game:state', state);
    });
  }, 1000);
  const PORT = process.env.PORT || 3000;
  // '0.0.0.0' = nasłuchuj na wszystkich interfejsach sieciowych (nie tylko localhost),
  // dzięki czemu serwer jest dostępny zarówno z LAN (Twoje IP np. 192.168.x.x),
  // jak i z zewnątrz po przekierowaniu portu na routerze lub przez tunel (np. ngrok).
  const HOST = process.env.HOST || '0.0.0.0';
  server.listen(PORT, HOST, () => console.log(`Server listening on ${HOST}:${PORT}`));
}

startApp().catch(err => {
  console.error('Fatal error starting app', err);
  process.exit(1);
});
