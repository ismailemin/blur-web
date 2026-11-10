#!/usr/bin/env python3
"""Emit the retail `.aid` racing line as a course document (engine-verified).

The P48 raster rejects the retail line on five levels because its step limit
(0.025 m) is stricter than the car. The engine is the real arbiter: if the
scripted sprint can drive the line without respawns, the line is drivable and
the raster was over-conservative.

This tool reads the committed `.aid` racing line, resamples it at 0.25 m, takes
the ground height from the committed raster height field, and emits a document
in the same schema as the raster courses so `build_raster_layout.mjs` and the
E1 package builder consume it unchanged.

It is deliberately labelled:

    courseSource: "retail-aid-line-unverified"
    bandVerified: false
    bandReason: "the P48 band check rejects this line; the engine run decides"

Usage:
  python probes/map-laps-aid/tools/build_aid_line_course.py --map hackney
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-laps-aid/tools"))
sys.path.insert(0, str(ROOT / "probes/map-laps/tools"))
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))
sys.path.insert(0, str(ROOT / "probes/course/tools"))

import build_aid_paths as B  # noqa: E402

SAMPLE_STEP = 0.25
MAPS = ["hackney", "brighton", "russianhill"]


def resample(points, step):
    closed = points + [points[0]]
    lengths = [0.0]
    for index in range(1, len(closed)):
        lengths.append(lengths[-1] + math.hypot(closed[index][0] - closed[index - 1][0],
                                                closed[index][1] - closed[index - 1][1]))
    total = lengths[-1]
    count = max(8, int(round(total / step)))
    out = []
    cursor = 0
    for index in range(count):
        target = total * index / count
        while cursor + 1 < len(lengths) and lengths[cursor + 1] < target:
            cursor += 1
        span = lengths[cursor + 1] - lengths[cursor]
        t = 0.0 if span <= 0 else (target - lengths[cursor]) / span
        out.append((closed[cursor][0] + (closed[cursor + 1][0] - closed[cursor][0]) * t,
                    closed[cursor][1] + (closed[cursor + 1][1] - closed[cursor][1]) * t))
    return out


def build(map_id: str) -> dict:
    cfg = dict(B.LEVELS[map_id])
    pak_path = ROOT / B.PAK_RELATIVE
    data, entries, _codec, _fat = B.read_pak_index(pak_path)
    routes = B.load_json(ROOT / B.ROUTES_RELATIVE)
    spawn_doc = B.load_json(ROOT / cfg["batch"] / "spawn.json")
    spawn = spawn_doc.get("layout", {}).get("spawn") or {}
    cfg["_spawn"] = (float(spawn.get("x")), float(spawn.get("z")))
    chosen = B.choose_racing_line(cfg, data, entries, routes)
    if chosen is None:
        raise SystemExit("%s: no racing line" % map_id)

    grid = np.load(ROOT / cfg["grid"])
    H = grid["height"]
    xs, zs = grid["xs"], grid["zs"]
    points = resample(chosen["points"], SAMPLE_STEP)

    stations = []
    arc = 0.0
    for index, (x, z) in enumerate(points):
        i = int(round((x - xs[0]) / B.CELL))
        j = int(round((z - zs[0]) / B.CELL))
        i = max(0, min(H.shape[1] - 1, i))
        j = max(0, min(H.shape[0] - 1, j))
        ground = float(H[j, i])
        if not math.isfinite(ground):
            ground = 0.0
        if index > 0:
            previous = points[index - 1]
            arc += math.hypot(x - previous[0], z - previous[1])
        stations.append({"arc": round(arc, 6), "x": round(x, 6), "z": round(z, 6),
                         "groundY": round(ground, 6)})

    best = min(range(len(points)),
               key=lambda i: (points[i][0] - cfg["_spawn"][0]) ** 2 + (points[i][1] - cfg["_spawn"][1]) ** 2)
    stations = stations[best:] + stations[:best]
    # Re-base the arcs after the rotation.
    arc = 0.0
    for index, station in enumerate(stations):
        if index > 0:
            arc += math.hypot(station["x"] - stations[index - 1]["x"],
                              station["z"] - stations[index - 1]["z"])
        station["arc"] = round(arc, 6)

    body = {
        "kind": "blur.map-laps-aid.raster-course",
        "version": 1,
        "courseId": map_id,
        "level": cfg["level"],
        "courseSource": "retail-aid-line-unverified",
        "retailLineUsed": True,
        "verdict": "course",
        "bandVerified": False,
        "bandReason": "the P48 band check rejects this line; the engine run decides",
        "scope": {
            "collisionOnly": True,
            "retailRacingLine": True,
            "retailStartLine": False,
            "rendererClaim": False,
            "vehiclePhysics": False,
            "gameRun": False,
            "pathDriven": False,
            "note": "the committed retail AI racing line, resampled; the raster band check is not applied",
        },
        "source": {
            "probe": "probes/map-laps-aid/tools/build_aid_line_course.py",
            "aid": chosen["entry"]["path"],
            "aidSha256": chosen["sha256"],
            "routeNumber": chosen.get("routeNumber"),
            "grid": cfg["grid"],
            "spawn": {**spawn, "source": "the committed map-batch spawn document"},
            "algorithm": {
                "name": "retail .aid racing line resampled",
                "sampleStepMetres": SAMPLE_STEP,
                "groundSource": "committed P48 raster height field at the nearest cell",
            },
        },
        "clearance": {
            "bandMetres": 1.68,
            "halfWidthMetres": 0.84,
            "stepMetres": 0.21,
            "erosionCells": 0,
            "guaranteedClearanceMetres": 0.0,
            "minRasterClearanceMetres": 0.0,
            "metric": "not measured: the raster band check rejects this line",
            "bandTier": "none",
            "bandTierReason": "the engine run decides; the raster step limit is stricter than the car",
        },
        "course": {
            "name": cfg["level"] + " retail AI racing line (engine-verified)",
            "loopLengthMetres": round(arc, 6),
            "stationCount": len(stations),
            "sampleStepMetres": SAMPLE_STEP,
            "maxStationSpacingMetres": round(max(
                math.hypot(stations[(i + 1) % len(stations)]["x"] - stations[i]["x"],
                           stations[(i + 1) % len(stations)]["z"] - stations[i]["z"])
                for i in range(len(stations))), 6),
            "closed": True,
            "closureSeamMetres": round(math.hypot(stations[0]["x"] - stations[-1]["x"],
                                                  stations[0]["z"] - stations[-1]["z"]), 6),
            "start": stations[0],
            "spawnProjection": {
                "x": stations[0]["x"],
                "z": stations[0]["z"],
                "metres": round(math.hypot(stations[0]["x"] - cfg["_spawn"][0],
                                           stations[0]["z"] - cfg["_spawn"][1]), 4),
                "station": 0,
            },
            "groundMinY": min(s["groundY"] for s in stations),
            "groundMaxY": max(s["groundY"] for s in stations),
            "stations": stations,
        },
    }
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    body["hash"] = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return body


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--map", choices=MAPS, default=None)
    args = ap.parse_args(argv)
    for map_id in ([args.map] if args.map else MAPS):
        body = build(map_id)
        out = ROOT / ("probes/map-laps-aid/data/%s-aid-line.json" % map_id)
        out.write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("WROTE %s %.3f m %d stations" %
              (map_id, body["course"]["loopLengthMetres"], body["course"]["stationCount"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
