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

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, onSnapshot,
  getDocs, query, where, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  firebaseConfig, FREEROLL_ORIGIN, FOLLOW_TOURNAMENT_IDS, TEST_MODE,
} from "/config.js";
import { SCORING, SEASON_POINTS, scoreEntry, isAlive, finishPoints, seasonPointsForRank }
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
    if (!["home", "season", "finished", "rules"].includes(t.dataset.view) && state.activeId == null) {
      return showView("home");
    }
    showView(t.dataset.view);
  }));

$("#brand").addEventListener("click", () => showView(state.name ? "home" : "name"));

// ---------------------------------------------------------------- identity
async function handleAuth(user) {
  if (!user) {
    try { await signInAnonymously(auth); }
    catch (e) { setStatus(`Could not start a session: ${e.message}`, "error"); }
    return;
  }
  state.uid = user.uid;
  let snap = null;
  try { snap = await getDoc(doc(db, "entrants", user.uid)); } catch (_) {}
  if (snap && snap.exists() && snap.data().name) {
    state.name = snap.data().name;
    el.whoami.textContent = `Playing as ${state.name}`;
    await boot();
  } else {
    showView("name");
  }
}

$("#name-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!db || !state.uid) { $("#name-error").textContent = "Still connecting, try again in a second."; return; }
  const name = $("#name-input").value.trim();
  if (name.length < 2) { $("#name-error").textContent = "Name must be at least 2 characters."; return; }
  $("#name-error").textContent = "";

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
    await boot();
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
  if (new URLSearchParams(location.search).has("demo")) return bootDemo();

  const param = new URLSearchParams(location.search).get("t");
  const fromUrl = param ? param.split(",").map((x) => parseInt(x, 10)).filter((n) => !isNaN(n)) : [];
  const seeds = (Array.isArray(FOLLOW_TOURNAMENT_IDS) ? FOLLOW_TOURNAMENT_IDS : [])
    .map(Number).filter(Number.isFinite);

  if (fromUrl.length) {
    state.follow = fromUrl;
  } else {
    setStatus("Looking for tournaments\u2026");
    state.follow = await discoverLive(seeds);
    setStatus("");
  }

  showView("home");
  for (const id of state.follow) followTournament(id);
  if (state.follow.length === 1) openTournament(state.follow[0]);

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

function discoverLive(seedIds) {
  const remembered = Number(localStorage.getItem(SEEN_KEY) || 0);
  const base = Math.max(remembered, ...seedIds.map(Number), 0);
  if (!base) return Promise.resolve([]);

  const ids = [];
  for (let id = base - 2; id <= base + 14; id++) if (id > 0) ids.push(id);

  return new Promise((resolve) => {
    const found = new Map();
    const probe = io(FREEROLL_ORIGIN, {
      transports: ["websocket", "polling"],
      withCredentials: false,
      reconnection: false,
    });

    const finish = () => {
      try { probe.close(); } catch (_) {}
      const live = [...found.entries()]
        .filter(([, t]) => t.status === "in_progress")
        .map(([id]) => id)
        .sort((x, y) => y - x);
      const newest = Math.max(base, ...found.keys());
      if (Number.isFinite(newest) && newest > remembered) {
        localStorage.setItem(SEEN_KEY, String(newest));
      }
      resolve(live);
    };

    const timer = setTimeout(finish, 5000);
    probe.on("connect", () => ids.forEach((id) => probe.emit("joinRoom", String(id))));
    probe.on("tournament:updated", (ev) => {
      const t = ev?.data?.tournament;
      if (!t || t.id == null) return;
      found.set(Number(t.id), t);
      const c = card(Number(t.id));
      if (!c.tournament) c.tournament = t;
    });
    probe.on("connect_error", () => { clearTimeout(timer); finish(); });
  });
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
    saveContestMeta();
    maybeFreezeResults();
  }
  render();
}

/**
 * Persist the tournament's identity on the contest doc, so the Finished tab can
 * describe a game without needing a socket connection to it. Written once per
 * session, after the tournament record first arrives.
 */
async function saveContestMeta() {
  const c = active();
  if (!c?.tournament || !state.contestId || state.metaSaved) return;
  state.metaSaved = true;
  const t = c.tournament;
  try {
    await setDoc(doc(db, "contests", String(state.contestId)), {
      tournamentId: state.activeId,
      title: t.title ?? null,
      venue: t.venue ?? null,
      td: t.td ?? null,
      date: t.date ?? null,
      fieldSize: c.players.length,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (e) { console.warn("contest meta:", e.message); }
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
  } catch (e) { console.warn("freeze results:", e.message); }
}

function openTournament(id) {
  state.activeId = id;
  state.contestId = TEST_MODE ? `test-${id}` : String(id);
  state.mockEntries = [];
  state.entries = [];
  state.metaSaved = false;
  state.resultsFrozen = false;
  followTournament(id);
  prepareContest(id);
  watchEntries();
  showView("standings");
}

async function prepareContest(id) {
  if (!TEST_MODE) return;
  try {
    await withTimeout(setDoc(doc(db, "contests", String(state.contestId)),
      { tournamentId: id, gameStarted: false, title: `Test ${id}`, updatedAt: serverTimestamp() },
      { merge: true }), 6000);
  } catch (e) { console.warn("contest prepare:", e.message); }
}

/**
 * Archive a finished tournament that nobody was watching when it ended.
 *
 * Contests used to be frozen only by a client that happened to be on the page
 * at the final knockout, so a game that ended unobserved never appeared under
 * Finished. This fetches the final roster over the socket and writes it, which
 * works for any past tournament because joinRoom serves its record whatever the
 * status.
 */
function archiveContest(tournamentId, contestId) {
  return new Promise((resolve) => {
    const s = io(FREEROLL_ORIGIN, {
      transports: ["websocket", "polling"],
      withCredentials: false,
      reconnection: false,
    });
    let players = null, tournament = null, settled = false;

    const done = async (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { s.close(); } catch (_) {}
      if (!ok || !players?.length || !tournament) return resolve(false);
      if (tournament.status === "in_progress") return resolve(false);
      try {
        await setDoc(doc(db, "contests", String(contestId), "results", "final"), {
          fieldSize: players.length,
          players: players.map((p) => ({
            id: Number(p.id), name: String(p.name), nickname: p.nickname ?? null,
            placement: p.placement ?? null,
            elimination_position: p.elimination_position ?? null,
            hitman_name: p.hitman_name ?? null,
            is_active: Boolean(p.is_active),
          })),
          frozenAt: serverTimestamp(),
        }, { merge: true });
        await setDoc(doc(db, "contests", String(contestId)), {
          tournamentId: Number(tournamentId),
          title: tournament.title ?? null,
          venue: tournament.venue ?? null,
          td: tournament.td ?? null,
          date: tournament.date ?? null,
          fieldSize: players.length,
        }, { merge: true });
        resolve(true);
      } catch (e) {
        console.warn("archive failed:", e.message);
        resolve(false);
      }
    };

    const timer = setTimeout(() => done(false), 8000);
    s.on("connect", () => s.emit("joinRoom", String(tournamentId)));
    s.on("updatePlayers", (p) => { if (Array.isArray(p)) players = p; if (tournament) done(true); });
    s.on("tournament:updated", (ev) => {
      tournament = ev?.data?.tournament ?? null;
      if (players) done(true);
    });
    s.on("connect_error", () => done(false));
  });
}

// ---------------------------------------------------------------- entries
function watchEntries() {
  if (!state.contestId) return;
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
          t?.time ? ` <strong style="color:var(--cyan)">@ ${esc(String(t.time).slice(0,5))}</strong>` : ""}</span></div>
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
  $("#home-empty").hidden = ids.length > 0;
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

function computeStandings(players, entries) {
  return entries
    .map((e) => ({ ...e, score: scoreEntry(e.picks ?? [], players) }))
    .sort((a, b) => b.score.totalPoints - a.score.totalPoints ||
      b.score.picksAlive - a.score.picksAlive ||
      String(a.name).localeCompare(String(b.name)))
    .map((row, i) => ({ ...row, rank: i + 1 }));
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
    not on raw place. That way a 12 player Tuesday and a 37 player Wednesday are
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
    <p>Your <strong>projected total</strong> is higher than the sum of those
    figures, and deliberately so. Your survivors cannot all finish in the same
    place, so if they went out one after another they would take different places,
    and the total credits them accordingly. Tap <span class="mathbtn">why?</span>
    on any entry to see that spelled out. It is a floor: picks can only finish
    higher than the projection, never lower.</p>

    <h2 class="section">The season</h2>
    <p>There are two separate scores. The <strong>points</strong> in a game decide
    who places where on that night, and nothing more. What carries into the season
    is <strong>where you placed</strong>, which pays season points:</p>
    <div class="table-wrap"><table><thead><tr>
      <th>Place</th>${SEASON_POINTS.map((_, i) => `<th>${i + 1}${ordinal(i + 1)}</th>`).join("")}
      <th>${SEASON_POINTS.length + 1}${ordinal(SEASON_POINTS.length + 1)}+</th>
    </tr></thead><tbody><tr>
      <td>Season points</td>${SEASON_POINTS.map((v) => `<td><strong>${v}</strong></td>`).join("")}
      <td>0</td>
    </tr></tbody></table></div>
    <p>A game pays at most <strong>${Math.max(...SEASON_POINTS)}</strong> season
    points no matter how big it was, so a quiet Tuesday counts the same as a packed
    Wednesday. Scoring 400 points in one game and winning it earns the same
    ${Math.max(...SEASON_POINTS)} as scoring 90 and winning it. The season runs a
    month and the highest total wins. The top <strong>${SEASON_POINTS.length}</strong>
    in each game are highlighted in the standings, because those are the places that
    pay.</p>

    <h2 class="section">Your account</h2>
    <p>Your account is linked to this device, so your name, your entries and your
    season points are waiting for you whenever you come back to this page. Names
    are unique, so no two entrants can share one. Opening the page on another
    browser or device creates a separate account, and clearing your browser data
    starts a fresh one.</p>`;
}

// ---------------------------------------------------------------- finished
/**
 * Every contest that has a frozen final roster, with its full standings and the
 * season points it paid out. Scored from `results/final`, so no socket needed.
 */
async function renderFinished() {
  const node = $("#finished-list");
  node.innerHTML = `<p class="muted">Loading\u2026</p>`;
  try {
    const all = await withTimeout(getDocs(collection(db, "contests")), 8000);
    if (!all) {
      node.innerHTML = `<p class="error">Could not reach the database. Check your
        connection and reload.</p>`;
      return;
    }
    const docsList = all.docs.filter((c) => c.id !== DEMO_ID);
    if (!docsList.length) {
      node.innerHTML = `<p class="muted">No contests yet.</p>`;
      return;
    }

    // Read every contest at once rather than one after another.
    const loaded = await Promise.all(docsList.map(async (c) => {
      const [entriesSnap, finalSnap] = await Promise.all([
        withTimeout(getDocs(collection(db, "contests", c.id, "entries")), 8000),
        withTimeout(getDoc(doc(db, "contests", c.id, "results", "final")), 8000),
      ]);
      return { id: c.id, meta: c.data(), entriesSnap, finalSnap };
    }));

    // Any contest with entries but no frozen roster gets archived now.
    const toArchive = loaded.filter((x) =>
      x.entriesSnap?.size && !(x.finalSnap && x.finalSnap.exists()) && x.meta?.tournamentId != null);
    if (toArchive.length) {
      node.innerHTML = `<p class="muted">Archiving ${toArchive.length}
        finished game${toArchive.length > 1 ? "s" : ""}\u2026</p>`;
      const results = await Promise.all(
        toArchive.map((x) => archiveContest(x.meta.tournamentId, x.id)));
      if (results.some(Boolean)) return renderFinished();   // reload with the new archives
    }

    const done = [];
    for (const x of loaded) {
      if (!(x.finalSnap && x.finalSnap.exists())) continue;
      const players = x.finalSnap.data().players ?? [];
      if (!players.length) continue;
      const rows = computeStandings(
        players,
        (x.entriesSnap?.docs ?? []).map((d) => ({ entrantId: d.id, ...d.data() }))
      );
      done.push({ id: x.id, meta: x.meta, players, rows });
    }

    done.sort((p, q) => String(q.meta.date ?? "").localeCompare(String(p.meta.date ?? "")));

    if (!done.length) {
      node.innerHTML = `<p class="muted">No finished contests with entries yet.
        A game is archived once it has ended and someone opens this tab.</p>`;
      return;
    }

    node.innerHTML = done.map((d) => {
      const m = d.meta;
      const champ = d.players.find((p) => Number(p.placement) === 1)
        ?? d.players.find((p) => Number(p.elimination_position) === d.players.length);
      const open = state.finishedOpen === d.id;
      return `<div class="fcard">
        <div class="fcard-top">
          <div>
            <div class="fcard-title">${esc(cleanTitle(m.title) || m.venue || `Tournament ${m.tournamentId ?? d.id}`)}</div>
            <div class="t-meta">
              ${m.date ? `<span>${esc(fmtDate(m.date))}</span>` : ""}
              ${m.venue ? `<span>${esc(m.venue)}</span>` : ""}
              ${m.td ? `<span>TD ${esc(m.td)}</span>` : ""}
              <span><strong>${d.players.length}</strong> players</span>
              <span><strong>${d.rows.length}</strong> entries</span>
            </div>
          </div>
          <button class="draftbtn" data-fid="${d.id}">${open ? "Hide" : "Standings"}</button>
        </div>
        <div class="fcard-body">
          <div class="row"><span class="ico">&#127942;</span><span>Tournament won by
            <strong>${esc(champ ? (champ.nickname || champ.name) : "?")}</strong></span></div>
          ${d.rows[0] ? `<div class="row"><span class="ico">&#129351;</span><span>Fantasy winner
            <strong>${esc(d.rows[0].name)}</strong> with
            <strong>${d.rows[0].score.totalPoints}</strong> points for
            <strong>${seasonPointsForRank(1)}</strong> season points</span></div>` : ""}
        </div>
        ${open ? `<div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Entrant</th><th>Points</th><th>Their picks</th><th>Season</th></tr></thead>
          <tbody>${d.rows.map((r) => `<tr class="${r.entrantId === state.uid ? "me " : ""}${
            seasonPointsForRank(r.rank) ? "paid" : ""}">
            <td>${r.rank}</td><td>${esc(r.name)}</td>
            <td><strong>${r.score.totalPoints}</strong></td>
            <td class="picksum">${r.score.picks.map((p) =>
              `${esc(p.name)} <span class="place">#${p.finishedPlace ?? "?"}</span>`).join(" \u00b7 ")}</td>
            <td class="season">${seasonPointsForRank(r.rank) || "0"}</td></tr>`).join("")}
          </tbody></table></div>` : ""}
      </div>`;
    }).join("");

    node.querySelectorAll("button[data-fid]").forEach((b) =>
      b.addEventListener("click", () => {
        state.finishedOpen = state.finishedOpen === b.dataset.fid ? null : b.dataset.fid;
        renderFinished();
      }));
  } catch (e) {
    node.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------- season
async function renderSeason() {
  const node = $("#season-table");
  node.innerHTML = `<p class="muted">Loading\u2026</p>`;
  try {
    const all = await withTimeout(getDocs(collection(db, "contests")), 8000);
    if (!all) {
      node.innerHTML = `<p class="error">Could not reach the database. Check your
        connection and reload.</p>`;
      return;
    }

    // Test contests count here too, otherwise the table is empty for the whole
    // dry-run period. Only the demo field is excluded.
    const docsList = all.docs.filter((c) => c.id !== DEMO_ID);
    const loaded = await Promise.all(docsList.map(async (c) => {
      const [entriesSnap, finalSnap] = await Promise.all([
        withTimeout(getDocs(collection(db, "contests", c.id, "entries")), 8000),
        withTimeout(getDoc(doc(db, "contests", c.id, "results", "final")), 8000),
      ]);
      return { id: c.id, entriesSnap, finalSnap };
    }));

    const totals = new Map();
    let counted = 0;
    for (const x of loaded) {
      if (!x.entriesSnap?.size) continue;
      let players = (x.finalSnap && x.finalSnap.exists()) ? (x.finalSnap.data().players ?? []) : null;
      if (!players && String(state.contestId) === x.id) players = active()?.players ?? [];
      if (!players || !players.length) continue;
      counted++;

      // Season points come from PLACING in the game, not the raw score, so
      // every game is worth the same however big it was.
      const ranked = computeStandings(
        players,
        x.entriesSnap.docs.map((d) => ({ entrantId: d.id, ...d.data() }))
      );
      for (const row of ranked) {
        const earned = seasonPointsForRank(row.rank);
        const prev = totals.get(row.entrantId)
          ?? { name: row.name, points: 0, contests: 0, best: null };
        totals.set(row.entrantId, {
          name: row.name ?? prev.name,
          points: prev.points + earned,
          contests: prev.contests + 1,
          best: prev.best == null ? row.rank : Math.min(prev.best, row.rank),
        });
      }
    }

    const rows = [...totals.entries()].map(([id, v]) => ({ id, ...v }))
      .sort((p, q) => q.points - p.points || p.name.localeCompare(q.name));

    node.innerHTML = rows.length
      ? `<p class="muted">${SEASON_POINTS[0]} points for winning a game, then
         ${SEASON_POINTS.slice(1).join(", ")} down to
         ${SEASON_POINTS.length}${ordinal(SEASON_POINTS.length)}. Ninth and below
         score nothing, so a game is worth at most ${SEASON_POINTS[0]}.
         Counting ${counted} game${counted === 1 ? "" : "s"}.</p>
         <div class="table-wrap"><table><thead><tr><th>#</th><th>Entrant</th>
         <th>Season Pts</th><th>Games</th><th>Best Finish</th><th>Avg</th></tr></thead><tbody>
         ${rows.map((r, i) => `<tr class="${r.id === state.uid ? "me " : ""}${
           i < SEASON_POINTS.length ? "paid" : ""}"><td>${i + 1}</td>
           <td>${esc(r.name)}</td><td><strong>${r.points}</strong></td><td>${r.contests}</td>
           <td>${r.best ? "#" + r.best : "0"}</td>
           <td>${Math.round((r.points / r.contests) * 10) / 10}</td></tr>`).join("")}
         </tbody></table></div>`
      : `<p class="muted">Nothing to show yet. A game counts towards the season
         once it has finished and been archived, which happens when someone opens
         the Finished tab after it ends.</p>`;
  } catch (e) {
    node.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------- demo
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

(async function start() {
  const cfg = await resolveConfig();
  if (!cfg) {
    setStatus("Firebase config not found. Deploy with Firebase Hosting, or fill in public/config.js.", "error");
    return;
  }
  app = initializeApp(cfg);
  auth = getAuth(app);
  db = getFirestore(app);
  onAuthStateChanged(auth, handleAuth);
})();
