// Dither Studio — Service Worker
// Stale-while-revalidate caching for offline support

const CACHE_NAME = 'dither-studio-v3';
const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js?v=3',
  '/dither-worker.js',
  '/transport-worker.js',
  '/palettes.js?v=3',
  '/pipeline.js?v=3',
  '/export.js?v=3',
  '/manifest.json?v=3',
];

// Precache app shell on install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Clean old caches on activate
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

// Stale-while-revalidate: serve from cache, update in background
self.addEventListener('fetch', event => {
  // Only handle same-origin GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(event.request).then(cached => {
        const fetchPromise = fetch(event.request).then(response => {
          if (response.ok) {
            cache.put(event.request, response.clone());
          }
          return response;
        }).catch(() => cached);

        return cached || fetchPromise;
      })
    )
  );
});
