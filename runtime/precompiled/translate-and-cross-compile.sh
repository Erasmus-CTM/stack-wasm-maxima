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
"$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/translate-driver.lisp" 2>&1 | tee "$WORK/logs/translate.log"
grep -q '^CTM-TRANSLATION-OK|' "$WORK/logs/translate.log" || {
  echo 'Maxima translation did not emit a complete source success marker' >&2
  exit 1
}
# The pinned Maxima translator writes .LISP (and .UNLISP warnings) on Linux.
# Keep its raw output, then copy to ASDF's conventional lowercase source name.
if test -s "$WORK/source/stackmaxima.LISP"; then
  cp "$WORK/source/stackmaxima.LISP" "$WORK/source/stackmaxima.lisp"
elif ! test -s "$WORK/source/stackmaxima.lisp"; then
  echo 'Maxima translation did not produce stackmaxima.LISP or stackmaxima.lisp' >&2
  exit 1
fi
test -s "$WORK/source/stackmaxima.lisp"
if test -s "$WORK/source/stackmaxima.LISP"; then
  sha256sum "$WORK/source/stackmaxima.LISP" > "$WORK/logs/stackmaxima-translator-output.sha256"
fi
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
