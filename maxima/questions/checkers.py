"""Example author module for PythonChecker API v1 (AGPL-3.0-or-later)."""


def positive_multiple(student, teacher, options):
    if student.is_Integer is not True:
        return {"valid": False, "correct": False, "feedback": "Enter an integer value."}
    correct = student > 0 and student % teacher == 0
    return {"valid": True, "correct": bool(correct),
            "feedback": "" if correct else "Use a positive integer multiple of the given number."}


CHECKERS = {"positive_multiple": positive_multiple}
