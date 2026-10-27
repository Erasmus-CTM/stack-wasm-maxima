;;; SPDX-License-Identifier: AGPL-3.0-or-later
;;; Compiled variant. Each frame keeps one fresh cons live across the
;;; recursive call, so when the innermost frame requests a full collection
;;; the C stack holds N distinct pointerful heap objects.
(defun deep (n)
  (let ((x (cons n nil)))
    (if (zerop n)
        (progn (ext:gc t) 0)
        (+ (deep (1- n)) (car x)))))
