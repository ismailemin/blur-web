#!/usr/bin/env python3
"""Exploratory collision-surface raster around the committed E1 spawn.

Read-only: parses game-data/Blur/levels/usa_la_river/Level.levelphysics with the
committed collision-oracle reference parser (imported, not modified) and prints
surface statistics for a narrow window around the spawn. No output file is
written by this script; it is a measurement aid for the traversability builder.

    python probes/drivable-path/tools/explore_surface.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
import reference_oracle as oracle  # noqa: E402

PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"


def flatten_triangles(level):
    out = []
    for mesh in level["meshes"]:
        verts = mesh["vertices"]
        for tri in mesh["triangles"]:
            leaf = mesh["leaves"][tri["leaf"]]
            base = leaf["vertex_start"]
            a = verts[base + tri["a"]]
            b = verts[base + tri["b"]]
            c = verts[base + tri["c"]]
            out.append((a, b, c))
    return np.asarray(out, dtype=np.float64)


def normals(tris):
    u = tris[:, 1] - tris[:, 0]
    v = tris[:, 2] - tris[:, 0]
    n = np.cross(u, v)
    ln = np.linalg.norm(n, axis=1)
    ln[ln == 0] = 1.0
    return n / ln[:, None]


def main() -> int:
    data = PHYSICS.read_bytes()
    level = oracle.load_level(data)
    tris = flatten_triangles(level)
    nrm = normals(tris)
    print("meshes", len(level["meshes"]), "triangles", len(tris))
    print("bounds", tris.reshape(-1, 3).min(axis=0), tris.reshape(-1, 3).max(axis=0))

    up = nrm[:, 1] > 0.5
    wall = np.abs(nrm[:, 1]) < 0.2
    print("up-facing", int(up.sum()), "wall-ish", int(wall.sum()))

    x0, x1, z0, z1 = -200.0, 150.0, 900.0, 1300.0
    inside = ((tris[:, :, 0].min(axis=1) < x1) & (tris[:, :, 0].max(axis=1) > x0)
              & (tris[:, :, 2].min(axis=1) < z1) & (tris[:, :, 2].max(axis=1) > z0))
    print("triangles in window", int(inside.sum()),
          "up", int((inside & up).sum()), "wall", int((inside & wall).sum()))

    # height samples on a 1 m grid by exact point-in-triangle for up-facing tris
    step = 1.0
    xs = np.arange(x0, x1 + step, step)
    zs = np.arange(z0, z1 + step, step)
    H = np.full((len(zs), len(xs)), np.nan)
    sub = tris[inside & up]
    for t in sub:
        a, b, c = t
        den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
        if abs(den) < 1e-12:
            continue
        i0 = max(0, int(math.floor((min(a[0], b[0], c[0]) - x0) / step)))
        i1 = min(len(xs) - 1, int(math.ceil((max(a[0], b[0], c[0]) - x0) / step)))
        j0 = max(0, int(math.floor((min(a[2], b[2], c[2]) - z0) / step)))
        j1 = min(len(zs) - 1, int(math.ceil((max(a[2], b[2], c[2]) - z0) / step)))
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
        Hs = H[j0:j1 + 1, i0:i1 + 1]
        Hs[m] = np.where(np.isnan(Hs[m]), h[m], np.maximum(Hs[m], h[m]))
    have = ~np.isnan(H)
    print("raster cells", H.size, "covered", int(have.sum()),
          "coverage %.3f" % (have.sum() / H.size))
    print("spawn cell height",
          H[int((1050 - z0) / step), int((-88 - x0) / step)])

    # print a coarse occupancy map every 5 m (up-facing surface present)
    print("\nmap: '#' surface present, '.' none; rows z, cols x, 5 m spacing")
    for j in range(0, len(zs), 5):
        row = []
        for i in range(0, len(xs), 5):
            row.append("#" if not np.isnan(H[j, i]) else ".")
        print("z=%7.1f %s" % (zs[j], "".join(row)))

    # spawn neighbourhood heights along +X (the 29 m straight) and +Z
    print("\n+X profile at z=1050 (1 m):")
    j = int((1050 - z0) / step)
    for i in range(int((-110 - x0) / step), int((-40 - x0) / step) + 1):
        print("  x=%7.1f h=%s" % (xs[i], "%.4f" % H[j, i] if not np.isnan(H[j, i]) else "None"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
