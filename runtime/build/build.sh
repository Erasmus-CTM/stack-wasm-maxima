#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK="$ROOT/.cache/runtime-build"
MAXIMA="$WORK/sources/maxima"
export ECL_SRCDIR="$WORK/sources/ecl"
export GNUPLOT_SRCDIR="$WORK/sources/gnuplot"
export EMSDK_PATH="$WORK/sources/emsdk"
export ECL_TO_RUN="$MAXIMA/wasm/ecl-host/bin/ecl"
mkdir -p "$WORK/logs"
exec > >(tee "$WORK/logs/build.log") 2>&1
printf 'Build started: '; date -u +%FT%TZ
cd "$EMSDK_PATH"
./emsdk install 4.0.10
./emsdk activate 4.0.10
# emsdk_env references optional unset variables.
set +u
source "$EMSDK_PATH/emsdk_env.sh"
set -u
emcc --version
cd "$MAXIMA"
./bootstrap
cd "$GNUPLOT_SRCDIR"
./prepare
cd "$MAXIMA/wasm"
# Run the upstream 32-bit host recipe first; a pinned cache can provide it.
make -j2 "$ECL_TO_RUN"
file "$ECL_TO_RUN"
"$ECL_TO_RUN" --norc --eval '(format t "CTM-HOST-ECL|~a|~a~%" (lisp-implementation-version) (integer-length most-positive-fixnum))' --eval '(ext:quit)'
# Select runtime files only: no MathJax/browser UI copies or publication.
targets=(maxima-ecl-combined/maxima.wasm maxima-ecl-combined/libecl.so maxima-ecl-combined/maxima_thread.js maxima-ecl-combined/share_files.js)
for module in slatec quadpack plot solve poisson-series matrix-algebra number-theory limits integration; do
 targets+=("maxima-ecl-combined/maxima-$module.fas")
done
make -j2 "${targets[@]}"
printf 'Build completed: '; date -u +%FT%TZ
