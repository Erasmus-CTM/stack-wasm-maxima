# Third-party notices

The executable runtime and STACK source files are fetched into ignored working directories during the experiment; no upstream runtime binaries are committed.

That stays true for the repository. The published GitHub Pages site, however, does redistribute the runtime binaries and the STACK sources. It serves the Maxima, ECL and gnuplot WebAssembly runtime (`maxima-runtime/`, unmodified from https://maxima-on-wasm.pages.dev/), the STACK Maxima libraries (`stack-sources.json`), STACK JavaScript and sample questions, JSXGraph inlined into board pages, and the Quarto page libraries. The page `site/licenses.qmd` (published as `licenses.html`, "Licences and sources") lists each component with its version, licence, the evidence for that licence and the exact upstream source. The licence texts are in `site/LICENSES/`. In summary:

| Component | Licence as recorded on the page |
|---|---|
| Maxima 5.49 port (`branch_5_49_base_90_g813903d33`) | GNU GPL version 2 (Maxima `COPYING`); share packages and some core files carry their own notices |
| ECL 26.3.27, with bundled GMP 4.2.1 and Boehm GC 8.2.8 | LGPL-2.1-or-later (ECL and GMP); Boehm-GC (garbage collector) |
| gnuplot 6.1 patchlevel 0 (2025-02-15) | gnuplot's own licence (its `Copyright` file) |
| Emscripten glue and system libraries | MIT or NCSA; musl MIT; LLVM libraries Apache-2.0 with LLVM exception |
| STACK at 33383047af39c204bf4442802a058f8b918b2b1b | GPL-3.0-or-later per `COPYING.txt` (many file headers say version two); sample questions CC-BY-SA-4.0; HELM questions CC-BY-NC-4.0 |
| JSXGraph 1.14.1, jsxgraph-quarto | LGPL-3.0-or-later or MIT; MIT |
| Quarto 1.8.27 page libraries | MIT (Bootstrap, Popper, tippy.js and others), Apache-2.0 (Fuse.js) |

Pyodide, MathJax, KaTeX and web fonts are loaded from other servers when a page runs and are not redistributed. The page also lists what could not be determined, for example the licence of Maxima files without a notice and whether the WebAssembly build of gnuplot is modified. The binaries are not rebuilt by this project; a CTM-built release with a full build recipe and sources is planned (`reports/2026-10-22-system-design-audit.md`, section 6).

The selected answer-test fixture data and reused oracle originate in Erasmus-CTM/ctm-checkers at 9e042dc5e57a1636be64ca5d08910c9af5ff1371. Its fixture inventory is transcribed from maths/moodle-qtype_stack at 10d323311b7f39fb7b092dd10ce75f7d8632f525, tests/fixtures/answertestfixtures.class.php, copyright 2012 University of Birmingham and STACK's contributors, GPL-3.0-or-later. Recorded report data retains source revision, fixture IDs and source lines. The source license is available at https://github.com/Erasmus-CTM/ctm-checkers/blob/9e042dc5e57a1636be64ca5d08910c9af5ff1371/tests/stack/native_compliance/COPYING.txt.

The experiment loads unmodified STACK Maxima libraries at 10d323311b7f39fb7b092dd10ce75f7d8632f525 and 33383047af39c204bf4442802a058f8b918b2b1b. Existing file headers and licences are preserved in the fetched checkouts.

Maxima-on-Wasm is the ECL/Emscripten implementation by Marius Gerbershagen at https://maxima-on-wasm.pages.dev/ and https://gitlab.com/mgerbershagen/maxima. The committed measurement identifies the actual files by SHA-256. Experiment evidence identifies additional share-library files loaded at runtime.

New adapter and measurement code is AGPL-3.0-or-later. This notice does not replace upstream licences.
