#!/usr/bin/env python3
"""Build the committed three-lap layout for `usa_amboy` loop-01.

The input is the collision-only map-lap probe:

  _work/map-laps/usa_amboy/loops.json     loop-01, 284.4524 m, component 510
  _work/map-laps/usa_amboy/coverage.json  draw coverage of the loop line
  _work/map-laps/usa_amboy/layout.json    the probe's own hand-off record
  _work/map-laps/usa_amboy/grid.npz       P48 passable raster (base/height/xs/zs)

The output is an `e1-drive.sprint` v1 document with `courseId: "lap"`, the same
schema `probes/e1-drive/web/sprint-layout.js` derives for River loop-01. It
carries four gates (start, checkpoint-1, checkpoint-2, finish), the closed
0.25 m sample table, the start/finish line, per-gate ground, the 3-lap rule and
the source hashes.

Fields the probe's `layout.json` does not carry are derived, never invented:

  * per-sample `groundY`: `loops.json` `ground` (P48 raster H at the 0.5 m cell
    of each sample); the probe's ground is already the 4-decimal raster value;
  * gate line endpoints: 5 m tangent window, 4 m line, oriented so the approach
    side is positive (the same rule as `sprint-layout.js`);
  * `groundCheck`: the P48 passable raster at the gate cell and at 0.25 m
    stations across the 4 m line. This is the probe's own raster, not a new
    measurement.

Draw coverage is copied from `coverage.json`; it is a 0.5 m height test, not a
render. Gate-width draw/collision coverage was not measured by the probe and is
recorded as `measured: false`.

    python probes/map-laps/tools/build_amboy_lap.py
    python probes/map-laps/tools/build_amboy_lap.py --check
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
DEFAULT_DIR = ROOT / "_work/map-laps/usa_amboy"
DEFAULT_OUT = ROOT / "probes/map-laps/data/amboy-loop01-lap.json"

LEVEL = "usa_amboy"
MAP_ID = "amboy"
LOOP_ID = "loop-01"
LOOP_COMPONENT = 510
LOOP_LENGTH_M = 284.4524
LAPS = 3
SAMPLE_STEP_M = 0.25
GATE_HALF_WIDTH_M = 2.0
TANGENT_WINDOW_M = 5.0
CLOSURE_LIMIT_M = 1.0
BAND_HALF_WIDTH_M = 1.25
CAR_HALF_WIDTH_M = 1.138
CAR_HALF_LENGTH_M = 1.7905
CAR_CIRCUMRADIUS_M = math.hypot(CAR_HALF_LENGTH_M, CAR_HALF_WIDTH_M)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def file_sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_hash(doc: dict) -> str:
    body = {k: v for k, v in doc.items() if k != "hash"}
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def num(value, nd=6):
    """Round to `nd` decimals and emit an int for integral values.

    The committed hash is canonical JSON. Python prints `1.0` where JavaScript
    prints `1`, so integral floats are stored as ints; every non-integral value
    here is >= 1e-4, where Python and JavaScript use the same decimal form.
    """
    if value is None:
        return None
    rounded = round(float(value), nd)
    if rounded == 0:
        return 0
    if rounded == int(rounded) and abs(rounded) < 1e15:
        return int(rounded)
    return rounded


def arc_table(points):
    arc = [0.0]
    for a, b in zip(points, points[1:]):
        arc.append(arc[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    return arc


def tangent_at(points, index, window=TANGENT_WINDOW_M):
    ring = len(points) - 1
    half = max(1, int(round(window / 2.0 / SAMPLE_STEP_M)))
    a = points[(index - half) % ring]
    b = points[(index + half) % ring]
    tx, tz = b[0] - a[0], b[1] - a[1]
    length = math.hypot(tx, tz) or 1.0
    return tx / length, tz / length, round(2 * half * SAMPLE_STEP_M, 3)


def line_side(a, b, point):
    return (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])


def closest_arc_index(arc, target):
    """Sample index whose measured arc is closest to `target`."""
    return min(range(len(arc)), key=lambda index: abs(arc[index] - target))


def gate_line(x, z, tx, tz, half_width, approach):
    """4 m line perpendicular to the tangent, oriented approach-side positive."""
    nx, nz = -tz, tx
    a = [x - nx * half_width, z - nz * half_width]
    b = [x + nx * half_width, z + nz * half_width]
    if line_side(a, b, approach) <= 0:
        a, b = b, a
    return a, b


def raster_check(base, height, xs, zs, x, z, tx, tz, ground, half_width=GATE_HALF_WIDTH_M):
    """P48 passable raster at the gate cell and across its 4 m line."""
    cell = float(xs[1] - xs[0])
    nz, nx = base.shape

    def cell_of(px, pz):
        return int(round((px - xs[0]) / cell)), int(round((pz - zs[0]) / cell))

    i, j = cell_of(x, z)
    inside = 0 <= i < nx and 0 <= j < nz
    passable = bool(inside and base[j, i])
    raster_height = float(height[j, i]) if inside else None

    nxv, nzv = -tz, tx
    stations = []
    steps = int(round(half_width / SAMPLE_STEP_M))
    for k in range(-steps, steps + 1):
        d = k * SAMPLE_STEP_M
        ii, jj = cell_of(x + nxv * d, z + nzv * d)
        ok = 0 <= ii < nx and 0 <= jj < nz and bool(base[jj, ii])
        stations.append((d, ok))
    car_stations = [ok for d, ok in stations if abs(d) <= CAR_HALF_WIDTH_M + 1e-9]

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


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true",
                    help="compare the generated document with --out; exit 1 if it differs")
    args = ap.parse_args(argv)

    base_dir = args.dir
    loops_path = base_dir / "loops.json"
    coverage_path = base_dir / "coverage.json"
    layout_path = base_dir / "layout.json"
    verify_path = base_dir / "verify.json"
    engine_path = base_dir / "engine-trace.json"
    grid_path = base_dir / "grid.npz"

    loops_doc = load_json(loops_path)
    coverage_doc = load_json(coverage_path)
    layout_doc = load_json(layout_path)
    verify_doc = load_json(verify_path) if verify_path.exists() else None
    engine_doc = load_json(engine_path) if engine_path.exists() else None

    if loops_doc.get("kind") != "map-laps.loops" or loops_doc.get("version") != 1:
        raise SystemExit("loops.json is not map-laps.loops v1")
    if loops_doc.get("level") != LEVEL:
        raise SystemExit("loops.json is for %s, not %s" % (loops_doc.get("level"), LEVEL))
    if coverage_doc.get("kind") != "map-laps.coverage" or coverage_doc.get("level") != LEVEL:
        raise SystemExit("coverage.json is not the usa_amboy map-laps.coverage artifact")
    if layout_doc.get("kind") != "map-laps.layout" or layout_doc.get("level") != LEVEL:
        raise SystemExit("layout.json is not the usa_amboy map-laps.layout artifact")

    loop = next((q for q in loops_doc["loops"] if q["id"] == LOOP_ID), None)
    if loop is None:
        raise SystemExit("loop %s is not in loops.json" % LOOP_ID)
    if loop.get("closed") is not True:
        raise SystemExit("%s is not closed" % LOOP_ID)
    if loop.get("component") != LOOP_COMPONENT:
        raise SystemExit("%s is in component %s, expected %s"
                         % (LOOP_ID, loop.get("component"), LOOP_COMPONENT))
    if abs(loop["length"] - LOOP_LENGTH_M) > 1e-3:
        raise SystemExit("recorded loop length %s is not %s m"
                         % (loop["length"], LOOP_LENGTH_M))
    if loop["closureSeam"] > CLOSURE_LIMIT_M:
        raise SystemExit("closure seam %s m exceeds %s m"
                         % (loop["closureSeam"], CLOSURE_LIMIT_M))

    points = loop["points"]
    ground = loop["ground"]
    if len(points) != len(ground):
        raise SystemExit("points and ground arrays differ in length")
    if points[0] != points[-1]:
        raise SystemExit("loop points do not repeat the first point at the seam")
    if len(points) < 3:
        raise SystemExit("loop has too few points")

    ring = len(points) - 1
    arc = arc_table(points)
    length = arc[-1]
    if abs(length - LOOP_LENGTH_M) > 1e-3:
        raise SystemExit("recomputed loop length %.6f is not %s m" % (length, LOOP_LENGTH_M))

    cov_loop = next((q for q in coverage_doc["loops"] if q["id"] == LOOP_ID), None)
    if cov_loop is None:
        raise SystemExit("coverage.json has no %s" % LOOP_ID)
    if cov_loop.get("fraction") != 1.0 or cov_loop.get("gapRuns") != 0:
        raise SystemExit("coverage.json does not record a fully covered loop")

    # The probe's own hand-off must agree with the derived stations.
    probe_gates = {g["label"]: g for g in layout_doc.get("gates", [])}
    if "start" not in probe_gates or "finish" not in probe_gates:
        raise SystemExit("the probe layout has no start/finish gate")

    grid = np.load(grid_path)
    base, height, xs, zs = grid["base"], grid["height"], grid["xs"], grid["zs"]

    # Checkpoints at the samples closest to one-third / two-thirds of the
    # measured arc. The probe's layout.json used nominal 0.25 m sample thirds
    # (indices 379/759, 32.77 % / 65.66 %); the measured arc is the authority.
    i1 = closest_arc_index(arc, length / 3.0)
    i2 = closest_arc_index(arc, 2.0 * length / 3.0)

    # ---------------------------------------------------------------- gates
    def make_gate(index, kind, gate_id, sample_index, gate_arc):
        x, z = points[index]
        tx, tz, window = tangent_at(points, index)
        heading = math.atan2(tx, tz)
        approach = points[(index - 1) % ring]
        a, b = gate_line(x, z, tx, tz, GATE_HALF_WIDTH_M, approach)
        g = ground[index]
        check = raster_check(base, height, xs, zs, x, z, tx, tz, g)
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
            "widthMetres": num(GATE_HALF_WIDTH_M * 2, 6),
            "requestedWidthMetres": num(GATE_HALF_WIDTH_M * 2, 6),
            "narrowed": False,
            "a": [num(a[0], 6), num(a[1], 6)],
            "b": [num(b[0], 6), num(b[1], 6)],
            "coverage": {
                "measured": False,
                "source": "not measured",
                "note": ("the probe measured the loop centre line at 0 / +/-1 m "
                         "(coverage.json), not the 4 m gate line; no gate-width "
                         "draw/collision coverage claim is made"),
            },
            "groundCheck": check,
        }

    gates = []
    gates.append(make_gate(0, "start", "start", 0, 0.0))
    gates.append(make_gate(i1, "checkpoint", "checkpoint-1", i1, arc[i1]))
    gates.append(make_gate(i2, "checkpoint", "checkpoint-2", i2, arc[i2]))
    # The finish is the same physical line at the closure sample. The driving
    # slice names the repeated first point (samples.length - 1) as the finish.
    gates.append(make_gate(0, "finish", "finish", ring, length))

    start = gates[0]
    finish = gates[3]
    if start["a"] != finish["a"] or start["b"] != finish["b"]:
        raise SystemExit("the finish line is not the start line")
    if start["x"] != finish["x"] or start["z"] != finish["z"]:
        raise SystemExit("the finish point is not the start point")

    # ---------------------------------------------------------------- samples
    samples = []
    for index, (x, z) in enumerate(points):
        samples.append({
            "arc": num(arc[index], 6),
            "x": num(x, 6),
            "z": num(z, 6),
            "groundY": num(ground[index], 4),
            "covered": True,
        })

    # ---------------------------------------------------------------- source
    physics = loops_doc["inputs"]["physics"]
    physics_path = ROOT / physics["path"]
    physics_sha = file_sha256(physics_path)
    if physics_sha != "sha256:" + physics["sha256"]:
        raise SystemExit("the physics file does not match the recorded SHA-256")

    source = {
        "map": MAP_ID,
        "level": LEVEL,
        "probe": "probes/map-laps (collision-only map-lap search)",
        "probeScope": "collisionOnly",
        "loopId": LOOP_ID,
        "loopComponent": LOOP_COMPONENT,
        "loopLengthMetres": num(LOOP_LENGTH_M, 4),
        "lapLoops": "_work/map-laps/usa_amboy/loops.json",
        "lapLoopsFileSha256": file_sha256(loops_path),
        "lapLoopsCanonicalHash": loops_doc["hash"],
        "coverage": "_work/map-laps/usa_amboy/coverage.json",
        "coverageFileSha256": file_sha256(coverage_path),
        "coverageCanonicalHash": coverage_doc["hash"],
        "layout": "_work/map-laps/usa_amboy/layout.json",
        "layoutFileSha256": file_sha256(layout_path),
        "layoutCanonicalHash": layout_doc["hash"],
        "verify": "_work/map-laps/usa_amboy/verify.json",
        "verifyFileSha256": file_sha256(verify_path) if verify_doc else None,
        "verifyCanonicalHash": verify_doc["hash"] if verify_doc else None,
        "engineTrace": "_work/map-laps/usa_amboy/engine-trace.json",
        "engineTraceFileSha256": file_sha256(engine_path) if engine_doc else None,
        "physics": {
            "path": physics["path"],
            "bytes": physics["bytes"],
            "sha256": physics_sha,
        },
        "groundSource": ("loops.json loop-01 `ground`: the P48 collision raster H "
                         "at each 0.25 m sample's 0.5 m cell (4 decimals)"),
        "gateLineSource": ("5 m tangent window across the loop, 4 m line, oriented "
                           "so the approach side is positive (sprint-layout.js rule)"),
        "checkpointStationSource": ("samples closest to one-third / two-thirds of the "
                                    "measured arc; the probe layout's 379/759 are "
                                    "nominal 0.25 m sample thirds (32.77 % / 65.66 %)"),
        "spawn": {
            "x": start["x"],
            "z": start["z"],
            "headingRad": start["headingRad"],
        },
        "spawnSource": ("loop-01 first sample from _work/map-laps/usa_amboy/loops.json; "
                        "not a retail start line"),
    }

    # ---------------------------------------------------------------- course
    course = {
        "rule": ("the lap follows map-laps loop-01 (284.4524 m, 1152 samples at "
                 "0.25 m) exactly; the start/finish line sits on the first measured "
                 "sample and is perpendicular to the 5 m tangent across the seam; "
                 "three forward crossings of that line end the race"),
        "name": "usa_amboy map-laps loop-01",
        "spawn": {
            "x": start["x"],
            "z": start["z"],
            "headingRad": start["headingRad"],
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
        "sampleStepMetres": num(SAMPLE_STEP_M, 3),
        "sampleCount": len(samples),
        "laps": LAPS,
        "span": {
            "startArc": 0,
            "finishArc": num(length, 6),
            "lengthMetres": num(length, 6),
            "measuredLengthMetres": num(LOOP_LENGTH_M, 4),
            "laps": LAPS,
            "totalRaceDistanceMetres": num(LOOP_LENGTH_M * LAPS, 4),
            "measuredTotalRaceDistanceMetres": num(length * LAPS, 6),
            "note": ("arc lengths are measured along the closed loop-01; lap N ends "
                     "at the next forward crossing of arc 0 and the timer is the "
                     "engine tick clock from GO"),
        },
        "corridor": {
            "rule": ("off-course respawn band is a declared +/-%s m around the "
                     "measured loop line" % BAND_HALF_WIDTH_M),
            "halfWidthMetres": num(BAND_HALF_WIDTH_M, 3),
            "source": {
                "minRasterClearanceM": num(loop["minClearance"], 3),
                "carHalfWidthM": num(CAR_HALF_WIDTH_M, 3),
                "carCircumradiusM": num(CAR_CIRCUMRADIUS_M, 6),
                "note": ("1.25 m is the River P67 measured driven lateral bound and "
                         "is only a declared respawn rule here: no lap has been "
                         "driven on this map"),
            },
        },
        "lap": {
            "laps": LAPS,
            "lengthMetres": num(length, 6),
            "minLapMetres": num(length * 0.5, 6),
            "line": {
                "arc": 0,
                "x": start["x"],
                "z": start["z"],
                "groundY": start["groundY"],
                "headingRad": start["headingRad"],
                "tangent": dict(start["tangent"]),
                "widthMetres": start["widthMetres"],
                "requestedWidthMetres": start["requestedWidthMetres"],
                "narrowed": False,
                "a": list(start["a"]),
                "b": list(start["b"]),
                "coverage": dict(start["coverage"]),
            },
            "bandHalfWidthMetres": num(BAND_HALF_WIDTH_M, 3),
            "source": {
                "file": "_work/map-laps/usa_amboy/loops.json",
                "fileSha256": source["lapLoopsFileSha256"],
                "canonicalHash": loops_doc["hash"],
                "loopId": LOOP_ID,
                "component": LOOP_COMPONENT,
                "samples": len(samples),
            },
        },
        "coverage": {
            "source": "_work/map-laps/usa_amboy/coverage.json (loop-01)",
            "rule": "covered = declared draw triangle within 0.5 m of the collision height",
            "samples": int(cov_loop["samples"]),
            "coveredSamples": int(cov_loop["samples"] - cov_loop["centreUncoveredSamples"]),
            "stations": int(cov_loop["stations"]),
            "coveredStations": int(cov_loop["coveredStations"]),
            "coverageFraction": num(cov_loop["fraction"], 6),
            "centreUncoveredSamples": int(cov_loop["centreUncoveredSamples"]),
            "gapRuns": int(cov_loop["gapRuns"]),
            "gapMetres": num(cov_loop["gapMetres"], 6),
            "deltaMinMetres": num(cov_loop["deltaMin"], 6),
            "deltaMaxMetres": num(cov_loop["deltaMax"], 6),
            "deltaMedianMetres": num(cov_loop["deltaMedian"], 6),
            "lateralStationsM": [num(v, 3) for v in coverage_doc["inputs"]["lateralStationsM"]],
            "note": ("the coverage test measured the 1151 unique loop samples at "
                     "0 / +/-1 m, not the 4 m gate lines"),
        },
        "samples": samples,
        "sampling": {
            "gateSampleStepMetres": num(0.1, 3),
            "tangentWindowMetres": num(TANGENT_WINDOW_M, 3),
            "sampleStepMetres": num(SAMPLE_STEP_M, 3),
        },
        "reference": {
            "rule": ("driver control reference: the measured loop-01 line itself, "
                     "closed at the seam; it is a controller aid, not a new road, "
                     "and the lap line, laps and timer stay on the measured samples"),
            "windowMetres": 0,
            "carHalfWidthMetres": num(CAR_HALF_WIDTH_M, 3),
            "maxDeviationMetres": 0,
            "minBandMarginMetres": num(BAND_HALF_WIDTH_M - CAR_HALF_WIDTH_M, 6),
            "points": [
                {
                    "arc": sample["arc"],
                    "x": sample["x"],
                    "z": sample["z"],
                    "deviation": 0,
                    "bandMarginMetres": num(BAND_HALF_WIDTH_M - CAR_HALF_WIDTH_M, 6),
                }
                for sample in samples
            ],
        },
    }

    # ---------------------------------------------------------------- document
    doc = {
        "kind": "e1-drive.sprint",
        "version": 1,
        "courseId": "lap",
        "scope": {
            "collisionOnly": True,
            "drawGeometryRead": False,
            "drawCoverageSource": ("_work/map-laps/usa_amboy/coverage.json "
                                   "(0.5 m height test, not a render)"),
            "rendererClaim": False,
            "vehiclePhysics": False,
            "gameRun": False,
            "lapDriven": False,
            "engineTrace": ("recorded in _work/map-laps/usa_amboy/engine-trace.json; "
                            "not re-run by this builder"),
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
                      "across a respawn and freezes on the third lap"),
            "gateOrder": ("the start/finish line counts only on a forward crossing "
                          "after at least half a lap; three laps end the race"),
            "finishRequiresAllCheckpoints": False,
            "progress": ("progress is cumulative forward travel along the measured "
                         "closed loop, clamped to three laps"),
            "respawn": {
                "fallBelowGroundMetres": num(1.0, 3),
                "airborneTicks": 30,
                "outsideBandMarginMetres": 0,
                "overshootMarginMetres": 0,
                "target": ("the start/finish line point and its measured tangent "
                           "heading (the last lap line)"),
                "rule": ("respawn when the chassis falls more than 1 m below the "
                         "measured ground at its arc or stays airborne for 30 ticks, "
                         "or leaves the declared band; the attempt timer keeps "
                         "running and the lap count is kept"),
            },
            "limits": [
                ("the lap starts in collision component 510 (map-laps loop-01), not "
                 "at the committed point-to-point spawn; the start is moved into the "
                 "loop component and is not a gate-layout change"),
                ("three laps of the measured 284.4524 m loop; the start/finish line "
                 "is rules geometry only and no gate mesh is added to the render "
                 "packet"),
                ("the checkpoint gates are data only: the current LapRules counts "
                 "three forward crossings of the start/finish line and does not "
                 "require the checkpoints"),
                ("no lap has been driven on this map; the 1.25 m respawn band is a "
                 "declared rule, not a measured driven lateral bound"),
                "no opponents, no AI and no race audio",
            ],
        },
        "integration": {
            "integrated": False,
            "needed": [
                ("map-registry.js needs an Amboy lap course entry (layoutUrl + "
                 "courses) for ?map=amboy&course=lap"),
                ("app.js must fetch this document for the lap course and pass it to "
                 "createSprintRules; LapRules requires courseId \"lap\""),
                ("map-package.js validateMapPackage is the point-to-point 4-gate / "
                 "2060 m validator and must not be applied to this lap document"),
                ("the e1-drive Amboy geometry packet must be loaded before the lap "
                 "layout; this document carries no draw geometry"),
                ("gate lines are rules geometry only; no gate mesh, start banner or "
                 "race director exists for this map"),
                "props/power-ups/colliders are not measured by this probe",
            ],
            "missingData": [
                ("retail start-line / route record for the map (Level.levelphysics "
                 "has a route count but routes are not parsed by the committed "
                 "scanner)"),
                ("draw coverage of the gate lines at their full 4 m width "
                 "(coverage.json measured 0 / +/-1 m stations only)"),
                "decoded InstancedTriangleMesh collision shapes (excluded from the raster)",
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
        "loop": LOOP_ID,
        "component": LOOP_COMPONENT,
        "lengthMetres": doc["course"]["lengthMetres"],
        "recordedLengthMetres": LOOP_LENGTH_M,
        "laps": LAPS,
        "gates": [{"id": g["id"], "arc": g["arc"], "groundY": g["groundY"]}
                  for g in gates],
        "samples": len(samples),
        "coverageFraction": doc["course"]["coverage"]["coverageFraction"],
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
