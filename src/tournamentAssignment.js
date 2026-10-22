// Pure room-assignment logic for the Monthly Tournament — split out of tournamentEngine.js so it's
// trivially unit-testable and has zero dependency on Mongo/Socket.IO. See tournamentEngine.js's
// startRound() for the only caller.
'use strict';

const PLAYERS_PER_ROOM = 10;
// 35 rooms x 10 players — matches Tournament.js's own schema default and
// QUALIFICATION_SEMIFINAL_SLOTS (35) in tournamentEngine.js.
const DEFAULT_MAX_PARTICIPANTS = 350;

/**
 * Splits `players` (registration-order array of {userId, username}) into R = players.length / 10
 * rooms of exactly 10 players each, for the given roundNumber (1-4).
 *
 * Bez zadnego losowania (takze pseudolosowego) - jawny wzor, ktory kazdy uczestnik moze sprawdzic
 * (Regulamin §1a, Zasady Turnieju). Gracz o numerze i w kolejnosci zapisow (0, 1, 2...):
 *   q = floor(i / 10), s = i mod 10,  pokoj w rundzie k = (q + (k - 1) * s) mod R.
 * Runda 1 to kolejne dziesiatki wg kolejnosci zapisow; w rundach 2-4 gracze z tej samej dziesiatki
 * rozchodza sie do roznych pokoi. Dla kazdego s numer q przebiega wszystkie pokoje dokladnie raz,
 * wiec kazdy pokoj ma zawsze dokladnie 10 graczy.
 */
function roomIndexFor(index, roundNumber, roomCount) {
  const q = Math.floor(index / PLAYERS_PER_ROOM);
  const s = index % PLAYERS_PER_ROOM;
  return (q + (roundNumber - 1) * s) % roomCount;
}

function assignPlayersToRooms(players, roundNumber) {
  if (!Array.isArray(players) || players.length === 0 || players.length % PLAYERS_PER_ROOM !== 0) {
    throw new Error(`assignPlayersToRooms: players.length must be a positive multiple of ${PLAYERS_PER_ROOM} (got ${players.length})`);
  }
  if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > 4) {
    throw new Error(`assignPlayersToRooms: roundNumber must be 1-4 (got ${roundNumber})`);
  }
  const roomCount = players.length / PLAYERS_PER_ROOM;
  const rooms = Array.from({ length: roomCount }, () => []);
  players.forEach((player, index) => rooms[roomIndexFor(index, roundNumber, roomCount)].push(player));
  return rooms;
}

module.exports = { assignPlayersToRooms, roomIndexFor, PLAYERS_PER_ROOM, DEFAULT_MAX_PARTICIPANTS };
