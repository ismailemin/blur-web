"""Measure whether a wider 5-point cell sampling makes the failing stations passable.

Read-only diagnostic. It re-uses the committed triangle loader and the committed
surface/wall classification, and only changes the height sampling rule: a cell is
covered when its centre OR any of its four corners lies on a surface triangle.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-laps/tools"))
sys.path.insert(0, str(ROOT / "probes/lap-search/tools"))

import longbeach_path_common as lb  # noqa: E402
from raster import triangle_normals, edge_max_dh, rasterise_wall  # noqa: E402

CELL = 0.5
SURFACE_MIN_NY = lb.SURFACE_MIN_NY
STEP_LIMIT = lb.STEP_LIMIT
GRADE_LIMIT = lb.GRADE_LIMIT
WALL_DILATE = lb.WALL_DILATE

LEVELS = {
    "hackney": ("uk_london_hackney", (-227.278106, -133.764788)),
    "brighton": ("uk_brighton", (84.692995, -185.625677)),
    "sausalito": ("usa_sanfran_sausalito", (709.746329, -1434.611018)),
    "russianhill": ("usa_sanfran_russianhill", (-48.467753, 322.743199)),
    "bowl": ("spa_barcelona_bowl_multiplayer", (0.0, 0.0)),
}


def rasterise_height_wide(tris, x0, x1, z0, z1, cell):
    """Max surface height per cell over the centre and the four cell corners."""
    nx = int(round((x1 - x0) / cell)) + 1
    nz = int(round((z1 - z0) / cell)) + 1
    H = np.full((nz, nx), -np.inf)
    xs = x0 + np.arange(nx) * cell
    zs = z0 + np.arange(nz) * cell
    offsets = [(0.0, 0.0), (-0.5, -0.5), (-0.5, 0.5), (0.5, -0.5), (0.5, 0.5)]
    for t in tris:
        a, b, c = t
        den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
        if abs(den) < 1e-12:
            continue
        i0 = max(0, int(np.floor((min(a[0], b[0], c[0]) - x0) / cell)) - 1)
        i1 = min(nx - 1, int(np.ceil((max(a[0], b[0], c[0]) - x0) / cell)) + 1)
        j0 = max(0, int(np.floor((min(a[2], b[2], c[2]) - z0) / cell)) - 1)
        j1 = min(nz - 1, int(np.ceil((max(a[2], b[2], c[2]) - z0) / cell)) + 1)
        if i1 < i0 or j1 < j0:
            continue
        gx, gz = np.meshgrid(xs[i0:i1 + 1], zs[j0:j1 + 1])
        for ox, oz in offsets:
            px = gx + ox * cell
            pz = gz + oz * cell
            l1 = ((b[2] - c[2]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[2])) / den
            l2 = ((c[2] - a[2]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[2])) / den
            l3 = 1.0 - l1 - l2
            m = (l1 >= -1e-9) & (l2 >= -1e-9) & (l3 >= -1e-9)
            if not m.any():
                continue
            h = l1 * a[1] + l2 * b[1] + l3 * c[1]
            sub = H[j0:j1 + 1, i0:i1 + 1]
            sub[m] = np.maximum(sub[m], h[m])
    H[~np.isfinite(H)] = np.nan
    return H, xs, zs


def main() -> int:
    for map_id, (level, probe) in LEVELS.items():
        grid_path = ROOT / ("_work/map-laps/%s/grid.npz" % map_id)
        if not grid_path.is_file():
            print("%-12s no grid" % map_id)
            continue
        grid = np.load(grid_path)
        base = grid["base"].astype(bool)
        xs, zs = grid["xs"], grid["zs"]
        H0 = grid["height"]
        col = int(round((probe[0] - xs[0]) / CELL))
        row = int(round((probe[1] - zs[0]) / CELL))
        if not (0 <= row < base.shape[0] and 0 <= col < base.shape[1]):
            print("%-12s probe outside the raster" % map_id)
            continue
        old = bool(base[row, col])
        # Wide rule over a small window around the probe.
        win = 3
        x0 = xs[max(0, col - win)]
        x1 = xs[min(len(xs) - 1, col + win)]
        z0 = zs[max(0, row - win)]
        z1 = zs[min(len(zs) - 1, row + win)]
        tris = lb.load_static_triangles()[3]
        nrm = triangle_normals(tris)
        surface = tris[nrm[:, 1] > SURFACE_MIN_NY]
        wall = tris[np.abs(nrm[:, 1]) < 0.5]
        Hw, wxs, wzs = rasterise_height_wide(surface, x0, x1, z0, z1, CELL)
        dh = edge_max_dh(Hw)
        W = rasterise_wall(wall, Hw, x0, x1, z0, z1, CELL, WALL_DILATE)
        edge_dh = min(STEP_LIMIT, GRADE_LIMIT * CELL)
        wide = np.isfinite(Hw) & (dh <= edge_dh + 1e-9) & ~W
        wc = int(round((probe[0] - wxs[0]) / CELL))
        wr = int(round((probe[1] - wzs[0]) / CELL))
        new = bool(wide[wr, wc]) if (0 <= wr < wide.shape[0] and 0 <= wc < wide.shape[1]) else None
        print("%-12s old=%-5s wide=%-5s height=%s dh=%.4f"
              % (map_id, old, new,
                 "nan" if not np.isfinite(H0[row, col]) else "%.4f" % H0[row, col],
                 float(dh[wr, wc]) if new is not None else float("nan")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
