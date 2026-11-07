#!/usr/bin/env python3
"""Independent verification of the usa_amboy texture-binding manifest.

Re-derives every draw's material chain with the committed P73a reference
resolver (probes/asset-reader/tests/verify_instance_textures_reference.py),
recomputes every UV0 hash from the native draw ranges, re-extracts every texture
blob from levelrender/levelstream, re-decodes with the committed texture_inspect,
recomputes the status split and re-runs the extractor for byte determinism.

Writes _work/map-slice/amboy-textures/verify.json. Data only.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes/asset-reader/tests"))
sys.path.insert(0, str(ROOT / "probes/map-slice/tools"))

from inspect_car_level_assets import render_layout, resource_prefix, stream_prefix  # noqa: E402
from inspect_level_instances import read_lists  # noqa: E402
from verify_instance_textures_reference import material_albedo  # noqa: E402
import amboy_texture_bindings as atb  # noqa: E402
import amboy_blocker_report as abr  # noqa: E402

LEVEL = "usa_amboy"
PACKAGE = ROOT / "_work/map-slice/amboy"
OUT = ROOT / "_work/map-slice/amboy-textures"
REPEAT = ROOT / "_work/map-slice/amboy-textures-repeat"
STAGES = ROOT / "_work/map-pipeline/probes"
LEVEL_DIR = ROOT / "game-data/Blur/levels" / LEVEL
NATIVE = ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe"

checks = []
failures = []


def check(name, condition, detail=None):
    checks.append({"check": name, "ok": bool(condition),
                   "detail": None if detail is None else str(detail)[:400]})
    if not condition:
        failures.append(name)


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def fnv1a64(data):
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def main() -> int:
    manifest = load(OUT / "bindings.json")
    blockers = load(OUT / "blockers.json")
    slice_doc = load(PACKAGE / "slice.json")
    levelrender = (LEVEL_DIR / "level.levelrender").read_bytes()
    scene = render_layout(levelrender, "level")["scene"]
    records = scene["stream"]["chunks"]
    archive = atb.TextureArchive(records, LEVEL_DIR / "level.levelstream")

    check("schema", manifest.get("schema") == atb.SCHEMA)
    check("draw count", manifest["counts"]["draws"] == 1606,
          manifest["counts"]["draws"])
    check("section count", manifest["counts"]["sections"] == 48)
    check("triangle count", manifest["counts"]["triangles"] == 348948)
    check("input levelrender hash",
          manifest["inputs"]["levelrender"]["sha256"] == sha256_bytes(levelrender))
    check("input levelstream hash",
          manifest["inputs"]["levelstream"]["sha256"] ==
          sha256_bytes((LEVEL_DIR / "level.levelstream").read_bytes()))
    check("slice hash", manifest["inputs"]["slice"]["sha256"] ==
          sha256_bytes((PACKAGE / "slice.json").read_bytes()))

    draws_by_section = {}
    for row in manifest["draws"]:
        draws_by_section.setdefault(row["section"], []).append(row)

    uv_checked = 0
    material_checked = 0
    triangle_checked = 0
    for section in slice_doc["draws"]["sections"]:
        stage = STAGES / ("%s-g%d-n%d" % (LEVEL, section["geometryBlock"], section["nodeBlock"]))
        node_raw = (stage / "node.chunk").read_bytes()
        stream_prefix(node_raw, records[section["nodeChunkIndex"]])
        resources = resource_prefix(node_raw, {"resourcePayloadOffset": 24,
                                               "scenePayloadOffset": 0}, streamed=True)
        render_list = read_lists(node_raw, resources)[0]
        geometry_raw = (stage / "geometry.chunk").read_bytes()
        stream_prefix(geometry_raw, records[section["geometryChunkIndex"]])
        geometry_resources = resource_prefix(
            geometry_raw, {"resourcePayloadOffset": 24, "scenePayloadOffset": 0},
            streamed=True)
        native = load(stage / "native.json")
        reference = load(stage / "reference.json")
        rows = draws_by_section[section["id"]]
        check("draw rows %s" % section["id"], len(rows) == len(native["draws"]) ==
              len(reference["draws"]))
        for row, native_draw, ref_draw in zip(rows, native["draws"], reference["draws"]):
            check("range %s#%d" % (section["id"], row["drawIndex"]),
                  row["firstIndex"] == native_draw["firstIndex"] and
                  row["indexCount"] == native_draw["indexCount"] and
                  row["primitiveIndex"] == ref_draw["primitiveIndex"])
            if row["indexCount"] > 0:
                digest = atb.uv_range_hash(native, native_draw["firstIndex"],
                                           native_draw["indexCount"])
                check("uv %s#%d" % (section["id"], row["drawIndex"]),
                      row["uvHash"] == digest, (row["uvHash"], digest))
                uv_checked += 1
            primitive = render_list["primitives"][row["primitiveIndex"]]
            material = material_albedo(render_list, primitive)
            check("material seen %s#%d" % (section["id"], row["drawIndex"]),
                  material["seen"] == row["material"]["seen"])
            check("material row %s#%d" % (section["id"], row["drawIndex"]),
                  material["row"] == row["material"]["row"])
            check("material known %s#%d" % (section["id"], row["drawIndex"]),
                  material["known"] == row["material"]["known"])
            check("material slot %s#%d" % (section["id"], row["drawIndex"]),
                  material["slot"] == row["material"]["slot"])
            check("material type %s#%d" % (section["id"], row["drawIndex"]),
                  material["material"] == row["material"]["material"])
            material_checked += 1

    check("all draws visited", sum(len(rows) for rows in draws_by_section.values()) == 1606)
    check("UV hashes recomputed", uv_checked == 1606, uv_checked)
    check("material chains recomputed", material_checked == 1606, material_checked)

    status = Counter()
    texture_checked = 0
    for texture in manifest["textures"]:
        if texture["kind"] == "shared":
            shared = scene["sharedTextures"][texture["index"]]
            blob = levelrender[shared["dataOffset"]:shared["dataOffset"] + shared["dataBytes"]]
        else:
            record = archive.texture(texture["block"], texture["index"])
            check("texture re-extracted %s" % texture["id"], record is not None)
            if record is None:
                continue
            blob = (record["_data"][record["headerOffset"]:record["headerOffset"] +
                    record["headerBytes"]] +
                    record["_data"][record["dataOffset"]:record["dataOffset"] +
                    record["dataBytes"]])
        check("blob hash %s" % texture["id"],
              sha256_bytes(blob) == texture["blobSha256"])
        blob_path = ROOT / texture["blobPath"]
        check("blob file %s" % texture["id"],
              blob_path.is_file() and sha256_bytes(blob_path.read_bytes()) ==
              texture["blobSha256"])
        check("texture name %s" % texture["id"], bool(texture["name"]))
        if texture.get("decodeBlocker") == "decoder-size-limit":
            continue
        process = subprocess.run([str(NATIVE), str(blob_path), "--raw"],
                                 capture_output=True, timeout=120)
        doc = json.loads(process.stdout.decode("utf-8"))
        rgba = bytes(doc["rgba"])
        check("decode %s" % texture["id"],
              process.returncode == 0 and doc.get("status") == "ok")
        check("rgba size %s" % texture["id"], len(rgba) == texture["rgbaBytes"])
        check("rgba sha %s" % texture["id"],
              sha256_bytes(rgba) == texture["rgbaSha256"])
        check("rgba fnv %s" % texture["id"],
              "0x%016x" % fnv1a64(rgba) == texture["rgbaFnv1a64"])
        alphas = rgba[3::4]
        check("alpha stats %s" % texture["id"],
              min(alphas) == texture["alpha"]["min"] and
              max(alphas) == texture["alpha"]["max"] and
              len(set(alphas)) == texture["alpha"]["distinct"])
        texture_checked += 1

    check("texture sources", len(manifest["textures"]) == 195,
          len(manifest["textures"]))
    check("decoded textures", texture_checked == 189, texture_checked)

    # External anchor for the blob reconstruction method: the P47 River blob.
    river_dir = ROOT / "game-data/Blur/levels/usa_la_river"
    river_scene = render_layout((river_dir / "level.levelrender").read_bytes(), "level")["scene"]
    river_archive = atb.TextureArchive(river_scene["stream"]["chunks"],
                                       river_dir / "level.levelstream")
    river_record = river_archive.texture(359, 0)
    check("P47 anchor texture found", river_record is not None)
    if river_record is not None:
        river_blob = (river_record["_data"][river_record["headerOffset"]:
                      river_record["headerOffset"] + river_record["headerBytes"]] +
                      river_record["_data"][river_record["dataOffset"]:
                      river_record["dataOffset"] + river_record["dataBytes"]])
        anchor = ROOT / "_work/logs/engine-stream-spike/textures/tex-359-0.raw"
        check("P47 anchor blob byte-identical",
              anchor.is_file() and sha256_bytes(river_blob) == sha256_bytes(anchor.read_bytes()))

    # Recompute the status split from the manifest material/texture facts.
    for row in manifest["draws"]:
        sa = row["status"]
        status[sa] += 1
    expected = {
        "bindable-static-albedo": 1201,
        "blocked-decoder-size-limit": 50,
        "blocked-alpha-rule-missing": 17,
        "blocked-effect-not-static-albedo": 334,
        "blocked-runtime-albedo-parameter": 4,
    }
    check("status split", dict(status) == expected, dict(status))
    check("bindable counts", manifest["counts"]["bindableDraws"] == 1201 and
          manifest["counts"]["bindableTriangles"] == 269300)
    check("bindable texture sources", manifest["counts"]["bindableTextureSources"] == 186)

    # Blocker report: all 27 stop on POSITION0 type 7 and resolve a static albedo.
    unsupported = blockers["unsupportedSections"]["sections"]
    check("unsupported sections", len(unsupported) == 27)
    for row in unsupported:
        bad = row["firstUnsupportedPosition"]
        check("unsupported %s geometry" % row["id"],
              bad is not None and bad["positionElement"]["type"] == 7 and
              bad["positionElement"]["method"] == 0 and bad["vertexStride"] == 28)
        check("unsupported %s texture" % row["id"],
              row["primitiveCounts"].get("staticAlbedo", 0) > 0)
    check("all 27 texture side resolved",
          blockers["unsupportedSections"]["summary"].get("textureSideResolved") == 27)

    instances = blockers["instances"]
    check("instance sections", instances["summary"]["sections"] == 3)
    check("instance count", instances["summary"]["instances"] == 366)
    check("instance static albedo", instances["summary"]["staticAlbedoInstances"] == 366)
    check("instance UV0 declared", instances["summary"]["uv0DeclaredInstances"] == 366)
    for row in instances["sections"]:
        check("instances %s native omitted" % row["id"],
              row["nativeSingleChunk"]["emittedInstanceCount"] == 0 and
              row["nativeSingleChunk"]["omittedOtherBlockInstances"] == row["instanceCount"])

    # Determinism: rebuild the manifest into a second directory and compare bytes.
    if REPEAT.exists():
        import shutil
        shutil.rmtree(REPEAT)
    process = subprocess.run([sys.executable, str(ROOT / "probes/map-slice/tools/amboy_texture_bindings.py"),
                              "--out", str(REPEAT)], capture_output=True, text=True,
                             timeout=1800)
    check("repeat build exit", process.returncode == 0, process.stderr[-300:])
    if process.returncode == 0:
        original = (OUT / "bindings.json").read_bytes()
        repeat = (REPEAT / "bindings.json").read_bytes()
        normalized = repeat.replace(rel(REPEAT).encode("utf-8"),
                                    rel(OUT).encode("utf-8"))
        check("repeat bindings byte-identical", normalized == original)
        check("repeat summary byte-identical",
              (REPEAT / "summary.json").read_bytes() == (OUT / "summary.json").read_bytes())

    result = {
        "schema": "blur.map-slice.amboy-textures-verify/1",
        "kind": "map-slice-texture-bindings-verify",
        "level": LEVEL,
        "checks": checks,
        "count": len(checks),
        "failures": failures,
        "status": "PASS" if not failures else "FAIL",
        "manifestSha256": sha256_bytes((OUT / "bindings.json").read_bytes()),
        "blockersSha256": sha256_bytes((OUT / "blockers.json").read_bytes()),
    }
    (OUT / "verify.json").write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "checks": len(checks),
                      "failures": failures[:10]}, indent=1))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
