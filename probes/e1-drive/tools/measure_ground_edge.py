#!/usr/bin/env python3
"""Measure a per-arc ground edge for an already-built map layout.

River's 310 m line was re-centred and given a measured `course.groundEdge`
(see `recentre_layout.py`). The other playable maps still declare a fixed
respawn band (6 m, 12 m or 0.84 m) that is a *rule*, not the road: where the
height raster has no ground closer than that band, a human can drive off the
edge and fall.

This tool measures, for every layout sample, the distance to the first cell
without ground on each side (the void), and writes:

    course.groundEdge = {
      rule, halfWidthMetres, rows: [{arc, respawnHalfWidthMetres,
                                     voidLeftMetres, voidRightMetres}], source
    }

The page respawns at `min(declared band, respawnHalfWidthMetres) + margin`, so
the declared band still applies on a wide road and the measured edge takes over
where the road is narrower. Nothing is invented: every row comes from the
committed height raster.

The canonical `hash` is recomputed by `_work/finalise_layout_hash.mjs` (the JS
`hashOf`), not here, so the page and the registry agree byte for byte.

**Not wired in yet.** `map_package_builder.mjs --check` compares `layout.json`
byte for byte, so a hand-added field makes `verify_e1_map` fail. The tool is
committed for the follow-up that emits the field from the builder itself, and
it must only be applied to maps whose height raster is a single deck: on
Shutoko, Oval and Highrise a "no ground" cell is another deck, and the guard
confined the car to a narrow band (their solo scenarios timed out).

Usage:
  python probes/e1-drive/tools/measure_ground_edge.py \
      --layout _work/e1-drive/longbeach/layout.json \
      --grid _work/map-laps/longbeach/grid.npz
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/e1-drive/tools"))
import recentre_layout as R  # noqa: E402

INSET_METRES = 3.0
MIN_BAND = 2.0
MAX_BAND = 12.0


def build_rows(samples, H, xs, zs, sample_step):
    void = R.measure_void(samples, H, xs, zs)
    stride = max(1, int(round(1.0 / sample_step))) if sample_step else 4
    rows = []
    last = len(samples) - 1
    for index, (sample, (high, low)) in enumerate(zip(samples, void)):
        if index % stride and index != last:
            continue
        sides = [abs(value) for value in (high, low) if value is not None]
        band = min(min(sides) - INSET_METRES, MAX_BAND) if sides else MAX_BAND
        rows.append({
            "arc": sample["arc"],
            "respawnHalfWidthMetres": round(max(MIN_BAND, band), 3),
            "voidLeftMetres": None if high is None else round(abs(high), 3),
            "voidRightMetres": None if low is None else round(abs(low), 3),
        })
    return rows


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--layout", required=True)
    ap.add_argument("--grid", required=True)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)

    layout_path = ROOT / args.layout
    grid_path = ROOT / args.grid
    doc = json.loads(layout_path.read_text(encoding="utf-8"))
    grid = np.load(grid_path)
    H = grid["height"]
    xs, zs = grid["xs"], grid["zs"]
    samples = doc["course"]["samples"]
    step = doc["course"].get("sampleStepMetres") or 0.25

    rows = build_rows(samples, H, xs, zs, step)
    band = doc["course"].get("corridor", {}).get("halfWidthMetres")
    doc["course"]["groundEdge"] = {
        "rule": "per-arc half-width from the nearest ground edge (height raster, no ground = void), inset by 3 m and clamped to 2..12 m; the page respawns at min(declared band, this edge)",
        "halfWidthMetres": round(min(row["respawnHalfWidthMetres"] for row in rows), 3),
        "rows": rows,
        "source": {
            "grid": args.grid,
            "scanHalfMetres": R.VOID_SCAN_HALF_METRES,
            "scanStepMetres": R.SCAN_STEP,
            "insetMetres": INSET_METRES,
            "declaredBandMetres": band,
            "note": "measured ground edge, not a declared lane; the scripted sprint keeps the declared band",
        },
    }
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    if args.check:
        if layout_path.read_text(encoding="utf-8") != text:
            print("STALE " + args.layout)
            return 1
        print("OK %s %d rows" % (args.layout, len(rows)))
        return 0
    layout_path.write_text(text, encoding="utf-8")
    print("WROTE %s declared %.2f measured min %.2f (%d rows)"
          % (args.layout, band if band is not None else float("nan"),
             doc["course"]["groundEdge"]["halfWidthMetres"], len(rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
