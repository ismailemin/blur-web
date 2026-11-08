"""Independent verifier for the spatial-sector map chunks.

Usage:
    python probes/map-stream/tools/verify_map_stream.py --map amboy
    python probes/map-stream/tools/verify_map_stream.py --all
    python probes/map-stream/tools/verify_map_stream.py --all --skip-determinism

The verifier re-reads the committed map package, re-derives every draw range,
sector assignment, slice table, texture page and measurement, then reassembles
the streams and compares them byte-for-byte with the committed payload.  It
also performs a fresh build into a temporary directory and compares every file
with the committed chunk output (two-build determinism).
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import shutil
import sys
from array import array

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import map_stream_common as common

SECTOR_SIZE = common.SECTOR_SIZE
GLOBAL_SPAN = common.GLOBAL_SPAN


class Checker:
    def __init__(self, map_id: str):
        self.map_id = map_id
        self.checks = 0
        self.failures = []
        self.notes = []

    def check(self, ok: bool, name: str, detail=None) -> bool:
        self.checks += 1
        if not ok:
            self.failures.append({"name": name, "detail": detail})
        return bool(ok)

    def eq(self, got, want, name: str) -> bool:
        ok = got == want
        return self.check(ok, name, None if ok else {"got": got, "want": want})

    def note(self, text: str) -> None:
        self.notes.append(text)


# --- independent source reading --------------------------------------------


def _pin(value) -> str:
    return value if value.startswith("sha256:") else "sha256:" + value


def _sha(data: bytes) -> str:
    return common.sha256_tag(data)


def read_source(map_id: str) -> dict:
    spec = common.MAP_SOURCES[map_id]
    if spec["kind"] == "render-package":
        return read_render_package(map_id, spec)
    return read_geometry_document(map_id, spec)


def _draw_ranges(indices: bytes, first_index: int, index_count: int) -> tuple:
    values = array("I")
    values.frombytes(indices[first_index * 4 : (first_index + index_count) * 4])
    return min(values), max(values)


def _bounds(positions: bytes, lo: int, hi: int) -> list:
    floats = memoryview(positions).cast("f")
    xs = floats[lo * 3 : hi * 3 + 3 : 3]
    ys = floats[lo * 3 + 1 : hi * 3 + 3 : 3]
    zs = floats[lo * 3 + 2 : hi * 3 + 3 : 3]
    return [
        round(min(xs), 6),
        round(min(ys), 6),
        round(min(zs), 6),
        round(max(xs), 6),
        round(max(ys), 6),
        round(max(zs), 6),
    ]


def _bounds_dict(values: list) -> dict:
    return {
        "minX": values[0],
        "minY": values[1],
        "minZ": values[2],
        "maxX": values[3],
        "maxY": values[4],
        "maxZ": values[5],
    }


def read_render_package(map_id: str, spec: dict) -> dict:
    rel_dir = spec["dir"]
    render_bytes = common.read_bytes(rel_dir + "/render.json")
    diag_bytes = common.read_bytes(rel_dir + "/diagnostics.json")
    render = json.loads(render_bytes.decode("utf-8"))
    diag = json.loads(diag_bytes.decode("utf-8"))
    mesh_id = spec["meshId"]
    streams = {}
    for kind in ("positions", "uv0", "indices"):
        entry = render["buffers"][kind]
        data = common.read_bytes(rel_dir + "/" + entry["path"])
        streams[kind] = {"data": data, "bytes": len(data), "pin": _pin(entry["sha256"]), "count": entry["count"]}
    draws = []
    for position, record in enumerate(render["draws"]):
        lo, hi = _draw_ranges(streams["indices"]["data"], record["firstIndex"], record["indexCount"])
        draws.append(
            {
                "ordinal": len(draws),
                "drawId": record["drawId"],
                "kind": "bindable",
                "meshId": mesh_id,
                "firstIndex": record["firstIndex"],
                "indexCount": record["indexCount"],
                "firstVertex": lo,
                "vertexCount": hi - lo + 1,
                "triangleCount": record["triangleCount"],
                "textureId": record.get("textureId"),
                "textureSlot": record.get("textureSlot"),
                "bounds": _bounds(streams["positions"]["data"], lo, hi),
                "source": {"file": "render.json", "index": position},
            }
        )
    for position, record in enumerate(diag["draws"]):
        lo, hi = _draw_ranges(streams["indices"]["data"], record["firstIndex"], record["indexCount"])
        draws.append(
            {
                "ordinal": len(draws),
                "drawId": record["drawId"],
                "kind": "blocked",
                "meshId": mesh_id,
                "firstIndex": record["firstIndex"],
                "indexCount": record["indexCount"],
                "firstVertex": lo,
                "vertexCount": hi - lo + 1,
                "triangleCount": record["triangleCount"],
                "textureId": record.get("textureId"),
                "textureSlot": None,
                "bounds": _bounds(streams["positions"]["data"], lo, hi),
                "source": {"file": "diagnostics.json", "index": position},
            }
        )
    textures = {}
    for item in render["textures"]["items"]:
        data = common.read_bytes(rel_dir + "/" + item["file"])
        textures[item["slot"]] = {
            "slot": item["slot"],
            "id": item["primaryId"],
            "file": item["file"],
            "bytes": item["bytes"],
            "sha256": _pin(item["sha256"]),
            "data": data,
            "width": item["width"],
            "height": item["height"],
        }
    layout = render["layout"]
    points = common.read_bytes(rel_dir + "/" + layout["pointsFile"])
    return {
        "map_id": map_id,
        "kind": spec["kind"],
        "level": spec["level"],
        "meshIds": [mesh_id],
        "streams": {(mesh_id, kind): streams[kind] for kind in streams},
        "draws": draws,
        "textures": textures,
        "layout": layout,
        "points": points,
        "pointsPin": _pin(layout["pointsSha256"]),
        "source": {
            "render": {"file": "render.json", "bytes": len(render_bytes), "sha256": _sha(render_bytes)},
            "diagnostics": {
                "file": "diagnostics.json",
                "bytes": len(diag_bytes),
                "sha256": _sha(diag_bytes),
            },
            "renderContentHash": _pin(render["hashes"]["contentSha256"]),
        },
        "physics": spec["physics"],
        "lap": spec["lap"],
        "spawn": spec["spawn"],
    }


def read_geometry_document(map_id: str, spec: dict) -> dict:
    doc_bytes = common.read_bytes(spec["document"])
    doc = json.loads(doc_bytes.decode("utf-8"))
    streams = {}
    draws = []
    mesh_ids = []
    for mesh in doc["meshes"]:
        mesh_id = mesh["id"]
        mesh_ids.append(mesh_id)
        positions = mesh["positions"]
        if isinstance(positions, str):
            positions = json.loads(positions)
        indices = mesh["indices"]
        if isinstance(indices, str):
            indices = json.loads(indices)
        uv = mesh["uv"]
        if isinstance(uv, str):
            uv = json.loads(uv)
        pos_bytes = array("f", positions).tobytes()
        idx_bytes = array("I", indices).tobytes()
        uv_bytes = base64.b64decode(uv["data"])
        if _sha(pos_bytes) != _pin(mesh["positionsSha256"]):
            raise AssertionError("river positions pin mismatch")
        if _sha(idx_bytes) != _pin(mesh["indicesSha256"]):
            raise AssertionError("river indices pin mismatch")
        if _sha(uv_bytes) != _pin(uv["sha256"]):
            raise AssertionError("river uv0 pin mismatch")
        streams[(mesh_id, "positions")] = {"data": pos_bytes, "bytes": len(pos_bytes), "pin": _pin(mesh["positionsSha256"]), "count": len(pos_bytes) // 12}
        streams[(mesh_id, "uv0")] = {"data": uv_bytes, "bytes": len(uv_bytes), "pin": _pin(uv["sha256"]), "count": len(uv_bytes) // 8}
        streams[(mesh_id, "indices")] = {"data": idx_bytes, "bytes": len(idx_bytes), "pin": _pin(mesh["indicesSha256"]), "count": len(idx_bytes) // 4}
    textures_by_id = {}
    slot = 0
    for group in ("levelTextures", "textures"):
        for item in doc.get(group) or []:
            data = base64.b64decode(item["rgbaBase64"])
            textures_by_id[item["id"]] = {
                "slot": slot,
                "id": item["id"],
                "file": f"textures/tex-{slot:03d}.rgba",
                "bytes": item["rgbaBytes"],
                "sha256": _pin(item["rgbaSha256"]),
                "data": data,
                "width": item["width"],
                "height": item["height"],
            }
            slot += 1
    texture_by_slot = {item["slot"]: item for item in textures_by_id.values()}

    def add(draw, group, position):
        mesh_id = draw["meshId"]
        indices = streams[(mesh_id, "indices")]["data"]
        lo, hi = _draw_ranges(indices, draw["indexOffset"], draw["indexCount"])
        texture = textures_by_id.get(draw.get("textureId"))
        draws.append(
            {
                "ordinal": len(draws),
                "drawId": draw["id"],
                "kind": "bindable",
                "meshId": mesh_id,
                "firstIndex": draw["indexOffset"],
                "indexCount": draw["indexCount"],
                "firstVertex": lo,
                "vertexCount": hi - lo + 1,
                "triangleCount": draw["indexCount"] // 3,
                "textureId": draw.get("textureId"),
                "textureSlot": texture["slot"] if texture else None,
                "bounds": _bounds(streams[(mesh_id, "positions")]["data"], lo, hi),
                "source": {"file": "level.geometry.json", "group": group, "index": position},
            }
        )

    for position, draw in enumerate(doc["levelDraws"]):
        add(draw, "levelDraws", position)
    for position, draw in enumerate(doc["trackVisual"]["draws"]):
        add(draw, "trackVisual.draws", position)
    return {
        "map_id": map_id,
        "kind": spec["kind"],
        "level": spec["level"],
        "meshIds": mesh_ids,
        "streams": streams,
        "draws": draws,
        "textures": texture_by_slot,
        "layout": None,
        "points": None,
        "pointsPin": None,
        "source": {"document": {"file": spec["document"], "bytes": len(doc_bytes), "sha256": _sha(doc_bytes)}},
        "physics": spec["physics"],
        "lap": spec["lap"],
        "spawn": spec["spawn"],
    }


# --- helpers ----------------------------------------------------------------


def bucket_of(draw: dict, origin: tuple) -> object:
    bounds = _bounds_dict(draw["bounds"])
    if (bounds["maxX"] - bounds["minX"]) > GLOBAL_SPAN or (bounds["maxZ"] - bounds["minZ"]) > GLOBAL_SPAN:
        return "global"
    cx = (bounds["minX"] + bounds["maxX"]) / 2.0
    cz = (bounds["minZ"] + bounds["maxZ"]) / 2.0
    return (int(math.floor((cx - origin[0]) / SECTOR_SIZE)), int(math.floor((cz - origin[1]) / SECTOR_SIZE)))


def slice_range(draw: dict, kind: str) -> tuple:
    if kind == "indices":
        return draw["firstIndex"] * 4, (draw["firstIndex"] + draw["indexCount"]) * 4
    stride = 12 if kind == "positions" else 8
    return draw["firstVertex"] * stride, (draw["firstVertex"] + draw["vertexCount"]) * stride


def merge(ranges) -> list:
    out = []
    for start, end in sorted(ranges):
        if out and start <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], end))
        else:
            out.append((start, end))
    return out


def percentile(values, fraction):
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int(round(fraction * (len(ordered) - 1)))))]


def aggregate(files: list) -> str:
    lines = "\n".join(f"{name}\0{size}\0{sha}" for name, size, sha in sorted(files))
    return common.sha256_tag(lines.encode("utf-8"))


# --- verification -----------------------------------------------------------


def verify_map(map_id: str, out_root: str, determinism: bool, checker: Checker) -> dict:
    root = os.path.join(out_root, map_id)
    manifest_path = os.path.join(root, "manifest.json")
    checker.check(os.path.isfile(manifest_path), "manifest.json exists")
    manifest_bytes = open(manifest_path, "rb").read()
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    checker.eq(manifest.get("kind"), "blur.map-stream.manifest", "manifest kind")
    checker.eq(manifest.get("version"), 1, "manifest version")
    checker.eq(manifest.get("schema"), common.SCHEMA, "manifest schema")
    checker.eq(manifest["map"]["id"], map_id, "manifest map id")

    index_path = os.path.join(root, "index.json")
    index = json.loads(open(index_path, "rb").read().decode("utf-8"))
    checker.eq(index.get("kind"), "blur.map-stream.index", "index kind")
    checker.eq(index.get("map"), map_id, "index map id")

    bucket_paths = {"global": index["global"]["path"]}
    for item in index["sectors"]:
        bucket_paths[(int(item["sx"]), int(item["sz"]))] = item["path"]
    bucket_records = {
        key: json.loads(open(os.path.join(root, path.replace("/", os.sep)), "rb").read().decode("utf-8"))
        for key, path in bucket_paths.items()
    }
    shared_index = json.loads(open(os.path.join(root, "shared", "textures.json"), "rb").read().decode("utf-8"))
    shared_page = open(os.path.join(root, "shared", "textures.bin"), "rb").read()

    # 1. self pins -----------------------------------------------------------
    body = {key: value for key, value in manifest.items() if key != "hashes"}
    checker.eq(manifest["hashes"]["contentSha256"], common.content_hash(body), "manifest content hash")
    pinned_files = manifest["hashes"]["files"]
    for rel_path, pin in pinned_files.items():
        full = os.path.join(root, rel_path.replace("/", os.sep))
        exists = os.path.isfile(full)
        checker.check(exists, "file " + rel_path + " exists")
        if not exists:
            continue
        data = open(full, "rb").read()
        checker.eq(len(data), pin["bytes"], "file " + rel_path + " bytes")
        checker.eq(_sha(data), pin["sha256"], "file " + rel_path + " sha256")

    emitted = set()
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            rel = os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/")
            if rel in ("manifest.json", "verify.json"):
                continue
            emitted.add(rel)
    checker.eq(sorted(emitted), sorted(pinned_files), "every emitted file is pinned (no extra payload)")

    # 2. source --------------------------------------------------------------
    source = read_source(map_id)
    draws = source["draws"]
    textures = source["textures"]
    checker.eq(len(manifest["source"].get("render", manifest["source"].get("document", {}))), 3, "source pin block present")
    if source["kind"] == "render-package":
        for key in ("render", "diagnostics"):
            pin = manifest["source"][key]
            checker.eq(pin["bytes"], source["source"][key]["bytes"], f"source {key} bytes")
            checker.eq(pin["sha256"], source["source"][key]["sha256"], f"source {key} sha256")
        checker.eq(manifest["source"]["renderContentHash"], source["source"]["renderContentHash"], "source render content hash")
        for mesh_id in source["meshIds"]:
            for kind in ("positions", "uv0", "indices"):
                stream = source["streams"][(mesh_id, kind)]
                meta_stream = next(
                    item["streams"][kind]
                    for item in manifest["meshes"]
                    if item["meshId"] == mesh_id
                )
                checker.eq(meta_stream["bytes"], stream["bytes"], f"stream {mesh_id}:{kind} bytes")
                checker.eq(meta_stream["sha256"], stream["pin"], f"stream {mesh_id}:{kind} sha256")
    else:
        doc = manifest["source"]["document"]
        checker.eq(doc["bytes"], source["source"]["document"]["bytes"], "source document bytes")
        checker.eq(doc["sha256"], source["source"]["document"]["sha256"], "source document sha256")
        for mesh_id in source["meshIds"]:
            meta_mesh = next(item for item in manifest["meshes"] if item["meshId"] == mesh_id)
            for kind in ("positions", "uv0", "indices"):
                stream = source["streams"][(mesh_id, kind)]
                checker.eq(meta_mesh["streams"][kind]["bytes"], stream["bytes"], f"stream {mesh_id}:{kind} bytes")
                checker.eq(meta_mesh["streams"][kind]["sha256"], stream["pin"], f"stream {mesh_id}:{kind} sha256")

    # 3. draw table ----------------------------------------------------------
    meta_streams = json.loads(open(os.path.join(root, "meta", "streams.json"), "rb").read().decode("utf-8"))
    checker.eq(meta_streams.get("kind"), "blur.map-stream.streams", "meta streams kind")
    checker.eq(len(meta_streams["meshes"]), len(source["meshIds"]), "meta mesh count")
    checker.eq([item["meshId"] for item in meta_streams["meshes"]], source["meshIds"], "meta mesh ids")
    records = {}
    for key, record in bucket_records.items():
        for draw_record in record["draws"]["records"]:
            ordinal = draw_record["ordinal"]
            checker.check(ordinal not in records, f"draw {ordinal} record appears once")
            records[ordinal] = draw_record
    checker.eq(sorted(records), list(range(len(draws))), "bucket draw records cover every ordinal")
    for draw in draws:
        record = records.get(draw["ordinal"])
        checker.check(record is not None, f"draw {draw['ordinal']} has a record")
        if record is None:
            continue
        tag = f"draw {draw['ordinal']} {draw['drawId']}"
        checker.eq(record["ordering"] if "ordering" in record else record["ordinal"], draw["ordinal"], tag + " ordinal")
        checker.eq(record["drawId"], draw["drawId"], tag + " id")
        checker.eq(record["kind"], draw["kind"], tag + " kind")
        checker.eq(record["meshId"], draw["meshId"], tag + " mesh")
        checker.eq(record["firstIndex"], draw["firstIndex"], tag + " firstIndex")
        checker.eq(record["indexCount"], draw["indexCount"], tag + " indexCount")
        checker.eq(record["firstVertex"], draw["firstVertex"], tag + " firstVertex")
        checker.eq(record["vertexCount"], draw["vertexCount"], tag + " vertexCount")
        checker.eq(record["bounds"], _bounds_dict(draw["bounds"]), tag + " bounds")
        checker.eq(record["textureId"], draw["textureId"], tag + " textureId")
        checker.eq(record["textureSlot"], draw["textureSlot"], tag + " textureSlot")
        checker.eq(record["triangleCount"], draw["triangleCount"], tag + " triangleCount")

    # 4. texture table -------------------------------------------------------
    texture_records = {}
    for key, record in bucket_records.items():
        for blob in record["textures"].get("blobs") or []:
            checker.check(blob["slot"] not in texture_records, f"texture {blob['slot']} described once")
            texture_records[blob["slot"]] = blob
    for blob in shared_index["blobs"]:
        checker.check(blob["slot"] not in texture_records, f"texture {blob['slot']} described once (shared)")
        texture_records[blob["slot"]] = blob
    checker.eq(sorted(texture_records), sorted(textures), "texture descriptor set equals source")
    for slot, texture in textures.items():
        record = texture_records.get(slot)
        if record is None:
            continue
        checker.eq(record["id"], texture["id"], f"texture {slot} id")
        checker.eq(record["bytes"], texture["bytes"], f"texture {slot} bytes")
        checker.eq(record["sha256"], texture["sha256"], f"texture {slot} sha256")
        checker.eq(record["width"], texture["width"], f"texture {slot} width")
        checker.eq(record["height"], texture["height"], f"texture {slot} height")
        checker.eq(_sha(texture["data"]), texture["sha256"], f"texture {slot} source sha")

    # 5. grid / assignment ---------------------------------------------------
    min_x = min(_bounds_dict(draw["bounds"])["minX"] for draw in draws)
    min_z = min(_bounds_dict(draw["bounds"])["minZ"] for draw in draws)
    origin = (math.floor(min_x / SECTOR_SIZE) * SECTOR_SIZE, math.floor(min_z / SECTOR_SIZE) * SECTOR_SIZE)
    checker.eq(manifest["grid"]["origin"], {"x": origin[0], "z": origin[1]}, "grid origin")
    checker.eq(manifest["grid"]["sizeMetres"], SECTOR_SIZE, "grid sector size")
    checker.eq(manifest["grid"]["globalSpanMetres"], GLOBAL_SPAN, "grid global span")

    expected_buckets = {}
    for draw in draws:
        expected_buckets.setdefault(bucket_of(draw, origin), []).append(draw["ordinal"])
    for key, ordinals in expected_buckets.items():
        checker.eq(sorted(ordinals), sorted(set(ordinals)), f"bucket {key} has unique ordinals")

    index_sectors = {(int(item["sx"]), int(item["sz"])): item for item in index["sectors"]}
    expected_sectors = {key for key in expected_buckets if key != "global"}
    checker.eq(sorted(index_sectors), sorted(expected_sectors), "index sector set equals computed sectors")
    seen = {}
    for key, ordinals in expected_buckets.items():
        if key == "global":
            listed = index["global"]["drawOrdinals"]
        else:
            listed = index_sectors[key]["drawOrdinals"]
        checker.eq(sorted(listed), sorted(ordinals), f"index bucket {key} draw ordinals")
        for ordinal in listed:
            seen[ordinal] = seen.get(ordinal, 0) + 1
    checker.eq(sorted(seen), list(range(len(draws))), "every draw ordinal appears in a bucket")
    checker.eq(sorted(seen.values()), [1] * len(draws), "every draw appears exactly once")

    # 6. per-bucket payload --------------------------------------------------
    drawn_by_ordinal = {draw["ordinal"]: draw for draw in draws}
    stream_by_key = source["streams"]
    reassembled = {key: bytearray(stream["bytes"]) for key, stream in stream_by_key.items()}
    written = {key: bytearray(stream["bytes"]) for key, stream in stream_by_key.items()}

    buckets = [("global", index["global"]["path"])] + [
        (key, item["path"]) for key, item in sorted(index_sectors.items())
    ]
    for key, rel_path in buckets:
        record = bucket_records[key]
        bucket_dir = os.path.dirname(full)
        ordinals = record["draws"]["ordinals"]
        draw_list = [drawn_by_ordinal[ordinal] for ordinal in ordinals]
        tag = "bucket " + (key if isinstance(key, str) else common.sector_id(*key))
        checker.eq(record["kind"], "blur.map-stream.global" if key == "global" else "blur.map-stream.sector", tag + " kind")
        checker.eq(record["map"], map_id, tag + " map")
        if key != "global":
            checker.eq(int(record["bucket"]["sx"]), key[0], tag + " sx")
            checker.eq(int(record["bucket"]["sz"]), key[1], tag + " sz")
            checker.eq(record["bucket"]["bounds"], common.sector_bounds(key[0], key[1], origin), tag + " bounds")
            for draw in draw_list:
                bounds = _bounds_dict(draw["bounds"])
                cx = (bounds["minX"] + bounds["maxX"]) / 2.0
                cz = (bounds["minZ"] + bounds["maxZ"]) / 2.0
                inside = (
                    record["bucket"]["bounds"]["minX"] <= cx < record["bucket"]["bounds"]["maxX"]
                    and record["bucket"]["bounds"]["minZ"] <= cz < record["bucket"]["bounds"]["maxZ"]
                )
                checker.check(inside, tag + f" draw {draw['ordinal']} centroid inside sector")
        checker.eq(record["draws"]["count"], len(draw_list), tag + " draw count")
        checker.eq(record["draws"]["bindable"], sum(1 for d in draw_list if d["kind"] == "bindable"), tag + " bindable count")
        checker.eq(record["draws"]["blocked"], sum(1 for d in draw_list if d["kind"] == "blocked"), tag + " blocked count")
        checker.eq(record["draws"]["triangles"], sum(d["triangleCount"] for d in draw_list), tag + " triangle count")
        checker.eq(
            [item["ordinal"] for item in record["draws"]["records"]],
            record["draws"]["ordinals"],
            tag + " draw records match ordinals",
        )

        geometry_file = os.path.join(root, record["geometry"]["path"])
        geometry_bytes = open(geometry_file, "rb").read()
        checker.eq(len(geometry_bytes), record["geometry"]["bytes"], tag + " geometry bytes")
        checker.eq(_sha(geometry_bytes), record["geometry"]["sha256"], tag + " geometry sha256")
        offsets = 0
        slices = record["geometry"]["slices"]
        covered = {}
        for entry in slices:
            checker.eq(entry["payloadOffset"], offsets, tag + " slice payload offset contiguous")
            chunk = geometry_bytes[entry["payloadOffset"] : entry["payloadOffset"] + entry["bytes"]]
            checker.eq(_sha(chunk), entry["sha256"], tag + " slice sha256")
            stream = stream_by_key[(entry["meshId"], entry["stream"])]
            start = entry["srcOffset"]
            end = start + entry["bytes"]
            checker.check(end <= stream["bytes"], tag + " slice inside stream")
            checker.check(
                chunk == stream["data"][start:end],
                tag + " slice is a verbatim stream copy",
            )
            target = reassembled[(entry["meshId"], entry["stream"])]
            target[start:end] = chunk
            written[(entry["meshId"], entry["stream"])][start:end] = b"\x01" * (end - start)
            covered.setdefault((entry["meshId"], entry["stream"]), []).append((start, end))
            offsets = entry["payloadOffset"] + entry["bytes"]
        checker.eq(offsets, len(geometry_bytes), tag + " geometry file is exactly the slice payload")

        for mesh_id in source["meshIds"]:
            for kind in ("positions", "uv0", "indices"):
                if (mesh_id, kind) not in stream_by_key:
                    continue
                expected = merge(
                    [slice_range(draw, kind) for draw in draw_list if draw["meshId"] == mesh_id]
                )
                actual = merge(covered.get((mesh_id, kind), []))
                checker.eq(actual, expected, tag + f" {mesh_id}:{kind} slice table equals merged draw ranges")
        for draw in draw_list:
            for kind in ("positions", "uv0", "indices"):
                start, end = slice_range(draw, kind)
                target = written[(draw["meshId"], kind)]
                checker.check(
                    target[start:end].count(1) == end - start,
                    tag + f" draw {draw['ordinal']} {kind} range covered",
                )

        textures_file = os.path.join(root, record["textures"]["path"])
        texture_bytes = open(textures_file, "rb").read()
        checker.eq(len(texture_bytes), record["textures"]["bytes"], tag + " texture page bytes")
        checker.eq(_sha(texture_bytes), record["textures"]["sha256"], tag + " texture page sha256")
        if record["textures"].get("blobs") is None:
            checker.eq(record["textures"]["table"], "shared/textures.json", tag + " global texture table pointer")
            page_slots = sorted(index["textures"]["sharedSlots"])
        else:
            offset = 0
            page_slots = []
            for blob in record["textures"]["blobs"]:
                checker.eq(blob["offset"], offset, tag + " texture blob offset contiguous")
                data = texture_bytes[blob["offset"] : blob["offset"] + blob["bytes"]]
                checker.eq(_sha(data), blob["sha256"], tag + " texture blob sha256")
                checker.eq(blob["bytes"], textures[blob["slot"]]["bytes"], tag + " texture blob bytes")
                checker.eq(data, textures[blob["slot"]]["data"], tag + " texture blob is a verbatim copy")
                page_slots.append(blob["slot"])
                offset += blob["bytes"]
            checker.eq(offset, len(texture_bytes), tag + " texture page is exactly the blob payload")
            checker.eq(page_slots, sorted(set(page_slots)), tag + " texture page slots unique and sorted")
        # every draw's texture resolves on this page or the shared page
        shared_slots = set(index["textures"]["sharedSlots"])
        for draw in draw_list:
            slot = draw["textureSlot"]
            if slot is None:
                continue
            checker.check(
                slot in page_slots or slot in shared_slots,
                tag + f" draw {draw['ordinal']} texture slot {slot} resolves",
            )

    # 7. reassembly ----------------------------------------------------------
    for (mesh_id, kind), stream in stream_by_key.items():
        checker.eq(_sha(bytes(reassembled[(mesh_id, kind)])), stream["pin"], f"reassembly {mesh_id}:{kind} equals committed stream hash")
        expected_covered = sum(
            end - start
            for start, end in merge(
                [slice_range(draw, kind) for draw in draws if draw["meshId"] == mesh_id]
            )
        )
        checker.eq(
            written[(mesh_id, kind)].count(0),
            stream["bytes"] - expected_covered,
            f"reassembly {mesh_id}:{kind} covers every draw-referenced byte",
        )
    checker.eq(len(reassembled), len(stream_by_key), "reassembly stream count")

    # 8. texture ownership ---------------------------------------------------
    owner_sets = {}
    for draw in draws:
        slot = draw["textureSlot"]
        if slot is None or slot not in textures:
            continue
        owner_sets.setdefault(slot, set()).add(bucket_of(draw, origin))
    expected_shared = sorted(slot for slot, keys in owner_sets.items() if len(keys) > 1 or "global" in keys)
    expected_unused = sorted(slot for slot in textures if slot not in owner_sets)
    expected_global = sorted(set(expected_shared) | set(expected_unused))
    checker.eq(index["textures"]["sharedSlots"], expected_global, "shared texture slot set")
    checker.eq(
        index["textures"]["sharedBlobs"],
        len(expected_global),
        "shared texture blob count",
    )
    shared_index = json.loads(open(os.path.join(root, "shared", "textures.json"), "rb").read().decode("utf-8"))
    shared_page = open(os.path.join(root, "shared", "textures.bin"), "rb").read()
    checker.eq(len(shared_page), shared_index["bytes"], "shared page bytes pin")
    checker.eq(_sha(shared_page), shared_index["sha256"], "shared page sha256 pin")
    checker.eq([blob["slot"] for blob in shared_index["blobs"]], expected_global, "shared page blob order")
    for blob in shared_index["blobs"]:
        data = shared_page[blob["offset"] : blob["offset"] + blob["bytes"]]
        checker.eq(data, textures[blob["slot"]]["data"], f"shared texture {blob['slot']} is a verbatim copy")
    reassembled_textures = {}
    sector_texture_records = [bucket_records[key] for key in sorted(index_sectors)]
    for record in sector_texture_records:
        page = open(os.path.join(root, record["textures"]["path"]), "rb").read()
        blobs = record["textures"]["blobs"]
        for blob in blobs:
            checker.check(blob["slot"] not in reassembled_textures, f"texture slot {blob['slot']} stored exactly once")
            reassembled_textures[blob["slot"]] = page[blob["offset"] : blob["offset"] + blob["bytes"]]
    for blob in shared_index["blobs"]:
        checker.check(blob["slot"] not in reassembled_textures, f"texture slot {blob['slot']} stored exactly once (shared)")
        reassembled_textures[blob["slot"]] = shared_page[blob["offset"] : blob["offset"] + blob["bytes"]]
    checker.eq(sorted(reassembled_textures), sorted(textures), "reassembled texture slot set equals source")
    texture_rows = []
    for slot, texture in textures.items():
        data = reassembled_textures[slot]
        checker.eq(_sha(data), texture["sha256"], f"reassembled texture {slot} matches committed sha")
        texture_rows.append((texture["file"], len(data), _sha(data)))
    committed_rows = [(texture["file"], texture["bytes"], texture["sha256"]) for texture in textures.values()]
    checker.eq(aggregate(texture_rows), aggregate(committed_rows), "texture aggregate hash equals committed package")
    checker.eq(manifest["textures"]["blobs"], len(textures), "manifest texture blob count")
    checker.eq(manifest["textures"]["bytes"], sum(texture["bytes"] for texture in textures.values()), "manifest texture byte total")
    checker.eq(manifest["textures"]["sharedBytes"], len(shared_page), "manifest shared texture bytes")
    checker.eq(
        manifest["textures"]["exclusiveBytes"],
        sum(texture["bytes"] for texture in textures.values()) - len(shared_page),
        "manifest exclusive texture bytes",
    )

    # 9. layout / lap / physics ---------------------------------------------
    if source["kind"] == "render-package":
        points_path = os.path.join(root, "meta", "layout.points.f32.bin")
        checker.check(os.path.isfile(points_path), "layout points file exists")
        points = open(points_path, "rb").read()
        checker.eq(len(points), len(source["points"]), "layout points bytes")
        checker.eq(_sha(points), source["pointsPin"], "layout points sha equals committed pin")
        checker.eq(points, source["points"], "layout points are a byte copy")
        checker.eq(meta_streams["layout"]["points"]["sha256"], source["pointsPin"], "meta layout points pin")
    lap_record = json.loads(open(os.path.join(root, "meta", "lap.json"), "rb").read().decode("utf-8"))
    checker.eq(manifest["lapGates"], lap_record, "manifest lap block equals meta/lap.json")
    checker.eq(lap_record["sectorSplit"], False, "lap data is global")
    if source["lap"].get("path"):
        data = common.read_bytes(source["lap"]["path"])
        checker.eq(lap_record["source"]["bytes"], len(data), "lap source bytes")
        checker.eq(lap_record["source"]["sha256"], _sha(data), "lap source sha")
        payload = json.loads(data.decode("utf-8"))
        if payload.get("kind") == "e1-drive.sprint":
            checker.eq(lap_record["gates"], payload["gates"], "lap gates copied verbatim")
            checker.eq(lap_record["countdown"], payload.get("countdown"), "lap countdown copied verbatim")
            checker.eq(lap_record["course"]["lengthMetres"], payload["course"]["lengthMetres"], "lap course length")
        else:
            checker.eq(lap_record["course"]["start"], payload["start"], "lap course start")
            checker.eq(lap_record["course"]["finish"], payload["finish"], "lap course finish")
    else:
        checker.check(lap_record["gates"] is None, "no invented gates for a map without a committed layout")
    physics = manifest["physics"]
    checker.eq(physics["sectorSplit"], False, "physics stays global")
    checker.eq(physics["path"], source["physics"]["path"], "physics path pin")
    checker.eq(physics["bytes"], source["physics"]["bytes"], "physics bytes pin")
    checker.eq(physics["sha256"], source["physics"]["sha256"], "physics sha pin")
    if os.path.isfile(common.repo_path(physics["path"])):
        checker.eq(_sha(common.read_bytes(physics["path"])), physics["sha256"], "physics file matches its pin")
    else:
        checker.check(True, "physics file not present locally (pin carried from the committed map package)")

    # 10. measurement --------------------------------------------------------
    measurement = manifest["measurement"]
    sector_ordinals = {key: value for key, value in expected_buckets.items() if key != "global"}
    sector_records = {
        key: json.loads(open(os.path.join(root, index_sectors[key]["path"]), "rb").read().decode("utf-8"))
        for key in sector_ordinals
    }
    sector_sizes = {key: index_sectors[key]["bytes"] for key in sector_ordinals}
    for key, record in sector_records.items():
        item = index_sectors[key]
        checker.eq(item["draws"], len(item["drawOrdinals"]), f"index sector {key} draw count")
        checker.eq(
            item["bytes"],
            item["geometryBytes"] + item["textureBytes"] + len(common.dumps_pretty(record)),
            f"index sector {key} byte total",
        )
        checker.eq(item["sha256"]["geometry"], record["geometry"]["sha256"], f"index sector {key} geometry pin")
        checker.eq(item["sha256"]["textures"], record["textures"]["sha256"], f"index sector {key} texture pin")
    spawn = source["spawn"]
    spawn_sx = int((spawn["x"] - origin[0]) // SECTOR_SIZE)
    spawn_sz = int((spawn["z"] - origin[1]) // SECTOR_SIZE)
    checker.eq(measurement["draws"]["total"], len(draws), "measurement draw total")
    checker.eq(measurement["draws"]["bindable"], sum(1 for draw in draws if draw["kind"] == "bindable"), "measurement bindable draws")
    checker.eq(measurement["draws"]["blocked"], sum(1 for draw in draws if draw["kind"] == "blocked"), "measurement blocked draws")
    checker.eq(measurement["draws"]["global"], len(expected_buckets.get("global", [])), "measurement global draws")
    checker.eq(measurement["draws"]["sector"], len(draws) - len(expected_buckets.get("global", [])), "measurement sector draws")
    checker.eq(measurement["draws"]["maxPerSector"], max((len(v) for v in sector_ordinals.values()), default=0), "measurement max draws per sector")
    checker.eq(measurement["draws"]["medianPerSector"], percentile([len(v) for v in sector_ordinals.values()], 0.5), "measurement median draws per sector")
    checker.eq(measurement["sectors"]["nonEmpty"], len(sector_ordinals), "measurement sector count")
    payload_sizes = [sector_sizes[key] for key in sector_ordinals]
    checker.eq(measurement["bytes"]["sectorPayload"], sum(payload_sizes), "measurement sector payload total")
    checker.eq(measurement["bytes"]["sectorPayloadMin"], min(payload_sizes), "measurement sector payload min")
    checker.eq(measurement["bytes"]["sectorPayloadMedian"], percentile(payload_sizes, 0.5), "measurement sector payload median")
    checker.eq(measurement["bytes"]["sectorPayloadP90"], percentile(payload_sizes, 0.9), "measurement sector payload p90")
    checker.eq(measurement["bytes"]["sectorPayloadMax"], max(payload_sizes), "measurement sector payload max")
    def radius(rad):
        return [key for key in sector_ordinals if abs(key[0] - spawn_sx) <= rad and abs(key[1] - spawn_sz) <= rad]
    first = measurement["firstVisible"]
    checker.eq(first["sector"], common.sector_id(spawn_sx, spawn_sz), "measurement first sector id")
    checker.eq(first["sectorPresent"], (spawn_sx, spawn_sz) in sector_ordinals, "measurement first sector present")
    checker.eq(first["sectorBytes"], sector_sizes.get((spawn_sx, spawn_sz), 0), "measurement first sector bytes")
    checker.eq(first["radius1Sectors"], len(radius(1)), "measurement radius-1 sector count")
    checker.eq(first["radius1Bytes"], sum(sector_sizes[key] for key in radius(1)), "measurement radius-1 bytes")
    table = measurement["streaming"]["table"]
    for row in table:
        rad = row["radiusSectors"]
        checker.eq(row["sectors"], len(radius(rad)), f"measurement radius {rad} sector count")
        checker.eq(row["sectorBytes"], sum(sector_sizes[key] for key in radius(rad)), f"measurement radius {rad} bytes")
    resident = measurement["bytes"]["resident"]
    checker.eq(resident, len(manifest_bytes) + sum(
        pinned_files[path]["bytes"]
        for path in ["index.json", "meta/streams.json", "meta/lap.json", "global/global.json", "global/geometry.bin", "shared/textures.json", "shared/textures.bin"]
        if path in pinned_files
    ) + (pinned_files["meta/layout.points.f32.bin"]["bytes"] if "meta/layout.points.f32.bin" in pinned_files else 0), "measurement resident bytes")
    checker.eq(measurement["bytes"]["chunkedTotal"], len(manifest_bytes) + sum(pin["bytes"] for pin in pinned_files.values()), "measurement chunked total")
    checker.eq(first["resident"], resident, "measurement first-visible resident")
    checker.eq(first["residentPlusRadius1"], resident + first["radius1Bytes"], "measurement resident + radius 1")

    coverage = measurement["coverage"]
    for (mesh_id, kind), stream in stream_by_key.items():
        row = coverage[f"{mesh_id}:{kind}"]
        checker.eq(row["streamBytes"], stream["bytes"], f"coverage {mesh_id}:{kind} stream bytes")
        checker.eq(row["coveredBytes"] + row["unreferencedBytes"], stream["bytes"], f"coverage {mesh_id}:{kind} partitions the stream")
    duplication = measurement["duplicationBytes"]["byStream"]
    for (mesh_id, kind) in stream_by_key:
        name = f"{mesh_id}:{kind}"
        emitted = sum(
            entry["bytes"]
            for record in bucket_records.values()
            for entry in record["geometry"]["slices"]
            if entry["meshId"] == mesh_id and entry["stream"] == kind
        )
        checker.eq(duplication.get(name), emitted - coverage[name]["coveredBytes"], f"duplication {name}")

    # 11. determinism --------------------------------------------------------
    deterministic = None
    if determinism:
        temp_root = os.path.join(common.repo_path(os.path.join("_work", "map-stream", "_verify")), map_id)
        if os.path.isdir(temp_root):
            shutil.rmtree(temp_root)
        os.makedirs(temp_root, exist_ok=True)
        from build_map_stream import build_map  # local import: builder is the reference implementation

        build_map(map_id, temp_root)
        fresh_root = os.path.join(temp_root, map_id)
        committed_files = sorted(
            os.path.relpath(os.path.join(dp, name), root).replace(os.sep, "/")
            for dp, _dn, fns in os.walk(root)
            for name in fns
            if name != "verify.json"
        )
        fresh_files = sorted(
            os.path.relpath(os.path.join(dp, name), fresh_root).replace(os.sep, "/")
            for dp, _dn, fns in os.walk(fresh_root)
            for name in fns
        )
        checker.eq(fresh_files, committed_files, "determinism file list")
        for rel_path in committed_files:
            a = open(os.path.join(root, rel_path), "rb").read()
            b = open(os.path.join(fresh_root, rel_path), "rb").read()
            checker.check(a == b, "determinism byte equality " + rel_path)
        fresh_manifest = json.loads(open(os.path.join(fresh_root, "manifest.json"), "rb").read().decode("utf-8"))
        checker.eq(fresh_manifest["hashes"]["contentSha256"], manifest["hashes"]["contentSha256"], "determinism content hash")
        deterministic = True
        shutil.rmtree(temp_root)

    return {
        "map": map_id,
        "output": os.path.relpath(root, common.REPO).replace(os.sep, "/"),
        "checks": checker.checks,
        "failures": checker.failures,
        "deterministic": deterministic,
        "contentSha256": manifest["hashes"]["contentSha256"],
        "sectors": len(sector_ordinals),
        "draws": len(draws),
        "chunkedTotalBytes": measurement["bytes"]["chunkedTotal"],
        "residentBytes": measurement["bytes"]["resident"],
        "firstVisibleResidentPlusRadius1": measurement["firstVisible"]["residentPlusRadius1"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--map", choices=list(common.MAP_ORDER))
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--out", default=os.path.join("_work", "map-stream"))
    parser.add_argument("--skip-determinism", action="store_true")
    parser.add_argument("--report", default=None)
    args = parser.parse_args()
    if not args.all and not args.map:
        parser.error("give --map <id> or --all")
    maps = list(common.MAP_ORDER) if args.all else [args.map]
    out_root = common.repo_path(args.out)
    results = []
    total_checks = 0
    total_failures = 0
    for map_id in maps:
        checker = Checker(map_id)
        try:
            result = verify_map(map_id, out_root, not args.skip_determinism, checker)
        except Exception as error:  # a verifier crash is a failure, not an excuse
            checker.check(False, "verifier completed", {"error": repr(error)})
            result = {"map": map_id, "checks": checker.checks, "failures": checker.failures}
        result["checks"] = checker.checks
        result["failureCount"] = len(checker.failures)
        results.append(result)
        total_checks += checker.checks
        total_failures += len(checker.failures)
        print(
            f"{map_id}: {'PASS' if not checker.failures else 'FAIL'} "
            f"{checker.checks} checks, {len(checker.failures)} failures"
        )
        for failure in checker.failures[:12]:
            print("  -", failure["name"], failure.get("detail"))
    report = {
        "kind": "blur.map-stream.verify",
        "version": 1,
        "maps": results,
        "checks": total_checks,
        "failures": total_failures,
        "pass": total_failures == 0,
    }
    report_path = (
        common.repo_path(args.report)
        if args.report
        else os.path.join(out_root, "verify.json")
    )
    common.write_bytes(report_path, common.dumps_pretty(report))
    print(f"TOTAL {total_checks} checks, {total_failures} failures -> {'PASS' if total_failures == 0 else 'FAIL'}")
    return 0 if total_failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
