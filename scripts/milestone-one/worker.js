// Use the pinned upstream transport and runtime unchanged.
importScripts('/maxima_thread.js');
const upstreamStart = self.onmessage;
self.onmessage = event => {
  const { files, buffers } = event.data;
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
