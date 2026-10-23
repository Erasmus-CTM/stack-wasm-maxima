// SPDX-License-Identifier: AGPL-3.0-or-later
// Bind existing CTM question controls to a jsxgraph-quarto iframe.
(function (scope) {
  'use strict';
  const PROTOCOL = 'ctm-stack-jsxgraph', VERSION = 1;
  const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
  const MAX_VALUE = 32768, MAX_CONTENT = 262144, MAX_INPUTS = 32;
  const attached = new WeakMap(), cards = new WeakMap();
  const templateLoads = new Map();
  const coreLoads = new Map();
  let epochSequence = 0;
  function nonce() {
    if (scope.crypto?.randomUUID) return scope.crypto.randomUUID();
    return Date.now().toString(36) + '-' + (++epochSequence) + '-' + Math.random().toString(36).slice(2);
  }
  function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function coreDataURL(url, digest, size) {
    if (!/^[a-f0-9]{64}$/.test(digest) || !/^[1-9][0-9]*$/.test(size) || !Number.isSafeInteger(Number(size)) ||
        url.search || url.hash || !url.pathname.endsWith('/native/boards/assets/'+digest+'.js')) throw new Error('Invalid content-addressed JSXGraph core marker');
    const key=url.href+'|'+digest+'|'+size;
    if (!coreLoads.has(key)) {
      const loading=(async () => {
        if (!scope.crypto?.subtle || typeof scope.btoa !== 'function') throw new Error('Native board core integrity requires a secure browser context');
        const response=await scope.fetch(url.href);
        if (!response.ok) throw new Error('JSXGraph core request failed: '+response.status);
        const bytes=new Uint8Array(await response.arrayBuffer());
        if (bytes.length!==Number(size)) throw new Error('JSXGraph core byte count mismatch');
        const actual=Array.from(new Uint8Array(await scope.crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
        if (actual!==digest) throw new Error('JSXGraph core SHA-256 mismatch');
        let binary='';
        for(let at=0;at<bytes.length;at+=32768)binary+=String.fromCharCode.apply(null,bytes.subarray(at,at+32768));
        return 'data:text/javascript;base64,'+scope.btoa(binary);
      })();
      coreLoads.set(key,loading);
      loading.catch(()=>{if(coreLoads.get(key)===loading)coreLoads.delete(key);});
    }
    return coreLoads.get(key);
  }
  function descriptor(value) {
    if (typeof value === 'string') value = JSON.parse(value);
    if (!plain(value) || typeof value.assessmentId !== 'string' || !value.assessmentId || value.assessmentId.length > 256 ||
        !Array.isArray(value.inputs) || value.inputs.length > MAX_INPUTS || new Set(value.inputs).size !== value.inputs.length ||
        !value.inputs.every(name => typeof name === 'string' && NAME.test(name))) throw new Error('Invalid STACK JSXGraph descriptor');
    const boardValues = value.boardValues === undefined ? {} : value.boardValues;
    if (!plain(boardValues) || Object.keys(boardValues).length > 128 || !Object.entries(boardValues).every(([key, entry]) =>
        /^[A-Za-z0-9_]{1,64}$/.test(key) && typeof entry === 'number' && Number.isFinite(entry))) throw new Error('Invalid STACK JSXGraph board values');
    return {assessmentId:value.assessmentId, inputs:[...value.inputs], boardValues:{...boardValues}};
  }
  function attachIframe(frame, supplied) {
    if (attached.has(frame)) return attached.get(frame);
    const spec = descriptor(supplied || frame.getAttribute('data-stack-jsxgraph'));
    const card = frame.closest('section.stack-sympy');
    if (!card) throw new Error('A STACK graphical board must belong to one CTM question');
    const allowed = new Set(spec.inputs), revisions = new Map(spec.inputs.map(name => [name, 0]));
    const buttons = new Map(), retiredInstances = new Set(), collections = new Map();
    if (!cards.has(card)) cards.set(card, {handles:new Set(), replaying:false, busy:false});
    const cardState = cards.get(card);
    let generation = nonce(), epoch = ++epochSequence, instanceId = null, disconnected = false, acceptingHello = true;
    let previousState = '', scheduled = false, lastAction = '', errorOutput = null, boardReady = false;
    const originalSrcdoc = frame.getAttribute('srcdoc');
    const originalSrc = frame.getAttribute('src');
    const templatePath = frame.getAttribute('data-stack-jsxgraph-template');
    let templateURL = null, mountSequence = 0, templatePending = false;
    let blankNavigation = false, pendingBlankMount = null;
    if (templatePath !== null) {
      if (!/^\.\.\/native\/boards\/[A-Za-z0-9_-]+\.html$/.test(templatePath)) throw new Error('Invalid native board template URL');
      templateURL = new URL(templatePath, frame.ownerDocument.baseURI);
      if (!/^https?:$/.test(templateURL.protocol) || templateURL.origin !== new URL(frame.ownerDocument.baseURI).origin) throw new Error('Native board templates must be same-origin');
    }
    frame.setAttribute('data-stack-jsxgraph-ready', 'false');
    function input(name) {
      if (!allowed.has(name)) throw new Error('STACK input is not bound to this board: ' + String(name));
      const matches = Array.from(card.querySelectorAll('.stack-answer[data-name]')).filter(item => item.dataset.name === name);
      if (matches.length !== 1 || typeof matches[0].value !== 'string') {
        throw new Error('The graphical board requires one supported text input: ' + name);
      }
      return matches[0];
    }
    for (const name of spec.inputs) input(name);
    function current() { return !disconnected && frame.isConnected !== false && card.contains(frame); }
    function contentElement(id) {
      return Array.from(card.querySelectorAll('[id]')).find(item => item.id === id) || null;
    }
    function validation(name, target) {
      const field = Array.from(card.querySelectorAll('.stack-validation[data-name]')).find(item => item.dataset.name === name);
      const result = card.querySelector('.stack-result');
      if (result?.dataset.state === 'loading' && lastAction === 'validate') return {complete:false, valid:null};
      if (field?.dataset.state === 'valid' || field?.dataset.state === 'invalid') {
        return {complete:true, valid:field.dataset.state === 'valid'};
      }
      const invalid = target.getAttribute('aria-invalid');
      return invalid === 'true' || invalid === 'false' ? {complete:true, valid:invalid === 'false'} : {complete:false, valid:null};
    }
    function snapshot() {
      return {inputs:Object.fromEntries(spec.inputs.map(name => {
        const target = input(name);
        const value = target.value;
        if (value.length > MAX_VALUE) throw new Error('The graphical response exceeds the input limit');
        const metadata = Object.fromEntries(Object.entries(target.dataset).filter(([key, entry]) =>
          key.startsWith('stack') && key.length <= 80 && typeof entry === 'string' && entry.length <= 256));
        if (!metadata.stackInputType) metadata.stackInputType = target.getAttribute('data-stack-input-type') || 'algebraic';
        if (!metadata.stackInputDecimalSeparator) metadata.stackInputDecimalSeparator = '.';
        if (!metadata.stackInputListSeparator) metadata.stackInputListSeparator = ',';
        return [name, {value, revision:revisions.get(name), metadata,
          readonly:target.hasAttribute('readonly') || target.disabled === true, validation:validation(name, target)}];
      }))};
    }
    function post(data) {
      if (!current() || !instanceId) return;
      frame.contentWindow.postMessage({protocol:PROTOCOL, version:VERSION, assessmentId:spec.assessmentId,
        instanceId, generation, ...data}, '*');
    }
    function initialize() {
      const state = snapshot(); previousState = JSON.stringify(state);
      post({type:'init', epoch, state, boardValues:spec.boardValues});
      layout();
    }
    function sync() {
      scheduled = false;
      if (!current() || !instanceId) return;
      try {
        const state = snapshot(), text = JSON.stringify(state);
        if (text !== previousState) { previousState = text; post({type:'state', state}); }
      } catch (error) { showError(error.message); }
    }
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => { if (!disconnected) sync(); });
    }
    function layout() {
      if (!current()) return;
      frame.contentWindow.postMessage({protocol:'jsxgraph-quarto-assessment', version:1,
        type:'layout', assessmentId:spec.assessmentId}, '*');
    }
    function reloadFrame() {
      if (!current()) return;
      if (templateURL) {
        const ticket = ++mountSequence;
        templatePending = true; acceptingHello = false;
        const url = templateURL.href;
        if (!templateLoads.has(url)) {
          const loading = scope.fetch(url).then(response => {
            if (!response.ok) throw new Error('Native board template request failed: ' + response.status);
            return response.text();
          }).then(async html => {
            const document = new scope.DOMParser().parseFromString(html,'text/html');
            if (!/<head>/i.test(html) || document.querySelector('base')) throw new Error('Invalid native board template document');
            const base = document.createElement('base'); base.href = url;
            document.head.prepend(base);
            // Firefox's srcdoc speculative scanner can fetch before honoring
            // base. Resolve static attributes explicitly; inline author/vendor
            // script text stays untouched. Keep base for imports and CSS URLs.
            const coreMounts=[];
            for (const node of document.querySelectorAll('script[src],link[href]')) {
              const attribute = node.hasAttribute('src') ? 'src' : 'href';
              const resource = new URL(node.getAttribute(attribute),url);
              if (!/^https?:$/.test(resource.protocol) || resource.origin !== templateURL.origin) throw new Error('Native board template resources must be staged same-origin');
              node.setAttribute(attribute,resource.href);
              if (node.hasAttribute('data-ctm-jsxgraph-sha256')) {
                if (attribute!=='src') throw new Error('JSXGraph core marker requires a script');
                coreMounts.push(coreDataURL(resource,node.getAttribute('data-ctm-jsxgraph-sha256'),node.getAttribute('data-ctm-jsxgraph-bytes'))
                  .then(data=>node.setAttribute('src',data)));
              }
            }
            await Promise.all(coreMounts);
            return '<!doctype html>\n'+document.documentElement.outerHTML;
          });
          templateLoads.set(url,loading);
          loading.catch(() => { if (templateLoads.get(url) === loading) templateLoads.delete(url); });
        }
        templateLoads.get(url).then(html => {
          if (!current() || ticket !== mountSequence) return;
          const apply = () => {
            if (!current() || ticket !== mountSequence) return;
            templatePending = false;
            if (errorOutput) { errorOutput.remove(); errorOutput = null; }
            frame.setAttribute('srcdoc', html);
          };
          // Complete a real document retirement before reusing srcdoc. Firefox
          // can otherwise retain an inaccessible execution context on reset.
          if (blankNavigation) pendingBlankMount = apply;
          else if (frame.hasAttribute('srcdoc')) {
            blankNavigation = true; pendingBlankMount = apply;
            frame.removeAttribute('srcdoc');
            frame.setAttribute('src', 'about:blank');
          } else apply();
        }).catch(error => {
          if (!current() || ticket !== mountSequence) return;
          templatePending = false;
          showError(error.message);
        });
        return;
      }
      // Native packaging links one shared Quarto-rendered template. Legacy
      // data: and srcdoc documents retain the same navigation/reset behavior.
      if (originalSrcdoc !== null) frame.setAttribute('srcdoc', originalSrcdoc);
      else if (originalSrc !== null) frame.setAttribute('src', originalSrc);
      else showError('The graphical board has no original document to restore');
    }
    function invalidate(reload) {
      mountSequence++; templatePending = false; pendingBlankMount = null;
      if (instanceId) retiredInstances.add(instanceId);
      instanceId = null; generation = nonce(); epoch = ++epochSequence; previousState = '';
      boardReady = false; frame.setAttribute('data-stack-jsxgraph-ready', 'false');
      for (const name of spec.inputs) revisions.set(name, revisions.get(name) + 1);
      for (const [target, listener] of buttons) target.removeEventListener('click', listener);
      buttons.clear();
      for (const row of collections.values()) {
        clearTimeout(row.timer); row.reject(new Error('The question was reset or its variant changed'));
      }
      collections.clear();
      if (reload) reloadFrame();
    }
    function hostInput(event) {
      const target = event.target;
      if (target?.matches?.('.stack-answer[data-name]') && allowed.has(target.dataset.name)) {
        revisions.set(target.dataset.name, revisions.get(target.dataset.name) + 1); schedule();
      }
    }
    function click(event) {
      const validate = event.target?.closest?.('.stack-validate'), check = event.target?.closest?.('.stack-check');
      if (validate || check) {
        lastAction = validate ? 'validate' : 'grade'; schedule();
        if (!cardState.replaying) {
          event.preventDefault(); event.stopImmediatePropagation();
          if (!cardState.busy) {
            cardState.busy = true;
            const button = validate || check;
            const currentHandles = Array.from(cardState.handles);
            const generations = currentHandles.map(handle => handle.generation());
            Promise.all(currentHandles.map(handle => handle.collect())).then(() => {
              if (!currentHandles.every((handle, index) => handle.current() && handle.generation() === generations[index])) return;
              cardState.replaying = true;
              try { button.click(); } finally { cardState.replaying = false; }
            }).catch(error => {
              if (currentHandles.every((handle, index) => handle.current() && handle.generation() === generations[index])) showError(error.message);
            }).finally(() => { cardState.busy = false; });
          }
        }
      }
      else if (event.target?.closest?.('.stack-reset')) {
        acceptingHello = false;
        invalidate(false);
        // The shared CTM clear() changes values without input events. Rebuild
        // the author board after it completes, restoring its initial geometry.
        queueMicrotask(reloadFrame);
      }
    }
    function change(event) {
      if (event.target?.matches?.('.stack-variant')) { acceptingHello = false; invalidate(false); }
      else hostInput(event);
    }
    function reset() { acceptingHello = false; invalidate(false); queueMicrotask(reloadFrame); }
    function loaded() {
      if (blankNavigation) {
        blankNavigation = false;
        const mount = pendingBlankMount; pendingBlankMount = null;
        if (mount) mount();
        return;
      }
      if (!templatePending) acceptingHello = true;
      layout();
    }
    function receive(event) {
      const data = event.data;
      if (current() && event.source === frame.contentWindow && plain(data) && data.protocol === 'jsxgraph-quarto-assessment' &&
          data.version === 1 && data.type === 'response' && data.assessmentId === spec.assessmentId &&
          typeof data.requestId === 'string' && collections.has(data.requestId)) {
        const row = collections.get(data.requestId);
        collections.delete(data.requestId); clearTimeout(row.timer);
        if (row.generation !== generation || row.instanceId !== instanceId) {
          row.reject(new Error('The graphical input changed while collecting its response')); return;
        }
        try {
          if (typeof data.error === 'string') throw new Error(data.error.slice(0, 4096));
          const values = data.payload?.inputs;
          if (!plain(values) || Object.keys(values).length !== spec.inputs.length || !spec.inputs.every(name =>
            Object.prototype.hasOwnProperty.call(values, name) && typeof values[name] === 'string' && values[name].length <= MAX_VALUE)) {
            throw new Error('The graphical board returned invalid STACK input data');
          }
          const updates = [];
          for (const name of spec.inputs) {
            const target = input(name);
            if (target.value === values[name]) continue;
            if (revisions.get(name) !== row.revisions.get(name)) throw new Error('The input changed while collecting its graphical response');
            if (target.disabled || target.hasAttribute('readonly')) throw new Error('This STACK input is read-only');
            updates.push([name, target]);
          }
          for (const [name, target] of updates) {
            target.value = values[name];
            target.dispatchEvent(new Event('input', {bubbles:true}));
            target.dispatchEvent(new Event('change', {bubbles:true}));
          }
          row.resolve(values);
        } catch (error) { row.reject(error); }
        return;
      }
      if (!current() || event.source !== frame.contentWindow || !plain(data) || data.protocol !== PROTOCOL ||
          data.version !== VERSION || data.assessmentId !== spec.assessmentId || typeof data.instanceId !== 'string' ||
          !data.instanceId || data.instanceId.length > 128) return;
      if (data.type === 'hello') {
        if (!acceptingHello || retiredInstances.has(data.instanceId)) return;
        if (instanceId && instanceId !== data.instanceId) invalidate(false);
        instanceId = data.instanceId;
        try { initialize(); } catch (error) { showError(error.message); }
        return;
      }
      if (data.instanceId !== instanceId || data.generation !== generation) return;
      if (data.type === 'board-ready') {
        boardReady = true; frame.setAttribute('data-stack-jsxgraph-ready', 'true'); layout(); return;
      }
      if (data.type !== 'request' ||
          typeof data.requestId !== 'string' || data.requestId.length > 256) return;
      const response = {type:'response', requestId:data.requestId};
      try {
        if (data.operation === 'set-input') {
          const target = input(data.name);
          if (typeof data.value !== 'string' || data.value.length > MAX_VALUE) throw new Error('Invalid graphical response value');
          if (target.disabled || target.hasAttribute('readonly')) throw new Error('This STACK input is read-only');
          if (!Number.isSafeInteger(data.inputRevision) || data.inputRevision !== revisions.get(data.name)) {
            throw new Error('The input changed while the graphical response was being sent; use the current board state');
          }
          if (target.value !== data.value) {
            target.value = data.value;
            target.dispatchEvent(new Event('input', {bubbles:true}));
            target.dispatchEvent(new Event('change', {bubbles:true}));
          }
          response.value = snapshot();
        } else if (data.operation === 'get-content') {
          if (typeof data.elementId !== 'string' || data.elementId.length > 256) throw new Error('Invalid STACK content identifier');
          const target = contentElement(data.elementId);
          response.value = target ? target.innerHTML : null;
          if (response.value && response.value.length > MAX_CONTENT) throw new Error('STACK content exceeds the graphical input limit');
        } else if (data.operation === 'listen-button') {
          if (typeof data.elementId !== 'string' || data.elementId.length > 256) throw new Error('Invalid STACK button identifier');
          const target = contentElement(data.elementId);
          if (!target || !target.matches('button, input[type="button"]')) throw new Error('STACK external button is not in this question');
          if (!buttons.has(target)) {
            const listener = event => { event.preventDefault(); post({type:'button', elementId:data.elementId}); };
            target.addEventListener('click', listener); buttons.set(target, listener);
          }
          response.value = true;
        } else throw new Error('Unsupported STACK JSXGraph operation: ' + String(data.operation));
      } catch (error) { response.error = String(error.message || error).slice(0, 4096); }
      try { response.state = snapshot(); } catch (error) { response.error = error.message; }
      post(response); schedule();
    }
    function showError(message) {
      const document = frame.ownerDocument || scope.document;
      if (!errorOutput) {
        errorOutput = document.createElement('p');
        errorOutput.className = 'ctm-stack-jsxgraph-error'; errorOutput.setAttribute('role', 'alert');
        frame.after(errorOutput);
      }
      errorOutput.textContent = String(message).slice(0, 4096);
    }
    function collect() {
      if (!current() || !instanceId || !boardReady) return Promise.reject(new Error('The graphical input is still connecting; try again'));
      const requestId = nonce();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { collections.delete(requestId); reject(new Error('The graphical response did not arrive before validation')); }, 10000);
        collections.set(requestId, {resolve, reject, timer, generation, instanceId, revisions:new Map(revisions)});
        frame.contentWindow.postMessage({protocol:'jsxgraph-quarto-assessment', version:1,
          type:'request', assessmentId:spec.assessmentId, requestId}, '*');
      });
    }
    scope.addEventListener('message', receive);
    card.addEventListener('input', hostInput);
    card.addEventListener('change', change, true);
    card.addEventListener('click', click, true);
    card.addEventListener('reset', reset, true);
    frame.addEventListener('load', loaded);
    const observer = new scope.MutationObserver(schedule);
    observer.observe(card, {subtree:true, childList:true, attributes:true,
      attributeFilter:['aria-invalid', 'data-state', 'hidden', 'open', 'class', 'style']});
    const resize = typeof scope.ResizeObserver === 'function' ? new scope.ResizeObserver(layout) : null;
    resize?.observe(frame);
    const handle = {sync, layout, collect, current, generation:() => generation, disconnect() {
      disconnected = true; invalidate(false);
      scope.removeEventListener('message', receive);
      card.removeEventListener('input', hostInput);
      card.removeEventListener('change', change, true);
      card.removeEventListener('click', click, true);
      card.removeEventListener('reset', reset, true);
      frame.removeEventListener('load', loaded);
      observer.disconnect(); resize?.disconnect(); attached.delete(frame);
      cardState.handles.delete(handle);
    }};
    cardState.handles.add(handle);
    attached.set(frame, handle);
    if (templateURL) queueMicrotask(reloadFrame);
    return handle;
  }
  function install(root) {
    root = root || scope.document;
    const handles = new Map(), failed = new Map();
    function scan() {
      for (const [frame, handle] of handles) if (frame.isConnected === false || !root.contains(frame)) {
        handle.disconnect(); handles.delete(frame);
      }
      for (const frame of failed.keys()) if (frame.isConnected === false || !root.contains(frame)) failed.delete(frame);
      for (const frame of root.querySelectorAll('iframe[data-stack-jsxgraph]')) if (!handles.has(frame)) {
        const description = frame.getAttribute('data-stack-jsxgraph');
        if (failed.get(frame) === description) continue;
        try { handles.set(frame, attachIframe(frame)); }
        catch (error) {
          failed.set(frame, description);
          frame.setAttribute('data-stack-jsxgraph-error', error.message);
          const output = scope.document.createElement('p');
          output.className = 'ctm-stack-jsxgraph-error'; output.setAttribute('role', 'alert');
          output.textContent = error.message; frame.after(output);
        }
      }
    }
    scan();
    const observer = new scope.MutationObserver(scan);
    observer.observe(root === scope.document ? root.documentElement : root, {childList:true, subtree:true});
    return {scan, disconnect() { observer.disconnect(); for (const handle of handles.values()) handle.disconnect(); handles.clear(); failed.clear(); }};
  }
  scope.CTMStackJSXGraph = Object.freeze({install, attachIframe});
})(typeof window === 'undefined' ? self : window);
