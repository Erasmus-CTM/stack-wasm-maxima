// SPDX-License-Identifier: AGPL-3.0-or-later
// Summarise page-timings-owned.yml: one column per runtime, medians from
// scripts/measure-native-page-timings.mjs (button click to verdict on the page).
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] || 'test-results/page-timings-owned');
const labels = { 'poc1': 'PoC1 (deployed runtime)', 'v2': 'runtime-v2', 'v3': 'runtime-v3', 'oz-4.0.10': '4.0.10 ecl-oz (trial)',
  'oz-6.0.11': '6.0.11 ecl-oz (trial)', 'trial': (process.env.TRIAL_LABEL || 'Trial build'), 'live': 'Live public page' };
const runtimes = (process.env.RUNTIMES || Object.keys(labels).join(' ')).split(/\s+/).filter(Boolean).map(name => [name, labels[name] || name]);
const rows = [
  ['First Validate click (includes Maxima + STACK start-up)', s => s.native.firstValidation.ui],
  ['…of which Maxima + STACK start-up', s => s.nativeInitialization],
  ['Later Validate', s => s.native.warmValidation.ui],
  ['First Check', s => s.native.firstGrade.ui],
  ['Later Check', s => s.native.warmGrade.ui],
  ['First Python-checked grade (includes Python start-up)', s => s.python.firstGrade.ui],
  ['…of which Python start-up', s => s.pythonInitialization],
  ['Later Python-checked grade', s => s.python.warmGrade.ui],
];
const format = ms => ms == null ? '—' : ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';
const out = [];
for (const [speed, title] of [['full', 'Full speed'], ['quarter', 'Quarter of one CPU (test-machine setting, not a laptop model)']]) {
  const reports = {};
  for (const [name] of runtimes) {
    try { reports[name] = JSON.parse(await readFile(join(root, speed, name, 'summary.json'), 'utf8')); } catch {}
  }
  if (!Object.keys(reports).length) continue;
  const n = Object.values(reports).find(report => report.passed)?.statistics.nativeInitialization.n;
  out.push(`## ${title}: medians of ${n ?? '?'} fresh browser starts`, '',
    `| | ${runtimes.map(([, label]) => label).join(' | ')} |`, `|---|${runtimes.map(() => '---:').join('|')}|`);
  for (const [label, pick] of rows) {
    out.push(`| ${label} | ${runtimes.map(([name]) => {
      const report = reports[name];
      if (!report) return 'not run';
      if (!report.passed) return 'failed';
      let stat;
      try { stat = pick(report.statistics); } catch { return 'not measured'; }
      return `${format(stat.median)} (${format(stat.min)}–${format(stat.max)})`;
    }).join(' | ')} |`);
  }
  for (const [name] of runtimes) if (reports[name] && !reports[name].passed) out.push('', `- ${name} failed: ${String(reports[name].failure?.message).slice(0, 200)}`);
  out.push('');
}
console.log(out.join('\n'));
