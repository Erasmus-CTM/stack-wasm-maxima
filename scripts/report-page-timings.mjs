// SPDX-License-Identifier: AGPL-3.0-or-later
// Summarise page-timings-owned.yml in the layout of the 22 October report:
// one column per runtime, medians from scripts/measure-site-timings.mjs.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] || 'test-results/page-timings-owned');
const runtimes = [['poc1', 'PoC1 (deployed runtime)'], ['oz-4.0.10', 'Own, 4.0.10, ecl-oz'], ['oz-6.0.11', 'Own, 6.0.11, ecl-oz']];
const rows = [
  ['Maxima: first Validate click (includes Python start-up)', 'maxima', 'firstValidationUI'],
  ['Maxima: first Check (includes Maxima + STACK start-up)', 'maxima', 'firstGradeUI'],
  ['Maxima: …of which Maxima + STACK start-up', 'maxima', 'deferredNativeInitialization'],
  ['Maxima: later Check', 'maxima', 'warmGradeUI'],
  ['Maxima: later Validate', 'maxima', 'warmValidationUI'],
  ['SymPy: first Validate click (control)', 'sympy', 'firstValidationUI'],
];
const format = ms => ms == null ? '—' : ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms.toFixed(1) + ' ms';
const out = [];
for (const [speed, title] of [['full', 'Full speed'], ['quarter', 'Quarter of one CPU']]) {
  const reports = {};
  for (const [name] of runtimes) {
    try { reports[name] = JSON.parse(await readFile(join(root, speed, name, 'summary.json'), 'utf8')); } catch {}
  }
  if (!Object.keys(reports).length) continue;
  out.push(`## ${title} (medians)`, '', `| | ${runtimes.map(([, label]) => label).join(' | ')} |`, `|---|${runtimes.map(() => '---:').join('|')}|`);
  for (const [label, backend, key] of rows) {
    out.push(`| ${label} | ${runtimes.map(([name]) => {
      const report = reports[name];
      if (!report) return 'not run';
      if (!report.passed) return 'failed';
      return format(report.statistics?.[backend]?.[key]?.median);
    }).join(' | ')} |`);
  }
  const failures = runtimes.filter(([name]) => reports[name] && !reports[name].passed)
    .map(([name]) => `- ${name}: ${String(reports[name].failure?.message).slice(0, 200)}`);
  out.push('', ...failures, '');
}
console.log(out.join('\n'));
