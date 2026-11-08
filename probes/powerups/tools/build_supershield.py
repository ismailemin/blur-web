"""Build the SuperShield data/provenance manifest (SS1, read-only game data).

Sources (all inside ``gamedata.pak``; the PAK itself is never modified):

  \\gamedata\\xt\\pickups.bin         PickupType 619, PickupLevel 523, balance, FX, lists
  \\gamedata\\xt\\multiplayer.bin     MpPickup flags, MultiplayerRace rows
  \\gamedata\\xt\\singleplayer.bin    AmaxEvent / OpponentSetup / DifficultySettings
  \\gamedata\\xt\\ui.bin              UiXtConfig.PerkDisplayParameters.superShield
  \\gamedata\\xt\\audioentities.bin   AudioEntityDef names (negative + Shield reuse)

The builder re-uses the committed FLSK decoder (``xt_decode.py``) and the PAK
index helper. Every serialized value is read from the file; nothing is guessed.
Runtime behaviour is cited to the extracted retail source and labelled
``runtime-only``. The independent verifier re-reads the same files without
importing ``xt_decode``.

Output: ``_work/powerups/supershield.json`` (deterministic, sorted keys).
"""
from __future__ import annotations

import hashlib
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "tools"))

from build_powerups import (  # noqa: E402
    canonical_hash,
    decode_pak_entry,
    extract_hud,
    level_summary,
    sha256,
)
from inspect_asset_layout import pak_index  # noqa: E402
from xt_decode import Flask  # noqa: E402

GAME_DIR = ROOT / "game-data" / "Blur"
PACK = "gamedata.pak"
OUT_DIR = ROOT / "_work" / "powerups"
OUT = OUT_DIR / "supershield.json"
SOURCE_ROOT = ROOT / "_work" / "engine-vehicle-spike" / "tree"

PICKUPS = "\\gamedata\\xt\\pickups.bin"
MULTIPLAYER = "\\gamedata\\xt\\multiplayer.bin"
SINGLEPLAYER = "\\gamedata\\xt\\singleplayer.bin"
UI = "\\gamedata\\xt\\ui.bin"
AUDIO = "\\gamedata\\xt\\audioentities.bin"

PICKUP_LABEL = "SuperShield"

# Source citations. The token is searched verbatim; expected_line pins the exact
# line so the manifest cannot silently drift to a different line.
CITATIONS = [
    # PickupSuperShield.cpp
    ("PickupSuperShield.cpp", "Debug::Bool g_ForceAllShieldsToBeSuper", "activation.debugForceAllShields", 15),
    ("PickupSuperShield.cpp", "Debug::Bool g_InfiniShield", "activation.debugInfiniteShield", 17),
    ("PickupSuperShield.cpp", "if(pLogicActor->mSuperShield)", "activation.alreadyActiveCheck", 48),
    ("PickupSuperShield.cpp", "KillPickup(-1, E_PICKUP_CAUSE_OF_DEATH_REPLACED);", "activation.replacedNoRefresh", 50),
    ("PickupSuperShield.cpp", "pLogicActor->mShieldTime = m_pBalancingData->mLifetime;", "activation.lifetime", 54),
    ("PickupSuperShield.cpp", "pLogicActor->mSuperShield = true;", "activation.flag", 55),
    ("PickupSuperShield.cpp", "IncreaseMass(pBody, m_pBalancingData->mIncreasedMass);", "activation.mass", 66),
    ("PickupSuperShield.cpp", "E_FAKE_SPEED_ACCELERATE", "activation.nitroFakeSpeed", 72),
    ("PickupSuperShield.cpp", "mShieldDomeSpecialFX", "activation.shieldDomeFx", 83),
    ("PickupSuperShield.cpp", "m_ShieldSizeModifier", "fxScale.vehicleShieldSizeModifier", 88),
    ("GameVehicleData.cpp", 'XT_FIELD(m_ShieldSizeModifier, "ShieldSizeModifier")', "fxScale.vehicleDataField", 156),
    ("PickupSuperShield.cpp", "C_VehicleLogicMsg_PowerUpFXDurations", "audio.fxDurationUsesShieldType", 104),
    ("PickupSuperShield.cpp", "pLogicActor->mShieldTime -= frameTime;", "expiry.tick", 182),
    ("PickupSuperShield.cpp", "RevertMass(pBody);", "expiry.revertMass", 192),
    ("PickupSuperShield.cpp", "pLogicActor->mSuperShield = false;", "expiry.clearFlag", 193),
    ("PickupSuperShield.cpp", "if(!m_pBalancingData->mBoostDuringUse)", "boosts.gate", 205),
    ("PickupSuperShield.cpp", "normalisedInput = (input - minTriggerValue) / (1.f - minTriggerValue);", "boosts.triggerNormalise", 263),
    ("PickupSuperShield.cpp", "const Maths::HVec3 impulse = left * steeringInput * m_pBalancingData->mSteeringBoost;", "boosts.steeringImpulse", 284),
    ("PickupSuperShield.cpp", "const Maths::HVec3 impulse = forward * m_pBalancingData->mAccelerationBoost * throttleInput;", "boosts.accelerationImpulse", 296),
    ("PickupSuperShield.cpp", "const Maths::HVec3 impulse = Maths::HVec3( down * m_pBalancingData->mDownForceBoost );", "boosts.downForceImpulse", 307),
    # VLC_Pickups.cpp
    ("VLC_Pickups.cpp", "Debug::Float g_debugPerksDoubleShieldCooldown", "ram.cooldown", 115),
    ("VLC_Pickups.cpp", "case E_PICKUP_TYPE_SUPER_SHIELD:", "activation.createCase", 1434),
    ("VLC_Pickups.cpp", "// Shield no longer takes damage.", "absorb.noHpDrain", 1613),
    ("VLC_Pickups.cpp", "pActor->mShieldHealth -= pPickup->mNormal->mBalancingData->GetDamageInflicted();", "absorb.shockOnlyHpSpecialCase", 1615),
    ("VLC_Pickups.cpp", "float timeShielded = pActor->mShieldTime;", "absorb.timeGate", 1631),
    ("VLC_Pickups.cpp", "if( timeShielded > 0.f && pickupType != E_PICKUP_TYPE_NITROUS)", "absorb.nitrousExcluded", 1633),
    ("VLC_Pickups.cpp", "RegisterShieldedPickup(pickupType, firingIdx, pickupId);", "absorb.consume", 1634),
    ("VLC_Pickups.cpp", "myShieldActive = (pActor->mDoubleShield ||pActor->mSuperShield);", "ram.selfShieldFlag", 2291),
    ("VLC_Pickups.cpp", "if(hisShieldActive && !myShieldActive && mHitByDoubleShieldCooldown <= 0.f)", "ram.condition", 2298),
    ("VLC_Pickups.cpp", "E_FAKE_PHYSICS_JINK_SHIELD_LEFT", "ram.jinkLeft", 2324),
    ("VLC_Pickups.cpp", "E_FAKE_PHYSICS_JINK_SHIELD_RIGHT", "ram.jinkRight", 2328),
    ("VLC_Pickups.cpp", "C_VehicleLogicForceDamageMsg forceDamageMsg", "ram.damage", 2336),
    ("VLC_Pickups.cpp", "pActor->SendMessageToComponent(Components::E_IF_VehicleComponent_Damage, &forceDamageMsg);", "ram.damageSend", 2337),
    # Collision / mass
    ("VLC_Damage.cpp", "if( pActor->mShieldTime == 0.f )", "collision.damageSuppressed", 1744),
    ("VLC_Network_Damage.cpp", "if( pActor->mShieldTime <= 0.f )", "collision.networkGate", 142),
    ("VLC_Network_Damage.cpp", "pMsg->mCollisionInfo.m_GameplayImpulse = 0.0f;", "collision.impulseZeroed", 152),
    ("RaceLogicLayer.cpp", "vehicleAWeight = AmaxVehicleWeight_Ultra;", "collision.ultraWeight", 1806),
    # Creation / networking
    ("PickupsManager.cpp", "type == E_PICKUP_TYPE_SUPER_SHIELD)", "network.pickupKilled", 224),
    ("PickupsManager.cpp", "pickupInfo.mPickupType = E_PICKUP_TYPE_SUPER_SHIELD;", "activation.debugReplace", 296),
    ("PickupsManager.cpp", "new (pPickup)C_PickupSuperShield", "creation.pool", 512),
    ("PickupsManager.cpp", "mpEventManager->Add_PickupFired", "network.pickupFired", 534),
    # Multiplayer selection surface
    ("PickupPositionActor.cpp", "( pPickup->meType == E_PICKUP_TYPE_SUPER_SHIELD ) ||", "multiplayer.randomExcluded", 1094),
    ("Playlist.cpp", "for(int i = 0; i < UI::E_Pickup_Max; i++)", "multiplayer.probabilityLoop", 285),
    ("Playlist.cpp", "levelState.mPickupProbabilities.PushBack(levelPickupProb);", "multiplayer.probabilityTable", 297),
    ("MultiplayerDefines.h", "E_Pickup_Nitro = 0,", "multiplayer.uiPickupFirst", 65),
    ("MultiplayerDefines.h", "E_Pickup_Max,", "multiplayer.uiPickupCount", 74),
    ("MultiplayerData.h", "XtFlags<XtU16, UI::E_Pickup>", "multiplayer.raceFlagWidth", 42),
    ("MultiplayerData.cpp", "XT_FLAG( 1 << UI::E_Pickup_Repair,", "multiplayer.eighthFlag", 454),
    ("RLEnums.h", "E_PICKUP_TYPE_SUPER_SHIELD,", "network.runtimeEnumOrdinal", 109),
    ("NetEventManager.cpp", "U8 pickupTypeAndSubType = (pickupInfo.mPickupType << 4) | pickupInfo.mPickupSubType;", "network.fourBitType", 193),
    ("NetEventManager.cpp", "temp.GetEventBuffer()->PushU8(p_PickupType);", "network.shieldedPickupU8", 483),
    ("NetEventManager.cpp", "temp.GetEventBuffer()->PushS16(damage);", "network.damageDealtS16", 533),
    # HUD / audio / balance struct
    ("UIPerks2.cpp", "case E_PICKUP_TYPE_SUPER_SHIELD:", "hud.typeMapping", 111),
    ("RLDatabase.h", "struct RLSuperShieldBalancingData : RLBalancingDataBase", "balancing.struct", 490),
    ("RLDatabase.h", "GetDamageInflicted() { return mDamagePointsOnImpact; }", "balancing.damageOverride", 492),
    ("PickupShield.cpp", "pActor->mShieldHealth\t= mpShieldData->mHealth;", "contrast.normalShieldUsesHealth", 69),
    ("PickupBase.cpp", "Game::PickupCreationStruct pickupInfo(E_PICKUP_TYPE_SHIELD, E_PICKUP_SUB_TYPE_NORMAL, vehIdx);", "contrast.alwaysShieldsIsNormalShield", 240),
    ("VehicleLogicActor.h", "mSuperShield;", "runtime.actorFlag", 263),
    ("PickupSubSystem.cpp", "if(pickupEntityDefinition[ePickupType])", "audio.noEntityGuard", 1664),
]

NEGATIVE_CHECKS = [
    ("PickupSuperShield.cpp", "mShieldHealth", "SuperShield never references mShieldHealth"),
    ("PickupSuperShield.cpp", "mBrakingBoost", "SuperShield never reads the serialized BrakingBoost"),
    ("PickupSubSystem.cpp", "gAudioPickupString[E_PICKUP_TYPE_SUPER_SHIELD]", "no SuperShield audio entity slot"),
    ("MultiplayerDefines.h", "SuperShield", "UI::E_Pickup has no SuperShield value"),
    ("MultiplayerData.cpp", "SuperShield", "MpPickup has no SuperShield flag"),
    ("Playlist.cpp", "SUPER_SHIELD", "MP level-state probability table has no SuperShield"),
]

ABSENT_MULTIPLAYER = [
    "UI::E_Pickup has exactly eight values (Nitro..Repair); there is no SuperShield value.",
    "MultiplayerRace.powerups is XtFlags<XtU16, UI::E_Pickup>; only the eight E_Pickup bits are defined.",
    "Playlist.cpp fills mPickupProbabilities in a loop bounded by UI::E_Pickup_Max (8), so a ninth type is never added to the MP table.",
    "PickupPositionActor::SetRandomPickupType hard-excludes E_PICKUP_TYPE_SUPER_SHIELD from the random selection for every mode.",
    "The only probability list that names SuperShield (pickups record 279) sets it to 0.0 and is bound to MP race 203 (hardcore, powerups bits 0).",
    "singleplayer.bin has no DifficultyPerks records and no AIPerkUse entries; the one AlwaysShields opponent spawns a normal Shield, not a SuperShield.",
]

PROVISIONAL = [
    {
        "id": "multiplayer-enable-rule",
        "status": "provisional",
        "decision": "Project-defined enable bit/spawn rule outside UI::E_Pickup; retail has no SuperShield MP flag.",
        "why": "The entity and wire path exist, but no shipped multiplayer selection surface can choose it.",
    },
    {
        "id": "spawn-placement",
        "status": "provisional",
        "decision": "Project chooses where SuperShield spawns; no recovered raced placement exists (0 of 333 recovered River/Amboy/Gracia placements).",
        "why": "Pickup placement is level actor data and is not in the recovered raced sets.",
    },
    {
        "id": "provisional-absorb-cap",
        "status": "provisional",
        "decision": "The model supports an optional caller-supplied absorb cap. Default is null = no cap, matching the recovered runtime (time invulnerability).",
        "why": "Health=50 is serialized but unused; using it as a damage cap would be a project decision, not retail.",
    },
    {
        "id": "boost-physics",
        "status": "provisional",
        "decision": "The model emits owner-local boost impulses; it does not integrate them into vehicle physics.",
        "why": "Impulse application is runtime physics; the host model is a rules/event contract.",
    },
    {
        "id": "audio",
        "status": "provisional",
        "decision": "Project must add an audio entity or explicitly reuse the normal Shield audio; retail has no SuperShield mapping.",
        "why": "PickUpSubsystem has eight base type names and no SuperShield slot.",
    },
]


def source_evidence() -> dict:
    files = {}
    citations = []
    negative = []
    for filename, token, field, expected_line in CITATIONS:
        matches = sorted(SOURCE_ROOT.rglob(filename))
        if not matches:
            raise SystemExit(f"source file not found: {filename}")
        path = matches[0]
        text = path.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        hits = [i + 1 for i, line in enumerate(lines) if token in line]
        if not hits:
            raise SystemExit(f"token not found in {filename}: {token!r}")
        if expected_line is not None and expected_line not in hits:
            raise SystemExit(
                f"{filename}: token {token!r} at lines {hits}, expected {expected_line}")
        line_no = expected_line if expected_line in hits else hits[0]
        rel = path.relative_to(ROOT).as_posix()
        files.setdefault(rel, {"path": rel, "sha256": sha256(path.read_bytes()),
                               "bytes": path.stat().st_size})
        citations.append({
            "field": field,
            "file": rel,
            "line": line_no,
            "token": token,
            "text": lines[line_no - 1].strip(),
        })
    for filename, token, reason in NEGATIVE_CHECKS:
        path = sorted(SOURCE_ROOT.rglob(filename))[0]
        text = path.read_text(encoding="utf-8", errors="replace")
        count = text.count(token)
        if count != 0:
            raise SystemExit(f"negative check failed: {filename} contains {token!r} ({count})")
        rel = path.relative_to(ROOT).as_posix()
        files.setdefault(rel, {"path": rel, "sha256": sha256(path.read_bytes()),
                               "bytes": path.stat().st_size})
        negative.append({"file": rel, "mustNotContain": token, "reason": reason, "count": count})
    return {
        "files": sorted(files.values(), key=lambda x: x["path"]),
        "citations": citations,
        "negativeChecks": negative,
    }


def atom_value(flask: Flask, type_index: int, payload: bytes, off: int):
    atom = flask.types[type_index][4]
    if atom == 1:
        return "bool", struct.unpack_from("<I", payload, off)[0] != 0
    if atom == 10:
        return "f32", struct.unpack_from("<f", payload, off)[0]
    if atom in (2, 3, 4, 5):
        fmt = {2: "<b", 3: "<h", 4: "<i", 5: "<q"}[atom]
        return {2: "i8", 3: "i16", 4: "i32", 5: "i64"}[atom], struct.unpack_from(fmt, payload, off)[0]
    if atom in (6, 7, 8, 9):
        fmt = {6: "<B", 7: "<H", 8: "<I", 9: "<Q"}[atom]
        return {6: "u8", 7: "u16", 8: "u32", 9: "u64"}[atom], struct.unpack_from(fmt, payload, off)[0]
    if atom in (12, 13):
        return "string-offset", struct.unpack_from("<I", payload, off)[0]
    if atom == 14:
        return "locId", f"{struct.unpack_from('<I', payload, off)[0]:08x}"
    raise SystemExit(f"unsupported atom {atom}")


def main() -> None:
    index = pak_index(GAME_DIR / "cache" / PACK)
    if index.get("codec") != 2:
        raise SystemExit("expected zlib gamedata pak")

    packs = {}
    for key, path in (("pickups", PICKUPS), ("multiplayer", MULTIPLAYER),
                      ("singleplayer", SINGLEPLAYER), ("ui", UI), ("audio", AUDIO)):
        packs[key] = decode_pak_entry(index, GAME_DIR / "cache" / PACK, path)
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / f"{key}.xt").write_bytes(packs[key]["bytes"])

    pick = Flask(packs["pickups"]["bytes"])
    mp = Flask(packs["multiplayer"]["bytes"])
    sp = Flask(packs["singleplayer"]["bytes"])
    ui = Flask(packs["ui"]["bytes"])
    audio = Flask(packs["audio"]["bytes"])

    # Enumeration authority: PickupSystem.Types, not a hard-coded record number.
    system_record = next(i for i in range(len(pick.records))
                         if pick.type_name(pick.record_type(i)) == "PickupSystem")
    system = pick.decode_record(system_record)
    type_handles = system["Types"]["items"]
    handle = next(h for h in type_handles
                  if h.get("value", {}).get("Type", {}).get("label") == PICKUP_LABEL)
    type_record = handle["record"]
    type_ref_id = handle["refId"]
    entity = handle["value"]
    normal = entity["Normal"]
    level_record = normal["record"]
    level_ref_id = normal["refId"]
    if pick.type_name(pick.record_type(level_record)) != "PickupLevel":
        raise SystemExit("SuperShield Normal handle is not a PickupLevel")

    data_base = pick.tables["data"]["offset"]
    type_payload = pick.record_payload(type_record)
    type_payload_abs = data_base + pick._data_start[type_record]

    # Balancing pointer: PickupLevel offset 12, {u16 component,u16 element}.
    level_payload = pick.record_payload(level_record)
    level_payload_abs = data_base + pick._data_start[level_record]
    comp, elem = struct.unpack_from("<2H", level_payload, 12)
    bal_comp, bal_elem = comp, elem
    comp_type, comp_count, comp_behaviour = pick.components[
        pick._component_start[level_record] + comp]
    if comp_behaviour != 0:
        raise SystemExit("balancing pointer target is not an object component")
    comp_offset = pick._component_offset(level_record, comp)
    bal_type_size = pick.types[comp_type][5]
    bal_base = comp_offset + elem * bal_type_size
    bal_abs = level_payload_abs + bal_base
    bal_type = pick.type_name(comp_type)
    if bal_type != "SuperShieldBalancingData":
        raise SystemExit(f"unexpected balancing type {bal_type}")

    fields = {}
    for f in pick.all_fields(comp_type):
        off = bal_base + f["offset"]
        atom_name, value = atom_value(pick, f["typeIndex"], level_payload, off)
        status = "serialized"
        if f["name"] in ("Health", "BrakingBoost"):
            status = "serialized-unused"
        fields[f["name"]] = {
            "structOffset": f["offset"],
            "payloadOffset": off,
            "absOffset": level_payload_abs + off,
            "atom": atom_name,
            "value": value,
            "status": status,
        }

    def value(name: str):
        return fields[name]["value"]

    # Full level summary (FX graph, special effects, assets) from the committed builder.
    fx = level_summary(pick, normal)

    # HUD entry: UiXtConfig.PerkDisplayParameters.superShield.
    hud = extract_hud(ui)
    hud_entry = hud["perkEntries"]["superShield"]
    hud_config_record = hud["source"]["record"]
    hud_payload = ui.record_payload(hud_config_record)
    perk_type = next(i for i in range(len(ui.types))
                     if ui.type_name(i) == "UiPerkDisplayParameters")
    perk_field = next(f for f in ui.type_fields(ui.record_type(hud_config_record))
                      if f["name"] == "PerkDisplayParameters")
    perk_fields = {f["name"]: f["offset"] for f in ui.all_fields(perk_type)}
    super_field_offset = perk_fields["superShield"]
    super_abs = ui.tables["data"]["offset"] + ui._data_start[hud_config_record] + \
        perk_field["offset"] + super_field_offset

    # Audio names: no SuperShield entity; the normal Shield entity exists.
    audio_names = []
    for i in range(len(audio.records)):
        payload = audio.record_payload(i)
        offset = struct.unpack_from("<I", payload, 0)[0]
        strings = audio.record_strings(i)
        end = strings.find(b"\0", offset) if offset < len(strings) else -1
        if end >= 0:
            audio_names.append({"name": strings[offset:end].decode("latin-1"),
                                "record": i, "refId": audio.record_id(i)})
    shield_audio = next((row for row in audio_names if row["name"] == "Shield"), None)
    super_audio = next((row for row in audio_names if "SuperShield" in row["name"]), None)

    # Probability list 279 names SuperShield at 0.0; list 737 is the boss list.
    def probability_list(record: int):
        obj = pick.decode_record(record)
        items = obj["PickupProbabilities"]["items"]
        return {
            "record": record,
            "refId": pick.record_id(record),
            "items": [
                {"pickup": item["PickupType"]["label"],
                 "labelIndex": item["PickupType"]["labelIndex"],
                 "probability": item["Probability"]}
                for item in items
            ],
            "sum": sum(item["Probability"] for item in items),
        }

    list_279 = probability_list(279)
    list_737 = probability_list(737)
    if list_279["items"][9]["pickup"] != PICKUP_LABEL:
        raise SystemExit("probability list 279 item 9 is not SuperShield")

    # MP race 203 is the only race with a non-null list; it is hardcore with bits 0.
    race_type = next(i for i in range(len(mp.types))
                     if mp.type_name(i) == "MultiplayerRace")
    race_fields = {f["name"]: f for f in mp.type_fields(race_type)}
    race_record = 203
    if mp.record_id(race_record) != 1363684996:
        raise SystemExit("MultiplayerRace 203 id mismatch")
    race_payload = mp.record_payload(race_record)
    race_bits = struct.unpack_from("<I", race_payload, race_fields["powerups"]["offset"])[0]
    race_prob_ref = struct.unpack_from(
        "<I", race_payload, race_fields["PickupProbabilities"]["offset"])[0]
    race_prob_id, race_prob_type, race_prob_record = mp.refs[race_prob_ref]
    if race_prob_id != list_279["refId"]:
        raise SystemExit("MP race 203 does not reference probability list 279")

    # Single-player: 86 AmaxEvent records; no DifficultyPerks records; no AIPerkUse.
    event_type = next(i for i in range(len(sp.types)) if sp.type_name(i) == "AmaxEvent")
    events = [i for i in range(len(sp.records)) if sp.record_type(i) == event_type]
    difficulty_type = next(i for i in range(len(sp.types))
                           if sp.type_name(i) == "DifficultySettings")
    difficulty_fields = {f["name"]: f for f in sp.type_fields(difficulty_type)}
    difficulty_offsets = {}
    event_fields = {f["name"]: f for f in sp.all_fields(event_type)}
    for name in ("Easy", "Medium", "Hard"):
        difficulty_offsets[name] = event_fields[name]["offset"]
    ai_perk_entries = 0
    always_shields = 0
    always_shields_details = []
    opponent_type = next(i for i in range(len(sp.types))
                         if sp.type_name(i) == "OpponentSetup")
    opponent_always = next(f["offset"] for f in sp.type_fields(opponent_type)
                           if f["name"] == "AlwaysShields")
    for rec in events:
        payload = sp.record_payload(rec)
        for name, base in difficulty_offsets.items():
            comp, elem, length = struct.unpack_from("<2HI", payload,
                                                    base + difficulty_fields["AIPerkUse"]["offset"])
            ai_perk_entries += length
        comp, elem, length = struct.unpack_from(
            "<2HI", payload, event_fields["Opponents"]["offset"])
        if comp != 0xFFFF:
            stride = sp.types[opponent_type][5]
            base = sp._component_offset(rec, comp) + elem * stride
            for k in range(length):
                if struct.unpack_from("<I", payload, base + k * stride + opponent_always)[0]:
                    always_shields += 1
                    name_off = struct.unpack_from("<I", payload, event_fields["Name"]["offset"])[0]
                    strings = sp.record_strings(rec)
                    end = strings.find(b"\0", name_off)
                    always_shields_details.append({
                        "eventRecord": rec,
                        "eventRefId": sp.record_id(rec),
                        "eventName": strings[name_off:end].decode("latin-1") if end >= 0 else None,
                        "opponentIndex": k,
                        "opponentArrayComponent": comp,
                        "opponentArrayElement": elem,
                        "absOffset": (sp.tables["data"]["offset"] + sp._data_start[rec] + base +
                                      k * stride + opponent_always),
                    })
    difficulty_perk_type = next((i for i in range(len(sp.types))
                                 if sp.type_name(i) == "DifficultyPerks"), None)
    difficulty_perk_records = sum(
        1 for i in range(len(sp.records))
        if sp.record_type(i) == difficulty_perk_type) if difficulty_perk_type is not None else 0

    # MP enum / flag counts.
    mp_pickup_type = next(i for i in range(len(mp.types)) if mp.type_name(i) == "MpPickup")
    mp_pickup_labels = mp.type_labels(mp_pickup_type)
    type_list_type = next(i for i in range(len(pick.types))
                          if pick.type_name(i) == "PickupTypeList")
    type_list_labels = pick.type_labels(type_list_type)

    manifest = {
        "schema": "blur-powerups-supershield/1",
        "generatedBy": "probes/powerups/tools/build_supershield.py",
        "date": "2026-11-08",
        "owner": "SS1",
        "scope": "data/analysis only; no e1-drive, boost-feasibility, race-rules, net-mvp, asset-reader, tools, upstream or game-data change",
        "sources": [
            {
                "name": key,
                "pack": PACK,
                "path": packs[key]["path"],
                "offset": packs[key]["offset"],
                "storedBytes": packs[key]["storedBytes"],
                "logicalBytes": packs[key]["logicalBytes"],
                "pathCrc32": packs[key]["pathCrc32"],
                "sha256Decoded": packs[key]["sha256Decoded"],
                "sha256Stored": packs[key]["sha256Stored"],
                "role": {
                    "pickups": "SuperShield PickupType/PickupLevel/balance/FX/probability",
                    "multiplayer": "MpPickup flags and MultiplayerRace rows",
                    "singleplayer": "AmaxEvent/OpponentSetup/DifficultySettings",
                    "ui": "UiXtConfig.PerkDisplayParameters.superShield",
                    "audio": "AudioEntityDef names (negative + Shield reuse)",
                }[key],
            }
            for key in ("pickups", "multiplayer", "singleplayer", "ui", "audio")
        ],
        "entity": {
            "pickupLabel": PICKUP_LABEL,
            "record": type_record,
            "refId": type_ref_id,
            "type": "PickupType",
            "payloadAbs": type_payload_abs,
            "payloadBytes": pick.records[type_record][2],
            "typeField": {
                "fieldOffset": 4,
                "absOffset": type_payload_abs + 4,
                "label": entity["Type"]["label"],
                "labelIndex": entity["Type"]["labelIndex"],
            },
            "normal": {
                "handleFieldOffset": 8,
                "handleAbsOffset": type_payload_abs + 8,
                "refIndex": struct.unpack_from("<I", type_payload, 8)[0],
                "refId": level_ref_id,
                "record": level_record,
                "payloadAbs": level_payload_abs,
                "payloadBytes": pick.records[level_record][2],
            },
            "baseProbability": {"fieldOffset": 52, "value": entity["BaseProbability"],
                                "status": "serialized"},
            "doNotRandomise": {"fieldOffset": 48, "value": entity["DoNotRandomise"],
                               "status": "serialized"},
            "aiUsageType": entity["AIUsageType"],
            "aiTriggers": entity["AIPickupTypes"]["items"],
            "positionModifiers": {"count": entity["PositionModifiers"]["length"],
                                  "items": entity["PositionModifiers"]["items"]},
            "specialEffectCycle": {
                "begin": entity["PickupSpecialFXBeginCycle"],
                "end": entity["PickupSpecialFXEndCycle"],
            },
            "levels": {k: v for k, v in entity.items() if k == "Normal"},
            "levelSlots": {
                "present": [slot for slot in ("Normal", "DoubleTap", "Reversed",
                                               "ReversedDoubleTap", "Mini", "Modified",
                                               "ReversedModified") if isinstance(entity.get(slot), dict)],
                "null": [slot for slot in ("Normal", "DoubleTap", "Reversed",
                                            "ReversedDoubleTap", "Mini", "Modified",
                                            "ReversedModified") if entity.get(slot) is None],
            },
        },
        "balancing": {
            "type": bal_type,
            "typeIndex": comp_type,
            "sizeBytes": bal_type_size,
            "component": bal_comp,
            "componentCount": comp_count,
            "componentOffsetInPayload": comp_offset,
            "element": bal_elem,
            "payloadOffset": bal_base,
            "absOffset": bal_abs,
            "fields": fields,
        },
        "fx": fx,
        "hud": {
            "source": {
                "pack": PACK,
                "path": UI,
                "record": hud_config_record,
                "refId": ui.record_id(hud_config_record),
                "type": "UiXtConfig",
                "field": "PerkDisplayParameters",
                "fieldOffset": perk_field["offset"],
                "entryOffset": super_field_offset,
                "entryAbsOffset": super_abs,
                "entrySizeBytes": ui.types[perk_type][5] // 16,
            },
            "key": "superShield",
            "entry": hud_entry,
            "sheet": {
                "names": [row["name"] for row in hud["iconSheets"]],
                "status": "string-only",
                "reason": "perk_icons/perk_sheet are strings without a typed texture binding",
            },
        },
        "audio": {
            "superShieldEntity": super_audio,
            "shieldEntity": shield_audio,
            "fxDurationMessageType": "Shield",
            "status": "no-super-shield-audio-entity",
            "reason": "PickUpSubsystem names only the eight UI::E_Pickup types; E_PICKUP_TYPE_SUPER_SHIELD (10) has no gAudioPickupString slot and no AudioEntityDef. PickupSuperShield.cpp:104 sends the FX-duration envelope as E_PICKUP_TYPE_SHIELD, but no Shield audio object is created for this UID.",
            "source": "PickupSubSystem.cpp:1608-1636,1664",
        },
        "probability": {
            "baseProbability": entity["BaseProbability"],
            "doNotRandomise": entity["DoNotRandomise"],
            "superShieldList": list_279,
            "bossList": list_737,
            "multiplayerRace203": {
                "record": race_record,
                "refId": mp.record_id(race_record),
                "type": mp.type_labels(race_fields["type"]["typeIndex"])[struct.unpack_from(
                    "<I", race_payload, race_fields["type"]["offset"])[0]],
                "powerupsBits": race_bits,
                "probabilityRefIndex": race_prob_ref,
                "probabilityRefId": race_prob_id,
                "probabilityRecord": 279,
                "probabilityExternal": race_prob_record == 0xFFFF,
            },
            "notes": [
                "List 279 is the only list that names SuperShield; every value in it is 0.0.",
                "The only race that references list 279 is a hardcore race with powerups bits 0 (no power-ups enabled).",
                "The two boss events bind list 737, which has no SuperShield item.",
            ],
        },
        "multiplayer": {
            "enabled": False,
            "status": "not-in-mp-pickup-enum",
            "mpPickupLabels": mp_pickup_labels,
            "mpPickupFlagCount": len(mp_pickup_labels),
            "pickupTypeListLabels": type_list_labels,
            "pickupTypeListBitCount": len(type_list_labels),
            "uiPickupEnum": {
                "first": "E_Pickup_Nitro = 0",
                "max": "E_Pickup_Max",
                "count": 8,
                "source": "MultiplayerDefines.h:65,74",
            },
            "probabilityTableEntries": 8,
            "randomSelectionExcluded": True,
            "evidence": ABSENT_MULTIPLAYER,
            "wire": {
                "pickupFiredTypeNibble": 10,
                "typeFitsFourBits": True,
                "pickupFiredEncoding": "(mPickupType << 4) | mPickupSubType",
                "pickupFiredSource": "NetEventManager.cpp:193",
                "shieldedPickupTypeIsU8": True,
                "shieldedPickupSource": "NetEventManager.cpp:483",
                "damageDealtIsS16": True,
                "damageDealtSource": "NetEventManager.cpp:533",
                "pickupKilledReplicated": True,
                "pickupKilledSource": "PickupsManager.cpp:224",
                "remoteCreateSupported": True,
                "remoteCreateSource": "PickupsManager.cpp:509-514,530-535",
                "status": "wire-can-carry-supershield",
            },
        },
        "singlePlayer": {
            "eventCount": len(events),
            "difficultyPerkRecords": difficulty_perk_records,
            "aiPerkUseEntries": ai_perk_entries,
            "opponentsAlwaysShields": always_shields,
            "alwaysShieldsEvent": always_shields_details[0] if always_shields_details else None,
            "alwaysShieldsSpawns": "Shield",
            "alwaysShieldsSource": "PickupBase.cpp:238-243",
            "offsets": {
                "opponentsArrayFieldOffset": event_fields["Opponents"]["offset"],
                "alwaysShieldsFieldOffset": opponent_always,
                "aiPerkUseFieldOffset": difficulty_fields["AIPerkUse"]["offset"],
                "difficultyBlockOffsets": difficulty_offsets,
            },
            "bossProbabilityList": list_737["record"],
            "bossProbabilityHasSuperShield": any(
                item["pickup"] == PICKUP_LABEL for item in list_737["items"]),
            "superShieldGrantPaths": 0,
            "notes": [
                "No DifficultyPerks records exist in singleplayer.bin (the type is declared but unused).",
                "No AIPerkUse entries exist in any of the 86 AmaxEvent difficulty blocks.",
                "The one AlwaysShields opponent (Boss Battle Part 1, opponent 3) spawns a normal Shield, not a SuperShield.",
                "No recovered raced placement names SuperShield (0/333 across River/Amboy/Gracia).",
            ],
        },
        "runtime": {
            "activation": {
                "lifetimeSeconds": value("Lifetime"),
                "delaySeconds": value("Delay"),
                "alreadyActive": "replaced-no-refresh",
                "refresh": False,
                "source": "PickupSuperShield.cpp:48-55",
            },
            "absorb": {
                "model": "time-invulnerability",
                "gate": "mShieldTime > 0",
                "excludedPickupType": "Nitrous",
                "healthField": {
                    "value": value("Health"),
                    "status": "serialized-unused",
                    "reason": "C_PickupSuperShield never assigns mShieldHealth; only mShieldTime gates AttemptHitByPickup. Health is used by the normal Shield (PickupShield.cpp:69).",
                },
                "damageCap": None,
                "damageCapStatus": "not-serialized",
                "source": "VLC_Pickups.cpp:1631-1636;PickupSuperShield.cpp (no mShieldHealth)",
            },
            "collision": {
                "blocksImpactDamage": True,
                "networkImpulseZeroed": True,
                "weightClass": "Ultra",
                "source": "VLC_Damage.cpp:1744;VLC_Network_Damage.cpp:142-152;RaceLogicLayer.cpp:1805-1809",
            },
            "ram": {
                "damage": value("DamagePointsOnImpact"),
                "damageCap": value("DamagePointsOnImpact"),
                "cooldownSeconds": 1.0,
                "condition": "other has active SuperShield, self does not, cooldown <= 0",
                "jink": ["jink-shield-left", "jink-shield-right"],
                "jinkBasis": "runtime dot of the rammer->shield vector against the rammer local left axis",
                "source": "VLC_Pickups.cpp:115,2298-2337",
            },
            "mass": {
                "increaseDuringUse": value("IncreaseMassDuringUse"),
                "activeMassKg": value("IncreasedMass"),
                "revert": "original mass stored at activation",
                "source": "PickupSuperShield.cpp:61-67,192",
            },
            "nitro": {
                "enabled": value("NitroOnStartup"),
                "mode": "E_FAKE_SPEED_ACCELERATE",
                "targetMph": value("NitroTargetSpeedInMPH"),
                "targetMps": value("NitroTargetSpeedInMPH") * 0.44704,
                "source": "PickupSuperShield.cpp:69-73",
            },
            "boosts": {
                "boostDuringUse": value("BoostDuringUse"),
                "steeringForwardOffsetM": value("SteeringForwardOffset"),
                "steeringBoost": value("SteeringBoost"),
                "accelerationBoost": value("AccelerationBoost"),
                "brakingBoost": {
                    "value": value("BrakingBoost"),
                    "status": "serialized-unused",
                    "reason": "ApplyAccelerationOrDecelerationBoost multiplies AccelerationBoost by signed throttle; it never reads BrakingBoost.",
                },
                "downForceBoost": value("DownForceBoost"),
                "minimumTriggerValue": value("MinimumTriggerValue"),
                "triggerNormalisation": "input > min ? (input-min)/(1-min) : 0",
                "localPlayerOnly": True,
                "source": "PickupSuperShield.cpp:171-174,203-311",
            },
            "fxScale": {
                "shieldScale": [1.0, 1.25, 0.47],
                "bumperTranslation": [0.0, -0.65, 1.0],
                "status": "runtime-debug-default",
                "vehicleShieldSizeModifier": {
                    "status": "vehicle-data",
                    "field": "AmaxVehicle.ShieldSizeModifier",
                    "role": "three-axis multiplier applied to the shield FX scale; not in pickups.bin",
                    "source": "PickupSuperShield.cpp:88-90;GameVehicleData.cpp:156",
                },
                "source": "PickupSuperShield.cpp:19-20,88-90",
            },
        },
        "decision": {
            "status": "integrable-project-extension",
            "provisional": True,
            "summary": "The entity, balance data, FX, HUD entry, activation/absorb/expiry/ram rules and the retail wire path all exist. What is missing is a multiplayer enable/spawn rule; retail has no SuperShield bit in UI::E_Pickup and hard-excludes it from random selection.",
            "requires": [
                "project-defined multiplayer enable bit/spawn rule (provisional)",
                "original vehicle mass at activation (engine/XT data)",
                "owner-local boost impulse application (host event contract only)",
                "audio entity or an explicit reuse decision (provisional)",
            ],
            "notRequired": [
                "new wire event type (PickupFired type nibble 10, PickupKilled, ShieldedPickup, DamageDealt all fit)",
                "new pickup class or runtime rule for absorb/expire/ram",
                "new FX payload decode (ShieldDomeSpecialFX is already in pickups.bin)",
            ],
            "missingRuntimeRule": False,
            "missingMultiplayerEnableRule": True,
        },
        "eventContract": {
            "authority": "host",
            "channel": "reliable-ordered",
            "seq": "monotonic host seq; clients apply in order",
            "events": [
                {
                    "type": "supershield-spawned",
                    "payload": ["seq", "authority", "pickupId", "pickupType", "typeId",
                                "position", "level", "spawnSource"],
                    "sync": "reliable, once",
                },
                {
                    "type": "supershield-activated",
                    "payload": ["seq", "authority", "pickupId", "ownerId", "at",
                                "lifetimeSeconds", "massKgBefore", "massActiveKg",
                                "weightClass", "nitro", "boosts", "absorbModel",
                                "healthField", "hud", "audio", "level"],
                    "sync": "reliable, once",
                },
                {
                    "type": "supershield-absorbed",
                    "payload": ["seq", "authority", "ownerId", "sourcePickupType",
                                "attemptedDamage", "absorbedDamage", "leakedDamage",
                                "shieldRemainingSeconds", "healthUnchanged", "absorbModel",
                                "cap", "provisional"],
                    "sync": "reliable",
                },
                {
                    "type": "supershield-rammed",
                    "payload": ["seq", "authority", "ownerId", "rammerId",
                                "damage", "damageCap", "jink", "cooldownSeconds",
                                "shieldRemainingSeconds"],
                    "sync": "reliable",
                },
                {
                    "type": "supershield-ram-ignored",
                    "payload": ["seq", "authority", "ownerId", "rammerId", "reason",
                                "cooldownRemainingSeconds?"],
                    "sync": "local diagnostic; host may omit",
                },
                {
                    "type": "supershield-expired",
                    "payload": ["seq", "authority", "ownerId", "at", "reason",
                                "lifetimeSeconds", "massKgRevertedTo"],
                    "sync": "reliable, once",
                },
                {
                    "type": "supershield-replaced",
                    "payload": ["seq", "authority", "ownerId", "pickupId", "reason",
                                "refreshed", "remainingSeconds"],
                    "sync": "reliable, once",
                },
                {
                    "type": "supershield-boost-applied",
                    "payload": ["seq", "authority", "ownerId", "steeringImpulse",
                                "accelerationImpulse", "downForceImpulse",
                                "steeringApplicationPoint", "throttleNormalised",
                                "brakeNormalised"],
                    "sync": "owner-local; not a replicated state field",
                },
                {
                    "type": "supershield-rejected",
                    "payload": ["seq", "authority", "ownerId", "reason", "missing"],
                    "sync": "local diagnostic",
                },
            ],
            "wireMapping": {
                "spawn": "PickupDroppedOnTrack (type U8=10) for project-dropped pickups; level actor data for fixed placements",
                "activate": "PickupFired (type nibble 10, subtype 0)",
                "absorb": "ShieldedPickup (incoming pickup type U8) + replicated shield state",
                "ram": "DamageDealt (S16 damage=100)",
                "expire": "PickupKilled (pickup UID) or authoritative shield-state snapshot",
                "lateJoin": "send active shields with remainingSeconds, massKgBefore/massActiveKg, next seq",
            },
            "clientRule": "clients send use/pickup intents; they never judge absorb/ram/expiry or consume inventory",
        },
        "provisional": PROVISIONAL,
        "missing": [
            {
                "field": "multiplayerEnableBit",
                "status": "absent-from-schema",
                "reason": "UI::E_Pickup has eight values; MultiplayerRace.powerups has no SuperShield bit.",
            },
            {
                "field": "multiplayerSpawnPlacement",
                "status": "not-in-recovered-raced-data",
                "reason": "0 of 333 recovered River/Amboy/Gracia placements name SuperShield; actor placement is level data.",
            },
            {
                "field": "originalVehicleMass",
                "status": "runtime-engine-data",
                "reason": "Mass must come from the vehicle body at activation to revert correctly.",
            },
            {
                "field": "boostImpulseIntegration",
                "status": "runtime-only",
                "reason": "ApplyImpulseWorldSpace magnitudes are serialized; frame integration and inertia are engine physics.",
            },
            {
                "field": "fakeSpeedNitro",
                "status": "runtime-only",
                "reason": "E_FAKE_SPEED_ACCELERATE to 50 mph is a FakeSpeed runtime effect, not a serialized force.",
            },
            {
                "field": "audioEntity",
                "status": "absent",
                "reason": "No AudioEntityDef name and no PickUpSubsystem gAudioPickupString slot for SuperShield.",
            },
            {
                "field": "hudIconSheetBinding",
                "status": "partial",
                "reason": "texture_index 104 exists; perk_icons/perk_sheet are strings without a typed binding.",
            },
            {
                "field": "runtimeEnumInteger",
                "status": "source-order-only",
                "reason": "E_PICKUP_TYPE 10 follows the shipped enum order; the XT enum stores label index 10, not an integer.",
            },
        ],
        "existingManifest": {
            "path": "_work/powerups/powerups.json",
            "sha256": "",
            "contentHash": "",
            "verifierChecks": 0,
            "verifierFailed": 0,
        },
        "sourceCode": source_evidence(),
        "limits": [
            "Data and a rules/event prototype only; no e1-drive, renderer, GPU or full-game claim.",
            "The retail multiplayer selection surface cannot choose SuperShield; the integration is a project extension, labelled provisional.",
            "No retail parity for FakeSpeed, boost impulse integration, collision inertia, audio or HUD sheet binding.",
            "Health=50 and BrakingBoost=1500 are serialized but unused by C_PickupSuperShield; they are not used as a damage cap or braking model.",
            "No guessed spawn position, MP flag bit or audio entity was added.",
        ],
    }

    existing_path = OUT_DIR / "powerups.json"
    if existing_path.exists():
        existing_bytes = existing_path.read_bytes()
        manifest["existingManifest"]["sha256"] = sha256(existing_bytes)
        existing = json.loads(existing_bytes.decode("utf-8"))
        manifest["existingManifest"]["contentHash"] = existing["hashes"]["manifestContent"]
        verify_path = OUT_DIR / "verify.json"
        if verify_path.exists():
            verify = json.loads(verify_path.read_text(encoding="utf-8"))
            manifest["existingManifest"]["verifierChecks"] = verify["checks"]
            manifest["existingManifest"]["verifierFailed"] = verify["failed"]

    manifest["hashes"] = {
        "manifestContent": canonical_hash(manifest),
        "sources": {Path(s["path"]).name: s["sha256Decoded"] for s in manifest["sources"]},
        "sourceCode": {row["path"]: row["sha256"] for row in manifest["sourceCode"]["files"]},
    }

    text = json.dumps(manifest, indent=1, sort_keys=True) + "\n"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    print("type", type_record, type_ref_id, "level", level_record, level_ref_id,
          "balancing abs", bal_abs)
    print("manifestContent", manifest["hashes"]["manifestContent"])


if __name__ == "__main__":
    main()
