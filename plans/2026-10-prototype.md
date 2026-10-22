# Prototype plan and consolidation dependencies

Status: milestone 1 passed in [CI run 39669805961](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39669805961). Both pinned libraries loaded and all 22 selected rows at each pin matched the native reference, including three injected mid-input interrupt checks per worker.

## Milestone 2 implementation

Status: **passed** in [CI run 39721228518](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39721228518), measured source `2493268c2bf3eb9941407f376d20a07fb5da4ec9`. Both backends complete all 19 cards / 27 variants, six PythonChecker cards and 121 authored test rows, with zero structured-result differences. See the [completion report](../reports/milestone-two/2026-10-22-completion.md).

The matched prototype retains CTM's input validation, frozen variants, response-tree orchestration, CAStext and PythonChecker implementation. Native STACK answer-test decisions are delegated to Maxima through a persistent child worker. CTM formats bounded native diagnostic feedback, with consistency guards; there is no SymPy answer-test fallback. The shared Python costs and actual native/Python routes are recorded separately.

The existing frontend's persistent serialized worker is reused. The demo materializer provides one guarded backend descriptor seam and a thin `stack-maxima` block adapter; it does not maintain a second question UI. The benchmark will verify identical rendered payloads for both routes and exercise all 27 variants, authored tests, normal UI state transitions and repeated timings.

Substantial implementation increments are committed on this research branch. The previous milestone's accepted source and computed reports remain available independently.

The executable browser harness and [milestone-two workflow](../.github/workflows/milestone-two.yml) now exist. They render both routes, require identical frozen payloads, drive the existing scalar/matrix controls, run authored tests for every variant, validate/check/reset, test stale replies, and retain request-specific native/Python routing evidence. Full result differences and failed authored expectations are failures for review, never silent fallback. The first CI attempt stopped at runtime downloading (HTTP 403), before rendering or grading; [its evidence](../reports/milestone-two/runs/39718723145/build.json) is preserved. The downloader now uses the same Node fetch path as the accepted milestone-one experiment, retaining all hash checks.

Local checks cover all 19 `stack-maxima` blocks through Pandoc, JavaScript syntax, mocked shared-memory result boundaries and the Python adapter's admission/contract tests. These checks do not establish browser grading correctness. Local Chromium and Quarto's theme compiler cannot execute in this sandbox; the GitHub workflow is the execution authority for the full rendered experiment.

## Decision: proceed now

Milestone 1 is independent of the open CTM consolidation PRs. It uses pinned source checkouts and does not modify ctm-assessment, ctm-libs, ctm-checkers, stack-sympy, or either course.

At the initial dependency check on 21 October 2026, ctm-assessment #24 and ctm-checkers #13 were still open. A later check the same day found ctm-assessment #24 merged and ctm-checkers #13 still open. Neither is needed to load upstream STACK in a standalone Wasm worker. Shared runtime/settings integration should follow the relevant merged interfaces, using reviewed commit pins rather than chasing moving branches.

## Reuse boundary

Use CTM Assessment wherever applicable. The first dependency check has no new exercise frontend. It reuses ctm-checkers' exact fixture inventory, native Maxima oracle, argument preparation, batch generation and output parser at 9e042dc5e57a1636be64ca5d08910c9af5ff1371.

The first usable Quarto prototype will reuse existing question cards, inputs and matrix editors, Validate/Check controls, previews, feedback panels, variants, stale-result handling and the worker request/result contract. Do not grow the dependency check into a second exercise frontend.

## Milestones

1. **Load and assess in Wasm.** Verify the measured Maxima core hashes; mount unmodified STACK sources at 10d323311b7f39fb7b092dd10ce75f7d8632f525 and 33383047af39c204bf4442802a058f8b918b2b1b in separate workers; run representative official answer tests; compare stable CAS results with the existing CTM native oracle. Record dependencies, versions, raw logs, failures and source hashes.
2. **The matching Quarto demo project.** Register a Maxima answer-test backend while keeping the existing frontend contract. Run the exact XML demo questions and CTM-frozen variants already used in the stack-sympy documentation, including scalar and matrix examples, through ::: stack-maxima blocks. Reuse the CTM UI and record paired startup, validation and grading timings against the SymPy backend. This hybrid milestone retains CTM preparation, input validation and PRT orchestration; it does not establish native STACK question preparation or PHP input-controller parity. Record unsupported extensions explicitly.
3. **Full native backend and PythonChecker bridge.** Move preparation/validation/PRTs behind the native backend where appropriate. Keep PythonChecker code in ctm-checkers/Pyodide and preserve mixed-node ordering, partial credit and matrix assessment data. The hybrid milestone already retains PythonChecker through CTM's existing controller; compiled native Maxima PRTs would need a continuation/callback bridge.
4. **Reliability and packaging.** Extend goldens and browser coverage, isolation/reset, cancellation/restart and first-grade network/memory measurements. Integrate with settled CTM runtime/settings and offline asset manifests.

## Milestone 1 acceptance and limits

- Both pinned STACK libraries must finish loading; errors are failures.
- Deterministically select positive and negative eligible official fixtures for each of the ten answer-test families currently compared by CTM, plus two matrix cases where available.
- Use ctm-checkers' argument preparation and result parser unchanged. The Wasm transport adapts filesystem paths, protocol output, process exit, virtual-filesystem I/O and interrupt communication; it does not patch STACK's mathematical sources.
- Compare CAS validity, correctness and answer notes with native STACK at each pin. Never turn loader errors or missing results into passing cases.
- Record source revision, file list and hashes, actual native Maxima and browser versions, shared-memory configuration and observed dependencies.
- This proves the direct Maxima answer-test layer for selected probes. It does not establish PHP input-controller, full PRT, Quarto UI, PythonChecker, exam, cancellation or general session-isolation parity.
- The first experiment uses a fresh browser worker for each STACK pin, with selected probes in one session. General per-question isolation remains a later requirement.

## Execution and evidence

The local execution helpers were unavailable when this milestone began. The repository workflow therefore runs the browser/native experiment, uploads diagnostics, and commits its computed report back to the research branch without force-pushing or touching main.

Every run records whether it actually completed. Unperformed checks remain under Runs needed. A failed experiment is useful evidence and must retain its diagnostic output.

## Next milestones and runs needed

- Develop native question preparation/input validation and the native PRT/PythonChecker bridge as milestone 3, while retaining the existing public CTM request/result contract.
- Optimize and remeasure runtime startup. The accepted paired demo observes 24.7–26.1 seconds for hybrid Maxima worker initialization versus 3.55–3.58 seconds for SymPy, with fresh browser caches and prepared gzip localhost assets. The earlier 78–81 seconds describe a different dependency harness.
- Extend native feedback translation beyond the bounded diagnostics used in these demos. CTM's structural set descriptions remain checked against native diagnostic keys and verdicts.
- Establish general namespace isolation, cancellation/restart, other browser engines, memory measurements, offline/exam packaging and production backend registration as milestone 4.
- Obtain another implementation/security review for production integration. The independent milestone-two review found no blocking, high or medium defect for the curated hybrid target; it does not certify production readiness.
