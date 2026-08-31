// service-worker.js — KIMA EIS app-shell cache.
// Only registers when served over http(s) (see app.js: registerServiceWorkerIfHosted).
// Under file://, this file is never fetched or executed — the app already
// works fully offline in that mode via IndexedDB with no network dependency.

const CACHE_NAME = 'kima-eis-shell-v8';
const SHELL_ASSETS = [
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './import.js',
  './graph.js',
  './impact.js',
  './decision.js',
  './topology.js',
  './manifest.webmanifest',
  './lib/xlsx.full.min.js',
];

self.addEventListener('install', (event) => {
  // M-26/ADR-034: skipWaiting() is deliberately NOT called here
  // unconditionally anymore. It used to be, which meant a newly-installed
  // worker activated and took control of already-open pages immediately
  // and silently — before app.js's update banner even existed to ask the
  // user first. Activation is now driven exclusively by the SKIP_WAITING
  // message below, sent only when the user clicks the banner's reload
  // button, so a page stays on its already-loaded (and cache-matching)
  // version until the user deliberately opts into the update.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
  );
});

// M-26/ADR-034: the sole trigger for this worker taking over. app.js's
// update banner posts this message only after the user clicks its
// reload button (see showServiceWorkerUpdateBanner in app.js); it is
// no longer redundant to an automatic call, since none exists anymore.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

// Cache-first for the app shell; falls back to network for anything else
// (there is no "anything else" in the offline-first design, but this keeps
// the worker safe if new same-origin assets are added later).
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => cached);
    })
  );
});
