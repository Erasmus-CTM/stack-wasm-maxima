// SPDX-License-Identifier: AGPL-3.0-or-later
// Protocol and DOM-boundary tests. Real JSXGraph dragging is tested in CI.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';

class FakeEvent {
  constructor(type, options = {}) { this.type = type; this.bubbles = Boolean(options.bubbles); }
  preventDefault() { this.defaultPrevented = true; }
  stopImmediatePropagation() { this.stopped = true; }
}
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = [];
    this.attributes = new Map(); this.dataset = {}; this.listeners = new Map(); this.value = '';
    this.className = ''; this.style = {}; this.srcdocWrites = 0; this.srcWrites = 0; this.innerHTML = '';
  }
  get isConnected() { return this.ownerDocument.contains(this); }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === 'id') this.id = String(value);
    if (key === 'class') this.className = String(value);
    if (key === 'srcdoc') this.srcdocWrites++;
    if (key === 'src') this.srcWrites++;
  }
  getAttribute(key) { return key === 'id' ? this.id || null : this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  after(child) {
    child.parentNode = this.parentNode;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this) + 1, 0, child);
  }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  contains(child) { return child === this || this.children.some(item => item.contains(child)); }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    if (selector === '[id]') return Boolean(this.id);
    if (selector === 'iframe[data-stack-jsxgraph]') return this.tagName === 'IFRAME' && this.hasAttribute('data-stack-jsxgraph');
    const match = /^(\w+)?(?:\.([\w-]+))?(\[data-name\])?$/.exec(selector);
    if (!match) return false;
    return (!match[1] || this.tagName === match[1].toUpperCase()) &&
      (!match[2] || this.className.split(/\s+/).includes(match[2])) && (!match[3] || typeof this.dataset.name === 'string');
  }
  closest(selector) { for (let item = this; item; item = item.parentNode) if (item.matches?.(selector)) return item; return null; }
  querySelectorAll(selector) { return this.children.flatMap(item => [...(item.matches(selector) ? [item] : []), ...item.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, fn, capture = false) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({fn, capture:Boolean(capture)});
  }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(row => row.fn !== fn)); }
  dispatchEvent(event) {
    event.target = this;
    const ancestors = []; for (let item = this.parentNode; item; item = item.parentNode) ancestors.push(item);
    const invoke = (target, capture) => {
      for (const row of target.listeners.get(event.type) || []) {
        if (event.stopped) return;
        if (row.capture === capture) row.fn(event);
      }
    };
    for (const target of [...ancestors].reverse()) invoke(target, true);
    invoke(this, true); invoke(this, false);
    if (event.bubbles) for (const target of ancestors) invoke(target, false);
    return !event.defaultPrevented;
  }
  click() { this.dispatchEvent(new FakeEvent('click', {bubbles:true})); }
}
class Document extends Element {
  constructor() {
    super('document'); this.ownerDocument = this; this.documentElement = this;
    this.body = this.appendChild(new Element('body', this));
  }
  createElement(tag) { return new Element(tag, this); }
}
class Window {
  constructor(document) { this.document = document; this.listeners = new Map(); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event) { for (const fn of this.listeners.get(type) || []) fn(event); }
}
class Observer { observe() {} disconnect() {} }
const hostDocument = new Document(), hostWindow = new Window(hostDocument);
hostWindow.MutationObserver = Observer; hostWindow.ResizeObserver = Observer;
const frameDocument = new Document(), frameWindow = new Window(frameDocument);
const sentToHost = [], sentToFrame = [];
const hostProxy = {postMessage(data) { sentToHost.push(data); queueMicrotask(() => hostWindow.emit('message', {data, source:frameProxy})); }};
const frameProxy = {postMessage(data) { sentToFrame.push(data); queueMicrotask(() => frameWindow.emit('message', {data, source:hostProxy})); }};
frameWindow.parent = hostProxy;
let responseProvider;
frameWindow.JXG = {QuartoAssessment:{register(spec) { responseProvider = spec.response; }}};
frameWindow.addEventListener('message', async event => {
  const data = event.data;
  if (event.source === hostProxy && data.protocol === 'jsxgraph-quarto-assessment' && data.type === 'request') {
    try { hostProxy.postMessage({...data, type:'response', payload:await responseProvider()}); }
    catch(error) { hostProxy.postMessage({...data, type:'response', error:error.message}); }
  }
});
function run(source, window) {
  return vm.runInContext(source, vm.createContext({window, self:window, Event:FakeEvent,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, console, URL}));
}
const root = new URL('.', import.meta.url);
run(await readFile(new URL('host.js', root), 'utf8'), hostWindow);
run(await readFile(new URL('frame.js', root), 'utf8'), frameWindow);
function child(parent, tag, className, name) {
  const element = parent.ownerDocument.createElement(tag); element.className = className;
  if (name) element.dataset.name = name;
  return parent.appendChild(element);
}
const card = child(hostDocument.body, 'section', 'stack-sympy'); card.dataset.stackId = 'native-test';
const input = child(card, 'input', 'stack-answer', 'ans1'); input.value = '[0,0]';
input.dataset.stackInputType = 'algebraic'; input.dataset.stackInputDecimalSeparator = '.';
const other = child(card, 'input', 'stack-answer', 'private'); other.value = 'do not change';
const validation = child(card, 'span', 'stack-validation', 'ans1');
const result = child(card, 'div', 'stack-result');
const validateButton = child(card, 'button', 'stack-validate');
const resetButton = child(card, 'button', 'stack-reset');
const feedback = child(card, 'span', ''); feedback.id = 'feedback-data'; feedback.innerHTML = '{"ok":true}';
const otherCard = child(hostDocument.body, 'section', 'stack-sympy');
const external = child(otherCard, 'span', ''); external.id = 'outside'; external.innerHTML = 'private';
const frame = child(card, 'iframe', ''); frame.contentWindow = frameProxy;
frame.setAttribute('src', 'data:text/html;base64,PGh0bWw+b3JpZ2luYWwgYm9hcmQ8L2h0bWw+');
const handle = hostWindow.CTMStackJSXGraph.attachIframe(frame, {assessmentId:'native-board', inputs:['ans1'],boardValues:{t0:-2}});
const api = frameWindow.CTMStackJSXGraphFrame.create({assessmentId:'native-board', inputNames:['ans1'],tokenNames:['t0']});
assert.throws(()=>api.board_values(), /not initialized/);
const settle = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve)); };
try {
  const id = await api.request_access_to_input('ans1', true, true);
  assert.equal(id, 'ans1');
  const mirror = frameDocument.querySelectorAll('input')[0];
  assert.equal(mirror.value, '[0,0]', 'Initial question values reach the mirror before registration resolves');
  assert.equal(api.get_input_metadata('ans1').InputType, 'algebraic');
  await api.mark_ready(); await settle();
  assert.equal(frame.getAttribute('data-stack-jsxgraph-ready'), 'true');
  assert.equal(api.board_values().t0,-2,'The scoped init carries prepared numeric data');
  assert.equal(Object.isFrozen(api.board_values()),true);
  const initialized=sentToFrame.find(message=>message.type==='init');
  for(const boardValues of [{t0:99},{t0:NaN},{t0:-2,extra:3},'code']) {
    frameWindow.emit('message',{source:hostProxy,data:{...initialized,boardValues}});
    assert.equal(api.board_values().t0,-2,'Late/malformed data cannot change initialized geometry');
  }
  frameWindow.emit('message',{source:{},data:{...initialized,boardValues:{t0:99}}});
  assert.equal(api.board_values().t0,-2,'The data channel requires the exact parent WindowProxy');
  await assert.rejects(api.request_access_to_input('private'), /not bound/);

  mirror.value = '[1,2]'; mirror.dispatchEvent(new FakeEvent('change'));
  mirror.value = '[3,4]'; mirror.dispatchEvent(new FakeEvent('change'));
  await settle();
  assert.equal(input.value, '[3,4]', 'Rapid changes drain in order without dropping the latest position');
  assert.equal((await responseProvider()).inputs.ans1, '[3,4]');
  assert.equal(other.value, 'do not change');
  const oldWrite = sentToHost.findLast(message => message.operation === 'set-input');

  const before = sentToHost.filter(message => message.operation === 'set-input').length;
  input.value = '[5,6]'; input.dispatchEvent(new FakeEvent('input', {bubbles:true}));
  await settle();
  assert.equal(mirror.value, '[5,6]', 'Parent edits update the existing board mirror');
  assert.equal(sentToHost.filter(message => message.operation === 'set-input').length, before, 'Incoming state does not echo into another write');
  assert.equal(await api.get_content('feedback-data'), '{"ok":true}');
  assert.equal(await api.get_content('outside'), null, 'Feedback lookup never escapes the containing question');

  const callbacks = [];
  api.register_validation_state_listener('ans1', (...args) => callbacks.push(args), true);
  await settle();
  validation.dataset.state = 'valid'; result.dataset.state = 'valid'; handle.sync();
  await settle();
  assert.equal(JSON.stringify(callbacks.at(-1)), JSON.stringify([true, true, 'ans1']));

  let validations = 0, observedAnswer;
  validateButton.addEventListener('click', () => { validations++; observedAnswer = input.value; result.dataset.state = 'loading'; });
  mirror.value = '[7,8]'; mirror.dispatchEvent(new FakeEvent('change'));
  validateButton.click();
  await settle();
  assert.equal(validations, 1, 'The shared Validate handler runs once after collection');
  assert.equal(observedAnswer, '[7,8]', 'Validate reads the final graphical state after pending writes drain');

  const forged = {...oldWrite, requestId:'forged', value:'[999,999]'};
  hostWindow.emit('message', {data:forged, source:{}});
  await settle();
  assert.equal(input.value, '[7,8]', 'A different source window cannot write an input');
  hostProxy.postMessage({...oldWrite, requestId:'wrong-input', name:'private', value:'tampered'});
  await settle();
  assert.equal(other.value, 'do not change', 'The correct iframe cannot write an undeclared sibling input');

  input.setAttribute('readonly', '');
  mirror.value = '[9,10]'; mirror.dispatchEvent(new FakeEvent('change'));
  await settle();
  assert.equal(input.value, '[7,8]', 'Read-only host inputs cannot be edited by a board');
  await assert.rejects(responseProvider(), /read-only/, 'A failed graphical write cannot collect the previous answer');
  validateButton.click(); await settle();
  assert.equal(validations, 1, 'A rejected write prevents the shared Validate handler from grading stale input');
  input.removeAttribute('readonly');
  mirror.value = '[10,11]'; mirror.dispatchEvent(new FakeEvent('change')); await settle();
  assert.equal((await responseProvider()).inputs.ans1, '[10,11]', 'A successful new edit recovers collection');
  mirror.value = '[12,13]'; mirror.dispatchEvent(new FakeEvent('change'));
  await api.clear_input('ans1'); await settle();
  assert.equal(input.value, '', 'Clear is serialized after an in-flight graphical edit');
  const writes = sentToHost.filter(message => message.operation === 'set-input').length;
  mirror.value = 'x'.repeat(32769); mirror.dispatchEvent(new FakeEvent('change'));
  await settle();
  assert.equal(sentToHost.filter(message => message.operation === 'set-input').length, writes, 'Oversized data is rejected before transport');
  await assert.rejects(responseProvider(), /input limit/, 'An oversized edit cannot collect the previous answer');
  input.value = '[14,15]'; input.dispatchEvent(new FakeEvent('input', {bubbles:true})); await settle();
  assert.equal((await responseProvider()).inputs.ans1, '[14,15]', 'A newer explicit host edit recovers collection');

  resetButton.addEventListener('click', () => { input.value = ''; });
  const reloads = frame.srcWrites;
  resetButton.click();
  assert.equal(frame.getAttribute('data-stack-jsxgraph-ready'), 'false', 'Reset clears the parent readiness marker before navigation');
  await settle();
  assert.equal(frame.srcWrites, reloads + 1, 'Reset recreates the stock Quarto board from its original data URL');
  hostProxy.postMessage({...oldWrite, requestId:'late-after-reset', value:'[99,99]'});
  hostProxy.postMessage({protocol:'ctm-stack-jsxgraph', version:1, type:'hello', assessmentId:'native-board', instanceId:oldWrite.instanceId});
  hostProxy.postMessage({protocol:'ctm-stack-jsxgraph', version:1, type:'hello', assessmentId:'native-board', instanceId:'late-previously-unseen-document'});
  await settle();
  assert.equal(input.value, '', 'Late writes and retired-frame handshakes cannot restore a pre-reset response');
  assert.equal(sentToFrame.some(message => message.type === 'init' && message.instanceId === 'late-previously-unseen-document'), false,
    'Reset blocks handshakes until the replacement iframe document has loaded');
  frame.dispatchEvent(new FakeEvent('load'));
  hostProxy.postMessage({protocol:'ctm-stack-jsxgraph', version:1, type:'hello', assessmentId:'native-board', instanceId:'new-document'});
  await settle();
  const fresh = sentToFrame.findLast(message => message.type === 'init' && message.instanceId === 'new-document');
  assert.ok(fresh, 'The new iframe document can connect through the same WindowProxy after reset');
  hostProxy.postMessage({protocol:'ctm-stack-jsxgraph', version:1, type:'request', operation:'set-input', assessmentId:'native-board',
    instanceId:'new-document', generation:fresh.generation, requestId:'fresh-write', name:'ans1', value:'[11,12]',
    inputRevision:fresh.state.inputs.ans1.revision});
  await settle();
  assert.equal(input.value, '[11,12]');
  hostProxy.postMessage({...oldWrite, requestId:'old-document-after-remount', value:'[99,99]'});
  await settle();
  assert.equal(input.value, '[11,12]', 'The retired document stays blocked after a replacement document connects');
  console.log('JSXGraph adapter: initial state, two-way edits, click collection, namespace, readonly, size and reset boundaries passed');
} finally { api.dispose(); handle.disconnect(); }

// Parent-fetch/template lifecycle: no opaque HTTP navigation and no stale
// asynchronous mount into a reset, replaced or disposed board.
hostDocument.baseURI='https://site.test/dept/course/maxima/native.html';
// Minimal inert DOM facade for lifecycle tests. Actual parser/speculative
// loading behavior is tested in all real browsers by the offline fixture.
hostWindow.DOMParser=class {
  parseFromString(html){
    let base;
    const replacements=[];
    const nodes=Array.from(html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>|<link\b[^>]*>/gi)).flatMap(match=>{
      const opening=match[0].slice(0,match[0].indexOf('>')+1);
      const attribute=/\b(src|href)="([^"]*)"/.exec(opening);if(!attribute)return [];
      const values=Object.fromEntries(Array.from(opening.matchAll(/\b([A-Za-z0-9:-]+)="([^"]*)"/g),row=>[row[1],row[2]]));
      let rendered=opening;replacements.push({before:opening,get after(){return rendered;}});
      return [{hasAttribute:name=>name in values,getAttribute:name=>values[name]??null,setAttribute(name,value){values[name]=value;rendered=rendered.replace(new RegExp('\\b'+name+'="[^"]*"'),name+'="'+value+'"');}}];
    });
    return {querySelector:()=>/<base\b/i.test(html)?{}:null,
      createElement:()=>({href:''}),head:{prepend:value=>{base=value.href;}},querySelectorAll:()=>nodes,
      documentElement:{get outerHTML(){let output=html.replace(/<!doctype[^>]*>/i,'');for(const {before,after}of replacements)output=output.replace(before,after);return output.replace(/<head>/i,'<head><base href="'+base+'">');}}};
  }
};
const pendingTemplates=new Map(),templateRequests=[];
hostWindow.fetch=url=>{
  templateRequests.push(url);
  return new Promise((resolve,reject)=>pendingTemplates.set(url,{resolve,reject}));
};
function templateFrame(path,values={t0:-1}){
  const card=child(hostDocument.body,'section','stack-sympy');
  child(card,'input','stack-answer','ans1');
  const reset=child(card,'button','stack-reset');
  const select=child(card,'select','stack-variant');
  const frame=child(card,'iframe','');frame.contentWindow={postMessage(){}};
  frame.setAttribute('src','about:blank');frame.setAttribute('data-stack-jsxgraph-template',path);
  const handle=hostWindow.CTMStackJSXGraph.attachIframe(frame,{assessmentId:'template',inputs:['ans1'],boardValues:values});
  return {card,reset,select,frame,handle};
}
const templateHTML='<!doctype html><html><head><meta charset="utf-8"><script src="./assets/vendor.js"></script><link href="./assets/vendor.css"><script>window.literal="./assets/do-not-rewrite.js";</script></head><body>unchanged board code</body></html>';
const completeTemplate=(name,ok=true,html=templateHTML)=>pendingTemplates.get('https://site.test/dept/course/native/boards/'+name).resolve({ok,status:ok?200:503,text:async()=>html});
const mounts=[];
try{
  const first=templateFrame('../native/boards/shared.html'),second=templateFrame('../native/boards/shared.html');mounts.push(first,second);
  await settle();assert.equal(templateRequests.length,1,'Concurrent instances share one parent template fetch');
  completeTemplate('shared.html');await settle();
  for(const item of [first,second]){
    assert.equal(item.frame.getAttribute('src'),'about:blank','An opaque HTTP navigation is never started');
    assert.equal(item.frame.srcdocWrites,1);
    assert.ok(item.frame.getAttribute('srcdoc').includes('<head><base href="https://site.test/dept/course/native/boards/shared.html">'));
    assert.ok(item.frame.getAttribute('srcdoc').includes('unchanged board code'));
    assert.ok(item.frame.getAttribute('srcdoc').includes('src="https://site.test/dept/course/native/boards/assets/vendor.js"'));
    assert.ok(item.frame.getAttribute('srcdoc').includes('href="https://site.test/dept/course/native/boards/assets/vendor.css"'));
    assert.ok(item.frame.getAttribute('srcdoc').includes('window.literal="./assets/do-not-rewrite.js";'),'Script text is preserved');
  }
  first.reset.click();await settle();
  assert.equal(first.frame.hasAttribute('srcdoc'),false,'Reset retires the old document before remount');
  assert.equal(first.frame.srcdocWrites,1,'No new document mounts before the blank load');
  first.reset.click();await settle();
  first.frame.dispatchEvent(new FakeEvent('load'));await settle();
  assert.equal(first.frame.srcdocWrites,2,'Only the latest reset mounts after shared blank navigation');
  first.frame.dispatchEvent(new FakeEvent('load'));await settle();
  assert.equal(first.frame.srcdocWrites,2,'The new document load cannot repeat its mount');
  second.reset.click();await settle();second.handle.disconnect();
  second.frame.dispatchEvent(new FakeEvent('load'));await settle();
  assert.equal(second.frame.srcdocWrites,1,'Disconnect while blank cannot remount a retired document');
  const resetting=templateFrame('../native/boards/reset-pending.html');mounts.push(resetting);await settle();
  const oldGeneration=resetting.handle.generation();resetting.reset.click();await settle();
  assert.notEqual(resetting.handle.generation(),oldGeneration);
  completeTemplate('reset-pending.html');await settle();
  assert.equal(resetting.frame.srcdocWrites,1,'Only the current reset mount ticket consumes the shared result');
  const replaced=templateFrame('../native/boards/variant-pending.html');mounts.push(replaced);await settle();
  replaced.select.dispatchEvent(new FakeEvent('change',{bubbles:true}));replaced.frame.remove();
  const replacement=templateFrame('../native/boards/variant-pending.html',{t0:-2});mounts.push(replacement);await settle();
  completeTemplate('variant-pending.html');await settle();
  assert.equal(replaced.frame.srcdocWrites,0,'A detached prior variant cannot consume pending fetch completion');
  assert.equal(replacement.frame.srcdocWrites,1);
  const disposed=templateFrame('../native/boards/disposed.html');mounts.push(disposed);await settle();
  disposed.handle.disconnect();completeTemplate('disposed.html');await settle();assert.equal(disposed.frame.srcdocWrites,0);
  const failed=templateFrame('../native/boards/retry.html');mounts.push(failed);await settle();
  completeTemplate('retry.html',false);await settle();
  assert.equal(failed.frame.srcdocWrites,0);assert.match(failed.card.querySelectorAll('.ctm-stack-jsxgraph-error')[0].textContent,/503/);
  failed.reset.click();await settle();completeTemplate('retry.html');await settle();
  assert.equal(failed.frame.srcdocWrites,1);assert.equal(failed.card.querySelectorAll('.ctm-stack-jsxgraph-error').length,0,'A successful retry clears its obsolete fetch error');
  const unsafe=templateFrame('../native/boards/unsafe-resource.html');mounts.push(unsafe);await settle();
  completeTemplate('unsafe-resource.html',true,templateHTML.replace('./assets/vendor.js','https://external.test/vendor.js'));await settle();
  assert.equal(unsafe.frame.srcdocWrites,0);assert.match(unsafe.card.querySelectorAll('.ctm-stack-jsxgraph-error')[0].textContent,/staged same-origin/);
  assert.throws(()=>templateFrame('https://external.test/private.html'),/Invalid native board template/);
  assert.throws(()=>templateFrame('../native/private.html'),/Invalid native board template/);
  hostWindow.crypto=webcrypto;hostWindow.btoa=value=>Buffer.from(value,'binary').toString('base64');
  const awaitResult=async predicate=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)assert.fail('Timed out awaiting actual integrity completion');await new Promise(resolve=>setImmediate(resolve));}};
  const core=Buffer.from('/* exact vendor bytes: © λ */\nwindow.vendor=true;');
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const coreHTML=bytes=>templateHTML.replace('<script src="./assets/vendor.js">','<script src="./assets/'+digest(bytes)+'.js" data-ctm-jsxgraph-sha256="'+digest(bytes)+'" data-ctm-jsxgraph-bytes="'+bytes.length+'">');
  const coreURL=bytes=>'https://site.test/dept/course/native/boards/assets/'+digest(bytes)+'.js';
  const completeCore=(expected,actual=expected,ok=true)=>pendingTemplates.get(coreURL(expected)).resolve({ok,status:ok?200:503,arrayBuffer:async()=>Uint8Array.from(actual).buffer});
  const coreA=templateFrame('../native/boards/core-a.html'),coreB=templateFrame('../native/boards/core-b.html');mounts.push(coreA,coreB);await settle();
  completeTemplate('core-a.html',true,coreHTML(core));completeTemplate('core-b.html',true,coreHTML(core));await settle();
  assert.equal(templateRequests.filter(url=>url===coreURL(core)).length,1,'Different question templates share one parent core fetch');
  completeCore(core);await awaitResult(()=>coreA.frame.srcdocWrites===1&&coreB.frame.srcdocWrites===1);
  for(const item of [coreA,coreB]){
    assert.equal(item.frame.srcdocWrites,1);
    const encoded=item.frame.getAttribute('srcdoc').match(/src="data:text\/javascript;base64,([^"]+)"/)[1];
    assert.deepEqual(Buffer.from(encoded,'base64'),core,'Mounted core bytes remain exact after integrity verification');
  }
  const style=Buffer.from('/* exact shared JSXGraph style */ .jxgbox { border: 0; }');
  const styleHTML=templateHTML.replace('<link href="./assets/vendor.css">',
    '<link href="./assets/'+digest(style)+'.css" data-ctm-board-style-sha256="'+digest(style)+'" data-ctm-board-style-bytes="'+style.length+'">');
  const styleURL='https://site.test/dept/course/native/boards/assets/'+digest(style)+'.css';
  const styleA=templateFrame('../native/boards/style-a.html'),styleB=templateFrame('../native/boards/style-b.html');mounts.push(styleA,styleB);await settle();
  completeTemplate('style-a.html',true,styleHTML);completeTemplate('style-b.html',true,styleHTML);await settle();
  assert.equal(templateRequests.filter(url=>url===styleURL).length,1,'Opaque board styles share one parent response');
  pendingTemplates.get(styleURL).resolve({ok:true,status:200,arrayBuffer:async()=>Uint8Array.from(style).buffer});
  await awaitResult(()=>styleA.frame.srcdocWrites===1&&styleB.frame.srcdocWrites===1);
  for(const item of [styleA,styleB]){
    const encoded=item.frame.getAttribute('srcdoc').match(/href="data:text\/css;base64,([^"]+)"/)[1];
    assert.deepEqual(Buffer.from(encoded,'base64'),style,'Mounted style bytes remain exact');
  }
  const resettingCore=Buffer.from('/* reset-race exact vendor */'),race=templateFrame('../native/boards/core-race.html');mounts.push(race);await settle();
  completeTemplate('core-race.html',true,coreHTML(resettingCore));await settle();race.reset.click();await settle();completeCore(resettingCore);await awaitResult(()=>race.frame.srcdocWrites===1);
  assert.equal(race.frame.srcdocWrites,1,'A pending shared core cannot mount the previous reset ticket');
  const disposedCore=Buffer.from('/* disposed exact vendor */'),disposedAsset=templateFrame('../native/boards/core-disposed.html');mounts.push(disposedAsset);await settle();
  completeTemplate('core-disposed.html',true,coreHTML(disposedCore));await settle();disposedAsset.handle.disconnect();
  const liveAsset=templateFrame('../native/boards/core-live.html');mounts.push(liveAsset);await settle();completeTemplate('core-live.html',true,coreHTML(disposedCore));await settle();completeCore(disposedCore);await awaitResult(()=>liveAsset.frame.srcdocWrites===1);assert.equal(disposedAsset.frame.srcdocWrites,0);
  const variantCore=Buffer.from('/* variant-race exact vendor */'),oldVariant=templateFrame('../native/boards/core-old-variant.html');mounts.push(oldVariant);await settle();completeTemplate('core-old-variant.html',true,coreHTML(variantCore));await settle();oldVariant.select.dispatchEvent(new FakeEvent('change',{bubbles:true}));oldVariant.frame.remove();
  const newVariant=templateFrame('../native/boards/core-new-variant.html',{t0:-2});mounts.push(newVariant);await settle();completeTemplate('core-new-variant.html',true,coreHTML(variantCore));await settle();completeCore(variantCore);await awaitResult(()=>newVariant.frame.srcdocWrites===1);assert.equal(oldVariant.frame.srcdocWrites,0);
  const countCore=Buffer.from('/* count mismatch */'),countAsset=templateFrame('../native/boards/core-count.html');mounts.push(countAsset);await settle();completeTemplate('core-count.html',true,coreHTML(countCore));await settle();completeCore(countCore,Buffer.from('short'));await awaitResult(()=>countAsset.card.querySelectorAll('.ctm-stack-jsxgraph-error').length===1);assert.equal(countAsset.frame.srcdocWrites,0);
  const networkCore=Buffer.from('/* network retry */'),networkAsset=templateFrame('../native/boards/core-network.html');mounts.push(networkAsset);await settle();completeTemplate('core-network.html',true,coreHTML(networkCore));await settle();pendingTemplates.get(coreURL(networkCore)).reject(new Error('network unavailable'));await awaitResult(()=>networkAsset.card.querySelectorAll('.ctm-stack-jsxgraph-error').length===1);
  networkAsset.reset.click();await settle();completeTemplate('core-network.html',true,coreHTML(networkCore));await settle();completeCore(networkCore);await awaitResult(()=>networkAsset.frame.srcdocWrites===1);assert.equal(templateRequests.filter(url=>url===coreURL(networkCore)).length,2);
  const retryCore=Buffer.from('/* retry exact vendor */'),badCore=templateFrame('../native/boards/core-retry.html');mounts.push(badCore);await settle();
  completeTemplate('core-retry.html',true,coreHTML(retryCore));await settle();const corrupt=Buffer.from(retryCore);corrupt[0]^=1;completeCore(retryCore,corrupt);await awaitResult(()=>badCore.card.querySelectorAll('.ctm-stack-jsxgraph-error').length===1);
  assert.equal(badCore.frame.srcdocWrites,0);assert.match(badCore.card.querySelectorAll('.ctm-stack-jsxgraph-error')[0].textContent,/SHA-256 mismatch/);
  badCore.reset.click();await settle();completeTemplate('core-retry.html',true,coreHTML(retryCore));await settle();completeCore(retryCore);await awaitResult(()=>badCore.frame.srcdocWrites===1);
  assert.equal(badCore.frame.srcdocWrites,1);assert.equal(badCore.card.querySelectorAll('.ctm-stack-jsxgraph-error').length,0);assert.equal(templateRequests.filter(url=>url===coreURL(retryCore)).length,2,'Failed integrity does not poison the retry cache');
  const invalidCore=templateFrame('../native/boards/core-invalid.html');mounts.push(invalidCore);await settle();completeTemplate('core-invalid.html',true,coreHTML(core).replace('./assets/'+digest(core)+'.js','./assets/unverified.js'));await settle();
  assert.equal(invalidCore.frame.srcdocWrites,0);assert.match(invalidCore.card.querySelectorAll('.ctm-stack-jsxgraph-error')[0].textContent,/content-addressed/);
  console.log('Template mounts: shared fetch, explicit base, stale reset/variant/disposal rejection and failed-fetch retry passed');
  console.log('Shared JSXGraph core: exact hashed bytes, one parent fetch, failed-integrity retry and lifecycle races passed');
}finally{for(const item of mounts)item.handle.disconnect();}
