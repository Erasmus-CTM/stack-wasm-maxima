// Trusted minimal constructor fixtures only. Never loads/evaluates maxima.js.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const replacement=await readFile(new URL('./errno-stack-body.jsfrag',import.meta.url),'utf8');
const receiptBody=await readFile(new URL('./errno-stack-receipt.jsfrag',import.meta.url),'utf8');
function fixture({derived=false,initial=true,shape='normal',messageKind='string',superFailure=false,observerThrows=false,collision=false}={}){
  const context=vm.createContext({});
  const descriptor=`Object.defineProperty(Error,'stackTraceLimit',`;
  const shapes={normal:`${descriptor}{value:20,writable:true,configurable:true,enumerable:false});`,
    readonly:`${descriptor}{value:20,writable:false,configurable:true,enumerable:true});`,
    absent:`delete Error.stackTraceLimit;`,
    accessor:`${descriptor}{get(){return 20},configurable:true,enumerable:true});`,
    inherited:`delete Error.stackTraceLimit;Object.setPrototypeOf(Error,{stackTraceLimit:20});`,
    nonnumeric:`${descriptor}{value:'20',writable:true,configurable:true});`,
    infinity:`${descriptor}{value:Infinity,writable:true,configurable:true});`,
    zero:`${descriptor}{value:0,writable:true,configurable:true});`,
    negative:`${descriptor}{value:-1,writable:true,configurable:true});`,
    nonconfigurable:`${descriptor}{value:20,writable:true,configurable:false,enumerable:true});`};
  vm.runInContext(shapes[shape],context);
  if(superFailure)vm.runInContext(`var injectedFailure=new Error('synthetic superclass failure');
    Error=new Proxy(Error,{construct(target,args,newTarget){if(args[0]==='fixture errno 44')throw injectedFailure;return Reflect.construct(target,args,newTarget)}});`,context);
  vm.runInContext(`
    var runtimeInitialized=${initial};
    var ERRNO_CODES={ENOENT:44,ENOTDIR:54,EIO:29,EACCES:2};
    var messageCalls=0;
    var Module=${collision?"{__ctmErrnoStackExperimentReceiptV1:'existing'}":'{}'},receipts=[],observerCalls=0;
    function postMessage(message){observerCalls++;if(!descriptorSame())throw Error('descriptor not restored before observer');${observerThrows?"throw Error('synthetic observer failure');":'receipts.push(JSON.parse(message.text.split("|")[1]));'}}
    function strError(errno){messageCalls++;
      ${messageKind==='throw'?`throw new Error('message computation failed');`:messageKind==='object'?`return {toString(){throw new Error('message conversion failed')}};`:`return 'fixture errno '+errno;`}
    }
    var before=Object.getOwnPropertyDescriptor(Error,'stackTraceLimit');
    class FixtureErrnoError extends Error {
      name='ErrnoError';
      constructor(errno){
        ${derived?replacement:`super(runtimeInitialized ? strError(errno) : '');`}
        this.errno=errno;
        for(var key in ERRNO_CODES){if(ERRNO_CODES[key]===errno){this.code=key;break;}}
        ${derived?receiptBody:''}
      }
    }
    function create(errno){return new FixtureErrnoError(errno)}
    function capture(errno){try{return {error:create(errno),thrown:false};}catch(error){return {error,thrown:true};}}
    function descriptorSame(){const after=Object.getOwnPropertyDescriptor(Error,'stackTraceLimit');
      return before===undefined?after===undefined:Reflect.ownKeys(before).every(k=>before[k]===after[k])&&Reflect.ownKeys(before).length===Reflect.ownKeys(after).length;}
  `,context);
  return {context,run:code=>vm.runInContext(code,context)};
}
let checks=0;
for(const errno of [44,54,29,2,0,999,'44',null,undefined]){
 const original=fixture(),changed=fixture({derived:true});
 for(const value of [original,changed]){
  value.context.errno=errno;assert.equal(value.run('var a=capture(errno),b=capture(errno);a.thrown'),false);
  assert.equal(value.run('a.error!==b.error && a.error instanceof Error && a.error instanceof FixtureErrnoError && Object.getPrototypeOf(a.error)===FixtureErrnoError.prototype && a.error.constructor===FixtureErrnoError'),true);
  assert.equal(value.run('a.error.errno'),errno);assert.equal(value.run('descriptorSame()'),true);
 }
 for(const field of ['name','message','errno','code'])assert.equal(original.run('a.error.'+field),changed.run('a.error.'+field));
 assert.equal(changed.run('messageCalls'),2);
 const stack=changed.run('a.error.stack');
 if(errno===44||errno===54){assert.equal(stack.includes('\n    at '),false);assert.equal(original.run('String(a.error.stack).includes("\\n    at ")'),true);}
 else assert.match(stack,/\n\s+at create/);
 checks++;
}
for(const shape of ['readonly','absent','accessor','inherited','nonnumeric','infinity','nonconfigurable']){
 const original=fixture({shape}),changed=fixture({derived:true,shape});
 for(const value of [original,changed])assert.equal(value.run('var a=capture(44);descriptorSame()'),true);
 assert.equal(original.run('a.thrown'),changed.run('a.thrown'));assert.equal(original.run('a.error.message'),changed.run('a.error.message'));
 if(shape==='nonconfigurable')assert.equal(changed.run('String(a.error.stack).includes("\\n    at ")'),false);
 else assert.equal(original.run('String(a.error.stack).includes("\\n    at ")'),changed.run('String(a.error.stack).includes("\\n    at ")'));
 checks++;
}
for(const messageKind of ['throw','object'])for(const errno of [44,54,29]){
 const value=fixture({derived:true,messageKind});value.context.errno=errno;
 assert.equal(value.run('var a=capture(errno);a.thrown'),true);
 assert.match(value.run('a.error.stack'),/\n\s+at (strError|Object.toString)/);
 assert.equal(value.run('descriptorSame()'),true);checks++;
}
for(const derived of [false,true]){
 const value=fixture({derived,initial:false});assert.equal(value.run('var a=create(44);a.message'), '');
 assert.equal(value.run('messageCalls'),0);assert.equal(value.run('descriptorSame()'),true);checks++;
}
// Expected lookups remain catchable by the existing class/errno contract; a
// later unexpected errno retains its independent stack after those lookups.
const after=fixture({derived:true});assert.equal(after.run('for(let i=0;i<100;i++){try{throw create(i%2?44:54)}catch(e){if(!(e instanceof FixtureErrnoError)||![44,54].includes(e.errno))throw e;}}descriptorSame()'),true);
assert.match(after.run('create(29).stack'),/\n\s+at create/);checks++;
const failedSuper=fixture({derived:true,superFailure:true});
assert.equal(failedSuper.run('var a=capture(44);a.thrown&&a.error===injectedFailure&&descriptorSame()'),true);
assert.match(failedSuper.run('create(29).stack'),/\n\s+at create/);checks++;
const once=fixture({derived:true});
assert.equal(once.run('create(29);receipts.length'),0);
assert.equal(once.run('create(44);create(54);create(44);receipts.length'),1);
assert.equal(once.run('receipts[0].didSuppress&&receipts[0].supported&&receipts[0].descriptorRestored&&receipts[0].stack.frameCount===0'),true);checks++;
assert.equal(once.run('receipts[0].errno===44&&receipts[0].assignedErrno===44&&receipts[0].code==="ENOENT"'),true);checks++;
assert.equal(once.run('receipts[0].originalStackTraceLimit'),20);checks++;
for(const shape of ['zero','negative']){
 const value=fixture({derived:true,shape});
 assert.equal(value.run('create(44);descriptorSame()&&receipts[0].originalStackTraceLimit<=0'),true);
 assert.equal(value.run('receipts[0].didSuppress'),true);checks++;
}
for(const shape of ['readonly','absent','accessor','inherited','nonnumeric','infinity']){
 const value=fixture({derived:true,shape});
 assert.equal(value.run('create(44);receipts.length'),1);
 assert.equal(value.run('receipts[0].didSuppress||receipts[0].supported'),false);
 assert.equal(value.run('receipts[0].descriptorRestored'),true);
 assert.equal(value.run('typeof receipts[0].fallbackReason'), 'string');checks++;
}
const observer=fixture({derived:true,observerThrows:true});
assert.equal(observer.run('var a=capture(44),b=capture(54);!a.thrown&&!b.thrown&&a.error.errno===44&&b.error.code==="ENOTDIR"&&descriptorSame()'),true);
assert.equal(observer.run('observerCalls'),1);assert.equal(observer.run('receipts.length'),0);checks++;
const collision=fixture({derived:true,collision:true});
assert.equal(collision.run('var a=capture(44);!a.thrown&&a.error.errno===44&&Module.__ctmErrnoStackExperimentReceiptV1==="existing"&&descriptorSame()'),true);
assert.equal(collision.run('observerCalls'),0);checks++;
console.log(JSON.stringify({passed:true,checks,scope:'Own minimal JS constructor fixtures only; no generated artifact JS, browser, Wasm, FAS, Lisp or compiler executed'}));
