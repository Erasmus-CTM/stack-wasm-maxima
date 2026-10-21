# Milestone 1: recorded browser/native experiment

Status: **failed**.

Source commit: c3eacebf4d78a9f6de8ffdcc88d6a8ee9deba106.

Workflow evidence: https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39668799588

The same selected CTM official fixtures and native parser are used for both execution paths.
A fresh Wasm worker is used for each STACK revision; the selected cases share that session.

| STACK revision | Result | Compared rows | Runtime ready ms | STACK ready ms | Total check ms |
|---|---|---:|---:|---:|---:|
| 10d3233 | fail | 0 | 1849.2449999999953 | 65408.69999999998 | 67974.38 |
| 3338304 | pass | 22 | 1700.7300000000105 | 60377.01999999999 | 62826.01999999999 |

Timings describe this CI dependency check with predownloaded local runtime files, not cold course-page loading.
Detailed differences, raw output, dependency hashes and failures are in the JSON/log files beside this report.

## Runs needed

- Resolve every recorded loader/runtime failure before extending scope.
- Implement the requested stack-maxima Quarto entry point and paired demo timings.
- Establish full input validation, PRT and PythonChecker integration, isolation/reset, and broader browser coverage.

Selected fixture data originates in STACK (GPL-3.0-or-later); see THIRD-PARTY-NOTICES.md.
