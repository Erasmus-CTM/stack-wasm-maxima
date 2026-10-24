# Milestone 1: recorded browser/native experiment

Status: **passed**.

Source commit: 61127481df93a2e9c69a19e64c0dc9db7bbb723f.

Workflow evidence: https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40059617859

The same selected CTM official fixtures and native parser are used for both execution paths.
A fresh Wasm worker is used for each STACK revision; the selected cases share that session.

| STACK revision | Result | Compared rows | Runtime ready ms | STACK ready ms | Total check ms |
|---|---|---:|---:|---:|---:|
| 10d3233 | pass | 22 | 1682.6300000000047 | 59193.640000000014 | 61622.44 |
| 3338304 | pass | 22 | 1681.820000000007 | 59911.53999999998 | 62322.54999999999 |

Timings describe this CI dependency check with predownloaded local runtime files, not cold course-page loading.
Detailed differences, raw output, dependency hashes and failures are in the JSON/log files beside this report.

## Runs needed

- Run the matching documentation demos through the CTM frontend.
- Implement the requested stack-maxima Quarto entry point and paired demo timings.
- Establish full input validation, PRT and PythonChecker integration, isolation/reset, and broader browser coverage.

Selected fixture data originates in STACK (GPL-3.0-or-later); see THIRD-PARTY-NOTICES.md.
