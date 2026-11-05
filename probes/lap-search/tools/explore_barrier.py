#!/usr/bin/env python3
"""P61: characterise the spawn-component / loop-component barriers exactly.

Finds every pair of boundary cells of two components within `--radius`, clusters
them by location, and for the closest pair in each cluster reports the exact
collision-surface profile: ground along the crossing, nearest steep triangle
(vertices, height band, normal), and the flat-ground width across the gap.
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
sys.path.insert(0, str(ROOT / "probes/lap-search/tools"))
import reference_oracle as oracle  # noqa: E402
from raster import flatten_triangles, triangle_normals  # noqa: E402

PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
CELL = 0.5
SPAWN = (-88.0, 1050.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--radius", type=float, default=6.0)
    args = ap.parse_args()

    d = np.load(ROOT / "_work/lap-search/grid.npz")
    base = d["base"]
    xs, zs = d["xs"], d["zs"]
    from raster import label_components
    lab, sizes = label_components(base, conn=8)
    sj = int(round((SPAWN[1] - zs[0]) / CELL))
    si = int(round((SPAWN[0] - xs[0]) / CELL))
    sid = int(lab[sj, si])

    def boundary(cid):
        m = lab == cid
        p = np.pad(m, 1, constant_values=False)
        inner = (p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1]
                 & p[1:-1, :-2] & p[1:-1, 2:])
        return np.argwhere(m & ~inner)

    # components that own a loop, from loops.json
    import json
    doc = json.loads((ROOT / "_work/lap-search/loops.json").read_text(encoding="utf-8"))
    targets = [c["id"] for c in doc["loopComponents"] if not c["isSpawnComponent"]]
    print("spawn comp", sid, "targets", targets)

    # level triangles for exact queries
    level = oracle.load_level(PHYSICS.read_bytes())
    tris = flatten_triangles(level)
    nrm = triangle_normals(tris)

    A = boundary(sid)
    for cid in targets:
        B = boundary(cid)
        rad_cells = int(math.ceil(args.radius / CELL))
        # bucket B by 4 m cells
        buck = {}
        for j, i in B:
            buck.setdefault((j // 8, i // 8), []).append((j, i))
        pairs = []
        for j, i in A:
            for bj in range(j // 8 - 1, j // 8 + 2):
                for bi in range(i // 8 - 1, i // 8 + 2):
                    for jj, ii in buck.get((bj, bi), ()):
                        dd = math.hypot((jj - j) * CELL, (ii - i) * CELL)
                        if dd <= args.radius:
                            pairs.append((dd, (j, i), (jj, ii)))
        pairs.sort(key=lambda q: q[0])
        # cluster by 20 m midpoint buckets, keep the closest pair per cluster
        clusters = {}
        for dd, pa, pb in pairs:
            mj = (pa[0] + pb[0]) // 40
            mi = (pa[1] + pb[1]) // 40
            key = (mj, mi)
            if key not in clusters:
                clusters[key] = (dd, pa, pb, 0)
            c = clusters[key]
            clusters[key] = (c[0], c[1], c[2], c[3] + 1)
        print("comp", cid, "boundary cells", len(B), "pairs within %.1f m" % args.radius,
              len(pairs), "clusters", len(clusters))
        for key, (dd, pa, pb, cnt) in sorted(clusters.items(), key=lambda kv: kv[1][0])[:8]:
            aw = (float(xs[pa[1]]), float(zs[pa[0]]))
            bw = (float(xs[pb[1]]), float(zs[pb[0]]))
            print("  gap %.3f m  %s -> %s  pairs %d" % (dd, aw, bw, cnt))
            # ground profile
            n = max(2, int(math.ceil(dd / 0.05)) + 1)
            prof = []
            for k in range(n):
                t = k / (n - 1)
                prof.append((aw[0] + (bw[0] - aw[0]) * t, aw[1] + (bw[1] - aw[1]) * t))
            # nearest steep triangle within 2 m of the midpoint
            mx = (aw[0] + bw[0]) / 2
            mz = (aw[1] + bw[1]) / 2
            best = (1e9, None)
            for idx, t in enumerate(tris):
                if abs(nrm[idx, 1]) >= 0.5:
                    continue
                # distance to triangle XZ (reuse a simple point-edge distance)
                ax, az = t[0][0], t[0][2]
                bx, bz = t[1][0], t[1][2]
                cx, cz = t[2][0], t[2][2]
                den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
                dist = 1e9
                if abs(den) > 1e-12:
                    l1 = ((bz - cz) * (mx - cx) + (cx - bx) * (mz - cz)) / den
                    l2 = ((cz - az) * (mx - cx) + (ax - cx) * (mz - cz)) / den
                    l3 = 1.0 - l1 - l2
                    if l1 >= 0 and l2 >= 0 and l3 >= 0:
                        dist = 0.0
                if dist > 0:
                    for (px, pz, qx, qz) in ((ax, az, bx, bz), (bx, bz, cx, cz), (cx, cz, ax, az)):
                        dx, dz = qx - px, qz - pz
                        l2 = dx * dx + dz * dz
                        if l2 == 0:
                            dist = min(dist, math.hypot(mx - px, mz - pz))
                        else:
                            tt = max(0.0, min(1.0, ((mx - px) * dx + (mz - pz) * dz) / l2))
                            dist = min(dist, math.hypot(mx - (px + tt * dx), mz - (pz + tt * dz)))
                if dist < best[0]:
                    best = (dist, idx)
            if best[1] is not None:
                t = tris[best[1]]
                ys = (t[0][1], t[1][1], t[2][1])
                print("    nearest steep tri %d distance %.3f m y %.3f..%.3f normal.y %.3f"
                      % (best[1], best[0], min(ys), max(ys), nrm[best[1], 1]))
                print("    vertices", [[round(float(v[0]), 2), round(float(v[1]), 2),
                                        round(float(v[2]), 2)] for v in t])


if __name__ == "__main__":
    main()
