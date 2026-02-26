// Dither Studio — Service Worker
// Network-first with cache fallback for offline support

const CACHE_NAME = 'dither-studio-v5';
// Use relative paths for GitHub Pages subdirectory compatibility
const APP_SHELL = [
  './',
  './index.html',
  './app.js?v=5',
  './dither-worker.js?v=5',
  './transport-worker.js?v=5',
  './palettes.js?v=5',
  './pipeline.js?v=5',
  './export.js?v=5',
  './manifest.json?v=5',
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
