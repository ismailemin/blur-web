#!/usr/bin/env python3
"""Decode every committed map-slice texture source with the extended decoder.

Inputs (read-only):

* ``_work/map-slice/<map>-textures/bindings.json`` - the committed MAP3/MAP5
  texture manifest (blob paths, descriptor, per-source identity, per-draw
  binding status);
* ``_work/map-slice/<map>-textures/raw/*.raw`` - the 28-byte descriptor plus the
  complete mip chain, reconstructed from ``Level.levelstream`` /
  ``level.levelrender`` by that pass and validated there;
* the retail ``level.levelrender`` / ``Level.levelstream`` - only to extract the
  ``g_tTexture`` blobs behind the ``Racification*`` decal draws, which the
  committed manifests record by identity but do not decode.

Outputs (generated game data, not committed):

* ``_work/textures/<map>/rgba/<id>.rgba`` - every source decoded at mip0;
* ``_work/textures/<map>/decode.json`` - dims, format, mip byte count, blob and
  RGBA hashes, alpha statistics, committed-limit verdict;
* ``_work/textures/<map>/decal.rgba/<id>.rgba`` + the same facts for the decal
  ``g_tTexture`` sources.

Nothing under ``probes/e1-drive``, ``probes/map-slice``, ``probes/asset-reader``,
``tools/``, ``upstream/`` or ``game-data/`` is written.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "probes/textures"))
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes/map-slice/tools"))

import bc_decode  # noqa: E402
from map_slice_common import package_dir, short_name, texture_dir  # noqa: E402

LEVELS = {
    "usa_amboy": {"package": "amboy", "short": "amboy"},
    "spa_barcelona_gracia": {"package": "gracia", "short": "gracia"},
}
OUT_ROOT = ROOT / "_work/textures"


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def fnv1a64(data: bytes) -> int:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False, allow_nan=False) + "\n",
                    encoding="utf-8", newline="\n")


def write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def decoded_record(blob: bytes, *, expected_blob_sha: str | None) -> dict:
    """Decode one blob and return its complete, hash-pinned record."""
    blob_sha = sha256_bytes(blob)
    if expected_blob_sha is not None and blob_sha != expected_blob_sha:
        raise SystemExit("blob SHA-256 drift: manifest says %s, file is %s"
                         % (expected_blob_sha, blob_sha))
    desc = bc_decode.parse_descriptor(blob)
    rejection = bc_decode.committed_rejection(desc)
    result = bc_decode.decode_blob(blob, extended=True)
    rgba = result["rgba"]
    stats = bc_decode.alpha_stats(rgba)
    record = {
        "width": result["width"],
        "height": result["height"],
        "levels": result["levels"],
        "format": result["format"],
        "formatName": result["formatName"],
        "depth": desc["depth"],
        "type": desc["type"],
        "usage": desc["usage"],
        "blobBytes": desc["blobBytes"],
        "texelPayloadBytes": desc["payloadBytes"],
        "encodedMipChainBytes": result["info"]["encodedMipChainBytes"],
        "rgbaBytes": len(rgba),
        "blobSha256": blob_sha,
        "rgbaSha256": sha256_bytes(rgba),
        "rgbaFnv1a64": "0x%016x" % fnv1a64(rgba),
        "committedDecoderVerdict": "accepted" if rejection is None else "rejected",
        "committedDecoderRejection": rejection,
        "extensionRequired": rejection is not None,
        "alpha": stats,
    }
    if len(rgba) != record["width"] * record["height"] * 4:
        raise SystemExit("RGBA length mismatch for %dx%d" % (record["width"], record["height"]))
    return record, rgba


def manifest_texture_rows(bindings: dict, out_dir: Path) -> list[dict]:
    rows = []
    for texture in bindings["textures"]:
        blob = ROOT / texture["blobPath"]
        raw = blob.read_bytes()
        record, rgba = decoded_record(raw, expected_blob_sha=texture["blobSha256"])
        descriptor = texture["descriptor"]
        for key in ("width", "height", "levels", "format"):
            if record[key] != descriptor[key]:
                raise SystemExit("%s: manifest %s %s != decoded %s"
                                 % (texture["id"], key, descriptor[key], record[key]))
        if record["blobBytes"] != texture["blobBytes"]:
            raise SystemExit("%s: blob byte count differs from the manifest" % texture["id"])
        if texture["kind"] == "resource-block":
            # MAP3/MAP5 record payloadBytes = texel payload only for resource blocks
            # and the whole blob (descriptor + texels) for shared textures.
            if texture["payloadBytes"] != record["texelPayloadBytes"]:
                raise SystemExit("%s: texel payload byte count differs from the manifest"
                                 % texture["id"])
        elif texture["payloadBytes"] != record["blobBytes"]:
            raise SystemExit("%s: shared blob byte count differs from the manifest"
                             % texture["id"])
        if texture.get("rgbaSha256") not in (None, record["rgbaSha256"]):
            raise SystemExit("%s: in-bound RGBA hash differs from the committed manifest"
                             % texture["id"])
        rows.append({
            "id": texture["id"],
            "kind": texture["kind"],
            "block": texture["block"],
            "index": texture["index"],
            "name": texture["name"],
            "textureHash": texture.get("textureHash"),
            "blobPath": texture["blobPath"],
            "rgbaPath": None,
            "manifestPayloadBytes": texture["payloadBytes"],
            **record,
        })
        write_bytes(out_dir / "rgba" / (texture["id"] + ".rgba"), rgba)
    return rows


def short_name_of(level: str) -> str:
    return LEVELS[level]["short"]


def decal_sources(bindings: dict) -> list[dict]:
    """Distinct ``g_tTexture`` sources behind the blocked effect/decal draws."""
    seen = {}
    for draw in bindings["draws"]:
        if draw["status"] != "blocked-effect-not-static-albedo":
            continue
        aux = draw.get("auxTexture")
        if not aux:
            continue
        key = (aux.get("block"), aux.get("index"), aux.get("kind"))
        entry = seen.setdefault(key, {
            "block": aux.get("block"),
            "index": aux.get("index"),
            "kind": aux.get("kind"),
            "name": aux.get("name"),
            "parameter": aux.get("parameter"),
            "draws": 0,
            "triangles": 0,
            "effects": {},
        })
        entry["draws"] += 1
        entry["triangles"] += draw["triangleCount"]
        entry["effects"][draw["effect"]] = entry["effects"].get(draw["effect"], 0) + 1
    return list(seen.values())


def extract_decal_blobs(level: str, sources: list[dict], out_dir: Path) -> list[dict]:
    from amboy_texture_bindings import TextureArchive  # proven record/texel parser
    from inspect_car_level_assets import render_layout

    level_dir = ROOT / "game-data/Blur/levels" / level
    levelrender = (level_dir / "level.levelrender").read_bytes()
    scene = render_layout(levelrender, "level")["scene"]
    archive = TextureArchive(scene["stream"]["chunks"], level_dir / "Level.levelstream")
    short = short_name_of(level)
    rows = []
    for source in sources:
        if source["block"] == -1:
            shared = scene["sharedTextures"][source["index"]]
            blob = levelrender[shared["dataOffset"]:shared["dataOffset"] + shared["dataBytes"]]
            sha = None
        else:
            record = archive.texture(source["block"], source["index"])
            if record is None:
                raise SystemExit("decal source %s:%s has no LOD0 stream item"
                                 % (source["block"], source["index"]))
            data = record["_data"]
            blob = (data[record["headerOffset"]:record["headerOffset"] + record["headerBytes"]] +
                    data[record["dataOffset"]:record["dataOffset"] + record["dataBytes"]])
            sha = None
        decoded, rgba = decoded_record(blob, expected_blob_sha=sha)
        ident = "%s.decal.%d.%d" % (short, source["block"], source["index"])
        write_bytes(out_dir / "decal-rgba" / (ident + ".rgba"), rgba)
        rows.append({
            "id": ident,
            "block": source["block"],
            "index": source["index"],
            "kind": source["kind"],
            "name": source["name"],
            "parameter": source["parameter"],
            "draws": source["draws"],
            "triangles": source["triangles"],
            "effects": source["effects"],
            "rgbaPath": rel(out_dir / "decal-rgba" / (ident + ".rgba")),
            **decoded,
        })
    return rows


def runtime_proof(level: str, bindings: dict) -> dict:
    """Read the exact material element behind each runtime-only albedo draw.

    Re-runs the committed node-chunk parser (the one MAP3/MAP5 used) and prints
    the ``g_tAlbedo`` field type/count/value of the recorded material row. Type 9
    is ``DATA_INDEX``: a reference into a material list that the runtime rebuilds
    (``listIndex != 0``). Nothing is decoded or guessed.
    """
    from inspect_car_level_assets import render_layout, resource_prefix, stream_prefix
    from inspect_level_instances import read_lists

    package = package_dir(level)
    slice_doc = load_json(package / "slice.json")
    levelrender = (ROOT / "game-data/Blur/levels" / level / "level.levelrender").read_bytes()
    records = render_layout(levelrender, "level")["scene"]["stream"]["chunks"]
    stages = ROOT / "_work/map-pipeline/probes"
    sections = {(s["geometryBlock"], s["nodeBlock"]): s for s in slice_doc["draws"]["sections"]}
    rows = {}
    out = []
    for draw in bindings["draws"]:
        if draw["status"] != "blocked-runtime-albedo-parameter":
            continue
        geometry_block, node_block = (int(x) for x in draw["section"][1:].split("-n"))
        key = (geometry_block, node_block)
        if key not in rows:
            stage = stages / ("%s-g%d-n%d" % (level, geometry_block, node_block))
            raw = (stage / "node.chunk").read_bytes()
            stream_prefix(raw, records[sections[key]["nodeChunkIndex"]])
            resources = resource_prefix(raw, {"resourcePayloadOffset": 24,
                                              "scenePayloadOffset": 0}, streamed=True)
            rows[key] = read_lists(raw, resources)[0]["constants"]
        row = draw["material"]["row"]
        material = rows[key][row]
        field = next((f for f in material["fields"] if f["name"] == "g_tAlbedo"), None)
        if field is None:
            raise SystemExit("runtime draw %s row %d has no g_tAlbedo field"
                             % (draw["section"], row))
        if field["type"] != 9:
            raise SystemExit("runtime draw %s row %d g_tAlbedo type %d is not DATA_INDEX"
                             % (draw["section"], row, field["type"]))
        values = field["values"]
        out.append({
            "section": draw["section"],
            "drawIndex": draw["drawIndex"],
            "primitiveIndex": draw["primitiveIndex"],
            "effect": draw["effect"],
            "materialRow": row,
            "material": material["typeName"],
            "field": "g_tAlbedo",
            "elementType": field["type"],
            "elementCount": field["count"],
            "runtimeListRefs": values,
            "listIndexNonZero": all(v["listIndex"] != 0 for v in values),
            "reason": "g_tAlbedo is a DATA_INDEX (type 9) reference into a runtime "
                      "material list; no serialized texture slot exists",
        })
    return {
        "draws": out,
        "count": len(out),
        "allType9": all(row["elementType"] == 9 for row in out),
        "allRuntimeList": all(row["listIndexNonZero"] for row in out),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--level", default="usa_amboy")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    level = args.level
    if level not in LEVELS:
        raise SystemExit("known levels: " + ", ".join(LEVELS))
    short = short_name_of(level)
    binding_dir = texture_dir(level)
    bindings_path = binding_dir / "bindings.json"
    bindings = load_json(bindings_path)
    out_dir = (args.out or (OUT_ROOT / short)).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    textures = manifest_texture_rows(bindings, out_dir)
    for row in textures:
        row["rgbaPath"] = rel(out_dir / "rgba" / (row["id"] + ".rgba"))

    decals = extract_decal_blobs(level, decal_sources(bindings), out_dir)
    runtime = runtime_proof(level, bindings)

    level_dir = ROOT / "game-data/Blur/levels" / level
    doc = {
        "schema": "blur.textures.decode/1",
        "kind": "map-texture-decode",
        "level": level,
        "short": short,
        "scope": {
            "dataOnly": True,
            "rendererChanged": False,
            "gpuClaim": False,
            "texturesBoundInRenderer": False,
            "alphaRuleApplied": False,
            "decoderExtended": True,
            "source": "standalone Python reimplementation of the documented PC "
                      ".texture decode; the committed C++ reader is not modified",
        },
        "inputs": {
            "bindings": {"path": rel(bindings_path), "sha256": sha256_file(bindings_path)},
            "levelrender": {"path": rel(level_dir / "level.levelrender"),
                            "bytes": (level_dir / "level.levelrender").stat().st_size,
                            "sha256": sha256_file(level_dir / "level.levelrender")},
            "levelstream": {"path": rel(level_dir / "Level.levelstream"),
                            "bytes": (level_dir / "Level.levelstream").stat().st_size,
                            "sha256": sha256_file(level_dir / "Level.levelstream")},
        },
        "decoder": {
            "committedMaxDimension": bc_decode.COMMITTED_MAX_DIMENSION,
            "committedMaxLevels": bc_decode.COMMITTED_MAX_LEVELS,
            "extendedMaxDimension": bc_decode.MAX_DIMENSION,
            "extendedMaxLevels": bc_decode.MAX_LEVELS,
            "maxPayloadBytes": bc_decode.MAX_INPUT_BYTES,
            "formats": {str(key): value for key, value in bc_decode.FORMAT_NAMES.items()},
        },
        "textures": textures,
        "decalTextures": decals,
        "runtimeAlbedo": runtime,
    }
    write_json(out_dir / "decode.json", doc)

    extended = [t for t in textures if t["extensionRequired"]]
    print("level %s: %d sources decoded (%d need the extension), %d decal sources, "
          "%d runtime draws"
          % (level, len(textures), len(extended), len(decals), runtime["count"]))
    for row in extended:
        print("  extended %-22s %-26s %4dx%-4d %-10s rgbsha %s"
              % (row["id"], row["name"], row["width"], row["height"],
                 row["formatName"], row["rgbaSha256"][:16]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
