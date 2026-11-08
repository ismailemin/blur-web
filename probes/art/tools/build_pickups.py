"""Build the ART1 pickup/weapon asset inventory, per-asset manifests and previews.

Read-only inputs:
  * `game-data/Blur/cache/root.pak`     (codec 4 packet zlib; models, cycles)
  * `game-data/Blur/cache/gamedata.pak` (codec 2 zlib; `pickups.bin`)
  * committed readers in `probes/asset-reader` compiled to
    `_work/build/asset-reader-native/Release/*.exe`
  * `probes/powerups/tools/xt_decode.py` (FLSK v2 record decoder, imported)
  * `probes/car-parts/tools/build_manifest.py::parse_mdldat` (MdlDat element layer)
  * `_work/powerups/placements{,-amboy,-gracia}.json` (authoring heights, read-only)
  * extracted reference source under `_work/engine-vehicle-spike/tree/` (citations)

Writes only under `--out` (default `_work/art/pickups`).

Every asset is selected from serialized data, never from a filename guess:
  * spawn icons  -> `PickupSystem.Types[]` -> `PickupType.PickupSpecialFX` ->
                    `SpecialFX.Components` -> `AnimatedMeshSpecialFX.
                    AnimatedMeshFileName` / `AnimationFileName` (`pickups.bin`)
  * weapon/world -> `PickupLevel.SpecialFX.<slot>[]` items of the decoded level
                    (`MineSpecialFX`, `ShieldDomeSpecialFX`, `ProjectileSpecialFX`,
                     `FiredSpecialFX`, `HitVehicleSpecialFX`)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parents[2]
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(ROOT / "probes" / "powerups" / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "car-parts" / "tools"))

import pak_util as U  # noqa: E402
import preview as P  # noqa: E402
import xt_decode as X  # noqa: E402
from build_manifest import parse_mdldat  # noqa: E402

PICKUPS_XT = "\\gamedata\\xt\\pickups.bin"
PICKUP_SYSTEM_REF_ID = 253474959

LABELS = [
    "Nitrous", "Shock", "Shunt", "Blindfire", "Barge", "Bomb",
    "Repair", "Shield", "Fan", "Stopwatch", "SuperShield",
]
MP_LABELS = ["Nitrous", "Shock", "Shunt", "Blindfire", "Barge", "Bomb",
             "Repair", "Shield"]

SPAWN_SLUGS = {
    "Nitrous": "pickup-nitrous",
    "Shock": "pickup-shock",
    "Shunt": "pickup-shunt",
    "Blindfire": "pickup-blindfire",
    "Barge": "pickup-barge",
    "Bomb": "pickup-bomb",
    "Repair": "pickup-repair",
    "Shield": "pickup-shield",
    "SuperShield": "pickup-supershield",
    "Fan": "pickup-fan",
    "Stopwatch": "pickup-stopwatch",
}

# (slug, entity label, level, slot, item index, expected model basename, role)
WORLD_SELECTIONS = [
    ("mine-core1", "Bomb", "Normal", "MineSpecialFX", 0, "minecore1", "placed mine: core shell"),
    ("mine-core2", "Bomb", "Normal", "MineSpecialFX", 0, "minecore2", "placed mine: pulse core"),
    ("shield-bubble", "Shield", "Normal", "ShieldDomeSpecialFX", 0, "shieldlevel1", "shield dome shell"),
    ("shield-bubble-bumper", "Shield", "Normal", "ShieldDomeSpecialFX", 0, "shieldlevel1bumper", "shield dome bumper"),
    ("supershield-bubble", "SuperShield", "Normal", "ShieldDomeSpecialFX", 0, "shieldsuper", "SuperShield dome shell"),
    ("supershield-bubble-bumper", "SuperShield", "Normal", "ShieldDomeSpecialFX", 0, "shieldsuperbumper", "SuperShield dome bumper"),
    ("projectile-blindfire", "Blindfire", "Normal", "ProjectileSpecialFX", 0, "blind_projectile_01", "Blindfire/Bolt projectile (Normal)"),
    ("projectile-blindfire-modified", "Blindfire", "Modified", "ProjectileSpecialFX", 0, "bolt_shotgun_projectile", "Blindfire/Bolt projectile (Modified)"),
    ("projectile-shunt", "Shunt", "Normal", "ProjectileSpecialFX", 0, "shuntprojectile1", "Shunt projectile"),
    ("barge-wave-left", "Barge", "Normal", "FiredSpecialFX", 0, "bargewave1left", "barge shockwave (left/front)"),
    ("barge-wave-bumper", "Barge", "Normal", "FiredSpecialFX", 0, "bargewavebumper", "barge shockwave (bumper)"),
    ("barge-wave-ring", "Barge", "Normal", "FiredSpecialFX", 0, "bargewavering", "barge shockwave (ring)"),
    ("barge-wave-residue", "Barge", "Normal", "FiredSpecialFX", 1, "bargewaveresidue", "barge shockwave residue"),
    ("repair-effect", "Repair", "Normal", "HitVehicleSpecialFX", 0, "repairing1", "repair effect (body)"),
    ("repair-effect-bumper", "Repair", "Normal", "HitVehicleSpecialFX", 0, "repairingbumper", "repair effect (bumper)"),
]

CITATIONS = [
    ("_work/engine-vehicle-spike/tree/code/amax/game/GameLogic/ActorStudioActors/PickupPositionActor.cpp",
     [72, 208, 305, 338, 786, 789, 791, 813]),
    ("_work/engine-vehicle-spike/tree/code/mercury/library/gamesys/specialFX/source/AnimatedMesh.cpp",
     [146, 204, 206, 291]),
]


def normalise_asset_path(value: str) -> str:
    """Serialized names mix `/` and `\\`; PAK paths are backslash-separated."""
    cleaned = value.strip().replace("/", "\\")
    while "\\\\" in cleaned:
        cleaned = cleaned.replace("\\\\", "\\")
    if not cleaned.startswith("\\"):
        cleaned = "\\" + cleaned
    return cleaned.lower()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_pickup_system() -> tuple[X.Flask, dict]:
    data, info = U.decode_zlib_entry("gamedata.pak", PICKUPS_XT)
    flask = X.Flask(data)
    index = None
    for candidate in range(len(flask.records)):
        if flask.record_id(candidate) == PICKUP_SYSTEM_REF_ID:
            index = candidate
            break
    if index is None:
        raise SystemExit("pickups.bin has no PickupSystem record")
    return flask, flask.decode_record(index)


def collect_assets(node, out, path=""):
    """Collect every serialized .model/.cycle/.texture string with its JSON path."""
    if isinstance(node, dict):
        for key, value in node.items():
            collect_assets(value, out, path + "/" + key)
    elif isinstance(node, list):
        for position, value in enumerate(node):
            collect_assets(value, out, path + f"[{position}]")
    elif isinstance(node, str):
        if node.lower().endswith((".model", ".cycle", ".texture")):
            out.append({"jsonPath": path, "value": node})


def collect_lights(node, out, path=""):
    """Collect every LightSpecialFX component under a PickupSpecialFX item."""
    if isinstance(node, dict):
        if node.get("$type") in ("LightSpecialFX", "SpriteParticleSpecialFX"):
            out.append({"jsonPath": path, "type": node["$type"], "value": node})
        for key, value in node.items():
            collect_lights(value, out, path + "/" + key)
    elif isinstance(node, list):
        for position, value in enumerate(node):
            collect_lights(value, out, path + f"[{position}]")


def decode_entities(system: dict) -> dict:
    entities = {}
    for item in system["Types"]["items"]:
        record = item["value"]
        label = record["Type"]["label"]
        if label not in LABELS:
            continue
        special_fx = record.get("PickupSpecialFX")
        if not isinstance(special_fx, dict) or "value" not in special_fx:
            raise SystemExit(f"{label}: PickupSpecialFX handle does not resolve")
        meshes, lights, others = [], [], []
        for component in special_fx["value"]["Components"]["items"]:
            inner = component["Component"]
            kind = inner["typeName"]
            value = inner["value"]
            entry = {
                "type": kind,
                "refId": inner["refId"],
                "record": inner["record"],
                "speedFactor": component.get("SpeedFactor"),
                "startOffset": component.get("StartOffset"),
            }
            if kind == "AnimatedMeshSpecialFX":
                entry["model"] = normalise_asset_path(value["AnimatedMeshFileName"]["value"])
                entry["cycle"] = normalise_asset_path(value["AnimationFileName"]["value"])
                entry["skeleton"] = value["SkeletonFileName"]["value"]
                entry["farDistance"] = value["FarDistance"]
                entry["internalSpecialFxCount"] = len(value["InternalSpecialFX"]["items"])
                meshes.append(entry)
            elif kind == "LightSpecialFX":
                entry["light"] = {
                    "time": value["Time"],
                    "offset": {k: value["Offset"][k] for k in ("vx", "vy", "vz")},
                    "colour": {k: value["Colour"][k] for k in ("r", "g", "b")},
                    "radius": value["Radius"],
                    "cullDistance": value["CullDistance"],
                    "graph": [{"time": k["Time"], "value": k["Value"]}
                              for k in value["EffectGraph"]["items"]],
                }
                lights.append(entry)
            else:
                entry["fields"] = sorted(value.keys())
                others.append(entry)
        if len(meshes) != 1:
            raise SystemExit(f"{label}: expected one AnimatedMeshSpecialFX, got {len(meshes)}")
        entities[label] = {
            "refId": item["refId"],
            "record": item["record"],
            "typeField": record["Type"],
            "specialFx": {"refId": special_fx["refId"], "record": special_fx["record"]},
            "cycleBegin": record.get("PickupSpecialFXBeginCycle"),
            "cycleEnd": record.get("PickupSpecialFXEndCycle"),
            "mesh": meshes[0],
            "light": lights[0] if lights else None,
            "extraComponents": others,
            "levelNames": [name for name in ("Normal", "DoubleTap", "Reversed",
                                             "ReversedDoubleTap", "Mini", "Modified",
                                             "ReversedModified")
                           if isinstance(record.get(name), dict)],
            "recordValue": record,
        }
    missing = [label for label in LABELS if label not in entities]
    if missing:
        raise SystemExit(f"missing PickupType labels: {missing}")
    return entities


def level_special_fx(record: dict, level: str) -> dict:
    handle = record.get(level)
    if not isinstance(handle, dict) or "value" not in handle:
        raise SystemExit(f"{record['Type']['label']}: no {level} level")
    special_fx = handle["value"].get("SpecialFX")
    if not isinstance(special_fx, dict):
        raise SystemExit(f"{record['Type']['label']}/{level}: no SpecialFX tree")
    return special_fx


def find_slot_item(tree: dict, slot: str, item_index: int) -> dict:
    array = tree.get(slot)
    if not isinstance(array, dict):
        raise SystemExit(f"slot {slot} not present")
    items = array["items"]
    if item_index >= len(items):
        raise SystemExit(f"slot {slot} has only {len(items)} item(s)")
    return items[item_index]


def decode_model(path: str) -> dict:
    data, info = U.decode_entry("root.pak", path)
    chunks = U.model_inspect(data, "asset.model")
    scene = U.scene_inspect(data, "asset.model")
    resources = U.scene_resource_textures(data, "asset.model")
    mdldat = parse_mdldat(data)
    return {"bytes": data, "entry": info, "chunks": chunks, "scene": scene,
            "resources": resources, "mdldat": mdldat}


def texture_records(data: bytes, scene: dict) -> list:
    rows = []
    for texture in scene.get("sharedTextures", []):
        start = texture["dataOffset"]
        end = start + texture["dataBytes"]
        row = {"name": texture["name"], "hash": texture["hash"],
               "dataOffset": start, "dataBytes": texture["dataBytes"]}
        if start < 0 or end > len(data) or texture["dataBytes"] <= 0:
            row.update({"status": "blocked", "reason": "texture span outside model bytes"})
            rows.append(row)
            continue
        blob = data[start:end]
        result = U.texture_raw_inspect(blob, "embedded.tex")
        if result.get("status") == "ok":
            row.update({
                "status": "decoded",
                "width": result["width"],
                "height": result["height"],
                "rgbaSha256": sha256_bytes(bytes(result["rgba"])),
                "rgbaBytes": len(result["rgba"]),
            })
            row["_rgba"] = result["rgba"]
        else:
            row.update({
                "status": "unsupported-format",
                "reason": result.get("error") or result.get("message") or "decoder rejected descriptor",
            })
        rows.append(row)
    return rows


def finite_bounds(bounds: dict) -> bool:
    for key in ("min", "max"):
        values = bounds.get(key, [])
        if len(values) != 3 or not all(math.isfinite(v) for v in values):
            return False
    return True


def build_asset(slug: str, role: str, referenced_by: list, model_path: str,
                cycle_path: str | None, lights: list, out: Path) -> dict:
    asset_dir = out / slug
    asset_dir.mkdir(parents=True, exist_ok=True)
    decoded = decode_model(model_path)
    scene = decoded["scene"]
    if scene.get("status") != "ok":
        raise SystemExit(f"{slug}: scene reader failed: {scene.get('message')}")

    mdldat = decoded["mdldat"]
    model_count = mdldat["modelCount"]
    elements = [{
        "index": e["index"], "name": e["name"], "modelIndex": e["modelIndex"],
        "matrix": e["matrix"], "min": e["min"], "max": e["max"],
        "linearIdentity": e["linearIdentity"],
        "linearDeviation": round(e["linearDeviation"], 9),
        "parent": e["parent"], "renderMeshId": e["renderMeshId"],
    } for e in mdldat["elements"]]

    textures = texture_records(decoded["bytes"], scene)
    for row in textures:
        rgba = row.pop("_rgba", None)
        if rgba is not None:
            tex_dir = asset_dir / "textures"
            tex_dir.mkdir(parents=True, exist_ok=True)
            (tex_dir / (row["name"] + ".png")).write_bytes(
                P.texture_png(row["width"], row["height"], rgba))

    metadata = scene["metadata"]
    bounds = scene["bounds"]
    png = P.render(scene["positions"], scene["indices"], scene["draws"], bounds)
    (asset_dir / "preview.png").write_bytes(png)

    cycle = None
    if cycle_path:
        cycle_data, cycle_info = U.decode_entry("root.pak", cycle_path)
        cycle = {**cycle_info, "decodedBytes": len(cycle_data)}

    manifest = {
        "slug": slug,
        "role": role,
        "referencedBy": referenced_by,
        "model": {
            **decoded["entry"],
            "chunks": decoded["chunks"]["chunks"],
            "chunkCount": decoded["chunks"]["chunkCount"],
            "platform": decoded["chunks"]["platform"],
        },
        "cycle": cycle,
        "lights": lights,
        "mdlDat": {
            "modelCount": model_count,
            "elementCount": mdldat["elementCount"],
            "elements": elements,
            "animatedMeshModelIndex": 1 if model_count > 1 else 0,
        },
        "scene": {
            "status": scene["status"],
            "metadata": metadata,
            "bounds": bounds,
            "draws": scene["draws"],
            "sharedTextures": textures,
        },
        "counts": {
            "vertexCount": metadata["vertexCount"],
            "triangleCount": metadata["triangleCount"],
            "primitiveCount": metadata["primitiveCount"],
            "drawCount": len(scene["draws"]),
            "uv0ValidVertices": metadata["uv0ValidVertices"],
            "uv0PlaceholderVertices": metadata["uv0PlaceholderVertices"],
            "textureCount": len(textures),
            "texturesDecoded": sum(1 for t in textures if t["status"] == "decoded"),
            "texturesUnsupported": sum(1 for t in textures if t["status"] != "decoded"),
        },
        "boundsFinite": finite_bounds(bounds),
        "preview": {
            "path": f"{slug}/preview.png",
            "width": P.WIDTH,
            "height": P.HEIGHT,
            "sha256": sha256_bytes(png),
        },
        "resourceTextures": {
            "status": decoded["resources"].get("status"),
            "blockCount": len(decoded["resources"].get("resourceBlocks", [])),
            "metadata": decoded["resources"].get("metadata", {}),
        },
        "notes": [
            "scene reader output is the first render list (resource block 0, LOD0), "
            "object-local; node transforms and runtime materials are not applied",
        ],
    }
    U.write_json(asset_dir / "manifest.json", manifest)
    return manifest


def citation_block() -> list:
    rows = []
    for rel, lines in CITATIONS:
        path = ROOT / rel
        data = path.read_bytes()
        text = data.decode("utf-8", "replace").splitlines()
        rows.append({
            "path": rel,
            "sha256": sha256_bytes(data),
            "lines": [{"line": n, "text": text[n - 1].strip()} for n in lines],
        })
    return rows


def placement_hover() -> dict:
    """Recover the authored hover height: WorldMatrix Y minus collision ground Y."""
    files = ["placements.json", "placements-amboy.json", "placements-gracia.json"]
    per_file = {}
    all_heights = []
    primary_heights = []
    rotate = {"true": 0, "false": 0, "absent": 0}
    for name in files:
        path = ROOT / "_work" / "powerups" / name
        if not path.exists():
            per_file[name] = {"status": "unavailable"}
            continue
        doc = json.loads(path.read_text(encoding="utf-8"))
        batches = [("root", doc.get("placements"))]
        primary_id = doc.get("authority", {}).get("primaryRouteRecordId")
        for route in doc.get("authority", {}).get("routes", []):
            batches.append((route.get("recordId"), route.get("placements")))
        heights = []
        for key, placements in batches:
            if not placements:
                continue
            for placement in placements:
                height = placement.get("collision", {}).get("heightAboveGround")
                if isinstance(height, (int, float)) and math.isfinite(height):
                    heights.append(float(height))
                    all_heights.append(float(height))
                    if key == "root" or key == primary_id:
                        primary_heights.append(float(height))
                flag = placement.get("overrides", {}).get("rotateGraphic")
                if flag is True:
                    rotate["true"] += 1
                elif flag is False:
                    rotate["false"] += 1
                else:
                    rotate["absent"] += 1
        heights.sort()
        per_file[name] = {
            "status": "recovered",
            "n": len(heights),
            "min": heights[0],
            "median": heights[len(heights) // 2],
            "max": heights[-1],
        } if heights else {"status": "empty"}

    def summary(values, band=False):
        ordered = sorted(v for v in values if (not band or 0.0 < v <= 3.0))
        if not ordered:
            return {"status": "unavailable", "n": 0}
        return {
            "n": len(ordered),
            "min": ordered[0],
            "p10": ordered[len(ordered) // 10],
            "median": ordered[len(ordered) // 2],
            "p90": ordered[(len(ordered) * 9) // 10],
            "max": ordered[-1],
        }

    return {
        "hoverHeightMetres": {
            "primarySets": summary(primary_heights),
            "allRecoveredSets": summary(all_heights),
            "primarySetsAuthoredBand": summary(primary_heights, band=True),
            "allRecoveredSetsAuthoredBand": summary(all_heights, band=True),
            "authoredBandRule": "0.0 < heightAboveGround <= 3.0 m; excludes the four "
                                "Amboy/Gracia slots whose 'highest up-facing triangle' "
                                "probe hit a bridge/overpass surface (negative heights, "
                                "already flagged drivableSurface:false in the placement "
                                "manifests). No value is replaced or moved.",
            "perFile": per_file,
            "definition": "placement WorldMatrix.AW.y minus collision groundY from the "
                          "PWR3/PWR5 placement manifests",
            "status": "recovered-from-serialized-placement",
            "provenance": [
                "docs/work/analysis/pickup-placement.md §3 (54 River placements, "
                "heightAboveGround 0.692-1.564 m, median ~0.70 m)",
                "creator-authored WorldMatrix, not a runtime constant",
            ],
        },
        "rotateGraphic": {
            "counts": rotate,
            "status": "recovered-from-serialized-placement",
            "note": "all recovered raced placements serialize RotateGraphic=false",
        },
    }


def transform_block(entities: dict, placements: dict, assets_by_slug: dict) -> dict:
    icon_quads = {}
    for label in LABELS:
        asset = assets_by_slug[SPAWN_SLUGS[label]]
        bounds = asset["scene"]["bounds"]
        mn, mx = bounds["min"], bounds["max"]
        icon_quads[label] = {
            "width": mx[0] - mn[0],
            "height": mx[1] - mn[1],
            "thickness": mx[2] - mn[2],
            "bottomY": mn[1],
            "topY": mx[1],
            "metresAtScale1": True,
            "note": "object-local quad bounds; the .cycle may animate a scale that is not decoded",
        }
    car = load_reference_car()
    return {
        "scale": {
            "value": 1.0,
            "status": "recovered-from-code",
            "provenance": [
                "AnimatedMesh.cpp:153,204-207,291 - the special FX instance stores the "
                "actor HMat43 and schedules the model with that matrix; no scale, "
                "rotation or offset is applied",
                "PickupPositionActor.cpp:189-190 - mWorldMatrix = Load(creation WorldMatrix)",
            ],
        },
        "rotation": {
            "actorYawRadPerUpdate": 0.1,
            "status": "recovered-from-code",
            "applied": False,
            "appliedReason": "every recovered raced placement serializes RotateGraphic=false",
            "provenance": [
                "PickupPositionActor.cpp:72 gDebugRotationSpeed(\"Perks.PickupActor.RotationSpeed\", 0.1f)",
                "PickupPositionActor.cpp:305 mRotateSpeed = gDebugRotationSpeed",
                "PickupPositionActor.cpp:789-791 applied per update as RotY(mRotateSpeed) * "
                "mWorldMatrix only when mRotateGraphic",
            ],
            "shuffleSpin": {
                "rotateTimeSeconds": 1.02,
                "speedModifier": 1.0,
                "speedMin": 0.0,
                "speedMax": 1.0,
                "shuffleIntervalSeconds": 5.0,
                "status": "recovered-from-code",
                "provenance": [
                    "PickupPositionActor.cpp:75-79,555-587 - shuffle re-roll ramps "
                    "mRotateSpeed to at most 1.0 rad/update over 1.02 s",
                ],
                "note": "unused by the recovered raced sets: ConstantShuffle=false",
            },
        },
        "bob": {
            "status": "not-decoded",
            "value": None,
            "reason": "no vertical motion is applied to the actor world matrix "
                      "(AnimatePickup only composes RotY); any bob lives inside the "
                      ".cycle animation, and no .cycle reader exists in this repository",
        },
        "light": {
            "status": "recovered-from-serialized-data",
            "perType": {
                label: ({
                    "offset": entity["light"]["light"]["offset"],
                    "time": entity["light"]["light"]["time"],
                    "radius": entity["light"]["light"]["radius"],
                    "cullDistance": entity["light"]["light"]["cullDistance"],
                    "colour": entity["light"]["light"]["colour"],
                    "graph": entity["light"]["light"]["graph"],
                } if entity["light"] else None)
                for label, entity in entities.items()
            },
        },
        "hover": placements["hoverHeightMetres"],
        "rotateGraphic": placements["rotateGraphic"],
        "iconQuad": {
            "status": "recovered-from-model-bounds",
            "perType": icon_quads,
            "provenance": [
                "scene_inspect bounds of each spawn icon model (object-local, "
                "nodeTransformsApplied:false); the single DefaultElement has an "
                "identity linear matrix",
            ],
        },
        "referenceCar": car,
        "cycles": {
            "status": "referenced-not-decoded",
            "reason": "the `.cycle` container has no committed reader; only its PAK "
                      "identity and the serialized loop window are recorded",
            "perType": {
                label: {
                    "cycle": entity["mesh"]["cycle"],
                    "cycleBegin": entity["cycleBegin"],
                    "cycleEnd": entity["cycleEnd"],
                    "farDistance": entity["mesh"]["farDistance"],
                }
                for label, entity in entities.items()
            },
        },
    }


def load_reference_car() -> dict:
    """Corvette ZR1 bounds from the committed car-parts manifest (scale reference)."""
    path = ROOT / "_work" / "car-parts" / "cars" / "corvette-zr1-stock" / "manifest.json"
    if not path.exists():
        return {"status": "unavailable"}
    data = path.read_bytes()
    doc = json.loads(data)
    bounds = doc["mesh"]["bounds"]
    mn, mx = bounds["min"], bounds["max"]
    return {
        "status": "recovered-from-committed-manifest",
        "slug": "corvette-zr1-stock",
        "source": "_work/car-parts/cars/corvette-zr1-stock/manifest.json",
        "sha256": sha256_bytes(data),
        "bounds": bounds,
        "width": mx[0] - mn[0],
        "height": mx[1] - mn[1],
        "length": mx[2] - mn[2],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "_work" / "art" / "pickups")
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)

    _, system = load_pickup_system()
    entities = decode_entities(system)

    assets = []
    for label in LABELS:
        entity = entities[label]
        mesh = entity["mesh"]
        referenced_by = [{
            "entity": label,
            "pickupTypeRefId": entity["refId"],
            "pickupTypeRecord": entity["record"],
            "specialFxRefId": entity["specialFx"]["refId"],
            "specialFxRecord": entity["specialFx"]["record"],
            "slot": "PickupSpecialFX",
            "componentType": "AnimatedMeshSpecialFX",
            "componentRefId": mesh["refId"],
            "componentRecord": mesh["record"],
            "location": "actor WorldMatrix (PickupPositionActor.cpp:813)",
            "cycle": mesh["cycle"],
            "cycleBegin": entity["cycleBegin"],
            "cycleEnd": entity["cycleEnd"],
            "farDistance": mesh["farDistance"],
        }]
        assets.append(build_asset(SPAWN_SLUGS[label], f"{label} spawn icon",
                                  referenced_by, mesh["model"], mesh["cycle"],
                                  [entity["light"]] if entity["light"] else [], out))

    batch = []
    for slug, label, level, slot, item_index, basename, role in WORLD_SELECTIONS:
        entity = entities[label]
        tree = level_special_fx(entity["recordValue"], level)
        item = find_slot_item(tree, slot, item_index)
        found = []
        collect_assets(item, found)
        models = []
        for row in found:
            if not row["value"].lower().endswith(".model"):
                continue
            normalised = normalise_asset_path(row["value"])
            if normalised not in [m["path"] for m in models]:
                models.append({"path": normalised, "jsonPath": row["jsonPath"]})
        cycles = []
        for row in found:
            if not row["value"].lower().endswith(".cycle"):
                continue
            normalised = normalise_asset_path(row["value"])
            if normalised not in [c["path"] for c in cycles]:
                cycles.append({"path": normalised, "jsonPath": row["jsonPath"]})
        match = [m for m in models
                 if Path(m["path"].replace("\\", "/")).stem.lower() == basename]
        if len(match) != 1:
            raise SystemExit(f"{slug}: expected one model basename {basename}, "
                             f"got {[m['path'] for m in models]}")
        chosen = match[0]
        cycle_match = [c for c in cycles
                       if Path(c["path"].replace("\\", "/")).stem.lower() == basename]
        cycle_path = cycle_match[0]["path"] if len(cycle_match) == 1 else None
        lights = []
        collect_lights(item.get("GlobalSpecialFX"), lights)
        referenced_by = [{
            "entity": label,
            "pickupTypeRefId": entity["refId"],
            "level": level,
            "slot": slot,
            "itemIndex": item_index,
            "jsonPath": chosen["jsonPath"],
            "location": item["SpecialFXLocation"]["label"],
            "durationIntro": item.get("DurationIntro"),
            "durationLoop": item.get("DurationLoop"),
            "durationOutro": item.get("DurationOutro"),
            "slotModelList": [m["path"] for m in models],
        }]
        batch.append((slug, role, referenced_by, chosen["path"], cycle_path, lights))

    for slug, role, referenced_by, model_path, cycle_path, lights in batch:
        assets.append(build_asset(slug, role, referenced_by, model_path, cycle_path,
                                  lights, out))

    placements = placement_hover()
    assets_by_slug = {asset["slug"]: asset for asset in assets}
    transform = transform_block(entities, placements, assets_by_slug)

    catalog = {
        "kind": "art1-pickup-weapon-asset-inventory",
        "version": 1,
        "generatedBy": "probes/art/tools/build_pickups.py",
        "sources": {
            "models": "game-data/Blur/cache/root.pak (codec 4 packet zlib)",
            "definitions": "game-data/Blur/cache/gamedata.pak \\gamedata\\xt\\pickups.bin (codec 2 zlib)",
            "placements": ["_work/powerups/placements.json",
                           "_work/powerups/placements-amboy.json",
                           "_work/powerups/placements-gracia.json"],
        },
        "pickupBase": {
            "status": "absent-from-data",
            "reason": "there is no separate pickup base/crate mesh: every spawn visual is "
                      "a single AnimatedMeshSpecialFX icon model selected by "
                      "PickupType.PickupSpecialFX; the icon models are one- or two-quad "
                      "billboards with no base element",
            "searchedEntries": 3388,
            "searchedPatterns": ["crate", "pickupbase", "pickup_base", "base_pickup", "perkbase"],
        },
        "entities": {label: {
            "pickupTypeRefId": entity["refId"],
            "pickupTypeRecord": entity["record"],
            "spawnIcon": SPAWN_SLUGS[label],
            "model": entity["mesh"]["model"],
            "cycle": entity["mesh"]["cycle"],
            "lightOffset": entity["light"]["light"]["offset"] if entity["light"] else None,
            "cycleBegin": entity["cycleBegin"],
            "cycleEnd": entity["cycleEnd"],
            "levels": entity["levelNames"],
            "multiplayerClass": label in MP_LABELS,
        } for label, entity in entities.items()},
        "assets": [dict(asset, mdlDat={"modelCount": asset["mdlDat"]["modelCount"],
                                       "elementCount": asset["mdlDat"]["elementCount"]})
                   for asset in assets],
        "transform": transform,
        "citations": citation_block(),
        "limits": [
            "scene reader exposes only the first render list (resource block 0, LOD0), "
            "object-local; later render lists and node transforms are not imported",
            "albedo bindings are diagnostic-only for these FX models because the material "
            "list is dynamic; texture names come from the scene's shared-texture table",
            "the .cycle animation container has no reader; rotation/bob inside the cycle "
            "is not decoded",
        ],
    }
    U.write_json(out / "index.json", catalog)
    U.write_json(out / "transform.json", transform)

    print(f"assets={len(assets)} entities={len(entities)} out={out}")
    for asset in assets:
        c = asset["counts"]
        print(f"  {asset['slug']:30s} v={c['vertexCount']:5d} t={c['triangleCount']:5d} "
              f"draws={c['drawCount']:2d} tex={c['textureCount']} "
              f"decoded={c['texturesDecoded']}")


if __name__ == "__main__":
    main()
