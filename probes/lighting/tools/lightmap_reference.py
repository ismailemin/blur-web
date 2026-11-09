#!/usr/bin/env python3
"""Independent reference for the decoded lightmap set.

This script deliberately does not import ``lightmap_data.py`` or
``build_manifest.py``.  It re-reads the committed ``Level.levelrender`` /
``Level.levelstream`` bytes with the committed low-level readers, re-resolves
every material ``g_tLightmap`` reference, re-extracts each texture blob and
re-decodes mip 0 with the committed native decoder.  The output is compared to
the manifest by ``verify_lightmap.mjs``.

Run:
  python probes/lighting/tools/lightmap_reference.py --levels river,amboy,gracia,longbeach
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GAME = ROOT / "game-data/Blur"
LEVELS = GAME / "levels"
DECODER = ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe"

sys.path.insert(0, str(ROOT / "tools"))
import inspect_car_level_assets as car  # noqa: E402
import inspect_car_materials as cm  # noqa: E402
from inspect_level_instances import read_lists  # noqa: E402

LEVEL_IDS = {
    "river": "usa_la_river",
    "amboy": "usa_amboy",
    "gracia": "spa_barcelona_gracia",
    "longbeach": "usa_la_longbeachdocks",
    "observatory": "usa_la_observatory",
    "downtown": "usa_la_downtown",
    "mharuna": "jpn_mharuna",
    "highrise": "usa_la_multiplayer_highrise",
    "shutoko": "jpn_tokyo_shutoko",
    "oval": "spa_barcelona_oval",
    "amboy-mp": "usa_amboy_multiplayer",
    "dumbo": "usa_ny_dumbo",
    "downtown-mp": "usa_la_downtown_multiplayer",
}
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


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rel(path: Path) -> str:
    # Keep the requested case (the manifests use ``Level.levelrender`` even on
    # case-insensitive Windows volumes where the on-disk name may be lower-case).
    return path.relative_to(ROOT).as_posix()


def parse_item(data: bytes, cursor: int, lod: int):
    """Independent parse of one streamed resource-block LOD item."""
    r = cm.MaterialReader(data, cursor)
    r.ar()
    r.ar()
    platform, number = r.unpack("II")
    if platform != 2 or number != lod:
        raise ValueError("item header %d/%d at %d, expected 2/%d" % (platform, number, cursor, lod))
    lists = []
    if lod == 0:
        for _ in range(r.vec(256)):
            if r.unpack("B") != 2:
                raise ValueError("null vertex buffer")
            version = r.ar(1)
            r.ar()
            stride = r.count(4096)
            elements = []
            for _ in range(r.vec(32)):
                r.ar()
                elements.append(dict(zip(("type", "method", "usage", "usageIndex"), r.unpack("4i"))))
            offsets = [r.unpack("H") for _ in range(r.vec(32))]
            if len(offsets) != len(elements):
                raise ValueError("vertex offset count")
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
                    raise ValueError("vertex blob")
                r.take((-r.p) % alignment)
            start = r.p
            r.take(size)
        for _ in range(r.vec(256)):
            if r.unpack("B") != 2:
                raise ValueError("null index buffer")
            version = r.ar(1)
            count, kind = r.unpack("II")
            if kind not in (0, 1) or count > 6000000:
                raise ValueError("index buffer")
            size = count * (2 if kind == 0 else 4)
            if version:
                r.ar()
                stored, alignment, compression = r.unpack("III")
                swap = r.unpack("B")
                if stored != size or alignment < 1 or alignment > 4096 \
                        or alignment & (alignment - 1) or compression or swap:
                    raise ValueError("index blob")
                r.take((-r.p) % alignment)
            start = r.p
            r.take(size)
        nodes = r.vec(100000)
        resources = {"vertexBuffers": [], "indexBuffers": [], "nodeCount": nodes,
                     "firstNodeOffset": r.p}
        lists = read_lists(data, resources)
        r = cm.MaterialReader(data, resources["parsedNodesEnd"])
    count = r.count(16)
    textures = [cm.texture_lod(r, lod, 0) for _ in range(count)]
    return textures, r.p, lists


def scan_level(short: str) -> dict:
    level = LEVEL_IDS[short]
    folder = LEVELS / level
    render_path = folder / "Level.levelrender"
    stream_path = folder / "Level.levelstream"
    render = render_path.read_bytes()
    layout = car.render_layout(render, "level")
    scene = layout["scene"]
    records = scene["stream"]["chunks"]

    textures = {}
    rows = []
    counts = Counter()
    materials = defaultdict(set)
    records_by_key = defaultdict(set)

    with stream_path.open("rb") as stream:
        for record_index, record in enumerate(records):
            stream.seek(record["offset"])
            data = stream.read(record["storedBytes"])
            if len(data) != record["storedBytes"]:
                raise ValueError("short stream record %d" % record_index)
            car.stream_prefix(data, record)
            cursor = 24
            for item_index, item in enumerate(record["items"]):
                item_textures, cursor, lists = parse_item(data, cursor, item["lod"])
                if item["lod"] != 0:
                    continue
                for texture_index, texture in enumerate(item_textures):
                    descriptor = texture.get("descriptor") or {}
                    row = {
                        "recordIndex": record_index,
                        "itemIndex": item_index,
                        "block": item["block"],
                        "index": texture_index,
                        "name": texture.get("name"),
                        "width": descriptor.get("width"),
                        "height": descriptor.get("height"),
                        "levels": descriptor.get("levels"),
                        "format": descriptor.get("format"),
                        "headerOffset": texture.get("headerOffset"),
                        "headerBytes": texture.get("headerBytes"),
                        "dataOffset": texture.get("dataOffset"),
                        "dataBytes": texture.get("dataBytes"),
                    }
                    rows.append(row)
                    if row["name"] is not None:
                        textures[(row["block"], row["index"])] = row
                for render_list in lists:
                    sources = render_list["sources"]["texture"]
                    for material in render_list["constants"]:
                        for field in material["fields"]:
                            if field["name"] != "g_tLightmap" or field["type"] != 7 \
                                    or field["count"] != 1 or not field["values"]:
                                continue
                            slot = field["values"][0]
                            if not 0 <= slot < len(sources):
                                raise ValueError("g_tLightmap slot out of range")
                            source = sources[slot]
                            key = (source["block"], source["index"])
                            counts[key] += 1
                            materials[key].add(material["typeName"])
                            records_by_key[key].add(record_index)
            if cursor != len(data):
                tail = data[cursor:]
                if any(tail) or len(tail) > 4096:
                    raise ValueError("record %d trailing bytes" % record_index)

    names = {}
    unresolved = []
    for key, count in counts.items():
        row = textures.get(key)
        if row is None or row["name"] is None:
            unresolved.append({
                "key": list(key),
                "count": count,
                "records": sorted(records_by_key[key]),
                "reason": "texture block/index not found in the LOD0 scan",
            })
            continue
        names[row["name"]] = {
            "count": count,
            "materials": sorted(materials[key]),
            "records": sorted(records_by_key[key]),
            "row": row,
        }
    lightmap_names = sorted(name for name in names if name.lower().startswith("lightmap_"))
    other_names = sorted(name for name in names if not name.lower().startswith("lightmap_"))
    prefix_names = sorted({row["name"] for row in rows
                           if row["name"] and row["name"].lower().startswith("lightmap_")})
    if set(prefix_names) != set(lightmap_names):
        raise ValueError("lightmap_* texture set differs from the g_tLightmap reference set")
    return {
        "level": level,
        "renderPath": rel(render_path),
        "renderBytes": len(render),
        "renderSha256": sha256(render),
        "streamPath": rel(stream_path),
        "streamBytes": stream_path.stat().st_size,
        "streamSha256": sha256_file(stream_path),
        "records": records,
        "rows": rows,
        "names": names,
        "lightmapNames": lightmap_names,
        "unresolved": unresolved,
        "otherNames": other_names,
    }


def decode(blob: bytes, label: str) -> dict:
    if not DECODER.exists():
        raise FileNotFoundError("missing %s" % rel(DECODER))
    temp = ROOT / "_work/lighting/reference" / (label + ".raw")
    temp.parent.mkdir(parents=True, exist_ok=True)
    temp.write_bytes(blob)
    process = subprocess.run([str(DECODER), str(temp), "--raw"],
                             capture_output=True, timeout=120)
    if process.returncode != 0 or not process.stdout:
        raise ValueError("decoder rejected %s: %s"
                         % (label, process.stderr.decode("utf-8", "replace")[-200:]))
    document = json.loads(process.stdout.decode("utf-8"))
    if document.get("status") != "ok":
        raise ValueError("decoder status %r for %s" % (document.get("status"), label))
    width, height = document["width"], document["height"]
    rgba = bytes(document["rgba"])
    if len(rgba) != width * height * 4:
        raise ValueError("decoded length mismatch for %s" % label)
    metadata = document.get("metadata") or {}
    return {
        "width": width,
        "height": height,
        "rgbaBytes": len(rgba),
        "rgbaSha256": sha256(rgba),
        "format": metadata.get("formatCode"),
        "formatName": metadata.get("format"),
        "mipLevels": metadata.get("mipLevels"),
        "pixelDataOffset": metadata.get("pixelDataOffset"),
        "encodedMipChainBytes": metadata.get("encodedMipChainBytes"),
    }


def set_hash(entries: list[dict], field: str) -> str:
    payload = json.dumps(
        [{"name": entry["name"], field: entry[field]} for entry in
         sorted(entries, key=lambda entry: entry["name"])],
        sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return sha256(payload)


def build_reference(short: str) -> dict:
    scan = scan_level(short)
    folder = LEVELS / scan["level"]
    stream_path = folder / "Level.levelstream"
    entries = []
    chunks = {}
    for name in scan["lightmapNames"]:
        info = scan["names"][name]
        row = info["row"]
        record = scan["records"][row["recordIndex"]]
        chunk = chunks.get(row["recordIndex"])
        if chunk is None:
            with stream_path.open("rb") as stream:
                stream.seek(record["offset"])
                chunk = stream.read(record["storedBytes"])
            if len(chunk) != record["storedBytes"]:
                raise ValueError("short stream record")
            chunks[row["recordIndex"]] = chunk
        blob = (chunk[row["headerOffset"]:row["headerOffset"] + row["headerBytes"]]
                + chunk[row["dataOffset"]:row["dataOffset"] + row["dataBytes"]])
        decoded = decode(blob, short + "." + name)
        if decoded["width"] != row["width"] or decoded["height"] != row["height"]:
            raise ValueError("decoded dimensions differ for %s" % name)
        if decoded["format"] != row["format"]:
            raise ValueError("decoded format differs for %s" % name)
        if decoded["mipLevels"] != row["levels"]:
            raise ValueError("decoded mip count differs for %s" % name)
        if decoded["pixelDataOffset"] != row["headerBytes"]:
            raise ValueError("decoded pixel offset differs for %s" % name)
        if decoded["encodedMipChainBytes"] != row["dataBytes"]:
            raise ValueError("decoded encoded bytes differ for %s" % name)
        entries.append({
            "name": name,
            "width": row["width"],
            "height": row["height"],
            "format": row["format"],
            "formatName": FORMAT_NAMES[row["format"]],
            "levels": row["levels"],
            "bytes": len(blob),
            "payloadBytes": row["dataBytes"],
            "sha256": sha256(blob),
            "decodedRgbaBytes": decoded["rgbaBytes"],
            "decodedRgbaSha256": decoded["rgbaSha256"],
            "referenceCount": info["count"],
            "source": {
                "kind": "resource-block",
                "block": row["block"],
                "index": row["index"],
                "streamRecordIndex": row["recordIndex"],
                "streamRecordOffset": record["offset"],
                "streamRecordBytes": record["storedBytes"],
                "headerOffsetInChunk": row["headerOffset"],
                "headerBytes": row["headerBytes"],
                "dataOffsetInChunk": row["dataOffset"],
                "dataBytes": row["dataBytes"],
            },
        })
    entries.sort(key=lambda entry: entry["name"])
    unsupported = [
        {
            "name": None,
            "key": entry["key"],
            "reason": entry["reason"],
        }
        for entry in scan["unresolved"]
    ] + [
        {
            "name": name,
            "reason": "g_tLightmap resolves to a non-lightmap texture",
        }
        for name in scan["otherNames"]
    ]
    unsupported.sort(key=lambda entry: (
        entry["name"] is not None,
        entry["name"] or "",
        entry.get("key") or [],
    ))
    decoded = bool(entries) and not unsupported
    dimensions = Counter("%dx%d" % (entry["width"], entry["height"]) for entry in entries)
    formats = Counter(entry["format"] for entry in entries)
    return {
        "schema": "blur-lighting-lightmap-reference/1",
        "short": short,
        "level": scan["level"],
        "source": {
            "render": {"path": scan["renderPath"], "bytes": scan["renderBytes"],
                       "sha256": scan["renderSha256"]},
            "stream": {"path": scan["streamPath"], "bytes": scan["streamBytes"],
                       "sha256": scan["streamSha256"]},
        },
        "lightmap": {
            "kind": "texture-set",
            "decoded": decoded,
            "uvSet": "luxlightmap",
            "format": next(iter(formats)) if len(formats) == 1 else None,
            "formatName": (FORMAT_NAMES[next(iter(formats))]
                           if len(formats) == 1 and next(iter(formats)) in FORMAT_NAMES else None),
            "count": len(entries),
            "width": (entries[0]["width"] if entries and len(dimensions) == 1 else None),
            "height": (entries[0]["height"] if entries and len(dimensions) == 1 else None),
            "dimensions": dict(sorted(dimensions.items())),
            "bytes": sum(entry["bytes"] for entry in entries),
            "sha256": set_hash(entries, "sha256"),
            "decodedRgbaSha256": set_hash(entries, "decodedRgbaSha256"),
            "textures": entries,
            "unsupported": unsupported,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--levels",
                        default="river,amboy,gracia,longbeach,observatory,downtown,"
                                "mharuna,highrise,shutoko,oval,amboy-mp,dumbo,"
                                "downtown-mp")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    shorts = [name.strip() for name in args.levels.split(",") if name.strip()]
    unknown = [name for name in shorts if name not in LEVEL_IDS]
    if unknown:
        parser.error("unknown level(s): " + ", ".join(unknown))
    document = {
        "schema": "blur-lighting-lightmap-reference/1",
        "kind": "lightmap-reference",
        "levels": {short: build_reference(short) for short in shorts},
    }
    text = json.dumps(document, indent=1, sort_keys=True, allow_nan=False) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
