#!/usr/bin/env python3
"""Map batch compiler — shared stages.

One level id in, one self-describing package out:

    _work/map-batch/<level>/
        manifest.json
        draws.json
        draws.positions.f32.bin
        draws.uv0.f32.bin
        draws.indices.u32.bin
        textures/index.json
        textures/tex-NNN.rgba
        collision.json
        collision.positions.f32.bin
        collision.indices.u32.bin
        path.json
        path.points.f32.bin
        spawn.json
        blockers.json
        report.json

Every geometry value is produced by the committed readers. This module does not
contain a second binary decoder:

  * collision   -> probes/map-pipeline/tools/physics_scan.py
  * draw decode -> the committed native `level_inspect.exe` output already
                   staged by probes/map-pipeline/tools/probe_draws.py
  * textures    -> probes/map-slice/tools/amboy_texture_bindings.py primitives
                   (Resolver / TextureArchive / decode_texture / classify_draw)
  * spawn rays  -> probes/map-slice/tools/extract_slice.py ray helpers
  * measurement -> the committed map-pipeline 1 m grid, collision path and
                   draw-covered path artifacts (pinned by hash)

Data only. No renderer, GPU, browser, engine-physics or playable-game claim is
made by this module.
"""
from __future__ import annotations

import hashlib
import json
import math
import shutil
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))
sys.path.insert(0, str(ROOT / "probes/map-slice/tools"))
sys.path.insert(0, str(ROOT / "tools"))

import amboy_texture_bindings as tb  # noqa: E402
import extract_slice as xs  # noqa: E402
import map_slice_common as msc  # noqa: E402
import physics_scan  # noqa: E402

LEVELS_DIR = ROOT / "game-data/Blur/levels"
PIPELINE = ROOT / "_work/map-pipeline"
BATCH = ROOT / "_work/map-batch"
LOGS = ROOT / "_work/logs/map-batch"
REGISTRY = ROOT / "probes/e1-drive/web/map-registry.js"

DRAW_PROBE_DOCS = (
    "draw-probes-all.json",
    "draw-probes-top.json",
    "draw-probes-extra.json",
    "draw-probes-sausalito.json",
)

SCHEMA_MANIFEST = "blur.map-batch.manifest/1"
SCHEMA_DRAWS = "blur.map-batch.draws/1"
SCHEMA_TEXTURES = "blur.map-batch.textures/1"
SCHEMA_COLLISION = "blur.map-batch.collision/1"
SCHEMA_PATH = "blur.map-batch.path/1"
SCHEMA_SPAWN = "blur.map-batch.spawn/1"
SCHEMA_BLOCKERS = "blur.map-batch.blockers/1"
SCHEMA_REPORT = "blur.map-batch.report/1"

# Maps integrated in probes/e1-drive/web/map-registry.js. `playable` is an
# integration fact with a repository pin, not a data-only claim.
INTEGRATED = {
    "usa_la_river": "river",
    "usa_amboy": "amboy",
    "spa_barcelona_gracia": "gracia",
    "usa_la_longbeachdocks": "longbeach",
    "usa_la_observatory": "observatory",
    "usa_la_downtown": "downtown",
    "jpn_mharuna": "mharuna",
    "usa_la_multiplayer_highrise": "highrise",
    "jpn_tokyo_shutoko": "shutoko",
    "spa_barcelona_oval": "oval",
    "usa_amboy_multiplayer": "amboy-mp",
}

MIN_COVERED_PATH_M = 25.0
SAMPLE_STEP_M = 0.25
PATH_MAX_STEP_M = 0.250001
TEXTURE_LIMIT_PX = 512

# Artifacts written by this compiler, in manifest order.
ARTIFACTS = (
    "draws.json",
    "draws.positions.f32.bin",
    "draws.uv0.f32.bin",
    "draws.lightmapUv.f32.bin",
    "draws.indices.u32.bin",
    "textures/index.json",
    "collision.json",
    "collision.positions.f32.bin",
    "collision.indices.u32.bin",
    "path.json",
    "path.points.f32.bin",
    "spawn.json",
    "blockers.json",
)


# --------------------------------------------------------------------- helpers

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def write_json(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(doc, indent=1, ensure_ascii=False, allow_nan=False, sort_keys=True) + "\n",
        encoding="utf-8")


def file_record(path: Path, base: Path | None = None) -> dict:
    data = path.read_bytes()
    name = path.relative_to(base).as_posix() if base else rel(path)
    return {"path": name, "bytes": len(data), "sha256": sha256_bytes(data)}


def f32_array(values) -> np.ndarray:
    array = np.asarray(values, dtype="<f4")
    if not np.isfinite(array).all():
        raise ValueError("non-finite float in a binary export")
    return array


def u32_array(values) -> np.ndarray:
    array = np.asarray(values, dtype="<u4")
    if array.size and int(array.max()) > 0xFFFFFFFF:
        raise ValueError("uint32 export overflow")
    return array


def write_bin(path: Path, array: np.ndarray) -> dict:
    data = np.ascontiguousarray(array).tobytes(order="C")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"file": path.name, "bytes": len(data), "sha256": sha256_bytes(data),
            "dtype": str(array.dtype), "count": int(array.size)}


def all_levels() -> list[str]:
    return sorted(p.name for p in LEVELS_DIR.iterdir() if p.is_dir())


def level_files(level: str) -> dict:
    base = LEVELS_DIR / level
    out = {}
    for key, name in (("level", "Level.level"), ("physics", "Level.levelphysics"),
                      ("render", "Level.levelrender"), ("stream", "Level.levelstream")):
        path = base / name
        out[key] = {"exists": path.is_file()}
        if path.is_file():
            out[key].update(bytes=path.stat().st_size, sha256=sha256_file(path))
    return out


def probe_entries(level: str) -> tuple[dict, list[dict]]:
    """Merge every committed probe doc; prefer an `ok` row for a duplicate pair."""
    merged: dict[tuple[int, int], dict] = {}
    docs = []
    for name in DRAW_PROBE_DOCS:
        path = PIPELINE / name
        if not path.is_file():
            continue
        docs.append({"path": rel(path), "bytes": path.stat().st_size,
                     "sha256": sha256_file(path)})
        doc = load_json(path)
        for entry in doc["levels"]:
            if entry["level"] != level:
                continue
            for probe in entry["probes"]:
                key = (int(probe["geometryBlock"]), int(probe["nodeBlock"]))
                current = merged.get(key)
                if current is None or (current.get("status") != "ok"
                                       and probe.get("status") == "ok"):
                    merged[key] = probe
    rows = [merged[key] for key in sorted(merged)]
    return {"documents": docs}, rows


def parse_unsupported(error: str) -> dict:
    return xs.parse_unsupported(error or "")


# ------------------------------------------------------------------- collision

def collision_stage(level: str, out: Path) -> tuple[dict, list]:
    physics_path = LEVELS_DIR / level / "Level.levelphysics"
    data = physics_path.read_bytes()
    level_doc = physics_scan.scan_level(data)
    triangles = physics_scan.flatten_static_triangles(level_doc)

    geom = xs.collision_geometry(physics_path)
    pos_rec = write_bin(out / "collision.positions.f32.bin", f32_array(geom["positions"]))
    idx_rec = write_bin(out / "collision.indices.u32.bin", u32_array(geom["indices"]))

    shapes = geom["shapes"]
    reasons = {}
    for shape in shapes:
        if not shape["shipped"]:
            reasons[shape["importName"]] = reasons.get(shape["importName"], 0) + 1

    document = {
        "schema": SCHEMA_COLLISION,
        "level": level,
        "kind": "static-collision-triangle-mesh",
        "file": "Level.levelphysics",
        "source": {"path": rel(physics_path), "bytes": len(data),
                   "sha256": sha256_bytes(data)},
        "fileVersion": geom["fileVersion"],
        "streamVersion": geom["streamVersion"],
        "shapeStreamEnd": geom["shapeStreamEnd"],
        "routeCount": geom["routeCount"],
        "routesParsed": geom["routesParsed"],
        "counts": {
            "triangles": geom["triangles"],
            "vertices": geom["vertices"],
            "triangleSoupVertices": geom["triangleSoupVertices"],
            "surfaceTriangles": geom["surfaceTriangles"],
            "steepTriangles": geom["steepTriangles"],
            "otherTriangles": geom["otherTriangles"],
            "degenerateTriangles": geom["degenerateTriangles"],
            "shapeCount": len(shapes),
            "shippedShapeCount": sum(1 for s in shapes if s["shipped"]),
            "excludedShapeCount": sum(1 for s in shapes if not s["shipped"]),
        },
        "bounds": geom["bounds"],
        "buffers": {
            "positions": {**pos_rec, "components": 3, "role": "collision vertex table"},
            "indices": {**idx_rec, "components": 3,
                        "role": "triangle list, 3 indices per triangle"},
        },
        "shapes": shapes,
        "excludedByType": reasons,
        "surfaceRule": "geometric normal.y > 0.94; steep = |normal.y| < 0.5",
        "readers": {"scanner": geom["scanner"], "oracle": geom["oracle"]},
        "limits": [
            "static triangle meshes only; simple shapes, composite sub-meshes and "
            "instance geometry are not part of this buffer",
            "fluid meshes are parsed but excluded from the drivable triangle surface",
        ],
    }
    return document, triangles


# ----------------------------------------------------------------------- draws

def draws_stage(level: str, out: Path, probes: list[dict]) -> dict:
    supported = sorted([p for p in probes if p.get("status") == "ok"],
                       key=lambda p: (p["geometryBlock"], p["nodeBlock"]))
    unsupported = sorted([p for p in probes if p.get("status") != "ok"],
                         key=lambda p: (p["geometryBlock"], p["nodeBlock"]))

    pos_chunks, uv_chunks, lightmap_uv_chunks, idx_chunks = [], [], [], []
    sections, draws = [], []
    vertex_offset = index_offset = 0
    instance_descriptions = 0
    instance_sections = 0
    placeholder_vertices = 0

    for probe in supported:
        stage = ROOT / probe["stage"]
        native_path = stage / "native.json"
        native = load_json(native_path)
        meta = native["metadata"]
        vertex_count = int(meta["vertexCount"])
        triangle_count = int(meta["triangleCount"])
        draw_count = int(meta["primitiveCount"])
        if len(native["positions"]) != vertex_count * 3:
            raise ValueError("position count mismatch at " + str(native_path))
        if len(native["uv0"]) != vertex_count * 2:
            raise ValueError("UV0 count mismatch at " + str(native_path))
        if len(native["indices"]) != triangle_count * 3:
            raise ValueError("index count mismatch at " + str(native_path))
        if len(native["draws"]) != draw_count:
            raise ValueError("draw count mismatch at " + str(native_path))
        if native["indices"] and max(native["indices"]) >= vertex_count:
            raise ValueError("index out of range at " + str(native_path))
        if sum(int(d["indexCount"]) for d in native["draws"]) != len(native["indices"]):
            raise ValueError("draw ranges do not cover the index buffer at " + str(native_path))

        section_id = "g%d-n%d" % (probe["geometryBlock"], probe["nodeBlock"])
        pos = f32_array(native["positions"])
        uv = f32_array(native["uv0"])
        # F16_4 UV0 carries the retail lightmap UV in .zw. The reader exports it
        # as a parallel pair stream; a 2-component UV0 has no lightmap UV and
        # contributes explicit zeros (recorded, never a guess).
        lightmap_uv = native.get("lightmapUv") or []
        if lightmap_uv:
            if len(lightmap_uv) != vertex_count * 2:
                raise ValueError("lightmap UV count mismatch at " + str(native_path))
            lm = f32_array(lightmap_uv)
        else:
            lm = f32_array([0.0] * (vertex_count * 2))
        idx = np.asarray(native["indices"], dtype=np.int64) + vertex_offset
        pos_chunks.append(pos)
        uv_chunks.append(uv)
        lightmap_uv_chunks.append(lm)
        idx_chunks.append(idx)

        skipped = int(meta.get("instanceDescriptionsSkipped", 0) or 0) + \
            int(meta.get("instanceBatchDescriptionsSkipped", 0) or 0)
        if skipped:
            instance_sections += 1
        instance_descriptions += skipped
        placeholder_vertices += int(meta.get("placeholderUvVertices", 0) or 0)

        draw_offset = len(draws)
        local_first = 0
        for ordinal, draw in enumerate(native["draws"]):
            first = index_offset + int(draw["firstIndex"])
            count = int(draw["indexCount"])
            draws.append({
                "id": "%s#%d" % (section_id, ordinal),
                "sectionId": section_id,
                "sectionDrawIndex": ordinal,
                "firstIndex": first,
                "indexCount": count,
                "triangleCount": count // 3,
                "uv0Available": bool(draw.get("uv0Available")),
                "binding": draw.get("binding"),
                "albedoTexture": draw.get("albedoTexture"),
                "albedoParameter": draw.get("albedoParameter"),
                "status": None,
                "textureId": None,
                "textureSlot": None,
                "uvHash": None,
                "effect": None,
                "material": None,
                "materialRow": None,
                "blocker": None,
            })
            local_first += count
        if local_first != len(native["indices"]):
            raise ValueError("draw range sum mismatch at " + str(native_path))

        sections.append({
            "id": section_id,
            "geometryBlock": int(probe["geometryBlock"]),
            "nodeBlock": int(probe["nodeBlock"]),
            "geometryChunkIndex": probe.get("geometryChunkIndex"),
            "nodeChunkIndex": probe.get("nodeChunkIndex"),
            "stage": rel(stage),
            "status": "supported",
            "vertexOffset": vertex_offset,
            "vertexCount": vertex_count,
            "indexOffset": index_offset,
            "indexCount": len(native["indices"]),
            "triangleCount": triangle_count,
            "drawOffset": draw_offset,
            "drawCount": draw_count,
            "bounds": native["bounds"],
            "positionsFloat32LESha256": probe["positionsFloat32LESha256"],
            "indicesUint32LESha256": probe["indicesUint32LESha256"],
            "geometryChunk": {"bytes": probe["geometryChunkBytes"],
                              "sha256": probe["geometryChunkSha256"]},
            "nodeChunk": {"bytes": probe["nodeChunkBytes"],
                          "sha256": probe["nodeChunkSha256"]},
            "instancesApplied": bool(meta.get("instancesApplied", False)),
            "instanceDescriptionsSkipped": skipped,
            "instanceBasePrimitivesSkipped": int(
                meta.get("instanceBasePrimitivesSkipped", 0) or 0),
            "nodeTransformsApplied": bool(meta.get("nodeTransformsApplied", False)),
            "coordinateSpace": meta.get("coordinateSpace"),
            "scope": meta.get("scope"),
            "uv0PlaceholderVertices": int(meta.get("placeholderUvVertices", 0) or 0),
        })
        vertex_offset += vertex_count
        index_offset += len(native["indices"])

    positions = np.concatenate(pos_chunks) if pos_chunks else np.zeros(0, dtype="<f4")
    uv0 = np.concatenate(uv_chunks) if uv_chunks else np.zeros(0, dtype="<f4")
    lightmap_uv = (np.concatenate(lightmap_uv_chunks) if lightmap_uv_chunks
                   else np.zeros(0, dtype="<f4"))
    indices = np.concatenate(idx_chunks) if idx_chunks else np.zeros(0, dtype="<i8")
    positions = f32_array(positions)
    uv0 = f32_array(uv0)
    lightmap_uv = f32_array(lightmap_uv)
    indices = u32_array(indices)

    pos_rec = write_bin(out / "draws.positions.f32.bin", positions)
    uv_rec = write_bin(out / "draws.uv0.f32.bin", uv0)
    lightmap_uv_rec = write_bin(out / "draws.lightmapUv.f32.bin", lightmap_uv)
    idx_rec = write_bin(out / "draws.indices.u32.bin", indices)

    unsupported_records = []
    for probe in unsupported:
        parsed = parse_unsupported(probe.get("error") or "")
        unsupported_records.append({
            "id": "g%d-n%d" % (probe["geometryBlock"], probe["nodeBlock"]),
            "geometryBlock": int(probe["geometryBlock"]),
            "nodeBlock": int(probe["nodeBlock"]),
            "geometryChunkIndex": probe.get("geometryChunkIndex"),
            "nodeChunkIndex": probe.get("nodeChunkIndex"),
            "status": "unsupported",
            "reason": parsed["reason"],
            "byteOffset": parsed["byteOffset"],
            "error": probe.get("error"),
            "geometryChunk": probe.get("geometryChunkSha256"),
            "nodeChunk": probe.get("nodeChunkSha256"),
        })

    return {
        "positions": positions,
        "uv0": uv0,
        "lightmapUv": lightmap_uv,
        "indices": indices,
        "sections": sections,
        "draws": draws,
        "unsupportedSections": unsupported_records,
        "buffers": {"positions": pos_rec, "uv0": uv_rec,
                    "lightmapUv": lightmap_uv_rec, "indices": idx_rec},
        "counts": {
            "sectionsProbed": len(probes),
            "sectionsSupported": len(supported),
            "sectionsUnsupported": len(unsupported),
            "vertexCount": int(positions.size // 3),
            "indexCount": int(indices.size),
            "triangleCount": int(indices.size // 3),
            "drawCount": len(draws),
            "uv0PlaceholderVertices": placeholder_vertices,
            "instanceSectionsSkipped": instance_sections,
            "instanceDescriptionsSkipped": instance_descriptions,
        },
    }


# -------------------------------------------------------------------- textures

def _texture_limits() -> list[str]:
    return [
        "static g_tAlbedo/g_MeshTexture identity and original UV0 only",
        "material colour, blend, alpha test, shader stages, sampler wrap/filter, "
        "mips and sRGB are not applied",
        "the committed decoder is bounded to 2D <= %d px; larger sources are not "
        "resampled or replaced" % TEXTURE_LIMIT_PX,
        "first-RenderList direct LOD0 primitives only; instances are not applied",
        "no fallback texture or fallback colour is invented",
    ]


def textures_stage(level: str, out: Path, draw_doc: dict, temp: Path) -> dict:
    """Resolve static albedo identity with the committed MAP3 resolver and decode
    every in-bound source with the committed texture decoder.

    The resolver/decode/classify primitives are imported from
    `amboy_texture_bindings.py`; only the per-level driver loop is here.
    """
    level_dir = LEVELS_DIR / level
    tb.LEVEL = level
    tb.PREFIX = msc.short_name(level)
    tb.LEVEL_DIR = level_dir
    tb.STAGES = PIPELINE / "probes"
    tb.SCHEMA = "blur.map-batch.textures/1"

    levelrender = (level_dir / "level.levelrender").read_bytes()
    stream_path = level_dir / "level.levelstream"
    layout = tb.render_layout(levelrender, "level")
    scene = layout["scene"]
    records = scene["stream"]["chunks"]
    archive = tb.TextureArchive(records, stream_path)

    texture_cache: dict[tuple[int, int], dict | None] = {}
    rgba_by_id: dict[str, bytes] = {}
    section_errors = []
    status_counts: dict[str, int] = {}
    status_triangles: dict[str, int] = {}
    bindable_ids: set[str] = set()
    status_by_draw: dict[str, dict] = {}

    temp.mkdir(parents=True, exist_ok=True)

    sections = draw_doc["sections"]
    draws = draw_doc["draws"]
    for section in sections:
        stage = ROOT / section["stage"]
        section_id = section["id"]
        try:
            record = records[int(section["nodeChunkIndex"])]
            if not record["items"] or record["items"][0] != {"block": section["nodeBlock"],
                                                             "lod": 0}:
                raise ValueError("node chunk record mismatch")
            node_raw = (stage / "node.chunk").read_bytes()
            tb.stream_prefix(node_raw, record)
            resources = tb.resource_prefix(
                node_raw, {"resourcePayloadOffset": 24, "scenePayloadOffset": 0},
                streamed=True)
            lists = tb.read_lists(node_raw, resources)
            if not lists:
                raise ValueError("node chunk has no RenderList")
            render_list = lists[0]
            resolver = tb.Resolver(render_list, scene["effects"])

            geometry_data = (stage / "geometry.chunk").read_bytes()
            stream_prefix_record = records[int(section["geometryChunkIndex"])]
            tb.stream_prefix(geometry_data, stream_prefix_record)
            geometry_resources = tb.resource_prefix(
                geometry_data, {"resourcePayloadOffset": 24, "scenePayloadOffset": 0},
                streamed=True)

            native = load_json(stage / "native.json")
            expected = tb.emitted_direct_draws(render_list, scene,
                                               section["geometryBlock"])
            section_draws = draws[section["drawOffset"]:
                                  section["drawOffset"] + section["drawCount"]]
            if len(expected) != len(native["draws"]) or len(expected) != len(section_draws):
                raise ValueError("draw count mismatch (%d/%d/%d)"
                                 % (len(expected), len(native["draws"]),
                                    len(section_draws)))

            local_first = 0
            for draw_index, (emit, native_draw, row) in enumerate(
                    zip(expected, native["draws"], section_draws)):
                triangles = tb.triangle_count(geometry_data, geometry_resources, emit)
                if triangles * 3 != int(native_draw["indexCount"]):
                    raise ValueError("draw triangle count mismatch at #%d" % draw_index)
                if int(native_draw["firstIndex"]) != local_first:
                    raise ValueError("draw range is not contiguous at #%d" % draw_index)
                local_first += int(native_draw["indexCount"])

                primitive = render_list["primitives"][emit["primitiveIndex"]]
                is_vehicle, forced = resolver.vehicle_parameter(primitive)
                material = resolver.resolve(primitive)
                material["forced_reason"] = forced
                parameter = "g_MeshTexture" if is_vehicle else "g_tAlbedo"
                source = None
                texture = None
                if (material["known"] and material["slot"] is not None
                        and not forced and not is_vehicle):
                    slot = material["slot"]
                    if 0 <= slot < len(render_list["sources"]["texture"]):
                        source = dict(render_list["sources"]["texture"][slot])
                        key = (source["block"], source["index"])
                        if key not in texture_cache:
                            record_tex = tb.texture_source_record(
                                source, archive, scene)
                            if record_tex is not None:
                                blob = record_tex.pop("blob")
                                record_tex["blobSha256"] = sha256_bytes(blob)
                                record_tex["blobBytes"] = len(blob)
                                record_tex["format"] = record_tex["descriptor"]["format"]
                                record_tex["formatName"] = tb.FORMAT_NAMES.get(
                                    record_tex.get("format"),
                                    "unsupported/%s" % record_tex.get("format"))
                                if (record_tex["width"] > TEXTURE_LIMIT_PX
                                        or record_tex["height"] > TEXTURE_LIMIT_PX):
                                    record_tex["decoded"] = False
                                    record_tex["decodeBlocker"] = "decoder-size-limit"
                                    record_tex["decodeError"] = (
                                        "committed texture_inspect decodes 2D textures up "
                                        "to %d px; source is %dx%d"
                                        % (TEXTURE_LIMIT_PX, record_tex["width"],
                                           record_tex["height"]))
                                else:
                                    raw_path = temp / (record_tex["id"] + ".raw")
                                    rgba_path = temp / (record_tex["id"] + ".rgba")
                                    try:
                                        decoded = tb.decode_texture(
                                            blob, raw_path, rgba_path)
                                        record_tex.update(decoded)
                                        record_tex["decoded"] = True
                                        rgba_by_id[record_tex["id"]] = \
                                            rgba_path.read_bytes()
                                    except ValueError as error:
                                        record_tex["decoded"] = False
                                        record_tex["decodeBlocker"] = "decoder-rejected"
                                        record_tex["decodeError"] = str(error)
                                    finally:
                                        raw_path.unlink(missing_ok=True)
                                        rgba_path.unlink(missing_ok=True)
                                texture_cache[key] = record_tex
                            else:
                                texture_cache[key] = None
                        texture = texture_cache.get(key)

                uv_hash = tb.uv_range_hash(native, int(native_draw["firstIndex"]),
                                           int(native_draw["indexCount"]))
                aux = None
                if not material["seen"] and material.get("otherTextures"):
                    first = material["otherTextures"][0]
                    if 0 <= first["slot"] < len(render_list["sources"]["texture"]):
                        aux_source = dict(render_list["sources"]["texture"][first["slot"]])
                        aux = {"parameter": first["parameter"], **tb.texture_identity(
                            aux_source, archive, scene)}

                # The retail lightmap is bound through the material's g_tLightmap
                # field. Record the exact texture name per draw so the renderer can
                # bind the decoded texture; a material without the field gets null.
                lightmap_name = None
                lightmap_slot = None
                lightmap = material.get("lightmap")
                if lightmap:
                    slot = lightmap.get("slot")
                    if isinstance(slot, int) and 0 <= slot < len(render_list["sources"]["texture"]):
                        lm_source = dict(render_list["sources"]["texture"][slot])
                        lightmap_name = tb.texture_identity(lm_source, archive,
                                                            scene).get("name")
                        lightmap_slot = slot

                resolved = {
                    "section": section_id,
                    "drawIndex": draw_index,
                    "primitiveIndex": emit["primitiveIndex"],
                    "firstIndex": int(native_draw["firstIndex"]),
                    "indexCount": int(native_draw["indexCount"]),
                    "triangleCount": triangles,
                    "effect": resolver.effect(primitive),
                    "parameter": parameter,
                    "material": material,
                    "textureSource": source,
                    "textureId": texture["id"] if texture else None,
                    "textureName": texture["name"] if texture else None,
                    "textureFormat": texture.get("formatName") if texture else None,
                    "textureRgbaSha256": texture.get("rgbaSha256") if texture else None,
                    "textureRgbaFnv1a64": texture.get("textureRgbaFnv1a64")
                    if texture else None,
                    "auxTexture": aux,
                    "lightmapName": lightmap_name,
                    "lightmapSlot": lightmap_slot,
                    "uv0Available": bool(native_draw.get("uv0Available")),
                    "uvHash": uv_hash,
                }
                status, reason = tb.classify_draw(resolved, texture)
                resolved["status"] = status
                resolved["blocker"] = reason
                resolved["bindable"] = status == "bindable-static-albedo"
                if resolved["bindable"] and texture:
                    bindable_ids.add(texture["id"])

                status_counts[status] = status_counts.get(status, 0) + 1
                status_triangles[status] = status_triangles.get(status, 0) + triangles

                row.update({
                    "status": status,
                    "blocker": reason,
                    "textureId": resolved["textureId"],
                    "textureName": resolved["textureName"],
                    "lightmapName": resolved["lightmapName"],
                    "uvHash": uv_hash,
                    "effect": resolved["effect"],
                    "parameter": parameter,
                    "material": (material or {}).get("material"),
                    "materialRow": (material or {}).get("row"),
                })
                status_by_draw[row["id"]] = row
        except (ValueError, KeyError, IndexError, StopIteration, TypeError) as error:
            section_errors.append({"section": section_id,
                                   "error": "%s: %s" % (type(error).__name__, error)})
            for row in draws[section["drawOffset"]:
                              section["drawOffset"] + section["drawCount"]]:
                row.update({"status": "unresolved",
                            "blocker": "texture-section-resolution-error",
                            "uvHash": None, "effect": None, "material": None,
                            "materialRow": None})
                status_counts["unresolved"] = status_counts.get("unresolved", 0) + 1
                status_triangles["unresolved"] = status_triangles.get(
                    "unresolved", 0) + row["triangleCount"]

    # ---------------------------------------------------------- texture blobs
    textures_dir = out / "textures"
    textures_dir.mkdir(parents=True, exist_ok=True)
    for stale in textures_dir.glob("*.rgba"):
        stale.unlink()

    items = []
    slot_for_id: dict[str, int] = {}
    referenced_mip0 = 0
    unique_mip0 = 0
    merged_groups = []
    for texture_id in sorted(bindable_ids):
        texture = next((t for t in texture_cache.values()
                        if t and t.get("id") == texture_id), None)
        if texture is None or not texture.get("rgbaSha256"):
            raise ValueError("bindable texture without decoded RGBA: " + texture_id)
        referenced_mip0 += int(texture["rgbaBytes"])

    groups: dict[str, list[str]] = {}
    for texture_id in sorted(bindable_ids):
        texture = next((t for t in texture_cache.values()
                        if t and t.get("id") == texture_id), None)
        groups.setdefault(texture["rgbaSha256"], []).append(texture_id)

    for slot, (rgba_sha, ids) in enumerate(sorted(groups.items(),
                                                  key=lambda item: item[1][0])):
        primary = ids[0]
        texture = next(t for t in texture_cache.values()
                       if t and t.get("id") == primary)
        data = rgba_by_id[primary]
        if sha256_bytes(data) != rgba_sha:
            raise ValueError("RGBA hash mismatch for " + primary)
        if len(data) != texture["width"] * texture["height"] * 4:
            raise ValueError("RGBA length is not width*height*4 for " + primary)
        name = "tex-%03d.rgba" % slot
        (textures_dir / name).write_bytes(data)
        for texture_id in ids:
            slot_for_id[texture_id] = slot
        unique_mip0 += len(data)
        item_draws = [row for row in draws
                      if row["status"] == "bindable-static-albedo"
                      and row["textureId"] in ids]
        items.append({
            "slot": slot,
            "file": "textures/" + name,
            "bytes": len(data),
            "sha256": rgba_sha,
            "fnv1a64": "0x%016x" % tb.fnv1a64(data),
            "primaryId": primary,
            "sourceIds": ids,
            "name": texture["name"],
            "kind": texture["kind"],
            "block": texture["block"],
            "index": texture["index"],
            "width": texture["width"],
            "height": texture["height"],
            "levels": texture["levels"],
            "format": texture["format"],
            "formatName": texture["formatName"],
            "sampler": texture.get("sampler"),
            "alpha": texture.get("alpha"),
            "blobSha256": texture.get("blobSha256"),
            "blobBytes": texture.get("blobBytes"),
            "drawCount": len(item_draws),
            "triangleCount": sum(row["triangleCount"] for row in item_draws),
            "bindableDrawCount": len(item_draws),
            "srgbHint": {"colourSpace": "srgb", "applied": False},
            "mipHint": {"sourceLevels": texture["levels"], "decodedLevels": 1,
                        "generateMips": True, "applied": False},
            "upload": {"format": "rgba8unorm", "srgbVariant": "rgba8unorm-srgb",
                       "bytesMip0": len(data)},
        })
        if len(ids) > 1:
            merged_groups.append({"sha256": rgba_sha, "primaryId": primary,
                                  "sourceIds": ids})

    for row in draws:
        if row["status"] == "bindable-static-albedo":
            row["textureSlot"] = slot_for_id.get(row["textureId"])

    bindable_draws = sum(1 for row in draws
                         if row["status"] == "bindable-static-albedo")
    blocked_draws = len(draws) - bindable_draws
    decoded_sources = sum(1 for t in texture_cache.values() if t and t.get("decoded"))
    decoded_bytes = sum(int(t["rgbaBytes"]) for t in texture_cache.values()
                        if t and t.get("decoded"))

    index = {
        "schema": SCHEMA_TEXTURES,
        "level": level,
        "prefix": tb.PREFIX,
        "scope": {
            "dataOnly": True,
            "rendererChanged": False,
            "gpuUploaded": False,
            "texturesBoundInRenderer": False,
            "instancesApplied": False,
            "materialsBeyondStaticAlbedoApplied": False,
            "alphaRuleApplied": False,
            "samplerApplied": False,
        },
        "inputs": {
            "levelrender": {"path": rel(level_dir / "level.levelrender"),
                            "bytes": len(levelrender),
                            "sha256": sha256_bytes(levelrender)},
            "levelstream": {"path": rel(stream_path),
                            "bytes": stream_path.stat().st_size,
                            "sha256": sha256_file(stream_path)},
            "decoder": {"path": rel(ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe"),
                        "sha256": sha256_file(ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe")},
            "resolver": {"path": rel(ROOT / "probes/map-slice/tools/amboy_texture_bindings.py"),
                         "sha256": sha256_file(ROOT / "probes/map-slice/tools/amboy_texture_bindings.py")},
        },
        "materialResolution": {
            "reader": "source-shaped replica of scene_reader.cpp bind_albedo(): "
                      "instance -> base -> every active stream material, nested "
                      "type-8 rows followed, last g_tAlbedo wins",
            "albedoParameters": ["g_tAlbedo", "g_MeshTexture"],
        },
        "counts": {
            "sections": len(sections),
            "draws": len(draws),
            "triangles": int(draw_doc["counts"]["triangleCount"]),
            "bindableDraws": bindable_draws,
            "blockedDraws": blocked_draws,
            "distinctTextureSources": len(bindable_ids),
            "decodedSources": decoded_sources,
            "decodedSourceBytes": decoded_bytes,
            "uniqueBlobs": len(items),
            "mergedSources": len(bindable_ids) - len(items),
            "referencedMip0Bytes": referenced_mip0,
            "uniqueMip0Bytes": unique_mip0,
            "savedByMergeBytes": referenced_mip0 - unique_mip0,
            "statuses": dict(sorted(status_counts.items())),
            "statusTriangles": dict(sorted(status_triangles.items())),
        },
        "mergedGroups": merged_groups,
        "items": items,
        "sectionErrors": section_errors,
        "limits": _texture_limits(),
    }
    write_json(textures_dir / "index.json", index)
    shutil.rmtree(temp, ignore_errors=True)
    return index


# ------------------------------------------------------------------------ path

def _resample(points: list[dict], step: float = SAMPLE_STEP_M) -> list[dict]:
    out: list[dict] = []
    for a, b in zip(points, points[1:]):
        length = math.hypot(b["x"] - a["x"], b["z"] - a["z"])
        n = max(1, int(math.ceil(length / step)))
        for k in range(n):
            t = k / n
            out.append({"x": round(a["x"] + (b["x"] - a["x"]) * t, 4),
                        "z": round(a["z"] + (b["z"] - a["z"]) * t, 4),
                        "h": round(a["h"] + (b["h"] - a["h"]) * t, 4)})
    out.append(dict(points[-1]))
    return out


def _polyline_length(points: list[dict]) -> float:
    return sum(math.hypot(b["x"] - a["x"], b["z"] - a["z"])
               for a, b in zip(points, points[1:]))


def path_stage(level: str, out: Path) -> dict:
    covered_summary_path = PIPELINE / "covered" / (level + ".json")
    covered_path_path = PIPELINE / "covered" / (level + "-path.json")
    collision_path_path = PIPELINE / "paths" / (level + ".json")
    maps_path = PIPELINE / "maps.json"

    covered_summary = load_json(covered_summary_path) if covered_summary_path.is_file() else {}
    maps_doc = load_json(maps_path) if maps_path.is_file() else {"levels": []}
    maps_row = next((row for row in maps_doc.get("levels", [])
                     if row.get("name") == level), {})
    collision_only = (maps_row.get("drivable") or {}).get("path") or {}
    collision_len = float(collision_only.get("lengthM") or 0.0)

    kind = "draw-covered-measured"
    source = None
    samples = []
    if covered_path_path.is_file():
        covered_doc = load_json(covered_path_path)
        raw = covered_doc.get("samples") or []
        if len(raw) >= 2:
            samples = _resample(raw)
            source = file_record(covered_path_path)

    draw_available = bool(samples)
    if not draw_available:
        kind = "collision-only-measured"
        if collision_path_path.is_file():
            collision_doc = load_json(collision_path_path)
            raw = collision_doc.get("samples") or []
            if len(raw) >= 2:
                samples = _resample(raw)
                source = file_record(collision_path_path)

    if len(samples) < 2:
        raise ValueError("no measured path with at least two samples")

    length = _polyline_length(samples)
    steps = [math.hypot(b["x"] - a["x"], b["z"] - a["z"])
             for a, b in zip(samples, samples[1:])]
    heights = [p["h"] for p in samples]
    max_step = max(steps) if steps else 0.0
    max_gap = max((abs(b - a) for a, b in zip(heights, heights[1:])), default=0.0)

    draw_len = length if draw_available else 0.0
    coverage_ratio = (draw_len / collision_len) if collision_len else 0.0

    binary = f32_array([[p["x"], p["z"], p["h"]] for p in samples])
    bin_rec = write_bin(out / "path.points.f32.bin", binary)

    document = {
        "schema": SCHEMA_PATH,
        "level": level,
        "kind": kind,
        "units": {"x": "metres", "z": "metres", "h": "metres", "arc": "metres"},
        "lengthM": round(length, 9),
        "sampleCount": len(samples),
        "sampleStepM": SAMPLE_STEP_M,
        "direction": "spawn -> finish (point-to-point; no lap is claimed)",
        "pointsFile": "path.points.f32.bin",
        "pointsFormat": "float32le x,z,h; 12 bytes per point",
        "pointsSha256": bin_rec["sha256"],
        "pointsBytes": bin_rec["bytes"],
        "start": {"x": samples[0]["x"], "z": samples[0]["z"], "h": samples[0]["h"]},
        "end": {"x": samples[-1]["x"], "z": samples[-1]["z"], "h": samples[-1]["h"]},
        "continuity": {
            "maxStepM": round(max_step, 9),
            "stepLimitM": PATH_MAX_STEP_M,
            "maxStepWithinLimit": max_step <= PATH_MAX_STEP_M,
            "maxHeightDeltaM": round(max_gap, 9),
            "monotonicArc": all(step > 0 for step in steps),
        },
        "drawCovered": {
            "available": draw_available,
            "lengthM": round(draw_len, 9),
            "sampleCount": len(samples) if draw_available else 0,
            "source": source,
            "coverageOfCollisionDiameter": round(coverage_ratio, 6),
            "coveredPassableCells": covered_summary.get("coveredPassableCells"),
            "passableCells": covered_summary.get("passableCells"),
            "coverageOfPassable": covered_summary.get("coverageOfPassable"),
            "coveredComponents": covered_summary.get("componentCount"),
            "blocker": None if draw_available else "no draw-covered collision cell",
        },
        "collisionOnly": {
            "lengthM": round(collision_len, 9),
            "sampleCount": collision_only.get("samples"),
            "start": collision_only.get("start"),
            "end": collision_only.get("end"),
            "maxStepM": collision_only.get("maxStepM"),
            "max2mGrade": collision_only.get("max2mGrade"),
            "component": (maps_row.get("drivable") or {}).get("measuredComponent"),
            "source": file_record(maps_path) if maps_path.is_file() else None,
            "pathArtifact": file_record(collision_path_path)
            if collision_path_path.is_file() else None,
        },
        "checkpoints": [
            {"index": index, **_station(samples, _cumulative(samples),
                                        length * index / 3.0)}
            for index in (1, 2)
        ],
        "sources": {
            "coveredSummary": file_record(covered_summary_path)
            if covered_summary_path.is_file() else None,
            "coveredPath": file_record(covered_path_path)
            if covered_path_path.is_file() else None,
            "collisionPath": file_record(collision_path_path)
            if collision_path_path.is_file() else None,
            "mapPipelineMaps": file_record(maps_path) if maps_path.is_file() else None,
            "grid": (file_record(PIPELINE / "grids" / (level + ".npz"))
                     if (PIPELINE / "grids" / (level + ".npz")).is_file() else None),
        },
        "samples": [{"x": p["x"], "z": p["z"], "h": p["h"]} for p in samples],
    }
    return document


# ----------------------------------------------------------------------- spawn

def _cumulative(points: list[dict]) -> list[float]:
    out = [0.0]
    for a, b in zip(points, points[1:]):
        out.append(out[-1] + math.hypot(b["x"] - a["x"], b["z"] - a["z"]))
    return out


def _point_at_arc(samples: list[dict], arc: float) -> dict:
    acc = 0.0
    for a, b in zip(samples, samples[1:]):
        d = math.hypot(b["x"] - a["x"], b["z"] - a["z"])
        if acc + d >= arc:
            t = (arc - acc) / d if d else 0.0
            return {"x": round(a["x"] + (b["x"] - a["x"]) * t, 4),
                    "z": round(a["z"] + (b["z"] - a["z"]) * t, 4),
                    "h": round(a["h"] + (b["h"] - a["h"]) * t, 4)}
        acc += d
    return dict(samples[-1])


def _station(samples: list[dict], cumulative: list[float], arc: float) -> dict:
    """Candidate checkpoint -> nearest dense path point (slice semantics)."""
    target = _point_at_arc(samples, arc)
    best = min(range(len(samples)),
               key=lambda i: (samples[i]["x"] - target["x"]) ** 2 +
                             (samples[i]["z"] - target["z"]) ** 2)
    delta = math.hypot(samples[best]["x"] - target["x"],
                       samples[best]["z"] - target["z"])
    return {"requestedArcM": round(arc, 6),
            "requestedX": target["x"], "requestedZ": target["z"],
            "arcM": round(cumulative[best], 6),
            "pointIndex": best,
            "nearestPointDeltaM": round(delta, 6),
            "x": samples[best]["x"], "z": samples[best]["z"],
            "ground": samples[best]["h"]}


def spawn_stage(level: str, out: Path, path_doc: dict, triangles: list) -> dict:
    samples = path_doc["samples"]
    spawn = dict(samples[0])
    spawn["ground"] = spawn["h"]
    tangent_index = min(8, len(samples) - 1)
    heading = math.atan2(samples[tangent_index]["x"] - samples[0]["x"],
                         samples[tangent_index]["z"] - samples[0]["z"])
    spawn["heading"] = heading

    checks = []
    proof = None
    ray_target = "up-facing-drivable-surface"
    try:
        records = xs.build_ray_triangles(triangles)
        up_records = [r for r in records if r["normal"][1] > 0.94]
        try:
            proof = xs.spawn_proof(up_records, spawn, level)
        except SystemExit:
            ray_target = "highest-any-surface-fallback"
            proof = xs.spawn_proof(records, spawn, level)
        ray_hit = bool(proof["center"].get("hit"))
        ground_delta = float(proof["deltaToLayoutGroundM"])
        up_facing = bool(proof["center"].get("upFacing"))
        all_up = bool(proof["allUpFacing"])
        all_hits = bool(proof["allHits"])
    except (SystemExit, ValueError, KeyError) as error:
        ray_hit = up_facing = all_up = all_hits = False
        ground_delta = None
        proof = {"status": "error", "error": str(error)[:300]}

    grid_path = PIPELINE / "grids" / (level + ".npz")
    audit_passable = False
    audit_ground = None
    if grid_path.is_file():
        grid = np.load(grid_path)
        xs_grid, zs_grid = grid["xs"], grid["zs"]
        ix = int(np.abs(xs_grid - spawn["x"]).argmin())
        iz = int(np.abs(zs_grid - spawn["z"]).argmin())
        audit_passable = bool(grid["passable"][iz, ix])
        audit_ground = float(grid["height"][iz, ix])
        if not math.isfinite(audit_ground):
            audit_ground = None

    checks.append({"name": "finite", "pass": all(
        math.isfinite(v) for v in (spawn["x"], spawn["z"], spawn["h"], heading))})
    checks.append({"name": "ray-hit", "pass": ray_hit})
    checks.append({"name": "up-facing", "pass": up_facing})
    checks.append({"name": "spawn-band-25-hits", "pass": all_hits})
    checks.append({"name": "spawn-band-all-up", "pass": all_up})
    checks.append({"name": "audit-cell-passable", "pass": audit_passable})
    checks.append({"name": "layout-ground-within-0.5m",
                   "pass": ground_delta is not None and abs(ground_delta) <= 0.5,
                   "detail": ground_delta})

    length = float(path_doc["lengthM"])
    checkpoints = []
    for entry in path_doc["checkpoints"]:
        checkpoints.append({
            "index": entry["index"],
            "arcM": entry["arcM"],
            "distanceM": entry["arcM"],
            "requestedArcM": entry["requestedArcM"],
            "pointIndex": entry["pointIndex"],
            "nearestPointDeltaM": entry["nearestPointDeltaM"],
            "x": entry["x"], "z": entry["z"], "ground": entry["ground"],
        })
    finish = {"arcM": round(length, 6), "distanceM": round(length, 6),
              "pointIndex": len(samples) - 1,
              "x": samples[-1]["x"], "z": samples[-1]["z"],
              "ground": samples[-1]["h"]}

    document = {
        "schema": SCHEMA_SPAWN,
        "level": level,
        "kind": path_doc["kind"],
        "spawn": {
            "x": spawn["x"], "z": spawn["z"], "ground": spawn["h"],
            "headingRad": round(heading, 9),
            "headingSource": "first 2 m tangent of the measured path (index 8 of the "
                             "0.25 m resample)",
            "source": "derived from the measured path, not a retail start line",
            "stationM": 0.0,
        },
        "layout": {
            "mode": "point-to-point",
            "direction": "spawn -> checkpoint 1 -> checkpoint 2 -> finish",
            "lengthM": round(length, 6),
            "sampleCount": len(samples),
            "sampleStepM": SAMPLE_STEP_M,
            "pointsFile": "path.points.f32.bin",
            "pointsSha256": path_doc["pointsSha256"],
            "spawn": {"x": spawn["x"], "z": spawn["z"],
                      "ground": spawn["h"], "heading": round(heading, 9)},
            "checkpoints": checkpoints,
            "finish": finish,
            "lap": None,
            "lapReason": "the measured path is an open point-to-point line; no closed "
                         "circuit or lap is claimed",
        },
        "validity": {
            "onCollisionSurface": bool(ray_hit and up_facing),
            "rayTarget": ray_target,
            "rayHit": ray_hit,
            "upFacing": up_facing,
            "rayGroundY": (proof.get("groundY") if isinstance(proof, dict) else None),
            "layoutGroundY": spawn["h"],
            "groundDeltaM": ground_delta,
            "auditCellPassable": audit_passable,
            "auditGroundY": audit_ground,
            "bandAllHits": all_hits,
            "bandAllUpFacing": all_up,
            "bandHeightSpreadM": (proof.get("heightSpreadM")
                                  if isinstance(proof, dict) else None),
            "checks": checks,
            "pass": all(check["pass"] for check in checks),
        },
        "proof": proof,
        "limits": [
            "spawn and course are derived from the measured path, not a retail start line",
            "the 25-ray 1 m x 5 m band is a spawn-surface check, not a measured road width",
            "no lap, respawn, race-director or pickup placement is claimed",
        ],
    }
    return document


# -------------------------------------------------------------------- blockers

def blockers_stage(level: str, collision: dict, draw_doc: dict,
                   textures: dict | None, path_doc: dict) -> dict:
    blockers = []

    unsupported = draw_doc["unsupportedSections"]
    if unsupported:
        blockers.append({
            "code": "unsupported-draw-section",
            "severity": "geometry",
            "count": len(unsupported),
            "detail": "first-RenderList direct sections the committed native reader "
                      "stops on; each carries its byte offset and reason",
            "items": [{k: s[k] for k in ("id", "geometryBlock", "nodeBlock",
                                         "reason", "byteOffset")} for s in unsupported],
            "fatalForPlayable": False,
            "resolvedBy": "a position-format decoder for the named section types",
        })

    counts = draw_doc["counts"]
    if counts["instanceDescriptionsSkipped"]:
        blockers.append({
            "code": "instance-geometry-skipped",
            "severity": "geometry",
            "count": counts["instanceDescriptionsSkipped"],
            "sections": counts["instanceSectionsSkipped"],
            "detail": "instancesApplied:false; instance-only geometry can add surfaces",
            "fatalForPlayable": False,
            "resolvedBy": "instance traversal across the referenced geometry blocks",
        })

    excluded = collision["excludedByType"]
    if excluded:
        blockers.append({
            "code": "collision-shape-excluded",
            "severity": "physics",
            "count": sum(excluded.values()),
            "byType": excluded,
            "detail": "simple, composite-sub and instance collision shapes are not in "
                      "the triangle package; the engine still loads the full physics file",
            "fatalForPlayable": False,
            "resolvedBy": "engine-side physics import (already used by e1-drive)",
        })

    if textures is not None:
        statuses = textures["counts"]["statuses"]
        for status, count in sorted(statuses.items()):
            if status == "bindable-static-albedo" or count == 0:
                continue
            blockers.append({
                "code": "texture-draw-" + status.replace("blocked-", ""),
                "severity": "texture",
                "count": count,
                "triangles": textures["counts"]["statusTriangles"].get(status, 0),
                "detail": "draws carry no bound static albedo for this level",
                "fatalForPlayable": False,
                "resolvedBy": "decoder/alpha/effect/shader support for this class",
            })
        if textures["sectionErrors"]:
            blockers.append({
                "code": "texture-section-resolution-error",
                "severity": "texture",
                "count": len(textures["sectionErrors"]),
                "items": textures["sectionErrors"],
                "detail": "the committed resolver could not classify every draw in "
                          "these sections",
                "fatalForPlayable": False,
                "resolvedBy": "a fix in the source-shaped material resolver",
            })
    else:
        blockers.append({
            "code": "texture-stage-not-run",
            "severity": "texture",
            "count": path_doc["sampleCount"],
            "detail": "the texture stage did not produce an index for this level",
            "fatalForPlayable": True,
            "resolvedBy": "re-run the batch with the texture stage enabled",
        })

    draw_len = float(path_doc["drawCovered"]["lengthM"])
    coverage = float(path_doc["drawCovered"]["coverageOfCollisionDiameter"])
    if draw_len < MIN_COVERED_PATH_M:
        blockers.append({
            "code": "draw-coverage-blocked",
            "severity": "coverage",
            "count": 1,
            "drawCoveredPathM": draw_len,
            "thresholdM": MIN_COVERED_PATH_M,
            "detail": "the largest draw-covered collision component is shorter than "
                      "the %d m audit floor" % MIN_COVERED_PATH_M,
            "fatalForPlayable": True,
            "resolvedBy": "instance traversal or a different draw block that covers "
                          "the drivable surface",
        })
    elif coverage < 0.9:
        blockers.append({
            "code": "draw-coverage-partial",
            "severity": "coverage",
            "count": 1,
            "drawCoveredPathM": draw_len,
            "coverageOfCollisionDiameter": coverage,
            "detail": "the direct-draw route covers less than 90 %% of the collision "
                      "diameter",
            "fatalForPlayable": False,
            "resolvedBy": "instance traversal or additional draw blocks",
        })

    if not path_doc["drawCovered"]["available"]:
        blockers.append({
            "code": "no-draw-covered-path",
            "severity": "coverage",
            "count": 1,
            "detail": "no draw-covered passable cell exists under the extracted draws",
            "fatalForPlayable": True,
            "resolvedBy": "instance traversal or another draw pass",
        })

    blockers.append({
        "code": "spawn-derived-not-retail",
        "severity": "layout",
        "count": 1,
        "detail": "the spawn is the first measured path point; the level files expose "
                  "no retail start-line record",
        "fatalForPlayable": False,
        "resolvedBy": "a source start-line record",
    })
    blockers.append({
        "code": "point-to-point-no-lap",
        "severity": "layout",
        "count": 1,
        "detail": "the measured line is open; no lap, respawn or race-director rule "
                  "is part of this package",
        "fatalForPlayable": False,
        "resolvedBy": "a measured closed circuit and a lap rule",
    })
    blockers.append({
        "code": "materials-not-applied",
        "severity": "material",
        "count": 1,
        "detail": "static albedo identity + original UV0 only; colour, blend, alpha "
                  "test, shader stages, sampler, mips and sRGB are not applied",
        "fatalForPlayable": False,
        "resolvedBy": "a GPU material/shader pass",
    })
    blockers.append({
        "code": "normals-not-exported",
        "severity": "geometry",
        "count": 1,
        "detail": "the committed direct-draw reader emits no normal stream",
        "fatalForPlayable": False,
        "resolvedBy": "a reader change or the documented derivative-normal fallback",
    })

    grade = grade_for(level, path_doc)
    return {
        "schema": SCHEMA_BLOCKERS,
        "level": level,
        "grade": grade,
        "blockerCount": len(blockers),
        "fatalCount": sum(1 for b in blockers if b["fatalForPlayable"]),
        "bySeverity": _count_by(blockers, "severity"),
        "blockers": blockers,
        "gradeRule": {
            "blocked": "draw-covered path < %.0f m" % MIN_COVERED_PATH_M,
            "playable": "level is integrated in probes/e1-drive/web/map-registry.js "
                        "and the package is valid",
            "partial": "measured draw-covered path >= %.0f m but not integrated"
                       % MIN_COVERED_PATH_M,
        },
    }


def _count_by(rows: list[dict], key: str) -> dict:
    out: dict[str, int] = {}
    for row in rows:
        out[row[key]] = out.get(row[key], 0) + 1
    return dict(sorted(out.items()))


def _blocked_groups(draws: list[dict]) -> dict:
    """Blocked draws grouped by status with their global index ranges.

    Mirrors what the e1 diagnostics consumer needs, so a consumer does not have
    to re-scan every draw to build the additive/diagnostic lists.
    """
    groups: dict[str, dict] = {}
    for draw in draws:
        if draw["status"] == "bindable-static-albedo":
            continue
        group = groups.setdefault(draw["status"], {
            "status": draw["status"], "draws": 0, "triangles": 0,
            "indexRanges": [], "blockers": []})
        group["draws"] += 1
        group["triangles"] += draw["triangleCount"]
        group["indexRanges"].append({"drawId": draw["id"],
                                     "firstIndex": draw["firstIndex"],
                                     "indexCount": draw["indexCount"]})
        if draw.get("blocker") and draw["blocker"] not in group["blockers"]:
            group["blockers"].append(draw["blocker"])
    return dict(sorted(groups.items()))


def grade_for(level: str, path_doc: dict) -> str:
    # An integrated map is playable even when its draw-covered path is short:
    # the committed collision path is the course authority (Highrise's draw
    # path is 6.2 m, its collision course is 14.3 m and it runs in the page).
    if level in INTEGRATED:
        return "playable"
    if float(path_doc["drawCovered"]["lengthM"]) < MIN_COVERED_PATH_M:
        return "blocked"
    return "partial"


# --------------------------------------------------------------------- assembly

def build_level(level: str, out: Path, *, textures: bool = True,
                log=print) -> dict:
    started = time.perf_counter()
    timings: dict[str, float] = {}
    out.mkdir(parents=True, exist_ok=True)

    log("[%s] sources" % level)
    stage_start = time.perf_counter()
    files = level_files(level)
    probe_sources, probes = probe_entries(level)
    timings["sources"] = time.perf_counter() - stage_start

    log("[%s] collision (%d probes)" % (level, len(probes)))
    stage_start = time.perf_counter()
    collision, triangles = collision_stage(level, out)
    timings["collision"] = time.perf_counter() - stage_start

    log("[%s] draws" % level)
    stage_start = time.perf_counter()
    draw_doc = draws_stage(level, out, probes)
    timings["draws"] = time.perf_counter() - stage_start

    log("[%s] textures" % level)
    stage_start = time.perf_counter()
    try:
        texture_doc = textures_stage(level, out, draw_doc, out / "_texture-tmp") \
            if textures else None
    except (ValueError, KeyError, OSError) as error:
        texture_doc = None
        draw_doc.setdefault("stageErrors", []).append(
            {"stage": "textures", "error": "%s: %s" % (type(error).__name__, error)})
        for row in draw_doc["draws"]:
            if row["status"] is None:
                row.update({"status": "unresolved",
                            "blocker": "texture-stage-error: %s" % error})
        log("[%s] textures FAILED: %s" % (level, error))
    timings["textures"] = time.perf_counter() - stage_start

    log("[%s] path" % level)
    stage_start = time.perf_counter()
    path_doc = path_stage(level, out)
    timings["path"] = time.perf_counter() - stage_start

    log("[%s] spawn" % level)
    stage_start = time.perf_counter()
    spawn_doc = spawn_stage(level, out, path_doc, triangles)
    timings["spawn"] = time.perf_counter() - stage_start

    log("[%s] blockers" % level)
    stage_start = time.perf_counter()
    blocker_doc = blockers_stage(level, collision, draw_doc, texture_doc, path_doc)
    timings["blockers"] = time.perf_counter() - stage_start

    write_json(out / "collision.json", collision)
    write_json(out / "path.json", path_doc)
    write_json(out / "spawn.json", spawn_doc)
    write_json(out / "blockers.json", blocker_doc)

    # ------------------------------------------------------------- draws.json
    counts = draw_doc["counts"]
    statuses = (texture_doc["counts"]["statuses"] if texture_doc
                else {"unresolved": counts["drawCount"]})
    draw_document = {
        "schema": SCHEMA_DRAWS,
        "level": level,
        "mapId": INTEGRATED.get(level),
        "kind": "first-renderlist-direct-lod0",
        "units": {"position": "metres, source level space", "uv0": "normalised",
                  "index": "uint32 global vertex index"},
        "scope": {
            "instancesApplied": False,
            "materialsApplied": False,
            "texturesBoundInRenderer": False,
            "normalsExported": False,
            "partialSceneTraversal": True,
            "coordinateSpace": "source level coordinates, unchanged",
        },
        "sources": {
            "levelRender": files["render"],
            "probeDocuments": probe_sources["documents"],
            "nativeReader": {"path": rel(ROOT / "_work/build/asset-reader-native/Release/level_inspect.exe"),
                             "sha256": sha256_file(ROOT / "_work/build/asset-reader-native/Release/level_inspect.exe")},
        },
        "counts": {
            **counts,
            "bindableDraws": statuses.get("bindable-static-albedo", 0),
            "blockedDraws": counts["drawCount"] - statuses.get("bindable-static-albedo", 0),
            "statuses": dict(sorted(statuses.items())),
        },
        "buffers": draw_doc["buffers"],
        "sections": draw_doc["sections"],
        "unsupportedSections": draw_doc["unsupportedSections"],
        "draws": draw_doc["draws"],
        "drawLists": {
            "opaque": {"predicate": "status == 'bindable-static-albedo'",
                       "count": statuses.get("bindable-static-albedo", 0),
                       "note": "filter draws by status; no separate index buffer is emitted"},
            "blocked": {"predicate": "status != 'bindable-static-albedo'",
                        "count": counts["drawCount"] - statuses.get("bindable-static-albedo", 0)},
            "blockedGroups": _blocked_groups(draw_doc["draws"]),
        },
        "textures": {
            "index": "textures/index.json",
            "sources": texture_doc["counts"]["distinctTextureSources"] if texture_doc else 0,
            "uniqueBlobs": texture_doc["counts"]["uniqueBlobs"] if texture_doc else 0,
            "referencedMip0Bytes": texture_doc["counts"]["referencedMip0Bytes"] if texture_doc else 0,
            "uniqueMip0Bytes": texture_doc["counts"]["uniqueMip0Bytes"] if texture_doc else 0,
        },
        "stageErrors": draw_doc.get("stageErrors", []),
        "limits": [
            "draw coverage is first-RenderList direct LOD0 only; instances not applied",
            "texture status is static-albedo identity only, not a GPU binding",
            "no vertex normals; no fallback normal is invented",
            "no renderer, GPU or playable-game claim",
        ],
    }
    write_json(out / "draws.json", draw_document)

    # ----------------------------------------------------------- report first
    stage_start = time.perf_counter()
    counts_row = {
        "draws": counts["drawCount"],
        "bindableDraws": statuses.get("bindable-static-albedo", 0),
        "drawTriangles": counts["triangleCount"],
        "vertices": counts["vertexCount"],
        "sectionsSupported": counts["sectionsSupported"],
        "sectionsProbed": counts["sectionsProbed"],
        "sectionsUnsupported": counts["sectionsUnsupported"],
        "instanceDescriptionsSkipped": counts["instanceDescriptionsSkipped"],
        "textureSources": texture_doc["counts"]["distinctTextureSources"] if texture_doc else 0,
        "textureBlobs": texture_doc["counts"]["uniqueBlobs"] if texture_doc else 0,
        "textureBytes": texture_doc["counts"]["uniqueMip0Bytes"] if texture_doc else 0,
        "textureBytesReferenced": texture_doc["counts"]["referencedMip0Bytes"] if texture_doc else 0,
        "collisionTriangles": collision["counts"]["triangles"],
        "collisionVertices": collision["counts"]["vertices"],
        "drawCoveredPathM": round(float(path_doc["drawCovered"]["lengthM"]), 6),
        "collisionPathM": round(float(path_doc["collisionOnly"]["lengthM"]), 6),
        "coverageOfCollisionDiameter": round(
            float(path_doc["drawCovered"]["coverageOfCollisionDiameter"]), 6),
        "pathSamples": path_doc["sampleCount"],
        "spawnValid": bool(spawn_doc["validity"]["pass"]),
    }
    report = {
        "schema": SCHEMA_REPORT,
        "level": level,
        "mapId": INTEGRATED.get(level),
        "grade": blocker_doc["grade"],
        "counts": counts_row,
        "spawn": {k: spawn_doc["spawn"][k]
                  for k in ("x", "z", "ground", "headingRad")},
        "spawnValidity": spawn_doc["validity"]["pass"],
        "timingsSeconds": {k: round(v, 4) for k, v in timings.items()},
        "totalSeconds": None,
        "artifacts": {name: name for name in ARTIFACTS},
        "blockers": {
            "count": blocker_doc["blockerCount"],
            "fatal": blocker_doc["fatalCount"],
            "codes": [b["code"] for b in blocker_doc["blockers"]],
        },
        "limits": [
            "data only: no renderer, GPU, browser or playable-game claim",
            "no retail start line, lap, respawn or pickup placement exists in this "
            "package",
            "coverage is first-RenderList direct LOD0 only; instances are not applied",
        ],
    }
    timings["report"] = time.perf_counter() - stage_start
    report["timingsSeconds"] = {k: round(v, 4) for k, v in timings.items()}

    # --------------------------------------------------------------- manifest
    stage_start = time.perf_counter()
    pinned = {}
    for name in ARTIFACTS:
        path = out / name
        if not path.is_file():
            raise ValueError("missing artifact " + name)
        pinned[name] = {"bytes": path.stat().st_size, "sha256": sha256_file(path)}
    for texture in sorted((out / "textures").glob("*.rgba")):
        name = "textures/" + texture.name
        pinned[name] = {"bytes": texture.stat().st_size, "sha256": sha256_file(texture)}

    map_registry = file_record(REGISTRY) if REGISTRY.is_file() else None
    manifest_body = {
        "schema": SCHEMA_MANIFEST,
        "kind": "map-batch-package",
        "level": level,
        "mapId": INTEGRATED.get(level),
        "grade": blocker_doc["grade"],
        "units": {
            "position": "metres",
            "normal": "unit vector",
            "uv0": "raw source UV0 pair; sampler not applied",
            "index": "uint32 index into the named position array",
            "heading": "radians; engine local +Z is longitudinal",
        },
        "scope": {
            "dataOnly": True,
            "playableClaim": False,
            "rendererClaim": False,
            "gpuClaim": False,
            "browserFrameProduced": False,
            "e1DriveIntegration": level in INTEGRATED,
            "integratedByRegistry": ({"mapId": INTEGRATED[level],
                                      "registry": map_registry}
                                     if level in INTEGRATED else None),
            "instancesApplied": False,
            "materialsApplied": False,
            "texturesBoundInRenderer": False,
            "normalsExported": False,
            "partialSceneTraversal": True,
        },
        "source": {
            "files": files,
            "probeDocuments": probe_sources["documents"],
            "nativeReader": {"path": rel(ROOT / "_work/build/asset-reader-native/Release/level_inspect.exe"),
                             "sha256": sha256_file(ROOT / "_work/build/asset-reader-native/Release/level_inspect.exe")},
            "textureDecoder": {"path": "_work/build/asset-reader-native/Release/texture_inspect.exe",
                               "sha256": sha256_file(ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe")},
            "scanner": collision["readers"]["scanner"],
            "oracle": collision["readers"]["oracle"],
            "path": path_doc["sources"],
            "mapRegistry": map_registry,
        },
        "counts": {
            "draws": counts_row["draws"],
            "bindableDraws": counts_row["bindableDraws"],
            "drawTriangles": counts_row["drawTriangles"],
            "vertices": counts_row["vertices"],
            "indices": counts["indexCount"],
            "sectionsProbed": counts_row["sectionsProbed"],
            "sectionsSupported": counts_row["sectionsSupported"],
            "sectionsUnsupported": counts_row["sectionsUnsupported"],
            "instanceDescriptionsSkipped": counts_row["instanceDescriptionsSkipped"],
            "textureSources": counts_row["textureSources"],
            "textureBlobs": counts_row["textureBlobs"],
            "textureBytes": counts_row["textureBytes"],
            "textureBytesReferenced": counts_row["textureBytesReferenced"],
            "collisionTriangles": counts_row["collisionTriangles"],
            "collisionVertices": counts_row["collisionVertices"],
            "drawCoveredPathM": counts_row["drawCoveredPathM"],
            "collisionPathM": counts_row["collisionPathM"],
            "coverageOfCollisionDiameter": counts_row["coverageOfCollisionDiameter"],
            "pathSamples": counts_row["pathSamples"],
            "spawnValid": counts_row["spawnValid"],
            "blockers": blocker_doc["blockerCount"],
            "fatalBlockers": blocker_doc["fatalCount"],
        },
        "artifacts": {
            "draws": "draws.json",
            "drawsBuffers": {
                "positions": draw_doc["buffers"]["positions"],
                "uv0": draw_doc["buffers"]["uv0"],
                "indices": draw_doc["buffers"]["indices"],
            },
            "textures": "textures/index.json",
            "collision": "collision.json",
            "collisionBuffers": {
                "positions": collision["buffers"]["positions"],
                "indices": collision["buffers"]["indices"],
            },
            "path": "path.json",
            "pathPoints": {"file": "path.points.f32.bin",
                           "bytes": pinned["path.points.f32.bin"]["bytes"],
                           "sha256": pinned["path.points.f32.bin"]["sha256"]},
            "spawn": "spawn.json",
            "blockers": "blockers.json",
        },
        "integrationContract": {
            "version": 1,
            "packageRoot": "_work/map-batch/" + level,
            "geometry": {
                "positionBuffer": "draws.positions.f32.bin",
                "positionFormat": "float32x3",
                "uv0Buffer": "draws.uv0.f32.bin",
                "uv0Format": "float32x2",
                "indexBuffer": "draws.indices.u32.bin",
                "indexFormat": "uint32",
                "drawList": "draws.json#draws",
                "opaqueFilter": "status == 'bindable-static-albedo'",
                "vertexCount": counts["vertexCount"],
                "indexCount": counts["indexCount"],
                "uploadOnce": True,
            },
            "textures": {
                "table": "textures/index.json#items",
                "selectBy": "draw.textureSlot",
                "uploadFormat": "rgba8unorm",
                "srgbVariant": "rgba8unorm-srgb",
                "srgbApplied": False,
                "uniqueBlobs": counts_row["textureBlobs"],
                "bytesMip0": counts_row["textureBytes"],
            },
            "layout": {
                "pointsBuffer": "path.points.f32.bin",
                "pointsFormat": "float32le x,z,h; 12 bytes per point",
                "sampleCount": path_doc["sampleCount"],
                "lengthM": path_doc["lengthM"],
                "spawn": spawn_doc["spawn"],
                "checkpoints": spawn_doc["layout"]["checkpoints"],
                "finish": spawn_doc["layout"]["finish"],
                "lap": None,
            },
            "slots": {
                "collider": {"id": level + ".collision",
                             "mesh": "collision.positions.f32.bin + collision.indices.u32.bin",
                             "hiddenPhysicsProvenance": True,
                             "engineLoadsFullPhysics": True},
                "pickups": [],
                "pickupReason": "no pickup/placement record exists in the level files; "
                                "nothing is invented",
                "laps": [{"id": level + ".lap.1", "kind": "point-to-point",
                          "startArcM": 0.0, "finishArcM": path_doc["lengthM"]}],
                "lapReason": "one point-to-point slot; the measured line is open and "
                             "no circuit is claimed",
            },
            "pins": {
                "manifestContentSha256Source": "manifest.hashes.contentSha256 "
                                               "(computed over this body without hashes)",
                "physicsFileSha256": files["physics"]["sha256"],
                "physicsBytes": files["physics"].get("bytes"),
                "renderFileSha256": files["render"]["sha256"],
                "levelrenderBytes": files["render"].get("bytes"),
            },
        },
        "limits": [
            "data only: no renderer, GPU, browser, engine or playable-game claim",
            "first-RenderList direct LOD0 draws only; instancesApplied:false",
            "static albedo identity and original UV0 only; no GPU material state",
            "no vertex normals; no fallback normal is invented",
            "spawn and course are derived from the measured path, not a retail start line",
            "no pickup placement, lap circuit or race-director rule is claimed",
        ],
    }
    manifest_body["hashes"] = {
        "algorithm": "sha256",
        "contentSha256": sha256_bytes(canonical(manifest_body)),
        "files": pinned,
    }
    content = manifest_body["hashes"]["contentSha256"]
    write_json(out / "manifest.json", manifest_body)
    timings["manifest"] = time.perf_counter() - stage_start

    report["timingsSeconds"] = {k: round(v, 4) for k, v in timings.items()}
    report["totalSeconds"] = round(time.perf_counter() - started, 4)
    report["hashes"] = {
        "manifest": sha256_file(out / "manifest.json"),
        "manifestContentSha256": content,
        "draws": sha256_file(out / "draws.json"),
        "path": sha256_file(out / "path.json"),
        "spawn": sha256_file(out / "spawn.json"),
        "blockers": sha256_file(out / "blockers.json"),
        "collision": sha256_file(out / "collision.json"),
    }
    write_json(out / "report.json", report)
    return {"level": level, "grade": report["grade"], "counts": counts_row,
            "timings": report["timingsSeconds"], "totalSeconds": report["totalSeconds"],
            "hashes": report["hashes"], "manifestContentSha256": content}


def build_all(*, textures: bool = True, log=print) -> dict:
    started = time.perf_counter()
    levels = all_levels()
    rows = []
    for level in levels:
        out = BATCH / level
        try:
            row = build_level(level, out, textures=textures, log=log)
        except Exception as error:  # noqa: BLE001 - one failed level must not stop the run
            log("[%s] FAILED: %s: %s" % (level, type(error).__name__, error))
            row = {"level": level, "grade": "error",
                   "error": "%s: %s" % (type(error).__name__, error)}
        rows.append(row)
    summary = {
        "schema": "blur.map-batch.batch/1",
        "generatedBy": "probes/map-batch/build_map.py --all",
        "levelCount": len(rows),
        "totalSeconds": round(time.perf_counter() - started, 4),
        "levels": rows,
    }
    BATCH.mkdir(parents=True, exist_ok=True)
    write_json(BATCH / "batch-summary.json", summary)
    return summary


