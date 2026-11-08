#!/usr/bin/env python3
"""Shared inputs, model constants and geometry helpers for the map-lap probe.

This module generalizes the P61 lap search (`probes/lap-search`) to the two
point-to-point maps `usa_amboy` and `spa_barcelona_gracia`.

Read-only reuse:
  * `probes/map-pipeline/tools/physics_scan.py` decodes the shape stream. The
    committed collision oracle alone rejects these levels because their first
    import shape is a Box; the map-pipeline scanner follows the upstream
    serializer and decodes triangle mesh types 0 and 11 with the oracle
    routines verbatim.
  * `probes/lap-search/tools/raster.py` supplies the P48 raster primitives
    (surface raster, 8-neighbour height difference, wall mask, erosion,
    run-length component labelling). No file is modified.

Only static triangle meshes (types 0 and 11) are in the model. Simple shapes
(Box, Cylinder) and InstancedTriangleMesh are not decoded by the committed
scanner and are therefore not in the raster; that is recorded, not guessed.

No draw geometry is read by this module.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
sys.path.insert(0, str(ROOT / "probes/lap-search/tools"))

import physics_scan as scan  # noqa: E402  (read-only import)
from raster import (  # noqa: E402  (read-only import)
    triangle_normals, rasterise_height, edge_max_dh, rasterise_wall, erode,
    label_components,
)

# --------------------------------------------------------------------------
# model constants (P48 / P61, unchanged)
# --------------------------------------------------------------------------
CELL = 0.5
SURFACE_MIN_NY = 0.94
STEP_LIMIT = 0.05
GRADE_LIMIT = 0.05
EDGE_DH = min(STEP_LIMIT, GRADE_LIMIT * CELL)          # 0.025 m
WALL_DILATE = 0.5
ISLAND_MIN_M2 = 100.0
ISLAND_MIN_CELLS = int(round(ISLAND_MIN_M2 / (CELL * CELL)))
LOOP_ERODE = 3
MAX_ERODE = 8
SAMPLE_STEP = 0.25

# car envelope: widest/longest box proxy across the 25-car XT roster
CAR_LENGTH = 2.981
CAR_WIDTH = 1.676
SAFETY_MARGIN = 0.30
HALF_LENGTH = CAR_LENGTH / 2.0 + SAFETY_MARGIN          # 1.7905
HALF_WIDTH = CAR_WIDTH / 2.0 + SAFETY_MARGIN            # 1.138
NEED_WIDTH = CAR_WIDTH + 2.0 * SAFETY_MARGIN            # 2.276

DIRS8 = [(0, -1), (-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1)]


# --------------------------------------------------------------------------
# level registry (values copied from the committed map-slice packages)
# --------------------------------------------------------------------------
LEVELS = {
    "usa_amboy": dict(
        physics="game-data/Blur/levels/usa_amboy/Level.levelphysics",
        slicePackage="_work/map-slice/amboy",
        sliceDoc="_work/map-slice/amboy/slice.json",
        pathDoc="_work/map-pipeline/paths/usa_amboy.json",
        spawn=dict(x=230.0, z=1128.0, heading=-2.35619449),
        pathLengthM=2060.59538,
        checkpointsM=[686.8623, 1373.6673],
        finish=[-356.0, 860.0],
        triangles=63708,
        staticShapes="0 TriangleMesh + 11 TriangleMeshBase",
        undecodedShapes="0 Box, 4 Cylinder, 10 InstancedTriangleMesh",
    ),
    "spa_barcelona_gracia": dict(
        physics="game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics",
        slicePackage="_work/map-slice/gracia",
        sliceDoc="_work/map-slice/gracia/slice.json",
        pathDoc="_work/map-pipeline/paths/spa_barcelona_gracia.json",
        spawn=dict(x=336.0, z=-23.0, heading=2.15879893),
        pathLengthM=624.91378,
        checkpointsM=[208.343397, 416.652055],
        finish=[876.0, -142.0],
        triangles=113270,
        staticShapes="2x 0 TriangleMesh + 2x 11 TriangleMeshBase",
        undecodedShapes="2 Box, 38 InstancedTriangleMesh",
    ),
}


def out_dir(level: str) -> Path:
    p = ROOT / "_work/map-laps" / level
    p.mkdir(parents=True, exist_ok=True)
    return p


# --------------------------------------------------------------------------
# collision triangles
# --------------------------------------------------------------------------

def load_level(level: str):
    cfg = LEVELS[level]
    path = ROOT / cfg["physics"]
    data = path.read_bytes()
    parsed = scan.scan_level(data)
    return cfg, path, data, parsed


def flatten_static(parsed):
    """(n,3,3) triangle soup of every static triangle mesh (types 0 and 11)."""
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
    return np.asarray(out, dtype=np.float64)


def bounds(tris, pad=2.0):
    p = tris.reshape(-1, 3)
    return (math.floor(p[:, 0].min()) - pad, math.ceil(p[:, 0].max()) + pad,
            math.floor(p[:, 2].min()) - pad, math.ceil(p[:, 2].max()) + pad)


def build_raster(tris, cell=CELL, log=print, step_limit=STEP_LIMIT, grade_limit=GRADE_LIMIT):
    """P48 surface passability + wall mask. Returns a dict of rasters."""
    nrm = triangle_normals(tris)
    surface = tris[nrm[:, 1] > SURFACE_MIN_NY]
    wall = tris[np.abs(nrm[:, 1]) < 0.5]
    x0, x1, z0, z1 = bounds(tris)
    log("raster %d cells, %d surface tris, %d steep tris"
        % (((int(round((x1 - x0) / cell)) + 1) * (int(round((z1 - z0) / cell)) + 1),
            len(surface), len(wall))))
    H, xs, zs = rasterise_height(surface, x0, x1, z0, z1, cell)
    dh = edge_max_dh(H)
    W = rasterise_wall(wall, H, x0, x1, z0, z1, cell, WALL_DILATE)
    edge_dh = min(step_limit, grade_limit * cell)
    base = np.isfinite(H) & (dh <= edge_dh + 1e-9) & ~W
    return dict(H=H, dh=dh, W=W, base=base, xs=xs, zs=zs, cell=cell,
                x0=x0, x1=x1, z0=z0, z1=z1, edge_dh=edge_dh,
                step_limit=step_limit, grade_limit=grade_limit,
                triNormals=nrm)


# --------------------------------------------------------------------------
# enclosed islands (memory-lean replacement for raster.enclosed_islands)
# --------------------------------------------------------------------------

def enclosed_islands(mask, flab):
    """Enclosed 4-connected background regions, with their owning foreground.

    Same definition as P61 (`raster.enclosed_islands`), but the island/owner
    join is computed on the boundary-cell pairs instead of an (nb+1)x(nf+1)
    dense histogram, which does not fit for a city-sized raster.
    """
    nz, nx = mask.shape
    bg = ~mask
    blab, bsizes = label_components(bg, conn=4)
    nb = len(bsizes)
    nf = int(flab.max())
    border_ids = set(int(v) for v in np.concatenate(
        (blab[0, :], blab[-1, :], blab[:, 0], blab[:, -1])))

    keys = []
    for dj, di in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        ys = slice(max(0, dj), nz + min(0, dj))
        yd = slice(max(0, -dj), nz - max(0, dj))
        xs = slice(max(0, di), nx + min(0, di))
        xd = slice(max(0, -di), nx - max(0, di))
        src = np.zeros_like(flab)
        src[yd, xd] = flab[ys, xs]
        sel = bg & (src > 0)
        if sel.any():
            keys.append(blab[sel].astype(np.int64) * (nf + 1) + src[sel])
    if keys:
        allk = np.concatenate(keys)
        uniq, cnt = np.unique(allk, return_counts=True)
        ubl = uniq // (nf + 1)
        ufg = uniq % (nf + 1)
        order = np.lexsort((-cnt, ubl))
        ubl, ufg = ubl[order], ufg[order]
        first = np.ones(len(ubl), dtype=bool)
        first[1:] = ubl[1:] != ubl[:-1]
        owner_of = dict(zip(ubl[first].tolist(), ufg[first].tolist()))
    else:
        owner_of = {}

    jj, ii = np.where(bg)
    bl = blab[jj, ii]
    minx = np.full(nb + 1, nx, dtype=np.int64)
    maxx = np.full(nb + 1, -1, dtype=np.int64)
    minz = np.full(nb + 1, nz, dtype=np.int64)
    maxz = np.full(nb + 1, -1, dtype=np.int64)
    np.minimum.at(minx, bl, ii)
    np.maximum.at(maxx, bl, ii)
    np.minimum.at(minz, bl, jj)
    np.maximum.at(maxz, bl, jj)
    out = []
    for bid in range(1, nb + 1):
        if bsizes[bid - 1] == 0 or bid in border_ids:
            continue
        out.append(dict(bgLabel=bid, size=int(bsizes[bid - 1]),
                        bbox=[int(minx[bid]), int(maxx[bid]), int(minz[bid]), int(maxz[bid])],
                        owner=int(owner_of.get(bid, 0))))
    out.sort(key=lambda h: -h["size"])
    return out


def eroded_background(base, k):
    """Background labelling after k clearance erosions, with the border label set."""
    F = erode(base, k)
    blab, _ = label_components(~F, conn=4)
    border = set(int(v) for v in np.concatenate(
        (blab[0, :], blab[-1, :], blab[:, 0], blab[:, -1])))
    return F, blab, border


def island_still_enclosed(blab, border, island_cells):
    """True when >=50% of `island_cells` sit in a non-border bg region.

    This is the P61 survival rule (an island that is still enclosed after k
    clearance erosions has a ring at >= (k+1)*cell from every blocked cell).
    """
    labs = blab[island_cells[:, 0], island_cells[:, 1]]
    vals, cnts = np.unique(labs, return_counts=True)
    best = 0
    for v, c in zip(vals.tolist(), cnts.tolist()):
        if v != 0 and v not in border:
            best = max(best, c)
    return best >= 0.5 * len(island_cells)


# --------------------------------------------------------------------------
# closed-path extraction (copied from probes/lap-search/tools/build_loops.py)
# --------------------------------------------------------------------------

def moore_trace(mask):
    """Ordered outer boundary pixels of one 8-connected region (Moore trace)."""
    ys, xs = np.nonzero(mask)
    j0 = int(ys[0])
    i0 = int(xs[ys == ys[0]][0])
    start = (j0, i0)
    b = start
    c = (j0, i0 - 1)
    contour = [start]
    seen = set()
    while True:
        k = DIRS8.index((c[0] - b[0], c[1] - b[1]))
        found = False
        for t in range(1, 9):
            kk = (k + t) % 8
            nb = (b[0] + DIRS8[kk][0], b[1] + DIRS8[kk][1])
            if 0 <= nb[0] < mask.shape[0] and 0 <= nb[1] < mask.shape[1] and mask[nb]:
                c = (b[0] + DIRS8[(kk - 1) % 8][0], b[1] + DIRS8[(kk - 1) % 8][1])
                b = nb
                found = True
                break
        if not found:
            break
        state = (b, c)
        if state in seen:
            break
        seen.add(state)
        contour.append(b)
        if b == start and len(contour) > 4:
            break
    return contour


def map_to_foreground(contour, mask):
    nz, nx = mask.shape
    out = []
    prev = None
    for (j, i) in contour:
        cands = []
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                if dj == 0 and di == 0:
                    continue
                y, x = j + dj, i + di
                if 0 <= y < nz and 0 <= x < nx and mask[y, x]:
                    cands.append((y, x))
        if not cands:
            continue
        if prev is None:
            cands.sort()
            pick = cands[0]
        else:
            cands.sort(key=lambda q: (abs(q[0] - prev[0]) + abs(q[1] - prev[1]), q))
            pick = cands[0]
        out.append(pick)
        prev = pick
    return out


def line_of_sight(mask, a, b):
    j0, i0 = a
    j1, i1 = b
    steps = max(abs(j1 - j0), abs(i1 - i0))
    if steps == 0:
        return bool(mask[j0, i0])
    for k in range(steps + 1):
        t = k / steps
        j = int(round(j0 + (j1 - j0) * t))
        i = int(round(i0 + (i1 - i0) * t))
        if not mask[j, i]:
            return False
    return True


def simplify_cyclic(mask, cells, passes=4):
    pts = []
    for c in cells:
        if not pts or c != pts[-1]:
            pts.append(c)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    for _ in range(passes):
        n = len(pts)
        if n < 8:
            break
        pts = pts[1:] + pts[:1]
        out = [pts[0]]
        for i in range(1, n - 1):
            a = out[-1]
            b = pts[i]
            c = pts[i + 1]
            if (line_of_sight(mask, a, c)
                    and math.hypot(c[0] - a[0], c[1] - a[1])
                    <= math.hypot(b[0] - a[0], b[1] - a[1])
                    + math.hypot(c[0] - b[0], c[1] - b[1]) - 1e-9):
                continue
            out.append(b)
        out.append(pts[-1])
        pts = out
    if len(pts) > 1 and pts[-1] == pts[0]:
        pts.pop()
    return pts


def resample_closed(points, step):
    out = []
    for a, b in zip(points, points[1:]):
        l = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(math.ceil(l / step)))
        for k in range(n):
            t = k / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    out.append(points[-1])
    return out


# --------------------------------------------------------------------------
# metrics
# --------------------------------------------------------------------------

def loop_metrics(samples, H, W, dh, xs, zs, cell, edge_dh):
    """Raster step/grade/clearance/band for a closed, resampled loop line."""
    nz, nx = H.shape
    ii = np.rint((np.asarray([p[0] for p in samples]) - xs[0]) / cell).astype(np.int64)
    jj = np.rint((np.asarray([p[1] for p in samples]) - zs[0]) / cell).astype(np.int64)
    ok = (ii >= 0) & (ii < nx) & (jj >= 0) & (jj < nz)
    hs = np.full(len(samples), np.nan)
    hs[ok] = H[jj[ok], ii[ok]]
    step = np.abs(np.diff(hs))
    finite_step = step[np.isfinite(step)]
    max_step = float(finite_step.max()) if finite_step.size else None

    # 2 m grade along the sampled arc (closed)
    pts = np.asarray(samples, dtype=np.float64)
    seg = np.hypot(np.diff(pts[:, 0]), np.diff(pts[:, 1]))
    arc = np.concatenate(([0.0], np.cumsum(seg)))
    max_grade = 0.0
    n = len(samples) - 1
    for a in range(n):
        target = arc[a] + 2.0
        m = int(np.searchsorted(arc, target))
        if m >= len(arc):
            m = len(arc) - 1
        acc = arc[m] - arc[a]
        if acc >= 1.9 and math.isfinite(hs[a]) and math.isfinite(hs[m]):
            max_grade = max(max_grade, abs(hs[m] - hs[a]) / acc)

    # exact raster clearance to the nearest blocked cell (local window)
    blocked = ~(np.isfinite(H) & (dh <= edge_dh + 1e-9) & ~W)
    min_clear = None
    min_at = None
    for k, (x, z) in enumerate(samples):
        i, j = int(round((x - xs[0]) / cell)), int(round((z - zs[0]) / cell))
        if not (0 <= j < nz and 0 <= i < nx):
            continue
        r = 24
        j0, j1 = max(0, j - r), min(nz, j + r + 1)
        i0, i1 = max(0, i - r), min(nx, i + r + 1)
        sub = blocked[j0:j1, i0:i1]
        if not sub.any():
            continue
        lj, li = np.nonzero(sub)
        d = np.hypot((lj + j0 - j) * cell, (li + i0 - i) * cell)
        md = float(d.min())
        if min_clear is None or md < min_clear:
            min_clear, min_at = md, k
    return dict(maxStep=max_step, maxGrade=max_grade,
                minClearance=min_clear, minClearanceAt=min_at,
                groundMin=float(np.nanmin(hs)) if np.isfinite(hs).any() else None,
                groundMax=float(np.nanmax(hs)) if np.isfinite(hs).any() else None,
                groundRange=(float(np.nanmax(hs) - np.nanmin(hs))
                             if np.isfinite(hs).any() else None))


def flat_band_width(samples, base, xs, zs, cell, reach=20.0):
    """Narrowest perpendicular passable run on the loop line (m).

    For every sample the perpendicular is walked in 0.5 m steps in both
    directions until a non-passable cell is met; both sides are summed.
    """
    nz, nx = base.shape
    worst = None
    worst_at = None
    n = len(samples) - 1
    for k in range(n):
        x, z = samples[k]
        a = samples[(k - 1) % n]
        b = samples[(k + 1) % n]
        tx, tz = b[0] - a[0], b[1] - a[1]
        tl = math.hypot(tx, tz) or 1.0
        nxv, nzv = -tz / tl, tx / tl
        half = 0.0
        for sgn in (1.0, -1.0):
            d = 0.0
            while d <= reach:
                d += cell
                i = int(round((x + nxv * sgn * d - xs[0]) / cell))
                j = int(round((z + nzv * sgn * d - zs[0]) / cell))
                if not (0 <= j < nz and 0 <= i < nx) or not base[j, i]:
                    break
            half += max(0.0, d - cell)
        if worst is None or half < worst:
            worst, worst_at = half, k
    return worst, worst_at


def path_component(path_doc, lab, xs, zs, cell):
    """Labels of every path sample plus the component holding the majority."""
    pts = [(p["x"], p["z"]) for p in path_doc["samples"]]
    ii = np.rint((np.asarray([p[0] for p in pts]) - xs[0]) / cell).astype(np.int64)
    jj = np.rint((np.asarray([p[1] for p in pts]) - zs[0]) / cell).astype(np.int64)
    ok = (ii >= 0) & (ii < lab.shape[1]) & (jj >= 0) & (jj < lab.shape[0])
    labs = lab[jj[ok], ii[ok]]
    vals, cnt = np.unique(labs, return_counts=True)
    order = np.argsort(-cnt)
    top = list(zip(vals[order].tolist(), cnt[order].tolist()))[:8]
    return dict(samples=int(ok.sum()),
                components=[dict(component=int(v), samples=int(c)) for v, c in top])


def json_hash(doc):
    import hashlib
    body = json.dumps({k: v for k, v in doc.items() if k != "hash"},
                      sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()


def write_json(path: Path, doc: dict):
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
