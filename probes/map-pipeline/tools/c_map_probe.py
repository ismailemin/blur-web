#!/usr/bin/env python3
"""Read-only prototype for the two C maps (draw-coverage blockers).

The committed `probe_draws.py` only associates a node's declared geometry
block with a stream chunk when that block is the *first* item of a chunk, and
the committed native reader refuses chunks that declare prerequisites.  This
tool keeps the same decoder rules and asks two narrower questions:

1. Does the same levelrender/levelstream data contain drawable geometry for the
   node chunks that the current extractor skipped?
2. If that geometry is added to the coverage test, how much of the measured
   collision path becomes draw-covered?

It reuses the committed Python readers (`render_layout`, `read_render_lists`,
`geometry`) and the committed `level_inspect` output only for cross-validation.
No file under `tools/`, `game-data/`, `probes/asset-reader`, `probes/e1-drive`
or `probes/map-slice` is modified.  No renderer/GPU/playable claim is made.

Outputs (default `_work/map-pipeline/<level>-probe/`):
  probe.json              per-section extraction + validation + coverage
  draws.positions.f32.bin merged positions (additive prototype)
  draws.indices.u32.bin   merged indices (additive prototype)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))
from inspect_car_level_assets import Reader, render_layout, resource_prefix  # noqa: E402
from inspect_level_chunk import geometry, read_render_lists  # noqa: E402
import coverage as cov  # noqa: E402
import inventory_levels as inv  # noqa: E402

WORK = ROOT / "_work/map-pipeline"
LIMIT = 16 * 1024 * 1024
TOLERANCE = 0.5


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_floats(text: str):
    return json.loads(text, parse_int=lambda value: -0.0 if value == "-0" else int(value))


def parse_texture(data: bytes, cursor: int) -> int:
    """Skip one resource texture record (mirrors scene_reader.cpp:390)."""
    r = Reader(data, cursor)
    r.ar(2); r.ar()
    if r.unpack("I") != 2:
        raise ValueError("unexpected texture archive platform")
    r.string()
    sampler = r.ar(1)
    for _ in range(10 if sampler else 9):
        r.unpack("I")
    r.unpack("I")
    present = r.unpack("I")
    if not present:
        return r.p
    descriptor_bytes = r.count(256)
    r.take(descriptor_bytes)
    if present > 1:
        r.unpack("i"); r.unpack("i")
    elif sampler:
        r.ar(); size, alignment, compression = r.unpack("III"); swap = r.unpack("B")
        if not alignment or alignment > 4096 or (alignment & (alignment - 1)) or compression or swap:
            raise ValueError("unsupported texture LOD buffer")
        r.take((-r.p) % alignment)
        r.take(size)
    else:
        size = r.count(LIMIT)
        r.take(size)
    return r.p


def parse_item(data: bytes, cursor: int) -> dict:
    """Parse one stream item: VB list, IB list, nodes, textures (read-only)."""
    r = Reader(data, cursor)
    r.ar(); r.ar()
    platform = r.unpack("I"); reserved = r.unpack("I")
    if platform != 2 or reserved != 0:
        raise ValueError("unexpected stream item header")
    vbs = []
    for _ in range(r.vec(256)):
        if r.unpack("B") != 2:
            raise ValueError("null vertex buffer pointer")
        version = r.ar(1); r.ar()
        stride = r.count(4096)
        if not stride:
            raise ValueError("zero vertex stride")
        elements = []
        for _ in range(r.vec(32)):
            r.ar()
            elements.append(dict(zip(("type", "method", "usage", "usageIndex"), r.unpack("4i"))))
        offsets = [r.unpack("H") for _ in range(r.vec(32))]
        if len(offsets) != len(elements):
            raise ValueError("vertex element offset count mismatch")
        for element, offset in zip(elements, offsets):
            element["offset"] = offset
        count = r.count(1000000)
        size = stride * count
        if version:
            r.ar(); stored, alignment, compression = r.unpack("III"); swap = r.unpack("B")
            if stored != size or not alignment or alignment > 4096 or (alignment & (alignment - 1)) or compression or swap:
                raise ValueError("unsupported VB blob layout")
            r.take((-r.p) % alignment)
        start = r.p
        r.take(size)
        vbs.append({"stride": stride, "vertexCount": count, "elements": elements,
                    "dataOffset": start, "dataBytes": size})
    ibs = []
    for _ in range(r.vec(256)):
        if r.unpack("B") != 2:
            raise ValueError("null index buffer pointer")
        version = r.ar(1); count, kind = r.unpack("II")
        if kind not in (0, 1) or count > 6000000:
            raise ValueError("unsupported index type/count")
        width = 2 if kind == 0 else 4
        size = count * width
        if version:
            r.ar(); stored, alignment, compression = r.unpack("III"); swap = r.unpack("B")
            if stored != size or not alignment or alignment > 4096 or (alignment & (alignment - 1)) or compression or swap:
                raise ValueError("unsupported IB blob layout")
            r.take((-r.p) % alignment)
        start = r.p
        r.take(size)
        ibs.append({"count": count, "width": width, "dataOffset": start, "dataBytes": size})
    node_count = r.vec(100000)
    if node_count:
        raise ValueError("geometry item carries %d node payload(s)" % node_count)
    texture_count = r.count(16)
    cursor = r.p
    for _ in range(texture_count):
        cursor = parse_texture(data, cursor)
    return {"platform": platform, "vbs": vbs, "ibs": ibs,
            "textureCount": texture_count, "end": cursor}


def read_chunk(stream_path: Path, record: dict) -> bytes:
    offset, size = record["offset"], record["storedBytes"]
    if offset < 0 or size < 40 or size > LIMIT:
        raise ValueError("stream chunk outside bounded range")
    with stream_path.open("rb") as file:
        file.seek(offset)
        data = file.read(size)
    if len(data) != size:
        raise ValueError("short stream read")
    return data


def canonical(report: dict):
    positions = b"".join(struct.pack("<f", value) for value in report["positions"])
    indices = b"".join(struct.pack("<I", value) for value in report["indices"])
    return digest(positions), digest(indices)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", required=True)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args(argv)
    level = args.level
    out = args.out or (WORK / (level + "-probe"))
    out.mkdir(parents=True, exist_ok=True)

    folder = ROOT / "game-data/Blur/levels" / level
    level_file = folder / "level.levelrender"
    stream_file = folder / "level.levelstream"
    level_data = level_file.read_bytes()
    scene = render_layout(level_data, "level")["scene"]
    records = scene["stream"]["chunks"]

    # block -> unique LOD0 stream item
    by_block = defaultdict(list)
    for ci, record in enumerate(records):
        for ii, item in enumerate(record["items"]):
            if item["lod"] == 0:
                by_block[item["block"]].append({"chunk": ci, "item": ii})
    ambiguous = {b: rows for b, rows in by_block.items() if len(rows) > 1}

    # every first-RenderList node chunk
    nodes = []
    node_errors = []
    for ci, record in enumerate(records):
        if not record["items"] or record["items"][0]["lod"] != 0:
            continue
        if record["prerequisites"]:
            continue
        try:
            raw = read_chunk(stream_file, record)
            resources = resource_prefix(raw, {"resourcePayloadOffset": 24, "scenePayloadOffset": 0},
                                        streamed=True)
            render_lists = read_render_lists(raw, resources)
            if not render_lists:
                continue
            nodes.append({"chunk": ci, "block": record["items"][0]["block"], "raw": raw,
                          "render": render_lists[0]})
        except (ValueError, IndexError, StopIteration, struct.error) as exc:
            node_errors.append({"chunk": ci, "error": str(exc)[:200]})

    rows = []
    merged_positions = []
    merged_indices = []
    merged_draws = []
    seen_geometry = set()
    totals = Counter()
    for node in nodes:
        render = node["render"]
        blocks = sorted({source["block"] for source in render["sources"]["vertexBuffer"] if source["block"] >= 0})
        for block in blocks:
            entry = {"nodeChunk": node["chunk"], "nodeBlock": node["block"], "block": block,
                     "primitives": len(render["primitives"]),
                     "instances": len(render["instances"]),
                     "basePrimitives": len(render["basePrimitives"])}
            locations = by_block.get(block, [])
            if len(locations) != 1:
                entry.update(status="unsupported",
                             reason="%d LOD0 stream items for block" % len(locations))
                rows.append(entry)
                continue
            location = locations[0]
            entry.update(chunk=location["chunk"], item=location["item"],
                         chunkPrerequisites=records[location["chunk"]]["prerequisites"])
            try:
                chunk_data = read_chunk(stream_file, records[location["chunk"]])
                cursor = 24
                target = None
                item_count = len(records[location["chunk"]]["items"])
                for index in range(item_count):
                    item = parse_item(chunk_data, cursor)
                    if index == location["item"]:
                        target = item
                        break
                    cursor = item["end"]
                reachable = target is not None
                entry.update(itemIndexReached=reachable, itemsBeforeTarget=location["item"],
                             chunkItemCount=item_count,
                             targetEnd=target["end"] if target else None,
                             chunkStoredBytes=records[location["chunk"]]["storedBytes"])
                if not reachable:
                    raise ValueError("target item not reached")
                resources = {"vertexBuffers": target["vbs"], "indexBuffers": target["ibs"],
                             "nodeCount": 0, "firstNodeOffset": target["end"]}
                reference = geometry(chunk_data, resources, scene, render, block)
                pos_hash, idx_hash = canonical(reference)
                entry.update(status="ok", vertices=reference["vertexCount"],
                             triangles=reference["triangleCount"], draws=len(reference["draws"]),
                             bounds=reference["bounds"],
                             positionsSha256=pos_hash, indicesSha256=idx_hash,
                             chunkBytes=len(chunk_data))
                totals["sections"] += 1
                totals["vertices"] += reference["vertexCount"]
                totals["triangles"] += reference["triangleCount"]
                totals["draws"] += len(reference["draws"])
                key = (location["chunk"], location["item"])
                native_path = WORK / "probes" / ("%s-g%d-n%d" % (level, block, node["block"])) / "native.json"
                committed = native_path.is_file()
                if key not in seen_geometry:
                    seen_geometry.add(key)
                    base = len(merged_positions) // 3
                    idx_start = len(merged_indices)
                    merged_positions.extend(reference["positions"])
                    for draw in reference["draws"]:
                        merged_draws.append({"nodeChunk": node["chunk"], "block": block,
                                             "firstIndex": idx_start + draw["firstIndex"],
                                             "indexCount": draw["indexCount"],
                                             "committedSection": committed})
                    merged_indices.extend(index + base for index in reference["indices"])
                    totals["uniqueSections"] += 1
                # native cross-validation when the committed extractor staged it
                if committed:
                    native = json_floats(native_path.read_text())
                    npos, nidx = canonical(native)
                    entry["nativeValidation"] = {
                        "file": str(native_path.relative_to(ROOT)).replace("\\", "/"),
                        "positionsMatch": npos == pos_hash,
                        "indicesMatch": nidx == idx_hash,
                        "vertexCountMatch": native["positions"].__len__() // 3 == reference["vertexCount"],
                        "triangleCountMatch": native["indices"].__len__() // 3 == reference["triangleCount"],
                    }
                    totals["nativeValidated"] += 1
                    if npos != pos_hash or nidx != idx_hash:
                        entry["status"] = "hash-mismatch"
            except (ValueError, IndexError, StopIteration, struct.error) as exc:
                entry.update(status="unsupported", reason=str(exc)[:200])
            rows.append(entry)

    ok_rows = [row for row in rows if row["status"] == "ok"]
    unique_geometry = {}
    for row in ok_rows:
        unique_geometry[(row["chunk"], row["item"])] = row

    # coverage over the committed measured collision path, same 0.5 m rule
    grid = np.load(WORK / "grids" / (level + ".npz"))
    H, xs, zs = grid["height"], grid["xs"], grid["zs"]
    passable = grid["passable"]
    path_doc = json.loads((WORK / "paths" / (level + ".json")).read_text())
    tris = []
    # rebuild from merged buffers using the rebased draw ranges
    pos = np.asarray(merged_positions, dtype=np.float64).reshape(-1, 3)
    idx = np.asarray(merged_indices, dtype=np.int64)
    for draw in merged_draws:
        first = int(draw["firstIndex"])
        count = int(draw["indexCount"])
        for at in range(first, first + count, 3):
            tris.append((pos[idx[at]], pos[idx[at + 1]], pos[idx[at + 2]]))
    tris = np.asarray(tris, dtype=np.float64)
    samples = cov.resample(path_doc["samples"])

    def measure(triangle_set, keys_out=None):
        buckets, bcell = cov.bucket_triangles(triangle_set)
        station_total = covered_total = 0
        gaps = []
        current_gap = None
        for si, (px, pz) in enumerate(samples):
            if si == 0 and len(samples) > 1:
                hx, hz = samples[1][0] - px, samples[1][1] - pz
            elif si == len(samples) - 1 and len(samples) > 1:
                hx, hz = px - samples[si - 1][0], pz - samples[si - 1][1]
            elif len(samples) > 1:
                hx, hz = samples[si + 1][0] - samples[si - 1][0], samples[si + 1][1] - samples[si - 1][1]
            else:
                hx, hz = 1.0, 0.0
            hl = math.hypot(hx, hz) or 1.0
            nx, nz = -hz / hl, hx / hl
            i = int(round((px - xs[0]) / (xs[1] - xs[0])))
            j = int(round((pz - zs[0]) / (zs[1] - zs[0])))
            if not (0 <= j < H.shape[0] and 0 <= i < H.shape[1]):
                continue
            ch = float(H[j, i])
            if not math.isfinite(ch):
                continue
            for lateral in cov.LATERAL:
                qx, qz = px + nx * lateral, pz + nz * lateral
                vh, delta, tri = cov.visual_height(qx, qz, triangle_set, buckets, bcell, ch)
                station_total += 1
                if delta is not None and delta <= TOLERANCE:
                    covered_total += 1
                elif lateral == 0.0:
                    if current_gap is None:
                        current_gap = {"start": [round(qx, 3), round(qz, 3)], "samples": 0}
                    current_gap["samples"] += 1
                    current_gap["end"] = [round(qx, 3), round(qz, 3)]
            if current_gap is not None and current_gap["samples"] and si < len(samples) - 1:
                qx, qz = samples[si + 1]
                vh, delta, tri = cov.visual_height(qx, qz, triangle_set, buckets, bcell, ch)
                if delta is not None and delta <= TOLERANCE:
                    current_gap["metres"] = round(current_gap["samples"] * cov.SAMPLE_STEP, 3)
                    gaps.append(current_gap)
                    current_gap = None
        if current_gap is not None:
            current_gap["metres"] = round(current_gap["samples"] * cov.SAMPLE_STEP, 3)
            gaps.append(current_gap)
        return {"samples": len(samples), "stationTests": station_total,
                "coveredStations": covered_total,
                "fraction": round(covered_total / station_total, 6) if station_total else 0.0,
                "gapRuns": len(gaps), "gapMetres": round(sum(g["metres"] for g in gaps), 3),
                "gaps": gaps[:40]}

    coverage = measure(tris)
    tris_new = []
    for draw in merged_draws:
        if draw["committedSection"]:
            continue
        first = int(draw["firstIndex"])
        count = int(draw["indexCount"])
        for at in range(first, first + count, 3):
            tris_new.append((pos[idx[at]], pos[idx[at + 1]], pos[idx[at + 2]]))
    tris_new = np.asarray(tris_new, dtype=np.float64)
    coverage_new = measure(tris_new) if len(tris_new) else {
        "samples": len(samples), "stationTests": 0, "coveredStations": 0,
        "fraction": 0.0, "gapRuns": 0, "gapMetres": 0.0, "gaps": []}
    # Secondary, stricter view: only up-facing triangles (the collision surface rule)
    cross = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    length = np.linalg.norm(cross, axis=1)
    up = np.abs(cross[:, 1]) / np.maximum(length, 1e-12) >= 0.94
    coverage_up = measure(tris[up])
    buckets, bcell = cov.bucket_triangles(tris)

    # draw-covered collision component on the 1 m grid
    covered_mask = np.zeros(H.shape, dtype=bool)
    js, is_ = np.nonzero(passable)
    for jj, ii in zip(js.tolist(), is_.tolist()):
        ch = float(H[jj, ii])
        if not math.isfinite(ch):
            continue
        vh, delta, tri = cov.visual_height(float(xs[ii]), float(zs[jj]), tris, buckets, bcell, ch)
        if delta is not None and delta <= TOLERANCE:
            covered_mask[jj, ii] = True
    combined = passable & covered_mask
    labels, sizes, bboxes = inv.component_label(combined)
    order = sorted(range(len(sizes)), key=lambda k: sizes[k], reverse=True)
    component_path = None
    if order and sizes[order[0]] > 0:
        cid = order[0] + 1
        seeds = np.flatnonzero((labels == cid).ravel())
        seed0 = int(seeds[0])
        _, _, far_a = inv.bfs_from(labels, cid, seed0, H.shape[1], H.shape[0])
        seed_flat = (int(far_a // (H.shape[1] + 2) - 1) * H.shape[1] +
                     int(far_a % (H.shape[1] + 2) - 1))
        _, parent, far_b = inv.bfs_from(labels, cid, seed_flat, H.shape[1], H.shape[0], want_parent=True)
        cells = inv.reconstruct(parent, far_b, seed_flat, H.shape[1], H.shape[0])
        pts = [(float(xs[i2]), float(zs[j2])) for j2, i2 in cells]
        length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
        component_path = {"lengthM": round(length, 3), "samples": len(pts),
                          "start": [round(pts[0][0], 3), round(pts[0][1], 3)] if pts else None,
                          "end": [round(pts[-1][0], 3), round(pts[-1][1], 3)] if pts else None}

    # package prototype buffers
    (out / "draws.positions.f32.bin").write_bytes(
        struct.pack("<%df" % len(merged_positions), *merged_positions))
    (out / "draws.indices.u32.bin").write_bytes(
        struct.pack("<%dI" % len(merged_indices), *merged_indices))

    doc = {
        "schema": "blur.map-pipeline.c-map-probe/1",
        "level": level,
        "scope": ("read-only extraction of every first-RenderList direct LOD0 primitive "
                  "reachable through the Scene ChunkInfo, including non-first chunk items and "
                  "chunks with declared prerequisites; instancesApplied:false; no materials, "
                  "textures, shaders or GPU state"),
        "sources": {
            "levelrender": {"bytes": len(level_data), "sha256": digest(level_data),
                            "path": str(level_file.relative_to(ROOT)).replace("\\", "/")},
            "levelstream": {"bytes": stream_file.stat().st_size,
                            "sha256": digest(stream_file.read_bytes()) if stream_file.stat().st_size < 512 * 1024 * 1024 else "deferred",
                            "path": str(stream_file.relative_to(ROOT)).replace("\\", "/")},
        },
        "chunkIndex": {
            "streamChunks": len(records),
            "lod0Blocks": len(by_block),
            "ambiguousBlocks": sorted(ambiguous),
            "nodeChunksParsed": len(nodes),
            "nodeErrors": node_errors,
        },
        "sections": rows,
        "totals": {
            "sections": len(unique_geometry),
            "pairRows": len(ok_rows),
            "vertices": len(merged_positions) // 3,
            "triangles": len(merged_indices) // 3,
            "draws": len(merged_draws),
            "nativeValidated": totals["nativeValidated"],
        },
        "coverage": {
            "path": "committed measured collision path (paths/<level>.json)",
            "pathSha256": digest((WORK / "paths" / (level + ".json")).read_bytes()),
            "rule": "covered = collision passable AND a declared draw triangle within 0.5 m",
            "allTriangles": coverage,
            "upFacingTriangles": coverage_up,
            "newSectionsOnly": coverage_new,
            "coveredPassableCells": int(combined.sum()),
            "passableCells": int(passable.sum()),
            "coverageOfPassable": round(float(combined.sum()) / max(1, int(passable.sum())), 6),
            "drawCoveredComponentPath": component_path,
            "topComponents": [{"cells": int(sizes[k]), "bbox": list(bboxes[k])} for k in order[:10]],
        },
        "limits": [
            "first RenderList direct primitives LOD0 only; instance descriptions not applied",
            "no materials, textures, shaders, samplers, culling or GPU state",
            "no renderer, GPU, browser, vehicle-physics or playable claim",
            "1 m collision audit grid and 0.5 m vertical coverage tolerance",
        ],
    }
    (out / "probe.json").write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "level": level,
        "sections": doc["totals"]["sections"],
        "triangles": doc["totals"]["triangles"],
        "coverageFraction": coverage["fraction"],
        "upFacingCoverageFraction": coverage_up["fraction"],
        "newOnlyCoverageFraction": coverage_new["fraction"],
        "componentPathM": component_path["lengthM"] if component_path else 0.0,
        "nativeValidated": doc["totals"]["nativeValidated"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
