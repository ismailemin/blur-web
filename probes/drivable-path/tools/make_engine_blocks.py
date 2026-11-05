#!/usr/bin/env python3
"""Turn engine-trace wall hits into circular blockers for the next build pass.

The height raster cannot see a thin vertical fin. The engine trace can. Each hit
point is written as {x, z, r, source} and `build_path.py --blocks <file>` clears
that disc from the passable mask before erosion, so the search routes around the
engine-confirmed wall. The process is iterated until the engine trace is clean.

    python probes/drivable-path/tools/make_engine_blocks.py \
        --trace _work/drivable-path/engine-trace.json \
        --out _work/drivable-path/engine-blocks.json
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work/drivable-path"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trace", type=Path, default=OUT / "engine-trace.json")
    ap.add_argument("--out", type=Path, default=OUT / "engine-blocks.json")
    ap.add_argument("--radius", type=float, default=2.5)
    args = ap.parse_args()
    doc = json.loads(args.trace.read_text())
    points = []
    for v in doc["violations"]:
        for h in v.get("hits", []):
            p = h.get("point")
            if p:
                points.append((round(p[0], 4), round(p[1], 4), h.get("dir"), h.get("normal")))
    # cluster within 1.5 m, keep the mean
    clusters = []
    for x, z, d, n in points:
        for c in clusters:
            if math.hypot(x - c["x"], z - c["z"]) <= 1.5:
                c["pts"].append((x, z))
                break
        else:
            clusters.append(dict(x=x, z=z, pts=[(x, z)]))
    blocks = []
    for c in clusters:
        xs = [p[0] for p in c["pts"]]
        zs = [p[1] for p in c["pts"]]
        blocks.append(dict(x=round(sum(xs) / len(xs), 4), z=round(sum(zs) / len(zs), 4),
                           r=args.radius, source="engine-trace wall hit",
                           samples=len(c["pts"])))
    doc_out = dict(kind="drivable-path.engine-blocks", version=1,
                   traceHash=doc.get("hash"), radius=args.radius, blocks=blocks)
    args.out.write_text(json.dumps(doc_out, indent=1) + "\n")
    print("wrote", args.out, len(blocks), "blocks", json.dumps(blocks, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
