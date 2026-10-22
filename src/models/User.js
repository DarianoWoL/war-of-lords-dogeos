const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  // Optional on documents created before this field existed (sparse index) — required going
  // forward for every new registration (see POST /api/auth/register in server.js).
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  // Bought directly with real money (10 zł brutto/ticket — see POST /api/market/buy-tournament-tickets
  // in server.js). WoLcoin (the old virtual-currency middleman) has been retired from the game entirely.
  tournamentTickets: { type: Number, default: 0 },
  // Virtual PLN balance shown on the player profile — separate from the retired WoLcoin system
  // above. Also the automatic payout target for Monthly Tournament Final prizes (see
  // tournamentEngine.payoutFinalPrizes / TournamentResults.js).
  // Dawne saldo w VPLN (1 VPLN = 1 zl) - po przeliczeniu (scripts/migrate-vpln-to-doge.js) zawsze 0.
  vplnBalance: { type: Number, default: 0 },
  // Wirtualne saldo gracza w DOGE: nagrody, zakupy w sklepie, wplaty i wyplaty (DogeTransaction).
  dogeBalance: { type: Number, default: 0 },
  // Prywatny adres DOGE gracza do wyplat (zapamietany z ostatniej wyplaty).
  dogeAddress: { type: String, default: null, trim: true },
  // Adres portfela EVM (DogeOS testnet) powiazany podpisem wiadomosci - patrz src/chain. Unikalny: jeden portfel = jedno konto.
  walletAddress: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
  // Konto zalozone przez portfel dostaje tymczasowa nazwe Lord_xxxxxx - gracz wybiera wlasna przy pierwszym wejsciu.
  needsUsername: { type: Boolean, default: false },
  // Monthly ranking (left panel in Turnieje) — sum of Skill Points CHANGES from REGULAR
  // (non-tournament, i.e. Pokoje Bitewne) rounds only this calendar month — tournament rounds
  // never touch this (see payoutRoundRewards in server.js). TOP 5 get a direct semifinal pass
  // (see semifinalDirectPass below and maybeGrantRegularRoundsMmrReward in server.js): good
  // regular-room players skip the qualification grind entirely instead of needing tickets/rounds.
  regularRoundsMmrPoints: { type: Number, default: 0 },
  regularRoundsMmrPointsMonthKey: { type: String, default: null },
  // Set when this account won a TOP-5 regularRoundsMmrPoints reward this month — a direct
  // semifinal berth, independent of (and bypassing) the qualificationPoints/TOP-35 ranking below.
  semifinalDirectPass: { type: Boolean, default: false },
  semifinalDirectPassMonthKey: { type: String, default: null },
  // One tournament ticket now covers 4 qualification round entries, not 1 — this cycles 0-3 and
  // consumes a whole `tournamentTickets` only every 4th round start (see startCountdown in
  // server.js). Not tied to a specific ticket purchase batch, just a rolling usage counter across
  // however many tickets the player has; a partially-used ticket carries over indefinitely (no
  // monthly reset, unlike the ranking fields below).
  qualificationRoundUses: { type: Number, default: 0 },
  // Cumulative in-game "punkty wioski" earned across this window's qualification rounds (summed
  // in payoutRoundRewards for isTournament rounds) — what the qualification leaderboard/TOP 35
  // ranks by. Resets monthly alongside the ticket pool (see currentMonthKey in server.js).
  qualificationPoints: { type: Number, default: 0 },
  qualificationPointsMonthKey: { type: String, default: null },
  skillPoints: { type: Number, default: 1200 },
  // Mini-Tournament-only MMR (blind matchmaking) — fed EXCLUSIVELY by Mini-Tournament round
  // results (payoutRoundRewards in server.js), never by free/qualification rounds. Start 1000.
  tournamentMMR: { type: Number, default: 1000 },
  roundsPlayed: { type: Number, default: 0 },
  roundsWon: { type: Number, default: 0 },
  isAdmin: { type: Boolean, default: false },
  isBlocked: { type: Boolean, default: false },
  // Human-readable reason shown to the player on the blocked-account screen (see blockUserAccount /
  // GET /api/me/block-status in server.js) — set whenever isBlocked flips to true, cleared on unblock.
  blockReason: { type: String, default: null },
  isBot: { type: Boolean, default: false },
  // Marks the single reserved "house" account that receives VPLN debited from players paying for
  // tickets with their VPLN balance instead of real money (see getOrCreateVplnBankAccount in
  // server.js) — keeps that VPLN visibly "in the system" (auditable via Panel Graczy) rather than
  // just vanishing on debit. Never logs in for real, never plays, excluded from the public ranking
  // (see GET /api/ranking) but deliberately left isBot:false so it never gets swept up by bot-
  // management tooling that only checks isBot.
  isSystemAccount: { type: Boolean, default: false },
  // Gates access to index.html (see checkRulesAccepted in server.js / the rules overlay in
  // index.html) until the player explicitly ticks the box and confirms — set once, never reset.
  hasAcceptedRules: { type: Boolean, default: false },
  // Drives the "co nowego" announcements popup on index.html (see GET /api/news/unread, POST
  // /api/news/mark-read) — any NewsItem created after this timestamp is still unread. null means
  // "never dismissed anything", so every existing announcement counts as unread.
  lastNewsReadAt: { type: Date, default: null },
  // Set at registration when the required Regulamin/Polityka Prywatności checkbox (see
  // public/login.html #registerForm) was ticked — POST /api/auth/register rejects the request
  // outright if this consent isn't present, so on any successful account these are always set.
  termsAcceptedAt: { type: Date, default: null },
  privacyAcceptedAt: { type: Date, default: null },
  // Optional newsletter/marketing opt-in checkbox, unchecked by default — can be flipped later
  // from the profile page, unlike the required terms/privacy consent above.
  marketingOptIn: { type: Boolean, default: false },
  marketingOptInAt: { type: Date, default: null },
  // Every account gets exactly one free practice round against bots (see POST /api/trial/start) —
  // flips to true the moment it's used and never resets, so it can't be repeated.
  freeTrialUsed: { type: Boolean, default: false },
  // This account's own invite code — generated lazily on first use (see getOrCreateReferralCode in
  // server.js) rather than at registration, so accounts created before the referral feature existed
  // still get one on demand. `referredBy` is set once, at registration, from a `?ref=` code on the
  // registration form (see POST /api/auth/register) — never changed afterward.
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Max ONE unused Mini-Tournament ticket per account at a time (see POST /api/rooms/:id/join) —
  // consumed on joining a ticket-gated mini-tournament room's queue, refunded if they leave before
  // the round actually starts (see leaveWaitingRoom in server.js).
  hasUnusedMiniTournamentTicket: { type: Boolean, default: false },
  // Set once, permanently, the first time this account's Mini-Tournament ticket purchase is
  // confirmed paid — this is what a referrer's invited-player count actually counts (see
  // maybeGrantReferralReward in server.js), independent of hasUnusedMiniTournamentTicket above
  // (which toggles back and forth as tickets get bought/used/refunded).
  hasBoughtMiniTournamentTicket: { type: Boolean, default: false },
  // Same idea, for a Monthly Tournament ticket purchase — set once, permanently, the first time
  // this account's Monthly Tournament TicketOrder is confirmed paid. Referral milestone counting
  // (see maybeGrantReferralReward) treats either ticket type as qualifying, so a referred player
  // only ever needs to buy ONE ticket, of either kind, to count toward their referrer's reward.
  hasBoughtTournamentTicket: { type: Boolean, default: false },
  // Set the first time this account is confirmed (via a game:join hard-block, see server.js) to
  // share a device with another account — kept permanently afterward as evidence, even if the
  // player later switches machines, so admins can still see which accounts were ever linked.
  hardwareId: { type: String, default: null, index: true },
  // Rolling log of real connection attempts, newest first, capped (see pushLoginHistory in
  // server.js) — used to answer "did this account ever share an IP with account X in the last 7
  // days" for the game:join network-history multi-account check.
  loginHistory: [{
    ip: String,
    deviceId: String,
    at: { type: Date, default: Date.now }
  }],
  // Brute-force login lockout (see attemptLogin in server.js) — failedLoginAttempts counts
  // CONSECUTIVE wrong-password attempts since the last successful login (reset to 0 on success).
  // Every 3rd consecutive failure escalates loginLockoutTier by one and sets loginLockedUntil,
  // with an increasing cooldown per tier (30s / 30min / 24h, capped at the 24h tier for any further
  // escalation) — visible to admins in the Panel Graczy.
  failedLoginAttempts: { type: Number, default: 0 },
  loginLockoutTier: { type: Number, default: 0 },
  loginLockedUntil: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);
