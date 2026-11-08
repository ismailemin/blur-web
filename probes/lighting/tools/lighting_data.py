#!/usr/bin/env python3
"""Read-only recovery of the retail Blur lighting setup from shipped data.

This module reads, and never writes, three independent retail sources:

1. ``Level.levelrender``  -- the ``Lights`` block (``C_LightList::Read``) and the
   ``LS`` block (``C_LightSamplePoints::Read``), plus the Scene vertex
   declarations that prove whether normals are serialized.
2. ``Level.levelstream``  -- only to sample real vertex-buffer bytes for the
   normals proof (the header/declaration comes from ``levelrender``).
3. ``cache/gamedata.pak`` -- the ``\\gamedata\\xt\\amax.bin`` FLSK pack holding the
   per-city ``EnvironmentSettings`` record (``AmaxCity.environmentSettings``).

Nothing here guesses a value. Every returned field records where it came from
(byte offset in the original file, or the upstream source file/line for the
code-only constants). Unsupported shapes raise instead of falling back.

Upstream citations (read-only reference checkout, ``upstream/BlurRebuilt``):

  code/mercury/library/graphics/world_render/source/LightList.cpp:38-98
      C_LightList::Read / GetSunDirection -> sun direction is matrix row Z
  code/mercury/library/graphics/world_render/include/world_render/LightList.h:15-56
      E_LightType order and C_Light layout (type, HMat43, HVec4, radius)
  code/mercury/library/graphics/world_render/source/LightSamplePoints.cpp:139-258
      LS block children and the F16 compressed sample record
  code/mercury/library/graphics/shader/include/shader/common/Lighting.h:152-165
      diffuse term order (baked + sky + sun) * albedo * intensity
  code/mercury/library/graphics/shader/include/shader/common/Fog.h:68-99
      depth/height fog
  code/mercury/library/graphics/renderingdata/include/renderingdata/datatypes.h:17-38
      VertexElementType order (11 = U8_4N)
  code/mercury/library/graphics/renderingdata/include/renderingdata/vertexbuffer.h:22-36
      VertexElementUsage order (3 = NORMAL, 9 = COLOR)
  code/mercury/library/graphics/shader/include/shader/common/Transform.h:26-43
      PC normal decode: input * 2 - 1
"""
from __future__ import annotations

import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GAME = ROOT / "game-data/Blur"
LEVELS_DIR = GAME / "levels"

# ---------------------------------------------------------------------------
# level table: retail package, short name, and the measured spawn used for the
# ambient probe. The spawn is not a retail start line: it is the first station
# of the measured draw-covered centre line committed by the map-slice probe.
SPAWN_TABLE = {
    "usa_la_river": {
        "short": "river",
        "city": "USA_LA_River",
        "spawn": (-88.0, 6.0, 1050.0),
        "spawnSource": "_work/map-slice/*-render/render.json layout.spawn (River uses the P48 corridor start -88 / 1050, ground 5.8074)",
    },
    "usa_amboy": {
        "short": "amboy",
        "city": "USA_Amboy",
        "spawn": (230.0, -0.0942, 1128.0),
        "spawnSource": "_work/map-slice/amboy-render/render.json layout.spawn",
    },
    "spa_barcelona_gracia": {
        "short": "gracia",
        "city": "SPA_Barcelona_Gracia",
        "spawn": (336.0, 129.9989, -23.0),
        "spawnSource": "_work/map-slice/gracia-render/render.json layout.spawn",
    },
    "usa_la_longbeachdocks": {
        "short": "longbeach",
        "city": "USA_LA_LongBeachDocks",
        "spawn": (-519.0, -0.098, 111.0),
        "spawnSource": "_work/map-slice/longbeach-render/render.json layout.spawn",
    },
    # The seven remaining playable maps. ``layout.json`` stores the horizontal
    # spawn as ``course.spawn.x`` / ``course.spawn.z`` and the ground height as
    # ``course.spawnGroundY`` (also ``course.start.groundY``); the tuple below is
    # (x, spawnGroundY, z). The committed source of the _work copy is the
    # map-laps path file named in each spawnSource.
    "usa_la_observatory": {
        "short": "observatory",
        "city": "USA_LA_Observatory",
        "spawn": (226.0, 21.2531, 373.0),
        "spawnSource": "_work/e1-drive/observatory/layout.json course.spawn.x=226, "
                       "course.spawn.z=373, course.spawnGroundY=21.2531 "
                       "(course.start.groundY); committed source "
                       "probes/map-laps/data/observatory-path.json",
    },
    "usa_la_downtown": {
        "short": "downtown",
        "city": "USA_LA_Downtown",
        "spawn": (715.0, 111.8145, 145.0),
        "spawnSource": "_work/e1-drive/downtown/layout.json course.spawn.x=715, "
                       "course.spawn.z=145, course.spawnGroundY=111.8145 "
                       "(course.start.groundY); committed source "
                       "probes/map-laps/data/downtown-path.json",
    },
    "jpn_mharuna": {
        "short": "mharuna",
        "city": "JPN_MHaruna",
        "spawn": (-2693.0, 1064.4312, -838.0),
        "spawnSource": "_work/e1-drive/mharuna/layout.json course.spawn.x=-2693, "
                       "course.spawn.z=-838, course.spawnGroundY=1064.4312 "
                       "(course.start.groundY); committed source "
                       "probes/map-laps/data/mharuna-path.json",
    },
    "usa_la_multiplayer_highrise": {
        "short": "highrise",
        "city": "USA_LA_Multiplayer_Highrise",
        "spawn": (202.0, 218.184, -267.0),
        "spawnSource": "_work/e1-drive/highrise/layout.json course.spawn.x=202, "
                       "course.spawn.z=-267, course.spawnGroundY=218.184 "
                       "(course.start.groundY); committed source "
                       "probes/map-laps/data/highrise-path.json",
    },
    "jpn_tokyo_shutoko": {
        "short": "shutoko",
        "city": "JPN_Tokyo_Shutoko",
        "spawn": (1168.0, -2.632, -134.0),
        "spawnSource": "_work/e1-drive/shutoko/layout.json course.spawn.x=1168, "
                       "course.spawn.z=-134, course.spawnGroundY=-2.632 "
                       "(course.start.groundY); committed source "
                       "probes/map-laps/data/shutoko-path.json",
    },
    "spa_barcelona_oval": {
        "short": "oval",
        "city": "SPA_Barcelona_Oval",
        "spawn": (-567.0, 0.1439, -522.0),
        "spawnSource": "_work/e1-drive/oval/layout.json course.spawn.x=-567, "
                       "course.spawn.z=-522, course.spawnGroundY=0.1439 "
                       "(course.start.groundY); committed source "
                       "probes/map-laps/data/oval-path.json",
    },
    "usa_amboy_multiplayer": {
        "short": "amboy-mp",
        "city": "USA_Amboy_Multiplayer",
        "spawn": (55.0, 1.7573, -5.0),
        "spawnSource": "_work/e1-drive/amboy-mp/layout.json course.spawn.x=55, "
                       "course.spawn.z=-5, course.spawnGroundY=1.7573 "
                       "(course.start.groundY); committed source "
                       "probes/map-laps/data/amboy-mp-path.json",
    },
}

LIGHT_TYPE_NAMES = {
    0: "none",
    1: "hemisphere",
    2: "area",
    3: "directional",
    4: "point",
    5: "spot",
}

# RenderingData::VertexElementType (datatypes.h:17-38).
VERTEX_TYPE_NAMES = {
    0: "S16_2", 1: "S16_4", 2: "S16_2N", 3: "S16_4N",
    4: "F32_1", 5: "F32_2", 6: "F32_3", 7: "F32_4",
    8: "F16_2", 9: "F16_4", 10: "U8_4", 11: "U8_4N",
    12: "SHHD_3N", 13: "SDDD_3N",
}

# RenderingData::VertexElementUsage (vertexbuffer.h:22-36).
VERTEX_USAGE_NAMES = {
    0: "position", 1: "blendweight", 2: "blendindices", 3: "normal",
    4: "psize", 5: "texcoord", 6: "tangent", 7: "binormal",
    8: "tessfactor", 9: "color", 10: "sample",
}

LIGHT_SAMPLE_MODEL_NAMES = {
    0: "RGBSH_SunSkyFactor",
    1: "SunSkySH",
    2: "RGBSH",
}


# ---------------------------------------------------------------------------
# binary helpers

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fnv1a64(data: bytes) -> str:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return "%016x" % value


def file_block(data: bytes, offset: int, end: int) -> dict:
    """One Sys::C_FileBlock header (16 bytes, little endian)."""
    if offset < 0 or offset + 16 > end:
        raise ValueError("truncated FileBlock at %d" % offset)
    name, size, count, kind, compression = struct.unpack_from("<8sIHBB", data, offset)
    if size < 16 or offset + size > end or compression:
        raise ValueError("unsupported FileBlock at %d" % offset)
    return {
        "id": name.split(b"\0", 1)[0].decode("ascii"),
        "offset": offset,
        "bytes": size,
        "count": count,
        "type": kind,
        "payload": offset + 16,
        "end": offset + size,
    }


def child_blocks(data: bytes, block: dict) -> list[dict]:
    if block["type"] != 0x43:
        raise ValueError("%s is not a container block" % block["id"])
    out = []
    at = block["payload"]
    while at < block["end"]:
        child = file_block(data, at, block["end"])
        out.append(child)
        at = child["end"]
        if len(out) > 64:
            raise ValueError("too many child blocks")
    if at != block["end"] or len(out) != block["count"]:
        raise ValueError("child count mismatch in %s" % block["id"])
    return out


def render_root(data: bytes) -> tuple[dict, list[dict]]:
    if data[:4] != b"  CP":
        raise ValueError("expected PC file marker")
    root = file_block(data, 4, len(data))
    if root["id"] != "Render":
        raise ValueError("missing Render root")
    if root["type"] == 0x43:
        chunks = child_blocks(data, root)
    else:
        chunks = []
        at = root["payload"]
        while at < root["end"]:
            child = file_block(data, at, root["end"])
            chunks.append(child)
            at = child["end"]
    return root, chunks


def half_to_float(bits: int) -> float:
    return struct.unpack("<e", struct.pack("<H", bits))[0]


# ---------------------------------------------------------------------------
# Lights block: C_LightList::Read (LightList.cpp:38-72)

def parse_lights(data: bytes, block: dict) -> dict:
    pl = block["payload"]
    end = block["end"]
    offset = [0]

    def take(fmt: str, size: int):
        at = pl + offset[0]
        if at + size > end:
            raise ValueError("Lights field past block end")
        value = struct.unpack_from(fmt, data, at)
        offset[0] += size
        return value

    def light(field: str) -> dict:
        start = offset[0]
        (light_type,) = take("<I", 4)
        matrix = take("<12f", 48)
        colour = take("<4f", 16)
        (radius,) = take("<f", 4)
        if light_type not in LIGHT_TYPE_NAMES:
            raise ValueError("unknown light type %d" % light_type)
        rows = [list(matrix[0:3]), list(matrix[3:6]), list(matrix[6:9]), list(matrix[9:12])]
        return {
            "field": field,
            "type": light_type,
            "typeName": LIGHT_TYPE_NAMES[light_type],
            "matrixRows": rows,
            "direction": rows[2],
            "colour": list(colour),
            "radius": radius,
            "offset": pl + start,
            "offsetInPayload": start,
        }

    (version,) = take("<i", 4)
    (has_sun,) = take("<I", 4)
    sun = light("SunLight") if has_sun else None
    (has_sky,) = take("<I", 4)
    sky = light("SkyLight") if has_sky else None

    nodes_start = offset[0]
    (node_count,) = take("<i", 4)
    if node_count < 0 or node_count > 100000:
        raise ValueError("implausible kd-tree node count")
    take("<%dI" % (node_count * 2), node_count * 8)
    (mailbox_count,) = take("<i", 4)
    if mailbox_count < 0 or mailbox_count > 100000:
        raise ValueError("implausible kd-tree mailbox count")
    take("<%dI" % mailbox_count, mailbox_count * 4)
    (primitive_count,) = take("<i", 4)
    if primitive_count < 0 or primitive_count > 10000:
        raise ValueError("implausible light primitive count")
    primitives = []
    for index in range(primitive_count):
        start = offset[0]
        (light_type,) = take("<I", 4)
        matrix = take("<12f", 48)
        colour = take("<4f", 16)
        (radius,) = take("<f", 4)
        if light_type not in LIGHT_TYPE_NAMES:
            raise ValueError("unknown point light type")
        rows = [list(matrix[0:3]), list(matrix[3:6]), list(matrix[6:9])]
        primitives.append({
            "index": index,
            "type": light_type,
            "typeName": LIGHT_TYPE_NAMES[light_type],
            "position": rows[3] if len(rows) > 3 else list(matrix[9:12]),
            "direction": rows[2],
            "colour": list(colour),
            "radius": radius,
            "offset": pl + start,
        })
    consumed = offset[0]
    if pl + consumed != end:
        raise ValueError("Lights block not fully consumed (%d of %d)" % (consumed, end - pl))

    counts: dict[str, int] = {}
    for primitive in primitives:
        counts[primitive["typeName"]] = counts.get(primitive["typeName"], 0) + 1

    return {
        "blockOffset": block["offset"],
        "blockBytes": block["bytes"],
        "payloadBytes": end - pl,
        "version": version,
        "hasSun": bool(has_sun),
        "hasSky": bool(has_sky),
        "sun": sun,
        "sky": sky,
        "kdTree": {
            "nodes": node_count,
            "mailboxes": mailbox_count,
            "primitives": primitive_count,
            "nodeTableOffset": pl + nodes_start,
        },
        "lights": primitives,
        "lightTypeCounts": counts,
        "consumedBytes": consumed,
    }


# ---------------------------------------------------------------------------
# LS block: C_LightSamplePoints::Read (LightSamplePoints.cpp:139-258)

def parse_light_samples(data: bytes, block: dict) -> dict:
    parts = {child["id"]: child for child in child_blocks(data, block)}
    if set(parts) != {"Header", "LSPoint", "LSData", "LSTree"}:
        raise ValueError("unexpected LS children %s" % sorted(parts))
    header = parts["Header"]
    version, model = struct.unpack_from("<iI", data, header["payload"])
    if model not in LIGHT_SAMPLE_MODEL_NAMES:
        raise ValueError("unsupported light sample model %d" % model)

    point_block = parts["LSPoint"]
    point_payload = point_block["payload"]
    (point_count,) = struct.unpack_from("<i", data, point_payload)
    point_bytes = point_block["end"] - point_payload
    if 4 + point_count * 10 != point_bytes:
        raise ValueError("LSPoint extent mismatch")
    points = []
    for index in range(point_count):
        at = point_payload + 4 + index * 10
        x, y, z, sample_index = struct.unpack_from("<HHHI", data, at)
        points.append({
            "index": index,
            "position": [half_to_float(x), half_to_float(y), half_to_float(z)],
            "sampleIndex": sample_index,
            "offset": at,
        })

    data_block = parts["LSData"]
    data_payload = data_block["payload"]
    (sample_count,) = struct.unpack_from("<i", data, data_payload)
    per_sample = 14 if model == 0 else 12
    record_bytes = per_sample * 2
    data_bytes = data_block["end"] - data_payload
    if 4 + sample_count * record_bytes != data_bytes:
        raise ValueError("LSData extent mismatch")
    samples = []
    for index in range(sample_count):
        at = data_payload + 4 + index * record_bytes
        halves = struct.unpack_from("<%dH" % per_sample, data, at)
        samples.append({
            "index": index,
            "halfBits": list(halves),
            "values": [half_to_float(h) for h in halves],
            "offset": at,
        })

    for point in points:
        if point["sampleIndex"] >= sample_count:
            raise ValueError("light sample index out of range")

    return {
        "blockOffset": block["offset"],
        "blockBytes": block["bytes"],
        "version": version,
        "model": model,
        "modelName": LIGHT_SAMPLE_MODEL_NAMES[model],
        "children": {name: {"offset": child["offset"], "bytes": child["bytes"]}
                     for name, child in parts.items()},
        "pointCount": point_count,
        "sampleCount": sample_count,
        "pointsOffset": point_payload,
        "samplesOffset": data_payload,
        "points": points,
        "samples": samples,
    }


def closest_point(ls: dict, position) -> dict:
    best = None
    best_d2 = None
    for point in ls["points"]:
        dx = point["position"][0] - position[0]
        dy = point["position"][1] - position[1]
        dz = point["position"][2] - position[2]
        d2 = dx * dx + dy * dy + dz * dz
        if best_d2 is None or d2 < best_d2:
            best_d2 = d2
            best = point
    if best is None:
        raise ValueError("no light sample points")
    return {"point": best, "distance": best_d2 ** 0.5}


def sh_up_normal(values: list[float]) -> list[float]:
    """Ambient for a +Y normal: dot(float4(normal, 1), coeffs) per channel.

    The basis is literally ``dot(float4(vWorldNormal, 1.0h), coeffs)``
    (shader/lighting/SphericalHarmonics.h), i.e. coefficient order (x, y, z, 1).
    """
    if len(values) < 12:
        raise ValueError("SH sample needs 12 coefficients")
    return [values[1] + values[3], values[5] + values[7], values[9] + values[11]]


# ---------------------------------------------------------------------------
# Scene vertex declarations: are normals serialized?

def _reader(data: bytes, at: int):
    """Minimal reader matching tools/inspect_car_level_assets.Reader usage."""
    class R:
        def __init__(self, p):
            self.p = p

        def take(self, n):
            v = data[self.p:self.p + n]
            if len(v) != n:
                raise ValueError("short read")
            self.p += n
            return v

        def unpack(self, fmt, **kw):
            n = struct.calcsize("<" + fmt)
            v = struct.unpack_from("<" + fmt, data, self.p)
            self.p += n
            return v

        def ar(self, size):
            v = data[self.p]
            if v > size:
                raise ValueError("archive version out of range")
            self.p += 1
            return v

        def count(self, limit):
            v = self.unpack("i")[0]
            if v < 0 or v > limit:
                raise ValueError("count out of range")
            return v

        def vec(self, limit=1000000):
            v = self.unpack("i")[0]
            if v < 0 or v > limit:
                raise ValueError("vector size out of range")
            return v

        def string(self):
            n = self.count(4096)
            return self.take(n).decode("latin-1")

        def cull(self):
            name = self.string()
            self.ar(1)
            self.bounds()
            self.bits()
            return {"name": name}

        def bounds(self):
            v = self.unpack("6f")
            return {"min": list(v[:3]), "max": list(v[3:])}

        def bits(self):
            n = self.count(4096)
            return self.take(n)

    return R(at)


def scene_declarations(data: bytes, scene_block: dict) -> list[list[dict]]:
    """Vertex declarations via the committed Scene reader.

    ``tools/inspect_car_level_assets.scene_header`` already validates the ARCH
    envelope, the 17-byte element layout and the shared-texture list. This
    function only adds the symbolic type/usage names (FORMAT-scene.md:19-20).
    """
    reader = _import_committed("inspect_car_level_assets", ROOT / "tools")
    scene = reader.scene_header(data, scene_block)
    declarations = []
    for declaration in scene["declarations"]:
        elements = []
        for element in declaration:
            elements.append({
                "stream": element["stream"],
                "offset": element["offset"],
                "type": element["type"],
                "typeName": VERTEX_TYPE_NAMES.get(element["type"], "unknown-%d" % element["type"]),
                "method": element["method"],
                "usage": element["usage"],
                "usageName": VERTEX_USAGE_NAMES.get(element["usage"], "unknown-%d" % element["usage"]),
                "usageIndex": element["usageIndex"],
            })
        declarations.append(elements)
    return declarations


def normal_element(declaration: list[dict]) -> dict | None:
    found = [e for e in declaration if e["usage"] == 3 and e["usageIndex"] == 0]
    if len(found) > 1:
        raise ValueError("multiple NORMAL0 elements in one declaration")
    return found[0] if found else None


def normal_byte_stats(raw: bytes, offset: int, stride: int, count: int, limit: int = 4096):
    """Decode U8_4N normals with the retail PC rule (Transform.h:29-30)."""
    lengths = []
    w_values = set()
    for vertex in range(min(count, limit)):
        at = vertex * stride + offset
        if at + 4 > len(raw):
            break
        x, y, z, w = raw[at], raw[at + 1], raw[at + 2], raw[at + 3]
        vx = x / 255.0 * 2.0 - 1.0
        vy = y / 255.0 * 2.0 - 1.0
        vz = z / 255.0 * 2.0 - 1.0
        lengths.append((vx * vx + vy * vy + vz * vz) ** 0.5)
        w_values.add(w)
    if not lengths:
        return None
    return {
        "decodedVertices": len(lengths),
        "minLength": min(lengths),
        "meanLength": sum(lengths) / len(lengths),
        "maxLength": max(lengths),
        "wValues": sorted(w_values)[:8],
    }


# ---------------------------------------------------------------------------
# Per-city EnvironmentSettings from the FLSK pack

def _import_committed(module: str, path: Path):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
    return __import__(module)


def load_city_environment(level: str) -> dict:
    """Decode ``AmaxCity.environmentSettings`` for one level from gamedata.pak.

    Reuses the committed PAK index (tools/inspect_asset_layout.py) and the
    committed FLSK record decoder (probes/powerups/tools/xt_decode.py). Both are
    read-only imports; no value is re-implemented here.
    """
    pak_index = _import_committed("inspect_asset_layout", ROOT / "tools").pak_index
    xt_decode = _import_committed("xt_decode", ROOT / "probes/powerups/tools")
    pak_path = GAME / "cache/gamedata.pak"
    index = pak_index(pak_path)
    if index.get("codec") != 2:
        raise ValueError("expected zlib gamedata.pak")
    entry = next(r for r in index["entries"]
                 if r["path"].lower() == "\\gamedata\\xt\\amax.bin")
    with pak_path.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    inflater = zlib.decompressobj()
    blob = inflater.decompress(packed, entry["logical_bytes"] + 1)
    if len(blob) != entry["logical_bytes"] or not inflater.eof:
        raise ValueError("amax.bin zlib extent mismatch")

    flask = xt_decode.Flask(blob)
    city_type = next(i for i in range(len(flask.types)) if flask.type_name(i) == "City")
    wanted = SPAWN_TABLE[level]["city"]
    found = None
    for record_index in range(len(flask.records)):
        if flask.record_type(record_index) != city_type:
            continue
        record = flask.decode_record(record_index)
        name = record.get("Name")
        name = name["value"] if isinstance(name, dict) else name
        if name == wanted:
            found = (record_index, record)
            break
    if found is None:
        raise ValueError("city %r not found in amax.bin" % wanted)
    record_index, record = found
    env = record["EnvironmentSettings"]
    lighting = env["lightingSettings"]["value"]
    info = lighting["lightingSettings"]

    def rgba(value):
        return [value["r"], value["g"], value["b"], value["a"]]

    fog = lighting["fogSettings"]
    sky = lighting["skySettings"]
    post = lighting["hdrSettings"]
    shadow = env["shadowSettings"]["value"]
    car_light = env["carLightSettings"]["value"]
    flares = env["lightFlareSettings"]["value"]

    return {
        "pak": "cache/gamedata.pak",
        "entry": entry["path"],
        "entryLogicalBytes": entry["logical_bytes"],
        "packSha256": sha256_bytes(blob),
        "flaskVersion": flask.version,
        "recordIndex": record_index,
        "cityName": wanted,
        "fields": {
            "sunColour": rgba(info["SunColour"]),
            "skyColour": rgba(info["SkyColour"]),
            "bakedColour": rgba(info["BakedColour"]),
            "emissiveColour": rgba(info["EmissiveColour"]),
        },
        "fog": {
            "colour": rgba(fog["FogColour"]),
            "depth": {
                "density": fog["DepthFog"]["Density"],
                "nearDistance": fog["DepthFog"]["NearDistance"],
                "scale": fog["DepthFog"]["Scale"],
            },
            "height": {
                "height": fog["HeightFog"]["Height"],
                "density": fog["HeightFog"]["Density"],
                "falloff": fog["HeightFog"]["Falloff"],
                "scale": fog["HeightFog"]["Scale"],
            },
        },
        "skyDome": {
            "texture": sky["texture"]["value"],
            "rotation": sky["rotation"],
            "intensity": sky["intensity"],
            "fogColour": rgba(sky["fogColour"]),
            "fogCurve": sky["fogCurve"],
            "blackHeight": sky["blackHeight"],
            "blackSize": sky["blackSize"],
        },
        "postProcess": {
            "middleGrey": post["middleGrey"],
            "exposureMin": post["exposureMin"],
            "exposureMax": post["exposureMax"],
            "bloomScale": post["bloomScale"],
            "bloomThreshold": post["bloomThreshold"],
        },
        "shadow": {name: shadow[name] for name in (
            "ShadowSize", "ShadowHeight", "DropShadowIntensity", "DropShadowHeight",
            "IndividualShadowMaxIntensity", "MultiShadowIntensity", "FadeRange", "MaxShadows")},
        "carLight": {
            "SHLightFactor": car_light["SHLightFactor"],
            "SHLightMax": car_light["SHLightMax"],
            "StaticLightCubemapFactor": car_light["StaticLightCubemapFactor"],
            "DynamicLightCubemapFactor": car_light["DynamicLightCubemapFactor"],
            "LightCubemapMax": car_light["LightCubemapMax"],
            "FakeSunBlobShadowIntensity": car_light["FakeSunBlobShadowIntensity"],
            "FakeSunBlobShadowPosition": [car_light["FakeSunBlobShadowPosition"]["vx"],
                                          car_light["FakeSunBlobShadowPosition"]["vy"],
                                          car_light["FakeSunBlobShadowPosition"]["vz"]],
        },
        "lightFlares": {
            "carWhiteFlaresColour": [flares["CarWhiteFlaresColour"]["r"],
                                     flares["CarWhiteFlaresColour"]["g"],
                                     flares["CarWhiteFlaresColour"]["b"]],
            "carRedFlaresColour": [flares["CarRedFlaresColour"]["r"],
                                   flares["CarRedFlaresColour"]["g"],
                                   flares["CarRedFlaresColour"]["b"]],
            "globalColour": [flares["GlobalColour"]["r"], flares["GlobalColour"]["g"],
                             flares["GlobalColour"]["b"]],
        },
        # Offsets inside the record payload are schema offsets, not file offsets;
        # xt_decode validates that every field is inside the record payload.
        "fieldOffsets": {
            "environmentSettings": 52,
            "lightingSettings": 0,
            "fogSettings": 64,
            "skySettings": 112,
            "hdrSettings": 152,
            "sunColour": 0,
            "skyColour": 16,
            "bakedColour": 32,
            "emissiveColour": 48,
        },
    }


# ---------------------------------------------------------------------------
# top-level level read

def read_level(level: str, max_normal_buffers: int = 6) -> dict:
    if level not in SPAWN_TABLE:
        raise ValueError("unknown level %r" % level)
    spec = SPAWN_TABLE[level]
    folder = LEVELS_DIR / level
    render_path = folder / "Level.levelrender"
    stream_path = folder / "Level.levelstream"
    data = render_path.read_bytes()
    root, chunks = render_root(data)
    by_id = {chunk["id"]: chunk for chunk in chunks}
    for required in ("Header", "Scene", "LS", "Lights"):
        if required not in by_id:
            raise ValueError("missing %s block in %s" % (required, render_path.name))

    scene_block = by_id["Scene"]
    declarations = scene_declarations(data, scene_block)
    lights = parse_lights(data, by_id["Lights"])
    light_samples = parse_light_samples(data, by_id["LS"])

    probe = closest_point(light_samples, spec["spawn"])
    sample = light_samples["samples"][probe["point"]["sampleIndex"]]

    normals = _normal_proof(data, stream_path, declarations, max_normal_buffers)

    return {
        "level": level,
        "short": spec["short"],
        "city": spec["city"],
        "renderPath": str(render_path.relative_to(ROOT)).replace("\\", "/"),
        "renderBytes": len(data),
        "renderSha256": sha256_bytes(data),
        "renderFnv1a64": fnv1a64(data),
        "streamPath": str(stream_path.relative_to(ROOT)).replace("\\", "/"),
        "streamBytes": stream_path.stat().st_size,
        "blocks": [{"id": c["id"], "offset": c["offset"], "bytes": c["bytes"],
                    "type": c["type"], "count": c["count"]} for c in chunks],
        "lights": lights,
        "lightSamples": light_samples,
        "ambientProbe": {
            "spawn": list(spec["spawn"]),
            "spawnSource": spec["spawnSource"],
            "pointIndex": probe["point"]["index"],
            "pointPosition": probe["point"]["position"],
            "distance": probe["distance"],
            "sampleIndex": probe["point"]["sampleIndex"],
            "sampleOffset": sample["offset"],
            "halfBits": sample["halfBits"],
            "sh": sample["values"],
            "upNormalAmbient": sh_up_normal(sample["values"]),
            "searchRadius": 10.0,
            "searchRadiusSource": "LightSamplePointScene.cpp:108 (F32 closest = 10.0f)",
        },
        "declarations": declarations,
        "normals": normals,
    }


def _normal_proof(data: bytes, stream_path: Path, declarations: list[dict],
                  max_buffers: int) -> dict:
    """Prove the NORMAL element is serialized, with real bytes and offsets.

    The Scene stream table and the per-chunk resource prefix are read with the
    committed reader (tools/inspect_car_level_assets.render_layout /
    resource_prefix, already used by tools/inspect_level_chunk.py). Every 8-bit
    decode uses the retail PC rule ``input * 2 - 1`` (Transform.h:29-30).
    """
    reader = _import_committed("inspect_car_level_assets", ROOT / "tools")
    render_layout = reader.render_layout
    resource_prefix = reader.resource_prefix
    stream_prefix = getattr(reader, "stream_prefix", None)

    layout = render_layout(data, "level")
    chunks = layout["scene"]["stream"]["chunks"]

    declaration_summary = []
    for index, declaration in enumerate(declarations):
        element = normal_element(declaration)
        declaration_summary.append({
            "declaration": index,
            "elements": len(declaration),
            "normal": element,
            "hasNormal": element is not None,
        })

    sampled = []
    stream_bytes = stream_path.read_bytes()
    with stream_path.open("rb") as stream:
        for record in chunks:
            if len(sampled) >= max_buffers:
                break
            items = record.get("items") or []
            if not items or items[0].get("lod") != 0:
                continue
            if not 16 <= record["storedBytes"] <= 64 * 1024 * 1024:
                continue
            if record["offset"] + record["storedBytes"] > len(stream_bytes):
                raise ValueError("stream record outside levelstream")
            stream.seek(record["offset"])
            chunk_data = stream.read(record["storedBytes"])
            if stream_prefix is not None:
                stream_prefix(chunk_data, record)
            try:
                resources = resource_prefix(
                    chunk_data, {"resourcePayloadOffset": 24, "scenePayloadOffset": 0},
                    streamed=True)
            except (ValueError, IndexError, struct.error):
                continue
            for buffer_index, buffer in enumerate(resources["vertexBuffers"]):
                element = next((e for e in buffer["elements"]
                                if e["usage"] == 3 and e["usageIndex"] == 0), None)
                if element is None:
                    continue
                if element["type"] != 11:
                    raise ValueError("unexpected normal element type %d" % element["type"])
                stats = normal_byte_stats(chunk_data, buffer["dataOffset"] + element["offset"],
                                          buffer["stride"], buffer["vertexCount"])
                sampled.append({
                    "resourceBlock": items[0].get("block"),
                    "streamRecordOffset": record["offset"],
                    "streamRecordBytes": record["storedBytes"],
                    "vertexBuffer": buffer_index,
                    "vertexCount": buffer["vertexCount"],
                    "stride": buffer["stride"],
                    "element": element,
                    "stats": stats,
                })
                if len(sampled) >= max_buffers:
                    break

    if not sampled:
        raise ValueError("no serialized normal element found in sampled buffers")

    lengths = [s["stats"] for s in sampled if s["stats"]]
    worst = max(max(abs(s["minLength"] - 1.0), abs(s["maxLength"] - 1.0)) for s in lengths)
    sampled_vertices = sum(s["decodedVertices"] for s in lengths)
    return {
        "declarations": declaration_summary,
        "declarationsWithNormal": sum(1 for d in declaration_summary if d["hasNormal"]),
        "sampledBuffers": sampled,
        "sampledVertices": sampled_vertices,
        "worstLengthError": worst,
        "decodeRule": "vertex * 2 - 1 (Transform.h:29-30)",
        "verdict": "serialized",
    }
