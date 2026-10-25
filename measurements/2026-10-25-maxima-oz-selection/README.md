# Compiler selection evidence — 25 October 2026

**Promotion remains blocked by the fresh-build source validation failure.** Timing success does not waive source/native parity. See [source-parity-blocker.json](source-parity-blocker.json) and [caught-condition.json](caught-condition.json).

[Selection run 40169223514](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40169223514) compared admitted binaries without rebuilding, on one runner, with source-loaded STACK. Each condition and mode has ten repetitions per profile, balanced AB/BA five times each. All 80 samples passed the timing workload gates. Cold and warm-profile reload both use fresh workers; reload does not retain a CAS session.

The control has the same profile and source pins as runtime-v2 but is not byte-identical to the published archive: these are profile comparisons. The inherited producer scope prose describes an older six-cell n=3 plan; the executed source-only n=10 plan is explicitly checked by the derivation script.

Seconds below. Ready includes IQR and minimum–maximum; other columns are medians. [results.json](results.json) includes every raw sample, all metric spreads and identities. [raw/](raw/) retains producer reports, admission evidence and runner details; [derive-statistics.py](derive-statistics.py) rechecks and derives statistics.

| Condition | Mode | Profile | Ready median (IQR; min–max) | STACK load | First positive | Warmed grade |
|---|---|---|---|---:|---:|---:|
| unrestricted | cold | ecl-oz | 18.538 (18.343–19.156; 18.268–19.388) | 13.567 | 2.486 | 0.049 |
| unrestricted | cold | ecl-oz-maxima-oz | 9.534 (9.315–9.773; 9.273–10.621) | 6.653 | 0.217 | 0.043 |
| unrestricted | warm-profile-reload | ecl-oz | 18.464 (18.153–18.501; 17.971–18.615) | 13.648 | 2.485 | 0.047 |
| unrestricted | warm-profile-reload | ecl-oz-maxima-oz | 9.038 (8.853–9.061; 8.543–9.107) | 7.133 | 0.195 | 0.041 |
| CPUQuota=25% | cold | ecl-oz | 77.453 (77.085–77.734; 76.994–78.499) | 57.450 | 10.205 | 0.247 |
| CPUQuota=25% | cold | ecl-oz-maxima-oz | 42.908 (42.732–43.073; 42.503–43.110) | 29.650 | 0.997 | 0.200 |
| CPUQuota=25% | warm-profile-reload | ecl-oz | 74.156 (74.027–74.276; 73.697–75.294) | 57.597 | 10.287 | 0.247 |
| CPUQuota=25% | warm-profile-reload | ecl-oz-maxima-oz | 40.046 (40.003–40.113; 39.698–40.218) | 29.697 | 0.998 | 0.202 |

The aggregate Node/server/browser CPUQuota=25% reference misses the aspirational D8 20-second cold target: candidate median readiness is 42.908 seconds, compared with 77.453 seconds for the control. A CPU quota is not an exact laptop-time prediction.

The first-positive gain is principally a real first-use JavaScript filesystem exception cost removed by final-link optimization; it is not evidence of a tenfold algebra or warmed-grading improvement. See [FIRST-GRADE.md](FIRST-GRADE.md) for narrow CPU profiles, loader observations, delivered glue hashes and the pinned Emscripten mechanism.

The timing artifacts predate the fresh integration build. That build passed the candidate compiled suite but failed the final source controller. An unmodified no-rebuild full UI run reproduced the same failure on repetition two. It occurs before the Python callback. Diagnosis remains open; neither a passing rerun nor changing session lifetime alone establishes a repair.
