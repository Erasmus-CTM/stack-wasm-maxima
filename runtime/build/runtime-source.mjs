// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function loadOwnedRuntime(source,repository) {
 if(!source)return null;
 const root=resolve(source),bytes=await readFile(resolve(root,'manifest.json'));
 const manifest=JSON.parse(bytes);
 const pins=JSON.parse(await readFile(resolve(repository,'runtime/build/pins.json')));
 assert.equal(manifest.schema,1);assert.deepEqual(manifest.sourcePins,pins,'Owned runtime must match the exact current source pins');
 assert.ok(Array.isArray(manifest.runtimeAssets)&&manifest.runtimeAssets.length>0);
 const records=new Map();
 for(const record of manifest.runtimeAssets) {
  assert.equal(typeof record.path,'string');
  assert.ok(record.path&&!record.path.includes('\\')&&!record.path.startsWith('/')&&!record.path.includes(':')&&record.path.split('/').every(p=>p&&p!=='.'&&p!=='..'));
  assert.ok(!records.has('/'+record.path),'Duplicate owned asset');
  assert.match(record.sha256,/^[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(record.bytes)&&record.bytes>=0);
  const content=await readFile(resolve(root,'runtime',record.path));
  assert.equal(content.length,record.bytes,record.path);assert.equal(hash(content),record.sha256,record.path);
  records.set('/'+record.path,{...record,fileBytes:record.bytes});
 }
 return {root:resolve(root,'runtime'),records,provenance:{kind:'ctm-owned-build',manifestSha256:hash(bytes),sourcePins:pins}};
}
