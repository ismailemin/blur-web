#!/usr/bin/env python3
"""Deterministic top-down map of the river 310 m line vs the prop colliders."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work/river-path"
PATH_FILE = ROOT / "_work/drivable-path/path.json"
GRID_FILE = ROOT / "_work/drivable-path/grid.npz"

COLORS = {
    "C1": (235, 150, 40, 220),
    "C2": (220, 50, 50, 230),
    "C3": (50, 110, 220, 220),
    "C4": (150, 60, 190, 220),
    "other": (160, 160, 160, 170),
}


def main() -> int:
    path = json.loads(PATH_FILE.read_text(encoding="utf-8"))
    line = json.loads((OUT / "line.json").read_text(encoding="utf-8"))
    props = json.loads((OUT / "props.json").read_text(encoding="utf-8"))
    man = json.loads((ROOT / "_work/prop-collision/colliders.json").read_text(encoding="utf-8"))
    grid = np.load(GRID_FILE, allow_pickle=False)

    pts = np.array(path["course"]["points"], dtype=float)
    d = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    arc = np.concatenate([[0.0], np.cumsum(d)])
    xs, zs, bp = grid["xs"], grid["zs"], grid["base_pass"]

    x0, x1 = -135.0, 112.0
    z0, z1 = 1000.0, 1318.0
    scale = 4.0
    W = int((x1 - x0) * scale)
    H = int((z1 - z0) * scale)

    def px(x):
        return (x - x0) * scale

    def pz(z):
        return (z1 - z) * scale

    # drivable surface: build a 0.5 m-cell mask and upscale nearest-neighbour
    cw = int(round((x1 - x0) / 0.5))
    ch = int(round((z1 - z0) / 0.5))
    small = np.full((ch, cw, 3), 255, dtype=np.uint8)
    for j, z in enumerate(zs):
        if z < z0 or z > z1:
            continue
        jj = int(round((z1 - z) / 0.5))
        if jj < 0 or jj >= ch:
            continue
        for i, x in enumerate(xs):
            if x < x0 or x > x1 or not bp[j, i]:
                continue
            ii = int(round((x - x0) / 0.5))
            if 0 <= ii < cw:
                small[jj, ii] = (222, 242, 222)
    img = Image.fromarray(small, "RGB").resize((W, H), Image.NEAREST).convert("RGBA")
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    meta = {p["id"]: p for p in props["props"]}
    for c in man["colliders"]:
        m = meta[c["id"]]
        col = COLORS.get(m["cluster"], COLORS["other"])
        center = np.array(c["center"], dtype=float)
        ax = np.array(c["axes"], dtype=float)
        u = ax[0][[0, 2]]
        v = ax[2][[0, 2]]
        hu, hv = c["half"][0], c["half"][2]
        corners = [center[[0, 2]] + su * hu * u + sv * hv * v
                   for su, sv in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
        od.polygon([(px(q[0]), pz(q[1])) for q in corners], fill=col)
    img = Image.alpha_composite(img, overlay).convert("RGB")
    draw = ImageDraw.Draw(img)

    # original path (black) and corrected segments (green)
    draw.line([(px(x), pz(z)) for x, z in pts], fill=(0, 0, 0), width=2)
    for seg_name in ("S1", "S2"):
        seg = [s for s in line["samples"] if s["segment"] == seg_name]
        if seg:
            draw.line([(px(s["position"][0]), pz(s["position"][1])) for s in seg],
                      fill=(0, 160, 0), width=3)
    # blocked arc in red on the original line
    for b in line["correctedCourse"]["blockedArcs"]:
        if b["lengthM"] <= 0:
            continue
        seg = [p for p, a in zip(pts, arc) if b["arcStartM"] <= a <= b["arcEndM"]]
        if len(seg) >= 2:
            draw.line([(px(x), pz(z)) for x, z in seg], fill=(220, 0, 0), width=5)
    # start / finish
    draw.ellipse([px(pts[0][0]) - 6, pz(pts[0][1]) - 6, px(pts[0][0]) + 6, pz(pts[0][1]) + 6],
                 fill=(0, 70, 200), outline=(0, 0, 0))
    draw.rectangle([px(pts[-1][0]) - 6, pz(pts[-1][1]) - 6, px(pts[-1][0]) + 6, pz(pts[-1][1]) + 6],
                   fill=(0, 0, 0))
    # cluster labels
    for text, x, z, col in (
        ("C1 52.9-61.1", -52.0, 1094.0, (140, 80, 0)),
        ("C3 114.3-121.8", -12.0, 1132.0, (0, 60, 160)),
        ("C2 WALL 124.8-127.8", 4.0, 1148.0, (180, 0, 0)),
        ("C4 181.4-206.8", 34.0, 1206.0, (110, 20, 150)),
    ):
        draw.text((px(x), pz(z)), text, fill=col)
    # legend
    lx, ly = 12, 12
    draw.rectangle([lx - 6, ly - 6, lx + 360, ly + 150], fill=(255, 255, 255), outline=(0, 0, 0))
    rows = [
        ("drivable collision surface (base_pass)", (222, 242, 222)),
        ("C1 metal rack (52.9-61.1 m)", COLORS["C1"][:3]),
        ("C2 construction site (124.8-127.8 m)", COLORS["C2"][:3]),
        ("C3 concrete pipes (114.3-121.8 m)", COLORS["C3"][:3]),
        ("C4 metal rack (181.4-206.8 m)", COLORS["C4"][:3]),
        ("other prop colliders", COLORS["other"][:3]),
        ("original 310 m line", (0, 0, 0)),
        ("corrected free segments S1/S2", (0, 160, 0)),
        ("blocked arc (C2 site)", (220, 0, 0)),
    ]
    for k, (text, col) in enumerate(rows):
        y = ly + k * 15
        draw.rectangle([lx, y + 2, lx + 12, y + 12], fill=col, outline=(0, 0, 0))
        draw.text((lx + 18, y), text, fill=(0, 0, 0))
    sx, sy = 12, H - 28
    draw.line([sx, sy, sx + 20 * scale, sy], fill=(0, 0, 0), width=3)
    draw.text((sx, sy - 16), "20 m", fill=(0, 0, 0))
    draw.text((W - 250, H - 28), "visible-mesh props; not retail collision", fill=(0, 0, 0))
    out = OUT / "map.png"
    img.save(out, format="PNG", optimize=False)
    print("wrote", out, img.size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
