const mongoose = require('mongoose');

// One document per calendar month's Monthly Tournament. Drives the whole qualification schedule
// as a state machine — see src/tournamentEngine.js for the transition logic and timers. Everything
// about a given month's tournament (who's registered, when each round starts, who ends up in the
// semifinals) lives here or on the TournamentRoom documents it owns (see TournamentRoom.js).
const TournamentSchema = new mongoose.Schema({
  // "YYYY-MM" — one tournament per month, enforced via the unique index below.
  monthKey: { type: String, required: true, unique: true },

  // SCHEDULED: accepting ticket registrations. Two independent things both have to happen before
  //   Round 1 actually starts — the pool selling out (or scheduledStartAt arriving, if it's already
  //   set) closes REGISTRATION, and scheduledStartAt being set at all is what actually triggers a
  //   start. Deliberately decoupled: an admin can open ticket sales with just a pool size and no
  //   date yet, let it sell out, and only THEN decide/announce the actual start date — see
  //   tournamentEngine.scheduleTournament / tryStartRound1.
  // ROUND_1 / ROUND_2 / ROUND_3 / ROUND_4: that round's rooms are live.
  // BREAK_1: the 30-minute gap between Round 1 and Round 2 (same day).
  // PAUSE_DAY: the overnight gap between Round 2 (day 1) and Round 3 (day 2).
  // BREAK_2: the 30-minute gap between Round 3 and Round 4 (day 2).
  // CALCULATION_BREAK: the 2-hour gap between Round 4 finishing and results being announced.
  // COMPLETED: results announced, semifinalists computed and written back to User records.
  status: {
    type: String,
    enum: ['SCHEDULED', 'ROUND_1', 'BREAK_1', 'ROUND_2', 'PAUSE_DAY', 'ROUND_3', 'BREAK_2', 'ROUND_4', 'CALCULATION_BREAK', 'COMPLETED'],
    default: 'SCHEDULED',
    index: true
  },

  // Total ticket pool for this month — admin-configurable (see POST /api/admin/tournament/schedule),
  // must always be a multiple of 10 since qualification rooms are always exactly 10 players; room
  // count per round is derived as maxParticipants/10, never a fixed 35 (see tournamentAssignment.js).
  maxParticipants: { type: Number, required: true, default: 350 },
  // Day 1 / Round 1 start time "T" — admin-configured, SEPARATELY from maxParticipants above (see
  // POST /api/admin/tournament/schedule) — deliberately optional/nullable: a tournament can exist
  // and sell tickets with this still unset, e.g. while waiting for the pool to sell out before
  // committing to a date.
  scheduledStartAt: { type: Date, default: null },
  // Day 2 / Round 3 start time — defaults to scheduledStartAt + 24h if not set explicitly by the
  // admin at the same time scheduledStartAt is set.
  day2StartAt: { type: Date, default: null },

  // Announced (not actual/triggering) dates for the semifinal/final stages, shown on the player-
  // facing tournament tile before either stage exists as a room — purely informational, admin-set
  // whenever ready; the semifinal/final rooms themselves are still started manually by an admin
  // (see seedBracketRoom in tournamentEngine.js), these fields don't trigger anything.
  semifinalScheduledAt: { type: Date, default: null },
  finalScheduledAt: { type: Date, default: null },

  // Actual (not scheduled) timestamps, filled in as the state machine progresses — used both for
  // admin visibility and to let the server correctly resume timers after a restart (compare "now"
  // against these instead of trusting an in-memory timer that no longer exists after a reboot).
  round1StartedAt: { type: Date, default: null },
  round1EndedAt: { type: Date, default: null },
  round2StartedAt: { type: Date, default: null },
  round2EndedAt: { type: Date, default: null },
  round3StartedAt: { type: Date, default: null },
  round3EndedAt: { type: Date, default: null },
  round4StartedAt: { type: Date, default: null },
  round4EndedAt: { type: Date, default: null },
  resultsAnnouncedAt: { type: Date, default: null },

  // How long each qualification round itself runs for, in minutes — used both to set each Round's
  // duration and to compute when a round "should" have ended if the server was down.
  roundDurationMinutes: { type: Number, default: 60 },

  // Admin-configurable break lengths, in minutes — replace the old hardcoded BREAK_MS/
  // CALCULATION_BREAK_MS constants in tournamentEngine.js. breakBetweenQualRoundsMinutes covers
  // BOTH BREAK_1 (Round1->Round2) and BREAK_2 (Round3->Round4) — one shared value, same as the
  // single constant it replaces.
  breakBetweenQualRoundsMinutes: { type: Number, default: 30 },
  calculationBreakMinutes: { type: Number, default: 120 },

  // Fully-automatic bracket-stage start delays, in minutes, counted from the moment the PREVIOUS
  // stage actually completed (resultsAnnouncedAt for semifinal, semifinalCompletedAt for final) —
  // NOT an arbitrary far-future date, deliberately, so the raw setTimeout in tournamentEngine.js's
  // scheduleAt() can never overflow (Node silently fires setTimeout almost immediately past
  // ~24.8 days) — see scheduleTournament's validation for the enforced cap.
  delayToSemifinalMinutes: { type: Number, default: 0 },
  delayToFinalMinutes: { type: Number, default: 0 },
  // When all 4 semifinal TournamentRooms finished — the anchor for delayToFinalMinutes, and what
  // resumeInFlightTournaments() re-arms the final auto-start timer against after a server restart.
  semifinalCompletedAt: { type: Date, default: null },

  // Player-facing display name for this edition — optional, admin-set. Falls back to monthKey
  // ("YYYY-MM") in the UI if unset.
  title: { type: String, default: null },

  // Gross ticket price in PLN for THIS edition only (see getTicketPricePLN in server.js, which
  // falls back to a fixed default when unset) — kept here, not on Settings.js, so each edition's
  // price is part of the same guaranteed, pre-set record as prizesConfig below.
  ticketPricePLN: { type: Number, default: null },

  // The guaranteed, pre-set VPLN prize breakdown for this edition's Final (10 finalists) — must be
  // configured before it's shown to players and, once the first ticket is sold (see the guard in
  // tournamentEngine.scheduleTournament), can never change again: players must be able to trust the
  // numbers they saw before buying. place4to10VPLN is a single flat placement prize applied to every
  // finalist placing 4th through 10th (a fixed skill-competition prize amount, not a ticket refund).
  prizesConfig: {
    place1VPLN: { type: Number, default: 0 },
    place2VPLN: { type: Number, default: 0 },
    place3VPLN: { type: Number, default: 0 },
    place4to10VPLN: { type: Number, default: 0 },
    // Set the first time an admin saves real prize numbers — distinguishes "genuinely zero prizes"
    // from "never configured yet" (see payoutFinalPrizes in tournamentEngine.js, which skips payout
    // entirely while this is null).
    configuredAt: { type: Date, default: null }
  },

  // Registered participants — filled by tournamentEngine.registerParticipant() every time a ticket
  // purchase finalizes while this Tournament is still SCHEDULED (see the hook in
  // finalizeTicketOrder, src/server.js). Ordering of this array (push order = ticket purchase
  // order) IS the deterministic source list handed to assignPlayersToRooms() — never re-sorted
  // in place, so re-running assignment for the same round always reproduces the same rooms.
  participants: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    ticketPurchasedAt: { type: Date, required: true },
    // Running Total_TP across whichever rounds have finished so far (0-1200) — updated by
    // tournamentEngine.onRoomFinished() as each of the 35 rooms in a round completes.
    totalTP: { type: Number, default: 0 },
    // Sum of `kills` (killsAsAttacker + killsAsDefender) across all rounds this player has played
    // — the tie-breaker #1 field (see tournamentScoring.compareForFinalRanking).
    totalUnitsDestroyed: { type: Number, default: 0 }
  }],
  // Locked the moment registration closes (pool full or scheduledStartAt reached) — participants
  // added after this point (shouldn't normally happen, purchases are gated elsewhere too) are
  // simply not part of any round assignment.
  registrationClosedAt: { type: Date, default: null },
  // Manual admin kill-switch for NEW ticket purchases — completely independent of maxParticipants
  // (which can never go to 0, see the multiple-of-10 room-bracket validation in scheduleTournament)
  // and of registrationClosedAt above (which is automatic, tied to the pool selling out or the
  // start date arriving). This is the "pause sales without touching pool size, dates, or prizes"
  // lever — see PUT /api/admin/tournament/sales-pause in server.js.
  salesPausedByAdmin: { type: Boolean, default: false },

  // Final 40 semifinalists, written once at COMPLETED — 35 from this tournament's own qualification
  // ranking + 5 from the Free Server Ranking (see FreeServerRanking.js / User.semifinalDirectPass,
  // an entirely separate, already-existing mechanism this just also snapshots here for one
  // combined audit record).
  semifinalists: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    source: { type: String, enum: ['qualification', 'freeServerRanking'], required: true },
    rank: { type: Number, required: true } // 1-35 within source 'qualification', 1-5 within 'freeServerRanking'
  }]
}, { timestamps: true });

module.exports = mongoose.model('Tournament', TournamentSchema);
