#!/usr/bin/env python3
"""Classify the usa_amboy unsupported draw sections and skipped instances.

Reports, separately for the 27 unsupported first-RenderList sections and the 366
instance descriptions in 3 supported sections:

  * whether the source material chain resolves a static g_tAlbedo (texture side)
  * whether the committed reader stops on geometry (geometry-reader side)
  * the exact declaration element / stream-chunk reason

Data/analysis only. No renderer, GPU, browser or full-game claim.
"""
from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes/map-slice/tools"))

from inspect_car_level_assets import render_layout, resource_prefix, stream_prefix  # noqa: E402
from inspect_level_instances import read_lists  # noqa: E402
import amboy_texture_bindings as atb  # noqa: E402

LEVEL = "usa_amboy"
PACKAGE = ROOT / "_work/map-slice/amboy"
OUT = ROOT / "_work/map-slice/amboy-textures"
STAGES = ROOT / "_work/map-pipeline/probes"
LEVEL_DIR = ROOT / "game-data/Blur/levels" / LEVEL
NATIVE = ROOT / "_work/build/asset-reader-native/Release/level_inspect.exe"
SCHEMA = "blur.map-slice.amboy-blockers/1"


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False,
                               allow_nan=False) + "\n", encoding="utf-8")


def position_check(declaration, vb):
    position = next((e for e in declaration if e["usage"] == 0 and e["usageIndex"] == 0), None)
    if position is None:
        return False, "POSITION0 declaration missing", position
    size = 12 if position["type"] == 6 else 8 if position["type"] == 9 else 0
    supported = (position["method"] == 0 and position["type"] in (6, 9) and
                 position["offset"] + size <= vb["stride"])
    reason = None
    if not supported:
        reason = ("POSITION0 type=%d method=%d offset=%d stride=%d (committed reader accepts type 6/F32_3 and 9/F16_4 with method 0)"
                  % (position["type"], position["method"], position["offset"], vb["stride"]))
    return supported, reason, position


def in_scope_primitives(render_list, scene, geometry_block):
    """Direct primitives whose POSITION/VB/IB bind the selected geometry block."""
    declarations = scene["declarations"]
    vertex_sources = render_list["sources"]["vertexBuffer"]
    index_sources = render_list["sources"]["indexBuffer"]
    for index, primitive in enumerate(render_list["primitives"]):
        declaration = declarations[primitive["declaration"]]
        position = next((e for e in declaration if e["usage"] == 0 and e["usageIndex"] == 0), None)
        if position is None:
            continue
        stream = next((s for s in primitive["streams"]
                       if s["streamIndex"] == position["stream"] and s["frequency"] == 0), None)
        if stream is None:
            continue
        vb_source = vertex_sources[stream["vertexBuffer"]]
        ib_source = index_sources[primitive["indexBuffer"]]
        if vb_source["block"] == geometry_block and ib_source["block"] == geometry_block:
            yield index, primitive, declaration, stream, vb_source, ib_source


def unsupported_report(slice_doc, scene, records):
    rows = []
    for section in slice_doc["draws"]["unsupportedSections"]:
        stage = STAGES / ("%s-g%d-n%d" % (LEVEL, section["geometryBlock"], section["nodeBlock"]))
        node_raw = (stage / "node.chunk").read_bytes()
        geometry_raw = (stage / "geometry.chunk").read_bytes()
        stream_prefix(node_raw, records[section["nodeChunkIndex"]])
        node_resources = resource_prefix(node_raw, {"resourcePayloadOffset": 24,
                                                    "scenePayloadOffset": 0}, streamed=True)
        render_list = read_lists(node_raw, node_resources)[0]
        stream_prefix(geometry_raw, records[section["geometryChunkIndex"]])
        geometry_resources = resource_prefix(geometry_raw, {"resourcePayloadOffset": 24,
                                                            "scenePayloadOffset": 0}, streamed=True)
        resolver = atb.Resolver(render_list, scene["effects"])
        counts = Counter()
        bad = None
        for index, primitive, declaration, stream, vb_source, ib_source in in_scope_primitives(
                render_list, scene, section["geometryBlock"]):
            counts["inScopePrimitives"] += 1
            material = resolver.resolve(primitive)
            if material["known"] and material["slot"] is not None:
                counts["staticAlbedo"] += 1
            elif material["seen"]:
                counts["runtimeAlbedo"] += 1
            elif material.get("otherTextures"):
                counts["otherTextureOnly"] += 1
            else:
                counts["noAlbedo"] += 1
            vb = geometry_resources["vertexBuffers"][vb_source["index"]]
            supported, reason, position = position_check(declaration, vb)
            if not supported:
                bad = {
                    "primitiveIndex": index,
                    "declarationIndex": primitive["declaration"],
                    "effect": resolver.effect(primitive),
                    "positionElement": position,
                    "vertexStride": vb["stride"],
                    "vertexElements": vb["elements"],
                    "reason": reason,
                    "material": {k: material[k] for k in
                                 ("seen", "known", "slot", "row", "material", "reason")},
                }
                break
        rows.append({
            "id": section["id"],
            "geometryBlock": section["geometryBlock"],
            "nodeBlock": section["nodeBlock"],
            "nativeByteOffset": section.get("byteOffset"),
            "nativeReason": section.get("reason"),
            "primitiveCounts": dict(counts),
            "firstUnsupportedPosition": bad,
            "classification": ("geometry-reader-blocker" if bad else "unclassified"),
            "textureSide": ("static-albedo-resolved-for-at-least-one-primitive"
                            if counts.get("staticAlbedo") else "no-static-albedo-in-scope"),
        })
    summary = Counter()
    for row in rows:
        summary["sections"] += 1
        if row["firstUnsupportedPosition"]:
            summary["geometryReaderBlocked"] += 1
            summary["positionType%d" % row["firstUnsupportedPosition"]["positionElement"]["type"]] += 1
            if row["primitiveCounts"].get("staticAlbedo"):
                summary["textureSideResolved"] += 1
    return rows, dict(summary)


def instance_report(slice_doc, scene, records, stream_path, out):
    sections = [s for s in slice_doc["draws"]["sections"] if s.get("instanceDescriptionsSkipped")]
    archive = atb.TextureArchive(records, stream_path)
    rows = []
    for section in sections:
        stage = STAGES / ("%s-g%d-n%d" % (LEVEL, section["geometryBlock"], section["nodeBlock"]))
        node_raw = (stage / "node.chunk").read_bytes()
        stream_prefix(node_raw, records[section["nodeChunkIndex"]])
        resources = resource_prefix(node_raw, {"resourcePayloadOffset": 24,
                                               "scenePayloadOffset": 0}, streamed=True)
        render_list = read_lists(node_raw, resources)[0]
        resolver = atb.Resolver(render_list, scene["effects"])
        material_counts = Counter()
        uv_counts = Counter()
        blocks = Counter()
        triangle_upper = 0
        for instance in render_list["instances"]:
            base = render_list["basePrimitives"][instance["primitiveIndex"]]
            material = resolver.resolve(base)
            if material["known"] and material["slot"] is not None:
                material_counts["staticAlbedo"] += 1
            elif material["seen"]:
                material_counts["runtimeAlbedo"] += 1
            elif material.get("otherTextures"):
                material_counts["otherTextureOnly"] += 1
            else:
                material_counts["noAlbedo"] += 1
            declaration = scene["declarations"][base["declaration"]]
            position = next((e for e in declaration
                             if e["usage"] == 0 and e["usageIndex"] == 0), None)
            uv = next((e for e in declaration
                       if e["usage"] == 5 and e["usageIndex"] == 0), None)
            if uv and uv["method"] == 0 and uv["type"] in (5, 8, 9):
                uv_counts["uv0Declaration"] += 1
            streams = {s["streamIndex"]: s for s in instance["streams"] if s["streamIndex"] != -1}
            streams.update({s["streamIndex"]: s for s in base["streams"] if s["streamIndex"] != -1})
            stream = streams.get(position["stream"]) if position else None
            if stream is None:
                continue
            vb_source = render_list["sources"]["vertexBuffer"][stream["vertexBuffer"]]
            ib_source = render_list["sources"]["indexBuffer"][base["indexBuffer"]]
            blocks[(vb_source["block"], vb_source["index"],
                    ib_source["block"], ib_source["index"])] += 1
            lod = base["lods"][0]
            if base["topology"] == 0:
                triangle_upper += lod["indexCount"] // 3
            elif base["topology"] == 1:
                triangle_upper += max(0, lod["indexCount"] - 2)
        block_rows = []
        referenced = sorted({block for key in blocks for block in (key[0], key[2])})
        for block in referenced:
            location = archive.block_index.get(block)
            if location is None:
                block_rows.append({"block": block, "lod0Item": None, "available": False})
                continue
            record_index, item_index = location
            record = records[record_index]
            block_rows.append({
                "block": block,
                "lod0Item": {"recordIndex": record_index, "itemIndex": item_index},
                "firstItemOfRecord": item_index == 0,
                "recordStoredBytes": record["storedBytes"],
                "recordPrerequisites": len(record["prerequisites"]),
                "available": True,
            })
        native_process = subprocess.run(
            [str(NATIVE), "--instances-all", rel(LEVEL_DIR / "level.levelrender"),
             rel(stage / "geometry.chunk"), rel(stage / "node.chunk"),
             str(section["geometryBlock"]), str(section["nodeBlock"])],
            capture_output=True, text=True, timeout=120)
        native_doc = json.loads(native_process.stdout) if native_process.stdout else {}
        native_dir = out / "instance-native"
        native_dir.mkdir(parents=True, exist_ok=True)
        (native_dir / ("%s-instances-all.json" % section["id"])).write_text(
            json.dumps(native_doc, separators=(",", ":")) + "\n", encoding="utf-8")
        first_blocks = [row["block"] for row in block_rows
                        if row["available"] and row["firstItemOfRecord"]][:16]
        chunk_paths = []
        chunk_dir = out / "instance-chunks"
        chunk_dir.mkdir(parents=True, exist_ok=True)
        for block in first_blocks:
            record_index = archive.block_index[block][0]
            data = archive.record_data(record_index)
            path = chunk_dir / ("block%d.chunk" % block)
            path.write_bytes(data)
            chunk_paths.append((block, path))
        bundle = {"attempted": bool(chunk_paths), "blocks": first_blocks, "result": None}
        if chunk_paths:
            command = [str(NATIVE), "--instances-bundle",
                       rel(LEVEL_DIR / "level.levelrender"), rel(stage / "node.chunk"),
                       str(section["nodeBlock"])]
            for block, path in chunk_paths:
                command += [str(block), rel(path)]
            process = subprocess.run(command, capture_output=True, text=True, timeout=120)
            doc = json.loads(process.stdout) if process.stdout else {}
            (native_dir / ("%s-instances-bundle.json" % section["id"])).write_text(
                json.dumps(doc, separators=(",", ":")) + "\n", encoding="utf-8")
            bundle["result"] = {
                "returncode": process.returncode,
                "status": doc.get("status"),
                "error": doc.get("error"),
                "drawCount": len(doc.get("draws", [])),
                "triangleCount": len(doc.get("indices", [])) // 3,
                "metadata": doc.get("metadata"),
            }
        rows.append({
            "id": section["id"],
            "geometryBlock": section["geometryBlock"],
            "nodeBlock": section["nodeBlock"],
            "instanceCount": len(render_list["instances"]),
            "basePrimitiveCount": len(render_list["basePrimitives"]),
            "materialCounts": dict(material_counts),
            "uv0Counts": dict(uv_counts),
            "triangleUpperBound": triangle_upper,
            "referencedBlocks": referenced,
            "blockDetail": block_rows,
            "firstItemBlocks": [row["block"] for row in block_rows if row["firstItemOfRecord"]],
            "nativeSingleChunk": {
                "returncode": native_process.returncode,
                "status": native_doc.get("status"),
                "emittedInstanceCount": (native_doc.get("metadata") or {}).get("emittedInstanceCount"),
                "omittedOtherBlockInstances": (native_doc.get("metadata") or {}).get("omittedOtherBlockInstances"),
                "drawCount": len(native_doc.get("draws", [])),
            },
            "nativeBundle": bundle,
            "classification": {
                "textureSide": ("static-albedo-resolved-for-all-instances"
                                if material_counts.get("staticAlbedo") == len(render_list["instances"])
                                else "partial"),
                "uv0Side": ("uv0-declared-for-all-instances"
                            if uv_counts.get("uv0Declaration") == len(render_list["instances"])
                            else "partial"),
                "geometrySide": "geometry-reader-blocker",
            },
        })
    return rows


def main() -> int:
    slice_doc = load_json(PACKAGE / "slice.json")
    levelrender = (LEVEL_DIR / "level.levelrender").read_bytes()
    scene = render_layout(levelrender, "level")["scene"]
    records = scene["stream"]["chunks"]
    out = OUT
    unsupported_rows, unsupported_summary = unsupported_report(slice_doc, scene, records)
    instance_rows = instance_report(slice_doc, scene, records,
                                    LEVEL_DIR / "level.levelstream", out)
    instance_summary = Counter()
    for row in instance_rows:
        instance_summary["sections"] += 1
        instance_summary["instances"] += row["instanceCount"]
        instance_summary["triangleUpperBound"] += row["triangleUpperBound"]
        instance_summary["staticAlbedoInstances"] += row["materialCounts"].get("staticAlbedo", 0)
        instance_summary["uv0DeclaredInstances"] += row["uv0Counts"].get("uv0Declaration", 0)
        instance_summary["referencedBlocks"] += len(row["referencedBlocks"])
        instance_summary["availableBlocks"] += sum(1 for item in row["blockDetail"] if item["available"])
        instance_summary["firstItemBlocks"] += sum(1 for item in row["blockDetail"] if item["firstItemOfRecord"])
        if row["nativeBundle"]["result"] and row["nativeBundle"]["result"]["status"] == "error":
            instance_summary["bundlePrerequisiteErrors"] += 1
    result = {
        "schema": SCHEMA,
        "kind": "map-slice-blockers",
        "level": LEVEL,
        "scope": {
            "dataOnly": True,
            "rendererChanged": False,
            "gpuClaim": False,
            "instancesApplied": False,
        },
        "inputs": {
            "slice": {"path": rel(PACKAGE / "slice.json"),
                      "sha256": atb.sha256_file(PACKAGE / "slice.json")},
            "levelrender": {"path": rel(LEVEL_DIR / "level.levelrender"),
                            "sha256": atb.sha256_bytes(levelrender)},
            "levelstream": {"path": rel(LEVEL_DIR / "level.levelstream"),
                            "sha256": atb.sha256_file(LEVEL_DIR / "level.levelstream")},
        },
        "unsupportedSections": {
            "count": len(unsupported_rows),
            "summary": unsupported_summary,
            "sections": unsupported_rows,
        },
        "instances": {
            "summary": dict(instance_summary),
            "sections": instance_rows,
        },
        "limits": [
            "Data only: no renderer, GPU, browser or full-game claim.",
            "The 27 sections stop in the committed direct-draw reader before material binding; their source materials are parsed separately and are not drawn.",
            "Instance material/UV0 declarations are source facts; no instance geometry is emitted by the committed reader in this package.",
            "Vertex element type 7 is reported as an unknown source type; its byte width is not documented in the repository and is not guessed.",
        ],
    }
    write_json(out / "blockers.json", result)
    print(json.dumps({"unsupported": unsupported_summary,
                      "instances": dict(instance_summary)}, indent=1))
    print("blockers:", rel(out / "blockers.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
