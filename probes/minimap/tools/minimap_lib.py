"""Shared, deterministic primitives for the Blur Web minimap probe.

The library derives minimap geometry from measured data only:

* the committed collision triangle meshes (`Level.levelphysics`), parsed by the
  committed map-pipeline scanner (read-only import), and
* the committed measured centre lines (e1-drive sprint/lap layouts and the
  map-pipeline candidate layouts).

No value is hand-drawn.  Where a value is a grid measurement, the resolution is
recorded next to it.

Axes: world is Y-up, X east, Z south-ish (engine convention).  The minimap is
world-aligned: screen +x = world +X, screen +y = world +Z.  No compass claim is
made because the retail map orientation is unknown; consumers may apply
`projection.rotationRad`.
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
import zlib
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[3]
MAP_PIPELINE_TOOLS = REPO / "probes" / "map-pipeline" / "tools"
if str(MAP_PIPELINE_TOOLS) not in sys.path:
    sys.path.insert(0, str(MAP_PIPELINE_TOOLS))

import physics_scan  # noqa: E402  (committed scanner, read-only import)

SCHEMA = "blur.minimap.geometry/1"
MARKER_SCHEMA = "blur.minimap.markers/1"
ROUND = 6
SURFACE_MIN_NORMAL_Y = 0.94          # P48/P61 drivable-surface rule (<= 20 deg)
GRID_CELL_M = 0.5                    # measurement raster resolution
RASTER_LAYERS = 3                    # stacked surfaces per cell (road + bridge)
LAYER_GAP_M = 0.30                   # two heights within this are one layer
WIDTH_TOL_M = 0.45                   # cross-slope tolerance from the centre line
WIDTH_SAMPLE_STEP_M = 0.25
WIDTH_CAP_HALF_M = 12.0              # display cap (same 12 m cap as P51)
WIDTH_SCAN_CAP_HALF_M = 30.0         # measurement cap before display clamping


# ---------------------------------------------------------------------------
# deterministic JSON / hashing
# ---------------------------------------------------------------------------

def q(x: float) -> float:
    """Round a derived float to the canonical 1e-6 grid (avoids -0.0)."""
    v = round(float(x), ROUND)
    return 0.0 if v == 0.0 else v


def qpts(points):
    return [[q(p[0]), q(p[1])] for p in points]


def canonical_bytes(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True).encode("utf-8")


def canonical_hash(obj) -> str:
    return "sha256:" + hashlib.sha256(canonical_bytes(obj)).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


# ---------------------------------------------------------------------------
# collision surface
# ---------------------------------------------------------------------------

def load_surface_triangles(level: str):
    """Return (up-facing triangles (N,3,3), classification counts, source hash)."""
    path = REPO / "game-data" / "Blur" / "levels" / level / "Level.levelphysics"
    raw = path.read_bytes()
    level_doc = physics_scan.scan_level(raw)
    soup = physics_scan.flatten_static_triangles(level_doc)
    arr = np.asarray(soup, dtype=np.float64)
    if arr.ndim != 3 or arr.shape[1:] != (3, 3):
        raise SystemExit("unexpected triangle soup shape: %r" % (arr.shape,))
    n = np.cross(arr[:, 1] - arr[:, 0], arr[:, 2] - arr[:, 0])
    ln = np.linalg.norm(n, axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        ny = np.where(ln > 0.0, n[:, 1] / ln, 0.0)
    surface = (ln > 0.0) & (ny > SURFACE_MIN_NORMAL_Y)
    steep = (ln > 0.0) & (np.abs(ny) < 0.5)
    other = (ln > 0.0) & ~surface & ~steep
    degenerate = ln == 0.0
    counts = {
        "triangles": int(arr.shape[0]),
        "surface": int(surface.sum()),
        "steep": int(steep.sum()),
        "other": int(other.sum()),
        "degenerate": int(degenerate.sum()),
        "surfaceMinNormalY": SURFACE_MIN_NORMAL_Y,
    }
    return arr[surface], counts, sha256_bytes(raw)


# ---------------------------------------------------------------------------
# height raster (stacked surfaces)
# ---------------------------------------------------------------------------

class HeightRaster:
    """Max-height stack raster used to measure the drivable band.

    `layers` high surfaces are kept per cell so a road under a bridge does not
    disappear.  Sampling picks the layer nearest a reference height.
    """

    def __init__(self, min_x, min_z, max_x, max_z, cell=GRID_CELL_M,
                 layers=RASTER_LAYERS):
        if cell <= 0:
            raise ValueError("cell must be positive")
        self.cell = float(cell)
        self.x0 = float(min_x)
        self.z0 = float(min_z)
        self.w = int(math.floor((max_x - min_x) / cell)) + 1
        self.h = int(math.floor((max_z - min_z) / cell)) + 1
        self.layers = int(layers)
        self.heights = np.full((self.layers, self.h, self.w), np.nan,
                               dtype=np.float32)

    # -- rasterisation ------------------------------------------------------
    def _candidates(self, tris):
        """Flat (cell index, height) pairs for every covered cell centre."""
        cell = self.cell
        idx_parts = []
        val_parts = []
        for tri in tris:
            (x0, y0, z0), (x1, y1, z1), (x2, y2, z2) = tri
            tx0 = min(x0, x1, x2); tx1 = max(x0, x1, x2)
            tz0 = min(z0, z1, z2); tz1 = max(z0, z1, z2)
            ix0 = int(math.ceil((tx0 - self.x0) / cell - 0.5))
            ix1 = int(math.floor((tx1 - self.x0) / cell + 0.5))
            iz0 = int(math.ceil((tz0 - self.z0) / cell - 0.5))
            iz1 = int(math.floor((tz1 - self.z0) / cell + 0.5))
            ix0 = max(ix0, 0); ix1 = min(ix1, self.w - 1)
            iz0 = max(iz0, 0); iz1 = min(iz1, self.h - 1)
            if ix1 < ix0 or iz1 < iz0:
                continue
            gx = self.x0 + np.arange(ix0, ix1 + 1) * cell
            gz = self.z0 + np.arange(iz0, iz1 + 1) * cell
            px, pz = np.meshgrid(gx, gz)
            d = (x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0)
            if abs(d) < 1e-12:
                continue
            w0 = ((x1 - px) * (z2 - pz) - (x2 - px) * (z1 - pz)) / d
            w1 = ((x2 - px) * (z0 - pz) - (x0 - px) * (z2 - pz)) / d
            w2 = 1.0 - w0 - w1
            eps = -1e-9
            inside = (w0 >= eps) & (w1 >= eps) & (w2 >= eps)
            if not inside.any():
                continue
            hh = w0 * y0 + w1 * y1 + w2 * y2
            iz, ix = np.nonzero(inside)
            flat = (iz + iz0) * self.w + (ix + ix0)
            idx_parts.append(flat.astype(np.int64))
            val_parts.append(hh[inside].astype(np.float64))
        if not idx_parts:
            return (np.zeros(0, np.int64), np.zeros(0, np.float64))
        return np.concatenate(idx_parts), np.concatenate(val_parts)

    def build(self, tris):
        idx, val = self._candidates(tris)
        if idx.size == 0:
            return self
        # numpy 2.3 `ufunc.at` does not reliably write through a reshaped view,
        # so update flat work buffers and copy them back into the raster.
        # `maximum` propagates NaN, so the work buffers start at -inf.
        flat = self.heights.reshape(self.layers, -1)
        h0 = np.full(flat.shape[1], -np.inf, dtype=np.float32)
        np.maximum.at(h0, idx, val)
        flat[0][:] = np.where(np.isfinite(h0), h0, np.nan)
        if self.layers > 1:
            h1 = np.full(flat.shape[1], -np.inf, dtype=np.float32)
            m1 = val < h0[idx] - LAYER_GAP_M
            np.maximum.at(h1, idx[m1], val[m1])
            flat[1][:] = np.where(np.isfinite(h1), h1, np.nan)
            if self.layers > 2:
                h2 = np.full(flat.shape[1], -np.inf, dtype=np.float32)
                m2 = val < h1[idx] - LAYER_GAP_M
                np.maximum.at(h2, idx[m2], val[m2])
                flat[2][:] = np.where(np.isfinite(h2), h2, np.nan)
        return self

    # -- sampling -----------------------------------------------------------
    def cell_of(self, x, z):
        ix = np.rint((np.asarray(x, dtype=np.float64) - self.x0) / self.cell)
        iz = np.rint((np.asarray(z, dtype=np.float64) - self.z0) / self.cell)
        return ix.astype(np.int64), iz.astype(np.int64)

    def sample(self, x, z, ref):
        """Return (height, |height-ref|) of the layer nearest `ref`; NaN if none."""
        ix, iz = self.cell_of(x, z)
        ok = (ix >= 0) & (ix < self.w) & (iz >= 0) & (iz < self.h)
        out_h = np.full(np.shape(ix), np.nan, dtype=np.float64)
        out_d = np.full(np.shape(ix), np.inf, dtype=np.float64)
        if not np.any(ok):
            return out_h, out_d
        hs = self.heights[:, iz[ok], ix[ok]].astype(np.float64)  # (L, n)
        rr = np.asarray(ref, dtype=np.float64)
        if rr.shape == ():
            rr = np.full(hs.shape[1], float(rr))
        else:
            rr = rr[ok]
        d = np.abs(hs - rr)
        d = np.where(np.isfinite(hs), d, np.inf)
        k = np.argmin(d, axis=0)
        cols = np.arange(hs.shape[1])
        out_h[ok] = hs[k, cols]
        out_d[ok] = d[k, cols]
        return out_h, out_d


# ---------------------------------------------------------------------------
# drivable band measurement
# ---------------------------------------------------------------------------

def _unit(v):
    n = math.hypot(v[0], v[1])
    if n <= 0.0:
        return (0.0, 0.0)
    return (v[0] / n, v[1] / n)


def tangent_at(points, i, closed=False):
    """Central-difference tangent of a 2D polyline (x, z).

    For a closed ring (last point repeats the first) the neighbours wrap, so
    the seam vertex gets the same tangent from either side.
    """
    n = len(points)
    if closed and n > 2:
        m = n - 1 if (points[0][0] == points[-1][0] and points[0][1] == points[-1][1]) else n
        iu = i % m
        a, b = points[(iu - 1) % m], points[(iu + 1) % m]
        return _unit((b[0] - a[0], b[1] - a[1]))
    if i <= 0:
        a, b = points[0], points[min(1, n - 1)]
    elif i >= n - 1:
        a, b = points[max(0, n - 2)], points[n - 1]
    else:
        a, b = points[i - 1], points[i + 1]
    return _unit((b[0] - a[0], b[1] - a[1]))


def measure_band(raster, points, grounds, step=WIDTH_SAMPLE_STEP_M,
                 tol=WIDTH_TOL_M, cap=WIDTH_SCAN_CAP_HALF_M, closed=False):
    """Per-station drivable half-width, measured perpendicular to the line.

    A sample is drivable when a stacked surface exists within `tol` of the
    station ground.  The run stops at the first failing sample.  Resolution is
    `step`; the run length is a lower bound on the true band (documented).
    """
    pts = [(float(p[0]), float(p[1])) for p in points]
    n = len(pts)
    offs = np.arange(step, cap + step * 0.5, step)
    half = np.zeros(n, dtype=np.float64)
    full = np.zeros(n, dtype=np.float64)
    left = np.zeros(n, dtype=np.float64)
    right = np.zeros(n, dtype=np.float64)
    centre_missing = 0
    for i in range(n):
        x, z = pts[i]
        h0 = float(grounds[i])
        tx, tz = tangent_at(pts, i, closed=closed)
        nx, nz = -tz, tx
        if not math.isfinite(h0):
            continue
        _, d0 = raster.sample(np.array([x]), np.array([z]), np.array([h0]))
        if not np.isfinite(d0[0]) or d0[0] > tol:
            centre_missing += 1
            continue
        for sign, out in ((1.0, right), (-1.0, left)):
            xs = x + nx * offs * sign
            zs = z + nz * offs * sign
            hh, dd = raster.sample(xs, zs, np.full(offs.shape, h0))
            good = np.isfinite(hh) & (dd <= tol)
            bad = np.nonzero(~good)[0]
            run = float(offs[bad[0] - 1]) if bad.size and bad[0] > 0 else 0.0
            if bad.size == 0:
                run = float(offs[-1])
            out[i] = run
        full[i] = left[i] + right[i]
        half[i] = full[i] * 0.5
    return {
        "halfFullM": half,
        "fullM": full,
        "leftM": left,
        "rightM": right,
        "centreMissingStations": int(centre_missing),
    }


# ---------------------------------------------------------------------------
# polyline simplification
# ---------------------------------------------------------------------------

def _dist_point_seg(p, a, b):
    ax, az = a; bx, bz = b; px, pz = p
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    if L2 <= 0.0:
        return math.hypot(px - ax, pz - az)
    t = ((px - ax) * dx + (pz - az) * dz) / L2
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


def _dp(seq, tol, keep):
    """Douglas-Peucker over index list `seq` (recursive, deterministic)."""
    stack = [(0, len(seq) - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        a = seq[i0]; b = seq[i1]
        best = -1.0; best_k = -1
        for k in range(i0 + 1, i1):
            d = _dist_point_seg(seq[k], a, b)
            if d > best:
                best = d; best_k = k
        if best > tol:
            keep.add(best_k)
            stack.append((i0, best_k))
            stack.append((best_k, i1))


def simplify(points, tol, closed=False):
    """Douglas-Peucker.  Returns (kept points, indices into `points`)."""
    pts = [(float(p[0]), float(p[1])) for p in points]
    if len(pts) <= 2:
        return pts, list(range(len(pts)))
    if closed:
        # Anchor on the point farthest from the ring centroid, then DP the
        # open chain that starts and ends at the anchor.
        cx = sum(p[0] for p in pts) / len(pts)
        cz = sum(p[1] for p in pts) / len(pts)
        anchor = max(range(len(pts)),
                     key=lambda i: (math.hypot(pts[i][0] - cx, pts[i][1] - cz), -i))
        order = list(range(anchor, len(pts))) + list(range(0, anchor + 1))
        keep = {0, len(order) - 1}
        _dp([pts[i] for i in order], tol, keep)
        idx = [order[k] for k in sorted(keep)]
        return [pts[i] for i in idx], idx
    keep = {0, len(pts) - 1}
    _dp(pts, tol, keep)
    idx = sorted(keep)
    return [pts[i] for i in idx], idx


def _dp_hierarchy(seq):
    """Douglas-Peucker split hierarchy: index -> significance (max deviation)."""
    sig = {0: float("inf"), len(seq) - 1: float("inf")}
    stack = [(0, len(seq) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a = seq[i]; b = seq[j]
        best = -1.0; best_k = -1
        for k in range(i + 1, j):
            d = _dist_point_seg(seq[k], a, b)
            if d > best:
                best = d; best_k = k
        if best_k >= 0:
            prev = sig.get(best_k, -1.0)
            if best > prev:
                sig[best_k] = best
            stack.append((i, best_k))
            stack.append((best_k, j))
    return sig


def simplify_budget(points, budget, closed=False):
    """Keep the `budget` most significant DP vertices (exact vertex budget).

    Returns (kept points, indices into `points`, max significance dropped).
    """
    pts = [(float(p[0]), float(p[1])) for p in points]
    n = len(pts)
    if budget < 2:
        raise ValueError("budget must be >= 2")
    if n <= budget:
        idx = list(range(n))
        return [pts[i] for i in idx], idx, 0.0
    if closed:
        cx = sum(p[0] for p in pts) / n
        cz = sum(p[1] for p in pts) / n
        anchor = max(range(n), key=lambda i: (math.hypot(pts[i][0] - cx, pts[i][1] - cz), -i))
        order = list(range(anchor, n)) + list(range(0, anchor + 1))
        seq = [pts[i] for i in order]
        sig = _dp_hierarchy(seq)
        interior = [(sig.get(k, -1.0), k) for k in range(1, len(seq) - 1)]
        interior.sort(key=lambda t: (-t[0], t[1]))
        keep_order = {0, len(seq) - 1}
        for _, k in interior[:max(0, budget - 1)]:
            keep_order.add(k)
        keep_order = sorted(keep_order)
        idx = [order[k] for k in keep_order]
        dropped = max((s for s, k in interior[budget - 1:]), default=0.0)
        return [pts[i] for i in idx], idx, max(0.0, dropped)
    sig = _dp_hierarchy(pts)
    interior = [(sig.get(k, -1.0), k) for k in range(1, n - 1)]
    interior.sort(key=lambda t: (-t[0], t[1]))
    keep = {0, n - 1}
    for _, k in interior[:max(0, budget - 2)]:
        keep.add(k)
    idx = sorted(keep)
    dropped = max((s for s, k in interior[budget - 2:]), default=0.0)
    return [pts[i] for i in idx], idx, max(0.0, dropped)


def fit_budget(points, budget, closed=False, tol_hi=25.0):
    """Compatibility wrapper: significance-budget simplification.

    The returned tolerance is the largest significance that was dropped, i.e.
    an upper bound on the vertex-removal error before the final Hausdorff check.
    """
    pts, idx, dropped = simplify_budget(points, budget, closed)
    return pts, idx, dropped


def deviation(original, simplified, closed=False):
    """Max/mean distance from every original sample to the simplified line."""
    segs = list(zip(simplified, simplified[1:]))
    if closed and len(simplified) > 2:
        segs.append((simplified[-1], simplified[0]))
    if not segs:
        return 0.0, 0.0
    mx = 0.0; total = 0.0; count = 0
    for p in original:
        dmin = min(_dist_point_seg((p[0], p[1]), a, b) for a, b in segs)
        mx = max(mx, dmin); total += dmin; count += 1
    return mx, total / max(count, 1)


def polyline_length(points, closed=False):
    total = 0.0
    for a, b in zip(points, points[1:]):
        total += math.hypot(b[0] - a[0], b[1] - a[1])
    if closed and len(points) > 2:
        a, b = points[-1], points[0]
        total += math.hypot(b[0] - a[0], b[1] - a[1])
    return total


def arc_lengths(points):
    out = [0.0]
    for a, b in zip(points, points[1:]):
        out.append(out[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    return out


def resample(points, grounds, step):
    """Resample a measured 0.25 m polyline at `step` (arc-length interpolation).

    Returns (points, grounds, arc indices into the original sample list).
    """
    arc = arc_lengths(points)
    total = arc[-1]
    n = int(math.floor(total / step)) + 1
    out_p = []; out_h = []; out_i = []
    j = 0
    for k in range(n):
        s = min(k * step, total)
        while j + 1 < len(arc) - 1 and arc[j + 1] < s:
            j += 1
        span = arc[j + 1] - arc[j] if j + 1 < len(arc) else 0.0
        t = 0.0 if span <= 0 else (s - arc[j]) / span
        a = points[j]; b = points[min(j + 1, len(points) - 1)]
        out_p.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        ha = grounds[j]; hb = grounds[min(j + 1, len(grounds) - 1)]
        out_h.append(ha + (hb - ha) * t if (ha is not None and hb is not None) else None)
        out_i.append(j)
    return out_p, out_h, out_i


# ---------------------------------------------------------------------------
# ribbon outline from centre line + measured half width
# ---------------------------------------------------------------------------

def ribbon_outline(points, half_widths, closed=False):
    """Closed polygon(s) from the centre line and per-vertex half width.

    The offset is clamped at sharp corners so the ribbon does not fold over
    itself: at a vertex whose turn angle is `phi`, the offset cannot exceed
    `0.45 * min(prevLen, nextLen) / tan(phi/2)` (a stroke-join limit).  The
    clamp is display-only; measured widths stay in `path.width`.

    For an open line: left chain + reversed right chain (a closed polygon).
    For a closed line: outer ring + inner ring (outer, hole).
    """
    pts = [(float(p[0]), float(p[1])) for p in points]
    n = len(pts)
    ring = closed and n > 2
    m = (n - 1 if (pts[0][0] == pts[-1][0] and pts[0][1] == pts[-1][1]) else n) if ring else n

    def nb(i):
        iu = i % m
        return pts[(iu - 1) % m], pts[(iu + 1) % m]

    left = []; right = []
    clamped = 0
    for i in range(n):
        tx, tz = tangent_at(pts, i, closed=ring)
        nx, nz = -tz, tx
        hw = float(half_widths[i])
        if ring:
            p_prev, p_next = nb(i)
            a0 = math.atan2(pts[i % m][1] - p_prev[1], pts[i % m][0] - p_prev[0])
            a1 = math.atan2(p_next[1] - pts[i % m][1], p_next[0] - pts[i % m][0])
            L0 = math.hypot(pts[i % m][0] - p_prev[0], pts[i % m][1] - p_prev[1])
            L1 = math.hypot(p_next[0] - pts[i % m][0], p_next[1] - pts[i % m][1])
            d = abs((a1 - a0 + math.pi) % (2 * math.pi) - math.pi)
            if L0 > 0 and L1 > 0 and d > 1e-6:
                limit = 0.45 * min(L0, L1) / math.tan(d * 0.5)
                if hw > limit:
                    hw = max(1.0, limit)
                    clamped += 1
        elif 1 <= i <= n - 2:
            L0 = math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
            L1 = math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
            a0 = math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0])
            a1 = math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0])
            d = abs((a1 - a0 + math.pi) % (2 * math.pi) - math.pi)
            if L0 > 0 and L1 > 0 and d > 1e-6:
                limit = 0.45 * min(L0, L1) / math.tan(d * 0.5)
                if hw > limit:
                    hw = max(1.0, limit)
                    clamped += 1
        left.append((pts[i][0] + nx * hw, pts[i][1] + nz * hw))
        right.append((pts[i][0] - nx * hw, pts[i][1] - nz * hw))
    if closed:
        # Order by area so a consumer always fills `outer` first and then
        # punches `hole` (which side is "left" depends on ring winding).
        a_out = abs(ring_area(left))
        a_in = abs(ring_area(right))
        if a_out >= a_in:
            return {"type": "ribbon-rings", "outer": qpts(left), "hole": qpts(right),
                    "clampedVertices": clamped}
        return {"type": "ribbon-rings", "outer": qpts(right), "hole": qpts(left),
                "clampedVertices": clamped}
    return {"type": "ribbon-polygon", "outer": qpts(left + list(reversed(right))),
            "hole": None, "clampedVertices": clamped}


def count_self_intersections(ring):
    """Number of proper segment intersections in a closed ring (report only)."""
    segs = list(zip(ring, ring[1:] + ring[:1]))
    n = len(segs)
    hits = 0
    for i in range(n):
        a, b = segs[i]
        for j in range(i + 1, n):
            if j == i or (j + 1) % n == i or (i + 1) % n == j:
                continue
            c, d = segs[j]
            if _seg_cross(a, b, c, d):
                hits += 1
    return hits


def _orient(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _seg_cross(a, b, c, d):
    o1 = _orient(a, b, c); o2 = _orient(a, b, d)
    o3 = _orient(c, d, a); o4 = _orient(c, d, b)
    return (o1 > 0) != (o2 > 0) and (o3 > 0) != (o4 > 0)


def ring_area(ring):
    s = 0.0
    for a, b in zip(ring, ring[1:] + ring[:1]):
        s += a[0] * b[1] - b[0] * a[1]
    return s * 0.5


# ---------------------------------------------------------------------------
# mask boundary tracing (free-roam basin)
# ---------------------------------------------------------------------------

def mask_rings(mask, x0, z0, cell):
    """Trace every boundary ring of a boolean mask (lattice unit edges).

    Returns a list of rings in world coordinates; outer rings and holes are
    distinguished by signed area in the caller.  Deterministic edge stitching.
    """
    h, w = mask.shape
    m = np.zeros((h + 2, w + 2), dtype=bool)
    m[1:-1, 1:-1] = mask
    edges = {}
    def add(a, b):
        edges.setdefault(a, []).append(b)
    ys, xs = np.nonzero(m)
    for y, x in zip(ys.tolist(), xs.tolist()):
        if not m[y, x]:
            continue
        if not m[y - 1, x]:  # top side, inside on the left when walking -> +x
            add((x, y), (x + 1, y))
        if not m[y + 1, x]:
            add((x + 1, y + 1), (x, y + 1))
        if not m[y, x - 1]:
            add((x, y + 1), (x, y))
        if not m[y, x + 1]:
            add((x + 1, y), (x + 1, y + 1))
    for v in edges.values():
        v.sort()
    rings = []
    for start in sorted(edges):
        while edges.get(start):
            ring = [start]
            cur = start
            prev = None
            guard = 0
            while True:
                guard += 1
                if guard > 4_000_000:
                    raise RuntimeError("boundary trace did not close")
                nxts = edges.get(cur)
                if not nxts:
                    break
                nxt = nxts.pop(0)
                ring.append(nxt)
                # prefer the sharpest right turn at a self-touching node
                prev, cur = cur, nxt
                if cur == start:
                    break
            if len(ring) >= 4:
                rings.append([(x0 + (p[0] - 1.5) * cell, z0 + (p[1] - 1.5) * cell)
                              for p in ring[:-1]])
    return rings


# ---------------------------------------------------------------------------
# projection
# ---------------------------------------------------------------------------

def bounds_of(points):
    xs = [p[0] for p in points]; zs = [p[1] for p in points]
    return {"minX": q(min(xs)), "maxX": q(max(xs)),
            "minZ": q(min(zs)), "maxZ": q(max(zs))}


def make_projection(bounds, width_px, height_px, pad_frac=0.06):
    """Uniform-scale world-XZ -> map-pixel transform (world-aligned, +Z down).

    scale = min(usable_w / dx, usable_h / dz); the world bbox centre maps to the
    viewport centre.  `rotationRad` is 0 here and is applied by the consumer.
    """
    dx = bounds["maxX"] - bounds["minX"]
    dz = bounds["maxZ"] - bounds["minZ"]
    pad = pad_frac * max(dx, dz)
    usable_w = width_px - 2.0 * pad
    usable_h = height_px - 2.0 * pad
    if dx <= 0 or dz <= 0:
        raise ValueError("degenerate bounds")
    scale = min(usable_w / dx, usable_h / dz)
    cx = (bounds["minX"] + bounds["maxX"]) * 0.5
    cz = (bounds["minZ"] + bounds["maxZ"]) * 0.5
    return {
        "viewport": {"w": width_px, "h": height_px},
        "paddingPx": q(pad),
        "scalePxPerM": q(scale),
        "worldCentre": [q(cx), q(cz)],
        "mapCentre": [q(width_px * 0.5), q(height_px * 0.5)],
        "rotationRad": 0.0,
        "axis": "+X right, +Z down (world-aligned; no compass claim)",
        "formula": "mapX = mapCentre.x + scale*(worldX-worldCentre.x); "
                   "mapY = mapCentre.y + scale*(worldZ-worldCentre.y)",
    }


def project(proj, x, z):
    s = proj["scalePxPerM"]
    mx, mz = proj["mapCentre"]; wx, wz = proj["worldCentre"]
    return (mx + s * (float(x) - wx), mz + s * (float(z) - wz))


def unproject(proj, mx, my):
    s = proj["scalePxPerM"]
    cx, cz = proj["mapCentre"]; wx, wz = proj["worldCentre"]
    return (wx + (float(mx) - cx) / s, wz + (float(my) - cz) / s)


def clamp_marker(proj, mx, my, inset_px):
    """Clamp a map point into the viewport inset by `inset_px`."""
    w = proj["viewport"]["w"]; h = proj["viewport"]["h"]
    lo_x, hi_x = inset_px, w - inset_px
    lo_y, hi_y = inset_px, h - inset_px
    return (min(max(mx, lo_x), hi_x), min(max(my, lo_y), hi_y))


def heading_to_screen(heading_rad, rotation_rad=0.0):
    """World heading (rad, clockwise from +Z, atan2(dx,dz)) -> screen direction.

    Screen +y is world +Z, so the unit screen vector is (sin a, cos a) with
    a = heading - rotation.  Returns (dx, dy) and the canvas angle used by
    `ctx.rotate` (atan2(dy, dx)).
    """
    a = float(heading_rad) - float(rotation_rad)
    dx = math.sin(a); dy = math.cos(a)
    return (dx, dy, math.atan2(dy, dx))


def principal_axis(points):
    """Angle of the dominant axis of the point cloud (radians, from +X)."""
    pts = np.asarray(points, dtype=np.float64)
    c = pts - pts.mean(axis=0)
    cov = (c.T @ c) / max(len(pts), 1)
    vals, vecs = np.linalg.eigh(cov)
    v = vecs[:, int(np.argmax(vals))]
    ang = math.atan2(v[1], v[0])
    if ang < 0:
        ang += math.pi
    return ang


def rotated_bounds(points, angle):
    ca, sa = math.cos(-angle), math.sin(-angle)
    out = [(p[0] * ca - p[1] * sa, p[0] * sa + p[1] * ca) for p in points]
    b = bounds_of(out)
    b["rotationRad"] = q(angle)
    b["widthM"] = q(b["maxX"] - b["minX"])
    b["depthM"] = q(b["maxZ"] - b["minZ"])
    return b


# ---------------------------------------------------------------------------
# PNG (deterministic, dependency-free) and SVG
# ---------------------------------------------------------------------------

def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (struct_u32(len(data)) + tag + data
            + struct_u32(zlib.crc32(tag + data) & 0xFFFFFFFF))


def struct_u32(v):
    return int(v).to_bytes(4, "big")


def write_png(path, rgb):
    """Write an (H, W, 3) uint8 RGB array as a PNG (no metadata, deterministic)."""
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))
    out = b"\x89PNG\r\n\x1a\n"
    out += _png_chunk(b"IHDR", struct_u32(w) + struct_u32(h) + bytes([8, 2, 0, 0, 0]))
    out += _png_chunk(b"IDAT", zlib.compress(raw, 6))
    out += _png_chunk(b"IEND", b"")
    Path(path).write_bytes(out)


class Canvas:
    """Tiny software rasteriser with 2x supersampling and deterministic output."""

    def __init__(self, w, h, bg=(14, 18, 24), ss=2):
        self.w = int(w); self.h = int(h); self.ss = int(ss)
        self.buf = np.zeros((self.h * self.ss, self.w * self.ss, 3), np.float32)
        self.buf[:, :] = np.asarray(bg, np.float32)

    def _put(self, x, y, color, alpha=1.0):
        x = int(round(x * self.ss)); y = int(round(y * self.ss))
        if 0 <= y < self.buf.shape[0] and 0 <= x < self.buf.shape[1]:
            c = np.asarray(color, np.float32)
            self.buf[y, x] = self.buf[y, x] * (1 - alpha) + c * alpha

    def line(self, a, b, color, width_px=1.0, alpha=1.0):
        ss = self.ss
        ax, ay = a[0] * ss, a[1] * ss
        bx, by = b[0] * ss, b[1] * ss
        r = max(0.5 * ss, width_px * ss * 0.5)
        H, W = self.buf.shape[:2]
        x0 = max(0, int(math.floor(min(ax, bx) - r - 2)))
        x1 = min(W - 1, int(math.ceil(max(ax, bx) + r + 2)))
        y0 = max(0, int(math.floor(min(ay, by) - r - 2)))
        y1 = min(H - 1, int(math.ceil(max(ay, by) + r + 2)))
        if x1 < x0 or y1 < y0:
            return
        xs = np.arange(x0, x1 + 1, dtype=np.float64) + 0.5
        ys = np.arange(y0, y1 + 1, dtype=np.float64) + 0.5
        px, py = np.meshgrid(xs, ys)
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        if L2 <= 0.0:
            t = np.zeros_like(px)
        else:
            t = np.clip(((px - ax) * dx + (py - ay) * dy) / L2, 0.0, 1.0)
        d = np.hypot(px - (ax + t * dx), py - (ay + t * dy))
        cov = np.clip(r + 0.5 - d, 0.0, 1.0) * alpha
        if not np.any(cov > 0):
            return
        sub = self.buf[y0:y1 + 1, x0:x1 + 1]
        c = np.asarray(color, np.float32)
        m = cov[..., None]
        sub[:] = sub * (1.0 - m) + c * m

    def polyline(self, pts, color, width_px=2.0, closed=False, alpha=1.0):
        seq = list(pts) + ([pts[0]] if closed and len(pts) > 2 else [])
        for a, b in zip(seq, seq[1:]):
            self.line(a, b, color, width_px, alpha)

    def polygon(self, pts, color, alpha=1.0):
        """Scanline fill of a closed polygon (even-odd)."""
        if len(pts) < 3:
            return
        ys = [p[1] for p in pts]
        y0 = max(0, int(math.floor(min(ys)))); y1 = min(self.h - 1, int(math.ceil(max(ys))))
        n = len(pts)
        for py in range(y0, y1 + 1):
            yy = py + 0.5
            xs = []
            for i in range(n):
                ax, ay = pts[i]; bx, by = pts[(i + 1) % n]
                if (ay <= yy < by) or (by <= yy < ay):
                    xs.append(ax + (yy - ay) * (bx - ax) / (by - ay))
            xs.sort()
            for k in range(0, len(xs) - 1, 2):
                xa = int(math.ceil(xs[k] * self.ss)); xb = int(math.floor(xs[k + 1] * self.ss))
                if xb >= xa:
                    row = self.buf[py * self.ss:(py + 1) * self.ss]
                    c = np.asarray(color, np.float32)
                    row[:, max(0, xa):max(0, xb + 1)] = (
                        row[:, max(0, xa):max(0, xb + 1)] * (1 - alpha) + c * alpha)

    def dot(self, p, color, radius=3.0):
        ss = self.ss
        cx, cy = p[0] * ss, p[1] * ss
        r = radius * ss
        H, W = self.buf.shape[:2]
        x0 = max(0, int(math.floor(cx - r - 2))); x1 = min(W - 1, int(math.ceil(cx + r + 2)))
        y0 = max(0, int(math.floor(cy - r - 2))); y1 = min(H - 1, int(math.ceil(cy + r + 2)))
        if x1 < x0 or y1 < y0:
            return
        xs = np.arange(x0, x1 + 1) + 0.5; ys = np.arange(y0, y1 + 1) + 0.5
        px, py = np.meshgrid(xs, ys)
        d = np.hypot(px - cx, py - cy)
        cov = np.clip(r + 0.5 - d, 0.0, 1.0)[..., None]
        sub = self.buf[y0:y1 + 1, x0:x1 + 1]
        c = np.asarray(color, np.float32)
        sub[:] = sub * (1.0 - cov) + c * cov

    def ring(self, p, color, radius=5.0, width=1.0):
        steps = max(16, int(radius * 8))
        prev = None
        for i in range(steps + 1):
            a = 2 * math.pi * i / steps
            cur = (p[0] + math.cos(a) * radius, p[1] + math.sin(a) * radius)
            if prev is not None:
                self.line(prev, cur, color, width)
            prev = cur

    def triangle(self, p, color, size=6.0, direction=(0.0, 1.0)):
        dx, dy = direction
        n = math.hypot(dx, dy) or 1.0
        dx, dy = dx / n, dy / n
        px, py = -dy, dx
        tip = (p[0] + dx * size, p[1] + dy * size)
        a = (p[0] - dx * size * 0.6 + px * size * 0.75, p[1] - dy * size * 0.6 + py * size * 0.75)
        b = (p[0] - dx * size * 0.6 - px * size * 0.75, p[1] - dy * size * 0.6 - py * size * 0.75)
        self.polygon([tip, a, b], color)

    def finish(self):
        ss = self.ss
        img = self.buf.reshape(self.h, ss, self.w, ss, 3).mean(axis=(1, 3))
        return np.clip(img + 0.5, 0, 255).astype(np.uint8)


def svg_doc(width, height, elements):
    body = "\n".join(elements)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
            'viewBox="0 0 %d %d">\n<rect width="100%%" height="100%%" fill="#0e1218"/>\n'
            '%s\n</svg>\n') % (width, height, width, height, body)


def svg_path_d(pts, closed=False):
    if not pts:
        return ""
    d = "M %.2f %.2f" % (pts[0][0], pts[0][1])
    for p in pts[1:]:
        d += " L %.2f %.2f" % (p[0], p[1])
    if closed:
        d += " Z"
    return d
