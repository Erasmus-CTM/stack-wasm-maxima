# Paired reviewer-page evidence

[Run 39754203113](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39754203113) passes at executable source `3ec984fdf6e52955c3c6ed9f8e1e3a332750d8c6`.

Both the rendered localhost page and the deployed [GitHub Pages comparison](https://erasmus-ctm.github.io/stack-wasm-maxima/previews/research/2026-10-runtime-feasibility/maxima/examples.html) pass 36 cards / 18 pairs, with 24 variants, 112 authored test rows and six PythonChecker questions per backend. Structured results match exactly. Real scalar/matrix validation and grading, worker routing, unique identifiers, and independent edit/reset state are included.

- [Computed summary](summary.json) includes navigation/isolation, worker URLs, native event counts, hashes and artifact provenance.
- [Local raw report](local-smoke.json.gz) and [public raw report](public-smoke.json.gz) are gzip-compressed UTF-8 JSON, retained in full.
- [Scalar pair](backend-pair-scalar.png) and [matrix pair](backend-pair-matrix.png) show real successful assessment controls. Public and local screenshots are byte-identical and were visually inspected.
- Public HTML SHA-256: `3e1c86157bfb545423370bcabb75a40ace1249afd30930d6b73f198e5f78a8eb`.

The artifact ZIP hashes were checked after download. The summary records the raw JSON and gzip hashes. Decompress either raw report with a standard gzip reader to inspect every observed request and response. The page is the ordinary tracked `site/maxima/examples.qmd`, built and deployed by GitHub Actions; no separate hosted snapshot is required.
