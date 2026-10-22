# Milestone 3: native questions, graphical inputs and optional Python

Approved by AC on 22 October 2026, starting from merged PR #1 at
`e3adf45bae3663a422d2ac14ebc6c1cd672dc6c0`. Status: **in progress**.

## Required behavior

1. Prepare question variables, validate supported inputs and evaluate response
   trees with the native STACK/Maxima backend, preserving the shared CTM card
   and request/result contract. Standard questions must work without loading
   Pyodide or SymPy. Define the supported input/controller subset explicitly;
   native Maxima alone does not supply Moodle's PHP input controller.
2. Reuse `jsxgraph/jsxgraph-quarto` for boards and its JSON assessment transport.
   Add a STACK compatibility adapter for `[[jsxgraph]]`, input references and
   supported `stack_js`/`stack_jxg` operations. Preserve declared JSON/string
   input semantics, initialization, state edits, reset, variants and feedback.
   Unsupported operations must produce explicit author diagnostics.
3. Retain the existing `ctm-checkers` PythonChecker implementation and public
   API. Native-only loading is an optimization for questions without Python
   dependencies. Mixed native/Python/native trees require ordered dispatch or
   continuations preserving feedback variables, branch notes, partial credit,
   weighted scores and matrix/vector assessment details.
4. Add playable examples to the repository's Quarto site: an unchanged upstream
   graphical question with native grading, a graphical PythonChecker example
   and a mixed response tree. Label upstream features and CTM extensions.
5. Compare correct, incorrect, invalid and written-form answers with the pinned
   native STACK reference. Test independent question state, reset/variant
   changes and late replies. A failed native call must never fall back to SymPy.
6. Investigate loading cost. Record loader phases and compare exact original
   and changed assets in fresh browser processes. Repeat public UI timings on
   the exact deployed build after functional checks pass. Separate first
   validation, first native grade and warm calls; include optional Python cost.

## Loading investigation

The accepted public benchmark measured median first validation of 43.28 s for
the hybrid Maxima backend, including initialization of both runtimes. Ordinary
validation itself takes about 12 ms warm. The first changes under test defer
Maxima until native grading is required and mount hash-verified library bytes
from one async preload package, avoiding sequential synchronous lazy-file
requests. The ordinary files remain available with identical pinned bytes.

`scripts/milestone-three/measure-loader.mjs` measures native readiness and a real
answer test with and without preloading. It records all server requests and
supports an explicitly simulated per-request latency. These results do not
replace the real deployed-page benchmark and must not be described as WAN data.

## Completion evidence still required

- Native preparation, native input validation and response-tree parity.
- Upstream JSXGraph import and bidirectional STACK input adapter.
- Mixed native/Python/native execution, including structured assessment data.
- Browser functional reports and exact-build public timings.

Milestone 3 is complete only when the evidence above passes. Reliability,
additional browsers and offline/exam packaging remain milestone 4.
