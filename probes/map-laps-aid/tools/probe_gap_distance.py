"""Distance from a probe cell to the nearest surface hole (NaN height) in cells."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-laps/tools"))

CELL = 0.5
PROBES = {
    "hackney": (-227.278106, -133.764788),
    "brighton": (84.692995, -185.625677),
    "sausalito": (709.746329, -1434.611018),
    "russianhill": (-48.467753, 322.743199),
}

for map_id, (x, z) in PROBES.items():
    grid_path = ROOT / ("_work/map-laps/%s/grid.npz" % map_id)
    if not grid_path.is_file():
        print("%-12s no grid" % map_id)
        continue
    grid = np.load(grid_path)
    H = grid["height"]
    xs, zs = grid["xs"], grid["zs"]
    col = int(round((x - xs[0]) / CELL))
    row = int(round((z - zs[0]) / CELL))
    if not (0 <= row < H.shape[0] and 0 <= col < H.shape[1]):
        print("%-12s probe outside" % map_id)
        continue
    window = 6
    sub = H[max(0, row - window):row + window + 1, max(0, col - window):col + window + 1]
    holes = ~np.isfinite(sub)
    # Chebyshev distance from the probe cell to the nearest hole.
    best = None
    for dj in range(-window, window + 1):
        for di in range(-window, window + 1):
            r = window + dj
            c = window + di
            if 0 <= r < holes.shape[0] and 0 <= c < holes.shape[1] and holes[r, c]:
                d = max(abs(dj), abs(di))
                if best is None or d < best:
                    best = d
    print("%-12s centre=%s nearest hole cells=%s (%.2f m) holes in window=%d/%d"
          % (map_id,
             "nan" if not np.isfinite(H[row, col]) else "%.3f" % H[row, col],
             best, (best or 0) * CELL, int(holes.sum()), holes.size))
