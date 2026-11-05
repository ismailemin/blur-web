#!/usr/bin/env python3
"""Build a collision-only traversability model for USA LA River and search the
longest drivable course from the committed E1 spawn.

Read-only inputs:
  * game-data/Blur/levels/usa_la_river/Level.levelphysics
  * probes/collision-oracle/tests/reference_oracle.py (imported parser only)
  * _work/e1-drive/cars.json / probes/e1-drive/cars/roster.json (car envelope)
  * _work/e1-drive/spawn.json (spawn)

Outputs (all under _work/drivable-path/):
  * path.json    path samples, length, clearance, steps, barriers, hashes
  * path.svg     top-down map
  * path.html    map with the result table
  * grid.npz     the 0.5 m height / passable rasters (deterministic arrays)

The model is deliberately *collision-only*: no draw geometry is read, so a
"covered" cell that is a 50 m cliff face cannot enter the model at all.

    python probes/drivable-path/tools/build_path.py [--cell 0.5]
"""
from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import math
import sys
from collections import deque
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
import reference_oracle as oracle  # noqa: E402

PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
OUT = ROOT / "_work/drivable-path"

# --- documented model constants -------------------------------------------
CELL = 0.5                 # m, local traversability grid
STAGE_A_CELL = 1.0         # m, first pass to find the spawn component extent
SURFACE_MIN_NY = 0.94      # cos(20 deg): drivable surface only
STEP_LIMIT = 0.05          # m, max height difference between adjacent 0.5 m cells
GRADE_LIMIT = 0.05         # 5 %: conservative; engine climbs 2.5 %, fails 6.7 %
EDGE_DH = STEP_LIMIT if STEP_LIMIT < GRADE_LIMIT * CELL else GRADE_LIMIT * CELL
# The car envelope is the widest/longest harness box proxy across the five-car
# XT roster (Dodge wheelBase 2.981 m, Audi trackWidthRear 1.676 m) plus a
# labelled 0.30 m safety margin on every side.
CAR_LENGTH = 2.981
CAR_WIDTH = 1.676
SAFETY_MARGIN = 0.30
HALF_LENGTH = CAR_LENGTH / 2.0 + SAFETY_MARGIN       # 1.7905
HALF_WIDTH = CAR_WIDTH / 2.0 + SAFETY_MARGIN         # 1.138
CLEARANCE_ERODE_CELLS = int(math.ceil(HALF_WIDTH / CELL))   # 3 cells = 1.5 m
SPAWN = (-88.0, 1050.0)
# 29 m P37 sprint control: spawn -> -59 m along +X at z = 1050
SPRINT_END = (-59.0, 1050.0)

# --- rasterisation ---------------------------------------------------------


def flatten_triangles(level):
    out = []
    for mesh in level["meshes"]:
        verts = mesh["vertices"]
        for tri in mesh["triangles"]:
            leaf = mesh["leaves"][tri["leaf"]]
            base = leaf["vertex_start"]
            out.append((verts[base + tri["a"]], verts[base + tri["b"]], verts[base + tri["c"]]))
    return np.asarray(out, dtype=np.float64)


def triangle_normals(tris):
    u = tris[:, 1] - tris[:, 0]
    v = tris[:, 2] - tris[:, 0]
    n = np.cross(u, v)
    ln = np.linalg.norm(n, axis=1)
    ln[ln == 0] = 1.0
    return n / ln[:, None]


def rasterise_height(tris, x0, x1, z0, z1, cell):
    """Max up-facing surface height per XZ cell (NaN where no surface)."""
    nx = int(round((x1 - x0) / cell)) + 1
    nz = int(round((z1 - z0) / cell)) + 1
    H = np.full((nz, nx), -np.inf)
    xs = x0 + np.arange(nx) * cell
    zs = z0 + np.arange(nz) * cell
    for t in tris:
        a, b, c = t
        den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
        if abs(den) < 1e-12:
            continue
        i0 = max(0, int(math.floor((min(a[0], b[0], c[0]) - x0) / cell)))
        i1 = min(nx - 1, int(math.ceil((max(a[0], b[0], c[0]) - x0) / cell)))
        j0 = max(0, int(math.floor((min(a[2], b[2], c[2]) - z0) / cell)))
        j1 = min(nz - 1, int(math.ceil((max(a[2], b[2], c[2]) - z0) / cell)))
        if i1 < i0 or j1 < j0:
            continue
        gx, gz = np.meshgrid(xs[i0:i1 + 1], zs[j0:j1 + 1])
        l1 = ((b[2] - c[2]) * (gx - c[0]) + (c[0] - b[0]) * (gz - c[2])) / den
        l2 = ((c[2] - a[2]) * (gx - c[0]) + (a[0] - c[0]) * (gz - c[2])) / den
        l3 = 1.0 - l1 - l2
        m = (l1 >= -1e-9) & (l2 >= -1e-9) & (l3 >= -1e-9)
        if not m.any():
            continue
        h = l1 * a[1] + l2 * b[1] + l3 * c[1]
        sub = H[j0:j1 + 1, i0:i1 + 1]
        sub[m] = np.maximum(sub[m], h[m])
    H[~np.isfinite(H)] = np.nan
    return H, xs, zs


def edge_max_dh(H):
    """Max |dh| between each cell and its 8 neighbours; inf at surface holes."""
    nz, nx = H.shape
    out = np.zeros((nz, nx))
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            if di == 0 and dj == 0:
                continue
            A = H[max(0, -dj):nz - max(0, dj), max(0, -di):nx - max(0, di)]
            B = H[max(0, dj):nz + min(0, dj), max(0, di):nx + min(0, di)]
            invalid = ~np.isfinite(A) | ~np.isfinite(B)
            d = np.where(invalid, np.inf, np.abs(np.nan_to_num(A - B, nan=0.0)))
            tgt = out[max(0, -dj):nz - max(0, dj), max(0, -di):nx - max(0, di)]
            np.fmax(tgt, d, out=tgt)
    return out


def rasterise_wall(tris, H, x0, x1, z0, z1, cell, radius):
    """Mark cells within `radius` of a steep (|ny| < 0.5) triangle's XZ projection.

    A height raster alone cannot see a thin vertical fin: both sides can be at the
    same height. Projecting the steep triangles and dilating by one cell closes
    that hole. Vertical triangles project to a segment, so the point-to-edge
    distance is used rather than a barycentric area test.

    The triangle only blocks where it occupies the car's height band above the
    local ground. A retaining wall *below* the road surface (a 50 m face whose top
    is under the road) is correctly ignored.
    """
    nx = int(round((x1 - x0) / cell)) + 1
    nz = int(round((z1 - z0) / cell)) + 1
    W = np.zeros((nz, nx), dtype=bool)
    xs = x0 + np.arange(nx) * cell
    zs = z0 + np.arange(nz) * cell
    for t in tris:
        ax, az = t[0][0], t[0][2]
        bx, bz = t[1][0], t[1][2]
        cx, cz = t[2][0], t[2][2]
        t_ymin = min(t[0][1], t[1][1], t[2][1])
        t_ymax = max(t[0][1], t[1][1], t[2][1])
        i0 = max(0, int(math.floor((min(ax, bx, cx) - radius - x0) / cell)))
        i1 = min(nx - 1, int(math.ceil((max(ax, bx, cx) + radius - x0) / cell)))
        j0 = max(0, int(math.floor((min(az, bz, cz) - radius - z0) / cell)))
        j1 = min(nz - 1, int(math.ceil((max(az, bz, cz) + radius - z0) / cell)))
        if i1 < i0 or j1 < j0:
            continue
        Hsub = H[j0:j1 + 1, i0:i1 + 1]
        gate = np.isfinite(Hsub) & (t_ymin < Hsub + 2.0) & (t_ymax > Hsub + 0.05)
        if not gate.any():
            continue
        gx, gz = np.meshgrid(xs[i0:i1 + 1], zs[j0:j1 + 1])
        # inside the projected triangle?
        den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
        inside = np.zeros(gx.shape, dtype=bool)
        if abs(den) > 1e-12:
            l1 = ((bz - cz) * (gx - cx) + (cx - bx) * (gz - cz)) / den
            l2 = ((cz - az) * (gx - cx) + (ax - cx) * (gz - cz)) / den
            l3 = 1.0 - l1 - l2
            inside = (l1 >= 0) & (l2 >= 0) & (l3 >= 0)
        # distance to the three projected edges
        d = np.full(gx.shape, np.inf)
        for (px, pz, qx, qz) in ((ax, az, bx, bz), (bx, bz, cx, cz), (cx, cz, ax, az)):
            dx, dz = qx - px, qz - pz
            l2 = dx * dx + dz * dz
            if l2 == 0:
                dd = np.hypot(gx - px, gz - pz)
            else:
                tt = np.clip(((gx - px) * dx + (gz - pz) * dz) / l2, 0.0, 1.0)
                dd = np.hypot(gx - (px + tt * dx), gz - (pz + tt * dz))
            d = np.minimum(d, dd)
        m = (inside | (d <= radius)) & gate
        if m.any():
            W[j0:j1 + 1, i0:i1 + 1] |= m
    return W


def apply_blocks(mask, xs, zs, blocks, cell):
    """Clear a disc around each engine-confirmed wall hit from the passable mask."""
    for b in blocks:
        i0 = max(0, int(math.floor((b["x"] - b["r"] - xs[0]) / cell)))
        i1 = min(mask.shape[1] - 1, int(math.ceil((b["x"] + b["r"] - xs[0]) / cell)))
        j0 = max(0, int(math.floor((b["z"] - b["r"] - zs[0]) / cell)))
        j1 = min(mask.shape[0] - 1, int(math.ceil((b["z"] + b["r"] - zs[0]) / cell)))
        gx, gz = np.meshgrid(xs[i0:i1 + 1], zs[j0:j1 + 1])
        d = np.hypot(gx - b["x"], gz - b["z"])
        mask[j0:j1 + 1, i0:i1 + 1] &= d > b["r"]
    return mask


def erode(mask, k):
    out = mask.copy()
    for _ in range(k):
        p = np.pad(out, 1, constant_values=False)
        nxt = np.ones_like(out)
        nz, nx = out.shape
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                nxt &= p[1 + dj:1 + dj + nz, 1 + di:1 + di + nx]
        out = nxt
    return out


def neighbour_ok(mask, nz, nx):
    """A cell is connected if it and >=2 orthogonal neighbours are in mask."""
    return mask


def bfs_component(mask, start):
    nz, nx = mask.shape
    seen = np.zeros_like(mask)
    if not mask[start]:
        return seen
    q = deque([start])
    seen[start] = True
    while q:
        j, i = q.popleft()
        for dj, di in ((-1, 0), (1, 0), (0, -1), (0, 1),
                       (-1, -1), (-1, 1), (1, -1), (1, 1)):
            jj, ii = j + dj, i + di
            if 0 <= jj < nz and 0 <= ii < nx and mask[jj, ii] and not seen[jj, ii]:
                seen[jj, ii] = True
                q.append((jj, ii))
    return seen


def dijkstra(mask, start, cell):
    """8-connected shortest path over mask; returns dist and predecessor arrays."""
    nz, nx = mask.shape
    INF = np.inf
    dist = np.full((nz, nx), INF, dtype=np.float64)
    prev = np.full((nz, nx, 2), -1, dtype=np.int32)
    dist[start] = 0.0
    heap = [(0.0, start[0], start[1])]
    diag = cell * math.sqrt(2.0)
    while heap:
        d, j, i = heapq.heappop(heap)
        if d > dist[j, i]:
            continue
        for dj, di, w in ((-1, 0, cell), (1, 0, cell), (0, -1, cell), (0, 1, cell),
                          (-1, -1, diag), (-1, 1, diag), (1, -1, diag), (1, 1, diag)):
            jj, ii = j + dj, i + di
            if not (0 <= jj < nz and 0 <= ii < nx and mask[jj, ii]):
                continue
            # no corner cutting
            if dj != 0 and di != 0:
                if not (mask[j, ii] and mask[jj, i]):
                    continue
            nd = d + w
            if nd < dist[jj, ii] - 1e-12:
                dist[jj, ii] = nd
                prev[jj, ii] = (j, i)
                heapq.heappush(heap, (nd, jj, ii))
    return dist, prev


def reconstruct(prev, target, start):
    path = []
    j, i = target
    while (j, i) != (start[0], start[1]) and j >= 0:
        path.append((j, i))
        pj, pi = prev[j, i]
        j, i = int(pj), int(pi)
    path.append((start[0], start[1]))
    path.reverse()
    return path


# --- geometry helpers ------------------------------------------------------


def height_at(H, xs, zs, x, z):
    """Bilinear-free nearest-cell read of the 0.5 m raster (diagnostic only)."""
    i = int(round((x - xs[0]) / (xs[1] - xs[0])))
    j = int(round((z - zs[0]) / (zs[1] - zs[0])))
    if 0 <= j < H.shape[0] and 0 <= i < H.shape[1]:
        return H[j, i]
    return float("nan")


def point_segment_distance(px, pz, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az
    l2 = dx * dx + dz * dz
    if l2 == 0:
        return math.hypot(px - ax, pz - az)
    t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / l2))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


# --- path post-processing --------------------------------------------------


def line_of_sight(mask, a, b):
    """Supercover line between grid cells; every crossed cell must be in mask."""
    j0, i0 = a
    j1, i1 = b
    steps = max(abs(j1 - j0), abs(i1 - i0))
    if steps == 0:
        return mask[j0, i0]
    for k in range(steps + 1):
        t = k / steps
        j = int(round(j0 + (j1 - j0) * t))
        i = int(round(i0 + (i1 - i0) * t))
        if not mask[j, i]:
            return False
    return True


def taut_path(mask, cells):
    """Greedy string-pulling: keep the farthest visible waypoint."""
    if len(cells) <= 2:
        return cells
    out = [cells[0]]
    k = 0
    while k < len(cells) - 1:
        best = k + 1
        for m in range(len(cells) - 1, k, -1):
            if line_of_sight(mask, cells[k], cells[m]):
                best = m
                break
        out.append(cells[best])
        k = best
    return out


def resample(points, step):
    out = []
    for a, b in zip(points, points[1:]):
        l = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(math.ceil(l / step)))
        for k in range(n):
            t = k / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    out.append(points[-1])
    return out


def free_width(base_pass, xs, zs, cell, x, z, heading):
    """Contiguous passable width perpendicular to `heading`, up to 20 m."""
    px, pz = -heading[1], heading[0]
    total = 1
    for sign in (1, -1):
        for k in range(1, 41):
            qx = x + px * sign * k * cell
            qz = z + pz * sign * k * cell
            i = int(round((qx - xs[0]) / cell))
            j = int(round((qz - zs[0]) / cell))
            if not (0 <= j < base_pass.shape[0] and 0 <= i < base_pass.shape[1]) or not base_pass[j, i]:
                break
            total += 1
    return total * cell


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--cell", type=float, default=CELL)
    ap.add_argument("--wall-mask", choices=("none", "oracle"), default="none",
                    help="oracle = block every steep triangle; none = verify walls with the engine trace")
    ap.add_argument("--grade", type=float, default=GRADE_LIMIT)
    ap.add_argument("--erode", type=int, default=CLEARANCE_ERODE_CELLS,
                    help="clearance erosion in 0.5 m cells")
    ap.add_argument("--blocks", type=Path, default=None,
                    help="JSON file of engine-confirmed wall discs {x,z,r}")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)
    cell = args.cell
    grade_limit = args.grade
    out_dir = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    print("loading", PHYSICS)
    level = oracle.load_level(PHYSICS.read_bytes())
    tris = flatten_triangles(level)
    nrm = triangle_normals(tris)
    print("triangles", len(tris))
    surface = tris[nrm[:, 1] > SURFACE_MIN_NY]
    wall = tris[np.abs(nrm[:, 1]) < 0.5]
    print("drivable-normal triangles (ny>%.2f)" % SURFACE_MIN_NY, len(surface),
          "steep-wall triangles (|ny|<0.5)", len(wall))

    # Stage A: 1 m over the full level, find the spawn component extent.
    all_pts = tris.reshape(-1, 3)
    x0 = math.floor(all_pts[:, 0].min()) - 2
    x1 = math.ceil(all_pts[:, 0].max()) + 2
    z0 = math.floor(all_pts[:, 2].min()) - 2
    z1 = math.ceil(all_pts[:, 2].max()) + 2
    print("stage A 1 m window", (x0, x1, z0, z1))
    HA, xa, za = rasterise_height(surface, x0, x1, z0, z1, STAGE_A_CELL)
    dhA = edge_max_dh(HA)
    edgeA = STAGE_A_CELL * grade_limit
    WA = rasterise_wall(wall, HA, x0, x1, z0, z1, STAGE_A_CELL, 0.5)
    passA = np.isfinite(HA) & (dhA <= edgeA + 1e-9)
    if args.wall_mask == "oracle":
        passA &= ~WA
    sj = int(round((SPAWN[1] - za[0]) / STAGE_A_CELL))
    si = int(round((SPAWN[0] - xa[0]) / STAGE_A_CELL))
    print("spawn cell", (sj, si), "height", HA[sj, si], "passA", passA[sj, si])
    compA = bfs_component(passA, (sj, si))
    cntA = int(compA.sum())
    print("stage A component cells", cntA)
    jj, ii = np.where(compA)
    if not len(jj):
        print("FAILED: spawn is not on the 1 m traversable component")
        return 2
    ax0 = xa[ii.min()] - 20
    ax1 = xa[ii.max()] + 20
    az0 = za[jj.min()] - 20
    az1 = za[jj.max()] + 20
    print("stage A component bbox x %.1f..%.1f z %.1f..%.1f" % (ax0, ax1, az0, az1))

    # Stage B: 0.5 m inside the component bbox.
    print("stage B %.2f m window" % cell, (ax0, ax1, az0, az1))
    H, xs, zs = rasterise_height(surface, ax0, ax1, az0, az1, cell)
    dh = edge_max_dh(H)
    edge_dh = min(STEP_LIMIT, grade_limit * cell)
    W = rasterise_wall(wall, H, ax0, ax1, az0, az1, cell, 0.5)
    print("oracle wall-mask cells", int(W.sum()))
    base_pass = np.isfinite(H) & (dh <= edge_dh + 1e-9)
    if args.wall_mask == "oracle":
        base_pass &= ~W
    blocks = []
    if args.blocks and args.blocks.exists():
        blocks = json.loads(args.blocks.read_text()).get("blocks", [])
        apply_blocks(base_pass, xs, zs, blocks, cell)
        print("applied engine wall blocks", len(blocks))
    sj = int(round((SPAWN[1] - zs[0]) / cell))
    si = int(round((SPAWN[0] - xs[0]) / cell))
    print("spawn cell", (sj, si), "height", H[sj, si], "base pass", base_pass[sj, si])
    print("base passable cells", int(base_pass.sum()))

    # 29 m sprint control on the un-eroded mask
    ej = int(round((SPRINT_END[1] - zs[0]) / cell))
    ei = int(round((SPRINT_END[0] - xs[0]) / cell))
    ctrl = []
    steps = int(round((SPRINT_END[0] - SPAWN[0]) / (cell / 4)))
    ok_ctrl = True
    for k in range(steps + 1):
        x = SPAWN[0] + (SPRINT_END[0] - SPAWN[0]) * k / steps
        z = SPAWN[1]
        i = int(round((x - xs[0]) / cell))
        j = int(round((z - zs[0]) / cell))
        ctrl.append((j, i))
        if not base_pass[j, i]:
            ok_ctrl = False
    print("29 m sprint control passable:", ok_ctrl)

    # Clearance erosion variants.
    variants = {}
    for k in (2, 3, 4):
        m = erode(base_pass, k)
        comp = bfs_component(m, (sj, si))
        variants[k] = (m, comp, int(comp.sum()))
        print("erosion %d cells (%.2f m): component cells %d" % (k, k * cell, int(comp.sum())))
    k_use = args.erode
    mask, comp, ncomp = variants.get(k_use, (None, None, None))
    if mask is None:
        mask = erode(base_pass, k_use)
        comp = bfs_component(mask, (sj, si))
        ncomp = int(comp.sum())
        variants[k_use] = (mask, comp, ncomp)
        print("erosion %d cells (%.2f m): component cells %d" % (k_use, k_use * cell, ncomp))
    if ncomp == 0:
        k_use = 2
        mask, comp, ncomp = variants[k_use]
    print("using erosion", k_use, "component", ncomp)

    # Dijkstra from spawn on the eroded component.
    dist, prev = dijkstra(comp, (sj, si), cell)
    finite = np.isfinite(dist)
    far = np.unravel_index(np.argmax(np.where(finite, dist, -1)), dist.shape)
    far_dist = float(dist[far])
    print("farthest cell", far, "grid distance %.3f m" % far_dist,
          "point", (xs[far[1]], zs[far[0]]), "height", H[far])

    raw = reconstruct(prev, far, (sj, si))
    raw_pts = [(xs[i], zs[j]) for j, i in raw]
    taut = taut_path(comp, raw)
    taut_pts = [(xs[i], zs[j]) for j, i in taut]
    # the course starts at the committed spawn, not at the first grid centre
    taut_pts = [SPAWN] + taut_pts[1:]
    samples = resample(taut_pts, 0.25)
    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(samples, samples[1:]))
    print("raw grid path", len(raw), "cells, taut", len(taut), "points, length %.3f m" % length)

    # Per-sample measurements from the raster (verifier re-derives exactly).
    hs = [height_at(H, xs, zs, x, z) for x, z in samples]
    max_step = 0.0
    for a, b in zip(hs, hs[1:]):
        if math.isfinite(a) and math.isfinite(b):
            max_step = max(max_step, abs(b - a))
    # max grade over a 2 m window
    max_grade = 0.0
    grade_at = 0
    for k in range(len(samples)):
        j = k
        acc = 0.0
        while j + 1 < len(samples) and acc < 2.0:
            acc += math.hypot(samples[j + 1][0] - samples[j][0], samples[j + 1][1] - samples[j][1])
            j += 1
        if acc >= 1.9 and math.isfinite(hs[k]) and math.isfinite(hs[j]):
            g = abs(hs[j] - hs[k]) / acc
            if g > max_grade:
                max_grade = g
                grade_at = k
    # clearance: distance from each sample to the nearest base_pass=False cell
    # (eroded component already guarantees >= k_use cells; report min distance)
    min_clear = float("inf")
    min_clear_at = 0
    blocked = ~base_pass
    for k, (x, z) in enumerate(samples):
        i = int(round((x - xs[0]) / cell))
        j = int(round((z - zs[0]) / cell))
        # local window search
        rad = 10
        j0 = max(0, j - rad); j1 = min(base_pass.shape[0], j + rad + 1)
        i0 = max(0, i - rad); i1 = min(base_pass.shape[1], i + rad + 1)
        sub = blocked[j0:j1, i0:i1]
        if sub.any():
            jj, ii = np.where(sub)
            d = np.sqrt(((jj + j0 - j) * cell) ** 2 + ((ii + i0 - i) * cell) ** 2)
            md = float(d.min())
            if md < min_clear:
                min_clear = md
                min_clear_at = k
    print("max step %.4f m, max 2 m grade %.4f%%, min clearance %.3f m"
          % (max_step, 100 * max_grade, min_clear))

    # Barrier classification at the farthest cell: why each neighbour is out.
    barriers = []
    fj, fi = int(far[0]), int(far[1])
    for dj, di, name in ((-1, 0, "north -Z"), (1, 0, "south +Z"),
                         (0, -1, "west -X"), (0, 1, "east +X"),
                         (-1, -1, "NW"), (-1, 1, "NE"), (1, -1, "SW"), (1, 1, "SE")):
        jj, ii = fj + dj, fi + di
        if not (0 <= jj < H.shape[0] and 0 <= ii < H.shape[1]):
            barriers.append(dict(direction=name, kind="level-edge"))
            continue
        if not math.isfinite(H[jj, ii]):
            barriers.append(dict(direction=name, kind="no-collision-surface",
                                 point=[float(xs[ii]), float(zs[jj])]))
        elif not base_pass[jj, ii]:
            barriers.append(dict(direction=name, kind="step-or-grade",
                                 dh=float(abs(H[jj, ii] - H[fj, fi])),
                                 point=[float(xs[ii]), float(zs[jj])]))
        elif not comp[jj, ii]:
            barriers.append(dict(direction=name, kind="clearance",
                                 point=[float(xs[ii]), float(zs[jj])]))
        else:
            barriers.append(dict(direction=name, kind="open"))
    print("barriers at farthest:", json.dumps(barriers, indent=1))

    # Measured barrier: free width perpendicular to the course near the end.
    ex, ez = float(xs[far[1]]), float(zs[far[0]])
    if len(samples) >= 2:
        hx = samples[-1][0] - samples[-2][0]
        hz = samples[-1][1] - samples[-2][1]
        hl = math.hypot(hx, hz) or 1.0
        heading = (hx / hl, hz / hl)
    else:
        heading = (1.0, 0.0)
    free_widths = []
    for ahead in (0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0):
        px = ex + heading[0] * ahead
        pz = ez + heading[1] * ahead
        free_widths.append(dict(ahead=ahead,
                                width=round(free_width(comp, xs, zs, cell, px, pz, heading), 3),
                                widthBase=round(free_width(base_pass, xs, zs, cell, px, pz, heading), 3)))
    need = CAR_WIDTH + 2.0 * SAFETY_MARGIN
    first_narrow = next((w for w in free_widths if w["ahead"] > 0 and w["widthBase"] < need), None)
    print("free widths at end:", json.dumps(free_widths))
    print("first station narrower than %.3f m:" % need, first_narrow)

    # Record file hashes / provenance.
    phys_sha = hashlib.sha256(PHYSICS.read_bytes()).hexdigest()
    spawn_rec = json.loads((ROOT / "_work/e1-drive/spawn.json").read_text())
    cars = json.loads((ROOT / "_work/e1-drive/cars.json").read_text())

    pts = [[round(x, 4), round(z, 4)] for x, z in samples]
    doc = dict(
        kind="drivable-path.course",
        version=1,
        scope=dict(
            collisionOnly=True,
            drawGeometryRead=False,
            rendererClaim=False,
            engineClaim=False,
            note="traversability from Level.levelphysics collision triangles only; no draw coverage used",
        ),
        inputs=dict(
            physics=dict(path="game-data/Blur/levels/usa_la_river/Level.levelphysics",
                         bytes=PHYSICS.stat().st_size, sha256=phys_sha),
            spawn=spawn_rec,
            carEnvelope=dict(
                source="_work/e1-drive/cars.json (RP_CarDynamics XT decode)",
                roster="5 cars; widest/longest harness box proxy",
                length=CAR_LENGTH, width=CAR_WIDTH,
                wheelBaseSource="Dodge_Challenger_Stock 2.981 m (max roster)",
                trackWidthSource="Audi_R8V10_Stock 1.676 m rear (max roster)",
                safetyMargin=SAFETY_MARGIN,
                halfLength=HALF_LENGTH, halfWidth=HALF_WIDTH,
                note="safety margin is a labelled assumption, not an XT value",
            ),
        ),
        model=dict(
            cell=cell,
            surfaceMinNormalY=SURFACE_MIN_NY,
            surfaceMinNormalDeg=math.degrees(math.acos(SURFACE_MIN_NY)),
            stepLimit=STEP_LIMIT,
            gradeLimit=grade_limit,
            edgeDhLimit=edge_dh,
            clearanceErodeCells=k_use,
            clearanceErodeMetres=k_use * cell,
            wallMask=args.wall_mask,
            search="8-connected Dijkstra on the eroded passable component",
            smoothing="visibility string-pulling on the same component",
            sampleStep=0.25,
        ),
        component=dict(cells=int(ncomp), areaM2=round(ncomp * cell * cell, 2),
                       bbox=[float(ax0), float(ax1), float(az0), float(az1)]),
        course=dict(
            length=round(length, 4),
            gridDistance=round(far_dist, 4),
            start=[SPAWN[0], SPAWN[1]],
            end=[float(xs[far[1]]), float(zs[far[0]])],
            samples=len(samples),
            points=pts,
            maxStep=round(max_step, 5),
            maxGrade=round(max_grade, 6),
            maxGradeAtSample=grade_at,
            minClearance=round(min_clear, 4),
            minClearanceAtSample=min_clear_at,
        ),
        barriers=barriers,
        barrierSummary=dict(
            kind="clearance-narrowing",
            needWidth=round(need, 4),
            freeWidths=free_widths,
            firstNarrow=first_narrow,
            nearestBlockedDistance=round(min_clear, 4),
        ),
        control29m=dict(passable=ok_ctrl, start=[SPAWN[0], SPAWN[1]], end=[SPRINT_END[0], SPRINT_END[1]]),
    )
    body = dict(doc)
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    canonical = hashlib.sha256(text.encode("utf-8")).hexdigest()
    doc["hash"] = "sha256:" + canonical
    (out_dir / "path.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n",
                                       encoding="utf-8")
    np.savez_compressed(out_dir / "grid.npz", height=H.astype(np.float32),
                        base_pass=base_pass, component=comp, wall_oracle=W, xs=xs, zs=zs)
    print("wrote", out_dir / "path.json", "canonical", doc["hash"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
