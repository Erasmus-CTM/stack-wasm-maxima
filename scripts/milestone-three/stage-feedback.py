#!/usr/bin/env python3
"""Extract a bounded English native-feedback catalogue from pinned STACK.

PHP is never executed. Only selected single-quoted literal language entries
are accepted, and the complete upstream source blob is hash checked first.
This is intentionally not the full Moodle feedback/CAS-text interpreter.
"""
# SPDX-License-Identifier: AGPL-3.0-or-later
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

STACK_REVISION = "33383047af39c204bf4442802a058f8b918b2b1b"
LANGUAGE_PATH = "lang/en/qtype_stack.php"
LANGUAGE_SHA256 = "efbc42e93a186343bba31e00b1abebbb5c58f86c0b74221bcee555d8847c2713"
# Exact keys used by the supported scalar, numerical and collection tests.
# Unsupported keys remain visible as escaped raw protocol in the browser.
KEYS = """
ATAlgEquiv_SA_not_expression ATAlgEquiv_SA_not_matrix
ATAlgEquiv_SA_not_list ATAlgEquiv_SA_not_list_semi
ATAlgEquiv_SA_not_set ATAlgEquiv_SA_not_set_semi
ATAlgEquiv_SA_not_realset ATAlgEquiv_SA_not_equation ATAlgEquiv_SA_not_logic
ATAlgEquiv_TA_not_equation ATAlgEquiv_SA_not_inequality
ATAlgEquiv_SA_not_function ATAlgEquiv_SA_not_string Subst
ATSubstEquiv_Opt_List ATEqualComAssRules_Opt_List ATEqualComAssRules_Opt_Incompatible
ATSets_SA_not_set ATSets_SA_not_set_semi ATSets_SB_not_set
ATSets_wrongentries ATSets_missingentries ATSets_duplicates
ATInequality_nonstrict ATInequality_strict ATInequality_backwards
ATLowestTerms_wrong ATLowestTerms_entries ATLowestTerms_not_rat
ATList_wronglen ATList_wrongentries ATMatrix_wrongsz ATMatrix_wrongentries
ATSet_wrongsz ATSet_wrongentries
irred_Q_commonint irred_Q_optional_fac FacForm_UnPick_morework
ATFacForm_error_list ATFacForm_isfactored ATFacForm_notfactored
ATFacForm_notpoly ATFacForm_notalgequiv
ATSingleFrac_error_list ATSingleFrac_true ATSingleFrac_part ATSingleFrac_var
ATSingleFrac_ret_exp ATSingleFrac_div
ATNumerical_SA_not_list ATNumerical_SA_not_list_semi
ATNumerical_SA_not_set ATNumerical_SA_not_set_semi
ATNumerical_SA_not_number ATNumerical_SB_not_number ATNumerical_FAILED
ATNumerical_STACKERROR_tol ATNum_OutofRange
ATNumDecPlaces_OptNotInt ATNumDecPlaces_NoDP ATNumDecPlaces_Wrong_DPs
ATNumDecPlaces_Float ATNumDecPlacesWrong_OptNotInt
""".split()


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def literals(source: str) -> dict[str, str]:
    """Read PHP single-quoted literals with PHP's two escape rules only."""
    entries: dict[str, str] = {}
    pattern = r"^\$string\['([A-Za-z0-9_]+)'\]\s*=\s*'((?:[^'\\]|\\.)*)'\s*;"
    for match in re.finditer(pattern, source, re.MULTILINE):
        key, encoded = match.groups()
        if key not in KEYS:
            continue
        if key in entries:
            raise ValueError("Duplicate STACK language key: " + key)
        entries[key] = re.sub(r"\\([\\'])", lambda item: item[1], encoded)
    return entries


def stage(source: Path, output: Path) -> dict:
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if revision != STACK_REVISION:
        raise ValueError(f"Expected STACK {STACK_REVISION}, got {revision}")
    original = subprocess.check_output(["git", "-C", str(source), "show", f"{STACK_REVISION}:{LANGUAGE_PATH}"])
    if digest(original) != LANGUAGE_SHA256:
        raise ValueError("Pinned STACK language source hash mismatch")
    entries = literals(original.decode("utf-8"))
    messages = {}
    for key in sorted(KEYS):
        if key not in entries:
            raise ValueError("Missing or nonliteral STACK feedback message: " + key)
        message = entries[key]
        residual = re.sub(r"\{\$a->m[0-7]\}", "", message)
        if "{$" in residual:
            raise ValueError("Unsupported STACK feedback placeholder: " + key)
        # Restrict the tiny static HTML subset as well as the dynamic values.
        if re.search(r"<[^>]*>", re.sub(r"</?(?:tt|code|em|strong)>", "", message)):
            raise ValueError("Unsupported static STACK feedback markup: " + key)
        messages[key] = message
    records = [{"repository": "maths/moodle-qtype_stack", "revision": revision,
                "path": LANGUAGE_PATH, "sha256": digest(original), "bytes": len(original)}]
    catalogue = {"schema": 1, "stackRevision": revision, "language": "en",
                 "license": "GPL-3.0-or-later", "sourceFiles": records, "messages": messages}
    encoded = (json.dumps(catalogue, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    output.mkdir(parents=True, exist_ok=True)
    (output / "feedback-messages.json").write_bytes(encoded)
    provenance = {"schema": 1, "stackRevision": revision, "sourceFiles": records,
                  "catalogue": {"path": "feedback-messages.json", "sha256": digest(encoded),
                                "bytes": len(encoded), "keys": sorted(messages)},
                  "transformation": "Extract exact selected PHP single-quoted English literals; decode only PHP single-quote/backslash escapes",
                  "scope": "Bounded STACK answer-test feedback translation; unknown protocol stays visible as escaped raw text, not full Moodle feedback parity"}
    (output / "feedback-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="Native asset directory")
    args = parser.parse_args()
    print(json.dumps(stage(args.stack_source.resolve(), args.output.resolve())))


if __name__ == "__main__":
    main()
