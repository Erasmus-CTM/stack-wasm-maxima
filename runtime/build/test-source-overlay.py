#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Synthetic provenance failure tests; these do not establish collector correctness."""
import copy
import contextlib
import importlib.util
import io
import difflib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile
import textwrap
import unittest
from unittest.mock import patch
import source_overlay as overlay
from source_state import verify
from recipe_inputs import committed_recipe, recipe_records

ROOT = Path(__file__).resolve().parents[2]


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def write(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root, stderr=subprocess.PIPE).decode().strip()


def commit(root):
    git(root, 'add', '.')
    git(root, '-c', 'user.name=Overlay fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic fixture')
    return git(root, 'rev-parse', 'HEAD')


class OverlayEvidence(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ctm-overlay-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'recipe'
        self.work = Path(self.temp.name) / 'build'
        self.root.mkdir()
        git(self.root, 'init', '-q')
        self.original = b'/* Synthetic source; not ECL. */\nGC_push_all(start, end);\n'
        self.derived = self.original.replace(b'GC_push_all(', b'GC_push_all_eager(')
        pins = {'sources': []}
        for name, files in {
            'ecl': {overlay.SOURCE: self.original, 'src/c/other.c': b'unchanged_other_root();\n',
                    'LICENSE': b'Synthetic fixture licence.\n', 'configure': b'generated support\n'},
            'maxima': {'wasm/Makefile': b'original recipe\n', 'wasm/build.lisp': b'(original-builder)\n',
                       'src/maxima.asd': b'(original-asdf)\n', 'src/math.lisp': b'(original-math)\n'}
        }.items():
            source = self.work / 'sources' / name
            source.mkdir(parents=True)
            git(source, 'init', '-q')
            for path, body in files.items():
                write(source / path, body)
            revision = commit(source)
            archive = self.work / 'source-archives' / (name + '.tar')
            archive.parent.mkdir(exist_ok=True)
            git(source, 'archive', '--format=tar', '--prefix=' + name + '/', '--output=' + str(archive), 'HEAD')
            pins['sources'].append({'name': name, 'commit': revision,
                                    'archive': {'format':'git-archive-tar', 'prefix':name + '/', 'sha256':overlay.digest(archive.read_bytes())}})
        self.ecl_revision = next(p['commit'] for p in pins['sources'] if p['name'] == 'ecl')
        self.addCleanup(patch.stopall)
        patch.object(overlay, 'REVISION', self.ecl_revision).start()
        patch.dict(os.environ).start()
        os.environ.pop('GITHUB_SHA', None)
        patch_bytes = ''.join(difflib.unified_diff(self.original.decode().splitlines(keepends=True),
                            self.derived.decode().splitlines(keepends=True),
                            fromfile='a/' + overlay.SOURCE, tofile='b/' + overlay.SOURCE)).encode()
        write(self.root / overlay.PATCH, patch_bytes)
        value = {'schema':1, 'id':'ecl-eager-owned-root-ranges', 'source':'ecl', 'revision':self.ecl_revision,
                 'path':overlay.SOURCE, 'target':'wasm32-unknown-emscripten', 'applyAfter':'verified-original-native-ecl32',
                 'original': {'gitBlob':overlay.blob(self.original), **overlay.record(self.original)},
                 'derived':overlay.record(self.derived), 'patch':{'path':overlay.PATCH, **overlay.record(patch_bytes)}}
        save(self.root / overlay.DESCRIPTOR, value)
        pins['buildPatches'] = [{'descriptor':overlay.DESCRIPTOR, 'sha256':overlay.digest((self.root / overlay.DESCRIPTOR).read_bytes())}]
        save(self.root / 'runtime/build/pins.json', pins)
        save(self.root / 'runtime/build/configuration.json', {'targetSourceOverlaySha256':pins['buildPatches'][0]['sha256']})
        save(self.root / 'runtime/build/recipe-inputs.json', {'schema':1,'directories':['runtime/build'],'files':[]})
        write(self.root / '.gitignore', b'__pycache__/\n')
        for path in ['runtime/build/source_overlay.py', 'runtime/build/source_state.py',
                     'runtime/build/apply-target-overlay.py', 'runtime/build/build.sh']:
            write(self.root / path, (ROOT / path).read_bytes())
        self.revision = commit(self.root)
        self.before = verify(self.root, self.work, 'before')
        # Minimal ELF header, explicitly a synthetic provenance fixture.
        self.host = b'\x7fELF\x01\x01' + b'\0' * 12 + b'\x03\x00' + b'synthetic-native-host'
        write(self.work / overlay.HOST, self.host)
        write((self.work / overlay.HOST).parent.parent / 'lib/libecl.so', b'synthetic native ECL library')
        write(self.work / 'logs/host-ecl.sha256', (overlay.digest(self.host) + '  ' + str(self.work / overlay.HOST) + '\n').encode())

    def apply_and_verify(self):
        proof = overlay.apply(self.root, self.work)
        after = verify(self.root, self.work, 'after', target_overlay=True)
        return proof, after, overlay.integrity(self.root, self.work)

    def package_fixture(self):
        proof, after, integrity = self.apply_and_verify()
        artifact = Path(self.temp.name) / 'artifact'
        for source, target in [('logs','logs'), ('source-archives','sources'), ('build-recipes','build-recipes')]:
            shutil.copytree(self.work / source, artifact / target)
        folder = artifact / 'source-overlays/ecl'
        write(folder / 'descriptor.json', (self.root / overlay.DESCRIPTOR).read_bytes())
        write(folder / 'root-scanner.patch', (self.root / overlay.PATCH).read_bytes())
        write(folder / overlay.SOURCE, self.derived)
        licence = (self.work / 'sources/ecl/LICENSE').read_bytes()
        write(folder / 'LICENSE', licence)
        write(artifact / 'LICENSES/upstream/ecl/LICENSE', licence)
        critical = [r for s in after['sources'] if s['name']=='maxima' for r in s['files'] if r['path'] in overlay.CRITICAL]
        recipe = {'revision':self.revision,'files':recipe_records(self.root)}
        for row in recipe['files']:
            write(artifact / 'recipe' / row['path'], (self.root / row['path']).read_bytes())
        manifest = {'recipe':recipe, 'sourceIntegrity':integrity,
                    'upstreamRecipe': {'path':'wasm/Makefile','sha256':overlay.digest((self.work / 'build-recipes/maxima/wasm/Makefile').read_bytes()),
                      'verifiedInputs':critical,'verifiedFilesUnmodified':True,'patches':[],
                      'scope':'Only the three pinned Maxima build inputs: synthetic fixture'}}
        save(artifact / 'manifest.json', manifest)
        save(artifact / 'source-manifest.json', manifest)
        overlay.verify_packaged(artifact, self.root)
        return artifact

    def test_release_rechecks_accepted_bytes_and_packages_complete_source_offer(self):
        # Synthetic source/runtime/compiler fixtures only; no release or real build.
        workflow_path = '.github/workflows/runtime-release.yml'
        workflow = (ROOT / workflow_path).read_text()
        write(self.root / workflow_path, workflow.encode())
        write(self.root / 'runtime/build/compiler-profiles.json',
              (ROOT / 'runtime/build/compiler-profiles.json').read_bytes())
        save(self.root / 'runtime/build/recipe-inputs.json',
             {'schema':1, 'directories':['runtime/build'], 'files':[workflow_path]})
        self.revision = commit(self.root)
        artifact = self.package_fixture()
        spec = importlib.util.spec_from_file_location('release_compiler_fixture', ROOT / 'runtime/build/test-compiler-evidence.py')
        compiler_fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(compiler_fixture)
        profile = compiler_fixture.profiles()['profiles']['ecl-oz']
        compiler = Path(self.temp.name) / 'compiler'
        compiler.mkdir()
        compiler_fixture.packaged(compiler, profile)
        shutil.copytree(compiler / 'logs', artifact / 'logs', dirs_exist_ok=True)
        binary = b'Synthetic Wasm fixture; never executed.'
        write(artifact / 'runtime/libecl.so', binary)
        for name in ('BUILD-NOTICES.md', 'SITE-NOTICES-context.md', 'sizes.md'):
            write(artifact / name, b'Synthetic fixture notice.\n')
        manifest = overlay.read(artifact / 'manifest.json')
        manifest.update(schema=1, compilerProfile=profile,
                        sourcePins=overlay.read(self.root / 'runtime/build/pins.json'), toolchain={},
                        configuration=overlay.read(self.root / 'runtime/build/configuration.json'), startupAdapter={})
        save(artifact / 'source-manifest.json', manifest)
        manifest['runtimeAssets'] = [{'path':'libecl.so', **overlay.record(binary)}]
        save(artifact / 'manifest.json', manifest)
        target = self.root / 'accepted/.cache/runtime-build'
        shutil.copytree(artifact, target / 'artifact')
        artifact = target / 'artifact'
        write(artifact / 'logs/artifact-manifest.json', b'Ordinary nested fixture evidence.\n')
        acceptance_path = target / 'validation/acceptance.json'
        acceptance = {'passed':True, 'compilerProfile':profile, 'configuration':manifest['configuration'],
                      'artifactManifestSha256':overlay.digest((artifact / 'manifest.json').read_bytes()),
                      'sourceIntegrity':manifest['sourceIntegrity'],
                      'compilerEvidenceSha256':overlay.digest((artifact / 'logs/compiler-experiment.json').read_bytes())}
        save(acceptance_path, acceptance)

        def inventory():
            save(artifact / 'artifact-manifest.json', {'schema':1,'files':[
                {'path':path.relative_to(artifact).as_posix(), **overlay.record(path.read_bytes())}
                for path in sorted(artifact.rglob('*')) if path.is_file() and path != artifact / 'artifact-manifest.json']})

        def step(name):
            marker = '      - name: ' + name + '\n'
            self.assertEqual(workflow.count(marker), 1)
            block = workflow.split(marker, 1)[1].split('\n      - name:', 1)[0]
            return textwrap.dedent(block.split('        run: |\n', 1)[1])

        shell = step('Require the accepted artifact of this profile and commit')
        code = shell.split("python3 - <<'EOF'\n", 1)[1].split('\nEOF', 1)[0]
        environment = {'GITHUB_SHA':self.revision, 'PROFILE':'ecl-oz', 'TAG':'runtime-v1',
                       'GITHUB_SERVER_URL':'https://example.invalid', 'GITHUB_REPOSITORY':'fixture/repository',
                       'GITHUB_RUN_ID':'1'}

        def verify():
            with contextlib.chdir(self.root), patch.dict(os.environ, environment), contextlib.redirect_stdout(io.StringIO()):
                exec(compile(code, workflow_path + ':release-admission', 'exec'), {})

        inventory()
        verify()
        delivery = overlay.read(artifact / 'artifact-manifest.json')
        delivery['files'] = [r for r in delivery['files'] if r['path'] != 'logs/artifact-manifest.json']
        save(artifact / 'artifact-manifest.json', delivery)
        with self.assertRaises(AssertionError): verify()
        inventory()
        # Recompute delivery hashes after tampering: the acceptance-bound runtime
        # manifest and current committed recipe must still reject these mutations.
        for relative, replacement in [
            ('runtime/libecl.so', b'changed executable'),
            ('runtime/extra.fas', b'undeclared executable'),
            ('recipe/' + workflow_path, b'changed preserved release policy'),
            ('source-manifest.json', json.dumps({**overlay.read(artifact / 'source-manifest.json'), 'configuration':{}}).encode()),
            ('unpackaged-evidence.txt', b'an omitted future archive member'),
        ]:
            with self.subTest(recomputed_delivery=relative):
                path = artifact / relative
                original = path.read_bytes() if path.exists() else None
                write(path, replacement)
                inventory()
                with self.assertRaises(AssertionError): verify()
                if original is None: path.unlink()
                else: path.write_bytes(original)
        inventory()
        for field, value in [('passed', False), ('artifactManifestSha256','0'*64),
                             ('compilerEvidenceSha256','0'*64), ('sourceIntegrity',{}),
                             ('compilerProfile',compiler_fixture.profiles()['profiles']['baseline'])]:
            with self.subTest(acceptance=field):
                save(acceptance_path, {**acceptance, field:value})
                with self.assertRaises(AssertionError): verify()
        save(acceptance_path, acceptance)
        environment['GITHUB_SHA'] = '0'*40
        with self.assertRaises(AssertionError): verify()
        environment['GITHUB_SHA'] = self.revision
        verify()
        subprocess.run(['bash', '-e', '-c', step('Package the runtime and the source offer')],
                       cwd=self.root, env={**os.environ, **environment}, check=True, stdout=subprocess.PIPE)
        union = set()
        for name in ('maxima-runtime-v1.tar.gz', 'maxima-runtime-v1-sources.tar.gz'):
            with tarfile.open(self.root / 'release' / name) as archive:
                for row in archive.getmembers():
                    if row.isfile():
                        self.assertNotIn(row.name, union)
                        union.add(row.name)
                        self.assertEqual(archive.extractfile(row).read(), (artifact / row.name).read_bytes())
        self.assertEqual(union, {p.relative_to(artifact).as_posix() for p in artifact.rglob('*') if p.is_file()})
        self.assertIn('source-overlays/ecl/' + overlay.SOURCE, union)
        self.assertIn('logs/target-source-overlay.json', union)
        self.assertIn('logs/artifact-manifest.json', union)
        self.assertIn('recipe/' + workflow_path, union)

    def test_original_host_and_truthful_target_after(self):
        proof, after, integrity = self.apply_and_verify()
        self.assertEqual((self.work / overlay.HOST).read_bytes(), self.host)
        self.assertEqual(proof['recipeRevision'], self.revision)
        self.assertTrue(overlay.read(self.work / 'logs/source-state-host.json')['upstreamUnmodified'])
        self.assertFalse(after['upstreamUnmodified'])
        self.assertFalse(integrity['allVerifiedFilesUnmodified'])
        row = next(r for s in after['sources'] if s['name']=='ecl' for r in s['files'] if r['path']==overlay.SOURCE)
        self.assertEqual(row['gitBlob'], overlay.blob(self.derived))
        self.assertEqual(row['upstreamGitBlob'], overlay.blob(self.original))
        with self.assertRaises(AssertionError):
            verify(self.root, self.work, 'after')
        with self.assertRaises(AssertionError):
            overlay.apply(self.root, self.work)

    def test_descriptor_patch_and_source_tampering_fail(self):
        value = overlay.descriptor(self.root)
        for path in [overlay.DESCRIPTOR, overlay.PATCH]:
            file = self.root / path
            original = file.read_bytes()
            file.write_bytes(original + b'\n')
            with self.assertRaises(AssertionError):
                overlay.descriptor(self.root)
            file.write_bytes(original)
        with self.assertRaises(AssertionError):
            overlay.derive(self.root, self.original + b'\n')
        self.assertEqual(overlay.derive(self.root, self.original), self.derived)
        for path in ['sources/ecl/src/c/other.c', 'sources/maxima/src/math.lisp', 'sources/maxima/wasm/Makefile']:
            file = self.work / path
            original = file.read_bytes()
            file.write_bytes(original + b'tampering\n')
            with self.assertRaises(AssertionError):
                overlay.apply(self.root, self.work)
            self.assertEqual((self.work / 'sources/ecl' / overlay.SOURCE).read_bytes(), self.original)
            file.write_bytes(original)
        self.assertEqual(overlay.descriptor(self.root), value)

    def test_missing_or_changed_native_host_blocks_application(self):
        host = self.work / overlay.HOST
        host.unlink()
        with self.assertRaises(FileNotFoundError):
            overlay.apply(self.root, self.work)
        for body in [self.host + b'changed', b'not-ELF32']:
            host.write_bytes(body)
            with self.assertRaises(AssertionError):
                overlay.apply(self.root, self.work)
        self.assertEqual((self.work / 'sources/ecl' / overlay.SOURCE).read_bytes(), self.original)

    def test_after_requires_application_proof_and_unchanged_host(self):
        source = self.work / 'sources/ecl' / overlay.SOURCE
        source.write_bytes(self.derived)
        with self.assertRaises(FileNotFoundError):
            verify(self.root, self.work, 'after', target_overlay=True)
        source.write_bytes(self.original)
        self.apply_and_verify()
        write(self.work / overlay.HOST, self.host + b'changed-after')
        with self.assertRaises(AssertionError):
            verify(self.root, self.work, 'after', target_overlay=True)
        with self.assertRaises(AssertionError):
            overlay.integrity(self.root, self.work)
        write(self.work / overlay.HOST, self.host)
        write((self.work / overlay.HOST).parent.parent / 'lib/libecl.so', b'changed native library')
        with self.assertRaises(AssertionError):
            verify(self.root, self.work, 'after', target_overlay=True)

    def test_unrelated_source_changes_and_missing_coverage_fail_after(self):
        _, after, _ = self.apply_and_verify()
        value = overlay.descriptor(self.root)
        for change in ('omitted','changed','duplicate','second-overlay'):
            bad = copy.deepcopy(after)
            rows = next(s['files'] for s in bad['sources'] if s['name']=='maxima')
            if change=='omitted': rows.pop()
            if change=='changed': rows[0]['sha256']='0'*64
            if change=='duplicate': rows.append(copy.deepcopy(rows[0]))
            if change=='second-overlay': rows[0]['overlayId']=value['id']
            with self.assertRaises(AssertionError):
                overlay.validate_transition(self.before, bad, value)
        path = self.work / 'sources/ecl/src/c/other.c'
        path.write_bytes(b'tampering after apply')
        with self.assertRaises(AssertionError):
            verify(self.root, self.work, 'after', target_overlay=True)

    def test_native_only_keeps_original_source_contract(self):
        after = verify(self.root, self.work, 'after')
        self.assertTrue(after['upstreamUnmodified'])
        self.assertEqual(after['overlays'], [])
        self.assertFalse((self.work / 'logs/target-source-overlay.json').exists())
        # Existing generated build-support exclusion is unchanged and explicit.
        (self.work / 'sources/ecl/configure').write_bytes(b'generated by bootstrap')
        self.assertTrue(verify(self.root, self.work, 'after')['upstreamUnmodified'])

    def test_committed_recipe_rejects_dirty_or_wrong_head_inputs(self):
        self.assertEqual(committed_recipe(self.root)[0], self.revision)
        untracked = self.root / 'runtime/build/untracked-helper.py'
        untracked.write_bytes(b'unrecorded recipe input')
        with self.assertRaises(AssertionError):
            committed_recipe(self.root)
        untracked.unlink()
        path = self.root / 'runtime/build/source_overlay.py'
        path.write_bytes(path.read_bytes() + b'\n# changed helper\n')
        with self.assertRaises(AssertionError):
            committed_recipe(self.root)
        os.environ['GITHUB_SHA']='a'*40
        with self.assertRaises(AssertionError):
            committed_recipe(self.root)

    def test_package_detects_archive_patch_licence_recipe_and_report_tampering(self):
        artifact = self.package_fixture()
        paths = ['sources/ecl.tar', 'source-overlays/ecl/root-scanner.patch',
                 'source-overlays/ecl/descriptor.json', 'source-overlays/ecl/' + overlay.SOURCE,
                 'source-overlays/ecl/LICENSE', 'recipe/runtime/build/source_overlay.py',
                 'build-recipes/maxima/wasm/Makefile']
        for relative in paths:
            with self.subTest(path=relative):
                path = artifact / relative
                original = path.read_bytes()
                path.write_bytes(original + b'tampered')
                with self.assertRaises(AssertionError):
                    overlay.verify_packaged(artifact, self.root)
                path.write_bytes(original)

    def test_consistently_forged_or_removed_source_rows_fail_archive_binding(self):
        artifact = self.package_fixture()
        for mode in ('removed', 'changed'):
            with self.subTest(mode=mode):
                originals = {}
                for phase in ('before', 'host', 'after'):
                    path = artifact / ('logs/source-state-' + phase + '.json')
                    originals[path] = path.read_bytes()
                    report = json.loads(originals[path])
                    source = next(s for s in report['sources'] if s['name']=='ecl')
                    row = next(r for r in source['files'] if r['path']=='src/c/other.c')
                    if mode=='removed':
                        source['files'].remove(row)
                    else:
                        row.update(gitBlob='a'*40, bytes=20, sha256='b'*64)
                    save(path, report)
                proof_path = artifact / 'logs/target-source-overlay.json'
                originals[proof_path] = proof_path.read_bytes()
                proof = json.loads(originals[proof_path])
                proof['beforeSha256'] = overlay.digest((artifact / 'logs/source-state-before.json').read_bytes())
                proof['hostSourceSha256'] = overlay.digest((artifact / 'logs/source-state-host.json').read_bytes())
                save(proof_path, proof)
                # Recomputing the manifest cannot make forged source rows true.
                with self.assertRaisesRegex(AssertionError, 'pinned ecl archive'):
                    overlay.integrity(self.root, artifact, packaged=True)
                for path, original in originals.items():
                    path.write_bytes(original)
        for relative, field, value in [('manifest.json','sourceIntegrity',{}),
                                       ('logs/target-source-overlay.json','recipeRevision','b'*40),
                                       ('logs/target-source-overlay.json','nativeHost',{'path':overlay.HOST,'format':'ELF32-i386','sha256':'0'*64})]:
            with self.subTest(path=relative, field=field):
                path = artifact / relative
                original = path.read_bytes()
                document = json.loads(original); document[field]=value; save(path, document)
                with self.assertRaises(AssertionError):
                    overlay.verify_packaged(artifact, self.root)
                path.write_bytes(original)


class ReviewedDescriptor(unittest.TestCase):
    def test_exact_descriptor_and_patch_are_bound_to_current_configuration(self):
        value = overlay.descriptor(ROOT)
        self.assertEqual(value['original']['sha256'], 'd7492e257e5dc9a143bb86461686b6f3e030b1d741c93c31ab645a9f74d2f5d7')
        self.assertEqual(value['revision'], 'e4bdb2e5b1e444e1773032a53650773848f4d6cd')


if __name__ == '__main__':
    unittest.main()
