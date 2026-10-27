;;; Wasm variant, bytecode only. In the -O0 --spill-pointers wasm build each
;;; level of recursion through MAP leaves about 16 distinct pointers on the
;;; shadow stack, enough to overflow the mark stack before ECL's 32 MB C stack
;;; limit (about 440 levels).
(defun deep (n)
  (if (zerop n)
      (progn (ext:gc t) 0)
      (let ((r 0))
        (map nil (lambda (x) (setq r (+ (deep (1- n)) (car x))))
             (vector (cons n nil)))
        r)))
