// SPDX-License-Identifier: AGPL-3.0-or-later
// HTTP asset measurements only; this script does not execute either runtime.
import { get } from 'node:https';
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAXIMA = 'https://maxima-on-wasm.pages.dev/';
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/';
const COURSE_ROOTS = ['numpy', 'scipy', 'sympy', 'matplotlib', 'micropip', 'pyodide-http'];
const MAX_BYTES = 128 * 1024 * 1024;
const MAXIMA_CORE = ['maxima.wasm', 'libecl.so', 'maxima.js', 'maxima_thread.js', 'share_files.js'];
const PYODIDE_CORE = ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

function fetchAsset(url) {
  return new Promise((resolveRequest, reject) => {
    const startedAt = new Date().toISOString();
    const request = get(url, { headers: { 'Accept-Encoding': 'br, gzip' } }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`${url}: HTTP ${response.statusCode}; expected 200`));
        return;
      }
      const chunks = [];
      let received = 0;
      response.on('error', reject);
      response.on('data', chunk => {
        received += chunk.length;
        if (received > MAX_BYTES) {
          response.destroy(new Error(`${url}: exceeds measurement size limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          if (!response.complete) throw new Error(`${url}: incomplete HTTP response`);
          const encoded = Buffer.concat(chunks);
          const encoding = response.headers['content-encoding'] || 'identity';
          const body = encoding === 'br' ? brotliDecompressSync(encoded, { maxOutputLength: MAX_BYTES })
            : encoding === 'gzip' ? gunzipSync(encoded, { maxOutputLength: MAX_BYTES })
            : encoding === 'identity' ? encoded
            : (() => { throw new Error(`Unsupported content encoding: ${encoding}`); })();
          resolveRequest({
            body,
            record: {
              url, startedAt, completedAt: new Date().toISOString(), status: response.statusCode,
              contentEncoding: encoding, transferBytes: encoded.length, fileBytes: body.length,
              sha256: createHash('sha256').update(body).digest('hex'),
              headers: Object.fromEntries(['content-type', 'content-length', 'etag', 'last-modified',
                'date', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
                'access-control-allow-origin'].filter(key => response.headers[key] !== undefined)
                .map(key => [key, response.headers[key]])),
            },
          });
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error(`${url}: request timed out`)));
    request.on('error', reject);
  });
}

function closure(packages, roots) {
  const found = new Set();
  function visit(name) {
    if (found.has(name)) return;
    if (!packages[name]) throw new Error(`Unknown Pyodide package: ${name}`);
    found.add(name);
    for (const dependency of packages[name].depends) visit(dependency);
  }
  roots.forEach(visit);
  return [...found].sort();
}


function dylinkNeeded(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
    throw new Error('Linked module is not a WebAssembly binary');
  }
  function uint(state, limit) {
    let value = 0, multiplier = 1;
    for (let i = 0; i < 5; i++) {
      if (state.offset >= limit) throw new Error('Truncated Wasm integer');
      const next = bytes[state.offset++];
      value += (next & 127) * multiplier;
      if (!(next & 128)) return value;
      multiplier *= 128;
    }
    throw new Error('Oversized Wasm integer');
  }
  function string(state, limit) {
    const size = uint(state, limit), end = state.offset + size;
    if (end > limit) throw new Error('Truncated Wasm string');
    const value = bytes.subarray(state.offset, end).toString('utf8');
    state.offset = end;
    return value;
  }
  const state = { offset: 8 };
  while (state.offset < bytes.length) {
    const section = bytes[state.offset++], size = uint(state, bytes.length), end = state.offset + size;
    if (end > bytes.length) throw new Error('Truncated Wasm section');
    if (section === 0 && string(state, end) === 'dylink.0') {
      const found = [];
      while (state.offset < end) {
        const type = bytes[state.offset++], length = uint(state, end), subEnd = state.offset + length;
        if (subEnd > end) throw new Error('Truncated dylink subsection');
        if (type === 2) {
          const count = uint(state, subEnd);
          for (let i = 0; i < count; i++) found.push(string(state, subEnd));
        }
        state.offset = subEnd;
      }
      return found;
    }
    state.offset = end;
  }
  return [];
}

export async function measure() {
  const startedAt = new Date().toISOString();
  const assets = new Map();
  const bodies = new Map();
  async function add(url) {
    if (!assets.has(url)) {
      const { record, body } = await fetchAsset(url);
      assets.set(url, record);
      bodies.set(url, body);
    }
    return assets.get(url);
  }
  let maximaCore = MAXIMA_CORE.map(path => MAXIMA + path);
  const pythonCore = PYODIDE_CORE.map(path => PYODIDE + path);
  await Promise.all([...maximaCore, ...pythonCore].map(add));
  const loader = bodies.get(MAXIMA + 'maxima.js').toString('utf8');
  const worker = bodies.get(MAXIMA + 'maxima_thread.js').toString('utf8');
  const shareIndex = bodies.get(MAXIMA + 'share_files.js').toString('utf8');
  const lock = JSON.parse(bodies.get(PYODIDE + 'pyodide-lock.json').toString('utf8'));
  const optionalPaths = [...worker.matchAll(/FS\.createLazyFile\('\/', '([^']+)'/g)].map(match => match[1]);
  if (!optionalPaths.length || new Set(optionalPaths).size !== optionalPaths.length) {
    throw new Error('Could not identify unique lazy Maxima modules');
  }
  const maximaOptional = optionalPaths.map(path => MAXIMA + path);
  const packageNames = closure(lock.packages, COURSE_ROOTS);
  const packageURLs = packageNames.map(name => PYODIDE + lock.packages[name].file_name);
  await Promise.all([...maximaOptional, ...packageURLs].map(add));
  for (const name of packageNames) {
    const pkg = lock.packages[name];
    const record = assets.get(PYODIDE + pkg.file_name);
    if (record.sha256 !== pkg.sha256) throw new Error(`Pyodide lock hash mismatch: ${name}`);
    record.package = { name, version: pkg.version, dependencies: pkg.depends };
  }

  const dependencyGraph = new Map();
  const pendingModules = [MAXIMA + 'maxima.wasm', ...maximaOptional];
  while (pendingModules.length) {
    const url = pendingModules.shift();
    if (dependencyGraph.has(url)) continue;
    await add(url);
    const dependencies = dylinkNeeded(bodies.get(url)).map(name => {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Unexpected linked-library name: ' + name);
      return MAXIMA + name;
    });
    dependencyGraph.set(url, dependencies);
    pendingModules.push(...dependencies);
  }
  function withLinkedLibraries(urls) {
    const found = new Set();
    function visit(url) {
      if (found.has(url)) return;
      found.add(url);
      for (const dependency of dependencyGraph.get(url) || []) visit(dependency);
    }
    urls.forEach(visit);
    return [...found];
  }
  maximaCore = withLinkedLibraries(maximaCore);
  const allMaximaModules = withLinkedLibraries([...maximaCore, ...maximaOptional]);
  const linkedLibraries = [...new Set([...dependencyGraph.values()].flat())];

  // This is an optional self-hosting estimate, separate from actual transferBytes.
  for (const url of [...maximaOptional, ...linkedLibraries]) {
    assets.get(url).localGzipLevel9Bytes = gzipSync(bodies.get(url), { level: 9 }).length;
  }
  const gradingPackages = closure(lock.packages, ['sympy']).map(name => PYODIDE + lock.packages[name].file_name);
  const groups = {
    maximaCore,
    maximaOptionalModules: maximaOptional,
    maximaCoreAndAllNineOptionalModules: allMaximaModules,
    maximaLinkedLibraries: linkedLibraries,
    maximaCoreAndPlotModule: withLinkedLibraries([...maximaCore, MAXIMA + 'maxima-plot.fas']),
    pyodideCore: pythonCore,
    sympyAndDependencies: gradingPackages,
    pyodideGrading: [...pythonCore, ...gradingPackages],
    pyodideCoursePackages: packageURLs,
    pyodideCourse: [...pythonCore, ...packageURLs],
    coursePlusMaximaCore: [...pythonCore, ...packageURLs, ...maximaCore],
  };
  const totals = Object.fromEntries(Object.entries(groups).map(([name, urls]) => {
    const uniqueURLs = [...new Set(urls)];
    return [name, {
      count: uniqueURLs.length,
      transferBytes: uniqueURLs.reduce((sum, url) => sum + assets.get(url).transferBytes, 0),
      fileBytes: uniqueURLs.reduce((sum, url) => sum + assets.get(url).fileBytes, 0),
    }];
  }));
  return {
    schema: 1, startedAt, completedAt: new Date().toISOString(),
    method: 'HTTPS GET; count encoded response-body bytes, decode HTTP content encoding, hash file bytes; no runtime execution',
    units: { MB: 1000000, MiB: 1048576 },
    scope: 'Selected assets, not a browser network trace or complete STACK grading bundle. File bytes retain ZIP/wheel compression.',
    deployment: {
      maximaBaseURL: MAXIMA, pyodideBaseURL: PYODIDE, pyodideDistributionVersion: '0.28.3',
      pyodideLockInfo: lock.info, coursePackageRoots: COURSE_ROOTS,
      maximaShareDirectory: shareIndex.match(/share\/maxima\/([^/'"]+)/)?.[1] || null,
      maximaConfiguredInitialMemoryBytes: Number(loader.match(/var INITIAL_MEMORY = Module\['INITIAL_MEMORY'\] \|\| (\d+)/)?.[1]) || null,
      maximaWorkerUsesAtomicsWait: worker.includes('Atomics.wait'),
    },
    maximaDylinkDependencies: Object.fromEntries(dependencyGraph),
    assets: [...assets.values()].sort((a, b) => a.url.localeCompare(b.url)), groups, totals,
  };
}

if (typeof process !== 'undefined' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  const result = await measure();
  if (output) {
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ output, totals: result.totals }, null, 2));
  } else console.log(JSON.stringify(result, null, 2));
}

