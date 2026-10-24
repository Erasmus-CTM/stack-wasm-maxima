#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Check original sources, or the one explicitly selected target overlay."""
import argparse
import json
from pathlib import Path
from source_state import verify

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('phase', choices=('before', 'after'))
parser.add_argument('--target-overlay', action='store_true')
args = parser.parse_args()
report = verify(ROOT, ROOT / '.cache/runtime-build', args.phase, args.target_overlay)
print(json.dumps({'phase': args.phase, 'passed': True, 'upstreamUnmodified': report['upstreamUnmodified'],
                  'files': sum(len(row['files']) for row in report['sources'])}))
