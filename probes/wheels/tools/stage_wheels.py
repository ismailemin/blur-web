"""Stage one uniform car-part manifest per decodable record, for wheel analysis.

Read-only over the game data and the committed builders; writes only under
`_work/wheels/`.

The wheel-corner analysis needs, for every car, the same artifact set produced
by the same builder version: MdlDat element local bounds + element matrices,
the first-RenderList LOD0 draws with index ranges, and the LOD0 mesh vertex
stream. This tool materialises that set once per record and records every input
hash so a repeated run is byte-identical.

Usage:
  python probes/wheels/tools/stage_wheels.py [--out-root _work/wheels]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PY = sys.executable
BUILDER = ROOT / "probes/car-parts/tools/build_manifest.py"
CARS = ROOT / "_work/vehicle-pipeline/cars.json"
CALIASES = ROOT / "_work/vehicle-pipeline/c-aliases.json"
OUT_DEFAULT = ROOT / "_work/wheels"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class BuilderRejected(RuntimeError):
    """The committed builder refused this model with a typed reason."""


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def load_inventory() -> list[dict]:
    cars = json.loads(CARS.read_text(encoding="utf-8"))
    aliases = {record["index"]: record
               for record in json.loads(CALIASES.read_text(encoding="utf-8"))["records"]}
    inventory = []
    for record in cars["records"]:
        entry = {
            "index": record["index"],
            "id": record["id"],
            "class": record["class"],
            "name": record["name"],
            "slug": record["slug"],
            "recordWheelBase": record.get("wheelBase"),
            "physics": record["physics"]["values"],
            "model": None,
            "wheelModel": None,
            "unavailable": None,
        }
        model = record.get("model") or {}
        decoded = model.get("decodedPath")
        pak_path = model.get("pakPath")
        model_sha = model.get("modelSha256")
        mapping = model.get("mapping")
        if decoded and (ROOT / decoded).is_file():
            entry["model"] = {
                "decoded": str(Path(decoded).as_posix()),
                "sha256": model_sha,
                "pakPath": pak_path,
                "mapping": mapping,
            }
        elif record["index"] in aliases:
            alias = aliases[record["index"]]
            intended = alias.get("intendedModel") or {}
            decoded = intended.get("decodedPath")
            wheel = (alias.get("wheelModel") or {})
            if decoded and (ROOT / decoded).is_file():
                entry["model"] = {
                    "decoded": str(Path(decoded).as_posix()),
                    "sha256": intended.get("sha256"),
                    "pakPath": intended.get("pakPath"),
                    "mapping": f"c-alias:{alias['identity']['kind']}",
                }
                if wheel.get("pakPath"):
                    entry["wheelModel"] = {
                        "pakPath": wheel.get("pakPath"),
                        "sha256": wheel.get("sha256"),
                    }
        if entry["model"] is None:
            entry["unavailable"] = (
                record.get("classReason") or
                "no decoded body model: the physics record has no AmaxVehicle body reference")
        inventory.append(entry)
    return inventory


def build_manifest(entry: dict, out_root: Path) -> dict:
    target = out_root / "manifests" / entry["slug"]
    model = ROOT / entry["model"]["decoded"]
    summary_path = target / "build.json"
    stamp = {
        "modelSha256": sha256_file(model),
        "builderSha256": sha256_file(BUILDER),
        "pakPath": entry["model"]["pakPath"],
    }
    if summary_path.is_file():
        previous = json.loads(summary_path.read_text(encoding="utf-8"))
        if previous.get("stamp") == stamp and (target / "manifest.json").is_file():
            return {"built": False, "stamp": stamp, "summary": previous["summary"]}
    command = [
        PY, str(BUILDER),
        "--model", str(model),
        "--out-dir", str(target),
        "--car-slug", entry["slug"],
        "--car-name", entry["name"],
    ]
    if entry["model"]["pakPath"]:
        command += ["--model-pak-path", entry["model"]["pakPath"]]
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    if completed.returncode != 0:
        message = (completed.stderr or completed.stdout).strip()
        raise BuilderRejected(f"builder exit {completed.returncode}: {message[-2000:]}")
    summary = json.loads(completed.stdout)
    target.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(
        json.dumps({"stamp": stamp, "summary": summary}, indent=1, sort_keys=True) + "\n",
        encoding="utf-8", newline="\n")
    return {"built": True, "stamp": stamp, "summary": summary}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-root", type=Path, default=OUT_DEFAULT)
    args = parser.parse_args()
    out_root = args.out_root.resolve()
    inventory = load_inventory()
    rows = []
    for entry in inventory:
        if entry["model"] is None:
            rows.append({**{key: entry[key] for key in ("index", "class", "name", "slug")},
                         "status": "unsupported",
                         "reason": entry["unavailable"]})
            print(f"{entry['index']:3d} {entry['class']} {entry['slug']:42s} UNSUPPORTED")
            continue
        try:
            result = build_manifest(entry, out_root)
        except BuilderRejected as error:
            rows.append({**{key: entry[key] for key in ("index", "class", "name", "slug")},
                         "status": "refused",
                         "model": entry["model"],
                         "reason": str(error)})
            print(f"{entry['index']:3d} {entry['class']} {entry['slug']:42s} REFUSED {error}")
            continue
        diagnostics = result["summary"]["diagnostics"]
        rows.append({
            "index": entry["index"],
            "class": entry["class"],
            "name": entry["name"],
            "slug": entry["slug"],
            "status": "staged",
            "built": result["built"],
            "model": entry["model"],
            "wheelModel": entry["wheelModel"],
            "modelSha256": result["stamp"]["modelSha256"],
            "builderSha256": result["stamp"]["builderSha256"],
            "manifest": str((out_root / "manifests" / entry["slug"] / "manifest.json")
                            .relative_to(ROOT).as_posix()),
            "manifestSha256": result["summary"]["manifestSha256"],
            "meshSha256": result["summary"]["meshSha256"],
            "draws": diagnostics["drawCount"],
            "wheelDraws": diagnostics["wheelDrawCount"],
            "wheelGroups": diagnostics["wheelGroupCount"],
            "tyreDrawCount": diagnostics["tyreDrawCount"],
            "rimDrawCount": diagnostics["rimDrawCount"],
            "brakeDiscDrawCount": diagnostics["brakeDiscDrawCount"],
            "brakeCaliperDrawCount": diagnostics["brakeCaliperDrawCount"],
            "tyreProofTier": diagnostics["tyreProofTier"],
            "builderProvenWheelDraws": diagnostics["provenWheelDrawCount"],
            "builderAmbiguousWheelDraws": diagnostics["ambiguousWheelDrawCount"],
            "physics": entry["physics"],
            "recordWheelBase": entry["recordWheelBase"],
        })
        print(f"{entry['index']:3d} {entry['class']} {entry['slug']:42s} "
              f"draws={diagnostics['drawCount']:3d} wheel={diagnostics['wheelDrawCount']:2d} "
              f"(t/r/d/c={diagnostics['tyreDrawCount']}/{diagnostics['rimDrawCount']}/"
              f"{diagnostics['brakeDiscDrawCount']}/{diagnostics['brakeCaliperDrawCount']}) "
              f"builderProven={diagnostics['provenWheelDrawCount']:2d} {'build' if result['built'] else 'cached'}")
    staged = [row for row in rows if row["status"] == "staged"]
    document = {
        "kind": "blur.wheel-corner-staging",
        "version": 1,
        "generatedBy": "probes/wheels/tools/stage_wheels.py",
        "status": "ok",
        "counts": {
            "records": len(rows),
            "staged": len(staged),
            "unsupported": sum(1 for row in rows if row["status"] == "unsupported"),
            "refused": sum(1 for row in rows if row["status"] == "refused"),
            "classA": sum(1 for row in staged if row["class"] == "A"),
            "classB": sum(1 for row in staged if row["class"] == "B"),
            "classC": sum(1 for row in staged if row["class"] == "C"),
            "wheelDraws": sum(row["wheelDraws"] for row in staged),
            "builderProvenWheelDraws": sum(row["builderProvenWheelDraws"] for row in staged),
            "builderAmbiguousWheelDraws": sum(row["builderAmbiguousWheelDraws"] for row in staged),
        },
        "inputs": {
            "carsJson": str(CARS.relative_to(ROOT).as_posix()),
            "carsJsonSha256": sha256_file(CARS),
            "cAliasesJson": str(CALIASES.relative_to(ROOT).as_posix()),
            "cAliasesJsonSha256": sha256_file(CALIASES),
            "builder": str(BUILDER.relative_to(ROOT).as_posix()),
            "builderSha256": sha256_file(BUILDER),
            "python": PY,
        },
        "records": rows,
        "limits": [
            "Staging only: one first-RenderList LOD0 manifest per record from the committed "
            "car-parts builder. No roster, geometry, material, browser or drive claim.",
            "The manifest is rebuilt only when the decoded model or the builder hash changes; "
            "the recorded hashes make a repeated run byte-identical.",
        ],
    }
    out_root.mkdir(parents=True, exist_ok=True)
    text = json.dumps(document, indent=1, sort_keys=True) + "\n"
    (out_root / "staging.json").write_text(text, encoding="utf-8", newline="\n")
    print(json.dumps({"staged": len(staged), "unsupported": document["counts"]["unsupported"],
                      "refused": document["counts"]["refused"],
                      "wheelDraws": document["counts"]["wheelDraws"],
                      "stagingSha256": sha256_bytes(text.encode("utf-8"))}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
