// Minimal zero-cache Service Worker for Tycho PWA installability.
// Intentionally does not cache HTML, /api/* responses, or SSE streams so the
// console always talks directly to the live host without stale disk caches.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if ('caches' in self) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
      await self.clients.claim();
    })(),
  );
});
