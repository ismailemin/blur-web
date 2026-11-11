"""Extract the geodesic diameter of the Nth largest draw-covered component.

Experiment tool for the blocked maps: the largest component's diameter may
contain a feature the controller cannot drive (brighton's first 109 m zig-zag).
A different component is a different road.

  python _work/covered_component_path.py --level uk_brighton --component 1 \
      --out _work/covered-course/brighton-c1-path.json
"""

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
WORK = ROOT / "_work/map-pipeline"
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))
import inventory_levels as inv  # noqa: E402
import coverage as cov  # noqa: E402
from covered_path import build_covered_mask  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", required=True)
    ap.add_argument("--component", type=int, default=0)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    grid_path = WORK / "grids" / (args.level + ".npz")
    grid = np.load(grid_path)
    tris, _meta, _hard = cov.load_triangles(args.level)
    buckets, bcell = cov.bucket_triangles(tris)
    covered, _ = build_covered_mask(args.level, grid, tris, buckets, bcell)
    H, xs, zs = grid["height"], grid["xs"], grid["zs"]
    combined = grid["passable"] & covered
    labels, sizes, bboxes = inv.component_label(combined)
    order = sorted(range(len(sizes)), key=lambda k: sizes[k], reverse=True)
    if args.component >= len(order):
        raise SystemExit("component index out of range")
    k = order[args.component]
    cid = k + 1
    seeds = np.flatnonzero((labels == cid).ravel())
    seed0 = int(seeds[0])
    _, _, far_a = inv.bfs_from(labels, cid, seed0, H.shape[1], H.shape[0])
    seed_flat = (int(far_a // (H.shape[1] + 2) - 1) * H.shape[1] +
                 int(far_a % (H.shape[1] + 2) - 1))
    _, parent, far_b = inv.bfs_from(labels, cid, seed_flat, H.shape[1], H.shape[0],
                                    want_parent=True)
    cells = inv.reconstruct(parent, far_b, seed_flat, H.shape[1], H.shape[0])
    pts = [(float(xs[i]), float(zs[j])) for j, i in cells]
    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
    heights = [float(H[j, i]) for j, i in cells]
    max_step = max((abs(b - a) for a, b in zip(heights, heights[1:])
                    if math.isfinite(a) and math.isfinite(b)), default=0.0)
    doc = {
        "schema": "blur.map-pipeline.covered-path/1",
        "level": args.level,
        "model": {"toleranceM": 0.5,
                  "rule": "collision passable AND a declared draw triangle is within 0.5 m of the collision height",
                  "cell": 1.0},
        "component": {"index": args.component, "cells": int(sizes[k]),
                      "bbox": list(bboxes[k])},
        "path": {
            "kind": "geodesic diameter of draw-covered collision component %d" % args.component,
            "lengthM": round(length, 3),
            "maxStepM": round(max_step, 5),
            "start": [pts[0][0], pts[0][1]],
            "end": [pts[-1][0], pts[-1][1]],
            "startGround": round(heights[0], 4),
            "endGround": round(heights[-1], 4),
        },
        "samples": [{"x": x, "z": z, "h": round(h, 4)}
                    for (x, z), h in zip(pts, heights)],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote %s  component %d  %.3f m  %d samples  maxStep %.4f"
          % (out, args.component, length, len(pts), max_step))


if __name__ == "__main__":
    main()
