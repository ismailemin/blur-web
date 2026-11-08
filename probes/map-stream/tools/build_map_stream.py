"""Build spatial-sector map chunks from the committed map packages.

Usage:
    python probes/map-stream/tools/build_map_stream.py --map amboy
    python probes/map-stream/tools/build_map_stream.py --all
    python probes/map-stream/tools/build_map_stream.py --map river --out <dir>

The producer reads the committed package read-only and writes
``<out>/<map>/``.  It never re-derives level data: positions, UV0, indices,
texture blobs and the measured path are byte copies of the committed payload.
The draw table is re-derived (a compact projection of the committed draw and
diagnostic records) and every field is checked against the source.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import map_stream_common as common

DRAW_KEYS = (
    "ordinal",
    "drawId",
    "kind",
    "meshId",
    "firstIndex",
    "indexCount",
    "firstVertex",
    "vertexCount",
    "vertexRangeSource",
    "triangleCount",
    "textureId",
    "textureSlot",
    "bounds",
    "source",
)

TEXTURE_KEYS = (
    "slot",
    "id",
    "sourceIds",
    "file",
    "bytes",
    "sha256",
    "width",
    "height",
    "format",
    "formatName",
    "uploadFormat",
    "documentGroup",
)


def _project(record: dict, keys) -> dict:
    return {key: record[key] for key in keys if key in record}


def _lap_record(spec: dict, map_id: str, source: dict) -> dict:
    lap = spec["lap"]
    record = {
        "kind": "blur.map-stream.lap",
        "version": 1,
        "map": map_id,
        "sectorSplit": False,
        "reason": "gate triggers, arc progress and respawn are evaluated against the whole measured path from any position; a sector-local gate table would break arc monotonicity and the declared 6 m band",
    }
    if not lap.get("path"):
        record["gates"] = None
        record["source"] = None
        record["reasonDetail"] = lap.get("reason")
        return record
    data = common.read_bytes(lap["path"])
    record["source"] = {"path": lap["path"], "kind": lap.get("kind"), **common.pin_of(data)}
    payload = json.loads(data.decode("utf-8"))
    if payload.get("kind") == "e1-drive.sprint":
        course = payload.get("course") or {}
        record.update(
            {
                "mode": course.get("rule"),
                "gates": payload.get("gates"),
                "countdown": payload.get("countdown"),
                "rules": payload.get("rules"),
                "course": {
                    key: course[key]
                    for key in (
                        "name",
                        "spawn",
                        "spawnGroundY",
                        "start",
                        "finish",
                        "measuredEnd",
                        "lengthMetres",
                        "finishArc",
                        "sampleStepMetres",
                        "sampleCount",
                        "span",
                        "band",
                    )
                    if key in course
                },
                "pathPoints": (
                    {"file": "meta/layout.points.f32.bin", **common.pin_of(source["points_bytes"])}
                    if source.get("points_bytes") is not None
                    else None
                ),
                "contentHash": payload.get("hash"),
            }
        )
    else:
        record.update(
            {
                "mode": "point-to-point",
                "gates": None,
                "countdown": None,
                "rules": None,
                "course": {
                    key: payload[key]
                    for key in (
                        "name",
                        "start",
                        "finish",
                        "lengthMetres",
                        "sampleStepMetres",
                        "sampleCount",
                        "coveredSamples",
                        "coverageFraction",
                        "gapTotalMetres",
                        "width",
                        "sections",
                    )
                    if key in payload
                },
                "contentHash": payload.get("hash"),
            }
        )
    return record


def _bucket_geometry(source: dict, draws: list, mesh_order: list) -> dict:
    slices = []
    payload = bytearray()
    for mesh_id in mesh_order:
        for kind in common.STREAM_KINDS:
            stream = source["streams"].get((mesh_id, kind))
            if stream is None:
                continue
            ranges = [
                common.stream_slice_range(draw, kind)
                for draw in draws
                if draw["meshId"] == mesh_id
            ]
            for start, end in common.merge_ranges(ranges):
                chunk = stream["data"][start:end]
                slices.append(
                    {
                        "stream": kind,
                        "meshId": mesh_id,
                        "srcOffset": start,
                        "bytes": len(chunk),
                        "payloadOffset": len(payload),
                        "sha256": common.sha256_tag(chunk),
                    }
                )
                payload.extend(chunk)
    return {"slices": slices, "bytes": bytes(payload)}


def _texture_page(textures: list) -> tuple:
    payload = bytearray()
    table = []
    for texture in sorted(textures, key=lambda item: item["slot"]):
        table.append(
            {
                "slot": texture["slot"],
                "id": texture["id"],
                "sourceIds": texture.get("sourceIds") or [texture["id"]],
                "offset": len(payload),
                "bytes": texture["bytes"],
                "sha256": texture["sha256"],
                "width": texture["width"],
                "height": texture["height"],
                "format": texture.get("format"),
                "formatName": texture.get("formatName"),
                "uploadFormat": texture.get("uploadFormat", "rgba8unorm"),
                "documentGroup": texture.get("documentGroup"),
            }
        )
        payload.extend(texture["data"])
    return bytes(payload), table


def _percentile(values: list, fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(fraction * (len(ordered) - 1)))))
    return ordered[index]


def _coverage(streams: dict, buckets: dict, mesh_order: list) -> dict:
    """Exact per-stream byte coverage across all buckets (duplication measure)."""
    result = {}
    for mesh_id in mesh_order:
        for kind in common.STREAM_KINDS:
            stream = streams.get((mesh_id, kind))
            if stream is None:
                continue
            size = stream["bytes"]
            counts = bytearray(size)
            for draw_list in buckets.values():
                ranges = [
                    common.stream_slice_range(draw, kind)
                    for draw in draw_list
                    if draw["meshId"] == mesh_id
                ]
                for start, end in common.merge_ranges(ranges):
                    counts[start:end] = b"\x01" * (end - start)
            covered = counts.count(1)
            result[f"{mesh_id}:{kind}"] = {
                "streamBytes": size,
                "coveredBytes": covered,
                "unreferencedBytes": size - covered,
            }
    return result


def build_map(map_id: str, out_root: str) -> dict:
    spec = dict(common.MAP_SOURCES[map_id])
    spec["id"] = map_id
    source = common.load_source(map_id)
    draws = source["draws"]
    textures = source["textures"]
    mesh_order = sorted({mesh_id for mesh_id, _kind in source["streams"]})
    texture_by_slot = {texture["slot"]: texture for texture in textures}

    origin, buckets = common.assign_draws(draws)
    sector_keys = sorted(key for key in buckets if key != "global")
    global_draws = buckets.get("global", [])
    spawn = spec["spawn"]
    spawn_sx = int((spawn["x"] - origin[0]) // common.SECTOR_SIZE)
    spawn_sz = int((spawn["z"] - origin[1]) // common.SECTOR_SIZE)

    # --- texture ownership --------------------------------------------------
    owners = {}
    for draw in draws:
        slot = draw.get("textureSlot")
        if slot is None or slot not in texture_by_slot:
            continue
        owners.setdefault(slot, set()).add(common.draw_bucket(draw, origin))

    shared_slots = sorted(slot for slot, keys in owners.items() if len(keys) > 1 or "global" in keys)
    unused_slots = sorted(slot for slot in texture_by_slot if slot not in owners)
    global_texture_slots = sorted(set(shared_slots) | set(unused_slots))
    exclusive_slots = {key: [] for key in sector_keys}
    for slot, keys in owners.items():
        if slot in global_texture_slots:
            continue
        (key,) = tuple(keys)
        exclusive_slots[key].append(slot)
    for key in exclusive_slots:
        exclusive_slots[key].sort()

    # --- output -------------------------------------------------------------
    root = os.path.join(out_root, map_id)
    if os.path.isdir(root):
        import shutil

        shutil.rmtree(root)
    files = {}

    def emit(rel_path: str, data: bytes) -> dict:
        common.write_bytes(os.path.join(root, rel_path), data)
        pin = common.pin_of(data)
        files[rel_path] = pin
        return {"path": rel_path, **pin}

    def bucket_files(key, draw_list, geometry_payload, texture_payload, texture_table) -> dict:
        if key == "global":
            bucket = {
                "type": "global",
                "id": "global",
                "sizeMetres": common.SECTOR_SIZE,
                "origin": {"x": origin[0], "z": origin[1]},
            }
            geometry_path = "global/geometry.bin"
            texture_path = "shared/textures.bin"
            json_path = "global/global.json"
        else:
            sx, sz = key
            bucket = {
                "type": "sector",
                "id": common.sector_id(sx, sz),
                "sx": sx,
                "sz": sz,
                "sizeMetres": common.SECTOR_SIZE,
                "bounds": common.sector_bounds(sx, sz, origin),
            }
            base = "sectors/" + bucket["id"]
            geometry_path = base + "/geometry.bin"
            texture_path = base + "/textures.bin"
            json_path = base + "/sector.json"
        geometry_pin = emit(geometry_path, geometry_payload["bytes"])
        texture_pin = emit(texture_path, texture_payload)
        slots = sorted(
            {draw["textureSlot"] for draw in draw_list if draw.get("textureSlot") is not None}
        )
        texture_block = {**texture_pin}
        if key == "global":
            texture_block["table"] = "shared/textures.json"
            texture_block["blobs"] = None
        else:
            texture_block["blobs"] = texture_table
        record = {
            "kind": "blur.map-stream.sector" if key != "global" else "blur.map-stream.global",
            "version": 1,
            "schema": common.SCHEMA,
            "map": map_id,
            "bucket": bucket,
            "draws": {
                "count": len(draw_list),
                "bindable": sum(1 for draw in draw_list if draw["kind"] == "bindable"),
                "blocked": sum(1 for draw in draw_list if draw["kind"] == "blocked"),
                "triangles": sum(draw["triangleCount"] for draw in draw_list),
                "ordinals": [draw["ordinal"] for draw in draw_list],
                "records": [_project(draw, DRAW_KEYS) for draw in draw_list],
            },
            "textureSlots": slots,
            "geometry": {
                "file": os.path.basename(geometry_path),
                "path": geometry_path,
                **geometry_pin,
                "slices": geometry_payload["slices"],
            },
            "textures": {
                "file": os.path.basename(texture_path),
                "path": texture_path,
                **texture_block,
            },
            "bytes": geometry_pin["bytes"] + texture_pin["bytes"],
        }
        record["json"] = emit(json_path, common.dumps_pretty(record))
        record["bytesWithJson"] = record["bytes"] + record["json"]["bytes"]
        return record

    sector_records = [
        bucket_files(
            key,
            buckets[key],
            _bucket_geometry(source, buckets[key], mesh_order),
            *_texture_page([texture_by_slot[slot] for slot in exclusive_slots[key]]),
        )
        for key in sector_keys
    ]
    global_record = bucket_files(
        "global",
        global_draws,
        _bucket_geometry(source, global_draws, mesh_order),
        *_texture_page([texture_by_slot[slot] for slot in global_texture_slots]),
    )

    # --- meta ---------------------------------------------------------------
    meta_streams = {
        "kind": "blur.map-stream.streams",
        "version": 1,
        "schema": common.SCHEMA,
        "map": map_id,
        "level": source["level"],
        "renderLabel": source["renderLabel"],
        "source": source["source"],
        "meshes": [
            {
                "meshId": mesh_id,
                "streams": {
                    kind: {
                        key: source["streams"][(mesh_id, kind)][key]
                        for key in ("kind", "dtype", "components", "stride", "count", "bytes", "sha256")
                    }
                    for kind in common.STREAM_KINDS
                    if (mesh_id, kind) in source["streams"]
                },
            }
            for mesh_id in mesh_order
        ],
        "layout": source["layout"],
    }
    if "meshStreamMeta" in source:
        meta_streams["meshStreamMeta"] = source["meshStreamMeta"]
    draws_pin = emit("meta/streams.json", common.dumps_pretty(meta_streams))

    lap_record = _lap_record(spec, map_id, source)
    lap_pin = emit("meta/lap.json", common.dumps_pretty(lap_record))
    points_pin = (
        emit("meta/layout.points.f32.bin", source["points_bytes"])
        if source.get("points_bytes") is not None
        else None
    )

    shared_textures = [texture_by_slot[slot] for slot in global_texture_slots]
    shared_page_bytes, shared_table = _texture_page(shared_textures)
    shared_index = {
        "kind": "blur.map-stream.texture-page",
        "version": 1,
        "schema": common.SCHEMA,
        "map": map_id,
        "page": "shared/textures.bin",
        "role": "textures referenced by more than one sector or by a global draw; resident with the map",
        "blobs": shared_table,
        "bytes": len(shared_page_bytes),
        "sha256": common.sha256_tag(shared_page_bytes),
    }
    shared_index_pin = emit("shared/textures.json", common.dumps_pretty(shared_index))

    # --- index --------------------------------------------------------------
    index = {
        "kind": "blur.map-stream.index",
        "version": 1,
        "schema": common.SCHEMA,
        "map": map_id,
        "grid": {
            "axes": "XZ",
            "sizeMetres": common.SECTOR_SIZE,
            "globalSpanMetres": common.GLOBAL_SPAN,
            "origin": {"x": origin[0], "z": origin[1]},
            "assignment": "draw XZ AABB centroid; global when either AABB span exceeds globalSpanMetres",
        },
        "draws": {
            "order": "bucket draws.records (by ordinal)",
            "count": len(draws),
            "bindable": sum(1 for draw in draws if draw["kind"] == "bindable"),
            "blocked": sum(1 for draw in draws if draw["kind"] == "blocked"),
        },
        "meta": {
            "streams": {"path": "meta/streams.json", **draws_pin},
            "lap": {"path": "meta/lap.json", **lap_pin},
            "layoutPoints": (
                {"path": "meta/layout.points.f32.bin", **points_pin} if points_pin else None
            ),
        },
        "textures": {
            "blobs": len(textures),
            "bytes": sum(texture["bytes"] for texture in textures),
            "sharedPage": "shared/textures.json",
            "sharedSlots": global_texture_slots,
            "sharedBytes": len(shared_page_bytes),
            "sharedBlobs": len(global_texture_slots),
        },
        "global": {
            "path": "global/global.json",
            "drawOrdinals": [draw["ordinal"] for draw in global_draws],
            "draws": len(global_draws),
            "geometryBytes": global_record["geometry"]["bytes"],
            "textureBytes": global_record["textures"]["bytes"],
            "textureSlots": sorted(
                {draw["textureSlot"] for draw in global_draws if draw.get("textureSlot") is not None}
            ),
            "bytes": global_record["bytesWithJson"],
        },
        "sectors": [
            {
                "id": record["bucket"]["id"],
                "sx": record["bucket"]["sx"],
                "sz": record["bucket"]["sz"],
                "path": record["json"]["path"],
                "drawOrdinals": record["draws"]["ordinals"],
                "draws": record["draws"]["count"],
                "textureSlots": record["textureSlots"],
                "bytes": record["bytesWithJson"],
                "geometryBytes": record["geometry"]["bytes"],
                "textureBytes": record["textures"]["bytes"],
                "sha256": {
                    "geometry": record["geometry"]["sha256"],
                    "textures": record["textures"]["sha256"],
                },
                "files": {
                    "sector": record["json"]["path"],
                    "geometry": record["geometry"]["path"],
                    "textures": record["textures"]["path"],
                },
            }
            for record in sector_records
        ],
    }
    index_pin = emit("index.json", common.dumps_pretty(index))

    # --- measurement --------------------------------------------------------
    texture_total = sum(texture["bytes"] for texture in textures)
    shared_page_bytes = index["textures"]["sharedBytes"]
    stream_bytes = {
        f"{mesh_id}:{kind}": source["streams"][(mesh_id, kind)]["bytes"]
        for mesh_id in mesh_order
        for kind in common.STREAM_KINDS
        if (mesh_id, kind) in source["streams"]
    }
    coverage = _coverage(source["streams"], buckets, mesh_order)
    duplicate_rows = {}
    for name, item in coverage.items():
        emitted = sum(
            entry["bytes"]
            for record in sector_records + [global_record]
            for entry in record["geometry"]["slices"]
            if f"{entry['meshId']}:{entry['stream']}" == name
        )
        duplicate_rows[name] = emitted - item["coveredBytes"]
    duplication = duplicate_rows

    sector_by_key = {
        (record["bucket"]["sx"], record["bucket"]["sz"]): record for record in sector_records
    }
    sector_sizes = {key: record["bytesWithJson"] for key, record in sector_by_key.items()}

    def radius_set(radius: int) -> list:
        return [
            key
            for key in sector_by_key
            if abs(key[0] - spawn_sx) <= radius and abs(key[1] - spawn_sz) <= radius
        ]

    resident_paths = ["index.json", "meta/streams.json", "meta/lap.json"]
    if points_pin:
        resident_paths.append("meta/layout.points.f32.bin")
    resident_paths += [
        "global/global.json",
        "global/geometry.bin",
        "shared/textures.json",
        "shared/textures.bin",
    ]
    resident_base = sum(files[path]["bytes"] for path in resident_paths)

    package_payload = sum(stream_bytes.values()) + texture_total + (points_pin["bytes"] if points_pin else 0)
    committed_package_bytes = None
    if spec["kind"] == "render-package":
        committed_package_bytes = 0
        for name in sorted(os.listdir(common.repo_path(spec["dir"]))):
            full = os.path.join(common.repo_path(spec["dir"]), name)
            if os.path.isfile(full) and name != "verify.json":
                committed_package_bytes += os.path.getsize(full)
        for name in sorted(os.listdir(os.path.join(common.repo_path(spec["dir"]), "textures"))):
            committed_package_bytes += os.path.getsize(
                os.path.join(common.repo_path(spec["dir"]), "textures", name)
            )
    else:
        committed_package_bytes = len(common.read_bytes(spec["document"]))

    single = spec.get("servedSingleFile")
    single_info = None
    if single:
        try:
            data = common.read_bytes(single["path"])
            single_info = {
                "path": single["path"],
                "bytes": len(data),
                "sha256": common.sha256_tag(data),
                "declaredSha256": single.get("sha256"),
            }
        except FileNotFoundError:
            single_info = {"path": single["path"], "bytes": None, "sha256": None}

    def make_measurement(manifest_bytes_len: int) -> dict:
        resident = resident_base + manifest_bytes_len
        table = []
        for radius in range(0, 4):
            chosen = radius_set(radius)
            size = sum(sector_sizes[key] for key in chosen)
            table.append(
                {
                    "radiusSectors": radius,
                    "sectors": len(chosen),
                    "sectorBytes": size,
                    "residentPlusSectors": resident + size,
                }
            )
        spawn_key = (spawn_sx, spawn_sz)
        radius1_bytes = sum(sector_sizes[key] for key in radius_set(1))
        nearest = None
        if spawn_key not in sector_by_key and sector_sizes:
            nearest = min(
                sector_sizes,
                key=lambda key: (key[0] - spawn_sx) ** 2 + (key[1] - spawn_sz) ** 2,
            )
        sector_payload = [record["bytesWithJson"] for record in sector_records]
        total_chunked = manifest_bytes_len + sum(pin["bytes"] for pin in files.values())
        return {
            "grid": {
                "sizeMetres": common.SECTOR_SIZE,
                "globalSpanMetres": common.GLOBAL_SPAN,
                "origin": {"x": origin[0], "z": origin[1]},
            },
            "draws": {
                "total": len(draws),
                "bindable": sum(1 for draw in draws if draw["kind"] == "bindable"),
                "blocked": sum(1 for draw in draws if draw["kind"] == "blocked"),
                "global": len(global_draws),
                "sector": len(draws) - len(global_draws),
                "maxPerSector": max((record["draws"]["count"] for record in sector_records), default=0),
                "medianPerSector": _percentile(
                    [record["draws"]["count"] for record in sector_records], 0.5
                ),
            },
            "sectors": {
                "nonEmpty": len(sector_records),
                "gridWidth": (
                    max(key[0] for key in sector_by_key) - min(key[0] for key in sector_by_key) + 1
                    if sector_by_key
                    else 0
                ),
                "gridDepth": (
                    max(key[1] for key in sector_by_key) - min(key[1] for key in sector_by_key) + 1
                    if sector_by_key
                    else 0
                ),
            },
            "bytes": {
                "streams": {**stream_bytes, "total": sum(stream_bytes.values())},
                "textures": {
                    "blobs": len(textures),
                    "total": texture_total,
                    "shared": shared_page_bytes,
                    "exclusive": texture_total - shared_page_bytes,
                    "sharedBlobs": len(global_texture_slots),
                    "exclusiveBlobs": len(textures) - len(global_texture_slots),
                },
                "layoutPoints": points_pin["bytes"] if points_pin else 0,
                "manifest": manifest_bytes_len,
                "index": index_pin["bytes"],
                "metaStreams": draws_pin["bytes"],
                "metaLap": lap_pin["bytes"],
                "globalGeometry": global_record["geometry"]["bytes"],
                "globalJson": global_record["json"]["bytes"],
                "sharedTextures": shared_page_bytes,
                "sharedIndex": shared_index_pin["bytes"],
                "sectorGeometry": sum(record["geometry"]["bytes"] for record in sector_records),
                "sectorTextures": sum(record["textures"]["bytes"] for record in sector_records),
                "sectorJson": sum(record["json"]["bytes"] for record in sector_records),
                "sectorPayload": sum(sector_payload),
                "sectorPayloadMin": min(sector_payload) if sector_payload else 0,
                "sectorPayloadMedian": _percentile(sector_payload, 0.5),
                "sectorPayloadP90": _percentile(sector_payload, 0.9),
                "sectorPayloadMax": max(sector_payload) if sector_payload else 0,
                "resident": resident,
                "chunkedTotal": total_chunked,
            },
            "duplicationBytes": {
                "byStream": duplication,
                "repeatedVertexBytes": sum(
                    value for key, value in duplication.items() if not key.endswith(":indices")
                ),
                "repeatedIndexBytes": sum(
                    value for key, value in duplication.items() if key.endswith(":indices")
                ),
                "repeatedTextureBytes": 0,
            },
            "firstVisible": {
                "spawn": spawn,
                "sector": common.sector_id(spawn_sx, spawn_sz),
                "sectorPresent": spawn_key in sector_by_key,
                "nearestNonEmpty": common.sector_id(*nearest) if nearest else None,
                "sectorBytes": sector_sizes.get(spawn_key, 0),
                "radius1Sectors": len(radius_set(1)),
                "radius1Bytes": sum(sector_sizes[key] for key in radius_set(1)),
                "resident": resident,
                "residentPlusSector": resident + sector_sizes.get(spawn_key, 0),
                "residentPlusRadius1": resident + sum(sector_sizes[key] for key in radius_set(1)),
            },
            "streaming": {
                "loadRadiusSectors": 1,
                "prefetchRadiusSectors": 2,
                "evictRadiusSectors": 3,
                "table": table,
            },
            "coverage": coverage,
            "comparison": {
                "committedPackagePayloadBytes": package_payload,
                "committedPackageBytes": committed_package_bytes,
                "chunkedTotalBytes": total_chunked,
                "chunkedTotalVsPackage": (
                    round(total_chunked / committed_package_bytes, 4)
                    if committed_package_bytes
                    else None
                ),
                "residentBytes": resident,
                "residentVsPackage": (
                    round(resident / committed_package_bytes, 4)
                    if committed_package_bytes
                    else None
                ),
                "residentVsSingleFile": (
                    round(resident / single_info["bytes"], 4)
                    if single_info and single_info.get("bytes")
                    else None
                ),
                "residentPlusRadius1Bytes": resident + radius1_bytes,
                "residentPlusRadius1VsPackage": (
                    round((resident + radius1_bytes) / committed_package_bytes, 4)
                    if committed_package_bytes
                    else None
                ),
                "residentPlusRadius1VsSingleFile": (
                    round((resident + radius1_bytes) / single_info["bytes"], 4)
                    if single_info and single_info.get("bytes")
                    else None
                ),
                "servedSingleFile": single_info,
                "reductionVsSingleFile": (
                    round(1.0 - total_chunked / single_info["bytes"], 6)
                    if single_info and single_info.get("bytes")
                    else None
                ),
            },
        }

    manifest = {
        "kind": "blur.map-stream.manifest",
        "version": 1,
        "schema": common.SCHEMA,
        "map": {
            "id": map_id,
            "level": source["level"],
            "label": source["label"],
            "renderLabel": source["renderLabel"],
            "sourceKind": source["kind"],
        },
        "grid": {
            "axes": "XZ",
            "sizeMetres": common.SECTOR_SIZE,
            "globalSpanMetres": common.GLOBAL_SPAN,
            "origin": {"x": origin[0], "z": origin[1]},
            "assignment": "draw XZ AABB centroid; global when either AABB span exceeds globalSpanMetres",
            "sectorIdFormat": "x%03d_z%03d (sector index in the grid, origin-relative)",
        },
        "meshes": meta_streams["meshes"],
        "counts": {
            "draws": len(draws),
            "bindable": sum(1 for draw in draws if draw["kind"] == "bindable"),
            "blocked": sum(1 for draw in draws if draw["kind"] == "blocked"),
            "textures": len(textures),
            "textureBytes": texture_total,
            "sectors": len(sector_records),
            "globalDraws": len(global_draws),
        },
        "source": source["source"],
        "chunks": {
            "resident": [
                {"path": "manifest.json", "role": "self", "bytes": None},
                *[
                    {"path": path, "bytes": files[path]["bytes"]}
                    for path in resident_paths
                ],
            ],
            "global": {
                "path": "global/global.json",
                "geometry": "global/geometry.bin",
                "textures": "shared/textures.bin",
            },
            "sectorPattern": "sectors/x%03d_z%03d/{sector.json,geometry.bin,textures.bin}",
            "index": "index.json",
        },
        "textures": {
            "page": "shared/textures.bin",
            "pageIndex": "shared/textures.json",
            "blobs": len(textures),
            "bytes": texture_total,
            "sharedSlots": global_texture_slots,
            "sharedBlobs": len(global_texture_slots),
            "sharedBytes": shared_page_bytes,
            "exclusiveBytes": texture_total - shared_page_bytes,
            "resolution": "sector textures.bin first, then shared/textures.bin; every referenced slot resolves in exactly one page",
        },
        "measurement": make_measurement(0),
        "policy": {
            "sectorOwnership": "every draw appears in exactly one bucket (one sector or the global set); no draw is duplicated across buckets",
            "byteOwnership": "sector geometry slices may repeat shared vertices across buckets; GPU uploads write at the original stream offset, so repeats are idempotent and draw ranges never change",
            "drawRanges": "firstIndex/indexCount/firstVertex/vertexCount are the committed values; the loader uploads slices at their committed byte offset and draws the committed ranges",
            "globalSet": "draws whose XZ AABB exceeds 3 sectors (384 m) on either axis: terrain shells, sky/distant ridges, water planes. Always resident",
            "texturePages": "each RGBA blob is stored once: sector pages for sector-exclusive blobs, the shared page for cross-sector blobs",
            "missingSector": "typed error; a required sector (spawn or radius 1) that is missing aborts the map load. A draw whose bucket is not resident is never substituted",
            "determinism": "no timestamps, random ids or absolute paths; two builds are byte-identical",
        },
        "physics": {
            "sectorSplit": False,
            "reason": "the engine imports Level.levelphysics as one world with one static instance; wheel rays cross sector seams every few metres and e1_create consumes the whole file before a sector exists",
            "path": spec["physics"]["path"],
            "bytes": spec["physics"]["bytes"],
            "sha256": spec["physics"]["sha256"],
            "level": spec["physics"]["level"],
            "collisionTriangles": spec["physics"]["collisionTriangles"],
            "mustStayGlobal": [
                "the whole Level.levelphysics import (TriangleMesh, TriangleMeshBase, Box, Cylinder, InstancedTriangleMesh, FluidMesh shapes)",
                "the collision triangle surface used as physics provenance (render.json#collisionSurface)",
            ],
            "sectorSplitReason": "splitting collision would need one static instance per sector, per-sector ground probes and a seam-crossing ray query; no committed test proves that, so it is out of scope and undocumented behaviour is not invented",
        },
        "lapGates": lap_record,
        "hashes": {
            "algorithm": "sha256",
            "contentSha256": None,
            "files": dict(sorted(files.items())),
        },
        "limits": [
            "data only: no renderer, GPU, browser, e1-drive integration or playable-game claim",
            "geometry is the committed package payload partitioned by byte range; no vertex is remapped and no draw range changes",
            "blocked/decal draws are part of the partition (they own index ranges) but remain labelled diagnostics/decal, not opaque albedo",
            "texture pixels are the committed RGBA8 mip0 blobs; alpha, blend, shader, sampler, mips and sRGB are not applied",
            "collision and lap/gate data stay global; they are pinned, not sector-split",
            "a sector is self-sufficient for its own draws only when the shared texture page is resident (the shared page is loaded with the manifest set)",
            "instancesApplied:false, unsupported sections and the decoder-size/alpha blockers are inherited unchanged from the committed package",
        ],
    }

    # fixed point: the manifest records its own byte length
    for _ in range(6):
        body = {key: value for key, value in manifest.items() if key != "hashes"}
        manifest["hashes"]["contentSha256"] = common.content_hash(body)
        serialized = common.dumps_pretty(manifest)
        if manifest["measurement"]["bytes"]["manifest"] == len(serialized):
            break
        manifest["measurement"] = make_measurement(len(serialized))
        body = {key: value for key, value in manifest.items() if key != "hashes"}
        manifest["hashes"]["contentSha256"] = common.content_hash(body)
        serialized = common.dumps_pretty(manifest)
        if manifest["measurement"]["bytes"]["manifest"] == len(serialized):
            break
    manifest_bytes = common.dumps_pretty(manifest)
    common.write_bytes(os.path.join(root, "manifest.json"), manifest_bytes)

    measurement = manifest["measurement"]
    return {
        "map": map_id,
        "level": source["level"],
        "output": os.path.relpath(root, common.REPO).replace(os.sep, "/"),
        "sectors": len(sector_records),
        "globalDraws": len(global_draws),
        "draws": len(draws),
        "manifestBytes": len(manifest_bytes),
        "packageBytes": measurement["bytes"]["chunkedTotal"],
        "residentBytes": measurement["bytes"]["resident"],
        "sectorBytesMax": measurement["bytes"]["sectorPayloadMax"],
        "sectorBytesMedian": measurement["bytes"]["sectorPayloadMedian"],
        "firstVisibleSectorBytes": measurement["firstVisible"]["sectorBytes"],
        "firstVisibleResidentPlusRadius1": measurement["firstVisible"]["residentPlusRadius1"],
        "committedPackageBytes": measurement["comparison"]["committedPackageBytes"],
        "servedSingleFileBytes": (
            measurement["comparison"]["servedSingleFile"]["bytes"]
            if measurement["comparison"]["servedSingleFile"]
            else None
        ),
        "contentSha256": manifest["hashes"]["contentSha256"],
        "manifestSha256": common.sha256_tag(manifest_bytes),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--map", choices=list(common.MAP_ORDER))
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--out", default=os.path.join("_work", "map-stream"))
    args = parser.parse_args()
    if not args.all and not args.map:
        parser.error("give --map <id> or --all")
    maps = list(common.MAP_ORDER) if args.all else [args.map]
    out_root = common.repo_path(args.out)
    os.makedirs(out_root, exist_ok=True)
    summaries = [build_map(map_id, out_root) for map_id in maps]
    for summary in summaries:
        print(json.dumps(summary, sort_keys=True))
    common.write_bytes(
        os.path.join(out_root, "build.json"),
        common.dumps_pretty({"kind": "blur.map-stream.build", "version": 1, "maps": summaries}),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
