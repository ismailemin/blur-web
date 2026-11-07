"""Build the power-up projectile / impulse recovery manifest (PWR4).

Read-only over the shipped PAK and the extracted retail source reference. Output:
``_work/powerups/projectiles.json``.

Every serialized value is read from the PAK with the committed FLSK rules. Every
runtime value is cited to a file/line in the extracted source tree and hashed.
No value is invented; fields that are not in either place are typed unknowns.
"""
from __future__ import annotations

import hashlib
import json
import re
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402
from xt_decode import Flask  # noqa: E402
from build_powerups import (  # noqa: E402
    PACK, decode_pak_entry, sha256, canonical_hash, level_summary, extract_hud,
)

OUT = ROOT / "_work" / "powerups" / "projectiles.json"
GAME_DIR = ROOT / "game-data" / "Blur"
SOURCE_ROOT = ROOT / "_work" / "engine-vehicle-spike" / "tree"

PICKUPS = "\\gamedata\\xt\\pickups.bin"
UI = "\\gamedata\\xt\\ui.bin"
AUDIO = "\\gamedata\\xt\\audioentities.bin"
RLDB = "\\gamedata\\xt\\rldatabase.bin"
AMAX = "\\gamedata\\xt\\amax.bin"

TYPES = {
    "Blindfire": 271,
    "Shunt": 152,
    "Shock": 202,
    "Barge": 329,
}

FOCUS_LEVELS = {
    "Blindfire": ["Normal", "Reversed", "Modified", "ReversedModified"],
    "Shunt": ["Normal", "DoubleTap", "Reversed"],
    "Shock": ["Normal", "DoubleTap"],
    "Barge": ["Normal"],
}

# Source citations. ``token`` is searched verbatim in the file; the builder records
# the actual line number, so the manifest cannot drift silently.
SOURCE_CITATIONS = [
    # Blindfire projectile
    ("PickupBlindfire.cpp", 'g_debugBlindfireLiveTime', "blindfire.lifetimeSeconds", 25, 10.0),
    ("PickupBlindfire.cpp", "mpBlindfireData->mSpeed", "blindfire.speedFromData", None, None),
    ("PickupBlindfire.cpp", "mAliveTime += C_GameApp", "blindfire.ageAccumulator", None, None),
    ("PickupBlindfire.cpp", "mAliveTime > g_debugBlindfireLiveTime", "blindfire.expire", None, None),
    ("PickupBlindfire.cpp", "RegisterHit(idx)", "blindfire.hit", None, None),
    # Shunt projectile
    ("PickupShunt.cpp", 'g_ShuntKillTime', "shunt.lifetimeSeconds", 31, 40.0),
    ("PickupShunt.cpp", 'g_ShuntMaxSpeed', "shunt.maxSpeed", 29, 110.0),
    ("PickupShunt.cpp", 'g_ShuntMaxHomingSpeed', "shunt.maxHomingSpeed", 30, 50.0),
    ("PickupShunt.cpp", 'g_ShuntWarningRange', "shunt.warningRange", 37, 100.0),
    ("PickupShunt.cpp", 'g_ShuntWarningDot', "shunt.warningDot", 36, 0.5),
    ("PickupShunt.cpp", 'g_ShuntHeightFromGround', "shunt.heightFromGround", 41, 0.3),
    ("PickupShunt.cpp", 'g_ShuntMaxTurnRate', "shunt.maxTurnRate", 38, 180.0),
    ("PickupShunt.cpp", 'g_debugShuntHomingTurnRate', "shunt.homingTurnRate", 50, 65.0),
    ("PickupShunt.cpp", "m_shuntCar.m_minSpeed = 60.0f", "shunt.minSpeed", None, 60.0),
    ("PickupShunt.cpp", "m_killTime = g_ShuntKillTime", "shunt.killTimeFromData", None, None),
    # Shock
    ("PickupShock.cpp", 'g_debugShockSizeDenominator', "shock.sizeDenominator", 43, 60.0),
    ("PickupShock.cpp", 'g_debugShockMinWidth', "shock.minWidth", 46, 0.1),
    ("PickupShock.cpp", 'g_debugShockMaxWidth', "shock.maxWidth", 47, 0.8),
    ("PickupShock.cpp", 'g_debugShockSizeMultiplierBaseLow', "shock.sizeMultiplierLow", 37, 0.85),
    ("PickupShock.cpp", 'g_debugShockSizeMultiplierBaseHigh', "shock.sizeMultiplierHigh", 38, 1.15),
    ("PickupShock.cpp", 'g_debugShockGrowthRateCutOff', "shock.growthCutoffSeconds", 36, 0.7),
    ("PickupShock.cpp", 'g_debugShockInitialGrowthRate', "shock.growthInitial", 34, 1.5),
    ("PickupShock.cpp", 'g_debugShockLateGrowthRate', "shock.growthLate", 35, 1.5),
    ("PickupShock.cpp", "mTotalInnerRadius = mTrackSegmentWidth", "shock.innerRadiusScale", 137, None),
    ("PickupShock.cpp", "mTotalOuterRadius = mTrackSegmentWidth", "shock.outerRadiusScale", 138, None),
    ("PickupShock.cpp", "mCurrentOuterRadius = mTotalOuterRadius * growthLevel", "shock.growth", None, None),
    ("PickupShock.cpp", "mCurrentOuterRadius = Maths::Clamp", "shock.growthClamp", None, None),
    ("PickupShock.cpp", "if( dist2 <= outerRadiusSquared)", "shock.hitTestOuterOnly", None, None),
    ("PickupShock.cpp", "heightDiff >= mpShockData->mHeightDiff", "shock.heightGate", None, None),
    ("PickupShock.cpp", "RegisterHit(i, hitType)", "shock.hit", None, None),
    ("PickupShock.cpp", "mCurrentLifetime > mTotalLifetime", "shock.expire", None, None),
    # Barge
    ("PickupBarge.cpp", 'g_debugBargeOuterRadius', "barge.outerRadius", 23, 2.0),
    ("PickupBarge.cpp", 'g_debugBargeRadiusAddition', "barge.radiusAddition", 24, 0.5),
    ("PickupBarge.cpp", 'g_debugBargeRadiusExtentsFudgeAverage', "barge.extentsFudge", 25, 1.75),
    ("PickupBarge.cpp", 'g_debugBargeIdiotLeniency', "barge.idiotLeniency", 22, 3.0),
    ("PickupBarge.cpp", "mMajorRadius = mpBargeData->mRadius", "barge.majorRadius", 46, None),
    ("PickupBarge.cpp", "mMinorRadius = mpBargeData->mRadius", "barge.minorRadius", 47, None),
    ("PickupBarge.cpp", "mTimer = mpBargeData->mDuration", "barge.durationFromData", 79, None),
    ("PickupBarge.cpp", "mMajorRadius += g_debugBargeRadiusAddition", "barge.radiusAddApplied", 81, None),
    ("PickupBarge.cpp", "IsInsideEllipse(pTargetActor->GetPositionInfo().mWorldPosition, -g_debugBargeOuterRadius", "barge.majorInner", 150, None),
    ("PickupBarge.cpp", "IsInsideEllipse(pTargetActor->GetPositionInfo().mWorldPosition, extendsFudge)", "barge.outer", 142, None),
    ("PickupBarge.cpp", "mTimer <= 0.f", "barge.expire", 125, None),
    # Shared projectile movement / collision
    ("PickupProjectileBase.cpp", "mPrevPos + (mMovementDir * mSpeed * frameTime)", "projectile.travel", 181, None),
    ("PickupProjectileBase.cpp", "mMovementDir * mSpeed * frameTime * 1.2f", "projectile.secondRay", 222, None),
    ("PickupProjectileBase.cpp", "desc.m_Radius=mRadius", "projectile.sphereRadius", 131, None),
    ("PickupProjectileBase.cpp", "(F32)mRadius", "projectile.rayRadius", 445, None),
    ("PickupBase.h", "CheckLegalHit(U32 idx)", "hit.legalDefenderCentric", 72, None),
    ("PickupBase.cpp", "bool C_PickupBase::CheckCanHit", "hit.checkCanHit", 203, None),
    # Damage
    ("VLC_Damage.cpp", "damage = pPickup->mNormal->mBalancingData->GetDamageInflicted();", "damage.base", 2293, None),
    ("VLC_Damage.cpp", "ePickupType == E_PICKUP_TYPE_SHUNT || ePickupType == E_PICKUP_TYPE_SHOCK", "damage.minorHalfTypes", 2296, None),
    ("VLC_Damage.cpp", "damage /= 2;", "damage.minorHalf", 2298, None),
    # Charges / ammo
    ("VLC_Pickups.cpp", "int C_VehicleComponent_Pickups::GetNumShotsAwarded", "charges.function", 2853, None),
    ("VLC_Pickups.cpp", "numShots = 3;", "charges.blindfire", 2859, 3),
    ("VLC_Pickups.cpp", "numShots = 1;", "charges.default", 2855, 1),
    ("VLC_Pickups.cpp", "mPickupStore[a].mNumShots--;", "charges.consume", 1075, None),
    # Fake physics hit effects
    ("VLC_Pickups.cpp", "E_FAKE_PHYSICS_FLIP_FORWARD", "shunt.majorFlip", 1698, None),
    ("VLC_Pickups.cpp", "E_FAKE_PHYSICS_TIP_FORWARD", "shunt.minorTip", 1702, None),
    ("VLC_Pickups.cpp", "E_FAKE_PHYSICS_JINK_BARGE_RIGHT", "barge.majorJinkRight", 1782, None),
    ("VLC_Pickups.cpp", "E_FAKE_PHYSICS_JINK_BARGE_MINOR_RIGHT", "barge.minorJinkRight", 1784, None),
    # Targeting
    ("VehicleLogicActor.cpp", "MAX_TARGET_DISTANCE = 500.f", "targeting.shuntMaxDistance", 2060, 500.0),
    ("VehicleLogicActor.cpp", "MAX_TARGET_OFFSET_ANGLE = 0.707f", "targeting.shuntConeCos", 2059, 0.707),
    ("VehicleLogicActor.cpp", "mPickupInfo.mCurrentTargetIdx = EvaluateShockTarget();", "targeting.shock", 1957, None),
    ("VehicleLogicActor.cpp", "const int C_VehicleLogicActor::EvaluateShockTarget()", "targeting.shockFunction", 2025, None),
    # Shock placement
    ("ShockManager.cpp", 'g_debugShockManagerNumShocks', "shock.domesPerUse", 19, 3),
    ("ShockManager.cpp", 'g_debugShockManagerDistanceLifetimeModifier', "shock.distanceLifetimeModifier", 48, 0.1),
    ("ShockManager.cpp", 'g_debugShockManagerDistanceLifetimeModifierMax', "shock.distanceLifetimeModifierMax", 49, 10.0),
    ("PickupShock.cpp", "mTotalLifetime = mpShockData->mLifetime + lifetimeMod", "shock.totalLifetime", 71, None),
    ("ShockManager.cpp", "mPoint.mWidth = Maths::Clamp", "shock.widthClamp", 757, None),
]

# Fields that are not serialized. ``status`` follows the PWR1 vocabulary.
UNKNOWNS = {
    "Blindfire": [
        {"field": "projectileLifetime", "status": "runtime-only",
         "value": 10.0, "unit": "s", "source": "PickupBlindfire.cpp:25",
         "reason": "Only a Debug::Float default; no lifetime field exists in pickups.bin."},
        {"field": "charges", "status": "runtime-only",
         "value": 3, "unit": "shots", "source": "VLC_Pickups.cpp:2859",
         "reason": "GetNumShotsAwarded hard-codes 3 for Blindfire; no schema field."},
        {"field": "targeting", "status": "runtime-only",
         "value": "forward/no homing", "source": "PickupBlindfire.cpp:30-34",
         "reason": "The Blindfire constructor passes targetIdx -1; movementDir is the firing basis AZ."},
        {"field": "hitVolume", "status": "runtime-only",
         "value": "sphere radius 0.2 + swept ray", "source": "PickupProjectileBase.cpp:128-133,445",
         "reason": "The target vehicle's collision shape is engine data, not in pickups.bin."},
        {"field": "groundAlignment", "status": "runtime-only",
         "value": "ray to ground, trace up 2 m / down 100 m", "source": "PickupProjectileBase.cpp:42-43,300-374",
         "reason": "Depends on the level collision mesh and the deferred ray scheduler."},
        {"field": "maxRange", "status": "not-serialized",
         "value": None, "candidates": {"warningDistance": 100.0, "derivedLifetimeTravelM": 3000.0},
         "reason": "WarningDistance is a warning cone; 10 s x 300 m/s is derived, not an engine cap."},
    ],
    "Shunt": [
        {"field": "projectileLifetime", "status": "runtime-only",
         "value": 40.0, "unit": "s", "source": "PickupShunt.cpp:31",
         "reason": "Debug::Float kill time; no lifetime field in ShuntBalancingData."},
        {"field": "projectileSpeed", "status": "runtime-only",
         "value": "initial max(forward+15,10); min 60; max 110; homing 0.3..1.0 x 50 + target speed",
         "source": "PickupShunt.cpp:197-200,510,610,685",
         "reason": "ShuntBalancingData has no Speed; only ShuntReverseBalancingData has Speed=50."},
        {"field": "homing", "status": "runtime-only",
         "value": "target required; cone/turn rate from debug defaults", "source": "PickupShunt.cpp:28-53,499-776",
         "reason": "Homing state machine and turn rates are code, not fields."},
        {"field": "heightFromGround", "status": "runtime-only",
         "value": 0.3, "unit": "m", "source": "PickupShunt.cpp:41,72",
         "reason": "ShuntBalancingData has no height field; only Reverse has HeightFromGround."},
        {"field": "charges", "status": "runtime-only",
         "value": 1, "unit": "shot", "source": "VLC_Pickups.cpp:2855",
         "reason": "Default one-shot path; no schema field."},
        {"field": "hitVolume", "status": "runtime-only",
         "value": "sphere radius 0.75 + swept ray", "source": "PickupShunt.cpp:71;PickupProjectileBase.cpp:445",
         "reason": "Target vehicle shape is engine data."},
        {"field": "hitStrength", "status": "runtime-only",
         "value": "major while health==max, minor after damage", "source": "PickupShunt.cpp:389-391",
         "reason": "mHealth is runtime projectile health."},
        {"field": "maxRange", "status": "not-serialized",
         "value": None, "candidates": {"humanTargetMaxDistance": 500.0, "warningRange": 100.0, "derivedLifetimeTravelM": 4400.0},
         "reason": "ShuntBalancingData has no range; 40 s x 110 m/s is derived."},
    ],
    "Barge": [
        {"field": "charges", "status": "runtime-only",
         "value": 1, "unit": "shot", "source": "VLC_Pickups.cpp:2855",
         "reason": "Default one-shot path."},
        {"field": "hitVolume", "status": "runtime-only",
         "value": "ellipse (circle) radius 7.5 around the firing car; extents fudge from the target", "source": "PickupBarge.cpp:46-47,81-82,139-157",
         "reason": "The target extents are engine vehicle data, not in pickups.bin."},
        {"field": "majorMinorBand", "status": "runtime-only",
         "value": "inner band 2.0 m + extentsFudge", "source": "PickupBarge.cpp:23,150",
         "reason": "OuterRadius debug default 2.0 is the only band width."},
        {"field": "impulseMagnitude", "status": "not-serialized",
         "value": None, "source": "VLC_Pickups.cpp:1781-1800",
         "reason": "Barge applies a FakePhysics jink (major/minor), not a linear impulse; the jink constants are debug defaults."},
        {"field": "maxRange", "status": "serialized-radius-only",
         "value": 7.5, "unit": "m", "source": "BargeBalancingData.Radius 7.0 + 0.5",
         "reason": "Radius is serialized; the +0.5 is a runtime debug addition."},
    ],
    "Shock": [
        {"field": "domeCount", "status": "runtime-only",
         "value": 3, "unit": "domes per use", "source": "ShockManager.cpp:19,177",
         "reason": "No dome-count field in ShockBalancingData."},
        {"field": "placement", "status": "runtime-only",
         "value": "3 domes along the target's racing spline ahead", "source": "ShockManager.cpp:681-773",
         "reason": "Requires the AI track/spline data, which is not in these packs."},
        {"field": "actualRadii", "status": "runtime-only",
         "value": "width x sizeMultiplier x InnerRadius/OuterRadius; width 0.1..0.8", "source": "PickupShock.cpp:137-138,69;ShockManager.cpp:757",
         "reason": "InnerRadius/OuterRadius are scale factors; the real radius is computed at runtime."},
        {"field": "lifetime", "status": "runtime-only",
         "value": "1.5 + distanceLifetimeModifier (0..10) s, then FX-loop rounding", "source": "ShockManager.cpp:110-111;PickupShock.cpp:84-101",
         "reason": "Only the base 1.5 s is serialized."},
        {"field": "sizeMultiplier", "status": "runtime-only",
         "value": "random 0.85..1.15, seeded by uniqueId*width", "source": "PickupShock.cpp:67-69",
         "reason": "Deterministic per shock id but not serialized."},
        {"field": "hitStrength", "status": "runtime-only",
         "value": "always MINOR; inner-radius check is commented out", "source": "PickupShock.cpp:253-256",
         "reason": "So the applied damage is 100/2 = 50 even inside InnerRadius."},
        {"field": "maxRange", "status": "not-serialized",
         "value": None, "candidates": {"warningDistance": 15.0, "domePlacementAheadM": "runtime spline"},
         "reason": "Shock is placed on the track, not fired at a range."},
    ],
}

CONTRACT = {
    "events": [
        {"event": "projectile-fired", "payload": ["seq", "authority", "projectileId", "pickupType", "level", "ownerId", "origin", "direction", "targetId", "speedMps", "lifetimeSeconds", "chargesRemaining", "source"],
         "sync": "reliable, once; host-authoritative"},
        {"event": "projectile-travelled", "payload": ["seq", "projectileId", "at", "position"], "sync": "derived/optional; not authoritative"},
        {"event": "projectile-hit", "payload": ["seq", "projectileId", "targetId", "hitType", "damage", "impulse", "at"], "sync": "reliable"},
        {"event": "projectile-miss", "payload": ["seq", "projectileId", "reason", "at"], "sync": "reliable if it affects HUD/audio"},
        {"event": "projectile-expired", "payload": ["seq", "projectileId", "reason", "at"], "sync": "derived; may be omitted if both peers tick"},
        {"event": "barge-hit", "payload": ["seq", "bargeId", "targetId", "hitType", "damage", "fakePhysics", "at"], "sync": "reliable"},
        {"event": "shock-dome-spawned", "payload": ["seq", "domeId", "ownerId", "targetId", "position", "width", "baseOuterRadius", "actualOuterRadius", "lifetimeSeconds"], "sync": "reliable"},
        {"event": "shock-hit", "payload": ["seq", "domeId", "targetId", "damage", "at"], "sync": "reliable"},
        {"event": "dynamic-object-impulse", "payload": ["seq", "sourcePickup", "objectId", "force", "electricalEffect", "at"], "sync": "reliable if the object is replicated"},
    ],
    "authority": {
        "model": "host-authoritative M2; retail validation is defender-centric (CheckLegalHit)",
        "host": "owns projectile ids, seq, hit judgement for M2, charges, inventory and expiry",
        "client": "sends fire/aim intents; renders from host events; never judges a hit locally",
        "retailNote": "C_PickupBase::CheckLegalHit returns true for the defender's local vehicle for these defender-centric pickups (PickupBase.h:72). M2 must not silently switch to firer-side hit judgement.",
    },
    "values": {
        "projectileLifetimeSeconds": {"Blindfire": 10.0, "Shunt": 40.0, "source": "runtime-only"},
        "projectileSpeedMps": {"Blindfire": 300.0, "Shunt": "runtime initial 10..(forward+15), max 110", "source": "XT + runtime"},
        "charges": {"Blindfire": 3, "Shunt": 1, "Barge": 1, "Shock": 1, "source": "runtime-only"},
        "damage": {"Blindfire": 50, "ShuntMajor": 100, "ShuntMinor": 50, "Barge": 100, "ShockApplied": 50, "source": "XT + minor-hit rule"},
    },
    "provisional": [
        "Shunt linear impulse magnitude is not a retail value; the retail effect is a FakePhysics flip/tip.",
        "Barge fake-physics jink magnitude is not serialized.",
        "Shock dome positions/widths require the track spline; a model must require caller inputs.",
        "Target collision shapes/extents are engine data; the JS model requires caller-provided radii/extents.",
        "The deterministic Shock size multiplier maps a hash to 0.85..1.15; this is a project determinism choice, not a recovered RNG.",
    ],
}


def read_file(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def find_type(flask: Flask, name: str) -> int:
    for i in range(len(flask.types)):
        if flask.type_name(i) == name:
            return i
    raise SystemExit(f"type not found: {name}")


def record_by_id(flask: Flask, ref_id: int) -> int:
    for i in range(len(flask.records)):
        if flask.record_id(i) == ref_id:
            return i
    raise SystemExit(f"record not found: {ref_id}")


def component_offset(flask: Flask, record: int, component: int) -> int:
    start = sum(flask.records[i][1] for i in range(record))
    off = 0
    for typ, count, behaviour in flask.components[start:start + component]:
        off = (off + count * (flask.types[typ][5] if behaviour == 0 else 4) + 3) & ~3
    return off


def decode_atom(flask: Flask, type_index: int, payload: bytes, off: int):
    t = flask.types[type_index]
    atom = t[4]
    if atom == 1:
        return struct.unpack_from("<I", payload, off)[0] != 0
    if atom == 2:
        return struct.unpack_from("<b", payload, off)[0]
    if atom == 3:
        return struct.unpack_from("<h", payload, off)[0]
    if atom == 4:
        return struct.unpack_from("<i", payload, off)[0]
    if atom == 5:
        return struct.unpack_from("<q", payload, off)[0]
    if atom == 6:
        return struct.unpack_from("<B", payload, off)[0]
    if atom == 7:
        return struct.unpack_from("<H", payload, off)[0]
    if atom == 8:
        return struct.unpack_from("<I", payload, off)[0]
    if atom == 9:
        return struct.unpack_from("<Q", payload, off)[0]
    if atom == 10:
        return struct.unpack_from("<f", payload, off)[0]
    if atom == 11:
        return struct.unpack_from("<d", payload, off)[0]
    if atom in (12, 13):
        raw = struct.unpack_from("<I", payload, off)[0]
        strings = flask._current_strings
        end = strings.find(b"\0", raw) if raw < len(strings) else -1
        return strings[raw:end].decode("latin-1") if end >= 0 else None
    if atom == 14:
        return f"{struct.unpack_from('<I', payload, off)[0]:08x}"
    raise SystemExit(f"unsupported atom {atom}")


def field_values(flask: Flask, type_index: int, payload: bytes, base: int) -> dict:
    out = {}
    for f in flask.all_fields(type_index):
        off = base + f["offset"]
        if f["array"]:
            continue
        if f["behaviour"] == 3:
            child = flask.types[f["typeIndex"]]
            out[f["name"]] = {
                "type": flask.type_name(f["typeIndex"]),
                "offset": off,
                "fields": field_values(flask, f["typeIndex"], payload, off)
                if child[3] == 3 else None,
            }
        elif f["behaviour"] in (0, 1, 2):
            out[f["name"]] = {
                "offset": off,
                "value": decode_atom(flask, f["typeIndex"], payload, off)
                if f["behaviour"] == 0 else
                {"labelIndex": struct.unpack_from("<I", payload, off)[0],
                 "label": flask.type_labels(f["typeIndex"])[struct.unpack_from("<I", payload, off)[0]]}
                if f["behaviour"] == 1 else
                {"bits": struct.unpack_from("<I", payload, off)[0]},
            }
        else:
            out[f["name"]] = {"offset": off, "pointer": True}
    return out


def level_info(flask: Flask, entity_record: int, slot: str) -> dict | None:
    doc = flask.decode_record(entity_record)
    handle = doc.get(slot)
    if not handle or not handle.get("value"):
        return None
    level_record = handle["record"]
    level_value = handle["value"]
    balancing = level_value.get("BalancingData")
    balancing_type = balancing.get("$type") if isinstance(balancing, dict) else None
    payload = flask.record_payload(level_record)
    comp, elem = struct.unpack_from("<2H", payload, 12)
    start = sum(flask.records[i][1] for i in range(level_record))
    comp_type, comp_count, comp_behaviour = flask.components[start + comp]
    stride = flask.types[comp_type][5] if comp_behaviour == 0 else 4
    bal_off = component_offset(flask, level_record, comp) + elem * stride
    if flask.type_name(comp_type) != balancing_type:
        raise SystemExit(f"{slot}: pointer type mismatch {flask.type_name(comp_type)} != {balancing_type}")
    fields = field_values(flask, comp_type, payload, bal_off)
    summary = level_summary(flask, handle)
    return {
        "slot": slot,
        "levelRecord": level_record,
        "levelRefId": handle["refId"],
        "balancingType": balancing_type,
        "balancingPayloadOffset": bal_off,
        "balancingComponent": comp,
        "balancingElement": elem,
        "fields": fields,
        "balancingGraph": {
            "levelRecord": level_record,
            "fieldOffset": 0,
            "keyframes": summary.get("balancingGraph", {}).get("keyframes", []) if summary else [],
            "maxBoost": summary.get("balancingGraph", {}).get("maxBoost") if summary else None,
        },
        "specialFx": summary.get("specialFx") if summary else None,
    }


def perk_fx(level: dict) -> dict:
    out = {}
    for arr in (level.get("specialFx") or {}).get("arrays", []):
        slot = arr.get("slot")
        if slot in ("ProjectileSpecialFX", "ProjectileDroppedSpecialFX",
                    "HitEnvironmentSpecialFX", "ExplosionSpecialFX",
                    "FiredSpecialFX", "ChargingSpecialFX", "HitVehicleSpecialFX"):
            out[slot] = {
                "count": arr.get("count"),
                "items": [{"location": i.get("location"), "durations": {
                    "intro": i.get("durationIntro"), "loop": i.get("durationLoop"),
                    "outro": i.get("durationOutro")}, "assets": i.get("assets")}
                          for i in arr.get("items", [])],
            }
    return out


def ai_triggers(entity_doc: dict) -> list:
    raw = entity_doc.get("AIPickupTypes")
    items = raw.get("items", []) if isinstance(raw, dict) else []
    out = []
    for item in items:
        usage = []
        for row in (item.get("UsageTypes") or {}).get("items", []) if isinstance(item.get("UsageTypes"), dict) else []:
            usage.append({k: v for k, v in row.items() if not k.startswith("$")})
        out.append({"trigger": item.get("$type"), "usageTypes": usage})
    return out


def force_effects(pick: Flask, rld: Flask) -> dict:
    rec = record_by_id(pick, 4122981083)
    if pick.type_name(pick.record_type(rec)) != "PerkForceEffects":
        raise SystemExit("PerkForceEffects record type mismatch")
    payload = pick.record_payload(rec)
    type_index = pick.record_type(rec)
    effects = {}
    effect_type = find_type(pick, "ForceEffect")
    for f in pick.type_fields(type_index):
        if f["behaviour"] != 3:
            continue
        base = f["offset"]
        fields = field_values(pick, effect_type, payload, base)
        effects[f["name"]] = {"recordOffset": base, "fields": fields}
    # Cross-pack reference from rldatabase System.PerkForceEffects.
    sys_rec = record_by_id(rld, 2206278946)
    sys_payload = rld.record_payload(sys_rec)
    sys_field = next(f for f in rld.all_fields(rld.record_type(sys_rec))
                     if f["name"] == "PerkForceEffects")
    ref_index = struct.unpack_from("<I", sys_payload, sys_field["offset"])[0]
    ref_id, ref_type, ref_record = rld.refs[ref_index]
    return {
        "pack": PICKUPS,
        "record": rec,
        "refId": pick.record_id(rec),
        "type": "PerkForceEffects",
        "fieldOffsets": {f["name"]: f["offset"] for f in pick.type_fields(type_index)},
        "effects": effects,
        "crossReference": {
            "fromPack": RLDB,
            "fromRecord": sys_rec,
            "fromRefId": rld.record_id(sys_rec),
            "field": "PerkForceEffects",
            "fieldOffset": sys_field["offset"],
            "refIndex": ref_index,
            "refId": ref_id,
            "typeName": rld.type_name(ref_type),
            "recordInOwningPack": None if ref_record == 0xFFFF else ref_record,
            "unloadedInOwningPack": ref_record == 0xFFFF,
            "resolvesByRefIdInPickups": ref_id == pick.record_id(rec),
        },
    }


def ai_controller(pick: Flask) -> dict:
    rec = record_by_id(pick, 742508891)
    type_index = pick.record_type(rec)
    payload = pick.record_payload(rec)
    out = {"record": rec, "refId": pick.record_id(rec), "type": "AIPickupControllerSetup",
           "fieldOffsets": {f["name"]: f["offset"] for f in pick.all_fields(type_index)},
           "values": {}}
    for f in pick.all_fields(type_index):
        if f["array"]:
            continue
        if f["behaviour"] == 0:
            out["values"][f["name"]] = decode_atom(pick, f["typeIndex"], payload, f["offset"])
    doc = pick.decode_record(rec)
    graphs = []
    for item in (doc.get("AIPickupAccuracyGraphs") or {}).get("items", []):
        keyframes = (item.get("InRangeAccuracyGraph") or {}).get("items", [])
        graphs.append({"keyframes": keyframes})
    out["accuracyGraphs"] = graphs
    out["provenance"] = ("AIPickupAccuracyGraph is AI aim probability vs distance, not the human "
                         "projectile hit volume; the 7 graphs are indexed by pickup class in runtime code.")
    return out


def audio_summary(audio: Flask) -> dict:
    wanted = {
        "Shock": ["Shock", "ShockProjectile", "ShockHit"],
        "Shunt": ["Shunt", "ShuntProjectile", "ShuntHit"],
        "Blindfire": ["BlindFire", "BlindFireProjectile", "BlindFireHit"],
        "Barge": ["Barge", "BargeHit"],
    }

    def val(x):
        return x.get("value") if isinstance(x, dict) else x

    def ref(x):
        return {"refId": x.get("refId"), "type": x.get("typeName")} if isinstance(x, dict) else None

    # Shallow name scan first: decoding every AudioEntityDef recursively is slow.
    wanted_names = {name for names in wanted.values() for name in names}
    candidates = {}
    for ri in range(len(audio.records)):
        payload = audio.record_payload(ri)
        raw = struct.unpack_from("<I", payload, 0)[0]
        strings = audio.record_strings(ri)
        end = strings.find(b"\0", raw) if raw < len(strings) else -1
        if end < 0:
            continue
        name = strings[raw:end].decode("latin-1")
        if name in wanted_names:
            candidates[name] = ri
    rows = {name: audio.decode_record(ri) for name, ri in candidates.items()}
    out = {}
    for label, names in wanted.items():
        out[label] = []
        for name in names:
            doc = rows.get(name)
            if not doc:
                out[label].append({"name": name, "found": False})
                continue
            ri = candidates[name]
            inst = doc.get("instFunction") or {}
            out[label].append({
                "name": name,
                "found": True,
                "record": ri,
                "refId": audio.record_id(ri),
                "group": ref(doc.get("group")),
                "objects": [ref(o.get("object")) for o in (doc.get("objCreate") or {}).get("objCreates", {}).get("items", [])],
                "instances": [val(i.get("name")) for i in (inst.get("instances") or {}).get("items", [])],
                "connectorsOut": sorted({val(c.get("component")) for c in (inst.get("connectorsOut") or {}).get("items", [])}),
                "connectorsIn": sorted({val(c.get("component")) for c in (inst.get("connectorsIn") or {}).get("items", [])}),
                "externs": [val(e.get("referenceString")) for e in (doc.get("externs") or {}).get("items", [])],
                "externParamOuts": [val(e.get("referenceString")) for e in (doc.get("externParamOuts") or {}).get("items", [])],
            })
    return out


def hud_summary(ui: Flask) -> dict:
    hud = extract_hud(ui)
    perk_type = find_type(ui, "UiPerkDisplayParameters")
    offsets = {f["name"]: f["offset"] for f in ui.all_fields(perk_type)}
    keys = ["shock", "shunt", "barge", "blindfire1", "blindfire2", "blindfire3",
            "extra_blindfire1", "extra_blindfire2", "extra_blindfire3", "extra_blindfire4"]
    entries = {}
    for key in keys:
        value = hud["perkEntries"].get(key)
        if value is None:
            continue
        entries[key] = {
            "fieldOffset": offsets.get(key),
            "recordOffset": hud["source"]["fieldOffset"] + offsets.get(key, 0),
            "entry": value,
        }
    return {
        "source": hud["source"],
        "entries": entries,
        "iconSheets": hud["iconSheets"],
        "helpScreen": hud["helpScreen"],
        "binding": "UiPerkInfo.texture_index indexes the perk icon sheet; no typed sheet binding is present.",
    }


def source_evidence() -> dict:
    files = {}
    citations = []
    for filename, token, field, expected_line, expected_value in SOURCE_CITATIONS:
        matches = [p for p in SOURCE_ROOT.rglob(filename)]
        if not matches:
            raise SystemExit(f"source file not found: {filename}")
        path = matches[0]
        text = read_file(path)
        lines = text.splitlines()
        hits = [i + 1 for i, line in enumerate(lines) if token in line]
        if not hits:
            raise SystemExit(f"token not found in {filename}: {token}")
        line_no = hits[0]
        if expected_line is not None and line_no != expected_line:
            raise SystemExit(f"{filename}: token {token!r} at line {line_no}, expected {expected_line}")
        rel = path.relative_to(ROOT).as_posix()
        files.setdefault(rel, {"path": rel, "sha256": sha256(path.read_bytes()),
                               "bytes": path.stat().st_size})
        citations.append({
            "field": field,
            "file": rel,
            "line": line_no,
            "token": token,
            "text": lines[line_no - 1].strip(),
            "expectedValue": expected_value,
        })
    return {"files": sorted(files.values(), key=lambda x: x["path"]), "citations": citations}


def main() -> None:
    index = pak_index(GAME_DIR / "cache" / PACK)
    pick = decode_pak_entry(index, GAME_DIR / "cache" / PACK, PICKUPS)
    ui = decode_pak_entry(index, GAME_DIR / "cache" / PACK, UI)
    audio = decode_pak_entry(index, GAME_DIR / "cache" / PACK, AUDIO)
    rld = decode_pak_entry(index, GAME_DIR / "cache" / PACK, RLDB)
    amax = decode_pak_entry(index, GAME_DIR / "cache" / PACK, AMAX)

    from xt_decode import Flask
    pick_flask = Flask(pick["bytes"])
    ui_flask = Flask(ui["bytes"])
    audio_flask = Flask(audio["bytes"])
    rld_flask = Flask(rld["bytes"])
    amax_flask = Flask(amax["bytes"])

    sources = []
    for row in (pick, ui, audio, rld, amax):
        sources.append({k: v for k, v in row.items() if k != "bytes"})

    existing = ROOT / "_work" / "powerups" / "powerups.json"
    existing_bytes = existing.read_bytes()
    existing_text = existing_bytes.decode("utf-8")
    existing_manifest = json.loads(existing_text)
    verify_path = ROOT / "_work" / "powerups" / "verify.json"
    verify = json.loads(verify_path.read_text(encoding="utf-8")) if verify_path.exists() else {}
    if verify.get("checks") != 1783 or verify.get("failed") != 0:
        raise SystemExit("existing 1,783-check powerups verifier is not intact")

    types = {}
    for label, rec in TYPES.items():
        doc = pick_flask.decode_record(rec)
        levels = {}
        for slot in FOCUS_LEVELS[label]:
            info = level_info(pick_flask, rec, slot)
            if info:
                info["projectileFx"] = perk_fx(info)
                levels[slot] = info
        types[label] = {
            "pickupLabel": label,
            "record": rec,
            "refId": pick_flask.record_id(rec),
            "type": pick_flask.type_name(pick_flask.record_type(rec)),
            "levels": levels,
            "aiUsageType": doc.get("AIUsageType"),
            "aiTriggers": ai_triggers(doc),
            "classification": {
                "status": "partial-runtime",
                "basis": "Serialized gameplay fields recover; projectile lifetime, charges, "
                         "target selection, actual hit volume and fake-physics magnitude are runtime.",
            },
            "missing": UNKNOWNS[label],
        }

    # Shock-specific route width evidence (the raced River route).
    route_type = find_type(amax_flask, "Route")
    route_rec = None
    for ri in range(len(amax_flask.records)):
        if amax_flask.record_type(ri) == route_type and amax_flask.record_id(ri) == 1643385212:
            route_rec = ri
            break
    route_doc = amax_flask.decode_record(route_rec) if route_rec is not None else {}
    city_handle = route_doc.get("City") if route_doc else None
    city_name = None
    if isinstance(city_handle, dict):
        city_value = city_handle.get("value") or {}
        city_name = (city_value.get("Name") or {}).get("value")
    shock_route = {
        "routeRecord": route_rec,
        "routeId": amax_flask.record_id(route_rec) if route_rec is not None else None,
        "routeNumber": route_doc.get("RouteNumber") if route_doc else None,
        "city": city_name,
        "shockWidthWeighting": route_doc.get("ShockWidthWeighting") if route_doc else None,
        "fieldOffset": next((f["offset"] for f in amax_flask.all_fields(route_type)
                             if f["name"] == "ShockWidthWeighting"), None),
        "effect": "0.0 means the runtime falls back to extremeWidthWeighting=1.0 "
                  "(ShockManager.cpp:752-754).",
    }

    manifest = {
        "schema": "blur-powerups-projectiles/1",
        "generatedBy": "probes/powerups/tools/build_projectiles.py",
        "date": "2026-11-07",
        "owner": "PWR4",
        "scope": "projectile/weapon definitions for Blindfire/Bolt, Shunt, Barge and the Shock dome hit test",
        "sources": sources,
        "sourceCode": source_evidence(),
        "perkForceEffects": force_effects(pick_flask, rld_flask),
        "aiController": ai_controller(pick_flask),
        "hud": hud_summary(ui_flask),
        "audio": audio_summary(audio_flask),
        "shockRoute": shock_route,
        "runtimeValues": {
            "Blindfire": {
                "lifetimeSeconds": 10.0, "charges": 3, "heightFromGroundM": 0.3,
                "traceUpM": 2.0, "traceDownM": 100.0, "source": "PickupBlindfire.cpp:25;PickupProjectileBase.cpp:42-43",
            },
            "Shunt": {
                "lifetimeSeconds": 40.0, "charges": 1, "minSpeedMps": 60.0,
                "maxSpeedMps": 110.0, "maxHomingSpeedMps": 50.0, "heightFromGroundM": 0.3,
                "homingTurnRateDegPerSec": 65.0, "maxTurnRateDegPerSec": 180.0,
                "warningRangeM": 100.0, "warningDot": 0.5,
                "source": "PickupShunt.cpp:29-41,50;VLC_Pickups.cpp:2855",
            },
            "Barge": {
                "charges": 1, "paddingM": 0.5, "innerBandM": 2.0,
                "extentsFudgeAverageM": 1.75, "idiotLeniencyM": 3.0,
                "source": "PickupBarge.cpp:22-25,81-82,142-150;VLC_Pickups.cpp:2855",
            },
            "Shock": {
                "charges": 1, "domesPerUse": 3, "sizeMultiplierLow": 0.85,
                "sizeMultiplierHigh": 1.15, "growthCutoffSeconds": 0.7,
                "growthInitial": 1.5, "growthLate": 1.5,
                "minWidth": 0.1, "maxWidth": 0.8, "sizeDenominator": 60.0,
                "source": "PickupShock.cpp:34-47;ShockManager.cpp:19;VLC_Pickups.cpp:2855",
            },
        },
        "types": types,
        "damageModel": {
            "baseField": "XxBalancingData.DamageInflicted",
            "blindfire": 50,
            "shuntMajor": 100,
            "shuntMinor": 50,
            "bargeAny": 100,
            "shockApplied": 50,
            "shockBase": 100,
            "minorHalfTypes": ["Shunt", "Shock"],
            "source": "VLC_Damage.cpp:2291-2299",
            "note": "Shock always registers MINOR (inner-radius check commented out), so its applied damage is 50.",
        },
        "targetingModel": {
            "blindfire": {"mode": "forward", "targetIdx": -1,
                          "source": "PickupBlindfire.cpp:30-34",
                          "ai": "AIPickupTypeEnemyInRange distance/angle 40/40, 30/30, 20/20"},
            "shunt": {"mode": "targeted/homing", "targetRequired": True,
                      "human": "camera LOS, dotForward > cos(45°), distance <= 500 m, score=angle*(sqrt(distance/500)); lowest wins",
                      "humanSource": "VehicleLogicActor.cpp:2059-2060,2188-2219",
                      "ai": "AIPickupTypeEnemyInRange distance/angle 40/40, 30/30, 20/20",
                      "warning": "100 m, dot >= 0.5 (runtime; XT has ECM 13/20/25)"},
            "shock": {"mode": "ahead-in-race-order",
                      "human": "EvaluateShockTarget: lowest mRacePosition among still-racing vehicles",
                      "source": "VehicleLogicActor.cpp:2025-2052",
                      "placement": "3 domes along the target's AI spline ahead; not serialized"},
            "barge": {"mode": "self-centred area", "targetRequired": False,
                      "source": "PickupBarge.cpp:132-160"},
        },
        "hitTestModel": {
            "blindfire": {"shape": "sphere + swept ray", "radius": 0.2,
                          "falloff": "none", "maxTargets": 1,
                          "source": "PickupProjectileBase.cpp:128-133,445;PickupBlindfire.cpp:137-165"},
            "shunt": {"shape": "sphere + swept ray", "radius": 0.75,
                      "falloff": "none; major/minor from projectile health",
                      "maxTargets": 1, "source": "PickupShunt.cpp:389-391;PickupProjectileBase.cpp:445"},
            "barge": {"shape": "ellipse/circle around owner", "radius": 7.0,
                      "runtimePadding": 0.5, "innerBand": 2.0, "extentsFudge": 1.75,
                      "falloff": "none; major/minor only changes fake-physics jink",
                      "maxTargets": "all vehicles in the ellipse", "source": "PickupBarge.cpp:139-160,308-329"},
            "shock": {"shape": "growing 3D sphere", "baseInner": 7.0, "baseOuter": 14.0,
                      "actualOuter": "width * sizeMultiplier * OuterRadius",
                      "innerUsed": False, "falloff": "none (always MINOR -> 50)",
                      "heightGate": -1.5, "maxTargets": "all vehicles inside, once per dome",
                      "source": "PickupShock.cpp:137-138,203-285"},
        },
        "impulseModel": {
            "vehicleFakePhysics": {
                "shuntMajor": "E_FAKE_PHYSICS_FLIP_FORWARD",
                "shuntMinor": "E_FAKE_PHYSICS_TIP_FORWARD",
                "bargeMajor": "E_FAKE_PHYSICS_JINK_BARGE_LEFT/RIGHT",
                "bargeMinor": "E_FAKE_PHYSICS_JINK_BARGE_MINOR_LEFT/RIGHT",
                "magnitude": "not-serialized (FakePhysics debug defaults)",
                "reproducibleFromData": False,
                "provisionalLinearImpulse": "20 kN*s forward (BOOST1 measurement) is a design choice, not retail",
            },
            "dynamicObjectForce": {
                "source": "PerkForceEffects (pickups.bin record 821)",
                "values": {
                    name: effect["fields"]["MaxForce"]["value"]
                    for name, effect in force_effects(pick_flask, rld_flask)["effects"].items()
                },
                "reproducibleFromData": True,
                "note": "MaxForce is applied to dynamic/physical objects, not to vehicles.",
            },
            "bargeMinePush": {
                "MinMinePushForce": 50000.0,
                "MinePushForceMultiplier": 1000.0,
                "activeInRetail": False,
                "source": "BargeBalancingData + PickupBarge.cpp:200-218 (commented out)",
            },
        },
        "contract": CONTRACT,
        "classification": {
            "overall": "partial-runtime",
            "types": {label: types[label]["classification"] for label in TYPES},
            "notSerialized": sorted({u["field"] for rows in UNKNOWNS.values() for u in rows}),
        },
        "unknowns": UNKNOWNS,
        "existingManifest": {
            "path": "_work/powerups/powerups.json",
            "sha256": sha256(existing_bytes),
            "contentHash": existing_manifest.get("hashes", {}).get("manifestContent"),
            "verifierChecks": verify.get("checks"),
            "verifierFailed": verify.get("failed"),
            "intact": verify.get("checks") == 1783 and verify.get("failed") == 0,
        },
        "limits": [
            "This manifest is data and a rules contract; it is not a retail-parity or full-game claim.",
            "Runtime values are the shipped source's Debug::Float/Int defaults; a retail build's persisted debug overrides are not read.",
            "Target collision shapes/extents and track spline data are not in the XT packs; the JS model requires caller inputs.",
            "No e1-drive, boost-feasibility, race-rules, net-mvp, asset-reader, tools, upstream or game-data file is changed.",
            "The existing 1,783-check powerups manifest is not modified; its hash is recorded and checked.",
        ],
    }
    manifest["hashes"] = {
        "manifestContent": canonical_hash(manifest),
        "sources": {Path(s["path"]).name: s["sha256Decoded"] for s in sources},
        "sourceCode": {row["path"]: row["sha256"] for row in manifest["sourceCode"]["files"]},
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(manifest, indent=1, sort_keys=True) + "\n"
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT} ({len(text)} bytes)")
    print("manifestContent", manifest["hashes"]["manifestContent"])
    for label in TYPES:
        print(f"{label}: levels={list(types[label]['levels'])} missing={len(types[label]['missing'])}")
    print("force effects", list(manifest["perkForceEffects"]["effects"]))
    print("audio", {k: [r["name"] for r in v if r.get("found")] for k, v in manifest["audio"].items()})


if __name__ == "__main__":
    main()
