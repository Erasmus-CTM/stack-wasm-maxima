;;; SPDX-License-Identifier: AGPL-3.0-or-later
;;; Interpreted variant, needs no C compiler. MAPCAR is implemented in C and
;;; holds its fresh argument and result lists in C locals while it calls the
;;; function, so every level of recursion leaves distinct conses on the C
;;; stack even when DEEP itself runs as bytecode.
(defun deep (n)
  (if (zerop n)
      (progn (ext:gc t) 0)
      (car (mapcar (lambda (x) (+ (deep (1- n)) (car x)))
                   (list (cons n nil))))))
