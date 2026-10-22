# Frozen public timing evidence

The accepted batch is [run 39831459804, attempt 2](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39831459804/attempts/2), measured on 22 October 2026.
Both comparison and native timing steps passed. The final page tables use this complete
successful batch only; ordinary builds do not regenerate timings.

- Measured deployment source: `15fa33299d68d64e122a2661a2868feb30130edb`.
- Benchmark source: `1886d5dd3ef30edb5096601cea841684c0290860`.
- [Comparison summary](39831459804-attempt-2/comparison-summary.json): six profiles,
  three per backend, with 15 warm calls per operation/backend.
- [Native summary](39831459804-attempt-2/native-summary.json): three profiles,
  15 warm calls per operation, actual final browser Document hashes and counts only.
- [Earlier failed admissions](failed-attempts.json) remain separate and are excluded
  from final statistics. Run attempt 1 and attempt 2 have different artifact IDs even
  though their artifact names match.

Values are milliseconds in JSON, with median/minimum/maximum/sample count. Page tables
convert selected first-call rows to seconds. UI clocks cover original button click to
verdict DOM mutation, including board collection/replay; worker clocks cover actual
postMessage/response. Initialization belongs to the relevant first UI operation and
must not be added to it. Hybrid native startup is deferred to the first native Check.
The optional Python workload begins with warm Maxima and measures incremental Python
startup. Native warm validation/response-tree costs are higher than the hybrid's
answer-test-only delegation; these are different execution paths.

Navigation, initial HTML loading, isolation bootstrap, answer entry and later MathJax
painting are excluded from button timings. All profiles are fresh Chromium processes
and browser caches, but OS/CDN caches are not cleared. Provenance requests can warm CDN
caches. These accepted workloads on one runner are descriptive, not confidence
intervals, user-device predictions or controlled comparisons with historical builds.
Older milestone 2 and local loader tables remain labelled historical.

## Exact-build acceptance

Comparison HTML SHA-256: `ab1be8fe366093b3134c60010160bdb7839d62bbdb598d6c0a5735d36c314942`.
Native HTML SHA-256: `a483b6d59808a4e626a5eeb6303dea0528c6acbd9fcf1f10f896807859d7ddae` (16,855,012 bytes).
Every native profile records its actual final service-worker Document URL, status,
COOP/COEP headers, byte count and SHA-256 from the same CDP session that retained its
response. The 64 MiB per-resource and 256 MiB total inspector buffers prevent eviction;
experimental durable messages are disabled. No DOM or standalone-fetch replacement
was accepted for the final-navigation hash gate. Before/after fetch hashes and public
asset/source fingerprints independently record deployment stability.

Each native profile proves zero assessment RPCs before its first action, one worker,
one initialization, 20 RPCs, six Python callbacks and one Python-ready event. Through
board validation it records zero interpreter/stdlib/wheel requests and Python unloaded.
The small pyodide-runtime.js helper is excluded from interpreter counts.

## Original artifact

[Artifact 12450225673](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39831459804/artifacts/12450225673)
contains the complete raw and summary reports from the successful attempt.
ZIP SHA-256: `1fcc1ae388e5c22ac8023e8a08f3d28d7d9589a1ab0e907076f183d1612fe2d3`;
size 93,050 bytes; recorded expiration **20 January 2027, 18:32:26 UTC**.
The repository summaries use an explicit whitelist: method/limits, runner/browser,
statistics, numeric sample times/pass checks, actual final navigation records and
public asset/source fingerprints. They omit full worker programs, question/answer
payloads, console bodies and network bodies.
