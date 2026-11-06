"""Export the level-instance prop UV0 + static BC1 albedo pack for the E1 PoC.

P73a (`docs/work/analysis/level-instance-textures.md`) proved that the committed
asset-reader exports the real UV0 stream and the resolved static `g_tAlbedo`
resource identity for all 22 `usa_la_river` block27/node253 instance draws. It
also split them by the committed texture format:

  * 18 draws / 10,212 triangles resolve to a DXT1/BC1 image and can reuse the
    already-proven track/car sampling path,
  * 4 draws / 96 triangles resolve to `cab01alphas_diff` (DXT5/BC3) and stay
    blocked as `bc3-alpha-rule-missing`.

This tool turns that read-only export into PoC artefacts, exactly like
`build_track_textures.py` does for the track:

  * the UV0 stream is copied from `_work/asset-reader/level-instance-uv.bin`;
  * every per-draw UV0 hash is recomputed from the stream + the reader indices
    and must equal the P73a value;
  * the four BC1 sources are decoded with the committed
    `texture_inspect.exe --raw` and compared with the P34 registry FNV hash;
  * the manifest records per-draw provenance, the RGBA file hashes and the
    explicit sampler choice.

The four BC3 draws keep their real UV hash and source identity in the manifest
but get `textureId:null` and `status:"blocked-bc3-alpha"`. No alpha rule, pixel,
texture or UV is invented.

Inputs (read-only):
  * `_work/asset-reader/level-instance-textures.json` (P73a, pinned SHA-256)
  * `_work/asset-reader/level-instance-uv.bin` (pinned SHA-256 / size)
  * `_work/asset-reader/level-instances-all.json` (reader indices + UV0)
  * `_work/logs/engine-stream-spike/engine-textures.json` (P34 registry)
  * `_work/logs/engine-stream-spike/textures/tex-<block>-<index>.raw`
  * `_work/build/asset-reader-native/Release/texture_inspect.exe`

Outputs (never committed):
  * `_work/e1-drive/level-textures/level.albedo.<block>.<index>.rgba`
  * `_work/e1-drive/level-instance-textures.json`

Usage:
    python probes/e1-drive/tools/build_level_instance_textures.py
"""
from __future__ import annotations

import hashlib
import json
import struct
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ASSET = ROOT / "_work/asset-reader"
MANIFEST_IN = ASSET / "level-instance-textures.json"
UV_IN = ASSET / "level-instance-uv.bin"
READER_OUT = ASSET / "level-instances-all.json"
SPIKE = ROOT / "_work/logs/engine-stream-spike"
REGISTRY = SPIKE / "engine-textures.json"
TEXTURE_BLOBS = SPIKE / "textures"
DECODER = ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe"

OUT_DIR = ROOT / "_work/e1-drive"
TEX_OUT_DIR = OUT_DIR / "level-textures"
MANIFEST_OUT = OUT_DIR / "level-instance-textures.json"

# The inputs are the committed P73a output. A different file is a hard failure,
# because the level-prop pixels may only change when that export is rebuilt.
MANIFEST_IN_SHA256 = "1a33893026887f0e022eeec782791cbedf9153146d389b7c076f9d0b84f47fb4"
UV_IN_SHA256 = "158a3ac81b4cf7a5b1b92d327d8dfcd97ab29100387eb72d3b84f1f333962c83"
READER_OUT_SHA256 = "fc0a99138bb946f8d91e14d47d66f862f7603760e853a4bc4db64cb975960b9b"
REGISTRY_SHA256 = "e1243615ab3630c8141062926dea1c2594d48d52231ec185f31c051aa3048cd8"

EXPECTED_DRAWS = 22
EXPECTED_TRIANGLES = 10308
EXPECTED_VERTICES = 13162
EXPECTED_UV_VALUES = 26324
EXPECTED_UV_BYTES = 105296
EXPECTED_UV_AGGREGATE = "b07310e198de4c19"
EXPECTED_BINDABLE_DRAWS = 18
EXPECTED_BINDABLE_TRIANGLES = 10212
EXPECTED_BLOCKED_DRAWS = 4
EXPECTED_BLOCKED_TRIANGLES = 96
EXPECTED_BC1_SOURCES = 4
EXPECTED_BC1_BYTES = 8192
BLOCKED_REASON = "bc3-alpha-rule-missing"

# The same explicit PoC sampler the track and car packs use. Wrap/filter/mip and
# sRGB are still not recovered engine state.
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

SCOPE = (
    "River block27/node253 level-instance props: the real source UV0 stream and the static "
    "g_tAlbedo BC1 image on 18 draws; material colour, blend state, alpha rule, shader stages, "
    "sampler wrap/filter, mips and sRGB are not applied"
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fnv1a64(data: bytes) -> str:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{value:016x}"


def content_hash(doc: dict) -> str:
    body = {key: value for key, value in doc.items() if key != "contentHash"}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + sha256_bytes(encoded)


def require_file(path: Path, expected_sha: str | None = None) -> bytes:
    if not path.is_file():
        raise SystemExit("BLOCKED: missing " + str(path.relative_to(ROOT)))
    data = path.read_bytes()
    if expected_sha is not None and sha256_bytes(data) != expected_sha:
        raise SystemExit("FAILED: " + str(path.relative_to(ROOT)) + " is not the pinned file")
    return data


def decode_bc1(source: str, record: dict) -> tuple[bytes, dict]:
    block, index = (int(part) for part in source.split(":"))
    blob = TEXTURE_BLOBS / f"tex-{block}-{index}.raw"
    if not blob.is_file():
        raise SystemExit(f"FAILED: missing texture blob {blob.relative_to(ROOT)}")
    blob_bytes = blob.read_bytes()
    if record["blobHash"] != fnv1a64(blob_bytes):
        raise SystemExit(f"FAILED: {source} blob hash does not match the P34 registry")
    process = subprocess.run([str(DECODER), str(blob), "--raw"], capture_output=True)
    if process.returncode != 0:
        raise SystemExit(
            f"FAILED: committed decoder rejected {source}: " +
            process.stderr.decode("utf-8", "replace")[-400:])
    decoded = json.loads(process.stdout.decode("utf-8"))
    if decoded.get("status") != "ok":
        raise SystemExit(f"FAILED: committed decoder status for {source}: {decoded.get('status')}")
    width, height = decoded["width"], decoded["height"]
    rgba = bytes(decoded["rgba"])
    if (width, height) != (record["width"], record["height"]):
        raise SystemExit(
            f"FAILED: {source} decoded size {width}x{height} != registry "
            f"{record['width']}x{record['height']}")
    if len(rgba) != record["rgbaBytes"] or len(rgba) != width * height * 4:
        raise SystemExit(f"FAILED: {source} RGBA length {len(rgba)} != registry {record['rgbaBytes']}")
    rgba_fnv = fnv1a64(rgba)
    if rgba_fnv != record["rgbaHash"]:
        raise SystemExit(f"FAILED: {source} RGBA hash {rgba_fnv} != P34 registry {record['rgbaHash']}")
    meta = {
        "block": block,
        "index": index,
        "name": record["name"],
        "textureHash": record["textureHash"],
        "width": width,
        "height": height,
        "levels": record["levels"],
        "format": record["format"],
        "formatName": "DXT1/BC1",
        "payloadBytes": record["payloadBytes"],
        "descriptorBytes": record["descriptorBytes"],
        "blob": str(blob.relative_to(ROOT)).replace("\\", "/"),
        "blobSha256": "sha256:" + sha256_bytes(blob_bytes),
        "rgbaBytes": len(rgba),
        "rgbaSha256": "sha256:" + sha256_bytes(rgba),
        "rgbaFnv1a64": rgba_fnv,
    }
    return rgba, meta


def main() -> None:
    manifest_bytes = require_file(MANIFEST_IN, MANIFEST_IN_SHA256)
    uv_bytes = require_file(UV_IN, UV_IN_SHA256)
    require_file(READER_OUT, READER_OUT_SHA256)
    require_file(REGISTRY, REGISTRY_SHA256)
    if not DECODER.is_file():
        raise SystemExit("BLOCKED: missing committed decoder " + str(DECODER.relative_to(ROOT)))

    artifact = json.loads(manifest_bytes.decode("utf-8"))
    reader = json.loads(READER_OUT.read_text(encoding="utf-8"))
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    registry_by_source = {f"{r['block']}:{r['index']}": r for r in registry["textures"]}

    if artifact.get("kind") != "asset-reader.level-instance-textures" or artifact.get("version") != 1:
        raise SystemExit("FAILED: level-instance-textures.json kind/version changed")
    if artifact["mesh"]["vertexCount"] != EXPECTED_VERTICES or \
       reader["metadata"]["vertexCount"] != EXPECTED_VERTICES:
        raise SystemExit("FAILED: vertex count changed")
    if artifact["mesh"]["triangleCount"] != EXPECTED_TRIANGLES:
        raise SystemExit("FAILED: triangle count changed")
    if artifact["uv0"]["bytes"] != EXPECTED_UV_BYTES or len(uv_bytes) != EXPECTED_UV_BYTES:
        raise SystemExit("FAILED: UV byte count changed")
    if artifact["uv0"]["values"] != EXPECTED_UV_VALUES:
        raise SystemExit("FAILED: UV value count changed")
    if artifact["uv0"]["aggregate"] != "0x" + EXPECTED_UV_AGGREGATE:
        raise SystemExit("FAILED: UV aggregate changed")

    values = list(struct.unpack("<%df" % (len(uv_bytes) // 4), uv_bytes))
    if len(values) != EXPECTED_UV_VALUES or not all(v == v and abs(v) != float("inf") for v in values):
        raise SystemExit("FAILED: UV stream contains a non-finite value")
    if fnv1a64(uv_bytes) != EXPECTED_UV_AGGREGATE:
        raise SystemExit("FAILED: UV stream FNV aggregate changed")

    indices = reader["indices"]
    if len(indices) != EXPECTED_TRIANGLES * 3:
        raise SystemExit("FAILED: reader index count changed")
    if len(reader["draws"]) != EXPECTED_DRAWS or len(artifact["draws"]) != EXPECTED_DRAWS:
        raise SystemExit("FAILED: draw count changed")

    # ---------------------------------------------------------- textures
    TEX_OUT_DIR.mkdir(parents=True, exist_ok=True)
    textures = []
    by_source = {}
    for record in artifact["textures"]:
        source = f"{record['block']}:{record['index']}"
        if record["formatName"] != "DXT1/BC1":
            # The single BC3 source stays blocked: never decode or bind it here.
            by_source[source] = record
            continue
        registry_record = registry_by_source.get(source)
        if registry_record is None:
            raise SystemExit(f"FAILED: source {source} has no P34 decode record")
        rgba, meta = decode_bc1(source, registry_record)
        texture_id = f"level.albedo.{record['block']}.{record['index']}"
        file = TEX_OUT_DIR / (texture_id + ".rgba")
        file.write_bytes(rgba)
        if sha256_bytes(file.read_bytes()) != meta["rgbaSha256"][7:]:
            raise SystemExit(f"FAILED: {texture_id} written RGBA does not re-hash")
        meta["id"] = texture_id
        meta["source"] = source
        meta["rgbaPath"] = str(file.relative_to(ROOT)).replace("\\", "/")
        meta["bindableDraws"] = record["bindableDraws"]
        meta["draws"] = list(record["draws"])
        meta["triangles"] = record["triangles"]
        textures.append(meta)
        by_source[source] = meta

    if len(textures) != EXPECTED_BC1_SOURCES:
        raise SystemExit(f"FAILED: {len(textures)} BC1 sources, expected {EXPECTED_BC1_SOURCES}")
    if sum(texture["rgbaBytes"] for texture in textures) != EXPECTED_BC1_BYTES:
        raise SystemExit("FAILED: BC1 RGBA byte total changed")

    # ------------------------------------------------------------- draws
    draws = []
    bindable = []
    blocked = []
    for index, draw in enumerate(artifact["draws"]):
        if draw["instanceIndex"] != index:
            raise SystemExit(f"FAILED: draw {index} instance index is {draw['instanceIndex']}")
        reader_draw = reader["draws"][index]
        if reader_draw["instanceIndex"] != draw["instanceIndex"]:
            raise SystemExit(f"FAILED: reader draw order changed at {index}")
        if reader_draw["firstIndex"] != draw["firstIndex"] or \
           reader_draw["indexCount"] != draw["indexCount"]:
            raise SystemExit(f"FAILED: draw {index} index range differs between export and reader")
        # Recompute the P45-style FNV-1a 64 over the referenced UV pairs.
        chunk = bytearray()
        low_u = low_v = float("inf")
        high_u = high_v = float("-inf")
        for offset in range(draw["firstIndex"], draw["firstIndex"] + draw["indexCount"]):
            vertex = indices[offset]
            u = values[vertex * 2]
            v = values[vertex * 2 + 1]
            chunk += struct.pack("<ff", u, v)
            low_u, high_u = min(low_u, u), max(high_u, u)
            low_v, high_v = min(low_v, v), max(high_v, v)
        uv_hash = "0x" + fnv1a64(bytes(chunk))
        if uv_hash != draw["uvHash"]:
            raise SystemExit(
                f"FAILED: draw {index} UV hash {uv_hash} != P73a {draw['uvHash']}")
        source = f"{draw['resourceBlock']}:{draw['resourceIndex']}"
        source_record = by_source.get(source)
        if source_record is None:
            raise SystemExit(f"FAILED: draw {index} names unknown source {source}")
        is_bc1 = draw["bindable"] is True
        record = {
            "drawId": f"river.block27.instance{draw['instanceIndex']}."
                      f"primitive{draw['basePrimitiveIndex']}",
            "instanceIndex": draw["instanceIndex"],
            "basePrimitiveIndex": draw["basePrimitiveIndex"],
            "firstIndex": draw["firstIndex"],
            "indexCount": draw["indexCount"],
            "triangleCount": draw["triangleCount"],
            "section": "river.block27.node253",
            "uv0Available": draw["uv0Available"],
            "uvHash": uv_hash,
            "uvType": draw["uvType"],
            "uvOffset": draw["uvOffset"],
            "uvStride": draw["uvStride"],
            "uvRange": {
                "minU": low_u, "maxU": high_u, "minV": low_v, "maxV": high_v,
            },
            "material": draw["material"],
            "materialRow": draw["materialRow"],
            "albedoParameter": draw["albedoParameter"],
            "albedoTextureId": draw["albedoTextureId"],
            "albedoTexture": draw["texture"]["name"],
            "resourceBlock": draw["resourceBlock"],
            "resourceIndex": draw["resourceIndex"],
            "textureFormat": draw["texture"]["formatName"],
            "status": "bound-static-albedo-bc1" if is_bc1 else "blocked-bc3-alpha",
            "bindable": is_bc1,
            "blockedReason": None if is_bc1 else BLOCKED_REASON,
            "textureId": source_record["id"] if is_bc1 else None,
            "provenance":
                "P73a asset-reader export (UV0 + static g_tAlbedo identity) joined to the P34 "
                "engine-textures registry and the committed BC decoder",
        }
        draws.append(record)
        (bindable if is_bc1 else blocked).append(record)

    if len(bindable) != EXPECTED_BINDABLE_DRAWS or len(blocked) != EXPECTED_BLOCKED_DRAWS:
        raise SystemExit(
            f"FAILED: split is {len(bindable)}/{len(blocked)}, expected "
            f"{EXPECTED_BINDABLE_DRAWS}/{EXPECTED_BLOCKED_DRAWS}")
    bindable_triangles = sum(draw["triangleCount"] for draw in bindable)
    blocked_triangles = sum(draw["triangleCount"] for draw in blocked)
    if bindable_triangles != EXPECTED_BINDABLE_TRIANGLES or \
       blocked_triangles != EXPECTED_BLOCKED_TRIANGLES:
        raise SystemExit("FAILED: triangle split changed")
    if any(draw["textureId"] is not None for draw in blocked):
        raise SystemExit("FAILED: a blocked draw was bound to a texture")

    document = {
        "kind": "e1-drive.level-instance-textures",
        "version": 1,
        "level": artifact["level"],
        "nodeBlock": artifact["nodeBlock"],
        "geometryBlock": artifact["geometryBlock"],
        "scope": SCOPE,
        "source": {
            "assetReaderManifest": str(MANIFEST_IN.relative_to(ROOT)).replace("\\", "/"),
            "assetReaderManifestSha256": "sha256:" + MANIFEST_IN_SHA256,
            "uvStream": str(UV_IN.relative_to(ROOT)).replace("\\", "/"),
            "uvStreamSha256": "sha256:" + UV_IN_SHA256,
            "readerOutput": str(READER_OUT.relative_to(ROOT)).replace("\\", "/"),
            "readerOutputSha256": "sha256:" + READER_OUT_SHA256,
            "textureRegistry": str(REGISTRY.relative_to(ROOT)).replace("\\", "/"),
            "textureRegistrySha256": "sha256:" + REGISTRY_SHA256,
            "geometry": "_work/render-packet/packet.json (level mesh, world-space instance geometry)",
            "decoder": str(DECODER.relative_to(ROOT)).replace("\\", "/"),
        },
        "mesh": {
            "id": "river.block27.instances-all",
            "vertexCount": EXPECTED_VERTICES,
            "triangleCount": EXPECTED_TRIANGLES,
            "positionsSha256": artifact["mesh"]["positionsSha256"],
            "indicesSha256": artifact["mesh"]["indicesSha256"],
        },
        "uvStream": {
            "path": str(UV_IN.relative_to(ROOT)).replace("\\", "/"),
            "sha256": "sha256:" + UV_IN_SHA256,
            "encoding": "float32le",
            "components": 2,
            "values": EXPECTED_UV_VALUES,
            "bytes": EXPECTED_UV_BYTES,
            "vertexCount": EXPECTED_VERTICES,
            "aggregate": "0x" + EXPECTED_UV_AGGREGATE,
            "declaration": artifact["uv0"]["declaration"],
        },
        "sampler": SAMPLER,
        "draws": draws,
        "textures": textures,
        "coverage": {
            "draws": EXPECTED_DRAWS,
            "triangles": EXPECTED_TRIANGLES,
            "texturedDraws": EXPECTED_BINDABLE_DRAWS,
            "texturedTriangles": EXPECTED_BINDABLE_TRIANGLES,
            "diagnosticDraws": EXPECTED_BLOCKED_DRAWS,
            "diagnosticTriangles": EXPECTED_BLOCKED_TRIANGLES,
            "blockedReason": BLOCKED_REASON,
        },
        "limits": [
            "static g_tAlbedo image only: g_tMaterial, material colour, blend state, shader stages, "
            "sampler wrap/filter, mip chain and sRGB are not applied",
            "the four BC3 cab draws keep their real UV0 and source identity but no pixel, alpha rule, "
            "texture or UV is invented; they stay diagnostic",
            "source images are 32x16 BC1 at mip0; no upscale or invented detail",
            "no renderer/GPU/browser claim: this tool only exports data",
        ],
    }
    document["contentHash"] = content_hash(document)

    text = json.dumps(document, indent=2, sort_keys=True) + "\n"
    MANIFEST_OUT.write_text(text, encoding="utf-8")
    written = MANIFEST_OUT.read_bytes()

    print(json.dumps({
        "output": str(MANIFEST_OUT.relative_to(ROOT)).replace("\\", "/"),
        "bytes": len(written),
        "sha256": "sha256:" + sha256_bytes(written),
        "contentHash": document["contentHash"],
        "draws": len(draws),
        "triangles": EXPECTED_TRIANGLES,
        "bindable": {"draws": len(bindable), "triangles": bindable_triangles},
        "blocked": {"draws": len(blocked), "triangles": blocked_triangles,
                    "reason": BLOCKED_REASON},
        "textures": len(textures),
        "textureBytes": sum(texture["rgbaBytes"] for texture in textures),
        "uv": {"values": EXPECTED_UV_VALUES, "bytes": EXPECTED_UV_BYTES,
               "sha256": "sha256:" + UV_IN_SHA256},
        "textureFiles": [texture["rgbaPath"] for texture in textures],
    }, indent=2))


if __name__ == "__main__":
    main()
