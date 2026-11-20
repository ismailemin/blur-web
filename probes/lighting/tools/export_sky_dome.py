#!/usr/bin/env python3
"""Export the retail sky-dome textures and the imposter shadow texture.

The committed runtime table names one sky dome per playable map
(``sky.dome.texture``, e.g. ``graphics/textures/skies/s10.texture``) but records
metadata only.  This exporter extracts the real texture from
``game-data/Blur/cache/root.pak``, decodes mip 0 and writes renderer-consumable
files, together with the committed per-map parameters the renderer applies.

  <out-root>/skies/<name>.rgba             raw mip-0 RGBA8, width*height*4 bytes
  <out-root>/skies/index.json              per-texture identity, hashes, metadata
  <out-root>/shadows/impostershadow.rgba   raw mip-0 RGBA8 (A8 expanded, 255,255,255,a)
  <out-root>/shadows/index.json            shadow texture identity + per-map settings
  <out-root>/<map>/sky.json                per-map dome record the page fetches
  <out-root>/<map>/shadow.json             per-map shadow record the page fetches

``<out-root>`` defaults to ``_work/lighting`` (gitignored).

Decoding
--------
Every sky dome in the committed table is a 2048x512 DXT5/BC3 single-mip
``.texture`` container (checked on every run; any other format is a typed
``unsupported`` error with the descriptor offset and format code, never a
guess).  The committed native decoder (``texture_inspect.exe``) deliberately
refuses textures larger than 512x512, so the DXT5 block decode below is a
line-for-line port of its ``pixels()`` (``probes/asset-reader/src/
texture_reader.cpp``), including the integer rounding.  The port is verified
against the native decoder on a committed 256x256 DXT5 sample from the same pak
(``dontship/textures/debugback.texture``) and the result is recorded in the
index; a mismatch aborts the export.

Sources (read-only):
  * ``probes/lighting/data/runtime-lighting.json`` -- sky.dome per map.
  * ``_work/lighting/<map>.json`` -- committed manifest: shadow settings
    (``amax.bin City.EnvironmentSettings.shadowSettings``).
  * ``game-data/Blur/cache/root.pak`` -- the textures.

Run:
  python probes/lighting/tools/export_sky_dome.py
  python probes/lighting/tools/export_sky_dome.py --maps amboy,hackney --out-root _work/lighting
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402
from prepare_asset_fixture import decode_packet_zlib  # noqa: E402

GAME = ROOT / "game-data/Blur"
CACHE = GAME / "cache"
ROOT_PAK = CACHE / "root.pak"
RUNTIME_TABLE = ROOT / "probes/lighting/data/runtime-lighting.json"
MANIFEST_ROOT = ROOT / "_work/lighting"
DECODER = ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe"
DEFAULT_OUT = ROOT / "_work/lighting"

SCHEMA = "blur.sky-dome-export/1"
SHADOW_SCHEMA = "blur.imposter-shadow-export/1"
DXT1, DXT3, DXT5 = 0x31545844, 0x33545844, 0x35545844
FORMAT_NAMES = {DXT1: "DXT1/BC1", DXT3: "DXT3/BC2", DXT5: "DXT5/BC3",
                21: "A8R8G8B8", 22: "X8R8G8B8", 32: "A8B8G8R8", 33: "X8B8G8R8",
                28: "A8", 50: "L8"}
SKY_PREFIX = "graphics/textures/skies/"


class UnsupportedTexture(Exception):
    """A texture the exporter refuses to guess about."""

    def __init__(self, reason: str, **detail):
        super().__init__(reason)
        self.code = "unsupported"
        self.reason = reason
        self.detail = detail


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(document) -> bytes:
    return (json.dumps(document, indent=1, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")


def rgb565(value: int):
    r, g, b = value >> 11, (value >> 5) & 63, value & 31
    return ((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2), 255)


def decode_dxt5_mip0(payload: bytes, width: int, height: int) -> bytes:
    """Byte-exact port of ``pixels()`` for DXT5/BC3 (texture_reader.cpp:20-140)."""
    out = bytearray(width * height * 4)
    step = 16
    p = 0
    for by in range((height + 3) // 4):
        for bx in range((width + 3) // 4):
            block = payload[p:p + step]
            if len(block) != step:
                raise UnsupportedTexture("truncated DXT5 block",
                                         byteOffset=p, blockBytes=len(block))
            a0, a1 = block[0], block[1]
            alpha = [0] * 8
            alpha[0], alpha[1] = a0, a1
            if a0 > a1:
                for i in range(2, 8):
                    alpha[i] = ((8 - i) * a0 + (i - 1) * a1 + 3) // 7
            else:
                for i in range(2, 6):
                    alpha[i] = ((6 - i) * a0 + (i - 1) * a1 + 2) // 5
                alpha[6], alpha[7] = 0, 255
            alpha_codes = int.from_bytes(block[2:8], "little")
            c0, c1 = struct.unpack_from("<HH", block, 8)
            palette = [rgb565(c0), rgb565(c1), [0, 0, 0, 255], [0, 0, 0, 255]]
            for k in range(3):
                palette[2][k] = (2 * palette[0][k] + palette[1][k]) // 3
                palette[3][k] = (palette[0][k] + 2 * palette[1][k]) // 3
            codes = struct.unpack_from("<I", block, 12)[0]
            for y in range(4):
                for x in range(4):
                    pixel = y * 4 + x
                    colour = palette[(codes >> (2 * pixel)) & 3]
                    alpha_value = alpha[(alpha_codes >> (3 * pixel)) & 7]
                    px, py = bx * 4 + x, by * 4 + y
                    if px < width and py < height:
                        offset = (py * width + px) * 4
                        out[offset:offset + 4] = bytes((colour[0], colour[1], colour[2], alpha_value))
            p += step
    return bytes(out)


def decode_linear_mip0(payload: bytes, width: int, height: int, fmt: int) -> bytes:
    """Port of the non-DXT ``pixels()`` branches (A8/L8/RGBA/BGRA)."""
    out = bytearray(width * height * 4)
    count = width * height
    if fmt == 28:
        for i in range(count):
            out[i * 4:i * 4 + 4] = bytes((255, 255, 255, payload[i]))
    elif fmt == 50:
        for i in range(count):
            out[i * 4:i * 4 + 4] = bytes((payload[i], payload[i], payload[i], 255))
    elif fmt in (21, 22):
        for i in range(count):
            out[i * 4:i * 4 + 4] = bytes((payload[i * 4 + 2], payload[i * 4 + 1], payload[i * 4],
                                          payload[i * 4 + 3] if fmt == 21 else 255))
    elif fmt in (32, 33):
        for i in range(count):
            out[i * 4:i * 4 + 4] = bytes((payload[i * 4], payload[i * 4 + 1], payload[i * 4 + 2],
                                          payload[i * 4 + 3] if fmt == 32 else 255))
    else:
        raise UnsupportedTexture("unsupported PC texture format", format="0x%08x" % fmt,
                                 formatName=FORMAT_NAMES.get(fmt, "unsupported"))
    return bytes(out)


def native_decode(container: bytes, label: str, out_root: Path) -> dict:
    if not DECODER.exists():
        raise FileNotFoundError("missing %s; build it with: python tools/verify_asset_probe.py"
                                % DECODER.relative_to(ROOT).as_posix())
    temp = out_root / "_decode"
    temp.mkdir(parents=True, exist_ok=True)
    path = temp / (label + ".texture")
    path.write_bytes(container)
    result = subprocess.run([str(DECODER), str(path)], capture_output=True, text=True)
    if result.returncode != 0:
        raise UnsupportedTexture("native decoder failed", error=result.stderr.strip()[:200])
    document = json.loads(result.stdout)
    if document.get("status") != "ok":
        raise UnsupportedTexture("native decoder rejected the texture", error=document.get("error"))
    document["rgba"] = bytes(document["rgba"])
    return document


def pak_entries() -> dict:
    index = pak_index(ROOT_PAK)
    if index.get("status") != "indexed":
        raise SystemExit("root.pak is not indexed: %s" % index.get("status"))
    return {row["path"].replace("\\", "/").lower(): row
            for row in index["entries"] if not row["directory"]}


def read_pak_entry(rows: dict, needle: str) -> tuple[dict, bytes]:
    hits = [row for path, row in rows.items() if path.endswith(needle.lower())]
    if len(hits) != 1:
        raise SystemExit("expected exactly one %r in root.pak, found %d" % (needle, len(hits)))
    entry = hits[0]
    with ROOT_PAK.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    return entry, decode_packet_zlib(packed, entry["logical_bytes"])


def parse_texture(container: bytes, entry: dict, label: str) -> dict:
    if container[:8] != b"Texture\x00":
        raise UnsupportedTexture("not a PC .texture container", byteOffset=0)
    if len(container) < 84:
        raise UnsupportedTexture("container shorter than its 84-byte header", bytes=len(container))
    width, height, depth, levels, fmt, usage, kind = struct.unpack_from("<7I", container, 56)
    if depth != 1 or kind != 3:
        raise UnsupportedTexture("not a 2D PC texture", depth=depth, type=kind)
    if levels != 1:
        raise UnsupportedTexture("sky/shadow export expects one mip level", levels=levels)
    block = 8 if fmt == DXT1 else 16 if fmt in (DXT3, DXT5) else None
    if block is None:
        mip = width * height * (1 if fmt in (28, 50) else 4)
    else:
        mip = ((width + 3) // 4) * ((height + 3) // 4) * block
    payload = container[84:]
    if len(payload) != mip:
        raise UnsupportedTexture("mip-chain byte count mismatch", declared=mip,
                                 actual=len(payload), byteOffset=84)
    return {
        "label": label,
        "pakEntry": entry["path"],
        "pakOffset": entry["offset"],
        "containerBytes": len(container),
        "storedBytes": entry["stored_bytes"],
        "containerSha256": sha256(container),
        "width": width,
        "height": height,
        "levels": levels,
        "format": "0x%08x" % fmt,
        "formatName": FORMAT_NAMES.get(fmt, "unsupported"),
        "formatCode": fmt,
        "usage": usage,
        "payloadOffset": 84,
        "payloadBytes": len(payload),
        "payload": payload
    }


def decoder_self_check(rows: dict, out_root: Path) -> dict:
    entry, container = read_pak_entry(rows, "dontship/textures/debugback.texture")
    meta = parse_texture(container, entry, "decode-self-check")
    if meta["formatCode"] != DXT5:
        raise UnsupportedTexture("self-check sample is not DXT5",
                                 format=meta["format"])
    ported = decode_dxt5_mip0(meta["payload"], meta["width"], meta["height"])
    native = native_decode(container, "decode-self-check", out_root)
    if native["width"] != meta["width"] or native["height"] != meta["height"]:
        raise UnsupportedTexture("self-check dimension mismatch")
    match = ported == native["rgba"]
    if not match:
        raise UnsupportedTexture("DXT5 port does not reproduce the native decoder",
                                 width=meta["width"], height=meta["height"])
    return {
        "sample": entry["path"],
        "width": meta["width"],
        "height": meta["height"],
        "bytes": len(ported),
        "sha256": "sha256:" + sha256(ported),
        "nativeSha256": "sha256:" + sha256(native["rgba"]),
        "match": True,
        "rule": "byte-for-byte port of probes/asset-reader/src/texture_reader.cpp pixels()"
    }


def export_sky(rows: dict, texture_path: str, out_root: Path) -> dict:
    name = texture_path.rsplit("/", 1)[-1]
    entry, container = read_pak_entry(rows, SKY_PREFIX + name)
    meta = parse_texture(container, entry, name)
    if meta["formatCode"] != DXT5:
        raise UnsupportedTexture("unexpected sky texture format", texture=texture_path,
                                 format=meta["format"], formatName=meta["formatName"],
                                 byteOffset=meta["payloadOffset"])
    if meta["width"] != 2048 or meta["height"] != 512:
        raise UnsupportedTexture("unexpected sky texture dimensions", texture=texture_path,
                                 width=meta["width"], height=meta["height"])
    rgba = decode_dxt5_mip0(meta["payload"], meta["width"], meta["height"])
    target = out_root / "skies" / (Path(name).stem + ".rgba")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(rgba)
    return {
        "name": name,
        "texture": texture_path,
        "file": target.name,
        "rgbaUrl": "/_work/lighting/skies/" + target.name,
        "width": meta["width"],
        "height": meta["height"],
        "levels": meta["levels"],
        "format": meta["format"],
        "formatName": meta["formatName"],
        "pakEntry": meta["pakEntry"],
        "pakOffset": meta["pakOffset"],
        "containerBytes": meta["containerBytes"],
        "storedBytes": meta["storedBytes"],
        "containerSha256": "sha256:" + meta["containerSha256"],
        "decodedRgbaBytes": len(rgba),
        "decodedRgbaSha256": "sha256:" + sha256(rgba),
        "pixelFormat": "RGBA8",
        "colourSpace": "linear (the retail .texture path does not SetSRGB; "
                       "TexturedSkyDome::OnCreate)",
        "decoder": "dxt5-port-of-texture_reader.cpp"
    }


def export_shadow(rows: dict, out_root: Path) -> dict:
    name = "impostershadow.texture"
    entry, container = read_pak_entry(rows, "graphics/textures/shadows/" + name)
    meta = parse_texture(container, entry, name)
    if meta["formatCode"] == 28:
        rgba = decode_linear_mip0(meta["payload"], meta["width"], meta["height"], 28)
        decoder = "a8-port-of-texture_reader.cpp"
    else:
        native = native_decode(container, "impostershadow", out_root)
        rgba = native["rgba"]
        decoder = "native-texture_inspect"
    target = out_root / "shadows" / "impostershadow.rgba"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(rgba)
    return {
        "name": name,
        "texture": "graphics/textures/shadows/" + name,
        "file": target.name,
        "rgbaUrl": "/_work/lighting/shadows/" + target.name,
        "width": meta["width"],
        "height": meta["height"],
        "levels": meta["levels"],
        "format": meta["format"],
        "formatName": meta["formatName"],
        "pakEntry": meta["pakEntry"],
        "pakOffset": meta["pakOffset"],
        "containerBytes": meta["containerBytes"],
        "storedBytes": meta["storedBytes"],
        "containerSha256": "sha256:" + meta["containerSha256"],
        "decodedRgbaBytes": len(rgba),
        "decodedRgbaSha256": "sha256:" + sha256(rgba),
        "pixelFormat": "RGBA8",
        "decoder": decoder,
        "note": "A8 expands to (255,255,255,a); the renderer uses the alpha blob"
    }


def manifest_shadow(map_id: str) -> dict:
    path = MANIFEST_ROOT / (map_id + ".json")
    if not path.exists():
        raise SystemExit("missing %s; rebuild it with probes/lighting/tools/build_manifest.py"
                         % path.relative_to(ROOT).as_posix())
    manifest = json.loads(path.read_text(encoding="utf-8"))
    shadow = manifest.get("shadow")
    if not isinstance(shadow, dict):
        raise SystemExit("%s has no shadow block" % path.relative_to(ROOT).as_posix())
    for key in ("ShadowSize", "ShadowHeight", "DropShadowIntensity", "DropShadowHeight",
                "MultiShadowIntensity", "IndividualShadowMaxIntensity", "MaxShadows",
                "FadeRange", "texture"):
        if key not in shadow:
            raise SystemExit("%s shadow block is missing %s" % (path.name, key))
    return shadow


def write_json(path: Path, document) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical(document))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out-root", default=str(DEFAULT_OUT))
    parser.add_argument("--maps", default="", help="comma separated map ids (default: all)")
    args = parser.parse_args()
    out_root = Path(args.out_root)
    if not out_root.is_absolute():
        out_root = ROOT / out_root

    table = json.loads(RUNTIME_TABLE.read_text(encoding="utf-8"))
    maps = table.get("maps") or {}
    wanted = [m.strip() for m in args.maps.split(",") if m.strip()] or list(maps)
    unknown = [m for m in wanted if m not in maps]
    if unknown:
        raise SystemExit("runtime table has no map(s): " + ", ".join(unknown))

    rows = pak_entries()
    self_check = decoder_self_check(rows, out_root)

    sky_records = {}
    for map_id in wanted:
        dome = (maps[map_id].get("sky") or {}).get("dome")
        if not dome or not dome.get("texture"):
            raise SystemExit("map %s has no sky.dome.texture" % map_id)
        path = dome["texture"]
        if path not in sky_records:
            sky_records[path] = export_sky(rows, path, out_root)

    shadow_record = export_shadow(rows, out_root)

    per_map_sky = {}
    per_map_shadow = {}
    for map_id in wanted:
        dome = maps[map_id]["sky"]["dome"]
        record = sky_records[dome["texture"]]
        per_map_sky[map_id] = {
            "schema": SCHEMA,
            "mapId": map_id,
            "texture": dome["texture"],
            "rgbaUrl": record["rgbaUrl"],
            "width": record["width"],
            "height": record["height"],
            "decodedRgbaSha256": record["decodedRgbaSha256"],
            "rotation": dome["rotation"],
            "intensity": dome["intensity"],
            "fogColour": dome["fogColour"],
            "fogCurve": dome["fogCurve"],
            "blackHeight": dome["blackHeight"],
            "blackSize": dome["blackSize"],
            "rule": "vsTexturedSkyDome.vsh/psTexturedSkyDome.psh: uv=(u+rotation, v); "
                    "fog=saturate((v+fogTop-1)/fogTop)^fogCurve; "
                    "black=saturate((blackHeight-v)*blackSize); "
                    "sky=rgb*a*a*intensity; colour=lerp(sky, fogColour, fog)*black",
            "source": "probes/lighting/data/runtime-lighting.json sky.dome"
        }
        shadow = manifest_shadow(map_id)
        per_map_shadow[map_id] = {
            "schema": SHADOW_SCHEMA,
            "mapId": map_id,
            "rgbaUrl": shadow_record["rgbaUrl"],
            "width": shadow_record["width"],
            "height": shadow_record["height"],
            "sizeX": shadow["ShadowSize"],
            "sizeY": shadow["ShadowSize"],
            "offsetY": shadow["ShadowHeight"],
            "intensity": shadow["DropShadowIntensity"],
            "dropHeight": shadow["DropShadowHeight"],
            "maxShadows": shadow["MaxShadows"],
            "multiShadowIntensity": shadow["MultiShadowIntensity"],
            "individualShadowMaxIntensity": shadow["IndividualShadowMaxIntensity"],
            "fadeRange": shadow["FadeRange"],
            "texture": shadow["texture"],
            "mode": "projected-imposter-approximation",
            "note": "the retail deferred screen-space blob (per-channel render target, "
                    "gaussian blur, screen composite) is not reproduced; the committed "
                    "imposter texture and shadow settings drive a ground-projected quad"
        }

    index = {
        "schema": SCHEMA,
        "kind": "sky-dome-textures",
        "generatedBy": "probes/lighting/tools/export_sky_dome.py",
        "textures": [sky_records[path] for path in sorted(sky_records)],
        "maps": per_map_sky,
        "decoderSelfCheck": self_check,
        "source": {
            "runtimeTable": "probes/lighting/data/runtime-lighting.json",
            "pak": "game-data/Blur/cache/root.pak"
        }
    }
    shadow_index = {
        "schema": SHADOW_SCHEMA,
        "kind": "imposter-shadow-texture",
        "generatedBy": "probes/lighting/tools/export_sky_dome.py",
        "textures": [shadow_record],
        "maps": per_map_shadow,
        "source": {
            "runtimeManifests": "_work/lighting/<map>.json shadow block",
            "pak": "game-data/Blur/cache/root.pak"
        }
    }
    write_json(out_root / "skies/index.json", index)
    write_json(out_root / "shadows/index.json", shadow_index)
    for map_id in wanted:
        write_json(out_root / map_id / "sky.json", per_map_sky[map_id])
        write_json(out_root / map_id / "shadow.json", per_map_shadow[map_id])

    print(json.dumps({
        "status": "ok",
        "outRoot": out_root.relative_to(ROOT).as_posix(),
        "maps": len(wanted),
        "skyTextures": len(sky_records),
        "selfCheck": self_check["match"],
        "sky": {m: per_map_sky[m]["texture"].rsplit("/", 1)[-1] for m in wanted},
        "shadowTexture": shadow_record["formatName"]
    }, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except UnsupportedTexture as error:
        print(json.dumps({"status": "error", "code": error.code, "reason": error.reason,
                          "detail": error.detail}, indent=1, sort_keys=True))
        raise SystemExit(1)
