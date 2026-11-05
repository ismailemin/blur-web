#!/usr/bin/env python3
"""Edge step statistics on the collision surface near the spawn band.

    python probes/drivable-path/tools/stats_edges.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
import reference_oracle as oracle  # noqa: E402

PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"


def flatten(level):
    out = []
    for mesh in level["meshes"]:
        verts = mesh["vertices"]
        for tri in mesh["triangles"]:
            leaf = mesh["leaves"][tri["leaf"]]
            base = leaf["vertex_start"]
            out.append((verts[base + tri["a"]], verts[base + tri["b"]], verts[base + tri["c"]]))
    return np.asarray(out, dtype=np.float64)


def normals(tris):
    u = tris[:, 1] - tris[:, 0]
    v = tris[:, 2] - tris[:, 0]
    n = np.cross(u, v)
    ln = np.linalg.norm(n, axis=1)
    ln[ln == 0] = 1.0
    return n / ln[:, None]


def raster(tris, x0, x1, z0, z1, cell):
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
        i0 = max(0, int(np.floor((min(a[0], b[0], c[0]) - x0) / cell)))
        i1 = min(nx - 1, int(np.ceil((max(a[0], b[0], c[0]) - x0) / cell)))
        j0 = max(0, int(np.floor((min(a[2], b[2], c[2]) - z0) / cell)))
        j1 = min(nz - 1, int(np.ceil((max(a[2], b[2], c[2]) - z0) / cell)))
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


def main():
    level = oracle.load_level(PHYSICS.read_bytes())
    tris = flatten(level)
    nrm = normals(tris)
    up = tris[nrm[:, 1] > 0.5]
    x0, x1, z0, z1, cell = -120.0, 40.0, 980.0, 1200.0, 0.5
    H, xs, zs = raster(up, x0, x1, z0, z1, cell)
    print("raster", H.shape, "covered", int(np.isfinite(H).sum()))
    dh = []
    kinds = {}
    for dj, di, name in ((0, 1, "x"), (1, 0, "z")):
        A = H[:H.shape[0] - dj if dj else None, :H.shape[1] - di if di else None]
        B = H[dj:, di:]
        m = np.isfinite(A) & np.isfinite(B)
        d = np.abs(A[m] - B[m])
        dh.append(d)
        print(name, "pairs", len(d),
              "|dh| p50 %.4f p90 %.4f p99 %.4f p99.9 %.4f max %.4f"
              % (np.percentile(d, 50), np.percentile(d, 90), np.percentile(d, 99),
                 np.percentile(d, 99.9), d.max()))
        for th in (0.01, 0.02, 0.025, 0.03, 0.04, 0.05, 0.1):
            kinds[(name, th)] = int((d > th).sum())
    d = np.concatenate(dh)
    print("all pairs", len(d))
    for th in (0.01, 0.02, 0.025, 0.03, 0.04, 0.05, 0.1):
        print("  |dh| > %.3f : %d (%.3f%%)" % (th, (d > th).sum(), 100.0 * (d > th).mean()))
    # height range in the channel
    m = np.isfinite(H)
    print("height min/max/mean", np.nanmin(H), np.nanmax(H), np.nanmean(H))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
