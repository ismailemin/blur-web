#!/usr/bin/env python3
"""Free-roam drivable regions around the committed USA LA River spawn.

This is a data-only probe. It asks how much *car-clearance* drivable surface
exists around the E1 spawn on `Level.levelphysics`, which connected regions it
forms, and which of those regions are actually covered by the committed draw
geometry. It does not render a frame, run the engine, or claim a game.

Model (same constants as P48 `probes/drivable-path/tools/build_path.py`):

  * 0.5 m XZ grid over a 1,000 x 1,000 m study window around the spawn;
  * drivable surface = highest up-facing collision triangle with normal.y > 0.94;
  * adjacent-cell step/grade: max height difference <= min(0.05 m, 5 % * 0.5 m)
    = 0.025 m;
  * wall mask = steep triangles (|normal.y| < 0.5) whose height band reaches
    local ground +0.05 ... +2.0 m, projected to XZ and dilated by 0.5 m;
  * car-clearance masks = the passable mask eroded by 2 cells (1.0 m, the P48
    search mask) and by 3 cells (1.5 m, a stricter clearance sensitivity);
  * car envelope = 2.981 m x 1.676 m box proxy (widest/longest XT roster car)
    plus a labelled 0.30 m margin, half-width 1.138 m.

Draw coverage uses the pinned P41 46-section draw map (read-only):

  * collision height = highest up-facing collision triangle (normal.y > 0.5)
    containing the test point;
  * visual height = the draw triangle (normal.y > 0.1) containing the point whose
    height is nearest the collision height;
  * covered = a draw triangle exists and |visual - collision| <= 0.5 m;
  * per-region area coverage is sampled on a 1.0 m lattice (every second 0.5 m
    cell); the car-width band is measured separately along each region's
    geodesic spine with seven stations (0, +-0.419, +-0.838, +-1.138 m).

Outputs (all under `_work/free-roam/`):

  regions.json          regions, areas, bounds, hulls, width, barriers, coverage,
                        separations, P48 control, recommendation, hashes
  regions-samples.json  per-cell coverage samples for the detailed regions
  free-roam.svg         top-down map (regions, walls, draw coverage, P48 course)
  free-roam.png         raster copy of the same map
  free-roam.html        the map with the result table
  grid.npz              deterministic rasters (height, passable, wall, labels)

Usage:
    python probes/free-roam/tools/build_regions.py
"""
from __future__ import annotations

import hashlib
import heapq
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
import reference_oracle as oracle  # noqa: E402

OUT = ROOT / "_work/free-roam"
PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
VISUAL_JSON = ROOT / "_work/track-coverage/visual.json"
SPAWN_JSON = ROOT / "_work/e1-drive/spawn.json"
P48_JSON = ROOT / "_work/drivable-path/path.json"

# Pinned inputs: a different file is a hard failure, never a silent fallback.
PHYSICS_SHA256 = "1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28"
VISUAL_SHA256 = "877b4dc7e1f5ece197f0776239b33d23b0350f8cf77ef462c0c7a266a6abcb67"
VISUAL_KIND = ("track-coverage.visual-sections", 1)
P48_KIND = ("drivable-path.course", 1)
P48_CANONICAL = "sha256:4b725b10e6619e7cc2f3ef0b0ea03f3a252660a8ffaad0ffe04cb96e0318605b"
P48_LENGTH = 310.3952

# Study window: 1 km square around the committed spawn (-88, 1050).
WINDOW = (-300.0, 700.0, 650.0, 1650.0)
SPAWN = (-88.0, 1050.0)

# P48 model constants.
CELL = 0.5
SURFACE_MIN_NY = 0.94
STEP_LIMIT = 0.05
GRADE_LIMIT = 0.05
EDGE_DH = min(STEP_LIMIT, GRADE_LIMIT * CELL)      # 0.025 m
WALL_RADIUS = 0.5
WALL_BAND_LOW = 0.05
WALL_BAND_HIGH = 2.0
CAR_LENGTH = 2.981
CAR_WIDTH = 1.676
SAFETY_MARGIN = 0.30
HALF_LENGTH = CAR_LENGTH / 2.0 + SAFETY_MARGIN      # 1.7905
HALF_WIDTH = CAR_WIDTH / 2.0 + SAFETY_MARGIN        # 1.138
P48_ERODE_CELLS = 2                                  # 1.0 m, P48 search mask
STRICT_ERODE_CELLS = int(math.ceil(HALF_WIDTH / CELL))  # 3 cells = 1.5 m

# Coverage rules.
COLLISION_NY_MIN = 0.5
VISUAL_NY_MIN = 0.1
COVER_TOL = 0.5
COVERAGE_STRIDE = 2                # 1.0 m area-coverage lattice
BUCKET = 4.0
STATIONS = (0.0, -0.419, 0.419, -0.838, 0.838, -1.138, 1.138)
ENVELOPE_STATIONS = STATIONS[:5]
MARGIN_STATIONS = STATIONS

# Region reporting.
MIN_DETAIL_AREA = 500.0            # m^2
MIN_REGION_AREA = 500.0            # m^2
MAX_DETAIL_REGIONS = 16

PALETTE = ("#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#06b6d4",
           "#ef4444", "#84cc16", "#e879f9", "#14b8a6", "#f97316",
           "#60a5fa", "#4ade80", "#fbbf24", "#c084fc", "#22d3ee")


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(doc: dict) -> str:
    body = dict(doc)
    body.pop("hash", None)
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + sha256_bytes(text.encode("utf-8"))


def triangle_normal(a, b, c):
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    return nx / length, ny / length, nz / length


def percentile(values, q):
    if not values:
        return 0.0
    pos = min(len(values) - 1, max(0, int(round(q * (len(values) - 1)))))
    return float(values[pos])


def content_digest(arrays):
    """Deterministic digest of array contents (the npz container is not byte-stable)."""
    h = hashlib.sha256()
    per = {}
    for key in sorted(arrays):
        a = np.ascontiguousarray(arrays[key])
        sub = hashlib.sha256()
        sub.update(key.encode("ascii"))
        sub.update(str(a.dtype).encode("ascii"))
        sub.update(str(a.shape).encode("ascii"))
        sub.update(a.tobytes())
        per[key] = sub.hexdigest()
        h.update(sub.digest())
    return h.hexdigest(), per


# --------------------------------------------------------------------------- #
# collision raster
# --------------------------------------------------------------------------- #

def flatten_collision():
    level = oracle.load_level(PHYSICS.read_bytes())
    triangles = []
    for mesh in level["meshes"]:
        verts = mesh["vertices"]
        for tri in mesh["triangles"]:
            leaf = mesh["leaves"][tri["leaf"]]
            base = leaf["vertex_start"]
            triangles.append((verts[base + tri["a"]],
                              verts[base + tri["b"]],
                              verts[base + tri["c"]]))
    return np.asarray(triangles, dtype=np.float64), len(level["meshes"])


def raster_height(tris, x0, x1, z0, z1, cell):
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
        inside = (l1 >= -1e-9) & (l2 >= -1e-9) & (l3 >= -1e-9)
        if not inside.any():
            continue
        h = l1 * a[1] + l2 * b[1] + l3 * c[1]
        sub = H[j0:j1 + 1, i0:i1 + 1]
        sub[inside] = np.maximum(sub[inside], h[inside])
    H[~np.isfinite(H)] = np.nan
    return H, xs, zs


def edge_max_dh(H):
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


def raster_wall(wall, H, x0, x1, z0, z1, cell, radius):
    nx = int(round((x1 - x0) / cell)) + 1
    nz = int(round((z1 - z0) / cell)) + 1
    W = np.zeros((nz, nx), dtype=bool)
    xs = x0 + np.arange(nx) * cell
    zs = z0 + np.arange(nz) * cell
    for t in wall:
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
        gate = np.isfinite(Hsub) & (t_ymin < Hsub + WALL_BAND_HIGH) & (t_ymax > Hsub + WALL_BAND_LOW)
        if not gate.any():
            continue
        gx, gz = np.meshgrid(xs[i0:i1 + 1], zs[j0:j1 + 1])
        den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
        inside = np.zeros(gx.shape, dtype=bool)
        if abs(den) > 1e-12:
            l1 = ((bz - cz) * (gx - cx) + (cx - bx) * (gz - cz)) / den
            l2 = ((cz - az) * (gx - cx) + (ax - cx) * (gz - cz)) / den
            l3 = 1.0 - l1 - l2
            inside = (l1 >= 0) & (l2 >= 0) & (l3 >= 0)
        d = np.full(gx.shape, np.inf)
        for (px, pz, qx, qz) in ((ax, az, bx, bz), (bx, bz, cx, cz), (cx, cz, ax, az)):
            dx, dz = qx - px, qz - pz
            l2v = dx * dx + dz * dz
            if l2v == 0:
                dd = np.hypot(gx - px, gz - pz)
            else:
                tt = np.clip(((gx - px) * dx + (gz - pz) * dz) / l2v, 0.0, 1.0)
                dd = np.hypot(gx - (px + tt * dx), gz - (pz + tt * dz))
            d = np.minimum(d, dd)
        m = (inside | (d <= radius)) & gate
        if m.any():
            W[j0:j1 + 1, i0:i1 + 1] |= m
    return W


def erode(mask, k):
    out = mask.copy()
    nz, nx = out.shape
    for _ in range(k):
        p = np.pad(out, 1, constant_values=False)
        nxt = np.ones_like(out)
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                nxt &= p[1 + dj:1 + dj + nz, 1 + di:1 + di + nx]
        out = nxt
    return out


def label_components(mask):
    """Deterministic 8-connected component labelling; returns labels, sizes, first cells."""
    nz, nx = mask.shape
    labels = np.zeros((nz, nx), dtype=np.int32)
    sizes = []
    first = []
    for j, i in np.argwhere(mask):
        if labels[j, i]:
            continue
        lab = len(sizes) + 1
        stack = [(j, i)]
        labels[j, i] = lab
        count = 0
        fj, fi = j, i
        while stack:
            cj, ci = stack.pop()
            count += 1
            for dj in (-1, 0, 1):
                for di in (-1, 0, 1):
                    if dj == 0 and di == 0:
                        continue
                    jj, ii = cj + dj, ci + di
                    if 0 <= jj < nz and 0 <= ii < nx and mask[jj, ii] and not labels[jj, ii]:
                        labels[jj, ii] = lab
                        stack.append((jj, ii))
        sizes.append(count)
        first.append((fj, fi))
    return labels, sizes, first


# --------------------------------------------------------------------------- #
# geodesic helpers
# --------------------------------------------------------------------------- #

def dijkstra(mask, start, cell):
    nz, nx = mask.shape
    dist = np.full((nz, nx), np.inf)
    prev = np.full((nz, nx, 2), -1, dtype=np.int32)
    if not mask[start]:
        return dist, prev
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
            if dj != 0 and di != 0 and not (mask[j, ii] and mask[jj, i]):
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
    while (j, i) != start and j >= 0:
        path.append((j, i))
        pj, pi = prev[j, i]
        j, i = int(pj), int(pi)
    path.append(start)
    path.reverse()
    return path


def crop_mask(mask):
    cells = np.argwhere(mask)
    if not len(cells):
        return None
    j0, i0 = cells.min(axis=0)
    j1, i1 = cells.max(axis=0)
    return (int(j0), int(j1), int(i0), int(i1))


def region_geodesics(region):
    """Four-seed double sweep diameter and the path from the spawn cell.

    Returns a compact record with global cell coordinates.
    """
    box = crop_mask(region)
    if box is None:
        return None
    j0, j1, i0, i1 = box
    sub = region[j0:j1 + 1, i0:i1 + 1]
    local_cells = np.argwhere(sub)

    seeds = [tuple(local_cells[0]),
             tuple(local_cells[np.argmin(local_cells[:, 1])]),
             tuple(local_cells[np.argmax(local_cells[:, 1])]),
             tuple(local_cells[np.argmin(local_cells[:, 0])]),
             tuple(local_cells[np.argmax(local_cells[:, 0])]),
             tuple(local_cells[np.argmin(local_cells[:, 0] + local_cells[:, 1])]),
             tuple(local_cells[np.argmax(local_cells[:, 0] + local_cells[:, 1])])]

    best = None  # (length, a_local, b_local, dist, prev, start)
    seen = set()
    for s in seeds:
        if s in seen:
            continue
        seen.add(s)
        d1, _ = dijkstra(sub, s, CELL)
        a = np.unravel_index(np.argmax(np.where(np.isfinite(d1), d1, -1)), d1.shape)
        if not np.isfinite(d1[a]):
            continue
        d2, p2 = dijkstra(sub, a, CELL)
        b = np.unravel_index(np.argmax(np.where(np.isfinite(d2), d2, -1)), d2.shape)
        length = float(d2[b])
        if best is None or length > best[0] + 1e-9:
            best = (length, a, b, d2, p2)
    if best is None:
        return None
    length, a, b, dist, prev = best
    path = reconstruct(prev, b, a)
    path_global = [(int(j + j0), int(i + i0)) for j, i in path]
    return dict(length=length, a=(int(a[0] + j0), int(a[1] + i0)),
                b=(int(b[0] + j0), int(b[1] + i0)), path=path_global)


def spawn_geodesic(region, spawn_cell):
    box = crop_mask(region)
    j0, j1, i0, i1 = box
    sub = region[j0:j1 + 1, i0:i1 + 1]
    sj, si = spawn_cell[0] - j0, spawn_cell[1] - i0
    if not (0 <= sj < sub.shape[0] and 0 <= si < sub.shape[1] and sub[sj, si]):
        return None
    dist, prev = dijkstra(sub, (sj, si), CELL)
    far = np.unravel_index(np.argmax(np.where(np.isfinite(dist), dist, -1)), dist.shape)
    length = float(dist[far])
    path = reconstruct(prev, far, (sj, si))
    path_global = [(int(j + j0), int(i + i0)) for j, i in path]
    return dict(length=length, end=(int(far[0] + j0), int(far[1] + i0)), path=path_global)


def resample_cells(path, step_m):
    """Resample a cell path at step_m; returns (x_index, z_index) float pairs."""
    pts = [(float(c[1]), float(c[0])) for c in path]
    if len(pts) < 2:
        return pts
    step_cells = step_m / CELL
    out = [pts[0]]
    remainder = step_cells
    for a, b in zip(pts, pts[1:]):
        seg = math.hypot(b[0] - a[0], b[1] - a[1])
        if seg == 0:
            continue
        t = 0.0
        while seg - t >= remainder - 1e-12:
            t += remainder
            out.append((a[0] + (b[0] - a[0]) * t / seg,
                        a[1] + (b[1] - a[1]) * t / seg))
            remainder = step_cells
        remainder -= (seg - t)
    if out[-1] != pts[-1]:
        out.append(pts[-1])
    return out


def width_profile(region, path_cells, cell, step_m=5.0, cap_m=60.0):
    if len(path_cells) < 2:
        return dict(stations=0)
    pts = resample_cells(path_cells, step_m)
    widths = []
    for k, (pi, pj) in enumerate(pts):
        a = pts[max(0, k - 1)]
        b = pts[min(len(pts) - 1, k + 1)]
        fx, fz = b[0] - a[0], b[1] - a[1]
        norm = math.hypot(fx, fz) or 1.0
        px, pz = -fz / norm, fx / norm
        i0 = int(round(pi))
        j0 = int(round(pj))
        # snap to a region cell if the interpolated point rounds outside a corner
        found = False
        if 0 <= j0 < region.shape[0] and 0 <= i0 < region.shape[1] and region[j0, i0]:
            found = True
        else:
            for dj in (-1, 0, 1):
                for di in (-1, 0, 1):
                    jj, ii = int(round(pj)) + dj, int(round(pi)) + di
                    if 0 <= jj < region.shape[0] and 0 <= ii < region.shape[1] and region[jj, ii]:
                        i0, j0, found = ii, jj, True
                        break
                if found:
                    break
        if not found:
            widths.append(0.0)
            continue
        total = cell
        for sign in (1, -1):
            run = 0.0
            kk = 0
            while run < cap_m:
                kk += 1
                i = int(round(i0 + px * sign * kk))
                j = int(round(j0 + pz * sign * kk))
                if not (0 <= j < region.shape[0] and 0 <= i < region.shape[1]) or not region[j, i]:
                    break
                run += cell
            total += run
        widths.append(total)
    widths_sorted = sorted(widths)
    return dict(stations=len(widths), stepMetres=step_m, capMetres=cap_m, min=round(widths_sorted[0], 2),
                p05=round(percentile(widths_sorted, 0.05), 2),
                median=round(percentile(widths_sorted, 0.5), 2),
                mean=round(sum(widths) / len(widths), 2),
                max=round(widths_sorted[-1], 2),
                samples=[round(w, 2) for w in widths])


def max_inscribed_width(region):
    """Chamfer distance transform + exact local Euclidean correction.

    The region is cropped to its own bbox and padded with non-region cells so a
    window-clipped region cannot invent clearance at the study-window edge.
    """
    box = crop_mask(region)
    if box is None:
        return dict(radiusMetres=0.0, widthMetres=0.0, cell=[0, 0])
    gj0, gj1, gi0, gi1 = box
    crop = region[gj0:gj1 + 1, gi0:gi1 + 1]
    nz, nx = crop.shape
    R = np.pad(crop, 1, constant_values=False)
    pz, px = R.shape
    INF = 1e9
    s2 = math.sqrt(2.0)
    D = np.where(R, INF, 0.0)
    for j in range(1, pz):
        row = D[j]
        up = D[j - 1]
        for i in range(px):
            if not R[j, i]:
                continue
            best = row[i]
            if up[i] + 1.0 < best:
                best = up[i] + 1.0
            if i > 0 and up[i - 1] + s2 < best:
                best = up[i - 1] + s2
            if i + 1 < px and up[i + 1] + s2 < best:
                best = up[i + 1] + s2
            row[i] = best
        for i in range(1, px):
            if row[i - 1] + 1.0 < row[i]:
                row[i] = row[i - 1] + 1.0
        for i in range(px - 2, -1, -1):
            if row[i + 1] + 1.0 < row[i]:
                row[i] = row[i + 1] + 1.0
    for j in range(pz - 2, -1, -1):
        row = D[j]
        dn = D[j + 1]
        for i in range(px):
            if not R[j, i]:
                continue
            best = row[i]
            if dn[i] + 1.0 < best:
                best = dn[i] + 1.0
            if i > 0 and dn[i - 1] + s2 < best:
                best = dn[i - 1] + s2
            if i + 1 < px and dn[i + 1] + s2 < best:
                best = dn[i + 1] + s2
            row[i] = best
        for i in range(1, px):
            if row[i - 1] + 1.0 < row[i]:
                row[i] = row[i - 1] + 1.0
        for i in range(px - 2, -1, -1):
            if row[i + 1] + 1.0 < row[i]:
                row[i] = row[i + 1] + 1.0
    interior = D[1:-1, 1:-1]
    flat = int(np.argmax(interior))
    j, i = np.unravel_index(flat, interior.shape)
    radius_cells = float(interior[j, i])
    # exact correction: distance from (j,i) to every non-region cell in a local window
    rad = int(math.ceil(radius_cells)) + 3
    j0, j1 = max(0, j - rad), min(nz, j + rad + 1)
    i0, i1 = max(0, i - rad), min(nx, i + rad + 1)
    local = crop[j0:j1, i0:i1]
    jj, ii = np.where(~local)
    if len(jj):
        exact = float(np.sqrt((jj + j0 - j) ** 2 + (ii + i0 - i) ** 2).min()) * CELL
    else:
        exact = radius_cells * CELL
    return dict(radiusMetres=round(exact, 3), widthMetres=round(2.0 * exact, 3),
                cell=[int(j + gj0), int(i + gi0)])


def enclosed_holes(region, xs, zs):
    """Count non-region components fully enclosed by the region (topological holes)."""
    box = crop_mask(region)
    if box is None:
        return dict(count=0, largestAreaM2=0.0, holes=[])
    j0, j1, i0, i1 = box
    crop = region[j0:j1 + 1, i0:i1 + 1]
    pad = np.pad(crop, 1, constant_values=False)
    out = ~pad
    lab, sizes, _ = label_components(out)
    holes = []
    for k, size in enumerate(sizes):
        q = k + 1
        cc = np.argwhere(lab == q)
        touches = bool((cc[:, 0] == 0).any() or (cc[:, 0] == pad.shape[0] - 1).any()
                       or (cc[:, 1] == 0).any() or (cc[:, 1] == pad.shape[1] - 1).any())
        if touches:
            continue
        holes.append(dict(
            areaM2=round(float(size) * CELL * CELL, 2),
            centroid=[round(float(xs[i0 + int(round(cc[:, 1].mean())) - 1]), 2),
                      round(float(zs[j0 + int(round(cc[:, 0].mean())) - 1]), 2)],
        ))
    holes.sort(key=lambda h: (-h["areaM2"], h["centroid"]))
    return dict(count=len(holes), largestAreaM2=holes[0]["areaM2"] if holes else 0.0,
                holes=holes[:5])


def wall_vertical_range(x, z, wall_tris, radius=3.0):
    """Vertical range of steep triangles within `radius` of (x,z) in XZ."""
    ymin = None
    ymax = None
    count = 0
    for t in wall_tris:
        best = 1e9
        for a, b in ((0, 1), (1, 2), (2, 0)):
            px, pz = t[a][0], t[a][2]
            qx, qz = t[b][0], t[b][2]
            dx, dz = qx - px, qz - pz
            l2 = dx * dx + dz * dz
            tt = 0.0 if l2 == 0 else max(0.0, min(1.0, ((x - px) * dx + (z - pz) * dz) / l2))
            best = min(best, math.hypot(x - (px + tt * dx), z - (pz + tt * dz)))
            if best == 0.0:
                break
        if best <= radius:
            count += 1
            ty0 = min(t[0][1], t[1][1], t[2][1])
            ty1 = max(t[0][1], t[1][1], t[2][1])
            ymin = ty0 if ymin is None else min(ymin, ty0)
            ymax = ty1 if ymax is None else max(ymax, ty1)
    if ymin is None:
        return None
    return dict(triangles=count, yMin=round(float(ymin), 3), yMax=round(float(ymax), 3),
                heightMetres=round(float(ymax - ymin), 3))


def convex_hull(points):
    pts = sorted(set((round(float(x), 3), round(float(y), 3)) for x, y in points))
    if len(pts) <= 2:
        return [[p[0], p[1]] for p in pts]
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return [[p[0], p[1]] for p in lower[:-1] + upper[:-1]]


# --------------------------------------------------------------------------- #
# draw coverage
# --------------------------------------------------------------------------- #

def load_visual():
    raw = VISUAL_JSON.read_bytes()
    digest = sha256_bytes(raw)
    if digest != VISUAL_SHA256:
        raise SystemExit("build_regions: BLOCKED: %s is not the pinned draw map (%s != %s)"
                         % (VISUAL_JSON.name, digest, VISUAL_SHA256))
    doc = json.loads(raw)
    if (doc.get("kind"), doc.get("version")) != VISUAL_KIND:
        raise SystemExit("build_regions: BLOCKED: unexpected draw map kind/version")
    sections = [s for s in doc["sections"] if s.get("status") == "ok"]
    return doc, sections, digest


def build_visual_triangles(sections):
    triangles = []
    owner = []
    for si, section in enumerate(sections):
        positions = section["positions"]
        indices = section["indices"]
        ranges = [(d["firstIndex"], d["firstIndex"] + d["indexCount"], di, d)
                  for di, d in enumerate(section["draws"])]
        for offset in range(0, len(indices), 3):
            found = None
            for first, end, di, d in ranges:
                if first <= offset < end:
                    found = (di, d)
                    break
            if found is None:
                raise SystemExit("build_regions: FAILED: triangle %d of %s is outside every draw"
                                 % (offset, section["key"]))
            ia, ib, ic = indices[offset], indices[offset + 1], indices[offset + 2]
            a = (positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2])
            b = (positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2])
            c = (positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2])
            if triangle_normal(a, b, c)[1] <= VISUAL_NY_MIN:
                continue
            triangles.append((a, b, c))
            owner.append((si, offset, found[0], found[1]))
    return triangles, owner


class BucketIndex:
    def __init__(self, triangles, bucket=BUCKET):
        self.bucket = bucket
        self.buckets = defaultdict(list)
        for idx, t in enumerate(triangles):
            a, b, c = t
            i0 = int(math.floor(min(a[0], b[0], c[0]) / bucket))
            i1 = int(math.floor(max(a[0], b[0], c[0]) / bucket))
            j0 = int(math.floor(min(a[2], b[2], c[2]) / bucket))
            j1 = int(math.floor(max(a[2], b[2], c[2]) / bucket))
            for bx in range(i0, i1 + 1):
                for bz in range(j0, j1 + 1):
                    self.buckets[(bx, bz)].append(idx)

    def candidates(self, x, z):
        return self.buckets.get((int(math.floor(x / self.bucket)),
                                 int(math.floor(z / self.bucket))), ())


def height_in(tri, x, z):
    a, b, c = tri
    den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
    if abs(den) < 1e-12:
        return None
    l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / den
    l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / den
    l3 = 1.0 - l1 - l2
    if l1 < -1e-9 or l2 < -1e-9 or l3 < -1e-9:
        return None
    return l1 * a[1] + l2 * b[1] + l3 * c[1]


# --------------------------------------------------------------------------- #
# map
# --------------------------------------------------------------------------- #

def svg_map(doc, class_grid, uncovered_grid, x0, z0, step, regions, course_pts, spawn):
    nz, nx = class_grid.shape
    scale = 1.0
    margin = 90
    width = int(round(nx * scale + 2 * margin))
    height = int(round(nz * scale + 2 * margin))
    px = lambda i: margin + i * scale
    py = lambda j: margin + (nz - 1 - j) * scale
    out = []
    out.append('<?xml version="1.0" encoding="UTF-8"?>')
    out.append('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">'
               % (width, height, width, height))
    out.append('<rect x="0" y="0" width="%d" height="%d" fill="#0d1117"/>' % (width, height))
    color = {-1: "#0d1117", 1: "#2b3138", 2: "#000000"}
    for ridx, rec in enumerate(regions):
        color[rec["_class"]] = PALETTE[ridx % len(PALETTE)]
    # run-length rectangles
    for j in range(nz):
        row = class_grid[j]
        changes = np.flatnonzero(np.diff(row)) + 1
        starts = np.concatenate(([0], changes))
        ends = np.concatenate((changes, [nx]))
        for a, b in zip(starts, ends):
            v = int(row[a])
            if v == -1:
                continue
            out.append('<rect x="%.2f" y="%.2f" width="%.2f" height="%.2f" fill="%s"/>'
                       % (px(a), py(j), (b - a) * scale, scale, color.get(v, "#555")))
    # uncovered coverage samples
    for j in range(nz):
        row = uncovered_grid[j]
        changes = np.flatnonzero(np.diff(row)) + 1
        starts = np.concatenate(([0], changes))
        ends = np.concatenate((changes, [nx]))
        for a, b in zip(starts, ends):
            if not row[a]:
                continue
            out.append('<rect x="%.2f" y="%.2f" width="%.2f" height="%.2f" fill="#7f1d1d" opacity="0.9"/>'
                       % (px(a), py(j), (b - a) * scale, scale))
    # P48 course
    if course_pts:
        d = "M " + " L ".join("%.2f %.2f" % (px((x - x0) / step), py((z - z0) / step))
                              for x, z in course_pts)
        out.append('<path d="%s" fill="none" stroke="#60a5fa" stroke-width="2.2"/>' % d)
    # region labels (anchor cells are on the 0.5 m grid; the map grid is 1 m)
    for ridx, rec in enumerate(regions):
        if ridx >= 8:
            break
        j, i = rec["_labelCell"]
        tx, ty = px(i / 2.0), py(j / 2.0)
        out.append('<circle cx="%.1f" cy="%.1f" r="3" fill="#ffffff" opacity="0.8"/>' % (tx, ty))
        out.append('<text x="%.1f" y="%.1f" fill="#ffffff" font-family="monospace" font-size="11">'
                   '%s %.0f m2</text>' % (tx + 6, ty - 6, rec["id"], rec["areaM2"]))
        out.append('<text x="%.1f" y="%.1f" fill="#cbd5e1" font-family="monospace" font-size="10">'
                   'draw %.0f%%</text>' % (tx + 6, ty + 7, 100.0 * rec["coverage"]["fraction"]))
    # spawn
    sx, sy = px((spawn[0] - x0) / step), py((spawn[1] - z0) / step)
    out.append('<circle cx="%.1f" cy="%.1f" r="6" fill="#facc15" stroke="#000" stroke-width="1.5"/>' % (sx, sy))
    out.append('<text x="%.1f" y="%.1f" fill="#facc15" font-family="monospace" font-size="12">spawn (%.0f, %.0f)</text>'
               % (sx + 9, sy + 4, spawn[0], spawn[1]))
    # axes every 100 m
    xmap1 = x0 + (nx - 1) * step
    for x in range(int(math.ceil(x0 / 100.0) * 100), int(xmap1) + 1, 100):
        xx = px((x - x0) / step)
        out.append('<line x1="%.1f" y1="%d" x2="%.1f" y2="%d" stroke="#334155" stroke-width="1" opacity="0.5"/>'
                   % (xx, margin, xx, height - margin))
        out.append('<text x="%.1f" y="%d" fill="#94a3b8" font-family="monospace" font-size="10" text-anchor="middle">%d</text>'
                   % (xx, height - margin + 14, x))
    for z in range(int(math.ceil(z0 / 100.0) * 100), int(z0 + (nz - 1) * step) + 1, 100):
        yy = py((z - z0) / step)
        out.append('<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="#334155" stroke-width="1" opacity="0.5"/>'
                   % (margin, yy, width - margin, yy))
        out.append('<text x="%d" y="%.1f" fill="#94a3b8" font-family="monospace" font-size="10" text-anchor="end">%d</text>'
                   % (margin - 6, yy + 3, z))
    # legend
    lx, ly = width - 265, 16
    out.append('<rect x="%d" y="%d" width="250" height="168" fill="#0b1220" stroke="#334155"/>' % (lx, ly))
    spawn_color = next((PALETTE[k % len(PALETTE)] for k, r in enumerate(regions) if r["containsSpawn"]),
                       "#22c55e")
    legend = [(spawn_color, "spawn free-roam region"), ("#3b82f6", "other drivable region"),
              ("#2b3138", "collision passable, not detailed"), ("#000000", "wall / steep obstacle"),
              ("#7f1d1d", "drivable area with no draw"), ("#60a5fa", "P48 310 m course")]
    for k, (c, text) in enumerate(legend):
        out.append('<rect x="%d" y="%d" width="12" height="12" fill="%s"/>' % (lx + 8, ly + 10 + 24 * k, c))
        out.append('<text x="%d" y="%d" fill="#e2e8f0" font-family="monospace" font-size="10">%s</text>'
                   % (lx + 26, ly + 20 + 24 * k, text))
    out.append('<text x="%d" y="%d" fill="#94a3b8" font-family="monospace" font-size="10">'
               'data-only, no renderer/game claim</text>' % (margin, 22))
    out.append('</svg>')
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    physics_bytes = PHYSICS.read_bytes()
    if sha256_bytes(physics_bytes) != PHYSICS_SHA256:
        raise SystemExit("build_regions: BLOCKED: Level.levelphysics hash changed")

    spawn_doc = json.loads(SPAWN_JSON.read_text())
    spawn = (float(spawn_doc["x"]), float(spawn_doc["z"]))
    if abs(spawn[0] - SPAWN[0]) > 1e-9 or abs(spawn[1] - SPAWN[1]) > 1e-9:
        raise SystemExit("build_regions: BLOCKED: committed spawn is not (-88, 1050)")

    path_bytes = P48_JSON.read_bytes()
    path_doc = json.loads(path_bytes)
    if (path_doc.get("kind"), path_doc.get("version")) != P48_KIND:
        raise SystemExit("build_regions: BLOCKED: unexpected P48 path kind")
    if canonical(path_doc) != P48_CANONICAL:
        raise SystemExit("build_regions: BLOCKED: P48 path canonical hash changed")
    course_pts = [(float(p[0]), float(p[1])) for p in path_doc["course"]["points"]]

    triangles, mesh_count = flatten_collision()
    normals = np.array([triangle_normal(*t) for t in triangles])
    surface = triangles[normals[:, 1] > SURFACE_MIN_NY]
    wall = triangles[np.abs(normals[:, 1]) < 0.5]
    print("collision triangles %d (surface %d, steep %d)" % (len(triangles), len(surface), len(wall)))

    x0, x1, z0, z1 = WINDOW
    H, xs, zs = raster_height(surface, x0, x1, z0, z1, CELL)
    nx, nz = len(xs), len(zs)
    dh = edge_max_dh(H)
    base_pass = np.isfinite(H) & (dh <= EDGE_DH + 1e-9)
    W = raster_wall(wall, H, x0, x1, z0, z1, CELL, WALL_RADIUS)
    base_pass &= ~W
    print("grid %dx%d, passable %d, wall-mask %d" % (nz, nx, int(base_pass.sum()), int(W.sum())))

    labels2, sizes2, _ = label_components(erode(base_pass, P48_ERODE_CELLS))
    labels3, sizes3, _ = label_components(erode(base_pass, STRICT_ERODE_CELLS))
    labels0, sizes0, _ = label_components(base_pass)

    sj = int(round((spawn[1] - z0) / CELL))
    si = int(round((spawn[0] - x0) / CELL))
    spawn_lab2 = int(labels2[sj, si])
    spawn_lab3 = int(labels3[sj, si])
    spawn_lab0 = int(labels0[sj, si])
    if spawn_lab2 == 0:
        raise SystemExit("build_regions: FAILED: spawn is not on the 2-cell clearance mask")
    print("spawn labels base=%d p48=%d strict=%d" % (spawn_lab0, spawn_lab2, spawn_lab3))

    # candidate regions: 2-cell mask, area >= MIN_REGION_AREA, spawn region always
    order = sorted(range(len(sizes2)), key=lambda k: (-sizes2[k], k))
    candidates = []
    for k in order:
        lab = k + 1
        area = sizes2[k] * CELL * CELL
        if area < MIN_REGION_AREA:
            continue
        candidates.append(lab)
        if len(candidates) >= MAX_DETAIL_REGIONS:
            break
    if spawn_lab2 not in candidates:
        candidates.append(spawn_lab2)
    # detail order: area desc, then bbox min
    def bbox_of(lab):
        c = np.argwhere(labels2 == lab)
        return (int(c[:, 1].min()), int(c[:, 1].max()), int(c[:, 0].min()), int(c[:, 0].max()))
    candidates.sort(key=lambda lab: (-sizes2[lab - 1], bbox_of(lab)))

    print("candidate regions", len(candidates))

    # visual map
    visual_doc, sections, visual_sha = load_visual()
    visual, owner = build_visual_triangles(sections)
    vindex = BucketIndex(visual)
    collision_tris = [t for t in triangles if triangle_normal(*t)[1] > COLLISION_NY_MIN]
    cindex = BucketIndex(collision_tris)
    print("draw triangles %d, collision up-facing %d" % (len(visual), len(collision_tris)))

    def ground_height(x, z):
        best = None
        for i in cindex.candidates(x, z):
            h = height_in(collision_tris[i], x, z)
            if h is not None and (best is None or h > best):
                best = h
        return best

    def visual_hit(x, z, coll):
        best = None
        for i in vindex.candidates(x, z):
            h = height_in(visual[i], x, z)
            if h is None:
                continue
            d = h - coll
            if best is None or abs(d) < abs(best[0]):
                best = (d, i)
        return best

    regions = []
    detailed = []
    sample_rows = []
    all_masks = {}

    # common grid class for the map: -1 background, 1 passable, 2 wall, 3+ regions
    class_grid = np.full((nz, nx), -1, dtype=np.int16)
    class_grid[base_pass] = 1
    class_grid[W] = 2

    for idx, lab in enumerate(candidates):
        region = labels2 == lab
        cells = int(sizes2[lab - 1])
        area = cells * CELL * CELL
        arr = np.argwhere(region)
        jmin, jmax = int(arr[:, 0].min()), int(arr[:, 0].max())
        imin, imax = int(arr[:, 1].min()), int(arr[:, 1].max())
        lab0_at = int(labels0[int(arr[0, 0]), int(arr[0, 1])])
        rec = dict(
            id="R%02d" % (idx + 1),
            label=("spawn" if lab == spawn_lab2 else "region-%02d" % (idx + 1)),
            containsSpawn=bool(lab == spawn_lab2),
            cells=cells,
            areaM2=round(area, 2),
            areaStrictM2=round(float((labels3[region] > 0).sum()) * CELL * CELL, 2),
            strictSpawnComponentAreaM2=(round(float(sizes3[spawn_lab3 - 1]) * CELL * CELL, 2)
                                        if lab == spawn_lab2 else None),
            baseComponentAreaM2=round(float(sizes0[lab0_at - 1]) * CELL * CELL, 2) if lab0_at else 0.0,
            bounds=[round(float(xs[imin]), 2), round(float(xs[imax]), 2),
                    round(float(zs[jmin]), 2), round(float(zs[jmax]), 2)],
            bboxCells=[int(imin), int(imax), int(jmin), int(jmax)],
            windowClipped=bool(imin == 0 or jmin == 0 or imax == nx - 1 or jmax == nz - 1),
            hull=convex_hull([(xs[i], zs[j]) for j, i in arr[::max(1, len(arr) // 2000)]]),
        )
        rec["_class"] = 3 + idx
        class_grid[region] = rec["_class"]

        # geodesic diameter
        geo = region_geodesics(region)
        if geo:
            rec["diameter"] = dict(
                lengthMetres=round(geo["length"], 3),
                start=[round(float(xs[geo["a"][1]]), 2), round(float(zs[geo["a"][0]]), 2)],
                end=[round(float(xs[geo["b"][1]]), 2), round(float(zs[geo["b"][0]]), 2)],
                method="max over six boundary-seeded double sweeps (8-connected, 0.5/0.7071 m)",
            )
            rec["width"] = width_profile(region, geo["path"], CELL)
            rec["spine"] = [[round(float(xs[int(round(i))]), 2), round(float(zs[int(round(j))]), 2)]
                            for i, j in resample_cells(geo["path"], 2.0)]
            rec["spineCells"] = [[round(float(xs[i]), 2), round(float(zs[j]), 2)] for j, i in geo["path"]]
            rec["_spinePath"] = geo["path"]
        else:
            rec["diameter"] = None
            rec["width"] = dict(stations=0)

        sp_geo = spawn_geodesic(region, (sj, si)) if lab == spawn_lab2 else None
        if sp_geo:
            rec["fromSpawn"] = dict(
                lengthMetres=round(sp_geo["length"], 3),
                end=[round(float(xs[sp_geo["end"][1]]), 2), round(float(zs[sp_geo["end"][0]]), 2)],
            )
            rec["widthFromSpawn"] = width_profile(region, sp_geo["path"], CELL)
            rec["spawnSpine"] = [[round(float(xs[int(round(i))]), 2), round(float(zs[int(round(j))]), 2)]
                                 for i, j in resample_cells(sp_geo["path"], 2.0)]
            rec["spawnSpineCells"] = [[round(float(xs[i]), 2), round(float(zs[j]), 2)]
                                      for j, i in sp_geo["path"]]
            rec["_spawnPath"] = sp_geo["path"]

        rec["maxInscribed"] = max_inscribed_width(region)
        rec["enclosedHoles"] = enclosed_holes(region, xs, zs)
        # label anchor = max inscribed cell; also the optional widest-point spawn
        rec["_labelCell"] = rec["maxInscribed"]["cell"]
        rec["suggestedSpawn"] = [round(float(xs[rec["_labelCell"][1]]), 2),
                                 round(float(zs[rec["_labelCell"][0]]), 2)]

        # boundary / obstacle classification
        boundary = Counter()
        boundary_dist = []
        boundary_cells = []
        for j, i in arr:
            if (region[max(0, j - 1):j + 2, max(0, i - 1):i + 2].sum() == 9):
                continue
            boundary_cells.append((j, i))
            j0w, j1w = max(0, j - 6), min(nz, j + 7)
            i0w, i1w = max(0, i - 6), min(nx, i + 7)
            sub_block = (~base_pass[j0w:j1w, i0w:i1w]) | W[j0w:j1w, i0w:i1w]
            jj, ii = np.where(sub_block)
            if not len(jj):
                boundary["open"] += 1
                continue
            dj = jj + j0w - j
            di = ii + i0w - i
            d2 = dj * dj + di * di
            k = int(np.argmin(d2))
            jj0, ii0 = int(jj[k] + j0w), int(ii[k] + i0w)
            boundary_dist.append(math.sqrt(d2[k]) * CELL)
            if W[jj0, ii0]:
                boundary["wall"] += 1
            elif not np.isfinite(H[jj0, ii0]):
                boundary["void"] += 1
            else:
                boundary["stepOrGrade"] += 1
        perim = sum(1 for j, i in boundary_cells) * CELL  # boundary cell count * 0.5 m (approx)
        rec["boundary"] = dict(
            boundaryCells=len(boundary_cells),
            perimeterApproxMetres=round(perim, 1),
            classification={k: v for k, v in sorted(boundary.items())},
            nearestBarrierMetres=dict(min=round(min(boundary_dist), 2) if boundary_dist else None,
                                      median=round(percentile(sorted(boundary_dist), 0.5), 2) if boundary_dist else None,
                                      max=round(max(boundary_dist), 2) if boundary_dist else None),
        )

        # coverage at 1 m lattice
        cov_rows = []
        covered = 0
        reason = Counter()
        section_counts = Counter()
        draw_counts = Counter()
        cov_grid = np.zeros((nz, nx), dtype=bool)
        sampled = 0
        for j, i in arr:
            if j % COVERAGE_STRIDE or i % COVERAGE_STRIDE:
                continue
            x, z = float(xs[i]), float(zs[j])
            coll = ground_height(x, z)
            sampled += 1
            if coll is None:
                reason["collisionMissing"] += 1
                cov_rows.append([rec["id"], round(x, 3), round(z, 3), None, None, None, None, 0])
                continue
            hit = visual_hit(x, z, coll)
            if hit is None:
                reason["visualMissing"] += 1
                cov_rows.append([rec["id"], round(x, 3), round(z, 3), round(coll, 4), None, None, None, 0])
                continue
            delta, tri = hit
            ok = abs(delta) <= COVER_TOL
            cov_grid[j, i] = bool(ok)
            if ok:
                covered += 1
                si_, off, di, draw = owner[tri]
                key = sections[si_]["key"]
                section_counts[key] += 1
                draw_counts[(key, di)] += 1
                cov_rows.append([rec["id"], round(x, 3), round(z, 3), round(coll, 4),
                                 round(delta, 4), key, di, 1])
            else:
                reason["deltaOutOfTolerance"] += 1
                cov_rows.append([rec["id"], round(x, 3), round(z, 3), round(coll, 4),
                                 round(delta, 4), sections[owner[tri][0]]["key"], owner[tri][2], 0])
        rec["coverage"] = dict(
            sampleStepMetres=COVERAGE_STRIDE * CELL,
            samples=sampled,
            covered=covered,
            fraction=round(covered / sampled, 6) if sampled else 0.0,
            coveredAreaM2=round(area * covered / sampled, 2) if sampled else 0.0,
            uncoveredAreaM2=round(area - area * covered / sampled, 2) if sampled else 0.0,
            failureReasons={k: v for k, v in sorted(reason.items())},
        )
        rec["sections"] = [
            dict(key=key, coveredSamples=count,
                 coveredAreaM2=round(area * count / sampled, 2) if sampled else 0.0,
                 fraction=round(count / sampled, 6) if sampled else 0.0)
            for key, count in sorted(section_counts.items(), key=lambda kv: (-kv[1], kv[0]))
        ]
        rec["_draws"] = sorted("%s#%d" % k for k in draw_counts)

        # uncovered clusters on the sampled 1 m lattice
        # Coverage is sampled on the global even-row/even-column lattice.  Anchor
        # the compact lattice to the first even index in the region bbox, not to
        # the bbox corner: a bbox whose min index is odd would otherwise shift
        # every sample by one cell.
        pj = jmin if jmin % COVERAGE_STRIDE == 0 else jmin + 1
        pi = imin if imin % COVERAGE_STRIDE == 0 else imin + 1
        ch = (jmax - pj) // COVERAGE_STRIDE + 1
        cw = (imax - pi) // COVERAGE_STRIDE + 1
        S = np.zeros((ch, cw), dtype=bool)
        R = np.zeros_like(S)
        for j, i in arr:
            if j % COVERAGE_STRIDE or i % COVERAGE_STRIDE:
                continue
            R[(j - pj) // COVERAGE_STRIDE, (i - pi) // COVERAGE_STRIDE] = True
            S[(j - pj) // COVERAGE_STRIDE, (i - pi) // COVERAGE_STRIDE] = bool(cov_grid[j, i])
        unc = R & ~S
        ulab, usizes, _ = label_components(unc)
        clusters = []
        for k in sorted(range(len(usizes)), key=lambda q: -usizes[q])[:8]:
            q = k + 1
            cc = np.argwhere(ulab == q)
            if not len(cc):
                continue
            clusters.append(dict(
                areaM2=float(usizes[k]),
                bounds=[round(float(xs[pi + cc[:, 1].min() * COVERAGE_STRIDE]), 2),
                        round(float(xs[pi + cc[:, 1].max() * COVERAGE_STRIDE]), 2),
                        round(float(zs[pj + cc[:, 0].min() * COVERAGE_STRIDE]), 2),
                        round(float(zs[pj + cc[:, 0].max() * COVERAGE_STRIDE]), 2)],
                centroid=[round(float(xs[pi + int(round(cc[:, 1].mean() * COVERAGE_STRIDE))]), 2),
                          round(float(zs[pj + int(round(cc[:, 0].mean() * COVERAGE_STRIDE))]), 2)],
            ))
        rec["uncoveredClusters"] = clusters

        # P48 proximity (spawn region only)
        if lab == spawn_lab2:
            seg = np.array([[course_pts[k][0], course_pts[k][1],
                             course_pts[k + 1][0], course_pts[k + 1][1]]
                            for k in range(len(course_pts) - 1)])
            pts = np.array([[xs[i], zs[j]] for j, i in arr])
            dmin = np.full(len(pts), np.inf)
            for k in range(0, len(pts), 400):
                p = pts[k:k + 400]
                ax, az = seg[:, 0][None, :], seg[:, 1][None, :]
                bx, bz = seg[:, 2][None, :], seg[:, 3][None, :]
                dx, dz = bx - ax, bz - az
                l2 = dx * dx + dz * dz
                t = np.clip(((p[:, 0][:, None] - ax) * dx + (p[:, 1][:, None] - az) * dz) / np.where(l2 == 0, 1, l2), 0, 1)
                qx = ax + t * dx
                qz = az + t * dz
                d = np.sqrt((p[:, 0][:, None] - qx) ** 2 + (p[:, 1][:, None] - qz) ** 2)
                dmin[k:k + 400] = d.min(axis=1)
            rec["p48CourseProximity"] = {
                "within6mM2": round(float((dmin <= 6.0).sum()) * CELL * CELL, 2),
                "within12mM2": round(float((dmin <= 12.0).sum()) * CELL * CELL, 2),
                "within25mM2": round(float((dmin <= 25.0).sum()) * CELL * CELL, 2),
                "beyond25mM2": round(float((dmin > 25.0).sum()) * CELL * CELL, 2),
                "totalM2": round(float(len(pts)) * CELL * CELL, 2),
            }

        regions.append(rec)
        detailed.append(rec)
        all_masks[rec["id"]] = region
        sample_rows.extend(cov_rows)
        print("  %s area %.1f m2, draw %.1f%%, diameter %.1f m, width median %.1f m"
              % (rec["id"], rec["areaM2"], 100 * rec["coverage"]["fraction"],
                 rec["diameter"]["lengthMetres"] if rec["diameter"] else 0,
                 rec["width"].get("median", 0)))

    # ---------------------------------------------------------- separations
    # Sensitivity: the same passable mask without the steep-triangle wall mask.
    base_no_wall = np.isfinite(H) & (dh <= EDGE_DH + 1e-9)
    labels_nw, sizes_nw, _ = label_components(erode(base_no_wall, P48_ERODE_CELLS))
    spawn_nw = int(labels_nw[sj, si])
    spawn_rec = next((r for r in regions if r["containsSpawn"]), None)
    separations = []
    if spawn_rec:
        sp_region = all_masks[spawn_rec["id"]]
        A = np.argwhere(sp_region)
        Astride = A[::8]
        for rec in regions:
            if rec is spawn_rec or rec["areaM2"] < 1000.0:
                continue
            other = all_masks[rec["id"]]
            B = np.argwhere(other)
            # coarse nearest pair, then local exact
            best = (1e18, None, None)
            for k in range(0, len(Astride), 128):
                ch = Astride[k:k + 128]
                d2 = ((ch[:, None, 0] - B[None, :, 0]) ** 2 + (ch[:, None, 1] - B[None, :, 1]) ** 2)
                idx = np.unravel_index(np.argmin(d2), d2.shape)
                v = float(d2[idx])
                if v < best[0]:
                    best = (v, tuple(ch[idx[0]]), tuple(B[idx[1]]))
            pa, pb = best[1], best[2]
            # refine +-12 cells
            A2 = A[(np.abs(A[:, 0] - pa[0]) <= 12) & (np.abs(A[:, 1] - pa[1]) <= 12)]
            B2 = B[(np.abs(B[:, 0] - pb[0]) <= 12) & (np.abs(B[:, 1] - pb[1]) <= 12)]
            best2 = (1e18, None, None)
            for aa in A2:
                d2 = (aa[0] - B2[:, 0]) ** 2 + (aa[1] - B2[:, 1]) ** 2
                k = int(np.argmin(d2))
                if float(d2[k]) < best2[0]:
                    best2 = (float(d2[k]), tuple(aa), tuple(B2[k]))
            pa, pb = best2[1], best2[2]
            gap = math.sqrt(best2[0]) * CELL
            # classify the straight segment on the raster
            p0 = np.array([xs[pa[1]], zs[pa[0]]])
            p1 = np.array([xs[pb[1]], zs[pb[0]]])
            steps = max(2, int(math.ceil(np.linalg.norm(p1 - p0) / (CELL / 2))))
            kinds = Counter()
            mid_kinds = Counter()
            hvals = []
            for k in range(steps + 1):
                p = p0 + (p1 - p0) * k / steps
                i = int(round((p[0] - x0) / CELL))
                j = int(round((p[1] - z0) / CELL))
                if not (0 <= j < nz and 0 <= i < nx):
                    kinds["window"] += 1
                    continue
                if W[j, i]:
                    kind = "wall"
                elif not np.isfinite(H[j, i]):
                    kind = "void"
                elif not base_pass[j, i]:
                    kind = "stepOrGrade"
                else:
                    kind = "passable"
                kinds[kind] += 1
                if 0.35 <= k / steps <= 0.65:
                    mid_kinds[kind] += 1
                if np.isfinite(H[j, i]):
                    hvals.append(float(H[j, i]))
            if gap > 30.0:
                barrier = "distant"
            else:
                nonpass = {k: v for k, v in mid_kinds.items() if k != "passable"}
                if nonpass:
                    order = {"wall": 0, "void": 1, "stepOrGrade": 2}
                    barrier = sorted(nonpass.items(),
                                     key=lambda kv: (-kv[1], order.get(kv[0], 9)))[0][0]
                else:
                    barrier = "narrow-neck"
            midx = float((p0[0] + p1[0]) / 2.0)
            midz = float((p0[1] + p1[1]) / 2.0)
            wall_extent = wall_vertical_range(midx, midz, wall, 3.0) if barrier in ("wall", "void") else None
            without_wall = bool(np.any(labels_nw[sp_region] == spawn_nw) and
                                np.any(labels_nw[other] == spawn_nw))
            separations.append(dict(
                fromRegion=spawn_rec["id"], toRegion=rec["id"],
                boundaryGapMetres=round(gap, 3),
                clearanceCorrectedGapMetres=round(max(0.0, gap - 2 * P48_ERODE_CELLS * CELL), 3),
                barrierType=barrier,
                rasterCounts={k: v for k, v in sorted(kinds.items())},
                midGapCounts={k: v for k, v in sorted(mid_kinds.items())},
                at=[round(float(p0[0]), 2), round(float(p0[1]), 2)],
                to=[round(float(p1[0]), 2), round(float(p1[1]), 2)],
                midpoint=[round(midx, 2), round(midz, 2)],
                heightRangeMetres=[round(min(hvals), 3), round(max(hvals), 3)] if hvals else None,
                groundDropMetres=round(max(hvals) - min(hvals), 3) if hvals else None,
                wallVerticalRange=wall_extent,
                wallAboveGroundMetres=(round(wall_extent["yMax"] - max(hvals), 3)
                                       if wall_extent and hvals else None),
                withoutWallMaskConnected=without_wall,
                withoutWallMaskNote=("ground-only mask (no steep-face mask) connects the two regions; "
                                     "the barrier is the steep face, not a step or void") if without_wall else
                                    ("still disconnected without the steep-face mask"),
            ))
            print("  separation %s -> %s: %.2f m, %s" % (spawn_rec["id"], rec["id"], gap, barrier))

    # ------------------------------------------------- P48 course band control
    def band_coverage(points, step_m, stations):
        arc = [0.0]
        for k in range(1, len(points)):
            arc.append(arc[-1] + math.hypot(points[k][0] - points[k - 1][0],
                                            points[k][1] - points[k - 1][1]))
        centre = env = margin = 0
        reasons = Counter()
        gaps = 0
        prev_margin = None
        rows = 0
        for k, (x, z) in enumerate(points):
            a = points[max(0, k - 1)]
            b = points[min(len(points) - 1, k + 1)]
            fx, fz = b[0] - a[0], b[1] - a[1]
            norm = math.hypot(fx, fz) or 1.0
            fwd = (fx / norm, fz / norm)
            right = (-fwd[1], fwd[0])
            ok = []
            for o in stations:
                px, pz = x + right[0] * o, z + right[1] * o
                coll = ground_height(px, pz)
                if coll is None:
                    reasons["collisionMissing"] += 1
                    ok.append(False)
                    continue
                hit = visual_hit(px, pz, coll)
                if hit is None:
                    reasons["visualMissing"] += 1
                    ok.append(False)
                    continue
                if abs(hit[0]) > COVER_TOL:
                    reasons["deltaOutOfTolerance"] += 1
                    ok.append(False)
                    continue
                ok.append(True)
            rows += 1
            if ok[0]:
                centre += 1
            if all(ok[:5]):
                env += 1
            m = all(ok)
            if m:
                margin += 1
            if prev_margin is not None and prev_margin != m:
                gaps += 1
            prev_margin = m
        return dict(samples=len(points), sampleStepMetres=step_m,
                    centreCovered=centre, envelopeCovered=env, marginCovered=margin,
                    centreFraction=round(centre / len(points), 6),
                    envelopeFraction=round(env / len(points), 6),
                    marginFraction=round(margin / len(points), 6),
                    marginTransitions=gaps,
                    failureReasons={k: v for k, v in sorted(reasons.items())})

    p48_control = band_coverage(course_pts, 0.25, STATIONS)
    print("P48 course band:", p48_control["centreFraction"], p48_control["marginFraction"])

    # Car-width draw coverage along each region's geodesic spine.
    for rec in regions:
        spine = rec.pop("_spinePath", None)
        if spine:
            pts = [(float(xs[i]), float(zs[j])) for j, i in spine]
            rec["spineBandCoverage"] = band_coverage(pts, CELL, STATIONS)
        spawn_spine = rec.pop("_spawnPath", None)
        if spawn_spine:
            pts = [(float(xs[i]), float(zs[j])) for j, i in spawn_spine]
            rec["spawnSpineBandCoverage"] = band_coverage(pts, CELL, STATIONS)

    # ------------------------------------------------------------- map
    # 1 m map grid sampled from the 0.5 m class grid (aligned to the 1 m coverage lattice)
    mz = (nz - 1) // 2 + 1
    mx = (nx - 1) // 2 + 1
    map_class = class_grid[::2, ::2].copy()
    uncovered_map = np.zeros((mz, mx), dtype=bool)
    # Mark uncovered from cov rows: use the same sample lattice
    cov_lookup = {}
    for row in sample_rows:
        rid, x, z, coll, delta, key, di, ok = row
        cov_lookup[(round((x - x0) / CELL), round((z - z0) / CELL))] = (rid, ok)
    for (ii, jj), (rid, ok) in cov_lookup.items():
        if ok:
            continue
        if 0 <= jj < mz * 2 and 0 <= ii < mx * 2:
            uncovered_map[jj // 2, ii // 2] = True

    svg = svg_map(dict(), map_class, uncovered_map, x0, z0, 1.0, regions, course_pts, spawn)
    (OUT / "free-roam.svg").write_text(svg, encoding="utf-8")

    # PNG via PIL
    try:
        from PIL import Image, ImageDraw
        img = Image.new("RGB", (mx, mz), (13, 17, 23))
        px = img.load()
        colors = {-1: (13, 17, 23), 1: (43, 49, 56), 2: (0, 0, 0)}
        for ridx, rec in enumerate(regions):
            h = PALETTE[ridx % len(PALETTE)].lstrip("#")
            colors[rec["_class"]] = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
        for j in range(mz):
            for i in range(mx):
                px[i, mz - 1 - j] = colors.get(int(map_class[j, i]), (85, 85, 85))
        dr = ImageDraw.Draw(img)
        for j in range(mz):
            for i in range(mx):
                if uncovered_map[j, i]:
                    px[i, mz - 1 - j] = (127, 29, 29)
        # course
        pts = [((x - x0), (z - z0)) for x, z in course_pts]
        dr.line([(p[0], mz - 1 - p[1]) for p in pts], fill=(96, 165, 250), width=2)
        sx, sz = spawn[0] - x0, spawn[1] - z0
        dr.ellipse([sx - 5, mz - 1 - sz - 5, sx + 5, mz - 1 - sz + 5], fill=(250, 204, 21), outline=(0, 0, 0))
        for ridx, rec in enumerate(regions):
            j, i = rec["_labelCell"]
            tx, ty = i // 2, mz - 1 - j // 2
            dr.text((tx + 5, ty - 12), "%s %.0f m2" % (rec["id"], rec["areaM2"]), fill=(255, 255, 255))
            dr.text((tx + 5, ty), "draw %.0f%%" % (100 * rec["coverage"]["fraction"]), fill=(203, 213, 225))
        # title, legend, scale bar
        dr.text((10, 8), "USA LA River - free-roam drivable regions (data-only)", fill=(226, 232, 240))
        spawn_color = (168, 85, 247)
        for k, rec in enumerate(regions):
            if rec["containsSpawn"]:
                h = PALETTE[k % len(PALETTE)].lstrip("#")
                spawn_color = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
        lx, ly = 700, 790
        dr.rectangle([lx - 8, ly - 8, lx + 292, ly + 142], fill=(11, 18, 32), outline=(51, 65, 85))
        legend = [(spawn_color, "spawn free-roam region"), ((59, 130, 246), "other drivable region"),
                  ((43, 49, 56), "collision passable"), ((0, 0, 0), "wall / steep obstacle"),
                  ((127, 29, 29), "drivable, no draw"), ((96, 165, 250), "P48 310 m course")]
        for k, (col, text) in enumerate(legend):
            y = ly + 4 + 21 * k
            dr.rectangle([lx, y, lx + 12, y + 12], fill=col)
            dr.text((lx + 18, y), text, fill=(226, 232, 240))
        dr.line([(20, 985), (120, 985)], fill=(226, 232, 240), width=2)
        dr.text((22, 968), "100 m", fill=(226, 232, 240))
        img.save(OUT / "free-roam.png")
    except ImportError:
        print("PIL unavailable; PNG skipped")

    # ------------------------------------------------------------ report
    total_area = sum(r["areaM2"] for r in regions)
    spawn_area = spawn_rec["areaM2"] if spawn_rec else 0.0
    largest = max(regions, key=lambda r: r["areaM2"]) if regions else None
    p48_band = spawn_rec["p48CourseProximity"] if spawn_rec and "p48CourseProximity" in spawn_rec else None

    # region records: strip private keys
    out_regions = []
    for rec in regions:
        clean = {k: v for k, v in rec.items() if not k.startswith("_")}
        out_regions.append(clean)

    doc = dict(
        kind="free-roam.regions",
        version=1,
        scope=dict(
            collisionOnly=False,
            collisionMesh=True,
            drawGeometryRead=True,
            instancesApplied=False,
            engineRun=False,
            rendererClaim=False,
            gameClaim=False,
            note=("collision traversability + committed first-RenderList direct draws; "
                  "no renderer, GPU, engine frame or playable-game claim"),
        ),
        inputs=dict(
            physics=dict(path="game-data/Blur/levels/usa_la_river/Level.levelphysics",
                         bytes=len(physics_bytes), sha256=PHYSICS_SHA256),
            visualMap=dict(path="_work/track-coverage/visual.json", bytes=VISUAL_JSON.stat().st_size,
                           sha256=visual_sha, sections=len(visual_doc["sections"]),
                           okSections=len(sections)),
            p48Path=dict(path="_work/drivable-path/path.json", bytes=len(path_bytes),
                         sha256=sha256_bytes(path_bytes), canonical=P48_CANONICAL,
                         lengthMetres=P48_LENGTH),
            spawn=dict(path="_work/e1-drive/spawn.json", x=spawn[0], z=spawn[1]),
            oracle=dict(path="probes/collision-oracle/tests/reference_oracle.py",
                        sha256=sha256_bytes((ROOT / "probes/collision-oracle/tests/reference_oracle.py").read_bytes())),
            collisionTriangles=len(triangles),
            collisionMeshes=mesh_count,
            drawTriangles=len(visual),
        ),
        model=dict(
            cellMetres=CELL,
            window=dict(x0=x0, x1=x1, z0=z0, z1=z1, widthMetres=x1 - x0, heightMetres=z1 - z0),
            surfaceMinNormalY=SURFACE_MIN_NY,
            surfaceMinNormalDeg=round(math.degrees(math.acos(SURFACE_MIN_NY)), 3),
            stepLimitMetres=STEP_LIMIT,
            gradeLimit=GRADE_LIMIT,
            edgeDhLimitMetres=EDGE_DH,
            wallMask=dict(radiusMetres=WALL_RADIUS, bandLowMetres=WALL_BAND_LOW,
                          bandHighMetres=WALL_BAND_HIGH,
                          rule="project steep triangles (|normal.y| < 0.5) and dilate by 0.5 m"),
            erosion=dict(p48Cells=P48_ERODE_CELLS, p48Metres=P48_ERODE_CELLS * CELL,
                         strictCells=STRICT_ERODE_CELLS, strictMetres=STRICT_ERODE_CELLS * CELL,
                         rule="8-connected erosion of the passable mask"),
            carEnvelope=dict(source="_work/e1-drive/cars.json (RP_CarDynamics XT decode)",
                             lengthMetres=CAR_LENGTH, widthMetres=CAR_WIDTH,
                             safetyMarginMetres=SAFETY_MARGIN,
                             halfLengthMetres=round(HALF_LENGTH, 4),
                             halfWidthMetres=round(HALF_WIDTH, 4),
                             note="box proxy; the safety margin is a labelled assumption"),
            regionDefinition="8-connected component of the P48 2-cell erosion mask",
            coverage=dict(collisionNyMin=COLLISION_NY_MIN, visualNyMin=VISUAL_NY_MIN,
                          toleranceMetres=COVER_TOL,
                          areaSampleStepMetres=COVERAGE_STRIDE * CELL,
                          stationsMetres=list(STATIONS)),
        ),
        summary=dict(
            windowAreaM2=round((x1 - x0) * (z1 - z0), 1),
            detailedRegions=len(regions),
            detailedAreaM2=round(total_area, 2),
            spawnRegionId=spawn_rec["id"] if spawn_rec else None,
            spawnRegionAreaM2=spawn_area,
            largestRegionId=largest["id"] if largest else None,
            largestRegionAreaM2=largest["areaM2"] if largest else None,
            largestRegionIsSpawnRegion=bool(largest and largest["containsSpawn"]),
            spawnRegionIsLargest=False if not largest else bool(largest["containsSpawn"]),
            spawnRegionDrawFraction=spawn_rec["coverage"]["fraction"] if spawn_rec else None,
            spawnRegionDrawAreaM2=spawn_rec["coverage"]["coveredAreaM2"] if spawn_rec else None,
            p48Band=dict(
                within6mM2=p48_band["within6mM2"] if p48_band else None,
                within12mM2=p48_band["within12mM2"] if p48_band else None,
                within25mM2=p48_band["within25mM2"] if p48_band else None,
                beyond25mM2=p48_band["beyond25mM2"] if p48_band else None,
                totalM2=p48_band["totalM2"] if p48_band else None,
            ) if p48_band else None,
            p48Course=p48_control,
        ),
        separations=separations,
        regions=out_regions,
        evidence=dict(
            map="_work/free-roam/free-roam.svg",
            png="_work/free-roam/free-roam.png",
            html="_work/free-roam/free-roam.html",
            samples="_work/free-roam/regions-samples.json",
            grid="_work/free-roam/grid.npz",
            hashes="_work/free-roam/hashes.json",
        ),
    )

    # recommendation
    warnings = []
    if spawn_rec:
        cov = spawn_rec["coverage"]
        if cov["uncoveredAreaM2"] > 0:
            warnings.append("%.1f m2 (%.1f%%) of the spawn region has no matching draw triangle"
                            % (cov["uncoveredAreaM2"], 100 * (1 - cov["fraction"])))
            if spawn_rec["uncoveredClusters"]:
                c = spawn_rec["uncoveredClusters"][0]
                warnings.append("largest undrawn cluster %.1f m2 near (%.0f, %.0f)"
                                % (c["areaM2"], c["centroid"][0], c["centroid"][1]))
        if spawn_rec["boundary"]:
            cls = spawn_rec["boundary"]["classification"]
            total = sum(cls.values()) or 1
            warnings.append("spawn-region boundary is wall %.0f%%, void/ledge %.0f%%, step/grade %.0f%%"
                            % (100 * cls.get("wall", 0) / total,
                               100 * cls.get("void", 0) / total,
                               100 * cls.get("stepOrGrade", 0) / total))
        prox = spawn_rec.get("p48CourseProximity")
        if prox:
            warnings.append("the spawn region is %.0f m2; %.0f m2 (%.0f%%) lies more than 25 m from the 310 m course, so free-roam is wider than the corridor"
                            % (prox["totalM2"], prox["beyond25mM2"],
                               100 * prox["beyond25mM2"] / prox["totalM2"] if prox["totalM2"] else 0))
    if separations:
        s = separations[0]
        warnings.append("nearest larger basin %s is %.2f m away across a %s; it is not reachable from the committed spawn"
                        % (s["toRegion"], s["boundaryGapMetres"], s["barrierType"]))
        for s in separations[1:4]:
            if s["barrierType"] != "distant":
                warnings.append("basin %s (%.0f m2) is %.2f m away across a %s; not reachable"
                                % (s["toRegion"],
                                   next((r["areaM2"] for r in regions if r["id"] == s["toRegion"]), 0.0),
                                   s["boundaryGapMetres"], s["barrierType"]))
    undrawn = [r for r in regions if r["coverage"]["fraction"] == 0.0 and not r["containsSpawn"]]
    if undrawn:
        warnings.append("%d collision-drivable regions (%.0f m2 total) have 0%% draw coverage; do not open them in free-roam without a labelled fallback"
                        % (len(undrawn), sum(r["areaM2"] for r in undrawn)))
    doc["recommendation"] = dict(
        mode="free-roam",
        spawn=dict(x=spawn[0], z=spawn[1],
                   headingRad=round(float(spawn_doc.get("heading", math.pi / 2)), 6),
                   note="committed E1 spawn; keep the P48 start-line convention for the 310 m sprint"),
        recommendedBounds=spawn_rec["bounds"] if spawn_rec else None,
        recommendedHull=spawn_rec["hull"] if spawn_rec else None,
        respawnRule=("no corridor respawn in free-roam; reset only on an explicit user command, "
                     "an out-of-region position, or a fall below the local collision ground"),
        sprintMode=("keep the 310.395 m P48 course as a separate timed mode (`?course=310`); "
                    "free-roam must not inherit the corridor's lateral respawn or finish gate"),
        warnings=warnings,
        limits=[
            "collision + committed draws only; no renderer, GPU, engine frame or playable-game claim",
            "instancesApplied:false; instance-only geometry could add or change surfaces",
            "the 0.5 m raster is a conservative model, not a driven lap",
            "the 0.30 m safety margin is a labelled assumption, not an XT body dimension",
            "coverage uses a symmetric |visual-collision| <= 0.5 m rule",
        ],
    )

    # hashes
    doc["hash"] = canonical(doc)
    (OUT / "regions.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    samples_doc = dict(
        kind="free-roam.region-samples",
        version=1,
        fields=["region", "x", "z", "collision", "delta", "section", "drawIndex", "covered"],
        sampleStepMetres=COVERAGE_STRIDE * CELL,
        rows=sample_rows,
    )
    (OUT / "regions-samples.json").write_text(
        json.dumps(samples_doc, sort_keys=False, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8")

    np.savez_compressed(OUT / "grid.npz",
                        height=H.astype(np.float32), base_pass=base_pass, wall=W,
                        labels_p48=labels2, labels_strict=labels3, labels_base=labels0,
                        xs=xs, zs=zs)

    # HTML
    rows = []
    for rec in regions:
        rows.append("<tr><td>%s%s</td><td>%.1f</td><td>%.1f</td><td>%.1f</td><td>%.3f</td>"
                    "<td>%.1f</td><td>%.1f</td><td>%s</td></tr>" % (
                        rec["id"], " *" if rec["containsSpawn"] else "",
                        rec["areaM2"], rec["coverage"]["coveredAreaM2"],
                        100 * rec["coverage"]["fraction"],
                        rec["coverage"]["fraction"],
                        rec["diameter"]["lengthMetres"] if rec["diameter"] else 0,
                        rec["width"].get("median", 0),
                        ", ".join("%s %.0f%%" % (s["key"], 100 * s["fraction"])
                                 for s in rec["sections"][:4])))
    html = ("<!DOCTYPE html><html><head><meta charset='utf-8'><title>Free-roam regions</title>"
            "<style>body{background:#0d1117;color:#e2e8f0;font-family:monospace;margin:20px}"
            "table{border-collapse:collapse}td,th{border:1px solid #334155;padding:4px 8px}"
            "th{background:#1e293b}</style></head><body>"
            "<h1>USA LA River — free-roam drivable regions</h1>"
            "<p>Collision traversability + committed draws. Data-only, no renderer/game claim.</p>"
            "<img src='free-roam.svg' style='max-width:100%%;border:1px solid #334155'/>"
            "<h2>Regions</h2><table><tr><th>region</th><th>area m2</th><th>drawn m2</th>"
            "<th>drawn pct</th><th>fraction</th><th>diameter m</th><th>median width m</th>"
            "<th>top sections</th></tr>%s</table>"
            "<h2>Warnings</h2><ul>%s</ul>"
            "<p>Map: <a href='free-roam.png'>PNG</a> · <a href='free-roam.svg'>SVG</a> · "
            "<a href='regions.json'>regions.json</a></p></body></html>"
            % ("".join(rows), "".join("<li>%s</li>" % w for w in warnings)))
    (OUT / "free-roam.html").write_text(html, encoding="utf-8")

    # Output hash manifest (written last; regions.json's own file hash is included).
    hash_files = ["regions.json", "regions-samples.json", "free-roam.svg",
                  "free-roam.png", "free-roam.html"]
    grid_arrays = dict(height=H.astype(np.float32), base_pass=base_pass, wall=W,
                       labels_p48=labels2, labels_strict=labels3, labels_base=labels0,
                       xs=xs, zs=zs)
    grid_digest, grid_per = content_digest(grid_arrays)
    hashes = dict(
        kind="free-roam.hashes",
        version=1,
        physics=dict(path="game-data/Blur/levels/usa_la_river/Level.levelphysics",
                     sha256=PHYSICS_SHA256),
        visualMap=dict(path="_work/track-coverage/visual.json", sha256=visual_sha),
        p48Path=dict(path="_work/drivable-path/path.json", sha256=sha256_bytes(path_bytes),
                     canonical=P48_CANONICAL),
        regionsCanonical=doc["hash"],
        gridContent=dict(file="grid.npz", combined=grid_digest, arrays=grid_per,
                         note="content hash; the npz ZIP container itself carries timestamps"),
        files={name: dict(bytes=(OUT / name).stat().st_size,
                          sha256=sha256_bytes((OUT / name).read_bytes()))
               for name in hash_files},
    )
    (OUT / "hashes.json").write_text(json.dumps(hashes, indent=1, sort_keys=True) + "\n", encoding="utf-8")

    print(json.dumps({"summary": doc["summary"], "separations": separations,
                      "hash": doc["hash"]}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
