#!/usr/bin/env python3
"""Compile reviewed STACK XML structure for native Wasm preparation.

This stage reads author code but never evaluates it. Every prepared value is
computed by the native backend in build-site.mjs. The existing CTM XML reader
still validates response-tree structure and the supported input settings.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import html
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
STACK_REVISION = "33383047af39c204bf4442802a058f8b918b2b1b"
CHECKERS_REVISION = "c366f175aba6b62caa628bc60f57bb1167fc087b"
JSXGRAPH_REVISION = "ba2daa52fa6b1c65b37322bca3f02643e31a688e"
UPSTREAM = "samplequestions/stacklibrary/Doc-Examples/Specialist-Tools-Docs/JSXgraphs/"
BOARD = re.compile(r"\[\[jsxgraph\b((?:\"[^\"]*\"|'[^']*'|[^\]])*)\]\](.*?)\[\[/jsxgraph\]\]", re.S)
ESCAPE = re.compile(r"\[\[escape\s+value=([\"'])(.*?)\1\s*/\]\]", re.S)
TOKEN = re.compile(r"\{@(.*?)@\}|\{#(.*?)#\}", re.S)
ATTR = re.compile(r"([A-Za-z][A-Za-z0-9_-]*)\s*=\s*([\"'])(.*?)\2", re.S)
COMMENT = re.compile(r"/\*.*?\*/", re.S)
CHECKER_SOURCE = '''# CTM team, CC BY-SA 4.0. PythonChecker API v1.
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
'''


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def checked_revision(path: Path, expected: str) -> Path:
    path = path.resolve()
    actual = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    if actual != expected:
        raise ValueError(f"Expected {expected} at {path}, got {actual}")
    return path


def source_bytes(root: Path, path: str) -> bytes:
    source = root / path
    return source.read_bytes() if source.is_file() else subprocess.check_output(["git", "-C", str(root), "show", f"HEAD:{path}"])


def local_names(source: str) -> list[str]:
    source = COMMENT.sub("", source)
    # The supported author subset has top-level assignments. Nested lambda
    # variables are already scoped by Maxima; function definitions and global
    # assignment syntax are not admitted by this build adapter.
    if re.search(r"\b[A-Za-z]\w*\s*\([^;]*?\)\s*:=|::", source):
        raise ValueError("Native question functions/global assignments are outside the prepared author subset")
    names = re.findall(r"(?:^|[;$])\s*([A-Za-z][A-Za-z0-9_]*)\s*:(?!=)", source)
    if len(names) != len(set(names)):
        raise ValueError("Reassigned author variables are outside the prepared subset")
    return names


def subelement(parent, tag, value):
    node = ET.SubElement(parent, tag)
    node.text = str(value)
    return node


def authored_question(name, prompt, teacher, *, input_type="algebraic", variables="", mixed=False, python=None, matrix=False):
    quiz = ET.Element("quiz")
    q = ET.SubElement(quiz, "question", type="stack")
    subelement(subelement(q, "name", ""), "text", name)
    for field, value in (("questiontext", prompt), ("generalfeedback", ""), ("specificfeedback", "[[feedback:prt1]]"),
                         ("questionnote", ""), ("questionvariables", variables)):
        subelement(subelement(q, field, ""), "text", value)
    for field, value in (("questionsimplify", 1), ("defaultgrade", 1), ("penalty", 0.1)):
        subelement(q, field, value)
    inp = ET.SubElement(q, "input")
    for field, value in (("name", "ans"), ("type", input_type), ("tans", teacher), ("strictsyntax", 1),
                         ("insertstars", 0), ("forbidfloat", 0), ("checkanswertype", 1), ("mustverify", 1), ("showvalidation", 1)):
        subelement(inp, field, value)
    prt = ET.SubElement(q, "prt")
    for field, value in (("name", "prt1"), ("value", 1), ("autosimplify", 1)):
        subelement(prt, field, value)

    def node(identifier, test, student, target, options, true, false):
        n = ET.SubElement(prt, "node")
        for field, value in (("name", identifier), ("answertest", test), ("sans", student), ("tans", target), ("testoptions", options)):
            subelement(n, field, value)
        for branch, spec in (("true", true), ("false", false)):
            for field, value in zip(("scoremode", "score", "nextnode", "answernote"), spec):
                subelement(n, branch + field, value)
            subelement(subelement(n, branch + "feedback", ""), "text", "")

    if mixed:
        node(0, "AlgEquiv", "ans[2]", "2", "", ("=", ".5", 1, "native-y-T"), ("=", "0", 1, "native-y-F"))
        node(1, "PythonChecker", "ans", teacher, '{"checker":"positive_x"}', ("+", ".25", 2, "python-x-T"), ("+", "0", 2, "python-x-F"))
        node(2, "AlgEquiv", "ans[1]", "2", "", ("+", ".25", -1, "native-x-T"), ("+", "0", -1, "native-x-F"))
        cases = [('[2,2]', 1, "native-y-T | python-x-T | native-x-T"),
                 ('[2,3]', .5, "native-y-F | python-x-T | native-x-T"),
                 ('[-1,3]', 0, "native-y-F | python-x-F | native-x-F")]
    elif python:
        node(0, "PythonChecker", "ans", teacher, json.dumps({"checker": python}),
             ("=", 1, -1, "python-T"), ("=", 0, -1, "python-F"))
        cases = [(teacher, 1, "python-T"), ('matrix([1,1],[0,1])' if matrix else '[-1,1]', 0, "python-F")]
    else:
        node(0, "AlgEquiv", "ans", teacher, "", ("=", 1, -1, "native-T"), ("=", 0, -1, "native-F"))
        cases = [(teacher, 1, "native-T"), ('matrix([1,1],[0,1])' if matrix else '0', 0, "native-F")]
    for index, (answer, score, note) in enumerate(cases, 1):
        test = ET.SubElement(q, "qtest")
        subelement(test, "testcase", index)
        subelement(subelement(test, "testinput", ""), "name", "ans")
        subelement(test.find("testinput"), "value", answer)
        expected = ET.SubElement(test, "expected")
        for field, value in (("name", "prt1"), ("expectedscore", score), ("expectedpenalty", 0 if score == 1 else .1), ("expectedanswernote", note)):
            subelement(expected, field, value)
    return ET.tostring(quiz, encoding="utf-8", xml_declaration=True)


POINT_PROMPT = '''<p>Move the point, or edit its coordinate list. [[input:ans]] [[validation:ans]] [[feedback:prt1]]</p>
[[jsxgraph width="500px" height="360px" input-ref-ans="pointRef"]]
var board = JXG.JSXGraph.initBoard(divid, {axis:true,boundingbox:[-4,4,4,-4],showCopyright:false,showNavigation:false});
var point = board.create('point',[-1,-1],{name:'P',snapToGrid:true,snapSizeX:1,snapSizeY:1});
stack_jxg.bind_point(pointRef, point);
board.update();
[[/jsxgraph]]'''


def compile_question(body, importer, identifier, *, python=False):
    root = ET.fromstring(body)
    elements = [q for q in root.findall("question") if q.get("type") == "stack"]
    if len(elements) != 1:
        raise ValueError(f"{identifier} requires one STACK question")
    element = copy.deepcopy(elements[0])
    extended = {}
    python_nodes = {}
    for inp in element.findall("input"):
        name = importer._text(inp, "name")
        typ = importer._text(inp, "type")
        options = importer._text(inp, "options").strip()
        if typ in {"string", "json"}:
            extended[name] = {"type": typ}
            inp.find("type").text = "algebraic"
        if options:
            if options != "hideanswer":
                raise ValueError(f"{identifier}: unsupported input options {options!r}")
            extended.setdefault(name, {})["options"] = options
            inp.find("options").text = ""
    # Reuse the dependency-free structural reader without importing its
    # mathematical engine. Its PythonChecker branch imports that engine's
    # checker module, so validate the small options contract explicitly and
    # temporarily use a native node while the generic PRT reader checks edges.
    for prt in element.findall("prt"):
        for node in prt.findall("node"):
            if importer._text(node, "answertest").strip() != "PythonChecker":
                continue
            options = importer._text(node, "testoptions").strip()
            config = json.loads(options)
            if (not isinstance(config, dict) or set(config) - {"checker", "options"}
                    or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", str(config.get("checker", "")))
                    or not isinstance(config.get("options", {}), dict)):
                raise ValueError(f"{identifier}: invalid PythonChecker options")
            if importer._text(node, "sans").strip() not in {importer._text(inp, "name") for inp in element.findall("input")}:
                raise ValueError(f"{identifier}: PythonChecker requires a direct input name")
            key = (importer._text(prt, "name").strip(), importer._text(node, "name").strip())
            python_nodes[key] = options
            node.find("answertest").text = "AlgEquiv"
            node.find("testoptions").text = ""
    question = importer._question(element)
    for inp in question["inputs"]:
        inp.update(extended.get(inp["name"], {}))
    if python:
        question["python_checkers"] = {"api_version": 1, "source": CHECKER_SOURCE}
    for prt in question["prts"]:
        for node in prt["nodes"]:
            key = (prt["name"], node["name"])
            if key in python_nodes:
                node.update(test="PythonChecker", options=python_nodes[key])
    question["native"] = {"schema": 1, "id": identifier, "locals": local_names(question["variables"]), "tokens": [], "boards": []}
    tokens, boards = question["native"]["tokens"], question["native"]["boards"]

    def tokenize(text, phase="prepare", context="html"):
        def replace(match):
            expr, source_expr = match.groups()
            prefix = text[:match.start()]
            delimiters = list(re.finditer(r"\\(?:\(|\)|\[|\])", prefix))
            inside_math = bool(delimiters and delimiters[-1].group() in {r"\(", r"\["})
            token = {"id": f"t{len(tokens)}", "source": (expr if expr is not None else source_expr).strip(),
                     "format": "latex" if expr is not None else "source", "wrap": expr is not None and not inside_math,
                     "phase": phase, "context": context}
            tokens.append(token)
            return f"@@CTM_NATIVE_{token['id']}@@"
        return TOKEN.sub(replace, text or "")

    def template(text, phase="prepare"):
        escapes = {}
        def escape(match):
            key = f"CTMNATIVEESCAPE{len(escapes)}END"
            # Escaped CASText is literal teaching material. Numeric bracket
            # entities keep it distinct from live directives through rendering.
            escapes[key] = html.escape(match[2], quote=False).replace("[", "&#91;").replace("]", "&#93;")
            return key
        text = ESCAPE.sub(escape, text or "")
        def board(match):
            parsed = {name: value for name, _, value in ATTR.findall(match[1])}
            residue = ATTR.sub("", match[1]).strip()
            if residue:
                raise ValueError(f"{identifier}: unrecognized JSXGraph attribute syntax {residue!r}")
            refs = {name[len("input-ref-"):]: value for name, value in parsed.items() if name.startswith("input-ref-")}
            if not set(refs) <= {inp["name"] for inp in question["inputs"]}:
                raise ValueError(f"{identifier}: JSXGraph references an unknown input")
            if any(not re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", value) for value in refs.values()):
                raise ValueError(f"{identifier}: invalid JSXGraph input reference variable")
            allowed = {"width", "height", "aspect-ratio", "version"} | {"input-ref-" + name for name in refs}
            if not set(parsed) <= allowed:
                raise ValueError(f"{identifier}: JSXGraph attributes outside the compatibility subset: {set(parsed) - allowed}")
            spec = {"id": f"b{len(boards)}", "phase": phase, "attributes": parsed,
                    "inputs": refs, "code": tokenize(match[2], phase, "javascript")}
            boards.append(spec)
            return f"@@CTM_BOARD_{spec['id']}@@"
        text = BOARD.sub(board, text)
        if re.search(r"\[\[(?!input:|validation:|feedback:)", text):
            raise ValueError(f"{identifier}: unsupported or unclosed CASText block")
        text = tokenize(text, phase)
        for key, value in escapes.items():
            text = text.replace(key, value)
        return text

    for field in ("questiontext", "generalfeedback", "specificfeedback", "questionnote"):
        question[field] = template(question[field])
    for prt in question["prts"]:
        prt["locals"] = local_names(prt["feedbackvariables"])
        for node in prt["nodes"]:
            for branch in ("true", "false"):
                node[branch]["feedback"] = template(node[branch]["feedback"], "feedback")
    if any(board["phase"] == "feedback" for board in boards):
        raise ValueError(f"{identifier}: runtime-created feedback boards require an additional native display adapter")
    return question


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-source", type=Path, required=True)
    parser.add_argument("--ctm-checkers-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "site/native/questions.json")
    parser.add_argument("--resources", type=Path, default=ROOT / "site/maxima/native-questions")
    args = parser.parse_args()
    stack = checked_revision(args.stack_source, STACK_REVISION)
    checkers = checked_revision(args.ctm_checkers_source, CHECKERS_REVISION)
    spec = importlib.util.spec_from_file_location("native_ctm_importer", checkers / "src/ctm_checkers/stack/importer.py")
    importer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(importer)
    # Avoid importing the SymPy-based question engine: only this structural
    # module is reused, and pure-Python checker options are checked below.
    importer.TESTS.add("PythonChecker")
    args.resources.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    inventory = []

    def append(identifier, title, body, provenance, *, seeds=(1,), python=False, probes=(), graph=None):
        resource = args.resources / (identifier + ".xml")
        resource.write_bytes(body)
        question = compile_question(body, importer, identifier, python=python)
        inventory.append({"id": identifier, "title": title, "source": {**provenance, "sha256": sha(body),
                          "resource": "native-questions/" + resource.name}, "seeds": list(seeds), "question": question,
                          "probes": list(probes), "graph": graph,
                          "python": any(node["test"] == "PythonChecker" for prt in question["prts"] for node in prt["nodes"])})

    for identifier, filename, title, probes in [
        ("native-rational", "rational-equivalence.xml", "Rational equivalence", [{"answers": {"ans": "0"}, "status": "graded", "score": 0}]),
        ("native-numerical", "numerical-measurement.xml", "Numerical precision", [{"answers": {"perimeter": "24", "area": "17.5", "reported": "17.50"}, "status": "graded", "score": 1}, {"answers": {"perimeter": "0", "area": "0", "reported": "0.00"}, "status": "graded", "score": 0}]),
        ("native-collections", "finite-collections.xml", "Lists and sets", [])]:
        path = "examples/stack/" + filename
        append(identifier, title, source_bytes(checkers, path), {"repository": "Erasmus-CTM/ctm-checkers", "revision": CHECKERS_REVISION,
               "path": path, "classification": "CTM-authored question using standard STACK features"}, seeds=(1, 2) if identifier == "native-rational" else (1,), probes=probes)

    matrix = authored_question("A fixed native matrix", "<p>Enter the two by two identity matrix. [[input:ans]] [[validation:ans]] [[feedback:prt1]]</p>", "matrix([1,0],[0,1])", input_type="matrix", matrix=True)
    append("native-matrix", "A fixed matrix", matrix, {"classification": "CTM-authored question using standard fixed matrix input and AlgEquiv"}, probes=[{"answers":{"ans":"matrix([1,0],[0,1])"},"status":"graded","score":1},{"answers":{"ans":"matrix([1,1],[0,1])"},"status":"graded","score":0}])
    for identifier, filename, title, graph in [
        ("native-binding", "2_Binding_what_does_it_mean.xml", "Unchanged upstream point binding", {"kind":"bound-point","name":"Bound","input":"ans1"}),
        ("native-json", "4_JSON_and_complex_binding.xml", "Unchanged upstream JSON state", {"kind":"color-points","input":"ans1"})]:
        path = UPSTREAM + filename
        append(identifier, title, source_bytes(stack, path), {"repository":"maths/moodle-qtype_stack","revision":STACK_REVISION,"path":path,
               "classification":"Unchanged upstream STACK teaching demonstration; tautological grading, not evidence of mathematical assessment"}, graph=graph)
    for identifier, title, mixed in [("native-python-board", "A graphical PythonChecker", False), ("native-mixed-board", "Native → Python → native", True)]:
        instruction = ("<p>Place P at (2,2). The y-coordinate earns one half, positive x earns one quarter through PythonChecker, and x=2 earns the final quarter.</p>" if mixed
                       else "<p>Place P anywhere in the open first quadrant. PythonChecker accepts any two positive coordinates.</p>")
        body = authored_question(title, instruction + POINT_PROMPT, "[2,2]", mixed=mixed, python="positive_point")
        probes = [{"answers":{"ans":"[2,2]"},"status":"graded","score":1}, {"answers":{"ans":"[2,3]"},"status":"graded","score":.5}, {"answers":{"ans":"[-1,3]"},"status":"graded","score":0}] if mixed else [{"answers":{"ans":"[1,1]"},"status":"graded","score":1},{"answers":{"ans":"[-1,1]"},"status":"graded","score":0}]
        append(identifier, title, body, {"classification":"CTM extension: PythonChecker and native/Python continuation"}, python=True, probes=probes,
               graph={"kind":"bound-point","name":"P","input":"ans"})
    matrix_python = authored_question("Matrix column assessment from PythonChecker", "<p>Enter the identity matrix. The checker reports a verdict for each column. [[input:ans]] [[validation:ans]] [[feedback:prt1]]</p>", "matrix([1,0],[0,1])", input_type="matrix", python="identity_columns", matrix=True)
    append("native-matrix-python", "PythonChecker column evidence", matrix_python, {"classification":"CTM extension: PythonChecker structured matrix assessment"}, python=True,
           probes=[{"answers":{"ans":"matrix([1,0],[0,1])"},"status":"graded","score":1,"assessment":{"columns":["correct","correct"]}}, {"answers":{"ans":"matrix([1,1],[0,1])"},"status":"graded","score":0,"assessment":{"columns":["correct","incorrect"]}}])
    (args.resources / "native-checkers.py").write_text(CHECKER_SOURCE, encoding="utf-8")
    report = {"schema":1,"stackRevision":STACK_REVISION,"ctmCheckersRevision":CHECKERS_REVISION,"jsxgraphQuartoRevision":JSXGRAPH_REVISION,
              "scope":"Native question preparation and supported controller subset; no Moodle PHP input-controller parity claim", "questions":inventory}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"questions":len(inventory),"variants":sum(len(q["seeds"]) for q in inventory),"output":str(args.output)}))


if __name__ == "__main__":
    main()
