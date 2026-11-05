"""Export the real UV0 streams and static albedo textures for the E1 track visual.

The E1 drive slice draws 394 River direct draws (block88/node283 plus the six
measured corridor sections of the 539.81 m course). P44/P45/P47 measured, for the
299 corridor draws only:

  * the resolved UV0 stream (element offset 16, stream 0 = the POSITION stream,
    per-draw FNV-1a 64 value hash), and
  * the static `g_tAlbedo` binding (`block:index`) and, through the P34 + P47
    decode registry, the decoded BC1 RGBA of every bound source.

This tool turns those measurements into PoC artefacts: one float32 UV0 array per
merged vertex, one RGBA file per distinct source, and a manifest that pins every
value by hash. Nothing is guessed: a draw without a P45/P47 row (block88) or with
a runtime-only albedo parameter keeps `textureId:null` and a labelled reason, and
any value that fails its recorded hash aborts the run.

Inputs (read-only, under `_work/` and `game-data/`):

  * `_work/logs/engine-stream-spike/a__run1.log` / `a__run2.log` — the P47 wasm
    harness stdout, which prints one `webfiledraw section uv0 ...` row per
    drawable corridor draw (UV0 stream, per-draw UV0 hash, albedo source, decoded
    texture identity and RGBA hash);
  * `_work/logs/engine-stream-spike/p47-verify-fresh.json` — the P47 gate totals,
    used to pin the UV0 and binding aggregates and the texture count;
  * `_work/logs/engine-stream-spike/reference-mesh-<g>-<n>.json` — the committed
    C++ `level_inspect` mesh reference, whose `uv0` array P45 proved equal to the
    engine UV0 stream draw by draw;
  * `_work/logs/engine-stream-spike/track-textures.json` /
    `engine-textures.json` — the P34/P47 per-texture decode records;
  * `_work/logs/engine-stream-spike/textures/tex-<block>-<index>.raw` — the
    descriptor+texel blob of every source, fed to the committed decoder;
  * `_work/build/asset-reader-native/Release/texture_inspect.exe` — the committed
    BC1 reader (`--raw`), so no pixel decode is re-implemented here;
  * `_work/level-candidates/probes/{00-usa_la_river-g88-n283,08-usa_la_river-g56-n289}/reference.json`
    and `_work/track-coverage/visual.json` — the geometry inputs `build_geometry.mjs`
    also consumes; their draw ranges are matched one-to-one against the mesh
    reference before any UV is written.

Outputs (never committed):

  * `_work/e1-drive/track-uv.bin` — float32 LE UV0 pairs for all 96,494 merged
    vertices, in the same vertex order as `geometry.json`'s track mesh;
  * `_work/e1-drive/textures/<id>.rgba` — one RGBA8 mip0 bitmap per distinct
    static source (pixels as decoded by the committed BC1 reader);
  * `_work/e1-drive/track-textures.json` — the manifest: sampler choice, per-
    section UV hashes, per-texture identity/hashes and per-draw binding status.

Usage:
    python probes/e1-drive/tools/build_track_textures.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPIKE = ROOT / "_work/logs/engine-stream-spike"
TEXTURE_BLOBS = SPIKE / "textures"
DECODER = ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe"
OUT_DIR = ROOT / "_work/e1-drive"
UV_OUT = OUT_DIR / "track-uv.bin"
TEX_OUT_DIR = OUT_DIR / "textures"
MANIFEST_OUT = OUT_DIR / "track-textures.json"

# The two committed level_inspect direct-draw references and the 46-section
# track-coverage map. These are the same files and the same pins build_geometry.mjs
# uses; re-stating them here keeps this tool independent of geometry.json.
LEVEL_INSPECT_REFS = {
    88: {
        "path": "_work/level-candidates/probes/00-usa_la_river-g88-n283/reference.json",
        "sha256": "e2a830f40af73ddcab928f719212c0bbdc77416b276b83c5a6e05ac48c887b89",
    },
    56: {
        "path": "_work/level-candidates/probes/08-usa_la_river-g56-n289/reference.json",
        "sha256": "ac570f64be34a0e0480173c8c31f3784e28200e7a6ddfe14a7bf462a458dccaf",
    },
}
TRACK_COVERAGE = {
    "path": "_work/track-coverage/visual.json",
    "sha256": "877b4dc7e1f5ece197f0776239b33d23b0350f8cf77ef462c0c7a266a6abcb67",
    "kind": "track-coverage.visual-sections",
    "version": 1,
}

# Merged order must equal `build_geometry.mjs` TRACK_VISUAL_SECTIONS order.
SECTIONS = [
    {"key": "river.block88.node283", "geometryBlock": 88, "nodeBlock": 283,
     "sourceKind": "level-inspect", "drawCount": 95},
    {"key": "river.block56.node289", "geometryBlock": 56, "nodeBlock": 289,
     "sourceKind": "level-inspect", "drawCount": 49},
    {"key": "river.block58.node265", "geometryBlock": 58, "nodeBlock": 265,
     "sourceKind": "track-coverage", "sectionKey": "g58-n265", "drawCount": 41},
    {"key": "river.block50.node265", "geometryBlock": 50, "nodeBlock": 265,
     "sourceKind": "track-coverage", "sectionKey": "g50-n265", "drawCount": 44},
    {"key": "river.block71.node209", "geometryBlock": 71, "nodeBlock": 209,
     "sourceKind": "track-coverage", "sectionKey": "g71-n209", "drawCount": 56},
    {"key": "river.block64.node209", "geometryBlock": 64, "nodeBlock": 209,
     "sourceKind": "track-coverage", "sectionKey": "g64-n209", "drawCount": 40},
    {"key": "river.block59.node265", "geometryBlock": 59, "nodeBlock": 265,
     "sourceKind": "track-coverage", "sectionKey": "g59-n265", "drawCount": 69},
]

# P47 gate constants. Every derived value is compared with these before writing,
# so a changed log, registry or decoder fails instead of producing new pixels.
P47_UV_AGGREGATE = "2ed1f4b0b3c9148e"
P47_BINDING_AGGREGATE = "9cc08756505dd497"
P47_CORRIDOR_DRAWS = 299
P47_STATIC_DRAWS = 297
P47_RUNTIME_DRAWS = 2
P47_SOURCES = 137  # 136 static + the runtime-only -1:-1 pair

# The sampler is an explicit PoC choice, not a recovered engine state: P45/P47
# record that wrap mode, filter, anisotropy and mip selection are not resolved.
SAMPLER = {
    "addressModeU": "repeat",
    "addressModeV": "repeat",
    "magFilter": "linear",
    "minFilter": "linear",
    "mipmapFilter": "not-applied",
    "mipLevelsUploaded": 1,
    "textureFormat": "rgba8unorm",
    "colourSpace": "raw-decoded-texels",
    "reason": (
        "wrap/filter/mip/sRGB are not recovered from the engine; 'repeat' + linear on mip0 is the "
        "single explicit PoC choice, so UV0 outside [0,1] repeats instead of clamping. The RGBA bytes "
        "are the committed BC1 decode of the stored texels, uploaded as rgba8unorm: no sRGB-to-linear "
        "conversion, no mip chain and no anisotropy are applied. This is not retail sampling fidelity"
    ),
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fnv1a64(data: bytes) -> str:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{value:016x}"


def mix_f32(value: int, component: float) -> int:
    """P45/P47 UV0 hash step: FNV-1a 64 over the little-endian float32 bits."""
    for byte in struct.pack("<f", component):
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def load_signed_zero_json(path: Path) -> dict:
    """Keep the node reader's bare `-0` token as negative float zero (P45 §Signed zero)."""
    return json.loads(
        path.read_text(encoding="utf-8"),
        parse_int=lambda token: float(token) if token == "-0" else int(token),
    )


def float32_hash(values) -> str:
    return sha256_bytes(struct.pack("<%df" % len(values), *values))


def load_p47_rows():
    """Parse the per-draw `webfiledraw section uv0` rows out of the P47 harness log."""
    run1 = SPIKE / "a__run1.log"
    run2 = SPIKE / "a__run2.log"
    if not run1.is_file():
        raise SystemExit("BLOCKED: missing P47 harness log " + str(run1))
    text = run1.read_text(encoding="utf-8", errors="replace")
    if run2.is_file() and run2.read_text(encoding="utf-8", errors="replace") != text:
        raise SystemExit("FAILED: a__run1.log and a__run2.log differ (non-deterministic harness output)")

    rows = {}
    for line in text.splitlines():
        if not line.startswith("webfiledraw section uv0 "):
            continue
        fields = {}
        for token in line.split()[3:]:
            if "=" in token:
                key, value = token.split("=", 1)
                fields[key] = value
        key = (fields["key"], int(fields["draw"]))
        if key in rows:
            raise SystemExit(f"FAILED: duplicate P47 UV0 row {key}")
        rows[key] = fields
    if len(rows) != P47_CORRIDOR_DRAWS:
        raise SystemExit(f"FAILED: P47 log has {len(rows)} UV0 rows, expected {P47_CORRIDOR_DRAWS}")
    return rows, sha256_bytes(text.encode("utf-8"))


def load_p47_gate():
    path = SPIKE / "p47-verify-fresh.json"
    if not path.is_file():
        raise SystemExit("BLOCKED: missing P47 gate report " + str(path))
    doc = json.loads(path.read_text(encoding="utf-8"))
    if doc.get("verdict") != "PASS":
        raise SystemExit("FAILED: P47 gate report verdict is " + str(doc.get("verdict")))
    uv = doc["track_uv"]
    if uv["uvAggregate"] != P47_UV_AGGREGATE or uv["bindingAggregate"] != P47_BINDING_AGGREGATE:
        raise SystemExit(
            "FAILED: P47 aggregates changed (" + uv["uvAggregate"] + " / " + uv["bindingAggregate"] + ")")
    if uv["uvRecords"] != P47_CORRIDOR_DRAWS or uv["staticBindings"] != P47_STATIC_DRAWS:
        raise SystemExit("FAILED: P47 draw counts changed")
    return doc


def load_texture_registries():
    """P34 + P47 per-texture records, keyed by `block:index`."""
    registry = {}
    for name in ("engine-textures.json", "track-textures.json"):
        path = SPIKE / name
        if not path.is_file():
            raise SystemExit("BLOCKED: missing texture registry " + str(path))
        doc = json.loads(path.read_text(encoding="utf-8"))
        for record in doc["textures"]:
            key = f"{record['block']}:{record['index']}"
            if key in registry:
                raise SystemExit(f"FAILED: texture source {key} appears in both registries")
            record = dict(record)
            record["registry"] = name
            registry[key] = record
    if len(registry) != 198:
        raise SystemExit(f"FAILED: texture registry has {len(registry)} sources, expected 198 (P34 102 + P47 96)")
    return registry


def load_geometry_section(section):
    """The geometry input for one section: level_inspect reference or track-coverage entry."""
    if section["sourceKind"] == "level-inspect":
        spec = LEVEL_INSPECT_REFS[section["geometryBlock"]]
        path = ROOT / spec["path"]
        if not path.is_file():
            raise SystemExit("BLOCKED: missing " + spec["path"])
        raw = path.read_bytes()
        if sha256_bytes(raw) != spec["sha256"]:
            raise SystemExit(f"{section['key']}: reference is not the pinned level_inspect output")
        doc = json.loads(raw)
        return doc, spec["path"], spec["sha256"]
    path = ROOT / TRACK_COVERAGE["path"]
    if not path.is_file():
        raise SystemExit("BLOCKED: missing " + TRACK_COVERAGE["path"])
    raw = path.read_bytes()
    if sha256_bytes(raw) != TRACK_COVERAGE["sha256"]:
        raise SystemExit(TRACK_COVERAGE["path"] + " is not the pinned track-coverage output")
    doc = json.loads(raw)
    if doc.get("kind") != TRACK_COVERAGE["kind"] or doc.get("version") != TRACK_COVERAGE["version"]:
        raise SystemExit(TRACK_COVERAGE["path"] + ": kind/version changed")
    entry = next((s for s in doc["sections"] if s.get("key") == section["sectionKey"]), None)
    if entry is None:
        raise SystemExit(f"{section['key']}: missing from the track-coverage map")
    return entry, TRACK_COVERAGE["path"], TRACK_COVERAGE["sha256"]


def decode_source(source, row, registry):
    """Decode one source with the committed BC1 reader and cross-check every field."""
    record = registry.get(source)
    if record is None:
        raise SystemExit(f"FAILED: source {source} has no P34/P47 decode record")
    block, index = (int(part) for part in source.split(":"))
    blob = TEXTURE_BLOBS / f"tex-{block}-{index}.raw"
    if not blob.is_file():
        raise SystemExit(f"FAILED: missing texture blob {blob.relative_to(ROOT)}")
    blob_bytes = blob.read_bytes()
    blob_sha = sha256_bytes(blob_bytes)
    process = subprocess.run([str(DECODER), str(blob), "--raw"], capture_output=True)
    if process.returncode != 0:
        raise SystemExit(f"FAILED: committed decoder rejected {source}: " + process.stderr.decode("utf-8", "replace")[-400:])
    decoded = json.loads(process.stdout.decode("utf-8"))
    if decoded.get("status") != "ok":
        raise SystemExit(f"FAILED: committed decoder status for {source}: {decoded.get('status')}")
    width, height = decoded["width"], decoded["height"]
    rgba = bytes(decoded["rgba"])
    if (width, height) != (record["width"], record["height"]):
        raise SystemExit(f"FAILED: {source} decoded size {width}x{height} != registry {record['width']}x{record['height']}")
    if len(rgba) != record["rgbaBytes"] or len(rgba) != width * height * 4:
        raise SystemExit(f"FAILED: {source} RGBA length {len(rgba)} != registry {record['rgbaBytes']}")
    rgba_fnv = fnv1a64(rgba)
    if rgba_fnv != record["rgbaHash"]:
        raise SystemExit(f"FAILED: {source} RGBA hash {rgba_fnv} != P47 {record['rgbaHash']}")
    if record["blobHash"] != fnv1a64(blob_bytes):
        raise SystemExit(f"FAILED: {source} blob hash != P47 record")
    for field in ("name", "textureHash", "levels", "format"):
        if str(row[{"textureHash": "texturehash", "name": "texture", "levels": "levels", "format": "format"}[field]]) != str(record[field]):
            raise SystemExit(f"FAILED: {source} {field} differs between P47 row and registry")
    rgba_sha = sha256_bytes(rgba)
    if record["registry"] == "track-textures.json":
        # Some rows of the six sections are P34-bound; the P47 registry only has the
        # 96 track decodes, so only assert set membership here, not which set.
        pass
    return {
        "id": f"track.albedo.{block}.{index}",
        "block": block,
        "index": index,
        "name": record["name"],
        "textureHash": record["textureHash"],
        "width": width,
        "height": height,
        "levels": record["levels"],
        "format": record["format"],
        "formatName": "DXT1/BC1" if record["format"] == 827611204 else str(record["format"]),
        "payloadBytes": record["payloadBytes"],
        "rgbaBytes": len(rgba),
        "rgbaSha256": "sha256:" + rgba_sha,
        "rgbaFnv1a64": rgba_fnv,
        "blob": str(blob.relative_to(ROOT)).replace("\\", "/"),
        "blobSha256": "sha256:" + blob_sha,
        "registry": record["registry"],
        "rgba": rgba,
    }


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(MANIFEST_OUT))
    args = parser.parse_args(argv)

    if not DECODER.is_file():
        raise SystemExit(
            "BLOCKED: committed decoder missing: " + str(DECODER.relative_to(ROOT)) +
            " — build it with `python tools/verify_asset_probe.py` (it is read-only here)")

    gate = load_p47_gate()
    rows, log_sha = load_p47_rows()
    registries = load_texture_registries()

    merged_uv = []
    draw_records = []
    texture_draws = {}
    seen_sources = {}
    section_records = []

    for section in SECTIONS:
        geometry_doc, source_path, source_sha = load_geometry_section(section)
        mesh_path = SPIKE / f"reference-mesh-{section['geometryBlock']}-{section['nodeBlock']}.json"
        if not mesh_path.is_file():
            raise SystemExit("BLOCKED: missing committed mesh reference " + str(mesh_path.relative_to(ROOT)))
        mesh = load_signed_zero_json(mesh_path)
        vertex_count = mesh["metadata"]["vertexCount"]
        if mesh["metadata"].get("primitiveCount") != section["drawCount"]:
            raise SystemExit(f"{section['key']}: mesh reference has {mesh['metadata'].get('primitiveCount')} primitives")
        if len(mesh["uv0"]) != 2 * vertex_count:
            raise SystemExit(f"{section['key']}: uv0 has {len(mesh['uv0'])} values, expected 2 x {vertex_count}")
        for component in mesh["uv0"]:
            if not (component == component and abs(component) != float("inf")):
                raise SystemExit(f"{section['key']}: uv0 has a non-finite component")
        if float32_hash(mesh["positions"]) != float32_hash(geometry_doc["positions"]):
            raise SystemExit(f"{section['key']}: mesh reference positions differ from the geometry input")
        if mesh["indices"] != geometry_doc["indices"]:
            raise SystemExit(f"{section['key']}: mesh reference indices differ from the geometry input")
        if len(geometry_doc["draws"]) != section["drawCount"]:
            raise SystemExit(f"{section['key']}: geometry input has {len(geometry_doc['draws'])} draws")

        uv = mesh["uv0"]
        merged_uv.extend(uv)
        section_uv_hash = float32_hash(uv)
        section_draws = []

        for order, (geometry_draw, mesh_draw) in enumerate(zip(geometry_doc["draws"], mesh["draws"])):
            if geometry_draw["firstIndex"] != mesh_draw["firstIndex"] or \
                    geometry_draw["indexCount"] != mesh_draw["indexCount"]:
                raise SystemExit(f"{section['key']}: draw {order} range differs between the two readers")
            if not mesh_draw["uv0Available"]:
                raise SystemExit(f"{section['key']}: draw {order} has no uv0Available (P45 requires 299/299)")
            primitive = geometry_draw["primitiveIndex"]
            row = rows.get((f"g{section['geometryBlock']}-n{section['nodeBlock']}", primitive))

            record = {
                "sectionKey": section["key"],
                "sectionDrawIndex": order,
                "mergedDrawIndex": len(draw_records),
                "primitiveIndex": primitive,
                "sourceIndexRange": [geometry_draw["firstIndex"], geometry_draw["indexCount"]],
            }

            if row is None:
                # block88/node283 was never emitted by P44/P45/P47 (it is not part of
                # the measured corridor), so it has no committed UV/binding row and
                # therefore no texture. Its UV0 is still the reader's real stream.
                record.update({
                    "textureId": None,
                    "textureSource": None,
                    "uvProvenance": "level-mesh-uv0",
                    "uvHash": None,
                    "bindingStatus": "noBindingRowForSection",
                    "bindingReason": (
                        "the committed P44/P45/P47 section pass covers the six measured corridor sections only; "
                        "block88/node283 has no binding row, so the draw keeps the diagnostic albedo"),
                })
                section_draws.append(record)
                draw_records.append(record)
                continue

            if row["uvnull"] != "0":
                raise SystemExit(f"{section['key']}: draw {primitive} has uv0:null ({row['uvreason']})")
            if not row["uvhash"].startswith("0x"):
                raise SystemExit(f"{section['key']}: draw {primitive} UV0 row has no uvhash")

            digest = 0xCBF29CE484222325
            low = [None, None]
            high = [None, None]
            first, count = geometry_draw["firstIndex"], geometry_draw["indexCount"]
            for vertex in mesh["indices"][first:first + count]:
                pair = (uv[2 * vertex], uv[2 * vertex + 1])
                for axis in range(2):
                    digest = mix_f32(digest, pair[axis])
                    if low[axis] is None or pair[axis] < low[axis]:
                        low[axis] = pair[axis]
                    if high[axis] is None or pair[axis] > high[axis]:
                        high[axis] = pair[axis]
            if f"{digest:016x}" != row["uvhash"][2:]:
                raise SystemExit(
                    f"{section['key']}: draw {primitive} UV0 hash {digest:016x} != P47 {row['uvhash']}")

            source = row["albedo"]
            if row["texstate"] == "runtimeOnly":
                if source != "-1:-1" or row["texture"] != "null":
                    raise SystemExit(f"{section['key']}: draw {primitive} runtime row is malformed")
                record.update({
                    "textureId": None,
                    "textureSource": None,
                    "uvProvenance": "level-mesh-uv0",
                    "uvHash": "0x" + row["uvhash"][2:],
                    "uvRange": [[low[0], high[0]], [low[1], high[1]]],
                    "bindingStatus": "runtimeOnlyAlbedoParameter",
                    "bindingReason": row["bindreason"],
                })
                section_draws.append(record)
                draw_records.append(record)
                continue

            if row["texstate"] != "decoded":
                raise SystemExit(f"{section['key']}: draw {primitive} texstate is {row['texstate']}")
            texture = seen_sources.get(source)
            if texture is None:
                texture = decode_source(source, row, registries)
                seen_sources[source] = texture
            texture_draws.setdefault(source, []).append(len(draw_records))
            record.update({
                "textureId": texture["id"],
                "textureSource": source,
                "textureName": texture["name"],
                "uvProvenance": "level-mesh-uv0",
                "uvHash": "0x" + row["uvhash"][2:],
                "uvRange": [[low[0], high[0]], [low[1], high[1]]],
                "bindingStatus": "bound-static-albedo",
                "bindingReason": "none",
            })
            section_draws.append(record)
            draw_records.append(record)

        section_records.append({
            "key": section["key"],
            "geometryBlock": section["geometryBlock"],
            "nodeBlock": section["nodeBlock"],
            "sourceKind": section["sourceKind"],
            "geometrySource": source_path,
            "geometrySourceSha256": "sha256:" + source_sha,
            "meshReference": str(mesh_path.relative_to(ROOT)).replace("\\", "/"),
            "meshReferenceSha256": "sha256:" + sha256_bytes(mesh_path.read_bytes()),
            "vertexCount": vertex_count,
            "drawCount": section["drawCount"],
            "uvValues": len(uv),
            "uvSha256": "sha256:" + section_uv_hash,
            "uvPresentDraws": len(section_draws),
            "texturedDraws": sum(1 for draw in section_draws if draw["textureId"] is not None),
        })

    if len(merged_uv) != 2 * 96494:
        raise SystemExit(f"FAILED: merged UV has {len(merged_uv)} values, expected 2 x 96494")

    textured = [draw for draw in draw_records if draw["textureId"] is not None]
    runtime = [draw for draw in draw_records if draw["bindingStatus"] == "runtimeOnlyAlbedoParameter"]
    unbound = [draw for draw in draw_records if draw["bindingStatus"] == "noBindingRowForSection"]
    if len(textured) != P47_STATIC_DRAWS:
        raise SystemExit(f"FAILED: {len(textured)} textured draws, expected {P47_STATIC_DRAWS}")
    if len(runtime) != P47_RUNTIME_DRAWS or len(unbound) != 95:
        raise SystemExit(f"FAILED: fallback split {len(runtime)} runtime / {len(unbound)} unbound")
    if len(seen_sources) != 136:
        raise SystemExit(f"FAILED: {len(seen_sources)} decoded static sources, expected 136")

    gate_textures = gate["track_textures"]
    if seen_sources and sum(1 for t in seen_sources.values() if t["registry"] == "track-textures.json") != gate_textures["decoded"]:
        raise SystemExit("FAILED: track texture count differs from the P47 gate")

    # UV0 aggregate: fold the parsed P47 rows exactly as verify_stream.py does
    # (`section_uv_hash`), so a changed log fails instead of producing new data.
    def mix_string(value, text_):
        data = text_.encode("utf-8")
        value = mix_u32(value, len(data))
        for byte in data:
            value ^= byte
            value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
        return value

    def mix_u32(value, number):
        for byte in struct.pack("<I", number & 0xFFFFFFFF):
            value ^= byte
            value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
        return value

    def mix_u64(value, number):
        for byte in struct.pack("<Q", number & 0xFFFFFFFFFFFFFFFF):
            value ^= byte
            value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
        return value

    aggregate = 0xCBF29CE484222325
    for row in rows.values():
        aggregate = mix_string(aggregate, row["key"])
        aggregate = mix_u32(aggregate, int(row["draw"]))
        aggregate = mix_u32(aggregate, 1 if row["uvnull"] == "0" else 0)
        aggregate = mix_u32(aggregate, int(row["uvstream"]))
        aggregate = mix_u32(aggregate, int(row["uvtype"]))
        aggregate = mix_u32(aggregate, int(row["uvoffset"]))
        aggregate = mix_u32(aggregate, int(row["uvstride"]))
        aggregate = mix_u32(aggregate, int(row["uvshift"]))
        aggregate = mix_u32(aggregate, int(row["uvfirst"]))
        aggregate = mix_u32(aggregate, int(row["uvcount"]))
        aggregate = mix_u64(aggregate, int(row["uvhash"], 16))
        aggregate = mix_string(aggregate, row["uvreason"])
    uv_aggregate = f"{aggregate:016x}"
    if uv_aggregate != P47_UV_AGGREGATE:
        raise SystemExit(f"FAILED: recomputed UV aggregate {uv_aggregate} != P47 {P47_UV_AGGREGATE}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    TEX_OUT_DIR.mkdir(parents=True, exist_ok=True)

    uv_bytes = struct.pack("<%df" % len(merged_uv), *merged_uv)
    UV_OUT.write_bytes(uv_bytes)

    textures = []
    rgba_total = 0
    for source in sorted(seen_sources, key=lambda key: tuple(int(part) for part in key.split(":"))):
        texture = seen_sources[source]
        rgba = texture.pop("rgba")
        path = TEX_OUT_DIR / (texture["id"] + ".rgba")
        path.write_bytes(rgba)
        if sha256_bytes(path.read_bytes()) != texture["rgbaSha256"][7:]:
            raise SystemExit(f"FAILED: {texture['id']} written RGBA does not re-hash")
        texture["rgbaPath"] = str(path.relative_to(ROOT)).replace("\\", "/")
        texture["drawCount"] = len(texture_draws[source])
        textures.append(texture)
        rgba_total += len(rgba)

    manifest = {
        "kind": "e1-drive.track-textures",
        "version": 1,
        "generator": "probes/e1-drive/tools/build_track_textures.py",
        "scope": (
            "UV0 and static g_tAlbedo bindings for the merged E1 track visual; values are the committed "
            "P45/P47 rows, the UV0 arrays are the committed level_inspect mesh streams those rows were "
            "compared against, and the pixels are the committed BC1 decode of the P47/P34 blobs. No UV, "
            "colour, address mode or mip level is synthesised"
        ),
        "pins": {
            "p47Log": "sha256:" + log_sha,
            "p47Gate": "sha256:" + sha256_bytes((SPIKE / "p47-verify-fresh.json").read_bytes()),
            "uvAggregate": P47_UV_AGGREGATE,
            "bindingAggregate": P47_BINDING_AGGREGATE,
            "trackDraws": len(draw_records),
            "corridorDraws": P47_CORRIDOR_DRAWS,
        },
        "sampler": SAMPLER,
        "uvStream": {
            "path": str(UV_OUT.relative_to(ROOT)).replace("\\", "/"),
            "storage": "float32-le",
            "components": 2,
            "vertexCount": len(merged_uv) // 2,
            "values": len(merged_uv),
            "bytes": len(uv_bytes),
            "sha256": "sha256:" + sha256_bytes(uv_bytes),
            "order": "the merged track mesh vertex order in geometry.json (sections in this order)",
            "source": "level_inspect reference-mesh-<g>-<n>.json uv0, P45-verified per draw",
        },
        "sections": section_records,
        "textures": textures,
        "draws": draw_records,
        "coverage": {
            "trackDraws": len(draw_records),
            "texturedDraws": len(textured),
            "fallbackDraws": len(draw_records) - len(textured),
            "fallbackRuntimeOnly": len(runtime),
            "fallbackNoBindingRow": len(unbound),
            "texturedSections": sum(1 for section in section_records if section["texturedDraws"]),
            "textureCount": len(textures),
            "rgbaBytes": rgba_total,
            "uvBytes": len(uv_bytes),
            "textureFormat": "DXT1/BC1 decoded to RGBA8",
            "note": (
                "297 of 394 draws are textured: the 297 static corridor draws of the six measured sections. "
                "2 corridor draws are runtime-only albedo parameters and 95 block88/node283 draws have no "
                "P44/P45/P47 binding row; both keep the diagnostic albedo and say so per draw"),
        },
    }
    text = json.dumps(manifest, indent=1)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # Write the exact bytes that were hashed above (LF newlines, no platform
    # translation), so the printed SHA-256 is the file's SHA-256.
    out.write_bytes(text.encode("utf-8"))

    print(json.dumps({
        "output": str(out.relative_to(ROOT)).replace("\\", "/"),
        "bytes": len(text.encode("utf-8")),
        "sha256": "sha256:" + sha256_bytes(text.encode("utf-8")),
        "uv": {
            "path": manifest["uvStream"]["path"],
            "bytes": len(uv_bytes),
            "vertexCount": manifest["uvStream"]["vertexCount"],
            "sha256": manifest["uvStream"]["sha256"],
        },
        "textures": {
            "count": len(textures),
            "rgbaBytes": rgba_total,
            "p34": sum(1 for texture in textures if texture["registry"] == "engine-textures.json"),
            "p47": sum(1 for texture in textures if texture["registry"] == "track-textures.json"),
        },
        "draws": manifest["coverage"],
        "uvAggregate": uv_aggregate,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
