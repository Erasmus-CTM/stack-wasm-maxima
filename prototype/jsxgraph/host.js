// SPDX-License-Identifier: AGPL-3.0-or-later
// Bind existing CTM question controls to a jsxgraph-quarto iframe.
(function (scope) {
  'use strict';
  const PROTOCOL = 'ctm-stack-jsxgraph', VERSION = 1;
  const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
  const MAX_VALUE = 32768, MAX_CONTENT = 262144, MAX_INPUTS = 32;
  const attached = new WeakMap(), cards = new WeakMap();
  let epochSequence = 0;
  function nonce() {
    if (scope.crypto?.randomUUID) return scope.crypto.randomUUID();
    return Date.now().toString(36) + '-' + (++epochSequence) + '-' + Math.random().toString(36).slice(2);
  }
  function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function descriptor(value) {
    if (typeof value === 'string') value = JSON.parse(value);
    if (!plain(value) || typeof value.assessmentId !== 'string' || !value.assessmentId || value.assessmentId.length > 256 ||
        !Array.isArray(value.inputs) || value.inputs.length > MAX_INPUTS || new Set(value.inputs).size !== value.inputs.length ||
        !value.inputs.every(name => typeof name === 'string' && NAME.test(name))) throw new Error('Invalid STACK JSXGraph descriptor');
    return {assessmentId:value.assessmentId, inputs:[...value.inputs]};
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
      post({type:'init', epoch, state});
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
      // The stock extension uses a self-contained data: URL. Also accept
      // srcdoc when a host embeds the same Quarto-rendered document that way.
      if (originalSrcdoc !== null) frame.setAttribute('srcdoc', originalSrcdoc);
      else if (originalSrc !== null) frame.setAttribute('src', originalSrc);
      else showError('The graphical board has no original document to restore');
    }
    function invalidate(reload) {
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
    function loaded() { acceptingHello = true; layout(); }
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
