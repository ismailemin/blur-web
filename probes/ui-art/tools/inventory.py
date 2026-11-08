"""Inventory every retail UI/menu art asset and write `_work/ui-art/inventory.json`.

Reads only `game-data/Blur/**` (pak index + decoded payloads) and the
read-only `upstream/BlurRebuilt` sources as documentation.  Writes only under
`_work/ui-art/`.

Categories:
  bpr-texture       one texture inside a BZR2 `.bpr` bundle
  ui-texture        standalone compiled `.texture` (minimaps)
  ipf-vector        Adobe polygon package (car icons, logos, buttons, shapes)
  pf-font           polygon (vector outline) font
  dat-font          bitmap-font glyph metrics
  movie             Bink video (loading/attract/credits movies)
  debug-font        dontship-only debug font assets

Usage:
  python probes/ui-art/tools/inventory.py
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import uiart  # noqa: E402

ROOT = uiart.ROOT
OUT = ROOT / "_work" / "ui-art"
PAKS = ["boot.pak", "gamedata.pak", "gamedata_boot.pak", "lut_rampak.pak",
        "root.pak", "root_streaming.pak"]

# Menu/HUD/brand art the shell will need, matched on the retail asset name.
ROLE_PATTERNS = [
    ("logo", re.compile(r"blur_logo|blur_tm|raceworld_logo|hollywood_logo|bizarre", re.I)),
    ("manufacturer-badge", re.compile(r"^man_", re.I)),
    ("track-badge", re.compile(r"^(?:JPN|SPA|UK|USA)_", re.I)),
    ("playlist-badge", re.compile(r"^PL_", re.I)),
    ("car-cutout", re.compile(r"^[A-Za-z0-9]+_[A-Za-z0-9]+_(?:Stock|Race|Drift|Drag|Rat|Tuner|OffRoad|Legend)", re.I)),
    ("boss-art", re.compile(r"^boss\d_", re.I)),
    ("panel-frame", re.compile(r"box|frame|edging|grad|hex|stroke|shape|corner|radar|vignette|screen", re.I)),
    ("button-hint", re.compile(r"button|controller|icon|pass_fail|tick_cross|load_save|on$", re.I)),
    ("hud-element", re.compile(r"hud|mirror|lock_on|speed|rpm|damage|minimap|rank|team|mic|stopwatch|checkpoint", re.I)),
    ("font-atlas", re.compile(r"swis|myer|font", re.I)),
    ("playlist-thumb", re.compile(r"tut_thumb|achievements|stickerbook", re.I)),
]

IPF_ROLE = [
    ("car-class-badge", re.compile(r"car_icons", re.I)),
    ("ui-icon-sheet", re.compile(r"icon_sheet|fe_icons|common_icons|perk_icons|ability_icons|award_icons|shop_icons|mod_icons|location_icons|pass_fail", re.I)),
    ("frame-9slice", re.compile(r"frame_curve|shapes|stroke|waves|curve", re.I)),
    ("button-art", re.compile(r"controller|load_save|on\.ipf|car_select|avatar_box|vs_trails|fan_animation|321", re.I)),
    ("minimap-vector", re.compile(r"minimap", re.I)),
]


def role_for(name: str, patterns) -> list[str]:
    return [role for role, pat in patterns if pat.search(name)] or ["unclassified"]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    assets: list[dict] = []
    bundles: list[dict] = []
    vectors: list[dict] = []
    fonts: list[dict] = []
    problems: list[dict] = []

    # ---------------------------------------------------------- pak entries
    for pak_name in PAKS:
        index = uiart.pak(pak_name)
        rows = sorted((r for r in index["entries"] if not r["directory"]),
                      key=lambda r: r["path"].lower())
        for row in rows:
            path = row["path"]
            low = path.lower()
            if not low.startswith("\\ui\\"):
                continue
            ext = low.rsplit(".", 1)[-1]
            base = path.rsplit("\\", 1)[-1]
            common = {
                "pak": pak_name,
                "path": path,
                "pakOffset": row["offset"],
                "storedBytes": row["stored_bytes"],
                "logicalBytes": row["logical_bytes"],
                "pathCrc32": row["path_crc32"],
                "fatIndex": row["fat_index"],
            }
            if ext == "bpr":
                data, info = uiart.load(pak_name, path)
                bundle = uiart.parse_bpr(data)
                bundles.append({
                    **common,
                    "kind": "bpr-bundle",
                    "sha256": info["sha256"],
                    "bytes": len(data),
                    "version": bundle["version"],
                    "platform": bundle["platform"],
                    "headerBytes": bundle["headerBytes"],
                    "resourceInfoSize": bundle["resourceInfoSize"],
                    "stringTableOffset": bundle["stringTableOffset"],
                    "stringBytes": bundle["stringBytes"],
                    "resourceBytes": bundle["resourceBytes"],
                    "trailerBytes": bundle["trailerBytes"],
                    "dataSize": bundle["dataSize"],
                    "resourceCount": len(bundle["resources"]),
                    "roles": role_for(base, ROLE_PATTERNS),
                })
                for res in bundle["resources"]:
                    expected = uiart.bpr_mip_bytes(res["format"], res["width"],
                                                   res["height"], res["mipLevels"])
                    entry = {
                        "id": f"{Path(base).stem}/{res['name']}",
                        "kind": "bpr-texture",
                        "source": path,
                        "pak": pak_name,
                        "bundle": base,
                        "name": res["name"],
                        "format": res["formatName"],
                        "formatCode": res["format"],
                        "width": res["width"],
                        "height": res["height"],
                        "mipLevels": res["mipLevels"],
                        "resourceOffset": res["recordOffset"],
                        "dataOffset": res["offsetData"],
                        "dataBytes": res["dataBytes"],
                        "expectedBytes": expected,
                        "storedMipLevels": uiart.bpr_stored_mips(
                            res["width"], res["height"], res["mipLevels"]),
                        "flags": res["flags"],
                        "roles": role_for(res["name"], ROLE_PATTERNS),
                    }
                    if expected != res["dataBytes"]:
                        problems.append({"kind": "bpr-size-mismatch", **entry})
                    assets.append(entry)
            elif ext == "texture":
                data, info = uiart.load(pak_name, path)
                desc = uiart.parse_texture(data)
                expected = uiart.expected_mip_bytes(desc["format"], desc["width"],
                                                    desc["height"], desc["levels"])
                entry = {
                    "id": Path(base).stem,
                    "kind": "ui-texture",
                    "source": path,
                    "pak": pak_name,
                    "sha256": info["sha256"],
                    "bytes": len(data),
                    "format": desc["formatName"],
                    "formatCode": desc["format"],
                    "width": desc["width"],
                    "height": desc["height"],
                    "mipLevels": desc["levels"],
                    "usage": desc["usage"],
                    "flags": desc["flags"],
                    "texelOffset": desc["texelOffset"],
                    "dataBytes": desc["texelBytes"],
                    "expectedBytes": expected,
                    "roles": ["minimap"],
                }
                if expected != desc["texelBytes"]:
                    problems.append({"kind": "texture-size-mismatch", **entry})
                assets.append(entry)
            elif ext == "ipf":
                data, info = uiart.load(pak_name, path)
                rec = {
                    **common,
                    "kind": "ipf-vector",
                    "sha256": info["sha256"],
                    "bytes": len(data),
                    "roles": role_for(base, IPF_ROLE),
                }
                try:
                    parsed = uiart.parse_ipf(data, keep_geometry=False)
                    rec["status"] = "parsed"
                    rec["version"] = f"{parsed['major']}.{parsed['minor']}"
                    rec["layers"] = len(parsed["layers"])
                    rec["shapes"] = parsed["shapes"]
                    rec["sprites"] = sorted(
                        child["name"] for layer in parsed["layers"]
                        for child in layer["children"] if child["kind"] == "polygon")
                    rec["layerNames"] = [layer["name"] for layer in parsed["layers"]]
                except uiart.IpfError as exc:
                    rec["status"] = "unsupported"
                    rec["reason"] = str(exc)
                    le = int.from_bytes(data[:4], "little")
                    be = int.from_bytes(data[:4], "big")
                    rec["versionRawLE"] = le
                    rec["versionRawBE"] = be
                    rec["version"] = f"{le >> 16}.{le & 0xFFFF}"
                    if not 1 <= (le >> 16) <= 64 and 1 <= (be >> 16) <= 64:
                        rec["byteOrder"] = "big-endian"
                        rec["version"] = f"{be >> 16}.{be & 0xFFFF}"
                        rec["reason"] = (
                            f"big-endian IPF {be >> 16}.{be & 0xFFFF}: retail PC reader "
                            "uses Ut::LittleEndianToNative and rejects the version")
                    else:
                        rec["byteOrder"] = "little-endian"
                        rec["reason"] = (
                            f"legacy IPF {le >> 16}.{le & 0xFFFF}: retail reader requires "
                            f"major {uiart.IPF_MAJOR} and returns VersionDeprecated")
                    problems.append({"kind": "ipf-unsupported", "fatal": False,
                                     "path": path, "reason": rec["reason"]})
                vectors.append(rec)
            elif ext == "pf":
                data, info = uiart.load(pak_name, path)
                rec = {**common, "kind": "pf-font", "sha256": info["sha256"],
                       "bytes": len(data), "roles": ["font-vector"]}
                try:
                    parsed = uiart.parse_pf(data, keep_geometry=False)
                    rec.update({k: v for k, v in parsed.items() if k != "glyphs"})
                    rec["glyphCount"] = len(parsed["glyphs"])
                    rec["status"] = "parsed"
                except Exception as exc:  # noqa: BLE001 - typed report, not a crash
                    rec["status"] = "unsupported"
                    rec["reason"] = f"{type(exc).__name__}: {exc}"
                    problems.append({"kind": "pf-unsupported", "path": path,
                                     "reason": rec["reason"]})
                fonts.append(rec)
            elif ext == "dat":
                data, info = uiart.load(pak_name, path)
                rec = {**common, "kind": "dat-font", "sha256": info["sha256"],
                       "bytes": len(data), "roles": ["font-bitmap-metrics"]}
                try:
                    parsed = uiart.parse_dat_font(data)
                    rec.update({k: v for k, v in parsed.items() if k != "glyphs"})
                    rec["glyphCount"] = len(parsed["glyphs"])
                    rec["status"] = "parsed"
                except Exception as exc:  # noqa: BLE001
                    rec["status"] = "unsupported"
                    rec["reason"] = f"{type(exc).__name__}: {exc}"
                    problems.append({"kind": "dat-unsupported", "path": path,
                                     "reason": rec["reason"]})
                fonts.append(rec)
            else:
                problems.append({"kind": "unexpected-ui-extension", "path": path})

    # ---------------------------------------------------- debug font assets
    for pak_name, path in [("root.pak", r"\dontship\fonts\arialdebug.font"),
                           ("root.pak", r"\dontship\textures\font.dds")]:
        try:
            data, info = uiart.load(pak_name, path)
        except Exception as exc:  # noqa: BLE001
            problems.append({"kind": "debug-font-missing", "path": path,
                             "reason": str(exc)})
            continue
        assets.append({
            "id": path.rsplit("\\", 1)[-1],
            "kind": "debug-font",
            "source": path,
            "pak": pak_name,
            "sha256": info["sha256"],
            "bytes": len(data),
            "format": "DDS" if path.endswith(".dds") else "unknown-font",
            "roles": ["debug-only"],
            "note": "dontship/debug asset, not part of the retail menu kit",
        })

    # --------------------------------------------------------------- movies
    movies_dir = ROOT / "game-data" / "Blur" / "UI" / "movies"
    for movie in sorted(movies_dir.glob("*.bik")):
        assets.append({
            "id": movie.stem,
            "kind": "movie",
            "source": "UI/movies/" + movie.name,
            "pak": None,
            "bytes": movie.stat().st_size,
            "sha256": sha256(movie.read_bytes()),
            "format": "Bink",
            "width": None,
            "height": None,
            "roles": ["loading-screen" if movie.stem.startswith(("01_", "02_", "03_", "04_", "05_", "06_", "07_", "08_", "09_", "10_"))
                      else "splash-or-attract"],
            "note": "Bink video; no decoder in this probe",
        })

    # -------------------------------------------------------------- summary
    counts: dict[str, int] = {}
    for asset in assets:
        counts[asset["kind"]] = counts.get(asset["kind"], 0) + 1
    decoded_kinds = {"bpr-texture", "ui-texture"}
    raster_assets = [a for a in assets if a["kind"] in decoded_kinds]
    vector_bytes = sum(a["bytes"] for a in vectors)
    raster_source_bytes = 0
    for asset in raster_assets:
        raster_source_bytes += asset.get("dataBytes", 0)
    doc = {
        "scope": "retail UI/menu art inventory (read-only)",
        "generatedFrom": {
            "gameData": "game-data/Blur",
            "paks": PAKS,
            "formatAuthority": [
                "probes/asset-reader/FORMAT-texture.md",
                "upstream/BlurRebuilt/code/mercury/library/graphics/display/source/bundler/ResourceBundleReader.cpp",
                "upstream/BlurRebuilt/code/mercury/library/graphics/display/source/bundler/ResourceBundleReaderImpl3.cpp",
                "upstream/BlurRebuilt/code/mercury/library/ui/source/ui/Illustrator/Ipf/ipfreader.cpp",
                "upstream/BlurRebuilt/code/mercury/library/ui/source/ui/Graphics/Font/UIPolygonFont.cpp",
                "upstream/BlurRebuilt/code/mercury/library/ui/source/ui/Graphics/Font/UIBitmapFont.cpp",
            ],
        },
        "counts": counts,
        "totals": {
            "assets": len(assets),
            "raster": len(raster_assets),
            "rasterSourceBytes": raster_source_bytes,
            "vectorPackages": len(vectors),
            "vectorBytes": vector_bytes,
            "fontRecords": len(fonts),
            "bundles": len(bundles),
            "problems": len(problems),
        },
        "categories": {
            "bprBundles": bundles,
            "raster": [a for a in raster_assets if a["kind"] == "bpr-texture"],
            "textures": [a for a in raster_assets if a["kind"] == "ui-texture"],
            "vector": vectors,
            "fonts": fonts,
        },
        "otherAssets": [a for a in assets
                        if a["kind"] in ("movie", "debug-font")],
        "problems": problems,
    }
    uiart.write_json(OUT / "inventory.json", doc)

    print(f"assets {len(assets)} raster {len(raster_assets)} "
          f"vector {len(vectors)} fonts {len(fonts)} movies "
          f"{counts.get('movie', 0)} problems {len(problems)}")
    print(f"bpr textures {counts.get('bpr-texture', 0)} "
          f"ui textures {counts.get('ui-texture', 0)}")
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
