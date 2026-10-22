# Milestone 3: native questions, graphical inputs and optional Python

Approved by AC on 22 October 2026, starting from merged PR #1 at
`e3adf45bae3663a422d2ac14ebc6c1cd672dc6c0`. Status: **complete**.

Accepted assessment build: `15fa33299d68d64e122a2661a2868feb30130edb`.
The [completion report](../reports/milestone-three/2026-10-22-completion.md)
records functional, independent reference, deployed-page and exact-build timing
evidence. Completion covers the supported browser subset described below;
Moodle/PHP controller parity and exam packaging remain outside this milestone.

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

The milestone 2 public benchmark measured median first validation of 43.28 s for
the earlier hybrid Maxima backend, including initialization of both runtimes.
The milestone 3 comparison now defers
Maxima until native grading is required. The separate native page needs Maxima
for validation as well as grading, and defers Python until a visited checker.
Both native loading paths mount hash-verified library bytes from one async
preload package, avoiding sequential synchronous lazy-file requests. The
ordinary files remain available with identical pinned bytes.

`scripts/milestone-three/measure-loader.mjs` measures native readiness and a real
answer test with and without preloading. It records all server requests and
supports an explicitly simulated per-request latency. These results do not
replace the real deployed-page benchmark and must not be described as WAN data.

The frozen [loader experiment](../reports/milestone-three/loading/README.md)
passed twelve actual answer-test probes. The package reduced requests from
137 to 12; median readiness was 38.57 → 36.71 s locally and 48.32 → 37.39 s
with an explicitly simulated 80 ms per request. These results include three
fresh browser processes per loader and condition. Functional milestone builds
run the native probe; repeating the full loader experiment is an explicit
workflow-dispatch action.

Separate instrumented startup probes investigate exact search directories,
library loads and an optional reduced library configuration. Disabling the
file-search cache timed out and is retained as an opt-in negative experiment.
Diagnostic hook timings must not be presented as production or public UI
timings. Reusable ECL compilation caches require their own pinned-build and
full-source parity evidence before becoming a production loading change.

## Completion evidence

- Native preparation, validation and response-tree execution passed on nine
  cards, eleven seeded variants and twenty-four authored test rows. All 316
  captured programs matched the desktop Maxima reference: 307 exactly and nine
  under the recorded narrow presentation-only policy, with zero unaccepted
  differences.
- Graphical import uses pinned stock jsxgraph-quarto and unchanged upstream
  STACK bindings. Browser checks cover point and JSON exchange, bidirectional
  input, reset, variants, late replies and independent question state.
- Existing PythonChecker remains optional and lazy. Real mixed
  native/Python/native routes preserve feedback locals, partial/weighted credit
  and structured matrix assessment without restarting Maxima.
- Reviewer run `39823225049` and its deployed browser checks passed. Public
  comparison, native and Data flow HTML matched the accepted artifact bytes.
- Timing run `39831459804`, attempt 2, passed against those exact public HTML
  hashes using timing code `1886d5dd3ef30edb5096601cea841684c0290860`.
  Failed measurement attempts remain recorded separately.

The unchanged upstream graphical examples demonstrate data exchange and use
their original self-comparison grading; they are not independent correctness
tests. CTM-authored standard-feature questions and PythonChecker extensions are
clearly distinguished on the native page. Input admission, response-tree
control and English feedback translation are explicitly bounded, not the full
Moodle/STACK PHP implementation.

Reliability across additional browsers, offline/exam packaging, broader
question compatibility and further native startup reductions remain future
work. Instrumented reduced-library experiments are not production defaults.
