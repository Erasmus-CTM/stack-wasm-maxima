// SPDX-License-Identifier: AGPL-3.0-or-later
// ECL runs synchronously. Both stdin and native results travel directly through
// shared memory, so a Python caller can wait without servicing message events.
'use strict';
const C = { INPUT: 0, INPUT_LENGTH: 1, RESULT: 2, RESULT_LENGTH: 3, ABORT: 4, REQUEST: 5, RESPONSE: 6 };
const nativeImport = self.importScripts.bind(self);
let control, sharedInput, sharedOutput, manifest, runtimeBase;
let pendingInput = new Uint32Array(0), inputIndex = 0;
let outputLine = '', stdoutTail = '', initialized = false;
function fail(error) {
  const message = String(error && (error.stack || error.message) || error);
  if (control && Atomics.load(control, C.REQUEST) > 0) {
    deliver(Atomics.load(control, C.REQUEST), { error: message, stdoutTail }, 2);
  }
  self.postMessage({ type: 'error', error: message });
}
function deliver(id, value, status) {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.length > sharedOutput.length) throw new Error('Native result exceeds shared output capacity');
  sharedOutput.set(encoded);
  Atomics.store(control, C.RESULT_LENGTH, encoded.length);
  Atomics.store(control, C.RESPONSE, id);
  Atomics.store(control, C.RESULT, status);
  Atomics.notify(control, C.RESULT);
}
function consume(text) {
  stdoutTail = (stdoutTail + text).slice(-16384);
  outputLine += text;
  if (outputLine.length > 2 * 1024 * 1024) throw new Error('Native output line exceeded diagnostic limit');
  let end;
  while ((end = outputLine.indexOf('\n')) !== -1) {
    const line = outputLine.slice(0, end).replace(/\r$/, '');
    outputLine = outputLine.slice(end + 1);
    const ready = /^CTMMAXIMA-READY\|([^|]+)\|(.+)$/.exec(line);
    const result = /^CTMMAXIMA\|(\d+)\|(.+)$/.exec(line);
    if (ready) {
      initialized = true;
      self.postMessage({ type: 'ready', stackLibraryVersion: ready[1], maximaVersion: ready[2] });
    } else if (result) {
      const id = Number(result[1]);
      if (id !== Atomics.load(control, C.REQUEST)) throw new Error('Unexpected native response identifier');
      deliver(id, JSON.parse(result[2]), 1);
    }
  }
}
function installTransport() {
  self.readChar = function () {
    while (inputIndex >= pendingInput.length) {
      while (Atomics.load(control, C.INPUT) === 0) Atomics.wait(control, C.INPUT, 0);
      const length = Atomics.load(control, C.INPUT_LENGTH);
      if (length < 1 || length > sharedInput.length) throw new Error('Invalid shared stdin length');
      pendingInput = sharedInput.slice(0, length);
      inputIndex = 0;
      Atomics.store(control, C.INPUT, 0);
      Atomics.notify(control, C.INPUT);
    }
    return pendingInput[inputIndex++];
  };
  self.checkForInterrupt = function () { return Atomics.load(control, C.ABORT); };
  self.writeChar = function (character) { consume(String.fromCodePoint(character)); };
  self.writeBaseString = function (pointer, size) {
    let text = '';
    for (let i = 0; i < size; i++) text += String.fromCodePoint(HEAPU8[pointer + i]);
    consume(text);
  };
  self.convertString = function (pointer, size) {
    let text = '';
    for (let i = 0; i < size; i++) text += String.fromCodePoint(HEAP32[(pointer >> 2) + i]);
    return text;
  };
  self.writeString = function (pointer, size) { consume(self.convertString(pointer, size)); };
}
self.addEventListener('error', event => fail(event.message || 'Native runtime error'));
self.onmessage = async ({ data }) => {
  if (data.type !== 'start' || control) return;
  try {
    runtimeBase = new URL(data.baseURL, self.location.href).href;
    manifest = data.manifest;
    control = new Int32Array(data.buffers[0]);
    sharedInput = new Uint32Array(data.buffers[1]);
    sharedOutput = new Uint8Array(data.buffers[2]);
    nativeImport(new URL('maxima_thread.js', runtimeBase).href);
    const upstreamStart = self.onmessage;
    const preInit = Module.preInit;
    Module.locateFile = path => new URL(path, runtimeBase).href;
    Module.preInit = function () {
      const lazy = FS.createLazyFile;
      FS.createLazyFile = function (parent, name, url, canRead, canWrite) {
        return lazy.call(this, parent, name, new URL(url, runtimeBase).href, canRead, canWrite);
      };
      preInit();
    };
    Module.preRun.push(function () {
      const missing = new FS.ErrnoError(44);
      MEMFS.ops_table.dir.node.lookup = function () { throw missing; };
      const ioctl = FS.ioctl;
      FS.ioctl = function (stream, operation, argument) {
        if (operation === 21531 && FS.isFile(stream.node.mode)) {
          HEAP32[argument >> 2] = Math.max(0, stream.node.node_ops.getattr(stream.node).size - stream.position);
          return 0;
        }
        return ioctl.call(this, stream, operation, argument);
      };
      for (const path of ['/ctm', '/ctm/tmp', '/ctm/plots', '/ctm/obj', '/ctm/moodle-qtype_stack-master/tmp']) FS.mkdirTree(path);
      for (const file of manifest.files) {
        const path = '/ctm/moodle-qtype_stack-master/' + file.path;
        FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
        FS.writeFile(path, new TextEncoder().encode(file.content));
      }
    });
    self.importScripts = function (...urls) {
      const mapped = urls.map(url => {
        const parsed = new URL(url, self.location.href);
        if (parsed.pathname.endsWith('/maxima.js') || parsed.pathname.endsWith('/share_files.js')) {
          return new URL(parsed.pathname.split('/').pop(), runtimeBase).href;
        }
        return parsed.href;
      });
      if (mapped.some(url => url.endsWith('/maxima.js'))) installTransport();
      return nativeImport(...mapped);
    };
    const startup = Array.from(manifest.startup, ch => ch.codePointAt(0));
    if (startup.length > sharedInput.length) throw new Error('Startup script exceeds shared stdin capacity');
    sharedInput.set(startup);
    Atomics.store(control, C.INPUT_LENGTH, startup.length);
    Atomics.store(control, C.INPUT, 1);
    // The upstream starter creates its own functions, then imports maxima.js.
    // Our import hook installs the independent persistent transport last.
    upstreamStart({ data: [new SharedArrayBuffer(8), new SharedArrayBuffer(4), new SharedArrayBuffer(4)] });
  } catch (error) { fail(error); }
};
