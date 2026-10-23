// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline board dependency proof; traffic/cache measurements are a separate test.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {resolve, join, posix} from 'node:path';
import {serveDemo} from '../milestone-two/serve.mjs';

const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes('--'+name)?args[args.indexOf('--'+name)+1]:fallback;
const site=resolve(option('site','site/_site'));
const engine=option('browser',process.env.CTM_BROWSER||'chromium');
const output=resolve(option('output','test-results/board-mathjax-'+engine+'.json'));
const browserTypes=await import(process.env.CTM_PLAYWRIGHT_MODULE||'playwright');
assert.ok(['chromium','firefox','webkit'].includes(engine));
const staged=JSON.parse(await readFile(join(site,'native/board-mathjax.json'),'utf8'));
const framePath='native/boards/offline-mathjax-check-'+engine+'.html';
const relative=path=>posix.relative(posix.dirname(framePath),path);
const config=structuredClone(staged.config);
// Resolve staged site-relative paths against the actual child document, including
// nested hosting. Data-bearing paths never become executable source strings.
const configPaths={};
for(const [key,value] of Object.entries(config.loader.paths))configPaths[key]=relative(value);
const fontPaths={svg:relative(config.svg.fontPath),chtml:relative(config.chtml.fontPath),
  fontURL:relative(config.chtml.fontURL)};
const configuration=`window.MathJax=${JSON.stringify(config)};
for(const [key,value] of Object.entries(${JSON.stringify(configPaths)}))MathJax.loader.paths[key]=new URL(value,document.baseURI).href;
MathJax.svg.fontPath=new URL(${JSON.stringify(fontPaths.svg)},document.baseURI).href;
MathJax.chtml.fontPath=new URL(${JSON.stringify(fontPaths.chtml)},document.baseURI).href;
MathJax.chtml.fontURL=new URL(${JSON.stringify(fontPaths.fontURL)},document.baseURI).href;`;
const loader=relative(staged.bases.mathjax4+'tex-mml-svg.js');
await writeFile(join(site,framePath),`<!doctype html><meta charset="utf-8"><title>Offline board maths proof</title>
<script>${configuration}</script>
<script crossorigin="anonymous" src="${relative(staged.preloader)}"></script>
<script id="MathJax-script" crossorigin="anonymous" async src="${loader}"></script>`);
const parentPath='native/offline-board-mathjax-check-'+engine+'.html';
await writeFile(join(site,parentPath),'<!doctype html><meta charset="utf-8"><title>Offline board dependency check</title><iframe title="opaque board maths" sandbox="allow-scripts" src="boards/offline-mathjax-check-'+engine+'.html"></iframe>');
const ordinaryParent='native/ordinary-board-mathjax-check-'+engine+'.html';
await writeFile(join(site,ordinaryParent),'<!doctype html><meta charset="utf-8"><title>Ordinary board dependency check</title><iframe title="ordinary board maths" src="boards/offline-mathjax-check-'+engine+'.html"></iframe>');
const report={engine,source:'canonical pinned MathJax/CTM assets',externalRequests:[],
  failedRequests:[],pageerrors:[],consoleErrors:[],responses:[],cases:[],passed:false};
let browser,app;
async function bounded(promise,label){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(label+' exceeded 60 seconds')),60000);
  })]);}finally{clearTimeout(timer);}
}
try{
  app=await serveDemo({root:site});
  const launch=engine==='chromium'&&process.env.CTM_CHROMIUM_CHANNEL?{channel:process.env.CTM_CHROMIUM_CHANNEL}:{};
  browser=await browserTypes[engine].launch({headless:true,...launch});
  report.browserVersion=browser.version();
  // This fresh fixture has no isolation/bootstrap service worker. Do not inject
  // Playwright's service-worker blocker into an intentionally opaque document.
  const context=await browser.newContext();
  // Blocking every non-site network URL proves closure. Routing disables the
  // browser HTTP cache; this harness deliberately makes no transfer-size claim.
  await context.route('**/*',route=>{
    const url=route.request().url();
    if(url.startsWith(app.baseURL)||url.startsWith('data:')||url.startsWith('blob:'))return route.continue();
    report.externalRequests.push(url);return route.abort('blockedbyclient');
  });
  const page=await context.newPage();
  page.on('pageerror',error=>report.pageerrors.push({message:error.message,stack:error.stack}));
  page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
  page.on('requestfailed',request=>report.failedRequests.push({url:request.url(),error:request.failure()}));
  page.on('response',response=>report.responses.push({url:response.url(),status:response.status()}));
  // Native CTM boards are intentionally opaque. The optional ordinary-origin
  // control is separate from this affected-question dependency acceptance.
  for(const opaque of (args.includes('--ordinary-control')?[true,false]:[true])){
    await page.goto(app.baseURL+(opaque?parentPath:ordinaryParent),{waitUntil:'load'});
    assert.equal(await page.evaluate(()=>crossOriginIsolated),true,'original isolated parent');
    const frame=page.frames().find(frame=>frame.parentFrame()===page.mainFrame());
    assert.ok(frame);
    await frame.waitForFunction(()=>!!window.MathJax?.startup?.promise,null,{timeout:60000});
    const result=await bounded(frame.evaluate(async()=>{
      await MathJax.startup.promise;
      const node=await MathJax.tex2svgPromise('x^2+1');
      const extended=await MathJax.tex2svgPromise(String.raw`\mathfrak{ABCDEFGHIJKLMNOPQRSTUVWXYZ}\unicode{x1D7D8}`);
      document.body.append(node,extended);
      return {origin:self.origin,version:MathJax.version,
        glyphs:node.querySelectorAll('svg path,svg use').length,
        extendedGlyphs:extended.querySelectorAll('svg path,svg use').length,
        speech:node.getAttribute('data-semantic-speech-none'),braille:node.getAttribute('data-semantic-braille'),
        loader:document.getElementById('MathJax-script').src};
    }),'actual local SVG and accessibility rendering');
    assert.equal(result.version,'4.1.3');
    assert.ok(result.glyphs>0&&result.extendedGlyphs>0,'real SVG and extended font output');
    assert.equal(result.speech,'x squared plus 1');assert.equal(result.braille,'⠭⠘⠆⠐⠬⠂');
    if(opaque)assert.equal(result.origin,'null');else assert.equal(result.origin,new URL(app.baseURL).origin);
    assert.ok(result.loader.startsWith(app.baseURL));
    report.cases.push({opaque,...result});
  }
  assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.failedRequests,[]);
  assert.deepEqual(report.pageerrors,[]);assert.deepEqual(report.consoleErrors,[]);
  assert.ok(report.responses.every(response=>response.status===200));
  assert.ok(report.responses.some(response=>response.url.includes('/sre/mathmaps/')),'real local speech maps');
  assert.ok(report.responses.some(response=>response.url.includes('/mathjax-newcm-font@')&&response.url.includes('/svg/dynamic/')),'real local extended font component');
  report.passed=true;await context.close();
}catch(error){report.error=String(error.stack||error);throw error;
}finally{
  if(browser)await browser.close();if(app)await new Promise(resolveClose=>app.server.close(resolveClose));
  for(const proofPath of [framePath,parentPath,ordinaryParent])await rm(join(site,proofPath),{force:true});
  await mkdir(resolve(output,'..'),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({engine,passed:report.passed,cases:report.cases.length,
    externalRequests:report.externalRequests,failedRequests:report.failedRequests.length,
    pageerrors:report.pageerrors,consoleErrors:report.consoleErrors}));
}
