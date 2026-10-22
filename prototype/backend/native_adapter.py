"""Native STACK answer tests inside the existing CTM question controller.

This prototype deliberately retains CTM's parser, validation, frozen values,
PRT scoring, CAStext rendering and PythonChecker implementation. Only the
ordinary answer-test callback is replaced. It is not a Moodle PHP controller.
"""
# SPDX-License-Identifier: AGPL-3.0-or-later
from __future__ import annotations

import json
import re

from ctm_checkers.stack import assessment, checkers, engine
from ctm_checkers.stack.expressions import (
    AUTHOR_BASIS_FUNCTIONS, AUTHOR_COLLECTION_FUNCTIONS, FUNCTION_ALIASES,
    MAX_CHARS, Node, SCALAR_FUNCTIONS, Unsupported, evaluate, parse,
)

TESTS = frozenset({"AlgEquiv", "Sets", "SameType", "EqualComAss", "FacForm",
                   "SingleFrac", "LowestTerms", "NumAbsolute", "NumRelative", "NumDecPlaces"})
_NAME = re.compile(r"[A-Za-z_][A-Za-z_0-9]*\Z", re.ASCII)
_NUMBER = re.compile(r"(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\Z", re.ASCII)
_CONSTANTS = {"i": "%i", "%i": "%i", "e": "%e", "%e": "%e",
              "pi": "%pi", "Pi": "%pi", "PI": "%pi", "%pi": "%pi"}
_FUNCTIONS = frozenset(SCALAR_FUNCTIONS) | {"gcd", "mod", "matrix"}
_HELPERS = AUTHOR_COLLECTION_FUNCTIONS | AUTHOR_BASIS_FUNCTIONS | {
    "diff", "expand", "factor", "ratsimp", "cancel", "ev", "float", "lcm",
    "num", "denom", "decimalplaces", "dispdp", "displaydp", "significantfigures", "dispsf",
}
_CONTROLLED_AT_ERROR = re.compile(
    r"(?:AT[A-Za-z0-9]+_STACKERROR_(?:SAns|TAns|Opt|Raw|tol)"
    r"|ATNumDecPlaces_OptNotInt|STACKERROR_OPTION)\."
)
_installed = False


def maxima_source(node: Node | str, env=None, assumptions=None) -> str:
    """Serialize CTM's bounded AST, never interpolate unchecked learner text.

    Author bindings are inserted as their already frozen CTM values. Held
    lists, sets, equations and matrices retain the source vocabulary shared
    by CTM and Maxima. Parentheses preserve the submitted operation tree.
    """
    node = parse(node) if isinstance(node, str) else node
    env = env or {}
    assumptions = assumptions or {}
    budget = [0]

    def value_source(value, depth):
        # The same serializer used by CTM's frozen variants and question tests.
        return visit(parse(engine._source(value)), {}, depth + 1)

    def visit(current, bindings, depth):
        budget[0] += 1
        if not isinstance(current, Node) or depth > 60 or budget[0] > 2000:
            raise Unsupported("Maxima transport expression exceeds the AST bound")
        kind, value, children = current.kind, current.value, current.children
        if kind == "number" and _NUMBER.fullmatch(value):
            return value
        if kind == "boolean" and value in {"true", "false"}:
            return value
        if kind == "name":
            if value in _CONSTANTS:
                return _CONSTANTS[value]
            if value in bindings:
                return value_source(bindings[value], depth)
            if _NAME.fullmatch(value):
                return value
        elif kind in {"list", "set"}:
            left, right = ("[", "]") if kind == "list" else ("{", "}")
            return left + ",".join(visit(c, bindings, depth + 1) for c in children) + right
        elif kind == "unary" and value in {"+", "-"} and len(children) == 1:
            return "(" + value + visit(children[0], bindings, depth + 1) + ")"
        elif kind == "binary" and value in {"+", "-", "*", "/", "^", "**"} and len(children) == 2:
            operator = "^" if value == "**" else value
            return "(" + visit(children[0], bindings, depth + 1) + operator + visit(children[1], bindings, depth + 1) + ")"
        elif kind == "equation" and len(children) == 2:
            return "(" + visit(children[0], bindings, depth + 1) + "=" + visit(children[1], bindings, depth + 1) + ")"
        elif kind == "logical":
            if value == "not" and len(children) == 1:
                return "(not " + visit(children[0], bindings, depth + 1) + ")"
            if value in {"and", "or", "xor", "xnor", "implies"} and len(children) >= 2:
                return "(" + (" " + value + " ").join(visit(c, bindings, depth + 1) for c in children) + ")"
        elif kind == "index":
            return value_source(evaluate(current, bindings, assumptions=assumptions), depth)
        elif kind == "call":
            name = FUNCTION_ALIASES.get(value, value)
            if name in _FUNCTIONS:
                return name + "(" + ",".join(visit(c, bindings, depth + 1) for c in children) + ")"
            if value in _HELPERS:
                # CTM's author-only helpers have one implementation. Resolve
                # them in the existing frozen context before native dispatch.
                return value_source(evaluate(current, bindings, assumptions=assumptions), depth)
        raise Unsupported(f"Expression node {kind!r}/{value!r} is outside the Maxima transport subset")

    result = visit(node, env, 0)
    if len(result) > 20000:
        raise Unsupported("Maxima transport expression exceeds the source bound")
    return result


def request_for(name, student, teacher, options="", *, env=None, raw=None, assumptions=None):
    """Build one native AT request after CTM's bounded mathematical admission."""
    if name not in TESTS:
        raise Unsupported(f"Native Maxima answer test {name!r} is unsupported")
    env = env or {}
    assumptions = assumptions or {}
    student_ast = parse(student) if isinstance(student, str) else student
    teacher_ast = parse(teacher)
    # Reuse the grammar and computation bounds already used by CTM; never
    # call the SymPy answer-test verdict as a native fallback.
    evaluate(student_ast, env, assumptions=assumptions, student=True)
    evaluate(teacher_ast, env, assumptions=assumptions)
    option_source = str(options or "")
    if name in {"NumAbsolute", "NumRelative"}:
        option_source = assessment.numeric_option_source(option_source)
    if option_source.strip():
        option_ast = parse(option_source)
        evaluate(option_ast, env, assumptions=assumptions)
        option_source = maxima_source(option_ast, env, assumptions)
    if raw is None:
        raw = student if isinstance(student, str) else maxima_source(student_ast, env, assumptions)
    if not isinstance(raw, str) or len(raw) > max(MAX_CHARS, 20000):
        raise Unsupported("Raw answer exceeds the Maxima transport bound")
    return {
        "test": name,
        "student": maxima_source(student_ast, env, assumptions),
        "teacher": maxima_source(teacher_ast, env, assumptions),
        "options": option_source,
        "raw": raw,
        "assumptions": {"positive": bool(assumptions.get("positive")), "real": bool(assumptions.get("real"))},
    }


def install(assess_json, on_event=None):
    """Install the native seam once in this worker's private CTM interpreter.

    assess_json is synchronous: JSON request -> JSON native result. The JS
    implementation waits on separate SAB response memory written by the CAS
    child, rather than needing this blocked Python worker's message loop.
    """
    global _installed
    if _installed:
        raise RuntimeError("The native Maxima adapter is already installed")

    def emit(event):
        if on_event is not None:
            try:
                on_event(json.dumps(event))
            except Exception:
                pass  # Diagnostics never change the mathematical result.

    def native_answer_test(name, student, teacher, options="", *, env=None, raw=None,
                           assumptions=None, python_checkers=None):
        request = request_for(name, student, teacher, options, env=env, raw=raw, assumptions=assumptions)
        response_text = assess_json(json.dumps(request, separators=(",", ":")))
        if not isinstance(response_text, str):
            raise RuntimeError("Maxima assessor must return synchronous JSON text")
        result = json.loads(response_text)
        if (not isinstance(result, dict) or type(result.get("cas_valid")) is not bool
                or type(result.get("correct")) is not bool
                or not isinstance(result.get("answer_note", ""), (str, list))):
            raise RuntimeError("Malformed native Maxima answer-test result")
        note = result.get("answer_note", "")
        notes = note if isinstance(note, list) else [note]
        if any(not isinstance(item, str) for item in notes):
            raise RuntimeError("Malformed native Maxima answer notes")
        if (not result["cas_valid"] and not result["correct"]
                and any(_CONTROLLED_AT_ERROR.search(item) for item in notes)):
            raise RuntimeError("Native STACK answer-test error: " + " ".join(notes))
        feedback = result.get("feedback", "")
        if not isinstance(feedback, str):
            raise RuntimeError("Malformed native Maxima feedback")
        # Translate the native diagnostic key into CTM's existing feedback
        # wording. This never recomputes the native verdict; the unmodified
        # stack_trans payload remains in the worker's nativeFeedback event.
        note_tokens = {token.strip() for item in notes for token in item.split(".")}
        if (name == "NumDecPlaces" and result["cas_valid"] and not result["correct"]
                and "ATNumDecPlaces_Wrong_DPs" in note_tokens and not feedback):
            feedback = "Incorrect number of decimal places"
        # Native cas_valid denotes AT applicability, not input validity.
        # CTM's validated ordinary wrong answer follows its authored false
        # branch even when STACK's first AT flag is false.
        return {"valid": True, "cas_valid": result["cas_valid"], "correct": result["correct"],
                "note": note, "feedback": feedback}

    original_invoke = checkers.invoke

    def observed_python_checker(*args, **kwargs):
        result = original_invoke(*args, **kwargs)
        emit({"event": "python-checker", "checker": str(args[1] if len(args) > 1 else kwargs.get("options", "")),
              "valid": bool(result.get("valid")), "correct": bool(result.get("correct"))})
        return result

    engine.answer_test = native_answer_test
    checkers.invoke = observed_python_checker
    _installed = True

