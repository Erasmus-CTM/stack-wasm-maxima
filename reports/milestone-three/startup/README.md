# Native startup diagnostics

This directory provides aggregate measurements and provenance only. Raw reports remain in the original GitHub Actions artifacts linked below; they are not included in this summary. Actions artifacts may expire (currently scheduled for 20 January 2027), and downloading them may require GitHub authentication. The ZIP and raw-report SHA-256 digests in [index.json](index.json) identify the measured evidence independently of its future availability.

## Method and limits

These are frozen **instrumented local diagnostics**, not public button-to-verdict timings. Every mode used a fresh Chromium process/profile and native worker on one GitHub-hosted runner. Filesystem and Lisp tracing add substantial overhead. Parent and child load durations are inclusive and must not be added together. OS/CDN caches were not cleared. There is one sample per mode per run, so these measurements do not establish a production speedup, variance estimate, or confidence interval.

## Successful baseline and deliberately reduced configuration

[Run 39815640449](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39815640449), source `b2b02ded87f27dc4a469239e83002c79969b4276`:

| Instrumented mode | Native readiness | Core-ready marker | Load events | Answer-test probes |
| --- | ---: | ---: | ---: | --- |
| Full stock startup | 62.49 s | 2.91 s | 80 | 4/4 passed |
| Core without statistics tail | 37.81 s | 2.32 s | 57 | 4/4 passed |

Both modes reported no startup errors. The reduced mode omits statistics libraries and optional tail setup. It is **not full STACK**, and four answer tests do not prove broader question compatibility. It is never the production default.

Within the full diagnostic sample, the stock loader took 59.50 s inclusively. Linear algebra took 17.29 s, including 12.90 s in its nested setup; statistics loading took 16.29 s. These measurements identify library loading/compilation as an investigation target. They do not isolate each library's independent cost or predict its production delay.

## Negative experiments

| Run | Measured outcome | Decision |
| --- | --- | --- |
| 39811650324 | Full 77.10 s; exact-directory 71.88 s; cache-off exceeded 240 s | Cache-off failed. The older filesystem trace was capped, so directory-search equivalence was not established. |
| 39813361860 | Full 78.21 s (core 3.54 s); reduced 49.86 s (core 3.07 s); exact-directory 63.34 s | Exact-directory mode failed one library load and omitted 17 source paths: 62 versus 80 load events. The guard rejected it despite four passing probes. |

Both negative runs have overall `passed:false`. Their faster rejected samples are not accepted optimizations. Reduced-mode timings do not authorize removing libraries from production.

## Original evidence and verification

Read-only GitHub metadata checked on 22 October 2026 identifies the repository as public, ID `1428812079`. All three artifacts report that same repository ID for both the workflow and its source repository. Their reported ZIP digests match the downloaded ZIP bytes; raw-report digests identify the original report entry.

| Source revision | Original artifact |
| --- | --- |
| `aa3983996f311d28100b20faa5f11e380f7c21a5` | [Run 39811650324 / artifact 12440118099](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39811650324/artifacts/12440118099) |
| `399c66ccade6acc7ba0fdf86de157e3e563269e7` | [Run 39813361860 / artifact 12441735803](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39813361860/artifacts/12441735803) |
| `b2b02ded87f27dc4a469239e83002c79969b4276` | [Run 39815640449 / artifact 12442177398](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39815640449/artifacts/12442177398) |

[index.json](index.json) records exact SHA-256 digests, source revisions, runtime pins, aggregate phases and failure decisions. It contains no raw traces or source text.

## Production decision

Production retains the full stock STACK loader and file-search cache. The separately verified [preload package comparison](../loading/README.md) is the accepted loading change. Reusing compilation caches is a possible next experiment, requiring exact runtime/source pins and full-question parity before promotion. No production change is justified solely by the diagnostic times above.
