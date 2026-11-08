r"""Build the retail mode/event catalogue from shipped XT game data (read-only).

Sources (all inside game-data/Blur/cache/gamedata.pak; the PAK is never written):

  \gamedata\xt\singleplayer.bin   AmaxEvent records (86) + career tiers/bosses
  \gamedata\xt\multiplayer.bin    MultiplayerRace (439), MultiplayerEvent (25), config
  \gamedata\xt\amax.bin           Route (70) and City (22) records
  \gamedata\xt\rldatabase.bin     SP_GameMode_Destruction scoring values
  \gamedata\xt\loc\*.loc          English name/text tables (OLTX)

Every extracted scalar carries its record id, record index and absolute byte
offset inside the decoded XT payload plus the field offset. No offset is guessed:
the decoder validates the FLSK schema and the record extent first.

Output: _work/race-rules/game-modes.json (deterministic, sorted keys).
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
from loc_decode import parse as parse_loc  # noqa: E402

GAME_DIR = ROOT / "game-data" / "Blur"
PACK_PATH = GAME_DIR / "cache" / "gamedata.pak"
OUT_DIR = ROOT / "_work" / "race-rules"
OUT_FILE = OUT_DIR / "game-modes.json"

SOURCES = {
    "singleplayer": "\\gamedata\\xt\\singleplayer.bin",
    "multiplayer": "\\gamedata\\xt\\multiplayer.bin",
    "amax": "\\gamedata\\xt\\amax.bin",
    "rldatabase": "\\gamedata\\xt\\rldatabase.bin",
}

LOC_FILES = [
    "\\gamedata\\xt\\loc\\singleplayer.loc",
    "\\gamedata\\xt\\loc\\multiplayer.loc",
    "\\gamedata\\xt\\loc\\cityandroutenames.loc",
    "\\gamedata\\xt\\loc\\common.loc",
    "\\gamedata\\xt\\loc\\hud.loc",
    "\\gamedata\\xt\\loc\\racebookui.loc",
    "\\gamedata\\xt\\loc\\racebookcommon.loc",
    "\\gamedata\\xt\\loc\\info.loc",
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_hash(obj: dict) -> str:
    body = {k: v for k, v in obj.items() if k != "hashes"}
    return sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode())


INDEX = pak_index(PACK_PATH)


def entry_meta(path: str) -> dict:
    row = next((r for r in INDEX["entries"] if r["path"].lower() == path.lower()), None)
    if row is None:
        raise SystemExit("missing PAK entry " + path)
    return row


def decode_pak_entry(path: str) -> dict:
    row = entry_meta(path)
    with PACK_PATH.open("rb") as stream:
        stream.seek(row["offset"])
        stored = stream.read(row["stored_bytes"])
    if len(stored) != row["stored_bytes"]:
        raise SystemExit("short read " + path)
    inflater = zlib.decompressobj()
    data = inflater.decompress(stored, row["logical_bytes"] + 1)
    if (len(data) != row["logical_bytes"] or not inflater.eof
            or inflater.unused_data or inflater.unconsumed_tail):
        raise SystemExit("zlib extent mismatch " + path)
    return {
        "pak": PACK_PATH.name,
        "path": row["path"],
        "fatIndex": row["fat_index"],
        "offset": row["offset"],
        "storedBytes": row["stored_bytes"],
        "logicalBytes": row["logical_bytes"],
        "pathCrc32": row["path_crc32"],
        "sha256Decoded": sha256(data),
        "bytes": data,
    }


def type_index(flask: Flask, name: str) -> int:
    for index in range(len(flask.types)):
        if flask.type_name(index) == name:
            return index
    raise SystemExit("missing XT type " + name)


def records_of(flask: Flask, type_name: str) -> list[int]:
    index = type_index(flask, type_name)
    return [i for i in range(len(flask.records)) if flask.record_type(i) == index]


def payload_offset(flask: Flask, record_index: int) -> int:
    return flask._data_base + flask._data_start[record_index]


def field_meta(flask: Flask, type_index_value: int) -> dict:
    return {field["name"]: field for field in flask.all_fields(type_index_value)}


def read_fields(flask: Flask, record_index: int, type_index_value: int | None = None) -> dict:
    """Decode every field of one record (or nested struct) with byte offsets."""
    type_index_value = type_index_value if type_index_value is not None else flask.record_type(record_index)
    payload = flask.record_payload(record_index)
    base = payload_offset(flask, record_index)
    out = {}
    previous = flask._current_strings
    flask._current_strings = flask.record_strings(record_index)
    try:
        for field in flask.all_fields(type_index_value):
            value = flask._decode_field(record_index, field, payload, field["offset"], 0, (record_index,))
            out[field["name"]] = {
                "value": value,
                "fieldOffset": field["offset"],
                "byteOffset": base + field["offset"],
                "behaviour": field["behaviour"],
                "array": field["array"],
            }
    finally:
        flask._current_strings = previous
    return out


def plain(value):
    """Strip XT envelopes to the scalar the database cares about."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, str)):
        return value
    if isinstance(value, dict):
        if "label" in value:
            return {"label": value["label"], "labelIndex": value["labelIndex"]}
        if "labels" in value:
            return {"bits": value["bits"], "labels": value["labels"]}
        if "id" in value and "atom" in value and value.get("atom") == "locId":
            return {"locId": value["id"]}
        if "value" in value and "atom" in value:
            return value["value"]
        if "refId" in value:
            return {
                "refId": value["refId"],
                "typeName": value["typeName"],
                "unloaded": bool(value.get("unloaded")),
            }
        if "$type" in value:
            return {"$type": value["$type"], **{k: plain(v) for k, v in value.items() if k != "$type"}}
    return value


def summarise_rules(array_value) -> list[dict]:
    if not array_value:
        return []
    items = array_value.get("items", []) if isinstance(array_value, dict) else []
    out = []
    for item in items:
        if not isinstance(item, dict):
            out.append({"$type": None})
            continue
        row = {"$type": item.get("$type")}
        for key, value in item.items():
            if key == "$type":
                continue
            row[key] = plain(value)
        out.append(row)
    return out


def mode_vars(flask: Flask, record_index: int, pointer, pointer_field_offset: int) -> dict | None:
    """Decode a nested AmaxRaceMode* component and list its fields with offsets."""
    if not pointer or not isinstance(pointer, dict) or pointer.get("$type") is None:
        return None
    name = pointer["$type"]
    index = type_index(flask, name)
    payload = flask.record_payload(record_index)
    base = payload_offset(flask, record_index)
    component, element = struct.unpack_from("<2H", payload, pointer_field_offset)
    if component == 0xFFFF:
        return None
    component_offset = flask._component_offset(record_index, component)
    element_size = flask.types[index][5]
    struct_base = component_offset + element * element_size
    out = {
        "$type": name,
        "component": component,
        "element": element,
        "componentByteOffset": base + struct_base,
        "fields": {},
    }
    previous = flask._current_strings
    flask._current_strings = flask.record_strings(record_index)
    try:
        for field in flask.all_fields(index):
            value = flask._decode_field(record_index, field, payload, struct_base + field["offset"], 0, (record_index,))
            out["fields"][field["name"]] = {
                "value": plain(value),
                "fieldOffset": struct_base + field["offset"],
                "byteOffset": base + struct_base + field["offset"],
            }
    finally:
        flask._current_strings = previous
    return out


# ------------------------------------------------------------------ loc index
LOC_INDEX: dict[int, dict] = {}
LOC_BY_NAME: dict[str, dict] = {}
LOC_META = []
for path in LOC_FILES:
    decoded = decode_pak_entry(path)
    try:
        lookup, translation = parse_loc(decoded["bytes"], "en")
    except Exception as error:  # noqa: BLE001
        LOC_META.append({"path": path, "error": str(error)})
        continue
    LOC_META.append({
        "path": path,
        "offset": decoded["offset"],
        "logicalBytes": decoded["logicalBytes"],
        "sha256Decoded": decoded["sha256Decoded"],
        "ids": len(lookup),
    })
    for ident, name in lookup.items():
        LOC_INDEX.setdefault(ident, {"name": name, "text": translation.get(ident), "path": path})
        LOC_BY_NAME.setdefault(name, {"locId": ident, "text": translation.get(ident), "path": path})


def loc_id(value) -> dict | None:
    if not isinstance(value, dict) or value.get("atom") != "locId":
        return None
    ident = int(value["id"], 16)
    found = LOC_INDEX.get(ident)
    return {
        "locId": value["id"],
        "name": found["name"] if found else None,
        "text": found["text"] if found else None,
        "path": found["path"] if found else None,
    }


# ------------------------------------------------------------------ source 1
SINGLE = decode_pak_entry(SOURCES["singleplayer"])
SP = Flask(SINGLE["bytes"])
SP_EVENT_TYPE = type_index(SP, "AmaxEvent")


def extract_difficulty(record_index: int, field_name: str, base_offset: int, base_byte: int) -> dict:
    payload = SP.record_payload(record_index)
    field = field_meta(SP, SP_EVENT_TYPE)[field_name]
    diff_type = field["typeIndex"]
    base = field["offset"]
    out = {"$type": SP.type_name(diff_type), "fields": {}}
    previous = SP._current_strings
    SP._current_strings = SP.record_strings(record_index)
    try:
        for sub in SP.all_fields(diff_type):
            value = SP._decode_field(record_index, sub, payload, base + sub["offset"], 0, (record_index,))
            out["fields"][sub["name"]] = {
                "value": plain(value) if sub["name"] not in ("PassRules", "FailRules", "LapActions", "TimeActions") else summarise_rules(value),
                "fieldOffset": base_offset + sub["offset"],
                "byteOffset": base_byte + sub["offset"],
            }
    finally:
        SP._current_strings = previous
    return out


SP_EVENTS = []
for record_index in records_of(SP, "AmaxEvent"):
    payload = SP.record_payload(record_index)
    base = payload_offset(SP, record_index)
    fields = read_fields(SP, record_index)
    name = fields["Name"]["value"]["value"]
    mode = fields["RaceMode"]["value"]
    event = {
        "recordIndex": record_index,
        "recordId": SP.record_id(record_index),
        "payloadByteOffset": base,
        "name": name,
        "locString": loc_id(fields["LocString"]["value"]),
        "route": {
            "refId": fields["Route"]["value"]["refId"],
            "typeName": fields["Route"]["value"]["typeName"],
        },
        "laps": fields["Laps"]["value"],
        "carClass": plain(fields["CarClass"]["value"]),
        "raceMode": mode["$type"] if isinstance(mode, dict) else None,
        "raceModeByteOffset": fields["RaceMode"]["byteOffset"],
        "pickupsDoNotRespawn": fields["PickupsDoNotRespawn"]["value"],
        "pickupSpawnLevel": fields["PickupSpawnLevel"]["value"],
        "pickupDisableTimeSeconds": fields["PickupDisableTime"]["value"],
        "aiDontGoForPickups": fields["AIDontGoForPickups"]["value"],
        "opponentCount": (fields["Opponents"]["value"] or {}).get("length", 0),
        "leaderboard": plain(fields["Leaderboards"]["value"]),
        "difficulty": {},
        "modeVars": mode_vars(SP, record_index, mode, fields["RaceMode"]["fieldOffset"]),
    }
    for diff_name in ("Easy", "Medium", "Hard"):
        event["difficulty"][diff_name.lower()] = extract_difficulty(
            record_index, diff_name, 0, base)
    SP_EVENTS.append(event)

SP_EVENT_BY_RECORD = {row["recordIndex"]: row for row in SP_EVENTS}

# career tiers and bosses
TIER_RECORD = records_of(SP, "SP_TierData")[0]
TIER_TREE = SP.decode_record(TIER_RECORD)
CAREER_TIERS = []
for tier in TIER_TREE["tierRoot"]["tiers"]["items"]:
    events = []
    for item in tier["events"]["items"]:
        ref = item["event"]
        record = ref.get("record") if isinstance(ref, dict) else None
        event_row = SP_EVENT_BY_RECORD.get(record)
        events.append({
            "$type": item["$type"],
            "id": item["id"],
            "eventRecordId": ref["refId"] if isinstance(ref, dict) else None,
            "eventRecordIndex": record,
            "eventName": event_row["name"] if event_row else None,
            "raceMode": event_row["raceMode"] if event_row else None,
            "laps": event_row["laps"] if event_row else None,
            "fanPar": item.get("fanPar"),
        })
    boss = tier.get("boss")
    # SP_TierData.boss is serialized as the SP_Boss struct itself in the shipped
    # pack; older/other schema revisions wrap it in a `value` envelope. Accept
    # both without guessing: a direct struct is used as-is.
    boss_value = boss.get("value") if isinstance(boss, dict) and boss.get("value") is not None else boss
    demand_rows = []
    if boss_value:
        for demand in boss_value["demands"]["items"]:
            demand_rows.append({
                "$type": demand["$type"],
                "count": demand.get("count"),
                "minspeed": demand.get("minspeed"),
            })
    CAREER_TIERS.append({
        "id": tier["id"],
        "name": loc_id(tier["name"]),
        "starRequirement": tier["starRequirement"],
        "events": events,
        "boss": {
            "id": boss_value["id"] if boss_value else None,
            "name": loc_id(boss_value["name"]) if boss_value else None,
            "bio": loc_id(boss_value["bio"]) if boss_value else None,
            "demands": demand_rows,
        } if boss_value else None,
    })

CAREER_BOSSES = []
for boss in TIER_TREE["bosses"]["items"]:
    CAREER_BOSSES.append({
        "id": boss["id"],
        "name": loc_id(boss["name"]),
        "bio": loc_id(boss["bio"]),
        "demands": [{"$type": d["$type"], "count": d.get("count"), "minspeed": d.get("minspeed")}
                    for d in boss["demands"]["items"]],
        "rewardUnlockCount": boss["rewardsForUnlock"]["length"],
        "rewardDefeatCount": boss["rewardsForDefeat"]["length"],
    })

# ------------------------------------------------------------------ source 2
MULTI = decode_pak_entry(SOURCES["multiplayer"])
MP = Flask(MULTI["bytes"])
MP_RACE_TYPE = type_index(MP, "MultiplayerRace")
MP_EVENT_TYPE = type_index(MP, "MultiplayerEvent")
MP_CONFIG_TYPE = type_index(MP, "MultiplayerConfig")
MP_RACE_FIELDS = field_meta(MP, MP_RACE_TYPE)

RACES = []
for record_index in records_of(MP, "MultiplayerRace"):
    fields = read_fields(MP, record_index)
    row = {
        "recordIndex": record_index,
        "recordId": MP.record_id(record_index),
        "payloadByteOffset": payload_offset(MP, record_index),
    }
    for key, cell in fields.items():
        row[key] = plain(cell["value"])
    for key in ("type", "damage_mode", "handicap", "lastmanstanding", "ai",
                "carupgrades", "mods", "poweruprespawn", "randompowerups"):
        value = row.get(key)
        row[key + "Label"] = value.get("label") if isinstance(value, dict) else value
    row["routeRefId"] = fields["route"]["value"]["refId"] if fields["route"]["value"] else None
    row["powerups"] = plain(fields["powerups"]["value"])
    row["classes"] = plain(fields["classes"]["value"])
    RACES.append(row)

MP_EVENTS = []
for record_index in records_of(MP, "MultiplayerEvent"):
    fields = read_fields(MP, record_index)
    races = fields["races"]["value"]
    race_refs = []
    if races and races.get("items"):
        for item in races["items"]:
            if isinstance(item, dict):
                race_refs.append({"refId": item["refId"], "recordIndex": item.get("record")})
    event = {
        "recordIndex": record_index,
        "recordId": MP.record_id(record_index),
        "payloadByteOffset": payload_offset(MP, record_index),
        "name": loc_id(fields["name"]["value"]),
        "description": loc_id(fields["desc"]["value"]),
        "iconName": plain(fields["icon_name"]["value"]),
        "imageName": plain(fields["image_name"]["value"]),
        "notAvailable": fields["not_available"]["value"],
        "isChampionship": fields["is_championship"]["value"],
        "championshipLength": fields["championship_length"]["value"],
        "fanMultiplier": fields["fan_multiplier"]["value"],
        "minPlayers": fields["min_players"]["value"],
        "maxPlayers": fields["max_players"]["value"],
        "minRank": fields["min_rank"]["value"],
        "maxRank": fields["max_rank"]["value"],
        "maxLegend": fields["max_legend"]["value"],
        "teams": fields["teams"]["value"],
        "misc": plain(fields["misc"]["value"]),
        "aiDifficulty": plain(fields["aiDifficulty"]["value"]),
        "raceRefs": race_refs,
        "timeoutSettings": summarise_rules(fields["timeout_settings"]["value"]),
    }
    MP_EVENTS.append(event)

CONFIG_RECORD = records_of(MP, "MultiplayerConfig")[0]
CONFIG_FIELDS = read_fields(MP, CONFIG_RECORD)
CONFIG = {
    "recordIndex": CONFIG_RECORD,
    "recordId": MP.record_id(CONFIG_RECORD),
    "payloadByteOffset": payload_offset(MP, CONFIG_RECORD),
    "motormashScoring": plain(CONFIG_FIELDS["motormashScoringValues"]["value"]),
    "motormashRespawnDelayMultipliers": plain(CONFIG_FIELDS["motormash_respawn_delay_multipliers"]["value"]),
    "campingPreventionTimeout": CONFIG_FIELDS["camping_prevention_timeout"]["value"],
    "damageMultipliers": plain(CONFIG_FIELDS["damage_multiplier_values"]["value"]),
    "idleTimeoutData": plain(CONFIG_FIELDS["idle_timeout_data"]["value"]),
    "racePositionPoints": plain(CONFIG_FIELDS["race_position_points"]["value"]),
    "defaults": plain(CONFIG_FIELDS["defaults"]["value"]),
    "customRaceTimeout": summarise_rules(CONFIG_FIELDS["custom_race_timeout"]["value"]),
    "scoring": summarise_rules(CONFIG_FIELDS["scoring"]["value"]),
    "powerupRespawnToggleLongSeconds": CONFIG_FIELDS["powerup_respawn_toggle_long"]["value"],
    "powerupRespawnToggleVeryLongSeconds": CONFIG_FIELDS["powerup_respawn_toggle_very_long"]["value"],
    "teamAFanBonus": CONFIG_FIELDS["winner_team_fan_bonus"]["value"],
    "teamAFanBonusMultiplier": CONFIG_FIELDS["winner_team_fan_bonus_balancing_multiplier"]["value"],
    "rivalsCommencementDelaySeconds": CONFIG_FIELDS["rivals_commencement_delay_timer"]["value"],
    "rivalsCountdownSeconds": CONFIG_FIELDS["rivals_countdown_timer"]["value"],
    "timeoutHiddenSeconds": CONFIG_FIELDS["timeout_time_hidden"]["value"],
    "timeoutVisibleSeconds": CONFIG_FIELDS["timeout_time_visible"]["value"],
    "teamAName": loc_id(CONFIG_FIELDS["team_a_name"]["value"]),
    "teamBName": loc_id(CONFIG_FIELDS["team_b_name"]["value"]),
}

# ------------------------------------------------------------------ source 3
AMAX = decode_pak_entry(SOURCES["amax"])
AX = Flask(AMAX["bytes"])
ROUTES = {}
for record_index in records_of(AX, "Route"):
    fields = read_fields(AX, record_index)
    ROUTES[AX.record_id(record_index)] = {
        "recordIndex": record_index,
        "recordId": AX.record_id(record_index),
        "name": plain(fields["Name"]["value"]),
        "locString": loc_id(fields["LocString"]["value"]),
        "routeNumber": fields["RouteNumber"]["value"],
        "circuitType": plain(fields["CircuitType"]["value"]),
        "cityRefId": fields["City"]["value"]["refId"] if fields["City"]["value"] else None,
        "onlyAllowSingleLap": fields["OnlyAllowSingleLap"]["value"],
        "fansToUnlockInSplitScreen": fields["FansToUnlockInSplitScreen"]["value"],
    }
CITIES = {}
for record_index in records_of(AX, "City"):
    fields = read_fields(AX, record_index)
    CITIES[AX.record_id(record_index)] = {
        "recordIndex": record_index,
        "recordId": AX.record_id(record_index),
        "name": plain(fields["Name"]["value"]),
        "locString": loc_id(fields["LocString"]["value"]),
        "devOnly": fields["DevOnly"]["value"],
        "iconName": plain(fields["IconName"]["value"]),
    }
for route in ROUTES.values():
    city = CITIES.get(route["cityRefId"])
    route["cityName"] = city["name"] if city else None
    route["cityLoc"] = city["locString"] if city else None

# ------------------------------------------------------------------ source 4
RL = decode_pak_entry(SOURCES["rldatabase"])
RLDB = Flask(RL["bytes"])
RL_RECORD = records_of(RLDB, "GameModeSystem")[0]
RL_FIELDS = read_fields(RLDB, RL_RECORD)
SP_DESTRUCTION = plain(RL_FIELDS["SP_Destruction"]["value"])

# ------------------------------------------------------------------ mode catalogue
ENGINE_MODES = [
    ("E_RaceMode_Nothing", 0, "sentinel"),
    ("E_RaceMode_StreetRace", 1, "single-player race"),
    ("E_RaceMode_Multiplayer_Racing", 2, "multiplayer lap race"),
    ("E_RaceMode_Multiplayer_Elimination", 3, "multiplayer elimination"),
    ("E_RaceMode_Multiplayer_Points", 4, "multiplayer points"),
    ("E_RaceMode_Multiplayer_Destruction", 5, "multiplayer destruction"),
    ("E_RaceMode_Destruction", 6, "single-player destruction"),
    ("E_RaceMode_Checkpoint", 7, "single-player checkpoint"),
    ("E_RaceMode_FanDemand", 8, "single-player fan demand"),
    ("E_RaceMode_BossBattle", 9, "single-player boss battle"),
    ("E_RaceMode_FriendDemand_StreetRace", 10, "friend demand race"),
    ("E_RaceMode_FriendDemand_Destruction", 11, "friend demand destruction"),
    ("E_RaceMode_FriendDemand_Checkpoint", 12, "friend demand checkpoint"),
    ("E_RaceMode_FriendDemand_FanDemand", 13, "friend demand fan demand"),
    ("E_RaceMode_FriendDemand_BossBattle", 14, "friend demand boss battle"),
]

RACE_TYPE_LABELS = ["racing", "elimination", "points", "destruction", "hardcore"]

MODES = [
    {
        "id": "street-race",
        "displayName": "Street Race",
        "family": "single-player",
        "engineMode": "E_RaceMode_StreetRace",
        "engineModeId": 1,
        "dataRaceModeType": "AmaxRaceModeStreetRace",
        "objective": "complete the configured number of laps on the route",
        "laps": "AmaxEvent.Laps (1-4 observed)",
        "checkpoints": "route split lines; not serialized in AmaxEvent",
        "timeLimit": "DifficultySettings.TimeLimit (0 = none; 150 s on 13 events, 300 s on 1)",
        "scoring": "pass rule (DriverFinishInXPosition) + optional AMAX score (not decoded)",
        "winCondition": "pass rules, e.g. DriverFinishInXPosition.PositionNeeded",
        "teams": False,
        "players": "1 local player + up to 20 opponent setups",
        "respawn": "E_AMAXWRECKED_RESPAWN default (LevelState.cpp:154)",
        "rulesKind": "race",
        "implemented": True,
        "source": ["GameLogic/RaceModes/RaceModeDefines.h:11-33",
                   "GameLogic/RaceModes/RaceModeStreetRace.cpp",
                   "GameLogic/GameData/GameEventData.h:399-402"],
    },
    {
        "id": "racing",
        "displayName": "Racing",
        "family": "multiplayer",
        "dataRaceType": "racing",
        "dataRaceTypeLabelIndex": 0,
        "objective": "complete the configured laps; first across the line wins",
        "laps": "MultiplayerRace.laps (1-4 observed)",
        "checkpoints": "route split lines; not serialized in MultiplayerRace",
        "timeLimit": "MultiplayerRace.time (0 for every shipped racing race)",
        "scoring": "position only",
        "winCondition": "first to finish the configured laps",
        "teams": "MultiplayerEvent.teams (2 events true)",
        "players": "MultiplayerRace.min_players 2-6, max_players 4-20",
        "respawn": "E_AMAXWRECKED_RESPAWN; poweruprespawn is a pickup setting, not a car respawn",
        "rulesKind": "race",
        "implemented": True,
        "source": ["GameLogic/RaceModes/RaceModeMultiplayerRacing.cpp"],
    },
    {
        "id": "hardcore",
        "displayName": "Hardcore",
        "family": "multiplayer",
        "dataRaceType": "hardcore",
        "dataRaceTypeLabelIndex": 4,
        "objective": "lap race with no power-ups and high damage",
        "laps": "MultiplayerRace.laps (1 or 3 observed)",
        "timeLimit": "0",
        "scoring": "position only",
        "winCondition": "first to finish the configured laps",
        "teams": False,
        "players": "min 2-4, max 10-20",
        "respawn": "normal wreck respawn",
        "rulesKind": "race-no-powerups",
        "implemented": True,
        "source": ["GameLogic/PlayMode/CustomRace.cpp:111",
                   "GameLogic/PlayMode/Playlist.cpp:290",
                   "GameLogic/Stickers/StickerManager.cpp:634"],
    },
    {
        "id": "elimination",
        "displayName": "Elimination",
        "family": "multiplayer",
        "dataRaceType": "elimination",
        "dataRaceTypeLabelIndex": 1,
        "objective": "periodically eliminate the worst-ranked racer; last remaining wins",
        "laps": "no shipped MultiplayerRace row",
        "timeLimit": "no shipped MultiplayerRace row; source uses LevelState.mTimeLimit as the period",
        "scoring": "EliminationPoints statistic; criterion from E_EliminationType",
        "winCondition": "last non-eliminated participant",
        "teams": False,
        "players": "2-20 from the RaceType contract; no shipped event data",
        "respawn": "eliminated racers leave the race",
        "rulesKind": "elimination",
        "implemented": True,
        "implementedFrom": "source semantics + config; no shipped per-race values",
        "source": ["GameLogic/RaceModes/RaceModeMultiplayerElimination.cpp:53-185",
                   "GameLogic/GameData/MultiplayerData.cpp:495-509"],
    },
    {
        "id": "points",
        "displayName": "Points",
        "family": "multiplayer",
        "dataRaceType": "points",
        "dataRaceTypeLabelIndex": 2,
        "objective": "score fans from the scoring-event table; finish on laps, time or score target",
        "laps": "no shipped MultiplayerRace row; finish type is laps > 0, else time > 0, else score target",
        "timeLimit": "no shipped row",
        "scoring": "MultiplayerConfig.scoring (26 rules, 1-25 points) + AMAX event score",
        "winCondition": "highest fan score; score target finishes the race",
        "teams": "MultiplayerEvent.teams",
        "players": "2-20 from the RaceType contract; no shipped event data",
        "respawn": "normal wreck respawn",
        "rulesKind": "points",
        "implemented": True,
        "implementedFrom": "source semantics + recovered 26-rule scoring table; no shipped per-race values",
        "source": ["GameLogic/RaceModes/RaceModeMultiplayerPoints.cpp:48-146",
                   "multiplayer.bin MultiplayerConfig.scoring"],
    },
    {
        "id": "destruction",
        "displayName": "Destruction (Motor Mash)",
        "family": "multiplayer",
        "dataRaceType": "destruction",
        "dataRaceTypeLabelIndex": 3,
        "objective": "score on-track points from damage and wrecks before the timer or score target",
        "laps": "MultiplayerRace.laps = 0 (31/31)",
        "timeLimit": "MultiplayerRace.time = 180 s (31/31)",
        "scoring": "MotorMashScoringValues: wreck 5, suicide -1, low damage 1, high damage 2, rival x2",
        "winCondition": "highest OnTrackPoints; ties broken by fans",
        "teams": "MultiplayerEvent.teams",
        "players": "min 2-6, max 4-20",
        "respawn": "wreck respawn delay multipliers [1, 10, 20] s",
        "rulesKind": "destruction",
        "implemented": True,
        "source": ["GameLogic/RaceModes/RaceModeMultiplayerDestruction.cpp:152-175, 230-292",
                   "multiplayer.bin MultiplayerConfig.motormashScoringValues"],
    },
    {
        "id": "checkpoint",
        "displayName": "Checkpoint",
        "family": "single-player",
        "engineMode": "E_RaceMode_Checkpoint",
        "engineModeId": 7,
        "dataRaceModeType": "AmaxRaceModeCheckpoint",
        "objective": "reach the finish before the time bank runs out; each checkpoint adds time",
        "laps": "AmaxEvent.Laps (1-4 observed)",
        "checkpoints": "timeAwarded array length defines the checkpoint count",
        "timeLimit": "AmaxRaceModeCheckpointVars.initialTime + timeAwarded[]; stopwatchIncTime per stopwatch",
        "scoring": "medal from remaining time (gold/silver thresholds; bronze >= 0)",
        "winCondition": "finish with timeLeft >= 0",
        "teams": False,
        "players": "1 local player + opponents",
        "respawn": "normal wreck respawn",
        "rulesKind": "checkpoint",
        "implemented": True,
        "source": ["GameLogic/RaceModes/RaceModeCheckpoint.cpp:115-343, 657-690",
                   "singleplayer.bin AmaxRaceModeCheckpointVars"],
    },
    {
        "id": "destruction-single",
        "displayName": "Destruction (single-player)",
        "family": "single-player",
        "engineMode": "E_RaceMode_Destruction",
        "engineModeId": 6,
        "dataRaceModeType": "AmaxRaceModeDestruction",
        "objective": "wreck AI waves for points before the timer; medals by point thresholds",
        "laps": "AmaxEvent.Laps = 0 (13/13)",
        "checkpoints": "none",
        "timeLimit": "AmaxRaceModeDestructionVars.initialTime",
        "scoring": "SP_GameMode_Destruction: hit 1, wreck Easy 2 / Medium 5 / Hard 9 / VHard 2; wave-size bonuses not decoded",
        "winCondition": "reach bronzePoints before the timer; medals at silver/gold thresholds",
        "teams": False,
        "players": "1 local player + waves",
        "respawn": "E_AMAXWRECKED_DO_NOTHING; damage mode POWERUPS_ONLY",
        "rulesKind": "destruction",
        "implemented": True,
        "source": ["GameLogic/RaceModes/RaceModeDestruction.cpp:173-218, 441-491, 1117-1174",
                   "rldatabase.bin SP_GameMode_Destruction"],
    },
    {
        "id": "boss-battle",
        "displayName": "Boss Battle",
        "family": "single-player",
        "engineMode": "E_RaceMode_BossBattle",
        "engineModeId": 9,
        "dataRaceModeType": "AmaxRaceModeBossBattle",
        "objective": "beat the minders, then beat the boss by wrecking it or staying ahead for the required time",
        "laps": "AmaxEvent.Laps (1-3 observed)",
        "checkpoints": "route split lines",
        "timeLimit": "DifficultySettings.TimeLimit",
        "scoring": "pass/fail rules; boss battle medal is Gold on win",
        "winCondition": "wreckBossToWin or timeInFrontOfBoss gap win; fail on being behind",
        "teams": False,
        "players": "1 local player + boss + minders",
        "respawn": "normal wreck respawn",
        "rulesKind": "boss-battle",
        "implemented": True,
        "implementedFrom": "AmaxRaceModeBossBattle values + documented two-stage logic (retail body partly commented)",
        "source": ["GameLogic/RaceModes/RaceModeBossBattle.cpp:73-238",
                   "GameLogic/GameData/GameEventData.h:473-486"],
    },
    {
        "id": "fan-demand",
        "displayName": "Fan Demand",
        "family": "single-player",
        "engineMode": "E_RaceMode_FanDemand",
        "engineModeId": 8,
        "dataRaceModeType": "AmaxRaceModeFanDemand (type absent from shipped pack schema)",
        "objective": "complete fan demands inside the event time",
        "laps": "not serialized",
        "checkpoints": "not serialized",
        "timeLimit": "not serialized",
        "scoring": "AmaxRaceModeFanDemandVars.Bronze/Silver/GoldNumToComplete (declared in source, absent from pack)",
        "winCondition": "not serialized",
        "teams": False,
        "players": "1 local player",
        "respawn": "unknown",
        "rulesKind": None,
        "implemented": False,
        "blockedReason": "The AmaxRaceModeFanDemand type and its three difficulty var structs are declared in GameEventData.h but the type is absent from the shipped singleplayer.bin schema; no FanDemand event records or values exist. The demand definition source (SP_BossDemand_* types) is present, but the mode thresholds are not.",
        "source": ["GameLogic/GameData/GameEventData.h:457-471",
                   "singleplayer.bin type table (no AmaxRaceModeFanDemand)"],
    },
    {
        "id": "friend-demand-*",
        "displayName": "Friend Demand variants",
        "family": "friend-demand",
        "engineMode": "E_RaceMode_FriendDemand_*",
        "engineModeId": "10-14",
        "objective": "five variants of the single-player modes for a friend challenge",
        "dataRaceModeType": "not present in shipped pack schema",
        "rulesKind": None,
        "implemented": False,
        "blockedReason": "No FriendDemand mode records or var types exist in the shipped XT packs; the five variants wrap the same underlying modes (source only).",
        "source": ["GameLogic/RaceModes/RaceModeDefines.h:23-27",
                   "GameLogic/RaceModes/RaceModeFriendDemand*.cpp"],
    },
]

# capability per shipped event/race
for event in SP_EVENTS:
    kind = None
    if event["raceMode"] == "AmaxRaceModeStreetRace":
        kind = "race"
    elif event["raceMode"] == "AmaxRaceModeCheckpoint":
        kind = "checkpoint"
    elif event["raceMode"] == "AmaxRaceModeDestruction":
        kind = "destruction"
    elif event["raceMode"] == "AmaxRaceModeBossBattle":
        kind = "boss-battle"
    event["rulesKind"] = kind
    event["routeInfo"] = ROUTES.get(event["route"]["refId"])

for race in RACES:
    race["routeInfo"] = ROUTES.get(race["routeRefId"])
    race["rulesKind"] = {
        "racing": "race",
        "hardcore": "race-no-powerups",
        "destruction": "destruction",
    }.get(race["typeLabel"], None)

UNSUPPORTED = [
    {
        "field": "fanDemandThresholds",
        "status": "absent-from-shipped-schema",
        "reason": "AmaxRaceModeFanDemandVars is not in singleplayer.bin; no value can be recovered.",
    },
    {
        "field": "friendDemandModes",
        "status": "absent-from-shipped-schema",
        "reason": "No FriendDemand mode records in the XT packs.",
    },
    {
        "field": "splitLineCountPerEvent",
        "status": "not-serialized-in-mode-data",
        "reason": "AmaxEvent/MultiplayerRace do not store split line counts; split lines live in level actor data.",
    },
    {
        "field": "eliminationPerRaceValues",
        "status": "no-shipped-race-rows",
        "reason": "The RaceType enum has 'elimination' but all 439 MultiplayerRace rows are racing/hardcore/destruction.",
    },
    {
        "field": "pointsPerRaceValues",
        "status": "no-shipped-race-rows",
        "reason": "The RaceType enum has 'points' but no MultiplayerRace row uses it.",
    },
    {
        "field": "eliminationTypeAndEvent",
        "status": "runtime-only",
        "reason": "Custom-race UI settings, not serialized in MultiplayerRace; names recovered from MultiplayerData.cpp:495-509.",
    },
    {
        "field": "eliminationPeriodMultipliers",
        "status": "source-default-not-serialized",
        "reason": "GameLogic/RaceModes/RaceModeMultiplayerElimination.cpp:36-39 debug defaults 2.0, 1.0, 1, 1.",
    },
    {
        "field": "checkpointMedalBronzeThreshold",
        "status": "implicit",
        "reason": "bronze is 'timeLeft >= 0'; only silver and gold thresholds are serialized.",
    },
    {
        "field": "waveSizeBonuses",
        "status": "runtime-only",
        "reason": "Per-wave vehicle composition is serialized (AmaxRaceModeDestruction.waves), but wave-completion bonus points are computed in code.",
    },
    {
        "field": "locStringsForEventNames",
        "status": "partial",
        "reason": "Several AmaxEvent LocString ids (e.g. cbd10c37) and the T#E# names are not present in any shipped .loc; internal Name is the only recovered label.",
    },
    {
        "field": "amaxScoreTable",
        "status": "not-decoded",
        "reason": "The 97 AMAX scoring events are not decoded in this task; the Points mode uses the recovered 26-rule MultiplayerConfig table and records unknown events as unscored.",
    },
]

# ------------------------------------------------------------------ manifest
manifest = {
    "schema": "blur.race-rules.game-modes/1",
    "date": "2026-11-08",
    "scope": {
        "gameDataRecovered": True,
        "retailParity": False,
        "rulesOnly": True,
        "fullGame": False,
        "note": "Catalogue values are read from the shipped XT packs. Rules are an original state machine; no retail binary behaviour is claimed where the data or source is absent.",
    },
    "sources": {
        key: {k: v for k, v in decode_pak_entry(path).items() if k != "bytes"}
        for key, path in SOURCES.items()
    },
    "locTables": LOC_META,
    "decoder": {
        "path": "probes/race-rules/tools/xt_decode.py",
        "sha256": sha256((HERE / "xt_decode.py").read_bytes()),
        "locDecoder": "probes/race-rules/tools/loc_decode.py",
        "locDecoderSha256": sha256((HERE / "loc_decode.py").read_bytes()),
        "origin": "probes/powerups/tools/xt_decode.py (copied read-only)",
    },
    "enums": {
        "engineRaceMode": [{"name": n, "id": i, "note": note} for n, i, note in ENGINE_MODES],
        "raceType": [{"label": label, "labelIndex": i} for i, label in enumerate(RACE_TYPE_LABELS)],
        "damageMode": [{"label": label, "labelIndex": i} for i, label in enumerate(
            ["off", "low", "medium", "high", "one_hit"])],
        "powerupRespawn": [{"label": label, "labelIndex": i} for i, label in enumerate(
            ["Normal", "AlwaysOn", "Long", "VeryLong", "None"])],
        "lastManStanding": [{"label": label, "labelIndex": i} for i, label in enumerate(["Off", "On"])],
    },
    "schemas": {
        "AmaxEvent": {
            "typeIndex": SP_EVENT_TYPE,
            "size": SP.types[SP_EVENT_TYPE][5],
            "fields": {name: {"offset": f["offset"], "behaviour": f["behaviour"],
                              "array": f["array"], "typeIndex": f["typeIndex"]}
                       for name, f in field_meta(SP, SP_EVENT_TYPE).items()},
        },
        "MultiplayerRace": {
            "typeIndex": MP_RACE_TYPE,
            "size": MP.types[MP_RACE_TYPE][5],
            "fields": {name: {"offset": f["offset"], "behaviour": f["behaviour"],
                              "array": f["array"], "typeIndex": f["typeIndex"]}
                       for name, f in MP_RACE_FIELDS.items()},
        },
        "MultiplayerEvent": {
            "typeIndex": MP_EVENT_TYPE,
            "size": MP.types[MP_EVENT_TYPE][5],
            "fields": {name: {"offset": f["offset"], "behaviour": f["behaviour"],
                              "array": f["array"], "typeIndex": f["typeIndex"]}
                       for name, f in field_meta(MP, MP_EVENT_TYPE).items()},
        },
    },
    "modes": MODES,
    "singlePlayer": {
        "events": SP_EVENTS,
        "eventCount": len(SP_EVENTS),
        "career": {
            "tierDataRecordId": SP.record_id(TIER_RECORD),
            "tierDataRecordIndex": TIER_RECORD,
            "tiers": CAREER_TIERS,
            "bosses": CAREER_BOSSES,
            "eventCount": sum(len(tier["events"]) for tier in CAREER_TIERS),
        },
        "destructionScoring": SP_DESTRUCTION,
        "destructionScoringRecordId": RLDB.record_id(RL_RECORD),
        "destructionScoringRecordIndex": RL_RECORD,
    },
    "multiplayer": {
        "events": MP_EVENTS,
        "eventCount": len(MP_EVENTS),
        "races": RACES,
        "raceCount": len(RACES),
        "config": CONFIG,
    },
    "routes": {str(k): v for k, v in sorted(ROUTES.items())},
    "cities": {str(k): v for k, v in sorted(CITIES.items())},
    "unsupported": UNSUPPORTED,
}

manifest["hashes"] = {
    "content": canonical_hash(manifest),
}

OUT_DIR.mkdir(parents=True, exist_ok=True)
text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
OUT_FILE.write_bytes(text.encode())
file_sha = sha256(text.encode())
hashes = {
    "schema": "blur.race-rules.game-modes-hashes/1",
    "file": str(OUT_FILE.relative_to(ROOT)).replace("\\", "/"),
    "fileSha256": file_sha,
    "content": manifest["hashes"]["content"],
    "counts": {
        "spEvents": len(SP_EVENTS),
        "careerEvents": sum(len(tier["events"]) for tier in CAREER_TIERS),
        "careerTiers": len(CAREER_TIERS),
        "careerBosses": len(CAREER_BOSSES),
        "mpRaces": len(RACES),
        "mpEvents": len(MP_EVENTS),
        "routes": len(ROUTES),
        "cities": len(CITIES),
    },
}
(OUT_DIR / "game-modes-hashes.json").write_bytes(
    (json.dumps(hashes, indent=2, sort_keys=True) + "\n").encode())

print("events(sp):", len(SP_EVENTS))
print("career tiers:", len(CAREER_TIERS), "bosses:", len(CAREER_BOSSES),
      "career events:", sum(len(t["events"]) for t in CAREER_TIERS))
print("mp races:", len(RACES), "mp events:", len(MP_EVENTS))
print("routes:", len(ROUTES), "cities:", len(CITIES))
print("file:", OUT_FILE)
print("fileSha256:", file_sha)
print("content:", manifest["hashes"]["content"])
