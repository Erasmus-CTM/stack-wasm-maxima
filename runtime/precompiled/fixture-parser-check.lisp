; SPDX-License-Identifier: AGPL-3.0-or-later
(in-package :maxima)
(defun ctm-parser-shape (form)
  (if (atom form)
      (if (symbolp form) (string-downcase (symbol-name form)) form)
      (let* ((operator (string-downcase (symbol-name (caar form))))
             (arguments (mapcar #'ctm-parser-shape (cdr form))))
        ; The pinned declarations make these two operators commutative.
        ; Canonicalize only operand order, retaining every grouping boundary.
        (when (member operator '("$nounand" "$nounor") :test #'equal)
          (setf arguments (sort arguments #'string< :key #'prin1-to-string)))
        (cons operator arguments))))
(handler-case
    (progn
      (mfuncall '$batchload (ext:getenv "CTM_PARSER_BOOTSTRAP"))
      (if (equal (ext:getenv "CTM_FIXTURE_MODE") "source")
          (mfuncall '$batchload (ext:getenv "CTM_FIXTURE_SOURCE"))
          (load (ext:getenv "CTM_FIXTURE_LISP")))
      (dolist (case '(( $ctm_parser_probe
                        (($nounor) $p (($nounand) $q $r)))
                      ( $ctm_parser_negated
                        (($nounor) (($nounnot) $p) (($nounand) $q $r)))
                      ( $ctm_parser_grouped
                        (($nounand) (($nounor) $p $q) $r))))
        (let ((actual (ctm-parser-shape (mfuncall (first case) '$p '$q '$r)))
              (expected (ctm-parser-shape (second case))))
          (format t "~&CTM-PARSER-SHAPE|~S|~S~%" (first case) actual)
          (unless (equal actual expected)
            (error "Noun logic parse/precedence/grouping mismatch: ~S / ~S" actual expected))))
      (format t "~&CTM-PARSER-BEHAVIOR-OK|cases=3|precedence=true|grouping=true~%")
      (finish-output)
      (bye 0))
  (error (condition)
    (let ((*print-readably* nil))
      (format *error-output* "~&CTM-PARSER-BEHAVIOR-FAILED|~A~%" condition)
      (finish-output *error-output*))
    (bye 1)))
