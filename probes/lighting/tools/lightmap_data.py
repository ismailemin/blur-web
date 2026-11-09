#!/usr/bin/env python3
"""Decode the retail static-world lightmaps for one level.

The static world lighting is baked into DXT5/BC3 textures stored as LOD0
resource-block textures in ``Level.levelstream``.  A material binds one through
its ``g_tLightmap`` field; the field is a texture slot in the node's
``RenderList`` texture-source list, which resolves to a ``(block, index)``
resource-block texture.  This module:

1. walks every stream chunk and every resource-block LOD0 item with the
   committed readers (``tools/inspect_car_level_assets.py`` and
   ``tools/inspect_car_materials.py``);
2. resolves every material ``g_tLightmap`` reference through the RenderList
   texture-source list;
3. extracts the texture blob (28-byte PC TextureDesc + encoded mip chain) and
   decodes mip 0 with the committed native decoder
   (``probes/asset-reader/src/texture_cli.cpp`` -> ``texture_inspect.exe``);
4. returns a deterministic ``lightmap`` block for the manifest.

Nothing is guessed.  A texture that the decoder rejects is reported as
``unsupported`` with its stream record and byte offsets and the block records
``decoded: false``.  A ``g_tLightmap`` reference that resolves outside the
decoded ``lightmap_*`` set is reported per reference in ``unsupported``; the
block then keeps ``decoded: true`` with ``complete: false`` and ``partial:
true``, so the decoded textures stay usable while the one unbound reference is
labelled instead of being dropped or replaced by a placeholder.

Upstream citations (read-only reference checkout, ``upstream/BlurRebuilt``):

  code/amax/game/Shaders/Common/Lighting.h:82-91
      g_tLightmap Source="<Lightmap>", UVSet="luxlightmap"
  code/amax/game/Shaders/Common/Lighting.h:109
      #pragma texformat g_tLightmap COMPRESSED_RGBA_S3TC_DXT5
  code/amax/game/Shaders/Common/Parameters.h:11
      TEXCOORD0 annotation xy(uv:0) | zw(uv:luxlightmap) | format(F16_4)
  code/mercury/library/graphics/shader/include/shader/lighting/Lightmap.h:16-38
      RGBLightmapNormalisedGamma and SunSkyLightmap decode rules
  probes/asset-reader/FORMAT-texture.md:34
      supported D3DFORMAT list (DXT1/DXT3/DXT5 and selected uncompressed)
  probes/asset-reader/src/texture_reader.cpp:13
      DXT1=0x31545844, DXT3=0x33545844, DXT5=0x35545844
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GAME = ROOT / "game-data/Blur"
LEVELS_DIR = GAME / "levels"
DECODER = ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe"

sys.path.insert(0, str(ROOT / "tools"))
import inspect_car_level_assets as car  # noqa: E402
import inspect_car_materials as cm  # noqa: E402
from inspect_level_instances import read_lists  # noqa: E402

# D3DFORMAT codes stored in the PC TextureDesc (texture_reader.cpp:13).
FORMAT_NAMES = {
    0x31545844: "DXT1/BC1",
    0x33545844: "DXT3/BC2",
    0x35545844: "DXT5/BC3",
    21: "A8R8G8B8",
    22: "X8R8G8B8",
    32: "A8B8G8R8",
    33: "X8B8G8R8",
    28: "A8",
    50: "L8",
}

LIGHTMAP_PREFIX = "lightmap_"
UV_SET = "luxlightmap"
UV_SOURCE = "TEXCOORD0.zw (shader/common/Parameters.h:11)"
SHADER_TERMS = {
    "sunSky": "fSkyOcclusion *= sample.g; fSunOcclusion *= sample.b "
              "(shader/lighting/Lightmap.h SunSkyLightmap)",
    "rgbNormalisedGamma": "colour *= (sample.rgb * sample.a)^2 "
                          "(shader/lighting/Lightmap.h RGBLightmapNormalisedGamma)",
}
SET_HASH_RULE = ("sha256 over canonical JSON of the per-texture (name, field) pairs sorted by "
                 "name; canonical JSON is sort_keys=True, separators=(',', ':'), UTF-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def _parse_item(data: bytes, cursor: int, lod: int):
    """Parse one streamed resource-block LOD item.

    Returns ``(textures, end_cursor, render_lists)``.  The LOD0 item carries the
    vertex/index buffers and nodes; higher LODs carry only textures.  This is
    the same layout ``inspect_car_materials.resource_blocks`` reads for a
    non-streamed file, split per item because a stream chunk stores one item per
    block LOD.
    """
    r = cm.MaterialReader(data, cursor)
    r.ar()
    r.ar()
    platform, lod_number = r.unpack("II")
    if platform != 2 or lod_number != lod:
        raise ValueError("resource item header platform/lod %d/%d, expected 2/%d at %d"
                         % (platform, lod_number, lod, cursor))
    lists = []
    if lod == 0:
        vertex_buffers = []
        for _ in range(r.vec(256)):
            if r.unpack("B") != 2:
                raise ValueError("null vertex buffer at %d" % r.p)
            version = r.ar(1)
            r.ar()
            stride = r.count(4096)
            elements = []
            for _ in range(r.vec(32)):
                r.ar()
                elements.append(dict(zip(("type", "method", "usage", "usageIndex"),
                                         r.unpack("4i"))))
            offsets = [r.unpack("H") for _ in range(r.vec(32))]
            if len(offsets) != len(elements):
                raise ValueError("vertex element offset count mismatch at %d" % r.p)
            for element, offset in zip(elements, offsets):
                element["offset"] = offset
            count = r.count(1000000)
            size = stride * count
            if version:
                r.ar()
                stored, alignment, compression = r.unpack("III")
                swap = r.unpack("B")
                if stored != size or alignment < 1 or alignment > 4096 \
                        or alignment & (alignment - 1) or compression or swap:
                    raise ValueError("unsupported vertex buffer blob at %d" % r.p)
                r.take((-r.p) % alignment)
            start = r.p
            r.take(size)
            vertex_buffers.append({"stride": stride, "vertexCount": count,
                                   "elements": elements, "dataOffset": start,
                                   "dataBytes": size})
        index_buffers = []
        for _ in range(r.vec(256)):
            if r.unpack("B") != 2:
                raise ValueError("null index buffer at %d" % r.p)
            version = r.ar(1)
            count, kind = r.unpack("II")
            if kind not in (0, 1) or count > 6000000:
                raise ValueError("unsupported index buffer at %d" % r.p)
            size = count * (2 if kind == 0 else 4)
            if version:
                r.ar()
                stored, alignment, compression = r.unpack("III")
                swap = r.unpack("B")
                if stored != size or alignment < 1 or alignment > 4096 \
                        or alignment & (alignment - 1) or compression or swap:
                    raise ValueError("unsupported index buffer blob at %d" % r.p)
                r.take((-r.p) % alignment)
            start = r.p
            r.take(size)
            index_buffers.append({"count": count, "width": 2 if kind == 0 else 4,
                                  "dataOffset": start, "dataBytes": size})
        node_count = r.vec(100000)
        resources = {"vertexBuffers": vertex_buffers, "indexBuffers": index_buffers,
                     "nodeCount": node_count, "firstNodeOffset": r.p}
        lists = read_lists(data, resources)
        r = cm.MaterialReader(data, resources["parsedNodesEnd"])
    count = r.count(16)
    textures = [cm.texture_lod(r, lod, 0) for _ in range(count)]
    return textures, r.p, lists


def scan_level(level: str) -> dict:
    """Scan one level's stream for LOD0 textures and g_tLightmap references.

    Returns a dict with every LOD0 texture record, the resolved references, and
    the set of lightmap names.  The scan is read-only.
    """
    folder = LEVELS_DIR / level
    render_path = folder / "Level.levelrender"
    stream_path = folder / "Level.levelstream"
    render = render_path.read_bytes()
    layout = car.render_layout(render, "level")
    scene = layout["scene"]
    records = scene["stream"]["chunks"]

    textures = {}
    texture_rows = []
    references = Counter()
    reference_materials = defaultdict(set)
    reference_records = defaultdict(set)

    with stream_path.open("rb") as stream:
        for record_index, record in enumerate(records):
            stream.seek(record["offset"])
            data = stream.read(record["storedBytes"])
            if len(data) != record["storedBytes"]:
                raise ValueError("short levelstream read for record %d" % record_index)
            car.stream_prefix(data, record)
            cursor = 24
            for item_index, item in enumerate(record["items"]):
                textures_here, cursor, lists = _parse_item(data, cursor, item["lod"])
                if item["lod"] != 0:
                    continue
                for texture_index, texture in enumerate(textures_here):
                    descriptor = texture.get("descriptor") or {}
                    row = {
                        "recordIndex": record_index,
                        "itemIndex": item_index,
                        "block": item["block"],
                        "index": texture_index,
                        "name": texture.get("name"),
                        "textureHash": texture.get("hash"),
                        "width": descriptor.get("width"),
                        "height": descriptor.get("height"),
                        "depth": descriptor.get("depth"),
                        "levels": descriptor.get("levels"),
                        "format": descriptor.get("format"),
                        "headerOffset": texture.get("headerOffset"),
                        "headerBytes": texture.get("headerBytes"),
                        "dataOffset": texture.get("dataOffset"),
                        "dataBytes": texture.get("dataBytes"),
                    }
                    texture_rows.append(row)
                    if row["name"] is not None:
                        textures[(item["block"], texture_index)] = row
                for render_list in lists:
                    sources = render_list["sources"]["texture"]
                    for material in render_list["constants"]:
                        for field in material["fields"]:
                            if field["name"] != "g_tLightmap" or field["type"] != 7 \
                                    or field["count"] != 1 or not field["values"]:
                                continue
                            slot = field["values"][0]
                            if not 0 <= slot < len(sources):
                                references[("slot-out-of-range", slot)] += 1
                                continue
                            source = sources[slot]
                            key = (source["block"], source["index"])
                            references[key] += 1
                            reference_materials[key].add(material["typeName"])
                            reference_records[key].add(record_index)
            if cursor != len(data):
                tail = data[cursor:]
                if any(tail) or len(tail) > 4096:
                    raise ValueError("record %d has %d trailing bytes (%d stored)"
                                     % (record_index, len(tail), len(data)))

    resolved = {}
    unresolved = []
    for key, count in sorted(references.items()):
        block, index = key
        if block == -1:
            shared = scene["sharedTextures"]
            if not 0 <= index < len(shared):
                unresolved.append({"key": list(key), "count": count,
                                   "reason": "shared texture index out of range",
                                   "records": sorted(reference_records[key]),
                                   "recordOffsets": [records[i]["offset"]
                                                     for i in sorted(reference_records[key])]})
                continue
            name = shared[index]["name"]
            resolved[name] = {
                "name": name, "kind": "shared", "block": -1, "index": index,
                "count": count, "materials": sorted(reference_materials[key]),
                "records": sorted(reference_records[key]),
            }
            continue
        row = textures.get(key)
        if row is None:
            unresolved.append({"key": list(key), "count": count,
                               "reason": "texture block/index not found in the LOD0 scan",
                               "records": sorted(reference_records[key]),
                               "recordOffsets": [records[i]["offset"]
                                                 for i in sorted(reference_records[key])]})
            continue
        if row["name"] is None:
            unresolved.append({"key": list(key), "count": count,
                               "reason": "texture has no LOD0 name",
                               "records": sorted(reference_records[key]),
                               "recordOffsets": [records[i]["offset"]
                                                 for i in sorted(reference_records[key])]})
            continue
        resolved[row["name"]] = {
            "name": row["name"], "kind": "resource-block", "block": block, "index": index,
            "count": count, "materials": sorted(reference_materials[key]),
            "records": sorted(reference_records[key]),
        }

    name_prefix = sorted({row["name"] for row in texture_rows
                          if row["name"] and row["name"].lower().startswith(LIGHTMAP_PREFIX)})
    referenced_lightmaps = sorted(name for name in resolved
                                  if name.lower().startswith(LIGHTMAP_PREFIX))
    referenced_other = sorted(name for name in resolved
                              if not name.lower().startswith(LIGHTMAP_PREFIX))
    return {
        "level": level,
        "renderPath": rel(render_path),
        "renderBytes": len(render),
        "renderSha256": sha256_bytes(render),
        "streamPath": rel(stream_path),
        "streamBytes": stream_path.stat().st_size,
        "streamSha256": sha256_file(stream_path),
        "recordCount": len(records),
        "textureCount": len(texture_rows),
        "textures": texture_rows,
        "references": resolved,
        "unresolvedReferences": unresolved,
        "namePrefixLightmaps": name_prefix,
        "referencedLightmaps": referenced_lightmaps,
        "referencedNonLightmaps": referenced_other,
        "unreferencedNamePrefixLightmaps": sorted(set(name_prefix) - set(referenced_lightmaps)),
        "referencedLightmapsMissingFromNamePrefix": sorted(
            set(referenced_lightmaps) - set(name_prefix)),
    }


def decode_blob(blob: bytes, label: str, temp_dir: Path) -> dict:
    """Decode one PC texture blob with the committed native decoder.

    The decoder CLI takes a file path.  The blob is bounded (<= 64 MiB by the
    decoder) and written under the caller's gitignored ``_work`` directory.
    """
    if not DECODER.exists():
        raise FileNotFoundError(
            "missing %s; build it with: python tools/verify_asset_probe.py"
            % rel(DECODER))
    temp_dir.mkdir(parents=True, exist_ok=True)
    path = temp_dir / (label + ".raw")
    path.write_bytes(blob)
    process = subprocess.run([str(DECODER), str(path), "--raw"],
                             capture_output=True, timeout=120)
    if process.returncode != 0 or not process.stdout:
        raise ValueError("committed decoder rejected %s: %s"
                         % (label, process.stderr.decode("utf-8", "replace")[-300:]))
    document = json.loads(process.stdout.decode("utf-8"))
    if document.get("status") != "ok":
        raise ValueError("committed decoder status %r for %s"
                         % (document.get("status"), label))
    width, height = document["width"], document["height"]
    rgba = bytes(document["rgba"])
    if len(rgba) != width * height * 4:
        raise ValueError("decoded RGBA length %d differs from %dx%d for %s"
                         % (len(rgba), width, height, label))
    metadata = document.get("metadata") or {}
    return {
        "width": width,
        "height": height,
        "rgba": rgba,
        "rgbaSha256": sha256_bytes(rgba),
        "format": metadata.get("formatCode"),
        "formatName": metadata.get("format"),
        "mipLevels": metadata.get("mipLevels"),
        "pixelDataOffset": metadata.get("pixelDataOffset"),
        "encodedMipChainBytes": metadata.get("encodedMipChainBytes"),
    }


def _set_hash(entries: list[dict], field: str) -> str:
    payload = json.dumps(
        [{"name": entry["name"], field: entry[field]} for entry in
         sorted(entries, key=lambda entry: entry["name"])],
        sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return sha256_bytes(payload)


def build_lightmap_block(level: str, temp_dir: Path | None = None) -> dict:
    """Build the deterministic ``lightmap`` manifest block for one level."""
    scan = scan_level(level)
    temp = temp_dir or (ROOT / "_work/lighting/decoded" / level)
    entries = []
    unsupported = []

    folder = LEVELS_DIR / level
    stream_path = folder / "Level.levelstream"
    render = (folder / "Level.levelrender").read_bytes()
    layout = car.render_layout(render, "level")
    records = layout["scene"]["stream"]["chunks"]
    chunk_cache = {}

    # Every g_tLightmap reference must resolve to a decoded lightmap_* texture.
    # An unresolved key or a non-lightmap target is a typed unsupported entry,
    # never a dropped reference or a placeholder texture.
    for unresolved in scan["unresolvedReferences"]:
        offsets = unresolved.get("recordOffsets") or []
        record_index = (unresolved.get("records") or [None])[0]
        unsupported.append({
            "name": None,
            "key": unresolved["key"],
            "count": unresolved["count"],
            "reason": unresolved["reason"],
            "records": unresolved.get("records", []),
            "bytePosition": {
                "recordIndex": record_index,
                "streamRecordOffset": offsets[0] if offsets else None,
            },
        })
    for name in scan["referencedNonLightmaps"]:
        reference = scan["references"][name]
        record_index = reference["records"][0] if reference["records"] else None
        unsupported.append({
            "name": name,
            "key": [reference["block"], reference["index"]],
            "count": reference["count"],
            "reason": "g_tLightmap resolves to a non-lightmap texture",
            "source": reference,
            "bytePosition": {
                "recordIndex": record_index,
                "streamRecordOffset": (records[record_index]["offset"]
                                       if record_index is not None else None),
                "block": reference["block"],
                "index": reference["index"],
            },
        })

    for name in scan["referencedLightmaps"]:
        reference = scan["references"][name]
        if reference["kind"] != "resource-block":
            unsupported.append({
                "name": name,
                "reason": "g_tLightmap resolves to a shared texture, not a resource-block texture",
                "source": reference,
            })
            continue
        row = next((item for item in scan["textures"]
                    if item["block"] == reference["block"]
                    and item["index"] == reference["index"]
                    and item["name"] == name), None)
        if row is None:
            unsupported.append({
                "name": name,
                "reason": "texture record disappeared between the reference and texture scans",
                "source": reference,
            })
            continue
        if row["format"] not in FORMAT_NAMES:
            unsupported.append({
                "name": name,
                "reason": "unsupported texture format %r" % row["format"],
                "bytePosition": {"recordIndex": row["recordIndex"],
                                 "headerOffset": row["headerOffset"],
                                 "format": row["format"]},
                "source": reference,
            })
            continue
        if row["headerBytes"] != 28:
            unsupported.append({
                "name": name,
                "reason": "unexpected PC TextureDesc size %r, expected 28"
                          % row["headerBytes"],
                "bytePosition": {"recordIndex": row["recordIndex"],
                                 "headerOffset": row["headerOffset"]},
                "source": reference,
            })
            continue

        record_info = records[row["recordIndex"]]
        chunk = chunk_cache.get(row["recordIndex"])
        if chunk is None:
            with stream_path.open("rb") as stream:
                stream.seek(record_info["offset"])
                chunk = stream.read(record_info["storedBytes"])
            if len(chunk) != record_info["storedBytes"]:
                raise ValueError("short levelstream read for record %d"
                                 % row["recordIndex"])
            chunk_cache[row["recordIndex"]] = chunk
        blob = (chunk[row["headerOffset"]:row["headerOffset"] + row["headerBytes"]]
                + chunk[row["dataOffset"]:row["dataOffset"] + row["dataBytes"]])
        try:
            decoded = decode_blob(blob, level + "." + name, temp)
        except (ValueError, json.JSONDecodeError) as error:
            unsupported.append({
                "name": name,
                "reason": str(error),
                "bytePosition": {"recordIndex": row["recordIndex"],
                                 "streamRecordOffset": record_info["offset"],
                                 "headerOffset": row["headerOffset"],
                                 "dataOffset": row["dataOffset"]},
                "source": reference,
            })
            continue

        if decoded["width"] != row["width"] or decoded["height"] != row["height"]:
            unsupported.append({
                "name": name,
                "reason": "decoded %dx%d differs from the descriptor %dx%d"
                          % (decoded["width"], decoded["height"],
                             row["width"], row["height"]),
                "bytePosition": {"recordIndex": row["recordIndex"],
                                 "headerOffset": row["headerOffset"]},
                "source": reference,
            })
            continue
        if decoded["format"] != row["format"]:
            unsupported.append({
                "name": name,
                "reason": "decoder format %r differs from the descriptor %r"
                          % (decoded["format"], row["format"]),
                "bytePosition": {"recordIndex": row["recordIndex"],
                                 "headerOffset": row["headerOffset"]},
                "source": reference,
            })
            continue
        if decoded["mipLevels"] != row["levels"]:
            unsupported.append({
                "name": name,
                "reason": "decoder mip count %r differs from the descriptor %r"
                          % (decoded["mipLevels"], row["levels"]),
                "bytePosition": {"recordIndex": row["recordIndex"],
                                 "headerOffset": row["headerOffset"]},
                "source": reference,
            })
            continue
        if decoded["pixelDataOffset"] != row["headerBytes"]:
            unsupported.append({
                "name": name,
                "reason": "decoder pixel offset %r differs from the descriptor size %r"
                          % (decoded["pixelDataOffset"], row["headerBytes"]),
                "bytePosition": {"recordIndex": row["recordIndex"],
                                 "headerOffset": row["headerOffset"]},
                "source": reference,
            })
            continue
        if decoded["encodedMipChainBytes"] != row["dataBytes"]:
            unsupported.append({
                "name": name,
                "reason": "decoder encoded bytes %r differ from the descriptor %r"
                          % (decoded["encodedMipChainBytes"], row["dataBytes"]),
                "bytePosition": {"recordIndex": row["recordIndex"],
                                 "headerOffset": row["headerOffset"]},
                "source": reference,
            })
            continue

        entries.append({
            "name": name,
            "width": row["width"],
            "height": row["height"],
            "format": row["format"],
            "formatName": FORMAT_NAMES[row["format"]],
            "levels": row["levels"],
            "bytes": len(blob),
            "payloadBytes": row["dataBytes"],
            "sha256": sha256_bytes(blob),
            "decodedRgbaBytes": len(decoded["rgba"]),
            "decodedRgbaSha256": decoded["rgbaSha256"],
            "referenceCount": reference["count"],
            "materials": reference["materials"],
            "source": {
                "kind": "resource-block",
                "block": row["block"],
                "index": row["index"],
                "streamRecordIndex": row["recordIndex"],
                "streamRecordOffset": record_info["offset"],
                "streamRecordBytes": record_info["storedBytes"],
                "headerOffsetInChunk": row["headerOffset"],
                "headerBytes": row["headerBytes"],
                "dataOffsetInChunk": row["dataOffset"],
                "dataBytes": row["dataBytes"],
            },
        })

    entries.sort(key=lambda entry: entry["name"])
    # Two separate facts, deliberately not collapsed into one flag:
    #   decoded   every lightmap_* texture of the set decoded and matched its
    #             descriptor (the texture set itself is complete);
    #   complete  every g_tLightmap reference resolved to one of those decoded
    #             textures, i.e. `unsupported` is empty.
    # A set can be decoded but not complete (downtown, highrise): the decoded
    # lightmap_* textures are real, hashed and exported, and the reference
    # outside the set stays a typed `unsupported` entry with its material,
    # stream record and byte position. It is never dropped and never replaced
    # by a placeholder texture.
    decoded = bool(entries) and len(entries) == len(scan["referencedLightmaps"])
    complete = decoded and not unsupported
    unsupported_references = sum(entry.get("count") or 1 for entry in unsupported)
    dimensions = Counter("%dx%d" % (entry["width"], entry["height"]) for entry in entries)
    formats = Counter(entry["format"] for entry in entries)
    total_bytes = sum(entry["bytes"] for entry in entries)
    set_sha = _set_hash(entries, "sha256") if entries else None
    set_rgba_sha = _set_hash(entries, "decodedRgbaSha256") if entries else None

    block = {
        "provenance": {
            "kind": "data",
            "source": "Level.levelstream LOD0 resource-block textures referenced by "
                      "material g_tLightmap through the RenderList texture-source list; "
                      "decoded mip 0 with probes/asset-reader texture_inspect",
            "reader": "probes/asset-reader/src/texture_reader.cpp (PC TextureDesc + DXT5/BC3)",
            "uvSet": UV_SET,
            "uvSource": UV_SOURCE,
            "shaderTerms": SHADER_TERMS,
            "formatSource": "probes/asset-reader/FORMAT-texture.md:34; "
                            "texture_reader.cpp:13",
            "setHashRule": SET_HASH_RULE,
            "referenceRule": "every lightmap_* texture is referenced by at least one "
                             "material g_tLightmap field; a reference outside that set is "
                             "reported as unresolved, never dropped. `decoded` means every "
                             "lightmap_* texture decoded and matched its descriptor; "
                             "`complete` means every g_tLightmap reference resolved to one of "
                             "them. `decoded` with `complete:false` is a partial set: the "
                             "decoded textures are real, the typed `unsupported` references "
                             "are not bound",
        },
        "kind": "texture-set",
        "decoded": decoded,
        "complete": complete,
        **({"partial": True} if decoded and not complete else {}),
        "unsupportedReferences": unsupported_references,
        "uvSet": UV_SET,
        "format": next(iter(formats)) if len(formats) == 1 else None,
        "formatName": (FORMAT_NAMES[next(iter(formats))]
                       if len(formats) == 1 and next(iter(formats)) in FORMAT_NAMES else None),
        "count": len(entries),
        "width": (entries[0]["width"] if entries and len(dimensions) == 1 else None),
        "height": (entries[0]["height"] if entries and len(dimensions) == 1 else None),
        "dimensions": dict(sorted(dimensions.items())),
        "bytes": total_bytes,
        "sha256": set_sha,
        "decodedRgbaSha256": set_rgba_sha,
        "textures": entries,
        "unsupported": unsupported,
        "referenceSummary": {
            "gTLightmapFields": sum(reference["count"]
                                    for reference in scan["references"].values()),
            "textures": len(entries),
            "materials": sorted({name for entry in entries for name in entry["materials"]}),
            "unresolved": scan["unresolvedReferences"],
            "unreferencedNamePrefixLightmaps": scan["unreferencedNamePrefixLightmaps"],
            "referencedLightmapsMissingFromNamePrefix":
                scan["referencedLightmapsMissingFromNamePrefix"],
            "referencedNonLightmaps": scan["referencedNonLightmaps"],
        },
        "source": ("manifest lightmap set for %s: %d DXT5/BC3 textures, %d bytes, "
                   "decoded mip 0 from %s" % (level, len(entries), total_bytes,
                                              scan["streamPath"]))
                  if complete else
                  ("manifest partial lightmap set for %s: %d decoded DXT5/BC3 textures, "
                   "%d bytes, decoded mip 0 from %s; %d g_tLightmap reference(s) outside "
                   "the decoded set are typed in `unsupported`"
                   % (level, len(entries), total_bytes, scan["streamPath"],
                      unsupported_references))
                  if decoded else
                  ("manifest lightmap set for %s: %d decoded DXT5/BC3 textures, %d bytes; "
                   "the full g_tLightmap set is unsupported (%d typed entries), see "
                   "unsupported" % (level, len(entries), total_bytes, len(unsupported))),
    }
    return block


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("level", nargs="?", default="usa_amboy")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    block = build_lightmap_block(args.level)
    text = json.dumps(block, indent=1, sort_keys=True, allow_nan=False) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    print(text)
    return 0 if block["decoded"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
