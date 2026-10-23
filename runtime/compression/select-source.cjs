// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');

// All selection paths, including an explicit run ID, use the same contract.
function validateRun(run, {workflowID, head, branch, repository}) {
  assert.equal(run.workflow_id, workflowID, 'Wrong source workflow');
  assert.equal(run.status, 'completed', 'Source build is incomplete');
  assert.equal(run.conclusion, 'success', 'Source build must succeed as a whole');
  assert.equal(run.head_sha, head, 'Source build is not for the current head');
  assert.equal(run.head_branch, branch, 'Source branch differs');
  assert.equal(run.repository?.full_name, repository, 'Source repository differs');
  assert.equal(run.head_repository?.full_name, repository, 'Fork artifacts are not accepted');
  assert.ok(['pull_request', 'workflow_dispatch'].includes(run.event), 'Unexpected source event');
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, 'Missing run attempt');
  return run;
}

function selectArtifact(artifacts, revision, run) {
  const matches = artifacts.filter(row => row.name === 'owned-runtime-' + revision && !row.expired);
  assert.equal(matches.length, 1, 'Expected one unexpired baseline owned runtime artifact');
  assert.match(matches[0].digest, /^sha256:[0-9a-f]{64}$/, 'Missing artifact digest');
  if (run) {
    const started = Date.parse(run.run_started_at), created = Date.parse(matches[0].created_at);
    assert.ok(Number.isFinite(started) && Number.isFinite(created) && created >= started,
      'Artifact predates the selected run attempt');
  }
  return matches[0];
}

function validateRecipe(raw, commit, run, artifact, profile) {
  assert.deepEqual(raw.compilerProfile, profile, 'Source compiler profile differs');
  assert.equal(raw.recipe.revision, commit.sha, 'Recipe revision differs');
  assert.equal(artifact.name, 'owned-runtime-' + commit.sha, 'Artifact name differs from recipe');
  assert.ok(commit.sha === run.head_sha || (commit.parents.length === 2 &&
    commit.parents[1].sha === run.head_sha), 'Recipe must be the current head or its tested PR merge');
  if (commit.sha !== run.head_sha) assert.equal(run.event, 'pull_request');
  return {revision: commit.sha, parents: commit.parents.map(row => row.sha),
    relationship: commit.sha === run.head_sha ? 'same-commit' : 'tested-pr-merge'};
}
module.exports = {validateRun, selectArtifact, validateRecipe};
