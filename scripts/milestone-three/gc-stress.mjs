// SPDX-License-Identifier: AGPL-3.0-or-later
// Replay captured native CAS programs on the built Wasm runtime while Boehm
// GC collects far more often (GC_FREE_SPACE_DIVISOR). A pointer the collector
// cannot see then becomes a frequent use-after-free instead of a rare one.
// Before the complete GC pass list, the exact [1,1] validation failed here in
// about 1.4% of iterations. Diagnostic copy only: shipped files are unchanged.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';
import {serveDemo} from '../milestone-two/serve.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
  index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[index + 1]]], []));
const site = resolve(args.site || 'site/_site');
const output = resolve(args.output || 'test-results/milestone-three/gc-stress.json');
const divisor = String(args.divisor || 1000);
const iterations = Number(args.iterations || 400), rounds = Number(args.rounds || 1);
const root = resolve('.cache/gc-stress');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const captureBytes = await readFile(args['browser-report'] || 'test-results/milestone-three/browser.json');
const capture = JSON.parse(captureBytes), captured = capture.programs;
if (process.env.GITHUB_SHA) assert.equal(capture.sourceRevision, process.env.GITHUB_SHA, 'Captured programs belong to another commit');
const manifestBytes = await readFile(join(site, 'stack-sources.json')), manifest = JSON.parse(manifestBytes);
assert.equal(digest(manifestBytes), capture.runtime.manifestSha256, 'Stress site differs from the captured controller');
assert.ok(manifest.runtimeBuild?.manifestSha256, 'Missing owned runtime identity');
for (const asset of [...manifest.runtimeAssets, ...(manifest.compiledStack ? [manifest.compiledStack.asset] : [])]) {
  const bytes = await readFile(join(site, 'maxima-runtime', asset.path));
  assert.equal(bytes.length, asset.fileBytes, asset.path);
  assert.equal(digest(bytes), asset.sha256, asset.path);
}
assert.ok(Array.isArray(captured) && captured.length > 0, 'Missing captured native programs');
const target = captured.filter(row => row.operation === 'validate' && row.question === 'A graphical PythonChecker' &&
  row.expression.includes('_ctm_s:eval_string("[1,1]")') && row.expression.includes('_ctm_t:eval_string("[2,2]")'));
assert.ok(target.length > 0, 'Missing the exact [1,1] against [2,2] validation program');

await rm(root, {recursive: true, force: true});
await mkdir(join(root, 'runtime'), {recursive: true});
await cp(join(site, 'maxima-runtime'), join(root, 'maxima-runtime'), {recursive: true});
await cp(join(site, 'stack-sources.json'), join(root, 'stack-sources.json'));
await cp(join(site, 'runtime/maxima-session.js'), join(root, 'runtime/maxima-session.js'));
const child = await readFile(join(site, 'runtime/maxima-child.js'), 'utf8');
const anchor = '    Module.preRun.push(function () {\n';
assert.equal(child.split(anchor).length, 2, 'The child startup hook changed');
await writeFile(join(root, 'runtime/maxima-child.js'),
  child.replace(anchor, anchor + '      Object.assign(ENV, {GC_FREE_SPACE_DIVISOR: ' + JSON.stringify(divisor) + '});\n'));
await writeFile(join(root, 'index.html'), '<!doctype html><title>GC stress</title>');
await writeFile(join(root, 'gc-stress-worker.js'), `importScripts('runtime/maxima-session.js');
self.onmessage = async ({data}) => {
  const session = new MaximaSession({baseURL:'./maxima-runtime/', stackSourceURL:'./stack-sources.json', callTimeoutMs:120000});
  const report = {ok:true, deviations:[]};
  const run = (phase, index, row) => {
    let result, error = null;
    try { result = session.evaluate(row.expression); } catch (failure) { error = String(failure); }
    if (error || JSON.stringify(result) !== JSON.stringify(row.result)) {
      report.deviations.push({phase, index, question:row.question, operation:row.operation, error,
        result:error ? null : JSON.stringify(result).slice(0, 4000)});
      if (error) throw new Error('Session failed during ' + phase + ' ' + index + ': ' + error);
    }
  };
  try {
    report.initialization = await session.init();
    session.write(':lisp (defun maxima::$ctm_gc_stats () (cons (quote (maxima::mlist)) (multiple-value-list (si::gc-stats t))))\\n', 60000);
    session.write(':lisp (si::gc-stats t)\\n', 60000);
    const started = performance.now();
    for (let i = 0; i < data.iterations; i++) for (const row of data.target) run('target', i, row);
    report.targetMs = performance.now() - started;
    for (let round = 0; round < data.rounds; round++) data.captured.forEach((row, index) => run('replay-' + round, index, row));
    report.totalMs = performance.now() - started;
    report.gcStats = session.evaluate('ctm_gc_stats()');
  } catch (error) { report.ok = false; report.error = String(error && error.stack || error); }
  finally { session.terminate(); }
  self.postMessage(report);
};`);

const app = await serveDemo({root, compression: 'gzip'});
let browser, report;
try {
  browser = await chromium.launch({headless: true});
  const page = await browser.newPage();
  await page.goto(app.baseURL);
  const result = await page.evaluate(data => new Promise(done => {
    const worker = new Worker('gc-stress-worker.js');
    worker.onmessage = ({data}) => { worker.terminate(); done(data); };
    worker.onerror = event => done({ok:false, error:event.message, deviations:[]});
    worker.postMessage(data);
  }), {target, captured, iterations, rounds});
  report = {schema: 1, diagnosticOnly: true, sourceRevision:capture.sourceRevision,
    browserReportSha256:digest(captureBytes), stackManifestSha256:digest(manifestBytes),
    runtimeManifestSha256:manifest.runtimeBuild.manifestSha256, stackRevision:manifest.stackRevision,
    divisor: Number(divisor), iterations, rounds,
    targetPrograms: target.length, replayPrograms: captured.length, ...result,
    scope: 'Exact captured programs and results, one fresh worker with GC_FREE_SPACE_DIVISOR set before ECL starts. ' +
      'A deviation is a wrong CAS result under frequent collection. Passing bounds, but cannot exclude, rarer root faults.'};
} finally {
  if (browser) await browser.close();
  await app.close();
}
await mkdir(resolve(output, '..'), {recursive: true});
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ok: report.ok, deviations: report.deviations.length, gcStats: report.gcStats,
  targetMs: Math.round(report.targetMs || 0), totalMs: Math.round(report.totalMs || 0), error: report.error}));
assert.equal(report.ok, true, report.error);
assert.deepEqual(report.deviations, [], 'Captured CAS results changed under frequent garbage collection');
assert.ok(Array.isArray(report.gcStats) && report.gcStats[1] >= iterations,
  'GC stress must collect at least once per target iteration');
