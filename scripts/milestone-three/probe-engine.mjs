// SPDX-License-Identifier: AGPL-3.0-or-later
// Fast feedback on actual native preparation/validation/PRTs before Quarto.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { serveDemo } from '../milestone-two/serve.mjs';

const root = resolve(process.env.NATIVE_SITE || '.cache/loader-demo');
const output = resolve(process.env.NATIVE_OUTPUT || 'test-results/native-probe');
await mkdir(output,{recursive:true});
const inventory = JSON.parse(await readFile(resolve(root,'native/questions.json')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {schema:1,createdAt:new Date().toISOString(),sourceRevision:process.env.GITHUB_SHA || null,
  runtime:JSON.parse(await readFile(resolve(root,'runtime-assets.json'))),
  scope:'Actual native worker preparation/validation/PRTs. Browser UI and graphical interaction have separate checks.',
  sourcePins:{stack:inventory.stackRevision,checkers:inventory.ctmCheckersRevision},files:[],programs:[],events:[],rows:[],passed:false};
for(const path of ['native/questions.json','native/engine.js','native/input.js','native/input-rules.json','native/input-provenance.json',
  'native/feedback.js','native/feedback-messages.json','native/feedback-provenance.json','native/backend-worker.js','runtime/maxima-session.js','runtime/maxima-child.js']) {
  const bytes=await readFile(resolve(root,path)); report.files.push({path,bytes:bytes.length,sha256:hash(bytes)});
}
await writeFile(resolve(root,'native-probe.html'),'<!doctype html><title>Native engine probe</title>');
const app=await serveDemo({root});
let browser;
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE || undefined});
  report.browserVersion=browser.version();
  const page=await browser.newPage();
  await page.goto(app.baseURL+'native-probe.html');
  await page.evaluate(() => {
    const worker = new Worker('native/backend-worker.js'), pending = new Map();
    window.nativeEvidence = {events:[],calls:[],requests:0};
    worker.onmessage=({data})=>{
      if(data.type==='backend-event'){window.nativeEvidence.events.push(data);return;}
      const task=pending.get(data.id);if(!task)return;pending.delete(data.id);clearTimeout(task.timer);
      window.nativeEvidence.calls.push(data);
      task.resolve(data);
    };
    window.nativeCall = payload => new Promise((resolveCall,reject)=>{
      const id=++window.nativeEvidence.requests;
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Native probe timeout'));},300000);
      pending.set(id,{resolve:resolveCall,timer});worker.postMessage({id,...payload});
    });
  });
  async function call(payload) {
    const reply=await page.evaluate(payload=>window.nativeCall(payload),payload);
    assert.equal(reply.ok,true,reply.error);
    return reply;
  }
  const init=await call({type:'init',recordPrograms:true});
  report.initialization=init.backend;
  for(const entry of inventory.questions.filter(entry=>!entry.python)) {
    for(const seed of entry.seeds) {
      const variant=(await call({type:'prepare',question:entry.question,seed})).result;
      const row={id:entry.id,seed,variant};report.rows.push(row);
      let answers=variant.qtests?.[0]?.answers;
      if(!answers || !Object.keys(answers).length) answers=Object.fromEntries(Object.entries(variant.teachers).map(([name,value])=>[name,value.source]));
      if(entry.id==='native-json') answers={ans1:'[{"x":1,"y":2,"color":"red"}]'};
      row.validation=await call({type:'validate',question:entry.question,variant,answers});
      assert.equal(row.validation.result.status,'valid',entry.id+' model input must validate');
      row.grade=await call({type:'grade',question:entry.question,variant,answers});
      assert.equal(row.grade.result.status,'graded',entry.id+' model must grade');
      assert.equal(row.grade.result.score,1,entry.id+' model must get full credit');
      if(entry.question.qtests?.length) {
        row.tests=await call({type:'tests',question:entry.question,variant});
        assert.equal(row.tests.result.passed,true,entry.id+' authored tests must pass');
      }
      for(const probe of entry.probes || []) {
        const actual=await call({type:'grade',question:entry.question,variant,answers:probe.answers});
        assert.equal(actual.result.status,probe.status,entry.id+' probe status');
        assert.equal(actual.result.score,probe.score,entry.id+' probe score');
        (row.probes ||= []).push({probe,actual});
      }
      console.log(JSON.stringify({id:entry.id,seed,status:row.grade.result.status,score:row.grade.result.score,tests:row.tests?.result.results.length || 0}));
      await writeFile(resolve(output,'browser.json'),JSON.stringify(report,null,2)+'\n');
    }
  }
  // Independent regression probes exercise written forms and native string
  // values that can disappear if build preparation simplifies test inputs.
  const base=inventory.questions.find(entry=>entry.id==='native-rational').question;
  function regression(name,test,teacher,answer) {
    const question=JSON.parse(JSON.stringify(base));
    question.name=name;question.variables='';question.simplify=true;
    question.native={schema:1,id:name,locals:[],tokens:[],boards:[]};
    question.inputs=[{...question.inputs[0],name:'ans1',teacher,type:'algebraic',requirelowestterms:false,checkanswertype:false}];
    question.prts=[{name:'prt1',value:1,autosimplify:true,feedbackvariables:'',locals:[],nodes:[{
      name:'0',test,student:'ans1',teacher,options:'',quiet:true,
      true:{mode:'=',score:1,next:-1,note:'probe-T',feedback:''},
      false:{mode:'=',score:0,next:-1,note:'probe-F',feedback:''}}]}];
    question.qtests=[{testcase:'1',inputs:{ans1:answer},expected:{prt1:{score:0,penalty:question.penalty,note:'probe-F'}}}];
    return question;
  }
  for(const question of [regression('probe-lowest-terms','LowestTerms','1/2','2/4'),
    regression('probe-held-equalcomass','EqualComAss','2*x','x+x')]) {
    const variant=(await call({type:'prepare',question,seed:1})).result;
    const tests=(await call({type:'tests',question,variant})).result;
    assert.equal(tests.passed,true,question.name+' must retain authored input form');
    report.rows.push({id:question.name,variant,tests});
  }
  const jsonQuestion=regression('probe-json-qtest','AlgEquiv','"[]"','"[{\\"x\\":1}]"');
  jsonQuestion.inputs[0].type='json';jsonQuestion.prts[0].nodes[0].teacher='ans1';
  jsonQuestion.qtests[0].expected.prt1={score:1,penalty:0,note:'probe-T'};
  const jsonVariant=(await call({type:'prepare',question:jsonQuestion,seed:1})).result;
  assert.equal(jsonVariant.qtests[0].answers.ans1,'[{"x":1}]','JSON qtest strings must lose Maxima quoting');
  const jsonTests=(await call({type:'tests',question:jsonQuestion,variant:jsonVariant})).result;
  assert.equal(jsonTests.passed,true);
  report.rows.push({id:jsonQuestion.name,variant:jsonVariant,tests:jsonTests});
  const evidence=await page.evaluate(()=>window.nativeEvidence);
  report.events=evidence.events;
  report.programs=evidence.events.filter(event=>event.event==='native-evaluate').map(({operation,question,expression,result})=>({operation,question,expression,result}));
  report.passed=true;
}catch(error){report.failure={message:String(error),stack:error.stack};console.error(JSON.stringify(report.failure));}
finally{
  if(browser){
    try { const pages=browser.contexts()[0]?.pages();if(pages?.length){const evidence=await pages[0].evaluate(()=>window.nativeEvidence);report.events=evidence?.events || report.events;report.programs=report.events.filter(event=>event.event==='native-evaluate').map(({operation,question,expression,result})=>({operation,question,expression,result}));}} catch{}
    await browser.close();
  }
  report.network=app.requests;await app.close();
  await writeFile(resolve(output,'browser.json'),JSON.stringify(report,null,2)+'\n');
}
if(!report.passed)process.exitCode=1;
