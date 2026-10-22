// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync,brotliCompressSync,brotliDecompressSync,constants} from 'node:zlib';
export const hash=body=>createHash('sha256').update(body).digest('hex');
export const settings=Object.freeze({gzip:{level:9,mtime:0},brotli:{quality:11,mode:'generic'},minimumBytes:256});
export function encode(body){
 const gzip=gzipSync(body,{level:settings.gzip.level});
 assert.equal(gzip.readUInt32LE(4),0,'Deterministic gzip header must have mtime zero');
 const br=brotliCompressSync(body,{params:{[constants.BROTLI_PARAM_QUALITY]:settings.brotli.quality,[constants.BROTLI_PARAM_MODE]:constants.BROTLI_MODE_GENERIC,[constants.BROTLI_PARAM_SIZE_HINT]:body.length}});
 assert.deepEqual(gunzipSync(gzip),body);assert.deepEqual(brotliDecompressSync(br),body);
 return {gzip,br};
}
// Emscripten's pinned lazy-file loader recognizes gzip, not Brotli.
// Modules and share resources can use its synchronous lazy path, so remain gzip.
export const brotliSafe=path=>['maxima.js','maxima.wasm','maxima_thread.js','share_files.js','runtime-preload.json'].includes(path);
export function accepted(header,encoding){
 const entries=String(header||'').toLowerCase().split(',').map(part=>part.trim().split(';').map(x=>x.trim()));
 const entry=entries.find(([name])=>name===encoding)||entries.find(([name])=>name==='*');
 if(!entry)return false;
 const parameter=entry.slice(1).find(p=>p.startsWith('q='));
 const quality=parameter?Number(parameter.slice(2)):1;
 return Number.isFinite(quality)&&quality>0&&quality<=1;
}
