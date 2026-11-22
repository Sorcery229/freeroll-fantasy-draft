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

The flag used to flip only once *some* client had observed the start, so a late
entry could land in the gap if nobody had the page open. The scheduled archiver
below now also mirrors `game_started`, which narrows that gap to the interval
between runs rather than leaving it open all night.

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

## Real contests (TEST_MODE = false)

The app now runs real contests: entries go to `contests/{tournamentId}`, picks
close when the TD starts the clock, and no synthetic predictions are shown.

Turning the flag off exposed two faults that test mode had been hiding, both
confirmed against the live security rules before being fixed:

1. **Nobody could have entered.** `firestore.rules` only permits creating a
   contest when the write carries `gameStarted == false`. The old code wrote the
   contest metadata without that field, which is denied, and the function that
   did create it properly returned early unless test mode was on. So in a real
   contest the document was never created, and entries are refused unless it
   exists. `syncContest()` now owns the document and creates it correctly.
2. **The lock would have been hours late.** Nothing in the page copied
   `game_started` into Firestore; only the scheduled archiver did, and GitHub
   runs it roughly every six hours. Picks could have stayed open most of the
   night after the clock started. Any open page now mirrors it within seconds.

Verified against the live rules, in order: creating a contest without
`gameStarted` is denied; creating it with `gameStarted: false` succeeds; merging
metadata succeeds whether the contest is open or locked; picks submitted while
open succeed; after the lock, both editing an existing entry and adding a new
one are refused; and the lock cannot be set back to false.

## The dry-run contests are hidden, not deleted

While test mode was on, entries were written to `test-<id>` rather than the real
contest. Both documents got summaries, so each of those nights appeared on the
Finished tab twice: the real contest reporting that nobody entered, and its twin
holding the picks. Those ids are now filtered out of both list views. The
documents remain in the database, since `firestore.rules` forbids deletion, but
nothing displays them and their entries no longer reach the season table.

Note that Independent genuinely runs two tournaments on the same night. Those
are separate games with different fields and different winners, not duplicates,
and both are shown.

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

## Finding tonight's game

Nothing is set by hand. The app finds live games itself: it joins a run of
tournament ids on one throwaway socket, keeps whichever report
`status: "in_progress"`, and remembers the newest id it has ever seen in
`localStorage` so later visits start from there. `?t=<id>` still overrides
everything for one visit.

The search window is **adaptive**, and that matters. The first version looked a
fixed number of ids ahead, which failed the moment the league created more
tournaments than the window spanned between two visits: nothing was found, so
the remembered id never advanced, so nothing was ever found again. It locked
itself out. It now walks forward in chunks until a chunk turns up nothing new
past the highest id it has seen, which recovers from a gap of any size. Starting
from a browser stuck at id 717 it found the two games running on id 732 and 733
in under four seconds.

## First paint

The page used to be blank through four sequential steps: the Firebase SDK from
the CDN, `/__/firebase/init.json`, anonymous sign-in, then the entrant document.
Only after all of that did it decide whether to show the name prompt or the
tournament list. Nothing above the fold actually needs any of it.

Three changes:

1. **The display name is cached** in `localStorage` beside the uid it belongs
   to, so a return visit draws the tournament list on the first frame. Firestore
   confirms it in the background, and corrects it if the cache is stale.
2. **The Firebase SDK loads dynamically**, inside `start()`, instead of as a
   static import at the top of the module. As a static import the browser had to
   fetch and parse it before the first line of the file ran.
3. **The tournament search starts immediately**, in parallel with sign-in. It
   talks to openbarleague.com over a socket and needs nothing from Firebase, so
   there was never a reason for it to wait.

Measured on the real bundles: what must arrive before the first screen can be
drawn went from **258 KB over 7 requests, plus three sequential round trips**,
down to **87 KB over 4 requests and no round trips**. The 170 KB of Firebase SDK
still loads, just no longer in front of the user.

Views that read Firestore await `dbReady` rather than assuming the SDK has
arrived, since the page is now interactive before it has. The name form waits
for sign-in on submit instead of refusing with "still connecting".

## Round-the-clock archiving

A finished game used to be recorded only if a browser happened to be watching
when it ended, or if someone later opened the Finished tab. Games nobody watched
were lost.

`scripts/archive.mjs`, run every 15 minutes by `.github/workflows/archive.yml`,
does that work on a schedule instead. It reads the project's public SDK config
from Hosting, signs in anonymously exactly as a visitor's browser does, walks
the tournament ids over the socket, and writes `contests/{id}` plus
`contests/{id}/results/final` for every finished game that is not archived yet.
It also sets `gameStarted` on games that are running, which is what narrows the
lock gap described above.

Worth stating: **there are no secrets in this job.** Firebase web config is
public by design, and every write it makes is one an ordinary visitor could
already make under the existing `firestore.rules`. It needs no service account
and no Blaze plan, which is why it is a GitHub Action and not a Cloud Function —
scheduled Cloud Functions require the paid plan.

Each run is idempotent: a game already frozen with its full field and summarised
is skipped, so a late or duplicated run costs nothing. By default it scans back
40 ids behind the known frontier; run the workflow manually with a `from` input
to backfill further, or with `RESUMMARISE=1` to rebuild stored summaries after a
shape change.

The backfill has been run: **41 games, ids 693 to 733**, are in the database.

## The list views do not use the Firestore SDK

The SDK talks to Firestore over a long-lived WebChannel. When that channel
stalls in Safari, an ordinary list read hangs with it, and the Finished tab
showed *Could not reach the database* after its timeout expired, with Season
stuck on *Loading...* The documents behind both tabs are world-readable
(`allow read: if true` in `firestore.rules`), so they do not need that channel,
or any authentication.

Both tabs now read the contest list with a plain `fetch` against the Firestore
REST API. Measured against the live project: **69 documents, 84 KB, under 300
ms**, where the SDK read was exceeding a 12-second timeout. The SDK remains the
fallback, in case a content blocker objects to the bare REST endpoint, and it is
still what powers the live entry feed, where streaming is the whole point.

The project id comes from `/__/firebase/init.json`, which is published to
`state.projectId` as soon as it resolves rather than waiting for the SDK, so
these reads are not stuck behind the 170 KB download either.

## A finished game is never invisible

Contest summaries are written by the scheduled archiver, but it can be behind,
or running an older revision of the script. That happened: the app was deployed
reading summaries while the Action was still on a commit that did not write
them, and twenty games went missing from Finished.

The page now rebuilds a missing summary itself, from the frozen roster and the
entries, using the same `buildSummary` the archiver uses. Verified by stripping
four stored summaries and rebuilding them in the page's own code path: all four
came back identical to what the archiver had written, in 329 ms for the four.
It is bounded to the newest `REBUILD_LIMIT` (12) games so a long outage cannot
turn it into an unbounded fan-out.

## Why the summary lives on the contest document

The Finished and Season tabs used to read every contest and then, for each one,
its entries subcollection and its frozen roster. At 40-odd archived games that
is ninety round trips. It worked at four contests and fell over at forty: the
Firestore channel wedged in Safari and the tab showed *Could not reach the
database*, with Season stuck on *Loading...* forever.

A finished game's standings can never change, so they are now computed once and
stored on the contest document as `summary` — champion, entry count, and the
ranked rows with each entrant's picks, points and season points. Both tabs read
a single query of about 57 KB.

`buildSummary` and `computeStandings` live in `public/scoring.js`, imported by
both the page and the archiver, so the two cannot drift apart. Verified: a
summary recomputed in the browser's code path is byte-identical to the one the
scheduled job stored.

A game someone watched to the end is summarised by their browser immediately, so
it appears under Finished without waiting for the next scheduled run. That path
deliberately uses the real entries only, never the synthetic TEST_MODE
predictions, which must not reach the database.

## Data model

```
entrants/{uid}                  { name, updatedAt }
config/discovery                { newest, updatedAt }   # archiver's frontier
contests/{tournamentId}         { tournamentId, gameStarted, title, venue, fieldSize,
                                  summary: { champion, entryCount, standings[] } }
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
