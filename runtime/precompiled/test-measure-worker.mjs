// SPDX-License-Identifier: AGPL-3.0-or-later
// Exercise the generated lifecycle protocol; native mathematics is checked in CI.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
const source=await readFile(new URL('./measure.mjs',import.meta.url),'utf8');
const restartChecks=JSON.parse(await readFile(new URL('./restart-checks.json',import.meta.url),'utf8'));
const start=source.indexOf('const worker=`'),end=source.indexOf('`;\nawait writeFile',start)+2;
assert.ok(start>=0&&end>start);
const worker=vm.runInNewContext(source.slice(start,end)+';worker',{restartChecks});
new vm.Script(worker);
assert.ok(restartChecks.checks.every(row=>!row.expression.includes('\\"')),'Maxima program data must contain plain quotes');
assert.ok(restartChecks.checks.find(row=>row.name==='pm-structure').expression.includes('parse_string("x#pm#y")'));
assert.deepEqual(restartChecks.checks.find(row=>row.name==='pm-display').expected,['{x '+String.fromCharCode(92)+'pm y}',' '+String.fromCharCode(92)+'pm y']);
const digest=text=>createHash('sha256').update(text).digest('hex');
async function execute(options={}){
  const sessions=[],messages=[],writes=[];let clock=0;
  const compiled=Boolean(options.compiled),asset={fileBytes:123,sha256:'a'.repeat(64)};
  const manifest={stackRevision:'fixture-pin',stackLibraryVersion:'fixture-version',runtimeBuild:{sourcePins:{sources:[{name:'maxima',version:'fixture-maxima'}]}},...(compiled?{compiledStack:{asset}}:{})};
  const expected={manifestSha256:digest(JSON.stringify(manifest)),stackRevision:manifest.stackRevision,stackLibraryVersion:manifest.stackLibraryVersion,maximaVersion:'fixture-maxima',compiledStack:manifest.compiledStack||null,bundleSha256:asset.sha256};
  class Session{
    constructor(){this.index=sessions.length;this.manifest=structuredClone(manifest);this.poisoned=false;sessions.push(this);}
    async init(){
      clock+=10+this.index;
      if(options.failInit&&this.index===1)throw new Error('Fixture restart init failed');
      this.ready=Promise.resolve(true);
      this.child=options.reuseChild&&this.index===1?sessions[0].child:{};
      for(const field of ['controlBuffer','inputBuffer','outputBuffer'])this[field]=options.reuseBuffer===field&&this.index===1?sessions[0][field]:new SharedArrayBuffer(8);
      if(options.changedManifest&&this.index===1)this.manifest.stackRevision='wrong-pin';
      const stages={stackLoadMs:1,...(compiled?{compiledStackMounted:true,compiledStackBytes:asset.fileBytes,compiledStackOpens:1,compiledSourceEntryOpens:0,compiledStackSha256:asset.sha256}:{})};
      if(options.sourceFallback&&this.index===2)stages.compiledSourceEntryOpens=1;
      if(options.zeroFasRead&&this.index===1)stages.compiledStackOpens=0;
      if(options.wrongFasHash&&this.index===1)stages.compiledStackSha256='b'.repeat(64);
      return {stages,maximaVersion:'fixture-maxima',stackRevision:manifest.stackRevision,stackLibraryVersion:manifest.stackLibraryVersion};
    }
    evaluate(expression){
      if(this.poisoned||!this.ready){if(options.oldAccepts)return 42;throw new Error('Maxima is not ready');}
      if(expression.includes('stack_reset('))throw new Error('Raw reset must remain a distinct diagnostic');
      if(expression==='stackmaximaversion')return options.wrongVersion&&this.index===1?'wrong-version':manifest.stackLibraryVersion;
      if(expression==='6*7')return 42;
      if(expression.startsWith('[STACKpmOPT'))return ['#pm#',true,true,!(options.missingDefault&&this.index===1),false,'~d','~a','.',true,true];
      if(expression.startsWith('[ctm_restart_sentinel,')){assert.equal(this.seeded,true);return [123456,42,true,true,true,!options.oldAssumptionMissed,true];}
      if(expression.startsWith("[is(ctm_restart_sentinel='"))return [!(options.sentinelSurvives&&this.index===1),!(options.functionSurvives&&this.index===1),!(options.functionSurvives&&this.index===1),true,true];
      if(expression.startsWith('block([%ERR:["stack_map"],%NOTES:')){
        const check=restartChecks.checks.find(row=>expression.includes('r:errcatch('+row.expression+')'));
        assert.ok(check,'Generated probe must preserve its exact Maxima quoting');
        if(options.semanticError&&this.index===1&&check.name==='pm-negative')return [false,'Fixture CAS error'];
        if(options.wrongDisplay&&this.index===1&&check.name==='pm-display')return [true,['wrong display','wrong display']];
        return [true,structuredClone(check.expected)];
      }
      if(expression.includes('ctm_force_gc')){assert.equal(this.gc,true);return !(options.failGc&&this.index===1);}
      if(expression.includes('errcatch(error('))return 'CTM deliberate caught CAS error';
      throw new Error('Unexpected generated expression: '+expression);
    }
    write(command){
      assert.equal(command.endsWith('\n'),true,'Commands require actual newline terminators');
      assert.equal(command.includes('\\n'),false,'Literal backslash-n is not a terminator');
      assert.equal(command.includes('stack_reset('),false);writes.push(command);
      if(command.startsWith('ctm_restart_sentinel:'))this.seeded=true;
      else if(command.startsWith(':lisp (defun maxima::$ctm_force_gc'))this.gc=true;
      else throw new Error('Unexpected trusted command');
    }
    assess(request){
      if(options.failRegrade&&this.index===1)throw new Error('Fixture regrade failed');
      return {cas_valid:true,correct:options.badNegative&&this.index===1?true:request.teacher==='x^2+2*x+1'};
    }
    terminate(){this.poisoned=true;this.ready=null;this.terminated=true;}
  }
  const self={postMessage:row=>messages.push(structuredClone(row))};
  vm.runInNewContext(worker,{self,MaximaSession:Session,importScripts(){},performance:{now:()=>clock++},crypto:webcrypto,TextEncoder});
  await self.onmessage({data:{manifest:'fixture-manifest.json',expected}});
  const final=messages.filter(row=>row.type!=='progress');assert.equal(final.length,1);
  return {result:final[0],sessions,messages,writes};
}
for(const compiled of [false,true]){
  const success=await execute({compiled});assert.equal(success.result.ok,true);assert.equal(success.result.phase,'complete');
  assert.equal(success.result.restartKind,'full-session-restart');assert.equal(success.sessions.length,4);
  assert.equal(success.result.readyMs,11);assert.deepEqual(success.result.restarts.map(row=>row.readyMs),[12,13,14]);
  assert.equal(success.result.warmCalls.length,10);assert.equal(success.result.restarts.length,3);
  assert.ok(success.result.restarts.every(row=>row.childReplaced&&row.buffersReplaced.every(Boolean)&&row.namespaceCleared.every(Boolean)&&row.gc&&row.afterError===42));
  assert.ok(success.sessions.every(row=>row.terminated));assert.equal(success.writes.length,6);
  assert.equal(success.result.checks.length,9);assert.ok(success.result.restarts.every(row=>row.checks.length===9));
}
const failures=[
  [{reuseChild:true},/reused a worker/,'initialize-1'],
  [{reuseBuffer:'inputBuffer'},/reused a worker/,'initialize-1'],
  [{failInit:true},/Fixture restart init failed/,'initialize-1'],
  [{oldAccepts:true},/Terminated session still accepts/,'terminate-1'],
  [{oldAssumptionMissed:true},/Disposable old state/,'seed-old-state-1'],
  [{sentinelSurvives:true},/Old namespace/,'namespace-1'],
  [{functionSurvives:true},/Old namespace/,'namespace-1'],
  [{changedManifest:true},/manifest content changed/,'initialize-1'],
  [{wrongVersion:true},/version mismatch/,'initialize-1'],
  [{missingDefault:true},/pinned defaults/,'policy-1'],
  [{semanticError:true},/Lifecycle check failed: pm-negative/,'semantic-1:pm-negative'],
  [{wrongDisplay:true},/Lifecycle value mismatch: pm-display/,'semantic-1:pm-display'],
  [{badNegative:true},/Negative regrading failed/,'grade-1'],
  [{compiled:true,sourceFallback:true},/read\/source fallback/,'initialize-2'],
  [{compiled:true,zeroFasRead:true},/read\/source fallback/,'initialize-1'],
  [{compiled:true,wrongFasHash:true},/hash mismatch/,'initialize-1'],
  [{failGc:true},/Full collection/,'gc-1'],
  [{failRegrade:true},/Fixture regrade failed/,'grade-1'],
];
for(const [options,error,phase] of failures){
  const failed=await execute(options);assert.equal(failed.result.ok,false,JSON.stringify(options));assert.match(failed.result.error,error);
  assert.equal(failed.result.phase,phase);assert.ok(failed.result.restarts.length>0);
  assert.ok(failed.messages.some(row=>row.type==='progress'&&row.progress.phase===phase));
}
console.log('Generated full-session restart: 4 distinct heaps, source/compiled identity, namespace/policy checks, GC/error recovery and18 failure controls verified');

const planStart=source.indexOf('const shortDiagnostic='),planEnd=source.indexOf('for(const path of files)',planStart);
const planning=source.slice(planStart,planEnd)+';report.planned';
for(const [env,diagnosticOnly,expected] of [[{},false,{trials:8,initializations:32,restarts:24}],[{PRECOMPILED_DIAGNOSTIC_SHORT:'1'},true,{trials:2,initializations:8,restarts:6}]]){
 const report={diagnosticOnly,scope:''};const planned=vm.runInNewContext(planning,{process:{env},report,assert});
 assert.deepEqual(JSON.parse(JSON.stringify(planned)),expected);
}
assert.throws(()=>vm.runInNewContext(planning,{process:{env:{PRECOMPILED_DIAGNOSTIC_SHORT:'1'}},report:{diagnosticOnly:false},assert}),/Short trials cannot clear/);
console.log('Fresh matrix stays8trials/32heaps; short2trial transport run requires explicit frozen provenance');
