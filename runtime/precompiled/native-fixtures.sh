#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Native-only diagnostic arms; this neither builds nor selects a browser bundle.
set -euo pipefail
export LC_ALL=C
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK="$ROOT/.cache/precompiled-fixtures"
MAXIMA="$ROOT/.cache/runtime-build/sources/maxima"
export ECL_SRCDIR="$ROOT/.cache/runtime-build/sources/ecl"
export ECL_TO_RUN="$MAXIMA/wasm/ecl-host/bin/ecl"
MODE=${1:-standalone}
[[ $# -le 1 && ( "$MODE" == standalone || "$MODE" == --reuse-built-native ) ]] || { echo "Invalid fixture mode" >&2; exit 64; }
test ! -e "$WORK"
mkdir -p "$WORK/logs"
exec > >(tee "$WORK/logs/fixtures.log") 2>&1
export MAXIMA_PREFIX="$MAXIMA/wasm/maxima-ecl-combined"
NATIVE="$MAXIMA_PREFIX/bin/maxima"
if [[ "$MODE" == --reuse-built-native ]]; then
  # Preserve the cold build's provenance; never bootstrap an already-built tree.
  test -x "$ECL_TO_RUN" && test -x "$NATIVE"
  sha256sum --check "$ROOT/.cache/runtime-build/logs/host-ecl.sha256"
  mkdir "$WORK/provenance"
  for phase in before after; do
    report="$ROOT/.cache/runtime-build/logs/source-state-$phase.json"
    python - "$report" "$phase" <<'VERIFY'
import json,sys
from pathlib import Path
report=json.loads(Path(sys.argv[1]).read_text())
assert report['schema']==1 and report['passed'] is True and report['phase']==sys.argv[2]
assert {s['name'] for s in report['sources']}=={'maxima','ecl'}
VERIFY
    cp "$report" "$WORK/provenance/"
    sha256sum "$report" >> "$WORK/provenance/original-reports.sha256"
  done
  python "$ROOT/runtime/build/verify-source-state.py" after
  sha256sum --check "$WORK/provenance/original-reports.sha256"
else
  python "$ROOT/runtime/build/verify-source-state.py" before
  cd "$MAXIMA"
  ./bootstrap
  cd wasm
  # Exact native prerequisites from the unmodified pinned upstream Makefile.
  make -f Makefile -j2 "$ECL_TO_RUN" maxima-ecl-combined/share
fi
"$ECL_TO_RUN" --norc --eval '(unless (= (integer-length most-positive-fixnum) 29) (ext:quit 65))' --eval '(ext:quit)'
sha256sum "$ECL_TO_RUN" "$NATIVE" > "$WORK/logs/native-executables.sha256"
export CTM_FIXTURE_PARSER=false
export CTM_FIXTURE_BRIDGE_FILE="$ROOT/runtime/precompiled/display2d-bridge.lisp"
for arm in assignment-control assignment-bridge reset-control reset-package; do
  mkdir "$WORK/$arm"
  export CTM_FIXTURE_BRIDGE=false CTM_FIXTURE_PACKAGE=false
  export CTM_FIXTURE_SOURCE="$WORK/$arm/fixture.mac"
  export CTM_FIXTURE_LISP="$WORK/$arm/fixture.LISP"
  if [[ "$arm" == assignment-* ]]; then
    printf 'ctm_fixture_assignment(v):=block([display2d:true],display2d:v,display2d)$\n' > "$CTM_FIXTURE_SOURCE"
  else
    printf 'ctm_reset_probe(x):=x+1$\n' > "$CTM_FIXTURE_SOURCE"
  fi
  [[ "$arm" != assignment-bridge ]] || export CTM_FIXTURE_BRIDGE=true
  [[ "$arm" != reset-package ]] || export CTM_FIXTURE_PACKAGE=true
  if "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$ROOT/runtime/precompiled/fixture-translate.lisp" > "$WORK/$arm/translate.log" 2>&1; then
    grep -q '^CTM-FIXTURE-TRANSLATION-OK|' "$WORK/$arm/translate.log"
    echo translated > "$WORK/$arm/translation-status.txt"
  else
    echo failed > "$WORK/$arm/translation-status.txt"
  fi
  if [[ "$arm" == assignment-* ]]; then
    for mode in source compiled; do
      export CTM_FIXTURE_MODE="$mode"
      if [[ "$mode" == source || -s "$CTM_FIXTURE_LISP" ]] &&
        "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$ROOT/runtime/precompiled/fixture-assignment-check.lisp" > "$WORK/$arm/check-$mode.log" 2>&1 &&
        grep -q '^CTM-ASSIGNMENT-BEHAVIOR-OK|' "$WORK/$arm/check-$mode.log"; then
        echo passed > "$WORK/$arm/check-$mode-status.txt"
      else
        echo failed > "$WORK/$arm/check-$mode-status.txt"
      fi
    done
  else
    # Existing reset checker resolves its translated fixture beside the driver.
    mkdir "$WORK/$arm/source"
    cp "$ROOT/runtime/precompiled/reset-probe.lisp" "$WORK/$arm/reset-probe.lisp"
    if [[ -s "$CTM_FIXTURE_LISP" ]]; then
      cp "$CTM_FIXTURE_LISP" "$WORK/$arm/source/ctm-reset-probe.LISP"
    fi
    if "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/$arm/reset-probe.lisp" > "$WORK/$arm/reset.log" 2>&1 &&
      grep -q '^CTM-RESET-OK|3$' "$WORK/$arm/reset.log"; then
      echo passed > "$WORK/$arm/reset-status.txt"
    else
      echo failed > "$WORK/$arm/reset-status.txt"
    fi
  fi
done
cd "$ROOT"
python runtime/precompiled/parser_bootstrap.py \
  --stack-source "$ROOT/.cache/precompiled-stack/upstream-stack" --output "$WORK/parser-input"
export CTM_PARSER_BOOTSTRAP="$WORK/parser-input/parser-declarations.mac"
for arm in parser-control parser-bootstrap; do
  mkdir "$WORK/$arm"
  export CTM_FIXTURE_BRIDGE=false CTM_FIXTURE_PACKAGE=true CTM_FIXTURE_PARSER=false
  export CTM_FIXTURE_SOURCE="$WORK/$arm/fixture.mac"
  export CTM_FIXTURE_LISP="$WORK/$arm/fixture.LISP"
  cat > "$CTM_FIXTURE_SOURCE" <<'PARSER'
ctm_parser_probe(p,q,r):=p nounor q nounand r$
ctm_parser_negated(p,q,r):=nounnot p nounor q nounand r$
ctm_parser_grouped(p,q,r):=(p nounor q) nounand r$
PARSER
  [[ "$arm" != parser-bootstrap ]] || export CTM_FIXTURE_PARSER=true
  if "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$ROOT/runtime/precompiled/fixture-translate.lisp" > "$WORK/$arm/translate.log" 2>&1; then
    grep -q '^CTM-FIXTURE-TRANSLATION-OK|' "$WORK/$arm/translate.log"
    echo translated > "$WORK/$arm/translation-status.txt"
  else
    echo failed > "$WORK/$arm/translation-status.txt"
  fi
  if [[ "$arm" == parser-bootstrap ]]; then
    for mode in source compiled; do
      export CTM_FIXTURE_MODE="$mode"
      if "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$ROOT/runtime/precompiled/fixture-parser-check.lisp" > "$WORK/$arm/check-$mode.log" 2>&1 &&
        grep -q '^CTM-PARSER-BEHAVIOR-OK|' "$WORK/$arm/check-$mode.log"; then
        echo passed > "$WORK/$arm/check-$mode-status.txt"
      else
        echo failed > "$WORK/$arm/check-$mode-status.txt"
      fi
    done
  fi
done
mkdir "$WORK/color-input"
cp "$ROOT/runtime/precompiled/assignment-adapter.lisp" "$WORK/color-input/"
cp "$ROOT/runtime/precompiled/display2d-bridge.lisp" "$WORK/color-input/"
export CTM_COLOR_ADAPTER="$WORK/color-input/assignment-adapter.lisp"
export CTM_COLOR_TEX="$WORK/color-input/stacktex.lisp"
# Preserve the actual pinned printer and decolouring definition as fixture inputs.
python - "$ROOT/.cache/precompiled-stack/upstream-stack" "$WORK/color-input" <<'COLOR_INPUT'
import json,hashlib,subprocess,sys
from pathlib import Path
stack,out=map(Path,sys.argv[1:])
pin='33383047af39c204bf4442802a058f8b918b2b1b'
assert subprocess.check_output(['git','-C',str(stack),'rev-parse','HEAD'],text=True).strip()==pin
inputs=[]
for name in ('stacktex.lisp','stackmaxima.mac'):
    path='stack/maxima/'+name
    body=(stack/path).read_bytes()
    assert body==subprocess.check_output(['git','-C',str(stack),'show',pin+':'+path])
    inputs.append({'path':path,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()})
    if name=='stacktex.lisp': (out/name).write_bytes(body)
    else:
        start=b'detexcolor(ex) := block([argsex],'
        assert body.count(start)==1
        at=body.index(start)
        end=body.index(b'\n)$',at)+3
        (out/'detexcolor.mac').write_bytes(body[at:end]+b'\n')
(out/'inputs.json').write_text(json.dumps({'stackRevision':pin,'inputs':inputs},indent=2)+'\n')
COLOR_INPUT
cat > "$WORK/color-input/translate.lisp" <<'COLOR_TRANSLATE'
(in-package :maxima)
(handler-case
    (let* ((source (ext:getenv "CTM_FIXTURE_SOURCE"))
           (adapted (equal (ext:getenv "CTM_COLOR_ADAPTED") "true"))
           ($packagefile t) (result nil))
      (load (ext:getenv "CTM_COLOR_ADAPTER"))
      (when adapted
        ;; Absent, present NIL and present non-NIL properties must all survive.
        (remprop '$texcolor 'translate)
        (setf (get '$texcolorplain 'translate) nil)
        (setf (get '$nounor 'translate) 'ctm-color-fixture-sentinel)
        (ctm-with-stack-noun-call-translation (lambda () :normal))
        (unless (and (not (ctm-stack-noun-translator-present-p '$texcolor))
                     (ctm-stack-noun-translator-present-p '$texcolorplain)
                     (null (get '$texcolorplain 'translate))
                     (eq (get '$nounor 'translate) 'ctm-color-fixture-sentinel))
          (error "Normal color translation changed property presence"))
        (setf (get '$texcolor 'translate) 'ctm-color-fixture-sentinel)
        (remprop '$texcolorplain 'translate)
        (setf (get '$nounor 'translate) nil)
        (unless (eq (catch 'ctm-color-fixture-escape
                      (ctm-with-stack-noun-call-translation
                       (lambda () (throw 'ctm-color-fixture-escape :escaped))))
                    :escaped)
          (error "Color translation swallowed a nonlocal exit"))
        (let ((caught nil))
          (handler-case
              (ctm-with-stack-noun-call-translation (lambda () (error "deliberate fixture failure")))
            (error (condition)
              (unless (search "deliberate fixture failure" (princ-to-string condition))
                (error "Color translation replaced the fixture error"))
              (setf caught t)))
          (unless caught (error "Color translation swallowed the fixture error")))
        (unless (and (eq (get '$texcolor 'translate) 'ctm-color-fixture-sentinel)
                     (not (ctm-stack-noun-translator-present-p '$texcolorplain))
                     (ctm-stack-noun-translator-present-p '$nounor)
                     (null (get '$nounor 'translate)))
          (error "Exceptional color translation failed to restore properties"))
        (remprop '$texcolor 'translate)
        (remprop '$nounor 'translate))
      (unless (eq (catch 'macsyma-quit
                    (setf result (if adapted
                                     (ctm-with-stack-noun-call-translation
                                      (lambda () (translate-file source nil)))
                                     (translate-file source nil)))
                    :completed)
                  :completed)
        (error "Color fixture translation aborted"))
      (unless (and (listp result) (= (length result) 4)
                   (equal (third result) (ext:getenv "CTM_FIXTURE_LISP"))
                   (not (ctm-stack-noun-translator-present-p '$texcolor))
                   (not (ctm-stack-noun-translator-present-p '$texcolorplain))
                   (not (ctm-stack-noun-translator-present-p '$nounor)))
        (error "Color fixture translation result/restoration mismatch"))
      (format t "~&CTM-COLOR-TRANSLATION-OK|adapted=~S|restored=true~%" adapted)
      (finish-output) (bye 0))
  (error (condition)
    (let ((*print-readably* nil))
      (format *error-output* "~&CTM-COLOR-TRANSLATION-FAILED|~A~%" condition)
      (finish-output *error-output*))
    (bye 1)))
COLOR_TRANSLATE
cat > "$WORK/color-input/check.lisp" <<'COLOR_CHECK'
(in-package :maxima)
(defvar $ctm_color_captured)
(defvar $ctm_color_argument_reads)
(defun ctm-color-shape (form)
  (if (atom form) form (cons (caar form) (mapcar #'ctm-color-shape (cdr form)))))
(defun ctm-color-capture (label form)
  (let (($ctm_color_captured nil)
        (path (concatenate 'string (ext:getenv "CTM_COLOR_OUTPUT") "/" label ".txt")))
    (meval `(($with_stdout) ,path ((msetq) $ctm_color_captured ,form)))
    (with-open-file (stream path)
      (let ((text (make-string (file-length stream))))
        (read-sequence text stream)
        (values $ctm_color_captured text)))))
(defun ctm-color-silent (label form expected)
  (multiple-value-bind (value output) (ctm-color-capture label form)
    (unless (and (zerop (length output))
                 (equal (ctm-color-shape value) (ctm-color-shape expected)))
      (error "Color fixture ~A: value ~S expected ~S; captured ~S" label value expected output))
    value))
(handler-case
    (let* ((sourcep (equal (ext:getenv "CTM_FIXTURE_MODE") "source"))
           (adapted (equal (ext:getenv "CTM_COLOR_ADAPTED") "true"))
           ($simp t) ($tr_warn_bad_function_calls t))
      ;; Load only the four pinned color-printer forms. The full STACK file also
      ;; replaces unrelated core functions whose dependencies are absent here.
      (let ((seen nil) (eof (gensym)) (*read-eval* nil))
        (with-open-file (stream (ext:getenv "CTM_COLOR_TEX"))
          (loop for form = (read stream nil eof) until (eq form eof)
                do (when (and (consp form)
                              (or (and (eq (first form) 'defun)
                                       (member (second form) '(tex-texcolor tex-texcolorplain))
                                       (equal (third form) '(x l r)))
                                  (equal form '(defprop $texcolor tex-texcolor tex))
                                  (equal form '(defprop $texcolorplain tex-texcolorplain tex))))
                     (let ((key (second form)))
                       (when (member key seen) (error "Duplicate pinned color printer form"))
                       (push key seen))
                     (eval form))))
        (unless (and (= (length seen) 4)
                     (every (lambda (name) (member name seen))
                            '(tex-texcolor tex-texcolorplain $texcolor $texcolorplain)))
          (error "Pinned color printer forms were not all loaded")))
      (if sourcep (mfuncall '$batchload (ext:getenv "CTM_FIXTURE_SOURCE"))
          (load (ext:getenv "CTM_FIXTURE_LISP")))
      ;; This is the exact value-cell state produced by translated detexcolor.
      ;; Do not warm the functions or reset warning history before this check.
      (dolist (symbol '($texcolor $texcolorplain))
        (unless (and (not (assoc symbol *tr-runtime-warned*))
                     (not (get symbol 'punt-nil-warnp))
                     (not (get symbol 'undefined-warnp)))
          (error "Color first-call check is not fresh"))
        (setf (symbol-value symbol) symbol))
      (loop for probe in '($ctm_color_probe $ctm_color_plain_probe)
            for symbol in '($texcolor $texcolorplain)
            for label in '("first-color" "first-plain")
            for color in '("red" "blue")
            for tex in '("{\\color{red}{\\underline{42}}}" "{\\color{blue}{42}}")
            do (multiple-value-bind (value output)
                   (ctm-color-capture label `((,probe) ,color 41))
                 (unless (equal (ctm-color-shape value) (list symbol color 42))
                   (error "Color call lost its evaluated local argument"))
                 (if (and (not sourcep) (not adapted))
                     (unless (and (search "has a function or macro call which has not been translated properly." output)
                                  (search "If you want the value of the function name, use `apply'" output)
                                  (eq (cdr (assoc symbol *tr-runtime-warned*)) 'punt-nil))
                       (error "Original translation did not reproduce the exact first-call warning"))
                     (unless (zerop (length output)) (error "Adapted/source first call printed ~S" output)))
                 ;; Exercise the pinned TeX printer itself. STACK's replacement
                 ;; tex1 also needs utils.mac helpers, outside this minimal fixture.
                 (let ((rendered (reduce #'strcat (tex value nil nil 'mparen 'mparen))))
                   (unless (equal rendered tex)
                     (error "Pinned color TeX printer changed: ~S" rendered)))
                 (unless (= (mfuncall '$detexcolor value) 42)
                   (error "Pinned detexcolor did not recover the argument"))))
      (when (and (not sourcep) (not adapted))
        (format t "~&CTM-COLOR-CONTROL-REPRODUCED|first-calls=2|warning=punt-nil~%")
        (finish-output) (bye 0))
      ;; Define a separately interpreted source reference after the first-call
      ;; checks. Dynamic aliases/lambdas/functions must match it, not a noun stub.
      (mfuncall '$eval_string "ctm_color_reference(c,v):=block([localvalue:v+1],texcolor(c,localvalue))")
      (mfuncall '$eval_string "ctm_color_plain_reference(c,v):=block([localvalue:v+1],texcolorplain(c,localvalue))")
      (mfuncall '$eval_string "ctm_color_held_reference(c,v):=texcolor(c,v)")
      (mfuncall '$eval_string "ctm_color_plain_held_reference(c,v):=texcolorplain(c,v)")
      (loop for probe in '($ctm_color_probe $ctm_color_plain_probe)
            for reference in '($ctm_color_reference $ctm_color_plain_reference)
            for held-probe in '($ctm_color_held $ctm_color_plain_held)
            for held-reference in '($ctm_color_held_reference $ctm_color_plain_held_reference)
            for symbol in '($texcolor $texcolorplain)
            for other in '($texcolorplain $texcolor)
            for prefix in '("color" "plain")
            do (flet ((check (label)
                        (ctm-color-silent
                         (concatenate 'string prefix "-" label)
                         `((,probe) "red" 41)
                         (mfuncall reference "red" 41))))
                 (makunbound symbol)
                 (check "unbound")
                 (setf (symbol-value symbol) symbol)
                 ;; Test held argument transport directly. Arithmetic in a
                 ;; translated v+1 body has separate upstream simplification rules.
                 (let (($simp nil))
                   (ctm-color-silent
                    (concatenate 'string prefix "-held")
                    `((,held-probe) "red" ((mplus) 41 1))
                    (mfuncall held-reference "red" '((mplus) 41 1))))
                 (progv (list symbol) (list other) (check "symbol-alias"))
                 (progv (list symbol)
                        (list (mfuncall '$eval_string "lambda([c,v],v+10)"))
                   (unless (= (check "lambda") 52) (error "Color lambda was not applied")))
                 (mfuncall '$eval_string
                           (concatenate 'string (string-downcase (subseq (symbol-name symbol) 1))
                                        "(c,v):=v+20"))
                 (unless (= (check "function") 62) (error "Color function was not applied"))
                 (progv (list symbol) (list other)
                   (unless (= (check "function-and-alias") 62)
                     (error "Color value alias overrode the original function")))
                 (mremprop symbol 'mexpr)))
      (setf $ctm_color_argument_reads 0)
      (ctm-color-silent "argument-once" '(($ctm_color_once) "red" 41) '(($texcolor) "red" 42))
      (unless (= $ctm_color_argument_reads 1) (error "Color argument evaluated more than once"))
      (unless (and $tr_warn_bad_function_calls
                   (every (lambda (symbol) (not (assoc symbol *tr-runtime-warned*)))
                          '($texcolor $texcolorplain)))
        (error "Color calls changed the warning policy or warning history"))
      ;; A third ordinary unresolved function retains Maxima's warning policy.
      (multiple-value-bind (value output)
          (ctm-color-capture "unrelated-warning" '(($ctm_color_unknown) 41))
        (unless (equal (ctm-color-shape value) '($ctm_color_untranslated 41))
          (error "Unrelated unresolved call changed"))
        (if sourcep
            (unless (zerop (length output)) (error "Source unresolved call printed a warning"))
            (unless (and $tr_warn_bad_function_calls
                         (search "has a function or macro call which has not been translated properly." output)
                         (assoc '$ctm_color_untranslated *tr-runtime-warned*))
              (error "Color adapter suppressed unrelated translation warnings"))))
      (format t "~&CTM-COLOR-BEHAVIOR-OK|first-calls=2|dispatch-cases=12|argument-once=true|warnings-retained=true~%")
      (finish-output) (bye 0))
  (error (condition)
    (let ((*print-readably* nil))
      (format *error-output* "~&CTM-COLOR-BEHAVIOR-FAILED|~A~%" condition)
      (finish-output *error-output*))
    (bye 1)))
COLOR_CHECK
for arm in color-control color-apply; do
  mkdir "$WORK/$arm"
  export CTM_COLOR_ADAPTED=false
  [[ "$arm" != color-apply ]] || export CTM_COLOR_ADAPTED=true
  export CTM_FIXTURE_SOURCE="$WORK/$arm/fixture.mac"
  export CTM_FIXTURE_LISP="$WORK/$arm/fixture.LISP"
  cat > "$CTM_FIXTURE_SOURCE" <<'COLOR_SOURCE'
ctm_color_argument_reads:0$
ctm_color_probe(c,v):=block([localvalue:v+1],texcolor(c,localvalue))$
ctm_color_plain_probe(c,v):=block([localvalue:v+1],texcolorplain(c,localvalue))$
ctm_color_held(c,v):=texcolor(c,v)$
ctm_color_plain_held(c,v):=texcolorplain(c,v)$
ctm_color_once(c,v):=texcolor(c,(ctm_color_argument_reads:ctm_color_argument_reads+1,v+1))$
ctm_color_unknown(v):=ctm_color_untranslated(v)$
COLOR_SOURCE
  cat "$WORK/color-input/detexcolor.mac" >> "$CTM_FIXTURE_SOURCE"
  if "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/color-input/translate.lisp" > "$WORK/$arm/translate.log" 2>&1 &&
    grep -q '^CTM-COLOR-TRANSLATION-OK|' "$WORK/$arm/translate.log"; then
    echo translated > "$WORK/$arm/translation-status.txt"
  else
    echo failed > "$WORK/$arm/translation-status.txt"
  fi
  for mode in source compiled; do
    export CTM_FIXTURE_MODE="$mode" CTM_COLOR_OUTPUT="$WORK/$arm/$mode"
    mkdir "$CTM_COLOR_OUTPUT"
    marker='^CTM-COLOR-BEHAVIOR-OK|'
    [[ "$arm/$mode" != color-control/compiled ]] || marker='^CTM-COLOR-CONTROL-REPRODUCED|'
    if [[ "$mode" == source || -s "$CTM_FIXTURE_LISP" ]] &&
      "$NATIVE" --very-quiet --quit-on-error --batch-lisp="$WORK/color-input/check.lisp" > "$WORK/$arm/check-$mode.log" 2>&1 &&
      grep -q "$marker" "$WORK/$arm/check-$mode.log"; then
      echo passed > "$WORK/$arm/check-$mode-status.txt"
    else
      echo failed > "$WORK/$arm/check-$mode-status.txt"
    fi
  done
done
python runtime/build/verify-source-state.py after
if [[ "$MODE" == --reuse-built-native ]]; then
  sha256sum --check "$WORK/provenance/original-reports.sha256"
  sha256sum --check "$ROOT/.cache/runtime-build/logs/host-ecl.sha256"
fi
sha256sum --check "$WORK/logs/native-executables.sha256"
python - <<'PY'
import hashlib,json
from pathlib import Path
root=Path('.cache/precompiled-fixtures')
report={'schema':1,'scope':'Native fixture experiments only; no browser bundle, parity or speedup established','arms':{}}
for arm in ('assignment-control','assignment-bridge','reset-control','reset-package','parser-control','parser-bootstrap','color-control','color-apply'):
    directory=root/arm
    report['arms'][arm]={p.name:p.read_text().strip() for p in directory.glob('*status.txt')}
report['files']=[{'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(root.rglob('*')) if p.is_file() and p != root/'logs/fixtures.log']
(root/'report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
a=report['arms']
assert a['assignment-control']['translation-status.txt']=='failed'
assert 'Cannot print object' in (root/'assignment-control/translate.log').read_text()
assert all(a[x]['check-source-status.txt']=='passed' for x in ('assignment-control','assignment-bridge'))
assert a['assignment-bridge']['translation-status.txt']=='translated'
assert a['assignment-bridge']['check-compiled-status.txt']=='passed'
assert a['reset-control']['translation-status.txt']=='translated'
assert a['reset-control']['reset-status.txt']=='failed'
reset_control=(root/'reset-control/reset.log').read_text()
assert 'CTM-RESET-PRECHECK-OK|42' in reset_control and 'CTM-RESET-CLEARED|0' in reset_control
assert a['reset-package']['translation-status.txt']=='translated'
assert a['reset-package']['reset-status.txt']=='passed'
assert a['parser-control']['translation-status.txt']=='failed'
assert 'nounor is not an infix operator' in (root/'parser-control/translate.log').read_text()
assert a['parser-bootstrap']['translation-status.txt']=='translated'
assert all(a['parser-bootstrap']['check-'+mode+'-status.txt']=='passed' for mode in ('source','compiled'))
for arm in ('color-control','color-apply'):
    assert a[arm]['translation-status.txt']=='translated'
    assert all(a[arm]['check-'+mode+'-status.txt']=='passed' for mode in ('source','compiled'))
PY
