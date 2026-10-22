# Public deployment verification

Source `15fa33299d68d64e122a2661a2868feb30130edb` passed the [push reviewer workflow](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39823225049), including the full native browser harness and independent Maxima replay. Publication job `119993878416` also succeeded, including the deployed browser checks.

The accepted rendered-site artifact is `12448045201`. Its downloaded ZIP SHA256 matched GitHub's digest: `d32eb0462a485b9b29c279ffc1b300db23f5f5b10b3ff7becea7efdd51174ebc`.

Independent downloads of the public `maxima/examples.html`, `maxima/native.html` and `maxima/data-flow.html` response bodies matched the extracted artifact byte hashes. The public native build manifest reported the same source revision. Exact URLs and hashes are recorded in [public-verification.json](public-verification.json).

This is summary-only deployment provenance, separate from the acceptance summary and timing measurements. Public URLs can change on a later deployment; the recorded hashes identify the observed build. No raw question payloads are retained here.
