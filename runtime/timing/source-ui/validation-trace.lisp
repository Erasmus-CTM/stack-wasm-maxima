(progn
  (defparameter maxima::$ctm_validation_trace "not captured")
  (defvar maxima::$ctm_capture_validation nil)
  (defparameter maxima::*ctm_original_errcatch* (symbol-function 'maxima::errcatch-impl))
  (defun maxima::ctm_capture_condition (condition)
    (when (and (typep condition 'type-error)
               (eq (type-error-datum condition) 'maxima::subr))
      (setf maxima::$ctm_validation_trace
        (or (ignore-errors
              (with-output-to-string (stream)
                (let ((*print-level* 5) (*print-length* 12))
                  (format stream "~A~%MEVAL: ~S~%" condition maxima::*last-meval1-form*)
                  (let ((top (find-symbol "IHS-TOP" "SI"))
                        (fun (find-symbol "IHS-FUN" "SI"))
                        (lex (find-symbol "IHS-LEX" "SI")))
                    (when (and top fun (fboundp top) (fboundp fun))
                      (loop for index from (funcall top) downto 0
                            repeat 100
                            do (format stream "~D ~S ~S~%" index (funcall fun index)
                                       (when (and lex (fboundp lex)) (funcall lex index)))))))))
            "condition capture failed"))))
  (defun maxima::errcatch-impl (closure)
    (funcall maxima::*ctm_original_errcatch*
      (if maxima::$ctm_capture_validation
        (lambda ()
          (handler-bind ((type-error #'maxima::ctm_capture_condition))
            (funcall closure)))
        closure)))
  (quote maxima::$done))
