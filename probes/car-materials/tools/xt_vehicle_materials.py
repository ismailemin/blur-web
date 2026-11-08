"""Read-only decoder for the retail vehicle XT material database.

The shipped engine builds every car's paint ramp and the glass/alloy/light/base
material constants from two compiled XT packs inside ``gamedata.pak``:

* ``\\gamedata\\xt\\amax.bin`` — ``AmaxVehicle`` records embed
  ``VEH_Vehicle`` (``baseVehicle``), which owns ``paintJobs`` and
  ``materialOverrides``.
* ``\\gamedata\\xt\\vehicles.bin`` — the shared ``VEH_PaintJob``,
  ``VEH_Curve``, ``VEH_Material*`` and ``VEH_MaterialDefaults`` records.

The format authority is ``probes/asset-reader/FORMAT-xt.md`` (FLSK v1/v2). Every
value returned here carries the pack, record, field and absolute byte offset it
was read from. Nothing is guessed: an unresolved handle or a type without a
known serialized field raises instead of returning a placeholder.
"""
from __future__ import annotations

import hashlib
import json
import math
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from inspect_asset_layout import pak_index  # noqa: E402

PACK_FILES = {
    "amax": "\\gamedata\\xt\\amax.bin",
    "vehicles": "\\gamedata\\xt\\vehicles.bin",
}
TABLES = [("types", 12), ("bases", 4), ("fields", 8), ("strings", 1),
          ("refs", 8), ("records", 16), ("components", 6), ("data", 1)]

PART_CODES = {
    "none": 0, "wheel": 1, "wheelinstance": 2, "wheellod": 3, "tyre": 4,
    "alloyrim": 5, "alloy": 6, "alloyblur": 7, "brakedisc": 8,
    "brakecaliper": 9, "bonnet": 10, "boot": 11, "door": 12, "wing": 13,
    "bumper": 14, "mirror": 15, "exhaust": 16, "licenseplate": 17,
    "steeringwheel": 18, "handbrake": 19, "gearstick": 20,
    "paddleshift": 21, "signalstalk": 22, "window": 23,
    "windowinterior": 24, "wiper": 25, "lightcluster": 26,
    "headlight": 27, "rearlight": 28, "foglight": 29, "brakelight": 30,
    "reverselight": 31, "runninglight": 32, "signallight": 33,
    "rearandbrakelight": 34, "headlightcover": 35, "foglightcover": 36,
    "rearlightcover": 37,
}
PART_CODE_NAMES = {value: key for key, value in PART_CODES.items()}
SUB_CODES = {
    "none": 0, "left": 1, "right": 2, "centre": 3, "center": 3,
    "front": 4, "frontleft": 5, "frontright": 6, "back": 7,
    "backleft": 8, "backright": 9, "rear": 7, "rearleft": 8,
    "rearright": 9, "top": 10, "topleft": 11, "topright": 12,
    "bottom": 13, "bottomleft": 14, "bottomright": 15,
}
SUB_CODE_NAMES = {value: key for key, value in SUB_CODES.items()}

# VehicleModelManager.cpp:395-430 — which per-element parameters are exposed.
GLASS_EXPOSURE_TOKENS = ("e_window", "e_headlightcover")
ALLOY_EXPOSURE_TOKENS = ("e_alloyrim", "e_wheellod")
LIGHT_EXPOSURE_TOKENS = (
    "e_headlight", "e_rearlight", "e_foglight", "e_brakelight",
    "e_reverselight", "e_runninglight", "e_signallight",
    "e_rearandbrakelight", "e_licenseplate",
)

# PaintEditor.cpp / shaders.jam / vehicle_common.h source lines used as evidence.
SOURCE = {
    "paint_selection": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/"
        "customisation/PaintEditor.cpp:151-153 — g_debugUseFirstPaintJobFound "
        "defaults true and picks m_PaintJobs[0]"),
    "paint_default_job": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/"
        "customisation/PaintEditor.cpp:168-169 — falls back to "
        "p_pMaterialDefaults->m_DefaultPaintJob"),
    "paint_ramp": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/"
        "customisation/PaintEditor.cpp:253-302,314-355 — 512x1 A8R8G8B8 "
        "sRGB ramp, byte=(U8)(float*255), alpha=reflectivity curve"),
    "paint_sample": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/"
        "vehicle/shaders/vehicle_common.h:1249-1250 — "
        "tex2Dlod(PaintTextureSampler,(NdotV,0))"),
    "paint_sampler_srgb": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/"
        "vehicle/shaders/vehicle_common.h:579-590 — SRGB_TEXTURE, CLAMP"),
    "paint_texture_srgb": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/"
        "customisation/PaintEditor.cpp:370 — CreateTexture2D(..., "
        "E_Format_Linear | E_Format_SRGB, E_Format_A8R8G8B8)"),
    "paint_surface": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/"
        "vehicle/shaders/vehicle_common.h:936-956 — surface=paintTex.xyz, "
        "reflectivity=paintTex.w"),
    "paint_lighting": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/"
        "vehicle/shaders/vehicle_common.h:880-934 — "
        "lit*(1-refl)+refl*env*rim*ao"),
    "light_masks": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/"
        "vehicle/shaders/vehicle_common.h:447-493,1212-1214,1253-1259 — "
        "off=UV0.xy, on=UV0.zw, lerp(off,on,on.a*g_vRenderColour.w)"),
    "light_weights": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/"
        "material/Material.cpp:614-678 and source/VehicleModel.cpp:1020-1087 — "
        "m_Intensity is 0/1 by light state, Intensity()=m_Intensity*"
        "m_DefaultIntensity*scale*noise"),
    "light_default_colour": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/"
        "vehicle/shaders/vehicle_common.h:116 — g_vRenderColour default "
        "{0,0,0,1}"),
    "glass_material": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/"
        "material/Material.cpp:313-369 — g_vRenderColour=tint, "
        "g_vRenderSettings=(minAlpha,maxAlpha,minRef, maxRef)"),
    "glass_blend": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/"
        "vehicle/shaders/vehicle_common.h:1341-1359 — SrcBlend One, "
        "DestBlend InvSrcAlpha, AlphaTest"),
    "alloy_material": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/"
        "material/Material.cpp:510-559 — g_vRenderColour=colour, "
        "g_vRenderSettings=(specPow,specInt)"),
    "alloy_surface": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/"
        "vehicle/shaders/vehicle_common.h:978-979 — g_vRenderColour.xyz"),
    "base_surface": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/"
        "vehicle/shaders/vehicle_common.h:983-984 — g_vMaterialColour.xyz "
        "from g_vMtlParameters.vMaterialColour"),
    "exposure": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/"
        "VehicleModelManager.cpp:395-430 — per-element parameter exposure"),
    "material_lookup": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/"
        "material/Material.cpp:751-801 — vehicle override, vehicle default, "
        "global part, global default"),
    "part_codes": (
        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/"
        "CodeProcessor.cpp:74-143,218-278 — element name -> part/sub code"),
    "curve": (
        "upstream/BlurRebuilt/code/mercury/library/common/misc_shared/include/"
        "misc_shared/Curve/HermiteCurve.h:74-83,149-200 — degrees->tangent "
        "tan(deg*pi/180)/3 and cubic Hermite evaluation"),
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def f32(value: float) -> float:
    """Round a Python float to IEEE-754 binary32 (the retail F32 type)."""
    return struct.unpack("<f", struct.pack("<f", value))[0]


def extract_pack(relative: str, game_dir: Path | None = None) -> bytes:
    game = (game_dir or (ROOT / "game-data/Blur")).resolve()
    pak = game / "cache/gamedata.pak"
    index = pak_index(pak)
    entry = next((r for r in index["entries"] if r["path"] == relative), None)
    if entry is None:
        raise ValueError(f"{relative}: not present in gamedata.pak")
    with pak.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    inflater = zlib.decompressobj()
    data = inflater.decompress(packed, entry["logical_bytes"] + 1)
    if len(data) != entry["logical_bytes"] or not inflater.eof or inflater.unused_data:
        raise ValueError(f"{relative}: zlib extent mismatch")
    return data


def parse_xt(data: bytes) -> dict:
    if not 72 <= len(data):
        raise ValueError("XT input too short")
    header = struct.unpack_from("<18I", data)
    if header[0] != 0x464C534B or header[1] not in (1, 2):
        raise ValueError("unsupported FLSK tag/version")
    tables = {}
    for i, (name, width) in enumerate(TABLES):
        offset, count = header[2 + i * 2:4 + i * 2]
        tables[name] = {"offset": offset, "count": count, "units": width}
        if offset + count * width > len(data):
            raise ValueError(f"{name}: table outside input")

    def rows(name, fmt):
        tb = tables[name]
        return [struct.unpack_from("<" + fmt, data, tb["offset"] + i * tb["units"])
                for i in range(tb["count"])]

    raw_strings = bytearray(
        data[tables["strings"]["offset"]:tables["strings"]["offset"]
             + tables["strings"]["count"]])
    if header[1] == 2 and raw_strings:
        prev = 0xCC
        encoded = bytes(raw_strings)
        for i in range(len(encoded) - 1):
            decoded = (prev - (encoded[i] ^ 0xB3)) & 255
            raw_strings[i] = decoded
            prev = (prev + decoded - i) & 255
        raw_strings[-1] = 0
    strings = bytes(raw_strings)

    def name_at(at):
        end = strings.find(b"\0", at)
        if end < at:
            raise ValueError("unterminated schema name")
        return strings[at:end].decode("ascii")

    type_rows = rows("types", "6H")
    base_rows = rows("bases", "2H")
    field_rows = rows("fields", "3H2B")
    ref_rows = rows("refs", "I2H")
    rec_rows = rows("records", "4I")
    comp_rows = rows("components", "3H")

    types = []
    field_at = base_at = 0
    for i, row in enumerate(type_rows):
        types.append({
            "index": i, "name": name_at(row[0]), "fieldCount": row[1],
            "baseCount": row[2], "behaviour": row[3], "atom": row[4],
            "size": row[5], "fieldStart": field_at, "baseStart": base_at,
        })
        field_at += row[1]
        base_at += row[2]
    if field_at != len(field_rows) or base_at != len(base_rows):
        raise ValueError("schema field/base ranges do not consume their tables")
    fields = [{
        "index": i, "name": name_at(row[0]), "type": row[1],
        "offset": row[2], "behaviour": row[3], "array": bool(row[4]),
    } for i, row in enumerate(field_rows)]
    bases = [{"type": row[0], "offset": row[1]} for row in base_rows]
    refs = {row[0]: {"id": row[0], "type": row[1], "record": row[2]}
            for row in ref_rows}
    if len(refs) != len(ref_rows):
        raise ValueError("duplicate XT ref id")

    records = []
    data_at = 0
    comp_at = 0
    for i, (ref, nc, nd, ns) in enumerate(rec_rows):
        if ref >= len(ref_rows) or nc == 0:
            raise ValueError("invalid record ref/component count")
        used = 0
        for typ, count, beh in comp_rows[comp_at:comp_at + nc]:
            used = (used + count * (types[typ]["size"] if beh == 0 else 4)
                    + 3) & ~3
        if used != nd or nd + ns > tables["data"]["count"] - data_at:
            raise ValueError("record data extent mismatch")
        records.append({
            "index": i, "id": ref_rows[ref][0], "type": ref_rows[ref][1],
            "componentStart": comp_at, "componentCount": nc,
            "dataBytes": nd, "stringBytes": ns,
            "dataOffset": tables["data"]["offset"] + data_at,
        })
        data_at += nd + ns
        comp_at += nc
    if comp_at != len(comp_rows) or data_at != tables["data"]["count"]:
        raise ValueError("record data does not consume the data table")
    return {
        "version": header[1], "tables": tables, "types": types,
        "fields": fields, "bases": bases, "refRows": ref_rows,
        "refs": refs, "records": records, "components": comp_rows,
        "data": data,
    }


class XtPack:
    def __init__(self, name: str, relative: str, data: bytes):
        self.name = name
        self.relative = relative
        self.data = data
        self.sha256 = sha256_bytes(data)
        self.xt = parse_xt(data)
        self.by_name = {t["name"]: t for t in self.xt["types"]}

    def type_index(self, name: str) -> int:
        try:
            return self.by_name[name]["index"]
        except KeyError as exc:
            raise ValueError(f"{self.name}: missing XT type {name}") from exc

    def record_image(self, rec: dict) -> bytes:
        start = rec["dataOffset"]
        return self.data[start:start + rec["dataBytes"]]

    def record_strings(self, rec: dict) -> bytes:
        start = rec["dataOffset"] + rec["dataBytes"]
        raw = self.data[start:start + rec["stringBytes"]]
        out = bytearray(raw)
        if self.xt["version"] == 2 and raw:
            prev = 0xCC
            for i in range(len(raw) - 1):
                decoded = (prev - (raw[i] ^ 0xB3)) & 255
                out[i] = decoded
                prev = (prev + decoded - i) & 255
            out[-1] = 0
        return bytes(out)

    def record_name(self, rec: dict, field_offset: int = 0) -> str:
        image = self.record_image(rec)
        strings = self.record_strings(rec)
        at = struct.unpack_from("<I", image, field_offset)[0]
        end = strings.find(b"\0", at)
        if end < at:
            raise ValueError("record string outside blob")
        return strings[at:end].decode("ascii", "replace")

    def components(self, rec: dict) -> list[dict]:
        out = []
        cursor = 0
        types = self.xt["types"]
        for i in range(rec["componentStart"], rec["componentStart"] + rec["componentCount"]):
            typ, count, beh = self.xt["components"][i]
            width = types[typ]["size"] if beh == 0 else 4
            out.append({"type": typ, "count": count, "behaviour": beh,
                        "offset": cursor, "width": width})
            cursor = (cursor + count * width + 3) & ~3
        return out

    def all_fields(self, type_index: int) -> list[dict]:
        """Own fields plus base fields, with absolute-within-type offsets."""
        out = []
        t = self.xt["types"][type_index]
        for bi in range(t["baseStart"], t["baseStart"] + t["baseCount"]):
            base = self.xt["bases"][bi]
            for field in self.all_fields(base["type"]):
                out.append({**field, "offset": field["offset"] + base["offset"]})
        for fi in range(t["fieldStart"], t["fieldStart"] + t["fieldCount"]):
            out.append(dict(self.xt["fields"][fi]))
        return out

    def field(self, type_index: int, name: str) -> dict:
        for field in self.all_fields(type_index):
            if field["name"] == name:
                return field
        raise ValueError(f"{self.name}: type {type_index} has no field {name}")


class XtMaterialDb:
    def __init__(self, game_dir: Path | None = None):
        self.packs = {}
        for name, relative in PACK_FILES.items():
            self.packs[name] = XtPack(name, relative, extract_pack(relative, game_dir))
        self.local = {}
        for name, pack in self.packs.items():
            for index, row in enumerate(pack.xt["refRows"]):
                rid, typ, rec = row
                if rec != 0xFFFF:
                    entry = (name, index, rec, pack.xt["types"][typ]["name"])
                    if rid in self.local:
                        raise ValueError(f"duplicate local XT id {rid}")
                    self.local[rid] = entry

    def resolve(self, pack_name: str, handle: int) -> dict | None:
        if handle == 0xFFFFFFFF:
            return None
        pack = self.packs[pack_name]
        rows = pack.xt["refRows"]
        if handle >= len(rows):
            raise ValueError(f"{pack_name}: handle {handle} outside refs table")
        rid, typ, rec = rows[handle]
        type_name = pack.xt["types"][typ]["name"]
        if rec != 0xFFFF:
            return {
                "pack": pack_name, "handle": handle, "id": rid,
                "type": type_name, "record": pack.xt["records"][rec],
            }
        target = self.local.get(rid)
        if target is None:
            raise ValueError(f"{pack_name}: external id {rid} unresolved")
        target_pack, _row, target_rec, target_type = target
        return {
            "pack": target_pack, "handle": handle, "id": rid,
            "type": target_type,
            "record": self.packs[target_pack].xt["records"][target_rec],
        }

    def provenance(self, resolved: dict, field: str | None = None,
                   offset: int | None = None, size: int | None = None) -> dict:
        pack = self.packs[resolved["pack"]]
        rec = resolved["record"]
        out = {
            "pack": pack.relative,
            "packSha256": pack.sha256,
            "recordIndex": rec["index"],
            "recordId": rec["id"],
            "recordType": resolved["type"],
            "dataOffset": rec["dataOffset"],
        }
        if field is not None:
            out["field"] = field
        if offset is not None:
            out["offset"] = offset
        if size is not None:
            out["bytes"] = size
        return out

    # ---- paint jobs -----------------------------------------------------
    def curve(self, pack_name: str, handle: int) -> dict:
        info = self.resolve(pack_name, handle)
        if info is None or info["type"] != "VEH_Curve":
            raise ValueError(f"handle {handle} is not a VEH_Curve")
        pack = self.packs[info["pack"]]
        rec = info["record"]
        image = pack.record_image(rec)
        comp = pack.components(rec)
        c, e, n = struct.unpack_from("<HHI", image, 0)
        if c == 0xFFFF or n == 0:
            frames = []
        else:
            element = comp[c]
            frames = [struct.unpack_from("<4f", image,
                                          element["offset"] + (e + k) * element["width"])
                      for k in range(n)]
        return {
            "handle": handle, "id": info["id"], "pack": pack.relative,
            "packKey": info["pack"],
            "recordIndex": rec["index"], "recordId": rec["id"],
            "keyFrames": [{"time": f32(f[0]), "value": f32(f[1]),
                           "inTangent": f32(f[2]), "outTangent": f32(f[3])}
                          for f in frames],
            "provenance": self.provenance(info, "keyFrames", rec["dataOffset"],
                                          rec["dataBytes"]),
        }

    def paint_job(self, pack_name: str, handle: int) -> dict:
        info = self.resolve(pack_name, handle)
        if info is None or info["type"] != "VEH_PaintJob":
            raise ValueError(f"handle {handle} is not a VEH_PaintJob")
        pack = self.packs[info["pack"]]
        rec = info["record"]
        image = pack.record_image(rec)
        comp = pack.components(rec)
        c, e, n = struct.unpack_from("<HHI", image, 28)
        if c == 0xFFFF or n == 0:
            colours = []
            colour_offset = None
        else:
            element = comp[c]
            colours = [struct.unpack_from("<3f", image,
                                           element["offset"] + (e + k) * element["width"])
                       for k in range(n)]
            colour_offset = rec["dataOffset"] + element["offset"] + e * element["width"]
        undercoat = struct.unpack_from("<3f", image, 4)
        scuff = struct.unpack_from("<3f", image, 16)
        colour_curve = self.curve(info["pack"], struct.unpack_from("<I", image, 36)[0])
        reflect_curve = self.curve(info["pack"], struct.unpack_from("<I", image, 40)[0])
        return {
            "handle": handle, "id": info["id"], "pack": pack.relative,
            "packKey": info["pack"],
            "recordIndex": rec["index"], "recordId": rec["id"],
            "name": pack.record_name(rec, 0),
            "undercoat": [f32(v) for v in undercoat],
            "scuff": [f32(v) for v in scuff],
            "colours": [[f32(v) for v in colour] for colour in colours],
            "colourCurve": colour_curve,
            "reflectivityCurve": reflect_curve,
            "provenance": {
                "record": self.provenance(info, None),
                "undercoat": self.provenance(info, "undercoatColour", rec["dataOffset"] + 4, 12),
                "scuff": self.provenance(info, "scuffColour", rec["dataOffset"] + 16, 12),
                "colours": self.provenance(info, "colours", colour_offset,
                                           12 * len(colours)) if colours else None,
                "colourCurve": self.provenance(info, "colourCurve", rec["dataOffset"] + 36, 4),
                "reflectivityCurve": self.provenance(info, "reflectivityCurve",
                                                     rec["dataOffset"] + 40, 4),
            },
        }

    # ---- materials ------------------------------------------------------
    def material_value(self, pack_name: str, handle: int) -> dict:
        info = self.resolve(pack_name, handle)
        if info is None:
            raise ValueError("null material handle")
        pack = self.packs[info["pack"]]
        rec = info["record"]
        image = pack.record_image(rec)
        type_name = info["type"]
        value = {"type": type_name}
        offsets = {}
        if type_name == "VEH_MaterialPaint":
            value["codeDamageScale"] = f32(struct.unpack_from("<f", image, 0)[0])
            value["colour"] = [f32(v) for v in struct.unpack_from("<3f", image, 4)]
            offsets = {"colour": (rec["dataOffset"] + 4, 12)}
        elif type_name == "VEH_MaterialGlass":
            value["codeDamageScale"] = f32(struct.unpack_from("<f", image, 0)[0])
            value["tint"] = [f32(v) for v in struct.unpack_from("<3f", image, 4)]
            value["minAlpha"] = f32(struct.unpack_from("<f", image, 16)[0])
            value["maxAlpha"] = f32(struct.unpack_from("<f", image, 20)[0])
            value["minReflectivity"] = f32(struct.unpack_from("<f", image, 24)[0])
            value["maxReflectivity"] = f32(struct.unpack_from("<f", image, 28)[0])
            offsets = {"tint": (rec["dataOffset"] + 4, 12),
                       "minAlpha": (rec["dataOffset"] + 16, 4),
                       "maxAlpha": (rec["dataOffset"] + 20, 4),
                       "minReflectivity": (rec["dataOffset"] + 24, 4),
                       "maxReflectivity": (rec["dataOffset"] + 28, 4)}
        elif type_name == "VEH_MaterialAlloy":
            value["codeDamageScale"] = f32(struct.unpack_from("<f", image, 0)[0])
            value["colour"] = [f32(v) for v in struct.unpack_from("<3f", image, 4)]
            value["specPow"] = f32(struct.unpack_from("<f", image, 16)[0])
            value["specInt"] = f32(struct.unpack_from("<f", image, 20)[0])
            offsets = {"colour": (rec["dataOffset"] + 4, 12),
                       "specPow": (rec["dataOffset"] + 16, 4),
                       "specInt": (rec["dataOffset"] + 20, 4)}
        elif type_name == "VEH_MaterialLight":
            value["codeDamageScale"] = f32(struct.unpack_from("<f", image, 0)[0])
            value["tint"] = [f32(v) for v in struct.unpack_from("<3f", image, 4)]
            value["intensity"] = f32(struct.unpack_from("<f", image, 16)[0])
            offsets = {"tint": (rec["dataOffset"] + 4, 12),
                       "intensity": (rec["dataOffset"] + 16, 4)}
        elif type_name == "VEH_MaterialTyre":
            value["treadDepth"] = f32(struct.unpack_from("<f", image, 0)[0])
            offsets = {"treadDepth": (rec["dataOffset"], 4)}
        elif type_name == "VEH_MaterialBase":
            pass
        else:
            raise ValueError(f"unsupported material type {type_name}")
        return {
            "handle": handle, "id": info["id"], "pack": pack.relative,
            "packKey": info["pack"],
            "recordIndex": rec["index"], "recordId": rec["id"],
            "value": value,
            "provenance": {
                "record": self.provenance(info, None),
                **{name: self.provenance(info, name, offset, size)
                   for name, (offset, size) in offsets.items()},
            },
        }

    def material_defaults(self, pack_name: str, handle: int) -> dict:
        info = self.resolve(pack_name, handle)
        if info is None or info["type"] != "VEH_MaterialDefaults":
            raise ValueError(f"handle {handle} is not VEH_MaterialDefaults")
        pack = self.packs[info["pack"]]
        rec = info["record"]
        image = pack.record_image(rec)
        comp = pack.components(rec)
        c, e, n = struct.unpack_from("<HHI", image, 0)
        if c == 0xFFFF or n == 0:
            handles = []
        else:
            element = comp[c]
            handles = [struct.unpack_from("<I", image,
                                          element["offset"] + (e + k) * 4)[0]
                       for k in range(n)]
        default_paint_job = struct.unpack_from("<I", image, 8)[0]
        entries = []
        for mid in handles:
            instance = self.resolve(info["pack"], mid)
            if instance is None or instance["type"] != "VEH_MaterialInstance":
                raise ValueError(f"material defaults entry {mid} is not VEH_MaterialInstance")
            ipack = self.packs[instance["pack"]]
            irec = instance["record"]
            iimage = ipack.record_image(irec)
            part_code, part_sub = struct.unpack_from("<ii", iimage, 0)
            material_handle = struct.unpack_from("<I", iimage, 8)[0]
            material = self.material_value(instance["pack"], material_handle)
            entries.append({
                "handle": mid, "id": instance["id"],
                "partCode": part_code, "partName": PART_CODE_NAMES.get(part_code),
                "partSubCode": part_sub,
                "partSubName": SUB_CODE_NAMES.get(part_sub),
                "material": material,
                "provenance": {
                    "instance": self.provenance(instance, None),
                    "part": self.provenance(instance, "part", irec["dataOffset"], 8),
                    "material": self.provenance(instance, "material",
                                                irec["dataOffset"] + 8, 4),
                },
            })
        return {
            "handle": handle, "id": info["id"], "pack": pack.relative,
            "packKey": info["pack"],
            "recordIndex": rec["index"], "recordId": rec["id"],
            "defaultPaintJobHandle": default_paint_job,
            "entries": entries,
            "provenance": self.provenance(info, None),
        }

    # ---- vehicle --------------------------------------------------------
    def vehicle(self, name: str) -> dict:
        pack = self.packs["amax"]
        vehicle_type = pack.type_index("AmaxVehicle")
        base_type = pack.type_index("VEH_Vehicle")
        base_field = pack.field(vehicle_type, "baseVehicle")
        paint_field = pack.field(base_type, "paintJobs")
        override_field = pack.field(base_type, "materialOverrides")
        for rec in pack.xt["records"]:
            if rec["type"] != vehicle_type:
                continue
            if pack.record_name(rec, 12) != name:
                continue
            image = pack.record_image(rec)
            comp = pack.components(rec)
            base = base_field["offset"]
            paint_rel = base + paint_field["offset"]
            c, e, n = struct.unpack_from("<HHI", image, paint_rel)
            if c == 0xFFFF or n == 0:
                paint_handles = []
            else:
                element = comp[c]
                paint_handles = [struct.unpack_from("<I", image,
                                                    element["offset"] + (e + k) * 4)[0]
                                 for k in range(n)]
            override_rel = base + override_field["offset"]
            override_handle = struct.unpack_from("<I", image, override_rel)[0]
            return {
                "name": name, "pack": pack.relative,
                "recordIndex": rec["index"], "recordId": rec["id"],
                "paintJobHandles": paint_handles,
                "materialOverridesHandle": override_handle,
                "provenance": {
                    "record": {
                        "pack": pack.relative, "packSha256": pack.sha256,
                        "recordIndex": rec["index"], "recordId": rec["id"],
                        "recordType": "AmaxVehicle", "dataOffset": rec["dataOffset"],
                    },
                    "baseVehicle": {
                        "pack": pack.relative, "offset": rec["dataOffset"] + base,
                        "bytes": self.packs["amax"].xt["types"][base_type]["size"],
                    },
                    "paintJobs": {
                        "pack": pack.relative, "offset": rec["dataOffset"] + paint_rel,
                        "bytes": 8, "count": n,
                    },
                    "materialOverrides": {
                        "pack": pack.relative,
                        "offset": rec["dataOffset"] + override_rel, "bytes": 4,
                    },
                },
            }
        raise ValueError(f"no AmaxVehicle record named {name}")

    def global_material_defaults(self) -> dict:
        pack = self.packs["amax"]
        defaults_type = pack.type_index("AmaxVehicleDefaults")
        rec = next((r for r in pack.xt["records"] if r["type"] == defaults_type), None)
        if rec is None:
            raise ValueError("no AmaxVehicleDefaults record")
        image = pack.record_image(rec)
        handle = struct.unpack_from("<I", image, 0)[0]
        result = self.material_defaults("amax", handle)
        result["sourceRecord"] = {
            "pack": pack.relative, "recordIndex": rec["index"],
            "recordId": rec["id"],
            "provenance": {"pack": pack.relative, "packSha256": pack.sha256,
                           "offset": rec["dataOffset"], "bytes": 4},
        }
        return result


def effective_material_chain(defaults: dict, override: dict | None,
                             part_code: int) -> dict:
    """Reproduce C_MaterialManager::GetXtMaterial(Material.cpp:751-801)."""
    global_by_part = {e["partCode"]: e for e in defaults["entries"]}
    override_by_part = ({e["partCode"]: e for e in override["entries"]}
                        if override else {})
    if part_code in override_by_part:
        entry = override_by_part[part_code]
        path = "vehicle.part"
    elif 0 in override_by_part:
        entry = override_by_part[0]
        path = "vehicle.default"
    elif part_code in global_by_part:
        entry = global_by_part[part_code]
        path = "global.part"
    elif 0 in global_by_part:
        entry = global_by_part[0]
        path = "global.default"
    else:
        entry = None
        path = "none"
    return {"entry": entry, "path": path}


def get_codes(name: str | None) -> dict:
    """Reproduce C_CodeProcessor::GetCodes (CodeProcessor.cpp:218-278)."""
    if not name:
        return {"partCode": 0, "partName": None, "subCode": 0,
                "subName": None, "reason": "empty-element-name"}
    text = name.lower()
    if len(text) > 2:
        if text[0] == "_":
            text = text[1:]
        elif text[1] == "_":
            text = text[2:]
    if not text:
        return {"partCode": 0, "partName": None, "subCode": 0,
                "subName": None, "reason": "empty-after-prefix"}
    pos = text.find("_")
    sub = 0
    if pos != -1 and pos + 1 < len(text):
        sub = SUB_CODES.get(text[pos + 1:], 0)
        text = text[:pos]
    part = PART_CODES.get(text, 0)
    return {
        "partCode": part,
        "partName": PART_CODE_NAMES.get(part),
        "subCode": sub,
        "subName": SUB_CODE_NAMES.get(sub),
        "reason": "ok" if part else "part-name-not-in-s_PartNames",
    }


def exposure(element_name: str | None) -> dict:
    """Per-element parameter exposure from VehicleModelManager.cpp:395-430."""
    text = (element_name or "").lower()
    out = {
        "renderSettings": False, "renderColour": False, "damageSettings": False,
        "branch": None,
    }
    if "e_tyre" in text:
        out.update(renderSettings=True, branch="tyre")
    elif any(tok in text for tok in GLASS_EXPOSURE_TOKENS):
        out.update(renderSettings=True, renderColour=True,
                   damageSettings=True, branch="glass/window")
    elif any(tok in text for tok in ALLOY_EXPOSURE_TOKENS):
        out.update(renderSettings=True, renderColour=True, branch="alloy")
    elif any(tok in text for tok in LIGHT_EXPOSURE_TOKENS):
        out.update(renderColour=True, damageSettings=True, branch="light")
    else:
        out["branch"] = "none"
    return out


def hermite_eval(key_frames: list[dict], position: float) -> float:
    """C_HermiteCurve::Evaluate with the retail degrees->tangent conversion."""
    if len(key_frames) <= 1:
        return 0.0
    frames = []
    for frame in key_frames:
        frames.append({
            "position": f32(frame["time"]),
            "value": f32(frame["value"]),
            "tangentIn": f32(math.tan(f32(frame["inTangent"]) * math.pi / 180.0) / 3.0),
            "tangentOut": f32(math.tan(f32(frame["outTangent"]) * math.pi / 180.0) / 3.0),
        })
    low, high = 0, len(frames) - 1
    while high > low + 1:
        mid = (low + high) >> 1
        if position < frames[mid]["position"]:
            high = mid
        else:
            low = mid
    ka = low
    kb = ka + 1
    if kb >= len(frames):
        return frames[ka]["value"]
    period = f32(frames[kb]["position"] - frames[ka]["position"])
    if period <= 1e-6:
        return frames[ka]["value"]
    u = f32((position - frames[ka]["position"]) / period)
    u = min(max(u, 0.0), 1.0)
    y1 = frames[ka]["value"]
    y4 = frames[kb]["value"]
    y2 = f32(y1 + f32(frames[ka]["tangentOut"] * period))
    y3 = f32(y4 - f32(frames[kb]["tangentIn"] * period))
    u2 = f32(u * u)
    u3 = f32(u2 * u)
    h1 = f32(-u3 + 3.0 * u2 - 3.0 * u + 1.0)
    h2 = f32(3.0 * u3 - 6.0 * u2 + 3.0 * u)
    h3 = f32(-3.0 * u3 + 3.0 * u2)
    h4 = u3
    return f32(f32(f32(y1 * h1) + f32(y2 * h2)) + f32(f32(y3 * h3) + f32(y4 * h4)))


def build_paint_ramp(paint_job: dict, width: int = 512) -> bytes:
    """Reproduce C_PaintJob::UpdateMaterialTexture for a 512x1 RGBA8 ramp."""
    colours = paint_job["colours"]
    if not colours:
        raise ValueError("paint job has no colours")
    out = bytearray()
    count = len(colours)
    for i_width in range(width):
        value = f32(1.0 - i_width / width)
        f_colour = f32((count - 1) * value)
        i_colour = int(f_colour)
        if i_colour == count - 1:
            rgb = colours[-1]
        else:
            frac = f32(f_colour - i_colour)
            lerp = min(max(hermite_eval(paint_job["colourCurve"]["keyFrames"], frac), 0.0), 1.0)
            c1 = colours[i_colour]
            c2 = colours[i_colour + 1]
            rgb = [f32(c1[k] + f32(c2[k] - c1[k]) * lerp) for k in range(3)]
        alpha = min(max(hermite_eval(paint_job["reflectivityCurve"]["keyFrames"], value), 0.0), 1.0)
        for channel in rgb + [alpha]:
            out.append(max(0, min(255, int(channel * 255.0))))
    return bytes(out)


def ramp_sha256(ramp: bytes) -> str:
    return sha256_bytes(ramp)


def json_dump(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
                    encoding="utf-8")
