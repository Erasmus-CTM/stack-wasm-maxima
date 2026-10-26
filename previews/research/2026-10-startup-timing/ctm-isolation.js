// SPDX-License-Identifier: AGPL-3.0-or-later
(() => {
  if (self.crossOriginIsolated) return;
  const scriptURL = document.currentScript.src;
  const workerURL = new URL('ctm-isolation-worker.js', scriptURL);
  const key = 'ctm-public-isolation-reload-v1';
  const failure = error => {
    console.error('Assessment environment could not be prepared', error);
    const show = () => {
      const message = document.createElement('p');
      message.setAttribute('role', 'alert');
      message.textContent = 'This browser could not prepare the assessment environment. Open this page in a current browser tab and reload.';
      document.body.prepend(message);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true });
    else show();
  };
  if (!self.isSecureContext || !('serviceWorker' in navigator)) {
    failure(new Error('A secure browser with service worker support is required'));
    return;
  }
  navigator.serviceWorker.register(workerURL.href, { scope: new URL('.', workerURL).pathname })
    .then(() => navigator.serviceWorker.ready)
    .then(async () => {
      if (!navigator.serviceWorker.controller) {
        await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      }
      if (self.crossOriginIsolated) return;
      // Finish the initial document's existing work before navigating. A
      // first-visit isolation reload must not abort styles/fonts or MathJax
      // that the ordinary document has already started loading.
      if (document.readyState !== 'complete') {
        await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
      }
      if (window.MathJax?.startup?.promise) await window.MathJax.startup.promise;
      if (document.fonts?.ready) {
        // MathJax can append font-using nodes at the end of startup. Let their
        // styles participate in layout before observing the font-set promise.
        await new Promise(resolve => window.requestAnimationFrame(() => {
          document.body?.getBoundingClientRect();
          resolve();
        }));
        await document.fonts.ready;
        // Commit a frame using the loaded faces before discarding this document.
        await new Promise(resolve => window.requestAnimationFrame(resolve));
      }
      if (sessionStorage.getItem(key) === workerURL.href) throw new Error('Isolation did not activate after the first reload');
      sessionStorage.setItem(key, workerURL.href);
      location.reload();
    })
    .catch(failure);
})();
