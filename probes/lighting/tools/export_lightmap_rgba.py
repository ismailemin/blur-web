#!/usr/bin/env python3
"""Export the decoded static-world lightmap pixels as renderer-consumable files.

``lightmap_data.build_lightmap_block`` decodes every ``g_tLightmap`` texture of
a level and records its identity and hashes, but deliberately discards the
pixels.  This exporter re-runs the same committed decode path and writes the
mip-0 RGBA8 buffer of every texture to disk:

  <out-root>/<map>/lightmap/<name>.rgba   raw mip-0 RGBA8, width*height*4 bytes
  <out-root>/<map>/lightmap/index.json    per-texture sizes/hashes + set hash

``<out-root>`` defaults to ``_work/lighting`` (gitignored).  The ``file`` field
of each index entry is relative to the export root, so the index is identical
whichever root is used.

The export is byte-deterministic: sorted keys, fixed separators, no timestamps,
no floating point.  A decode error, a descriptor mismatch or a disagreement with
the committed runtime table aborts the run before the index is written; no
placeholder, white texture or partial set is ever emitted.

Run:
  python probes/lighting/tools/export_lightmap_rgba.py
  python probes/lighting/tools/export_lightmap_rgba.py --maps river --out-root _work/lighting
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import lightmap_data as LM  # noqa: E402

ROOT = LM.ROOT
DEFAULT_OUT_ROOT = ROOT / "_work/lighting"
RUNTIME_TABLE = ROOT / "probes/lighting/data/runtime-lighting.json"

SCHEMA = "blur.lightmap-rgba/1"
KIND = "lightmap-rgba-export"
UV_SET = "luxlightmap"
PIXEL_FORMAT = "RGBA8"
MIP_LEVEL = 0

# Short map id -> retail level package, in manifest build order.
LEVEL_IDS = {
    "river": "usa_la_river",
    "amboy": "usa_amboy",
    "gracia": "spa_barcelona_gracia",
    "longbeach": "usa_la_longbeachdocks",
}
MAP_ORDER = ["river", "amboy", "gracia", "longbeach"]

SET_HASH_RULE = ("sha256 over canonical JSON of the per-texture (name, decodedRgbaSha256) "
                 "pairs sorted by name; canonical JSON is sort_keys=True, "
                 "separators=(',', ':'), UTF-8. The same rule and value as the manifest and "
                 "runtime table lightmap.decodedRgbaSha256")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(document) -> bytes:
    return (json.dumps(document, indent=1, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")


def set_hash(entries: list[dict], field: str) -> str:
    """Set hash over ``(name, field)`` pairs, the rule the manifest uses."""
    payload = json.dumps(
        [{"name": entry["name"], field: entry[field]}
         for entry in sorted(entries, key=lambda entry: entry["name"])],
        sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return sha256_bytes(payload)


def load_runtime_lightmap(map_id: str) -> dict:
    """Load the committed runtime table's lightmap block for one map.

    The table is the committed contract the renderer already consumes; the
    export must agree with it or fail, never diverge silently.
    """
    if not RUNTIME_TABLE.exists():
        raise FileNotFoundError(
            "missing %s; rebuild it with: node probes/lighting/tools/build_runtime_lighting.mjs"
            % RUNTIME_TABLE.relative_to(ROOT).as_posix())
    document = json.loads(RUNTIME_TABLE.read_text(encoding="utf-8"))
    entry = (document.get("maps") or {}).get(map_id)
    if not entry:
        raise ValueError("runtime table has no map %r" % map_id)
    lightmap = entry.get("lightmap")
    if not lightmap or lightmap.get("decoded") is not True:
        raise ValueError("runtime table map %r has no decoded lightmap set" % map_id)
    return lightmap


def decode_map(map_id: str, temp_dir: Path) -> tuple[list[dict], list[tuple[str, bytes]]]:
    """Decode every referenced lightmap texture of one map.

    Returns the index entries (without ``file``) and the pixel buffers.  Any
    descriptor mismatch, decode error or unresolved reference raises.
    """
    level = LEVEL_IDS[map_id]
    scan = LM.scan_level(level)
    if scan["unresolvedReferences"]:
        raise ValueError("%s: unresolved g_tLightmap references: %r"
                         % (map_id, scan["unresolvedReferences"]))
    if scan["unreferencedNamePrefixLightmaps"]:
        raise ValueError("%s: lightmap_* textures with no g_tLightmap reference: %r"
                         % (map_id, scan["unreferencedNamePrefixLightmaps"]))
    if scan["referencedLightmapsMissingFromNamePrefix"]:
        raise ValueError("%s: g_tLightmap names outside the lightmap_* prefix: %r"
                         % (map_id, scan["referencedLightmapsMissingFromNamePrefix"]))
    if scan["referencedNonLightmaps"]:
        raise ValueError("%s: g_tLightmap resolves to non-lightmap textures: %r"
                         % (map_id, scan["referencedNonLightmaps"]))

    folder = LM.LEVELS_DIR / level
    stream_path = folder / "Level.levelstream"
    render = (folder / "Level.levelrender").read_bytes()
    records = LM.car.render_layout(render, "level")["scene"]["stream"]["chunks"]

    entries: list[dict] = []
    pixels: list[tuple[str, bytes]] = []
    chunk_cache: dict[int, bytes] = {}

    for name in scan["referencedLightmaps"]:
        reference = scan["references"][name]
        if reference["kind"] != "resource-block":
            raise ValueError("%s: %s resolves to a %s texture, not a resource-block texture"
                             % (map_id, name, reference["kind"]))
        row = next((item for item in scan["textures"]
                    if item["block"] == reference["block"]
                    and item["index"] == reference["index"]
                    and item["name"] == name), None)
        if row is None:
            raise ValueError("%s: %s has no matching LOD0 texture record" % (map_id, name))
        if row["format"] not in LM.FORMAT_NAMES:
            raise ValueError("%s: %s has unsupported format %r"
                             % (map_id, name, row["format"]))
        if row["headerBytes"] != 28:
            raise ValueError("%s: %s has PC TextureDesc size %r, expected 28"
                             % (map_id, name, row["headerBytes"]))

        record = records[row["recordIndex"]]
        chunk = chunk_cache.get(row["recordIndex"])
        if chunk is None:
            with stream_path.open("rb") as stream:
                stream.seek(record["offset"])
                chunk = stream.read(record["storedBytes"])
            if len(chunk) != record["storedBytes"]:
                raise ValueError("%s: short levelstream read for record %d"
                                 % (map_id, row["recordIndex"]))
            chunk_cache[row["recordIndex"]] = chunk
        blob = (chunk[row["headerOffset"]:row["headerOffset"] + row["headerBytes"]]
                + chunk[row["dataOffset"]:row["dataOffset"] + row["dataBytes"]])

        decoded = LM.decode_blob(blob, level + "." + name, temp_dir)
        if decoded["width"] != row["width"] or decoded["height"] != row["height"]:
            raise ValueError("%s: %s decoded %dx%d, descriptor says %dx%d"
                             % (map_id, name, decoded["width"], decoded["height"],
                                row["width"], row["height"]))
        if decoded["format"] != row["format"]:
            raise ValueError("%s: %s decoder format %r, descriptor says %r"
                             % (map_id, name, decoded["format"], row["format"]))
        if decoded["mipLevels"] != row["levels"]:
            raise ValueError("%s: %s decoder mip count %r, descriptor says %r"
                             % (map_id, name, decoded["mipLevels"], row["levels"]))
        if decoded["pixelDataOffset"] != row["headerBytes"]:
            raise ValueError("%s: %s decoder pixel offset %r, descriptor size %r"
                             % (map_id, name, decoded["pixelDataOffset"], row["headerBytes"]))
        if decoded["encodedMipChainBytes"] != row["dataBytes"]:
            raise ValueError("%s: %s decoder encoded bytes %r, descriptor says %r"
                             % (map_id, name, decoded["encodedMipChainBytes"], row["dataBytes"]))

        rgba = decoded["rgba"]
        expected_bytes = row["width"] * row["height"] * 4
        if len(rgba) != expected_bytes:
            raise ValueError("%s: %s decoded %d bytes, expected %d"
                             % (map_id, name, len(rgba), expected_bytes))
        file_sha = sha256_bytes(rgba)
        if file_sha != decoded["rgbaSha256"]:
            raise ValueError("%s: %s decoded hash mismatch" % (map_id, name))
        entries.append({
            "name": name,
            "width": row["width"],
            "height": row["height"],
            "bytes": len(rgba),
            "sha256": file_sha,
            "decodedRgbaSha256": decoded["rgbaSha256"],
        })
        pixels.append((name, rgba))

    entries.sort(key=lambda entry: entry["name"])
    pixels.sort(key=lambda item: item[0])
    return entries, pixels


def check_runtime(map_id: str, entries: list[dict], lightmap: dict) -> None:
    """Require the export to agree with the committed runtime table."""
    if lightmap.get("uvSet") != UV_SET:
        raise ValueError("%s: runtime uvSet %r, expected %r"
                         % (map_id, lightmap.get("uvSet"), UV_SET))
    if lightmap.get("count") != len(entries):
        raise ValueError("%s: runtime count %r, export has %d textures"
                         % (map_id, lightmap.get("count"), len(entries)))
    runtime_textures = lightmap.get("textures") or []
    runtime_by_name = {texture["name"]: texture for texture in runtime_textures}
    export_names = {entry["name"] for entry in entries}
    if set(runtime_by_name) != export_names:
        missing = sorted(export_names - set(runtime_by_name))
        extra = sorted(set(runtime_by_name) - export_names)
        raise ValueError("%s: runtime texture set differs from the export "
                         "(missing from runtime: %r, extra in runtime: %r)"
                         % (map_id, missing, extra))
    for entry in entries:
        texture = runtime_by_name[entry["name"]]
        if texture["width"] != entry["width"] or texture["height"] != entry["height"]:
            raise ValueError("%s: %s dimensions differ from the runtime table"
                             % (map_id, entry["name"]))
        if texture["decodedRgbaBytes"] != entry["bytes"]:
            raise ValueError("%s: %s decodedRgbaBytes differs from the runtime table"
                             % (map_id, entry["name"]))
        if texture["decodedRgbaSha256"] != entry["decodedRgbaSha256"]:
            raise ValueError("%s: %s decodedRgbaSha256 differs from the runtime table; "
                             "rebuild the manifests and the runtime table"
                             % (map_id, entry["name"]))
    if lightmap.get("decodedRgbaSha256") != set_hash(entries, "decodedRgbaSha256"):
        raise ValueError("%s: runtime set hash differs from the export; rebuild the "
                         "manifests and the runtime table" % map_id)


def export_map(map_id: str, out_root: Path) -> dict:
    lightmap = load_runtime_lightmap(map_id)
    with tempfile.TemporaryDirectory(prefix="lightmap-export-") as temp:
        entries, pixels = decode_map(map_id, Path(temp))
    check_runtime(map_id, entries, lightmap)

    target = out_root / map_id / "lightmap"
    target.mkdir(parents=True, exist_ok=True)
    expected_files = set()
    for name, rgba in pixels:
        relative = "%s/lightmap/%s.rgba" % (map_id, name)
        (target / (name + ".rgba")).write_bytes(rgba)
        expected_files.add(name + ".rgba")
    for stale in target.glob("*.rgba"):
        if stale.name not in expected_files:
            stale.unlink()

    dimensions = Counter("%dx%d" % (entry["width"], entry["height"]) for entry in entries)
    index = {
        "schema": SCHEMA,
        "kind": KIND,
        "mapId": map_id,
        "level": LEVEL_IDS[map_id],
        "uvSet": UV_SET,
        "format": PIXEL_FORMAT,
        "sourceFormat": lightmap["format"],
        "sourceFormatName": lightmap["formatName"],
        "mipLevel": MIP_LEVEL,
        "colorTransformApplied": False,
        "count": len(entries),
        "width": entries[0]["width"] if entries and len(dimensions) == 1 else None,
        "height": entries[0]["height"] if entries and len(dimensions) == 1 else None,
        "dimensions": dict(sorted(dimensions.items())),
        "bytes": sum(entry["bytes"] for entry in entries),
        "sha256": set_hash(entries, "decodedRgbaSha256"),
        "setHashRule": SET_HASH_RULE,
        "textures": [
            {**entry, "file": "%s/lightmap/%s.rgba" % (map_id, entry["name"])}
            for entry in entries
        ],
        "source": "mip-0 RGBA8 decoded from the %d DXT5/BC3 g_tLightmap textures of %s "
                  "(Level.levelstream) with probes/asset-reader texture_inspect; "
                  "no mip chain, no sRGB/colour transform, no shader term applied"
                  % (len(entries), LEVEL_IDS[map_id]),
    }
    payload = canonical(index)
    (target / "index.json").write_bytes(payload)
    return index


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT,
                        help="export root (default: _work/lighting)")
    parser.add_argument("--maps", default=",".join(MAP_ORDER),
                        help="comma-separated map ids (default: all four)")
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    maps = [name.strip() for name in args.maps.split(",") if name.strip()]
    unknown = [name for name in maps if name not in LEVEL_IDS]
    if unknown:
        raise SystemExit("unknown map id(s): %s (use %s)"
                         % (", ".join(unknown), ", ".join(MAP_ORDER)))
    out_root = args.out_root.resolve()
    for map_id in maps:
        index = export_map(map_id, out_root)
        if not args.quiet:
            print("%-10s %3d textures %10d B  sha256 %s"
                  % (map_id, index["count"], index["bytes"], index["sha256"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
