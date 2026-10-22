# Milestone 2: matched Quarto browser experiment

Status: **failed**.

Source commit: `9f58c414aad41983eae892c612a6cfddd43b88dc`.

Workflow evidence: https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39744713793

Browser: chromium 141.0.7390.37.

Both backends use the same CTM frontend and frozen payloads. The Maxima edition remains a hybrid: Python performs input validation, PRT orchestration and PythonChecker execution.

Packaged runtime: 81 assets / 57083412 decoded bytes. STACK `33383047af39c204bf4442802a058f8b918b2b1b`; ctm-checkers `c366f175aba6b62caa628bc60f57bb1167fc087b`. Source and asset hashes are recorded in JSON without embedding library contents.

Successful grade screenshots (paths relative to the raw browser report in the Actions artifact):

- `sympy-scalar-index-01-v1.png` (sympy, scalar, index-01, variant 1).
- `sympy-matrix-examples-12-v1.png` (sympy, matrix, examples-12, variant 1).

| Backend | Completed variants | Authored test rows | Median warm validation ms | Median warm grade ms |
|---|---:|---:|---:|---:|
| sympy | 27 | 121 | 14.5 | 14.4 |
| maxima | 0 | 0 | not measured | not measured |

Initialization (fresh browser cache per page; prepared assets served locally with gzip):

- sympy/index: 3507.8 ms.
- sympy/examples: 3598.9 ms.
- maxima/index: 3607.4 ms.
- maxima/examples: 3480.6 ms.

Transferred response-body bytes per page (browser-observed, including CDN dependencies):

- sympy/index: 10501978 bytes.
- sympy/examples: 10522899 bytes.
- maxima/index: 10502205 bytes.
- maxima/examples: 10523140 bytes.

These measurements do not establish public WAN startup, production bundling, exam isolation or cancellation safety.

Failures: 3. Full structured result differences: 0. The JSON report retains details; differences are not silently treated as equivalent.

## Runs needed

- Resolve the recorded failures/differences and rerun before declaring this milestone complete.
- Any missing variants, timings or routing evidence remain unverified.
