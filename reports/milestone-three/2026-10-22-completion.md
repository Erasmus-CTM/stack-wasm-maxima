# Milestone 3 completion: native questions, boards and optional Python

Milestone 3 is complete for the supported browser implementation. The accepted
assessment source is `15fa33299d68d64e122a2661a2868feb30130edb`, built and checked
in [reviewer run 39823225049](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39823225049).
The native preparation and grading path uses STACK/Maxima without loading
Python for native-only questions. Graphical questions reuse pinned
jsxgraph-quarto and the unchanged STACK binding library through the CTM adapter.
PythonChecker retains its existing API and starts lazily when a visited node
requires it.

## Functional and reference evidence

The native browser harness passed nine cards, eleven seeded variants and
twenty-four authored test rows, including four graphical cards and three with
PythonChecker. It exercised ten boundary fixtures, four invalid probes and
nineteen non-full-credit probes. Correctness checks cover real point and JSON
exchange, typed input, reset and variant changes, late replies, independent
question state, matrix assessment, partial/weighted scoring and ordered mixed
native/Python/native execution.

All 316 captured native programs passed the independent desktop Maxima replay:
307 exact matches and nine accepted presentation-only matches, with zero
unaccepted differences. The narrow presentation policy preserves raw display
differences and keeps mathematical values, state, scores, notes and source
comparisons strict. This is native CAS parity evidence, not a Moodle/PHP run.
See the [acceptance summary](acceptance/39823225049/README.md).

## Exact public build and timings

Publication job `119993878416` passed, including the deployed browser checks.
The downloaded rendered-site artifact `12448045201` matched its GitHub ZIP
digest `d32eb0462a485b9b29c279ffc1b300db23f5f5b10b3ff7becea7efdd51174ebc`.
Independent public downloads of comparison, native and Data flow HTML matched
the artifact byte hashes, and the public manifest identified the accepted
source. Exact URLs and hashes are in the
[public verification record](acceptance/39823225049/public-verification.json).

[Timing run 39831459804, attempt 2](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39831459804/attempts/2)
passed with measurement code `1886d5dd3ef30edb5096601cea841684c0290860` against
the accepted public HTML hashes. Timing code and assessment source are distinct
revisions. Artifact `12450225673` has ZIP SHA256
`1fcc1ae388e5c22ac8023e8a08f3d28d7d9589a1ab0e907076f183d1612fe2d3`.
The [paired summary](timings/39831459804-attempt-2/comparison-summary.json) and
[native summary](timings/39831459804-attempt-2/native-summary.json) separate cold
validation, deferred native startup, warm calls and incremental PythonChecker
startup. Earlier failed attempts are retained separately; they are not valid
native timing samples. These measurements describe fresh desktop Chromium
sessions against this deployment, not all candidate devices or networks.

## Scope and remaining work

The supported input admission, native response-tree controller and pinned
English feedback translation are a bounded implementation. They do not
reproduce Moodle's PHP input/attempt controller or establish compatibility with
arbitrary STACK questions. CTM-authored standard-feature questions are labelled
separately from PythonChecker extensions. The unchanged upstream graphical
examples retain their original self-comparison grading and demonstrate data
exchange rather than independent correctness assessment. A failed native call
does not fall back to SymPy.

The preload package reduces request overhead while preserving pinned bytes;
native STACK library startup remains substantial. Controlled local loader
experiments and instrumented startup diagnostics are linked separately in the
[loading](loading/README.md) and [startup](startup/README.md) evidence. Reduced
library scope is diagnostic, not a production default, and reusable compilation
caches still need pinned-build and full-source parity evidence. Additional
browsers, broader question support, offline/exam packaging and further startup
work remain future milestones.
