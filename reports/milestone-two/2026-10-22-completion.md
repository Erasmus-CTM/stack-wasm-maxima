# Milestone 2: matched CTM Quarto prototype

Status: **passed**. [CI run 39721228518](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39721228518) measured executable source `2493268c2bf3eb9941407f376d20a07fb5da4ec9` in a clean worktree. The later inventory status and documentation updates do not change the question sources, options, variants or executable code.

The existing CTM frontend now runs the same documentation questions through SymPy or a hybrid Maxima backend. The Maxima pages use `::: {.stack-maxima}` blocks; the question renderer, scalar/matrix inputs, validation/check controls, variants, feedback, AI-feedback integration and PythonChecker stay in their current libraries. Backend selection is per page in this prototype.

## Computed evidence

| Check | SymPy | Hybrid Maxima |
|---|---:|---:|
| Question cards | 19 | 19 |
| Completed frozen variants | 27 | 27 |
| PythonChecker cards covered | 6 | 6 |
| Passed authored test rows | 121 | 121 |
| Selected UI validation calls | 27 | 27 |
| Repeated warm grading calls | 81 | 81 |
| Reset checks | 27 | 27 |
| Stale validation-reply checks | 2 | 2 |

The rendered frozen payloads are identical. Every authored row runs through the existing **Run question tests** control. One selected authored answer per variant is also entered through the real scalar/matrix editors, validated and graded three times. This does not mean every wrong/invalid authored answer was filled through the student controls.

There are **zero full structured-result differences** and no operation, network, UI-state or routing failures. Comparisons retain scores, status, input interpretations, PRT paths/notes/feedback and PythonChecker assessment data. The Maxima worker emitted 232 native answer-test events and 122 PythonChecker events, linked to their actual CTM requests. Failed earlier runs remain archived; missing coverage or failed loading was never treated as success.

The [raw browser report](runs/39721228518/browser.json), [summary](latest.json) and Actions artifact preserve source/file hashes, source pins, worker calls, native diagnostics, individual samples and actual network requests. Packaging verifies 81 runtime assets (57,083,412 decoded file bytes) and 77 unmodified STACK source files (898,867 bytes); packaged files are not all necessarily fetched during initialization.

## Paired measurements

Chromium 141.0.7390.37; a fresh browser context/cache per page; prepared local assets served with gzip and isolation headers. Both editions still load Pyodide/SymPy. Screenshots are taken after the timed calls.

| Measurement | SymPy | Hybrid Maxima |
|---|---:|---:|
| Worker initialization, two pages | 3.55–3.58 s | 24.74–26.10 s |
| Median warm validation | 14.2 ms | 14.2 ms |
| Median warm grading | 14.5 ms | 35.1 ms |
| Encoded response bodies per fresh page | 10.50–10.52 MB | 21.21–21.28 MB |

MB means 1,000,000 bytes. Transfer counts exclude protocol/header overhead; the raw data also retains response header sizes. Warm medians combine the matching native and PythonChecker demo mix. These are CI observations, not public WAN latency, full-course Python-package measurements, browser performance guarantees or a statistically powered benchmark. Startup varied across earlier runs; compare the recorded environment and individual samples.

The prototype establishes feasibility and frontend reuse. It does **not** establish a speed or download-size advantage for Maxima: the hybrid adds an interpreter, initialization work and memory alongside Python. Memory was not measured here.

## Visual verification and implementation review

The four successful scalar/matrix screenshots were inspected after downloading the accepted artifact and verifying its SHA-256. The corresponding SymPy and Maxima screenshots are byte-identical for each question kind.

![Scalar question through Maxima](screenshots/maxima-scalar.png)

![PythonChecker matrix question on the Maxima page](screenshots/maxima-matrix.png)

An independent code review found no blocking, high or medium defect for the curated hybrid milestone. Eight Python admission/contract/feedback tests and the JavaScript shared-memory boundary suite pass. The browser run supplies the actual CAS/UI evidence; mocked tests and recorded-result replay are not reported as fresh CAS runs.

The downloadable artifact on the successful workflow contains the rendered site, full diagnostics and all four screenshots. Its name is `milestone-two-2493268c2bf3eb9941407f376d20a07fb5da4ec9`; ZIP SHA-256: `bee2255220f31b3e4b681cce6baa170c01ee843d36818bd239baddf52b92e7e1`. The [build guide](../../prototype/README.md) and workflow reproduce the project from pinned sources.

## Scope and subsequent work

Maxima supplies ordinary answer-test verdicts. CTM/Pyodide still prepares/fixes variants, parses and validates inputs, drives PRTs, formats bounded diagnostic feedback and runs PythonChecker. Native verdicts remain authoritative: collection feedback uses native list/matrix diagnostics plus the existing CTM structural set formatter, guarded against native verdict/key disagreement. It adds no CAS calls and never falls back to SymPy answer tests. Raw upstream feedback remains available; general `stack_trans` translation is not implemented.

Native question preparation/input-controller parity, compiled native PRT orchestration with PythonChecker, general question namespace isolation, reliable cancellation/restart, additional browser engines, memory/offline/exam measurements and production CTM backend registration remain later milestones. Course defaults and mixed backends on a single page are not implemented by this prototype.
