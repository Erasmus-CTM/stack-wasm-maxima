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
async function execute({returnValue=true,failAcknowledgment=false,failRegrade=false,resetError=false,sentinelSurvives=false,diagnostic=false,probeError=false,fatalProbe=false,registrationResult=[true,true]}={}) {
  const writes=[],messages=[],probes=[];let resets=0,sentinel=false,gc=false,grades=0;
  class Session {
    constructor(){this.manifest={stackLibraryVersion:'fixture-version'};}
    async init(){return {stages:{stackLoadMs:1}};}
    evaluate(expression){
      if(expression.includes('stack_reset('))throw new Error('Reset must be outside the dynamic evaluation wrapper');
      if(expression==='ctm_reserved_all_state()')return [true,false,[]];
      if(expression==='ctm_stack_helper_state()')return [['fixture',true,true,true,true,true,false]];
      if(expression.includes('errcatch(ctm_register_stack_library_helpers('))return registrationResult;
      if(expression.startsWith('block([%ERR:["stack_map"],%NOTES:')){
        probes.push(expression);
        assert.equal(expression.includes('\\"'),false,'Maxima probe quotes must survive generated JavaScript');
        if(fatalProbe&&probes.length===3)throw new Error('Fixture fatal probe');
        return probeError&&probes.length===1?[false,'Fixture caught CAS error']:[true,'fixture observation'];
      }
      if(expression==='6*7')return 42;
      if(expression==='stackmaximaversion')return 'fixture-version';
      if(expression.startsWith('string([STACKpmOPT'))return 'fixture globals';
      if(expression==='ctm_reset_sentinel:123456'){sentinel=true;return 123456;}
      if(expression.startsWith('[ctm_reset_result')){
        if(failAcknowledgment)throw new Error('Reset acknowledgment failed');
        return [resetError?[]:[returnValue],!sentinel,resetError?'Actual reset error':false];
      }
      if(expression.includes('ctm_force_gc')){assert.equal(gc,true);return true;}
      if(expression.includes('errcatch(error('))return 'CTM deliberate caught CAS error';
      throw new Error('Unexpected generated expression: '+expression);
    }
    write(command){
      assert.equal(command.endsWith('\n'),true,'Native commands need a real newline');
      assert.equal(command.includes('\\n'),false,'Literal backslash-n is not a command terminator');
      writes.push(command);
      if(command===':lisp fixture\n')return;
      if(command.includes('ctm_reset_result:errcatch(stack_reset(true))')){assert.equal(sentinel,true);sentinel=sentinelSurvives;resets++;gc=false;}
      else if(command.startsWith(':lisp (defun maxima::$ctm_force_gc'))gc=true;
      else throw new Error('Unexpected trusted command');
    }
    assess(){if(failRegrade&&grades++>0)throw new Error('CAS evaluation failed: fixture cause');return {cas_valid:true,correct:true};}
    terminate(){}
  }
  const self={postMessage:row=>messages.push(row)};let clock=0;
  vm.runInNewContext(worker,{self,MaximaSession:Session,importScripts(){},performance:{now:()=>++clock}});
  await self.onmessage({data:{manifest:'source-control',resetCompatibility:diagnostic?'fixture':null}});
  assert.equal(messages.length,1);
  return {result:messages[0],writes,resets,probes};
}
const positive=await execute();
assert.equal(positive.result.ok,true);assert.equal(positive.result.phase,'complete');
assert.equal(positive.resets,3);assert.equal(positive.writes.length,6);
assert.ok(positive.result.resets.every(row=>row.reset===true&&row.gc===true&&row.afterError===42));
const falseReturn=await execute({returnValue:false});
assert.equal(falseReturn.result.ok,false);
assert.equal(falseReturn.resets,1,'Failed reset must stop before collection and further resets');
assert.equal(falseReturn.result.resets[0].reset,false,'A failed reset result cannot be converted into success');
const survived=await execute({sentinelSurvives:true});
assert.equal(survived.result.ok,false);assert.equal(survived.result.resets[0].returned[0],true);
assert.equal(survived.result.resets[0].sentinelCleared,false);
const resetFailure=await execute({resetError:true});
assert.equal(resetFailure.result.ok,false);assert.equal(resetFailure.result.resets[0].returned.length,0);
assert.equal(resetFailure.result.resets[0].error,'Actual reset error');
const regrade=await execute({failRegrade:true});
assert.equal(regrade.result.ok,false);assert.equal(regrade.result.phase,'regrade-1');
assert.equal(regrade.result.resets.length,1);
assert.equal(regrade.result.resets[0].reset,true);assert.equal(regrade.result.resets[0].gc,true);
assert.equal(regrade.result.resets[0].afterError,42);
assert.match(regrade.result.error,/fixture cause/);
const failure=await execute({failAcknowledgment:true});
assert.equal(failure.result.ok,false);assert.equal(failure.result.phase,'reset-1');
assert.ok(failure.result.readyMs>0);assert.equal(failure.result.warmCalls.length,10);
assert.match(failure.result.error,/Reset acknowledgment failed/);
console.log('Generated measurement worker: global reset commands, three acknowledgments, real newlines and failure progress verified');

const diagnostic=await execute({diagnostic:true,probeError:true});
assert.equal(diagnostic.result.ok,true);
assert.deepEqual(Array.from(diagnostic.result.lifecycleBefore[0].result),[false,'Fixture caught CAS error']);
assert.equal(diagnostic.result.lifecycleBefore.length,9,'Caught probe errors must not hide later observations');
assert.ok(diagnostic.probes.some(program=>program.includes('parse_string("x#pm#y")')));
assert.ok(diagnostic.result.resets.every(row=>row.lifecycle.length===9));
const fatalProbe=await execute({diagnostic:true,fatalProbe:true});
assert.equal(fatalProbe.result.ok,false);
assert.equal(fatalProbe.result.phase,'lifecycle-before:pm-structure');
assert.equal(fatalProbe.result.lifecycleBefore.length,3);
assert.equal(fatalProbe.result.lifecycleBefore[1].result[0],true);
assert.equal(fatalProbe.result.lifecycleBefore[2].result,null);
assert.match(fatalProbe.result.error,/Fixture fatal probe/);
console.log('Diagnostic probe transport: plain quotes, caught-error continuation and fatal-progress retention verified');

for(const registrationResult of [[false,'Fixture registration error'],[true,'symbolic call']]){
 const rejected=await execute({diagnostic:true,registrationResult});
 assert.equal(rejected.result.ok,false);
 assert.equal(rejected.result.phase,'helper-registration');
 assert.equal(rejected.result.helpersAtRegistration.length,1);
 assert.match(rejected.result.error,/Helper registration rejected/);
 assert.equal(rejected.probes.length,0);
}
console.log('Registration acknowledgment: rejected and symbolic outcomes stop before lifecycle probes');
