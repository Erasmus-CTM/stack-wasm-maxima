# Milestone 2: matched Quarto browser experiment

Status: **backend differences need review**.

Source commit: `f1132a1674da1d02997a1e57910e335c3122c899`.

Workflow evidence: https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39720161430

Browser: chromium 141.0.7390.37.

Both backends use the same CTM frontend and frozen payloads. The Maxima edition remains a hybrid: Python performs input validation, PRT orchestration and PythonChecker execution.

| Backend | Completed variants | Authored test rows | Median warm validation ms | Median warm grade ms |
|---|---:|---:|---:|---:|
| sympy | 27 | 121 | 13.1 | 13.6 |
| maxima | 27 | 121 | 13.3 | 61.4 |

Initialization (fresh browser cache per page; prepared assets served locally with gzip):

- sympy/index: 6247.9 ms.
- sympy/examples: 6077.7 ms.
- maxima/index: 42087.7 ms.
- maxima/examples: 41239.1 ms.

Transferred response-body bytes per page (browser-observed, including CDN dependencies):

- sympy/index: 10507609 bytes.
- sympy/examples: 10529906 bytes.
- maxima/index: 21261974 bytes.
- maxima/examples: 21285668 bytes.

These measurements do not establish public WAN startup, production bundling, exam isolation or cancellation safety.

Failures: 0. Full structured result differences: 14. The JSON report retains details; differences are not silently treated as equivalent.

## Runs needed

- Resolve the recorded failures/differences and rerun before declaring this milestone complete.
- Any missing variants, timings or routing evidence remain unverified.
