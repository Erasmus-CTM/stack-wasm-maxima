# Reusable native board documents

`build-site.mjs` asks the pinned, unchanged JSXGraph Quarto extension to render
one document per question/board. `package-boards.mjs` writes those documents to
`native/boards/`, extracts complete base64 JavaScript/CSS resources to shared
SHA-256 filenames, and records the URL on a non-navigating iframe. The parent
fetches that same-origin URL once per page, inserts an explicit absolute base,
and mounts `srcdoc` inside the existing opaque sandbox. The decoded vendor bytes and
licence headers remain identical. The build manifest records source-document,
packaged-document and asset hashes. No generated vendor source is patched.

Each selected variant keeps a small iframe descriptor with its own prepared
numeric values. The existing exact-parent/iframe handshake carries these values
in `init`, bound to assessment ID, document instance, epoch and generation.
The template reads a frozen map only after readiness. Variant changes and Reset
mount the same fetched template and establish a new document instance. Pending
fetches cannot mount a replaced, reset or disposed instance. Failures are surfaced
and Reset can retry. They do not send executable code. Input metadata, collection, revision and
stale-generation checks continue to apply.

The current native inventory uses one source-format numeric coordinate token,
with the two prepared values -1 and -2. Other current boards have no tokens.
This packaging adapter accepts only finite decimal numeric source tokens used
as standalone array elements. Strings/comments/template literals, raw source
expressions, LaTeX tokens, signed zero and nonfinite numbers fail explicitly;
there is no new JavaScript evaluator or general authored-template interpreter.

The iframe retains `sandbox="allow-scripts"`. Its external scripts, modules and
stylesheet use CORS because its origin is opaque. A static host must provide
`Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`
for public assets beneath
`native/boards/assets/` and `native/boards/mathjax/`. `serveDemo` provides exactly
that policy while retaining COOP, COEP and CORP for the rest of the site. The
narrow CORP exception is needed by MathJax's original speech-worker importScripts;
anonymous CORS alone does not authorize that no-cors worker resource. No
credentials or runtime endpoints are made cross-origin. Offline copies must
retain this complete directory structure and use an HTTP static server with
those headers; a double-clicked `file:` page is not the execution contract.

Direct opaque HTTP template navigation was rejected on headerless static hosts,
where the new document is outside the parent's isolation worker. Parent fetch
and explicit-base `srcdoc` avoid that navigation entirely. Other native HTML and
nested documents retain their original restricted policy. The headerless test
server omits all raw COOP/COEP/CORP headers, including board resources; the
canonical worker supplies parent isolation. Supported opt-in CORS component and
worker transport must prove actual closure there. The frame's sandbox remains
`allow-scripts` only.

MathJax staging and its transitive font, accessibility and speech dependencies
are owned by the separate canonical asset producer. An unmapped external board
script fails the build. The adapter never removes speech or braille support.
The PR's browser evidence must establish complete offline loading and actual
cold/warm transfers, rather than inferring one wire transfer from a shared URL.

`test-package-boards.mjs` checks shared asset bytes, safe relative paths,
dynamic-import resolution, numeric data boundaries and narrow CORS/isolation.
`prototype/jsxgraph/test-adapter.mjs` covers scoped initialization and existing
two-way input, validation, collection and reset behavior. The actual rendered
site's native browser checks cover real authored boards and prepared seed
changes; packaging unit tests alone do not establish browser feature parity.
