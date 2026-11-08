"""Collision ground index for course validation (read-only inputs).

Two loaders:
  * `load_oracle_triangles(levelphysics_bytes)` re-uses the committed
    collision-oracle parser (`probes/collision-oracle/tests/reference_oracle.py`)
    exactly as the T-005/P48 work does.
  * `load_slice_triangles(package_dir)` reads the committed map-slice
    `collision.positions.f32.bin` / `collision.indices.u32.bin` pair (the
    `physics_scan.py` decode used for levels whose first import shape is a Box).

`GroundIndex` buckets triangles on a fixed XZ cell and returns the highest
up-facing triangle under a point. This is a measurement helper, not a physics
engine.
"""
from __future__ import annotations

import struct
from pathlib import Path


def load_oracle_triangles(data: bytes):
    """Return (positions, indices, source) from a Level.levelphysics buffer."""
    import sys
    root = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(root / "probes" / "collision-oracle" / "tests"))
    import reference_oracle as oracle  # noqa: E402

    level = oracle.load_level(data)
    positions = []
    indices = []
    for mesh in level["meshes"]:
        for tri in mesh["triangles"]:
            node = mesh["nodes"][mesh["leaves"][tri["leaf"]]["node"]]
            # Vertices are addressed per node; rebuild the triangle in node space
            # so we do not depend on the per-node vertex table ordering above.
            a = oracle.leaf_vertex(mesh, node, tri["a"])
            b = oracle.leaf_vertex(mesh, node, tri["b"])
            c = oracle.leaf_vertex(mesh, node, tri["c"])
            idx = len(positions)
            positions.extend([a, b, c])
            indices.extend([idx, idx + 1, idx + 2])
    return [c for p in positions for c in p], indices, {"kind": "collision-oracle", "triangles": len(indices) // 3}


def load_slice_triangles(package_dir):
    package = Path(package_dir)
    pos_raw = (package / "collision.positions.f32.bin").read_bytes()
    idx_raw = (package / "collision.indices.u32.bin").read_bytes()
    count = len(pos_raw) // 12
    positions = list(struct.unpack("<%df" % (count * 3), pos_raw))
    indices = list(struct.unpack("<%dI" % (len(idx_raw) // 4), idx_raw))
    return positions, indices, {
        "kind": "map-slice", "vertices": count, "triangles": len(indices) // 3,
        "positionsSha256": sha256(pos_raw), "indicesSha256": sha256(idx_raw),
    }


def sha256(data: bytes) -> str:
    import hashlib
    return hashlib.sha256(data).hexdigest()


class GroundIndex:
    def __init__(self, positions, indices, cell: float = 8.0):
        self.positions = positions
        self.indices = indices
        self.cell = cell
        self.buckets: dict[tuple[int, int], list[int]] = {}
        self.min_y = float("inf")
        self.max_y = float("-inf")
        for t in range(0, len(indices), 3):
            i0, i1, i2 = indices[t], indices[t + 1], indices[t + 2]
            ax, ay, az = positions[3 * i0], positions[3 * i0 + 1], positions[3 * i0 + 2]
            bx, by, bz = positions[3 * i1], positions[3 * i1 + 1], positions[3 * i1 + 2]
            cx, cy, cz = positions[3 * i2], positions[3 * i2 + 1], positions[3 * i2 + 2]
            self.min_y = min(self.min_y, ay, by, cy)
            self.max_y = max(self.max_y, ay, by, cy)
            x0 = int(min(ax, bx, cx) // cell)
            x1 = int(max(ax, bx, cx) // cell)
            z0 = int(min(az, bz, cz) // cell)
            z1 = int(max(az, bz, cz) // cell)
            for gx in range(x0, x1 + 1):
                for gz in range(z0, z1 + 1):
                    self.buckets.setdefault((gx, gz), []).append(t)

    def _triangles_at(self, x: float, z: float):
        key = (int(x // self.cell), int(z // self.cell))
        return self.buckets.get(key, ())

    def hit(self, x: float, z: float, up_only: bool = True):
        """Highest triangle containing (x, z); returns dict or None."""
        best = None
        p = self.positions
        for t in self._triangles_at(x, z):
            i0, i1, i2 = self.indices[t], self.indices[t + 1], self.indices[t + 2]
            ax, ay, az = p[3 * i0], p[3 * i0 + 1], p[3 * i0 + 2]
            bx, by, bz = p[3 * i1], p[3 * i1 + 1], p[3 * i1 + 2]
            cx, cy, cz = p[3 * i2], p[3 * i2 + 1], p[3 * i2 + 2]
            det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
            if det == 0.0:
                continue
            l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det
            l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det
            l3 = 1.0 - l1 - l2
            eps = -1e-9
            if l1 < eps or l2 < eps or l3 < eps:
                continue
            y = l1 * ay + l2 * by + l3 * cy
            # up-facing normal test (Y component of the cross product)
            nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
            ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
            nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
            if up_only and ny <= 0.0:
                continue
            if best is None or y > best["y"]:
                best = {"y": y, "triangle": t // 3, "normalY": ny}
        return best
