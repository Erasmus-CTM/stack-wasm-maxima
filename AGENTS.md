# Project rules

## STACK compatibility and runtime performance

- Keep a Maxima runtime for full STACK compatibility. Do not assume that 100% of STACK can be reimplemented in SymPy, or make continued Maxima support conditional on a complete SymPy replacement.
- Select the fastest practical, fully compatible Maxima solution. Compare upstream/prebuilt runtimes, owned compiler-profile builds with source-loaded STACK, and precompiled STACK using matched workloads and conditions; precompilation is not a goal by itself.
- Maintaining and serving an owned compiled solution must earn its build, update, provenance and hosting costs through a substantial, repeatable improvement beyond measurement noise. An approximately one-second win alone is not sufficient justification.
- Meaningful incremental improvements are worthwhile: reducing readiness from 40 seconds to 28 seconds can justify work even if an aspirational target remains unmet. Report absolute and relative gains, repetitions, uncertainty and maintenance costs rather than choosing a universal cutoff.
- The 20-second readiness target is a wish, not a mandatory acceptance threshold or a reason to reject an otherwise correct improvement. Report whether it was reached without treating it as a correctness or merge gate.
- Preserve full parity, artifact provenance and independent review requirements. A faster result must still pass the applicable correctness and lifecycle checks.
- Separate source-runtime compiler-profile gains from precompiled STACK gains. Report actual measurements, repetitions, conditions and limitations; do not claim a precompiled speedup without evidence.
- Benchmark CPU quotas describe the test environment and remain distinct from the aspirational 20-second latency target. Do not infer an exact laptop time from a CPU quota.

These performance rules reflect AC's clarification on 24 October 2026.
