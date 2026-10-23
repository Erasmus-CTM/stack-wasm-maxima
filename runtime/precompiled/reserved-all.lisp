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

;;; Exact interactive compile targets in the two pinned STACK libraries.
;;; Registration happens once at trusted startup, before any question programs.
;;; $FUNCTIONS owns their removal; duplicate $PROPS ownership defeats
;;; kill(allbut[functions]). Validate every target before changing any list.
(defparameter *ctm-stack-compiled-helpers*
  '($safe_op $op_usedp $zip_with $count_op $scientific_notation $%_ce_rem texnumformat))

(defun $ctm_stack_helper_state ()
  (cons '(mlist)
    (mapcar (lambda (name)
      (list '(mlist) (symbol-name name)
        (if (fboundp name) t nil)
        (if (and (fboundp name) (compiled-function-p (symbol-function name))) t nil)
        (if (get name 'translated) t nil)
        (if (mget name 'mexpr) t nil)
        (if (assoc (list name) (cdr $functions) :test #'equal) t nil)
        (if (member name (cdr $props) :test #'eq) t nil)))
      *ctm-stack-compiled-helpers*)))

(defvar *ctm-stack-helper-registration-before* nil)
(defun ctm-register-stack-library-helpers (&optional compiled-entry)
  (setq *ctm-stack-helper-registration-before* ($ctm_stack_helper_state))
  (dolist (name *ctm-stack-compiled-helpers*)
    (unless (or (and (fboundp name) (get name 'translated)
                     (mget name 'mexpr)
                     (assoc (list name) (cdr $functions) :test #'equal))
                ;; The packagefile entry defines this function directly; its
                ;; caught interactive compile has no interpreted definition.
                ;; Only the explicit compiled-entry mode admits this ownership.
                (and (eq compiled-entry t) (eq name 'texnumformat)
                     (fboundp name) (compiled-function-p (symbol-function name))
                     (get name 'translated) (not (mget name 'mexpr))
                     (not (assoc (list name) (cdr $functions) :test #'equal))
                     (not (member name (cdr $props) :test #'eq))))
      (error "STACK helper ~S lacks translated/interpreted function ownership" name)))
  (setq $props (remove-if (lambda (name) (member name *ctm-stack-compiled-helpers* :test #'eq)) $props))
  '$done)

(defun $ctm_stack_helper_registration_before () *ctm-stack-helper-registration-before*)

(defun $ctm_register_stack_library_helpers (compiled-entry)
  (ctm-register-stack-library-helpers compiled-entry))
