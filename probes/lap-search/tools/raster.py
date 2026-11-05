#!/usr/bin/env python3
"""Raster primitives shared by the lap-search builder.

The traversability model is the P48 model; the connected-component and island
code is new here because the lap question needs holes, not geodesic distance.

Run-length union-find labelling is used instead of a per-cell Python flood so a
0.5 m full-level scan (about 19 M cells) stays a batch job. The label values are
deterministic: runs are numbered in row-major order and each final component is
named after its minimum run id.

    (module; no CLI)
"""
from __future__ import annotations

import math

import numpy as np


# --------------------------------------------------------------------------
# surface / wall rasters (same constants and gates as P48 drivable-path.md)
# --------------------------------------------------------------------------

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
    """Highest up-facing triangle per XZ cell (NaN where no surface)."""
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
    """Cells within `radius` of a steep triangle whose height band meets the ground."""
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
    """k-layer 8-connected erosion (a retained cell has all 8 neighbours)."""
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


# --------------------------------------------------------------------------
# connected components via run-length union-find
# --------------------------------------------------------------------------

def _row_runs(row):
    d = np.diff(np.concatenate(([0], row.view(np.int8), [0])))
    starts = np.flatnonzero(d == 1)
    ends = np.flatnonzero(d == -1) - 1
    return starts, ends


def label_components(mask, conn=8):
    """4- or 8-connected labels for a 2D bool mask.

    Returns (labels int32, sizes list indexed by label-1), deterministic.
    """
    nz, nx = mask.shape
    parent = []

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra == rb:
            return
        if ra < rb:
            parent[rb] = ra
        else:
            parent[ra] = rb

    prev_s = prev_e = None
    prev_ids = None
    row_ids = []
    for j in range(nz):
        s, e = _row_runs(mask[j])
        ids = list(range(len(parent), len(parent) + len(s)))
        parent.extend(ids)
        if prev_s is not None and len(s):
            pad = 1 if conn == 8 else 0
            k = 0
            for idx in range(len(s)):
                a0, a1 = int(s[idx]), int(e[idx])
                while k < len(prev_s) and int(prev_e[k]) + pad < a0:
                    k += 1
                kk = k
                while kk < len(prev_s) and int(prev_s[kk]) <= a1 + pad:
                    union(ids[idx], prev_ids[kk])
                    kk += 1
        row_ids.append(ids)
        prev_s, prev_e, prev_ids = s, e, ids

    roots = [find(i) for i in range(len(parent))]
    # name each component after its minimum run id (row-major, deterministic)
    root_to_label = {}
    labels = np.zeros(mask.shape, dtype=np.int32)
    for j in range(nz):
        ids = row_ids[j]
        if not ids:
            continue
        s, e = _row_runs(mask[j])
        for idx in range(len(ids)):
            root = roots[ids[idx]]
            lab = root_to_label.get(root)
            if lab is None:
                lab = len(root_to_label) + 1
                root_to_label[root] = lab
            labels[j, int(s[idx]):int(e[idx]) + 1] = lab
    counts = np.bincount(labels.ravel(), minlength=len(root_to_label) + 1)
    sizes = [int(counts[lab]) for lab in range(1, len(root_to_label) + 1)]
    return labels, sizes


def enclosed_islands(mask, flab):
    """Enclosed 4-connected background regions of a foreground mask.

    `flab` is the foreground label raster (`label_components(mask, 8)[0]`). An
    island is a 4-connected background region that a border flood cannot reach.
    Returns a list of dicts: bg label, cell size, bbox/centroid in raster
    coordinates and the foreground label that surrounds it.
    """
    nz, nx = mask.shape
    bg = ~mask
    blab, bsizes = label_components(bg, conn=4)
    border_ids = set(int(v) for v in np.concatenate(
        (blab[0, :], blab[-1, :], blab[:, 0], blab[:, -1])))
    nb = len(bsizes)
    nf = int(flab.max())
    # count foreground labels adjacent to each island (4-neighbour contact)
    counts = np.zeros((nb + 1) * (nf + 1), dtype=np.int64)
    for dj, di in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        src = np.zeros_like(flab)
        ys = slice(max(0, dj), nz + min(0, dj))
        yd = slice(max(0, -dj), nz - max(0, dj))
        xs = slice(max(0, di), nx + min(0, di))
        xd = slice(max(0, -di), nx - max(0, di))
        src[yd, xd] = flab[ys, xs]
        sel = bg & (src > 0)
        if sel.any():
            key = blab[sel].astype(np.int64) * (nf + 1) + src[sel]
            counts += np.bincount(key, minlength=counts.size)
    counts = counts.reshape(nb + 1, nf + 1)
    own = counts.argmax(axis=1).astype(np.int32)
    jj, ii = np.where(bg)
    bl = blab[jj, ii]
    sizes = np.bincount(bl, minlength=nb + 1)
    minx = np.full(nb + 1, nx, dtype=np.int64)
    maxx = np.full(nb + 1, -1, dtype=np.int64)
    minz = np.full(nb + 1, nz, dtype=np.int64)
    maxz = np.full(nb + 1, -1, dtype=np.int64)
    np.minimum.at(minx, bl, ii)
    np.maximum.at(maxx, bl, ii)
    np.minimum.at(minz, bl, jj)
    np.maximum.at(maxz, bl, jj)
    sumx = np.bincount(bl, weights=ii)
    sumz = np.bincount(bl, weights=jj)
    out = []
    for bid in range(1, nb + 1):
        if sizes[bid] == 0 or bid in border_ids:
            continue
        out.append(dict(bgLabel=bid, size=int(sizes[bid]),
                        bbox=[int(minx[bid]), int(maxx[bid]), int(minz[bid]), int(maxz[bid])],
                        centroid=[float(sumx[bid] / sizes[bid]),
                                  float(sumz[bid] / sizes[bid])],
                        owner=int(own[bid])))
    out.sort(key=lambda h: -h["size"])
    return out
