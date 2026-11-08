#!/usr/bin/env python3
"""Build the E1 map artifacts for a committed map-batch level.

This is the map-batch counterpart of `probes/e1-drive/tools/map_package_builder.mjs`.
It reads the committed map-batch package read-only and writes:

  _work/e1-drive/<map>/map.json      E1 map document (one merged mesh, the opaque
                                     draw list, textures, hidden collision
                                     provenance, blocked labels)
  _work/e1-drive/<map>/layout.json   the committed `e1-drive.sprint` path document,
                                     copied verbatim (its own `hash` is the pin)

Inputs (read-only):

  _work/map-batch/<level>/manifest.json          package pins
  _work/map-batch/<level>/draws.json             draw list + buffer pins
  _work/map-batch/<level>/draws.positions.f32.bin
  _work/map-batch/<level>/draws.uv0.f32.bin
  _work/map-batch/<level>/draws.indices.u32.bin
  _work/map-batch/<level>/textures/index.json
  _work/map-batch/<level>/textures/tex-*.rgba
  _work/map-batch/<level>/collision.positions.f32.bin
  _work/map-batch/<level>/collision.indices.u32.bin
  _work/map-batch/<level>/collision.json
  _work/map-batch/<level>/blockers.json
  _work/map-batch/<level>/spawn.json
  game-data/Blur/levels/<level>/Level.levelphysics
  probes/map-laps/data/<map>-path.json           committed collision-clear path

Every value is copied from the committed package. No colour, texture, transform
or coordinate is invented. A changed package is a hard failure: the file and
content hashes recorded here are also the page's pin set.

The map hash is computed with a JavaScript-compatible canonical JSON serializer
(`JSON.stringify` number formatting), so the page's `hashOf` accepts it.

Run:

    python probes/map-batch/tools/build_e1_package.py
    python probes/map-batch/tools/build_e1_package.py --map observatory
    python probes/map-batch/tools/build_e1_package.py --check
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import sys
from decimal import Decimal
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]

MAP_BUILDS = {
    "observatory": dict(
        id="observatory",
        level="usa_la_observatory",
        batch="_work/map-batch/usa_la_observatory",
        out_dir="_work/e1-drive/observatory",
        layout="probes/map-laps/data/observatory-path.json",
        physics="game-data/Blur/levels/usa_la_observatory/Level.levelphysics",
        mesh_id="observatory.direct",
        render_label="observatory-direct-draws",
        package_label="usa_la_observatory",
        course_name="usa_la_observatory collision-clear path",
        decal_status="blocked-effect-not-static-albedo",
        diagnostic_statuses=("blocked-alpha-rule-missing", "blocked-decoder-size-limit"),
        collision_note=("static triangle meshes only; the six Cylinders and four "
                        "InstancedTriangleMeshes are not in this buffer"),
        collision_reason=("hidden physics provenance; the engine loads the complete "
                          "Level.levelphysics, this mesh is not uploaded or drawn"),
        instance_descriptions=0,
        instance_sections=0,
        unsupported_sections=30,
        map_limits=[
            "direct LOD0 draws only; 30 unsupported sections are not applied",
            "no instance descriptions are present in this package",
            "89 additive/effect draws and 51 diagnostic draws (1 alpha-rule, 50 decoder-size) are skipped with labels; no fallback texture or colour",
            "collision triangles exclude the six Cylinders and four InstancedTriangleMeshes",
            "spawn, checkpoints and finish are the committed map-batch pose and collision-clear path, not a retail start line",
        ],
    ),
    "downtown": dict(
        id="downtown",
        level="usa_la_downtown",
        batch="_work/map-batch/usa_la_downtown",
        out_dir="_work/e1-drive/downtown",
        layout="probes/map-laps/data/downtown-path.json",
        physics="game-data/Blur/levels/usa_la_downtown/Level.levelphysics",
        mesh_id="downtown.direct",
        render_label="downtown-direct-draws",
        package_label="usa_la_downtown",
        course_name="usa_la_downtown collision-clear path",
        decal_status="blocked-effect-not-static-albedo",
        diagnostic_statuses=("blocked-alpha-rule-missing", "blocked-runtime-albedo-parameter"),
        collision_note=("static triangle meshes only; the FluidMesh is not in this "
                        "buffer"),
        collision_reason=("hidden physics provenance; the engine loads the complete "
                          "Level.levelphysics, this mesh is not uploaded or drawn"),
        instance_descriptions=15002,
        instance_sections=75,
        unsupported_sections=4,
        map_limits=[
            "direct LOD0 draws only; 4 unsupported sections and 15,002 instance descriptions in 75 sections are not applied",
            "428 additive/effect draws and 216 diagnostic draws (211 alpha-rule, 5 runtime-albedo) are skipped with labels; no fallback texture or colour",
            "collision triangles exclude the FluidMesh",
            "spawn, checkpoints and finish are the committed map-batch pose and collision-clear path, not a retail start line",
        ],
    ),
    "mharuna": dict(
        id="mharuna",
        level="jpn_mharuna",
        batch="_work/map-batch/jpn_mharuna",
        out_dir="_work/e1-drive/mharuna",
        layout="probes/map-laps/data/mharuna-path.json",
        physics="game-data/Blur/levels/jpn_mharuna/Level.levelphysics",
        mesh_id="mharuna.direct",
        render_label="mharuna-direct-draws",
        package_label="jpn_mharuna",
        course_name="jpn_mharuna collision-clear path",
        decal_status=None,
        diagnostic_statuses=("blocked-alpha-rule-missing", "blocked-decoder-size-limit",
                             "blocked-runtime-albedo-parameter", "blocked-no-static-albedo"),
        collision_note=("static triangle meshes only; the simple/composite collision "
                        "shapes are not in this buffer"),
        collision_reason=("hidden physics provenance; the engine loads the complete "
                          "Level.levelphysics, this mesh is not uploaded or drawn"),
        instance_descriptions=416,
        instance_sections=34,
        unsupported_sections=34,
        map_limits=[
            "direct LOD0 draws only; 34 unsupported sections and 416 instance descriptions are not applied",
            "the additive/effect and diagnostic draws are skipped with labels; no fallback texture or colour",
            "collision triangles exclude the simple/composite collision shapes",
            "spawn, checkpoints and finish are the committed map-batch pose and collision-clear path, not a retail start line",
        ],
    ),
    "highrise": dict(
        id="highrise",
        level="usa_la_multiplayer_highrise",
        batch="_work/map-batch/usa_la_multiplayer_highrise",
        out_dir="_work/e1-drive/highrise",
        layout="probes/map-laps/data/highrise-path.json",
        physics="game-data/Blur/levels/usa_la_multiplayer_highrise/Level.levelphysics",
        mesh_id="highrise.direct",
        render_label="highrise-direct-draws",
        package_label="usa_la_multiplayer_highrise",
        course_name="usa_la_multiplayer_highrise collision-clear path",
        decal_status="blocked-effect-not-static-albedo",
        diagnostic_statuses=("blocked-alpha-rule-missing", "blocked-decoder-size-limit",
                             "blocked-missing-texture-source"),
        collision_note=("static triangle meshes only; the simple/composite collision "
                        "shapes are not in this buffer"),
        collision_reason=("hidden physics provenance; the engine loads the complete "
                          "Level.levelphysics, this mesh is not uploaded or drawn"),
        instance_descriptions=0,
        instance_sections=0,
        unsupported_sections=0,
        map_limits=[
            "direct LOD0 draws only; no unsupported sections in this package",
            "31 effect draws and 13 diagnostic draws (1 alpha-rule, 6 decoder-size, 6 missing texture source) are skipped with labels; no fallback texture or colour",
            "collision triangles exclude the simple/composite collision shapes",
            "spawn, checkpoints and finish are the committed map-batch pose and collision-clear path, not a retail start line",
        ],
    ),
    "shutoko": dict(
        id="shutoko",
        level="jpn_tokyo_shutoko",
        batch="_work/map-batch/jpn_tokyo_shutoko",
        out_dir="_work/e1-drive/shutoko",
        layout="probes/map-laps/data/shutoko-path.json",
        physics="game-data/Blur/levels/jpn_tokyo_shutoko/Level.levelphysics",
        mesh_id="shutoko.direct",
        render_label="shutoko-direct-draws",
        package_label="jpn_tokyo_shutoko",
        course_name="jpn_tokyo_shutoko collision-clear path",
        decal_status="blocked-effect-not-static-albedo",
        diagnostic_statuses=("blocked-alpha-rule-missing", "blocked-decoder-size-limit",
                             "blocked-missing-texture-source", "blocked-no-static-albedo",
                             "blocked-runtime-albedo-parameter"),
        collision_note=("static triangle meshes only; the simple/composite collision "
                        "shapes are not in this buffer"),
        collision_reason=("hidden physics provenance; the engine loads the complete "
                          "Level.levelphysics, this mesh is not uploaded or drawn"),
        instance_descriptions=6762,
        instance_sections=36,
        unsupported_sections=4,
        map_limits=[
            "direct LOD0 draws only; 4 unsupported sections and 6,762 instance descriptions in 36 sections are not applied",
            "190 effect draws and 199 diagnostic draws (189 alpha-rule, 2 decoder-size, 4 missing texture source, 2 no-static-albedo, 2 runtime-albedo) are skipped with labels; no fallback texture or colour",
            "collision triangles exclude the simple/composite collision shapes",
            "spawn, checkpoints and finish are the committed map-batch pose and collision-clear path, not a retail start line",
        ],
    ),
    "oval": dict(
        id="oval",
        level="spa_barcelona_oval",
        batch="_work/map-batch/spa_barcelona_oval",
        out_dir="_work/e1-drive/oval",
        layout="probes/map-laps/data/oval-path.json",
        physics="game-data/Blur/levels/spa_barcelona_oval/Level.levelphysics",
        mesh_id="oval.direct",
        render_label="oval-direct-draws",
        package_label="spa_barcelona_oval",
        course_name="spa_barcelona_oval collision-clear path",
        decal_status="blocked-effect-not-static-albedo",
        diagnostic_statuses=("blocked-alpha-rule-missing", "blocked-missing-texture-source",
                             "blocked-no-static-albedo", "blocked-runtime-albedo-parameter"),
        collision_note=("static triangle meshes only; the simple/composite collision "
                        "shapes are not in this buffer"),
        collision_reason=("hidden physics provenance; the engine loads the complete "
                          "Level.levelphysics, this mesh is not uploaded or drawn"),
        instance_descriptions=756,
        instance_sections=2,
        unsupported_sections=25,
        map_limits=[
            "direct LOD0 draws only; 25 unsupported sections and 756 instance descriptions in 2 sections are not applied",
            "123 effect draws and 87 diagnostic draws (73 alpha-rule, 1 missing texture source, 9 no-static-albedo, 4 runtime-albedo) are skipped with labels; no fallback texture or colour",
            "collision triangles exclude the simple/composite collision shapes",
            "spawn, checkpoints and finish are the committed map-batch pose and collision-clear path, not a retail start line",
        ],
    ),
    "amboy-mp": dict(
        id="amboy-mp",
        level="usa_amboy_multiplayer",
        batch="_work/map-batch/usa_amboy_multiplayer",
        out_dir="_work/e1-drive/amboy-mp",
        layout="probes/map-laps/data/amboy-mp-path.json",
        physics="game-data/Blur/levels/usa_amboy_multiplayer/Level.levelphysics",
        mesh_id="amboy-mp.direct",
        render_label="amboy-mp-direct-draws",
        package_label="usa_amboy_multiplayer",
        course_name="usa_amboy_multiplayer collision-clear path",
        decal_status=None,
        diagnostic_statuses=("blocked-decoder-size-limit",),
        collision_note=("static triangle meshes only; the simple/composite collision "
                        "shapes are not in this buffer"),
        collision_reason=("hidden physics provenance; the engine loads the complete "
                          "Level.levelphysics, this mesh is not uploaded or drawn"),
        instance_descriptions=213,
        instance_sections=1,
        unsupported_sections=6,
        map_limits=[
            "direct LOD0 draws only; 6 unsupported sections and 213 instance descriptions in 1 section are not applied",
            "8 diagnostic draws (decoder-size) are skipped with labels; no fallback texture or colour",
            "collision triangles exclude the simple/composite collision shapes",
            "spawn, checkpoints and finish are the committed map-batch pose and collision-clear path, not a retail start line",
        ],
    ),
}


# --------------------------------------------------------------------------
# JavaScript-compatible JSON
# --------------------------------------------------------------------------
def js_number(value) -> str:
    """Format a number exactly as `JSON.stringify` does."""
    x = float(value)
    if x == 0:
        return "0"
    if not math.isfinite(x):
        raise ValueError("non-finite number in the map document")
    if x == int(x) and abs(x) < 1e21:
        return str(int(x))
    text = repr(x)
    if "e" in text or "E" in text:
        mantissa, exponent = text.lower().split("e")
        exp = int(exponent)
        if -6 <= exp < 21:
            return format(Decimal(text), "f")
        mantissa = mantissa.rstrip("0").rstrip(".") if "." in mantissa else mantissa
        return mantissa + "e" + ("+" if exp >= 0 else "-") + str(abs(exp))
    return text


def js_dumps(value) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return js_number(value)
    if isinstance(value, np.ndarray):
        if value.ndim != 1:
            raise TypeError("only 1-D arrays are serialised")
        return "[" + ",".join(js_number(v) for v in value.tolist()) + "]"
    if isinstance(value, (list, tuple)):
        if value and all(isinstance(v, (int, float)) and not isinstance(v, bool)
                         for v in value):
            return "[" + ",".join(js_number(v) for v in value) + "]"
        return "[" + ",".join(js_dumps(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(str(k), ensure_ascii=False) + ":" + js_dumps(v)
                              for k, v in value.items()) + "}"
    raise TypeError("cannot serialise " + type(value).__name__)


def sort_value(value):
    if isinstance(value, list):
        return [sort_value(v) for v in value]
    if isinstance(value, np.ndarray):
        return value
    if isinstance(value, dict):
        return {key: sort_value(value[key]) for key in sorted(value)}
    return value


def js_hash(value) -> str:
    body = js_dumps(sort_value(value))
    return "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


LABELS = {
    "blocked-alpha-rule-missing": "alphaRuleMissing",
    "blocked-decoder-size-limit": "decoderSizeLimit",
    "blocked-runtime-albedo-parameter": "runtimeAlbedoParameter",
    "blocked-no-static-albedo": "noStaticAlbedo",
    "blocked-missing-texture-source": "missingTextureSource",
}

GROUP_NAMES = {
    "blocked-alpha-rule-missing": "alphaRule",
    "blocked-decoder-size-limit": "decoderSize",
    "blocked-runtime-albedo-parameter": "runtimeAlbedo",
    "blocked-no-static-albedo": "noStaticAlbedo",
    "blocked-missing-texture-source": "missingTextureSource",
}


# --------------------------------------------------------------------------
# package
# --------------------------------------------------------------------------
def build_map(map_id: str, check: bool = False, log=print):
    cfg = MAP_BUILDS[map_id]
    batch = ROOT / cfg["batch"]
    out_dir = ROOT / cfg["out_dir"]

    manifest_path = batch / "manifest.json"
    draws_path = batch / "draws.json"
    collision_path = batch / "collision.json"
    blockers_path = batch / "blockers.json"
    textures_path = batch / "textures" / "index.json"
    spawn_path = batch / "spawn.json"
    physics_path = ROOT / cfg["physics"]
    layout_path = ROOT / cfg["layout"]

    for path in (manifest_path, draws_path, collision_path, blockers_path,
                 textures_path, spawn_path, physics_path, layout_path):
        if not path.exists():
            raise SystemExit("missing input: " + str(path.relative_to(ROOT)))

    manifest_bytes = manifest_path.read_bytes()
    draws_bytes = draws_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    draws = json.loads(draws_bytes)
    collision = load_json(collision_path)
    textures_index = load_json(textures_path)
    spawn_doc = load_json(spawn_path)
    physics_bytes = physics_path.read_bytes()

    if manifest.get("level") != cfg["level"] or draws.get("level") != cfg["level"]:
        raise SystemExit("package is not " + cfg["level"])
    if spawn_doc.get("level") != cfg["level"]:
        raise SystemExit("spawn.json is not " + cfg["level"])

    # ------------------------------------------------------------ pins
    files = manifest["hashes"]["files"]
    for name, path in (("draws.json", draws_path), ("collision.json", collision_path),
                       ("blockers.json", blockers_path),
                       ("textures/index.json", textures_path),
                       ("spawn.json", spawn_path),
                       ("collision.positions.f32.bin",
                        batch / "collision.positions.f32.bin"),
                       ("collision.indices.u32.bin",
                        batch / "collision.indices.u32.bin"),
                       ("draws.positions.f32.bin", batch / "draws.positions.f32.bin"),
                       ("draws.uv0.f32.bin", batch / "draws.uv0.f32.bin"),
                       ("draws.indices.u32.bin", batch / "draws.indices.u32.bin")):
        record = files.get(name)
        if not record:
            raise SystemExit("manifest has no pin for " + name)
        if path.stat().st_size != record["bytes"] or file_sha256(path) != "sha256:" + record["sha256"]:
            raise SystemExit("%s does not match the manifest pin" % path)

    draws_sha = file_sha256(draws_path)

    # ------------------------------------------------------------ geometry
    positions_bytes = (batch / "draws.positions.f32.bin").read_bytes()
    uv0_bytes = (batch / "draws.uv0.f32.bin").read_bytes()
    index_bytes = (batch / "draws.indices.u32.bin").read_bytes()
    positions = np.frombuffer(positions_bytes, dtype="<f4")
    uv0 = np.frombuffer(uv0_bytes, dtype="<f4")
    indices = np.frombuffer(index_bytes, dtype="<u4")
    vertex_count = len(positions) // 3
    index_count = len(indices)
    if vertex_count != draws["counts"]["vertexCount"]:
        raise SystemExit("vertex count %d != committed %d"
                         % (vertex_count, draws["counts"]["vertexCount"]))
    if index_count != draws["counts"]["indexCount"]:
        raise SystemExit("index count %d != committed %d"
                         % (index_count, draws["counts"]["indexCount"]))
    if len(uv0) != vertex_count * 2:
        raise SystemExit("UV0 count %d != vertex count %d * 2" % (len(uv0), vertex_count))

    mesh = {
        "id": cfg["mesh_id"],
        "storage": "inline-json",
        "vertexCount": vertex_count,
        "indexCount": index_count,
        "positions": positions,
        "indices": indices,
        "positionsSha256": file_sha256(batch / "draws.positions.f32.bin"),
        "indicesSha256": file_sha256(batch / "draws.indices.u32.bin"),
        "uv": {
            "storage": "base64-float32le",
            "components": 2,
            "vertexCount": vertex_count,
            "values": vertex_count * 2,
            "bytes": len(uv0_bytes),
            "data": base64.b64encode(uv0_bytes).decode("ascii"),
            "sha256": file_sha256(batch / "draws.uv0.f32.bin"),
            "source": {
                "provenance": ("committed map-batch draws.uv0.f32.bin; "
                               "%d placeholder vertices"
                               % draws["counts"]["uv0PlaceholderVertices"]),
            },
        },
        "coordinateSpace": "world",
        "source": {
            "package": cfg["batch"],
            "buffers": ["draws.positions.f32.bin", "draws.uv0.f32.bin",
                        "draws.indices.u32.bin"],
            "note": ("positions and UV0 are separate per-vertex streams, indices are "
                     "global; copied byte-for-byte from the committed package"),
        },
    }

    # ------------------------------------------------------------ draws
    def bounds_for(first_index, count):
        lo = [math.inf, math.inf, math.inf]
        hi = [-math.inf, -math.inf, -math.inf]
        for index in range(first_index, first_index + count):
            vertex = int(indices[index]) * 3
            for axis in range(3):
                value = float(positions[vertex + axis])
                if value < lo[axis]:
                    lo[axis] = value
                if value > hi[axis]:
                    hi[axis] = value
        return {"min": lo, "max": hi}

    opaque = [draw for draw in draws["draws"]
              if draw["status"] == "bindable-static-albedo"]
    if len(opaque) != draws["counts"]["bindableDraws"]:
        raise SystemExit("opaque draw count %d != committed %d"
                         % (len(opaque), draws["counts"]["bindableDraws"]))
    draw_records = []
    for ordinal, draw in enumerate(opaque):
        if not (draw["firstIndex"] >= 0 and draw["indexCount"] > 0
                and draw["indexCount"] % 3 == 0
                and draw["firstIndex"] + draw["indexCount"] <= index_count):
            raise SystemExit("draw %s has an invalid index range" % draw["id"])
        bounds = bounds_for(draw["firstIndex"], draw["indexCount"])
        if not all(math.isfinite(v) for v in bounds["min"] + bounds["max"]):
            raise SystemExit("draw %s bounds are not finite" % draw["id"])
        draw_records.append({
            "id": "%s.draw.%d" % (cfg["id"], ordinal),
            "meshId": cfg["mesh_id"],
            "indexOffset": draw["firstIndex"],
            "indexCount": draw["indexCount"],
            "triangleCount": draw["triangleCount"],
            "textureId": draw["textureId"],
            "textureSlot": draw["textureSlot"],
            "textureName": draw["textureName"],
            "uvHash": draw["uvHash"],
            "section": draw["sectionId"],
            "sectionDrawIndex": draw["sectionDrawIndex"],
            "primitiveIndex": None,
            "effect": draw["effect"],
            "material": draw["material"],
            "materialRow": draw["materialRow"],
            "layer": "opaque",
            "worldKind": "baked-into-mesh",
            "bounds": bounds,
            "source": {
                "package": cfg["batch"],
                "drawId": draw["id"],
                "status": draw["status"],
            },
        })

    # ------------------------------------------------------------ textures
    texture_records = []
    for item in textures_index["items"]:
        file = batch / item["file"]
        rgba = file.read_bytes()
        if len(rgba) != item["bytes"] or file_sha256(file) != "sha256:" + item["sha256"]:
            raise SystemExit("texture %s does not match textures/index.json" % item["file"])
        if len(rgba) != item["width"] * item["height"] * 4:
            raise SystemExit("texture %s byte length does not match its dimensions"
                             % item["file"])
        texture_records.append({
            "id": item["primaryId"],
            "sourceIds": list(item["sourceIds"]),
            "slot": item["slot"],
            "name": item["name"],
            "width": item["width"],
            "height": item["height"],
            "levels": item["levels"],
            "format": item["format"],
            "formatName": item["formatName"],
            "alphaOpaque": bool(item["alpha"]["alphaOpaque"]),
            "sampler": list(item["sampler"]) if isinstance(item["sampler"], list) else None,
            "samplerReason": (None if isinstance(item["sampler"], list)
                              else "no raw sampler state recorded for this shared source; not applied"),
            "bytes": len(rgba),
            "rgbaBytes": len(rgba),
            "rgbaSha256": "sha256:" + item["sha256"],
            "rgbaBase64": base64.b64encode(rgba).decode("ascii"),
            "srgbHint": item["srgbHint"],
            "mipHint": item["mipHint"],
            "upload": item["upload"],
            "drawCount": item["drawCount"],
            "triangleCount": item["triangleCount"],
            "source": {
                "package": cfg["batch"],
                "file": item["file"],
                "sha256": "sha256:" + item["sha256"],
            },
        })
    if len(texture_records) != textures_index["counts"]["uniqueBlobs"]:
        raise SystemExit("texture count %d != committed %d"
                         % (len(texture_records), textures_index["counts"]["uniqueBlobs"]))

    texture_id_by_source = {}
    for texture in texture_records:
        for source_id in texture["sourceIds"]:
            texture_id_by_source[source_id] = texture["id"]
    for draw in draw_records:
        merged = texture_id_by_source.get(draw["textureId"])
        if merged is None:
            raise SystemExit("draw %s names unknown texture source %s"
                             % (draw["id"], draw["textureId"]))
        draw["textureSourceId"] = draw["textureId"]
        draw["textureId"] = merged

    # ------------------------------------------------------------ collision
    collision_positions = np.frombuffer(
        (batch / "collision.positions.f32.bin").read_bytes(), dtype="<f4")
    collision_indices = np.frombuffer(
        (batch / "collision.indices.u32.bin").read_bytes(), dtype="<u4")
    collision_vertex_count = len(collision_positions) // 3
    collision_index_count = len(collision_indices)
    if collision_vertex_count != collision["counts"]["vertices"]:
        raise SystemExit("collision vertex count does not match collision.json")
    if collision_index_count != collision["counts"]["triangles"] * 3:
        raise SystemExit("collision index count does not match collision.json")
    collision_bounds = {"min": [math.inf, math.inf, math.inf],
                        "max": [-math.inf, -math.inf, -math.inf]}
    for index in range(0, len(collision_positions), 3):
        for axis in range(3):
            value = float(collision_positions[index + axis])
            if value < collision_bounds["min"][axis]:
                collision_bounds["min"][axis] = value
            if value > collision_bounds["max"][axis]:
                collision_bounds["max"][axis] = value
    collision_surface = {
        "id": cfg["id"] + ".collision",
        "meshId": cfg["id"] + ".collision.mesh",
        "visible": False,
        "physicsOnly": True,
        "vertexCount": collision_vertex_count,
        "triangleCount": collision_index_count // 3,
        "bounds": collision_bounds,
        "source": {"package": cfg["batch"], "note": cfg["collision_note"]},
        "reason": cfg["collision_reason"],
        "mesh": {
            "id": cfg["id"] + ".collision.mesh",
            "storage": "inline-json",
            "vertexCount": collision_vertex_count,
            "indexCount": collision_index_count,
            "positions": collision_positions,
            "indices": collision_indices,
            "positionsSha256": file_sha256(batch / "collision.positions.f32.bin"),
            "indicesSha256": file_sha256(batch / "collision.indices.u32.bin"),
            "uv": None,
            "coordinateSpace": "world",
            "source": {"package": cfg["batch"]},
        },
        "draw": {
            "id": cfg["id"] + ".collision.draw",
            "meshId": cfg["id"] + ".collision.mesh",
            "indexOffset": 0,
            "indexCount": collision_index_count,
            "visible": False,
        },
    }

    # ------------------------------------------------------------ blocked
    groups = draws["drawLists"]["blockedGroups"]
    effect = groups.get(cfg["decal_status"]) if cfg.get("decal_status") else None
    if cfg.get("decal_status") and effect is None:
        raise SystemExit("draws.json has no %s group" % cfg["decal_status"])
    if effect is None:
        # A map with no effect/decal draws records an explicit zero group.
        effect = {"draws": 0, "triangles": 0, "indexRanges": []}
    diagnostic_groups = {}
    diagnostic_counts = {"alphaRule": 0, "decoderSize": 0, "runtimeAlbedo": 0,
                     "noStaticAlbedo": 0, "missingTextureSource": 0}
    diagnostic_draws = 0
    diagnostic_triangles = 0
    for status in cfg["diagnostic_statuses"]:
        group = groups.get(status)
        if group is None:
            raise SystemExit("draws.json has no %s group" % status)
        diagnostic_groups[status] = {
            "draws": group["draws"],
            "triangles": group["triangles"],
            "indexRanges": group["indexRanges"],
        }
        diagnostic_counts[GROUP_NAMES[status]] = group["draws"]
        diagnostic_draws += group["draws"]
        diagnostic_triangles += group["triangles"]
    blocked = {
        "draws": draws["counts"]["blockedDraws"],
        "triangles": effect["triangles"] + diagnostic_triangles,
        "effectDecal": {
            "draws": effect["draws"],
            "triangles": effect["triangles"],
            "indexRanges": effect["indexRanges"],
            "treatment": ("skipped: a separate additive/alpha-tested pass is not "
                          "implemented; not bound as opaque albedo"),
            "textureBound": False,
            "fallback": "none",
        },
        "diagnosticOnly": {
            "draws": diagnostic_draws,
            "triangles": diagnostic_triangles,
            "groups": diagnostic_counts,
            "statusGroups": diagnostic_groups,
            "treatment": ("skipped: no texture is bound and no fallback texture or "
                          "colour is invented"),
            "textureBound": False,
            "fallback": "none",
        },
        "note": ("the shared index buffer still contains every blocked range; it is "
                 "only reachable through this list, never through the opaque draw list"),
        "labels": {
            "effectNotStaticAlbedo": effect["draws"],
            **{LABELS[status]: group["draws"]
               for status, group in diagnostic_groups.items()},
        },
    }
    if blocked["draws"] != effect["draws"] + diagnostic_draws:
        raise SystemExit("blocked draw counts do not add up")

    # ------------------------------------------------------------ layout
    layout_bytes = layout_path.read_bytes()
    layout = json.loads(layout_bytes)
    if layout.get("kind") != "e1-drive.sprint" or layout.get("courseId") != cfg["id"]:
        raise SystemExit("%s is not an e1-drive.sprint %s layout"
                         % (cfg["layout"], cfg["id"]))

    # ------------------------------------------------------------ document
    draw_triangles = sum(draw["triangleCount"] for draw in draw_records)
    texture_bytes = sum(texture["rgbaBytes"] for texture in texture_records)
    counts = {
        "draws": len(draw_records),
        "drawTriangles": draw_triangles,
        "textures": len(texture_records),
        "textureBytes": texture_bytes,
        "vertices": vertex_count,
        "indices": index_count,
        "triangles": index_count // 3,
        "blockedDraws": blocked["draws"],
        "blockedTriangles": blocked["triangles"],
        "decalDraws": blocked["effectDecal"]["draws"],
        "diagnosticDraws": blocked["diagnosticOnly"]["draws"],
        "collisionVertices": collision_vertex_count,
        "collisionTriangles": collision_index_count // 3,
    }
    if counts["drawTriangles"] != textures_index["counts"]["statusTriangles"]["bindable-static-albedo"]:
        raise SystemExit("draw triangle count does not match textures/index.json")
    if counts["textureBytes"] != manifest["counts"]["textureBytes"]:
        raise SystemExit("texture byte count does not match the manifest")

    render_bounds = {
        "min": [min(draw["bounds"]["min"][axis] for draw in draw_records)
                for axis in range(3)],
        "max": [max(draw["bounds"]["max"][axis] for draw in draw_records)
                for axis in range(3)],
    }

    map_body = {
        "kind": "e1-drive.map-package",
        "version": 1,
        "level": cfg["level"],
        "source": {
            "slice": {
                "path": cfg["batch"] + "/collision.json",
                "bytes": collision_path.stat().st_size,
                "sha256": file_sha256(collision_path),
                "contentHash": file_sha256(collision_path),
                "contentHashSource": ("the map-batch package records no canonical "
                                      "content hash for collision.json; its committed "
                                      "file pin is used"),
                "note": ("the collision slice document; the map-batch manifest is not "
                         "pinned here because it pins map-registry.js, which pins this "
                         "package"),
            },
            "render": {
                "path": cfg["batch"] + "/draws.json",
                "bytes": len(draws_bytes),
                "sha256": draws_sha,
                "contentHash": draws_sha,
                "contentHashSource": ("the map-batch package records no canonical "
                                      "content hash for draws.json; its committed "
                                      "file pin is used"),
            },
            "blockers": {
                "path": cfg["batch"] + "/blockers.json",
                "bytes": blockers_path.stat().st_size,
                "sha256": file_sha256(blockers_path),
            },
            "textures": {
                "path": cfg["batch"] + "/textures/index.json",
                "bytes": textures_path.stat().st_size,
                "sha256": file_sha256(textures_path),
            },
            "spawnDocument": {
                "path": cfg["batch"] + "/spawn.json",
                "bytes": spawn_path.stat().st_size,
                "sha256": file_sha256(spawn_path),
            },
            "physics": {
                "path": cfg["physics"],
                "bytes": len(physics_bytes),
                "sha256": file_sha256(physics_path),
            },
            "module": {
                "path": "_work/e1-drive/module/e1_drive.wasm",
                "policy": ("behaviour-based; see "
                           "docs/work/analysis/map-slice-module-pin-policy.md"),
            },
            "packet": cfg["batch"] + "/draws.json",
            "packetHash": draws_sha,
            "packetSha256": draws_sha,
        },
        "counts": counts,
        "meshes": [mesh],
        "mapRender": {
            "label": cfg["render_label"],
            "meshId": cfg["mesh_id"],
            "drawCount": len(draw_records),
            "triangleCount": draw_triangles,
            "texturedDrawCount": len(draw_records),
            "vertexCount": vertex_count,
            "triangleTotal": index_count // 3,
            "draws": draw_records,
            "textures": texture_records,
            "sections": [],
            "texturePack": {
                "format": "rgba8unorm",
                "srgbVariant": "rgba8unorm-srgb",
                "srgbAppliedByProducer": False,
                "mipPolicy": "mip0 decoded; the consumer derives a full mip chain",
                "sampler": ("raw sampler state recorded per texture; wrap/filter not "
                            "applied by the producer"),
                "uniqueBlobs": len(texture_records),
                "bytesMip0": texture_bytes,
            },
            "bounds": render_bounds,
            "spawn": {
                **spawn_doc["spawn"],
                "validity": spawn_doc.get("validity"),
                "sourceDocument": cfg["batch"] + "/spawn.json",
            },
            "collisionSurface": collision_surface,
            "blocked": blocked,
            "normals": {
                "vertexNormals": 0,
                "source": "the committed direct-draw reader exports no normal stream",
                "fallback": ("the existing consumer screen-space derivative normal "
                             "path (cross(dpdx,dpdy) of world position)"),
                "note": "no vertex normal was invented",
            },
            "instances": {
                "applied": False,
                "descriptions": cfg["instance_descriptions"],
                "sections": cfg["instance_sections"],
                "note": "not applied; instance-only geometry can add surfaces",
            },
            "unsupportedSections": cfg["unsupported_sections"],
            "limits": cfg["map_limits"],
        },
    }
    if map_body["mapRender"]["instances"]["descriptions"] != draws["counts"]["instanceDescriptionsSkipped"]:
        raise SystemExit("instance description count does not match draws.json")
    if map_body["mapRender"]["unsupportedSections"] != draws["counts"]["sectionsUnsupported"]:
        raise SystemExit("unsupported section count does not match draws.json")
    map_hash = js_hash(map_body)

    map_doc = {**map_body, "hash": map_hash}
    map_text = js_dumps(map_doc) + "\n"
    map_bytes = map_text.encode("utf-8")
    layout_text = layout_bytes  # verbatim

    if check:
        current_map = (out_dir / "map.json").read_bytes() if (out_dir / "map.json").exists() else None
        current_layout = (out_dir / "layout.json").read_bytes() if (out_dir / "layout.json").exists() else None
        if current_map != map_bytes:
            raise SystemExit(cfg["out_dir"] + "/map.json is stale or hand-edited; rebuild it")
        if current_layout != layout_text:
            raise SystemExit(cfg["out_dir"] + "/layout.json is stale or hand-edited; rebuild it")
        return {
            "mode": "check",
            "ok": True,
            "mapId": cfg["id"],
            "mapHash": map_hash,
            "layoutHash": layout["hash"],
        }

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "map.json").write_bytes(map_bytes)
    (out_dir / "layout.json").write_bytes(layout_text)
    return {
        "mode": "build",
        "mapId": cfg["id"],
        "map": {
            "path": cfg["out_dir"] + "/map.json",
            "bytes": len(map_bytes),
            "sha256": "sha256:" + hashlib.sha256(map_bytes).hexdigest(),
            "contentHash": map_hash,
        },
        "layout": {
            "path": cfg["out_dir"] + "/layout.json",
            "bytes": len(layout_text),
            "sha256": "sha256:" + hashlib.sha256(layout_text).hexdigest(),
            "contentHash": layout["hash"],
        },
        "counts": counts,
        "textures": {
            "uniqueBlobs": len(texture_records),
            "bytesMip0": texture_bytes,
            "mergedGroups": len(textures_index.get("mergedGroups") or []),
        },
        "gates": [{"id": gate["id"], "arc": gate["arc"]} for gate in layout["gates"]],
        "layoutSpan": layout["course"]["span"],
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", choices=sorted(MAP_BUILDS) + ["all"], default="all")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)
    keys = sorted(MAP_BUILDS) if args.map == "all" else [args.map]
    results = []
    for key in keys:
        results.append(build_map(key, check=args.check))
    print(json.dumps(results if len(results) > 1 else results[0], indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


