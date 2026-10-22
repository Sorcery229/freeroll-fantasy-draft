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
  getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  firebaseConfig, FREEROLL_ORIGIN, FOLLOW_TOURNAMENT_IDS, TEST_MODE,
} from "/config.js";
import { SCORING, scoreEntry, isAlive, maxAchievable } from "/scoring.js";

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
  selected: [], expanded: null,
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
  for (const v of ["name", "home", "draft", "standings", "season"]) {
    const node = document.getElementById(`view-${v}`);
    if (node) node.hidden = v !== name;
  }
  document.querySelectorAll(".tab").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.view === name)));
  if (name === "season") renderSeason();
  render();
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    if (!state.name) return showView("name");
    if (t.dataset.view !== "home" && t.dataset.view !== "season" && state.activeId == null) {
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
  if (!db || !state.uid) { $("#name-error").textContent = "Still connecting — try again in a second."; return; }
  const name = $("#name-input").value.trim();
  if (name.length < 2) { $("#name-error").textContent = "Name must be at least 2 characters."; return; }
  $("#name-error").textContent = "";
  try {
    await setDoc(doc(db, "entrants", state.uid), { name, updatedAt: serverTimestamp() }, { merge: true });
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
  const configured = (Array.isArray(FOLLOW_TOURNAMENT_IDS) ? FOLLOW_TOURNAMENT_IDS : [])
    .map(Number).filter((n) => Number.isFinite(n));
  state.follow = fromUrl.length ? fromUrl : configured;

  if (!state.follow.length) {
    const cfg = await withTimeout(getDoc(doc(db, "config", "active")), 4000);
    if (cfg && cfg.exists()) state.follow = [Number(cfg.data().tournamentId)];
  }

  if (!state.follow.length) { setStatus("No tournaments configured."); return showView("home"); }

  showView("home");
  for (const id of state.follow) followTournament(id);
  if (state.follow.length === 1) openTournament(state.follow[0]);
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
  if (TEST_MODE && id === state.activeId) buildLiveMocks();
  render();
}

function openTournament(id) {
  state.activeId = id;
  state.contestId = TEST_MODE ? `test-${id}` : String(id);
  state.mockEntries = [];
  state.entries = [];
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
  try {
    await setDoc(doc(db, "contests", String(state.contestId), "entries", state.uid),
      { name: state.name, picks, submittedAt: serverTimestamp() });
    $("#draft-error").textContent = "";
    setStatus("Picks locked in. Good luck.");
    showView("standings");
  } catch (e) {
    $("#draft-error").textContent = e.code === "permission-denied"
      ? "Picks are closed — the clock has started." : e.message;
  }
}
$("#submit-picks").addEventListener("click", submitPicks);
$("#clear-picks").addEventListener("click", () => { state.selected = []; render(); });
$("#pool-filter").addEventListener("input", (e) => { state.poolFilter = e.target.value; renderDraft(); });

// ---------------------------------------------------------------- render
function render() {
  if (state.view === "home") renderHome();
  if (state.view === "standings") renderTournament();
  if (state.view === "draft") renderDraft();
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
        <div class="card-title"><span>${esc(title)}</span><span>→</span></div>
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
  const t = c.tournament;
  const players = c.players;
  $("#t-head").innerHTML = `
    <h1 class="t-title">${esc(t?.title || t?.venue || `Tournament ${state.activeId}`)}</h1>
    <div class="t-meta">
      <span>${esc(t?.venue ?? "")}</span><span>TD ${esc(t?.td ?? "—")}</span>
      <span><strong>${remaining(c)}</strong> of <strong>${players.length}</strong> left</span>
      <span><strong>${allEntries().length}</strong> entries</span>
      <span>max <strong>${players.length ? maxAchievable(players.length) : 0}</strong></span>
    </div>`;

  renderClock();

  // Knockouts, most recent first.
  const out = players.filter((p) => !isAlive(p))
    .sort((a, b) => (b.elimination_position ?? 0) - (a.elimination_position ?? 0));
  $("#ko-feed").innerHTML = out.length ? out.map((p) => {
    const place = players.length - (Number(p.elimination_position) || 0) + 1;
    return `<div class="feed-item out">
      <div class="who">${esc(p.nickname || p.name)} <span class="place">#${place}</span></div>
      ${p.hitman_name ? `<div class="by">knocked out by ${esc(p.hitman_name)}</div>` : ""}
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
    <thead><tr><th>#</th><th>Entrant</th><th>Points</th><th>Alive</th><th>Best</th></tr></thead><tbody>
    ${rows.map((r) => `
      <tr class="entry ${r.entrantId === state.uid ? "me" : ""}" data-id="${r.entrantId}">
        <td>${r.rank}</td>
        <td><span class="caret">${state.expanded === r.entrantId ? "▾" : "▸"}</span> ${esc(r.name)}</td>
        <td><strong>${r.score.totalPoints}</strong></td>
        <td class="${r.score.picksAlive ? "alive-yes" : "alive-no"}">${r.score.picksAlive}/${SCORING.picksRequired}</td>
        <td>${r.score.bestFinish ? "#" + r.score.bestFinish : "—"}</td>
      </tr>
      ${state.expanded === r.entrantId ? `<tr class="detail"><td colspan="5">
        <div class="draft-title">${esc(r.name)}'s draft</div>
        <table class="subtable"><thead><tr><th>Pick</th><th>Player</th><th>Status</th><th>Points</th></tr></thead>
        <tbody>${[...r.score.picks].sort((a, b) => b.totalPoints - a.totalPoints)
          .map((p) => `<tr class="${p.alive ? "" : "dim"}">
            <td>${p.pickOrder}</td>
            <td>${esc(p.name)}</td>
            <td>${p.alive
              ? `<span class="alive-yes">still in</span> <span class="muted">(${p.effectivePlace}th if out now)</span>`
              : `<span class="muted">finished</span> <span class="place">#${p.effectivePlace}</span>`}</td>
            <td><strong>${p.totalPoints}</strong></td></tr>`).join("")}
          <tr class="sum"><td></td><td>Total</td><td></td><td><strong>${r.score.totalPoints}</strong></td></tr>
        </tbody></table></td></tr>` : ""}
    `).join("")}</tbody></table></div>`;
  $("#standings-table").querySelectorAll("tr.entry").forEach((tr) =>
    tr.addEventListener("click", () => {
      state.expanded = state.expanded === tr.dataset.id ? null : tr.dataset.id;
      renderStandingsTable(players);
    }));
}

function renderDraft() {
  const c = active();
  if (!c) return;
  const t = c.tournament;
  $("#draft-head").innerHTML = `<h1 class="glow">Make your picks</h1>
    <p class="muted">${esc(t?.title || t?.venue || "")} · pick ${SCORING.picksRequired} players</p>`;

  const locked = !TEST_MODE && Boolean(t?.game_started);
  $("#draft-locked").hidden = !locked;
  $("#draft-body").hidden = locked;
  if (locked) return;

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
    : `<span class="muted">Nobody picked yet — choose ${SCORING.picksRequired} from the field.</span>`;

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

// ---------------------------------------------------------------- season
async function renderSeason() {
  const node = $("#season-table");
  node.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const totals = new Map();
    const contests = await getDocs(collection(db, "contests"));
    for (const c of contests.docs) {
      if (c.id === DEMO_ID || c.id.startsWith("test-")) continue;
      const [entriesSnap, finalSnap] = await Promise.all([
        getDocs(collection(db, "contests", c.id, "entries")),
        getDoc(doc(db, "contests", c.id, "results", "final")),
      ]);
      if (!entriesSnap.size) continue;
      let players = finalSnap.exists() ? (finalSnap.data().players ?? []) : null;
      if (!players && String(state.activeId) === c.id) players = active()?.players ?? [];
      if (!players || !players.length) continue;
      for (const d of entriesSnap.docs) {
        const e = d.data();
        const s = scoreEntry(e.picks ?? [], players);
        const prev = totals.get(d.id) ?? { name: e.name, points: 0, contests: 0 };
        totals.set(d.id, {
          name: e.name ?? prev.name,
          points: Math.round((prev.points + s.totalPoints) * 10) / 10,
          contests: prev.contests + 1,
        });
      }
    }
    const rows = [...totals.entries()].map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    node.innerHTML = rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Entrant</th>
         <th>Total Pts</th><th>Contests</th><th>Avg</th></tr></thead><tbody>
         ${rows.map((r, i) => `<tr class="${r.id === state.uid ? "me" : ""}"><td>${i + 1}</td>
           <td>${esc(r.name)}</td><td><strong>${r.points}</strong></td><td>${r.contests}</td>
           <td>${Math.round((r.points / r.contests) * 10) / 10}</td></tr>`).join("")}
         </tbody></table></div>`
      : `<p class="muted">No finished contests yet.</p>`;
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
