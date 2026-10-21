# Third-party notices

The executable runtime and STACK source files are fetched into ignored working directories during the experiment; no upstream runtime binaries are committed.

The selected answer-test fixture data and reused oracle originate in Erasmus-CTM/ctm-checkers at 9e042dc5e57a1636be64ca5d08910c9af5ff1371. Its fixture inventory is transcribed from maths/moodle-qtype_stack at 10d323311b7f39fb7b092dd10ce75f7d8632f525, tests/fixtures/answertestfixtures.class.php, copyright 2012 University of Birmingham and STACK's contributors, GPL-3.0-or-later. Recorded report data retains source revision, fixture IDs and source lines. The source license is available at https://github.com/Erasmus-CTM/ctm-checkers/blob/9e042dc5e57a1636be64ca5d08910c9af5ff1371/tests/stack/native_compliance/COPYING.txt.

The experiment loads unmodified STACK Maxima libraries at 10d323311b7f39fb7b092dd10ce75f7d8632f525 and 33383047af39c204bf4442802a058f8b918b2b1b. Existing file headers and licences are preserved in the fetched checkouts.

Maxima-on-Wasm is the ECL/Emscripten implementation by Marius Gerbershagen at https://maxima-on-wasm.pages.dev/ and https://gitlab.com/mgerbershagen/maxima. The committed measurement identifies the actual files by SHA-256. Experiment evidence identifies additional share-library files loaded at runtime.

New adapter and measurement code is AGPL-3.0-or-later. This notice does not replace upstream licences.
