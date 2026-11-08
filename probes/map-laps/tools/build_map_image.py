#!/usr/bin/env python3
"""Top-down diagnostic map for the map-lap probe (PNG + SVG).

Left: the whole level at 2 m per pixel - passable collision surface in grey,
steep/wall cells in dark violet, the measured point-to-point path in blue, every
candidate loop in a distinct colour, the recommended loop in red with its start
marker. Right: the recommended loop zoomed at 0.5 m per pixel.

This is a data diagnostic, not a renderer frame: no draw geometry, material,
texture or GPU state is read.

    python probes/map-laps/tools/build_map_image.py --level usa_amboy
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from map_laps_common import ROOT  # noqa: E402

LOOP_COLOURS = [(60, 60, 220), (0, 150, 90), (200, 120, 0), (150, 0, 150),
                (0, 150, 180), (120, 120, 0), (200, 60, 120), (90, 90, 90)]


def world_to_px(x, z, xs, zs, cell, scale, origin):
    i = (x - xs[0]) / cell
    j = (z - zs[0]) / cell
    return (int(round(origin[0] + i * scale)), int(round(origin[1] + j * scale)))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", required=True)
    ap.add_argument("--dir", type=Path)
    args = ap.parse_args(argv)
    base_dir = args.dir or (ROOT / "_work/map-laps" / args.level)
    doc = json.loads((base_dir / "loops.json").read_text(encoding="utf-8"))
    grid = np.load(base_dir / "grid.npz")
    base, wall = grid["base"], grid["wall"]
    H, xs, zs = grid["height"], grid["xs"], grid["zs"]
    cell = float(xs[1] - xs[0])
    path = json.loads((ROOT / doc["inputs"]["pathDoc"]["path"]).read_text())

    step = 4                                     # 2 m per pixel on the overview
    sub_base = base[::step, ::step]
    sub_wall = wall[::step, ::step]
    hz, hx = sub_base.shape
    scale = 1.0 / step * cell

    overview = Image.new("RGB", (hx, hz), (12, 12, 16))
    px = overview.load()
    for j in range(hz):
        for i in range(hx):
            if sub_wall[j, i]:
                px[i, j] = (96, 70, 140)
            elif sub_base[j, i]:
                px[i, j] = (150, 150, 150)
    draw = ImageDraw.Draw(overview)

    def o(x, z):
        return world_to_px(x, z, xs, zs, cell, scale, (0, 0))

    pts = [(p["x"], p["z"]) for p in path["samples"]]
    draw.line([o(x, z) for x, z in pts], fill=(70, 130, 255), width=1)

    best = doc.get("bestLoop")
    for n, loop in enumerate(doc["loops"]):
        colour = LOOP_COLOURS[n % len(LOOP_COLOURS)]
        if loop["id"] == best:
            colour = (255, 40, 40)
        draw.line([o(x, z) for x, z in loop["points"]], fill=colour, width=2 if loop["id"] == best else 1)
    if best:
        bl = next(q for q in doc["loops"] if q["id"] == best)
        sx, sz = bl["points"][0]
        px0 = o(sx, sz)
        draw.ellipse([px0[0] - 4, px0[1] - 4, px0[0] + 4, px0[1] + 4],
                     fill=(255, 255, 255), outline=(0, 0, 0))
    sp = doc["inputs"]["spawn"]
    s0 = o(sp["x"], sp["z"])
    draw.rectangle([s0[0] - 3, s0[1] - 3, s0[0] + 3, s0[1] + 3], fill=(0, 255, 255))
    draw.text((6, 6), "%s  loops=%d  best=%s" % (args.level, len(doc["loops"]), best),
              fill=(255, 255, 255))

    # zoom on the best loop
    if best:
        bl = next(q for q in doc["loops"] if q["id"] == best)
        lp = np.array(bl["points"])
        x0, x1 = lp[:, 0].min() - 20, lp[:, 0].max() + 20
        z0, z1 = lp[:, 1].min() - 20, lp[:, 1].max() + 20
        i0 = max(0, int((x0 - xs[0]) / cell)); i1 = min(base.shape[1], int((x1 - xs[0]) / cell))
        j0 = max(0, int((z0 - zs[0]) / cell)); j1 = min(base.shape[0], int((z1 - zs[0]) / cell))
        sb = base[j0:j1, i0:i1]
        sw = wall[j0:j1, i0:i1]
        sh = H[j0:j1, i0:i1]
        zoom = Image.new("RGB", (i1 - i0, j1 - j0), (12, 12, 16))
        zp = zoom.load()
        finite = np.isfinite(sh)
        hmin = float(np.nanmin(sh)) if finite.any() else 0.0
        hmax = float(np.nanmax(sh)) if finite.any() else 1.0
        for j in range(zoom.height):
            for i in range(zoom.width):
                if sw[j, i]:
                    zp[i, j] = (120, 90, 170)
                elif sb[j, i]:
                    v = int(90 + 120 * ((sh[j, i] - hmin) / (hmax - hmin + 1e-9)))
                    zp[i, j] = (v, v, v)
        zd = ImageDraw.Draw(zoom)
        zd.line([((x - xs[0]) / cell - i0, (z - zs[0]) / cell - j0) for x, z in bl["points"]],
                fill=(255, 40, 40), width=1)
        sx, sz = bl["points"][0]
        zx = (sx - xs[0]) / cell - i0
        zz = (sz - zs[0]) / cell - j0
        zd.ellipse([zx - 3, zz - 3, zx + 3, zz + 3], fill=(255, 255, 255))
        zd.text((5, 5), "%s  %.3f m" % (bl["id"], bl["length"]), fill=(255, 255, 255))

        total_w = overview.width + zoom.width + 8
        total_h = max(overview.height, zoom.height)
        out = Image.new("RGB", (total_w, total_h), (0, 0, 0))
        out.paste(overview, (0, 0))
        out.paste(zoom, (overview.width + 8, 0))
    else:
        out = overview

    out.save(base_dir / "map.png")
    print("wrote", base_dir / "map.png", out.size)

    # vector schematic of the same content (loops + path only)
    def s(x, z):
        return "%.1f,%.1f" % (x, -z)

    w = abs(xs[-1] - xs[0]); h = abs(zs[-1] - zs[0])
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="%.1f %.1f %.1f %.1f">'
             % (xs[0], -zs[-1], w, h),
             '<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="#0c0c10"/>'
             % (xs[0], -zs[-1], w, h)]
    parts.append('<polyline fill="none" stroke="#4682ff" stroke-width="1.5" points="%s"/>'
                 % " ".join(s(x, z) for x, z in pts[::3]))
    for n, loop in enumerate(doc["loops"]):
        c = "#ff2828" if loop["id"] == best else "#%02x%02x%02x" % LOOP_COLOURS[n % len(LOOP_COLOURS)]
        parts.append('<polyline fill="none" stroke="%s" stroke-width="%s" points="%s"/>'
                     % (c, "2" if loop["id"] == best else "1",
                        " ".join(s(x, z) for x, z in loop["points"][::2])))
    parts.append("</svg>")
    (base_dir / "map.svg").write_text("\n".join(parts) + "\n", encoding="utf-8")
    print("wrote", base_dir / "map.svg")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
