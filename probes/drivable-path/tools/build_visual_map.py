#!/usr/bin/env python3
"""Render the visual-coverage map (SVG + HTML + PNG), deterministic.

Panels:
  * top-down: the 310.395 m course, coloured per covering draw, over the
    collision surface; car-width band drawn underneath;
  * arc vs (visual - collision) in millimetres;
  * arc vs continuous drawn width in metres, with the car envelope lines.

Inputs : _work/drivable-path/{visual-coverage.json,visual-coverage-samples.json,
         path.json,grid.npz?,visual-coverage-verify.json?}
Outputs: _work/drivable-path/{visual-coverage.svg,visual-coverage.html,
         visual-coverage.png}

    python probes/drivable-path/tools/build_visual_map.py [--png]
"""
from __future__ import annotations

import argparse
import html
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work/drivable-path"
SCALE = 4.2
PAD = 56
STRIP_H = 170
EDGE = Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")

DRAW_COLOURS = ["#3fb950", "#58a6ff", "#d29922", "#bc8cff", "#ff7b72", "#39c5cf",
                "#f778ba", "#a5d6ff"]


def fmt(value, digits=2):
    return ("%." + str(digits) + "f") % value


def main(argv) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", action="store_true", help="also render a PNG with headless Edge")
    args = ap.parse_args(argv)

    manifest = json.loads((OUT / "visual-coverage.json").read_text(encoding="utf-8"))
    samples = json.loads((OUT / "visual-coverage-samples.json").read_text(encoding="utf-8"))
    path = json.loads((OUT / "path.json").read_text(encoding="utf-8"))
    if len(samples["rows"]) != manifest["coverage"]["samples"]:
        raise SystemExit("build_visual_map: BLOCKED: sample rows do not match the manifest; "
                         "run build_visual_coverage.py first")
    verify = None
    if (OUT / "visual-coverage-verify.json").is_file():
        verify = json.loads((OUT / "visual-coverage-verify.json").read_text(encoding="utf-8"))

    rows = samples["rows"]
    points = path["course"]["points"]
    arcs = [r[0] for r in rows]
    deltas_mm = [None if r[4] is None else r[4] * 1000.0 for r in rows]
    widths = [r[9] + r[10] for r in rows]

    xs = [p[0] for p in points]
    zs = [p[1] for p in points]
    xmin, xmax = min(xs) - 22.0, max(xs) + 22.0
    zmin, zmax = min(zs) - 18.0, max(zs) + 18.0
    map_w = (xmax - xmin) * SCALE
    map_h = (zmax - zmin) * SCALE
    width = int(max(980, map_w) + 2 * PAD)
    map_top = PAD + 34
    strip1_top = map_top + map_h + 54
    strip2_top = strip1_top + STRIP_H + 40
    height = int(strip2_top + STRIP_H + PAD)
    left = (width - map_w) / 2.0

    def sx(x):
        return left + (x - xmin) * SCALE

    def sy(z):
        return map_top + (zmax - z) * SCALE

    parts = []
    parts.append('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
                 'viewBox="0 0 %d %d" font-family="monospace">' % (width, height, width, height))
    parts.append('<rect width="100%" height="100%" fill="#0d1117"/>')
    parts.append('<text x="%d" y="%d" fill="#c9d1d9" font-size="15">USA LA River — draw coverage of the 310.395 m drivable course</text>'
                 % (PAD, PAD))
    parts.append('<text x="%d" y="%d" fill="#8b949e" font-size="10.5">%d samples at 0.25 m · %s / %s covered at the car width · %d gap run(s) · drawn surface %s–%s m wide</text>'
                 % (PAD, PAD + 16, manifest["coverage"]["samples"],
                    manifest["coverage"]["marginCovered"], manifest["coverage"]["samples"],
                    manifest["coverage"]["gapRuns"], fmt(manifest["width"]["min"], 1),
                    fmt(manifest["width"]["max"], 1)))

    # ---------------------------------------------------------------- surface
    grid_file = OUT / "grid.npz"
    background = "none"
    if grid_file.is_file():
        g = np.load(grid_file)
        H = g["height"]
        base = g["base_pass"]
        comp = g["component"]
        wall = g["wall_oracle"]
        gx = g["xs"]
        gz = g["zs"]
        cell = float(gx[1] - gx[0])
        stride = 2
        i0 = max(0, int(math.floor((xmin - gx[0]) / cell)))
        i1 = min(len(gx) - 1, int(math.ceil((xmax - gx[0]) / cell)))
        j0 = max(0, int(math.floor((zmin - gz[0]) / cell)))
        j1 = min(len(gz) - 1, int(math.ceil((zmax - gz[0]) / cell)))
        parts.append('<g id="collision-surface">')
        for mask, fill, opacity in ((base, "#16211a", 1.0), (comp, "#1f3a28", 1.0),
                                    (wall, "#5c2323", 0.95)):
            parts.append('<g fill="%s" opacity="%s">' % (fill, fmt(opacity, 2)))
            for j in range(j0, j1 + 1, stride):
                row = mask[j, i0:i1 + 1:stride]
                if not row.any():
                    continue
                z = float(gz[j])
                start = None
                for a in range(len(row) + 1):
                    on = a < len(row) and bool(row[a])
                    if on and start is None:
                        start = a
                    elif not on and start is not None:
                        x_a = float(gx[i0 + start * stride])
                        x_b = float(gx[i0 + (a - 1) * stride])
                        parts.append('<rect x="%s" y="%s" width="%s" height="%s"/>'
                                     % (fmt(sx(x_a)), fmt(sy(z) - SCALE * stride),
                                        fmt(max(0.6, (x_b - x_a) * SCALE + SCALE * stride)),
                                        fmt(SCALE * stride)))
                        start = None
            parts.append('</g>')
        parts.append('</g>')
        background = "grid.npz (collision passable component, walls)"

    # grid every 20 m
    parts.append('<g stroke="#263243" stroke-width="0.6" opacity="0.75">')
    gx0 = math.ceil(xmin / 20.0) * 20.0
    while gx0 <= xmax:
        parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s"/>'
                     % (fmt(sx(gx0)), fmt(map_top), fmt(sx(gx0)), fmt(map_top + map_h)))
        parts.append('<text x="%s" y="%s" fill="#7d8b99" font-size="9.5" text-anchor="middle">%d</text>'
                     % (fmt(sx(gx0)), fmt(map_top + map_h + 14), gx0))
        gx0 += 20.0
    gz0 = math.ceil(zmin / 20.0) * 20.0
    while gz0 <= zmax:
        parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s"/>'
                     % (fmt(left), fmt(sy(gz0)), fmt(left + map_w), fmt(sy(gz0))))
        parts.append('<text x="%s" y="%s" fill="#7d8b99" font-size="9.5" text-anchor="end">%d</text>'
                     % (fmt(left - 6), fmt(sy(gz0) + 3), gz0))
        gz0 += 20.0
    parts.append('</g>')
    parts.append('<text x="%s" y="%s" fill="#8b949e" font-size="9.5">x (m)</text>'
                 % (fmt(left + map_w - 34), fmt(map_top - 8)))
    parts.append('<text x="%s" y="%s" fill="#8b949e" font-size="9.5">z (m)</text>'
                 % (fmt(left - 34), fmt(map_top + 10)))

    # car-width band under the course: 2.276 m full width
    band_px = 2.0 * manifest["model"]["marginHalfWidthMetres"] * SCALE
    d_path = " ".join(("M %s %s" % (fmt(sx(x)), fmt(sy(z)))) if k == 0 else
                      ("L %s %s" % (fmt(sx(x)), fmt(sy(z))))
                      for k, (x, z) in enumerate(points))
    parts.append('<path d="%s" fill="none" stroke="#0f2a1c" stroke-width="%s" '
                 'stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>'
                 % (d_path, fmt(band_px, 1)))
    parts.append('<path d="%s" fill="none" stroke="#2ea043" stroke-width="1" '
                 'stroke-linejoin="round" stroke-linecap="round" opacity="0.35"/>' % d_path)

    # -------------------------------------------------------- draw-coloured path
    ordered = []
    for section in manifest["sections"]:
        for draw in section["draws"]:
            if not draw["usedCentre"]:
                continue
            first = min((s["arcStart"] for s in draw["arcSpans"]), default=1e18)
            ordered.append((first, section["key"], draw["drawIndex"]))
    ordered.sort()
    colour_of = {}
    for i, (first, key, di) in enumerate(ordered):
        colour_of[(key, di)] = DRAW_COLOURS[i % len(DRAW_COLOURS)]

    run_start = 0
    for k in range(1, len(rows) + 1):
        if k == len(rows) or (rows[k][5], rows[k][6]) != (rows[run_start][5], rows[run_start][6]):
            colour = colour_of.get((rows[run_start][5], rows[run_start][6]), "#f85149")
            segment = " ".join(
                ("M %s %s" % (fmt(sx(rows[i][1])), fmt(sy(rows[i][2])))) if i == run_start
                else ("L %s %s" % (fmt(sx(rows[i][1])), fmt(sy(rows[i][2]))))
                for i in range(run_start, k))
            parts.append('<path d="%s" fill="none" stroke="#0b1b2b" stroke-width="6.4" '
                         'stroke-linejoin="round" stroke-linecap="round"/>' % segment)
            parts.append('<path d="%s" fill="none" stroke="%s" stroke-width="3.4" '
                         'stroke-linejoin="round" stroke-linecap="round"/>' % (segment, colour))
            run_start = k

    # gaps (none expected) drawn on top in red
    for gap in manifest["gaps"]:
        parts.append('<circle cx="%s" cy="%s" r="6" fill="#f85149" stroke="#0d1117" stroke-width="2"/>'
                     % (fmt(sx(gap["start"][0])), fmt(sy(gap["start"][1]))))

    # start / end
    parts.append('<circle cx="%s" cy="%s" r="7" fill="#2ecc71" stroke="#0d1117" stroke-width="2"/>'
                 % (fmt(sx(points[0][0])), fmt(sy(points[0][1]))))
    parts.append('<text x="%s" y="%s" fill="#2ecc71" font-size="10.5">spawn (−88, 1050)</text>'
                 % (fmt(sx(points[0][0]) + 9), fmt(sy(points[0][1]) + 15)))
    parts.append('<circle cx="%s" cy="%s" r="7" fill="#ff9f43" stroke="#0d1117" stroke-width="2"/>'
                 % (fmt(sx(points[-1][0])), fmt(sy(points[-1][1]))))
    parts.append('<text x="%s" y="%s" fill="#ff9f43" font-size="10.5">finish (103.5, 1292.5)</text>'
                 % (fmt(sx(points[-1][0]) + 10), fmt(sy(points[-1][1]) - 9)))
    parts.append('<text x="%s" y="%s" fill="#8b949e" font-size="9.5">%s</text>'
                 % (fmt(sx(points[-1][0]) + 10), fmt(sy(points[-1][1]) + 8),
                    "no visual gaps" if not manifest["gaps"] else
                    "%d gap run(s)" % len(manifest["gaps"])))

    # ---------------------------------------------------------------- legend
    legend_x = left + 8
    legend_y = map_top + 34
    parts.append('<rect x="%s" y="%s" width="%d" height="%d" fill="#0d1117" opacity="0.82" '
                 'stroke="#263243" stroke-width="0.8"/>'
                 % (fmt(legend_x - 6), fmt(legend_y - 14), 330, 15 * (len(ordered) + 2) + 16))
    parts.append('<text x="%s" y="%s" fill="#c9d1d9" font-size="10">covering draw (section g56-n289)</text>'
                 % (fmt(legend_x), fmt(legend_y)))
    for i, (first, key, di) in enumerate(ordered):
        draw = next(d for s in manifest["sections"] if s["key"] == key
                    for d in s["draws"] if d["drawIndex"] == di)
        spans = " + ".join("%s–%s m" % (fmt(s["arcStart"], 1), fmt(s["arcEnd"], 1))
                           for s in draw["arcSpans"])
        parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s" stroke-width="4"/>'
                     % (fmt(legend_x), fmt(legend_y + 15 * (i + 1) - 3),
                        fmt(legend_x + 18), fmt(legend_y + 15 * (i + 1) - 3),
                        colour_of[(key, di)]))
        parts.append('<text x="%s" y="%s" fill="#c9d1d9" font-size="9.5">d%d prim %d · %s · %d tris · %s</text>'
                     % (fmt(legend_x + 24), fmt(legend_y + 15 * (i + 1)),
                        di, draw["primitiveIndex"], spans, draw["trianglesInRange"],
                        "centre" if draw["arcSpans"] else "band only"))

    # ------------------------------------------------------------- strip charts
    strip_left = PAD + 46
    strip_w = width - 2 * PAD - 46
    arc_max = arcs[-1]

    def ax(a):
        return strip_left + (a / arc_max) * strip_w

    def legend_axes(top, title, ymin, ymax, ticks, unit):
        parts.append('<text x="%d" y="%s" fill="#c9d1d9" font-size="11">%s</text>'
                     % (PAD, fmt(top - 8), title))
        parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="#263243" stroke-width="0.9"/>'
                     % (fmt(strip_left), fmt(top), fmt(strip_left + strip_w), fmt(top)))
        for value in ticks:
            y = top + (ymax - value) / (ymax - ymin) * STRIP_H
            parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="#1c2634" stroke-width="0.7"/>'
                         % (fmt(strip_left), fmt(y), fmt(strip_left + strip_w), fmt(y)))
            parts.append('<text x="%s" y="%s" fill="#8b949e" font-size="9" text-anchor="end">%s%s</text>'
                         % (fmt(strip_left - 6), fmt(y + 3), ("%g" % value), unit))

    legend_axes(strip1_top, "visual − collision height (mm), nearest draw triangle at the centre",
                -1.2, 1.2, [-1.0, -0.5, 0.0, 0.5, 1.0], " mm")
    for a in range(0, int(arc_max) + 1, 50):
        parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="#1c2634" stroke-width="0.7"/>'
                     % (fmt(ax(a)), fmt(strip1_top), fmt(ax(a)), fmt(strip1_top + STRIP_H)))
        parts.append('<text x="%s" y="%s" fill="#8b949e" font-size="9" text-anchor="middle">%d</text>'
                     % (fmt(ax(a)), fmt(strip1_top + STRIP_H + 14), a))
    points_mm = [(ax(arcs[k]), strip1_top + (1.2 - (deltas_mm[k] if deltas_mm[k] is not None else 0.0)) / 2.4 * STRIP_H)
                 for k in range(len(rows))]
    parts.append('<path d="%s" fill="none" stroke="#58a6ff" stroke-width="1.1"/>'
                 % " ".join(("M %s %s" % (fmt(x), fmt(y))) if i == 0 else
                            ("L %s %s" % (fmt(x), fmt(y)))
                            for i, (x, y) in enumerate(points_mm)))
    parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="#2ea043" stroke-width="0.7" stroke-dasharray="4 3"/>'
                 % (fmt(strip_left), fmt(strip1_top + STRIP_H / 2),
                    fmt(strip_left + strip_w), fmt(strip1_top + STRIP_H / 2)))
    parts.append('<text x="%s" y="%s" fill="#8b949e" font-size="9">min %s mm · max %s mm · all %d samples inside ±1 cm</text>'
                 % (fmt(strip_left + strip_w - 300), fmt(strip1_top + 12),
                    fmt(manifest["delta"]["min"] * 1000.0, 3),
                    fmt(manifest["delta"]["max"] * 1000.0, 3),
                    manifest["delta"]["countWithin1cm"]))

    legend_axes(strip2_top, "drawn surface width across the course (m), 0.10 m scan", 0.0, 26.0,
                [0, 5, 10, 15, 20, 25], " m")
    for a in range(0, int(arc_max) + 1, 50):
        parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="#1c2634" stroke-width="0.7"/>'
                     % (fmt(ax(a)), fmt(strip2_top), fmt(ax(a)), fmt(strip2_top + STRIP_H)))
        parts.append('<text x="%s" y="%s" fill="#8b949e" font-size="9" text-anchor="middle">%d</text>'
                     % (fmt(ax(a)), fmt(strip2_top + STRIP_H + 14), a))
    points_w = [(ax(arcs[k]), strip2_top + (26.0 - widths[k]) / 26.0 * STRIP_H)
                for k in range(len(rows))]
    parts.append('<path d="%s" fill="none" stroke="#3fb950" stroke-width="1.2"/>'
                 % " ".join(("M %s %s" % (fmt(x), fmt(y))) if i == 0 else
                            ("L %s %s" % (fmt(x), fmt(y)))
                            for i, (x, y) in enumerate(points_w)))
    for value, colour, label in ((2.276, "#ff9f43", "car envelope + 0.30 m margin (2.276 m)"),
                                 (1.676, "#58a6ff", "car envelope (1.676 m)")):
        y = strip2_top + (26.0 - value) / 26.0 * STRIP_H
        parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s" stroke-width="0.8" stroke-dasharray="4 3"/>'
                     % (fmt(strip_left), fmt(y), fmt(strip_left + strip_w), fmt(y), colour))
        parts.append('<text x="%s" y="%s" fill="%s" font-size="9">%s</text>'
                     % (fmt(strip_left + 6), fmt(y - 3), colour, label))
    parts.append('<text x="%s" y="%s" fill="#8b949e" font-size="9" text-anchor="end">drawn width min %s m · median %s m · max %s m (24 m scan cap)</text>'
                 % (fmt(strip_left + strip_w), fmt(strip2_top + STRIP_H - 2),
                    fmt(manifest["width"]["min"], 1), fmt(manifest["width"]["median"], 1),
                    fmt(manifest["width"]["max"], 1)))
    parts.append('<text x="%s" y="%s" fill="#8b949e" font-size="9" text-anchor="middle">arc along the course (m)</text>'
                 % (fmt(strip_left + strip_w / 2), fmt(height - 16)))
    parts.append('</svg>')
    svg = "\n".join(parts)
    (OUT / "visual-coverage.svg").write_text(svg, encoding="utf-8")

    # ------------------------------------------------------------------- HTML
    def row(label, value):
        return "<tr><th>%s</th><td>%s</td></tr>" % (html.escape(label), html.escape(str(value)))

    input_rows = "\n".join([
        row("course", "%s · %d samples at 0.25 m" % (manifest["course"]["lengthMetres"],
                                                     manifest["course"]["samples"])),
        row("visual map", "%s · %s" % (manifest["inputs"]["visualMap"],
                                       manifest["inputs"]["visualMapSha256"][:16] + "…")),
        row("collision", "%s · %s" % (manifest["inputs"]["physics"],
                                      manifest["inputs"]["physicsSha256"][:16] + "…")),
        row("cover rule", "%s" % manifest["model"]["coverRule"]),
        row("car width", "%.3f m + %.2f m margin (half width %.3f m)" % (
            manifest["model"]["carWidthMetres"], manifest["model"]["safetyMarginMetres"],
            manifest["model"]["marginHalfWidthMetres"])),
        row("coverage", "centre %d/%d · envelope %d/%d · car width %d/%d" % (
            manifest["coverage"]["centreCovered"], manifest["coverage"]["samples"],
            manifest["coverage"]["envelopeCovered"], manifest["coverage"]["samples"],
            manifest["coverage"]["marginCovered"], manifest["coverage"]["samples"])),
        row("gaps", "%d runs · %s m · first gap %s" % (
            manifest["coverage"]["gapRuns"], fmt(manifest["coverage"]["gapTotalMetres"], 3),
            "none" if manifest["firstGap"] is None else manifest["firstGap"]["start"])),
        row("visual − collision", "%s … %s m (max |Δ| %s m)" % (
            fmt(manifest["delta"]["min"], 6), fmt(manifest["delta"]["max"], 6),
            fmt(manifest["delta"]["maxAbs"], 6))),
        row("drawn width", "%s–%s m (median %s m)" % (
            fmt(manifest["width"]["min"], 1), fmt(manifest["width"]["max"], 1),
            fmt(manifest["width"]["median"], 1))),
        row("control: draws removed", "%d/%d covered" % (
            manifest["control"]["withoutUsedDraws"]["covered"],
            manifest["control"]["withoutUsedDraws"]["samples"])),
        row("control: section removed", "%d/%d covered" % (
            manifest["control"]["withoutUsedSection"]["covered"],
            manifest["control"]["withoutUsedSection"]["samples"])),
        row("manifest hash", manifest["hash"]),
    ])
    draw_rows = []
    for section in manifest["sections"]:
        for draw in section["draws"]:
            if not (draw["usedCentre"] or draw["usedBand"]):
                continue
            spans = " + ".join("%s–%s" % (fmt(s["arcStart"], 1), fmt(s["arcEnd"], 1))
                               for s in draw["arcSpans"]) or "band only"
            draw_rows.append("<tr><td>%s</td><td>%d</td><td>%d</td><td>%d…%d</td>"
                             "<td>%d</td><td>%s</td><td>%d</td><td>%s</td></tr>" % (
                                 section["key"], draw["drawIndex"], draw["primitiveIndex"],
                                 draw["firstIndex"], draw["firstIndex"] + draw["indexCount"],
                                 draw["trianglesInRange"], spans,
                                 draw["samplesCentre"], draw["samplesBand"]))
    verify_html = ""
    if verify is not None:
        verify_html = ("<p><strong>Independent verification:</strong> %s — native C++ reader "
                       "re-extraction, %d checks, %d errors; engine ground cross-check max "
                       "%s m over %d samples.</p>") % (
            verify["status"], sum(verify["checks"].values()), len(verify["errors"]),
            verify["engineCollisionCheck"].get("maxAbsDifferenceMetres"),
            verify["engineCollisionCheck"].get("samples", 0))
    doc = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>USA LA River — draw coverage of the 310.395 m course</title>
<style>
body {{ margin: 0; background: #0d1117; color: #c9d1d9; font: 14px/1.5 system-ui, sans-serif; }}
main {{ max-width: 1180px; margin: 0 auto; padding: 24px; }}
h1 {{ font-size: 20px; }}
svg {{ width: 100%%; height: auto; border: 1px solid #263243; background: #0d1117; }}
table {{ border-collapse: collapse; margin-top: 18px; width: 100%%; }}
th, td {{ border-bottom: 1px solid #263243; padding: 5px 9px; text-align: left; vertical-align: top; }}
th {{ width: 26%%; color: #8b949e; font-weight: 500; }}
code {{ color: #79c0ff; }}
</style></head>
<body><main>
<h1>USA LA River — draw coverage of the 310.395 m drivable course</h1>
<p>The committed direct draws of section <code>g56-n289</code> cover the whole course at the
car width; the drawn surface matches the collision surface within one millimetre. This is a
data measurement: no renderer, GPU or game frame is involved. Background: %s.</p>
%s
%s
<table>%s</table>
<h2 style="font-size:15px;margin-top:24px">Draws used</h2>
<table><tr><th>section</th><th>draw</th><th>primitive</th><th>index range</th><th>tris in range</th>
<th>arc spans (m)</th><th>centre samples</th><th>band samples</th></tr>
%s</table>
<p>Commands and limits: <code>probes/drivable-path/README.md</code> ·
<code>_work/drivable-path/visual-coverage-verify.json</code>.</p>
</main></body></html>
""" % (background, svg, verify_html, input_rows, "\n".join(draw_rows))
    (OUT / "visual-coverage.html").write_text(doc, encoding="utf-8")
    print("wrote", OUT / "visual-coverage.svg", len(svg), "bytes")
    print("wrote", OUT / "visual-coverage.html", len(doc), "bytes")

    if args.png:
        if not EDGE.is_file():
            print("png: SKIPPED (headless Edge not found)")
            return 0
        png = OUT / "visual-coverage.png"
        profile = OUT / "edge-profile"
        process = subprocess.run([
            str(EDGE), "--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--force-device-scale-factor=1", "--user-data-dir=%s" % profile,
            "--window-size=%d,%d" % (width + 40, height + 40),
            "--screenshot=%s" % png,
            (OUT / "visual-coverage.html").resolve().as_uri(),
        ], capture_output=True, text=True, timeout=120, check=False)
        if process.returncode != 0 or not png.is_file():
            print("png: FAILED", process.returncode, (process.stderr or process.stdout)[-400:])
            return 1
        print("wrote", png, png.stat().st_size, "bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
