# Lossless runtime sidecars

This separate experiment augments a successful owned-build artifact with gzip-9
and Brotli-11 sidecars. It preserves all original raw runtime bytes, canonical
hashes, upstream notices, full source archives, recipe and source manifest.
Compression itself trims no file or changes a mathematical source/compiler flag, and the
published site and default serving behavior are unchanged.

The compressor requires Node 22.16.0 from the same exact Linux SDK Node archive
already pinned by the owned build. The installer verifies its SHA-256 and byte
count before fresh extraction. The actual executing Node binary is hashed,
with zlib/Brotli versions and parameters recorded. gzip mtime is asserted zero
and its OS header byte is retained; every gzip/Brotli output is decoded and
checked against the canonical raw SHA-256. Tiny files below 256 bytes keep
identity delivery. Both sidecars remain available for size comparison even
where a candidate encoding would be larger than identity.

The pinned Emscripten lazy-file loader only recognizes `Content-Encoding: gzip`
when obtaining a decoded file length. Brotli is therefore limited to ordinary
fetches for main Wasm, JavaScript and the derived preload JSON. Lazy modules
and share resources use gzip; explicit byte ranges always return the requested
canonical identity bytes and offsets. The runtime loader is unchanged.

`CTM_RUNTIME_COMPRESSION_SOURCE=ARTIFACT` with
`CTM_RUNTIME_COMPRESSION_MODE=gzip` or `br` opts the research static server into
verified prebuilt delivery. Without that source the existing server behavior
is unchanged. Every runtime request must match the sidecar inventory and raw
digest; encoded bytes and decoded digests are verified before serving.

This negotiation is a policy for servers/offline hosting we control. GitHub
Pages does not deploy these sidecars or this per-file policy. Pages may apply
its own automatic gzip independently; `runtime/build/measure-pages.mjs` records
the public preview's actual headers and encoded body counts separately.

The workflow takes an explicit successful owned-build run ID, or prefers a
successful owned-build PR run from the current branch. It selects the uniquely
named primary cold-build artifact, leaving the second cold rebuild distinct.
It never substitutes deployed bytes when
that artifact is unavailable. Preserved owned-build recipe files must match the
current relevant tracked build inputs byte for byte, so an older artifact is
accepted only when its exact source pins and recipe still match. The selected
run's API head SHA and actual recipe revision remain separate: the latter must
equal the head or directly merge it, as verified through the commit API.

It rebuilds only the test page, then runs both delivery policies through the
native browser checks and exactly 316-program desktop replays each, requiring
zero unaccepted differences. Each replay is the existing combined trace:
shared raw build-time preparation programs plus fresh compressed browser-session
programs. Origin counts are reported explicitly; this does not claim 316 new
Wasm executions under each encoding. An additional real
Chromium session disables preload to exercise lazy HEAD/GET gzip behavior and
ordinary Wasm Brotli, then verifies an explicit identity byte range against
the original Wasm offsets. Raw failures and augmented artifacts are retained.

The historical 81-file runtime and the derived preload JSON were tabulated
separately. The preload duplicates packaged runtime content, so totals that
include it describe packaging bytes rather than unique runtime bytes. The
[original compression run](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39875818721)
validated that historical build. The no-gnuplot consumer now requires the exact
current 79-file closure and startup configuration; its new sizes require fresh
CI evidence. Local unit fixtures on a different Node are not production size evidence.
Existing readiness events, UI round-trip times and actual encoded request bytes
are summarized as observations with cache/deferred-work effects; no statistical
speed comparison is inferred from these sessions.
