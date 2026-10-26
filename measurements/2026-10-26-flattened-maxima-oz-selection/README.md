# Flattened ecl-oz-maxima-oz production selection, 26 October 2026

Primary evidence is the exact accepted production artifact for PR #28 head `0d1141e68deb63863a3f9e6a1776d52f06b20cc5`, tested as merge `d3ae000d86f165e537d08c0ec9d1ebf7724e6bd2`. The independent no-rebuild comparison used source-loaded STACK, ten balanced repetitions per profile and load mode, first unrestricted and then under aggregate `systemd CPUQuota=25%`, on one runner. All 80 complete samples passed. Five repetitions use AB order and five BA order.

Each cell below is **median [Q1, Q3] in seconds**, using inclusive linear interpolation. Full minimum/maximum, sample standard deviation and all ten raw observations for each metric/group are in [results.json](records/primary/results.json). [The 80 raw timing samples as CSV](primary-raw-samples.csv) retain repetition, profile, load mode, CPU condition and unique run ID. Nothing is pooled with the secondary run.

**Readiness**

| CPU condition | Load | ecl-oz | ecl-oz-maxima-oz | Improvement |
|---|---|---:|---:|---:|
| unrestricted | cold | 12.190 [12.061, 12.656] | 6.818 [6.696, 6.902] | 5.372 s / 44.1% |
| unrestricted | warm-profile-reload | 11.987 [11.781, 12.250] | 6.308 [6.113, 6.360] | 5.678 s / 47.4% |
| CPUQuota=25% | cold | 48.548 [48.105, 50.148] | 28.253 [27.353, 28.758] | 20.295 s / 41.8% |
| CPUQuota=25% | warm-profile-reload | 42.907 [42.622, 43.707] | 22.913 [21.802, 23.164] | 19.993 s / 46.6% |

**Source STACK loading**

| CPU condition | Load | ecl-oz | ecl-oz-maxima-oz | Improvement |
|---|---|---:|---:|---:|
| unrestricted | cold | 8.413 [8.242, 8.475] | 4.906 [4.832, 4.994] | 3.507 s / 41.7% |
| unrestricted | warm-profile-reload | 8.282 [8.181, 8.414] | 5.008 [4.837, 5.059] | 3.275 s / 39.5% |
| CPUQuota=25% | cold | 35.696 [35.011, 36.631] | 19.455 [19.021, 20.454] | 16.240 s / 45.5% |
| CPUQuota=25% | warm-profile-reload | 33.548 [33.198, 34.190] | 18.411 [16.972, 18.602] | 15.136 s / 45.1% |

**First positive STACK grade**

| CPU condition | Load | ecl-oz | ecl-oz-maxima-oz | Improvement |
|---|---|---:|---:|---:|
| unrestricted | cold | 1.426 [1.409, 1.443] | 0.119 [0.118, 0.122] | 11.98× |
| unrestricted | warm-profile-reload | 1.431 [1.416, 1.460] | 0.117 [0.114, 0.118] | 12.21× |
| CPUQuota=25% | cold | 5.894 [5.818, 5.972] | 0.691 [0.605, 0.697] | 8.53× |
| CPUQuota=25% | warm-profile-reload | 5.851 [5.794, 5.984] | 0.555 [0.501, 0.684] | 10.53× |

D8 uses the CPUQuota=25% cold reference: **28.253 s versus the 20 s wish: not met**. The target is separate from correctness acceptance. A CPU quota is an environment description, not an exact student-laptop prediction.

The primary runner reports AMD EPYC 9V45 96-Core Processor, 4 logical CPUs and 16766414848 bytes RAM. The quota covers Node, the local server and Chromium together and caps them at a quarter of one CPU. Cold means a fresh browser/profile; host OS caches are uncontrolled. A warm-profile reload follows acknowledged termination of the preceding worker and creates a new worker in the retained browser profile. Both arms use identical pinned source STACK/checker files, current classifier startup, marker observer and captured native programs; runtime binaries are reused from independently accepted producer archives. Compiled STACK remains opt-in and is not timed here.

**Why the first grade improves**

The large first-use gain is explained by [the controlled CPU, module-load and filesystem-glue investigation](https://github.com/Erasmus-CTM/stack-wasm-maxima/blob/0d1141e68deb63863a3f9e6a1776d52f06b20cc5/measurements/2026-10-25-maxima-oz-selection/FIRST-GRADE.md). Both profiles load `genut` on first grading. In the older final-link JavaScript glue, filesystem probes construct expensive error stacks; the `-Oz` main link disables that assertion-related filesystem error overhead. The measured CPU leaf accounts for most of the earlier 2.49-to-0.23-second difference; V8 module compilation accounts for milliseconds. This is a real first-use loading/glue effect, not evidence of tenfold warmed algebra throughput. The new timing run uses the same unprofiled matched workload in both arms.

**Correctness and provenance**

The final-head production build passed both STACK pins, source and compiled controller comparisons of all 316 captured programs against independent and same-source native runtimes, 24 restarts, graphics/offline MathJax, plot policy, and source/compiled during-call GC stress. [Acceptance](production/acceptance.json) binds those records to [the runtime manifest](production/manifest.json). Source stress passed 400 iterations of eight target programs plus a full 316-program replay under 16,852 collections; compiled stress passed the same workload under 27,547 collections, with zero deviations. The compiler proof requires the exact `flatten,spill-pointers,simplify-locals-notee-nostructure,vacuum,coalesce-locals,reorder-locals` sequence after optimization.

The standalone reproducer demonstrates that plain spilling misses transient pointers held on the Wasm value stack across nested calls; flattening exposes them as locals. Cleanup preserves spill stores while keeping V8 local counts within its limit. [Reproducer CI](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40231542637) covers two SDK and two collector versions with failing negative controls and zero losses after flattening.

[Earlier C4 replication](records/replication-c4/results.json) independently passed another 80 samples on its own runner. Its cold medians were 13.492 to 7.182 s unrestricted and 54.453 to 30.509 s under CPUQuota=25%. Ten Wasm assets differ between that build and the final build ([comparison](production/comparison-with-replication.json)), so the primary run above uses the exact final-head artifact. Secondary samples and statistics remain separate and complete in [the secondary raw CSV](replication-c4-raw-samples.csv) and reports.

See [evidence-index.json](evidence-index.json) for immutable workflow/artifact IDs, SHA-256 digests, source identities and full/compact evidence links. Complete raw primary [full-speed](records/primary/report.json) and [CPU-limited](records/primary/cpu-quarter/report.json) reports, [independent admission](records/primary/admission.json), [producer API records](records/primary/producer-api.json), [hardware](records/primary/runner-hardware.json), and the original file inventory are retained. Intermediate progress snapshots remain in the original artifact; complete samples are preserved here.

Release-record schema 1 is unchanged: its `compilerProfile` remains a string, now `ecl-oz-maxima-oz`. Runtime payload paths and the 79-asset runtime closure are unchanged. The runtime manifest's `compilerProfile` object additionally records scoped Maxima/STACK optimization and `gcSpillPasses`; new provenance inputs stay under the existing source-archive recipe paths. The site pin can use the generated v3 release record without a format change. Source-loaded STACK remains the default. AC merges PR #28 and dispatches **Release the owned Maxima runtime** on main with tag `runtime-v3`; the site pin changes in a separate PR afterward.
