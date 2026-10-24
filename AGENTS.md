# Project rules

## STACK compatibility and runtime performance

- Keep a Maxima runtime for full STACK compatibility. Do not assume that 100% of STACK can be reimplemented in SymPy, or make continued Maxima support conditional on a complete SymPy replacement.
- Pursue the fastest validated Maxima solution. Measured incremental improvements are worthwhile: reducing readiness from 40 seconds to 28 seconds is valuable even if an aspirational target remains unmet.
- The 20-second readiness target is a wish, not a mandatory acceptance threshold or a reason to reject an otherwise correct improvement. Report whether it was reached without treating it as a correctness or merge gate.
- Preserve full parity, artifact provenance and independent review requirements. A faster result must still pass the applicable correctness and lifecycle checks.
- Separate source-runtime compiler-profile gains from precompiled STACK gains. Report actual measurements, repetitions, conditions and limitations; do not claim a precompiled speedup without evidence.
- Benchmark CPU quotas describe the test environment and remain distinct from the aspirational 20-second latency target. Do not infer an exact laptop time from a CPU quota.

These performance rules reflect AC's clarification on 24 October 2026.
