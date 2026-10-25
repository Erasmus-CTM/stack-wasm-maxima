#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
export LC_ALL=C
# Experiments never inherit hidden compiler overrides from a shell/runner.
unset EMCC_CFLAGS EMCC_DEBUG EMCC_DEBUG_SAVE EMCC_VERBOSE
export VERBOSE=1
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK="$ROOT/.cache/runtime-build"
MAXIMA="$WORK/sources/maxima"
export ECL_SRCDIR="$WORK/sources/ecl"
export EMSDK_PATH="$WORK/sources/emsdk"
export ECL_TO_RUN="$MAXIMA/wasm/ecl-host/bin/ecl"
mkdir -p "$WORK/logs"
exec > >(tee "$WORK/logs/build.log") 2>&1
printf 'Build started: '; date -u +%FT%TZ
# Fail immediately if hosted-runner tracing or its parser is unavailable.
python "$ROOT/runtime/build/test-compiler-evidence.py" --require-strace
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
# CTM_EMSDK selects an experimental toolchain; unset means the pinned release.
EMSDK_VERSION=$(python "$ROOT/runtime/build/toolchain_pins.py")
cd "$EMSDK_PATH"
./emsdk install "$EMSDK_VERSION"
./emsdk activate "$EMSDK_VERSION"
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
# The native compiler was built from original source. Only now derive the
# target ECL source, preserving the unchanged upstream Maxima build inputs.
python "$ROOT/runtime/build/apply-target-overlay.py"
# Select runtime files only: no MathJax/browser UI copies or publication.
# ECL discards successful subprocess stderr. OS exec tracing captures actual
# compiler/Binaryen argv regardless of that redirection; never dump environment.
python "$ROOT/runtime/build/compiler_profile.py" > "$WORK/logs/compiler-profile.json"
ECL_INJECTED_FLAGS=$(python "$ROOT/runtime/build/compiler_profile.py" --emcc-flags)
(
 export EMCC_VERBOSE=1
 if [[ -n "$ECL_INJECTED_FLAGS" ]]; then export EMCC_CFLAGS="$ECL_INJECTED_FLAGS"; else unset EMCC_CFLAGS; fi
 # Keep each target's printed command and diagnostics together. Interleaving
 # a parallel warning with another command makes strict trace association fail.
 strace -f -qq -e trace=execve -e signal=none -s 1048576 -o "$WORK/logs/ecl-exec.log" make --output-sync=target -f "$MAKE_RECIPE" -j2 ecl-emscripten
) 2>&1 | tee "$WORK/logs/ecl-cross-build.log"
cat "$WORK/logs/ecl-exec.log" >> "$WORK/logs/ecl-cross-build.log"
# Target-info carries raw upstream CFLAGS, not the injected experiment. Keep
# it unchanged so Maxima still uses its original generated-Lisp optimization.
unset EMCC_CFLAGS
export EMCC_VERBOSE=1
build_maxima_phase() {
targets=(maxima-ecl-combined/maxima.wasm maxima-ecl-combined/libecl.so maxima-ecl-combined/maxima_thread.js maxima-ecl-combined/share_files.js)
make --output-sync=target -f "$MAKE_RECIPE" -j2 "${targets[@]}" || exit $?
# Upstream Makefile optional targets unnecessarily depend on plot.fasb.
# Their actual pinned ASDF systems depend only on maxima/core. Invoke the
# unmodified upstream cross compiler directly: no fake prerequisite or patch.
for module in slatec quadpack solve poisson-series matrix-algebra number-theory limits integration; do
 "$ECL_TO_RUN" --norc --load build.lisp --eval "(cross-compile-maxima-module \"maxima/$module\")" --eval '(ext:quit)' || exit $?
 cp "../src/binary-ecl/wasm32-emscripten/maxima/$module.fasb" "maxima-ecl-combined/maxima-$module.fas" || exit $?
done
}
export MAKE_RECIPE ECL_TO_RUN
export -f build_maxima_phase
strace -f -qq -e trace=execve -e signal=none -s 1048576 -o "$WORK/logs/maxima-exec.log" bash -euo pipefail -c build_maxima_phase 2>&1 | tee "$WORK/logs/maxima-cross-build.log"
cat "$WORK/logs/maxima-exec.log" >> "$WORK/logs/maxima-cross-build.log"
unset -f build_maxima_phase
unset EMCC_VERBOSE
python "$ROOT/runtime/build/check-compiler-experiment.py"
test ! -e ../src/binary-ecl/wasm32-emscripten/maxima/plot.fasb
test ! -e maxima-ecl-combined/maxima-plot.fas
test ! -e maxima-ecl-combined/libgnuplot.so
cmp "$MAKE_RECIPE" "$WORK/build-recipes/maxima/wasm/Makefile"
sha256sum --check "$WORK/logs/host-ecl.sha256"
python "$ROOT/runtime/build/verify-source-state.py" after --target-overlay
node "$ROOT/runtime/build/inspect-wasm.mjs" maxima-ecl-combined/maxima.wasm > "$WORK/logs/wasm-memory.json"
printf 'Build completed: '; date -u +%FT%TZ
