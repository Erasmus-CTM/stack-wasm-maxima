# Matched Quarto prototype

This prototype reuses the pinned stack-sympy pages, CTM frontend, XML questions, frozen variant generator, input validation, PRT controller, feedback and PythonChecker implementation. The Maxima edition changes the authoring class to `stack-maxima` and dispatches ordinary answer tests to unmodified STACK libraries in a persistent Wasm Maxima worker.

This is a hybrid prototype: both editions still load Pyodide and SymPy. It tests whether the native STACK grading seam works with the existing application. It does not demonstrate removal of Python resources or a faster cold start.

CTM also formats native decimal/list/set/matrix diagnostics. List positions come from native answer notes; the existing CTM collection formatter supplies the wording and bounded set descriptions, with consistency checks against native verdicts and diagnostic keys. No extra CAS calls or SymPy answer-test fallback are used. Raw upstream feedback is retained for inspection; this is not a general translation of STACK's feedback protocol.

Selection is per question card. An ordinary `stack-question` block uses SymPy; a `stack-maxima` block selects the named Maxima worker through its enclosing wrapper. Each backend has its own persistent worker, queue, request IDs and reset handling. Missing Maxima configuration fails closed. General course settings and production backend registration remain later integration work.

## Sources

| Source | Commit |
|---|---|
| stack-sympy | `1b1d50f69fc1e7eb39846b497657d72be325f597` |
| ctm-checkers | `c366f175aba6b62caa628bc60f57bb1167fc087b` |
| ctm-libs | `94687f718fd651fc2857bc5242a64e45c8fd4697` |
| STACK | `33383047af39c204bf4442802a058f8b918b2b1b` |

The source inventory is [demos/manifest.json](../demos/manifest.json): 19 question cards and 27 variants, including the six PythonChecker cards. Generated pages preserve authored seeds, variant counts, XML and checker source hashes. The post-render collector requires equal frozen payloads in the two editions.

## Build and try

The reviewer page is committed directly as [site/maxima/examples.qmd](../site/maxima/examples.qmd). It contains the 18 worked questions as consecutive SymPy and Maxima subsections, with 24 variants and 112 authored test rows per backend. Each copy has its own identifier and controls. Select the same variant number to compare a pair. The introductory question remains covered separately by the original 19-card milestone suite.

[site.yml](../.github/workflows/site.yml) stages the pinned dependencies without rewriting that QMD, renders it with Quarto 1.8.27, verifies both real grading workers, and publishes only passing output to the activated `gh-pages` source. Research previews use `previews/<branch>/maxima/examples.html`; main uses `maxima/examples.html`. A small service worker establishes the isolation required by Maxima on GitHub Pages; the first visit may reload once.

The complete dependency checkout and build commands are in [milestone-two.yml](../.github/workflows/milestone-two.yml). It uses Python 3.12, Quarto 1.8.27 and Node 22. Source checkouts live under `.m2-sources/`; generated work lives under `.cache/milestone-two/`.

After dependency installation:

```sh
python scripts/milestone-two/materialize.py --stack-sympy-source .m2-sources/stack-sympy --ctm-checkers-source .m2-sources/ctm-checkers --ctm-libs-source .m2-sources/ctm-libs
python scripts/milestone-two/prepare-runtime.py --stack-source .m2-sources/stack --ctm-checkers-source .m2-sources/ctm-checkers
CTM_COMPONENT_DEV=1 CTM_LIBS_EXTENSION="$PWD/.cache/milestone-two/demo/_extensions/ctm-libs" CTM_CHECKERS_EXTENSION="$PWD/.cache/milestone-two/demo/_extensions/ctm-checkers" STACK_SYMPY_PYTHON=python quarto render .cache/milestone-two/demo
python scripts/milestone-two/materialize.py --collect-site .cache/milestone-two/demo/_site --payload-output test-results/milestone-two/frozen-payloads.json
node scripts/milestone-two/serve.mjs
```

Open the printed localhost address. The pages live under `maxima/` and `sympy/`. This host supplies cross-origin isolation headers and gzip compression, including for the runtime's lazy file requests.

The post-render collector removes Quarto 1.8.27's optional ES6 polyfill tag identically from both editions: that obsolete CDN response is blocked by the required isolation headers, and both Wasm runtimes already require modern browsers. Page hashes and removal counts are recorded in `MATERIALIZATION.json`; the question payloads and CTM controls are unchanged.

A Maxima question is authored as:

```markdown
::: {.stack-maxima}
#| file: questions/polynomial-expansion.xml
#| question: Expand a product (form-sensitive)
#| variants: 3
#| seed: 17
#| review: true
#| feedback: true
:::
```

The small Quarto filter converts that block into the existing CTM question block. A guarded frontend patch supplies a worker URL and status label; the default worker remains SymPy.

## Verify and measure

```sh
node scripts/milestone-two/run.mjs
```

The launcher serves the generated site, runs the matched browser harness, writes diagnostics under `test-results/milestone-two/` and closes the server. CI preserves the rendered site and diagnostics as an Actions artifact. Results should be read with their source commit and run URL.

The benchmark records the real worker RPCs and backend routing events. Native answer tests must produce native routing evidence, and PythonChecker questions must retain Python routing evidence. Startup measurements include the full fresh-page runtime load; warm calls are measured separately. Transfer results describe this gzip localhost host, with public CDN dependencies measured by browser network events.
