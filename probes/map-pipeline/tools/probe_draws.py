#!/usr/bin/env python3
"""Read-only native draw probes for selected levels.

Reuses `tools/inspect_level_candidates.inspect_level` to find first RenderList
direct geometry/node correlated pairs, then runs the committed native
`level_inspect.exe` on those exact stream records. This is the same extraction
path used by the asset-reader probe; no file under tools/, game-data/ or another
probe is modified.

Outputs:
  _work/map-pipeline/probes/<level>-g<block>-n<node>/{geometry.chunk,node.chunk,native.json,reference.json}
  _work/map-pipeline/draw-probes.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
import inspect_level_candidates as candidates  # noqa: E402
from inspect_car_level_assets import Reader, resource_prefix  # noqa: E402
from inspect_level_chunk import geometry  # noqa: E402

LEVEL_INSPECT = ROOT / "_work/build/asset-reader-native/Release/level_inspect.exe"
OUT = ROOT / "_work/map-pipeline/probes"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_floats(text: str):
    return json.loads(text, parse_int=lambda value: -0.0 if value == "-0" else int(value))


def canonical_mesh(report: dict):
    import struct
    positions = b"".join(struct.pack("<f", value) for value in report["positions"])
    indices = b"".join(struct.pack("<I", value) for value in report["indices"])
    return digest(positions), digest(indices)


def probe_level(name: str, max_pairs: int, out_dir: Path):
    statistics = Counter()
    errors = []
    pairs, summary = candidates.inspect_level(name, statistics, errors)
    pairs.sort(key=lambda p: p["estimatedSourceIndexCount"], reverse=True)
    rows = []
    for pair in pairs[:max_pairs]:
        node = pair["node"]
        block = pair["geometryBlock"]
        record = pair["geometryRecord"]
        probe = {
            "level": name,
            "geometryBlock": block,
            "geometryChunkIndex": pair["geometryChunkIndex"],
            "nodeBlock": node["record"]["items"][0]["block"],
            "nodeChunkIndex": node["chunkIndex"],
            "estimatedSourceIndexCount": pair["estimatedSourceIndexCount"],
            "levelFile": str(pair["levelFile"]),
            "levelSha256": pair["levelSha256"],
        }
        try:
            raw = pair["readRecord"](record)
            resources = resource_prefix(raw, {"resourcePayloadOffset": 24,
                                              "scenePayloadOffset": 0}, streamed=True)
            if resources["nodeCount"]:
                raise ValueError("first geometry resource also has node payloads")
            r = Reader(raw, resources["firstNodeOffset"])
            if r.unpack("I"):
                raise ValueError("first geometry resource has textures")
            reference = geometry(raw, resources, pair["scene"], node["render"], block)
            stage = out_dir / ("%s-g%d-n%d" % (name, block, probe["nodeBlock"]))
            stage.mkdir(parents=True, exist_ok=True)
            geometry_file = stage / "geometry.chunk"
            node_file = stage / "node.chunk"
            geometry_file.write_bytes(raw)
            node_file.write_bytes(node["raw"])
            proc = subprocess.run(
                [str(LEVEL_INSPECT), str(pair["levelFile"]), str(geometry_file),
                 str(node_file), str(block), str(probe["nodeBlock"])],
                capture_output=True, text=True, encoding="utf-8", timeout=120,
                check=False)
            native = json_floats(proc.stdout) if proc.stdout else {}
            if proc.returncode != 0 or native.get("status") != "ok":
                raise ValueError("native: " + (native.get("error") or proc.stderr[:200]))
            pos_hash, idx_hash = canonical_mesh(native)
            if pos_hash != reference["positionsFloat32LESha256"]:
                raise ValueError("position hash mismatch")
            if idx_hash != reference["indicesUint32LESha256"]:
                raise ValueError("index hash mismatch")
            (stage / "native.json").write_text(json.dumps(native) + "\n",
                                               encoding="utf-8")
            (stage / "reference.json").write_text(json.dumps(reference) + "\n",
                                                  encoding="utf-8")
            probe.update({
                "status": "ok",
                "vertexCount": reference["vertexCount"],
                "triangleCount": reference["triangleCount"],
                "drawCount": len(reference["draws"]),
                "bounds": reference["bounds"],
                "geometryChunkBytes": len(raw),
                "nodeChunkBytes": len(node["raw"]),
                "geometryChunkSha256": digest(raw),
                "nodeChunkSha256": digest(node["raw"]),
                "positionsFloat32LESha256": pos_hash,
                "indicesUint32LESha256": idx_hash,
                "stage": str(stage.relative_to(ROOT)).replace("\\", "/"),
                "instancesApplied": False,
            })
        except (ValueError, IndexError, StopIteration, KeyError,
                json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
            probe.update({"status": "unsupported", "error": str(exc)[:300]})
        rows.append(probe)
    return {"level": name, "summary": summary,
            "pairCount": len(pairs), "probes": rows,
            "errors": [e for e in errors if e.get("level") == name][:10]}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--levels", nargs="+", required=True)
    ap.add_argument("--max-pairs", type=int, default=8)
    ap.add_argument("--out", type=Path, default=OUT.parent / "draw-probes.json")
    args = ap.parse_args(argv)
    OUT.mkdir(parents=True, exist_ok=True)
    rows = [probe_level(name, args.max_pairs, OUT) for name in args.levels]
    doc = {
        "schema": "blur.map-pipeline.draw-probes/1",
        "scope": ("first RenderList direct LOD0 geometry only; instancesApplied:false; "
                  "materials/textures/shaders not applied"),
        "nativeReader": str(LEVEL_INSPECT.relative_to(ROOT)).replace("\\", "/"),
        "nativeReaderSha256": digest(LEVEL_INSPECT.read_bytes()),
        "levels": rows,
    }
    args.out.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n",
                        encoding="utf-8")
    print(json.dumps({r["level"]: {
        "pairs": r["pairCount"],
        "ok": sum(1 for p in r["probes"] if p["status"] == "ok"),
        "unsupported": sum(1 for p in r["probes"] if p["status"] != "ok"),
    } for r in rows}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
