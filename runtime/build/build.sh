#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
export LC_ALL=C
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK="$ROOT/.cache/runtime-build"
MAXIMA="$WORK/sources/maxima"
export ECL_SRCDIR="$WORK/sources/ecl"
export EMSDK_PATH="$WORK/sources/emsdk"
export ECL_TO_RUN="$MAXIMA/wasm/ecl-host/bin/ecl"
mkdir -p "$WORK/logs"
exec > >(tee "$WORK/logs/build.log") 2>&1
printf 'Build started: '; date -u +%FT%TZ
# Use the unchanged upstream recipe for core/share/ECL targets only.
MAKE_RECIPE="$MAXIMA/wasm/Makefile"
mkdir -p "$WORK/build-recipes/maxima/wasm"
cp "$MAKE_RECIPE" "$WORK/build-recipes/maxima/wasm/Makefile"
python "$ROOT/runtime/build/verify-source-state.py" before
test ! -e "$WORK/sources/gnuplot"
test ! -e "$WORK/source-archives/gnuplot.tar"
python "$ROOT/runtime/build/record-environment.py"
python "$ROOT/runtime/build/prepare-toolchain.py"
export EMSDK_KEEP_DOWNLOADS=1
cd "$EMSDK_PATH"
./emsdk install 4.0.10
./emsdk activate 4.0.10
# emsdk_env references optional unset variables.
set +u
source "$EMSDK_PATH/emsdk_env.sh"
set -u
# emsdk clears a variable with this name; the port Makefile requires it.
export EMSDK_PATH="$WORK/sources/emsdk"
emcc --version | tee "$WORK/logs/emcc-version.txt"
"$EMSDK_PATH/upstream/bin/clang" --version | tee "$WORK/logs/clang-version.txt"
"$EMSDK_NODE" --version | tee "$WORK/logs/sdk-node-version.txt"
./emsdk list > "$WORK/logs/emsdk-installed.txt"
cd "$MAXIMA"
./bootstrap
cd "$MAXIMA/wasm"
# Build a fresh host on this cold runner. Bootstrap ECL runs during its own
# build; record the installed host hash before using it for cross compilation.
make -f "$MAKE_RECIPE" -j2 "$ECL_TO_RUN"
sha256sum "$ECL_TO_RUN" > "$WORK/logs/host-ecl.sha256"
file "$ECL_TO_RUN" | tee "$WORK/logs/host-format.txt"
grep -Eq 'ELF 32-bit.*Intel 80386' "$WORK/logs/host-format.txt"
"$ECL_TO_RUN" --norc --eval '(unless (= (integer-length most-positive-fixnum) 29) (ext:quit 65))' --eval '(format t "CTM-HOST-ECL|~a|~a~%" (lisp-implementation-version) (integer-length most-positive-fixnum))' --eval '(ext:quit)'
sha256sum --check "$WORK/logs/host-ecl.sha256"
# Select runtime files only: no MathJax/browser UI copies or publication.
targets=(maxima-ecl-combined/maxima.wasm maxima-ecl-combined/libecl.so maxima-ecl-combined/maxima_thread.js maxima-ecl-combined/share_files.js)
make -f "$MAKE_RECIPE" -j2 "${targets[@]}"
# Upstream Makefile optional targets unnecessarily depend on plot.fasb.
# Their actual pinned ASDF systems depend only on maxima/core. Invoke the
# unmodified upstream cross compiler directly: no fake prerequisite or patch.
for module in slatec quadpack solve poisson-series matrix-algebra number-theory limits integration; do
 "$ECL_TO_RUN" --norc --load build.lisp --eval "(cross-compile-maxima-module \"maxima/$module\")" --eval '(ext:quit)'
 cp "../src/binary-ecl/wasm32-emscripten/maxima/$module.fasb" "maxima-ecl-combined/maxima-$module.fas"
done
test ! -e ../src/binary-ecl/wasm32-emscripten/maxima/plot.fasb
test ! -e maxima-ecl-combined/maxima-plot.fas
test ! -e maxima-ecl-combined/libgnuplot.so
cmp "$MAKE_RECIPE" "$WORK/build-recipes/maxima/wasm/Makefile"
python "$ROOT/runtime/build/verify-source-state.py" after
node "$ROOT/runtime/build/inspect-wasm.mjs" maxima-ecl-combined/maxima.wasm > "$WORK/logs/wasm-memory.json"
printf 'Build completed: '; date -u +%FT%TZ
