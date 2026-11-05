#!/usr/bin/env python3
"""P61: locate the island component, the spawn component, and the barrier between."""
from __future__ import annotations

import sys
from collections import deque
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/lap-search/tools"))
from raster import label_components, enclosed_islands  # noqa: E402

CELL = 0.5
SPAWN = (-88.0, 1050.0)


def main():
    z = np.load(ROOT / "_work/lap-search/_full05.npz")
    base = z["base"]
    xs, zs = z["xs"], z["zs"]
    lab, sizes = label_components(base, conn=8)
    sj = int(round((SPAWN[1] - zs[0]) / CELL))
    si = int(round((SPAWN[0] - xs[0]) / CELL))
    sid = int(lab[sj, si])
    isl = enclosed_islands(base, lab)
    print("spawn comp", sid, "cells", sizes[sid - 1])
    for h in isl[:4]:
        print("island", h["size"], "owner", h["owner"], "bbox", h["bbox"], "centroid", h["centroid"])

    # component bboxes
    for cid in sorted({sid, isl[0]["owner"], isl[1]["owner"]}):
        jj, ii = np.where(lab == cid)
        print("comp %d cells %d bbox x %.1f..%.1f z %.1f..%.1f"
              % (cid, sizes[cid - 1], xs[ii.min()], xs[ii.max()], zs[jj.min()], zs[jj.max()]))

    # nearest pair between spawn comp and island component (boundary cells only)
    other = isl[0]["owner"]

    def boundary(cid):
        m = lab == cid
        p = np.pad(m, 1, constant_values=False)
        inner = (p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1]
                 & p[1:-1, :-2] & p[1:-1, 2:])
        return np.argwhere(m & ~inner)

    A = boundary(sid)
    B = boundary(other)
    print("boundary cells", len(A), len(B))
    best = (1e18, None, None)
    for k0 in range(0, len(A), 400):
        chunk = A[k0:k0 + 400].astype(np.float64)
        d2 = ((chunk[:, None, 0] - B[None, :, 0].astype(np.float64)) ** 2
              + (chunk[:, None, 1] - B[None, :, 1].astype(np.float64)) ** 2)
        idx = np.unravel_index(np.argmin(d2), d2.shape)
        if d2[idx] < best[0]:
            best = (d2[idx], A[k0 + idx[0]], B[idx[1]])
    d, a, b = best
    a = tuple(int(v) for v in a)
    b = tuple(int(v) for v in b)
    print("nearest spawn<->island comp gap %.3f m at %s %s world %s %s"
          % (np.sqrt(d) * CELL, a, b,
             (float(xs[a[1]]), float(zs[a[0]])), (float(xs[b[1]]), float(zs[b[0]]))))


if __name__ == "__main__":
    main()
