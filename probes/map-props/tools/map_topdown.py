"""map_topdown.py — top-down diagnostic for the map-props collider manifests.

Draws one PNG per map:
  - grey 40 m region band under the measured path,
  - black measured polyline, red thick segments for all-visible blocked arcs,
  - collider OBB footprints coloured by diagnostic structure class,
  - on-measured-path (inactive under `roadside`) colliders in purple,
  - spawn / checkpoints / finish markers and a legend.

Usage:
  python probes/map-props/tools/map_topdown.py [--out DIR]
"""

import argparse
import json
import math
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DEFAULT_OUT = os.path.join(ROOT, "_work", "map-props")

COLORS = {
    "building": (214, 95, 2),
    "silo-tank": (27, 158, 119),
    "wall": (117, 112, 179),
    "pole-tower": (90, 90, 90),
    "fence-barrier": (231, 41, 138),
    "container-vehicle": (230, 171, 2),
    "pipe-structure": (102, 166, 30),
    "other": (150, 150, 150),
}


def corners(c):
    cx, cz = c["center"][0], c["center"][2]
    ux, uz = c["axes"][0][0], c["axes"][0][2]
    vx, vz = c["axes"][2][0], c["axes"][2][2]
    hu, hv = c["half"][0], c["half"][2]
    return [
        (cx + ux * hu + vx * hv, cz + uz * hu + vz * hv),
        (cx + ux * hu - vx * hv, cz + uz * hu - vz * hv),
        (cx - ux * hu - vx * hv, cz - uz * hu - vz * hv),
        (cx - ux * hu + vx * hv, cz - uz * hu + vz * hv),
    ]


def draw_map(map_key, out_dir):
    with open(os.path.join(ROOT, "_work", "map-props", f"colliders-{map_key}.json"), encoding="utf-8") as f:
        m = json.load(f)
    with open(os.path.join(ROOT, "_work", "map-slice", f"{map_key}-render", "layout.points.f32.bin"), "rb") as f:
        raw = f.read()
    import struct
    pts = struct.unpack("<%df" % (len(raw) // 4), raw)
    path = [(pts[3 * i], pts[3 * i + 1]) for i in range(len(pts) // 3)]

    xs = [p[0] for p in path]
    zs = [p[1] for p in path]
    pad = 55.0
    xmin, xmax = min(xs) - pad, max(xs) + pad
    zmin, zmax = min(zs) - pad, max(zs) + pad
    span = max(xmax - xmin, zmax - zmin)
    width = 1500
    scale = (width - 40) / span
    height = int((zmax - zmin) * scale) + 120
    img = Image.new("RGB", (width, height), "white")
    d = ImageDraw.Draw(img)

    def X(x):
        return 20 + (x - xmin) * scale

    def Y(z):
        return 20 + (zmax - z) * scale

    # 40 m region band under the path (union of 40 m discs, exact and centred)
    band_px = 40.0 * scale
    for i in range(0, len(path), 8):
        px, pz = X(path[i][0]), Y(path[i][1])
        d.ellipse([px - band_px, pz - band_px, px + band_px, pz + band_px], fill=(236, 236, 236))
    # colliders
    for c in m["colliders"]:
        poly = [(X(x), Y(z)) for x, z in corners(c)]
        color = COLORS.get(c["structureClass"], (150, 150, 150))
        if c.get("active") is False:
            d.polygon(poly, outline=(120, 0, 160), width=2)
        else:
            d.polygon(poly, outline=color, width=1 if max(c["size"][0], c["size"][2]) < 5 else 2)
    # path and blocked arcs
    d.line([(X(x), Y(z)) for x, z in path], fill=(0, 0, 0), width=2)
    cum = [0.0]
    for i in range(1, len(path)):
        cum.append(cum[-1] + math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]))
    for a in m["path"]["allVisibleBlockedArcs"]:
        # arc -> sample window
        idxs = []
        for i, arc in enumerate(cum):
            if a["arcStart"] - 0.3 <= arc <= a["arcEnd"] + 0.3:
                idxs.append(i)
        if idxs:
            d.line([(X(path[i][0]), Y(path[i][1])) for i in idxs], fill=(220, 0, 0), width=5)
    # markers
    def marker(x, z, color, label):
        r = 7
        d.ellipse([X(x) - r, Y(z) - r, X(x) + r, Y(z) + r], outline=color, width=2)
        d.text((X(x) + 10, Y(z) - 10), label, fill=color)

    sp = m["path"]["spawn"]
    marker(sp["x"], sp["z"], (0, 140, 0), "spawn")
    for cp in m["path"]["checkpoints"]:
        marker(cp["x"], cp["z"], (220, 120, 0), f"cp{cp['index']}")
    fin = m["path"]["finish"]
    marker(fin["x"], fin["z"], (0, 60, 220), "finish")

    # legend / title
    d.text((20, 4), f"{m['level']} - {m['counts']['colliders']} colliders "
                    f"({m['counts']['active']} active, {m['counts']['inactiveOnMeasuredPath']} on-path); "
                    f"path {m['path']['lengthM']:.1f} m; black = measured path, red = all-visible blocked arc",
           fill=(0, 0, 0))
    y = height - 20
    x = 20
    for name, color in COLORS.items():
        d.rectangle([x, y - 8, x + 12, y + 4], outline=color, width=2)
        d.text((x + 16, y - 8), name, fill=(0, 0, 0))
        x += 24 + 7 * len(name)
    d.rectangle([x, y - 8, x + 12, y + 4], outline=(120, 0, 160), width=2)
    d.text((x + 16, y - 8), "on-path (inactive)", fill=(0, 0, 0))

    out = os.path.join(out_dir, f"map-{map_key}.png")
    img.save(out)
    print(f"wrote {out} {img.size[0]}x{img.size[1]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for map_key in ("amboy", "gracia"):
        draw_map(map_key, args.out)


if __name__ == "__main__":
    sys.exit(main())
