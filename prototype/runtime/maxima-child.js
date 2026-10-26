// SPDX-License-Identifier: AGPL-3.0-or-later
// ECL runs synchronously. Both stdin and native results travel directly through
// shared memory, so a Python caller can wait without servicing message events.
'use strict';
const C = { INPUT: 0, INPUT_LENGTH: 1, RESULT: 2, RESULT_LENGTH: 3, ABORT: 4, REQUEST: 5, RESPONSE: 6 };
const nativeImport = self.importScripts.bind(self);
let control, sharedInput, sharedOutput, manifest, runtimeBase;
let pendingInput = new Uint32Array(0), inputIndex = 0;
let outputLine = '', stdoutTail = '', initialized = false;
let stages = {}, started;
const hex = bytes => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
function traceCompiledEntryReads(filesystem, stages, entry) {
  const open=filesystem.open;
  filesystem.open=function(path,...args) {
    const stream=open.call(this,path,...args);
    const resolved=typeof stream.path==='string'?stream.path:filesystem.getPath(stream.node);
    if((stream.flags&3)!==1) {
      if(resolved===entry+'.fas')stages.compiledStackOpens++;
      if(resolved===entry+'.mac')stages.compiledSourceEntryOpens++;
    }
    return stream;
  };
}
async function preloadFiles(base, spec) {
  const mounted = new Map();
  if (!spec) return mounted; // Older manifests retain the original loader.
  const records = new Map(manifest.runtimeAssets.map(file => [file.path, file]));
  if (!Array.isArray(spec.paths) || new Set(spec.paths).size !== spec.paths.length ||
      !spec.paths.every(path => records.has(path))) throw new Error('Invalid runtime preload index');
  const url = new URL(spec.path, base);
  if (url.origin !== new URL(base).origin || !url.href.startsWith(base)) throw new Error('Unsafe runtime preload URL');
  const response = await fetch(url);
  if (!response.ok) throw new Error('Runtime preload HTTP ' + response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== spec.fileBytes || hex(await crypto.subtle.digest('SHA-256', bytes)) !== spec.sha256) {
    throw new Error('Runtime preload hash mismatch');
  }
  const pack = JSON.parse(new TextDecoder().decode(bytes));
  if (pack.schema !== 1 || !Array.isArray(pack.files) || pack.files.length !== spec.paths.length) {
    throw new Error('Invalid runtime preload package');
  }
  for (const file of pack.files) {
    if (!spec.paths.includes(file.path) || mounted.has(new URL(file.path, base).href)) throw new Error('Unexpected runtime preload file');
    const value = Uint8Array.from(atob(file.content), character => character.charCodeAt(0));
    const record = records.get(file.path);
    if (value.length !== record.fileBytes || hex(await crypto.subtle.digest('SHA-256', value)) !== record.sha256) {
      throw new Error('Runtime preload source hash mismatch: ' + file.path);
    }
    mounted.set(new URL(file.path, base).href, value);
  }
  return mounted;
}
async function fetchCompiledStack(base, spec) {
  if (!spec) return null;
  const entry = manifest.files.filter(file => file.path === 'stack/maxima/stackmaxima.mac');
  const loader = manifest.files.filter(file => file.path === 'stack/maxima/stacklocallinux.mac');
  if (spec.schema !== 1 || spec.mode !== 'entry-fas' || spec.stackRevision !== manifest.stackRevision ||
      entry.length !== 1 || loader.length !== 1 ||
      spec.sourcePath !== entry[0].path || spec.sourceSha256 !== entry[0].sha256 ||
      spec.overlayLoaderSha256 !== loader[0].sha256 ||
      spec.asset?.path !== 'stackmaxima.fas' ||
      manifest.files.some(file => file.path === 'stack/maxima/stackmaxima.fas') ||
      loader[0].content.includes('load("stackmaxima.mac")$') ||
      loader[0].content.split('load("/ctm/moodle-qtype_stack-master/stack/maxima/stackmaxima.fas")$').length !== 2) {
    throw new Error('Invalid precompiled STACK manifest');
  }
  for (const file of [entry[0], loader[0]]) {
    const body = new TextEncoder().encode(file.content);
    if (body.length !== file.bytes || hex(await crypto.subtle.digest('SHA-256', body)) !== file.sha256) {
      throw new Error('Precompiled STACK source hash mismatch: ' + file.path);
    }
  }
  const {fileBytes, sha256} = spec.asset;
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 1 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('Invalid precompiled STACK asset record');
  }
  const url = new URL(spec.asset.path, base);
  if (url.origin !== new URL(base).origin || !url.href.startsWith(base)) {
    throw new Error('Unsafe precompiled STACK asset URL');
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error('Precompiled STACK HTTP ' + response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== fileBytes || hex(await crypto.subtle.digest('SHA-256', bytes)) !== sha256) {
    throw new Error('Precompiled STACK asset hash mismatch');
  }
  return bytes;
}
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
    if (line.trim() === 'CTMSTACK-LOAD-BEGIN') stages.stackLoadStartedMs = performance.now() - started;
    if (line.trim() === 'CTMSTACK-LOAD-END') {
      stages.stackLoadEndedMs = performance.now() - started;
      if (stages.stackLoadStartedMs !== undefined) stages.stackLoadMs = stages.stackLoadEndedMs - stages.stackLoadStartedMs;
    }
    if (ready) {
      initialized = true;
      stages.readyMs = performance.now() - started;
      self.postMessage({ type: 'ready', stackLibraryVersion: ready[1], maximaVersion: ready[2], stages });
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
    started = performance.now();
    runtimeBase = new URL(data.baseURL, self.location.href).href;
    manifest = data.manifest;
    control = new Int32Array(data.buffers[0]);
    sharedInput = new Uint32Array(data.buffers[1]);
    sharedOutput = new Uint8Array(data.buffers[2]);
    const preloaded = await preloadFiles(runtimeBase, data.preload === false ? null : manifest.preload);
    const compiledStack = await fetchCompiledStack(runtimeBase, manifest.compiledStack);
    stages.preloadMs = performance.now() - started;
    stages.preloadedFiles = preloaded.size;
    if (compiledStack) stages.compiledStackBytes = compiledStack.length;
    nativeImport(new URL('maxima_thread.js', runtimeBase).href);
    const upstreamStart = self.onmessage;
    const preInit = Module.preInit;
    Module.locateFile = path => new URL(path, runtimeBase).href;
    Module.preInit = function () {
      // Only runtime assets are deployed. A lazy node for any other share file
      // 404s on first stat, which emsdk 6.0.11 turns into a runtime abort.
      const shipped = manifest.runtimeAssets && new Set(manifest.runtimeAssets.map(file => new URL(file.path, runtimeBase).href));
      const lazy = FS.createLazyFile;
      FS.createLazyFile = function (parent, name, url, canRead, canWrite) {
        const absolute = new URL(url, runtimeBase).href;
        if (preloaded.has(absolute)) {
          // Hand the bytes to MEMFS instead of FS.write: from emsdk 6.0.11 the
          // heap FS.write consults does not exist yet during preInit.
          const directory = typeof parent == 'string' ? parent : FS.getPath(parent);
          FS.createDataFile(directory, name, null, canRead, canWrite);
          const file = FS.lookupPath(directory.replace(/\/$/, '') + '/' + name).node;
          file.contents = preloaded.get(absolute);
          file.usedBytes = file.contents.length;
          preloaded.delete(absolute); // MEMFS owns the mounted copy now.
          return file;
        }
        if (shipped && !shipped.has(absolute)) return null;
        return lazy.call(this, parent, name, absolute, canRead, canWrite);
      };
      preInit();
    };
    Module.preRun.push(function () {
      stages.wasmReadyMs = performance.now() - started;
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
      if (compiledStack) {
        const entry='/ctm/moodle-qtype_stack-master/stack/maxima/stackmaxima';
        FS.writeFile(entry+'.fas', compiledStack);
        Object.assign(stages,{compiledStackMounted:true,compiledStackOpens:0,compiledSourceEntryOpens:0,
          compiledStackSha256:manifest.compiledStack.asset.sha256,compiledStackRevision:manifest.stackRevision});
        traceCompiledEntryReads(FS,stages,entry);
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
