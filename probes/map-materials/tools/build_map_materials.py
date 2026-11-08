#!/usr/bin/env python3
"""Build per-map draw material recipes for River, Amboy, Gracia and Longbeach.

Data extraction only. Every value is read from the committed level render lists
through the committed sequential readers; derived pass/depth decisions are
tagged ``code`` with the source rule, and anything that cannot be resolved is a
typed blocker instead of a guess.

Output: ``_work/map-materials/<short>/materials.json`` (generated, not committed).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-materials/tools"))
sys.path.insert(0, str(ROOT / "tools"))

from inspect_car_level_assets import render_layout, resource_prefix, stream_prefix
from map_materials_common import (BLEND_FACTORS, BLEND_OPS, CULL_MODES,
                                  LEVELS, MATERIAL_ELEMENT_TYPES, PASS_BLEND_ENABLE,
                                  PASS_DEPTH, RENDER_PASSES, TEXTURE_STAGE_FIELDS,
                                  TextureMetadata, blend_state_json,
                                  blend_state_valid, material_stack,
                                  pass_for_primitive, read_lists, texture_sources)

PROBES = ROOT / "_work/map-pipeline/probes"
TRACK_COVERAGE = ROOT / "_work/track-coverage/visual.json"
E1_CORRIDOR = ["g56-n289", "g58-n265", "g50-n265", "g71-n209", "g64-n209", "g59-n265"]
OMIT_VALUE_FIELDS = {"g_mWorld", "g_SHNode", "g_mPalette", "PaletteData", "nested"}
SCHEMA = "blur.map-materials/1"


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_hash(doc: dict) -> str:
    body = {key: value for key, value in doc.items() if key != "hashes"}
    return "sha256:" + hashlib.sha256(
        json.dumps(body, sort_keys=True, separators=(",", ":"),
                   ensure_ascii=True, allow_nan=False).encode("utf-8")).hexdigest()


def write_json(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False,
                               allow_nan=False) + "\n", encoding="utf-8")


def triangle_count(indices: list[int], draw: dict) -> int:
    topology = draw["topology"]
    if topology not in (0, 1):
        raise ValueError("unsupported topology %d" % topology)
    first, count = draw["firstIndex"], draw["indexCount"]
    values = indices[first:first + count]
    if topology == 0 and len(values) % 3:
        raise ValueError("triangle list has a partial triple")
    step = 1 if topology == 1 else 3
    total = 0
    for j in range(2, len(values), step):
        a, b, c = values[j - 2:j + 1]
        if topology == 1 and j % 2:
            a, b = b, a
        if len({a, b, c}) == 3:
            total += 1
    return total


def classify(pass_name: str, state: dict, parameters: dict, effect: str) -> tuple[str, list[str]]:
    tags = []
    if "g_fEmissiveIntensity" in parameters or "g_tNeon" in parameters or \
            "g_vAnimatedNeonColour" in parameters or "g_vLightFlareColour" in parameters or \
            "LightFlare" in effect or "Neon" in effect:
        tags.append("emissive")
    if "g_fReflectorIntensity" in parameters:
        tags.append("reflector")
    if "g_fAlphaFactor" in parameters:
        tags.append("alpha-factor")
    if pass_name == "RACIFICATION" or effect.startswith("Racification"):
        return "additive-decal", tags
    if state["alphaBlendEnable"] or pass_name in ("OVERLAY", "BACK_FRONT"):
        return "alpha-blended", tags
    if state["alphaTestEnable"] or state["alphaToMaskEnable"] or pass_name == "ALPHA_TEST":
        return "alpha-tested", tags
    if "emissive" in tags:
        return "emissive-light", tags
    return "opaque", tags


def parameter_record(parameter: dict) -> dict:
    record = {
        "type": parameter["type"],
        "typeName": MATERIAL_ELEMENT_TYPES.get(parameter["type"], "UNKNOWN"),
        "count": parameter["count"],
        "row": parameter["row"],
        "rowTypeName": parameter["rowTypeName"],
        "stage": parameter["stage"],
        "serializedOffset": parameter["serializedOffset"],
    }
    if parameter["count"] > 4 or parameter["type"] == 9:
        record["valuesOmitted"] = True
        record["valuesReason"] = ("matrix/lighting/palette or runtime data array; "
                                  "not a colour, alpha, blend or texture factor")
    else:
        record["values"] = parameter["values"]
    return record


def colour_recipe(parameters: dict) -> dict:
    if "g_vColour" in parameters:
        p = parameters["g_vColour"]
        return {"source": "g_vColour", "provenance": "data",
                "values": p["values"], "row": p["row"],
                "serializedOffset": p["serializedOffset"]}
    if "g_tAlbedo" in parameters:
        p = parameters["g_tAlbedo"]
        return {"source": "g_tAlbedo", "provenance": "data",
                "reason": "colour is the sampled albedo texel; no separate scalar colour factor is serialized",
                "row": p["row"], "serializedOffset": p["serializedOffset"]}
    if "g_tMaterial" in parameters:
        p = parameters["g_tMaterial"]
        return {"source": "g_tMaterial", "provenance": "code",
                "reason": "no albedo map; the shader derives colour/material parameters from the material map or a default",
                "row": p["row"], "serializedOffset": p["serializedOffset"]}
    return {"source": "default-white", "provenance": "code",
            "reason": "no colour-bearing parameter in the stack; shader default is white"}


def alpha_recipe(parameters: dict, has_albedo: bool, alpha_stats: dict | None) -> dict:
    if "g_fAlphaFactor" in parameters:
        p = parameters["g_fAlphaFactor"]
        return {"source": "g_fAlphaFactor", "provenance": "data",
                "values": p["values"], "row": p["row"],
                "serializedOffset": p["serializedOffset"],
                "note": "effect-layer alpha scale; multiplied by g_vColour.a in the shader"}
    if has_albedo:
        return {"source": "albedo-texture-alpha", "provenance": "data",
                "alphaStats": alpha_stats,
                "note": "alpha is the sampled albedo texel alpha (Material.h EvaluateAlbedo)"}
    return {"source": "default-one", "provenance": "code",
            "reason": "no albedo map and no alpha factor; shader default is 1.0"}


def specular_recipe(parameters: dict) -> dict:
    if "g_tSpecular" in parameters:
        p = parameters["g_tSpecular"]
        return {"source": "g_tSpecular", "provenance": "data",
                "row": p["row"], "serializedOffset": p["serializedOffset"]}
    if "g_tMaterial" in parameters:
        p = parameters["g_tMaterial"]
        return {"source": "g_tMaterial.r", "provenance": "code",
                "reason": "material-map red channel is the specular intensity (Shaders/Common/Material.h:111)",
                "row": p["row"], "serializedOffset": p["serializedOffset"]}
    return {"source": "shader-default", "provenance": "code",
            "reason": "no specular parameter; C_Material zero-initialised (Material.h:140-142)"}


def emissive_recipe(parameters: dict) -> dict:
    if "g_fEmissiveIntensity" in parameters:
        p = parameters["g_fEmissiveIntensity"]
        return {"source": "g_fEmissiveIntensity", "provenance": "data",
                "values": p["values"], "row": p["row"],
                "serializedOffset": p["serializedOffset"]}
    if "g_vAnimatedNeonColour" in parameters:
        p = parameters["g_vAnimatedNeonColour"]
        return {"source": "g_vAnimatedNeonColour", "provenance": "data",
                "values": p["values"], "row": p["row"],
                "serializedOffset": p["serializedOffset"],
                "note": "animated by the shader; the serialized value is the base colour"}
    if "g_vLightFlareColour" in parameters:
        p = parameters["g_vLightFlareColour"]
        return {"source": "g_vLightFlareColour", "provenance": "data",
                "values": p["values"], "row": p["row"],
                "serializedOffset": p["serializedOffset"]}
    if "g_tMaterial" in parameters:
        p = parameters["g_tMaterial"]
        return {"source": "g_tMaterial.a", "provenance": "code",
                "reason": ("day lighting: emissive = (1 - materialMap.a) * albedo "
                           "(Shaders/Common/Material.h:114); night: materialMap.g * albedo (:119)"),
                "row": p["row"], "serializedOffset": p["serializedOffset"]}
    return {"source": "none", "provenance": "code",
            "reason": "no emissive parameter; C_Material zero-initialised (Material.h:140-142)"}


def uv_recipe(declaration: list[dict], primitive: dict, uv_hash: str | None) -> dict:
    texcoords = [e for e in declaration if e["usage"] == 5]
    sets = sorted({e["usageIndex"] for e in texcoords})
    uv0 = next((e for e in texcoords if e["usageIndex"] == 0), None)
    stream = None
    if uv0 is not None:
        stream = next((s for s in primitive["streams"]
                       if s["streamIndex"] == uv0["stream"] and s["frequency"] == 0), None)
    return {
        "set": 0,
        "provenance": "data",
        "declaration": uv0,
        "declaredTexcoordSets": sets,
        "uv1Present": 1 in sets,
        "uv0Stream": stream,
        "uvHash": uv_hash,
        "note": ("the shader reads vTexCoord.xy = TEXCOORD0 "
                 "(Shaders/Common/Material.h:144,159); UV1 and higher are not sampled "
                 "by the material path used here"),
    }


def section_specs(level: str, short: str, slice_doc: dict | None):
    if level == "usa_la_river":
        specs = []
        for stage in sorted(PROBES.glob(level + "-g*-n*")):
            key = stage.name[len(level) + 1:]
            g, n = key.split("-")
            specs.append({"id": key, "stage": stage, "geometryBlock": int(g[1:]),
                          "nodeBlock": int(n[1:]), "geometryChunkIndex": None,
                          "nodeChunkIndex": None})
        by_id = {spec["id"]: spec for spec in specs}
        ordered = [by_id[key] for key in E1_CORRIDOR if key in by_id]
        ordered += [spec for spec in specs if spec["id"] not in E1_CORRIDOR]
        return ordered
    specs = []
    for section in slice_doc["draws"]["sections"]:
        if section["status"] != "supported":
            continue
        stage = ROOT / section["stage"]
        specs.append({"id": section["id"], "stage": stage,
                      "geometryBlock": section["geometryBlock"],
                      "nodeBlock": section["nodeBlock"],
                      "geometryChunkIndex": section["geometryChunkIndex"],
                      "nodeChunkIndex": section["nodeChunkIndex"],
                      "drawCount": section["drawCount"]})
    return specs


def load_alpha_stats(short: str) -> dict:
    if short == "river":
        return {}
    path = ROOT / f"_work/map-slice/{short}-textures/bindings.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    result = {}
    for texture in doc.get("textures", []):
        result[texture["id"]] = texture.get("alpha")
    return result


def load_slice_inputs(short: str):
    if short == "river":
        return None, None
    slice_path = ROOT / f"_work/map-slice/{short}/slice.json"
    bind_path = ROOT / f"_work/map-slice/{short}-textures/bindings.json"
    return (json.loads(slice_path.read_text(encoding="utf-8")),
            json.loads(bind_path.read_text(encoding="utf-8")))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--level", required=True, choices=sorted(LEVELS))
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    level = args.level
    short = LEVELS[level]
    out_dir = (args.out or (ROOT / "_work/map-materials" / short)).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    level_dir = ROOT / "game-data/Blur/levels" / level
    header = (level_dir / "level.levelrender").read_bytes()
    scene = render_layout(header, "level")["scene"]
    records = scene["stream"]["chunks"]
    metadata = TextureMetadata(records, level_dir / "level.levelstream",
                               scene["sharedTextures"], header)
    slice_doc, binding_doc = load_slice_inputs(short)
    alpha_stats_by_id = load_alpha_stats(short)
    binding_rows = binding_doc["draws"] if binding_doc else None

    track_visual = None
    track_sections = {}
    path_doc = None
    if short == "river":
        track_visual = json.loads(TRACK_COVERAGE.read_text(encoding="utf-8"))
        for section in track_visual["sections"]:
            track_sections[section["key"]] = section
        path_doc = json.loads((ROOT / "_work/drivable-path/path.json")
                              .read_text(encoding="utf-8"))
        path_points = path_doc["course"]["points"]
        band_points = [(x, z) for i, (x, z) in enumerate(path_points) if i * 0.25 <= 100.02]
    else:
        band_points = []

    draws = []
    sections = []
    texture_index = defaultdict(lambda: {"draws": 0, "triangles": 0, "classes": Counter(),
                                         "parameters": Counter()})
    class_counts = Counter()
    class_triangles = Counter()
    blockers_by_class = defaultdict(Counter)
    binding_cursor = 0
    track_cursor = 0
    coverage_mismatch = []

    specs = section_specs(level, short, slice_doc)
    for spec in specs:
        stage = spec["stage"]
        raw = (stage / "node.chunk").read_bytes()
        node_block = spec["nodeBlock"]
        geo_block = spec["geometryBlock"]
        record = next((r for r in records if r["items"] and r["items"][0] == {"block": node_block, "lod": 0}), None)
        if record is None:
            raise SystemExit("no node chunk record for " + spec["id"])
        stream_prefix(raw, record)
        resources = resource_prefix(raw, {"resourcePayloadOffset": 24,
                                         "scenePayloadOffset": 0}, streamed=True)
        lists = read_lists(raw, resources)
        if not lists:
            raise SystemExit("no RenderList in " + spec["id"])
        render_list = lists[0]
        if short == "river":
            reference = track_sections[spec["id"]]
        else:
            reference = json.loads((stage / "reference.json").read_text(encoding="utf-8"))
        vertex_sources = render_list["sources"]["vertexBuffer"]
        index_sources = render_list["sources"]["indexBuffer"]
        section_draws = []
        draw_index = 0
        for primitive_index, primitive in enumerate(render_list["primitives"]):
            declaration = scene["declarations"][primitive["declaration"]]
            position = next((e for e in declaration if e["usage"] == 0 and e["usageIndex"] == 0), None)
            if position is None:
                continue
            stream = next((s for s in primitive["streams"]
                           if s["streamIndex"] == position["stream"] and s["frequency"] == 0), None)
            if stream is None:
                continue
            if not 0 <= stream["vertexBuffer"] < len(vertex_sources) or \
                    not 0 <= primitive["indexBuffer"] < len(index_sources):
                continue
            if vertex_sources[stream["vertexBuffer"]]["block"] != geo_block or \
                    index_sources[primitive["indexBuffer"]]["block"] != geo_block:
                continue
            if draw_index >= len(reference["draws"]):
                raise SystemExit("reference has fewer draws than the reader in " + spec["id"])
            ref = reference["draws"][draw_index]
            if ref["primitiveIndex"] != primitive_index:
                raise SystemExit("primitive order differs from the reference in " + spec["id"])
            effect = scene["effects"][primitive["effect"]].replace("\\", "/").rsplit("/", 1)[-1]
            if effect.endswith(".fx"):
                effect = effect[:-3]
            pass_name, pass_info = pass_for_primitive(render_list["passInfos"], primitive_index)
            if pass_name is None:
                raise SystemExit("primitive %d absent from RenderPassInfo" % primitive_index)
            state = primitive["blendState"]
            valid, reason = blend_state_valid(state)
            if not valid:
                raise SystemExit("invalid BlendState in %s draw %d: %s" % (spec["id"], draw_index, reason))
            stack = material_stack(render_list, primitive)
            resolved = texture_sources(render_list, stack["parameters"])
            class_name, tags = classify(pass_name, state, stack["parameters"], effect)

            texcoord = triangle_count(reference["indices"], ref)
            alpha_stats = None
            status = "unbound"
            blocker_kind = None
            blocker_reason = None
            texture_id = None
            if binding_rows is not None:
                row = binding_rows[binding_cursor]
                if row["section"] != spec["id"] or row["drawIndex"] != draw_index:
                    raise SystemExit("binding row order mismatch at %s draw %d" % (spec["id"], draw_index))
                binding_cursor += 1
                status = row["status"]
                texture_id = row.get("textureId")
                alpha_stats = alpha_stats_by_id.get(texture_id) if texture_id else None
                if status == "blocked-alpha-rule-missing":
                    blocker_kind, blocker_reason = "alpha-rule-missing", row.get("blocker")
                elif status == "blocked-decoder-size-limit":
                    blocker_kind, blocker_reason = "decoder-size-limit", row.get("blocker")
                elif status == "blocked-runtime-albedo-parameter":
                    blocker_kind, blocker_reason = "runtime-albedo-parameter", row.get("blocker")
                elif status == "blocked-effect-not-static-albedo":
                    blocker_kind, blocker_reason = "effect-not-static-albedo", row.get("blocker")
                elif status == "blocked-no-static-albedo":
                    blocker_kind, blocker_reason = "no-static-albedo", row.get("blocker")
            else:
                status = "river-unbound"
                if "g_tAlbedo" not in stack["parameters"]:
                    blocker_kind = "no-static-albedo"
                    blocker_reason = ("the effect has no g_tAlbedo assignment; the material is "
                                      "shader-computed or runtime-only")
                elif stack["parameters"]["g_tAlbedo"]["type"] == 9:
                    blocker_kind = "runtime-albedo-parameter"
                    blocker_reason = "g_tAlbedo is a DATA_INDEX runtime parameter, not a static texture index"

            stages = {}
            missing_stages = []
            for name, source in resolved.items():
                if name not in TEXTURE_STAGE_FIELDS:
                    continue
                if source["resolution"] != "data":
                    missing_stages.append({"parameter": name, "reason": source.get("reason")})
                    continue
                info = metadata.resolve(source["block"], source["index"])
                if info.get("resolution") == "unsupported":
                    missing_stages.append({"parameter": name, "reason": info.get("reason")})
                    continue
                stage_record = {
                    "slot": source["slot"],
                    "block": source["block"],
                    "index": source["index"],
                    "kind": info.get("kind"),
                    "name": info.get("name"),
                    "textureHash": info.get("textureHash"),
                    "width": info.get("width"),
                    "height": info.get("height"),
                    "levels": info.get("levels"),
                    "format": info.get("format"),
                    "formatCode": info.get("formatCode"),
                    "payloadBytes": info.get("payloadBytes"),
                    "pixelsDecoded": False,
                }
                stage_record["id"] = "%s.%s.%d.%d" % (short, "shared" if source["block"] == -1 else "tex",
                                                     source["block"], source["index"])
                stages[name] = stage_record
                key = (stage_record["id"], name)
                entry = texture_index[key]
                entry["draws"] += 1
                entry["triangles"] += texcoord
                entry["classes"][class_name] += 1
                entry["parameters"][name] += 1
                entry["record"] = stage_record

            blockers = []
            if blocker_kind:
                blockers.append({"kind": blocker_kind, "reason": blocker_reason})
            if missing_stages:
                blockers.append({"kind": "texture-stage-unresolved", "stages": missing_stages})
            if "g_fAlphaFactor" in stack["parameters"]:
                pass  # effect layer alpha is data
            elif alpha_stats and not alpha_stats.get("alphaOpaque"):
                if blocker_kind is None:
                    blockers.append({"kind": "alpha-rule-missing",
                                     "reason": "%s alpha is not opaque and the pass state gives no test/blend rule" % texture_id})
                blocker_kind = blocker_kind or "alpha-rule-missing"
            parameters = {name: parameter_record(parameter)
                          for name, parameter in stack["parameters"].items()}
            recipe_status = "complete" if not blockers else "partial"

            draw = {
                "id": "%s:%s:%d" % (short, spec["id"], draw_index),
                "section": spec["id"],
                "drawIndex": draw_index,
                "primitiveIndex": primitive_index,
                "effect": effect,
                "firstIndex": ref["firstIndex"],
                "indexCount": ref["indexCount"],
                "triangleCount": texcoord,
                "pass": {
                    "index": RENDER_PASSES.index(pass_name),
                    "name": pass_name,
                    "provenance": "code",
                    "rule": "GetRenderPass(sortType, blendState) at build time; serialized RenderPassInfo array",
                    "depthTest": PASS_DEPTH[pass_name]["depthTest"],
                    "depthWrite": PASS_DEPTH[pass_name]["depthWrite"],
                    "blendEnable": PASS_BLEND_ENABLE[pass_name],
                    "depthProvenance": "code",
                    "depthRule": "Context::SetPass (renderingdata/.../target/context.cpp:641-676)",
                },
                "blend": {**blend_state_json(state), "provenance": "data",
                          "serializedBytes": 24,
                          "serializedEncoding": "iiiBBBBii"},
                "alphaTest": {
                    "enable": bool(state["alphaTestEnable"]),
                    "ref": state["alphaRef"],
                    "toMask": bool(state["alphaToMaskEnable"]),
                    "provenance": "data",
                },
                "cull": {"mode": state["cullMode"], "name": CULL_MODES[state["cullMode"]],
                         "provenance": "data"},
                "zBias": state["zBias"],
                "flags": primitive["flags"],
                "blendClass": class_name,
                "tags": tags,
                "bindingStatus": status,
                "textureId": texture_id,
                "textureStages": stages,
                "material": {
                    "stack": stack["order"],
                    "runtime": stack["runtime"],
                    "parameters": parameters,
                    "colour": colour_recipe(stack["parameters"]),
                    "alpha": alpha_recipe(stack["parameters"], "g_tAlbedo" in stack["parameters"], alpha_stats),
                    "specular": specular_recipe(stack["parameters"]),
                    "emissive": emissive_recipe(stack["parameters"]),
                    "materialMap": stages.get("g_tMaterial"),
                    "materialMapRule": {
                        "provenance": "code",
                        "rule": ("material map R=specularIntensity, G=0.5*smoothness, B=fresnelMidBrightness, "
                                 "A=emissive factor (day: 1-A, night: G)"),
                        "source": "upstream/BlurRebuilt/code/amax/game/Shaders/Common/Material.h:108-122",
                    },
                },
                "uv": uv_recipe(declaration, primitive, None),
                "recipeStatus": recipe_status,
                "blockers": blockers,
            }
            recipe_body = {
                "pass": draw["pass"]["name"], "blend": state,
                "alphaTest": [state["alphaTestEnable"], state["alphaRef"], state["alphaToMaskEnable"]],
                "cull": state["cullMode"], "zBias": state["zBias"],
                "stack": [entry["id"] for entry in stack["order"]],
                "parameters": parameters, "stages": stages,
                "uv": draw["uv"]["declaration"],
            }
            draw["recipeHash"] = "sha256:" + hashlib.sha256(
                json.dumps(recipe_body, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=True, allow_nan=False).encode("utf-8")).hexdigest()[:32]
            if class_name == "additive-decal":
                draw["material"]["decal"] = {
                    "provenance": "code",
                    "premultipliedAlpha": True,
                    "rule": ("output.rgb *= output.a; technique SrcBlend=One, DestBlend=InvSrcAlpha, "
                             "BlendOp=Add, AlphaTestEnable=TRUE, ZWriteEnable=FALSE"),
                    "alphaFactorMode": ("binary-cutout" if stack["parameters"].get("g_fAlphaFactor", {}).get("values", [1])[0] == 0
                                        else "smooth"),
                    "alphaFactorRule": ("a = lerp(sign(a)/255, a, g_fAlphaFactor); 0 collapses alpha to a "
                                        "1/255 binary cutout, 1 keeps the texture alpha"),
                    "source": ("upstream/BlurRebuilt/code/amax/game/Shaders/Racification/Racification.fx:"
                               "297-298,325,330-346"),
                }
            draws.append(draw)
            section_draws.append({
                "id": draw["id"], "drawIndex": draw_index,
                "primitiveIndex": primitive_index,
                "pass": pass_name, "blendClass": class_name,
            })
            class_counts[class_name] += 1
            class_triangles[class_name] += texcoord
            for blocker in blockers:
                blockers_by_class[class_name][blocker["kind"]] += 1
            draw_index += 1

        if draw_index != len(reference["draws"]):
            coverage_mismatch.append((spec["id"], draw_index, len(reference["draws"])))
        sections.append({
            "id": spec["id"],
            "geometryBlock": geo_block,
            "nodeBlock": node_block,
            "nodeChunkIndex": spec["nodeChunkIndex"],
            "geometryChunkIndex": spec["geometryChunkIndex"],
            "drawCount": len(section_draws),
            "triangleCount": sum(d["triangleCount"] for d in draws[-len(section_draws):]) if section_draws else 0,
            "classes": dict(Counter(d["blendClass"] for d in section_draws)),
            "draws": section_draws,
        })
        if short == "river" and spec["id"] in E1_CORRIDOR and section_draws:
            for draw in draws[-len(section_draws):]:
                draw["e1TrackDrawIndex"] = track_cursor + draw["drawIndex"]
                draw["e1TrackDrawId"] = "river.block%s.node%s.draw.%d" % (
                    geo_block, node_block, track_cursor + draw["drawIndex"])
            track_cursor += len(section_draws)

    if binding_rows is not None and binding_cursor != len(binding_rows):
        raise SystemExit("binding rows not fully consumed: %d of %d" % (binding_cursor, len(binding_rows)))
    if coverage_mismatch:
        raise SystemExit("draw count mismatch: %r" % (coverage_mismatch,))

    # River 0-100 m spatial slice (12.5 m lateral radius around the measured
    # 0..100 m centreline of the 310.3952 m course).
    slice_ids = []
    if short == "river":
        radius2 = 12.5 * 12.5
        cell = 4.0
        near_cells = set()
        band_by_cell = defaultdict(list)
        reach = int(math.ceil(12.5 / cell)) + 1
        for bx, bz in band_points:
            cx, cz = int(math.floor(bx / cell)), int(math.floor(bz / cell))
            band_by_cell[(cx, cz)].append((bx, bz))
            for dx in range(-reach, reach + 1):
                for dz in range(-reach, reach + 1):
                    near_cells.add((cx + dx, cz + dz))
        for draw in draws:
            doc = track_sections.get(draw["section"])
            if doc is None:
                continue
            positions = doc.get("positions")
            indices = doc.get("indices")
            if not positions or not indices:
                continue
            near = False
            first = draw["firstIndex"]
            for offset in range(first, first + draw["indexCount"]):
                vertex = indices[offset]
                x = positions[vertex * 3]
                z = positions[vertex * 3 + 2]
                cx, cz = int(math.floor(x / cell)), int(math.floor(z / cell))
                if (cx, cz) not in near_cells:
                    continue
                for dx in range(-reach, reach + 1):
                    for dz in range(-reach, reach + 1):
                        for bx, bz in band_by_cell.get((cx + dx, cz + dz), ()):
                            if (x - bx) ** 2 + (z - bz) ** 2 <= radius2:
                                near = True
                                break
                        if near:
                            break
                    if near:
                        break
                if near:
                    break
            if near:
                slice_ids.append(draw["id"])
        slice_set = set(slice_ids)
        for draw in draws:
            draw["riverSlice0to100m"] = draw["id"] in slice_set

    classes = {}
    for name in ("opaque", "alpha-tested", "alpha-blended", "additive-decal", "emissive-light"):
        if class_counts.get(name):
            classes[name] = {
                "draws": class_counts[name],
                "triangles": class_triangles[name],
                "blockers": dict(blockers_by_class[name]),
            }
    for name in classes:
        stage_bytes = Counter()
        stage_textures = Counter()
        unique_ids = set()
        for (texture_id, parameter), entry in texture_index.items():
            count = entry["classes"].get(name, 0)
            if count:
                stage_bytes[parameter] += entry["record"].get("payloadBytes") or 0
                stage_textures[parameter] += 1
                unique_ids.add(texture_id)
        classes[name]["textures"] = len(unique_ids)
        classes[name]["textureStages"] = {
            parameter: {"textures": stage_textures[parameter], "payloadBytes": stage_bytes[parameter]}
            for parameter in sorted(stage_textures)
        }

    texture_rows = []
    for (texture_id, parameter), entry in sorted(texture_index.items()):
        texture_rows.append({
            "id": texture_id,
            "parameter": parameter,
            "record": entry["record"],
            "draws": entry["draws"],
            "triangles": entry["triangles"],
            "classes": dict(entry["classes"]),
        })

    blockers = Counter()
    for draw in draws:
        for blocker in draw["blockers"]:
            blockers[blocker["kind"]] += 1

    result = {
        "schema": SCHEMA,
        "kind": "map-material-recipes",
        "level": level,
        "shortName": short,
        "scope": {
            "dataOnly": True,
            "rendererChanged": False,
            "browserCapture": False,
            "materialsApplied": False,
            "source": "levelrender first-RenderList direct LOD0 primitives",
            "whatIsResolved": ("material row stack, colour/alpha/specular/emissive sources, "
                               "texture stages, blend state, render pass, depth/cull, UV0"),
            "whatIsNotResolved": ("pixel-shaded appearance, sampler wrap/filter, mip selection, "
                                  "shader execution, runtime paint/light state, instances"),
        },
        "inputs": {
            "levelrender": {"file": rel(level_dir / "level.levelrender"),
                            "bytes": len(header), "sha256": sha256_bytes(header)},
            "levelstream": {"file": rel(level_dir / "level.levelstream"),
                            "bytes": (level_dir / "level.levelstream").stat().st_size},
            "slice": (None if slice_doc is None else {
                "file": rel(ROOT / f"_work/map-slice/{short}/slice.json"),
                "sha256": sha256_file(ROOT / f"_work/map-slice/{short}/slice.json")}),
            "bindings": (None if binding_doc is None else {
                "file": rel(ROOT / f"_work/map-slice/{short}-textures/bindings.json"),
                "sha256": sha256_file(ROOT / f"_work/map-slice/{short}-textures/bindings.json")}),
            "sections": [{"id": spec["id"], "stage": rel(spec["stage"]),
                          "nodeChunkSha256": sha256_file(spec["stage"] / "node.chunk"),
                          "referenceSha256": (sha256_file(spec["stage"] / "reference.json")
                                              if (spec["stage"] / "reference.json").exists() else None)}
                         for spec in specs],
        },
        "counts": {
            "sections": len(sections),
            "draws": len(draws),
            "triangles": sum(d["triangleCount"] for d in draws),
            "recipesComplete": sum(1 for d in draws if d["recipeStatus"] == "complete"),
            "recipesPartial": sum(1 for d in draws if d["recipeStatus"] == "partial"),
            "typedBlockers": sum(1 for d in draws if d["blockers"]),
            "blockersByKind": dict(blockers),
            "classes": {name: classes[name]["draws"] for name in classes},
        },
        "classes": classes,
        "sections": sections,
        "draws": draws,
        "textures": texture_rows,
        "limits": [
            "Data only: no renderer, GPU, browser or game claim; material pixels are not decoded.",
            "First-RenderList direct LOD0 primitives only; instancesApplied:false.",
            "Pass and depth decisions are the retail build-time rule applied to the serialized blend state (code tag).",
            "Material-map channels are shader semantics from Shaders/Common/Material.h (code tag), not sampled values.",
            "Alpha values for BC1/BGRA sources are not decoded here for every map; the bindings package alpha stats are reused where present.",
            "UV1 and higher are recorded as declared but are not sampled by the material path (UV0 only).",
        ],
        "hashes": {},
    }
    if short == "river":
        result["counts"]["riverSlice0to100mDraws"] = len(slice_ids)
        result["counts"]["riverSlice0to100mClasses"] = dict(Counter(
            d["blendClass"] for d in draws if d.get("riverSlice0to100m")))
        result["scope"]["riverSlice"] = {
            "definition": ("draws with at least one vertex within 12.5 m of the measured "
                           "0-100 m centreline of the 310.3952 m course"),
            "radiusMetres": 12.5,
            "bandPoints": len(band_points),
            "drawCount": len(slice_ids),
        }
        result["inputs"]["drivablePath"] = {
            "file": rel(ROOT / "_work/drivable-path/path.json"),
            "sha256": sha256_file(ROOT / "_work/drivable-path/path.json")}
        result["inputs"]["trackCoverage"] = {
            "file": rel(TRACK_COVERAGE), "sha256": sha256_file(TRACK_COVERAGE)}
    result["hashes"] = {"contentSha256": canonical_hash(result)}
    write_json(out_dir / "materials.json", result)
    print(json.dumps({
        "level": level, "draws": len(draws), "sections": len(sections),
        "classes": result["counts"]["classes"],
        "recipesComplete": result["counts"]["recipesComplete"],
        "recipesPartial": result["counts"]["recipesPartial"],
        "blockers": result["counts"]["blockersByKind"],
        "slice0to100": result["counts"].get("riverSlice0to100mDraws"),
        "contentSha256": result["hashes"]["contentSha256"],
    }, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
