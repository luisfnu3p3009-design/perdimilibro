// perdimilibro service worker — v0.4
// Estrategia:
//   - network-first para HTML (los deploys se ven al instante)
//   - cache-first para CSS/JS/imágenes
//   - nunca cachear: /api/*, llamadas a Supabase, Google Books, Open Library
// Bumpear VERSION en cada deploy para invalidar caches viejos.

const VERSION = 'v0.4.0';
const CACHE = `perdimilibro-${VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/auth.css',
  '/app.js',
  '/db.js',
  '/auth.js',
  '/supabase.js',
  '/migrate.js',
  '/config.js',
  '/manifest.json',
  '/terminos.html',
  '/privacidad.html',
  '/login.html',
  '/signup.html',
  '/forgot-password.html',
  '/reset-password.html'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE).catch(err => {
        // Si algún archivo falla (ej. config.js no creado todavía), seguir.
        console.warn('Precache parcial:', err);
      }))
      .then(() => self.skipWaiting())
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

  // Nunca interceptar:
  //  - llamadas al backend serverless (/api/...) → son POST y/o sensibles
  //  - APIs de metadata externa (Google Books, Open Library)
  //  - Supabase (auth + REST + Realtime). Token rotativo, no debe cachearse.
  if (url.pathname.startsWith('/api/')) return;
  if (url.hostname.includes('googleapis.com')) return;
  if (url.hostname.includes('openlibrary.org')) return;
  if (url.hostname.includes('supabase.co'))     return;
  if (url.hostname.includes('supabase.in'))     return;

  // HTML: network-first
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

  // Resto (CSS, JS, imágenes, fuentes): cache-first
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return resp;
    }))
  );
});
