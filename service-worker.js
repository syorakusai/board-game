importScripts("app-version.js");
const scopeUrl = new URL(self.registration.scope);
const development = /\/board-game\/dev\/$/.test(scopeUrl.pathname);
const CACHE_PREFIX = `kizoku-no-hisomegoto-${development ? "dev" : "prod"}-`;
const CACHE_NAME = `${CACHE_PREFIX}${self.APP_VERSION || "dev"}`;
const APP_SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "environment.js",
  "app-version.js",
  "card-data.js",
  "game-rules.js",
  "game-state.js",
  "round-candidates.js",
  "roulette.js",
  "card-sets.json",
  "manifest.webmanifest",
  "assets/pwa-icon-192.png",
  "assets/pwa-icon-512.png"
];

APP_SHELL.push("firebase-config.js", "firebase-client.js", "multiplayer-phase1.js");

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const request = event.request;
  const url = new URL(request.url);
  if (!development && url.pathname.startsWith(new URL("dev/", scopeUrl).pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put("./", copy));
      return response;
    }).catch(() => caches.match("./")));
    return;
  }
  const appShellFile = APP_SHELL.map(file => new URL(file, scopeUrl).pathname).includes(url.pathname);
  if (appShellFile) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request)));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok && new URL(request.url).origin === self.location.origin) {
      caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    }
    return response;
  })));
});
