#!/usr/bin/env python3
"""Shared readers and classifiers for the environment probe.

Data only. This module reads committed level-render evidence (map-slice
packages, map-pipeline probe stages), the compiled XT environment settings
library and the sky textures in ``root.pak``. It never writes game data and it
changes no renderer.

Sources (all read-only):

* ``_work/map-slice/<short>/{slice.json,layout.points.f32.bin}`` - sections,
  bounds, draws, measured path.
* ``_work/map-slice/<short>-textures/{bindings.json,blockers.json}`` - per-draw
  effect, material, texture identity and blocked status.
* ``_work/map-slice/<short>-render/render.json`` - the opaque draw list the
  browser package uploads.
* ``_work/track-coverage/{corridor.json,course_samples.json}`` - the River
  playable corridor.
* ``game-data/Blur/cache/gamedata.pak`` ``\\gamedata\\xt\\amax.bin`` - compiled
  XT library holding ``EnvironmentSettings``/``LightingSettings``/``SkySettings``
  /``FogSettings`` records.
* ``game-data/Blur/cache/gamedata.pak``
  ``\\gamedata\\levels\\<level>\\actorpack.xt`` - per-level handle to its
  ``EnvironmentSettings`` record.
* ``game-data/Blur/cache/root.pak`` ``\\graphics\\textures\\skies\\*.texture`` -
  sky texture descriptor (width/height/format/levels).

Format authorities:

* ``probes/asset-reader/FORMAT-xt.md`` (FLSK v1/v2),
* ``upstream/.../common/xt2/source/game/XtFlaskImport.cpp`` (pointer/handle,
  atom and string decoding),
* ``upstream/.../graphics/effect/source/sky/SkyDomeEnvSettings.cpp`` and
  ``SkyDomeBase.cpp`` (sky values and dome geometry),
* ``upstream/.../graphics/shader/source/envsettings/FogSettings.cpp`` (fog).
"""
from __future__ import annotations

import hashlib
import json
import math
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# --------------------------------------------------------------------------
# Level registry
# --------------------------------------------------------------------------
# ``playable`` is the draw set e1-drive currently draws for that map:
#   river   - block88/node283 plus the six measured corridor sections (394 draws)
#   amboy   - render.json#draws (1,201 opaque draws)
#   gracia  - render.json#draws (2,627 opaque draws)
#   longbeach - no map branch in e1-drive (map-registry MAP_IDS: river/amboy/gracia)
LEVELS = [
    {
        "short": "river",
        "level": "usa_la_river",
        "slice": "_work/environment/river/slice.json",
        "bindings": "_work/environment/river-textures/bindings.json",
        "blockers": None,
        "render": None,
        "path": "track-course",
        "playableMode": "sections",
        "playableSections": [
            "g88-n283", "g56-n289", "g58-n265", "g50-n265",
            "g71-n209", "g64-n209", "g59-n265",
        ],
        "mapWired": True,
        "note": "Default map. Current draw set is block88/node283 (95 draws) plus "
                "the six measured corridor sections (299 draws) = 394 draws.",
    },
    {
        "short": "amboy",
        "level": "usa_amboy",
        "slice": "_work/map-slice/amboy/slice.json",
        "bindings": "_work/map-slice/amboy-textures/bindings.json",
        "blockers": "_work/map-slice/amboy-textures/blockers.json",
        "render": "_work/map-slice/amboy-render/render.json",
        "path": "layout",
        "playableMode": "bindable",
        "playableSections": [],
        "mapWired": True,
        "note": "?map=amboy draws render.json#draws: 1,201 opaque draws.",
    },
    {
        "short": "gracia",
        "level": "spa_barcelona_gracia",
        "slice": "_work/map-slice/gracia/slice.json",
        "bindings": "_work/map-slice/gracia-textures/bindings.json",
        "blockers": "_work/map-slice/gracia-textures/blockers.json",
        "render": "_work/map-slice/gracia-render/render.json",
        "path": "layout",
        "playableMode": "bindable",
        "playableSections": [],
        "mapWired": True,
        "note": "?map=gracia draws render.json#draws: 2,627 opaque draws.",
    },
    {
        "short": "longbeach",
        "level": "usa_la_longbeachdocks",
        "slice": "_work/map-slice/longbeach/slice.json",
        "bindings": "_work/map-slice/longbeach-textures/bindings.json",
        "blockers": "_work/map-slice/longbeach-textures/blockers.json",
        "render": "_work/map-slice/longbeach-render/render.json",
        "path": "layout",
        "playableMode": "none",
        "playableSections": [],
        "mapWired": False,
        "note": "No ?map=longbeach branch; e1-drive MAP_IDS is river/amboy/gracia.",
    },
]

BINDABLE = "bindable-static-albedo"

STATUS_LABEL = {
    "bindable-static-albedo": "bindable static albedo + original UV0",
    "blocked-alpha-rule-missing": "BC3 source with non-opaque alpha and no alpha rule",
    "blocked-decoder-size-limit": "source exceeds the committed 512 px decoder bound",
    "blocked-runtime-albedo-parameter": "g_tAlbedo is a runtime DATA_INDEX parameter",
    "blocked-no-static-albedo": "primitive material stack has no g_tAlbedo/g_tTexture",
    "blocked-effect-not-static-albedo": "additive/effect shader exposes g_tTexture, not g_tAlbedo",
    "blocked-missing-texture-source": "node texture source could not be resolved",
}

# Distance used to separate foreground from background. The retail far clip is
# 230.0365 m (docs/work/analysis/retail-parity.md), so geometry farther from the
# measured racing line than one far clip is treated as background scenery. This
# is a classification proxy, not a visibility or culling proof.
DISTANT_M = 230.0

# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------

def load_json(rel_or_path) -> dict:
    path = Path(rel_or_path)
    if not path.is_absolute():
        path = ROOT / path
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(rel_or_path) -> str:
    path = Path(rel_or_path)
    if not path.is_absolute():
        path = ROOT / path
    return sha256_bytes(path.read_bytes())


def canonical_hash(obj) -> str:
    body = json.dumps(obj, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return "sha256:" + sha256_bytes(body.encode("utf-8"))


def dump_json(path: Path, obj) -> str:
    text = json.dumps(obj, indent=1, sort_keys=True, allow_nan=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return sha256_bytes(text.encode("utf-8"))


def fnum(value: float, digits: int = 6) -> float:
    return round(float(value), digits)


# --------------------------------------------------------------------------
# PAK access
# --------------------------------------------------------------------------

def pak_index(pak: Path) -> dict:
    sys.path.insert(0, str(ROOT / "tools"))
    from inspect_asset_layout import pak_index as _index  # noqa: E402
    return _index(pak)


def _read_packet_zlib(entry: dict, raw: bytes) -> bytes:
    """Decode codec 4 (packet-zlib): one U32 packet size then U32 chunks."""
    pos = 0
    packet_size, = struct.unpack_from("<I", raw, pos)
    pos += 4
    out = bytearray()
    while pos < len(raw):
        size, = struct.unpack_from("<I", raw, pos)
        pos += 4
        if size == 0xFFFFFFFF:
            out += raw[pos:pos + packet_size]
            pos += packet_size
        else:
            out += zlib.decompressobj(-15).decompress(raw[pos:pos + size], packet_size + 1)
            pos += size
    if len(out) != entry["logical_bytes"]:
        raise ValueError("packet-zlib extent mismatch for " + entry["path"])
    return bytes(out)


def read_pak_entry(pak: Path, entry: dict) -> bytes:
    with pak.open("rb") as stream:
        stream.seek(entry["offset"])
        raw = stream.read(entry["stored_bytes"])
    if len(raw) != entry["stored_bytes"]:
        raise ValueError("short PAK read for " + entry["path"])
    idx = pak_index(pak)
    codec = idx.get("codec")
    if codec == 1:
        return raw
    if codec == 2:
        out = zlib.decompressobj().decompress(raw, entry["logical_bytes"] + 1)
        if len(out) != entry["logical_bytes"]:
            raise ValueError("zlib extent mismatch for " + entry["path"])
        return out
    if codec == 4:
        return _read_packet_zlib(entry, raw)
    raise ValueError("unsupported PAK codec %r" % (codec,))


def pak_entry(pak: Path, suffix: str) -> dict:
    low = suffix.lower()
    for row in pak_index(pak)["entries"]:
        if row["path"].lower() == low:
            return row
    raise KeyError(suffix)


# --------------------------------------------------------------------------
# FLSK (compiled XT) reader
# --------------------------------------------------------------------------
TABLES = [
    ("types", 12), ("bases", 4), ("fields", 8), ("strings", 1),
    ("refs", 8), ("records", 16), ("components", 6), ("data", 1),
]


class XtFile:
    """Bounded little-endian FLSK v1/v2 reader with typed value decoding.

    Metadata validation mirrors ``probes/asset-reader/FORMAT-xt.md``; record
    values are decoded through schema field offsets, never by guessing.
    """

    def __init__(self, data: bytes):
        self.data = data
        header = struct.unpack_from("<18I", data)
        if header[0] != 0x464C534B or header[1] not in (1, 2):
            raise ValueError("unsupported FLSK tag/version")
        self.version = header[1]
        self.tables = {}
        for i, (name, size) in enumerate(TABLES):
            off, count = header[2 + i * 2:4 + i * 2]
            self.tables[name] = (off, count, size)
        self.types = self._rows("types", "<6H")
        self.bases = self._rows("bases", "<2H")
        self.fields = self._rows("fields", "<3H2B")
        self.refs = self._rows("refs", "<I2H")
        self.records = self._rows("records", "<4I")
        self.components = self._rows("components", "<3H")
        self.strings = self._decode_strings()
        self.type_names = [self.name(t[0]) for t in self.types]
        self.type_index = {}
        for i, name in enumerate(self.type_names):
            self.type_index.setdefault(name, i)

    def _rows(self, table: str, fmt: str) -> list:
        off, count, size = self.tables[table]
        stride = struct.calcsize(fmt)
        if stride != size:
            raise ValueError("element width mismatch for " + table)
        return [struct.unpack_from(fmt, self.data, off + i * size) for i in range(count)]

    def _decode_strings(self) -> bytes:
        off, count, _ = self.tables["strings"]
        raw = bytearray(self.data[off:off + count])
        if self.version == 2 and raw:
            prev = 0xCC
            for i, byte in enumerate(raw[:-1]):
                dec = (prev - (byte ^ 0xB3)) & 255
                raw[i] = dec
                prev = (prev + dec - i) & 255
            raw[-1] = 0
        return bytes(raw)

    def name(self, at: int) -> str:
        end = self.strings.find(b"\x00", at)
        if end < at:
            raise ValueError("unterminated XT name")
        return self.strings[at:end].decode("ascii", "replace")

    def type_of(self, index: int) -> dict:
        name, field_count, base_count, behaviour, atom, size = self.types[index]
        return {
            "index": index, "name": self.name(name), "behaviour": behaviour,
            "atom": atom, "size": size, "baseStart": 0, "baseCount": base_count,
            "fieldStart": 0, "fieldCount": field_count,
        }

    def fields_of(self, type_index: int) -> list:
        """Return schema fields with their absolute offset in the field table."""
        start = 0
        for t in self.types[:type_index]:
            start += t[1]
        t = self.types[type_index]
        out = []
        for i in range(start, start + t[1]):
            name, ftype, offset, behaviour, array = self.fields[i]
            out.append({
                "index": i, "name": self.name(name),
                "typeIndex": None if ftype == 65535 else ftype,
                "typeName": None if ftype == 65535 else self.type_names[ftype],
                "offset": offset, "behaviour": behaviour, "array": bool(array),
            })
        return out

    def record(self, index: int) -> dict:
        ref, component_start, data_bytes, string_bytes = self.records[index]
        id_, type_index, record_index = self.refs[ref]
        if record_index != index:
            raise ValueError("record/ref mismatch at %d" % index)
        off = self.data_offset(index)
        return {
            "index": index, "id": id_, "typeIndex": type_index,
            "typeName": self.type_names[type_index],
            "dataOffset": off, "dataBytes": data_bytes, "stringBytes": string_bytes,
            "componentStart": component_start,
            "componentCount": self.records[index][1],
        }

    def data_offset(self, index: int) -> int:
        base = self.tables["data"][0]
        at = 0
        for i in range(index):
            at += self.records[i][2] + self.records[i][3]
        return base + at

    def record_bytes(self, index: int) -> bytes:
        r = self.record(index)
        return self.data[r["dataOffset"]:r["dataOffset"] + r["dataBytes"]]

    def record_strings(self, index: int) -> bytes:
        r = self.record(index)
        off = r["dataOffset"] + r["dataBytes"]
        raw = bytearray(self.data[off:off + r["stringBytes"]])
        if raw:
            prev = 0xCC
            for i, byte in enumerate(raw[:-1]):
                dec = (prev - (byte ^ 0xB3)) & 255
                raw[i] = dec
                prev = (prev + dec - i) & 255
            raw[-1] = 0
        return bytes(raw)

    def records_of_type(self, name: str) -> list:
        if name not in self.type_index:
            return []
        ti = self.type_index[name]
        return [self.record(i) for i in range(len(self.records))
                if self.refs[self.records[i][0]][1] == ti]

    def handle_target(self, handle_id: int):
        if handle_id >= len(self.refs):
            return None
        record_index = self.refs[handle_id][2]
        if record_index == 65535:
            return None
        return record_index


ATOM_WIDTH = {1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4,
              9: 8, 10: 4, 11: 8, 12: 4, 13: 4, 14: 4}


def xt_decode(xt: XtFile, type_index: int, buf: bytes, strings: bytes,
              base: int = 0, prefix: str = "", depth: int = 0) -> dict:
    """Decode a struct instance at ``base`` in ``buf`` by schema field offsets."""
    if depth > 8:
        raise ValueError("XT struct nesting too deep")
    out = {}
    t = xt.types[type_index]
    for field in xt.fields_of(type_index):
        key = prefix + field["name"]
        offset = base + field["offset"]
        behaviour = field["behaviour"]
        type_name = field["typeName"]
        if behaviour == 3:  # nested struct
            out.update(xt_decode(xt, field["typeIndex"], buf, strings, offset,
                                 key + ".", depth + 1))
        elif behaviour == 0:  # atom
            if type_name == "f32":
                out[key] = struct.unpack_from("<f", buf, offset)[0]
            elif type_name == "u32":
                out[key] = struct.unpack_from("<I", buf, offset)[0]
            elif type_name == "i32":
                out[key] = struct.unpack_from("<i", buf, offset)[0]
            elif type_name == "bool":
                out[key] = struct.unpack_from("<I", buf, offset)[0] != 0
            elif type_name == "sz8":
                at = struct.unpack_from("<I", buf, offset)[0]
                if at < len(strings):
                    end = strings.find(b"\x00", at)
                    out[key] = strings[at:end if end >= 0 else len(strings)].decode(
                        "ascii", "replace")
                else:
                    out[key] = None
            else:
                out[key] = {"atom": type_name,
                            "raw": struct.unpack_from("<I", buf, offset)[0]}
        elif behaviour == 5:  # handle: U32 ref-table index
            out[key] = {"handle": struct.unpack_from("<I", buf, offset)[0]}
        elif behaviour == 4:  # pointer: U16 component, U16 element
            out[key] = {"component": struct.unpack_from("<2H", buf, offset)[0],
                        "element": struct.unpack_from("<2H", buf, offset)[1]}
        else:
            raise ValueError("unsupported XT field behaviour %d" % behaviour)
    return out


# --------------------------------------------------------------------------
# Environment settings
# --------------------------------------------------------------------------
SKY_TEXTURE_PREFIX = "\\graphics\\textures\\skies\\"
GAMEDATA = ROOT / "game-data/Blur/cache/gamedata.pak"
ROOTPAK = ROOT / "game-data/Blur/cache/root.pak"


def _level_env_handle(actorpack: bytes) -> int:
    xt = XtFile(actorpack)
    if "EnvironmentSettings" not in xt.type_index:
        raise KeyError("actorpack has no EnvironmentSettings type")
    ti = xt.type_index["EnvironmentSettings"]
    for ident, typ, record in xt.refs:
        if typ == ti:
            return ident
    raise KeyError("actorpack has no EnvironmentSettings ref")


def _sky_texture(path: str) -> dict:
    if not path or not path.lower().startswith("graphics/textures/skies/"):
        raise ValueError("unsupported sky texture path " + repr(path))
    name = path.rsplit("/", 1)[-1]
    entry = pak_entry(ROOTPAK, SKY_TEXTURE_PREFIX + name)
    data = read_pak_entry(ROOTPAK, entry)
    if data[:8] != b"Texture\x00":
        raise ValueError("not a PC .texture container")
    width, height, depth, levels, fmt, usage, kind = struct.unpack_from("<7I", data, 56)
    formats = {0x31545844: "DXT1/BC1", 0x33545844: "DXT3/BC2",
               0x35545844: "DXT5/BC3"}
    block = 8 if fmt == 0x31545844 else 16 if fmt in (0x33545844, 0x35545844) else None
    if block is None:
        raise ValueError("unsupported sky texture format 0x%08x" % fmt)
    chain = 0
    w, h = width, height
    for _ in range(levels):
        chain += max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * block
        w = max(1, w // 2)
        h = max(1, h // 2)
    return {
        "path": path,
        "pakEntry": entry["path"],
        "containerBytes": len(data),
        "storedBytes": entry["stored_bytes"],
        "containerSha256": sha256_bytes(data),
        "width": width, "height": height, "depth": depth, "levels": levels,
        "format": "0x%08x" % fmt, "formatName": formats[fmt],
        "type": kind,
        "payloadBytes": len(data) - 84,
        "declaredChainBytes": chain,
        "rgbaMip0Bytes": width * height * 4,
        "decoderBoundPx": 512,
        "decoderBounded": max(width, height) > 512,
    }


def level_environment(level: str) -> dict:
    """Resolve a level's EnvironmentSettings record to its typed values."""
    actor_entry = pak_entry(GAMEDATA, "\\gamedata\\levels\\%s\\actorpack.xt" % level)
    actor = read_pak_entry(GAMEDATA, actor_entry)
    handle = _level_env_handle(actor)

    amax_entry = pak_entry(GAMEDATA, "\\gamedata\\xt\\amax.bin")
    amax = read_pak_entry(GAMEDATA, amax_entry)
    xt = XtFile(amax)

    record_index = None
    for i in range(len(xt.refs)):
        if xt.refs[i][0] == handle:
            record_index = xt.refs[i][2]
            break
    if record_index is None or record_index == 65535:
        raise KeyError("EnvironmentSettings handle %d is external to amax.bin" % handle)

    env = xt.record(record_index)
    if env["typeName"] != "EnvironmentSettings":
        raise ValueError("handle resolves to " + env["typeName"])
    env_buf = xt.record_bytes(record_index)
    env_strings = xt.record_strings(record_index)

    # EnvironmentSettings is 7 handles: lighting, lightFlare, postFx, roadTrack,
    # shadow, carLight, wind. Only lightingSettings carries the sky/fog values.
    handles = xt_decode(xt, xt.type_index["EnvironmentSettings"], env_buf, env_strings)
    chain = {}
    for name, value in handles.items():
        hid = value["handle"]
        target = xt.handle_target(hid)
        chain[name] = {"handle": hid, "record": target,
                       "type": None if target is None else xt.record(target)["typeName"]}
    lighting_ref = chain["lightingSettings"]
    if lighting_ref["record"] is None:
        raise KeyError("lightingSettings handle is external")
    light_record = xt.record(lighting_ref["record"])
    if light_record["typeName"] != "LightingSettings":
        raise ValueError("lightingSettings is not LightingSettings")
    values = xt_decode(xt, xt.type_index["LightingSettings"],
                       xt.record_bytes(light_record["index"]),
                       xt.record_strings(light_record["index"]))

    sky_texture = _sky_texture(values.get("skySettings.texture") or "")

    return {
        "level": level,
        "actorpack": {
            "pakEntry": actor_entry["path"],
            "logicalBytes": actor_entry["logical_bytes"],
            "sha256": sha256_bytes(actor),
            "environmentSettingsHandle": handle,
        },
        "library": {
            "pakEntry": amax_entry["path"],
            "logicalBytes": amax_entry["logical_bytes"],
            "sha256": sha256_bytes(amax),
            "format": "FLSK v%d" % xt.version,
            "types": len(xt.types),
            "records": len(xt.records),
        },
        "records": {
            "settings": {"index": record_index, "id": env["id"],
                         "bytes": env["dataBytes"], "type": "EnvironmentSettings"},
            "lighting": {"index": light_record["index"], "id": light_record["id"],
                         "bytes": light_record["dataBytes"], "type": "LightingSettings"},
            "chain": chain,
        },
        "sky": {
            "texture": values.get("skySettings.texture"),
            "rotationRad": values.get("skySettings.rotation"),
            "intensity": values.get("skySettings.intensity"),
            "fogColour": [values.get("skySettings.fogColour.%s" % c) for c in "rgba"],
            "fogCurve": values.get("skySettings.fogCurve"),
            "blackHeight": values.get("skySettings.blackHeight"),
            "blackSize": values.get("skySettings.blackSize"),
            "textureDescriptor": sky_texture,
        },
        "fog": {
            "colour": [values.get("fogSettings.FogColour.%s" % c) for c in "rgba"],
            "depth": {
                "density": values.get("fogSettings.DepthFog.Density"),
                "nearDistance": values.get("fogSettings.DepthFog.NearDistance"),
                "scale": values.get("fogSettings.DepthFog.Scale"),
                "effectiveDensity": (
                    values.get("fogSettings.DepthFog.Density", 0.0) *
                    values.get("fogSettings.DepthFog.Scale", 0.0)),
            },
            "height": {
                "height": values.get("fogSettings.HeightFog.Height"),
                "density": values.get("fogSettings.HeightFog.Density"),
                "falloff": values.get("fogSettings.HeightFog.Falloff"),
                "scale": values.get("fogSettings.HeightFog.Scale"),
                "effectiveDensity": (
                    values.get("fogSettings.HeightFog.Density", 0.0) *
                    values.get("fogSettings.HeightFog.Scale", 0.0)),
            },
        },
        "lighting": {
            "sunColour": [values.get("lightingSettings.SunColour.%s" % c) for c in "rgba"],
            "skyColour": [values.get("lightingSettings.SkyColour.%s" % c) for c in "rgba"],
            "bakedColour": [values.get("lightingSettings.BakedColour.%s" % c) for c in "rgba"],
            "emissiveColour": [values.get("lightingSettings.EmissiveColour.%s" % c) for c in "rgba"],
        },
        "postProcess": {k.split(".", 1)[1]: v for k, v in values.items()
                        if k.startswith("hdrSettings.")},
        "cubemapTexture": values.get("cubemapTexture"),
        "values": values,
        "source": {
            "xtTypes": "upstream/BlurRebuilt/code/mercury/library/graphics/"
                       "effect/source/sky/SkyDomeEnvSettings.cpp (XT_FIELD order)",
            "valueUse": "SkyDomeEnvSettings.cpp Set() -> SetFogColour/SetIntensity/"
                        "SetRotation/fogCurve/blackHeight/blackSize",
            "fogUse": "graphics/shader/source/envsettings/FogSettings.cpp Set()",
            "dome": "graphics/effect/source/sky/SkyDomeBase.cpp BuildSphere()",
            "fogShaders": ["graphics/render/include/render/shaders/sky/vsSkyDome.vsh",
                           "graphics/effect/include/effect/shaders/sky/psTexturedSkyDome.psh"],
        },
    }


# --------------------------------------------------------------------------
# Geometry distance and coverage metrics
# --------------------------------------------------------------------------

def layout_points(slice_doc: dict) -> list:
    pts = slice_doc["layout"]["points"]
    out = []
    for p in pts:
        if isinstance(p, dict):
            out.append((float(p["x"]), float(p["z"]), float(p.get("h", 0.0))))
        else:
            out.append((float(p[0]), float(p[1]), float(p[2]) if len(p) > 2 else 0.0))
    return out


def river_course_points() -> list:
    data = load_json("_work/track-coverage/course_samples.json")
    return [(float(s["x"]), float(s["z"]),
             float(s["coll"]) if s.get("coll") is not None else 0.0)
            for s in data["samples"]]


def path_points(cfg: dict) -> list:
    if cfg["path"] == "track-course":
        return river_course_points()
    return layout_points(load_json(cfg["slice"]))


def box_distance_xz(bounds: dict, points: list) -> float:
    mn, mx = bounds["min"], bounds["max"]
    best = float("inf")
    for x, z in ((p[0], p[1]) for p in points):
        dx = max(mn[0] - x, 0.0, x - mx[0])
        dz = max(mn[2] - z, 0.0, z - mx[2])
        if dx == 0.0 and dz == 0.0:
            return 0.0
        d = math.hypot(dx, dz)
        if d < best:
            best = d
    return best


def _angle_interval(points: list, bounds: dict, sample, expand: float = 0.0):
    sx, sz = sample[0], sample[1]
    mn, mx = bounds["min"], bounds["max"]
    if mn[0] - expand <= sx <= mx[0] + expand and mn[2] - expand <= sz <= mx[2] + expand:
        return (0.0, 360.0)
    angles = []
    for x in (mn[0], mx[0]):
        for z in (mn[2], mx[2]):
            angles.append(math.degrees(math.atan2(z - sz, x - sx)) % 360.0)
    angles.sort()
    # The AABB corners span the smaller arc; find the largest gap.
    gaps = [(angles[(i + 1) % 4] - angles[i]) % 360.0 for i in range(4)]
    i = max(range(4), key=lambda k: gaps[k])
    start = angles[(i + 1) % 4]
    return (start, (start + (360.0 - gaps[i])) % 360.0)


def _union_degrees(intervals: list) -> float:
    expanded = []
    for start, end in intervals:
        if start == 0.0 and end == 360.0:
            return 360.0
        if start <= end:
            expanded.append((start, end))
        else:
            expanded.append((start, 360.0))
            expanded.append((0.0, end))
    if not expanded:
        return 0.0
    expanded.sort()
    total = 0.0
    cur_s, cur_e = expanded[0]
    for s, e in expanded[1:]:
        if s > cur_e:
            total += cur_e - cur_s
            cur_s, cur_e = s, e
        else:
            cur_e = max(cur_e, e)
    total += cur_e - cur_s
    return total


def _solid_angle_triangle(a, b, c) -> float:
    la = math.sqrt(sum(v * v for v in a))
    lb = math.sqrt(sum(v * v for v in b))
    lc = math.sqrt(sum(v * v for v in c))
    if la == 0.0 or lb == 0.0 or lc == 0.0:
        return 0.0
    det = (a[0] * (b[1] * c[2] - b[2] * c[1])
           - a[1] * (b[0] * c[2] - b[2] * c[0])
           + a[2] * (b[0] * c[1] - b[1] * c[0]))
    denom = (la * lb * lc
             + (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * lc
             + (a[0] * c[0] + a[1] * c[1] + a[2] * c[2]) * lb
             + (b[0] * c[0] + b[1] * c[1] + b[2] * c[2]) * la)
    omega = 2.0 * math.atan2(abs(det), denom)
    return omega if det >= 0.0 else -omega


BOX_TRIANGLES = [
    (0, 1, 3), (0, 3, 2),  # -z
    (4, 6, 7), (4, 7, 5),  # +z
    (0, 4, 5), (0, 5, 1),  # -x
    (2, 3, 7), (2, 7, 6),  # +x
    (0, 2, 6), (0, 6, 4),  # -y
    (1, 5, 7), (1, 7, 3),  # +y
]


def box_solid_angle(bounds: dict, sample) -> float:
    """Visible solid angle of an AABB from a point (steradians, <= 2*pi).

    Each of the 12 box triangles contributes signed solid angle; only the
    positive (front-facing) contributions are summed, which is the exact
    projected area of a convex box. Distant or small boxes tend to zero.
    """
    mn, mx = bounds["min"], bounds["max"]
    sx, sy, sz = sample[0], sample[1], sample[2] if len(sample) > 2 else 0.0
    corners = []
    for x in (mn[0], mx[0]):
        for y in (mn[1], mx[1]):
            for z in (mn[2], mx[2]):
                corners.append((x - sx, y - sy, z - sz))
    order = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 2, 6), (0, 6, 4),
             (1, 5, 7), (1, 7, 3), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6)]
    # corners index order: x0y0z0(0) x0y0z1(1) x0y1z0(2) x0y1z1(3)
    #                     x1y0z0(4) x1y0z1(5) x1y1z0(6) x1y1z1(7)
    total = 0.0
    for i, j, k in order:
        omega = _solid_angle_triangle(corners[i], corners[j], corners[k])
        if omega > 0.0:
            total += omega
    return total


def group_visual_metrics(sections: list, points: list, sample_stride: int = 4) -> dict:
    """Mean visible solid angle of the group's section AABBs from the racing line.

    Solid angle is distance- and height-aware: a near wall or a tall backdrop
    occupies more of the frame than a far flat one of the same triangle count.
    Occlusion between sections is not modelled.
    """
    if not sections or not points:
        return {"meanSolidAngleSr": 0.0, "hemispherePercent": 0.0,
                "maxElevationDeg": 0.0, "samples": 0}
    total = 0.0
    peak = 0.0
    count = 0
    for sample in points[::sample_stride]:
        omega = 0.0
        for sec in sections:
            omega += box_solid_angle(sec["bounds"], sample)
            b = sec["bounds"]
            for x in (b["min"][0], b["max"][0]):
                for z in (b["min"][2], b["max"][2]):
                    dist = max(2.0, math.hypot(x - sample[0], z - sample[1]))
                    elev = math.degrees(math.atan2(b["max"][1] - sample[2], dist))
                    if elev > peak:
                        peak = elev
        total += min(omega, 2.0 * math.pi)
        count += 1
    mean = total / count
    return {
        "meanSolidAngleSr": fnum(mean, 6),
        "hemispherePercent": fnum(100.0 * mean / (2.0 * math.pi), 3),
        "maxElevationDeg": fnum(peak, 3),
        "samples": count,
    }


# --------------------------------------------------------------------------
# Semantic classification
# --------------------------------------------------------------------------
GROUP_ORDER = [
    "distant-background", "water-surface", "terrain-ground", "crowd-grandstand",
    "fences-barriers", "signage-advertising", "animated-props", "vegetation",
    "effect-decal", "light-flare", "structures-props",
]

GROUP_LABEL = {
    "distant-background": "Distant / background geometry (horizon, vista planes, far city shell)",
    "water-surface": "Water surface and water-shader geometry",
    "terrain-ground": "Road surface, verge, dirt, sand and ground",
    "crowd-grandstand": "Crowd imposters, grandstands and stadium shells",
    "fences-barriers": "Fences, barriers, railings and guard rails",
    "signage-advertising": "Signs, billboards, adverts and neon",
    "animated-props": "Animated props (neon/flashing/screen/fan effects)",
    "vegetation": "Trees, foliage, bushes and grass",
    "effect-decal": "Additive effect/decal layer (Racification)",
    "light-flare": "Light-flare markers",
    "structures-props": "Buildings, walls, cranes, containers and other props",
    "sky-atmosphere": "Sky dome, fog and atmosphere (no level geometry)",
    "instance-geometry": "Instance-only geometry descriptions (not applied)",
    "unsupported-section": "Sections blocked by the position vertex format",
}

TEXTURE_RULES = [
    ("crowd-grandstand", ("crowd", "stadium", "grandstand", "spectator",
                          "bleacher", "stand")),
    ("fences-barriers", ("barrier", "fence", "railing", "handrail", "guard",
                         "balustrade", "highvis", "wiremesh", "chainfence")),
    ("signage-advertising", ("sign", "billboard", "advert", "neon", "banner",
                             "poster", "logo", "placard")),
    ("vegetation", ("tree", "foliage", "bush", "grass", "plant", "hedge",
                    "shrub", "palm", "ivy", "longgrass")),
    ("water-surface", ("ocean", "water_", "waterfall", "river", "lake", "canal",
                       "seawater", "harbour")),
    ("distant-background", ("vista", "farground", "background", "citywrap",
                            "skyline", "backdrop", "horizon", "distant")),
    ("terrain-ground", ("road", "tarmac", "pavement", "kerb", "curb", "dirt",
                        "sand", "ground", "rock", "gravel", "concrete",
                        "cobble", "asphalt", "verge", "floor", "terrain",
                        "track")),
    ("structures-props", ("building", "wall", "roof", "window", "tower",
                          "bridge", "container", "crane", "dock", "warehouse",
                          "house", "facade", "pipe", "shed", "hut", "station",
                          "gate", "door", "column", "pillar", "arch", "stairs",
                          "platform", "silo", "derek", "barrel", "crate")),
]

WATER_TEXTURE_EXCEPTIONS = ("waterbarrel", "puddle", "watertower")


def _match_texture(name: str):
    low = (name or "").lower()
    if not low:
        return None
    for group, keys in TEXTURE_RULES:
        if group == "water-surface" and any(k in low for k in WATER_TEXTURE_EXCEPTIONS):
            continue
        if any(k in low for k in keys):
            return group
    return None


def classify_draw(draw: dict, min_distance: float) -> dict:
    """Assign one draw to exactly one group. First matching rule wins."""
    effect = draw.get("effect") or ""
    low_effect = effect.lower()
    texture = draw.get("textureName") or ""
    low_tex = texture.lower()

    # 1. effect-driven groups
    if "racification" in low_effect:
        return {"group": "effect-decal", "rule": "effect:Racification"}
    if "lightflare" in low_effect:
        return {"group": "light-flare", "rule": "effect:LightFlare"}
    if "foliage" in low_effect or "speedtree" in low_effect:
        return {"group": "vegetation", "rule": "effect:Foliage/SpeedTree"}
    if "ocean" in low_effect or "water" in low_effect:
        return {"group": "water-surface", "rule": "effect:Ocean/Water"}
    if any(k in low_effect for k in ("animatedneon", "flashingneon", "animated",
                                     "spinner", "bobbing", "fan")):
        return {"group": "animated-props", "rule": "effect:Animated"}
    if "advert" in low_effect:
        return {"group": "signage-advertising", "rule": "effect:Advert"}
    if "highvis" in low_effect:
        return {"group": "fences-barriers", "rule": "effect:HighVis"}

    # 2. explicit background / water markers
    if any(k in low_tex for k in ("vista", "farground", "background", "citywrap",
                                  "skyline", "backdrop", "horizon", "distant")):
        return {"group": "distant-background", "rule": "texture:distant"}
    if any(k in low_tex for k in ("ocean", "water_", "river", "lake", "canal")):
        if not any(k in low_tex for k in WATER_TEXTURE_EXCEPTIONS):
            return {"group": "water-surface", "rule": "texture:water"}

    # 3. geometric background band
    if min_distance > DISTANT_M:
        return {"group": "distant-background",
                "rule": "distance>%gm" % DISTANT_M}

    # 4. texture families
    matched = _match_texture(texture)
    if matched:
        return {"group": matched, "rule": "texture:%s" % matched}

    # 5. road effects without a road texture
    if "road" in low_effect:
        return {"group": "terrain-ground", "rule": "effect:Road"}

    return {"group": "structures-props", "rule": "fallback:structure"}


# --------------------------------------------------------------------------
# Per-map package loading
# --------------------------------------------------------------------------

def load_map(cfg: dict) -> dict:
    slice_doc = load_json(cfg["slice"])
    bindings = load_json(cfg["bindings"])
    blockers = load_json(cfg["blockers"]) if cfg["blockers"] else None

    sections = {}
    for sec in slice_doc["draws"]["sections"]:
        if sec.get("status") != "supported":
            continue
        sections[sec["id"]] = {
            "id": sec["id"],
            "geometryBlock": sec["geometryBlock"],
            "nodeBlock": sec["nodeBlock"],
            "vertexCount": sec.get("vertexCount", 0),
            "indexCount": sec.get("indexCount", 0),
            "triangleCount": sec.get("triangleCount", 0),
            "drawCount": sec.get("drawCount", 0),
            "bounds": sec.get("bounds"),
        }

    unsupported = []
    for sec in slice_doc["draws"].get("unsupportedSections", []):
        unsupported.append({
            "id": sec.get("id"),
            "geometryBlock": sec.get("geometryBlock"),
            "nodeBlock": sec.get("nodeBlock"),
            "reason": sec.get("reason") or sec.get("status") or "unsupported",
            "byteOffset": sec.get("byteOffset"),
            "error": sec.get("error"),
        })

    draws = []
    for i, d in enumerate(bindings["draws"]):
        draws.append({
            "index": i,
            "section": d["section"],
            "drawIndex": d.get("drawIndex", i),
            "primitiveIndex": d.get("primitiveIndex"),
            "firstIndex": d.get("firstIndex"),
            "indexCount": d.get("indexCount", 0),
            "triangleCount": d.get("triangleCount", 0),
            "effect": d.get("effect"),
            "textureId": d.get("textureId"),
            "textureName": d.get("textureName"),
            "textureFormat": d.get("textureFormat"),
            "status": d.get("status"),
            "bindable": d.get("status") == BINDABLE,
        })

    textures = {}
    for t in bindings["textures"]:
        textures[t["id"]] = {
            "id": t["id"], "name": t.get("name"), "width": t.get("width"),
            "height": t.get("height"), "formatName": t.get("formatName"),
            "rgbaBytes": t.get("rgbaBytes", 0), "payloadBytes": t.get("payloadBytes", 0),
            "drawCount": t.get("drawCount", 0),
            "triangleCount": t.get("triangleCount", 0),
        }

    return {
        "cfg": cfg,
        "slice": slice_doc,
        "bindings": bindings,
        "blockers": blockers,
        "sections": sections,
        "unsupported": unsupported,
        "draws": draws,
        "textures": textures,
        "paths": path_points(cfg),
    }


def playable_predicate(pkg: dict):
    cfg = pkg["cfg"]
    mode = cfg["playableMode"]
    if mode == "none":
        return lambda draw: False
    if mode == "sections":
        wanted = set(cfg["playableSections"])
        return lambda draw: draw["section"] in wanted
    return lambda draw: draw["bindable"]
