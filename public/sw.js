// playlistz Service Worker
const CACHE_NAME = "playlistz-v1";
const urlsToCache = ["/", "/freqhole-playlistz.html", "/index.html"];

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
