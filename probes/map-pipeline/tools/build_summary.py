#!/usr/bin/env python3
"""Render a deterministic top-down + table summary from maps.json.

Outputs:
  _work/map-pipeline/maps-summary.svg   top-down panel + table (standalone SVG)
  _work/map-pipeline/maps-summary.html  the same with the readable table
No JavaScript. The SVG is built from the 1 m grids and measured path artifacts.
"""
from __future__ import annotations

import argparse
import html
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
WORK = ROOT / "_work/map-pipeline"
COLORS = {"A": "#1a9850", "B": "#e6a700", "C": "#d73027"}


def svg_escape(text) -> str:
    return html.escape(str(text), quote=True)


def runs_for_mask(mask, x0, z0, cell, max_dim):
    nz, nx = mask.shape
    step = max(1, int(math.ceil(max(nx, nz) / max_dim)))
    rects = []
    for j in range(0, nz, step):
        row = mask[j, 0::step]
        i = 0
        while i < len(row):
            if not row[i]:
                i += 1
                continue
            k = i
            while k + 1 < len(row) and row[k + 1]:
                k += 1
            rects.append((i * step, j, (k - i + 1) * step, step))
            i = k + 1
    return rects, step


def level_svg(row, max_dim=220):
    name = row["name"]
    grid_path = ROOT / row["grid"]["path"]
    if not grid_path.is_file():
        return '<div class="missing">no grid</div>'
    grid = np.load(grid_path)
    passable = grid["passable"]
    H = grid["height"]
    xs, zs = grid["xs"], grid["zs"]
    nz, nx = passable.shape
    step = max(1, int(math.ceil(max(nx, nz) / max_dim)))
    rects, _ = runs_for_mask(passable, 0, 0, 1.0, max_dim)
    scale = max_dim / max(nx, nz)
    w, h = nx * scale, nz * scale
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.1f} {h:.1f}" '
             f'width="{w:.0f}" height="{h:.0f}" role="img" aria-label="{svg_escape(name)}">',
             f'<rect width="{w:.1f}" height="{h:.1f}" fill="#111"/>']
    for (i, j, rw, rh) in rects:
        parts.append(f'<rect x="{i*scale:.2f}" y="{j*scale:.2f}" '
                     f'width="{rw*scale:.2f}" height="{rh*scale:.2f}" fill="#3a3a3a"/>')
    # collision path
    cpath = WORK / "paths" / (name + ".json")
    if cpath.is_file():
        pts = json.loads(cpath.read_text())["samples"]
        if len(pts) > 1:
            d = "M " + " L ".join(
                f"{(p['x']-xs[0])/step*scale:.2f},{(p['z']-zs[0])/step*scale:.2f}"
                for p in pts[::max(1, len(pts)//300)])
            parts.append(f'<path d="{d}" fill="none" stroke="#d73027" stroke-width="1.1"/>')
    # draw-covered path
    cpath2 = WORK / "covered" / (name + "-path.json")
    if cpath2.is_file():
        pts = json.loads(cpath2.read_text())["samples"]
        if len(pts) > 1:
            d = "M " + " L ".join(
                f"{(p['x']-xs[0])/step*scale:.2f},{(p['z']-zs[0])/step*scale:.2f}"
                for p in pts[::max(1, len(pts)//300)])
            parts.append(f'<path d="{d}" fill="none" stroke="#1a9850" stroke-width="1.6"/>')
    parts.append('</svg>')
    return "".join(parts)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--maps", type=Path, default=WORK / "maps.json")
    ap.add_argument("--out-svg", type=Path, default=WORK / "maps-summary.svg")
    ap.add_argument("--out-html", type=Path, default=WORK / "maps-summary.html")
    args = ap.parse_args(argv)
    doc = json.loads(args.maps.read_text())
    rows = doc["levels"]
    row_h = 86
    width = 1800
    header_h = 60
    svg_w = 260
    height = header_h + row_h * len(rows) + 20
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
             f'viewBox="0 0 {width} {height}" font-family="Segoe UI, Arial, sans-serif">',
             f'<rect width="{width}" height="{height}" fill="#0d0d0d"/>',
             f'<text x="20" y="28" fill="#f0f0f0" font-size="18">Blur Web map pipeline — collision + draw audit (19 levels)</text>',
             f'<text x="20" y="48" fill="#a0a0a0" font-size="11">gray = collision-passable 1 m cells · red = collision-only diameter · green = draw-covered diameter · first RenderList direct draws, instancesApplied:false</text>',
             f'<text x="20" y="{header_h+14}" fill="#c0c0c0" font-size="11">A {doc["summary"]["classificationCounts"]["A"]} · B {doc["summary"]["classificationCounts"]["B"]} · C {doc["summary"]["classificationCounts"]["C"]}</text>']
    y = header_h + 24
    for row in rows:
        parts.append(f'<text x="20" y="{y+12}" fill="{COLORS[row["classification"]]}" font-size="12" font-weight="bold">#{row["rank"]:02d} {svg_escape(row["name"])}</text>')
        parts.append(f'<text x="20" y="{y+30}" fill="#d0d0d0" font-size="10">class {row["classification"]} · tri {row["physics"].get("staticTriangles",0)} · collision path {row["drivable"].get("path",{}).get("lengthM",0)} m · draw-covered {row["drawCoverage"]["drawCoveredPathM"]} m · covered {row["drawCoverage"]["coveredCollisionCells"]} cells</text>')
        parts.append(f'<text x="20" y="{y+46}" fill="#909090" font-size="9">sections {row["draws"]["probesSupported"]}/{row["draws"]["probesAttempted"]} probed of {row["draws"]["firstRenderListDirectPairs"]} pairs · blocked: {svg_escape(row.get("blocker") or "—")[:150]}</text>')
        parts.append(f'<g transform="translate(1620,{y-4})">{level_svg(row, 74)}</g>')
        y += row_h
    parts.append('</svg>')
    svg = "\n".join(parts)
    args.out_svg.write_text(svg + "\n", encoding="utf-8")

    table_rows = []
    for row in rows:
        d = row["drivable"]
        c = row["drawCoverage"]
        table_rows.append(
            "<tr class='%s'><td>%d</td><td>%s</td><td>%s</td><td>%s</td>"
            "<td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
                row["classification"].lower(), row["rank"], html.escape(row["name"]),
                row["classification"], row["kind"],
                row["physics"].get("staticTriangles", 0),
                d.get("path", {}).get("lengthM", 0),
                c["drawCoveredPathM"], c["coveredCollisionCells"],
                "%d/%d" % (row["draws"]["probesSupported"], row["draws"]["probesAttempted"]),
                row["draws"]["firstRenderListDirectPairs"],
                html.escape(row.get("blocker") or "—")))
    html_doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Blur Web map pipeline audit</title>
<style>
body {{ background:#0d0d0d; color:#e8e8e8; font:13px Segoe UI,Arial,sans-serif; margin:24px; }}
h1 {{ font-size:20px; }} h2 {{ font-size:15px; color:#bbb; }}
table {{ border-collapse:collapse; width:100%; }}
th,td {{ border-bottom:1px solid #333; padding:5px 7px; text-align:left; vertical-align:top; }}
th {{ color:#aaa; position:sticky; top:0; background:#151515; }}
tr.a td:nth-child(3) {{ color:#1a9850; font-weight:bold; }}
tr.b td:nth-child(3) {{ color:#e6a700; font-weight:bold; }}
tr.c td:nth-child(3) {{ color:#d73027; font-weight:bold; }}
.note {{ color:#999; max-width:1100px; }}
</style></head><body>
<h1>Blur Web map pipeline — 19-level audit</h1>
<p class="note">Data-only audit. Gray = collision-passable 1 m cells; red = collision-only geodesic diameter; green = draw-covered diameter. Draws are first RenderList direct LOD0 only (<code>instancesApplied:false</code>). A = integrated e1-drive level, B = needs layout/reader step, C = blocked at the extracted draw coverage. No playable-game claim.</p>
<img src="maps-summary.svg" alt="top-down map summary" style="max-width:100%;border:1px solid #333">
<h2>Ranked matrix</h2>
<table><thead><tr><th>#</th><th>level</th><th>class</th><th>kind</th><th>collision tris</th><th>collision path m</th><th>draw-covered path m</th><th>covered cells</th><th>sections probed</th><th>correlated pairs</th><th>blocker</th></tr></thead>
<tbody>{''.join(table_rows)}</tbody></table>
</body></html>
"""
    args.out_html.write_text(html_doc, encoding="utf-8")
    print(json.dumps({"svg": str(args.out_svg), "html": str(args.out_html),
                      "levels": len(rows)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
