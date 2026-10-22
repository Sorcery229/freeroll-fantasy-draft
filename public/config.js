// public/config.js
//
// OPTIONAL. When this app is served by Firebase Hosting it reads the project's
// own SDK config from the reserved URL /__/firebase/init.json, so you do not
// need to fill anything in here — deploying is enough.
//
// Only fill this in if you serve the app from somewhere that is NOT Firebase
// Hosting (a plain web server, file://, etc.). These values are not secrets:
// Firebase web config is public by design and access is controlled by
// firestore.rules.

export const firebaseConfig = {
  // apiKey: "...",
  // authDomain: "...",
  // projectId: "...",
  // storageBucket: "...",
  // messagingSenderId: "...",
  // appId: "...",
};

// The live dashboard whose socket.io feed we read. No trailing slash.
export const FREEROLL_ORIGIN = "https://openbarleague.com";

// Tournaments listed on the Active Tournaments page. `?t=<id>` overrides it.
// Live-game discovery would need the dashboard's REST API, which sends no CORS
// headers, so the ids are configured here and the socket supplies everything
// else. Set this to tonight's tournament id(s).
export const FOLLOW_TOURNAMENT_IDS = [712];

// TEST MODE. While true the app:
//   * lets you submit picks even after the clock has started,
//   * stores those picks under contest id "test-<tournamentId>" instead of the
//     real contest, so nothing pollutes a genuine contest,
//   * never mirrors game_started to Firestore (so the test contest stays open),
//   * injects synthetic predictions attributed to real players in the field.
// Set to false for a real contest, where picks must close when the clock starts.
export const TEST_MODE = true;
