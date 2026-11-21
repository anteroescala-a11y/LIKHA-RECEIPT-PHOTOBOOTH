/* Offline support: network first so updates arrive, cache as the fallback when the tablet is offline. */
const CACHE = 'rpb-v5';
const SHELL = [
  './', 'index.html', 'css/style.css',
  'js/imaging.js', 'js/compose.js', 'js/escpos.js', 'js/qr.js', 'js/share.js', 'js/app.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'media/splash.mp4',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;
  // Video is fetched in byte ranges, and partial responses cannot be cached: serve the stored
  // whole file when there is one, otherwise leave it to the network.
  if (req.headers.has('range')) {
    e.respondWith(caches.match(req.url).then((hit) => hit || fetch(req)));
    return;
  }
  e.respondWith(
    fetch(req)
      .then((res) => {
        // Also keeps the web fonts, so receipts look the same offline after the first online run.
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || Response.error()))
  );
});
