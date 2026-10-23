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
if featurep(all,constant) then error("Literal all properties survived cleanup")$
kill(all)$
declare(all,constant)$
texput(all,"R")$
kill(allbut[functions,all])$
if not is(ctm_literal_all_texword()="R") then error("allbut literal-all exclusion failed")$
ctm_scope:99$
kill(props)$
if not is(ctm_scope=99) then error("kill(props) expanded into kill(all)")$
if featurep(all,constant) then error("kill(props) failed literal cleanup")$
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
;; A one-symbol registration fixture, not an implementation of STACK's helper.
(mfuncall '$eval_string "%_ce_rem(x):=x+1")
(mfuncall '$eval_string "compile(%_ce_rem)")
(mfuncall '$eval_string "ctm_unrelated_compiled(x):=x+2")
(mfuncall '$eval_string "compile(ctm_unrelated_compiled)")
(assert (member '$%_ce_rem (cdr $props) :test #'eq))
(assert (member '$ctm_unrelated_compiled (cdr $props) :test #'eq))
(ctm-register-stack-tex-helper)
(let ((binding (symbol-function '$%_ce_rem)))
 (dotimes (iteration 3)
  (mfuncall '$eval_string "ctm_helper_sentinel:37")
  (mfuncall '$eval_string "kill(allbut[functions])")
  (assert (eq (meval '$ctm_helper_sentinel) '$ctm_helper_sentinel))
  (si:gc t)
  (assert (eq binding (symbol-function '$%_ce_rem)))
  (assert (= (mfuncall '$%_ce_rem 41) 42))
  (assert (not (fboundp '$ctm_unrelated_compiled)))))
(mfuncall '$eval_string "kill(functions)")
(assert (not (fboundp '$%_ce_rem)))
(assert (not (mget '$%_ce_rem 'mexpr)))
(let ((rejected nil))
 (handler-case (ctm-register-stack-tex-helper) (error () (setq rejected t)))
 (assert rejected))
(mfuncall '$eval_string "%_ce_rem(x):=x+1")
(mfuncall '$eval_string "compile(%_ce_rem)")
(ctm-register-stack-tex-helper)
(mfuncall '$eval_string "kill(all)")
(assert (not (fboundp '$%_ce_rem)))
(assert (not (mget '$%_ce_rem 'mexpr)))
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
