// Makes the playground cross-origin isolated, which SharedArrayBuffer needs, on
// a host that cannot send the headers for it: this service worker adds them to
// every response it passes on. index.html registers it only when the page is
// not isolated already.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const request = e.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin')
    return;
  e.respondWith(
    fetch(request).then(response => {
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );
});
