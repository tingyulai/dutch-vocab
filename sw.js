// Offline cache: serve app files from cache, refresh them in the background.
const CACHE = 'dutch-vocab-v17';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon.svg', './apple-touch-icon.png', './words.csv',
  ...Array.from({ length: 9 }, (_, i) => `./covers/cover-${i + 1}.jpg`)];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Other sites (the Google Sheet, fonts) go straight to the network; the app keeps its own offline copy.
  if (new URL(e.request.url).origin !== location.origin) return;
  // The word list changes when edited: always try the network first, use the cached copy offline.
  if (new URL(e.request.url).pathname.endsWith('/words.csv')) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('./words.csv', copy));
        }
        return res;
      }).catch(() => caches.match('./words.csv'))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
