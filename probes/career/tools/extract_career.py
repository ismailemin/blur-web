"""Build the machine-readable Blur career manifest from retail data.

Read-only: opens `game-data/Blur/cache/gamedata.pak`, decodes the entries with
the committed bounded XT reader, resolves route/vehicle/localisation references
through `amax.bin` and the shipped `.loc` tables, and writes
`_work/career/career.json` plus `_work/career/hashes.json`.

Nothing is guessed. Every event carries the source record index, record id and
payload offset, the handle field offsets, and the resolved reference ids. Values
that are not present in the data are emitted as `null` with a typed reason.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import zlib
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "loc" / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "career" / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402
import olt  # noqa: E402
from xt_decode import Flask  # noqa: E402

PAK = ROOT / "game-data" / "Blur" / "cache" / "gamedata.pak"
SP_PATH = "\\gamedata\\xt\\singleplayer.bin"
AMAX_PATH = "\\gamedata\\xt\\amax.bin"
SP_LOC = "\\gamedata\\xt\\loc\\singleplayer.loc"
CRN_LOC = "\\gamedata\\xt\\loc\\cityandroutenames.loc"

MODE_IDS = {
    "AmaxRaceModeStreetRace": "street-race",
    "AmaxRaceModeDestruction": "destruction",
    "AmaxRaceModeCheckpoint": "checkpoint",
    "AmaxRaceModeBossBattle": "boss-battle",
    "AmaxRaceModeFanDemand": "fan-demand",
}
KIND_IDS = {
    "SP_RaceEvent": "race",
    "SP_FanEvent": "fan",
    "SP_DestructionEvent": "destruction",
    "SP_CheckpointEvent": "checkpoint",
    "SP_BossEvent": "boss",
}
DEMAND_UNITS = {
    "SP_BossDemand_Tier_Earn_Fans": "fans",
    "SP_BossDemand_Tier_Use_Powerups": "powerup-uses",
    "SP_BossDemand_Tier_Finish_In_Different_Car": "distinct-cars",
    "SP_BossDemand_Tier_Finish_Events": "events",
    "SP_BossDemand_Tier_Shield_Powerups": "shield-uses",
    "SP_BossDemand_Tier_Evade_Full_Shocks": "full-shocks-evaded",
    "SP_BossDemand_Tier_Collect_Stopwatches": "stopwatches",
    "SP_BossDemand_Event_Time_Remaining": "seconds",
    "SP_BossDemand_Tier_Complete_FanDemands": "fan-demands",
    "SP_BossDemand_Tier_Complete_FanRuns": "fan-runs",
    "SP_BossDemand_Tier_Complete_FanPars": "fan-pars",
    "SP_BossDemand_Event_Get_5X_Combo": "combo",
    "SP_BossDemand_Tier_Ram_Into_Sea": "cars",
    "SP_BossDemand_Tier_Wreck": "wrecks",
    "SP_BossDemand_Tier_Barge_Hits": "barge-hits",
    "SP_BossDemand_Event_Get_All_Lights": "lights",
    "SP_BossDemand_Tier_Shunt_Hits": "shunt-hits",
    "SP_BossDemand_Tier_Multiple_Barge_Hits": "multi-barge-hits",
    "SP_BossDemand_Tier_Shock_Opponents": "opponents-shocked",
    "SP_BossDemand_Event_Complete_FanRun": "fan-run",
    "SP_BossDemand_Tier_Drift": "drift-score",
    "SP_BossDemand_Tier_Use_Weapon_Defence": "weapon-defences",
    "SP_BossDemand_Tier_Clean_Triple_Nitros": "triple-nitros",
    "SP_BossDemand_Tier_Get_Lights": "lights",
    "SP_BossDemand_Tier_Forward_Mine_Hits": "forward-mine-hits",
    "SP_BossDemand_Tier_Nitro_Ram": "nitro-rams",
    "SP_BossDemand_Tier_Destruction_Bonus_Hits": "destruction-bonus-hits",
    "SP_BossDemand_Event_Wreck_And_Win": "cars-and-win",
    "SP_BossDemand_Tier_Shield_Mines": "shield-mines",
    "SP_BossDemand_Tier_3_Bolt_Hits": "bolt-hits",
    "SP_BossDemand_Tier_Mine_Hits": "mine-hits",
    "SP_BossDemand_Event_Finish_Without_SorR": "events-without-repair-or-respawn",
    "SP_BossDemand_Event_Finish_In_Nats_BMW": "events-in-vehicle",
    "SP_BossDemand_Tier_Reach_Speed": "speed-threshold",
    "SP_BossDemand_Tier_Reverse_Bolt_Hits": "reverse-bolt-hits",
    "SP_BossDemand_Tier_Win_All_Events": "events-won",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def read_entry(index: dict, path: str) -> tuple[bytes, dict]:
    row = next((r for r in index["entries"] if r["path"].lower() == path.lower()), None)
    if row is None or row.get("directory"):
        raise SystemExit(f"missing pak entry: {path}")
    with PAK.open("rb") as stream:
        stream.seek(row["offset"])
        packed = stream.read(row["stored_bytes"])
    data = zlib.decompress(packed)
    if len(data) != row["logical_bytes"]:
        raise SystemExit(f"{path}: decoded {len(data)} != logical {row['logical_bytes']}")
    info = {
        "path": row["path"],
        "offset": row["offset"],
        "storedBytes": row["stored_bytes"],
        "logicalBytes": row["logical_bytes"],
        "sha256": sha256_bytes(data),
    }
    return data, info


def loc_string(loc, loc_id: str | None):
    if not loc_id:
        return None, "no loc id"
    lid = int(loc_id, 16)
    if lid == 0:
        return None, "loc id 0x00000000 is the null localisation id"
    key = loc.key_by_hash.get(lid)
    if key is None:
        return None, f"loc id 0x{lid:08x} not in {loc.path}"
    value = loc.strings("en").get(key)
    if value is None:
        return None, f"loc key {key} has no en value"
    return {"key": key, "locId": f"{lid:08x}", "value": value}, None


def field_offsets(flask: Flask, type_index: int) -> dict:
    return {f["name"]: f["offset"] for f in flask.all_fields(type_index)}


def element_offset(flask: Flask, record: int, component: int, element: int, size: int) -> int:
    return flask._component_offset(record, component) + element * size


def ref_id_of(flask: Flask, ref_index: int) -> int:
    return flask.refs[ref_index][0]


def resolve_handle(flask: Flask, value):
    if not value:
        return None
    return {"refIndex": value.get("refIndex"), "refId": value.get("refId"),
            "typeName": value.get("typeName"), "unloaded": bool(value.get("unloaded"))}


def difficulty_block(flask: Flask, event_type_offset: dict, raw: dict, name: str) -> dict:
    offsets = field_offsets(flask, 79)
    return {
        "name": name,
        "timeLimitSeconds": raw.get("TimeLimit"),
        "aiBalancingFile": (raw.get("AIBalancingFileName") or {}).get("value")
        if isinstance(raw.get("AIBalancingFileName"), dict) else raw.get("AIBalancingFileName"),
        "aiRetryInterval": raw.get("AIRetryInterval"),
        "aiRetryMinTrackSpeed": raw.get("AIRetryMinTrackSpeed"),
        "damageModifier": raw.get("DamageModifier"),
        "powerUpDamageModifier": raw.get("PowerUpDamageModifier"),
        "passImmediatelyOnSuccess": raw.get("PassImmediatelyOnSuccess"),
        "failImmediately": raw.get("FailImmediately"),
        "sequentialRules": raw.get("SequentialRules"),
        "passRuleCount": raw.get("PassRules", {}).get("length"),
        "failRuleCount": raw.get("FailRules", {}).get("length"),
        "lapActionCount": raw.get("LapActions", {}).get("length"),
        "timeActionCount": raw.get("TimeActions", {}).get("length"),
        "aiPerkUseCount": raw.get("AIPerkUse", {}).get("length"),
        "provenance": {"fieldOffset": event_type_offset[name], "structBytes": 92},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(ROOT / "_work" / "career" / "career.json"))
    args = parser.parse_args()

    index = pak_index(PAK)
    sp_bytes, sp_info = read_entry(index, SP_PATH)
    amax_bytes, amax_info = read_entry(index, AMAX_PATH)
    sp_loc_bytes, sp_loc_info = read_entry(index, SP_LOC)
    crn_loc_bytes, crn_loc_info = read_entry(index, CRN_LOC)

    sp = Flask(sp_bytes)
    amax = Flask(amax_bytes)
    sp_loc = olt.read_olt(sp_loc_bytes, "singleplayer.loc")
    crn_loc = olt.read_olt(crn_loc_bytes, "cityandroutenames.loc")

    # --- amax indexes -----------------------------------------------------
    amax_routes = {}
    amax_vehicles = {}
    for i, rec in enumerate(amax.records):
        name = amax.type_name(amax.record_type(i))
        if name == "Route":
            d = amax.decode_record(i)
            city = d.get("City") or {}
            city_value = city.get("value") or {}
            amax_routes[amax.record_id(i)] = {
                "recordIndex": i,
                "recordId": amax.record_id(i),
                "dataOffset": amax._data_base + amax._data_start[i],
                "name": (d.get("Name") or {}).get("value"),
                "loc": d.get("LocString"),
                "routeNumber": d.get("RouteNumber"),
                "cityId": city.get("refId"),
                "cityName": (city_value.get("Name") or {}).get("value"),
                "cityLoc": city_value.get("LocString"),
                "circuitType": (d.get("CircuitType") or {}).get("label")
                if isinstance(d.get("CircuitType"), dict) else None,
                "onlyAllowSingleLap": d.get("OnlyAllowSingleLap"),
            }
        elif name == "AmaxVehicle":
            d = amax.decode_record(i)
            amax_vehicles[amax.record_id(i)] = {
                "recordIndex": i,
                "recordId": amax.record_id(i),
                "dataOffset": amax._data_base + amax._data_start[i],
                "name": (d.get("Name") or {}).get("value"),
                "class": (d.get("class") or {}).get("label") if isinstance(d.get("class"), dict) else d.get("class"),
                "use": d.get("use"),
                "locked": d.get("Locked"),
            }

    # --- singlesplayer schema --------------------------------------------
    sp_event_offsets = field_offsets(sp, 23)
    amax_event_offsets = field_offsets(sp, 1)
    boss_offsets = field_offsets(sp, 30)
    opponent_offsets = field_offsets(sp, 11)
    checkpoint_offsets = field_offsets(sp, 85)

    tree_index = None
    for i, rec in enumerate(sp.records):
        if sp.type_name(sp.record_type(i)) == "SP_TierData":
            tree_index = i
            break
    if tree_index is None:
        raise SystemExit("SP_TierData record not found")
    tree = sp.decode_record(tree_index)
    tree_record_id = sp.record_id(tree_index)
    tree_data_offset = sp._data_base + sp._data_start[tree_index]
    tree_payload = sp.record_payload(tree_index)

    tiers_component = tree["tiers"]["component"]
    bosses_component = tree["bosses"]["component"]

    # --- debug fixture dump (raw bytes of every resolved record) ---------
    fixture_dir = ROOT / "_work" / "career" / "fixture"
    fixture_dir.mkdir(parents=True, exist_ok=True)
    (fixture_dir / "singleplayer.bin").write_bytes(sp_bytes)
    (fixture_dir / "singleplayer.loc").write_bytes(sp_loc_bytes)
    (fixture_dir / "cityandroutenames.loc").write_bytes(crn_loc_bytes)

    tiers_out = []
    event_counter = Counter()
    mode_counter = Counter()
    class_counter = Counter()
    level_counter = Counter()
    total_events = 0

    for tier_no, tier in enumerate(tree["tiers"]["items"]):
        tier_id = tier["id"]
        tier_name, tier_name_reason = loc_string(sp_loc, tier["name"].get("id"))
        tier_events = []

        for event_no, sp_event in enumerate(tier["events"]["items"]):
            amax_handle = sp_event["event"]
            amax_event = amax_handle["value"]
            if amax_event is None:
                raise SystemExit(f"{sp_event['id']}: AmaxEvent not loaded")
            amax_record = amax_handle["record"]
            amax_id = amax_handle["refId"]
            kind_label = sp_event["$type"]

            route_handle = amax_event["Route"]
            route_id = route_handle["refId"] if route_handle else None
            route = amax_routes.get(route_id)
            if route is None:
                route_out = {"id": route_id, "name": None, "city": None, "routeNumber": None,
                             "level": None, "reason": "Route record not found in amax.bin"}
            else:
                city = route["cityName"]
                level = city.lower() if city else None
                route_loc, route_loc_reason = loc_string(crn_loc, (route["loc"] or {}).get("id"))
                route_out = {
                    "id": route_id,
                    "name": route["name"],
                    "city": city,
                    "routeNumber": route["routeNumber"],
                    "level": level,
                    "levelDirectory": f"game-data/Blur/levels/{level}" if level else None,
                    "circuitType": route["circuitType"],
                    "onlyAllowSingleLap": route["onlyAllowSingleLap"],
                    "loc": route_loc,
                    "locReason": route_loc_reason,
                    "recordIndex": route["recordIndex"],
                    "dataOffset": route["dataOffset"],
                }

            mode_raw = (amax_event.get("RaceMode") or {}).get("$type")
            mode = MODE_IDS.get(mode_raw, mode_raw)
            car_class = (amax_event.get("CarClass") or {}).get("label") \
                if isinstance(amax_event.get("CarClass"), dict) else amax_event.get("CarClass")

            opponents = amax_event.get("Opponents") or {}
            setups = []
            for o in opponents.get("items", []):
                setups.append({
                    "character": resolve_handle(sp, o.get("Opponent")),
                    "vehicleOverride": resolve_handle(sp, o.get("VehicleOveride")),
                    "detailOverride": o.get("DetailOverride"),
                    "healthOverride": o.get("HealthOverride"),
                    "alwaysShields": o.get("AlwaysShields"),
                    "onlyAttacksPlayer": o.get("OnlyAttacksPlayer"),
                    "perkSlotsOverride": o.get("PerkSlotsOverride"),
                    "perkGiftTimer": o.get("PerkGiftTimer"),
                    "perkGiftTimerInitial": o.get("PerkGiftTimerInitial"),
                    "perkGiftLaps": o.get("PerkGiftLaps"),
                    "perkGiftTypeCount": (o.get("PerkGiftTypes") or {}).get("length"),
                })

            mode_config = None
            if mode_raw == "AmaxRaceModeCheckpoint":
                rm = amax_event["RaceMode"]
                mode_config = {
                    "kind": "checkpoint",
                    "initialTimeSeconds": {k: rm[k]["initialTime"] for k in ("easy", "medium", "hard")},
                    "stopwatchIncrementSeconds": {k: rm[k]["stopwatchIncTime"] for k in ("easy", "medium", "hard")},
                    "timeAwardedSeconds": {k: rm[k]["timeAwarded"]["items"] for k in ("easy", "medium", "hard")},
                    "thresholdsSeconds": {
                        k: {"bronzeRemaining": rm[k]["bronzeTimeRemaining"],
                            "silverRemaining": rm[k]["silverTimeRemaining"],
                            "goldRemaining": rm[k]["goldTimeRemaining"]}
                        for k in ("easy", "medium", "hard")
                    },
                }
            elif mode_raw == "AmaxRaceModeDestruction":
                rm = amax_event["RaceMode"]
                mode_config = {
                    "kind": "destruction",
                    "timeForWreckSeconds": {
                        "easy": rm["timeForWreckEasy"], "medium": rm["timeForWreckMedium"],
                        "hard": rm["timeForWreckHard"], "veryHard": rm["timeForWreckVHard"],
                    },
                    "behindCutOffDistance": rm["BehindCutOffDistance"],
                    "waves": [
                        {
                            "aiSlots": [w["waveAI"][f"slot{i}"]["label"] for i in (1, 2, 3, 4)],
                            "formation": w["waveFormation"]["label"],
                            "separationDistance": w["waveSeparationDistance"],
                        }
                        for w in rm["waves"]["items"]
                    ],
                    "thresholdsPoints": {
                        k: {"bronze": rm[k]["bronzePoints"], "silver": rm[k]["silverPoints"],
                            "gold": rm[k]["goldPoints"]}
                        for k in ("easy", "medium", "hard")
                    },
                    "carsUsePerks": {
                        k: {name: rm[k][f"{name}CarsUsePerks"] for name in ("Easy", "Medium", "Hard", "VHard")}
                        for k in ("easy", "medium", "hard")
                    },
                }
            elif mode_raw == "AmaxRaceModeBossBattle":
                rm = amax_event["RaceMode"]
                mode_config = {
                    "kind": "boss-battle",
                    "distanceFromMinders": rm.get("distanceFromMinders"),
                    "timeInFrontOfMinders": rm.get("timeInFrontOfMinders"),
                    "wreckMindersToWin": rm.get("wreckMindersToWin"),
                    "distanceFromBoss": rm.get("distanceFromBoss"),
                    "timeInFrontOfBoss": rm.get("timeInFrontOfBoss"),
                    "wreckBossToWin": rm.get("wreckBossToWin"),
                }

            difficulties = {}
            for name in ("Easy", "Medium", "Hard"):
                block = difficulty_block(sp, amax_event_offsets, amax_event[name], name)
                key = name.lower()
                if mode_config and mode_config["kind"] == "destruction":
                    block["thresholdsPoints"] = mode_config["thresholdsPoints"][key]
                if mode_config and mode_config["kind"] == "checkpoint":
                    block["thresholdsSeconds"] = mode_config["thresholdsSeconds"][key]
                difficulties[name] = block

            sp_event_record = None
            events_component = tier["events"]["component"]
            events_element = tier["events"]["element"]
            element_index = events_element + event_no
            sp_event_offset = element_offset(sp, tree_index, events_component,
                                             element_index, 16)
            sp_event_payload = tree_payload[sp_event_offset:sp_event_offset + 16]
            if len(sp_event_payload) != 16:
                raise SystemExit(f"{sp_event['id']}: SP_Event element outside payload")
            handle_ref_index = struct.unpack_from("<I", sp_event_payload,
                                                  sp_event_offsets["event"])[0]

            # Route handle raw index from the decoded handle (kept as evidence).
            route_ref_index = route_handle.get("refIndex") if route_handle else None
            amax_data_offset = sp._data_base + sp._data_start[amax_record]

            event_out = {
                "key": (amax_event.get("Name") or {}).get("value"),
                "eventId": sp_event["id"],
                "kind": KIND_IDS.get(kind_label, kind_label),
                "kindLabel": kind_label,
                "tierIndex": tier_no,
                "indexInTier": event_no,
                "amaxEventId": amax_id,
                "route": route_out,
                "mode": mode,
                "modeLabel": mode_raw,
                "laps": amax_event.get("Laps"),
                "carClass": car_class,
                "fanPar": sp_event.get("fanPar"),
                "carRestriction": resolve_handle(sp, sp_event.get("carRestriction")),
                "pickups": {
                    "spawnLevel": amax_event.get("PickupSpawnLevel"),
                    "doNotRespawn": amax_event.get("PickupsDoNotRespawn"),
                    "disableTimeSeconds": amax_event.get("PickupDisableTime"),
                    "aiDontGoForPickups": amax_event.get("AIDontGoForPickups"),
                    "probabilityList": resolve_handle(sp, amax_event.get("PickupProbabilities")),
                },
                "opponents": {"count": opponents.get("length"), "setups": setups},
                "difficulty": difficulties,
                "modeConfig": mode_config,
                "provenance": {
                    "spEvent": {
                        "treeDataRecordIndex": tree_index,
                        "treeDataRecordId": tree_record_id,
                        "arrayComponent": events_component,
                        "elementIndex": element_index,
                        "elementOffset": sp_event_offset,
                        "dataOffset": tree_data_offset + sp_event_offset,
                        "payloadBytes": len(sp_event_payload),
                        "fieldOffsets": sp_event_offsets,
                        "eventHandleRefIndex": handle_ref_index,
                    },
                    "amaxEvent": {
                        "recordIndex": amax_record,
                        "recordId": amax_id,
                        "dataOffset": amax_data_offset,
                        "payloadBytes": len(sp.record_payload(amax_record)),
                        "fieldOffsets": amax_event_offsets,
                        "routeHandleRefIndex": route_ref_index,
                    },
                },
            }
            tier_events.append(event_out)
            total_events += 1
            event_counter[event_out["kind"]] += 1
            mode_counter[mode] += 1
            class_counter[car_class] += 1
            level_counter[route_out.get("level")] += 1

        boss = tier["boss"]
        boss_out = None
        if boss:
            boss_name, boss_name_reason = loc_string(sp_loc, boss["name"].get("id"))
            boss_bio, boss_bio_reason = loc_string(sp_loc, boss["bio"].get("id"))
            demands = []
            for d in boss["demands"]["items"]:
                kind = d["$type"]
                extra = {}
                if "count" in d:
                    extra["target"] = d["count"]
                if "numcars" in d:
                    extra["numCars"] = d["numcars"]
                if "minspeed" in d:
                    extra["minSpeed"] = d["minspeed"]
                if "vehicle" in d:
                    veh = resolve_handle(sp, d["vehicle"])
                    extra["vehicle"] = veh
                    if veh:
                        extra["vehicleName"] = amax_vehicles.get(veh["refId"], {}).get("name")
                event_ref = d.get("event")
                demands.append({
                    "kind": kind,
                    "unit": DEMAND_UNITS.get(kind, "unknown"),
                    "target": d.get("count"),
                    "eventKey": (event_ref or {}).get("event", {}).get("value", {}).get("Name", {}).get("value")
                    if event_ref else None,
                    "eventId": (event_ref or {}).get("id") if event_ref else None,
                    **extra,
                })

            def rewards(items):
                out = []
                for r in items:
                    if r.get("$type") == "SP_VehicleReward":
                        veh = resolve_handle(sp, r.get("vehicle"))
                        out.append({
                            "kind": "vehicle",
                            "vehicleId": veh["refId"] if veh else None,
                            "vehicleName": amax_vehicles.get(veh["refId"], {}).get("name") if veh else None,
                            "vehicleClass": amax_vehicles.get(veh["refId"], {}).get("class") if veh else None,
                        })
                    elif r.get("$type") == "SP_ModReward":
                        out.append({"kind": "mod", "mod": resolve_handle(sp, r.get("mod"))})
                    else:
                        out.append({"kind": r.get("$type"), "unsupported": True})
                return out

            boss_out = {
                "id": boss["id"],
                "name": boss_name,
                "nameReason": boss_name_reason,
                "bio": boss_bio,
                "bioReason": boss_bio_reason,
                "eventKey": next((e["key"] for e in tier_events if e["kind"] == "boss"), None),
                "demands": demands,
                "rewardsForUnlock": rewards(boss["rewardsForUnlock"]["items"]),
                "rewardsForDefeat": rewards(boss["rewardsForDefeat"]["items"]),
                "provenance": {
                    "tierDataRecordIndex": tree_index,
                    "tierDataRecordId": tree_record_id,
                    "tierDataDataOffset": tree_data_offset,
                    "arrayComponent": bosses_component,
                    "elementOffset": element_offset(sp, tree_index, bosses_component, tier_no, 36),
                    "fieldOffsets": boss_offsets,
                },
            }

        max_stars = sum(7 for e in tier_events if e["kind"] != "boss") + \
            sum(8 for e in tier_events if e["kind"] == "boss")
        tiers_out.append({
            "index": tier_no,
            "id": tier_id,
            "name": tier_name,
            "nameReason": tier_name_reason,
            "starRequirement": tier["starRequirement"],
            "maxStars": max_stars,
            "eventCount": len(tier_events),
            "events": tier_events,
            "boss": boss_out,
            "provenance": {
                "tierDataRecordIndex": tree_index,
                "tierDataRecordId": tree_record_id,
                "tierDataDataOffset": tree_data_offset,
                "arrayComponent": tiers_component,
                "elementOffset": element_offset(sp, tree_index, tiers_component, tier_no, 24),
            },
        })

    # --- ranks ------------------------------------------------------------
    rank_index = None
    for i, rec in enumerate(sp.records):
        if sp.type_name(sp.record_type(i)) == "SP_RankData":
            rank_index = i
            break
    ranks_out = []
    if rank_index is not None:
        ranks = sp.decode_record(rank_index)["ranks"]
        for rank_no, rank in enumerate(ranks["items"]):
            name, name_reason = loc_string(sp_loc, rank["name"].get("id"))
            vehicles = []
            for v in rank["vehicles"]["items"]:
                veh = resolve_handle(sp, v.get("vehicle"))
                if veh:
                    meta = amax_vehicles.get(veh["refId"], {})
                    vehicles.append({"vehicleId": veh["refId"], "vehicleName": meta.get("name"),
                                     "vehicleClass": meta.get("class")})
            ranks_out.append({
                "index": rank_no,
                "fans": rank["fans"],
                "name": name,
                "nameReason": name_reason,
                "vehicles": vehicles,
                "mods": rank["mods"]["length"],
            })

    max_stars = sum(t["maxStars"] for t in tiers_out)
    vehicle_reward_ids = {v["vehicleId"] for r in ranks_out for v in r["vehicles"]}
    for t in tiers_out:
        if t["boss"]:
            for key in ("rewardsForUnlock", "rewardsForDefeat"):
                for r in t["boss"][key]:
                    if r.get("kind") == "vehicle":
                        vehicle_reward_ids.add(r["vehicleId"])

    manifest = {
        "kind": "blur.career-manifest",
        "version": 1,
        "scope": {
            "dataRecovered": True,
            "rulesImplemented": False,
            "uiImplemented": False,
            "retailParity": False,
            "note": "Retail career data from the shipped singleplayer.bin. Rules semantics "
                    "are from the shipped upstream source; no engine run is claimed.",
        },
        "source": {
            "pak": {"path": str(PAK.relative_to(ROOT)).replace("\\", "/"), "sha256": sha256_file(PAK)},
            "entries": [sp_info, amax_info, sp_loc_info, crn_loc_info],
            "decoder": "probes/career/tools/xt_decode.py (bounded PC FLSK v1/v2 reader)",
            "locReader": "probes/loc/tools/olt.py (OLTX v1)",
            "upstream": {
                "commit": "5270304b81983b9e3edbd569ba25235c17bbabd7",
                "files": ["GameLogic/SinglePlayer/SinglePlayer.h", "SP_Events.cpp",
                          "SP_Rewards.cpp", "SP_SaveGame.cpp", "SP_Tiers.cpp", "SP_Game.cpp",
                          "SP_BossDemands.cpp", "GameLogic/RaceModes/RaceModeStreetRace.cpp",
                          "GameLogic/RaceModes/RaceModeDestruction.cpp",
                          "GameLogic/RaceModes/RaceModeCheckpoint.cpp",
                          "GameLogic/RaceModes/RaceModeBossBattle.cpp"],
            },
        },
        "enums": {
            "eventKind": ["race", "fan", "destruction", "checkpoint", "boss"],
            "medal": ["incomplete", "bronze", "silver", "gold"],
            "carClass": ["A", "B", "C", "D", "E", "ANY"],
            "raceMode": ["street-race", "destruction", "checkpoint", "boss-battle", "fan-demand"],
            "bossDemandUnit": sorted(set(DEMAND_UNITS.values())),
        },
        "rules": {
            "currency": {"kind": "fans", "xp": None, "money": None,
                         "note": "SP_Lua.cpp adds results.mRaceStatistics.mFansEarned to _totalFans; "
                                 "no XP or cash field exists in the SP save game."},
            "medal": {
                "standardPosition": {"gold": 1, "silver": 2, "bronze": 3,
                                     "incomplete": "position > 3",
                                     "source": "RaceModeStreetRace.cpp SetupResults"},
                "destructionPoints": "difficulty block bronzePoints/silverPoints/goldPoints",
                "checkpointTimeRemaining": "difficulty block bronze/silver/goldTimeRemaining",
                "bossBattle": {"gold": "boss defeated", "incomplete": "otherwise",
                               "source": "RaceModeBossBattle.cpp"},
            },
            "stars": {
                "standard": {"bronze": 3, "silver": 4, "gold": 5,
                             "fanParBonus": 1, "fanRunBonus": 1, "max": 7,
                             "source": "SP_Events.cpp SP_CountTotalEventStars"},
                "boss": {"gold": 8, "max": 8},
                "maxTotal": max_stars,
            },
            "tierUnlock": {
                "condition": "totalStars >= tier.starRequirement",
                "starsCounted": "sum of stars of every event of every already-unlocked tier",
                "source": "SP_Rewards.cpp SP_ProcessUnlocks",
            },
            "eventUnlock": {
                "condition": "tierUnlocked && completedStandardEventsInTierBeforeThisIndex >= (indexInTier / 3) * 2",
                "groupSize": 3,
                "requiredPerGroup": 2,
                "source": "SP_Rewards.cpp SP_ProcessUnlocks requiredCount = (eventNo / 3) * 2",
            },
            "bossUnlock": {
                "condition": "all typed boss demands complete",
                "source": "SP_Rewards.cpp",
            },
            "bossEventUnlock": {"condition": "boss unlocked"},
            "bossRewards": {
                "unlockRewards": "boss unlocked",
                "defeatRewards": "boss event complete (all boss events in tier complete)",
            },
            "rankUnlock": {"condition": "fans >= rank.fans",
                           "source": "SP_Rank.cpp SP_FindRankByFans"},
            "initialRank": 1,
            "initialRankNote": "SP_FindRankByFans(0) returns rank 1 because rank 1 fans = 0.",
            "maxRank": len(ranks_out) - 1,
        },
        "ranks": ranks_out,
        "tiers": tiers_out,
        "summary": {
            "tierCount": len(tiers_out),
            "eventCount": total_events,
            "standardEventCount": total_events - event_counter.get("boss", 0),
            "bossEventCount": event_counter.get("boss", 0),
            "bossCount": sum(1 for t in tiers_out if t["boss"]),
            "rankCount": len(ranks_out) - 1,
            "maxStars": max_stars,
            "eventsByKind": dict(sorted(event_counter.items())),
            "eventsByMode": dict(sorted(mode_counter.items())),
            "eventsByClass": dict(sorted(class_counter.items())),
            "eventsByLevel": dict(sorted((k or "null", v) for k, v in level_counter.items())),
            "eventsByTier": [t["eventCount"] for t in tiers_out],
            "starRequirements": [t["starRequirement"] for t in tiers_out],
            "maxStarsPerTier": [t["maxStars"] for t in tiers_out],
            "vehicleRewardCount": len(vehicle_reward_ids),
            "vehicleRewardIds": sorted(vehicle_reward_ids),
        },
        "provenance": {
            "singleplayerRecordIndex": tree_index,
            "singleplayerRecordId": tree_record_id,
            "singleplayerDataOffset": tree_data_offset,
            "singleplayerTypes": len(sp.types),
            "singleplayerRecords": len(sp.records),
            "amaxRoutes": len(amax_routes),
            "amaxVehicles": len(amax_vehicles),
        },
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(manifest, indent=1, ensure_ascii=False)
    out_path.write_text(text, encoding="utf-8")
    digest = sha256_bytes(text.encode("utf-8"))

    hashes = {
        "career.json": digest,
        "source": {
            sp_info["path"]: sp_info["sha256"],
            amax_info["path"]: amax_info["sha256"],
            sp_loc_info["path"]: sp_loc_info["sha256"],
            crn_loc_info["path"]: crn_loc_info["sha256"],
        },
        "counts": manifest["summary"],
    }
    (out_path.parent / "hashes.json").write_text(
        json.dumps(hashes, indent=1, sort_keys=True), encoding="utf-8")
    print(f"wrote {out_path} ({len(text.encode('utf-8'))} bytes) sha256:{digest}")
    print(json.dumps({k: v for k, v in manifest["summary"].items()
                      if k not in ("vehicleRewardIds",)}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
