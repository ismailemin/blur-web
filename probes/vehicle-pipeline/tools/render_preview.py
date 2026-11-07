"""Deterministic geometry-only preview renders for a staged car-part mesh.

This is *not* a browser/GPU capture. It reads the staged `mesh.json`
(object-space LOD0 positions + U32 indices), rasterises three fixed
orthographic views with a z-buffer and Lambert shading, and writes plain PNGs.
It proves that the staged mesh has a sane silhouette/bounds and gives the
integrator a quick visual reference. Materials/UVs are **not** sampled.

Usage:
  python probes/vehicle-pipeline/tools/render_preview.py --mesh <mesh.json> \
      --out-dir <dir> [--size 480x270]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import zlib
from pathlib import Path

# Fixed turntable samples. The model's forward axis is not claimed here.
VIEWS = (
    ("front34", 35.0, 14.0),
    ("rear34", 215.0, 12.0),
    ("side", 90.0, 4.0),
)
BASE = (0.78, 0.82, 0.88)
AMBIENT = 0.42
LIGHT = (-0.30, 0.75, 0.60)
BACKGROUND = (0.085, 0.095, 0.125)


def rotate(x: float, y: float, z: float, yaw: float, pitch: float) -> tuple[float, float, float]:
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    x1 = cy * x + sy * z
    z1 = -sy * x + cy * z
    y2 = cp * y - sp * z1
    z2 = sp * y + cp * z1
    return x1, y2, z2


def png_chunk(tag: bytes, payload: bytes) -> bytes:
    return (struct.pack(">I", len(payload)) + tag + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))


def write_png(path: Path, width: int, height: int, pixels: bytearray) -> None:
    raw = bytearray()
    stride = width * 3
    for row in range(height):
        raw.append(0)
        raw.extend(pixels[row * stride:(row + 1) * stride])
    document = (b"\x89PNG\r\n\x1a\n"
                + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                + png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
                + png_chunk(b"IEND", b""))
    path.write_bytes(document)


def render_view(mesh: dict, width: int, height: int, label: str,
                yaw_deg: float, pitch_deg: float) -> dict:
    positions = mesh["positions"]
    indices = mesh["indices"]
    vertex_count = mesh["vertexCount"]
    if len(positions) != vertex_count * 3 or len(indices) % 3:
        raise ValueError("mesh positions/indices do not match vertexCount")
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)
    projected = []
    for index in range(vertex_count):
        x, y, z = positions[index * 3:index * 3 + 3]
        projected.append(rotate(x, y, z, yaw, pitch))

    xs = [point[0] for point in projected]
    ys = [point[1] for point in projected]
    zs = [point[2] for point in projected]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    min_z, max_z = min(zs), max(zs)
    span_x = max(max_x - min_x, 1e-6)
    span_y = max(max_y - min_y, 1e-6)
    margin = 0.06
    scale = min(width * (1 - 2 * margin) / span_x,
                height * (1 - 2 * margin) / span_y)
    cx = (min_x + max_x) * 0.5
    cy = (min_y + max_y) * 0.5
    screen_points = [(width * 0.5 + (point[0] - cx) * scale,
                      height * 0.5 - (point[1] - cy) * scale,
                      point[2]) for point in projected]

    pixels = bytearray()
    background_bytes = bytes(int(channel * 255) for channel in BACKGROUND)
    pixels.extend(background_bytes * (width * height))
    zbuffer = [float("-inf")] * (width * height)
    light_length = math.sqrt(sum(channel * channel for channel in LIGHT))
    lx, ly, lz = (channel / light_length for channel in LIGHT)

    for tri in range(len(indices) // 3):
        ia, ib, ic = indices[tri * 3:tri * 3 + 3]
        if ia >= vertex_count or ib >= vertex_count or ic >= vertex_count:
            raise ValueError(f"index outside vertexCount at triangle {tri}")
        ax, ay, az = screen_points[ia]
        bx, by, bz = screen_points[ib]
        cx2, cy2, cz = screen_points[ic]
        area = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax)
        if area <= 1e-9:
            continue
        min_px = max(0, int(math.floor(min(ax, bx, cx2))))
        max_px = min(width - 1, int(math.ceil(max(ax, bx, cx2))))
        min_py = max(0, int(math.floor(min(ay, by, cy2))))
        max_py = min(height - 1, int(math.ceil(max(ay, by, cy2))))
        if min_px > max_px or min_py > max_py:
            continue
        inv_area = 1.0 / area
        x0, y0, z0 = positions[ia * 3:ia * 3 + 3]
        x1, y1, z1 = positions[ib * 3:ib * 3 + 3]
        x2, y2, z2 = positions[ic * 3:ic * 3 + 3]
        ux, uy, uz = x1 - x0, y1 - y0, z1 - z0
        vx, vy, vz = x2 - x0, y2 - y0, z2 - z0
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        nlen = math.sqrt(nx * nx + ny * ny + nz * nz)
        if nlen <= 1e-12:
            continue
        nxr, nyr, nzr = rotate(nx / nlen, ny / nlen, nz / nlen, yaw, pitch)
        light = abs(nxr * lx + nyr * ly + nzr * lz)
        shade = AMBIENT + (1.0 - AMBIENT) * light
        red = min(255, int(BASE[0] * shade * 255))
        green = min(255, int(BASE[1] * shade * 255))
        blue = min(255, int(BASE[2] * shade * 255))
        for py in range(min_py, max_py + 1):
            sample_y = py + 0.5
            row = py * width
            for px in range(min_px, max_px + 1):
                sample_x = px + 0.5
                w0 = ((bx - sample_x) * (cy2 - sample_y)
                      - (by - sample_y) * (cx2 - sample_x)) * inv_area
                if w0 < 0.0:
                    continue
                w1 = ((cx2 - sample_x) * (ay - sample_y)
                      - (cy2 - sample_y) * (ax - sample_x)) * inv_area
                if w1 < 0.0:
                    continue
                w2 = 1.0 - w0 - w1
                if w2 < 0.0:
                    continue
                slot = row + px
                depth = w0 * az + w1 * bz + w2 * cz
                if depth <= zbuffer[slot]:
                    continue
                zbuffer[slot] = depth
                offset = slot * 3
                pixels[offset] = red
                pixels[offset + 1] = green
                pixels[offset + 2] = blue

    background_rgb = tuple(int(channel * 255) for channel in BACKGROUND)
    covered = 0
    for slot in range(width * height):
        offset = slot * 3
        if (pixels[offset], pixels[offset + 1], pixels[offset + 2]) != background_rgb:
            covered += 1
    return {
        "label": label,
        "pixels": pixels,
        "coverage": round(covered / (width * height), 6),
        "boundsRotated": {
            "min": [round(min_x, 6), round(min_y, 6), round(min_z, 6)],
            "max": [round(max_x, 6), round(max_y, 6), round(max_z, 6)],
        },
    }


def render_all(mesh: dict, width: int, height: int, out_dir: Path) -> list[dict]:
    results = []
    for label, yaw_deg, pitch_deg in VIEWS:
        view = render_view(mesh, width, height, label, yaw_deg, pitch_deg)
        target = out_dir / f"preview-{label}.png"
        write_png(target, width, height, view["pixels"])
        results.append({
            "view": label,
            "yawDegrees": yaw_deg,
            "pitchDegrees": pitch_deg,
            "path": target.as_posix(),
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "bytes": target.stat().st_size,
            "coverage": view["coverage"],
            "boundsRotated": view["boundsRotated"],
        })
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mesh", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--size", default="480x270")
    args = parser.parse_args()

    width, height = (int(value) for value in args.size.lower().split("x"))
    mesh = json.loads(args.mesh.read_text(encoding="utf-8"))
    args.out_dir.mkdir(parents=True, exist_ok=True)
    views = render_all(mesh, width, height, args.out_dir)
    print(json.dumps({"mesh": str(args.mesh), "size": [width, height], "views": views},
                     indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
