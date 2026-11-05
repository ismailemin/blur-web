"""Deterministic per-car manifests for the static TEXTURE_INDEX references of
runtime-only vehicle draws.

Scope: the 267 runtime-only draws already classified by the committed
``blur.car-material-texture-manifest`` roster (45 ``_NO_ALBEDO`` paint-lookup
draws, 66 light off/on blend draws, 156 other ``_NO_ALBEDO`` draws). This probe
does not change that classification. For each runtime draw it walks the same
ordered constant material calls, follows constant ``MATERIAL_INDEX`` references,
and resolves every serialized ``TEXTURE_INDEX`` field through the render-list
texture source list to a static shared or resource-block texture. Those static
images are assembled and decoded with the committed ``texture_inspect.exe
--raw`` decoder exactly like ``build_roster_materials.py``.

What this does **not** do:

* It does not recover a paint colour or the runtime ``g_sPaintMaterialTexture``
  lookup. No paint-related texture field is serialized in the model; the paint
  material's dynamic list is a runtime recipe. Paint draws are reported with
  that exact reason and their static dent/scratch/bump references only.
* It does not recover a light blend state or weight. ``g_sOffTexture`` /
  ``g_sOnTexture`` (and damage variants) are static masks, but the blend uses
  runtime ``g_vRenderColour.w`` and both ``UV0.xy`` / ``UV0.zw``.

Data extraction only: ``materialsApplied``, ``shaderExecuted``,
``samplerApplied``, ``paintLookupRecovered``, ``lightBlendRecovered`` and
``rendererClaim`` stay false.

Read-only inputs:
  * ``_work/car-parts/cars/index.json``
  * ``_work/car-materials/roster/cars/<slug>/materials.json`` (P52 classification)
  * ``_work/car-parts/cars/<slug>/scene-report.json``
  * ``_work/car-parts/models/<sha>.decoded``
  * ``_work/build/asset-reader-native/Release/scene_inspect.exe``
  * ``_work/build/asset-reader-native/Release/texture_inspect.exe``
  * ``tools/inspect_car_materials.py`` (imported, not modified)

Output (default ``_work/car-materials/runtime``):
  * ``cars/<slug>/materials.json`` — runtime draw + static reference manifest
  * ``cars/<slug>/textures/*.rawtexture`` — original descriptor + complete chain
  * ``cars/<slug>/textures/*.rgba`` — native mip0 RGBA8
  * ``cars/<slug>/textures/*.png`` — same pixels for inspection
  * ``index.json`` — per-car coverage, texture table and hashes
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
PROBE_TOOLS = Path(__file__).resolve().parent
for entry in (str(TOOLS), str(PROBE_TOOLS)):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import inspect_car_level_assets as car_reader  # noqa: E402
import inspect_car_materials as material_reader  # noqa: E402
import build_roster_materials as roster  # noqa: E402  (committed probe helpers)

SCENE_EXE = roster.SCENE_EXE
TEXTURE_EXE = roster.TEXTURE_EXE
CARS_ROOT = roster.CARS_ROOT
CARS_INDEX = roster.CARS_INDEX
ROSTER_ROOT = ROOT / "_work/car-materials/roster"
MANIFEST_KIND = "blur.car-runtime-texture-manifest"
MANIFEST_VERSION = 1
DECODER_MAX_DIMENSION = roster.DECODER_MAX_DIMENSION

PAINT_LOOKUP_PARAMETER = "g_sPaintMaterialTexture"
LIGHT_BLEND_PARAMETER = "g_vRenderColour.w"

PAINT_REASON = (
    "The _a variant defines _NO_ALBEDO; this draw does not sample an albedo "
    "image; paint appearance comes from runtime g_sPaintMaterialTexture"
)
LIGHT_REASON = (
    "Off/On texture blend depends on runtime g_vRenderColour.w, and uses both "
    "UV0.xy/zw"
)
NO_ALBEDO_REASON = (
    "The _a variant defines _NO_ALBEDO; this draw does not sample an albedo image"
)

PAINT_SOURCE_LINES = [
    "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/shaders.jam:29"
    " — <_a> defines _NO_ALBEDO",
    "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/vehicle/"
    "shaders/vehicle_common.h:508 — shared texture g_sPaintMaterialTexture",
    "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/vehicle/"
    "shaders/vehicle_common.h:583 — PaintTextureSampler binds it",
    "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/vehicle/"
    "shaders/vehicle_common.h:1250 — tex2Dlod(PaintTextureSampler, (NdotV,0))",
    "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/"
    "VehicleModelManager.cpp:372 — exposed as MATERIAL_ELEMENT_TYPE_TEXTURE_PTR",
    "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/"
    "VehicleModel.cpp:1759 and customisation/PaintEditor.cpp — supplied from the "
    "runtime paint job",
    "tools/inspect_car_materials.py:314-315 — committed reader's shape",
]
LIGHT_SOURCE_LINES = [
    "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/vehicle/"
    "shaders/vehicle_common.h:447-450 — g_sOffTexture/g_sOnTexture and damage "
    "variants",
    "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/include/vehicle/"
    "shaders/vehicle_common.h:1212-1214 — off samples UV0.xy, on samples UV0.zw, "
    "lerp weight is g_vRenderColour.w",
    "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/"
    "VehicleModelManager.cpp:411,418,427,477 — g_vRenderColour exposed as a "
    "runtime F32 parameter",
    "tools/inspect_car_materials.py:312 — committed reader's shape",
]


def sha256_bytes(data: bytes) -> str:
    return roster.sha256_bytes(data)


def sha256_file(path: Path) -> str:
    return roster.sha256_file(path)


def rel(path: Path) -> str:
    return roster.rel(path)


def safe_name(name: str) -> str:
    return roster.safe_name(name)


def json_text(value) -> str:
    return roster.json_text(value)


def texture_id(kind: str, name: str, block: int | None, index: int) -> str:
    safe = safe_name(name)
    if kind == "shared":
        return f"shared:{index}:{safe}"
    return f"block:{block}:{index}:{safe}"


def draw_kind(roster_draw: dict) -> str:
    if roster_draw["status"] == "runtime_light_blend":
        return "light"
    if roster_draw["status"] == "shader_no_albedo":
        family = (roster_draw.get("shaderFamily") or "").lower()
        if family in ("paint", "paintm"):
            return "paint"
        return "no_albedo"
    raise RuntimeError(
        f"internal: draw {roster_draw['index']} is not a runtime-only roster draw"
    )


def reference_role(kind: str, parameter: str, effect: str) -> str:
    if parameter == "g_sOffTexture":
        return "light-off-texture"
    if parameter == "g_sOnTexture":
        return "light-on-texture"
    if parameter == "g_sOffTextureDamage":
        return "light-off-damage-texture"
    if parameter == "g_sOnTextureDamage":
        return "light-on-damage-texture"
    glass = "glass" in effect.lower()
    if kind == "paint":
        if parameter == "g_DentTexture":
            return "paint-dent-texture"
        if parameter == "g_ScratchTexture":
            return "paint-scratch-texture"
        if parameter == "g_BumpTexture":
            return "paint-bump-texture"
        return "paint-auxiliary-texture"
    if parameter == "g_DentTexture":
        return "glass-dent-normal-texture" if glass else "dent-texture"
    if parameter == "g_ScratchTexture":
        return "glass-scratch-texture" if glass else "scratch-texture"
    if parameter == "g_BumpTexture":
        return "bump-texture"
    return "auxiliary-texture"


def texture_identity(kind: str, name: str, block, index, scene, blocks) -> dict:
    if kind == "shared":
        source = scene["sharedTextures"][index]
        return {
            "kind": "shared",
            "name": name,
            "hash": source["hash"],
            "sharedIndex": index,
            "index": index,
            "dataOffset": source["dataOffset"],
            "dataBytes": source["dataBytes"],
        }
    stored = blocks[block]["textures"][index]
    return {
        "kind": "resource-block",
        "name": name,
        "hash": stored["hash"],
        "block": block,
        "index": index,
        "sampler": stored["sampler"],
    }


def make_texture_record(
    out_root: Path,
    slug: str,
    target: dict,
    model_bytes: bytes,
    scene: dict,
    blocks: list,
    cpp_textures: dict,
) -> dict:
    """Decode one static texture with the committed roster rules."""
    identity = target["identity"]
    record = {
        "id": target["id"],
        "kind": identity["kind"],
        "name": identity["name"],
        "nameEmpty": identity["name"] == "",
        "hash": identity["hash"],
        "parameters": sorted(target["parameters"]),
        "roles": sorted(target["roles"]),
        "drawIndices": sorted(target["drawIndices"]),
        "decoded": None,
        "undecodedReason": None,
    }
    if identity["kind"] == "shared":
        index = identity["sharedIndex"]
        source = scene["sharedTextures"][index]
        record.update({
            "sharedIndex": index,
            "dataOffset": source["dataOffset"],
            "dataBytes": source["dataBytes"],
            "sampler": source.get("sampler"),
        })
        desc = roster.descriptor_at(model_bytes, source["dataOffset"])
        sizes = roster.chain_sizes(desc)
        if 28 + sum(sizes) != source["dataBytes"]:
            raise RuntimeError(
                f"{slug}: shared {target['id']} data bytes do not match its chain"
            )
        chain = model_bytes[source["dataOffset"] + 28: source["dataOffset"] + source["dataBytes"]]
        raw = model_bytes[source["dataOffset"]: source["dataOffset"] + source["dataBytes"]]
        decodable = (
            desc["format"] in roster.ALLOWED_FORMATS
            and desc["width"] <= DECODER_MAX_DIMENSION
            and desc["height"] <= DECODER_MAX_DIMENSION
        )
        reason = None
        if not decodable:
            reason = (
                f"shared descriptor {desc['width']}x{desc['height']} "
                f"{desc['formatName']} is outside the committed decoder bound "
                f"{DECODER_MAX_DIMENSION}x{DECODER_MAX_DIMENSION} or format; a "
                "shared texture stores one descriptor, so no lower LOD is available"
            )
        record.update({
            "descriptor": desc,
            "levels": desc["levels"],
            "source": "embedded PC TextureDesc + complete mip chain",
            "lods": [{
                "lod": 0,
                "present": True,
                "descriptor": desc,
                "descriptorOffset": source["dataOffset"],
                "descriptorBytes": 28,
                "payloadOffset": source["dataOffset"] + 28,
                "payloadBytes": source["dataBytes"] - 28,
                "completeMipBytes": sum(sizes),
                "topMipLevels": desc["levels"],
                "assembled": True,
                "decodable": decodable,
                "reason": reason,
            }],
        })
        if decodable:
            stem = f"shared-{index}-{safe_name(identity['name'])}"
            record["decoded"] = roster.write_texture_outputs(
                out_root / "cars" / slug, stem, desc, raw, chain
            )
            record["decoded"]["sourceLod"] = 0
            record["decoded"]["source"] = "embedded complete chain"
        else:
            record["undecodedReason"] = reason
        return record

    block_index, texture_index = identity["block"], identity["index"]
    stored = blocks[block_index]["textures"][texture_index]
    cpp_stored = cpp_textures.get((block_index, texture_index))
    if cpp_stored is None:
        raise RuntimeError(f"{slug}: {target['id']} missing from C++ resource metadata")
    if (cpp_stored["name"], cpp_stored["hash"]) != (stored["name"], stored["hash"]):
        raise RuntimeError(f"{slug}: {target['id']} C++ resource identity differs")
    record.update({"block": block_index, "index": texture_index, "lods": []})
    previous = None
    best = None
    failed = False
    for lod in stored["lods"]:
        if not lod["present"]:
            record["lods"].append({
                "lod": lod["lod"],
                "present": False,
                "decodable": False,
                "reason": "not present in this source LOD stream",
            })
            continue
        entry = {
            "lod": lod["lod"],
            "present": True,
            "descriptorOffset": lod["headerOffset"],
            "descriptorBytes": lod["headerBytes"],
            "payloadOffset": lod["dataOffset"],
            "payloadBytes": lod["dataBytes"],
        }
        try:
            raw, previous, segments, top_levels = roster.assemble_lod(
                model_bytes, lod, previous
            )
        except (ValueError, KeyError) as error:
            entry.update({
                "descriptor": lod.get("descriptor"),
                "assembled": False,
                "decodable": False,
                "reason": str(error),
            })
            record["lods"].append(entry)
            failed = True
            break
        desc, chain = previous
        cpp_lod = next(
            (item for item in cpp_stored["lods"] if item["lod"] == lod["lod"]), None
        )
        if cpp_lod is None:
            raise RuntimeError(f"{slug}: {target['id']} lod {lod['lod']} missing in C++")
        if cpp_lod["descriptor"] != lod["descriptor"]:
            raise RuntimeError(f"{slug}: {target['id']} lod {lod['lod']} descriptor differs")
        if cpp_lod["payloadOffset"] != lod["dataOffset"]:
            raise RuntimeError(f"{slug}: {target['id']} lod {lod['lod']} payload offset differs")
        if cpp_lod["payloadBytes"] != lod["dataBytes"]:
            raise RuntimeError(f"{slug}: {target['id']} lod {lod['lod']} payload bytes differ")
        if cpp_lod["completeMipBytes"] != len(chain):
            raise RuntimeError(f"{slug}: {target['id']} lod {lod['lod']} complete bytes differ")
        if cpp_lod["topMipLevels"] != top_levels:
            raise RuntimeError(f"{slug}: {target['id']} lod {lod['lod']} top mip count differs")
        decodable = (
            desc["format"] in roster.ALLOWED_FORMATS
            and desc["width"] <= DECODER_MAX_DIMENSION
            and desc["height"] <= DECODER_MAX_DIMENSION
        )
        reason = None
        if not decodable:
            reason = (
                f"descriptor {desc['width']}x{desc['height']} {desc['formatName']} "
                f"exceeds the committed decoder bound "
                f"{DECODER_MAX_DIMENSION}x{DECODER_MAX_DIMENSION} or has an "
                "unsupported format"
            )
        entry.update({
            "descriptor": desc,
            "completeMipBytes": len(chain),
            "topMipLevels": top_levels,
            "sourceSegments": segments,
            "assembled": True,
            "decodable": decodable,
            "reason": reason,
        })
        record["lods"].append(entry)
        if decodable:
            best = (lod["lod"], desc, chain, raw, segments)
    if best is not None:
        chosen_lod, desc, chain, raw, segments = best
        stem = (
            f"block-{block_index}-{texture_index}-{safe_name(identity['name'])}"
            f"-lod{chosen_lod}-{desc['width']}x{desc['height']}"
        )
        decoded = roster.write_texture_outputs(
            out_root / "cars" / slug, stem, desc, raw, chain
        )
        decoded.update({
            "sourceLod": chosen_lod,
            "source": "assembled original descriptor + complete mip chain",
            "sourceSegments": segments,
        })
        record["decoded"] = decoded
    else:
        reasons = [entry.get("reason") for entry in record["lods"] if entry.get("reason")]
        record["undecodedReason"] = (
            reasons[0] if reasons else "no populated decodable mip chain"
        )
    if failed and record["undecodedReason"] is None:
        record["undecodedReason"] = "a later source LOD could not be assembled"
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out-dir", type=Path, default=ROOT / "_work/car-materials/runtime"
    )
    parser.add_argument(
        "--roster-dir", type=Path, default=ROSTER_ROOT,
        help="committed P52 roster output (classification authority)",
    )
    parser.add_argument(
        "--cars-index", type=Path, default=CARS_INDEX,
        help="committed per-car index (mapping, model/manifest hashes)",
    )
    args = parser.parse_args()
    out_root = args.out_dir.resolve()
    roster_root = args.roster_dir.resolve()
    for forbidden in (ROOT / "game-data", ROOT / "upstream"):
        if out_root.is_relative_to(forbidden.resolve()):
            parser.error(f"output must not be inside {forbidden.name}")
    if not (roster_root / "index.json").is_file():
        parser.error(f"missing committed roster output: {roster_root / 'index.json'}")
    out_root.mkdir(parents=True, exist_ok=True)

    index = json.loads(args.cars_index.read_text(encoding="utf-8"))
    if index.get("kind") != "car-parts.car-model-index" or len(index.get("mapped", [])) != 5:
        raise RuntimeError("committed car index is not the five-car mapped index")
    cars = sorted(index["cars"], key=lambda row: row["slug"])

    summaries = []
    for car in cars:
        slug = car["slug"]
        name = car["name"]
        model_path = ROOT / car["decodedModel"]
        manifest_path = CARS_ROOT / slug / "manifest.json"
        committed_report_path = ROOT / car["sceneReport"]
        roster_manifest_path = roster_root / "cars" / slug / "materials.json"
        if not roster_manifest_path.is_file():
            raise RuntimeError(f"{slug}: missing committed roster manifest")
        model_bytes = model_path.read_bytes()
        if sha256_bytes(model_bytes) != car["modelSha256"]:
            raise RuntimeError(f"{slug}: decoded model hash differs from the committed index")
        if sha256_file(manifest_path) != car["manifestSha256"].removeprefix("sha256:"):
            raise RuntimeError(f"{slug}: part manifest hash differs from the committed index")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("kind") != "blur.car-part-manifest":
            raise RuntimeError(f"{slug}: unexpected part manifest kind")
        roster_manifest = json.loads(roster_manifest_path.read_text(encoding="utf-8"))
        if roster_manifest.get("kind") != "blur.car-material-texture-manifest":
            raise RuntimeError(f"{slug}: unexpected roster manifest kind")

        scene, scene_sha, scene_raw = roster.run_json(SCENE_EXE, str(model_path))
        resources, resources_sha, _ = roster.run_json(
            SCENE_EXE, str(model_path), "--resources"
        )
        committed_report = committed_report_path.read_bytes()
        if scene_raw != committed_report:
            raise RuntimeError(f"{slug}: scene report is not byte-identical to committed")
        if len(scene["draws"]) != len(roster_manifest["draws"]):
            raise RuntimeError(f"{slug}: roster draw count differs from C++ scene report")

        old_reader = car_reader.Reader
        try:
            car_reader.Reader = material_reader.MaterialReader
            layout = car_reader.render_layout(model_bytes, "model")
        finally:
            car_reader.Reader = old_reader
        scene_end = next(c["end"] for c in layout["chunks"] if c["id"] == "Scene")
        blocks = material_reader.resource_blocks(model_bytes, layout["scene"], scene_end)
        render_list = next(
            node for node in blocks[0]["nodes"]
            if node["type"] == "RenderingData::RenderListNode_Common"
        )
        resolved, uv = material_reader.resolved_report(
            model_bytes, layout["scene"], blocks, render_list
        )
        python_draws = resolved["draws"]
        if not (len(python_draws) == len(scene["draws"]) == len(roster_manifest["draws"])):
            raise RuntimeError(
                f"{slug}: draw counts differ: python={len(python_draws)} "
                f"cpp={len(scene['draws'])} roster={len(roster_manifest['draws'])}"
            )

        cpp_textures: dict[tuple[int, int], dict] = {}
        for block in resources["resourceBlocks"]:
            for texture in block["textures"]:
                cpp_textures[(block["index"], texture["index"])] = texture

        texture_targets: dict[str, dict] = {}
        draw_records = []
        runtime_indices = []
        for draw_index, (py, roster_draw) in enumerate(
            zip(python_draws, roster_manifest["draws"])
        ):
            if roster_draw["index"] != draw_index:
                raise RuntimeError(f"{slug}: roster draw order differs at {draw_index}")
            if roster_draw["albedoParameter"] is not None:
                continue
            kind = draw_kind(roster_draw)
            runtime_indices.append(draw_index)
            if py["status"] != roster_draw["status"]:
                raise RuntimeError(
                    f"{slug}: draw {draw_index} status differs: "
                    f"python={py['status']} roster={roster_draw['status']}"
                )
            if (py["shaderFamily"] or "") != (roster_draw.get("shaderFamily") or ""):
                raise RuntimeError(
                    f"{slug}: draw {draw_index} shader family differs"
                )
            if bool(py["noAlbedoDefine"]) != bool(roster_draw["noAlbedoDefine"]):
                raise RuntimeError(f"{slug}: draw {draw_index} _NO_ALBEDO flag differs")
            if py["uv0"]["available"] != roster_draw["uv0Available"]:
                raise RuntimeError(f"{slug}: draw {draw_index} UV0 availability differs")

            primitive = render_list["primitives"][draw_index]
            calls, assignments, unknown = material_reader.material_assignments(
                render_list, primitive
            )
            bindings = []
            unsupported_fields = []
            for parameter in sorted(assignments):
                value = assignments[parameter]
                if value["type"] != 7:
                    continue
                if not value["static"]:
                    unsupported_fields.append({
                        "parameter": parameter,
                        "reason": "TEXTURE_PTR/DATA_INDEX is a runtime value, not a static TEXTURE_INDEX",
                    })
                    continue
                try:
                    binding = material_reader.texture_binding(
                        value["values"][0], render_list, layout["scene"], blocks
                    )
                except (ValueError, IndexError) as error:
                    unsupported_fields.append({
                        "parameter": parameter,
                        "nodeTextureIndex": value["values"][0],
                        "reason": f"texture source rejected: {error}",
                    })
                    continue
                if binding["kind"] == "shared":
                    identity = texture_identity(
                        "shared", binding["name"], None, binding["index"],
                        layout["scene"], blocks,
                    )
                else:
                    identity = texture_identity(
                        "resource-block", binding["name"], binding["block"],
                        binding["index"], layout["scene"], blocks,
                    )
                tid = texture_id(identity["kind"], identity["name"],
                                 identity.get("block"), identity["index"])
                role = reference_role(kind, parameter, py["effect"])
                target = texture_targets.setdefault(tid, {
                    "id": tid,
                    "identity": identity,
                    "parameters": set(),
                    "roles": set(),
                    "drawIndices": [],
                })
                if target["identity"] != identity:
                    raise RuntimeError(f"{slug}: texture identity conflict for {tid}")
                target["parameters"].add(parameter)
                target["roles"].add(role)
                if draw_index not in target["drawIndices"]:
                    target["drawIndices"].append(draw_index)
                bindings.append({
                    "parameter": parameter,
                    "role": role,
                    "materialStage": value["stage"],
                    "materialIndex": value["materialIndex"],
                    "materialList": value["materialList"],
                    "fieldSerializedOffset": value["serializedOffset"],
                    "nodeTextureIndex": binding["nodeTextureIndex"],
                    "textureId": tid,
                    "textureKind": identity["kind"],
                    "textureName": identity["name"],
                    "textureHash": identity["hash"],
                    "block": identity.get("block"),
                    "index": identity["index"],
                    "sampler": identity.get("sampler"),
                })

            runtime_only = {
                "paintLookup": None,
                "lightBlend": None,
                "runtimeMaterialInputs": [
                    {
                        "stage": item["stage"],
                        "index": item["index"],
                        "listIndex": item["listIndex"],
                        "reason": item["reason"],
                    }
                    for item in unknown
                ],
            }
            if kind == "paint":
                runtime_only["paintLookup"] = {
                    "parameter": PAINT_LOOKUP_PARAMETER,
                    "field": PAINT_LOOKUP_PARAMETER,
                    "resolution": "unsupported",
                    "resolved": False,
                    "reason": PAINT_REASON,
                    "presentInSerializedMaterial": False,
                    "paintColourRecovered": False,
                    "paintTextureRecovered": False,
                    "sourceLines": PAINT_SOURCE_LINES,
                    "note": (
                        "The serialized paint materials provide only dent/scratch/"
                        "bump TEXTURE_INDEX fields; g_sPaintMaterialTexture is a "
                        "TEXTURE_PTR supplied from the runtime paint job."
                    ),
                }
            elif kind == "light":
                runtime_only["lightBlend"] = {
                    "parameter": LIGHT_BLEND_PARAMETER,
                    "field": LIGHT_BLEND_PARAMETER,
                    "resolution": "unsupported",
                    "resolved": False,
                    "reason": LIGHT_REASON,
                    "uvInputs": ["UV0.xy", "UV0.zw"],
                    "blendWeightRecovered": False,
                    "staticMaskTextureIds": sorted({
                        item["textureId"] for item in bindings
                    }),
                    "sourceLines": LIGHT_SOURCE_LINES,
                }
            resolved_static = len(bindings) > 0
            draw_records.append({
                "index": draw_index,
                "kind": kind,
                "effect": py["effect"],
                "shaderFamily": py["shaderFamily"],
                "noAlbedoDefine": bool(py["noAlbedoDefine"]),
                "status": py["status"],
                "binding": roster_draw["binding"],
                "runtimeReason": roster_draw["runtimeReason"],
                "ordinaryAlbedoParameter": None,
                "ordinaryAlbedoResolved": False,
                "staticTextureBindings": bindings,
                "unsupportedStaticFields": unsupported_fields,
                "staticReferenceResolved": resolved_static,
                "runtimeOnly": runtime_only,
                "paintLookupResolved": False,
                "lightBlendResolved": False,
                "completeOriginalMaterialReproduced": False,
            })

        # Decode every referenced static texture exactly once per car.
        texture_records = [
            make_texture_record(
                out_root, slug, texture_targets[tid], model_bytes,
                layout["scene"], blocks, cpp_textures,
            )
            for tid in sorted(texture_targets)
        ]
        if len({record["id"] for record in texture_records}) != len(texture_records):
            raise RuntimeError(f"{slug}: texture id collision")

        # Cross-check the P52 roster's already-decoded textures: same model,
        # same id, same RGBA hash. This is not used as decode authority.
        roster_textures = {
            item["id"]: item for item in roster_manifest.get("textures", [])
            if item.get("decoded")
        }
        cross_checks = []
        for record in texture_records:
            other = roster_textures.get(record["id"])
            if other is None:
                continue
            if not record["decoded"]:
                raise RuntimeError(f"{slug}: roster decoded {record['id']} but runtime did not")
            if other["decoded"]["rgba"]["sha256"] != record["decoded"]["rgba"]["sha256"]:
                raise RuntimeError(f"{slug}: {record['id']} RGBA differs from roster")
            cross_checks.append({
                "textureId": record["id"],
                "rgbaSha256": record["decoded"]["rgba"]["sha256"],
                "rosterMatches": True,
            })

        paint_draws = [d for d in draw_records if d["kind"] == "paint"]
        light_draws = [d for d in draw_records if d["kind"] == "light"]
        no_albedo_draws = [d for d in draw_records if d["kind"] == "no_albedo"]
        decoded = [t for t in texture_records if t["decoded"]]
        total_rgba = sum(t["decoded"]["rgba"]["bytes"] for t in decoded)
        total_raw = sum(t["decoded"]["rawtexture"]["bytes"] for t in decoded)
        coverage = {
            "drawCount": len(roster_manifest["draws"]),
            "staticAlbedoDrawCount": roster_manifest["coverage"]["staticAlbedoDrawCount"],
            "runtimeDrawCount": len(draw_records),
            "runtimePaintLookupDrawCount": len(paint_draws),
            "runtimeLightBlendDrawCount": len(light_draws),
            "runtimeShaderNoAlbedoDrawCount": len(no_albedo_draws),
            "runtimeDrawsWithStaticReferences": sum(
                1 for d in draw_records if d["staticReferenceResolved"]
            ),
            "runtimeDrawsWithoutStaticReferences": sum(
                1 for d in draw_records if not d["staticReferenceResolved"]
            ),
            "paintDrawsWithStaticAuxiliaryTextures": sum(
                1 for d in paint_draws if d["staticReferenceResolved"]
            ),
            "paintDrawsWithResolvedPaintLookup": 0,
            "lightDrawsWithStaticMaskTextures": sum(
                1 for d in light_draws if d["staticReferenceResolved"]
            ),
            "lightDrawsWithResolvedBlend": 0,
            "noAlbedoDrawsWithStaticReferences": sum(
                1 for d in no_albedo_draws if d["staticReferenceResolved"]
            ),
            "noAlbedoDrawsWithoutStaticReferences": sum(
                1 for d in no_albedo_draws if not d["staticReferenceResolved"]
            ),
            "staticTextureBindingCount": sum(
                len(d["staticTextureBindings"]) for d in draw_records
            ),
            "unsupportedStaticFieldCount": sum(
                len(d["unsupportedStaticFields"]) for d in draw_records
            ),
            "uniqueTextureCount": len(texture_records),
            "decodedTextureCount": len(decoded),
            "undecodedTextureCount": len(texture_records) - len(decoded),
            "decodedRgbaBytes": total_rgba,
            "decodedRawtextureBytes": total_raw,
            "textureRoleCounts": {
                role: sum(1 for t in texture_records if role in t["roles"])
                for role in sorted({role for t in texture_records for role in t["roles"]})
            },
        }
        if coverage["runtimePaintLookupDrawCount"] != roster_manifest["coverage"][
            "runtimePaintLookupDrawCount"
        ]:
            raise RuntimeError(f"{slug}: paint draw count differs from roster")
        if coverage["runtimeLightBlendDrawCount"] != roster_manifest["coverage"][
            "runtimeLightBlendDrawCount"
        ]:
            raise RuntimeError(f"{slug}: light draw count differs from roster")
        if coverage["runtimeShaderNoAlbedoDrawCount"] != roster_manifest["coverage"][
            "runtimeShaderNoAlbedoDrawCount"
        ]:
            raise RuntimeError(f"{slug}: no-albedo draw count differs from roster")
        if coverage["runtimeDrawCount"] != (
            coverage["runtimePaintLookupDrawCount"]
            + coverage["runtimeLightBlendDrawCount"]
            + coverage["runtimeShaderNoAlbedoDrawCount"]
        ):
            raise RuntimeError(f"{slug}: runtime draw split does not add up")
        if coverage["paintDrawsWithResolvedPaintLookup"] != 0:
            raise RuntimeError(f"{slug}: paint lookup must not be claimed")
        if coverage["lightDrawsWithResolvedBlend"] != 0:
            raise RuntimeError(f"{slug}: light blend must not be claimed")

        output = {
            "kind": MANIFEST_KIND,
            "version": MANIFEST_VERSION,
            "classification": {
                "authority": (
                    "committed roster manifest (blur.car-material-texture-manifest) "
                    "re-checked against tools/inspect_car_materials.py"
                ),
                "runtimeDrawCount": len(draw_records),
                "paint": {
                    "drawCount": len(paint_draws),
                    "criterion": (
                        "shaderFamily in {paint, paintm} and the effect token list "
                        "contains 'a' (_NO_ALBEDO); no g_MeshTexture assignment"
                    ),
                    "effectFamilies": {
                        family: sum(1 for d in paint_draws
                                    if (d["shaderFamily"] or "") == family)
                        for family in sorted({d["shaderFamily"] or "" for d in paint_draws})
                    },
                    "materialTextureFields": sorted({
                        b["parameter"] for d in paint_draws
                        for b in d["staticTextureBindings"]
                    }),
                    "sourceLines": PAINT_SOURCE_LINES,
                },
                "light": {
                    "drawCount": len(light_draws),
                    "criterion": (
                        "shaderFamily == light; off/on and damage TEXTURE_INDEX "
                        "fields are static, the blend is not"
                    ),
                    "effectFamilies": {
                        family: sum(1 for d in light_draws
                                    if (d["shaderFamily"] or "") == family)
                        for family in sorted({d["shaderFamily"] or "" for d in light_draws})
                    },
                    "materialTextureFields": sorted({
                        b["parameter"] for d in light_draws
                        for b in d["staticTextureBindings"]
                    }),
                    "sourceLines": LIGHT_SOURCE_LINES,
                },
                "noAlbedo": {
                    "drawCount": len(no_albedo_draws),
                    "criterion": (
                        "any other effect whose token list contains 'a' "
                        "(_NO_ALBEDO); no g_MeshTexture assignment"
                    ),
                    "effectFamilies": {
                        family: sum(1 for d in no_albedo_draws
                                    if (d["shaderFamily"] or "") == family)
                        for family in sorted({d["shaderFamily"] or "" for d in no_albedo_draws})
                    },
                    "materialTextureFields": sorted({
                        b["parameter"] for d in no_albedo_draws
                        for b in d["staticTextureBindings"]
                    }),
                    "sourceLines": [
                        "upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/"
                        "shaders.jam:29 — <_a> defines _NO_ALBEDO",
                        "tools/inspect_car_materials.py:313-314 — committed reader's "
                        "shape",
                    ],
                },
            },
            "source": {
                "car": {"slug": slug, "name": name},
                "model": {
                    "path": rel(model_path),
                    "sha256": car["modelSha256"],
                    "bytes": len(model_bytes),
                    "pakPath": car["pakPath"],
                    "pakRecord": car["record"],
                },
                "partManifest": {
                    "path": rel(manifest_path),
                    "sha256": sha256_file(manifest_path),
                    "kind": manifest["kind"],
                    "version": manifest["version"],
                },
                "rosterManifest": {
                    "path": rel(roster_manifest_path),
                    "sha256": sha256_file(roster_manifest_path),
                    "kind": roster_manifest["kind"],
                    "version": roster_manifest["version"],
                    "role": "classification authority for the 267 runtime-only draws",
                },
                "sceneReport": {
                    "reader": "scene_inspect.exe",
                    "committedPath": rel(committed_report_path),
                    "committedSha256": sha256_bytes(committed_report),
                    "reproducedSha256": scene_sha,
                    "reproducedByteIdentical": True,
                    "scope": scene["metadata"]["scope"],
                },
                "resourceMetadata": {
                    "reader": "scene_inspect.exe --resources",
                    "sha256": resources_sha,
                    "resourceBlocks": resources["resourceBlockCount"],
                    "loadedResourceBlocks": resources["loadedResourceBlocks"],
                },
                "independentParser": {
                    "reader": "tools/inspect_car_materials.py (imported, read-only)",
                    "sceneEnd": scene_end,
                    "resourceBlockCount": len(blocks),
                },
                "textureDecoder": {
                    "reader": "texture_inspect.exe --raw",
                    "pcFormatContract": "probes/asset-reader/FORMAT-texture.md",
                    "maxDimension": DECODER_MAX_DIMENSION,
                    "supportedFormats": sorted(roster.ALLOWED_FORMATS.values()),
                },
            },
            "scope": {
                "drawSet": "the 267 runtime-only draws of the first RenderList LOD0",
                "applies": "static TEXTURE_INDEX reference resolution and image decode only",
                "materialsApplied": False,
                "shaderExecuted": False,
                "samplerApplied": False,
                "paintLookupRecovered": False,
                "lightBlendRecovered": False,
                "staticReferencesDecoded": True,
                "rendererClaim": False,
            },
            "coverage": coverage,
            "draws": draw_records,
            "textures": texture_records,
            "rosterCrossChecks": cross_checks,
            "limits": [
                "Only serialized TEXTURE_INDEX fields on the 267 runtime-only draws are "
                "resolved. Runtime rebuilt material lists (listIndex != 0) are recipes, "
                "not ready shader values, and are never treated as static textures.",
                "Paint appearance is not recovered. No g_sPaintMaterialTexture field is "
                "serialized in the model; the paint lookup is a runtime TEXTURE_PTR built "
                "from the user's paint job. Only paint dent/scratch/bump texture "
                "references are decoded, and they must not be read as paint colour.",
                "Light blend state is not recovered. Off/on/damage masks are static "
                "TEXTURE_INDEX inputs, but the blend weight is runtime g_vRenderColour.w "
                "and off/on sample UV0.xy/UV0.zw.",
                "Texture images are decoded mip0 RGBA8. No sampling state, UV transform, "
                "colour space, sRGB, alpha blend, shader code, paint lookup or light "
                "blend is applied.",
                "Shared textures have one descriptor; a 1024x1024 mip0 outside the "
                "committed 512x512 decoder bound is recorded as undecoded with its exact "
                "reason rather than re-labelled or downscaled.",
                "No renderer or game claim is made; decoded pixels are source images, not "
                "a reproduction of retail car appearance.",
            ],
        }

        car_dir = out_root / "cars" / slug
        car_dir.mkdir(parents=True, exist_ok=True)
        manifest_out = car_dir / "materials.json"
        manifest_out.write_text(json_text(output), encoding="utf-8")
        summaries.append({
            "slug": slug,
            "name": name,
            "manifest": f"cars/{slug}/materials.json",
            "manifestSha256": sha256_file(manifest_out),
            "coverage": coverage,
            "textures": {
                t["id"]: {
                    "name": t["name"],
                    "nameEmpty": t["nameEmpty"],
                    "hash": t["hash"],
                    "kind": t["kind"],
                    "parameters": t["parameters"],
                    "roles": t["roles"],
                    "decoded": bool(t["decoded"]),
                    "lod": t["decoded"]["sourceLod"] if t["decoded"] else None,
                    "width": t["decoded"]["nativeDecoder"]["width"] if t["decoded"] else None,
                    "height": t["decoded"]["nativeDecoder"]["height"] if t["decoded"] else None,
                    "rgbaSha256": t["decoded"]["rgba"]["sha256"] if t["decoded"] else None,
                    "undecodedReason": t["undecodedReason"],
                }
                for t in texture_records
            },
        })
        print(
            f"{slug}: runtime={coverage['runtimeDrawCount']} "
            f"paint={coverage['runtimePaintLookupDrawCount']} "
            f"light={coverage['runtimeLightBlendDrawCount']} "
            f"no-albedo={coverage['runtimeShaderNoAlbedoDrawCount']} "
            f"with-static={coverage['runtimeDrawsWithStaticReferences']} "
            f"without-static={coverage['runtimeDrawsWithoutStaticReferences']} "
            f"textures={coverage['uniqueTextureCount']} "
            f"decoded={coverage['decodedTextureCount']} "
            f"undecoded={coverage['undecodedTextureCount']}"
        )

    aggregate = {
        "kind": "blur.car-runtime-texture-index",
        "version": MANIFEST_VERSION,
        "carCount": len(summaries),
        "totals": {
            "runtimeDraws": sum(s["coverage"]["runtimeDrawCount"] for s in summaries),
            "paintDraws": sum(s["coverage"]["runtimePaintLookupDrawCount"] for s in summaries),
            "lightDraws": sum(s["coverage"]["runtimeLightBlendDrawCount"] for s in summaries),
            "noAlbedoDraws": sum(s["coverage"]["runtimeShaderNoAlbedoDrawCount"] for s in summaries),
            "drawsWithStaticReferences": sum(
                s["coverage"]["runtimeDrawsWithStaticReferences"] for s in summaries
            ),
            "drawsWithoutStaticReferences": sum(
                s["coverage"]["runtimeDrawsWithoutStaticReferences"] for s in summaries
            ),
            "paintDrawsWithStaticAuxiliaryTextures": sum(
                s["coverage"]["paintDrawsWithStaticAuxiliaryTextures"] for s in summaries
            ),
            "paintDrawsWithResolvedPaintLookup": 0,
            "lightDrawsWithStaticMaskTextures": sum(
                s["coverage"]["lightDrawsWithStaticMaskTextures"] for s in summaries
            ),
            "lightDrawsWithResolvedBlend": 0,
            "noAlbedoDrawsWithStaticReferences": sum(
                s["coverage"]["noAlbedoDrawsWithStaticReferences"] for s in summaries
            ),
            "noAlbedoDrawsWithoutStaticReferences": sum(
                s["coverage"]["noAlbedoDrawsWithoutStaticReferences"] for s in summaries
            ),
            "uniqueTextures": sum(s["coverage"]["uniqueTextureCount"] for s in summaries),
            "decodedTextures": sum(s["coverage"]["decodedTextureCount"] for s in summaries),
            "undecodedTextures": sum(s["coverage"]["undecodedTextureCount"] for s in summaries),
            "decodedRgbaBytes": sum(s["coverage"]["decodedRgbaBytes"] for s in summaries),
            "decodedRawtextureBytes": sum(
                s["coverage"]["decodedRawtextureBytes"] for s in summaries
            ),
        },
        "cars": summaries,
        "limits": [
            "Per-car manifests are independent; identical texture names across cars are "
            "not assumed to be identical bytes.",
            "Static references on runtime-only draws do not make the draw's paint or light "
            "appearance static. Paint lookup and light blend stay unresolved.",
            "No renderer, shader, sampling or game behaviour is claimed.",
        ],
    }
    index_out = out_root / "index.json"
    index_out.write_text(json_text(aggregate), encoding="utf-8")
    print(json.dumps(aggregate["totals"], indent=2))
    print(f"wrote {rel(index_out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
