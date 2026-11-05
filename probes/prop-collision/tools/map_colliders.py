#!/usr/bin/env python
"""Top-down diagnostic map of the prop-collision layer.

Reads _work/prop-collision/colliders.json and the measured course, and writes a
PNG with the course line, the 6 m gate band, every collider footprint (active
and on-course) and the measured arcs where the all-visible profile blocks the
line.  Diagnostic output only.
"""

import json
import math
import os
from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
COLLIDERS = os.path.join(ROOT, "_work", "prop-collision", "colliders.json")
PATH_JSON = os.path.join(ROOT, "_work", "drivable-path", "path.json")
OUT = os.path.join(ROOT, "_work", "prop-collision", "map.png")

with open(COLLIDERS, "r", encoding="utf-8") as f:
    manifest = json.load(f)
with open(PATH_JSON, "r", encoding="utf-8") as f:
    course = json.load(f)["course"]

points = course["points"]
xs = [p[0] for p in points]
zs = [p[1] for p in points]
minx, maxx = min(xs), max(xs)
minz, maxz = min(zs), max(zs)
for c in manifest["colliders"]:
    for p in (c["worldAabb"]["min"], c["worldAabb"]["max"]):
        minx = min(minx, p[0])
        maxx = max(maxx, p[0])
        minz = min(minz, p[2])
        maxz = max(maxz, p[2])

pad = 8.0
minx -= pad
maxx += pad
minz -= pad
maxz += pad
scale = 5.0  # px per metre
w = int((maxx - minx) * scale) + 1
h = int((maxz - minz) * scale) + 1


def sx(x):
    return int((x - minx) * scale)


def sz(z):
    return int((z - minz) * scale)


img = Image.new("RGB", (w, h), (250, 248, 242))
d = ImageDraw.Draw(img)

COLOURS = {
    "vehicle-sized-wreck": (200, 40, 40),
    "building-sized": (150, 40, 160),
    "vehicle": (220, 100, 20),
    "building": (120, 60, 200),
    "structure": (70, 110, 200),
    "unclassified": (20, 20, 20),
}
INACTIVE = (150, 150, 150)


def arc_point(arc):
    acc = 0.0
    for i in range(1, len(points)):
        seg = math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
        if acc + seg >= arc:
            t = (arc - acc) / seg if seg else 0
            x = points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t
            z = points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t
            dx = points[i][0] - points[i - 1][0]
            dz = points[i][1] - points[i - 1][1]
            n = math.hypot(dx, dz) or 1.0
            return x, z, -dz / n, dx / n
        acc += seg
    return points[-1][0], points[-1][1], 0, 1


# 6 m gate band
left, right = [], []
for i, p in enumerate(points):
    a = points[max(0, i - 1)]
    b = points[min(len(points) - 1, i + 1)]
    dx = b[0] - a[0]
    dz = b[1] - a[1]
    n = math.hypot(dx, dz) or 1.0
    nx, nz = -dz / n, dx / n
    left.append((p[0] + nx * 3.0, p[1] + nz * 3.0))
    right.append((p[0] - nx * 3.0, p[1] - nz * 3.0))
d.polygon(
    [(sx(x), sz(z)) for x, z in left] + [(sx(x), sz(z)) for x, z in reversed(right)],
    fill=(228, 238, 220),
)

# all-visible blocked arcs
for arc in manifest["road"]["allVisibleBlockedArcs"]:
    x, z, nx, nz = arc_point((arc["arcStart"] + arc["arcEnd"]) / 2)
    d.line(
        [(sx(x - nx * 3.4), sz(z - nz * 3.4)), (sx(x + nx * 3.4), sz(z + nz * 3.4))],
        fill=(210, 30, 30),
        width=4,
    )

# measured gates
for arc in (0.0, 100.108, 200.075, 300.160):
    x, z, nx, nz = arc_point(arc)
    d.line(
        [(sx(x - nx * 3), sz(z - nz * 3)), (sx(x + nx * 3), sz(z + nz * 3))],
        fill=(255, 150, 0),
        width=2,
    )

# colliders
for c in manifest["colliders"]:
    ctr = c["center"]
    ux, uz = c["axes"][0][0], c["axes"][0][2]
    vx, vz = c["axes"][2][0], c["axes"][2][2]
    hu, hv = c["half"][0], c["half"][2]
    corners = [
        (ctr[0] + ux * hu + vx * hv, ctr[2] + uz * hu + vz * hv),
        (ctr[0] - ux * hu + vx * hv, ctr[2] - uz * hu + vz * hv),
        (ctr[0] - ux * hu - vx * hv, ctr[2] - uz * hu - vz * hv),
        (ctr[0] + ux * hu - vx * hv, ctr[2] + uz * hu - vz * hv),
    ]
    colour = COLOURS.get(c["classification"], (20, 20, 20))
    if not c["active"]:
        colour = INACTIVE
        d.polygon([(sx(x), sz(z)) for x, z in corners], fill=(232, 226, 220), outline=colour)
    else:
        d.polygon([(sx(x), sz(z)) for x, z in corners], outline=colour)
    d.line([(sx(x), sz(z)) for x, z in corners] + [(sx(corners[0][0]), sz(corners[0][1]))], fill=colour, width=1)

d.line([(sx(p[0]), sz(p[1])) for p in points], fill=(20, 20, 20), width=2)

d.text((8, 8), "Prop colliders vs the 310.395 m course (5 px/m)", fill=(0, 0, 0))
legend = [
    ("course centreline", (20, 20, 20)),
    ("6 m gate band", (228, 238, 220)),
    ("all-visible blocked arc (4)", (210, 30, 30)),
    ("measured gate", (255, 150, 0)),
    ("vehicle-sized level prop", (200, 40, 40)),
    ("building-sized level prop", (150, 40, 160)),
    ("active structure", (70, 110, 200)),
    ("on-course (inactive in default)", (150, 150, 150)),
]
y = 24
for label, colour in legend:
    d.rectangle([8, y, 20, y + 8], fill=colour, outline=(0, 0, 0))
    d.text((26, y - 1), label, fill=(0, 0, 0))
    y += 13
d.text((8, y + 4), f"{manifest['counts']['colliders']} colliders, {manifest['counts']['active']} active", fill=(0, 0, 0))

img.save(OUT)
print(OUT, img.size)
