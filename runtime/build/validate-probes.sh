#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
output="$root/.cache/runtime-build/validation"
mkdir -p "$output"
python scripts/milestone-one/prepare.py
for candidate in deployed owned; do
  if [[ "$candidate" == owned ]]; then
    export CTM_MAXIMA_RUNTIME_SOURCE="$root/.cache/runtime-build/artifact"
  else
    unset CTM_MAXIMA_RUNTIME_SOURCE
  fi
  export MILESTONE_ONE_REPORT_ROOT="$output/m1-$candidate-report"
  node scripts/milestone-one/run.mjs
  python scripts/milestone-one/compare.py
  mkdir -p "$output/m1-$candidate"
  cp test-results/milestone-one/* "$output/m1-$candidate/"
  cp "$MILESTONE_ONE_REPORT_ROOT/latest.json" "$output/m1-$candidate/comparison.json"
done
