# STACK Wasm Maxima

Research into using Maxima in WebAssembly with CTM Assessment's Quarto frontend and STACK grading libraries.

The current work is an asset measurement and integration assessment. It is not yet a working STACK-on-Wasm grader.

- [Runtime sizes, integration, and tradeoffs](reports/2026-10-21-runtime-size-and-integration.md)
- [Selectable backend API proposal](reports/2026-10-21-selectable-backends.md)
- [Recorded asset measurements](measurements/2026-10-21-runtime-assets.json)
- [Reproducible measurement script](scripts/measure-runtime-assets.mjs)

Run with Node.js 20 or later (no dependencies):

```sh
node scripts/measure-runtime-assets.mjs measurements/local-runtime-assets.json
```

The script downloads selected public assets into memory, records actual encoded HTTP body sizes and decoded-file SHA-256 values, and verifies Python package hashes against the pinned Pyodide lock. It does not execute Maxima or Pyodide. The upstream Maxima deployment is mutable; the recorded hashes identify the files measured.

The course configuration uses Pyodide 0.28.3, SymPy 1.13.3 and mpmath 1.3.0. These measurements do not describe the full Pyodide distribution or every Maxima package.

New code in this repository is licensed under AGPL-3.0-or-later; see [LICENSE](LICENSE). No upstream runtime binaries or third-party source code are redistributed here.

