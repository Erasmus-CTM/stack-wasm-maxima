#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Package precisely the currently staged asset inventory, plus source/notices."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
import shutil
from configuration import configuration, startup
from recipe_inputs import recipe_files, committed_recipe
from source_overlay import DESCRIPTOR, PATCH, SOURCE, integrity, verify_packaged
from source_state import verify as verify_source_state
from compiler_profile import compiler_profile
from compiler_evidence import derive

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
    config = configuration()
    profile = compiler_profile()
    compiler_record = json.loads((work / 'logs/compiler-experiment.json').read_bytes())
    observed = derive((work / 'logs/ecl-config.log').read_bytes(),(work / 'logs/target-info.lsp').read_bytes(),(work / 'logs/ecl-cross-build.log').read_bytes(),(work / 'logs/maxima-cross-build.log').read_bytes(),profile)
    assert compiler_record['passed'] is True and compiler_record['profile']==profile and compiler_record['observed']==observed
    if subprocess.check_output(['git','rev-parse','HEAD'],cwd=args.notices,text=True).strip() != pins['notices']['commit']:
        raise ValueError('Third-party notices checkout is not the pinned revision')
    progress = json.loads((work / 'source-progress.json').read_text())['sources']
    if len(progress) != len(pins['sources']) or not all(row['verified'] for row in progress):
        raise ValueError('Source preparation did not verify every pinned source')
    toolchain = json.loads((work / 'logs/toolchain-archives.json').read_text())
    if len(toolchain['archives']) != len(pins['toolchainArchives']) or not all(row['verified'] for row in toolchain['archives']):
        raise ValueError('Executed toolchain archives were not all verified')
    if any(pin['name']=='gnuplot' for pin in pins['sources']):
        raise ValueError('Current build must have no gnuplot source')
    recipe_revision, _ = committed_recipe(ROOT)
    verify_source_state(ROOT, work, 'after', target_overlay=True)
    source_integrity = integrity(ROOT, work)
    if json.loads((work / 'logs/target-source-overlay.json').read_bytes())['recipeRevision'] != recipe_revision:
        raise ValueError('Source overlay was applied by a different recipe revision')
    expected_archives = {pin['name'] + ('.tar' if pin['archive']['format']=='git-archive-tar' else '.tar.gz') for pin in pins['sources']}
    if {path.name for path in (work / 'source-archives').iterdir()} != expected_archives:
        raise ValueError('Source archive directory contains stale or missing provenance')
    if (work / 'sources/gnuplot').exists():
        raise ValueError('Unexpected external gnuplot source tree')
    upstream_recipe = work / 'sources/maxima/wasm/Makefile'
    preserved_recipe = work / 'build-recipes/maxima/wasm/Makefile'
    if upstream_recipe.read_bytes() != preserved_recipe.read_bytes():
        raise ValueError('Upstream build recipe changed')
    source_before = json.loads((work / 'logs/source-state-before.json').read_text())
    source_after = json.loads((work / 'logs/source-state-after.json').read_text())
    if not source_before['passed'] or not source_after['passed']:
        raise ValueError('Missing verified upstream source-state evidence')
    critical = [row for source in source_after['sources'] if source['name']=='maxima' for row in source['files'] if row['path'] in ['wasm/Makefile','wasm/build.lisp','src/maxima.asd']]
    if len(critical) != 3 or any((work / 'build-recipes/maxima' / row['path']).read_bytes() != (work / 'sources/maxima' / row['path']).read_bytes() for row in critical):
        raise ValueError('Pinned upstream build inputs differ from preserved bytes')
    recipe_evidence = {'path':'wasm/Makefile','sha256':hashlib.sha256(upstream_recipe.read_bytes()).hexdigest(),
                       'verifiedFilesUnmodified':True,'verifiedInputs':critical,'patches':[],
                       'scope':'Only the three pinned Maxima build inputs: wasm/Makefile, wasm/build.lisp, src/maxima.asd. ECL source derivation is described separately in sourceIntegrity.'}
    for pin in pins['sources']:
        suffix = '.tar' if pin['archive']['format'] == 'git-archive-tar' else '.tar.gz'
        archive = work / 'source-archives' / (pin['name'] + suffix)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != pin['archive']['sha256']:
            raise ValueError('Source archive changed after preparation: ' + pin['name'])
    built = work / 'sources/maxima/wasm/maxima-ecl-combined'
    runtime = args.output / 'runtime'
    runtime.mkdir(parents=True, exist_ok=True)
    for omitted in config['omittedRuntimePaths']:
        if (runtime / omitted).exists() or (built / omitted).exists():
            raise ValueError('Unexpected omitted browser artifact: ' + omitted)
    table = []
    for path, deployed in sorted(records().items()):
        if path in config['omittedRuntimePaths']:
            continue
        body = (built / path).read_bytes()
        target = runtime / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        table.append({'path': path, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(),
                      'deployedBytes': deployed['fileBytes'], 'deployedSha256': deployed['sha256'],
                      'differenceBytes': len(body) - deployed['fileBytes']})
    licence_dir = args.output / 'LICENSES'
    shutil.copytree(args.notices / pins['notices']['path'], licence_dir, dirs_exist_ok=True, ignore=shutil.ignore_patterns('gnuplot.txt'))
    shutil.copy2(args.notices / 'THIRD-PARTY-NOTICES.md', args.output / 'SITE-NOTICES-context.md')
    # Preserve the source repositories' own notice files too; do not rewrite them.
    for name, paths in {'maxima':['COPYING'], 'ecl':['COPYING','LICENSE','src/gmp/COPYING','src/gmp/COPYING.LIB','src/libffi/LICENSE','src/bdwgc/README.md','src/bdwgc/README.QUICK']}.items():
        for path in paths:
            source = work / 'sources' / name / path
            if source.is_file():
                target = licence_dir / 'upstream' / name / path
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
    shutil.copytree(work / 'source-archives', args.output / 'sources', dirs_exist_ok=True)
    shutil.copytree(work / 'logs', args.output / 'logs', dirs_exist_ok=True)
    shutil.copytree(work / 'build-recipes', args.output / 'build-recipes', dirs_exist_ok=True)
    overlay = args.output / 'source-overlays/ecl'
    (overlay / SOURCE).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / DESCRIPTOR, overlay / 'descriptor.json')
    shutil.copy2(ROOT / PATCH, overlay / 'root-scanner.patch')
    shutil.copy2(work / 'sources/ecl' / SOURCE, overlay / SOURCE)
    shutil.copy2(work / 'sources/ecl/LICENSE', overlay / 'LICENSE')
    (overlay / 'README.txt').write_text(
        'CTM target-only ECL source modification: replace eight root-range pushes in src/c/alloc_2.d with GC_push_all_eager.\n'
        'The native ECL32 host is built before this overlay is applied. Its source and executable identities are retained in logs/.\n'
        'The complete original ECL archive is unchanged in sources/ecl.tar. Apply root-scanner.patch there with git apply to reproduce the provided derived file.\n'
        'Original file copyright notices and the ECL LICENSE apply to this derived source and patch. See descriptor.json for exact original, derived and patch hashes.\n')
    recipe = {'repository':'https://github.com/Erasmus-CTM/stack-wasm-maxima',
              'revision':recipe_revision,
              'files':[]}
    recipe_paths = [ROOT / path for path in recipe_files(ROOT)]
    for source in sorted(recipe_paths):
        relative = source.relative_to(ROOT).as_posix()
        body = source.read_bytes()
        target = args.output / 'recipe' / relative
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(body)
        recipe['files'].append({'path':relative,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()})
    (args.output / 'source-manifest.json').write_text(json.dumps({'schema':1,'compilerProfile':profile,'sourcePins':pins,'recipe':recipe,'toolchain':toolchain,'upstreamRecipe':recipe_evidence,'sourceIntegrity':source_integrity,'configuration':config,'startupAdapter':{'content':startup(config),'sha256':config['startupSha256']}},indent=2)+'\n')
    notices = ["# Notices for this owned-build artifact", "",
               "These runtime files were rebuilt by CTM from the pinned original source archives plus the declared target ECL overlay and recipe recorded in source-manifest.json.",
               "The licence text files under LICENSES are copied unchanged from the pinned third-party-notices PR; upstream original notices and full source archives are retained too.",
               "Component licence summaries are not replacements for the preserved per-file terms. Maxima's COPYING contains GPL v2 and the tree has mixed per-file notices; no blanket or-later grant is asserted here.",
               "ECL's LICENSE lists exceptions for loop.lsp, pprint.lsp, format.lsp, contrib and examples. Their original terms remain in the complete ECL source archive.",
               "The target ECL contains the declared root-scanner overlay under source-overlays/ecl/. Original ECL archives remain unchanged; this directory preserves the patch, exact derived source, descriptor and ECL licence. Native ECL32 and all three Maxima build inputs use original source bytes.",
               "SITE-NOTICES-context.md is the legacy site's notice for its deployed dependencies; it is retained only as site context and does not describe the provenance of these rebuilt files.",
               "Build inputs, exact archive hashes, SDK binary identities, recipe revision and recipe files are in source-manifest.json and recipe/.", ""]
    (args.output / 'BUILD-NOTICES.md').write_text('\n'.join(notices))
    manifest = {'schema':1, 'compilerProfile':profile, 'runtimeAssets':table, 'sourcePins':pins, 'recipe':recipe, 'toolchain':toolchain, 'upstreamRecipe':recipe_evidence,'sourceIntegrity':source_integrity,'configuration':config,'startupAdapter':{'content':startup(config),'sha256':config['startupSha256']},
                'scope':'Uncompressed owned-build substitution candidate; parity not implied by successful compilation'}
    (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    verify_packaged(args.output, ROOT)
    lines = ['# Owned build versus deployed files', '', '| Path | Built bytes | Deployed bytes | Difference |', '|---|---:|---:|---:|']
    lines += [f"| `{r['path']}` | {r['bytes']} | {r['deployedBytes']} | {r['differenceBytes']:+} |" for r in table]
    lines += ['', f"Total built bytes: {sum(r['bytes'] for r in table)}.", '', f"Plotting omitted from sources, build and delivery. Compiler experiment profile: {profile['name']}; only the ECL target phase accepts injected flags, and no other trim or compression is applied."]
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
