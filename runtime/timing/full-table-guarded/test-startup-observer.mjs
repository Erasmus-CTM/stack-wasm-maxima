import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {deriveStartupObserver} from './derive-startup-observer.mjs';
const observer=await readFile(new URL('./startup-observer.jsfrag',import.meta.url),'utf8');
const original=await readFile(new URL('../gc-main-integration/prototype/runtime/maxima-child.js',import.meta.url));
const {derived,proof}=deriveStartupObserver(original);new vm.Script(derived.toString());
assert.equal(proof.original.sha256,'24125f846a4fb7d3f57c82327bb5dfe267998682858d25369045de44d1ec1e0b');
assert.throws(()=>deriveStartupObserver(Buffer.concat([original,Buffer.from(' ')])),/Exact admitted/);
const insertedFailure=derived.toString().match(/function fail\(error\) \{[\s\S]*?\n\}/)[0];
const consume=derived.toString().match(/function consume\(text\) \{[\s\S]*?\n\}/)[0];
function fixture(){
  const messages=[];const context=vm.createContext({self:{postMessage:message=>messages.push(structuredClone(message))},performance:{now:()=>1},console});
  vm.runInContext("let stdoutTail='',outputLine='',initialized=false,control; const C={REQUEST:5}; let stages={},started=0; function deliver(){throw Error('Unexpected result')};\n"+observer+'\n'+insertedFailure+'\n'+consume,context);
  const feed=text=>{context.next=text;vm.runInContext('consume(next)',context);};
  const fail=()=>vm.runInContext("fail(new Error('synthetic original failure'))",context);
  const receipts=()=>messages.filter(r=>r.type==='diagnostic').map(r=>JSON.parse(r.text.slice('CTM-STARTUP-GUARD|'.length)));
  return {context,messages,feed,fail,receipts};
}
const valid='CTMSTACK-LOAD-BEGIN\nloading errortostring.lisp\nwarning: unsupported syscall: __syscall_getrusage\nCTMSTACK-LOAD-END\nCTMMAXIMA-READY|version|maxima\n';
const good=fixture();for(const character of valid)good.feed(character);assert.equal(good.receipts().length,1);assert.equal(good.receipts()[0].passed,true);assert.equal(good.messages.at(-1).type,'ready');
good.feed('loadfile: failed to load deliberate-post-ready.lisp\n-- an error. To debug this try:\n');assert.equal(good.receipts().length,1);assert.equal(good.messages.some(r=>r.type==='error'),false);
for(const text of ['loadfile: failed to load draw.lisp','Maxima encountered a Lisp error: fixture','-- an error. To debug this try:','incorrect syntax: fixture']){
  const bad=fixture();bad.feed('CTMSTACK-LOAD-BEGIN\n'+text+'\n');bad.feed('ignored later text\n'.repeat(3000)+valid);
  assert.equal(bad.receipts().length,1);assert.equal(bad.receipts()[0].passed,false);assert.match(bad.receipts()[0].firstFatal.line,new RegExp(text.split(':')[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));assert.equal(bad.messages.filter(r=>r.type==='error').length,1);assert.equal(bad.messages.some(r=>r.type==='ready'),false);
}
for(const text of ['CTMSTACK-LOAD-END\n','CTMMAXIMA-READY|v|m\n','CTMSTACK-LOAD-BEGIN\nCTMSTACK-LOAD-BEGIN\n','CTMSTACK-LOAD-BEGIN\nCTMSTACK-LOAD-END\nCTMSTACK-LOAD-END\n','CTMSTACK-LOAD-BEGIN\nCTMSTACK-LOAD-END\nCTMMAXIMA-READY|bad\n']){const bad=fixture();bad.feed(text+valid);assert.equal(bad.receipts().length,1);assert.equal(bad.receipts()[0].passed,false);assert.equal(bad.messages.some(r=>r.type==='ready'),false);}
const failed=fixture();failed.feed('CTMSTACK-LOAD-BEGIN\n');failed.fail();failed.feed(valid);assert.equal(failed.receipts().length,1);assert.equal(failed.receipts()[0].passed,false);assert.equal(failed.messages.some(r=>r.type==='ready'),false);
const long=fixture();long.feed('bounded benign output\n'.repeat(10000)+valid);assert.equal(long.receipts()[0].passed,true);assert.equal(long.receipts()[0].stdoutTail.length,16384);assert.equal(long.receipts()[0].stdoutTailTruncated,true);assert.ok(JSON.stringify(long.receipts()[0]).length<65536);
const sample=JSON.parse(await readFile('/workspace/work/compiler-audit-evidence/12578335489/trials/03-baseline-source-instrumented/sample.json'));
const tails=[];function visit(value){if(!value||typeof value!=='object')return;for(const [k,v] of Object.entries(value)){if(k==='startupStdoutTail'&&typeof v==='string')tails.push(v);else if(typeof v==='object')visit(v);}}visit(sample);
const failing=tails.find(t=>t.includes('loadfile: failed to load')&&t.includes('draw.lisp'));assert.ok(failing,'Actual retained failing tail required');
const actual=fixture();actual.feed('CTMSTACK-LOAD-BEGIN\n');actual.feed(failing);assert.equal(actual.receipts()[0].passed,false);assert.ok(actual.receipts()[0].firstFatal.line.includes('draw.lisp'));assert.equal(actual.messages.some(r=>r.type==='ready'),false);
console.log(JSON.stringify({passed:true,scope:'Trusted observer/consume source with synthetic transport and read-only actual failed stdout data; no browser/CAS/Lisp/Wasm/artifact program executed',original:proof.original,derived:proof.derived,actualFailureFixture:{artifact:12578335489,replayedTailCharacters:failing.length,syntheticBeginPrefix:true},checks:['exact original hash','stream fragments','ordered success','post-ready caught errors unaffected','four anchored diagnostics','sticky fatal survives later READY','five marker order failures','original fail remains fatal','bounded long output','actual draw.lisp failure retained/rejected']}));
