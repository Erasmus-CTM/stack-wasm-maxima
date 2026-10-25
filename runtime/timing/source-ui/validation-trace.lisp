(progn
  (defparameter maxima::$ctm_validation_trace "not captured")
  (defparameter maxima::*ctm_original_error_handler* (symbol-function 'si::universal-error-handler))
  (defun maxima::ctm_capture_condition (condition)
    (when (and (typep condition 'type-error)
               (eq (type-error-datum condition) 'maxima::subr))
      (setf maxima::$ctm_validation_trace
        (or (ignore-errors
              (with-output-to-string (stream)
                (let ((*print-level* 5) (*print-length* 12))
                  (format stream "~A~%MEVAL: ~S~%" condition maxima::*last-meval1-form*)
                  (let ((ar maxima::*mlambda-call-stack*))
                    (loop for offset from (- (fill-pointer ar) 5) downto 0 by 5
                          repeat 60
                          do (let ((args (prin1-to-string (aref ar (+ offset 3)))))
                               (format stream "MAXIMA ~S ~S ~A~%" (aref ar (+ offset 4))
                                       (aref ar (+ offset 2))
                                       (subseq args 0 (min 2048 (length args)))))))
                  (let ((top (find-symbol "IHS-TOP" "SI"))
                        (fun (find-symbol "IHS-FUN" "SI"))
                        (lex (find-symbol "IHS-LEX" "SI")))
                    (when (and top fun (fboundp top) (fboundp fun))
                      (loop for index from (funcall top) downto 0
                            repeat 100
                            do (format stream "~D ~S ~S~%" index (funcall fun index)
                                       (when (and lex (fboundp lex)) (funcall lex index)))))))))
            "condition capture failed"))))
  (defun si::universal-error-handler (continue datum arguments)
    (let ((condition (ignore-errors
                       (if (typep datum 'condition) datum
                         (apply #'make-condition datum arguments)))))
      (when condition (maxima::ctm_capture_condition condition)))
    (funcall maxima::*ctm_original_error_handler* continue datum arguments))
  (quote maxima::$done))
