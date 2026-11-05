#!/usr/bin/env python3
"""Render the drivable-path course map (SVG + HTML), deterministic.

Inputs : _work/drivable-path/{path.json,grid.npz,verify.json,engine-trace.json}
Outputs: _work/drivable-path/{path.svg,path.html}

    python probes/drivable-path/tools/build_map.py
"""
from __future__ import annotations

import html
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work/drivable-path"
SCALE = 4.0
PAD = 48


def runs(row):
    """Yield (start, end, value) for runs of equal values in a 1-D array."""
    if len(row) == 0:
        return
    start = 0
    val = row[0]
    for i in range(1, len(row)):
        if row[i] != val:
            yield start, i, val
            start = i
            val = row[i]
    yield start, len(row), val


def main() -> int:
    path = json.loads((OUT / "path.json").read_text())
    verify = json.loads((OUT / "verify.json").read_text())
    engine = json.loads((OUT / "engine-trace.json").read_text())
    g = np.load(OUT / "grid.npz")
    H = g["height"]; base = g["base_pass"]; comp = g["component"]; W = g["wall_oracle"]
    xs = g["xs"]; zs = g["zs"]
    cell = float(xs[1] - xs[0])
    stride = 2  # 1 m rendering

    pts = path["course"]["points"]
    px = [p[0] for p in pts]; pz = [p[1] for p in pts]
    xmin = min(min(px), float(xs[0])) - 10
    xmax = max(max(px), 130.0) + 10
    zmin = min(min(pz), 1020.0) - 10
    zmax = max(max(pz), 1315.0) + 10
    # clip to the raster window
    xmin = max(xmin, float(xs[0])); xmax = min(xmax, float(xs[-1]))
    zmin = max(zmin, float(zs[0])); zmax = min(zmax, float(zs[-1]))
    width = int((xmax - xmin) * SCALE) + 2 * PAD
    height = int((zmax - zmin) * SCALE) + 2 * PAD

    def sx(x):
        return PAD + (x - xmin) * SCALE

    def sy(z):
        return PAD + (zmax - z) * SCALE

    parts = []
    parts.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">')
    parts.append('<rect width="100%" height="100%" fill="#0d1117"/>')
    parts.append('<g id="surface">')

    colors = {
        "base": "#1b2a1f",
        "comp": "#2f5f3c",
        "wall": "#7a2c2c",
    }
    # 1 m runs; draw base, then component, then walls
    i0 = max(0, int(math.floor((xmin - xs[0]) / cell)))
    i1 = min(len(xs) - 1, int(math.ceil((xmax - xs[0]) / cell)))
    j0 = max(0, int(math.floor((zmin - zs[0]) / cell)))
    j1 = min(len(zs) - 1, int(math.ceil((zmax - zs[0]) / cell)))
    for cls, mask in (("base", base), ("comp", comp), ("wall", W)):
        fill = colors[cls]
        parts.append(f'<g fill="{fill}">')
        for j in range(j0, j1 + 1, stride):
            row = mask[j, i0:i1 + 1:stride]
            if not row.any():
                continue
            z = float(zs[j])
            for a, b, v in runs(row.astype(np.int8)):
                if not v:
                    continue
                x_a = float(xs[i0 + a * stride])
                x_b = float(xs[i0 + min((b - 1) * stride, i1 - i0)])
                x0 = sx(x_a); x1 = sx(x_b) + SCALE * stride
                y0 = sy(z) - SCALE * stride
                parts.append(f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{max(0.5, x1 - x0):.1f}" height="{SCALE * stride:.1f}"/>')
        parts.append('</g>')
    parts.append('</g>')

    # grid every 20 m
    parts.append('<g stroke="#263243" stroke-width="0.6" opacity="0.7">')
    gx = math.ceil(xmin / 20.0) * 20.0
    while gx <= xmax:
        parts.append(f'<line x1="{sx(gx):.1f}" y1="{PAD}" x2="{sx(gx):.1f}" y2="{height - PAD}"/>')
        parts.append(f'<text x="{sx(gx):.1f}" y="{height - PAD + 16}" fill="#7d8b99" font-family="monospace" font-size="10" text-anchor="middle">{gx:.0f}</text>')
        gx += 20.0
    gz = math.ceil(zmin / 20.0) * 20.0
    while gz <= zmax:
        parts.append(f'<line x1="{PAD}" y1="{sy(gz):.1f}" x2="{width - PAD}" y2="{sy(gz):.1f}"/>')
        parts.append(f'<text x="{PAD - 6}" y="{sy(gz) + 3:.1f}" fill="#7d8b99" font-family="monospace" font-size="10" text-anchor="end">{gz:.0f}</text>')
        gz += 20.0
    parts.append('</g>')
    parts.append(f'<text x="{PAD}" y="{PAD - 20}" fill="#c9d1d9" font-family="monospace" font-size="13">USA LA River — collision-only drivable path ({path["course"]["length"]:.1f} m)</text>')
    parts.append(f'<text x="{PAD}" y="{PAD - 6}" fill="#7d8b99" font-family="monospace" font-size="10">x / z metres · green = passable collision surface · dark red = steep collision face · blue = measured course</text>')

    # path
    d = " ".join((f"M {sx(x):.2f} {sy(z):.2f}" if k == 0 else f"L {sx(x):.2f} {sy(z):.2f}")
                 for k, (x, z) in enumerate(pts))
    parts.append(f'<path d="{d}" fill="none" stroke="#0b1b2b" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>')
    parts.append(f'<path d="{d}" fill="none" stroke="#4aa3ff" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>')

    # start / end
    sx0, sy0 = sx(pts[0][0]), sy(pts[0][1])
    ex, ez = path["course"]["end"]
    parts.append(f'<circle cx="{sx0:.1f}" cy="{sy0:.1f}" r="7" fill="#2ecc71" stroke="#0d1117" stroke-width="2"/>')
    parts.append(f'<text x="{sx0 + 10:.1f}" y="{sy0 - 8:.1f}" fill="#2ecc71" font-family="monospace" font-size="11">spawn (-88, 1050)</text>')
    parts.append(f'<circle cx="{sx(ex):.1f}" cy="{sy(ez):.1f}" r="7" fill="#ff9f43" stroke="#0d1117" stroke-width="2"/>')
    parts.append(f'<text x="{sx(ex) + 10:.1f}" y="{sy(ez) - 8:.1f}" fill="#ff9f43" font-family="monospace" font-size="11">end ({ex:.1f}, {ez:.1f})</text>')
    # barrier annotation
    narrow = path["barrierSummary"]["firstNarrow"]
    if narrow:
        parts.append(f'<text x="{sx(ex) + 10:.1f}" y="{sy(ez) + 14:.1f}" fill="#ff9f43" font-family="monospace" font-size="10">surface narrows to {narrow["widthBase"]:.1f} m at +{narrow["ahead"]:.0f} m</text>')
    # scale bar
    bar = 50.0
    x0 = width - PAD - bar * SCALE
    y0 = height - PAD + 28
    parts.append(f'<line x1="{x0:.1f}" y1="{y0}" x2="{x0 + bar * SCALE:.1f}" y2="{y0}" stroke="#c9d1d9" stroke-width="2"/>')
    parts.append(f'<text x="{x0 + bar * SCALE / 2:.1f}" y="{y0 + 13}" fill="#c9d1d9" font-family="monospace" font-size="10" text-anchor="middle">{bar:.0f} m</text>')
    parts.append('</svg>')
    svg = "\n".join(parts)
    (OUT / "path.svg").write_text(svg, encoding="utf-8")

    # HTML
    def row(label, value):
        return f"<tr><th>{html.escape(label)}</th><td>{html.escape(str(value))}</td></tr>"

    m = verify["metrics"]
    table = "\n".join([
        row("course length", f'{path["course"]["length"]:.3f} m'),
        row("start", "(-88.0, 1050.0)"),
        row("end", f'({path["course"]["end"][0]:.1f}, {path["course"]["end"][1]:.1f})'),
        row("samples", f'{path["course"]["samples"]} at 0.25 m'),
        row("max step (engine / oracle)", f'{engine["maxStep"]:.4f} m / {m["maxStep"]:.4f} m'),
        row("max 2 m grade (engine / oracle)", f'{100 * engine["maxGrade"]:.2f} % / {100 * m["maxGrade"]:.2f} %'),
        row("min wall distance (oracle)", f'{m["minWallDistance"]:.2f} m'),
        row("car envelope", f'{path["inputs"]["carEnvelope"]["length"]:.3f} × {path["inputs"]["carEnvelope"]["width"]:.3f} m + {path["inputs"]["carEnvelope"]["safetyMargin"]:.2f} m'),
        row("model", f'{path["model"]["cell"]} m grid, step ≤ {path["model"]["stepLimit"]} m, grade ≤ {100 * path["model"]["gradeLimit"]:.1f} %, wall mask = {path["model"]["wallMask"]}'),
        row("engine wall trace", f'{len(engine["violations"])} violations at {engine["samples"]} samples'),
        row("29 m sprint engine control", f'{engine["control29m"]["wallHits"]} wall hits, max step {engine["control29m"]["maxStep"]:.4f} m'),
        row("path hash", path["hash"]),
        row("verify hash", verify["hash"]),
        row("engine trace hash", engine["hash"]),
    ])
    doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>USA LA River — collision-only drivable path</title>
<style>
body {{ margin: 0; background: #0d1117; color: #c9d1d9; font: 14px/1.5 system-ui, sans-serif; }}
main {{ max-width: 1200px; margin: 0 auto; padding: 24px; }}
h1 {{ font-size: 20px; }}
svg {{ width: 100%; height: auto; border: 1px solid #263243; }}
table {{ border-collapse: collapse; margin-top: 24px; width: 100%; }}
th, td {{ border-bottom: 1px solid #263243; padding: 6px 10px; text-align: left; vertical-align: top; }}
th {{ width: 30%; color: #8b949e; font-weight: 500; }}
code {{ color: #79c0ff; }}
</style></head>
<body><main>
<h1>USA LA River — collision-only drivable path</h1>
<p>Every cell comes from <code>Level.levelphysics</code>; no draw geometry is read. The course is
the longest engine-clean path found from the committed spawn under the documented step, grade and
clearance limits.</p>
{svg}
<table>{table}</table>
<p>Commands and limits: <code>probes/drivable-path/README.md</code>.</p>
</main></body></html>
"""
    (OUT / "path.html").write_text(doc, encoding="utf-8")
    print("wrote", OUT / "path.svg", len(svg), "bytes")
    print("wrote", OUT / "path.html", len(doc), "bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
