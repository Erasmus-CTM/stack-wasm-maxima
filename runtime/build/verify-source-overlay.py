#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Revalidate a packaged target overlay against the current recipe checkout."""
import argparse
from pathlib import Path
from source_overlay import verify_packaged

parser = argparse.ArgumentParser()
parser.add_argument('artifact', type=Path)
args = parser.parse_args()
verify_packaged(args.artifact.resolve(), Path(__file__).resolve().parents[2])
print('Packaged ECL target overlay, original archive and native-host evidence verified')
