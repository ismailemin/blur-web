"""Deterministic per-car material/albedo texture binding manifest.

Scope: every car in the E1 roster, their committed part manifests and their own
decoded ``.model`` files. For every draw it records the committed readers'
material binding, then resolves the referenced static texture to
``(name, hash, block, index)``, assembles the original PC descriptor plus a
complete mip chain, and decodes mip0 to RGBA with the committed native decoder.

This is data extraction only. It applies no shader, sampling, paint lookup,
light blend or renderer behaviour. Runtime-only inputs are reported with the
committed reader's exact reason, never guessed.

Read-only inputs:
  * ``_work/car-parts/cars/<slug>/manifest.json`` (part manifests)
  * ``_work/car-parts/cars/<slug>/scene-report.json`` (committed reader output)
  * ``_work/car-parts/models/<sha>.decoded`` (decoded models)
  * ``_work/build/asset-reader-native/Release/scene_inspect.exe``
  * ``_work/build/asset-reader-native/Release/texture_inspect.exe``
  * ``tools/inspect_car_materials.py`` and ``tools/inspect_car_level_assets.py``
    as independent, source-shaped cross-checks (imported, not modified).

Output (default ``_work/car-materials/roster``):
  * ``cars/<slug>/materials.json`` — the per-car manifest
  * ``cars/<slug>/textures/*.rawtexture`` — original descriptor + complete chain
  * ``cars/<slug>/textures/*.rgba`` — native mip0 RGBA8, row-major, no V flip
  * ``cars/<slug>/textures/*.png`` — the same pixels for human inspection
  * ``index.json`` — per-car coverage, hashes and texture counts
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import inspect_car_level_assets as car_reader  # noqa: E402  (committed diagnostic)
import inspect_car_materials as material_reader  # noqa: E402  (committed diagnostic)

SCENE_EXE = ROOT / "_work/build/asset-reader-native/Release/scene_inspect.exe"
TEXTURE_EXE = ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe"
CARS_ROOT = ROOT / "_work/car-parts/cars"
CARS_INDEX = CARS_ROOT / "index.json"
ROSTER = ROOT / "probes/e1-drive/cars/roster.json"
MANIFEST_KIND = "blur.car-material-texture-manifest"
MANIFEST_VERSION = 1
DECODER_MAX_DIMENSION = 512  # FORMAT-texture.md accepted PC decoder bound
ALLOWED_FORMATS = {
    int.from_bytes(b"DXT1", "little"): "DXT1/BC1",
    int.from_bytes(b"DXT3", "little"): "DXT3/BC2",
    int.from_bytes(b"DXT5", "little"): "DXT5/BC3",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def safe_name(name: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in "-_." else "_" for c in name).strip("_")
    return cleaned or "unnamed"


def json_text(value) -> str:
    return json.dumps(value, indent=2, ensure_ascii=True, allow_nan=False) + "\n"


def run_json(exe: Path, *args: str) -> tuple[dict, str, bytes]:
    if not exe.is_file():
        raise RuntimeError(f"missing committed reader: {exe}")
    process = subprocess.run(
        [str(exe), *args], capture_output=True, text=True, check=False
    )
    if process.returncode != 0:
        raise RuntimeError(
            f"{exe.name} {' '.join(args)} failed ({process.returncode}): {process.stderr.strip()}"
        )
    raw = process.stdout.encode("utf-8")
    try:
        parsed = json.loads(process.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{exe.name} did not return JSON: {error}") from error
    if parsed.get("status") != "ok":
        raise RuntimeError(f"{exe.name} returned status {parsed.get('status')}: {parsed}")
    return parsed, sha256_bytes(raw), raw


def descriptor_at(data: bytes, offset: int) -> dict:
    if offset < 0 or offset + 28 > len(data):
        raise RuntimeError(f"texture descriptor at {offset} is outside the model")
    width, height, depth, levels, fmt, usage, kind = struct.unpack_from(
        "<7I", data, offset
    )
    return {
        "width": width,
        "height": height,
        "depth": depth,
        "levels": levels,
        "format": fmt,
        "formatName": ALLOWED_FORMATS.get(fmt, f"0x{fmt:08x}"),
        "usage": usage,
        "type": kind,
    }


def chain_sizes(desc: dict) -> list[int]:
    """Exact mip byte sizes for one PC Display::TextureDesc (largest first)."""
    if desc["depth"] != 1 or desc["type"] != 3:
        raise ValueError(
            f"only 2D depth1/type3 is supported (depth={desc['depth']}, type={desc['type']})"
        )
    fmt = desc["format"]
    if fmt not in ALLOWED_FORMATS:
        raise ValueError(f"unsupported D3DFORMAT 0x{fmt:08x}")
    width, height, levels = desc["width"], desc["height"], desc["levels"]
    if not (1 <= width <= 8192 and 1 <= height <= 8192):
        raise ValueError(f"dimensions {width}x{height} outside 1..8192")
    maximum = max(width.bit_length() - 1, height.bit_length() - 1) + 1
    if not 1 <= levels <= maximum:
        raise ValueError(f"mip count {levels} outside 1..{maximum}")
    block = 8 if fmt == int.from_bytes(b"DXT1", "little") else 16
    return [
        max(1, (max(1, width >> level) + 3) // 4)
        * max(1, (max(1, height >> level) + 3) // 4)
        * block
        for level in range(levels)
    ]


def assemble_lod(data: bytes, lod: dict, previous: tuple[dict, bytes] | None):
    """Rebuild a complete mip chain without inventing a descriptor.

    Source: archive.cpp LOD reader + D3D11TextureLoad.cpp CopyTextureData2D.
    A populated later LOD supplies new largest mip(s); the existing lower tail
    is copied behind them. Only exact-aligning chains are accepted.
    """
    if lod["present"] != 1 or lod.get("headerBytes") != 28:
        raise ValueError("only present unpaired 28-byte PC descriptors are supported")
    desc = dict(lod["descriptor"])
    desc["formatName"] = ALLOWED_FORMATS.get(desc["format"], f"0x{desc['format']:08x}")
    sizes = chain_sizes(desc)
    header = data[lod["headerOffset"]: lod["headerOffset"] + 28]
    if struct.unpack("<7I", header) != (
        desc["width"], desc["height"], desc["depth"], desc["levels"],
        desc["format"], desc["usage"], desc["type"],
    ):
        raise ValueError("parsed descriptor differs from source bytes")
    payload = data[lod["dataOffset"]: lod["dataOffset"] + lod["dataBytes"]]
    if len(payload) != lod["dataBytes"]:
        raise ValueError("truncated source payload")
    covered = 0
    prefix_levels = 0
    for size in sizes:
        if covered == len(payload):
            break
        covered += size
        prefix_levels += 1
        if covered > len(payload):
            raise ValueError("source payload ends inside a mip level")
    if covered != len(payload):
        raise ValueError("source payload exceeds descriptor mip chain")
    chain = bytearray(sum(sizes))
    chain[: len(payload)] = payload
    segments = [{
        "kind": "new-top-mips",
        "modelOffset": lod["dataOffset"],
        "bytes": len(payload),
        "destinationOffset": 0,
        "sha256": sha256_bytes(payload),
    }]
    if len(payload) != len(chain):
        if previous is None:
            raise ValueError("partial initial texture has no existing mip tail")
        old, old_chain = previous
        difference = desc["levels"] - old["levels"]
        if (
            difference < 0
            or desc["format"] != old["format"]
            or max(1, desc["width"] >> difference) != old["width"]
            or max(1, desc["height"] >> difference) != old["height"]
            or sizes[difference:] != chain_sizes(old)
        ):
            raise ValueError("source mip tail dimensions/format do not align")
        destination = sum(sizes[:difference])
        if destination != len(payload) or len(old_chain) != len(chain) - destination:
            raise ValueError("source top mip prefix and copied tail overlap or leave a gap")
        chain[destination:] = old_chain
        segments.append({
            "kind": "previous-complete-mip-tail",
            "bytes": len(old_chain),
            "destinationOffset": destination,
            "sha256": sha256_bytes(old_chain),
        })
    return header + chain, (desc, bytes(chain)), segments, prefix_levels


def decode_native(raw_path: Path) -> dict:
    parsed, digest, raw = run_json(TEXTURE_EXE, str(raw_path), "--raw")
    rgba = bytes(parsed["rgba"])
    width, height = parsed["width"], parsed["height"]
    if width * height * 4 != len(rgba):
        raise RuntimeError(f"{raw_path.name}: RGBA size mismatch")
    return {
        "status": "ok",
        "width": width,
        "height": height,
        "rgba": rgba,
        "rgbaSha256": sha256_bytes(rgba),
        "jsonSha256": digest,
        "metadata": parsed.get("metadata"),
    }


def decode_pillow(desc: dict, chain: bytes) -> bytes:
    from PIL import Image

    header = [124, 0x1007, desc["height"], desc["width"], 0, 0, 1] + [0] * 11
    header += [32, 4, desc["format"], 0, 0, 0, 0, 0, 0x1000, 0, 0, 0, 0]
    image = Image.open(io.BytesIO(b"DDS " + struct.pack("<31I", *header) + chain))
    return image.convert("RGBA").tobytes()


def compare_native_pillow(desc: dict, native_rgba: bytes, pillow_rgba: bytes) -> dict:
    if len(native_rgba) != len(pillow_rgba):
        raise RuntimeError("independent decoder output size differs")
    dxt5 = int.from_bytes(b"DXT5", "little")
    differences = [
        (index, abs(a - b))
        for index, (a, b) in enumerate(zip(native_rgba, pillow_rgba))
        if a != b
    ]
    if any(
        not (desc["format"] == dxt5 and index % 4 == 3 and delta <= 1)
        for index, delta in differences
    ):
        first = differences[0]
        raise RuntimeError(
            "native/Pillow difference beyond documented BC3 alpha rounding at channel "
            f"{first[0]} (delta {first[1]})"
        )
    return {
        "matches": not differences,
        "differentChannels": len(differences),
        "maxDifference": max((delta for _, delta in differences), default=0),
        "policy": "exact for BC1/BC2; BC3 RGB exact, alpha <=1 because the source "
                  "decoder rounds interpolation while Pillow floors it",
        "pillowRgbaSha256": sha256_bytes(pillow_rgba),
        "pillowVersion": __import__("PIL").__version__,
    }


def write_texture_outputs(
    out_dir: Path, stem: str, desc: dict, raw: bytes, chain: bytes
) -> dict:
    textures = out_dir / "textures"
    textures.mkdir(parents=True, exist_ok=True)
    raw_path = textures / f"{stem}.rawtexture"
    raw_path.write_bytes(raw)
    native = decode_native(raw_path)
    if (native["width"], native["height"]) != (desc["width"], desc["height"]):
        raise RuntimeError(f"{stem}: native dimensions differ from descriptor")
    rgba_path = textures / f"{stem}.rgba"
    rgba_path.write_bytes(native["rgba"])
    from PIL import Image

    png_path = textures / f"{stem}.png"
    Image.frombytes("RGBA", (native["width"], native["height"]), native["rgba"]).save(png_path)
    pillow = decode_pillow(desc, chain)
    comparison = compare_native_pillow(desc, native["rgba"], pillow)
    return {
        "rawtexture": {
            "path": raw_path.relative_to(out_dir).as_posix(),
            "bytes": len(raw),
            "sha256": sha256_bytes(raw),
        },
        "rgba": {
            "path": rgba_path.relative_to(out_dir).as_posix(),
            "bytes": len(native["rgba"]),
            "sha256": native["rgbaSha256"],
            "mip": 0,
            "channelOrder": "RGBA8",
            "orientation": "row-major top-left, no vertical flip",
        },
        "png": {
            "path": png_path.relative_to(out_dir).as_posix(),
            "sha256": sha256_file(png_path),
        },
        "nativeDecoder": {
            "reader": "texture_inspect.exe --raw",
            "width": native["width"],
            "height": native["height"],
            "rgbaSha256": native["rgbaSha256"],
            "jsonSha256": native["jsonSha256"],
        },
        "independentPillow": comparison,
    }


def cpp_classification(draw: dict, scene_report: dict) -> str:
    if draw["albedoTexture"] is not None:
        return "static_albedo_shared"
    if draw["resourceBlock"] is not None:
        return "static_albedo_resource_block"
    binding = draw["binding"].lower()
    if "light" in binding:
        return "runtime_light_blend"
    if "paint" in binding:
        return "runtime_paint_lookup"
    if "_no_albedo" in binding:
        return "shader_no_albedo"
    return "unresolved"


def python_classification(draw: dict) -> str:
    status = draw["status"]
    if status == "static_albedo_image_resolved":
        return "static"
    if status == "runtime_light_blend":
        return "runtime_light_blend"
    if status == "shader_no_albedo":
        stem = Path(draw["effect"].lower()).stem.split("_")
        family = stem[1] if len(stem) > 1 else ""
        return "runtime_paint_lookup" if family in ("paint", "paintm") else "shader_no_albedo"
    return status


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out-dir", type=Path, default=ROOT / "_work/car-materials/roster"
    )
    parser.add_argument(
        "--cars-index", type=Path, default=CARS_INDEX,
        help="committed per-car index (mapping, model/manifest hashes)",
    )
    args = parser.parse_args()
    out_root = args.out_dir.resolve()
    for forbidden in (ROOT / "game-data", ROOT / "upstream"):
        if out_root.is_relative_to(forbidden.resolve()):
            parser.error(f"output must not be inside {forbidden.name}")
    out_root.mkdir(parents=True, exist_ok=True)

    index = json.loads(args.cars_index.read_text(encoding="utf-8"))
    roster = json.loads(ROSTER.read_text(encoding="utf-8"))
    roster_slugs = [car["slug"] for car in roster["cars"]]
    if index.get("kind") != "car-parts.car-model-index":
        raise RuntimeError("committed car index is not a car-parts.car-model-index")
    mapped = index.get("mapped", [])
    if len(mapped) != len(roster_slugs) or set(mapped) != set(roster_slugs):
        raise RuntimeError(
            f"committed car index maps {len(mapped)} cars, the e1-drive roster has "
            f"{len(roster_slugs)}"
        )
    if len(index.get("cars", [])) != len(roster_slugs):
        raise RuntimeError(
            f"committed car index has {len(index.get('cars', []))} rows, the e1-drive roster has "
            f"{len(roster_slugs)}"
        )
    cars = sorted(index["cars"], key=lambda row: row["slug"])

    summaries = []
    for car in cars:
        slug = car["slug"]
        name = car["name"]
        model_path = ROOT / car["decodedModel"]
        manifest_path = CARS_ROOT / slug / "manifest.json"
        committed_report_path = ROOT / car["sceneReport"]
        model_bytes = model_path.read_bytes()
        if sha256_bytes(model_bytes) != car["modelSha256"]:
            raise RuntimeError(f"{slug}: decoded model hash differs from the committed index")
        if sha256_file(manifest_path) != car["manifestSha256"].removeprefix("sha256:"):
            raise RuntimeError(f"{slug}: part manifest hash differs from the committed index")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("kind") != "blur.car-part-manifest":
            raise RuntimeError(f"{slug}: unexpected part manifest kind")
        if manifest["source"]["modelSha256"] != car["modelSha256"]:
            raise RuntimeError(f"{slug}: part manifest model hash mismatch")

        # Committed readers are re-run from the real bytes. The normal scene
        # report is compared with the committed file; resource metadata is new.
        scene, scene_sha, scene_raw = run_json(SCENE_EXE, str(model_path))
        resources, resources_sha, _ = run_json(SCENE_EXE, str(model_path), "--resources")
        committed_report = committed_report_path.read_bytes()
        scene_matches_committed = scene_raw == committed_report

        # Independent source-shaped parser (same layout as the C++ reader).
        old_reader = car_reader.Reader
        try:
            car_reader.Reader = material_reader.MaterialReader
            layout = car_reader.render_layout(model_bytes, "model")
        finally:
            car_reader.Reader = old_reader
        scene_end = next(c["end"] for c in layout["chunks"] if c["id"] == "Scene")
        blocks = material_reader.resource_blocks(model_bytes, layout["scene"], scene_end)
        render_list = next(
            node for node in blocks[0]["nodes"]
            if node["type"] == "RenderingData::RenderListNode_Common"
        )
        resolved, uv = material_reader.resolved_report(
            model_bytes, layout["scene"], blocks, render_list
        )
        python_draws = resolved["draws"]
        cpp_draws = scene["draws"]
        skipped = len(manifest.get("skippedEmptyDraws", []))
        if not (len(python_draws) == len(cpp_draws) == len(manifest["draws"]) + skipped):
            raise RuntimeError(
                f"{slug}: draw counts differ: python={len(python_draws)} "
                f"cpp={len(cpp_draws)} manifest={len(manifest['draws'])} "
                f"skippedEmpty={skipped}"
            )

        # C++ resource metadata lookup for cross-checking every LOD we assemble.
        cpp_textures: dict[tuple[int, int], dict] = {}
        for block in resources["resourceBlocks"]:
            for texture in block["textures"]:
                cpp_textures[(block["index"], texture["index"])] = texture

        texture_targets: dict[str, dict] = {}
        draw_records = []
        # The manifest may skip empty draws, so its draw entries are matched to
        # the scene by the recorded original index rather than by position.
        for part in manifest["draws"]:
            draw_index = part["index"]
            py = python_draws[draw_index]
            cpp = cpp_draws[draw_index]
            cpp_kind = cpp_classification(cpp, scene)
            py_kind = python_classification(py)
            static_cpp = cpp_kind.startswith("static_albedo")
            static_py = py_kind == "static"
            if (static_cpp != static_py) or (
                static_cpp and py_kind != "static"
            ) or (
                not static_cpp and py_kind != cpp_kind
            ):
                raise RuntimeError(
                    f"{slug}: draw {draw_index} classification differs: "
                    f"cpp={cpp_kind} python={py_kind}"
                )
            if cpp["uv0Available"] is not py["uv0"]["available"]:
                raise RuntimeError(f"{slug}: draw {draw_index} UV0 availability differs")

            material = None
            texture_ids: list[str] = []
            light_inputs = None
            parameter = None
            texture = py["knownTextures"].get("g_MeshTexture")
            if texture is not None:
                if py["status"] != "static_albedo_image_resolved":
                    raise RuntimeError(f"{slug}: draw {draw_index} has g_MeshTexture but is not static")
                info = texture["texture"]
                parameter = "g_MeshTexture"
                if info["kind"] == "shared":
                    source = scene["sharedTextures"][info["index"]]
                    texture_id = f"shared:{info['index']}:{safe_name(info['name'])}"
                    identity = {
                        "kind": "shared",
                        "name": info["name"],
                        "hash": source["hash"],
                        "sharedIndex": info["index"],
                        "dataOffset": source["dataOffset"],
                        "dataBytes": source["dataBytes"],
                    }
                else:
                    stored = blocks[info["block"]]["textures"][info["index"]]
                    texture_id = (
                        f"block:{info['block']}:{info['index']}:{safe_name(stored['name'])}"
                    )
                    identity = {
                        "kind": "resource-block",
                        "name": stored["name"],
                        "hash": stored["hash"],
                        "block": info["block"],
                        "index": info["index"],
                    }
                texture_ids.append(texture_id)
                target = texture_targets.setdefault(
                    texture_id, {**identity, "roles": set(), "drawIndices": []}
                )
                for key, value in identity.items():
                    if target[key] != value:
                        raise RuntimeError(f"{slug}: texture identity conflict for {texture_id}")
                target["roles"].add("albedo")
                target["drawIndices"].append(draw_index)
                assignment = texture["assignment"]
                if assignment["materialList"] != 0:
                    raise RuntimeError(f"{slug}: draw {draw_index} static texture in runtime list")
                constant = render_list["constants"]["materials"][assignment["materialIndex"]]
                material = {
                    "id": f"list0-material{assignment['materialIndex']}",
                    "parameter": parameter,
                    "stage": assignment["stage"],
                    "listIndex": 0,
                    "index": assignment["materialIndex"],
                    "typeName": constant["typeName"],
                    "archiveOffset": constant["archiveOffset"],
                    "fieldSerializedOffset": assignment["serializedOffset"],
                    "nodeTextureIndex": info["nodeTextureIndex"],
                }
            elif py["status"] == "runtime_light_blend":
                light_inputs = {}
                for off_name in ("g_sOffTexture", "g_sOnTexture"):
                    entry = py["knownTextures"].get(off_name)
                    if entry is None:
                        continue
                    info = entry["texture"]
                    if info["kind"] == "shared":
                        source = scene["sharedTextures"][info["index"]]
                        texture_id = f"shared:{info['index']}:{safe_name(info['name'])}"
                        identity = {
                            "kind": "shared", "name": info["name"],
                            "hash": source["hash"], "sharedIndex": info["index"],
                            "dataOffset": source["dataOffset"],
                            "dataBytes": source["dataBytes"],
                        }
                    else:
                        stored = blocks[info["block"]]["textures"][info["index"]]
                        texture_id = (
                            f"block:{info['block']}:{info['index']}:{safe_name(stored['name'])}"
                        )
                        identity = {
                            "kind": "resource-block", "name": stored["name"],
                            "hash": stored["hash"], "block": info["block"],
                            "index": info["index"],
                        }
                    target = texture_targets.setdefault(
                        texture_id, {**identity, "roles": set(), "drawIndices": []}
                    )
                    for key, value in identity.items():
                        if target[key] != value:
                            raise RuntimeError(
                                f"{slug}: texture identity conflict for {texture_id}"
                            )
                    target["roles"].add("light-blend-input")
                    if draw_index not in target["drawIndices"]:
                        target["drawIndices"].append(draw_index)
                    light_inputs[off_name] = texture_id

            runtime_reason = None
            if not static_py:
                runtime_reason = py["reason"]
            draw_records.append({
                "index": draw_index,
                "partId": part.get("partId"),
                "partKind": part.get("partKind"),
                "partName": part.get("partName"),
                "renderPartId": part.get("renderPartId"),
                "previewPartId": part.get("previewPartId"),
                "effect": py["effect"],
                "shaderFamily": Path(py["effect"].lower()).stem.split("_")[1]
                    if len(Path(py["effect"].lower()).stem.split("_")) > 1 else None,
                "noAlbedoDefine": py["noAlbedoDefine"],
                "status": py["status"],
                "binding": cpp["binding"],
                "uv0Available": cpp["uv0Available"],
                "albedoParameter": parameter,
                "material": material,
                "textureIds": texture_ids,
                "lightBlendInputs": light_inputs,
                "runtimeReason": runtime_reason,
                "materialCalls": [
                    {
                        "stage": call["stage"],
                        "listIndex": call["listIndex"],
                        "index": call["index"],
                        "typeName": call.get("type"),
                        "runtimeRebuiltList": bool(call.get("runtimeRebuiltList")),
                    }
                    for call in py["materialCalls"]
                ],
            })

        # Decode every referenced texture once. Resource-block textures use the
        # highest complete chain that fits the committed decoder's 512 bound.
        texture_records = []
        for texture_id in sorted(texture_targets):
            target = texture_targets[texture_id]
            record = {
                "id": texture_id,
                "kind": target["kind"],
                "name": target["name"],
                "hash": target["hash"],
                "roles": sorted(target["roles"]),
                "drawIndices": sorted(set(target["drawIndices"])),
            }
            if target["kind"] == "shared":
                texture = scene["sharedTextures"][target["sharedIndex"]]
                offset = texture["dataOffset"]
                desc = descriptor_at(model_bytes, offset)
                sizes = chain_sizes(desc)
                if 28 + sum(sizes) != texture["dataBytes"]:
                    raise RuntimeError(
                        f"{slug}: shared {target['name']} data bytes do not match its chain"
                    )
                chain = model_bytes[offset + 28: offset + texture["dataBytes"]]
                raw = model_bytes[offset: offset + texture["dataBytes"]]
                stem = f"shared-{target['sharedIndex']}-{safe_name(target['name'])}"
                decodable = (
                    desc["format"] in ALLOWED_FORMATS
                    and desc["width"] <= DECODER_MAX_DIMENSION
                    and desc["height"] <= DECODER_MAX_DIMENSION
                )
                reason = None
                if not decodable:
                    reason = (
                        f"descriptor {desc['width']}x{desc['height']} {desc['formatName']} "
                        f"is outside the committed decoder bound "
                        f"{DECODER_MAX_DIMENSION}x{DECODER_MAX_DIMENSION} or format"
                    )
                record.update({
                    "sharedIndex": target["sharedIndex"],
                    "dataOffset": texture["dataOffset"],
                    "dataBytes": texture["dataBytes"],
                    "descriptor": desc,
                    "levels": desc["levels"],
                    "source": "embedded PC TextureDesc + complete mip chain",
                    "decoded": None,
                    "undecodedReason": reason,
                    "lods": [{
                        "lod": 0,
                        "present": True,
                        "descriptor": desc,
                        "descriptorOffset": texture["dataOffset"],
                        "descriptorBytes": 28,
                        "payloadOffset": texture["dataOffset"] + 28,
                        "payloadBytes": texture["dataBytes"] - 28,
                        "completeMipBytes": sum(sizes),
                        "topMipLevels": desc["levels"],
                        "assembled": True,
                        "decodable": decodable,
                        "reason": reason,
                    }],
                })
                if decodable:
                    record["decoded"] = write_texture_outputs(
                        out_root / "cars" / slug, stem, desc, raw, chain
                    )
                    record["decoded"]["sourceLod"] = 0
                    record["decoded"]["source"] = "embedded complete chain"
            else:
                block_index, texture_index = target["block"], target["index"]
                stored = blocks[block_index]["textures"][texture_index]
                cpp_stored = cpp_textures.get((block_index, texture_index))
                if cpp_stored is None:
                    raise RuntimeError(f"{slug}: {texture_id} missing from committed resource metadata")
                if (cpp_stored["name"], cpp_stored["hash"]) != (stored["name"], stored["hash"]):
                    raise RuntimeError(f"{slug}: {texture_id} committed resource identity differs")
                record.update({
                    "block": block_index,
                    "index": texture_index,
                    "sampler": stored["sampler"],
                    "lods": [],
                    "decoded": None,
                    "undecodedReason": None,
                })
                previous = None
                best = None
                failed = False
                for lod in stored["lods"]:
                    if not lod["present"]:
                        record["lods"].append({
                            "lod": lod["lod"], "present": False, "decodable": False,
                            "reason": "not present in this source LOD stream",
                        })
                        continue
                    entry = {
                        "lod": lod["lod"],
                        "present": True,
                        "descriptorOffset": lod["headerOffset"],
                        "descriptorBytes": lod["headerBytes"],
                        "payloadOffset": lod["dataOffset"],
                        "payloadBytes": lod["dataBytes"],
                    }
                    try:
                        raw, previous, segments, top_levels = assemble_lod(
                            model_bytes, lod, previous
                        )
                    except (ValueError, struct.error) as error:
                        entry.update({
                            "descriptor": lod.get("descriptor"),
                            "assembled": False,
                            "decodable": False,
                            "reason": str(error),
                        })
                        record["lods"].append(entry)
                        failed = True
                        break
                    desc, chain = previous
                    cpp_lod = next(
                        (l for l in cpp_stored["lods"] if l["lod"] == lod["lod"]), None
                    )
                    if cpp_lod is None:
                        raise RuntimeError(f"{slug}: {texture_id} lod {lod['lod']} missing in C++")
                    for key in ("descriptor", "payloadOffset", "payloadBytes"):
                        if cpp_lod[key] != (lod["descriptor"] if key == "descriptor" else lod[
                            "dataOffset" if key == "payloadOffset" else "dataBytes"
                        ]):
                            raise RuntimeError(
                                f"{slug}: {texture_id} lod {lod['lod']} {key} differs from C++"
                            )
                    if cpp_lod["completeMipBytes"] != len(chain):
                        raise RuntimeError(
                            f"{slug}: {texture_id} lod {lod['lod']} complete bytes differ from C++"
                        )
                    if cpp_lod["topMipLevels"] != top_levels:
                        raise RuntimeError(
                            f"{slug}: {texture_id} lod {lod['lod']} top mip count differs from C++"
                        )
                    decodable = (
                        desc["format"] in ALLOWED_FORMATS
                        and desc["width"] <= DECODER_MAX_DIMENSION
                        and desc["height"] <= DECODER_MAX_DIMENSION
                    )
                    reason = None
                    if not decodable:
                        reason = (
                            f"descriptor {desc['width']}x{desc['height']} {desc['formatName']} "
                            f"exceeds the committed decoder bound "
                            f"{DECODER_MAX_DIMENSION}x{DECODER_MAX_DIMENSION} or has an "
                            "unsupported format"
                        )
                    entry.update({
                        "descriptor": desc,
                        "completeMipBytes": len(chain),
                        "topMipLevels": top_levels,
                        "sourceSegments": segments,
                        "assembled": True,
                        "decodable": decodable,
                        "reason": reason,
                    })
                    record["lods"].append(entry)
                    if decodable:
                        best = (lod["lod"], desc, chain, raw, segments)
                if best is not None:
                    chosen_lod, desc, chain, raw, segments = best
                    stem = (
                        f"block-{block_index}-{texture_index}-{safe_name(target['name'])}"
                        f"-lod{chosen_lod}-{desc['width']}x{desc['height']}"
                    )
                    decoded = write_texture_outputs(
                        out_root / "cars" / slug, stem, desc, raw, chain
                    )
                    decoded.update({
                        "sourceLod": chosen_lod,
                        "source": "assembled original descriptor + complete mip chain",
                        "sourceSegments": segments,
                    })
                    record["decoded"] = decoded
                else:
                    reasons = [entry.get("reason") for entry in record["lods"] if entry.get("reason")]
                    record["undecodedReason"] = (
                        reasons[0] if reasons else "no populated decodable mip chain"
                    )
                if failed and record["undecodedReason"] is None:
                    record["undecodedReason"] = "a later source LOD could not be assembled"
            texture_records.append(record)

        # Coverage is derived from the records, never hand-filled.
        static_draws = [d for d in draw_records if d["albedoParameter"] == "g_MeshTexture"]
        runtime_paint = [d for d in draw_records if d["status"] == "shader_no_albedo"
                         and (d["shaderFamily"] or "").lower() in ("paint", "paintm")]
        runtime_no_albedo = [
            d for d in draw_records
            if d["status"] == "shader_no_albedo"
            and (d["shaderFamily"] or "").lower() not in ("paint", "paintm")
        ]
        runtime_light = [d for d in draw_records if d["status"] == "runtime_light_blend"]
        shared_albedo_draws = [d for d in static_draws
                               if d["textureIds"][0].startswith("shared:")]
        block_draws = [d for d in static_draws
                       if d["textureIds"][0].startswith("block:")]
        part_groups: dict[str, dict] = {}
        for part in manifest["parts"]:
            owned = [d["index"] for d in draw_records if d["partId"] == part["id"]]
            preview = [index for index in sorted(part["draws"]) if index not in owned]
            part_groups[part["id"]] = {
                "partId": part["id"],
                "partKind": part["partKind"],
                "partName": part.get("name"),
                "proven": True,
                "drawIndices": owned,
                "manifestDrawIndices": sorted(part["draws"]),
                "previewOnlyDrawIndices": preview,
                "staticAlbedoDrawIndices": [],
                "textureIds": [],
            }
        unclassified = {
            "partId": None,
            "partKind": "unclassified",
            "partName": None,
            "proven": False,
            "drawIndices": [],
            "manifestDrawIndices": [],
            "previewOnlyDrawIndices": [],
            "staticAlbedoDrawIndices": [],
            "textureIds": [],
        }
        for draw in draw_records:
            group = part_groups.get(draw["partId"]) if draw["partId"] else unclassified
            if group is None:
                raise RuntimeError(f"{slug}: draw {draw['index']} points at unknown part {draw['partId']}")
            if draw["partId"] is None:
                unclassified["drawIndices"].append(draw["index"])
            if draw["albedoParameter"]:
                group["staticAlbedoDrawIndices"].append(draw["index"])
                for texture_id in draw["textureIds"]:
                    if texture_id not in group["textureIds"]:
                        group["textureIds"].append(texture_id)
        parts = [part_groups[key] for key in sorted(part_groups)]
        if unclassified["drawIndices"]:
            parts.append(unclassified)

        decoded_textures = [t for t in texture_records if t["decoded"]]
        total_rgba = sum(t["decoded"]["rgba"]["bytes"] for t in decoded_textures)
        total_raw = sum(t["decoded"]["rawtexture"]["bytes"] for t in decoded_textures)
        coverage = {
            "drawCount": len(draw_records),
            "partCount": len(manifest["parts"]),
            "drawsWithPartId": sum(1 for d in draw_records if d["partId"]),
            "drawsWithoutPartId": sum(1 for d in draw_records if not d["partId"]),
            "staticAlbedoDrawCount": len(static_draws),
            "staticAlbedoDrawsWithUv0": sum(1 for d in static_draws if d["uv0Available"]),
            "staticAlbedoSharedTextureDraws": len(shared_albedo_draws),
            "staticAlbedoResourceBlockDraws": len(block_draws),
            "runtimePaintLookupDrawCount": len(runtime_paint),
            "runtimeShaderNoAlbedoDrawCount": len(runtime_no_albedo),
            "runtimeLightBlendDrawCount": len(runtime_light),
            "unresolvedDrawCount": sum(
                1 for d in draw_records
                if d["status"] not in ("static_albedo_image_resolved", "runtime_light_blend",
                                       "shader_no_albedo")
            ),
            "textureReferenceDrawCount": sum(
                1 for d in draw_records if d["textureIds"] or d["lightBlendInputs"]
            ),
            "uniqueTextureCount": len(texture_records),
            "decodedTextureCount": len(decoded_textures),
            "undecodedTextureCount": len(texture_records) - len(decoded_textures),
            "decodedRgbaBytes": total_rgba,
            "decodedRawtextureBytes": total_raw,
            "textureRoleCounts": {
                role: sum(1 for t in texture_records if role in t["roles"])
                for role in ("albedo", "light-blend-input")
            },
        }
        if coverage["staticAlbedoDrawsWithUv0"] != coverage["staticAlbedoDrawCount"]:
            raise RuntimeError(f"{slug}: a statically textured draw lacks original UV0")

        output = {
            "kind": MANIFEST_KIND,
            "version": MANIFEST_VERSION,
            "source": {
                "car": {"slug": slug, "name": name},
                "model": {
                    "path": rel(model_path),
                    "sha256": car["modelSha256"],
                    "bytes": len(model_bytes),
                    "pakPath": car["pakPath"],
                    "pakRecord": car["record"],
                },
                "partManifest": {
                    "path": rel(manifest_path),
                    "sha256": sha256_file(manifest_path),
                    "kind": manifest["kind"],
                    "version": manifest["version"],
                },
                "sceneReport": {
                    "reader": "scene_inspect.exe",
                    "committedPath": rel(committed_report_path),
                    "committedSha256": sha256_bytes(committed_report),
                    "reproducedSha256": scene_sha,
                    "reproducedByteIdentical": scene_matches_committed,
                    "scope": scene["metadata"]["scope"],
                },
                "resourceMetadata": {
                    "reader": "scene_inspect.exe --resources",
                    "sha256": resources_sha,
                    "resourceBlocks": resources["resourceBlockCount"],
                    "loadedResourceBlocks": resources["loadedResourceBlocks"],
                },
                "independentParser": {
                    "reader": "tools/inspect_car_materials.py (imported, read-only)",
                    "sceneEnd": scene_end,
                    "resourceBlockCount": len(blocks),
                },
                "textureDecoder": {
                    "reader": "texture_inspect.exe --raw",
                    "pcFormatContract": "probes/asset-reader/FORMAT-texture.md",
                    "maxDimension": DECODER_MAX_DIMENSION,
                    "supportedFormats": sorted(ALLOWED_FORMATS.values()),
                },
            },
            "scope": {
                "drawSet": "first RenderList base primitives LOD0, object-local",
                "applies": "material row resolution and static image decode only",
                "materialsApplied": False,
                "shaderExecuted": False,
                "samplerApplied": False,
                "paintLookupRecovered": False,
                "lightBlendRecovered": False,
                "rendererClaim": False,
            },
            "coverage": coverage,
            "parts": parts,
            "draws": draw_records,
            "textures": texture_records,
            "limits": [
                "Only the first RenderList base primitives at LOD0 are inspected; later render "
                "lists, higher LODs, damage, paint variants and runtime light states are not imported.",
                "Texture images are decoded mip0 RGBA8. No sampling state, UV transform, colour "
                "space, sRGB, alpha blend, shader code, paint lookup or light blend is applied.",
                "Runtime-only draws keep the committed reader's reason and bind no image: "
                "_NO_ALBEDO paint uses a runtime g_sPaintMaterialTexture lookup, light draws blend "
                "off/on inputs with runtime g_vRenderColour.w and UV0.xy/zw, and other _a shaders "
                "do not sample an ordinary albedo image.",
                "Resource-block later LODs contain only new top mip levels; complete chains are "
                "assembled from the original descriptor plus copied lower tails. A chain whose "
                "dimensions exceed the committed decoder's 512x512 bound is recorded but not decoded.",
                "Draw-to-part identity is the committed part manifest's AABB evidence; draws whose "
                "corner is unclassified keep partId null and are reported in the unclassified group.",
                "No renderer or game claim is made; the decoded pixels are source images, not a "
                "reproduction of retail car appearance.",
            ],
        }

        car_dir = out_root / "cars" / slug
        car_dir.mkdir(parents=True, exist_ok=True)
        manifest_out = car_dir / "materials.json"
        manifest_out.write_text(json_text(output), encoding="utf-8")
        summaries.append({
            "slug": slug,
            "name": name,
            "manifest": f"cars/{slug}/materials.json",
            "manifestSha256": sha256_file(manifest_out),
            "coverage": coverage,
            "textures": {
                t["id"]: {
                    "name": t["name"],
                    "hash": t["hash"],
                    "kind": t["kind"],
                    "roles": t["roles"],
                    "decoded": bool(t["decoded"]),
                    "lod": t["decoded"]["sourceLod"] if t["decoded"] else None,
                    "width": t["decoded"]["nativeDecoder"]["width"] if t["decoded"] else None,
                    "height": t["decoded"]["nativeDecoder"]["height"] if t["decoded"] else None,
                    "rgbaSha256": t["decoded"]["rgba"]["sha256"] if t["decoded"] else None,
                    "undecodedReason": t["undecodedReason"],
                }
                for t in texture_records
            },
        })
        print(
            f"{slug}: draws={coverage['drawCount']} static={coverage['staticAlbedoDrawCount']} "
            f"textures={coverage['uniqueTextureCount']} decoded={coverage['decodedTextureCount']} "
            f"runtime(paint/light/no-albedo)="
            f"{coverage['runtimePaintLookupDrawCount']}/"
            f"{coverage['runtimeLightBlendDrawCount']}/"
            f"{coverage['runtimeShaderNoAlbedoDrawCount']}"
        )

    aggregate = {
        "kind": "blur.car-material-texture-index",
        "version": MANIFEST_VERSION,
        "carCount": len(summaries),
        "totals": {
            "draws": sum(s["coverage"]["drawCount"] for s in summaries),
            "staticAlbedoDraws": sum(s["coverage"]["staticAlbedoDrawCount"] for s in summaries),
            "uniqueTextures": sum(s["coverage"]["uniqueTextureCount"] for s in summaries),
            "decodedTextures": sum(s["coverage"]["decodedTextureCount"] for s in summaries),
            "decodedRgbaBytes": sum(s["coverage"]["decodedRgbaBytes"] for s in summaries),
            "decodedRawtextureBytes": sum(
                s["coverage"]["decodedRawtextureBytes"] for s in summaries
            ),
        },
        "cars": summaries,
        "limits": [
            "Per-car manifests are independent; identical texture names across cars are not "
            "assumed to be identical bytes.",
            "No renderer, shader, sampling or game behaviour is claimed.",
        ],
    }
    index_out = out_root / "index.json"
    index_out.write_text(json_text(aggregate), encoding="utf-8")
    print(json.dumps(aggregate["totals"], indent=2))
    print(f"wrote {rel(index_out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
