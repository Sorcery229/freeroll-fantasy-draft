# Freeroll Fantasy Draft — Firebase app

A standalone fantasy-draft page that reads **live tournament data from
openbarleague.com** and stores picks in your own Firestore. It touches neither
the Freeroll repo nor the Freeroll database.

Anyone can play: they type a name, pick 5 players, and come back later to the
same name and the same season points. No password, no email.

## How it gets live data without database access

The Freeroll dashboard runs a socket.io server alongside Next.js. Two
properties of that server make this possible, both verified against production
rather than assumed:

1. **It accepts cross-origin connections.** `server.mts:1015` configures
   `cors: { origin: true, credentials: true }`. In socket.io v4 `origin: true`
   reflects whatever `Origin` the client sends. A handshake to
   `https://openbarleague.com/socket.io/?EIO=4&transport=polling` sent with
   `Origin: https://fantasy-demo.web.app` came back with
   `access-control-allow-origin: https://fantasy-demo.web.app`, so a Firebase
   domain can connect.
2. **Joining a tournament room needs no auth and replies with everything.** The
   `joinRoom` handler (`server.mts:1182`) calls `socket.join(room)` with no
   authorization check, then emits `updatePlayers` (the full roster),
   `tournament:updated` (the tournament record, **including `game_started`**)
   and `timer:sync`. Subsequent knockouts arrive as further `updatePlayers` /
   `player:eliminated` / `tournament:updated` events.

So the roster, every knockout, and the lock state all arrive over one socket.

The REST API is deliberately **not** used: it sends no
`Access-Control-Allow-Origin` header at all (checked across `next.config.js`
and every route), so a browser on another origin cannot read it. That is the
one thing a separately-hosted page genuinely cannot do.

## Scoring

Two tiers, in `public/scoring.js`.

### Within one game

`SCORING.mode = "curve"`: a pick scores
`maxFinishPoints * (fraction of the field it beat) ^ gamma`, with
`maxFinishPoints = 100` and `gamma = 3`. In a 37-player field that is 1st = 100,
2nd = 91.9, 3rd = 84.2, 5th = 70.2, 9th = 47.1, last = 0. Top-heavy, so a deep
run actually pays, and field-size neutral, so the same percentile is worth the
same in a 12-player game as a 37-player one.

Knockouts award **no points** (`knockoutPoints: 0`) — the league wants to see
who knocked out whom, not to pay for it. They appear in the live feed only.

Players still in are scored at the place they would take if they busted on the
next hand, so live scores climb as the field thins.

`mode: "places"` is the simpler alternative (points = players beaten + 1) and
remains one constant away, but it is linear: 1st in a 37 field scores 37 against
2nd's 36, so picking the actual winner is worth 3% more than picking the
runner-up. That flatness is why `curve` is the default.

### Across the season

Season points come from an entrant's **finishing rank in each game**, not their
raw score:

| Game rank | 1st | 2nd | 3rd | 4th | 5th | 6th | 7th | 8th | 9th+ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Season points | 10 | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 |

`SEASON_POINTS = [10, 7, 6, 5, 4, 3, 2, 1]`.

This is what makes the two tiers fit together. Because only the *order* within a
game carries forward, the in-game curve can be as top-heavy as it likes without
distorting the season, and **every game is worth exactly the same** — a
12-player Tuesday cannot be outweighed by a 37-player Saturday. A month of eight
games tops out at 80 points.

### Elimination order is not a finishing place

The live feed exposes `elimination_position` (`ko_position` in the database) and
it is the **order of elimination** — `1` means the first player knocked out,
i.e. last place. Verified on live tournament 712, where the first player out
carried `elimination_position: 1`. The scorer originally treated it as a
finishing place, which paid the first player eliminated full marks for
"winning". `effectivePlace()` now inverts it against the field size. Finished
games are unaffected: they carry `placement`, a true finishing place, which
takes precedence.

## Identity: name only, progress kept

Firebase **anonymous auth** gives each browser a stable `uid` with no sign-up.
The name is a label stored at `entrants/{uid}`. Returning on the same browser
restores the name and all season points automatically; "Change name" renames
without losing history, because history is keyed to the uid.

The honest limits: a different browser or device is a different entrant, and
clearing site data starts a new one. Someone determined can therefore enter a
contest more than once. For a bar league that is usually an acceptable trade
for having no passwords; if it ever matters, swap anonymous auth for email
links or phone auth — it is a two-line change in `app.js`.

## The lock

Picks must close when the TD starts the clock. Enforcement:

- Any client watching the socket mirrors `game_started` into
  `contests/{tournamentId}.gameStarted`, and that flag is **monotonic** —
  `firestore.rules` permits `false -> true` but never the reverse.
- The rules refuse any entry write while that flag is true. This runs on
  Firestore's servers, so editing the page's JavaScript does not get you past
  it.

Residual weakness, stated plainly: the flag only flips once *some* client has
observed the start. If literally nobody has the page open at the moment the
clock starts, a late entry could land in the gap. Two ways to close it if you
care: keep the standings page open on any screen during the game, or upgrade to
the Blaze plan and run a scheduled Cloud Function that polls and sets the flag.
The dashboard branch does not have this weakness, because there the lock is
read directly from the database on every submit.

## Setup

**There is no API key to paste.** When served by Firebase Hosting the app reads
the project's own SDK config from the reserved URL `/__/firebase/init.json`, so
deploying is all that is required. `public/config.js` exists only as a fallback
for serving the app from somewhere other than Firebase Hosting.

1. Create a Firebase project, **create a Firestore database** (Standard
   edition, production mode, and leave scheduled backups off — that step is the
   only part of the wizard that asks for a paid plan), and **enable Anonymous
   sign-in** under Authentication → Sign-in method.
2. Set your project id in `.firebaserc` (already set to
   `freeroll-fantasy-draft`).
3. Deploy:

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only hosting,firestore:rules
```

### Deploying from GitHub instead

`.github/workflows/deploy.yml` deploys on every push to `main`. It needs one
repository secret, `FIREBASE_SERVICE_ACCOUNT`, containing a service-account JSON
key with Firebase Hosting admin rights. The quickest way to create it is to run
`firebase init hosting:github` once locally, which mints the service account and
writes the secret for you; then delete the workflow file that command generates,
since this repo already has one.

Everything runs on the **free Spark plan** — Hosting, Firestore and anonymous
auth only, with no Cloud Functions. That is deliberate: Spark blocks outbound
requests from Cloud Functions to non-Google hosts, which would have broken any
design that proxied the Freeroll API.

## Test mode against a live game

`public/config.js` carries two settings that control this:

```js
export const LIVE_TOURNAMENT_ID = 712;  // tournament this page follows
export const TEST_MODE = true;          // dry-run behaviour, see below
```

With `TEST_MODE = true` the app:

- **lets you submit picks after the clock has started**, so a game already in
  progress can be used for a dry run;
- writes those picks to contest id **`test-<tournamentId>`**, never the real
  contest, so nothing pollutes a genuine one;
- **never mirrors `game_started`** to Firestore, keeping the test contest open;
- **injects synthetic predictions attributed to real players in the field** —
  entrant names are taken from the live roster and each picks 5 rivals, seeded
  from the tournament id so the same game always yields the same predictions.
  They live only in the page.

Set `TEST_MODE = false` for a real contest, where picks must close the moment
the TD starts the clock.

`LIVE_TOURNAMENT_ID` is checked before the Firestore `config/active` document,
so pointing the page at a game needs no database write. Set it to `null` to go
back to `config/active`, and note that `?t=<id>` always overrides both.

### A bug this testing caught

The live feed exposes `elimination_position` (`ko_position` in the database),
and it is the **order of elimination** — `1` means the first player knocked out,
i.e. last place — not a finishing place. Verified on live tournament 712, where
the first player out carried `elimination_position: 1`. The scorer originally
treated it as a finishing place, which paid the first player eliminated a full
100 points for "winning". `effectivePlace()` now inverts it against the field
size. Finished games are unaffected because they carry `placement`, which is a
true finishing place and takes precedence.

## Demo mode (testing with no live game)

Open the site with `?demo=1`:

```
https://freeroll-fantasy-draft.web.app/?demo=1
```

This replaces the live socket with a canned field of **100 real Freeroll
Atlanta players**, pulled from `/api/rankings/advanced` on openbarleague.com —
all 89 players who have a nickname, plus the 11 most-active players without
one. The data lives in `public/demo.json`.

The demo also loads automatically on the main page whenever no live game is
configured, so the landing page is never empty.

It opens **mid-tournament**: the clock is running, 42 of the 100 players are
already out, and **12 synthetic predictions** are in the standings, named after
real league nicknames. Those predictions exist only in the page — they are never
written to Firestore — so the demo looks populated without inventing data in
your database. Everything is seeded from a fixed value, so it looks identical on
every load.

A control bar appears with:

- **Start clock (lock picks)** — flips `game_started` locally so you can see
  the picks-closed state.
- **Bust next player** / **Bust 10** — eliminates random players and credits
  the knockout to another survivor, so you can watch live scores climb.
- **Reset field** — puts all 100 back in and reopens picks, which is how you
  make your own prediction against the mock field.

Entries are still written to Firestore under contest id `demo`, so the real
write path and the standings rendering are genuinely exercised. Two deliberate
differences from a live contest: the lock is simulated in the page and never
mirrored to Firestore (which keeps the demo contest reusable instead of
permanently locked), and the season leaderboard skips contest `demo` so test
data never counts.

Verified by replaying a full 100-player tournament through the scorer:
placements come out covering 1–100 exactly once, and a sample 5-pick entry
finished on 172.3 points with 4 knockouts and a best finish of 5th.

One thing that mock surfaces: at a 100-player field the curve compresses at the
top — 2nd place scores 97 against 1st at 100, because beating 98 of 99 players
is nearly the same as beating all 99. At your real field sizes (20–30) the
separation is much better: 2nd of 27 scores 88.9. If Freeroll ever runs
100-player events, raise `gamma` in `public/scoring.js` to keep the top places
apart.

## Pointing it at tonight's game

The socket needs a tournament id, and discovering the live one would require
the CORS-blocked REST API. So it is set manually, once per game:

- Click **Set tournament** and paste the id, which writes `config/active`; or
- Open the page with `?t=<id>` to override for one visit.

Find the id in the dashboard URL for the live game. Anyone signed in can set it
(the rules allow it) — if you want that restricted, set `config/active` from
the Firebase console instead and tighten the `match /config/{docId}` rule to
`allow write: if false`.

## Data model

```
entrants/{uid}                  { name, updatedAt }
config/active                   { tournamentId, updatedAt }
contests/{tournamentId}         { tournamentId, gameStarted, title, venue }
contests/{tournamentId}/entries/{uid}        { name, picks: [{id, name}] × 5, submittedAt }
contests/{tournamentId}/results/final        { fieldSize, players[], frozenAt }
```

`results/final` is a frozen copy of the final roster, written once a contest
ends, so the season leaderboard can rescore finished contests with no socket
connection.

## What was and was not tested

- **Verified against production:** the cross-origin socket handshake, and that
  the REST API sends no CORS headers.
- **Verified locally:** `scoring.js` reproduces the reference numbers exactly
  (27-field curve and the 397.4 maximum), and all three JS files pass
  `node --check` with every DOM id in `index.html` matching.
- **Not tested:** the app has never run in a browser against a live tournament,
  because no game was in progress while it was built and I cannot deploy to
  your Firebase project. Expect to shake out small UI issues on the first live
  game. The riskiest assumption is the exact socket payload shape, which is
  taken from `server.mts:973-997`.

## Trade-offs versus the dashboard branch

The branch (`feat-fantasy-draft.patch`) remains the better long-term option: it
reuses NextAuth identity and `players_v2.uid`, enforces the lock from the
database, and cannot drift from the tournament code. This Firebase app wins on
exactly one axis — it ships without touching the droplet or its database. It
depends on internal socket event shapes, so a future change to `server.mts`
would break it silently, with nothing failing in anyone's CI.
