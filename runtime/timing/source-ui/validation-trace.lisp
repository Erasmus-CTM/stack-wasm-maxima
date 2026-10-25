(progn
  (defparameter maxima::$ctm_validation_trace "not captured")
  (defun maxima::$ctm_diagnostic_validate (expr lowest teacher options)
    (let ((capturing nil))
      (handler-bind
          ((error
             (lambda (condition)
               (unless capturing
                 (setf capturing t)
                 (unwind-protect
                     (setf maxima::$ctm_validation_trace
                       (or (ignore-errors
                             (with-output-to-string (stream)
                               (let ((*print-level* 5) (*print-length* 8))
                                 (format stream "~A~%" condition)
                                 (let ((top (find-symbol "IHS-TOP" "SI"))
                                       (fun (find-symbol "IHS-FUN" "SI")))
                                   (when (and top fun (fboundp top) (fboundp fun))
                                     (loop for index from (funcall top) downto 0
                                           repeat 100
                                           do (format stream "~D ~S~%" index (funcall fun index))))))))
                           "condition capture failed"))
                   (setf capturing nil))))))
        (maxima::mfuncall 'maxima::$stack_validate expr lowest teacher options))))
  (quote maxima::$done))
