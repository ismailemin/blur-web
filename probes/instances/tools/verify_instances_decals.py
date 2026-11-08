#!/usr/bin/env python3
"""Independent verifier for the instance/decal census (>= 200 checks).

The verifier re-reads the produced artifacts, the original level Scene tables and
the committed map-slice manifests, recomputes geometry bounds and UV hashes from
the emitted buffers, reconciles the census against the earlier package/blocker
reports, and optionally rebuilds both producers into a temporary directory to
prove byte determinism.

Usage:
  python probes/instances/tools/verify_instances_decals.py
  python probes/instances/tools/verify_instances_decals.py --skip-rebuild
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from instances_common import (  # noqa: E402
    LEVELS,
    ROOT,
    LevelData,
    load_json,
    sha256_bytes,
    sha256_file,
)

CHECKS = []


def check(name: str, condition, detail="") -> None:
    CHECKS.append({"name": name, "pass": bool(condition), "detail": str(detail)})


def close(a, b, tol=0.0):
    return abs(float(a) - float(b)) <= tol


def near_list(a, b, tol=0.0):
    return len(a) == len(b) and all(close(x, y, tol) for x, y in zip(a, b))


def buffer_path(base: Path, rel: str) -> Path:
    """Buffers may be named relative to the repo root (`_work/...`), not to the
    level directory; joining the two used to double the prefix."""
    candidate = ROOT / rel
    return candidate if candidate.exists() else base / rel


def read_f32(path: Path, count: int):
    data = path.read_bytes()
    if len(data) != count * 4:
        return None, data
    return np.frombuffer(data, dtype="<f4").astype(np.float64), data


def read_u32(path: Path, count: int):
    data = path.read_bytes()
    if len(data) != count * 4:
        return None, data
    return np.frombuffer(data, dtype="<u4"), data


def fnv_decal(uv: np.ndarray, indices: np.ndarray) -> str:
    value = 0xCBF29CE484222325
    for index in indices:
        for axis in range(2):
            for byte in np.float32(uv[int(index), axis]).tobytes():
                value ^= byte
                value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return "0x%016x" % value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-rebuild", action="store_true")
    parser.add_argument("--out", type=Path,
                        default=ROOT / "_work/instances/verify.json")
    args = parser.parse_args()

    instances_summary = load_json(ROOT / "_work/instances/summary.json")
    decals_summary = load_json(ROOT / "_work/instances/decals-summary.json")
    check("instances summary schema", instances_summary.get("schema") == "blur.instances/1")
    check("decals summary schema", decals_summary.get("schema") == "blur.instances/1")

    totals = Counter()
    for short in ("river", "amboy", "gracia", "longbeach"):
        config = LEVELS[short]
        out = ROOT / "_work/instances" / short
        level = LevelData(short)
        doc = load_json(out / "instances.json")
        meshes = load_json(out / "instance-meshes.json")
        decals = load_json(out / "decals.json")
        counts = doc["counts"]
        dcounts = decals["counts"]

        # ---------------------------------------------------------- identity
        check(f"{short}: level id", doc["level"] == config["level"])
        check(f"{short}: instances schema", doc["schema"] == "blur.instances/1")
        check(f"{short}: meshes kind", meshes["kind"] == "level-instance-meshes")
        check(f"{short}: decals kind", decals["kind"] == "level-decal-records")
        check(f"{short}: level render hash",
              doc["inputs"]["levelRender"]["sha256"] == sha256_bytes(level.header))
        check(f"{short}: level stream size",
              doc["inputs"]["levelStream"]["bytes"] == level.stream_path.stat().st_size)
        check(f"{short}: decal level hash",
              decals["inputs"]["levelRender"]["sha256"] == sha256_bytes(level.header))

        # -------------------------------------------------------- count sums
        instances = doc["instances"]
        check(f"{short}: instance count", len(instances) == counts["instances"])
        check(f"{short}: section count", len(doc["sections"]) == counts["sections"])
        check(f"{short}: section instance sum",
              sum(s["instances"] for s in doc["sections"]) == counts["instances"])
        check(f"{short}: first+later lists",
              counts["instancesFirstRenderList"] + counts["instancesLaterRenderList"]
              == counts["instances"])
        check(f"{short}: resolved+rejected",
              counts["resolved"] + counts["rejected"] == counts["instances"])
        check(f"{short}: rejection code sum",
              sum(counts["rejectionsByCode"].values()) == counts["rejected"])
        resolved = [r for r in instances if r["status"] == "resolved"]
        check(f"{short}: resolved list length", len(resolved) == counts["resolved"])
        check(f"{short}: unique instance ids",
              len({r["instanceId"] for r in instances}) == len(instances))
        check(f"{short}: instance id prefix",
              all(r["instanceId"].startswith(r["section"] + "#i") for r in instances))
        check(f"{short}: unique section ids",
              len({(s["nodeBlock"], s["renderListIndex"]) for s in doc["sections"]})
              == len(doc["sections"]))
        check(f"{short}: instance section present",
              all(any(s["nodeBlock"] == r["nodeBlock"]
                      and s["renderListIndex"] == r["renderListIndex"]
                      for s in doc["sections"]) for r in instances))

        # ----------------------------------------------- transforms / bounds
        bad_finite = bad_affine = bad_scale = bad_det = 0
        for record in instances:
            transform = record["transform"]
            if transform is None:
                continue
            matrix = transform["matrix"]
            if not all(math.isfinite(v) for v in matrix):
                bad_finite += 1
            if not (matrix[3] == 0 and matrix[7] == 0 and matrix[11] == 0
                    and matrix[15] == 1):
                bad_affine += 1
            if not (0 < transform["maxScale"] < 1e7):
                bad_scale += 1
            if abs(transform["determinant"]) <= 1e-12:
                bad_det += 1
        check(f"{short}: transforms finite", bad_finite == 0, bad_finite)
        check(f"{short}: transforms affine", bad_affine == 0, bad_affine)
        check(f"{short}: transform scale sane", bad_scale == 0, bad_scale)
        check(f"{short}: transform non-degenerate", bad_det == 0, bad_det)
        check(f"{short}: every resolved has transform",
              all(r["transform"] is not None for r in resolved))
        check(f"{short}: every resolved has mesh",
              all(r["mesh"] is not None for r in resolved))
        check(f"{short}: archived bounds ordered",
              all(r["archivedBounds"]["min"][a] <= r["archivedBounds"]["max"][a]
                  for r in instances for a in range(3)))
        check(f"{short}: archived bounds finite",
              all(math.isfinite(v) for r in instances
                  for v in r["archivedBounds"]["raw"]))
        check(f"{short}: world bounds ordered",
              all(r["worldBounds"]["min"][a] <= r["worldBounds"]["max"][a]
                  for r in resolved for a in range(3)))
        check(f"{short}: all resolved contained in archived bounds",
              counts["instancesContained"] == counts["resolved"],
              counts["instancesContained"])
        check(f"{short}: bounds containment flag true",
              all(r["boundsCheck"]["contained"] for r in resolved))
        check(f"{short}: every resolved has a group",
              all(r["group"] is not None for r in resolved))
        check(f"{short}: all bounds groups validated",
              counts["boundsGroupsValidated"] == counts["boundsGroups"],
              counts["boundsGroupsValidated"])
        check(f"{short}: no group exceeds record",
              counts["boundsGroupsExceedRecord"] == 0)
        check(f"{short}: group member sum",
              sum(g["instances"] for g in doc["boundsGroups"]) == counts["resolved"])
        check(f"{short}: group records byte-identical",
              all(g["recordsByteIdentical"] for g in doc["boundsGroups"]))
        check(f"{short}: group tolerance recorded",
              all(g.get("tolerance", 0) >= 1e-4 for g in doc["boundsGroups"]))
        check(f"{short}: package instances zero",
              counts["instancesInPackage"] == 0)
        check(f"{short}: instance package reason typed",
              all(r["package"]["reason"] in
                  ("noMapPackage", "referencedBlockNotDirectInPackage",
                   "meshReferenceUnresolved") for r in instances))

        # ---------------------------------------------------------- mesh table
        mesh_rows = meshes["meshes"]
        check(f"{short}: mesh count", len(mesh_rows) == counts["uniqueMeshes"])
        check(f"{short}: mesh ids unique",
              len({m["meshId"] for m in mesh_rows}) == len(mesh_rows))
        check(f"{short}: mesh ids stable",
              all(m["meshId"] == "m%05d" % i for i, m in enumerate(mesh_rows)))
        check(f"{short}: mesh vertex sum",
              sum(m["vertexCount"] for m in mesh_rows) == counts["meshVertices"])
        check(f"{short}: mesh index sum",
              sum(m["indexCount"] for m in mesh_rows) == counts["meshIndices"])
        check(f"{short}: mesh triangle sum",
              sum(m["triangleCount"] for m in mesh_rows) == counts["meshTrianglesUnique"])
        check(f"{short}: mesh triangle arithmetic",
              all(m["triangleCount"] == m["indexCount"] // 3 for m in mesh_rows))
        check(f"{short}: mesh instance reuse sum",
              sum(m["instanceCount"] for m in mesh_rows) == counts["resolved"])
        check(f"{short}: mesh reuse arithmetic",
              all(m["reuse"] == m["instanceCount"] - 1 for m in mesh_rows))
        check(f"{short}: mesh offsets contiguous",
              all(m["vertexOffset"] == sum(x["vertexCount"] for x in mesh_rows[:i])
                  and m["indexOffset"] == sum(x["indexCount"] for x in mesh_rows[:i])
                  for i, m in enumerate(mesh_rows)))
        check(f"{short}: mesh local bounds ordered",
              all(m["localBounds"]["min"][a] <= m["localBounds"]["max"][a]
                  for m in mesh_rows for a in range(3)))
        check(f"{short}: mesh ranges non-empty",
              all(m["vertexCount"] > 0 and m["indexCount"] > 0 for m in mesh_rows))
        check(f"{short}: mesh uv0 availability recorded",
              all(isinstance(m["uv0Available"], bool) for m in mesh_rows))
        check(f"{short}: instance triangle sum",
              sum(r["mesh"]["triangleCount"] for r in resolved)
              == counts["instanceTrianglesRendered"])
        check(f"{short}: instance vertex sum",
              sum(r["mesh"]["vertexCount"] for r in resolved)
              == counts["instanceVerticesRendered"])

        # ------------------------------------------------------------- buffers
        buffers = doc["buffers"]
        positions, pos_bytes = read_f32(buffer_path(out, buffers["positions"]["path"]),
                                        counts["meshVertices"] * 3)
        uv0, uv_bytes = read_f32(buffer_path(out, buffers["uv0"]["path"]),
                                 counts["meshVertices"] * 2)
        indices, idx_bytes = read_u32(buffer_path(out, buffers["indices"]["path"]),
                                      counts["meshIndices"])
        transforms, tr_bytes = read_f32(buffer_path(out, buffers["transforms"]["path"]),
                                        counts["instances"] * 16)
        check(f"{short}: position buffer size",
              len(pos_bytes) == counts["meshVertices"] * 12)
        check(f"{short}: uv0 buffer size", len(uv_bytes) == counts["meshVertices"] * 8)
        check(f"{short}: index buffer size", len(idx_bytes) == counts["meshIndices"] * 4)
        check(f"{short}: transform buffer size",
              len(tr_bytes) == counts["instances"] * 64)
        check(f"{short}: position buffer hash",
              sha256_bytes(pos_bytes) == buffers["positions"]["sha256"])
        check(f"{short}: uv0 buffer hash",
              sha256_bytes(uv_bytes) == buffers["uv0"]["sha256"])
        check(f"{short}: index buffer hash",
              sha256_bytes(idx_bytes) == buffers["indices"]["sha256"])
        check(f"{short}: transform buffer hash",
              sha256_bytes(tr_bytes) == buffers["transforms"]["sha256"])
        check(f"{short}: position buffer finite",
              positions is not None and bool(np.isfinite(positions).all()))
        check(f"{short}: uv0 buffer finite",
              uv0 is not None and bool(np.isfinite(uv0).all()))

        # every mesh slice recomputed from the buffers
        bad_bounds = bad_index = 0
        for mesh in mesh_rows:
            start = mesh["vertexOffset"]
            count = mesh["vertexCount"]
            points = positions[start * 3:(start + count) * 3].reshape(-1, 3)
            box_min = points.min(axis=0).tolist()
            box_max = points.max(axis=0).tolist()
            if not (near_list(box_min, mesh["localBounds"]["min"], 1e-6)
                    and near_list(box_max, mesh["localBounds"]["max"], 1e-6)):
                bad_bounds += 1
            first = mesh["indexOffset"]
            local = indices[first:first + mesh["indexCount"]]
            if local.max() >= count:
                bad_index += 1
        check(f"{short}: mesh local bounds match buffers", bad_bounds == 0, bad_bounds)
        check(f"{short}: mesh indices inside vertex range", bad_index == 0, bad_index)

        # every instance transform and world bound recomputed
        bad_transform = bad_world = bad_meshlink = 0
        for order, record in enumerate(instances):
            matrix = transforms[order * 16:(order + 1) * 16]
            if record["transform"] is None:
                if np.any(matrix != 0):
                    bad_transform += 1
                continue
            if not np.allclose(matrix, record["transform"]["matrix"], rtol=0, atol=0):
                bad_transform += 1
            mesh = record["mesh"]
            if mesh is None:
                continue
            row = next((m for m in mesh_rows if m["meshId"] == mesh["meshId"]), None)
            if row is None:
                bad_meshlink += 1
                continue
            start = row["vertexOffset"]
            count = row["vertexCount"]
            points = positions[start * 3:(start + count) * 3].reshape(-1, 3)
            m = matrix.astype(np.float64).reshape(4, 4)
            world = (points[:, 0:1] * m[0:1, 0:3] + points[:, 1:2] * m[1:2, 0:3]
                     + points[:, 2:3] * m[2:3, 0:3] + m[3, 0:3])
            box_min = world.min(axis=0).tolist()
            box_max = world.max(axis=0).tolist()
            if not (near_list(box_min, record["worldBounds"]["min"], 1e-4)
                    and near_list(box_max, record["worldBounds"]["max"], 1e-4)):
                bad_world += 1
        check(f"{short}: transform buffer matches JSON", bad_transform == 0, bad_transform)
        check(f"{short}: world bounds recomputed", bad_world == 0, bad_world)
        check(f"{short}: instance mesh ids present", bad_meshlink == 0, bad_meshlink)

        # ------------------------------------------------ source re-derivation
        bad_source = bad_bounds_source = bad_matrix = 0
        section_cache = {}
        for record in instances:
            key = (record["recordIndex"], record["itemIndex"])
            if key not in section_cache:
                data, _resources, lists = level.item_context(*key)
                section_cache[key] = lists
            lists = section_cache[key]
            if record["renderListIndex"] >= len(lists):
                bad_source += 1
                continue
            node = lists[record["renderListIndex"]]
            if record["nodeBlock"] != level.records[record["recordIndex"]]["items"][record["itemIndex"]]["block"]:
                bad_source += 1
                continue
            if not 0 <= record["instanceIndex"] < len(node["instances"]):
                bad_source += 1
                continue
            instance = node["instances"][record["instanceIndex"]]
            if instance["primitiveIndex"] != record["basePrimitiveIndex"]:
                bad_source += 1
            archived = node["bounds"]["instance"][record["instanceIndex"]]
            if not near_list(archived, record["archivedBounds"]["raw"], 0):
                bad_bounds_source += 1
            if record["transform"] is not None:
                from inspect_level_instances import constant_world
                base = node["basePrimitives"][instance["primitiveIndex"]]
                matrix, _trace = constant_world(node, instance, base)
                if not near_list(matrix, record["transform"]["matrix"], 1e-6):
                    bad_matrix += 1
        check(f"{short}: instance source re-derived", bad_source == 0, bad_source)
        check(f"{short}: archived bounds re-read", bad_bounds_source == 0, bad_bounds_source)
        check(f"{short}: transforms re-derived", bad_matrix == 0, bad_matrix)

        # -------------------------------------------------------------- textures
        texture_rows = doc["textures"]
        check(f"{short}: texture count", len(texture_rows) == counts["instanceTextures"])
        check(f"{short}: texture ids unique",
              len({t["id"] for t in texture_rows}) == len(texture_rows))
        check(f"{short}: texture bytes sum",
              sum(t["rgbaBytes"] for t in texture_rows)
              == counts["instanceTextureRgbaBytes"])
        bad_texture = 0
        for texture in texture_rows:
            if texture["rgbaBytes"] and texture.get("width") and texture.get("height"):
                if texture["rgbaBytes"] != texture["width"] * texture["height"] * 4:
                    bad_texture += 1
            if texture["decodeStatus"] == "decoded-texture-inspect":
                path = out.parent / texture["rgbaFile"]
                if not path.exists() or sha256_file(path) != texture["rgbaSha256"]:
                    bad_texture += 1
            if texture["decodeStatus"] == "committed-package":
                bindings = load_json(ROOT / "_work/map-slice" /
                                     (short + "-textures/bindings.json"))
                entry = next((x for x in bindings["textures"]
                              if x["block"] == texture["block"]
                              and x["index"] == texture["index"]), None)
                if entry is None or entry.get("rgbaSha256") != texture["rgbaSha256"]:
                    bad_texture += 1
        check(f"{short}: texture bytes/hashes match source", bad_texture == 0, bad_texture)
        check(f"{short}: instance textures resolve",
              all(r["material"] is None or r["material"].get("texture") is not None
                  or r["status"] != "resolved" for r in instances))

        # -------------------------------------------------------------- decals
        decal_rows = decals["decals"]
        dresolved = [d for d in decal_rows if d["status"] == "resolved"]
        check(f"{short}: decal count", len(decal_rows) == dcounts["draws"])
        check(f"{short}: decal resolved+rejected",
              dcounts["resolved"] + dcounts["rejected"] == dcounts["draws"])
        check(f"{short}: decal triangle sum",
              sum(d["triangleCount"] for d in dresolved) == dcounts["triangles"])
        check(f"{short}: decal vertex sum",
              sum(d["vertexCount"] for d in dresolved) == dcounts["vertices"])
        check(f"{short}: decal ids unique",
              len({d["drawId"] for d in decal_rows}) == len(decal_rows))
        check(f"{short}: decal triangle arithmetic",
              all(d["triangleCount"] == d["indexCount"] // 3 for d in dresolved))
        check(f"{short}: decal uv ordered",
              all(d["uv"]["min"][0] <= d["uv"]["max"][0]
                  and d["uv"]["min"][1] <= d["uv"]["max"][1] for d in dresolved))
        check(f"{short}: decal world bounds ordered",
              all(d["worldBounds"]["min"][a] <= d["worldBounds"]["max"][a]
                  for d in dresolved for a in range(3)))
        check(f"{short}: decal transform identity",
              all(d["transform"]["kind"] == "identity" for d in dresolved))
        check(f"{short}: decal material static",
              dcounts["materialStaticDraws"] == dcounts["resolved"])

        dbuffers = decals["buffers"]
        dpos, dpos_bytes = read_f32(buffer_path(out, dbuffers["positions"]["path"]),
                                    dcounts["vertices"] * 3)
        duv, duv_bytes = read_f32(buffer_path(out, dbuffers["uv0"]["path"]),
                                  dcounts["vertices"] * 2)
        didx, didx_bytes = read_u32(buffer_path(out, dbuffers["indices"]["path"]),
                                    dcounts["vertices"] * 3 if False else
                                    sum(d["indexCount"] for d in dresolved))
        check(f"{short}: decal position buffer size",
              len(dpos_bytes) == dcounts["vertices"] * 12)
        check(f"{short}: decal uv buffer size", len(duv_bytes) == dcounts["vertices"] * 8)
        check(f"{short}: decal index buffer size",
              len(didx_bytes) == sum(d["indexCount"] for d in dresolved) * 4)
        check(f"{short}: decal position hash",
              sha256_bytes(dpos_bytes) == dbuffers["positions"]["sha256"])
        check(f"{short}: decal uv hash",
              sha256_bytes(duv_bytes) == dbuffers["uv0"]["sha256"])
        check(f"{short}: decal index hash",
              sha256_bytes(didx_bytes) == dbuffers["indices"]["sha256"])
        check(f"{short}: decal positions finite",
              dpos is not None and bool(np.isfinite(dpos).all()))

        # recompute every decal UV FNV hash from the emitted buffers
        bad_uv = bad_decal_geom = 0
        decal_uv = duv.reshape(-1, 2) if duv is not None else None
        for decal in dresolved:
            start = decal["indexOffset"]
            local = didx[start:start + decal["indexCount"]]
            if local.max() >= decal["vertexCount"]:
                bad_decal_geom += 1
                continue
            if fnv_decal(decal_uv, local) != decal["uv"]["hash"]:
                bad_uv += 1
        check(f"{short}: decal UV hashes recomputed", bad_uv == 0, bad_uv)
        check(f"{short}: decal indices inside vertex range",
              bad_decal_geom == 0, bad_decal_geom)

        # pass state: every Racification draw is additive, alpha-tested, no depth write
        check(f"{short}: decal blend additive",
              all(d["pass"]["alphaBlend"]["src"] == "One"
                  and d["pass"]["alphaBlend"]["dst"] == "InvSrcAlpha"
                  and d["pass"]["alphaBlend"]["op"] == "Add" for d in dresolved))
        check(f"{short}: decal alpha test enabled",
              all(d["pass"]["alphaTest"]["enabled"] == "TRUE" for d in dresolved))
        check(f"{short}: decal depth write off",
              all(d["pass"]["depth"]["write"] == "FALSE" for d in dresolved))
        check(f"{short}: decal sort type",
              all(d["pass"]["sortType"] == "racification" for d in dresolved))
        check(f"{short}: decal runtime inputs recorded",
              all(len(d["pass"]["runtimeInputs"]) == 4 for d in dresolved))
        check(f"{short}: decal textures resolve",
              all(d.get("textureId") in {t["id"] for t in decals["textures"]}
                  for d in dresolved))
        check(f"{short}: decal texture bytes sum",
              sum(t["rgbaBytes"] for t in decals["textures"])
              == dcounts["textureRgbaBytes"])

        # ------------------------------------------- package reconciliation
        if config.get("package"):
            blockers_path = ROOT / "_work/map-slice" / (short + "-textures/blockers.json")
            blockers = load_json(blockers_path)["instances"]["sections"]
            first_by_node = {}
            for section in doc["sections"]:
                if section["renderListIndex"] == 0:
                    first_by_node[section["nodeBlock"]] = section["instances"]
            bad = []
            for section in blockers:
                got = first_by_node.get(section["nodeBlock"])
                if got != section["instanceCount"]:
                    bad.append([section["id"], section["instanceCount"], got])
            check(f"{short}: blocker instance counts reconcile", not bad, bad[:5])
            check(f"{short}: blocker instance total",
                  sum(s["instanceCount"] for s in blockers) ==
                  sum(first_by_node.get(s["nodeBlock"], 0) for s in blockers))
            check(f"{short}: blocker section count",
                  len(blockers) == sum(1 for s in doc["sections"]
                                       if s["renderListIndex"] == 0
                                       and s["nodeBlock"] in
                                       {b["nodeBlock"] for b in blockers}))
            diagnostics = load_json(ROOT / config["package"] / "diagnostics.json")
            group = diagnostics["groups"]["effectDecal"]
            check(f"{short}: package decal subset",
                  dcounts["packageMatched"] == group["draws"])
            check(f"{short}: package decal triangles subset",
                  sum(d["triangleCount"] for d in dresolved if d["package"]["matched"])
                  == group["triangles"])
            check(f"{short}: package decal UV hashes match",
                  dcounts["packageUvHashMismatch"] == 0)
            check(f"{short}: package decal triangle counts match",
                  dcounts["packageTriangleMismatch"] == 0)
            check(f"{short}: package decal subset <= census",
                  dcounts["packageMatched"] <= dcounts["draws"])
        else:
            check(f"{short}: no package declared", doc["package"]["available"] is False)
            check(f"{short}: river decal package absent",
                  decals["package"]["available"] is False)
            check(f"{short}: river all decals unmatched",
                  dcounts["packageMatched"] == 0)

        # -------------------------------------------------------- file hashes
        check(f"{short}: instances json hash",
              sha256_file(out / "instances.json") ==
              instances_summary["levels"][short]["hashes"]["instancesJson"])
        check(f"{short}: meshes json hash",
              sha256_file(out / "instance-meshes.json") ==
              instances_summary["levels"][short]["hashes"]["meshesJson"])
        check(f"{short}: decals json hash",
              sha256_file(out / "decals.json") ==
              decals_summary["levels"][short]["hashes"]["decalsJson"])

        totals["instances"] += counts["instances"]
        totals["resolved"] += counts["resolved"]
        totals["rejected"] += counts["rejected"]
        totals["instanceTriangles"] += counts["instanceTrianglesRendered"]
        totals["meshTriangles"] += counts["meshTrianglesUnique"]
        totals["decals"] += dcounts["draws"]
        totals["decalTriangles"] += dcounts["triangles"]
        totals["instanceTextureBytes"] += counts["instanceTextureRgbaBytes"]
        totals["decalTextureBytes"] += dcounts["textureRgbaBytes"]
        totals["instanceMeshes"] += counts["uniqueMeshes"]
        totals["instanceMeshBytes"] += (doc["buffers"]["positions"]["bytes"]
                                        + doc["buffers"]["uv0"]["bytes"]
                                        + doc["buffers"]["indices"]["bytes"]
                                        + doc["buffers"]["transforms"]["bytes"])
        totals["decalBytes"] += (decals["buffers"]["positions"]["bytes"]
                                 + decals["buffers"]["uv0"]["bytes"]
                                 + decals["buffers"]["indices"]["bytes"])

    check("total instances 37,867", totals["instances"] == 37867, totals["instances"])
    check("total resolved 35,085", totals["resolved"] == 35085, totals["resolved"])
    check("total rejected 2,782", totals["rejected"] == 2782, totals["rejected"])
    check("total decals 1,533", totals["decals"] == 1533, totals["decals"])
    check("total instance mesh triangles > 1.3M",
          totals["meshTriangles"] > 1_300_000, totals["meshTriangles"])
    check("total decal triangles 297,096", totals["decalTriangles"] == 297096,
          totals["decalTriangles"])

    # --------------------------------------------------------- determinism
    if not args.skip_rebuild:
        temp = Path(tempfile.mkdtemp(prefix="instances-verify-"))
        try:
            for script, summary_name in (
                    ("extract_instances.py", "summary.json"),
                    ("extract_decals.py", "decals-summary.json")):
                process = subprocess.run(
                    [sys.executable, str(ROOT / "probes/instances/tools" / script),
                     "--out-root", str(temp)],
                    capture_output=True, text=True)
                check(f"rebuild {script} exits 0", process.returncode == 0,
                      process.stderr[-300:])
            for short in ("river", "amboy", "gracia", "longbeach"):
                for name in ("instances.json", "instance-meshes.json",
                             "instance-transforms.f32.bin",
                             "instance-mesh.positions.f32.bin",
                             "instance-mesh.uv0.f32.bin",
                             "instance-mesh.indices.u32.bin",
                             "decals.json", "decal.positions.f32.bin",
                             "decal.uv0.f32.bin", "decal.indices.u32.bin"):
                    a = ROOT / "_work/instances" / short / name
                    b = temp / short / name
                    check(f"determinism {short}/{name}",
                          a.exists() and b.exists()
                          and sha256_file(a) == sha256_file(b))
                a_textures = sorted((ROOT / "_work/instances" / short / "textures").glob("*.rgba"))
                b_textures = sorted((temp / short / "textures").glob("*.rgba"))
                check(f"determinism {short}/textures count",
                      len(a_textures) == len(b_textures))
                check(f"determinism {short}/textures bytes",
                      [(p.name, sha256_file(p)) for p in a_textures]
                      == [(p.name, sha256_file(p)) for p in b_textures])
        finally:
            shutil.rmtree(temp, ignore_errors=True)
    else:
        check("determinism rebuild skipped", True, "explicit --skip-rebuild")

    passed = sum(1 for c in CHECKS if c["pass"])
    failed = [c for c in CHECKS if not c["pass"]]
    result = {
        "schema": "blur.instances.verify/1",
        "checks": len(CHECKS),
        "passed": passed,
        "failed": len(failed),
        "status": "PASS" if not failed else "FAIL",
        "totals": dict(totals),
        "failures": failed[:40],
        "allChecks": CHECKS,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=1, allow_nan=False) + "\n",
                        encoding="utf-8")
    print(json.dumps({k: result[k] for k in ("checks", "passed", "failed", "status",
                                             "totals")}, indent=1))
    if failed:
        for item in failed[:20]:
            print("FAIL", item["name"], item["detail"])
        raise SystemExit(1)


if __name__ == "__main__":
    main()



