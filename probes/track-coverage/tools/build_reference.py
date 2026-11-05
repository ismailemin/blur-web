"""Enumerate every USA LA River RenderList direct-draw section (read-only).

This is the input stage for the track-coverage probe. It reuses the committed
Python readers (`tools/inspect_level_candidates.py`, `tools/inspect_level_chunk.py`)
and writes only under `_work/track-coverage/`. It never writes to `upstream/`,
`game-data/` or an installed game.

The output `visual.json` is a cache of the 46 source-correlated RenderList /
geometry pairs that the committed readers can expand. Every section keeps its
source identity (geometry block, node block, chunk indices), its per-draw
ranges (via the reference `draws` array) and the SHA-256 of its float32
positions and uint32 indices.

Usage:
    python probes/track-coverage/tools/build_reference.py [--out-dir DIR]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
import inspect_level_candidates as cand  # noqa: E402
from inspect_level_chunk import geometry  # noqa: E402

LEVEL = "usa_la_river"
DEFAULT_OUT = ROOT / "_work/track-coverage"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def float_bytes(values):
    return struct.pack("<%df" % len(values), *values)


def uint_bytes(values):
    return struct.pack("<%dI" % len(values), *values)


def main(argv) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)
    out = args.out_dir.resolve()
    if out.is_relative_to((ROOT / "game-data/Blur").resolve()):
        ap.error("output must be outside game data")
    out.mkdir(parents=True, exist_ok=True)

    statistics = Counter()
    pairs, summary = cand.inspect_level(LEVEL, statistics, [])
    if not pairs:
        print("build_reference: FAILED: no correlated RenderList/geometry pairs", file=sys.stderr)
        return 2
    # Deterministic order: largest declared index count first, then block/node.
    pairs.sort(
        key=lambda p: (
            -p["estimatedSourceIndexCount"],
            p["geometryBlock"],
            p["node"]["record"]["items"][0]["block"],
        )
    )

    sections = []
    for pair in pairs:
        node = pair["node"]
        block = pair["geometryBlock"]
        node_block = node["record"]["items"][0]["block"]
        key = f"g{block}-n{node_block}"
        record = pair["geometryRecord"]
        try:
            raw = pair["readRecord"](record)
            resources = cand.resource_prefix(
                raw,
                {"resourcePayloadOffset": 24, "scenePayloadOffset": 0},
                streamed=True,
            )
            if resources["nodeCount"]:
                raise ValueError("first geometry resource also has node payloads")
            reader = cand.Reader(raw, resources["firstNodeOffset"])
            if reader.unpack("I"):
                raise ValueError("first geometry resource has textures")
            ref = geometry(raw, resources, pair["scene"], node["render"], block)
        except Exception as error:  # reported, never silently skipped
            sections.append(
                {
                    "key": key,
                    "geometryBlock": block,
                    "nodeBlock": node_block,
                    "status": "unsupported",
                    "error": str(error),
                }
            )
            continue

        positions = ref["positions"]
        indices = ref["indices"]
        section = {
            "key": key,
            "status": "ok",
            "geometryBlock": block,
            "nodeBlock": node_block,
            "geometryChunkIndex": pair["geometryChunkIndex"],
            "nodeChunkIndex": node["chunkIndex"],
            "nodeName": node["render"]["name"],
            "estimatedSourceIndexCount": pair["estimatedSourceIndexCount"],
            "vertexCount": ref["vertexCount"],
            "triangleCount": ref["triangleCount"],
            "drawCount": len(ref["draws"]),
            "bounds": ref["bounds"],
            "positionsSha256": digest(float_bytes(positions)),
            "indicesSha256": digest(uint_bytes(indices)),
            "draws": ref["draws"],
            "positions": positions,
            "indices": indices,
        }
        sections.append(section)
        print(
            "%s g%s n%s: %d verts / %d tris / %d draws"
            % (key, block, node_block, ref["vertexCount"], ref["triangleCount"], len(ref["draws"]))
        )

    level_file = ROOT / "game-data/Blur/levels" / LEVEL / "level.levelrender"
    stream_file = ROOT / "game-data/Blur/levels" / LEVEL / "level.levelstream"
    physics_file = ROOT / "game-data/Blur/levels" / LEVEL / "Level.levelphysics"
    document = {
        "kind": "track-coverage.visual-sections",
        "version": 1,
        "level": LEVEL,
        "source": {
            "levelRender": str(level_file.relative_to(ROOT)).replace("\\", "/"),
            "levelRenderSha256": digest(level_file.read_bytes()),
            "levelStream": str(stream_file.relative_to(ROOT)).replace("\\", "/"),
            "levelStreamSha256": digest(stream_file.read_bytes()) if stream_file.is_file() else None,
            "levelPhysics": str(physics_file.relative_to(ROOT)).replace("\\", "/"),
            "levelPhysicsSha256": digest(physics_file.read_bytes()) if physics_file.is_file() else None,
            "reader": "tools/inspect_level_candidates.py + tools/inspect_level_chunk.py",
            "selection": (
                "first RenderList direct draws of every source-correlated geometry/node pair; "
                "instances are not applied and no transform is invented"
            ),
            "instancesApplied": False,
            "mapOnly": False,
        },
        "summary": summary,
        "statistics": dict(statistics),
        "sections": sections,
    }
    text = json.dumps(document, separators=(",", ":"))
    path = out / "visual.json"
    path.write_text(text, encoding="utf-8")
    sha = digest(text.encode("utf-8"))

    manifest = {
        "kind": "track-coverage.visual-manifest",
        "version": 1,
        "visual": str(path.relative_to(ROOT)).replace("\\", "/"),
        "visualSha256": sha,
        "source": document["source"],
        "summary": summary,
        "statistics": dict(statistics),
        "sections": [
            {k: v for k, v in s.items() if k not in ("positions", "indices", "draws")}
            for s in sections
        ],
    }
    (out / "visual-manifest.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({"sections": len(sections), "visual": str(path), "sha256": sha}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
