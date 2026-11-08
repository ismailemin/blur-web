"""Deterministic 480x270 software previews for decoded model geometry.

No GPU, no browser and no external image library: the rasteriser consumes the
committed `scene_inspect` output (object-local positions, U32 triangle indices,
per-draw index spans) and writes an 8-bit RGBA PNG with a fixed zlib level and
no timestamps, so two runs are byte-identical.

Two fixed cameras are produced per asset:

  * `front` - orthographic, looking down +Z with +Y up (the natural view of the
    zero-thickness icon quads);
  * `iso`   - orthographic three-quarter view, for the mostly-horizontal world
    effects (barge wave, mine rings) that collapse to a line in the front view.

This is a diagnostic silhouette/flat-shade view of the *first render list*
geometry only. It does not apply node transforms, shader billboarding, UVs or
material textures; those remain outside the committed scene reader.
"""
from __future__ import annotations

import math
import struct
import zlib

WIDTH = 480
HEIGHT = 270
MARGIN = 16
BACKGROUND = (18, 20, 24, 255)

# Fixed palette; one colour per draw, cycled. Flat enough to read a silhouette.
PALETTE = [
    (198, 208, 220), (232, 168, 96), (128, 196, 168), (196, 148, 208),
    (120, 168, 224), (224, 196, 120), (168, 208, 120), (208, 128, 128),
]

LIGHT = (-0.35, 0.55, 0.75)
ISO_DIRECTION = (0.62, 0.46, 0.64)


def _normalise(v):
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    if n <= 0.0:
        return (0.0, 0.0, 0.0)
    return (v[0] / n, v[1] / n, v[2] / n)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def camera_basis(view: str):
    if view == "front":
        forward = (0.0, 0.0, 1.0)
    elif view == "iso":
        forward = _normalise(ISO_DIRECTION)
    else:
        raise ValueError(f"unknown view {view}")
    right = _normalise(_cross(forward, (0.0, 1.0, 0.0)))
    up = _cross(right, forward)
    return forward, right, up


def png_bytes(width: int, height: int, rgba: bytearray) -> bytes:
    if len(rgba) != width * height * 4:
        raise ValueError("RGBA buffer size mismatch")
    rows = bytearray()
    stride = width * 4
    for y in range(height):
        rows.append(0)  # filter type 0 (None)
        rows += rgba[y * stride:(y + 1) * stride]

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
            + chunk(b"IEND", b""))


def render(positions, indices, draws, bounds, view="front",
           width=WIDTH, height=HEIGHT) -> bytes:
    """positions: flat float list; indices: flat int list; draws: scene draws."""
    if isinstance(bounds, dict):
        bounds = (bounds["min"], bounds["max"])
    if len(positions) % 3 or len(indices) % 3:
        raise ValueError("Malformed geometry arrays")
    for value in positions:
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("Non-finite position in preview input")

    forward, right, up = camera_basis(view)

    # Project every vertex into camera space.
    raw = []
    for i in range(0, len(positions), 3):
        p = (positions[i], positions[i + 1], positions[i + 2])
        raw.append((_dot(p, right), _dot(p, up), _dot(p, forward)))

    xs = [r[0] for r in raw]
    ys = [r[1] for r in raw]
    ex = max(max(xs) - min(xs), 1e-6)
    ey = max(max(ys) - min(ys), 1e-6)
    scale = min((width - 2 * MARGIN) / ex, (height - 2 * MARGIN) / ey)
    cx = (min(xs) + max(xs)) * 0.5
    cy = (min(ys) + max(ys)) * 0.5
    ox = width * 0.5
    oy = height * 0.5
    pts = [(ox + (rx - cx) * scale, oy - (ry - cy) * scale, rz)
           for rx, ry, rz in raw]

    rgba = bytearray(BACKGROUND * (width * height))
    zbuf = [float("inf")] * (width * height)
    light = _normalise(LIGHT)
    for draw_index, draw in enumerate(draws):
        colour = PALETTE[draw_index % len(PALETTE)]
        first = draw["firstIndex"]
        count = draw["indexCount"]
        for t in range(first, first + count, 3):
            ia, ib, ic = indices[t], indices[t + 1], indices[t + 2]
            ax, ay, az = pts[ia]
            bx, by, bz = pts[ib]
            cx2, cy2, cz2 = pts[ic]
            area = (bx - ax) * (cy2 - ay) - (cx2 - ax) * (by - ay)
            if abs(area) < 1e-12:
                continue
            shade = 0.55 + 0.45 * abs(light[2] if view == "front" else light[1])
            col = (min(255, int(colour[0] * shade)),
                   min(255, int(colour[1] * shade)),
                   min(255, int(colour[2] * shade)), 255)

            min_x = max(0, int(math.floor(min(ax, bx, cx2))))
            max_x = min(width - 1, int(math.ceil(max(ax, bx, cx2))))
            min_y = max(0, int(math.floor(min(ay, by, cy2))))
            max_y = min(height - 1, int(math.ceil(max(ay, by, cy2))))
            inv_area = 1.0 / area
            for py in range(min_y, max_y + 1):
                fy = py + 0.5
                row = py * width
                for px in range(min_x, max_x + 1):
                    fx = px + 0.5
                    w0 = ((bx - ax) * (fy - ay) - (fx - ax) * (by - ay)) * inv_area
                    w1 = ((fx - ax) * (cy2 - ay) - (cx2 - ax) * (fy - ay)) * inv_area
                    w2 = 1.0 - w0 - w1
                    if w0 < 0.0 or w1 < 0.0 or w2 < 0.0:
                        continue
                    depth = w0 * az + w1 * bz + w2 * cz2
                    o = row + px
                    if depth < zbuf[o]:
                        zbuf[o] = depth
                        p = o * 4
                        rgba[p] = col[0]
                        rgba[p + 1] = col[1]
                        rgba[p + 2] = col[2]
                        rgba[p + 3] = 255
    return png_bytes(width, height, rgba)


def texture_png(width: int, height: int, rgba: list) -> bytes:
    if len(rgba) != width * height * 4:
        raise ValueError("Texture RGBA size mismatch")
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # filter type 0 (None)
        start = y * width * 4
        rows += bytes(rgba[start:start + width * 4])

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
            + chunk(b"IEND", b""))
