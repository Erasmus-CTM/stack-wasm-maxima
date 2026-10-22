# Step 0 local result, 22 October 2026

The deployed binary supports direct ECL evaluation after startup without
cross-origin isolation. No rebuild was needed. Both EOF and the source-derived
to-lisp route passed 22/22 frozen native probe comparisons and exact comparison
of all 26 CAS program results against the unchanged stdin transport. Actual
native-rational preparation, validation and grade returned the same results;
the teacher answer scored 1. A CAS error returned
`[false,"intentional step-zero CAS error"]`, then the same worker returned
`[true,42]` for a new call.

The full local observation is `local-success.json`. It covers the same-worker
internal error/recovery calls. The final harness additionally checks distinct
postMessage error/recovery requests; CI is the authority for that final check.
The isolated baseline and two nonisolated pages ran sequentially in one browser,
so the timings below are single local observations, with a warm HTTP cache after
the baseline. They do not establish a startup improvement.

| Route | Ready (s) | Prepare program (ms) | First validate (ms) | Grade's validate (ms) | PRT program (ms) |
|---|---:|---:|---:|---:|---:|
| Existing stdin/SAB | 37.129 | 310.3 | 167.9 | 75.5 | 174.7 |
| Direct ECL after EOF | 31.362 | 283.0 | 71.7 | 74.7 | 189.5 |
| Direct ECL after to-lisp | 31.767 | 327.7 | 63.3 | 65.4 | 209.1 |

The first answer-test program incurred an additional lazy share-file load
(~2 s) in each worker; it is retained in per-call evidence. No asset sizes or
source files changed. Failed development observations are retained under
`attempts/`; their causes and the reproduction commands are documented in the
prototype README. Licence notices remain dependent on the separate PR being
prepared by AC. No step 1 work has started.
