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
prepared for AC by a Claude developer agent. No step 1 work has started.

The follow-up working-tree observation `local-reviewed-abi-success.json` passed
all three routes after the safe-eval varargs correction. Both nonisolated
workers returned the intentional CAS error, then 42 in a separate message;
they also returned ECL NIL (1) for an intentional Lisp-level error and emitted
`LISPRECOVER|42` on the next Lisp request. Its sourceRevision has the same
historical working-tree caveat above. Final strict completeness/provenance
assertions are verified again by the PR workflow at its exact commit.

## External review experiments

The external Claude review on PR #5 identified a real Unicode bug. The failed
`local-6-unicode-failure.json` retains the original UTF-8-as-base-characters
result, against a correct stdin baseline. The fixed adapter builds an
ASCII-only reader expression, reconstructing non-ASCII code points on the
Lisp side before parsing and evaluating the original form. It covers the
research Lisp message interface as well as Maxima program strings.

`local-external-review-success.json` is the expanded working-tree observation
(with harness dirty state, harness hashes and hashes of actual served JS).
The isolated stdin baseline and both nonisolated routes matched all 28 CAS
program expressions/results exactly: the previous 26, the string `æøå−π`,
and actual NativeStackEngine preparation/rendering of a CASText token with
that string. The 22 frozen native comparisons and rational grade 1 still passed.

| Experiment | EOF | to-lisp |
|---|---|---|
| Malformed program `(`, then a separate `6*7` request | Reader/protocol failure, then `[true,42]` | Same |
| 300 individually acknowledged calls after main returned | 300 correct | 300 correct |
| Wasm capacity after calls 1, 50, 100, 150, 200, 250, 300 | 134,217,728 bytes throughout | Same |
| Temporary Wasm stack pointer at those intervals | Stable (35,528,368) | Same |
| Unbounded recursive Maxima function | `[false,"Maximum call stack size exceeded"]` | Same |
| Separate `6*7` after recursion, same worker | `[true,42]`; no replacement | Same |

The terminal recursion experiment has a 15-second caller watchdog followed by
a separate 3-second same-worker recovery watchdog, then unconditional worker
termination. The harness also records a replacement-required outcome if a
future tested runtime cannot recover. The measured case above recovered;
this does not establish recovery from every Wasm trap. Memory observations
are linear-memory capacity, not live Lisp heap or a leak-free claim. No ECL
GC counters were measured. Final CI additionally checks the malformed source's
safe-eval NIL diagnostic and exact response order; that instrumentation was
added after the local observation.

There is no cancellation: `checkForInterrupt` always returns 0. A runaway
program requires caller termination and replacement. Arbitrary `data.lisp`
messages are research-only and must never reach a production worker. Use EOF
as the primary next-step route because it requires only main returning and
the runtime staying alive; retain the port-specific to-lisp throw as fallback.

F-2 no longer needs to wait for an owned rebuild to have a viable call-entry
route. Returning after startup also satisfies a necessary snapshot precondition
(L1), but snapshot save/restore and its GC/linking/filesystem validity remain
unproved. Step 1 remains provenance, exact pins, owned CI reproduction,
substitution parity and oracle version matching. Trims/compression are later
step-2 work; the subsequently authorized pre-step-2 compression work is outside
this step-0 PR. The published runtime and existing transport remain unchanged.
The separate licence PR is prepared for AC by a Claude developer agent.
