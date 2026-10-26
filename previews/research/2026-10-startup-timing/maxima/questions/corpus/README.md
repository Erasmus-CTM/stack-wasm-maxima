# Native STACK question corpus

These 35 original Moodle STACK XML exports come from the [STACK sample question library](https://github.com/maths/moodle-qtype_stack/tree/10d323311b7f39fb7b092dd10ce75f7d8632f525/samplequestions/stacklibrary), pinned to commit `10d323311b7f39fb7b092dd10ce75f7d8632f525`. The files are byte-for-byte copies, including CASText, CDATA, authored response trees, deployed seeds, and native `<qtest>` cases. No answer, test, or XML wrapper has been rewritten for SymPy.

The selection covers 24 Algebra Refresher questions from all 15 numbered chapters, five questions from other mathematical Topics, and one numerical-input Features example. Five matrix-input exports were added: four elementary-matrix problems and one systems-to-matrix-equation problem. Together the 35 exports contain 82 authored qtests and 313 `<deployedseed>` entries. The [manifest](manifest.json) gives each local filename, unique local ID, exact upstream path and URL, SHA-256 checksum, original question name, topic, input count, answer-test names, qtest count, and deployed seeds. The XML itself is the authority for authored behavior.

Authorship and license: credit the STACK question authors and the original authors or contributors named inside each export where applicable. These sample questions are distributed under [Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/); the applicable [upstream license text](COPYING.txt) is reproduced here. The per-question links in the manifest identify the source and version. We have not modified the questions. This corpus excludes the upstream HELM subtree, which has a different license.

The corpus is a compatibility target, not a claim that all questions work in this limited adapter. Some exports exercise Maxima, input types, CASText, and answer tests outside the current supported subset; authored qtests remain upstream expectations until independently run and checked. Use the recorded [compatibility baseline](baseline.json) to distinguish imports, successful qtest runs, mismatches, and explicit unsupported diagnostics. From the repository root, run `PYTHONPATH=src python tools/stack_native/check_corpus.py --check` to compare a fresh replay, or omit `--check` to refresh the baseline after an adapter change; then run stack-sympy's `python scripts/generate_corpus_page.py` to update its gallery. Each original XML runs in an isolated, time-limited worker. The replay uses the first three deployed seeds where present, otherwise local seeds 17, 29, and 47. A question with a disagreement on any replayed seed stays out of the interactive gallery, even if another seed passes. Passing these cases does not establish Moodle/Maxima parity: the adapter's seeded choices need not match Maxima's choices for the same number. For a single XML file, run `PYTHONPATH=src python -m ctm_checkers.stack.cli test --file examples/stack/corpus/AlgMap-1-6.xml`.

Passing authored qtests also does not certify the original grading design. In `AlgMap-2.5`, the response tree awards credit for `LowestTerms` before checking value equivalence; a reduced answer with the wrong value can receive full credit. The [gallery](../../corpus.qmd) flags that card. We leave the original XML and authored expectations unchanged.

`AlgMap-8.10` has a reproduced upstream PRT authoring bug: the variant with
`a=8`, `b=9`, `c=2`, `d=3` has correct answer `7*(t+y)`, which its only
full-credit branch rejects under `SingleFrac`. The pinned native STACK test
rejects that same written form. The original XML and authored test expectations
remain unchanged; the gallery names the authoring cause explicitly.

`AlgMap-15.1` uses `{ta1,ta2}` as a set-valued answer and `elementp(?,ans)`
in its response tree. Its opening `{` is valid ASCII Maxima syntax, rather than
an encoding defect. The set-valued answer is supported, but the `?` placeholder in this custom
Maxima membership expression is outside the parser grammar. The question remains
blocked for that explicit syntax reason; no XML sanitization is applied.
