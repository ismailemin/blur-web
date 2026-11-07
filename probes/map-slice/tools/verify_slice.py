#!/usr/bin/env python3
"""Deterministic verifier for a map-slice package.

Re-reads the original level files and the committed map-pipeline artifacts,
recomputes collision triangles, merged draw buffers, layout metrics, the spawn
band and the physics-settle summary, and compares every value with the package.
It never writes outside the package directory and never modifies source data.

Usage:
    python probes/map-slice/tools/verify_slice.py [--package _work/map-slice/amboy]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
SCANNER_DIR = ROOT / "probes/map-pipeline/tools"
sys.path.insert(0, str(SCANNER_DIR))
import physics_scan  # noqa: E402
sys.path.insert(0, str(ROOT / "probes/map-slice/tools"))
from extract_slice import (  # noqa: E402
    BAND_OFFSETS_M, STATIONS_M, build_ray_triangles, canonical,
    point_segment_distance, vertical_hit,
)

CHECKS = 0
ERRORS: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if not condition:
        ERRORS.append(name + (": " + detail if detail else ""))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def source_check(source: dict) -> None:
    for key, record in source.items():
        path = ROOT / record["path"]
        check("source." + key + ".exists", path.is_file(), record["path"])
        if not path.is_file():
            continue
        data = path.read_bytes()
        check("source." + key + ".bytes", len(data) == record["bytes"],
              f"{len(data)} != {record['bytes']}")
        check("source." + key + ".sha256", sha256_bytes(data) == record["sha256"],
              record["path"])


def collision_check(slice_doc: dict, package: Path) -> tuple[dict, list]:
    record = slice_doc["collision"]
    physics_path = ROOT / slice_doc["source"]["levelPhysics"]["path"]
    data = physics_path.read_bytes()
    level = physics_scan.scan_level(data)
    triangles = physics_scan.flatten_static_triangles(level)

    positions: list[float] = []
    indices: list[int] = []
    ids: dict[tuple[float, float, float], int] = {}
    surface = steep = other = degenerate = 0
    minv = [math.inf] * 3
    maxv = [-math.inf] * 3
    for a, b, c in triangles:
        ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
        nx = uy * vz - uz * vy
        ny = uz * vx - ux * vz
        nz = ux * vy - uy * vx
        length = math.sqrt(nx * nx + ny * ny + nz * nz)
        if length < 1e-12:
            degenerate += 1
        elif ny / length > 0.94:
            surface += 1
        elif abs(ny / length) < 0.5:
            steep += 1
        else:
            other += 1
        for p in (a, b, c):
            key = (p[0], p[1], p[2])
            identifier = ids.get(key)
            if identifier is None:
                identifier = len(positions) // 3
                ids[key] = identifier
                positions.extend(key)
            indices.append(identifier)
            for axis in range(3):
                minv[axis] = min(minv[axis], p[axis])
                maxv[axis] = max(maxv[axis], p[axis])

    metrics = {
        "triangles": len(triangles),
        "vertices": len(positions) // 3,
        "triangleSoupVertices": len(indices),
        "surfaceTriangles": surface,
        "steepTriangles": steep,
        "otherTriangles": other,
        "degenerateTriangles": degenerate,
        "bounds": {"min": minv, "max": maxv},
        "fileVersion": level["fileVersion"],
        "streamVersion": level["streamVersion"],
        "shapeTypes": [s["importType"] for s in level["shapes"]],
    }
    for key in ("triangles", "vertices", "triangleSoupVertices", "surfaceTriangles",
                "steepTriangles", "otherTriangles", "degenerateTriangles",
                "fileVersion", "streamVersion"):
        check("collision." + key, metrics[key] == record[key],
              f"{metrics[key]} != {record[key]}")
    check("collision.bounds", metrics["bounds"] == record["bounds"])
    check("collision.shapeTypes",
          metrics["shapeTypes"] == [s["importType"] for s in record["shapes"]])

    stored_pos = np.frombuffer((package / record["positions"]["file"]).read_bytes(),
                               dtype="<f4")
    stored_idx = np.frombuffer((package / record["indices"]["file"]).read_bytes(),
                               dtype="<u4")
    expected_pos = np.asarray(positions, dtype="<f4")
    expected_idx = np.asarray(indices, dtype="<u4")
    check("collision.positions.binary", np.array_equal(stored_pos, expected_pos))
    check("collision.indices.binary", np.array_equal(stored_idx, expected_idx))
    check("collision.positions.hash",
          sha256_bytes(stored_pos.tobytes()) == record["positions"]["sha256"])
    check("collision.indices.hash",
          sha256_bytes(stored_idx.tobytes()) == record["indices"]["sha256"])
    check("collision.positions.count", int(stored_pos.size) == metrics["vertices"] * 3)
    check("collision.indices.count", int(stored_idx.size) == metrics["triangles"] * 3)
    return metrics, triangles


def draws_check(slice_doc: dict, package: Path) -> dict:
    record = slice_doc["draws"]
    probe_doc = load_json(ROOT / slice_doc["source"]["drawProbes"]["path"])
    entry = next(x for x in probe_doc["levels"] if x["level"] == slice_doc["level"])
    probes = sorted(entry["probes"], key=lambda p: (p["geometryBlock"], p["nodeBlock"]))
    supported = [p for p in probes if p["status"] == "ok"]
    unsupported = [p for p in probes if p["status"] != "ok"]

    positions: list[float] = []
    uv0: list[float] = []
    indices: list[int] = []
    draws = []
    textured = diagnostic = uv_missing = placeholders = 0
    section_offsets = {}
    stored_sections = {s["id"]: s for s in record["sections"]}

    for probe in supported:
        stage = ROOT / probe["stage"]
        native_path = stage / "native.json"
        native = load_json(native_path)
        meta = native["metadata"]
        vertex_count = int(meta["vertexCount"])
        check("draws." + probe["stage"] + ".positions",
              len(native["positions"]) == vertex_count * 3)
        check("draws." + probe["stage"] + ".uv0",
              len(native["uv0"]) == vertex_count * 2)
        check("draws." + probe["stage"] + ".indices",
              len(native["indices"]) == int(meta["triangleCount"]) * 3)
        section_index = f"g{probe['geometryBlock']}-n{probe['nodeBlock']}"
        stored_section = stored_sections[section_index]
        check("draws." + section_index + ".nativeJsonHash",
              sha256_file(native_path) == stored_section["nativeJson"]["sha256"])
        for chunk_name, record_name in (("geometry.chunk", "geometryChunk"),
                                        ("node.chunk", "nodeChunk")):
            chunk_path = stage / chunk_name
            check("draws." + section_index + "." + chunk_name + ".exists",
                  chunk_path.is_file())
            if chunk_path.is_file():
                check("draws." + section_index + "." + chunk_name + ".hash",
                      sha256_file(chunk_path) == stored_section[record_name]["sha256"])
        check("draws." + section_index + ".positionsHash",
              sha256_bytes(np.asarray(native["positions"], dtype="<f4").tobytes()) ==
              stored_section["positionsFloat32LESha256"])
        check("draws." + section_index + ".indicesHash",
              sha256_bytes(np.asarray(native["indices"], dtype="<u4").tobytes()) ==
              stored_section["indicesUint32LESha256"])
        vertex_offset = len(positions) // 3
        index_offset = len(indices)
        draw_offset = len(draws)
        positions.extend(native["positions"])
        uv0.extend(native["uv0"])
        indices.extend(int(i) + vertex_offset for i in native["indices"])
        placeholders += int(meta.get("placeholderUvVertices", 0) or 0)
        for ordinal, draw in enumerate(native["draws"]):
            if draw["albedoTexture"] is None:
                diagnostic += 1
            else:
                textured += 1
            if not draw["uv0Available"]:
                uv_missing += 1
            draws.append({
                "sectionDrawIndex": ordinal,
                "firstIndex": index_offset + int(draw["firstIndex"]),
                "indexCount": int(draw["indexCount"]),
                "albedoTexture": draw["albedoTexture"],
                "albedoParameter": draw.get("albedoParameter"),
                "binding": draw["binding"],
                "uv0Available": bool(draw["uv0Available"]),
                "material": None,
                "textureRef": None,
                "sectionId": section_index,
            })
        section_offsets[section_index] = {
            "vertexOffset": vertex_offset, "vertexCount": vertex_count,
            "indexOffset": index_offset, "indexCount": len(native["indices"]),
            "drawOffset": draw_offset, "drawCount": len(native["draws"]),
            "positionsFloat32LESha256": probe["positionsFloat32LESha256"],
            "indicesUint32LESha256": probe["indicesUint32LESha256"],
        }

    metrics = {
        "sectionsProbed": len(probes),
        "sectionsSupported": len(supported),
        "sectionsUnsupported": len(unsupported),
        "vertexCount": len(positions) // 3,
        "triangleCount": len(indices) // 3,
        "drawCount": len(draws),
        "texturedDraws": textured,
        "diagnosticDraws": diagnostic,
        "uv0MissingDraws": uv_missing,
        "uv0PlaceholderVertices": placeholders,
    }
    for key, value in metrics.items():
        check("draws." + key, value == record[key], f"{value} != {record[key]}")

    stored_pos = np.frombuffer((package / record["positions"]["file"]).read_bytes(),
                               dtype="<f4")
    stored_uv0 = np.frombuffer((package / record["uv0"]["file"]).read_bytes(),
                               dtype="<f4")
    stored_idx = np.frombuffer((package / record["indices"]["file"]).read_bytes(),
                               dtype="<u4")
    expected_pos = np.asarray(positions, dtype="<f4")
    expected_uv0 = np.asarray(uv0, dtype="<f4")
    expected_idx = np.asarray(indices, dtype="<u4")
    check("draws.positions.binary", np.array_equal(stored_pos, expected_pos))
    check("draws.uv0.binary", np.array_equal(stored_uv0, expected_uv0))
    check("draws.indices.binary", np.array_equal(stored_idx, expected_idx))
    check("draws.positions.hash",
          sha256_bytes(stored_pos.tobytes()) == record["positions"]["sha256"])
    check("draws.uv0.hash",
          sha256_bytes(stored_uv0.tobytes()) == record["uv0"]["sha256"])
    check("draws.indices.hash",
          sha256_bytes(stored_idx.tobytes()) == record["indices"]["sha256"])
    check("draws.positions.count", int(stored_pos.size) == metrics["vertexCount"] * 3)
    check("draws.uv0.count", int(stored_uv0.size) == metrics["vertexCount"] * 2)
    check("draws.indices.count", int(stored_idx.size) == metrics["triangleCount"] * 3)

    check("draws.sectionCount", len(stored_sections) == len(section_offsets))
    for section_id, expected in section_offsets.items():
        actual = stored_sections.get(section_id)
        check("draws.section." + section_id + ".present", actual is not None)
        if actual is None:
            continue
        for key in ("vertexOffset", "vertexCount", "indexOffset", "indexCount",
                    "drawOffset", "drawCount"):
            check("draws.section." + section_id + "." + key,
                  actual[key] == expected[key], f"{actual[key]} != {expected[key]}")
    check("draws.allDirectDrawsDiagnostic", textured == 0 and diagnostic == len(draws))
    check("draws.allUv0Present", uv_missing == 0)
    check("draws.noPlaceholderUv", placeholders == 0)

    stored_draws = record["draws"]
    check("draws.drawRecords", len(stored_draws) == len(draws))
    for index, (actual, expected) in enumerate(zip(stored_draws, draws)):
        for key in ("firstIndex", "indexCount", "albedoTexture", "uv0Available",
                    "sectionDrawIndex", "sectionId"):
            check(f"draws.record.{index}.{key}", actual[key] == expected[key])
        check(f"draws.record.{index}.albedoNull", actual["albedoTexture"] is None)

    stored_unsupported = {s["id"]: s for s in record["unsupportedSections"]}
    check("draws.unsupported.count", len(stored_unsupported) == len(unsupported))
    for probe in unsupported:
        section_id = f"g{probe['geometryBlock']}-n{probe['nodeBlock']}"
        actual = stored_unsupported.get(section_id)
        check("draws.unsupported." + section_id + ".present", actual is not None)
        if actual is None:
            continue
        error = probe.get("error") or ""
        text = error[len("native: "):] if error.startswith("native: ") else error
        reason, offset = text, None
        if " at byte " in text:
            head, tail = text.rsplit(" at byte ", 1)
            try:
                offset = int(tail.strip())
                reason = head
            except ValueError:
                pass
        check("draws.unsupported." + section_id + ".reason",
              actual["reason"] == reason, actual["reason"])
        check("draws.unsupported." + section_id + ".byteOffset",
              actual["byteOffset"] == offset, f"{actual['byteOffset']} != {offset}")
    return metrics


def layout_check(slice_doc: dict) -> dict:
    layout = slice_doc["layout"]
    covered = load_json(ROOT / slice_doc["source"]["coveredPath"]["path"])
    samples = covered["samples"]
    points = layout["points"]
    check("layout.pointCount", len(points) == layout["pointCount"])
    cumulative = [0.0]
    for a, b in zip(points, points[1:]):
        cumulative.append(cumulative[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    length = cumulative[-1]
    check("layout.length", abs(length - layout["lengthM"]) <= 1e-3,
          f"{length} != {layout['lengthM']}")
    check("layout.pointsSha256",
          sha256_bytes(np.asarray(points, dtype="<f4").tobytes()) == layout["pointsSha256"])
    check("layout.spawnIsFirst",
          abs(points[0][0] - layout["spawn"]["x"]) < 1e-9 and
          abs(points[0][1] - layout["spawn"]["z"]) < 1e-9)
    check("layout.finishIsLast",
          abs(points[-1][0] - layout["finish"]["x"]) < 1e-9 and
          abs(points[-1][1] - layout["finish"]["z"]) < 1e-9)
    check("layout.finishDistance", abs(cumulative[-1] - layout["finish"]["distanceM"]) < 1e-6)

    max_deviation = 0.0
    for point in points:
        best = min(range(len(samples)),
                   key=lambda i: (samples[i]["x"] - point[0]) ** 2 +
                                 (samples[i]["z"] - point[1]) ** 2)
        dev = math.inf
        for j in (best - 1, best):
            if 0 <= j < len(samples) - 1:
                dev = min(dev, point_segment_distance(
                    point[0], point[1], samples[j]["x"], samples[j]["z"],
                    samples[j + 1]["x"], samples[j + 1]["z"]))
        max_deviation = max(max_deviation, dev)
    check("layout.onCoveredPolyline", max_deviation < 1e-6, str(max_deviation))
    check("layout.maxDeviation", abs(max_deviation -
          layout["verification"]["maxDeviationFromCoveredPolylineM"]) < 1e-12)

    keys = {(round(p[0], 6), round(p[1], 6)) for p in points}
    embedded = sum(1 for s in samples if (round(s["x"], 6), round(s["z"], 6)) in keys)
    check("layout.coveredSamplesEmbedded", embedded == len(samples))
    check("layout.coveredSamplesPassable",
          layout["verification"]["coveredSamplesAllPassable"] is True)

    for checkpoint in layout["checkpoints"]:
        best = min(range(len(points)),
                   key=lambda i: (points[i][0] - checkpoint["x"]) ** 2 +
                                 (points[i][1] - checkpoint["z"]) ** 2)
        check("layout.checkpoint." + str(checkpoint["index"]) + ".distance",
              abs(cumulative[best] - checkpoint["distanceM"]) <= 1e-6)
        check("layout.checkpoint." + str(checkpoint["index"]) + ".pointIndex",
              best == checkpoint["pointIndex"])
    check("layout.checkpointOrder",
          all(a["distanceM"] < b["distanceM"]
              for a, b in zip(layout["checkpoints"], layout["checkpoints"][1:])))
    check("layout.checkpointBeforeFinish",
          all(c["distanceM"] < layout["lengthM"] for c in layout["checkpoints"]))

    tangent = math.atan2(points[1][0] - points[0][0], points[1][1] - points[0][1])
    error = abs(math.atan2(math.sin(tangent - layout["spawn"]["heading"]),
                           math.cos(tangent - layout["spawn"]["heading"])))
    check("layout.spawnHeading", error <= 1e-6, str(error))
    return {"lengthM": length, "maxDeviationM": max_deviation,
            "headingErrorRad": error, "embedded": embedded}


def spawn_check(slice_doc: dict, triangles) -> dict:
    proof = slice_doc["spawnProof"]
    records = build_ray_triangles(triangles)
    spawn = slice_doc["layout"]["spawn"]
    forward = (math.sin(spawn["heading"]), math.cos(spawn["heading"]))
    lateral = (math.cos(spawn["heading"]), -math.sin(spawn["heading"]))
    stored_hits = {}
    for row in proof["band"]:
        for entry in row:
            stored_hits[(entry["stationM"], entry["offsetM"])] = entry
    max_delta = 0.0
    hits = 0
    up = True
    heights = []
    for station in STATIONS_M:
        for offset in BAND_OFFSETS_M:
            x = spawn["x"] + forward[0] * station + lateral[0] * offset
            z = spawn["z"] + forward[1] * station + lateral[1] * offset
            hit = vertical_hit(records, x, z)
            stored = stored_hits[(station, offset)]
            check("spawn.hit." + f"{station:g}." + f"{offset:g}", hit["hit"] == stored.get("hit", True))
            if hit["hit"] and stored.get("hit", True):
                hits += 1
                up = up and hit["normal"][1] > 0.94
                heights.append(hit["y"])
                max_delta = max(max_delta, abs(hit["y"] - stored["y"]))
                check("spawn.up." + f"{station:g}." + f"{offset:g}",
                      (hit["normal"][1] > 0.94) == stored["upFacing"])
    check("spawn.hitCount", hits == proof["hitCount"])
    check("spawn.allHits", proof["allHits"] is True)
    check("spawn.allUpFacing", proof["allUpFacing"] is True and up)
    check("spawn.groundToLayout",
          abs(proof["groundY"] - spawn["ground"]) <= 1e-4,
          f"{proof['groundY']} vs {spawn['ground']}")
    check("spawn.maxDelta", max_delta <= 1e-6, str(max_delta))
    check("spawn.spread",
          abs((max(heights) - min(heights)) - proof["heightSpreadM"]) <= 1e-6)
    return {"hitCount": hits, "maxDeltaM": max_delta,
            "heightSpreadM": max(heights) - min(heights)}


def physics_check(slice_doc: dict, package: Path) -> dict:
    record = slice_doc["physicsProof"]
    path = package / record["file"]
    check("physics.file.exists", path.is_file())
    if not path.is_file():
        return {}
    check("physics.file.hash", sha256_file(path) == record["sha256"])
    doc = load_json(path)
    check("physics.schema", doc["schema"] == "blur.map-slice.physics-settle/1")
    check("physics.level", doc["level"] == slice_doc["level"])
    check("physics.inputs.level.hash",
          doc["inputs"]["levelPhysics"]["sha256"] ==
          slice_doc["source"]["levelPhysics"]["sha256"])
    check("physics.inputs.car.hash",
          doc["inputs"]["carFields"]["sha256"] ==
          slice_doc["source"]["carFields"]["sha256"])
    check("physics.module.hash",
          doc["module"]["sha256"] == slice_doc["source"]["e1Module"]["sha256"])
    check("physics.module.buildHash",
          doc["module"]["buildJsonSha256"] == slice_doc["source"]["e1Build"]["sha256"])
    wasm_path = ROOT / doc["module"]["wasmPath"]
    check("physics.module.wasmExists", wasm_path.is_file())
    if wasm_path.is_file():
        check("physics.module.wasmHash",
              sha256_file(wasm_path) == doc["module"]["wasmSha256"])
        build = load_json(ROOT / slice_doc["source"]["e1Build"]["path"])
        check("physics.module.buildWasmHash",
              build.get("wasmSha256") == doc["module"]["wasmSha256"])
        check("physics.module.buildDeterministic",
              build.get("buildDeterministic") is True)

    ticks = doc["ticks"]
    check("physics.tickCount", len(ticks) == 61)
    check("physics.tickSequence", [t["tick"] for t in ticks] == list(range(61)))
    check("physics.zeroInput",
          all(all(Number == 0 for Number in t["input"]) for t in ticks[1:]))
    check("physics.allFinite", all(t["finite"] for t in ticks))
    check("physics.allAnyContact", all(t["anyContact"] for t in ticks))
    check("physics.minWheelContacts", min(t["wheelContacts"] for t in ticks) == 4)
    check("physics.contactTicks", all(t["wheelContacts"] == 4 for t in ticks))
    check("physics.stateHashes",
          all(t["stateHash"].startswith("sha256:") and len(t["stateHash"]) == 71
              for t in ticks))

    summary = doc["summary"]
    check("physics.tick0Hash", summary["tick0StateHash"] == ticks[0]["stateHash"])
    check("physics.tick60Hash", summary["tick60StateHash"] == ticks[-1]["stateHash"])
    sequence = "sha256:" + hashlib.sha256(
        "\n".join(t["stateHash"] for t in ticks).encode("utf-8")).hexdigest()
    check("physics.sequenceHash", summary["stateSequenceHash"] == sequence)
    check("physics.summary.finite", summary["allFinite"] is True)
    check("physics.summary.contact", summary["allAnyContact"] is True)
    check("physics.summary.minContacts", summary["minWheelContacts"] == 4)
    drift = math.hypot(ticks[-1]["position"][0] - ticks[0]["position"][0],
                       ticks[-1]["position"][2] - ticks[0]["position"][2])
    check("physics.summary.drift", abs(summary["driftM"] - drift) <= 1e-6)
    ride = ticks[0]["position"][1] - summary["groundY"]
    check("physics.summary.rideHeight", abs(summary["rideHeightM"] - ride) <= 1e-6)
    check("physics.determinism", doc["determinism"]["identical"] is True)
    check("physics.determinism.sequence",
          doc["determinism"]["sequenceA"] == doc["determinism"]["sequenceB"])
    check("physics.groundProbes",
          len(doc["groundProbes"]) == len(BAND_OFFSETS_M) * len(STATIONS_M))
    check("physics.groundProbes.allHit",
          all(row["probe"].get("hit") == 1 for row in doc["groundProbes"]))
    check("physics.groundProbes.allUp",
          all(row["probe"].get("normal", [0, 0, 0])[1] > 0.94
              for row in doc["groundProbes"]))
    check("physics.spawnMatchesLayout",
          abs(doc["inputs"]["spawn"]["x"] - slice_doc["layout"]["spawn"]["x"]) < 1e-9 and
          abs(doc["inputs"]["spawn"]["z"] - slice_doc["layout"]["spawn"]["z"]) < 1e-9 and
          abs(doc["inputs"]["spawn"]["heading"] - slice_doc["layout"]["spawn"]["heading"]) < 1e-9)
    check("physics.sliceSummary.sequence",
          record["summary"]["stateSequenceHash"] == summary["stateSequenceHash"])
    check("physics.sliceSummary.tick0",
          record["summary"]["tick0StateHash"] == summary["tick0StateHash"])
    return {
        "tick0StateHash": summary["tick0StateHash"],
        "tick60StateHash": summary["tick60StateHash"],
        "stateSequenceHash": summary["stateSequenceHash"],
        "driftM": summary["driftM"],
        "rideHeightM": summary["rideHeightM"],
    }


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", default="_work/map-slice/amboy")
    args = parser.parse_args(argv)
    package = ROOT / args.package
    slice_path = package / "slice.json"
    if not slice_path.is_file():
        raise SystemExit("BLOCKED: missing " + rel(slice_path))
    slice_doc = load_json(slice_path)

    check("schema", slice_doc.get("schema") == "blur.map-slice/1")
    check("kind", slice_doc.get("kind") == "map-slice-package")
    check("level", slice_doc.get("level") == "usa_amboy")
    check("scope.noPlayableClaim", slice_doc["scope"]["playableClaim"] is False)
    check("scope.noRendererClaim", slice_doc["scope"]["rendererClaim"] is False)
    check("scope.noGpuClaim", slice_doc["scope"]["gpuClaim"] is False)
    check("scope.noE1Integration", slice_doc["scope"]["e1DriveIntegration"] is False)
    check("scope.instancesNotApplied", slice_doc["scope"]["instancesApplied"] is False)
    check("scope.materialsNotApplied", slice_doc["scope"]["materialsApplied"] is False)
    check("scope.texturesNotBound", slice_doc["scope"]["texturesBound"] is False)

    source_check(slice_doc["source"])

    body = {k: v for k, v in slice_doc.items() if k != "hashes"}
    check("hashes.content", sha256_bytes(canonical(body)) ==
          slice_doc["hashes"]["contentSha256"])

    for name, record in slice_doc["hashes"]["files"].items():
        path = package / name
        check("files." + name + ".exists", path.is_file())
        if not path.is_file():
            continue
        check("files." + name + ".bytes", path.stat().st_size == record["bytes"])
        check("files." + name + ".sha256", sha256_file(path) == record["sha256"])

    metrics, triangles = collision_check(slice_doc, package)
    draw_metrics = draws_check(slice_doc, package)
    layout_metrics = layout_check(slice_doc)
    spawn_metrics = spawn_check(slice_doc, triangles)
    physics_metrics = physics_check(slice_doc, package)

    textures = slice_doc["textures"]
    check("textures.noneBound", textures["status"] == "none-bound")
    check("textures.zeroCount", textures["boundCount"] == 0)
    check("textures.emptyItems", textures["items"] == [])
    check("textures.reason", len(textures["reason"]) > 0)
    check("textures.diagnostic",
          slice_doc["draws"]["texturedDraws"] == 0 and
          slice_doc["draws"]["diagnosticDraws"] == slice_doc["draws"]["drawCount"])

    payload_files = sorted(p.name for p in package.iterdir()
                           if p.is_file() and p.name not in ("slice.json", "verify.json"))
    check("files.manifestMatches", payload_files == sorted(slice_doc["hashes"]["files"]))

    result = {
        "schema": "blur.map-slice.verify/1",
        "level": slice_doc["level"],
        "package": args.package.replace("\\", "/"),
        "verdict": "PASS" if not ERRORS else "FAIL",
        "checks": CHECKS,
        "errors": ERRORS,
        "packageHashes": {
            "slice.json": {"bytes": slice_path.stat().st_size,
                           "sha256": sha256_file(slice_path)},
            "physics-settle.json": {
                "bytes": (package / "physics-settle.json").stat().st_size,
                "sha256": sha256_file(package / "physics-settle.json")},
            "payloadBytes": sum((package / name).stat().st_size
                                for name in slice_doc["hashes"]["files"]),
        },
        "recomputed": {
            "collision": {k: metrics[k] for k in
                          ("triangles", "vertices", "surfaceTriangles",
                           "steepTriangles", "otherTriangles", "degenerateTriangles")},
            "draws": draw_metrics,
            "layout": {**layout_metrics,
                       "coverageOfCollisionDiameter": 2060.595 / 2110.801},
            "spawn": spawn_metrics,
            "physics": physics_metrics,
        },
        "limits": [
            "direct-draw LOD0 only; instances not applied",
            "0 bound albedo textures; direct-draw material binding unresolved",
            "no decoded vertex normals",
            "point-to-point course only; no lap claim",
            "physics proof is a zero-input settle, not a driven lap",
            "no browser, GPU, renderer or playable-game claim",
        ],
    }
    verify_path = package / "verify.json"
    verify_path.write_text(json.dumps(result, indent=1,
                                      ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "verdict": result["verdict"],
        "checks": result["checks"],
        "errors": result["errors"],
        "verify": rel(verify_path),
        "verifySha256": sha256_file(verify_path),
        "collisionTriangles": metrics["triangles"],
        "drawTriangles": draw_metrics["triangleCount"],
        "draws": draw_metrics["drawCount"],
        "lengthM": layout_metrics["lengthM"],
        "physics": physics_metrics,
    }, indent=1))
    return 0 if not ERRORS else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
