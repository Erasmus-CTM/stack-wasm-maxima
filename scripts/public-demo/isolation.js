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
      if (sessionStorage.getItem(key) === workerURL.href) throw new Error('Isolation did not activate after the first reload');
      sessionStorage.setItem(key, workerURL.href);
      location.reload();
    })
    .catch(failure);
})();
