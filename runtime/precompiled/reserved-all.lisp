;;; SPDX-License-Identifier: AGPL-3.0-or-later
;;; Experimental compatibility for pinned Maxima's literal $ALL in $PROPS.
;;; Public kill(all), allbut exclusions and ordinary property cleanup remain.
(in-package :maxima)
(defvar *ctm-reserved-all-original-kill1* nil)
(defvar *ctm-reserved-all-parent* nil)

(defun ctm-reserved-all-kill1 (x)
  (let ((literal-member (and (eq *ctm-reserved-all-parent* '$props) (eq x '$all))))
    (let ((*ctm-reserved-all-parent* x))
      (if literal-member
          ;; Literal property member, not a public wildcard command. Bind its
          ;; own parent context before kill1-atom follows noun/verb partners.
          (unless (and allbutl (member x allbutl :test #'equal))
            (kill1-atom x))
          (funcall *ctm-reserved-all-original-kill1* x)))))

(defun ctm-install-reserved-all-fix ()
  (cond ((eq (symbol-function 'kill1) #'ctm-reserved-all-kill1) '$done)
        (*ctm-reserved-all-original-kill1*
         (error "Reserved-all adapter encountered a different kill1 binding"))
        (t (setf *ctm-reserved-all-original-kill1* (symbol-function 'kill1))
           (setf (symbol-function 'kill1) #'ctm-reserved-all-kill1)
           '$done)))

(defun $ctm_reserved_all_state ()
  (list '(mlist)
        (if (member '$all (cdr $props) :test #'eq) t nil)
        (if (member '$all *builtin-$props* :test #'eq) t nil)
        (cons '(mlist)
              (loop for key in (symbol-plist '$all) by #'cddr
                    collect (if (symbolp key) (symbol-name key) "non-symbol")))))

(ctm-install-reserved-all-fix)

;;; The library explicitly compiles this helper because stacktex.lisp calls its
;;; Lisp binding directly. Keep its interpreted function registration as the
;;; owner of removal; an extra $PROPS entry otherwise kills it even when reset
;;; explicitly preserves $FUNCTIONS. This is an experimental one-symbol policy.
(defun ctm-register-stack-tex-helper ()
  (let ((name '$%_ce_rem))
    (unless (and (fboundp name) (get name 'translated)
                 (mget name 'mexpr)
                 (assoc (list name) (cdr $functions) :test #'equal))
      (error "STACK tex helper lacks compiled/interpreted function ownership"))
    (setq $props (remove name $props :test #'eq))
    '$done))

(defun $ctm_stack_tex_helper_state ()
  (let ((name '$%_ce_rem))
    (list '(mlist) (if (fboundp name) t nil)
          (if (mget name 'mexpr) t nil)
          (if (assoc (list name) (cdr $functions) :test #'equal) t nil)
          (if (member name (cdr $props) :test #'eq) t nil))))
