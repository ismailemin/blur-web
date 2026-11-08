#!/usr/bin/env python3
"""Read-only per-level node/instance inventory and extraction-policy audit.

For every level it counts, from the committed levelrender/levelstream:
  * first-RenderList node chunks parsed (first LOD0 item, no prerequisites)
  * instance descriptions / base primitives / primitives in those lists
  * declared geometry block references that the committed extractor skips
    because the block is a non-first item of a chunk or the chunk declares
    prerequisites
  * whether the reference has a unique LOD0 stream item at all

It does not extract geometry and does not modify game data.  Outputs
`_work/map-pipeline/node-inventory.json`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
from inspect_car_level_assets import Reader, render_layout, resource_prefix, stream_prefix  # noqa: E402
from inspect_level_chunk import read_render_lists  # noqa: E402

LIMIT = 16 * 1024 * 1024
LEVELS = (
    "usa_la_river", "usa_amboy", "usa_ny_dumbo", "showroom", "spa_barcelona_gracia",
    "usa_la_longbeachdocks", "usa_la_observatory", "spa_barcelona_oval",
    "uk_london_hackney", "uk_brighton", "jpn_mharuna", "usa_sanfran_russianhill",
    "usa_sanfran_sausalito", "usa_la_downtown", "usa_la_downtown_multiplayer",
    "usa_amboy_multiplayer", "jpn_tokyo_shutoko", "usa_la_multiplayer_highrise",
    "spa_barcelona_bowl_multiplayer",
)


def scan(name: str) -> dict:
    folder = ROOT / "game-data/Blur/levels" / name
    level_file, stream_file = folder / "level.levelrender", folder / "level.levelstream"
    data = level_file.read_bytes()
    scene = render_layout(data, "level")["scene"]
    records = scene["stream"]["chunks"]
    stream_size = stream_file.stat().st_size
    by_block = defaultdict(list)
    for ci, record in enumerate(records):
        for ii, item in enumerate(record["items"]):
            if item["lod"] == 0:
                by_block[item["block"]].append({"chunk": ci, "item": ii,
                                                "first": ii == 0,
                                                "prerequisites": list(record["prerequisites"])})

    def read_record(record, prefix=False):
        offset, count = record["offset"], record["storedBytes"]
        if offset < 0 or count < 40 or count > LIMIT or offset + count > stream_size:
            raise ValueError("stream range outside bounds")
        with stream_file.open("rb") as file:
            file.seek(offset)
            return file.read(min(count, 64) if prefix else count)

    stats = Counter()
    instances = Counter()
    skipped_refs = []
    direct_refs = 0
    nodes = 0
    errors = []
    for ci, record in enumerate(records):
        if not record["items"] or record["items"][0]["lod"] != 0:
            stats["notFirstLOD0"] += 1
            continue
        if record["prerequisites"]:
            stats["chunkPrerequisite"] += 1
            continue
        try:
            prefix = read_record(record, True)
            info = stream_prefix(prefix, record)
            if info.get("firstVertexBufferCount", 0):
                continue
            r = Reader(prefix, 48)
            if r.vec() != 0 or r.vec() == 0:
                stats["neitherGeometryNorNode"] += 1
                continue
            raw = read_record(record)
            resources = resource_prefix(raw, {"resourcePayloadOffset": 24, "scenePayloadOffset": 0},
                                        streamed=True)
            render_lists = read_render_lists(raw, resources)
            if not render_lists:
                stats["noRenderList"] += 1
                continue
            nodes += 1
            first = render_lists[0]
            instances["descriptions"] += len(first["instances"])
            instances["basePrimitives"] += len(first["basePrimitives"])
            instances["primitives"] += len(first["primitives"])
            if first["instances"]:
                instances["nodesWithInstances"] += 1
            for source in first["sources"]["vertexBuffer"]:
                block = source["block"]
                if block < 0:
                    continue
                locations = by_block.get(block, [])
                if not locations:
                    skipped_refs.append({"nodeChunk": ci, "block": block,
                                         "reason": "no LOD0 stream item"})
                    continue
                if len(locations) != 1:
                    skipped_refs.append({"nodeChunk": ci, "block": block,
                                         "reason": "%d LOD0 stream items" % len(locations)})
                    continue
                location = locations[0]
                if location["first"] and not location["prerequisites"]:
                    direct_refs += 1
                else:
                    skipped_refs.append({"nodeChunk": ci, "block": block,
                                         "chunk": location["chunk"], "item": location["item"],
                                         "firstItem": location["first"],
                                         "prerequisites": location["prerequisites"]})
        except (ValueError, IndexError, StopIteration, struct.error) as exc:
            errors.append({"chunk": ci, "error": str(exc)[:160]})

    reasons = Counter()
    for ref in skipped_refs:
        if ref.get("firstItem") is False and not ref.get("prerequisites"):
            reasons["non-first-item"] += 1
        elif ref.get("prerequisites"):
            reasons["chunk-prerequisite"] += 1
        else:
            reasons["no-unique-lod0-item"] += 1
    return {
        "level": name,
        "streamChunks": len(records),
        "nodeChunksParsed": nodes,
        "instances": dict(instances),
        "directBlockRefs": direct_refs,
        "skippedBlockRefs": len(skipped_refs),
        "skippedByReason": dict(reasons),
        "skippedRefs": skipped_refs,
        "chunkStats": dict(stats),
        "errors": errors[:20],
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path,
                    default=ROOT / "_work/map-pipeline/node-inventory.json")
    args = ap.parse_args(argv)
    rows = [scan(name) for name in LEVELS]
    doc = {
        "schema": "blur.map-pipeline.node-inventory/1",
        "scope": "first RenderList node chunks only; no geometry extraction; read-only",
        "levels": rows,
        "totals": {
            "levels": len(rows),
            "instances": sum(r["instances"].get("descriptions", 0) for r in rows),
            "skippedBlockRefs": sum(r["skippedBlockRefs"] for r in rows),
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({r["level"]: {"nodes": r["nodeChunksParsed"],
                                   "instances": r["instances"].get("descriptions", 0),
                                   "skippedRefs": r["skippedBlockRefs"],
                                   "byReason": r["skippedByReason"]} for r in rows}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
