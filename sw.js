/* â•â• SERVICE WORKER â€“ Sakhi Sang â•â• */
// Bump this version string every time you deploy new code.
// This tells the browser to throw away old cached files and install fresh ones.
const CACHE = 'sakhi-sang-v406';
const SHELL = [
  './index.html',
  './js/config.js',
  './js/db.js',
  './js/excel.js',
  './js/ui-core.js',
  './js/ui-home.js',
  './js/ui-devotees.js',
  './js/ui-calling.js',
  './js/ui-attendance.js',
  './js/ui-analytics.js',
  './js/ui-activities.js',
  './js/ui-ai-chat.js',
  './js/xlsx-js-style.bundle.js',
  './css/style.css',
  './icon-192.png',
  './icon-512.png',
  './icons/icon.svg',
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Nunito:wght@300;400;500;600;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
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
  const url = e.request.url;

  // Firebase / Firestore: always bypass cache, go straight to network
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebase') ||
      url.includes('googleapis.com/v1') ||
      url.includes('identitytoolkit')) {
    return;
  }

  // App JS files: network-first, cached fallback.
  // This guarantees users get fresh code after every deployment
  // without needing a hard refresh. Falls back to cache when offline.
  if (url.includes('/js/')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // HTML navigation: network-first so the shell is always fresh,
  // cached fallback for offline use.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Everything else (fonts, icons, CDN libraries, CSS):
  // cache-first â€” these rarely change and benefit from instant loading.
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => {
        if (e.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
