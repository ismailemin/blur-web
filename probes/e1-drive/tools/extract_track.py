"""Extract the River collision surface around the drive slice as a triangle mesh.

The E1 drive slice renders the committed River *draw* set (block27/node253, 22
instances). That set is props near the road, not the road itself: the surface the
wheels actually trace is `usa_la_river/Level.levelphysics`, which is not part of
the render packet. Without it the car drives on an invisible surface.

This tool emits the collision triangles inside one world-space box. The E1 drive
slice no longer draws them as the track visual: the real River render geometry is
drawn instead (committed `level_inspect` direct draws), and this mesh is kept in
the packet as hidden physics provenance (`visible:false`) and used to measure how
much of the drive box the real draws cover.

It reuses the collision oracle's independent Python reference parser
(`probes/collision-oracle/tests/reference_oracle.py`), whose derivation was
verified against the engine (T-005d-gravity-wasm.md). No format is re-derived and
no vertex is invented: positions are the file's own vertices, selected by leaf
index exactly as the reference query path does.

Usage:
    python probes/e1-drive/tools/extract_track.py [--out _work/e1-drive/track.json]

Writes only under _work/e1-drive/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
import reference_oracle as oracle  # noqa: E402

LEVEL = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
DEFAULT_OUT = ROOT / "_work/e1-drive/track.json"
PARSER = ROOT / "probes/collision-oracle/tests/reference_oracle.py"

# The box that contains the whole 300-tick script for every roster car (the
# slowest car leaves the spawn by 30.7 m, the fastest AWD car by 69.4 m: spawn
# x = -88, so the run reaches x ~ -18.6) plus the visible props around it and the
# chase camera's working area behind the car. Chosen from the measured runs in
# _work/e1-drive/run.json, not from a guess.
BOX_MIN = (-120.0, 0.0, 1010.0)
BOX_MAX = (-10.0, 20.0, 1090.0)


def inside(p):
    return (BOX_MIN[0] <= p[0] <= BOX_MAX[0] and
            BOX_MIN[1] <= p[1] <= BOX_MAX[1] and
            BOX_MIN[2] <= p[2] <= BOX_MAX[2])


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args(argv)

    if not LEVEL.is_file():
        print(f"extract_track: BLOCKED: missing {LEVEL}", file=sys.stderr)
        return 3
    data = LEVEL.read_bytes()
    level = oracle.load_level(data)

    positions = []
    indices = []
    index_of = {}
    kept = 0
    skipped = 0
    per_mesh = []

    def vertex_id(p):
        key = (round(p[0], 4), round(p[1], 4), round(p[2], 4))
        existing = index_of.get(key)
        if existing is not None:
            return existing
        identifier = len(positions) // 3
        index_of[key] = identifier
        positions.extend((p[0], p[1], p[2]))
        return identifier

    for mesh in level["meshes"]:
        vertices = mesh["vertices"]
        leaves = mesh["leaves"]
        mesh_kept = 0
        for triangle in mesh["triangles"]:
            leaf = leaves[triangle["leaf"]]
            base = leaf["vertex_start"]
            a = vertices[base + triangle["a"]]
            b = vertices[base + triangle["b"]]
            c = vertices[base + triangle["c"]]
            if not (inside(a) and inside(b) and inside(c)):
                skipped += 1
                continue
            indices.extend((vertex_id(a), vertex_id(b), vertex_id(c)))
            kept += 1
            mesh_kept += 1
        if mesh_kept:
            per_mesh.append({"meshIndex": mesh["index"], "triangles": mesh_kept})

    if kept == 0:
        print("extract_track: FAILED: no triangle inside the box", file=sys.stderr)
        return 2

    minv = [min(positions[i::3]) for i in range(3)]
    maxv = [max(positions[i::3]) for i in range(3)]
    vertex_count = len(positions) // 3

    position_bytes = struct.pack("<%df" % len(positions), *positions)
    index_bytes = struct.pack("<%dI" % len(indices), *indices)
    document = {
        "kind": "e1-drive.track",
        "version": 1,
        "id": "river.collision.surface",
        "source": {
            "file": "game-data/Blur/levels/usa_la_river/Level.levelphysics",
            "sha256": hashlib.sha256(data).hexdigest(),
            "parser": "probes/collision-oracle/tests/reference_oracle.py (load_level)",
            "parserSha256": hashlib.sha256(PARSER.read_bytes()).hexdigest(),
            "selection": {
                "boxMin": list(BOX_MIN),
                "boxMax": list(BOX_MAX),
                "rule": "a triangle is kept when all three of its vertices are inside the box"
            },
            "levelMeshes": len(level["meshes"]),
            "levelTriangles": sum(len(m["triangles"]) for m in level["meshes"]),
            "keptTriangles": kept,
            "skippedTriangles": skipped,
            "keptPerMesh": per_mesh,
            "note": (
                "physics collision geometry, not retail render geometry: the level material list "
                "and any visual mesh are not bound. The E1 drive packet keeps this mesh as hidden "
                "physics provenance (visible:false) and draws the real level_inspect direct draws"
            )
        },
        "vertexCount": vertex_count,
        "indexCount": len(indices),
        "positions": positions,
        "indices": indices,
        "positionsSha256": "sha256:" + hashlib.sha256(position_bytes).hexdigest(),
        "indicesSha256": "sha256:" + hashlib.sha256(index_bytes).hexdigest(),
        "coordinateSpace": "world",
        "bounds": {"min": [round(v, 4) for v in minv], "max": [round(v, 4) for v in maxv]}
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(document)
    out.write_text(text, encoding="utf-8")

    print(json.dumps({
        "output": str(out.relative_to(ROOT)).replace("\\", "/"),
        "bytes": len(text.encode("utf-8")),
        "sha256": "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "vertices": vertex_count,
        "triangles": len(indices) // 3,
        "levelTriangles": document["source"]["levelTriangles"],
        "bounds": document["bounds"],
        "levelSha256": document["source"]["sha256"],
        "parserSha256": document["source"]["parserSha256"]
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
