// SPDX-License-Identifier: AGPL-3.0-or-later
// Raw HTTPS keeps encoded body counts; fetch() would transparently decode them.
import https from 'node:https';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
const base='https://erasmus-ctm.github.io/stack-wasm-maxima/previews/research/2026-10-native-stack/maxima-runtime/';
const hash=body=>createHash('sha256').update(body).digest('hex');
const report={schema:1,base,measuredAt:new Date().toISOString(),passed:false,assets:[],
 toolchain:{node:process.version,zlib:process.versions.zlib,platform:process.platform,arch:process.arch},
 scope:'Read-only observation of the existing public GitHub Pages preview. These response headers/body counts do not establish deployment of CTM gzip/Brotli sidecars. The tested sidecar negotiation is for servers/offline hosting under our control.'};
const request=url=>new Promise((resolve,reject)=>{
 const req=https.get(url,{headers:{'Accept-Encoding':'br, gzip','User-Agent':'CTM-runtime-encoding-measurement'}},res=>{
  const chunks=[];let length=0;
  res.on('data',chunk=>{length+=chunk.length;if(length>64*1024*1024){req.destroy(new Error('Public asset exceeds measurement bound'));return;}chunks.push(chunk);});
  res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject);
 });req.setTimeout(120000,()=>req.destroy(new Error('Public Pages request timeout')));req.on('error',reject);
});
try{
 const inventory=JSON.parse(await readFile('measurements/2026-10-21-runtime-assets.json','utf8'));
 const linked=JSON.parse(await readFile('measurements/2026-10-21-runtime-dependencies.json','utf8'));
 const expected=new Map([...inventory.assets,...linked.assets].map(row=>[new URL(row.url).pathname.slice(1),row]));
 for(const path of ['maxima.wasm','libecl.so','maxima-solve.fas']){
  const url=new URL(path,base).href,{body,headers,status}=await request(url);
  const encoding=headers['content-encoding']||'identity';
  const decoded=encoding==='gzip'?gunzipSync(body):encoding==='br'?brotliDecompressSync(body):body;
  report.assets.push({path,url,status,encoding,encodedBodyBytes:body.length,decodedBytes:decoded.length,
   encodedSha256:hash(body),decodedSha256:hash(decoded),frozenDeploymentHashMatches:hash(decoded)===expected.get(path)?.sha256,headers});
  if(status!==200)throw new Error(path+': HTTP '+status);
  if(hash(decoded)!==expected.get(path)?.sha256)throw new Error(path+': public bytes differ from the frozen deployment; inspect before claiming a comparison');
 }
 report.passed=true;
}catch(error){report.failure=String(error);}
await mkdir('.cache/runtime-build/validation',{recursive:true});
await writeFile('.cache/runtime-build/validation/public-pages-encoding.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
if(!report.passed)process.exitCode=1;
