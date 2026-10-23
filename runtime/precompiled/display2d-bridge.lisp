; SPDX-License-Identifier: AGPL-3.0-or-later
; Dispatch to this process's original assignment hook, never a serialized host
; function. The translation process dynamically binds originals while its
; properties are temporarily symbolic; the target leaves properties unchanged.
(in-package :maxima)
(defvar *ctm-original-assignment-hooks* nil)
(defun ctm-stack-assignment-bridge (variable value)
  (let ((hook (or (cdr (assoc variable *ctm-original-assignment-hooks*))
                  (get variable 'assign))))
    (unless (or (functionp hook)
                (and (symbolp hook) (fboundp hook)
                     (not (eq hook 'ctm-stack-assignment-bridge))))
      (error "No original assignment hook for ~S" variable))
    (funcall hook variable value)))
