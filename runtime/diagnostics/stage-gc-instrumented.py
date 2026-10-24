#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Stage one explicitly diagnostic libecl replacement; never admit a build."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from target_info import compare as compare_target_info

ROOT = Path(__file__).resolve().parents[2]
PIN = 'e4bdb2e5b1e444e1773032a53650773848f4d6cd'
MANIFEST = 'ebe109fcd21ddaf79f6d73562a8ce047f08e5430ffee8af63c0234faefbd037a'
MODULE = 'fafd807fcb5f68a01135694421b1bb5006476de078aeba0c7c8fdfe7dec9aee6'
SOURCE_FILES = {'src/bdwgc/mark.c', 'src/bdwgc/mark_rts.c', 'src/c/alloc_2.d'}
FROZEN_TARGET = {'bytes': 259333,
                 'sha256': '03ff4b16dcca2c0ff11c8feab748602c8673d4a736d7b84d203b428a57f909ff'}


def sha(body):
    return hashlib.sha256(body).hexdigest()


def record(body):
    return {'bytes': len(body), 'sha256': sha(body)}


def contained(path):
    path = path.resolve()
    assert path.is_relative_to(ROOT), 'Diagnostic path escapes checkout'
    return path


def interface(path):
    # Compilation alone runs no module initialization or artifact code.
    code = """const fs=require('node:fs');
const m=new WebAssembly.Module(fs.readFileSync(process.argv[1]));
process.stdout.write(JSON.stringify({imports:WebAssembly.Module.imports(m),
exports:WebAssembly.Module.exports(m)}));"""
    return json.loads(subprocess.check_output(['node', '-e', code, str(path)], timeout=120))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--frozen-root', type=Path, required=True)
    parser.add_argument('--new-module', type=Path, required=True)
    parser.add_argument('--target-info', type=Path, required=True)
    parser.add_argument('--source-ecl', type=Path, required=True)
    parser.add_argument('--patch-report', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    frozen, module, target, source, patch_path, output = map(contained, [
        args.frozen_root, args.new_module, args.target_info, args.source_ecl,
        args.patch_report, args.output])
    assert not output.exists() and not output.is_relative_to(frozen)
    assert subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() == PIN
    changed = set(subprocess.check_output(['git', '-C', str(source), 'diff', '--name-only'], text=True).splitlines())
    assert changed == SOURCE_FILES, 'Unexpected source changes in diagnostic ECL'
    patch_bytes = patch_path.read_bytes()
    patch = json.loads(patch_bytes)
    assert patch['diagnosticOnly'] is True and patch['acceptance'] is False
    assert patch['productionAdmission'] is False and patch['sourcePin'] == PIN
    assert patch['applied'] is True
    assert {row['path'] for row in patch['files']} == SOURCE_FILES
    for row in patch['files']:
        original = subprocess.check_output(['git', '-C', str(source), 'show', PIN + ':' + row['path']])
        assert record(original) == row['original']
        assert record((source / row['path']).read_bytes()) == row['derived']
    original_target = (frozen / 'logs/target-info.lsp').read_bytes()
    instrumented_target = target.read_bytes()
    assert record(original_target) == FROZEN_TARGET, 'Frozen target-info changed'
    target_comparison = compare_target_info(original_target, instrumented_target)
    original_manifest = (frozen / 'manifest.json').read_bytes()
    assert sha(original_manifest) == MANIFEST
    manifest = json.loads(original_manifest)
    assert manifest['compilerProfile']['name'] == 'baseline'
    assert manifest['sourcePins'] == json.loads((ROOT / 'runtime/build/pins.json').read_text())
    assert manifest['configuration'] == json.loads((ROOT / 'runtime/build/configuration.json').read_text())
    assets = manifest['runtimeAssets']
    assert len(assets) == len({row['path'] for row in assets}) == 79
    runtime = (frozen / 'runtime').resolve()
    for row in assets:
        path = runtime / row['path']
        assert path.resolve().is_relative_to(runtime) and not path.is_symlink()
        assert record(path.read_bytes()) == {'bytes': row['bytes'], 'sha256': row['sha256']}
    original_module = runtime / 'libecl.so'
    assert sha(original_module.read_bytes()) == MODULE
    new_bytes = module.read_bytes()
    assert new_bytes[:8] == b'\0asm\x01\0\0\0' and sha(new_bytes) != MODULE
    old_interface, new_interface = interface(original_module), interface(module)
    assert old_interface['imports'] == new_interface['imports'], 'Diagnostic module import interface changed'
    old_exports = {row['name']: row['kind'] for row in old_interface['exports']}
    new_exports = {row['name']: row['kind'] for row in new_interface['exports']}
    assert all(new_exports.get(name) == kind for name, kind in old_exports.items()), 'Existing export interface changed'
    extra_exports = sorted(set(new_exports) - set(old_exports))
    assert all('ctm' in name.lower() for name in extra_exports), 'Undeclared new diagnostic export'
    output.mkdir(parents=True)
    rows = []
    for row in assets:
        destination = output / 'runtime' / row['path']
        destination.parent.mkdir(parents=True, exist_ok=True)
        body = new_bytes if row['path'] == 'libecl.so' else (runtime / row['path']).read_bytes()
        destination.write_bytes(body)
        actual = record(body)
        assert row['path'] == 'libecl.so' or actual == {'bytes': row['bytes'], 'sha256': row['sha256']}
        replacement = {**row, **actual}
        if 'differenceBytes' in replacement:
            replacement['differenceBytes'] = len(body) - replacement['deployedBytes']
        rows.append(replacement)
    proof = {'schema': 1, 'kind': 'frozen-gc-instrumentation-mix',
             'diagnosticOnly': True, 'acceptance': False, 'productionAdmission': False,
             'sourcePin': PIN, 'parentArtifact': 12546163663,
             'parentArchiveSha256': 'bcefb37577cbe56d30086551d1192198be6427eac1206e5784074899c2ea2647',
             'parentManifest': record(original_manifest), 'sourcePatchReport': record(patch_bytes),
             'originalModule': record(original_module.read_bytes()), 'instrumentedModule': record(new_bytes),
             'onlyChangedRuntimeAsset': 'libecl.so', 'targetInfoMatches': True,
             'targetInfoComparison': target_comparison,
             'moduleInterfaceShapeMatches': True, 'extraDiagnosticExports': extra_exports,
             'interfaceScope': 'Import/export names and kinds only; not a full binary ABI or production admission proof',
             'originalInterface': old_interface, 'instrumentedInterface': new_interface,
             'runtimeAssets': rows}
    derived = {**manifest, 'runtimeAssets': rows, 'diagnosticOnly': True,
               'acceptance': False, 'productionAdmission': False,
               'scope': 'Instrumented collector mixed with frozen baseline assets; diagnostic only',
               'diagnosticParentManifestSha256': MANIFEST,
               'diagnosticOnlyChangedRuntimeAsset': 'libecl.so'}
    (output / 'original-manifest.json').write_bytes(original_manifest)
    (output / 'manifest.json').write_text(json.dumps(derived, indent=2) + '\n')
    (output / 'instrumentation.json').write_bytes(patch_bytes)
    (output / 'original-target-info.lsp').write_bytes(original_target)
    (output / 'instrumented-target-info.lsp').write_bytes(instrumented_target)
    (output / 'diagnostic-provenance.json').write_text(json.dumps(proof, indent=2) + '\n')
    print(json.dumps({'diagnosticOnly': True, 'acceptance': False,
                      'assets': len(rows), 'changed': 'libecl.so', 'module': record(new_bytes)}))


if __name__ == '__main__':
    main()
