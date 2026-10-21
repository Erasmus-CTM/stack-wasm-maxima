# Prototype plan and consolidation dependencies

Status: milestone 1 passed in [CI run 39669805961](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39669805961). Both pinned libraries loaded and all 22 selected rows at each pin matched the native reference, including three injected mid-input interrupt checks per worker.

## Milestone 2 implementation

Status: in progress. The first matched prototype retains CTM's input validation, frozen variants, response-tree orchestration, CAStext and PythonChecker implementation. Native STACK answer-test decisions are delegated to Maxima through a persistent child worker. This is an explicitly hybrid backend; paired reports must identify the shared Python costs and actual native/Python routes.

The existing frontend's persistent serialized worker is reused. The demo materializer provides one guarded backend descriptor seam and a thin `stack-maxima` block adapter; it does not maintain a second question UI. The benchmark will verify identical rendered payloads for both routes and exercise all 27 variants, authored tests, normal UI state transitions and repeated timings.

Substantial implementation increments are committed on this research branch. The previous milestone's accepted source and computed reports remain available independently.

## Decision: proceed now

Milestone 1 is independent of the open CTM consolidation PRs. It uses pinned source checkouts and does not modify ctm-assessment, ctm-libs, ctm-checkers, stack-sympy, or either course.

At the initial dependency check on 21 October 2026, ctm-assessment #24 and ctm-checkers #13 were still open. A later check the same day found ctm-assessment #24 merged and ctm-checkers #13 still open. Neither is needed to load upstream STACK in a standalone Wasm worker. Shared runtime/settings integration should follow the relevant merged interfaces, using reviewed commit pins rather than chasing moving branches.

## Reuse boundary

Use CTM Assessment wherever applicable. The first dependency check has no new exercise frontend. It reuses ctm-checkers' exact fixture inventory, native Maxima oracle, argument preparation, batch generation and output parser at 9e042dc5e57a1636be64ca5d08910c9af5ff1371.

The first usable Quarto prototype will reuse existing question cards, inputs and matrix editors, Validate/Check controls, previews, feedback panels, variants, stale-result handling and the worker request/result contract. Do not grow the dependency check into a second exercise frontend.

## Milestones

1. **Load and assess in Wasm.** Verify the measured Maxima core hashes; mount unmodified STACK sources at 10d323311b7f39fb7b092dd10ce75f7d8632f525 and 33383047af39c204bf4442802a058f8b918b2b1b in separate workers; run representative official answer tests; compare stable CAS results with the existing CTM native oracle. Record dependencies, versions, raw logs, failures and source hashes.
2. **The matching Quarto demo project.** Register a Maxima backend while keeping the existing frontend contract. Run the exact XML demo questions and frozen variants already used in the stack-sympy documentation, including scalar and matrix examples, through ::: stack-maxima blocks. Reuse the CTM UI and record paired startup, validation and grading timings against the SymPy backend. Prepare each question with the selected backend; record unsupported extensions explicitly.
3. **PythonChecker bridge.** Keep Python code in ctm-checkers/Pyodide. Integrate PythonChecker results inside the backend orchestrator, including mixed PRT ordering, partial credit and matrix assessment data.
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

## Runs needed

- Build the matching Quarto demo described in [the frozen inventory](../demos/README.md), preserving the existing CTM frontend.
- Address the observed 78–81 second STACK initialization in the unoptimized dependency harness; compare preload/compilation options and measure cold-page behavior separately.
- Complete the PythonChecker bridge before declaring the entire 19-card / 27-variant paired demo complete.
- Obtain a separate implementation review before proposing production integration.
