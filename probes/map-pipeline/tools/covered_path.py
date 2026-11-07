#!/usr/bin/env python3
"""Draw-aware collision path: only cells whose collision surface is under an
extracted draw triangle within 0.5 m are traversable.

This generalises the track-coverage/P41 rule to any level with first RenderList
direct draws. Inputs are the 1 m collision grid from inventory_levels.py and the
native draw probes from probe_draws.py.

Output: _work/map-pipeline/covered/<level>.json
  coveredCells, component count, largest covered component, path length,
  gap/coverage counts. No renderer claim.
"""
from __future__ import annotations

import argparse
import hashlib
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

TOLERANCE = 0.5


def build_covered_mask(level, grid, tris, buckets, bcell):
    H, xs, zs = grid["height"], grid["xs"], grid["zs"]
    passable = grid["passable"]
    nz, nx = H.shape
    covered = np.zeros((nz, nx), dtype=bool)
    nearest_delta = np.full((nz, nx), np.nan, dtype=np.float32)
    js, is_ = np.nonzero(passable)
    for j, i in zip(js.tolist(), is_.tolist()):
        ch = float(H[j, i])
        if not math.isfinite(ch):
            continue
        vh, delta, tri = cov.visual_height(float(xs[i]), float(zs[j]),
                                           tris, buckets, bcell, ch)
        if delta is not None and delta <= TOLERANCE:
            covered[j, i] = True
            nearest_delta[j, i] = delta
    return covered, nearest_delta


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", required=True)
    ap.add_argument("--grid", type=Path)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args(argv)
    grid_path = args.grid or (WORK / "grids" / (args.level + ".npz"))
    out = args.out or (WORK / "covered" / (args.level + ".json"))
    grid = np.load(grid_path)
    tris, meta, hard_errors = cov.load_triangles(args.level)
    if len(tris) == 0:
        raise SystemExit("no draw triangles for " + args.level)
    buckets, bcell = cov.bucket_triangles(tris)
    covered, deltas = build_covered_mask(args.level, grid, tris, buckets, bcell)
    H, xs, zs = grid["height"], grid["xs"], grid["zs"]
    passable = grid["passable"]
    combined = passable & covered
    labels, sizes, bboxes = inv.component_label(combined)
    order = sorted(range(len(sizes)), key=lambda k: sizes[k], reverse=True)
    doc = {
        "schema": "blur.map-pipeline.covered-path/1",
        "level": args.level,
        "inputs": {
            "grid": str(grid_path.relative_to(ROOT)).replace("\\", "/"),
            "gridSha256": hashlib.sha256(grid_path.read_bytes()).hexdigest(),
            "nativeProbes": sorted(p.name for p in (WORK / "probes").glob(args.level + "-*")),
        },
        "model": {"toleranceM": TOLERANCE,
                  "rule": "collision passable AND a declared draw triangle is within 0.5 m of the collision height",
                  "cell": 1.0},
        "drawTriangles": int(len(tris)),
        "hardErrors": hard_errors,
        "passableCells": int(passable.sum()),
        "coveredPassableCells": int(combined.sum()),
        "coverageOfPassable": round(float(combined.sum()) / max(1, int(passable.sum())), 6),
        "componentCount": len(sizes),
        "topComponents": [
            {"cells": int(sizes[k]), "areaM2": float(sizes[k]),
             "bbox": list(bboxes[k])} for k in order[:10]
        ],
    }
    if order and sizes[order[0]] > 0:
        cid = order[0] + 1
        seeds = np.flatnonzero((labels == cid).ravel())
        seed0 = int(seeds[0])
        _, _, far_a = inv.bfs_from(labels, cid, seed0, H.shape[1], H.shape[0])
        seed_flat = (int(far_a // (H.shape[1] + 2) - 1) * H.shape[1] +
                     int(far_a % (H.shape[1] + 2) - 1))
        _, parent, far_b = inv.bfs_from(labels, cid, seed_flat, H.shape[1], H.shape[0],
                                        want_parent=True)
        cells = inv.reconstruct(parent, far_b, seed_flat, H.shape[1], H.shape[0])
        pts = [(float(xs[i]), float(zs[j])) for j, i in cells]
        length = sum(math.hypot(b[0] - a[0], b[1] - a[1])
                     for a, b in zip(pts, pts[1:]))
        heights = [float(H[j, i]) for j, i in cells]
        max_step = max((abs(b - a) for a, b in zip(heights, heights[1:])
                        if math.isfinite(a) and math.isfinite(b)), default=0.0)
        doc["path"] = {
            "kind": "geodesic diameter of the largest draw-covered collision component",
            "lengthM": round(length, 3),
            "samples": len(pts),
            "start": [round(pts[0][0], 3), round(pts[0][1], 3)] if pts else None,
            "end": [round(pts[-1][0], 3), round(pts[-1][1], 3)] if pts else None,
            "startGround": round(heights[0], 4) if heights else None,
            "endGround": round(heights[-1], 4) if heights else None,
            "maxStepM": round(max_step, 5),
            "bbox": [round(min(p[0] for p in pts), 3), round(max(p[0] for p in pts), 3),
                     round(min(p[1] for p in pts), 3), round(max(p[1] for p in pts), 3)] if pts else None,
        }
        path_path = WORK / "covered" / (args.level + "-path.json")
        path_path.parent.mkdir(parents=True, exist_ok=True)
        path_path.write_text(json.dumps({
            "schema": "blur.map-pipeline.path/1", "level": args.level,
            "kind": "draw-covered geodesic diameter",
            "samples": [{"x": round(xs[i], 3), "z": round(zs[j], 3),
                         "h": round(float(H[j, i]), 4)} for j, i in cells],
        }, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")
        doc["path"]["artifact"] = str(path_path.relative_to(ROOT)).replace("\\", "/")
        doc["path"]["artifactSha256"] = hashlib.sha256(path_path.read_bytes()).hexdigest()
    else:
        doc["path"] = {"lengthM": 0.0, "reason": "no draw-covered passable cell"}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"level": args.level, "passable": int(passable.sum()),
                      "covered": int(combined.sum()),
                      "components": len(sizes),
                      "path": doc["path"].get("lengthM")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
