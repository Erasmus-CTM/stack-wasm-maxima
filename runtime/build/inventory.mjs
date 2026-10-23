// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function expectedRuntimePaths(repository){
 const read=async path=>JSON.parse(await readFile(resolve(repository,path),'utf8'));
 const inventory=await read('measurements/2026-10-21-runtime-assets.json');
 const linked=await read('measurements/2026-10-21-runtime-dependencies.json');
 const extra=await read('measurements/2026-10-22-demo-runtime-dependencies.json');
 const observed=await read('reports/milestone-one/browser-3338304.json');
 const config=await read('runtime/build/configuration.json');
 const base='https://maxima-on-wasm.pages.dev/';
 const urls=[...inventory.groups.maximaCore,...inventory.groups.maximaOptionalModules,...linked.assets.map(a=>a.url),...extra.assets.map(a=>a.url),...observed.servedAssets.map(a=>a.url)];
 if(!urls.every(url=>url.startsWith(base)))throw new Error('Unexpected inventory origin');
 return new Set(urls.map(url=>url.slice(base.length)).filter(path=>!config.omittedRuntimePaths.includes(path)));
}
