// SPDX-License-Identifier: AGPL-3.0-or-later
// Exercise the real shared CTM UI and record the native programs it executes.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
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
await mkdir(output, {recursive:true});

// Only turn on diagnostics in the actual native worker. All assessment
// requests/responses and every Worker execution remain real and unmodified.
function observeNativeWorkers() {
  const RealWorker = window.Worker;
  const state = window.__nativeHarness = {workers:[], calls:[], events:[]};
  window.Worker = class extends RealWorker {
    constructor(url, options) {
      super(url, options);
      const descriptor = {id:state.workers.length, url:String(url), createdAt:performance.now()};
      state.workers.push(descriptor);
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

const pythonAsset = url => /\/(?:pyodide(?:[./-]|$)|python_stdlib\.zip)|\/(?:sympy|mpmath|micropip)[^/]*\.whl(?:[?#]|$)|\.whl(?:[?#]|$)/i.test(url);
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

async function assertNoPython(label) {
  await Promise.allSettled(networkTasks);
  const assets=report.network.filter(row=>pythonAsset(row.url));
  assert.deepEqual(assets,[],label+': native operations must load no Python Wasm, standard library or checker/SymPy wheels');
  const replies=await page.evaluate(()=>window.__nativeHarness.calls.filter(row=>row.response?.backend).map(row=>row.response.backend));
  assert.ok(replies.every(backend=>backend.pythonLoaded!==true),label+': worker must report Python uninitialized');
  report.nativeOnlyNetwork={through:label,requests:report.network.length,pythonAssets:assets};
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

try {
  const manifestBytes=await readFile(join(site,'native/build-manifest.json'));
  const manifest=JSON.parse(manifestBytes);
  const inventory=manifest.questions || manifest.cards;
  assert.ok(Array.isArray(inventory) && inventory.length>=8,'Native build manifest must inventory every required question');
  report.manifest={sha256:hash(manifestBytes),bytes:manifestBytes.length,...manifest};
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
    const python=payload.question.prts.some(prt=>prt.nodes.some(node=>node.test==='PythonChecker'));
    questions.push({entry,id,card,payload,python,payloadSha256:hash(source)});
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
      const row={id,variant,seed:payload.variants[variant].seed,python,payloadSha256,authoredTests:tested,probes:[]};
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
        probes.push({name:'admitted native mathematical error is invalid',answers:{...positive.inputs,[name]:'gcd([1],1)'},status:'invalid'});
      }
      if(id==='native-numerical') probes.push({name:'missing written trailing zero',
        answers:{perimeter:'24',area:'17.5',reported:'17.5'},status:'graded',score:0.7});
      for(const probe of probes) {
        if(probe.seed!==undefined && probe.seed!==row.seed || probe.variant!==undefined && probe.variant!==variant)continue;
        await fillAnswers(card,probe.answers);
        const observed={name:probe.name,expected:probe,validation:await action(card,'validate')};
        const validation=observed.validation.call.response.result;
        assert.equal(validation.status,probe.status==='invalid'?'invalid':'valid',id+': '+probe.name);
        if(probe.status==='invalid')assert.equal(await card.locator('.stack-check').isDisabled(),true);
        else {
          observed.grade=await action(card,'grade');
          const graded=observed.grade.call.response.result;
          assert.equal(graded.status,probe.status || 'graded');
          if(probe.score!==undefined)assert.equal(graded.score,probe.score,id+': '+probe.name);
          if(probe.assessment) {
            const assessments=('rows' in probe.assessment || 'columns' in probe.assessment)
              ? {[payload.question.inputs[0].name]:probe.assessment} : probe.assessment;
            for(const [name,assessment] of Object.entries(assessments))assert.deepEqual(graded.inputs[name].assessment,assessment);
          }
          observed.routing=assertRouteOrder(payload.question,graded,observed.grade.events);
          if(probe.sequence)assert.deepEqual(observed.routing.actual,probe.sequence);
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
  // Graphical input evidence uses real pointer events and the ordinary
  // Validate/Check buttons; hidden input assignment is not a substitute.
  for(const item of questions.filter(row=>row.entry.graphical || row.entry.graph || /native-(?:binding|json|python-board|mixed-board)$/.test(row.id))) {
    const {id,entry,card,payload}=item;
    await card.locator('.stack-variant').selectOption('0');
    await card.locator('.stack-reset').click();await awaitBoards(card);
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
      assert.match(await card.locator('.stack-result').textContent(),/points|color/i,'Native JSON feedback must be displayed');
    }
    const path=id+'.png';await card.screenshot({path:join(output,path),animations:'disabled'});report.screenshots.push({id,path});
    await card.locator('.stack-reset').click();await awaitBoards(card);
    assert.deepEqual((await state(card)).fields,before.fields,'Graph Reset must restore the associated input state');
    report.graphics.push({id,kind:graphic.kind,moved,twoWay,validation:validated,grade:graded,reset:await state(card)});
  }
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
  report.observation=await page.evaluate(()=>window.__nativeHarness);
  report.programs.push(...report.observation.events.filter(row=>row.data.event==='native-evaluate').map(row=>row.data));
  const operations=new Set(report.programs.map(row=>row.operation));
  for(const operation of ['prepare','validate','prt'])assert.ok(operations.has(operation),'Missing actual '+operation+' native program evidence');
  report.coverage={cards:questions.length,variants:report.rows.length,authoredRows:report.rows.reduce((n,row)=>n+(row.authoredTests?.call.response.result.results.length || 0),0),
    pythonCards:questions.filter(row=>row.python).length,graphics:report.graphics.length,programs:report.programs.length,
    invalidProbes:report.rows.flatMap(row=>row.probes).filter(probe=>probe.expected.status==='invalid').length,
    nonFullCreditProbes:report.rows.flatMap(row=>row.probes).filter(probe=>typeof probe.expected.score==='number' && probe.expected.score<1).length};
  assert.ok(report.coverage.pythonCards>=2 && report.coverage.graphics>=3);
  assert.ok(report.coverage.invalidProbes>0 && report.coverage.nonFullCreditProbes>0,'Require independent invalid and wrong/partial-credit UI probes');
  await Promise.allSettled(networkTasks);
  assert.deepEqual(report.errors,[]);
  assert.deepEqual(report.consoleErrors.filter(text=>!safeConsole(text)),[]);
  assert.deepEqual(report.network.filter(row=>row.status>=400 || row.failed && !/ERR_ABORTED/.test(row.failed)),[]);
  if(app)assert.deepEqual(app.requests.filter(row=>row.status>=400),[]);
  report.passed=true;
} catch(error) {
  report.failure={message:String(error),stack:error.stack};
  console.error(report.failure.message);
  if(page && !page.isClosed()) {
    report.observation=await page.evaluate(()=>window.__nativeHarness).catch(()=>null);
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
