// SPDX-License-Identifier: AGPL-3.0-or-later
// Replay actual native STACK feedback and adversarial protocol text. These
// checks never invoke a SymPy formatter or manufacture a mathematical verdict.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

const directory = resolve(process.argv[2] || '.cache/m3-feedback');
const bytes = await readFile(resolve(directory,'feedback-messages.json'));
const provenance = JSON.parse(await readFile(resolve(directory,'feedback-provenance.json')));
const catalogue = JSON.parse(bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'),provenance.catalogue.sha256);
assert.equal(catalogue.stackRevision,'33383047af39c204bf4442802a058f8b918b2b1b');
assert.equal(catalogue.sourceFiles[0].sha256,'efbc42e93a186343bba31e00b1abebbb5c58f86c0b74221bcee555d8847c2713');
assert.equal(catalogue.license,'GPL-3.0-or-later');
const self = {NativeFeedbackMessages:catalogue};
vm.runInNewContext(await readFile(new URL('feedback.js',import.meta.url),'utf8'),{self});
const feedback = self.NativeFeedback;
const call = (key,...args) => "stack_trans('" + key + "'" + args.map(arg=>' , !quot!'+arg+'!quot! ').join('') + '); !NEWLINE!';
let checked = 0;
function translated(raw,expected) {
  const result = feedback.describe(raw);
  assert.equal(result.raw,raw);assert.equal(result.translated,true,result.reason);
  if (expected) assert.match(result.html,expected);
  assert.equal(result.html,feedback.format(raw));checked++;
  return result;
}
function unsupported(raw,reason) {
  const result = feedback.describe(raw);
  assert.equal(result.raw,raw);assert.equal(result.translated,false);
  assert.match(result.html,/Native STACK feedback \(untranslated\): <code>/);
  assert.equal(result.text,'Native STACK feedback (untranslated): '+raw);
  if (reason) assert.match(result.reason,reason);
  assert.doesNotMatch(result.html,/<script|<img/i);
  checked++;return result;
}

translated('',undefined);
translated(call('ATNumDecPlaces_Wrong_DPs'),/Your answer has been given to the wrong number of decimal places\./);
const length = translated(call('ATList_wronglen','\\(2\\)','\\(3\\)'),/Your list should have \\\(2\\\) elements, but it actually has \\\(3\\\)/);
assert.equal(length.text,'Your list should have \\(2\\) elements, but it actually has \\(3\\). ');
translated(call('ATMatrix_wrongsz','\\(1\\)','\\(2\\)','\\(1\\)','\\(1\\)'),/matrix should be/);
const set = translated(call('ATSets_wrongentries','\\[\\left \\{4 \\right \\}\\]') +
  call('ATSets_missingentries','\\[\\left \\{3 \\right \\}\\]'),/<br>The following are missing from your set/);
assert.equal(set.keys.join(','),'ATSets_wrongentries,ATSets_missingentries');
assert.match(set.text,/\nThe following are missing/);
translated(call('ATLowestTerms_wrong',''),/cancel fractions/);
translated(call('ATAlgEquiv_SA_not_function'),/<tt>:=<\/tt>/);
translated(call('ATSingleFrac_part'),/\\over\{b\}/);
translated(call('irred_Q_optional_fac','\\(x^2-1\\)'),/you don&#39;t need to/);
assert.equal(translated(call('ATSingleFrac_true')).html,'');
translated(call('ATList_wrongentries','\\[\\left[\\begin{array}{cc}1 & 2\\end{array}\\right]\\]'),/1 &amp; 2/);

// Substitution values remain inert text, even when they contain HTML, quote
// delimiters, or more apparent protocol. Nothing inside an argument executes.
const injection = '<img src=x onerror="throw 1"><script>throw 2</script>';
const escaped = translated(call('Subst',injection),/&lt;img/);
assert.doesNotMatch(escaped.html,/<img|<script/);
assert.equal(escaped.text,'Your answer would be correct if you used the following substitution of variables. '+injection+' ');
translated(call('Subst',"\\(x\\) stack_trans('ATSets_duplicates');"),/stack_trans\(&#39;ATSets_duplicates&#39;\)/);
unsupported("stack_trans('not_a_known_key'); !NEWLINE!",/unknown translation key/);
unsupported('  \n',/empty protocol/);
unsupported("stack_trans('constructor'); !NEWLINE!",/unknown translation key/);
unsupported("stack_trans('ATSets_duplicates'); !NEWLINE!<script>throw 1</script>",/syntax/);
unsupported("stack_trans('ATSets_duplicates'); globalThis.hacked=true; !NEWLINE!",/syntax/);
unsupported("stack_trans('ATSets_duplicates')",/syntax/);
unsupported("stack_trans(\"ATSets_duplicates\"); !NEWLINE!",/syntax/);
unsupported(call('ATList_wronglen','\\(2\\)'),/missing translation argument/);
unsupported(call('ATSets_duplicates','unexpected'),/unused translation argument/);
unsupported(call('Subst','\\href{javascript:alert(1)}{click}'),/unsupported display command/);
unsupported(call('Subst','\\require{html}\\htmlClass{active}{x}'),/unsupported display command/);
unsupported(call('Subst','\\def\\x{1}'),/unsupported display command/);
unsupported(call('Subst','\\begin{html}<script>throw 1</script>\\end{html}'),/unsupported display command/);
unsupported(call('Subst','\\begin{equation}x\\end{equation}'),/unsupported display command/);
unsupported(call('Subst','a\u0000b'),/unsupported display command/);
unsupported(call('Subst','unterminated!quot!text'),/syntax/);
unsupported(call('Subst',...Array(9).fill('')),/argument limit/);
unsupported(call('ATSets_duplicates').repeat(129),/call limit/);
unsupported('x'.repeat(131073),/length limit/);
assert.throws(()=>feedback.format({toString(){throw new Error('must not stringify');}}),/must be a string/);checked++;

// Every selected pinned literal can be rendered with the argument count
// declared by its own placeholders; this also catches PHP escape damage.
for (const [key,template] of Object.entries(catalogue.messages)) {
  const indices = [...template.matchAll(/\{\$a->m([0-7])\}/g)].map(match=>Number(match[1]));
  const count = indices.length ? Math.max(...indices)+1 : 0;
  translated(call(key,...Array.from({length:count},(_,index)=>'\\('+index+'\\)')));
}

// These exact payloads were produced by real Wasm STACK in the merged M2
// browser benchmark. Replay all of them, including nested list/set/matrix
// TeX and concatenated translation calls, without reconstructing the values.
const reportPath = resolve('reports/milestone-two/runs/39753393394/browser.json');
const report = JSON.parse(await readFile(reportPath));
const native = new Set();
function collect(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.nativeFeedback === 'string' && value.nativeFeedback) native.add(value.nativeFeedback);
  for (const item of Object.values(value)) collect(item);
}
collect(report);
assert.equal(native.size,18,'Keep the full real native feedback corpus');
for (const raw of native) translated(raw);
assert(native.has(call('ATNumDecPlaces_Wrong_DPs')));
assert([...native].some(raw=>raw.includes("'ATList_wrongentries'")));
assert([...native].some(raw=>raw.includes("'ATSets_wrongentries'")));
assert([...native].some(raw=>raw.includes("'ATMatrix_wrongentries'")));

const missing = {NativeFeedbackMessages:null};
vm.runInNewContext(await readFile(new URL('feedback.js',import.meta.url),'utf8'),{self:missing});
const unavailable = missing.NativeFeedback.describe(call('ATSets_duplicates'));
assert.equal(unavailable.translated,false);assert.match(unavailable.reason,/missing pinned/);checked++;
console.log(JSON.stringify({checks:checked,realNativeFeedbackPayloads:native.size,pinnedMessages:Object.keys(catalogue.messages).length}));
