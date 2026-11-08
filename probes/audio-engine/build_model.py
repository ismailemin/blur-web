"""Build the per-car retail engine mapping for the browser mixer.

Reads (never writes) the committed retail evidence:

  * `_work/e1-drive/cars.json` and `_work/e1-drive/cars/<slug>.fields`
    (the five integrated `RP_CarDynamics` records);
  * `game-data/Blur/cache/gamedata.pak` `\\gamedata\\xt\\amax.bin`
    (`AmaxVehicle.vehicleAudioEntity`, `AudioEngineType`, ...);
  * `_work/audio/audio.bin` (`AudioEntityProxy` -> `AudioEntityDef` ref);
  * `_work/audio/audio-catalog.json` (entity names, banks, decoded graphs);
  * `_work/audio/catalog/graphs/<entity>_engine.dat` (AOBJ graph copies).

Writes only:

  * `_work/audio-engine/engine-mapping.json` (full provenance/evidence);
  * `probes/audio-engine/engine-models.mjs` (the frozen table the mixer uses).

The mapping is record-derived, never name-similarity.  If an `AmaxVehicle`
does not resolve through `vehicleAudioEntity`, or the entity has no decoded
engine graph, the car is emitted with `status:"unsupported"` and an explicit
reason; no bank is substituted.
"""
from __future__ import annotations

import hashlib
import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
HARNESS = ROOT / "engine/harness/t005d-vehicle"
for path in (TOOLS, HARNESS, ROOT / "probes/vehicle-pipeline/tools",
             ROOT / "probes/race-rules/tools", ROOT / "probes/audio"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import car_xt  # noqa: E402
import inspect_dat  # noqa: E402
import xt_decode  # noqa: E402
import audit_c_aliases as amax_tool  # noqa: E402

OUT = ROOT / "_work/audio-engine"
LOGS = ROOT / "_work/logs/audio-engine"
MODULE = ROOT / "probes/audio-engine/engine-models.mjs"
CARS = ROOT / "_work/e1-drive/cars.json"
AUDIO_CATALOG = ROOT / "_work/audio/audio-catalog.json"
AUDIO_BIN = ROOT / "_work/audio/audio.bin"
GRAPH_DIR = ROOT / "_work/audio/catalog/graphs"

# The five integrated E1 cars (probes/e1-drive/cars/roster.json).
INTEGRATED = [
    "corvette-zr1-stock",
    "lotus-exige-cup260-stock",
    "dodge-challenger-stock",
    "ford-focusrs-stock",
    "audi-r8v10-stock",
]

RPM_X = 0.0001  # BaseMessageHandler.cpp:1940 / :1970
SOUND_SPEED = 343.0


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def parse_fields(path: Path) -> dict[str, float]:
    """Decode a T-005d .fields file (`name<TAB>hex-bits`)."""
    values: dict[str, float] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or "\t" not in line:
            continue
        key, raw = line.split("\t", 1)
        raw = raw.strip()
        if len(raw) == 8:
            # T-005d .fields prints the serialized big-endian bit pattern as
            # text (e.g. 44480000 is 800.0f), not little-endian file bytes.
            values[key] = struct.unpack(">f", bytes.fromhex(raw))[0]
        elif re.fullmatch(r"-?\d+", raw):
            values[key] = float(raw)
    return values


def load_amax() -> dict:
    """AmaxVehicle rows with audio fields and the resolved proxy -> entity name.

    `audit_c_aliases.load_amax` already proves dynamics handles; this extends the
    same rows with the audio handle and the scalar audio parameters.
    """
    xt, data = amax_tool.load_xt(amax_tool.AMAX_BIN, amax_tool.AMAX_PATH)
    type_index = next(t["index"] for t in xt["types"] if t["name"] == "AmaxVehicle")
    leaves = {leaf["name"]: leaf for leaf in car_xt.leaves(xt, type_index)}
    refs_table = xt["tables"]["refs"]
    refs = [struct.unpack_from("<I2H", data, refs_table["offset"] + i * refs_table["units"])
            for i in range(refs_table["count"])]
    records = {r["id"]: r for r in xt["records"] if r["id"] != 0xFFFFFFFF}

    def raw(rec: dict, field: str, size: int = 4) -> int:
        code = {1: "B", 2: "H", 4: "I"}[size]
        return struct.unpack_from("<" + code, data, rec["dataOffset"] + leaves[field]["offset"])[0]

    def f32(rec: dict, field: str) -> float:
        return struct.unpack_from("<f", data, rec["dataOffset"] + leaves[field]["offset"])[0]

    def handle(rec: dict, field: str) -> int | None:
        value = raw(rec, field)
        return None if value == 0xFFFFFFFF else value

    def resolve(handle_index: int | None) -> dict | None:
        if handle_index is None or handle_index >= len(refs):
            return None
        ref_id, type_id, record_index = refs[handle_index]
        return {
            "refIndex": handle_index,
            "refId": ref_id,
            "typeId": type_id,
            "typeName": xt["types"][type_id]["name"] if type_id < len(xt["types"]) else None,
            "recordIndex": None if record_index == 0xFFFF else record_index,
        }

    rows = []
    for rec in xt["records"]:
        if rec["type"] != type_index:
            continue
        dynamics = resolve(handle(rec, "dynamics"))
        rows.append({
            "tag": amax_tool._record_name(xt, data, rec),
            "recordId": rec["id"],
            "use": bool(raw(rec, "use", 1)),
            "dynamics": dynamics,
            "audioProxy": resolve(handle(rec, "vehicleAudioEntity")),
            "aiAudioProxy": resolve(handle(rec, "aiVehicleAudioEntity")),
            "audioRpmLimit": f32(rec, "AudioRPMLimit"),
            "audioGarageId": f32(rec, "AudioGarageID"),
            "audioForcedInduction": bool(raw(rec, "AudioForcedInduction", 1)),
            "audioEngineType": f32(rec, "AudioEngineType"),
            "audioExhaustType": f32(rec, "AudioExhaustType"),
        })
    return {
        "rows": rows,
        "sha256": sha256_bytes(data),
        "bytes": len(data),
    }


def proxy_to_entity() -> dict[int, dict]:
    """Resolve `audio.bin` AudioEntityProxy records to AudioEntityDef ids.

    `AudioEntityProxy` payload is the ref index in `audio.bin`; the ref target
    is the `AudioEntityDef` record id (`audioentities.bin`).  The 228 entity
    names/objects come from the committed audio catalog.
    """
    flask = xt_decode.Flask(AUDIO_BIN.read_bytes())
    catalog = json.loads(AUDIO_CATALOG.read_text(encoding="utf-8"))
    entities = {row["refId"]: row for row in catalog["entities"]}
    proxies: dict[int, dict] = {}
    for i in range(len(flask.records)):
        if flask.type_name(flask.record_type(i)) != "AudioEntityProxy":
            continue
        proxy_id = flask.record_id(i)
        payload = flask.record_payload(i)
        ref_index = struct.unpack_from("<I", payload, 0)[0]
        if ref_index >= len(flask.refs):
            proxies[proxy_id] = {"proxyId": proxy_id, "refIndex": ref_index, "entity": None}
            continue
        ref_id, ref_type, _ = flask.refs[ref_index]
        entity = entities.get(ref_id)
        proxies[proxy_id] = {
            "proxyId": proxy_id,
            "refIndex": ref_index,
            "refId": ref_id,
            "refType": flask.type_name(ref_type),
            "entity": entity,
        }
    return proxies


def graph_for_entity(entity: dict) -> dict | None:
    for obj in entity.get("objects", []):
        name = obj.get("file") or ""
        if name.lower().endswith("_engine.dat"):
            return {"file": name, "objectRefId": obj.get("refId")}
    return None


def parse_graph(path: Path) -> dict:
    data = path.read_bytes()
    obj = inspect_dat.Object(data)
    curves = {}
    for component in obj.components:
        curve = obj.read_curve(component["index"])
        if curve:
            curves[curve["name"]] = curve
    sounds = {}
    for component in obj.components:
        info = obj.sound_info(component["index"])
        if info:
            sounds[info["name"]] = info
    controls = {}
    for name, curve in curves.items():
        component = next(c for c in obj.components if c["name"] == name)
        com = inspect_dat.i16(data, component["dataOffset"] + 4)
        target = obj.components[com] if 0 <= com < len(obj.components) else None
        controls[name] = {
            "com": com,
            "component": target["name"] if target else None,
            "type": target["typeName"] if target else None,
        }
    return {
        "object": obj.name,
        "components": len(obj.components),
        "declaredComponents": obj.num_components,
        "walkError": obj.walk_error,
        "curves": curves,
        "sounds": sounds,
        "controls": controls,
        "sha256": sha256_bytes(data),
        "bytes": len(data),
    }


def numeric_wave_label(wave: str) -> int | None:
    match = re.search(r"_(\d{3,5})$", wave)
    return int(match.group(1)) if match else None


def pitch_label(points: list[list[float]]) -> float | None:
    """EngineNPitch ends at 2.0 at x = 2 * rpmLabel / 10000."""
    for x, y in reversed(points):
        if abs(y - 2.0) < 1e-4:
            return round(x * 5000.0, 3)
    return None


def cylinder_count(entity_name: str) -> tuple[int | None, str]:
    match = re.search(r"_V(\d+)$", entity_name, re.IGNORECASE)
    if match:
        return int(match.group(1)), f"audio entity name {entity_name!r}"
    match = re.search(r"_i(\d+)$", entity_name, re.IGNORECASE)
    if match:
        return int(match.group(1)), f"audio entity name {entity_name!r}"
    return None, f"audio entity name {entity_name!r} has no cylinder token"


def build_car(slug: str, roster: dict, amax: dict, proxies: dict,
              catalog: dict, graph_cache: dict) -> dict:
    row = next((c for c in roster if c["slug"] == slug), None)
    if row is None:
        return {"slug": slug, "status": "unsupported", "reason": "not in e1 roster"}

    fields_path = ROOT / row["fields"]["path"]
    fields = parse_fields(fields_path)
    record_id = row["record"]["id"]
    vehicles = [v for v in amax["rows"]
                if v["use"] and v["dynamics"] and v["dynamics"]["refId"] == record_id]
    if not vehicles:
        return {
            "slug": slug, "status": "unsupported",
            "reason": f"no used AmaxVehicle.dynamics handle resolves to record {record_id}",
            "record": row["record"],
        }
    # Prefer the base vehicle whose tag equals the record name; otherwise the
    # first used vehicle with the exact dynamics handle is the shipped actor.
    vehicle = next((v for v in vehicles if v["tag"] == row["name"]), vehicles[0])
    proxy = proxies.get((vehicle["audioProxy"] or {}).get("refId"))
    if not proxy or not proxy.get("entity"):
        return {
            "slug": slug, "status": "unsupported",
            "reason": "vehicleAudioEntity proxy does not resolve to an AudioEntityDef",
            "record": row["record"], "amaxTag": vehicle["tag"],
            "audioProxy": vehicle["audioProxy"],
        }
    entity = proxy["entity"]
    graph_ref = graph_for_entity(entity)
    if not graph_ref:
        return {
            "slug": slug, "status": "unsupported",
            "reason": f"audio entity {entity['name']!r} has no *_engine.dat object",
            "record": row["record"], "amaxTag": vehicle["tag"],
            "audioEntity": entity["name"],
        }
    graph_path = GRAPH_DIR / graph_ref["file"].lower()
    if not graph_path.exists():
        return {
            "slug": slug, "status": "unsupported",
            "reason": f"decoded graph {graph_ref['file']} is absent under _work/audio/catalog/graphs",
            "record": row["record"], "amaxTag": vehicle["tag"],
            "audioEntity": entity["name"],
        }
    graph = graph_cache.get(graph_path.name)
    if graph is None:
        graph = parse_graph(graph_path)
        graph_cache[graph_path.name] = graph

    bank = next((b for b in catalog["banks"].values()
                 if b.get("bankName", "").lower() == entity["name"].lower()), None)
    if bank is None:
        # The entity name and bank name can differ; use the graph's sound bank.
        first_sound = next((s for s in graph["sounds"].values()), None)
        bank_name = first_sound["bank"] if first_sound else entity["name"]
        bank = next((b for b in catalog["banks"].values()
                     if b.get("bankName", "").lower() == str(bank_name).lower()), None)

    loops = []
    decel = []
    warnings = []
    for slot in range(0, 12):
        sound_name = f"Engine{slot}Sound"
        vol_name = f"Engine{slot}Volume"
        pitch_name = f"Engine{slot}Pitch"
        if sound_name not in graph["sounds"]:
            continue
        sound = graph["sounds"][sound_name]
        wave = sound["wave"]
        vol = graph["curves"].get(vol_name)
        pitch = graph["curves"].get(pitch_name)
        if not vol or not pitch:
            warnings.append(f"{sound_name}: missing {vol_name}/{pitch_name}")
            continue
        vol_ctrl = graph["controls"].get(vol_name, {})
        pitch_ctrl = graph["controls"].get(pitch_name, {})
        wave_label = numeric_wave_label(wave)
        curve_label = pitch_label(pitch["points"])
        label = wave_label if wave_label and wave_label >= 500 else curve_label
        label_source = "wave-name" if label is wave_label else "pitch-curve-endpoint"
        if wave_label and curve_label and abs(wave_label - curve_label) > max(2.0, wave_label * 0.01):
            warnings.append(
                f"{wave}: wave label {wave_label} vs pitch label {curve_label:.1f}")
        entry = {
            "slot": slot,
            "sound": sound_name,
            "wave": wave,
            "bank": sound["bank"],
            "rpmLabel": round(label, 3) if label is not None else None,
            "labelSource": label_source,
            "waveLabel": wave_label,
            "curveLabel": curve_label,
            "volumeCurve": vol["points"],
            "pitchCurve": pitch["points"],
            "volumeControl": vol_ctrl,
            "pitchControl": pitch_ctrl,
        }
        is_decel = "decel" in wave.lower()
        if is_decel:
            entry["playable"] = False
            entry["reason"] = "decel layer is gated by clutch/throttle, not RPM; excluded from the RPM-only mixer"
            decel.append(entry)
            continue
        if vol_ctrl.get("component") != "RPMInput":
            entry["playable"] = False
            entry["reason"] = f"volume control is {vol_ctrl.get('component')!r}, not RPMInput"
            warnings.append(f"{vol_name}: control {vol_ctrl.get('component')!r} is not RPMInput")
            decel.append(entry)
            continue
        if pitch_ctrl.get("component") != "RPMInput":
            entry["playable"] = False
            entry["reason"] = f"pitch control is {pitch_ctrl.get('component')!r}, not RPMInput"
            warnings.append(f"{pitch_name}: control {pitch_ctrl.get('component')!r} is not RPMInput")
            decel.append(entry)
            continue
        if all(abs(y) < 1e-9 for _x, y in vol["points"]):
            entry["playable"] = False
            entry["reason"] = "volume curve is flat zero in this graph"
            decel.append(entry)
            continue
        entry["playable"] = True
        loops.append(entry)

    cylinders, cylinder_source = cylinder_count(entity["name"])
    gear_count = int(row["values"]["gears"])
    torque_points = row["values"]["torqueCurve"]
    x0 = fields.get("engine.engineTorque_Rpm.x0", 0.0)
    x1 = fields.get("engine.engineTorque_Rpm.x1", row["values"]["limiterRPM"])
    y_scale = fields.get("engine.engineTorque_Rpm.yScale", row["values"].get("torqueScaleNm", 0.0))
    torque = []
    for index, fraction in enumerate(torque_points):
        rpm = x0 if len(torque_points) == 1 else x0 + (x1 - x0) * index / (len(torque_points) - 1)
        torque.append({"rpm": round(rpm, 3), "fraction": round(float(fraction), 6),
                       "torqueNm": round(float(fraction) * y_scale, 3)})
    idle = fields.get("engine.idleRPM")
    limiter = fields.get("engine.limiterRPM", row["values"]["limiterRPM"])
    car = {
        "slug": slug,
        "status": "mapped" if loops else "unsupported",
        "reason": None if loops else "graph has no RPM-controlled engine loop",
        "name": row["name"],
        "record": row["record"],
        "amaxTag": vehicle["tag"],
        "amaxRecordId": vehicle["recordId"],
        "audioEntity": entity["name"],
        "audioEntityRefId": entity["refId"],
        "audioProxyId": proxy["proxyId"],
        "audioProxyRefIndex": proxy["refIndex"],
        "engineGraph": graph_ref["file"],
        "engineGraphSha256": graph["sha256"],
        "engineGraphBytes": graph["bytes"],
        "engineGraphParsedComponents": graph["components"],
        "engineGraphDeclaredComponents": graph["declaredComponents"],
        "engineGraphWalkError": graph["walkError"],
        "bank": bank["bankName"] if bank else None,
        "bankAsset": bank["asset"] if bank else None,
        "bankSha256": bank.get("bankSha256") if bank else None,
        "cylinderCount": cylinders,
        "cylinderSource": cylinder_source,
        "idleRpm": round(idle, 3) if idle is not None else None,
        "limiterRpm": round(limiter, 3),
        "audioRpmLimit": round(vehicle["audioRpmLimit"], 6),
        "audioGarageId": round(vehicle["audioGarageId"], 6),
        "audioForcedInduction": vehicle["audioForcedInduction"],
        "audioEngineType": round(vehicle["audioEngineType"], 6),
        "audioExhaustType": round(vehicle["audioExhaustType"], 6),
        "gearCount": gear_count,
        "gearRatios": [round(float(v), 6) for v in row["values"]["gearRatios"]],
        "finalRatio": round(float(row["values"]["finalRatio"]), 6),
        "torqueScaleNm": round(float(y_scale), 3),
        "torqueCurve": torque,
        "loops": loops,
        "excludedLayers": decel,
        "warnings": warnings,
    }
    if idle is None:
        car["warnings"].append("engine.idleRPM was absent from the .fields record")
    if cylinders is None:
        car["warnings"].append("cylinder count is not present in RP_CarDynamics; no audio token either")
    return car


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    roster_doc = json.loads(CARS.read_text(encoding="utf-8"))
    roster = roster_doc["roster"]["cars"]
    catalog = json.loads(AUDIO_CATALOG.read_text(encoding="utf-8"))
    amax = load_amax()
    proxies = proxy_to_entity()
    graph_cache: dict[str, dict] = {}
    cars = {}
    for slug in INTEGRATED:
        cars[slug] = build_car(slug, roster, amax, proxies, catalog, graph_cache)

    document = {
        "kind": "audio-engine.engine-mapping",
        "version": 1,
        "generatedBy": "probes/audio-engine/build_model.py",
        "note": "Record-derived mapping. No name-similarity, no substituted bank.",
        "sources": {
            "carsJson": {"path": rel(CARS), "sha256": sha256_file(CARS)},
            "amax": {"path": "gamedata.pak:\\gamedata\\xt\\amax.bin",
                     "sha256": amax["sha256"], "bytes": amax["bytes"]},
            "audioBin": {"path": rel(AUDIO_BIN), "sha256": sha256_file(AUDIO_BIN)},
            "audioCatalog": {"path": rel(AUDIO_CATALOG), "sha256": sha256_file(AUDIO_CATALOG)},
        },
        "rpmParameter": {
            "name": "RPMInput",
            "domain": "x = Engine().RPM() * 0.0001",
            "source": [
                "upstream/BlurRebuilt/code/amax/game/Game/GameActors/Components/AudioMessageHandlers/BaseMessageHandler.cpp:1940",
                "upstream/BlurRebuilt/code/amax/game/Game/GameActors/Components/AudioMessageHandlers/BaseMessageHandler.cpp:1970",
            ],
        },
        "audioFields": {
            "source": "upstream/BlurRebuilt/code/amax/game/GameLogic/GameData/GameVehicleData.cpp:131-135",
            "fields": ["AudioRPMLimit", "AudioGarageID", "AudioForcedInduction",
                       "AudioEngineType", "AudioExhaustType"],
        },
        "cars": cars,
    }
    (OUT / "engine-mapping.json").write_text(
        json.dumps(document, indent=2) + "\n", encoding="utf-8")

    # The shipped module table is generated, not hand-edited.
    module = {
        "generatedBy": document["generatedBy"],
        "kind": document["kind"],
        "rpmX": RPM_X,
        "cars": {
            slug: {
                "slug": car["slug"],
                "status": car["status"],
                "name": car.get("name"),
                "audioEntity": car.get("audioEntity"),
                "engineGraph": car.get("engineGraph"),
                "bank": car.get("bank"),
                "cylinderCount": car.get("cylinderCount"),
                "idleRpm": car.get("idleRpm"),
                "limiterRpm": car.get("limiterRpm"),
                "gearCount": car.get("gearCount"),
                "torqueScaleNm": car.get("torqueScaleNm"),
                "torqueCurve": car.get("torqueCurve"),
                "loops": car.get("loops", []),
                "excludedLayers": car.get("excludedLayers", []),
                "warnings": car.get("warnings", []),
            }
            for slug, car in cars.items()
        },
        "provenance": {
            "carsJsonSha256": document["sources"]["carsJson"]["sha256"],
            "amaxSha256": document["sources"]["amax"]["sha256"],
            "audioBinSha256": document["sources"]["audioBin"]["sha256"],
            "audioCatalogSha256": document["sources"]["audioCatalog"]["sha256"],
        },
    }
    text = (
        "// GENERATED by probes/audio-engine/build_model.py — do not hand-edit.\n"
        "// Record-derived retail engine mapping; no audio samples are embedded.\n"
        "export const ENGINE_MODEL_PROVENANCE = Object.freeze("
        + json.dumps(module["provenance"], indent=2) + ");\n\n"
        "export const ENGINE_MODELS = Object.freeze("
        + json.dumps(module["cars"], indent=2) + ");\n"
    )
    MODULE.write_text(text, encoding="utf-8")

    print(f"amax {amax['bytes']} B sha256 {amax['sha256']}")
    for slug, car in cars.items():
        loops = car.get("loops", [])
        print(f"{slug:28s} {car['status']:11s} entity={car.get('audioEntity')} "
              f"graph={car.get('engineGraph')} loops={len(loops)} "
              f"idle={car.get('idleRpm')} limiter={car.get('limiterRpm')} "
              f"cyl={car.get('cylinderCount')}")
    print(f"wrote {OUT / 'engine-mapping.json'} ({sha256_file(OUT / 'engine-mapping.json')})")
    print(f"wrote {MODULE} ({sha256_file(MODULE)})")


if __name__ == "__main__":
    main()
