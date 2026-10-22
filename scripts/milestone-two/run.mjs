// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as playwright from 'playwright';
import { serveDemo } from './serve.mjs';
import { runPage, compareBackends } from './browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf('--' + name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error('Missing --' + name + ' value');
  return args[at + 1];
}
const site = resolve(option('site', join(root, '.cache/milestone-two/demo/_site')));
const output = resolve(option('output', join(root, 'test-results/milestone-two')));
const reportDirectory = resolve(option('reports', join(root, 'reports/milestone-two')));
const browserName = option('browser', 'chromium');
const repeats = Number(option('repeats', '3'));
const timeout = Number(option('timeout', '330000'));
if (!['chromium', 'firefox', 'webkit'].includes(browserName)) throw new Error('Unknown browser: ' + browserName);
if (!Number.isInteger(repeats) || repeats < 2 || repeats > 20) throw new Error('--repeats must be 2–20');
const manifest = JSON.parse(await readFile(join(root, 'demos/manifest.json')));
const provenance = JSON.parse(await readFile(join(site, 'MATERIALIZATION.json')));
const frozen = JSON.parse(await readFile(join(output, 'frozen-payloads.json')));
if (frozen.pairedPayloadsIdentical !== true || frozen.cards !== manifest.demos.length || frozen.variants !== 27) {
  throw new Error('Collect and verify all paired frozen payloads before running browsers');
}
await mkdir(output, { recursive: true });
await mkdir(reportDirectory, { recursive: true });
const sourceRevision = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceFiles = [
  'scripts/milestone-two/run.mjs', 'scripts/milestone-two/browser.mjs',
  'scripts/milestone-two/serve.mjs', 'scripts/milestone-two/materialize.py',
  'scripts/milestone-two/prepare-runtime.py', 'prototype/backend/worker.js',
  'prototype/backend/native_adapter.py', 'prototype/runtime/maxima-session.js',
  'prototype/runtime/maxima-child.js', 'prototype/quarto/stack-maxima.lua',
  'demos/manifest.json',
];
const files = await Promise.all(sourceFiles.map(async path => {
  const data = await readFile(join(root, path));
  return { path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}));
const runURL = process.env.GITHUB_RUN_ID ? 'https://github.com/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID : null;
const report = { schema: 1, createdAt: new Date().toISOString(), sourceRevision, runURL,
  sourceWorktreeDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim()),
  files, provenance, frozenPayloads: { cards: frozen.cards, variants: frozen.variants,
    hashes: frozen.demos.map(({ demoId, payloadSha256 }) => ({ demoId, payloadSha256 })) },
  browserName, repeats, timeoutMs: timeout, scope: 'Matched CTM Quarto UI; hybrid Maxima answer tests with shared Python validation/PRT/PythonChecker',
  serving: { compression: 'gzip', crossOriginIsolated: true, freshContextPerPage: true,
    note: 'Cold browser cache per page; localhost-prepared assets. This is not a public WAN latency or production bundle benchmark.' },
  pages: [], differences: [], failures: [], passed: false };
let app, browser;
const write = async () => {
  await writeFile(join(output, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
};
try {
  app = await serveDemo({ root: site });
  browser = await playwright[browserName].launch({ headless: true });
  report.browserVersion = browser.version();
  const selectedInputs = new Map();
  for (const backend of ['sympy', 'maxima']) {
    for (const pageName of ['index', 'examples']) {
      const demos = manifest.demos.filter(demo => demo.sourcePage === pageName + '.qmd');
      const result = await runPage({ browser, baseURL: app.baseURL, backend, pageName, demos, selectedInputs, repeats, timeout, output,
        onProgress: text => console.log(new Date().toISOString() + ' ' + text) });
      report.pages.push(result);
      if (result.error) report.failures.push({ backend, page: pageName, ...result.error });
      report.failures.push(...result.failures.map(item => ({ backend, page: pageName, ...item })));
      const networkFailures = result.network.filter(item => item.status >= 400 || item.measurementError || item.failed && !/ERR_ABORTED/.test(item.failed));
      if (networkFailures.length) report.failures.push({ backend, page: pageName, operation: 'network', requests: networkFailures });
      await write();
    }
  }
  const variants = backend => report.pages.filter(page => page.backend === backend).flatMap(page => page.variants);
  const sympy = variants('sympy'), maxima = variants('maxima');
  report.coverage = { expectedCards: manifest.demos.length, expectedVariants: frozen.variants,
    sympyVariants: sympy.length, maximaVariants: maxima.length,
    sympyPythonCheckerCards: new Set(sympy.filter(row => row.pythonChecker).map(row => row.demoId)).size,
    maximaPythonCheckerCards: new Set(maxima.filter(row => row.pythonChecker).map(row => row.demoId)).size };
  if (sympy.length !== frozen.variants || maxima.length !== frozen.variants || report.coverage.maximaPythonCheckerCards !== 6) {
    report.failures.push({ operation: 'coverage', message: 'All 19 cards / 27 variants and six PythonChecker cards must complete' });
  } else {
    try { report.differences = compareBackends(sympy, maxima); }
    catch (error) { report.failures.push({ operation: 'paired-comparison', message: String(error), stack: error.stack }); }
  }
  report.passed = report.failures.length === 0 && report.differences.length === 0;
} catch (error) {
  report.failures.push({ operation: 'launcher', message: String(error), stack: error.stack });
} finally {
  if (browser) await browser.close();
  if (app) { report.serverRequests = app.requests; await app.close(); }
  await write();
}

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), at = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[at] : (sorted[at - 1] + sorted[at]) / 2;
};
const timings = ['sympy', 'maxima'].map(backend => {
  const pages = report.pages.filter(page => page.backend === backend), variants = pages.flatMap(page => page.variants);
  return { backend, pages: pages.length, variants: variants.length,
    workerInitializationMs: pages.map(page => ({ page: page.page, ...page.startup })),
    validationMedianMs: median(variants.map(row => row.validation.elapsedMs)),
    gradeMedianMs: median(variants.flatMap(row => row.gradeCalls.map(call => call.elapsedMs))),
    authoredTestRows: variants.reduce((count, row) => count + row.authoredTests.response.result.results.length, 0),
    encodedResponseBodyBytesByPage: pages.map(page => ({ page: page.page, ...page.networkTotals })) };
});
const summary = { schema: 1, createdAt: report.createdAt, sourceRevision, runURL,
  passed: report.passed, status: report.passed ? 'passed' : report.failures.length ? 'failed' : 'backend differences need review',
  browserName, browserVersion: report.browserVersion, repeats, scope: report.scope, serving: report.serving,
  coverage: report.coverage, timings, failures: report.failures, differences: report.differences,
  sourceFiles: files, rawReport: 'test-results/milestone-two/browser.json' };
await writeFile(join(reportDirectory, 'latest.json'), JSON.stringify(summary, null, 2) + '\n');
const number = value => value === null || value === undefined ? 'not measured' : value.toFixed(1);
const lines = [
  '# Milestone 2: matched Quarto browser experiment', '',
  'Status: **' + summary.status + '**.', '',
  'Source commit: `' + sourceRevision + '`.' + (report.sourceWorktreeDirty ? ' The measured worktree had tracked changes; use the recorded file hashes.' : ''),
  ...(runURL ? ['', 'Workflow evidence: ' + runURL] : []), '',
  'Browser: ' + browserName + ' ' + (report.browserVersion || '(did not launch)') + '.', '',
  'Both backends use the same CTM frontend and frozen payloads. The Maxima edition remains a hybrid: Python performs input validation, PRT orchestration and PythonChecker execution.', '',
  '| Backend | Completed variants | Authored test rows | Median warm validation ms | Median warm grade ms |',
  '|---|---:|---:|---:|---:|',
  ...timings.map(item => '| ' + item.backend + ' | ' + item.variants + ' | ' + item.authoredTestRows + ' | ' + number(item.validationMedianMs) + ' | ' + number(item.gradeMedianMs) + ' |'), '',
  'Initialization (fresh browser cache per page; prepared assets served locally with gzip):', '',
  ...timings.flatMap(item => item.workerInitializationMs.map(page => '- ' + item.backend + '/' + page.page + ': ' + number(page.workerInitMs) + ' ms' + (page.workerInitOK === false ? ' (initialization failed).' : '.'))), '',
  'Transferred response-body bytes per page (browser-observed, including CDN dependencies):', '',
  ...timings.flatMap(item => item.encodedResponseBodyBytesByPage.map(page => '- ' + item.backend + '/' + page.page + ': ' + page.encodedResponseBodyBytes + ' bytes.')), '',
  'These measurements do not establish public WAN startup, production bundling, exam isolation or cancellation safety.', '',
  'Failures: ' + report.failures.length + '. Full structured result differences: ' + report.differences.length + '. The JSON report retains details; differences are not silently treated as equivalent.', '',
  '## Runs needed', '',
  ...(report.passed ? ['- Broader browser coverage and production packaging/reliability remain later milestones.'] : [
    '- Resolve the recorded failures/differences and rerun before declaring this milestone complete.',
    '- Any missing variants, timings or routing evidence remain unverified.',
  ]), '',
];
await writeFile(join(reportDirectory, 'latest.md'), lines.join('\n'));
console.log(JSON.stringify({ status: summary.status, sourceRevision, coverage: report.coverage,
  failures: report.failures.length, differences: report.differences.length, timings }));
if (!report.passed) process.exitCode = 1;
