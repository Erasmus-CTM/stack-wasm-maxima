// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {effectivePins} from './toolchain-pins.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const python=version=>JSON.parse(execFileSync('python3',['-c','import json,toolchain_pins;print(json.dumps(toolchain_pins.effective_pins()))'],
 {cwd:resolve(repository,'runtime/build'),env:{...process.env,CTM_EMSDK:version}}));
const released=JSON.parse(await readFile(resolve(repository,'runtime/build/pins.json')));
assert.deepEqual(await effectivePins(repository,''),released);
assert.deepEqual(await effectivePins(repository,'4.0.10'),released);
const experiment=await effectivePins(repository,'6.0.11');
assert.deepEqual(experiment,python('6.0.11'));
assert.deepEqual(experiment.experimentalToolchain,{emsdk:'6.0.11',replaces:'4.0.10'});
assert.equal(experiment.sources.find(pin=>pin.name==='emsdk').commit,'dd8e25632640cfc1fb570c7fa4cc374e8a5e5a72');
assert.deepEqual(experiment.sources.filter(pin=>['maxima','ecl'].includes(pin.name)),released.sources.filter(pin=>['maxima','ecl'].includes(pin.name)));
await assert.rejects(effectivePins(repository,'5.0.0'),/Unknown Emscripten toolchain/);
console.log('toolchain pins: JavaScript and Python agree');
