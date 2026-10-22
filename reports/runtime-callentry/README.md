# Step 0 local result, 22 October 2026

The deployed binary supports direct ECL evaluation after startup without
cross-origin isolation. No rebuild was needed. Both EOF and the source-derived
to-lisp route passed 22/22 frozen native probe comparisons and exact comparison
of all 26 CAS program results against the unchanged stdin transport. Actual
native-rational preparation, validation and grade returned the same results;
the teacher answer scored 1. A CAS error returned
`[false,"intentional step-zero CAS error"]`, then the same worker returned
`[true,42]` for a new call.

The full initial local observation is `local-success.json`. All local attempts
were working-tree development runs: their `sourceRevision` is the checked-out
base/previous HEAD, not a reproduction claim for that commit. Runtime and STACK
hashes were checked, but the original local artifacts did not fingerprint every
uncommitted harness byte. They remain unchanged as historical evidence. Future
runs record dirty state, harness hashes and the actual JS responses served;
CI at the final PR commit is the reproducible acceptance authority. It covers the same-worker
internal error/recovery calls. The final harness additionally checks distinct
postMessage error/recovery requests; CI is the authority for that final check.
The isolated baseline and two nonisolated pages ran sequentially in one browser,
with a fresh browser context and different localhost origin per route. These
are single local-server observations. OS/filesystem/process warming is
uncontrolled; no HTTP-cache reuse or startup improvement is claimed.

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

The follow-up working-tree observation `local-reviewed-abi-success.json` passed
all three routes after the safe-eval varargs correction. Both nonisolated
workers returned the intentional CAS error, then 42 in a separate message;
they also returned ECL NIL (1) for an intentional Lisp-level error and emitted
`LISPRECOVER|42` on the next Lisp request. Its sourceRevision has the same
historical working-tree caveat above. Final strict completeness/provenance
assertions are verified again by the PR workflow at its exact commit.
