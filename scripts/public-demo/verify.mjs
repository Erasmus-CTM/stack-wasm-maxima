// SPDX-License-Identifier: AGPL-3.0-or-later
// External QA of the published exercises. Reuse the accepted UI harness;
// never substitute locally served pages or grading results for the live site.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { runPage, compareBackends } from '../milestone-two/browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'test-results/public-demo');
const baseURL = new URL(process.env.BASE_URL || 'https://stack-maxima-quarto-comparison.citrus-char-2084.chatgpt.site/');
assert.equal(baseURL.protocol, 'https:', 'Public QA requires the real HTTPS deployment');
assert.ok(!baseURL.username && !baseURL.password && !baseURL.search && !baseURL.hash, 'Use a public site base URL');
if (!baseURL.pathname.endsWith('/')) baseURL.pathname += '/';
const sourceRevision = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const runURL = process.env.GITHUB_RUN_ID ? 'https://github.com/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID : null;
await mkdir(output, { recursive: true });
const report = { schema: 1, createdAt: new Date().toISOString(), sourceRevision, runURL, baseURL: baseURL.href,
  scope: 'Public HTTPS landing and actual matched CTM exercise pages; all accepted cards, variants, authored tests and PythonChecker routes',
  timingScope: 'Public deployment diagnostics after asset preflight and root-only isolation priming in each fresh grading context; not a cold WAN benchmark and independent of accepted localhost milestone-two measurements',
  serving: { publicHTTPS: true, repeats: 3, freshContextPerExercisePage: true },
  probes: [], isolationNavigations: [], priming: [], landing: [], directNavigation: [], publishedPages: [], pages: [], differences: [], failures: [], passed: false };
const save = () => writeFile(join(output, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
let browser;

async function request(path, { method = 'GET', isolation = false, type, expectedHash } = {}) {
  const url = new URL(path, baseURL).href;
  const response = await fetch(url, { method, signal: AbortSignal.timeout(90000) });
  const headers = Object.fromEntries(response.headers.entries());
  const record = { url, method, status: response.status, finalURL: response.url,
    contentType: headers['content-type'], contentLength: headers['content-length'], contentEncoding: headers['content-encoding'],
    coop: headers['cross-origin-opener-policy'], coep: headers['cross-origin-embedder-policy'], corp: headers['cross-origin-resource-policy'] };
  report.probes.push(record);
  assert.equal(response.status, 200, method + ' ' + url + ' must exist');
  assert.equal(new URL(response.url).origin, baseURL.origin, 'Published assets must stay on the selected origin');
  if (type) assert.ok(new RegExp(type, 'i').test(record.contentType || ''), url + ' has the wrong media type');
  if (isolation) {
    // Static hosting may ignore _headers. Record its unmodified HTTP response;
    // only effective browser navigation headers can prove SW isolation.
    record.rawIsolationHeadersPresent = record.coop === 'same-origin' &&
      ['require-corp', 'credentialless'].includes(record.coep);
  }
  if (method === 'HEAD') {
    assert.ok(!/text\/html/i.test(record.contentType || ''), 'A missing runtime file must not return the HTML application fallback');
    return record;
  }
  const body = Buffer.from(await response.arrayBuffer());
  record.decodedBodyBytes = body.length;
  record.sha256 = hash(body);
  if (expectedHash) assert.equal(record.sha256, expectedHash, 'Published bytes differ from accepted source: ' + path);
  return { record, body };
}

function watchPage(page, observation) {
  observation.errors = [];
  observation.networkFailures = [];
  observation.workers = [];
  page.on('pageerror', error => observation.errors.push(String(error)));
  page.on('worker', worker => observation.workers.push(worker.url()));
  page.on('requestfailed', request => observation.networkFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('response', response => {
    if (response.status() >= 400) observation.networkFailures.push({ url: response.url(), status: response.status() });
  });
}

function assertPageHealthy(observation) {
  assert.deepEqual(observation.errors, [], 'The public page must have no uncaught exceptions');
  assert.deepEqual(observation.networkFailures.filter(row => !/ERR_ABORTED/.test(row.error || '')), [], 'The public page must have no failed requests');
}

async function navigateIsolated(page, url, purpose) {
  const record = { purpose, url, startedAt: new Date().toISOString(), navigations: [] };
  report.isolationNavigations.push(record);
  const started = Date.now(), deadline = started + 180000, pending = [];
  const observer = response => {
    const request = response.request();
    if (!request.isNavigationRequest()) return;
    try { if (request.frame() !== page.mainFrame()) return; } catch { return; }
    const navigation = { url: response.url(), status: response.status(), fromServiceWorker: response.fromServiceWorker() };
    record.navigations.push(navigation);
    pending.push(response.allHeaders().then(headers => Object.assign(navigation, {
      coop: headers['cross-origin-opener-policy'], coep: headers['cross-origin-embedder-policy'],
      corp: headers['cross-origin-resource-policy'],
    })));
  };
  page.on('response', observer);
  const navigationInterruption = error => /Execution context was destroyed|Cannot find context|interrupted by another navigation|ERR_ABORTED/.test(String(error));
  try {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }); }
    catch (error) { if (!navigationInterruption(error)) throw error; }
    // The page's own first-visit bootstrap may replace the document once.
    // Retry only navigation-context interruptions, never a missing-isolation
    // timeout or a failed resource. This survives that automatic reload.
    for (;;) {
      const remaining = deadline - Date.now();
      assert.ok(remaining > 0, 'The public isolation bootstrap did not finish');
      try {
        await page.waitForFunction(() => self.crossOriginIsolated && document.readyState === 'complete', null, { timeout: remaining });
        await page.waitForLoadState('load', { timeout: Math.max(1, deadline - Date.now()) });
        record.browser = await page.evaluate(() => ({
          url: location.href, crossOriginIsolated: self.crossOriginIsolated, readyState: document.readyState,
          secureContext: self.isSecureContext, serviceWorkerSupported: 'serviceWorker' in navigator,
          controller: navigator.serviceWorker?.controller?.scriptURL || null,
        }));
        break;
      } catch (error) { if (!navigationInterruption(error)) throw error; }
    }
    await Promise.all(pending);
    assert.equal(record.browser.crossOriginIsolated, true, 'The real browser document must be isolated');
    assert.equal(record.browser.url, url, 'The bootstrap must return to the requested public page');
    const effective = record.navigations.at(-1);
    assert.ok(effective, 'Capture the effective browser navigation response');
    assert.equal(effective.status, 200);
    assert.equal(effective.coop, 'same-origin', 'Effective browser navigation must have COOP same-origin');
    assert.ok(['require-corp', 'credentialless'].includes(effective.coep), 'Effective browser navigation must have an isolation COEP');
    if (effective.fromServiceWorker) assert.ok(record.browser.controller, 'A service-worker navigation must have a real controller');
    record.reloads = Math.max(0, record.navigations.length - 1);
    record.elapsedMs = Date.now() - started;
    return record;
  } catch (error) {
    await Promise.allSettled(pending);
    record.elapsedMs = Date.now() - started;
    record.error = String(error);
    throw error;
  } finally { page.off('response', observer); }
}

function isolationPrimedBrowser(browser) {
  return {
    newContext: async options => {
      const context = await browser.newContext(options);
      const primer = await context.newPage();
      const record = { purpose: 'Root-only isolation setup before the unchanged exercise harness', url: baseURL.href };
      report.priming.push(record);
      watchPage(primer, record);
      try {
        record.isolation = await navigateIsolated(primer, baseURL.href, 'grading-context-primer-' + report.priming.length);
        assertPageHealthy(record);
        assert.deepEqual(record.workers, [], 'Isolation priming must not create any CAS/grading worker');
        record.noCASInitialized = true;
        await primer.close();
        return context;
      } catch (error) {
        record.error = String(error);
        await context.close();
        throw error;
      }
    },
  };
}

async function inspectColdDirectNavigation(browser, manifest) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const record = { path: 'maxima/examples.html', freshContext: true, priorLandingVisit: false };
  report.directNavigation.push(record);
  watchPage(page, record);
  try {
    record.isolation = await navigateIsolated(page, new URL(record.path, baseURL).href, 'cold-direct-maxima-examples');
    await page.waitForFunction(() => document.querySelectorAll('.stack-sympy .stack-reset').length ===
      document.querySelectorAll('.ctm-demo-card').length && document.querySelectorAll('.ctm-demo-card').length > 0);
    record.cards = await page.locator('.ctm-demo-card').evaluateAll(cards => cards.map(card => card.dataset.demoId));
    assert.deepEqual(record.cards, manifest.demos.filter(demo => demo.sourcePage === 'examples.qmd').map(demo => demo.id));
    assertPageHealthy(record);
    assert.deepEqual(record.workers, [], 'Direct navigation alone must not initialize grading runtimes');
    record.screenshot = 'cold-direct-maxima-examples.png';
    await page.screenshot({ path: join(output, record.screenshot), fullPage: false, animations: 'disabled' });
  } catch (error) {
    record.error = { message: String(error), stack: error.stack };
    report.failures.push({ operation: 'cold-direct-navigation', ...record.error });
    await page.screenshot({ path: join(output, 'cold-direct-maxima-examples-failure.png'), fullPage: false }).catch(() => {});
  } finally { await context.close(); }
}

async function inspectLanding(browser) {
  const exerciseLinks = new Set();
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', deviceScaleFactor: 1 });
    const page = await context.newPage();
    const observation = { viewport: name, size: viewport };
    watchPage(page, observation);
    try {
      observation.isolation = await navigateIsolated(page, baseURL.href, 'landing-' + name);
      observation.document = await page.evaluate(async () => {
        if (document.fonts?.ready) await document.fonts.ready;
        const links = [...document.querySelectorAll('a[href]')].map(anchor => ({ href: anchor.href, literal: anchor.getAttribute('href') }));
        return { title: document.title, crossOriginIsolated: self.crossOriginIsolated,
          scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, links,
          missingSections: links.filter(link => link.literal.startsWith('#') && link.literal.length > 1 && !document.getElementById(decodeURIComponent(link.literal.slice(1)))),
          brokenImages: [...document.images].filter(image => !image.complete || !image.naturalWidth).map(image => image.currentSrc || image.src) };
      });
      assert.equal(observation.document.crossOriginIsolated, true, 'The public landing must be isolated too');
      assert.ok(observation.document.scrollWidth <= observation.document.viewportWidth + 2, 'The public landing must fit its viewport');
      assert.deepEqual(observation.document.missingSections, [], 'Landing section links must resolve');
      assert.deepEqual(observation.document.brokenImages, [], 'Landing image assets must load');
      assertPageHealthy(observation);
      for (const link of observation.document.links) {
        const target = new URL(link.href);
        if (target.origin === baseURL.origin) exerciseLinks.add(target.pathname);
      }
      observation.screenshot = 'landing-' + name + '.png';
      await page.screenshot({ path: join(output, observation.screenshot), fullPage: true, animations: 'disabled' });
    } catch (error) {
      observation.error = { message: String(error), stack: error.stack };
      report.failures.push({ operation: 'landing', viewport: name, ...observation.error });
      await page.screenshot({ path: join(output, 'landing-' + name + '-failure.png'), fullPage: true }).catch(() => {});
    } finally { report.landing.push(observation); await context.close(); }
  }
  for (const backend of ['sympy', 'maxima']) {
    assert.ok(exerciseLinks.has(new URL(backend + '/examples.html', baseURL).pathname), 'The landing must link directly to the live ' + backend + ' examples');
  }
}

async function inspectPublishedPayloads(browser, manifest, acceptedRaw) {
  const expectedHashes = new Map(acceptedRaw.frozenPayloads.hashes.map(row => [row.demoId, row.payloadSha256]));
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    for (const backend of ['sympy', 'maxima']) {
      for (const pageName of ['index', 'examples']) {
        const path = backend + '/' + pageName + '.html';
        await request(path, { isolation: true, type: 'text/html' });
        await navigateIsolated(page, new URL(path, baseURL).href, 'payload-preflight-' + backend + '-' + pageName);
        const payloads = await page.locator('.ctm-demo-card').evaluateAll(cards => cards.map(card => ({
          demoId: card.dataset.demoId, source: card.querySelector('script.stack-sympy-data')?.textContent,
        })));
        const expectedDemos = manifest.demos.filter(demo => demo.sourcePage === pageName + '.qmd');
        assert.deepEqual(payloads.map(row => row.demoId), expectedDemos.map(demo => demo.id), 'The live page must contain the exact accepted question cards');
        // Use the collector's Python JSON canonicalization, including its float
        // spelling. Hash the original script text, before JS parses numbers.
        const hashes = JSON.parse(execFileSync('python3', ['-c', [
          'import hashlib,json,sys',
          'rows=json.load(sys.stdin)',
          'result=[dict(demoId=row["demoId"],payloadSha256=hashlib.sha256(json.dumps(json.loads(row["source"]),ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()) for row in rows]',
          'print(json.dumps(result))',
        ].join('\n')], { input: JSON.stringify(payloads), encoding: 'utf8' }));
        for (const row of hashes) assert.equal(row.payloadSha256, expectedHashes.get(row.demoId), 'The published frozen payload must match accepted evidence: ' + row.demoId);
        report.publishedPages.push({ backend, page: pageName, payloads: hashes });
        await save();
      }
    }
  } finally { await context.close(); }
}

try {
  const manifest = JSON.parse(await readFile(join(root, 'demos/manifest.json')));
  const accepted = JSON.parse(await readFile(join(root, 'reports/milestone-two/latest.json')));
  assert.equal(accepted.passed, true, 'The reference milestone-two report must be accepted');
  const acceptedRun = new URL(accepted.runURL).pathname.split('/').at(-1);
  assert.match(acceptedRun, /^\d+$/);
  const acceptedRaw = JSON.parse(await readFile(join(root, 'reports/milestone-two/runs', acceptedRun, 'browser.json')));
  assert.equal(acceptedRaw.sourceRevision, accepted.sourceRevision);
  report.acceptedReference = { sourceRevision: accepted.sourceRevision, runURL: accepted.runURL,
    cards: accepted.coverage.expectedCards, variants: accepted.coverage.expectedVariants,
    authoredRowsPerBackend: 121, runtimeManifestSha256: accepted.runtime.manifestSha256 };
  report.sourceFiles = await Promise.all([
    'scripts/public-demo/verify.mjs', '.github/workflows/public-demo.yml',
    'scripts/milestone-two/browser.mjs', 'demos/manifest.json', 'reports/milestone-two/latest.json',
  ].map(async path => { const bytes = await readFile(join(root, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }; }));
  await request('', { isolation: true, type: 'text/html' });
  const { body: publicationBytes } = await request('PUBLICATION.json', { type: 'application/json' });
  const publication = JSON.parse(publicationBytes);
  assert.equal(publication.accepted_artifact_sha256, 'bee2255220f31b3e4b681cce6baa170c01ee843d36818bd239baddf52b92e7e1', 'The public package must preserve the accepted artifact identity');
  assert.equal(publication.accepted_browser_run, 39721228518);
  assert.equal(publication.accepted_executable_source, accepted.sourceRevision);
  assert.equal(publication.accepted_site_files.length, 275);
  const acceptedFiles = new Map(publication.accepted_site_files.map(file => [file.path, file]));
  const publishedFiles = new Map(publication.files.map(file => [file.path, file]));
  assert.equal(acceptedFiles.size, publication.accepted_site_files.length, 'Accepted file identities must be unique');
  assert.equal(publishedFiles.size, publication.files.length, 'Published file identities must be unique');
  report.publication = { sha256: hash(publicationBytes), acceptedArtifactSha256: publication.accepted_artifact_sha256,
    acceptedSiteFiles: publication.accepted_site_files.length, publishedFiles: publication.files.length,
    publicationChanges: publication.publication_changes };
  for (const path of ['ctm-isolation.js', 'ctm-isolation-worker.js']) {
    const published = publishedFiles.get(path);
    assert.ok(published, 'The root-scope browser isolation bootstrap must be declared: ' + path);
    await request(path, { type: 'javascript', expectedHash: published.sha256 });
  }
  const { body: materializationBytes } = await request('MATERIALIZATION.json', { type: 'application/json' });
  const materialization = JSON.parse(materializationBytes);
  assert.deepEqual(materialization.sourcePins, acceptedRaw.provenance.sourcePins, 'Published CTM source pins must match the accepted site');
  const { body: runtimeBytes } = await request('stack-sources.json', { type: 'application/json', expectedHash: accepted.runtime.manifestSha256 });
  const runtime = JSON.parse(runtimeBytes);
  assert.equal(runtime.stackRevision, accepted.runtime.stackRevision);
  assert.equal(runtime.ctmCheckersRevision, accepted.runtime.ctmCheckersRevision);
  assert.deepEqual(runtime.runtimeAssets, accepted.runtime.runtimeAssets);
  report.runtime = { stackRevision: runtime.stackRevision, ctmCheckersRevision: runtime.ctmCheckersRevision,
    stackLibraryVersion: runtime.stackLibraryVersion, runtimeAssetCount: runtime.runtimeAssets.length,
    stackFileCount: runtime.files.length, manifestSha256: hash(runtimeBytes) };
  for (const [path, sourcePath] of [
    ['backend/worker.js', 'prototype/backend/worker.js'], ['backend/native_adapter.py', 'prototype/backend/native_adapter.py'],
    ['runtime/maxima-session.js', 'prototype/runtime/maxima-session.js'], ['runtime/maxima-child.js', 'prototype/runtime/maxima-child.js'],
  ]) {
    const source = accepted.sourceFiles.find(file => file.path === sourcePath);
    assert.ok(source, 'The accepted report must identify the deployed adapter source');
    assert.equal(acceptedFiles.get(path)?.sha256, source.sha256, 'The accepted artifact must identify the original backend/runtime source');
    assert.equal(publishedFiles.get(path)?.sha256, source.sha256, 'Publication must preserve accepted backend/runtime bytes');
    await request(path, { expectedHash: source.sha256 });
  }
  // Public transfer is diagnostic, not a cold-WAN comparison. Verify actual
  // deployed runtime bytes, as well as both publication manifest identities.
  for (let offset = 0; offset < runtime.runtimeAssets.length; offset += 8) {
    await Promise.all(runtime.runtimeAssets.slice(offset, offset + 8).map(asset => {
      const path = 'maxima-runtime/' + asset.path;
      assert.equal(acceptedFiles.get(path)?.sha256, asset.sha256, 'The accepted artifact must contain the pinned runtime asset');
      assert.equal(publishedFiles.get(path)?.sha256, asset.sha256, 'Publication must preserve the pinned runtime asset');
      return request(path, { expectedHash: asset.sha256, type: asset.path.endsWith('.wasm') ? 'application/wasm' : undefined });
    }));
  }
  browser = await chromium.launch({ headless: true });
  report.browserVersion = browser.version();
  await inspectColdDirectNavigation(browser, manifest);
  await inspectLanding(browser);
  await inspectPublishedPayloads(browser, manifest, acceptedRaw);
  const selectedInputs = new Map(), screenshotKinds = new Set();
  const primedBrowser = isolationPrimedBrowser(browser);
  for (const backend of ['sympy', 'maxima']) {
    for (const pageName of ['index', 'examples']) {
      const result = await runPage({ browser: primedBrowser, baseURL: baseURL.href, backend, pageName,
        demos: manifest.demos.filter(demo => demo.sourcePage === pageName + '.qmd'), selectedInputs, screenshotKinds,
        repeats: 3, timeout: 330000, output, onProgress: text => console.log(new Date().toISOString() + ' public ' + text) });
      report.pages.push(result);
      if (result.error) report.failures.push({ backend, page: pageName, ...result.error });
      report.failures.push(...result.failures.map(failure => ({ backend, page: pageName, ...failure })));
      const failedRequests = result.network.filter(row => row.status >= 400 || row.measurementError || row.failed && !/ERR_ABORTED/.test(row.failed));
      if (failedRequests.length) report.failures.push({ backend, page: pageName, operation: 'network', requests: failedRequests });
      await save();
    }
  }
  const variants = backend => report.pages.filter(page => page.backend === backend).flatMap(page => page.variants);
  const sympy = variants('sympy'), maxima = variants('maxima');
  report.coverage = ['sympy', 'maxima'].map(backend => {
    const rows = variants(backend);
    return { backend, cards: new Set(rows.map(row => row.demoId)).size, variants: rows.length,
      pythonCheckerCards: new Set(rows.filter(row => row.pythonChecker).map(row => row.demoId)).size,
      authoredTestRows: rows.reduce((count, row) => count + row.authoredTests.response.result.results.length, 0),
      validationCalls: rows.length, gradeCalls: rows.reduce((count, row) => count + row.gradeCalls.length, 0) };
  });
  for (const coverage of report.coverage) {
    if (coverage.cards !== 19 || coverage.variants !== 27 || coverage.pythonCheckerCards !== 6 ||
      coverage.authoredTestRows !== 121 || coverage.gradeCalls !== 81) {
      report.failures.push({ operation: 'coverage', ...coverage, message: 'Every accepted card, variant, authored test and repeated grade must complete on the public site' });
    }
  }
  if (sympy.length === 27 && maxima.length === 27) report.differences = compareBackends(sympy, maxima);
  report.screenshots = report.pages.flatMap(page => page.variants.flatMap(row => (row.screenshots || []).map(screenshot =>
    ({ backend: page.backend, page: page.page, demoId: row.demoId, variant: row.variant, seed: row.seed, ...screenshot }))));
  assert.equal(report.screenshots.length, 4, 'Successful scalar and matrix screenshots must exist for both public backends');
  report.passed = report.failures.length === 0 && report.differences.length === 0;
} catch (error) {
  report.failures.push({ operation: 'public-verification', message: String(error), stack: error.stack });
} finally {
  if (browser) await browser.close();
  await save();
}
const summary = { schema: 1, createdAt: report.createdAt, sourceRevision, runURL, baseURL: report.baseURL,
  passed: report.passed, browserVersion: report.browserVersion, acceptedReference: report.acceptedReference,
  runtime: report.runtime, publication: report.publication, coverage: report.coverage, screenshots: report.screenshots,
  directNavigation: report.directNavigation, isolationNavigations: report.isolationNavigations, priming: report.priming,
  landing: report.landing.map(({ viewport, screenshot, error, document }) => ({ viewport, screenshot, error,
    title: document?.title, scrollWidth: document?.scrollWidth, viewportWidth: document?.viewportWidth })),
  failures: report.failures, differences: report.differences,
  sourceFiles: report.sourceFiles, rawReport: 'test-results/public-demo/browser.json' };
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const markdown = [
  '# Public STACK demo verification', '', 'Status: **' + (report.passed ? 'passed' : 'failed') + '**.', '',
  'Site: ' + report.baseURL, '', 'Verification source: `' + sourceRevision + '`.', '',
  ...(runURL ? ['Workflow: ' + runURL, ''] : []),
  'This run verifies the public HTTPS deployment. It preserves the accepted localhost milestone-two report separately.', '',
  'Raw HTTP headers are recorded independently from effective browser navigation headers. The deployment uses a root-scope first-visit service worker to add isolation where static hosting ignores _headers. Cold direct navigation and responsive landing checks include that reload. Each grading context is primed at the root without creating a CAS worker before the unchanged exercise harness runs.', '',
  'Public timings are diagnostic after byte preflight and isolation priming; they are not a cold WAN benchmark.', '',
  '| Backend | Cards | Variants | PythonChecker cards | Authored test rows | Repeated grades |',
  '|---|---:|---:|---:|---:|---:|',
  ...(report.coverage || []).map(row => '| ' + row.backend + ' | ' + row.cards + ' | ' + row.variants + ' | ' + row.pythonCheckerCards + ' | ' + row.authoredTestRows + ' | ' + row.gradeCalls + ' |'), '',
  'Failures: ' + report.failures.length + '. Structured paired-result differences: ' + report.differences.length + '.', '',
  'Raw RPCs, routing events, headers, asset checks, network measurements and desktop/mobile landing plus scalar/matrix screenshots are in the Actions artifact.', '',
  ...report.failures.map(failure => '- ' + failure.operation + ': ' + (failure.message || JSON.stringify(failure))), '',
].join('\n');
await writeFile(join(output, 'summary.md'), markdown);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log(JSON.stringify({ passed: report.passed, baseURL: report.baseURL, coverage: report.coverage,
  failures: report.failures.length, differences: report.differences.length }));
if (!report.passed) process.exitCode = 1;
