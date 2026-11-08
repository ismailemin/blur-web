#!/usr/bin/env python3
"""Standalone PC ``.texture`` decoder for the map texture-coverage study.

This module reimplements, from the format contract in
``probes/asset-reader/FORMAT-texture.md`` and the source lines it cites, the
exact decode the committed C++ ``texture_reader.cpp`` performs, with the two
hard-coded structural bounds lifted from the *validator* (they are not part of
the format):

==================  ==================================  ======================
committed bound     where in ``texture_reader.cpp``     lift used here
==================  ==================================  ======================
width/height > 512  ``inspect_payload()``               up to ``MAX_DIMENSION``
levels > 10         ``inspect_payload()``               up to natural mip count
==================  ==================================  ======================

Everything else is kept byte-for-byte compatible with the committed decoder:
the 16-bit colour expansion, the BC1 three-colour mode, the BC3 alpha
interpolation rounding (``+3`` before ``/7``, ``+2`` before ``/5``, Microsoft's
rounded integer examples), the edge-block crop, and the non-BC channel orders.

The decoder is deliberately dependency-free (no Pillow, no numpy) so that it is
an independent reference; ``verify_textures.py`` cross-checks it against the
committed native decoder and against Pillow's DDS decoder.

Format facts (all traceable to the contract, not guessed):

* payload = 28-byte ``TextureDesc`` (width, height, depth, levels, format,
  usage, type, seven little-endian U32) followed by the complete mip chain,
  largest mip first; only mip0 is converted.
* BC1 = DXT1 (``0x31545844``), BC2 = DXT3 (``0x33545844``),
  BC3 = DXT5 (``0x35545844``); 8 bytes per 4x4 block for BC1, 16 for BC2/BC3.
* a mip is ``max(1, ceil(w/4)) * max(1, ceil(h/4)) * blockBytes``.
"""
from __future__ import annotations

import struct

BC1 = 0x31545844
BC2 = 0x33545844
BC3 = 0x35545844

FORMAT_NAMES = {
    BC1: "DXT1/BC1",
    BC2: "DXT3/BC2",
    BC3: "DXT5/BC3",
    21: "A8R8G8B8",
    22: "X8R8G8B8",
    32: "A8B8G8R8",
    33: "X8B8G8R8",
    28: "A8",
    50: "L8",
}

# The committed decoder's own texel limits, kept as named constants so the report
# can state exactly which images exceed them.
COMMITTED_MAX_DIMENSION = 512
COMMITTED_MAX_LEVELS = 10
# The lift is bounded too: 8192 px is the largest PC D3D11 texture dimension and
# keeps a single input under the committed 8-MiB ``texture_raw_inspect`` limit.
MAX_DIMENSION = 8192
MAX_LEVELS = 16
MAX_INPUT_BYTES = 8 * 1024 * 1024


class TextureFormatError(ValueError):
    """Explicit, typed failure; never a silent fallback."""


def rgb565(value: int) -> tuple[int, int, int, int]:
    r = (value >> 11) & 0x1F
    g = (value >> 5) & 0x3F
    b = value & 0x1F
    return ((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2), 255)


def block_bytes(fmt: int) -> int:
    if fmt == BC1:
        return 8
    if fmt in (BC2, BC3):
        return 16
    raise TextureFormatError("format %d is not a block-compressed format" % fmt)


def mip_bytes(width: int, height: int, fmt: int) -> int:
    """Bytes of one mip level, exactly as ``mip_bytes()`` in texture_reader.cpp."""
    if fmt in (BC1, BC2, BC3):
        blocks = max(1, (width + 3) // 4) * max(1, (height + 3) // 4)
        return blocks * block_bytes(fmt)
    if fmt in (21, 22, 32, 33):
        return width * height * 4
    if fmt in (28, 50):
        return width * height
    raise TextureFormatError("unsupported PC texture format %d" % fmt)


def max_levels(width: int, height: int) -> int:
    side = max(width, height)
    count = 1
    while side > 1:
        side >>= 1
        count += 1
    return count


def parse_descriptor(blob: bytes) -> dict:
    if len(blob) < 28:
        raise TextureFormatError("truncated PC texture descriptor (%d bytes)" % len(blob))
    width, height, depth, levels, fmt, usage, kind = struct.unpack_from("<7I", blob, 0)
    return {
        "width": width,
        "height": height,
        "depth": depth,
        "levels": levels,
        "format": fmt,
        "usage": usage,
        "type": kind,
        "blobBytes": len(blob),
        "payloadBytes": len(blob) - 28,
        "encodedMipChainBytes": len(blob) - 28,
    }


def validate(desc: dict, *, extended: bool = True) -> dict:
    """Return the documented limit verdict for one descriptor.

    ``extended=False`` applies the committed validator, so a caller can state
    which single check the committed decoder fails on.
    """
    width, height, depth = desc["width"], desc["height"], desc["depth"]
    levels, fmt, kind = desc["levels"], desc["format"], desc["type"]
    limit_dim = MAX_DIMENSION if extended else COMMITTED_MAX_DIMENSION
    limit_levels = MAX_LEVELS if extended else COMMITTED_MAX_LEVELS
    if width == 0 or height == 0:
        raise TextureFormatError("zero dimension %dx%d" % (width, height))
    if width > limit_dim or height > limit_dim:
        raise TextureFormatError(
            "%dx%d exceeds the %d px decoder bound" % (width, height, limit_dim))
    if depth != 1 or kind != 3:
        raise TextureFormatError("only 2D textures are supported (depth=%d type=%d)"
                                 % (depth, kind))
    if levels == 0 or levels > limit_levels:
        raise TextureFormatError("%d mip levels exceeds the %d level bound"
                                 % (levels, limit_levels))
    natural = max_levels(width, height)
    if levels > natural:
        raise TextureFormatError("%d mip levels exceeds the natural %d"
                                 % (levels, natural))
    expected = 0
    for mip in range(levels):
        expected += mip_bytes(max(1, width >> mip), max(1, height >> mip), fmt)
    if expected != desc["encodedMipChainBytes"]:
        raise TextureFormatError(
            "mip-chain byte count mismatch: descriptor declares %d, payload holds %d"
            % (expected, desc["encodedMipChainBytes"]))
    return {
        "width": width,
        "height": height,
        "levels": levels,
        "format": fmt,
        "formatName": FORMAT_NAMES.get(fmt, "unsupported"),
        "encodedMipChainBytes": expected,
    }


def committed_rejection(desc: dict) -> str | None:
    """Which committed check rejects this descriptor, or ``None`` if in bounds."""
    try:
        validate(desc, extended=False)
        return None
    except TextureFormatError as error:
        return str(error)


def decode_bc(blob: bytes, width: int, height: int, fmt: int, offset: int = 28) -> bytearray:
    """Decode mip0 of a BC1/BC2/BC3 payload (``pixels()`` semantics)."""
    out = bytearray(width * height * 4)
    step = 8 if fmt == BC1 else 16
    position = offset
    for block_y in range((height + 3) // 4):
        for block_x in range((width + 3) // 4):
            colour_offset = position + (0 if fmt == BC1 else 8)
            c0 = blob[colour_offset] | (blob[colour_offset + 1] << 8)
            c1 = blob[colour_offset + 2] | (blob[colour_offset + 3] << 8)
            p0 = rgb565(c0)
            p1 = rgb565(c1)
            p2 = [0, 0, 0, 255]
            p3 = [0, 0, 0, 255]
            if c0 > c1 or fmt != BC1:
                for k in range(3):
                    p2[k] = (2 * p0[k] + p1[k]) // 3
                    p3[k] = (p0[k] + 2 * p1[k]) // 3
            else:
                for k in range(3):
                    p2[k] = (p0[k] + p1[k]) // 2
                p3 = [0, 0, 0, 0]
            palette = (p0, p1, tuple(p2), tuple(p3))
            codes = struct.unpack_from("<I", blob, colour_offset + 4)[0]

            alpha_values = None
            alpha_codes = 0
            if fmt == BC3:
                a0 = blob[position]
                a1 = blob[position + 1]
                values = [0] * 8
                values[0] = a0
                values[1] = a1
                if a0 > a1:
                    for i in range(2, 8):
                        values[i] = ((8 - i) * a0 + (i - 1) * a1 + 3) // 7
                else:
                    for i in range(2, 6):
                        values[i] = ((6 - i) * a0 + (i - 1) * a1 + 2) // 5
                    values[6] = 0
                    values[7] = 255
                alpha_values = values
                alpha_codes = int.from_bytes(blob[position + 2:position + 8], "little")

            for y in range(4):
                py = block_y * 4 + y
                if py >= height:
                    continue
                row = py * width
                for x in range(4):
                    px = block_x * 4 + x
                    if px >= width:
                        continue
                    pixel = y * 4 + x
                    colour = palette[(codes >> (2 * pixel)) & 3]
                    index = (row + px) * 4
                    if fmt == BC2:
                        nibble = (blob[position + pixel // 2] >> ((pixel % 2) * 4)) & 0xF
                        out[index] = colour[0]
                        out[index + 1] = colour[1]
                        out[index + 2] = colour[2]
                        out[index + 3] = nibble * 17
                    elif fmt == BC3:
                        out[index] = colour[0]
                        out[index + 1] = colour[1]
                        out[index + 2] = colour[2]
                        out[index + 3] = alpha_values[(alpha_codes >> (3 * pixel)) & 7]
                    else:
                        out[index] = colour[0]
                        out[index + 1] = colour[1]
                        out[index + 2] = colour[2]
                        out[index + 3] = colour[3]
            position += step
    return out


def decode_plain(blob: bytes, width: int, height: int, fmt: int, offset: int = 28) -> bytearray:
    out = bytearray(width * height * 4)
    source = blob
    for i in range(width * height):
        p = offset + i * (1 if fmt in (28, 50) else 4)
        if fmt == 28:
            out[i * 4:i * 4 + 4] = bytes((255, 255, 255, source[p]))
        elif fmt == 50:
            value = source[p]
            out[i * 4:i * 4 + 4] = bytes((value, value, value, 255))
        elif fmt in (21, 22):
            out[i * 4:i * 4 + 4] = bytes((source[p + 2], source[p + 1], source[p],
                                           source[p + 3] if fmt == 21 else 255))
        else:  # 32 / 33
            out[i * 4:i * 4 + 4] = bytes((source[p], source[p + 1], source[p + 2],
                                           source[p + 3] if fmt == 32 else 255))
    return out


def decode_blob(blob: bytes, *, extended: bool = True) -> dict:
    """Decode one standalone ``descriptor + mip chain`` payload (mip0 only)."""
    if len(blob) > MAX_INPUT_BYTES:
        raise TextureFormatError("input %d bytes exceeds the 8-MiB payload bound" % len(blob))
    desc = parse_descriptor(blob)
    info = validate(desc, extended=extended)
    fmt = desc["format"]
    if fmt in (BC1, BC2, BC3):
        rgba = decode_bc(blob, desc["width"], desc["height"], fmt)
    else:
        rgba = decode_plain(blob, desc["width"], desc["height"], fmt)
    if len(rgba) != desc["width"] * desc["height"] * 4:
        raise TextureFormatError("decoded length differs from dimensions")
    return {
        "descriptor": desc,
        "info": info,
        "width": desc["width"],
        "height": desc["height"],
        "levels": desc["levels"],
        "format": fmt,
        "formatName": info["formatName"],
        "rgba": bytes(rgba),
    }


def alpha_stats(rgba: bytes) -> dict:
    alphas = rgba[3::4]
    histogram = {}
    for value in alphas:
        histogram[value] = histogram.get(value, 0) + 1
    total = len(alphas)
    zeros = histogram.get(0, 0)
    full = histogram.get(255, 0)
    binary = all(value in (0, 255) for value in histogram)
    return {
        "pixels": total,
        "min": min(alphas) if alphas else 255,
        "max": max(alphas) if alphas else 255,
        "distinct": len(histogram),
        "alphaOpaque": zeros == 0 and full == total,
        "zeroPixels": zeros,
        "opaquePixels": full,
        "zeroFraction": (zeros / total) if total else 0.0,
        "opaqueFraction": (full / total) if total else 0.0,
        "below128Fraction": (sum(count for value, count in histogram.items() if value < 128) / total)
        if total else 0.0,
        "binary": binary,
        "histogram": {str(key): histogram[key] for key in sorted(histogram)},
    }
