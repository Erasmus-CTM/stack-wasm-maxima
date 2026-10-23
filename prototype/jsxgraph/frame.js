// SPDX-License-Identifier: AGPL-3.0-or-later
// STACK-JS compatibility inside jsxgraph-quarto's sandboxed iframe.
(function (scope) {
  'use strict';
  const PROTOCOL = 'ctm-stack-jsxgraph', VERSION = 1;
  const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
  const MAX_VALUE = 32768, MAX_CONTENT = 262144, MAX_INPUTS = 32;
  let instanceSequence = 0;
  function nonce() {
    if (scope.crypto?.randomUUID) return scope.crypto.randomUUID();
    return Date.now().toString(36) + '-' + (++instanceSequence) + '-' + Math.random().toString(36).slice(2);
  }
  function validName(value) { return typeof value === 'string' && NAME.test(value); }
  function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }

  function create(options) {
    options = options || {};
    const assessmentId = options.assessmentId;
    const names = options.inputNames || [];
    const tokenNames = options.tokenNames || [];
    if (typeof assessmentId !== 'string' || !assessmentId || assessmentId.length > 256 ||
        !Array.isArray(names) || names.length > MAX_INPUTS || new Set(names).size !== names.length ||
        !names.every(validName) || !Array.isArray(tokenNames) || tokenNames.length > 128 || new Set(tokenNames).size !== tokenNames.length ||
        !tokenNames.every(name => typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(name))) throw new Error('Invalid STACK JSXGraph binding descriptor');
    const allowed = new Set(names), instanceId = nonce();
    if (!scope.JXG?.QuartoAssessment?.register) throw new Error('The jsxgraph-quarto assessment bridge is missing');
    const timeoutMs = Math.min(30000, Math.max(1000, options.timeoutMs || 10000));
    const document = scope.document;
    const mirrors = new Map(), metadata = new Map(), pending = new Map();
    const validationListeners = new Map(), buttonListeners = new Map();
    const desired = new Map(), writing = new Set(), pumps = new Map(), writeErrors = new Map();
    let generation = null, epoch = -1, sequence = 0, applying = false, disposed = false;
    let latestState = null, boardValues = null, helloTimer, loadTimer;
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Keep failures observable through ready/request promises without an
    // unhandled rejection before the author's asynchronous wrapper awaits it.
    ready.catch(() => {});

    function displayError(message) {
      let target = document.querySelector('.ctm-stack-jsxgraph-error');
      if (!target) {
        target = document.createElement('pre');
        target.className = 'ctm-stack-jsxgraph-error';
        target.setAttribute('role', 'alert');
        document.body.appendChild(target);
      }
      target.textContent = String(message).slice(0, 4096);
    }
    function post(data) {
      if (!disposed) scope.parent.postMessage({protocol: PROTOCOL, version: VERSION,
        assessmentId, instanceId, generation, ...data}, '*');
    }
    function inputName(name) {
      if (disposed) throw new Error('The graphical input is no longer connected');
      if (!validName(name) || !allowed.has(name)) throw new Error('STACK input is not bound to this board: ' + String(name));
      return name;
    }
    function rejectRequests(message) {
      for (const row of pending.values()) { clearTimeout(row.timer); row.reject(new Error(message)); }
      pending.clear();
    }
    function mirror(name) {
      inputName(name);
      if (mirrors.has(name)) return mirrors.get(name);
      const input = document.createElement('input');
      input.type = 'hidden';
      input.id = name;
      input.value = latestState?.inputs?.[name]?.value || '';
      for (const [key, value] of Object.entries(metadata.get(name) || {})) input.dataset[key] = value;
      if (latestState?.inputs?.[name]?.readonly) input.setAttribute('readonly', '');
      document.body.appendChild(input);
      mirrors.set(name, input);
      input.addEventListener('change', () => {
        if (applying || disposed) return;
        if (typeof input.value !== 'string' || input.value.length > MAX_VALUE) {
          const error = new Error('The graphical response exceeds the input limit.');
          writeErrors.set(name, {error, revision:latestState.inputs[name].revision});
          displayError(error.message);
          applyState(latestState); return;
        }
        desired.set(name, input.value);
        startWrite(name);
      });
      return input;
    }
    function validState(state) {
      return plain(state) && plain(state.inputs) && names.every(name => {
        const row = state.inputs[name];
        return plain(row) && typeof row.value === 'string' && row.value.length <= MAX_VALUE &&
          Number.isSafeInteger(row.revision) && row.revision >= 0 &&
          (!row.metadata || plain(row.metadata) && Object.entries(row.metadata).every(([key, value]) =>
            key.startsWith('stack') && key.length <= 80 && typeof value === 'string' && value.length <= 256));
      });
    }
    function notifyValidation(name, state) {
      const value = state.inputs[name].validation || {complete:false, valid:null};
      if (typeof value.complete !== 'boolean' || value.valid !== null && typeof value.valid !== 'boolean') return;
      for (const row of validationListeners.get(name) || []) {
        const signature = JSON.stringify(value);
        if (row.previous === signature) continue;
        row.previous = signature;
        try { row.callback(value.complete, value.valid, name); }
        catch (error) { displayError(error?.message || error); }
      }
    }
    function applyState(state) {
      if (!state || !validState(state)) return;
      latestState = state;
      applying = true;
      try {
        for (const name of names) {
          const row = state.inputs[name];
          metadata.set(name, row.metadata || {});
          if (!writing.has(name) && !desired.has(name) && row.revision > (writeErrors.get(name)?.revision ?? Infinity)) {
            writeErrors.delete(name);
          }
          const input = mirrors.get(name);
          // Keep a more recent drag while its preceding write is in flight.
          if (input && !desired.has(name) && !writing.has(name) && input.value !== row.value) {
            input.value = row.value;
            input.dispatchEvent(new Event('change'));
          }
          notifyValidation(name, state);
        }
      } finally { applying = false; }
    }
    async function request(operation, details) {
      await ready;
      if (disposed) throw new Error('The graphical input is no longer connected');
      const requestId = instanceId + ':' + (++sequence);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('STACK JSXGraph request timed out: ' + operation)); }, timeoutMs);
        pending.set(requestId, {resolve, reject, timer});
        post({type:'request', requestId, operation, ...(details || {})});
      });
    }
    async function pump(name) {
      if (writing.has(name)) return;
      writing.add(name);
      try {
        while (desired.has(name) && !disposed) {
          const value = desired.get(name);
          desired.delete(name);
          const state = await request('set-input', {name, value, inputRevision: latestState.inputs[name].revision});
          writeErrors.delete(name);
          applyState(state);
        }
      } catch (error) {
        desired.delete(name);
        writeErrors.set(name, {error, revision:latestState.inputs[name].revision});
        if (!disposed) displayError(error?.message || error);
      } finally { writing.delete(name); applyState(latestState); }
    }
    function startWrite(name) {
      if (pumps.has(name)) return pumps.get(name);
      const task = pump(name);
      pumps.set(name, task);
      task.finally(() => {
        if (pumps.get(name) === task) pumps.delete(name);
        if (!disposed && desired.has(name)) startWrite(name);
      });
      return task;
    }
    function receive(event) {
      const data = event.data;
      if (event.source !== scope.parent || !plain(data) || data.protocol !== PROTOCOL || data.version !== VERSION ||
          data.assessmentId !== assessmentId || data.instanceId !== instanceId || disposed) return;
      if (data.type === 'init') {
        if (!Number.isSafeInteger(data.epoch) || data.epoch < epoch || typeof data.generation !== 'string' ||
            data.generation.length > 128 || !validState(data.state)) return;
        const values = data.boardValues === undefined ? {} : data.boardValues;
        if (!plain(values) || Object.keys(values).length !== tokenNames.length || !tokenNames.every(name =>
            Object.prototype.hasOwnProperty.call(values, name) && typeof values[name] === 'number' && Number.isFinite(values[name]))) return;
        // Initialization is immutable for a document. Host variant/reset changes
        // navigate a fresh document, so late/repeated init cannot alter geometry.
        if (boardValues && JSON.stringify(boardValues) !== JSON.stringify(values)) return;
        boardValues = Object.freeze({...values});
        if (generation && generation !== data.generation) {
          rejectRequests('The question was reset or its variant changed');
          desired.clear();
        }
        epoch = data.epoch; generation = data.generation;
        applyState(data.state);
        clearInterval(helloTimer); clearTimeout(loadTimer);
        resolveReady();
        return;
      }
      if (!generation || data.generation !== generation) return;
      if (data.type === 'state') { applyState(data.state); return; }
      if (data.type === 'button' && typeof data.elementId === 'string') {
        for (const callback of buttonListeners.get(data.elementId) || []) callback(data.elementId);
        return;
      }
      if (data.type !== 'response' || typeof data.requestId !== 'string') return;
      const row = pending.get(data.requestId);
      if (!row) return;
      pending.delete(data.requestId); clearTimeout(row.timer);
      if (data.state) applyState(data.state);
      if (typeof data.error === 'string') row.reject(new Error(data.error.slice(0, 4096)));
      else row.resolve(data.value);
    }
    scope.addEventListener('message', receive);
    function hello() { post({type:'hello'}); }
    helloTimer = setInterval(hello, 250);
    loadTimer = setTimeout(() => {
      clearInterval(helloTimer);
      const error = new Error('The STACK graphical input did not connect to its question');
      rejectReady(error); displayError(error.message);
    }, timeoutMs);
    hello();

    const api = {
      ready,
      board_values: function () {
        if (!boardValues || disposed) throw new Error('The graphical board values are not initialized');
        return boardValues;
      },
      mark_ready: async function () {
        await ready;
        if (disposed) throw new Error('The graphical input is no longer connected');
        post({type:'board-ready'});
      },
      request_access_to_input: async function (name) {
        inputName(name); await ready; inputName(name); return mirror(name).id;
      },
      get_input_metadata: function (name) {
        const input = mirrors.get(inputName(name));
        if (!input) throw new Error('Register the STACK input before requesting its metadata');
        return Object.fromEntries(Object.entries(input.dataset).filter(([key]) => key.startsWith('stack'))
          .map(([key, value]) => [key.slice(5), value]));
      },
      clear_input: async function (name) {
        inputName(name); await ready;
        desired.set(name, '');
        await startWrite(name);
        if (writeErrors.has(name)) throw writeErrors.get(name).error;
      },
      get_content: function (elementId) {
        if (typeof elementId !== 'string' || elementId.length > 256) return Promise.reject(new Error('Invalid STACK content identifier'));
        return request('get-content', {elementId}).then(value => {
          if (value !== null && (typeof value !== 'string' || value.length > MAX_CONTENT)) throw new Error('Invalid STACK content response');
          return value;
        });
      },
      register_validation_state_listener: function (name, callback) {
        inputName(name);
        if (typeof callback !== 'function') throw new TypeError('Validation listener must be a function');
        if (!validationListeners.has(name)) validationListeners.set(name, []);
        validationListeners.get(name).push({callback, previous:null});
        ready.then(() => notifyValidation(name, latestState)).catch(error => displayError(error.message));
      },
      register_external_button_listener: function (elementId, callback) {
        if (typeof elementId !== 'string' || !elementId || elementId.length > 256 || typeof callback !== 'function') {
          throw new Error('Invalid STACK external button listener');
        }
        if (!buttonListeners.has(elementId)) buttonListeners.set(elementId, []);
        buttonListeners.get(elementId).push(callback);
        return request('listen-button', {elementId});
      },
      display_error: displayError,
      dispose: function () {
        disposed = true; clearInterval(helloTimer); clearTimeout(loadTimer);
        scope.removeEventListener('message', receive);
        rejectReady(new Error('The graphical input was disconnected'));
        rejectRequests('The graphical input was disconnected');
        for (const input of mirrors.values()) input.remove();
      },
    };
    scope.JXG.QuartoAssessment.register({response: async () => {
      await ready;
      // A parent collecting the response before Validate must wait until the
      // most recent drag has reached the question's ordinary input controls.
      while (pumps.size) await Promise.all(pumps.values());
      if (writeErrors.size) throw writeErrors.values().next().value.error;
      return {inputs:Object.fromEntries(names.map(name => [name, mirrors.get(name)?.value ?? latestState.inputs[name].value]))};
    }});
    return api;
  }
  scope.CTMStackJSXGraphFrame = Object.freeze({create});
})(typeof window === 'undefined' ? self : window);
