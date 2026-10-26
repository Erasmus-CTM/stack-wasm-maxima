# SPDX-License-Identifier: AGPL-3.0-or-later
"""Bind each cold rebuild to its current source, recipe and distinct CI identity."""
import hashlib
import json
import re


def digest(body):
    return hashlib.sha256(body).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def current_run_producer_identity(root, consumer):
    """A comparison retry consumes accepted builds from this run's earlier attempts.

    The workflow downloads named artifacts from its own run. Keep that run and
    checkout fixed; only the producer attempt may precede the consumer attempt.
    validate_build subsequently verifies this identity and the complete inventory.
    """
    producer = read_json(root / '.cache/runtime-build/artifact/logs/environment.json')['buildIdentity']
    assert producer['runId'] == consumer['runId'], 'Artifact belongs to another workflow run'
    assert producer['sourceRevision'] == consumer['sourceRevision'], 'Artifact belongs to another checkout'
    for attempt in (producer['runAttempt'], consumer['runAttempt']):
        assert isinstance(attempt, str) and re.fullmatch(r'[1-9][0-9]*', attempt), 'Invalid workflow attempt'
    assert int(producer['runAttempt']) <= int(consumer['runAttempt']), 'Artifact belongs to a future attempt'
    return {key: producer[key] for key in ('runId', 'runAttempt', 'sourceRevision')}


def verify_artifact_files(artifact):
    rows = read_json(artifact / 'artifact-manifest.json')['files']
    paths = {row['path'] for row in rows}
    assert len(paths) == len(rows), 'Duplicate artifact files'
    actual = {p.relative_to(artifact).as_posix() for p in artifact.rglob('*') if p.is_file() and p.name != 'artifact-manifest.json'}
    assert paths == actual, 'Artifact inventory differs from actual delivered files'
    for row in rows:
        path = artifact / row['path']
        assert path.resolve().is_relative_to(artifact.resolve()), 'Escaping artifact path'
        body = path.read_bytes()
        assert type(row['bytes']) is int and len(body) == row['bytes']
        assert digest(body) == row['sha256'], 'Changed artifact file: ' + row['path']


def validate_build(root, label, expected):
    artifact = root / '.cache/runtime-build/artifact'
    verify_artifact_files(artifact)
    body = (artifact / 'manifest.json').read_bytes()
    manifest = json.loads(body)
    assert manifest['sourcePins'] == expected['pins'], 'Stale source pins'
    if 'compilerProfile' in expected:
        from compiler_evidence import verify_packaged
        assert manifest['compilerProfile']==expected['compilerProfile']
        verify_packaged(artifact,expected['compilerProfile'])
        from source_overlay import verify_packaged as verify_overlay
        from pathlib import Path
        integrity = verify_overlay(artifact, Path(__file__).resolve().parents[2])
    assert manifest['configuration'] == expected['configuration'], 'Stale build configuration'
    assert manifest['startupAdapter'] == expected['startupAdapter'], 'Changed startup adapter'
    assert manifest['recipe'] == expected['recipe'], 'Stale or incomplete current recipe'
    recipe_paths = [row['path'] for row in manifest['recipe']['files']]
    assert len(set(recipe_paths)) == len(recipe_paths), 'Duplicate recipe files'
    for row in manifest['recipe']['files']:
        preserved = (artifact / 'recipe' / row['path']).read_bytes()
        assert len(preserved) == row['bytes'] and digest(preserved) == row['sha256']
    source = read_json(artifact / 'source-manifest.json')
    for key in ['sourcePins','recipe','configuration','startupAdapter','upstreamRecipe','toolchain'] + (['sourceIntegrity'] if 'compilerProfile' in expected else []):
        assert source[key] == manifest[key], 'Source-manifest identity differs: ' + key
    if 'compilerProfile' in expected:
        assert source['compilerProfile']==manifest['compilerProfile']
    rows = manifest['runtimeAssets']
    paths = [row['path'] for row in rows]
    assert len(set(paths)) == len(paths), 'Duplicate runtime files'
    assert set(paths) == set(expected['runtimePaths']), 'Incorrect current runtime closure'
    assets = {}
    for row in rows:
        path = artifact / 'runtime' / row['path']
        assert path.resolve().is_relative_to((artifact / 'runtime').resolve())
        runtime = path.read_bytes()
        assert len(runtime) == row['bytes'] and digest(runtime) == row['sha256']
        assets[row['path']] = {'bytes':len(runtime),'sha256':digest(runtime)}
    environment = read_json(artifact / 'logs/environment.json')
    if 'compilerProfile' in expected:
        assert environment['compilerProfile']==expected['compilerProfile']
    identity = {**expected['identity'],'coldBuild':label}
    assert label in ['cold1','cold2'] and environment['buildIdentity'] == identity, 'Duplicated/stale cold-build identity'
    assert re.fullmatch(r'[0-9a-f]{40}', identity['sourceRevision'])
    assert identity['runId'].isdigit() and identity['runAttempt'].isdigit()
    assert environment['coldBuild']['observedGithubHostedRun'] is True
    assert environment['coldBuild']['configuredWorkflowPolicy'] == {'restoreHostCache':False,'restoreSdkCache':False,'useCcache':False}
    assert environment['runnerContext'] == {'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted'}
    assert environment['runnerImage']['ImageVersion']
    acceptance = read_json(root / '.cache/runtime-build/validation/acceptance.json')
    assert acceptance['passed'] is True and acceptance['artifactManifestSha256'] == digest(body)
    assert acceptance['configuration'] == expected['configuration'] and acceptance['environment'] == environment
    if 'compilerProfile' in expected:
        assert acceptance['sourceIntegrity'] == integrity
    return {'name':label,'recipe':manifest['recipe'],'pins':manifest['sourcePins'],
            'configuration':manifest['configuration'],'assets':assets,'environment':environment,'manifestSha256':digest(body),'compilerProfile':manifest.get('compilerProfile')}


def current_expectations(repository, identity):
    from configuration import configuration, startup
    from package import records
    from recipe_inputs import recipe_records
    from compiler_profile import compiler_profile
    config = configuration()
    return {'compilerProfile':compiler_profile(),'pins':read_json(repository / 'runtime/build/pins.json'),'configuration':config,
            'startupAdapter':{'content':startup(config),'sha256':config['startupSha256']},
            'runtimePaths':set(records()) - set(config['omittedRuntimePaths']),
            'recipe':{'repository':'https://github.com/Erasmus-CTM/stack-wasm-maxima','revision':identity['sourceRevision'],'files':recipe_records(repository)},
            'identity':identity}
