// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const {validateRun, selectArtifact, validateRecipe} = require('./select-source.cjs');
const head = 'a'.repeat(40), revision = 'b'.repeat(40);
const expected = {workflowID: 123, head, branch: 'feature', repository: 'owner/repo'};
const run = {workflow_id:123, head_sha:head, head_branch:'feature', status:'completed',
  conclusion:'success', event:'pull_request', run_attempt:1,
  repository:{full_name:'owner/repo'}, head_repository:{full_name:'owner/repo'}};
validateRun(run, expected);
for (const change of [{workflow_id:456},{head_sha:'c'.repeat(40)}, {head_branch:'old'},
  {status:'in_progress'}, {conclusion:'failure'}, {event:'push'}, {run_attempt:0},
  {repository:{full_name:'wrong/repo'}}, {head_repository:{full_name:'fork/repo'}}]) {
  assert.throws(() => validateRun({...run, ...change}, expected));
}
const artifact = {name:'owned-runtime-'+revision, expired:false, digest:'sha256:'+'d'.repeat(64)};
assert.equal(selectArtifact([artifact, {...artifact,name:'owned-runtime-ecl-oz-'+revision}], revision), artifact);
assert.throws(() => selectArtifact([{...artifact,created_at:'2026-10-23T10:00:00Z'}], revision,
  {run_started_at:'2026-10-23T11:00:00Z'}));
selectArtifact([{...artifact,created_at:'2026-10-23T11:01:00Z'}], revision,
  {run_started_at:'2026-10-23T11:00:00Z'});
for (const rows of [[], [{...artifact,expired:true}], [artifact,artifact],
  [{...artifact,name:'owned-runtime-'+head}], [{...artifact,digest:undefined}]]) {
  assert.throws(() => selectArtifact(rows, revision));
}
const profile = {id:'baseline'}, raw = {compilerProfile:profile, recipe:{revision}};
const commit = {sha:revision, parents:[{sha:'e'.repeat(40)}, {sha:head}]};
validateRecipe(raw, commit, run, artifact, profile);
validateRecipe({...raw,recipe:{revision:head}}, {sha:head,parents:[]}, run,
  {...artifact,name:'owned-runtime-'+head}, profile);
for (const [r,c,s,a,p] of [
  [{...raw,compilerProfile:undefined},commit,run,artifact,profile],
  [raw,{...commit,parents:[{sha:head},{sha:'e'.repeat(40)}]},run,artifact,profile],
  [raw,commit,{...run,event:'workflow_dispatch'},artifact,profile],
  [raw,commit,run,{...artifact,name:'owned-runtime-'+head},profile],
  [raw,commit,run,artifact,{id:'ecl-oz'}]]) assert.throws(() => validateRecipe(r,c,s,a,p));
console.log('Current-head run, baseline artifact, compiler profile and merge provenance rejection checks passed');
