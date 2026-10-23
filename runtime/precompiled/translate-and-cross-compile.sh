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
mkdir -p "$WORK/source" "$WORK/source-adapted" "$WORK/source-initialized" "$WORK/logs"
# Refuse retained generated outputs: a failed attempt must never reuse a bundle.
for output in "$WORK/source/stackmaxima.LISP" "$WORK/source/stackmaxima.lisp" \
  "$WORK/source/ctm-assignment-probe.LISP" "$WORK/source/ctm-reset-probe.LISP" \
  "$WORK/source-adapted/stackmaxima.LISP" "$WORK/source-adapted/stackmaxima.lisp" \
  "$WORK/source-initialized/stackmaxima.LISP" "$WORK/source-initialized/stackmaxima.lisp" \
  "$WORK/source-initialized/parser-declarations.mac" "$WORK/source-initialized/parser-declarations.json" "$WORK/stackmaxima.fas"; do
  if test -e "$output"; then
    echo "Refusing stale experiment output: $output" >&2
    exit 1
  fi
done
if find "$WORK" "$MAXIMA/src/binary-ecl" -type f \( -name 'ctm-stackmaxima.fasb' -o -name 'ctm-stackmaxima.fas' \) -print -quit | grep -q .; then
  echo 'Refusing retained cross-compiler output' >&2
  exit 1
fi
cp "$STACK/stack/maxima/stackmaxima.mac" "$WORK/source/stackmaxima.mac"
sha256sum "$WORK/source/stackmaxima.mac" > "$WORK/logs/stackmaxima-source.sha256"
cat > "$WORK/translate-driver.lisp" <<'EOF'
(in-package :maxima)
(handler-case
    (let* ((source (namestring (merge-pathnames #P"source/stackmaxima.mac" *load-truename*)))
           (result nil))
      (unless (eq (catch 'macsyma-quit
                    (setf result (translate-file source nil))
                    :completed)
                  :completed)
        (error "Maxima aborted translation"))
      (unless (and (listp result) (= (length result) 4)
                   (equal (first result) '(mlist))
                   (stringp (third result))
                   (equal (third result)
                          (namestring (make-pathname :defaults source :type "LISP"))))
        (error "Translator returned no expected Lisp output path: ~S" result))
      (with-standard-io-syntax
        (let ((*package* (find-package :maxima)) (*read-eval* nil)
              (eof (gensym)) (forms 0))
          (with-open-file (stream (third result))
            (loop for form = (read stream nil eof)
                  until (eq form eof) do (incf forms)))
          (unless (plusp forms) (error "Empty translated Lisp"))
          (format t "~&CTM-TRANSLATION-OK|~D~%" forms)))
      (finish-output)
      (bye 0))
  (error (condition)
    (let ((*print-readably* nil))
      (format *error-output* "~&CTM-TRANSLATION-FAILED|~A~%" condition)
      (finish-output *error-output*))
    (bye 1)))
EOF
printf 'ctm_assignment_probe():=block(display2d:false,true)$\n' > "$WORK/source/ctm-assignment-probe.mac"
sed 's/stackmaxima\.mac/ctm-assignment-probe.mac/g' "$WORK/translate-driver.lisp" > "$WORK/assignment-probe-driver.lisp"
if "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/assignment-probe-driver.lisp" 2>&1 | tee "$WORK/logs/assignment-probe.log"; then
  printf 'translation succeeded\n' > "$WORK/logs/assignment-probe-status.txt"
else
  printf 'translation failed\n' > "$WORK/logs/assignment-probe-status.txt"
fi
# A separate minimal translated function tests Maxima's $props/reset hazard.
printf 'ctm_reset_probe(x):=x+1$\n' > "$WORK/source/ctm-reset-probe.mac"
sed 's/stackmaxima\.mac/ctm-reset-probe.mac/g' "$WORK/translate-driver.lisp" > "$WORK/reset-translate-driver.lisp"
cp "$ROOT/runtime/precompiled/reset-probe.lisp" "$WORK/reset-probe.lisp"
reset_ok=false
if "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/reset-translate-driver.lisp" 2>&1 | tee "$WORK/logs/reset-translate.log" &&
  grep -q '^CTM-TRANSLATION-OK|' "$WORK/logs/reset-translate.log" &&
  "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/reset-probe.lisp" 2>&1 | tee "$WORK/logs/reset-probe.log" &&
  grep -q '^CTM-RESET-OK|3$' "$WORK/logs/reset-probe.log"; then
  reset_ok=true
fi
printf '%s\n' "$reset_ok" > "$WORK/logs/reset-probe-status.txt"
# Preserve the unchanged full-entry negative control and demand its known
# readable-function failure; an unrelated control error cannot authorize a bundle.
if "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/translate-driver.lisp" 2>&1 | tee "$WORK/logs/translate.log"; then
  echo 'Unexpected unchanged-entry translation success; review the control' >&2
  exit 1
fi
grep -q '^CTM-TRANSLATION-FAILED|Cannot print object.*readably' "$WORK/logs/translate.log"
cp "$WORK/source/stackmaxima.mac" "$WORK/source-adapted/stackmaxima.mac"
cp "$ROOT/runtime/precompiled/display2d-bridge.lisp" "$WORK/display2d-bridge.lisp"
cp "$ROOT/runtime/precompiled/assignment-adapter.lisp" "$WORK/assignment-adapter.lisp"
cp "$WORK/display2d-bridge.lisp" "$WORK/source-adapted/display2d-bridge.lisp"
{
  printf '(load (merge-pathnames #P"assignment-adapter.lisp" *load-truename*))\n'
  sed -e 's@source/stackmaxima.mac@source-adapted/stackmaxima.mac@g' \
      -e 's@(translate-file source nil)@(ctm-translate-stack-entry source)@g' "$WORK/translate-driver.lisp"
} > "$WORK/adapted-translate-driver.lisp"
# Retain the hook-adapted/no-parser negative control as a separate raw output.
if "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/adapted-translate-driver.lisp" 2>&1 | tee "$WORK/logs/translate-adapted.log"; then
  echo 'Unexpected parser-control success; review translation prerequisites' >&2
  exit 1
fi
grep -q 'nounor is not an infix operator' "$WORK/logs/translate-adapted.log"
python "$ROOT/runtime/precompiled/parser_bootstrap.py" --stack-source "$STACK" --output "$WORK/source-initialized"
cp "$WORK/source/stackmaxima.mac" "$WORK/source-initialized/stackmaxima.mac"
cp "$WORK/display2d-bridge.lisp" "$WORK/source-initialized/display2d-bridge.lisp"
{
  printf '(load (merge-pathnames #P"assignment-adapter.lisp" *load-truename*))\n'
  printf '(in-package :maxima)\n'
  printf '(mfuncall (quote $batchload) (namestring (merge-pathnames #P"source-initialized/parser-declarations.mac" *load-truename*)))\n'
  sed -e 's@source/stackmaxima.mac@source-initialized/stackmaxima.mac@g' \
      -e 's@(translate-file source nil)@(ctm-translate-stack-entry source)@g' "$WORK/translate-driver.lisp"
} > "$WORK/initialized-translate-driver.lisp"
"$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/initialized-translate-driver.lisp" 2>&1 | tee "$WORK/logs/translate-initialized.log"
grep -q '^CTM-TRANSLATION-OK|' "$WORK/logs/translate-initialized.log"
test -s "$WORK/source-initialized/stackmaxima.LISP"
cp "$WORK/source-initialized/stackmaxima.LISP" "$WORK/source-initialized/stackmaxima.lisp"
sha256sum "$WORK/source-initialized/stackmaxima.mac" "$WORK/source-initialized/stackmaxima.LISP" \
  "$WORK/source-initialized/stackmaxima.lisp" "$WORK/source-initialized/display2d-bridge.lisp" \
  "$WORK/source-initialized/parser-declarations.mac" "$WORK/source-initialized/parser-declarations.json" > "$WORK/logs/initialized-source.sha256"
cat > "$WORK/source-initialized/ctm-stackmaxima.asd" <<'EOF'
(asdf:defsystem #:ctm-stackmaxima
  :depends-on (#:maxima/core)
  :serial t
  :components ((:file "display2d-bridge") (:file "stackmaxima")))
EOF
cd "$MAXIMA/wasm"
"$ECL" --norc --load build.lisp \
  --eval "(asdf:load-asd \"$WORK/source-initialized/ctm-stackmaxima.asd\")" \
  --eval '(cross-compile-maxima-module "ctm-stackmaxima")' \
  --eval '(ext:quit)' 2>&1 | tee "$WORK/logs/cross-compile.log"
mapfile -t bundles < <(find "$WORK" "$MAXIMA/src/binary-ecl" -type f \( -name 'ctm-stackmaxima.fasb' -o -name 'ctm-stackmaxima.fas' \) -print)
test "${#bundles[@]}" = 1
cp "${bundles[0]}" "$WORK/stackmaxima.fas"
file "$WORK/stackmaxima.fas" | tee "$WORK/logs/bundle-format.txt"
sha256sum "$WORK/stackmaxima.fas" > "$WORK/logs/stackmaxima-fas.sha256"
python "$ROOT/runtime/build/verify-source-state.py" after
