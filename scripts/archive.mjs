// scripts/archive.mjs
//
// Keeps the Finished tab populated around the clock, with no server and no
// paid plan.
//
// The app used to archive a tournament only when a browser happened to be
// watching it end, or when someone opened the Finished tab. Games nobody
// watched were simply lost. This script does the same work on a schedule from
// GitHub Actions:
//
//   1. reads the project's own public SDK config from Firebase Hosting,
//   2. signs in anonymously (the same identity any visitor gets, so the
//      existing firestore.rules already permit exactly these writes),
//   3. walks the Freeroll tournament ids over socket.io to find every game,
//   4. writes contests/<id> and contests/<id>/results/final for each finished
//      game that has not been archived yet,
//   5. mirrors game_started to Firestore for games that are running, which
//      closes picks even if no browser is open when the clock starts.
//
// No secrets are involved. Firebase web config is public by design and every
// write here is one an ordinary visitor could already make.

import { io } from "socket.io-client";
import { buildSummary } from "../public/scoring.js";

// Only relevant when the job runs behind an HTTP proxy. GitHub's runners are
// not, so this stays inert there and https-proxy-agent is never loaded.
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "";
let ProxyAgent = null;
if (PROXY) {
  try { ProxyAgent = (await import("https-proxy-agent")).HttpsProxyAgent; }
  catch (_) { console.warn("proxy set but https-proxy-agent is not installed"); }
}

const HOSTING = process.env.HOSTING_ORIGIN || "https://freeroll-fantasy-draft.web.app";
const FREEROLL = process.env.FREEROLL_ORIGIN || "https://openbarleague.com";
const FS = "https://firestore.googleapis.com/v1";

// How far back to look behind the known frontier, and how far ahead to walk
// looking for new games.
const BACK = Number(process.env.BACKFILL_BACK || 40);
const FROM = process.env.BACKFILL_FROM ? Number(process.env.BACKFILL_FROM) : null;
// Set when the summary shape changes and stored ones must be rebuilt.
const RESUMMARISE = process.env.RESUMMARISE === "1";
const CHUNK = 25;
const MAX_CHUNKS = 12;

const log = (...a) => console.log(...a);

// ----------------------------------------------------------------- firestore
let cfg, idToken, base;

async function connect() {
  const r = await fetch(HOSTING + "/__/firebase/init.json");
  if (!r.ok) throw new Error("init.json " + r.status);
  cfg = await r.json();
  base = FS + "/projects/" + cfg.projectId + "/databases/(default)/documents";

  const a = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + cfg.apiKey,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }) });
  const body = await a.json();
  if (!a.ok) throw new Error("anon sign-in " + a.status + ": " + JSON.stringify(body));
  idToken = body.idToken;
  log("signed in to " + cfg.projectId + " as an anonymous user");
}

/** Encode a plain JS value as a Firestore typed value. */
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number")
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === "object")
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(function (e) { return [e[0], enc(e[1])]; })) } };
  return { stringValue: String(v) };
}

/** PATCH with an updateMask, which is Firestore REST's merge write. */
async function write(path, data) {
  const mask = Object.keys(data).map((k) => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  const fields = Object.fromEntries(Object.entries(data).map(function (e) { return [e[0], enc(e[1])]; }));
  const r = await fetch(base + "/" + path + "?" + mask, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer " + idToken },
    body: JSON.stringify({ fields: fields }),
  });
  if (!r.ok) throw new Error("write " + path + ": " + r.status + " " + (await r.text()));
}

async function read(path) {
  const r = await fetch(base + "/" + path, { headers: { authorization: "Bearer " + idToken } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("read " + path + ": " + r.status);
  return r.json();
}

/** Every contest doc that already exists, with what we need to decide on it. */
async function existingContests() {
  const out = new Map();
  let token = "";
  for (let page = 0; page < 20; page++) {
    const r = await fetch(base + "/contests?pageSize=300" + token,
      { headers: { authorization: "Bearer " + idToken } });
    if (!r.ok) throw new Error("list contests: " + r.status);
    const j = await r.json();
    for (const d of j.documents || []) {
      const id = d.name.split("/").pop();
      const f = d.fields || {};
      out.set(id, {
        tournamentId: f.tournamentId ? Number(f.tournamentId.integerValue) : null,
        hasSummary: RESUMMARISE ? false : Boolean(f.summary),
      });
    }
    if (!j.nextPageToken) break;
    token = "&pageToken=" + j.nextPageToken;
  }
  return out;
}


/** Turn a frozen results/final document back into plain player objects. */
function decodePlayers(finalDoc) {
  const vals = (finalDoc && finalDoc.fields && finalDoc.fields.players &&
    finalDoc.fields.players.arrayValue && finalDoc.fields.players.arrayValue.values) || [];
  return vals.map((v) => {
    const f = (v.mapValue && v.mapValue.fields) || {};
    const num = (k) => (f[k] && f[k].integerValue != null ? Number(f[k].integerValue) : null);
    return {
      id: num("id"),
      name: f.name && f.name.stringValue ? f.name.stringValue : "",
      nickname: f.nickname && f.nickname.stringValue ? f.nickname.stringValue : null,
      placement: num("placement"),
      elimination_position: num("elimination_position"),
      hitman_name: f.hitman_name && f.hitman_name.stringValue ? f.hitman_name.stringValue : null,
      is_active: Boolean(f.is_active && f.is_active.booleanValue),
    };
  });
}

/** One contest's entries, as the scorer expects them. */
async function readEntries(contestId) {
  const r = await fetch(base + "/contests/" + contestId + "/entries?pageSize=300",
    { headers: { authorization: "Bearer " + idToken } });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.documents || []).map((d) => {
    const f = d.fields || {};
    const picks = ((f.picks && f.picks.arrayValue && f.picks.arrayValue.values) || []).map((p) => {
      const pf = (p.mapValue && p.mapValue.fields) || {};
      return {
        id: pf.id ? Number(pf.id.integerValue) : null,
        name: pf.name ? pf.name.stringValue : "",
      };
    });
    return {
      entrantId: d.name.split("/").pop(),
      name: f.name ? f.name.stringValue : "",
      picks: picks,
    };
  });
}

// -------------------------------------------------------------------- socket
/**
 * Join a batch of tournament rooms on one socket and record which ids exist
 * and what state they are in. joinRoom needs no auth and answers for any id
 * whatever its status, which is what makes an archive with no database access
 * possible at all.
 *
 * Only `tournament:updated` is useful here, because it carries the tournament
 * id inside the payload. `updatePlayers` arrives as a bare array with no id
 * attached, so rosters have to be fetched one room per socket (see below).
 */
function probe(sock, ids, tournaments) {
  return new Promise((resolve) => {
    let quiet = setTimeout(done, 3000);
    const onT = (ev) => {
      const t = ev && ev.data && ev.data.tournament;
      if (t && t.id != null) {
        tournaments.set(Number(t.id), t);
        clearTimeout(quiet);
        quiet = setTimeout(done, 800);
      }
    };
    function done() {
      clearTimeout(quiet);
      sock.off("tournament:updated", onT);
      resolve();
    }
    sock.on("tournament:updated", onT);
    ids.forEach((id) => sock.emit("joinRoom", String(id)));
  });
}

/** Fetch one tournament's final roster on its own socket. */
async function fetchRoster(id) {
  let sock;
  try { sock = await openSocket(); } catch (_) { return null; }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 15000);
    sock.on("updatePlayers", (list) => { if (Array.isArray(list)) finish(list); });
    sock.emit("joinRoom", String(id));
  });
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const opts = {
      transports: ["polling", "websocket"],
      tryAllTransports: true,
      reconnection: false,
      timeout: 20000,
    };
    if (ProxyAgent) opts.agent = new ProxyAgent(PROXY);
    const s = io(FREEROLL, opts);
    const t = setTimeout(() => reject(new Error("socket timeout")), 20000);
    s.on("connect", () => { clearTimeout(t); resolve(s); });
    s.on("connect_error", (e) => { clearTimeout(t); reject(new Error("socket: " + e.message)); });
  });
}

// ---------------------------------------------------------------------- main
async function main() {
  await connect();

  const known = await existingContests();
  const frontierDoc = await read("config/discovery");
  const remembered = Number((frontierDoc && frontierDoc.fields && frontierDoc.fields.newest &&
    frontierDoc.fields.newest.integerValue) || 0);
  const fromContests = Math.max(0, ...[...known.values()].map((v) => v.tournamentId || 0), 0);
  const start = FROM !== null ? FROM : Math.max(1, Math.max(remembered, fromContests, 1) - BACK);
  log("starting id " + start + " (remembered " + (remembered || "none") +
      ", contests " + (fromContests || "none") + ")");

  const sock = await openSocket();
  const tournaments = new Map();
  let highest = 0;
  for (let c = 0; c < MAX_CHUNKS; c++) {
    const ids = [];
    for (let i = start + c * CHUNK; i < start + (c + 1) * CHUNK; i++) ids.push(i);
    const before = tournaments.size;
    await probe(sock, ids, tournaments);
    const maxSeen = tournaments.size ? Math.max(...tournaments.keys()) : 0;
    if (maxSeen > highest) highest = maxSeen;
    log("  ids " + ids[0] + "-" + ids[ids.length - 1] + ": " + (tournaments.size - before) + " found");
    if (tournaments.size === before && ids[0] > highest) break;
  }
  try { sock.close(); } catch (_) {}
  log(tournaments.size + " tournaments seen, highest id " + highest);

  let archived = 0, locked = 0, summarised = 0;
  const ordered = [...tournaments.entries()].sort((a, b) => a[0] - b[0]);
  for (const entry of ordered) {
    const id = entry[0], t = entry[1];
    const contestId = String(id);

    if (t.status === "in_progress") {
      // Mirror the clock start so picks close even with nobody on the page.
      if (t.game_started) {
        if (!known.has(contestId)) await write("contests/" + contestId, { tournamentId: id, gameStarted: false });
        await write("contests/" + contestId, {
          tournamentId: id, title: t.title || null, venue: t.venue || null,
          td: t.td || null, date: t.date || null, gameStarted: true, updatedAt: new Date(),
        });
        locked++;
      }
      continue;
    }

    const info = known.get(contestId) || null;
    const final = await read("contests/" + contestId + "/results/final");
    const have = final && Number((final.fields && final.fields.fieldSize &&
      final.fields.fieldSize.integerValue) || 0);
    const reported = Number(t.total_players || 0);
    const frozen = Boolean(have && (!reported || have === reported));

    let players = null;
    if (frozen) {
      // Already have the whole field. Only a summary might still be missing,
      // on the real contest or on its "test-<id>" dry run.
      const testMeta = known.get("test-" + id);
      const realDone = Boolean(info && info.hasSummary);
      const testDone = !testMeta || testMeta.hasSummary;
      if (realDone && testDone) continue;
      players = decodePlayers(final);
    } else {
      players = await fetchRoster(id);
      if (!players || !players.length) { log("  " + id + ": no roster, skipped"); continue; }
      if (have === players.length && info && info.hasSummary) continue;

      await write("contests/" + contestId + "/results/final", {
        fieldSize: players.length,
        players: players.map((p) => ({
          id: Number(p.id), name: String(p.name), nickname: p.nickname || null,
          placement: p.placement == null ? null : p.placement,
          elimination_position: p.elimination_position == null ? null : p.elimination_position,
          hitman_name: p.hitman_name || null,
          is_active: Boolean(p.is_active),
        })),
        frozenAt: new Date(),
      });
      archived++;
      log("  archived " + id + ": " + (t.venue || t.title || "game") + " (" + players.length + " players)");
    }

    if (!players.length) continue;

    // The real contest, and the "test-<id>" dry-run contest alongside it. Test
    // contests hold the entries made while TEST_MODE was on, and both tabs
    // count them, so they need a summary from the same roster.
    for (const cid of [contestId, "test-" + id]) {
      const meta = known.get(cid) || null;
      if (cid !== contestId && !meta) continue;        // no dry run for this game
      if (meta && meta.hasSummary && frozen) continue;
      const summary = buildSummary(players, await readEntries(cid));
      if (!meta) await write("contests/" + cid, { tournamentId: id, gameStarted: false });
      await write("contests/" + cid, {
        tournamentId: id, title: t.title || null, venue: t.venue || null,
        td: t.td || null, date: t.date || null, fieldSize: players.length,
        gameStarted: true, summary: summary, updatedAt: new Date(),
      });
      summarised++;
      if (summary.entryCount) {
        log("  " + cid + ": " + summary.entryCount + " entries, won by " +
            (summary.standings[0] ? summary.standings[0].name : "?"));
      }
    }
  }

  if (highest > remembered) await write("config/discovery", { newest: highest, updatedAt: new Date() });
  log("done: " + archived + " archived, " + summarised + " summarised, " + locked +
      " locked, frontier " + Math.max(highest, remembered));
}

main().catch((e) => { console.error(e); process.exit(1); });
