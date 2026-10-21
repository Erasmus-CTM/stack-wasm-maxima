# STACK Wasm Maxima

Research and prototypes for using Maxima in WebAssembly with CTM Assessment's Quarto frontend and STACK grading libraries.

Milestone 1 runs unmodified STACK answer-test libraries in browser Wasm Maxima. At both tested STACK revisions, all 22 selected official fixture probes matched the native reference. See the [execution report](reports/milestone-one/latest.md).

Milestone 2 is building a [matched Quarto prototype](prototype/README.md): the same 19 documentation questions and 27 frozen variants through selectable SymPy and Maxima workers, retaining PythonChecker.

- [Prototype plan and milestones](plans/2026-10-prototype.md)
- [Matched demo source inventory](demos/manifest.json)
- [Runtime sizes, integration, and tradeoffs](reports/2026-10-21-runtime-size-and-integration.md)
- [Selectable backend API proposal](reports/2026-10-21-selectable-backends.md)
- [Recorded asset measurements](measurements/2026-10-21-runtime-assets.json)
- [Reproducible measurement script](scripts/measure-runtime-assets.mjs)

Run the asset measurement with Node.js 20 or later:

```sh
node scripts/measure-runtime-assets.mjs measurements/local-runtime-assets.json
```

The course configuration uses Pyodide 0.28.3, SymPy 1.13.3 and mpmath 1.3.0. The Maxima prototype currently retains those Python resources. Original four-file Maxima estimates omit dynamically loaded libraries and modules; use the dependency supplement and execution reports for the measured closure.

New code in this repository is licensed under AGPL-3.0-or-later; see [LICENSE](LICENSE). No upstream runtime binaries or third-party source code are committed here.
