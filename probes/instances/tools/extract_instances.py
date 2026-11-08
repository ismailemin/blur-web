#!/usr/bin/env python3
"""Extract every serialized level instance into a drawable, deterministic package.

For each level (``river``, ``amboy``, ``gracia``, ``longbeach``) this tool:

1. walks every LOD0 item of every Scene stream record and reads every RenderList;
2. records each instance's source node, archived bounds, constant transform and
   material stack;
3. resolves its ``basePrimitives[primitiveIndex]`` mesh through the committed
   POSITION/UV0/index readers (supported stream types only);
4. deduplicates identical mesh ranges into one mesh table + one uploaded buffer
   set, and writes a per-instance transform buffer;
5. rejects unresolvable references with a typed reason and a counted total.

Outputs ``_work/instances/<map>/instances.json``, ``instance-meshes.json``,
``instance-mesh.positions.f32.bin``, ``instance-mesh.uv0.f32.bin``,
``instance-mesh.indices.u32.bin`` and ``instance-transforms.f32.bin``.
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from instances_common import (  # noqa: E402
    BOUNDS_TOLERANCE,
    LEVELS,
    ROOT,
    LevelData,
    TextureRegistry,
    TypedError,
    aabb,
    bounds_error,
    bounds_excess,
    bounds_record,
    bounds_tolerance,
    is_finite,
    load_json,
    matrix_determinant,
    matrix_scale,
    output_dir,
    rel,
    reset_texture_dir,
    sha256_bytes,
    sha256_file,
    transform_points,
    union_boxes,
    write_json,
)

PROBES = ROOT / "_work/map-pipeline/draw-probes-all.json"


def package_keys(level: LevelData):
    """Source tuples of every drawable draw already in the map package."""
    config = level.config
    if not config.get("package"):
        return set(), {"available": False, "reason": "no map package for this level"}
    render_path = ROOT / config["package"] / "render.json"
    slice_path = ROOT / "_work/map-slice" / level.short / "slice.json"
    if not render_path.exists() or not slice_path.exists():
        return set(), {"available": False, "reason": "package manifest missing"}
    render = load_json(render_path)
    slice_doc = load_json(slice_path)
    sections = {s["id"]: s for s in slice_doc["draws"]["sections"]}
    node_cache = {}
    keys = set()
    for draw in render["draws"]:
        section = sections.get(draw["section"])
        if section is None:
            continue
        node_path = ROOT / section["nodeChunk"]["file"]
        if not node_path.exists():
            continue
        key = section["id"]
        if key not in node_cache:
            raw = node_path.read_bytes()
            record = next((c for c in level.records
                           if c["items"] and c["items"][0]["block"] == section["nodeBlock"]
                           and c["items"][0]["lod"] == 0), None)
            if record is None:
                node_cache[key] = None
                continue
            data = raw
            from instances_common import resource_prefix, stream_prefix  # local import
            from inspect_level_instances import read_lists  # noqa: F401
            stream_prefix(data, record)
            resources = resource_prefix(data, {"resourcePayloadOffset": 24,
                                               "scenePayloadOffset": 0}, streamed=True)
            node_cache[key] = read_lists(data, resources)[0]
        node = node_cache[key]
        if node is None:
            continue
        primitive = node["primitives"][draw["primitiveIndex"]]
        try:
            binding = level.position_uv_binding(node, primitive)
        except TypedError:
            continue
        keys.add(level.mesh_key(binding))
    geometry_blocks = sorted({s["geometryBlock"] for s in slice_doc["draws"]["sections"]})
    return keys, {"available": True, "drawTuples": len(keys),
                  "geometryBlocks": geometry_blocks,
                  "renderJson": rel(render_path),
                  "renderJsonSha256": sha256_file(render_path)}


def section_geometry_block(level: LevelData, node: dict, fallback: int) -> int:
    for primitive in node.get("primitives", []):
        try:
            binding = level.position_uv_binding(node, primitive)
        except TypedError:
            continue
        block = binding["positionSource"]["block"]
        if block == binding["indexSource"]["block"]:
            return block
    return fallback


def instance_sections(level: LevelData):
    rows = level.census()
    sections = []
    for row in rows:
        if "node" not in row:
            continue
        node = row["node"]
        if not node["instances"]:
            continue
        geom = section_geometry_block(level, node, row["nodeBlock"])
        suffix = "" if row["renderListIndex"] == 0 else "#L%d" % row["renderListIndex"]
        sections.append({
            "sectionId": "g%d-n%d%s" % (geom, row["nodeBlock"], suffix),
            "nodeBlock": row["nodeBlock"],
            "recordIndex": row["recordIndex"],
            "itemIndex": row["itemIndex"],
            "renderListIndex": row["renderListIndex"],
            "geometryBlock": geom,
            "node": node,
            "activationUnproven": row["renderListIndex"] > 0,
        })
    return sections


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-root", type=Path, default=None,
                        help="override _work/instances (determinism rebuilds)")
    args = parser.parse_args()
    from instances_common import set_output_root
    set_output_root(args.out_root)
    root_out = (args.out_root.resolve() if args.out_root else ROOT / "_work/instances")
    root_out.mkdir(parents=True, exist_ok=True)
    summary = {"schema": "blur.instances/1", "kind": "level-instances",
               "generatedBy": "probes/instances/tools/extract_instances.py",
               "levels": {}}
    for short in ("river", "amboy", "gracia", "longbeach"):
        level = LevelData(short)
        out = output_dir(short)
        out.mkdir(parents=True, exist_ok=True)
        reset_texture_dir(short)
        registry = TextureRegistry(level)
        pkg_keys, pkg_info = package_keys(level)
        sections = instance_sections(level)

        meshes = {}
        mesh_order = []
        instances = []
        rejections = {}
        instance_textures = {}

        for section in sections:
            node = section["node"]
            instance_bounds = node["bounds"]["instance"]
            if len(instance_bounds) != len(node["instances"]):
                raise SystemExit("FAILED: %s instance bounds count mismatch" % section["sectionId"])
            for index, instance in enumerate(node["instances"]):
                instance_id = "%s#i%d" % (section["sectionId"], index)
                record = {
                    "instanceId": instance_id,
                    "section": section["sectionId"],
                    "nodeBlock": section["nodeBlock"],
                    "recordIndex": section["recordIndex"],
                    "itemIndex": section["itemIndex"],
                    "renderListIndex": section["renderListIndex"],
                    "activationUnproven": section["activationUnproven"],
                    "instanceIndex": index,
                    "basePrimitiveIndex": instance["primitiveIndex"],
                    "flags": instance["flags"],
                    "transform": None,
                    "mesh": None,
                    "material": None,
                    "archivedBounds": bounds_record(instance_bounds[index]),
                    "worldBounds": None,
                    "boundsCheck": None,
                    "group": None,
                    "package": {
                        "inPackage": False,
                        "reason": None,
                    },
                    "status": "pending",
                }
                base = node["basePrimitives"][instance["primitiveIndex"]]
                record["effect"] = level.effect_name(base)
                try:
                    binding = level.position_uv_binding(node, base)
                    record["meshReference"] = {
                        "positionBlock": binding["positionSource"]["block"],
                        "positionIndex": binding["positionSource"]["index"],
                        "indexBlock": binding["indexSource"]["block"],
                        "indexIndex": binding["indexSource"]["index"],
                        "lod": binding["lod"],
                        "topology": binding["topology"],
                        "declaration": binding["declaration"],
                        "positionElement": binding["position"],
                        "uv0Element": binding["uv0"],
                        "vertexOffset": binding["positionStream"]["vertexOffset"],
                    }
                except TypedError as error:
                    record["meshReference"] = None
                    record["status"] = "mesh-rejected"
                    record["rejection"] = {"code": error.code, "detail": error.detail}
                    rejections[error.code] = rejections.get(error.code, 0) + 1
                    instances.append(record)
                    continue

                try:
                    matrix, trace = constant_world_safe(level, node, instance, base)
                    scale = matrix_scale(matrix)
                    determinant = matrix_determinant(matrix)
                    record["transform"] = {
                        "matrix": [float(v) for v in matrix],
                        "matrixSemantics": "row vector: out[a]=x*m[a]+y*m[4+a]+z*m[8+a]+m[12+a]",
                        "materialRow": trace[0]["material"] if trace else None,
                        "serializedOffsets": [t["serializedOffset"] for t in trace],
                        "affine": (matrix[3] == 0 and matrix[7] == 0 and matrix[11] == 0
                                   and matrix[15] == 1),
                        "finite": is_finite(matrix),
                        "scale": scale,
                        "maxScale": max(scale),
                        "uniformScale": max(scale) - min(scale) <= 1e-5 * max(1.0, max(scale)),
                        "determinant": determinant,
                    }
                except (ValueError, IndexError) as error:
                    record["status"] = "transform-rejected"
                    record["rejection"] = {"code": "transformRejected", "detail": str(error)}
                    rejections["transformRejected"] = rejections.get("transformRejected", 0) + 1
                    instances.append(record)
                    continue

                try:
                    mesh = level.decode_mesh(node, base)
                    key = level.mesh_key(level.position_uv_binding(node, base))
                    if key not in meshes:
                        meshes[key] = {
                            "meshId": "m%05d" % len(mesh_order),
                            "sourceBlock": mesh["sourceBlock"],
                            "vertexBuffer": mesh["vertexBuffer"],
                            "indexBuffer": mesh["indexBuffer"],
                            "lod": mesh["lod"],
                            "topology": mesh["topology"],
                            "declaration": mesh["declaration"],
                            "vertexCount": mesh["vertexCount"],
                            "indexCount": mesh["indexCount"],
                            "triangleCount": mesh["triangleCount"],
                            "localBounds": mesh["localBounds"],
                            "uv0Available": mesh["uv0Available"],
                            "recordPrerequisites": mesh["recordPrerequisites"],
                            "positions": mesh["positions"],
                            "uv0": mesh["uv0"],
                            "indices": mesh["indices"],
                            "instanceCount": 0,
                            "reuse": 0,
                        }
                        mesh_order.append(key)
                    entry = meshes[key]
                    entry["instanceCount"] += 1
                    entry["reuse"] = entry["instanceCount"] - 1
                    record["mesh"] = {
                        "meshId": entry["meshId"],
                        "vertexCount": entry["vertexCount"],
                        "indexCount": entry["indexCount"],
                        "triangleCount": entry["triangleCount"],
                        "localBounds": entry["localBounds"],
                        "uv0Available": entry["uv0Available"],
                    }
                    record["status"] = "resolved"
                except TypedError as error:
                    record["status"] = "mesh-rejected"
                    record["rejection"] = {"code": error.code, "detail": error.detail}
                    rejections[error.code] = rejections.get(error.code, 0) + 1
                    record["package"]["reason"] = package_reason(level, record)
                    instances.append(record)
                    continue

                # material + texture
                try:
                    material = level.resolve_material(node, instance, base)
                    albedo = material["albedo"]
                    record["material"] = {
                        "albedo": albedo,
                        "textures": material["textures"],
                        "runtime": material["runtime"],
                        "texture": None,
                    }
                    if albedo["known"] and albedo["slot"] is not None:
                        source = level.texture_source(node, albedo["slot"])
                        texture = registry.resolve(source)
                        record["material"]["texture"] = texture
                        instance_textures[texture["id"]] = texture
                except (TypedError, ValueError) as error:
                    code = error.code if isinstance(error, TypedError) else "materialRejected"
                    record["material"] = {"albedo": None, "textures": [], "runtime": [],
                                          "texture": None,
                                          "rejection": {"code": code, "detail": str(error)}}

                # world bounds + package presence
                world = transform_points(
                    np.asarray(meshes[key]["positions"], dtype=np.float32),
                    record["transform"]["matrix"])
                record["worldBounds"] = aabb(world)
                tolerance = bounds_tolerance(record["worldBounds"], instance_bounds[index])
                record["boundsCheck"] = {
                    "contained": bounds_excess(record["worldBounds"],
                                               instance_bounds[index]) <= tolerance,
                    "excess": bounds_excess(record["worldBounds"], instance_bounds[index]),
                    "recordError": bounds_error(record["worldBounds"], instance_bounds[index]),
                    "tolerance": tolerance,
                }
                key_tuple = level.mesh_key(level.position_uv_binding(node, base))
                record["package"] = {
                    "inPackage": key_tuple in pkg_keys,
                    "reason": None if key_tuple in pkg_keys else package_reason(level, record),
                }
                instances.append(record)

        # ------------------------------------------------------ group bounds
        groups = {}
        for record in instances:
            if record["status"] != "resolved":
                continue
            row = record["transform"]["materialRow"]
            key = (record["nodeBlock"], record["renderListIndex"], row)
            groups.setdefault(key, []).append(record)
        group_rows = []
        for key, members in sorted(groups.items(),
                                   key=lambda item: (item[0][0], item[0][1], item[0][2] or -1)):
            node_block, list_index, row = key
            records_raw = {tuple(struct.pack("<8f", *m["archivedBounds"]["raw"])) for m in members}
            identical = len(records_raw) == 1
            union = union_boxes([m["worldBounds"] for m in members])
            record = members[0]["archivedBounds"]["raw"]
            error = bounds_error(union, record) if identical else None
            excess = bounds_excess(union, record) if identical else None
            tolerance = bounds_tolerance(union, record)
            tight = error is not None and error <= tolerance
            contained = excess is not None and excess <= tolerance
            if tight:
                status = "validated-tight"
            elif contained:
                status = "validated-contained"
            elif not identical:
                status = "record-mismatch"
            else:
                status = "union-exceeds-record"
            rowrecord = {
                "nodeBlock": node_block,
                "renderListIndex": list_index,
                "transformConstantRow": row,
                "instances": len(members),
                "recordsByteIdentical": identical,
                "unionError": error,
                "unionExcess": excess,
                "tolerance": tolerance,
                "validated": tight or contained,
                "status": status,
            }
            group_rows.append(rowrecord)
            for member in members:
                member["group"] = dict(rowrecord, groupIndex=len(group_rows) - 1)

        # ----------------------------------------------------- mesh buffers
        mesh_rows = []
        position_blocks = []
        uv0_blocks = []
        index_blocks = []
        vertex_offset = 0
        index_offset = 0
        for key in mesh_order:
            mesh = meshes[key]
            mesh["vertexOffset"] = vertex_offset
            mesh["indexOffset"] = index_offset
            vertex_offset += mesh["vertexCount"]
            index_offset += mesh["indexCount"]
            position_blocks.append(mesh["positions"].astype("<f4").tobytes())
            uv0_blocks.append(mesh["uv0"].astype("<f4").tobytes())
            index_blocks.append(mesh["indices"].astype("<u4").tobytes())
            mesh_rows.append({
                "meshId": mesh["meshId"],
                "sourceBlock": mesh["sourceBlock"],
                "sourceVertexBuffer": mesh["vertexBuffer"],
                "sourceIndexBuffer": mesh["indexBuffer"],
                "lod": mesh["lod"],
                "topology": mesh["topology"],
                "declaration": mesh["declaration"],
                "vertexOffset": mesh["vertexOffset"],
                "vertexCount": mesh["vertexCount"],
                "indexOffset": mesh["indexOffset"],
                "indexCount": mesh["indexCount"],
                "triangleCount": mesh["triangleCount"],
                "localBounds": mesh["localBounds"],
                "uv0Available": mesh["uv0Available"],
                "recordPrerequisites": mesh["recordPrerequisites"],
                "instanceCount": mesh["instanceCount"],
                "reuse": mesh["reuse"],
            })
        position_bytes = b"".join(position_blocks)
        uv0_bytes = b"".join(uv0_blocks)
        index_bytes = b"".join(index_blocks)
        transforms = b"".join(
            struct.pack("<16f", *([0.0] * 16 if r["transform"] is None else r["transform"]["matrix"]))
            for r in instances)
        paths = {
            "positions": out / "instance-mesh.positions.f32.bin",
            "uv0": out / "instance-mesh.uv0.f32.bin",
            "indices": out / "instance-mesh.indices.u32.bin",
            "transforms": out / "instance-transforms.f32.bin",
        }
        paths["positions"].write_bytes(position_bytes)
        paths["uv0"].write_bytes(uv0_bytes)
        paths["indices"].write_bytes(index_bytes)
        paths["transforms"].write_bytes(transforms)

        resolved = [r for r in instances if r["status"] == "resolved"]
        counts = {
            "sections": len(sections),
            "sectionsFirstRenderList": sum(1 for s in sections if s["renderListIndex"] == 0),
            "sectionsLaterRenderList": sum(1 for s in sections if s["renderListIndex"] > 0),
            "instances": len(instances),
            "instancesFirstRenderList": sum(1 for r in instances if r["renderListIndex"] == 0),
            "instancesLaterRenderList": sum(1 for r in instances if r["renderListIndex"] > 0),
            "resolved": len(resolved),
            "rejected": len(instances) - len(resolved),
            "rejectionsByCode": dict(sorted(rejections.items())),
            "uniqueMeshes": len(mesh_rows),
            "meshVertices": int(vertex_offset),
            "meshIndices": int(index_offset),
            "meshTrianglesUnique": int(index_offset // 3),
            "instanceTrianglesRendered": int(sum(r["mesh"]["triangleCount"]
                                                  for r in resolved)),
            "instanceVerticesRendered": int(sum(r["mesh"]["vertexCount"]
                                                for r in resolved)),
            "boundsGroups": len(group_rows),
            "boundsGroupsValidated": sum(1 for g in group_rows if g["validated"]),
            "boundsGroupsTight": sum(1 for g in group_rows if g["status"] == "validated-tight"),
            "boundsGroupsContained": sum(1 for g in group_rows
                                         if g["status"] == "validated-contained"),
            "boundsGroupsExceedRecord": sum(1 for g in group_rows
                                            if g["status"] == "union-exceeds-record"),
            "instancesContained": sum(1 for r in resolved
                                      if r["boundsCheck"]["contained"]),
            "instancesInPackage": sum(1 for r in instances if r["package"]["inPackage"]),
            "instanceTextures": len(instance_textures),
            "instanceTextureRgbaBytes": int(sum(t["rgbaBytes"] for t in instance_textures.values())),
        }
        texture_rows = sorted(instance_textures.values(), key=lambda t: t["id"])
        instances_doc = {
            "schema": "blur.instances/1",
            "kind": "level-instance-records",
            "level": level.level,
            "shortName": short,
            "scope": (
                "every RenderList serialized in every LOD0 Scene stream item; "
                "instances[i] of each RenderList; meshes decoded through committed "
                "POSITION/UV0/index readers only. Node-tree activation is not "
                "traversed, so renderListIndex>0 is labelled activationUnproven."
            ),
            "inputs": {
                "levelRender": {"path": rel(level.render_path),
                                "bytes": len(level.header),
                                "sha256": sha256_bytes(level.header)},
                "levelStream": {"path": rel(level.stream_path),
                                "bytes": level.stream_path.stat().st_size,
                                "sha256": sha256_file(level.stream_path)},
            },
            "package": pkg_info,
            "counts": counts,
            "sections": [{
                "section": s["sectionId"],
                "nodeBlock": s["nodeBlock"],
                "recordIndex": s["recordIndex"],
                "itemIndex": s["itemIndex"],
                "renderListIndex": s["renderListIndex"],
                "geometryBlock": s["geometryBlock"],
                "instances": len(s["node"]["instances"]),
                "basePrimitives": len(s["node"]["basePrimitives"]),
                "activationUnproven": s["activationUnproven"],
            } for s in sections],
            "boundsGroups": group_rows,
            "instances": instances,
            "textures": texture_rows,
            "buffers": {
                "positions": {"path": paths["positions"].name,
                              "bytes": len(position_bytes),
                              "sha256": sha256_bytes(position_bytes)},
                "uv0": {"path": paths["uv0"].name,
                        "bytes": len(uv0_bytes),
                        "sha256": sha256_bytes(uv0_bytes)},
                "indices": {"path": paths["indices"].name,
                            "bytes": len(index_bytes),
                            "sha256": sha256_bytes(index_bytes)},
                "transforms": {"path": paths["transforms"].name,
                               "bytes": len(transforms),
                               "sha256": sha256_bytes(transforms)},
            },
            "limits": [
                "node-tree activation is not traversed; later RenderLists are labelled activationUnproven",
                "mesh references are decoded only for POSITION type 6/9, UV0 type 5/8/9 and topology list/strip",
                "archived instance bounds are validated per CullNode proxy group (transform constant row)",
                "materials beyond static g_tAlbedo/g_MeshTexture identity are not applied",
                "record prerequisites are recorded but not separately traversed",
            ],
        }
        write_json(out / "instances.json", instances_doc)
        meshes_doc = {
            "schema": "blur.instances/1",
            "kind": "level-instance-meshes",
            "level": level.level,
            "shortName": short,
            "counts": {
                "meshes": len(mesh_rows),
                "vertices": int(vertex_offset),
                "indices": int(index_offset),
                "triangles": int(index_offset // 3),
                "instances": len(instances),
                "resolvedInstances": len(resolved),
            },
            "buffers": instances_doc["buffers"],
            "meshes": mesh_rows,
        }
        write_json(out / "instance-meshes.json", meshes_doc)

        summary["levels"][short] = {
            "level": level.level,
            "counts": counts,
            "hashes": {
                "instancesJson": sha256_file(out / "instances.json"),
                "meshesJson": sha256_file(out / "instance-meshes.json"),
                "positions": sha256_bytes(position_bytes),
                "uv0": sha256_bytes(uv0_bytes),
                "indices": sha256_bytes(index_bytes),
                "transforms": sha256_bytes(transforms),
            },
            "bytes": {
                "instancesJson": (out / "instances.json").stat().st_size,
                "meshesJson": (out / "instance-meshes.json").stat().st_size,
                "positions": len(position_bytes),
                "uv0": len(uv0_bytes),
                "indices": len(index_bytes),
                "transforms": len(transforms),
            },
        }
        print(json.dumps({short: counts, "hashes": summary["levels"][short]["hashes"]},
                         indent=1))

    write_json(root_out / "summary.json", summary, pretty=True)
    print(str(root_out / "summary.json"))


def constant_world_safe(level: LevelData, node: dict, instance: dict, base: dict):
    from inspect_level_instances import constant_world
    try:
        return constant_world(node, instance, base)
    except ValueError as error:
        raise ValueError(str(error))


def package_reason(level: LevelData, record: dict) -> str:
    config = level.config
    if not config.get("package"):
        return "noMapPackage"
    reference = record.get("meshReference")
    if reference is None:
        return "meshReferenceUnresolved"
    return "referencedBlockNotDirectInPackage"


if __name__ == "__main__":
    main()
