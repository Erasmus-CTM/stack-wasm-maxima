#!/usr/bin/env python3
"""Package hash-pinned runtime assets and unmodified STACK for the CTM demo."""
from __future__ import annotations
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import importlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
STACK_SHA = "33383047af39c204bf4442802a058f8b918b2b1b"
CHECKERS_SHA = "c366f175aba6b62caa628bc60f57bb1167fc087b"
BASE = "https://maxima-on-wasm.pages.dev/"

def checked_checkout(path: Path, expected: str) -> Path:
    path = path.resolve()
    actual = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    if actual != expected:
        raise ValueError(f"Expected {expected} at {path}, got {actual}")
    return path

def owned_runtime_source(path: Path | None, wanted: set[str], baseline_comparator=False, compiler_profile_name=None):
    if path is None:
        return None
    path = path.resolve()
    encoded = (path / "manifest.json").read_bytes()
    manifest = json.loads(encoded)
    pins = json.loads((ROOT / "runtime/build/pins.json").read_text())
    if baseline_comparator:
        baseline = json.loads((ROOT / 'runtime/build/baseline.json').read_text())
        if hashlib.sha256(encoded).hexdigest() != baseline['manifestSha256'] or manifest.get('sourcePins') != baseline['sourcePins']:
            raise ValueError('Comparator must be the exact frozen historical owned baseline')
        pins = baseline['sourcePins']
    if manifest.get("schema") != 1 or manifest.get("sourcePins") != pins:
        raise ValueError("Owned runtime manifest does not identify the exact expected source pins")
    records = manifest.get("runtimeAssets")
    profile = manifest.get('configuration')
    if not baseline_comparator:
        sys.path.insert(0, str(ROOT / 'runtime/build'))
        from compiler_profile import compiler_profile
        selected_compiler = compiler_profile(compiler_profile_name)
        if manifest.get('compilerProfile') != selected_compiler:
            raise ValueError('Current candidate requires the selected exact compiler profile')
        expected = json.loads((ROOT / 'runtime/build/configuration.json').read_text())
        if profile != expected:
            raise ValueError('Unknown or changed runtime build configuration')
        shim = (ROOT / 'runtime/build/no-plot.mac').read_bytes()
        if hashlib.sha256(shim).hexdigest() != expected['startupSha256']:
            raise ValueError('Current startup adapter hash differs')
        if manifest.get('startupAdapter') != {'content':shim.decode().strip()+'\n','sha256':expected['startupSha256']}:
            raise ValueError('Current startup adapter differs from the exact configuration')
        wanted = wanted - {BASE + p for p in profile['omittedRuntimePaths']}
    if not isinstance(records, list) or len(records) != len(wanted):
        raise ValueError("Owned runtime asset inventory is incomplete")
    selected = {}
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("Invalid owned runtime asset record")
        relative = record.get("path")
        if (not isinstance(relative, str) or relative in selected or BASE + relative not in wanted
                or type(record.get("bytes")) is not int or record["bytes"] < 0
                or not isinstance(record.get("sha256"), str)
                or len(record["sha256"]) != 64
                or any(c not in "0123456789abcdef" for c in record["sha256"])):
            raise ValueError("Invalid owned runtime asset record")
        selected[relative] = record
    if {BASE + relative for relative in selected} != wanted:
        raise ValueError("Owned runtime asset paths differ from the required inventory")
    return {"root": path / "runtime", "records": selected,
            "provenance": {"kind": "ctm-owned-build", "manifestSha256": hashlib.sha256(encoded).hexdigest(),
                           "sourcePins": pins, **({"compilerProfile":manifest["compilerProfile"]} if not baseline_comparator else {})}, 'configuration': profile,
            'startup': manifest.get('startupAdapter', {}).get('content', '')}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stack-source", type=Path, required=True)
    parser.add_argument("--ctm-checkers-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / ".cache/milestone-two/demo")
    parser.add_argument("--asset-cache", type=Path, default=ROOT / ".cache/maxima-runtime")
    parser.add_argument("--runtime-source", type=Path, default=os.environ.get("CTM_MAXIMA_RUNTIME_SOURCE"),
                        help="Opt-in owned-build artifact directory; default remains the deployed runtime")
    parser.add_argument("--verified-baseline-comparator", action="store_true", help="Comparator only: exact frozen historical artifact; never permits another pin set")
    parser.add_argument("--compiler-profile", help="Explicit current compiler profile when staging an accepted comparison artifact")
    args = parser.parse_args()
    stack = checked_checkout(args.stack_source, STACK_SHA)
    checkers = checked_checkout(args.ctm_checkers_source, CHECKERS_SHA)
    sys.path.insert(0, str(checkers / "tools/stack_native"))
    oracle = importlib.import_module("native_compliance.maxima_runner")
    inventory = json.loads((ROOT / "measurements/2026-10-21-runtime-assets.json").read_text())
    linked = json.loads((ROOT / "measurements/2026-10-21-runtime-dependencies.json").read_text())
    demo_linked = json.loads((ROOT / "measurements/2026-10-22-demo-runtime-dependencies.json").read_text())
    observed = json.loads((ROOT / "reports/milestone-one/browser-3338304.json").read_text())
    wanted = set(inventory["groups"]["maximaCore"] + inventory["groups"]["maximaOptionalModules"])
    wanted.update(a["url"] for a in linked["assets"])
    wanted.update(a["url"] for a in demo_linked["assets"])
    wanted.update(a["url"] for a in observed["servedAssets"])
    records = {}
    for asset in inventory["assets"] + linked["assets"] + demo_linked["assets"] + observed["servedAssets"]:
        if asset["url"] not in wanted:
            continue
        old = records.get(asset["url"])
        if old and old["sha256"] != asset["sha256"]:
            raise ValueError("Inconsistent observed runtime asset hash")
        records[asset["url"]] = asset
    if set(records) != wanted:
        raise ValueError("Missing hashes for selected runtime assets")
    owned = owned_runtime_source(args.runtime_source, wanted, args.verified_baseline_comparator, args.compiler_profile)
    if owned and owned['configuration']:
        wanted -= {BASE + p for p in owned['configuration']['omittedRuntimePaths']}
    args.output.mkdir(parents=True, exist_ok=True)
    runtime = args.output / "maxima-runtime"
    runtime.mkdir(exist_ok=True)
    if owned and owned['configuration']:
        for omitted in owned['configuration']['omittedRuntimePaths']:
            if (runtime / omitted).exists() or (owned['root'] / omitted).exists():
                raise ValueError('Trimmed runtime contains a stale omitted file: ' + omitted)

    def copy_asset(url: str) -> dict:
        if not url.startswith(BASE) or urlsplit(url).netloc != urlsplit(BASE).netloc:
            raise ValueError("Unexpected runtime source origin")
        relative = url[len(BASE):]
        if any(part in ("", ".", "..") for part in relative.split("/")) or "\\" in relative:
            raise ValueError("Unsafe runtime asset path")
        expected = records[url]
        cache = args.asset_cache / relative
        if owned:
            candidate = owned["records"][relative]
            expected = {"fileBytes": candidate["bytes"], "sha256": candidate["sha256"]}
            body = (owned["root"] / relative).read_bytes()
            if len(body) != expected["fileBytes"]:
                raise ValueError("Owned runtime byte count mismatch: " + relative)
        elif cache.is_file():
            body = cache.read_bytes()
        else:
            # Use the same Node fetch client as the accepted milestone-one
            # run. The asset host rejects urllib's default client signature.
            # The downloader bounds the response; hashes still decide whether
            # any downloaded byte is admitted into the runtime package.
            body = subprocess.check_output(
                ["node", str(ROOT / "scripts/milestone-two/fetch-runtime.mjs"), url],
                timeout=60,
            )
            if len(body) > 64 * 1024 * 1024:
                raise ValueError("Runtime asset exceeds size limit")
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(body)
        if hashlib.sha256(body).hexdigest() != expected["sha256"]:
            raise ValueError("Pinned runtime hash mismatch: " + url)
        target = runtime / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        result = {"path": relative, "sourceURL": None if owned else url,
                  "fileBytes": len(body), "sha256": expected["sha256"]}
        if owned:
            result["deployedComparisonURL"] = url
        return result

    with ThreadPoolExecutor(max_workers=6) as pool:
        assets = list(pool.map(copy_asset, sorted(wanted)))
    # Emscripten's lazy files otherwise issue synchronous HEAD/range requests
    # one at a time. Keep the original files and bytes, but mount the observed
    # startup modules and packaged share files from one ordinary async fetch.
    startup_modules = {a["url"][len(BASE):] for a in observed["servedAssets"]
                       if a["url"].endswith(".fas")}
    preload_paths = sorted(a["path"] for a in assets
                           if a["path"].startswith("share/") or a["path"] in startup_modules)
    preload_body = (json.dumps({"schema": 1, "files": [
        {"path": path, "content": base64.b64encode((runtime / path).read_bytes()).decode("ascii")}
        for path in preload_paths]}, separators=(",", ":")) + "\n").encode("utf-8")
    (runtime / "runtime-preload.json").write_bytes(preload_body)
    preload = {"path": "runtime-preload.json", "sha256": hashlib.sha256(preload_body).hexdigest(),
               "fileBytes": len(preload_body), "paths": preload_paths}
    index = (runtime / "share_files.js").read_bytes()
    if not owned and hashlib.sha256(index).hexdigest() != demo_linked["shareIndexSha256"]:
        raise ValueError("Demo dependencies name another runtime share index")
    import re
    declared = {BASE + match[3] for match in re.finditer(
        r"FS\.createLazyFile\('([^']*)',\s*'([^']*)',\s*'([^']*)'", index.decode("utf-8"))}
    if not {asset["url"] for asset in demo_linked["assets"]} <= declared:
        raise ValueError("Demo dependencies must be declared by the pinned runtime")
    files = []
    for path in sorted((stack / "stack/maxima").rglob("*")):
        if path.is_file() and path.suffix in (".mac", ".lisp"):
            data = path.read_bytes()
            files.append({"path": path.relative_to(stack).as_posix(), "bytes": len(data),
                          "sha256": hashlib.sha256(data).hexdigest(), "content": data.decode("utf-8")})
    version = re.search(r"stackmaximaversion:(\d+)", (stack / "stack/maxima/stackmaxima.mac").read_text())[1]
    startup = "\n".join([
        'm2_emit(s):=printf(true,"~%~a~%",s)$',
        "display2d:false$",
        'maxima_userdir:"/ctm"$',
        'load("/ctm/moodle-qtype_stack-master/stack/maxima/stacklocallinux.mac")$',
        "display2d:false$", "linel:1000000$",
        'm2_emit(sconcat("CTMMAXIMA-READY|",stackmaximaversion,"|",MAXIMA_VERSION_STR))$',
        "",
    ])
    if owned:
        sys.path.insert(0, str(ROOT / 'runtime/build'))
        from configuration import startup as profile_startup
        expected_startup = profile_startup(owned['configuration']) if owned['configuration'] else ''
        if expected_startup != owned['startup']:
            raise ValueError('Owned runtime startup differs from its pinned profile')
        startup = expected_startup + startup
    manifest = {"schema": 1, "stackRevision": STACK_SHA, "stackLibraryVersion": version,
                "ctmCheckersRevision": CHECKERS_SHA, "nativeInputPreparation": oracle.INPUT_PREPARATION,
                "tests": oracle.TESTS, "startup": startup, "files": files, "runtimeAssets": assets,
                "preload": preload,
                "scope": "Maxima answer tests with shared CTM validation/PRT/PythonChecker"}
    if owned:
        manifest["runtimeBuild"] = owned["provenance"]
    (args.output / "stack-sources.json").write_text(json.dumps(manifest, ensure_ascii=False) + "\n", encoding="utf-8")
    for name in ("backend", "runtime", "native", "jsxgraph"):
        source = ROOT / "prototype" / name
        if source.is_dir():
            shutil.copytree(source, args.output / name, dirs_exist_ok=True)
    # Optional same-origin hosting uses these exact decoded files. Compression
    # is a server policy and is recorded separately by the browser benchmark.
    record = {"schema": 1, "runtimeAssetCount": len(assets),
              "runtimeFileBytes": sum(a["fileBytes"] for a in assets),
              "stackFileCount": len(files), "stackSourceBytes": sum(f["bytes"] for f in files),
              "stackRevision": STACK_SHA, "ctmCheckersRevision": CHECKERS_SHA, "assets": assets}
    if owned:
        record["runtimeBuild"] = owned["provenance"]
    (args.output / "runtime-assets.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({k: v for k, v in record.items() if k != "assets"}))

if __name__ == "__main__":
    main()
