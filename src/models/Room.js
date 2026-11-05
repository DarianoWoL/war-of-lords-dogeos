const mongoose = require('mongoose');

// A Room is now purely a permanent matchmaking template — settings + whoever is currently waiting
// for the next round to start. It is never deleted or reset when a round starts/ends; joining a
// Room means joining its `waitingPlayers` queue (see performRoomJoin in src/server.js), and once
// that queue crosses the threshold, the server snapshots it into a brand-new Round document (see
// src/models/Round.js) and immediately empties `waitingPlayers` back to zero — the Room is always
// ready to start collecting the NEXT, fully independent round. Many Rounds spawned from the same
// Room run in parallel; nothing about an in-progress or finished Round is ever reflected here.
const RoomSchema = new mongoose.Schema({
    roomName: { type: String, required: true, unique: true },
    // Pure list-visibility toggle (public "Pokoje Bitewne" + admin "Aktywne pokoje") — has nothing
    // to do with whether a round is currently running, unlike the old overloaded `status` field.
    enabled: { type: Boolean, default: true },
    // Actually blocks new joins/round-starts (see performRoomJoin) — previously existed but was
    // never enforced anywhere.
    isPaused: { type: Boolean, default: false },
    // Rounds are free to join — entry fee and WoLcoin round-end rewards were removed entirely, so
    // this always stays 0 (see performRoomJoin / payoutRoundRewards in server.js).
    entryFee: { type: Number, default: 0 },
    maxPlayers: { type: Number, default: 10 },
    // 'standard': round auto-starts once the queue is full.
    // 'percentage': round starts via the ready-check flow (every real player marks themselves
    // ready, min. 5 players queued).
    // 'team': team mode on the 50-main-village map (no sub villages) — players pick a team
    // (waitingPlayers[].teamId) in the lobby, round starts via ready-check with a lower/flexible
    // threshold (min. 2 teams present, see maybeStartReadyRoom) or admin force-start any time.
    roomType: { type: String, enum: ['standard', 'percentage', 'team'], default: 'standard' },
    // Tournament rounds — created only from the dedicated admin subpage (admin-turnieje.html),
    // always roomType 'standard' (see POST /api/rooms). Hidden from the regular "Pokoje Bitewne"
    // listing/admin room-management views; shown only in the public "Turnieje" tab and the admin
    // "Rundy Turniejowe" subpage (see the `tournament` query-param filtering in server.js).
    isTournament: { type: Boolean, default: false },
    // Only meaningful when isTournament is true. 'qualification' rooms are the ones admins create
    // freely from admin-turnieje.html and players join by spending a tournament ticket (see
    // performRoomJoin in server.js). 'semifinal' marks the 4 permanent rooms, and 'final' the 1
    // permanent room, auto-provisioned by ensureSemifinalRooms()/ensureFinalRoom() at server
    // startup — both start paused, unpaused manually by an admin (semifinal once qualification
    // rounds are over; final once the 10 finalists have been determined); joining either never
    // costs a ticket.
    tournamentStage: { type: String, enum: ['qualification', 'semifinal', 'final'], default: 'qualification' },
    // Mini-Tournaments: ordinary standard rooms (created the normal way via POST /api/rooms) with
    // VPLN prizes bolted on — deliberately NOT built on the Monthly Tournament machinery (no
    // TournamentRoom/Tournament doc, no bracket stages), just this Room's own settings + the
    // mini-tournament round-finish hook in server.js. See public/mini-tournaments.html.
    isMiniTournament: { type: Boolean, default: false },
    miniTournamentPrizes: {
      place1VPLN: { type: Number, default: 0 },
      place2VPLN: { type: Number, default: 0 },
      place3VPLN: { type: Number, default: 0 }
    },
    // When true, joining this room's queue requires (and consumes) one
    // User.hasUnusedMiniTournamentTicket — see performRoomJoin / leaveWaitingRoom in server.js.
    requiresMiniTournamentTicket: { type: Boolean, default: false },
    // Mini-Turniej only: when true, a waiting player can fill the empty seats with server bots (they never get prizes).
    allowBots: { type: Boolean, default: false },
    // Only meaningful for roomType 'team' — admin-chosen at room creation, 2-10 teams. Determines
    // both the valid teamId range for lobby:setTeam/lobby:addBotToTeam and maxPlayers
    // (teamCount * 5) — the underlying map always has 10 fixed regions of 5 villages, but a room
    // only ever uses the first `teamCount` of them; the rest stay neutral/unclaimed that round.
    teamCount: { type: Number, min: 2, max: 10, default: 2 },
    // Only meaningful for 'standard'/'percentage' rooms (bots are never allowed in 'team' rooms at
    // all, see the lobby:addBot/addBotToTeam guards in server.js). Normally only an admin can add
    // bots to a room's waiting queue — this opt-in per-room flag lets ANY player in the lobby do it
    // too, for practice/test rooms where the admin wants players to be able to pad out a match
    // themselves without needing an admin present.
    playersCanAddBots: { type: Boolean, default: false },
    settings: {
      dlugoscRundySekundy: { type: Number, default: 3600 },
      modyfikatorCzasuEkonomii: { type: Number, default: 0 },
      modyfikatorCzasuWojska: { type: Number, default: 0 },
      // Kept for backward compatibility with old Round snapshots — no longer read anywhere since
      // WoLcoin round-end rewards were removed (see payoutRoundRewards in server.js).
      nagrodaTop1: { type: Number, default: 0 },
      nagrodaTop2: { type: Number, default: 0 },
      nagrodaTop3: { type: Number, default: 0 },
      nagrodaAgresor: { type: Number, default: 0 }
    },
    waitingPlayers: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        username: String,
        isBot: { type: Boolean, default: false },
        color: { type: String, default: null },
        // Only meaningful in 'percentage'/'team' rooms — see roomType above. Bots are always
        // treated as ready (they can't click the button) so they never block the all-ready check.
        ready: { type: Boolean, default: false },
        // Only meaningful in 'team' rooms — which of the room's teamCount team slots (1-teamCount)
        // this player picked in the lobby; null until chosen. Maps directly to
        // GameEngine.TEAM_REGIONS[teamId] (which main villages that team lands on) and to
        // PLAYER_COLORS[teamId - 1] (shared team color).
        teamId: { type: Number, default: null },
        joinedAt: { type: Date, default: Date.now },
        // Only meaningful in 'percentage' rooms - userIds of other real players in this same queue
        // who have voted to remove this player from the lobby (see lobby:voteKick in server.js),
        // e.g. someone AFK who never clicks "Gotowy" and blocks the whole ready-check indefinitely.
        // Reaching VOTE_KICK_THRESHOLD distinct votes actually removes them. Reset implicitly: a
        // kicked/left player who rejoins gets a brand-new waitingPlayers entry with an empty array.
        kickVotes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
    }],
    // Entry fees collected from the CURRENT waiting queue only — moves onto the new Round document
    // (and resets to 0 here) the moment that queue's round actually starts.
    poolPP: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Room', RoomSchema);
