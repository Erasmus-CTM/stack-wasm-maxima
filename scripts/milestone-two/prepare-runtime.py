#!/usr/bin/env python3
"""Package hash-pinned runtime assets and unmodified STACK for the CTM demo."""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import importlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlsplit
from urllib.request import urlopen

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

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stack-source", type=Path, required=True)
    parser.add_argument("--ctm-checkers-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / ".cache/milestone-two/demo")
    parser.add_argument("--asset-cache", type=Path, default=ROOT / ".cache/maxima-runtime")
    args = parser.parse_args()
    stack = checked_checkout(args.stack_source, STACK_SHA)
    checkers = checked_checkout(args.ctm_checkers_source, CHECKERS_SHA)
    sys.path.insert(0, str(checkers / "tools/stack_native"))
    oracle = importlib.import_module("native_compliance.maxima_runner")
    inventory = json.loads((ROOT / "measurements/2026-10-21-runtime-assets.json").read_text())
    linked = json.loads((ROOT / "measurements/2026-10-21-runtime-dependencies.json").read_text())
    observed = json.loads((ROOT / "reports/milestone-one/browser-3338304.json").read_text())
    wanted = set(inventory["groups"]["maximaCore"] + inventory["groups"]["maximaOptionalModules"])
    wanted.update(a["url"] for a in linked["assets"])
    wanted.update(a["url"] for a in observed["servedAssets"])
    records = {}
    for asset in inventory["assets"] + linked["assets"] + observed["servedAssets"]:
        if asset["url"] not in wanted:
            continue
        old = records.get(asset["url"])
        if old and old["sha256"] != asset["sha256"]:
            raise ValueError("Inconsistent observed runtime asset hash")
        records[asset["url"]] = asset
    if set(records) != wanted:
        raise ValueError("Missing hashes for selected runtime assets")
    args.output.mkdir(parents=True, exist_ok=True)
    runtime = args.output / "maxima-runtime"
    runtime.mkdir(exist_ok=True)

    def copy_asset(url: str) -> dict:
        if not url.startswith(BASE) or urlsplit(url).netloc != urlsplit(BASE).netloc:
            raise ValueError("Unexpected runtime source origin")
        relative = url[len(BASE):]
        if any(part in ("", ".", "..") for part in relative.split("/")) or "\\" in relative:
            raise ValueError("Unsafe runtime asset path")
        expected = records[url]
        cache = args.asset_cache / relative
        if cache.is_file():
            body = cache.read_bytes()
        else:
            with urlopen(url, timeout=45) as response:
                body = response.read(64 * 1024 * 1024 + 1)
            if len(body) > 64 * 1024 * 1024:
                raise ValueError("Runtime asset exceeds size limit")
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(body)
        if hashlib.sha256(body).hexdigest() != expected["sha256"]:
            raise ValueError("Pinned runtime hash mismatch: " + url)
        target = runtime / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        return {"path": relative, "sourceURL": url, "fileBytes": len(body), "sha256": expected["sha256"]}

    with ThreadPoolExecutor(max_workers=6) as pool:
        assets = list(pool.map(copy_asset, sorted(wanted)))
    files = []
    for path in sorted((stack / "stack/maxima").rglob("*")):
        if path.is_file() and path.suffix in (".mac", ".lisp"):
            data = path.read_bytes()
            files.append({"path": path.relative_to(stack).as_posix(), "bytes": len(data),
                          "sha256": hashlib.sha256(data).hexdigest(), "content": data.decode("utf-8")})
    import re
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
    manifest = {"schema": 1, "stackRevision": STACK_SHA, "stackLibraryVersion": version,
                "ctmCheckersRevision": CHECKERS_SHA, "nativeInputPreparation": oracle.INPUT_PREPARATION,
                "tests": oracle.TESTS, "startup": startup, "files": files, "runtimeAssets": assets,
                "scope": "Maxima answer tests with shared CTM validation/PRT/PythonChecker"}
    (args.output / "stack-sources.json").write_text(json.dumps(manifest, ensure_ascii=False) + "\n", encoding="utf-8")
    for name in ("backend", "runtime"):
        source = ROOT / "prototype" / name
        if source.is_dir():
            shutil.copytree(source, args.output / name, dirs_exist_ok=True)
    # Optional same-origin hosting uses these exact decoded files. Compression
    # is a server policy and is recorded separately by the browser benchmark.
    record = {"schema": 1, "runtimeAssetCount": len(assets),
              "runtimeFileBytes": sum(a["fileBytes"] for a in assets),
              "stackFileCount": len(files), "stackSourceBytes": sum(f["bytes"] for f in files),
              "stackRevision": STACK_SHA, "ctmCheckersRevision": CHECKERS_SHA, "assets": assets}
    (args.output / "runtime-assets.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({k: v for k, v in record.items() if k != "assets"}))

if __name__ == "__main__":
    main()
