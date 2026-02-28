// Dither Studio — Service Worker
// Network-first with cache fallback for offline support

const CACHE_NAME = 'dither-studio-v9';
// Use relative paths for GitHub Pages subdirectory compatibility
const APP_SHELL = [
  './',
  './index.html',
  './app.js?v=10',
  './dither-worker.js?v=10',
  './transport-worker.js?v=10',
  './palettes.js?v=10',
  './pipeline.js?v=10',
  './export.js?v=10',
  './manifest.json?v=10',
];

// Precache app shell on install — skip waiting immediately
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Clean ALL old caches on activate, claim clients immediately
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== CACHE_NAME)
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Network-first: always try to fetch fresh, fall back to cache for offline
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
