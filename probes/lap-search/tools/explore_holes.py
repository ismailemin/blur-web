#!/usr/bin/env python3
"""P61 screening: 1 m components and their enclosed islands (all components)."""
from __future__ import annotations

import math
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
sys.path.insert(0, str(ROOT / "probes/lap-search/tools"))
import reference_oracle as oracle  # noqa: E402
from raster import (  # noqa: E402
    flatten_triangles, triangle_normals, rasterise_height, edge_max_dh,
    rasterise_wall, label_components, enclosed_islands,
)

PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"


def main():
    t0 = time.time()
    level = oracle.load_level(PHYSICS.read_bytes())
    tris = flatten_triangles(level)
    nrm = triangle_normals(tris)
    surface = tris[nrm[:, 1] > 0.94]
    wall = tris[np.abs(nrm[:, 1]) < 0.5]
    p = tris.reshape(-1, 3)
    x0 = math.floor(p[:, 0].min()) - 2
    x1 = math.ceil(p[:, 0].max()) + 2
    z0 = math.floor(p[:, 2].min()) - 2
    z1 = math.ceil(p[:, 2].max()) + 2
    H, xs, zs = rasterise_height(surface, x0, x1, z0, z1, 1.0)
    dh = edge_max_dh(H)
    W = rasterise_wall(wall, H, x0, x1, z0, z1, 1.0, 0.5)
    base = np.isfinite(H) & (dh <= 0.05 + 1e-9) & ~W
    print("raster %.1fs base cells %d" % (time.time() - t0, base.sum()))
    lab, sizes = label_components(base, conn=8)
    print("components", len(sizes), "%.1fs" % (time.time() - t0))
    isl = enclosed_islands(base, lab)
    print("islands", len(isl), "%.1fs" % (time.time() - t0))
    # per-component island counts
    from collections import Counter
    cnt = Counter(i["owner"] for i in isl)
    big = [i for i in isl if i["size"] >= 10]
    print("islands >= 10 cells:", len(big))
    # print per island with component size
    for h in big[:60]:
        cid = h["owner"]
        x0h, x1h, z0h, z1h = h["bbox"]
        print("island %5d cells (%.0f m2) owner comp %3d (cells %6d) x %.1f..%.1f z %.1f..%.1f"
              % (h["size"], h["size"], cid,
                 sizes[cid - 1] if cid else 0,
                 xs[x0h], xs[x1h], zs[z0h], zs[z1h]))
    print("owners with islands:", len(cnt))
    for cid, n in sorted(cnt.items(), key=lambda kv: -sizes[kv[0] - 1] if kv[0] else 0):
        if cid == 0:
            continue
        print("  comp %3d cells %6d islands %4d largest %5d"
              % (cid, sizes[cid - 1], n,
                 max(i["size"] for i in isl if i["owner"] == cid)))
    print("total %.1fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
