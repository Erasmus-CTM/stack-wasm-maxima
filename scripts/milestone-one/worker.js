// Use the pinned upstream transport and runtime unchanged.
importScripts('/maxima_thread.js');
const upstreamStart = self.onmessage;
const upstreamImportScripts = self.importScripts.bind(self);
let currentBuffers;
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
  const { files, buffers } = event.data;
  currentBuffers = buffers;
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
    const originalOpen = FS.open;
    FS.open = function (path, ...args) {
      if (typeof path === 'string' && path.startsWith('/ctm/')) self.postMessage({ type: 'm1-fs-open', path });
      return originalOpen.call(this, path, ...args);
    };
    for (const directory of ['/ctm', '/ctm/tmp', '/ctm/plots', '/ctm/obj',
      '/ctm/moodle-qtype_stack-master/tmp']) FS.mkdirTree(directory);
    for (const file of files) {
      const path = '/ctm/moodle-qtype_stack-master/' + file.path;
      FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      FS.writeFile(path, new TextEncoder().encode(file.content));
    }
  });
  try { upstreamStart({ data: buffers }); }
  catch (error) { self.postMessage({ type: 'm1-error', error: String(error.stack || error) }); }
};
