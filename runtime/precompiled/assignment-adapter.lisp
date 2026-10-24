; SPDX-License-Identifier: AGPL-3.0-or-later
; Translation-process adapter only. Pinned Maxima/STACK files are unchanged.
(in-package :maxima)
(load (merge-pathnames #P"display2d-bridge.lisp" *load-truename*))
(defun ctm-color-translator-present-p (symbol)
  (loop for tail on (symbol-plist symbol) by #'cddr
        thereis (eq (car tail) 'translate)))

(defun ctm-translate-color-call (form)
  ;; Use Maxima's ordinary apply dispatch for these two STACK TeX constructors.
  ;; mfunction-call warns for their self-bound symbols, contaminating captured
  ;; validation output. A fixed noun constructor would lose author aliases.
  ;; Translate arguments normally so compiled lexical locals remain available.
  ;; Quote the original operator: ordinary function definitions retain priority
  ;; over its value cell, just as in an interpreted call.
  (translate `(($apply) ((mquote) ,(caar form)) ((mlist) ,@(cdr form)))))

(defun ctm-with-color-call-translation (thunk)
  (let ((originals
          (mapcar (lambda (symbol)
                    (list symbol (get symbol 'translate)
                          (ctm-color-translator-present-p symbol)))
                  '($texcolor $texcolorplain))))
    (unwind-protect
         (progn
           (dolist (row originals)
             (setf (get (first row) 'translate) 'ctm-translate-color-call))
           (funcall thunk))
      (dolist (row originals)
        (if (third row)
            (setf (get (first row) 'translate) (second row))
            (remprop (first row) 'translate)))
      (unless (every (lambda (row)
                       (and (eq (get (first row) 'translate) (second row))
                            (eq (ctm-color-translator-present-p (first row))
                                (third row))))
                     originals)
        (error "Translation-process color translators were not restored")))))

(defun ctm-props-registration-p (form)
  (and (consp form)
       (or (and (eq (car form) 'add2lnc) (eq (third form) '$props))
           (ctm-props-registration-p (car form))
           (ctm-props-registration-p (cdr form)))))
(defun ctm-translate-stack-entry (source)
  (let* ((originals nil)
         ($packagefile t))
    (do-symbols (variable (find-package :maxima))
      (when (and (eq (symbol-package variable) (find-package :maxima))
                 (functionp (get variable 'assign)))
        (push (cons variable (get variable 'assign)) originals)))
    (unless (assoc '$display2d originals)
      (error "Expected the pinned display2d hook among adapter inputs"))
    (setf originals (sort originals #'string< :key (lambda (row) (symbol-name (car row)))))
    (let ((*print-length* nil) (*print-level* nil))
      (format t "~&CTM-ASSIGNMENT-HOOKS|~S~%" (mapcar #'car originals)))
    (let ((*ctm-original-assignment-hooks* originals))
      (unwind-protect
           (progn
             (dolist (row originals)
               (setf (get (car row) 'assign) 'ctm-stack-assignment-bridge))
             (let ((result (ctm-with-color-call-translation
                             (lambda () (translate-file source nil)))))
               (with-standard-io-syntax
                 (let ((*package* (find-package :maxima)) (*read-eval* nil)
                       (eof (gensym)) (dependencies nil))
                   (with-open-file (stream (make-pathname :defaults source :type "LISP"))
                     (loop for form = (read stream nil eof) until (eq form eof)
                           do (when (ctm-props-registration-p form)
                                (error "Package entry still registers translated functions in props"))
                              (dolist (dependency '("assessment.mac" "stack_logic.lisp"))
                                (when (equal form (list 'simplify (list '$load dependency)))
                                  (pushnew dependency dependencies :test #'equal)))))
                   (unless (every (lambda (name) (member name dependencies :test #'equal))
                                  '("assessment.mac" "stack_logic.lisp"))
                     (error "Translated entry lost an original runtime dependency load"))))
               (format t "~&CTM-PACKAGE-REGISTRATION-OK~%")
               result))
        (dolist (row originals) (setf (get (car row) 'assign) (cdr row)))
        (unless (every (lambda (row) (eq (get (car row) 'assign) (cdr row))) originals)
          (error "Translation-process assignment hooks were not restored"))))))
