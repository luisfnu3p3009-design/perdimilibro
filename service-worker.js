// perdimilibro service worker — cache simple, network-first para HTML, cache-first para estáticos
// Bump VERSION en cada deploy para invalidar cache.
const VERSION = 'v0.2.0';
const CACHE = `perdimilibro-${VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/terminos.html',
  '/privacidad.html'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Nunca cachear:
  //  - Llamadas al backend de scan (/api/...) → siempre live, son POST.
  //  - APIs externas de metadata por ISBN (Google Books, Open Library).
  if (url.pathname.startsWith('/api/')) return;
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('openlibrary.org')) {
    return;
  }

  // HTML: network-first (para que los deploys se vean rápido).
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
    );
    return;
  }

  // Resto (CSS, JS, imágenes, fuentes): cache-first.
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return resp;
    }))
  );
});
