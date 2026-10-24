// SPDX-License-Identifier: AGPL-3.0-or-later
// Entry-read evidence is mandatory even when startup failed. Retain a fatal
// runtime cause as the primary error, with entry failures recorded separately.
export function requireCompiledEntryReads(result) {
  const errors = [];
  const opened = path => result.messageTrace?.some(row =>
    row.type === 'm1-fs-open' && row.read === true && row.path === path);
  const root = '/ctm/moodle-qtype_stack-master/stack/maxima/';
  if (!opened(root + 'stackmaxima.fas')) errors.push('Compiled entry was not opened by the real Wasm filesystem');
  if (opened(root + 'stackmaxima.mac')) errors.push('Compiled probe unexpectedly opened the source entry');
  if (errors.length) {
    result.compiledEntryErrors = errors;
    result.ok = false;
    result.error ||= errors[0];
  }
  return result;
}
