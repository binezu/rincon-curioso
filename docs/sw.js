// la app abre aunque no haya señal (con lo ultimo que se cargo); los datos siempre se piden nuevos primero
const C = 'rincon-v1';
const BASE = ['./', 'index.html', 'app.js', 'app.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(BASE))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    const copia = r.clone(); caches.open(C).then(c => c.put(e.request, copia)); return r;
  }).catch(() => caches.match(e.request)));
});
