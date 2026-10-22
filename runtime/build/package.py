#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Package precisely the currently staged asset inventory, plus source/notices."""
import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
BASE = 'https://maxima-on-wasm.pages.dev/'

def records():
    inventory = json.loads((ROOT / 'measurements/2026-10-21-runtime-assets.json').read_text())
    linked = json.loads((ROOT / 'measurements/2026-10-21-runtime-dependencies.json').read_text())
    extra = json.loads((ROOT / 'measurements/2026-10-22-demo-runtime-dependencies.json').read_text())
    observed = json.loads((ROOT / 'reports/milestone-one/browser-3338304.json').read_text())
    wanted = set(inventory['groups']['maximaCore'] + inventory['groups']['maximaOptionalModules'])
    wanted.update(a['url'] for a in linked['assets'] + extra['assets'] + observed['servedAssets'])
    result = {}
    for record in inventory['assets'] + linked['assets'] + extra['assets'] + observed['servedAssets']:
        if record['url'] in wanted:
            path = record['url'].removeprefix(BASE)
            assert record['url'].startswith(BASE) and not Path(path).is_absolute() and '..' not in Path(path).parts
            if path in result:
                assert record['sha256'] == result[path]['sha256']
            result[path] = record
    assert len(result) == len(wanted)
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--notices', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT / '.cache/runtime-build/artifact')
    args = parser.parse_args()
    work = ROOT / '.cache/runtime-build'
    pins = json.loads((ROOT / 'runtime/build/pins.json').read_text())
    if subprocess.check_output(['git','rev-parse','HEAD'],cwd=args.notices,text=True).strip() != pins['notices']['commit']:
        raise ValueError('Third-party notices checkout is not the pinned revision')
    progress = json.loads((work / 'source-progress.json').read_text())['sources']
    if len(progress) != len(pins['sources']) or not all(row['verified'] for row in progress):
        raise ValueError('Source preparation did not verify every pinned source')
    toolchain = json.loads((work / 'logs/toolchain-archives.json').read_text())
    if len(toolchain['archives']) != len(pins['toolchainArchives']) or not all(row['verified'] for row in toolchain['archives']):
        raise ValueError('Executed toolchain archives were not all verified')
    for pin in pins['sources']:
        suffix = '.tar' if pin['archive']['format'] == 'git-archive-tar' else '.tar.gz'
        archive = work / 'source-archives' / (pin['name'] + suffix)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != pin['archive']['sha256']:
            raise ValueError('Source archive changed after preparation: ' + pin['name'])
    built = work / 'sources/maxima/wasm/maxima-ecl-combined'
    runtime = args.output / 'runtime'
    runtime.mkdir(parents=True, exist_ok=True)
    table = []
    for path, deployed in sorted(records().items()):
        body = (built / path).read_bytes()
        target = runtime / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        table.append({'path': path, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(),
                      'deployedBytes': deployed['fileBytes'], 'deployedSha256': deployed['sha256'],
                      'differenceBytes': len(body) - deployed['fileBytes']})
    licence_dir = args.output / 'LICENSES'
    shutil.copytree(args.notices / pins['notices']['path'], licence_dir, dirs_exist_ok=True)
    shutil.copy2(args.notices / 'THIRD-PARTY-NOTICES.md', args.output / 'SITE-NOTICES-context.md')
    # Preserve the source repositories' own notice files too; do not rewrite them.
    for name, paths in {'maxima':['COPYING'], 'ecl':['COPYING','LICENSE','src/gmp/COPYING','src/gmp/COPYING.LIB','src/libffi/LICENSE','src/bdwgc/README.md','src/bdwgc/README.QUICK'], 'gnuplot':['Copyright']}.items():
        for path in paths:
            source = work / 'sources' / name / path
            if source.is_file():
                target = licence_dir / 'upstream' / name / path
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
    shutil.copytree(work / 'source-archives', args.output / 'sources', dirs_exist_ok=True)
    shutil.copytree(work / 'logs', args.output / 'logs', dirs_exist_ok=True)
    recipe = {'repository':'https://github.com/Erasmus-CTM/stack-wasm-maxima',
              'revision':os.environ.get('GITHUB_SHA') or subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
              'files':[]}
    recipe_paths = [p for p in (ROOT / 'runtime/build').rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    recipe_paths += [ROOT / '.github/workflows/runtime-build.yml', ROOT / 'scripts/milestone-two/prepare-runtime.py', ROOT / 'scripts/milestone-one/run.mjs', ROOT / 'scripts/milestone-one/compare.py']
    for source in sorted(recipe_paths):
        relative = source.relative_to(ROOT).as_posix()
        body = source.read_bytes()
        target = args.output / 'recipe' / relative
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(body)
        recipe['files'].append({'path':relative,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()})
    (args.output / 'source-manifest.json').write_text(json.dumps({'schema':1,'sourcePins':pins,'recipe':recipe,'toolchain':toolchain},indent=2)+'\n')
    notices = ["# Notices for this owned-build artifact", "",
               "These runtime files were rebuilt by CTM from the exact upstream sources and recipe recorded in source-manifest.json.",
               "The licence text files under LICENSES are copied unchanged from the pinned third-party-notices PR; upstream original notices and full source archives are retained too.",
               "Component licence summaries are not replacements for the preserved per-file terms. Maxima's COPYING contains GPL v2 and the tree has mixed per-file notices; no blanket or-later grant is asserted here.",
               "ECL's LICENSE lists exceptions for loop.lsp, pprint.lsp, format.lsp, contrib and examples. Their original terms remain in the complete ECL source archive.",
               "SITE-NOTICES-context.md is the legacy site's notice for its deployed dependencies; it is retained only as site context and does not describe the provenance of these rebuilt files.",
               "Build inputs, exact archive hashes, SDK binary identities, recipe revision and recipe files are in source-manifest.json and recipe/.", ""]
    (args.output / 'BUILD-NOTICES.md').write_text('\n'.join(notices))
    manifest = {'schema':1, 'runtimeAssets':table, 'sourcePins':pins, 'recipe':recipe, 'toolchain':toolchain,
                'scope':'Uncompressed owned-build substitution candidate; parity not implied by successful compilation'}
    (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    lines = ['# Owned build versus deployed files', '', '| Path | Built bytes | Deployed bytes | Difference |', '|---|---:|---:|---:|']
    lines += [f"| `{r['path']}` | {r['bytes']} | {r['deployedBytes']} | {r['differenceBytes']:+} |" for r in table]
    lines += ['', f"Total built bytes: {sum(r['bytes'] for r in table)}.", '', 'No trims or compression applied.']
    (args.output / 'sizes.md').write_text('\n'.join(lines) + '\n')
    all_files = []
    for path in sorted(args.output.rglob('*')):
        if path.is_file() and path.name != 'artifact-manifest.json':
            body = path.read_bytes()
            all_files.append({'path':path.relative_to(args.output).as_posix(),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()})
    (args.output / 'artifact-manifest.json').write_text(json.dumps({'schema':1,'files':all_files}, indent=2) + '\n')
    print(json.dumps({'runtimeFiles':len(table),'runtimeBytes':sum(r['bytes'] for r in table)}))

if __name__ == '__main__':
    main()
