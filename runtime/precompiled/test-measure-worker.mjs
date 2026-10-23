// SPDX-License-Identifier: AGPL-3.0-or-later
// Execute the generated worker, including its actual command escaping.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('./measure.mjs',import.meta.url),'utf8');
const start=source.indexOf('const worker=`'),end=source.indexOf('`;\nawait writeFile',start)+2;
assert.ok(start>=0&&end>start);
const worker=vm.runInNewContext(source.slice(start,end)+';worker');
new vm.Script(worker);
async function execute({returnValue=true,failAcknowledgment=false}={}) {
  const writes=[],messages=[];let resets=0,sentinel=false,gc=false;
  class Session {
    constructor(){this.manifest={stackLibraryVersion:'fixture-version'};}
    async init(){return {stages:{stackLoadMs:1}};}
    evaluate(expression){
      if(expression.includes('stack_reset('))throw new Error('Reset must be outside the dynamic evaluation wrapper');
      if(expression==='6*7')return 42;
      if(expression==='stackmaximaversion')return 'fixture-version';
      if(expression==='ctm_reset_sentinel:123456'){sentinel=true;return 123456;}
      if(expression.startsWith('is(ctm_reset_completed')){
        if(failAcknowledgment)throw new Error('Reset acknowledgment failed');
        return returnValue===true&&!sentinel;
      }
      if(expression.includes('ctm_force_gc')){assert.equal(gc,true);return true;}
      if(expression.includes('errcatch(error('))return 'CTM deliberate caught CAS error';
      throw new Error('Unexpected generated expression: '+expression);
    }
    write(command){
      assert.equal(command.endsWith('\n'),true,'Native commands need a real newline');
      assert.equal(command.includes('\\n'),false,'Literal backslash-n is not a command terminator');
      writes.push(command);
      if(command.includes('ctm_reset_completed:stack_reset(true)')){assert.equal(sentinel,true);sentinel=false;resets++;gc=false;}
      else if(command.startsWith(':lisp (defun maxima::$ctm_force_gc'))gc=true;
      else throw new Error('Unexpected trusted command');
    }
    assess(){return {cas_valid:true,correct:true};}
    terminate(){}
  }
  const self={postMessage:row=>messages.push(row)};let clock=0;
  vm.runInNewContext(worker,{self,MaximaSession:Session,importScripts(){},performance:{now:()=>++clock}});
  await self.onmessage({data:{manifest:'source-control'}});
  assert.equal(messages.length,1);
  return {result:messages[0],writes,resets};
}
const positive=await execute();
assert.equal(positive.result.ok,true);assert.equal(positive.result.phase,'complete');
assert.equal(positive.resets,3);assert.equal(positive.writes.length,6);
assert.ok(positive.result.resets.every(row=>row.reset===true&&row.gc===true&&row.afterError===42));
const falseReturn=await execute({returnValue:false});
assert.equal(falseReturn.result.resets[0].reset,false,'A failed reset result cannot be converted into success');
const failure=await execute({failAcknowledgment:true});
assert.equal(failure.result.ok,false);assert.equal(failure.result.phase,'reset-1');
assert.ok(failure.result.readyMs>0);assert.equal(failure.result.warmCalls.length,10);
assert.match(failure.result.error,/Reset acknowledgment failed/);
console.log('Generated measurement worker: global reset commands, three acknowledgments, real newlines and failure progress verified');
