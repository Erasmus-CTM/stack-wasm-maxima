#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Usage: run-wasm.sh BUILD_BIN_DIR FIRST LAST
# BUILD_BIN_DIR holds ecl.js, ecl.wasm and libecl.so from an Emscripten build
# of ECL (see README). Runs one Node process per depth of deep-wasm.lisp and
# prints each depth that aborts with "Unexpected mark stack overflow".
# Exits 1 if any depth aborted, 0 if none did, 2 on any other failure.
set -u
bin=${1:?usage: run-wasm.sh BUILD_BIN_DIR FIRST LAST}
first=${2:?}
last=${3:?}
here=$(cd "$(dirname "$0")" && pwd)
# The Emscripten build has no file system access to this directory, so the
# definition is passed as an --eval form.
def=$(grep -v '^;' "$here/deep-wasm.lisp")
log=$(mktemp)
trap 'rm -f "$log"' EXIT
# -O0 interpreter frames need more than Node's default native stack.
ulimit -s unlimited 2>/dev/null
aborts=0
d=$first
while [ "$d" -le "$last" ]; do
  node --stack-size=200000 "$bin/ecl.js" --norc --eval "$def" \
    --eval "(format t (if (= (deep $d) (/ (* $d (1+ $d)) 2)) \"CTM-OK~%\" \"CTM-WRONG~%\"))" \
    --eval '(ext:quit)' >"$log" 2>&1
  if grep -q 'Unexpected mark stack overflow' "$log"; then
    echo "depth $d: Unexpected mark stack overflow ($(grep CTM-ROOTS "$log" | tail -n 1))"
    [ "$aborts" -eq 0 ] && grep -E '^Unexpected|^RuntimeError|^ +at libecl' "$log" | head -n 12
    aborts=$((aborts + 1))
  elif ! grep -q CTM-OK "$log"; then
    echo "depth $d: did not complete"
    grep -v CTM-ROOTS "$log" | head -n 20
    exit 2
  fi
  d=$((d + 1))
done
echo "$aborts aborting depths in $first..$last (wasm)"
[ "$aborts" -eq 0 ]
