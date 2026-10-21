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
  entries: [],        // [{ entrantId, name, picks:[{id,name}] }]
  selected: [],       // ids chosen in the draft UI
  view: "standings",
  expanded: null,
  socket: null,
  lockMirrored: false,
};

const $ = (sel) => document.querySelector(sel);
const el = {
  status: $("#status"), whoami: $("#whoami"), conn: $("#conn"),
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

// ---------------------------------------------------------------- boot
async function boot() {
  const param = new URLSearchParams(location.search).get("t");
  let id = param ? parseInt(param, 10) : NaN;
  if (isNaN(id)) {
    const cfg = await getDoc(doc(db, "config", "active"));
    id = cfg.exists() ? Number(cfg.data().tournamentId) : NaN;
  }
  if (isNaN(id)) {
    showView("standings");
    setStatus("No tournament selected yet. Use \u201CSet tournament\u201D below to point this page at tonight\u2019s game.");
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

  s.on("connect", () => { el.conn.textContent = "live"; join(); });
  s.on("disconnect", () => { el.conn.textContent = "reconnecting…"; });
  s.on("connect_error", (err) => {
    el.conn.textContent = "offline";
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
    ["Entries", state.entries.length],
    ["Max Possible", players.length ? maxAchievable(players.length) : 0],
  ].map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");

  if (!state.entries.length) {
    $("#standings-table").innerHTML = `<p class="muted">No entries yet.${
      state.tournament?.game_started ? "" : " Be the first to pick 5 players."}</p>`;
    return;
  }

  const rows = computeStandings(players, state.entries);
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
