#!/usr/bin/env python3
"""Build the sections-only River input for the environment probe.

``usa_la_river`` has no map-slice package (the map-pipeline never produced a
candidate layout for it). The environment probe only needs section identity,
chunk indexes, bounds and counts, which the committed
``_work/map-pipeline/draw-probes-all.json`` already contains. This script copies
those fields, adds each section's ``instanceDescriptionsSkipped`` from the
committed probe ``native.json`` metadata, and writes a clearly labelled
sections-only document under ``_work/environment/river/``.

No geometry, material, texture, collision or layout value is synthesised.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env_common import ROOT, dump_json, load_json, sha256_file  # noqa: E402

LEVEL = "usa_la_river"
OUT = ROOT / "_work/environment/river"
PROBES = ROOT / "_work/map-pipeline/draw-probes-all.json"


def main() -> int:
    doc = load_json(PROBES)
    level = next(x for x in doc["levels"] if x["level"] == LEVEL)
    supported, unsupported = [], []
    for probe in level["probes"]:
        stage = probe.get("stage") or (
            "_work/map-pipeline/probes/%s-g%d-n%d"
            % (LEVEL, probe["geometryBlock"], probe["nodeBlock"]))
        native_path = ROOT / stage / "native.json"
        instances = 0
        if native_path.is_file():
            meta = load_json(native_path).get("metadata", {})
            instances = int(meta.get("instanceDescriptionsSkipped", 0))
        row = {
            "id": "g%d-n%d" % (probe["geometryBlock"], probe["nodeBlock"]),
            "geometryBlock": probe["geometryBlock"],
            "nodeBlock": probe["nodeBlock"],
            "geometryChunkIndex": probe["geometryChunkIndex"],
            "nodeChunkIndex": probe["nodeChunkIndex"],
            "vertexCount": probe.get("vertexCount", 0),
            "indexCount": probe.get("estimatedSourceIndexCount", 0),
            "triangleCount": probe.get("triangleCount", 0),
            "drawCount": probe.get("drawCount", 0),
            "bounds": probe.get("bounds"),
            "instanceDescriptionsSkipped": instances,
            "stage": stage,
        }
        if probe["status"] == "ok":
            row["status"] = "supported"
            supported.append(row)
        else:
            unsupported.append({
                "id": row["id"],
                "geometryBlock": row["geometryBlock"],
                "nodeBlock": row["nodeBlock"],
                "geometryChunkIndex": row["geometryChunkIndex"],
                "nodeChunkIndex": row["nodeChunkIndex"],
                "status": "unsupported",
                "reason": "Unsupported position vertex format",
                "byteOffset": None,
                "error": probe.get("error"),
                "estimatedSourceIndexCount": probe.get("estimatedSourceIndexCount"),
            })

    doc_out = {
        "schema": "blur.environment.probe-slice/1",
        "kind": "environment-sections-input",
        "level": LEVEL,
        "note": "Sections-only input for the environment probe. Section identity, "
                "chunk indexes, bounds and counts are copied from the committed "
                "map-pipeline draw probes; instanceDescriptionsSkipped is read from "
                "each stage's native.json metadata. No geometry, material, texture, "
                "collision or layout value is added.",
        "source": {
            "drawProbes": {"path": "_work/map-pipeline/draw-probes-all.json",
                           "sha256": sha256_file("_work/map-pipeline/draw-probes-all.json")},
        },
        "draws": {
            "sectionsProbed": len(level["probes"]),
            "sectionsSupported": len(supported),
            "sectionsUnsupported": len(unsupported),
            "sections": supported,
            "unsupportedSections": unsupported,
        },
    }
    OUT.mkdir(parents=True, exist_ok=True)
    digest = dump_json(OUT / "slice.json", doc_out)
    print(json.dumps({
        "file": "_work/environment/river/slice.json",
        "sha256": digest,
        "supported": len(supported),
        "unsupported": len(unsupported),
        "draws": sum(s["drawCount"] for s in supported),
        "triangles": sum(s["triangleCount"] for s in supported),
        "vertices": sum(s["vertexCount"] for s in supported),
        "instances": sum(s["instanceDescriptionsSkipped"] for s in supported),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
