"""Build the retail runtime material recipes for the fifteen integrated cars.

This stage closes the P60 gap: the paint lookup and the light blend are not
invented, they are decoded from the shipped XT packs.

* ``\\gamedata\\xt\\amax.bin`` -> ``AmaxVehicle`` (paint job array,
  per-vehicle material overrides)
* ``\\gamedata\\xt\\vehicles.bin`` -> ``VEH_PaintJob`` / ``VEH_Curve`` /
  ``VEH_MaterialDefaults`` / ``VEH_MaterialPaint|Glass|Alloy|Light|Tyre``
* each car's own ``.model`` -> serialized ``g_vMtlParameters`` and the
  ``g_DentTexture`` / ``g_ScratchTexture`` / ``g_BumpTexture`` /
  ``g_sOffTexture`` / ``g_sOnTexture`` (+ damage) fields
* the committed P52 roster manifest -> authoritative draw classification,
  static albedo texture ids and decoded texture paths

Output is written under ``_work/car-materials/runtime/recipes`` by default:
one ``<slug>.json`` per car, one 512x1 RGBA paint ramp per car, and an
``index.json`` with coverage and hashes. Nothing is rendered.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
PROBE_TOOLS = Path(__file__).resolve().parent
for entry in (str(TOOLS), str(PROBE_TOOLS)):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import inspect_car_level_assets as car_reader  # noqa: E402
import inspect_car_materials as material_reader  # noqa: E402
import xt_vehicle_materials as xt  # noqa: E402

CARS_INDEX = ROOT / "_work/car-parts/cars/index.json"
ROSTER_ROOT = ROOT / "_work/car-materials/roster"
P60_ROOT = ROOT / "_work/car-materials/runtime"
ROSTER_JSON = ROOT / "probes/e1-drive/cars/roster.json"
DEFAULT_OUT = ROOT / "_work/car-materials/runtime/recipes"

MANIFEST_KIND = "blur.car-runtime-material-recipe"
MANIFEST_VERSION = 1
INTEGRATED_CARS = 15

PAINT_AUX_FIELDS = (
    ("g_DentTexture", "paint-dent-texture"),
    ("g_ScratchTexture", "paint-scratch-texture"),
    ("g_BumpTexture", "paint-bump-texture"),
)
LIGHT_FIELDS = (
    ("g_sOffTexture", "light-off-texture"),
    ("g_sOnTexture", "light-on-texture"),
    ("g_sOffTextureDamage", "light-off-damage-texture"),
    ("g_sOnTextureDamage", "light-on-damage-texture"),
)

COLOUR_SPACE = {
    "paintJobColours": {
        "space": "srgb-encoded",
        "reason": "PaintEditor.cpp:290-295 writes (U8)(float*255) into an "
                  "A8R8G8B8 texture created with E_Format_SRGB "
                  "(PaintEditor.cpp:370); PaintTextureSampler declares "
                  "SRGB_TEXTURE (vehicle_common.h:579-590).",
        "consumerRule": "Upload the stored ramp as rgba8unorm-srgb or convert "
                        "the stored bytes sRGB->linear exactly once.",
    },
    "paintReflectivity": {
        "space": "linear",
        "reason": "The alpha channel of the ramp is the reflectivity curve; "
                  "alpha is not sRGB-decoded by the sampler.",
    },
    "materialColours": {
        "space": "linear",
        "reason": "XtRgb values are uploaded as F32 shader constants "
                  "(g_vRenderColour/g_vMaterialColour) with no sRGB decode.",
    },
    "lightMasks": {
        "space": "srgb-encoded-rgb-linear-alpha",
        "reason": "Off/on samplers declare SRGB_TEXTURE "
                  "(vehicle_common.h:452-493); the alpha mask is linear.",
    },
    "modelMaterialColours": {
        "space": "linear",
        "reason": "g_vMtlParameters is a serialized F32 model material row.",
    },
}


def sha256_file(path: Path) -> str:
    return xt.sha256_file(path)


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def json_load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def texture_id(binding: dict) -> str | None:
    if not binding:
        return None
    if binding["kind"] == "shared":
        return f"shared:{binding['index']}:{binding['name']}"
    if binding["kind"] == "resource-block":
        return f"block:{binding['block']}:{binding['index']}:{binding['name']}"
    return None


def p60_texture_map(p60: dict | None) -> dict:
    if not p60:
        return {}
    return {texture["id"]: texture for texture in p60.get("textures", [])}


def roster_texture_map(roster: dict) -> dict:
    return {texture["id"]: texture for texture in roster.get("textures", [])}


def decoded_from(texture: dict | None) -> dict | None:
    if not texture or not texture.get("decoded"):
        return None
    decoded = texture["decoded"]
    return {
        "rgba": decoded.get("rgba"),
        "png": decoded.get("png"),
        "rawtexture": decoded.get("rawtexture"),
    }


def resolve_texture(binding: dict, p60: dict, roster: dict) -> dict:
    tid = texture_id(binding)
    if tid is None:
        return {
            "textureId": None, "name": binding.get("name"),
            "hash": None, "kind": binding.get("kind"),
            "decoded": None,
            "decodeReason": "texture source kind is not shared/resource-block",
        }
    source = p60.get(tid) or roster.get(tid)
    decoded = decoded_from(source)
    return {
        "textureId": tid,
        "name": binding.get("name"),
        "hash": source.get("hash") if source else None,
        "kind": binding["kind"],
        "decoded": decoded,
        "decodeReason": None if decoded else (
            "texture decoded by neither the P52 roster nor the P60 runtime "
            "pass; the colour recipe does not depend on its pixels"),
        "sampler": binding.get("sampler"),
    }


def paint_recipe(db: xt.XtMaterialDb, vehicle: dict, defaults: dict,
                 default_paint_job: dict, ramp_path: Path) -> dict:
    paint_jobs = [db.paint_job("amax", handle) for handle in vehicle["paintJobHandles"]]
    if paint_jobs:
        stock = paint_jobs[0]
        selection = {
            "rule": "first-paint-job",
            "paintJobIndex": 0,
            "reason": "C_PaintJob::UpdateMaterial uses m_PaintJobs[0] when "
                      "g_debugUseFirstPaintJobFound is true (default)",
            "source": xt.SOURCE["paint_selection"],
        }
        fallback = False
    else:
        stock = default_paint_job
        selection = {
            "rule": "material-default-paint-job",
            "paintJobIndex": None,
            "reason": "the vehicle has no m_PaintJobs; C_PaintJob falls back to "
                      "p_materialDefaults->m_DefaultPaintJob",
            "source": xt.SOURCE["paint_default_job"],
        }
        fallback = True
    ramp = xt.build_paint_ramp(stock)
    ramp_path.parent.mkdir(parents=True, exist_ok=True)
    ramp_path.write_bytes(ramp)
    return {
        "id": "paint.stock",
        "kind": "paint",
        "materialType": "VEH_PaintJob",
        "draws": [],
        "selection": selection,
        "stock": stock,
        "alternates": paint_jobs[1:],
        "fallbackUsed": fallback,
        "defaultPaintJob": {
            "handle": default_paint_job["handle"],
            "name": default_paint_job["name"],
            "recordIndex": default_paint_job["recordIndex"],
            "recordId": default_paint_job["recordId"],
            "pack": default_paint_job["pack"],
        },
        "ramp": {
            "width": 512,
            "height": 1,
            "texelFormat": "RGBA8",
            "alphaMeaning": "reflectivity",
            "sample": "tex2Dlod(PaintTextureSampler, float4(saturate(dot(N,V)), 0, 0, 0))",
            "samplerSRGB": True,
            "address": "CLAMP",
            "bytes": rel(ramp_path),
            "byteLength": len(ramp),
            "sha256": xt.ramp_sha256(ramp),
            "generator": "colours interpolated by colourCurve at "
                         "value=1-i/512; alpha=reflectivityCurve(value); "
                         "byte=(U8)(clamp(x,0,1)*255)",
            "source": xt.SOURCE["paint_ramp"],
        },
        "shader": {
            "surfaceColour": "paintTex.xyz",
            "reflectivity": "paintTex.w",
            "finalColour": "lighting*surface*(1-reflectivity) + "
                           "reflectivity*envCube*rimFade*ao",
            "sources": [xt.SOURCE["paint_surface"], xt.SOURCE["paint_lighting"],
                        xt.SOURCE["paint_sample"]],
        },
        "blend": {"alphaBlend": False, "sortOrder": 1, "alphaTest": False},
        "alpha": {"mode": "opaque", "value": 1.0},
        "provenance": [stock["provenance"]],
    }


def material_for_part(defaults: dict, override: dict | None, part_code: int) -> dict:
    chain = xt.effective_material_chain(defaults, override, part_code)
    return chain


# Which C_Material* classes actually AddParameter() for each exposed register.
# C_MaterialBase::SetParameter adds every register with zero-initialised data;
# C_MaterialPaint::SetParameter returns without adding anything.
REGISTER_SETTERS = {
    "renderColour": {"VEH_MaterialGlass", "VEH_MaterialAlloy",
                     "VEH_MaterialLight", "VEH_MaterialBase"},
    "renderSettings": {"VEH_MaterialGlass", "VEH_MaterialAlloy",
                       "VEH_MaterialBase", "VEH_MaterialTyre"},
    "damageSettings": {"VEH_MaterialGlass", "VEH_MaterialLight",
                       "VEH_MaterialBase"},
}


def register_known(material: dict | None, exposure_flag: bool, register: str) -> bool:
    if not exposure_flag or material is None:
        return False
    mat_type = material["material"]["value"]["type"]
    return mat_type in REGISTER_SETTERS[register]


def register_values(material: dict | None, register: str) -> list[float] | None:
    """The value a C_Material* class uploads for an exposed register."""
    if material is None:
        return None
    mat_type = material["material"]["value"]["type"]
    value = material["material"]["value"]
    if mat_type == "VEH_MaterialBase":
        return [0.0, 0.0, 0.0, 0.0]
    if register == "renderColour":
        if mat_type == "VEH_MaterialGlass":
            return [*value["tint"], 1.0]
        if mat_type == "VEH_MaterialAlloy":
            return [*value["colour"], 1.0]
        if mat_type == "VEH_MaterialLight":
            return [*value["tint"], value["intensity"]]
        return None
    if register == "renderSettings":
        if mat_type == "VEH_MaterialGlass":
            return [value["minAlpha"], value["maxAlpha"],
                    value["minReflectivity"], value["maxReflectivity"]]
        if mat_type == "VEH_MaterialAlloy":
            return [value["specPow"], value["specInt"], 0.0, 0.0]
        if mat_type == "VEH_MaterialTyre":
            return [value["treadDepth"], 0.0, 0.0, 0.0]
        return None
    if register == "damageSettings":
        if mat_type in ("VEH_MaterialGlass", "VEH_MaterialLight"):
            return [0.0, 0.0, 0.0, 0.0]
        return None
    return None


def light_states(material: dict | None, part_code: int,
                 exposure_flag: bool) -> dict:
    if not exposure_flag:
        return {
            "off": 0.0, "on": None,
            "rule": "g_vRenderColour is not exposed on this element; the shared "
                    "register can carry a previous draw's value (typed partial)",
        }
    mat_type = material["material"]["value"]["type"] if material else None
    value = material["material"]["value"] if material else {}
    if mat_type == "VEH_MaterialLight":
        intensity = value["intensity"]
        if part_code == 34:
            return {
                "off": 0.0,
                "rear": intensity,
                "brake": min(1.0, 2.0 * intensity),
                "rear+brake": min(1.0, 2.0 * intensity),
                "rule": "VehicleModel.cpp:1038-1042 sets m_Intensity=1 for the "
                        "base rear light and +1 for the brake; "
                        "Intensity()=m_Intensity*Xt intensity",
            }
        return {
            "off": 0.0,
            "on": intensity,
            "rule": "VehicleModel.cpp:1044 sets m_Intensity=1 when visible; "
                    "Intensity()=1*Xt intensity",
        }
    if mat_type in ("VEH_MaterialGlass", "VEH_MaterialAlloy"):
        return {
            "off": 0.0, "on": 1.0,
            "rule": "the material sets g_vRenderColour.w to 1.0",
        }
    if mat_type == "VEH_MaterialBase":
        return {
            "off": 0.0, "on": 0.0,
            "rule": "C_MaterialBase::SetParameter adds g_vRenderColour with "
                    "zero-initialised data, so w=0",
        }
    return {
        "off": 0.0, "on": None,
        "rule": "this material class does not set g_vRenderColour; the shared "
                "register can carry a previous draw's value (typed partial)",
    }


def build_recipe_key(family: str, codes: dict, material: dict | None,
                     exposure: dict, resolution: str) -> str:
    part = codes["partName"] or "none"
    mat_type = material["material"]["value"]["type"] if material else "none"
    return f"{family}.{part}.{mat_type}.{resolution}"


def build_car(db: xt.XtMaterialDb, car: dict, roster: dict,
              p60: dict | None, defaults: dict, override: dict | None,
              default_paint_job: dict, out_dir: Path) -> dict:
    slug = car["slug"]
    model_path = ROOT / car["decodedModel"]
    model_bytes = model_path.read_bytes()
    if xt.sha256_bytes(model_bytes) != car["modelSha256"]:
        raise RuntimeError(f"{slug}: model hash differs from car index")
    part_manifest = json_load(ROOT / car["manifest"])
    elements = part_manifest["mdlDat"]["elements"]

    old_reader = car_reader.Reader
    try:
        car_reader.Reader = material_reader.MaterialReader
        layout = car_reader.render_layout(model_bytes, "model")
    finally:
        car_reader.Reader = old_reader
    scene_end = next(chunk["end"] for chunk in layout["chunks"] if chunk["id"] == "Scene")
    blocks = material_reader.resource_blocks(model_bytes, layout["scene"], scene_end)
    render_list = next(node for node in blocks[0]["nodes"]
                       if node["type"] == "RenderingData::RenderListNode_Common")
    dml = render_list.get("dynamicMaterialLists") or []
    dml_materials = dml[0]["materials"] if dml else []

    p60_tex = p60_texture_map(p60)
    roster_tex = roster_texture_map(roster)
    p60_draws = {draw["index"]: draw for draw in (p60 or {}).get("draws", [])}

    ramp_path = out_dir / "ramps" / f"{slug}.rgba"
    paint = paint_recipe(db, db.vehicle(person := car["name"]), defaults,
                         default_paint_job, ramp_path)

    recipes: "OrderedDict[str, dict]" = OrderedDict()
    draw_assignments = []
    texture_uses: "OrderedDict[str, dict]" = OrderedDict()

    def add_texture(binding: dict, parameter: str, role: str,
                    draw_index: int, serialized_offset: int | None) -> dict:
        info = resolve_texture(binding, p60_tex, roster_tex)
        tid = info["textureId"]
        if tid:
            record = texture_uses.setdefault(tid, {
                "id": tid,
                "name": info["name"],
                "hash": info["hash"],
                "kind": info["kind"],
                "decoded": info["decoded"],
                "decodeReason": info["decodeReason"],
                "bindings": [],
            })
            record["bindings"].append({
                "draw": draw_index,
                "parameter": parameter,
                "role": role,
                "serializedOffset": serialized_offset,
            })
        return info

    for roster_draw in roster["draws"]:
        draw_index = roster_draw["index"]
        primitive = render_list["primitives"][draw_index]
        calls, assignments, _unknown = material_reader.material_assignments(
            render_list, primitive)
        base_call = next((call for call in calls if call["stage"] == "base"), None)
        element_index = None
        if base_call and base_call.get("listIndex") == 1 and base_call["index"] < len(dml_materials):
            row = dml_materials[base_call["index"]]
            for field in row["fields"]:
                if field["name"] == "Index":
                    element_index = field["values"][0]
        element_name = (elements[element_index]["name"]
                        if element_index is not None and element_index < len(elements) else None)
        codes = xt.get_codes(element_name)
        exposure = xt.exposure(element_name)
        material = material_for_part(defaults, override, codes["partCode"])
        surface = assignments.get("g_vMtlParameters")
        model_surface = None
        if surface:
            values = surface["values"]
            model_surface = {
                "serializedOffset": surface["serializedOffset"],
                "values": values,
                "vParameters": values[0:4],
                "vMaterialColour": values[4:8],
            }

        family = roster_draw.get("shaderFamily")
        status = roster_draw["status"]
        assignment = {
            "draw": draw_index,
            "effect": roster_draw["effect"],
            "shaderFamily": family,
            "status": status,
            "partId": roster_draw.get("partId"),
            "partName": roster_draw.get("partName"),
            "elementIndex": element_index,
            "elementName": element_name,
            "partCode": codes["partCode"],
            "partCodeName": codes["partName"],
            "partSubCode": codes["subCode"],
            "partSubName": codes["subName"],
            "codeReason": codes["reason"],
            "exposure": exposure,
            "materialLookupPath": material["path"],
            "materialType": (material["entry"]["material"]["value"]["type"]
                             if material["entry"] else None),
            "modelSurfaceParameters": model_surface,
        }

        if roster_draw.get("albedoParameter") is not None:
            texture_ids = []
            for tid in roster_draw.get("textureIds", []):
                source = roster_tex.get(tid)
                texture_uses.setdefault(tid, {
                    "id": tid,
                    "name": source.get("name") if source else None,
                    "hash": source.get("hash") if source else None,
                    "kind": source.get("kind") if source else None,
                    "decoded": decoded_from(source),
                    "decodeReason": None if source and source.get("decoded") else
                    "texture not decoded in the committed roster",
                    "bindings": [],
                })
                texture_uses[tid]["bindings"].append({
                    "draw": draw_index,
                    "parameter": roster_draw.get("albedoParameter"),
                    "role": "albedo",
                    "serializedOffset": None,
                })
                texture_ids.append(tid)
            assignment.update({
                "recipeId": "albedo.static",
                "resolution": "resolved",
                "reason": None,
                "textureIds": texture_ids,
                "uvConvention": {
                    "sampleUV": "(1 - u, v)",
                    "source": "docs/work/verification/T-007-car-uv-orientation.md",
                },
            })
            recipes.setdefault("albedo.static", {
                "id": "albedo.static",
                "kind": "albedo",
                "draws": [],
                "textureIds": [],
                "inputs": {
                    "colour": "texture.rgb",
                    "alpha": "texture.a (or 1.0 when the draw is opaque)",
                    "lighting": "vertex SH lighting * g_vBakedColour",
                },
                "blend": {"alphaBlend": False},
                "alpha": {"mode": "texture-or-opaque"},
                "provenance": ["docs/work/analysis/car-materials.md"],
            })
            recipes["albedo.static"]["draws"].append(draw_index)
            for tid in texture_ids:
                if tid not in recipes["albedo.static"]["textureIds"]:
                    recipes["albedo.static"]["textureIds"].append(tid)
            draw_assignments.append(assignment)
            continue

        # ----- runtime-only draw -----------------------------------------
        if family == "paint":
            recipe_id = "paint.stock"
            resolution = "resolved"
            reason = None
            recipes.setdefault(recipe_id, paint)
            recipes[recipe_id]["draws"].append(draw_index)
            assignment.update({"recipeId": recipe_id, "resolution": resolution,
                               "reason": reason, "textureIds": []})
            for parameter, role in PAINT_AUX_FIELDS:
                value = assignments.get(parameter)
                if value and value["type"] == 7 and value["count"] == 1:
                    binding = material_reader.texture_binding(
                        value["values"][0], render_list, layout["scene"], blocks)
                    info = add_texture(binding, parameter, role, draw_index,
                                       value["serializedOffset"])
                    assignment["textureIds"].append(info["textureId"])
            draw_assignments.append(assignment)
            continue

        if family == "light":
            weight_known = register_known(material["entry"],
                                          exposure["renderColour"], "renderColour")
            resolution = "resolved" if weight_known else "partial"
            reason = None if weight_known else (
                "g_vRenderColour.w is not set by this draw's material/exposure "
                "path; the shared register can carry a previous draw's value")
            states = light_states(material["entry"], codes["partCode"],
                                  exposure["renderColour"])
            recipe_id = build_recipe_key("light", codes, material["entry"],
                                         exposure, resolution)
            recipe = recipes.setdefault(recipe_id, {
                "id": recipe_id,
                "kind": "light",
                "materialType": (material["entry"]["material"]["value"]["type"]
                                 if material["entry"] else None),
                "draws": [],
                "tint": (material["entry"]["material"]["value"].get("tint")
                         if material["entry"] else None),
                "intensity": (material["entry"]["material"]["value"].get("intensity")
                              if material["entry"] else None),
                "renderColour": (register_values(material["entry"], "renderColour")
                                 if weight_known else None),
                "weight": states,
                "textures": {},
                "formula": "off=tex(UV0.xy); on=tex(UV0.zw); "
                           "rgb=lerp(off.rgb,on.rgb,on.a*w); a=on.a*w; "
                           "surface=lerp(rgb,damage,g_vDamageSettings.x); "
                           "final=lerp(surface*lighting,surface,surface.a) + "
                           "reflection*rimFade*surface.a*ao",
                "blend": {"alphaBlend": False, "alphaTest": False},
                "alpha": {"mode": "on.a*w"},
                "provenance": [xt.SOURCE["light_masks"], xt.SOURCE["light_weights"]],
                "resolution": resolution,
                "reason": reason,
            })
            recipe["draws"].append(draw_index)
            assignment.update({"recipeId": recipe_id, "resolution": resolution,
                               "reason": reason, "textureIds": []})
            for parameter, role in LIGHT_FIELDS:
                value = assignments.get(parameter)
                if value and value["type"] == 7 and value["count"] == 1:
                    binding = material_reader.texture_binding(
                        value["values"][0], render_list, layout["scene"], blocks)
                    info = add_texture(binding, parameter, role, draw_index,
                                       value["serializedOffset"])
                    recipe["textures"][role] = info["textureId"]
                    assignment["textureIds"].append(info["textureId"])
            draw_assignments.append(assignment)
            continue

        if family == "glass":
            mat_type = (material["entry"]["material"]["value"]["type"]
                        if material["entry"] else None)
            settings_known = register_known(material["entry"],
                                            exposure["renderSettings"], "renderSettings")
            colour_known = register_known(material["entry"],
                                          exposure["renderColour"], "renderColour")
            resolution = "resolved" if settings_known and colour_known else "partial"
            reasons = []
            if not settings_known:
                reasons.append("g_vRenderSettings is not set by this draw's "
                               "material/exposure path; the shared register can "
                               "carry a previous draw's value")
            if not colour_known:
                reasons.append("g_vRenderColour is not set by this draw's "
                               "material/exposure path")
            reason = "; ".join(reasons) if reasons else None
            recipe_id = build_recipe_key("glass", codes, material["entry"],
                                         exposure, resolution)
            value = material["entry"]["material"]["value"] if material["entry"] else {}
            recipe = recipes.setdefault(recipe_id, {
                "id": recipe_id,
                "kind": "glass",
                "materialType": mat_type,
                "draws": [],
                "tint": value.get("tint"),
                "minAlpha": value.get("minAlpha"),
                "maxAlpha": value.get("maxAlpha"),
                "minReflectivity": value.get("minReflectivity"),
                "maxReflectivity": value.get("maxReflectivity"),
                "formula": "alpha=lerp(maxAlpha,minAlpha,NdotV); "
                           "reflectivity=lerp(maxReflect,maxReflect,NdotV); "
                           "colour=g_vMaterialColour+g_vRenderColour.xyz; "
                           "final=lighting*colour*alpha*(1-refl)+"
                           "refl*env*rim*ao*alphaScale",
                "blend": {"alphaBlend": True, "src": "One",
                          "dest": "InvSrcAlpha", "alphaTest": True},
                "alpha": {"mode": "lerp(maxAlpha,minAlpha,NdotV)"},
                "provenance": [xt.SOURCE["glass_material"], xt.SOURCE["glass_blend"],
                               xt.SOURCE["exposure"]],
                "resolution": resolution,
                "reason": reason,
                "textureIds": [],
            })
            recipe["draws"].append(draw_index)
            assignment.update({"recipeId": recipe_id, "resolution": resolution,
                               "reason": reason, "textureIds": []})
            draw_assignments.append(assignment)
            continue

        if family == "alloy":
            mat_type = (material["entry"]["material"]["value"]["type"]
                        if material["entry"] else None)
            colour_known = register_known(material["entry"],
                                          exposure["renderColour"], "renderColour")
            settings_known = register_known(material["entry"],
                                            exposure["renderSettings"], "renderSettings")
            resolution = "resolved" if colour_known and settings_known else "partial"
            reasons = []
            if not colour_known:
                reasons.append("g_vRenderColour is not set by this draw's "
                               "material/exposure path")
            if not settings_known:
                reasons.append("g_vRenderSettings is not set by this draw's "
                               "material/exposure path")
            reason = "; ".join(reasons) if reasons else None
            recipe_id = build_recipe_key("alloy", codes, material["entry"],
                                         exposure, resolution)
            value = material["entry"]["material"]["value"] if material["entry"] else {}
            recipe = recipes.setdefault(recipe_id, {
                "id": recipe_id,
                "kind": "alloy",
                "materialType": mat_type,
                "draws": [],
                "colour": value.get("colour"),
                "specPow": value.get("specPow"),
                "specInt": value.get("specInt"),
                "formula": "surface=g_vRenderColour.xyz; "
                           "g_vRenderSettings=(specPow,specInt,0,0); "
                           "reflectivity=lerp(vParameters.y,vParameters.x,NdotV); "
                           "final=lighting*surface*(1-refl)+refl*env*rim*ao",
                "blend": {"alphaBlend": False, "alphaTest": False},
                "alpha": {"mode": "g_vRenderColour.w", "value": 1.0},
                "provenance": [xt.SOURCE["alloy_material"], xt.SOURCE["alloy_surface"],
                               xt.SOURCE["exposure"]],
                "resolution": resolution,
                "reason": reason,
                "textureIds": [],
            })
            recipe["draws"].append(draw_index)
            assignment.update({"recipeId": recipe_id, "resolution": resolution,
                               "reason": reason, "textureIds": []})
            draw_assignments.append(assignment)
            continue

        # default / base: the surface colour is the serialized model row
        if model_surface is None:
            resolution = "unsupported"
            reason = ("g_vMtlParameters is not serialized on this draw; the "
                      "base-colour shader input cannot be recovered")
            recipe = {
                "id": "base.unsupported",
                "kind": "base",
                "draws": [draw_index],
                "formula": None,
                "blend": {"alphaBlend": False},
                "alpha": {"mode": "opaque", "value": 1.0},
                "provenance": [],
                "resolution": resolution,
                "reason": reason,
            }
            recipe_id = recipe["id"]
            recipes.setdefault(recipe_id, recipe)
            if recipe_id in recipes:
                recipes[recipe_id].setdefault("draws", []).append(draw_index)
            assignment.update({"recipeId": recipe_id, "resolution": resolution,
                               "reason": reason, "textureIds": []})
            draw_assignments.append(assignment)
            continue
        fingerprint = tuple(round(v, 6) for v in model_surface["values"])
        recipe_id = None
        for candidate in recipes.values():
            if (candidate["kind"] == "base"
                    and candidate.get("fingerprint") == fingerprint):
                recipe_id = candidate["id"]
                break
        if recipe_id is None:
            recipe_id = f"base.{codes['partName'] or 'none'}.{len(recipes)}"
            recipes[recipe_id] = {
                "id": recipe_id,
                "kind": "base",
                "materialType": (material["entry"]["material"]["value"]["type"]
                                 if material["entry"] else None),
                "draws": [draw_index],
                "fingerprint": fingerprint,
                "modelSurfaceParameters": model_surface,
                "formula": "surface=g_vMaterialColour.xyz; "
                           "reflectivity=lerp(vParameters.y,vParameters.x,NdotV); "
                           "final=lighting*surface*(1-refl)+refl*env*rim*ao",
                "blend": {"alphaBlend": False, "alphaTest": False},
                "alpha": {"mode": "opaque", "value": 1.0},
                "provenance": [
                    xt.SOURCE["base_surface"],
                    {"model": rel(model_path), "draw": draw_index,
                     "field": "g_vMtlParameters",
                     "serializedOffset": model_surface["serializedOffset"],
                     "bytes": 32},
                ],
                "resolution": "resolved",
                "reason": None,
                "textureIds": [],
            }
        else:
            recipes[recipe_id]["draws"].append(draw_index)
        assignment.update({"recipeId": recipe_id, "resolution": "resolved",
                           "reason": None, "textureIds": []})
        draw_assignments.append(assignment)

    # stable draw lists
    for recipe in recipes.values():
        recipe["draws"] = sorted(set(recipe["draws"]))

    kind_counts = Counter(recipe["kind"] for recipe in recipes.values()
                          for _ in recipe["draws"])
    diagnostics = [a for a in draw_assignments if a["recipeId"] != "albedo.static"]
    resolution_counts = Counter(a["resolution"] for a in diagnostics)
    class_counts = Counter()
    for assignment in diagnostics:
        family = assignment["shaderFamily"]
        if family == "paint":
            class_counts["paint"] += 1
        elif family == "light":
            class_counts["light"] += 1
        elif family == "glass":
            class_counts["glass"] += 1
        elif family == "alloy":
            class_counts["alloy"] += 1
        else:
            class_counts["base"] += 1

    return {
        "kind": MANIFEST_KIND,
        "version": MANIFEST_VERSION,
        "car": {
            "slug": slug,
            "name": car["name"],
            "recordId": car["record"]["id"],
            "recordIndex": car["record"]["index"],
            "model": {
                "path": rel(model_path),
                "sha256": car["modelSha256"],
                "pakPath": car["pakPath"],
            },
        },
        "source": {
            "paintPack": {
                "path": db.packs["amax"].relative,
                "sha256": db.packs["amax"].sha256,
                "bytes": len(db.packs["amax"].data),
            },
            "materialPack": {
                "path": db.packs["vehicles"].relative,
                "sha256": db.packs["vehicles"].sha256,
                "bytes": len(db.packs["vehicles"].data),
            },
            "rosterManifest": {
                "path": rel(ROOT / "_work/car-materials/roster/cars" / slug / "materials.json"),
                "sha256": sha256_file(ROOT / "_work/car-materials/roster/cars" / slug / "materials.json"),
            },
            "runtimeManifest": ({
                "path": rel(ROOT / "_work/car-materials/runtime/cars" / slug / "materials.json"),
                "sha256": sha256_file(ROOT / "_work/car-materials/runtime/cars" / slug / "materials.json"),
            } if p60 else None),
            "partManifest": {
                "path": rel(ROOT / car["manifest"]),
                "sha256": car["manifestSha256"].removeprefix("sha256:"),
            },
        },
        "vehicle": db.vehicle(car["name"]),
        "colourSpace": COLOUR_SPACE,
        "paint": paint,
        "materialDefaults": {
            "global": defaults,
            "vehicleOverride": override,
            "lookupRule": xt.SOURCE["material_lookup"],
            "partCodeRule": xt.SOURCE["part_codes"],
        },
        "recipes": list(recipes.values()),
        "textureTable": list(texture_uses.values()),
        "draws": draw_assignments,
        "coverage": {
            "drawCount": len(draw_assignments),
            "staticAlbedoDrawCount": len(draw_assignments) - len(diagnostics),
            "runtimeDiagnosticDrawCount": len(diagnostics),
            "classCounts": dict(class_counts),
            "resolutionCounts": dict(resolution_counts),
            "recipeKindDrawCounts": dict(kind_counts),
            "recipeCount": len(recipes),
            "textureCount": len(texture_uses),
            "decodedTextureCount": sum(1 for t in texture_uses.values() if t["decoded"]),
            "undecodedTextureCount": sum(1 for t in texture_uses.values() if not t["decoded"]),
        },
        "limits": [
            "Data only: no shader is executed and no image is rendered.",
            "Paint ramp bytes are generated from the decoded XT floats by the "
            "retail PaintEditor formula; they are not a retail screen capture.",
            "Glass on an element whose part code/exposure does not set "
            "g_vRenderSettings is partial: the shared register's value is not "
            "statically recoverable.",
            "Light weight on an element whose material/exposure path does not set "
            "g_vRenderColour is partial for the same reason.",
            "Paint auxiliary dent/scratch/bump masks are referenced; batch-1 "
            "cars outside P60 do not decode them because the colour recipe does "
            "not use their pixels.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--car-count", type=int, default=INTEGRATED_CARS)
    args = parser.parse_args()
    out_dir = args.out_dir.resolve()
    for forbidden in (ROOT / "game-data", ROOT / "upstream"):
        if out_dir.is_relative_to(forbidden.resolve()):
            parser.error(f"output must not be inside {forbidden.name}")

    cars_index = json_load(CARS_INDEX)
    roster_index = json_load(ROSTER_ROOT / "index.json")
    roster_json = json_load(ROSTER_JSON)
    roster_order = roster_json["cars"][:args.car_count]
    if len(roster_order) != args.car_count:
        raise RuntimeError("roster has fewer cars than requested")
    by_slug = {car["slug"]: car for car in cars_index["cars"]}
    roster_manifests = {}
    for entry in roster_order:
        slug = entry["slug"]
        if slug not in roster_index.get("cars", []) and not (
                ROSTER_ROOT / "cars" / slug / "materials.json").is_file():
            raise RuntimeError(f"{slug}: missing roster manifest")
        roster_manifests[slug] = json_load(
            ROSTER_ROOT / "cars" / slug / "materials.json")

    db = xt.XtMaterialDb()
    global_defaults = db.global_material_defaults()
    default_paint_job = db.paint_job(global_defaults["packKey"],
                                     global_defaults["defaultPaintJobHandle"])

    out_dir.mkdir(parents=True, exist_ok=True)
    summaries = []
    for entry in roster_order:
        slug = entry["slug"]
        car = by_slug[slug]
        vehicle = db.vehicle(car["name"])
        override = None
        if vehicle["materialOverridesHandle"] != 0xFFFFFFFF:
            override = db.material_defaults("amax", vehicle["materialOverridesHandle"])
        p60_path = P60_ROOT / "cars" / slug / "materials.json"
        p60 = json_load(p60_path) if p60_path.is_file() else None
        manifest = build_car(db, car, roster_manifests[slug], p60,
                             global_defaults, override, default_paint_job, out_dir)
        manifest["paint"]["ramp"]["bytes"] = f"ramps/{slug}.rgba"
        manifest_path = out_dir / f"{slug}.json"
        xt.json_dump(manifest_path, manifest)
        summaries.append({
            "slug": slug,
            "name": car["name"],
            "manifest": manifest_path.name,
            "manifestSha256": sha256_file(manifest_path),
            "paintJob": manifest["paint"]["stock"]["name"],
            "paintFallback": manifest["paint"]["fallbackUsed"],
            "paintRampSha256": manifest["paint"]["ramp"]["sha256"],
            "coverage": manifest["coverage"],
        })
        print(f"{slug}: draws={manifest['coverage']['drawCount']} "
              f"diagnostic={manifest['coverage']['runtimeDiagnosticDrawCount']} "
              f"resolved={manifest['coverage']['resolutionCounts'].get('resolved', 0)} "
              f"partial={manifest['coverage']['resolutionCounts'].get('partial', 0)} "
              f"unsupported={manifest['coverage']['resolutionCounts'].get('unsupported', 0)} "
              f"paint={manifest['paint']['stock']['name']}")

    total = Counter()
    for summary in summaries:
        for key, value in summary["coverage"]["resolutionCounts"].items():
            total[key] += value
        total["diagnostic"] += summary["coverage"]["runtimeDiagnosticDrawCount"]
        total["draws"] += summary["coverage"]["drawCount"]
    index = {
        "kind": "blur.car-runtime-material-recipe-index",
        "version": 1,
        "carCount": len(summaries),
        "sourcePacks": {
            "amax": {"path": db.packs["amax"].relative,
                     "sha256": db.packs["amax"].sha256,
                     "bytes": len(db.packs["amax"].data)},
            "vehicles": {"path": db.packs["vehicles"].relative,
                         "sha256": db.packs["vehicles"].sha256,
                         "bytes": len(db.packs["vehicles"].data)},
        },
        "materialDefaultsRecord": {
            "pack": global_defaults["pack"],
            "recordIndex": global_defaults["recordIndex"],
            "recordId": global_defaults["recordId"],
        },
        "defaultPaintJob": {
            "handle": default_paint_job["handle"],
            "name": default_paint_job["name"],
            "recordIndex": default_paint_job["recordIndex"],
            "recordId": default_paint_job["recordId"],
        },
        "totals": {
            "carCount": len(summaries),
            "draws": total["draws"],
            "diagnosticDraws": total["diagnostic"],
            "resolved": total["resolved"],
            "partial": total["partial"],
            "unsupported": total["unsupported"],
        },
        "cars": summaries,
        "limits": [
            "Fifteen integrated cars only; later roster cars are out of scope.",
            "Paint, light, glass, alloy and base-default colours are game-data "
            "values with record/field/byte provenance.",
            "Partial draws are explicitly typed; no shared-register value is "
            "guessed.",
        ],
    }
    xt.json_dump(out_dir / "index.json", index)
    print(json.dumps(index["totals"], indent=2))


if __name__ == "__main__":
    main()
