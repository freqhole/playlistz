// service worker source inlined as a string.
// public/sw.js is kept in sync with this content.
// this string is embedded into zip bundles so they are fully self-contained.
//
// to reset all caches from the browser console:
//   await window.__playlistzReset()    (registered by web-component.tsx)
//
// to force a cache refresh, bump CACHE_VERSION below and rebuild.

const SW_JS_CONTENT = `// playlistz service worker
//
// caches the app shell files (freqhole-playlistz.js, playlistz.js, index.html, sw.js).
// audio and image files in data/ are NOT pre-cached; the app ui handles that separately.
//
// bumping CACHE_VERSION forces all clients to receive fresh app files on next load.
const CACHE_VERSION = "v2";
const CACHE_NAME = \`playlistz-\${CACHE_VERSION}\`;

const APP_SHELL = [
  "freqhole-playlistz.js",
  "playlistz.js",
  "index.html",
  "sw.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(APP_SHELL).catch((err) => {
        console.warn("playlistz sw: pre-cache partial failure:", err);
      }),
    ).then(() => self.skipWaiting()),
  );
});

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

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const filename = url.pathname.split("/").pop() ?? "";
  const isAppShell = APP_SHELL.includes(filename) || url.pathname === "/" || url.pathname === "";

  if (!isAppShell) return;

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
`;

export function generateSwJs(): string {
  return SW_JS_CONTENT;
}
