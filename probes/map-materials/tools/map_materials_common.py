#!/usr/bin/env python3
"""Source-shaped level render-list reader for full draw material recipes.

Data extraction only. The reader follows the committed RenderingData serializers
(``renderingdata/include/renderingdata/noninterface/archive.inl``) and the
committed Python readers under ``tools/``. It adds what those readers discard:

* the 24-byte serialized ``BlendState`` of every primitive
  (``iiiBBBBii`` = SrcBlend, DestBlend, BlendOp, AlphaBlendEnable,
  AlphaTestEnable, AlphaRef, AlphaToMaskEnable, CullMode, ZBias);
* the six ``RenderPassInfo`` records of the render list, which assign every
  primitive to OPAQUE / ALPHA_TEST / OVERLAY / BACK_FRONT / POST_RESOLVE /
  RACIFICATION exactly as the retail build-time rule does;
* every constant material row of the primitive's material stack, with the
  serialized field offset and value.

No engine source, game data, ``tools/`` module or other probe is modified.
"""
from __future__ import annotations

import math
import struct
from collections import Counter

# ---------------------------------------------------------------------------
# RenderingData enums (upstream renderingdata/include/renderingdata/renderstates.h)
# ---------------------------------------------------------------------------

BLEND_FACTORS = [
    "ZERO", "ONE", "SRCCOLOUR", "INVSRCCOLOUR", "SRCALPHA", "INVSRCALPHA",
    "DSTALPHA", "INVDSTALPHA", "DSTCOLOUR", "INVDSTCOLOUR",
]
BLEND_OPS = ["ADD", "SUBTRACT", "MIN", "MAX", "REVSUBTRACT"]
CULL_MODES = ["NONE", "NORMAL", "REVERSED"]
RENDER_PASSES = [
    "OPAQUE", "ALPHA_TEST", "OVERLAY", "BACK_FRONT", "POST_RESOLVE",
    "RACIFICATION",
]
# context.cpp SetPass(): depth test / write are inferred from the pass.
PASS_DEPTH = {
    "OPAQUE": {"depthTest": True, "depthWrite": True},
    "ALPHA_TEST": {"depthTest": True, "depthWrite": True},
    "POST_RESOLVE": {"depthTest": True, "depthWrite": True},
    "OVERLAY": {"depthTest": True, "depthWrite": False},
    "BACK_FRONT": {"depthTest": True, "depthWrite": False},
    "RACIFICATION": {"depthTest": True, "depthWrite": False},
}
PASS_BLEND_ENABLE = {
    "OPAQUE": False,
    "ALPHA_TEST": False,
    "POST_RESOLVE": False,
    "OVERLAY": True,
    "BACK_FRONT": True,
    "RACIFICATION": True,
}

MATERIAL_ELEMENT_TYPES = {
    0: "S8", 1: "U8", 2: "S16", 3: "U16", 4: "S32", 5: "U32", 6: "F32",
    7: "TEXTURE_INDEX", 8: "MATERIAL_INDEX", 9: "DATA_INDEX",
    10: "TEXTURE_PTR",
}

# Scalar shapes used to size a material field. TEXTURE_INDEX / MATERIAL_INDEX /
# DATA_INDEX are S32; TEXTURE_PTR is a slot word (4 bytes in the archive).
TYPE_FORMATS = {
    0: "b", 1: "B", 2: "h", 3: "H", 4: "i", 5: "I", 6: "f", 8: "ii",
    9: "i", 10: "I",
}

TEXTURE_STAGE_FIELDS = (
    "g_tAlbedo", "g_tMaterial", "g_tNormal", "g_tSpecular",
    "g_tDetailAlbedo", "g_tDetailSpecular", "g_tLightmap", "g_tEnvironment",
    "g_tWorldNormal", "g_tTexture", "g_tColour", "g_tNeon", "g_tDirtAlbedo",
    "g_tFlicker", "g_tBlendNormal", "g_2L_tTexture", "g_tDetailMaterial",
)


def blend_state_from_bytes(raw: bytes) -> dict:
    """Decode one serialized ``BlendState`` (24 bytes)."""
    if len(raw) != 24:
        raise ValueError("BlendState must be 24 bytes")
    src, dst, op, ablend, atest, aref, amask, cull, zbias = struct.unpack(
        "<iiiBBBBii", raw)
    return {
        "srcBlend": src,
        "destBlend": dst,
        "blendOp": op,
        "alphaBlendEnable": ablend,
        "alphaTestEnable": atest,
        "alphaRef": aref,
        "alphaToMaskEnable": amask,
        "cullMode": cull,
        "zBias": zbias,
    }


def blend_state_valid(state: dict) -> tuple[bool, str | None]:
    if not 0 <= state["srcBlend"] < len(BLEND_FACTORS):
        return False, "srcBlend %d outside BlendFactor" % state["srcBlend"]
    if not 0 <= state["destBlend"] < len(BLEND_FACTORS):
        return False, "destBlend %d outside BlendFactor" % state["destBlend"]
    if not 0 <= state["blendOp"] < len(BLEND_OPS):
        return False, "blendOp %d outside BlendOp" % state["blendOp"]
    if state["alphaBlendEnable"] not in (0, 1):
        return False, "alphaBlendEnable %d is not a bool" % state["alphaBlendEnable"]
    if state["alphaTestEnable"] not in (0, 1):
        return False, "alphaTestEnable %d is not a bool" % state["alphaTestEnable"]
    if state["alphaToMaskEnable"] not in (0, 1):
        return False, "alphaToMaskEnable %d is not a bool" % state["alphaToMaskEnable"]
    if not 0 <= state["cullMode"] < len(CULL_MODES):
        return False, "cullMode %d outside CullMode" % state["cullMode"]
    if not 0 <= state["zBias"] <= 15:
        return False, "zBias %d outside 0..15" % state["zBias"]
    if not 0 <= state["alphaRef"] <= 255:
        return False, "alphaRef %d outside 0..255" % state["alphaRef"]
    return True, None


def blend_state_json(state: dict) -> dict:
    return {
        "srcBlend": state["srcBlend"],
        "srcBlendName": BLEND_FACTORS[state["srcBlend"]],
        "destBlend": state["destBlend"],
        "destBlendName": BLEND_FACTORS[state["destBlend"]],
        "blendOp": state["blendOp"],
        "blendOpName": BLEND_OPS[state["blendOp"]],
        "alphaBlendEnable": bool(state["alphaBlendEnable"]),
        "alphaTestEnable": bool(state["alphaTestEnable"]),
        "alphaRef": state["alphaRef"],
        "alphaToMaskEnable": bool(state["alphaToMaskEnable"]),
        "cullMode": state["cullMode"],
        "cullModeName": CULL_MODES[state["cullMode"]],
        "zBias": state["zBias"],
    }


def pass_for_primitive(pass_infos: list[dict], index: int,
                       instance: bool = False) -> tuple[str | None, dict | None]:
    """Return (passName, RenderPassInfo) for a primitive/instance index."""
    key_n = "nInstances" if instance else "nPrimitives"
    key_off = "instanceOffset" if instance else "primitiveOffset"
    for number, info in enumerate(pass_infos):
        start = info[key_off]
        if start <= index < start + info[key_n]:
            return RENDER_PASSES[number], info
    return None, None


class MaterialListReader:
    """Subclass-friendly reader for one render list.

    ``Reader`` is expected to provide ``ar(n)``, ``unpack``, ``vec``, ``string``,
    ``count``, ``bits``, ``bounds`` and ``take`` exactly like the committed
    ``inspect_car_level_assets.Reader``.
    """

    def read_blend_state(self) -> dict:
        self.ar()
        raw = self.b[self.p:self.p + 24]
        if len(raw) != 24:
            raise ValueError("truncated BlendState")
        self.p += 24
        return blend_state_from_bytes(raw)

    def read_primitive(self) -> dict:
        start = self.p
        version = self.ar(1)
        effect, declaration, topology, index_buffer, flags = self.unpack("5i")
        base = self.material()
        instance = self.material() if version else None
        blend = self.read_blend_state()
        lods = []
        for _ in range(self.vec(64)):
            self.ar()
            lods.append(dict(zip(("offset", "indexCount", "minIndex",
                                  "vertexCount"), self.unpack("4I"))))
        streams = [self.stream() for _ in range(self.vec(32))]
        return {
            "archiveOffset": start, "end": self.p, "version": version,
            "effect": effect, "declaration": declaration, "topology": topology,
            "indexBuffer": index_buffer, "flags": flags,
            "baseMaterial": base, "instanceMaterial": instance,
            "blendState": blend, "lods": lods, "streams": streams,
        }


def material_row_fields(row: dict) -> list[dict]:
    return row["fields"]


def material_stack(render_list: dict, primitive: dict,
                   max_depth: int = 32) -> dict:
    """Resolve the primitive's material stack in source application order.

    Order is the committed ``scene_reader.cpp bind_albedo()`` order: primitive
    instance material, base material, then every active stream material. A
    ``MATERIAL_INDEX`` field (type 8) is followed recursively at the point it is
    applied. The result keeps the full ordered stack and the last-wins parameter
    map. Runtime-rebuilt lists (``listIndex != 0``) are recorded but never
    supply values.
    """
    constants = render_list["constants"]
    order: list[dict] = []
    parameters: dict[str, dict] = {}
    runtime: list[str] = []

    def apply(ref: dict, stage: str, stack: tuple[int, ...]) -> None:
        index = ref["index"]
        list_index = ref["listIndex"]
        if list_index != 0:
            runtime.append("%s: dynamic material list %d is rebuilt at runtime"
                           % (stage, list_index))
            return
        if not 0 <= index < len(constants):
            raise ValueError("constant material index %d out of bounds" % index)
        if index in stack or len(stack) >= max_depth:
            raise ValueError("recursive constant material reference %d" % index)
        row = constants[index]
        order.append({
            "id": "list0-material%d" % index,
            "stage": stage,
            "index": index,
            "typeName": row["typeName"],
            "archiveOffset": row["archiveOffset"],
        })
        for field in row["fields"]:
            if field["type"] == 8:
                for child in field["values"]:
                    apply(child, stage + "/" + field["name"], stack + (index,))
            else:
                parameters[field["name"]] = {
                    "type": field["type"],
                    "typeName": MATERIAL_ELEMENT_TYPES.get(field["type"], "UNKNOWN"),
                    "count": field["count"],
                    "values": field["values"],
                    "row": index,
                    "rowTypeName": row["typeName"],
                    "stage": stage,
                    "serializedOffset": field["serializedOffset"],
                }

    if primitive.get("instanceMaterial") is not None:
        apply(primitive["instanceMaterial"], "instance", ())
    apply(primitive["baseMaterial"], "base", ())
    for number, stream in enumerate(primitive["streams"]):
        if stream["streamIndex"] != -1:
            apply(stream["material"], "stream[%d]/slot%d" % (number, stream["streamIndex"]), ())

    return {"order": order, "parameters": parameters, "runtime": runtime}


def finite(value):
    if isinstance(value, float) and not math.isfinite(value):
        return False
    return True


def texture_sources(render_list: dict, parameters: dict) -> dict:
    """Resolve every TEXTURE_INDEX parameter to a render-list texture source."""
    sources = render_list["sources"]["texture"]
    result = {}
    for name, parameter in parameters.items():
        if parameter["type"] != 7:
            continue
        values = parameter["values"]
        if parameter["count"] != 1 or len(values) != 1:
            result[name] = {"resolution": "unsupported",
                            "reason": "texture parameter has count %d" % parameter["count"]}
            continue
        slot = values[0]
        if not 0 <= slot < len(sources):
            result[name] = {"resolution": "unsupported",
                            "reason": "texture slot %d outside render-list source list" % slot}
            continue
        source = dict(sources[slot])
        result[name] = {"resolution": "data", "slot": slot,
                        "block": source["block"], "index": source["index"]}
    return result


# ---------------------------------------------------------------------------
# Level reader
# ---------------------------------------------------------------------------

LEVELS = {
    "usa_la_river": "river",
    "usa_amboy": "amboy",
    "spa_barcelona_gracia": "gracia",
    "usa_la_longbeachdocks": "longbeach",
}

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


def make_reader_class():
    """Build the reader class lazily so importing this module needs no sys.path.

    The committed ``tools/`` modules stay read-only authorities; the class only
    reuses their sequential readers and adds the blend/pass capture.
    """
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    if str(root / "tools") not in sys.path:
        sys.path.insert(0, str(root / "tools"))
    from inspect_car_materials import MaterialReader
    from inspect_level_chunk import NodeReader

    class LevelReader(MaterialReader):
        material = NodeReader.material
        stream = NodeReader.stream
        instance = NodeReader.instance
        primitive = MaterialListReader.read_primitive
        read_blend_state = MaterialListReader.read_blend_state

        def render_list(self) -> dict:
            version = self.ar(4)
            if version < 2:
                raise ValueError("Legacy RenderList unsupported")
            node = self.cull()
            inline = self.material_list()
            primitives = [self.primitive() for _ in range(self.vec())]
            instances = [self.instance() for _ in range(self.vec())]
            batches = []
            for _ in range(self.vec()):
                self.ar()
                batches.append({"instance": self.instance(),
                                "stream": self.stream()})
            bases = [self.primitive() for _ in range(self.vec())]
            constants = self.material_data(inline["types"])
            pass_infos = []
            for _ in range(self.vec()):
                self.ar()
                pass_infos.append(dict(zip(
                    ("nPrimitives", "primitiveOffset", "nInstances",
                     "instanceOffset", "nInstanceBatches", "instanceBatchOffset"),
                    self.unpack("6i"))))
            bounds = {key: [self.bounds() for _ in range(self.vec())]
                      for key in ("primitive", "instance", "batch")}
            for _ in range(3):
                flag = self.ar(1)
                self.take(4)
                if flag:
                    self.take(self.vec() * 2)
                self.take(4)
                self.take(self.vec(16 * 1024 * 1024))
            self.take(self.vec() * 4)
            for _ in range(self.vec()):
                self.ar()
                self.bits()
                self.bits()
            dynamic = [self.material_list()
                       for _ in range(2 if version == 3 else self.vec(256) if version > 3 else 0)]
            sources = {key: [dict(zip(("block", "index"), self.unpack("ii")))
                             for _ in range(self.vec())]
                       for key in ("indexBuffer", "vertexBuffer", "texture")}
            chunks = []
            for _ in range(self.vec()):
                self.ar()
                entry = {"chunkIndex": self.unpack("i")}
                for key in ("indexBuffer", "vertexBuffer", "texture"):
                    rows = []
                    for _ in range(self.vec()):
                        self.ar()
                        rows.append(dict(zip(("block", "index", "indexInList"),
                                             self.unpack("3i"))))
                    entry[key] = rows
                chunks.append(entry)
            return {
                "name": node["name"], "primitives": primitives,
                "instances": instances, "batches": batches,
                "basePrimitives": bases, "constants": constants["materials"],
                "inline": inline, "dynamic": dynamic, "sources": sources,
                "chunkData": chunks, "passInfos": pass_infos,
                "bounds": bounds, "end": self.p,
            }

    return LevelReader


class TextureMetadata:
    """Lazily resolve ``block:index`` to texture identity without decoding pixels."""

    def __init__(self, records: list[dict], stream_path, shared: list[dict],
                 levelrender: bytes):
        self.records = records
        self.stream_path = stream_path
        self.shared = shared
        self.levelrender = levelrender
        self.block_index = {}
        for record_index, record in enumerate(records):
            for item_index, item in enumerate(record["items"]):
                if item["lod"] == 0:
                    self.block_index.setdefault(item["block"], (record_index, item_index))
        self.record_cache = {}
        self.item_textures = {}
        self.cache = {}

    def record_data(self, record_index: int) -> bytes:
        if record_index not in self.record_cache:
            record = self.records[record_index]
            with self.stream_path.open("rb") as handle:
                handle.seek(record["offset"])
                data = handle.read(record["storedBytes"])
            if len(data) != record["storedBytes"]:
                raise ValueError("short levelstream read")
            self.record_cache[record_index] = data
        return self.record_cache[record_index]

    def textures_for_item(self, record_index: int, item_index: int) -> list[dict]:
        key = (record_index, item_index)
        if key in self.item_textures:
            return self.item_textures[key]
        import sys
        from pathlib import Path
        root = Path(__file__).resolve().parents[3]
        if str(root / "tools") not in sys.path:
            sys.path.insert(0, str(root / "tools"))
        from inspect_car_level_assets import resource_prefix, stream_prefix
        from inspect_car_materials import MaterialReader, texture_lod

        record = self.records[record_index]
        data = self.record_data(record_index)
        stream_prefix(data, record)
        cursor = 24
        for number, item in enumerate(record["items"]):
            if item["lod"] != 0:
                raise ValueError("texture item is not LOD0")
            resources = resource_prefix(data, {"resourcePayloadOffset": cursor,
                                               "scenePayloadOffset": 0}, streamed=True)
            if resources["nodeCount"]:
                read_lists(data, resources)
                reader = MaterialReader(data, resources["parsedNodesEnd"])
            else:
                reader = MaterialReader(data, resources["firstNodeOffset"])
            count = reader.count(16)
            textures = [texture_lod(reader, item["lod"], 0) for _ in range(count)]
            self.item_textures[(record_index, number)] = textures
            cursor = reader.p
            if number == item_index:
                return textures
        raise ValueError("item index outside record")

    def resolve(self, block: int, index: int) -> dict:
        key = (block, index)
        if key in self.cache:
            return self.cache[key]
        result: dict
        if block == -1:
            if 0 <= index < len(self.shared):
                entry = self.shared[index]
                descriptor = None
                if entry["dataOffset"] + 28 <= len(self.levelrender):
                    width, height, depth, levels, fmt, usage, kind = struct.unpack_from(
                        "<7I", self.levelrender, entry["dataOffset"])
                    descriptor = {"width": width, "height": height, "depth": depth,
                                  "levels": levels, "format": fmt, "usage": usage,
                                  "type": kind}
                result = {
                    "kind": "shared", "block": -1, "index": index,
                    "name": entry["name"], "textureHash": entry["sharedHash"],
                    "descriptor": descriptor,
                    "width": descriptor["width"] if descriptor else None,
                    "height": descriptor["height"] if descriptor else None,
                    "levels": descriptor["levels"] if descriptor else None,
                    "format": (FORMAT_NAMES.get(descriptor["format"], "unsupported/%d" % descriptor["format"])
                               if descriptor else None),
                    "formatCode": descriptor["format"] if descriptor else None,
                    "payloadBytes": entry.get("dataBytes"),
                    "pixelsDecoded": False,
                    "pixelsReason": "identity only; no pixel decode is part of this package",
                }
            else:
                result = {"kind": "shared", "block": -1, "index": index,
                          "resolution": "unsupported",
                          "reason": "shared texture index outside Scene header"}
        else:
            location = self.block_index.get(block)
            if location is None:
                result = {"kind": "resource-block", "block": block, "index": index,
                          "resolution": "unsupported",
                          "reason": "resource block has no LOD0 stream item"}
            else:
                textures = self.textures_for_item(*location)
                if not 0 <= index < len(textures):
                    result = {"kind": "resource-block", "block": block, "index": index,
                              "resolution": "unsupported",
                              "reason": "texture index outside the block's item array"}
                else:
                    texture = textures[index]
                    descriptor = texture.get("descriptor") or {}
                    result = {
                        "kind": "resource-block", "block": block, "index": index,
                        "name": texture.get("name"),
                        "textureHash": texture.get("hash"),
                        "descriptor": descriptor,
                        "width": descriptor.get("width"),
                        "height": descriptor.get("height"),
                        "levels": descriptor.get("levels"),
                        "format": FORMAT_NAMES.get(descriptor.get("format"),
                                                   "unsupported/%s" % descriptor.get("format")),
                        "formatCode": descriptor.get("format"),
                        "headerBytes": texture.get("headerBytes"),
                        "payloadBytes": texture.get("dataBytes"),
                        "pixelsDecoded": False,
                        "pixelsReason": "identity only; no pixel decode is part of this package",
                    }
        self.cache[key] = result
        return result


def read_lists(data: bytes, resources: dict) -> list[dict]:
    reader_class = make_reader_class()
    reader = reader_class(data, resources["firstNodeOffset"])
    result = []
    limit = 16 * 1024 * 1024
    for index in range(resources["nodeCount"]):
        tag = reader.unpack("B")
        if tag == 0:
            continue
        if tag != 3:
            raise ValueError("Unsupported level node pointer")
        name = reader.string()
        version = reader.ar(4)
        if name == "RenderingData::RenderListNode_Common":
            if version:
                raise ValueError("Unsupported level RenderList version")
            node = reader.render_list()
            node.update(nodeIndex=index)
            result.append(node)
        elif name == "RenderingData::CullNode":
            reader.node()
            reader.bounds()
            reader.bits()
            if version > 0:
                reader.take(4)
            if version > 1:
                reader.bits()
        elif name == "RenderingData::RootNode":
            reader.cull()
        elif name == "RenderingData::GroupNode":
            reader.cull()
            reader.string()
        elif name == "RenderingData::LodNode":
            reader.cull()
            reader.take(reader.vec() * 4)
        elif name == "RenderingData::Node":
            reader.string()
            reader.take(reader.vec() * 8 + 16)
        else:
            raise ValueError("Unsupported level node " + name)
    resources["parsedNodesEnd"] = reader.p
    return result

