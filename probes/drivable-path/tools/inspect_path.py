#!/usr/bin/env python3
"""Inspect the generated path: shape, coarse map, endpoint barrier."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work/drivable-path"


def main():
    d = json.loads((OUT / "path.json").read_text())
    pts = d["course"]["points"]
    print("samples", len(pts), "length", d["course"]["length"], "end", d["course"]["end"])
    print("every 25 m:")
    acc = 0.0
    nxt = 0.0
    for k in range(1, len(pts)):
        acc += ((pts[k][0] - pts[k - 1][0]) ** 2 + (pts[k][1] - pts[k - 1][1]) ** 2) ** 0.5
        if acc >= nxt:
            print("  %7.1f m  (%8.2f, %8.2f)" % (acc, pts[k][0], pts[k][1]))
            nxt += 25.0
    g = np.load(OUT / "grid.npz")
    H = g["height"]; base = g["base_pass"]; comp = g["component"]; W = g["wall_oracle"]
    xs = g["xs"]; zs = g["zs"]
    print("grid", H.shape, "xs", xs[0], xs[-1], "zs", zs[0], zs[-1])
    # coarse map: . = base passable, c = component, W = oracle wall, blank = void
    print("\ncoarse map (2 m sampling): '.' base passable, 'o' oracle wall, ' ' void")
    for j in range(0, H.shape[0], 4):
        row = []
        for i in range(0, H.shape[1], 4):
            if base[j, i]:
                row.append("o" if W[j, i] else ".")
            elif W[j, i]:
                row.append("w")
            else:
                row.append(" ")
        print("z=%7.1f %s" % (zs[j], "".join(row)))
    # endpoint neighbourhood, 0.5 m cells
    end = d["course"]["end"]
    ei = int(round((end[0] - xs[0]) / 0.5)); ej = int(round((end[1] - zs[0]) / 0.5))
    print("\nendpoint neighbourhood (0.5 m): B=base pass, C=component, W=oracle wall, .=void")
    for j in range(ej - 20, ej + 21, 1):
        row = []
        for i in range(ei - 30, ei + 31, 1):
            if not (0 <= j < H.shape[0] and 0 <= i < H.shape[1]):
                row.append("?")
            elif comp[j, i]:
                row.append("C")
            elif base[j, i]:
                row.append("W" if W[j, i] else "B")
            elif W[j, i]:
                row.append("w")
            else:
                row.append(".")
        print("z=%7.1f %s" % (zs[j], "".join(row)))
    print("x range", xs[ei - 30], "..", xs[ei + 30])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
