#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Read-only upstream drift evidence; never rewrite pins or publish a build."""
import json
from pathlib import Path
import subprocess
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
REFERENCES = {'maxima': 'refs/heads/emscripten-port-deployed',
              'ecl': 'refs/heads/maxima-emscripten-hacks-wip',
              'emsdk': 'refs/tags/4.0.10',
              'emscripten': 'refs/tags/4.0.10'}

def main():
    pins = json.loads((ROOT / 'runtime/build/pins.json').read_text())
    report = {'schema': 1, 'createdAt': datetime.now(timezone.utc).isoformat(),
              'scope': 'Read-only branch and pinned-tag drift report. Exact candidate pins require human review, archive verification, owned build and the full substitution suite. No pin edits, PRs, tags or releases are created.',
              'sources': [], 'checked': False}
    output = ROOT / 'test-results/runtime-upstream'
    output.mkdir(parents=True, exist_ok=True)
    try:
        for source in pins['sources']:
            reference = REFERENCES[source['name']]
            raw = subprocess.check_output(['git','ls-remote',source['repository'],reference,reference+'^{}'], text=True, timeout=120)
            refs = dict(line.split()[::-1] for line in raw.splitlines())
            commit = refs.get(reference+'^{}', refs.get(reference))
            if not commit or len(commit) != 40:
                raise ValueError('Missing exact upstream reference: ' + source['name'])
            report['sources'].append({'name': source['name'], 'repository': source['repository'],
                                      'reference': reference, 'pinnedCommit': source['commit'],
                                      'observedCommit': commit, 'changed': commit != source['commit']})
        report['checked'] = True
    except Exception as error:
        report['failure'] = str(error)
    (output / 'upstream.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0 if report['checked'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
