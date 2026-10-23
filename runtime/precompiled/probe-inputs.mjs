// SPDX-License-Identifier: AGPL-3.0-or-later
// Optional binary inputs for the unchanged official answer-test batch.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=body=>createHash('sha256').update(body).digest('hex');
const loaderPath='stack/maxima/stacklocallinux.mac';
const bundlePath='stack/maxima/stackmaxima.fas';
const oldLoad='load("stackmaxima.mac")$';
const newLoad='load("/ctm/moodle-qtype_stack-master/stack/maxima/stackmaxima.fas")$';

export async function compiledProbeInputs(indexPath, preparedBytes) {
  const prepared=JSON.parse(preparedBytes),index=JSON.parse(await readFile(indexPath,'utf8'));
  assert.deepEqual(prepared.versions.map(row=>row.stackRevision).sort(),
    ['10d323311b7f39fb7b092dd10ce75f7d8632f525','33383047af39c204bf4442802a058f8b918b2b1b'].sort());
  assert.equal(index.schema,1);
  assert.deepEqual(index.officialPrepared,{bytes:preparedBytes.length,sha256:hash(preparedBytes)});
  assert.equal(index.pins.length,2);
  assert.equal(new Set(index.pins.map(row=>row.stackRevision)).size,2);
  assert.deepEqual(index.pins.map(row=>row.stackRevision).sort(),prepared.versions.map(row=>row.stackRevision).sort());
  const result=new Map();
  for(const row of index.pins) {
    const original=prepared.versions.find(version=>version.stackRevision===row.stackRevision);
    const bytes=await readFile(row.manifest.path);
    assert.equal(bytes.length,row.manifest.bytes);assert.equal(hash(bytes),row.manifest.sha256);
    const manifest=JSON.parse(bytes);
    assert.equal(manifest.schema,1);assert.equal(row.compiledStack.schema,1);
    assert.equal(manifest.stackRevision,original.stackRevision);
    assert.deepEqual(manifest.compiledStack,row.compiledStack);
    const compiled=row.compiledStack;
    assert.equal(compiled.stackRevision,original.stackRevision);
    assert.equal(compiled.mode,'entry-fas');assert.equal(compiled.asset.path,'stackmaxima.fas');
    const source=original.files.find(file=>file.path==='stack/maxima/stackmaxima.mac');
    assert.ok(source);assert.ok(original.files.some(file=>file.path===loaderPath));
    assert.equal(compiled.sourceSha256,source.sha256);
    assert.equal(new Set(original.files.map(file=>file.path)).size,original.files.length);
    assert.equal(original.files.some(file=>file.path===bundlePath),false);
    assert.equal(manifest.files.length,original.files.length);
    assert.equal(new Set(manifest.files.map(file=>file.path)).size,manifest.files.length);
    const inputs=[];
    for(const file of original.files) {
      assert.equal(Buffer.byteLength(file.content),file.bytes);assert.equal(hash(file.content),file.sha256);
      const actual=manifest.files.find(candidate=>candidate.path===file.path);assert.ok(actual);
      if(file.path===loaderPath) {
        assert.equal(file.content.split(oldLoad).length,2);
        const content=file.content.replace(oldLoad,newLoad);
        assert.deepEqual(actual,{...file,content,bytes:Buffer.byteLength(content),sha256:hash(content)});
        assert.equal(compiled.originalLoaderSha256,file.sha256);
        assert.equal(compiled.overlayLoaderSha256,actual.sha256);
      }else assert.deepEqual(actual,file);
      inputs.push(actual);
    }
    const binary=await readFile(row.bundlePath);
    assert.equal(binary.length,compiled.asset.fileBytes);assert.equal(hash(binary),compiled.asset.sha256);
    inputs.push({path:bundlePath,bytes:binary.length,sha256:hash(binary),encoding:'base64',content:binary.toString('base64')});
    result.set(original.stackRevision,{files:inputs,compiledStack:compiled,manifestSha256:hash(bytes)});
  }
  return result;
}
