"""Shared primitives for the map-stream chunk producer / verifier.

The chunk layer never re-derives level data.  It reads the committed map
packages, partitions their binary payload by a fixed XZ sector grid, and pins
every byte it emits.  Everything here is deterministic: no timestamps, no
random ids, no absolute paths in the output.
"""

from __future__ import annotations

import base64
import json
import math
import os
import struct
from array import array

# --- fixed format constants -------------------------------------------------

CHUNK_KIND = "blur.map-stream"
SCHEMA = "blur.map-stream/1"
VERSION = 1

#: Fixed sector edge in metres.  Chosen from the measured draw AABBs:
#: median max-extent 62-83 m, p75 136-175 m, p90 226-274 m.  128 m is roughly
#: twice the median draw extent, so the median draw fits inside one sector.
SECTOR_SIZE = 128.0

#: A draw whose XZ AABB spans more than this on either axis is not localised.
#: 384 m = 3 sectors = the footprint of a sector plus its radius-1 neighbours,
#: so a localised draw is fully covered by the radius-1 resident set.
GLOBAL_SPAN = 384.0

STREAM_KINDS = ("positions", "uv0", "indices")
STREAM_STRIDE = {"positions": 12, "uv0": 8, "indices": 4}
STREAM_DTYPE = {"positions": "float32", "uv0": "float32", "indices": "uint32"}
STREAM_COMPONENTS = {"positions": 3, "uv0": 2, "indices": 1}

MAP_ORDER = ("amboy", "gracia", "longbeach", "river")

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def repo_path(rel: str) -> str:
    rel = rel.replace("/", os.sep)
    return rel if os.path.isabs(rel) else os.path.join(REPO, rel)


# --- hashing / json ---------------------------------------------------------


def sha256_hex(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def sha256_tag(data: bytes) -> str:
    return "sha256:" + sha256_hex(data)


def norm_pin(value: str) -> str:
    """Accept both `ab12..` and `sha256:ab12..` pin spellings."""
    if value is None:
        return None
    return value if value.startswith("sha256:") else "sha256:" + value


def canonical_json(value) -> bytes:
    """Canonical body used for content hashes (sorted keys, no whitespace)."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False
    ).encode("utf-8")


def content_hash(value) -> str:
    return sha256_tag(canonical_json(value))


def dumps_pretty(value) -> bytes:
    return (
        json.dumps(value, sort_keys=True, indent=1, ensure_ascii=True, allow_nan=False) + "\n"
    ).encode("utf-8")


def write_bytes(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)


def write_json(path: str, value) -> None:
    write_bytes(path, dumps_pretty(value))


def read_bytes(rel: str) -> bytes:
    with open(repo_path(rel), "rb") as handle:
        return handle.read()


def read_json(rel: str):
    with open(repo_path(rel), "r", encoding="utf-8") as handle:
        return json.load(handle)


def pin_of(data: bytes) -> dict:
    return {"bytes": len(data), "sha256": sha256_tag(data)}


def file_pin(rel: str) -> dict:
    data = read_bytes(rel)
    return {"path": rel, **pin_of(data)}


def rel_output(root: str, path: str) -> str:
    return os.path.relpath(path, root).replace(os.sep, "/")


# --- map sources ------------------------------------------------------------

#: Committed package each map is chunked from, plus the always-global inputs
#: (physics, lap data) that the contract keeps outside the sector stream.
MAP_SOURCES = {
    "amboy": {
        "level": "usa_amboy",
        "label": "Amboy",
        "kind": "render-package",
        "dir": "_work/map-slice/amboy-render",
        "meshId": "amboy.direct",
        "renderLabel": "amboy-direct-draws",
        "spawn": {"x": 230.0, "z": 1128.0, "headingRad": -2.35619449},
        "physics": {
            "path": "game-data/Blur/levels/usa_amboy/Level.levelphysics",
            "bytes": 4442528,
            "sha256": "sha256:18c73e1cca6f13c5bbd4937454f25ec3163a67553fea6842a7797400af2175f2",
            "level": "usa_amboy",
            "collisionTriangles": 63708,
        },
        "lap": {
            "path": "_work/e1-drive/amboy/layout.json",
            "kind": "e1-drive.sprint",
            "gates": True,
        },
        "servedSingleFile": {
            "path": "_work/e1-drive/amboy/map.json",
            "sha256": "sha256:52acd10348ab1e747461eae3f5ec9854de1300910096dc50bc8ab7f06850e01a",
        },
    },
    "gracia": {
        "level": "spa_barcelona_gracia",
        "label": "Gracia",
        "kind": "render-package",
        "dir": "_work/map-slice/gracia-render",
        "meshId": "gracia.direct",
        "renderLabel": "gracia-direct-draws",
        "spawn": {"x": 336.0, "z": -23.0, "headingRad": 2.15879893},
        "physics": {
            "path": "game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics",
            "bytes": 5569121,
            "sha256": "sha256:acfb58a20ff7adced0b2424dc39474509e6b4c4c805729fd9463bdd310a173c0",
            "level": "spa_barcelona_gracia",
            "collisionTriangles": 113270,
        },
        "lap": {
            "path": "_work/e1-drive/gracia/layout.json",
            "kind": "e1-drive.sprint",
            "gates": True,
        },
        "servedSingleFile": {
            "path": "_work/e1-drive/gracia/map.json",
            "sha256": "sha256:562b56889b80d3368d5a1f08f009d6f351b6d3de33b3539df51c666a737a6a0d",
        },
    },
    "longbeach": {
        "level": "usa_la_longbeachdocks",
        "label": "Longbeach",
        "kind": "render-package",
        "dir": "_work/map-slice/longbeach-render",
        "meshId": "longbeach.direct",
        "renderLabel": "longbeach-direct-draws",
        "spawn": {"x": -519.0, "z": 111.0, "headingRad": -2.35619449},
        "physics": {
            "path": "game-data/Blur/levels/usa_la_longbeachdocks/Level.levelphysics",
            "bytes": 2214990,
            "sha256": "sha256:ce22c1cadbcff96074ff4d84741137162d2fe0697a5c354053e181944d6cca0d",
            "level": "usa_la_longbeachdocks",
            "collisionTriangles": 25183,
        },
        "lap": {
            "path": None,
            "kind": None,
            "gates": False,
            "reason": "no committed e1-drive sprint layout for usa_la_longbeachdocks (the map is not in web/map-registry.js)",
        },
        "servedSingleFile": None,
    },
    "river": {
        "level": "usa_la_river",
        "label": "River",
        "kind": "geometry-document",
        "dir": None,
        "document": "_work/e1-drive/level.geometry.json",
        "meshId": None,
        "renderLabel": "asset-reader-direct-draws",
        "spawn": {"x": -88.0, "z": 1050.0, "headingRad": 1.5707963267948966},
        "physics": {
            "path": "_work/e1-drive/Level.levelphysics",
            "bytes": 1945409,
            "sha256": "sha256:1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28",
            "level": "usa_la_river",
            "collisionTriangles": None,
        },
        "lap": {
            "path": "_work/e1-drive/course.json",
            "kind": "e1-drive.course",
            "gates": True,
        },
        "servedSingleFile": {
            "path": "_work/e1-drive/level.geometry.json",
            "sha256": "sha256:838d33408c23f2d8a9c3911cc92a9a4b3fcc3b5eeb53276c59db09efcf88483d",
        },
    },
}


# --- source loading ---------------------------------------------------------


def _stream_entry(kind: str, data: bytes, count: int) -> dict:
    return {
        "kind": kind,
        "dtype": STREAM_DTYPE[kind],
        "components": STREAM_COMPONENTS[kind],
        "stride": STREAM_STRIDE[kind],
        "count": count,
        "bytes": len(data),
        "sha256": sha256_tag(data),
    }


def vertex_span_index(indices: bytes, first_index: int, index_count: int) -> tuple:
    """Inclusive first/last vertex referenced by one draw's index range."""
    start = first_index * 4
    end = (first_index + index_count) * 4
    chunk = indices[start:end]
    values = array("I")
    values.frombytes(chunk)
    if not values:
        raise ValueError("draw has an empty index range")
    return min(values), max(values)


def aabb_from_positions(positions: bytes, lo: int, hi: int, stride: int = 12) -> dict:
    floats = memoryview(positions).cast("f")
    xs = floats[lo * 3 : hi * 3 + 3 : 3]
    ys = floats[lo * 3 + 1 : hi * 3 + 3 : 3]
    zs = floats[lo * 3 + 2 : hi * 3 + 3 : 3]
    return {
        "minX": round(min(xs), 6),
        "minY": round(min(ys), 6),
        "minZ": round(min(zs), 6),
        "maxX": round(max(xs), 6),
        "maxY": round(max(ys), 6),
        "maxZ": round(max(zs), 6),
    }


def make_draw(
    ordinal: int,
    draw_id: str,
    kind: str,
    mesh_id: str,
    first_index: int,
    index_count: int,
    indices: bytes,
    positions: bytes,
    texture_id,
    texture_slot,
    triangle_count,
    source: dict,
    declared_vertex=(None, None),
) -> dict:
    lo, hi = vertex_span_index(indices, first_index, index_count)
    record = {
        "ordinal": ordinal,
        "drawId": draw_id,
        "kind": kind,
        "meshId": mesh_id,
        "firstIndex": first_index,
        "indexCount": index_count,
        "firstVertex": lo,
        "vertexCount": hi - lo + 1,
        "vertexRangeSource": "min-max of referenced indices",
        "triangleCount": triangle_count,
        "textureId": texture_id,
        "textureSlot": texture_slot,
        "bounds": aabb_from_positions(positions, lo, hi),
        "source": source,
    }
    if declared_vertex[0] is not None:
        record["declaredVertexOffset"] = declared_vertex[0]
        record["declaredVertexCount"] = declared_vertex[1]
    return record


def load_render_package(spec: dict) -> dict:
    rel_dir = spec["dir"]
    render_bytes = read_bytes(rel_dir + "/render.json")
    diag_bytes = read_bytes(rel_dir + "/diagnostics.json")
    render = json.loads(render_bytes.decode("utf-8"))
    diag = json.loads(diag_bytes.decode("utf-8"))
    if render.get("kind") != "map-slice-render-package":
        raise ValueError("unexpected render package kind for " + spec["id"])

    mesh_id = spec["meshId"]
    streams = {}
    for kind in STREAM_KINDS:
        entry = render["buffers"][kind]
        data = read_bytes(rel_dir + "/" + entry["path"])
        if len(data) != entry["bytes"]:
            raise ValueError(f"{spec['id']} {kind} bytes mismatch")
        if sha256_tag(data) != norm_pin(entry["sha256"]):
            raise ValueError(f"{spec['id']} {kind} sha mismatch")
        streams[(mesh_id, kind)] = {
            "data": data,
            **_stream_entry(kind, data, entry["count"]),
        }

    index_stream = streams[(mesh_id, "indices")]["data"]
    pos_stream = streams[(mesh_id, "positions")]["data"]

    draws = []
    ordinal = 0
    for position, draw in enumerate(render["draws"]):
        draws.append(
            make_draw(
                ordinal,
                draw["drawId"],
                "bindable",
                mesh_id,
                draw["firstIndex"],
                draw["indexCount"],
                index_stream,
                pos_stream,
                draw.get("textureId"),
                draw.get("textureSlot"),
                draw.get("triangleCount"),
                {"file": "render.json", "index": position, "status": draw.get("status")},
            )
        )
        ordinal += 1
    for position, draw in enumerate(diag["draws"]):
        draws.append(
            make_draw(
                ordinal,
                draw["drawId"],
                "blocked",
                mesh_id,
                draw["firstIndex"],
                draw["indexCount"],
                index_stream,
                pos_stream,
                draw.get("textureId"),
                None,
                draw.get("triangleCount"),
                {
                    "file": "diagnostics.json",
                    "index": position,
                    "status": draw.get("status"),
                    "blocker": (draw.get("diagnostic") or {}).get("blocker"),
                },
            )
        )
        ordinal += 1

    textures = []
    for item in render["textures"]["items"]:
        data = read_bytes(rel_dir + "/" + item["file"])
        if len(data) != item["bytes"]:
            raise ValueError(f"{spec['id']} texture {item['file']} bytes mismatch")
        if sha256_tag(data) != norm_pin(item["sha256"]):
            raise ValueError(f"{spec['id']} texture {item['file']} sha mismatch")
        textures.append(
            {
                "slot": item["slot"],
                "id": item["primaryId"],
                "sourceIds": item.get("sourceIds") or [item["primaryId"]],
                "file": item["file"],
                "bytes": item["bytes"],
                "sha256": norm_pin(item["sha256"]),
                "width": item["width"],
                "height": item["height"],
                "format": item.get("format"),
                "formatName": item.get("formatName"),
                "uploadFormat": (item.get("upload") or {}).get("format", "rgba8unorm"),
                "data": data,
            }
        )

    layout = render["layout"]
    points_rel = rel_dir + "/" + layout["pointsFile"]
    points_bytes = read_bytes(points_rel)
    if len(points_bytes) != layout["pointsBytes"]:
        raise ValueError("layout points bytes mismatch")
    if sha256_tag(points_bytes) != norm_pin(layout["pointsSha256"]):
        raise ValueError("layout points sha mismatch")

    return {
        "id": spec["id"],
        "level": spec["level"],
        "label": spec["label"],
        "kind": spec["kind"],
        "dir": rel_dir,
        "renderLabel": spec["renderLabel"],
        "streams": streams,
        "draws": draws,
        "textures": textures,
        "layout": {
            "source": "render.json#layout",
            "mode": layout.get("mode"),
            "direction": layout.get("direction"),
            "spawn": layout.get("spawn"),
            "checkpoints": layout.get("checkpoints"),
            "finish": layout.get("finish"),
            "lengthM": layout.get("lengthM"),
            "pointCount": layout.get("pointCount"),
            "sampleStepM": layout.get("sampleStepM"),
            "pointsFloat32": layout.get("pointsFloat32"),
            "points": {
                "file": "meta/layout.points.f32.bin",
                **pin_of(points_bytes),
            },
        },
        "points_bytes": points_bytes,
        "source": {
            "kind": "map-slice-render-package",
            "dir": rel_dir,
            "render": {"file": "render.json", **pin_of(render_bytes)},
            "diagnostics": {"file": "diagnostics.json", **pin_of(diag_bytes)},
            "renderContentHash": norm_pin(render["hashes"]["contentSha256"]),
            "counts": render.get("counts", {}),
            "renderLabel": render.get("kind"),
        },
    }


def _decode_document_mesh(mesh: dict) -> dict:
    positions = mesh["positions"]
    if isinstance(positions, str):
        positions = json.loads(positions)
    indices = mesh["indices"]
    if isinstance(indices, str):
        indices = json.loads(indices)
    uv = mesh["uv"]
    if isinstance(uv, str):
        uv = json.loads(uv)
    uv_bytes = base64.b64decode(uv["data"])
    pos_bytes = array("f", positions).tobytes()
    idx_bytes = array("I", indices).tobytes()
    for name, data, pin in (
        ("positions", pos_bytes, mesh["positionsSha256"]),
        ("indices", idx_bytes, mesh["indicesSha256"]),
        ("uv0", uv_bytes, uv["sha256"]),
    ):
        if sha256_tag(data) != norm_pin(pin):
            raise ValueError(f"river {mesh['id']} {name} decode does not match its pin")
    counts = {"positions": len(pos_bytes) // 12, "uv0": len(uv_bytes) // 8, "indices": len(idx_bytes) // 4}
    return {"positions": pos_bytes, "uv0": uv_bytes, "indices": idx_bytes, "counts": counts}


def load_geometry_document(spec: dict) -> dict:
    doc_bytes = read_bytes(spec["document"])
    doc = json.loads(doc_bytes.decode("utf-8"))
    if doc.get("kind") != "e1-drive.geometry":
        raise ValueError("unexpected geometry document kind")

    streams = {}
    mesh_ids = []
    mesh_stream_meta = {}
    for mesh in doc["meshes"]:
        mesh_id = mesh["id"]
        mesh_ids.append(mesh_id)
        decoded = _decode_document_mesh(mesh)
        for kind in STREAM_KINDS:
            streams[(mesh_id, kind)] = {
                "data": decoded[kind],
                **_stream_entry(kind, decoded[kind], decoded["counts"][kind]),
            }
        mesh_stream_meta[mesh_id] = {
            "vertexCount": decoded["counts"]["positions"],
            "indexCount": decoded["counts"]["indices"],
            "storage": mesh.get("storage"),
            "coordinateSpace": mesh.get("coordinateSpace"),
        }

    # texture order is the document order: levelTextures then textures.  The
    # document has no slot field, so the slot is the position in that order.
    texture_records = []
    slot = 0
    for group in ("levelTextures", "textures"):
        for item in doc.get(group) or []:
            data = base64.b64decode(item["rgbaBase64"])
            if len(data) != item["rgbaBytes"]:
                raise ValueError(f"river texture {item['id']} bytes mismatch")
            if sha256_tag(data) != norm_pin(item["rgbaSha256"]):
                raise ValueError(f"river texture {item['id']} sha mismatch")
            texture_records.append(
                {
                    "slot": slot,
                    "id": item["id"],
                    "sourceIds": [item["id"]],
                    "file": f"textures/tex-{slot:03d}.rgba",
                    "bytes": item["rgbaBytes"],
                    "sha256": norm_pin(item["rgbaSha256"]),
                    "width": item["width"],
                    "height": item["height"],
                    "format": item.get("format"),
                    "formatName": item.get("formatName"),
                    "uploadFormat": "rgba8unorm",
                    "documentGroup": group,
                    "data": data,
                }
            )
            slot += 1
    by_id = {tex["id"]: tex["slot"] for tex in texture_records}

    draws = []
    ordinal = 0
    for draw in doc["levelDraws"]:
        mesh_id = draw["meshId"]
        index_stream = streams[(mesh_id, "indices")]["data"]
        pos_stream = streams[(mesh_id, "positions")]["data"]
        draws.append(
            make_draw(
                ordinal,
                draw["id"],
                "bindable",
                mesh_id,
                draw["indexOffset"],
                draw["indexCount"],
                index_stream,
                pos_stream,
                draw.get("textureId"),
                by_id.get(draw.get("textureId")),
                draw["indexCount"] // 3,
                {"file": "level.geometry.json", "group": "levelDraws", "index": ordinal},
                declared_vertex=(draw.get("vertexOffset"), draw.get("vertexCount")),
            )
        )
        ordinal += 1
    for position, draw in enumerate(doc["trackVisual"]["draws"]):
        mesh_id = draw["meshId"]
        index_stream = streams[(mesh_id, "indices")]["data"]
        pos_stream = streams[(mesh_id, "positions")]["data"]
        draws.append(
            make_draw(
                ordinal,
                draw["id"],
                "bindable",
                mesh_id,
                draw["indexOffset"],
                draw["indexCount"],
                index_stream,
                pos_stream,
                draw.get("textureId"),
                by_id.get(draw.get("textureId")),
                draw["indexCount"] // 3,
                {"file": "level.geometry.json", "group": "trackVisual.draws", "index": position},
                declared_vertex=(draw.get("vertexOffset"), draw.get("vertexCount")),
            )
        )
        ordinal += 1

    return {
        "id": spec["id"],
        "level": spec["level"],
        "label": spec["label"],
        "kind": spec["kind"],
        "dir": None,
        "document": spec["document"],
        "renderLabel": spec["renderLabel"],
        "streams": streams,
        "draws": draws,
        "textures": texture_records,
        "layout": {
            "source": "level.geometry.json",
            "mode": "point-to-point",
            "note": "River has no layout.points file in the geometry document; the committed lap data is _work/e1-drive/course.json (global, pinned)",
            "spawn": spec["spawn"],
            "points": None,
        },
        "points_bytes": None,
        "meshStreamMeta": mesh_stream_meta,
        "source": {
            "kind": "e1-drive-geometry-document",
            "document": {"file": spec["document"], **pin_of(doc_bytes)},
            "meshIds": mesh_ids,
            "counts": {
                "draws": len(draws),
                "levelDraws": len(doc["levelDraws"]),
                "trackDraws": len(doc["trackVisual"]["draws"]),
            },
        },
    }


def load_source(map_id: str) -> dict:
    spec = dict(MAP_SOURCES[map_id])
    spec["id"] = map_id
    if spec["kind"] == "render-package":
        return load_render_package(spec)
    return load_geometry_document(spec)


# --- sector grid ------------------------------------------------------------


def grid_origin(draws) -> tuple:
    min_x = min(draw["bounds"]["minX"] for draw in draws)
    min_z = min(draw["bounds"]["minZ"] for draw in draws)
    return (
        math.floor(min_x / SECTOR_SIZE) * SECTOR_SIZE,
        math.floor(min_z / SECTOR_SIZE) * SECTOR_SIZE,
    )


def draw_bucket(draw: dict, origin: tuple) -> object:
    bounds = draw["bounds"]
    if (bounds["maxX"] - bounds["minX"]) > GLOBAL_SPAN or (
        bounds["maxZ"] - bounds["minZ"]
    ) > GLOBAL_SPAN:
        return "global"
    cx = (bounds["minX"] + bounds["maxX"]) / 2.0
    cz = (bounds["minZ"] + bounds["maxZ"]) / 2.0
    sx = int(math.floor((cx - origin[0]) / SECTOR_SIZE))
    sz = int(math.floor((cz - origin[1]) / SECTOR_SIZE))
    return (sx, sz)


def sector_id(sx: int, sz: int) -> str:
    return f"x{sx:03d}_z{sz:03d}"


def sector_bounds(sx: int, sz: int, origin: tuple) -> dict:
    x0 = origin[0] + sx * SECTOR_SIZE
    z0 = origin[1] + sz * SECTOR_SIZE
    return {
        "minX": x0,
        "maxX": x0 + SECTOR_SIZE,
        "minZ": z0,
        "maxZ": z0 + SECTOR_SIZE,
    }


def assign_draws(draws) -> tuple:
    """Return (origin, buckets) where buckets maps bucket-key -> list of draws."""
    origin = grid_origin(draws)
    buckets = {}
    for draw in draws:
        key = draw_bucket(draw, origin)
        buckets.setdefault(key, []).append(draw)
    return origin, buckets


def stream_slice_range(draw: dict, kind: str) -> tuple:
    if kind == "indices":
        start = draw["firstIndex"] * 4
        return start, start + draw["indexCount"] * 4
    stride = STREAM_STRIDE[kind]
    start = draw["firstVertex"] * stride
    return start, start + draw["vertexCount"] * stride


def merge_ranges(ranges) -> list:
    merged = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged
