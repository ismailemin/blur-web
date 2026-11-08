#!/usr/bin/env python3
"""Shared collision-path model for `usa_la_longbeachdocks`.

This module is the Long Beach instance of the map-laps probe. It reuses the
P48 raster primitives (`probes/lap-search/tools/raster.py`) through
`map_laps_common.py` and the committed map-pipeline physics scanner, and adds
the point-to-point search the closed-loop tools do not have:

  * the P48 passability raster (0.5 m, static triangle meshes types 0/11);
  * an 8-connected clearance mask (`erode(base, CLEARANCE_CELLS)`), so every
    retained cell is at least `CLEARANCE_CELLS * 0.5 m` from a blocked cell in
    the Chebyshev metric and therefore at least that far in Euclidean distance;
  * a corridor around the committed draw-covered path (chamfer distance in
    cells), so the collision path follows the measured course instead of
    cutting across the map;
  * A* on the intersection of the two masks, a greedy line-of-sight
    simplification that re-checks every 0.25 m station, and a 0.25 m resample.

Only static triangle meshes are in the raster. The ten InstancedTriangleMesh
records and the FluidMesh are recorded as not in the raster, never guessed.

No draw geometry is read for the path itself: the committed draw path is used
only as the corridor centre line.
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-laps/tools"))
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))

import physics_scan as scan  # noqa: E402  (read-only import)
from map_laps_common import (  # noqa: E402
    CELL, SURFACE_MIN_NY, STEP_LIMIT, GRADE_LIMIT, WALL_DILATE,
    CAR_LENGTH, CAR_WIDTH, SAFETY_MARGIN, HALF_LENGTH, HALF_WIDTH,
    build_raster, erode,
)

LEVEL = "usa_la_longbeachdocks"
MAP_ID = "longbeach"
PHYSICS = "game-data/Blur/levels/usa_la_longbeachdocks/Level.levelphysics"
STATIC_TRIANGLES = 25183

# Committed start/finish positions (the measured draw-covered path endpoints).
START = (-519.0, 111.0)
FINISH = (-432.0, -86.0)
# Committed spawn heading: the draw path's first 2 m tangent.
START_HEADING = -2.35619449
FINISH_HEADING = 0.7853990838305359

SAMPLE_STEP = 0.25
CLEARANCE_CELLS = 12                # 6.0 m Chebyshev -> >= 6.0 m Euclidean
CORRIDOR_CELLS = 14                 # 7.0 m half-width around the draw path
CORRIDOR_PENALTY = 0.2              # cost per draw-path cell of deviation
GATE_HALF_WIDTH = 4.0               # 8 m gate line; the 6 m committed width missed
                                    # the driven checkpoint-1 crossing by 0.39 m
BAND_HALF_WIDTH = 6.0               # page validator's declared respawn band
CORRIDOR_HALF_WIDTH = 6.0           # declared respawn band for this path
TANGENT_WINDOW = 5.0

CAR_CIRCUMRADIUS = math.hypot(HALF_LENGTH, HALF_WIDTH)   # 2.1246 m

# The obstruction recorded in docs/work/analysis/longbeach-path-blocked.md:
# the 10 cm curb the car's box proxy corner struck at draw-path arc 226.8 m.
STOP_POSE = (-714.73, 49.19)
OBSTRUCTION_SEGMENTS = [
    dict(a=(-718.404, 47.664), b=(-688.458, 47.664), yMin=-0.098, yMax=0.002,
         triangles=[7617, 7618, 10292, 10293]),
    dict(a=(-718.404, 28.864), b=(-718.404, 47.664), yMin=-0.098, yMax=0.008,
         triangles=[10297, 10300]),
]

DRAW_LAYOUT = "probes/map-laps/data/longbeach-draw-layout.json"
GRID_PATH = "_work/map-laps/longbeach/grid.npz"
OUT_PATH = "probes/map-laps/data/longbeach-path.json"


def load_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def file_sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(Path(path).read_bytes()).hexdigest()


def canonical_hash(doc: dict) -> str:
    body = {k: v for k, v in doc.items() if k != "hash"}
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def num(value, nd=6):
    """Round to `nd` decimals and emit an int for integral values.

    The committed hash is canonical JSON. Python prints `1.0` where JavaScript
    prints `1`, so integral floats are stored as ints.
    """
    if value is None:
        return None
    rounded = round(float(value), nd)
    if rounded == 0:
        return 0
    if rounded == int(rounded) and abs(rounded) < 1e15:
        return int(rounded)
    return rounded


# --------------------------------------------------------------------------
# raster
# --------------------------------------------------------------------------

def load_static_triangles():
    path = ROOT / PHYSICS
    data = path.read_bytes()
    parsed = scan.scan_level(data)
    out = []
    for mesh in parsed["shapes"]:
        if mesh.get("importType") not in (0, 11):
            continue
        verts = mesh["vertices"]
        for tri in mesh["triangles"]:
            leaf = mesh["leaves"][tri["leaf"]]
            base = leaf["vertex_start"]
            out.append((verts[base + tri["a"]], verts[base + tri["b"]],
                        verts[base + tri["c"]]))
    return path, data, parsed, np.asarray(out, dtype=np.float64)


def build_grid(log=print):
    path, data, parsed, tris = load_static_triangles()
    if len(tris) != STATIC_TRIANGLES:
        raise SystemExit("static triangle count %d != committed %d (refusing to guess)"
                         % (len(tris), STATIC_TRIANGLES))
    R = build_raster(tris, CELL, log=log)
    grid_path = ROOT / GRID_PATH
    grid_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(grid_path, base=R["base"], wall=R["W"],
                        height=R["H"].astype(np.float32),
                        dh=R["dh"].astype(np.float32),
                        xs=R["xs"], zs=R["zs"])
    return grid_path, path, data, parsed, tris, R


def load_grid():
    grid = np.load(ROOT / GRID_PATH)
    return (grid["base"], grid["height"], grid["xs"], grid["zs"])


def cell_of(x, z, xs, zs):
    # Half-up rounding, matching JavaScript's Math.round. Python's round() is
    # banker's rounding, which picks a different cell for a station exactly on a
    # 0.5 m cell boundary (many 0.25 m samples are).
    return (int(math.floor((x - xs[0]) / CELL + 0.5)),
            int(math.floor((z - zs[0]) / CELL + 0.5)))


# --------------------------------------------------------------------------
# draw-path corridor
# --------------------------------------------------------------------------

def draw_path_cells(xs, zs, shape):
    doc = load_json(ROOT / DRAW_LAYOUT)
    pts = [(s["x"], s["z"]) for s in doc["course"]["samples"]]
    ii = np.rint((np.asarray([p[0] for p in pts]) - xs[0]) / CELL).astype(np.int64)
    jj = np.rint((np.asarray([p[1] for p in pts]) - zs[0]) / CELL).astype(np.int64)
    nz, nx = shape
    ok = (ii >= 0) & (ii < nx) & (jj >= 0) & (jj < nz)
    seed = np.zeros((nz, nx), dtype=bool)
    seed[jj[ok], ii[ok]] = True
    return seed, doc


def chamfer_cells(seed):
    """3-4 chamfer distance to the nearest seed cell, in cells (approximate)."""
    nz, nx = seed.shape
    INF = 1e9
    d = np.where(seed, 0.0, INF).astype(np.float32)
    for j in range(nz):
        row = d[j]
        if j > 0:
            prev = d[j - 1]
            np.minimum(row, prev + 3.0, out=row)
            np.minimum(row[1:], prev[:-1] + 4.0, out=row[1:])
            np.minimum(row[:-1], prev[1:] + 4.0, out=row[:-1])
        np.minimum(row[1:], row[:-1] + 3.0, out=row[1:])
    for j in range(nz - 1, -1, -1):
        row = d[j]
        if j < nz - 1:
            nxt = d[j + 1]
            np.minimum(row, nxt + 3.0, out=row)
            np.minimum(row[1:], nxt[:-1] + 4.0, out=row[1:])
            np.minimum(row[:-1], nxt[1:] + 4.0, out=row[:-1])
        np.minimum(row[:-1], row[1:] + 3.0, out=row[:-1])
    return d / 3.0


# --------------------------------------------------------------------------
# A* and simplification
# --------------------------------------------------------------------------

SQ2 = math.sqrt(2.0)
NEIGHBOURS = [(-1, -1, SQ2), (0, -1, 1.0), (1, -1, SQ2),
              (-1, 0, 1.0), (1, 0, 1.0),
              (-1, 1, SQ2), (0, 1, 1.0), (1, 1, SQ2)]


def astar(mask, start, finish, penalty=None):
    """8-connected A*; deterministic heap tie-break on (f, g, row, col)."""
    import heapq
    nz, nx = mask.shape
    gscore = np.full((nz, nx), np.inf, dtype=np.float32)
    came = np.full((nz, nx), -1, dtype=np.int32)
    gscore[start[1], start[0]] = 0.0
    hx, hy = finish
    heap = [(math.hypot(start[0] - hx, start[1] - hy), 0.0, start[1], start[0])]
    while heap:
        f, gs, j, i = heapq.heappop(heap)
        if gs > gscore[j, i] + 1e-6:
            continue
        if i == hx and j == hy:
            return gscore, came
        for di, dj, cost in NEIGHBOURS:
            ii, jj = i + di, j + dj
            if ii < 0 or jj < 0 or ii >= nx or jj >= nz or not mask[jj, ii]:
                continue
            ng = gs + cost
            if penalty is not None:
                ng += CORRIDOR_PENALTY * float(penalty[jj, ii])
            if ng < gscore[jj, ii] - 1e-6:
                gscore[jj, ii] = ng
                came[jj, ii] = j * nx + i
                heapq.heappush(heap, (ng + math.hypot(ii - hx, jj - hy), ng, jj, ii))
    return None, None


def trace_path(came, finish, nx):
    out = []
    cur = finish[1] * nx + finish[0]
    while cur >= 0:
        j, i = divmod(cur, nx)
        out.append((i, j))
        cur = came[j, i]
    out.reverse()
    return out


def segment_ok(mask, xs, zs, a, b, step=SAMPLE_STEP):
    """Every `step` station of a->b maps to a passable cell."""
    nz, nx = mask.shape
    ax, az = float(xs[a[0]]), float(zs[a[1]])
    bx, bz = float(xs[b[0]]), float(zs[b[1]])
    length = math.hypot(bx - ax, bz - az)
    n = max(1, int(math.ceil(length / step)))
    for k in range(n + 1):
        t = k / n
        i, j = cell_of(ax + (bx - ax) * t, az + (bz - az) * t, xs, zs)
        if not (0 <= i < nx and 0 <= j < nz) or not mask[j, i]:
            return False
    return True


def simplify(mask, xs, zs, cells):
    """Greedy line-of-sight simplification that keeps the first/last cell step.

    The first and last steps are kept so the path's endpoint headings are the
    draw path's committed spawn and finish headings.
    """
    if len(cells) < 3:
        return list(cells)
    simp = [cells[0], cells[1]]
    i = 1
    end = len(cells) - 2
    while i < end:
        lo, hi = i + 1, end
        best = i + 1
        while lo <= hi:
            mid = (lo + hi) // 2
            if segment_ok(mask, xs, zs, cells[i], cells[mid]):
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1
        simp.append(cells[best])
        i = best
    if simp[-1] != cells[-2]:
        simp.append(cells[-2])
    simp.append(cells[-1])
    return simp


def resample(points, step=SAMPLE_STEP):
    out = []
    for a, b in zip(points, points[1:]):
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(math.ceil(length / step)))
        for k in range(n):
            t = k / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    out.append(points[-1])
    return out


def build_path(log=print, clearance_cells=None, corridor_cells=None):
    """Return (samples, world_points, cells, mask, dist, grid, draw_doc)."""
    k = CLEARANCE_CELLS if clearance_cells is None else int(clearance_cells)
    r = CORRIDOR_CELLS if corridor_cells is None else int(corridor_cells)
    grid_path, phys_path, phys_bytes, parsed, tris, R = build_grid(log=log)
    base, H, xs, zs = R["base"], R["H"], R["xs"], R["zs"]
    start = cell_of(START[0], START[1], xs, zs)
    finish = cell_of(FINISH[0], FINISH[1], xs, zs)
    if not base[start[1], start[0]]:
        raise SystemExit("committed start %s is not on P48 passable ground" % (START,))
    if not base[finish[1], finish[0]]:
        raise SystemExit("committed finish %s is not on P48 passable ground" % (FINISH,))
    seed, draw_doc = draw_path_cells(xs, zs, base.shape)
    dist = chamfer_cells(seed)
    clear = erode(base, k)
    mask = clear & (dist <= r)
    if not mask[start[1], start[0]] or not mask[finish[1], finish[0]]:
        raise SystemExit("start or finish does not survive the %d-cell clearance mask"
                         % k)
    gscore, came = astar(mask, start, finish, penalty=dist)
    if gscore is None:
        raise SystemExit("no collision path at %d-cell clearance inside the %d-cell corridor"
                         % (k, r))
    cells = trace_path(came, finish, base.shape[1])
    simp = simplify(mask, xs, zs, cells)
    world = [(float(xs[i]), float(zs[j])) for i, j in simp]
    samples = resample(world, SAMPLE_STEP)
    for index, (x, z) in enumerate(samples):
        i, j = cell_of(x, z, xs, zs)
        if not mask[j, i]:
            raise SystemExit("resampled station %d (%.3f, %.3f) left the clearance mask"
                             % (index, x, z))
    return (samples, world, cells, mask, dist, (base, H, xs, zs), draw_doc,
            phys_path, phys_bytes, parsed, tris, k, r)
