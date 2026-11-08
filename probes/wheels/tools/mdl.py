"""Independent, bounded reader for the wheel data of one PC vehicle model.

This module deliberately does **not** import or reuse
`probes/car-parts/tools/build_manifest.py`. It re-implements only the two reads
the wheel-corner proof needs, from the documented format:

  * `MdlDat` (`C_ModelData::Read`) — element names, HMat43 matrices and local
    `C_AxisBox` bounds for model index 0, plus the model/string tables.
  * the committed native `scene_inspect.exe` first-RenderList LOD0 draw list —
    positions, U32 indices and `(firstIndex, indexCount)` ranges.

Everything else (AABBs, masks, signatures) is computed here, so a corner proof
can be reproduced without trusting the car-parts builder's classification.

Format references: `probes/asset-reader/FORMAT-model.md`, the same PC file-block
layout the committed builder documents. A field that does not match is an error,
never a guess.
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCENE_EXE = ROOT / "_work/build/asset-reader-native/Release/scene_inspect.exe"

MAX_MODEL_BYTES = 64 * 1024 * 1024
MAX_STRINGS = 4096
MAX_STRING_BYTES = 1 << 20


class Unsupported(RuntimeError):
    """The data cannot support the requested proof; the reason is exact."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_block(data: bytes, offset: int, limit: int) -> dict:
    if offset < 0 or offset + 16 > limit:
        raise Unsupported(f"truncated file-block header at {offset}")
    ident = data[offset:offset + 8]
    name = ident.split(b"\0", 1)[0]
    if not name or any(byte < 0x20 or byte > 0x7E for byte in name):
        raise Unsupported(f"invalid file-block id at {offset}")
    if any(ident[len(name):]):
        raise Unsupported(f"non-zero id padding at {offset}")
    size, count = struct.unpack_from("<IH", data, offset + 8)
    kind, compression = data[offset + 14], data[offset + 15]
    if size < 16 or offset + size > limit:
        raise Unsupported(f"file-block {name!r} size {size} exceeds input at {offset}")
    if kind not in (0x41, 0x43):
        raise Unsupported(f"unsupported file-block type {kind:#x} at {offset}")
    if kind == 0x43 and compression != 0:
        raise Unsupported(f"compressed container {name!r} at {offset}")
    return {
        "id": name.decode("ascii"),
        "offset": offset,
        "bytes": size,
        "count": count,
        "type": kind,
        "payloadOffset": offset + 16,
        "payloadBytes": size - 16,
        "end": offset + size,
    }


def child_blocks(data: bytes, parent: dict) -> list[dict]:
    result = []
    cursor = parent["payloadOffset"]
    for _ in range(parent["count"]):
        block = read_block(data, cursor, parent["end"])
        result.append(block)
        cursor = block["end"]
    if cursor != parent["end"]:
        raise Unsupported(f"container {parent['id']!r} children do not fill their size")
    return result


class Span:
    def __init__(self, data: bytes, offset: int, end: int, what: str):
        self.data = data
        self.cursor = offset
        self.end = end
        self.what = what

    def need(self, count: int) -> None:
        if count < 0 or self.cursor + count > self.end:
            raise Unsupported(f"truncated {self.what} at {self.cursor}")

    def i32(self) -> int:
        self.need(4)
        value = struct.unpack_from("<i", self.data, self.cursor)[0]
        self.cursor += 4
        return value

    def u32(self) -> int:
        self.need(4)
        value = struct.unpack_from("<I", self.data, self.cursor)[0]
        self.cursor += 4
        return value

    def f32x3(self) -> tuple[float, float, float]:
        self.need(12)
        values = struct.unpack_from("<fff", self.data, self.cursor)
        self.cursor += 12
        if not all(math.isfinite(value) for value in values):
            raise Unsupported(f"non-finite float in {self.what}")
        return values

    def remaining(self) -> int:
        return self.end - self.cursor


def parse_mdldat(data: bytes) -> dict:
    """Parse the MdlDat block of a decoded PC `.model` payload."""
    if len(data) > MAX_MODEL_BYTES:
        raise Unsupported(f"model is larger than {MAX_MODEL_BYTES} bytes")
    if data[:4] != b"  CP":
        raise Unsupported("model does not start with the PC fourcc marker")
    model = read_block(data, 4, len(data))
    if model["id"] != "Model" or model["type"] != 0x43:
        raise Unsupported("first top-level block is not a Model container")
    mdldat = next((block for block in child_blocks(data, model) if block["id"] == "MdlDat"), None)
    if mdldat is None or mdldat["type"] != 0x41:
        raise Unsupported("Model has no MdlDat data block")

    blocks = []
    cursor = mdldat["payloadOffset"]
    while cursor < mdldat["end"]:
        block = read_block(data, cursor, mdldat["end"])
        blocks.append(block)
        cursor = block["end"]
    by_id = {block["id"]: block for block in blocks}
    for required in ("Header", "StrTab", "Models", "Element"):
        if required not in by_id:
            raise Unsupported(f"MdlDat is missing {required}")

    header = by_id["Header"]
    span = Span(data, header["payloadOffset"], header["end"], "MdlDat Header")
    version = span.i32()
    model_count = span.i32()
    element_count = span.i32()
    constraint_count = span.i32()
    if version not in (0, 1):
        raise Unsupported(f"unsupported MdlDat version {version}")
    if not (0 <= model_count <= 4096 and 0 <= element_count <= 65536):
        raise Unsupported("MdlDat counts out of range")
    bounds = None
    if version >= 1:
        bounds = {"min": list(span.f32x3()), "max": list(span.f32x3())}
    if span.remaining() != 0:
        raise Unsupported("MdlDat Header has trailing bytes")

    strtab = by_id["StrTab"]
    span = Span(data, strtab["payloadOffset"], strtab["end"], "MdlDat StrTab")
    count = span.u32()
    if count > MAX_STRINGS:
        raise Unsupported("StrTab string count exceeds limit")
    offsets = [span.u32() for _ in range(count)]
    data_bytes = span.u32()
    if data_bytes > MAX_STRING_BYTES:
        raise Unsupported("StrTab data exceeds limit")
    span.need(data_bytes)
    raw = data[span.cursor:span.cursor + data_bytes]
    span.cursor += data_bytes
    if span.remaining() != 0:
        raise Unsupported("StrTab has trailing bytes")
    strings = []
    for index, offset in enumerate(offsets):
        if offset >= len(raw) or (index + 1 < len(offsets) and offsets[index + 1] < offset):
            raise Unsupported("StrTab offset out of range or unordered")
        end = raw.find(b"\0", offset)
        if end < 0:
            raise Unsupported("StrTab string is not NUL-terminated")
        strings.append(raw[offset:end].decode("ascii", "strict"))

    models_block = by_id["Models"]
    expected = model_count * (48 + 24 + 4 * 4 + 3 * 4)
    if models_block["payloadBytes"] != expected:
        raise Unsupported(f"Models payload {models_block['payloadBytes']} != {expected}")
    span = Span(data, models_block["payloadOffset"], models_block["end"], "Models")
    models = []
    for index in range(model_count):
        matrix = [span.f32x3() for _ in range(4)]
        local_min = span.f32x3() if version >= 1 else None
        local_max = span.f32x3() if version >= 1 else None
        name_id = span.i32()
        element_index = span.i32()
        element_count_field = span.i32()
        first_element = span.i32()
        parent = span.i32()
        first_child = span.i32()
        next_sibling = span.i32()
        if not 0 <= name_id < len(strings):
            raise Unsupported(f"model {index} name id out of range")
        for link in (parent, first_child, next_sibling):
            if link < -1 or link >= model_count:
                raise Unsupported(f"model {index} link out of range")
        models.append({
            "index": index,
            "name": strings[name_id],
            "matrix": [list(row) for row in matrix],
            "min": list(local_min) if local_min else None,
            "max": list(local_max) if local_max else None,
            "elementIndex": element_index,
            "elementCount": element_count_field,
            "firstElement": first_element,
            "parent": parent,
        })

    element_block = by_id["Element"]
    expected = element_count * (4 + 48 + 24 + 4 * 4 + 3 * 4)
    if element_block["payloadBytes"] != expected:
        raise Unsupported(f"Element payload {element_block['payloadBytes']} != {expected}")
    span = Span(data, element_block["payloadOffset"], element_block["end"], "Element")
    elements = []
    for index in range(element_count):
        model_index = span.i32()
        matrix = [span.f32x3() for _ in range(4)]
        local_min = span.f32x3()
        local_max = span.f32x3()
        name_id = span.i32()
        element_index = span.i32()
        parent = span.i32()
        first_child = span.i32()
        next_sibling = span.i32()
        render_mesh_id = span.i32()
        physics_shape_id = span.u32()
        if not 0 <= model_index < model_count:
            raise Unsupported(f"element {index} model index out of range")
        if not 0 <= name_id < len(strings):
            raise Unsupported(f"element {index} name id out of range")
        for link in (parent, first_child, next_sibling):
            if link < -1 or link >= element_count:
                raise Unsupported(f"element {index} link out of range")
        elements.append({
            "index": index,
            "modelIndex": model_index,
            "name": strings[name_id],
            "matrix": [list(row) for row in matrix],
            "translation": list(matrix[3]),
            "min": list(local_min),
            "max": list(local_max),
            "elementIndex": element_index,
            "parent": parent,
            "firstChild": first_child,
            "nextSibling": next_sibling,
            "renderMeshId": render_mesh_id,
            "physicsShapeId": physics_shape_id,
        })
    return {
        "sha256": sha256(data[mdldat["offset"]:mdldat["end"]]),
        "offset": mdldat["offset"],
        "bytes": mdldat["bytes"],
        "version": version,
        "bounds": bounds,
        "models": models,
        "elements": elements,
        "strings": strings,
    }


def read_scene(model_path: Path, scene_json: Path | None = None,
               scene_exe: Path = SCENE_EXE) -> dict:
    """First-RenderList LOD0 geometry from the committed native reader."""
    if scene_json is not None:
        return json.loads(Path(scene_json).read_text(encoding="utf-8"))
    if not scene_exe.is_file():
        raise Unsupported(f"missing scene reader: {scene_exe}")
    completed = subprocess.run([str(scene_exe), str(model_path)], capture_output=True,
                               text=True, encoding="utf-8")
    if completed.returncode != 0:
        raise Unsupported(f"scene reader exit {completed.returncode}: {completed.stderr[-500:]}")
    scene = json.loads(completed.stdout)
    if scene.get("status") != "ok":
        raise Unsupported(f"scene reader status: {scene.get('status')}")
    return scene


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

@dataclass
class Draw:
    index: int
    first_index: int
    index_count: int
    bounds_min: list[float]
    bounds_max: list[float]
    vertex_count: int
    points: list[tuple[float, float, float]] = field(default_factory=list)
    signature: str = ""

    @property
    def center(self) -> list[float]:
        return [(self.bounds_min[i] + self.bounds_max[i]) / 2.0 for i in range(3)]

    @property
    def extent(self) -> list[float]:
        return [self.bounds_max[i] - self.bounds_min[i] for i in range(3)]


def build_draws(scene: dict) -> list[Draw]:
    positions = scene["positions"]
    indices = scene["indices"]
    draws = []
    for index, raw in enumerate(scene["draws"]):
        first, count = raw["firstIndex"], raw["indexCount"]
        if count <= 0 or count % 3 != 0 or first + count > len(indices):
            raise Unsupported(f"draw {index} has an invalid index range {first}+{count}")
        used = set(indices[first:first + count])
        if not used:
            raise Unsupported(f"draw {index} has an empty index range")
        points = [(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]) for v in used]
        point_list = sorted(points)
        digest = hashlib.sha256()
        for point in point_list:
            digest.update(struct.pack("<fff", *point))
        lo = [min(point[axis] for point in points) for axis in range(3)]
        hi = [max(point[axis] for point in points) for axis in range(3)]
        draws.append(Draw(index=index, first_index=first, index_count=count,
                          bounds_min=lo, bounds_max=hi, vertex_count=len(used),
                          points=point_list, signature=digest.hexdigest()))
    return draws


def union(draws: list[Draw]) -> tuple[list[float], list[float]]:
    lo = [min(draw.bounds_min[axis] for draw in draws) for axis in range(3)]
    hi = [max(draw.bounds_max[axis] for draw in draws) for axis in range(3)]
    return lo, hi


def aabb_cost(lo_a, hi_a, lo_b, hi_b) -> float:
    """Symmetric-difference length of two axis-aligned boxes (metres)."""
    return sum(abs(lo_a[k] - lo_b[k]) + abs(hi_a[k] - hi_b[k]) for k in range(3))


def contains(outer_lo, outer_hi, inner_lo, inner_hi, tol: float) -> bool:
    return all(inner_lo[k] >= outer_lo[k] - tol and inner_hi[k] <= outer_hi[k] + tol
               for k in range(3))


def point_cloud_within(points_a, points_b, tol: float) -> bool:
    """Every point of A is within `tol` of some point of B (and vice versa)."""
    if len(points_a) != len(points_b):
        return False

    def covered(source, target):
        cell = max(tol, 1e-9)
        grid: dict[tuple[int, int, int], list[tuple[float, float, float]]] = {}
        for point in target:
            key = (math.floor(point[0] / cell), math.floor(point[1] / cell),
                   math.floor(point[2] / cell))
            grid.setdefault(key, []).append(point)
        limit = tol * tol
        for point in source:
            base = (math.floor(point[0] / cell), math.floor(point[1] / cell),
                    math.floor(point[2] / cell))
            found = False
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        for other in grid.get((base[0] + dx, base[1] + dy, base[2] + dz), ()):
                            ddx = point[0] - other[0]
                            ddy = point[1] - other[1]
                            ddz = point[2] - other[2]
                            if ddx * ddx + ddy * ddy + ddz * ddz <= limit:
                                found = True
                                break
                        if found:
                            break
                    if found:
                        break
                if found:
                    break
            if not found:
                return False
        return True

    return covered(points_a, points_b) and covered(points_b, points_a)


def mirror_points(points):
    """Mirror a point cloud across the element-local YZ plane."""
    return sorted((-point[0], point[1], point[2]) for point in points)
