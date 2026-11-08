#!/usr/bin/env python3
"""Geodesic reach from the committed spawn to each candidate loop's start line.

A lap hand-off needs to know whether the loop is reachable from the committed
spawn without leaving the passable collision surface. The loops artifact already
says which component each loop is in; this measures the actual shortest path on
the 0.5 m passable raster (8-connected BFS with Euclidean edge weights) and
writes the distance and route length per loop.

    python probes/map-laps/tools/reach_map_loop.py --level usa_amboy
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import deque
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from map_laps_common import ROOT  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", required=True)
    ap.add_argument("--dir", type=Path)
    args = ap.parse_args(argv)
    base_dir = args.dir or (ROOT / "_work/map-laps" / args.level)
    doc = json.loads((base_dir / "loops.json").read_text(encoding="utf-8"))
    grid = np.load(base_dir / "grid.npz")
    base, xs, zs = grid["base"], grid["xs"], grid["zs"]
    cell = float(xs[1] - xs[0])
    nz, nx = base.shape

    spawn = doc["inputs"]["spawn"]
    sj = int(round((spawn["z"] - zs[0]) / cell))
    si = int(round((spawn["x"] - xs[0]) / cell))
    if not base[sj, si]:
        raise SystemExit("the spawn cell is not passable")

    dist = np.full((nz, nx), np.inf)
    dist[sj, si] = 0.0
    q = deque([(sj, si)])
    diag = cell * math.sqrt(2.0)
    while q:
        j, i = q.popleft()
        d0 = dist[j, i]
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                if dj == 0 and di == 0:
                    continue
                y, x = j + dj, i + di
                if y < 0 or y >= nz or x < 0 or x >= nx or not base[y, x]:
                    continue
                nd = d0 + (diag if dj and di else cell)
                if nd < dist[y, x] - 1e-12:
                    dist[y, x] = nd
                    q.append((y, x))

    loops = []
    for loop in doc["loops"]:
        x, z = loop["points"][0]
        i = int(round((x - xs[0]) / cell))
        j = int(round((z - zs[0]) / cell))
        d = float(dist[j, i])
        loops.append(dict(
            id=loop["id"], component=loop["component"],
            start=[x, z],
            reachable=bool(math.isfinite(d)),
            geodesicM=(round(d, 3) if math.isfinite(d) else None),
            straightLineM=round(math.hypot(x - spawn["x"], z - spawn["z"]), 3),
        ))

    out = dict(
        kind="map-laps.reach",
        version=1,
        level=args.level,
        inputs=dict(loopsHash=doc["hash"], spawn=spawn,
                    raster=dict(cell=cell, shape=[int(nz), int(nx)])),
        loops=loops,
        note="8-connected BFS on the P48 passable raster; a geometric shortest path, not a driven line",
    )
    body = json.dumps(out, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    out["hash"] = "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
    (base_dir / "reach.json").write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    for L in loops:
        print("%s comp %d reachable %s geodesic %s m straight %.3f m"
              % (L["id"], L["component"], L["reachable"], L["geodesicM"], L["straightLineM"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
