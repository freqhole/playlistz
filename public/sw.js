// playlistz service worker
//
// caches the app shell files (freqhole-playlistz.js, playlistz.js, index.html, sw.js).
// audio and image files in data/ are NOT pre-cached; the app ui handles that separately.
//
// bumping CACHE_VERSION forces all clients to receive fresh app files on next load.
const CACHE_VERSION = "v2";
const CACHE_NAME = `playlistz-${CACHE_VERSION}`;

// app shell files to cache on install
const APP_SHELL = [
  "freqhole-playlistz.js",
  "playlistz.js",
  "index.html",
  "sw.js",
];

// install: cache app shell and skip waiting so this sw activates immediately
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(APP_SHELL).catch((err) => {
        // some files may not exist (e.g. playlistz.js before first generate run)
        console.warn("playlistz sw: pre-cache partial failure:", err);
      }),
    ).then(() => self.skipWaiting()),
  );
});

// activate: delete old caches, claim all clients immediately
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n.startsWith("playlistz-") && n !== CACHE_NAME)
            .map((n) => caches.delete(n)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// fetch: cache-first for app shell files, network-pass-through for everything else
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const filename = url.pathname.split("/").pop() ?? "";
  const isAppShell = APP_SHELL.includes(filename) || url.pathname === "/" || url.pathname === "";

  if (!isAppShell) {
    return; // let browser handle data/ assets (audio, images)
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
        }
        return response;
      });
    }).catch(() => caches.match("index.html")),
  );
});

// message: handle reset/clear from the page via window.__playlistzReset()
self.addEventListener("message", (event) => {
  if (event.data?.type === "PLAYLISTZ_RESET") {
    event.waitUntil(
      caches.keys()
        .then((names) => Promise.all(names.map((n) => caches.delete(n))))
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((c) => c.postMessage({ type: "PLAYLISTZ_RESET_DONE" }))),
    );
  }
});


self.addEventListener("install", (event) => {
  console.log("playlistz service worker: installing...");
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        console.log("playlistz service worker: caching app shell");
        return cache.addAll(urlsToCache);
      })
      .catch((error) => {
        console.error(
          "playlistz service worker: failed to cache app shell:",
          error
        );
      })
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches
      .match(event.request)
      .then((response) => {
        // return cached version or fetch from network
        if (response) {
          return response;
        }
        return fetch(event.request);
      })
      .catch((error) => {
        console.error("playlistz service worker: fetch failed:", error);
        throw error;
      })
  );
});

self.addEventListener("activate", (event) => {
  console.log("playlistz service worker: activating...");
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log(
              "playlistz service worker: deleting old cache:",
              cacheName
            );
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
