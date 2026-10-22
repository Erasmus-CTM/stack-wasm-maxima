# Public comparison-page timings

[Workflow run 39759255662](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39759255662) passed on 22 October 2026. Benchmark source: `ec553c3c9fcbe3830ec39dc97110479be3081823`. Measured exercise sources: `3ec984fdf6e52955c3c6ed9f8e1e3a332750d8c6`.

The measured public page's HTML SHA-256 was `3e1c86157bfb545423370bcabb75a40ace1249afd30930d6b73f198e5f78a8eb`, checked both before and after all trials. The same frontend/worker sources and question blocks are retained when adding the timing chapter and question-compatibility labels.

There are three fresh Chromium processes/profiles/workers per backend. Each starts with a real Validate click, with zero preceding worker calls, followed by five more validations, the first grade, and five more grades. The workload is the first rational-expression question, variant 1, with the same accepted correct answer. OS/CDN caches are not cleared; this is one Linux CI runner, not a user-device or broad question benchmark.

- [Computed summary](summary.json): exact medians, minima, maxima, sample counts, runner/browser details, asset fingerprints and provenance.
- [Complete raw report](timings.json.gz): gzip-compressed JSON containing every sample, real worker calls, initialization checkpoints, routing events and UI intervals.

Median first Validate was **5.95 s SymPy / 43.28 s Maxima**. Initialization accounted for **5.77 s / 43.10 s** respectively. Later Validate took **12.3 ms / 12.4 ms**, and later Check **12.4 ms / 39.0 ms**. Initial validation RPC after setup was about 180 ms on both backends.

The Maxima worker's Python-ready and Maxima-ready checkpoints overlap; do not add them. Click-to-feedback ends at the DOM update and excludes later MathJax paint. Worker RPC intervals exclude UI work. Warm rows have 15 calls across three workers; the first Check follows validation and is not cold startup.

The downloaded artifact ZIP's SHA-256 was verified against GitHub's digest. Raw and gzip hashes are included in the summary. Compatibility is documented separately in [question-compatibility.json](../../question-compatibility.json); the six PythonChecker questions run the same Python implementation in both displayed backends.
