# Source validation failure: competing explanations

Status: unresolved, compiler promotion blocked. The displayed PythonChecker question name is a workload location; failure precedes the Python callback.

Observed: a fresh integration binary fails [1,1] validation against [2,2] in two independent unmodified full UI executions. Original candidate and control passed three full UI repetitions each. Exact CAS-history-only replay passed on all three binaries, so it does not reproduce the complete execution environment. Instrumenting earlier validations also changed the outcome and cannot establish a fix.

The exact-case observer captured a Lisp CAR type error (SUBR instead of LIST), during stack_validate inside with_stdout. %ERR is empty; %NOTES already contains ATList_wrongentries 1, 2. STACK appends that note immediately before wrong-entry feedback rendering. The next diagnostic captures the call chain before unwind, only on the exact failing validation.

Hypotheses to distinguish, not conclusions:

1. Validation/error-boundary design: all caught conditions become invalid input. This masks internal faults and prevents existing poisoned-session recovery. Repair must retain expected domain invalidity (1/0), distinguish internal faults, and fail the request without silently retrying or grading.
2. Long-lived CAS state: questions share one healthy worker. Author assignments and ordinary assumption flags are scoped, but complete per-question namespace isolation is explicitly deferred in project plans. Compare histories and actual global/property state; a restart that merely avoids the symptom is insufficient root-cause evidence.
3. Feedback path side effects: upstream ATList colors an aliased student list; stack_validate eventually detexcolors its return. Inspect the actual CAR caller and values before changing how we invoke it. Using only the question name or bypassing wrong-answer display would be an inadequate fix.
4. Native runtime/compiler/collector problem: sensitivity to allocation/instrumentation and build identity is consistent with several runtime problems, but does not identify one. The existing root-scanner overlay and 100-GC smoke do not rule out other faults. Require a reproducer and direct evidence before extending patches or blaming optimization.
5. Harness/browser scheduling: same original engine hash confirmed; backend requests and Python invocations are serialized. Short replay omits UI/Python delays and browser environment. Preserve these when minimizing; no evidence yet of overlapping CAS requests.

Required validation for a repair: focused reproducer, regressions for valid/wrong/domain-invalid inputs and internal errors, complete source UI plus independent native comparison on repeated fresh workers, and full production-profile build with all acceptance gates at the final head. Preserve source-loaded default and never accept reruns as a substitute for a repair.

Further controls: all 180 prefix expressions match each of six unmodified control/original-candidate UI runs, with identical full JSON results through 179 and the first difference at 180. See identical-history.json. The fresh integration build also has byte-identical build.sh, compiler_profile.py, pins, configuration, source patch and maxima-child.js source to the original candidate; the artifact identity still differs. This rules out an additional flag-setting edit, not all build/runtime causes.

The first global error-hook UI run passed all 316 UI programs. Its native replay correctly rejected eight new diagnostic metadata values because the helper exists only in Wasm; that observer mistake was corrected, not accepted as parity. The subsequent diagnostic preserves diagnostic=false for successful validations. Root failure remains open.

Latest review update: run40181246819 passed five complete source UI316/native316 repetitions with no startup or generated CAS-program changes and zero post-failure diagnostic triggers. Every180-program prefix equals the failed unmodified run. Consequently the hypothesis that startup instrumentation alone masks the problem is not established. The original three reproduced source failures remain unexplained; user requested a fresh Claude review. See CLAUDE-HANDOFF.txt and postfailure-only-summary.json.
