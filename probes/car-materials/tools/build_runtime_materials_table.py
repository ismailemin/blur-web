"""Build the committed 25-car runtime material manifest.

This is the data stage behind ``probes/car-materials/runtime-materials.mjs``.
It reads only retail sources plus the committed roster:

* ``probes/e1-drive/cars/roster.json`` -- the authoritative 25 slugs and order.
* ``_work/car-parts/cars/index.json`` -- the record-level ``amaxTag`` link for
  the seven roster names that carry a decoration (``grpc``, ``1stplay``,
  ``StockE3``, ...). The link is the committed ``modelMapping`` record
  (``AmaxVehicle.dynamics`` handle -> ``RP_CarDynamics`` id -> vehicle tag),
  never name similarity.
* ``\\gamedata\\xt\\amax.bin`` -- ``AmaxVehicle`` paint job handles and the
  per-vehicle material override handle.
* ``\\gamedata\\xt\\vehicles.bin`` -- ``VEH_PaintJob``, ``VEH_Curve`` and the
  ``VEH_MaterialGlass|Light|Alloy`` records.

For each car it resolves the stock paint job, the glass material for part code
23 (window), the light material for part code 27 (headlight) and the alloy
material for part code 6 (alloy), following the retail lookup order in
``C_MaterialManager::GetXtMaterial`` (Material.cpp:751-801).

Every value is either copied verbatim from the decoded retail record or derived
by a documented rule:

* ``baseColour`` -- the paint ramp texel the retail shader samples at
  ``NdotV -> 1`` (``tex2Dlod(PaintTextureSampler, (saturate(dot(N,V)), 0))``),
  i.e. ramp index 511, sRGB-decoded to linear. Alpha is the opaque paint blend
  alpha (1.0), not the ramp's reflectivity channel.
* ``glass`` / ``emissive`` / ``emissiveStrength`` / ``alloy`` -- verbatim copies
  of the decoded XtRgb / F32 fields (linear, no sRGB decode).

Fields the retail format does not serialize (``metallic``, ``roughness``) are
omitted and listed in ``missing`` with the absent ``Record.field`` path and the
fields that were searched instead. Nothing is given a guessed default.

Output: ``probes/car-materials/data/runtime-materials.json`` by default.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PROBE_TOOLS = Path(__file__).resolve().parent
if str(PROBE_TOOLS) not in sys.path:
    sys.path.insert(0, str(PROBE_TOOLS))

import xt_vehicle_materials as xt  # noqa: E402

ROSTER = ROOT / "probes/e1-drive/cars/roster.json"
CARS_INDEX = ROOT / "_work/car-parts/cars/index.json"
DEFAULT_OUT = ROOT / "probes/car-materials/data/runtime-materials.json"

MANIFEST_SCHEMA = "blur.car-materials-runtime-manifest/1"
RUNTIME_SCHEMA = "blur.car-materials-runtime/1"
CAR_COUNT = 25

# Part codes resolved per car (CodeProcessor.cpp:74-143,218-278).
GLASS_PART = 23       # window
LIGHT_PART = 27       # headlight
ALLOY_PART = 6        # alloy

# The retail paint ramp is 512x1 RGBA8 (PaintEditor.cpp:253-302).
RAMP_WIDTH = 512
RAMP_HEIGHT = 1
# tex2Dlod(PaintTextureSampler, float4(saturate(dot(N,V)), 0, 0, 0)) with CLAMP:
# NdotV -> 1 samples the last texel.
BASE_COLOUR_TEXEL = RAMP_WIDTH - 1

COLOUR_SPACE = {
    "baseColour": {
        "space": "linear-rgb",
        "reason": "the retail paint ramp is an sRGB-encoded A8R8G8B8 texture "
                  "(PaintEditor.cpp:370, PaintTextureSampler SRGB_TEXTURE in "
                  "vehicle_common.h:579-590); baseColour decodes the stored byte "
                  "sRGB->linear exactly once",
    },
    "paintRamp": {
        "space": "srgb-encoded-rgba8",
        "reason": "the committed ramp bytes are the retail texture bytes; alpha "
                  "is the linear reflectivity curve",
    },
    "materialColours": {
        "space": "linear-rgb",
        "reason": "XtRgb values are uploaded as F32 shader constants "
                  "(g_vRenderColour/g_vMaterialColour) with no sRGB decode",
    },
    "alpha": {
        "space": "linear",
        "reason": "paint alpha is the opaque blend alpha (1.0); glass alpha "
                  "bounds are serialized F32 values",
    },
}

# Fields the retail format does not serialize. `sourceField` is the absent
# dotted path; `searchedFields` are the serialized VEH_PaintJob fields that were
# inspected instead. verify_runtime_materials.mjs proves `sourceField` is really
# absent from the XT schema and that every `searchedFields` entry exists.
MISSING_FIELDS = [
    {
        "field": "metallic",
        "sourceField": "VEH_PaintJob.metallic",
        "present": False,
        "searchedFields": [
            "undercoatColour", "scuffColour", "colours",
            "colourCurve", "reflectivityCurve",
        ],
        "reason": "VEH_PaintJob serializes undercoatColour, scuffColour, colours, "
                  "colourCurve and reflectivityCurve only; there is no metallic/F0 "
                  "scalar. reflectivityCurve is a Fresnel reflectivity, not a "
                  "metallic workflow input.",
    },
    {
        "field": "roughness",
        "sourceField": "VEH_PaintJob.roughness",
        "present": False,
        "searchedFields": ["reflectivityCurve"],
        "reason": "No roughness/microfacet scalar is serialized. reflectivityCurve "
                  "is a Fresnel reflectivity term; converting it to a roughness "
                  "would be a guess, so the field is omitted.",
    },
]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def display(path: Path) -> str:
    try:
        return rel(path)
    except ValueError:
        return str(path.resolve())


def srgb_to_linear(channel: float) -> float:
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def f32_list(values) -> list[float]:
    return [xt.f32(float(value)) for value in values]


def record_fields(pack: xt.XtPack, type_name: str) -> list[str]:
    type_index = pack.type_index(type_name)
    return sorted(field["name"] for field in pack.all_fields(type_index))


def resolve_amax_tag(car: dict) -> tuple[str, int | None]:
    """Return (tag, expected record id) using the committed record-level link."""
    mapping = car.get("modelMapping")
    if mapping:
        tag = mapping["amaxTag"]
        if not mapping.get("handleResolvesToExactRecordId"):
            raise RuntimeError(
                f"{car['slug']}: modelMapping does not prove the amax record id")
        if mapping.get("nameSimilarityUsed"):
            raise RuntimeError(f"{car['slug']}: modelMapping used name similarity")
        return tag, int(mapping["amaxRecordId"])
    return car["name"], None


def material_entry(chain: dict, expected: str, slug: str, part: str) -> dict:
    entry = chain["entry"]
    if entry is None:
        raise RuntimeError(f"{slug}: no {part} material in the retail lookup chain")
    value = entry["material"]["value"]
    if value["type"] != expected:
        raise RuntimeError(
            f"{slug}: {part} material is {value['type']}, expected {expected}")
    return entry


def build_car(db: xt.XtMaterialDb, car: dict, roster_entry: dict,
              global_defaults: dict, default_paint_job: dict) -> dict:
    slug = car["slug"]
    tag, expected_id = resolve_amax_tag(car)
    vehicle = db.vehicle(tag)
    if expected_id is not None and vehicle["recordId"] != expected_id:
        raise RuntimeError(
            f"{slug}: amax record id {vehicle['recordId']} != modelMapping "
            f"amaxRecordId {expected_id}")

    override = None
    if vehicle["materialOverridesHandle"] != 0xFFFFFFFF:
        override = db.material_defaults("amax", vehicle["materialOverridesHandle"])

    # ---- paint ---------------------------------------------------------
    if vehicle["paintJobHandles"]:
        paint_job = db.paint_job("amax", vehicle["paintJobHandles"][0])
        fallback = False
        selection = "first-paint-job"
    else:
        paint_job = default_paint_job
        fallback = True
        selection = "material-default-paint-job"

    ramp = xt.build_paint_ramp(paint_job, RAMP_WIDTH)
    if len(ramp) != RAMP_WIDTH * RAMP_HEIGHT * 4:
        raise RuntimeError(f"{slug}: paint ramp is {len(ramp)} bytes")
    texel = ramp[BASE_COLOUR_TEXEL * 4:BASE_COLOUR_TEXEL * 4 + 4]
    base_colour = [srgb_to_linear(channel / 255.0) for channel in texel[:3]] + [1.0]

    paint_raw = {
        "paintJob": {
            "name": paint_job["name"],
            "handle": paint_job["handle"],
            "recordId": paint_job["recordId"],
            "recordIndex": paint_job["recordIndex"],
            "pack": paint_job["pack"],
            "selection": selection,
            "fallbackUsed": fallback,
        },
        "colours": [f32_list(colour) for colour in paint_job["colours"]],
        "undercoatColour": f32_list(paint_job["undercoat"]),
        "scuffColour": f32_list(paint_job["scuff"]),
        "colourCurve": paint_job["colourCurve"],
        "reflectivityCurve": paint_job["reflectivityCurve"],
        "ramp": {
            "width": RAMP_WIDTH,
            "height": RAMP_HEIGHT,
            "format": "RGBA8",
            "sha256": sha256_bytes(ramp),
            "base64": base64.b64encode(ramp).decode("ascii"),
        },
    }
    paint_derived = {
        "baseColour": base_colour,
        "sample": {
            "rampIndex": BASE_COLOUR_TEXEL,
            "uv": [1.0, 0.0],
            "rule": "tex2Dlod(PaintTextureSampler, (saturate(dot(N,V)), 0)) with "
                    "CLAMP samples the last texel at NdotV->1",
            "encoding": "srgb-byte -> linear-rgb; alpha is the opaque paint alpha",
        },
    }

    # ---- glass ---------------------------------------------------------
    glass_chain = xt.effective_material_chain(global_defaults, override, GLASS_PART)
    glass_entry = material_entry(glass_chain, "VEH_MaterialGlass", slug, "glass")
    glass_value = glass_entry["material"]["value"]
    glass_raw = {
        "partCode": GLASS_PART,
        "partName": xt.PART_CODE_NAMES[GLASS_PART],
        "lookupPath": glass_chain["path"],
        "recordId": glass_entry["material"]["recordId"],
        "recordIndex": glass_entry["material"]["recordIndex"],
        "pack": glass_entry["material"]["pack"],
        "tint": f32_list(glass_value["tint"]),
        "minAlpha": xt.f32(glass_value["minAlpha"]),
        "maxAlpha": xt.f32(glass_value["maxAlpha"]),
        "minReflectivity": xt.f32(glass_value["minReflectivity"]),
        "maxReflectivity": xt.f32(glass_value["maxReflectivity"]),
    }
    glass_derived = {
        "tint": list(glass_raw["tint"]),
        "minAlpha": glass_raw["minAlpha"],
        "maxAlpha": glass_raw["maxAlpha"],
        "minReflectivity": glass_raw["minReflectivity"],
        "maxReflectivity": glass_raw["maxReflectivity"],
        "blend": {"src": "One", "dest": "InvSrcAlpha", "alphaTest": True},
    }

    # ---- light ---------------------------------------------------------
    light_chain = xt.effective_material_chain(global_defaults, override, LIGHT_PART)
    light_entry = material_entry(light_chain, "VEH_MaterialLight", slug, "light")
    light_value = light_entry["material"]["value"]
    light_raw = {
        "partCode": LIGHT_PART,
        "partName": xt.PART_CODE_NAMES[LIGHT_PART],
        "lookupPath": light_chain["path"],
        "recordId": light_entry["material"]["recordId"],
        "recordIndex": light_entry["material"]["recordIndex"],
        "pack": light_entry["material"]["pack"],
        "tint": f32_list(light_value["tint"]),
        "intensity": xt.f32(light_value["intensity"]),
    }
    light_derived = {
        "emissive": list(light_raw["tint"]),
        "emissiveStrength": light_raw["intensity"],
    }

    # ---- alloy ---------------------------------------------------------
    alloy_chain = xt.effective_material_chain(global_defaults, override, ALLOY_PART)
    alloy_entry = material_entry(alloy_chain, "VEH_MaterialAlloy", slug, "alloy")
    alloy_value = alloy_entry["material"]["value"]
    alloy_raw = {
        "partCode": ALLOY_PART,
        "partName": xt.PART_CODE_NAMES[ALLOY_PART],
        "lookupPath": alloy_chain["path"],
        "recordId": alloy_entry["material"]["recordId"],
        "recordIndex": alloy_entry["material"]["recordIndex"],
        "pack": alloy_entry["material"]["pack"],
        "colour": f32_list(alloy_value["colour"]),
        "specPow": xt.f32(alloy_value["specPow"]),
        "specInt": xt.f32(alloy_value["specInt"]),
    }
    alloy_derived = {
        "colour": list(alloy_raw["colour"]),
        "specPow": alloy_raw["specPow"],
        "specInt": alloy_raw["specInt"],
    }

    return {
        "slug": slug,
        "name": roster_entry["name"],
        "amaxTag": tag,
        "amaxRecordId": vehicle["recordId"],
        "paint": {"raw": paint_raw, "derived": paint_derived},
        "glass": {"raw": glass_raw, "derived": glass_derived},
        "light": {"raw": light_raw, "derived": light_derived},
        "alloy": {"raw": alloy_raw, "derived": alloy_derived},
        "missing": [dict(entry) for entry in MISSING_FIELDS],
        "source": {
            "amaxTag": tag,
            "amaxRecordId": vehicle["recordId"],
            "paintJob": {
                "name": paint_raw["paintJob"]["name"],
                "handle": paint_raw["paintJob"]["handle"],
                "recordId": paint_raw["paintJob"]["recordId"],
                "recordIndex": paint_raw["paintJob"]["recordIndex"],
                "pack": paint_raw["paintJob"]["pack"],
                "selection": selection,
                "fallbackUsed": fallback,
            },
            "glass": {
                "recordId": glass_raw["recordId"],
                "recordIndex": glass_raw["recordIndex"],
                "pack": glass_raw["pack"],
                "partCode": GLASS_PART,
                "lookupPath": glass_chain["path"],
            },
            "light": {
                "recordId": light_raw["recordId"],
                "recordIndex": light_raw["recordIndex"],
                "pack": light_raw["pack"],
                "partCode": LIGHT_PART,
                "lookupPath": light_chain["path"],
            },
            "alloy": {
                "recordId": alloy_raw["recordId"],
                "recordIndex": alloy_raw["recordIndex"],
                "pack": alloy_raw["pack"],
                "partCode": ALLOY_PART,
                "lookupPath": alloy_chain["path"],
            },
        },
    }


def build_document() -> dict:
    roster = json.loads(ROSTER.read_text(encoding="utf-8"))
    roster_slugs = [entry["slug"] for entry in roster["cars"]]
    if len(roster_slugs) != CAR_COUNT:
        raise RuntimeError(
            f"roster has {len(roster_slugs)} cars, expected {CAR_COUNT}")
    if len(set(roster_slugs)) != CAR_COUNT:
        raise RuntimeError("roster slugs are not unique")

    cars_index = json.loads(CARS_INDEX.read_text(encoding="utf-8"))
    by_slug = {car["slug"]: car for car in cars_index["cars"]}
    missing = [slug for slug in roster_slugs if slug not in by_slug]
    if missing:
        raise RuntimeError(f"cars index is missing roster slugs {missing}")

    db = xt.XtMaterialDb()
    global_defaults = db.global_material_defaults()
    default_paint_job = db.paint_job(
        global_defaults["packKey"], global_defaults["defaultPaintJobHandle"])

    vehicles_pack = db.packs["vehicles"]
    source_fields = {
        name: record_fields(vehicles_pack, name)
        for name in ("VEH_PaintJob", "VEH_MaterialGlass",
                     "VEH_MaterialLight", "VEH_MaterialAlloy")
    }
    for entry in MISSING_FIELDS:
        record, field = entry["sourceField"].split(".", 1)
        if record not in source_fields:
            raise RuntimeError(f"missing entry names unknown record {record}")
        if field in source_fields[record]:
            raise RuntimeError(
                f"missing entry claims {entry['sourceField']} is absent, but the "
                f"XT schema serializes it")
        unknown = [name for name in entry["searchedFields"]
                   if name not in source_fields[record]]
        if unknown:
            raise RuntimeError(
                f"missing entry searches unknown fields {unknown} on {record}")

    cars = {}
    for roster_entry in roster["cars"]:
        slug = roster_entry["slug"]
        cars[slug] = build_car(db, by_slug[slug], roster_entry,
                               global_defaults, default_paint_job)

    return {
        "schema": MANIFEST_SCHEMA,
        "kind": "blur.car-materials-runtime",
        "version": 1,
        "generatedBy": "probes/car-materials/tools/build_runtime_materials_table.py",
        "scope": "Retail paint, glass, light and alloy material values for the 25-car "
                 "roster, decoded from the shipped XT packs. Values are copied "
                 "verbatim or derived by a documented rule; fields the format does "
                 "not serialize are absent and listed in `missing`.",
        "colourSpace": COLOUR_SPACE,
        "roster": {
            "path": rel(ROSTER),
            "sha256": sha256_file(ROSTER),
            "carCount": len(roster_slugs),
            "order": roster_slugs,
        },
        "sources": {
            name: {
                "path": pack.relative,
                "sha256": pack.sha256,
                "bytes": len(pack.data),
            }
            for name, pack in db.packs.items()
        },
        "sourceFields": source_fields,
        "missingFields": [dict(entry) for entry in MISSING_FIELDS],
        "cars": cars,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out = args.out.resolve()
    for forbidden in (ROOT / "game-data", ROOT / "upstream"):
        if out.is_relative_to(forbidden.resolve()):
            parser.error(f"output must not be inside {forbidden.name}")

    document = build_document()
    text = json.dumps(document, indent=2, sort_keys=True,
                      ensure_ascii=False) + "\n"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8", newline="\n")

    recovered = {
        "paint": sum(1 for car in document["cars"].values() if "baseColour" in car["paint"]["derived"]),
        "glass": sum(1 for car in document["cars"].values() if "tint" in car["glass"]["derived"]),
        "emissive": sum(1 for car in document["cars"].values() if "emissive" in car["light"]["derived"]),
        "alloy": sum(1 for car in document["cars"].values() if "colour" in car["alloy"]["derived"]),
    }
    print(f"wrote {display(out)} sha256 {sha256_bytes(text.encode('utf-8'))}")
    print(f"cars {len(document['cars'])}/{CAR_COUNT}; recovered {recovered}")


if __name__ == "__main__":
    main()
