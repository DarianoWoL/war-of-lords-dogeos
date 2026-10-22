const mongoose = require('mongoose');

// Single-document collection holding global site toggles the admin can flip at runtime
// (e.g. temporarily disabling the shop) without touching code or restarting the server.
const SettingsSchema = new mongoose.Schema({
  singleton: { type: String, default: 'main', unique: true },
  shopEnabled: { type: Boolean, default: true },
  // Kill-switch for creating NEW 'team' rooms (existing team rounds already in progress are
  // unaffected) — lets the admin temporarily hide/disable team mode site-wide without touching code.
  teamModeEnabled: { type: Boolean, default: true },
  // Global monthly pool for the shop's "Bilety turniejowe" tile (see POST
  // /api/market/buy-tournament-tickets in server.js) — capped at TOURNAMENT_TICKETS_MONTHLY_POOL
  // total tickets sold across ALL players combined, not per-player. `ticketsMonthKey` ("YYYY-MM")
  // is compared against the current month on each purchase attempt; a mismatch means nobody has
  // bought a ticket yet this month, so the counter lazily resets to 0 right there instead of
  // needing a cron job.
  tournamentTicketsSoldThisMonth: { type: Number, default: 0 },
  tournamentTicketsMonthKey: { type: String, default: null },
  // Set the moment the top-5 "regular-rounds MMR gained this month" direct semifinal pass has been
  // granted for a given month (see maybeGrantRegularRoundsMmrReward in server.js) — an atomic
  // claim so two simultaneous ticket purchases that both exhaust the pool at once can't both
  // trigger it twice.
  mmrRewardGrantedMonthKey: { type: String, default: null },
  // Same atomic-claim idempotency guard as mmrRewardGrantedMonthKey above, but for the separate
  // flat-VPLN consolation prize paid to that month's Free-Server-Ranking Top 5 (see
  // grantFreeRankingConsolationPrize in server.js) — a distinct field because the two rewards are
  // granted independently and must never block each other.
  freeRankingConsolationGrantedMonthKey: { type: String, default: null },
  // Gross price in PLN for a single Mini-Tournament ticket (see POST /api/payments/mini-tickets/create
  // in server.js) — admin-configurable, unlike the Monthly Tournament ticket price this has no
  // per-edition override, just one site-wide value at a time.
  miniTournamentTicketPricePLN: { type: Number, default: 10 },
  // Admin-configurable GLOBAL monthly cap on Mini-Tournament ticket PURCHASES (not usage — a ticket
  // can be joined-to-a-room/refunded/joined-again indefinitely with no date tracked on that side at
  // all, only the initial purchase counts against this pool). Same lazy-reset-on-month-change shape
  // as tournamentTicketsSoldThisMonth/tournamentTicketsMonthKey above.
  miniTournamentTicketsMonthlyPool: { type: Number, default: 1000 },
  miniTournamentTicketsSoldThisMonth: { type: Number, default: 0 },
  miniTournamentTicketsMonthKey: { type: String, default: null },
  // Admin-configurable floor for a single VPLN->PLN withdrawal request (see POST
  // /api/withdrawals/request in server.js) — keeps individual bank transfers worth the manual admin
  // effort of executing them. Default set by the Usługodawca at 100 zł.
  // Minimalna kwota wyplaty - w DOGE (nazwa pola z czasow VPLN).
  minWithdrawalVpln: { type: Number, default: 100 },
  // Nagrody stale w DOGE (wczesniej 10 VPLN na sztywno w kodzie); null = wartosc domyslna z server.js.
  freeRankingConsolationDoge: { type: Number, default: null },
  // Domyslna cena Biletu Turniejowego w DOGE (gdy turniej nie ma wlasnej ceny).
  tournamentTicketPriceDoge: { type: Number, default: null },
  referralRewardDoge: { type: Number, default: null },
  // Jednorazowe przeliczenie VPLN -> DOGE (scripts/migrate-vpln-to-doge.js): kurs i data.
  vplnToDogeRate: { type: Number, default: null },
  vplnToDogeMigratedAt: { type: Date, default: null },
  // Safety-net hard cap on total REAL PLN collected via HotPay in a calendar month (see
  // remainingHotpayRevenueLimit in server.js) — independent of the ticket price/pool settings, so a
  // misconfigured price or pool still can't let through more real-money revenue than the admin
  // intends. 0/null disables the cap entirely (no limit). VPLN-settled ticket purchases never count
  // toward this — it's real-money-in only.
  hotpayMonthlyRevenueLimitPLN: { type: Number, default: 0 },
  hotpayRevenueThisMonthPLN: { type: Number, default: 0 },
  hotpayRevenueMonthKey: { type: String, default: null },
  // Shows/hides the "Pobierz aplikację" button on index.html (see GET /api/settings/app-download)
  // — the APK itself (public/mobile-app/waroflords.apk) is always on disk either way, this just
  // controls whether the site advertises it. Off by default: a brand-new trial APK shouldn't be
  // offered to visitors until the admin has actually checked it works.
  appDownloadEnabled: { type: Boolean, default: false }
});

const Settings = mongoose.model('Settings', SettingsSchema);

async function getSettings() {
  let settings = await Settings.findOne({ singleton: 'main' });
  if (!settings) {
    settings = await Settings.create({ singleton: 'main' });
  }
  return settings;
}

module.exports = { Settings, getSettings };
