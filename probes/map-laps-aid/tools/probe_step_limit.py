"""Measure the step/grade rejection along the retail racing line.

For each blocked level, this reads the committed `.aid` racing line and the
committed P48 raster, and reports the distribution of the cell step `dh` along
the line. The P48 passability rule rejects a cell when `dh > 0.025 m`
(STEP_LIMIT 0.05 m, GRADE_LIMIT 0.05 at 0.5 m cells). This tool answers one
question: how much wider would the step limit have to be for the retail line to
be passable, and is that a small step or a real wall?

Read-only diagnostic. It writes nothing.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-laps-aid/tools"))
sys.path.insert(0, str(ROOT / "probes/map-laps/tools"))
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))
sys.path.insert(0, str(ROOT / "probes/course/tools"))

import build_aid_paths as B  # noqa: E402

MAPS = ["hackney", "brighton", "sausalito", "russianhill"]


def main() -> int:
    pak_path = ROOT / B.PAK_RELATIVE
    data, pak_index, _codec, _fat = B.read_pak_index(pak_path)
    routes = B.load_json(ROOT / B.ROUTES_RELATIVE)
    for map_id in MAPS:
        cfg = dict(B.LEVELS[map_id])
        spawn_doc = B.load_json(ROOT / cfg["batch"] / "spawn.json")
        layout = spawn_doc.get("layout") or {}
        spawn = layout.get("spawn") or {}
        cfg["_spawn"] = (float(spawn.get("x")), float(spawn.get("z")))
        chosen = B.choose_racing_line(cfg, data, pak_index, routes)
        if chosen is None:
            print("%-12s no racing line" % map_id)
            continue
        grid = np.load(ROOT / cfg["grid"])
        dh = grid["dh"]
        xs, zs = grid["xs"], grid["zs"]
        points = chosen["points"]
        values = []
        for x, z in points:
            i = int(round((x - xs[0]) / B.CELL))
            j = int(round((z - zs[0]) / B.CELL))
            if 0 <= j < dh.shape[0] and 0 <= i < dh.shape[1]:
                values.append(float(dh[j, i]))
        arr = np.asarray(values)
        finite = arr[np.isfinite(arr)]
        edge_dh = min(B.STEP_LIMIT, B.GRADE_LIMIT * B.CELL)
        over = int((arr > edge_dh + 1e-9).sum())
        print("%-12s stations=%d over025=%d (%.2f%%) p50=%.4f p90=%.4f p99=%.4f max=%s"
              % (map_id, len(arr), over, 100.0 * over / max(1, len(arr)),
                 float(np.percentile(finite, 50)) if finite.size else float("nan"),
                 float(np.percentile(finite, 90)) if finite.size else float("nan"),
                 float(np.percentile(finite, 99)) if finite.size else float("nan"),
                 ("%.4f" % finite.max()) if finite.size else "nan"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
