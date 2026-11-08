#!/usr/bin/env python3
"""Shared, bounded readers for the level instance and decal census.

This module is the producer-side foundation for ``probes/instances``. It reads
only the original level archives (``level.levelrender`` / ``level.levelstream``)
through the committed Python readers under ``tools/`` and the committed texture
decoder binary. It does not modify game data, the asset reader, the map-slice
packages or any other probe.

Scope vocabulary:

* a *section* is one RenderList serialized in one LOD0 item of one Scene stream
  record. The map-slice packages only ever consumed the **first** RenderList of
  a chunk item; this census consumes every serialized RenderList and labels the
  ones with ``renderListIndex > 0`` as ``activationUnproven``.
* an *instance* is one ``instances[i]`` record of a RenderList. Its mesh is the
  ``basePrimitives[instance.primitiveIndex]`` primitive it names.
* a *decal* is a direct ``primitives[i]`` whose effect is a ``Racification*``
  additive layer shader.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes/map-slice/tools"))

import numpy as np  # noqa: E402

from inspect_car_level_assets import render_layout, resource_prefix, stream_prefix  # noqa: E402
from inspect_car_materials import texture_lod  # noqa: E402
from inspect_level_instances import InstanceReader, constant_world, read_lists  # noqa: E402
from amboy_texture_bindings import TextureArchive  # noqa: E402

LEVELS = {
    "river": {
        "level": "usa_la_river",
        "prefix": "river",
        "package": None,
        "decoder": True,
    },
    "amboy": {
        "level": "usa_amboy",
        "prefix": "amboy",
        "package": "_work/map-slice/amboy-render",
        "decoder": False,
    },
    "gracia": {
        "level": "spa_barcelona_gracia",
        "prefix": "gracia",
        "package": "_work/map-slice/gracia-render",
        "decoder": False,
    },
    "longbeach": {
        "level": "usa_la_longbeachdocks",
        "prefix": "longbeach",
        "package": "_work/map-slice/longbeach-render",
        "decoder": False,
    },
}

TEXTURE_DECODER = ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe"
FX_DIR = ROOT / "upstream/BlurRebuilt/code/amax/game/Shaders/Racification"

FORMAT_NAMES = {
    0x31545844: "DXT1/BC1",
    0x33545844: "DXT3/BC2",
    0x35545844: "DXT5/BC3",
    21: "A8R8G8B8",
    22: "X8R8G8B8",
    32: "A8B8G8R8",
    33: "X8B8G8R8",
    28: "A8",
    50: "L8",
}

POSITION_FORMATS = {6: ("fff", 3), 9: ("eee", 3)}
# Committed direct-draw reader semantics: type 5 = F32_2, type 8 = F16_2,
# type 9 = F16_4 (the first two halves are UV0, exactly as scene_reader.cpp
# reads them for direct draws). The narrower instance path in the native reader
# only accepted type 8; this producer follows the committed direct reader.
UV0_FORMATS = {5: ("ff", 8), 8: ("ee", 4), 9: ("ee", 8)}

BOUNDS_TOLERANCE = 1e-4


class TypedError(ValueError):
    """An explicitly typed, non-guessed rejection."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def fnv1a64_bytes(data: bytes) -> int:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def fnv_mix_f32(value: int, component: float) -> int:
    for byte in struct.pack("<f", component):
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, doc, pretty: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if pretty:
        text = json.dumps(doc, indent=1, ensure_ascii=False, allow_nan=False) + "\n"
    else:
        text = json.dumps(doc, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")) + "\n"
    path.write_text(text, encoding="utf-8")


_OUTPUT_ROOT = None


def set_output_root(path) -> None:
    global _OUTPUT_ROOT
    _OUTPUT_ROOT = Path(path).resolve() if path is not None else None


def output_dir(short: str) -> Path:
    root = _OUTPUT_ROOT if _OUTPUT_ROOT is not None else ROOT / "_work/instances"
    return root / short


def layout_dir(short: str) -> Path:
    return ROOT / "_work/logs/instances"


def float_list(values) -> list[float]:
    return [float(v) for v in values]


def is_finite(values) -> bool:
    return all(isinstance(v, (int, float)) and math.isfinite(v) for v in values)


def matrix_scale(matrix) -> list[float]:
    return [math.sqrt(sum(matrix[k * 4 + a] ** 2 for k in range(3))) for a in range(3)]


def matrix_determinant(matrix) -> float:
    m = matrix
    return (m[0] * (m[5] * m[10] - m[6] * m[9])
            - m[1] * (m[4] * m[10] - m[6] * m[8])
            + m[2] * (m[4] * m[9] - m[5] * m[8]))


def transform_points(positions: np.ndarray, matrix) -> np.ndarray:
    m = np.asarray(matrix, dtype=np.float64).reshape(4, 4)
    xyz = positions.astype(np.float64)
    # Row-vector semantics: out[a] = x*m[a] + y*m[4+a] + z*m[8+a] + m[12+a].
    out = xyz[:, 0:1] * m[0:1, 0:3] + xyz[:, 1:2] * m[1:2, 0:3] + \
        xyz[:, 2:3] * m[2:3, 0:3] + m[3, 0:3]
    return out


def aabb(points: np.ndarray) -> dict:
    if points.size == 0:
        return {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0]}
    return {"min": [float(v) for v in points.min(axis=0)],
            "max": [float(v) for v in points.max(axis=0)]}


def bounds_record(record) -> dict:
    values = float_list(record)
    return {"min": values[0:3], "max": values[3:6],
            "distanceMin": values[6], "distanceMax": values[7],
            "raw": values}


def bounds_error(box: dict, record) -> float:
    values = float_list(record)
    error = max(abs(box["min"][a] - values[a]) for a in range(3))
    return max(error, max(abs(box["max"][a] - values[3 + a]) for a in range(3)))


def bounds_excess(box: dict, record) -> float:
    """How far a draw box leaves the archived (object) bound; <=0 means inside."""
    values = float_list(record)
    excess = max(values[a] - box["min"][a] for a in range(3))
    return max(excess, max(box["max"][a] - values[3 + a] for a in range(3)))


def bounds_tolerance(*values) -> float:
    """Absolute 1e-4 for |coordinate| < 2048, plus one float32 ULP above that."""
    maximum = 0.0
    for value in values:
        if isinstance(value, dict):
            maximum = max(maximum, *(abs(v) for v in value["min"]),
                          *(abs(v) for v in value["max"]))
        else:
            maximum = max(maximum, *(abs(float(v)) for v in value))
    return max(BOUNDS_TOLERANCE, 2.0 ** -23 * maximum)


def union_boxes(boxes: list[dict]) -> dict:
    return {"min": [min(b["min"][a] for b in boxes) for a in range(3)],
            "max": [max(b["max"][a] for b in boxes) for a in range(3)]}


class LevelData:
    """One level's scene table, block locator, node census and mesh decoder."""

    def __init__(self, short: str):
        if short not in LEVELS:
            raise ValueError("unknown level short name: " + short)
        self.short = short
        self.config = LEVELS[short]
        self.level = self.config["level"]
        self.level_dir = ROOT / "game-data/Blur/levels" / self.level
        self.render_path = self.level_dir / "level.levelrender"
        self.stream_path = self.level_dir / "level.levelstream"
        self.header = self.render_path.read_bytes()
        self.layout = render_layout(self.header, "level")
        self.scene = self.layout["scene"]
        self.records = self.scene["stream"]["chunks"]
        self.effects = self.scene["effects"]
        self.declarations = self.scene["declarations"]
        self.block_location = {}
        for record_index, record in enumerate(self.records):
            for item_index, item in enumerate(record["items"]):
                if item["lod"] == 0:
                    self.block_location[item["block"]] = (record_index, item_index)
        self._record_cache = {}
        self._item_cache = {}
        self._lists_cache = {}
        self._mesh_cache = {}
        self._archive = None

    # ----------------------------------------------------------- raw access
    def record_bytes(self, record_index: int) -> bytes:
        if record_index not in self._record_cache:
            record = self.records[record_index]
            with self.stream_path.open("rb") as handle:
                handle.seek(record["offset"])
                data = handle.read(record["storedBytes"])
            if len(data) != record["storedBytes"]:
                raise TypedError("shortStreamRead", "record %d short read" % record_index)
            self._record_cache[record_index] = data
        return self._record_cache[record_index]

    def item_context(self, record_index: int, item_index: int):
        key = (record_index, item_index)
        if key in self._item_cache:
            return self._item_cache[key]
        record = self.records[record_index]
        data = self.record_bytes(record_index)
        try:
            stream_prefix(data, record)
        except (ValueError, IndexError) as error:
            raise TypedError("streamPrefixRejected", str(error))
        cursor = 24
        target = None
        for number, item in enumerate(record["items"]):
            if item["lod"] != 0:
                raise TypedError("nonLod0Item", "record %d item %d" % (record_index, number))
            try:
                resources = resource_prefix(
                    data, {"resourcePayloadOffset": cursor, "scenePayloadOffset": 0},
                    streamed=True)
                lists = read_lists(data, resources)
                reader = InstanceReader(data, resources["parsedNodesEnd"])
                for _ in range(reader.count(16)):
                    texture_lod(reader, 0, 0)
                cursor = reader.p
            except (ValueError, IndexError, StopIteration, struct.error) as error:
                raise TypedError("itemParseRejected",
                                 "record %d item %d: %s" % (record_index, number, error))
            if number == item_index:
                target = (data, resources, lists)
                break
        if target is None:
            raise TypedError("itemIndexOutsideRecord", "record %d" % record_index)
        self._item_cache[key] = target
        return target

    def block_context(self, block: int):
        if block not in self.block_location:
            raise TypedError("blockMissing", "block %d has no LOD0 item" % block)
        record_index, item_index = self.block_location[block]
        return self.item_context(record_index, item_index)

    def block_record(self, block: int) -> dict:
        record_index, item_index = self.block_location[block]
        record = self.records[record_index]
        return {
            "block": block,
            "recordIndex": record_index,
            "itemIndex": item_index,
            "storedBytes": record["storedBytes"],
            "prerequisites": record.get("prerequisites", []),
        }

    # ------------------------------------------------------------- census
    def census(self) -> list[dict]:
        """Every RenderList serialized in every LOD0 item of the Scene stream."""
        rows = []
        for record_index, record in enumerate(self.records):
            try:
                data = self.record_bytes(record_index)
                stream_prefix(data, record)
            except (ValueError, IndexError, TypedError) as error:
                rows.append({"recordIndex": record_index, "status": "rejected",
                             "reason": str(error)})
                continue
            cursor = 24
            for item_index, item in enumerate(record["items"]):
                if item["lod"] != 0:
                    continue
                try:
                    resources = resource_prefix(
                        data, {"resourcePayloadOffset": cursor, "scenePayloadOffset": 0},
                        streamed=True)
                    lists = read_lists(data, resources)
                    reader = InstanceReader(data, resources["parsedNodesEnd"])
                    texture_count = reader.count(16)
                    for _ in range(texture_count):
                        texture_lod(reader, 0, 0)
                    next_cursor = reader.p
                except (ValueError, IndexError, StopIteration, struct.error) as error:
                    rows.append({"recordIndex": record_index, "itemIndex": item_index,
                                 "block": item["block"], "status": "rejected",
                                 "reason": "item parse: " + str(error)})
                    cursor = None
                    break
                for list_index, node in enumerate(lists):
                    rows.append({
                        "recordIndex": record_index,
                        "itemIndex": item_index,
                        "nodeBlock": item["block"],
                        "renderListIndex": list_index,
                        "nodeIndex": node.get("nodeIndex"),
                        "node": node,
                        "texturesInItem": texture_count,
                    })
                cursor = next_cursor
            if cursor is None:
                continue
        return rows

    # -------------------------------------------------------- primitives
    def position_uv_binding(self, node: dict, primitive: dict):
        """Resolve POSITION and UV0 elements, streams and buffer sources."""
        if not 0 <= primitive["declaration"] < len(self.declarations):
            raise TypedError("declarationMissing", "declaration index out of bounds")
        declaration = self.declarations[primitive["declaration"]]
        position = next((e for e in declaration
                         if e["usage"] == 0 and e["usageIndex"] == 0), None)
        if position is None:
            raise TypedError("positionDeclarationMissing", "no POSITION0 element")
        uv0 = next((e for e in declaration
                    if e["usage"] == 5 and e["usageIndex"] == 0), None)

        def select_stream(element, label):
            matches = [s for s in primitive["streams"]
                       if s["streamIndex"] == element["stream"] and s["frequency"] == 0]
            if len(matches) != 1:
                raise TypedError("streamBindingUnsupported",
                                 "%s stream %d has %d frequency-0 bindings"
                                 % (label, element["stream"], len(matches)))
            return matches[0]

        position_stream = select_stream(position, "POSITION")
        uv_stream = select_stream(uv0, "UV0") if uv0 is not None else None
        sources = node["sources"]
        if not 0 <= position_stream["vertexBuffer"] < len(sources["vertexBuffer"]):
            raise TypedError("vertexSourceOutOfRange", "POSITION vertex source")
        position_source = sources["vertexBuffer"][position_stream["vertexBuffer"]]
        if uv_stream is not None:
            if not 0 <= uv_stream["vertexBuffer"] < len(sources["vertexBuffer"]):
                raise TypedError("vertexSourceOutOfRange", "UV0 vertex source")
            uv_source = sources["vertexBuffer"][uv_stream["vertexBuffer"]]
            if uv_source != position_source:
                raise TypedError("uv0SecondaryVertexBuffer",
                                 "UV0 uses a different vertex source (%s vs %s)"
                                 % (uv_source, position_source))
        if not 0 <= primitive["indexBuffer"] < len(sources["indexBuffer"]):
            raise TypedError("indexSourceOutOfRange", "index source")
        index_source = sources["indexBuffer"][primitive["indexBuffer"]]
        if index_source["block"] != position_source["block"]:
            raise TypedError("crossBlockPrimitive",
                             "VB block %d, IB block %d" % (position_source["block"],
                                                           index_source["block"]))
        return {
            "declaration": primitive["declaration"],
            "topology": primitive["topology"],
            "position": position,
            "uv0": uv0,
            "positionStream": position_stream,
            "uv0Stream": uv_stream,
            "positionSource": position_source,
            "indexSource": index_source,
            "lod": primitive["lods"][0],
        }

    def mesh_key(self, binding: dict) -> tuple:
        lod = binding["lod"]
        pos = binding["position"]
        uv = binding["uv0"] or {}
        return (
            binding["positionSource"]["block"], binding["positionSource"]["index"],
            binding["indexSource"]["block"], binding["indexSource"]["index"],
            lod["offset"], lod["indexCount"], lod["minIndex"], lod["vertexCount"],
            binding["topology"], binding["declaration"],
            pos["type"], pos["method"], pos["offset"],
            uv.get("type"), uv.get("method"), uv.get("offset"),
            binding["positionStream"]["vertexOffset"],
            (binding["uv0Stream"] or {}).get("vertexOffset", 0),
        )

    def decode_mesh(self, node: dict, primitive: dict) -> dict:
        binding = self.position_uv_binding(node, primitive)
        key = self.mesh_key(binding)
        if key in self._mesh_cache:
            cached = self._mesh_cache[key]
            if isinstance(cached, TypedError):
                raise cached
            return cached
        try:
            mesh = self._decode_mesh_uncached(binding)
        except TypedError as error:
            self._mesh_cache[key] = error
            raise
        self._mesh_cache[key] = mesh
        return mesh

    def _decode_mesh_uncached(self, binding: dict) -> dict:
        block = binding["positionSource"]["block"]
        data, resources, _lists = self.block_context(block)
        vertex_source = binding["positionSource"]
        index_source = binding["indexSource"]
        if not 0 <= vertex_source["index"] < len(resources["vertexBuffers"]):
            raise TypedError("vertexBufferIndexOutOfRange",
                             "block %d VB index %d" % (block, vertex_source["index"]))
        if not 0 <= index_source["index"] < len(resources["indexBuffers"]):
            raise TypedError("indexBufferIndexOutOfRange",
                             "block %d IB index %d" % (block, index_source["index"]))
        vertex_buffer = resources["vertexBuffers"][vertex_source["index"]]
        index_buffer = resources["indexBuffers"][index_source["index"]]
        lod = binding["lod"]
        topology = binding["topology"]
        if topology not in (0, 1):
            raise TypedError("topologyUnsupported", "topology %d" % topology)
        position = binding["position"]
        if position["method"] != 0 or position["type"] not in POSITION_FORMATS:
            raise TypedError("positionTypeUnsupported",
                             "POSITION type %d method %d" % (position["type"], position["method"]))
        fmt, components = POSITION_FORMATS[position["type"]]
        if components != 3:
            raise TypedError("positionTypeUnsupported", "POSITION component count")
        stored = next((e for e in vertex_buffer["elements"]
                       if e["usage"] == 0 and e["usageIndex"] == 0), None)
        if stored is None or any(stored[k] != position[k] for k in ("type", "method", "offset")):
            raise TypedError("declarationVertexMismatch",
                             "POSITION declaration does not match the external VB")
        uv0 = binding["uv0"]
        if uv0 is not None:
            if uv0["method"] != 0 or uv0["type"] not in UV0_FORMATS:
                raise TypedError("uv0TypeUnsupported",
                                 "UV0 type %d method %d" % (uv0["type"], uv0["method"]))
            stored_uv = next((e for e in vertex_buffer["elements"]
                              if e["usage"] == 5 and e["usageIndex"] == 0), None)
            if stored_uv is None or any(stored_uv[k] != uv0[k] for k in ("type", "method", "offset")):
                raise TypedError("declarationVertexMismatch",
                                 "UV0 declaration does not match the external VB")
            uv_format, uv_bytes = UV0_FORMATS[uv0["type"]]
            if uv0["offset"] + uv_bytes > vertex_buffer["stride"]:
                raise TypedError("uv0ExceedsVertexStride",
                                 "UV0 offset %d + %d > stride %d"
                                 % (uv0["offset"], uv_bytes, vertex_buffer["stride"]))

        stride = vertex_buffer["stride"]
        position_offset = binding["positionStream"]["vertexOffset"]
        uv_offset = (binding["uv0Stream"] or {}).get("vertexOffset", 0)
        for label, offset in (("POSITION", position_offset), ("UV0", uv_offset)):
            if offset < 0 or offset % stride:
                raise TypedError("streamVertexOffsetUnsupported",
                                 "%s byte offset %d, stride %d" % (label, offset, stride))
        position_shift = position_offset // stride
        uv_shift = uv_offset // stride

        if lod["offset"] + lod["indexCount"] > index_buffer["count"]:
            raise TypedError("lodOutsideIndexBuffer",
                             "lod %d+%d > %d" % (lod["offset"], lod["indexCount"],
                                                 index_buffer["count"]))
        width = index_buffer["width"]
        fmt_index = "H" if width == 2 else "I"
        raw_indices = [struct.unpack_from(
            "<" + fmt_index, data,
            index_buffer["dataOffset"] + (lod["offset"] + j) * width)[0]
            for j in range(lod["indexCount"])]
        step = 3 if topology == 0 else 1
        if topology == 0 and len(raw_indices) % 3:
            raise TypedError("triangleListIncomplete", "index count %d" % len(raw_indices))
        triangles = []
        for j in range(2, len(raw_indices), step):
            a, b, c = raw_indices[j - 2:j + 1]
            if topology == 1 and j % 2:
                a, b = b, a
            if a == b or b == c or a == c:
                continue
            triangles.append((a, b, c))
        if not triangles:
            raise TypedError("degeneratePrimitive", "no non-degenerate triangle")
        low = lod["minIndex"]
        high = low + lod["vertexCount"]
        for triangle in triangles:
            for value in triangle:
                if value < low or value >= high:
                    raise TypedError("indexOutsideLodRange", "index %d" % value)
                if value + position_shift >= vertex_buffer["vertexCount"]:
                    raise TypedError("indexOutsideVertexBuffer", "index %d" % value)
                if value + uv_shift >= vertex_buffer["vertexCount"]:
                    raise TypedError("indexOutsideVertexBuffer", "UV0 index %d" % value)
        used = sorted({v for triangle in triangles for v in triangle})
        index_map = {v: i for i, v in enumerate(used)}
        positions = []
        uvs = []
        for value in used:
            positions.append(struct.unpack_from(
                "<" + fmt, data,
                vertex_buffer["dataOffset"] + (value + position_shift) * stride
                + position["offset"])[:3])
            if uv0 is not None:
                uvs.append(struct.unpack_from(
                    "<" + uv_format, data,
                    vertex_buffer["dataOffset"] + (value + uv_shift) * stride
                    + uv0["offset"]))
        if not all(math.isfinite(v) for point in positions for v in point):
            raise TypedError("nonFinitePosition", "decoded POSITION is not finite")
        if not all(math.isfinite(v) for pair in uvs for v in pair):
            raise TypedError("nonFiniteUv0", "decoded UV0 is not finite")
        indices = [index_map[v] for triangle in triangles for v in triangle]
        positions_array = np.asarray(positions, dtype=np.float32)
        return {
            "meshKey": list(binding_key_strings(binding)),
            "sourceBlock": block,
            "vertexBuffer": vertex_source,
            "indexBuffer": index_source,
            "lod": lod,
            "topology": topology,
            "declaration": binding["declaration"],
            "vertexCount": len(used),
            "indexCount": len(indices),
            "triangleCount": len(indices) // 3,
            "localBounds": aabb(positions_array.astype(np.float64)),
            "positions": positions_array,
            "uv0": (np.asarray(uvs, dtype=np.float32)
                    if uv0 is not None else np.zeros((len(used), 2), dtype=np.float32)),
            "uv0Available": uv0 is not None,
            "indices": np.asarray(indices, dtype=np.uint32),
            "recordPrerequisites": self.records[
                self.block_location[block][0]].get("prerequisites", []),
        }

    # ------------------------------------------------------------ materials
    def resolve_material(self, node: dict, instance: dict | None,
                         primitive: dict) -> dict:
        """C++ binding order: instance material, base material, streams."""
        fields = []
        runtime = []
        textures = []
        albedo = {"seen": False, "known": False, "slot": None, "row": -1,
                  "material": None, "parameter": None, "reason": None}

        def walk(ref, stage, stack):
            if ref is None:
                return
            index = ref["index"]
            list_index = ref["listIndex"]
            if list_index != 0:
                runtime.append({"stage": stage, "materialRow": index,
                                "name": "listIndex", "reason":
                                "dynamic material list rebuilt at runtime"})
                return
            if not 0 <= index < len(node["constants"]):
                raise TypedError("materialIndexOutOfBounds",
                                 "%s row %d" % (stage, index))
            if index in stack or len(stack) >= 32:
                raise TypedError("recursiveMaterial", "%s row %d" % (stage, index))
            stack.append(index)
            material = node["constants"][index]
            for field in material["fields"]:
                name = field["name"]
                if field["type"] == 8:
                    for child in field["values"]:
                        walk(child, stage, stack)
                    continue
                if field["type"] == 9:
                    runtime.append({"stage": stage, "materialRow": index,
                                    "material": material["typeName"],
                                    "name": name,
                                    "reason": "DATA_INDEX runtime parameter"})
                    if name in ("g_tAlbedo", "g_MeshTexture"):
                        albedo.update(seen=True, known=False, slot=None, row=index,
                                      material=material["typeName"], parameter=name,
                                      reason="albedo is a runtime DATA_INDEX parameter")
                    continue
                record = {
                    "stage": stage,
                    "materialRow": index,
                    "material": material["typeName"],
                    "name": name,
                    "type": field["type"],
                    "count": field["count"],
                    "values": float_list(field["values"]) if field["values"] else [],
                }
                fields.append(record)
                if name in ("g_tAlbedo", "g_MeshTexture"):
                    if field["type"] == 7 and field["count"] == 1 and field["values"]:
                        albedo.update(seen=True, known=True, slot=int(field["values"][0]),
                                      row=index, material=material["typeName"],
                                      parameter=name, reason=None)
                    else:
                        albedo.update(seen=True, known=False, slot=None, row=index,
                                      material=material["typeName"], parameter=name,
                                      reason="unsupported scalar shape")
                elif ("Texture" in name or "Albedo" in name) and \
                        field["type"] == 7 and field["count"] == 1 and field["values"]:
                    textures.append({
                        "stage": stage,
                        "materialRow": index,
                        "material": material["typeName"],
                        "parameter": name,
                        "slot": int(field["values"][0]),
                    })
            stack.pop()

        if instance is not None:
            walk(instance["material"], "instance", [])
            for stream in instance.get("streams", []):
                if stream["streamIndex"] != -1:
                    walk(stream["material"], "instance-stream", [])
        walk(primitive.get("baseMaterial"), "base", [])
        for stream in primitive.get("streams", []):
            if stream["streamIndex"] != -1:
                walk(stream["material"], "stream", [])
        return {"albedo": albedo, "textures": textures, "fields": fields,
                "runtime": runtime}

    def effect_name(self, primitive: dict) -> str:
        index = primitive["effect"]
        if not 0 <= index < len(self.effects):
            raise TypedError("effectIndexOutOfBounds", "effect %d" % index)
        name = self.effects[index].replace("\\", "/").rsplit("/", 1)[-1]
        return name

    def effect_base(self, primitive: dict) -> str:
        name = self.effect_name(primitive)
        base = name.rsplit(".", 1)[0]
        for suffix in ("_LN", "_LOD"):
            if base.endswith(suffix):
                base = base[:-len(suffix)]
        return base

    # ------------------------------------------------------------- textures
    @property
    def archive(self):
        if self._archive is None:
            self._archive = TextureArchive(self.records, self.stream_path)
        return self._archive

    def texture_source(self, node: dict, slot: int) -> dict:
        sources = node["sources"]["texture"]
        if not 0 <= slot < len(sources):
            raise TypedError("textureSlotOutOfRange", "slot %d of %d"
                             % (slot, len(sources)))
        source = dict(sources[slot])
        if source["block"] == -1:
            shared = self.scene["sharedTextures"]
            if not 0 <= source["index"] < len(shared):
                raise TypedError("sharedTextureOutOfRange", "index %d" % source["index"])
            entry = shared[source["index"]]
            return {"block": -1, "index": source["index"],
                    "kind": "shared", "name": entry["sharedName"],
                    "descriptor": {"width": entry.get("width"),
                                   "height": entry.get("height"),
                                   "levels": entry.get("levels"),
                                   "format": entry.get("format")},
                    "sampler": entry.get("sampler"),
                    "payloadBytes": entry.get("dataBytes"),
                    "shared": entry}
        record = self.archive.texture(source["block"], source["index"])
        if record is None:
            raise TypedError("textureSourceMissing",
                             "block %d index %d has no LOD0 item"
                             % (source["block"], source["index"]))
        descriptor = record.get("descriptor")
        if not descriptor:
            raise TypedError("textureDescriptorMissing",
                             "block %d index %d" % (source["block"], source["index"]))
        return {"block": source["block"], "index": source["index"],
                "kind": "resource-block", "name": record["name"],
                "descriptor": descriptor, "sampler": record.get("sampler"),
                "payloadBytes": record.get("dataBytes"),
                "record": record}


def binding_key_strings(binding: dict) -> list[str]:
    lod = binding["lod"]
    return [
        "vb%d.%d" % (binding["positionSource"]["block"], binding["positionSource"]["index"]),
        "ib%d.%d" % (binding["indexSource"]["block"], binding["indexSource"]["index"]),
        "lod%d+%d" % (lod["offset"], lod["indexCount"]),
        "topo%d" % binding["topology"],
        "decl%d" % binding["declaration"],
    ]


class TextureRegistry:
    """Resolve texture identities and pixels from packages or the decoder."""

    def __init__(self, level: LevelData):
        self.level = level
        self.short = level.short
        self.out = output_dir(self.short)
        self.package = {}
        self.package_path = None
        package = level.config.get("package")
        if package:
            render_dir = ROOT / package
            bindings_path = ROOT / "_work/map-slice" / (self.short + "-textures/bindings.json")
            if bindings_path.exists():
                doc = load_json(bindings_path)
                self.package_path = bindings_path
                for record in doc.get("textures", []):
                    self.package[(record["block"], record["index"])] = record
        self.cache = {}
        self.decoded = []

    def resolve(self, source: dict) -> dict:
        key = (source["block"], source["index"])
        if key in self.cache:
            return self.cache[key]
        descriptor = source.get("descriptor") or {}
        format_value = descriptor.get("format")
        result = {
            "block": source["block"],
            "index": source["index"],
            "kind": source["kind"],
            "name": source.get("name"),
            "id": (("%s.shared.%d" % (self.short, source["index"]))
                   if source["block"] == -1 else
                   ("%s.albedo.%d.%d" % (self.short, source["block"], source["index"]))),
            "width": descriptor.get("width"),
            "height": descriptor.get("height"),
            "levels": descriptor.get("levels"),
            "format": format_value,
            "formatName": FORMAT_NAMES.get(format_value, "unsupported"),
            "sampler": source.get("sampler"),
            "payloadBytes": source.get("payloadBytes"),
            "rgbaBytes": 0,
            "rgbaSha256": None,
            "rgbaFnv1a64": None,
            "alpha": None,
            "alphaOpaque": None,
            "decodeStatus": "not-decoded",
            "decodeSource": None,
        }
        package = self.package.get(key)
        if package and package.get("rgbaBytes"):
            for field in ("name", "width", "height", "levels", "format", "formatName",
                          "sampler", "payloadBytes", "rgbaBytes", "rgbaSha256",
                          "rgbaFnv1a64", "alpha"):
                if package.get(field) is not None:
                    result[field] = package[field]
            result["alphaOpaque"] = bool((package.get("alpha") or {}).get("alphaOpaque"))
            result["decodeStatus"] = "committed-package"
            result["decodeSource"] = rel(self.package_path)
            if package.get("name") and source.get("name") and \
                    package["name"].strip() != source["name"].strip():
                result["decodeStatus"] = "identity-mismatch"
                result["packageName"] = package["name"]
            self.decoded.append(result)
            self.cache[key] = result
            return result
        # No package pixels: decode with the committed texture reader.
        blob, raw_id = self._raw_blob(source)
        raw_dir = self.out / "textures" / "raw"
        rgba_dir = self.out / "textures"
        raw_path = raw_dir / (raw_id + ".raw")
        rgba_path = rgba_dir / (raw_id + ".rgba")
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        raw_path.write_bytes(blob)
        if not TEXTURE_DECODER.exists():
            result["decodeStatus"] = "decoder-unavailable"
            self.cache[key] = result
            return result
        process = subprocess.run([str(TEXTURE_DECODER), str(raw_path), "--raw"],
                                 capture_output=True, timeout=120)
        if process.returncode != 0 or not process.stdout:
            result["decodeStatus"] = "decoder-rejected"
            result["decodeError"] = process.stderr.decode("utf-8", "replace")[-300:]
            self.cache[key] = result
            return result
        decoded = json.loads(process.stdout.decode("utf-8"))
        if decoded.get("status") != "ok":
            result["decodeStatus"] = "decoder-rejected"
            result["decodeError"] = str(decoded.get("status"))
            self.cache[key] = result
            return result
        width, height = decoded["width"], decoded["height"]
        rgba = bytes(decoded["rgba"])
        if len(rgba) != width * height * 4:
            raise TypedError("decodedRgbaLengthMismatch", raw_id)
        rgba_path.write_bytes(rgba)
        alphas = rgba[3::4]
        result.update(
            width=width, height=height, rgbaBytes=len(rgba),
            rgbaSha256=sha256_bytes(rgba),
            rgbaFnv1a64="0x%016x" % fnv1a64_bytes(rgba),
            alpha={"min": min(alphas), "max": max(alphas),
                   "distinct": len(set(alphas)),
                   "alphaOpaque": all(value == 255 for value in alphas)},
            alphaOpaque=all(value == 255 for value in alphas),
            decodeStatus="decoded-texture-inspect",
            decodeSource=rel(TEXTURE_DECODER),
            rgbaFile="%s/textures/%s.rgba" % (self.short, raw_id),
        )
        self.decoded.append(result)
        self.cache[key] = result
        return result

    def _raw_blob(self, source: dict):
        if source["block"] == -1:
            entry = source["shared"]
            blob = self.level.header[entry["dataOffset"]:entry["dataOffset"] + entry["dataBytes"]]
            return blob, ("%s.shared.%d" % (self.short, source["index"]))
        record = source["record"]
        data = record["_data"]
        blob = (data[record["headerOffset"]:record["headerOffset"] + record["headerBytes"]] +
                data[record["dataOffset"]:record["dataOffset"] + record["dataBytes"]])
        return blob, ("%s.albedo.%d.%d" % (self.short, source["block"], source["index"]))


# ---------------------------------------------------------------- effects
_FX_CACHE = {}


def _fx_expand(path: Path, defines: set, depth: int = 0):
    """Expand the tiny wrapper/include form used by the Racification shaders."""
    if depth > 4:
        raise ValueError("fx include depth")
    lines = []
    if_depth = 0
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = raw.strip()
        if stripped.startswith("#ifdef") or stripped.startswith("#ifndef") or stripped.startswith("#if "):
            if_depth += 1
        elif stripped.startswith("#endif"):
            if_depth = max(0, if_depth - 1)
        if stripped.startswith("#define ") and if_depth == 0:
            defines.add(stripped.split(None, 1)[1].split()[0])
            continue
        match = re.match(r'#include\s+"([^"]+)"', stripped)
        if match:
            target = path.parent / match.group(1)
            if not target.exists():
                target = FX_DIR / Path(match.group(1)).name
            lines.extend(_fx_expand(target, defines, depth + 1))
            continue
        lines.append(raw)
    return lines


def _fx_active(lines, defines):
    """Yield (line, active) with simple #ifdef/#ifndef/#else/#endif evaluation."""
    stack = [True]
    for raw in lines:
        stripped = raw.strip()
        if stripped.startswith("#ifdef "):
            stack.append(stack[-1] and stripped.split(None, 1)[1].strip() in defines)
            continue
        if stripped.startswith("#ifndef "):
            stack.append(stack[-1] and stripped.split(None, 1)[1].strip() not in defines)
            continue
        if stripped.startswith("#if "):
            stack.append(stack[-1])  # complex expression: keep enclosing state
            continue
        if stripped.startswith("#else"):
            if len(stack) > 1:
                stack[-1] = not stack[-1]
            continue
        if stripped.startswith("#endif"):
            if len(stack) > 1:
                stack.pop()
            continue
        yield raw, stack[-1]


def fx_state(base: str) -> dict:
    """Parse the declared static pass state of a Racification family shader."""
    if base in _FX_CACHE:
        return _FX_CACHE[base]
    path = FX_DIR / (base + ".fx")
    if not path.exists():
        result = {"source": None, "status": "source-missing", "base": base}
        _FX_CACHE[base] = result
        return result
    defines = set()
    lines = _fx_expand(path, defines)
    text = "\n".join(line for line, active in _fx_active(lines, defines) if active)
    technique = re.search(r"technique\s+Material\b[^{]*\{(.*?)\n\}", text, re.S)
    if technique is None:
        technique = re.search(r"technique\s+\w+\b[^{]*\{(.*?)\n\}", text, re.S)
    body = technique.group(1) if technique else ""
    values = {}
    for match in re.finditer(r"(\w+)\s*=\s*([^;]+);", body):
        values[match.group(1)] = match.group(2).strip()
    sort_match = re.search(r'SortType\s*=\s*"([^"]+)"', text)
    result = {
        "source": rel(path),
        "sha256": sha256_file(path),
        "base": base,
        "defines": sorted(defines),
        "status": "parsed" if values else "pass-not-found",
        "techniqueSort": sort_match.group(1) if sort_match else None,
        "declared": values,
        "alphaBlend": {
            "enabled": values.get("AlphaBlendEnable"),
            "op": values.get("BlendOp"),
            "src": values.get("SrcBlend"),
            "dst": values.get("DestBlend"),
        },
        "alphaTest": {
            "enabled": values.get("AlphaTestEnable"),
            "reference": values.get("AlphaRef"),
            "referenceNote": (None if values.get("AlphaRef") is not None
                              else "AlphaRef not declared in the FX pass; D3D default 0 is not applied"),
        },
        "depth": {
            "test": values.get("ZEnable"),
            "testNote": (None if values.get("ZEnable") is not None
                         else "ZEnable not declared; D3D9/FX default true is not applied"),
            "write": values.get("ZWriteEnable"),
        },
        "cull": {
            "declared": values.get("CullMode"),
            "note": (None if values.get("CullMode") is not None
                     else "CullMode not declared for this variant; D3D9 default back-face culling is not applied"),
        },
    }
    _FX_CACHE[base] = result
    return result


def effect_state(level: LevelData, primitive: dict) -> dict:
    name = level.effect_name(primitive)
    base = level.effect_base(primitive)
    state = dict(fx_state(base))
    state["effect"] = name
    return state
