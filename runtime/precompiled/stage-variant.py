#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Stage an explicit opt-in compiled STACK manifest beside the source control."""
import argparse
import copy
import hashlib
import json
import subprocess
from pathlib import Path
from parser_bootstrap import extract as parser_declarations, SOURCE as PARSER_SOURCE, PINNED_SOURCES
from bundle_provenance import describe as describe_bundle, PROCESS_ADAPTER, TRANSLATION_MODE

ENTRY = "stack/maxima/stackmaxima.mac"
LOADER = "stack/maxima/stacklocallinux.mac"
OLD = 'load("stackmaxima.mac")$'
NEW = 'load("/ctm/moodle-qtype_stack-master/stack/maxima/stackmaxima.fas")$'
ASSET = "stackmaxima.fas"
START_LOAD = 'load("/ctm/moodle-qtype_stack-master/stack/maxima/stacklocallinux.mac")$'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def exact_file(manifest, stack, path):
    matches = [row for row in manifest["files"] if row["path"] == path]
    if len(matches) != 1:
        raise ValueError("Expected one STACK file: " + path)
    row = matches[0]
    actual = (stack / path).read_bytes()
    if (row["content"].encode("utf-8") != actual or row["bytes"] != len(actual)
            or row["sha256"] != digest(actual)):
        raise ValueError("STACK manifest/source mismatch: " + path)
    return row, actual


def stage(site, stack, bundle, translated):
    if translated.parent.name != 'source-initialized' or translated.parent.parent.resolve() != bundle.parent.resolve():
        raise ValueError('Bundle and translated inputs must belong to the same build directory')
    pin = subprocess.check_output(["git", "-C", str(stack), "rev-parse", "HEAD"], text=True).strip()
    if pin not in PINNED_SOURCES:
        raise ValueError("STACK checkout differs from the exact compiled source pin")
    original_path = site / "stack-sources.json"
    original = json.loads(original_path.read_text(encoding="utf-8"))
    if original.get("schema") != 1 or original.get("stackRevision") != pin or "compiledStack" in original:
        raise ValueError("Expected the original source-loaded STACK manifest")
    if original["startup"].count(START_LOAD) != 1:
        raise ValueError("Expected one exact STACK startup command")
    _, source = exact_file(original, stack, ENTRY)
    loader, loader_source = exact_file(original, stack, LOADER)
    if loader["content"].count(OLD) != 1:
        raise ValueError("Pinned loader does not contain one exact STACK entry load")
    binary = bundle.read_bytes()
    lisp = translated.read_bytes()
    adapter = translated.parent / "display2d-bridge.lisp"
    adapter_bytes = adapter.read_bytes()
    reviewed_adapter = Path(__file__).with_name("display2d-bridge.lisp").read_bytes()
    if not adapter_bytes or adapter_bytes != reviewed_adapter:
        raise ValueError("Compiled assignment bridge differs from the reviewed source")
    process_adapter = bundle.parent / PROCESS_ADAPTER
    process_adapter_bytes = process_adapter.read_bytes()
    if (not process_adapter_bytes or
            process_adapter_bytes != Path(__file__).with_name(PROCESS_ADAPTER).read_bytes()):
        raise ValueError('Translation-process adapter differs from the reviewed source')
    parser_source = (stack / PARSER_SOURCE).read_bytes()
    expected_declarations, declaration_start = parser_declarations(parser_source, pin)
    parser_file = translated.parent / 'parser-declarations.mac'
    parser_metadata_file = translated.parent / 'parser-declarations.json'
    parser_bytes = parser_file.read_bytes()
    parser_metadata = json.loads(parser_metadata_file.read_text())
    if (parser_bytes != expected_declarations or parser_metadata.get('schema') != 1
            or parser_metadata.get('stackRevision') != pin
            or parser_metadata.get('source') != {'path': PARSER_SOURCE, 'bytes': len(parser_source),
                'sha256': digest(parser_source), 'start': declaration_start,
                'end': declaration_start + len(expected_declarations)}
            or parser_metadata.get('file') != {'path': parser_file.name, 'bytes': len(parser_bytes),
                'sha256': digest(parser_bytes)}):
        raise ValueError('Translation parser bootstrap differs from pinned declarations')
    if not binary or not lisp:
        raise ValueError("Compiled bundle and translation must be nonempty")
    descriptor_path = bundle.with_name('stackmaxima.fas.json')
    descriptor_bytes = descriptor_path.read_bytes()
    if json.loads(descriptor_bytes) != describe_bundle(
            pin, source, lisp, adapter_bytes, process_adapter_bytes,
            parser_bytes, parser_metadata_file.read_bytes(), binary):
        raise ValueError('Bundle provenance differs from its exact pin and translation inputs')
    target = site / "maxima-runtime" / ASSET
    if target.exists():
        raise ValueError("Refusing to replace an existing runtime file")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(binary)
    timed = copy.deepcopy(original)
    timed["startup"] = timed["startup"].replace(START_LOAD,
        'm2_emit("CTMSTACK-LOAD-BEGIN")$\n' + START_LOAD + '\nm2_emit("CTMSTACK-LOAD-END")$')
    timed_output = site / "stack-sources-timed-source.json"
    if timed_output.exists():
        raise ValueError("Refusing to replace an existing timed source manifest")
    timed_output.write_text(json.dumps(timed, ensure_ascii=False) + "\n", encoding="utf-8")
    variant = copy.deepcopy(timed)
    replacement = loader["content"].replace(OLD, NEW)
    changed = next(row for row in variant["files"] if row["path"] == LOADER)
    changed.update({"content": replacement, "bytes": len(replacement.encode("utf-8")),
                    "sha256": digest(replacement.encode("utf-8"))})
    variant["compiledStack"] = {
        "schema": 1, "mode": "entry-fas", "stackRevision": pin,
        "sourcePath": ENTRY, "sourceSha256": digest(source),
        "translatedLispSha256": digest(lisp),
        "bundleProvenanceSha256": digest(descriptor_bytes),
        "translationAdapter": {"mode": TRANSLATION_MODE, "path": adapter.name,
                               "fileBytes": len(adapter_bytes), "sha256": digest(adapter_bytes),
                               "processAdapter": {"path": process_adapter.name,
                                                  "fileBytes": len(process_adapter_bytes),
                                                  "sha256": digest(process_adapter_bytes)},
                               "parserBootstrap": parser_metadata,
                               "parserBootstrapMetadataSha256": digest(parser_metadata_file.read_bytes())},
        "originalLoaderSha256": digest(loader_source),
        "overlayLoaderSha256": changed["sha256"],
        "asset": {"path": ASSET, "fileBytes": len(binary), "sha256": digest(binary)},
    }
    output = site / "stack-sources-precompiled.json"
    if output.exists():
        raise ValueError("Refusing to replace an existing compiled manifest")
    output.write_text(json.dumps(variant, ensure_ascii=False) + "\n", encoding="utf-8")
    return variant["compiledStack"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", type=Path, required=True)
    parser.add_argument("--stack-source", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--translated", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(stage(args.site, args.stack_source, args.bundle, args.translated), indent=2))
