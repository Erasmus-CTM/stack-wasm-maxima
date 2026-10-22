"""Decode native mathematical values for the existing PythonChecker v1 API.

This module owns no checker implementation and awards no marks. The native
response-tree continuation supplies evaluated values; ctm-checkers converts
them into its immutable public vocabulary and validates the checker result.
"""
# SPDX-License-Identifier: AGPL-3.0-or-later
from __future__ import annotations

import json
import sys

import sympy as sp

from ctm_checkers.stack.checkers import CheckerError, invoke
from ctm_checkers.stack.expressions import (
    Equation, HeldList, HeldSet, InvalidAnswer, Logical, MatrixValue,
    Unsupported, evaluate,
)

REQUEST_VARIABLE = "_ctm_native_python_request"
VALUE_TYPES = frozenset({"scalar", "matrix", "list", "set", "equation", "logical"})


def _reject_constant(value):
    raise ValueError(f"{value} is not a JSON value")


def _kind(value):
    if isinstance(value, MatrixValue):
        return "matrix"
    if isinstance(value, (list, HeldList)):
        return "list"
    if isinstance(value, HeldSet):
        return "set"
    if isinstance(value, Equation):
        return "equation"
    if isinstance(value, Logical) or value is sp.true or value is sp.false:
        return "logical"
    if isinstance(value, sp.Expr):
        return "scalar"
    raise CheckerError("Native PythonChecker value is outside the v1 mathematical vocabulary")


def decode_value(value, field):
    """Admit canonical Maxima source using CTM's bounded parser, never eval.

    JSON objects and strings are not implicit PythonChecker API extensions.
    Native author expressions may extract mathematical values from JSON first.
    The declared type is checked after parsing so a matrix cannot silently
    become a list, or a symbolic proposition an arithmetic scalar.
    """
    if (type(value) is not dict or set(value) != {"source", "type"}
            or not isinstance(value.get("type"), str) or value["type"] not in VALUE_TYPES):
        raise CheckerError(f"Native PythonChecker {field} requires a supported mathematical type and source")
    source = value["source"]
    if not isinstance(source, str):
        raise CheckerError(f"Native PythonChecker {field} source must be text")
    try:
        # student=True selects the same mathematical function vocabulary used
        # for ordinary learner values, excluding author evaluation helpers.
        decoded = evaluate(source, student=True)
    except (InvalidAnswer, Unsupported, TypeError, ValueError, ZeroDivisionError) as exc:
        raise CheckerError(f"Native PythonChecker {field} cannot be decoded: {exc}") from exc
    observed = _kind(decoded)
    if observed != value["type"]:
        raise CheckerError(f"Native PythonChecker {field} type mismatch: declared {value['type']}, decoded {observed}")
    return decoded


def call(request):
    """Invoke exactly one named checker without a grading/controller fallback."""
    if (type(request) is not dict
            or set(request) != {"descriptor", "options", "student", "teacher"}):
        raise CheckerError("Native PythonChecker request requires descriptor, options, student and teacher")
    student = decode_value(request["student"], "student")
    teacher = decode_value(request["teacher"], "teacher")
    return invoke(request["descriptor"], request["options"], student, teacher)


def call_json(text):
    if not isinstance(text, str) or len(text.encode("utf-8")) > 256 * 1024:
        raise CheckerError("Native PythonChecker request must be JSON text of at most 256 KiB")
    try:
        request = json.loads(text, parse_constant=_reject_constant)
    except (TypeError, ValueError) as exc:
        raise CheckerError("Native PythonChecker request is not valid JSON") from exc
    # The browser runtime supplies its existing interpreter guard. CPython
    # reference calls need no browser-global interpreter state to restore.
    guard = sys.modules.get("_ctm_guard")
    snapshot, restore = (guard.snapshot, guard.restore) if guard is not None else (None, None)
    state = snapshot() if snapshot is not None else None
    try:
        result = call(request)
        return json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    finally:
        if restore is not None:
            restore(state)


def call_from_globals(namespace):
    # Remove the shared request before executing trusted author checker code.
    # An exception cannot leave the previous card's request for the next call.
    return call_json(namespace.pop(REQUEST_VARIABLE))
