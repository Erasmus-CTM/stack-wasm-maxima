#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Stage one exact compiled loader and bundle for each official probe pin."""
import argparse
import importlib.util
import json
from pathlib import Path
from bundle_provenance import record
from parser_bootstrap import PINNED_SOURCES

spec = importlib.util.spec_from_file_location('stage_variant', Path(__file__).with_name('stage-variant.py'))
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)


def prepare(root, prepared, output):
    versions = json.loads(prepared.read_text())['versions']
    if len(versions) != 2 or {v['stackRevision'] for v in versions} != set(PINNED_SOURCES):
        raise ValueError('Official probes must contain both exact STACK pins once')
    output.mkdir(parents=True, exist_ok=False)
    result = {'schema': 1, 'officialPrepared': record(prepared.read_bytes()), 'pins': []}
    for version in versions:
        pin = version['stackRevision']
        work = root / '.cache' / ('precompiled-stack' if pin.startswith('3338304') else 'precompiled-stack-10d3233')
        site = output / pin
        site.mkdir()
        manifest = {'schema': 1, 'stackRevision': pin, 'startup': stage.START_LOAD,
                    'files': version['files']}
        (site / 'stack-sources.json').write_text(json.dumps(manifest) + '\n')
        compiled = stage.stage(site, work / 'upstream-stack', work / 'stackmaxima.fas',
                               work / 'source-initialized/stackmaxima.lisp')
        manifest_path = site / 'stack-sources-precompiled.json'
        result['pins'].append({'stackRevision': pin, 'compiledStack': compiled,
                               'manifest': {'path': str(manifest_path.resolve()), **record(manifest_path.read_bytes())},
                               'bundlePath': str((site / 'maxima-runtime/stackmaxima.fas').resolve())})
    (output / 'index.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepared', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(Path(__file__).resolve().parents[2], args.prepared, args.output)))
