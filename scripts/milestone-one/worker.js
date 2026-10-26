// Use the pinned upstream transport and runtime unchanged.
importScripts('/maxima_thread.js');
const upstreamStart = self.onmessage;
const upstreamImportScripts = self.importScripts.bind(self);
let currentBuffers;
let fatalReported = false, stderrTail = '';
function reportFatal(kind, error) {
  if (fatalReported) return;
  fatalReported = true;
  const message = String(error?.stack || error?.message || error);
  self.postMessage({ type: 'm1-error', error: message,
    fatal: { kind, message, stderrTail } });
}
// A native abort can be caught by Maxima's JavaScript error handler, leaving
// the worker alive but unable to finish. Preserve that cause before the batch
// watchdog fires. Ordinary stderr, including unsupported-syscall warnings,
// remains diagnostic output and does not itself fail the run.
const upstreamPrintErr = Module.printErr;
Module.printErr = function (...args) {
  stderrTail = (stderrTail + args.map(String).join(' ') + '\n').slice(-8192);
  if (typeof upstreamPrintErr === 'function') return upstreamPrintErr.apply(this, args);
  console.error(...args);
};
const upstreamAbort = Module.onAbort;
Module.onAbort = function (reason) {
  reportFatal('runtime-abort', reason);
  if (typeof upstreamAbort === 'function') return upstreamAbort.apply(this, arguments);
};
self.addEventListener('error', event => reportFatal('worker-error', event.error || event.message));
self.addEventListener('unhandledrejection', event => reportFatal('unhandled-rejection', event.reason));
function installBatchTransport(buffers) {
  const mutex = new Int32Array(buffers[0]);
  const input = new Uint32Array(buffers[1]);
  const size = new Uint32Array(buffers[2]);
  const interrupt = new Int32Array(buffers[3]);
  let index = 0, charactersRead = 0;
  const probePositions = new Set([37, 511, 1003]);
  // Upstream resets its stdin index for an interrupt. Keep the character
  // cursor and buffer intact when ECL's GC checks for an interrupt mid-read.
  self.checkForInterrupt = function () {
    Atomics.store(mutex, 0, 0);
    self.postMessage({ type: 'checkForInterrupt' });
    Atomics.wait(mutex, 0, 0);
    return Atomics.load(interrupt, 0);
  };
  self.readChar = function () {
    while (index >= size[0]) {
      index = 0;
      Atomics.store(mutex, 0, 0);
      self.postMessage({ type: 'waitingForInput' });
      Atomics.wait(mutex, 0, 0);
    }
    const character = input[index++];
    if (probePositions.has(++charactersRead)) {
      self.postMessage({ type: 'm1-transport-probe', charactersRead });
      self.checkForInterrupt();
    }
    return character;
  };
}
self.importScripts = function (...urls) {
  if (urls.some(url => String(url).endsWith('/maxima.js'))) installBatchTransport(currentBuffers);
  return upstreamImportScripts(...urls);
};
self.onmessage = event => {
  const { files, served, buffers } = event.data;
  currentBuffers = buffers;
  if (served) {
    // An owned runtime serves only its manifest. A lazy node for any other
    // declared share file 404s on first stat, which emsdk 6.0.11 turns into a
    // runtime abort, so those files are left out of the filesystem.
    const servedPaths = new Set(served);
    const upstreamPreInit = Module.preInit;
    Module.preInit = function () {
      const lazy = FS.createLazyFile;
      FS.createLazyFile = function (parent, name, url, ...rest) {
        if (!servedPaths.has(new URL(url, self.location.href).pathname)) return null;
        return lazy.call(this, parent, name, url, ...rest);
      };
      if (typeof upstreamPreInit === 'function') upstreamPreInit();
    };
  }
  Module.preRun.push(function () {
    // ECL probes regular files with FIONREAD before reading each character.
    // The deployed Emscripten MEMFS ioctl has no regular-file implementation.
    // MEMFS's lookup fallback only reports ENOENT. Reuse that error object
    // instead of collecting a JS/Wasm stack on every unsuccessful path probe.
    const missingFile = new FS.ErrnoError(44);
    MEMFS.ops_table.dir.node.lookup = function () { throw missingFile; };
    const originalIoctl = FS.ioctl;
    FS.ioctl = function (stream, operation, argument) {
      if (operation === 21531 && FS.isFile(stream.node.mode)) {
        HEAP32[argument >> 2] = Math.max(0, stream.node.node_ops.getattr(stream.node).size - stream.position);
        return 0;
      }
      return originalIoctl.call(this, stream, operation, argument);
    };
    self.postMessage({ type: 'm1-adapter', name: 'regular-file FIONREAD', operation: 21531 });
    for (const directory of ['/ctm', '/ctm/tmp', '/ctm/plots', '/ctm/obj',
      '/ctm/moodle-qtype_stack-master/tmp']) FS.mkdirTree(directory);
    for (const file of files) {
      const path = '/ctm/moodle-qtype_stack-master/' + file.path;
      FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      if (file.encoding && file.encoding !== 'base64') throw new Error('Unknown trusted fixture file encoding');
      FS.writeFile(path, file.encoding === 'base64'
        ? Uint8Array.from(atob(file.content), character => character.charCodeAt(0))
        : new TextEncoder().encode(file.content));
    }
    // Mounting writes are not evidence that Maxima read a library entry.
    const originalOpen = FS.open;
    FS.open = function (path, ...args) {
      const stream=originalOpen.call(this,path,...args);
      const resolved=typeof stream.path==='string'?stream.path:FS.getPath(stream.node);
      if(resolved.startsWith('/ctm/'))self.postMessage({type:'m1-fs-open',path:resolved,read:(stream.flags&3)!==1});
      return stream;
    };
  });
  try { upstreamStart({ data: buffers }); }
  catch (error) { reportFatal('worker-start', error); }
};
