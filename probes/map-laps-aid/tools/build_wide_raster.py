#!/usr/bin/env python3
"""Build a wider P48 passability raster for the blocked levels.

The committed P48 raster (`_work/map-laps/<map>/grid.npz`) rejects a cell when
the height step to a neighbour exceeds `min(STEP_LIMIT, GRADE_LIMIT * CELL)` =
**0.025 m** (a 5 % grade at 0.5 m cells). That is far stricter than the game: the
retail AI racing line itself crosses cells with a step of up to 0.176 m
(`probe_step_limit.py` measured p99 0.15 m, max 0.176 m on russianhill, 0.161 m
on brighton, 0.077 m on hackney).

This tool rebuilds the same raster with a documented wider rule:

    STEP_LIMIT_WIDE  = 0.20 m
    GRADE_LIMIT_WIDE = 0.40   (40 % at 0.5 m cells -> 0.20 m)

The bound is below the committed Corvette wheel radius (0.356 m, XT
`Corvette_ZR1_Stock`), so a wheel can climb the step. Nothing else changes: the
same triangles, the same surface/wall classification, the same wall dilation and
the same 0.5 m grid. The output is `_work/map-laps/<map>/grid-wide.npz` with the
same keys, so the existing path tools can read it unchanged.

Usage:
  python probes/map-laps-aid/tools/build_wide_raster.py [--map hackney]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-laps/tools"))

import longbeach_path_common as lb  # noqa: E402

STEP_LIMIT_WIDE = 0.20
GRADE_LIMIT_WIDE = 0.40
WHEEL_RADIUS_M = 0.356

MAPS = {
    "hackney": "uk_london_hackney",
    "brighton": "uk_brighton",
    "sausalito": "usa_sanfran_sausalito",
    "russianhill": "usa_sanfran_russianhill",
    "bowl": "spa_barcelona_bowl_multiplayer",
}


def build(map_id: str) -> Path:
    grid_path = ROOT / ("_work/map-laps/%s/grid.npz" % map_id)
    if not grid_path.is_file():
        raise SystemExit("%s: missing committed grid %s" % (map_id, grid_path))
    committed = np.load(grid_path)
    _path, _data, _parsed, tris = lb.load_static_triangles()
    raster = lb.build_raster(tris, lb.CELL, log=lambda *_: None,
                             step_limit=STEP_LIMIT_WIDE, grade_limit=GRADE_LIMIT_WIDE)
    out = ROOT / ("_work/map-laps/%s/grid-wide.npz" % map_id)
    np.savez_compressed(out, base=raster["base"], wall=raster["W"],
                        height=raster["H"].astype(np.float32),
                        dh=raster["dh"].astype(np.float32),
                        xs=raster["xs"], zs=raster["zs"])
    old_cells = int(committed["base"].sum())
    new_cells = int(raster["base"].sum())
    print("%-12s passable %d -> %d cells (+%.2f%%) edge_dh=%.3f m wheel=%.3f m"
          % (map_id, old_cells, new_cells,
             100.0 * (new_cells - old_cells) / max(1, old_cells),
             raster["edge_dh"], WHEEL_RADIUS_M))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--map", choices=sorted(MAPS), default=None)
    args = ap.parse_args(argv)
    for map_id in ([args.map] if args.map else sorted(MAPS)):
        build(map_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
