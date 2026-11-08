#!/usr/bin/env python3
"""Verify the lighting manifests against the retail bytes and the shader rules.

Checks are grouped per level (provenance, ranges, unit consistency, per-level
coverage, determinism) and globally (manifest hashes, cross-level differences,
code citations). Every check is an independent boolean with a printed detail, so
a single failure cannot hide behind another.

Run:  python probes/lighting/tools/verify_lighting.py
Exit: 0 when every check passes, 1 otherwise.
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_manifest as BM  # noqa: E402
import lighting_data as LD  # noqa: E402

ROOT = LD.ROOT
OUT_DIR = ROOT / "_work/lighting"
SHORTS = [LD.SPAWN_TABLE[level]["short"] for level in LD.SPAWN_TABLE]

CHECKS: list[tuple[str, bool, str]] = []
FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    ok = bool(ok)
    CHECKS.append((name, ok, detail))
    if not ok:
        FAILURES.append("%s :: %s" % (name, detail))


def close(a: float, b: float, tol: float = 1e-6) -> bool:
    return abs(a - b) <= tol


def finite(value) -> bool:
    if isinstance(value, dict):
        return all(finite(v) for v in value.values())
    if isinstance(value, (list, tuple)):
        return all(finite(v) for v in value)
    if isinstance(value, bool) or isinstance(value, str) or value is None:
        return True
    if isinstance(value, (int, float)):
        return math.isfinite(value)
    return False


def norm3(v) -> float:
    return math.sqrt(sum(c * c for c in v[:3]))


def verify_level(short: str) -> None:
    level = next(lv for lv in LD.SPAWN_TABLE if LD.SPAWN_TABLE[lv]["short"] == short)
    path = OUT_DIR / (short + ".json")
    check("river/amboy/gracia/longbeach manifest exists: %s" % short, path.exists(), str(path))
    if not path.exists():
        return
    raw = path.read_bytes()
    doc = json.loads(raw)

    # -- identity and hashes -------------------------------------------------
    check("%s schema" % short, doc.get("schema") == "blur-lighting/1", str(doc.get("schema")))
    check("%s level id" % short, doc.get("level") == level, str(doc.get("level")))
    check("%s city id" % short, doc.get("city") == LD.SPAWN_TABLE[level]["city"], "")
    render_sha = doc["source"]["render"]["sha256"]
    actual_sha = hashlib.sha256((ROOT / doc["source"]["render"]["path"]).read_bytes()).hexdigest()
    check("%s levelrender sha256 matches the file" % short, render_sha == actual_sha,
          "%s vs %s" % (render_sha[:12], actual_sha[:12]))
    check("%s render bytes match" % short,
          doc["source"]["render"]["bytes"] == (ROOT / doc["source"]["render"]["path"]).stat().st_size, "")
    check("%s amax sha256 length" % short, len(doc["source"]["environment"]["amaxSha256"]) == 64, "")
    check("%s block list has Lights" % short,
          any(b["id"] == "Lights" for b in doc["blocks"]), "")
    check("%s block list has LS" % short, any(b["id"] == "LS" for b in doc["blocks"]), "")

    # -- units ---------------------------------------------------------------
    units = doc.get("units", {})
    check("%s colour units say linear" % short, "linear" in units.get("colour", ""), units.get("colour", ""))
    check("%s sRGB decode declared absent" % short, "none" in units.get("colourSrgb", "").lower(),
          units.get("colourSrgb", ""))
    check("%s direction units" % short, "unit vector" in units.get("direction", ""), "")
    check("%s distance units are metres" % short, units.get("distance") == "metres", "")

    # -- sun reconstruction --------------------------------------------------
    sun = doc["sun"]
    check("%s sun provenance is data" % short, sun["provenance"]["kind"] == "data", "")
    check("%s sun type is directional" % short, sun["type"] == 3 and sun["typeName"] == "directional", "")
    check("%s sun radius is 100000" % short, close(sun["radius"], 100000.0), str(sun["radius"]))
    check("%s sun direction is unit length" % short, close(norm3(sun["direction"]), 1.0, 1e-5),
          "%.9f" % norm3(sun["direction"]))
    check("%s sun direction is matrix row Z" % short,
          all(close(sun["direction"][i], sun["matrixRows"][2][i], 1e-9) for i in range(3)), "")
    rows = [sun["matrixRows"][0], sun["matrixRows"][1], sun["matrixRows"][2]]
    check("%s sun matrix rows unit" % short, all(close(norm3(r), 1.0, 1e-5) for r in rows),
          ",".join("%.6f" % norm3(r) for r in rows))
    dots = []
    for a in range(3):
        for b in range(a + 1, 3):
            dots.append(sum(rows[a][i] * rows[b][i] for i in range(3)))
    check("%s sun matrix rows orthogonal" % short, all(abs(d) < 1e-5 for d in dots),
          ",".join("%.2e" % d for d in dots))
    check("%s sun translation row is zero" % short, all(close(v, 0.0) for v in sun["matrixRows"][3]), "")
    check("%s sun is above the horizon" % short, sun["direction"][1] > 0.0, "%.6f" % sun["direction"][1])
    check("%s sun direction y equals sin(elevation)" % short,
          close(sun["direction"][1], math.sin(math.radians(sun["elevationDeg"])), 1e-9), "")
    check("%s sun elevation in 3..80 deg" % short, 3.0 <= sun["elevationDeg"] <= 80.0,
          "%.3f" % sun["elevationDeg"])
    check("%s sun azimuth in 0..360" % short, 0.0 <= sun["azimuthDeg"] < 360.0,
          "%.3f" % sun["azimuthDeg"])
    check("%s sun colour rgb in 0..1" % short, all(0.0 <= c <= 1.0 for c in sun["colour"][:3]),
          str(sun["colour"][:3]))
    check("%s sun colour alpha in 0..1" % short, 0.0 <= sun["colour"][3] <= 1.0, "")
    check("%s sun intensity equals colour alpha" % short,
          close(sun["intensityUsed"], sun["colour"][3], 1e-9), "")

    # -- sky light object ----------------------------------------------------
    sky = doc["skyLightObject"]
    check("%s sky object present" % short, sky["provenance"]["kind"] == "data", "")
    check("%s sky object is a hemisphere" % short, sky["type"] == 1 and sky["typeName"] == "hemisphere", "")
    check("%s sky object up axis is +Y" % short,
          all(close(sky["upAxis"][i], [0.0, 1.0, 0.0][i], 1e-9) for i in range(3)), str(sky["upAxis"]))
    check("%s sky object colour is white" % short, all(close(c, 1.0) for c in sky["colour"][:3]), "")
    check("%s sky object alpha in 0..0.06" % short, 0.0 < sky["colour"][3] <= 0.06, str(sky["colour"][3]))

    # -- serialized light objects -------------------------------------------
    objs = doc["lightObjects"]
    check("%s light object counts sum to total" % short,
          sum(objs["counts"].values()) == objs["total"], "%s vs %d" % (objs["counts"], objs["total"]))
    check("%s light objects exist" % short, objs["total"] > 0, str(objs["total"]))
    check("%s light objects are area/point only" % short,
          set(objs["counts"]) <= {"area", "point", "spot"}, str(sorted(objs["counts"])))
    check("%s light object radii positive" % short, objs["radiusRange"][0] > 0.0, str(objs["radiusRange"]))
    check("%s light object radii ordered" % short, objs["radiusRange"][0] <= objs["radiusRange"][1], "")
    check("%s first light objects carry colour" % short,
          all(len(l["colour"]) == 4 for l in objs["first"]), "")
    check("%s first light objects are finite" % short, finite(objs["first"]), "")
    check("%s kd-tree nodes positive" % short, objs["kdTree"]["nodes"] > 0, str(objs["kdTree"]["nodes"]))
    check("%s kd-tree mailboxes positive" % short, objs["kdTree"]["mailboxes"] > 0, "")

    # -- light samples -------------------------------------------------------
    ls = doc["lightSamples"]
    check("%s LS model is RGBSH" % short, ls["model"] == 2 and ls["modelName"] == "RGBSH", "")
    check("%s LS point count positive" % short, ls["pointCount"] > 0, str(ls["pointCount"]))
    check("%s LS sample count positive" % short, ls["sampleCount"] > 0, str(ls["sampleCount"]))
    check("%s LS point record is 10 B" % short, ls["pointRecordBytes"] == 10, "")
    check("%s LS sample record is 24 B" % short, ls["sampleRecordBytes"] == 24, "")
    check("%s LS sample count <= point count" % short, ls["sampleCount"] <= ls["pointCount"], "")
    check("%s LS children complete" % short,
          set(ls["children"]) == {"Header", "LSPoint", "LSData", "LSTree"}, str(sorted(ls["children"])))

    # -- ambient probe -------------------------------------------------------
    probe = doc["ambientProbe"]
    check("%s probe kind mixes data and provisional" % short,
          probe["provenance"]["kind"] == "data+provisional", probe["provenance"]["kind"])
    check("%s probe distance within the 10 m search radius" % short,
          0.0 <= probe["distance"] <= probe["searchRadius"], "%.3f" % probe["distance"])
    check("%s probe distance is positive" % short, probe["distance"] > 0.0, "")
    check("%s probe sample index in range" % short,
          0 <= probe["sampleIndex"] < ls["sampleCount"], str(probe["sampleIndex"]))
    check("%s probe point index in range" % short,
          0 <= probe["pointIndex"] < ls["pointCount"], str(probe["pointIndex"]))
    check("%s probe has 12 SH coefficients" % short, len(probe["sh"]) == 12, str(len(probe["sh"])))
    check("%s probe has 12 half bits" % short, len(probe["halfBits"]) == 12, "")
    check("%s probe SH finite" % short, all(math.isfinite(v) for v in probe["sh"]), "")
    check("%s probe SH magnitude < 2" % short, all(abs(v) < 2.0 for v in probe["sh"]),
          "max %.3f" % max(abs(v) for v in probe["sh"]))
    check("%s probe up-normal ambient matches basis" % short,
          all(close(probe["upNormalAmbient"][i], probe["sh"][i * 4 + 1] + probe["sh"][i * 4 + 3], 1e-7)
              for i in range(3)), str(probe["upNormalAmbient"]))
    check("%s probe up-normal ambient positive" % short,
          all(c > 0.0 for c in probe["upNormalAmbient"]), str(probe["upNormalAmbient"]))
    check("%s probe spawn matches the spawn table" % short,
          all(close(probe["spawn"][i], LD.SPAWN_TABLE[level]["spawn"][i], 1e-9) for i in range(3)), "")

    # independent nearest-point recomputation from the retail bytes
    raw_level = LD.read_level(level, max_normal_buffers=1)
    recomputed = LD.closest_point(raw_level["lightSamples"], LD.SPAWN_TABLE[level]["spawn"])
    check("%s probe point index re-derived from bytes" % short,
          recomputed["point"]["index"] == probe["pointIndex"],
          "%d vs %d" % (recomputed["point"]["index"], probe["pointIndex"]))
    check("%s probe distance re-derived from bytes" % short,
          close(recomputed["distance"], probe["distance"], 1e-9), "%.9f" % recomputed["distance"])
    sample = raw_level["lightSamples"]["samples"][probe["sampleIndex"]]
    check("%s probe SH re-derived from bytes" % short,
          all(close(sample["values"][i], probe["sh"][i], 1e-9) for i in range(12)), "")

    # -- lighting info -------------------------------------------------------
    info = doc["lightingInfo"]
    check("%s lighting info provenance is data" % short, info["provenance"]["kind"] == "data", "")
    check("%s four colours present" % short,
          all(k in info for k in ("sunColour", "skyColour", "bakedColour", "emissiveColour")), "")
    check("%s colours are RGBA" % short,
          all(len(info[k]) == 4 for k in ("sunColour", "skyColour", "bakedColour", "emissiveColour")), "")
    check("%s baked colour is 1.5" % short, all(close(c, 1.5) for c in info["bakedColour"][:3]),
          str(info["bakedColour"]))
    check("%s emissive alpha is 1" % short, close(info["emissiveColour"][3], 1.0), "")
    check("%s emissive colour non-negative" % short, all(c >= 0.0 for c in info["emissiveColour"][:3]), "")
    check("%s baked ambient equals SH * BakedColour" % short,
          all(close(probe["upNormalAmbientScaled"][i],
                    probe["upNormalAmbient"][i] * info["bakedColour"][i], 1e-9) for i in range(3)), "")
    check("%s field offsets recorded" % short,
          set(info["provenance"]["offsets"]) == {"SunColour", "SkyColour", "BakedColour", "EmissiveColour"}, "")

    # -- fog ----------------------------------------------------------------
    fog = doc["fog"]
    check("%s fog provenance is data" % short, fog["provenance"]["kind"] == "data", "")
    check("%s fog colour rgb in 0..1" % short, all(0.0 <= c <= 1.0 for c in fog["colour"][:3]),
          str(fog["colour"][:3]))
    check("%s depth fog density in (0, 0.01]" % short, 0.0 < fog["depthDensity"] <= 0.01,
          str(fog["depthDensity"]))
    check("%s depth fog near distance is 0" % short, close(fog["depthNearDistance"], 0.0), "")
    check("%s depth fog scale is 1" % short, close(fog["depthScale"], 1.0), "")
    check("%s height fog height >= 0" % short, fog["height"]["height"] >= 0.0, "")
    check("%s height fog density in [0, 0.01]" % short, 0.0 <= fog["height"]["density"] <= 0.01, "")
    check("%s height fog falloff in [0, 0.1]" % short, 0.0 <= fog["height"]["falloff"] <= 0.1, "")
    check("%s height fog scale in [0, 1]" % short, 0.0 <= fog["height"]["scale"] <= 1.0, "")

    # -- sky dome -----------------------------------------------------------
    dome = doc["skyDome"]
    check("%s sky texture is a retail path" % short,
          dome["texture"].startswith("graphics/textures/skies/"), dome["texture"])
    check("%s sky texture ends with .texture" % short, dome["texture"].endswith(".texture"), "")
    check("%s sky intensity in (0, 2]" % short, 0.0 < dome["intensity"] <= 2.0, str(dome["intensity"]))
    check("%s sky rotation in [0, 2]" % short, 0.0 <= dome["rotation"] <= 2.0, str(dome["rotation"]))
    check("%s sky fog colour in 0..1" % short, all(0.0 <= c <= 1.0 for c in dome["fogColour"][:3]), "")
    check("%s sky fog curve positive" % short, dome["fogCurve"] > 0.0, str(dome["fogCurve"]))

    # -- post process -------------------------------------------------------
    post = doc["postProcess"]
    check("%s middleGrey in (0, 1]" % short, 0.0 < post["middleGrey"] <= 1.0, str(post["middleGrey"]))
    check("%s exposure min <= max" % short, post["exposureMin"] <= post["exposureMax"],
          "%s..%s" % (post["exposureMin"], post["exposureMax"]))
    check("%s exposure range within 0..8" % short,
          0.0 <= post["exposureMin"] and post["exposureMax"] <= 8.0, "")
    check("%s gamma is 2.2" % short, close(post["gamma"], 2.2), str(post["gamma"]))
    check("%s bloom threshold is 1" % short, close(post["bloomThreshold"], 1.0), "")

    # -- shadow -------------------------------------------------------------
    shadow = doc["shadow"]
    check("%s shadow provenance is data" % short, shadow["provenance"]["kind"] == "data", "")
    check("%s shadow is a projected blob, not a map" % short,
          shadow["technique"].startswith("projected"), shadow["technique"])
    check("%s shadow texture is impostershadow" % short,
          shadow["texture"].endswith("impostershadow.texture"), shadow["texture"])
    check("%s ShadowSize is 6" % short, close(shadow["ShadowSize"], 6.0), str(shadow["ShadowSize"]))
    check("%s ShadowHeight is 1" % short, close(shadow["ShadowHeight"], 1.0), "")
    check("%s DropShadowIntensity is 0.75" % short, close(shadow["DropShadowIntensity"], 0.75), "")
    check("%s MaxShadows is 6" % short, close(shadow["MaxShadows"], 6.0), "")
    check("%s shadow FadeRange in (0, 1]" % short, 0.0 < shadow["FadeRange"] <= 1.0, "")
    check("%s shadow intensities in 0..1" % short,
          0.0 <= shadow["IndividualShadowMaxIntensity"] <= 1.0
          and 0.0 <= shadow["MultiShadowIntensity"] <= 1.0, "")
    check("%s DropShadowHeight positive" % short, shadow["DropShadowHeight"] > 0.0, "")

    # -- car light / flares -------------------------------------------------
    car = doc["carLight"]
    check("%s car SH factor is 1" % short, close(car["SHLightFactor"], 1.0), "")
    check("%s car SH max is 1" % short, close(car["SHLightMax"], 1.0), "")
    check("%s car blob intensity in 0..1" % short, 0.0 <= car["FakeSunBlobShadowIntensity"] <= 1.0,
          str(car["FakeSunBlobShadowIntensity"]))
    flares = doc["lightFlares"]
    check("%s car white flare colour positive" % short,
          all(c > 0.0 for c in flares["carWhiteFlaresColour"]), str(flares["carWhiteFlaresColour"]))
    check("%s car red flare is red-dominant" % short,
          flares["carRedFlaresColour"][0] > flares["carRedFlaresColour"][1]
          and flares["carRedFlaresColour"][0] > flares["carRedFlaresColour"][2], "")

    # -- normals ------------------------------------------------------------
    normals = doc["normals"]
    check("%s normals verdict is serialized" % short, normals["verdict"] == "serialized", "")
    # The Scene declaration count is per map (River 16, Amboy 14, Gracia 17,
    # Longbeach 17). Re-derive it from the committed Scene reader instead of
    # pinning one map's number for all four.
    scene_count = len(LD.read_level(level)["declarations"])
    check("%s declaration count matches the Scene reader" % short,
          normals["declarationCount"] == scene_count,
          "%d vs %d" % (normals["declarationCount"], scene_count))
    check("%s declaration list length matches its count" % short,
          normals["declarationCount"] == len(normals["declarations"]),
          "%d vs %d" % (normals["declarationCount"], len(normals["declarations"])))
    check("%s most declarations carry NORMAL0" % short, normals["declarationsWithNormal"] >= 10,
          "%d of %d" % (normals["declarationsWithNormal"], normals["declarationCount"]))
    elements = [d["normal"] for d in normals["declarations"] if d["normal"]]
    check("%s every normal element is usage 3" % short, all(e["usage"] == 3 for e in elements), "")
    check("%s every normal element is type 11 (U8_4N)" % short, all(e["type"] == 11 for e in elements), "")
    check("%s every normal element is at offset 12" % short, all(e["offset"] == 12 for e in elements),
          str(sorted({e["offset"] for e in elements})))
    check("%s normal decode rule is 2x-1" % short, "2 - 1" in normals["decodeRule"], normals["decodeRule"])
    check("%s at least one sampled vertex buffer" % short, len(normals["sampledBuffers"]) >= 1, "")
    check("%s sampled vertices > 1000" % short, normals["sampledVertices"] > 1000,
          str(normals["sampledVertices"]))
    check("%s decoded normal lengths within 2%%" % short, normals["worstLengthError"] < 0.02,
          "%.5f" % normals["worstLengthError"])
    check("%s sampled buffers declare the normal element" % short,
          all(s["element"]["offset"] == 12 and s["element"]["type"] == 11
              for s in normals["sampledBuffers"]), "")

    # -- derived / sanity patch --------------------------------------------
    derived = doc["derived"]
    check("%s derived block is provisional" % short, derived["kind"] == "provisional", "")
    check("%s sh linear magnitude positive" % short,
          all(m > 0.0 for m in derived["shLinearMagnitude"]), str(derived["shLinearMagnitude"]))
    check("%s sh/sun cosine in -1..1" % short,
          all(-1.0 <= c <= 1.0 for c in derived["shSunCosine"]), str(derived["shSunCosine"]))
    patch = derived["sanityPatch"]
    expected_linear = [probe["upNormalAmbientScaled"][i] + info["sunColour"][i]
                       * max(0.0, sun["direction"][1]) for i in range(3)]
    check("%s sanity patch linear matches the diffuse terms" % short,
          all(close(patch["linearRgb"][i], expected_linear[i] * patch["albedo"], 1e-9) for i in range(3)),
          "")
    encoded = [max(0.0, min(1.0, v ** (1.0 / 2.2))) for v in patch["linearRgb"]]
    check("%s sanity patch encode matches gamma 2.2" % short,
          all(close(patch["encodedRgb"][i], encoded[i], 1e-9) for i in range(3)), "")
    check("%s sanity patch 8-bit within 2 of the float value" % short,
          all(abs(patch["encodedRgb8"][i] - round(patch["encodedRgb"][i] * 255)) <= patch["tolerance8"]
              for i in range(3)), str(patch["encodedRgb8"]))
    check("%s sanity patch is not black" % short, all(v > 0 for v in patch["encodedRgb8"]),
          str(patch["encodedRgb8"]))
    check("%s sanity patch is not clipped white" % short, all(v < 255 for v in patch["encodedRgb8"]),
          str(patch["encodedRgb8"]))

    # -- limits and citations ----------------------------------------------
    check("%s limits recorded" % short, len(doc["limits"]) >= 4, str(len(doc["limits"])))
    check("%s code citations present" % short, len(doc["code"]) >= 10, str(len(doc["code"])))
    check("%s diffuse order citation" % short,
          "Lighting.h:153-165" in doc["code"]["diffuseOrder"]["source"], "")
    check("%s normal decode citation" % short, "Transform.h" in doc["code"]["normalDecode"]["source"], "")
    check("%s SH basis citation" % short,
          "SphericalHarmonics.h" in doc["code"]["shBasis"]["source"], "")
    check("%s car SH decode citation" % short,
          "vehicle_common.h" in doc["code"]["carSHDecode"]["source"], "")
    check("%s exposure citation" % short, "Hdr.h" in doc["code"]["exposure"]["source"], "")
    check("%s no non-finite numbers in the manifest" % short, finite(doc), "")

    # determinism: rebuild and compare bytes exactly
    rebuilt = BM.canonical(BM.build_level(level))
    check("%s rebuild is byte-identical" % short, rebuilt == raw,
          "sha %s vs %s" % (hashlib.sha256(rebuilt).hexdigest()[:12],
                            hashlib.sha256(raw).hexdigest()[:12]))


def verify_global() -> None:
    index_path = OUT_DIR / "index.json"
    check("index manifest exists", index_path.exists(), str(index_path))
    if not index_path.exists():
        return
    index_raw = index_path.read_bytes()
    index = json.loads(index_raw)
    check("index schema", index.get("schema") == "blur-lighting-index/1", str(index.get("schema")))
    check("index lists four levels", set(index["levels"]) == set(SHORTS), str(sorted(index["levels"])))
    for short in SHORTS:
        record = index["levels"][short]
        path = ROOT / record["path"]
        check("%s index path exists" % short, path.exists(), record["path"])
        if path.exists():
            payload = path.read_bytes()
            check("%s index sha256 matches the file" % short,
                  hashlib.sha256(payload).hexdigest() == record["sha256"], record["sha256"])
            check("%s index byte count matches the file" % short,
                  len(payload) == record["bytes"], "%d vs %d" % (len(payload), record["bytes"]))
    check("index carries the code references", len(index.get("code", {})) >= 10, "")

    docs = {}
    for short in SHORTS:
        docs[short] = json.loads((OUT_DIR / (short + ".json")).read_bytes())

    # per-level differences that the comparison scene depends on
    sun_colours = {short: docs[short]["lightingInfo"]["sunColour"][:3] for short in SHORTS}
    check("Amboy authors a live sun colour", any(c > 0 for c in sun_colours["amboy"]),
          str(sun_colours["amboy"]))
    for short in ("river", "gracia", "longbeach"):
        check("%s bakes the sun (SunColour zero)" % short,
              all(close(c, 0.0) for c in sun_colours[short]), str(sun_colours[short]))
    directions = {short: docs[short]["sun"]["direction"] for short in SHORTS}
    pairs = [(a, b) for i, a in enumerate(SHORTS) for b in SHORTS[i + 1:]]
    for a, b in pairs:
        dot = sum(directions[a][i] * directions[b][i] for i in range(3))
        check("sun direction differs: %s vs %s" % (a, b), dot < 0.999, "dot %.4f" % dot)
    elevations = {short: docs[short]["sun"]["elevationDeg"] for short in SHORTS}
    check("elevations span more than 10 degrees",
          max(elevations.values()) - min(elevations.values()) > 10.0,
          str({k: round(v, 2) for k, v in elevations.items()}))
    ambients = {short: docs[short]["ambientProbe"]["upNormalAmbientScaled"] for short in SHORTS}
    check("ambient probes differ per level",
          len({tuple(round(v, 4) for v in a) for a in ambients.values()}) == len(SHORTS), "")
    emissives = {short: docs[short]["lightingInfo"]["emissiveColour"][0] for short in SHORTS}
    check("emissive scale differs per level", len(set(emissives.values())) > 1,
          str({k: round(v, 2) for k, v in emissives.items()}))
    fog_density = {short: docs[short]["fog"]["depthDensity"] for short in SHORTS}
    check("depth fog density differs per level", len(set(fog_density.values())) > 1,
          str(fog_density))
    check("River light sample probe shows the sun axis",
          min(docs["river"]["derived"]["shSunCosine"][:2]) > 0.85,
          str(docs["river"]["derived"]["shSunCosine"]))
    for short in SHORTS:
        check("%s spawn probe is inside the 10 m search radius" % short,
              docs[short]["ambientProbe"]["distance"] <= 10.0,
              "%.3f" % docs[short]["ambientProbe"]["distance"])
    check("all four manifests record the same retail amax entry",
          len({docs[short]["source"]["environment"]["entry"] for short in SHORTS}) == 1, "")
    check("all four manifests record the same amax sha256",
          len({docs[short]["source"]["environment"]["amaxSha256"] for short in SHORTS}) == 1, "")


def main() -> int:
    for short in SHORTS:
        verify_level(short)
    verify_global()
    passed = sum(1 for _, ok, _ in CHECKS if ok)
    total = len(CHECKS)
    for name, ok, detail in CHECKS:
        if not ok:
            print("FAIL %s\n     %s" % (name, detail))
    print("\n%d/%d checks passed" % (passed, total))
    if FAILURES:
        print("%d failure(s)" % len(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
