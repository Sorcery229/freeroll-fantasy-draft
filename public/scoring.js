// public/scoring.js
//
// Pure fantasy scoring. Mirrors lib/fantasy/scoring.ts from the dashboard
// branch, but reads the socket payload shape that openbarleague.com actually
// emits (server.mts:973-997), where a player looks like:
//
//   { id, name, nickname, uid, is_active, elimination_position,
//     placement, hitman_name, photo_url, ... }
//
// Note `hitman_name` and NOT `hitman_uid`: the socket payload only exposes the
// knocker-out's name, so knockouts are attributed by name match rather than by
// uid. Names inside one tournament are unique (the DB has a
// unique_player_per_tournament constraint), so this is safe within a contest.

export const SCORING = {
  // "places"  -> points = players finished ahead of + 1. Winner of a 36-player
  //              game scores 36, the first player out scores 1. Intuitive, and
  //              a bigger field is worth more, which matches the difficulty.
  //              Downside: it is linear, so 2nd (35) is barely behind 1st (36).
  // "curve"   -> top-heavy: maxFinishPoints * (fraction of field beaten)^gamma,
  //              which separates deep runs but needs explaining.
  mode: "curve",
  gamma: 3,
  maxFinishPoints: 100,
  // Knockouts award no points: the league only wants to see who knocked out
  // whom, not to pay for it.
  knockoutPoints: 0,
  picksRequired: 5,
};

/**
 * SEASON points, awarded by an entrant's FINISHING RANK in a single game — not
 * by their raw score. 1st in a game earns 10, 2nd 7, 3rd 6, down to 1 point for
 * 8th; 9th and below earn nothing.
 *
 * This is what makes the two tiers work together: within a game, scoring can be
 * as top-heavy as it likes (see SCORING.mode) because only the resulting
 * ORDER matters here. Every game is therefore worth exactly the same to the
 * season — a 12-player Tuesday cannot outweigh a 37-player Saturday — and a
 * month of games is simply the sum of these.
 */
export const SEASON_POINTS = [10, 7, 6, 5, 4, 3, 2, 1];

/** Season points for finishing `rank` (1-based) in one game. */
export function seasonPointsForRank(rank) {
  const r = Number(rank);
  if (!Number.isFinite(r) || r < 1) return 0;
  return SEASON_POINTS[r - 1] ?? 0;
}

const norm = (s) => String(s ?? "").trim().toLowerCase();

/** Still in the tournament? The socket sets is_active = (ko_position === null). */
export function isAlive(p) {
  if (typeof p.is_active === "boolean") return p.is_active;
  return p.elimination_position == null && p.placement == null;
}

/**
 * points = maxFinishPoints * ((N - place) / (N - 1)) ^ gamma
 *
 * The base is the fraction of the field beaten, so the curve is field-size
 * neutral: the same percentile scores the same in a 9-player game and a
 * 27-player one. gamma > 1 makes it convex, so 2nd is worth clearly less than
 * 1st instead of almost the same.
 */
export function finishPoints(place, fieldSize, cfg = SCORING) {
  const N = Number(fieldSize) || 0;
  if (!place || place <= 0) return 0;

  // "places": you score the number of players you finished ahead of, plus one.
  // Winner of a 36-player game gets 36; the first player out gets 1.
  if ((cfg.mode ?? "places") === "places") {
    return N <= 0 ? 0 : Math.max(0, N - place + 1);
  }

  // "curve": field-size neutral and top-heavy.
  if (N <= 1) return place === 1 ? cfg.maxFinishPoints : 0;
  const beaten = (N - place) / (N - 1);
  const clamped = Math.min(1, Math.max(0, beaten));
  return cfg.maxFinishPoints * Math.pow(clamped, cfg.gamma);
}

/** Knockouts credited per player name. */
export function knockoutsByName(players) {
  const counts = new Map();
  for (const p of players) {
    const h = norm(p.hitman_name);
    if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return counts;
}

/**
 * Where a player currently sits for scoring, as a FINISHING PLACE where 1 is
 * the winner.
 *
 * Three cases, and the middle one is easy to get wrong:
 *   * `placement` is the finishing place and is authoritative when present.
 *     Live tournaments leave it null; it is filled in when the game is
 *     integrated.
 *   * `elimination_position` (ko_position in the database) is the ORDER OF
 *     ELIMINATION — 1 means the first player knocked out, i.e. LAST place.
 *     Verified against live tournament 712, where the first player out carried
 *     elimination_position 1. It must therefore be inverted against the field
 *     size, not used as a place directly.
 *   * Players still in are scored at the place they would take if they busted
 *     on the next hand, i.e. the number still alive, so live scores climb as
 *     the field shrinks.
 */
export function effectivePlace(p, playersAlive, fieldSize) {
  if (p.placement != null) return Number(p.placement);
  if (p.elimination_position != null) {
    const n = Number(fieldSize) || 0;
    return Math.max(1, n - Number(p.elimination_position) + 1);
  }
  return Math.max(1, playersAlive);
}

/**
 * Score one entry (array of {id}) against the current roster.
 *
 * Surviving picks are credited with DISTINCT finishing places, counting back
 * from the current bubble. If 11 players remain and you hold 3 of them they
 * cannot all finish 11th — at worst they go out 11th, 10th and 9th. Crediting
 * each with 11th understates the entry, so places are assigned descending.
 * The sum does not depend on which pick takes which place, so this is a floor
 * on the entry's final score rather than a guess.
 */
export function scoreEntry(picks, players, cfg = SCORING) {
  const byId = new Map(players.map((p) => [Number(p.id), p]));
  const fieldSize = players.length;
  const playersAlive = players.filter(isAlive).length;
  const kos = knockoutsByName(players);

  const resolved = [];
  for (const pick of picks) {
    const p = byId.get(Number(pick.id ?? pick.tournament_draft_player_id));
    if (p) resolved.push(p);
  }

  let nextAlivePlace = playersAlive;
  const scored = resolved.map((p) => {
    const alive = isAlive(p);
    const place = alive
      ? Math.max(1, nextAlivePlace--)
      : effectivePlace(p, playersAlive, fieldSize);
    const fp = finishPoints(place, fieldSize, cfg);
    const koCount = kos.get(norm(p.name)) ?? 0;
    const kp = koCount * cfg.knockoutPoints;
    return {
      id: Number(p.id),
      name: p.nickname ? `${p.nickname} (${p.name})` : p.name,
      alive,
      effectivePlace: place,
      finishPoints: round1(fp),
      knockouts: koCount,
      knockoutPoints: kp,
      totalPoints: round1(fp + kp),
    };
  });

  const finish = scored.reduce((s, x) => s + x.finishPoints, 0);
  const ko = scored.reduce((s, x) => s + x.knockoutPoints, 0);
  const done = scored.filter((x) => !x.alive).map((x) => x.effectivePlace);

  return {
    finishPoints: round1(finish),
    knockoutPoints: ko,
    totalPoints: round1(finish + ko),
    knockouts: scored.reduce((s, x) => s + x.knockouts, 0),
    picksAlive: scored.filter((x) => x.alive).length,
    bestFinish: done.length ? Math.min(...done) : null,
    picks: scored,
  };
}
/** Best score reachable in a field of this size (picks finish 1..n). */
export function maxAchievable(fieldSize, cfg = SCORING) {
  let total = 0;
  for (let place = 1; place <= Math.min(cfg.picksRequired, fieldSize); place++) {
    total += finishPoints(place, fieldSize, cfg);
  }
  return round1(total);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
