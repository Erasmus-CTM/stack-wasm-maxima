# STACK bindings in existing Quarto boards

This adapter reuses the sandboxed iframe and assessment response transport of
`jsxgraph/jsxgraph-quarto`. It does not render a board. The build integration
turns supported STACK `[[jsxgraph]]` content into an ordinary Quarto
`.jsxgraph` block and imports STACK's unchanged `stackjsxgraph.js` bindings.

## Integration

The parent page loads `host.js` and calls
`CTMStackJSXGraph.install(document)` after the shared CTM frontend has created
its cards. An iframe inside `section.stack-sympy` carries this descriptor:

```html
data-stack-jsxgraph='{"assessmentId":"native-question-v1-board1","inputs":["ans1"]}'
```

`assessmentId` must match the stock Quarto block's `assessment_id` and be unique
on the rendered page. Every listed input must be an existing ordinary CTM text
input, `.stack-answer[data-name]`, in the containing card. The adapter cannot
access inputs or feedback in another card, even if an author omits STACK's
optional `limittoquestion` argument.

The iframe embeds `frame.js` before the author code and creates its STACK-JS
compatibility object:

```javascript
const stack_js = CTMStackJSXGraphFrame.create({
  assessmentId: 'native-question-v1-board1',
  inputNames: ['ans1']
});
const ref_A = await stack_js.request_access_to_input('ans1', true, true);
// The unmodified question code can now call stack_jxg.bind_point(ref_A, pA).
// After all original question code has run:
await stack_js.mark_ready();
```

Initial input values and STACK metadata are synchronized before the promise
resolves. The mirrored input uses the original name as its iframe-local ID.
The Quarto assessment provider returns `{inputs:{ans1:rawString}}` and waits
until pending writes finish. Author code may read the same ordinary DOM input
and send a `change` event, as in upstream JSON state examples.

## Supported operations and lifecycle

- `request_access_to_input`, `get_input_metadata`, and `clear_input`.
- `get_content`, restricted to IDs in the containing card.
- `register_validation_state_listener` and scoped external button listeners.
- `display_error`, plus adapter-only `ready`, `mark_ready` and `dispose`.

Other STACK-JS operations are not currently implemented. Matrix editor controls
are not text-input bindings; use an explicit structured response integration
for those. JSON and string inputs are transported as raw strings without
algebraic coercion. Their declared interpretation belongs to the backend.

The parent forwards ordinary text edits to the board and board edits to the
same CTM controls and invalidation events used by typed answers. Before Validate
or Check, it uses Quarto's existing assessment request to drain pending board
writes, then invokes the same existing CTM button handler. Reset reloads the
original iframe data URL (or `srcdoc`) so author-defined initial geometry is restored. Variant
changes disconnect replaced frames. Layout uses the existing Quarto `layout`
notification and a parent resize observer. `mark_ready` also triggers layout
after the original board code finishes and marks the parent iframe with
`data-stack-jsxgraph-ready="true"`; Reset clears that marker before navigation.

The compatibility protocol is `ctm-stack-jsxgraph`, version 1. Each document has
a distinct instance ID; each parent attachment/reset has a distinct generation.
Both sides check the source window, board ID, instance and generation. Parent
input revisions reject writes that raced a more recent typed edit. Responses,
names and content have explicit size limits. Request timeouts report errors;
an unconnected or invalid board never supplies an empty successful response.

Run `node prototype/jsxgraph/test-adapter.mjs` for the protocol/DOM-boundary
tests. These use a small DOM fixture; real board interaction and Quarto rendering
remain browser integration checks and must pass separately before release.
