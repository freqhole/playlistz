// service worker source inlined as a string.
// public/sw.js is kept in sync manually - it is served at /sw.js by vite dev
// server and copied as-is on build. this string is used when bundling sw.js
// into a zip download so the zip is self-contained.

const SW_JS_CONTENT = `// playlistz Service Worker
const CACHE_NAME = "playlistz-v1";
const urlsToCache = ["/", "/freqhole-playlistz.html", "/index.html", "/playlistz.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(urlsToCache);
      })
      .catch((error) => {
        console.error("playlistz service worker: failed to cache app shell:", error);
      })
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches
      .match(event.request)
      .then((response) => {
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
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
`;

export function generateSwJs(): string {
  return SW_JS_CONTENT;
}
