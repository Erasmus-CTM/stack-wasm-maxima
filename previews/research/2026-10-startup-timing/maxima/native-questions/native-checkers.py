# CTM team, CC BY-SA 4.0. PythonChecker API v1.
from ctm_checkers.stack.checker_api import collection_items

def positive_point(student, teacher, options):
    values = collection_items(student)
    return len(values) == 2 and all(value.is_real is True and value.is_positive is True for value in values)

def positive_x(student, teacher, options):
    values = collection_items(student)
    return len(values) == 2 and values[0].is_real is True and values[0].is_positive is True

def identity_columns(student, teacher, options):
    if student.shape != teacher.shape:
        return {"valid": False, "correct": False, "feedback": "Use a two by two matrix."}
    statuses = ["correct" if student[:, column] == teacher[:, column] else "incorrect" for column in range(student.cols)]
    return {"valid": True, "correct": all(value == "correct" for value in statuses),
            "feedback": "Each column is compared with the identity matrix.", "assessment": {"columns": statuses}}

CHECKERS = {"positive_point": positive_point, "positive_x": positive_x, "identity_columns": identity_columns}
