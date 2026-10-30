// Offline app shell. Map data itself is cached separately in IndexedDB (src/cache.ts).
//
// Install: save every file in the build (listed in precache.json), so the app reopens
//   offline after a single visit.
// Pages: network first, so a new deploy shows up right away; fall back to cache offline.
// Static assets (hashed by Vite): cache first, they never change under the same name.

const PREFIX = 'greenfield-shell-';

const manifest = () => fetch('/precache.json', { cache: 'no-store' }).then(r => r.json());

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const { version, files } = await manifest();
      await (await caches.open(PREFIX + version)).addAll(files);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // Keep only this build's cache.
      const current = PREFIX + (await manifest()).version;
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== current).map(k => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

/** The cache to write into: the one this build created (there's only one after activate). */
async function currentCache() {
  const key = (await caches.keys()).find(k => k.startsWith(PREFIX)) ?? `${PREFIX}runtime`;
  return caches.open(key);
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  // Never cache the precache list or API responses (the map token must always be fresh).
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === '/precache.json' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          const copy = res.clone();
          currentCache().then(c => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      hit =>
        hit ||
        fetch(request).then(res => {
          if (res.ok) {
            const copy = res.clone();
            currentCache().then(c => c.put(request, copy));
          }
          return res;
        }),
    ),
  );
});
