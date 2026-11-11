"""Does the draw-covered component's geodesic path carry the car band?

The five blocked levels were rejected because the retail `.aid` line does not
clear the car band on the P48 raster. The map-pipeline also measured a
draw-covered component (collision passable AND a draw triangle within 0.5 m):
hackney 776 m, brighton 975 m, russianhill 187 m. This probe asks the next
question — is that covered path itself band-clear at 0.25 m stations?

It does not write any artifact. It prints, per level: stations, band-clear
stations, the worst lateral clearance, and the largest cell step along the line.

  python probes/map-laps-aid/tools/probe_covered_band.py
"""

import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-laps/tools"))
sys.path.insert(0, str(ROOT / "probes/map-laps-aid/tools"))

from map_laps_common import CELL, HALF_WIDTH, SAFETY_MARGIN  # noqa: E402
from build_aid_paths import band_passable  # noqa: E402

LEVELS = {
    "hackney": ("uk_london_hackney", "_work/map-laps/hackney/grid.npz"),
    "brighton": ("uk_brighton", "_work/map-laps/brighton/grid.npz"),
    "russianhill": ("usa_sanfran_russianhill", "_work/map-laps/russianhill/grid.npz"),
}


def resample(points, step):
    out = []
    for index in range(len(points) - 1):
        x0, z0 = points[index]
        x1, z1 = points[index + 1]
        span = math.hypot(x1 - x0, z1 - z0)
        count = max(1, int(math.ceil(span / step)))
        for k in range(count):
            t = k / count
            out.append((x0 + (x1 - x0) * t, z0 + (z1 - z0) * t))
    out.append(points[-1])
    return out


def main():
    for name, (level, grid_rel) in LEVELS.items():
        covered = json.loads((ROOT / ("_work/map-pipeline/covered/%s-path.json" % level))
                             .read_text(encoding="utf-8"))
        points = [(p["x"], p["z"]) for p in covered["samples"]]
        grid = np.load(ROOT / grid_rel)
        base, H, xs, zs = grid["base"], grid["height"], grid["xs"], grid["zs"]
        line = resample(points, 0.25)
        clear = 0
        worst = None
        worst_at = None
        max_step = 0.0
        for index in range(1, len(line) - 1):
            x, z = line[index]
            ax, az = line[index - 1]
            bx, bz = line[index + 1]
            tx, tz = bx - ax, bz - az
            norm = math.hypot(tx, tz) or 1.0
            ok = band_passable(base, xs, zs, x, z, tx / norm, tz / norm)
            if ok:
                clear += 1
            else:
                i = int(round((x - xs[0]) / CELL))
                j = int(round((z - zs[0]) / CELL))
                inside = 0 <= j < base.shape[0] and 0 <= i < base.shape[1]
                if inside and np.isfinite(H[j, i]):
                    step = abs(float(H[j, i]) - float(H[max(0, j - 1), i]))
                    if step > max_step:
                        max_step = step
                if worst is None:
                    worst, worst_at = index, (round(x, 2), round(z, 2))
        print("%-12s stations %5d  band-clear %5d (%.1f%%)  first-fail %s  maxStep %.4f m"
              % (name, len(line) - 2, clear, 100.0 * clear / max(1, len(line) - 2),
                 worst_at, max_step))


if __name__ == "__main__":
    main()
