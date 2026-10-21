# Milestone 1: recorded browser/native experiment

Status: **passed**.

Source commit: 12f016a63c857c87d276d1ab3003d318bb393a0b.

Workflow evidence: https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39669805961

The same selected CTM official fixtures and native parser are used for both execution paths.
A fresh Wasm worker is used for each STACK revision; the selected cases share that session.

| STACK revision | Result | Compared rows | Runtime ready ms | STACK ready ms | Total check ms |
|---|---|---:|---:|---:|---:|
| 10d3233 | pass | 22 | 2509.6900000000023 | 81049.20500000002 | 84546.95000000001 |
| 3338304 | pass | 22 | 2335.6300000000047 | 78089.08000000002 | 81379.98000000004 |

Timings describe this CI dependency check with predownloaded local runtime files, not cold course-page loading.
Detailed differences, raw output, dependency hashes and failures are in the JSON/log files beside this report.

## Runs needed

- Run the matching documentation demos through the CTM frontend.
- Implement the requested stack-maxima Quarto entry point and paired demo timings.
- Establish full input validation, PRT and PythonChecker integration, isolation/reset, and broader browser coverage.

Selected fixture data originates in STACK (GPL-3.0-or-later); see THIRD-PARTY-NOTICES.md.
