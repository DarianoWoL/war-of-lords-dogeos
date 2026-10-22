// Monthly Tournament point calculation — turns one room's 10 finished players into Tournament
// Points (TP) for that round, and provides the final tie-break comparator for the overall
// qualification ranking once all 4 rounds are summed.
//
// Data source note: every stat this module reads (`points`, `killsAsAttacker`, `killsAsDefender`,
// `kills`) already exists per-player on a live/finished Round's player state — see
// src/gameSession.js's buildPlayerFromWaitingEntry() for where they're initialized to 0, and
// public/gameEngine.js's creditKills()/refreshAllPlayerPoints() for where they're actually
// maintained during play (creditKills already role-tags kills as attacker-side vs defender-side;
// `kills` is always kept as their sum). Nothing in the live game engine needed to change to
// support this — this module just reads those existing counters once a room's round is over.
'use strict';

// Index 0 = 1st place, ..., index 9 = 10th place. Used identically for all 3 sub-rankings.
const POINT_SCALE = [100, 92, 84, 76, 68, 60, 52, 44, 36, 30];

/**
 * Miejsca w jednej kategorii (malejaco - najwyzsza wartosc = miejsce 1) z miejscami ex aequo:
 * gracze z rownym wynikiem zajmuja to samo miejsce i dostaja tyle samo punktow, a kolejne miejsce
 * jest przesuniete (np. 1, 2, 2, 4). Wczesniej remis rozstrzygal identyfikator konta - kryterium
 * niezwiazane z gra (Regulamin §1a: o wyniku decyduja wylacznie statystyki z rozgrywki).
 * Zwraca Map userId -> miejsce.
 */
function positionsWithTies(players, keyFn) {
  const values = players.map((p) => keyFn(p));
  return new Map(players.map((p, i) => [p.userId, 1 + values.filter((v) => v > values[i]).length]));
}

/**
 * Same 3-category Tournament Points algorithm as computeRoomRoundResults below, generalized to
 * any room size (1+ players) instead of hard-requiring exactly 10 — used by the free-server
 * monthly ranking (src/server.js's payoutRoundRewards), where Pokoje Bitewne rooms can finish
 * with any player count. POINT_SCALE[rank-1] stays in bounds for any rank <= 10 (a room can never
 * produce more than 10 ranks in practice, but this is not itself enforced here); a hypothetical
 * rank beyond POINT_SCALE's length falls back to its last (lowest) value rather than reading
 * undefined into the sum.
 *
 * @param {Array<{userId, username, points, killsAsAttacker, killsAsDefender, kills}>} roomPlayers
 * @returns {Array<{userId, username, positionOverall, positionAggressor,
 *   positionUnitsDestroyed, roundTP}>}
 */
function computeRoomRoundResultsForAnyCount(roomPlayers) {
  if (!Array.isArray(roomPlayers) || roomPlayers.length === 0) return [];

  const scaleFor = (rank) => POINT_SCALE[Math.min(rank, POINT_SCALE.length) - 1];

  const positionOverall = positionsWithTies(roomPlayers, (p) => Number(p.points) || 0);
  const positionAggressor = positionsWithTies(roomPlayers, (p) => Number(p.killsAsAttacker) || 0);
  const positionUnitsDestroyed = positionsWithTies(roomPlayers, (p) => Number(p.kills) || 0);

  return roomPlayers.map((p) => {
    const posOverall = positionOverall.get(p.userId);
    const posAggressor = positionAggressor.get(p.userId);
    const posUnits = positionUnitsDestroyed.get(p.userId);
    const roundTP = scaleFor(posOverall) + scaleFor(posAggressor) + scaleFor(posUnits);
    return {
      userId: p.userId,
      username: p.username,
      positionOverall: posOverall,
      positionAggressor: posAggressor,
      positionUnitsDestroyed: posUnits,
      roundTP
    };
  });
}

/**
 * Computes each of the 3 sub-rankings for one finished room (exactly 10 players) and the
 * resulting per-player Tournament Points for that round.
 *
 * @param {Array<{userId, username, points, killsAsAttacker, killsAsDefender, kills}>} roomPlayers
 *   - exactly 10 entries, one per seat, taken from the finished Round's `state.players` (or the
 *   snapshot copied onto TournamentRoom.results — see tournamentEngine.js).
 * @returns {Array<{userId, username, positionOverall, positionAggressor,
 *   positionUnitsDestroyed, roundTP}>} one entry per input player, unordered (order is not
 *   meaningful — read `positionOverall` etc. for rank).
 */
function computeRoomRoundResults(roomPlayers) {
  if (!Array.isArray(roomPlayers) || roomPlayers.length !== 10) {
    throw new Error(`computeRoomRoundResults: expected exactly 10 players, got ${roomPlayers ? roomPlayers.length : 0}`);
  }

  // 1) Pozycja Ogólna — overall room standing, by village points (the same "points" GameEngine
  //    already keeps live throughout the round via refreshAllPlayerPoints()).
  const positionOverall = positionsWithTies(roomPlayers, (p) => Number(p.points) || 0);
  // 2) Pozycja Agresora — units destroyed while on the attack (killsAsAttacker).
  const positionAggressor = positionsWithTies(roomPlayers, (p) => Number(p.killsAsAttacker) || 0);
  // 3) Pozycja Pokonanych Jednostek — total enemy units destroyed regardless of role (kills =
  //    killsAsAttacker + killsAsDefender, already summed by GameEngine's creditKills()).
  const positionUnitsDestroyed = positionsWithTies(roomPlayers, (p) => Number(p.kills) || 0);

  return roomPlayers.map((p) => {
    const posOverall = positionOverall.get(p.userId);
    const posAggressor = positionAggressor.get(p.userId);
    const posUnits = positionUnitsDestroyed.get(p.userId);
    // POINT_SCALE[rank-1]: rank 1 -> 100pts, ..., rank 10 -> 30pts. Sum of 3 categories:
    // min possible = 30*3 = 90, max possible = 100*3 = 300, matching the spec exactly.
    const roundTP = POINT_SCALE[posOverall - 1] + POINT_SCALE[posAggressor - 1] + POINT_SCALE[posUnits - 1];
    return {
      userId: p.userId,
      username: p.username,
      positionOverall: posOverall,
      positionAggressor: posAggressor,
      positionUnitsDestroyed: posUnits,
      roundTP
    };
  });
}

/**
 * Final qualification-ranking comparator (sort ascending = best first) once all 4 rounds' TP are
 * summed per participant. Deterministic tie-break chain, exactly as specified:
 *   1. Higher Total_TP wins.
 *   2. Still tied -> higher totalUnitsDestroyed (sum of `kills` across all 4 rounds) wins.
 *   3. Still tied -> earlier ticketPurchasedAt wins.
 * Expects participant summary objects: { totalTP, totalUnitsDestroyed, ticketPurchasedAt }.
 */
function compareForFinalRanking(a, b) {
  if (b.totalTP !== a.totalTP) return b.totalTP - a.totalTP;
  if (b.totalUnitsDestroyed !== a.totalUnitsDestroyed) return b.totalUnitsDestroyed - a.totalUnitsDestroyed;
  const aTime = a.ticketPurchasedAt ? new Date(a.ticketPurchasedAt).getTime() : Infinity;
  const bTime = b.ticketPurchasedAt ? new Date(b.ticketPurchasedAt).getTime() : Infinity;
  return aTime - bTime;
}

/**
 * Fully deterministic, skill-based tie-break chain for any real-money or advancement decision that
 * needs to rank players by a single stat (village points, killsAsAttacker, killsAsDefender, ...)
 * within one finished room. Required because a game of skill (this one's whole legal basis — see
 * regulamin.html §1a) cannot have its winner decided by an unexplainable, non-skill criterion like
 * an account id sort order: every level below is a real, explainable performance metric, in order:
 *   1. The requested primary stat (e.g. points, or killsAsAttacker for an "aggressor" pick).
 *   2. Every OTHER combat stat (points/kills/killsAsAttacker/killsAsDefender, skipping the primary),
 *      in that fixed order — a player who also did better across the other three metrics has a
 *      stronger, more explainable claim than one who only matched on the single primary number.
 *   3. Earlier pointsAchievedAt (whoever reached their final village-points total first) — a
 *      genuine speed/skill criterion, and in practice unique to the millisecond, so real ties never
 *      actually reach the next level.
 *   4. Account id string compare — kept only as a mathematical safety net so the comparator always
 *      returns a total order (never an unresolved 0), but with level 3 in place this is never
 *      expected to actually be reached by two real players.
 * `primaryKey` must be one of 'points' | 'kills' | 'killsAsAttacker' | 'killsAsDefender'.
 */
function compareByStatCascade(primaryKey) {
  const ALL_STATS = ['points', 'kills', 'killsAsAttacker', 'killsAsDefender'];
  const fallbackStats = ALL_STATS.filter((k) => k !== primaryKey);
  return function (a, b) {
    const primaryDiff = (Number(b[primaryKey]) || 0) - (Number(a[primaryKey]) || 0);
    if (primaryDiff !== 0) return primaryDiff;
    for (const key of fallbackStats) {
      const diff = (Number(b[key]) || 0) - (Number(a[key]) || 0);
      if (diff !== 0) return diff;
    }
    const aTime = a.pointsAchievedAt ? new Date(a.pointsAchievedAt).getTime() : Infinity;
    const bTime = b.pointsAchievedAt ? new Date(b.pointsAchievedAt).getTime() : Infinity;
    if (aTime !== bTime) return aTime - bTime;
    return String(a.userId).localeCompare(String(b.userId));
  };
}

module.exports = { POINT_SCALE, computeRoomRoundResults, computeRoomRoundResultsForAnyCount, compareForFinalRanking, compareByStatCascade };
