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
