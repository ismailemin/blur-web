#!/usr/bin/env python3
"""P61: full-level 0.5 m components and enclosed islands (the real screen)."""
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
CELL = 0.5


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
    H, xs, zs = rasterise_height(surface, x0, x1, z0, z1, CELL)
    print("height %.1fs shape %s" % (time.time() - t0, H.shape))
    dh = edge_max_dh(H)
    W = rasterise_wall(wall, H, x0, x1, z0, z1, CELL, 0.5)
    print("wall %.1fs" % (time.time() - t0))
    base = np.isfinite(H) & (dh <= 0.025 + 1e-9) & ~W
    print("base cells", int(base.sum()), "%.1fs" % (time.time() - t0))
    np.savez_compressed(ROOT / "_work/lap-search/_full05.npz",
                        base=base, wall=W, height=H.astype(np.float32),
                        xs=xs, zs=zs)
    del H, dh, W
    lab, sizes = label_components(base, conn=8)
    print("components", len(sizes), "%.1fs" % (time.time() - t0))
    isl = enclosed_islands(base, lab)
    print("islands", len(isl), "%.1fs" % (time.time() - t0))
    big = [h for h in isl if h["size"] >= 400]  # >= 100 m2 at 0.5 m
    print("islands >= 400 cells (100 m2):", len(big))
    for h in big:
        cid = h["owner"]
        x0h, x1h, z0h, z1h = h["bbox"]
        print("island %6d cells (%6.0f m2) owner comp %3d (cells %6d, %.0f m2) "
              "x %7.1f..%7.1f z %7.1f..%7.1f"
              % (h["size"], h["size"] * CELL * CELL, cid,
                 sizes[cid - 1] if cid else 0,
                 (sizes[cid - 1] if cid else 0) * CELL * CELL,
                 xs[x0h], xs[x1h], zs[z0h], zs[z1h]))
    print("total %.1fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
