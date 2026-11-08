"""Re-derive the three remaining builder refusals from the committed data.

This is a read-only diagnostic. It parses the decoded body model with the
committed `build_manifest.parse_mdldat` and reads the scene with the committed
`scene_inspect.exe`; it never edits a model, a scene or a manifest.

For every record still `scope:"remaining"` it records:

  * the `e_wheel_*` parents and their wheel members (name, parent, local bounds,
    matrix translation, extent);
  * the parent chain of any wheel part that is not a direct child of an
    `e_wheel_*` element;
  * every scene draw with `indexCount == 0`;
  * for a wheel whose member union fails the thin-X / round-Y-Z test, both the
    member union and the parent envelope.

Usage:
  python probes/vehicle-batch/tools/inspect_builder_decisions.py
         [--spec <path>] [--out <path>]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
for path in (ROOT / "probes/car-parts/tools", ROOT / "tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import build_manifest as bm  # noqa: E402  (committed MdlDat parser)

SPEC_DEFAULT = ROOT / "probes/vehicle-batch/spec/cars.json"
OUT_DEFAULT = ROOT / "_work/vehicle-batch/builder-decisions.json"
SCENE_EXE = ROOT / "_work/build/asset-reader-native/Release/scene_inspect.exe"


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def extent(lo, hi) -> list[float]:
    return [hi[i] - lo[i] for i in range(3)]


def wheel_rows(elements: list[dict]) -> tuple[list[dict], list[dict]]:
    by_index = {element["index"]: element for element in elements}
    parents = [element for element in elements
               if element["name"].lower().startswith("e_wheel_")]
    parent_indexes = {element["index"] for element in parents}
    rows = []
    orphans = []
    for element in elements:
        kind = bm.wheel_kind(element["name"])
        if kind is None and not element["name"].lower().startswith("e_wheel_"):
            continue
        parent = by_index.get(element["parent"])
        row = {
            "index": element["index"],
            "name": element["name"],
            "kind": kind,
            "parentIndex": element["parent"],
            "parentName": parent["name"] if parent else None,
            "matrixTranslation": element["matrix"][3][:3],
            "min": element["min"],
            "max": element["max"],
            "extent": extent(element["min"], element["max"]),
        }
        if kind is not None and element["parent"] not in parent_indexes:
            chain = []
            cursor = element
            while cursor is not None:
                chain.append({"index": cursor["index"], "name": cursor["name"]})
                cursor = by_index.get(cursor["parent"])
            row["parentChain"] = chain
            orphans.append(row)
        rows.append(row)
    return rows, orphans


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--spec", type=Path, default=SPEC_DEFAULT)
    parser.add_argument("--out", type=Path, default=OUT_DEFAULT)
    args = parser.parse_args()

    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    records = []
    for car in spec["cars"]:
        if car["scope"] != "remaining":
            continue
        body = car["body"]
        record = {
            "slug": car["slug"],
            "recordIndex": car["recordIndex"],
            "recordId": car["recordId"],
            "recordName": car["recordName"],
            "body": None if body is None else {
                "pakPath": body["pakPath"],
                "sha256": body["sha256"],
                "decodedPath": body["decodedPath"],
            },
            "builderDecision": car.get("builderDecision"),
            "builderDiagnosis": car.get("builderDiagnosis"),
        }
        if body is None:
            record["status"] = "no-body-model"
            records.append(record)
            continue
        model_path = ROOT / body["decodedPath"]
        data = model_path.read_bytes()
        mdl = bm.parse_mdldat(data)
        elements = [element for element in mdl["elements"]
                    if element["modelIndex"] == 0]
        rows, orphans = wheel_rows(elements)
        wheels = []
        by_index = {element["index"]: element for element in elements}
        for parent in elements:
            if not parent["name"].lower().startswith("e_wheel_"):
                continue
            members = [element for element in rows
                       if element["parentIndex"] == parent["index"]]
            member_bounds = [{"min": element["min"], "max": element["max"]}
                             for element in members]
            union_lo = [min(item["min"][i] for item in member_bounds)
                        for i in range(3)]
            union_hi = [max(item["max"][i] for item in member_bounds)
                        for i in range(3)]
            union_extent = extent(union_lo, union_hi)
            parent_extent = extent(parent["min"], parent["max"])
            wheels.append({
                "parent": parent["name"],
                "parentIndex": parent["index"],
                "parentExtent": parent_extent,
                "parentRoundRelativeDelta": abs(parent_extent[1] - parent_extent[2])
                / max(parent_extent[1], parent_extent[2]),
                "memberUnionExtent": union_extent,
                "memberUnionRoundRelativeDelta": abs(
                    union_extent[1] - union_extent[2])
                / max(union_extent[1], union_extent[2]),
                "members": members,
            })
        scene = json.loads(subprocess.run(
            [str(SCENE_EXE), str(model_path)], capture_output=True, text=True,
            encoding="utf-8", check=True).stdout)
        empty_draws = [
            {"draw": index, "firstIndex": draw.get("firstIndex"),
             "indexCount": draw.get("indexCount")}
            for index, draw in enumerate(scene.get("draws") or [])
            if int(draw.get("indexCount") or 0) == 0
        ]
        record.update({
            "status": "inspected",
            "scene": {"drawCount": len(scene.get("draws") or []),
                      "emptyDraws": empty_draws},
            "wheelParents": wheels,
            "orphanWheelParts": orphans,
        })
        records.append(record)

    document = {
        "kind": "blur.vehicle-batch.builder-decisions",
        "version": 1,
        "generatedBy": "probes/vehicle-batch/tools/inspect_builder_decisions.py",
        "spec": {"path": rel(args.spec),
                 "sha256": hashlib.sha256(args.spec.read_bytes()).hexdigest()},
        "records": records,
        "note": "read-only evidence for the remaining builder refusals; no model, "
                "scene or manifest is edited",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(
        (json.dumps(document, indent=1, sort_keys=True) + "\n").encode("utf-8"))
    print(json.dumps({"out": rel(args.out), "records": len(records)}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
