import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {deriveStartupObserver} from './derive-startup-observer.mjs';
const digest=body=>createHash('sha256').update(body).digest('hex');
const record=body=>({bytes:Buffer.byteLength(body),sha256:digest(body)});
export const rootPath='/ctm/moodle-qtype_stack-master/stack/maxima/stacklocallinux.mac';
export const helperPath='/ctm/load-condition/observer.lisp';
const helper=await readFile(new URL('./load-condition.lisp',import.meta.url));
export function conditionStartup(original){
  const before='load("'+rootPath+'")$',after=':lisp (progn (load "'+helperPath+'") (funcall (find-symbol "RUN" "CTM-LOAD-CONDITION") "'+rootPath+'"))';
  assert.equal(original.split(before).length,2,'Exact unique original root-load command required');
  assert.equal(original.split('\n').filter(line=>line===before).length,1,'Root-load command must occupy one physical line');
  const derived=original.replace(before,after);assert.equal(derived.split('\n').length,original.split('\n').length);
  return {startup:derived,proof:{original:record(original),derived:record(derived),originalRootCommand:before,diagnosticRootCommand:after,scope:'One original root-load line is replaced with one diagnostic Lisp form. Dynamic ERRSET T changes error propagation; original surrounding startup commands remain exact.'}};
}
export function conditionChild(original){
  const guarded=deriveStartupObserver(original),source=guarded.derived.toString('utf8'),anchor='      stages.wasmReadyMs = performance.now() - started;';
  assert.equal(source.split(anchor).length,2);
  const mount=anchor+'\n      const conditionBytes=new TextEncoder().encode('+JSON.stringify(helper.toString('utf8'))+');\n'+
    '      FS.mkdirTree("/ctm/load-condition");\n      FS.writeFile('+JSON.stringify(helperPath)+',conditionBytes);\n'+
    '      const conditionMounted=FS.readFile('+JSON.stringify(helperPath)+');\n'+
    '      if(conditionMounted.length!==conditionBytes.length||!conditionMounted.every((value,index)=>value===conditionBytes[index]))throw Error("Diagnostic condition helper mount differs from trusted bytes");';
  let changed=source.replace(anchor,mount);
  const lineAnchor='    if (!initialized && !ctmStartupObserve(line)) continue;';assert.equal(changed.split(lineAnchor).length,2);
  changed=changed.replace(lineAnchor,'    if (!initialized) ctmConditionLine(line);\n'+lineAnchor);
  const capture=`function ctmConditionLine(line) {
  const c=ctmStartupGuard.conditionCapture||(ctmStartupGuard.conditionCapture={armedCount:0,recordCount:0,loggerFailedCount:0,overflow:0,lines:[]});
  if(line==='CTM-LOAD-CONDITION-ARMED')c.armedCount++;
  if(line==='CTM-LOAD-CONDITION-LOGGER-FAILED')c.loggerFailedCount++;
  if(line.startsWith('CTM-LOAD-CONDITION|')){c.recordCount++;if(c.lines.length<1&&line.length<=16384){c.lines.push(line);self.postMessage({type:'diagnostic',text:'CTM-LOAD-CONDITION-OBSERVED|'+JSON.stringify({schema:1,line})});}else c.overflow++;}
}
`;
  changed=changed.replace('function consume(text) {',capture+'function consume(text) {');
  const derived=Buffer.from(changed);
  return {derived,proof:{schema:1,kind:'scoped-root-load-condition-diagnostic',diagnosticOnly:true,acceptance:false,original:record(original),guarded:guarded.proof.derived,derived:record(derived),startupObserver:guarded.proof,helper:{path:helperPath,...record(helper),bytesVerifiedAfterWrite:true},scope:'Reviewed stdout guard plus one MEMFS helper mount before initialization. No runtime asset edits, compiler rebuild, CL:LOAD/function-cell interposition, TRACE, CPU or FS observers. Success/failure under ERRSET T cannot identify the original condition without matching evidence.'}};
}
export function parseConditionTail(startupGuard, immediate){
  const capture=startupGuard?.receipt?.conditionCapture,values=Array.isArray(immediate?.values)?immediate.values:[],immediateLines=values.map(value=>value?.line),lines=Array.isArray(capture?.lines)?capture.lines:immediateLines,records=[],errors=[];
  if(!immediate||!Array.isArray(immediate.values)||!Array.isArray(immediate.errors)||immediate.errors.length||immediate.count!==immediateLines.length||immediateLines.length>1||immediateLines.some(line=>typeof line!=='string')||values.some(value=>value?.schema!==1))errors.push('Missing/inconsistent immediate condition transport');
  if(capture&&JSON.stringify(capture.lines)!==JSON.stringify(immediateLines))errors.push('Receipt and immediate condition evidence differ');
  if(!capture||!Array.isArray(capture.lines)||capture.armedCount!==1||capture.recordCount!==lines.length||capture.recordCount>1||capture.overflow!==0||!Number.isInteger(capture.loggerFailedCount)||capture.loggerFailedCount<0)errors.push('Missing/inconsistent bounded condition capture');
  for(const line of lines)if(typeof line==='string'&&line.startsWith('CTM-LOAD-CONDITION|')){
    try{assert.ok(line.length<=16384);const value=JSON.parse(line.slice('CTM-LOAD-CONDITION|'.length));assert.equal(value.schema,1);assert.equal(value.kind,'maxima-root-load-condition');assert.equal(value.errset,true);assert.equal(typeof value.type,'string');assert.ok(value.type.length<=128);assert.equal(typeof value.report,'string');assert.ok(value.report.length<=2048);assert.equal(typeof value.reportTruncated,'boolean');records.push(value);}catch(error){errors.push(String(error));}
  }else errors.push('Invalid condition record prefix');
  return {armed:capture?.armedCount===1,records,errors,loggerFailed:Boolean(capture?.loggerFailedCount),capture:capture||null,immediate:immediate||null,stdoutTailTruncated:startupGuard?.receipt?.stdoutTailTruncated??null,scope:'A first bounded condition record is sent immediately through diagnostic/progress transport and also retained in the startup receipt even if its stdout tail rotates; missing/overflowed capture cannot establish absence of conditions. ERRSET T changes propagation, so no original-cause inference.'};
}
