// Service Worker — Proto Viewer auth guard + comment widget injector
// Intercepts direct navigation to protos/ : blocks if not authenticated,
// otherwise injects comment-widget.js so comments work on direct proto URLs.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle direct navigation (address bar / link click) to protos/*.html
  if (event.request.mode === 'navigate' && /\/protos\/.+\.html?$/i.test(url.pathname)) {
    event.respondWith(
      caches.has('pv-auth').then(async (hasAuth) => {

        // ── Not authenticated → redirect to the viewer login ──
        if (!hasAuth) {
          const base = url.pathname.replace(/\/protos\/.*$/, '/');
          return new Response(
            `<!DOCTYPE html><html><head><meta charset="utf-8">` +
            `<meta http-equiv="refresh" content="0;url=${base}">` +
            `</head><body><p>Redirection...</p></body></html>`,
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        }

        // ── Skip injection for iframe/frame navigations ──
        // The viewer loads protos in <iframe> — those requests also have mode:'navigate'
        // but Sec-Fetch-Dest is 'iframe', not 'document'. Only inject for top-level
        // navigations (user opening the proto URL directly in a new tab).
        const dest = event.request.headers.get('Sec-Fetch-Dest');
        if (dest === 'iframe' || dest === 'frame') {
          return fetch(event.request);
        }

        // ── Authenticated top-level navigation → fetch and inject the comment widget ──
        try {
          const response = await fetch(event.request);

          // Pass through non-HTML or error responses untouched
          const ct = response.headers.get('content-type') || '';
          if (!response.ok || !ct.includes('html')) return response;

          const html = await response.text();

          // Derive the repo base path  (e.g. "/proto-viewer/")
          const repoBase = url.pathname.replace(/\/protos\/.*$/, '/');

          // We inject two <script> tags:
          //   1. A tiny config snippet that exposes the repo base to the widget
          //   2. The widget script itself
          const injection =
            `<script>window.__PV_REPO = "${repoBase}";<\/script>\n` +
            `<script src="${repoBase}comment-widget.js"><\/script>`;

          // Insert before </body>; fall back to appending if tag is missing
          const injected = /<\/body>/i.test(html)
            ? html.replace(/<\/body>/i, injection + '\n</body>')
            : html + '\n' + injection;

          return new Response(injected, {
            status:     response.status,
            statusText: response.statusText,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });

        } catch {
          // Network failure — let the browser handle it normally
          return fetch(event.request);
        }
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
