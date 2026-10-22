"""Materialize a scoped backend seam in the exact pinned CTM frontend.

All question controls, rendering, validation state and stale-result handling
stay in the original implementation. Only its worker prefix becomes a factory
with one independent pool per backend, selected by the nearest card wrapper.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import textwrap

SOURCE_SHA256 = "53832ffd115c64fa2e28fb96ebebf6e99ebcec2e43c971a075cf7283e0731633"
WORKER_START = "  var workerURL = new URL('worker.js', current.src);\n"
WORKER_END = "  var MATHJAX_URL = "


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def once(source: str, before: str, after: str) -> str:
    count = source.count(before)
    if count != 1:
        raise ValueError(f"Frontend seam changed: expected one {before!r}, found {count}")
    return source.replace(before, after, 1)


def patch_frontend(extension: Path) -> list[dict]:
    path = extension / "stack-sympy.js"
    original = path.read_bytes()
    if digest(original) != SOURCE_SHA256:
        raise ValueError("The scoped frontend requires the exact pinned stack-sympy.js source")
    source = original.decode("utf-8")
    begin, end = source.index(WORKER_START), source.index(WORKER_END)
    worker = source[begin:end].rstrip()
    worker = once(worker, WORKER_START.rstrip(),
                  "  var workerURL = descriptor.workerURL ? new URL(descriptor.workerURL, document.baseURI) : defaultWorkerURL;")
    worker = once(worker, "loadTimeout: runtime.loadTimeout };",
                  "loadTimeout: descriptor.loadTimeout || runtime.loadTimeout };")
    worker = once(worker, "resetWorker(new Error('Python did not finish loading. Try again.'));",
                  "resetWorker(new Error((descriptor.label || 'SymPy') + ' did not finish loading. Try again.'));")
    factory = (
        "  var defaultWorkerURL = new URL('worker.js', current.src);\n"
        "  var backendInstances = Object.create(null);\n\n"
        "  function createBackend(descriptor) {\n"
        "    descriptor = descriptor || {};\n"
        + textwrap.indent(worker, "  ")
        + "\n    return { evaluate: evaluate, label: descriptor.label || 'SymPy' };\n"
        "  }\n\n"
        "  function backendForCard(card) {\n"
        "    var wrapper = card.closest('[data-stack-backend]');\n"
        "    var name = wrapper ? wrapper.getAttribute('data-stack-backend') : 'sympy';\n"
        "    if (!name) throw new Error('The question backend is not specified.');\n"
        "    if (backendInstances[name]) return backendInstances[name];\n"
        "    var descriptor = { label: 'SymPy' };\n"
        "    if (name !== 'sympy') {\n"
        "      var registry = window.CTMStackBackends;\n"
        "      if (!registry || !Object.prototype.hasOwnProperty.call(registry, name)) {\n"
        "        throw new Error('The ' + name + ' backend is not configured.');\n"
        "      }\n"
        "      descriptor = registry[name];\n"
        "      if (!descriptor || typeof descriptor.workerURL !== 'string' || !descriptor.workerURL.trim()) {\n"
        "        throw new Error('The ' + name + ' backend has no grading worker.');\n"
        "      }\n"
        "    }\n"
        "    backendInstances[name] = createBackend(descriptor);\n"
        "    return backendInstances[name];\n"
        "  }\n\n"
    )
    source = source[:begin] + factory + source[end:]
    source = once(source, "    var selector = card.querySelector('.stack-variant');",
                  "    var backend;\n"
                  "    try { backend = backendForCard(card); }\n"
                  "    catch (error) {\n"
                  "      message(card.querySelector('.stack-result'), 'Could not start the grader: ' + error.message, 'error');\n"
                  "      card.querySelectorAll('.stack-check, .stack-validate, .stack-tests').forEach(function (button) { button.disabled = true; });\n"
                  "      return;\n"
                  "    }\n"
                  "    var evaluate = backend.evaluate;\n"
                  "    var backendLabel = backend.label;\n"
                  "    var selector = card.querySelector('.stack-variant');")
    source = once(source, "type === 'grade' ? 'Checking with SymPy…' :",
                  "type === 'grade' ? 'Checking with ' + backendLabel + '…' :")
    result = source.encode("utf-8")
    path.write_bytes(result)
    return [{
        "path": "_extensions/stack-sympy/stack-sympy.js",
        "sourceSha256": digest(original), "materializedSha256": digest(result),
        "substitutions": ["worker prefix enclosed in createBackend(descriptor)",
                          "initialize(card) captures its nearest wrapper's backend",
                          "grade status uses the selected backend label"],
    }]
