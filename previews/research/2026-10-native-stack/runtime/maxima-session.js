// SPDX-License-Identifier: AGPL-3.0-or-later
// Internal bridge used by the CTM backend worker. Student text must pass
// CTM's parser and the Python adapter's structural serializer before assess().
(function (scope) {
  'use strict';
  const C = { INPUT: 0, INPUT_LENGTH: 1, RESULT: 2, RESULT_LENGTH: 3, ABORT: 4, REQUEST: 5, RESPONSE: 6 };
  const MAX_INPUT = 512 * 1024, MAX_OUTPUT = 1024 * 1024;
  const logic = { and: 'nounand', or: 'nounor', not: 'nounnot' };
  const quote = text => JSON.stringify(String(text));
  function source(value, field, allowEmpty) {
    if (typeof value !== 'string' || value.length > 32768 || (!allowEmpty && !value.trim())) {
      throw new Error('Invalid canonical Maxima ' + field);
    }
    if (/[;:$"\\\r\n?]/.test(value) || /\/\*|\*\//.test(value) ||
        /\b(?:load|system|kill|batch|with_stdout|eval_string|parse_string|printf|print|funmake|apply|block)\s*\(/i.test(value)) {
      throw new Error('Unsupported canonical Maxima ' + field);
    }
    return value.replace(/%?[A-Za-z_][A-Za-z_0-9]*/g, token => logic[token] || token);
  }
  class MaximaSession {
    constructor(options) {
      this.options = options || {};
      this.baseURL = new URL(this.options.baseURL || '../maxima-runtime/', scope.location.href).href;
      this.stackSourceURL = new URL(this.options.stackSourceURL || '../stack-sources.json', scope.location.href).href;
      this.counters = { nativeCalls: 0, byTest: {} };
      this.sequence = 0;
      this.poisoned = false;
    }
    event(event, data) {
      if (typeof this.options.onEvent === 'function') this.options.onEvent(Object.assign({ event }, data));
    }
    async init() {
      if (this.ready && !this.poisoned) return this.ready;
      this.poisoned = false;
      this.ready = this.start();
      this.ready.catch(() => { this.ready = null; this.poisoned = true; });
      return this.ready;
    }
    async start() {
      if (!scope.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
        throw new Error('The Maxima backend requires cross-origin isolation');
      }
      if (this.child) this.child.terminate();
      const started = performance.now();
      const response = await fetch(this.stackSourceURL);
      if (!response.ok) throw new Error('STACK manifest HTTP ' + response.status);
      this.manifest = await response.json();
      if (!this.manifest.files || !this.manifest.startup || !this.manifest.tests) throw new Error('Invalid STACK runtime manifest');
      this.controlBuffer = new SharedArrayBuffer(8 * 4);
      this.inputBuffer = new SharedArrayBuffer(MAX_INPUT * 4);
      this.outputBuffer = new SharedArrayBuffer(MAX_OUTPUT);
      this.control = new Int32Array(this.controlBuffer);
      this.input = new Uint32Array(this.inputBuffer);
      this.output = new Uint8Array(this.outputBuffer);
      const childURL = new URL('maxima-child.js', this.options.childURL || new URL('../runtime/', scope.location.href));
      this.child = new Worker(childURL);
      this.event('maxima-init-start', { stackRevision: this.manifest.stackRevision });
      const timeout = this.options.loadTimeoutMs || 240000;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.poisoned = true;
          this.child.terminate();
          reject(new Error('Maxima/STACK initialization exceeded ' + timeout / 1000 + ' s'));
        }, timeout);
        this.child.onerror = event => {
          clearTimeout(timer);
          this.poisoned = true;
          reject(new Error(event.message || 'Maxima child worker failed'));
        };
        this.child.onmessage = ({ data }) => {
          if (data.type === 'ready') {
            clearTimeout(timer);
            if (String(data.stackLibraryVersion) !== String(this.manifest.stackLibraryVersion)) {
              this.poisoned = true; this.child.terminate(); reject(new Error('STACK library version mismatch')); return;
            }
            this.initialization = { elapsedMs: performance.now() - started, maximaVersion: data.maximaVersion,
              stages: data.stages || {},
              stackRevision: this.manifest.stackRevision, stackLibraryVersion: data.stackLibraryVersion };
            this.event('maxima-ready', this.initialization);
            resolve();
          } else if (data.type === 'error') {
            clearTimeout(timer); this.poisoned = true;
            reject(new Error(data.error || 'Maxima initialization failed'));
          } else if (data.type === 'diagnostic') this.event('maxima-diagnostic', { text: data.text });
        };
        this.child.postMessage({ type: 'start', baseURL: this.baseURL, manifest: this.manifest,
          preload: this.options.preload !== false,
          buffers: [this.controlBuffer, this.inputBuffer, this.outputBuffer] });
      });
      return this.initialization;
    }
    write(command, timeoutMs) {
      const values = Array.from(command, ch => ch.codePointAt(0));
      if (values.length > this.input.length) throw new Error('Maxima command exceeds input capacity');
      const deadline = performance.now() + timeoutMs;
      while (Atomics.load(this.control, C.INPUT) !== 0) {
        const remaining = deadline - performance.now();
        if (remaining <= 0 || Atomics.wait(this.control, C.INPUT, 1, remaining) === 'timed-out') {
          throw new Error('Maxima input channel timed out');
        }
      }
      this.input.set(values);
      Atomics.store(this.control, C.INPUT_LENGTH, values.length);
      Atomics.store(this.control, C.INPUT, 1);
      Atomics.notify(this.control, C.INPUT);
    }
    assess(request) {
      if (!this.ready || this.poisoned) throw new Error('Maxima is not ready');
      const spec = this.manifest.tests[request.test];
      if (!spec) throw new Error('Unsupported Maxima answer test: ' + request.test);
      const student = source(request.student, 'student expression', false);
      const teacher = source(request.teacher, 'teacher expression', false);
      const option = source(request.options || '', 'options', true);
      if (typeof request.raw !== 'undefined' && (typeof request.raw !== 'string' || request.raw.length > 32768)) {
        throw new Error('Invalid raw answer spelling');
      }
      const args = ['eval_string(' + quote(student) + ')', 'eval_string(' + quote(teacher) + ')'];
      if (spec[0]) {
        if (request.test === 'NumAbsolute' || request.test === 'NumRelative') {
          const opt = quote(option.trim() || '0.05');
          args.push('block([_ctm_option],_ctm_option:errcatch(parse_string(' + opt + ')),if _ctm_option=[] then 0.05 else eval_string(' + opt + '))');
        } else {
          if (!option.trim()) throw new Error('This Maxima answer test requires options');
          args.push('eval_string(' + quote(option) + ')');
        }
      }
      if (spec[2]) args.push(quote(typeof request.raw === 'string' ? request.raw : request.student));
      const id = ++this.sequence;
      const positive = Boolean(request.assumptions && request.assumptions.positive);
      const real = Boolean(request.assumptions && request.assumptions.real);
      // Scope the ordinary Maxima assumption flags to this call. CTM performs
      // structural validation and supplies the question's assumption policy.
      const expression = 'block([simp:' + (spec[1] ? 'true' : 'false') +
        ',assume_pos:' + (positive ? 'true' : 'false') + ',assume_real:' + (real ? 'true' : 'false') +
        ',%ERR:["stack_map"],%NOTES:["stack_map"],%FEEDBACK:["stack_map"],%stmt:"ctm-at"' +
        ',_ctm_r,_ctm_v],_ctm_r:errcatch(AT' + request.test + '(' + args.join(',') + ')),' +
        'if _ctm_r=[] then m2_emit(sconcat("CTMMAXIMA|' + id + '|",stackjson_stringify([false,"CAS evaluation failed"]))) ' +
        'else (_ctm_v:first(_ctm_r),if not listp(_ctm_v) or length(_ctm_v)<4 then ' +
        'm2_emit(sconcat("CTMMAXIMA|' + id + '|",stackjson_stringify([false,"Malformed native answer-test result"]))) ' +
        'else if length(%ERR)>1 then ' +
        'm2_emit(sconcat("CTMMAXIMA|' + id + '|",stackjson_stringify([false,"Native STACK reported a CAS error"]))) ' +
        'else m2_emit(sconcat("CTMMAXIMA|' + id + '|",stackjson_stringify([true,[_ctm_v[1],_ctm_v[2],_ctm_v[3],_ctm_v[4]]])))))$\n';
      const timeout = this.options.callTimeoutMs || 60000;
      const started = performance.now();
      Atomics.store(this.control, C.RESULT, 0);
      Atomics.store(this.control, C.REQUEST, id);
      try {
        this.write(expression, timeout);
        const deadline = started + timeout;
        while (Atomics.load(this.control, C.RESULT) === 0) {
          const remaining = deadline - performance.now();
          if (remaining <= 0 || Atomics.wait(this.control, C.RESULT, 0, remaining) === 'timed-out') {
            throw new Error('The native Maxima answer test timed out');
          }
        }
        if (Atomics.load(this.control, C.RESPONSE) !== id) throw new Error('Maxima response identifier mismatch');
        const length = Atomics.load(this.control, C.RESULT_LENGTH);
        if (length < 1 || length > this.output.length) throw new Error('Invalid Maxima result size');
        // Browser TextDecoder rejects SharedArrayBuffer-backed views. The
        // result-ready atomic publishes these bytes; copy them into ordinary
        // memory before decoding, while this serialized call owns the slot.
        const result = JSON.parse(new TextDecoder().decode(this.output.slice(0, length)));
        if (Atomics.load(this.control, C.RESULT) !== 1) throw new Error(result.error || 'Maxima runtime failed');
        if (!Array.isArray(result) || result[0] !== true || !Array.isArray(result[1])) {
          throw new Error(Array.isArray(result) ? String(result[1]) : 'Malformed Maxima result');
        }
        const value = result[1];
        if (value.length !== 4 || typeof value[0] !== 'boolean' || typeof value[1] !== 'boolean' ||
            !(typeof value[2] === 'string' || Array.isArray(value[2])) || typeof value[3] !== 'string') {
          throw new Error('Invalid native answer-test fields');
        }
        const notes = Array.isArray(value[2]) ? value[2] : [value[2]];
        if (!value[0] && !value[1] && notes.some(note => typeof note === 'string' &&
            /(?:AT[A-Za-z0-9]+_STACKERROR_(?:SAns|TAns|Opt|Raw|tol)|ATNumDecPlaces_OptNotInt|STACKERROR_OPTION)\./.test(note))) {
          throw new Error('Native STACK answer-test error: ' + notes.join(' '));
        }
        this.counters.nativeCalls++;
        this.counters.byTest[request.test] = (this.counters.byTest[request.test] || 0) + 1;
        // Native feedback is a stack_trans protocol string, not displayable
        // HTML. Preserve it as evidence; CTM still renders authored feedback.
        return { cas_valid: value[0], correct: value[1], answer_note: value[2], feedback: '', native_feedback: value[3],
          elapsedMs: performance.now() - started };
      } catch (error) {
        this.poisoned = true;
        Atomics.store(this.control, C.ABORT, 1);
        this.child.terminate();
        throw error;
      }
    }
    terminate() {
      if (this.child) this.child.terminate();
      this.poisoned = true; this.ready = null;
    }
  }
  scope.MaximaSession = MaximaSession;
})(self);
