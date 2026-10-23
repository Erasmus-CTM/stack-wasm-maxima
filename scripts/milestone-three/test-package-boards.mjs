// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {boardProgram,boardValues,packageBoard} from './package-boards.mjs';
import {serveDemo} from '../milestone-two/serve.mjs';

const token={id:'t0',format:'source',context:'javascript'};
const program=boardProgram({code:'point([@@CTM_NATIVE_t0@@,-1]);'},[token]);
assert.equal(program.code,'point([ctm_board_values["t0"],-1]);');
assert.deepEqual(program.ids,['t0']);
assert.deepEqual(boardValues(program.ids,{tokenValues:{t0:{value:'-2',string:false}}}),{t0:-2});
assert.deepEqual(boardValues([],{tokenValues:{}}),{});
for(const value of ['1/2','NaN','Infinity','alert(1)','1e9999','-0','012']) assert.throws(()=>boardValues(['t0'],{tokenValues:{t0:{value,string:false}}}));
assert.throws(()=>boardValues(['t0'],{tokenValues:{t0:{value:'1',string:true}}}));
for(const code of ['point("[@@CTM_NATIVE_t0@@,]")','// [@@CTM_NATIVE_t0@@,]\npoint(1)','point(`[@@CTM_NATIVE_t0@@,]`)','point(@@CTM_NATIVE_t0@@)','var pattern=/[@@CTM_NATIVE_t0@@,]/;']) assert.throws(()=>boardProgram({code},[token]));
assert.throws(()=>boardProgram({code:'point([@@CTM_NATIVE_t0@@,0])'},[{...token,format:'latex'}]));

const site=await mkdtemp(join(tmpdir(),'ctm-board-package-'));
const vendor=Buffer.from('/* unchanged vendor license */\nwindow.vendor=true;');
const css=Buffer.from('/* stylesheet license */\n.jxgbox{border:0}');
const uri=(type,bytes)=>'data:'+type+';base64,'+bytes.toString('base64');
const original='<!doctype html><script id="MathJax-script" async src="https://cdn.example/mathjax.js"></script><script src="'+uri('text/javascript',vendor)+'"></script><style>@import url("'+uri('text/css',css)+'");</style><script>window.authored="unchanged"; import('+JSON.stringify(uri('text/javascript',vendor))+');</script>';
const iframe='<iframe id="question-b0" sandbox="allow-scripts" style="height:400px" src="'+uri('text/html',Buffer.from(original))+'"></iframe>';
let app,staticApp;
try {
  const jsxgraphCore={sha256:createHash('sha256').update(vendor).digest('hex'),bytes:vendor.length};
  const packed=await packageBoard({iframe,id:'question-b0',site,jsxgraphCore,assetMap:url=>{assert.equal(url,'https://cdn.example/mathjax.js');return 'native/boards/mathjax/tex-mml-svg.js';}});
  const packed2=await packageBoard({iframe,id:'question-b1',site,assetMap:()=> 'native/boards/mathjax/tex-mml-svg.js'});
  assert.deepEqual(packed.assets,packed2.assets,'All board templates share content-addressed vendor assets');
  assert.match(packed.html,/sandbox="allow-scripts"/);assert.ok(packed.html.includes('src="about:blank" data-stack-jsxgraph-template="../native/boards/question-b0.html"'));
  assert.ok(!packed.html.includes('base64'));
  const document=await readFile(join(site,packed.path),'utf8');
  assert.match(document,/src="mathjax\/tex-mml-svg.js" crossorigin="anonymous"/);
  assert.match(document,/<link rel="stylesheet"[^>]*crossorigin="anonymous"/);
  assert.match(document,/<script>window.authored="unchanged"; import\("\.\/assets\//);
  assert.ok(!document.includes('base64'));
  assert.ok(document.includes('data-ctm-jsxgraph-sha256="'+jsxgraphCore.sha256+'"'));
  assert.ok(document.includes('data-ctm-jsxgraph-bytes="'+vendor.length+'"'));
  await assert.rejects(packageBoard({iframe,id:'wrong-core',site,assetMap:()=> 'native/boards/mathjax/tex-mml-svg.js',jsxgraphCore:{...jsxgraphCore,sha256:'0'.repeat(64)}}),/one exact JSXGraph/);
  const mathjax={preloader:'native/boards/assets/preloader.js',config:{loader:{paths:{mathjax:'native/boards/mathjax/npm/mathjax@4.1.3',sre:'native/boards/mathjax/npm/mathjax@4.1.3/sre'}},svg:{fontPath:'native/boards/mathjax/npm/@mathjax/font'},chtml:{fontPath:'native/boards/mathjax/npm/@mathjax/font',fontURL:'native/boards/mathjax/npm/@mathjax/font/chtml/woff2'}}};
  const configured=await packageBoard({iframe,id:'configured',site,assetMap:()=> 'native/boards/mathjax/tex-mml-svg.js',mathjax});
  const configuredHTML=await readFile(join(site,configured.path),'utf8');
  assert.ok(configuredHTML.indexOf('window.MathJax=c')<configuredHTML.indexOf('src="assets/preloader.js"'));
  assert.ok(configuredHTML.indexOf('src="assets/preloader.js"')<configuredHTML.indexOf('id="MathJax-script"'));
  assert.ok(configuredHTML.includes('data-ctm-mathjax-transport="cors"'),'Native boards explicitly opt into canonical CORS-only static transport');
  const scope={window:{},document:{baseURI:'https://offline.test/course/native/boards/configured.html'},URL};
  vm.runInNewContext(configuredHTML.match(/<script>([\s\S]*?)<\/script>/)[1],scope);
  assert.equal(scope.window.MathJax.loader.paths.sre,'https://offline.test/course/native/boards/mathjax/npm/mathjax@4.1.3/sre');
  assert.equal(scope.window.MathJax.chtml.fontURL,'https://offline.test/course/native/boards/mathjax/npm/@mathjax/font/chtml/woff2');
  assert.ok(!configuredHTML.includes('crossorigin="anonymous" crossorigin='));
  for(const asset of packed.assets.filter(row=>row.sha256)) {
    const bytes=await readFile(join(site,asset.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
    assert.deepEqual(bytes,asset.path.endsWith('.js')?vendor:css);
  }
  await assert.rejects(packageBoard({iframe,id:'bad',site,assetMap:()=>undefined}),/Unmapped/);
  await assert.rejects(packageBoard({iframe,id:'../escape',site,assetMap:()=>''}),/Unsafe/);
  await mkdir(join(site,'native/boards/mathjax'),{recursive:true});await writeFile(join(site,'native/boards/mathjax/tex-mml-svg.js'),'/* staged MathJax */');
  app=await serveDemo({root:site});
  const asset=await fetch(app.baseURL+packed.assets[0].path);
  assert.equal(asset.headers.get('access-control-allow-origin'),'*');
  assert.equal(asset.headers.get('cross-origin-resource-policy'),'cross-origin');
  const template=await fetch(app.baseURL+packed.path);
  assert.equal(template.headers.get('access-control-allow-origin'),null);
  assert.equal(template.headers.get('cross-origin-resource-policy'),'cross-origin');
  assert.equal(template.headers.get('cross-origin-embedder-policy'),'require-corp');
  for(const path of ['native/boards/readme.txt','native/private.html','native/boards/private/other.html']){
    const response=await fetch(app.baseURL+path);
    assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin','Non-template resources retain original CORP');
    assert.equal(response.headers.get('access-control-allow-origin'),null);
  }
  staticApp=await serveDemo({root:site,isolationHeaders:false});
  const staticParent=await fetch(staticApp.baseURL+'native/private.html');
  for(const name of ['cross-origin-opener-policy','cross-origin-embedder-policy','cross-origin-resource-policy'])assert.equal(staticParent.headers.get(name),null);
  const staticAsset=await fetch(staticApp.baseURL+packed.assets[0].path);
  assert.equal(staticAsset.headers.get('cross-origin-resource-policy'),null);
  assert.equal(staticAsset.headers.get('access-control-allow-origin'),'*');
  assert.match(staticAsset.headers.get('cache-control'),/max-age=3600/);
  console.log('Board packaging: exact vendor bytes, shared files, numeric data boundary, CORS and isolation passed');
} finally {if(staticApp)await staticApp.close();if(app)await app.close();await rm(site,{recursive:true,force:true});}
