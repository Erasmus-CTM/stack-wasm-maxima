// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser smoke test for the tracked Quarto reviewer page.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveDemo } from '../milestone-two/serve.mjs';

const root = resolve(process.argv[2] || 'site/_site');
const output = resolve(process.argv[3] || 'test-results/reviewer-site');
await mkdir(output, { recursive: true });
const report = { schema: 1, root, cards: 0, crossOriginIsolated: false,
  validation: false, grade: false, errors: [], failedRequests: [], passed: false };
let app, browser;
try {
  app = await serveDemo({ root });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => report.errors.push(String(error)));
  page.on('requestfailed', request => report.failedRequests.push({
    url: request.url(), error: request.failure()?.errorText,
  }));
  const response = await page.goto(new URL('maxima/examples.html', app.baseURL).href,
    { waitUntil: 'load', timeout: 90000 });
  assert.equal(response.status(), 200);
  report.crossOriginIsolated = await page.evaluate(() => self.crossOriginIsolated);
  assert.equal(report.crossOriginIsolated, true);
  report.cards = await page.locator('section.stack-sympy').count();
  assert.equal(report.cards, 18);
  const card = page.locator('section.stack-sympy').first();
  await card.locator('input.stack-answer').fill('(x+5)/(x+4)');
  await card.locator('button.stack-validate').click();
  await card.locator('button.stack-check').waitFor({ state: 'visible', timeout: 300000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('section.stack-sympy button.stack-check');
    return button && !button.disabled;
  }, null, { timeout: 300000 });
  report.validation = true;
  await card.locator('button.stack-check').click();
  await page.waitForFunction(() => {
    const result = document.querySelector('section.stack-sympy .stack-result');
    return result && /correct|score|1(?:\.0+)?\s*\/?\s*1/i.test(result.textContent || '');
  }, null, { timeout: 120000 });
  report.grade = true;
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.failedRequests.filter(row => !/ERR_ABORTED/.test(row.error || '')), []);
  await page.screenshot({ path: output + '/maxima-examples.png', fullPage: false });
  report.passed = true;
} catch (error) {
  report.failure = { message: String(error), stack: error.stack };
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  await writeFile(output + '/smoke.json', JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
