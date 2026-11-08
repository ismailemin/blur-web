"""Read-only PAK / texture helpers for Blur Web VFX recovery.

- `pak_index`: independent implementation of the V2 PAK FAT reader used by
  `tools/inspect_asset_layout.py` (magic 2KAP, version 2, FAT stride 40/64,
  XOR path table). It only lists entries and validates payload bounds.
- `decode_packet_zlib`: codec-4 packet stream (u32 0x10000 packet size, then
  per-packet u32 stored size; 0xFFFFFFFF means a stored raw packet).
- `read_texture`: PC `.texture` container (84-byte header, texels at 84).
  Mip chains are complete in these files; only the top mip is decoded.
"""
from __future__ import annotations

import io
import struct
import zlib
from pathlib import Path

XOR_KEY = b"xVXo40j3@$%\\%`"
PACKET = 65536
LIMIT = 16 * 1024 * 1024


class PakError(ValueError):
    pass


def pak_index(path: Path) -> dict:
    size = path.stat().st_size
    with path.open("rb") as stream:
        prefix = stream.read(48)
        if len(prefix) != 48 or prefix[:4] != b"2KAP":
            raise PakError(f"{path.name}: unsupported preheader")
        version, sector, header_size = struct.unpack_from("<III", prefix, 4)
        if version != 2:
            raise PakError(f"{path.name}: unsupported version {version}")
        if header_size != 32 or not 512 <= sector <= 32768 or sector & (sector - 1):
            raise PakError(f"{path.name}: invalid header/sector")
        codec, fat_type = prefix[16], prefix[17]
        string_block, fat_block = struct.unpack_from("<II", prefix, 36)
        metadata_end = sector + string_block + fat_block
        if not sector < metadata_end <= min(size, LIMIT):
            raise PakError(f"{path.name}: metadata outside file/limit")
        stream.seek(sector)
        string_size = struct.unpack("<I", stream.read(4))[0]
        if string_size + 4 > string_block:
            raise PakError(f"{path.name}: string table exceeds block")
        raw = stream.read(string_size)
        strings = bytes(byte ^ XOR_KEY[(i + 1) % len(XOR_KEY)]
                        for i, byte in enumerate(raw))
        stream.seek(sector + string_block)
        count, fat_size = struct.unpack("<II", stream.read(8))
        stride = {0: 40, 1: 64}.get(fat_type)
        if stride is None or count * stride != fat_size or fat_size + 8 > fat_block:
            raise PakError(f"{path.name}: invalid FAT geometry")
        fat = stream.read(fat_size)
        if len(fat) != fat_size:
            raise PakError(f"{path.name}: truncated FAT")
        entries = []
        for i in range(count):
            crc, string_offset, _parent, logical, _timestamp, start, _unknown, stored = \
                struct.unpack_from("<IIIIQQII", fat, i * stride)
            if string_offset >= len(strings):
                raise PakError(f"{path.name}: path outside string table")
            end = strings.find(b"\0", string_offset)
            if end < 0:
                raise PakError(f"{path.name}: unterminated path")
            name = strings[string_offset:end].decode("utf-8", errors="replace")
            directory = start == 0xFFFFFFFFFFFFFFFF
            offset = None if directory else start * sector
            if not directory and (offset < metadata_end or offset + stored > size):
                raise PakError(f"{path.name}: payload bounds invalid for {name}")
            entries.append({"path": name, "directory": directory, "offset": offset,
                            "stored_bytes": stored, "logical_bytes": logical,
                            "path_crc32": f"{crc:08x}", "fat_index": i})
    return {"file": path.name, "bytes": size, "version": version, "codec": codec,
            "codec_name": {1: "raw", 2: "zlib", 3: "xmem", 4: "packet-zlib",
                           5: "packet-xmem"}.get(codec, "unknown"),
            "fat_type": fat_type, "metadata_end": metadata_end,
            "entries": [row for row in entries if not row["directory"]]}


def find_entry(index: dict, path: str) -> dict:
    wanted = path.lower().replace("/", "\\")
    for row in index["entries"]:
        if row["path"].lower().replace("/", "\\") == wanted:
            return row
    raise PakError(f"missing PAK entry {path}")


def read_entry_bytes(pak: Path, entry: dict) -> bytes:
    with pak.open("rb") as stream:
        stream.seek(entry["offset"])
        return stream.read(entry["stored_bytes"])


def decode_packet_zlib(data: bytes, logical: int) -> bytes:
    if not 1 <= logical <= LIMIT or len(data) < 8:
        raise PakError("asset outside bounded packet decoder scope")
    if struct.unpack_from("<I", data)[0] != PACKET:
        raise PakError("unsupported packet size")
    cursor = 4
    out = bytearray()
    count = 0
    max_packets = (logical + PACKET - 1) // PACKET + 1
    if len(data) > 4 + max_packets * (PACKET + 4):
        raise PakError("packed asset outside limit")
    while cursor < len(data):
        count += 1
        if count > max_packets or cursor + 4 > len(data):
            raise PakError("invalid packet header/count")
        stored = struct.unpack_from("<I", data, cursor)[0]
        cursor += 4
        raw = stored == 0xFFFFFFFF
        size = PACKET if raw else stored
        if not 1 <= size <= PACKET or cursor + size > len(data):
            raise PakError("invalid packet payload bounds")
        expected = min(PACKET, logical - len(out))
        if not expected and (raw or cursor + size != len(data) or logical % PACKET):
            raise PakError("unexpected final packet")
        payload = data[cursor:cursor + size]
        cursor += size
        if raw:
            out.extend(payload[:expected])
        else:
            inflater = zlib.decompressobj(-15)
            decoded = inflater.decompress(payload, expected + 1)
            if (len(decoded) != expected or not inflater.eof
                    or inflater.unused_data or inflater.unconsumed_tail):
                raise PakError("invalid DEFLATE stream or decoded packet length")
            out.extend(decoded)
    if len(out) != logical:
        raise PakError("decoded asset length mismatch")
    return bytes(out)


FORMATS = {
    int.from_bytes(b"DXT1", "little"): ("BC1", 8),
    int.from_bytes(b"DXT3", "little"): ("BC2", 16),
    int.from_bytes(b"DXT5", "little"): ("BC3", 16),
}


def read_texture(decoded: bytes) -> dict:
    if len(decoded) < 84 or decoded[:8] != b"Texture\0":
        raise PakError("not a PC texture")
    if struct.unpack_from("<I", decoded, 8)[0] != len(decoded):
        raise PakError("texture size field mismatch")
    if decoded[16:24] != b"Header\0\0" or decoded[40:48] != b"Data\0\0\0\0":
        raise PakError("unsupported texture layout")
    width, height, depth, levels, fmt, usage, kind = struct.unpack_from("<7I", decoded, 56)
    if width > 4096 or height > 4096 or not width or not height or depth != 1 or kind != 3:
        raise PakError("texture dimensions/type outside scope")
    name, block = FORMATS.get(fmt, (None, None))
    if name is None and fmt != 21:
        raise PakError(f"unsupported texture format {fmt:#x}")
    texels = decoded[84:]
    top = 0
    if name:
        top = ((width + 3) // 4) * ((height + 3) // 4) * block
        full = top
        w, h = width, height
        for _ in range(1, levels):
            w = max(1, w // 2)
            h = max(1, h // 2)
            full += ((w + 3) // 4) * ((h + 3) // 4) * block
    else:
        top = width * height * 4
        full = top
        w, h = width, height
        for _ in range(1, levels):
            w = max(1, w // 2)
            h = max(1, h // 2)
            full += w * h * 4
    return {"width": width, "height": height, "levels": levels, "format": fmt,
            "formatLabel": name or "RGBA8", "usage": usage, "payloadBytes": len(texels),
            "topMipBytes": top, "fullChainBytes": full,
            "completeChain": len(texels) == full, "texels": texels}


def top_mip_rgba(tex: dict) -> bytes:
    if tex["formatLabel"] == "RGBA8":
        return tex["texels"][:tex["topMipBytes"]]
    from PIL import Image
    header = [124, 0x1007, tex["height"], tex["width"], 0, 0, 1] + [0] * 11
    header += [32, 4, tex["format"], 0, 0, 0, 0, 0, 0x1000, 0, 0, 0, 0]
    dds = b"DDS " + struct.pack("<31I", *header) + tex["texels"][:tex["topMipBytes"]]
    return Image.open(io.BytesIO(dds)).convert("RGBA").tobytes()


def top_mip_png(tex: dict, target: Path) -> None:
    from PIL import Image
    if tex["formatLabel"] == "RGBA8":
        image = Image.frombytes("RGBA", (tex["width"], tex["height"]),
                                tex["texels"][:tex["topMipBytes"]])
    else:
        header = [124, 0x1007, tex["height"], tex["width"], 0, 0, 1] + [0] * 11
        header += [32, 4, tex["format"], 0, 0, 0, 0, 0, 0x1000, 0, 0, 0, 0]
        dds = b"DDS " + struct.pack("<31I", *header) + tex["texels"][:tex["topMipBytes"]]
        image = Image.open(io.BytesIO(dds)).convert("RGBA")
    image.save(target)
