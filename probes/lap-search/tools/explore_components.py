#!/usr/bin/env python3
"""P61 exploratory scan: collision-passable components and enclosed islands.

This is the scratch measurement that decides which components deserve a 0.5 m
cycle search. It is not part of the final claim; build_loops.py re-derives
everything it reports.

Model constants are the P48 traversability model (drivable-path.md §3.1):
  * surface: up-facing triangle normal.y > 0.94 (<= 20 deg)
  * passable: surface present in all 8 neighbours, max neighbour dh <= 2.5 cm
  * wall mask: |normal.y| < 0.5, height band ground+0.05..2.0 m, XZ dilated 0.5 m

    python probes/lap-search/tools/explore_components.py
"""
from __future__ import annotations

import math
import sys
import time
from collections import deque
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
import reference_oracle as oracle  # noqa: E402

PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"

CELL = 1.0
SURFACE_MIN_NY = 0.94
STEP_LIMIT = 0.05
GRADE_LIMIT = 0.05
WALL_DILATE = 0.5


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


def label(mask, conn=8):
    """Connected-component labels; returns (labels, sizes). Deterministic order."""
    nz, nx = mask.shape
    lab = np.zeros((nz, nx), dtype=np.int32)
    sizes = []
    cur = 0
    if conn == 8:
        nb = ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1))
    else:
        nb = ((-1, 0), (1, 0), (0, -1), (0, 1))
    for j in range(nz):
        for i in range(nx):
            if not mask[j, i] or lab[j, i]:
                continue
            cur += 1
            n = 0
            q = deque([(j, i)])
            lab[j, i] = cur
            while q:
                jj, ii = q.popleft()
                n += 1
                for dj, di in nb:
                    y, x = jj + dj, ii + di
                    if 0 <= y < nz and 0 <= x < nx and mask[y, x] and not lab[y, x]:
                        lab[y, x] = cur
                        q.append((y, x))
            sizes.append(n)
    return lab, sizes


def holes_of(lab, comp_id):
    """Enclosed 4-connected background regions of one component.

    A background cell belongs to a hole when a 4-connected flood from the raster
    border (over every non-component cell) cannot reach it.
    """
    comp = lab == comp_id
    nz, nx = comp.shape
    bg = ~comp
    seen = np.zeros((nz, nx), dtype=bool)
    q = deque()
    for j in list(range(nz)):
        for i in (0, nx - 1):
            if bg[j, i] and not seen[j, i]:
                seen[j, i] = True
                q.append((j, i))
    for i in list(range(nx)):
        for j in (0, nz - 1):
            if bg[j, i] and not seen[j, i]:
                seen[j, i] = True
                q.append((j, i))
    nb4 = ((-1, 0), (1, 0), (0, -1), (0, 1))
    while q:
        j, i = q.popleft()
        for dj, di in nb4:
            y, x = j + dj, i + di
            if 0 <= y < nz and 0 <= x < nx and bg[y, x] and not seen[y, x]:
                seen[y, x] = True
                q.append((y, x))
    hole = bg & ~seen
    if not hole.any():
        return []
    hlab, hsizes = label(hole, conn=4)
    out = []
    for hid, size in enumerate(hsizes, start=1):
        jj, ii = np.where(hlab == hid)
        if not len(jj):
            continue
        out.append(dict(size=int(size), bbox=[int(ii.min()), int(ii.max()),
                                              int(jj.min()), int(jj.max())],
                        centroid=[float(ii.mean()), float(jj.mean())]))
    out.sort(key=lambda h: -h["size"])
    return out


def main():
    t0 = time.time()
    level = oracle.load_level(PHYSICS.read_bytes())
    tris = flatten_triangles(level)
    nrm = triangle_normals(tris)
    surface = tris[nrm[:, 1] > SURFACE_MIN_NY]
    wall = tris[np.abs(nrm[:, 1]) < 0.5]
    print("triangles", len(tris), "surface", len(surface), "wall", len(wall))

    all_pts = tris.reshape(-1, 3)
    x0 = math.floor(all_pts[:, 0].min()) - 2
    x1 = math.ceil(all_pts[:, 0].max()) + 2
    z0 = math.floor(all_pts[:, 2].min()) - 2
    z1 = math.ceil(all_pts[:, 2].max()) + 2
    print("window", (x0, x1, z0, z1))
    H, xs, zs = rasterise_height(surface, x0, x1, z0, z1, CELL)
    print("height raster %.1fs" % (time.time() - t0))
    dh = edge_max_dh(H)
    W = rasterise_wall(wall, H, x0, x1, z0, z1, CELL, WALL_DILATE)
    print("wall raster %.1fs" % (time.time() - t0))
    edge_dh = min(STEP_LIMIT, GRADE_LIMIT * CELL)
    base = np.isfinite(H) & (dh <= edge_dh + 1e-9) & ~W
    print("base passable", int(base.sum()), "cells")

    for name, mask in (("base", base), ("erode1", erode(base, 1)), ("erode2", erode(base, 2))):
        print("---", name)
        lab, sizes = label(mask, conn=8)
        order = np.argsort(-np.asarray(sizes))
        for rank, idx in enumerate(order[:15], start=1):
            cid = int(idx) + 1
            size = int(sizes[idx])
            jj, ii = np.where(lab == cid)
            hs = holes_of(lab, cid)
            print("comp %d cells %d area %.0f m2 bbox x %.0f..%.0f z %.0f..%.0f holes %d %s"
                  % (rank, size, size * CELL * CELL, xs[ii.min()], xs[ii.max()],
                     zs[jj.min()], zs[jj.max()], len(hs),
                     [(h["size"], round(h["size"] * CELL * CELL)) for h in hs[:5]]))
        print("components", len(sizes), "total cells", int(mask.sum()))
    print("total %.1fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
