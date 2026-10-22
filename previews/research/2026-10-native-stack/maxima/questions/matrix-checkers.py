"""Supplied matrix checks for the common PythonChecker interface.

Each registered function accepts (student, teacher, options) and leaves scoring to PRTs.
Basis and elementary property checks use bounded real rational entries.
Positivity checks also accept rational real and imaginary parts.
"""
import sympy as sp

from ctm_checkers.matrix import assess_basis


def rational_matrix(value):
    if not isinstance(value, sp.MatrixBase):
        raise ValueError("Enter a matrix.")
    if any(entry.is_Rational is not True for entry in value):
        raise ValueError("Use real integers or exact fractions in every cell.")
    if any(max(abs(int(entry.p)).bit_length(), int(entry.q).bit_length()) > 256
           for entry in value):
        raise ValueError("Matrix entries exceed the 256-bit rational bound.")
    return value


def basis(student, teacher, options):
    space = options.get("space")
    # An invalid reference is an author error; invalid student entries are input feedback.
    reference = rational_matrix(teacher)
    rank = reference.rank()
    axis = "rows" if space == "rowspace" else "columns"
    if space == "nullspace":
        dimension, ambient = reference.cols - rank, reference.cols
        belongs = lambda vector: reference * vector == sp.zeros(reference.rows, 1)
        space_name = "null space"
    elif space == "columnspace":
        dimension, ambient = rank, reference.rows
        belongs = lambda vector: reference.row_join(vector).rank() == rank
        space_name = "column space"
    elif space == "rowspace":
        dimension, ambient = rank, reference.cols
        belongs = lambda vector: reference.col_join(vector).rank() == rank
        space_name = "row space"
    else:
        raise ValueError("Choose a null, column or row space.")
    if not dimension:
        raise ValueError("The target space has an empty basis; empty matrix inputs are not yet supported.")
    try:
        submitted = rational_matrix(student)
    except ValueError as exc:
        return {"valid": False, "correct": False, "feedback": str(exc)}
    submitted_ambient = submitted.rows if axis == "columns" else submitted.cols
    result = assess_basis(submitted, axis=axis, target_dimension=int(dimension),
                          name="answer", space_name=space_name,
                          belongs=lambda vector: submitted_ambient == ambient and belongs(vector))
    statuses = result["assessment"]["answer"][axis]
    count = submitted.cols if axis == "columns" else submitted.rows
    return {"valid": True,
            "correct": count == dimension and all(status == "correct" for status in statuses),
            "feedback": result["feedback"], "assessment": {axis: statuses}}


def matrix_property(student, teacher, options):
    property_name = options.get("property")
    if property_name not in {"integer_entries", "determinant", "identity"}:
        raise ValueError("Choose integer_entries, determinant or identity.")
    if property_name == "determinant":
        if (not isinstance(teacher, sp.Rational)
                or max(abs(int(teacher.p)).bit_length(), int(teacher.q).bit_length()) > 256):
            raise ValueError("The expected determinant must be a bounded exact rational number.")
    elif teacher is not sp.true and teacher is not sp.false:
        raise ValueError("The expected property value must be true or false.")
    try:
        matrix = rational_matrix(student)
    except ValueError as exc:
        return {"valid": False, "correct": False, "feedback": str(exc)}
    if property_name == "determinant":
        if matrix.rows != matrix.cols:
            return {"valid": False, "correct": False, "feedback": "A determinant requires a square matrix."}
        actual = matrix.det()
    elif property_name == "integer_entries":
        actual = sp.true if all(entry.q == 1 for entry in matrix) else sp.false
    else:
        actual = sp.true if matrix.rows == matrix.cols and matrix == sp.eye(matrix.rows) else sp.false
    return {"valid": True, "correct": bool(actual == teacher)}


def hermitian(A):
    return A.rows == A.cols and A == A.H


def positive_definite(A):
    if A.rows != A.cols:
        return False
    # Re(z.H*A*z) equals z.H*H*z for real or complex matrices.
    H = (A + A.H) / 2
    return all(H[:k, :k].det() > 0 for k in range(1, H.rows + 1))


def check_property(ansm, expected, property_test, explanation):
    if any(part.is_Rational is not True
           for entry in ansm for part in entry.as_real_imag()):
        return {"valid": False, "correct": False,
                "feedback": "Use integers or exact fractions for the real and imaginary parts."}
    correct = bool(property_test(ansm)) == bool(expected)
    return {"valid": True, "correct": correct,
            "feedback": "" if correct else explanation}


def is_hermitian(ansm, expected, options):
    return check_property(ansm, expected, hermitian,
                          "The Hermitian-symmetry condition does not match the expected result.")


def is_positive_definite(ansm, expected, options):
    return check_property(ansm, expected, positive_definite,
                          "The positive-definiteness condition does not match the expected result.")


def is_hpd(ansm, expected, options):
    return check_property(ansm, expected,
                          lambda A: hermitian(A) and positive_definite(A),
                          "The Hermitian-positive-definiteness condition does not match the expected result.")


CHECKERS = {
    "basis": basis,
    "matrix_property": matrix_property,
    "is_hermitian": is_hermitian,
    "is_positive_definite": is_positive_definite,
    "is_hpd": is_hpd,
}
