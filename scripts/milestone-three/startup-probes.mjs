// SPDX-License-Identifier: AGPL-3.0-or-later
// Experimental diagnostics. No production loader or pinned source is changed.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {serveDemo} from '../milestone-two/serve.mjs';

const root = resolve(process.env.LOADER_SITE || '.cache/loader-demo');
const output = resolve(process.env.STARTUP_PROBE_OUTPUT || 'test-results/startup-probes');
const modes = (process.env.STARTUP_PROBE_MODES || 'full,exact-directories,cache-off,core-no-statistics').split(',');
const allowed = new Set(['full', 'exact-directories', 'cache-off', 'core-no-statistics']);
if (!modes.length || modes.some(mode => !allowed.has(mode))) throw new Error('Unknown startup probe mode');
await mkdir(output, {recursive:true});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(resolve(root, 'stack-sources.json'));
const manifest = JSON.parse(manifestBytes);
const reports = {schema:1, createdAt:new Date().toISOString(), sourceRevision:process.env.GITHUB_SHA || null,
  probeSourceSha256:hash(await readFile(new URL(import.meta.url))),
  manifestSha256:hash(manifestBytes), stackRevision:manifest.stackRevision,
  stackLibraryVersion:manifest.stackLibraryVersion,
  originalStartupSha256:hash(manifest.startup),
  runtimeAssets:manifest.runtimeAssets.map(({path,sha256,fileBytes})=>({path,sha256,fileBytes})),
  scope:'Diagnostic timings with instrumentation, fresh browser/profile/worker per mode, local gzip server. Reduced core configuration deliberately omits stats/distrib/descriptive and does not establish full STACK equivalence.',
  modes, samples:[], passed:false};

// Common Lisp wrappers preserve the original functions and values. The probe
// records inclusive times; parent and child load times must not be added.
const traceLisp = `(progn
 (defparameter *ctm-probe-depth* 0)
 (defparameter *ctm-probe-origin* (get-internal-real-time))
 (dolist (symbol '($load $batchload $loadfile $compile))
   (when (fboundp symbol)
     (let ((name symbol) (original (symbol-function symbol)))
       (setf (symbol-function symbol)
         (lambda (&rest args)
           (let ((started (get-internal-real-time)) (depth *ctm-probe-depth*))
             (let ((*ctm-probe-depth* (1+ depth)))
               (unwind-protect (apply original args)
                 (format t "~%CTMSTARTUP|~d|~a|~a|~d|~d~%"
                   depth name (first args)
                   (round (* 1000 (/ (- started *ctm-probe-origin*) internal-time-units-per-second)))
                   (round (* 1000 (/ (- (get-internal-real-time) started) internal-time-units-per-second)))))))))))))`;

function diagnosticChild(mode) {
  return `
'use strict';
const mode = ${JSON.stringify(mode)};
const traceLisp = ${JSON.stringify(traceLisp)};
const forwardImport = self.importScripts.bind(self);
const forwardPost = self.postMessage.bind(self);
const loads = [], filesystem = new Map();
let lineBuffer = '', observationInstalled = false, observedLines = 0;
let diagnosticStarted = null, coreReadyMs = null, stackLoadStartedMs = null;
function recordText(text) {
  lineBuffer += text;
  if (lineBuffer.length > 1000000) lineBuffer = lineBuffer.slice(-1000000);
  let end;
  while ((end=lineBuffer.indexOf('\\n')) >= 0) {
    const line = lineBuffer.slice(0,end).replace(/\\r$/, '');
    lineBuffer = lineBuffer.slice(end+1);
    if(observedLines++ < 500)forwardPost({type:'diagnostic',text:line.slice(0,4000)});
    if(line.includes('CTMCORE-READY') && coreReadyMs===null)coreReadyMs=performance.now()-diagnosticStarted;
    if(line.includes('CTMSTACK-LOAD-START') && stackLoadStartedMs===null)stackLoadStartedMs=performance.now()-diagnosticStarted;
    const at = line.indexOf('CTMSTARTUP|');
    if (at < 0) continue;
    const parts = line.slice(at).split('|');
    if (parts.length === 6 && [parts[1],parts[4],parts[5]].every(value => /^\\d+$/.test(value))) {
      loads.push({depth:Number(parts[1]),function:parts[2],argument:parts[3],startedMs:Number(parts[4]),elapsedMs:Number(parts[5])});
    }
  }
}
function observeOutput() {
  if (observationInstalled) return;
  observationInstalled = true;
  const char = self.writeChar, base = self.writeBaseString, wide = self.writeString;
  self.writeChar = function(value) {recordText(String.fromCodePoint(value)); return char.apply(this,arguments);};
  self.writeBaseString = function(pointer,size) {
    let text=''; for(let at=0;at<size;at++) text+=String.fromCodePoint(HEAPU8[pointer+at]);
    recordText(text); return base.apply(this,arguments);
  };
  self.writeString = function(pointer,size) {recordText(self.convertString(pointer,size)); return wide.apply(this,arguments);};
}
function observeFS() {
  for (const name of ['open','lookupPath','stat','lstat','read','ioctl']) {
    if (typeof FS[name] !== 'function') continue;
    const original = FS[name];
    FS[name] = function(...args) {
      const raw = args[0];
      const path = typeof raw === 'string' ? raw : raw && raw.path || '<stream>';
      const operation = name === 'ioctl' ? name + ':' + args[1] : name;
      const key = operation + '|' + path;
      let record = filesystem.get(key);
      if (!record) {
        if(filesystem.size >= 10000) return original.apply(this,args);
        record={operation,path,calls:0,errors:0,elapsedMs:0,readBytes:0}; filesystem.set(key,record);
      }
      const started=performance.now(); record.calls++;
      try {const result=original.apply(this,args); if(name==='read' && typeof result==='number')record.readBytes+=result; return result;}
      catch(error) {record.errors++; throw error;}
      finally {record.elapsedMs+=performance.now()-started;}
    };
  }
}
self.importScripts = function(...urls) {
  if(urls.some(url => new URL(url,self.location.href).pathname.endsWith('/maxima.js'))) observeOutput();
  const result = forwardImport(...urls);
  if(urls.some(url => new URL(url,self.location.href).pathname.endsWith('/maxima_thread.js'))) {
    const oldPreInit=Module.preInit;
    Module.preInit=function(){oldPreInit();observeFS();};
  }
  return result;
};
self.postMessage = function(data,...args) {
  if(data && data.type==='ready') {
    data.stages = {...data.stages,coreReadyMs,stackLoadStartedMs,
      coreToStackReadyMs:coreReadyMs===null?null:performance.now()-diagnosticStarted-coreReadyMs,
      startupProfile:{mode,loads,
      filesystem:[...filesystem.values()].sort((a,b)=>b.elapsedMs-a.elapsedMs)}};
  }
  return forwardPost(data,...args);
};
forwardImport(new URL('../../runtime/maxima-child.js',self.location.href).href);
const start=self.onmessage;
self.onmessage=async event=>{
  const data=event.data;
  if(data.type!=='start') return start(event);
  diagnosticStarted=performance.now();
  const manifest=data.manifest;
  const source=manifest.files.find(file=>file.path==='stack/maxima/stacklocallinux.mac');
  if(!source) throw new Error('Missing pinned local startup source');
  let prelude=':lisp (format t "~%CTMCORE-READY~%")\\n';
  prelude+=':lisp ' + traceLisp.replace(/\\n/g,' ') + '\\n';
  if(mode==='cache-off')prelude+='file_search_cache:false$\\n';
  if(mode==='exact-directories') {
    const directories=[...new Set(manifest.runtimeAssets.filter(file=>file.path.startsWith('share/'))
      .map(file=>'/' + file.path.slice(0,file.path.lastIndexOf('/'))))].sort();
    const quote=value=>JSON.stringify(value);
    prelude+='file_search_maxima:append(['+directories.map(path=>quote(path+'/###.{mac,mc}')).join(',')+'],file_search_maxima)$\\n';
    prelude+='file_search_lisp:append(['+directories.map(path=>quote(path+'/###.{lisp,lsp}')).join(',')+'],file_search_lisp)$\\n';
  }
  const original='load("/ctm/moodle-qtype_stack-master/stack/maxima/stacklocallinux.mac")$';
  if(!manifest.startup.includes(original))throw new Error('Pinned manifest startup changed');
  const loadMarker=':lisp (format t "~%CTMSTACK-LOAD-START~%")\\n';
  if(mode==='core-no-statistics') {
    const split=source.content.indexOf('/* Load the main libraries. */');
    if(split<0)throw new Error('Pinned startup source layout changed');
    const initial=source.content.slice(0,split)+'\\nload("stackmaxima.mac")$\\n';
    manifest.startup=manifest.startup.replace(original,loadMarker+initial);
  }else manifest.startup=manifest.startup.replace(original,loadMarker+original);
  manifest.startup=prelude+manifest.startup;
  return start({data});
};
`;
}

await writeFile(resolve(root, 'startup-probe.html'), '<!doctype html><title>STACK startup diagnostics</title>');
for (const mode of modes) {
  const folder=resolve(root,'startup-probe',mode);
  await mkdir(folder,{recursive:true});
  await writeFile(resolve(folder,'maxima-child.js'),diagnosticChild(mode));
}
await writeFile(resolve(root,'startup-probe-worker.js'), `
importScripts('runtime/maxima-session.js');
self.onmessage=async({data})=>{
  let session;
  const diagnostics=[];
  try {
    session=new MaximaSession({baseURL:'./maxima-runtime/',stackSourceURL:'./stack-sources.json',
      childURL:new URL('startup-probe/'+data.mode+'/',self.location.href),preload:true,
      onEvent:event=>{if(diagnostics.length<600)diagnostics.push(event);}});
    const initialization=await session.init();
    const probes=[
      {test:'AlgEquiv',student:'(x+1)^2',teacher:'x^2+2*x+1'},
      {test:'AlgEquiv',student:'matrix([1,2],[3,4])',teacher:'matrix([1,2],[3,4])'},
      {test:'Sets',student:'{1,2}',teacher:'{2,1}'},
      {test:'NumDecPlaces',student:'1.75',teacher:'7/4',options:'2',raw:'1.75'}
    ];
    const results=probes.map(request=>({request,result:session.assess(request)}));
    self.postMessage({ok:true,initialization,results,diagnostics});
  }catch(error){self.postMessage({ok:false,error:String(error),stack:error.stack,diagnostics});}
  finally{if(session)session.terminate();}
};
`);

const app=await serveDemo({root});
try {
  for(const mode of modes) {
    const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE || undefined});
    try {
      reports.browserVersion=browser.version();
      const page=await browser.newPage();
      const consoleMessages=[];
      page.on('console',message=>{if(consoleMessages.length<600)consoleMessages.push({type:message.type(),text:message.text().slice(0,4000)});});
      page.on('pageerror',error=>consoleMessages.push({type:'pageerror',text:String(error)}));
      const requestStart=app.requests.length;
      await page.goto(app.baseURL+'startup-probe.html');
      const result=await page.evaluate(mode=>new Promise(resolveResult=>{
        const worker=new Worker('startup-probe-worker.js');
        const timer=setTimeout(()=>{worker.terminate();resolveResult({ok:false,error:'Startup probe timed out'});},300000);
        worker.onmessage=({data})=>{clearTimeout(timer);worker.terminate();resolveResult(data);};
        worker.onerror=error=>{clearTimeout(timer);worker.terminate();resolveResult({ok:false,error:error.message});};
        worker.postMessage({mode});
      }),mode);
      reports.samples.push({mode,...result,consoleMessages,requests:app.requests.slice(requestStart)});
      await writeFile(resolve(output,'startup-probes.json'),JSON.stringify(reports,null,2)+'\n');
      console.log(JSON.stringify({mode,ok:result.ok,error:result.error,initializationMs:result.initialization?.elapsedMs,
        diagnostics:result.ok ? undefined : result.diagnostics, consoleMessages:result.ok ? undefined : consoleMessages,
        loads:result.initialization?.stages?.startupProfile?.loads?.length,
        slowestLoads:result.initialization?.stages?.startupProfile?.loads?.slice().sort((a,b)=>b.elapsedMs-a.elapsedMs).slice(0,12)}));
      assert.equal(result.ok,true,result.error);
      assert.ok(result.initialization.stages.startupProfile.loads.length,'Lisp load profiler must produce evidence');
      assert.ok(Number.isFinite(result.initialization.stages.coreReadyMs),'The first Maxima command must produce the core-ready marker');
      assert.ok(Number.isFinite(result.initialization.stages.stackLoadStartedMs),'The STACK load-start marker must be observed');
      for(const row of result.results){assert.equal(row.result.cas_valid,true);assert.equal(row.result.correct,true);}
    }finally{await browser.close();}
  }
  const sources=sample=>sample.initialization?.stages?.startupProfile?.filesystem
    .filter(row=>row.operation==='read' && row.readBytes>0 &&
      (row.path.startsWith('/share/') || row.path.startsWith('/ctm/moodle-qtype_stack-master/')))
    .map(row=>row.path).sort();
  const full=reports.samples.find(sample=>sample.mode==='full');
  if(full) {
    reports.sourcePathChecks=[];
    for(const sample of reports.samples.filter(sample=>['exact-directories','cache-off'].includes(sample.mode))) {
      const expected=sources(full), actual=sources(sample);
      assert.ok(expected.length,'Filesystem profiler must identify loaded source files');
      assert.deepEqual(actual,expected,'An equivalent loader configuration must read the same pinned source files');
      reports.sourcePathChecks.push({mode:sample.mode,sameLoadedSourcePaths:true,paths:actual});
    }
  }
  reports.passed=true;
}catch(error){reports.failure=String(error);console.error(reports.failure);}
finally {await app.close();await writeFile(resolve(output,'startup-probes.json'),JSON.stringify(reports,null,2)+'\n');}
if(!reports.passed)process.exitCode=1;
