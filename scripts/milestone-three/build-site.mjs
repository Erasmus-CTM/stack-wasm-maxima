// SPDX-License-Identifier: AGPL-3.0-or-later
// Build native variants in the actual Wasm worker, then reuse Quarto's board
// renderer and CTM's card shell. No SymPy preparation is used for this page.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { serveDemo } from '../milestone-two/serve.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes('--'+name) ? args[args.indexOf('--'+name)+1] : fallback;
const site = resolve(option('site','site'));
const jsxgraphSource = resolve(option('jsxgraph-source','.m3-sources/jsxgraph-quarto'));
const stackSource = resolve(option('stack-source','.m3-sources/stack'));
const checkersSource = resolve(option('ctm-checkers-source',process.env.CTM_CHECKERS_SOURCE || '.m3-sources/ctm-checkers'));
const quarto = option('quarto',process.env.QUARTO || 'quarto');
const python = process.env.STACK_SYMPY_PYTHON || 'python';
const work = resolve(option('work','.cache/native-build'));
const data = JSON.parse(await readFile(join(site,'native/questions.json'),'utf8'));
await mkdir(work,{recursive:true});
const sourceSha = execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
const jsxSha = execFileSync('git',['rev-parse','HEAD'],{cwd:jsxgraphSource,encoding:'utf8'}).trim();
assert.equal(jsxSha,data.jsxgraphQuartoRevision,'Use the pinned existing JSXGraph extension');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = async (root,path) => {
  try { return await readFile(join(root,path),'utf8'); }
  catch(error) { if(error.code !== 'ENOENT') throw error; return execFileSync('git',['show','HEAD:'+path],{cwd:root,encoding:'utf8'}); }
};
const bindingSource = await source(stackSource,'corsscripts/stackjsxgraph.js');
const frameSource = await readFile(join(site,'jsxgraph/frame.js'),'utf8');
const bindingURL = 'data:text/javascript;base64,' + Buffer.from(bindingSource).toString('base64');
const programs = [], messages = [];
const report = {...data, sourceRevision:sourceSha, createdAt:new Date().toISOString(), programs,
  buildSourceFiles:[], preparation:{backend:'maxima-native',worker:'native/backend-worker.js',actualWasm:true},questions:[]};
for(const path of ['scripts/milestone-three/compile.py','scripts/milestone-three/build-site.mjs','scripts/milestone-three/render-cards.py',
  'prototype/native/engine.js','prototype/native/input.js','prototype/native/feedback.js',
  'prototype/native/backend-worker.js','prototype/native/python-bridge.js','prototype/native/python_bridge.py',
  'scripts/milestone-three/stage-feedback.py',
  'prototype/runtime/maxima-session.js','prototype/runtime/maxima-child.js',
  'prototype/jsxgraph/frame.js','prototype/jsxgraph/host.js']) {
  const bytes=await readFile(join(repository,path));report.buildSourceFiles.push({path,bytes:bytes.length,sha256:hash(bytes)});
}
report.nativeAssets=[];
for(const path of ['stack-parser.js','input-rules.json','input-provenance.json','feedback-messages.json','feedback-provenance.json']) {
  const bytes=await readFile(join(site,'native',path));report.nativeAssets.push({path:'native/'+path,bytes:bytes.length,sha256:hash(bytes)});
}
report.jsxgraphBindings={repository:'maths/moodle-qtype_stack',revision:data.stackRevision,path:'corsscripts/stackjsxgraph.js',sha256:hash(bindingSource)};
await writeFile(join(site,'native-build.html'),'<!doctype html><title>Native build preparation</title>');
const app=await serveDemo({root:site});
let browser;
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE || undefined});
  report.browserVersion=browser.version();
  const page=await browser.newPage();
  await page.goto(app.baseURL+'native-build.html');
  await page.evaluate(({base})=>{
    const worker=window.__nativeBuildWorker=new Worker(new URL('native/backend-worker.js',base));
    window.__nativeBuildMessages=[];
    window.__nativeBuildPending=new Map();
    window.__nativeBuildSequence=0;
    worker.onmessage=({data})=>{
      window.__nativeBuildMessages.push(data);
      const task=window.__nativeBuildPending.get(data.id);
      if(!task)return;
      window.__nativeBuildPending.delete(data.id);clearTimeout(task.timer);
      data.ok ? task.resolve(data) : task.reject(new Error(data.error));
    };
    worker.onerror=error=>{
      for(const task of window.__nativeBuildPending.values()){clearTimeout(task.timer);task.reject(new Error(error.message));}
      window.__nativeBuildPending.clear();
    };
    window.__nativeBuildCall=message=>new Promise((resolve,reject)=>{
      const id=++window.__nativeBuildSequence;
      const timer=setTimeout(()=>{window.__nativeBuildPending.delete(id);reject(new Error('Native preparation request timed out'));},300000);
      window.__nativeBuildPending.set(id,{resolve,reject,timer});
      worker.postMessage({...message,id});
    });
  },{base:app.baseURL});
  const initialized=await page.evaluate(({base})=>window.__nativeBuildCall({type:'init',recordPrograms:true,
    runtime:new URL('_extensions/ctm-libs/runtime/pyodide-runtime.js',base).href,
    checkers:['ctm-checkers.js','ctm-checkers-stack.js'].map(file=>new URL('_extensions/ctm-checkers/'+file,base).href)}),{base:app.baseURL});
  assert.equal(initialized.ok,true);
  report.preparation.initialization=initialized.backend;
  for(const item of data.questions){
    const variants=[];
    for(const seed of item.seeds){
      let result;
      try { result=await page.evaluate(({question,seed})=>window.__nativeBuildCall({type:'prepare',question,seed}),{question:item.question,seed}); }
      catch(error){ throw new Error(item.id+' seed '+seed+': '+error.message); }
      assert.equal(result.ok,true,item.id+' seed '+seed);
      variants.push(result.result);
    }
    const graphical=item.graph ? {
      ...item.graph,kind:item.graph.kind==='color-points'?'json-colour-points':'point',pointName:item.graph.name
    }:null;
    if(graphical?.initialXSource) {
      const token=item.question.native.tokens.find(token=>token.source===graphical.initialXSource && token.context==='javascript' && token.phase==='prepare');
      assert.ok(token,'Seeded graphical state must use an actual native-prepared board token');
      graphical.variantPoints=variants.map((variant,index)=>{
        const value=variant.tokenValues[token.id];
        assert.equal(value.string,false,'A graphical coordinate must be a native numeric value');
        const x=Number(value.value),y=Number(graphical.initialY);
        assert.ok(Number.isFinite(x) && Number.isFinite(y),'Graphical coordinates must be finite native values');
        return {variant:index,seed:variant.seed,pointName:graphical.pointName,coordinates:[x,y]};
      });
      assert.equal(new Set(graphical.variantPoints.map(point=>JSON.stringify(point.coordinates))).size,variants.length,
        'The selected graphical variants must have distinct actual native-prepared coordinates');
    }
    report.questions.push({...item,variants,graphical});
    console.log(JSON.stringify({prepared:item.id,variants:variants.length,pythonLoaded:false}));
  }
  messages.push(...await page.evaluate(()=>window.__nativeBuildMessages));
  programs.push(...messages.filter(message=>message.event==='native-evaluate' && message.expression));
  const diagnostics=await page.evaluate(()=>window.__nativeBuildCall({type:'diagnostics'}));
  assert.equal(diagnostics.result.pythonLoaded,false,'Native preparation must not start PythonChecker');
  report.preparation.final=diagnostics.result;
  report.preparation.programs=programs.length;
  const preparedPath=join(work,'prepared.json');
  await writeFile(preparedPath,JSON.stringify(report,null,2)+'\n');

  // Render every board with the pinned existing extension. Native input
  // bindings are an adapter around its renderer and unchanged STACK bindings.
  const boardsDirectory=join(work,'boards');
  await mkdir(join(boardsDirectory,'_extensions'),{recursive:true});
  await cp(join(jsxgraphSource,'_extensions/jsxgraph'),join(boardsDirectory,'_extensions/jsxgraph'),{recursive:true});
  const attribute = value => JSON.stringify(String(value));
  const boardSpecs = new Map();
  let qmd='---\ntitle: "Prepared native JSXGraph boards"\nfilters: [jsxgraph]\nformat:\n  html:\n    embed-resources: true\n---\n\n';
  for(const item of report.questions)for(let at=0;at<item.variants.length;at++){
    const variant=item.variants[at];
    for(const board of item.question.native.boards){
      const key=`${item.id}-v${at+1}-${board.id}`;
      const id=key;
      const inputNames=Object.keys(board.inputs);
      let code=board.code.replace(/@@CTM_NATIVE_([A-Za-z0-9_]+)@@/g,(_match,id)=>String(variant.tokenValues[id].value));
      const refs=Object.values(board.inputs);
      const registration=JSON.stringify({assessmentId:id,inputNames});
      code=frameSource+'\n(async function(){\nconst stack_js=CTMStackJSXGraphFrame.create('+registration+');\n'+
        'try {\nawait stack_js.ready;\nconst stack_jxg=(await import('+JSON.stringify(bindingURL)+')).default;\n'+
        (refs.length?'const ['+refs.join(',')+']=await Promise.all('+JSON.stringify(inputNames)+'.map(name=>stack_js.request_access_to_input(name,true,true)));\n':'')+
        'var divid=document.querySelector(".jxgbox").id;var BOARDID=divid;\n'+code+'\nwindow.__ctmStackJSXGraphReady=true;document.documentElement.dataset.ctmStackJsxgraphReady="true";await stack_js.mark_ready();\n} catch(error) { stack_js.display_error(error.message); }\n})();\n';
      const dimensions={width:'500',height:'400'};
      for(const axis of ['width','height'])if(board.attributes[axis]){
        const matched=/^([0-9]+(?:\.[0-9]+)?)(px)?$/.exec(board.attributes[axis]);
        assert.ok(matched, 'Native board renderer currently supports pixel dimensions');dimensions[axis]=matched[1];
      }
      const attrs={assessment_id:id,...dimensions,unit:'px',src_jxg:'_extensions/jsxgraph/resources/js/jsxgraphcore.js',src_css:'_extensions/jsxgraph/resources/css/jsxgraph.css'};
      qmd+='```{.jsxgraph '+Object.entries(attrs).map(([key,value])=>key+'='+attribute(value)).join(' ')+'}\n'+code+'\n```\n\n';
      boardSpecs.set(id,{assessmentId:id,inputs:inputNames,key});
    }
  }
  const boardHtml={};
  if(boardSpecs.size){
    await writeFile(join(boardsDirectory,'boards.qmd'),qmd);
    execFileSync(quarto,['render','boards.qmd','--to','html'],{cwd:boardsDirectory,stdio:'inherit'});
    const html=await readFile(join(boardsDirectory,'boards.html'),'utf8');
    const frames=await page.evaluate(html=>Array.from(new DOMParser().parseFromString(html,'text/html').querySelectorAll('iframe')).map(frame=>({id:frame.id,html:frame.outerHTML})),html);
    assert.equal(frames.length,boardSpecs.size,'Every native board needs its own stock renderer iframe');
    for(const frame of frames){
      const spec=boardSpecs.get(frame.id);assert.ok(spec,'Unexpected rendered board '+frame.id);
      const descriptor=JSON.stringify({assessmentId:spec.assessmentId,inputs:spec.inputs}).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
      boardHtml[spec.key]=frame.html.replace('<iframe','<iframe data-stack-jsxgraph="'+descriptor+'"');
    }
  }
  const boardsPath=join(work,'boards.json');
  await writeFile(boardsPath,JSON.stringify(boardHtml)+'\n');
  const env={...process.env};
  env.PYTHONPATH=join(checkersSource,'src')+(env.PYTHONPATH?':'+env.PYTHONPATH:'');
  execFileSync(python,[join(repository,'scripts/milestone-three/render-cards.py'),'--prepared',preparedPath,'--boards',boardsPath,
    '--output',join(site,'.native-prepared'),'--manifest',join(site,'native/build-manifest.json')],{cwd:repository,stdio:'inherit',env});
  await writeFile(join(work,'preparation-messages.json'),JSON.stringify(messages,null,2)+'\n');
} catch(error){
  await writeFile(join(work,'build-failure.json'),JSON.stringify({error:String(error),stack:error.stack,report,messages},null,2)+'\n');
  throw error;
} finally {if(browser)await browser.close();await app.close();}
