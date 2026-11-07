#!/usr/bin/env python3
"""Build a render-ready package from a slice and its texture bindings.

Defaults to ``usa_amboy`` (committed MAP2 slice + MAP3 bindings). Pass
``--level spa_barcelona_gracia`` for Gracia. Inputs (read-only):
  _work/map-slice/<short>/slice.json
  _work/map-slice/<short>/draws.{positions.f32,uv0.f32,indices.u32}.bin
  _work/map-slice/<short>-textures/bindings.json
  _work/map-slice/<short>-textures/blockers.json
  _work/map-slice/<short>-textures/textures/*.rgba

Output (default _work/map-slice/<short>-render):
  render.json                     manifest: buffers, 1,201 draws, 179 texture
                                  blobs, layout/spawn, upload contract, hashes
  diagnostics.json                405 blocked draws + separate additive-decal list
  draws.positions.f32.bin         identical bytes to the slice buffer
  draws.uv0.f32.bin               identical bytes to the slice buffer
  draws.indices.u32.bin           identical bytes to the slice buffer
  layout.points.f32.bin           8,673 x,z,h float32le points
  textures/tex-NNN.rgba           179 deduplicated bindable RGBA8 mip0 blobs

The build is deterministic: no timestamps, no absolute output paths and no
platform-dependent ordering. Identical texture blobs are merged; a draw keeps its
original MAP3 ``textureId`` and points at the merged slot.

Data only. This tool does not upload to a GPU, render a frame, touch e1-drive or
invent a texture.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-slice/tools"))
from map_slice_common import package_dir, render_dir, short_name, texture_dir  # noqa: E402

LEVEL = "usa_amboy"
SLICE_DIR = package_dir(LEVEL)
TEXTURE_DIR = texture_dir(LEVEL)
BINDINGS = TEXTURE_DIR / "bindings.json"
BLOCKERS = TEXTURE_DIR / "blockers.json"
RGBA_DIR = TEXTURE_DIR / "textures"
DEFAULT_OUT = render_dir(LEVEL)
PREFIX = short_name(LEVEL)

SCHEMA = "blur.map-slice.amboy-render/1"
DIAG_SCHEMA = "blur.map-slice.amboy-render-diagnostics/1"

FNV_OFFSET = 0xCBF29CE484222325
FNV_PRIME = 0x100000001B3
FNV_MASK = 0xFFFFFFFFFFFFFFFF

# Static source constant recorded by MAP3 from Racification.fx. It is a shader
# colour, not an albedo and not a decoded pixel.
RACIFICATION_COLOUR = [1.0, 1.0, 0.7, 1.0]

BINDABLE = "bindable-static-albedo"
EFFECT = "blocked-effect-not-static-albedo"
DECODER = "blocked-decoder-size-limit"
ALPHA = "blocked-alpha-rule-missing"
RUNTIME = "blocked-runtime-albedo-parameter"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False,
                               allow_nan=False) + "\n", encoding="utf-8")


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def file_record(path: Path, base: Path | None = None) -> dict:
    data = path.read_bytes()
    name = path.relative_to(base).as_posix() if base else rel(path)
    return {"path": name, "bytes": len(data), "sha256": sha256_bytes(data)}


def fnv1a64(data: bytes) -> int:
    value = FNV_OFFSET
    for byte in data:
        value ^= byte
        value = (value * FNV_PRIME) & FNV_MASK
    return value


def uv_range_hash(indices: np.ndarray, uv: np.ndarray, first: int, count: int) -> str:
    """FNV-1a 64 over referenced UV0 float32 bits, matching MAP3/P73a exactly."""
    digest = FNV_OFFSET
    for value in indices[first:first + count]:
        base = int(value) * 2
        for axis in (0, 1):
            for byte in struct.pack("<f", float(uv[base + axis])):
                digest ^= byte
                digest = (digest * FNV_PRIME) & FNV_MASK
    return "0x%016x" % digest


def expected_chain_bytes(width: int, height: int, levels: int) -> int:
    """RGBA8 byte count for the source mip chain (levels clamped to natural)."""
    natural = int(math.floor(math.log2(max(width, height)))) + 1
    total = 0
    for level in range(min(levels, natural)):
        total += max(1, width >> level) * max(1, height >> level) * 4
    return total


def dims_string(width: int, height: int) -> str:
    return "%dx%d" % (width, height)


def build(out: Path) -> dict:
    slice_doc = load_json(SLICE_DIR / "slice.json")
    bindings = load_json(BINDINGS)
    blockers = load_json(BLOCKERS)

    if slice_doc["level"] != LEVEL or bindings["level"] != LEVEL:
        raise SystemExit("unexpected level: %r / %r" % (slice_doc["level"], bindings["level"]))
    if blockers.get("level") != LEVEL:
        raise SystemExit("unexpected blockers level: %r" % blockers.get("level"))

    sections = {row["id"]: row for row in slice_doc["draws"]["sections"]}
    package_draws = slice_doc["draws"]["draws"]
    binding_draws = bindings["draws"]
    if len(package_draws) != len(binding_draws):
        raise SystemExit("slice/binding draw count differs: %d / %d"
                         % (len(package_draws), len(binding_draws)))
    if LEVEL == "usa_amboy" and len(package_draws) != 1606:
        raise SystemExit("expected 1,606 Amboy draws, got %d" % len(package_draws))

    # ---------------------------------------------------------------- buffers
    pos_path = SLICE_DIR / "draws.positions.f32.bin"
    uv_path = SLICE_DIR / "draws.uv0.f32.bin"
    idx_path = SLICE_DIR / "draws.indices.u32.bin"
    pos_bytes = pos_path.read_bytes()
    uv_bytes = uv_path.read_bytes()
    idx_bytes = idx_path.read_bytes()
    positions = np.frombuffer(pos_bytes, dtype="<f4")
    uv0 = np.frombuffer(uv_bytes, dtype="<f4")
    indices = np.frombuffer(idx_bytes, dtype="<u4")
    vertex_count = int(positions.size // 3)
    uv_vertex_count = int(uv0.size // 2)
    index_count = int(indices.size)
    if vertex_count != uv_vertex_count:
        raise SystemExit("position/UV vertex count differs: %d / %d"
                         % (vertex_count, uv_vertex_count))
    if LEVEL == "usa_amboy" and (vertex_count != 529624 or
                                 index_count != 1046844 or
                                 index_count // 3 != 348948):
        raise SystemExit("unexpected Amboy buffer sizes: %d verts / %d idx"
                         % (vertex_count, index_count))

    out.mkdir(parents=True, exist_ok=True)
    texture_out = out / "textures"
    texture_out.mkdir(parents=True, exist_ok=True)
    for stale in texture_out.glob("*.rgba"):
        stale.unlink()
    (out / "draws.positions.f32.bin").write_bytes(pos_bytes)
    (out / "draws.uv0.f32.bin").write_bytes(uv_bytes)
    (out / "draws.indices.u32.bin").write_bytes(idx_bytes)

    # ----------------------------------------------------------------- layout
    layout_src = slice_doc["layout"]
    points = np.asarray(layout_src["points"], dtype="<f4")
    layout_bytes = points.tobytes(order="C")
    (out / "layout.points.f32.bin").write_bytes(layout_bytes)
    if len(layout_bytes) != layout_src["pointCount"] * 12:
        raise SystemExit("layout byte count differs from pointCount")
    if sha256_bytes(layout_bytes) != layout_src["pointsSha256"]:
        raise SystemExit("layout points hash differs from slice manifest")

    # -------------------------------------------------- bindings / draw join
    bindable_ids = set()
    status_counts = {BINDABLE: 0, EFFECT: 0, DECODER: 0, ALPHA: 0, RUNTIME: 0}
    status_triangles = {key: 0 for key in status_counts}
    rows = []
    for package_draw, binding_draw in zip(package_draws, binding_draws):
        if (package_draw["sectionId"], package_draw["sectionDrawIndex"]) != \
                (binding_draw["section"], binding_draw["drawIndex"]):
            raise SystemExit("slice/binding draw order mismatch at %r"
                             % (package_draw["sectionId"], package_draw["sectionDrawIndex"]))
        section = sections[package_draw["sectionId"]]
        global_first = section["indexOffset"] + binding_draw["firstIndex"]
        if package_draw["firstIndex"] != global_first:
            raise SystemExit("global firstIndex mismatch for %s#%d"
                             % (binding_draw["section"], binding_draw["drawIndex"]))
        if package_draw["indexCount"] != binding_draw["indexCount"]:
            raise SystemExit("indexCount mismatch for %s#%d"
                             % (binding_draw["section"], binding_draw["drawIndex"]))
        status = binding_draw["status"]
        if status not in status_counts:
            raise SystemExit("unknown status: %r" % status)
        status_counts[status] += 1
        status_triangles[status] += binding_draw["triangleCount"]
        rows.append((package_draw, binding_draw, section, global_first))

    if sum(status_counts.values()) != len(rows):
        raise SystemExit("status split does not cover every draw: %r" % status_counts)
    if LEVEL == "usa_amboy" and (
            status_counts[BINDABLE] != 1201 or status_counts[EFFECT] != 334 or
            status_counts[DECODER] != 50 or status_counts[ALPHA] != 17 or
            status_counts[RUNTIME] != 4 or status_triangles[BINDABLE] != 269300):
        raise SystemExit("unexpected Amboy status split: %r" % status_counts)

    # -------------------------------------------------------- texture sources
    texture_by_id = {row["id"]: row for row in bindings["textures"]}
    for raw_draw in binding_draws:
        if raw_draw["status"] == BINDABLE:
            texture_id = raw_draw["textureId"]
            if not texture_id:
                raise SystemExit("bindable draw without textureId: %r" % raw_draw["section"])
            bindable_ids.add(texture_id)
            if texture_id not in texture_by_id:
                raise SystemExit("bindable texture missing from manifest: %r" % texture_id)

    if LEVEL == "usa_amboy" and len(bindable_ids) != 186:
        raise SystemExit("expected 186 bindable texture sources, got %d" % len(bindable_ids))

    # Group by decoded RGBA hash and merge identical sources.
    groups: dict[str, list[str]] = {}
    for texture_id in sorted(bindable_ids):
        texture = texture_by_id[texture_id]
        if not texture.get("rgbaSha256") or not texture.get("rgbaBytes"):
            raise SystemExit("bindable texture has no decoded RGBA: %r" % texture_id)
        rgba_path = RGBA_DIR / (texture_id + ".rgba")
        if not rgba_path.is_file():
            raise SystemExit("decoded RGBA file missing: %r" % rgba_path)
        groups.setdefault(texture["rgbaSha256"], []).append(texture_id)

    slot_for_id: dict[str, int] = {}
    texture_items = []
    merged_groups = []
    referenced_mip0 = 0
    unique_mip0 = 0
    referenced_chain = 0
    unique_chain = 0
    for slot, (rgba_sha, ids) in enumerate(
            sorted(groups.items(), key=lambda item: item[1][0])):
        primary = ids[0]
        texture = texture_by_id[primary]
        src_rgba = RGBA_DIR / (primary + ".rgba")
        data = src_rgba.read_bytes()
        if len(data) != texture["rgbaBytes"]:
            raise SystemExit("RGBA byte count mismatch for %r" % primary)
        if sha256_bytes(data) != rgba_sha:
            raise SystemExit("RGBA hash mismatch for %r" % primary)
        if len(data) != texture["width"] * texture["height"] * 4:
            raise SystemExit("RGBA length is not width*height*4 for %r" % primary)
        if not all(texture_by_id[i]["rgbaSha256"] == rgba_sha for i in ids):
            raise SystemExit("merged texture group has differing hashes")

        slot_name = "tex-%03d.rgba" % slot
        (texture_out / slot_name).write_bytes(data)
        chain_bytes = expected_chain_bytes(texture["width"], texture["height"],
                                           texture["levels"])
        for texture_id in ids:
            slot_for_id[texture_id] = slot
            other = texture_by_id[texture_id]
            referenced_mip0 += other["width"] * other["height"] * 4
            referenced_chain += expected_chain_bytes(other["width"], other["height"],
                                                      other["levels"])
        unique_mip0 += len(data)
        unique_chain += chain_bytes

        draws = [row for row in rows if row[1]["status"] == BINDABLE and
                 row[1]["textureId"] in ids]
        sections_used = sorted({row[1]["section"] for row in draws})
        texture_items.append({
            "slot": slot,
            "file": "textures/" + slot_name,
            "bytes": len(data),
            "sha256": rgba_sha,
            "fnv1a64": "0x%016x" % fnv1a64(data),
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
            "sourceBlob": {
                "path": rel(ROOT / texture["blobPath"]) if texture.get("blobPath") else None,
                "bytes": texture.get("blobBytes"),
                "sha256": texture.get("blobSha256"),
            },
            "sourceRgba": file_record(src_rgba),
            "drawCount": len(draws),
            "triangleCount": sum(row[1]["triangleCount"] for row in draws),
            "sections": sections_used,
            "srgbHint": {
                "colourSpace": "srgb",
                "applied": False,
                "reason": "diffuse _diff albedo hint; no colour-space conversion applied",
            },
            "mipHint": {
                "sourceLevels": texture["levels"],
                "decodedLevels": 1,
                "generateMips": True,
                "expectedChainBytes": chain_bytes,
                "applied": False,
                "reason": "only mip0 is decoded; the renderer may generate the chain",
            },
            "upload": {
                "format": "rgba8unorm",
                "srgbVariant": "rgba8unorm-srgb",
                "bytesMip0": len(data),
            },
        })
        if len(ids) > 1:
            merged_groups.append({"sha256": rgba_sha, "primaryId": primary,
                                  "sourceIds": ids})

    if LEVEL == "usa_amboy" and (
            len(texture_items) != 179 or len(merged_groups) != 7 or
            referenced_mip0 != 2672704 or unique_mip0 != 2654272 or
            referenced_chain != 3564368 or unique_chain != 3539772):
        raise SystemExit("unexpected Amboy texture merge result: %d blobs / %d "
                         "groups / %d referenced mip0"
                         % (len(texture_items), len(merged_groups), referenced_mip0))

    # ------------------------------------------------------------- bindable
    bindable_draws = []
    bindable_index_count = 0
    referenced_vertices = set()
    for package_draw, binding_draw, section, global_first in rows:
        if binding_draw["status"] != BINDABLE:
            continue
        range_indices = indices[global_first:global_first + binding_draw["indexCount"]]
        if range_indices.size == 0:
            raise SystemExit("empty bindable draw range")
        local_min = int(range_indices.min()) - section["vertexOffset"]
        local_max = int(range_indices.max()) - section["vertexOffset"]
        if local_min < 0 or local_max >= section["vertexCount"]:
            raise SystemExit("draw vertex range outside section")
        digest = uv_range_hash(indices, uv0, global_first, binding_draw["indexCount"])
        if digest != binding_draw["uvHash"]:
            raise SystemExit("UV hash mismatch vs MAP3 for %s#%d: %s != %s"
                             % (binding_draw["section"], binding_draw["drawIndex"],
                                digest, binding_draw["uvHash"]))
        texture_id = binding_draw["textureId"]
        texture = texture_by_id[texture_id]
        material = binding_draw.get("material") or {}
        bindable_draws.append({
            "drawId": "%s#%d" % (binding_draw["section"], binding_draw["drawIndex"]),
            "section": binding_draw["section"],
            "sectionDrawIndex": binding_draw["drawIndex"],
            "primitiveIndex": binding_draw["primitiveIndex"],
            "firstIndex": global_first,
            "indexCount": binding_draw["indexCount"],
            "triangleCount": binding_draw["triangleCount"],
            "firstVertex": section["vertexOffset"] + local_min,
            "lastVertex": section["vertexOffset"] + local_max,
            "textureId": texture_id,
            "textureSlot": slot_for_id[texture_id],
            "textureName": texture["name"],
            "textureFormat": texture["formatName"],
            "effect": binding_draw["effect"],
            "material": material.get("material"),
            "materialRow": material.get("row"),
            "uvHash": digest,
            "uvHashSource": "recomputed-from-merged-uv0-buffer",
            "status": BINDABLE,
        })
        bindable_index_count += binding_draw["indexCount"]
        referenced_vertices.update(int(value) for value in range_indices)

    if LEVEL == "usa_amboy" and len(bindable_draws) != 1201:
        raise SystemExit("expected 1,201 Amboy bindable draws, got %d"
                         % len(bindable_draws))

    # ------------------------------------------------------------ diagnostics
    diagnostic_draws = []
    effect_draws = []
    decoder_draws = []
    alpha_draws = []
    runtime_draws = []
    diagnostic_triangles = {EFFECT: 0, DECODER: 0, ALPHA: 0, RUNTIME: 0}
    for package_draw, binding_draw, section, global_first in rows:
        status = binding_draw["status"]
        if status == BINDABLE:
            continue
        diagnostic_triangles[status] += binding_draw["triangleCount"]
        digest = uv_range_hash(indices, uv0, global_first, binding_draw["indexCount"])
        if digest != binding_draw["uvHash"]:
            raise SystemExit("diagnostic UV hash mismatch for %s#%d"
                             % (binding_draw["section"], binding_draw["drawIndex"]))
        diagnostic = {
            "pass": "diagnostic-only",
            "albedoUsed": False,
            "textureBound": False,
            "fallback": "none",
            "fallbackNote": "no fallback texture or colour is invented for this draw",
        }
        texture_id = binding_draw.get("textureId")
        aux = binding_draw.get("auxTexture")
        if status == EFFECT:
            is_racification = binding_draw["effect"].startswith("Racification")
            diagnostic = {
                "pass": "effect-additive-decal",
                "albedoUsed": False,
                "textureBound": False,
                "opaqueAlbedo": False,
                "separatePass": "effect-additive-decal",
                "auxTexture": {
                    "parameter": aux.get("parameter") if aux else None,
                    "textureId": ("%s.albedo.%d.%d" % (PREFIX, aux["block"], aux["index"]))
                    if aux and aux.get("block", -1) >= 0 else
                    ("%s.shared.%d" % (PREFIX, aux["index"])) if aux else None,
                    "name": aux.get("name") if aux else None,
                    "kind": aux.get("kind") if aux else None,
                    "formatName": aux.get("formatName") if aux else None,
                    "width": aux.get("width") if aux else None,
                    "height": aux.get("height") if aux else None,
                },
                "colourConstant": RACIFICATION_COLOUR if is_racification else None,
                "colourConstantSource": (
                    "Racification.fx g_vColour (static shader constant)"
                    if is_racification else None),
                "reason": binding_draw["blocker"],
                "note": ("shader exposes g_tTexture with additive/alpha-tested blend; "
                         "binding it as opaque albedo would be a semantic error"),
            }
            effect_draws.append(binding_draw)
        elif status == DECODER:
            texture = texture_by_id.get(texture_id) if texture_id else None
            diagnostic = {
                "pass": "diagnostic-only",
                "albedoUsed": False,
                "textureBound": False,
                "fallback": "none",
                "blocker": "decoder-size-limit",
                "decoderLimitPx": 512,
                "sourceTextureId": texture_id,
                "sourceWidth": texture["width"] if texture else None,
                "sourceHeight": texture["height"] if texture else None,
                "sourceFormat": texture["formatName"] if texture else None,
                "decodedInMAP3": False,
                "reason": binding_draw["blocker"],
            }
            decoder_draws.append(binding_draw)
        elif status == ALPHA:
            texture = texture_by_id.get(texture_id) if texture_id else None
            diagnostic = {
                "pass": "diagnostic-only",
                "albedoUsed": False,
                "textureBound": False,
                "fallback": "none",
                "blocker": "alpha-rule-missing",
                "sourceTextureId": texture_id,
                "sourceFormat": texture["formatName"] if texture else None,
                "alpha": texture.get("alpha") if texture else None,
                "decodedInMAP3": True,
                "reason": binding_draw["blocker"],
            }
            alpha_draws.append(binding_draw)
        elif status == RUNTIME:
            diagnostic = {
                "pass": "diagnostic-only",
                "albedoUsed": False,
                "textureBound": False,
                "fallback": "none",
                "blocker": "runtime-albedo-parameter",
                "sourceTextureId": None,
                "materialRow": (binding_draw.get("material") or {}).get("row"),
                "reason": binding_draw["blocker"],
            }
            runtime_draws.append(binding_draw)
        diagnostic_draws.append({
            "drawId": "%s#%d" % (binding_draw["section"], binding_draw["drawIndex"]),
            "section": binding_draw["section"],
            "sectionDrawIndex": binding_draw["drawIndex"],
            "primitiveIndex": binding_draw["primitiveIndex"],
            "firstIndex": global_first,
            "indexCount": binding_draw["indexCount"],
            "triangleCount": binding_draw["triangleCount"],
            "textureId": texture_id,
            "textureName": binding_draw.get("textureName"),
            "effect": binding_draw["effect"],
            "status": status,
            "uvHash": digest,
            "diagnostic": diagnostic,
        })

    if LEVEL == "usa_amboy" and (
            len(diagnostic_draws) != 405 or len(effect_draws) != 334 or
            len(decoder_draws) != 50 or len(alpha_draws) != 17 or
            len(runtime_draws) != 4):
        raise SystemExit("unexpected Amboy diagnostic split: %d/%d/%d/%d/%d"
                         % (len(diagnostic_draws), len(effect_draws),
                            len(decoder_draws), len(alpha_draws), len(runtime_draws)))

    effect_ranges = [{"drawId": d["drawId"], "firstIndex": d["firstIndex"],
                      "indexCount": d["indexCount"]}
                     for d in diagnostic_draws if d["status"] == EFFECT]
    effect_names = sorted({d["effect"] for d in effect_draws})
    if effect_names and all(name.startswith("Racification") for name in effect_names):
        effect_note = ("%d Racification/RacificationDLayer draws form a separate "
                       "additive, alpha-tested decal layer. They are not opaque "
                       "albedo and are not part of the %s-draw opaque list."
                       % (len(effect_draws), format(len(bindable_draws), ",")))
    else:
        effect_note = ("%d effect-layer draws (%s) form a separate additive/"
                       "alpha-tested layer. They are not opaque albedo and are not "
                       "part of the %s-draw opaque list."
                       % (len(effect_draws), ", ".join(effect_names) or "none",
                          format(len(bindable_draws), ",")))
    diagnostics_doc = {
        "schema": DIAG_SCHEMA,
        "kind": "map-slice-render-diagnostics",
        "level": LEVEL,
        "scope": {
            "dataOnly": True,
            "rendererChanged": False,
            "gpuUploaded": False,
            "browserFrameProduced": False,
            "playableClaim": False,
            "texturesBound": False,
            "fallbackTextureInvented": False,
        },
        "counts": {
            "blockedDraws": len(diagnostic_draws),
            "blockedTriangles": sum(diagnostic_triangles.values()),
            "byStatus": {
                EFFECT: len(effect_draws),
                DECODER: len(decoder_draws),
                ALPHA: len(alpha_draws),
                RUNTIME: len(runtime_draws),
            },
            "trianglesByStatus": diagnostic_triangles,
        },
        "groups": {
            "effectDecal": {
                "status": EFFECT,
                "draws": len(effect_draws),
                "triangles": diagnostic_triangles[EFFECT],
                "pass": "effect-additive-decal",
                "opaqueAlbedo": False,
                "textureBound": False,
                "separateAdditiveDecalList": True,
                "indexRanges": effect_ranges,
                "note": effect_note,
            },
            "decoderSize": {
                "status": DECODER,
                "draws": len(decoder_draws),
                "triangles": diagnostic_triangles[DECODER],
                "pass": "diagnostic-only",
                "textureBound": False,
                "note": "source exceeds the committed 512x512 decoder bound; no image emitted",
            },
            "alphaRule": {
                "status": ALPHA,
                "draws": len(alpha_draws),
                "triangles": diagnostic_triangles[ALPHA],
                "pass": "diagnostic-only",
                "textureBound": False,
                "note": "BC3 source is non-opaque; no alpha-test/blend rule declared",
            },
            "runtimeAlbedo": {
                "status": RUNTIME,
                "draws": len(runtime_draws),
                "triangles": diagnostic_triangles[RUNTIME],
                "pass": "diagnostic-only",
                "textureBound": False,
                "note": "g_tAlbedo is a runtime DATA_INDEX parameter; no static image",
            },
        },
        "draws": diagnostic_draws,
        "limits": [
            "No fallback texture or fallback colour is invented for any blocked draw.",
            "The additive-decal ranges index the same uploaded geometry/index buffers; "
            "no decal index buffer is emitted in v1.",
            "No shader, blend, alpha-test, sampler or GPU state is applied.",
        ],
    }

    write_json(out / "diagnostics.json", diagnostics_doc)

    # ------------------------------------------- layout float32 measurements
    # The slice points are packed to float32 because that is the declared binary
    # format. Over 8,673 segments the quantisation shifts the cumulative length
    # by a few millimetres, so the exact float32 readings are recorded instead
    # of pretending they equal the JSON-precision source values.
    step = np.diff(points[:, :2], axis=0)
    cumulative = np.concatenate(([0.0], np.cumsum(np.hypot(step[:, 0], step[:, 1]))))
    float32_length = float(cumulative[-1])
    # Amboy's committed render manifest measured the heading on the first
    # float32 segment; keep that byte-identical. Gracia's candidate heading is
    # the first-2 m tangent, so use the 8th 0.25 m point.
    heading_index = 1 if LEVEL == "usa_amboy" else min(8, len(points) - 1)
    heading_f32 = math.atan2(float(points[heading_index, 0] - points[0, 0]),
                             float(points[heading_index, 1] - points[0, 1]))
    heading_error_f32 = abs(math.atan2(
        math.sin(heading_f32 - layout_src["spawn"]["heading"]),
        math.cos(heading_f32 - layout_src["spawn"]["heading"])))
    float32_checkpoints = []
    for checkpoint in layout_src["checkpoints"]:
        distances = np.hypot(points[:, 0] - checkpoint["x"],
                             points[:, 1] - checkpoint["z"])
        best = int(np.argmin(distances))
        float32_checkpoints.append({
            "index": checkpoint["index"],
            "pointIndex": best,
            "distanceM": float(cumulative[best]),
            "nearestPointDeltaM": float(distances[best]),
        })
    layout_float32 = {
        "lengthM": float32_length,
        "lengthErrorVsSourceM": float32_length - layout_src["lengthM"],
        "spawnHeadingRad": heading_f32,
        "spawnHeadingErrorVsSourceRad": heading_error_f32,
        "checkpoints": float32_checkpoints,
        "finishDistanceM": float(cumulative[-1]),
    }

    # --------------------------------------------------------------- manifest
    distinct_dimensions = sorted({dims_string(item["width"], item["height"])
                                  for item in texture_items})
    sections_with_bindable = sorted({row["section"] for row in bindable_draws})
    instance_sections = [s for s in slice_doc["draws"]["sections"]
                         if s.get("instanceDescriptionsSkipped")]
    instance_descriptions = slice_doc["draws"].get("instanceDescriptionsSkipped", 0)
    unsupported_count = len(slice_doc["draws"]["unsupportedSections"])
    if LEVEL == "usa_amboy":
        integration_gaps = [
            "e1-drive still builds its packet from River; a ?map=amboy packet "
            "producer is not part of this package.",
            "No GPU upload, shader, blend, alpha-test, sampler or sRGB conversion "
            "is implemented or claimed.",
            "The 405 blocked draws are diagnostic only: 334 are a separate "
            "additive decal layer (not opaque albedo), 50 exceed the decoder "
            "bound, 17 need an alpha rule and 4 are runtime parameters.",
            "No vertex normals are available; shading needs a reader change or a "
            "documented geometric-normal fallback.",
            "instancesApplied:false: 366 instance descriptions and 27 unsupported "
            "billboard sections remain geometry blockers.",
            "No collision/simple-shape copy is emitted here; the slice package "
            "and Level.levelphysics remain the physics inputs.",
        ]
    else:
        integration_gaps = [
            "e1-drive still builds its packet from River; a ?map=%s packet "
            "producer is not part of this package." % PREFIX,
            "No GPU upload, shader, blend, alpha-test, sampler or sRGB conversion "
            "is implemented or claimed.",
            "The %d blocked draws are diagnostic only: %d are a separate additive "
            "decal layer (not opaque albedo), %d exceed the decoder bound, %d need "
            "an alpha rule and %d are runtime parameters."
            % (len(diagnostic_draws), len(effect_draws), len(decoder_draws),
               len(alpha_draws), len(runtime_draws)),
            "No vertex normals are available; shading needs a reader change or a "
            "documented geometric-normal fallback.",
            "instancesApplied:false: %d instance descriptions in %d supported "
            "sections and %d unsupported sections remain geometry blockers."
            % (instance_descriptions, len(instance_sections), unsupported_count),
            "No collision/simple-shape copy is emitted here; the slice package "
            "and Level.levelphysics remain the physics inputs.",
        ]
    manifest_body = {
        "schema": SCHEMA,
        "kind": "map-slice-render-package",
        "level": LEVEL,
        "units": {
            "position": "metres, left-handed level space (x, y, z)",
            "uv0": "normalised texture coordinates (u, v)",
            "index": "uint32 global vertex index",
            "heading": "radians",
        },
        "scope": {
            "dataOnly": True,
            "rendererChanged": False,
            "e1DriveIntegrated": False,
            "gpuUploaded": False,
            "browserFrameProduced": False,
            "playableClaim": False,
            "texturesBoundInGpu": False,
            "srgbApplied": False,
            "mipsGenerated": False,
            "instancesApplied": False,
            "normalsIncluded": False,
            "partialSceneTraversal": True,
            "coordinateSpace": "source level coordinates, unchanged",
        },
        "source": {
            "slice": {**file_record(SLICE_DIR / "slice.json"),
                      "contentSha256": slice_doc["hashes"]["contentSha256"]},
            "bindings": file_record(BINDINGS),
            "blockers": file_record(BLOCKERS),
            "slicePayloads": {
                "positions": file_record(pos_path),
                "uv0": file_record(uv_path),
                "indices": file_record(idx_path),
                "layoutPointsSha256": layout_src["pointsSha256"],
            },
        },
        "counts": {
            "sections": len(sections),
            "sectionsWithBindableDraws": len(sections_with_bindable),
            "draws": len(bindable_draws) + len(diagnostic_draws),
            "bindableDraws": len(bindable_draws),
            "blockedDraws": len(diagnostic_draws),
            "bindableTriangles": status_triangles[BINDABLE],
            "blockedTriangles": sum(diagnostic_triangles.values()),
            "vertexCount": vertex_count,
            "indexCount": index_count,
            "triangleCount": index_count // 3,
            "bindableIndexCount": bindable_index_count,
            "bindableVerticesReferenced": len(referenced_vertices),
            "textureSources": len(bindable_ids),
            "uniqueTextureBlobs": len(texture_items),
            "mergedTextureSources": len(bindable_ids) - len(texture_items),
            "distinctTextureDimensions": len(distinct_dimensions),
            "statuses": {
                BINDABLE: len(bindable_draws),
                EFFECT: len(effect_draws),
                DECODER: len(decoder_draws),
                ALPHA: len(alpha_draws),
                RUNTIME: len(runtime_draws),
            },
        },
        "buffers": {
            "positions": {
                **file_record(out / "draws.positions.f32.bin", out),
                "dtype": "float32",
                "components": 3,
                "count": vertex_count,
                "stride": 12,
                "role": "merged section vertex positions, shared by every draw list",
            },
            "uv0": {
                **file_record(out / "draws.uv0.f32.bin", out),
                "dtype": "float32",
                "components": 2,
                "count": vertex_count,
                "stride": 8,
                "role": "merged section UV0, vertex-aligned with positions",
            },
            "indices": {
                **file_record(out / "draws.indices.u32.bin", out),
                "dtype": "uint32",
                "count": index_count,
                "role": "one global triangle index buffer; draw ranges include blocked draws",
            },
        },
        "textures": {
            "table": "items",
            "bindableSources": len(bindable_ids),
            "uniqueBlobs": len(texture_items),
            "mergedGroups": merged_groups,
            "bytes": {
                "referencedMip0": referenced_mip0,
                "uniqueMip0": unique_mip0,
                "savedByMergeMip0": referenced_mip0 - unique_mip0,
                "referencedExpectedChain": referenced_chain,
                "uniqueExpectedChain": unique_chain,
                "savedByMergeChain": referenced_chain - unique_chain,
            },
            "distinctDimensions": distinct_dimensions,
            "uploadFormat": "rgba8unorm",
            "srgbHint": "rgba8unorm-srgb",
            "mipPolicy": "mip0-only decoded; renderer may generate the recorded source level chain",
            "items": texture_items,
        },
        "draws": bindable_draws,
        "diagnostics": {
            "file": "diagnostics.json",
            **file_record(out / "diagnostics.json", out),
            "schema": DIAG_SCHEMA,
            "blockedDraws": len(diagnostic_draws),
            "blockedTriangles": sum(diagnostic_triangles.values()),
            "effectDecalDraws": len(effect_draws),
            "effectDecalTriangles": diagnostic_triangles[EFFECT],
            "decoderSizeDraws": len(decoder_draws),
            "alphaRuleDraws": len(alpha_draws),
            "runtimeAlbedoDraws": len(runtime_draws),
            "fallbackTextureInvented": False,
        },
        "layout": {
            **{key: layout_src[key] for key in
               ("schema", "mode", "direction", "level", "spawn", "checkpoints",
                "finish", "lengthM", "pointCount", "sampleStepM", "pointsFormat",
                "verification", "source")},
            "pointsFile": "layout.points.f32.bin",
            "pointsBytes": len(layout_bytes),
            "pointsSha256": sha256_bytes(layout_bytes),
            "sourceSlicePointsSha256": layout_src["pointsSha256"],
            "pointsFloat32": layout_float32,
        },
        "uploadContract": {
            "version": 1,
            "geometry": {
                "positionBuffer": "draws.positions.f32.bin",
                "positionFormat": "float32x3",
                "uv0Buffer": "draws.uv0.f32.bin",
                "uv0Format": "float32x2",
                "indexBuffer": "draws.indices.u32.bin",
                "indexFormat": "uint32",
                "vertexCount": vertex_count,
                "indexCount": index_count,
                "vertexBuffers": 2,
                "indexBuffers": 1,
                "uploadOnce": True,
                "drawList": "render.json#draws",
                "blockedDrawList": "diagnostics.json#draws",
                "note": "all draw lists index the same three buffers",
            },
            "textures": {
                "table": "render.json#textures.items",
                "selectBy": "draw.textureSlot",
                "uploadFormat": "rgba8unorm",
                "srgbVariant": "rgba8unorm-srgb",
                "srgbApplied": False,
                "mipPolicy": "upload mip0; generate the source-level chain at upload if desired",
                "bindStrategy": "per-texture bind groups; dimensions differ, no array/atlas packing was performed",
                "uniqueBlobs": len(texture_items),
                "distinctDimensions": len(distinct_dimensions),
            },
            "passes": {
                "opaqueAlbedo": {"drawList": "render.json#draws",
                                 "draws": len(bindable_draws)},
                "effectAdditiveDecal": {
                    "drawList": "diagnostics.json#groups.effectDecal.indexRanges",
                    "draws": len(effect_draws),
                    "opaqueAlbedo": False,
                },
                "diagnosticOnly": {"drawList": "diagnostics.json#draws",
                                   "draws": len(diagnostic_draws) - len(effect_draws)},
            },
            "sampler": "raw sampler state is recorded per texture; not applied",
            "normals": "not included by the committed direct-draw reader",
            "instances": "not applied",
        },
        "integrationGaps": integration_gaps,
        "limits": [
            "Data only: no renderer, GPU, browser, playable-game or full-game claim.",
            "The three geometry buffers are byte-identical to the MAP2 slice "
            "buffers; no vertex was reordered or removed.",
            "Blocked draw ranges remain in the shared index buffer but are listed "
            "separately and never assigned an opaque albedo.",
            "Textures are the committed CPU BC decode of mip0 only; alpha, blend, "
            "shader stages, sampler wrap/filter, mips and sRGB are not applied.",
            "No fallback texture was invented.",
        ],
    }

    files = {}
    for path in sorted(out.rglob("*")):
        if not path.is_file():
            continue
        name = path.relative_to(out).as_posix()
        if name in ("render.json", "verify.json"):
            continue
        files[name] = {"bytes": path.stat().st_size, "sha256": sha256_file(path)}
    manifest = dict(manifest_body)
    manifest["hashes"] = {
        "algorithm": "sha256",
        "contentSha256": sha256_bytes(canonical(manifest_body)),
        "files": files,
    }
    write_json(out / "render.json", manifest)
    return manifest


def main() -> int:
    global LEVEL, SLICE_DIR, TEXTURE_DIR, BINDINGS, BLOCKERS, RGBA_DIR, PREFIX
    global SCHEMA, DIAG_SCHEMA
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--level", default=LEVEL)
    parser.add_argument("--package", type=Path, default=None,
                        help="slice package directory")
    parser.add_argument("--texture-dir", type=Path, default=None)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    LEVEL = args.level
    PREFIX = short_name(LEVEL)
    SLICE_DIR = (args.package or package_dir(LEVEL)).resolve()
    TEXTURE_DIR = (args.texture_dir or texture_dir(LEVEL)).resolve()
    BINDINGS = TEXTURE_DIR / "bindings.json"
    BLOCKERS = TEXTURE_DIR / "blockers.json"
    RGBA_DIR = TEXTURE_DIR / "textures"
    SCHEMA = ("blur.map-slice.amboy-render/1" if LEVEL == "usa_amboy"
              else "blur.map-slice.render/1")
    DIAG_SCHEMA = ("blur.map-slice.amboy-render-diagnostics/1"
                   if LEVEL == "usa_amboy"
                   else "blur.map-slice.render-diagnostics/1")
    out = Path(args.out) if args.out else render_dir(LEVEL)
    manifest = build(out)
    print(json.dumps({
        "output": rel(out),
        "manifest": file_record(out / "render.json"),
        "contentSha256": manifest["hashes"]["contentSha256"],
        "draws": manifest["counts"]["bindableDraws"],
        "blockedDraws": manifest["counts"]["blockedDraws"],
        "textureSources": manifest["counts"]["textureSources"],
        "uniqueTextureBlobs": manifest["counts"]["uniqueTextureBlobs"],
        "textureBytes": manifest["textures"]["bytes"],
        "layoutPoints": manifest["layout"]["pointCount"],
        "files": len(manifest["hashes"]["files"]),
    }, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
