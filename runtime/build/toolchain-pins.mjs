// SPDX-License-Identifier: AGPL-3.0-or-later
// Mirror of toolchain_pins.py for the browser harness; test-toolchain-pins.mjs keeps them equal.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function effectivePins(repository,version=process.env.CTM_EMSDK) {
 const pins=JSON.parse(await readFile(resolve(repository,'runtime/build/pins.json')));
 if(!version)return pins;
 const pinned=pins.sources.find(pin=>pin.name==='emsdk').version;
 if(version===pinned)return pins;
 const experiments=JSON.parse(await readFile(resolve(repository,'runtime/build/toolchains.json'))).experimental;
 const chosen=experiments[version];
 if(!chosen)throw new Error('Unknown Emscripten toolchain: '+version);
 const names=new Set(pins.sources.map(pin=>pin.name));
 if(!Object.keys(chosen.sources).every(name=>names.has(name)))throw new Error('Toolchain overrides an unpinned source');
 const result=structuredClone(pins);
 for(const pin of result.sources)if(chosen.sources[pin.name])Object.assign(pin,chosen.sources[pin.name]);
 result.toolchainArchives=chosen.toolchainArchives;
 result.experimentalToolchain={emsdk:version,replaces:pinned};
 return result;
}
