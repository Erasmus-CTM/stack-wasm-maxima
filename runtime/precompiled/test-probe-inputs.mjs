// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {compiledProbeInputs} from './probe-inputs.mjs';
const hash=body=>createHash('sha256').update(body).digest('hex');
const record=body=>({bytes:Buffer.byteLength(body),sha256:hash(body)});
const pins=['33383047af39c204bf4442802a058f8b918b2b1b','10d323311b7f39fb7b092dd10ce75f7d8632f525'];
const root=await mkdtemp(join(tmpdir(),'ctm-compiled-probes-'));
try {
  const prepared={versions:pins.map(stackRevision=>({stackRevision,batch:'original official batch',files:[
    {path:'stack/maxima/stackmaxima.mac',content:stackRevision,...record(stackRevision)},
    {path:'stack/maxima/stacklocallinux.mac',content:'load("stackmaxima.mac")$',...record('load("stackmaxima.mac")$')}
  ]}))};
  const preparedBytes=Buffer.from(JSON.stringify(prepared));
  const index={schema:1,officialPrepared:record(preparedBytes),pins:[]};
  for(const version of prepared.versions) {
    const binary=Buffer.from('separate compiled bundle '+version.stackRevision);
    const content='load("/ctm/moodle-qtype_stack-master/stack/maxima/stackmaxima.fas")$';
    const loader={...version.files[1],content,...record(content)};
    const compiledStack={schema:1,mode:'entry-fas',stackRevision:version.stackRevision,
      sourceSha256:version.files[0].sha256,originalLoaderSha256:version.files[1].sha256,overlayLoaderSha256:loader.sha256,
      asset:{path:'stackmaxima.fas',fileBytes:binary.length,sha256:hash(binary)}};
    const manifest=Buffer.from(JSON.stringify({schema:1,stackRevision:version.stackRevision,compiledStack,files:[version.files[0],loader]}));
    const path=join(root,version.stackRevision+'.json'),bundlePath=join(root,version.stackRevision+'.fas');
    await writeFile(path,manifest);await writeFile(bundlePath,binary);
    index.pins.push({stackRevision:version.stackRevision,compiledStack,manifest:{path,...record(manifest)},bundlePath});
  }
  const indexPath=join(root,'index.json');await writeFile(indexPath,JSON.stringify(index));
  const inputs=await compiledProbeInputs(indexPath,preparedBytes);
  assert.equal(inputs.size,2);
  for(const pin of pins){const row=inputs.get(pin);assert.equal(row.files.at(-1).encoding,'base64');
    assert.equal(hash(Buffer.from(row.files.at(-1).content,'base64')),row.compiledStack.asset.sha256);}
  assert.equal(JSON.stringify(prepared),preparedBytes.toString(),'Original source controls must remain unchanged');
  const originalBinary=await readFile(index.pins[0].bundlePath);
  await writeFile(index.pins[0].bundlePath,await readFile(index.pins[1].bundlePath));
  await assert.rejects(compiledProbeInputs(indexPath,preparedBytes));
  await writeFile(index.pins[0].bundlePath,originalBinary);
  const originalManifest=await readFile(index.pins[0].manifest.path);
  const altered=JSON.parse(originalManifest);altered.files[1].content+='unreviewed_extra_command$';
  Object.assign(altered.files[1],record(altered.files[1].content));
  const alteredBytes=Buffer.from(JSON.stringify(altered));await writeFile(index.pins[0].manifest.path,alteredBytes);
  const originalRecord={...index.pins[0].manifest};Object.assign(index.pins[0].manifest,record(alteredBytes));
  await writeFile(indexPath,JSON.stringify(index));await assert.rejects(compiledProbeInputs(indexPath,preparedBytes));
  await writeFile(index.pins[0].manifest.path,originalManifest);index.pins[0].manifest=originalRecord;
  index.pins[0].compiledStack.stackRevision=pins[1];
  await writeFile(indexPath,JSON.stringify(index));await assert.rejects(compiledProbeInputs(indexPath,preparedBytes));
  console.log('Compiled probe binding: both pins accepted; swapped bundle, extra loader command and wrong pin rejected');
}finally{await rm(root,{recursive:true,force:true});}
