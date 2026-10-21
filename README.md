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

`public/scoring.js`, identical maths to the dashboard branch:

```
finishPoints = 100 * ((N - place) / (N - 1)) ^ 3
knockoutPoints = knockouts * 2
```

In a 27-player field: 1st = 100, 3rd = 78.7, 5th = 60.6, 9th = 33.2,
14th = 12.5, 20th = 2.0; the best possible 5-pick entry is 397.4. Because the
base is the *fraction of the field beaten*, a 9-player game and a 27-player
game produce comparable scores, which is what makes the season leaderboard
meaningful.

Players still in are scored at the place they would take if they busted on the
next hand, so live scores climb as the field shrinks.

One difference from the dashboard version: the socket payload exposes
`hitman_name` but not `hitman_uid`, so knockouts are credited by name match.
Player names are unique within a tournament (`unique_player_per_tournament` in
the database), so this is exact within a contest.

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
