"""Read-only UI/menu art access for the Blur Web UI-art probe.

Only reads `game-data/Blur/cache/*.pak` and writes under `_work/ui-art/`.
No retail bytes are written into the repository.

Format authority (all recovered, never guessed):

  * PAK V2 secure FAT + codec-4 packet-zlib:
    `tools/inspect_asset_layout.py` (committed reader).
  * `.bpr` = `2RZB` (on-disk) == the engine's `GetHeader("BZR2")` magic.
    `upstream/BlurRebuilt/.../bundler/ResourceBundleReader.cpp` +
    `ResourceBundleReaderImpl3.cpp`, `BundleHeader.h`, `ResourceHeader.h`,
    `ResourceTexture.h`, `ResourceTexture2D.h`, `ResourceBundlerDefines.h`.
  * `.texture` = compiled PC Texture container:
    `probes/asset-reader/FORMAT-texture.md` (committed decoder).
  * `.pf` = polygon font: `ui/Graphics/Font/UIPolygonFont.cpp` ReadFromFile.
  * `.dat` = bitmap font attributes: `ui/Graphics/Font/UIBitmapFont.cpp`.

Nothing here invents a format: every offset is read from a serialized field.
"""
from __future__ import annotations

import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402

GAME = ROOT / "game-data" / "Blur"
CACHE = GAME / "cache"
LIMIT = 64 * 1024 * 1024          # same bound the committed layout tool uses
PACKET = 65536


# --------------------------------------------------------------------------
# PAK access
# --------------------------------------------------------------------------
_INDEX_CACHE: dict[str, dict] = {}


def pak(name: str) -> dict:
    if name not in _INDEX_CACHE:
        index = pak_index(CACHE / name)
        if index.get("status") != "indexed":
            raise ValueError(f"{name}: unsupported pak ({index.get('status')})")
        index["_rows"] = {r["path"].lower(): r for r in index["entries"]
                          if not r["directory"]}
        _INDEX_CACHE[name] = index
    return _INDEX_CACHE[name]


def entry(name: str, path: str) -> dict:
    row = pak(name)["_rows"].get(path.lower())
    if row is None:
        raise KeyError(f"{name}:{path}")
    return row


def packet_decode(data: bytes, logical: int) -> bytes:
    """Codec 4 (`packet-zlib`): u32 65536 then [u32 stored][payload] packets.

    Same loop as `tools/prepare_asset_fixture.decode_packet_zlib`, but the
    caller supplies its own logical bound so the 44 MiB frontend bundle is
    readable.  Every packet is validated; a raw packet (-1) must be 64 KiB.
    """
    if not 1 <= logical <= LIMIT or len(data) < 8:
        raise ValueError("packet asset outside bounded decoder scope")
    if struct.unpack_from("<I", data)[0] != PACKET:
        raise ValueError("unsupported packet size")
    cursor = 4
    out = bytearray()
    packets = 0
    max_packets = (logical + PACKET - 1) // PACKET + 1
    while cursor < len(data):
        packets += 1
        if packets > max_packets or cursor + 4 > len(data):
            raise ValueError("invalid packet header/count")
        stored = struct.unpack_from("<I", data, cursor)[0]
        cursor += 4
        raw = stored == 0xFFFFFFFF
        size = PACKET if raw else stored
        if not 1 <= size <= PACKET or cursor + size > len(data):
            raise ValueError("invalid packet payload bounds")
        expected = min(PACKET, logical - len(out))
        if not expected and (raw or cursor + size != len(data) or logical % PACKET):
            raise ValueError("unexpected final packet")
        payload = data[cursor:cursor + size]
        cursor += size
        if raw:
            if size != expected:
                raise ValueError("raw packet size mismatch")
            out += payload
        else:
            inflater = zlib.decompressobj(-15)
            out += inflater.decompress(payload, expected + 1)
            if len(out) > logical or not inflater.eof:
                raise ValueError("malformed deflate packet")
    if len(out) != logical:
        raise ValueError("decoded length mismatch")
    return bytes(out)


def load(name: str, path: str) -> tuple[bytes, dict]:
    """Decode one pak entry and return (bytes, provenance)."""
    row = entry(name, path)
    with (CACHE / name).open("rb") as stream:
        stream.seek(row["offset"])
        packed = stream.read(row["stored_bytes"])
    codec = pak(name)["codec"]
    if codec == 2:
        decoded = zlib.decompress(packed)
    elif codec == 4:
        decoded = packet_decode(packed, row["logical_bytes"])
    else:
        raise ValueError(f"codec {codec} not in scope")
    if len(decoded) != row["logical_bytes"]:
        raise ValueError(f"{path}: decoded length {len(decoded)} != {row['logical_bytes']}")
    info = {
        "pak": name,
        "path": row["path"],
        "pakOffset": row["offset"],
        "storedBytes": row["stored_bytes"],
        "logicalBytes": row["logical_bytes"],
        "pathCrc32": row["path_crc32"],
        "fatIndex": row["fat_index"],
        "sha256": hashlib.sha256(decoded).hexdigest(),
    }
    return decoded, info


# --------------------------------------------------------------------------
# .texture  (compiled PC Texture container, FORMAT-texture.md)
# --------------------------------------------------------------------------
D3D_DXT1 = 0x31545844
D3D_DXT3 = 0x33545844
D3D_DXT5 = 0x35545844
D3D_A8R8G8B8 = 21
D3D_X8R8G8B8 = 22
D3D_A8B8G8R8 = 32
D3D_X8B8G8R8 = 33
D3D_A8 = 28
D3D_L8 = 50

TEXTURE_FORMAT_NAMES = {
    D3D_DXT1: "DXT1",
    D3D_DXT3: "DXT3",
    D3D_DXT5: "DXT5",
    D3D_A8R8G8B8: "A8R8G8B8",
    D3D_X8R8G8B8: "X8R8G8B8",
    D3D_A8B8G8R8: "A8B8G8R8",
    D3D_X8B8G8R8: "X8B8G8R8",
    D3D_A8: "A8",
    D3D_L8: "L8",
}

_TEXTURE_HEADER = 84   # 16 container + 16 header block + 4 + 4 + 16 data block + 28 desc


def parse_texture(data: bytes) -> dict:
    """Exact PC Texture container layout (FORMAT-texture.md).

    Returns the serialized descriptor and the mip byte span without decoding.
    """
    if len(data) < _TEXTURE_HEADER or len(data) > LIMIT:
        raise ValueError("texture outside bounded scope")
    if data[:8] != b"Texture\0":
        raise ValueError("texture container tag mismatch")
    total = struct.unpack_from("<I", data, 8)[0]
    count, kind = struct.unpack_from("<HH", data, 12)
    if total != len(data) or count != 2 or kind != 0x43:
        raise ValueError("unsupported texture container header")
    if data[16:24] != b"Header\0\0" or data[40:48] != b"Data\0\0\0\0":
        raise ValueError("unsupported texture block order")
    version, flags = struct.unpack_from("<II", data, 32)
    if version != 0:
        raise ValueError("unsupported texture header version")
    width, height, depth, levels, fmt, usage, tex_type = struct.unpack_from("<7I", data, 56)
    if not (1 <= width <= 8192 and 1 <= height <= 8192):
        raise ValueError("texture dimensions outside decoder scope")
    if depth != 1 or tex_type != 3:
        raise ValueError("only 2D textures are in scope")
    if not 1 <= levels <= 20:
        raise ValueError("impossible mip count")
    return {
        "width": width,
        "height": height,
        "depth": depth,
        "levels": levels,
        "format": fmt,
        "formatName": TEXTURE_FORMAT_NAMES.get(fmt, f"unknown-{fmt}"),
        "usage": usage,
        "type": tex_type,
        "flags": flags,
        "texelOffset": _TEXTURE_HEADER,
        "texelBytes": len(data) - _TEXTURE_HEADER,
    }


def _mip_size(fmt: int, w: int, h: int) -> int:
    if fmt == D3D_DXT1:
        return max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * 8
    if fmt in (D3D_DXT3, D3D_DXT5):
        return max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * 16
    return w * h * 4


def expected_mip_bytes(fmt: int, w: int, h: int, levels: int) -> int:
    total = 0
    for level in range(levels):
        total += _mip_size(fmt, max(1, w >> level), max(1, h >> level))
    return total


# --------------------------------------------------------------------------
# BZR2 (`.bpr`) resource bundle
# --------------------------------------------------------------------------
BPR_MAGIC = b"2RZB"
BPR_FORMATS = {1: "DXT1", 2: "DXT2", 3: "DXT3", 4: "DXT4", 5: "DXT5",
               6: "A8R8G8B8", 7: "L8", 8: "A32R32G32B32", 9: "DXN"}
BPR_BYTES_PER_BLOCK = {1: 8, 2: 16, 3: 16, 4: 16, 5: 16, 6: 4, 7: 1, 8: 16, 9: 16}
BPR_BLOCK_WIDTH = {1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 1, 7: 1, 8: 1, 9: 4}


def parse_bpr(data: bytes) -> dict:
    """BZR2 v3 (platform PC, uncompressed) bundle.

    Header (BundleHeader.h, no magic/version in the reader struct):
      u8 platform, u16 resourceInfoSize, u16 stringTableOffset,
      u16 flags, u32 uncompressedDataSize, u32 compressedDataSize

    Resource (ResourceHeader.h + ResourceTexture.h + ResourceTexture2D.h):
      u16 offsetNext, u16 offsetString, u32 offsetData, u16 type, u16 flags,
      u32 uncompressedDataSize, u32 compressedDataSize, u16 format,
      u16 mipLevels, u16 width, u16 height
    """
    if len(data) < 20 or data[:4] != BPR_MAGIC:
        raise ValueError("not a BZR2 bundle")
    version = data[4]
    if version != 3:
        raise ValueError(f"unsupported BZR2 version {version}")
    platform, info_size, string_offset, flags, data_size, packed_size = struct.unpack_from(
        "<BHHHII", data, 5)
    if platform != 2:
        raise ValueError(f"unsupported platform code {platform}")
    if flags & 0x000F:
        raise ValueError("compressed bundles are not in scope")
    info_start = 20
    info_end = info_start + info_size
    data_start = info_end
    if data_start + data_size > len(data):
        raise ValueError("bundle data size overruns the file")
    if string_offset >= info_size:
        raise ValueError("string table outside resource info")
    strings = data[info_start + string_offset:info_end]
    resources = []
    cursor = 0
    seen = 0
    while True:
        if cursor + 28 > info_size:
            raise ValueError("resource header outside info block")
        base = info_start + cursor
        (offset_next, offset_string, offset_data, rtype, rflags,
         rsize, rpacked) = struct.unpack_from("<HHIHHII", data, base)
        if rtype != 1:
            raise ValueError(f"unsupported resource type {rtype}")
        # Per-resource `flags` is not the compression selector: the bundle
        # header flag is.  Retail entries carry the same non-zero value
        # (0x02d5) while `compressedDataSize` is zero and the stored size
        # equals the exact mip chain, so the head flag must not be read as
        # an E_ResourceFlags bitfield.  Record it raw.
        if rpacked:
            raise ValueError("individually compressed resources are not in scope")
        fmt, mips, width, height = struct.unpack_from("<HHHH", data, base + 20)
        if offset_data + rsize > data_size:
            raise ValueError("resource data outside bundle")
        end = strings.find(b"\0", offset_string)
        if end < 0:
            raise ValueError("unterminated resource name")
        name = strings[offset_string:end].decode("ascii")
        resources.append({
            "name": name,
            "type": rtype,
            "flags": rflags,
            "format": fmt,
            "formatName": BPR_FORMATS.get(fmt, f"unknown-{fmt}"),
            "mipLevels": mips,
            "width": width,
            "height": height,
            "offsetData": offset_data,
            "dataBytes": rsize,
            "compressedBytes": rpacked,
            "recordOffset": cursor,
            "recordBytes": 28,
        })
        seen += 1
        if offset_next == 0:
            break
        if offset_next != 28:
            raise ValueError(f"unexpected record stride {offset_next}")
        cursor += offset_next
        if seen > 4096:
            raise ValueError("resource loop")
    if cursor + 28 != string_offset:
        raise ValueError("resource block does not end at the string table")
    return {
        "version": version,
        "platform": platform,
        "flags": flags,
        "resourceInfoSize": info_size,
        "stringTableOffset": string_offset,
        "dataSize": data_size,
        "headerBytes": 20,
        "resourceBytes": cursor + 28,
        "stringBytes": len(strings),
        "trailerBytes": len(data) - (data_start + data_size),
        "resources": resources,
        "texels": data[data_start:data_start + data_size],
    }


def bpr_mip_bytes(fmt: int, width: int, height: int, mips: int) -> int:
    """Stored byte count of a bundle texture's mip chain.

    The retail writer stops as soon as a mip would be smaller than 4x4 in
    either axis (the DXT block floor), even when the descriptor declares more
    levels.  This is derived from the resource sizes themselves and holds for
    every one of the 298 retail UI bundle textures; a level is counted only
    while `w >= 4 and h >= 4`.
    """
    bw = BPR_BLOCK_WIDTH.get(fmt)
    bb = BPR_BYTES_PER_BLOCK.get(fmt)
    if bw is None:
        return -1
    total = 0
    stored = 0
    for level in range(mips):
        w = max(1, width >> level)
        h = max(1, height >> level)
        if bw > 1 and (w < bw or h < bw):
            break
        total += max(1, (w + bw - 1) // bw) * max(1, (h + bw - 1) // bw) * bb
        stored += 1
    return total


def bpr_stored_mips(width: int, height: int, mips: int) -> int:
    count = 0
    for level in range(mips):
        if max(1, width >> level) < 4 or max(1, height >> level) < 4:
            break
        count += 1
    return count



# --------------------------------------------------------------------------
# BC / uncompressed pixel decoders (Microsoft block rules)
# --------------------------------------------------------------------------
def _rgb565(value: int) -> tuple[int, int, int]:
    """Bit-replication expansion, exactly `texture_reader.cpp::rgb565`."""
    r = (value >> 11) & 31
    g = (value >> 5) & 63
    b = value & 31
    return (r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)



def _bc1_colour(block: bytes, out: bytearray, base: int, stride: int, width: int, height: int):
    c0, c1, bits = struct.unpack_from("<HHI", block, 0)
    r0, g0, b0 = _rgb565(c0)
    r1, g1, b1 = _rgb565(c1)
    colours = [(r0, g0, b0, 255), (r1, g1, b1, 255)]
    if c0 > c1:
        colours += [((2 * r0 + r1) // 3, (2 * g0 + g1) // 3, (2 * b0 + b1) // 3, 255),
                    ((r0 + 2 * r1) // 3, (g0 + 2 * g1) // 3, (b0 + 2 * b1) // 3, 255)]
    else:
        colours += [((r0 + r1) // 2, (g0 + g1) // 2, (b0 + b1) // 2, 255),
                    (0, 0, 0, 0)]
    for py in range(4):
        for px in range(4):
            if base + py * stride + px * 4 + 4 > len(out):
                continue
            idx = (bits >> (2 * (py * 4 + px))) & 3
            out[base + py * stride + px * 4:base + py * stride + px * 4 + 4] = bytes(colours[idx])


def _bc3_alpha(block: bytes, out: bytearray, base: int, stride: int) -> list[int]:
    a0, a1 = block[0], block[1]
    table = [a0, a1]
    if a0 > a1:
        for i in range(2, 8):
            table.append(((8 - i) * a0 + (i - 1) * a1 + 3) // 7)
    else:
        for i in range(2, 6):
            table.append(((6 - i) * a0 + (i - 1) * a1 + 2) // 5)
        table += [0, 255]
    bits = int.from_bytes(block[2:8], "little")
    alphas = []
    for py in range(4):
        for px in range(4):
            idx = (bits >> (3 * (py * 4 + px))) & 7
            alphas.append(table[idx])
    return alphas


def _bc2_alpha(block: bytes) -> list[int]:
    alphas = []
    for byte in block[:8]:
        alphas += [(byte & 0x0F) * 17, (byte >> 4) * 17]
    return alphas


def decode_bc(fmt: int, raw: bytes, width: int, height: int) -> bytes:
    """Decode mip0 BC1/BC2/BC3 into row-major RGBA8 (no vertical flip)."""
    if fmt in (D3D_DXT1,):
        block_bytes = 8
    elif fmt in (D3D_DXT3, D3D_DXT5):
        block_bytes = 16
    else:
        raise ValueError(f"not a BC format: {fmt}")
    bw = (width + 3) // 4
    bh = (height + 3) // 4
    need = bw * bh * block_bytes
    if len(raw) < need:
        raise ValueError("BC payload truncated")
    out = bytearray(width * height * 4)
    for by in range(bh):
        for bx in range(bw):
            block = raw[(by * bw + bx) * block_bytes:(by * bw + bx + 1) * block_bytes]
            px = bx * 4
            py = by * 4
            w = min(4, width - px)
            h = min(4, height - py)
            stride = width * 4
            base = py * stride + px * 4
            if fmt == D3D_DXT1:
                _bc1_colour(block, out, base, stride, w, h)
                continue
            if fmt == D3D_DXT3:
                alphas = _bc2_alpha(block)
                colour = block[8:]
            else:
                alphas = _bc3_alpha(block, out, base, stride)
                colour = block[8:]
            _bc1_colour(colour, out, base, stride, w, h)
            for i in range(16):
                x = i % 4
                y = i // 4
                if x >= w or y >= h:
                    continue
                idx = base + y * stride + x * 4 + 3
                out[idx] = alphas[i]
    return bytes(out)


def decode_uncompressed(fmt: int, raw: bytes, width: int, height: int) -> bytes:
    if fmt == D3D_A8R8G8B8:
        need = width * height * 4
        if len(raw) < need:
            raise ValueError("A8R8G8B8 payload truncated")
        out = bytearray(need)
        for i in range(0, need, 4):
            b, g, r, a = raw[i:i + 4]
            out[i:i + 4] = bytes((r, g, b, a))
        return bytes(out)
    if fmt == D3D_L8:
        need = width * height
        if len(raw) < need:
            raise ValueError("L8 payload truncated")
        out = bytearray(need * 4)
        for i, value in enumerate(raw[:need]):
            out[i * 4:i * 4 + 4] = bytes((value, value, value, 255))
        return bytes(out)
    if fmt == D3D_A8:
        need = width * height
        if len(raw) < need:
            raise ValueError("A8 payload truncated")
        out = bytearray(need * 4)
        for i, value in enumerate(raw[:need]):
            out[i * 4:i * 4 + 4] = bytes((255, 255, 255, value))
        return bytes(out)
    raise ValueError(f"unsupported uncompressed format {fmt}")


def decode_image(fmt: int, raw: bytes, width: int, height: int) -> bytes:
    if fmt in (D3D_DXT1, D3D_DXT3, D3D_DXT5):
        return decode_bc(fmt, raw, width, height)
    return decode_uncompressed(fmt, raw, width, height)


# --------------------------------------------------------------------------
# Minimal deterministic PNG writer (RGBA8, no external dependency)
# --------------------------------------------------------------------------
def write_png(path: Path, width: int, height: int, rgba: bytes) -> None:
    if len(rgba) != width * height * 4:
        raise ValueError("RGBA length mismatch")
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + tag + payload +
                struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    blob = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) +
            chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(blob)


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
                    encoding="utf-8")


# --------------------------------------------------------------------------
# .ipf  (Adobe Illustrator polygon package)
# --------------------------------------------------------------------------
IPF_MAJOR = 16
IPF_MINOR = 0


class FontError(ValueError):
    pass


def parse_pf(data: bytes, keep_geometry: bool = True) -> dict:
    """Polygon font (`UIPolygonFont.cpp::ReadFromFile`).

    char name[256]; u32 glyphs; per glyph:
      u16 character, f32 offset, f32 width, f32 advance, u32 polys;
      per poly: u32 points; per point: f32 x, f32 y, u8 curves;
    u32 kerning; per pair: u16 first, u16 second, f32 amount.

    Metric and point coordinates are serialized against a 480-unit em
    (`kPolygonHeightHackFactor`) and the reader y-flips points.
    """
    if len(data) < 260 or len(data) > 16 * 1024 * 1024:
        raise FontError("polygon font outside bounded scope")
    name = data[:256].split(b"\0")[0].decode("latin-1")
    path_string = data[:256].split(b"\0")[1].decode("latin-1") if b"\0" in data[:256] else ""
    at = 256
    count = struct.unpack_from("<I", data, at)[0]
    at += 4
    if not 1 <= count <= 20000:
        raise FontError(f"glyph count {count} out of range")
    glyphs = []
    for _ in range(count):
        character = struct.unpack_from("<H", data, at)[0]
        offset, width, advance = struct.unpack_from("<fff", data, at + 2)
        polys = struct.unpack_from("<I", data, at + 14)[0]
        at += 18
        if polys > 4096:
            raise FontError("polygon count out of range")
        contours = []
        for _ in range(polys):
            points = struct.unpack_from("<I", data, at)[0]
            at += 4
            if points > 100000 or at + points * 9 > len(data):
                raise FontError("point count out of range")
            contour = []
            for _ in range(points):
                x, y = struct.unpack_from("<ff", data, at)
                curves = data[at + 8]
                at += 9
                contour.append([x, 480.0 - y] if keep_geometry else [x, y, curves])
            contours.append(contour)
        glyphs.append({"character": character,
                       "codepoint": f"U+{character:04X}",
                       "offset": offset / 480.0,
                       "width": width / 480.0,
                       "advance": advance / 480.0,
                       "offsetRaw": offset, "widthRaw": width, "advanceRaw": advance,
                       "contours": contours})
    pairs = struct.unpack_from("<I", data, at)[0]
    at += 4
    kerning = []
    if pairs:
        if at + pairs * 8 != len(data):
            raise FontError("kerning table does not end the file")
        for _ in range(pairs):
            first, second, amount = struct.unpack_from("<HHf", data, at)
            at += 8
            kerning.append({"first": first, "second": second,
                            "amount": amount / 480.0})
    if at != len(data):
        raise FontError(f"polygon font trailing bytes: {at} of {len(data)}")
    return {"name": name, "buildPath": path_string, "glyphCount": count,
            "kerningCount": pairs, "kerning": kerning,
            "emUnits": 480.0, "glyphs": glyphs}


def parse_dat_font(data: bytes, keep_uv: bool = True) -> dict:
    """Bitmap font metrics (`Font.cpp::Initialise` + `UIBitmapFont.cpp::Read`).

    S32 dataVersion (negative = versioned), S32 numFonts, then per font:
    char name[128], char texture[128], S32 language, S32 textureWidth,
    S32 textureHeight, S32 numGlyphs, S32 fontHeight, S32 hrzSpacing,
    S32 vrtSpacing, F32 topOffset, F32 sizeOverride, glyph array,
    S32 numKerningPairs, kerning array.

    v3 glyph = 24 bytes (`WWWWWxxFFF`); older = 28 bytes (`WxxFFFFSSSxx`).
    """
    if len(data) < 8 or len(data) > 16 * 1024 * 1024:
        raise FontError("bitmap font outside bounded scope")
    raw_version = struct.unpack_from("<i", data, 0)[0]
    at = 4
    if raw_version >= 0:
        version = 0
        num_fonts = raw_version
    else:
        version = -raw_version
        num_fonts = struct.unpack_from("<i", data, at)[0]
        at += 4
    if not 1 <= num_fonts <= 64:
        raise FontError(f"font count {num_fonts} out of range")
    fonts = []
    for _ in range(num_fonts):
        if at + 260 > len(data):
            raise FontError("font header truncated")
        name = data[at:at + 128].split(b"\0")[0].decode("latin-1")
        texture_name = data[at + 128:at + 256].split(b"\0")[0].decode("latin-1")
        at += 256
        language, tex_w, tex_h, num_glyphs, font_height = struct.unpack_from("<5i", data, at)
        at += 20
        if version > 1:
            hrz, vrt = struct.unpack_from("<2i", data, at)
            at += 8
        else:
            hrz = vrt = 0
            at += 8
        top_offset, size_override = struct.unpack_from("<2f", data, at)
        at += 8
        if not 0 <= num_glyphs <= 20000 or not 1 <= tex_w <= 8192 or not 1 <= tex_h <= 8192:
            raise FontError("bitmap font glyph/texture size out of range")
        stride = 24 if version > 2 else 28
        if at + num_glyphs * stride > len(data):
            raise FontError("bitmap glyph array truncated")
        glyphs = []
        for i in range(num_glyphs):
            base = at + i * stride
            character = struct.unpack_from("<H", data, base)[0]
            if version > 2:
                left, top, right, bottom = struct.unpack_from("<4H", data, base + 2)
                off, width, advance = struct.unpack_from("<3f", data, base + 12)
            else:
                left, top, right, bottom = struct.unpack_from("<4f", data, base + 2)
                off, width, advance = struct.unpack_from("<3h", data, base + 18)
            glyphs.append({
                "character": character,
                "codepoint": f"U+{character:04X}",
                "u0": left / tex_w, "v0": top / tex_h,
                "u1": right / tex_w, "v1": bottom / tex_h,
                "left": left, "top": top, "right": right, "bottom": bottom,
                "offset": off, "width": width, "advance": advance,
            })
        at += num_glyphs * stride
        if at + 4 > len(data):
            raise FontError("kerning count truncated")
        pairs = struct.unpack_from("<i", data, at)[0]
        at += 4
        if pairs < 0 or pairs > 200000:
            raise FontError("kerning count out of range")
        kstride = 8 if version > 2 else 6
        kerning = []
        if pairs:
            if at + pairs * kstride > len(data):
                raise FontError("kerning array truncated")
            for _ in range(pairs):
                first, second = struct.unpack_from("<HH", data, at)
                if version > 2:
                    amount = struct.unpack_from("<f", data, at + 4)[0]
                else:
                    amount = struct.unpack_from("<b", data, at + 4)[0]
                at += kstride
                kerning.append({"first": first, "second": second, "amount": amount})
        fonts.append({
            "name": name, "textureName": texture_name, "language": language,
            "textureWidth": tex_w, "textureHeight": tex_h,
            "glyphCount": num_glyphs, "fontHeight": font_height,
            "hrzSpacing": hrz, "vrtSpacing": vrt,
            "topOffset": top_offset, "sizeOverride": size_override,
            "kerningCount": pairs, "kerning": kerning, "glyphs": glyphs,
        })
    if at != len(data):
        raise FontError(f"bitmap font trailing bytes: {at} of {len(data)}")
    return {"dataVersion": version, "numFonts": num_fonts, "fonts": fonts,
            "glyphs": [g for f in fonts for g in f["glyphs"]]}


class IpfError(ValueError):
    pass


class _Reader:
    __slots__ = ("d", "p")

    def __init__(self, data: bytes):
        self.d = data
        self.p = 0

    def _take(self, n: int) -> int:
        if self.p + n > len(self.d):
            raise IpfError(f"IPF truncated at {self.p} (+{n})")
        self.p += n
        return self.p - n

    def u32(self) -> int:
        at = self._take(4)
        return struct.unpack_from("<I", self.d, at)[0]

    def i32(self) -> int:
        at = self._take(4)
        return struct.unpack_from("<i", self.d, at)[0]

    def u16(self) -> int:
        at = self._take(2)
        return struct.unpack_from("<H", self.d, at)[0]

    def f32(self) -> float:
        at = self._take(4)
        return struct.unpack_from("<f", self.d, at)[0]

    def f32s(self, n: int) -> list[float]:
        at = self._take(4 * n)
        return list(struct.unpack_from("<" + "f" * n, self.d, at))

    def string(self) -> str:
        at = self._take(4)
        size = struct.unpack_from("<I", self.d, at)[0]
        if size > 4096:
            raise IpfError(f"IPF string length {size} at {at}")
        start = self._take(size)
        return self.d[start:start + size].decode("latin-1")


def parse_ipf(data: bytes, keep_geometry: bool = True, allow_legacy: bool = False) -> dict:
    """Decode the Adobe polygon package read by `Ipf/IpfReader.cpp`.

    Layout (`IpfWriter.cpp`): u32 version, u32 layers, then a tree of
    `type=3` groups (level u32, name C_String, size i32) and `type=1`
    polygons.  A polygon carries fill/stroke/blend styles, a 6-float axis
    box, two HVec2 scalars, then fill vertices (2+4 floats), fill indices
    (u16) and stroke vertices (2+4+2 floats).  Every read is bounded and the
    caller checks exact consumption.

    `allow_legacy` accepts a major version other than 16 but marks the result
    `legacyVersion: true`; the retail reader rejects those files
    (`ImportScene` returns `E_Result_VersionDeprecated`), so callers must not
    present them as loadable retail assets.
    """
    r = _Reader(data)
    version = r.u32()
    major = version >> 16
    minor = version & 0xFFFF
    legacy = major != IPF_MAJOR
    if legacy and not allow_legacy:
        raise IpfError(f"deprecated IPF version {major}.{minor}")
    layers = r.u32()
    if layers > 4096:
        raise IpfError("IPF layer count out of range")

    out = {"version": version, "major": major, "minor": minor,
           "legacyVersion": legacy, "layers": [], "shapes": 0}

    def group(depth: int) -> dict:
        if depth > 64:
            raise IpfError("IPF group depth")
        level = r.u32()
        name = r.string()
        size = r.i32()
        if not 0 <= size <= 100000:
            raise IpfError(f"IPF group size {size}")
        node = {"kind": "group", "name": name, "level": level, "children": []}
        for _ in range(size):
            kind = r.i32()
            if kind == 3:
                node["children"].append(group(depth + 1))
            elif kind == 1:
                node["children"].append(polygon())
                out["shapes"] += 1
            else:
                raise IpfError(f"IPF element type {kind}")
        return node

    def polygon() -> dict:
        level = r.u32()
        name = r.string()
        fill_kind = r.i32()
        fill = None
        if fill_kind == 1:
            fill = {"kind": "solid", "rgb": r.f32s(3)}
        elif fill_kind == 2:
            fill = {"kind": "gradient", "dictionaryIndex": r.i32(),
                    "angle": r.f32(), "px": r.f32(), "py": r.f32(),
                    "length": r.f32()}
        elif fill_kind != 0:
            raise IpfError(f"IPF fill kind {fill_kind}")
        stroke = {"rgb": r.f32s(3), "width": r.f32()}
        at = r._take(2)
        transparency, blend = data[at], data[at + 1]
        bbox = r.f32s(6)
        offset = r.f32s(2)
        scale = r.f32s(2)
        shape = {"kind": "polygon", "name": name, "level": level,
                 "fill": fill, "stroke": stroke,
                 "transparency": transparency, "blend": blend,
                 "bbox": bbox, "offset": offset, "scale": scale,
                 "fillPaths": [], "indexPaths": [], "strokePaths": []}
        path_count = r.u32()
        for _ in range(path_count):
            count = r.u32()
            verts = r.f32s(count * 6) if keep_geometry else (r._take(count * 24) and None)
            shape["fillPaths"].append(
                [[verts[i * 6], verts[i * 6 + 1]] for i in range(count)] if keep_geometry else count)
        index_paths = r.u32()
        for _ in range(index_paths):
            count = r.u32()
            at = r._take(count * 2)
            idx = list(struct.unpack_from("<" + "H" * count, data, at))
            shape["indexPaths"].append(idx)
        stroke_paths = r.u32()
        for _ in range(stroke_paths):
            count = r.u32()
            verts = r.f32s(count * 8) if keep_geometry else (r._take(count * 32) and None)
            shape["strokePaths"].append(
                [[verts[i * 8], verts[i * 8 + 1]] for i in range(count)] if keep_geometry else count)
        return shape

    for _ in range(layers):
        kind = r.i32()
        if kind != 3:
            raise IpfError(f"IPF layer element type {kind}")
        out["layers"].append(group(0))
    if r.p != len(data):
        raise IpfError(f"IPF trailing bytes: consumed {r.p} of {len(data)}")
    return out
