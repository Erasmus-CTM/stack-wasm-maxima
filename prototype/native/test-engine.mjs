// SPDX-License-Identifier: AGPL-3.0-or-later
// Controller/continuation boundary checks. Native execution is tested in CI
// against actual Wasm and the independent Maxima CLI, not mocked here.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

class AdmissionError extends Error {}
const scope = {NativeInput:{AdmissionError,admit: raw => {
  if (raw === 'bad') throw new AdmissionError('Invalid lexical input');
  if (raw === 'broken-controller') throw new Error('Invalid input rules configuration');
  return {raw,source:raw,type:'list'};
}}};
const context = vm.createContext({self:scope,TextEncoder,crypto:webcrypto});
vm.runInContext(await readFile(new URL('engine.js',import.meta.url),'utf8'),context);
const Engine = scope.NativeStackEngine;
assert.deepEqual(Array.from(Engine.statements('a: "a;b"; /* ; */ b: [1,2];')), ['a: "a;b"','b: [1,2]']);
assert.throws(() => Engine.statements('a: "unterminated'), /Unclosed/);
assert.equal(Engine.renderTemplate('x=@@CTM_NATIVE_t0@@', {t0:{format:'latex',value:'\\frac{1}{2}',wrap:true}}), 'x=\\(\\frac{1}{2}\\)');
assert.equal(Engine.renderTemplate('@@CTM_NATIVE_t0@@', {t0:{format:'latex',value:'<script>',string:true}}), '&lt;script&gt;');

const branch = (score,next=-1,note='n') => ({mode:'=',score,next,note,feedback:''});
const question = {name:'Mixed graph response',variables:'a:2;',native:{schema:1,id:'mixed-graph',locals:['a'],tokens:[]},simplify:true,inputs:[
  {name:'ans1',type:'algebraic',teacher:'[1,2]',checkanswertype:false}
],python_checkers:{api_version:1,source:'CHECKERS = {}'},penalty:0.1,prts:[{
  name:'prt1',value:1,autosimplify:true,feedbackvariables:'b:a+1;',locals:['b'],nodes:[
    {name:'0',test:'AlgEquiv',student:'ans1',teacher:'[1,2]',options:'',quiet:false,true:branch(0.5,1,'native-start'),false:branch(0)},
    {name:'1',test:'PythonChecker',student:'ans1',teacher:'[1,2]',options:'{"checker":"graph"}',quiet:false,true:branch(0.5,2,'python'),false:branch(0)},
    {name:'2',test:'AlgEquiv',student:'ans1',teacher:'[1,2]',options:'',quiet:false,true:branch(1,-1,'native-end'),false:branch(0)}
  ]
}],qtests:[]};
const variant = {seed:1,env:{a:'2'},teachers:{ans1:{source:'[1,2]',type:'list'}},tokenValues:{},qtests:[]};
const events=[], expressions=[], answers={ans1:'[1,2]'};
const valid = {ans1:{valid:true,latex:'[1,2]',feedback:'',source:'[1,2]'}};
const paused = {kind:'python',node:'1',score:0.5,notes:['native-start'],feedback:[],path:[{node:'0',branch:'true',note:'native-start'}],
  events:[{event:'native-at',node:'0'}],environment:{a:'2',b:'3',ans1:'[1,2]'},student:{source:'[1,2]',type:'list'},teacher:{source:'[1,2]',type:'list'}};
const done = {kind:'done',score:1,notes:['native-start','python','native-end'],feedback:[],path:[
  {node:'0',branch:'true',note:'native-start'},{node:'1',branch:'true',note:'python'},{node:'2',branch:'true',note:'native-end'}
],events:[{event:'native-at',node:'2'}]};
let queued=[valid,paused,done], pythonCalls=0;
const engine = new Engine({session:{manifest:{stackRevision:'test-stack-pin',stackLibraryVersion:'test-version',tests:{AlgEquiv:[false,true,false]}},evaluate: expression => {
  expressions.push(expression);
  assert.ok(queued.length,'Unexpected additional native call');
  return structuredClone(queued.shift());
}},onEvent:event=>events.push(event),pythonCheck:async request=>{
  pythonCalls++;
  assert.equal(request.options,'{"checker":"graph"}');
  assert.deepEqual(request.student,{source:'[1,2]',type:'list'});
  return {valid:true,correct:true,feedback:'A graph <property> holds'};
}});
variant.native = await engine.binding(question,variant);
const result = await engine.grade(question,variant,answers);
assert.equal(result.status,'graded'); assert.equal(result.score,1); assert.equal(pythonCalls,1); assert.equal(queued.length,0);
assert.deepEqual(Array.from(result.prts.prt1.path,node=>node.node),['0','1','2']);
assert.deepEqual(events.filter(event=>event.event==='native-at'||event.event==='python-checker').map(event=>[event.event,event.node,event.phase]),[
  ['native-at','0',undefined],['python-checker','1','pause'],['python-checker','1','resume'],['native-at','2',undefined]
]);
assert.match(expressions[2],/_ctm_current:"1"/,'Continuation must resume at pending Python node');
assert.match(expressions[2],/b:eval_string\("3"\)/,'Feedback variable state must survive continuation');

// A lexical invalid answer reaches no native PRT and invokes no checker.
const before = expressions.length;
const invalid = await engine.grade(question,variant,{ans1:'bad'});
assert.equal(invalid.status,'invalid');assert.equal(expressions.length,before);assert.equal(pythonCalls,1);
await assert.rejects(engine.grade(question,variant,{ans1:'broken-controller'}),/Invalid input rules configuration/,
  'A broken controller must not be reported as a learner-invalid answer');
await assert.rejects(engine.validate(question,{...variant,env:{...variant.env,undeclared:'1'}},answers),/declared question variables/);
await assert.rejects(engine.validate({...question,name:'Different question'},variant,answers),/does not match/);
await assert.rejects(engine.validate(question,{...variant,seed:2},answers),/does not match/);
await assert.rejects(engine.validate(question,{...variant,env:{a:'3'}},answers),/does not match/);

queued=[valid,paused];
engine.pythonCheck=async()=>({valid:false,correct:false,feedback:'Malformed graph state'});
const rejected=await engine.grade(question,variant,answers);
assert.equal(rejected.status,'invalid');assert.equal(rejected.inputs.ans1.valid,false);assert.equal(rejected.feedback,'Malformed graph state');

queued=[valid,paused];
engine.pythonCheck=async()=>{throw new Error('checker failed');};
await assert.rejects(engine.grade(question,variant,answers),/checker failed/,'Author failure must not become a wrong answer or a native fallback');

console.log('Native controller boundary: ordered continuation, state, invalid input and checker failure checks passed (mock native transport)');
