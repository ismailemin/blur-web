"""Measure the longest covered River corridor from the committed draw geometry.

Inputs (read-only):
  * `_work/track-coverage/visual.json`  (produced by build_reference.py)
  * `game-data/Blur/levels/usa_la_river/Level.levelphysics`
  * `_work/level-candidates/...` is not needed here: visual.json carries it.

The measurement is data-derived. No vertex, triangle, transform or path point
is typed in. The path is a shortest path over a 1 m coverage grid, then a
clearance-weighted path, then an exact point-in-triangle pass at 0.25 m.

Outputs (all under `_work/track-coverage/`):
  * `corridor.json`          measured course, segments, gaps, widths, hashes
  * `corridor.svg`           top-down diagnostic (covered / gap / sections)
  * `corridor.html`          the same map with the result table
  * `summary.json`           compact evidence record

Usage:
    python probes/track-coverage/tools/build_corridor.py
"""
from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import math
import sys
from collections import Counter, deque
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
CELL = 1.0
BUCKET = 4.0
SAMPLE_STEP = 0.25
WIDTH_STEP = 0.25
WIDTH_MAX = 10.0
COVER_TOL = 0.5          # |visual - collision| at the same XZ
VISUAL_MIN_NY = 0.1      # keep slopes and walls for the "above" test
COLLISION_MIN_NY = 0.5   # drivable surface only
STEP_LIMIT = 0.5         # a vertical step above this ends the smooth course
SPAWN = (-88.0, 1050.0)  # the committed E1 spawn (spawn.json)
DEFAULT_OUT = ROOT / "_work/track-coverage"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_hash(document: dict) -> str:
    body = dict(document)
    body.pop("hash", None)
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + sha256_bytes(text.encode("utf-8"))


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


# ----------------------------------------------------------------------------
# Geometry loading
# ----------------------------------------------------------------------------

def load_visual_sections(path: Path):
    doc = load_json(path)
    sections = []
    triangles = []  # (a, b, c, section_key, section_index)
    for si, section in enumerate(doc["sections"]):
        if section.get("status") != "ok":
            continue
        positions = section["positions"]
        indices = section["indices"]
        for k in range(0, len(indices), 3):
            a = positions[indices[k] * 3:indices[k] * 3 + 3]
            b = positions[indices[k + 1] * 3:indices[k + 1] * 3 + 3]
            c = positions[indices[k + 2] * 3:indices[k + 2] * 3 + 3]
            ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
            vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
            nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
            ln = math.sqrt(nx * nx + ny * ny + nz * nz)
            if ln == 0 or ny / ln < VISUAL_MIN_NY:
                continue
            triangles.append((a, b, c, section["key"], si))
        sections.append(section)
    return doc, sections, triangles


def load_collision(path: Path):
    sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
    import reference_oracle as oracle

    data = path.read_bytes()
    level = oracle.load_level(data)
    triangles = []
    for mesh in level["meshes"]:
        vertices = mesh["vertices"]
        for tri in mesh["triangles"]:
            leaf = mesh["leaves"][tri["leaf"]]
            base = leaf["vertex_start"]
            a = vertices[base + tri["a"]]
            b = vertices[base + tri["b"]]
            c = vertices[base + tri["c"]]
            ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
            vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
            nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
            ln = math.sqrt(nx * nx + ny * ny + nz * nz)
            if ln == 0 or ny / ln < COLLISION_MIN_NY:
                continue
            triangles.append((a, b, c))
    return data, triangles


# ----------------------------------------------------------------------------
# Exact XZ point queries
# ----------------------------------------------------------------------------

def height_in_triangle(tri, x, z):
    a, b, c = tri[0], tri[1], tri[2]
    den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
    if abs(den) < 1e-12:
        return None
    l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / den
    l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / den
    l3 = 1.0 - l1 - l2
    if l1 < -1e-9 or l2 < -1e-9 or l3 < -1e-9:
        return None
    return l1 * a[1] + l2 * b[1] + l3 * c[1]


class PointIndex:
    def __init__(self, triangles, with_section=False):
        self.triangles = triangles
        self.with_section = with_section
        self.buckets = {}
        for idx, tri in enumerate(triangles):
            xs = (tri[0][0], tri[1][0], tri[2][0])
            zs = (tri[0][2], tri[1][2], tri[2][2])
            i0 = int(math.floor(min(xs) / BUCKET)); i1 = int(math.floor(max(xs) / BUCKET))
            j0 = int(math.floor(min(zs) / BUCKET)); j1 = int(math.floor(max(zs) / BUCKET))
            for i in range(i0, i1 + 1):
                for j in range(j0, j1 + 1):
                    self.buckets.setdefault((i, j), []).append(idx)

    def hits(self, x, z):
        cell = (int(math.floor(x / BUCKET)), int(math.floor(z / BUCKET)))
        out = []
        for idx in self.buckets.get(cell, ()):
            h = height_in_triangle(self.triangles[idx], x, z)
            if h is not None:
                out.append((h, idx))
        return out

    def collision_height(self, x, z):
        hits = self.hits(x, z)
        return max((h for h, _ in hits), default=None), [idx for h, idx in hits]

    def best_visual(self, x, z, collision_height):
        hits = self.hits(x, z)
        best = None
        best_idx = None
        for h, idx in hits:
            delta = h - collision_height
            if best is None or abs(delta) < abs(best):
                best = delta
                best_idx = idx
        return best, best_idx


# ----------------------------------------------------------------------------
# Grid
# ----------------------------------------------------------------------------

def grid_extents(collision_triangles):
    xs = [v[0] for t in collision_triangles for v in t]
    zs = [v[2] for t in collision_triangles for v in t]
    return (
        math.floor(min(xs)) - 20,
        math.ceil(max(xs)) + 20,
        math.floor(min(zs)) - 20,
        math.ceil(max(zs)) + 20,
    )


def rasterize(collision_triangles, visual_triangles, extents):
    x0, x1, z0, z1 = extents
    nx = int(round((x1 - x0) / CELL))
    nz = int(round((z1 - z0) / CELL))
    coll_h = np.full((nz, nx), -np.inf, dtype=np.float32)
    vis_min = np.full((nz, nx), np.inf, dtype=np.float32)
    vis_max = np.full((nz, nx), -np.inf, dtype=np.float32)
    vis_min_sec = np.full((nz, nx), -1, dtype=np.int16)
    vis_max_sec = np.full((nz, nx), -1, dtype=np.int16)

    def raster_one(tri, which, section_index=-1):
        a, b, c = tri[0], tri[1], tri[2]
        xmin = max(x0, min(a[0], b[0], c[0])); xmax = min(x1, max(a[0], b[0], c[0]))
        zmin = max(z0, min(a[2], b[2], c[2])); zmax = min(z1, max(a[2], b[2], c[2]))
        if xmax < xmin or zmax < zmin:
            return
        i0 = max(0, int(math.floor((xmin - x0) / CELL)))
        i1 = min(nx - 1, int(math.floor((xmax - x0) / CELL)))
        j0 = max(0, int(math.floor((zmin - z0) / CELL)))
        j1 = min(nz - 1, int(math.floor((zmax - z0) / CELL)))
        xs = x0 + (np.arange(i0, i1 + 1) + 0.5) * CELL
        zs = z0 + (np.arange(j0, j1 + 1) + 0.5) * CELL
        Xg, Zg = np.meshgrid(xs, zs)
        den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
        if abs(den) < 1e-12:
            return
        l1 = ((b[2] - c[2]) * (Xg - c[0]) + (c[0] - b[0]) * (Zg - c[2])) / den
        l2 = ((c[2] - a[2]) * (Xg - c[0]) + (a[0] - c[0]) * (Zg - c[2])) / den
        l3 = 1.0 - l1 - l2
        inside = (l1 >= -1e-9) & (l2 >= -1e-9) & (l3 >= -1e-9)
        if not inside.any():
            return
        h = (l1 * a[1] + l2 * b[1] + l3 * c[1]).astype(np.float32)
        if which == "collision":
            sub = coll_h[j0:j1 + 1, i0:i1 + 1]
            upd = inside & (h > sub)
            sub[upd] = h[upd]
        else:
            smin = vis_min[j0:j1 + 1, i0:i1 + 1]
            smax = vis_max[j0:j1 + 1, i0:i1 + 1]
            upd = inside & (h < smin)
            smin[upd] = h[upd]
            vis_min_sec[j0:j1 + 1, i0:i1 + 1][upd] = section_index
            upd = inside & (h > smax)
            smax[upd] = h[upd]
            vis_max_sec[j0:j1 + 1, i0:i1 + 1][upd] = section_index

    for tri in collision_triangles:
        raster_one(tri, "collision")
    for tri in visual_triangles:
        raster_one(tri[:3], "visual", tri[4])
    return {
        "x0": x0, "z0": z0, "nx": nx, "nz": nz,
        "coll_h": coll_h, "vis_min": vis_min, "vis_max": vis_max,
        "vis_min_sec": vis_min_sec, "vis_max_sec": vis_max_sec,
    }


def coverage_mask(grid):
    coll = grid["coll_h"] > -1e30
    return (grid["vis_min"] <= grid["coll_h"] + COVER_TOL) & (
        grid["vis_max"] >= grid["coll_h"] - COVER_TOL
    ) & coll


# ----------------------------------------------------------------------------
# Components / clearance / paths
# ----------------------------------------------------------------------------

def label_components(mask):
    nz, nx = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    components = []
    for j in range(nz):
        for i in range(nx):
            if not mask[j, i] or seen[j, i]:
                continue
            q = deque([(j, i)])
            seen[j, i] = True
            cells = []
            while q:
                cj, ci = q.popleft()
                cells.append((cj, ci))
                for dj in (-1, 0, 1):
                    for di in (-1, 0, 1):
                        if dj == 0 and di == 0:
                            continue
                        nj, ni = cj + dj, ci + di
                        if 0 <= nj < nz and 0 <= ni < nx and mask[nj, ni] and not seen[nj, ni]:
                            seen[nj, ni] = True
                            q.append((nj, ni))
            components.append(cells)
    components.sort(key=len, reverse=True)
    return components


def component_bbox(cells):
    js = [c[0] for c in cells]; is_ = [c[1] for c in cells]
    return min(js), max(js), min(is_), max(is_)


def subgrid_for_component(grid, cells, pad=20):
    j0, j1, i0, i1 = component_bbox(cells)
    j0 = max(0, j0 - pad); j1 = min(grid["nz"] - 1, j1 + pad)
    i0 = max(0, i0 - pad); i1 = min(grid["nx"] - 1, i1 + pad)
    return j0, j1, i0, i1


def clearance_transform(mask, j0, j1, i0, i1):
    sub = mask[j0:j1 + 1, i0:i1 + 1]
    h, w = sub.shape
    inf = 10 ** 9
    dist = np.full((h, w), inf, dtype=np.int32)
    q = deque()
    for j in range(h):
        for i in range(w):
            if not sub[j, i]:
                dist[j, i] = 0
                adjacent = False
                for dj in (-1, 0, 1):
                    for di in (-1, 0, 1):
                        nj, ni = j + dj, i + di
                        if 0 <= nj < h and 0 <= ni < w and sub[nj, ni]:
                            adjacent = True
                            break
                    if adjacent:
                        break
                if adjacent:
                    q.append((j, i))
    while q:
        cj, ci = q.popleft()
        for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            nj, ni = cj + dj, ci + di
            if 0 <= nj < h and 0 <= ni < w and sub[nj, ni] and dist[nj, ni] > dist[cj, ci] + 1:
                dist[nj, ni] = dist[cj, ci] + 1
                q.append((nj, ni))
    return sub, dist


def dijkstra(sub, weights, start, end, slope_limit=None, heights=None):
    h, w = sub.shape
    inf = 1e18
    dist = np.full((h, w), inf, dtype=np.float64)
    prev = np.full((h, w), -1, dtype=np.int64)
    dist[start] = 0.0
    pq = [(0.0, start)]
    dirs = ((-1, -1, math.sqrt(2)), (-1, 0, 1), (-1, 1, math.sqrt(2)),
            (0, -1, 1), (0, 1, 1),
            (1, -1, math.sqrt(2)), (1, 0, 1), (1, 1, math.sqrt(2)))
    while pq:
        cur, cell = heapq.heappop(pq)
        if cur > dist[cell]:
            continue
        if cell == end:
            break
        cj, ci = cell
        for dj, di, ew in dirs:
            n = (cj + dj, ci + di)
            if not (0 <= n[0] < h and 0 <= n[1] < w and sub[n[0], n[1]]):
                continue
            if slope_limit is not None and heights is not None:
                if abs(float(heights[n]) - float(heights[cell])) > slope_limit:
                    continue
            wgt = weights[n[0], n[1]]
            nd = cur + ew * CELL * wgt
            if nd < dist[n] - 1e-12:
                dist[n] = nd
                prev[n] = cell[0] * w + cell[1]
                heapq.heappush(pq, (nd, n))
    if not (dist[end] < inf * 0.5):
        return None, None, None
    path = []
    cur = end
    while cur != start and cur[0] >= 0:
        path.append(cur)
        p = prev[cur]
        if p < 0:
            return None, None, None
        cur = (p // w, p % w)
    path.append(start)
    path.reverse()
    return path, dist[end], dist


def path_length(path):
    return sum(
        math.hypot(path[k + 1][0] - path[k][0], path[k + 1][1] - path[k][1]) * CELL
        for k in range(len(path) - 1)
    )


def resample(path, x0, z0, step=SAMPLE_STEP):
    points = []
    for k in range(len(path) - 1):
        xa = x0 + path[k][1] * CELL; za = z0 + path[k][0] * CELL
        xb = x0 + path[k + 1][1] * CELL; zb = z0 + path[k + 1][0] * CELL
        d = math.hypot(xb - xa, zb - za)
        n = max(1, int(math.ceil(d / step)))
        for q in range(n):
            f = q / n
            points.append((xa + (xb - xa) * f, za + (zb - za) * f))
    points.append((x0 + path[-1][1] * CELL, z0 + path[-1][0] * CELL))
    return points


# ----------------------------------------------------------------------------
# Exact sampling / metrics
# ----------------------------------------------------------------------------

class Corridor:
    def __init__(self, visual_sections, visual_triangles, collision_triangles, out_dir):
        self.sections = visual_sections
        self.section_by_key = {s["key"]: s for s in visual_sections}
        self.visual_triangles = visual_triangles
        self.collision_triangles = collision_triangles
        self.out_dir = out_dir
        # indices: collision triangle -> id, visual triangle -> (id, section key)
        self.collision_index = PointIndex(collision_triangles)
        self.visual_index = PointIndex([t[:3] for t in visual_triangles])
        self.visual_key = [t[3] for t in visual_triangles]

    def sample(self, x, z):
        cy, cids = self.collision_index.collision_height(x, z)
        if cy is None:
            return {
                "x": round(x, 3), "z": round(z, 3), "coll": None, "vis": None,
                "delta": None, "section": None, "covered": False,
                "collisionTriangles": [], "visualTriangles": [],
            }
        delta, vidx = self.visual_index.best_visual(x, z, cy)
        vis = None if vidx is None else cy + delta
        section = None if vidx is None else self.visual_key[vidx]
        return {
            "x": round(x, 3), "z": round(z, 3), "coll": round(cy, 4),
            "vis": None if vis is None else round(vis, 4),
            "delta": None if delta is None else round(delta, 4),
            "section": section,
            "covered": bool(delta is not None and abs(delta) <= COVER_TOL),
            "collisionTriangles": sorted(set(cids)),
            "visualTriangles": [] if vidx is None else [vidx],
        }

    def measure(self, points):
        rows = []
        for x, z in points:
            rows.append(self.sample(x, z))
        # exact geometric distances between consecutive samples
        distances = [0.0]
        for k in range(1, len(rows)):
            distances.append(math.hypot(rows[k]["x"] - rows[k - 1]["x"],
                                        rows[k]["z"] - rows[k - 1]["z"]))
        total = sum(distances)
        segments = []
        gaps = []
        cur = []
        cur_gap = []
        for k, row in enumerate(rows):
            if row["covered"]:
                if cur_gap:
                    gaps.append(cur_gap); cur_gap = []
                cur.append(k)
            else:
                if cur:
                    segments.append(cur); cur = []
                cur_gap.append(k)
        if cur:
            segments.append(cur)
        if cur_gap:
            gaps.append(cur_gap)

        def run_length(indices):
            return sum(distances[k] for k in indices)

        segment_records = []
        for indices in segments:
            first, last = rows[indices[0]], rows[indices[-1]]
            segment_records.append({
                "lengthMetres": round(run_length(indices), 3),
                "start": [first["x"], first["z"]],
                "end": [last["x"], last["z"]],
                "startHeight": first["coll"],
                "endHeight": last["coll"],
                "sections": sorted(set(rows[k]["section"] for k in indices if rows[k]["section"])),
            })
        gap_records = []
        for indices in gaps:
            first, last = rows[indices[0]], rows[indices[-1]]
            gap_records.append({
                "lengthMetres": round(run_length(indices), 3),
                "start": [first["x"], first["z"]],
                "end": [last["x"], last["z"]],
                "startHeight": first["coll"],
                "endHeight": last["coll"],
            })

        # section metres (covered only)
        section_metres = Counter()
        for k in range(1, len(rows)):
            if rows[k]["covered"] and rows[k]["section"]:
                section_metres[rows[k]["section"]] += distances[k]

        # height steps / slope on exact samples
        max_step = 0.0
        max_step_at = None
        for k in range(1, len(rows)):
            if rows[k]["coll"] is None or rows[k - 1]["coll"] is None:
                continue
            dy = abs(rows[k]["coll"] - rows[k - 1]["coll"])
            if dy > max_step:
                max_step = dy
                max_step_at = [rows[k - 1]["x"], rows[k - 1]["z"], rows[k]["x"], rows[k]["z"]]
        max_slope = 0.0
        max_slope_at = None
        for k in range(1, len(rows)):
            if rows[k]["coll"] is None or rows[k - 1]["coll"] is None:
                continue
            d = distances[k]
            if d <= 1e-9:
                continue
            s = abs(rows[k]["coll"] - rows[k - 1]["coll"]) / d
            if s > max_slope:
                max_slope = s
                max_slope_at = [rows[k - 1]["x"], rows[k - 1]["z"], rows[k]["x"], rows[k]["z"]]

        return {
            "sampleStepMetres": SAMPLE_STEP,
            "sampleCount": len(rows),
            "coveredSamples": sum(1 for r in rows if r["covered"]),
            "coverageFraction": round(sum(1 for r in rows if r["covered"]) / len(rows), 6),
            "lengthMetres": round(total, 3),
            "segments": segment_records,
            "gaps": gap_records,
            "gapTotalMetres": round(sum(g["lengthMetres"] for g in gap_records), 3),
            "sectionMetres": {k: round(v, 2) for k, v in section_metres.most_common()},
            "maxHeightStepMetres": round(max_step, 4),
            "maxHeightStepAt": max_step_at,
            "maxSlopeDegrees": round(math.degrees(math.atan(max_slope)), 3),
            "maxSlopeAt": max_slope_at,
            "start": rows[0],
            "finish": rows[-1],
            "rows": rows,
            "distances": distances,
        }

    def width(self, path, x0, z0):
        points = resample(path, x0, z0)
        stations = []
        for i in range(0, len(points), 8):
            a = points[max(0, i - 4)]
            b = points[min(len(points) - 1, i + 4)]
            tx, tz = b[0] - a[0], b[1] - a[1]
            ln = math.hypot(tx, tz) or 1.0
            stations.append((points[i][0], points[i][1], tx / ln, tz / ln))
        widths = []
        rows = []
        for x, z, tx, tz in stations:
            nx, nz = -tz, tx
            covered = {}
            for j in range(-int(WIDTH_MAX / WIDTH_STEP), int(WIDTH_MAX / WIDTH_STEP) + 1):
                o = round(j * WIDTH_STEP, 2)
                px, pz = x + nx * o, z + nz * o
                cy = self.collision_index.collision_height(px, pz)[0]
                if cy is None:
                    covered[o] = False
                    continue
                delta = self.visual_index.best_visual(px, pz, cy)[0]
                covered[o] = delta is not None and abs(delta) <= COVER_TOL
            if not covered.get(0.0, False):
                w = 0.0
            else:
                left = 0.0
                o = -WIDTH_STEP
                while o >= -WIDTH_MAX and covered.get(round(o, 2), False):
                    left = -o; o -= WIDTH_STEP
                right = 0.0
                o = WIDTH_STEP
                while o <= WIDTH_MAX and covered.get(round(o, 2), False):
                    right = o; o += WIDTH_STEP
                w = left + right
            widths.append(w)
            rows.append({"x": round(x, 3), "z": round(z, 3), "widthMetres": round(w, 3)})
        widths_sorted = sorted(widths)
        return {
            "stationStepMetres": 2.0,
            "stations": len(widths),
            "minMetres": round(min(widths), 3),
            "medianMetres": round(widths_sorted[len(widths_sorted) // 2], 3),
            "meanMetres": round(sum(widths) / len(widths), 3),
            "maxMetres": round(max(widths), 3),
            "atLeast3m": sum(1 for w in widths if w >= 3.0),
            "atLeast6m": sum(1 for w in widths if w >= 6.0),
            "rows": rows,
        }


# ----------------------------------------------------------------------------
# SVG / HTML
# ----------------------------------------------------------------------------

def color_for(collision, covered, visual):
    if covered:
        return "#2e7d32"
    if collision:
        return "#9e9e9e"
    if visual:
        return "#90caf9"
    return None


def svg_map(grid, mask, recommended_path, max_path, spawn, finish, gaps, sections, out_svg):
    x0, z0, nx, nz = grid["x0"], grid["z0"], grid["nx"], grid["nz"]
    # main map around the spawn corridor
    mx0, mx1 = -150.0, 420.0
    mz0, mz1 = 900.0, 1420.0
    mw, mh = mx1 - mx0, mz1 - mz0
    scale = 2.0
    W, H = int(mw * scale), int(mh * scale)
    parts = []
    parts.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W + 260}" height="{H + 130}" '
        f'viewBox="0 0 {W + 260} {H + 130}" font-family="Segoe UI, Arial, sans-serif">'
    )
    parts.append(f'<rect width="{W + 260}" height="{H + 130}" fill="#11161c"/>')
    parts.append(f'<text x="16" y="28" fill="#e8eaed" font-size="18">USA LA River — measured covered corridor</text>')
    parts.append(f'<text x="16" y="48" fill="#9aa0a6" font-size="12">real committed draw triangles above + Level.levelphysics below · 1 m coverage grid · exact 0.25 m course samples</text>')

    # raster classes at 2 m, run-length rectangles
    step = 2.0
    for z in np.arange(mz0, mz1, step):
        j = int(round((z - z0) / CELL))
        if not (0 <= j < nz):
            continue
        run_start = None
        run_cls = None
        for x in np.arange(mx0, mx1 + step, step):
            i = int(round((x - x0) / CELL))
            if 0 <= i < nx:
                cls = color_for(
                    grid["coll_h"][j, i] > -1e30,
                    bool(mask[j, i]),
                    np.isfinite(grid["vis_min"][j, i]),
                )
            else:
                cls = None
            if cls != run_cls:
                if run_cls is not None and run_start is not None:
                    rx = (run_start - mx0) * scale
                    ry = (z - mz0) * scale
                    rw = (x - run_start) * scale
                    parts.append(
                        f'<rect x="{rx:.1f}" y="{ry:.1f}" width="{rw:.1f}" height="{step * scale:.1f}" fill="{run_cls}" opacity="0.55"/>'
                    )
                run_cls = cls
                run_start = x
        if run_cls is not None and run_start is not None:
            rx = (run_start - mx0) * scale
            ry = (z - mz0) * scale
            rw = (mx1 - run_start) * scale
            parts.append(
                f'<rect x="{rx:.1f}" y="{ry:.1f}" width="{rw:.1f}" height="{step * scale:.1f}" fill="{run_cls}" opacity="0.55"/>'
            )

    # grid ticks
    for x in range(int(mx0), int(mx1) + 1, 50):
        px = (x - mx0) * scale
        parts.append(f'<line x1="{px:.1f}" y1="0" x2="{px:.1f}" y2="{H}" stroke="#263238" stroke-width="0.5"/>')
        parts.append(f'<text x="{px + 2:.1f}" y="{H + 14}" fill="#78909c" font-size="9">{x}</text>')
    for z in range(int(mz0), int(mz1) + 1, 50):
        py = (z - mz0) * scale
        parts.append(f'<line x1="0" y1="{py:.1f}" x2="{W}" y2="{py:.1f}" stroke="#263238" stroke-width="0.5"/>')
        parts.append(f'<text x="2" y="{py - 2:.1f}" fill="#78909c" font-size="9">{z}</text>')

    def poly(path, color, width, dash=None):
        pts = " ".join(
            f"{(grid['x0'] + i * CELL - mx0) * scale:.1f},{(grid['z0'] + j * CELL - mz0) * scale:.1f}"
            for j, i in path
        )
        d = f' stroke-dasharray="{dash}"' if dash else ""
        parts.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="{width}"{d} stroke-linejoin="round"/>')

    # max path (dashed) then recommended (solid)
    poly(max_path, "#ffb300", 1.4, "5 4")
    poly(recommended_path, "#ff6d00", 2.6)

    # gaps as red diamonds
    for g in gaps:
        gx, gz = g["start"]
        px = (gx - mx0) * scale
        py = (gz - mz0) * scale
        parts.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="4" fill="#e53935"/>')

    # start / finish
    for (sx, sz, label, col) in (
        (spawn[0], spawn[1], "start / current spawn", "#00e676"),
        (finish[0], finish[1], "finish", "#ff5252"),
    ):
        px = (sx - mx0) * scale
        py = (sz - mz0) * scale
        parts.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="5" fill="{col}" stroke="#11161c" stroke-width="1.5"/>')
        parts.append(f'<text x="{px + 8:.1f}" y="{py + 4:.1f}" fill="{col}" font-size="11">{label}</text>')

    # legend
    lx = W + 18
    ly = 70
    legend = [
        ("#2e7d32", "covered (draw + collision)"),
        ("#9e9e9e", "collision only (no near draw)"),
        ("#90caf9", "draw only (no collision)"),
        ("#ff6d00", "recommended course"),
        ("#ffb300", "max covered route (has step)"),
        ("#e53935", "gap run"),
    ]
    for col, text in legend:
        parts.append(f'<rect x="{lx}" y="{ly - 10}" width="14" height="10" fill="{col}" opacity="0.8"/>')
        parts.append(f'<text x="{lx + 20}" y="{ly}" fill="#cfd8dc" font-size="11">{text}</text>')
        ly += 20

    # section labels at their reference bounds (source sections used)
    ly += 10
    parts.append(f'<text x="{lx}" y="{ly}" fill="#e8eaed" font-size="12">source sections</text>')
    ly += 18
    for key in sorted({k for k in sections}):
        s = sections[key]
        parts.append(f'<text x="{lx}" y="{ly}" fill="#b0bec5" font-size="10">{key}: {s["drawCount"]} draws / {s["triangleCount"]} tri</text>')
        ly += 14

    # inset: whole level at 20 m
    ix, iy, iw, ih = lx, ly + 16, 220, 220
    parts.append(f'<rect x="{ix}" y="{iy}" width="{iw}" height="{ih}" fill="#0b0f13" stroke="#37474f"/>')
    sx = iw / (grid["nx"] * CELL); sz = ih / (grid["nz"] * CELL)
    for z in range(0, grid["nz"], 20):
        for x in range(0, grid["nx"], 20):
            if mask[z, x]:
                parts.append(f'<rect x="{ix + x * CELL * sx:.1f}" y="{iy + z * CELL * sz:.1f}" width="{20 * CELL * sx:.1f}" height="{20 * CELL * sz:.1f}" fill="#2e7d32" opacity="0.55"/>')
    parts.append(f'<rect x="{ix + (mx0 - grid["x0"]) * sx:.1f}" y="{iy + (mz0 - grid["z0"]) * sz:.1f}" width="{mw * sx:.1f}" height="{mh * sz:.1f}" fill="none" stroke="#ff6d00"/>')
    parts.append(f'<text x="{ix}" y="{iy + ih + 14}" fill="#78909c" font-size="10">whole level · 20 m cells</text>')

    parts.append("</svg>")
    out_svg.write_text("\n".join(parts) + "\n", encoding="utf-8")


def html_document(svg_text, summary, out_html):
    rows = "".join(
        f"<tr><td>{k}</td><td>{v}</td></tr>"
        for k, v in [
            ("course", summary["course"]["name"]),
            ("length", f'{summary["course"]["lengthMetres"]:.2f} m'),
            ("start", summary["course"]["start"]),
            ("finish", summary["course"]["finish"]),
            ("covered samples", f'{summary["course"]["coveredSamples"]}/{summary["course"]["sampleCount"]}'),
            ("gaps", f'{summary["course"]["gapTotalMetres"]:.2f} m in {len(summary["course"]["gaps"])} runs'),
            ("width median", f'{summary["course"]["width"]["medianMetres"]:.2f} m'),
            ("sections", ", ".join(summary["course"]["sectionMetres"])),
            ("max route", f'{summary["maxRoute"]["lengthMetres"]:.2f} m ({summary["maxRoute"]["maxHeightStepMetres"]:.2f} m step)'),
            ("component route", f'{summary["componentRoute"]["lengthMetres"]:.2f} m'),
            ("lap", summary["lap"]["result"]),
        ]
    )
    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Blur River track coverage</title>
<style>body{{background:#11161c;color:#cfd8dc;font-family:Segoe UI,Arial,sans-serif;margin:24px}}
h1{{color:#e8eaed;font-size:20px}} table{{border-collapse:collapse;margin-top:18px}}
td{{border:1px solid #37474f;padding:4px 10px;font-size:12px}} td:first-child{{color:#90a4ae}}
p{{max-width:900px;font-size:12px;line-height:1.5}} code{{color:#ffcc80}}</style></head>
<body><h1>USA LA River — measured covered corridor</h1>
<p>Derived from the committed level draw geometry and <code>Level.levelphysics</code>.
Green = a real draw triangle within 0.5 m of the collision surface; grey = collision
only; blue = draw only. The orange line is the recommended course; the dashed
amber line is the longer covered route that contains a vertical step.</p>
{svg_text}
<table>{rows}</table>
<p>Run <code>python probes/track-coverage/tools/build_corridor.py</code> to regenerate
this map and <code>corridor.json</code>. No renderer or game claim is made.</p>
</body></html>"""
    out_html.write_text(html, encoding="utf-8")


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def main(argv) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--visual", type=Path, default=DEFAULT_OUT / "visual.json")
    args = ap.parse_args(argv)
    out = args.out_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    if not args.visual.is_file():
        print(f"build_corridor: BLOCKED: missing {args.visual}; run build_reference.py first", file=sys.stderr)
        return 3

    visual_doc, sections, visual_triangles = load_visual_sections(args.visual)
    physics_path = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
    physics_bytes, collision_triangles = load_collision(physics_path)
    print(f"sections={len(sections)} visualTriangles={len(visual_triangles)} collisionTriangles={len(collision_triangles)}")

    extents = grid_extents(collision_triangles)
    grid = rasterize(collision_triangles, visual_triangles, extents)
    mask = coverage_mask(grid)
    print(f"grid={grid['nx']}x{grid['nz']} coveredCells={int(mask.sum())}")

    components = label_components(mask)
    sx = int(round((SPAWN[0] - grid["x0"]) / CELL))
    sz = int(round((SPAWN[1] - grid["z0"]) / CELL))
    spawn_component = None
    for cells in components:
        if (sz, sx) in set(cells):
            spawn_component = cells
            break
    if spawn_component is None:
        print("build_corridor: FAILED: spawn is not on a covered cell", file=sys.stderr)
        return 2
    component_index = components.index(spawn_component)
    print(f"spawn component: {len(spawn_component)} cells (rank {component_index})")

    j0, j1, i0, i1 = subgrid_for_component(grid, spawn_component)
    sub, clear = clearance_transform(mask, j0, j1, i0, i1)
    start = (sz - j0, sx - i0)
    heights = grid["coll_h"][j0:j1 + 1, i0:i1 + 1]

    # unweighted farthest reachable cell from the spawn
    ones = np.ones_like(clear, dtype=np.float64)
    h, w = sub.shape
    inf = 1e18
    dist = np.full((h, w), inf, dtype=np.float64)
    dist[start] = 0.0
    pq = [(0.0, start)]
    dirs = ((-1, -1, math.sqrt(2)), (-1, 0, 1), (-1, 1, math.sqrt(2)),
            (0, -1, 1), (0, 1, 1), (1, -1, math.sqrt(2)), (1, 0, 1), (1, 1, math.sqrt(2)))
    while pq:
        cur, cell = heapq.heappop(pq)
        if cur > dist[cell]:
            continue
        cj, ci = cell
        for dj, di, ew in dirs:
            n = (cj + dj, ci + di)
            if not (0 <= n[0] < h and 0 <= n[1] < w and sub[n[0], n[1]]):
                continue
            nd = cur + ew * CELL
            if nd < dist[n] - 1e-12:
                dist[n] = nd
                heapq.heappush(pq, (nd, n))
    farthest = max(
        ((j, i) for j in range(h) for i in range(w) if dist[j, i] < inf * 0.5),
        key=lambda c: (dist[c], -c[0], -c[1]),
    )
    print(f"farthest reachable: ({grid['x0'] + (i0 + farthest[1]) * CELL:.1f}, {grid['z0'] + (j0 + farthest[0]) * CELL:.1f}) at {dist[farthest]:.1f} m")

    # clearance-weighted path to farthest
    weights = 1.0 + 2.0 / (clear + 0.5)
    max_path, _, _ = dijkstra(sub, weights, start, farthest, heights=heights)
    if max_path is None:
        print("build_corridor: FAILED: no clearance-weighted path", file=sys.stderr)
        return 2
    max_path_world = [(j0 + j, i0 + i) for j, i in max_path]
    max_points = resample(max_path_world, grid["x0"], grid["z0"])
    corridor = Corridor(sections, visual_triangles, collision_triangles, out)
    max_measure = corridor.measure(max_points)
    print(f"max route: {max_measure['lengthMetres']:.2f} m, coverage {max_measure['coverageFraction']*100:.2f}%")

    # smooth course: truncate before the first vertical step > STEP_LIMIT
    rows = max_measure["rows"]
    step_index = None
    for k in range(1, len(rows)):
        if rows[k]["coll"] is None or rows[k - 1]["coll"] is None:
            continue
        if abs(rows[k]["coll"] - rows[k - 1]["coll"]) > STEP_LIMIT:
            step_index = k
            break
    if step_index is None:
        rec_points = max_points
        rec_path_world = max_path_world
    else:
        rec_points = max_points[:step_index]
        # truncate the 1 m path at the cell nearest the last recommended sample
        fx, fz = rec_points[-1]
        rec_path_world = max_path_world
        while rec_path_world:
            px = grid["x0"] + rec_path_world[-1][1] * CELL
            pz = grid["z0"] + rec_path_world[-1][0] * CELL
            if abs(px - fx) <= 1.0 and abs(pz - fz) <= 1.0:
                break
            rec_path_world = rec_path_world[:-1]
    rec_measure = corridor.measure(rec_points)
    rec_width = corridor.width(rec_path_world, grid["x0"], grid["z0"])
    max_width = corridor.width(max_path_world, grid["x0"], grid["z0"])
    print(f"recommended: {rec_measure['lengthMetres']:.2f} m, coverage {rec_measure['coverageFraction']*100:.2f}%, gaps {rec_measure['gapTotalMetres']:.2f} m")

    # component diameter (north-south route) using extreme starts, for the report
    extremes = [
        min(spawn_component, key=lambda c: c[1]),
        max(spawn_component, key=lambda c: c[1]),
        min(spawn_component, key=lambda c: c[0]),
        max(spawn_component, key=lambda c: c[0]),
        min(spawn_component, key=lambda c: c[0] + c[1]),
        max(spawn_component, key=lambda c: c[0] + c[1]),
    ]
    best = (0.0, None, None)
    candidates = []
    for s in extremes:
        s_local = (s[0] - j0, s[1] - i0)
        if not (0 <= s_local[0] < h and 0 <= s_local[1] < w and sub[s_local]):
            continue
        # compute all distances from s_local
        inf = 1e18
        dist2 = np.full((h, w), inf, dtype=np.float64)
        dist2[s_local] = 0.0
        pq = [(0.0, s_local)]
        while pq:
            cur, cell = heapq.heappop(pq)
            if cur > dist2[cell]:
                continue
            cj, ci = cell
            for dj, di, ew in dirs:
                n = (cj + dj, ci + di)
                if not (0 <= n[0] < h and 0 <= n[1] < w and sub[n[0], n[1]]):
                    continue
                nd = cur + ew * CELL
                if nd < dist2[n] - 1e-12:
                    dist2[n] = nd
                    heapq.heappush(pq, (nd, n))
        f = max(
            ((jj, ii) for jj in range(h) for ii in range(w) if dist2[jj, ii] < inf * 0.5),
            key=lambda c: (dist2[c], -c[0], -c[1]),
        )
        if dist2[f] > best[0]:
            best = (dist2[f], s_local, f)
        candidates.append((dist2[f], s_local, f))
    # Pick the longest candidate whose exact 0.5 m coverage is >= 99%.
    candidates.sort(key=lambda c: (-c[0], c[1], c[2]))
    component_route = None
    fallback = None
    for distance, s_local, f in candidates:
        comp_path, _, _ = dijkstra(sub, weights, s_local, f, heights=heights)
        if comp_path is None:
            continue
        comp_world = [(j0 + j, i0 + i) for j, i in comp_path]
        comp_points = resample(comp_world, grid["x0"], grid["z0"], step=0.5)
        comp_measure = corridor.measure(comp_points)
        record = {
            "lengthMetres": comp_measure["lengthMetres"],
            "start": [grid["x0"] + s_local[1] * CELL, grid["z0"] + s_local[0] * CELL],
            "finish": [grid["x0"] + f[1] * CELL, grid["z0"] + f[0] * CELL],
            "sampleStepMetres": 0.5,
            "coveredSamples": comp_measure["coveredSamples"],
            "sampleCount": comp_measure["sampleCount"],
            "coverageFraction": comp_measure["coverageFraction"],
            "gapTotalMetres": comp_measure["gapTotalMetres"],
            "maxHeightStepMetres": comp_measure["maxHeightStepMetres"],
            "maxHeightStepAt": comp_measure["maxHeightStepAt"],
            "continuous": comp_measure["coverageFraction"] >= 0.99,
        }
        if fallback is None or record["coverageFraction"] > fallback["coverageFraction"]:
            fallback = record
        if record["continuous"]:
            component_route = record
            break
    if component_route is None:
        component_route = fallback
    if component_route is not None:
        if not component_route["continuous"]:
            component_route["note"] = (
                "largest grid diameter; exact 0.5 m sampling finds "
                f"{component_route['gapTotalMetres']:.1f} m of gaps, so this is not a continuous course"
            )
        print(f"component route: {component_route['lengthMetres']:.1f} m, coverage {component_route['coverageFraction']*100:.2f}%")

    # hole/lap evidence: largest enclosed hole of the spawn component
    js = [c[0] for c in spawn_component]; is_ = [c[1] for c in spawn_component]
    cj0, cj1 = min(js) - 1, max(js) + 1
    ci0, ci1 = min(is_) - 1, max(is_) + 1
    hh, ww = cj1 - cj0 + 1, ci1 - ci0 + 1
    local = np.zeros((hh, ww), dtype=bool)
    for j, i in spawn_component:
        local[j - cj0, i - ci0] = True
    outside = np.zeros_like(local, dtype=bool)
    q = deque()
    for j in range(hh):
        for i in (0, ww - 1):
            if not local[j, i] and not outside[j, i]:
                outside[j, i] = True; q.append((j, i))
    for i in range(ww):
        for j in (0, hh - 1):
            if not local[j, i] and not outside[j, i]:
                outside[j, i] = True; q.append((j, i))
    while q:
        cj, ci = q.popleft()
        for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nj, ni = cj + dj, ci + di
            if 0 <= nj < hh and 0 <= ni < ww and not local[nj, ni] and not outside[nj, ni]:
                outside[nj, ni] = True; q.append((nj, ni))
    holes = []
    seen_h = np.zeros_like(local, dtype=bool)
    for j in range(hh):
        for i in range(ww):
            if local[j, i] or outside[j, i] or seen_h[j, i]:
                continue
            q = deque([(j, i)]); seen_h[j, i] = True; cells = []
            while q:
                cj, ci = q.popleft(); cells.append((cj, ci))
                for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nj, ni = cj + dj, ci + di
                    if 0 <= nj < hh and 0 <= ni < ww and not local[nj, ni] and not outside[nj, ni] and not seen_h[nj, ni]:
                        seen_h[nj, ni] = True; q.append((nj, ni))
            holes.append(cells)
    holes.sort(key=len, reverse=True)
    largest_hole = None
    if holes:
        cells = holes[0]
        xs = [grid["x0"] + (ci0 + i) * CELL for j, i in cells]
        zs = [grid["z0"] + (cj0 + j) * CELL for j, i in cells]
        largest_hole = {
            "cells": len(cells),
            "bounds": [round(min(xs), 1), round(min(zs), 1), round(max(xs), 1), round(max(zs), 1)],
        }

    # section counts
    used_keys = list(rec_measure["sectionMetres"].keys())
    section_records = {}
    for key in used_keys:
        s = next((x for x in sections if x["key"] == key), None)
        if s:
            section_records[key] = {
                "geometryBlock": s["geometryBlock"],
                "nodeBlock": s["nodeBlock"],
                "geometryChunkIndex": s["geometryChunkIndex"],
                "nodeChunkIndex": s["nodeChunkIndex"],
                "vertexCount": s["vertexCount"],
                "triangleCount": s["triangleCount"],
                "drawCount": s["drawCount"],
                "bounds": s["bounds"],
                "positionsSha256": s["positionsSha256"],
                "indicesSha256": s["indicesSha256"],
            }

    # distinct triangles under the course
    coll_under = set()
    vis_under = set()
    for row in rec_measure["rows"]:
        coll_under.update(row.get("collisionTriangles", []))
        vis_under.update(row.get("visualTriangles", []))

    summary = {
        "kind": "track-coverage.corridor",
        "version": 1,
        "source": {
            "level": "usa_la_river",
            "levelPhysics": str(physics_path.relative_to(ROOT)).replace("\\", "/"),
            "levelPhysicsSha256": sha256_bytes(physics_bytes),
            "visual": str(args.visual.relative_to(ROOT)).replace("\\", "/"),
            "visualSha256": sha256_bytes(args.visual.read_bytes()),
            "visualSections": len(sections),
            "reader": "tools/inspect_level_candidates.py + tools/inspect_level_chunk.py",
            "instancesApplied": False,
            "mapOnly": False,
        },
        "rule": {
            "grid": "1 m XZ cells; collision height = max up-facing Level.levelphysics triangle (normal.y > 0.5); visual height = nearest committed draw triangle (normal.y > 0.1) in the same XZ cell",
            "covered": f"a cell is covered when the nearest committed draw triangle is within {COVER_TOL} m of the collision surface; the exact course is sampled at {SAMPLE_STEP} m with point-in-triangle tests",
            "path": "unweighted Dijkstra from the committed spawn to the farthest reachable covered cell, then a clearance-weighted Dijkstra (cost = step * (1 + 2/(clearance+0.5))) to that cell; the smooth course is truncated before the first height step > " + str(STEP_LIMIT) + " m",
            "width": f"perpendicular covered run at {WIDTH_STEP} m offsets up to ±{WIDTH_MAX} m, every 2 m along the path",
            "noGuess": "no transform, vertex, triangle or path point is typed in; every coordinate comes from the file or the measured grid",
        },
        "spawn": {
            "x": SPAWN[0], "z": SPAWN[1],
            "groundY": rec_measure["start"]["coll"],
            "source": "committed E1 spawn (spawn.json); ground from Level.levelphysics",
        },
        "course": {
            "name": "recommended smooth sprint extension",
            "lengthMetres": rec_measure["lengthMetres"],
            "start": [rec_measure["start"]["x"], rec_measure["start"]["z"]],
            "finish": [rec_measure["finish"]["x"], rec_measure["finish"]["z"]],
            "startHeight": rec_measure["start"]["coll"],
            "finishHeight": rec_measure["finish"]["coll"],
            "sampleStepMetres": rec_measure["sampleStepMetres"],
            "sampleCount": rec_measure["sampleCount"],
            "coveredSamples": rec_measure["coveredSamples"],
            "coverageFraction": rec_measure["coverageFraction"],
            "gapTotalMetres": rec_measure["gapTotalMetres"],
            "segments": rec_measure["segments"],
            "gaps": rec_measure["gaps"],
            "sectionMetres": rec_measure["sectionMetres"],
            "width": rec_width,
            "maxHeightStepMetres": rec_measure["maxHeightStepMetres"],
            "maxHeightStepAt": rec_measure["maxHeightStepAt"],
            "maxSlopeDegrees": rec_measure["maxSlopeDegrees"],
            "maxSlopeAt": rec_measure["maxSlopeAt"],
            "drawCount": sum(section_records[k]["drawCount"] for k in section_records),
            "triangleCount": sum(section_records[k]["triangleCount"] for k in section_records),
            "vertexCount": sum(section_records[k]["vertexCount"] for k in section_records),
            "collisionTrianglesUnderCourse": len(coll_under),
            "visualTrianglesUnderCourse": len(vis_under),
        },
        "maxRoute": {
            "name": "longest covered route from the committed spawn",
            "lengthMetres": max_measure["lengthMetres"],
            "start": [max_measure["start"]["x"], max_measure["start"]["z"]],
            "finish": [max_measure["finish"]["x"], max_measure["finish"]["z"]],
            "coverageFraction": max_measure["coverageFraction"],
            "gapTotalMetres": max_measure["gapTotalMetres"],
            "maxHeightStepMetres": max_measure["maxHeightStepMetres"],
            "maxHeightStepAt": max_measure["maxHeightStepAt"],
            "segments": max_measure["segments"],
            "gaps": max_measure["gaps"],
            "width": max_width,
        },
        "componentRoute": component_route,
        "component": {
            "cells": len(spawn_component),
            "rank": component_index + 1,
            "bbox": [
                round(grid["x0"] + min(is_) * CELL, 1),
                round(grid["z0"] + min(js) * CELL, 1),
                round(grid["x0"] + max(is_) * CELL, 1),
                round(grid["z0"] + max(js) * CELL, 1),
            ],
        },
        "lap": {
            "result": "not possible from the committed data",
            "reason": "the measured course is point-to-point; the spawn component has no second return corridor (largest enclosed hole is listed), and the nearest other covered component is separated by open cells",
            "largestEnclosedHole": largest_hole,
        },
        "sections": section_records,
    }
    summary["hash"] = canonical_hash(summary)

    (out / "corridor.json").write_text(json.dumps(summary, indent=1) + "\n", encoding="utf-8")
    for name, measure in (("course_samples.json", rec_measure), ("max_samples.json", max_measure)):
        sample_doc = {
            "kind": "track-coverage.course-samples",
            "version": 1,
            "corridorHash": summary["hash"],
            "sampleStepMetres": measure["sampleStepMetres"],
            "samples": [
                {
                    "x": float(row["x"]), "z": float(row["z"]),
                    "coll": None if row["coll"] is None else float(row["coll"]),
                    "vis": None if row["vis"] is None else float(row["vis"]),
                    "delta": None if row["delta"] is None else float(row["delta"]),
                    "section": None if row["section"] is None else str(row["section"]),
                    "covered": bool(row["covered"]),
                }
                for row in measure["rows"]
            ],
        }
        (out / name).write_text(json.dumps(sample_doc, separators=(",", ":")) + "\n", encoding="utf-8")
    svg_map(grid, mask, rec_path_world, max_path_world, SPAWN,
            (rec_measure["finish"]["x"], rec_measure["finish"]["z"]),
            rec_measure["gaps"], {k: section_records[k] for k in section_records}, out / "corridor.svg")
    html_document((out / "corridor.svg").read_text(encoding="utf-8"), summary, out / "corridor.html")

    compact = {
        "kind": "track-coverage.summary",
        "version": 1,
        "corridor": {
            "lengthMetres": rec_measure["lengthMetres"],
            "start": [rec_measure["start"]["x"], rec_measure["start"]["z"]],
            "finish": [rec_measure["finish"]["x"], rec_measure["finish"]["z"]],
            "coverageFraction": rec_measure["coverageFraction"],
            "gapTotalMetres": rec_measure["gapTotalMetres"],
            "segments": len(rec_measure["segments"]),
            "gaps": len(rec_measure["gaps"]),
            "widthMedianMetres": rec_width["medianMetres"],
            "sectionMetres": rec_measure["sectionMetres"],
        },
        "maxRoute": {
            "lengthMetres": max_measure["lengthMetres"],
            "coverageFraction": max_measure["coverageFraction"],
            "maxHeightStepMetres": max_measure["maxHeightStepMetres"],
        },
        "componentRoute": component_route,
        "lap": summary["lap"],
        "hash": summary["hash"],
        "files": {
            "corridor": "_work/track-coverage/corridor.json",
            "svg": "_work/track-coverage/corridor.svg",
            "html": "_work/track-coverage/corridor.html",
        },
    }
    (out / "summary.json").write_text(json.dumps(compact, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({
        "corridor": {
            "lengthMetres": rec_measure["lengthMetres"],
            "start": [rec_measure["start"]["x"], rec_measure["start"]["z"]],
            "finish": [rec_measure["finish"]["x"], rec_measure["finish"]["z"]],
            "coverage": round(rec_measure["coverageFraction"] * 100, 3),
            "gaps": rec_measure["gapTotalMetres"],
            "widthMedian": rec_width["medianMetres"],
        },
        "maxRoute": {
            "lengthMetres": max_measure["lengthMetres"],
            "maxHeightStepMetres": max_measure["maxHeightStepMetres"],
        },
        "componentRoute": component_route,
        "hash": summary["hash"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
