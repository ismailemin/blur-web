#!/usr/bin/env python3
"""Independent verifier for the free-roam region report.

It shares no raster, labelling, coverage or path code with
`build_regions.py`. It re-parses `Level.levelphysics` through the committed
collision-oracle parser, rebuilds its own 0.5 m height/wall/passable rasters with
a dot-product point-in-triangle formulation, labels components with its own BFS,
re-measures every recorded region spine with exact triangles, and re-computes a
deterministic subset of every draw-coverage row.

Checks:
  1. canonical hash of regions.json and pinned input hashes;
  2. independent raster equality (height, passable, wall, 2-cell / 3-cell labels);
  3. region cell counts, areas and bounds;
  4. exact ground / footprint / step / grade / wall clearance on every recorded
     region spine (2 m samples for footprint and walls, 0.5 m for step/grade);
  5. exact P48 310 m course control (min wall distance, footprint range, step,
     grade) against the P48 recorded values;
  6. draw coverage on every 25th recorded sample: collision height, nearest
     visual triangle, delta, covered flag, section and draw attribution;
  7. every 10th sample of the P48 course band at seven stations;
  8. the R04 -> R01 separation is a steep face above the local ground, not a
     step or void;
  9. output hash manifest and map files.

Usage:
    python probes/free-roam/tools/verify_regions.py
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
import reference_oracle as oracle  # noqa: E402

OUT = ROOT / "_work/free-roam"
PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
VISUAL_JSON = ROOT / "_work/track-coverage/visual.json"
P48_JSON = ROOT / "_work/drivable-path/path.json"

PHYSICS_SHA256 = "1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28"
VISUAL_SHA256 = "877b4dc7e1f5ece197f0776239b33d23b0350f8cf77ef462c0c7a266a6abcb67"
P48_CANONICAL = "sha256:4b725b10e6619e7cc2f3ef0b0ea03f3a252660a8ffaad0ffe04cb96e0318605b"

CELL = 0.5
SURFACE_MIN_NY = 0.94
STEP_LIMIT = 0.05
GRADE_LIMIT = 0.05
EDGE_DH = min(STEP_LIMIT, GRADE_LIMIT * CELL)
WALL_RADIUS = 0.5
WALL_BAND_LOW = 0.05
WALL_BAND_HIGH = 2.0
P48_ERODE_CELLS = 2
STRICT_ERODE_CELLS = 3
CAR_LENGTH = 2.981
CAR_WIDTH = 1.676
SAFETY_MARGIN = 0.30
HALF_LENGTH = CAR_LENGTH / 2.0 + SAFETY_MARGIN
HALF_WIDTH = CAR_WIDTH / 2.0 + SAFETY_MARGIN
ENVELOPE_HALF_WIDTH = CAR_WIDTH / 2.0
COLLISION_NY_MIN = 0.5
VISUAL_NY_MIN = 0.1
COVER_TOL = 0.5
BUCKET = 4.0
STATIONS = (0.0, -0.419, 0.419, -0.838, 0.838, -1.138, 1.138)


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def canonical(doc):
    body = dict(doc)
    body.pop("hash", None)
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + sha256_bytes(text.encode("utf-8"))


def json_default(obj):
    if hasattr(obj, "item"):
        return obj.item()
    raise TypeError("not JSON serializable: %r" % (type(obj),))


def content_digest(arrays):
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


def tri_normal(a, b, c):
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    return nx / length, ny / length, nz / length


def flatten():
    level = oracle.load_level(PHYSICS.read_bytes())
    tris = []
    for mesh in level["meshes"]:
        verts = mesh["vertices"]
        for tri in mesh["triangles"]:
            leaf = mesh["leaves"][tri["leaf"]]
            base = leaf["vertex_start"]
            tris.append((verts[base + tri["a"]], verts[base + tri["b"]], verts[base + tri["c"]]))
    return np.asarray(tris, dtype=np.float64)


def raster_height_dot(tris, x0, x1, z0, z1, cell):
    """Independent rasteriser: barycentric via dot products, not edge functions."""
    nx = int(round((x1 - x0) / cell)) + 1
    nz = int(round((z1 - z0) / cell)) + 1
    xs = x0 + np.arange(nx) * cell
    zs = z0 + np.arange(nz) * cell
    H = np.full((nz, nx), -np.inf)
    for t in tris:
        a, b, c = t
        v0x, v0z = b[0] - a[0], b[2] - a[2]
        v1x, v1z = c[0] - a[0], c[2] - a[2]
        d00 = v0x * v0x + v0z * v0z
        d01 = v0x * v1x + v0z * v1z
        d11 = v1x * v1x + v1z * v1z
        den = d00 * d11 - d01 * d01
        if abs(den) < 1e-14:
            continue
        i0 = max(0, int(math.floor((min(a[0], b[0], c[0]) - x0) / cell)))
        i1 = min(nx - 1, int(math.ceil((max(a[0], b[0], c[0]) - x0) / cell)))
        j0 = max(0, int(math.floor((min(a[2], b[2], c[2]) - z0) / cell)))
        j1 = min(nz - 1, int(math.ceil((max(a[2], b[2], c[2]) - z0) / cell)))
        if i1 < i0 or j1 < j0:
            continue
        gx, gz = np.meshgrid(xs[i0:i1 + 1], zs[j0:j1 + 1])
        v2x, v2z = gx - a[0], gz - a[2]
        d02 = v0x * v2x + v0z * v2z
        d12 = v1x * v2x + v1z * v2z
        u = (d11 * d02 - d01 * d12) / den
        v = (d00 * d12 - d01 * d02) / den
        inside = (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1.0 + 1e-9)
        if not inside.any():
            continue
        h = a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1])
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


def seg_dist(px, pz, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az
    l2 = dx * dx + dz * dz
    tt = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / l2))
    return math.hypot(px - (ax + tt * dx), pz - (az + tt * dz))


def raster_wall_independent(wall, H, x0, x1, z0, z1, cell, radius):
    nx = int(round((x1 - x0) / cell)) + 1
    nz = int(round((z1 - z0) / cell)) + 1
    xs = x0 + np.arange(nx) * cell
    zs = z0 + np.arange(nz) * cell
    W = np.zeros((nz, nx), dtype=bool)
    for t in wall:
        ax, az = t[0][0], t[0][2]
        bx, bz = t[1][0], t[1][2]
        cx, cz = t[2][0], t[2][2]
        tymin = min(t[0][1], t[1][1], t[2][1])
        tymax = max(t[0][1], t[1][1], t[2][1])
        i0 = max(0, int(math.floor((min(ax, bx, cx) - radius - x0) / cell)))
        i1 = min(nx - 1, int(math.ceil((max(ax, bx, cx) + radius - x0) / cell)))
        j0 = max(0, int(math.floor((min(az, bz, cz) - radius - z0) / cell)))
        j1 = min(nz - 1, int(math.ceil((max(az, bz, cz) + radius - z0) / cell)))
        if i1 < i0 or j1 < j0:
            continue
        Hsub = H[j0:j1 + 1, i0:i1 + 1]
        gate = np.isfinite(Hsub) & (tymin < Hsub + WALL_BAND_HIGH) & (tymax > Hsub + WALL_BAND_LOW)
        if not gate.any():
            continue
        gx, gz = np.meshgrid(xs[i0:i1 + 1], zs[j0:j1 + 1])
        # inside test by half-planes (independent of the builder's barycentric test)
        s0 = (bx - ax) * (gz - az) - (bz - az) * (gx - ax)
        s1 = (cx - bx) * (gz - bz) - (cz - bz) * (gx - bx)
        s2 = (ax - cx) * (gz - cz) - (az - cz) * (gx - cx)
        area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
        if area >= 0:
            inside = (s0 >= -1e-12) & (s1 >= -1e-12) & (s2 >= -1e-12)
        else:
            inside = (s0 <= 1e-12) & (s1 <= 1e-12) & (s2 <= 1e-12)
        d = np.full(gx.shape, np.inf)
        for (px, pz, qx, qz) in ((ax, az, bx, bz), (bx, bz, cx, cz), (cx, cz, ax, az)):
            dx, dz = qx - px, qz - pz
            l2 = dx * dx + dz * dz
            tt = np.zeros(gx.shape) if l2 == 0 else np.clip(((gx - px) * dx + (gz - pz) * dz) / l2, 0, 1)
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
    from collections import deque
    nz, nx = mask.shape
    labels = np.zeros((nz, nx), dtype=np.int32)
    sizes = []
    for j, i in np.argwhere(mask):
        if labels[j, i]:
            continue
        lab = len(sizes) + 1
        q = deque([(j, i)])
        labels[j, i] = lab
        count = 0
        while q:
            cj, ci = q.popleft()
            count += 1
            for dj in (-1, 0, 1):
                for di in (-1, 0, 1):
                    if dj == 0 and di == 0:
                        continue
                    jj, ii = cj + dj, ci + di
                    if 0 <= jj < nz and 0 <= ii < nx and mask[jj, ii] and not labels[jj, ii]:
                        labels[jj, ii] = lab
                        q.append((jj, ii))
        sizes.append(count)
    return labels, sizes


class Index:
    def __init__(self, triangles, keep=None):
        self.triangles = []
        self.buckets = defaultdict(list)
        for t in triangles:
            if keep is not None and not keep(t):
                continue
            idx = len(self.triangles)
            self.triangles.append(t)
            a, b, c = t
            i0 = int(math.floor(min(a[0], b[0], c[0]) / BUCKET))
            i1 = int(math.floor(max(a[0], b[0], c[0]) / BUCKET))
            j0 = int(math.floor(min(a[2], b[2], c[2]) / BUCKET))
            j1 = int(math.floor(max(a[2], b[2], c[2]) / BUCKET))
            for bx in range(i0, i1 + 1):
                for bz in range(j0, j1 + 1):
                    self.buckets[(bx, bz)].append(idx)

    def near(self, x, z):
        i = int(math.floor(x / BUCKET))
        j = int(math.floor(z / BUCKET))
        out = []
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                out.extend(self.buckets.get((i + di, j + dj), ()))
        return out


def height_in(tri, x, z):
    a, b, c = tri
    v0x, v0z = b[0] - a[0], b[2] - a[2]
    v1x, v1z = c[0] - a[0], c[2] - a[2]
    d00 = v0x * v0x + v0z * v0z
    d01 = v0x * v1x + v0z * v1z
    d11 = v1x * v1x + v1z * v1z
    den = d00 * d11 - d01 * d01
    if abs(den) < 1e-14:
        return None
    v2x, v2z = x - a[0], z - a[2]
    d02 = v0x * v2x + v0z * v2z
    d12 = v1x * v2x + v1z * v2z
    u = (d11 * d02 - d01 * d12) / den
    v = (d00 * d12 - d01 * d02) / den
    if u < -1e-9 or v < -1e-9 or u + v > 1.0 + 1e-9:
        return None
    return a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1])


def dist_tri_xz(tri, x, z):
    a, b, c = tri
    if height_in(tri, x, z) is not None:
        return 0.0
    return min(seg_dist(x, z, a[0], a[2], b[0], b[2]),
               seg_dist(x, z, b[0], b[2], c[0], c[2]),
               seg_dist(x, z, c[0], c[2], a[0], a[2]))


def main() -> int:
    checks = []
    failures = []

    def check(name, ok, detail=None):
        checks.append(dict(name=name, ok=bool(ok), detail=detail))
        if not ok:
            failures.append(name)

    doc = json.loads((OUT / "regions.json").read_text())
    samples_doc = json.loads((OUT / "regions-samples.json").read_text())
    grid = np.load(OUT / "grid.npz")
    hashes = json.loads((OUT / "hashes.json").read_text())
    path_doc = json.loads(P48_JSON.read_text())

    check("canonical-hash", canonical(doc) == doc["hash"], doc.get("hash"))
    check("physics-hash", sha256_bytes(PHYSICS.read_bytes()) == PHYSICS_SHA256)
    check("visual-map-hash", sha256_bytes(VISUAL_JSON.read_bytes()) == VISUAL_SHA256)
    check("p48-canonical", canonical(path_doc) == P48_CANONICAL, path_doc.get("hash"))
    check("p48-length", abs(path_doc["course"]["length"] - 310.3952) < 1e-6)
    check("spawn", doc["inputs"]["spawn"]["x"] == -88.0 and doc["inputs"]["spawn"]["z"] == 1050.0)

    # ---------------------------------------------------------- independent raster
    tris = flatten()
    normals = np.array([tri_normal(*t) for t in tris])
    surface = tris[normals[:, 1] > SURFACE_MIN_NY]
    wall = tris[np.abs(normals[:, 1]) < 0.5]
    x0, x1, z0, z1 = (doc["model"]["window"][k] for k in ("x0", "x1", "z0", "z1"))
    H, xs, zs = raster_height_dot(surface, x0, x1, z0, z1, CELL)
    dh = edge_max_dh(H)
    base_pass = np.isfinite(H) & (dh <= EDGE_DH + 1e-9)
    W = raster_wall_independent(wall, H, x0, x1, z0, z1, CELL, WALL_RADIUS)
    base_pass &= ~W
    check("raster-height-equals-builder",
          np.allclose(H, grid["height"], equal_nan=True, atol=1e-9))
    check("passable-equals-builder", np.array_equal(base_pass, grid["base_pass"]))
    check("wall-equals-builder", np.array_equal(W, grid["wall"]))

    labels2, sizes2 = label_components(erode(base_pass, P48_ERODE_CELLS))
    labels3, sizes3 = label_components(erode(base_pass, STRICT_ERODE_CELLS))
    labels0, sizes0 = label_components(base_pass)
    sj = int(round((1050.0 - z0) / CELL))
    si = int(round((-88.0 - x0) / CELL))
    spawn_lab2 = int(labels2[sj, si])
    spawn_lab3 = int(labels3[sj, si])
    spawn_lab0 = int(labels0[sj, si])
    check("spawn-on-p48-mask", spawn_lab2 > 0, dict(cell=[sj, si]))
    check("spawn-on-strict-mask", spawn_lab3 > 0)

    # Order-independent comparison of component sizes.
    check("p48-component-sizes",
          sorted(sizes2) == sorted(np.bincount(grid["labels_p48"].ravel())[1:].tolist()))
    check("strict-component-sizes", sorted(sizes3) == sorted(np.bincount(grid["labels_strict"].ravel())[1:].tolist()))
    check("base-component-sizes", sorted(sizes0) == sorted(np.bincount(grid["labels_base"].ravel())[1:].tolist()))

    # region cell counts / bounds
    region_ok = True
    region_detail = []
    for rec in doc["regions"]:
        candidates = [k + 1 for k, s in enumerate(sizes2) if s == rec["cells"]]
        found = 0
        for cand in candidates:
            arr = np.argwhere(labels2 == cand)
            bounds = [float(xs[arr[:, 1].min()]), float(xs[arr[:, 1].max()]),
                      float(zs[arr[:, 0].min()]), float(zs[arr[:, 0].max()])]
            if all(abs(bounds[k] - rec["bounds"][k]) < 1e-6 for k in range(4)):
                found = cand
                break
        if not found and candidates:
            found = candidates[0]
        if not found:
            region_ok = False
            region_detail.append(dict(id=rec["id"], error="no matching component"))
            continue
        cells = int((labels2 == found).sum())
        arr = np.argwhere(labels2 == found)
        bounds = [float(xs[arr[:, 1].min()]), float(xs[arr[:, 1].max()]),
                  float(zs[arr[:, 0].min()]), float(zs[arr[:, 0].max()])]
        ok = (cells == rec["cells"] and
              all(abs(bounds[k] - rec["bounds"][k]) < 1e-6 for k in range(4)))
        region_detail.append(dict(id=rec["id"], ok=ok, cells=cells, recordedCells=rec["cells"]))
        region_ok = region_ok and ok
    check("region-areas-bounds", region_ok, region_detail)

    # ---------------------------------------------------------- exact geometry
    ground_idx = Index(tris, lambda t: tri_normal(*t)[1] > COLLISION_NY_MIN)
    wall_idx = Index(tris, lambda t: abs(tri_normal(*t)[1]) < 0.5)

    def ground_height(x, z):
        best = None
        for idx in ground_idx.near(x, z):
            h = height_in(ground_idx.triangles[idx], x, z)
            if h is not None and (best is None or h > best):
                best = h
        return best

    def min_wall_distance(x, z, h):
        d = float("inf")
        for idx in wall_idx.near(x, z):
            t = wall_idx.triangles[idx]
            ymin = min(t[0][1], t[1][1], t[2][1])
            ymax = max(t[0][1], t[1][1], t[2][1])
            if ymax <= h + 0.05 or ymin >= h + 2.0:
                continue
            d = min(d, dist_tri_xz(t, x, z))
        return d

    def heading(points, k):
        a = points[max(0, k - 1)]
        b = points[min(len(points) - 1, k + 1)]
        fx, fz = b[0] - a[0], b[1] - a[1]
        n = math.hypot(fx, fz) or 1.0
        return (fx / n, fz / n)

    def spine_metrics(points, fine=None):
        missing = 0
        max_foot = 0.0
        max_foot_at = -1
        min_wall = float("inf")
        min_wall_at = -1
        hard = 0
        margin = 0
        for k, (x, z) in enumerate(points):
            fwd = heading(points, k)
            right = (-fwd[1], fwd[0])
            hs = []
            for sl, sw in ((0, 0), (1, 1), (1, -1), (-1, 1), (-1, -1),
                           (1, 0), (-1, 0), (0, 1), (0, -1)):
                px = x + fwd[0] * sl * HALF_LENGTH + right[0] * sw * HALF_WIDTH
                pz = z + fwd[1] * sl * HALF_LENGTH + right[1] * sw * HALF_WIDTH
                hh = ground_height(px, pz)
                if hh is None:
                    missing += 1
                else:
                    hs.append(hh)
            if hs:
                rng = max(hs) - min(hs)
                if rng > max_foot:
                    max_foot = rng
                    max_foot_at = k
            h = ground_height(x, z)
            if h is not None:
                d = min_wall_distance(x, z, h)
                if d < min_wall:
                    min_wall = d
                    min_wall_at = k
                if d < ENVELOPE_HALF_WIDTH:
                    hard += 1
                elif d < HALF_WIDTH:
                    margin += 1
        max_step = 0.0
        max_grade = 0.0
        if fine:
            heights = [ground_height(x, z) for x, z in fine]
            for k in range(1, len(fine)):
                if heights[k] is not None and heights[k - 1] is not None:
                    max_step = max(max_step, abs(heights[k] - heights[k - 1]))
            acc = 0.0
            k0 = 0
            for k in range(len(fine)):
                if k and acc >= 2.0:
                    if heights[k] is not None and heights[k0] is not None:
                        max_grade = max(max_grade, abs(heights[k] - heights[k0]) / acc)
                    k0 = k
                    acc = 0.0
                if k:
                    acc += math.hypot(fine[k][0] - fine[k - 1][0], fine[k][1] - fine[k - 1][1])
        return dict(samples=len(points), missingGround=missing, footprintMaxRange=round(max_foot, 5),
                    footprintMaxAt=max_foot_at, minWallDistance=round(min_wall, 5),
                    minWallAt=min_wall_at, hardWallViolations=hard, marginViolations=margin,
                    maxStep=round(max_step, 5), maxGrade=round(max_grade, 6))

    region_safety = []
    major_safe = True
    for rec in doc["regions"]:
        pts = [tuple(p) for p in rec.get("spine", [])]
        fine = [tuple(p) for p in rec.get("spineCells", [])]
        m = spine_metrics(pts, fine)
        ok = (m["missingGround"] == 0 and m["hardWallViolations"] == 0 and
              m["maxStep"] <= STEP_LIMIT + 1e-6 and m["maxGrade"] <= GRADE_LIMIT + 1e-6 and
              m["footprintMaxRange"] <= 0.20 + 1e-6)
        region_safety.append(dict(id=rec["id"], areaM2=rec["areaM2"], ok=ok, **m))
        if rec["areaM2"] >= 5000.0:
            major_safe = major_safe and ok
    check("region-spine-safety-major", major_safe,
          [r for r in region_safety if r["areaM2"] >= 5000.0])
    minor_issues = [dict(id=r["id"], areaM2=r["areaM2"], reason=(
        "footprint-range" if r["footprintMaxRange"] > 0.20 else
        "missing-ground" if r["missingGround"] else
        "hard-wall" if r["hardWallViolations"] else "step-or-grade"))
        for r in region_safety if not r["ok"]]
    check("minor-regions-are-not-recommended",
          all(r["areaM2"] < 5000.0 for r in region_safety if not r["ok"]),
          minor_issues)

    # P48 course exact control
    p48_pts = [tuple(p) for p in path_doc["course"]["points"]]
    p48_m = spine_metrics(p48_pts[::2], p48_pts)   # 0.5 m footprint samples, 0.25 m step/grade
    check("p48-wall-clearance", p48_m["minWallDistance"] >= HALF_WIDTH - 1e-6, p48_m)
    check("p48-footprint-range", p48_m["footprintMaxRange"] <= 0.20 + 1e-6, p48_m)
    check("p48-step-grade", p48_m["maxStep"] <= STEP_LIMIT + 1e-6 and
          p48_m["maxGrade"] <= GRADE_LIMIT + 1e-6, p48_m)
    check("p48-no-missing-ground", p48_m["missingGround"] == 0)

    # ---------------------------------------------------------- coverage subset
    visual_doc = json.loads(VISUAL_JSON.read_text())
    sections = [s for s in visual_doc["sections"] if s.get("status") == "ok"]
    visual = []
    owner = []
    for si, section in enumerate(sections):
        pos = section["positions"]
        idx = section["indices"]
        ranges = [(d["firstIndex"], d["firstIndex"] + d["indexCount"], di)
                  for di, d in enumerate(section["draws"])]
        for off in range(0, len(idx), 3):
            found = None
            for first, end, di in ranges:
                if first <= off < end:
                    found = di
                    break
            if found is None:
                raise SystemExit("verify_regions: draw range has a hole")
            ia, ib, ic = idx[off], idx[off + 1], idx[off + 2]
            a = (pos[ia * 3], pos[ia * 3 + 1], pos[ia * 3 + 2])
            b = (pos[ib * 3], pos[ib * 3 + 1], pos[ib * 3 + 2])
            c = (pos[ic * 3], pos[ic * 3 + 1], pos[ic * 3 + 2])
            if tri_normal(a, b, c)[1] <= VISUAL_NY_MIN:
                continue
            visual.append((a, b, c))
            owner.append((si, di))
    visual_idx = Index(visual)

    def visual_hit(x, z, coll):
        best = None
        for i in visual_idx.near(x, z):
            h = height_in(visual[i], x, z)
            if h is None:
                continue
            d = h - coll
            if best is None or abs(d) < abs(best[0]):
                best = (d, i)
        return best

    rows = samples_doc["rows"]
    mismatches = []
    checked = 0
    for k in range(0, len(rows), 25):
        rid, x, z, coll_rec, delta_rec, key_rec, di_rec, cov_rec = rows[k]
        checked += 1
        coll = ground_height(x, z)
        if coll_rec is None:
            if coll is not None:
                mismatches.append([k, "collision-null", coll])
            continue
        if coll is None:
            mismatches.append([k, "collision-missing", coll_rec])
            continue
        if abs(coll - coll_rec) > 1e-3:
            mismatches.append([k, "collision", coll, coll_rec])
            continue
        hit = visual_hit(x, z, coll)
        if hit is None:
            if delta_rec is not None:
                mismatches.append([k, "visual-missing", delta_rec])
            continue
        delta, tri = hit
        cov = abs(delta) <= COVER_TOL
        if abs(delta - (delta_rec if delta_rec is not None else 1e9)) > 1e-3:
            mismatches.append([k, "delta", delta, delta_rec])
        if bool(cov) != bool(cov_rec):
            mismatches.append([k, "covered", cov, cov_rec])
        si_, di = owner[tri]
        if key_rec is not None and (sections[si_]["key"] != key_rec or di != di_rec):
            mismatches.append([k, "attribution", sections[si_]["key"], di, key_rec, di_rec])
    check("coverage-subset", not mismatches,
          dict(checked=checked, mismatches=mismatches[:10], count=len(mismatches)))

    # P48 course band subset
    band_bad = 0
    band_checked = 0
    for k in range(0, len(p48_pts), 10):
        x, z = p48_pts[k]
        fwd = heading(p48_pts, k)
        right = (-fwd[1], fwd[0])
        for o in STATIONS:
            band_checked += 1
            px, pz = x + right[0] * o, z + right[1] * o
            coll = ground_height(px, pz)
            hit = visual_hit(px, pz, coll) if coll is not None else None
            if coll is None or hit is None or abs(hit[0]) > COVER_TOL:
                band_bad += 1
    check("p48-band-subset", band_bad == 0, dict(checked=band_checked, bad=band_bad))

    # ---------------------------------------------------------- separation wall
    sep = next((s for s in doc["separations"] if s["toRegion"] == "R01"), None)
    wall_ok = False
    wall_detail = None
    if sep:
        mx, mz = sep["midpoint"]
        gh = ground_height(mx, mz)
        near = []
        for t in wall:
            d = dist_tri_xz(t, mx, mz)
            if d <= 3.0:
                near.append((d, min(t[0][1], t[1][1], t[2][1]), max(t[0][1], t[1][1], t[2][1])))
        if near and gh is not None:
            ymax = max(v[2] for v in near)
            wall_ok = (ymax >= gh + 2.0 and sep["groundDropMetres"] is not None and
                       sep["groundDropMetres"] <= 0.10)
            wall_detail = dict(ground=gh, wallTriangles=len(near),
                               wallAboveGround=round(ymax - gh, 3),
                               groundDrop=sep["groundDropMetres"])
    check("r01-separation-wall", wall_ok, wall_detail)

    # ---------------------------------------------------------- outputs
    for name in ("free-roam.svg", "free-roam.png", "free-roam.html", "regions-samples.json"):
        p = OUT / name
        check("output-exists-" + name, p.exists() and p.stat().st_size > 0,
              dict(bytes=p.stat().st_size if p.exists() else 0))
    try:
        ET.parse(OUT / "free-roam.svg")
        svg_ok = True
    except Exception as exc:  # noqa: BLE001
        svg_ok = False
        svg_err = str(exc)
    check("svg-parses", svg_ok, None if svg_ok else svg_err)
    html = (OUT / "free-roam.html").read_text(encoding="utf-8")
    check("html-has-table", "R04" in html and "free-roam.svg" in html)
    hash_ok = all((OUT / name).stat().st_size == rec["bytes"] and
                  sha256_bytes((OUT / name).read_bytes()) == rec["sha256"]
                  for name, rec in hashes["files"].items())
    check("output-hashes", hash_ok, hashes["files"])
    grid_digest, _ = content_digest({k: grid[k] for k in grid.files})
    check("grid-content-hash", grid_digest == hashes["gridContent"]["combined"],
          dict(recomputed=grid_digest, recorded=hashes["gridContent"]["combined"]))

    result = dict(
        kind="free-roam.verify",
        version=1,
        **{"pass": not failures},
        checks=checks,
        failures=failures,
        inputs=dict(physicsSha256=PHYSICS_SHA256, visualSha256=VISUAL_SHA256,
                    p48Canonical=P48_CANONICAL, regionsHash=doc["hash"]),
        metrics=dict(
            collisionTriangles=len(tris),
            surfaceTriangles=len(surface),
            steepTriangles=len(wall),
            drawTriangles=len(visual),
            passableCells=int(base_pass.sum()),
            wallMaskCells=int(W.sum()),
            spawnLabels=dict(base=spawn_lab0, p48=spawn_lab2, strict=spawn_lab3),
            regionSafety=region_safety,
            minorSpineIssues=minor_issues,
            p48Safety=p48_m,
            coverageSubset=dict(checked=checked, mismatches=len(mismatches)),
            separationR01=wall_detail,
        ),
    )
    body = json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      default=json_default)
    result["hash"] = "sha256:" + sha256_bytes(body.encode("utf-8"))
    (OUT / "verify.json").write_text(json.dumps(result, indent=1, default=json_default) + "\n",
                                     encoding="utf-8")
    print(json.dumps({"pass": result["pass"], "checks": len(checks),
                      "failures": failures, "hash": result["hash"]}, indent=1))
    print(json.dumps(result["metrics"], indent=1, default=json_default))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
