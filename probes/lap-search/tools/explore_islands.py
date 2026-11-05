#!/usr/bin/env python3
"""P61: what are the two big islands made of, and how wide is the ring?

Reads _work/lap-search/_full05.npz, recomputes dh, and for each island >= 100 m2
reports interior composition (void / steep wall / step-grade) and the number of
erosion layers the island survives (ring half-width lower bound).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/lap-search/tools"))
from raster import label_components, enclosed_islands, erode, edge_max_dh  # noqa: E402

CELL = 0.5


def main():
    z = np.load(ROOT / "_work/lap-search/_full05.npz")
    base = z["base"]
    wall = z["wall"]
    H = z["height"].astype(np.float32)
    xs, zs = z["xs"], z["zs"]
    dh = edge_max_dh(H)
    lab, sizes = label_components(base, conn=8)
    isl = enclosed_islands(base, lab)
    big = [h for h in isl if h["size"] >= 400]
    for h in big:
        x0, x1, z0, z1 = h["bbox"]
        m = np.zeros(base.shape, dtype=bool)
        m[z0:z1 + 1, x0:x1 + 1] = True
        # island membership: background label == bgLabel
        # recompute labels for the island directly (bg is already labelled inside enclosed_islands)
        no_surface = ~np.isfinite(H)
        steep = wall
        step = np.isfinite(H) & ~wall & (dh > 0.025 + 1e-9)
        # island cells: use bbox + not foreground + not reachable from border is hard here;
        # approximate with the bbox complement whose cells are non-passable and connected.
        core = m & ~base
        print("island %d cells (%.0f m2) bbox x %.1f..%.1f z %.1f..%.1f owner %d"
              % (h["size"], h["size"] * CELL * CELL, xs[x0], xs[x1], zs[z0], zs[z1], h["owner"]))
        print("   bbox non-passable: no-surface %d, steep %d, step/grade %d, other %d"
              % (int((core & no_surface).sum()), int((core & steep).sum()),
                 int((core & step).sum()), int((core & ~no_surface & ~steep & ~step).sum())))


if __name__ == "__main__":
    main()
