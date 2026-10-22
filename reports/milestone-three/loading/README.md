# Native loader comparison

The reports in `39802432330/` came from the successful [Actions run](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39802432330).
Its source branch was `d79391075ee2450ad2e43c04866d6bc9f743435e`; Actions tested the PR merge revision `4113f05db47f45818bc1fbad193eb3d76e4f23fc`.
`summary.json` records the downloaded artifact ZIP hash and the uncompressed report hashes.
The compressed files preserve the complete raw reports, including each request, source fingerprint and real `AlgEquiv` result.

Each condition used three fresh Chromium processes, profiles and native workers. The two loaders used identical pinned Maxima/STACK files. The changed loader asynchronously fetches one hash-verified preload package and mounts its original bytes; the original loader fetches files on demand. OS, CDN and server compression caches were not cleared.

| Local server condition | Original readiness, median | Bundled readiness, median | Requests per sample |
| --- | ---: | ---: | ---: |
| No added latency | 38.57 s | 36.71 s | 137 → 12 |
| Simulated 80 ms per HTTP request | 48.32 s | 37.39 s | 137 → 12 |

All twelve actual native answer-test probes passed. The bundled loader removes 63 synchronous HEAD requests. Its compressed response bodies total about 324 kB more in this workload. The first answer test after readiness still takes about 2.4 s locally; warm grading is a separate measurement.

The added-latency condition is a controlled local experiment, not a measurement of the public page or a real network. These reports do not isolate ECL startup, STACK loading or compilation costs. Dedicated startup phase probes and exact-build public UI timings are separate evidence. Functional site builds do not overwrite these frozen benchmark reports.
