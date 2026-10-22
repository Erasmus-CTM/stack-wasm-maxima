# Milestone 2: matched Quarto browser experiment

Status: **failed**.

Source commit: `c95dfd23e7a93bbbbfdf40eadd545f00b2201b91`.

Workflow evidence: https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39719653956

Browser: chromium 141.0.7390.37.

Both backends use the same CTM frontend and frozen payloads. The Maxima edition remains a hybrid: Python performs input validation, PRT orchestration and PythonChecker execution.

| Backend | Completed variants | Authored test rows | Median warm validation ms | Median warm grade ms |
|---|---:|---:|---:|---:|
| sympy | 27 | 121 | 13.7 | 14.3 |
| maxima | 8 | 22 | 14.0 | 41.5 |

Initialization (fresh browser cache per page; prepared assets served locally with gzip):

- sympy/index: 3673.9 ms.
- sympy/examples: 3756.5 ms.
- maxima/index: 25604.3 ms.
- maxima/examples: 25614.4 ms.

Transferred response-body bytes per page (browser-observed, including CDN dependencies):

- sympy/index: 10502015 bytes.
- sympy/examples: 10523021 bytes.
- maxima/index: 21255485 bytes.
- maxima/examples: 21276642 bytes.

These measurements do not establish public WAN startup, production bundling, exam isolation or cancellation safety.

Failures: 3. Full structured result differences: 0. The JSON report retains details; differences are not silently treated as equivalent.

## Runs needed

- Resolve the recorded failures/differences and rerun before declaring this milestone complete.
- Any missing variants, timings or routing evidence remain unverified.
