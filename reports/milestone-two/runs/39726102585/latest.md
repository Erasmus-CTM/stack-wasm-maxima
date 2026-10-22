# Milestone 2: matched Quarto browser experiment

Status: **passed**.

Source commit: `41a580f4451d4a6ab47bcc5b159c3950a7b71c91`.

Workflow evidence: https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39726102585

Browser: chromium 141.0.7390.37.

Both backends use the same CTM frontend and frozen payloads. The Maxima edition remains a hybrid: Python performs input validation, PRT orchestration and PythonChecker execution.

Packaged runtime: 81 assets / 57083412 decoded bytes. STACK `33383047af39c204bf4442802a058f8b918b2b1b`; ctm-checkers `c366f175aba6b62caa628bc60f57bb1167fc087b`. Source and asset hashes are recorded in JSON without embedding library contents.

Successful grade screenshots (paths relative to the raw browser report in the Actions artifact):

- `sympy-scalar-index-01-v1.png` (sympy, scalar, index-01, variant 1).
- `sympy-matrix-examples-12-v1.png` (sympy, matrix, examples-12, variant 1).
- `maxima-scalar-index-01-v1.png` (maxima, scalar, index-01, variant 1).
- `maxima-matrix-examples-12-v1.png` (maxima, matrix, examples-12, variant 1).

| Backend | Completed variants | Authored test rows | Median warm validation ms | Median warm grade ms |
|---|---:|---:|---:|---:|
| sympy | 27 | 121 | 12.8 | 13.1 |
| maxima | 27 | 121 | 13.4 | 60.3 |

Initialization (fresh browser cache per page; prepared assets served locally with gzip):

- sympy/index: 6193.1 ms.
- sympy/examples: 6225.8 ms.
- maxima/index: 40645.9 ms.
- maxima/examples: 39797.5 ms.

Transferred response-body bytes per page (browser-observed, including CDN dependencies):

- sympy/index: 10502009 bytes.
- sympy/examples: 10523032 bytes.
- maxima/index: 21263151 bytes.
- maxima/examples: 21286542 bytes.

These measurements do not establish public WAN startup, production bundling, exam isolation or cancellation safety.

Failures: 0. Full structured result differences: 0. The JSON report retains details; differences are not silently treated as equivalent.

## Runs needed

- Broader browser coverage and production packaging/reliability remain later milestones.
