// SPDX-License-Identifier: AGPL-3.0-or-later
// Exercise the real shared CTM UI and record the native programs it executes.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, join, dirname, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {serveDemo} from '../milestone-two/serve.mjs';
import {matrixCells} from '../milestone-two/browser.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const site = resolve(process.env.NATIVE_SITE || process.argv[2] || 'site/_site');
const output = resolve(process.env.NATIVE_OUTPUT || process.argv[3] || 'test-results/milestone-three');
const liveURL = process.env.NATIVE_PAGE_URL ? new URL(process.env.NATIVE_PAGE_URL) : null;
if (liveURL) assert.equal(liveURL.protocol, 'https:');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item);
await mkdir(output, {recursive:true});

// Only turn on diagnostics in the actual native worker. All assessment
// requests/responses and every Worker execution remain real and unmodified.
function observeNativeWorkers() {
  const RealWorker = window.Worker;
  const state = window.__nativeHarness = {workers:[], calls:[], events:[]};
  // Keep live references outside the JSON evidence object. Late diagnostic
  // regressions reuse the same real worker after all reviewer-facing UI tests.
  const workerObjects = window.__nativeWorkerObjects = [];
  window.Worker = class extends RealWorker {
    constructor(url, options) {
      super(url, options);
      const descriptor = {id:state.workers.length, url:String(url), createdAt:performance.now()};
      state.workers.push(descriptor);
      workerObjects.push(this);
      this.addEventListener('message', ({data}) => {
        const receivedAt = performance.now();
        if (data?.type === 'backend-event') {state.events.push({worker:descriptor.id, receivedAt, data}); return;}
        const call = state.calls.findLast(row => row.worker === descriptor.id && row.id === data?.id && !row.response);
        if (call) Object.assign(call, {response:data, receivedAt, elapsedMs:receivedAt-call.sentAt});
      });
      this.addEventListener('error', error => state.events.push({worker:descriptor.id, error:error.message, receivedAt:performance.now()}));
      const send = this.postMessage.bind(this);
      this.postMessage = (data, transfer) => {
        const request = data?.type === 'init' && /\/native\/backend-worker\.js(?:[?#]|$)/.test(descriptor.url)
          ? {...data, recordPrograms:true} : data;
        state.calls.push({worker:descriptor.id, id:request?.id, type:request?.type, question:request?.question?.name,
          seed:request?.variant?.seed, answers:request?.answers, sentAt:performance.now()});
        return transfer === undefined ? send(request) : send(request, transfer);
      };
    }
  };
}

// The pinned CTM component imports this small configuration helper for every
// card. It contains no interpreter, standard library, wheel or initialized CAS.
const runtimeConfiguration = url => /\/site_libs\/quarto-contrib\/ctm-runtime-[^/]+\/pyodide-runtime\.js(?:[?#]|$)/.test(url);
const pythonAsset = url => !runtimeConfiguration(url) && /\/(?:pyodide(?:[./-]|$)|python_stdlib\.zip)|\/(?:sympy|mpmath|micropip)[^/]*\.whl(?:[?#]|$)|\.whl(?:[?#]|$)/i.test(url);
const safeConsole = text => /^warning: unsupported syscall: __syscall_(?:prlimit64|getrusage)\s*$/.test(text);
const report = {schema:1, createdAt:new Date().toISOString(), sourceRevision:process.env.GITHUB_SHA ||
  execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),
  scope:'Native preparation and bounded input/PRT path in the shared CTM UI, with explicitly optional PythonChecker and JSXGraph bindings',
  rows:[], programs:[], graphics:[], network:[], errors:[], consoleErrors:[], screenshots:[], passed:false};
let app, browser, page, baseURL;
const networkTasks = [];

const fieldSelector = name => '.stack-answer[data-name=' + JSON.stringify(name) + ']';
const cardSelector = id => 'section.stack-sympy[data-stack-id=' + JSON.stringify(id) + ']';
const state = card => card.evaluate(element => ({
  fields:[...element.querySelectorAll('.stack-answer[data-name]')].map(input => ({name:input.dataset.name,
    value:input.matches('input,textarea') ? input.value : null,
    cells:[...input.querySelectorAll('input[data-matrix-row]')].map(cell=>cell.value)})),
  checkDisabled:element.querySelector('.stack-check').disabled,
  result:element.querySelector('.stack-result').textContent,
  resultState:element.querySelector('.stack-result').dataset.state || null,
  variant:element.querySelector('.stack-variant')?.value || '0'
}));

async function action(card, type, {allowWorkerError=false}={}) {
  const id = await card.getAttribute('data-stack-id');
  const before = await page.evaluate(()=>window.__nativeHarness.calls.length);
  const button = card.locator({tests:'.stack-tests',validate:'.stack-validate',grade:'.stack-check'}[type]);
  assert.equal(await button.isEnabled(),true,`${id}: ${type} must be usable through the actual UI`);
  await button.click();
  await page.waitForFunction(({before,type,id}) => window.__nativeHarness.calls.slice(before)
    .some(call=>call.type===type && call.response) ||
    document.querySelector('section.stack-sympy[data-stack-id='+JSON.stringify(id)+'] .stack-result')?.dataset.state==='error',
  {before,type,id},{timeout:330000});
  const call = await page.evaluate(({before,type})=>window.__nativeHarness.calls.slice(before).find(row=>row.type===type && row.response),{before,type});
  assert.ok(call,`${id}: ${type} did not reach the native worker: ${await card.locator('.stack-result').textContent()}`);
  assert.equal(call.response.backend?.id,'maxima-native',`${id}: wrong backend`);
  if (!allowWorkerError) assert.equal(call.response.ok,true,`${id}: ${type}: ${call.response.error || 'native worker failed'}`);
  await page.waitForFunction(element=>element.querySelector('.stack-result').dataset.state!=='loading',await card.elementHandle(),{timeout:10000});
  const events=await page.evaluate(({worker,id})=>window.__nativeHarness.events.filter(row=>row.worker===worker && row.data?.requestId===id),call);
  return {call,events};
}

async function fillAnswers(card, answers) {
  const submitted={...answers};
  const fields=await card.locator('.stack-answer[data-name]').evaluateAll(items=>items.map(item=>({name:item.dataset.name,matrix:item.classList.contains('stack-matrix')})));
  assert.equal(fields.length,Object.keys(answers).length,'Every authored input needs a submitted answer');
  for (const {name,matrix} of fields) {
    const field=card.locator(fieldSelector(name));
    assert.equal(typeof answers[name],'string',name+' must preserve its raw answer spelling');
    if (!matrix) {
      if (await field.isVisible()) await field.fill(answers[name]);
      else await field.evaluate((element,value)=>{element.value=value;element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));},answers[name]);
      continue;
    }
    const rows=matrixCells(answers[name]);
    // The matrix editor submits each entered scalar in parentheses.
    // Declare that exact UI spelling before observing any worker request.
    submitted[name]='matrix('+rows.map(row=>'['+row.map(cell=>'('+cell+')').join(',')+']').join(',')+')';
    for (const [axis,key,target] of [['row','rows',rows.length],['col','cols',rows[0].length]]) {
      for (let attempt=0;attempt<40;attempt++) {
        const actual=Number(await field.locator('.math-dynamic-mat').getAttribute('data-'+key));
        if (actual===target) break;
        const button=field.locator('[data-dynamic-action='+JSON.stringify((actual<target?'add-':'remove-')+axis)+']');
        assert.equal(await button.isEnabled(),true,'Matrix editor cannot reach the authored shape');
        await button.click();
      }
      assert.equal(Number(await field.locator('.math-dynamic-mat').getAttribute('data-'+key)),target);
    }
    for (let row=0;row<rows.length;row++) for (let col=0;col<rows[0].length;col++) {
      await field.locator('input[data-matrix-row="'+(row+1)+'"][data-matrix-column="'+(col+1)+'"]').fill(rows[row][col]);
    }
  }
  return submitted;
}

function requiredSequence(question,result) {
  return Object.entries(result.prts||{}).flatMap(([name,prt])=>{
    const authored=question.prts.find(value=>value.name===name);
    assert.ok(authored,'Returned PRT must belong to the question');
    return (prt.path||[]).map(branch=>{
      const node=authored.nodes.find(value=>String(value.name)===String(branch.node));
      assert.ok(node,'Returned branch must identify an authored node');
      return {prt:name,node:String(node.name),test:node.test};
    });
  });
}

function assertRouteOrder(question,result,events) {
  const required=requiredSequence(question,result);
  const actual=events.filter(row=>row.data.event==='native-at' || row.data.event==='python-checker-result')
    .map(row=>row.data.event==='python-checker-result'?'PythonChecker':row.data.test);
  assert.deepEqual(actual,required.map(row=>row.test),'Actual native/Python dispatch order must match each visited authored node exactly once');
  return {required,actual};
}

function assertReadableNativeFeedback(result,events,{key,message}) {
  const raw=events.filter(row=>row.data.event==='native-at' && row.data.nativeFeedback?.includes("stack_trans('"+key+"'"));
  assert.ok(raw.length>0,'Real native answer-test evidence must retain the exact '+key+' translation protocol');
  assert.match(result.feedback,message,'Native grade feedback must contain the pinned readable English message');
  assert.doesNotMatch(result.feedback,/stack_trans\(|!NEWLINE!|!quot!|Native STACK feedback \(untranslated\)/,'Supported native feedback must render without raw protocol');
  return {key,raw:raw.map(row=>row.data.nativeFeedback),rendered:result.feedback};
}

async function assertNoPython(label) {
  await Promise.allSettled(networkTasks);
  const assets=report.network.filter(row=>pythonAsset(row.url));
  assert.deepEqual(assets,[],label+': native operations must load no Python Wasm, standard library or checker/SymPy wheels');
  const replies=await page.evaluate(()=>window.__nativeHarness.calls.filter(row=>row.response?.backend).map(row=>row.response.backend));
  assert.ok(replies.every(backend=>backend.pythonLoaded!==true),label+': worker must report Python uninitialized');
  report.nativeOnlyNetwork={through:label,requests:report.network.length,pythonAssets:assets,
    configurationHelpers:report.network.filter(row=>runtimeConfiguration(row.url))};
}

async function directNative(request, {allowWorkerError=false}={}) {
  const observed=await page.evaluate(async request=>{
    const state=window.__nativeHarness;
    const descriptor=state.workers.find(row=>/\/native\/backend-worker\.js(?:[?#]|$)/.test(row.url));
    if(!descriptor)throw new Error('No initialized native worker is available for the diagnostic regression');
    const worker=window.__nativeWorkerObjects[descriptor.id];
    const id='native-regression-'+(window.__nativeDirectSequence=(window.__nativeDirectSequence||0)+1);
    const response=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{worker.removeEventListener('message',receive);reject(new Error('Native diagnostic request timed out: '+request.type));},330000);
      function receive({data}) {
        if(data?.id!==id)return;
        clearTimeout(timer);worker.removeEventListener('message',receive);resolve(data);
      }
      worker.addEventListener('message',receive);worker.postMessage({...request,id});
    });
    return {request,response,worker:descriptor.id,events:state.events.filter(row=>row.worker===descriptor.id && row.data?.requestId===id)};
  },request);
  assert.equal(observed.response.backend?.id,'maxima-native','Diagnostic requests must execute on the real initialized native backend');
  if(!allowWorkerError)assert.equal(observed.response.ok,true,observed.response.error || request.type+' diagnostic request failed');
  return observed;
}

// These are explicit CTM regression fixtures, distinct from the unchanged
// upstream question inventory. Their literal authored spellings exercise the
// CAS boundaries that ordinary graph/JSON examples do not cover.
async function formRegressions(questions) {
  const original=questions.find(row=>row.id==='native-mixed-board').payload.question;
  const simple=(id,{teacher='1/2',test='LowestTerms',type='algebraic'}={})=>{
    const question=structuredClone(original),input=structuredClone(question.inputs[0]);
    Object.assign(question,{name:id,variables:'',simplify:true,questiontext:'CTM native boundary regression',generalfeedback:'',specificfeedback:'',questionnote:'',qtests:[]});
    question.native={schema:1,id,locals:[],tokens:[],boards:[]};
    Object.assign(input,{type,teacher,checkanswertype:false});question.inputs=[input];
    delete question.python_checkers;
    const branch=(score,note)=>({mode:'=',score,next:-1,note,feedback:''});
    question.prts=[{name:'prt1',value:1,autosimplify:true,feedbackvariables:'',locals:[],nodes:[{
      name:'0',test,student:input.name,teacher,options:'',quiet:false,true:branch(1,'form-T'),false:branch(0,'form-F')
    }]}];
    return question;
  };
  const evidence=[];
  const prepare=async question=>{
    const row={id:question.native.id,provenance:'CTM authored boundary regression; not an upstream example',question,questionSha256:hash(JSON.stringify(question))};
    evidence.push(row);report.formRegressions=evidence;
    row.preparation=await directNative({type:'prepare',question,seed:1});
    return {row,variant:row.preparation.response.result};
  };
  for(const [id,test,teacher,answers] of [
    ['regression-lowest-terms','LowestTerms','1/2',['2/4','1/2']],
    ['regression-written-form','EqualComAss','2*x',['x+x','2*x']]
  ]) {
    const question=simple(id,{test,teacher}),name=question.inputs[0].name;
    question.qtests=answers.map((answer,index)=>({testcase:String(index+1),inputs:{[name]:answer},expected:{prt1:{score:index,penalty:index?0:question.penalty,note:index?'form-T':'form-F'}}}));
    const {row,variant}=await prepare(question);
    assert.deepEqual(variant.qtests.map(test=>test.answers[name]),answers,'Native qtest preparation must retain the literal authored written operations');
    row.authoredTests=await directNative({type:'tests',question,variant});
    assert.equal(row.authoredTests.response.result.passed,true,id+': actual native form-sensitive tests must distinguish written expressions');
    assert.equal(row.authoredTests.response.result.results.length,2);
    if(test==='LowestTerms')row.nativeFeedback=assertReadableNativeFeedback(row.authoredTests.response.result.results[0].actual,row.authoredTests.events,
      {key:'ATLowestTerms_entries',message:/following terms in your answer are not in lowest terms/i});
  }
  for(const [id,type,raw] of [
    ['regression-json-qtest','json','[{"x":1,"y":2,"color":"red"}]'],
    ['regression-string-qtest','string','plain "quoted" text']
  ]) {
    const question=simple(id,{test:'AlgEquiv',teacher:JSON.stringify(raw),type}),name=question.inputs[0].name;
    question.prts[0].nodes[0].teacher=name;
    question.qtests=[{testcase:'1',inputs:{[name]:JSON.stringify(raw)},expected:{prt1:{score:1,penalty:0,note:'form-T'}}}];
    const {row,variant}=await prepare(question);
    assert.equal(variant.qtests[0].answers[name],raw,'Native '+type+' authored answers must contain raw text, without outer Maxima source quotes');
    row.authoredTests=await directNative({type:'tests',question,variant});
    assert.equal(row.authoredTests.response.result.passed,true,id+': raw text must survive actual native validation and grading');
  }
  for(const [id,test,teacher,answers,scores] of [
    ['regression-mixed-lowest-terms','LowestTerms','1/2',['[2/4,2]','[1/2,2]'],[0.75,1]],
    ['regression-mixed-written-form','EqualComAss','2*x',['[x+x,2]','[2*x,2]'],[0.5,0.75]]
  ]) {
    const question=structuredClone(original),name=question.inputs[0].name;
    Object.assign(question,{name:id,variables:'',qtests:[],simplify:true});
    question.native={schema:1,id,locals:[],tokens:[],boards:[]};
    question.inputs[0].teacher='['+teacher+',2]';question.inputs[0].checkanswertype=false;
    question.prts[0].feedbackvariables='';question.prts[0].locals=[];
    question.prts[0].nodes[0].teacher='2';question.prts[0].nodes[1].teacher='[2,2]';
    for(const node of question.prts[0].nodes)for(const branch of ['true','false'])node[branch].feedback='';
    const last=question.prts[0].nodes[2];Object.assign(last,{test,student:name+'[1]',teacher,options:''});
    const {row,variant}=await prepare(question);row.probes=[];
    for(let index=0;index<answers.length;index++) {
      const observed=await directNative({type:'grade',question,variant,answers:{[name]:answers[index]}});
      assert.equal(observed.response.result.status,'graded');
      assert.equal(observed.response.result.score,scores[index],id+': late native form test must see the original written input across Python continuation');
      const routing=assertRouteOrder(question,observed.response.result,observed.events);
      assert.deepEqual(routing.actual,['AlgEquiv','PythonChecker',test]);
      row.probes.push({answer:answers[index],expectedScore:scores[index],observed,routing});
    }
    const repeated=await directNative({type:'grade',question,variant,answers:{[name]:answers[0]}});
    assert.equal(repeated.response.result.score,scores[0],'A later answer must not leak into the next native/Python continuation');row.repeated=repeated;
  }
  const rejected=simple('regression-rejected-assignment');
  rejected.variables='a:ctmleakprobevariable:42;';rejected.native.locals=['a'];
  const failure=await directNative({type:'prepare',question:rejected,seed:1},{allowWorkerError:true});
  assert.equal(failure.response.ok,false);assert.match(failure.response.error,/Nested assignments/);
  assert.equal(failure.events.some(row=>row.data.event==='native-evaluate'),false,'Nested assignment must be rejected before a native program executes');
  evidence.push({id:rejected.native.id,provenance:'CTM authored boundary regression; not an upstream example',question:rejected,questionSha256:hash(JSON.stringify(rejected)),rejection:failure});
  const following=simple('regression-no-assignment-leak');following.variables='a:ctmleakprobevariable;';following.native.locals=['a'];
  const {row,variant}=await prepare(following);assert.equal(variant.env.a,'ctmleakprobevariable','Rejected question code must leave no global variable assignment');row.precedingRejectedQuestion=rejected.native.id;
  const frozen=simple('regression-frozen-random-teacher',{test:'AlgEquiv',teacher:'rand(5)'});frozen.prts[0].nodes[0].teacher=frozen.inputs[0].name;
  const prepared=await prepare(frozen),name=frozen.inputs[0].name,source=prepared.variant.teachers[name].source;
  assert.match(source,/^\d+$/);prepared.row.validations=[];
  for(let index=0;index<3;index++) {
    const observed=await directNative({type:'validate',question:frozen,variant:prepared.variant,answers:{[name]:source}});
    assert.equal(observed.response.result.status,'valid');
    const programs=observed.events.filter(row=>row.data.event==='native-evaluate');
    assert.ok(programs.length>0);assert.ok(programs.every(row=>!row.data.expression.includes('rand(')),'Validation must use the frozen model answer without rerolling the teacher');
    prepared.row.validations.push(observed);
  }
  const randomPrt=simple('regression-random-prt-rejected');randomPrt.prts[0].nodes[0].teacher='rand(5)';
  const rejection=await directNative({type:'prepare',question:randomPrt,seed:1},{allowWorkerError:true});
  assert.equal(rejection.response.ok,false);assert.match(rejection.response.error,/Random response-tree expressions/);
  assert.equal(rejection.events.some(row=>row.data.event==='native-evaluate'),false,'Random response-tree source must be rejected before a native program executes');
  evidence.push({id:randomPrt.native.id,provenance:'CTM authored boundary regression; not an upstream example',question:randomPrt,questionSha256:hash(JSON.stringify(randomPrt)),rejection});
  return evidence;
}

async function awaitBoards(card) {
  const frames=card.locator('iframe[data-stack-jsxgraph]');
  for (let index=0;index<await frames.count();index++) {
    const handle=await frames.nth(index).elementHandle();
    await page.waitForFunction(element=>element.getAttribute('data-stack-jsxgraph-ready')==='true',handle,{timeout:30000});
    const frame=await handle.contentFrame();
    assert.ok(frame,'A graphical question must contain a real iframe');
    await frame.waitForFunction(()=>window.__ctmStackJSXGraphReady===true && window.JXG && Object.keys(JXG.boards||{}).length>0,null,{timeout:30000});
  }
}

async function dragPoint(card, {input='ans1',pointName,target=[1,1]}={}) {
  await card.scrollIntoViewIfNeeded();
  const frameElement=card.locator('iframe[data-stack-jsxgraph]').first();
  await frameElement.scrollIntoViewIfNeeded();
  const frame=await (await frameElement.elementHandle()).contentFrame();
  await awaitBoards(card);
  const position=await frame.evaluate(({pointName,target})=>{
    const board=Object.values(JXG.boards).find(board=>board && board.objectsList?.some(object=>object.elType==='point' && object.visProp.visible && !object.visProp.fixed));
    if (!board) throw new Error('No interactive JSXGraph board');
    const point=board.objectsList.find(object=>object.elType==='point' && object.visProp.visible && !object.visProp.fixed && (!pointName || object.name===pointName));
    if (!point) throw new Error('No draggable authored point');
    return {name:point.name, before:[point.X(),point.Y()], from:point.coords.scrCoords.slice(1),
      to:[board.origin.scrCoords[1]+target[0]*board.unitX,board.origin.scrCoords[2]-target[1]*board.unitY]};
  },{pointName,target});
  const box=await frameElement.boundingBox();assert.ok(box);
  const field=card.locator(fieldSelector(input));
  const old=await field.inputValue();
  await page.mouse.move(box.x+position.from[0],box.y+position.from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x+position.to[0],box.y+position.to[1],{steps:12});
  await page.mouse.up();
  await page.waitForFunction(({id,input,old})=>document.querySelector('section.stack-sympy[data-stack-id='+JSON.stringify(id)+'] .stack-answer[data-name='+JSON.stringify(input)+']').value!==old,
    {id:await card.getAttribute('data-stack-id'),input,old},{timeout:10000});
  const raw=await field.inputValue();
  assert.notEqual(raw,old,'A real point drag must update the bound CTM answer');
  assert.equal(await card.locator('.stack-check').isDisabled(),true,'Editing the board must invalidate prior validation');
  return {position,raw,input};
}

async function assertGraphicalVariant({entry,card,payload},variant) {
  const expected=entry.graphical?.variantPoints?.find(point=>point.variant===variant);
  if(!expected)return null;
  assert.equal(expected.seed,payload.variants[variant].seed,'Graphical point metadata must identify the selected prepared seed');
  const frame=await (await card.locator('iframe[data-stack-jsxgraph]').first().elementHandle()).contentFrame();
  const coordinates=await frame.evaluate(pointName=>{
    const point=Object.values(JXG.boards).flatMap(board=>board.objectsList).find(point=>point.elType==='point' && point.name===pointName);
    if(!point)throw new Error('Selected graphical variant has no expected authored point');
    return [point.X(),point.Y()];
  },expected.pointName);
  assert.equal(coordinates.length,2);
  assert.ok(coordinates.every((value,axis)=>Math.abs(value-expected.coordinates[axis])<0.01),'The actual JSXGraph point must use this selected variant, including after switching back');
  return {...expected,actualCoordinates:coordinates};
}

// Real pointer input, ordinary Validate/Check, bidirectional binding and reset.
async function exerciseGraphic(item) {
  const {id,entry,card,payload}=item;
  await card.locator('.stack-variant').selectOption('0');
  await card.locator('.stack-reset').click();await awaitBoards(card);
  const initialVariant=await assertGraphicalVariant(item,0);
  const before=await state(card);
  const graphic=entry.graphical || entry.graph || {kind:id==='native-json'?'json-colour-points':'point',input:'ans1'};
  const moved=await dragPoint(card,{...graphic,pointName:graphic.pointName || graphic.name,
    target:graphic.target || (id==='native-json'?[0,1]:[2,2])});
  const validated=await action(card,'validate');assert.equal(validated.call.response.result.status,'valid');
  const graded=await action(card,'grade');assert.equal(graded.call.response.result.status,'graded');
  const stored=await card.locator(fieldSelector(moved.input)).inputValue();assert.equal(stored,moved.raw,'Grading must preserve the current board answer');
  let twoWay=null;
  if(['point','bound-point'].includes(graphic.kind) && (graphic.pointName || graphic.name)) {
    await fillAnswers(card,{[moved.input]:'[1,-1]'});
    const frame=await (await card.locator('iframe[data-stack-jsxgraph]').first().elementHandle()).contentFrame();
    const pointName=graphic.pointName || graphic.name;
    await frame.waitForFunction(name=>Object.values(JXG.boards).some(board=>board.objectsList.some(point=>
      point.elType==='point' && point.name===name && Math.abs(point.X()-1)<0.01 && Math.abs(point.Y()+1)<0.01)),pointName,{timeout:10000});
    assert.equal(await card.locator('.stack-check').isDisabled(),true,'Editing the text input must invalidate the old graph verdict');
    twoWay={raw:await card.locator(fieldSelector(moved.input)).inputValue(),point:[1,-1],passed:true};
  }
  if(['json-colour-points','color-points'].includes(graphic.kind)) {
    const data=JSON.parse(stored);assert.equal(data.length,1,'Dragging the source creates one stored point');
    assert.equal(data[0].color,'black');assert.ok(Math.abs(data[0].x)<0.3 && Math.abs(data[0].y-1)<0.3);
    const inline=card.locator('.stack-feedback[data-name="prt1"]');
    const feedback=await inline.count() ? inline.first() : card.locator('.stack-result .stack-prt-feedback').first();
    await feedback.waitFor({state:'visible'});
    assert.match(await feedback.textContent(),/points|color/i,'Native JSON feedback must be displayed in its actual PRT feedback region');
  }
  const path=id+'.png';await card.screenshot({path:join(output,path),animations:'disabled'});report.screenshots.push({id,path});
  await card.locator('.stack-reset').click();await awaitBoards(card);
  assert.deepEqual((await state(card)).fields,before.fields,'Graph Reset must restore the associated input state');
  report.graphics.push({id,kind:graphic.kind,initialVariant,moved,twoWay,validation:validated,grade:graded,reset:await state(card)});
}

async function openPage(url) {
  const interrupted=error=>Boolean(liveURL) && /Execution context was destroyed|Cannot find context|interrupted by another navigation|ERR_ABORTED/.test(String(error));
  try {const response=await page.goto(url,{waitUntil:'load',timeout:90000});assert.equal(response.status(),200);}
  catch(error){if(!interrupted(error))throw error;}
  const deadline=Date.now()+120000;
  for(;;) {
    try {await page.waitForFunction(()=>self.crossOriginIsolated && document.querySelectorAll('section.stack-sympy .stack-reset').length>0,null,{timeout:Math.max(1,deadline-Date.now())});break;}
    catch(error){if(!interrupted(error)||Date.now()>=deadline)throw error;}
  }
  assert.equal(await page.evaluate(()=>self.crossOriginIsolated),true);
}

async function verifyLivePage(expected) {
  const response=await page.request.get(liveURL.href,{headers:{'Cache-Control':'no-cache'},timeout:90000});
  assert.equal(response.status(),200,'The exact public native page must be available');
  const bytes=await response.body(),actual={url:response.url(),bytes:bytes.length,sha256:hash(bytes),checkedAt:new Date().toISOString()};
  assert.equal(actual.sha256,expected.sha256,'The public native HTML must exactly match the rendered artifact under review');
  assert.equal(actual.bytes,expected.bytes);
  return actual;
}

async function liveAssets() {
  const root=new URL(baseURL);
  const paths=new Set(['native/build-manifest.json','stack-sources.json','runtime-assets.json','ctm-isolation.js','ctm-isolation-worker.js',
    'native/backend-worker.js','native/engine.js','native/input.js','native/stack-parser.js','native/input-rules.json','native/input-provenance.json',
    'native/feedback.js','native/feedback-messages.json','native/feedback-provenance.json','native/python-bridge.js','native/python_bridge.py',
    'runtime/maxima-session.js','runtime/maxima-child.js','jsxgraph/host.js','jsxgraph/frame.js','backend/worker.js','backend/native_adapter.py']);
  const scripts=await page.locator('script[src]').evaluateAll(items=>items.map(item=>item.getAttribute('src')));
  const external=[];
  for(const source of scripts) {
    const url=new URL(source,liveURL);
    if(url.origin!==root.origin || !url.pathname.startsWith(root.pathname)) {external.push(url.href);continue;}
    paths.add(decodeURIComponent(url.pathname.slice(root.pathname.length)));
  }
  const assets=[];
  for(const path of [...paths].sort()) {
    const absolute=resolve(site,path),within=relative(site,absolute);
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within),'Public script must resolve within the tested site artifact');
    const bytes=await readFile(absolute);
    assets.push({path,url:new URL(path,root).href,bytes:bytes.length,sha256:hash(bytes)});
  }
  return {assets,externalScripts:external,scope:'All emitted same-site HTML scripts, native build/runtime manifests, and mutable native/runtime/bridge/backend adapters; upstream hash-pinned Wasm libraries excluded'};
}

async function verifyLiveAssets(inventory) {
  const checked=[];
  // Independent read-only asset checks share no worker or assessment state.
  for(let offset=0;offset<inventory.length;offset+=6) {
    const results=await Promise.allSettled(inventory.slice(offset,offset+6).map(async expected=>{
      const response=await page.request.get(expected.url,{headers:{'Cache-Control':'no-cache'},timeout:90000});
      assert.equal(response.status(),200,'Missing exact-build public asset '+expected.path);
      const bytes=await response.body(),sha256=hash(bytes);
      assert.equal(sha256,expected.sha256,'Public asset does not match this exact build: '+expected.path);
      assert.equal(bytes.length,expected.bytes);
      return {path:expected.path,bytes:bytes.length,sha256};
    }));
    for(const result of results) {if(result.status==='rejected')throw result.reason;checked.push(result.value);}
  }
  return {checkedAt:new Date().toISOString(),assets:checked};
}

try {
  assert.deepEqual(await readFile(join(site,'_headers')),await readFile(join(repository,'comparison/_headers')),'Rendered host policy must equal its canonical producer source');
  const manifestBytes=await readFile(join(site,'native/build-manifest.json'));
  const manifest=JSON.parse(manifestBytes);
  const inventory=manifest.questions || manifest.cards;
  assert.ok(Array.isArray(inventory) && inventory.length>=8,'Native build manifest must inventory every required question');
  const expectedTemplates=inventory.reduce((count,entry)=>count+entry.question.native.boards.length,0);
  assert.equal(manifest.boardTemplates?.length,expectedTemplates,'Final card manifest must retain completed board template provenance');
  assert.equal(new Set(manifest.boardTemplates.map(row=>row.path)).size,expectedTemplates,'One reusable template per question/board');
  const sharedAssets=new Map();
  for(const template of manifest.boardTemplates){
    const bytes=await readFile(join(site,template.path));
    assert.equal(bytes.length,template.bytes);assert.equal(hash(bytes),template.sha256);
    assert.match(template.originalSha256,/^[a-f0-9]{64}$/);
    for(const asset of template.assets.filter(asset=>asset.sha256))sharedAssets.set(asset.path,asset);
  }
  for(const asset of sharedAssets.values()){
    const bytes=await readFile(join(site,asset.path));
    assert.equal(bytes.length,asset.bytes);assert.equal(hash(bytes),asset.sha256);
  }
  assert.ok(sharedAssets.size>0,'Reusable templates retain exact shared vendor resource evidence');
  assert.match(manifest.boardMathjax?.provenance.assessmentRevision,/^[a-f0-9]{40}$/,'Final card manifest retains canonical asset producer provenance');
  const preloader=await readFile(join(site,manifest.boardMathjax.preloader));
  assert.equal(hash(preloader),manifest.boardMathjax.provenance.preloaderSha256);
  report.manifest={sha256:hash(manifestBytes),bytes:manifestBytes.length,...manifest};
  const htmlBytes=await readFile(join(site,'maxima/native.html'));
  report.pageArtifact={path:'maxima/native.html',bytes:htmlBytes.length,sha256:hash(htmlBytes)};
  report.programs.push(...(manifest.programs||[]));
  const runtimeBytes=await readFile(join(site,'stack-sources.json'));
  const runtime=JSON.parse(runtimeBytes);
  report.runtime={stackRevision:runtime.stackRevision,stackLibraryVersion:runtime.stackLibraryVersion,manifestSha256:hash(runtimeBytes),
    assets:runtime.runtimeAssets,preload:runtime.preload};
  if(!liveURL)app=await serveDemo({root:site});
  baseURL=liveURL ? new URL('../',liveURL).href : app.baseURL;
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||undefined});
  report.browserVersion=browser.version();
  page=await browser.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror',error=>report.errors.push(String(error)));
  page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
  page.on('requestfailed',request=>report.network.push({url:request.url(),failed:request.failure()?.errorText}));
  page.on('requestfinished',request=>networkTasks.push((async()=>{
    const response=await request.response();if(!response)return;
    report.network.push({url:request.url(),method:request.method(),status:response.status(),resourceType:request.resourceType(),...await request.sizes()});
  })()));
  await page.addInitScript(observeNativeWorkers);
  if(liveURL)report.livePage={before:await verifyLivePage(report.pageArtifact)};
  await openPage(liveURL?.href || new URL('maxima/native.html',baseURL).href);
  report.pageURL=page.url();
  assert.equal(await page.locator('section.stack-sympy').count(),inventory.length);
  const seenIds=new Set();
  const questions=[];
  for(const entry of inventory) {
    const id=entry.id || entry.identifier;
    assert.equal(typeof id,'string');assert.equal(seenIds.has(id),false,'Card IDs must be unique');seenIds.add(id);
    const card=page.locator(cardSelector(id));assert.equal(await card.count(),1,id);
    const source=await card.locator('script.stack-sympy-data').textContent();
    const payload=JSON.parse(source);assert.equal(payload.id,id);
    assert.ok(payload.variants.length>0);
    assert.ok(entry.payload?.question && Array.isArray(entry.payload.variants),id+': the tested build must retain its exact question and prepared variants');
    assert.deepEqual(payload.question,entry.payload.question,id+': the loaded question must exactly match this build artifact');
    assert.deepEqual(payload.variants,entry.payload.variants,id+': every loaded prepared variant must exactly match this build artifact');
    if(entry.graphical?.variantPoints) {
      const points=entry.graphical.variantPoints;
      assert.equal(points.length,payload.variants.length);
      assert.ok(points.every(point=>point.coordinates.length===2 && point.coordinates.every(Number.isFinite)));
      assert.ok(new Set(points.map(point=>JSON.stringify(point.coordinates))).size>1,'Seeded graphical examples must provide genuinely distinct prepared points');
    }
    const payloadIdentity={questionSha256:hash(canonical(payload.question)),variantsSha256:hash(canonical(payload.variants))};
    const python=payload.question.prts.some(prt=>prt.nodes.some(node=>node.test==='PythonChecker'));
    questions.push({entry,id,card,payload,python,payloadSha256:hash(source),payloadIdentity});
  }
  report.pagePayloads=questions.map(({id,payloadSha256,payloadIdentity})=>({id,payloadSha256,...payloadIdentity,artifactMatched:true}));
  if(liveURL) {
    report.publicAssets=await liveAssets();
    report.publicAssets.before=await verifyLiveAssets(report.publicAssets.assets);
  }
  const graphical=questions.filter(row=>row.entry.graphical || row.entry.graph || /native-(?:binding|json|python-board|mixed-board)$/.test(row.id));
  // Exercise unmodified native boards before unrelated mathematical fixtures.
  // Optional Python boards use the same helper after Python-dependent tests.
  for(const item of graphical.filter(row=>!row.python)) {
    await exerciseGraphic(item);
    await assertNoPython('native graphical question '+item.id);
    await writeFile(join(output,'browser.json'),JSON.stringify(report,null,2)+'\n');
  }
  // Establish the native-only promise before any Python-dependent question is used.
  const ordered=[...questions.filter(row=>!row.python),...questions.filter(row=>row.python)];
  const positives=new Map();
  let pythonValidatedWithoutLoad=false;
  for(const {entry,id,card,payload,python,payloadSha256} of ordered) {
    if(python && !report.nativeOnlyNetwork)await assertNoPython('all standard native cards');
    for(let variant=0;variant<payload.variants.length;variant++) {
      console.log(JSON.stringify({question:id,variant,seed:payload.variants[variant].seed,python}));
      await card.locator('.stack-variant').selectOption(String(variant));
      await awaitBoards(card);
      const graphicalVariant=await assertGraphicalVariant({entry,card,payload},variant);
      const initial=await state(card);
      if(python && !pythonValidatedWithoutLoad) {
        const answers=payload.variants[variant].qtests[0]?.answers;
        assert.ok(answers,'A Python example needs a prepared model input');
        await fillAnswers(card,answers);
        const validation=await action(card,'validate');
        assert.equal(validation.call.response.result.status,'valid');
        await assertNoPython('validation of the first PythonChecker question');
        report.optionalPythonValidation={id,validation};pythonValidatedWithoutLoad=true;
        await card.locator('.stack-reset').click();
      }
      const tested=payload.question.qtests.length ? await action(card,'tests') : null;
      const result=tested?.call.response.result || {results:[]};
      if(tested) {
        assert.equal(result.passed,true,id+': every authored test must pass');
        assert.equal(result.results.length,payload.question.qtests.length,id+': every authored row must execute');
        for(const actual of result.results)assert.equal(actual.passed,true);
      }
      const row={id,variant,seed:payload.variants[variant].seed,python,payloadSha256,graphicalVariant,authoredTests:tested,probes:[]};
      const positive=result.results.find(value=>value.actual?.status==='graded' && value.actual.score===1);
      if(positive) {
        positives.set(id,{answers:positive.inputs,variant});
        const sibling=questions.find(value=>value.id!==id);
        const untouched=await state(sibling.card);
        await fillAnswers(card,positive.inputs);
        assert.deepEqual(await state(sibling.card),untouched,'Editing one question must not change a sibling');
        row.validation=await action(card,'validate');
        assert.equal(row.validation.call.response.result.status,'valid');
        assert.equal(await card.locator('.stack-check').isEnabled(),true);
        row.grade=await action(card,'grade');
        assert.equal(row.grade.call.response.result.status,'graded');
        assert.equal(row.grade.call.response.result.score,1,id+': real UI must award full credit');
        row.routing=assertRouteOrder(payload.question,row.grade.call.response.result,row.grade.events);
        row.repeat=await action(card,'grade');
        assert.deepEqual(row.repeat.call.response.result,row.grade.call.response.result,'Repeated grading must preserve all results');
        assert.deepEqual(await state(sibling.card),untouched,'Native grading must not alter another question');
      } else assert.ok(/native-(?:binding|json)$/.test(id),id+': mathematical examples need an authored full-credit case');
      const probes=[...(entry.probes || [])];
      if(id==='native-rational' && positive) {
        const name=payload.question.inputs[0].name;
        probes.push({name:'incomplete fraction is invalid',answers:{...positive.inputs,[name]:'1/'},status:'invalid'});
        probes.push({name:'division by zero is invalid',answers:{...positive.inputs,[name]:'1/0'},status:'invalid'});
      }
      if(id==='native-numerical') probes.push({name:'missing written trailing zero',
        answers:{perimeter:'24',area:'17.5',reported:'17.5'},status:'graded',score:0.7});
      for(const probe of probes) {
        if(probe.seed!==undefined && probe.seed!==row.seed || probe.variant!==undefined && probe.variant!==variant)continue;
        // The unchanged STACK point binding passes three numeric values to
        // JSXGraph as homogeneous [w,x,y] coordinates. Its serializer writes
        // the resulting ordinary pair back into the input before collection.
        // Test that actual UI contract separately from the raw checker input.
        const homogeneousCoordinateProbe=['native-python-board','native-mixed-board'].includes(id) &&
          probe.name==='wrong-length coordinate list [2,2,2]' && probe.answers.ans==='[2,2,2]';
        const filledAnswers=await fillAnswers(card,probe.answers);
        const submittedAnswers=homogeneousCoordinateProbe ? {ans:'[1,1]'} : filledAnswers;
        const uiScore=homogeneousCoordinateProbe ? (id==='native-python-board' ? 1 : 0.25) : probe.score;
        const observed={name:probe.name,expected:probe,validation:await action(card,'validate')};
        assert.deepEqual(observed.validation.call.answers,submittedAnswers,
          id+': validation must assess the exact declared submitted answer');
        if(homogeneousCoordinateProbe)observed.uiCanonicalization={
          kind:'unchanged STACK/JSXGraph homogeneous point coordinates',typed:probe.answers,
          submitted:observed.validation.call.answers,expectedScore:uiScore};
        const validation=observed.validation.call.response.result;
        assert.equal(validation.status,probe.status==='invalid'?'invalid':'valid',id+': '+probe.name);
        if(probe.status==='invalid') {
          assert.equal(await card.locator('.stack-check').isDisabled(),true);
          if(probe.name==='division by zero is invalid') {
            const native=observed.validation.events.filter(row=>row.data.event==='native-evaluate' && row.data.operation==='validate');
            assert.ok(native.length>0,'Division by zero must exercise the actual native CAS error path after structural admission');
            assert.ok(native.some(row=>Object.values(row.data.result).some(input=>input.valid===false)),'A native program must return the invalid domain result');
            assert.equal(observed.validation.call.response.backend.restarts,0,'An ordinary mathematical domain error must not restart the worker');
            observed.nativeDomainError={actualPrograms:native.length,restarts:0};
          }
        } else {
          observed.grade=await action(card,'grade');
          const graded=observed.grade.call.response.result;
          assert.deepEqual(observed.grade.call.answers,submittedAnswers,
            id+': grading must assess the exact validated submitted answer');
          assert.equal(graded.status,probe.status || 'graded');
          assert.equal(observed.grade.call.response.backend.restarts,0,'A bounded wrong answer must grade without restarting the native worker');
          if(uiScore!==undefined)assert.equal(graded.score,uiScore,id+': '+probe.name+' (actual UI submission)');
          if(homogeneousCoordinateProbe) {
            observed.rawNative=await directNative({type:'grade',question:payload.question,
              variant:payload.variants[variant],answers:probe.answers});
            assert.deepEqual(observed.rawNative.request.answers,probe.answers,'The raw regression must retain all three entries');
            assert.equal(observed.rawNative.response.result.status,probe.status);
            assert.equal(observed.rawNative.response.result.score,probe.score,
              id+': the raw three-entry list must still receive zero from the actual native/Python tree');
            assert.equal(observed.rawNative.response.backend.restarts,0,'Raw wrong-length grading must not restart the worker');
            observed.rawNative.routing=assertRouteOrder(payload.question,observed.rawNative.response.result,observed.rawNative.events);
            if(probe.sequence)assert.deepEqual(observed.rawNative.routing.actual,probe.sequence);
          }
          if(probe.assessment) {
            const assessments=('rows' in probe.assessment || 'columns' in probe.assessment)
              ? {[payload.question.inputs[0].name]:probe.assessment} : probe.assessment;
            for(const [name,assessment] of Object.entries(assessments))assert.deepEqual(graded.inputs[name].assessment,assessment);
          }
          observed.routing=assertRouteOrder(payload.question,graded,observed.grade.events);
          if(probe.sequence)assert.deepEqual(observed.routing.actual,probe.sequence);
          if(probe.feedbackContains) {
            const inline=card.locator('.stack-feedback[data-name="prt1"]');
            const feedback=await inline.count() ? inline.first() : card.locator('.stack-result .stack-prt-feedback').first();
            await feedback.waitFor({state:'visible'});const visible=await feedback.textContent();
            for(const fragment of probe.feedbackContains) {
              assert.ok(graded.prts.prt1.feedback.includes(fragment),'Authored native feedback must retain its local value before and after Python');
              assert.ok(visible.includes(fragment),'Each native/Python feedback branch must display its preserved local value');
            }
            const pause=observed.grade.events.find(row=>row.data.event==='native-evaluate' && row.data.operation==='prt' && row.data.result.kind==='python');
            assert.ok(pause,'The actual native tree must pause for the Python continuation');
            assert.equal(pause.data.result.environment.target,'2','The feedback local must be captured by the real native continuation');
            observed.feedbackContinuation={target:pause.data.result.environment.target,expected:probe.feedbackContains,visible};
          }
          if(id==='native-numerical' && probe.name==='missing written trailing zero') {
            observed.nativeFeedback=assertReadableNativeFeedback(graded,observed.grade.events,
              {key:'ATNumDecPlaces_Wrong_DPs',message:/wrong number of decimal places/i});
            const visible=card.locator('.stack-feedback[data-name="prt3"] .stack-native-feedback').first();
            await visible.waitFor({state:'visible'});
            observed.nativeFeedback.visible=await visible.textContent();
            assert.match(observed.nativeFeedback.visible,/wrong number of decimal places/i,'Readable native precision feedback must appear in the actual question UI');
            assert.doesNotMatch(observed.nativeFeedback.visible,/stack_trans\(|!NEWLINE!|!quot!/);
          }
        }
        row.probes.push(observed);
      }
      if(positive && probes.some(probe=>probe.status==='invalid')) {
        await fillAnswers(card,positive.inputs);
        row.recovery={validation:await action(card,'validate')};
        assert.equal(row.recovery.validation.call.response.result.status,'valid','A mathematical input error must not poison the native worker');
        row.recovery.grade=await action(card,'grade');
        assert.equal(row.recovery.grade.call.response.result.score,1,'The same worker must grade a valid answer after input errors');
      }
      const sibling=questions.find(value=>value.id!==id), siblingState=await state(sibling.card);
      await card.locator('.stack-reset').click();
      assert.equal(await card.locator('.stack-check').isDisabled(),true);
      assert.equal(await card.locator('.stack-result').textContent(),'');
      assert.deepEqual((await state(card)).fields,initial.fields,'Reset must restore the current variant input state');
      assert.deepEqual(await state(sibling.card),siblingState,'Reset must leave the sibling unchanged');
      row.reset=await state(card);report.rows.push(row);
      if(!python)await assertNoPython(id+' variant '+(variant+1));
      await writeFile(join(output,'browser.json'),JSON.stringify(report,null,2)+'\n');
    }
  }
  for(const item of graphical.filter(row=>row.python))await exerciseGraphic(item);
  // Queue validation and reset in the same browser event-loop turn. Its real
  // later native reply must not resurrect the previous response generation.
  const stale=questions.find(row=>!row.python && positives.has(row.id));assert.ok(stale);
  const positive=positives.get(stale.id);
  await stale.card.locator('.stack-variant').selectOption(String(positive.variant));await fillAnswers(stale.card,positive.answers);
  const beforeCalls=await page.evaluate(()=>window.__nativeHarness.calls.length);
  await stale.card.evaluate(element=>{
    element.querySelector('.stack-validate').click();
    element.querySelector('.stack-reset').click();
  });
  await page.waitForFunction(before=>window.__nativeHarness.calls.slice(before).some(row=>row.type==='validate' && row.response),beforeCalls,{timeout:120000});
  assert.equal(await stale.card.locator('.stack-result').textContent(),'');assert.equal(await stale.card.locator('.stack-check').isDisabled(),true);
  report.staleReply={id:stale.id,passed:true,state:await state(stale.card)};
  await formRegressions(questions);
  report.observation=await page.evaluate(()=>window.__nativeHarness);
  report.runtime.maximaVersion=report.observation.events.find(row=>row.data?.event==='runtime-maxima-ready')?.data.maximaVersion;
  assert.equal(typeof report.runtime.maximaVersion,'string','Record the actual Wasm Maxima version from its ready protocol');
  report.programs.push(...report.observation.events.filter(row=>row.data.event==='native-evaluate').map(row=>row.data));
  const operations=new Set(report.programs.map(row=>row.operation));
  for(const operation of ['prepare','validate','prt'])assert.ok(operations.has(operation),'Missing actual '+operation+' native program evidence');
  report.coverage={cards:questions.length,variants:report.rows.length,authoredRows:report.rows.reduce((n,row)=>n+(row.authoredTests?.call.response.result.results.length || 0),0),
    pythonCards:questions.filter(row=>row.python).length,graphics:report.graphics.length,programs:report.programs.length,
    boundaryRegressionFixtures:report.formRegressions.length,
    invalidProbes:report.rows.flatMap(row=>row.probes).filter(probe=>probe.expected.status==='invalid').length,
    nonFullCreditProbes:report.rows.flatMap(row=>row.probes).filter(probe=>typeof probe.expected.score==='number' && probe.expected.score<1).length};
  assert.ok(report.coverage.pythonCards>=2 && report.coverage.graphics>=3);
  assert.ok(report.coverage.invalidProbes>0 && report.coverage.nonFullCreditProbes>0,'Require independent invalid and wrong/partial-credit UI probes');
  await Promise.allSettled(networkTasks);
  assert.deepEqual(report.errors,[]);
  assert.deepEqual(report.consoleErrors.filter(text=>!safeConsole(text)),[]);
  assert.deepEqual(report.network.filter(row=>row.status>=400 || row.failed && !/ERR_ABORTED/.test(row.failed)),[]);
  if(app)assert.deepEqual(app.requests.filter(row=>row.status>=400),[]);
  if(liveURL) {
    report.livePage.after=await verifyLivePage(report.pageArtifact);
    report.publicAssets.after=await verifyLiveAssets(report.publicAssets.assets);
  }
  report.passed=true;
} catch(error) {
  report.failure={message:String(error),stack:error.stack};
  console.error(report.failure.message);
  if(page && !page.isClosed()) {
    report.observation=await page.evaluate(()=>window.__nativeHarness).catch(()=>null);
    if(report.runtime)report.runtime.maximaVersion=report.observation?.events?.find(row=>row.data?.event==='runtime-maxima-ready')?.data.maximaVersion;
    report.programs.push(...(report.observation?.events||[]).filter(row=>row.data?.event==='native-evaluate').map(row=>row.data));
    await page.screenshot({path:join(output,'failure.png'),fullPage:false}).catch(()=>{});
  }
} finally {
  await Promise.allSettled(networkTasks);
  if(browser)await browser.close();
  if(app){report.serverRequests=app.requests;await app.close();}
  await writeFile(join(output,'browser.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({passed:report.passed,coverage:report.coverage,failure:report.failure}));
if(!report.passed)process.exitCode=1;
