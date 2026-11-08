"""Build the DMG1 damage-model manifest from the shipped XT packs + retail source.

Inputs (read-only):
  game-data/Blur/cache/gamedata.pak  ->  gamedata\\xt\\rldatabase.bin,
                                        gamedata\\xt\\multiplayer.bin,
                                        gamedata\\xt\\amax.bin,
                                        gamedata\\xt\\singleplayer.bin,
                                        gamedata\\xt\\pickups.bin
  _work/engine-vehicle-spike/tree/   ->  cited retail source lines
  probes/e1-drive/cars/roster.json   ->  e1 car roster identity

Output (not committed): _work/damage/damage.json

Every value is labelled:
  data         serialized XT value (offset recorded)
  code         recovered from the cited source line
  provisional  project policy, not retail
  unknown      not recovered
"""
from __future__ import annotations

import hashlib
import json
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "probes" / "powerups" / "tools"))
sys.path.insert(0, str(ROOT / "tools"))
import xt_decode  # noqa: E402  (read-only reuse of the bounded FLSK decoder)
from inspect_asset_layout import pak_index  # noqa: E402

GAME = ROOT / "game-data" / "Blur"
PACK = GAME / "cache" / "gamedata.pak"
SOURCE_ROOT = ROOT / "_work" / "engine-vehicle-spike" / "tree" / "code" / "amax"
OUT = ROOT / "_work" / "damage" / "damage.json"

PACK_FILES = {
    "rldatabase": "\\gamedata\\xt\\rldatabase.bin",
    "multiplayer": "\\gamedata\\xt\\multiplayer.bin",
    "amax": "\\gamedata\\xt\\amax.bin",
    "singleplayer": "\\gamedata\\xt\\singleplayer.bin",
    "pickups": "\\gamedata\\xt\\pickups.bin",
}

# (topic, relative path under code/amax, 1-based line)
CITATIONS = [
    ("health-wreck-bail", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 519),
    ("health-negative-clamp", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 533),
    ("health-max-clamp", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 535),
    ("wrecked-timer-duration", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 623),
    ("wrecked-timer-decrement", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 224),
    ("wrecked-timer-expiry", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 226),
    ("wrecked-ghost", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 725),
    ("damage-mode-gate", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 798),
    ("damage-apply", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 801),
    ("impact-level-damage-heavy", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1088),
    ("motor-mash-multiply", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1250),
    ("half-pip-floor", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1251),
    ("impact-mode-multiplier", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1387),
    ("perk-mode-multiplier", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 2324),
    ("impact-gameplay-impulse", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1746),
    ("impact-mass-normalise", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1749),
    ("impact-side-classify", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1751),
    ("impact-level-call", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1753),
    ("impact-cooldown-gate", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1845),
    ("impact-cooldown-set", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1857),
    ("perk-normal-damage", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 2293),
    ("perk-minor-halving", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 2298),
    ("perk-one-shot-kill", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 2391),
    ("perk-cooldown-set", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 2410),
    ("repair-adjust-health", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1001),
    ("health-increment", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1881),
    ("half-health-pip", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1244),
    ("mass-normalise-default", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1722),
    ("frontal-upright-dot", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 58),
    ("frontal-delta-dot", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 57),
    ("frontal-test-upright", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 2538),
    ("frontal-test-delta", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 2549),
    ("impact-powerups-only", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 1738),
    ("damage-enabled-on-race-start", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 2354),
    ("last-gasp-damage-cooldown", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 788),
    ("hog-reset-clears-in-progress", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 2455),
    ("repair-message", "game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp", 2372),
    ("impact-normalisation-range", "game/GameLogic/Layers/RaceLogicLayer.cpp", 2240),
    ("impact-normalised-value", "game/GameLogic/Layers/RaceLogicLayer.cpp", 2376),
    ("impact-gameplay-impulse-assign", "game/GameLogic/Layers/RaceLogicLayer.cpp", 2384),
    ("impact-level-function", "game/GameLogic/Layers/RaceLogicLayer.cpp", 3235),
    ("impact-bounds-compare", "game/GameLogic/Layers/RaceLogicLayer.cpp", 3245),
    ("inertia-human-human", "game/GameLogic/Layers/RaceLogicLayer.cpp", 1794),
    ("shield-weight-ultra", "game/GameLogic/Layers/RaceLogicLayer.cpp", 1806),
    ("weight-scale-light-medium", "game/GameLogic/Layers/RaceLogicLayer.cpp", 107),
    ("weight-scale-light-heavy", "game/GameLogic/Layers/RaceLogicLayer.cpp", 106),
    ("vehicle-base-health", "game/Game/GameActors/VehicleLogic/VehicleLogicActor.cpp", 1576),
    ("vehicle-extra-health-slots", "game/Game/GameActors/VehicleLogic/VehicleLogicActor.cpp", 1577),
    ("vehicle-start-health", "game/Game/GameActors/VehicleLogic/VehicleLogicActor.cpp", 1778),
    ("wrecked-duration-source", "game/Game/GameActors/VehicleLogic/VehicleLogicActor.cpp", 1422),
    ("ghost-disables-collisions", "game/Game/GameActors/VehicleLogic/VehicleLogicActor.cpp", 1622),
    ("hit-ghost-check", "game/GameLogic/Pickups/PickupBase.cpp", 209),
    ("hit-can-hit-rule", "game/GameLogic/Pickups/PickupBase.cpp", 212),
    ("always-shields", "game/GameLogic/Pickups/PickupBase.cpp", 238),
    ("shield-time-set", "game/GameLogic/Pickups/Normal/PickupShield.cpp", 68),
    ("shield-health-set", "game/GameLogic/Pickups/Normal/PickupShield.cpp", 69),
    ("shield-expiry", "game/GameLogic/Pickups/Normal/PickupShield.cpp", 144),
    ("supershield-time-set", "game/GameLogic/Pickups/Normal/PickupSuperShield.cpp", 54),
    ("supershield-mass", "game/GameLogic/Pickups/Normal/PickupSuperShield.cpp", 66),
    ("shield-absorb-gate", "game/Game/GameActors/Components/VehicleLogic/VLC_Pickups.cpp", 1633),
    ("shield-shock-drain", "game/Game/GameActors/Components/VehicleLogic/VLC_Pickups.cpp", 1615),
    ("shield-no-hp-comment", "game/Game/GameActors/Components/VehicleLogic/VLC_Pickups.cpp", 1613),
    ("ram-shield-state", "game/Game/GameActors/Components/VehicleLogic/VLC_Pickups.cpp", 2289),
    ("ram-condition", "game/Game/GameActors/Components/VehicleLogic/VLC_Pickups.cpp", 2298),
    ("ram-cooldown-set", "game/Game/GameActors/Components/VehicleLogic/VLC_Pickups.cpp", 2332),
    ("ram-force-damage", "game/Game/GameActors/Components/VehicleLogic/VLC_Pickups.cpp", 2336),
    ("ram-cooldown-default", "game/Game/GameActors/Components/VehicleLogic/VLC_Pickups.cpp", 115),
    ("respawn-spline", "game/Game/GameActors/Components/VehicleLogic/HandofGod/VLC_HandOfGod.cpp", 1636),
    ("respawn-start-position", "game/Game/GameActors/Components/VehicleLogic/HandofGod/VLC_HandOfGod.cpp", 1641),
    ("respawn-ghost-wrecked", "game/Game/GameActors/Components/VehicleLogic/HandofGod/VLC_HandOfGod.cpp", 1085),
    ("respawn-ghost-apply", "game/Game/GameActors/Components/VehicleLogic/HandofGod/VLC_HandOfGod.cpp", 1032),
    ("wrecked-default", "game/GameLogic/Structures/LevelState.cpp", 154),
    ("default-damage-mode", "game/GameLogic/Structures/LevelState.cpp", 137),
    ("default-damage-multiplier", "game/GameLogic/Structures/LevelState.cpp", 139),
    ("mp-damage-mode", "game/GameLogic/PlayMode/Playlist.cpp", 262),
    ("mp-damage-multiplier", "game/GameLogic/PlayMode/Playlist.cpp", 263),
    ("mp-wrecked-behaviour", "game/GameLogic/PlayMode/Playlist.cpp", 264),
    ("damage-mode-off", "library/Ui/game/Multiplayer/MultiplayerHelpers.cpp", 295),
    ("damage-mode-one-hit", "library/Ui/game/Multiplayer/MultiplayerHelpers.cpp", 307),
    ("damage-multiplier-high", "library/Ui/game/Multiplayer/MultiplayerHelpers.cpp", 317),
    ("damage-mode-enum", "library/Ui/game/Multiplayer/MultiplayerDefines.h", 91),
    ("destruction-powerups-only", "game/GameLogic/RaceModes/RaceModeDestruction.cpp", 185),
    ("destruction-no-respawn", "game/GameLogic/RaceModes/RaceModeDestruction.cpp", 186),
    ("destruction-ai-health-easy", "game/GameLogic/RaceModes/RaceModeDestruction.cpp", 383),
    ("destruction-ai-health-medium", "game/GameLogic/RaceModes/RaceModeDestruction.cpp", 387),
    ("destruction-ai-health-hard", "game/GameLogic/RaceModes/RaceModeDestruction.cpp", 391),
    ("mp-health-replicated-read", "game/GameLogic/RaceModes/RaceModeMultiplayer.cpp", 1055),
    ("mp-health-replicated-apply", "game/GameLogic/RaceModes/RaceModeMultiplayer.cpp", 1080),
    ("network-health-set", "game/Game/GameActors/Components/VehicleLogic/Multiplayer/VLC_Network_Damage.cpp", 56),
    ("network-shield-impulse-zero", "game/Game/GameActors/Components/VehicleLogic/Multiplayer/VLC_Network_Damage.cpp", 152),
    ("event-damage-modifier", "game/GameLogic/GameData/GameEventData.h", 325),
    ("event-powerup-damage-modifier", "game/GameLogic/GameData/GameEventData.h", 326),
    ("struct-impact-type", "game/GameLogic/RaceLogicCore/Database/RLDatabase.h", 797),
    ("struct-health-zone", "game/GameLogic/RaceLogicCore/Database/RLDatabase.h", 853),
    ("struct-damage-parameters", "game/GameLogic/RaceLogicCore/Database/RLDatabase.h", 891),
    ("struct-damage-system", "game/GameLogic/RaceLogicCore/Database/RLDatabase.h", 919),
    ("enum-impact-level", "game/GameLogic/RaceLogicCore/Data/RLEnums.h", 175),
    ("enum-health-level", "game/GameLogic/RaceLogicCore/Data/RLEnums.h", 190),
    ("enum-damage-mode", "game/GameLogic/RaceLogicCore/Data/RLEnums.h", 202),
    ("hud-max-segments", "library/Ui/game/Gadgets/Hud/UIDamage.cpp", 216),
    ("hud-full-segments", "library/Ui/game/Gadgets/Hud/UIDamage.cpp", 335),
    ("hud-segment-remainder", "library/Ui/game/Gadgets/Hud/UIDamage.cpp", 336),
    ("nitrous-rift-minor", "game/GameLogic/Pickups/Reverse/PickupNitrousReverse.cpp", 65),
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_pak_entry(index: dict, path: str) -> dict:
    entry = next(r for r in index["entries"] if r["path"].lower() == path.lower())
    with PACK.open("rb") as stream:
        stream.seek(entry["offset"])
        stored = stream.read(entry["stored_bytes"])
    data = zlib.decompressobj().decompress(stored, entry["logical_bytes"] + 1)
    if len(data) != entry["logical_bytes"]:
        raise SystemExit(f"{path}: decoded size mismatch")
    return {
        "path": entry["path"],
        "offset": entry["offset"],
        "storedBytes": entry["stored_bytes"],
        "logicalBytes": entry["logical_bytes"],
        "pathCrc32": entry["path_crc32"],
        "sha256Decoded": sha256(data),
        "bytes": data,
    }


def flask(source: dict) -> xt_decode.Flask:
    return xt_decode.Flask(source["bytes"])


def component_base(f: xt_decode.Flask, record: int, comp: int, elem: int = 0) -> int:
    typ, _count, behaviour = f.components[f._component_start[record] + comp]
    if behaviour != 0:
        raise SystemExit("component is not inline")
    stride = f.types[typ][5]
    return f._component_offset(record, comp) + elem * stride


def field_offset(f: xt_decode.Flask, type_index: int, name: str) -> int:
    for field in f.all_fields(type_index):
        if field["name"] == name:
            return field["offset"]
    raise SystemExit(f"field {name} not in {f.type_name(type_index)}")


def read_f32(f: xt_decode.Flask, record: int, base: int, type_index: int, name: str) -> float:
    import struct
    payload = f.record_payload(record)
    return struct.unpack_from("<f", payload, base + field_offset(f, type_index, name))[0]


def read_i32(f: xt_decode.Flask, record: int, base: int, type_index: int, name: str) -> int:
    import struct
    payload = f.record_payload(record)
    return struct.unpack_from("<i", payload, base + field_offset(f, type_index, name))[0]


def read_u8(f: xt_decode.Flask, record: int, base: int, type_index: int, name: str) -> int:
    import struct
    payload = f.record_payload(record)
    return struct.unpack_from("<B", payload, base + field_offset(f, type_index, name))[0]


def read_bool(f: xt_decode.Flask, record: int, base: int, type_index: int, name: str) -> bool:
    import struct
    payload = f.record_payload(record)
    return struct.unpack_from("<I", payload, base + field_offset(f, type_index, name))[0] != 0


def citation_rows() -> list[dict]:
    rows = []
    files = {}
    for topic, rel, line_no in CITATIONS:
        path = SOURCE_ROOT / rel
        if not path.exists():
            raise SystemExit(f"citation file missing: {rel}")
        data = path.read_bytes()
        digest = sha256(data)
        files[rel] = digest
        lines = data.decode("utf-8", errors="replace").splitlines()
        if not 1 <= line_no <= len(lines):
            raise SystemExit(f"citation line out of range: {rel}:{line_no}")
        text = lines[line_no - 1].strip()
        if not text:
            raise SystemExit(f"citation line empty: {rel}:{line_no}")
        rows.append({"topic": topic, "file": rel, "line": line_no, "text": text,
                     "sha256": digest})
    return rows, dict(sorted(files.items()))


def main() -> None:
    index = pak_index(PACK)
    sources = {}
    flakes = {}
    for key, pack_path in PACK_FILES.items():
        sources[key] = load_pak_entry(index, pack_path)
        flakes[key] = flask(sources[key])

    rld = flakes["rldatabase"]
    mp = flakes["multiplayer"]
    amax = flakes["amax"]
    sp = flakes["singleplayer"]
    pick = flakes["pickups"]

    # ---------------------------------------------------------------- System
    system_record = next(ri for ri in range(len(rld.records))
                         if rld.type_name(rld.record_type(ri)) == "System")
    system_doc = rld.decode_record(system_record)
    damage_system_record = system_doc["DamageSystem"]["record"]
    hog_record = system_doc["HandOfGodParameters"]["record"]
    if rld.record_id(damage_system_record) != 2981908992:
        raise SystemExit("DamageSystem refId moved")
    if rld.record_id(hog_record) != 100390132:
        raise SystemExit("HandOfGodParameters refId moved")

    sys_type = rld.record_type(damage_system_record)
    ds_base = component_base(rld, damage_system_record, 0)
    params_handle = system_doc["DamageSystem"]["value"]["Parameters"]
    params_record = params_handle["record"]
    if params_record != 33:
        raise SystemExit("DamageParameters record moved")
    params_type = rld.record_type(params_record)
    params_base = component_base(rld, params_record, 0)

    # DamageParameters scalars
    def pf(name):
        return read_f32(rld, params_record, params_base, params_type, name)

    def pi(name):
        return read_i32(rld, params_record, params_base, params_type, name)

    def pb(name):
        return read_bool(rld, params_record, params_base, params_type, name)

    damage_parameters = {
        "record": params_record,
        "refId": rld.record_id(params_record),
        "payloadBytes": len(rld.record_payload(params_record)),
        "structOffset": params_base,
        "fields": {
            "MaxWorldDamageImpulse": {"value": pf("MaxWorldDamageImpulse"), "offset": params_base + field_offset(rld, params_type, "MaxWorldDamageImpulse")},
            "MaxWorldEffectImpulse": {"value": pf("MaxWorldEffectImpulse"), "offset": params_base + field_offset(rld, params_type, "MaxWorldEffectImpulse")},
            "MaxVehicleDamageImpulse": {"value": pf("MaxVehicleDamageImpulse"), "offset": params_base + field_offset(rld, params_type, "MaxVehicleDamageImpulse")},
            "MaxVehicleEffectImpulse": {"value": pf("MaxVehicleEffectImpulse"), "offset": params_base + field_offset(rld, params_type, "MaxVehicleEffectImpulse")},
            "MaxObjectDamageImpulse": {"value": pf("MaxObjectDamageImpulse"), "offset": params_base + field_offset(rld, params_type, "MaxObjectDamageImpulse")},
            "MaxObjectEffectImpulse": {"value": pf("MaxObjectEffectImpulse"), "offset": params_base + field_offset(rld, params_type, "MaxObjectEffectImpulse")},
            "MaxStaticImpulse": {"value": pf("MaxStaticImpulse"), "offset": params_base + field_offset(rld, params_type, "MaxStaticImpulse")},
            "MaxDynamicImpulse": {"value": pf("MaxDynamicImpulse"), "offset": params_base + field_offset(rld, params_type, "MaxDynamicImpulse")},
            "HitByPerkCooldown": {"value": pf("HitByPerkCooldown"), "offset": params_base + field_offset(rld, params_type, "HitByPerkCooldown")},
            "CollidedCooldown": {"value": pf("CollidedCooldown"), "offset": params_base + field_offset(rld, params_type, "CollidedCooldown")},
            "HealthIncrement": {"value": pi("HealthIncrement"), "offset": params_base + field_offset(rld, params_type, "HealthIncrement")},
            "LightImpactDamage": {"value": pi("LightImpactDamage"), "offset": params_base + field_offset(rld, params_type, "LightImpactDamage")},
            "MediumImpactDamage": {"value": pi("MediumImpactDamage"), "offset": params_base + field_offset(rld, params_type, "MediumImpactDamage")},
            "HeavyImpactDamage": {"value": pi("HeavyImpactDamage"), "offset": params_base + field_offset(rld, params_type, "HeavyImpactDamage")},
            "ResetTimerAfterWrecked": {"value": pf("ResetTimerAfterWrecked"), "offset": params_base + field_offset(rld, params_type, "ResetTimerAfterWrecked")},
            "CapGameplayImpulse": {"value": pb("CapGameplayImpulse"), "offset": params_base + field_offset(rld, params_type, "CapGameplayImpulse")},
        },
    }
    groups = [{"group": g["HealthGroup"]["label"], "baseHealth": g["BaseHealth"]}
              for g in rld.decode_record(params_record)["VehicleHealthGroups"]["items"]]
    damage_parameters["vehicleHealthGroups"] = groups

    inertia = rld.decode_record(params_record)["IntraVehicularCollisionInertiaScale"]
    damage_parameters["inertiaScale"] = {k: inertia[k] for k in inertia if k != "$type"}

    # Impact types in DamageSystem array order.
    impact_types = []
    for item in system_doc["DamageSystem"]["value"]["ImpactTypes"]["items"]:
        value = item["value"]
        impact_types.append({
            "record": item["record"],
            "refId": item["refId"],
            "level": value["ImpactLevel"]["label"],
            "front": {"min": value["ImpulseBounds"]["Min"], "max": value["ImpulseBounds"]["Max"]},
            "side": {"min": value["SideImpulseBounds"]["Min"], "max": value["SideImpulseBounds"]["Max"]},
        })

    health_zones = []
    for item in system_doc["DamageSystem"]["value"]["HealthZones"]["items"]:
        value = item["value"]
        health_zones.append({
            "record": item["record"],
            "refId": item["refId"],
            "zone": value["HealthZone"]["label"],
            "min": value["HealthMin"],
            "max": value["HealthMax"],
        })

    # HandOfGod standard ghost parameters.
    hog_doc = rld.decode_record(hog_record)
    hog_type = rld.record_type(hog_record)
    hog_base = component_base(rld, hog_record, 0)
    ghost_base = hog_base + field_offset(rld, hog_type, "StandardGhostParameters")
    ghost = rld.decode_record(hog_record)["StandardGhostParameters"]

    hand_of_god = {
        "record": hog_record,
        "refId": rld.record_id(hog_record),
        "ghostAfterHoG": ghost["GhostTimeAfterHoG"],
        "ghostAfterWrecked": ghost["GhostTimeAfterWrecked"],
        "waitTime": hog_doc["WaitTime"],
        "resetTimer": hog_doc["ResetTimer"],
        "standardGhostOffset": ghost_base,
    }

    # ------------------------------------------------------- MultiplayerConfig
    mp_record = next(ri for ri in range(len(mp.records))
                     if mp.type_name(mp.record_type(ri)) == "MultiplayerConfig")
    mp_doc = mp.decode_record(mp_record)
    mp_type = mp.record_type(mp_record)
    mp_base = component_base(mp, mp_record, 0)
    mm_field = field_offset(mp, mp_type, "motor_mash_damage_multiplier")
    mm_values_field = field_offset(mp, mp_type, "damage_multiplier_values")
    lg_field = field_offset(mp, mp_type, "last_gasp_mod_settings")
    respawn_field = field_offset(mp, mp_type, "powerup_respawn_toggle_long")

    mp_config = {
        "record": mp_record,
        "refId": mp.record_id(mp_record),
        "payloadBytes": len(mp.record_payload(mp_record)),
        "motorMashDamageMultiplier": read_u8(mp, mp_record, mp_base, mp_type, "motor_mash_damage_multiplier"),
        "motorMashOffset": mp_base + mm_field,
        "damageMultipliers": dict(mp_doc["damage_multiplier_values"]),
        "damageMultipliersOffset": mp_base + mm_values_field,
        "lastGasp": {k: v for k, v in mp_doc["last_gasp_mod_settings"].items() if k != "$type"},
        "lastGaspOffset": mp_base + lg_field,
        "powerupRespawnToggleLong": mp_doc["powerup_respawn_toggle_long"],
        "powerupRespawnToggleVeryLong": mp_doc["powerup_respawn_toggle_very_long"],
        "respawnToggleOffset": mp_base + respawn_field,
        "motormashRespawnDelayMultipliers": mp_doc["motormash_respawn_delay_multipliers"]["items"],
        "aiAverageMpRank": {
            "easy": mp_doc["ai_average_mp_rank_easy"],
            "medium": mp_doc["ai_average_mp_rank_medium"],
            "hard": mp_doc["ai_average_mp_rank_hard"],
            "spread": mp_doc["ai_mp_rank_spread"],
        },
    }

    # Damage-mode distribution across MultiplayerRace records.
    distribution = {}
    races = 0
    for ri in range(len(mp.records)):
        if mp.type_name(mp.record_type(ri)) != "MultiplayerRace":
            continue
        races += 1
        label = mp.decode_record(ri)["damage_mode"]["label"]
        distribution[label] = distribution.get(label, 0) + 1
    mp_config["races"] = races
    mp_config["damageModeDistribution"] = dict(sorted(distribution.items()))

    # -------------------------------------------------------------- pickups
    def pickup_entity(label: str) -> dict:
        for ri in range(len(pick.records)):
            if pick.type_name(pick.record_type(ri)) != "PickupType":
                continue
            doc = pick.decode_record(ri)
            if doc.get("Type", {}).get("label") == label:
                return {"record": ri, "refId": pick.record_id(ri), "doc": doc}
        raise SystemExit(f"pickup {label} missing")

    def level_payload(level_record: int) -> tuple[dict, int, int]:
        level_doc = pick.decode_record(level_record)
        comp = int.from_bytes(pick.record_payload(level_record)[12:14], "little")
        elem = int.from_bytes(pick.record_payload(level_record)[14:16], "little")
        typ, _count, behaviour = pick.components[pick._component_start[level_record] + comp]
        if behaviour != 0:
            raise SystemExit("balancing pointer target is not inline")
        stride = pick.types[typ][5]
        base = pick._component_offset(level_record, comp) + elem * stride
        return level_doc, base, typ

    def weapon_row(label: str, slots: tuple[str, ...]) -> dict:
        ent = pickup_entity(label)
        out = {"entityRecord": ent["record"], "typeRefId": ent["refId"], "levels": {}}
        for slot in slots:
            handle = ent["doc"].get(slot)
            if not handle or not handle.get("record"):
                continue
            level_record = handle["record"]
            level_doc, base, typ = level_payload(level_record)
            bal = level_doc.get("BalancingData")
            if not isinstance(bal, dict) or not bal.get("$type"):
                raise SystemExit(f"{label}.{slot} has no balancing data")
            damage = bal.get("DamageInflicted")
            damage_offset = None
            if damage is not None:
                damage_offset = base + field_offset(pick, typ, "DamageInflicted")
            out["levels"][slot] = {
                "levelRecord": level_record,
                "levelRefId": pick.record_id(level_record),
                "balancingType": bal["$type"],
                "balancingPayloadOffset": base,
                "damageInflicted": damage,
                "damageOffset": damage_offset,
                "health": bal.get("Health"),
                "lifetime": bal.get("Lifetime"),
            }
        return out

    weapons = {
        "Nitrous": weapon_row("Nitrous", ("Normal", "Reversed")),
        "Shock": weapon_row("Shock", ("Normal", "DoubleTap")),
        "Shunt": weapon_row("Shunt", ("Normal", "Reversed")),
        "Blindfire": weapon_row("Blindfire", ("Normal", "Reversed", "Modified")),
        "Barge": weapon_row("Barge", ("Normal",)),
        "Bomb": weapon_row("Bomb", ("Normal", "Mini", "Reversed")),
        "Shield": weapon_row("Shield", ("Normal", "DoubleTap")),
        "Repair": weapon_row("Repair", ("Normal",)),
        "SuperShield": weapon_row("SuperShield", ("Normal",)),
    }

    repair_ent = pickup_entity("Repair")
    repair_level = repair_ent["doc"]["Normal"]["record"]
    repair_doc, repair_base, repair_type = level_payload(repair_level)
    repair_amount = repair_doc["BalancingData"]["AmountToRepair"]
    repair_offset = repair_base + field_offset(pick, repair_type, "AmountToRepair")

    shield_ent = pickup_entity("Shield")
    shield_level = shield_ent["doc"]["Normal"]["record"]
    shield_doc, shield_base, shield_type = level_payload(shield_level)
    shield_bal = shield_doc["BalancingData"]
    shield_cfg = {
        "lifetime": shield_bal["Lifetime"],
        "lifetimeOffset": shield_base + field_offset(pick, shield_type, "Lifetime"),
        "health": shield_bal["Health"],
        "healthOffset": shield_base + field_offset(pick, shield_type, "Health"),
    }
    shield_dt_level = shield_ent["doc"]["DoubleTap"]["record"]
    dt_doc, dt_base, dt_type = level_payload(shield_dt_level)
    shield_cfg["doubleTap"] = {
        "lifetime": dt_doc["BalancingData"]["Lifetime"],
        "lifetimeOffset": dt_base + field_offset(pick, dt_type, "Lifetime"),
        "health": dt_doc["BalancingData"]["Health"],
    }
    super_ent = pickup_entity("SuperShield")
    super_level = super_ent["doc"]["Normal"]["record"]
    super_doc, super_base, super_type = level_payload(super_level)
    super_bal = super_doc["BalancingData"]
    shield_cfg["superShield"] = {
        "lifetime": super_bal["Lifetime"],
        "lifetimeOffset": super_base + field_offset(pick, super_type, "Lifetime"),
        "damagePointsOnImpact": super_bal["DamagePointsOnImpact"],
        "damageOffset": super_base + field_offset(pick, super_type, "DamagePointsOnImpact"),
        "health": super_bal["Health"],
        "increasedMass": super_bal["IncreasedMass"],
        "nitroTargetSpeedInMPH": super_bal["NitroTargetSpeedInMPH"],
    }
    nitro_ent = pickup_entity("Nitrous")
    nitro_level = nitro_ent["doc"]["Normal"]["record"]
    nitro_doc, nitro_base, nitro_type = level_payload(nitro_level)
    shield_cfg["nitroDuration"] = nitro_doc["BalancingData"]["Duration"]
    shield_cfg["nitroDurationOffset"] = nitro_base + field_offset(pick, nitro_type, "Duration")

    # ------------------------------------------------------------ roster health
    roster = json.loads((ROOT / "probes" / "e1-drive" / "cars" / "roster.json").read_text(encoding="utf-8"))
    by_dynamics = {c["recordId"]: c["slug"] for c in roster["cars"]}
    roster_rows: dict[str, dict] = {}
    for ri in range(len(amax.records)):
        if amax.type_name(amax.record_type(ri)) != "AmaxVehicle":
            continue
        doc = amax.decode_record(ri)
        dyn = doc.get("dynamics")
        if not dyn or not dyn.get("refId"):
            continue
        slug = by_dynamics.get(dyn["refId"])
        if not slug:
            continue
        group = doc["HealthGroup"]["label"]
        row = roster_rows.setdefault(slug, {"healthGroup": group, "candidates": []})
        if row["healthGroup"] != group:
            row["healthGroup"] = "ambiguous"
        row["candidates"].append({
            "amaxRecord": ri,
            "amaxRefId": amax.record_id(ri),
            "name": doc["Name"]["value"],
            "healthGroup": group,
            "weightClass": doc["weightClass"]["label"],
        })
    bases = {g["group"]: g["baseHealth"] for g in groups}
    for slug, row in roster_rows.items():
        row["baseHealth"] = bases.get(row["healthGroup"]) if row["healthGroup"] in bases else None
        row["healthProvenance"] = "data" if row["healthGroup"] in bases else "ambiguous"

    # -------------------------------------------------------- single player
    sp_events = 0
    sp_modifiers = {"DamageModifier": {}, "PowerUpDamageModifier": {}}
    sp_opponents = {"total": 0, "healthOverride": {}, "alwaysShields": 0, "onlyAttacksPlayer": 0}
    for ri in range(len(sp.records)):
        if sp.type_name(sp.record_type(ri)) != "AmaxEvent":
            continue
        sp_events += 1
        doc = sp.decode_record(ri)
        for diff in ("Easy", "Medium", "Hard"):
            block = doc.get(diff) or {}
            for key in ("DamageModifier", "PowerUpDamageModifier"):
                v = block.get(key)
                if v is None:
                    continue
                bucket = sp_modifiers[key]
                label = f"{diff}:{v}"
                bucket[label] = bucket.get(label, 0) + 1
        for opp in (doc.get("Opponents") or {}).get("items", []):
            sp_opponents["total"] += 1
            h = opp.get("HealthOverride")
            sp_opponents["healthOverride"][str(h)] = sp_opponents["healthOverride"].get(str(h), 0) + 1
            if opp.get("AlwaysShields"):
                sp_opponents["alwaysShields"] += 1
            if opp.get("OnlyAttacksPlayer"):
                sp_opponents["onlyAttacksPlayer"] += 1

    # ------------------------------------------------------------ citations
    citations, source_hashes = citation_rows()

    manifest = {
        "kind": "damage-model.recovery",
        "version": 1,
        "generatedBy": "probes/damage/tools/build_damage.py",
        "provenance": {
            "data": "serialized XT value at the recorded record/offset",
            "code": "recovered from the cited retail source line",
            "provisional": "project policy; not a retail value",
            "unknown": "not recovered; no value is guessed",
        },
        "sources": [
            {k: v for k, v in sources[key].items() if k != "bytes"} for key in PACK_FILES
        ],
        "sourceCode": {
            "root": "_work/engine-vehicle-spike/tree/code/amax",
            "files": source_hashes,
            "citations": citations,
        },
        "health": {
            "increment": damage_parameters["fields"]["HealthIncrement"]["value"],
            "incrementOffset": damage_parameters["fields"]["HealthIncrement"]["offset"],
            "startHealth": "maxHealth - 1",
            "wreckThreshold": 0,
            "extraHealthPerSlot": damage_parameters["fields"]["HealthIncrement"]["value"],
            "groups": groups,
            "zones": health_zones,
            "regen": None,
            "zonesOrder": [z["zone"] for z in health_zones],
            "zoneMatch": "health > min && health <= max",
            "provenance": "data (rldatabase.bin System->DamageSystem->Parameters)",
        },
        "impact": {
            "gameplayImpulseField": "C_ImpactMsg.mCollisionInfo.m_GameplayImpulse",
            "normalisation": {
                "dynamicDynamic": damage_parameters["fields"]["MaxDynamicImpulse"]["value"],
                "static": damage_parameters["fields"]["MaxStaticImpulse"]["value"],
                "rule": "clamp(rawImpulseNs / range, 0, 1); range = bothBodiesDynamic ? MaxDynamicImpulse : MaxStaticImpulse",
            },
            "massNormalisation": {
                "enabled": True,
                "referenceMassKg": 1500.0,
                "rule": "scaledImpulse = gameplayImpulse * (1500 / victimMassKg)",
            },
            "types": impact_types,
            "damage": {
                "LightImpact": damage_parameters["fields"]["LightImpactDamage"]["value"],
                "MediumImpact": damage_parameters["fields"]["MediumImpactDamage"]["value"],
                "HeavyImpact": damage_parameters["fields"]["HeavyImpactDamage"]["value"],
            },
            "bucketRule": "first type with scaledImpulse > min && scaledImpulse <= max, in array order",
            "frontality": {
                "uprightDot": 0.707,
                "localDeltaDot": 0.85,
                "rule": "frontal if up.y > 0.707 and |localVelocityChange.z| > 0.85; else side",
            },
            "cooldownSeconds": damage_parameters["fields"]["CollidedCooldown"]["value"],
            "cooldownAppliesToZeroDamage": True,
            "cooldownGate": "impact damage skipped while victim cooldown > 0; cooldown set after every classified impact",
            "powerupsOnlyMode": "impacts do no damage and only camera effects run",
            "inertiaScale": damage_parameters["inertiaScale"],
            "vehicleWeightScales": {
                "lightToHeavy": 1.0,
                "lightToMedium": 1.1,
                "mediumToHeavy": 1.25,
                "lightToUltra": 1.3,
                "mediumToUltra": 1.3,
                "heavyToUltra": 1.1,
            },
            "provenance": "data (parameters/impact types) + code (normalisation/classification)",
        },
        "perk": {
            "cooldownSeconds": damage_parameters["fields"]["HitByPerkCooldown"]["value"],
            "cooldownGate": "perk hits do not check the victim cooldown; they set it",
            "minorHalving": ["Shunt", "Shock"],
            "minorHalvingRule": "damage = damage / 2 (integer) when hitType is MINOR and type is Shunt or Shock",
            "harmfulTypes": ["Shock", "Shunt", "Blindfire", "Barge", "Bomb", "SuperShield"],
            "nonHarmfulTypes": ["Nitrous", "Repair", "Shield"],
            "damageModes": {
                "normal": {"engine": "E_DAMAGE_MODE_NORMAL", "perkMultiplier": 1.0, "impacts": "normal"},
                "off": {"engine": "E_DAMAGE_MODE_INVULNERABLE", "perkMultiplier": 0.0, "impacts": "none"},
                "low": {"engine": "E_DAMAGE_MODE_MULTIPLIER", "perkMultiplier": 0.5, "impacts": "normal"},
                "medium": {"engine": "E_DAMAGE_MODE_MULTIPLIER", "perkMultiplier": 1.0, "impacts": "normal"},
                "high": {"engine": "E_DAMAGE_MODE_MULTIPLIER", "perkMultiplier": 2.0, "impacts": "normal"},
                "one-hit": {"engine": "E_DAMAGE_MODE_ONE_SHOT_KILL", "perkMultiplier": None, "impacts": "normal"},
                "powerups-only": {"engine": "E_DAMAGE_MODE_POWERUPS_ONLY", "perkMultiplier": 1.0, "impacts": "none"},
            },
            "multipliers": mp_config["damageMultipliers"],
            "motorMashDamageMultiplier": mp_config["motorMashDamageMultiplier"],
            "motorMashRule": "damage = int(damage * multiplier); damage -= damage % (HealthIncrement / 2)",
            "motorMashApplies": ["racing", "destruction"],
            "oneShotKillRule": "perk damage = maxHealth; impact path unchanged",
            "weapons": weapons,
        },
        "shield": {
            "absorbModel": "time-window",
            "blocksImpacts": True,
            "nitrousBypass": True,
            "shockDrainDamage": weapons["Shock"]["levels"]["Normal"]["damageInflicted"],
            "normal": {
                "lifetime": shield_cfg["lifetime"],
                "health": shield_cfg["health"],
                "ramActive": False,
                "refreshOnReactivate": True,
            },
            "doubleTap": {
                "lifetime": shield_cfg["doubleTap"]["lifetime"],
                "health": shield_cfg["doubleTap"]["health"],
                "ramActive": True,
                "refreshOnReactivate": True,
            },
            "superShield": {
                "lifetime": shield_cfg["superShield"]["lifetime"],
                "health": shield_cfg["superShield"]["health"],
                "healthUsed": False,
                "ramActive": True,
                "ramDamage": shield_cfg["superShield"]["damagePointsOnImpact"],
                "refreshOnReactivate": False,
                "increasedMass": shield_cfg["superShield"]["increasedMass"],
                "nitroTargetSpeedInMPH": shield_cfg["superShield"]["nitroTargetSpeedInMPH"],
            },
            "ramCooldownSeconds": 1.0,
            "ramRule": "rammer must be double-shielded or super-shielded; victim must not be; force damage 100 only for SuperShield",
            "nitroDuration": shield_cfg["nitroDuration"],
            "provenance": "data (Shield/SuperShield/Nitrous levels) + code (absorb/ram/expiry)",
        },
        "wreck": {
            "threshold": "health <= 0",
            "durationSeconds": damage_parameters["fields"]["ResetTimerAfterWrecked"]["value"],
            "durationSource": "RLDamageParameters.mResetTimerAfterWrecked",
            # VLC_Damage.cpp:725 ghosts for `mWreckedTimer + 2`; the reset at expiry
            # re-applies Ghost(2.0), so the window closes 2 s after the respawn.
            "ghostFromWreckSeconds": damage_parameters["fields"]["ResetTimerAfterWrecked"]["value"] + 2.0,
            "ghostAfterRespawnSeconds": hand_of_god["ghostAfterWrecked"],
            "ghostAfterHogSeconds": hand_of_god["ghostAfterHoG"],
            "behaviourDefault": "respawn",
            "behaviours": ["respawn", "eliminate", "do-nothing"],
            "respawnPosition": {
                "rule": "AI spline last valid position when AI data exists; otherwise best start position; reset zone overrides both",
                "status": "runtime",
            },
            "respawnHealth": {
                "policy": "maxHealth - 1",
                "status": "provisional",
                "note": "ResetHealth sets maxHealth-1 at actor creation; no racing-mode respawn health restore was found in the extracted path. Destruction calls ResetHealth on AI (re)activation.",
            },
            "actionCooldownSeconds": mp_config["lastGasp"]["damage_cooldown"],
            "wreckedSequenceDelaySeconds": mp_config["lastGasp"]["wrecked_sequence_delay"],
            "jumpTheGunReductionMultiplier": mp_config["lastGasp"]["last_gasp_wrecked_sequence_reduction_multiplier"],
            "provenance": "data (ResetTimerAfterWrecked/ghost) + code (respawn target) + provisional (respawn health)",
        },
        "modes": {
            "multiplayer": {
                "races": mp_config["races"],
                "damageModeDistribution": mp_config["damageModeDistribution"],
                "defaultDamageMode": "medium",
                "damageMultipliers": mp_config["damageMultipliers"],
                "motorMashDamageMultiplier": mp_config["motorMashDamageMultiplier"],
                "wreckedBehaviour": "respawn unless lastmanstanding is On -> eliminate",
                "respawnHealth": "peer-replicated; local restore is project policy",
            },
            "destruction": {
                "damageMode": "powerups-only",
                "wreckedBehaviour": "do-nothing",
                "aiHealthOverride": {
                    "Easy": weapons["Blindfire"]["levels"]["Normal"]["damageInflicted"],
                    "Medium": 2 * weapons["Blindfire"]["levels"]["Normal"]["damageInflicted"],
                    "Hard": 3 * weapons["Blindfire"]["levels"]["Normal"]["damageInflicted"],
                    "VeryHard": weapons["Blindfire"]["levels"]["Normal"]["damageInflicted"],
                },
                "aiHealthOverrideSource": "damageInflicted = Blindfire Normal DamageInflicted (50)",
            },
            "singlePlayer": {
                "events": sp_events,
                "damageMode": "normal",
                "damageMultiplier": 1.0,
                "damageModifierValues": sp_modifiers["DamageModifier"],
                "powerUpDamageModifierValues": sp_modifiers["PowerUpDamageModifier"],
                "consumedInRecoveredSource": False,
                "note": "AmaxEvent difficulty DamageModifier/PowerUpDamageModifier are serialized and bound but never read in the extracted source.",
            },
        },
        "ai": {
            "mpRank": mp_config["aiAverageMpRank"],
            "opponents": sp_opponents,
            "alwaysShields": "one opponent setup; RegisterHit spawns a normal Shield instead of damage",
            "difficultyDamageEffect": "none recovered; AI difficulty drives driving, not damage",
        },
        "roster": roster_rows,
        "damageParameters": damage_parameters,
        "multiplayerConfig": mp_config,
        "handOfGod": hand_of_god,
        "repair": {
            "amount": repair_amount,
            "amountOffset": repair_offset,
            "levelRecord": repair_level,
            "rule": "AdjustHealth(amount); clamps to maxHealth-1; amount 0 means full",
            "wrecked": "refused by CheckCanHit",
        },
        "unknowns": [
            {"id": "respawn-health-racing", "status": "unknown",
             "reason": "no racing-mode local respawn health restore in the extracted code path; health is replicated per peer"},
            {"id": "respawn-position", "status": "runtime",
             "reason": "AI spline last valid position / best start position; route spline not in the browser build"},
            {"id": "sp-damage-modifier-semantics", "status": "unknown",
             "reason": "AmaxEvent DamageModifier/PowerUpDamageModifier are serialized but not read by the extracted source"},
            {"id": "impact-raw-impulse", "status": "engine-input",
             "reason": "raw contact impulse comes from the physics solver; the model consumes the normalised gameplay impulse"},
            {"id": "fake-physics-magnitudes", "status": "not-serialized",
             "reason": "wreck/flip/tip impulses are debug defaults and contact-state dependent"},
            {"id": "effect-cancel-on-wreck", "status": "code",
             "reason": "no wreck handler clears shield/nitro timers; effects expire on their own clocks"},
        ],
    }

    # Canonical content hash (excludes the hash block itself).
    body = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    manifest["hashes"] = {
        "manifestContent": sha256(body.encode("utf-8")),
        "citationCount": len(citations),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    file_hash = sha256(OUT.read_bytes())

    print(f"wrote {OUT} ({OUT.stat().st_size} B)")
    print(f"file sha256     {file_hash}")
    print(f"content sha256  {manifest['hashes']['manifestContent']}")
    print(f"sources         {len(manifest['sources'])} packs")
    print(f"citations       {len(citations)} lines / {len(source_hashes)} files")
    print(f"health groups   {groups}")
    print(f"health zones    {[(z['zone'], z['min'], z['max']) for z in health_zones]}")
    print(f"impact types    {[(t['level'], t['front'], t['side']) for t in impact_types]}")
    print(f"impact damage   {manifest['impact']['damage']}")
    print(f"damage modes    {manifest['perk']['damageModes']}")
    print(f"weapons         {[(k, {s: v['damageInflicted'] for s, v in w['levels'].items()}) for k, w in weapons.items()]}")
    print(f"shield          normal {shield_cfg['lifetime']}s/{shield_cfg['health']} dp {shield_cfg['doubleTap']['lifetime']}s super {shield_cfg['superShield']['lifetime']}s/{shield_cfg['superShield']['damagePointsOnImpact']}dmg")
    print(f"wreck           {manifest['wreck']['durationSeconds']}s ghost {manifest['wreck']['ghostAfterRespawnSeconds']}s")
    print(f"mp races        {mp_config['races']} {mp_config['damageModeDistribution']}")
    print(f"roster          {len(roster_rows)} slugs")
    print(f"sp events       {sp_events} modifiers {sp_modifiers}")


if __name__ == "__main__":
    main()
