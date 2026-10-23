// Load before the original MathJax 4 browser component. This file configures
// MathJax; it deliberately neither loads nor replaces the vendor script.
// Activation in JSXGraph is gated on a supported pre-loader hook.
(function () {
  'use strict';
  if (self.origin !== 'null') return;
  const config = window.MathJax || {};
  const startup = config.startup || {};
  // Authored startup code/adaptors own their lifecycle and transport. Leave
  // their configuration intact rather than silently replacing that behavior.
  if (startup.ready !== undefined ||
      (startup.adaptor != null && startup.adaptor !== 'browserAdaptor')) return;
  // Static hosts such as GitHub Pages expose CORS but cannot supply CORP.
  // This explicit consumer option adds CORS requests; the default transport
  // and authored loaders keep their existing ownership.
  const cors = document.currentScript?.getAttribute('data-ctm-mathjax-transport') === 'cors';
  if (cors && config.loader?.require == null) {
    config.loader = Object.assign({}, config.loader, {
      require(file) {
        return new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = file;
          script.charset = 'UTF-8';
          script.crossOrigin = 'anonymous';
          script.onload = resolve;
          script.onerror = () => reject(new Error('Cannot load MathJax component: ' + file));
          document.head.appendChild(script);
        });
      }
    });
  }
  config.startup = Object.assign({}, startup, {
    ready() {
      // Another component can select an adaptor after this pre-loader ran.
      if (MathJax.config.startup.adaptor !== 'browserAdaptor') {
        return MathJax.startup.defaultReady();
      }
      const browserAdaptor = MathJax.startup.constructors.browserAdaptor;
      const originalBrowserAdaptor = MathJax._?.adaptors?.browserAdaptor?.browserAdaptor;
      if (!originalBrowserAdaptor || browserAdaptor !== originalBrowserAdaptor) {
        return MathJax.startup.defaultReady();
      }
      MathJax.startup.registerConstructor('ctmOpaqueWorkerAdaptor', function () {
        const adaptor = browserAdaptor(MathJax.config.browserAdaptor);
        adaptor.createWorker = async function (listener, options) {
          const file = options.path + '/' + options.worker;
          // Serialize configuration as data: no supplied value is executable
          // source. This runs MathJax's original SRE worker and mathmaps.
          let workerSource = file;
          if (cors) {
            const response = await fetch(file, {mode: 'cors', credentials: 'omit'});
            if (!response.ok) throw new Error('Cannot load MathJax worker: ' + response.status + ' ' + file);
            // Import the unchanged official worker bytes. Its absolute maps
            // URL still belongs to MathJax; fetch and worker errors propagate.
            workerSource = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(await response.text());
          }
          const source = 'self.maps = ' + JSON.stringify(options.maps) +
            '; importScripts(' + JSON.stringify(workerSource) + ');';
          const worker = new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(source));
          worker.onmessage = listener;
          return worker;
        };
        return adaptor;
      });
      MathJax.startup.useAdaptor('ctmOpaqueWorkerAdaptor', true);
      return MathJax.startup.defaultReady();
    }
  });
  window.MathJax = config;
})();

