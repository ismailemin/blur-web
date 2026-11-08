"""(DMGV1) Bounded, read-only Python port of the committed ``scene_inspect`` traversal.

Purpose: expose the vertex declarations and the *auxiliary vertex streams* of one
decoded PC ``.model`` that the committed reader validates but does not export:

* declaration elements (stream, offset, type, method, usage, usageIndex)
* resource-block 0 / LOD0 vertex buffers with stride, element layout and bytes
* the first render list: primitives, their declaration index, their vertex
  streams and the resolved VB source (``{block,index}``)
* the per-primitive effect name and material row

Nothing is guessed. Every offset comes from the same serialized fields the C++
reader consumes; a mismatch aborts with the byte position. The module is data
extraction only: no engine, no shader, no renderer.

Source authority: ``probes/asset-reader/src/scene_reader.cpp`` (committed) and
``probes/asset-reader/FORMAT-scene.md``. Portable because the format is
little-endian and the reader is platform independent.
"""
from __future__ import annotations

import struct

RA = 0x4152
MAX_COUNT = 100000


class SceneError(RuntimeError):
    pass


class Reader:
    def __init__(self, data: bytes, start: int = 0, end: int | None = None) -> None:
        self.b = data
        self.end = len(data) if end is None else end
        self.p = start
        self.origin = 0
        self.objects = 0

    def fail(self, message: str):
        raise SceneError(f"{message} at byte {self.p}")

    def need(self, n: int) -> None:
        if self.p > self.end or n > self.end - self.p:
            self.fail("Truncated scene")

    def skip(self, n: int) -> None:
        self.need(n)
        self.p += n

    def u8(self) -> int:
        self.need(1)
        value = self.b[self.p]
        self.p += 1
        return value

    def u16(self) -> int:
        self.need(2)
        value = struct.unpack_from("<H", self.b, self.p)[0]
        self.p += 2
        return value

    def u32(self) -> int:
        self.need(4)
        value = struct.unpack_from("<I", self.b, self.p)[0]
        self.p += 4
        return value

    def u64(self) -> int:
        lo = self.u32()
        hi = self.u32()
        return lo | (hi << 32)

    def s32(self) -> int:
        return struct.unpack("<i", struct.pack("<I", self.u32()))[0]

    def f32_bits(self) -> float:
        return struct.unpack("<f", struct.pack("<I", self.u32()))[0]

    def expect(self, value: int) -> None:
        if self.u32() != value:
            self.fail("Unsupported serialized value")

    def ar(self, max_version: int = 0) -> int:
        self.objects += 1
        if self.objects > MAX_COUNT:
            self.fail("Archive object limit")
        if self.u16() != RA:
            self.fail("Missing RA object marker")
        version = self.u16()
        if version > max_version:
            self.fail("Unsupported object version")
        return version

    def count(self, limit: int = MAX_COUNT) -> int:
        n = self.u32()
        if n > limit:
            self.fail("Collection limit")
        return n

    def vec(self, limit: int = MAX_COUNT) -> int:
        self.ar()
        return self.count(limit)

    def string(self) -> str:
        n = self.count(4096)
        self.need(n)
        value = self.b[self.p:self.p + n].decode("latin-1")
        self.p += n
        return value

    def literal(self, value: bytes) -> None:
        self.need(len(value))
        if self.b[self.p:self.p + len(value)] != value:
            self.fail("Unsupported archive signature")
        self.p += len(value)

    def bitvector(self) -> None:
        self.ar()
        bits = self.count(8 * 1024 * 1024)
        nbytes = self.vec()
        if nbytes < (bits + 7) // 8:
            self.fail("Invalid bit vector byte count")
        self.skip(nbytes)

    def bounds(self) -> None:
        self.ar()
        self.skip(32)

    def node(self) -> None:
        self.ar()
        self.string()
        n = self.vec()
        self.skip(n * 8)
        self.skip(16)

    def cull(self) -> None:
        version = self.ar(2)
        self.node()
        self.bounds()
        self.bitvector()
        if version > 0:
            self.skip(4)
        if version > 1:
            self.bitvector()

    def root(self) -> None:
        self.ar()
        self.cull()

    def pointer(self) -> bool:
        tag = self.u8()
        if tag == 0:
            return False
        if tag != 2:
            self.fail("Unsupported non-polymorphic pointer tag")
        return True

    def blob(self, expected: int) -> tuple[int, int]:
        self.ar()
        n = self.u32()
        alignment = self.u32()
        compression = self.u32()
        swap = self.u8()
        if n != expected:
            self.fail("Buffer byte size mismatch")
        if not alignment or alignment > 4096 or (alignment & (alignment - 1)):
            self.fail("Invalid buffer alignment")
        if compression or swap:
            self.fail("Unsupported compressed/endian buffer")
        if self.p < self.origin:
            self.fail("Invalid stream origin")
        self.skip((alignment - (self.p - self.origin) % alignment) % alignment)
        start = self.p
        self.skip(n)
        return start, n


class Chunk:
    __slots__ = ("start", "end", "payload", "count", "type", "id")

    def __init__(self, start, end, payload, count, type_, id_):
        self.start = start
        self.end = end
        self.payload = payload
        self.count = count
        self.type = type_
        self.id = id_


def chunk(r: Reader, start: int, parent_end: int) -> Chunk:
    r.p = start
    r.need(16)
    n = 0
    while n < 8 and r.b[start + n]:
        n += 1
    id_ = r.b[start:start + n].decode("latin-1")
    for i in range(n, 8):
        if r.b[start + i]:
            r.fail("Invalid chunk ID padding")
    r.p = start + 8
    size = r.u32()
    count = r.u16()
    type_ = r.u8()
    compression = r.u8()
    if size < 16 or start > parent_end or size > parent_end - start or compression:
        r.fail("Unsupported chunk bounds/compression")
    if type_ not in (0x41, 0x43):
        r.fail("Unsupported chunk type")
    return Chunk(start, start + size, start + 16, count, type_, id_)


def child(r: Reader, parent: Chunk, want: str) -> Chunk:
    if parent.type != 0x43:
        r.fail("Expected container")
    at = parent.payload
    found = None
    if parent.count > 10000:
        r.fail("Chunk count limit")
    for _ in range(parent.count):
        c = chunk(r, at, parent.end)
        at = c.end
        if c.id == want:
            if found is not None:
                r.fail("Duplicate named chunk")
            found = c
    if at != parent.end:
        r.fail("Container child size mismatch")
    if found is None:
        r.fail(f"Missing {want} chunk")
    return found


# ---------------------------------------------------------------------------
# Scene traversal
# ---------------------------------------------------------------------------

class Scene:
    """Declarations, block-0 LOD0 buffers and the first render list."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.r = Reader(data)
        self.declarations: list[list[dict]] = []
        self.effects: list[str] = []
        self.resource_blocks = 0
        self.loaded_blocks = 0
        self.shared_textures: list[dict] = []
        self.vbs: list[dict] = []
        self.ibs: list[dict] = []
        self.primitives: list[dict] = []
        self.vertex_sources: list[dict] = []
        self.texture_sources: list[dict] = []
        self.material_rows: list[dict] = []
        self.metadata: dict = {}
        self._run()

    # -- low level ---------------------------------------------------------
    def _scene_header(self):
        r = self.r
        target_version = r.ar(1)
        r.ar()
        r.expect(2)
        r.ar()
        self.metadata["scene_name"] = r.string()
        r.root()

        count = r.vec(256)
        for _ in range(count):
            r.ar()
            n = r.count(32)
            elements = []
            for _ in range(n):
                r.ar()
                stream = struct.unpack("<h", struct.pack("<H", r.u16()))[0]
                offset = r.u16()
                type_ = r.s32()
                method = r.s32()
                usage = r.s32()
                index = struct.unpack("<b", struct.pack("<B", r.u8()))[0]
                elements.append({
                    "stream": stream,
                    "offset": offset,
                    "type": type_,
                    "method": method,
                    "usage": usage,
                    "usageIndex": index,
                })
            self.declarations.append(elements)

        count = r.vec(256)
        for _ in range(count):
            r.ar()
            r.ar()
            self.effects.append(r.string())

        blocks = r.count(256)
        if not blocks:
            r.fail("No resource blocks")
        self.resource_blocks = blocks
        r.ar()
        r.ar()
        r.expect(2)
        shared = r.count(4096)
        for _ in range(shared):
            name = r.string()
            r.skip(4)
            # texture envelope
            r.ar()
            r.ar()
            r.expect(2)
            tex_name = r.string()
            sampler = r.ar(1)
            r.skip(40 if sampler else 36)
            tex_hash = r.u32()
            size = r.count(64 * 1024 * 1024)  # max_input, not the object-count limit
            tex_offset = r.p
            r.skip(size)
            self.shared_textures.append({
                "slot": len(self.shared_textures),
                "declaredName": name,
                "name": tex_name,
                "hash": tex_hash,
                "dataOffset": tex_offset,
                "dataBytes": size,
            })
        r.ar()
        stream_version = r.ar(3)
        self._empty_vector()
        self._empty_vector()
        if stream_version > 0:
            self._empty_vector()
            self._empty_vector()
        if stream_version > 1:
            self._empty_vector()
        if stream_version > 2:
            r.skip(4)
        if target_version > 0:
            self._dynamic_lists()
        loaded = r.count(256)
        if loaded > blocks or not loaded:
            r.fail("Unsupported absent resource blocks")
        self.loaded_blocks = loaded

    def _empty_vector(self):
        if self.r.vec() != 0:
            self.r.fail("Streamed scene collections not supported")

    def _material_type(self):
        r = self.r
        r.ar()
        name = r.string()
        n = r.vec(4096)
        fields = []
        for _ in range(n):
            r.ar()
            fname = r.string()
            ftype = r.s32()
            fcount = r.count(4096)
            if ftype < 0 or ftype > 10:
                r.fail("Unsupported material element type")
            fields.append({"name": fname, "type": ftype, "count": fcount})
        r.skip(8)
        offsets = r.vec(4096)
        r.skip(offsets * 2)
        r.skip(8)
        return {"name": name, "fields": fields}

    def _material_types(self):
        n = self.r.vec(4096)
        return [self._material_type() for _ in range(n)]

    def _material_data(self, types):
        r = self.r
        count = r.count(10000)
        r.count(MAX_COUNT)
        rows = []
        for _ in range(count):
            index = r.count()
            if index >= len(types):
                r.fail("Material type reference out of bounds")
            row = {"type": types[index]["name"], "fields": []}
            for field in types[index]["fields"]:
                size = 1 if field["type"] < 2 else 2 if field["type"] < 4 else 4
                if field["type"] in (8, 9):
                    for _ in range(field["count"]):
                        r.ar()
                        ref = r.s32()
                        lst = r.s32()
                        row["fields"].append({"name": field["name"], "ref": ref, "list": lst})
                else:
                    r.skip(size * field["count"])
            rows.append(row)
        return rows

    def _dynamic_lists(self):
        r = self.r
        n = r.vec(256)
        for _ in range(n):
            if r.pointer():
                r.ar()
                r.ar()
                types = self._material_types()
                self._material_data(types)

    # -- geometry ----------------------------------------------------------
    def _vertex_buffer(self):
        r = self.r
        version = r.ar(1)
        r.ar()
        stride = r.count(1024)
        if not stride:
            r.fail("Zero vertex stride")
        n = r.vec(32)
        elements = []
        for _ in range(n):
            r.ar()
            elements.append({
                "type": r.s32(),
                "method": r.s32(),
                "usage": r.s32(),
                "usageIndex": r.s32(),
                "offset": 0,
            })
        offsets = r.vec(32)
        if offsets != n:
            r.fail("Vertex element offset count mismatch")
        for element in elements:
            element["offset"] = r.u16()
        count = r.count(1000000)
        size = stride * count
        if version:
            start, _ = r.blob(size)
        else:
            start = r.p
            r.skip(size)
        return {"stride": stride, "count": count, "dataOffset": start,
                "dataBytes": size, "elements": elements, "version": version}

    def _index_buffer(self):
        r = self.r
        version = r.ar(1)
        n = r.count(6000000)
        type_ = r.u32()
        if type_ > 1:
            r.fail("Unsupported index type")
        width = 4 if type_ else 2
        if version:
            start, _ = r.blob(n * width)
        else:
            start = r.p
            r.skip(n * width)
        return {"count": n, "width": width, "dataOffset": start}

    def _resources(self):
        r = self.r
        n = r.vec(4096)
        return [{"block": r.s32(), "index": r.s32()} for _ in range(n)]

    def _primitive_stream(self):
        r = self.r
        r.ar()
        stream = {"vb": r.s32(), "index": r.s32(), "offset": r.s32(),
                  "frequency": r.s32(), "material": 0, "materialList": 0}
        r.ar()
        stream["material"] = r.s32()
        stream["materialList"] = r.s32()
        return stream

    def _primitive(self):
        r = self.r
        version = r.ar(1)
        primitive = {"effect": r.s32(), "declaration": r.s32(), "topology": r.s32(),
                     "ib": r.s32()}
        r.skip(4)
        r.ar()
        primitive["baseMaterial"] = {"index": r.s32(), "list": r.s32()}
        if version:
            r.ar()
            primitive["instanceMaterial"] = {"index": r.s32(), "list": r.s32()}
        r.ar()
        r.skip(24)
        n = r.vec(64)
        lods = []
        for _ in range(n):
            r.ar()
            lods.append({"offset": r.u32(), "count": r.u32(),
                         "minIndex": r.u32(), "vertices": r.u32()})
        primitive["lods"] = lods
        n = r.vec(32)
        primitive["streams"] = [self._primitive_stream() for _ in range(n)]
        return primitive

    def _instance(self):
        r = self.r
        r.ar()
        r.skip(4)
        r.ar()
        r.skip(8)
        n = r.vec(32)
        for _ in range(n):
            self._primitive_stream()
        r.skip(4)

    def _pvs(self):
        r = self.r
        version = r.ar(1)
        r.skip(4)
        if version:
            n = r.vec()
            r.skip(n * 2)
        r.skip(4)
        n = r.vec()
        r.skip(n)

    def _skill(self, n):  # skip n * 4 bytes with a vec count
        self.r.skip(n * 4)

    def _parse_render_list(self):
        # Mirrors scene_reader.cpp parse_render_list() up to the primitive list,
        # then stops. Primitive streams and the vertex source table are what we
        # need; material rows are already read before the primitives.
        r = self.r
        base_version = r.ar(4)
        if base_version < 2:
            r.fail("Unsupported legacy RenderListNode")
        r.cull()
        r.ar()
        types = self._material_types()
        self._material_data(types)

        n = r.vec(10000)
        primitives = [self._primitive() for _ in range(n)]
        self.primitives = primitives

        # Remaining fields are consumed only to reach the vertex source table.
        n = r.vec(10000)
        for _ in range(n):
            self._instance()
        n = r.vec(10000)
        for _ in range(n):
            r.ar()
            self._instance()
            self._primitive_stream()
        n = r.vec(10000)
        for _ in range(n):
            self._primitive()
        self._material_data(types)
        n = r.vec(10000)
        for _ in range(n):
            r.ar()
            r.skip(24)
        for _ in range(3):
            n = r.vec()
            for _ in range(n):
                self.r.bounds()
        for _ in range(3):
            self._pvs()
        n = r.vec()
        r.skip(n * 4)
        if r.vec():
            r.fail("Portal material traversal unsupported")
        if base_version == 3:
            for _ in range(2):
                r.ar()
                dynamic_types = self._material_types()
                self._material_data(dynamic_types)
        elif base_version > 3:
            n = r.vec(256)
            for _ in range(n):
                r.ar()
                dynamic_types = self._material_types()
                self._material_data(dynamic_types)
        self._resources()  # index sources
        self.vertex_sources = self._resources()
        self.texture_sources = self._resources()
        self.metadata["baseVersion"] = base_version

    def _node_pointer(self):
        r = self.r
        tag = r.u8()
        if tag == 0:
            return False
        if tag != 3:
            r.fail("Unsupported node pointer type")
        name = r.string()
        version = r.ar(4)
        if name == "RenderingData::RenderListNode_Common":
            if version:
                r.fail("Unsupported target RenderListNode version")
            self._parse_render_list()
            return True
        if name == "RenderingData::RootNode":
            if version:
                r.fail("Unsupported root version")
            r.cull()
            return False
        if name == "RenderingData::CullNode":
            if version > 2:
                r.fail("Unsupported cull version")
            r.node()
            r.bounds()
            r.bitvector()
            if version > 0:
                r.skip(4)
            if version > 1:
                r.bitvector()
            return False
        if name == "RenderingData::Node":
            if version:
                r.fail("Unsupported node version")
            r.string()
            n = r.vec()
            r.skip(n * 8 + 16)
            return False
        if name == "RenderingData::GroupNode":
            if version:
                r.fail("Unsupported group version")
            r.cull()
            r.string()
            return False
        r.fail(f"Unsupported polymorphic node {name}")
        return False

    def _run(self):
        r = self.r
        r.literal(b"  CP")
        model = chunk(r, 4, r.end)
        if model.id != "Model":
            r.fail("Expected Model container")
        render = child(r, model, "Render")
        if render.type != 0x41:
            r.fail("Expected Render wrapper")
        inner = chunk(r, render.payload, render.end)
        if inner.id != "Render" or inner.end != render.end:
            r.fail("Invalid inner Render")
        header = child(r, inner, "Header")
        r.p = header.payload
        if header.end - header.payload != 4 or r.u32() != 0:
            r.fail("Unsupported render header")
        scene = child(r, inner, "Scene")
        r.end = scene.end
        r.p = scene.payload
        r.origin = scene.payload
        r.literal(b"ARCH")
        r.expect(1)
        r.expect(0)
        r.literal(b"ARCH")
        r.expect(0)
        r.expect(1)
        self._scene_header()

        # resource block 0, LOD 0
        r.ar()
        r.ar()
        r.expect(2)
        lods = r.count(16)
        if not lods:
            r.fail("No resource LOD")
        r.ar()
        r.ar()
        r.expect(2)
        r.expect(0)
        n = r.vec(256)
        for _ in range(n):
            if not r.pointer():
                r.fail("Null vertex buffer")
            self.vbs.append(self._vertex_buffer())
        n = r.vec(256)
        for _ in range(n):
            if not r.pointer():
                r.fail("Null index buffer")
            self.ibs.append(self._index_buffer())
        n = r.vec(10000)
        found = False
        for _ in range(n):
            if self._node_pointer():
                found = True
                break
        if not found:
            r.fail("No supported render list in first resource block")
        self.metadata["blocks"] = self.resource_blocks
        self.metadata["loadedBlocks"] = self.loaded_blocks
        self.metadata["lods"] = lods
        self.metadata["parsedUntilOffset"] = r.p

    # -- helpers -----------------------------------------------------------
    def declaration(self, index: int) -> list[dict]:
        return self.declarations[index]

    def vb_data(self, index: int) -> memoryview:
        vb = self.vbs[index]
        return memoryview(self.data)[vb["dataOffset"]:vb["dataOffset"] + vb["dataBytes"]]


# Semantic names used by the vehicle damage shader (vehicle_common.h:317-327).
USAGE_NAMES = {
    (0, 0): "POSITION0",
    (3, 0): "NORMAL0",
    (5, 0): "TEXCOORD0",
    (5, 1): "TEXCOORD1",
    (5, 2): "TEXCOORD2(positionOffset)",
    (5, 3): "TEXCOORD3(normalOffset)",
    (5, 4): "TEXCOORD4(controlPointInfo)",
    (2, 0): "BLENDINDICES",
    (4, 0): "COLOUR0",
}
