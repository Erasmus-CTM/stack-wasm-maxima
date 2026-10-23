; SPDX-License-Identifier: AGPL-3.0-or-later
; Fixture experiment only. Capture the hook belonging to this target process.
(in-package :maxima)
(defparameter *ctm-display2d-hook* (get '$display2d 'assign))
(unless (functionp *ctm-display2d-hook*)
  (error "Expected the pinned compiled display2d assignment hook"))
(defun ctm-display2d-bridge (variable value)
  (funcall *ctm-display2d-hook* variable value))
