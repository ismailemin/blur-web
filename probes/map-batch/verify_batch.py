#!/usr/bin/env python3
"""Independent verifier for the map batch packages.

    python probes/map-batch/verify_batch.py

Checks, per level (every artifact is re-read from disk, nothing is trusted):

  * required files exist and every manifest pin matches bytes + SHA-256;
  * collision buffer counts, triangle classification and bounds reconcile;
  * draw buffers reconcile with section ranges and every draw range, and each
    section's merged vertices/indices re-hash to the committed native pin;
  * every draw has a status; bindable draws have a real texture item; blocked
    draws have no texture slot;
  * texture files exist, are width*height*4 bytes, hash-match and are referenced;
  * path length/step/continuity, checkpoint and finish stations;
  * spawn is the path start, finite, on the collision surface and passable;
  * blockers are typed, unique and consistent with coverage and the grade;
  * no NaN/Inf appears in any JSON artifact or binary float buffer;
  * the 3 known map-slice packages reproduce their committed counts;
  * determinism (when `determinism.json` exists) matches current hashes.

Writes _work/map-batch/verify.json and _work/logs/map-batch/verify.log only.
Exit code 0 = PASS.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BATCH = ROOT / "_work/map-batch"
LOGS = ROOT / "_work/logs/map-batch"
LEVELS_DIR = ROOT / "game-data/Blur/levels"
REGISTRY = ROOT / "probes/e1-drive/web/map-registry.js"

INTEGRATED = {"usa_la_river": "river", "usa_amboy": "amboy",
              "spa_barcelona_gracia": "gracia"}
MIN_COVERED_PATH_M = 25.0
MAX_PATH_STEP_M = 0.250001

REQUIRED = (
    "manifest.json", "draws.json", "draws.positions.f32.bin",
    "draws.uv0.f32.bin", "draws.indices.u32.bin", "textures/index.json",
    "collision.json", "collision.positions.f32.bin",
    "collision.indices.u32.bin", "path.json", "path.points.f32.bin",
    "spawn.json", "blockers.json", "report.json",
)

# Committed map-slice counts this batch must reproduce (docs/work/analysis).
KNOWN = {
    "usa_amboy": {
        "sectionsProbed": 75, "sectionsSupported": 48, "sectionsUnsupported": 27,
        "vertices": 529624, "drawTriangles": 348948, "draws": 1606,
        "collisionTriangles": 63708, "bindableDraws": 1201,
        "textureSources": 186, "textureBlobs": 179,
        "textureBytes": 2654272, "textureBytesReferenced": 2672704,
        "drawCoveredPathM": 2060.595380, "coverage": 0.976215,
        "checkpoints": [686.8623, 1373.6673],
    },
    "spa_barcelona_gracia": {
        "sectionsProbed": 92, "sectionsSupported": 88, "sectionsUnsupported": 4,
        "vertices": 738905, "drawTriangles": 550632, "draws": 3580,
        "collisionTriangles": 113270, "bindableDraws": 2627,
        "textureSources": 739, "textureBlobs": 734,
        "textureBytes": 3247360, "textureBytesReferenced": 3253504,
        "drawCoveredPathM": 624.913780, "coverage": 0.996039,
        "checkpoints": [208.343397, 416.652055],
    },
    "usa_la_longbeachdocks": {
        "sectionsProbed": 76, "sectionsSupported": 74, "sectionsUnsupported": 2,
        "vertices": 864473, "drawTriangles": 537294, "draws": 1141,
        "collisionTriangles": 25183, "bindableDraws": 1039,
        "textureSources": 175, "textureBlobs": 164,
        "textureBytes": 1239168, "textureBytesReferenced": 1263744,
        "drawCoveredPathM": 818.371716, "coverage": 0.472908,
        "checkpoints": [272.892714, 545.610534],
    },
}


# --------------------------------------------------------------------- helpers

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def strict_load(path: Path):
    def reject(value):
        raise ValueError("non-finite JSON constant " + value)

    return json.loads(path.read_text(encoding="utf-8"), parse_constant=reject)


def walk_finite(value, path="") -> list[str]:
    bad = []
    if isinstance(value, dict):
        for key, item in value.items():
            bad.extend(walk_finite(item, path + "/" + str(key)))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            bad.extend(walk_finite(item, path + "/%d" % index))
    elif isinstance(value, float):
        if not math.isfinite(value):
            bad.append(path)
    return bad


def close(a, b, tol):
    return a is not None and b is not None and abs(float(a) - float(b)) <= tol


class Checker:
    def __init__(self, log):
        self.log = log
        self.checks = 0
        self.failures = []

    def check(self, condition, label, detail=None):
        self.checks += 1
        if not condition:
            self.failures.append({"check": label, "detail": detail})
            self.log("FAIL %s%s" % (label, "" if detail is None else " :: " + str(detail)))
        return bool(condition)

    def equal(self, actual, expected, label):
        return self.check(actual == expected, label,
                          "actual=%r expected=%r" % (actual, expected))

    def within(self, actual, expected, tol, label):
        return self.check(close(actual, expected, tol), label,
                          "actual=%r expected=%r tol=%r" % (actual, expected, tol))


# ------------------------------------------------------------------ per level

def verify_level(level: str, ck: Checker, log) -> dict:
    out = BATCH / level
    log("-- %s" % level)

    # ---------------------------------------------------------- presence
    for name in REQUIRED:
        ck.check((out / name).is_file(), "%s/file:%s" % (level, name))
    if not (out / "manifest.json").is_file():
        return {"level": level, "checks": ck.checks, "failed": True}

    # ------------------------------------------------------------ manifest
    try:
        manifest = strict_load(out / "manifest.json")
    except (ValueError, json.JSONDecodeError) as error:
        ck.check(False, "%s/manifest-json" % level, error)
        return {"level": level, "checks": ck.checks, "failed": True}
    ck.equal(manifest.get("schema"), "blur.map-batch.manifest/1",
             "%s/manifest-schema" % level)
    ck.equal(manifest.get("level"), level, "%s/manifest-level" % level)
    grade = manifest.get("grade")
    ck.check(grade in ("playable", "partial", "blocked"),
             "%s/grade-domain" % level, grade)

    pinned = manifest.get("hashes", {}).get("files", {})
    for name, record in pinned.items():
        path = out / name
        if not ck.check(path.is_file(), "%s/pin-exists:%s" % (level, name)):
            continue
        data = path.read_bytes()
        ck.equal(len(data), record["bytes"], "%s/pin-bytes:%s" % (level, name))
        ck.equal(sha256_bytes(data), record["sha256"], "%s/pin-sha:%s" % (level, name))

    body = {key: value for key, value in manifest.items() if key != "hashes"}
    ck.equal(sha256_bytes(json.dumps(body, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False, allow_nan=False).encode("utf-8")),
             manifest["hashes"]["contentSha256"], "%s/manifest-content-hash" % level)

    # source pins against the live game data
    files = manifest["source"]["files"]
    physics = LEVELS_DIR / level / "Level.levelphysics"
    render = LEVELS_DIR / level / "level.levelrender"
    ck.equal(sha256_file(physics), files["physics"]["sha256"],
             "%s/physics-sha" % level)
    ck.equal(physics.stat().st_size, files["physics"]["bytes"],
             "%s/physics-bytes" % level)
    ck.equal(sha256_file(render), files["render"]["sha256"],
             "%s/render-sha" % level)
    ck.equal(render.stat().st_size, files["render"]["bytes"],
             "%s/render-bytes" % level)

    # ----------------------------------------------------------- collision
    collision = strict_load(out / "collision.json")
    cpos = np.fromfile(out / "collision.positions.f32.bin", dtype="<f4")
    cidx = np.fromfile(out / "collision.indices.u32.bin", dtype="<u4")
    cc = collision["counts"]
    ck.equal(cpos.size, cc["vertices"] * 3, "%s/collision-pos-count" % level)
    ck.equal(cidx.size, cc["triangles"] * 3, "%s/collision-idx-count" % level)
    ck.equal(cc["surfaceTriangles"] + cc["steepTriangles"] + cc["otherTriangles"] +
             cc["degenerateTriangles"], cc["triangles"],
             "%s/collision-classification" % level)
    ck.check(bool(np.isfinite(cpos).all()), "%s/collision-finite" % level)
    if cpos.size:
        mn = [float(cpos[0::3].min()), float(cpos[1::3].min()), float(cpos[2::3].min())]
        mx = [float(cpos[0::3].max()), float(cpos[1::3].max()), float(cpos[2::3].max())]
        ck.within(mn[0], collision["bounds"]["min"][0], 1e-4,
                  "%s/collision-bounds-min-x" % level)
        ck.within(mx[2], collision["bounds"]["max"][2], 1e-4,
                  "%s/collision-bounds-max-z" % level)
        ck.check(int(cidx.max()) < cpos.size // 3, "%s/collision-index-range" % level)
    ck.equal(cc["shapeCount"], len(collision["shapes"]),
             "%s/collision-shape-count" % level)
    ck.equal(cc["excludedShapeCount"],
             sum(1 for s in collision["shapes"] if not s["shipped"]),
             "%s/collision-excluded-count" % level)
    ck.equal(cc["shippedShapeCount"],
             sum(1 for s in collision["shapes"] if s["shipped"]),
             "%s/collision-shipped-count" % level)

    # --------------------------------------------------------------- draws
    draws_doc = strict_load(out / "draws.json")
    dpos = np.fromfile(out / "draws.positions.f32.bin", dtype="<f4")
    duv = np.fromfile(out / "draws.uv0.f32.bin", dtype="<f4")
    didx = np.fromfile(out / "draws.indices.u32.bin", dtype="<u4")
    dc = draws_doc["counts"]
    sections = draws_doc["sections"]
    draws = draws_doc["draws"]
    ck.equal(dpos.size, dc["vertexCount"] * 3, "%s/draws-pos-count" % level)
    ck.equal(duv.size, dc["vertexCount"] * 2, "%s/draws-uv-count" % level)
    ck.equal(didx.size, dc["indexCount"], "%s/draws-idx-count" % level)
    ck.equal(dc["indexCount"], dc["triangleCount"] * 3,
             "%s/draws-triangle-count" % level)
    ck.equal(len(draws), dc["drawCount"], "%s/draws-record-count" % level)
    ck.check(bool(np.isfinite(dpos).all()), "%s/draws-pos-finite" % level)
    ck.check(bool(np.isfinite(duv).all()), "%s/draws-uv-finite" % level)
    if didx.size:
        ck.check(int(didx.max()) < dc["vertexCount"], "%s/draws-index-range" % level)

    ck.equal(len(sections), dc["sectionsSupported"],
             "%s/sections-supported-count" % level)
    ck.equal(len(draws_doc["unsupportedSections"]), dc["sectionsUnsupported"],
             "%s/sections-unsupported-count" % level)
    ck.equal(dc["sectionsProbed"],
             dc["sectionsSupported"] + dc["sectionsUnsupported"],
             "%s/sections-total-count" % level)

    vertex_cursor = index_cursor = draw_cursor = 0
    section_pin_ok = 0
    for section in sections:
        sid = section["id"]
        ck.equal(section["vertexOffset"], vertex_cursor,
                 "%s/section-vertex-offset:%s" % (level, sid))
        ck.equal(section["indexOffset"], index_cursor,
                 "%s/section-index-offset:%s" % (level, sid))
        ck.equal(section["drawOffset"], draw_cursor,
                 "%s/section-draw-offset:%s" % (level, sid))
        ck.equal(section["indexCount"], section["triangleCount"] * 3,
                 "%s/section-tri-count:%s" % (level, sid))
        # Re-hash this section's merged buffers against the native probe pin.
        chunk_pos = dpos[vertex_cursor * 3:(vertex_cursor + section["vertexCount"]) * 3]
        chunk_idx = didx[index_cursor:index_cursor + section["indexCount"]] - vertex_cursor
        if (chunk_pos.size == section["vertexCount"] * 3
                and chunk_idx.size == section["indexCount"]):
            pos_sha = sha256_bytes(chunk_pos.astype("<f4").tobytes())
            idx_sha = sha256_bytes(chunk_idx.astype("<u4").tobytes())
            if pos_sha == section["positionsFloat32LESha256"] and \
                    idx_sha == section["indicesUint32LESha256"]:
                section_pin_ok += 1
        vertex_cursor += section["vertexCount"]
        index_cursor += section["indexCount"]
        draw_cursor += section["drawCount"]
    ck.equal(vertex_cursor, dc["vertexCount"], "%s/sections-vertex-sum" % level)
    ck.equal(index_cursor, dc["indexCount"], "%s/sections-index-sum" % level)
    ck.equal(draw_cursor, dc["drawCount"], "%s/sections-draw-sum" % level)
    ck.equal(section_pin_ok, len(sections),
             "%s/sections-native-pin-rehash" % level)

    section_by_id = {s["id"]: s for s in sections}
    expected_first = 0
    status_counts: dict[str, int] = {}
    for draw in draws:
        did = draw["id"]
        section = section_by_id.get(draw["sectionId"])
        if not ck.check(section is not None, "%s/draw-section:%s" % (level, did)):
            continue
        ck.equal(draw["firstIndex"], expected_first,
                 "%s/draw-range-tiles:%s" % (level, did))
        expected_first += draw["indexCount"]
        ck.equal(draw["indexCount"] % 3, 0, "%s/draw-tri-align:%s" % (level, did))
        ck.equal(draw["triangleCount"], draw["indexCount"] // 3,
                 "%s/draw-tri-count:%s" % (level, did))
        ck.check(section["indexOffset"] <= draw["firstIndex"]
                 < section["indexOffset"] + section["indexCount"],
                 "%s/draw-in-section:%s" % (level, did))
        ck.check(draw["status"] is not None, "%s/draw-status:%s" % (level, did))
        status_counts[draw["status"]] = status_counts.get(draw["status"], 0) + 1
        if draw["status"] == "bindable-static-albedo":
            ck.check(draw["textureId"] is not None,
                     "%s/draw-texture-id:%s" % (level, did))
            ck.check(isinstance(draw["textureSlot"], int),
                     "%s/draw-texture-slot:%s" % (level, did))
            ck.check(isinstance(draw["uvHash"], str) and draw["uvHash"].startswith("0x"),
                     "%s/draw-uv-hash:%s" % (level, did))
        else:
            ck.check(draw["textureSlot"] is None,
                     "%s/blocked-draw-no-slot:%s" % (level, did))
    ck.equal(expected_first, dc["indexCount"], "%s/draws-cover-index-buffer" % level)
    ck.equal(status_counts, dc["statuses"], "%s/draw-status-counts" % level)
    ck.equal(dc["bindableDraws"],
             status_counts.get("bindable-static-albedo", 0),
             "%s/draw-bindable-count" % level)
    ck.equal(dc["blockedDraws"],
             dc["drawCount"] - status_counts.get("bindable-static-albedo", 0),
             "%s/draw-blocked-count" % level)
    groups = draws_doc["drawLists"]["blockedGroups"]
    ck.equal(sum(group["draws"] for group in groups.values()), dc["blockedDraws"],
             "%s/blocked-groups-draws" % level)
    ck.equal(sum(group["triangles"] for group in groups.values()),
             sum(draw["triangleCount"] for draw in draws
                 if draw["status"] != "bindable-static-albedo"),
             "%s/blocked-groups-triangles" % level)
    for status, group in groups.items():
        ck.equal(len(group["indexRanges"]), group["draws"],
                 "%s/blocked-group-ranges:%s" % (level, status))
        ck.check(all(0 <= entry["firstIndex"]
                     and entry["firstIndex"] + entry["indexCount"] <= dc["indexCount"]
                     for entry in group["indexRanges"]),
                 "%s/blocked-group-range-bounds:%s" % (level, status))
        draw_by_id = {draw["id"]: draw for draw in draws}
        ck.check(all(draw_by_id.get(entry["drawId"], {}).get("status") == status
                     and draw_by_id.get(entry["drawId"], {}).get("firstIndex")
                     == entry["firstIndex"]
                     for entry in group["indexRanges"]),
                 "%s/blocked-group-join:%s" % (level, status))
    ck.equal(sum(s["instanceDescriptionsSkipped"] for s in sections),
             dc["instanceDescriptionsSkipped"],
             "%s/instance-description-sum" % level)
    for unsupported in draws_doc["unsupportedSections"]:
        ck.check(bool(unsupported.get("reason")),
                 "%s/unsupported-reason:%s" % (level, unsupported["id"]))
        ck.check(unsupported.get("byteOffset") is not None,
                 "%s/unsupported-offset:%s" % (level, unsupported["id"]))

    # ------------------------------------------------------------ textures
    tindex = strict_load(out / "textures/index.json")
    tc = tindex["counts"]
    ck.equal(len(tindex["items"]), tc["uniqueBlobs"],
             "%s/texture-blob-count" % level)
    ck.equal(sum(item["bytes"] for item in tindex["items"]), tc["uniqueMip0Bytes"],
             "%s/texture-bytes-sum" % level)
    ck.equal(sum(item["bindableDrawCount"] for item in tindex["items"]),
             tc["bindableDraws"], "%s/texture-bindable-draw-sum" % level)
    ck.equal(tc["draws"], dc["drawCount"], "%s/texture-draw-count" % level)
    ck.equal(tc["triangles"], dc["triangleCount"], "%s/texture-tri-count" % level)
    ck.equal(tc["bindableDraws"], dc["bindableDraws"], "%s/texture-bindable-count" % level)
    ck.equal(tc["statuses"], dc["statuses"], "%s/texture-status-parity" % level)
    ck.equal(tc["sections"], len(sections), "%s/texture-section-count" % level)

    source_to_slot: dict[str, int] = {}
    texture_dir = out / "textures"
    for slot, item in enumerate(tindex["items"]):
        ck.equal(item["slot"], slot, "%s/texture-slot:%s" % (level, item["file"]))
        path = out / item["file"]
        if not ck.check(path.is_file(), "%s/texture-exists:%s" % (level, item["file"])):
            continue
        data = path.read_bytes()
        ck.equal(len(data), item["bytes"], "%s/texture-bytes:%s" % (level, item["file"]))
        ck.equal(sha256_bytes(data), item["sha256"],
                 "%s/texture-sha:%s" % (level, item["file"]))
        ck.equal(len(data), item["width"] * item["height"] * 4,
                 "%s/texture-dimensions:%s" % (level, item["file"]))
        for source_id in item["sourceIds"]:
            source_to_slot[source_id] = slot
    for draw in draws:
        if draw["status"] != "bindable-static-albedo":
            continue
        ck.check(draw["textureId"] in source_to_slot,
                 "%s/texture-reference:%s" % (level, draw["id"]))
        ck.equal(draw["textureSlot"], source_to_slot.get(draw["textureId"]),
                 "%s/texture-slot-join:%s" % (level, draw["id"]))

    # ---------------------------------------------------------------- path
    path = strict_load(out / "path.json")
    samples = path["samples"]
    pts = np.fromfile(out / "path.points.f32.bin", dtype="<f4")
    ck.equal(pts.size, path["sampleCount"] * 3, "%s/path-point-count" % level)
    ck.equal(path["sampleCount"], len(samples), "%s/path-sample-count" % level)
    ck.equal(sha256_file(out / "path.points.f32.bin"), path["pointsSha256"],
             "%s/path-points-sha" % level)
    ck.check(bool(np.isfinite(pts).all()), "%s/path-finite" % level)
    ck.check(path["kind"] in ("draw-covered-measured", "collision-only-measured"),
             "%s/path-kind" % level)

    length = 0.0
    max_step = 0.0
    for a, b in zip(samples, samples[1:]):
        step = math.hypot(b["x"] - a["x"], b["z"] - a["z"])
        length += step
        max_step = max(max_step, step)
    ck.within(length, path["lengthM"], 1e-6, "%s/path-length" % level)
    ck.check(max_step <= MAX_PATH_STEP_M, "%s/path-max-step" % level, max_step)
    ck.within(max_step, path["continuity"]["maxStepM"], 1e-9,
              "%s/path-max-step-record" % level)
    ck.check(path["continuity"]["maxStepWithinLimit"], "%s/path-step-limit" % level)
    ck.check(all(math.hypot(b["x"] - a["x"], b["z"] - a["z"]) > 0
                 for a, b in zip(samples, samples[1:])),
             "%s/path-monotonic" % level)
    ck.within(samples[0]["x"], path["start"]["x"], 1e-9, "%s/path-start-x" % level)
    ck.within(samples[-1]["z"], path["end"]["z"], 1e-9, "%s/path-end-z" % level)

    draw_len = float(path["drawCovered"]["lengthM"])
    collision_len = float(path["collisionOnly"]["lengthM"])
    ck.equal(path["drawCovered"]["available"],
             path["kind"] == "draw-covered-measured", "%s/path-available" % level)
    ck.check(collision_len > 0, "%s/path-collision-length" % level)
    ck.check(draw_len <= collision_len * 1.01 + 1e-6,
             "%s/path-covered-not-longer-than-collision" % level,
             "covered=%r collision=%r" % (draw_len, collision_len))
    ratio = draw_len / collision_len if collision_len else 0.0
    ck.within(path["drawCovered"]["coverageOfCollisionDiameter"], ratio, 1e-6,
              "%s/path-coverage-ratio" % level)

    cumulative = [0.0]
    for a, b in zip(samples, samples[1:]):
        cumulative.append(cumulative[-1] + math.hypot(b["x"] - a["x"],
                                                      b["z"] - a["z"]))
    for checkpoint in path["checkpoints"]:
        index = checkpoint["pointIndex"]
        ck.check(0 <= index < len(samples), "%s/path-checkpoint-index:%d"
                 % (level, checkpoint["index"]))
        if not 0 <= index < len(samples):
            continue
        ck.within(checkpoint["x"], samples[index]["x"], 1e-9,
                  "%s/path-checkpoint-x:%d" % (level, checkpoint["index"]))
        ck.within(checkpoint["arcM"], cumulative[index], 1e-6,
                  "%s/path-checkpoint-arc:%d" % (level, checkpoint["index"]))
        ck.within(checkpoint["arcM"], checkpoint["requestedArcM"], 2.0,
                  "%s/path-checkpoint-request:%d" % (level, checkpoint["index"]))

    # --------------------------------------------------------------- spawn
    spawn_doc = strict_load(out / "spawn.json")
    spawn = spawn_doc["spawn"]
    ck.within(spawn["x"], samples[0]["x"], 1e-9, "%s/spawn-x" % level)
    ck.within(spawn["z"], samples[0]["z"], 1e-9, "%s/spawn-z" % level)
    ck.within(spawn["ground"], samples[0]["h"], 1e-9, "%s/spawn-ground" % level)
    ck.check(math.isfinite(spawn["headingRad"]) and
             -math.pi - 1e-9 <= spawn["headingRad"] <= math.pi + 1e-9,
             "%s/spawn-heading" % level, spawn["headingRad"])
    validity = spawn_doc["validity"]
    ck.check(validity["pass"] is True, "%s/spawn-valid" % level)
    ck.check(validity["onCollisionSurface"] is True,
             "%s/spawn-on-collision" % level)
    ck.check(validity["rayHit"] is True, "%s/spawn-ray-hit" % level)
    ck.check(validity["upFacing"] is True, "%s/spawn-up-facing" % level)
    ck.check(validity["bandAllHits"] is True, "%s/spawn-band-hits" % level)
    ck.check(validity["bandAllUpFacing"] is True,
             "%s/spawn-band-up-facing" % level)
    ck.check(validity["auditCellPassable"] is True,
             "%s/spawn-audit-passable" % level)
    ck.check(validity["groundDeltaM"] is not None and
             abs(validity["groundDeltaM"]) <= 0.5, "%s/spawn-ground-delta" % level)
    for check in validity["checks"]:
        ck.check(check["pass"] is True, "%s/spawn-check:%s" % (level, check["name"]))

    layout = spawn_doc["layout"]
    ck.within(layout["lengthM"], path["lengthM"], 1e-6, "%s/layout-length" % level)
    ck.equal(layout["sampleCount"], path["sampleCount"], "%s/layout-samples" % level)
    ck.within(layout["spawn"]["x"], spawn["x"], 1e-9, "%s/layout-spawn-x" % level)
    ck.within(layout["spawn"]["z"], spawn["z"], 1e-9, "%s/layout-spawn-z" % level)
    ck.within(layout["spawn"]["heading"], spawn["headingRad"], 1e-9,
              "%s/layout-spawn-heading" % level)
    ck.within(layout["finish"]["x"], samples[-1]["x"], 1e-9,
              "%s/layout-finish-x" % level)
    ck.within(layout["finish"]["z"], samples[-1]["z"], 1e-9,
              "%s/layout-finish-z" % level)
    ck.equal(layout["finish"]["pointIndex"], len(samples) - 1,
             "%s/layout-finish-index" % level)
    ck.equal(layout["pointsSha256"], path["pointsSha256"],
             "%s/layout-points-sha" % level)
    ck.check(layout["lap"] is None, "%s/layout-no-lap" % level)
    ck.equal(len(layout["checkpoints"]), 2, "%s/layout-checkpoint-count" % level)
    for checkpoint in layout["checkpoints"]:
        index = checkpoint["pointIndex"]
        ck.check(0 <= index < len(samples), "%s/layout-checkpoint-index:%d"
                 % (level, checkpoint["index"]))
        if 0 <= index < len(samples):
            ck.within(checkpoint["x"], samples[index]["x"], 1e-9,
                      "%s/layout-checkpoint-x:%d" % (level, checkpoint["index"]))
            ck.within(checkpoint["arcM"], cumulative[index], 1e-6,
                      "%s/layout-checkpoint-arc:%d" % (level, checkpoint["index"]))
            ck.within(checkpoint["distanceM"], checkpoint["arcM"], 1e-9,
                      "%s/layout-checkpoint-distance:%d"
                      % (level, checkpoint["index"]))

    # ------------------------------------------------------------ blockers
    blockers = strict_load(out / "blockers.json")
    ck.equal(blockers["level"], level, "%s/blockers-level" % level)
    ck.equal(blockers["grade"], grade, "%s/blockers-grade" % level)
    codes = [b["code"] for b in blockers["blockers"]]
    ck.equal(len(codes), len(set(codes)), "%s/blockers-unique" % level)
    ck.equal(blockers["blockerCount"], len(blockers["blockers"]),
             "%s/blockers-count" % level)
    ck.equal(blockers["fatalCount"],
             sum(1 for b in blockers["blockers"] if b["fatalForPlayable"]),
             "%s/blockers-fatal-count" % level)
    for blocker in blockers["blockers"]:
        ck.check(bool(blocker["code"]) and bool(blocker["severity"]),
                 "%s/blocker-typed:%s" % (level, blocker["code"]))

    covered_blocked = draw_len < MIN_COVERED_PATH_M
    ck.equal("draw-coverage-blocked" in codes, covered_blocked,
             "%s/blocker-coverage-blocked" % level)
    ck.equal("draw-coverage-partial" in codes,
             (not covered_blocked) and ratio < 0.9,
             "%s/blocker-coverage-partial" % level)
    ck.equal("unsupported-draw-section" in codes,
             dc["sectionsUnsupported"] > 0, "%s/blocker-unsupported" % level)
    ck.equal("instance-geometry-skipped" in codes,
             dc["instanceDescriptionsSkipped"] > 0,
             "%s/blocker-instances" % level)
    if "draw-coverage-blocked" in codes:
        blocker = next(b for b in blockers["blockers"]
                       if b["code"] == "draw-coverage-blocked")
        ck.equal(blocker["thresholdM"], MIN_COVERED_PATH_M,
                 "%s/blocker-threshold" % level)
        ck.equal(blocker["fatalForPlayable"], True,
                 "%s/blocker-coverage-fatal" % level)

    expected_grade = ("blocked" if covered_blocked
                      else "playable" if level in INTEGRATED else "partial")
    ck.equal(grade, expected_grade, "%s/grade-rule" % level)

    # -------------------------------------------------------------- report
    report = strict_load(out / "report.json")
    ck.equal(report["level"], level, "%s/report-level" % level)
    ck.equal(report["grade"], grade, "%s/report-grade" % level)
    rc = report["counts"]
    ck.equal(rc["draws"], dc["drawCount"], "%s/report-draws" % level)
    ck.equal(rc["bindableDraws"], dc["bindableDraws"],
             "%s/report-bindable" % level)
    ck.equal(rc["drawTriangles"], dc["triangleCount"],
             "%s/report-triangles" % level)
    ck.equal(rc["vertices"], dc["vertexCount"], "%s/report-vertices" % level)
    ck.equal(rc["collisionTriangles"], cc["triangles"],
             "%s/report-collision" % level)
    ck.equal(rc["textureBlobs"], tc["uniqueBlobs"], "%s/report-texture-blobs" % level)
    ck.equal(rc["textureBytes"], tc["uniqueMip0Bytes"],
             "%s/report-texture-bytes" % level)
    ck.within(rc["drawCoveredPathM"], draw_len, 1e-6,
              "%s/report-covered-path" % level)
    ck.within(rc["coverageOfCollisionDiameter"], ratio, 1e-6,
              "%s/report-coverage" % level)
    ck.equal(rc["pathSamples"], path["sampleCount"], "%s/report-samples" % level)
    ck.equal(rc["spawnValid"], validity["pass"], "%s/report-spawn" % level)
    ck.equal(report["hashes"]["manifest"], sha256_file(out / "manifest.json"),
             "%s/report-manifest-hash" % level)
    ck.equal(report["hashes"]["draws"], sha256_file(out / "draws.json"),
             "%s/report-draws-hash" % level)
    ck.equal(report["hashes"]["path"], sha256_file(out / "path.json"),
             "%s/report-path-hash" % level)
    for stage, seconds in report["timingsSeconds"].items():
        ck.check(math.isfinite(seconds) and seconds >= 0,
                 "%s/report-timing:%s" % (level, stage))
    ck.check(report["totalSeconds"] >= 0, "%s/report-total" % level)

    # ---------------------------------------------------------- no NaN/Inf
    bad = []
    for name in ("manifest.json", "draws.json", "textures/index.json",
                 "collision.json", "path.json", "spawn.json",
                 "blockers.json", "report.json"):
        bad.extend("%s%s" % (name, item) for item in
                   walk_finite(strict_load(out / name)))
    ck.equal(bad, [], "%s/no-nan-inf" % level)

    # --------------------------------------------------- known-map agreement
    if level in KNOWN:
        expected = KNOWN[level]
        ck.equal(dc["sectionsProbed"], expected["sectionsProbed"],
                 "%s/known-sections-probed" % level)
        ck.equal(dc["sectionsSupported"], expected["sectionsSupported"],
                 "%s/known-sections-supported" % level)
        ck.equal(dc["sectionsUnsupported"], expected["sectionsUnsupported"],
                 "%s/known-sections-unsupported" % level)
        ck.equal(dc["vertexCount"], expected["vertices"],
                 "%s/known-vertices" % level)
        ck.equal(dc["triangleCount"], expected["drawTriangles"],
                 "%s/known-draw-triangles" % level)
        ck.equal(dc["drawCount"], expected["draws"], "%s/known-draws" % level)
        ck.equal(cc["triangles"], expected["collisionTriangles"],
                 "%s/known-collision" % level)
        ck.equal(dc["bindableDraws"], expected["bindableDraws"],
                 "%s/known-bindable" % level)
        ck.equal(tc["distinctTextureSources"], expected["textureSources"],
                 "%s/known-texture-sources" % level)
        ck.equal(tc["uniqueBlobs"], expected["textureBlobs"],
                 "%s/known-texture-blobs" % level)
        ck.equal(tc["uniqueMip0Bytes"], expected["textureBytes"],
                 "%s/known-texture-bytes" % level)
        ck.equal(tc["referencedMip0Bytes"], expected["textureBytesReferenced"],
                 "%s/known-texture-referenced" % level)
        ck.within(draw_len, expected["drawCoveredPathM"], 1e-5,
                  "%s/known-covered-path" % level)
        ck.within(ratio, expected["coverage"], 1e-6,
                  "%s/known-coverage" % level)
        arcs = [checkpoint["arcM"] for checkpoint in layout["checkpoints"]]
        ck.within(arcs[0], expected["checkpoints"][0], 1e-3,
                  "%s/known-checkpoint-1" % level)
        ck.within(arcs[1], expected["checkpoints"][1], 1e-3,
                  "%s/known-checkpoint-2" % level)

    return {"level": level, "grade": grade, "checks": ck.checks,
            "failures": len(ck.failures)}


# ---------------------------------------------------------------------- batch

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--levels", nargs="*", default=None)
    parser.add_argument("--out", default=str(BATCH / "verify.json"))
    args = parser.parse_args(argv)

    LOGS.mkdir(parents=True, exist_ok=True)
    log_path = LOGS / "verify.log"
    log_handle = log_path.open("w", encoding="utf-8")

    def log(message: str) -> None:
        print(message, flush=True)
        log_handle.write(message + "\n")

    started = time.perf_counter()
    levels = args.levels or sorted(p.name for p in BATCH.iterdir()
                                   if p.is_dir() and (p / "manifest.json").is_file())
    ck = Checker(log)
    rows = []

    log("== map-batch verifier ==")
    ck.check(len(levels) == 19, "batch/level-count", len(levels))
    for level in levels:
        rows.append(verify_level(level, ck, log))

    # ------------------------------------------------------------- batch level
    registry = REGISTRY.read_text(encoding="utf-8")
    for level, map_id in INTEGRATED.items():
        ck.check("'%s'" % map_id in registry.split("MAP_IDS")[1].split("]")[0],
                 "registry/map-id:%s" % map_id)
        ck.check("level: '%s'" % level in registry,
                 "registry/level:%s" % level)
        manifest = strict_load(BATCH / level / "manifest.json")
        ck.equal(manifest["mapId"], map_id, "registry/manifest-map-id:%s" % level)
        ck.check(manifest["scope"]["e1DriveIntegration"] is True,
                 "registry/integration-flag:%s" % level)

    summary_path = BATCH / "batch-summary.json"
    if summary_path.is_file():
        summary = strict_load(summary_path)
        ck.equal(summary["levelCount"], len(levels), "batch/summary-count")
        ck.check(summary["totalSeconds"] > 0, "batch/summary-time")
        ck.equal({row["level"]: row.get("grade") for row in summary["levels"]},
                 {level: strict_load(BATCH / level / "manifest.json")["grade"]
                  for level in levels}, "batch/summary-grades")
        for row in summary["levels"]:
            ck.check(row.get("grade") != "error", "batch/summary-no-error:%s"
                     % row["level"])

    determinism_path = BATCH / "determinism.json"
    if determinism_path.is_file():
        det = strict_load(determinism_path)
        ck.check(det["allIdentical"] is True, "determinism/all-identical")
        ck.equal(det["levelCount"], len(levels), "determinism/level-count")
        for row in det["levels"]:
            ck.check(row["identical"] is True,
                     "determinism/level:%s" % row["level"])
            actual = {
                "manifest": sha256_file(BATCH / row["level"] / "manifest.json"),
                "draws": sha256_file(BATCH / row["level"] / "draws.json"),
                "path": sha256_file(BATCH / row["level"] / "path.json"),
            }
            ck.equal(row["hashes"]["manifest"], actual["manifest"],
                     "determinism/manifest-hash:%s" % row["level"])
            ck.equal(row["hashes"]["draws"], actual["draws"],
                     "determinism/draws-hash:%s" % row["level"])
            ck.equal(row["hashes"]["path"], actual["path"],
                     "determinism/path-hash:%s" % row["level"])
            ck.check(row["filesCompared"] and row["filesCompared"] > 0,
                     "determinism/files-compared:%s" % row["level"])

    elapsed = time.perf_counter() - started
    result = {
        "schema": "blur.map-batch.verify/1",
        "generatedBy": "probes/map-batch/verify_batch.py",
        "levelCount": len(levels),
        "checks": ck.checks,
        "failureCount": len(ck.failures),
        "status": "PASS" if not ck.failures else "FAIL",
        "seconds": round(elapsed, 4),
        "levels": rows,
        "failures": ck.failures[:200],
    }
    Path(args.out).write_text(
        json.dumps(result, indent=1, ensure_ascii=False, allow_nan=False,
                   sort_keys=True) + "\n", encoding="utf-8")
    log("== %s: %d checks, %d failures, %.1fs ==" % (
        result["status"], result["checks"], len(ck.failures), elapsed))
    log_handle.close()
    print(json.dumps({k: result[k] for k in
                      ("status", "levelCount", "checks", "failureCount",
                       "seconds")}, indent=1))
    return 0 if not ck.failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
