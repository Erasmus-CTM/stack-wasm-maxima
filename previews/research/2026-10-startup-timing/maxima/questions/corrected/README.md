# Corrected teaching copies

These four files are derivatives of the matching, unchanged exports in
`../corpus/`, pinned to STACK commit
`10d323311b7f39fb7b092dd10ce75f7d8632f525`. Original author attribution,
source URLs, and checksums are in the [corpus manifest](../corpus/manifest.json).
They retain the original authors' CC BY-SA 4.0 license; see
[the license text](../corpus/COPYING.txt). CTM made these teaching corrections
on 2026-10-16:

- `AlgMap-1-5.xml` and `AlgMap-6-4.xml`: replace the false exponent rule
  $c^a+c^b=c^{a+b}$ in the worked feedback with
  $c^a\cdot c^b=c^{a+b}$.
- `AlgMap-2-5.xml`: check algebraic equivalence before testing lowest terms.
  Wrong reduced fractions now earn zero credit. The test notes follow the
  corrected response tree, and an additional test rejects `123/127`.

The live gallery clearly identifies these derivatives. Its collapsed STACK
source panels and corrected-download links show the XML actually used by the
card. Original downloads and the compatibility replay baseline continue to
refer to the unmodified upstream exports.

On 2026-10-17 CTM added `7-3-26-(Write-sim-eqns-with-matrices).xml` as a presentation teaching copy: remove the unsupported `style="list-style-type:none;"` attribute from its `<ul>`, close the unclosed list, and label the question name as a derivative. No mathematical content, variables, answers, PRT scores or original qtests were changed. The unchanged original remains blocked in the corpus baseline. Its single original qtest passes for deployed seeds 1930245414, 812684119 and 1827462946 in this teaching copy. This copy retains the same CC BY-SA 4.0 license and the original attribution recorded in the corpus manifest.
