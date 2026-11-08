#!/usr/bin/env python3
"""Build the committed collision-clear point-to-point paths for the map-batch
levels `usa_la_observatory` and `usa_la_downtown`.

Inputs (read-only):

  _work/map-batch/<level>/collision.positions.f32.bin   committed collision vertices
  _work/map-batch/<level>/collision.indices.u32.bin     committed collision triangles
  _work/map-batch/<level>/spawn.json                    committed spawn pose
  _work/map-batch/<level>/path.json                     committed draw-covered path
  _work/map-batch/<level>/draws.json                    committed draw list (source pins)
  _work/map-batch/<level>/manifest.json                 committed package pins
  game-data/Blur/levels/<level>/Level.levelphysics       committed physics file (pin only)

Outputs:

  probes/map-laps/data/<map>-path.json   `e1-drive.sprint` v1, courseId = <map>
  _work/map-laps/<map>/grid.npz          P48 raster (base/height/dh/wall/xs/zs)

The path is not the draw path. It is an A* line on the P48 passability raster
(the same 0.5 m rule the Long Beach builder uses) eroded by `CLEARANCE_CELLS`
cells, inside a `CORRIDOR_CELLS` corridor around the committed draw-covered
path, simplified with a 0.25 m line-of-sight check and resampled at 0.25 m.

Two endpoint rules are recorded, not guessed:

  * the committed spawn pose and the committed draw-path finish are the path's
    first and last samples;
  * the isotropic erosion cannot contain those poses (the committed spawn sits
    0.707 m from a blocked cell on the observatory road edge), so each endpoint
    is joined to the nearest eroded cell by a straight connector. Every sample,
    including the connectors, is checked against the car half-width lateral
    band; every sample outside the connectors is checked against the full
    isotropic margin.

Run:

    python probes/map-laps/tools/build_batch_paths.py
    python probes/map-laps/tools/build_batch_paths.py --map observatory
    python probes/map-laps/tools/build_batch_paths.py --check
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
sys.path.insert(0, str(ROOT / "probes/map-laps/tools"))
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))

from map_laps_common import (  # noqa: E402
    CELL, SURFACE_MIN_NY, STEP_LIMIT, GRADE_LIMIT, WALL_DILATE,
    CAR_LENGTH, CAR_WIDTH, SAFETY_MARGIN, HALF_LENGTH, HALF_WIDTH,
    build_raster, erode,
)
import longbeach_path_common as lb  # noqa: E402  (read-only reuse)

# --------------------------------------------------------------------------
# registry
# --------------------------------------------------------------------------
LEVELS = {
    "observatory": dict(
        map_id="observatory",
        level="usa_la_observatory",
        batch="_work/map-batch/usa_la_observatory",
        physics="game-data/Blur/levels/usa_la_observatory/Level.levelphysics",
        out="probes/map-laps/data/observatory-path.json",
        grid="_work/map-laps/observatory/grid.npz",
        course_name="usa_la_observatory collision-clear path",
    ),
    "downtown": dict(
        map_id="downtown",
        level="usa_la_downtown",
        batch="_work/map-batch/usa_la_downtown",
        physics="game-data/Blur/levels/usa_la_downtown/Level.levelphysics",
        out="probes/map-laps/data/downtown-path.json",
        grid="_work/map-laps/downtown/grid.npz",
        course_name="usa_la_downtown collision-clear path",
    ),
    "mharuna": dict(
        map_id="mharuna",
        level="jpn_mharuna",
        batch="_work/map-batch/jpn_mharuna",
        physics="game-data/Blur/levels/jpn_mharuna/Level.levelphysics",
        out="probes/map-laps/data/mharuna-path.json",
        grid="_work/map-laps/mharuna/grid.npz",
        course_name="jpn_mharuna collision-clear path",
    ),
    "hackney": dict(
        map_id="hackney",
        level="uk_london_hackney",
        batch="_work/map-batch/uk_london_hackney",
        physics="game-data/Blur/levels/uk_london_hackney/Level.levelphysics",
        out="probes/map-laps/data/hackney-path.json",
        grid="_work/map-laps/hackney/grid.npz",
        course_name="uk_london_hackney collision-clear path",
        corridor_cells=28,
        clearance_cells=6,
    ),
    "dumbo": dict(
        map_id="dumbo",
        level="usa_ny_dumbo",
        batch="_work/map-batch/usa_ny_dumbo",
        physics="game-data/Blur/levels/usa_ny_dumbo/Level.levelphysics",
        out="probes/map-laps/data/dumbo-path.json",
        grid="_work/map-laps/dumbo/grid.npz",
        course_name="usa_ny_dumbo collision-clear path",
        corridor_cells=28,
        clearance_cells=6,
    ),
}

# --------------------------------------------------------------------------
# model constants
# --------------------------------------------------------------------------
SAMPLE_STEP = 0.25
# ceil(HALF_WIDTH / CELL) = ceil(1.138 / 0.5) = 3 cells = 1.5 m.
CLEARANCE_CELLS = 10
CORRIDOR_CELLS = 14                 # 7.0 m half-width around the draw path
CORRIDOR_PENALTY = 0.2              # cost per draw-path cell of deviation
GATE_HALF_WIDTH = 4.0               # 8 m gate line
BAND_HALF_WIDTH = 6.0               # page validator's declared 6 m band
CORRIDOR_HALF_WIDTH = 12.0          # declared respawn band; a tight street course needs recovery room
TANGENT_WINDOW = 5.0
NEAREST_BLOCKED_RADIUS = 30         # 15 m search window for the clearance probe

CAR_CIRCUMRADIUS = math.hypot(HALF_LENGTH, HALF_WIDTH)   # 2.1246 m


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def load_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def file_sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(Path(path).read_bytes()).hexdigest()


def canonical_hash(doc: dict) -> str:
    return lb.canonical_hash(doc)


def num(value, nd=6):
    return lb.num(value, nd)


def arc_table(points):
    arc = [0.0]
    for a, b in zip(points, points[1:]):
        arc.append(arc[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    return arc


def tangent_at(points, index, window=TANGENT_WINDOW):
    """5 m window tangent; clamped at the open path's ends (Long Beach rule)."""
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
    return tx / length, tz / length, round(min(window, math.hypot(b[0] - a[0], b[1] - a[1])), 3)


def line_side(a, b, point):
    return (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])


def gate_line(x, z, tx, tz, half_width, approach):
    nx, nz = -tz, tx
    a = [x - nx * half_width, z - nz * half_width]
    b = [x + nx * half_width, z + nz * half_width]
    if line_side(a, b, approach) <= 0:
        a, b = b, a
    return a, b


def nearest_blocked(base, xs, zs, x, z, radius=NEAREST_BLOCKED_RADIUS):
    """Distance to the nearest blocked raster cell and that cell's index."""
    nz, nx = base.shape
    i, j = lb.cell_of(x, z, xs, zs)
    j0, j1 = max(0, j - radius), min(nz, j + radius + 1)
    i0, i1 = max(0, i - radius), min(nx, i + radius + 1)
    sub = ~base[j0:j1, i0:i1]
    if not sub.any():
        return None, None
    lj, li = np.nonzero(sub)
    d = np.hypot((lj + j0 - j) * CELL, (li + i0 - i) * CELL)
    k = int(np.argmin(d))
    return float(d[k]), (int(li[k] + i0), int(lj[k] + j0))


def lateral_band(base, xs, zs, x, z, tx, tz, half_width=HALF_WIDTH):
    """Passability of the car's lateral band at 0.25 m stations."""
    nz, nx = base.shape
    nxv, nzv = -tz, tx
    steps = int(round(half_width / SAMPLE_STEP))
    stations = []
    for k in range(-steps, steps + 1):
        d = k * SAMPLE_STEP
        i, j = lb.cell_of(x + nxv * d, z + nzv * d, xs, zs)
        stations.append(0 <= i < nx and 0 <= j < nz and bool(base[j, i]))
    return stations


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


def nearest_clear_cell(clear, i, j, reach=80):
    """Nearest eroded cell to (i, j) in Euclidean metres, deterministic."""
    nz, nx = clear.shape
    best = None
    for r in range(0, reach + 1):
        j0, j1 = max(0, j - r), min(nz, j + r + 1)
        i0, i1 = max(0, i - r), min(nx, i + r + 1)
        js, is_ = np.nonzero(clear[j0:j1, i0:i1])
        if len(js) == 0:
            continue
        d = np.hypot((js + j0 - j) * CELL, (is_ + i0 - i) * CELL)
        k = int(np.argmin(d))
        if best is None or d[k] < best[0] - 1e-12:
            best = (float(d[k]), int(is_[k] + i0), int(js[k] + j0))
        if best[0] <= r * CELL + 1e-12:
            break
    return best


# --------------------------------------------------------------------------
# package inputs
# --------------------------------------------------------------------------
def load_batch(cfg, log=print):
    batch = ROOT / cfg["batch"]
    manifest = load_json(batch / "manifest.json")
    collision = load_json(batch / "collision.json")
    path_doc = load_json(batch / "path.json")
    spawn_doc = load_json(batch / "spawn.json")
    draws = load_json(batch / "draws.json")
    if manifest.get("level") != cfg["level"] or path_doc.get("level") != cfg["level"] \
            or spawn_doc.get("level") != cfg["level"] or draws.get("level") != cfg["level"]:
        raise SystemExit("%s package is not %s" % (cfg["batch"], cfg["level"]))

    pos_path = batch / "collision.positions.f32.bin"
    idx_path = batch / "collision.indices.u32.bin"
    pos_bytes = pos_path.read_bytes()
    idx_bytes = idx_path.read_bytes()
    pos_pin = collision["buffers"]["positions"]
    idx_pin = collision["buffers"]["indices"]
    if len(pos_bytes) != pos_pin["bytes"] or file_sha256(pos_path) != "sha256:" + pos_pin["sha256"]:
        raise SystemExit("%s does not match collision.json" % pos_path)
    if len(idx_bytes) != idx_pin["bytes"] or file_sha256(idx_path) != "sha256:" + idx_pin["sha256"]:
        raise SystemExit("%s does not match collision.json" % idx_path)

    positions = np.frombuffer(pos_bytes, dtype="<f4").astype(np.float64).reshape(-1, 3)
    indices = np.frombuffer(idx_bytes, dtype="<u4")
    if len(positions) != collision["counts"]["vertices"]:
        raise SystemExit("collision vertex count %d != committed %d"
                         % (len(positions), collision["counts"]["vertices"]))
    if len(indices) != collision["counts"]["triangles"] * 3:
        raise SystemExit("collision index count %d != committed %d triangles"
                         % (len(indices), collision["counts"]["triangles"]))
    tris = positions[indices.reshape(-1, 3)]
    log("collision %d triangles / %d vertices" % (len(tris), len(positions)))
    return {
        "batch": batch,
        "manifest": manifest,
        "collision": collision,
        "path": path_doc,
        "spawn": spawn_doc,
        "draws": draws,
        "positions": positions,
        "indices": indices,
        "tris": tris,
        "pos_path": pos_path,
        "idx_path": idx_path,
    }


def build_grid(cfg, batch, log=print):
    R = build_raster(batch["tris"], CELL, log=log)
    grid_path = ROOT / cfg["grid"]
    grid_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(grid_path, base=R["base"], wall=R["W"],
                        height=R["H"].astype(np.float32),
                        dh=R["dh"].astype(np.float32),
                        xs=R["xs"], zs=R["zs"])
    return grid_path, R


# --------------------------------------------------------------------------
# path
# --------------------------------------------------------------------------
def build_path(cfg, batch, R, log=print):
    clearance_cells = int(cfg.get("clearance_cells", CLEARANCE_CELLS))
    corridor_cells = int(cfg.get("corridor_cells", CORRIDOR_CELLS))
    base, H, xs, zs = R["base"], R["H"], R["xs"], R["zs"]
    path_doc = batch["path"]
    spawn = batch["spawn"]["layout"]["spawn"]
    start = (float(spawn["x"]), float(spawn["z"]))
    finish = (float(path_doc["end"]["x"]), float(path_doc["end"]["z"]))
    draw_points = [(float(p["x"]), float(p["z"])) for p in path_doc["samples"]]

    start_cell = lb.cell_of(start[0], start[1], xs, zs)
    finish_cell = lb.cell_of(finish[0], finish[1], xs, zs)
    if not base[start_cell[1], start_cell[0]]:
        raise SystemExit("committed spawn %s is not on P48 passable ground" % (start,))
    if not base[finish_cell[1], finish_cell[0]]:
        raise SystemExit("committed finish %s is not on P48 passable ground" % (finish,))

    # corridor around the committed draw-covered path
    ii = np.rint((np.asarray([p[0] for p in draw_points]) - xs[0]) / CELL).astype(np.int64)
    jj = np.rint((np.asarray([p[1] for p in draw_points]) - zs[0]) / CELL).astype(np.int64)
    nz, nx = base.shape
    ok = (ii >= 0) & (ii < nx) & (jj >= 0) & (jj < nz)
    seed = np.zeros((nz, nx), dtype=bool)
    seed[jj[ok], ii[ok]] = True
    dist = lb.chamfer_cells(seed)

    clear = erode(base, clearance_cells)
    spawn_snap = nearest_clear_cell(clear, start_cell[0], start_cell[1])
    finish_snap = nearest_clear_cell(clear, finish_cell[0], finish_cell[1])
    if spawn_snap is None or finish_snap is None:
        raise SystemExit("no eroded cell within 40 m of the committed endpoints")

    mask = clear & (dist <= corridor_cells)
    if not mask[spawn_snap[2], spawn_snap[1]] or not mask[finish_snap[2], finish_snap[1]]:
        raise SystemExit("snapped endpoint is outside the %d-cell corridor" % corridor_cells)
    gscore, came = lb.astar(mask, (spawn_snap[1], spawn_snap[2]),
                            (finish_snap[1], finish_snap[2]), penalty=dist)
    if gscore is None:
        blocked = []
        for index, (x, z) in enumerate(draw_points):
            i, j = lb.cell_of(x, z, xs, zs)
            if not mask[j, i]:
                blocked.append({"sampleIndex": index, "x": num(x, 6), "z": num(z, 6),
                                "passable": bool(base[j, i]),
                                "inClearance": bool(clear[j, i]),
                                "inCorridor": bool(dist[j, i] <= corridor_cells)})
        record = {
            "schema": "blur.map-laps.batch-blocked/1",
            "level": cfg["level"],
            "map": cfg["map_id"],
            "reason": ("no collision path at %d-cell clearance inside the %d-cell "
                       "corridor" % (clearance_cells, corridor_cells)),
            "clearanceCells": clearance_cells,
            "corridorCells": corridor_cells,
            "spawn": {"x": num(start[0], 6), "z": num(start[1], 6),
                      "snapMetres": num(spawn_snap[0], 4)},
            "finish": {"x": num(finish[0], 6), "z": num(finish[1], 6),
                       "snapMetres": num(finish_snap[0], 4)},
            "blockedSamples": blocked,
        }
        blocked_path = ROOT / "_work/map-laps" / cfg["map_id"] / "blocked.json"
        blocked_path.parent.mkdir(parents=True, exist_ok=True)
        blocked_path.write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8")
        raise SystemExit("no collision path at %d-cell clearance inside the %d-cell "
                         "corridor; %d blocked draw samples recorded in %s: %s"
                         % (clearance_cells, corridor_cells, len(blocked),
                            blocked_path.relative_to(ROOT), json.dumps(blocked[:20])))

    cells = lb.trace_path(came, (finish_snap[1], finish_snap[2]), nx)
    simp = lb.simplify(mask, xs, zs, cells)
    world = [(float(xs[i]), float(zs[j])) for i, j in simp]
    poly = [start] + world + [finish]
    samples_xy = lb.resample(poly, SAMPLE_STEP)
    # Drop a duplicated final station: when the last collision point equals the
    # finish pose the resampler emits the same point twice, which would give two
    # samples with the same arc. CourseModel requires strictly increasing arcs.
    deduped = [samples_xy[0]]
    for point in samples_xy[1:]:
        if math.hypot(point[0] - deduped[-1][0], point[1] - deduped[-1][1]) > 1e-6:
            deduped.append(point)
    samples_xy = deduped
    for index, (x, z) in enumerate(samples_xy):
        i, j = lb.cell_of(x, z, xs, zs)
        if not (0 <= i < nx and 0 <= j < nz and base[j, i]):
            raise SystemExit("resampled station %d (%.3f, %.3f) is not passable"
                             % (index, x, z))
    return {
        "samples_xy": samples_xy,
        "world": world,
        "cells": cells,
        "simp": simp,
        "mask": mask,
        "clear": clear,
        "dist": dist,
        "start": start,
        "finish": finish,
        "start_cell": start_cell,
        "finish_cell": finish_cell,
        "spawn_snap": spawn_snap,
        "finish_snap": finish_snap,
        "draw_points": draw_points,
        "spawn_heading": float(spawn["heading"]),
        "spawn_ground": float(spawn["ground"]),
        "finish_ground": float(path_doc["end"]["h"]),
    }


# --------------------------------------------------------------------------
# document
# --------------------------------------------------------------------------
def build_document(cfg, batch, grid_path, R, built, log=print):
    base, H, xs, zs = R["base"], R["H"], R["xs"], R["zs"]
    samples_xy = built["samples_xy"]
    world = built["world"]
    start = built["start"]
    finish = built["finish"]
    draw_points = built["draw_points"]
    path_doc = batch["path"]
    collision = batch["collision"]

    arc = arc_table(samples_xy)
    length = arc[-1]
    log("path %d samples, %d simplified points, %.6f m"
        % (len(samples_xy), len(world), length))

    ground = []
    for x, z in samples_xy:
        i, j = lb.cell_of(x, z, xs, zs)
        ground.append(round(float(H[j, i]), 4))

    spawn_connector_arc = math.hypot(world[0][0] - start[0], world[0][1] - start[1])
    finish_connector_arc = length - math.hypot(finish[0] - world[-1][0],
                                              finish[1] - world[-1][1])
    connector_arcs = {"spawn": [0.0, spawn_connector_arc],
                      "finish": [finish_connector_arc, length]}

    def is_interior(value):
        return (value >= spawn_connector_arc - 1e-9
                and value <= finish_connector_arc + 1e-9)

    # ---------------------------------------------------------------- gates
    # A checkpoint must sit on a straight section: a gate inside a hairpin is
    # cut by the driven line and the finish then reports checkpoints-missing.
    # Search +/- 12 % of the nominal third for the sample with the smallest
    # heading change over a 5 m window.
    def straightest(nominal_arc):
        low = max(0.0, nominal_arc - 0.12 * length)
        high = min(length, nominal_arc + 0.12 * length)
        best_index = min(range(len(arc)), key=lambda k: abs(arc[k] - nominal_arc))
        best_turn = None
        for k in range(len(arc)):
            if arc[k] < low or arc[k] > high:
                continue
            a = max(0, k - 10)
            b = min(len(samples_xy) - 1, k + 10)
            ax, az = samples_xy[a]
            bx, bz = samples_xy[b]
            cx, cz = samples_xy[k]
            turn = abs(math.atan2(bx - cx, bz - cz) - math.atan2(cx - ax, cz - az))
            if turn > math.pi:
                turn = 2 * math.pi - turn
            if best_turn is None or turn < best_turn:
                best_turn = turn
                best_index = k
        return best_index

    i1 = straightest(length / 3.0)
    i2 = straightest(2.0 * length / 3.0)

    def make_gate(index, kind, gate_id, sample_index, gate_arc):
        x, z = samples_xy[index]
        tx, tz, window = tangent_at(samples_xy, index)
        heading = math.atan2(tx, tz)
        # The approach point orients the gate line (the car must approach from
        # the positive side). Walk back/forward until the point is at least 1 m
        # from the gate: a path with a duplicated final sample would otherwise
        # give a zero side and flip the gate, so the car crosses it in the
        # "reverse" direction and the finish never fires.
        def approach_point(start_index, direction):
            x0, z0 = samples_xy[start_index]
            k = start_index + direction
            while 0 <= k < len(samples_xy):
                if math.hypot(samples_xy[k][0] - x0, samples_xy[k][1] - z0) >= 1.0:
                    return samples_xy[k]
                k += direction
            k = max(0, min(len(samples_xy) - 1, start_index + direction))
            return samples_xy[k]

        if index == 0:
            approach = approach_point(index, +1)
        else:
            approach = approach_point(index, -1)
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

    start_gate = gates[0]
    finish_gate = gates[3]
    if abs(start_gate["x"] - start[0]) > 1e-6 or abs(start_gate["z"] - start[1]) > 1e-6:
        raise SystemExit("the start gate is not the committed spawn position")
    if abs(finish_gate["x"] - finish[0]) > 1e-6 or abs(finish_gate["z"] - finish[1]) > 1e-6:
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

    # ---------------------------------------------------------------- clearance
    stated_margin = CLEARANCE_CELLS * CELL
    interior_min = (None, None, None)
    lateral_bad = []
    for index, (x, z) in enumerate(samples_xy):
        a = samples_xy[max(0, index - 1)]
        b = samples_xy[min(len(samples_xy) - 1, index + 1)]
        tx, tz = b[0] - a[0], b[1] - a[1]
        tl = math.hypot(tx, tz) or 1.0
        tx, tz = tx / tl, tz / tl
        band = lateral_band(base, xs, zs, x, z, tx, tz)
        if not all(band):
            lateral_bad.append({"sampleIndex": index, "arc": num(arc[index], 6),
                                "x": num(x, 6), "z": num(z, 6),
                                "passable": sum(1 for v in band if v), "stations": len(band)})
        if not is_interior(arc[index]):
            continue
        d, cell = nearest_blocked(base, xs, zs, x, z)
        if d is not None and (interior_min[0] is None or d < interior_min[0]):
            interior_min = (d, index, cell)
    if lateral_bad:
        raise SystemExit("the car half-width lateral band is blocked at %d samples: %s"
                         % (len(lateral_bad), json.dumps(lateral_bad[:10])))
    if interior_min[0] is None or interior_min[0] < stated_margin - 1e-9:
        raise SystemExit("the interior clearance %.3f m is below the stated %.3f m margin"
                         % (interior_min[0] or -1, stated_margin))

    # ---------------------------------------------------------------- obstruction
    draw_clear = []
    for index, (x, z) in enumerate(draw_points):
        d, cell = nearest_blocked(base, xs, zs, x, z)
        draw_clear.append((d, index, cell))
    draw_clear = [row for row in draw_clear if row[0] is not None]
    draw_min = min(draw_clear, key=lambda row: (row[0], row[1]))
    draw_arc = arc_table(draw_points)
    pinch_cell = draw_min[2]
    pinch_i, pinch_j = pinch_cell
    improvement = interior_min[0] - draw_min[0]
    log("obstruction: draw path %.3f m at sample %d (%.2f, %.2f); interior %.3f m at "
        "sample %d; stated margin %.1f m"
        % (draw_min[0], draw_min[1], draw_points[draw_min[1]][0],
           draw_points[draw_min[1]][1], interior_min[0], interior_min[1], stated_margin))

    # ---------------------------------------------------------------- source
    physics_path = ROOT / cfg["physics"]
    physics_bytes = physics_path.read_bytes()
    draws_path = batch["batch"] / "draws.json"
    collision_path = batch["batch"] / "collision.json"
    blockers_path = batch["batch"] / "blockers.json"
    textures_path = batch["batch"] / "textures" / "index.json"
    spawn_path = batch["batch"] / "spawn.json"
    path_path = batch["batch"] / "path.json"

    draws_file_sha = file_sha256(draws_path)
    collision_file_sha = file_sha256(collision_path)

    excluded = [s for s in collision["shapes"] if not s.get("shipped")]
    excluded_types = {}
    for shape in excluded:
        excluded_types[shape["importName"]] = excluded_types.get(shape["importName"], 0) + 1
    not_in_raster = ("the committed collision buffer ships %d static triangle-mesh "
                     "shapes; %d excluded shapes (%s) are not in the buffer and are "
                     "not in the raster"
                     % (collision["counts"]["shippedShapeCount"], len(excluded),
                        ", ".join("%dx %s" % (v, k) for k, v in sorted(excluded_types.items()))))

    source = {
        "map": cfg["map_id"],
        "level": cfg["level"],
        "probe": "probes/map-laps (collision-only point-to-point path)",
        "probeScope": "collisionOnly",
        "physics": {
            "path": cfg["physics"],
            "bytes": len(physics_bytes),
            "sha256": file_sha256(physics_path),
        },
        "slice": {
            "path": cfg["batch"] + "/collision.json",
            "bytes": collision_path.stat().st_size,
            "sha256": collision_file_sha,
            "contentHash": collision_file_sha,
            "contentHashSource": ("the map-batch package records no canonical content "
                                  "hash for collision.json; its committed file pin is "
                                  "used"),
            "note": ("the collision slice document; the map-batch manifest is not "
                     "pinned here because it pins map-registry.js, which pins this "
                     "package"),
        },
        "render": {
            "path": cfg["batch"] + "/draws.json",
            "bytes": draws_path.stat().st_size,
            "sha256": draws_file_sha,
            "contentHash": draws_file_sha,
            "contentHashSource": ("the map-batch package records no canonical content "
                                  "hash for draws.json; its committed file pin is used"),
        },
        "blockers": {
            "path": cfg["batch"] + "/blockers.json",
            "bytes": blockers_path.stat().st_size,
            "sha256": file_sha256(blockers_path),
        },
        "textures": {
            "path": cfg["batch"] + "/textures/index.json",
            "bytes": textures_path.stat().st_size,
            "sha256": file_sha256(textures_path),
        },
        "spawnDocument": {
            "path": cfg["batch"] + "/spawn.json",
            "bytes": spawn_path.stat().st_size,
            "sha256": file_sha256(spawn_path),
        },
        "drawPathDocument": {
            "path": cfg["batch"] + "/path.json",
            "bytes": path_path.stat().st_size,
            "sha256": file_sha256(path_path),
        },
        "raster": {
            "path": cfg["grid"],
            "fileSha256": file_sha256(grid_path),
            "cell": CELL,
            "surfaceMinNormalY": SURFACE_MIN_NY,
            "stepLimit": STEP_LIMIT,
            "gradeLimit": GRADE_LIMIT,
            "wallDilateMetres": WALL_DILATE,
            "staticTriangles": int(len(batch["tris"])),
            "notInRaster": not_in_raster,
            "source": ("P48 passable raster built from the committed "
                       "collision.positions.f32.bin / collision.indices.u32.bin "
                       "triangle buffer"),
        },
        "sliceCollision": {
            "positions": {
                "path": cfg["batch"] + "/collision.positions.f32.bin",
                "bytes": batch["pos_path"].stat().st_size,
                "sha256": file_sha256(batch["pos_path"]),
            },
            "indices": {
                "path": cfg["batch"] + "/collision.indices.u32.bin",
                "bytes": batch["idx_path"].stat().st_size,
                "sha256": file_sha256(batch["idx_path"]),
            },
            "note": ("the same %d triangles as the raster; the buffer is the committed "
                     "collision surface" % len(batch["tris"])),
        },
        "clearance": {
            "cells": CLEARANCE_CELLS,
            "lowerBoundMetres": num(stated_margin, 3),
            "metric": ("8-connected erosion: a retained cell has all 8 neighbours "
                       "over every one of the %d erosion layers, so its Chebyshev "
                       "distance to a blocked cell is >= %.1f m and its Euclidean "
                       "distance is at least that" % (CLEARANCE_CELLS, stated_margin)),
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
            "interiorMinClearanceM": num(interior_min[0], 4),
            "interiorMinSample": int(interior_min[1]),
            "lateralBandMetres": num(HALF_WIDTH, 3),
            "lateralBandSamples": len(samples_xy),
            "lateralBandBlocked": 0,
        },
        "corridor": {
            "drawPath": cfg["batch"] + "/path.json",
            "drawPathFileSha256": file_sha256(path_path),
            "drawPathLengthMetres": path_doc["lengthM"],
            "drawPathSamples": len(draw_points),
            "cells": CORRIDOR_CELLS,
            "halfWidthMetres": num(CORRIDOR_CELLS * CELL, 3),
            "penaltyPerCell": CORRIDOR_PENALTY,
            "note": ("the committed draw-covered path is the corridor centre line "
                     "only; no sample, gate or ground value is taken from it"),
        },
        "endpoints": {
            "spawn": {
                "x": num(start[0], 6),
                "z": num(start[1], 6),
                "headingRad": num(built["spawn_heading"], 9),
                "groundY": num(built["spawn_ground"], 4),
                "rasterCell": [int(built["start_cell"][0]), int(built["start_cell"][1])],
            },
            "finish": {
                "x": num(finish[0], 6),
                "z": num(finish[1], 6),
                "groundY": num(built["finish_ground"], 4),
                "rasterCell": [int(built["finish_cell"][0]), int(built["finish_cell"][1])],
            },
            "spawnSnap": {
                "metres": num(built["spawn_snap"][0], 4),
                "rasterCell": [int(built["spawn_snap"][1]), int(built["spawn_snap"][2])],
                "x": num(xs[built["spawn_snap"][1]], 6),
                "z": num(zs[built["spawn_snap"][2]], 6),
            },
            "finishSnap": {
                "metres": num(built["finish_snap"][0], 4),
                "rasterCell": [int(built["finish_snap"][1]), int(built["finish_snap"][2])],
                "x": num(xs[built["finish_snap"][1]], 6),
                "z": num(zs[built["finish_snap"][2]], 6),
            },
            "connectorArcs": {
                "spawn": [num(connector_arcs["spawn"][0], 6), num(connector_arcs["spawn"][1], 6)],
                "finish": [num(connector_arcs["finish"][0], 6), num(connector_arcs["finish"][1], 6)],
            },
            "rule": ("the committed spawn/finish poses are the first/last samples; "
                     "each is joined to the nearest eroded cell by a straight "
                     "connector. Every sample is checked against the car half-width "
                     "lateral band; only samples outside the connectors carry the "
                     "full isotropic margin"),
            "reason": ("the committed spawn sits %.3f m from a blocked raster cell, so "
                       "the isotropic %d-cell erosion cannot contain it; the connector "
                       "keeps the committed pose without relaxing the interior rule"
                       % (nearest_blocked(base, xs, zs, start[0], start[1])[0] or 0.0,
                          CLEARANCE_CELLS)),
        },
        "obstruction": {
            "label": "narrowest draw-path clearance to a blocked raster cell",
            "drawPath": {
                "sampleIndex": int(draw_min[1]),
                "arc": num(draw_arc[draw_min[1]], 6),
                "x": num(draw_points[draw_min[1]][0], 6),
                "z": num(draw_points[draw_min[1]][1], 6),
                "clearanceM": num(draw_min[0], 4),
                "nearestBlockedCell": [int(pinch_i), int(pinch_j)],
                "nearestBlockedCellHeightM": num(float(H[pinch_j, pinch_i]), 4),
                "nearestBlockedCellEdgeDhM": num(float(R["dh"][pinch_j, pinch_i]), 4),
                "nearestBlockedCellWall": bool(R["W"][pinch_j, pinch_i]),
            },
            "path": {
                "minInteriorClearanceM": num(interior_min[0], 4),
                "sampleIndex": int(interior_min[1]),
                "arc": num(arc[interior_min[1]], 6),
                "x": num(samples_xy[interior_min[1]][0], 6),
                "z": num(samples_xy[interior_min[1]][1], 6),
            },
            "statedMarginM": num(stated_margin, 3),
            "improvementM": num(improvement, 4),
            "source": ("P48 raster blocked-cell distance on the 0.5 m grid; the "
                       "blocked cell is a raster cell whose surface step or wall "
                       "exceeds the committed P48 rule"),
        },
        "spawn": {
            "x": start_gate["x"],
            "z": start_gate["z"],
            "headingRad": num(built["spawn_heading"], 9),
        },
        "spawnSource": ("position and heading: the committed spawn.json pose "
                        "(layout.spawn); the start gate's line uses the collision "
                        "path's 5 m tangent"),
        "groundSource": ("P48 collision raster H at each 0.25 m sample's 0.5 m cell "
                         "(4 decimals); the committed spawn/finish ground is recorded "
                         "in source.endpoints"),
        "gateLineSource": ("5 m tangent window, 8 m line, oriented so the approach "
                           "side is positive"),
        "checkpointStationSource": ("straightest sample within +/-12 % of one-third / two-thirds of the "
                                    "measured collision arc"),
    }

    # ---------------------------------------------------------------- course
    course = {
        "rule": ("point-to-point collision-clear path; the spawn is the committed "
                 "spawn pose and the finish is the committed draw-path end; every "
                 "interior sample is on the P48 passable raster eroded by %d cells "
                 "(>= %.1f m) inside a %d-cell corridor around the committed "
                 "draw-covered path"
                 % (CLEARANCE_CELLS, stated_margin, CORRIDOR_CELLS)),
        "name": cfg["course_name"],
        "spawn": {
            "x": start_gate["x"],
            "z": start_gate["z"],
            "headingRad": num(built["spawn_heading"], 9),
        },
        "spawnGroundY": start_gate["groundY"],
        "start": {
            "x": start_gate["x"],
            "z": start_gate["z"],
            "arc": 0,
            "groundY": start_gate["groundY"],
        },
        "finish": {
            "x": finish_gate["x"],
            "z": finish_gate["z"],
            "arc": num(length, 6),
            "groundY": finish_gate["groundY"],
        },
        "measuredEnd": {
            "x": finish_gate["x"],
            "z": finish_gate["z"],
            "arc": num(length, 6),
            "groundY": finish_gate["groundY"],
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
            "drawPathLengthMetres": path_doc["lengthM"],
            "finishClearanceMetres": 0,
            "note": ("arcs are measured along the collision-clear path; the "
                     "committed draw path is %.6f m and is not the authority"
                     % path_doc["lengthM"]),
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
                "minRasterClearanceM": num(interior_min[0], 4),
                "clearanceLowerBoundM": num(stated_margin, 3),
                "carHalfWidthM": num(HALF_WIDTH, 3),
                "carCircumradiusM": num(CAR_CIRCUMRADIUS, 6),
                "note": ("declared respawn rule at the measured %.3f m clearance "
                         "lower bound; the car half-width is %.3f m and the "
                         "circumradius is %.3f m"
                         % (interior_min[0], HALF_WIDTH, CAR_CIRCUMRADIUS)),
            },
        },
        "endpointConnectors": {
            "spawn": {
                "arc": num(spawn_connector_arc, 6),
                "metres": num(built["spawn_snap"][0], 4),
                "samples": sum(1 for value in arc if value < spawn_connector_arc - 1e-9),
            },
            "finish": {
                "arc": num(length - finish_connector_arc, 6),
                "metres": num(built["finish_snap"][0], 4),
                "samples": sum(1 for value in arc if value > finish_connector_arc + 1e-9),
            },
            "note": ("the connector samples are passable and their car half-width "
                     "lateral band is passable; the isotropic margin applies to "
                     "every sample outside the connector arcs"),
        },
        "coverage": {
            "measured": False,
            "source": "not measured",
            "note": ("draw coverage of this collision path was not measured; the "
                     "committed draw path's coverage does not apply to this line"),
        },
        "samples": samples,
    }

    # ---------------------------------------------------------------- document
    doc = {
        "kind": "e1-drive.sprint",
        "version": 1,
        "courseId": cfg["map_id"],
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
                 % (CLEARANCE_CELLS, stated_margin, CORRIDOR_CELLS)),
                ("the committed spawn/finish poses are joined to the eroded path by "
                 "%.3f m / %.3f m connectors; the connectors are laterally "
                 "car-width passable but do not carry the full isotropic margin"
                 % (built["spawn_snap"][0], built["finish_snap"][0])),
                ("the 6 m band is the page validator's declared controller/respawn "
                 "band; the measured respawn corridor is %.1f m and the measured "
                 "interior clearance is %.3f m"
                 % (CORRIDOR_HALF_WIDTH, interior_min[0])),
                ("the path clears the narrowest draw-path pinch (%.3f m) by %.3f m "
                 "(stated margin %.1f m)"
                 % (draw_min[0], interior_min[0], stated_margin)),
                ("gates are rules geometry only; no gate mesh is added to the render "
                 "packet"),
                ("the %d excluded collision shapes are not in the raster; no prop "
                 "collider, opponent, AI or race audio is added" % len(excluded)),
            ],
        },
        "integration": {
            "integrated": False,
            "needed": [
                ("map-registry.js needs the new layout file/content pins "
                 "(sampleCount, lengthMetres, checkpointArcs) for "
                 "?map=%s&script=sprint" % cfg["map_id"]),
                ("the E1 map-batch package builder copies this document verbatim as "
                 "_work/e1-drive/%s/layout.json" % cfg["map_id"]),
                ("the e1-drive %s geometry packet must be loaded before this "
                 "layout; this document carries no draw geometry" % cfg["map_id"]),
                ("gate lines are rules geometry only; no gate mesh, start banner or "
                 "race director exists for this map"),
                ("draw coverage of this collision path is not measured; the "
                 "committed draw path's coverage does not apply"),
            ],
            "missingData": [
                ("decoded InstancedTriangleMesh / FluidMesh collision shapes (%s)"
                 % ", ".join("%dx %s" % (v, k) for k, v in sorted(excluded_types.items()))),
                ("draw coverage of the collision path at 0.25 m samples and across "
                 "the 8 m gate lines"),
                "retail start-line / route record for the map",
            ],
        },
    }
    doc["hash"] = canonical_hash(doc)
    return doc


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def build_one(key, args, log=print):
    cfg = LEVELS[key]
    batch = load_batch(cfg, log=log)
    grid_path, R = build_grid(cfg, batch, log=log)
    built = build_path(cfg, batch, R, log=log)
    doc = build_document(cfg, batch, grid_path, R, built, log=log)
    text = json.dumps(doc, indent=1, ensure_ascii=False) + "\n"
    encoded = text.encode("utf-8")
    out = Path(args.out) if args.out else ROOT / cfg["out"]
    if args.check:
        if not out.exists():
            print("MISSING %s" % out)
            return 1
        if out.read_bytes() != encoded:
            print("STALE %s" % out)
            return 1
        print("OK %s" % out)
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(encoded)
    try:
        output = str(out.relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        output = str(out)
    print(json.dumps({
        "output": output,
        "bytes": len(encoded),
        "hash": doc["hash"],
        "lengthMetres": doc["course"]["lengthMetres"],
        "samples": doc["course"]["sampleCount"],
        "gates": [{"id": g["id"], "arc": g["arc"], "groundY": g["groundY"]}
                  for g in doc["gates"]],
        "spawnSnapM": doc["source"]["endpoints"]["spawnSnap"]["metres"],
        "finishSnapM": doc["source"]["endpoints"]["finishSnap"]["metres"],
        "obstruction": {
            "drawPathDistanceM": doc["source"]["obstruction"]["drawPath"]["clearanceM"],
            "pathDistanceM": doc["source"]["obstruction"]["path"]["minInteriorClearanceM"],
            "statedMarginM": doc["source"]["obstruction"]["statedMarginM"],
        },
    }, indent=1))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", choices=sorted(LEVELS) + ["all"], default="all")
    ap.add_argument("--out", type=Path, default=None,
                    help="override the output path (single --map only)")
    ap.add_argument("--check", action="store_true",
                    help="compare the generated document with the committed file")
    args = ap.parse_args(argv)
    keys = sorted(LEVELS) if args.map == "all" else [args.map]
    if args.out and len(keys) != 1:
        ap.error("--out needs a single --map")
    status = 0
    for key in keys:
        status |= build_one(key, args)
    return status


if __name__ == "__main__":
    raise SystemExit(main())







