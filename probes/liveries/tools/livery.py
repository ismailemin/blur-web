"""Decode Blur paint jobs (resprays) and the per-car preset list from shipped XT.

Every value is read at its serialized schema offset.  The only arithmetic is the
source-shaped reproduction of `Vehicle::C_PaintJob::UpdateMaterialTexture`
(`PatchEditor.cpp` / `PaintEditor.cpp`) and `Curve::T_HermiteCurve::GetValue`,
both of which are data transforms on the decoded XT values, not guesses.

No renderer, sampler or shader is executed.
"""

from __future__ import annotations

import math
import struct

from xtlib import (
    AMAX_BIN, GAMEDATA_PAK, SPLITSCREEN_BIN, UI_BIN, VEHICLES_BIN, VEHICLES_LOC,
    XtWorld, enum_labels, load_xt, read_pak_entry, resolve_array, sha256_bytes,
    sz8, type_index, type_name,
)

PAINT_WIDTH = 512
PAINT_HEIGHT = 1

# Source rule: PaintEditor.cpp:276-299 (512x1, heightScale = 1 - x/width).
PAINT_TEXTURE_WIDTH_SOURCE = "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/customisation/PaintEditor.cpp:370"


def f32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def _rgb(image: bytes, offset: int) -> list[float]:
    return list(struct.unpack_from("<3f", image, offset))


def _u32(image: bytes, offset: int) -> int:
    return struct.unpack_from("<I", image, offset)[0]


def _i32(image: bytes, offset: int) -> int:
    return struct.unpack_from("<i", image, offset)[0]


def _bool(image: bytes, offset: int) -> bool:
    return struct.unpack_from("<I", image, offset)[0] != 0


def _field(xt: dict, type_index_: int, name: str) -> dict:
    """Look up a field, following dotted sub-struct names and summing offsets."""
    parts = name.split(".")
    current_type, current_offset = type_index_, 0
    for depth, part in enumerate(parts):
        t = xt["types"][current_type]
        hit = None
        for i in range(t["fieldStart"], t["fieldStart"] + t["fieldCount"]):
            f = xt["fields"][i]
            if f["name"] == part:
                hit = f
                break
        if hit is None:
            raise KeyError(f"{type_name(xt, type_index_)}.{name}")
        if depth == len(parts) - 1:
            return dict(hit, offset=current_offset + hit["offset"])
        if hit["behaviour"] != 3 or hit["array"]:
            raise KeyError(f"{type_name(xt, type_index_)}.{name}: {part} is not a struct")
        current_offset += hit["offset"]
        current_type = hit["type"]
    raise KeyError(name)


def _record_provenance(world: XtWorld, logical: str, rec: dict) -> dict:
    return {
        "file": logical,
        "pak": "game-data/Blur/cache/gamedata.pak",
        "fileSha256": world.sha256[logical],
        "recordIndex": rec["index"],
        "recordId": rec["id"],
        "dataOffset": rec["dataOffset"],
        "dataBytes": rec["dataBytes"],
        "stringBytes": rec["stringBytes"],
    }


# ---------------------------------------------------------------------------
# Curves
# ---------------------------------------------------------------------------

def decode_curve(world: XtWorld, handle: int, logical: str) -> dict | None:
    if handle == 0xFFFFFFFF:
        return None
    curve_file, rec = world.resolve(logical, handle)
    xt = world.files[curve_file]["xt"]
    image = world.local(curve_file, rec)
    ti = type_index(xt, "VEH_Curve")
    off = _field(xt, ti, "keyFrames")["offset"]
    frames = []
    for at in resolve_array(xt, rec, off, image):
        time, value, tan_in, tan_out = struct.unpack_from("<4f", image, at)
        frames.append({
            "time": time,
            "value": value,
            "inTangentDegrees": tan_in,
            "outTangentDegrees": tan_out,
        })
    if len(frames) < 1:
        raise ValueError(f"curve {rec['id']} has no key frames")
    if any(frames[i]["time"] >= frames[i + 1]["time"] for i in range(len(frames) - 1)):
        raise ValueError(f"curve {rec['id']} key frames are not strictly ordered")
    return {
        "recordId": rec["id"],
        "source": _record_provenance(world, curve_file, rec),
        "keyFrames": frames,
    }


def _tangent(degrees: float) -> float:
    # Source: HermiteCurve.h:80-81, tan(degrees * PI / 180) / 3, float32.
    radians = f32(f32(degrees * f32(math.pi)) / 180.0)
    return f32(f32(math.tan(radians)) / 3.0)


def _get_key(frames: list[dict], position: float) -> int:
    low, high = 0, len(frames) - 1
    while high > low + 1:
        mid = (low + high) >> 1
        if position < frames[mid]["time"]:
            high = mid
        else:
            low = mid
    return low


def evaluate_curve(curve: dict, position: float) -> float:
    """Reproduce `Curve::T_HermiteCurve::Evaluate` + `GetValue` (float32)."""
    frames = curve["keyFrames"]
    if len(frames) < 2:
        return 0.0
    position = f32(position)
    ka = _get_key(frames, position)
    kb = ka + 1
    if kb >= len(frames):
        return f32(frames[ka]["value"])
    a, b = frames[ka], frames[kb]
    period = f32(b["time"] - a["time"])
    if period <= 1e-6:
        return f32(a["value"])
    u = f32((position - a["time"]) / period)
    u = min(max(u, 0.0), 1.0)
    y1 = f32(a["value"])
    y4 = f32(b["value"])
    y2 = f32(y1 + f32(_tangent(a["outTangentDegrees"]) * period))
    y3 = f32(y4 - f32(_tangent(b["inTangentDegrees"]) * period))
    u2 = f32(u * u)
    u3 = f32(u2 * u)
    h1 = f32(f32(f32(-u3 + f32(3.0 * u2)) - f32(3.0 * u)) + 1.0)
    h2 = f32(f32(f32(3.0 * u3) - f32(6.0 * u2)) + f32(3.0 * u))
    h3 = f32(f32(-3.0 * u3) + f32(3.0 * u2))
    h4 = u3
    return f32(f32(f32(y1 * h1) + f32(y2 * h2)) + f32(f32(y3 * h3) + f32(y4 * h4)))


def _lerp(a: float, b: float, t: float) -> float:
    return f32(a + f32(f32(b - a) * t))


def paint_texel(colours: list[list[float]], colour_curve: dict,
                reflectivity_curve: dict, value: float) -> tuple[int, int, int, int]:
    """One texel of `C_PaintJob::UpdateMaterialTexture` (PaintEditor.cpp:276-355)."""
    value = f32(value)
    if not colours:
        return (0, 0, 0, 0)
    n = len(colours)
    if n == 1:
        rgb = colours[0]
    else:
        f_colour = _lerp(0.0, float(n - 1), value)
        integral = math.floor(f_colour)
        frac = f32(f_colour - integral)
        index = int(integral)
        if index >= n - 1:
            rgb = colours[-1]
        else:
            t = evaluate_curve(colour_curve, frac)
            t = min(max(t, 0.0), 1.0)
            rgb = [_lerp(colours[index][k], colours[index + 1][k], t) for k in range(3)]
    r = int(min(max(rgb[0], 0.0), 1.0) * 255.0)
    g = int(min(max(rgb[1], 0.0), 1.0) * 255.0)
    b = int(min(max(rgb[2], 0.0), 1.0) * 255.0)
    a = int(min(max(evaluate_curve(reflectivity_curve, value), 0.0), 1.0) * 255.0)
    return (r, g, b, a)


def paint_table(preset: dict) -> bytes:
    """The exact 512x1 RGBA8 table the retail paint texture would contain."""
    out = bytearray()
    for x in range(PAINT_WIDTH):
        # fHeightScale = 1.0f - (float)iWidth / (float)width
        value = f32(1.0 - f32(float(x) / float(PAINT_WIDTH)))
        out.extend(bytes(paint_texel(preset["colours"], preset["colourCurve"],
                                     preset["reflectivityCurve"], value)))
    return bytes(out)


# ---------------------------------------------------------------------------
# Paint jobs
# ---------------------------------------------------------------------------

def decode_paint_job(world: XtWorld, record_id: int) -> dict:
    hit = world.by_id.get(record_id)
    if hit is None:
        raise ValueError(f"paint job id {record_id} is not in any loaded XT file")
    logical, rec = hit
    xt = world.files[logical]["xt"]
    if type_name(xt, rec["type"]) != "VEH_PaintJob":
        raise ValueError(f"id {record_id} is {type_name(xt, rec['type'])}, not VEH_PaintJob")
    image = world.local(logical, rec)
    ti = type_index(xt, "VEH_PaintJob")
    f_name = _field(xt, ti, "name")
    f_under = _field(xt, ti, "undercoatColour")
    f_scuff = _field(xt, ti, "scuffColour")
    f_colours = _field(xt, ti, "colours")
    f_cc = _field(xt, ti, "colourCurve")
    f_rc = _field(xt, ti, "reflectivityCurve")

    name = sz8(xt, world.files[logical]["data"], rec, f_name["offset"])
    colours = [_rgb(image, at) for at in resolve_array(xt, rec, f_colours["offset"], image)]
    if not 1 <= len(colours) <= 16:
        raise ValueError(f"paint job {record_id} has {len(colours)} colour stops")
    colour_curve = decode_curve(world, _u32(image, f_cc["offset"]), logical)
    reflectivity_curve = decode_curve(world, _u32(image, f_rc["offset"]), logical)
    for label, curve in (("colourCurve", colour_curve), ("reflectivityCurve", reflectivity_curve)):
        if curve is None:
            raise ValueError(f"paint job {record_id} has a null {label}")
        if len(curve["keyFrames"]) < 2:
            raise ValueError(f"paint job {record_id} {label} is not valid (needs 2 keys)")

    preset = {
        "presetId": record_id,
        "name": name,
        "localizedName": None,
        "localizedNameReason": "VEH_PaintJob has no LocId field; name is the non-localized authoring label",
        "undercoat": _rgb(image, f_under["offset"]),
        "scuff": _rgb(image, f_scuff["offset"]),
        "colours": colours,
        "colourCurve": colour_curve,
        "reflectivityCurve": reflectivity_curve,
        "swatch": colours[0],
        "source": _record_provenance(world, logical, rec),
        "fieldOffsets": {
            "name": f_name["offset"],
            "undercoatColour": f_under["offset"],
            "scuffColour": f_scuff["offset"],
            "colours": f_colours["offset"],
            "colourCurve": f_cc["offset"],
            "reflectivityCurve": f_rc["offset"],
        },
    }
    table = paint_table(preset)
    preset["table"] = {
        "width": PAINT_WIDTH,
        "height": PAINT_HEIGHT,
        "channelOrder": "RGBA8",
        "shaderSampler": "SRGB_TEXTURE (vehicle_common.h:580-590)",
        "valueOfTexelX": "1 - x/512",
        "rgbaSha256": sha256_bytes(table),
        "firstTexelSrgb": list(table[:4]),
        "lastTexelSrgb": list(table[-4:]),
        "reflectivityMin": min(b[3] for b in _chunks(table)),
        "reflectivityMax": max(b[3] for b in _chunks(table)),
    }
    return preset


def _chunks(table: bytes):
    for i in range(0, len(table), 4):
        yield table[i:i + 4]


# ---------------------------------------------------------------------------
# Material defaults
# ---------------------------------------------------------------------------

_MATERIAL_FIELDS = {
    "VEH_MaterialBase": [],
    "VEH_MaterialPaint": ["colour"],
    "VEH_MaterialGlass": ["tint", "minAlpha", "maxAlpha", "minReflectivity", "maxReflectivity"],
    "VEH_MaterialTyre": ["treadDepth"],
    "VEH_MaterialAlloy": ["colour", "specPow", "specInt"],
    "VEH_MaterialLight": ["tint", "intensity"],
}


def decode_material(world: XtWorld, handle: int, logical: str) -> dict | None:
    if handle == 0xFFFFFFFF:
        return None
    mat_file, rec = world.resolve(logical, handle)
    xt = world.files[mat_file]["xt"]
    tname = type_name(xt, rec["type"])
    if tname not in _MATERIAL_FIELDS:
        raise ValueError(f"unsupported material type {tname} for id {rec['id']}")
    image = world.local(mat_file, rec)
    values: dict[str, object] = {"codeDamageScale": f32(struct.unpack_from("<f", image, 0)[0])}
    for field in _MATERIAL_FIELDS[tname]:
        f = _field(xt, rec["type"], field)
        if field in ("colour", "tint"):
            values[field] = _rgb(image, f["offset"])
        else:
            values[field] = f32(struct.unpack_from("<f", image, f["offset"])[0])
    return {
        "materialId": rec["id"],
        "type": tname,
        "values": values,
        "source": _record_provenance(world, mat_file, rec),
    }


def decode_material_defaults(world: XtWorld, handle: int, logical: str) -> dict | None:
    if handle == 0xFFFFFFFF:
        return None
    md_file, rec = world.resolve(logical, handle)
    xt = world.files[md_file]["xt"]
    if type_name(xt, rec["type"]) != "VEH_MaterialDefaults":
        raise ValueError(f"expected VEH_MaterialDefaults, got {type_name(xt, rec['type'])}")
    image = world.local(md_file, rec)
    ti = type_index(xt, "VEH_MaterialDefaults")
    f_defaults = _field(xt, ti, "defaults")
    f_paint = _field(xt, ti, "defaultPaintJob")
    part_xt = world.files[md_file]["xt"]
    part_code = enum_labels(part_xt, type_index(part_xt, "VEH_PartCode"))
    sub_code = enum_labels(part_xt, type_index(part_xt, "VEH_PartSubCode"))
    instances = []
    for at in resolve_array(xt, rec, f_defaults["offset"], image):
        inst_file, inst = world.resolve(md_file, _u32(image, at))
        inst_image = world.local(inst_file, inst)
        inst_xt = world.files[inst_file]["xt"]
        if type_name(inst_xt, inst["type"]) != "VEH_MaterialInstance":
            raise ValueError("expected VEH_MaterialInstance")
        i_ti = type_index(inst_xt, "VEH_MaterialInstance")
        part_off = _field(inst_xt, i_ti, "part")["offset"]
        material_off = _field(inst_xt, i_ti, "material")["offset"]
        code = _i32(inst_image, part_off)
        sub = _i32(inst_image, part_off + 4)
        material = decode_material(world, _u32(inst_image, material_off), inst_file)
        instances.append({
            "partCode": code,
            "part": part_code[code] if 0 <= code < len(part_code) else f"unknown:{code}",
            "subCode": sub,
            "subPart": sub_code[sub] if 0 <= sub < len(sub_code) else f"unknown:{sub}",
            "material": material,
        })
    paint_handle = _u32(image, f_paint["offset"])
    default_paint = None if paint_handle == 0xFFFFFFFF else decode_paint_job(
        world, world.resolve(md_file, paint_handle)[1]["id"])
    return {
        "materialDefaultsId": rec["id"],
        "instances": instances,
        "defaultPaintPresetId": None if default_paint is None else default_paint["presetId"],
        "defaultPaintName": None if default_paint is None else default_paint["name"],
        "source": _record_provenance(world, md_file, rec),
    }


# ---------------------------------------------------------------------------
# Garage palette
# ---------------------------------------------------------------------------

PALETTE_CATEGORIES = ("Solid_A", "Solid_B", "Solid_C", "Metallic",
                      "Pearlecent", "Candy", "Splitscreen")


def decode_palette(world: XtWorld) -> dict:
    logical = UI_BIN
    xt = world.files[logical]["xt"]
    data = world.files[logical]["data"]
    cfg = next(r for r in xt["records"] if type_name(xt, r["type"]) == "UiXtConfig")
    image = world.local(logical, cfg)
    ti = type_index(xt, "UiXtConfig")
    f_garage = _field(xt, ti, "GarageResprays")
    categories = {}
    for name in PALETTE_CATEGORIES:
        f = _field(xt, ti, f"GarageResprays.{name}")
        ids = []
        for at in resolve_array(xt, cfg, f["offset"], image):
            hit = world.resolve(logical, _u32(image, at))
            if hit is None:
                raise ValueError(f"palette {name} contains a null handle")
            if type_name(world.files[hit[0]]["xt"], hit[1]["type"]) != "VEH_PaintJob":
                raise ValueError(f"palette {name} references a non-paint job")
            ids.append(hit[1]["id"])
        categories[name] = ids
    black_off = _field(xt, ti, "GarageResprays.Solid_Black")["offset"]
    black = world.resolve(logical, _u32(image, black_off))
    return {
        "source": _record_provenance(world, logical, cfg),
        "categories": categories,
        "solidBlack": None if black is None else black[1]["id"],
        "garageOrder": {
            "solid": "sIndex = column; sIndexV 0 = Solid_Black, 1 = Solid_C, 2 = Solid_B, 3 = Solid_A",
            "paged": "sIndex = column for Metallic, Pearlecent and Candy (UIColourPicker.cpp:271-276)",
        },
        "splitscreenUse": "GetSplitscreenResprays (Lua_Multiplayer.cpp:1599-1624), 8 team colours",
    }


# ---------------------------------------------------------------------------
# Loc
# ---------------------------------------------------------------------------

class LocTable:
    def __init__(self, pak=GAMEDATA_PAK, logical=VEHICLES_LOC):
        import olt
        _, raw = read_pak_entry(pak, logical)
        self.loc = olt.read_olt(raw, logical)
        self.by_hash = self.loc.key_by_hash
        self.en = self.loc.strings("en")
        self.sha256 = sha256_bytes(raw)
        self.logical = logical

    def lookup(self, loc_id: int) -> dict | None:
        key = self.by_hash.get(loc_id)
        if key is None:
            return None
        return {"locId": loc_id, "key": key, "en": self.en.get(key)}


# ---------------------------------------------------------------------------
# Vehicles
# ---------------------------------------------------------------------------

def decode_amax_vehicles(world: XtWorld) -> list[dict]:
    logical = AMAX_BIN
    xt = world.files[logical]["xt"]
    data = world.files[logical]["data"]
    vi = type_index(xt, "AmaxVehicle")
    leaves = {leaf["name"]: leaf for leaf in _leaves(xt, vi)}
    part_code = enum_labels(xt, type_index(xt, "VEH_PartCode"))
    vehicles = []
    for rec in xt["records"]:
        if rec["type"] != vi:
            continue
        image = world.local(logical, rec)
        paint_ids = []
        for at in resolve_array(xt, rec, leaves["baseVehicle.paintJobs"]["offset"], image):
            hit = world.resolve(logical, _u32(image, at))
            paint_ids.append(None if hit is None else hit[1]["id"])
        material_overrides_handle = _u32(image, leaves["baseVehicle.materialOverrides"]["offset"])
        dynamics_handle = _u32(image, leaves["dynamics"]["offset"])
        dynamics = None if dynamics_handle == 0xFFFFFFFF else world.resolve(logical, dynamics_handle)[1]["id"]
        industry = _u32(image, leaves["Manufacturer"]["offset"])
        manufacturer = None if industry == 0xFFFFFFFF else world.name_of(*world.resolve(logical, industry))
        vehicle = {
            "tag": world.name_of(logical, rec),
            "recordId": rec["id"],
            "recordIndex": rec["index"],
            "dataOffset": rec["dataOffset"],
            "dataBytes": rec["dataBytes"],
            "paintPresetIds": paint_ids,
            "materialOverridesHandle": material_overrides_handle,
            "dynamicsId": dynamics,
            "locId": _u32(image, 20),
            "locIdFull": _u32(image, leaves["locStringFull"]["offset"]),
            "uiIconName": sz8(xt, data, rec, leaves["UiIconName"]["offset"]),
            "canRespray": _bool(image, leaves["UICanReSpray"]["offset"]),
            "use": _bool(image, leaves["use"]["offset"]),
            "doNotShowInGame": _bool(image, leaves["DoNotShowInGame"]["offset"]),
            "locked": _bool(image, leaves["Locked"]["offset"]),
            "parentVehicle": None if _u32(image, leaves["parentVehicle"]["offset"]) == 0xFFFFFFFF
            else world.resolve(logical, _u32(image, leaves["parentVehicle"]["offset"]))[1]["id"],
            "class": _i32(image, leaves["class"]["offset"]),
            "manufacturer": manufacturer,
            "source": _record_provenance(world, logical, rec),
        }
        vehicles.append(vehicle)
    return vehicles


def _leaves(xt: dict, ti: int) -> list[dict]:
    import car_xt
    return car_xt.leaves(xt, ti)


def decode_global_defaults(world: XtWorld) -> dict:
    logical = AMAX_BIN
    xt = world.files[logical]["xt"]
    rec = next(r for r in xt["records"] if type_name(xt, r["type"]) == "AmaxVehicleDefaults")
    image = world.local(logical, rec)
    ti = type_index(xt, "AmaxVehicleDefaults")
    handle = _u32(image, _field(xt, ti, "materials")["offset"])
    defaults = decode_material_defaults(world, handle, logical)
    return {
        "recordId": rec["id"],
        "materialDefaults": defaults,
        "source": _record_provenance(world, logical, rec),
    }


def decode_texture_refs(world: XtWorld) -> dict:
    """Other shipped references to paint jobs (team paints, pink achievement list)."""
    out = {}
    for logical, path in ((MULTIPLAYER_BIN, "multiplayer.bin"), (ACHIEVEMENTS_BIN, "achievements.bin")):
        from xtlib import load_xt as _load
        xt, data = _load(GAMEDATA_PAK, logical)
        refs = world.files[logical]["refs"]
        found = []
        for handle, (rid, tid, ridx) in enumerate(refs):
            if type_name(xt, tid) != "VEH_PaintJob":
                continue
            if ridx != 0xFFFF:
                continue
            found.append({"handle": handle, "presetId": rid})
        out[path] = found
    return out
