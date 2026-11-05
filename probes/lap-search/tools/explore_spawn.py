#!/usr/bin/env python3
"""P61 exploratory scan of the spawn-region collision component at 0.5 m.

Reports every enclosed island (hole) of the collision-passable mask, its world
bbox/area, what blocks its interior, and how many erosion layers it survives.
This decides whether the spawn region supports a car-width ring.

    python probes/lap-search/tools/explore_spawn.py
"""
from __future__ import annotations

import math
import sys
import time
from collections import deque
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
sys.path.insert(0, str(ROOT / "probes/lap-search/tools"))
import reference_oracle as oracle  # noqa: E402
from explore_components import (  # noqa: E402
    flatten_triangles, triangle_normals, rasterise_height, edge_max_dh,
    rasterise_wall, erode, label, holes_of,
)

PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
CELL = 0.5
SPAWN = (-88.0, 1050.0)
BBOX = (-134.0, 287.0, 814.0, 1324.0)   # P48 component bbox + 5 m


def main():
    t0 = time.time()
    level = oracle.load_level(PHYSICS.read_bytes())
    tris = flatten_triangles(level)
    nrm = triangle_normals(tris)
    surface = tris[nrm[:, 1] > 0.94]
    wall = tris[np.abs(nrm[:, 1]) < 0.5]
    x0, x1, z0, z1 = BBOX
    H, xs, zs = rasterise_height(surface, x0, x1, z0, z1, CELL)
    dh = edge_max_dh(H)
    W = rasterise_wall(wall, H, x0, x1, z0, z1, CELL, 0.5)
    edge_dh = min(0.05, 0.05 * CELL)
    base = np.isfinite(H) & (dh <= edge_dh + 1e-9) & ~W
    print("shape", H.shape, "base cells", int(base.sum()), "wall", int(W.sum()),
          "%.1fs" % (time.time() - t0))
    sj = int(round((SPAWN[1] - zs[0]) / CELL))
    si = int(round((SPAWN[0] - xs[0]) / CELL))

    lab, sizes = label(base, conn=8)
    sid = lab[sj, si]
    print("spawn label", sid, "size", sizes[sid - 1] if sid else None)
    comp = lab == sid
    hs = holes_of(lab, sid)
    print("base holes", len(hs))
    for h in hs[:12]:
        x0h, x1h, z0h, z1h = h["bbox"]
        print("  base hole size %d (%.0f m2) x %.1f..%.1f z %.1f..%.1f"
              % (h["size"], h["size"] * CELL * CELL,
                 xs[x0h], xs[x1h], zs[z0h], zs[z1h]))

    for k in (1, 2, 3, 4):
        m = erode(base, k)
        lab2, sizes2 = label(m, conn=8)
        sid2 = lab2[sj, si]
        if not sid2:
            print("erode", k, "spawn not in mask")
            continue
        hs2 = holes_of(lab2, sid2)
        print("erode %d (%.1f m): comp %d cells %d holes %d %s"
              % (k, k * CELL, sid2, sizes2[sid2 - 1], len(hs2),
                 [(h["size"], h["bbox"]) for h in hs2[:6]]))
        for h in hs2[:4]:
            x0h, x1h, z0h, z1h = h["bbox"]
            print("   hole size %d (%.0f m2) x %.1f..%.1f z %.1f..%.1f"
                  % (h["size"], h["size"] * CELL * CELL,
                     xs[x0h], xs[x1h], zs[z0h], zs[z1h]))

    # classify the interior of the largest base hole
    if hs:
        h = max(hs, key=lambda q: q["size"])
        x0h, x1h, z0h, z1h = h["bbox"]
        m = np.zeros_like(base)
        m[z0h:z1h + 1, x0h:x1h + 1] = True
        hole = m & ~comp
        masks = dict(no_surface=~np.isfinite(H), wall=W,
                     step_or_grade=np.isfinite(H) & ~W & (dh > edge_dh + 1e-9),
                     other=np.isfinite(H) & ~W & (dh <= edge_dh + 1e-9))
        for name, mm in masks.items():
            print("  largest hole interior %-14s %d cells" % (name, int((hole & mm).sum())))
    print("total %.1fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
