#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Apply the exact target overlay after the unchanged native ECL32 build."""
import json
from pathlib import Path
from source_overlay import apply

ROOT = Path(__file__).resolve().parents[2]
print(json.dumps(apply(ROOT, ROOT / '.cache/runtime-build')))
