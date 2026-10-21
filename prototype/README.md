# Matched Quarto prototype

This prototype reuses the pinned stack-sympy pages, CTM frontend, XML questions, frozen variant generator, input validation, PRT controller, feedback and PythonChecker implementation. The Maxima edition changes the authoring class to `stack-maxima` and dispatches ordinary answer tests to unmodified STACK libraries in a persistent Wasm Maxima worker.

This is a hybrid prototype: both editions still load Pyodide and SymPy. It tests whether the native STACK grading seam works with the existing application. It does not demonstrate removal of Python resources or a faster cold start.

## Sources

| Source | Commit |
|---|---|
| stack-sympy | `1b1d50f69fc1e7eb39846b497657d72be325f597` |
| ctm-checkers | `c366f175aba6b62caa628bc60f57bb1167fc087b` |
| ctm-libs | `94687f718fd651fc2857bc5242a64e45c8fd4697` |
| STACK | `33383047af39c204bf4442802a058f8b918b2b1b` |

The source inventory is [demos/manifest.json](../demos/manifest.json): 19 question cards and 27 variants, including the six PythonChecker cards. Generated pages preserve authored seeds, variant counts, XML and checker source hashes. The post-render collector requires equal frozen payloads in the two editions.

## Build and try

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
