"""(DMGV1) Build the damage-visual manifest for every integrated E1 car.

Reads only committed / read-only artifacts:
  * ``_work/vehicle-pipeline/cars.json``                  (62-record audit, model map)
  * ``_work/vehicle-pipeline/models/<sha>.decoded``       (decoded PC ``.model``)
  * ``_work/vehicle-pipeline/materials/<slug>/*.json``    (independent draw traversal)
  * ``_work/car-parts/cars/<slug>/{manifest,scene-report}.json``   (A cars)
  * ``_work/car-materials/runtime/cars/<slug>/materials.json`` + ``textures/*.rawtexture``
  * ``probes/e1-drive/cars/roster.json``
  * ``game-data/Blur/cache/root.pak`` via ``pak_inspect``  (negative evidence)

Writes:
  ``_work/damage-visuals/index.json``                    full manifest
  ``_work/damage-visuals/coverage.json``                 47-model presence scan
  ``_work/damage-visuals/cars/<slug>/streams.json``
  ``_work/damage-visuals/cars/<slug>/draws.json``
  ``_work/damage-visuals/cars/<slug>/textures/*``

No guess, no invented texture, no renderer claim. Every value is either read
from a serialized field or decoded by the committed ``texture_inspect --raw``.
"""
from __future__ import annotations

import hashlib
import json
import struct
import subprocess
import zlib
from pathlib import Path

import scene_streams as S

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work" / "damage-visuals"
LOGS = ROOT / "_work" / "logs" / "damage-visuals"
RELEASE = ROOT / "_work" / "build" / "asset-reader-native" / "Release"
TEXTURE_INSPECT = RELEASE / "texture_inspect.exe"
SCENE_INSPECT = RELEASE / "scene_inspect.exe"
PAK_INSPECT = RELEASE / "pak_inspect.exe"

ROSTER = ROOT / "probes" / "e1-drive" / "cars" / "roster.json"

# Shader-family feature matrix, read from
# upstream/BlurRebuilt/code/mercury/library/graphics/vehicle/source/shaders/veh_*.fx
# (_VEH_ENABLE_*/_VEH_ASSUME_* defines) and shaders.jam:29-35 (the disabled-feature
# tokens appended to the serialized effect name).
FAMILY_FEATURES = {
    "paint":  {"dent": True,  "scratch": True,  "morph": True,  "controlPoints": True,  "swap": False},
    "paintm": {"dent": True,  "scratch": True,  "morph": True,  "controlPoints": True,  "swap": False},
    "glass":  {"dent": True,  "scratch": True,  "morph": True,  "controlPoints": True,  "swap": False},
    "default": {"dent": False, "scratch": True,  "morph": True,  "controlPoints": True,  "swap": False},
    "matt":   {"dent": False, "scratch": True,  "morph": True,  "controlPoints": True,  "swap": False},
    "alpha":  {"dent": False, "scratch": False, "morph": True,  "controlPoints": True,  "swap": False},
    "light":  {"dent": False, "scratch": False, "morph": True,  "controlPoints": True,  "swap": False},
    "alloy":  {"dent": False, "scratch": True,  "morph": False, "controlPoints": False, "swap": False},
    "neon":   {"dent": False, "scratch": False, "morph": True,  "controlPoints": True,  "swap": True},
    "winint": {"dent": False, "scratch": True,  "morph": True,  "controlPoints": False, "swap": False},
    "shadow": {"dent": False, "scratch": False, "morph": False, "controlPoints": False, "swap": False},
    "albedo": {"dent": False, "scratch": False, "morph": False, "controlPoints": False, "swap": False},
}
DISABLE_TOKEN = {"d": "dent", "f": "scratch", "h": "morph", "c": "controlPoints", "g": "swap"}
SHARED_DAMAGE_TEXTURES = {"paintdent", "smashedglass_nrm"}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def half_to_float(h: int) -> float:
    return struct.unpack("<e", struct.pack("<H", h))[0]


def png_write(path: Path, width: int, height: int, rgba: bytes) -> None:
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(rgba[y * stride:(y + 1) * stride])

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + tag + payload +
                struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
                     chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def decode_texture(rawpath: Path, outdir: Path, stem: str) -> dict:
    """Run the committed decoder on the original descriptor+mip bytes."""
    proc = subprocess.run([str(TEXTURE_INSPECT), str(rawpath), "--raw"],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"texture_inspect failed for {rawpath.name}: {proc.stderr.strip()[:200]}")
    data = json.loads(proc.stdout)
    if data.get("status") != "ok":
        raise RuntimeError(f"texture_inspect status for {rawpath.name}: {data.get('status')}")
    width, height = data["width"], data["height"]
    rgba = bytes(data["rgba"])
    if len(rgba) != width * height * 4:
        raise RuntimeError(f"RGBA length mismatch for {rawpath.name}")
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / f"{stem}.rgba").write_bytes(rgba)
    png_write(outdir / f"{stem}.png", width, height, rgba)
    return {
        "width": width,
        "height": height,
        "rgbaBytes": len(rgba),
        "rgbaSha256": sha256_bytes(rgba),
        "pngSha256": sha256_file(outdir / f"{stem}.png"),
    }


def stream_stats(scene: S.Scene, vb_index: int, element: dict) -> dict:
    vb = scene.vbs[vb_index]
    offset = element["offset"]
    stride = vb["stride"]
    data = scene.data
    base = vb["dataOffset"]
    values = []
    if element["type"] in (10, 11):    # U8_4 / U8_4N
        for v in range(vb["count"]):
            o = base + v * stride + offset
            values.append(tuple(data[o:o + 4]))
    else:
        raise RuntimeError(f"unexpected auxiliary stream type {element['type']}")

    result = {
        "usage": element["usage"],
        "usageIndex": element["usageIndex"],
        "type": element["type"],
        "offset": offset,
        "values": len(values),
        "uniqueValues": len(set(values)),
        "byteSha256": sha256_bytes(b"".join(bytes(b) for b in values)),
    }
    if element["type"] == 11:
        decoded = [((b[0] / 255.0) * 2.0 - 1.0,
                    (b[1] / 255.0) * 2.0 - 1.0,
                    (b[2] / 255.0) * 2.0 - 1.0) for b in values]
        comps = [c for t in decoded for c in t]
        neutral = sum(1 for b in values if b[0] == b[1] == b[2] == 127)
        result.update({
            "encode": "(byte/255)*2-1  [U8_4N decode + retail DX11 VS mad *2,-1]",
            "decodedRange": {
                "min": round(min(comps), 6),
                "max": round(max(comps), 6),
                "maxAbs": round(max(abs(c) for c in comps), 6),
            },
            "neutralValues": neutral,
            "neutralFraction": round(neutral / len(values), 6) if values else 0.0,
            "maxPossibleDisplacementMetres": round(max(abs(c) for c in comps), 6),
        })
    if element["usage"] == 5 and element["usageIndex"] == 4:
        pairs = {(b[0], b[1]) for b in values}
        weights = sorted({b[2] for b in values})
        result.update({
            "encode": "xy = control point indices, z = blend weight byte (0..254), w unused",
            "controlPointPairs": len(pairs),
            "controlPointPairSample": [list(p) for p in sorted(pairs)[:12]],
            "weightByteRange": [weights[0], weights[-1]] if weights else None,
            "weightByteDistinct": len(weights),
        })
    return result


def analyse_model(model_path: Path) -> dict:
    data = model_path.read_bytes()
    scene = S.Scene(data)
    result = {
        "modelSha256": sha256_bytes(data),
        "inputBytes": len(data),
        "sceneName": scene.metadata.get("scene_name"),
        "declarations": len(scene.declarations),
        "effects": scene.effects,
        "resourceBlocks": scene.resource_blocks,
        "loadedBlocks": scene.loaded_blocks,
        "baseVersion": scene.metadata.get("baseVersion"),
        "vertexBuffers": len(scene.vbs),
        "indexBuffers": len(scene.ibs),
        "primitives": len(scene.primitives),
        "declarationElements": [],
        "streamDeclarations": [],
        "buffers": [],
        "morphVertexCount": 0,
        "controlPointVertexCount": 0,
        "sharedTextures": scene.shared_textures,
    }
    for di, decl in enumerate(scene.declarations):
        elements = [{
            "stream": e["stream"],
            "offset": e["offset"],
            "type": e["type"],
            "method": e["method"],
            "usage": e["usage"],
            "usageIndex": e["usageIndex"],
            "semantic": S.USAGE_NAMES.get((e["usage"], e["usageIndex"]), f"usage{e['usage']}.{e['usageIndex']}"),
        } for e in decl]
        result["declarationElements"].append({"declaration": di, "elements": elements})
        morph = any(e["usage"] == 5 and e["usageIndex"] in (2, 3) for e in decl)
        cp = any(e["usage"] == 5 and e["usageIndex"] == 4 for e in decl)
        if morph or cp:
            result["streamDeclarations"].append({
                "declaration": di,
                "hasPositionOffset": any(e["usage"] == 5 and e["usageIndex"] == 2 for e in decl),
                "hasNormalOffset": any(e["usage"] == 5 and e["usageIndex"] == 3 for e in decl),
                "hasControlPointInfo": cp,
            })

    for vi, vb in enumerate(scene.vbs):
        entry = {
            "index": vi,
            "stride": vb["stride"],
            "vertexCount": vb["count"],
            "dataOffset": vb["dataOffset"],
            "dataBytes": vb["dataBytes"],
            "elements": [{"usage": e["usage"], "usageIndex": e["usageIndex"],
                          "type": e["type"], "method": e["method"], "offset": e["offset"],
                          "semantic": S.USAGE_NAMES.get((e["usage"], e["usageIndex"]),
                                                        f"usage{e['usage']}.{e['usageIndex']}")}
                         for e in vb["elements"]],
            "auxiliaryStreams": [],
        }
        for e in vb["elements"]:
            if e["usage"] == 5 and e["usageIndex"] in (2, 3, 4):
                entry["auxiliaryStreams"].append(stream_stats(scene, vi, e))
                if e["usageIndex"] in (2, 3):
                    result["morphVertexCount"] += vb["count"]
                if e["usageIndex"] == 4:
                    result["controlPointVertexCount"] += vb["count"]
        result["buffers"].append(entry)

    usage = {}
    for prim in scene.primitives:
        effect = scene.effects[prim["effect"]] if 0 <= prim["effect"] < len(scene.effects) else None
        for stream in prim["streams"]:
            if stream["index"] < 0:
                continue
            src = scene.vertex_sources[stream["vb"]]
            usage.setdefault(src["index"], set()).add(effect)
    for entry in result["buffers"]:
        entry["effects"] = sorted(x for x in usage.get(entry["index"], set()) if x)

    # Primitive -> declaration, so each draw can be classified.
    result["primitiveDeclarations"] = [p["declaration"] for p in scene.primitives]
    result["primitiveEffects"] = [
        scene.effects[p["effect"]] if 0 <= p["effect"] < len(scene.effects) else None
        for p in scene.primitives
    ]
    return result


def feature_state(effect: str, family: str) -> dict:
    tokens = effect.lower().removesuffix(".fx").split("_")
    features = dict(FAMILY_FEATURES.get(family, FAMILY_FEATURES["albedo"]))
    disabled = []
    for token in tokens:
        for letter, feature in DISABLE_TOKEN.items():
            if letter in token and features.get(feature):
                features[feature] = False
                disabled.append(feature)
    return {"family": family, "effect": effect, "disabledTokens": sorted(set(disabled)),
            "features": features}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def shared_texture_slice(model_path: Path, scene: S.Scene, name: str) -> tuple[bytes, dict] | None:
    entry = next((t for t in scene.shared_textures if t["name"] == name), None)
    if entry is None:
        return None
    data = model_path.read_bytes()
    payload = data[entry["dataOffset"]:entry["dataOffset"] + entry["dataBytes"]]
    return payload, entry


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    (OUT / "cars").mkdir(exist_ok=True)
    (OUT / "shared").mkdir(exist_ok=True)

    cars = load_json(ROOT / "_work" / "vehicle-pipeline" / "cars.json")
    roster = load_json(ROSTER)
    roster_slugs = [c["slug"] for c in roster["cars"]]
    records = {r["slug"]: r for r in cars["records"]}

    index = {
        "kind": "blur.damage-visual-manifest",
        "version": 1,
        "source": {
            "vehiclePipeline": "_work/vehicle-pipeline/cars.json",
            "vehiclePipelineSha256": sha256_file(ROOT / "_work" / "vehicle-pipeline" / "cars.json"),
            "roster": "probes/e1-drive/cars/roster.json",
            "rosterSha256": sha256_file(ROSTER),
        },
        "shaderFamilyFeatures": FAMILY_FEATURES,
        "disableTokens": DISABLE_TOKEN,
        "cars": {},
        "coverage": {},
        "negatives": {},
        "limits": [],
    }

    for slug in roster_slugs:
        record = records[slug]
        model_path = ROOT / record["model"]["decodedPath"]
        analysis = analyse_model(model_path)
        data = model_path.read_bytes()
        scene = S.Scene(data)

        car_dir = OUT / "cars" / slug
        car_dir.mkdir(parents=True, exist_ok=True)
        (car_dir / "streams.json").write_text(json.dumps(analysis, indent=1) + "\n", encoding="utf-8")

        # -------- per-draw classification -------------------------------
        pipeline_path = ROOT / "_work" / "vehicle-pipeline" / "materials" / slug / "corvette-materials.json"
        pipeline = load_json(pipeline_path) if pipeline_path.exists() else None
        parts_path = ROOT / "_work" / "car-parts" / "cars" / slug / "manifest.json"
        part_by_draw = {}
        if parts_path.exists():
            part_by_draw = {d["index"]: d.get("partId") for d in load_json(parts_path)["draws"]}

        runtime_path = ROOT / "_work" / "car-materials" / "runtime" / "cars" / slug / "materials.json"
        runtime = load_json(runtime_path) if runtime_path.exists() else None
        runtime_draws = {d["index"]: d for d in runtime["draws"]} if runtime else {}

        draw_count = pipeline["drawCount"] if pipeline else (len(parts_path and load_json(parts_path)["draws"]) if parts_path.exists() else len(analysis["primitiveDeclarations"]))
        draws = []
        for i in range(draw_count):
            rt = runtime_draws.get(i)
            if rt is not None:
                family = rt["shaderFamily"]
                effect = rt["effect"]
                role = rt["kind"]
                bindings = [{"parameter": b["parameter"], "role": b["role"],
                             "textureName": b["textureName"], "textureId": b["textureId"],
                             "fieldSerializedOffset": b["fieldSerializedOffset"],
                             "materialIndex": b["materialIndex"],
                             "materialStage": b["materialStage"]}
                            for b in rt["staticTextureBindings"]]
            else:
                pdraw = pipeline["draws"][i] if pipeline and i < len(pipeline["draws"]) else {}
                effect = pdraw.get("effect")
                family = pdraw.get("shaderFamily") or "albedo"
                role = pdraw.get("status") or "unknown"
                bindings = None
            if effect is None and i < len(analysis["primitiveEffects"]):
                effect = analysis["primitiveEffects"][i]
            state = feature_state(effect or "", family)
            decl_index = analysis["primitiveDeclarations"][i] if i < len(analysis["primitiveDeclarations"]) else None
            has_morph = None
            if decl_index is not None and 0 <= decl_index < len(analysis["declarationElements"]):
                has_morph = any(e["usage"] == 5 and e["usageIndex"] == 2
                                for e in analysis["declarationElements"][decl_index]["elements"])
            draws.append({
                "draw": i,
                "partId": part_by_draw.get(i),
                "role": role,
                "effect": effect,
                "family": state["family"],
                "declaration": decl_index,
                "declarationHasMorphStreams": has_morph,
                "disabledTokens": state["disabledTokens"],
                "features": state["features"],
                "damageBindings": bindings,
                "damageBindingsReason": None if bindings is not None else
                    "no committed per-draw damage-texture manifest for this car (P60 covers the five A cars)",
            })
        (car_dir / "draws.json").write_text(json.dumps(draws, indent=1) + "\n", encoding="utf-8")

        # -------- textures ---------------------------------------------
        textures = []
        texdir = car_dir / "textures"
        for name in sorted(SHARED_DAMAGE_TEXTURES):
            found = shared_texture_slice(model_path, scene, name)
            if not found:
                continue
            payload, entry = found
            raw = OUT / "shared" / f"{name}.rawtexture"
            if not raw.exists():
                # Embedded descriptor + complete mip chain, byte-for-byte.
                raw.write_bytes(payload)
            decoded_ok = True
            reason = None
            try:
                decoded = decode_texture(raw, texdir, name)
            except RuntimeError as exc:  # the committed decoder bound is authoritative
                decoded_ok = False
                reason = str(exc)
                decoded = None
            textures.append({
                "textureName": name,
                "source": "shared-texture-slot",
                "slot": entry["slot"],
                "serializedHash": entry["hash"],
                "modelDataOffset": entry["dataOffset"],
                "modelDataBytes": entry["dataBytes"],
                "rawtextureSha256": sha256_bytes(payload),
                "decoded": decoded,
                "decodedOk": decoded_ok,
                "undecodedReason": reason,
            })

        # P60 per-car block textures for the five A cars
        p60_dir = ROOT / "_work" / "car-materials" / "runtime" / "cars" / slug / "textures"
        if p60_dir.exists():
            for item in sorted(p60_dir.glob("*.rawtexture")):
                if item.stem.startswith(("shared-0-paintdent",)):
                    continue  # decoded above from the model bytes
                decoded = decode_texture(item, texdir, item.stem)
                textures.append({
                    "textureName": item.stem.rsplit("-lod", 1)[0].split("-", 3)[-1],
                    "file": item.name,
                    "source": "P60 committed runtime texture manifest",
                    "rawtextureSha256": sha256_file(item),
                    "rawtextureBytes": item.stat().st_size,
                    "decoded": decoded,
                    "decodedOk": True,
                    "undecodedReason": None,
                })
        index["cars"][slug] = {
            "name": record["name"],
            "recordIndex": record["index"],
            "recordId": record["id"],
            "drivetrain": record["drivetrain"],
            "mass": record["mass"],
            "model": {
                "expectedPath": record["model"]["expectedPath"],
                "pakPath": record["model"]["pakPath"],
                "decodedPath": record["model"]["decodedPath"],
                "sha256": record["model"]["modelSha256"],
                "pakOffset": record["model"]["pakOffset"],
            },
            "drawCount": len(draws),
            "morphVertexCount": analysis["morphVertexCount"],
            "controlPointVertexCount": analysis["controlPointVertexCount"],
            "damageTextures": textures,
            "hasP60DrawBindings": runtime is not None,
            "limits": [],
        }

    # ------------------------------------------------------- 47-model scan
    coverage = {}
    for record in cars["records"]:
        if record["model"].get("mapping") != "exact":
            continue
        path = ROOT / record["model"]["decodedPath"]
        try:
            data = path.read_bytes()
            scene = S.Scene(data)
            morph = sum(vb["count"] for vb in scene.vbs
                        if any(e["usage"] == 5 and e["usageIndex"] in (2, 3) for e in vb["elements"]))
            cp = sum(vb["count"] for vb in scene.vbs
                     if any(e["usage"] == 5 and e["usageIndex"] == 4 for e in vb["elements"]))
            coverage[record["slug"]] = {
                "recordIndex": record["index"],
                "recordId": record["id"],
                "modelSha256": hashlib.sha256(data).hexdigest(),
                "declarations": len(scene.declarations),
                "buffers": len(scene.vbs),
                "primitives": len(scene.primitives),
                "morphVertexCount": morph,
                "controlPointVertexCount": cp,
                "hasMorphStreams": morph > 0,
                "hasControlPointStreams": cp > 0,
                "integrated": record["slug"] in roster_slugs,
            }
        except Exception as exc:  # noqa: BLE001 - record the failure, never guess
            coverage[record["slug"]] = {
                "recordIndex": record["index"],
                "recordId": record["id"],
                "error": str(exc),
                "integrated": record["slug"] in roster_slugs,
            }
    index["coverage"] = coverage

    # -------------------------------------------------------- negative evidence
    pak_json = OUT / "pak-inventory.json"
    if not pak_json.exists():
        proc = subprocess.run([str(PAK_INSPECT), str(ROOT / "game-data" / "Blur" / "cache" / "root.pak")],
                              capture_output=True, text=True)
        pak_json.write_text(proc.stdout, encoding="utf-8")
    pak = json.loads(pak_json.read_text(encoding="utf-8"))
    entries = pak["entries"]

    def matches(*needles: str) -> list[str]:
        return sorted(e["path"] for e in entries
                      if e.get("path") and all(n.lower() in e["path"].lower() for n in needles))

    vehicle_models = sorted(e["path"] for e in entries
                            if e.get("path", "").lower().startswith("\\models\\vehicles\\")
                            and e["path"].lower().endswith(".model"))
    index["negatives"] = {
        "rootPakEntries": len(entries),
        "vehicleModelCount": len(vehicle_models),
        "wreckModelPaths": [p for p in vehicle_models if "wreck" in p.lower()],
        "damagedModelPaths": [p for p in vehicle_models if "damag" in p.lower()],
        "dirtLayerPaths": matches("dirtlayer"),
        "dontshipDirtTextures": [e["path"] for e in entries
                                 if e.get("path", "").lower().startswith("\\dontship\\")
                                 and "vehicledirt" in e["path"].lower()],
        "smashedGlassTextures": matches("smashedglass"),
        "paintDentTextures": matches("paintdent"),
        "damageDirEntries": [e["path"] for e in entries
                             if e.get("path", "").lower().endswith("vehicles\\damaged")],
        "vehicleModelNames": [p.rsplit("\\", 1)[-1] for p in vehicle_models],
    }

    index["limits"] = [
        "Data extraction only; no renderer, shader, sampler or GPU claim.",
        "The damage volume lattice and the damage info texture are runtime-generated "
        "(DamageLayer.cpp:2977-3169); they are not stored in the model and are not reproduced here.",
        "Morph-target streams are decoded as stored U8_4N and reported in object space; "
        "no morph level is applied and no vertex is displaced.",
        "Scratch/dent acceptance depends on the health-zone damage filter and the impact "
        "level (VLC_Damage.cpp:894-919); only the decoded rules table is reported.",
        "The 1024x1024 shared smashedglass_nrm is outside the committed decoder bound and "
        "stays undecoded with its exact reason.",
        "Per-draw damage-texture bindings exist only for the five A cars (P60 committed "
        "runtime material manifests); the other integrated cars carry effect-level "
        "classification and stream coverage only.",
    ]

    (OUT / "index.json").write_text(json.dumps(index, indent=1) + "\n", encoding="utf-8")
    (OUT / "coverage.json").write_text(json.dumps(coverage, indent=1) + "\n", encoding="utf-8")
    print(f"cars={len(index['cars'])} coverage={len(coverage)} textures="
          f"{sum(len(c['damageTextures']) for c in index['cars'].values())}")


if __name__ == "__main__":
    main()
