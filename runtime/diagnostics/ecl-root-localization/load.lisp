;;; SPDX-License-Identifier: CC0-1.0
;;; Run with an unmodified, dynamically linked ECL and a directory containing
;;; module-00001.so ... module-NNNNN.so. No direct collector API calls.
(let* ((directory (or (ext:getenv "ECL_ROOT_TEST_DIRECTORY")
                      (error "ECL_ROOT_TEST_DIRECTORY is required")))
       (count (parse-integer (or (ext:getenv "ECL_ROOT_TEST_COUNT") "4200")))
       (same (equal (ext:getenv "ECL_ROOT_TEST_SAME_LIBRARY") "1")))
  (unless (<= 1 count 10000) (error "Count must be between 1 and 10000"))
  (format t "~&ECL-ROOT-LOCALIZATION version=~A machine=~A count=~D same=~A~%"
          (lisp-implementation-version) (machine-type) count same)
  (finish-output)
  (loop for i from 1 to count
        for number = (if same 1 i)
        for name = (format nil "~A/module-~5,'0D.so" directory number)
        do (unless (probe-file name) (error "Missing library ~A" name))
           (si:load-foreign-module name)
           ;; Use ECL's ordinary collection entry, without replacing callbacks,
           ;; altering the mark stack or modifying ECL's library list.
           (when (zerop (mod i 25))
             (format t "loaded=~D collecting~%" i)
             (finish-output)
             (si:gc t)))
  (si:gc t)
  (format t "~&ECL-ROOT-LOCALIZATION completed=~D~%" count)
  (finish-output))
