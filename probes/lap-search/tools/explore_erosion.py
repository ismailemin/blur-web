#!/usr/bin/env python3
"""P61: does an island survive k layers of clearance erosion?

Uses the saved full-level 0.5 m rasters from explore_full05.py. A surviving
enclosed island after k 8-connected erosions means a ring of free surface at
least k cells (k*0.5 m) from every non-passable cell winds around that island.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/lap-search/tools"))
from raster import label_components, enclosed_islands, erode  # noqa: E402

CELL = 0.5
SPAWN = (-88.0, 1050.0)


def main():
    t0 = time.time()
    z = np.load(ROOT / "_work/lap-search/_full05.npz")
    base = z["base"]
    xs, zs = z["xs"], z["zs"]
    sj = int(round((SPAWN[1] - zs[0]) / CELL))
    si = int(round((SPAWN[0] - xs[0]) / CELL))
    print("raster", base.shape, "base cells", int(base.sum()))
    lab, sizes = label_components(base, conn=8)
    print("spawn label", lab[sj, si], "size", sizes[lab[sj, si] - 1])
    for k in range(0, 7):
        m = erode(base, k) if k else base
        lab, sizes = label_components(m, conn=8)
        isl = enclosed_islands(m, lab)
        big = [h for h in isl if h["size"] >= 100]
        print("k=%d (clearance %.1f m): foreground %d cells, comps %d, islands %d, >=100cells %d"
              % (k, k * CELL, int(m.sum()), len(sizes), len(isl), len(big)))
        for h in big[:10]:
            cid = h["owner"]
            x0h, x1h, z0h, z1h = h["bbox"]
            print("   island %6d cells (%5.0f m2) comp %3d (%6d cells) x %7.1f..%7.1f z %7.1f..%7.1f"
                  % (h["size"], h["size"] * CELL * CELL, cid,
                     sizes[cid - 1] if cid else 0,
                     xs[x0h], xs[x1h], zs[z0h], zs[z1h]))
        print("   spawn comp", lab[sj, si], "size", sizes[lab[sj, si] - 1] if lab[sj, si] else 0)
    print("total %.1fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
