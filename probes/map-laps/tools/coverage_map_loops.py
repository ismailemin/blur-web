#!/usr/bin/env python3
"""Draw coverage of the map-lap candidate loops.

Uses the committed map-pipeline coverage rule unchanged (read-only import of
`coverage.py` for the draw-triangle loader and its bucket index):

    covered = a declared first-RenderList draw triangle lies within 0.5 m of the
              collision height at that station

Three lateral stations are tested per 0.25 m loop sample: centre and +/-1.0 m in
the loop frame. This answers "is the loop drawn", not "is it rendered": no
material, texture, shader or GPU state is read.

    python probes/map-laps/tools/coverage_map_loops.py --level usa_amboy
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))
import coverage as cov  # noqa: E402  (read-only import)

TOLERANCE = 0.5
LATERAL = (0.0, -1.0, 1.0)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", required=True)
    ap.add_argument("--dir", type=Path)
    args = ap.parse_args(argv)
    base_dir = args.dir or (ROOT / "_work/map-laps" / args.level)
    doc = json.loads((base_dir / "loops.json").read_text(encoding="utf-8"))
    grid = np.load(base_dir / "grid.npz")
    H, xs, zs = grid["height"], grid["xs"], grid["zs"]
    cell = float(xs[1] - xs[0])

    tris, meta, hard_errors = cov.load_triangles(args.level)
    if len(tris) == 0:
        raise SystemExit("no draw triangles for " + args.level)
    buckets, bcell = cov.bucket_triangles(tris)

    def collision_height(x, z):
        i = int(round((x - xs[0]) / cell))
        j = int(round((z - zs[0]) / cell))
        if not (0 <= j < H.shape[0] and 0 <= i < H.shape[1]):
            return None
        h = float(H[j, i])
        return h if math.isfinite(h) else None

    loops = []
    for loop in doc["loops"]:
        pts = loop["points"]
        n = len(pts)
        stations = 0
        covered = 0
        deltas = []
        gaps = []
        current = None
        centre_gap = 0
        for k in range(n - 1):
            x, z = pts[k]
            a = pts[max(0, k - 1)]
            b = pts[min(n - 1, k + 1)]
            fx, fz = b[0] - a[0], b[1] - a[1]
            fl = math.hypot(fx, fz) or 1.0
            nxv, nzv = -fz / fl, fx / fl
            ch = collision_height(x, z)
            if ch is None:
                continue
            seg_hit = False
            for lateral in LATERAL:
                qx, qz = x + nxv * lateral, z + nzv * lateral
                vh, delta, tri = cov.visual_height(qx, qz, tris, buckets, bcell, ch)
                stations += 1
                if delta is not None and delta <= TOLERANCE:
                    covered += 1
                    deltas.append(delta)
                    if lateral == 0.0:
                        seg_hit = True
                elif lateral == 0.0:
                    centre_gap += 1
            if not seg_hit:
                if current is None:
                    current = {"start": [round(x, 3), round(z, 3)], "samples": 0}
                current["samples"] += 1
                current["end"] = [round(x, 3), round(z, 3)]
            elif current is not None:
                current["metres"] = round(current["samples"] * 0.25, 3)
                gaps.append(current)
                current = None
        if current is not None:
            current["metres"] = round(current["samples"] * 0.25, 3)
            gaps.append(current)
        loops.append(dict(
            id=loop["id"], component=loop["component"], length=loop["length"],
            samples=n - 1, stations=stations, coveredStations=covered,
            fraction=round(covered / stations, 6) if stations else 0.0,
            centreUncoveredSamples=centre_gap,
            gapRuns=len(gaps), gapMetres=round(sum(g["metres"] for g in gaps), 3),
            gaps=gaps[:20],
            deltaMin=round(min(deltas), 6) if deltas else None,
            deltaMax=round(max(deltas), 6) if deltas else None,
            deltaMedian=round(float(np.median(deltas)), 6) if deltas else None,
        ))

    out = dict(
        kind="map-laps.coverage",
        version=1,
        level=args.level,
        inputs=dict(
            loopsHash=doc["hash"],
            drawTriangles=int(len(tris)),
            drawSources=len(set(m[0] for m in meta)),
            rule="covered = declared draw triangle within 0.5 m of the collision height",
            lateralStationsM=list(LATERAL),
            hardErrors=hard_errors,
        ),
        loops=loops,
    )
    body = json.dumps(out, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    import hashlib
    out["hash"] = "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
    (base_dir / "coverage.json").write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    print("draws %d triangles from %d sections" % (len(tris), out["inputs"]["drawSources"]))
    for L in loops:
        print("%s len %8.3f cover %.3f gaps %d (%.2f m) delta %s..%s"
              % (L["id"], L["length"], L["fraction"], L["gapRuns"], L["gapMetres"],
                 L["deltaMin"], L["deltaMax"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
