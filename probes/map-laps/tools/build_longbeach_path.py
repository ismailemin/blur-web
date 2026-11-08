#!/usr/bin/env python3
"""Build the committed collision-clear point-to-point path for Long Beach.

The input is the committed collision data:

  game-data/Blur/levels/usa_la_longbeachdocks/Level.levelphysics   (read-only)
  _work/e1-drive/longbeach/layout.json   the committed draw-covered path; used
                                          only as the corridor centre line

and the output is `probes/map-laps/data/longbeach-path.json`, an
`e1-drive.sprint` v1 document with `courseId: "longbeach"`, the same schema the
driving slice consumes for `_work/e1-drive/longbeach/layout.json`.

The path is not the draw path. It is an A* line on the P48 passability raster
eroded by 8 cells (>= 4.0 m clearance) inside a 10-cell (5.0 m) corridor around
the committed draw path, simplified with a 0.25 m line-of-sight check and
resampled at 0.25 m. Every sample, gate and ground value therefore comes from
the collision raster.

    python probes/map-laps/tools/build_longbeach_path.py
    python probes/map-laps/tools/build_longbeach_path.py --check
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from longbeach_path_common import (  # noqa: E402
    ROOT, LEVEL, MAP_ID, PHYSICS, STATIC_TRIANGLES, START, FINISH,
    START_HEADING, FINISH_HEADING, SAMPLE_STEP, CLEARANCE_CELLS,
    CORRIDOR_CELLS, CORRIDOR_PENALTY, GATE_HALF_WIDTH, BAND_HALF_WIDTH,
    CORRIDOR_HALF_WIDTH, TANGENT_WINDOW, CAR_CIRCUMRADIUS, STOP_POSE,
    OBSTRUCTION_SEGMENTS, DRAW_LAYOUT, GRID_PATH, OUT_PATH,
    CELL, HALF_WIDTH, HALF_LENGTH, CAR_LENGTH, CAR_WIDTH, SAFETY_MARGIN,
    load_json, file_sha256, canonical_hash, num, cell_of, build_path,
)

DEFAULT_OUT = ROOT / OUT_PATH


def arc_table(points):
    arc = [0.0]
    for a, b in zip(points, points[1:]):
        arc.append(arc[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    return arc


def tangent_at(points, index, window=TANGENT_WINDOW):
    """5 m window tangent; clamped at the open path's ends."""
    half = max(1, int(round(window / 2.0 / SAMPLE_STEP)))
    if index == 0:
        a = points[0]
        b = points[min(len(points) - 1, half * 2)]
    elif index == len(points) - 1:
        a = points[max(0, len(points) - 1 - half * 2)]
        b = points[-1]
    else:
        a = points[max(0, index - half)]
        b = points[min(len(points) - 1, index + half)]
    tx, tz = b[0] - a[0], b[1] - a[1]
    length = math.hypot(tx, tz) or 1.0
    return tx / length, tz / length, round(min(window,
        math.hypot(b[0] - a[0], b[1] - a[1])), 3)


def line_side(a, b, point):
    return (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])


def gate_line(x, z, tx, tz, half_width, approach):
    nx, nz = -tz, tx
    a = [x - nx * half_width, z - nz * half_width]
    b = [x + nx * half_width, z + nz * half_width]
    if line_side(a, b, approach) <= 0:
        a, b = b, a
    return a, b


def raster_check(base, height, xs, zs, x, z, tx, tz, ground,
                 half_width=GATE_HALF_WIDTH):
    cell = float(xs[1] - xs[0])
    nz, nx = base.shape

    def cell_of_point(px, pz):
        return (int(math.floor((px - xs[0]) / cell + 0.5)),
                int(math.floor((pz - zs[0]) / cell + 0.5)))

    i, j = cell_of_point(x, z)
    inside = 0 <= i < nx and 0 <= j < nz
    passable = bool(inside and base[j, i])
    raster_height = float(height[j, i]) if inside else None

    nxv, nzv = -tz, tx
    stations = []
    steps = int(round(half_width / SAMPLE_STEP))
    for k in range(-steps, steps + 1):
        d = k * SAMPLE_STEP
        ii, jj = cell_of_point(x + nxv * d, z + nzv * d)
        ok = 0 <= ii < nx and 0 <= jj < nz and bool(base[jj, ii])
        stations.append((d, ok))
    car_stations = [ok for d, ok in stations if abs(d) <= HALF_WIDTH + 1e-9]

    return {
        "rasterCell": [i, j],
        "passable": passable,
        "rasterHeightM": num(raster_height, 6) if raster_height is not None else None,
        "groundY": num(ground, 4),
        "groundDeltaM": (num(abs(raster_height - ground), 4)
                         if raster_height is not None else None),
        "lineStations": len(stations),
        "linePassableStations": sum(1 for _, ok in stations if ok),
        "carHalfWidthStations": len(car_stations),
        "carHalfWidthPassable": bool(car_stations) and all(car_stations),
        "source": ("P48 passable raster (grid.npz base) at 0.5 m; gate line "
                   "stations at 0.25 m"),
    }


def segment_distance(px, pz, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az
    l2 = dx * dx + dz * dz
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / l2))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


def obstruction_distance(points):
    best = (1e18, None, None)
    for index, (x, z) in enumerate(points):
        for seg in OBSTRUCTION_SEGMENTS:
            d = segment_distance(x, z, seg["a"][0], seg["a"][1],
                                 seg["b"][0], seg["b"][1])
            if d < best[0]:
                best = (d, index, (x, z))
    return best


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--clearance-cells", type=int, default=CLEARANCE_CELLS,
                    help="8-connected clearance erosion in 0.5 m cells (default %d)"
                         % CLEARANCE_CELLS)
    ap.add_argument("--corridor-cells", type=int, default=CORRIDOR_CELLS,
                    help="draw-path corridor half-width in 0.5 m cells (default %d)"
                         % CORRIDOR_CELLS)
    ap.add_argument("--check", action="store_true",
                    help="compare the generated document with --out; exit 1 if it differs")
    args = ap.parse_args(argv)

    def log(msg):
        print(msg, flush=True)

    (samples_xy, world, cells, mask, dist, grid, draw_doc, phys_path,
     phys_bytes, parsed, tris, clearance_cells, corridor_cells) = build_path(
        log=log, clearance_cells=args.clearance_cells,
        corridor_cells=args.corridor_cells)
    base, H, xs, zs = grid
    stated_margin = clearance_cells * CELL
    log("path %d samples, %d simplified points, %d-cell clearance, %d-cell corridor"
        % (len(samples_xy), len(world), clearance_cells, corridor_cells))

    arc = arc_table(samples_xy)
    length = arc[-1]
    log("length %.6f m" % length)

    ground = []
    for x, z in samples_xy:
        i, j = cell_of(x, z, xs, zs)
        ground.append(round(float(H[j, i]), 4))
    spawn_heading = math.atan2(samples_xy[1][0] - samples_xy[0][0],
                               samples_xy[1][1] - samples_xy[0][1])

    # ---------------------------------------------------------------- gates
    i1 = min(range(len(arc)), key=lambda k: abs(arc[k] - length / 3.0))
    i2 = min(range(len(arc)), key=lambda k: abs(arc[k] - 2.0 * length / 3.0))

    def make_gate(index, kind, gate_id, sample_index, gate_arc):
        x, z = samples_xy[index]
        tx, tz, window = tangent_at(samples_xy, index)
        heading = math.atan2(tx, tz)
        if index == 0:
            approach = samples_xy[1]
        elif index == len(samples_xy) - 1:
            approach = samples_xy[-2]
        else:
            approach = samples_xy[index - 1]
        a, b = gate_line(x, z, tx, tz, GATE_HALF_WIDTH, approach)
        g = ground[index]
        check = raster_check(base, H, xs, zs, x, z, tx, tz, g)
        return {
            "id": gate_id,
            "kind": kind,
            "index": len(gates),
            "sampleIndex": int(sample_index),
            "arc": num(gate_arc, 6),
            "x": num(x, 6),
            "z": num(z, 6),
            "groundY": num(g, 4),
            "height": num(g, 4),
            "headingRad": num(heading, 9),
            "tangent": {
                "tx": num(tx, 9),
                "tz": num(tz, 9),
                "windowMetres": num(window, 3),
            },
            "widthMetres": num(GATE_HALF_WIDTH * 2, 6),
            "requestedWidthMetres": num(GATE_HALF_WIDTH * 2, 6),
            "narrowed": False,
            "a": [num(a[0], 6), num(a[1], 6)],
            "b": [num(b[0], 6), num(b[1], 6)],
            "coverage": {
                "measured": False,
                "source": "not measured",
                "note": ("the collision path has no draw-coverage measurement; "
                         "the gate line is rules geometry only"),
            },
            "groundCheck": check,
        }

    gates = []
    gates.append(make_gate(0, "start", "start", 0, 0.0))
    gates.append(make_gate(i1, "checkpoint", "checkpoint-1", i1, arc[i1]))
    gates.append(make_gate(i2, "checkpoint", "checkpoint-2", i2, arc[i2]))
    gates.append(make_gate(len(samples_xy) - 1, "finish", "finish",
                           len(samples_xy) - 1, length))

    start = gates[0]
    finish = gates[3]
    if abs(start["x"] - START[0]) > 1e-6 or abs(start["z"] - START[1]) > 1e-6:
        raise SystemExit("the start gate is not the committed start position")
    if abs(finish["x"] - FINISH[0]) > 1e-6 or abs(finish["z"] - FINISH[1]) > 1e-6:
        raise SystemExit("the finish gate is not the committed finish position")

    # ---------------------------------------------------------------- samples
    samples = []
    for index, (x, z) in enumerate(samples_xy):
        samples.append({
            "arc": num(arc[index], 6),
            "x": num(x, 6),
            "z": num(z, 6),
            "groundY": num(ground[index], 4),
            "covered": None,
        })

    # ---------------------------------------------------------------- obstruction
    draw_points = [(s["x"], s["z"]) for s in draw_doc["course"]["samples"]]
    draw_dist = obstruction_distance(draw_points)
    path_dist = obstruction_distance(samples_xy)
    stop_index = min(range(len(samples_xy)),
                     key=lambda k: math.hypot(samples_xy[k][0] - STOP_POSE[0],
                                              samples_xy[k][1] - STOP_POSE[1]))
    stop_distance = min(segment_distance(samples_xy[stop_index][0],
                                         samples_xy[stop_index][1],
                                         seg["a"][0], seg["a"][1],
                                         seg["b"][0], seg["b"][1])
                        for seg in OBSTRUCTION_SEGMENTS)
    draw_stop_index = min(range(len(draw_points)),
                          key=lambda k: math.hypot(draw_points[k][0] - STOP_POSE[0],
                                                   draw_points[k][1] - STOP_POSE[1]))
    draw_stop_arc = draw_doc["course"]["samples"][draw_stop_index]["arc"]
    if path_dist[0] < stated_margin:
        raise SystemExit("the path's %.3f m obstruction clearance is below the %.3f m "
                         "stated margin" % (path_dist[0], stated_margin))
    log("obstruction: draw path %.3f m, collision path %.3f m, at the 226.8 m stop "
        "%.3f m, stated margin %.1f m"
        % (draw_dist[0], path_dist[0], stop_distance, stated_margin))

    # ---------------------------------------------------------------- source
    physics_sha = file_sha256(phys_path)
    grid_path = ROOT / GRID_PATH
    draw_path = ROOT / DRAW_LAYOUT

    source = {
        "map": MAP_ID,
        "level": LEVEL,
        "probe": "probes/map-laps (collision-only point-to-point path)",
        "probeScope": "collisionOnly",
        "physics": {
            "path": PHYSICS,
            "bytes": len(phys_bytes),
            "sha256": physics_sha,
        },
        "slice": draw_doc["source"]["slice"],
        "render": draw_doc["source"]["render"],
        "raster": {
            "path": GRID_PATH,
            "fileSha256": file_sha256(grid_path),
            "cell": CELL,
            "surfaceMinNormalY": 0.94,
            "stepLimit": 0.05,
            "gradeLimit": 0.05,
            "staticTriangles": int(len(tris)),
            "notInRaster": ("10 InstancedTriangleMesh records and 1 FluidMesh; "
                            "the committed scanner does not decode them"),
            "source": ("P48 passable raster built from the static triangle meshes "
                       "(types 0 and 11) of Level.levelphysics"),
        },
        "sliceCollision": {
            "positions": {
                "path": "_work/map-slice/longbeach/collision.positions.f32.bin",
                "bytes": (ROOT / "_work/map-slice/longbeach/collision.positions.f32.bin").stat().st_size,
                "sha256": file_sha256(ROOT / "_work/map-slice/longbeach/collision.positions.f32.bin"),
            },
            "indices": {
                "path": "_work/map-slice/longbeach/collision.indices.u32.bin",
                "bytes": (ROOT / "_work/map-slice/longbeach/collision.indices.u32.bin").stat().st_size,
                "sha256": file_sha256(ROOT / "_work/map-slice/longbeach/collision.indices.u32.bin"),
            },
            "note": ("the same 25,183 static triangles as the raster; used only to "
                     "locate the recorded obstruction triangles by index"),
        },
        "clearance": {
            "cells": clearance_cells,
            "lowerBoundMetres": num(clearance_cells * CELL, 3),
            "metric": ("8-connected erosion: a retained cell has all 8 neighbours "
                       "over every one of the %d erosion layers, so its Chebyshev "
                       "distance to a blocked cell is >= %.1f m and its Euclidean "
                       "distance is at least that" % (clearance_cells,
                                                     clearance_cells * CELL)),
            "carHalfWidthM": num(HALF_WIDTH, 3),
            "carHalfLengthM": num(HALF_LENGTH, 4),
            "carCircumradiusM": num(CAR_CIRCUMRADIUS, 6),
            "carEnvelope": {
                "length": CAR_LENGTH,
                "width": CAR_WIDTH,
                "safetyMargin": SAFETY_MARGIN,
                "source": ("documented maximum XT envelope plus a labelled 0.30 m "
                           "margin; not a recovered retail hull"),
            },
        },
        "corridor": {
            "drawPath": DRAW_LAYOUT,
            "drawPathFileSha256": file_sha256(draw_path),
            "drawPathCanonicalHash": draw_doc["hash"],
            "drawPathLengthMetres": draw_doc["course"]["lengthMetres"],
            "drawPathSamples": len(draw_points),
            "cells": corridor_cells,
            "halfWidthMetres": num(corridor_cells * CELL, 3),
            "penaltyPerCell": CORRIDOR_PENALTY,
            "note": ("the committed draw-covered path is the corridor centre line "
                     "only; no sample, gate or ground value is taken from it"),
        },
        "obstruction": {
            "label": "10 cm curb at the draw path's 226.8 m stop",
            "analysis": "docs/work/analysis/longbeach-path-blocked.md",
            "stopPose": {"x": STOP_POSE[0], "z": STOP_POSE[1]},
            "segments": [
                {
                    "a": list(seg["a"]),
                    "b": list(seg["b"]),
                    "yMin": seg["yMin"],
                    "yMax": seg["yMax"],
                    "triangles": seg["triangles"],
                }
                for seg in OBSTRUCTION_SEGMENTS
            ],
            "drawPathDistanceM": num(draw_dist[0], 4),
            "drawPathClosestSample": int(draw_dist[1]),
            "drawPathStopArc": num(draw_stop_arc, 6),
            "pathDistanceM": num(path_dist[0], 4),
            "pathClosestSample": int(path_dist[1]),
            "pathClosestPoint": [num(path_dist[2][0], 4), num(path_dist[2][1], 4)],
            "pathStopSample": int(stop_index),
            "pathStopArc": num(arc[stop_index], 6),
            "pathStopDistanceM": num(stop_distance, 4),
            "statedMarginM": num(stated_margin, 3),
            "improvementM": num(path_dist[0] - draw_dist[0], 4),
            "source": ("static collision triangles 7617/7618/10292/10293 "
                       "(z = 47.664 curb) and 10297/10300 (x = -718.404 curb) in "
                       "_work/map-slice/longbeach/collision.indices.u32.bin"),
        },
        "spawn": {
            "x": start["x"],
            "z": start["z"],
            "headingRad": num(spawn_heading, 9),
        },
        "spawnSource": ("position: the committed draw-covered path first point "
                        "(-519, 111); heading: the collision path's first 0.25 m "
                        "tangent, which equals the draw path's first 2 m tangent "
                        "(-2.35619449 rad)"),
        "groundSource": ("P48 collision raster H at each 0.25 m sample's 0.5 m cell "
                         "(4 decimals)"),
        "gateLineSource": ("5 m tangent window, 8 m line, oriented so the approach "
                           "side is positive; the 6 m committed width missed the "
                           "driven checkpoint-1 crossing by 0.39 m"),
        "checkpointStationSource": ("samples closest to one-third / two-thirds of the "
                                    "measured collision arc; the draw path's "
                                    "272.892723 / 545.610543 m are not used"),
    }

    # ---------------------------------------------------------------- course
    course = {
        "rule": ("point-to-point collision-clear path; the spawn is the first "
                 "raster sample and the finish is the last; every sample is on the "
                 "P48 passable raster eroded by %d cells (>= %.1f m) inside a %d-cell "
                 "corridor around the committed draw-covered path"
                 % (clearance_cells, clearance_cells * CELL, corridor_cells)),
        "name": "usa_la_longbeachdocks collision-clear path",
        "spawn": {
            "x": start["x"],
            "z": start["z"],
            "headingRad": num(spawn_heading, 9),
        },
        "spawnGroundY": start["groundY"],
        "start": {
            "x": start["x"],
            "z": start["z"],
            "arc": 0,
            "groundY": start["groundY"],
        },
        "finish": {
            "x": finish["x"],
            "z": finish["z"],
            "arc": num(length, 6),
            "groundY": finish["groundY"],
        },
        "measuredEnd": {
            "x": finish["x"],
            "z": finish["z"],
            "arc": num(length, 6),
            "groundY": finish["groundY"],
        },
        "lengthMetres": num(length, 6),
        "finishArc": num(length, 6),
        "sampleStepMetres": num(SAMPLE_STEP, 3),
        "sampleCount": len(samples),
        "span": {
            "startArc": 0,
            "finishArc": num(length, 6),
            "lengthMetres": num(length, 6),
            "measuredLengthMetres": num(length, 6),
            "drawPathLengthMetres": draw_doc["course"]["lengthMetres"],
            "finishClearanceMetres": 0,
            "note": ("arcs are measured along the collision-clear path; the "
                     "committed draw path is %.6f m and is not the authority"
                     % draw_doc["course"]["lengthMetres"]),
        },
        "band": {
            "halfWidthMetres": num(BAND_HALF_WIDTH, 3),
            "source": ("declared controller and respawn band for this path; the "
                       "page validator requires the committed 6 m value"),
            "note": "not a road-width claim",
        },
        "corridor": {
            "rule": ("off-course respawn band is a declared +/-%.1f m around the "
                     "collision-clear path" % CORRIDOR_HALF_WIDTH),
            "halfWidthMetres": num(CORRIDOR_HALF_WIDTH, 3),
            "source": {
                "minRasterClearanceM": num(path_dist[0], 4),
                "clearanceLowerBoundM": num(stated_margin, 3),
                "carHalfWidthM": num(HALF_WIDTH, 3),
                "carCircumradiusM": num(CAR_CIRCUMRADIUS, 6),
                "note": ("declared respawn rule below the measured %.3f m clearance "
                         "to the nearest blocked cell; the car half-width is %.3f m "
                         "and the circumradius is %.3f m"
                         % (path_dist[0], HALF_WIDTH, CAR_CIRCUMRADIUS)),
            },
        },
        "coverage": {
            "measured": False,
            "source": "not measured",
            "note": ("draw coverage of this collision path was not measured; the "
                     "committed draw path's 0.4729 collision-diameter coverage "
                     "does not apply to this line"),
        },
        "samples": samples,
    }

    # ---------------------------------------------------------------- document
    doc = {
        "kind": "e1-drive.sprint",
        "version": 1,
        "courseId": MAP_ID,
        "scope": {
            "collisionOnly": True,
            "drawGeometryRead": False,
            "drawPathReadForCorridor": True,
            "drawCoverageSource": "not measured for this collision path",
            "rendererClaim": False,
            "vehiclePhysics": False,
            "gameRun": False,
            "pathDriven": False,
            "engineTrace": ("not run by this builder; the path is a geometric "
                            "raster result, not a driven lap"),
            "note": ("a data layout, not an e1-drive integration: no gate mesh, no "
                     "race director, no lap timing, no car simulated"),
        },
        "source": source,
        "course": course,
        "gates": gates,
        "countdown": {
            "ticks": 90,
            "stepTicks": 30,
            "labels": ["3", "2", "1"],
            "goLabel": "GO",
            "rule": ("input is held at zero until the countdown reaches GO; the "
                     "timer starts at GO and the car is on the start line"),
        },
        "rules": {
            "tickHz": 60,
            "timer": ("elapsed engine ticks from GO at 1/60 s; it keeps running "
                      "across a respawn and freezes on the finish"),
            "gateOrder": ("checkpoints count only in index order; a finish crossing "
                          "is rejected until every checkpoint is passed"),
            "finishRequiresAllCheckpoints": True,
            "progress": ("progress is the arc length of the nearest point on the "
                         "collision-clear path, clamped to the finish arc"),
            "respawn": {
                "fallBelowGroundMetres": num(1.0, 3),
                "airborneTicks": 30,
                "outsideBandMarginMetres": 1,
                "overshootMarginMetres": 2,
                "target": ("the gate point of the last passed checkpoint (the start "
                           "line before the first checkpoint)"),
                "rule": ("respawn when the chassis falls more than 1 m below the "
                         "measured ground at its arc, stays airborne for 30 ticks, "
                         "or leaves the declared band; the attempt timer keeps "
                         "running and the last checkpoint is kept"),
            },
            "limits": [
                ("one point-to-point sprint on the collision-clear path, not a lap "
                 "and not a retail start line"),
                ("the path is the P48 passable raster eroded by %d cells (>= %.1f m) "
                 "inside a %d-cell corridor around the committed draw-covered path"
                 % (clearance_cells, clearance_cells * CELL, corridor_cells)),
                ("the 6 m band is the page validator's declared controller/respawn "
                 "band; the measured respawn corridor is %.1f m and the measured "
                 "clearance to the nearest blocked cell is %.3f m"
                 % (CORRIDOR_HALF_WIDTH, path_dist[0])),
                ("the path clears the recorded 226.8 m curb by %.3f m (stated margin "
                 "%.1f m); the draw path passed %.3f m from it"
                 % (path_dist[0], stated_margin, draw_dist[0])),
                ("gates are rules geometry only; no gate mesh is added to the render "
                 "packet"),
                ("the ten InstancedTriangleMesh records and the FluidMesh are not in "
                 "the raster; no prop collider, opponent, AI or race audio is added"),
            ],
        },
        "integration": {
            "integrated": False,
            "needed": [
                ("map-registry.js needs the new layout file/content pins "
                 "(sampleCount, lengthMetres, checkpointArcs) for "
                 "?map=longbeach&script=sprint"),
                ("map_package_builder.mjs longbeach config needs the same pins; "
                 "the package builder copies the layout it is given"),
                ("the e1-drive Longbeach geometry packet must be loaded before this "
                 "layout; this document carries no draw geometry"),
                ("gate lines are rules geometry only; no gate mesh, start banner or "
                 "race director exists for this map"),
                ("draw coverage of this collision path is not measured; the "
                 "committed draw path's coverage does not apply"),
            ],
            "missingData": [
                ("decoded InstancedTriangleMesh collision shapes (10 records) and "
                 "the FluidMesh (1 record)"),
                ("draw coverage of the collision path at 0.25 m samples and across "
                 "the 6 m gate lines"),
                "retail start-line / route record for the map",
            ],
        },
    }
    doc["hash"] = canonical_hash(doc)

    text = json.dumps(doc, indent=1, ensure_ascii=False) + "\n"
    encoded = text.encode("utf-8")
    if args.check:
        if not args.out.exists():
            print("MISSING %s" % args.out)
            return 1
        if args.out.read_bytes() != encoded:
            print("STALE %s" % args.out)
            return 1
        print("OK %s" % args.out)
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(encoded)
    try:
        output = str(args.out.relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        output = str(args.out)
    print(json.dumps({
        "output": output,
        "bytes": len(encoded),
        "hash": doc["hash"],
        "lengthMetres": doc["course"]["lengthMetres"],
        "samples": len(samples),
        "gates": [{"id": g["id"], "arc": g["arc"], "groundY": g["groundY"]}
                  for g in gates],
        "obstruction": {
            "drawPathDistanceM": doc["source"]["obstruction"]["drawPathDistanceM"],
            "pathDistanceM": doc["source"]["obstruction"]["pathDistanceM"],
            "statedMarginM": doc["source"]["obstruction"]["statedMarginM"],
        },
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
