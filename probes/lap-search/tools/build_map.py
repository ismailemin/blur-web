#!/usr/bin/env python3
"""P61: top-down map of the measured laps (PNG + SVG).

Reads _work/lap-search/loops.json and grid.npz. Draws the relevant part of the
level with the passable mask, the loop components, the enclosed islands, the
measured loops, the committed spawn and the measured barrier. A zoom panel shows
the recommended loop.

All coordinates are level XZ metres (x right, z down). No draw geometry is used.

    python probes/lap-search/tools/build_map.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/lap-search/tools"))
from raster import label_components  # noqa: E402

OUT = ROOT / "_work/lap-search"
CELL = 0.5

C_BG = (255, 255, 255)
C_BASE = (214, 214, 214)
C_WALL = (90, 90, 90)
C_NOSURF = (246, 246, 246)
C_SPAWN = (176, 214, 242)
C_COMPS = {5: (198, 232, 190), 129: (250, 238, 170), 261: (224, 204, 238)}
C_ISLAND = (226, 120, 110)
C_LOOP = {0: (200, 30, 30), 1: (20, 70, 200), 2: (130, 40, 160)}
C_SPAWN_MARK = (240, 140, 0)
C_BARRIER = (210, 0, 160)


def font(size, bold=False):
    for name in (("arialbd.ttf" if bold else "arial.ttf"), "segoeui.ttf"):
        p = Path("C:/Windows/Fonts") / name
        if p.exists():
            try:
                return ImageFont.truetype(str(p), size)
            except OSError:
                pass
    return ImageFont.load_default()


def to_px(x, z, view):
    x0, x1, z0, z1, w, h = view
    return ((x - x0) / (x1 - x0) * w, (z - z0) / (z1 - z0) * h)


def main():
    doc = json.loads((OUT / "loops.json").read_text(encoding="utf-8"))
    d = np.load(OUT / "grid.npz")
    base = d["base"]
    wall = d["wall"]
    xs, zs = d["xs"], d["zs"]
    lab, sizes = label_components(base, conn=8)
    spawn_id = doc["spawnComponent"]["id"]
    comp_ids = {c["id"] for c in doc["loopComponents"]}
    blab, _ = label_components(~base, conn=4)
    islands = [blab == row["island"]["bgLabel"] for row in doc["islands"] if row["loop"]]

    rgb = np.empty((base.shape[0], base.shape[1], 3), dtype=np.uint8)
    rgb[:, :] = C_NOSURF
    rgb[base] = C_BASE
    rgb[wall] = C_WALL
    for cid, col in C_COMPS.items():
        if cid in comp_ids:
            rgb[lab == cid] = col
    if spawn_id:
        rgb[lab == spawn_id] = C_SPAWN
    for isl in islands:
        rgb[isl] = C_ISLAND
    full = Image.fromarray(rgb)

    # overview: spawn, loop-01, loop-02, loop-03 and the barrier
    V_OV = (-160.0, 1450.0, 790.0, 2210.0)
    ov_w = 1020
    ov_h = int(round((V_OV[3] - V_OV[2]) / (V_OV[1] - V_OV[0]) * ov_w))
    ov = full.resize((ov_w, ov_h), Image.BOX)
    view_ov = (V_OV[0], V_OV[1], V_OV[2], V_OV[3], ov_w, ov_h)

    best = next(q for q in doc["loops"] if q["id"] == doc["bestLoop"])
    bx = [p[0] for p in best["points"]]
    bz = [p[1] for p in best["points"]]
    V_Z = (min(bx) - 12, max(bx) + 12, min(bz) - 12, max(bz) + 12)
    z_w = 500
    z_h = int(round((V_Z[3] - V_Z[2]) / (V_Z[1] - V_Z[0]) * z_w))
    ix0 = int(round((V_Z[0] - xs[0]) / CELL))
    ix1 = int(round((V_Z[1] - xs[0]) / CELL))
    iz0 = int(round((V_Z[2] - zs[0]) / CELL))
    iz1 = int(round((V_Z[3] - zs[0]) / CELL))
    crop = full.crop((max(0, ix0), max(0, iz0),
                      min(rgb.shape[1], ix1), min(rgb.shape[0], iz1)))
    zoom = crop.resize((z_w, z_h), Image.NEAREST)
    view_z = (V_Z[0], V_Z[1], V_Z[2], V_Z[3], z_w, z_h)

    W, H = 1580, max(ov_h + 120, z_h + 300)
    canvas = Image.new("RGB", (W, H), C_BG)
    draw = ImageDraw.Draw(canvas)
    f_title = font(22, True)
    f_lab = font(14)
    f_small = font(12)
    draw.text((14, 10), "P61 USA LA River - collision-only lap search",
              fill=(20, 20, 20), font=f_title)
    draw.text((14, 40), "base passable 0.5 m raster; loops at 2.0 m (loop-01) / "
                       "1.5 m clearance; no draw geometry", fill=(70, 70, 70), font=f_small)

    ox, oy = 14, 70
    canvas.paste(ov, (ox, oy))
    d2 = ImageDraw.Draw(canvas)
    for loop in doc["loops"]:
        col = C_LOOP.get(loop["rank"] - 1, (200, 30, 30))
        pts = [(ox + px, oy + py) for px, py in
               (to_px(p[0], p[1], view_ov) for p in loop["points"])]
        d2.line(pts, fill=col, width=4 if loop["id"] == doc["bestLoop"] else 2,
                joint="curve")
    sx, sy = to_px(-88, 1050, view_ov)
    d2.ellipse([ox + sx - 6, oy + sy - 6, ox + sx + 6, oy + sy + 6],
               fill=C_SPAWN_MARK, outline=(80, 50, 0))
    d2.text((ox + sx + 10, oy + sy - 8), "spawn (-88, 1050)",
            fill=(120, 70, 0), font=f_small)
    b = next(c for c in doc["loopComponents"] if c["id"] == 5)["nearestToSpawn"]
    ax, az = b["fromWorld"]
    bxw, bzw = b["toWorld"]
    p1 = to_px(ax, az, view_ov)
    p2 = to_px(bxw, bzw, view_ov)
    d2.line([(ox + p1[0], oy + p1[1]), (ox + p2[0], oy + p2[1])],
            fill=C_BARRIER, width=3)
    d2.text((ox + p1[0] + 6, oy + p1[1] - 16),
            "1.118 m wall gap (comp 5 / spawn)", fill=C_BARRIER, font=f_small)
    for loop in doc["loops"]:
        px = sum(p[0] for p in loop["points"]) / len(loop["points"])
        pz = sum(p[1] for p in loop["points"]) / len(loop["points"])
        lx, ly = to_px(px, pz, view_ov)
        col = C_LOOP.get(loop["rank"] - 1, (0, 0, 0))
        d2.text((ox + lx + 8, oy + ly - 6), "%s %.1f m" % (loop["id"], loop["length"]),
                fill=col, font=f_lab)

    sb = 100.0 / (V_OV[1] - V_OV[0]) * ov_w
    y_sb = oy + ov_h - 18
    d2.line([(ox + 12, y_sb), (ox + 12 + sb, y_sb)], fill=(30, 30, 30), width=2)
    d2.text((ox + 12, y_sb - 16), "100 m", fill=(30, 30, 30), font=f_small)

    zx, zy = ox + ov_w + 30, oy + 30
    d2.text((zx, zy - 24), "zoom: %s (%.1f m, recommended)" % (best["id"], best["length"]),
            fill=(20, 20, 20), font=f_lab)
    canvas.paste(zoom, (zx, zy))
    for loop in doc["loops"]:
        if loop["id"] != best["id"]:
            continue
        pts = [(zx + px, zy + py) for px, py in
               (to_px(p[0], p[1], view_z) for p in loop["points"])]
        d2.line(pts, fill=C_LOOP.get(loop["rank"] - 1, (200, 30, 30)), width=3,
                joint="curve")
    sb2 = 10.0 / (V_Z[1] - V_Z[0]) * z_w
    y2 = zy + z_h - 14
    d2.line([(zx + 8, y2), (zx + 8 + sb2, y2)], fill=(30, 30, 30), width=2)
    d2.text((zx + 8, y2 - 14), "10 m", fill=(30, 30, 30), font=f_small)

    ly = zy + z_h + 16
    items = [
        (C_BASE, "passable collision surface"),
        (C_WALL, "steep collision face (wall mask)"),
        (C_SPAWN, "spawn component (no island)"),
        (C_ISLAND, "enclosed island (non-passable)"),
        (C_BARRIER, "measured barrier"),
    ]
    for i, (col, text) in enumerate(items):
        yy = ly + i * 18
        d2.rectangle([zx, yy + 3, zx + 12, yy + 13], fill=col, outline=(80, 80, 80))
        d2.text((zx + 18, yy), text, fill=(40, 40, 40), font=f_small)
    for i, loop in enumerate(doc["loops"]):
        yy = ly + (len(items) + i) * 18
        d2.rectangle([zx, yy + 3, zx + 12, yy + 13],
                     fill=C_LOOP.get(loop["rank"] - 1), outline=(80, 80, 80))
        d2.text((zx + 18, yy), "%s %.1f m%s" % (
            loop["id"], loop["length"],
            " (recommended)" if loop["id"] == doc["bestLoop"] else ""),
            fill=(40, 40, 40), font=f_small)

    canvas.save(OUT / "loops.png")

    # ---------------- SVG schematic ----------------
    def svg_path(loop, view, ox, oy):
        pts = [to_px(p[0], p[1], view) for p in loop["points"]]
        return "M " + " L ".join("%.1f %.1f" % (ox + x, oy + y) for x, y in pts) + " Z"

    def coarse_rects(mask, view, ox, oy, step):
        x0, x1, z0, z1, w, h = view
        out = []
        nx = int((x1 - x0) / step)
        nz = int((z1 - z0) / step)
        for j in range(nz):
            for i in range(nx):
                xa = x0 + i * step
                za = z0 + j * step
                ia = int(round((xa - xs[0]) / CELL))
                ib = int(round((xa + step - xs[0]) / CELL))
                ja = int(round((za - zs[0]) / CELL))
                jb = int(round((za + step - zs[0]) / CELL))
                sub = mask[max(0, ja):min(mask.shape[0], jb),
                           max(0, ia):min(mask.shape[1], ib)]
                if sub.size and sub.mean() > 0.5:
                    px0, py0 = to_px(xa, za, view)
                    px1, py1 = to_px(xa + step, za + step, view)
                    out.append("<rect x='%.1f' y='%.1f' width='%.1f' height='%.1f'/>"
                               % (ox + px0, oy + py0,
                                  max(0.6, px1 - px0), max(0.6, py1 - py0)))
        return "".join(out)

    svg = []
    svg.append("<svg xmlns='http://www.w3.org/2000/svg' width='%d' height='%d' "
               "viewBox='0 0 %d %d'>" % (W, H, W, H))
    svg.append("<rect width='100%' height='100%' fill='white'/>")
    svg.append("<text x='14' y='30' font-family='Segoe UI,Arial' font-size='22' "
               "font-weight='bold'>P61 USA LA River - collision-only lap search</text>")
    svg.append("<text x='14' y='52' font-family='Segoe UI,Arial' font-size='12' "
               "fill='#444'>base passable 0.5 m raster; loops at 2.0 m (loop-01) / "
               "1.5 m clearance; no draw geometry</text>")
    svg.append("<g fill='#d6d6d6'>%s</g>" % coarse_rects(base, view_ov, ox, oy, 8.0))
    svg.append("<g fill='#5a5a5a'>%s</g>" % coarse_rects(wall, view_ov, ox, oy, 8.0))
    for isl in islands:
        svg.append("<g fill='#e2786e'>%s</g>" % coarse_rects(isl, view_ov, ox, oy, 4.0))
    for loop in doc["loops"]:
        col = "#%02x%02x%02x" % C_LOOP.get(loop["rank"] - 1, (200, 30, 30))
        svg.append("<path d='%s' fill='none' stroke='%s' stroke-width='%d'/>"
                   % (svg_path(loop, view_ov, ox, oy), col,
                      4 if loop["id"] == doc["bestLoop"] else 2))
    sx, sy = to_px(-88, 1050, view_ov)
    svg.append("<circle cx='%.1f' cy='%.1f' r='6' fill='#f08c00' stroke='#503200'/>"
               % (ox + sx, oy + sy))
    svg.append("<text x='%.1f' y='%.1f' font-family='Segoe UI,Arial' font-size='12' "
               "fill='#784600'>spawn (-88, 1050)</text>" % (ox + sx + 10, oy + sy - 8))
    p1 = to_px(ax, az, view_ov)
    p2 = to_px(bxw, bzw, view_ov)
    svg.append("<line x1='%.1f' y1='%.1f' x2='%.1f' y2='%.1f' stroke='#d200a0' "
               "stroke-width='2'/>" % (ox + p1[0], oy + p1[1], ox + p2[0], oy + p2[1]))
    svg.append("<text x='%.1f' y='%.1f' font-family='Segoe UI,Arial' font-size='12' "
               "fill='#d200a0'>1.118 m wall gap (comp 5 / spawn)</text>"
               % (ox + p1[0] + 6, oy + p1[1] - 16))
    for loop in doc["loops"]:
        px = sum(p[0] for p in loop["points"]) / len(loop["points"])
        pz = sum(p[1] for p in loop["points"]) / len(loop["points"])
        lx, ly = to_px(px, pz, view_ov)
        col = "#%02x%02x%02x" % C_LOOP.get(loop["rank"] - 1, (0, 0, 0))
        svg.append("<text x='%.1f' y='%.1f' font-family='Segoe UI,Arial' "
                   "font-size='13' fill='%s'>%s %.1f m</text>"
                   % (ox + lx + 8, oy + ly - 6, col, loop["id"], loop["length"]))
    svg.append("<g>")
    svg.append("<rect x='%d' y='%d' width='%d' height='%d' fill='white' "
               "stroke='#888'/>" % (zx, zy, z_w, z_h))
    svg.append("<g fill='#d6d6d6'>%s</g>" % coarse_rects(base, view_z, zx, zy, 1.0))
    svg.append("<g fill='#5a5a5a'>%s</g>" % coarse_rects(wall, view_z, zx, zy, 1.0))
    for isl in islands:
        svg.append("<g fill='#e2786e'>%s</g>" % coarse_rects(isl, view_z, zx, zy, 1.0))
    svg.append("<path d='%s' fill='none' stroke='#c81e1e' stroke-width='3'/>"
               % svg_path(best, view_z, zx, zy))
    svg.append("<text x='%d' y='%d' font-family='Segoe UI,Arial' font-size='14'>"
               "zoom: %s (%.1f m, recommended)</text>"
               % (zx, zy - 8, best["id"], best["length"]))
    svg.append("</g>")
    svg.append("</svg>")
    (OUT / "loops.svg").write_text("\n".join(svg), encoding="utf-8")
    print("wrote", OUT / "loops.png", "and", OUT / "loops.svg")


if __name__ == "__main__":
    main()
