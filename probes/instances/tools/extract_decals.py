#!/usr/bin/env python3
"""Extract every ``Racification*`` additive decal draw from the level archives.

The decal layer is not opaque albedo: it is a separate additive, alpha-tested
pass. For each draw this tool records the draw id, source node, texture identity,
declared blend/depth/cull state, UV range and FNV-1a 64 hash, the static material
constants (``g_vColour`` and friends), the runtime inputs, and exact geometry
counts. Geometry is emitted in world space (identity transform).

Outputs ``_work/instances/<map>/decals.json`` and
``decal.positions.f32.bin`` / ``decal.uv0.f32.bin`` / ``decal.indices.u32.bin``.

Run after ``extract_instances.py``: the instance extractor owns and clears the
per-level ``textures`` directory, and this tool appends the decal textures to it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from instances_common import (  # noqa: E402
    LEVELS,
    ROOT,
    LevelData,
    TextureRegistry,
    TypedError,
    aabb,
    effect_state,
    fnv_mix_f32,
    load_json,
    output_dir,
    rel,
    sha256_bytes,
    sha256_file,
    write_json,
)

FX_RUNTIME_INPUTS = [
    {"name": "g_tDepthBuffer", "kind": "runtime-texture",
     "note": "engine depth buffer; DEPTHFADE variant only"},
    {"name": "g_vDepthScale", "kind": "shared-uniform",
     "note": "engine depth scale; DEPTHFADE variant only"},
    {"name": "g_RacificationGlobalFade", "kind": "shared-uniform",
     "note": "engine-wide fade, default 1.0"},
    {"name": "time", "kind": "engine-time",
     "note": "scroll parameters g_vScrollSpeedX/Y and g_vScrollTextureX/Y are animated when non-zero"},
]


def package_decal_index(level: LevelData):
    config = level.config
    if not config.get("package"):
        return {}, {"available": False, "reason": "no map package for this level"}
    diagnostics_path = ROOT / config["package"] / "diagnostics.json"
    slice_path = ROOT / "_work/map-slice" / level.short / "slice.json"
    if not diagnostics_path.exists() or not slice_path.exists():
        return {}, {"available": False, "reason": "package diagnostics missing"}
    diagnostics = load_json(diagnostics_path)
    slice_doc = load_json(slice_path)
    section_node = {s["id"]: s["nodeBlock"] for s in slice_doc["draws"]["sections"]}
    result = {}
    group = diagnostics.get("groups", {}).get("effectDecal", {})
    for draw in diagnostics.get("draws", []):
        node_block = section_node.get(draw.get("section"))
        if node_block is None:
            continue
        result[(node_block, draw["primitiveIndex"])] = {
            "section": draw["section"],
            "firstIndex": draw["firstIndex"],
            "indexCount": draw["indexCount"],
            "triangleCount": draw["triangleCount"],
            "uvHash": draw.get("uvHash"),
            "textureId": draw.get("textureId"),
            "auxTexture": (draw.get("diagnostic") or {}).get("auxTexture"),
            "drawId": draw.get("drawId"),
        }
    return result, {
        "available": True,
        "draws": len(diagnostics.get("draws", [])),
        "effectDecalDraws": group.get("draws"),
        "effectDecalTriangles": group.get("triangles"),
        "diagnosticsJson": rel(diagnostics_path),
        "diagnosticsJsonSha256": sha256_file(diagnostics_path),
    }


def decal_rows(level: LevelData):
    rows = []
    for row in level.census():
        if "node" not in row:
            continue
        node = row["node"]
        for primitive_index, primitive in enumerate(node["primitives"]):
            base = level.effect_base(primitive)
            if not base.lower().startswith("racification"):
                continue
            rows.append((row, node, primitive_index, primitive, base))
    return rows


def uv_digest(uvs: np.ndarray, indices: np.ndarray) -> str:
    digest = 0xCBF29CE484222325
    for index in indices:
        for axis in range(2):
            digest = fnv_mix_f32(digest, float(uvs[int(index), axis]))
    return "0x%016x" % digest


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
    summary = {"schema": "blur.instances/1", "kind": "level-decals",
               "generatedBy": "probes/instances/tools/extract_decals.py",
               "levels": {}}
    for short in ("river", "amboy", "gracia", "longbeach"):
        level = LevelData(short)
        out = output_dir(short)
        out.mkdir(parents=True, exist_ok=True)
        registry = TextureRegistry(level)
        package, package_info = package_decal_index(level)
        decals = []
        textures = {}
        positions_blocks = []
        uv_blocks = []
        index_blocks = []
        vertex_offset = 0
        index_offset = 0
        rejections = {}
        package_matched = 0
        uv_hash_mismatch = 0
        triangle_mismatch = 0
        for row, node, primitive_index, primitive, base in decal_rows(level):
            node_block = row["nodeBlock"]
            list_index = row["renderListIndex"]
            section = "n%d%s" % (node_block, "" if list_index == 0 else "#L%d" % list_index)
            draw_id = "%s#d%d" % (section, primitive_index)
            record = {
                "drawId": draw_id,
                "section": section,
                "nodeBlock": node_block,
                "recordIndex": row["recordIndex"],
                "itemIndex": row["itemIndex"],
                "renderListIndex": list_index,
                "activationUnproven": list_index > 0,
                "primitiveIndex": primitive_index,
                "effect": level.effect_name(primitive),
                "status": "pending",
            }
            try:
                mesh = level.decode_mesh(node, primitive)
            except TypedError as error:
                record["status"] = "rejected"
                record["rejection"] = {"code": error.code, "detail": error.detail}
                rejections[error.code] = rejections.get(error.code, 0) + 1
                decals.append(record)
                continue
            positions = np.asarray(mesh["positions"], dtype=np.float32)
            uvs = np.asarray(mesh["uv0"], dtype=np.float32)
            indices = np.asarray(mesh["indices"], dtype=np.uint32)
            uvmin = [float(uvs[:, 0].min()), float(uvs[:, 1].min())]
            uvmax = [float(uvs[:, 0].max()), float(uvs[:, 1].max())]
            digest = uv_digest(uvs, indices)
            record.update({
                "status": "resolved",
                "primitiveIndex": primitive_index,
                "topology": mesh["topology"],
                "declaration": mesh["declaration"],
                "vertexCount": mesh["vertexCount"],
                "indexCount": mesh["indexCount"],
                "triangleCount": mesh["triangleCount"],
                "worldBounds": aabb(positions.astype(np.float64)),
                "transform": {
                    "kind": "identity",
                    "note": "direct level draw; POSITION is already world space",
                },
                "uv": {"min": uvmin, "max": uvmax, "hash": digest,
                       "available": mesh["uv0Available"]},
                "vertexOffset": vertex_offset,
                "indexOffset": index_offset,
            })
            positions_blocks.append(positions.astype("<f4").tobytes())
            uv_blocks.append(uvs.astype("<f4").tobytes())
            index_blocks.append(indices.astype("<u4").tobytes())
            vertex_offset += int(mesh["vertexCount"])
            index_offset += int(mesh["indexCount"])

            # material + texture
            try:
                material = level.resolve_material(node, None, primitive)
                record["material"] = {
                    "albedo": material["albedo"],
                    "textures": material["textures"],
                    "runtime": material["runtime"],
                    "staticParameters": [f for f in material["fields"]
                                         if f["name"] not in ("g_tTexture",)],
                    "texture": None,
                }
                chosen = next((t for t in material["textures"]
                               if t["parameter"] == "g_tTexture"), None)
                if chosen is None and material["textures"]:
                    chosen = material["textures"][0]
                if chosen is not None:
                    source = level.texture_source(node, chosen["slot"])
                    texture = registry.resolve(source)
                    record["material"]["texture"] = texture
                    record["textureId"] = texture["id"]
                    textures[texture["id"]] = texture
                record["materialStatic"] = all(
                    not item for item in material["runtime"])
            except (TypedError, ValueError) as error:
                code = error.code if isinstance(error, TypedError) else "materialRejected"
                record["material"] = {"rejection": {"code": code, "detail": str(error)}}
                record["materialStatic"] = False

            state = effect_state(level, primitive)
            record["effectState"] = state
            record["pass"] = {
                "name": "effect-additive-decal",
                "opaqueAlbedo": False,
                "alphaBlend": state.get("alphaBlend"),
                "alphaTest": state.get("alphaTest"),
                "depth": state.get("depth"),
                "cull": state.get("cull"),
                "sortType": state.get("techniqueSort"),
                "runtimeInputs": FX_RUNTIME_INPUTS,
            }
            matched = package.get((node_block, primitive_index))
            if matched:
                package_matched += 1
                uv_ok = matched.get("uvHash") in (None, digest)
                tri_ok = matched.get("triangleCount") == record["triangleCount"]
                if not uv_ok:
                    uv_hash_mismatch += 1
                if not tri_ok:
                    triangle_mismatch += 1
                record["package"] = {
                    "matched": True,
                    "drawId": matched.get("drawId"),
                    "section": matched.get("section"),
                    "firstIndex": matched.get("firstIndex"),
                    "indexCount": matched.get("indexCount"),
                    "triangleCount": matched.get("triangleCount"),
                    "uvHash": matched.get("uvHash"),
                    "uvHashMatch": uv_ok,
                    "triangleCountMatch": tri_ok,
                }
            else:
                record["package"] = {"matched": False,
                                     "reason": ("noDecalPackage" if not package_info.get("available")
                                                else "outsidePackageSupportedSections")}
            decals.append(record)

        position_bytes = b"".join(positions_blocks)
        uv_bytes = b"".join(uv_blocks)
        index_bytes = b"".join(index_blocks)
        paths = {
            "positions": out / "decal.positions.f32.bin",
            "uv0": out / "decal.uv0.f32.bin",
            "indices": out / "decal.indices.u32.bin",
        }
        paths["positions"].write_bytes(position_bytes)
        paths["uv0"].write_bytes(uv_bytes)
        paths["indices"].write_bytes(index_bytes)

        resolved = [d for d in decals if d["status"] == "resolved"]
        blend_groups = {}
        for decal in resolved:
            state = decal["effectState"]
            key = "%s|%s|%s|%s|%s|%s" % (
                state.get("effect"), state.get("alphaBlend", {}).get("src"),
                state.get("alphaBlend", {}).get("dst"),
                state.get("alphaBlend", {}).get("op"),
                state.get("depth", {}).get("write"),
                state.get("cull", {}).get("declared"))
            blend_groups[key] = blend_groups.get(key, 0) + 1
        counts = {
            "draws": len(decals),
            "resolved": len(resolved),
            "rejected": len(decals) - len(resolved),
            "rejectionsByCode": dict(sorted(rejections.items())),
            "triangles": int(sum(d["triangleCount"] for d in resolved)),
            "vertices": int(sum(d["vertexCount"] for d in resolved)),
            "sections": len({(d["nodeBlock"], d["renderListIndex"]) for d in decals}),
            "textures": len(textures),
            "textureRgbaBytes": int(sum(t["rgbaBytes"] for t in textures.values())),
            "texturePayloadBytes": int(sum(t["payloadBytes"] or 0 for t in textures.values())),
            "packageMatched": package_matched,
            "packageUvHashMismatch": uv_hash_mismatch,
            "packageTriangleMismatch": triangle_mismatch,
            "materialStaticDraws": sum(1 for d in resolved
                                       if d.get("materialStatic")),
            "blendGroups": dict(sorted(blend_groups.items())),
        }
        doc = {
            "schema": "blur.instances/1",
            "kind": "level-decal-records",
            "level": level.level,
            "shortName": short,
            "scope": (
                "every Racification* direct primitive serialized in every LOD0 "
                "Scene stream item; geometry decoded through committed POSITION/"
                "UV0/index readers; pass state parsed from the committed FX source"
            ),
            "inputs": {
                "levelRender": {"path": rel(level.render_path),
                                "bytes": len(level.header),
                                "sha256": sha256_bytes(level.header)},
                "levelStream": {"path": rel(level.stream_path),
                                "bytes": level.stream_path.stat().st_size,
                                "sha256": sha256_file(level.stream_path)},
            },
            "package": package_info,
            "counts": counts,
            "textures": sorted(textures.values(), key=lambda t: t["id"]),
            "decals": decals,
            "buffers": {
                "positions": {"path": paths["positions"].name, "bytes": len(position_bytes),
                              "sha256": sha256_bytes(position_bytes)},
                "uv0": {"path": paths["uv0"].name, "bytes": len(uv_bytes),
                        "sha256": sha256_bytes(uv_bytes)},
                "indices": {"path": paths["indices"].name, "bytes": len(index_bytes),
                            "sha256": sha256_bytes(index_bytes)},
            },
            "limits": [
                "only Racification* effects are classified as the additive decal layer",
                "exact ordering inside the racification sort group is not recovered",
                "AlphaRef is not declared in the FX pass; D3D default is recorded, not applied",
                "ZEnable is not declared; the D3D/FX default (test on) is recorded, not applied",
                "runtime uniforms (global fade, depth buffer, scroll time) are not evaluated",
            ],
        }
        write_json(out / "decals.json", doc)
        summary["levels"][short] = {
            "level": level.level,
            "counts": counts,
            "hashes": {
                "decalsJson": sha256_file(out / "decals.json"),
                "positions": sha256_bytes(position_bytes),
                "uv0": sha256_bytes(uv_bytes),
                "indices": sha256_bytes(index_bytes),
            },
            "bytes": {
                "decalsJson": (out / "decals.json").stat().st_size,
                "positions": len(position_bytes),
                "uv0": len(uv_bytes),
                "indices": len(index_bytes),
            },
        }
        print(json.dumps({short: counts}, indent=1))
    write_json(root_out / "decals-summary.json", summary, pretty=True)
    print(str(root_out / "decals-summary.json"))


if __name__ == "__main__":
    main()
