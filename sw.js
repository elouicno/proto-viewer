// Service Worker — Proto Viewer auth guard
// Intercepts direct navigation to protos/ and blocks if not authenticated

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only intercept direct navigation to protos/*.html
  if (event.request.mode === 'navigate' && /\/protos\/.+\.html?$/i.test(url.pathname)) {
    event.respondWith(
      caches.has('pv-auth').then((hasAuth) => {
        if (hasAuth) {
          return fetch(event.request);
        }
        // Redirect to login page
        const base = url.pathname.replace(/\/protos\/.*$/, '/');
        return new Response(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${base}"></head><body><p>Redirection...</p></body></html>`,
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      })
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'pv-auth-login') {
    caches.open('pv-auth').then((c) => c.put('/pv-token', new Response('1')));
  } else if (event.data === 'pv-auth-logout') {
    caches.delete('pv-auth');
  }
});
