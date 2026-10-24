# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pinned source comparison with one explicit, exact target-only ECL overlay."""
import json
import os
from pathlib import Path
import subprocess
from source_overlay import (CRITICAL, SOURCE, blob, checked_after, descriptor,
                            derive, digest, host_identity, read, record, validate_transition)


def verify(repository, work, phase, target_overlay=False):
    assert phase in ('before', 'host', 'after')
    assert not target_overlay or phase == 'after'
    pins = json.loads((repository / 'runtime/build/pins.json').read_bytes())
    overlay = descriptor(repository) if target_overlay else None
    if target_overlay:
        proof = read(work / 'logs/target-source-overlay.json')
        assert proof['nativeHost'] == host_identity(work)
        assert proof['beforeSha256'] == digest((work / 'logs/source-state-before.json').read_bytes())
        assert proof['hostSourceSha256'] == digest((work / 'logs/source-state-host.json').read_bytes())
        assert proof['id'] == overlay['id'] and proof['derived'] == overlay['derived']
    observed = []
    for pin in pins['sources']:
        if pin['name'] not in ('maxima', 'ecl'):
            continue
        source = work / 'sources' / pin['name']
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
        assert revision == pin['commit']
        tree = subprocess.check_output(['git', 'ls-tree', '-r', '-z', 'HEAD'], cwd=source)
        checked = []
        for entry in tree.split(b'\0'):
            if not entry:
                continue
            metadata, raw_path = entry.split(b'\t', 1)
            mode, kind, upstream_blob = metadata.decode().split()
            assert kind == 'blob', 'Unexpected submodule source input'
            path = raw_path.decode()
            if phase != 'before' and not checked_after(pin['name'], path):
                continue
            file = source / path
            if mode != '120000':
                assert not file.is_symlink(), 'Tracked regular source replaced by symlink'
            body = os.fsencode(os.readlink(file)) if mode == '120000' else file.read_bytes()
            row = {'path': path, 'gitBlob': blob(body), **record(body)}
            if overlay and pin['name'] == 'ecl' and path == SOURCE:
                original = subprocess.check_output(['git', 'show', 'HEAD:' + path], cwd=source)
                assert body == derive(repository, original)
                row.update(upstreamGitBlob=upstream_blob, overlayId=overlay['id'])
            else:
                assert row['gitBlob'] == upstream_blob, pin['name'] + '/' + path
            if pin['name'] == 'maxima' and path in CRITICAL:
                target = work / 'build-recipes/maxima' / path
                if phase == 'before':
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(body)
                assert target.read_bytes() == body
            checked.append(row)
        assert checked
        observed.append({'name': pin['name'], 'revision': revision, 'files': checked})
    report = {'schema': 1, 'phase': phase, 'passed': True, 'sources': observed,
              'upstreamUnmodified': not target_overlay, 'overlays': [] if overlay is None else [overlay['id']],
              'scope': 'Before: every tracked Maxima/ECL input byte is original. Host: tracked .lisp/.lsp/.mac/.asd/.c/.h/.d and the three Maxima build inputs are original. After: the same coverage, with only the declared ECL target overlay admitted explicitly; each row records its actual bytes and Git blob. Generated configuration/build support is excluded from host/after claims.'}
    if phase != 'before':
        before = json.loads((work / 'logs/source-state-before.json').read_bytes())
        validate_transition(before, report, overlay)
    output = work / 'logs' / ('source-state-' + phase + '.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    return report
