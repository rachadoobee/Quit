/**
 * service-worker.js — offline support for QuitSnus
 *
 * Strategy: cache-first. On install we pre-cache the app shell. On fetch we
 * serve from cache and fall back to the network, caching new GET responses as
 * we go (so the Chart.js CDN file is cached after the first online load).
 */

const CACHE_NAME = 'quitsnus-v3';

// App shell assets to pre-cache on install.
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/db.js',
  './js/taper.js',
  './js/achievements.js',
  './js/notifications.js',
  './js/charts.js',
  './js/app.js',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
];

// Install: pre-cache the shell, then activate immediately.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // addAll is atomic; use individual adds so one CDN miss doesn't fail all.
      Promise.allSettled(PRECACHE.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches and take control.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first, then network (and cache successful GETs).
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          // Cache valid same-origin and CDN responses for next time.
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline and not cached → undefined
    })
  );
});

// Notification click: focus an existing window or open the app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
