#!/usr/bin/env python3
"""Focused map of the spawn junction: is the southern branch walled off?"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work/drivable-path"


def main():
    g = np.load(OUT / "grid.npz")
    H = g["height"]; base = g["base_pass"]; comp = g["component"]; W = g["wall_oracle"]
    xs = g["xs"]; zs = g["zs"]
    i0 = int(round((-100 - xs[0]) / 0.5)); i1 = int(round((-72 - xs[0]) / 0.5))
    j0 = int(round((1028 - zs[0]) / 0.5)); j1 = int(round((1062 - zs[0]) / 0.5))
    print("legend: C component, B base passable, w oracle wall, . void   x %.1f..%.1f z %.1f..%.1f"
          % (xs[i0], xs[i1], zs[j0], zs[j1]))
    for j in range(j0, j1 + 1, 2):
        row = []
        for i in range(i0, i1 + 1, 2):
            if comp[j, i]:
                row.append("C")
            elif base[j, i]:
                row.append("B")
            elif W[j, i]:
                row.append("w")
            else:
                row.append(".")
        print("z=%7.1f %s" % (zs[j], "".join(row)))
    print("x ticks every 2 cells = 1 m, from", xs[i0], "to", xs[i1])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
