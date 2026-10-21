# Selectable STACK grading backends: proposed boundary

Status: design proposal, 21 October 2026. No new backend configuration is implemented yet.

## Goal

Keep the existing Quarto authoring format and CTM inputs, validation/check controls, result panels, typesetting, variant selection and AI-feedback integration. Allow the course author to choose the STACK grading implementation through configuration, with optional per-question overrides. The learner-facing UI consumes one result contract.

## Existing boundary

The current STACK component already posts request type, question, frozen variant and raw answers to a worker. Its Python page adapter exposes stack.validate, stack.grade and stack.tests. The worker returns an id and an ok/result or ok/error envelope. The frontend consumes input validity and LaTeX plus total score, per-PRT feedback and status. This is the seam to preserve.

The current runtime loader and checker-wheel installation explicitly depend on Pyodide. Backend selection is therefore a small abstraction plus loader/packaging work, not an existing configuration switch.

## Implementation work, with a stable public interface

| Area | Proposed work | Existing pieces reused |
|---|---|---|
| 1. Backend descriptor and selection | Resolve effective backend, its version, capabilities, assets and prepared-plan schema. Add course defaults and optional block overrides. | CTM settings/bootstrap and existing component metadata. |
| 2. Runtime and asset loading | Dispatch to a lazy SymPy/Pyodide or Maxima/ECL worker; preserve request IDs, serialization, cancellation, restart and stale-result handling. | Worker envelope, UI response snapshots, asset manifests and offline hosting work. |
| 3. Build-time preparation | Produce a plan for the selected backend. SymPy wraps the existing importer/instantiate path; Maxima uses pinned STACK tooling/native Maxima where feasible. | Quarto filter, card shell, authored XML, variant controls and question tests. |
| 4. Maxima execution adapter | Mount required libraries, restore isolated question state, validate/preview raw inputs, execute answer tests/PRTs and normalize feedback/results. | Upstream STACK Maxima functions and existing result contract. This is the main new implementation. |
| 5. Packaging and evidence | Package/pin the new runtime, extend offline assets, run existing goldens and targeted native/browser comparisons for each backend. | Existing native oracle, fixtures, mutation cases, corpus and browser tests. |

Only the first two areas are shared backend plumbing: registration/selection and loading/dispatch. Preparation, parsing, validation, CAS semantics, result normalization and most tests belong inside the selected backend. Packaging composes those implementations. These are engineering areas, not a verified file count or time estimate; they are not five interface changes. The frontend should have no SymPy-versus-Maxima branches. The prior consolidation is useful because it already separated frontend, shared runtime and checker implementation.

## Proposed API

- prepare(sourceQuestion, variantSpec) -> preparedQuestion at build time.
- validate(preparedQuestion, rawAnswers) -> CTM validation result at runtime.
- grade(preparedQuestion, rawAnswers) -> CTM grading result at runtime.
- tests(preparedQuestion, authoredTests) -> normalized question-test results.
- dispose()/restart() on the runtime handle, with shared request cancellation semantics.

The prepared question contains common display/input metadata and an opaque backend-specific plan. It also identifies the backend, engine/library versions, plan schema and question/variant identity. Do not require a shared CAS AST, a shared interpreter, or conversion of SymPy-frozen values into Maxima values.

Use the existing worker reply envelope. Validation returns status and input validity, LaTeX previews and messages. Grading returns status, finite total score, input details and per-PRT scores/notes/feedback. The adapter handles language-tag translation and feedback sanitization before the UI inserts any HTML. Existing Python custom-checker assessment data needs a documented optional field/capability.

## Selection and capabilities

A possible configuration is a new backend key under the component's planned stack-sympy settings section, with a block-level backend override. Values would be sympy or maxima. This is proposed syntax, not a setting users can apply today. Keeping the component name avoids requiring an unrelated rename of existing authoring.

Resolve and bind the backend during the build. Preparation, validation, grading and authored tests must agree on the same backend and compatible plan/library versions. In-page variant switching retains that binding. A deliberate backend change triggers preparation and revalidation.

Backend selection is transparent to the UI. Every backend implements the same public request/result contract. Domain/branch conventions, rounding, supported answer tests and custom-checker extensions are backend implementation and conformance concerns; resolving them does not require another frontend interface. Each backend owns parsing, validation, assessment and result normalization. Do not silently retry a failed grade with another backend. Unsupported features produce the common authoring diagnostic through the backend contract.

Capability checks should identify supported input types, answer-test families, question options, raw-form requirements, Python extensions and deployment/isolation requirements. More general CTM inputs, such as graph responses or basis-property feedback, need an explicit backend mapping before their support is claimed.

## Where code belongs

- stack-wasm-maxima: one home for the Maxima runner, its adapter and dependency manifest/build tooling.
- ctm-checkers: keep the Python/SymPy engine and Python custom checkers in their existing home; add a thin adapter only where required.
- ctm-libs: reusable backend selection/loading and frontend result plumbing, with runtime-specific code behind its descriptor. No second copy of the input UI.
- stack-sympy: Quarto authoring and card integration, selecting the prepared plan and runner.
- ctm-assessment: package composition, pinned backend resources and offline/exam asset configuration.

## Resource implications

Selectable backends let a Maxima-only practice page omit Pyodide when it has no Python exercises or custom checkers. A Python-heavy page still needs Python plus Maxima if Maxima is selected. Shared frontend components are not duplicated. Match the runtime-size report's explicit asset scope; actual first-grade dependencies and startup time remain unmeasured.

A first integration prototype should support one existing scalar question and one matrix question through both adapters using the same frontend. Then compare question preparation, previews, scores, PRT paths, feedback and qtests, and measure the two runtime workers together. This is a proposed next step, not a completed integration.
