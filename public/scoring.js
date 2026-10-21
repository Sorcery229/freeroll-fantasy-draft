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
  gamma: 3,
  maxFinishPoints: 100,
  knockoutPoints: 2,
  picksRequired: 5,
};

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
  if (fieldSize <= 1) return place === 1 ? cfg.maxFinishPoints : 0;
  if (!place || place <= 0) return 0;
  const beaten = (fieldSize - place) / (fieldSize - 1);
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
 * Where a player currently sits for scoring. Busted players use their recorded
 * position; players still in are scored at the place they would take if they
 * busted on the next hand, i.e. the number still alive. That makes live scores
 * climb as the field shrinks.
 */
export function effectivePlace(p, playersAlive) {
  if (p.placement != null) return Number(p.placement);
  if (p.elimination_position != null) return Number(p.elimination_position);
  return Math.max(1, playersAlive);
}

/** Score one entry (array of {id, name}) against the current roster. */
export function scoreEntry(picks, players, cfg = SCORING) {
  const byId = new Map(players.map((p) => [Number(p.id), p]));
  const fieldSize = players.length;
  const playersAlive = players.filter(isAlive).length;
  const kos = knockoutsByName(players);

  const scored = [];
  for (const pick of picks) {
    const p = byId.get(Number(pick.id));
    if (!p) continue;
    const place = effectivePlace(p, playersAlive);
    const fp = finishPoints(place, fieldSize, cfg);
    const koCount = kos.get(norm(p.name)) ?? 0;
    const kp = koCount * cfg.knockoutPoints;
    scored.push({
      id: Number(p.id),
      name: p.nickname ? `${p.nickname} (${p.name})` : p.name,
      alive: isAlive(p),
      effectivePlace: place,
      finishPoints: round1(fp),
      knockouts: koCount,
      knockoutPoints: kp,
      totalPoints: round1(fp + kp),
    });
  }

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
