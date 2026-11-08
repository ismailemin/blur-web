"""Shared, read-only helpers for the PWR6 runtime pickup placement set.

Nothing here writes game data. The module provides:

  * the committed PAK/XT decode chain (same chain as PWR3/PWR5);
  * bounded triangle geometry queries against the committed collision mesh and
    the committed draw buffers;
  * projection of a point onto the measured e1-drive polyline with a signed
    lateral offset.

The geometry query is deliberately conservative: a triangle is indexed into
every 8 m cell its XZ bounds touch, so a vertical query only has to look at the
cell containing the point. Distances are exact (point/triangle closest point),
and "no triangle within the search box" is returned as `None`, never as a
guessed number.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "powerups" / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "map-pipeline" / "tools"))

import xt_decode  # noqa: E402

CELL_METRES = 8.0
SEARCH_RADIUS_METRES = 12.0
STEEP_NORMAL_Y = 0.5  # map-slice classification: |normal.y| < 0.5 is "steep"
DRIVABLE_NORMAL_Y = 0.94  # P48/Amboy/Gracia <= 20 degree heuristic


# ------------------------------------------------------------------ geometry
def normal_of(a, b, c):
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx = uy * vz - uz * vy
    ny = uz * vx - ux * vz
    nz = ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    if length < 1e-12:
        return None
    return (nx / length, ny / length, nz / length)


def point_triangle_distance(p, a, b, c):
    """Exact distance from point p to triangle abc (Ericson, RTCD 5.1.5)."""
    px, py, pz = p
    ax, ay, az = a
    bx, by, bz = b
    cx, cy, cz = c
    abx, aby, abz = bx - ax, by - ay, bz - az
    acx, acy, acz = cx - ax, cy - ay, cz - az
    apx, apy, apz = px - ax, py - ay, pz - az
    d1 = abx * apx + aby * apy + abz * apz
    d2 = acx * apx + acy * apy + acz * apz
    if d1 <= 0.0 and d2 <= 0.0:
        return math.sqrt(apx * apx + apy * apy + apz * apz)
    bpx, bpy, bpz = px - bx, py - by, pz - bz
    d3 = abx * bpx + aby * bpy + abz * bpz
    d4 = acx * bpx + acy * bpy + acz * bpz
    if d3 >= 0.0 and d4 <= d3:
        return math.sqrt(bpx * bpx + bpy * bpy + bpz * bpz)
    vc = d1 * d4 - d3 * d2
    if vc <= 0.0 and d1 >= 0.0 and d3 <= 0.0:
        denom = d1 - d3
        v = d1 / denom if denom else 0.0
        qx, qy, qz = ax + v * abx, ay + v * aby, az + v * abz
        return math.sqrt((px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2)
    cpx, cpy, cpz = px - cx, py - cy, pz - cz
    d5 = abx * cpx + aby * cpy + abz * cpz
    d6 = acx * cpx + acy * cpy + acz * cpz
    if d6 >= 0.0 and d5 <= d6:
        return math.sqrt(cpx * cpx + cpy * cpy + cpz * cpz)
    vb = d5 * d2 - d1 * d6
    if vb <= 0.0 and d2 >= 0.0 and d6 <= 0.0:
        denom = d2 - d6
        w = d2 / denom if denom else 0.0
        qx, qy, qz = ax + w * acx, ay + w * acy, az + w * acz
        return math.sqrt((px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2)
    va = d3 * d6 - d5 * d4
    if va <= 0.0 and (d4 - d3) >= 0.0 and (d5 - d6) >= 0.0:
        denom = (d4 - d3) + (d5 - d6)
        w = (d4 - d3) / denom if denom else 0.0
        qx, qy, qz = bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz)
        return math.sqrt((px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2)
    denom = va + vb + vc
    if abs(denom) < 1e-18:
        return min(
            math.dist(p, a), math.dist(p, b), math.dist(p, c))
    v = vb / denom
    w = vc / denom
    qx = ax + abx * v + acx * w
    qy = ay + aby * v + acy * w
    qz = az + abz * v + acz * w
    return math.sqrt((px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2)


def barycentric_y(a, b, c, x, z):
    """Height at (x, z) if the triangle contains it, else None."""
    ax, az = a[0], a[2]
    bx, bz = b[0], b[2]
    cx, cz = c[0], c[2]
    det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
    if abs(det) < 1e-12:
        return None
    u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det
    v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det
    w = 1.0 - u - v
    if u < -1e-9 or v < -1e-9 or w < -1e-9:
        return None
    return u * a[1] + v * b[1] + w * c[1]


class TriangleGrid:
    """XZ grid of triangles: exact vertical query + bounded near query."""

    def __init__(self, triangles, cell=CELL_METRES):
        self.cell = cell
        self.triangles = triangles
        self.cells = {}
        for index, tri in enumerate(triangles):
            xs = (tri[0][0], tri[1][0], tri[2][0])
            zs = (tri[0][2], tri[1][2], tri[2][2])
            x0 = math.floor(min(xs) / cell)
            x1 = math.floor(max(xs) / cell)
            z0 = math.floor(min(zs) / cell)
            z1 = math.floor(max(zs) / cell)
            if (x1 - x0 + 1) * (z1 - z0 + 1) > 4096:
                # Degenerate/oversized triangle: index its centroid only and
                # let the near query find it through the centroid cell. Such
                # triangles are counted in `oversizedTriangles`.
                x0 = x1 = math.floor(((min(xs) + max(xs)) / 2) / cell)
                z0 = z1 = math.floor(((min(zs) + max(zs)) / 2) / cell)
            for cx in range(x0, x1 + 1):
                for cz in range(z0, z1 + 1):
                    self.cells.setdefault((cx, cz), []).append(index)

    def cell_triangles(self, x, z):
        return self.cells.get((math.floor(x / self.cell), math.floor(z / self.cell)), [])

    def near_triangles(self, x, z, radius=SEARCH_RADIUS_METRES):
        cells = int(math.ceil(radius / self.cell)) + 1
        cx = math.floor(x / self.cell)
        cz = math.floor(z / self.cell)
        seen = set()
        out = []
        for ix in range(cx - cells, cx + cells + 1):
            for iz in range(cz - cells, cz + cells + 1):
                for index in self.cells.get((ix, iz), ()):
                    if index not in seen:
                        seen.add(index)
                        out.append(index)
        return out

    def vertical(self, x, z, y):
        """Ground below, first surface above, and wall/cover metrics at (x, z)."""
        below = None  # highest up-facing triangle at or below y
        above = None  # lowest triangle above y
        highest = None  # highest up-facing triangle regardless of y
        for index in self.cell_triangles(x, z):
            a, b, c, normal = self.triangles[index]
            height = barycentric_y(a, b, c, x, z)
            if height is None:
                continue
            if normal[1] > 0.1:
                if highest is None or height > highest[0]:
                    highest = (height, normal[1])
                if height <= y + 1e-3 and (below is None or height > below[0]):
                    below = (height, normal[1])
            if height > y + 1e-3 and (above is None or height < above[0]):
                above = (height, None)
        return highest, below, above

    def nearest_wall(self, p, radius=SEARCH_RADIUS_METRES):
        best = None
        for index in self.near_triangles(p[0], p[2], radius):
            a, b, c, normal = self.triangles[index]
            if abs(normal[1]) > STEEP_NORMAL_Y:
                continue
            distance = point_triangle_distance(p, a, b, c)
            if best is None or distance < best:
                best = distance
        # `None` means "no steep triangle within `radius`", a typed result.
        return best if best is not None and best <= radius else None


def load_collision_triangles(level_path):
    import physics_scan  # committed read-only map-pipeline scanner

    level = physics_scan.scan_level(level_path.read_bytes())
    triangles = []
    for a, b, c in physics_scan.flatten_static_triangles(level):
        normal = normal_of(a, b, c)
        if normal is None:
            continue
        triangles.append((a, b, c, normal))
    return triangles


def _read_f32(path):
    import array

    data = array.array("f")
    with path.open("rb") as stream:
        data.frombytes(stream.read())
    if sys.byteorder == "big":
        data.byteswap()
    return data


def _read_u32(path):
    import array

    data = array.array("I")
    with path.open("rb") as stream:
        data.frombytes(stream.read())
    if sys.byteorder == "big":
        data.byteswap()
    return data


def load_draw_triangles(package_dir):
    """Read the committed map-slice draw buffers (positions + indices)."""
    positions = _read_f32(package_dir / "draws.positions.f32.bin")
    indices = _read_u32(package_dir / "draws.indices.u32.bin")
    if len(indices) % 3:
        raise ValueError("draw index count is not a multiple of 3")
    triangles = []
    for i in range(0, len(indices), 3):
        a = (positions[indices[i] * 3], positions[indices[i] * 3 + 1], positions[indices[i] * 3 + 2])
        b = (positions[indices[i + 1] * 3], positions[indices[i + 1] * 3 + 1], positions[indices[i + 1] * 3 + 2])
        c = (positions[indices[i + 2] * 3], positions[indices[i + 2] * 3 + 1], positions[indices[i + 2] * 3 + 2])
        normal = normal_of(a, b, c)
        if normal is None:
            continue
        triangles.append((a, b, c, normal))
    return triangles


# ---------------------------------------------------------------- projection
def project_polyline(poly, x, z):
    """Planar projection with arc, nearest point and signed 2D cross offset."""
    best = None
    arc = 0.0
    for i in range(len(poly) - 1):
        ax, az = poly[i]
        bx, bz = poly[i + 1]
        dx, dz = bx - ax, bz - az
        length2 = dx * dx + dz * dz
        t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / length2))
        qx, qz = ax + t * dx, az + t * dz
        distance = math.hypot(x - qx, z - qz)
        if best is None or distance < best["distance"]:
            length = math.sqrt(length2)
            tx, tz = (dx / length, dz / length) if length else (0.0, 0.0)
            cross = tx * (z - qz) - tz * (x - qx)
            best = {
                "distance": distance,
                "arc": arc + t * length,
                "point": [qx, qz],
                "segment": i,
                "tangent": [tx, tz],
                "tangentYawRadians": math.atan2(tx, tz),
                "signedCross2d": cross,
            }
        arc += math.sqrt(length2)
    return best


def yaw_from_forward(forward):
    """Engine convention: forward (x, z) = (sin yaw, cos yaw)."""
    return math.atan2(forward[0], forward[2])


def normalize_angle(value):
    while value <= -math.pi:
        value += 2.0 * math.pi
    while value > math.pi:
        value -= 2.0 * math.pi
    return value
