#!/usr/bin/env python3
"""Emit the layout hand-off for the best candidate loop of a map.

The hand-off is a data record, not an integration: it names the loop, the start
line (also the finish line, because the loop is closed), the heading, two
checkpoint stations at one third and two thirds of the lap, the per-gate ground
and measured flat band, and the exact fields `sprint-layout.js` needs to build a
lap course. Nothing is copied into `probes/e1-drive`.

    python probes/map-laps/tools/build_map_layout.py --level usa_amboy
    python probes/map-laps/tools/build_map_layout.py --level spa_barcelona_gracia
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from map_laps_common import (  # noqa: E402
    ROOT, CAR_WIDTH, SAFETY_MARGIN, LOOP_ERODE, flat_band_width,
)

LAPS = 3
GATE_HALF_WIDTH = 2.0          # 4 m start/finish line, as in the River lap layout
TANGENT_WINDOW_M = 5.0
SAMPLE_STEP = 0.25


def arc_table(points):
    arc = [0.0]
    for a, b in zip(points, points[1:]):
        arc.append(arc[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    return arc


def tangent_at(points, arc, index, window=TANGENT_WINDOW_M):
    n = len(points) - 1                     # unique ring
    half = max(1, int(round(window / 2 / SAMPLE_STEP)))
    a = points[(index - half) % n]
    b = points[(index + half) % n]
    tx, tz = b[0] - a[0], b[1] - a[1]
    l = math.hypot(tx, tz) or 1.0
    return tx / l, tz / l, round(2 * half * SAMPLE_STEP, 3)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", required=True)
    ap.add_argument("--loop", default=None, help="loop id (default: recommended)")
    ap.add_argument("--dir", type=Path)
    args = ap.parse_args(argv)
    base_dir = args.dir or (ROOT / "_work/map-laps" / args.level)
    doc = json.loads((base_dir / "loops.json").read_text(encoding="utf-8"))
    cov_path = base_dir / "coverage.json"
    cov = json.loads(cov_path.read_text(encoding="utf-8")) if cov_path.exists() else None

    loop_id = args.loop or doc.get("bestLoop")
    if not loop_id:
        raise SystemExit("no recommended loop in %s" % (base_dir / "loops.json"))
    loop = next((q for q in doc["loops"] if q["id"] == loop_id), None)
    if loop is None:
        raise SystemExit("loop %s not in loops.json" % loop_id)

    grid = np.load(base_dir / "grid.npz")
    base, xs, zs = grid["base"], grid["xs"], grid["zs"]
    cell = float(xs[1] - xs[0])

    pts = loop["points"]
    ground = loop["ground"]
    n = len(pts) - 1
    arc = arc_table(pts)
    length = arc[-1]
    if abs(length - loop["length"]) > 0.05:
        raise SystemExit("arc %.4f != recorded length %.4f" % (length, loop["length"]))

    band_min, band_at = flat_band_width(pts, base, xs, zs, cell)
    if band_min is None:
        raise SystemExit("could not measure the band")

    verify_path = base_dir / "verify.json"
    exact_band = None
    if verify_path.exists():
        vdoc = json.loads(verify_path.read_text(encoding="utf-8"))
        vloop = next((q for q in vdoc["loops"] if q["id"] == loop_id), None)
        if vloop:
            exact_band = vloop["metrics"]["minBandWidth"]

    def station(index, kind, label, arc_value, is_line):
        x, z = pts[index]
        tx, tz, window = tangent_at(pts, arc, index)
        heading = math.atan2(tx, tz)
        nx, nz = -tz, tx
        half = GATE_HALF_WIDTH
        line = [[round(x - nx * half, 4), round(z - nz * half, 4)],
                [round(x + nx * half, 4), round(z + nz * half, 4)]]
        g = ground[index]
        return dict(kind=kind, label=label, sampleIndex=int(index),
                    arcM=round(arc_value, 4), x=round(x, 4), z=round(z, 4),
                    groundY=g, headingRad=round(heading, 9),
                    tangent=[round(tx, 9), round(tz, 9)],
                    tangentWindowM=window,
                    line=line if is_line else None,
                    halfWidthM=half if is_line else None)

    i1 = int(round((length / 3.0) / SAMPLE_STEP))
    i2 = int(round((2.0 * length / 3.0) / SAMPLE_STEP))
    gates = [
        station(0, "start", "start", 0.0, True),
        station(i1, "checkpoint", "checkpoint-1", arc[i1], False),
        station(i2, "checkpoint", "checkpoint-2", arc[i2], False),
        station(0, "finish", "finish", length, True),
    ]
    gates[3]["arcM"] = round(length, 4)

    gate_band = []
    for g in gates:
        b, at = flat_band_width([pts[g["sampleIndex"]], pts[(g["sampleIndex"] + 1) % n]],
                                base, xs, zs, cell, reach=10.0)
        at_cap = b is not None and b >= 19.9
        gate_band.append(dict(label=g["label"],
                              clearanceBandAtStationM=(None if at_cap else round(b, 2)),
                              atCap=bool(at_cap), capM=20.0))

    cov_loop = None
    if cov:
        cov_loop = next((q for q in cov["loops"] if q["id"] == loop_id), None)

    layout = dict(
        kind="map-laps.layout",
        version=1,
        level=args.level,
        scope=dict(
            dataOnly=True,
            rendererClaim=False,
            vehiclePhysics=False,
            gameRun=False,
            note=("a loop layout record, not an e1-drive integration: no gate mesh, "
                  "no race director, no lap timing"),
        ),
        loop=dict(id=loop["id"], lengthM=loop["length"], samples=n + 1,
                  stepM=SAMPLE_STEP, component=loop["component"],
                  erodeCells=loop["erodeCells"], tight=loop["tight"],
                  clearanceLowerBoundM=loop["clearanceLowerBoundM"],
                  islandIndex=loop["islandIndex"],
                  islandAreaM2=doc["islands"][loop["islandIndex"]]["island"]["areaM2"],
                  islandBlockedBy=doc["islands"][loop["islandIndex"]]["island"]["blockedBy"],
                  islandSurvivesErosion=doc["islands"][loop["islandIndex"]]["survivesErosion"]),
        laps=LAPS,
        totalRaceDistanceM=round(length * LAPS, 4),
        start=dict(x=pts[0][0], z=pts[0][1], groundY=ground[0],
                   headingRad=gates[0]["headingRad"],
                   headingSource="5 m tangent window across the closure seam"),
        finish=dict(x=pts[0][0], z=pts[0][1], groundY=ground[0],
                    headingRad=gates[0]["headingRad"], arcM=round(length, 4),
                    note="closed loop: the finish line is the start line"),
        gates=gates,
        gateBands=gate_band,
        band=dict(
            exactFlatBandM=exact_band,
            exactFlatBandSource="verify.json minBandWidth (0.25 m stations, |dh| <= 0.20 m, 16 m cap)",
            rasterClearanceBandM=round(band_min, 2),
            rasterClearanceBandAtSample=int(band_at),
            rasterClearanceBandNote=("narrowest perpendicular run of P48-passable cells on the "
                                     "loop line, island side included; a conservative bound"),
            roadHalfWidthAvailableM=(round((exact_band - (CAR_WIDTH + 2 * SAFETY_MARGIN)) / 2.0, 3)
                                     if exact_band else None),
        ),
        respawnBandHalfWidthM=(round(min(1.25, max(0.0, (exact_band - (CAR_WIDTH + 2 * SAFETY_MARGIN)) / 2.0)), 3)
                               if exact_band else 0.0),
        respawnBandNote=("1.25 m is the River P67 measured driven lateral bound and is only a "
                         "declared respawn rule here: no lap has been driven on this map"),
        measurements=dict(
            minFlatBandM=exact_band,
            minRasterClearanceBandM=round(band_min, 2),
            maxStepRasterM=loop["maxStep"], maxGradeRaster=loop["maxGrade"],
            minRasterClearanceM=loop["minClearance"],
            groundRangeM=loop["groundRange"],
            carEnvelope=doc["inputs"]["carEnvelope"],
            drawCoverageFraction=(cov_loop["fraction"] if cov_loop else None),
            drawCoverageGapRuns=(cov_loop["gapRuns"] if cov_loop else None),
            drawCoverageMaxDeltaM=(cov_loop["deltaMax"] if cov_loop else None),
            drawCoverageRule=(cov["inputs"]["rule"] if cov else None),
        ),
        evidence=dict(
            loopsJson="sha256:" + doc["hash"].split(":", 1)[1],
            loopsPath="_work/map-laps/%s/loops.json" % args.level,
            verifyPath="_work/map-laps/%s/verify.json" % args.level,
            coveragePath=("_work/map-laps/%s/coverage.json" % args.level if cov else None),
            engineTracePath="_work/map-laps/%s/engine-trace.json" % args.level,
            physicsSha256=doc["inputs"]["physics"]["sha256"],
        ),
        integration=dict(
            integrated=False,
            needed=[
                "probes/e1-drive/web/sprint-layout.js pins one River loops.json "
                "(LAP_LOOPS_PATH) and loop-01/component 5; a per-map pin and a "
                "per-map deriveLapCourseLayout call are required",
                "e1-drive builds its packet and sprint layout from River; the map "
                "slice package needs a per-map geometry packet (map id + draw ranges)",
                "the engine ground probe e1_ground_probe starts its ray at y = 130.0; "
                "it misses a road at that height, so a vertical e1_ray_probe from the "
                "raster ground is used here (documented, not a synthetic ground)",
                "gate lines are rules geometry only; no gate mesh, start banner or "
                "race director exists for this map",
                "no lap timing, respawn or off-course rule is implemented for these maps",
                "props/power-ups/colliders are not measured by this probe",
            ],
            missingData=[
                "retail start-line / route record for the map (Level.levelphysics has a "
                "route count but routes are not parsed by the committed scanner)",
                "draw coverage of the gate lines at their full 4 m width (coverage.json "
                "measured 0 / +/-1 m stations only)",
                "decoded InstancedTriangleMesh collision shapes (excluded from the raster)",
            ],
        ),
    )
    body = json.dumps(layout, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    import hashlib
    layout["hash"] = "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
    (base_dir / "layout.json").write_text(json.dumps(layout, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({
        "level": args.level, "loop": loop_id, "lengthM": loop["length"],
        "laps": LAPS, "start": [pts[0][0], pts[0][1]],
        "headingRad": gates[0]["headingRad"],
        "exactFlatBandM": exact_band,
        "rasterClearanceBandM": round(band_min, 2),
        "drawCoverage": layout["measurements"]["drawCoverageFraction"],
        "hash": layout["hash"],
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
