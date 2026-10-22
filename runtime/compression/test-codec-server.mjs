// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit fixtures run on the local Node too; published measurements require pinned Node.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {encode,hash,accepted,brotliSafe} from './codec.mjs';
import {loadSidecars} from './server-source.mjs';
import {serveDemo} from '../../scripts/milestone-two/serve.mjs';
const work=resolve('.cache/runtime-compression/tests');await mkdir(work,{recursive:true});
const root=await mkdtemp(join(work,'fixture-')),artifact=join(root,'artifact'),site=join(root,'site');
const bodies={'maxima.wasm':Buffer.from('ordinary fetch body '.repeat(2000)),'maxima-solve.fas':Buffer.from('lazy file body '.repeat(2000)),'runtime-preload.json':Buffer.from(JSON.stringify({fixture:'preload'.repeat(3000)}))};
let app;
try {
 const sourcePins=JSON.parse(await readFile(resolve('runtime/build/pins.json'))),rows=[];
 for(const [path,body] of Object.entries(bodies)){
  await mkdir(join(site,'maxima-runtime'),{recursive:true});await writeFile(join(site,'maxima-runtime',path),body);
  if(path!=='runtime-preload.json'){await mkdir(join(artifact,'runtime'),{recursive:true});await writeFile(join(artifact,'runtime',path),body);}
  const variants=encode(body);assert.deepEqual(encode(body),variants);assert.equal(variants.gzip.readUInt32LE(4),0);
  const encodings={};for(const [encoding,encoded] of Object.entries(variants)){
   const file=path+'.'+encoding;await writeFile(join(artifact,file),encoded);
   encodings[encoding]={path:file,bytes:encoded.length,sha256:hash(encoded),decodedBytes:body.length,decodedSha256:hash(body)};
  }
  rows.push({path,bytes:body.length,sha256:hash(body),brotliSafe:brotliSafe(path),encodings});
 }
 const raw={schema:1,sourcePins,runtimeAssets:rows.filter(r=>r.path!=='runtime-preload.json').map(({path,bytes,sha256})=>({path,bytes,sha256}))};
 const rawBytes=Buffer.from(JSON.stringify(raw)),original=Buffer.from(JSON.stringify({schema:1,files:[]}));
 await writeFile(join(artifact,'manifest.json'),rawBytes);await writeFile(join(artifact,'artifact-manifest.json'),original);
 const manifest={schema:1,toolchain:{node:'v22.16.0'},source:{kind:'ctm-owned-build',manifestSha256:hash(rawBytes),artifactManifestSha256:hash(original)},files:rows};
 await writeFile(join(artifact,'compression-manifest.json'),JSON.stringify(manifest));
 assert.equal(accepted('br;q=0, gzip;q=1','br'),false);assert.equal(accepted('br;q=0, gzip;q=1','gzip'),true);
 assert.equal(accepted('*;q=0','br'),false);assert.equal(accepted('br;q=not-a-number','br'),false);
 for(const mode of ['br','gzip']){
  app=await serveDemo({root:site,sidecarSource:artifact,sidecarMode:mode});
  for(const [path,body] of Object.entries(bodies)){
   const url=app.baseURL+'maxima-runtime/'+path;
   const response=await fetch(url,{headers:{'Accept-Encoding':'br, gzip'}});
   assert.equal(response.headers.get('content-encoding'),mode==='br'&&brotliSafe(path)?'br':'gzip');
   assert.equal(response.headers.get('accept-ranges'),'none');assert.deepEqual(Buffer.from(await response.arrayBuffer()),body);
   const head=await fetch(url,{method:'HEAD',headers:{'Accept-Encoding':'br, gzip'}});
   assert.equal(head.headers.get('content-encoding'),response.headers.get('content-encoding'));assert.equal((await head.arrayBuffer()).byteLength,0);
   const range=await fetch(url,{headers:{Range:'bytes=7-43','Accept-Encoding':'br, gzip'}});
   assert.equal(range.status,206);assert.equal(range.headers.get('content-encoding'),null);
   assert.equal(range.headers.get('content-range'),`bytes 7-43/${body.length}`);assert.deepEqual(Buffer.from(await range.arrayBuffer()),body.subarray(7,44));
  }
  assert.ok(app.requests.every(row=>row.sidecarManifestSha256));
  await app.close();app=null;
 }
 const sidecars=await loadSidecars(artifact,'br');
 assert.equal(sidecars.select('/maxima-runtime/maxima-solve.fas',bodies['maxima-solve.fas'],'br'),null,'Lazy-file Brotli-only requests must use identity');
 assert.throws(()=>sidecars.select('/maxima-runtime/unknown.fas',Buffer.from('x'),'gzip'));
 await writeFile(join(artifact,'maxima.wasm.br'),'corrupt');await assert.rejects(()=>loadSidecars(artifact,'br'));
 console.log('Deterministic codec, decoded SHA, ordinary Brotli/lazy gzip, HEAD, identity ranges and tampering checks passed; unit Node '+process.version);
}finally{if(app)await app.close();assert.equal(dirname(root),work);await rm(root,{recursive:true,force:true});}
