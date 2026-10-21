# STACK Wasm Maxima

Research and a reproducible browser/native dependency check for using Maxima with CTM Assessment's existing Quarto interface.

- [Computed milestone 1 results](reports/milestone-one/latest.md)
- [Prototype plan and consolidation dependencies](plans/2026-10-prototype.md)
- [The exact documentation demo inventory](demos/README.md)
- [Runtime sizes and integration tradeoffs](reports/2026-10-21-runtime-size-and-integration.md)
- [Selectable backend API and PythonChecker](reports/2026-10-21-selectable-backends.md)
- [Wasm loader compatibility investigation](reports/2026-10-21-wasm-loader-investigation.md)

Milestone 1 reuses CTM's official fixture inventory, native oracle, argument preparation and strict result parser. Its scope is selected direct STACK answer tests. The matching Quarto demo and its `::: {.stack-maxima}` entry point are the next milestone; this repository does not yet provide an installable Quarto grading backend.

The demo target keeps CTM's cards, inputs, matrix editor, previews, Validate/Check controls, variants and feedback. It uses the exact XML and checker source pins of the existing documentation. PythonChecker stays in the shared Python implementation.

## Reproduce

Run the **STACK Wasm milestone 1** GitHub Actions workflow on the research branch. It checks out pinned CTM/STACK sources, computes native references, runs Chromium, compares the results, uploads raw diagnostics and preserves a computed report. The workflow definition lists the dependencies and commands for local execution.

For HTTP asset inventories alone, use Node.js 20 or later:

```sh
node scripts/measure-runtime-assets.mjs measurements/local-runtime-assets.json
```

The measurement script counts encoded HTTP response-body bytes, hashes decoded files, verifies Pyodide package hashes, and follows the Wasm modules' linked-library dependencies. It does not execute either CAS. The recorded original four-file measurement and the later linked-library supplement are separate historical records; neither substitutes for a cold question-page trace.

New code is AGPL-3.0-or-later; see [LICENSE](LICENSE). Third-party fixtures and upstream provenance are documented in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Runtime binaries and third-party implementation sources are fetched from their original homes.
