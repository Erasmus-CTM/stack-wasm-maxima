// SPDX-License-Identifier: AGPL-3.0-or-later
// Add isolation on static hosts that do not apply the supplied _headers file.
// No application resources or assessment results are cached by this worker.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const request = event.request;
  if (new URL(request.url).origin !== self.location.origin) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith(fetch(request).then(response => {
    if (response.type === 'opaque' || response.status === 0) return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    // These generated, public documents/assets are consumed by intentionally
    // opaque board frames. Keep the parent and all other resources restricted.
    // Match the static-server contract, including project/subdirectory hosting.
    const path = new URL(request.url).pathname;
    const boards = new URL('./native/boards/', self.location.href).pathname;
    const leaf = path.startsWith(boards) ? path.slice(boards.length) : '';
    const asset = leaf.startsWith('assets/') || leaf.startsWith('mathjax/');
    if (asset || /^[A-Za-z0-9_-]+\.html$/.test(leaf)) {
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      if (asset) headers.set('Access-Control-Allow-Origin', '*');
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }));
});
