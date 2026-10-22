#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Package precisely the currently staged asset inventory, plus source/notices."""
import argparse
import hashlib
import json
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
    pins = json.loads((ROOT / 'runtime/build/pins.json').read_text())
    licence_dir = args.output / 'LICENSES'
    shutil.copytree(args.notices / pins['notices']['path'], licence_dir, dirs_exist_ok=True)
    shutil.copy2(args.notices / 'THIRD-PARTY-NOTICES.md', args.output / 'THIRD-PARTY-NOTICES.md')
    # Preserve the source repositories' own notice files too; do not rewrite them.
    for name, paths in {'maxima':['COPYING'], 'ecl':['COPYING','LICENSE','src/gmp/COPYING','src/gmp/COPYING.LIB','src/libffi/LICENSE','src/bdwgc/README.QUICK'], 'gnuplot':['Copyright']}.items():
        for path in paths:
            source = work / 'sources' / name / path
            if source.is_file():
                target = licence_dir / 'upstream' / name / path
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
    shutil.copytree(work / 'source-archives', args.output / 'sources', dirs_exist_ok=True)
    shutil.copytree(work / 'logs', args.output / 'logs', dirs_exist_ok=True)
    shutil.copy2(ROOT / 'runtime/build/pins.json', args.output / 'source-manifest.json')
    manifest = {'schema':1, 'runtimeAssets':table, 'sourcePins':pins,
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
