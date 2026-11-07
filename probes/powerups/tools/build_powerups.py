"""Build the power-up manifest from the shipped PC XT data (read-only).

Sources (all inside ``gamedata.pak``; the PAK itself is never modified):

  \\gamedata\\xt\\pickups.bin         pickup definitions, balance data, FX graph
  \\gamedata\\xt\\multiplayer.bin     per-race enable flags, respawn, online params
  \\gamedata\\xt\\ui.bin              HUD perk icon table
  \\gamedata\\xt\\audioentities.bin   per-perk audio entity names

The decoder is ``xt_decode.py`` (FLSK v1/v2). It follows the source-defined
serialization rules quoted in that file; this builder never guesses an offset or
a value. Every float/int in the output is read from the file.

Output: ``_work/powerups/powerups.json`` (deterministic, sorted keys).
"""
from __future__ import annotations

import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402
from xt_decode import Flask, FlaskError  # noqa: E402

GAME_DIR = ROOT / "game-data" / "Blur"
OUT_DIR = ROOT / "_work" / "powerups"
PACK = "gamedata.pak"

PICKUPS = "\\gamedata\\xt\\pickups.bin"
MULTIPLAYER = "\\gamedata\\xt\\multiplayer.bin"
UI = "\\gamedata\\xt\\ui.bin"
AUDIO = "\\gamedata\\xt\\audioentities.bin"
DYNAMIC = "\\gamedata\\xt\\dynamiceffects.bin"
SINGLE = "\\gamedata\\xt\\singleplayer.bin"
SEARCHED = ["\\gamedata\\xt\\scoring.bin"]

SLOTS = ("Normal", "DoubleTap", "Reversed", "ReversedDoubleTap", "Mini",
         "Modified", "ReversedModified")

# Runtime alias evidence. These are not serialized equalities: the file uses two
# different enums, and the alias is stated with the evidence that supports it.
ALIASES = {
    "Blindfire": {
        "multiplayer": "bolt",
        "status": "inferred-alias",
        "evidence": [
            "MpPickup flag labels are nitro,shock,barge,mine,shunt,bolt,shield,repair "
            "(multiplayer.bin) and contain no 'blindfire'.",
            "PickupTypeList flag labels are Barge,Bolt,Mine,Nitrous,Repair,Shield,Shock,Shunt "
            "(pickups.bin) and contain no 'blindfire'.",
            "The Blindfire pickup's SpecialFX assets include Bolt_Shotgun_Projectile.cycle "
            "and BoltLaserSightBeam.cycle, and no other pickup type references them.",
        ],
    },
    "Bomb": {
        "multiplayer": "mine",
        "status": "inferred-alias",
        "evidence": [
            "MpPickup contains 'mine' and no 'bomb'; PickupTypeList contains 'Mine' and no 'Bomb'.",
            "BombBalancingData carries MasterMinePrimeTimer; BombModifiedBalancingData carries "
            "NoMiniMinesToCreate and TotalSpreadWidth; SpecialFX slots are MineSpecialFX, "
            "MasterMinePrimedSpecialFX, MasterMineEquipedSpecialFX.",
            "The UI perk table names this entry 'bomb' but binds it to Flash_Icon, while the "
            "in-game HUD icon family is otherwise name-matched; the alias is therefore reported "
            "as inferred, not as a serialized equality.",
        ],
    },
}

HUD_KEY = {
    "Nitrous": ["nitrous"],
    "Shock": ["shock"],
    "Shunt": ["shunt"],
    "Barge": ["barge"],
    "Bomb": ["bomb"],
    "Blindfire": ["blindfire1", "blindfire2", "blindfire3"],
    "Repair": ["repair"],
    "Shield": ["shield"],
    "SuperShield": ["superShield"],
    "Fan": [],
    "Stopwatch": [],
}

AUDIO_PREFIX = {
    "Nitrous": ["NitrousHit"],
    "Shock": ["Shock", "ShockProjectile", "ShockHit"],
    "Shunt": ["Shunt", "ShuntProjectile", "ShuntHit"],
    "Barge": ["Barge", "BargeHit"],
    "Bomb": ["Bomb", "BombProjectile", "BombHit"],
    "Repair": ["RepairHit"],
    "Shield": ["Shield"],
    "Blindfire": ["BlindFire", "BlindFireProjectile", "BlindFireHit"],
    "SuperShield": [],
    "Fan": [],
    "Stopwatch": [],
}

MP_DIRECT = {
    "Nitrous": "nitro",
    "Shock": "shock",
    "Shunt": "shunt",
    "Barge": "barge",
    "Repair": "repair",
    "Shield": "shield",
}

ABSENT_BEHAVIOURS = [
    {
        "field": "charges",
        "status": "absent-from-schema",
        "reason": "No charge/ammo/count field exists in pickups.bin; only the HUD perk table "
                  "has blindfire1/2/3 and extra_blindfire1..4 entries.",
    },
    {
        "field": "humanTargeting",
        "status": "runtime-only",
        "reason": "Only AI trigger data (AIPickupTrigger derivations) is serialized; no human "
                  "target-selection field exists.",
    },
    {
        "field": "hitResolution",
        "status": "runtime-only",
        "reason": "Radius/outer-radius/speed/warning fields are serialized, but the hit test, "
                  "falloff and line-of-sight rules are not.",
    },
    {
        "field": "pickupRespawnNormalSeconds",
        "status": "not-serialized",
        "reason": "MpPowerupRespawn has a Normal label but only Long=5.0 s and VeryLong=20.0 s "
                  "are serialized in MultiplayerConfig.",
    },
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_hash(obj: dict) -> str:
    body = {k: v for k, v in obj.items() if k != "hashes"}
    return sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode())


def decode_pak_entry(index: dict, pak: Path, path: str) -> dict:
    entry = next((r for r in index["entries"] if r["path"].lower() == path.lower()), None)
    if entry is None:
        raise SystemExit(f"missing PAK entry {path}")
    with pak.open("rb") as stream:
        stream.seek(entry["offset"])
        stored = stream.read(entry["stored_bytes"])
    if len(stored) != entry["stored_bytes"]:
        raise SystemExit(f"short read {path}")
    if index["codec"] != 2:
        raise SystemExit("expected zlib gamedata pak")
    inflater = zlib.decompressobj()
    data = inflater.decompress(stored, entry["logical_bytes"] + 1)
    if (len(data) != entry["logical_bytes"] or not inflater.eof
            or inflater.unused_data or inflater.unconsumed_tail):
        raise SystemExit(f"zlib extent mismatch {path}")
    return {
        "pak": PACK,
        "path": entry["path"],
        "fatIndex": entry["fat_index"],
        "offset": entry["offset"],
        "storedBytes": entry["stored_bytes"],
        "logicalBytes": entry["logical_bytes"],
        "pathCrc32": entry["path_crc32"],
        "sha256Stored": sha256(stored),
        "sha256Decoded": sha256(data),
        "bytes": data,
    }


def flask_summary(flask: Flask) -> dict:
    return {
        "format": "FLSK",
        "version": flask.version,
        "endian": "little",
        "types": len(flask.types),
        "fields": len(flask.fields),
        "bases": len(flask.bases),
        "refs": len(flask.refs),
        "records": len(flask.records),
        "components": len(flask.components),
        "dataBytes": flask.tables["data"]["count"],
        "schemaStringsBytes": flask.tables["strings"]["count"],
    }


def walk(value, visit):
    if isinstance(value, dict):
        visit(value)
        for item in value.values():
            walk(item, visit)
    elif isinstance(value, list):
        for item in value:
            walk(item, visit)


def asset_strings(value) -> list[str]:
    found = set()

    def visit(node):
        if node.get("atom") == "sz8" and node.get("value"):
            found.add(node["value"])

    walk(value, visit)
    return sorted(found)


def unresolved_handles(value) -> list[dict]:
    found = []

    def visit(node):
        if node.get("unloaded"):
            found.append({"refIndex": node.get("refIndex"), "refId": node.get("refId"),
                          "typeName": node.get("typeName")})

    walk(value, visit)
    return found


def fx_summary(level: dict | None) -> dict | None:
    if not isinstance(level, dict):
        return None
    fx = level.get("SpecialFX")
    if not isinstance(fx, dict):
        return None
    arrays = []
    for name, field in fx.items():
        if name.startswith("$") or not isinstance(field, dict) or "items" not in field:
            continue
        items = field["items"]
        rows = []
        for item in items:
            if not isinstance(item, dict):
                continue
            refs = []
            for ref_name in ("LocalSpecialFX", "ExternalSpecialFX",
                             "InternalSpecialFX", "GlobalSpecialFX"):
                ref = item.get(ref_name)
                if isinstance(ref, dict) and not ref.get("unloaded"):
                    refs.append({"slot": ref_name, "record": ref.get("record"),
                                 "refId": ref.get("refId")})
            rows.append({
                "location": item.get("SpecialFXLocation"),
                "refs": refs,
                "assets": asset_strings(item),
                "durationIntro": item.get("DurationIntro"),
                "durationLoop": item.get("DurationLoop"),
                "durationOutro": item.get("DurationOutro"),
            })
        arrays.append({"slot": name, "count": field.get("length", len(items)), "items": rows})
    return {"arrays": arrays, "assetCount": len(asset_strings(fx))}


def level_summary(flask: Flask, handle: dict | None) -> dict | None:
    if not handle or not handle.get("value"):
        return None
    value = handle["value"]
    balancing = value.get("BalancingData")
    graph = value.get("BalancingGraph") or {}
    keyframes = (graph.get("EffectGraph") or {}).get("items", [])
    return {
        "record": handle.get("record"),
        "refId": handle.get("refId"),
        "balancingType": balancing.get("$type") if isinstance(balancing, dict) else None,
        "balancing": balancing,
        "balancingGraph": {
            "maxBoost": graph.get("MaxBoost"),
            "keyframes": keyframes,
        },
        "specialFx": fx_summary(value),
        "assets": asset_strings(value),
    }


def extract_hud(ui: Flask) -> dict:
    config_record = next(i for i in range(len(ui.records))
                         if ui.type_name(ui.record_type(i)) == "UiXtConfig")
    perk_type = next(i for i in range(len(ui.types)) if ui.type_name(i) == "UiPerkDisplayParameters")
    # UiXtConfig field offset of PerkDisplayParameters comes from the schema.
    config_type = ui.record_type(config_record)
    field = next(f for f in ui.type_fields(config_type) if f["name"] == "PerkDisplayParameters")
    ui._current_strings = ui.record_strings(config_record)
    entries = ui._decode_struct(config_record, perk_type, ui.record_payload(config_record),
                                field["offset"], 0, ())
    entries = {k: v for k, v in entries.items() if not k.startswith("$")}
    sheets = []
    strings = ui.record_strings(config_record)
    for sheet in (b"perk_icons", b"perk_sheet"):
        at = strings.find(sheet)
        if at >= 0:
            sheets.append({"name": sheet.decode(), "stringOffset": at})
    # Help_Powerups screen: record whose strings name PagePowerups.
    help_record = None
    for i in range(len(ui.records)):
        if b"PagePowerups" in ui.record_strings(i):
            help_record = i
            break
    help_strings = []
    if help_record is not None:
        parts = [p.decode("latin-1") for p in ui.record_strings(help_record).split(b"\0")
                 if len(p) > 2]
        help_strings = [p for p in parts if any(k in p for k in
                                                ("Powerup", "POWERUP", "Icon", "perk_sheet"))]
    return {
        "source": {"pack": PACK, "path": UI, "record": config_record,
                   "refId": ui.record_id(config_record),
                   "type": "UiXtConfig", "field": "PerkDisplayParameters",
                   "fieldOffset": field["offset"]},
        "perkEntries": entries,
        "iconSheets": sheets,
        "helpScreen": {"record": help_record,
                       "refId": ui.record_id(help_record) if help_record is not None else None,
                       "strings": help_strings},
        "provenance": "UiPerkInfo.texture_index indexes the perk icon sheet; the sheet names are "
                      "present as strings but have no typed field binding in this pack.",
    }


def extract_audio(audio: Flask) -> dict:
    rows = []
    for i in range(len(audio.records)):
        payload = audio.record_payload(i)
        offset = struct.unpack_from("<I", payload, 0)[0]
        strings = audio.record_strings(i)
        end = strings.find(b"\0", offset) if offset < len(strings) else -1
        if end < 0:
            continue
        rows.append({"name": strings[offset:end].decode("latin-1"),
                     "record": i, "refId": audio.record_id(i)})
    return {row["name"]: row for row in rows}


def extract_singleplayer(sp: Flask, id_map: dict) -> dict:
    event_type = next(i for i in range(len(sp.types)) if sp.type_name(i) == "AmaxEvent")
    fields = {f["name"]: f for f in sp.all_fields(event_type)}
    difficulty_types = {
        "Easy": fields["Easy"]["typeIndex"],
        "Medium": fields["Medium"]["typeIndex"],
        "Hard": fields["Hard"]["typeIndex"],
    }
    difficulty_offsets = {"Easy": fields["Easy"]["offset"],
                          "Medium": fields["Medium"]["offset"],
                          "Hard": fields["Hard"]["offset"]}
    power_damage_offsets = {
        name: next(f["offset"] for f in sp.type_fields(ti) if f["name"] == "PowerUpDamageModifier")
        for name, ti in difficulty_types.items()
    }
    perk_array_offsets = {
        name: next(f["offset"] for f in sp.type_fields(ti) if f["name"] == "AIPerkUse")
        for name, ti in difficulty_types.items()
    }
    opponent_offset = fields["Opponents"]["offset"]
    events = []
    gift_total = 0
    shield_total = 0
    for i in range(len(sp.records)):
        if sp.record_type(i) != event_type:
            continue
        payload = sp.record_payload(i)
        strings = sp.record_strings(i)
        name_off = struct.unpack_from("<I", payload, fields["Name"]["offset"])[0]
        end = strings.find(b"\0", name_off) if name_off < len(strings) else -1
        event_name = strings[name_off:end].decode("latin-1") if end >= 0 else None

        prob_ref = struct.unpack_from("<I", payload, fields["PickupProbabilities"]["offset"])[0]
        probability_list = None
        if prob_ref != 0xFFFFFFFF:
            ref_id, ref_type, ref_record = sp.refs[prob_ref]
            probability_list = {
                "refId": ref_id,
                "typeName": sp.type_name(ref_type),
                "record": None if ref_record == 0xFFFF else ref_record,
                "resolvesTo": id_map.get(ref_id, []),
                "external": ref_record == 0xFFFF,
            }

        difficulties = {}
        for level in ("Easy", "Medium", "Hard"):
            base = difficulty_offsets[level]
            comp, element, length = struct.unpack_from(
                "<2HI", payload, base + perk_array_offsets[level])
            difficulties[level] = {
                "powerUpDamageModifier": struct.unpack_from(
                    "<f", payload, base + power_damage_offsets[level])[0],
                "aiPerkUseCount": length,
            }

        opponents = []
        comp, element, length = struct.unpack_from("<2HI", payload, opponent_offset)
        if comp != 0xFFFF:
            prev = sp._current_strings
            sp._current_strings = strings
            try:
                for k in range(length):
                    setup = sp._component_element(i, comp, element + k, 0, ())
                    gifts = setup.get("PerkGiftTypes")
                    labels = gifts.get("labels") if isinstance(gifts, dict) else []
                    if labels:
                        gift_total += 1
                    if setup.get("AlwaysShields"):
                        shield_total += 1
                    opponents.append({
                        "alwaysShields": setup.get("AlwaysShields"),
                        "onlyAttacksPlayer": setup.get("OnlyAttacksPlayer"),
                        "healthOverride": setup.get("HealthOverride"),
                        "perkSlotsOverride": setup.get("PerkSlotsOverride"),
                        "perkGiftTimer": setup.get("PerkGiftTimer"),
                        "perkGiftTimerInitial": setup.get("PerkGiftTimerInitial"),
                        "perkGiftLaps": setup.get("PerkGiftLaps"),
                        "perkGiftTypes": labels,
                    })
            finally:
                sp._current_strings = prev

        events.append({
            "record": i,
            "refId": sp.record_id(i),
            "name": event_name,
            "index": struct.unpack_from("<i", payload, fields["Index"]["offset"])[0],
            "pickupsDoNotRespawn": bool(
                struct.unpack_from("<I", payload, fields["PickupsDoNotRespawn"]["offset"])[0]),
            "pickupSpawnLevel": struct.unpack_from(
                "<i", payload, fields["PickupSpawnLevel"]["offset"])[0],
            "pickupDisableTime": struct.unpack_from(
                "<f", payload, fields["PickupDisableTime"]["offset"])[0],
            "aiDontGoForPickups": bool(
                struct.unpack_from("<I", payload, fields["AIDontGoForPickups"]["offset"])[0]),
            "pickupProbabilityList": probability_list,
            "difficulties": difficulties,
            "opponents": opponents,
        })

    from collections import Counter
    aggregate = {
        "eventCount": len(events),
        "pickupDisableTime": {str(k): v for k, v in Counter(
            e["pickupDisableTime"] for e in events).items()},
        "pickupSpawnLevel": {str(k): v for k, v in Counter(
            e["pickupSpawnLevel"] for e in events).items()},
        "pickupsDoNotRespawn": sum(1 for e in events if e["pickupsDoNotRespawn"]),
        "aiDontGoForPickups": sum(1 for e in events if e["aiDontGoForPickups"]),
        "probabilityListBound": sum(1 for e in events if e["pickupProbabilityList"]),
        "powerUpDamageModifier": {
            level: {str(k): v for k, v in Counter(
                e["difficulties"][level]["powerUpDamageModifier"] for e in events).items()}
            for level in ("Easy", "Medium", "Hard")
        },
        "aiPerkUseEntries": sum(e["difficulties"][level]["aiPerkUseCount"]
                                for e in events for level in ("Easy", "Medium", "Hard")),
        "opponents": sum(len(e["opponents"]) for e in events),
        "opponentsWithPerkGifts": gift_total,
        "opponentsAlwaysShields": shield_total,
    }
    return {
        "source": {"pack": PACK, "path": SINGLE},
        "events": events,
        "aggregate": aggregate,
    }


def extract_modes(mp: Flask) -> dict:
    def field_map(type_name: str) -> dict:
        ti = next(i for i in range(len(mp.types)) if mp.type_name(i) == type_name)
        return {f["name"]: f for f in mp.type_fields(ti)}

    race_fields = field_map("MultiplayerRace")
    race_type = next(i for i in range(len(mp.types)) if mp.type_name(i) == "MultiplayerRace")
    enums = {name: mp.type_labels(next(i for i in range(len(mp.types)) if mp.type_name(i) == name))
             for name in ("MpPickup", "MpPowerupRespawn", "MpRandomPowerups", "DamageMode",
                          "MpClass")}

    def read_enum(payload, name, offset):
        index = struct.unpack_from("<I", payload, offset)[0]
        return index, enums[name][index] if index < len(enums[name]) else None

    def read_flags(payload, name, offset):
        bits = struct.unpack_from("<I", payload, offset)[0]
        return bits, [label for i, label in enumerate(enums[name]) if bits & (1 << i)]

    races = []
    for i in range(len(mp.records)):
        if mp.record_type(i) != race_type:
            continue
        payload = mp.record_payload(i)
        bits, labels = read_flags(payload, "MpPickup", race_fields["powerups"]["offset"])
        ridx, rlabel = read_enum(payload, "MpPowerupRespawn", race_fields["poweruprespawn"]["offset"])
        xidx, xlabel = read_enum(payload, "MpRandomPowerups", race_fields["randompowerups"]["offset"])
        didx, dlabel = read_enum(payload, "DamageMode", race_fields["damage_mode"]["offset"])
        # race type uses its own enum; read the label by index directly.
        type_labels = mp.type_labels(mp.type_fields(race_type)[0]["typeIndex"])
        race_type_index = struct.unpack_from("<I", payload, race_fields["type"]["offset"])[0]
        prob = struct.unpack_from("<I", payload, race_fields["PickupProbabilities"]["offset"])[0]
        races.append({
            "record": i,
            "refId": mp.record_id(i),
            "type": {"index": race_type_index,
                     "label": type_labels[race_type_index] if race_type_index < len(type_labels) else None},
            "minPlayers": struct.unpack_from("<I", payload, race_fields["min_players"]["offset"])[0],
            "maxPlayers": struct.unpack_from("<I", payload, race_fields["max_players"]["offset"])[0],
            "powerups": {"bits": bits, "labels": labels},
            "powerupRespawn": {"index": ridx, "label": rlabel},
            "randomPowerups": {"index": xidx, "label": xlabel},
            "damageMode": {"index": didx, "label": dlabel},
            "pickupProbabilityList": None if prob == 0xFFFFFFFF else prob,
        })

    aggregate = {
        "raceCount": len(races),
        "powerupEnabled": {label: sum(1 for r in races if label in r["powerups"]["labels"])
                           for label in enums["MpPickup"]},
        "powerupBitPatterns": {},
        "respawn": {label: sum(1 for r in races if r["powerupRespawn"]["label"] == label)
                    for label in enums["MpPowerupRespawn"]},
        "randomPowerups": {label: sum(1 for r in races if r["randomPowerups"]["label"] == label)
                           for label in enums["MpRandomPowerups"]},
        "damageMode": {label: sum(1 for r in races if r["damageMode"]["label"] == label)
                       for label in enums["DamageMode"]},
        "nullProbabilityList": sum(1 for r in races if r["pickupProbabilityList"] is None),
    }
    for r in races:
        key = str(r["powerups"]["bits"])
        aggregate["powerupBitPatterns"][key] = aggregate["powerupBitPatterns"].get(key, 0) + 1

    config_type = next(i for i in range(len(mp.types)) if mp.type_name(i) == "MultiplayerConfig")
    config_record = next(i for i in range(len(mp.records)) if mp.record_type(i) == config_type)
    config_payload = mp.record_payload(config_record)
    config_fields = {f["name"]: f for f in mp.type_fields(config_type)}
    config = {
        "record": config_record,
        "refId": mp.record_id(config_record),
        "powerupRespawnToggleLong": struct.unpack_from(
            "<f", config_payload, config_fields["powerup_respawn_toggle_long"]["offset"])[0],
        "powerupRespawnToggleVeryLong": struct.unpack_from(
            "<f", config_payload, config_fields["powerup_respawn_toggle_very_long"]["offset"])[0],
        "defaults": None,
        "damageMultipliers": None,
    }
    defaults_field = config_fields["defaults"]
    defaults_type = defaults_field["typeIndex"]
    mp._current_strings = mp.record_strings(config_record)
    config["defaults"] = mp._decode_struct(config_record, defaults_type, config_payload,
                                           defaults_field["offset"], 0, ())
    # damage_multiplier_values is an inline struct of three f32 fields.
    dmg_field = config_fields["damage_multiplier_values"]
    dmg = {}
    for f in mp.type_fields(dmg_field["typeIndex"]):
        dmg[f["name"]] = struct.unpack_from("<f", config_payload,
                                            dmg_field["offset"] + f["offset"])[0]
    config["damageMultipliers"] = dmg

    online = None
    for i in range(len(mp.records)):
        if mp.type_name(mp.record_type(i)) == "PickupParametersStoredOnline":
            o = mp.decode_record(i)
            online = {"record": i, "refId": mp.record_id(i),
                      "RecoveryTime": o["RecoveryTime"],
                      "RecoveryTimeSpeedMod": o["RecoveryTimeSpeedMod"]}
            break

    ability_type = next(i for i in range(len(mp.types)) if mp.type_name(i) == "MultiplayerAbility")
    abilities = []
    for i in range(len(mp.records)):
        if mp.record_type(i) != ability_type:
            continue
        o = mp.decode_record(i)
        abilities.append({
            "record": i,
            "refId": mp.record_id(i),
            "abilityId": o["AbilityId"],
            "slot": o["AbilitySlot"],
            "nameLocId": o["AbilityName"],
            "iconName": o["IconName"]["value"] if isinstance(o["IconName"], dict) else None,
            "abilityValue": o["AbilityValue"],
            "specialFxCount": o["OnActivateSpecialFX"]["length"],
        })

    categories = []
    cat_type = next(i for i in range(len(mp.types)) if mp.type_name(i) == "MultiplayerAbilityCategory")
    for i in range(len(mp.records)):
        if mp.record_type(i) != cat_type:
            continue
        o = mp.decode_record(i)
        categories.append({
            "record": i, "refId": mp.record_id(i), "slot": o["Slot"],
            "nameLocId": o["Name"],
            "abilities": [{"refId": a["refId"], "record": a["record"],
                           "abilityId": a["value"].get("AbilityId") if a.get("value") else None}
                          for a in o["Abilities"]["items"]],
        })

    return {
        "source": {"pack": PACK, "path": MULTIPLAYER},
        "enums": enums,
        "races": races,
        "aggregate": aggregate,
        "config": config,
        "onlinePickupParameters": online,
        "abilities": abilities,
        "abilityCategories": categories,
    }


def main() -> None:
    pak = GAME_DIR / "cache" / PACK
    index = pak_index(pak)
    if index.get("codec") != 2:
        raise SystemExit("expected zlib gamedata.pak")

    packs = {}
    for key, path in (("pickups", PICKUPS), ("multiplayer", MULTIPLAYER),
                      ("ui", UI), ("audio", AUDIO), ("dynamiceffects", DYNAMIC),
                      ("singleplayer", SINGLE)):
        packs[key] = decode_pak_entry(index, pak, path)
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / f"{key}.xt").write_bytes(packs[key]["bytes"])

    pickups = Flask(packs["pickups"]["bytes"])
    multiplayer = Flask(packs["multiplayer"]["bytes"])
    ui = Flask(packs["ui"]["bytes"])
    audio = Flask(packs["audio"]["bytes"])
    dynamic = Flask(packs["dynamiceffects"]["bytes"])
    single = Flask(packs["singleplayer"]["bytes"])

    sources = []
    source_flasks = {"pickups": pickups, "multiplayer": multiplayer, "ui": ui,
                     "audio": audio, "dynamiceffects": dynamic, "singleplayer": single}
    for key in ("pickups", "multiplayer", "ui", "audio", "dynamiceffects", "singleplayer"):
        meta = {k: v for k, v in packs[key].items() if k != "bytes"}
        meta["name"] = key
        meta["summary"] = flask_summary(source_flasks[key])
        meta["role"] = {
            "pickups": "pickup definitions and balance data",
            "multiplayer": "per-race enable flags and online pickup timing",
            "ui": "HUD perk icon table",
            "audio": "perk audio entity names",
            "dynamiceffects": "external particle/light FX resolution only",
            "singleplayer": "per-event/difficulty pickup settings",
        }[key]
        sources.append(meta)

    # Record-id -> (pack, record, type) across the packs, used to resolve
    # external handles that the runtime would resolve through the PAK pack.
    id_map: dict[int, list[dict]] = {}
    for key in ("pickups", "multiplayer", "ui", "audio", "dynamiceffects", "singleplayer"):
        flask = source_flasks[key]
        for i in range(len(flask.records)):
            rid = flask.record_id(i)
            id_map.setdefault(rid, []).append(
                {"pack": key, "record": i, "type": flask.type_name(flask.record_type(i))})

    # PickupSystem enumerates every PickupType record.
    system_record = next(i for i in range(len(pickups.records))
                         if pickups.type_name(pickups.record_type(i)) == "PickupSystem")
    system = pickups.decode_record(system_record)
    type_handles = system["Types"]["items"]
    if len(type_handles) != 11:
        raise SystemExit(f"expected 11 PickupType handles, got {len(type_handles)}")

    hud = extract_hud(ui)
    audio_names = extract_audio(audio)

    entities = []
    for handle in type_handles:
        record = handle["record"]
        obj = pickups.decode_record(record)
        label = obj["Type"]["label"]
        aliases = ALIASES.get(label)
        if aliases is None and label in MP_DIRECT:
            aliases = {
                "multiplayer": MP_DIRECT[label],
                "status": "exact-label-match",
                "evidence": [f"MpPickup flag '{MP_DIRECT[label]}' exists in multiplayer.bin "
                             f"and the PickupType label is '{label}'."],
            }
        if aliases is None:
            aliases = {
                "multiplayer": None,
                "status": "not-in-mp-pickup-enum",
                "evidence": ["MpPickup has eight flags (nitro, shock, barge, mine, shunt, "
                             "bolt, shield, repair); this PickupType has no matching flag."],
            }
        levels = {}
        for slot in SLOTS:
            summary = level_summary(pickups, obj.get(slot))
            if summary is not None:
                levels[slot] = summary

        runtime_handles = unresolved_handles(obj)
        resolved_external = []
        unresolved = []
        for item in runtime_handles:
            targets = id_map.get(item["refId"], [])
            if targets:
                resolved_external.append({**item, "resolvesTo": targets})
            else:
                unresolved.append(item)

        entity = {
            "id": f"pickup.{label}",
            "pickupLabel": label,
            "record": record,
            "refId": pickups.record_id(record),
            "typeField": obj["Type"],
            "multiplayer": aliases,
            "baseProbability": obj["BaseProbability"],
            "doNotRandomise": obj["DoNotRandomise"],
            "aiUsageType": obj["AIUsageType"],
            "aiTriggers": [
                {"trigger": t["$type"],
                 "usageTypes": [u for u in t["UsageTypes"]["items"]]}
                for t in obj["AIPickupTypes"]["items"]
            ],
            "positionModifiers": obj["PositionModifiers"]["items"],
            "specialEffectCycle": {
                "begin": obj["PickupSpecialFXBeginCycle"],
                "end": obj["PickupSpecialFXEndCycle"],
            },
            "levels": levels,
            "hud": {"entries": {key: hud["perkEntries"].get(key) for key in HUD_KEY[label]},
                    "key": HUD_KEY[label],
                    "basis": "UiXtConfig.PerkDisplayParameters keys, matched by name; pickups.bin "
                             "does not serialize a HUD reference.",
                    "absentReason": None if HUD_KEY[label] else "no UiPerkInfo entry for this pickup"},
            "audio": {
                "entities": [{"name": n, **audio_names[n]} for n in AUDIO_PREFIX[label]
                             if n in audio_names],
                "basis": "AudioEntityDef.name prefix match in audioentities.bin; the perk audio "
                         "graph inside the entity is not decoded.",
                "absentReason": None if AUDIO_PREFIX[label] else "no audio entity name matches this pickup",
                "spatializer": {"name": "PickupPosition", **audio_names["PickupPosition"]},
            },
            "unresolvedHandles": unresolved,
            "resolvedExternalHandles": resolved_external,
            "classification": {
                "status": ("fully-recovered" if not unresolved else "partial-field-set"),
                "scope": "PickupType record, every present PickupLevel slot, its BalancingData "
                         "and BalancingGraph, and the per-level SpecialFX reference tree",
                "basis": "Every serialized field decodes. External Particle_Event/Light_Object "
                         "handles are resolved by 32-bit record id to the owning pack but their "
                         "payloads are not decoded into this manifest.",
                "unresolvedHandleCount": len(unresolved),
                "externalFxResolvedById": len(resolved_external),
                "externalFxPayloadDecoded": False,
            },
            "absentBehaviours": ABSENT_BEHAVIOURS,
        }
        entities.append(entity)

    averages = []
    prob_lists = []
    for i in range(len(pickups.records)):
        tname = pickups.type_name(pickups.record_type(i))
        if tname == "PickupProbabilityList":
            o = pickups.decode_record(i)
            items = o["PickupProbabilities"]["items"]
            prob_lists.append({
                "record": i, "refId": pickups.record_id(i),
                "items": [{"pickup": x["PickupType"], "probability": x["Probability"]}
                          for x in items],
                "sum": sum(x["Probability"] for x in items),
            })
        elif tname == "PickupPositionRow":
            o = pickups.decode_record(i)
            averages.append({"record": i, "refId": pickups.record_id(i),
                             "typeList": o["TypeList"]})

    modes = extract_modes(multiplayer)
    singleplayer = extract_singleplayer(single, id_map)

    # Search the remaining packs for pickup definitions (negative evidence).
    searched = []
    for path in SEARCHED:
        meta = decode_pak_entry(index, pak, path)
        flask = Flask(meta["bytes"])
        names = {flask.type_name(i) for i in range(len(flask.types))}
        matches = sorted(n for n in names if any(k in n.lower() for k in
                                                 ("pickup", "powerup", "perk")))
        searched.append({
            "pack": PACK, "path": path, "fatIndex": meta["fatIndex"],
            "storedBytes": meta["storedBytes"], "logicalBytes": meta["logicalBytes"],
            "sha256Decoded": meta["sha256Decoded"], "types": len(flask.types),
            "records": len(flask.records),
            "pickupTypeNames": matches,
            "result": "no pickup definition types" if not matches else "matched types present",
        })

    decoder_path = HERE / "xt_decode.py"
    manifest = {
        "schema": "blur-powerups/1",
        "generatedBy": "probes/powerups/tools/build_powerups.py",
        "decoder": {
            "path": "probes/powerups/tools/xt_decode.py",
            "sha256": sha256(decoder_path.read_bytes()),
            "behaviourRules": [
                "struct/atom widths use the serialized type size (XtAtomType / FlaskDecodeAtom)",
                "behaviour 4 pointer = {u16 component,u16 element} in the owning record's component table",
                "behaviour 5 handle = u32 index into the sorted refs table (post-CompileRefList)",
                "array = {u16 component,u16 element,u32 length} in the owning record's component table",
                "enum = label index; the declared integer value is not serialized",
                "record strings use XtFlaskDecodeStrings (v2 XOR/prev transform)",
            ],
        },
        "sources": sources,
        "searchedPacks": searched,
        "enums": {
            "Pickup": pickups.type_labels(
                next(i for i in range(len(pickups.types)) if pickups.type_name(i) == "Pickup")),
            "PickupTypeList": pickups.type_labels(
                next(i for i in range(len(pickups.types)) if pickups.type_name(i) == "PickupTypeList")),
            "AIUsageType": pickups.type_labels(
                next(i for i in range(len(pickups.types)) if pickups.type_name(i) == "AIUsageType")),
            "PickupSpecialFXLocation": pickups.type_labels(
                next(i for i in range(len(pickups.types))
                     if pickups.type_name(i) == "PickupSpecialFXLocation")),
            "MpPickup": modes["enums"]["MpPickup"],
        },
        "pickupSystem": {
            "record": system_record,
            "refId": pickups.record_id(system_record),
            "parameters": system["Parameters"]["value"],
            "parametersStoredOnline": system["ParametersStoredOnline"],
            "typeHandleCount": len(type_handles),
        },
        "entities": entities,
        "pickupProbabilityLists": prob_lists,
        "pickupPositionRows": averages,
        "modes": modes,
        "singlePlayer": singleplayer,
        "hud": hud,
        "counts": {
            "pickupTypes": len(entities),
            "levelsPerType": {e["pickupLabel"]: len(e["levels"]) for e in entities},
            "probabilityLists": len(prob_lists),
            "positionRows": len(averages),
            "races": len(modes["races"]),
            "abilities": len(modes["abilities"]),
            "singlePlayerEvents": len(singleplayer["events"]),
        },
        "limits": [
            "Definitions and per-mode enable flags only; pickup placement on tracks is not in "
            "these packs and is not claimed.",
            "No retail hit/miss, ammo/charge, targeting or respawn timing is invented; absent "
            "fields are listed per entity.",
            "No full-game or retail-parity claim.",
        ],
    }
    manifest["hashes"] = {
        "manifestContent": canonical_hash(manifest),
        "sourceDecoded": {s["name"]: s["sha256Decoded"] for s in sources},
        "sourceStored": {s["name"]: s["sha256Stored"] for s in sources},
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    text = json.dumps(manifest, indent=1, sort_keys=True) + "\n"
    (OUT_DIR / "powerups.json").write_text(text, encoding="utf-8")
    print(f"wrote {OUT_DIR / 'powerups.json'} ({len(text)} bytes)")
    print(f"entities {len(entities)}: " + ", ".join(f"{e['pickupLabel']}({e['classification']['status']})"
                                                    for e in entities))
    print(f"races {len(modes['races'])}, probability lists {len(prob_lists)}, "
          f"abilities {len(modes['abilities'])}")
    print("manifestContent", manifest["hashes"]["manifestContent"])


if __name__ == "__main__":
    main()
