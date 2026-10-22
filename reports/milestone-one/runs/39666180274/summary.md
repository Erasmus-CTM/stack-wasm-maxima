# Milestone 1: recorded browser/native experiment

Status: **failed**.

Source commit: 87ac8e4ead1c29fd5680ab77984859fbe32a0673.

Workflow evidence: https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39666180274

The same selected CTM official fixtures and native parser are used for both execution paths.
A fresh Wasm worker is used for each STACK revision; the selected cases share that session.

| STACK revision | Result | Compared rows | Browser ready ms | Local batch ms |
|---|---|---:|---:|---:|
| 10d3233 | fail | 0 | 2542.6449999999895 | 90000.345 |
| 3338304 | fail | 0 | 2346.3499999999767 | 90000.45499999996 |

Timings describe this CI dependency check with predownloaded local runtime files, not cold course-page loading.
Detailed differences, raw output, dependency hashes and failures are in the JSON/log files beside this report.

## Runs needed

- Resolve every recorded loader/runtime failure before extending scope.
- Implement the requested stack-maxima Quarto entry point and paired demo timings.
- Establish full input validation, PRT and PythonChecker integration, isolation/reset, and broader browser coverage.

Selected fixture data originates in STACK (GPL-3.0-or-later); see THIRD-PARTY-NOTICES.md.
