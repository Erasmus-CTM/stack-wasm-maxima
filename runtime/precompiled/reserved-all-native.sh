#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK="$ROOT/.cache/precompiled-fixtures/reserved-all"
export MAXIMA_PREFIX="$ROOT/.cache/runtime-build/sources/maxima/wasm/maxima-ecl-combined"
NATIVE="$MAXIMA_PREFIX/bin/maxima"
mkdir -p "$WORK"
# Preserve useful failure output without hiding the command's exit status.
trap 'status=$?; if (( status != 0 )); then for log in "$WORK/negative.log" "$WORK/positive.log" "$WORK/helper.log"; do if [[ -f "$log" ]]; then cat "$log"; fi; done; fi; exit "$status"' EXIT
cp "$ROOT/runtime/precompiled/reserved-all.lisp" "$WORK/adapter.lisp"
cat > "$WORK/negative.mac" <<'EOF'
declare(all,constant)$
texput(all,"R")$
remove(all,constant)$
ctm_negative_result:errcatch(kill(allbut[functions]))$
if ctm_negative_result#[] then error("Expected bounded original recursion")$
if ctm_native_recursion_depth()<32 then error("Original recursion was not reached")$
print("CTM-RESERVED-ALL-NEGATIVE-RECURSION")$
EOF
cat > "$WORK/negative-driver.lisp" <<'EOF'
(in-package :maxima)
(defparameter *ctm-original-kill1* (symbol-function 'kill1))
(defparameter *ctm-reserved-all-depth* 0)
(defparameter *ctm_reserved_all_max_depth* 0)
(defun $ctm_native_recursion_depth () *ctm_reserved_all_max_depth*)
(setf (symbol-function 'kill1)
 (lambda (x)
  (let ((*ctm-reserved-all-depth* (1+ *ctm-reserved-all-depth*)))
   (setf *ctm_reserved_all_max_depth* (max *ctm_reserved_all_max_depth* *ctm-reserved-all-depth*))
   (when (> *ctm-reserved-all-depth* 32) (merror "CTM bounded original kill recursion"))
   (funcall *ctm-original-kill1* x))))
(mfuncall '$batchload (namestring (merge-pathnames #P"negative.mac" *load-truename*)))
(setf (symbol-function 'kill1) *ctm-original-kill1*)
(ext:quit)
EOF
cat > "$WORK/positive.mac" <<'EOF'
ctm_kept(x):=x+1$
ctm_dropped:37$
declare(all,constant)$
texput(all,"R")$
kill(allbut[functions])$
if not is(ctm_dropped='ctm_dropped) then error("allbut failed to clear variable")$
if not is(ctm_kept(41)=42) then error("allbut failed to preserve function")$
if featurep(all,constant) then error("Literal all feature survived cleanup")$
if not is(ctm_literal_all_texword()=absent) then error("Literal all texword survived cleanup")$
kill(all)$
declare(all,constant)$
texput(all,"R")$
kill(allbut[functions,all])$
if not is(ctm_literal_all_texword()="R") then error("allbut literal-all exclusion failed")$
ctm_scope:99$
kill(props)$
if not is(ctm_scope=99) then error("kill(props) expanded into kill(all)")$
if not is(ctm_literal_all_texword()=absent) then error("kill(props) failed literal texword cleanup")$
print("CTM-RESERVED-ALL-POSITIVE-CONTROLS-OK")$
EOF
cat > "$WORK/positive-driver.lisp" <<'EOF'
(in-package :maxima)
(load (merge-pathnames #P"adapter.lisp" *load-truename*))
(defun $ctm_literal_all_texword () (or (get '$all 'texword) '$absent))
(let ((installed (symbol-function 'kill1)))
 (ctm-install-reserved-all-fix)
 (assert (eq installed (symbol-function 'kill1))))
(mfuncall '$batchload (namestring (merge-pathnames #P"positive.mac" *load-truename*)))
(assert (not (mget '$ctm_kept 'mexpr)))
(format t "CTM-RESERVED-ALL-NATIVE-OK~%")
(ext:quit)
EOF
cat > "$WORK/helper-driver.lisp" <<'EOF'
(in-package :maxima)
(load (merge-pathnames #P"adapter.lisp" *load-truename*))
;; Synthetic functions test ownership, not the real helpers' mathematics.
(defun ctm-define-helper-fixtures (&optional (names *ctm-stack-compiled-helpers*))
 (dolist (name names)
  (let ((spelling (if (eq name 'texnumformat) "?texnumformat" (string-downcase (subseq (symbol-name name) 1)))))
   (mfuncall '$eval_string (format nil "~A(x):=x+1" spelling))
   (mfuncall '$eval_string (format nil "compile(~A)" spelling)))))
(ctm-define-helper-fixtures)
(mfuncall '$eval_string "ctm_unrelated_compiled(x):=x+2")
(mfuncall '$eval_string "compile(ctm_unrelated_compiled)")
(dolist (name *ctm-stack-compiled-helpers*) (assert (member name (cdr $props) :test #'eq)))
(assert (member '$ctm_unrelated_compiled (cdr $props) :test #'eq))
;; Missing ownership must reject without partially editing $PROPS.
(let ((prior (copy-tree $props))
      (definition (mget 'texnumformat 'mexpr))
      (rejected nil))
 (unwind-protect
  (progn
   (mremprop 'texnumformat 'mexpr)
   (handler-case (ctm-register-stack-library-helpers) (error () (setq rejected t)))
   (assert rejected)
   (assert (equal prior $props)))
  (mputprop 'texnumformat definition 'mexpr)))
(ctm-register-stack-library-helpers)
(let ((bindings (mapcar #'symbol-function *ctm-stack-compiled-helpers*)))
 (dotimes (iteration 3)
  (mfuncall '$eval_string "ctm_helper_sentinel:37")
  (mfuncall '$eval_string "kill(allbut[functions])")
  (assert (eq (meval '$ctm_helper_sentinel) '$ctm_helper_sentinel))
  (si:gc t)
  (loop for name in *ctm-stack-compiled-helpers* for binding in bindings do
   (assert (eq binding (symbol-function name)))
   (assert (= (mfuncall name 41) 42)))
  (assert (not (fboundp '$ctm_unrelated_compiled)))))
(mfuncall '$eval_string "kill(functions)")
(dolist (name *ctm-stack-compiled-helpers*)
 (assert (not (fboundp name))) (assert (not (mget name 'mexpr))))
(ctm-define-helper-fixtures)
(ctm-register-stack-library-helpers)
(mfuncall '$eval_string "kill(all)")
(dolist (name *ctm-stack-compiled-helpers*)
 (assert (not (fboundp name))) (assert (not (mget name 'mexpr))))
;; A packagefile DEFMTRFUN has Lisp/translated ownership without infolists.
(ctm-define-helper-fixtures (remove 'texnumformat *ctm-stack-compiled-helpers*))
(eval '(defmtrfun (texnumformat $any mdefine nil nil) ($x) (add $x 1)))
(compile 'texnumformat)
(assert (not (mget 'texnumformat 'mexpr)))
(assert (not (assoc '(texnumformat) (cdr $functions) :test #'equal)))
(assert (not (member 'texnumformat (cdr $props) :test #'eq)))
(let ((rejected nil))
 (handler-case (ctm-register-stack-library-helpers nil) (error () (setq rejected t)))
 (assert rejected))
(ctm-register-stack-library-helpers t)
(let ((bindings (mapcar #'symbol-function *ctm-stack-compiled-helpers*)))
 (dotimes (iteration 3)
  (mfuncall '$eval_string "ctm_helper_sentinel:37")
  (mfuncall '$eval_string "kill(allbut[functions])")
  (assert (eq (meval '$ctm_helper_sentinel) '$ctm_helper_sentinel))
  (si:gc t)
  (loop for name in *ctm-stack-compiled-helpers* for binding in bindings do
   (assert (eq binding (symbol-function name)))
   (assert (= (mfuncall name 41) 42)))))
(mfuncall '$eval_string "kill(functions)")
(assert (= (mfuncall 'texnumformat 41) 42))
(mfuncall '$eval_string "kill(all)")
(assert (= (mfuncall 'texnumformat 41) 42))
(mfuncall '$eval_string "kill(?texnumformat)")
(assert (not (fboundp 'texnumformat)))
(format t "CTM-STACK-TEX-HELPER-REGISTRATION-NATIVE-OK~%")
(ext:quit)
EOF
timeout 60 "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/negative-driver.lisp" > "$WORK/negative.log" 2>&1
grep -q 'CTM-RESERVED-ALL-NEGATIVE-RECURSION' "$WORK/negative.log"
timeout 60 "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/positive-driver.lisp" > "$WORK/positive.log" 2>&1
grep -q '^CTM-RESERVED-ALL-NATIVE-OK' "$WORK/positive.log"
timeout 60 "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/helper-driver.lisp" > "$WORK/helper.log" 2>&1
grep -q '^CTM-STACK-TEX-HELPER-REGISTRATION-NATIVE-OK' "$WORK/helper.log"
sha256sum "$WORK/"*.lisp "$WORK/"*.mac "$WORK/"*.log > "$WORK/sha256.txt"
cat "$WORK/negative.log" "$WORK/positive.log" "$WORK/helper.log"
