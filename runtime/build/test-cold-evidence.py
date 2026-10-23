#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Synthetic provenance fixtures, never a claim of compiling or running Wasm."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from cold_evidence import digest, validate_build

ROOT = Path(__file__).resolve().parents[2]


def save(path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value))


class ColdEvidence(unittest.TestCase):
    def fixture(self, root, label='cold1'):
        artifact = root / '.cache/runtime-build/artifact'
        config = {'name':'synthetic-no-plot'}
        adapter = {'content':'synthetic startup','sha256':digest(b'synthetic startup')}
        identity = {'runId':'12345','runAttempt':'1','sourceRevision':'a'*40}
        recipe_body = b'unchanged synthetic orchestration'
        recipe = {'repository':'https://github.com/Erasmus-CTM/stack-wasm-maxima','revision':identity['sourceRevision'],
                  'files':[{'path':'runtime/build/build.sh','bytes':len(recipe_body),'sha256':digest(recipe_body)}]}
        expected = {'pins':{'sources':['synthetic exact pin']},'configuration':config,'startupAdapter':adapter,
                    'recipe':recipe,'runtimePaths':{'core.wasm','math.fas'},'identity':identity}
        rows = []
        for path in sorted(expected['runtimePaths']):
            body = ('synthetic bytes for '+path).encode()
            target = artifact / 'runtime' / path
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(body)
            rows.append({'path':path,'bytes':len(body),'sha256':digest(body)})
        target = artifact / 'recipe/runtime/build/build.sh'
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(recipe_body)
        manifest = {'schema':1,'sourcePins':expected['pins'],'configuration':config,'startupAdapter':adapter,
                    'recipe':recipe,'runtimeAssets':rows,'upstreamRecipe':{'patches':[]},'toolchain':{'synthetic':True}}
        save(artifact / 'manifest.json',manifest)
        save(artifact / 'source-manifest.json',{key:value for key,value in manifest.items() if key!='runtimeAssets'})
        environment = {'buildIdentity':{**identity,'coldBuild':label},'runnerImage':{'ImageVersion':'synthetic-image'},
                       'runnerContext':{'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted'},
                       'coldBuild':{'observedGithubHostedRun':True,'configuredWorkflowPolicy':{'restoreHostCache':False,'restoreSdkCache':False,'useCcache':False}}}
        save(artifact / 'logs/environment.json',environment)
        self.refresh(root)
        return expected

    def refresh(self, root):
        artifact = root / '.cache/runtime-build/artifact'
        paths = sorted(p for p in artifact.rglob('*') if p.is_file() and p.name!='artifact-manifest.json')
        save(artifact / 'artifact-manifest.json',{'schema':1,'files':[{'path':p.relative_to(artifact).as_posix(),'bytes':p.stat().st_size,'sha256':digest(p.read_bytes())} for p in paths]})
        save(root / '.cache/runtime-build/validation/acceptance.json',{'passed':True,'artifactManifestSha256':digest((artifact / 'manifest.json').read_bytes()),
             'configuration':json.loads((artifact / 'manifest.json').read_text())['configuration'],'environment':json.loads((artifact / 'logs/environment.json').read_text())})

    def test_distinct_valid_cold_jobs_and_duplicate_identity(self):
        with tempfile.TemporaryDirectory(dir=self.work) as tmp:
            root = Path(tmp)
            expected = self.fixture(root / 'cold1','cold1')
            self.fixture(root / 'cold2','cold2')
            self.assertEqual(validate_build(root / 'cold1','cold1',expected)['name'],'cold1')
            self.assertEqual(validate_build(root / 'cold2','cold2',expected)['name'],'cold2')
            with self.assertRaises(AssertionError):
                validate_build(root / 'cold1','cold2',expected)

    def test_stale_current_recipe_or_configuration(self):
        for kind in ['recipe','configuration']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.work) as tmp:
                root = Path(tmp); expected = self.fixture(root)
                artifact = root / '.cache/runtime-build/artifact'
                for filename in ['manifest.json','source-manifest.json']:
                    value = json.loads((artifact / filename).read_text())
                    if kind=='recipe':
                        value['recipe']['revision'] = 'b'*40
                    else:
                        value['configuration'] = {'name':'stale plotting configuration'}
                    save(artifact / filename,value)
                self.refresh(root)
                with self.assertRaises(AssertionError):
                    validate_build(root,'cold1',expected)

    def test_tampered_environment_and_wrong_run(self):
        for update_manifest in [False,True]:
            with self.subTest(update_manifest=update_manifest), tempfile.TemporaryDirectory(dir=self.work) as tmp:
                root = Path(tmp); expected = self.fixture(root)
                path = root / '.cache/runtime-build/artifact/logs/environment.json'
                value = json.loads(path.read_text()); value['buildIdentity']['runId'] = '99999'; save(path,value)
                if update_manifest:
                    self.refresh(root)
                with self.assertRaises(AssertionError):
                    validate_build(root,'cold1',expected)

    def test_duplicate_runtime_and_source_manifest_identity(self):
        for kind in ['duplicate-runtime','source-pins']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.work) as tmp:
                root = Path(tmp); expected = self.fixture(root)
                artifact = root / '.cache/runtime-build/artifact'
                path = artifact / ('manifest.json' if kind=='duplicate-runtime' else 'source-manifest.json')
                value = json.loads(path.read_text())
                if kind=='duplicate-runtime':
                    value['runtimeAssets'].append(copy.deepcopy(value['runtimeAssets'][0]))
                else:
                    value['sourcePins'] = {'sources':['wrong source manifest pin']}
                save(path,value); self.refresh(root)
                with self.assertRaises(AssertionError):
                    validate_build(root,'cold1',expected)

    @classmethod
    def setUpClass(cls):
        cls.work = ROOT / '.cache/runtime-build/tests'
        cls.work.mkdir(parents=True,exist_ok=True)


if __name__ == '__main__':
    unittest.main()
