"""Read-only Level.levelphysics parser for per-triangle surface identity.

This module re-expresses the proven Gravity ``OptimisedAABBTree`` v10 layout
documented in ``docs/work/analysis/t005-collision-oracle.md`` and implemented
by ``probes/collision-oracle/src/level_physics.cpp``.  It adds nothing to the
geometry decode; it keeps the per-group ``C_TriangleHeader`` fields
(``collisionFlags``, ``physicsMaterial``, ``effectMaterial``, ``userDataFlags``)
that the collision oracle already parses but does not expose per triangle.

Source anchors (read-only, ``upstream/BlurRebuilt@5270304b``):

* ``common/system/include/system/serialise/C_FileBlock.h`` - block framing
* ``physics/gravity/source/importer/Importer.cpp`` - "Head" import stream
* ``physics/gravity/include/gravity/sdk/BodyHelper.h`` - ImportBasic descriptor
* ``physics/gravity/source/narrowphase/OptimisedAABBTree.cpp`` - tree layout
* ``physics/gravity/include/gravity/narrowphase/OptimisedAABBTree.h`` -
  ``C_TriangleHeader`` / ``AABBTreeTriangle`` records

No value is guessed: every field is read at its documented byte offset, and a
parse that does not land exactly on the block boundary raises.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

SHAPE_TERMINATOR = 0x0FFFFFFF
CONSTRAINT_TERMINATOR = 0xFFFFFFFF
IMPORT_TRIANGLE_MESH = 0
IMPORT_TRIANGLE_MESH_BASE = 11
IMPORT_CONVEX_HULL = 3
# E_ImportShapeType (gravity/include/gravity/narrowphase/Shape.h:20-46) and the
# post-ImportBasic parameter width declared in ShapeDescriptors.h.
PRIMITIVE_SHAPES = {
    2: ("box", ("halfExtents.x", "halfExtents.y", "halfExtents.z")),
    4: ("sphere", ("radius",)),
    5: ("capsule", ("height", "radius")),
    6: ("cylinder", ("height", "radius")),
    14: ("plane", ("normal.x", "normal.y", "normal.z", "distance")),
    15: ("cone", ("baseRadius", "height")),
}
TRIANGLE_HEADER_BYTES = 16   # sizeof(C_TriangleHeader) buffer stride
AABB_TRIANGLE_BYTES = 12     # sizeof(AABBTreeTriangle) buffer stride
DISK_HEADER_BYTES = 15       # U32,U16,U32,U32,U8
DISK_TRIANGLE_BYTES = 11     # U8,U8,U8,U32,U32
STACK_SLOTS = 512
MAX_FILE_BYTES = 128 * 1024 * 1024


class ParseError(Exception):
    def __init__(self, offset: int, code: str, detail: str):
        super().__init__(f"{code} at byte {offset}: {detail}")
        self.offset = offset
        self.code = code
        self.detail = detail


@dataclass
class TriangleHeader:
    index: int              # global header index in the mesh
    leaf: int
    collision_flags: int
    physics_material: int
    effect_material: int
    user_data_flags: int
    num_triangles: int
    first_triangle: int
    buffer_offset: int
    file_offset: int


@dataclass
class Triangle:
    index: int              # global triangle index in the mesh
    header: int
    leaf: int
    ordinal_in_leaf: int
    ia: int
    ib: int
    ic: int
    normal_packed: int
    active_edge: int
    file_offset: int


@dataclass
class Leaf:
    node: int
    box_min: tuple
    box_max: tuple
    vertex_start: int
    num_vertices: int
    triangle_size_indices: int
    vertex_s16: list  # 3 s16 per stream vertex, leaf-local copy keyed by global index
    first_triangle: int
    num_triangles: int


@dataclass
class Mesh:
    index: int
    num_vertices: int
    num_normals: int
    triangle_capacity: int
    num_nodes: int
    low: tuple
    high: tuple
    num_active_edges: int
    triangle_buffer_bytes: int
    physics_material_index: int
    effect_material_index: int
    collision_flag: int
    node_flag: int
    original_export_id: int
    instance_identity: bool
    vertices: list          # decoded world positions (3 floats each)
    normals: list           # decoded HenDN3 (3 floats each)
    headers: list = field(default_factory=list)
    triangles: list = field(default_factory=list)
    leaves: list = field(default_factory=list)
    stream_begin: int = 0
    stream_end: int = 0


@dataclass
class PrimitiveShape:
    """A non-triangle import shape (box/sphere/capsule/cylinder/cone/plane).

    These carry a shape-level ``physicsMaterial``/``effectMaterial`` pair in
    their ImportBasic prefix but no per-triangle material stream.
    """
    index: int
    import_type: int
    type_name: str
    file_offset: int
    margin: float
    epsilon: float
    physics_material: int
    effect_material: int
    collision_flag: int
    node_flag: int
    mass: float
    original_export_id: int
    params: dict


@dataclass
class Level:
    file_bytes: int
    file_version: int
    route_count: int
    gravity_version: int
    meshes: list
    primitives: list
    blocks: dict


class _Cursor:
    __slots__ = ("data", "pos", "end")

    def __init__(self, data: bytes, begin: int, end: int):
        self.data = data
        self.pos = begin
        self.end = end

    def need(self, n: int) -> None:
        if self.pos + n > self.end:
            raise ParseError(self.pos, "truncated",
                             f"need {n} bytes before block end {self.end}")

    def u8(self) -> int:
        self.need(1)
        v = self.data[self.pos]
        self.pos += 1
        return v

    def u16(self) -> int:
        self.need(2)
        v = struct.unpack_from("<H", self.data, self.pos)[0]
        self.pos += 2
        return v

    def s16(self) -> int:
        self.need(2)
        v = struct.unpack_from("<h", self.data, self.pos)[0]
        self.pos += 2
        return v

    def u32(self) -> int:
        self.need(4)
        v = struct.unpack_from("<I", self.data, self.pos)[0]
        self.pos += 4
        return v

    def i32(self) -> int:
        self.need(4)
        v = struct.unpack_from("<i", self.data, self.pos)[0]
        self.pos += 4
        return v

    def f32(self) -> float:
        self.need(4)
        v = struct.unpack_from("<f", self.data, self.pos)[0]
        self.pos += 4
        return v

    def vec3(self) -> tuple:
        return (self.f32(), self.f32(), self.f32())

    def skip(self, n: int) -> None:
        self.need(n)
        self.pos += n


def _read_block(cur: _Cursor) -> dict:
    at = cur.pos
    cur.need(16)
    raw = cur.data[cur.pos:cur.pos + 8]
    cur.pos += 8
    size = cur.u32()
    count = cur.u16()
    btype = cur.u8()
    comp = cur.u8()
    ident = raw.split(b"\0", 1)[0].decode("latin1")
    if not ident:
        raise ParseError(at, "block_id_empty", "8-byte block id has no characters")
    if size < 16:
        raise ParseError(at, "block_size_too_small", f"size {size} < 16")
    if at + size > cur.end:
        raise ParseError(at, "block_overruns_parent",
                         f"'{ident}' ends at {at + size} beyond {cur.end}")
    return {"offset": at, "id": ident, "size": size, "count": count,
            "type": btype, "compression": comp}


def decode_fixed_s16_14(v: int) -> float:
    """Fixed3_S16<14> -> float (Vector.inl:1960-1970)."""
    return v / 16384.0


def encode_fixed_s16_14(x: float) -> int:
    """(S16)(local * 16384.0f) - truncation toward zero (Vector.inl:1992-2002)."""
    v = int(x * 16384.0)
    if v > 32767:
        v = 32767
    if v < -32768:
        v = -32768
    return v


def decode_hendn3(v: int) -> tuple:
    """11-11-10 signed normalised triple (Storage.inl:250-261)."""
    def sext(value: int, bits: int) -> int:
        sign = 1 << (bits - 1)
        value &= (1 << bits) - 1
        return value - (1 << bits) if value & sign else value
    x = sext(v & 0x7FF, 11) / 1023.0
    y = sext((v >> 11) & 0x7FF, 11) / 1023.0
    z = sext((v >> 22) & 0x3FF, 10) / 511.0
    return (x, y, z)


def _read_basic(cur: _Cursor) -> dict:
    return {
        "margin": cur.f32(),
        "epsilon": cur.f32(),
        "physics_material": cur.u32(),
        "effect_material": cur.u32(),
        "collision_flag": cur.u32(),
        "node_flag": cur.u32(),
        "mass": cur.f32(),
        "original_export_id": cur.u32(),
        "render_offset": cur.vec3(),
        "remapped": cur.u32(),
        "user_data_flag": cur.u32(),
    }


def _read_instance(cur: _Cursor) -> tuple:
    """C_ShapeInstance import: position + Matrix33 rotation + Matrix33 inertia."""
    pos = cur.vec3()
    rot = [cur.f32() for _ in range(9)]
    inertia = [cur.f32() for _ in range(9)]
    return pos, rot, inertia


def _read_tree(cur: _Cursor, mesh: Mesh, version: int) -> None:
    if version < 10:
        raise ParseError(cur.pos, "unsupported_stream_version",
                         f"OptimisedAABBTree v10 required, got {version}")
    stream_begin = cur.pos
    mesh.num_vertices = cur.u32()
    mesh.num_normals = cur.u32()
    mesh.triangle_capacity = cur.u32()
    mesh.num_nodes = cur.u32()
    mesh.low = cur.vec3()
    mesh.high = cur.vec3()
    if mesh.num_nodes == 0:
        raise ParseError(stream_begin, "empty_tree", "numNodes == 0")
    if mesh.num_vertices > (cur.end - cur.pos) // 12:
        raise ParseError(stream_begin, "vertex_count_overruns", "numVertices too large")
    if mesh.num_normals > (cur.end - cur.pos) // 4:
        raise ParseError(stream_begin, "normal_count_overruns", "numNormals too large")

    stream_vertices = [cur.vec3() for _ in range(mesh.num_vertices)]
    mesh.normals = [decode_hendn3(cur.u32()) for _ in range(mesh.num_normals)]

    if mesh.num_nodes > (cur.end - cur.pos) // 28:
        raise ParseError(stream_begin, "node_count_overruns", "numNodes too large")

    nodes = []
    for _ in range(mesh.num_nodes):
        q = [cur.s16() for _ in range(6)]
        tri_size = cur.u32()
        start_or_right = cur.u32()
        vertex_start = cur.u32()
        num_vertices = cur.u32()
        nodes.append((q, tri_size, start_or_right, vertex_start, num_vertices))

    span = (mesh.high[0] - mesh.low[0],
            mesh.high[1] - mesh.low[1],
            mesh.high[2] - mesh.low[2])
    boxes = []
    for q, _, _, _, _ in nodes:
        bmin = tuple(decode_fixed_s16_14(q[i]) * span[i] + mesh.low[i] for i in range(3))
        bmax = tuple(decode_fixed_s16_14(q[i + 3]) * span[i] + mesh.low[i] for i in range(3))
        boxes.append((bmin, bmax))

    # Per-leaf vertex quantisation, same leaf order as the engine traversal.
    vertex_s16 = [None] * (mesh.num_vertices * 3)
    decoded = [None] * mesh.num_vertices
    stack = [0]
    buffer_offset = 0
    leaf_index = 0

    while stack:
        node_index = stack.pop()
        if node_index >= mesh.num_nodes:
            raise ParseError(cur.pos, "node_index_out_of_range",
                             f"node {node_index} >= {mesh.num_nodes}")
        q, tri_size, start_or_right, vertex_start, num_vertices = nodes[node_index]
        bmin, bmax = boxes[node_index]
        if tri_size == 0:
            if len(stack) + 2 > STACK_SLOTS:
                raise ParseError(cur.pos, "stack_overflow", "traversal stack exceeded")
            right = node_index + start_or_right
            left = node_index + 1
            if right >= mesh.num_nodes or left >= mesh.num_nodes:
                raise ParseError(cur.pos, "child_index_out_of_range",
                                 f"internal node {node_index} points outside the array")
            stack.append(right)
            stack.append(left)
            continue

        if vertex_start > mesh.num_vertices or num_vertices > mesh.num_vertices - vertex_start:
            raise ParseError(cur.pos, "leaf_vertex_range",
                             f"leaf {node_index} vertex range out of bounds")
        leaf_span = (bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2])
        recip = (1.0 / leaf_span[0], 1.0 / leaf_span[1], 1.0 / leaf_span[2])
        for i in range(vertex_start, vertex_start + num_vertices):
            t = stream_vertices[i]
            local = ((t[0] - bmin[0]) * recip[0],
                     (t[1] - bmin[1]) * recip[1],
                     (t[2] - bmin[2]) * recip[2])
            s = [encode_fixed_s16_14(local[0]),
                 encode_fixed_s16_14(local[1]),
                 encode_fixed_s16_14(local[2])]
            vertex_s16[i * 3:i * 3 + 3] = s
            decoded[i] = tuple(decode_fixed_s16_14(s[k]) * leaf_span[k] + bmin[k]
                               for k in range(3))

        leaf = Leaf(node=node_index, box_min=bmin, box_max=bmax,
                    vertex_start=vertex_start, num_vertices=num_vertices,
                    triangle_size_indices=tri_size, vertex_s16=None,
                    first_triangle=len(mesh.triangles), num_triangles=0)
        # The header/triangle stream is interleaved per leaf (OptimisedAABBTree.cpp:282-310).
        buffer_offset += TRIANGLE_HEADER_BYTES
        header_at = cur.pos
        collision_flags = cur.u32()
        physics_material = cur.u16()
        effect_material = cur.u32()
        user_data_flags = cur.u32()
        num_tri = cur.u8()
        if num_tri == 0:
            raise ParseError(cur.pos - 1, "zero_triangle_header",
                             "C_TriangleHeader::m_NumTriangles == 0")
        header = TriangleHeader(index=len(mesh.headers), leaf=leaf_index,
                                collision_flags=collision_flags,
                                physics_material=physics_material,
                                effect_material=effect_material,
                                user_data_flags=user_data_flags,
                                num_triangles=num_tri,
                                first_triangle=len(mesh.triangles),
                                buffer_offset=buffer_offset - TRIANGLE_HEADER_BYTES,
                                file_offset=header_at)
        mesh.headers.append(header)
        in_group = 0
        for a in range(tri_size):
            if in_group >= header.num_triangles:
                buffer_offset += TRIANGLE_HEADER_BYTES
                header_at = cur.pos
                collision_flags = cur.u32()
                physics_material = cur.u16()
                effect_material = cur.u32()
                user_data_flags = cur.u32()
                num_tri = cur.u8()
                if num_tri == 0:
                    raise ParseError(cur.pos - 1, "zero_triangle_header",
                                     "C_TriangleHeader::m_NumTriangles == 0")
                header = TriangleHeader(index=len(mesh.headers), leaf=leaf_index,
                                        collision_flags=collision_flags,
                                        physics_material=physics_material,
                                        effect_material=effect_material,
                                        user_data_flags=user_data_flags,
                                        num_triangles=num_tri,
                                        first_triangle=len(mesh.triangles),
                                        buffer_offset=buffer_offset - TRIANGLE_HEADER_BYTES,
                                        file_offset=header_at)
                mesh.headers.append(header)
                in_group = 0
            tri_at = cur.pos
            ia = cur.u8()
            ib = cur.u8()
            ic = cur.u8()
            normal_packed = cur.u32()
            active_edge = cur.u32()
            if ia >= num_vertices or ib >= num_vertices or ic >= num_vertices:
                raise ParseError(tri_at, "triangle_index_out_of_leaf",
                                 f"leaf {node_index} triangle index >= {num_vertices}")
            mesh.triangles.append(Triangle(index=len(mesh.triangles),
                                           header=header.index, leaf=leaf_index,
                                           ordinal_in_leaf=a, ia=ia, ib=ib, ic=ic,
                                           normal_packed=normal_packed,
                                           active_edge=active_edge, file_offset=tri_at))
            buffer_offset += AABB_TRIANGLE_BYTES
            in_group += 1

        leaf.num_triangles = len(mesh.triangles) - leaf.first_triangle
        mesh.leaves.append(leaf)
        leaf_index += 1

    if buffer_offset > mesh.triangle_capacity:
        raise ParseError(cur.pos, "triangle_capacity_exceeded",
                         f"stream used {buffer_offset} of {mesh.triangle_capacity}")
    mesh.triangle_buffer_bytes = buffer_offset

    mesh.num_active_edges = cur.u32()
    if mesh.num_active_edges > (cur.end - cur.pos) // 12:
        raise ParseError(cur.pos, "active_edge_count_overruns", "numActiveEdges too large")
    cur.skip(mesh.num_active_edges * 12)

    # Rebuild world vertices now that every leaf's quantisation is known.
    mesh.vertices = decoded
    mesh.stream_begin = stream_begin
    mesh.stream_end = cur.pos


def load_level_bytes(data: bytes) -> Level:
    if len(data) < 20:
        raise ParseError(0, "file_too_small", "shorter than the root block header")
    if len(data) > MAX_FILE_BYTES:
        raise ParseError(0, "file_too_large", "exceeds the 128 MiB probe bound")
    if data[:4] != b"  CP":
        raise ParseError(0, "bad_pc_marker", "expected little-endian '  CP'")

    root_cur = _Cursor(data, 4, len(data))
    root = _read_block(root_cur)
    if root["id"] != "Physic":
        raise ParseError(root["offset"], "bad_root_block",
                         f"root id '{root['id']}' != 'Physic'")
    if root["offset"] + root["size"] != len(data):
        raise ParseError(root["offset"] + root["size"], "root_size_mismatch",
                         "root does not end at EOF")

    children = _Cursor(data, root["offset"] + 16, len(data))
    blocks = {}
    while children.pos < children.end:
        blk = _read_block(children)
        blocks[blk["id"]] = blk
        if blk["id"] not in ("Header", "Main", "Routes"):
            raise ParseError(blk["offset"], "unknown_root_child",
                             f"'{blk['id']}' is not a proven root child")
        children.pos = blk["offset"] + blk["size"]
    if "Header" not in blocks or "Main" not in blocks:
        raise ParseError(len(data), "missing_required_block", "need Header and Main")

    hb = blocks["Header"]
    hcur = _Cursor(data, hb["offset"] + 16, hb["offset"] + hb["size"])
    file_version = hcur.u32()
    route_count = hcur.i32()
    if hcur.pos != hb["offset"] + hb["size"]:
        raise ParseError(hcur.pos, "header_block_trailing", "unread Header bytes")
    if route_count < 0 or route_count > 4096:
        raise ParseError(hb["offset"], "bad_route_count", str(route_count))

    mb = blocks["Main"]
    cur = _Cursor(data, mb["offset"] + 16, mb["offset"] + mb["size"])
    head = bytes(cur.u8() for _ in range(4))
    if head != b"Head":
        raise ParseError(mb["offset"] + 16, "missing_gravity_head", "no 'Head' fourcc")
    gravity_version = cur.u32()

    meshes = []
    primitives = []
    shape_index = 0
    while True:
        at_type = cur.pos
        shape_type = cur.u32()
        if shape_type == SHAPE_TERMINATOR:
            break
        shape_index += 1
        if shape_index > 256:
            raise ParseError(at_type, "too_many_shapes", "more than 256 shapes")
        if shape_type in (IMPORT_TRIANGLE_MESH, IMPORT_TRIANGLE_MESH_BASE):
            basic = _read_basic(cur)
            mesh = Mesh(index=len(meshes), num_vertices=0, num_normals=0,
                        triangle_capacity=0, num_nodes=0, low=(0, 0, 0), high=(0, 0, 0),
                        num_active_edges=0, triangle_buffer_bytes=0,
                        physics_material_index=basic["physics_material"],
                        effect_material_index=basic["effect_material"],
                        collision_flag=basic["collision_flag"],
                        node_flag=basic["node_flag"],
                        original_export_id=basic["original_export_id"],
                        instance_identity=True, vertices=[], normals=[])
            _read_tree(cur, mesh, gravity_version)
            if shape_type == IMPORT_TRIANGLE_MESH:
                pos, rot, _inertia = _read_instance(cur)
                identity = (pos == (0.0, 0.0, 0.0)
                            and rot == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0])
                mesh.instance_identity = identity
                if not identity:
                    raise ParseError(cur.pos, "non_identity_instance",
                                     "instance transform is not identity; space would be local")
            else:
                # E_ImportTriangleMeshBase_Shape is a shared mesh resource, not
                # a placed instance: ShapeDescriptors.cpp:1127-1132 imports the
                # basic descriptor and the tree only.
                mesh.instance_identity = None
            meshes.append(mesh)
        elif shape_type in PRIMITIVE_SHAPES:
            name, fields = PRIMITIVE_SHAPES[shape_type]
            basic = _read_basic(cur)
            params = {}
            for i, _ in enumerate(fields):
                params[f"p{i}"] = cur.f32()
            _read_instance(cur)
            primitives.append(PrimitiveShape(
                index=len(primitives), import_type=shape_type, type_name=name,
                file_offset=at_type, margin=basic["margin"], epsilon=basic["epsilon"],
                physics_material=basic["physics_material"],
                effect_material=basic["effect_material"],
                collision_flag=basic["collision_flag"], node_flag=basic["node_flag"],
                mass=basic["mass"], original_export_id=basic["original_export_id"],
                params=params))
        elif shape_type == IMPORT_CONVEX_HULL:
            basic = _read_basic(cur)
            num_points = cur.u32()
            num_triangles = cur.u32()
            if num_points > (cur.end - cur.pos) // 12:
                raise ParseError(cur.pos, "hull_points_overrun", "numPoints too large")
            cur.skip(num_points * 12)
            if num_triangles > (cur.end - cur.pos) // 12:
                raise ParseError(cur.pos, "hull_triangles_overrun", "numTriangles too large")
            cur.skip(num_triangles * 12)
            _read_instance(cur)
            primitives.append(PrimitiveShape(
                index=len(primitives), import_type=shape_type, type_name="convex-hull",
                file_offset=at_type, margin=basic["margin"], epsilon=basic["epsilon"],
                physics_material=basic["physics_material"],
                effect_material=basic["effect_material"],
                collision_flag=basic["collision_flag"], node_flag=basic["node_flag"],
                mass=basic["mass"], original_export_id=basic["original_export_id"],
                params={"numPoints": num_points, "numTriangles": num_triangles}))
        else:
            raise ParseError(at_type, "unsupported_shape_type",
                             f"E_ImportShapeType {shape_type} is not in the proven set "
                             f"(0 triangle mesh, 2 box, 3 convex hull, 4 sphere, "
                             f"5 capsule, 6 cylinder, 14 plane)")

    constraint_at = cur.pos
    constraint_type = cur.u32()
    if constraint_type != CONSTRAINT_TERMINATOR:
        raise ParseError(constraint_at, "unsupported_constraint", "constraint list not empty")
    if cur.pos != cur.end:
        raise ParseError(cur.pos, "main_block_trailing",
                         f"{cur.end - cur.pos} unread bytes at the end of Main")
    if not meshes:
        raise ParseError(mb["offset"], "no_static_meshes", "no static mesh")

    return Level(file_bytes=len(data), file_version=file_version,
                 route_count=route_count, gravity_version=gravity_version,
                 meshes=meshes, primitives=primitives, blocks=blocks)


def load_level(path) -> Level:
    with open(path, "rb") as handle:
        return load_level_bytes(handle.read())


def triangle_positions(mesh: Mesh, tri: Triangle) -> tuple:
    leaf = mesh.leaves[tri.leaf]
    base = leaf.vertex_start
    a = mesh.vertices[base + tri.ia]
    b = mesh.vertices[base + tri.ib]
    c = mesh.vertices[base + tri.ic]
    return a, b, c


def triangle_geometry(mesh: Mesh, tri: Triangle) -> dict:
    a, b, c = triangle_positions(mesh, tri)
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    nx = ab[1] * ac[2] - ab[2] * ac[1]
    ny = ab[2] * ac[0] - ab[0] * ac[2]
    nz = ab[0] * ac[1] - ab[1] * ac[0]
    length = (nx * nx + ny * ny + nz * nz) ** 0.5
    if length > 0.0:
        nx, ny, nz = nx / length, ny / length, nz / length
    centroid = ((a[0] + b[0] + c[0]) / 3.0,
                (a[1] + b[1] + c[1]) / 3.0,
                (a[2] + b[2] + c[2]) / 3.0)
    return {"a": a, "b": b, "c": c, "normal": (nx, ny, nz), "length": length,
            "centroid": centroid, "area": length * 0.5}
