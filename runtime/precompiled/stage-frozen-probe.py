#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pair a frozen older entry bundle with an independently reviewed runtime.

This diagnoses browser loading/reset behavior, not fresh-build parity. The
binary builds are separate; their immutable identities remain explicit.
"""
import copy
import hashlib
import json
from pathlib import Path
import shutil
from bundle_provenance import record

ROOT = Path(__file__).resolve().parents[2]
FROZEN = ROOT / '.cache/precompiled-frozen-inputs'
PROBE = FROZEN / 'probe/.cache/precompiled-stack'
SITE = ROOT / '.cache/precompiled-browser/site'
PIN = '33383047af39c204bf4442802a058f8b918b2b1b'
LOADER = 'stack/maxima/stacklocallinux.mac'
ENTRY = 'stack/maxima/stackmaxima.mac'
OLD = 'load("stackmaxima.mac")$'
NEW = 'load("/ctm/moodle-qtype_stack-master/stack/maxima/stackmaxima.fas")$'
START = 'load("/ctm/moodle-qtype_stack-master/stack/maxima/stacklocallinux.mac")$'


def stage():
    original_bytes = (SITE / 'stack-sources.json').read_bytes()
    original = json.loads(original_bytes)
    retained = json.loads((PROBE / 'site/stack-sources-precompiled.json').read_text())
    provenance = json.loads((FROZEN / 'provenance.json').read_text())
    assert provenance['diagnosticOnly'] is True
    assert original['stackRevision'] == retained['stackRevision'] == PIN
    assert len(original['files']) == len(retained['files'])
    assert len({f['path'] for f in original['files']}) == len(original['files'])
    assert len({f['path'] for f in retained['files']}) == len(retained['files'])
    compiled = retained['compiledStack']
    assert compiled['schema'] == 1 and compiled['mode'] == 'entry-fas' and compiled['stackRevision'] == PIN
    for file in original['files']:
        candidate = next(f for f in retained['files'] if f['path'] == file['path'])
        assert record(file['content'].encode()) == {'bytes': file['bytes'], 'sha256': file['sha256']}
        if file['path'] == LOADER:
            assert file['content'].count(OLD) == 1
            changed = file['content'].replace(OLD, NEW)
            assert candidate == {**file, 'content': changed, **record(changed.encode())}
            assert compiled['originalLoaderSha256'] == file['sha256']
            assert compiled['overlayLoaderSha256'] == candidate['sha256']
        else:
            assert candidate == file
    entry = next(f for f in original['files'] if f['path'] == ENTRY)
    assert compiled['sourcePath'] == ENTRY and compiled['sourceSha256'] == entry['sha256']
    lisp = (PROBE / 'source-initialized/stackmaxima.LISP').read_bytes()
    assert compiled['translatedLispSha256'] == record(lisp)['sha256']
    bridge = (PROBE / 'source-initialized/display2d-bridge.lisp').read_bytes()
    assert bridge == Path(__file__).with_name('display2d-bridge.lisp').read_bytes()
    assert compiled['translationAdapter']['sha256'] == record(bridge)['sha256']
    binary = (PROBE / 'stackmaxima.fas').read_bytes()
    assert binary.startswith(b'\x00asm')
    assert compiled['asset'] == {'path': 'stackmaxima.fas', 'fileBytes': len(binary), 'sha256': record(binary)['sha256']}
    assert original['startup'].count(START) == 1
    timed = copy.deepcopy(original)
    timed['startup'] = timed['startup'].replace(START,
        'm2_emit("CTMSTACK-LOAD-BEGIN")$\n' + START + '\nm2_emit("CTMSTACK-LOAD-END")$')
    assert timed['startup'] == retained['startup']
    variant = copy.deepcopy(timed)
    variant['files'] = retained['files']
    variant['compiledStack'] = compiled
    # Runtime assets/preload/build provenance come from the accepted baseline;
    # only the explicitly frozen entry overlay and FAS come from the old probe.
    for name, value in [('stack-sources-timed-source.json', timed), ('stack-sources-precompiled.json', variant)]:
        with (SITE / name).open('x') as stream:
            stream.write(json.dumps(value, ensure_ascii=False) + '\n')
    destination = SITE / 'maxima-runtime/stackmaxima.fas'
    assert not destination.exists()
    shutil.copyfile(PROBE / 'stackmaxima.fas', destination)
    summary = {'schema': 1, 'diagnosticOnly': True,
        'scope': 'Frozen baseline from39989733394 and older FAS from40005689823; separately built binaries, no fresh-build/current-head parity clearance',
        'artifacts': {name: row['spec'] for name, row in provenance['inputs'].items()},
        'sourceManifest': record(original_bytes), 'compiledStack': compiled,
        'measurementCodeRevision': __import__('os').environ.get('GITHUB_SHA')}
    (FROZEN / 'pair.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary))


if __name__ == '__main__':
    stage()
