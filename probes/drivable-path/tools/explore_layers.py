#!/usr/bin/env python3
"""Second measurement pass: height layers and wall faces near the spawn band.

    python probes/drivable-path/tools/explore_layers.py
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


def heights_at(tris, nrm, x, z, min_ny=0.1):
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    den = (b[:, 2] - c[:, 2]) * (a[:, 0] - c[:, 0]) + (c[:, 0] - b[:, 0]) * (a[:, 2] - c[:, 2])
    ok = np.abs(den) > 1e-12
    l1 = np.where(ok, ((b[:, 2] - c[:, 2]) * (x - c[:, 0]) + (c[:, 0] - b[:, 0]) * (z - c[:, 2])) / np.where(ok, den, 1), -1)
    l2 = np.where(ok, ((c[:, 2] - a[:, 2]) * (x - c[:, 0]) + (a[:, 0] - c[:, 0]) * (z - c[:, 2])) / np.where(ok, den, 1), -1)
    l3 = 1.0 - l1 - l2
    m = ok & (l1 >= -1e-9) & (l2 >= -1e-9) & (l3 >= -1e-9) & (nrm[:, 1] > min_ny)
    h = l1 * a[:, 1] + l2 * b[:, 1] + l3 * c[:, 1]
    return np.sort(h[m])


def main():
    level = oracle.load_level(PHYSICS.read_bytes())
    tris = flatten(level)
    nrm = normals(tris)
    up = nrm[:, 1] > 0.5
    wall = np.abs(nrm[:, 1]) < 0.2

    # Wall triangles in the spawn window: group by rounded centroid and report
    x0, x1, z0, z1 = -160.0, 120.0, 900.0, 1350.0
    cen = tris.mean(axis=1)
    win = ((cen[:, 0] > x0) & (cen[:, 0] < x1) & (cen[:, 2] > z0) & (cen[:, 2] < z1))
    wid = np.where(win & wall)[0]
    print("wall triangles in window:", len(wid))
    # vertical extent and centroid; print the biggest 30 by vertical extent
    ext = tris[wid, :, 1].max(axis=1) - tris[wid, :, 1].min(axis=1)
    order = np.argsort(-ext)[:30]
    for k in order:
        i = wid[k]
        t = tris[i]
        print("  wall tri %6d extent %6.2f  x %8.2f..%8.2f  y %7.2f..%7.2f  z %8.2f..%8.2f  ny %.3f"
              % (i, ext[k], t[:, 0].min(), t[:, 0].max(), t[:, 1].min(), t[:, 1].max(),
                 t[:, 2].min(), t[:, 2].max(), nrm[i, 1]))

    print("\nheight layers along x at z=1050 (up-facing, ny>0.5):")
    for x in range(-115, 75, 5):
        h = heights_at(tris, nrm, float(x), 1050.0, 0.5)
        if len(h):
            print("  x=%5d  %s" % (x, " ".join("%.3f" % v for v in h)))
        else:
            print("  x=%5d  -" % x)

    print("\nheight layers along z at x=-88:")
    for z in range(960, 1320, 10):
        h = heights_at(tris, nrm, -88.0, float(z), 0.5)
        print("  z=%5d  %s" % (z, " ".join("%.3f" % v for v in h) if len(h) else "-"))

    print("\nmax up-facing height along x at z=1050 (1 m), and min/max wall y crossing:")
    for x in range(-110, 71, 2):
        h = heights_at(tris, nrm, float(x), 1050.0, 0.5)
        print("  x=%5d  maxh=%s" % (x, "%.4f" % h[-1] if len(h) else "None"))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
