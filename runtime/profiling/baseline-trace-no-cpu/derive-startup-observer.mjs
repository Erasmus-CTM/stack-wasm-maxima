import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const sha=body=>createHash('sha256').update(body).digest('hex');
const rec=body=>({bytes:body.length,sha256:sha(body)});
const observer=await readFile(new URL('./startup-observer.jsfrag',import.meta.url));
export function deriveStartupObserver(original){
  assert.equal(sha(original),'24125f846a4fb7d3f57c82327bb5dfe267998682858d25369045de44d1ec1e0b','Exact admitted original child required');
  let text=original.toString('utf8');
  const edits=[
    ['function consume(text) {',observer.toString('utf8')+'\nfunction consume(text) {\n  if (!initialized) ctmStartupGuard.stdoutCharacters += text.length;'],
    ["    outputLine = outputLine.slice(end + 1);","    outputLine = outputLine.slice(end + 1);\n    if (!initialized && !ctmStartupObserve(line)) continue;"],
    ["  self.postMessage({ type: 'error', error: message });","  if (!initialized) { ctmStartupGuard.failed = true; ctmStartupReceipt(false, 'Original child failure: ' + message.slice(0,2048)); }\n  self.postMessage({ type: 'error', error: message });"]
  ];
  for(const [before,after] of edits){assert.equal(text.split(before).length,2,'Unique original anchor required');text=text.replace(before,after);}
  const derived=Buffer.from(text);return {derived,proof:{schema:1,kind:'benchmark-startup-stdout-observer',diagnosticOnly:true,acceptance:false,original:rec(original),derived:rec(derived),observer:rec(observer),edits:edits.map(([before,after])=>({before:rec(Buffer.from(before)),after:rec(Buffer.from(after))})),scope:'Shared derived child only. Original startup commands, runtime assets, session wrapper, source and FAS unchanged. Completed pre-READY stdout lines are scanned for anchored fatal diagnostics and existing marker order. One bounded receipt; no TRACE/CPU/FS observer or per-line timestamps/messages. Does not prove a same-evaluation root-load return. Original stdout tail is bounded to 16384 characters; console stderr is retained separately.'}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i]]=process.argv[i+1];
  for(const name of ['--input','--output','--proof'])assert.ok(args[name],name+' required');
  assert.notEqual(resolve(args['--input']),resolve(args['--output']));
  const {derived,proof}=deriveStartupObserver(await readFile(args['--input']));
  await mkdir(dirname(resolve(args['--output'])),{recursive:true});await mkdir(dirname(resolve(args['--proof'])),{recursive:true});
  await writeFile(args['--output'],derived);await writeFile(args['--proof'],JSON.stringify(proof,null,2)+'\n');
}
