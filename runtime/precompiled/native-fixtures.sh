#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Native-only diagnostic arms; this neither builds nor selects a browser bundle.
set -euo pipefail
export LC_ALL=C
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK="$ROOT/.cache/precompiled-fixtures"
MAXIMA="$ROOT/.cache/runtime-build/sources/maxima"
export ECL_SRCDIR="$ROOT/.cache/runtime-build/sources/ecl"
export ECL_TO_RUN="$MAXIMA/wasm/ecl-host/bin/ecl"
test ! -e "$WORK"
mkdir -p "$WORK/logs"
exec > >(tee "$WORK/logs/fixtures.log") 2>&1
python "$ROOT/runtime/build/verify-source-state.py" before
cd "$MAXIMA"
./bootstrap
cd wasm
# Exact native prerequisites from the unmodified pinned upstream Makefile.
make -f Makefile -j2 "$ECL_TO_RUN" maxima-ecl-combined/share
export MAXIMA_PREFIX="$MAXIMA/wasm/maxima-ecl-combined"
NATIVE="$MAXIMA_PREFIX/bin/maxima"
"$ECL_TO_RUN" --norc --eval '(unless (= (integer-length most-positive-fixnum) 29) (ext:quit 65))' --eval '(ext:quit)'
sha256sum "$ECL_TO_RUN" "$NATIVE" > "$WORK/logs/native-executables.sha256"
export CTM_FIXTURE_BRIDGE_FILE="$ROOT/runtime/precompiled/display2d-bridge.lisp"
for arm in assignment-control assignment-bridge reset-control reset-package; do
  mkdir "$WORK/$arm"
  export CTM_FIXTURE_BRIDGE=false CTM_FIXTURE_PACKAGE=false
  export CTM_FIXTURE_SOURCE="$WORK/$arm/fixture.mac"
  export CTM_FIXTURE_LISP="$WORK/$arm/fixture.LISP"
  if [[ "$arm" == assignment-* ]]; then
    printf 'ctm_fixture_assignment(v):=block([display2d:true],display2d:v,display2d)$\n' > "$CTM_FIXTURE_SOURCE"
  else
    printf 'ctm_reset_probe(x):=x+1$\n' > "$CTM_FIXTURE_SOURCE"
  fi
  [[ "$arm" != assignment-bridge ]] || export CTM_FIXTURE_BRIDGE=true
  [[ "$arm" != reset-package ]] || export CTM_FIXTURE_PACKAGE=true
  if "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$ROOT/runtime/precompiled/fixture-translate.lisp" > "$WORK/$arm/translate.log" 2>&1; then
    grep -q '^CTM-FIXTURE-TRANSLATION-OK|' "$WORK/$arm/translate.log"
    echo translated > "$WORK/$arm/translation-status.txt"
  else
    echo failed > "$WORK/$arm/translation-status.txt"
  fi
  if [[ "$arm" == assignment-* ]]; then
    for mode in source compiled; do
      export CTM_FIXTURE_MODE="$mode"
      if [[ "$mode" == source || -s "$CTM_FIXTURE_LISP" ]] &&
        "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$ROOT/runtime/precompiled/fixture-assignment-check.lisp" > "$WORK/$arm/check-$mode.log" 2>&1 &&
        grep -q '^CTM-ASSIGNMENT-BEHAVIOR-OK|' "$WORK/$arm/check-$mode.log"; then
        echo passed > "$WORK/$arm/check-$mode-status.txt"
      else
        echo failed > "$WORK/$arm/check-$mode-status.txt"
      fi
    done
  else
    # Existing reset checker resolves its translated fixture beside the driver.
    mkdir "$WORK/$arm/source"
    cp "$ROOT/runtime/precompiled/reset-probe.lisp" "$WORK/$arm/reset-probe.lisp"
    if [[ -s "$CTM_FIXTURE_LISP" ]]; then
      cp "$CTM_FIXTURE_LISP" "$WORK/$arm/source/ctm-reset-probe.LISP"
    fi
    if "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/$arm/reset-probe.lisp" > "$WORK/$arm/reset.log" 2>&1 &&
      grep -q '^CTM-RESET-OK|3$' "$WORK/$arm/reset.log"; then
      echo passed > "$WORK/$arm/reset-status.txt"
    else
      echo failed > "$WORK/$arm/reset-status.txt"
    fi
  fi
done
cd "$ROOT"
python runtime/build/verify-source-state.py after
python - <<'PY'
import hashlib,json
from pathlib import Path
root=Path('.cache/precompiled-fixtures')
report={'schema':1,'scope':'Native fixture experiments only; no browser bundle, parity or speedup established','arms':{}}
for arm in ('assignment-control','assignment-bridge','reset-control','reset-package'):
    directory=root/arm
    report['arms'][arm]={p.name:p.read_text().strip() for p in directory.glob('*status.txt')}
report['files']=[{'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(root.rglob('*')) if p.is_file() and p != root/'logs/fixtures.log']
(root/'report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
a=report['arms']
assert a['assignment-control']['translation-status.txt']=='failed'
assert 'Cannot print object' in (root/'assignment-control/translate.log').read_text()
assert all(a[x]['check-source-status.txt']=='passed' for x in ('assignment-control','assignment-bridge'))
assert a['assignment-bridge']['translation-status.txt']=='translated'
assert a['assignment-bridge']['check-compiled-status.txt']=='passed'
assert a['reset-control']['translation-status.txt']=='translated'
assert a['reset-control']['reset-status.txt']=='failed'
reset_control=(root/'reset-control/reset.log').read_text()
assert 'CTM-RESET-PRECHECK-OK|42' in reset_control and 'CTM-RESET-CLEARED|0' in reset_control
assert a['reset-package']['translation-status.txt']=='translated'
assert a['reset-package']['reset-status.txt']=='passed'
PY
