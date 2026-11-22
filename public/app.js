// public/app.js
//
// Fantasy draft for Freeroll Atlanta, hosted on Firebase, reading live
// tournament state straight from openbarleague.com over socket.io.
//
// Why this works with no database or repo access:
//   * The Freeroll socket.io server sets cors {origin: true, credentials: true}
//     (server.mts:1015), which reflects any Origin. Verified against
//     production: a handshake sent with a Firebase Origin came back with a
//     matching access-control-allow-origin.
//   * Its `joinRoom` handler (server.mts:1182) needs no auth and immediately
//     emits `updatePlayers` (full roster), `tournament:updated` (including
//     game_started) and `timer:sync` (level, time left, blind schedule).
//     Verified live on tournament 712.
//   * The REST API sends no CORS headers at all, so it is never used here.
//
// Firestore holds only our own data: entrant names and picks.

// The Firebase SDK is loaded DYNAMICALLY, further down in start().
//
// As a static import it was fetched and parsed before the first line of this
// file ran, so roughly 100 KB had to arrive from the CDN before the page could
// so much as draw the name prompt. That was most of the blank screen. Nothing
// above the fold needs Firebase: the name form is plain HTML and the tournament
// feed is a socket to openbarleague.com.
let initializeApp, getAuth, signInAnonymously, onAuthStateChanged;
let getFirestore, doc, getDoc, setDoc, collection, onSnapshot;
let getDocs, query, where, limit, serverTimestamp;

const FIREBASE_VERSION = "10.12.2";

// Resolves once db is usable. Views that read Firestore await this instead of
// assuming the SDK has arrived, since the page is now interactive before it has.
let dbReady = null;
// Resolves with the Firebase config, which arrives long before the SDK does.
// The REST reads need only the project id, so they wait on this, not on dbReady.
let configReady = null;

async function loadFirebaseSdk() {
  const cdn = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${cdn}/firebase-app.js`),
    import(`${cdn}/firebase-auth.js`),
    import(`${cdn}/firebase-firestore.js`),
  ]);
  ({ initializeApp } = appMod);
  ({ getAuth, signInAnonymously, onAuthStateChanged } = authMod);
  ({ getFirestore, doc, getDoc, setDoc, collection, onSnapshot,
     getDocs, query, where, limit, serverTimestamp } = fsMod);
}

import {
  firebaseConfig, FREEROLL_ORIGIN, FOLLOW_TOURNAMENT_IDS, TEST_MODE,
} from "/config.js";
import { SCORING, SEASON_POINTS, isAlive, finishPoints, seasonPointsForRank, computeStandings, buildSummary }
  from "/scoring.js";

let app = null, auth = null, db = null;

/** Hosting serves the project's SDK config here, so no keys live in source. */
async function resolveConfig() {
  try {
    const res = await fetch("/__/firebase/init.json", { cache: "no-store" });
    if (res.ok) {
      const cfg = await res.json();
      if (cfg && cfg.apiKey) return cfg;
    }
  } catch (_) { /* not on Firebase Hosting */ }
  const local = firebaseConfig ?? {};
  if (local.apiKey && !String(local.apiKey).startsWith("REPLACE")) return local;
  return null;
}

const DEMO_ID = "demo";
const DEMO_SEED = 20261021;

const state = {
  uid: null, name: null,
  view: "home",
  projectId: null,       // for the REST reads on the Finished and Season tabs
  contestEnsured: false, // contests/{id} exists, so entries may be written
  lockMirrored: false,   // game_started has been copied into Firestore
  booted: false,         // boot() has run; auth must not re-run discovery
  discovering: false,    // a tournament search is in flight
  follow: [],            // tournament ids shown on the home page
  cards: {},             // id -> { tournament, players, timer }
  activeId: null,        // tournament currently open
  contestId: null,       // Firestore contest doc id
  entries: [], mockEntries: [],
  selected: [], expanded: new Set(), math: new Set(),
  metaSaved: false, resultsFrozen: false, finishedOpen: null, showLeft: false,
  rediscover: null,
  sockets: {},
  filter: "", poolFilter: "",
  demo: false, demoSeed: null,
};

const $ = (s) => document.querySelector(s);
const el = { status: $("#status"), whoami: $("#whoami") };

function setStatus(msg, kind) {
  el.status.textContent = msg || "";
  el.status.style.color = kind === "error" ? "#f87171" : "";
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function card(id) {
  if (!state.cards[id]) state.cards[id] = { tournament: null, players: [], timer: null };
  return state.cards[id];
}
function active() { return state.activeId != null ? card(state.activeId) : null; }

// ---------------------------------------------------------------- views
function showView(name) {
  state.view = name;
  for (const v of ["name", "home", "draft", "standings", "finished", "season", "rules"]) {
    const node = document.getElementById(`view-${v}`);
    if (node) node.hidden = v !== name;
  }
  document.querySelectorAll(".tab").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.view === name)));
  if (name === "season") renderSeason();
  if (name === "finished") renderFinished();
  if (name === "rules") renderRules();
  render();
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    if (!state.name) return showView("name");
    const needsGame = !["home", "season", "finished", "rules"].includes(t.dataset.view);
    if (needsGame && state.activeId == null) {
      if (state.follow.length) { openTournament(state.follow[0], t.dataset.view); return; }
      showView("home");
      setStatus("No tournament is running right now. Finished games are under the Finished tab.");
      return;
    }
    showView(t.dataset.view);
  }));

$("#brand").addEventListener("click", () => showView(state.name ? "home" : "name"));

// ---------------------------------------------------------------- identity
/**
 * The name shown last time, cached beside the uid it belonged to.
 *
 * Reading it costs nothing, which is the point: the page used to sit blank
 * through four sequential network steps (the Firebase SDK from the CDN,
 * /__/firebase/init.json, anonymous sign-in, then the entrant document) before
 * it could decide whether to show the name prompt or the tournament list. With
 * the name cached it can draw the right screen on the first frame and let all
 * of that finish in the background.
 */
function cachedMe() {
  try {
    const raw = localStorage.getItem(ME_KEY);
    if (!raw) return null;
    const me = JSON.parse(raw);
    return me && me.name ? me : null;
  } catch (_) { return null; }
}

function rememberMe(uid, name) {
  try { localStorage.setItem(ME_KEY, JSON.stringify({ uid: uid, name: name })); }
  catch (_) {}
}

async function handleAuth(user) {
  if (!user) {
    try { await signInAnonymously(auth); }
    catch (e) { setStatus(`Could not start a session: ${e.message}`, "error"); }
    return;
  }
  state.uid = user.uid;
  let snap = null;
  try { snap = await withTimeout(getDoc(doc(db, "entrants", user.uid)), 10000); } catch (_) {}

  if (snap && snap.exists() && snap.data().name) {
    state.name = snap.data().name;
    el.whoami.textContent = `Playing as ${state.name}`;
    rememberMe(user.uid, state.name);
    // The tournament search already ran from the cached name. Only attach the
    // Firestore half now; re-running discovery would be wasted work.
    if (state.booted) attachContest();
    else await boot();
    return;
  }

  // No entrant record. If we optimistically drew the tournament list from a
  // cached name, that cache is stale, so fall back to asking.
  state.name = null;
  el.whoami.textContent = "";
  showView("name");
}

/** The parts of a contest that need a signed-in user, run once auth lands. */
function attachContest() {
  if (state.activeId == null || !db || !state.uid) return;
  state.contestId = TEST_MODE ? `test-${state.activeId}` : String(state.activeId);
  watchEntries();
  render();
}

$("#name-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("#name-input").value.trim();
  if (name.length < 2) { $("#name-error").textContent = "Name must be at least 2 characters."; return; }
  $("#name-error").textContent = "";

  // The form is now drawn before sign-in has finished, so someone typing
  // quickly can arrive here first. Wait for it rather than telling them to try
  // again.
  if (!db || !state.uid) {
    $("#name-error").textContent = "Saving\u2026";
    await withTimeout(dbReady, 15000);
    for (let i = 0; i < 100 && !state.uid; i++) await new Promise((r) => setTimeout(r, 100));
    if (!db || !state.uid) {
      $("#name-error").textContent = "Could not reach the server. Check your connection and try again.";
      return;
    }
    $("#name-error").textContent = "";
  }

  try {
    // One name per entrant. Compared lower-cased, so "Greg" cannot sit next to
    // "greg" in the standings.
    const taken = await getDocs(query(
      collection(db, "entrants"),
      where("name_lc", "==", name.toLowerCase()),
      limit(5)
    ));
    const clash = taken.docs.find((d) => d.id !== state.uid);
    if (clash) {
      $("#name-error").textContent = `"${name}" is already taken. Pick another one.`;
      return;
    }

    await setDoc(doc(db, "entrants", state.uid),
      { name, name_lc: name.toLowerCase(), updatedAt: serverTimestamp() }, { merge: true });
    state.name = name;
    el.whoami.textContent = `Playing as ${name}`;
    rememberMe(state.uid, name);
    if (state.booted) attachContest();
    else await boot();
  } catch (e) {
    $("#name-error").textContent = e.message;
  }
});

$("#change-name").addEventListener("click", () => {
  $("#name-input").value = state.name ?? "";
  showView("name");
});

if (new URLSearchParams(location.search).has("setup")) $("#set-tournament").hidden = false;
$("#set-tournament").addEventListener("click", async () => {
  const next = prompt("Tournament id to follow", state.activeId ?? "");
  const id = parseInt(next, 10);
  if (isNaN(id)) return;
  try { await setDoc(doc(db, "config", "active"), { tournamentId: id, updatedAt: serverTimestamp() }); } catch (_) {}
  location.search = `?t=${id}`;
});

// ---------------------------------------------------------------- boot
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
}

async function boot() {
  if (state.booted) return;
  state.booted = true;
  if (new URLSearchParams(location.search).has("demo")) return bootDemo();

  const param = new URLSearchParams(location.search).get("t");
  const fromUrl = param ? param.split(",").map((x) => parseInt(x, 10)).filter((n) => !isNaN(n)) : [];
  const seeds = (Array.isArray(FOLLOW_TOURNAMENT_IDS) ? FOLLOW_TOURNAMENT_IDS : [])
    .map(Number).filter(Number.isFinite);

  if (fromUrl.length) {
    state.follow = fromUrl;
  } else {
    state.discovering = true;
    showView("home");
    renderHome();
    state.follow = await discoverLive(seeds, (id) => {
      if (!state.follow.includes(id)) state.follow.push(id);
      followTournament(id);
      renderHome();
    });
    state.discovering = false;
  }

  showView("home");
  for (const id of state.follow) followTournament(id);
  // Select one up front so Make Picks and Standings are usable immediately.
  if (state.follow.length) {
    state.activeId = state.follow[0];
    attachContest();   // no-op until sign-in lands, then re-run from handleAuth
  }

  if (!fromUrl.length && !state.rediscover) {
    state.rediscover = setInterval(refreshLive, 120000);
  }
}

/** Re-run discovery so a game that starts later shows up on its own. */
async function refreshLive() {
  const live = await discoverLive(state.follow.length ? state.follow : []);
  const added = live.filter((id) => !state.follow.includes(id));
  const ended = state.follow.filter((id) => !live.includes(id));
  if (!added.length && !ended.length) return;

  state.follow = live;
  for (const id of added) followTournament(id);

  if (state.activeId != null && ended.includes(state.activeId)) {
    if (live.length) openTournament(live[0]);
    else { state.activeId = null; showView("home"); }
  }
  render();
}

// ---------------------------------------------------------------- discovery
/**
 * Find which tournaments are running right now.
 *
 * The dashboard's REST list of active games sends no CORS headers, so a browser
 * cannot read it. The socket can: joining a room returns that tournament's
 * record whatever its id, and a finished game reports `status: "integrated"`
 * rather than `in_progress`. So we join a bounded window of ids on one
 * throwaway socket, keep whichever come back in progress, drop it, then open a
 * real socket per live game.
 *
 * Tournament ids increment, so the window only has to reach a little past the
 * newest id we have ever seen, which is remembered between visits.
 */
const SEEN_KEY = "freeroll-fantasy:newest-tournament";
const ME_KEY = "freeroll-fantasy:me";
const FINISHED_LIMIT = 30;  // how many past games the Finished tab loads
const PROBE_CHUNK = 20;      // ids per pass
const PROBE_MAX_CHUNKS = 10; // how far ahead we are willing to walk

/**
 * Walk forward from the newest id we know of until we reach the end of the
 * league's tournament list, then report which of those are in progress.
 *
 * The window has to be adaptive. A fixed lookahead silently stops working the
 * moment the league creates more tournaments than the window spans between two
 * visits: nothing is found, so the remembered id never advances, so nothing is
 * ever found again. Walking in chunks until a chunk comes back empty self heals
 * from any gap.
 */
function probeChunk(probe, ids, found) {
  return new Promise((resolve) => {
    let quiet = setTimeout(done, 2500);
    function onT(ev) {
      const t = ev?.data?.tournament;
      if (t && t.id != null) {
        found.set(Number(t.id), t);
        const c = card(Number(t.id));
        if (!c.tournament) c.tournament = t;
        clearTimeout(quiet);
        quiet = setTimeout(done, 600);
      }
    }
    function done() {
      clearTimeout(quiet);
      probe.off("tournament:updated", onT);
      resolve();
    }
    probe.on("tournament:updated", onT);
    ids.forEach((id) => probe.emit("joinRoom", String(id)));
  });
}

async function discoverLive(seedIds, onFound) {
  const remembered = Number(localStorage.getItem(SEEN_KEY) || 0);
  let base = Math.max(remembered, ...seedIds.map(Number), 0);
  if (!base) base = 1;

  const found = new Map();
  const probe = io(FREEROLL_ORIGIN, {
    transports: ["websocket", "polling"],
    withCredentials: false,
    reconnection: false,
  });

  const connected = await new Promise((resolve) => {
    const giveUp = setTimeout(() => resolve(false), 6000);
    probe.on("connect", () => { clearTimeout(giveUp); resolve(true); });
    probe.on("connect_error", () => { clearTimeout(giveUp); resolve(false); });
  });
  if (!connected) { try { probe.close(); } catch (_) {} return []; }

  const reported = new Set();
  const report = () => {
    if (typeof onFound !== "function") return;
    for (const [id, t] of found) {
      if (t.status !== "in_progress" || reported.has(id)) continue;
      reported.add(id);
      onFound(id);
    }
  };

  // Start just behind the known id, then keep stepping forward while each chunk
  // still turns up tournaments that exist.
  let start = Math.max(1, base - 2);
  let highest = base;
  for (let chunk = 0; chunk < PROBE_MAX_CHUNKS; chunk++) {
    const ids = [];
    for (let id = start; id < start + PROBE_CHUNK; id++) ids.push(id);
    const before = found.size;
    await probeChunk(probe, ids, found);
    report();

    const maxSeen = found.size ? Math.max(...found.keys()) : 0;
    if (maxSeen > highest) highest = maxSeen;
    // Nothing new in this chunk and we are already past the frontier: stop.
    if (found.size === before && start > highest) break;
    start += PROBE_CHUNK;
  }

  try { probe.close(); } catch (_) {}
  if (highest > remembered) localStorage.setItem(SEEN_KEY, String(highest));

  return [...found.entries()]
    .filter(([, t]) => t.status === "in_progress")
    .map(([id]) => id)
    .sort((x, y) => y - x);
}

// ---------------------------------------------------------------- socket
function followTournament(id) {
  if (state.sockets[id]) return;
  const s = io(FREEROLL_ORIGIN, {
    transports: ["websocket", "polling"],
    withCredentials: false,
    reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 10000,
  });
  state.sockets[id] = s;

  const join = () => s.emit("joinRoom", String(id));
  s.on("connect", () => { setStatus(""); join(); });
  s.on("connect_error", (err) =>
    setStatus(`Cannot reach the live tournament feed (${err.message}).`, "error"));

  s.on("updatePlayers", (players) => {
    if (Array.isArray(players)) { card(id).players = players; onData(id); }
  });
  s.on("players:updated", (ev) => {
    if (ev?.data?.players) { card(id).players = ev.data.players; onData(id); }
  });
  s.on("tournament:updated", (ev) => {
    if (ev?.data?.tournament) { card(id).tournament = ev.data.tournament; onData(id); }
  });
  s.on("timer:sync", (t) => { card(id).timer = withClientClock(t); onData(id); });
  s.on("timer:update", (t) => { card(id).timer = withClientClock(t); onData(id); });
  s.on("player:eliminated", () => join());
  s.on("player:added", () => join());
}

/** Record when a timer snapshot arrived so the countdown can run locally. */
function withClientClock(t) {
  return { ...t, receivedAt: Date.now() };
}

function onData(id) {
  if (id === state.activeId) {
    if (TEST_MODE) buildLiveMocks();
    syncContest();
    maybeFreezeResults();
  }
  render();
}

/**
 * Keep contests/{id} in step with the live tournament.
 *
 * Three separate writes, because firestore.rules treats them differently and
 * each was verified against the live rules:
 *
 *   1. ENSURE. The document must exist before anyone can enter, and the create
 *      rule demands `gameStarted == false`. The old code wrote the metadata
 *      without that field, which is denied, so in real mode the contest was
 *      never created and no picks could be submitted at all. Sent as a merge:
 *      harmless on a contest that is already open, refused on one already
 *      locked, which is exactly right since that one already exists.
 *   2. METADATA. Allowed whether the contest is open or locked, which is what
 *      lets the Finished tab name a game.
 *   3. LOCK. Mirrors the TD starting the clock into `gameStarted`, which the
 *      rules then use to refuse further entries. Monotonic: it cannot go back.
 *
 * The lock used to be set only by the scheduled archiver, which GitHub actually
 * runs about every six hours, so picks could stay open most of the night after
 * the clock started. Any open page now closes it within seconds.
 */
async function syncContest() {
  const c = active();
  if (!c?.tournament || !state.contestId || !db || !state.uid) return;
  const t = c.tournament;
  const ref = doc(db, "contests", String(state.contestId));

  if (!state.contestEnsured) {
    state.contestEnsured = true;
    try {
      await setDoc(ref, { tournamentId: state.activeId, gameStarted: false }, { merge: true });
    } catch (_) { /* already exists and locked: nothing to create */ }
  }

  if (!state.metaSaved) {
    try {
      await setDoc(ref, {
        tournamentId: state.activeId,
        title: t.title ?? null,
        venue: t.venue ?? null,
        td: t.td ?? null,
        date: t.date ?? null,
        fieldSize: c.players.length,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      state.metaSaved = true;
    } catch (e) { console.warn("contest meta:", e.message); }
  }

  if (!TEST_MODE && t.game_started && !state.lockMirrored) {
    state.lockMirrored = true;
    try {
      await setDoc(ref, { gameStarted: true, updatedAt: serverTimestamp() }, { merge: true });
    } catch (e) { console.warn("lock:", e.message); }
  }
}

/**
 * Once a tournament is over, freeze the final roster under the contest. That is
 * what lets the Finished and Season tabs rescore a past game with no live feed.
 */
async function maybeFreezeResults() {
  const c = active();
  const players = c?.players ?? [];
  if (!players.length || state.resultsFrozen) return;
  const alive = players.filter(isAlive).length;
  const over = c.tournament?.status === "completed" || (alive <= 1 && players.length > 1);
  if (!over) return;
  state.resultsFrozen = true;
  try {
    await setDoc(doc(db, "contests", String(state.contestId), "results", "final"), {
      fieldSize: players.length,
      players: players.map((p) => ({
        id: Number(p.id),
        name: String(p.name),
        nickname: p.nickname ?? null,
        placement: p.placement ?? null,
        elimination_position: p.elimination_position ?? null,
        hitman_name: p.hitman_name ?? null,
        is_active: isAlive(p),
      })),
      frozenAt: serverTimestamp(),
    }, { merge: true });
    // Also store the precomputed summary, so a game someone watched to the end
    // shows up under Finished at once rather than waiting for the next
    // scheduled archive run.
    await setDoc(doc(db, "contests", String(state.contestId)), {
      // state.entries, NOT allEntries(): the latter includes the page-local
      // synthetic predictions from TEST_MODE, which must never be persisted.
      summary: buildSummary(players, state.entries),
      fieldSize: players.length,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (e) { console.warn("freeze results:", e.message); }
}

function openTournament(id, view = "standings") {
  state.activeId = id;
  state.contestId = TEST_MODE ? `test-${id}` : String(id);
  state.mockEntries = [];
  state.entries = [];
  state.metaSaved = false;
  state.contestEnsured = false;
  state.lockMirrored = false;
  state.resultsFrozen = false;
  followTournament(id);
  watchEntries();
  showView(view);
}


// ---------------------------------------------------------------- entries
function watchEntries() {
  if (!state.contestId || !db || !state.uid) return;
  onSnapshot(collection(db, "contests", String(state.contestId), "entries"), (snap) => {
    state.entries = snap.docs.map((d) => ({ entrantId: d.id, ...d.data() }));
    const mine = state.entries.find((e) => e.entrantId === state.uid);
    if (mine && !state.selected.length) state.selected = mine.picks.map((p) => Number(p.id));
    render();
  }, (err) => setStatus(`Could not read entries: ${err.message}`, "error"));
}

function allEntries() {
  return state.mockEntries.length ? [...state.entries, ...state.mockEntries] : state.entries;
}

function rng(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Test mode only: predictions as if players in tonight's field had each picked
 * 5 rivals before the clock started. Page-local, never written to Firestore,
 * seeded from the tournament id so a given game always looks the same.
 */
function buildLiveMocks() {
  if (state.mockEntries.length) return;
  const roster = active()?.players ?? [];
  if (roster.length < 8) return;
  const r = rng(Number(state.activeId) * 7919 + 13);
  const labels = roster.map((p) => p.nickname || p.name).filter(Boolean);
  for (let i = labels.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [labels[i], labels[j]] = [labels[j], labels[i]];
  }
  const count = Math.min(12, Math.max(6, Math.floor(roster.length / 2)));
  const out = [];
  for (let i = 0; i < count; i++) {
    const picks = []; const taken = new Set();
    while (picks.length < 5) {
      const p = roster[Math.floor(r() * roster.length)];
      if (taken.has(p.id)) continue;
      taken.add(p.id); picks.push({ id: p.id, name: p.name });
    }
    out.push({ entrantId: `mock-${state.activeId}-${i}`, name: labels[i] ?? `Entrant ${i + 1}`, picks, demo: true });
  }
  state.mockEntries = out;
}

async function submitPicks() {
  const roster = (active()?.players ?? []).filter(isAlive);
  const picks = state.selected
    .map((id) => roster.find((p) => Number(p.id) === id))
    .filter(Boolean)
    .map((p) => ({ id: Number(p.id), name: String(p.name) }));
  if (picks.length !== SCORING.picksRequired) {
    $("#draft-error").textContent = `Pick exactly ${SCORING.picksRequired} players.`; return;
  }
  const names = picks.map((p) => p.name).join(", ");
  if (!confirm(`Submit these ${picks.length} picks?\n\n${names}\n\nPicks are final. You cannot change them afterwards.`)) {
    return;
  }
  try {
    // Guarantee the contest document exists first. Entries are refused unless
    // it does, and that refusal is indistinguishable from the clock having
    // started, so without this a first entrant could be told picks were closed
    // on a game that had not begun.
    await syncContest();
    await setDoc(doc(db, "contests", String(state.contestId), "entries", state.uid),
      { name: state.name, picks, submittedAt: serverTimestamp() });
    $("#draft-error").textContent = "";
    setStatus("Picks locked in. Good luck.");
    showView("standings");
  } catch (e) {
    $("#draft-error").textContent = e.code === "permission-denied"
      ? "Picks are closed, the clock has started." : e.message;
  }
}
$("#submit-picks").addEventListener("click", submitPicks);
$("#clear-picks").addEventListener("click", () => { state.selected = []; render(); });
$("#pool-filter").addEventListener("input", (e) => { state.poolFilter = e.target.value; renderDraft(); });

// ---------------------------------------------------------------- render
function render() {
  try {
    if (state.view === "home") renderHome();
    if (state.view === "standings") renderTournament();
    if (state.view === "draft") renderDraft();
  } catch (e) {
    // Without this a mid-render throw leaves parts of the page frozen at
    // whatever they last showed, with nothing on screen to say why.
    console.error("render failed:", e);
    setStatus(`Display error: ${e.message}`, "error");
  }
}

/** "Limerick Junction - 10/21/2026" -> "Limerick Junction" */
function cleanTitle(s) {
  return String(s ?? "").replace(/\s*[-–]\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/, "").trim();
}

/**
 * Tournament start time. MySQL TIME reaches us in three shapes depending on how
 * the row was read: a bare "20:00:00", a UTC instant on the epoch day
 * ("1970-01-01T20:00:00.000Z"), or a local Date string
 * ("Thu Jan 01 1970 20:00:00 GMT-0500"). The last is what production sends, and
 * slicing it blindly produced "Thu J" on the cards.
 */
function fmtTime(v) {
  if (!v) return "";
  const s = String(v).trim();
  let h = null, m = null;

  if (/^\d{1,2}:\d{2}/.test(s)) {                 // bare clock time
    const [hh, mm] = s.split(":");
    h = Number(hh); m = Number(mm);
  } else if (/Z$|[+-]\d{2}:?\d{2}$/.test(s) && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);                          // epoch-day instant, read as UTC
    if (!isNaN(d)) { h = d.getUTCHours(); m = d.getUTCMinutes(); }
  } else {
    const d = new Date(s);                          // local Date string
    if (!isNaN(d)) { h = d.getHours(); m = d.getMinutes(); }
  }

  if (h == null || m == null || isNaN(h) || isNaN(m)) return "";
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt) ? "" : dt.toLocaleDateString(undefined,
    { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}
function levelLabel(c) {
  const lvl = c.timer?.currentLevel ?? c.tournament?.timer_current_level;
  if (!lvl) return "";
  return `Level ${lvl} (Standard)`;
}
function checkedIn(c) { return c.players.filter((p) => p.checked_in_at).length; }
function remaining(c) { return c.players.filter(isAlive).length; }

function renderHome() {
  const ids = state.follow;
  const nodes = ids.map((id) => {
    const c = card(id);
    const t = c.tournament;
    const title = t?.title || t?.venue || `Tournament ${id}`;
    return `<button class="card" data-id="${id}">
      <div class="card-top">
        <div class="card-title"><span>${esc(cleanTitle(title))}</span><span>→</span></div>
      </div>
      <div class="card-body">
        <div class="row"><span class="ico">🗓</span><span>${esc(fmtDate(t?.date))}${
          fmtTime(t?.time) ? ` <strong style="color:var(--cyan)">@ ${esc(fmtTime(t.time))}</strong>` : ""}</span></div>
        <div class="row"><span class="ico">📍</span><span>${esc(t?.venue ?? "")}</span></div>
        <div class="twocol">
          <div class="statbox"><div class="k">Checked In</div><div class="v">${checkedIn(c)}</div></div>
          <div class="statbox green"><div class="k">Remaining</div><div class="v">${remaining(c)}</div></div>
        </div>
        <div class="row"><span class="ico">⏱</span><span>${esc(levelLabel(c)) || "Waiting for clock"}</span></div>
        <div class="card-foot">TD: ${esc(t?.td ?? "—")}</div>
      </div>
    </button>`;
  });
  $("#home-cards").innerHTML = nodes.join("");
  // "Looking for games" and "there are none" are different things to say.
  $("#home-empty").hidden = ids.length > 0 || state.discovering;
  const searching = $("#home-searching");
  if (searching) searching.hidden = ids.length > 0 || !state.discovering;
  $("#home-cards").querySelectorAll(".card").forEach((b) =>
    b.addEventListener("click", () => openTournament(Number(b.dataset.id))));
}

function clockText(c) {
  const t = c.timer;
  if (!t || typeof t.timeRemaining !== "number") return { text: "--:--", paused: true };
  let secs = t.timeRemaining;
  if (t.isRunning && !t.isPaused) {
    secs -= Math.floor((Date.now() - (t.receivedAt ?? Date.now())) / 1000);
  }
  secs = Math.max(0, secs);
  const m = Math.floor(secs / 60), s = secs % 60;
  return { text: `${m}:${String(s).padStart(2, "0")}`, paused: !t.isRunning || t.isPaused };
}

/** Only the clock block. Called every second, so it must not rebuild inputs. */
function renderClock() {
  const c = active();
  const node = $("#t-timer");
  if (!c || !node) return;
  const ck = clockText(c);
  const blind = c.timer?.blindLevels?.[(c.timer?.currentLevel ?? 1) - 1];
  node.innerHTML = `
    <div class="clock ${ck.paused ? "paused" : ""}">${ck.text}</div>
    <div class="lvl">${esc(levelLabel(c) || "Clock not started")}</div>
    ${blind ? `<div class="blinds">${blind.isbreak ? "BREAK" :
       `${Number(blind.smallBlind).toLocaleString()} / ${Number(blind.bigBlind).toLocaleString()}`}</div>` : ""}
    <div class="note">${c.timer?.isPaused ? "Paused by the TD" :
       c.timer?.isRunning ? "Running" : "Waiting for the TD to start the clock"}</div>`;
}

function renderTournament() {
  const c = active();
  if (!c) return;
  // Idempotent: openTournament() clears the synthetic entries, and the next
  // socket event may be minutes away, so rebuild here as well.
  if (TEST_MODE) buildLiveMocks();
  const t = c.tournament;
  const players = c.players;
  $("#t-head").innerHTML =
    `<h1 class="t-title">${esc(cleanTitle(t?.title) || t?.venue || `Tournament ${state.activeId}`)}</h1>`;

  $("#t-meta").innerHTML = `
    <div class="left-big"><span class="n">${remaining(c)}</span>
      <span class="of">of ${players.length} left</span></div>
    <div class="td">TD ${esc(t?.td ?? "")}</div>
    <button id="whos-left" class="link">${state.showLeft ? "hide" : "who\u2019s left?"}</button>
    ${state.showLeft ? `<div class="leftlist">${
      players.filter(isAlive)
        .map((p) => `<span class="lchip">${esc(p.nickname || p.name)}</span>`)
        .join("") || `<span class="muted">Nobody left.</span>`}</div>` : ""}`;
  $("#whos-left").addEventListener("click", () => {
    state.showLeft = !state.showLeft;
    renderTournament();
  });

  renderClock();

  // Knockouts, most recent first.
  const out = players.filter((p) => !isAlive(p))
    .sort((a, b) => (b.elimination_position ?? 0) - (a.elimination_position ?? 0));
  $("#ko-feed").innerHTML = out.length ? out.map((p) => {
    const place = players.length - (Number(p.elimination_position) || 0) + 1;
    const when = timeAgo(p.knockedout_at ?? p.eliminated_at);
    return `<div class="feed-item out">
      <div class="ko-main">
        <span class="who">${esc(p.nickname || p.name)}</span>
        ${p.hitman_name
          ? `<span class="by">KO'd by <span class="hit">${esc(p.hitman_name)}</span></span>`
          : `<span class="by">KO'd</span>`}
      </div>
      <div class="ko-meta">
        ${when ? `<span class="when">${esc(when)}</span>` : ""}
        <span class="placetag">${place}${ordinal(place)} place</span>
      </div>
    </div>`;
  }).join("") : `<p class="muted">Nobody out yet.</p>`;

  // Build the filter input once; rebuilding it would drop focus mid-typing.
  if (!$("#st-filter")) {
    $("#standings-filter").innerHTML =
      `<input id="st-filter" class="bigfield" type="text" placeholder="Filter by entrant name..." />`;
    $("#st-filter").addEventListener("input", (e) => {
      state.filter = e.target.value;
      renderStandingsTable(active()?.players ?? []);
    });
  }

  renderStandingsTable(players);
}

function renderStandingsTable(players) {
  const entries = allEntries();
  if (!entries.length) {
    $("#standings-table").innerHTML = `<p class="muted">No entries yet. Be the first to pick 5 players.</p>`;
    return;
  }
  let rows = computeStandings(players, entries);
  if (state.filter) {
    const f = state.filter.toLowerCase();
    rows = rows.filter((r) => String(r.name).toLowerCase().includes(f));
  }
  $("#standings-table").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Entrant</th><th>Points</th><th>Alive</th><th>Draft</th></tr></thead><tbody>
    ${rows.map((r) => `
      <tr class="${r.entrantId === state.uid ? "me " : ""}${seasonPointsForRank(r.rank) ? "paid" : ""}${
        r.rank === 8 ? " cutoff" : ""}" data-id="${r.entrantId}">
        <td>${r.rank}</td>
        <td>${esc(r.name)}</td>
        <td><strong>${r.score.totalPoints}</strong></td>
        <td class="${r.score.picksAlive ? "alive-yes" : "alive-no"}">${r.score.picksAlive}/${SCORING.picksRequired}</td>
        <td><button class="draftbtn" data-id="${r.entrantId}">${
          state.expanded.has(r.entrantId) ? "Hide ▾" : "View ▸"}</button></td>
      </tr>
      ${state.expanded.has(r.entrantId) ? `<tr class="detail"><td colspan="5">
        <table class="subtable"><thead><tr><th>Player</th><th>Status</th><th>Points now</th></tr></thead>
        <tbody>${[...r.score.picks].sort((a, b) => b.currentPoints - a.currentPoints)
          .map((p) => `<tr class="${p.alive ? "" : "dim"}">
            <td>${esc(p.name)}</td>
            <td>${p.alive
              ? `<span class="alive-yes">still in</span>`
              : `<span class="muted">finished</span> <span class="place">#${p.finishedPlace}</span>`}</td>
            <td><strong>${p.currentPoints}</strong></td></tr>`).join("")}
          <tr class="sum total"><td>Projected total</td>
            <td>${r.score.projectionBonus > 0
              ? `<button class="mathbtn" data-id="${r.entrantId}">why? ${state.math.has(r.entrantId) ? "▾" : "▸"}</button>`
              : ""}</td>
            <td><strong>${r.score.totalPoints}</strong></td></tr>
        </tbody></table>
        ${state.math.has(r.entrantId) ? mathPanel(r.score) : ""}
      </td></tr>` : ""}
        `).join("")}</tbody></table></div>`;
  $("#standings-table").querySelectorAll("button.mathbtn").forEach((b) =>
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (state.math.has(b.dataset.id)) state.math.delete(b.dataset.id);
      else state.math.add(b.dataset.id);
      renderStandingsTable(players);
    }));
  $("#standings-table").querySelectorAll("button.draftbtn").forEach((b) =>
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // Opening one draft must not close the others.
      if (state.expanded.has(b.dataset.id)) state.expanded.delete(b.dataset.id);
      else state.expanded.add(b.dataset.id);
      renderStandingsTable(players);
    }));
}

/** The projection, explained in plain sentences. */
function mathPanel(score) {
  const alive = score.picks.filter((p) => p.alive);
  if (!alive.length) return "";
  const k = alive.length;
  const bubble = score.bubbleValue;
  const places = alive.map((p) => `${p.effectivePlace}${ordinal(p.effectivePlace)}`);
  const vals = alive.map((p) => p.projectedPoints);
  const sum = Math.round(vals.reduce((s, v) => s + v, 0) * 10) / 10;
  const flat = Math.round(k * bubble * 10) / 10;
  const spelled = ["", "one", "two", "three", "four", "five"][k] ?? String(k);
  const placeList = places.length > 1
    ? `${places.slice(0, -1).join(", ")} and ${places[places.length - 1]}`
    : places[0];

  return `<div class="mathpanel">
    <p>${k === 1 ? "One of your picks is" : `${cap(spelled)} of your picks are`} still in.
    With <strong>${score.playersAlive} players left</strong>, the next person out
    finishes ${score.playersAlive}${ordinal(score.playersAlive)}, which pays
    <strong>${bubble}</strong>, so that is what
    ${k === 1 ? "it is" : "each of them is"} worth right now.</p>

    ${k > 1 ? `<p>But they cannot all finish in the same place. If they were the
    next ${spelled} out, they would take ${placeList}, paying
    <strong>${sum}</strong> between them rather than ${k} × ${bubble} =
    <strong>${flat}</strong>.</p>` : ""}

    <p>Your projected total already counts that extra
    <strong>${score.projectionBonus}</strong>. It is the least you can finish on,
    and the longer your picks last the more they pay.</p>
  </div>`;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/** "3m ago" / "1h 12m ago", matching the dashboard's knockout feed. */
function timeAgo(ts) {
  if (!ts) return "";
  const then = new Date(ts).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m ago` : `${h}h ago`;
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function renderDraft() {
  const c = active();
  if (!c) return;
  const t = c.tournament;
  $("#draft-head").innerHTML = `<h1 class="glow">Make your picks</h1>
    <p class="muted">${esc(cleanTitle(t?.title) || t?.venue || "")} · pick ${SCORING.picksRequired} players</p>`;

  const locked = !TEST_MODE && Boolean(t?.game_started);
  $("#draft-locked").hidden = !locked;

  // Picks are final. Once an entry is in, show it read-only. Test contests stay
  // editable so a live game can be used for dry runs.
  const mine = state.entries.find((e) => e.entrantId === state.uid);
  const final = Boolean(mine) && !TEST_MODE;
  $("#draft-done").hidden = !final;
  if (final) {
    $("#draft-done").innerHTML = `<h3>Your picks are in</h3>
      <ol>${mine.picks.map((p) => `<li>${esc(p.name)}</li>`).join("")}</ol>
      <p class="muted" style="margin:10px 0 0">These are final. Follow them on the standings page.</p>`;
  }
  $("#draft-body").hidden = locked || final;
  if (locked || final) return;

  const pool = c.players.filter(isAlive);
  const f = state.poolFilter.trim().toLowerCase();
  const shown = f ? pool.filter((p) => String(p.name).toLowerCase().includes(f)
    || String(p.nickname ?? "").toLowerCase().includes(f)) : pool;

  $("#pick-count").textContent = `Your picks: ${state.selected.length} / ${SCORING.picksRequired}`;
  $("#chips").innerHTML = state.selected.length
    ? state.selected.map((id, i) => {
        const p = pool.find((x) => Number(x.id) === id);
        return p ? `<span class="chip" data-id="${id}"><span class="ord">${i + 1}</span>${esc(p.nickname || p.name)} ✕</span>` : "";
      }).join("")
    : `<span class="muted">Nobody picked yet, choose ${SCORING.picksRequired} from the field.</span>`;

  $("#pool-count").textContent = `${shown.length} of ${pool.length} players still in`;
  $("#pool").innerHTML = shown.map((p) => {
    const on = state.selected.includes(Number(p.id));
    const full = state.selected.length >= SCORING.picksRequired && !on;
    return `<button data-id="${p.id}" aria-pressed="${on}" ${full ? "disabled" : ""}>
      <span>${esc(p.nickname ? `${p.nickname} (${p.name})` : p.name)}</span><span>${on ? "✓" : ""}</span></button>`;
  }).join("") || `<p class="muted">No players checked in yet.</p>`;

  // Full field list, including players already out.
  $("#roster").innerHTML = c.players.map((p) => {
    const alive = isAlive(p);
    const place = alive ? null : c.players.length - (Number(p.elimination_position) || 0) + 1;
    return `<div class="feed-item ${alive ? "" : "out"}">
      <span class="who">${esc(p.nickname || p.name)}</span>
      ${alive ? `<span class="alive-yes"> · in</span>` : `<span class="place"> · #${place}</span>`}
    </div>`;
  }).join("") || `<p class="muted">Waiting for the roster…</p>`;

  $("#submit-picks").disabled = state.selected.length !== SCORING.picksRequired;
  $("#submit-picks").textContent =
    state.entries.some((e) => e.entrantId === state.uid) ? "Update my picks" : "Submit my picks";

  $("#pool").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => toggle(Number(b.dataset.id))));
  $("#chips").querySelectorAll(".chip").forEach((ch) =>
    ch.addEventListener("click", () => toggle(Number(ch.dataset.id))));
}

function toggle(id) {
  const i = state.selected.indexOf(id);
  if (i >= 0) state.selected.splice(i, 1);
  else if (state.selected.length < SCORING.picksRequired) state.selected.push(id);
  renderDraft();
}

// ---------------------------------------------------------------- rules
/**
 * The explainer. Everything here is generated from the live constants in
 * scoring.js, so it cannot drift away from what the app actually computes.
 */
function renderRules() {
  const N = active()?.players?.length || 30;
  const picks = SCORING.picksRequired;
  const sample = [1, 2, 3, 5, Math.round(N / 3), Math.round(N / 2), N]
    .filter((p, i, arr) => p >= 1 && p <= N && arr.indexOf(p) === i)
    .sort((a, b) => a - b);

  $("#rules-body").innerHTML = `
    <h2 class="section">What this is</h2>
    <p>A fantasy draft for Freeroll Atlanta tournaments. Before a game starts you
    pick <strong>${picks} players</strong> from the field. As the tournament runs,
    your picks earn points for how deep they go. The deeper they run, the more you
    score.</p>

    <h2 class="section">Making picks</h2>
    <ul>
      <li>Pick exactly <strong>${picks}</strong> players from those still in the field.</li>
      <li><strong>Anyone can pick the same player.</strong> There is no draft order
      and nobody gets locked out of a popular name.</li>
      <li><strong>Picks close when the TD starts the clock.</strong> Once cards are
      in the air, nobody can enter, otherwise someone who already won a few hands
      would be picked with a chip stack advantage.</li>
      <li><strong>Picks are final.</strong> Once submitted they cannot be changed.</li>
      <li>One entry per person per game.</li>
    </ul>

    <h2 class="section">How a pick scores</h2>
    <p>A pick's points depend on <strong>what fraction of the field it beat</strong>,
    not on raw place. That way a 12 player Tuesday and a 60 player Wednesday are
    scored on the same curve.</p>
    <p class="formula">points = ${SCORING.maxFinishPoints} × (players beaten ÷ (field − 1))
      <sup>${SCORING.gamma}</sup></p>
    <p>The cube is what makes a deep run pay. Finishing in the top few is worth far
    more than drifting out mid pack. In a ${N} player field:</p>
    <div class="table-wrap"><table><thead><tr>
      <th>Finish</th>${sample.map((p) => `<th>${p}${ordinal(p)}</th>`).join("")}
    </tr></thead><tbody><tr>
      <td>Points</td>${sample.map((p) =>
        `<td><strong>${Math.round(finishPoints(p, N) * 10) / 10}</strong></td>`).join("")}
    </tr></tbody></table></div>

    <h2 class="section">Why your score climbs during a game</h2>
    <p>A player still in the tournament is scored at the place they would take if
    they busted on the very next hand, so as the field shrinks every surviving pick
    is worth more. Every survivor shows the <strong>same</strong> figure, because
    they are all in the same position.</p>
    <p>Your <strong>projected total</strong> exceeds the sum of those figures.
    Survivors cannot all finish in the same place, so if they were eliminated one
    after another they would occupy different places, and the total credits them
    accordingly. Select <span class="mathbtn">why?</span> on any entry for the
    full calculation. The projection is a floor: picks can finish higher than it,
    never lower.</p>

    <h2 class="section">The season</h2>
    <p>Two separate scores are kept. The <strong>points</strong> earned in a game
    determine the order of that night's standings and nothing further. Only your
    <strong>finishing position</strong> carries into the season, and it is
    rewarded according to the following schedule:</p>
    <div class="table-wrap"><table><thead><tr>
      <th>Place</th>${SEASON_POINTS.map((_, i) => `<th>${i + 1}${ordinal(i + 1)}</th>`).join("")}
      <th>${SEASON_POINTS.length + 1}${ordinal(SEASON_POINTS.length + 1)}+</th>
    </tr></thead><tbody><tr>
      <td>Season points</td>${SEASON_POINTS.map((v) => `<td><strong>${v}</strong></td>`).join("")}
      <td>0</td>
    </tr></tbody></table></div>
    <p>A game awards at most <strong>${Math.max(...SEASON_POINTS)}</strong> season
    points regardless of its size. Scoring 400 points in a game and winning it
    earns the same ${Math.max(...SEASON_POINTS)} as scoring 90 and winning it. The
    season runs for one month and the highest total wins. The top
    <strong>${SEASON_POINTS.length}</strong> positions in each game are highlighted
    in the standings.</p>

    <h2 class="section">Your account</h2>
    <p>Your account is linked to this device. Your name, entries and season points
    are retained and restored each time you return to this page. Names must be
    unique, so no two entrants may share one. Opening the page on another browser
    or device creates a separate account, and clearing your browser data
    establishes a new one.</p>`;
}

// ---------------------------------------------------------------- finished
/**
 * Every contest that has a frozen final roster, with its full standings and the
 * season points it paid out. Scored from `results/final`, so no socket needed.
 */
/**
 * Load every contest in ONE query.
 *
 * Each card used to cost two further reads — its entries subcollection and its
 * frozen roster. Past about forty archived games that is ninety round trips,
 * which wedged the Firestore channel in Safari and left this tab showing
 * "Could not reach the database". The scheduled archiver now precomputes what
 * these views display and stores it on the contest document as `summary`, so
 * one query is enough. A finished game's standings never change, so there is
 * nothing to recompute here.
 */
/** Decode one Firestore REST typed value into a plain JS value. */
function fromRest(v) {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromRest);
  if ("mapValue" in v) return restFields(v.mapValue.fields);
  return null;
}

function restFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) out[k] = fromRest(v);
  return out;
}

/**
 * One-shot Firestore REST read.
 *
 * Every document these views touch is world-readable (firestore.rules:
 * `allow read: if true`), so this needs no auth and no streaming channel. That
 * is the point: the SDK talks over a long-lived WebChannel, and when that
 * channel stalls in Safari an ordinary list read hangs with it, which is what
 * produced "Could not reach the database" on this tab. A plain fetch cannot get
 * stuck behind it. Measured against the live project: the whole contest list,
 * 69 documents, in under 300 ms.
 */
async function restGet(path, ms = 9000) {
  if (typeof AbortController === "undefined") return null;
  if (!state.projectId && configReady) await withTimeout(configReady, 6000);
  if (!state.projectId) return null;
  const ctrl = new AbortController();
  const giveUp = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${state.projectId}` +
      `/databases/(default)/documents/${path}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(giveUp);
  }
}

async function fetchContestsRest() {
  const docs = [];
  let token = "";
  for (let page = 0; page < 10; page++) {
    const body = await restGet(`contests?pageSize=300${token}`);
    if (!body) return null;
    docs.push(...(body.documents ?? []));
    if (!body.nextPageToken) break;
    token = `&pageToken=${encodeURIComponent(body.nextPageToken)}`;
  }
  return docs.map((d) => {
    const meta = restFields(d.fields);
    return { id: d.name.split("/").pop(), meta, summary: meta.summary ?? null };
  });
}

/**
 * Rebuild a missing summary from the frozen roster, in the page.
 *
 * The scheduled archiver normally writes it, but it can be behind, or running
 * an older revision. A finished game should not be invisible because of that.
 * Bounded to the newest few so a long outage cannot turn this into a fan-out.
 */
const REBUILD_LIMIT = 12;

async function rebuildMissingSummaries(rows) {
  const missing = rows
    .filter((x) => !x.summary && x.id !== DEMO_ID && x.meta.tournamentId != null)
    .sort((p, q) => String(q.meta.date ?? "").localeCompare(String(p.meta.date ?? "")))
    .slice(0, REBUILD_LIMIT);
  if (!missing.length) return;

  await Promise.all(missing.map(async (x) => {
    const [finalDoc, entriesDoc] = await Promise.all([
      restGet(`contests/${encodeURIComponent(x.id)}/results/final`),
      restGet(`contests/${encodeURIComponent(x.id)}/entries?pageSize=300`),
    ]);
    const players = finalDoc && finalDoc.fields ? restFields(finalDoc.fields).players : null;
    if (!Array.isArray(players) || !players.length) return;   // still running
    const entries = ((entriesDoc && entriesDoc.documents) ?? []).map((d) => ({
      entrantId: d.name.split("/").pop(), ...restFields(d.fields),
    }));
    x.summary = buildSummary(players, entries);
    if (x.meta.fieldSize == null) x.meta.fieldSize = players.length;
  }));
}

async function loadSummaries() {
  let rows = await fetchContestsRest();
  if (rows) await rebuildMissingSummaries(rows);

  if (!rows) {
    // Fallback: the SDK. Slower to get going, but it is already authenticated
    // and works if a content blocker objects to the bare REST endpoint.
    if (!db) await withTimeout(dbReady, 15000);
    if (!db) return null;
    const all = await withTimeout(getDocs(collection(db, "contests")), 12000);
    if (!all) return null;
    rows = all.docs.map((c) => ({ id: c.id, meta: c.data(), summary: c.data().summary ?? null }));
  }

  return rows
    .filter((x) => x.id !== DEMO_ID)
    // Drop the "test-<id>" dry runs. While TEST_MODE was on, entries were
    // written to those instead of the real contest, so every one of those games
    // appeared on this tab twice: the real contest saying nobody entered, and
    // its twin holding the picks. They are left in the database but never
    // shown, which also keeps the dry-run entries out of the season table.
    .filter((x) => !String(x.id).startsWith("test-"))
    .filter((x) => x.summary);
}

async function renderFinished() {
  const node = $("#finished-list");
  node.innerHTML = `<p class="muted">Loading\u2026</p>`;
  try {
    const loaded = await loadSummaries();
    if (!loaded) {
      node.innerHTML = `<p class="error">Could not reach the database. Check your
        connection and reload.</p>`;
      return;
    }
    if (!loaded.length) {
      node.innerHTML = `<p class="muted">No finished games yet. Games are archived
        automatically, usually within a few hours of ending.</p>`;
      return;
    }

    loaded.sort((p, q) =>
      String(q.meta.date ?? "").localeCompare(String(p.meta.date ?? "")));
    const total = loaded.length;
    const done = loaded.slice(0, FINISHED_LIMIT);

    node.innerHTML = done.map((d) => {
      const m = d.meta, s = d.summary;
      const rows = s.standings ?? [];
      const open = state.finishedOpen === d.id;
      return `<div class="fcard">
        <div class="fcard-top">
          <div>
            <div class="fcard-title">${esc(cleanTitle(m.title) || m.venue || `Tournament ${m.tournamentId ?? d.id}`)}</div>
            <div class="t-meta">
              ${m.date ? `<span>${esc(fmtDate(m.date))}</span>` : ""}
              ${m.venue ? `<span>${esc(m.venue)}</span>` : ""}
              ${m.td ? `<span>TD ${esc(m.td)}</span>` : ""}
              <span><strong>${m.fieldSize ?? "?"}</strong> players</span>
              <span><strong>${s.entryCount ?? rows.length}</strong> entries</span>
            </div>
          </div>
          ${rows.length ? `<button class="draftbtn" data-fid="${d.id}">${open ? "Hide" : "Standings"}</button>` : ""}
        </div>
        <div class="fcard-body">
          <div class="row"><span class="ico">&#127942;</span><span>Tournament won by
            <strong>${esc(s.champion || "?")}</strong></span></div>
          ${rows[0] ? `<div class="row"><span class="ico">&#129351;</span><span>Fantasy winner
            <strong>${esc(rows[0].name)}</strong> with
            <strong>${rows[0].totalPoints}</strong> points for
            <strong>${rows[0].seasonPoints}</strong> season points</span></div>`
            : `<div class="row"><span class="muted">Nobody entered this game.</span></div>`}
        </div>
        ${open && rows.length ? `<div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Entrant</th><th>Points</th><th>Their picks</th><th>Season</th></tr></thead>
          <tbody>${rows.map((r) => `<tr class="${r.entrantId === state.uid ? "me " : ""}${
            r.seasonPoints ? "paid" : ""}">
            <td>${r.rank}</td><td>${esc(r.name)}</td>
            <td><strong>${r.totalPoints}</strong></td>
            <td class="picksum">${(r.picks ?? []).map((p) =>
              `${esc(p.name)} <span class="place">#${p.place ?? "?"}</span>`).join(" \u00b7 ")}</td>
            <td class="season">${r.seasonPoints || "0"}</td></tr>`).join("")}
          </tbody></table></div>` : ""}
      </div>`;
    }).join("");

    if (total > FINISHED_LIMIT) {
      node.insertAdjacentHTML("beforeend",
        `<p class="muted">Showing the ${FINISHED_LIMIT} most recent of ${total} games.</p>`);
    }

    node.querySelectorAll("button[data-fid]").forEach((b) =>
      b.addEventListener("click", () => {
        state.finishedOpen = state.finishedOpen === b.dataset.fid ? null : b.dataset.fid;
        renderFinished();
      }));
  } catch (e) {
    node.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

async function renderSeason() {
  const node = $("#season-table");
  node.innerHTML = `<p class="muted">Loading\u2026</p>`;
  try {
    const loaded = await loadSummaries();
    if (!loaded) {
      node.innerHTML = `<p class="error">Could not reach the database. Check your
        connection and reload.</p>`;
      return;
    }

    // Season points come from PLACING in a game, not from the raw score, so
    // every game is worth the same however big its field was.
    const totals = new Map();
    let counted = 0;
    for (const x of loaded) {
      const rows = x.summary.standings ?? [];
      if (!rows.length) continue;
      counted++;
      for (const r of rows) {
        const prev = totals.get(r.entrantId)
          ?? { name: r.name, points: 0, contests: 0, best: null };
        prev.name = r.name;
        prev.points += r.seasonPoints || 0;
        prev.contests += 1;
        prev.best = prev.best == null ? r.rank : Math.min(prev.best, r.rank);
        totals.set(r.entrantId, prev);
      }
    }

    if (!totals.size) {
      node.innerHTML = `<p class="muted">Nobody has entered a contest yet. The
        season table fills in once players start making picks.</p>`;
      return;
    }

    const rows = [...totals.entries()]
      .map(([entrantId, v]) => ({ entrantId, ...v }))
      .sort((p, q) => q.points - p.points || p.best - q.best ||
        String(p.name).localeCompare(String(q.name)))
      .map((r, i) => ({ ...r, rank: i + 1 }));

    node.innerHTML = `<p class="muted">${counted} game${counted === 1 ? "" : "s"} counted.</p>
      <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Entrant</th><th>Season points</th><th>Games</th><th>Best finish</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.entrantId === state.uid ? "me " : ""}${
        r.rank <= 8 ? "paid" : ""}">
        <td>${r.rank}</td><td>${esc(r.name)}</td>
        <td><strong>${r.points}</strong></td>
        <td>${r.contests}</td>
        <td>${r.best ? ordinal(r.best) : "\u2014"}</td></tr>`).join("")}
      </tbody></table></div>`;
  } catch (e) {
    node.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

async function bootDemo() {
  state.demo = true;
  state.activeId = DEMO_ID;
  state.contestId = DEMO_ID;
  state.follow = [DEMO_ID];
  const res = await fetch("/demo.json", { cache: "no-store" });
  if (!res.ok) { setStatus("Could not load demo.json", "error"); return; }
  const data = await res.json();
  state.demoSeed = data;
  const c = card(DEMO_ID);
  c.tournament = { ...data.tournament, date: new Date().toISOString(), time: "20:00" };
  c.players = data.players.map((p) => ({ ...p }));
  c.timer = withClientClock({ currentLevel: 3, timeRemaining: 900, isRunning: true, isPaused: false });
  buildDemoEntries();
  c.tournament.game_started = true;
  demoAdvance(42, rng(DEMO_SEED + 1));
  try {
    await setDoc(doc(db, "contests", DEMO_ID),
      { tournamentId: DEMO_ID, gameStarted: false, title: "Demo", updatedAt: serverTimestamp() },
      { merge: true });
  } catch (_) {}
  $("#demo-bar").hidden = false;
  wireDemo();
  watchEntries();
  showView("standings");
  renderDemoState();
}

function buildDemoEntries() {
  const roster = card(DEMO_ID).players;
  const r = rng(DEMO_SEED);
  const labels = roster.map((p) => p.nickname || p.name).filter(Boolean);
  for (let i = labels.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [labels[i], labels[j]] = [labels[j], labels[i]];
  }
  const out = [];
  for (let i = 0; i < 12; i++) {
    const picks = []; const taken = new Set();
    while (picks.length < 5) {
      const p = roster[Math.floor(r() * roster.length)];
      if (taken.has(p.id)) continue;
      taken.add(p.id); picks.push({ id: p.id, name: p.name });
    }
    out.push({ entrantId: `demo-entrant-${i}`, name: labels[i] ?? `Entrant ${i + 1}`, picks, demo: true });
  }
  state.mockEntries = out;
}

function demoAdvance(n, r) {
  const c = card(DEMO_ID);
  for (let k = 0; k < n; k++) {
    const alive = c.players.filter(isAlive);
    if (alive.length <= 1) break;
    const victim = alive[Math.floor(r() * alive.length)];
    const others = alive.filter((p) => p.id !== victim.id);
    const hitman = others[Math.floor(r() * others.length)];
    victim.is_active = false;
    // Match the live feed: elimination_position is bust order (1 = first out).
    victim.elimination_position = c.players.length - alive.length + 1;
    victim.placement = null;
    victim.hitman_name = hitman ? hitman.name : null;
  }
}

function renderDemoState() {
  const c = card(DEMO_ID);
  $("#demo-state").textContent = `${remaining(c)} of ${c.players.length} still in`;
}

function wireDemo() {
  $("#demo-start").addEventListener("click", () => {
    card(DEMO_ID).tournament.game_started = true; renderDemoState(); render();
  });
  $("#demo-bust").addEventListener("click", () => { demoAdvance(1, Math.random); renderDemoState(); render(); });
  $("#demo-bust10").addEventListener("click", () => { demoAdvance(10, Math.random); renderDemoState(); render(); });
  $("#demo-reset").addEventListener("click", () => {
    const c = card(DEMO_ID);
    c.tournament = { ...state.demoSeed.tournament, date: new Date().toISOString(), time: "20:00" };
    c.players = state.demoSeed.players.map((p) => ({ ...p }));
    state.selected = [];
    renderDemoState(); showView("draft");
  });
}

// ---------------------------------------------------------------- start
setInterval(() => { if (state.view === "standings") renderClock(); }, 1000);

/**
 * Draw something on the first frame, then do the slow work in parallel.
 *
 * This used to be strictly sequential: config fetch, then sign-in, then the
 * entrant document, and only then was any view unhidden. Every one of those is
 * a network round trip, and the page was blank for all of them. Now the cached
 * name decides what to draw immediately, the tournament search starts at once
 * over its own socket (it needs nothing from Firebase), and Firebase sign-in
 * runs alongside instead of in front.
 */
(async function start() {
  let resolveDbReady;
  dbReady = new Promise((r) => { resolveDbReady = r; });

  const me = cachedMe();
  if (me) {
    state.name = me.name;
    el.whoami.textContent = `Playing as ${me.name}`;
  }
  showView(me ? "home" : "name");

  // Discovery talks to openbarleague.com, not to Firebase, so it need not wait
  // for sign-in. A returning visitor sees tonight's games while auth is still
  // in flight. A new one is typing their name during the same window.
  const discovery = me ? boot() : Promise.resolve();

  // Config fetch and SDK download run together; neither blocks the first paint.
  // The config lands first and is published immediately, so the REST reads on
  // the Finished and Season tabs do not have to wait for the 170 KB of SDK.
  configReady = resolveConfig();
  configReady.then((c) => { if (c) state.projectId = c.projectId ?? null; });
  const [cfg] = await Promise.all([configReady, loadFirebaseSdk()]);
  if (!cfg) {
    setStatus("Firebase config not found. Deploy with Firebase Hosting, or fill in public/config.js.", "error");
    return;
  }
  app = initializeApp(cfg);
  auth = getAuth(app);
  db = getFirestore(app);
  resolveDbReady();
  onAuthStateChanged(auth, handleAuth);

  await discovery;
})();
