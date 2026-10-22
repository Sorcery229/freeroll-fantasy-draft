// public/app.js
//
// Fantasy draft for Freeroll Atlanta, hosted on Firebase, reading live
// tournament state straight from openbarleague.com over socket.io.
//
// Why this works without any database or repo access:
//   * The Freeroll socket.io server sets cors {origin: true, credentials: true}
//     (server.mts:1015), which reflects any Origin — verified against
//     production, which returned access-control-allow-origin for a foreign
//     Firebase domain.
//   * Its `joinRoom` handler (server.mts:1182) takes no auth and immediately
//     emits `updatePlayers` (full roster), `tournament:updated` (including
//     game_started) and `timer:sync`. So one room join delivers the roster,
//     every knockout, and the lock state.
//   * The REST API has no CORS headers at all, so it is deliberately unused
//     here. Everything comes over the socket.
//
// Firestore holds only OUR data: entrant names and picks.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, onSnapshot,
  getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, FREEROLL_ORIGIN } from "/config.js";
import { SCORING, scoreEntry, isAlive, maxAchievable } from "/scoring.js";

// ---------------------------------------------------------------- firebase
// Config is resolved at runtime, not hardcoded. Firebase Hosting serves the
// project's own SDK config at the reserved path /__/firebase/init.json, so a
// deployed site needs no API keys in the source at all. config.js is only a
// fallback for serving this app from somewhere other than Firebase Hosting.
let app = null;
let auth = null;
let db = null;

async function resolveConfig() {
  try {
    const res = await fetch("/__/firebase/init.json", { cache: "no-store" });
    if (res.ok) {
      const cfg = await res.json();
      if (cfg && cfg.apiKey) return cfg;
    }
  } catch (_) {
    // Not served by Firebase Hosting — fall through to config.js.
  }
  const local = firebaseConfig ?? {};
  if (local.apiKey && !String(local.apiKey).startsWith("REPLACE")) return local;
  return null;
}

// ---------------------------------------------------------------- state
const state = {
  uid: null,
  name: null,
  tournamentId: null,
  tournament: null,   // { id, title, venue, td, game_started, status, ... }
  players: [],        // socket roster
  entries: [],        // [{ entrantId, name, picks:[{id,name}] }] from Firestore
  mockEntries: [],    // demo-only, page-local, never written to Firestore
  selected: [],       // ids chosen in the draft UI
  view: "standings",
  expanded: null,
  socket: null,
  lockMirrored: false,
};

const $ = (sel) => document.querySelector(sel);
const el = {
  status: $("#status"), whoami: $("#whoami"),
  viewName: $("#view-name"), viewDraft: $("#view-draft"),
  viewStandings: $("#view-standings"), viewSeason: $("#view-season"),
};

function setStatus(msg, kind) {
  el.status.textContent = msg || "";
  el.status.style.color = kind === "error" ? "#f87171" : "";
}

// ---------------------------------------------------------------- views
function showView(name) {
  state.view = name;
  for (const v of ["name", "draft", "standings", "season"]) {
    const node = document.getElementById(`view-${v}`);
    if (node) node.hidden = v !== name;
  }
  document.querySelectorAll(".tab").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.view === name))
  );
  if (name === "season") renderSeason();
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    if (!state.name) return showView("name");
    showView(t.dataset.view);
  })
);

// ---------------------------------------------------------------- identity
// Anonymous auth gives this browser a stable uid with no sign-up, which is how
// someone returns later and is still the same entrant. The name is a label.
async function handleAuth(user) {
  if (!user) {
    try { await signInAnonymously(auth); }
    catch (e) { setStatus(`Could not start a session: ${e.message}`, "error"); }
    return;
  }
  state.uid = user.uid;
  const snap = await getDoc(doc(db, "entrants", user.uid));
  if (snap.exists() && snap.data().name) {
    state.name = snap.data().name;
    el.whoami.textContent = `Playing as ${state.name}`;
    await boot();
  } else {
    showView("name");
  }
}

// Resolve config, then start. Nothing below runs until Firebase is initialised.
(async function start() {
  const cfg = await resolveConfig();
  if (!cfg) {
    setStatus(
      "Firebase config not found. Deploy this with Firebase Hosting, or fill in public/config.js.",
      "error"
    );
    return;
  }
  app = initializeApp(cfg);
  auth = getAuth(app);
  db = getFirestore(app);
  onAuthStateChanged(auth, handleAuth);
})();

$("#name-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!db || !state.uid) { $("#name-error").textContent = "Still connecting — try again in a second."; return; }
  const name = $("#name-input").value.trim();
  if (name.length < 2) { $("#name-error").textContent = "Name must be at least 2 characters."; return; }
  try {
    await setDoc(doc(db, "entrants", state.uid), { name, updatedAt: serverTimestamp() }, { merge: true });
    state.name = name;
    el.whoami.textContent = `Playing as ${name}`;
    $("#name-error").textContent = "";
    await boot();
  } catch (e) {
    $("#name-error").textContent = e.message;
  }
});

$("#change-name").addEventListener("click", () => {
  $("#name-input").value = state.name ?? "";
  showView("name");
});

if (new URLSearchParams(location.search).has("setup")) {
  $("#set-tournament").hidden = false;
}

$("#set-tournament").addEventListener("click", async () => {
  const current = state.tournamentId ?? "";
  const next = prompt(
    "Tournament ID to follow.\n\nFind it in the dashboard URL for the live game, " +
    "e.g. /l/freeroll-atlanta/games/<id>.", current
  );
  if (!next) return;
  const id = parseInt(next, 10);
  if (isNaN(id)) return alert("That is not a number.");
  try {
    await setDoc(doc(db, "config", "active"), { tournamentId: id, updatedAt: serverTimestamp() });
    location.search = `?t=${id}`;
  } catch (e) { alert(`Could not save: ${e.message}`); }
});

// ---------------------------------------------------------------- demo mode
// `?demo=1` replaces the live socket with a canned 100-player field built from
// real leaderboard names, so the whole flow can be exercised with no game on.
// Entries are still written to Firestore (contest id "demo") so the real write
// path is tested; the lock is simulated locally and never mirrored, which keeps
// the demo contest reusable. The season leaderboard skips it.
const DEMO_ID = "demo";
const DEMO_SEED = 20261021;      // fixed so the demo looks the same on every load
const DEMO_ENTRIES = 12;         // synthetic predictions shown alongside yours
const DEMO_PREBUSTED = 42;       // field already thinned, so it reads as mid-game

/** mulberry32 — small deterministic PRNG so the demo is reproducible. */
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
 * Synthetic predictions. These live only in the page — they are never written
 * to Firestore — so the demo standings look populated without inventing data in
 * your database. Your own entry comes from Firestore and sits alongside them.
 */
function buildDemoEntries(players) {
  const r = rng(DEMO_SEED);
  const pool = [...players];
  // Distinct entrant names: shuffle the pool deterministically and take from
  // the front, so no two synthetic entrants share a name.
  const names = pool.map((p) => p.nickname || p.name).filter(Boolean);
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  const out = [];
  for (let i = 0; i < DEMO_ENTRIES; i++) {
    const picks = [];
    const taken = new Set();
    while (picks.length < 5) {
      const p = pool[Math.floor(r() * pool.length)];
      if (taken.has(p.id)) continue;
      taken.add(p.id);
      picks.push({ id: p.id, name: p.name });
    }
    out.push({
      entrantId: `demo-entrant-${i}`,
      name: names[i] ?? `Entrant ${i + 1}`,
      picks,
      demo: true,
    });
  }
  return out;
}

/** Advance the demo field by n knockouts, deterministically. */
function demoAdvance(n, r) {
  for (let k = 0; k < n; k++) {
    const alive = state.players.filter(isAlive);
    if (alive.length <= 1) break;
    const victim = alive[Math.floor(r() * alive.length)];
    const others = alive.filter((p) => p.id !== victim.id);
    const hitman = others[Math.floor(r() * others.length)];
    victim.is_active = false;
    victim.elimination_position = alive.length;
    victim.placement = alive.length;
    victim.hitman_name = hitman ? hitman.name : null;
  }
}

async function bootDemo() {
  state.tournamentId = DEMO_ID;
  const res = await fetch("/demo.json", { cache: "no-store" });
  if (!res.ok) { setStatus("Could not load demo.json", "error"); return; }
  const data = await res.json();
  state.demoSeed = data;
  state.tournament = { ...data.tournament };
  state.players = data.players.map((p) => ({ ...p }));

  // Present it as a game already under way: clock running, field thinned,
  // predictions in. "Reopen picks" puts it back to a pre-start field.
  state.mockEntries = buildDemoEntries(state.players);
  state.tournament.game_started = true;
  demoAdvance(DEMO_PREBUSTED, rng(DEMO_SEED + 1));
  // The rules require the contest doc to exist (with gameStarted false) before
  // entries may be written. Demo never flips it to true, so it stays reusable.
  try {
    await setDoc(
      doc(db, "contests", DEMO_ID),
      { tournamentId: DEMO_ID, gameStarted: false, title: "Demo", updatedAt: serverTimestamp() },
      { merge: true }
    );
  } catch (e) {
    setStatus(`Could not prepare the demo contest: ${e.message}`, "error");
  }
  $("#demo-bar").hidden = false;
  showView("standings");
  watchEntries();
  renderDemoState();
  render();
}

function renderDemoState() {
  const alive = state.players.filter(isAlive).length;
  $("#demo-state").textContent =
    `${alive} of ${state.players.length} still in` +
    (state.tournament?.game_started ? " · clock running" : " · picks open");
}

function demoBust(n = 1) {
  demoAdvance(n, Math.random);
  renderDemoState();
  render();
}

function wireDemo() {
  $("#demo-start").addEventListener("click", () => {
    state.tournament.game_started = true;
    renderDemoState();
    render();
  });
  $("#demo-bust").addEventListener("click", () => demoBust(1));
  $("#demo-bust10").addEventListener("click", () => demoBust(10));
  $("#demo-reset").addEventListener("click", () => {
    state.tournament = { ...state.demoSeed.tournament };   // game_started false
    state.players = state.demoSeed.players.map((p) => ({ ...p }));
    state.selected = [];
    renderDemoState();
    showView("draft");
    render();
  });
}

// ---------------------------------------------------------------- boot
async function boot() {
  if (new URLSearchParams(location.search).has("demo")) {
    wireDemo();
    return bootDemo();
  }
  const param = new URLSearchParams(location.search).get("t");
  let id = param ? parseInt(param, 10) : NaN;
  if (isNaN(id)) {
    const cfg = await getDoc(doc(db, "config", "active"));
    id = cfg.exists() ? Number(cfg.data().tournamentId) : NaN;
  }
  if (isNaN(id)) {
    // Nothing configured yet: show the demo tournament rather than an empty
    // page, so there is always something to look at on the main page.
    wireDemo();
    await bootDemo();
    setStatus("Showing a demo tournament \u2014 no live game is configured yet. An organiser can point this page at a real game by opening it with ?setup=1.");
    return;
  }
  state.tournamentId = id;
  showView("standings");
  watchEntries();
  connectSocket();
}

// ---------------------------------------------------------------- socket
function connectSocket() {
  const s = io(FREEROLL_ORIGIN, {
    transports: ["websocket", "polling"],
    withCredentials: false,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });
  state.socket = s;

  const join = () => s.emit("joinRoom", String(state.tournamentId));

  s.on("connect", () => { setStatus(""); join(); });
  s.on("connect_error", (err) => {
    setStatus(`Cannot reach the live tournament feed (${err.message}).`, "error");
  });

  // joinRoom replies with the full roster.
  s.on("updatePlayers", (players) => { if (Array.isArray(players)) setPlayers(players); });
  s.on("players:updated", (ev) => { if (ev?.data?.players) setPlayers(ev.data.players); });
  s.on("player:added", () => join());
  s.on("player:eliminated", () => join());
  s.on("tournament:updated", (ev) => { if (ev?.data?.tournament) setTournament(ev.data.tournament); });
}

function setPlayers(players) {
  state.players = players;
  render();
  maybeFreezeResults();
}

function setTournament(t) {
  state.tournament = t;
  render();
  mirrorLock();
}

// Mirror game_started into Firestore so the SECURITY RULES can refuse late
// entries. Enforcement lives on Firestore's servers, not in this file.
async function mirrorLock() {
  if (!state.tournament || state.lockMirrored) return;
  const started = Boolean(state.tournament.game_started);
  try {
    await setDoc(
      doc(db, "contests", String(state.tournamentId)),
      {
        tournamentId: state.tournamentId,
        gameStarted: started,
        title: state.tournament.title ?? null,
        venue: state.tournament.venue ?? null,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    if (started) state.lockMirrored = true;
  } catch (e) {
    console.warn("Could not mirror lock state:", e.message);
  }
}

// Once the tournament is over, freeze the final roster so the season
// leaderboard can rescore past contests with no socket connection.
async function maybeFreezeResults() {
  const players = state.players;
  if (!players.length) return;
  const alive = players.filter(isAlive).length;
  const over = state.tournament?.status === "completed" || (alive <= 1 && players.length > 1);
  if (!over) return;
  try {
    await setDoc(
      doc(db, "contests", String(state.tournamentId), "results", "final"),
      {
        fieldSize: players.length,
        players: players.map((p) => ({
          id: Number(p.id), name: String(p.name),
          placement: p.placement ?? null,
          elimination_position: p.elimination_position ?? null,
          hitman_name: p.hitman_name ?? null,
          is_active: false,
        })),
        frozenAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (e) {
    console.warn("Could not freeze results:", e.message);
  }
}

// ---------------------------------------------------------------- entries
function watchEntries() {
  onSnapshot(
    collection(db, "contests", String(state.tournamentId), "entries"),
    (snap) => {
      state.entries = snap.docs.map((d) => ({ entrantId: d.id, ...d.data() }));
      const mine = state.entries.find((e) => e.entrantId === state.uid);
      if (mine && !state.selected.length) state.selected = mine.picks.map((p) => Number(p.id));
      render();
    },
    (err) => setStatus(`Could not read entries: ${err.message}`, "error")
  );
}

async function submitPicks() {
  const alivePlayers = state.players.filter(isAlive);
  const picks = state.selected
    .map((id) => alivePlayers.find((p) => Number(p.id) === id))
    .filter(Boolean)
    .map((p) => ({ id: Number(p.id), name: String(p.name) }));

  if (picks.length !== SCORING.picksRequired) {
    $("#draft-error").textContent = `Pick exactly ${SCORING.picksRequired} players.`;
    return;
  }
  try {
    await setDoc(
      doc(db, "contests", String(state.tournamentId), "entries", state.uid),
      { name: state.name, picks, submittedAt: serverTimestamp() }
    );
    $("#draft-error").textContent = "";
    setStatus("Picks locked in. Good luck.");
    showView("standings");
  } catch (e) {
    // A permission error here is the lock doing its job.
    $("#draft-error").textContent =
      e.code === "permission-denied"
        ? "Picks are closed — the clock has started."
        : e.message;
  }
}

$("#submit-picks").addEventListener("click", submitPicks);
$("#clear-picks").addEventListener("click", () => { state.selected = []; render(); });
$("#pool-filter").addEventListener("input", render);

// ---------------------------------------------------------------- render
function render() {
  if (state.view === "draft") renderDraft();
  if (state.view === "standings") renderStandings();
}

function headline() {
  const t = state.tournament;
  if (!t) return `<h2>Tournament #${state.tournamentId}</h2>`;
  return `<h2>${esc(t.title || t.venue || "Tournament")}</h2>
    <p class="muted">${esc(t.venue ?? "")}${t.td ? ` — TD: ${esc(t.td)}` : ""}</p>`;
}

function renderDraft() {
  $("#draft-head").innerHTML = headline();
  const locked = Boolean(state.tournament?.game_started);
  $("#draft-locked").hidden = !locked;
  $("#draft-body").hidden = locked;
  if (locked) return;

  const pool = state.players.filter(isAlive);
  const filter = $("#pool-filter").value.trim().toLowerCase();
  const shown = filter ? pool.filter((p) => p.name.toLowerCase().includes(filter)) : pool;

  $("#pick-count").textContent = `Your picks: ${state.selected.length} / ${SCORING.picksRequired}`;

  $("#chips").innerHTML = state.selected.length
    ? state.selected.map((id, i) => {
        const p = pool.find((x) => Number(x.id) === id);
        return p ? `<span class="chip" data-id="${id}"><span class="ord">${i + 1}</span>${esc(p.name)} ✕</span>` : "";
      }).join("")
    : `<span class="muted">Nobody picked yet — choose ${SCORING.picksRequired} from the field below.</span>`;

  $("#pool").innerHTML = shown.map((p) => {
    const on = state.selected.includes(Number(p.id));
    const full = state.selected.length >= SCORING.picksRequired && !on;
    return `<button data-id="${p.id}" aria-pressed="${on}" ${full ? "disabled" : ""}>
      <span>${esc(p.nickname ? `${p.nickname} (${p.name})` : p.name)}</span>
      <span>${on ? "✓" : ""}</span></button>`;
  }).join("") || `<p class="muted">No players checked in yet.</p>`;

  $("#submit-picks").disabled = state.selected.length !== SCORING.picksRequired;
  $("#submit-picks").textContent =
    state.entries.some((e) => e.entrantId === state.uid) ? "Update my picks" : "Submit my picks";

  $("#pool").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => toggle(Number(b.dataset.id)))
  );
  $("#chips").querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () => toggle(Number(c.dataset.id)))
  );
}

function toggle(id) {
  const i = state.selected.indexOf(id);
  if (i >= 0) state.selected.splice(i, 1);
  else if (state.selected.length < SCORING.picksRequired) state.selected.push(id);
  renderDraft();
}

/** Firestore entries plus any page-local demo predictions. */
function allEntries() {
  return state.mockEntries.length ? [...state.entries, ...state.mockEntries] : state.entries;
}

function computeStandings(players, entries) {
  return entries
    .map((e) => ({ ...e, score: scoreEntry(e.picks ?? [], players) }))
    .sort(
      (a, b) =>
        b.score.totalPoints - a.score.totalPoints ||
        b.score.picksAlive - a.score.picksAlive ||
        String(a.name).localeCompare(String(b.name))
    )
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

function renderStandings() {
  $("#standings-head").innerHTML = headline();
  const players = state.players;
  const alive = players.filter(isAlive).length;

  $("#standings-stats").innerHTML = [
    ["Field", players.length],
    ["Still In", alive],
    ["Entries", allEntries().length],
    ["Max Possible", players.length ? maxAchievable(players.length) : 0],
  ].map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");

  if (!allEntries().length) {
    $("#standings-table").innerHTML = `<p class="muted">No entries yet.${
      state.tournament?.game_started ? "" : " Be the first to pick 5 players."}</p>`;
    return;
  }

  const rows = computeStandings(players, allEntries());
  $("#standings-table").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Entrant</th><th>Fantasy Pts</th><th>Finish</th>
    <th>KO Pts</th><th>KOs</th><th>Alive</th><th>Best</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr class="entry ${r.entrantId === state.uid ? "me" : ""}" data-id="${r.entrantId}">
        <td>${r.rank}</td><td>${esc(r.name)}</td>
        <td><strong>${r.score.totalPoints}</strong></td>
        <td>${r.score.finishPoints}</td>
        <td>${r.score.knockoutPoints}</td>
        <td>${r.score.knockouts}</td>
        <td class="${r.score.picksAlive ? "alive-yes" : "alive-no"}">${r.score.picksAlive}/${SCORING.picksRequired}</td>
        <td>${r.score.bestFinish ? "#" + r.score.bestFinish : "—"}</td>
      </tr>
      ${state.expanded === r.entrantId ? `<tr><td colspan="8"><div class="picks">${
        r.score.picks.map((p) => `<div class="pickcard ${p.alive ? "alive" : ""}">
          <div><strong>${esc(p.name)}</strong></div>
          <div class="muted">${p.alive ? `still in (${p.effectivePlace} left)` : `finished #${p.effectivePlace}`}</div>
          <div>${p.totalPoints} pts · ${p.knockouts} KO</div></div>`).join("")
      }</div></td></tr>` : ""}`).join("")}</tbody></table></div>`;

  $("#standings-table").querySelectorAll("tr.entry").forEach((tr) =>
    tr.addEventListener("click", () => {
      state.expanded = state.expanded === tr.dataset.id ? null : tr.dataset.id;
      renderStandings();
    })
  );
}

// ---------------------------------------------------------------- season
async function renderSeason() {
  const node = $("#season-table");
  node.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const totals = new Map(); // entrantId -> { name, points, contests }

    const contests = await getDocs(collection(db, "contests"));
    for (const c of contests.docs) {
      if (c.id === DEMO_ID) continue; // test data never counts toward the season
      const [entriesSnap, finalSnap] = await Promise.all([
        getDocs(collection(db, "contests", c.id, "entries")),
        getDoc(doc(db, "contests", c.id, "results", "final")),
      ]);
      if (!entriesSnap.size) continue;

      // Finished contests score off the frozen roster; the live one off the socket.
      let players = null;
      if (finalSnap.exists()) players = finalSnap.data().players ?? [];
      else if (String(state.tournamentId) === c.id) players = state.players;
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

    const rows = [...totals.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

    node.innerHTML = rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Entrant</th><th>Total Pts</th><th>Contests</th><th>Avg</th></tr></thead>
          <tbody>${rows.map((r, i) => `<tr class="${r.id === state.uid ? "me" : ""}">
            <td>${i + 1}</td><td>${esc(r.name)}</td><td><strong>${r.points}</strong></td>
            <td>${r.contests}</td>
            <td>${Math.round((r.points / r.contests) * 10) / 10}</td></tr>`).join("")}
          </tbody></table></div>`
      : `<p class="muted">No finished contests yet.</p>`;
  } catch (e) {
    node.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
