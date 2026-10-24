# Milestone 1: recorded browser/native experiment

Status: **failed**.

Source commit: 580019b25ae0be764fae181066c932ff499c0865.

Workflow evidence: https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40051138492

The same selected CTM official fixtures and native parser are used for both execution paths.
A fresh Wasm worker is used for each STACK revision; the selected cases share that session.

| STACK revision | Result | Compared rows | Runtime ready ms | STACK ready ms | Total check ms |
|---|---|---:|---:|---:|---:|
| 10d3233 | pass | 22 | 2594.1299999998882 | 73923.06499999948 | 77074.30999999959 |
| 3338304 | fail | 0 | 2576.3799999998882 | None | 180000.38499999978 |

Timings describe this CI dependency check with predownloaded local runtime files, not cold course-page loading.
Detailed differences, raw output, dependency hashes and failures are in the JSON/log files beside this report.

## Runs needed

- Resolve every recorded loader/runtime failure before extending scope.
- Implement the requested stack-maxima Quarto entry point and paired demo timings.
- Establish full input validation, PRT and PythonChecker integration, isolation/reset, and broader browser coverage.

Selected fixture data originates in STACK (GPL-3.0-or-later); see THIRD-PARTY-NOTICES.md.
