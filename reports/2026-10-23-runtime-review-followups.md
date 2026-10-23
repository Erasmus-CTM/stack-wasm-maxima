# Runtime review follow-up ledger

This ledger follows AC's decisions in the runtime-steps review at commit
`0c2b18d91544f3177dcf245d2bb135b3e0eaa2e9` (PR 10). The first step-2 PR is
complete external gnuplot removal only. Compiler optimization gets a separate
PR after its report, followed by precompiled STACK in another PR. The earlier
compiler experiment implementation remains a local snapshot at `755cba0`; its
cancelled runs are not acceptance evidence for this change.

| Finding | Current treatment | Remaining work / owner |
|---|---|---|
| F-1 build environment | Record runner image, kernel and exact dpkg versions in each artifact | Digest-pinned container/snapshot packages for release builds |
| F-2 reproducibility | Two independent cold builds, actual runtime-hash comparison, classification and differing-file list | State the observed classification only after CI |
| F-3 host cache | No restored host cache; rebuild and hash installed host before cross compilation | Audit hashes/provenance before any later caching |
| F-4 gnuplot | Remove external source/pin/build/patch and browser plot/library; fixed startup adapter and actual authored-question diagnostic | Full parity/timings gate this PR |
| F-5 upstream offer | Closed by removing the carried gnuplot patch | Historical failure/patch history retained in Git |
| F-6 durable runtime | Artifacts remain time-limited | AC decides release/tag; no release/tag created here |
| F-7 compression hosting | Document CTM sidecars as server/offline policy; measure actual public Pages encodings separately | Carry policy into assessment asset lock/offline server; Pages auto-compression is not deployment of these sidecars |
| F-8 board copies | No frontend changes in this runtime PR | Deduplicate in ctm-stack/JSXGraph authoring pipeline |
| F-9 all Brotli | Current tested mixed policy retained | Production call-entry loader may use manifest lengths for all Brotli |
| F-10 base synchronization | AC-only merges; root updates stale licence-first PR text | AC synchronizes main into #5, then refreshes stacked bases before merge |
| F-11 namespace persistence | No change to the spike's stated scope | Production worker needs question reset/isolation |
| F-12 traps | CAS recovery evidence keeps its stated limits | Production error taxonomy replaces worker for unrecoverable traps |
| Warm-profile reload | Same browser context and live origin, new page load and new worker, separate request/readiness deltas | Report observed cache/network/CPU differences without a speed claim |

The published site/default runtime remains unchanged. Local public-encoding
observations are provisional; CI repeats them and preserves the raw headers,
encoded counts and decoded hashes. GitHub Pages can apply its own automatic
gzip independently of our precompressed sidecar server policy.
