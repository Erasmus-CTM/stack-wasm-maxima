# Milestone 2: matched Quarto browser experiment

Status: **failed**.

Source commit: `2c58fb3a9baabee331f4f4b7df042352f4945df0`.

Workflow evidence: https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39719130379

Browser: chromium 141.0.7390.37.

Both backends use the same CTM frontend and frozen payloads. The Maxima edition remains a hybrid: Python performs input validation, PRT orchestration and PythonChecker execution.

| Backend | Completed variants | Authored test rows | Median warm validation ms | Median warm grade ms |
|---|---:|---:|---:|---:|
| sympy | 27 | 121 | 14.2 | 14.6 |
| maxima | 0 | 0 | not measured | not measured |

Initialization (fresh browser cache per page; prepared assets served locally with gzip):

- sympy/index: 3357.9 ms.
- sympy/examples: 3623.7 ms.
- maxima/index: 22937.8 ms.
- maxima/examples: 23702.8 ms.

Transferred response-body bytes per page (browser-observed, including CDN dependencies):

- sympy/index: 10501925 bytes.
- sympy/examples: 10523035 bytes.
- maxima/index: 21248610 bytes.
- maxima/examples: 21269676 bytes.

These measurements do not establish public WAN startup, production bundling, exam isolation or cancellation safety.

Failures: 5. Full structured result differences: 0. The JSON report retains details; differences are not silently treated as equivalent.

## Runs needed

- Resolve the recorded failures/differences and rerun before declaring this milestone complete.
- Any missing variants, timings or routing evidence remain unverified.
