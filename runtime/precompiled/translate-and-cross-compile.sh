#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# First gated experiment: translate the pinned STACK entry module and build a
# browser-target ECL bundle. This does not install or select the result.
set -euo pipefail
export LC_ALL=C
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
STACK=${1:?pass the exact STACK checkout}
WORK="$ROOT/.cache/precompiled-stack"
MAXIMA="$ROOT/.cache/runtime-build/sources/maxima"
ECL="$MAXIMA/wasm/ecl-host/bin/ecl"
NATIVE="$MAXIMA/wasm/maxima-ecl-combined/bin/maxima"
export MAXIMA_PREFIX="$MAXIMA/wasm/maxima-ecl-combined"
PIN=33383047af39c204bf4442802a058f8b918b2b1b
test "$(git -C "$STACK" rev-parse HEAD)" = "$PIN"
test -x "$ECL"
test -x "$NATIVE"
mkdir -p "$WORK/source" "$WORK/logs"
cp "$STACK/stack/maxima/stackmaxima.mac" "$WORK/source/stackmaxima.mac"
sha256sum "$WORK/source/stackmaxima.mac" > "$WORK/logs/stackmaxima-source.sha256"
printf 'translate_file("%s")$\n' "$WORK/source/stackmaxima.mac" > "$WORK/translate.mac"
"$NATIVE" --very-quiet --batch="$WORK/translate.mac" 2>&1 | tee "$WORK/logs/translate.log"
test -s "$WORK/source/stackmaxima.lisp"
sha256sum "$WORK/source/stackmaxima.lisp" > "$WORK/logs/stackmaxima-lisp.sha256"
cat > "$WORK/source/ctm-stackmaxima.asd" <<'EOF'
(asdf:defsystem #:ctm-stackmaxima
  :depends-on (#:maxima/core)
  :components ((:file "stackmaxima")))
EOF
cd "$MAXIMA/wasm"
"$ECL" --norc --load build.lisp \
  --eval "(asdf:load-asd \"$WORK/source/ctm-stackmaxima.asd\")" \
  --eval '(cross-compile-maxima-module "ctm-stackmaxima")' \
  --eval '(ext:quit)' 2>&1 | tee "$WORK/logs/cross-compile.log"
mapfile -t bundles < <(find "$WORK" "$MAXIMA/src/binary-ecl" -type f \( -name 'ctm-stackmaxima.fasb' -o -name 'ctm-stackmaxima.fas' \) -print)
test "${#bundles[@]}" = 1
cp "${bundles[0]}" "$WORK/stackmaxima.fas"
file "$WORK/stackmaxima.fas" | tee "$WORK/logs/bundle-format.txt"
sha256sum "$WORK/stackmaxima.fas" > "$WORK/logs/stackmaxima-fas.sha256"
python "$ROOT/runtime/build/verify-source-state.py" after
