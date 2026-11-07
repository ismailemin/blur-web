#!/usr/bin/env python3
"""Independent verifier for the render-ready ``usa_amboy`` package.

Re-reads the package and the original MAP2/MAP3 inputs, then recomputes:

  * every geometry buffer, index range and UV0 hash (1,201 bindable draws);
  * the 1,201 bindable / 405 blocked split and the 334-draw additive-decal list;
  * 186 texture sources merged into 179 RGBA mip0 blobs, with file hashes,
    dimensions, alpha and expected mip-chain byte counts;
  * layout point hash, spawn, checkpoints, finish, path length and heading;
  * two fresh builds byte-identical to the package.

Writes ``verify.json`` into the package. Exits non-zero on any failure. Data
only: no GPU, browser or renderer claim.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
TOOL = Path(__file__).resolve().parent / "build_amboy_render.py"

BINDABLE = "bindable-static-albedo"
EFFECT = "blocked-effect-not-static-albedo"
DECODER = "blocked-decoder-size-limit"
ALPHA = "blocked-alpha-rule-missing"
RUNTIME = "blocked-runtime-albedo-parameter"
NO_ALBEDO = "blocked-no-static-albedo"
FNV_OFFSET = 0xCBF29CE484222325
FNV_PRIME = 0x100000001B3
FNV_MASK = 0xFFFFFFFFFFFFFFFF


class Checker:
    def __init__(self) -> None:
        self.count = 0
        self.errors = []

    def check(self, name: str, condition, detail=None) -> bool:
        self.count += 1
        ok = bool(condition)
        if not ok:
            self.errors.append({"check": name, "detail": None if detail is None else str(detail)[:600]})
        return ok


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def fnv1a64(data: bytes) -> int:
    value = FNV_OFFSET
    for byte in data:
        value ^= byte
        value = (value * FNV_PRIME) & FNV_MASK
    return value


def uv_range_hash(indices: np.ndarray, uv: np.ndarray, first: int, count: int) -> str:
    digest = FNV_OFFSET
    for value in indices[first:first + count]:
        base = int(value) * 2
        for axis in (0, 1):
            for byte in struct.pack("<f", float(uv[base + axis])):
                digest ^= byte
                digest = (digest * FNV_PRIME) & FNV_MASK
    return "0x%016x" % digest


def expected_chain_bytes(width: int, height: int, levels: int) -> int:
    natural = int(math.floor(math.log2(max(width, height)))) + 1
    return sum(max(1, width >> level) * max(1, height >> level) * 4
               for level in range(min(levels, natural)))


def bindable_texture_rows(bindings: dict) -> list[dict]:
    ids = {row["textureId"] for row in bindings["draws"]
           if row["status"] == BINDABLE and row.get("textureId")}
    return [row for row in bindings["textures"] if row["id"] in ids]


def trim_bindable_sources(bindings: dict) -> int:
    return len({row["textureId"] for row in bindings["draws"]
                if row["status"] == BINDABLE and row.get("textureId")})


def file_map(directory: Path, ignore=()) -> dict[str, bytes]:
    result = {}
    for path in sorted(directory.rglob("*")):
        if not path.is_file():
            continue
        name = path.relative_to(directory).as_posix()
        if name in ignore:
            continue
        result[name] = path.read_bytes()
    return result


def verify(package: Path, level: str | None = None) -> dict:
    c = Checker()
    render_path = package / "render.json"
    diag_path = package / "diagnostics.json"
    if not render_path.is_file() or not diag_path.is_file():
        raise SystemExit("package is missing render.json or diagnostics.json")

    manifest = load_json(render_path)
    diagnostics = load_json(diag_path)
    level = level or manifest.get("level")
    if level != manifest.get("level"):
        raise SystemExit("requested level %r != manifest level %r"
                         % (level, manifest.get("level")))
    SLICE_DIR = (ROOT / manifest["source"]["slice"]["path"]).parent
    BINDINGS = ROOT / manifest["source"]["bindings"]["path"]
    BLOCKERS = ROOT / manifest["source"]["blockers"]["path"]
    TEXTURE_DIR = BINDINGS.parent
    slice_doc = load_json(SLICE_DIR / "slice.json")
    bindings = load_json(BINDINGS)
    blockers = load_json(BLOCKERS)
    slide = slice_doc["draws"]
    status = bindings["counts"]["statuses"]
    expected_bindable = bindings["counts"]["bindableDraws"]
    expected_blocked = bindings["counts"]["blockedDraws"]
    expected_draws = slide["drawCount"]
    expected_bindable_tri = bindings["counts"]["bindableTriangles"]
    expected_blocked_tri = slice_doc["draws"]["triangleCount"] - expected_bindable_tri
    expected_effect = status.get(EFFECT, 0)
    expected_decoder = status.get(DECODER, 0)
    expected_alpha = status.get(ALPHA, 0)
    expected_runtime = status.get(RUNTIME, 0)
    expected_no_albedo = status.get(NO_ALBEDO, 0)
    bindable_rows = bindable_texture_rows(bindings)
    expected_sources = trim_bindable_sources(bindings)
    expected_unique_blobs = len({row["rgbaSha256"] for row in bindable_rows})
    expected_ref_mip0 = sum(row["width"] * row["height"] * 4
                            for row in bindable_rows)
    expected_ref_chain = sum(expected_chain_bytes(row["width"], row["height"],
                                                  row["levels"])
                             for row in bindable_rows)
    unique_rows = {}
    for row in bindable_rows:
        unique_rows.setdefault(row["rgbaSha256"], row)
    expected_unique_mip0 = sum(row["width"] * row["height"] * 4
                               for row in unique_rows.values())
    expected_unique_chain = sum(expected_chain_bytes(row["width"], row["height"],
                                                     row["levels"])
                                for row in unique_rows.values())

    # ------------------------------------------------------------- identity
    c.check("schema", manifest.get("schema") ==
            ("blur.map-slice.amboy-render/1" if level == "usa_amboy"
             else "blur.map-slice.render/1"))
    c.check("kind", manifest.get("kind") == "map-slice-render-package")
    c.check("level", manifest.get("level") == level)
    c.check("diagnostics.schema", diagnostics.get("schema") ==
            ("blur.map-slice.amboy-render-diagnostics/1" if level == "usa_amboy"
             else "blur.map-slice.render-diagnostics/1"))
    c.check("diagnostics.level", diagnostics.get("level") == level)
    for name in ("dataOnly", "rendererChanged", "e1DriveIntegrated", "gpuUploaded",
                 "browserFrameProduced", "playableClaim", "texturesBoundInGpu",
                 "srgbApplied", "mipsGenerated", "instancesApplied", "normalsIncluded"):
        expected = name in ("dataOnly",)
        c.check("scope." + name, manifest["scope"].get(name) is expected)
    c.check("scope.partialSceneTraversal", manifest["scope"].get("partialSceneTraversal") is True)
    c.check("scope.coordinateSpace", manifest["scope"].get("coordinateSpace") ==
            "source level coordinates, unchanged")
    for name in ("dataOnly", "texturesBound", "fallbackTextureInvented"):
        c.check("diagnostics.scope." + name,
                diagnostics["scope"].get(name) is (name == "dataOnly"))

    counts = manifest["counts"]
    c.check("counts.bindableDraws", counts.get("bindableDraws") == expected_bindable,
            counts.get("bindableDraws"))
    c.check("counts.blockedDraws", counts.get("blockedDraws") == expected_blocked)
    c.check("counts.draws", counts.get("draws") == expected_draws)
    c.check("counts.bindableTriangles",
            counts.get("bindableTriangles") == expected_bindable_tri)
    c.check("counts.blockedTriangles",
            counts.get("blockedTriangles") == expected_blocked_tri)
    c.check("counts.textureSources",
            counts.get("textureSources") ==
            trim_bindable_sources(bindings))
    c.check("counts.uniqueTextureBlobs",
            counts.get("uniqueTextureBlobs") ==
            len({texture["rgbaSha256"] for texture in bindable_texture_rows(bindings)}))
    c.check("counts.mergedTextureSources",
            counts.get("mergedTextureSources") ==
            trim_bindable_sources(bindings) -
            len({texture["rgbaSha256"] for texture in bindable_texture_rows(bindings)}))
    statuses = counts.get("statuses", {})
    c.check("counts.status.effect", statuses.get(EFFECT) == expected_effect)
    c.check("counts.status.decoder", statuses.get(DECODER) == expected_decoder)
    c.check("counts.status.alpha", statuses.get(ALPHA) == expected_alpha)
    c.check("counts.status.runtime", statuses.get(RUNTIME) == expected_runtime)
    c.check("counts.status.bindable", statuses.get(BINDABLE) == expected_bindable)
    if expected_no_albedo:
        c.check("counts.status.noAlbedo",
                statuses.get(NO_ALBEDO) == expected_no_albedo)

    diag_counts = diagnostics["counts"]
    c.check("diagnostics.counts.blocked",
            diag_counts.get("blockedDraws") == expected_blocked)
    c.check("diagnostics.counts.triangles",
            diag_counts.get("blockedTriangles") == expected_blocked_tri)
    c.check("diagnostics.counts.effect",
            diag_counts["byStatus"].get(EFFECT) == expected_effect)
    c.check("diagnostics.counts.decoder",
            diag_counts["byStatus"].get(DECODER) == expected_decoder)
    c.check("diagnostics.counts.alpha",
            diag_counts["byStatus"].get(ALPHA) == expected_alpha)
    c.check("diagnostics.counts.runtime",
            diag_counts["byStatus"].get(RUNTIME) == expected_runtime)
    if expected_no_albedo:
        c.check("diagnostics.counts.noAlbedo",
                diag_counts["byStatus"].get(NO_ALBEDO) == expected_no_albedo)
    c.check("diagnostics.fallbackNotInvented",
            diagnostics["scope"].get("fallbackTextureInvented") is False)
    c.check("manifest.fallbackNotInvented",
            manifest["diagnostics"].get("fallbackTextureInvented") is False)

    contract = manifest.get("uploadContract", {})
    c.check("upload.version", contract.get("version") == 1)
    c.check("upload.vertexBuffers", contract["geometry"].get("vertexBuffers") == 2)
    c.check("upload.indexBuffers", contract["geometry"].get("indexBuffers") == 1)
    c.check("upload.positionFormat", contract["geometry"].get("positionFormat") == "float32x3")
    c.check("upload.uv0Format", contract["geometry"].get("uv0Format") == "float32x2")
    c.check("upload.indexFormat", contract["geometry"].get("indexFormat") == "uint32")
    c.check("upload.uploadOnce", contract["geometry"].get("uploadOnce") is True)
    c.check("upload.texFormat", contract["textures"].get("uploadFormat") == "rgba8unorm")
    c.check("upload.srgbVariant", contract["textures"].get("srgbVariant") ==
            "rgba8unorm-srgb")
    c.check("upload.srgbNotApplied", contract["textures"].get("srgbApplied") is False)
    c.check("upload.opaqueDraws",
            contract["passes"]["opaqueAlbedo"].get("draws") == expected_bindable)
    c.check("upload.decalDraws",
            contract["passes"]["effectAdditiveDecal"].get("draws") == expected_effect)
    c.check("upload.decalNotOpaque",
            contract["passes"]["effectAdditiveDecal"].get("opaqueAlbedo") is False)
    c.check("upload.diagnosticDraws",
            contract["passes"]["diagnosticOnly"].get("draws") ==
            expected_blocked - expected_effect)
    c.check("upload.normalsAbsent", "not included" in contract.get("normals", ""))
    c.check("upload.instancesAbsent", "not applied" in contract.get("instances", ""))

    # ------------------------------------------------------------- sources
    source = manifest["source"]
    for key, path, record in (
            ("slice", SLICE_DIR / "slice.json", source["slice"]),
            ("bindings", BINDINGS, source["bindings"]),
            ("blockers", BLOCKERS, source["blockers"])):
        c.check("source.%s.path" % key, record.get("path") ==
                path.resolve().relative_to(ROOT).as_posix(), record.get("path"))
        c.check("source.%s.bytes" % key, record.get("bytes") == path.stat().st_size)
        c.check("source.%s.sha256" % key, record.get("sha256") == sha256_file(path))
    c.check("source.slice.contentSha256",
            source["slice"].get("contentSha256") == slice_doc["hashes"]["contentSha256"])
    for key, name in (("positions", "draws.positions.f32.bin"),
                      ("uv0", "draws.uv0.f32.bin"),
                      ("indices", "draws.indices.u32.bin")):
        path = SLICE_DIR / name
        record = source["slicePayloads"][key]
        c.check("source.payload.%s.path" % key, record.get("path") ==
                path.resolve().relative_to(ROOT).as_posix())
        c.check("source.payload.%s.bytes" % key, record.get("bytes") == path.stat().st_size)
        c.check("source.payload.%s.sha256" % key, record.get("sha256") == sha256_file(path))
    c.check("source.layout.sha256",
            source["slicePayloads"].get("layoutPointsSha256") ==
            slice_doc["layout"]["pointsSha256"])

    # ------------------------------------------------------------- buffers
    pos = (package / "draws.positions.f32.bin").read_bytes()
    uv_bytes = (package / "draws.uv0.f32.bin").read_bytes()
    idx_bytes = (package / "draws.indices.u32.bin").read_bytes()
    positions = np.frombuffer(pos, dtype="<f4")
    uv0 = np.frombuffer(uv_bytes, dtype="<f4")
    indices = np.frombuffer(idx_bytes, dtype="<u4")
    c.check("buffer.positions.equalSlice", pos == (SLICE_DIR / "draws.positions.f32.bin").read_bytes())
    c.check("buffer.uv0.equalSlice", uv_bytes == (SLICE_DIR / "draws.uv0.f32.bin").read_bytes())
    c.check("buffer.indices.equalSlice", idx_bytes == (SLICE_DIR / "draws.indices.u32.bin").read_bytes())
    for name, record in (("positions", manifest["buffers"]["positions"]),
                         ("uv0", manifest["buffers"]["uv0"]),
                         ("indices", manifest["buffers"]["indices"])):
        path = package / record["path"]
        c.check("buffer.%s.path" % name, path.is_file())
        c.check("buffer.%s.bytes" % name, record["bytes"] == path.stat().st_size)
        c.check("buffer.%s.sha256" % name, record["sha256"] == sha256_file(path))
        c.check("buffer.%s.inHashes" % name,
                manifest["hashes"]["files"].get(record["path"], {}).get("sha256") ==
                record["sha256"])
    expected_vertices = slide["vertexCount"]
    expected_indices = slide["triangleCount"] * 3
    c.check("buffer.vertexCount", positions.size == expected_vertices * 3)
    c.check("buffer.uvCount", uv0.size == expected_vertices * 2)
    c.check("buffer.indexCount", indices.size == expected_indices)
    c.check("buffer.triangles", indices.size // 3 == slide["triangleCount"])
    c.check("buffer.indexMax", int(indices.max()) < expected_vertices,
            int(indices.max()))
    c.check("buffer.positionFinite", bool(np.isfinite(positions).all()))
    c.check("buffer.uvFinite", bool(np.isfinite(uv0).all()))
    c.check("buffer.positions.stride", manifest["buffers"]["positions"].get("stride") == 12)
    c.check("buffer.uv0.stride", manifest["buffers"]["uv0"].get("stride") == 8)
    c.check("buffer.indices.role",
            "global triangle index" in manifest["buffers"]["indices"].get("role", ""))

    # --------------------------------------------------------------- join
    sections = {row["id"]: row for row in slice_doc["draws"]["sections"]}
    package_draws = slice_doc["draws"]["draws"]
    binding_draws = bindings["draws"]
    c.check("join.drawCount",
            len(package_draws) == expected_draws and
            len(binding_draws) == expected_draws)
    joined = {}
    for package_draw, binding_draw in zip(package_draws, binding_draws):
        key = (binding_draw["section"], binding_draw["drawIndex"])
        section = sections[binding_draw["section"]]
        c.check("join.%s#%d" % key,
                (package_draw["sectionId"], package_draw["sectionDrawIndex"]) == key and
                package_draw["firstIndex"] ==
                section["indexOffset"] + binding_draw["firstIndex"] and
                package_draw["indexCount"] == binding_draw["indexCount"])
        joined[key] = (package_draw, binding_draw)
    c.check("join.uniqueKeys", len(joined) == expected_draws)

    # ---------------------------------------------------------- bindable draws
    draws = manifest["draws"]
    by_id = {}
    for draw in draws:
        by_id[draw.get("drawId")] = draw
    c.check("draws.count", len(draws) == expected_bindable)
    c.check("draws.uniqueIds", len(by_id) == expected_bindable)

    uv_checked = 0
    for key, (package_draw, binding_draw) in joined.items():
        if binding_draw["status"] != BINDABLE:
            continue
        draw_id = "%s#%d" % key
        draw = by_id.get(draw_id)
        if not c.check("draw.%s.present" % draw_id, draw is not None):
            continue
        section = sections[binding_draw["section"]]
        global_first = section["indexOffset"] + binding_draw["firstIndex"]
        c.check("draw.%s.range" % draw_id,
                draw.get("firstIndex") == global_first and
                draw.get("indexCount") == binding_draw["indexCount"] and
                draw.get("section") == binding_draw["section"] and
                draw.get("sectionDrawIndex") == binding_draw["drawIndex"])
        c.check("draw.%s.triangleCount" % draw_id,
                draw.get("triangleCount") == binding_draw["triangleCount"] and
                draw.get("indexCount") == draw["triangleCount"] * 3)
        c.check("draw.%s.textureId" % draw_id,
                draw.get("textureId") == binding_draw["textureId"])
        digest = uv_range_hash(indices, uv0, global_first, binding_draw["indexCount"])
        c.check("draw.%s.uvHash" % draw_id,
                digest == draw.get("uvHash") == binding_draw["uvHash"],
                (digest, draw.get("uvHash"), binding_draw["uvHash"]))
        uv_checked += 1
        first_vertex = int(indices[global_first:global_first + binding_draw["indexCount"]].min())
        last_vertex = int(indices[global_first:global_first + binding_draw["indexCount"]].max())
        c.check("draw.%s.vertices" % draw_id,
                draw.get("firstVertex") == first_vertex and
                draw.get("lastVertex") == last_vertex and
                first_vertex >= section["vertexOffset"] and
                last_vertex < section["vertexOffset"] + section["vertexCount"])
        slot = draw.get("textureSlot")
        c.check("draw.%s.slot" % draw_id,
                isinstance(slot, int) and
                0 <= slot < manifest["counts"]["uniqueTextureBlobs"], slot)

    c.check("draws.uvChecked", uv_checked == expected_bindable, uv_checked)

    # ---------------------------------------------------------- diagnostics
    diag_draws = diagnostics["draws"]
    c.check("diagnostics.draws.count", len(diag_draws) == expected_blocked)
    c.check("diagnostics.draws.unique",
            len({row["drawId"] for row in diag_draws}) == expected_blocked)
    blocked_keys = {key for key, (_, binding_draw) in joined.items()
                    if binding_draw["status"] != BINDABLE}
    c.check("diagnostics.keysCoverBlocked",
            {row["drawId"] for row in diag_draws} ==
            {"%s#%d" % key for key in blocked_keys})
    c.check("diagnostics.remainder",
            len({row["drawId"] for row in diag_draws} & set(by_id)) == 0)

    groups = diagnostics["groups"]
    c.check("diagnostics.group.effectDraws",
            groups["effectDecal"].get("draws") == expected_effect)
    c.check("diagnostics.group.effectTriangles",
            groups["effectDecal"].get("triangles") ==
            bindings["counts"]["statusTriangles"].get(EFFECT, 0))
    c.check("diagnostics.group.effectSeparate",
            groups["effectDecal"].get("separateAdditiveDecalList") is True)
    c.check("diagnostics.group.effectNotOpaque",
            groups["effectDecal"].get("opaqueAlbedo") is False)
    c.check("diagnostics.group.decoderDraws",
            groups["decoderSize"].get("draws") == expected_decoder)
    c.check("diagnostics.group.alphaDraws",
            groups["alphaRule"].get("draws") == expected_alpha)
    c.check("diagnostics.group.runtimeDraws",
            groups["runtimeAlbedo"].get("draws") == expected_runtime)
    if expected_no_albedo:
        c.check("diagnostics.group.noAlbedoDraws",
                groups.get("noStaticAlbedo", {}).get("draws") == expected_no_albedo,
                groups.get("noStaticAlbedo"))

    effect_ranges = groups["effectDecal"]["indexRanges"]
    c.check("diagnostics.decalRanges.count", len(effect_ranges) == expected_effect)
    effect_range_map = {row["drawId"]: row for row in effect_ranges}
    c.check("diagnostics.decalRanges.unique", len(effect_range_map) == expected_effect)

    effect_seen = 0
    for row in diag_draws:
        binding_draw = joined[(row["section"], row["sectionDrawIndex"])][1]
        status = binding_draw["status"]
        section = sections[row["section"]]
        global_first = section["indexOffset"] + binding_draw["firstIndex"]
        diagnostic = row["diagnostic"]
        draw_id = row["drawId"]
        c.check("diag.%s.range" % draw_id,
                row.get("status") == status and row.get("firstIndex") == global_first and
                row.get("indexCount") == binding_draw["indexCount"] and
                row.get("triangleCount") == binding_draw["triangleCount"])
        c.check("diag.%s.notBound" % draw_id,
                diagnostic.get("textureBound") is False and
                diagnostic.get("albedoUsed") is False)
        c.check("diag.%s.reason" % draw_id, bool(diagnostic.get("reason")))
        if status == EFFECT:
            effect_seen += 1
            c.check("diag.%s.effectClassification" % draw_id,
                    diagnostic.get("pass") == "effect-additive-decal" and
                    diagnostic.get("separatePass") == "effect-additive-decal" and
                    diagnostic.get("opaqueAlbedo") is False)
            aux = diagnostic.get("auxTexture") or {}
            c.check("diag.%s.auxTexture" % draw_id,
                    bool(aux.get("textureId")) and bool(aux.get("name")))
            if str(row.get("effect", "")).startswith("Racification"):
                c.check("diag.%s.colourConstant" % draw_id,
                        diagnostic.get("colourConstant") == [1.0, 1.0, 0.7, 1.0])
            else:
                c.check("diag.%s.colourConstant" % draw_id,
                        diagnostic.get("colourConstant") is None)
            rng = effect_range_map.get(draw_id)
            c.check("diag.%s.decalRange" % draw_id,
                    bool(rng) and rng.get("firstIndex") == global_first and
                    rng.get("indexCount") == binding_draw["indexCount"])
        elif status == DECODER:
            c.check("diag.%s.decoderClassification" % draw_id,
                    diagnostic.get("blocker") == "decoder-size-limit" and
                    max(diagnostic.get("sourceWidth") or 0,
                        diagnostic.get("sourceHeight") or 0) > 512 and
                    diagnostic.get("decodedInMAP3") is False)
        elif status == ALPHA:
            alpha = diagnostic.get("alpha") or {}
            c.check("diag.%s.alphaClassification" % draw_id,
                    diagnostic.get("blocker") == "alpha-rule-missing" and
                    alpha.get("alphaOpaque") is False and
                    diagnostic.get("decodedInMAP3") is True)
        elif status == RUNTIME:
            c.check("diag.%s.runtimeClassification" % draw_id,
                    diagnostic.get("blocker") == "runtime-albedo-parameter" and
                    diagnostic.get("sourceTextureId") is None)
        elif status == NO_ALBEDO:
            c.check("diag.%s.noAlbedoClassification" % draw_id,
                    diagnostic.get("blocker") == "no-static-albedo" and
                    diagnostic.get("sourceTextureId") is None and
                    diagnostic.get("fallback") == "none")
        else:
            c.check("diag.%s.classification" % draw_id, False, status)

    c.check("diagnostics.effectSeen", effect_seen == expected_effect, effect_seen)
    c.check("diagnostics.noDiagnosticDrawIsBindable",
            all(row["status"] != BINDABLE for row in diag_draws))

    # -------------------------------------------------------------- textures
    items = manifest["textures"]["items"]
    c.check("textures.itemCount", len(items) == expected_unique_blobs)
    c.check("textures.slotsSequential",
            [item["slot"] for item in items] == list(range(len(items))))
    c.check("textures.bytes.referencedMip0",
            manifest["textures"]["bytes"].get("referencedMip0") == expected_ref_mip0)
    c.check("textures.bytes.uniqueMip0",
            manifest["textures"]["bytes"].get("uniqueMip0") == expected_unique_mip0)
    c.check("textures.bytes.referencedChain",
            manifest["textures"]["bytes"].get("referencedExpectedChain") ==
            expected_ref_chain)
    c.check("textures.bytes.uniqueChain",
            manifest["textures"]["bytes"].get("uniqueExpectedChain") ==
            expected_unique_chain)

    slot_map = {item["slot"]: item for item in items}
    binding_textures = {row["id"]: row for row in bindings["textures"]}
    source_to_slot = {}
    texture_bytes = 0
    chain_bytes = 0
    texture_draws = 0
    texture_triangles = 0
    for item in items:
        tag = "tex.%03d" % item["slot"]
        path = package / item["file"]
        c.check(tag + ".file", path.is_file(), item["file"])
        data = path.read_bytes()
        texture_bytes += len(data)
        expected_chain = expected_chain_bytes(item["width"], item["height"], item["levels"])
        chain_bytes += expected_chain
        c.check(tag + ".bytes", item["bytes"] == len(data))
        c.check(tag + ".sha256", item["sha256"] == sha256_bytes(data))
        c.check(tag + ".fnv1a64", item["fnv1a64"] == "0x%016x" % fnv1a64(data))
        c.check(tag + ".rgbaLength", len(data) == item["width"] * item["height"] * 4)
        c.check(tag + ".uploadLength", len(data) == item["upload"]["bytesMip0"])
        c.check(tag + ".chain", item["mipHint"]["expectedChainBytes"] == expected_chain)
        c.check(tag + ".mipHint",
                item["mipHint"]["sourceLevels"] == item["levels"] and
                item["mipHint"]["decodedLevels"] == 1 and
                item["mipHint"]["generateMips"] is True and
                item["mipHint"]["applied"] is False)
        c.check(tag + ".srgbHint",
                item["srgbHint"]["colourSpace"] == "srgb" and
                item["srgbHint"]["applied"] is False)
        c.check(tag + ".uploadFormat",
                item["upload"]["format"] == "rgba8unorm" and
                item["upload"]["srgbVariant"] == "rgba8unorm-srgb")
        c.check(tag + ".alphaOpaque", (item.get("alpha") or {}).get("alphaOpaque") is True)
        c.check(tag + ".sourceRgba",
                item["sourceRgba"]["sha256"] == item["sha256"] and
                item["sourceRgba"]["bytes"] == len(data))
        source_blob = ROOT / (item["sourceBlob"].get("path") or "")
        c.check(tag + ".sourceBlob",
                bool(item["sourceBlob"].get("path")) and source_blob.is_file() and
                item["sourceBlob"].get("bytes") == source_blob.stat().st_size and
                item["sourceBlob"].get("sha256") == sha256_file(source_blob))
        c.check(tag + ".bindableSet",
                len(item["sourceIds"]) >= 1 and item["drawCount"] > 0)
        c.check(tag + ".decoderBound", item["width"] <= 512 and item["height"] <= 512)
        texture_draws += item["drawCount"]
        texture_triangles += item["triangleCount"]
        for texture_id in item["sourceIds"]:
            c.check(tag + ".source." + texture_id, texture_id not in source_to_slot)
            source_to_slot[texture_id] = item["slot"]
            binding_texture = binding_textures.get(texture_id)
            c.check(tag + ".sourceHash." + texture_id,
                    binding_texture is not None and
                    binding_texture.get("rgbaSha256") == item["sha256"])

    c.check("textures.sourceCount", len(source_to_slot) == expected_sources,
            len(source_to_slot))
    c.check("textures.totalBytes", texture_bytes == expected_unique_mip0,
            texture_bytes)
    c.check("textures.chainBytes", chain_bytes == expected_unique_chain, chain_bytes)
    c.check("textures.drawCoverage", texture_draws == expected_bindable, texture_draws)
    c.check("textures.triangleCoverage",
            texture_triangles == expected_bindable_tri, texture_triangles)
    c.check("textures.distinctDimensions",
            len(manifest["textures"]["distinctDimensions"]) ==
            len({"%dx%d" % (row["width"], row["height"]) for row in unique_rows.values()}))

    merged = manifest["textures"]["mergedGroups"]
    # A merge group is one distinct RGBA payload shared by two or more sources.
    # Counting sources-merged (sources - blobs) only equals the group count when
    # every group is a pair; a 3-way merge makes the two differ.
    hash_counts = {}
    for row in bindable_rows:
        hash_counts[row["rgbaSha256"]] = hash_counts.get(row["rgbaSha256"], 0) + 1
    expected_merge_groups = sum(1 for count in hash_counts.values() if count > 1)
    c.check("textures.mergedGroups", len(merged) == expected_merge_groups)
    c.check("textures.mergedIds",
            sum(len(group["sourceIds"]) for group in merged) ==
            sum(1 for row in bindable_rows
                if sum(1 for other in bindable_rows
                       if other["rgbaSha256"] == row["rgbaSha256"]) > 1))
    merge_bad = 0
    for group in merged:
        ids = group["sourceIds"]
        if len(ids) < 2 or group["primaryId"] != ids[0]:
            merge_bad += 1
        if len({source_to_slot.get(i) for i in ids}) != 1:
            merge_bad += 1
    c.check("textures.mergeMapping", merge_bad == 0, merge_bad)

    # every draw textureId is in the source map and its item exists
    for draw in draws:
        slot = draw.get("textureSlot")
        item = slot_map.get(slot)
        c.check("draw.%s.textureBinding" % draw["drawId"],
                item is not None and draw["textureId"] in item["sourceIds"] and
                source_to_slot.get(draw["textureId"]) == slot)

    # ----------------------------------------------------------------- layout
    layout = manifest["layout"]
    layout_bytes = (package / layout["pointsFile"]).read_bytes()
    points = np.frombuffer(layout_bytes, dtype="<f4").reshape(-1, 3)
    c.check("layout.pointsFile", layout["pointsFile"] == "layout.points.f32.bin")
    c.check("layout.pointsBytes", layout["pointsBytes"] == len(layout_bytes))
    c.check("layout.pointsSha256", layout["pointsSha256"] == sha256_bytes(layout_bytes))
    c.check("layout.sourcePointsSha256",
            layout["pointsSha256"] == slice_doc["layout"]["pointsSha256"])
    c.check("layout.pointCount",
            len(points) == layout["pointCount"] ==
            slice_doc["layout"]["pointCount"])
    c.check("layout.spawn", layout["spawn"] == slice_doc["layout"]["spawn"])
    c.check("layout.checkpoints", layout["checkpoints"] == slice_doc["layout"]["checkpoints"])
    c.check("layout.finish", layout["finish"] == slice_doc["layout"]["finish"])
    c.check("layout.lengthM", layout["lengthM"] == slice_doc["layout"]["lengthM"])

    diffs = np.diff(points[:, :2], axis=0)
    cumulative = np.concatenate(([0.0], np.cumsum(np.hypot(diffs[:, 0], diffs[:, 1]))))
    length = float(cumulative[-1])
    float32_layout = layout["pointsFloat32"]
    c.check("layout.measuredLength",
            abs(length - float32_layout["lengthM"]) <= 1e-9,
            (length, float32_layout["lengthM"]))
    c.check("layout.lengthErrorRecorded",
            abs((length - layout["lengthM"]) - float32_layout["lengthErrorVsSourceM"]) <= 1e-9)
    c.check("layout.lengthQuantisationBound",
            abs(length - layout["lengthM"]) <= 0.05,
            (length, layout["lengthM"]))
    c.check("layout.spawnIsFirst",
            abs(float(points[0, 0]) - layout["spawn"]["x"]) < 1e-9 and
            abs(float(points[0, 1]) - layout["spawn"]["z"]) < 1e-9)
    c.check("layout.finishIsLast",
            abs(float(points[-1, 0]) - layout["finish"]["x"]) < 1e-9 and
            abs(float(points[-1, 1]) - layout["finish"]["z"]) < 1e-9)
    c.check("layout.finishDistance",
            abs(float(cumulative[-1]) - float32_layout["finishDistanceM"]) <= 1e-9)
    recorded_checkpoints = {row["index"]: row for row in float32_layout["checkpoints"]}
    for checkpoint in layout["checkpoints"]:
        distances = np.hypot(points[:, 0] - checkpoint["x"],
                             points[:, 1] - checkpoint["z"])
        best = int(np.argmin(distances))
        recorded = recorded_checkpoints.get(checkpoint["index"])
        c.check("layout.checkpoint.%d.pointIndex" % checkpoint["index"],
                best == checkpoint["pointIndex"], best)
        c.check("layout.checkpoint.%d.float32PointIndex" % checkpoint["index"],
                recorded is not None and recorded["pointIndex"] == best)
        c.check("layout.checkpoint.%d.distance" % checkpoint["index"],
                abs(float(cumulative[best]) - checkpoint["distanceM"]) <= 0.1,
                (float(cumulative[best]), checkpoint["distanceM"]))
        c.check("layout.checkpoint.%d.float32Distance" % checkpoint["index"],
                recorded is not None and
                abs(float(cumulative[best]) - recorded["distanceM"]) <= 1e-9)
    # Amboy's committed float32 heading uses the first segment; generalized
    # levels use the first-2 m (index 8) tangent to match the candidate heading.
    heading_index = 1 if level == "usa_amboy" else min(8, len(points) - 1)
    tangent = math.atan2(float(points[heading_index, 0] - points[0, 0]),
                         float(points[heading_index, 1] - points[0, 1]))
    heading_error = abs(math.atan2(math.sin(tangent - layout["spawn"]["heading"]),
                                   math.cos(tangent - layout["spawn"]["heading"])))
    c.check("layout.spawnHeading",
            abs(tangent - float32_layout["spawnHeadingRad"]) <= 1e-9,
            (tangent, float32_layout["spawnHeadingRad"]))
    c.check("layout.spawnHeadingQuantisationBound", heading_error <= 1e-3, heading_error)
    c.check("layout.spawnHeadingMatchesSlice",
            layout["spawn"]["heading"] == slice_doc["layout"]["spawn"]["heading"])

    # ---------------------------------------------------------------- hashes
    hashes = manifest["hashes"]
    c.check("hashes.algorithm", hashes.get("algorithm") == "sha256")
    body = {key: value for key, value in manifest.items() if key != "hashes"}
    c.check("hashes.contentSha256",
            hashes.get("contentSha256") == sha256_bytes(canonical(body)))
    c.check("hashes.fileCount",
            len(hashes["files"]) ==
            5 + len(items), len(hashes["files"]))
    package_files = file_map(package, ignore=("render.json", "verify.json"))
    c.check("hashes.noMissingFiles", set(package_files) == set(hashes["files"]))
    hash_bad = 0
    for name, record in hashes["files"].items():
        data = package_files.get(name)
        c.check("hashes." + name + ".bytes",
                data is not None and record.get("bytes") == len(data))
        c.check("hashes." + name + ".sha256",
                data is not None and record.get("sha256") == sha256_bytes(data))
        if data is None or record.get("bytes") != len(data) or \
                record.get("sha256") != sha256_bytes(data):
            hash_bad += 1
    c.check("hashes.allFiles", hash_bad == 0, hash_bad)
    c.check("hashes.excludesVerify", "verify.json" not in hashes["files"])
    c.check("hashes.excludesManifest", "render.json" not in hashes["files"])

    # ------------------------------------------- two fresh deterministic builds
    build_root = ROOT / "_work/logs/map-slice" / ("%s-render-determinism" %
                                                 level.split("_")[-1])
    if build_root.exists():
        shutil.rmtree(build_root)
    build_root.mkdir(parents=True, exist_ok=True)
    build_digests = []
    try:
        build_dirs = []
        for index in (1, 2):
            target = build_root / ("build-%d" % index)
            process = subprocess.run(
                [sys.executable, str(TOOL), "--level", level,
                 "--package", str(SLICE_DIR), "--texture-dir", str(TEXTURE_DIR),
                 "--out", str(target)],
                cwd=str(ROOT), capture_output=True, timeout=1800)
            c.check("determinism.build%d.exit" % index, process.returncode == 0,
                    process.stderr.decode("utf-8", "replace")[-400:])
            build_dirs.append(target)
            c.check("determinism.build%d.render" % index,
                    (target / "render.json").is_file())

        maps = []
        for index, target in enumerate(build_dirs, 1):
            current = file_map(target, ignore=("render.json", "verify.json"))
            maps.append(current)
            c.check("determinism.build%d.fileSet" % index,
                    set(current) == set(package_files))
            bad = 0
            for name, data in package_files.items():
                equal = current.get(name) == data
                if not equal:
                    bad += 1
                c.check("determinism.build%d.equal.%s" % (index, name), equal)
            c.check("determinism.build%d.allBytes" % index, bad == 0, bad)
            rebuild = load_json(target / "render.json")
            c.check("determinism.build%d.contentSha" % index,
                    rebuild["hashes"]["contentSha256"] == hashes["contentSha256"])
            c.check("determinism.build%d.manifestBytes" % index,
                    (target / "render.json").read_bytes() == render_path.read_bytes())
            build_digests.append(hashlib.sha256(
                json.dumps(sorted((name, sha256_bytes(data))
                                  for name, data in current.items()),
                           separators=(",", ":")).encode("utf-8")).hexdigest())

        c.check("determinism.buildAEqualsBuildB", build_digests[0] == build_digests[1],
                build_digests)
    finally:
        shutil.rmtree(build_root, ignore_errors=True)

    result = {
        "schema": ("blur.map-slice.amboy-render-verify/1" if level == "usa_amboy"
                   else "blur.map-slice.render-verify/1"),
        "kind": "map-slice-render-verifier",
        "level": level,
        "status": "PASS" if not c.errors else "FAIL",
        "checks": c.count,
        "errors": len(c.errors),
        "firstErrors": c.errors[:20],
        "package": {
            "manifest": {"path": "render.json", "bytes": render_path.stat().st_size,
                         "sha256": sha256_file(render_path)},
            "contentSha256": hashes["contentSha256"],
            "files": len(hashes["files"]),
        },
        "counts": {
            "bindableDraws": len(draws),
            "blockedDraws": len(diag_draws),
            "effectDecalDraws": effect_seen,
            "textureSources": len(source_to_slot),
            "uniqueTextureBlobs": len(items),
            "textureMip0Bytes": texture_bytes,
            "textureExpectedChainBytes": chain_bytes,
            "layoutPoints": len(points),
        },
        "determinism": {
            "builds": 2,
            "aggregateSha256": build_digests,
            "byteIdentical": build_digests[0] == build_digests[1],
        },
        "scope": {
            "dataOnly": True,
            "rendererChanged": False,
            "gpuUploaded": False,
            "browserFrameProduced": False,
            "playableClaim": False,
        },
    }
    (package / "verify.json").write_text(
        json.dumps(result, indent=1, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", default="_work/map-slice/amboy-render")
    parser.add_argument("--level", default=None)
    args = parser.parse_args()
    package = (ROOT / args.package).resolve() if not Path(args.package).is_absolute() \
        else Path(args.package)
    result = verify(package, args.level)
    print(json.dumps({key: result[key] for key in
                      ("status", "checks", "errors", "counts", "determinism")},
                     indent=1))
    if result["errors"]:
        print(json.dumps(result["firstErrors"], indent=1))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
