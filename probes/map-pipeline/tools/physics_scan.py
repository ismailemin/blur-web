#!/usr/bin/env python3
"""Read-only Level.levelphysics shape-stream scanner for the map audit.

The committed collision oracle (probes/collision-oracle/tests/reference_oracle.py)
decodes only Collision::E_ImportTriangleMesh_Shape (0). Other level physics
files start with simple or composite import shapes, so the oracle stops at the
first non-zero type. This module follows the *upstream serializer* instead of
guessing:

  upstream/BlurRebuilt/code/mercury/library/physics/gravity/include/gravity/sdk/BodyHelper.h
  upstream/BlurRebuilt/code/mercury/library/physics/gravity/include/gravity/sdk/ShapeDescriptors.h
  upstream/BlurRebuilt/code/mercury/library/physics/gravity/include/gravity/sdk/CompositeDescriptor.h
  upstream/BlurRebuilt/code/mercury/library/physics/gravity/source/importer/Importer.cpp
  upstream/BlurRebuilt/code/mercury/library/common/core/include/core/maths/hvec/Matrix.inl (HMat43)

Serialised shape stream (stream version >= 7):
  type u32
  ImportBasic = margin f32, epsilon f32, physicsMaterial u32, effectMaterial u32,
                collisionFlag u32, nodeFlag u32, mass f32, originalExportID u32,
                renderOffset vec3, remapped u32, userDataFlag u32       (52 bytes)
  descriptor payload (type specific)
  C_ShapeInstance = position vec3, rotation 9*f32, inertia 9*f32       (84 bytes)

Triangle mesh types 0 and 11 share the optimised-AABB-tree payload and are
decoded by the committed oracle parser verbatim. Fluid mesh (17) carries the
same tree payload plus depth and (version >= 5) density fields; its triangles
are recorded as fluid, never as drivable surface.
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
import reference_oracle as oracle  # noqa: E402

# Collision::E_ImportShapeType (Shape.h)
IMPORT_NAMES = {
    0: "TriangleMesh",
    1: "KDTriangleMesh",
    2: "Box",
    3: "ConvexHull",
    4: "Sphere",
    5: "Capsule",
    6: "Cylinder",
    7: "Composite",
    8: "CharacterController",
    9: "Particle",
    10: "InstancedTriangleMesh",
    11: "TriangleMeshBase",
    12: "Cloth",
    13: "Fluid",
    14: "Plane",
    15: "Cone",
    16: "Rope",
    17: "FluidMesh",
    18: "Continuous",
    19: "NoCollisionRope",
    20: "NoCollisionCloth",
    21: "Null",
    22: "Deformable",
}
TERMINATOR = 0x0FFFFFFF
SHAPE_TERMINATOR = 0x0FFFFFFF
CONSTRAINT_TERMINATOR = 0xFFFFFFFF
SIMPLE_PAYLOAD = {2: 12, 4: 4, 5: 8, 6: 8, 15: 8}  # box, sphere, capsule, cylinder, cone
INSTANCE_BYTES = 84  # vec3 + HMat33 rotation + HMat33 inertia


def read_basic(r, version):
    """C_ShapeDesc::ImportBasic in BodyHelper.h."""
    d = dict(margin=r.f32(), epsilon=r.f32(),
             physicsMaterialIndex=r.u32(), effectMaterialIndex=r.u32(),
             collisionFlag=r.u32(), nodeFlag=r.u32(), mass=r.f32(),
             originalExportID=r.u32(), renderOffset=r.vec3(),
             remapped=r.u32())
    d["userDataFlag"] = r.u32() if version >= 7 else 0
    return d


def read_instance(r):
    return dict(position=r.vec3(),
                rotation=[r.f32() for _ in range(9)],
                inertia=[r.f32() for _ in range(9)])


def read_tree(r, version):
    """Collision::OptimisedAABBTree::DeSerialise, copied from the oracle."""
    mesh = dict(streamBegin=r.pos)
    num_v = r.u32()
    num_n = r.u32()
    tri_capacity = r.u32()
    num_nodes = r.u32()
    low = r.vec3()
    high = r.vec3()
    mesh.update(numVertices=num_v, numNormals=num_n,
                triangleCapacityBytes=tri_capacity, numNodes=num_nodes,
                low=low, high=high)

    vertices = [r.vec3() for _ in range(num_v)]
    normals = [r.u32() for _ in range(num_n)]

    nodes = []
    for _ in range(num_nodes):
        q = tuple(r.s16() for _ in range(6))
        nodes.append(dict(q=q, tsi=r.u32(), start_or_right=r.u32(),
                          vertex_start=r.u32(), num_vertices=r.u32()))

    span = oracle.vsub(high, low)
    for n in nodes:
        q = n["q"]
        local_min = (oracle.decode_fixed_s16(q[0]), oracle.decode_fixed_s16(q[1]),
                     oracle.decode_fixed_s16(q[2]))
        local_max = (oracle.decode_fixed_s16(q[3]), oracle.decode_fixed_s16(q[4]),
                     oracle.decode_fixed_s16(q[5]))
        n["box_min"] = oracle.vadd(oracle.vmul(local_min, span), low)
        n["box_max"] = oracle.vadd(oracle.vmul(local_max, span), low)

    quantised = [0] * (num_v * 3)
    leaves = []
    headers = []
    triangles = []
    stack = [0] if num_nodes else []
    buffer_offset = 0
    leaf_index = 0

    while stack:
        node_index = stack.pop()
        n = nodes[node_index]
        if n["tsi"] == 0:
            stack.append(node_index + n["start_or_right"])
            stack.append(node_index + 1)
            continue

        leaf_span = oracle.vsub(n["box_max"], n["box_min"])
        recip = oracle.vreciprocal(leaf_span)
        for i in range(n["vertex_start"], n["vertex_start"] + n["num_vertices"]):
            local = oracle.vmul(oracle.vsub(vertices[i], n["box_min"]), recip)
            quantised[i * 3 + 0] = oracle.encode_fixed_s16(local[0])
            quantised[i * 3 + 1] = oracle.encode_fixed_s16(local[1])
            quantised[i * 3 + 2] = oracle.encode_fixed_s16(local[2])

        n["triangle_buffer_start"] = buffer_offset
        n["first_triangle"] = len(triangles)
        n["first_header"] = len(headers)
        leaf = dict(node=node_index, first_triangle=len(triangles),
                    vertex_start=n["vertex_start"], num_vertices=n["num_vertices"],
                    tsi=n["tsi"], buffer_start=buffer_offset)
        leaves.append(leaf)
        leaf_index += 1

        def read_header(slot):
            h = dict(collisionFlags=r.u32(), physicsMaterial=r.u16(),
                     effectMaterial=r.u32(), userDataFlags=r.u32(),
                     numTriangles=r.u8(), leaf=leaf_index - 1,
                     first_triangle=len(triangles), buffer_offset=buffer_offset)
            if h["numTriangles"] == 0:
                raise oracle.ParseError("zero_triangle_header", r.pos - 1,
                                        "m_NumTriangles == 0")
            headers.append(h)
            return h

        buffer_offset += 16
        header = read_header(0)
        triangle_array_offset = buffer_offset
        header_index = 0

        for a in range(n["tsi"]):
            if header_index >= header["numTriangles"]:
                buffer_offset += 16
                header = read_header(0)
                triangle_array_offset = buffer_offset
                header_index = 0

            ia = r.u8()
            ib = r.u8()
            ic = r.u8()
            normal = r.u32()
            active = r.u32()
            if ia >= n["num_vertices"] or ib >= n["num_vertices"] or ic >= n["num_vertices"]:
                raise oracle.ParseError("triangle_index_out_of_leaf", r.pos - 11,
                                        "index >= numVertices")
            triangles.append(dict(a=ia, b=ib, c=ic, normal=normal, active=active,
                                  header=len(headers) - 1, leaf=leaf_index - 1,
                                  ordinal=a,
                                  buffer_offset=triangle_array_offset + 12 * header_index))
            buffer_offset += 12
            header_index += 1

        leaf["num_triangles"] = len(triangles) - leaf["first_triangle"]
        leaf["triangle_buffer_length"] = buffer_offset - leaf["buffer_start"]
        n["num_headers"] = len(headers) - n["first_header"]
        n["num_streamed_triangles"] = leaf["num_triangles"]
        n["triangle_buffer_length"] = leaf["triangle_buffer_length"]

    if buffer_offset > tri_capacity:
        raise oracle.ParseError("triangle_capacity_exceeded", r.pos,
                                "%d > %d" % (buffer_offset, tri_capacity))
    mesh["triangleBufferBytes"] = buffer_offset
    mesh["numActiveEdges"] = r.u32()
    r.pos += mesh["numActiveEdges"] * 12
    mesh["streamEnd"] = r.pos
    mesh.update(vertices=vertices, normals=normals, nodes=nodes, leaves=leaves,
                headers=headers, triangles=triangles, quantised=quantised)
    return mesh


def read_static_mesh_desc(r, version, import_type):
    mesh = read_basic(r, version)
    mesh.update(read_tree(r, version))
    mesh["importType"] = import_type
    mesh["importName"] = IMPORT_NAMES.get(import_type, str(import_type))
    return mesh


def read_static_mesh(r, version, import_type):
    mesh = read_static_mesh_desc(r, version, import_type)
    mesh.update(read_instance(r))
    return mesh


def read_fluid_mesh_desc(r, version):
    mesh = read_basic(r, version)
    mesh["depth"] = r.u32()
    mesh.update(read_tree(r, version))
    if version >= 5:
        mesh["fluid"] = dict(density=r.f32(), linearDrag=r.f32(),
                             angularDrag=r.f32(), current=r.vec3(),
                             maxBuoyancy=r.f32(), gravity=r.f32())
    mesh["importType"] = 17
    mesh["importName"] = "FluidMesh"
    return mesh


def read_fluid_mesh(r, version):
    mesh = read_fluid_mesh_desc(r, version)
    mesh.update(read_instance(r))
    return mesh


def read_convex_payload(r):
    num_points = r.u32()
    num_triangles = r.u32()
    r.pos += num_points * 12 + num_triangles * 12
    return num_points, num_triangles


def read_desc_payload(r, import_type, version, collect):
    """Read one descriptor payload (without the leading type u32)."""
    if import_type in (0, 11):
        collect.append(read_static_mesh(r, version, import_type))
        return None
    if import_type in SIMPLE_PAYLOAD:
        r.pos += 52 + SIMPLE_PAYLOAD[import_type]
        return None
    if import_type == 3:
        r.pos += 52
        read_convex_payload(r)
        return None
    if import_type == 10:
        r.pos += 52 + 4
        return None
    if import_type == 8:
        r.pos += 52 + 28
        return None
    if import_type == 21:
        r.pos += 52
        return None
    if import_type == 17:
        fluid = read_fluid_mesh(r, version)
        # read_fluid_mesh already consumed the top-level instance; composites do
        # not have one here, so this is only used at top level. Caller handles it.
        collect.append(fluid)
        return fluid
    raise oracle.ParseError("unsupported_shape_type", r.pos - 4,
                            "type %d (%s)" % (import_type, IMPORT_NAMES.get(import_type, "?")))


def read_composite(r, version, collect):
    """C_CompositeDesc::Import from CompositeDescriptor.h."""
    basic = read_basic(r, version)
    num_elems = r.u32()
    if version >= 6:
        constraint_body_id = r.i32()
    else:
        constraint_body_id = 0
    subs = []
    for _ in range(num_elems):
        at = r.pos
        sub_type = r.u32()
        start = r.pos
        if sub_type in (0, 11):
            sub_mesh = read_static_mesh_desc(r, version, sub_type)
            collect.append(sub_mesh)
        elif sub_type in SIMPLE_PAYLOAD:
            r.pos += 52 + SIMPLE_PAYLOAD[sub_type]
        elif sub_type == 3:
            r.pos += 52
            read_convex_payload(r)
        elif sub_type == 10:
            r.pos += 52 + 4
        elif sub_type == 8:
            r.pos += 52 + 28
        elif sub_type == 17:
            read_fluid_mesh_desc(r, version)
        elif sub_type == 21:
            r.pos += 52
        elif sub_type == 7:
            # Nested composite. Its descriptor payload is the same recursive form.
            read_composite(r, version, collect)
        else:
            raise oracle.ParseError("unsupported_shape_type", at,
                                    "composite sub-type %d" % sub_type)
        # C_ShapeDescWrapper: mass f32 + HMat43 (9+3 f32) + HMat33 (9 f32)
        r.pos += 4 + 48 + 36
        subs.append(dict(importType=sub_type, bytes=r.pos - start))
    return dict(importType=7, importName="Composite", basic=basic,
                numElements=num_elems, constraintBodyID=constraint_body_id,
                subShapes=subs)


def scan_level(data):
    """Return the parsed shape stream. Raises oracle.ParseError on a hard stop."""
    if len(data) < 20:
        raise oracle.ParseError("file_too_small", 0, "shorter than a root block header")
    if data[0:4] != b"  CP":
        raise oracle.ParseError("bad_pc_marker", 0, "expected '  CP'")
    root = oracle.read_block_header(oracle.Reader(data, 4, len(data)))
    if root["id"] != "Physic":
        raise oracle.ParseError("bad_root_block", root["offset"], "id '%s'" % root["id"])
    if root["offset"] + root["size"] != len(data):
        raise oracle.ParseError("root_size_mismatch", root["offset"] + root["size"],
                                "file size mismatch")

    children = oracle.Reader(data, root["offset"] + 16, root["offset"] + root["size"])
    header = main = routes = None
    while children.pos < children.end:
        blk = oracle.read_block_header(children)
        if blk["id"] == "Header":
            header = blk
        elif blk["id"] == "Main":
            main = blk
        elif blk["id"] == "Routes":
            routes = blk
        else:
            raise oracle.ParseError("unknown_root_child", blk["offset"], blk["id"])
        children.pos = blk["offset"] + blk["size"]

    if header is None or main is None:
        raise oracle.ParseError("missing_required_block", children.end,
                                "Header/Main required")
    h = oracle.Reader(data, header["offset"] + 16, header["offset"] + header["size"])
    file_version = h.u32()
    route_count = h.i32()

    r = oracle.Reader(data, main["offset"] + 16, main["offset"] + main["size"])
    if bytes(data[r.pos:r.pos + 4]) != b"Head":
        raise oracle.ParseError("missing_gravity_head", main["offset"] + 16,
                                "no Head fourcc")
    r.pos += 4
    stream_version = r.u32()

    shapes = []
    types = []
    while True:
        at = r.pos
        import_type = r.u32()
        if import_type == SHAPE_TERMINATOR:
            shape_stream_end = r.pos
            break
        types.append(import_type)
        if import_type in (0, 11):
            mesh = read_static_mesh(r, stream_version, import_type)
            mesh["index"] = len(shapes)
            shapes.append(mesh)
        elif import_type in SIMPLE_PAYLOAD:
            read_desc_payload(r, import_type, stream_version, [])
            r.pos += INSTANCE_BYTES
            shapes.append(dict(index=len(shapes), importType=import_type,
                               importName=IMPORT_NAMES[import_type]))
        elif import_type == 3:
            read_desc_payload(r, import_type, stream_version, [])
            r.pos += INSTANCE_BYTES
            shapes.append(dict(index=len(shapes), importType=3, importName="ConvexHull"))
        elif import_type == 10:
            read_desc_payload(r, import_type, stream_version, [])
            r.pos += INSTANCE_BYTES
            shapes.append(dict(index=len(shapes), importType=10,
                               importName="InstancedTriangleMesh"))
        elif import_type == 8:
            read_desc_payload(r, import_type, stream_version, [])
            r.pos += INSTANCE_BYTES
            shapes.append(dict(index=len(shapes), importType=8,
                               importName="CharacterController"))
        elif import_type == 21:
            read_desc_payload(r, import_type, stream_version, [])
            r.pos += INSTANCE_BYTES
            shapes.append(dict(index=len(shapes), importType=21, importName="Null"))
        elif import_type == 7:
            collected = []
            comp = read_composite(r, stream_version, collected)
            r.pos += INSTANCE_BYTES
            comp["index"] = len(shapes)
            comp["compositeSubMeshes"] = len(collected)
            shapes.append(comp)
        elif import_type == 17:
            fluid = read_fluid_mesh(r, stream_version)  # includes instance
            fluid["index"] = len(shapes)
            shapes.append(fluid)
        else:
            raise oracle.ParseError("unsupported_shape_type", at,
                                    "type %d (%s)" % (import_type,
                                                      IMPORT_NAMES.get(import_type, "?")))

    con = r.u32()
    if con != CONSTRAINT_TERMINATOR:
        raise oracle.ParseError("unsupported_constraint", r.pos - 4,
                                "constraint type %d" % con)
    if r.pos != r.end:
        raise oracle.ParseError("main_block_trailing", r.pos, "unread bytes")
    return dict(fileVersion=file_version, routeCount=route_count,
                streamVersion=stream_version, shapeStreamEnd=shape_stream_end,
                types=types, shapes=shapes, routesParsed=False)


def flatten_static_triangles(level):
    """Return (vertices, triangles) for every non-fluid static triangle mesh."""
    out = []
    for mesh in level["shapes"]:
        if mesh.get("importType") not in (0, 11):
            continue
        verts = mesh["vertices"]
        for tri in mesh["triangles"]:
            leaf = mesh["leaves"][tri["leaf"]]
            base = leaf["vertex_start"]
            out.append((verts[base + tri["a"]], verts[base + tri["b"]],
                        verts[base + tri["c"]]))
    return out


if __name__ == "__main__":
    import json
    path = Path(sys.argv[1])
    level = scan_level(path.read_bytes())
    summary = {
        "fileVersion": level["fileVersion"],
        "streamVersion": level["streamVersion"],
        "types": level["types"],
        "shapes": [{k: v for k, v in s.items()
                    if k in ("index", "importType", "importName", "numVertices",
                             "numNodes", "numActiveEdges", "numElements",
                             "compositeSubMeshes")}
                   for s in level["shapes"]],
        "staticTriangles": sum(len(s["triangles"]) for s in level["shapes"]
                               if s.get("importType") in (0, 11)),
    }
    print(json.dumps(summary, indent=2))
