"""Read-only retail asset layout diagnostic; no executable or payload extraction."""
from __future__ import annotations

import argparse
import json
import struct
import zlib
from collections import Counter
from pathlib import Path

XOR_TABLE_KEY = b"xVXo40j3@$%\\%`"
CODECS = {1: "raw", 2: "zlib", 3: "xmem", 4: "packet-zlib", 5: "packet-xmem"}
LIMIT = 64 * 1024 * 1024


def pak_index(path: Path) -> dict:
    size = path.stat().st_size
    with path.open("rb") as stream:
        prefix = stream.read(48)
        if len(prefix) != 48 or prefix[:4] != b"2KAP":
            raise ValueError(f"{path.name}: unsupported preheader/endian")
        version, sector, header_size = struct.unpack_from("<III", prefix, 4)
        if version != 2:
            return {"file": path.name, "bytes": size, "version": version,
                    "status": "unsupported_version_in_this_diagnostic"}
        if header_size != 32 or not 512 <= sector <= 32768 or sector & (sector - 1):
            raise ValueError("Invalid V2 header/sector")
        codec, fat_type = prefix[16], prefix[17]
        string_block, fat_block = struct.unpack_from("<II", prefix, 36)
        metadata_end = sector + string_block + fat_block
        if not sector < metadata_end <= min(size, LIMIT):
            raise ValueError("Metadata outside file/diagnostic limit")
        stream.seek(sector)
        string_size = struct.unpack("<I", stream.read(4))[0]
        if string_size + 4 > string_block:
            raise ValueError("String table exceeds its block")
        raw = stream.read(string_size)
        strings = bytes(byte ^ XOR_TABLE_KEY[(i + 1) % len(XOR_TABLE_KEY)]
                        for i, byte in enumerate(raw))
        stream.seek(sector + string_block)
        count, fat_size = struct.unpack("<II", stream.read(8))
        stride = {0: 40, 1: 64}.get(fat_type)
        if stride is None or count * stride != fat_size or fat_size + 8 > fat_block:
            raise ValueError("Invalid FAT geometry")
        fat = stream.read(fat_size)
        if len(fat) != fat_size:
            raise ValueError("Truncated FAT")
        rows = []
        for i in range(count):
            crc, string_offset, parent, logical, timestamp, start, unknown, stored = \
                struct.unpack_from("<IIIIQQII", fat, i * stride)
            if string_offset >= len(strings):
                raise ValueError("Path outside string table")
            end = strings.find(b"\0", string_offset)
            if end < 0:
                raise ValueError("Unterminated path")
            name = strings[string_offset:end].decode("utf-8", errors="replace")
            directory = start == 0xFFFFFFFFFFFFFFFF
            offset = None if directory else start * sector
            if not directory and (offset < metadata_end or offset + stored > size):
                raise ValueError(f"Payload bounds invalid: {name}")
            rows.append({"path": name, "directory": directory, "offset": offset,
                         "stored_bytes": stored, "logical_bytes": logical,
                         "path_crc32": f"{crc:08x}", "fat_index": i})
    files = [row for row in rows if not row["directory"]]
    models = sorted((row for row in files if row["path"].lower().endswith(".model")),
                    key=lambda row: row["logical_bytes"])
    xt = sorted((row for row in files if row["path"].lower().endswith((".xt", ".xt2", ".flask"))),
                key=lambda row: row["logical_bytes"])
    return {"file": path.name, "bytes": size, "version": version, "status": "indexed",
            "codec": codec, "codec_name": CODECS.get(codec, "unknown"), "fat_type": fat_type,
            "entry_count": count, "file_count": len(files), "metadata_end": metadata_end,
            "extensions": dict(Counter(Path(row["path"]).suffix.lower() for row in files)),
            "smallest_models": models[:12], "smallest_xt": xt[:12], "entries": rows,
            "integrity_validation_performed": False}


def chunk_headers(path: Path) -> dict:
    """Read the platform marker and the first outer block; data blocks stay opaque."""
    with path.open("rb") as stream:
        data = stream.read(min(path.stat().st_size, 4096))
    if len(data) < 20:
        raise ValueError("Too short for platform marker plus block")
    name, size, count, kind, compression = struct.unpack_from("<8sIHbb", data, 4)
    if size < 16 or size + 4 > path.stat().st_size:
        raise ValueError("Outer chunk bounds invalid")
    children = []
    if kind == 0x43:
        offset = 20
        for _ in range(count):
            if offset + 16 > min(len(data), size + 4):
                raise ValueError("Child header bounds invalid")
            child_name, child_size, child_count, child_kind, child_compression = \
                struct.unpack_from("<8sIHbb", data, offset)
            if child_size < 16 or offset + child_size > size + 4:
                raise ValueError("Child size exceeds parent")
            children.append({"id": child_name.rstrip(b"\0").decode("ascii"), "offset": offset,
                             "bytes": child_size, "count": child_count,
                             "type": child_kind, "compression": child_compression})
            offset += child_size
    return {"file": str(path), "bytes": path.stat().st_size,
            "platform_marker_hex": data[:4].hex(), "outer_block": {
                "id": name.rstrip(b"\0").decode("ascii"), "offset": 4,
                "bytes": size, "count": count, "type": kind, "compression": compression},
            "children": children, "note": "Opaque data blocks are not interpreted as generic nested chunks."}


def model_sample(pak_path: Path, entry: dict) -> dict:
    """Inspect one small, single-packet deflate model in memory; never save its bytes."""
    if not 8 <= entry["stored_bytes"] <= 65536 or not 20 <= entry["logical_bytes"] <= 65536:
        raise ValueError("Sample exceeds the bounded one-packet diagnostic")
    with pak_path.open("rb") as stream:
        stream.seek(entry["offset"])
        payload = stream.read(entry["stored_bytes"])
    packet_size, compressed_size = struct.unpack_from("<II", payload)
    if packet_size != 65536 or compressed_size != len(payload) - 8:
        raise ValueError("Not the expected single compressed packet")
    inflater = zlib.decompressobj(-15)
    decoded = inflater.decompress(payload[8:], entry["logical_bytes"] + 1)
    if not inflater.eof or inflater.unconsumed_tail or inflater.unused_data or len(decoded) != entry["logical_bytes"]:
        raise ValueError("Decoded model length/stream termination mismatch")
    name, outer_size, child_count, kind, compression = struct.unpack_from("<8sIHbb", decoded, 4)
    if name.rstrip(b"\0") != b"Model" or kind != 0x43 or outer_size + 4 > len(decoded):
        raise ValueError("Invalid model container")
    children, offset = [], 20
    for _ in range(child_count):
        if offset + 16 > outer_size + 4:
            raise ValueError("Model child header out of bounds")
        child_name, child_size, count, child_kind, child_compression = struct.unpack_from("<8sIHbb", decoded, offset)
        if child_size < 16 or offset + child_size > outer_size + 4:
            raise ValueError("Model child out of bounds")
        children.append({"id": child_name.rstrip(b"\0").decode("ascii"),
                         "offset": offset, "bytes": child_size, "count": count,
                         "type": child_kind, "compression": child_compression})
        offset += child_size
    return {"path": entry["path"], "pak_offset": entry["offset"],
            "stored_bytes": len(payload), "packet_size": packet_size,
            "compressed_packet_bytes": compressed_size, "decoded_bytes": len(decoded),
            "outer_model_bytes": outer_size, "children": children,
            "note": "Single-packet format decode in memory only. No hash/signature validation or model rendering."}


def zlib_metadata_sample(pak_path: Path, entry: dict) -> dict:
    if not 0 < entry["logical_bytes"] <= 65536 or not 0 < entry["stored_bytes"] <= 65536:
        raise ValueError("Metadata sample exceeds diagnostic cap")
    with pak_path.open("rb") as stream:
        stream.seek(entry["offset"])
        stored = stream.read(entry["stored_bytes"])
    inflater = zlib.decompressobj()
    decoded = inflater.decompress(stored, entry["logical_bytes"] + 1)
    if not inflater.eof or inflater.unused_data or inflater.unconsumed_tail or len(decoded) != entry["logical_bytes"]:
        raise ValueError("Metadata sample length/stream mismatch")
    return {"path": entry["path"], "pak_offset": entry["offset"],
            "stored_bytes": len(stored), "decoded_bytes": len(decoded),
            "prefix_hex": decoded[:32].hex(), "prefix_ascii": repr(decoded[:32]),
            "integrity_validation_performed": False}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-dir", type=Path, default=Path("game-data/Blur"))
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    root = args.game_dir.resolve(strict=True)
    output = args.out.resolve()
    if output.is_relative_to(root):
        parser.error("Output must be outside game data")
    results = {"scope": "Read-only format diagnostics. Selected small payloads decoded in memory. No files extracted/executed; no hash/signature validation.",
               "paks": [pak_index(path) for path in sorted((root / "cache").glob("*.pak"))],
               "showroom": [chunk_headers(root / "levels/showroom" / name)
                            for name in ("level.level", "level.levelrender")]}
    root_pak = next(pak for pak in results["paks"] if pak["file"] == "root.pak")
    sample = next(row for row in root_pak["entries"]
                  if row["path"].lower() == "\\models\\objects\\usa_la_river\\misc\\trafficcylinder.model")
    results["model_sample"] = model_sample(root / "cache/root.pak", sample)
    gamedata = next(pak for pak in results["paks"] if pak["file"] == "gamedata.pak")
    sample_paths = {"\\gamedata\\levels\\vehicletestscene\\actorpack.xt", "\\gamedata\\xt\\vehicles.bin"}
    results["metadata_samples"] = [zlib_metadata_sample(root / "cache/gamedata.pak", row)
                                   for row in gamedata["entries"] if row["path"] in sample_paths]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for pak in results["paks"]:
        print(f"{pak['file']}: {pak['status']}, {pak.get('entry_count', '?')} entries")
    print(f"Saved {output}")


if __name__ == "__main__":
    main()
