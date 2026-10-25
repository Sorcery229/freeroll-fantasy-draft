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

// SEED only. The app discovers live tournaments by itself: it probes a window
// of ids over the socket and keeps whichever report status "in_progress",
// remembering the newest id it has seen so later visits start from there. This
// list just gives it a starting point on a browser that has never run it, and
// `?t=<id>` still overrides everything.
export const FOLLOW_TOURNAMENT_IDS = [717];

// TEST MODE. While true the app:
//   * lets you submit picks even after the clock has started,
//   * stores those picks under contest id "test-<tournamentId>" instead of the
//     real contest, so nothing pollutes a genuine contest,
//   * never mirrors game_started to Firestore (so the test contest stays open),
//   * injects synthetic predictions attributed to real players in the field.
// Set to false for a real contest, where picks must close when the clock starts.
export const TEST_MODE = true;
