#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
export LC_ALL=C
export VERBOSE=1
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
python "$ROOT/runtime/build/apply-build-patches.py"
python "$ROOT/runtime/build/profile.py"
case "${CTM_RUNTIME_PROFILE:-baseline}" in ecl-oz|ecl-o2) export ECL_SRCDIR="$WORK/build-sources/ecl";; esac
MAKE_RECIPE="$WORK/build-recipes/maxima/wasm/Makefile"
python "$ROOT/runtime/build/prepare-toolchain.py"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf 'sdk_cache_ready=true\n' >> "$GITHUB_OUTPUT"; fi
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
cd "$GNUPLOT_SRCDIR"
# The git checkout lacks generated libtool support required by prepare.
libtoolize --copy
./prepare
cd "$MAXIMA/wasm"
# Fail on gnuplot configuration/linking before the longer ECL/Maxima builds.
make -f "$MAKE_RECIPE" -j2 maxima-ecl-combined/libgnuplot.so
# Run the upstream 32-bit host recipe first; a pinned cache can provide it.
make -f "$MAKE_RECIPE" -j2 "$ECL_TO_RUN"
file "$ECL_TO_RUN" | tee "$WORK/logs/host-format.txt"
grep -Eq 'ELF 32-bit.*Intel 80386' "$WORK/logs/host-format.txt"
"$ECL_TO_RUN" --norc --eval '(unless (= (integer-length most-positive-fixnum) 29) (ext:quit 65))' --eval '(format t "CTM-HOST-ECL|~a|~a~%" (lisp-implementation-version) (integer-length most-positive-fixnum))' --eval '(ext:quit)'
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf 'host_cache_ready=true\n' >> "$GITHUB_OUTPUT"; fi
# Select runtime files only: no MathJax/browser UI copies or publication.
targets=(maxima-ecl-combined/maxima.wasm maxima-ecl-combined/libecl.so maxima-ecl-combined/maxima_thread.js maxima-ecl-combined/share_files.js)
for module in slatec quadpack plot solve poisson-series matrix-algebra number-theory limits integration; do
 targets+=("maxima-ecl-combined/maxima-$module.fas")
done
make -f "$MAKE_RECIPE" -j2 "${targets[@]}"
python "$ROOT/runtime/build/check-profile.py"
node "$ROOT/runtime/build/inspect-wasm.mjs" maxima-ecl-combined/maxima.wasm > "$WORK/logs/wasm-memory.json"
printf 'Build completed: '; date -u +%FT%TZ
