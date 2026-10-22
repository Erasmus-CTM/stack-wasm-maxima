// SPDX-License-Identifier: AGPL-3.0-or-later
// Research only: direct ECL calls with the deployed, unmodified binaries.
'use strict';
const nativeImport = self.importScripts.bind(self);
let manifest, runtimeBase, started, stages = {}, tail = '', input = [], cursor = 0, eofCount=0;
const hex = bytes => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
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

let output = '', queue = Promise.resolve();
const consume = text => { output += text; if(output.length>2*1024*1024) throw new Error('Research output limit exceeded'); tail = (tail + text).slice(-16000); };
function installTransport() {
 self.readChar = () => { if(cursor < input.length) return input[cursor++]; if(++eofCount === 1) self.postMessage({type:'eof',tail, elapsedMs:performance.now()-started}); if(eofCount>4) throw new Error('EOF read repeated five times'); return -1; };
 self.checkForInterrupt = () => 0;
 self.writeChar = c => consume(String.fromCodePoint(c));
 self.writeBaseString = (p,n) => { let s='';for(let i=0;i<n;i++)s+=String.fromCharCode(HEAPU8[p+i]);consume(s); };
 self.convertString = (p,n) => {let s='';for(let i=0;i<n;i++)s+=String.fromCodePoint(HEAP32[(p>>2)+i]);return s;};
 self.writeString = (p,n) => consume(self.convertString(p,n));
 self.displayOutput = (...args) => consume(args.join(' '));
}
self.addEventListener('error', event => self.postMessage({type:'failure',error:event.message,tail}));
self.onmessage = async ({data}) => {
 try {
  if(data.type === 'start') {
    started=performance.now(); runtimeBase=new URL(data.baseURL,self.location.href).href;
    manifest=data.manifest;
    const preloaded = await preloadFiles(runtimeBase, manifest.preload);
    stages.preloadMs = performance.now() - started;
    stages.preloadedFiles = preloaded.size;
    nativeImport(new URL('maxima_thread.js', runtimeBase).href);
    const upstreamStart = self.onmessage;
    const preInit = Module.preInit;
    Module.locateFile = path => new URL(path, runtimeBase).href;
    Module.preInit = function () {
      const lazy = FS.createLazyFile;
      FS.createLazyFile = function (parent, name, url, canRead, canWrite) {
        const absolute = new URL(url, runtimeBase).href;
        if (preloaded.has(absolute)) {
          const file = FS.createDataFile(parent, name, preloaded.get(absolute), canRead, canWrite);
          preloaded.delete(absolute); // MEMFS owns the mounted copy now.
          return file;
        }
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
    });

    Module.noExitRuntime = true;
    Module.postRun.push(() => { const ready=/CTMMAXIMA-READY\|([^|]+)\|([^\r\n]+)/.exec(tail); if(ABORT || !ready || ready[1]!==String(manifest.stackLibraryVersion)) {self.postMessage({type:'failure',error:'Startup did not reach the pinned STACK version',tail});return;} self.onmessage = event => { queue=queue.then(()=>directMessage(event)); }; self.postMessage({type:'returned',tail,elapsedMs:performance.now()-started,aborted:ABORT,maximaVersion:ready[2],stages});});
    self.importScripts = (...urls) => {
      const mapped=urls.map(u => new URL(new URL(u,self.location.href).pathname.split('/').pop(),runtimeBase).href);
      if(mapped.some(u=>u.endsWith('/maxima.js'))) installTransport();
      return nativeImport(...mapped);
    };
    input=Array.from(manifest.startup+(data.route==='to-lisp' ? "\n:lisp (throw 'maxima::to-lisp nil)\n" : ''),c=>c.codePointAt(0));
    // Upstream creates SAB views but our hook replaces every transport callback
    // before Maxima executes. Ordinary ArrayBuffers suffice for that setup.
    upstreamStart({data:[new ArrayBuffer(8),new ArrayBuffer(4),new ArrayBuffer(4)]});
  }
 } catch(e) { self.postMessage({type:'failure',error:String(e.stack||e),tail}); }
};
function lispEval(text) {
  const saved = stackSave();
  try {
    const p = stringToUTF8OnStack(text);
    const string = resolveGlobalSymbol('ecl_make_constant_base_string').sym(p, -1);
    const form = resolveGlobalSymbol('si_string_to_object').sym(1, string);
    return resolveGlobalSymbol('si_safe_eval').sym(3, form, 1, 1);
  } finally { stackRestore(saved); }
}
function evaluate(expression) {
  if(typeof expression!=='string'||!expression.trim()||expression.length>300000||expression.includes('\0'))throw new Error('Invalid research CAS program');
  output = '';
  const command = 'block([%ERR:["stack_map"],%NOTES:["stack_map"],%FEEDBACK:["stack_map"],%stmt:"ctm-native",_ctm_program_result],'+
   '_ctm_program_result:errcatch('+expression+'),'+
   'm2_emit(sconcat("CTMCALL|",stackjson_stringify(if _ctm_program_result=[] then [false,errormsgtostring()] '+
   'else if length(%ERR)>1 then [false,"Native question reported a CAS error"] else [true,first(_ctm_program_result)]))))';
  // Common Lisp strings escape only backslash and quote; JSON's \n would
  // be read as the letter n rather than a newline.
  const literal='"'+command.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
  lispEval('(maxima::$eval_string '+literal+')');
  const records = output.split(/\r?\n/).filter(line=>line.startsWith('CTMCALL|'));
  if(records.length !== 1) throw new Error('Direct call did not produce exactly one result: '+tail);
  return JSON.parse(records[0].slice(8));
}
async function directMessage({data}) {
 try {
  if(data.type==='suite') {
    nativeImport('/native/stack-parser.js','/native/input.js','/native/engine.js','/suite.js');
    const session={manifest,evaluate(expression){const value=evaluate(expression);if(!value[0])throw new Error(value[1]);return value[1];}};
    const suite=await runSuite(session,data.fixtures,data.question);
    const failed=evaluate('error("intentional step-zero CAS error")');
    const recovered=evaluate('6*7');
    self.postMessage({type:'complete',suite,recovery:{failed,recovered},tail});return;
  }
  const t=performance.now();
  const value=data.lisp ? lispEval(data.lisp) : evaluate(data.expression);
  self.postMessage({type:'evaluated',id:data.id,value,tail,elapsedMs:performance.now()-t});
 } catch(e) {self.postMessage({type:'failure',id:data.id,error:String(e.stack||e),tail});}
}
