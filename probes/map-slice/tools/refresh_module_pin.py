#!/usr/bin/env python3
"""Refresh only the recorded E1 module/build identity of a slice package.

The geometry, collision, draw, layout and per-tick state hashes are not
rewritten. The current ``_work/e1-drive/module`` files are replayed on the
package physics at the recorded spawn; the refresh is refused if the per-tick
state hashes or sequence hash differ from the committed physics-settle record.

Usage:
    python probes/map-slice/tools/refresh_module_pin.py --package _work/map-slice/amboy
    python probes/map-slice/tools/refresh_module_pin.py --level spa_barcelona_gracia
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-slice/tools"))
from map_slice_common import package_dir, short_name, texture_dir  # noqa: E402


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, doc) -> None:
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False,
                               allow_nan=False) + "\n", encoding="utf-8")


def file_record(path: Path) -> dict:
    data = path.read_bytes()
    return {"path": path.resolve().relative_to(ROOT).as_posix(),
            "bytes": len(data), "sha256": sha256_bytes(data)}


def state_mismatch(old: dict, new: dict):
    old_ticks, new_ticks = old.get("ticks") or [], new.get("ticks") or []
    if len(old_ticks) != len(new_ticks):
        return "tick count: package %d replayed %d" % (
            len(old_ticks), len(new_ticks))
    for index, (left, right) in enumerate(zip(old_ticks, new_ticks)):
        if left["stateHash"] != right["stateHash"]:
            return "tick %d: package %s replayed %s" % (
                index, left["stateHash"], right["stateHash"])
    old_sequence = (old.get("summary") or {}).get("stateSequenceHash")
    new_sequence = (new.get("summary") or {}).get("stateSequenceHash")
    if old_sequence != new_sequence:
        return "sequence: package %s replayed %s" % (
            old_sequence, new_sequence)
    return None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--level", default=None)
    parser.add_argument("--package", type=Path, default=None)
    args = parser.parse_args(argv)

    if args.package is not None:
        package = args.package.resolve()
    elif args.level:
        package = package_dir(args.level)
    else:
        parser.error("pass --level or --package")

    slice_path = package / "slice.json"
    if not slice_path.is_file():
        raise SystemExit("BLOCKED: missing " + str(slice_path))
    slice_doc = load_json(slice_path)
    level = slice_doc["level"]
    old_slice_sha = sha256_file(slice_path)
    settle_path = package / "physics-settle.json"
    old_settle = load_json(settle_path)

    module_path = ROOT / slice_doc["source"]["e1Module"]["path"]
    build_path = ROOT / slice_doc["source"]["e1Build"]["path"]
    if not module_path.is_file() or not build_path.is_file():
        raise SystemExit("BLOCKED: current e1 module/build missing")

    old_module = dict(slice_doc["source"]["e1Module"])
    old_build = dict(slice_doc["source"]["e1Build"])

    temp_path = (ROOT / "_work/logs/map-slice/refresh" /
                 (short_name(level) + "-physics-settle.json"))
    temp_path.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.run(
        ["node", str(ROOT / "probes/map-slice/tools/physics_settle.mjs"),
         "--package", str(package), "--out", str(temp_path)],
        cwd=ROOT, text=True, capture_output=True, timeout=900)
    if process.returncode != 0:
        raise SystemExit("FAILED: replay failed\n" + process.stdout + process.stderr)
    new_settle = load_json(temp_path)

    mismatch = state_mismatch(old_settle, new_settle)
    if mismatch is not None:
        raise SystemExit("FAILED: physics behaviour changed; refusing refresh: " +
                         mismatch)

    # Behaviour is identical. Replace only the settle record's module identity
    # (the replay document already carries current identity) and copy it in.
    settle_bytes = temp_path.read_bytes()
    settle_path.write_bytes(settle_bytes)

    slice_doc["source"]["e1Module"] = file_record(module_path)
    slice_doc["source"]["e1Build"] = file_record(build_path)
    slice_doc["physicsProof"] = {
        "status": "settled",
        "file": "physics-settle.json",
        "sha256": sha256_bytes(settle_bytes),
        "summary": new_settle["summary"],
        "determinism": new_settle["determinism"],
        "moduleWasmSha256": new_settle["module"]["wasmSha256"],
        "spawn": new_settle["inputs"]["spawn"],
        "car": new_settle["create"].get("info", {}).get("car"),
    }
    slice_doc["hashes"]["files"]["physics-settle.json"] = {
        "bytes": len(settle_bytes),
        "sha256": sha256_bytes(settle_bytes),
    }
    body = {key: value for key, value in slice_doc.items() if key != "hashes"}
    slice_doc["hashes"]["contentSha256"] = sha256_bytes(canonical(body))
    write_json(slice_path, slice_doc)
    new_slice_sha = sha256_file(slice_path)

    # The binding/blocker manifests pin the slice file hash as an input. Their
    # per-draw/material rows do not depend on the module identity, so update
    # only that input pin. The texture verifier re-runs the binder and compares
    # the result byte-for-byte, which proves the rest of the file is unchanged.
    texture_package = texture_dir(level)
    pin_updates = {}
    for name in ("bindings.json", "blockers.json", "summary.json"):
        path = texture_package / name
        if not path.is_file():
            continue
        doc = load_json(path)
        if "inputs" not in doc or "slice" not in doc["inputs"]:
            continue
        doc["inputs"]["slice"]["sha256"] = new_slice_sha
        write_json(path, doc)
        pin_updates[name] = {"bytes": path.stat().st_size,
                             "sha256": sha256_file(path)}

    print(json.dumps({
        "level": level,
        "package": package.resolve().relative_to(ROOT).as_posix(),
        "behavior": "identical",
        "stateSequenceHash": new_settle["summary"]["stateSequenceHash"],
        "oldModule": {"bytes": old_module["bytes"], "sha256": old_module["sha256"]},
        "newModule": file_record(module_path),
        "oldBuild": {"bytes": old_build["bytes"], "sha256": old_build["sha256"]},
        "newBuild": file_record(build_path),
        "wasmSha256": new_settle["module"]["wasmSha256"],
        "slice": {"oldSha256": old_slice_sha,
                  "bytes": slice_path.stat().st_size,
                  "sha256": new_slice_sha,
                  "contentSha256": slice_doc["hashes"]["contentSha256"]},
        "physicsSettle": {"bytes": len(settle_bytes),
                          "sha256": sha256_bytes(settle_bytes)},
        "manifestPinUpdates": pin_updates,
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
