#!/usr/bin/env python3
"""Build the per-level lighting manifests under ``_work/lighting/``.

Every value carries a provenance label:

  data         read from a shipped retail byte stream (offset recorded)
  code         a constant or formula in the upstream source (file:line recorded)
  provisional  derived here for the WebGPU consumer, not a retail value

The manifests are deterministic: no timestamps, sorted keys, fixed separators.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import lighting_data as LD  # noqa: E402
import lightmap_data as LM  # noqa: E402

ROOT = LD.ROOT
OUT_DIR = ROOT / "_work/lighting"

# Shader/engine constants that are code-only (no per-level serialization).
CODE_REFERENCES = {
    "diffuseOrder": {
        "kind": "code",
        "value": "diffuse = ((baked * BakedColour) + SkyColour*skyOcc*saturate(n.y*0.5+0.5) + SunColour*saturate(dot(n,sunDir))*sunOcc) * albedo * diffuseIntensity",
        "source": "code/mercury/library/graphics/shader/include/shader/common/Lighting.h:153-165",
    },
    "defaultSunColour": {
        "kind": "code",
        "value": [1.0, 1.0, 1.0, 1.0],
        "source": "shader/common/Lighting.h:44-51 (g_LightingInfo default)",
    },
    "defaultSkyColour": {
        "kind": "code",
        "value": [0.25, 0.25, 0.25, 1.0],
        "source": "shader/common/Lighting.h:44-51 (g_LightingInfo default)",
    },
    "defaultBakedColour": {
        "kind": "code",
        "value": [1.0, 1.0, 1.0, 1.0],
        "source": "shader/common/Lighting.h:44-51 (g_LightingInfo default)",
    },
    "defaultEmissiveColour": {
        "kind": "code",
        "value": [0.0, 0.0, 0.0, 1.0],
        "source": "shader/common/Lighting.h:44-51 (g_LightingInfo default)",
    },
    "defaultIntensities": {
        "kind": "code",
        "value": [1.0, 10.0, 1.0, 1.0],
        "source": "shader/common/Lighting.h:44-51 (diffuse, highlight, reflection, global)",
    },
    "fallbackSunDirection": {
        "kind": "code",
        "value": [0.57735, 0.57735, -0.57735],
        "source": "world_render/source/LightList.cpp:97 (used only when a level has no sun light)",
    },
    "sunDirectionSemantics": {
        "kind": "code",
        "value": "unit vector pointing from the surface toward the sun; matrix row Z (m_Matrix.AZ())",
        "source": "world_render/source/LightList.cpp:90-98; shader/common/Lighting.h:159",
    },
    "normalDecode": {
        "kind": "code",
        "value": "vertexU8 / 255 * 2 - 1, world = mul(normal, (float3x3)g_mWorld), then normalize",
        "source": "shader/common/Transform.h:29-30,94; shader/common/Surface.h:38-45",
    },
    "shBasis": {
        "kind": "code",
        "value": "ambient.rgb = dot(float4(worldNormal, 1), coeffs) per channel; coefficient order (x, y, z, constant)",
        "source": "shader/lighting/SphericalHarmonics.h:4-9",
    },
    "carSHDecode": {
        "kind": "code",
        "value": "ambientOcclusionSH.yzw = vertexColour.yzw * 2 - 1 (x stays 0..1); vLighting.rgb = dot(g_LocalSpaceSHNode[i], ambientOcclusionSH)",
        "source": "vehicle/shaders/vehicle_common.h:1166-1177",
    },
    "exposure": {
        "kind": "code",
        "value": "GetExposure: rgb * g_vLuminance.x then sqrt(); HDRU32 tonemap squares it back; ApplyGamma pow(colour, 1/2.2)",
        "source": "shader/common/Hdr.h:92-121; render/shaders/postprocess/hdr/psToneMap.psh:22-34",
    },
    "toneMap": {
        "kind": "code",
        "value": "colour * (middleGrey / (luminance + 0.001)); per-level middleGrey/exposureMin/exposureMax feed the adaptation",
        "source": "render/shaders/postprocess/hdr/psHDR.h:31-34; render/source/postprocess/PostProcessEnvSettings.cpp:57-79",
    },
    "gamma": {
        "kind": "code",
        "value": 2.2,
        "source": "render/source/postprocess/hdr/HDRInterface.cpp:53 (g_HDRGamma default)",
    },
    "diffuseIntensity": {
        "kind": "code",
        "value": 1.0,
        "source": "shader/envsettings/LightingSettings.cpp:23 (g_vIntensities default 1,1,1,1)",
    },
    "fogDepth": {
        "kind": "code",
        "value": "factor = exp(-distance * density); colour = lerp(fogColour, colour, saturate(factor))",
        "source": "shader/common/Fog.h:68-81",
    },
    "fogHeight": {
        "kind": "code",
        "value": "fMin/fMax of (worldY-height, viewY-height); fogDistance = ratio*distance*saturate(-fMin*falloff); amount = -fogDistance*density",
        "source": "shader/common/Fog.h:54-66",
    },
    "carShadow": {
        "kind": "code",
        "value": "projected/drop shadow: ShadowSize, ShadowHeight, DropShadowIntensity, DropShadowHeight, IndividualShadowMaxIntensity, MultiShadowIntensity, FadeRange, MaxShadows; texture graphics/textures/shadows/impostershadow.texture",
        "source": "gamedata XT ShadowSettings (amax.bin, City.EnvironmentSettings.shadowSettings); texture listed in cache/root.pak",
    },
    "emissive": {
        "kind": "code",
        "value": "colour += material.emissive * EmissiveColour.rgb",
        "source": "shader/common/Lighting.h:233-235",
    },
    "ambientSource": {
        "kind": "code",
        "value": "static world: baked lightmaps (SunSkyLightmap/RGBLightmap) + light sample SH for props/cars; no analytic ambient term exists in the shader",
        "source": "shader/scene/SunSkyLighting.h:16-22; world_render/source/EnvironmentSampler.cpp:90-94",
    },
    "lightmapUV": {
        "kind": "code",
        "value": "lightmap UV is TEXCOORD0.zw; the shader annotation names the set 'luxlightmap'",
        "source": "shader/common/Parameters.h:11; shader/common/Lighting.h:82 (g_tLightmap UVSet)",
    },
    "lightmapFormat": {
        "kind": "code",
        "value": "g_tLightmap is COMPRESSED_RGBA_S3TC_DXT5 on PC",
        "source": "shader/common/Lighting.h:109 (pragma texformat g_tLightmap)",
    },
    "lightmapDecode": {
        "kind": "code",
        "value": "SunSkyLightmap: fSkyOcclusion *= sample.g, fSunOcclusion *= sample.b; RGBLightmapNormalisedGamma: colour *= (sample.rgb * sample.a)^2",
        "source": "shader/lighting/Lightmap.h:16-38",
    },
    "lightmapBinding": {
        "kind": "code",
        "value": "g_tLightmap Source='<Lightmap>' resolves through the material texture slot to a levelstream LOD0 resource-block texture",
        "source": "shader/common/Lighting.h:82; renderingdata RenderList texture-source list (tools/inspect_car_materials.py)",
    },
}


def finite(value) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def sun_angles(direction):
    x, y, z = direction
    elevation = math.degrees(math.asin(max(-1.0, min(1.0, y))))
    azimuth = math.degrees(math.atan2(-z, x)) % 360.0
    return elevation, azimuth


def build_level(level: str) -> dict:
    raw = LD.read_level(level)
    env = LD.load_city_environment(level)
    lightmap = LM.build_lightmap_block(level)
    sun = raw["lights"]["sun"]
    sky = raw["lights"]["sky"]
    probe = raw["ambientProbe"]
    if sun is None:
        elevation = azimuth = None
    else:
        elevation, azimuth = sun_angles(sun["direction"])

    baked = env["fields"]["bakedColour"]
    ambient_scaled = [probe["upNormalAmbient"][i] * baked[i] for i in range(3)]
    sh_linear = []
    sh_cosine = [] if sun is not None else None
    for channel in range(3):
        xyz = probe["sh"][channel * 4:channel * 4 + 3]
        magnitude = math.sqrt(sum(component * component for component in xyz))
        sh_linear.append(magnitude)
        if sun is None:
            continue
        if magnitude > 0.0:
            cosine = sum(xyz[i] * sun["direction"][i] for i in range(3)) / magnitude
        else:
            cosine = 0.0
        sh_cosine.append(cosine)

    if sun is None:
        # No directional sun is serialized (C_LightList hasSun=0). The code-only
        # fallback direction (LightList.cpp:97) is not substituted, so the sun
        # term is absent and the up-facing diffuse is the baked ambient only.
        sun_up = 0.0
        diffuse_up = list(ambient_scaled)
    else:
        sun_up = max(0.0, sun["direction"][1])
        diffuse_up = [ambient_scaled[i] + env["fields"]["sunColour"][i] * sun_up
                      for i in range(3)]
    # Net retail pipeline: value * exposure -> gamma 1/2.2 (Hdr.h:92-121 squares
    # after the shader already wrote sqrt(value*exposure); psToneMap.psh:22-34).
    patch_albedo = 0.5
    patch = [max(0.0, min(1.0, (diffuse_up[i] * patch_albedo * 1.0) ** (1.0 / 2.2))) for i in range(3)]

    if sun is None:
        sun_block = None
        sun_unsupported = {
            "code": "not-serialized",
            "field": "sun",
            "reason": "C_LightList hasSun=0: the level serializes no directional sun light; "
                      "the code-only fallback direction (LightList.cpp:97) is not substituted",
            "blockOffset": raw["lights"]["blockOffset"],
            "blockBytes": raw["lights"]["blockBytes"],
            "hasSun": raw["lights"]["hasSun"],
            "hasSky": raw["lights"]["hasSky"],
            "source": "Level.levelrender Lights block, C_LightList::Read "
                      "(LightList.cpp:38-72); hasSun flag at payload start",
        }
    else:
        sun_block = {
            "provenance": {
                "kind": "data",
                "source": "Level.levelrender Lights block, C_LightList::Read (LightList.cpp:38-72)",
                "blockOffset": raw["lights"]["blockOffset"],
                "offset": sun["offset"],
                "offsetInPayload": sun["offsetInPayload"],
            },
            "type": sun["type"],
            "typeName": sun["typeName"],
            "direction": sun["direction"],
            "matrixRows": sun["matrixRows"],
            "colour": sun["colour"],
            "radius": sun["radius"],
            "elevationDeg": elevation,
            "azimuthDeg": azimuth,
            "intensityUsed": sun["colour"][3],
        }
        sun_unsupported = None

    return {
        "schema": "blur-lighting/1",
        "kind": "level-lighting",
        "level": level,
        "short": raw["short"],
        "city": raw["city"],
        "units": {
            "colour": "linear RGB, 0..1 unless stated (no sRGB decode is applied to lighting colours)",
            "colourSrgb": "none; the environment-settings colours are multiplied directly in the linear shader term",
            "direction": "unit vector, +Y up, right-handed",
            "distance": "metres",
            "angle": "degrees in this manifest (serialized values are radians)",
            "intensity": "dimensionless multiplier",
            "sh": "linear radiance coefficients, coefficient order (x, y, z, constant)",
            "lightmap": "DXT5/BC3 texels 0..255 at mip 0; the shader decodes .g/.b (SunSkyLightmap) or (.rgb*.a)^2 (RGBLightmapNormalisedGamma) per material effect",
        },
        "source": {
            "render": {
                "path": raw["renderPath"],
                "bytes": raw["renderBytes"],
                "sha256": raw["renderSha256"],
                "fnv1a64": raw["renderFnv1a64"],
            },
            "stream": {"path": raw["streamPath"], "bytes": raw["streamBytes"]},
            "environment": {
                "pak": env["pak"],
                "entry": env["entry"],
                "entryLogicalBytes": env["entryLogicalBytes"],
                "amaxSha256": env["packSha256"],
                "flaskVersion": env["flaskVersion"],
                "recordIndex": env["recordIndex"],
            },
        },
        "blocks": raw["blocks"],
        "sun": sun_block,
        **({"sunUnsupported": sun_unsupported} if sun_unsupported is not None else {}),
        "skyLightObject": {
            "provenance": {
                "kind": "data",
                "source": "Level.levelrender Lights block, sky-hemisphere object; note it is only read by the debug renderer and the scene converter, not by the runtime shader",
                "offset": sky["offset"],
                "offsetInPayload": sky["offsetInPayload"],
            },
            "type": sky["type"],
            "typeName": sky["typeName"],
            "upAxis": sky["direction"],
            "colour": sky["colour"],
            "radius": sky["radius"],
        },
        "lightObjects": {
            "provenance": {
                "kind": "data",
                "source": "Level.levelrender Lights block kd-tree primitives (C_Light, 72 B each)",
                "kdTreeTableOffset": raw["lights"]["kdTree"]["nodeTableOffset"],
                "blockOffset": raw["lights"]["blockOffset"],
            },
            "counts": raw["lights"]["lightTypeCounts"],
            "total": len(raw["lights"]["lights"]),
            "kdTree": {
                "nodes": raw["lights"]["kdTree"]["nodes"],
                "mailboxes": raw["lights"]["kdTree"]["mailboxes"],
            },
            "radiusRange": [
                min((l["radius"] for l in raw["lights"]["lights"]), default=0.0),
                max((l["radius"] for l in raw["lights"]["lights"]), default=0.0),
            ],
            "first": raw["lights"]["lights"][:4],
        },
        "lightSamples": {
            "provenance": {
                "kind": "data",
                "source": "Level.levelrender LS block (LightSamplePoints.cpp:139-258)",
                "blockOffset": raw["lightSamples"]["blockOffset"],
                "pointsOffset": raw["lightSamples"]["pointsOffset"],
                "samplesOffset": raw["lightSamples"]["samplesOffset"],
                "recordBytes": 24,
            },
            "model": raw["lightSamples"]["model"],
            "modelName": raw["lightSamples"]["modelName"],
            "pointCount": raw["lightSamples"]["pointCount"],
            "sampleCount": raw["lightSamples"]["sampleCount"],
            "pointRecordBytes": 10,
            "sampleRecordBytes": len(raw["lightSamples"]["samples"][0]["halfBits"]) * 2,
            "children": raw["lightSamples"]["children"],
        },
        "ambientProbe": {
            "provenance": {
                "kind": "data+provisional",
                "source": "closest LS point to the measured spawn (LightSamplePointScene.cpp:105-119, radius 10 m) and its RGBSH sample",
                "position": "spawn table, see spawnSource",
            },
            "spawn": probe["spawn"],
            "spawnSource": probe["spawnSource"],
            "pointIndex": probe["pointIndex"],
            "pointPosition": probe["pointPosition"],
            "distance": probe["distance"],
            "sampleIndex": probe["sampleIndex"],
            "sampleOffset": probe["sampleOffset"],
            "halfBits": probe["halfBits"],
            "sh": probe["sh"],
            "upNormalAmbient": probe["upNormalAmbient"],
            "upNormalAmbientScaled": ambient_scaled,
            "searchRadius": probe["searchRadius"],
            "searchRadiusSource": probe["searchRadiusSource"],
        },
        "lightingInfo": {
            "provenance": {
                "kind": "data",
                "source": "gamedata.pak amax.bin City.EnvironmentSettings.lightingSettings.lightingSettings (LightingInfo)",
                "recordIndex": env["recordIndex"],
                "offsets": {"SunColour": env["fieldOffsets"]["sunColour"],
                            "SkyColour": env["fieldOffsets"]["skyColour"],
                            "BakedColour": env["fieldOffsets"]["bakedColour"],
                            "EmissiveColour": env["fieldOffsets"]["emissiveColour"]},
            },
            "sunColour": env["fields"]["sunColour"],
            "skyColour": env["fields"]["skyColour"],
            "bakedColour": env["fields"]["bakedColour"],
            "emissiveColour": env["fields"]["emissiveColour"],
            "alphaMeaning": "stored alpha is not used by the shader; only .rgb multiplies the term",
        },
        "fog": {
            "provenance": {
                "kind": "data",
                "source": "amax.bin City.EnvironmentSettings.lightingSettings.fogSettings",
                "recordIndex": env["recordIndex"],
                "offset": env["fieldOffsets"]["fogSettings"],
            },
            "colour": env["fog"]["colour"],
            "depthDensity": env["fog"]["depth"]["density"],
            "depthNearDistance": env["fog"]["depth"]["nearDistance"],
            "depthScale": env["fog"]["depth"]["scale"],
            "height": env["fog"]["height"],
        },
        "skyDome": {
            "provenance": {
                "kind": "data",
                "source": "amax.bin City.EnvironmentSettings.lightingSettings.skySettings",
                "offset": env["fieldOffsets"]["skySettings"],
            },
            **env["skyDome"],
        },
        "postProcess": {
            "provenance": {
                "kind": "data",
                "source": "amax.bin City.EnvironmentSettings.lightingSettings.hdrSettings (XT type PostProcess)",
                "offset": env["fieldOffsets"]["hdrSettings"],
            },
            **env["postProcess"],
            "gamma": CODE_REFERENCES["gamma"]["value"],
        },
        "shadow": {
            "provenance": {
                "kind": "data",
                "source": "amax.bin City.EnvironmentSettings.shadowSettings (XT type ShadowSettings)",
                "recordIndex": env["recordIndex"],
            },
            **env["shadow"],
            "technique": "projected drop shadow (blob), not a shadow map",
            "texture": "graphics/textures/shadows/impostershadow.texture",
        },
        "carLight": {
            "provenance": {
                "kind": "data",
                "source": "amax.bin City.EnvironmentSettings.carLightSettings (XT type CarLightSettings)",
            },
            **env["carLight"],
        },
        "lightFlares": {
            "provenance": {
                "kind": "data",
                "source": "amax.bin City.EnvironmentSettings.lightFlareSettings (XT type LightFlareSettings)",
            },
            **env["lightFlares"],
        },
        "normals": {
            "verdict": "serialized",
            "provenance": {
                "kind": "data",
                "source": "Level.levelrender Scene vertex declarations + Level.levelstream vertex bytes",
                "declarations": "Scene vertex declarations (usage 3 NORMAL0, type 11 U8_4N, offset 12)",
            },
            "declarationCount": len(raw["declarations"]),
            "declarationsWithNormal": raw["normals"]["declarationsWithNormal"],
            "declarations": raw["normals"]["declarations"],
            "sampledVertices": raw["normals"]["sampledVertices"],
            "worstLengthError": raw["normals"]["worstLengthError"],
            "decodeRule": raw["normals"]["decodeRule"],
            "sampledBuffers": raw["normals"]["sampledBuffers"],
            "noNormalCase": "declarations without NORMAL0 (F32_4 position streams) must keep the derivative fallback and say so",
        },
        "lightmap": lightmap,
        "code": CODE_REFERENCES,
        "derived": {
            "kind": "provisional",
            "sunToAmbientRatio": (
                None if sun is None or not any(ambient_scaled) else
                [env["fields"]["sunColour"][i] / ambient_scaled[i] if ambient_scaled[i] else None
                 for i in range(3)]),
            "expectedDiffuseUpFacingAlbedo1": diffuse_up,
            "shLinearMagnitude": sh_linear,
            "shSunCosine": sh_cosine,
            "sanityPatch": {
                "description": "flat patch, albedo 0.5, up normal, exposure 1.0, no fog, no shadow",
                "albedo": patch_albedo,
                "exposure": 1.0,
                "linearRgb": [diffuse_up[i] * patch_albedo for i in range(3)],
                "encodedRgb": patch,
                "encodedRgb8": [int(round(v * 255)) for v in patch],
                "tolerance8": 2,
                "toleranceReason": "8-bit rounding plus the F16 light-sample quantisation (worst normal length error is recorded under normals)",
                "formula": "pow(clamp(linear * exposure), 1/2.2) with linear = (bakedAmbient + SunColour*max(0,up.sunDir)) * albedo * diffuseIntensity",
            },
            "notes": [
                "expectedDiffuseUpFacingAlbedo1 = ambient (SH * BakedColour) + SunColour * max(0, dot(up, sunDir)); a flat known-colour patch must land within the verifier tolerance",
                "sunToAmbientRatio is provisional and only meaningful when the level authors a non-zero SunColour",
                "shSunCosine compares the SH linear term with the serialized sun direction; a high value proves the light-sample probe bakes the same sun (River: >0.85 on red/green)",
                "levels that author SunColour=0 bake all direct sun into lightmaps/light samples, so a single directional light alone cannot match them",
            ] + ([
                "this level serializes no directional sun light (C_LightList hasSun=0); shSunCosine is null and the up-facing expected diffuse is the baked ambient only, not a substituted fallback sun",
            ] if sun is None else []),
        },
        "limits": [
            "One ambient probe at the measured spawn; the real engine interpolates the nearest light sample per model instance (0.2 lerp per frame).",
            "The lightmap block decodes every g_tLightmap texture to mip-0 RGBA and records its identity, dimensions, format and hashes. It does not apply the sampler, mip chain, sRGB/colour transform or the per-material lightmap shader term; the renderer must do that from the recorded uvSet and shaderTerms.",
            "The lightmap set is the full level, not just the measured map-slice; a renderer that draws a subset still needs the per-material g_tLightmap name from the material binding.",
            "The per-vertex vehicle ambient (COLOR stream, U8_4N) is recorded as a stream, not evaluated; its exact bake basis is not recovered.",
            "No shadow-map, cascade, bias or PCF parameter exists in the data: retail cars use a projected drop shadow.",
            "Emissive and light-blend material states are per-material; only the per-level EmissiveColour scale is recovered here.",
        ],
    }


def canonical(document) -> bytes:
    return (json.dumps(document, indent=1, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=OUT_DIR)
    args = parser.parse_args()
    out: Path = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)

    index = {"schema": "blur-lighting-index/1", "levels": {}, "code": CODE_REFERENCES}
    for level in LD.SPAWN_TABLE:
        document = build_level(level)
        payload = canonical(document)
        path = out / (document["short"] + ".json")
        path.write_bytes(payload)
        index["levels"][document["short"]] = {
            "level": level,
            "path": str(path.relative_to(ROOT)).replace("\\", "/"),
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        print("%-22s %8d B  %s" % (document["short"], len(payload),
                                   index["levels"][document["short"]]["sha256"]))

    index_path = out / "index.json"
    index_path.write_bytes(canonical(index))
    print("%-22s %8d B  %s" % ("index", index_path.stat().st_size,
                               hashlib.sha256(index_path.read_bytes()).hexdigest()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
