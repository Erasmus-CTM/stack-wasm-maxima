// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
import {hash,accepted,brotliSafe} from './codec.mjs';
import {loadOwnedRuntime} from '../build/runtime-source.mjs';

export async function loadSidecars(source,mode){
 assert.ok(['gzip','br'].includes(mode),'Sidecar delivery mode must be gzip or br');
 const root=await realpath(resolve(source));
 const bytes=await readFile(resolve(root,'compression-manifest.json')),manifest=JSON.parse(bytes);
 const owned=await loadOwnedRuntime(root,resolve(fileURLToPath(new URL('../..',import.meta.url))));
 assert.equal(manifest.schema,1);assert.equal(manifest.toolchain.node,'v22.16.0');
 assert.equal(manifest.source.kind,'ctm-owned-build');
 assert.equal(hash(await readFile(resolve(root,'manifest.json'))),manifest.source.manifestSha256);
 assert.equal(manifest.source.manifestSha256,owned.provenance.manifestSha256);
 assert.equal(hash(await readFile(resolve(root,'artifact-manifest.json'))),manifest.source.artifactManifestSha256);
 const entries=new Map();
 for(const row of manifest.files){
  assert.equal(typeof row.path,'string');assert.ok(row.path&&!row.path.includes('\\')&&!row.path.includes(':')&&!row.path.startsWith('/')&&row.path.split('/').every(x=>x&&x!=='.'&&x!=='..'));
  assert.ok(!entries.has(row.path));assert.match(row.sha256,/^[0-9a-f]{64}$/);assert.ok(Number.isSafeInteger(row.bytes)&&row.bytes>=0);
  assert.equal(row.brotliSafe,brotliSafe(row.path));
  const encodings={};
  for(const [encoding,record] of Object.entries(row.encodings)){
   assert.ok(['gzip','br'].includes(encoding));
   const path=await realpath(resolve(root,record.path)),rel=relative(root,path);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));
   const encoded=await readFile(path);assert.equal(encoded.length,record.bytes);assert.equal(hash(encoded),record.sha256);
   const decoded=encoding==='gzip'?gunzipSync(encoded):brotliDecompressSync(encoded);
   assert.equal(decoded.length,row.bytes);assert.equal(hash(decoded),row.sha256);
   assert.equal(record.decodedBytes,row.bytes);assert.equal(record.decodedSha256,row.sha256);
   encodings[encoding]={body:encoded,sha256:record.sha256};
  }
  entries.set(row.path,{...row,encodings});
 }
 assert.deepEqual(new Set(entries.keys()),new Set([...owned.records.keys()].map(path=>path.slice(1)).concat('runtime-preload.json')),'Sidecars must cover the exact raw runtime and derived preload inventory');
 return {manifest,manifestSha256:hash(bytes),mode,select(pathname,body,acceptEncoding){
  if(!pathname.startsWith('/maxima-runtime/'))return null;
  const row=entries.get(pathname.slice('/maxima-runtime/'.length));assert.ok(row,'Runtime request is absent from sidecar manifest: '+pathname);
  assert.equal(body.length,row.bytes);assert.equal(hash(body),row.sha256,'Staged runtime differs from compressed canonical bytes');
  const encoding=mode==='br'&&row.brotliSafe&&accepted(acceptEncoding,'br')?'br':accepted(acceptEncoding,'gzip')?'gzip':null;
  if(!encoding||!row.encodings[encoding]||row.encodings[encoding].body.length>=body.length)return null;
  return {encoding,...row.encodings[encoding],manifestSha256:hash(bytes)};
 }};
}
