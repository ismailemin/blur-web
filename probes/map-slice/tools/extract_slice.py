#!/usr/bin/env python3
"""Build a self-describing map slice package for one Blur level.

The package is data only: collision triangles, first-RenderList direct draw
geometry (positions / UV0 / indices), the measured candidate layout, the
candidate spawn proof, and a physics-settle record produced by the existing E1
wasm module. No renderer, GPU, e1-drive integration or playable-game claim is
made.

Inputs are read-only:

  * game-data/Blur/levels/<level>/Level.levelphysics
  * game-data/Blur/levels/<level>/level.levelrender
  * _work/map-pipeline/draw-probes-all.json + probes/<level>-g*/native.json
  * _work/map-pipeline/candidates/<level>.layout.json
  * _work/map-pipeline/covered/<level>-path.json
  * _work/map-pipeline/grids/<level>.npz
  * _work/e1-drive/car.fields and _work/e1-drive/module/e1_drive.*

Collision extraction uses the committed map-pipeline scanner
(`probes/map-pipeline/tools/physics_scan.py`), which follows the upstream
serializer; the committed collision oracle alone rejects this level because its
first shape is a Box. Draw extraction reuses the committed native reader output
(`level_inspect`); no geometry value is re-derived or invented.

Usage:
    python probes/map-slice/tools/extract_slice.py [--level usa_amboy]
        [--out _work/map-slice/amboy]

Writes only under the selected output directory and _work/logs/map-slice/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
SCANNER_DIR = ROOT / "probes/map-pipeline/tools"
sys.path.insert(0, str(SCANNER_DIR))
import physics_scan  # noqa: E402

SCHEMA = "blur.map-slice/1"
LAYOUT_SCHEMA = "blur.map-slice.layout/1"
PHYSICS_SCHEMA = "blur.map-slice.physics-settle/1"

DRAW_PROBES = ROOT / "_work/map-pipeline/draw-probes-all.json"
GRID_DIR = ROOT / "_work/map-pipeline/grids"
CANDIDATE_DIR = ROOT / "_work/map-pipeline/candidates"
COVERED_DIR = ROOT / "_work/map-pipeline/covered"
CAR_FIELDS = ROOT / "_work/e1-drive/car.fields"
E1_MODULE = ROOT / "_work/e1-drive/module/e1_drive.mjs"
E1_BUILD = ROOT / "_work/e1-drive/module/build.json"
NATIVE_READER = ROOT / "_work/build/asset-reader-native/Release/level_inspect.exe"

BAND_OFFSETS_M = (-0.5, -0.25, 0.0, 0.25, 0.5)
STATIONS_M = (0.0, 1.0, 2.0, 3.0, 4.0)
RAY_START_Y = 50.0
RAY_MIN_Y = -50.0
RAY_MAX_Y = 5.0


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def file_record(path: Path) -> dict:
    data = path.read_bytes()
    return {"path": rel(path), "bytes": len(data), "sha256": sha256_bytes(data)}


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def write_json(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False,
                               allow_nan=False) + "\n", encoding="utf-8")


def f32(values) -> np.ndarray:
    array = np.asarray(values, dtype="<f4")
    if not np.isfinite(array).all():
        raise SystemExit("FAILED: non-finite float in a binary export")
    return array


def u32(values) -> np.ndarray:
    array = np.asarray(values, dtype="<u4")
    if array.size and int(array.max()) > 0xFFFFFFFF:
        raise SystemExit("FAILED: uint32 export overflow")
    return array


def write_bin(path: Path, array: np.ndarray) -> dict:
    data = array.tobytes(order="C")
    path.write_bytes(data)
    return {"file": path.name, "bytes": len(data), "sha256": sha256_bytes(data),
            "dtype": str(array.dtype), "count": int(array.size)}


# ---------------------------------------------------------------- collision

def collision_geometry(level_path: Path) -> dict:
    data = level_path.read_bytes()
    level = physics_scan.scan_level(data)
    triangles = physics_scan.flatten_static_triangles(level)

    positions: list[float] = []
    indices: list[int] = []
    vertex_id: dict[tuple[float, float, float], int] = {}
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
        else:
            y = ny / length
            if y > 0.94:
                surface += 1
            elif abs(y) < 0.5:
                steep += 1
            else:
                other += 1
        for p in (a, b, c):
            key = (p[0], p[1], p[2])
            identifier = vertex_id.get(key)
            if identifier is None:
                identifier = len(positions) // 3
                vertex_id[key] = identifier
                positions.extend(key)
            indices.append(identifier)
            for axis in range(3):
                minv[axis] = min(minv[axis], p[axis])
                maxv[axis] = max(maxv[axis], p[axis])

    shapes = []
    for shape in level["shapes"]:
        base = {"index": shape["index"], "importType": shape["importType"],
                "importName": shape["importName"]}
        if shape.get("importType") in (0, 11):
            base.update({
                "shipped": True,
                "vertexCount": shape["numVertices"],
                "triangleCount": len(shape["triangles"]),
                "leafCount": len(shape["leaves"]),
                "bounds": {"min": [float(v) for v in shape["low"]],
                           "max": [float(v) for v in shape["high"]]},
            })
        else:
            reasons = {
                2: "box collision shape; not a triangle mesh and not part of the "
                   "drivable triangle surface",
                6: "cylinder collision shape; not a triangle mesh and not part of "
                   "the drivable triangle surface",
                10: "InstancedTriangleMesh instance geometry is not decoded by the "
                    "committed scanner (instances are not applied)",
            }
            base.update({"shipped": False,
                         "reason": reasons.get(shape["importType"],
                                               "shape type not decoded")})
        shapes.append(base)

    return {
        "triangles": len(triangles),
        "vertices": len(positions) // 3,
        "triangleSoupVertices": len(indices),
        "surfaceTriangles": surface,
        "steepTriangles": steep,
        "otherTriangles": other,
        "degenerateTriangles": degenerate,
        "bounds": {"min": minv, "max": maxv},
        "positions": positions,
        "indices": indices,
        "shapes": shapes,
        "fileVersion": level["fileVersion"],
        "streamVersion": level["streamVersion"],
        "shapeStreamEnd": level["shapeStreamEnd"],
        "routeCount": level["routeCount"],
        "routesParsed": level["routesParsed"],
        "sourceSha256": sha256_bytes(data),
        "scanner": file_record(SCANNER_DIR / "physics_scan.py"),
        "oracle": file_record(ROOT / "probes/collision-oracle/tests/reference_oracle.py"),
    }


# ---------------------------------------------------------------- ray casting

def build_ray_triangles(triangles):
    records = []
    for a, b, c in triangles:
        ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
        nx = uy * vz - uz * vy
        ny = uz * vx - ux * vz
        nz = ux * vy - uy * vx
        length = math.sqrt(nx * nx + ny * ny + nz * nz)
        if length < 1e-12:
            continue
        records.append({
            "a": a, "b": b, "c": c,
            "minx": min(a[0], b[0], c[0]), "maxx": max(a[0], b[0], c[0]),
            "minz": min(a[2], b[2], c[2]), "maxz": max(a[2], b[2], c[2]),
            "normal": (nx / length, ny / length, nz / length),
        })
    return records


def vertical_hit(records, x: float, z: float) -> dict:
    """Highest upward/downward triangle under a vertical ray at (x, z)."""
    best = None
    for t in records:
        if x < t["minx"] or x > t["maxx"] or z < t["minz"] or z > t["maxz"]:
            continue
        a, b, c = t["a"], t["b"], t["c"]
        denom = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
        if abs(denom) < 1e-15:
            continue
        u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denom
        v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denom
        w = 1.0 - u - v
        if u < -1e-9 or v < -1e-9 or w < -1e-9:
            continue
        y = u * a[1] + v * b[1] + w * c[1]
        if y < RAY_MIN_Y or y > RAY_MAX_Y:
            continue
        if best is None or y > best["y"]:
            best = {"hit": True, "y": y, "normal": list(t["normal"]),
                    "barycentric": [u, v, w]}
    return best if best is not None else {"hit": False}


def spawn_proof(records, spawn: dict) -> dict:
    heading = float(spawn["heading"])
    forward = (math.sin(heading), math.cos(heading))
    lateral = (math.cos(heading), -math.sin(heading))
    x0, z0 = float(spawn["x"]), float(spawn["z"])

    band = []
    for station in STATIONS_M:
        row = []
        for offset in BAND_OFFSETS_M:
            x = x0 + forward[0] * station + lateral[0] * offset
            z = z0 + forward[1] * station + lateral[1] * offset
            hit = vertical_hit(records, x, z)
            if hit["hit"]:
                row.append({
                    "hit": True,
                    "stationM": station, "offsetM": offset,
                    "x": round(x, 6), "z": round(z, 6),
                    "y": round(hit["y"], 9),
                    "normal": [round(v, 9) for v in hit["normal"]],
                    "upFacing": hit["normal"][1] > 0.94,
                })
            else:
                row.append({"stationM": station, "offsetM": offset,
                            "x": round(x, 6), "z": round(z, 6),
                            "hit": False})
        band.append(row)

    hits = [h for row in band for h in row if h.get("hit")]
    heights = [h["y"] for h in hits]
    center = [h for h in hits if h["stationM"] == 0.0 and h["offsetM"] == 0.0]
    if not center:
        raise SystemExit("FAILED: no collision hit at the candidate spawn")
    ground = center[0]["y"]
    return {
        "ray": {"axis": "vertical down", "startY": RAY_START_Y,
                "minY": RAY_MIN_Y, "maxY": RAY_MAX_Y,
                "rule": "highest triangle hit under the point; no interpolation"},
        "center": center[0],
        "groundY": round(ground, 9),
        "deltaToLayoutGroundM": round(ground - float(spawn["ground"]), 9),
        "band": band,
        "bandOffsetsM": list(BAND_OFFSETS_M),
        "stationsM": list(STATIONS_M),
        "hitCount": len(hits),
        "expectedHitCount": len(BAND_OFFSETS_M) * len(STATIONS_M),
        "allHits": len(hits) == len(BAND_OFFSETS_M) * len(STATIONS_M),
        "allUpFacing": all(h["normal"][1] > 0.94 for h in hits),
        "heightSpreadM": round(max(heights) - min(heights), 9),
        "maxAbsHeightDeviationM": round(max(abs(h - ground) for h in heights), 9),
        "widthM": 1.0,
        "lengthM": max(STATIONS_M) + 1.0,
    }


# ---------------------------------------------------------------- draws

def parse_unsupported(error: str) -> dict:
    prefix = "native: "
    text = error[len(prefix):] if error.startswith(prefix) else error
    offset = None
    marker = " at byte "
    if marker in text:
        head, tail = text.rsplit(marker, 1)
        try:
            offset = int(tail.strip())
            text = head
        except ValueError:
            pass
    return {"reason": text, "byteOffset": offset}


def draw_geometry(level_path: Path, draw_probes_path: Path) -> dict:
    probe_doc = load_json(draw_probes_path)
    entry = next((x for x in probe_doc["levels"] if x.get("level") == level_path.parent.name), None)
    if entry is None:
        raise SystemExit("FAILED: no draw probe entry for " + level_path.parent.name)

    probes = sorted(entry["probes"],
                    key=lambda p: (p["geometryBlock"], p["nodeBlock"]))
    supported = [p for p in probes if p["status"] == "ok"]
    unsupported = [p for p in probes if p["status"] != "ok"]

    all_positions: list[float] = []
    all_uv0: list[float] = []
    all_indices: list[int] = []
    sections = []
    global_draws = []
    textured = 0
    diagnostic = 0
    uv_missing = 0
    placeholder_vertices = 0
    instance_descriptions = 0

    for probe in supported:
        stage = ROOT / probe["stage"]
        native_path = stage / "native.json"
        native = load_json(native_path)
        meta = native["metadata"]
        vertex_count = int(meta["vertexCount"])
        triangle_count = int(meta["triangleCount"])
        draw_count = int(meta["primitiveCount"])
        if len(native["positions"]) != vertex_count * 3:
            raise SystemExit("FAILED: position count mismatch at " + str(native_path))
        if len(native["uv0"]) != vertex_count * 2:
            raise SystemExit("FAILED: UV0 count mismatch at " + str(native_path))
        if len(native["indices"]) != triangle_count * 3:
            raise SystemExit("FAILED: index count mismatch at " + str(native_path))
        if len(native["draws"]) != draw_count:
            raise SystemExit("FAILED: draw count mismatch at " + str(native_path))
        max_index = max(native["indices"]) if native["indices"] else -1
        if max_index >= vertex_count:
            raise SystemExit("FAILED: index out of range at " + str(native_path))
        if sum(d["indexCount"] for d in native["draws"]) != len(native["indices"]):
            raise SystemExit("FAILED: draw ranges do not cover the index buffer at " +
                             str(native_path))

        vertex_offset = len(all_positions) // 3
        index_offset = len(all_indices)
        draw_offset = len(global_draws)
        all_positions.extend(native["positions"])
        all_uv0.extend(native["uv0"])
        all_indices.extend(int(i) + vertex_offset for i in native["indices"])
        placeholder_vertices += int(meta.get("placeholderUvVertices", 0) or 0)
        instance_descriptions += int(meta.get("instanceDescriptionsSkipped", 0) or 0) + \
            int(meta.get("instanceBatchDescriptionsSkipped", 0) or 0)

        draws = []
        for ordinal, draw in enumerate(native["draws"]):
            albedo = draw["albedoTexture"]
            if albedo is None:
                diagnostic += 1
            else:
                textured += 1
            if not draw["uv0Available"]:
                uv_missing += 1
            record = {
                "sectionDrawIndex": ordinal,
                "firstIndex": index_offset + int(draw["firstIndex"]),
                "indexCount": int(draw["indexCount"]),
                "albedoTexture": albedo,
                "albedoParameter": draw.get("albedoParameter"),
                "binding": draw["binding"],
                "uv0Available": bool(draw["uv0Available"]),
                "material": None,
                "textureRef": None,
            }
            draws.append(record)
            global_draws.append({**record, "sectionId": f"g{probe['geometryBlock']}-n{probe['nodeBlock']}"})

        sections.append({
            "id": f"g{probe['geometryBlock']}-n{probe['nodeBlock']}",
            "geometryBlock": probe["geometryBlock"],
            "nodeBlock": probe["nodeBlock"],
            "geometryChunkIndex": probe.get("geometryChunkIndex"),
            "nodeChunkIndex": probe.get("nodeChunkIndex"),
            "status": "supported",
            "stage": rel(stage),
            "nativeJson": file_record(native_path),
            "geometryChunk": {"file": rel(stage / "geometry.chunk"),
                              "bytes": probe["geometryChunkBytes"],
                              "sha256": probe["geometryChunkSha256"]},
            "nodeChunk": {"file": rel(stage / "node.chunk"),
                          "bytes": probe["nodeChunkBytes"],
                          "sha256": probe["nodeChunkSha256"]},
            "vertexOffset": vertex_offset,
            "vertexCount": vertex_count,
            "indexOffset": index_offset,
            "indexCount": len(native["indices"]),
            "triangleCount": triangle_count,
            "drawOffset": draw_offset,
            "drawCount": draw_count,
            "bounds": native["bounds"],
            "positionsFloat32LESha256": probe["positionsFloat32LESha256"],
            "indicesUint32LESha256": probe["indicesUint32LESha256"],
            "uv0Available": True,
            "uv0PlaceholderVertices": int(meta.get("placeholderUvVertices", 0) or 0),
            "material": "diagnostic-only",
            "materialBinding": "Level materials not applied in diagnostic preview",
            "textureRefs": [],
            "normals": "not-exported-by-native-direct-draw-reader",
            "instancesApplied": bool(meta.get("instancesApplied", False)),
            "instanceDescriptionsSkipped": int(meta.get("instanceDescriptionsSkipped", 0) or 0),
            "instanceBasePrimitivesSkipped": int(meta.get("instanceBasePrimitivesSkipped", 0) or 0),
            "nodeTransformsApplied": bool(meta.get("nodeTransformsApplied", False)),
            "coordinateSpace": meta.get("coordinateSpace"),
            "scope": meta.get("scope"),
            "draws": draws,
        })

    unsupported_records = []
    for probe in sorted(unsupported, key=lambda p: (p["geometryBlock"], p["nodeBlock"])):
        parsed = parse_unsupported(probe.get("error") or "")
        unsupported_records.append({
            "id": f"g{probe['geometryBlock']}-n{probe['nodeBlock']}",
            "geometryBlock": probe["geometryBlock"],
            "nodeBlock": probe["nodeBlock"],
            "geometryChunkIndex": probe.get("geometryChunkIndex"),
            "nodeChunkIndex": probe.get("nodeChunkIndex"),
            "estimatedSourceIndexCount": probe.get("estimatedSourceIndexCount"),
            "status": "unsupported",
            "reason": parsed["reason"],
            "byteOffset": parsed["byteOffset"],
            "error": probe.get("error"),
            "geometryChunk": probe.get("geometryChunkSha256"),
            "nodeChunk": probe.get("nodeChunkSha256"),
        })

    if textured != 0:
        raise SystemExit("FAILED: unexpected non-null albedo on a direct draw")

    return {
        "sectionsProbed": len(probes),
        "sectionsSupported": len(supported),
        "sectionsUnsupported": len(unsupported),
        "vertexCount": len(all_positions) // 3,
        "triangleCount": len(all_indices) // 3,
        "drawCount": len(global_draws),
        "texturedDraws": textured,
        "diagnosticDraws": diagnostic,
        "uv0MissingDraws": uv_missing,
        "uv0PlaceholderVertices": placeholder_vertices,
        "instanceDescriptionsSkipped": instance_descriptions,
        "positions": all_positions,
        "uv0": all_uv0,
        "indices": all_indices,
        "draws": global_draws,
        "sections": sections,
        "unsupportedSections": unsupported_records,
        "sourceSha256": sha256_file(level_path),
        "probeDocSha256": sha256_file(draw_probes_path),
        "nativeReader": file_record(NATIVE_READER),
    }


# ---------------------------------------------------------------- layout

def point_segment_distance(px, pz, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az
    length2 = dx * dx + dz * dz
    if length2 == 0.0:
        return math.hypot(px - ax, pz - az)
    t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / length2))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


def layout_document(candidate_path: Path, covered_path: Path, level: str) -> tuple[dict, list[list[float]]]:
    candidate = load_json(candidate_path)
    covered = load_json(covered_path)
    points = candidate["course"]["points"]
    samples = covered["samples"]
    if candidate["level"] != level or covered["level"] != level:
        raise SystemExit("FAILED: candidate/covered path level mismatch")

    cumulative = [0.0]
    for a, b in zip(points, points[1:]):
        cumulative.append(cumulative[-1] + math.hypot(b["x"] - a["x"], b["z"] - a["z"]))
    length = cumulative[-1]
    declared = float(candidate["course"]["lengthM"])
    if abs(length - declared) > 1e-3:
        raise SystemExit("FAILED: candidate polyline length %.9f != declared %.9f" %
                         (length, declared))

    # Every layout point must lie on the measured draw-covered polyline.
    max_deviation = 0.0
    for point in points:
        best = min(range(len(samples)),
                   key=lambda i: (samples[i]["x"] - point["x"]) ** 2 +
                                 (samples[i]["z"] - point["z"]) ** 2)
        dev = math.inf
        for j in (best - 1, best):
            if 0 <= j < len(samples) - 1:
                dev = min(dev, point_segment_distance(
                    point["x"], point["z"], samples[j]["x"], samples[j]["z"],
                    samples[j + 1]["x"], samples[j + 1]["z"]))
        max_deviation = max(max_deviation, dev)

    # All measured covered samples must be present in the dense layout.
    layout_keys = {(round(p["x"], 6), round(p["z"], 6)) for p in points}
    embedded = sum(1 for s in samples if (round(s["x"], 6), round(s["z"], 6)) in layout_keys)

    # The measured path sits on a 1/12 m coordinate lattice (0.25 m and
    # sqrt(2)/6 m steps are both integer multiples of 1/12 m).
    grid_error = 0.0
    for p in points:
        grid_error = max(grid_error, abs(p["x"] * 12.0 - round(p["x"] * 12.0)),
                         abs(p["z"] * 12.0 - round(p["z"] * 12.0)))

    def station_of(target):
        best = min(range(len(points)),
                   key=lambda i: (points[i]["x"] - target["x"]) ** 2 +
                                 (points[i]["z"] - target["z"]) ** 2)
        return best, math.hypot(points[best]["x"] - target["x"],
                                points[best]["z"] - target["z"]), cumulative[best]

    checkpoints = []
    for index, checkpoint in enumerate(candidate["course"]["checkpoints"], start=1):
        point_index, nearest, distance = station_of(checkpoint)
        checkpoints.append({
            "index": index,
            "distanceM": round(distance, 6),
            "pointIndex": point_index,
            "nearestPointDeltaM": round(nearest, 6),
            "x": checkpoint["x"],
            "z": checkpoint["z"],
            "ground": checkpoint["h"],
        })
    finish_index, finish_delta, finish_distance = station_of(candidate["course"]["finish"])
    spawn = candidate["spawn"]
    start_index, start_delta, start_distance = station_of(spawn)
    if abs(start_distance) > 1e-9 or abs(finish_distance - length) > 1e-6:
        raise SystemExit("FAILED: spawn/finish are not the layout endpoints")

    # Grid passability: every measured covered sample must be passable; record
    # how many dense layout points fall on a passable nearest audit cell.
    grid_path = GRID_DIR / f"{level}.npz"
    grid = np.load(grid_path)
    xs, zs = grid["xs"], grid["zs"]
    passable = grid["passable"]
    height = grid["height"]
    covered_passable = 0
    for sample in samples:
        ix = int(np.abs(xs - sample["x"]).argmin())
        iz = int(np.abs(zs - sample["z"]).argmin())
        covered_passable += int(passable[iz, ix])
    layout_passable = 0
    for point in points:
        ix = int(np.abs(xs - point["x"]).argmin())
        iz = int(np.abs(zs - point["z"]).argmin())
        layout_passable += int(passable[iz, ix])

    heading = float(spawn["heading"])
    tangent = math.atan2(points[1]["x"] - points[0]["x"],
                         points[1]["z"] - points[0]["z"])
    heading_error = abs(math.atan2(math.sin(tangent - heading),
                                   math.cos(tangent - heading)))

    dense_points = [[p["x"], p["z"], p["h"]] for p in points]
    points_bytes = np.asarray(dense_points, dtype="<f4").tobytes(order="C")

    document = {
        "schema": LAYOUT_SCHEMA,
        "mode": "point-to-point",
        "direction": "spawn -> checkpoints -> finish",
        "level": level,
        "spawn": {
            "x": spawn["x"], "z": spawn["z"], "ground": spawn["ground"],
            "heading": spawn["heading"],
            "headingReason": spawn.get("headingReason"),
            "source": spawn.get("source"),
            "stationM": 0.0,
        },
        "checkpoints": checkpoints,
        "finish": {
            "x": candidate["course"]["finish"]["x"],
            "z": candidate["course"]["finish"]["z"],
            "ground": candidate["course"]["finish"]["h"],
            "distanceM": round(length, 6),
            "pointIndex": finish_index,
            "nearestPointDeltaM": round(finish_delta, 6),
        },
        "lengthM": round(length, 6),
        "pointCount": len(points),
        "sampleStepM": candidate["course"].get("sampleStepM"),
        "points": dense_points,
        "pointsFormat": "float32le x,z,h; 12 bytes per point",
        "pointsSha256": sha256_bytes(points_bytes),
        "verification": {
            "declaredLengthM": declared,
            "lengthErrorM": round(length - declared, 9),
            "onCoveredPolyline": max_deviation < 1e-6,
            "maxDeviationFromCoveredPolylineM": max_deviation,
            "coveredSampleCount": len(samples),
            "coveredSamplesEmbedded": embedded,
            "coveredSamplesEmbeddedAll": embedded == len(samples),
            "auditGridStepM": 1.0 / 12.0,
            "maxGridCoordinateError": grid_error,
            "coveredSamplesPassable": covered_passable,
            "coveredSamplesAllPassable": covered_passable == len(samples),
            "layoutPointsOnPassableNearestCell": layout_passable,
            "layoutPoints": len(points),
            "spawnPointIndex": start_index,
            "spawnNearestPointDeltaM": round(start_delta, 6),
            "headingTangentRad": tangent,
            "headingErrorRad": heading_error,
        },
        "source": {
            "candidate": file_record(candidate_path),
            "coveredPath": file_record(covered_path),
            "grid": file_record(grid_path),
        },
    }
    return document, dense_points


# ---------------------------------------------------------------- assembly

def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--level", default="usa_amboy")
    parser.add_argument("--out", default="_work/map-slice/amboy")
    args = parser.parse_args(argv)

    level = args.level
    out = ROOT / args.out
    logs = ROOT / "_work/logs/map-slice"
    logs.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)

    level_dir = ROOT / "game-data/Blur/levels" / level
    physics_path = level_dir / "Level.levelphysics"
    render_path = level_dir / "level.levelrender"
    candidate_path = CANDIDATE_DIR / f"{level}.layout.json"
    covered_path = COVERED_DIR / f"{level}-path.json"
    grid_path = GRID_DIR / f"{level}.npz"

    for required in (physics_path, render_path, candidate_path, covered_path,
                     grid_path, DRAW_PROBES, CAR_FIELDS, E1_MODULE, E1_BUILD):
        if not required.is_file():
            raise SystemExit("BLOCKED: missing " + rel(required))

    print("collision ...")
    collision = collision_geometry(physics_path)
    collision_pos = write_bin(out / "collision.positions.f32.bin",
                              f32(collision["positions"]))
    collision_idx = write_bin(out / "collision.indices.u32.bin",
                              u32(collision["indices"]))
    ray_records = build_ray_triangles(
        physics_scan.flatten_static_triangles(
            physics_scan.scan_level(physics_path.read_bytes())))

    print("layout ...")
    layout, _ = layout_document(candidate_path, covered_path, level)
    proof = spawn_proof(ray_records, layout["spawn"])

    print("draws ...")
    draws = draw_geometry(render_path, DRAW_PROBES)
    draw_pos = write_bin(out / "draws.positions.f32.bin", f32(draws["positions"]))
    draw_uv0 = write_bin(out / "draws.uv0.f32.bin", f32(draws["uv0"]))
    draw_idx = write_bin(out / "draws.indices.u32.bin", u32(draws["indices"]))

    body = {
        "schema": SCHEMA,
        "kind": "map-slice-package",
        "level": level,
        "units": {
            "position": "metres",
            "normal": "unit vector",
            "uv0": "raw source UV0 pair (u,v); sampler not applied",
            "index": "uint32 index into the named position array",
            "heading": "radians; engine local +Z is longitudinal",
        },
        "scope": {
            "playableClaim": False,
            "rendererClaim": False,
            "gpuClaim": False,
            "browserFrameProduced": False,
            "e1DriveIntegration": False,
            "physicsProof": "e1 wasm module settle only; no e1-drive file changed",
            "geometry": "first-RenderList direct LOD0 primitives; instance-free",
            "instancesApplied": False,
            "materialsApplied": False,
            "texturesBound": False,
            "normalsExported": False,
            "partialSceneTraversal": True,
            "coordinateSpace": "source-level world (draws), world (collision)",
        },
        "source": {
            "levelPhysics": file_record(physics_path),
            "levelRender": file_record(render_path),
            "candidateLayout": file_record(candidate_path),
            "coveredPath": file_record(covered_path),
            "drawProbes": file_record(DRAW_PROBES),
            "coveredSummary": file_record(COVERED_DIR / f"{level}.json"),
            "mapPipelineMaps": file_record(ROOT / "_work/map-pipeline/maps.json"),
            "mapPipelineInventory": file_record(ROOT / "_work/map-pipeline/inventory.json"),
            "mapPipelineAnalysis": file_record(ROOT / "docs/work/analysis/map-pipeline.md"),
            "grid": file_record(grid_path),
            "carFields": file_record(CAR_FIELDS),
            "e1Module": file_record(E1_MODULE),
            "e1Build": file_record(E1_BUILD),
            "nativeReader": file_record(NATIVE_READER),
        },
        "collision": {
            "file": "Level.levelphysics",
            "sourceSha256": collision["sourceSha256"],
            "fileVersion": collision["fileVersion"],
            "streamVersion": collision["streamVersion"],
            "shapeStreamEnd": collision["shapeStreamEnd"],
            "routeCount": collision["routeCount"],
            "routesParsed": collision["routesParsed"],
            "triangles": collision["triangles"],
            "vertices": collision["vertices"],
            "triangleSoupVertices": collision["triangleSoupVertices"],
            "surfaceTriangles": collision["surfaceTriangles"],
            "steepTriangles": collision["steepTriangles"],
            "otherTriangles": collision["otherTriangles"],
            "degenerateTriangles": collision["degenerateTriangles"],
            "bounds": collision["bounds"],
            "positions": {**collision_pos, "role": "collision vertex table"},
            "indices": {**collision_idx, "role": "triangle list, 3 indices per triangle"},
            "shapes": collision["shapes"],
            "scanner": collision["scanner"],
            "oracle": collision["oracle"],
            "excluded": [
                {"shape": s["importName"], "index": s["index"], "reason": s["reason"]}
                for s in collision["shapes"] if not s["shipped"]
            ],
            "surfaceRule": "geometric normal.y > 0.94; steep = |normal.y| < 0.5",
        },
        "draws": {
            "file": "level.levelrender",
            "sourceSha256": draws["sourceSha256"],
            "probeDocSha256": draws["probeDocSha256"],
            "sectionsProbed": draws["sectionsProbed"],
            "sectionsSupported": draws["sectionsSupported"],
            "sectionsUnsupported": draws["sectionsUnsupported"],
            "vertexCount": draws["vertexCount"],
            "triangleCount": draws["triangleCount"],
            "drawCount": draws["drawCount"],
            "texturedDraws": draws["texturedDraws"],
            "diagnosticDraws": draws["diagnosticDraws"],
            "uv0MissingDraws": draws["uv0MissingDraws"],
            "uv0PlaceholderVertices": draws["uv0PlaceholderVertices"],
            "instanceDescriptionsSkipped": draws["instanceDescriptionsSkipped"],
            "positions": {**draw_pos, "role": "merged section vertex tables"},
            "uv0": {**draw_uv0, "role": "merged section UV0 pairs, 2 floats per vertex"},
            "indices": {**draw_idx, "role": "merged section triangle lists, global vertex indices"},
            "normals": {
                "status": "not-exported",
                "reason": "the committed native direct-draw reader emits positions, "
                          "UV0, indices and draw ranges only; no decoded normal stream",
            },
            "materialStatus": "diagnostic-only",
            "textureStatus": "none-bound",
            "sections": draws["sections"],
            "unsupportedSections": draws["unsupportedSections"],
            "draws": draws["draws"],
            "nativeReader": draws["nativeReader"],
        },
        "textures": {
            "status": "none-bound",
            "boundCount": 0,
            "boundBytes": 0,
            "items": [],
            "directDrawAlbedo": "unresolved",
            "reason": "All 1606 supported direct draws report albedoTexture:null and "
                      "binding 'Level materials not applied in diagnostic preview'. The "
                      "committed level_mesh_inspect path does not evaluate the level "
                      "material rows for direct base primitives, and no committed "
                      "reader path binds a shared/resource albedo image for them.",
            "attempts": [
                {
                    "tool": "_work/build/asset-reader-native/Release/level_inspect.exe "
                            "<levelrender> <geometry.chunk> <node.chunk> <block> <node>",
                    "result": "1606/1606 draws albedoTexture:null; sharedTextures:[]; "
                              "metadata.material='diagnostic-only'",
                },
                {
                    "tool": "level_inspect.exe --instances-all ... 100 234",
                    "result": "status=error: 'First RenderList contains no instances'",
                },
                {
                    "tool": "level_inspect.exe --instances-all ... 54 184",
                    "result": "status=ok but 0 in-scope draws; 261 instances reported "
                              "'other-block'; scope says no instance bound to the "
                              "supplied geometry chunk passed the bounds check",
                },
                {
                    "tool": "scene_inspect.exe level.levelrender --resources",
                    "result": "status=error: 'Expected Model container at byte 20' "
                              "(the Scene resource reader accepts model containers, "
                              "not a levelrender archive)",
                },
            ],
        },
        "layout": layout,
        "spawnProof": proof,
        "physicsProof": {"status": "pending", "file": "physics-settle.json"},
        "integrationGaps": [
            "per-map geometry upload and packet producer: the package has buffers and "
            "ranges but e1-drive still builds River only",
            "materials/textures: 0 bound direct-draw albedo images; the e1 page needs a "
            "level material/texture binding pass before this is more than diagnostic",
            "normals: absent from the committed direct-draw export; shading needs a "
            "reader change or a documented geometric-normal fallback",
            "instances: instancesApplied:false; 3 supported sections carry skipped "
            "instance descriptions, and instance-only geometry can add surfaces",
            "collision extras: the box, four cylinders and the InstancedTriangleMesh "
            "are not shipped in the triangle package",
            "spawn: derived from the measured path, not a retail start-line record",
            "course: point-to-point only; no lap/closed circuit is claimed",
            "props: no Amboy prop colliders or map-specific race rules",
            "UI: no map select, no Amboy entry, no results screen",
            "browser/GPU: no frame, screenshot or console evidence for this map",
        ],
        "limits": [
            "draw coverage is first-RenderList direct LOD0 only; instances not applied",
            "the 1 m audit grid is coarser than the measured 1/6 m path grid",
            "collision triangles are the static triangle meshes; simple shapes and "
            "instance geometry are excluded",
            "physics proof is a 60-tick zero-input settle on one car, not a lap",
            "no renderer, GPU, playable-game or full-game claim",
        ],
    }

    provisional = {**body, "hashes": {"status": "pending"}}
    write_json(out / "slice.json", provisional)

    print("physics settle ...")
    settled = subprocess.run(
        ["node", str(ROOT / "probes/map-slice/tools/physics_settle.mjs"),
         "--package", str(out)],
        cwd=ROOT, text=True, capture_output=True)
    (logs / "physics-settle.log").write_text(
        "$ node probes/map-slice/tools/physics_settle.mjs --package " + args.out + "\n" +
        settled.stdout + settled.stderr, encoding="utf-8")
    if settled.returncode != 0:
        raise SystemExit("FAILED: physics settle failed\n" + settled.stdout + settled.stderr)

    settle_doc = load_json(out / "physics-settle.json")
    body["physicsProof"] = {
        "status": "settled",
        "file": "physics-settle.json",
        "sha256": sha256_file(out / "physics-settle.json"),
        "summary": settle_doc["summary"],
        "determinism": settle_doc["determinism"],
        "moduleWasmSha256": settle_doc["module"]["wasmSha256"],
        "spawn": settle_doc["inputs"]["spawn"],
        "car": settle_doc["create"].get("info", {}).get("car"),
    }

    files = {}
    for path in sorted(out.iterdir()):
        if not path.is_file() or path.name in ("slice.json", "verify.json"):
            continue
        files[path.name] = {"bytes": path.stat().st_size,
                            "sha256": sha256_file(path)}
    body["hashes"] = {
        "algorithm": "sha256",
        "contentSha256": sha256_bytes(canonical(body)),
        "files": files,
    }
    write_json(out / "slice.json", body)

    print(json.dumps({
        "output": rel(out),
        "slice": file_record(out / "slice.json"),
        "collisionTriangles": body["collision"]["triangles"],
        "draws": {"sections": body["draws"]["sectionsSupported"],
                  "triangles": body["draws"]["triangleCount"],
                  "draws": body["draws"]["drawCount"],
                  "textured": body["draws"]["texturedDraws"]},
        "layout": {"lengthM": body["layout"]["lengthM"],
                   "points": body["layout"]["pointCount"],
                   "spawn": body["layout"]["spawn"]},
        "physics": body["physicsProof"]["summary"],
        "packageBytes": sum(v["bytes"] for v in files.values()) +
                        (out / "slice.json").stat().st_size,
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
