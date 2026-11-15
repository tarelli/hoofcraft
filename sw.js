// Offline support for Hoofcraft. Bump CACHE when the file list changes.
const CACHE = 'hoofcraft-v1';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'fonts/press-start-2p.woff2', 'fonts/vt323.woff2', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  // Only the game's own files are cached; leaderboard calls go straight to the network.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const isPage = request.mode === 'navigate' || request.destination === 'document';
  event.respondWith(isPage ? networkFirst(request) : cacheFirst(request));
});

// The page itself: newest version when online, cached copy when offline.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put('index.html', response.clone());
    return response;
  } catch {
    return (await cache.match('index.html')) || Response.error();
  }
}

// Fonts and icons never change under the same name.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
