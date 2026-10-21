# Matched documentation demos

This directory freezes the first paired-demo target: all **19 live question cards / 27 variants** on stack-sympy's `index.qmd` and `examples.qmd` at the source revision in `manifest.json`. It includes the six PythonChecker cards. This inventory is not yet an executable Maxima Quarto extension.

The XML and Python files have one home, in `ctm-checkers/examples/stack`. The stack-sympy site copies them from its pinned ctm-checkers commit during rendering; they are not authored in stack-sympy. The manifest records that exact pin and every referenced XML/checker Git blob SHA. Milestone 1's newer native-fixture oracle pin is a separate dependency and must not silently replace the documentation pin.

## Quarto prototype target

Mirror the existing question pages, converting only their question entry points to `::: {.stack-maxima}` blocks. Preserve the question selection, seed, variant count, review settings, checker file, feedback settings and identifiers. A thin block adapter should feed the existing CTM question-card renderer. The inputs, matrix editor, Validate/Check controls, variant selection, previews and feedback stay in their current libraries.

For example, the landing-page question becomes:

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

This is the proposed authoring syntax. The renderer/backend wiring is the next milestone; adding the block to an arbitrary project does not currently enable Maxima.

## Paired measurement conditions

Use the exact frozen JSON variants produced by the pinned CTM build for both backends, rather than asking two random generators to reproduce each other. Replay the same authored tests and additional alternate-correct/incorrect answers. Keep PythonChecker in the shared Python backend and exercise mixed response trees through the backend orchestrator. Report any unsupported question as a visible failure with its reason.

Record first-load transfer bytes and initialization separately from warm validation and warm grading. Include medians and individual samples, browser/version, source pins, cache state and whether course Pyodide was already loaded. The dependency check's predownloaded-runtime timings are not substitutes for these page measurements.
