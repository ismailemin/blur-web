"""Build the Blur Web VFX manifest from shipped PC data (read-only).

Outputs (not committed):
  _work/vfx/effects.json
  _work/vfx/textures/*.texture|*.png|*.json

Sources inside game-data/Blur/cache:
  gamedata.pak  \\gamedata\\xt\\dynamiceffects.bin  (75 types / 1,132 records)
  gamedata.pak  \\gamedata\\xt\\amax.bin           (wheel/impact/misc trigger tables)
  gamedata.pak  \\gamedata\\xt\\pickups.bin        (perk SpecialFX trees)
  root.pak      \\graphics\\textures\\particles\\* (sprite pages)
  root.pak      \\graphics\\textures\\specialfx\\* (gate sprites)

No value is guessed: every parameter is read from the decoded records, and each
invocation of the decode is recorded with the record id and payload offset.
Runtime/project values are tagged `code` or `provisional` and listed under
`missing` with a typed reason when the definition itself is incomplete.
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

import vfx_pak  # noqa: E402
import vfx_xt  # noqa: E402
from inspect_asset_layout import pak_index as reference_pak_index  # noqa: E402

GAME = ROOT / "game-data" / "Blur" / "cache"
OUT = ROOT / "_work" / "vfx"
TEXOUT = OUT / "textures"
GAMEDATA = GAME / "gamedata.pak"
ROOTPAK = GAME / "root.pak"

DYNAMIC = "\\gamedata\\xt\\dynamiceffects.bin"
AMAX = "\\gamedata\\xt\\amax.bin"
PICKUPS = "\\gamedata\\xt\\pickups.bin"

TRIGGER_CONTRACTS = {
    "nitro-activated": "docs/work/analysis/powerups.md section 8.1 (use -> nitro-activated)",
    "supershield-activated": "docs/work/analysis/supershield.md section 7",
    "shield-activated": "docs/work/analysis/powerups.md section 8.1",
    "mine-placed": "docs/work/analysis/powerups.md section 8.1 (use -> mine-placed)",
    "mine-detonated": "docs/work/analysis/powerups.md section 8.1",
    "repaired": "docs/work/analysis/powerups.md section 8.1 (use -> repaired)",
    "shock-activated": "docs/work/analysis/powerups.md section 8.1",
    "shock-hit": "docs/work/analysis/powerup-projectiles.md section 8.1",
    "barge-activated": "docs/work/analysis/powerups.md section 8.1",
    "barge-hit": "docs/work/analysis/powerup-projectiles.md section 8.1",
    "projectile-fired": "docs/work/analysis/powerup-projectiles.md section 8.1",
    "projectile-hit": "docs/work/analysis/powerup-projectiles.md section 8.1",
    "damage": "docs/work/analysis/powerups.md section 8.1",
    "wrecked": "docs/work/analysis/powerups.md section 8.1",
    "start-crossing": "probes/e1-drive/web/ai-driver-browser.js sprint events",
    "checkpoint": "probes/e1-drive/web/ai-driver-browser.js sprint events",
    "lap": "probes/e1-drive/web/ai-driver-browser.js sprint events",
    "finish": "probes/e1-drive/web/ai-driver-browser.js sprint events",
    "wheel-slip": "provisional project name for WheelSurfaceParticleEventTrigger.SlideFactor",
    "wheel-spin": "provisional project name for WheelSurfaceParticleEventTrigger.WheelSpin",
    "wheel-speed": "provisional project name for WheelSurfaceParticleEventTrigger.Speed",
    "impact-sparks": "provisional project name for AmaxImpactSurfaceEffect",
    "exhaust-pop": "provisional project name for MiscParticleEventType.ExhaustPop",
}

# Event records selected from the shipped trigger tables. Every id is a
# dynamiceffects.bin record id, verified by the builder before use.
EFFECTS = [
    {
        "id": "vfx.tyre_smoke",
        "label": "Tyre smoke",
        "category": "vehicle",
        "triggers": [
            {"contract": "wheel-slip", "recovered": {
                "pack": "amax", "type": "WheelSurfaceParticleEvent", "record": 4178,
                "refId": 3965844132, "trigger": "SlideFactor", "modifier": "Dry",
                "surface": "Tarmac", "wheelEventRecord": 4178}},
            {"contract": "wheel-spin", "recovered": {
                "pack": "amax", "type": "WheelSurfaceParticleEvent", "record": 1847,
                "refId": 1758056810, "trigger": "WheelSpin", "modifier": "Dry",
                "surface": "Tarmac", "wheelEventRecord": 1847}},
        ],
        "events": [1046, 278],
        "missing": [],
    },
    {
        "id": "vfx.skid_marks",
        "label": "Skid marks (track ribbons)",
        "category": "vehicle",
        "triggers": [
            {"contract": "wheel-slip", "recovered": {
                "pack": "amax", "type": "WheelSurfaceTrackEvent", "record": 3325,
                "refId": 3167209725, "trigger": "SlideFactor", "modifier": "Dry",
                "surface": "Tarmac", "wheelEventRecord": 3325}},
            {"contract": "wheel-speed", "recovered": {
                "pack": "amax", "type": "WheelSurfaceTrackEvent", "record": 4300,
                "refId": 4077633698, "trigger": "Speed", "modifier": "Dry",
                "surface": "Sand", "wheelEventRecord": 4300}},
        ],
        "trackEvents": [3325, 4300, 2334, 2789],
        "events": [],
        "missing": [
            {"field": "ribbonWidth", "status": "not-serialized",
             "reason": "DynamicEffect::Track ribbon width is engine runtime state; "
                       "WheelSurfaceTrackEvent carries trigger, material, colour, alpha curve and rate only."},
            {"field": "segmentLength", "status": "not-serialized",
             "reason": "Track segment spacing/length is produced by the track mesh builder, not serialized."},
            {"field": "segmentLifetime", "status": "not-serialized",
             "reason": "Decal lifetime/fade is runtime (no lifetime field in WheelSurfaceTrackEvent)."},
            {"field": "uvScroll", "status": "runtime-only",
             "reason": "UV orientation/scroll is applied by DynamicEffect::Track at emission time."},
        ],
    },
    {
        "id": "vfx.boost_flame",
        "label": "Boost / nitro flame and sparks",
        "category": "vehicle",
        "triggers": [
            {"contract": "nitro-activated", "recovered": {
                "pack": "amax", "type": "MiscEffects", "record": 768, "refId": 712999905,
                "trigger": "ExhaustPop", "eventRecord": 912}},
            {"contract": "exhaust-pop", "recovered": {
                "pack": "amax", "type": "MiscEffects", "record": 768, "refId": 712999905,
                "trigger": "ExhaustPop", "eventRecord": 912}},
        ],
        "events": [912, 272],
        "extraEffects": [100],
        "missing": [],
        "runtimeInputs": ["exhaust emitter position and direction (per-vehicle, amax AmaxVehicleParticleEmitter)",
                          "nitro fake-speed force (docs/work/analysis/boost-feasibility.md)"],
    },
    {
        "id": "vfx.shield_bubble.normal",
        "label": "Shield bubble (normal)",
        "category": "powerup",
        "triggers": [{"contract": "shield-activated", "recovered": {
            "pack": "pickups", "type": "PickupSpecialFX", "record": 638,
            "refId": 3152510509, "slot": "ShieldDomeSpecialFX", "eventRecord": 7}}],
        "events": [7],
        "pickupFx": [{"pickup": "Shield", "level": "Normal", "slot": "ShieldDomeSpecialFX",
                      "record": 638, "refId": 3152510509}],
        "missing": [
            {"field": "bubbleScale", "status": "runtime-only",
             "reason": "The dome scale is computed from vehicle extents at spawn; not a serialized VFX field."},
            {"field": "bubbleMeshPlayback", "status": "not-decoded",
             "reason": "The mesh/cycle assets are listed, but the cycle importer is out of this task's scope."},
        ],
    },
    {
        "id": "vfx.shield_bubble.super",
        "label": "Shield bubble (SuperShield)",
        "category": "powerup",
        "triggers": [{"contract": "supershield-activated", "recovered": {
            "pack": "pickups", "type": "PickupSpecialFX", "record": 221,
            "refId": 1073336203, "slot": "ShieldDomeSpecialFX", "eventRecord": 275}}],
        "events": [275],
        "pickupFx": [{"pickup": "SuperShield", "level": "Normal", "slot": "ShieldDomeSpecialFX",
                      "record": 221, "refId": 1073336203},
                     {"pickup": "SuperShield", "level": "Normal", "slot": "PickedUpSpecialFX",
                      "record": None, "refId": 4159880818},
                     {"pickup": "SuperShield", "level": "Normal", "slot": "HitVehicleSpecialFX",
                      "record": 587, "refId": 2906748773}],
        "missing": [
            {"field": "bubbleScale", "status": "code",
             "reason": "g_SuperShieldScale = (1.0, 1.25, 0.47) x vehicle extents x "
                       "AmaxVehicle.ShieldSizeModifier (PickupSuperShield.cpp:88-90)."},
            {"field": "bubbleMeshPlayback", "status": "not-decoded",
             "reason": "ShieldSuper.cycle / ShieldSuperBumper.cycle playback is model/animation data, not decoded here."},
        ],
    },
    {
        "id": "vfx.mine_arm",
        "label": "Mine arm / idle",
        "category": "powerup",
        "triggers": [{"contract": "mine-placed", "recovered": {
            "pack": "pickups", "type": "PickupSpecialFX", "record": 744,
            "refId": 3678293281, "slot": "MineSpecialFX", "eventRecord": 692}}],
        "events": [692, 1086],
        "pickupFx": [{"pickup": "Bomb", "level": "Normal", "slot": "MineSpecialFX",
                      "record": 744, "refId": 3678293281},
                     {"pickup": "Bomb", "level": "Normal", "slot": "MasterMineEquipedSpecialFX",
                      "record": 222, "refId": 1074034012},
                     {"pickup": "Bomb", "level": "Mini", "slot": "MineSpecialFX",
                      "record": 685, "refId": 3411576424}],
        "missing": [
            {"field": "armTimerBinding", "status": "runtime-only",
             "reason": "The 0.3 s MasterMinePrimeTimer is a balance field applied by the pickup code; "
                       "the VFX record carries no timer."},
            {"field": "meshPlayback", "status": "not-decoded",
             "reason": "MineCore1/2 and MineBuild1 cycle playback is model/animation data."},
        ],
    },
    {
        "id": "vfx.mine_detonate",
        "label": "Mine detonation",
        "category": "powerup",
        "triggers": [{"contract": "mine-detonated", "recovered": {
            "pack": "pickups", "type": "PickupSpecialFX", "record": 480,
            "refId": 2413170920, "slot": "ExplodeSpecialFX", "eventRecord": 217}}],
        "events": [217, 904],
        "pickupFx": [{"pickup": "Bomb", "level": "Normal", "slot": "ExplodeSpecialFX",
                      "record": 480, "refId": 2413170920},
                     {"pickup": "Bomb", "level": "Mini", "slot": "ExplodeSpecialFX",
                      "record": 695, "refId": 3450789846}],
        "hitRadius": {"inner": 1.0, "outer": 3.5, "provenance": "data",
                      "source": "docs/work/analysis/powerups.md BombBalancingData (Normal)"},
        "missing": [
            {"field": "meshPlayback", "status": "not-decoded",
             "reason": "MineBallExpand / MasterMineBoomCircles cycle playback is model/animation data."},
            {"field": "damageFalloff", "status": "runtime-only",
             "reason": "The hit test uses Radius/OuterRadius; no falloff curve is serialized."},
        ],
    },
    {
        "id": "vfx.explosion_wreck",
        "label": "Explosion / wreck",
        "category": "vehicle",
        "triggers": [
            {"contract": "wrecked", "recovered": {
                "pack": "amax", "type": "MiscEffects", "record": 768, "refId": 712999905,
                "trigger": "EngineFire", "eventRecord": 284}},
            {"contract": "damage", "recovered": {
                "pack": "amax", "type": "MiscEffects", "record": 768, "refId": 712999905,
                "trigger": "ScrapeStatic", "eventRecord": 10}},
        ],
        "events": [241, 284, 410],
        "extraEffects": [755, 214],
        "missing": [
            {"field": "wreckEventBinding", "status": "runtime-only",
             "reason": "The wreck transition is evaluated by the damage/vehicle code; no serialized "
                       "'wreck' VFX handle exists in the recovered packs."},
            {"field": "debrisParts", "status": "runtime-only",
             "reason": "Detached car-part debris uses the vehicle part/damage system, not a particle record."},
        ],
    },
    {
        "id": "vfx.impact_sparks",
        "label": "Impact sparks and debris",
        "category": "vehicle",
        "triggers": [
            {"contract": "damage", "recovered": {
                "pack": "amax", "type": "AmaxImpactSurfaceEffect", "record": 3960,
                "refId": 3778991693, "trigger": "impact intensity 0.01..1.0", "eventRecord": 1024}},
            {"contract": "impact-sparks", "recovered": {
                "pack": "pickups", "type": "PickupSpecialFX", "record": 587,
                "refId": 2906748773, "slot": "HitVehicleSpecialFX", "eventRecord": 67}},
        ],
        "events": [67, 381, 824, 410, 225, 1112, 917],
        "impactTables": [639, 1684, 2915, 3788, 3960, 4156],
        "missing": [],
    },
    {
        "id": "vfx.repair_sparkle",
        "label": "Repair sparkle",
        "category": "powerup",
        "triggers": [{"contract": "repaired", "recovered": {
            "pack": "pickups", "type": "PickupSpecialFX", "record": 159,
            "refId": 774988991, "slot": "HitVehicleSpecialFX", "eventRecord": 387}}],
        "events": [387],
        "pickupFx": [{"pickup": "Repair", "level": "Normal", "slot": "HitVehicleSpecialFX",
                      "record": 159, "refId": 774988991},
                     {"pickup": "Repair", "level": "Normal", "slot": "HitVehicleSpecialFX",
                      "record": 119, "refId": 592209150}],
        "missing": [],
    },
    {
        "id": "vfx.shock_wave",
        "label": "Shock wave and dome",
        "category": "powerup",
        "triggers": [
            {"contract": "shock-activated", "recovered": {
                "pack": "pickups", "type": "PickupSpecialFX", "record": 98,
                "refId": 473608112, "slot": "DomeSpecialFX", "eventRecord": 824}},
            {"contract": "shock-hit", "recovered": {
                "pack": "pickups", "type": "PickupSpecialFX", "record": 125,
                "refId": 612542818, "slot": "HitVehicleSpecialFX", "eventRecord": 1108}},
        ],
        "events": [63, 410, 824, 1108, 974],
        "pickupFx": [{"pickup": "Shock", "level": "Normal", "slot": "DomeSpecialFX",
                      "record": 98, "refId": 473608112},
                     {"pickup": "Shock", "level": "Normal", "slot": "HitVehicleSpecialFX",
                      "record": 125, "refId": 612542818},
                     {"pickup": "Shock", "level": "Normal", "slot": "ChargingSpecialFX",
                      "record": 755, "refId": 3740262711}],
        "missing": [
            {"field": "domePlacement", "status": "runtime-only",
             "reason": "Dome positions come from the target's AI racing spline; not in these packs."},
            {"field": "domeRadius", "status": "runtime-only",
             "reason": "Actual radius = track segment width x sizeMultiplier x serialized radius; "
                       "width and 0.85..1.15 multiplier are runtime (powerup-projectiles.md 3.4)."},
            {"field": "domeLifetimeMod", "status": "runtime-only",
             "reason": "lifetimeMod = clamp(-distanceToTarget * 0.1, 0, 10) at spawn."},
        ],
    },
    {
        "id": "vfx.blindfire_muzzle",
        "label": "Blindfire / Bolt muzzle",
        "category": "powerup",
        "triggers": [{"contract": "projectile-fired", "recovered": {
            "pack": "pickups", "type": "PickupSpecialFX", "record": 819,
            "refId": 4115374381, "slot": "HitVehicleSpecialFX", "eventRecord": 453}}],
        "events": [453, 881],
        "pickupFx": [{"pickup": "Blindfire", "level": "Normal", "slot": "HitVehicleSpecialFX",
                      "record": 819, "refId": 4115374381},
                     {"pickup": "Blindfire", "level": "Normal", "slot": "ProjectileSpecialFX",
                      "record": 824, "refId": 4138445310}],
        "missing": [],
    },
    {
        "id": "vfx.shunt_trail",
        "label": "Shunt projectile trail",
        "category": "powerup",
        "triggers": [{"contract": "projectile-fired", "recovered": {
            "pack": "pickups", "type": "PickupSpecialFX", "record": 191,
            "refId": 929070292, "slot": "ProjectileSpecialFX", "eventRecord": 174}}],
        "events": [174, 172],
        "pickupFx": [{"pickup": "Shunt", "level": "Normal", "slot": "ProjectileSpecialFX",
                      "record": 191, "refId": 929070292},
                     {"pickup": "Shunt", "level": "Normal", "slot": "HitVehicleSpecialFX",
                      "record": 95, "refId": 450975683}],
        "missing": [
            {"field": "projectileParticleBinding", "status": "not-serialized",
             "reason": "The Shunt ProjectileSpecialFX tree carries the projectile mesh/light but no "
                       "serialized Particle_Event handle; the named ShuntProjectileParticles event is "
                       "listed from the dynamiceffects table and its binding is runtime."},
        ],
    },
    {
        "id": "vfx.barge_shockwave",
        "label": "Barge shockwave",
        "category": "powerup",
        "triggers": [{"contract": "barge-activated", "recovered": {
            "pack": "pickups", "type": "PickupSpecialFX", "record": 785,
            "refId": 3968767580, "slot": "HitVehicleSpecialFX", "eventRecord": 821}}],
        "events": [821, 654],
        "pickupFx": [{"pickup": "Barge", "level": "Normal", "slot": "HitVehicleSpecialFX",
                      "record": 785, "refId": 3968767580}],
        "missing": [],
    },
    {
        "id": "vfx.start_finish_gate",
        "label": "Start / finish gate FX",
        "category": "race",
        "triggers": [
            {"contract": "start-crossing", "recovered": {"pack": "dynamiceffects",
             "type": "AnimatedMeshSpecialFX", "record": 833, "refId": 3154200717,
             "trigger": "Aug_GO", "eventRecord": None}},
            {"contract": "checkpoint", "recovered": {"pack": "dynamiceffects",
             "type": "AnimatedMeshSpecialFX", "record": 1070, "refId": 4042219360,
             "trigger": "Start_Text_Checkpoint_EN", "eventRecord": None}},
            {"contract": "lap", "recovered": {"pack": "dynamiceffects",
             "type": "AnimatedMeshSpecialFX", "record": 38, "refId": 187756142,
             "trigger": "Start_Text_Finallap_EN", "eventRecord": None}},
            {"contract": "finish", "recovered": {"pack": "dynamiceffects",
             "type": "AnimatedMeshSpecialFX", "record": 190, "refId": 778344348,
             "trigger": "Start_Text_Finish_EN", "eventRecord": None}},
        ],
        "events": [],
        "gateMeshes": [38, 129, 132, 142, 156, 190, 274, 279, 283, 287, 320, 524, 544,
                       607, 608, 650, 652, 789, 826, 833, 842, 897, 940, 1063, 1070,
                       1074, 1126],
        "gateSpecialFx": [1100, 657],
        "missing": [
            {"field": "cyclePlayback", "status": "not-decoded",
             "reason": "The .cycle/.skeleton playback and model skinning are outside this data-only task."},
            {"field": "spotLightRecord", "status": "external-unloaded",
             "reason": "Start_Finish_Line components reference SpotLightSpecialFX refId 4045072479 "
                       "with record=null in dynamiceffects.bin; its payload is not in this pack."},
            {"field": "gatePlacement", "status": "runtime-only",
             "reason": "Start line / checkpoint placement is level actor data, not an effect field."},
        ],
    },
]

TEXTURE_REQUESTS = {
    "vfx.skid_marks": ["skid_mark", "skid_mark_sand_multiply", "skid_mark_sand"],
    "vfx.start_finish_gate": ["graphics/textures/specialfx/rolling start_GO",
                              "graphics/textures/specialfx/spotlight"],
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_hash(obj: dict) -> str:
    body = {k: v for k, v in obj.items() if k != "hashes"}
    return sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode())


def count_leaves(value) -> int:
    """Count numeric parameter leaves in a decoded subtree."""
    if isinstance(value, bool):
        return 1
    if isinstance(value, (int, float)):
        return 1
    if isinstance(value, dict):
        return sum(count_leaves(v) for k, v in value.items()
                   if k not in ("records", "record", "refId", "payloadOffset",
                                "payloadBytes", "stringsOffset", "stringsBytes"))
    if isinstance(value, list):
        return sum(count_leaves(v) for v in value)
    return 0


def strip(node, resolve_name):
    if isinstance(node, list):
        return [strip(x, resolve_name) for x in node]
    if not isinstance(node, dict):
        return node
    if "atom" in node:
        return node.get("value")
    if "label" in node:
        return {"label": node["label"], "labelIndex": node["labelIndex"]}
    if "bits" in node:
        return {"bits": node["bits"], "labels": node["labels"]}
    if "refId" in node:
        out = {"refId": node["refId"], "type": node.get("typeName"),
               "record": node.get("record")}
        if node.get("unloaded"):
            out["unloaded"] = True
        else:
            out["name"] = resolve_name(node)
        return out
    if "items" in node:
        return {"type": node.get("typeName"), "length": node["length"],
                "items": [strip(x, resolve_name) for x in node["items"]]}
    return {k: strip(v, resolve_name) for k, v in node.items() if not k.startswith("$")}


class Build:
    def __init__(self):
        self.gd_index = reference_pak_index(GAMEDATA)
        self.root_index = vfx_pak.pak_index(ROOTPAK)
        self.sources = {}
        self.dyn = None
        self.amax = None
        self.pickups = None
        self.dyn_by_id = {}
        self.amax_by_id = {}
        self.pickup_by_id = {}
        self.textures = {}
        self.checks = 0

    # ------------------------------------------------------------------ sources
    def load(self):
        for key, path in (("dynamiceffects", DYNAMIC), ("amax", AMAX),
                          ("pickups", PICKUPS)):
            entry = next((r for r in self.gd_index["entries"]
                          if r["path"].lower() == path.lower()), None)
            if entry is None:
                raise SystemExit(f"missing gamedata entry {path}")
            with GAMEDATA.open("rb") as stream:
                stream.seek(entry["offset"])
                stored = stream.read(entry["stored_bytes"])
            import zlib
            inflater = zlib.decompressobj()
            data = inflater.decompress(stored, entry["logical_bytes"] + 1)
            if (len(data) != entry["logical_bytes"] or not inflater.eof
                    or inflater.unused_data or inflater.unconsumed_tail):
                raise SystemExit(f"zlib extent mismatch {path}")
            flask = vfx_xt.Xt(data)
            setattr(self, {"dynamiceffects": "dyn"}.get(key, key), flask)
            self.sources[key] = {
                "pack": "gamedata.pak", "path": path, "fatIndex": entry["fat_index"],
                "offset": entry["offset"], "storedBytes": entry["stored_bytes"],
                "logicalBytes": entry["logical_bytes"],
                "pathCrc32": entry["path_crc32"],
                "sha256Stored": sha256(stored), "sha256Decoded": sha256(data),
                "flask": {"version": flask.version, "types": len(flask.types),
                          "fields": len(flask.fields), "refs": len(flask.refs),
                          "records": len(flask.records),
                          "components": len(flask.components),
                          "dataBytes": flask.tables["data"]["count"]},
            }
        self.dyn_by_id = {self.dyn.record_id(i): i for i in range(len(self.dyn.records))}
        self.amax_by_id = {self.amax.record_id(i): i for i in range(len(self.amax.records))}
        self.pickup_by_id = {self.pickups.record_id(i): i for i in range(len(self.pickups.records))}

    def ref_name(self, node):
        rid = node.get("refId")
        for flask, index in ((self.dyn, self.dyn_by_id), (self.amax, self.amax_by_id),
                             (self.pickups, self.pickup_by_id)):
            if rid in index:
                i = index[rid]
                try:
                    doc = flask.decode_record(i)
                except Exception:
                    return None
                nm = doc.get("name") if isinstance(doc, dict) else None
                if isinstance(nm, dict):
                    nm = nm.get("value")
                elif not isinstance(nm, str):
                    nm = None
                return nm
        return None

    # ----------------------------------------------------------------- records
    def record_meta(self, flask, index, pack):
        return {
            "pack": pack,
            "record": index,
            "refId": flask.record_id(index),
            "type": flask.type_name(flask.record_type(index)),
            "payloadOffset": flask.record_payload_offset(index),
            "payloadBytes": flask.records[index][2],
            "stringsOffset": flask.record_strings_offset(index),
            "stringsBytes": flask.records[index][3],
        }

    def event_params(self, index):
        ev = self.dyn.decode_record(index)
        emitters = []
        for item in ev["emitters"]["items"]:
            effect = item["effect"]
            emitters.append({
                "effect": strip(effect, self.ref_name),
                "spawn": strip(item["spawn"], self.ref_name),
                "animation": strip(item["animation"], self.ref_name),
                "particle": strip(item["particle"], self.ref_name),
                "misc": strip(item["misc"], self.ref_name),
            })
        return {
            **self.record_meta(self.dyn, index, "dynamiceffects"),
            "name": ev["name"]["value"],
            "duration": strip(ev["duration"], self.ref_name),
            "repeating": ev["repeating"],
            "emitterCount": ev["emitters"]["length"],
            "emitters": emitters,
        }

    def effect_params(self, index):
        doc = self.dyn.decode_record(index)
        return {
            **self.record_meta(self.dyn, index, "dynamiceffects"),
            "name": doc["name"]["value"],
            "render": strip(doc["render"], self.ref_name),
            "physics": strip(doc["physics"], self.ref_name),
            "uiLightTrail": doc["uiLightTrail"],
            "children": strip(doc["children"], self.ref_name),
        }

    def track_params(self, index):
        doc = self.amax.decode_record(index)
        material = strip(doc["material"], self.ref_name)
        if isinstance(doc["material"], dict) and doc["material"].get("record") is not None:
            mat_doc = self.amax.decode_record(doc["material"]["record"])
            material["value"] = strip(mat_doc, self.ref_name)
        return {
            **self.record_meta(self.amax, index, "amax"),
            "trigger": strip(doc["trigger"], self.ref_name),
            "colour": strip(doc["colour"], self.ref_name),
            "alpha": strip(doc["alpha"], self.ref_name),
            "alphaRate": doc["alphaRate"],
            "material": material,
        }

    def impact_params(self, index):
        doc = self.amax.decode_record(index)
        return {
            **self.record_meta(self.amax, index, "amax"),
            "minImpact": doc["minImpact"], "maxImpact": doc["maxImpact"],
            "minIntensity": doc["minIntensity"], "maxIntensity": doc["maxIntensity"],
            "particleEvent": strip(doc["particleEvent"], self.ref_name),
            "surfaceTypes": strip(doc["surfaceTypes"], self.ref_name),
        }

    def specialfx_component(self, node):
        if not isinstance(node, dict):
            return {"type": "Null", "provenance": "data"}
        if node.get("unloaded"):
            return {"type": node.get("typeName"), "refId": node.get("refId"),
                    "record": None, "unloaded": True, "provenance": "data"}
        typ = node.get("typeName")
        value = node.get("value")
        out = {"type": typ, "refId": node.get("refId"), "record": node.get("record"),
               "provenance": "data"}
        if not isinstance(value, dict):
            return out
        if typ == "ParticleSpecialFX":
            ev = value.get("ParticleEvent")
            stripped = strip(ev, self.ref_name)
            if isinstance(ev, dict) and ev.get("refId") in self.dyn_by_id:
                i = self.dyn_by_id[ev["refId"]]
                stripped["resolvedRecord"] = i
                stripped["resolvedType"] = self.dyn.type_name(self.dyn.record_type(i))
                stripped["resolvedName"] = (self.dyn.decode_record(i).get("name") or {}).get("value")
                stripped["resolvedIn"] = "dynamiceffects"
            out.update({"offset": value.get("Offset"),
                        "collisionHeightOffset": value.get("CollisionHeightOffset"),
                        "particleEvent": stripped})
        elif typ == "AnimatedMeshSpecialFX":
            out.update({"mesh": value.get("AnimatedMeshFileName", {}).get("value"),
                        "animation": value.get("AnimationFileName", {}).get("value"),
                        "skeleton": value.get("SkeletonFileName", {}).get("value"),
                        "farDistance": value.get("FarDistance"),
                        "excludeFromCubemap": value.get("ExcludeFromCubemap"),
                        "excludeFromReflection": value.get("ExcludeFromReflection"),
                        "excludeFromMirror": value.get("ExcludeFromMirror")})
        elif typ in ("LightSpecialFX", "SpotLightSpecialFX"):
            out.update({"colour": strip(value.get("Colour"), self.ref_name),
                        "radius": value.get("Radius"),
                        "cullDistance": value.get("CullDistance")})
            for key in ("FieldOfViewX", "FieldOfViewY", "Texture", "Offset"):
                if key in value:
                    out[key] = strip(value[key], self.ref_name)
            graph = value.get("EffectGraph")
            out["keyframes"] = graph.get("length") if isinstance(graph, dict) else 0
        elif typ == "FlareSpecialFX":
            out.update({"offset": strip(value.get("Offset"), self.ref_name),
                        "roll": value.get("Roll"), "pitch": value.get("Pitch"),
                        "time": value.get("Time"),
                        "intensityKeys": value.get("Intensity", {}).get("length"),
                        "flare": strip(value.get("Flare"), self.ref_name)})
        elif typ in ("Tracer_Effect", "PostSpecialFX", "SplashCameraSpecialFX"):
            out["name"] = value.get("name") or value.get("$type")
        else:
            out["fields"] = strip(value, self.ref_name)
        return out

    def specialfx_params(self, index):
        doc = self.pickups.decode_record(index)
        if doc.get("$type") != "SpecialFX":
            return {**self.record_meta(self.pickups, index, "pickups"),
                    "type": doc.get("$type"), "note": "not a SpecialFX root"}
        comps = []
        for item in doc["Components"]["items"]:
            comp = self.specialfx_component(item.get("Component"))
            comp["speedFactor"] = item.get("SpeedFactor")
            comp["startOffset"] = item.get("StartOffset")
            comps.append(comp)
        return {**self.record_meta(self.pickups, index, "pickups"),
                "components": comps, "componentCount": len(comps)}

    def mesh_params(self, index):
        doc = self.dyn.decode_record(index)
        return {
            **self.record_meta(self.dyn, index, "dynamiceffects"),
            "mesh": doc["AnimatedMeshFileName"]["value"],
            "animation": doc["AnimationFileName"]["value"],
            "skeleton": doc["SkeletonFileName"]["value"],
            "farDistance": doc["FarDistance"],
            "internalFxCount": doc["InternalSpecialFX"]["length"],
        }

    # ---------------------------------------------------------------- textures
    def texture_key(self, name):
        return name.replace("\\", "/").lower()

    def resolve_texture(self, name):
        key = self.texture_key(name)
        base = key if key.endswith(".texture") else key + ".texture"
        if "/" in base:
            candidates = [base]
        else:
            candidates = [f"graphics/textures/particles/{base}"]
        for row in self.root_index["entries"]:
            p = row["path"].replace("\\", "/").lower().lstrip("/")
            if p in candidates:
                return row
        return None

    def extract_texture(self, row):
        path = row["path"].replace("\\", "/").lower()
        if path in self.textures:
            return self.textures[path]
        packed = vfx_pak.read_entry_bytes(ROOTPAK, row)
        decoded = vfx_pak.decode_packet_zlib(packed, row["logical_bytes"])
        tex = vfx_pak.read_texture(decoded)
        stem = row["path"].replace("\\", "/").split("/")[-1].rsplit(".", 1)[0]
        target = TEXOUT / (stem + ".texture")
        TEXOUT.mkdir(parents=True, exist_ok=True)
        target.write_bytes(decoded)
        png = TEXOUT / (stem + ".png")
        vfx_pak.top_mip_png(tex, png)
        rgba = vfx_pak.top_mip_rgba(tex)
        meta = {
            "name": stem, "pak": "root.pak", "path": row["path"],
            "fatIndex": row["fat_index"], "offset": row["offset"],
            "storedBytes": row["stored_bytes"], "logicalBytes": row["logical_bytes"],
            "sha256Stored": sha256(packed), "sha256Decoded": sha256(decoded),
            "sha256TopMipRgba": sha256(rgba),
            "width": tex["width"], "height": tex["height"],
            "levels": tex["levels"], "format": tex["format"],
            "formatLabel": tex["formatLabel"], "usage": tex["usage"],
            "payloadBytes": tex["payloadBytes"], "topMipBytes": tex["topMipBytes"],
            "fullChainBytes": tex["fullChainBytes"], "completeChain": tex["completeChain"],
            "files": {"texture": f"textures/{stem}.texture", "png": f"textures/{stem}.png"},
            "provenance": "data",
        }
        (TEXOUT / (stem + ".json")).write_text(json.dumps(meta, indent=1, sort_keys=True) + "\n",
                                              encoding="utf-8")
        self.textures[path] = meta
        return meta

    # ------------------------------------------------------------------- build
    def build(self):
        self.load()
        effects = []
        all_texture_requests = set()
        for spec in EFFECTS:
            events = []
            effect_refs = {}
            for record in spec.get("events", []):
                if self.dyn.type_name(self.dyn.record_type(record)) != "Particle_Event":
                    raise SystemExit(f"{spec['id']}: record {record} is not a Particle_Event")
                ev = self.event_params(record)
                events.append(ev)
                for em in ev["emitters"]:
                    ref = em["effect"]
                    if ref and ref.get("record") is not None:
                        effect_refs[ref["record"]] = ref["refId"]
                    elif ref and ref.get("unloaded"):
                        raise SystemExit(f"{spec['id']}: unloaded effect {ref['refId']}")
            extra = []
            referenced = {em["effect"]["record"] for ev in events for em in ev["emitters"]
                          if em["effect"] and em["effect"].get("record") is not None}
            for record in spec.get("extraEffects", []):
                if self.dyn.type_name(self.dyn.record_type(record)) != "Particle_Effect":
                    raise SystemExit(f"{spec['id']}: extra record {record} is not a Particle_Effect")
                item = self.effect_params(record)
                item["binding"] = ("referenced" if record in referenced
                                   else "not-referenced-in-dynamiceffects")
                extra.append(item)
                effect_refs[record] = self.dyn.record_id(record)
            effects_by_record = [self.effect_params(i) for i in sorted(effect_refs)]
            tracks = [self.track_params(i) for i in spec.get("trackEvents", [])]
            impacts = [self.impact_params(i) for i in spec.get("impactTables", [])]
            pickup_fx = [self.specialfx_params(i["record"]) for i in spec.get("pickupFx", [])
                         if i.get("record") is not None]
            for i in spec.get("pickupFx", []):
                if i.get("record") is None:
                    pickup_fx.append({"pickup": i["pickup"], "level": i["level"],
                                      "slot": i["slot"], "refId": i["refId"],
                                      "record": None, "unloaded": True,
                                      "provenance": "data"})
            meshes = [self.mesh_params(i) for i in spec.get("gateMeshes", [])]
            gate_roots = [self.specialfx_params_gate(i) for i in spec.get("gateSpecialFx", [])]

            textures = []
            for ev in events:
                for e in effects_by_record:
                    if e["record"] in [em["effect"]["record"] for em in ev["emitters"]]:
                        for key in ("render",):
                            dtex = e[key].get("diffuseTexture")
                            if dtex:
                                textures.append(dtex)
            names = set(t for t in textures if t)
            for name in TEXTURE_REQUESTS.get(spec["id"], []):
                names.add(name)
            resolved = []
            for name in sorted(names):
                row = self.resolve_texture(name)
                if row is None:
                    resolved.append({"requested": name, "status": "missing-in-root.pak"})
                    continue
                meta = self.extract_texture(row)
                resolved.append({"requested": name, "status": "extracted",
                                 **{k: meta[k] for k in ("path", "formatLabel", "width",
                                                         "height", "levels",
                                                         "sha256Decoded",
                                                         "sha256TopMipRgba",
                                                         "files")}})
            all_texture_requests.update(n for n in names)

            status = "partial" if spec.get("missing") else "decoded"
            effect = {
                "id": spec["id"],
                "label": spec["label"],
                "category": spec["category"],
                "status": status,
                "triggers": [
                    {**t, "contractSource": TRIGGER_CONTRACTS.get(t["contract"], "unknown"),
                     "contractProvenance": "code" if t["contract"] in
                     ("nitro-activated", "supershield-activated", "shield-activated",
                      "mine-placed", "mine-detonated", "repaired", "shock-activated",
                      "shock-hit", "barge-activated", "barge-hit", "projectile-fired",
                      "projectile-hit", "damage", "wrecked", "start-crossing",
                      "checkpoint", "lap", "finish")
                     else "provisional"}
                    for t in spec["triggers"]
                ],
                "events": events,
                "effects": effects_by_record,
                "extraEffects": extra,
                "trackEvents": tracks,
                "impactTables": impacts,
                "pickupSpecialFx": pickup_fx,
                "gateMeshes": meshes,
                "gateRoots": gate_roots,
                "textures": resolved,
                "runtimeInputs": spec.get("runtimeInputs", []),
                "hitRadius": spec.get("hitRadius"),
                "decodedParameterCount": count_leaves(
                    [events, effects_by_record, extra, tracks, impacts, pickup_fx,
                     meshes, gate_roots]),
                "missing": spec.get("missing", []),
                "provenance": self.provenance_for(spec, events, effects_by_record,
                                                  tracks, impacts, pickup_fx, meshes),
            }
            effects.append(effect)

        # record inventory
        inventory = []
        for i in range(len(self.dyn.records)):
            doc = None
            name = None
            if self.dyn.type_name(self.dyn.record_type(i)) in ("Particle_Effect", "Particle_Event",
                                                               "Light_Object", "Light_Effect",
                                                               "Tracer_Effect"):
                try:
                    doc = self.dyn.decode_record(i)
                    nm = doc.get("name") if isinstance(doc, dict) else None
                    name = nm.get("value") if isinstance(nm, dict) else (nm if isinstance(nm, str) else None)
                except Exception:
                    name = None
            inventory.append({"record": i, "refId": self.dyn.record_id(i),
                              "type": self.dyn.type_name(self.dyn.record_type(i)),
                              "name": name,
                              "payloadOffset": self.dyn.record_payload_offset(i)})

        counts = {
            "types": len(self.dyn.types), "fields": len(self.dyn.fields),
            "refs": len(self.dyn.refs), "records": len(self.dyn.records),
            "particleEffects": sum(1 for x in inventory if x["type"] == "Particle_Effect"),
            "particleEvents": sum(1 for x in inventory if x["type"] == "Particle_Event"),
            "effects": len(effects),
            "decoded": sum(1 for e in effects if e["status"] == "decoded"),
            "partial": sum(1 for e in effects if e["status"] == "partial"),
            "unsupported": sum(1 for e in effects if e["status"] == "unsupported"),
            "texturesExtracted": len(self.textures),
        }

        manifest = {
            "schema": "blur-vfx/1",
            "generatedBy": "probes/vfx/tools/build_vfx.py",
            "decoder": {
                "path": "probes/vfx/tools/vfx_xt.py",
                "sha256": sha256((HERE / "vfx_xt.py").read_bytes()),
                "rules": [
                    "atoms use the serialized XtAtomType width (4 B unless the type size is 8)",
                    "struct (behaviour 3) is inline at the field offset, base structs first",
                    "pointer (behaviour 4) = {u16 component,u16 element} in the owning record",
                    "handle (behaviour 5) = u32 index into the sorted refs table",
                    "array = {u16 component,u16 element,u32 length} in the owning record",
                    "enum = label index; the retail integer is not serialized",
                    "record strings use the v2 XOR/previous-byte transform",
                ],
            },
            "sources": list(self.sources.values()),
            "enums": {
                "Particle_EmitterSpawn": self.dyn.type_labels(self._type("dynamiceffects", "Particle_EmitterSpawn")),
                "Particle_EmitterSpace": self.dyn.type_labels(self._type("dynamiceffects", "Particle_EmitterSpace")),
                "Particle_Shape": self.dyn.type_labels(self._type("dynamiceffects", "Particle_Shape")),
                "Particle_BlendMode": self.dyn.type_labels(self._type("dynamiceffects", "Particle_BlendMode")),
                "Particle_Sort": self.dyn.type_labels(self._type("dynamiceffects", "Particle_Sort")),
                "Particle_EmitterDistribution": self.dyn.type_labels(self._type("dynamiceffects", "Particle_EmitterDistribution")),
                "Particle_EmitterOrientation": self.dyn.type_labels(self._type("dynamiceffects", "Particle_EmitterOrientation")),
                "Particle_EmitterColourMode": self.dyn.type_labels(self._type("dynamiceffects", "Particle_EmitterColourMode")),
                "Particle_EmitterUV": self.dyn.type_labels(self._type("dynamiceffects", "Particle_EmitterUV")),
                "Effect_Atlas": self.dyn.type_labels(self._type("dynamiceffects", "Effect_Atlas")),
                "Effect_AtlasType": self.dyn.type_labels(self._type("dynamiceffects", "Effect_AtlasType")),
                "Particle_Child": self.dyn.type_labels(self._type("dynamiceffects", "Particle_Child")),
                "Particle_PhysicsBehaviour": self.dyn.type_labels(self._type("dynamiceffects", "Particle_PhysicsBehaviour")),
                "Particle_Collision": self.dyn.type_labels(self._type("dynamiceffects", "Particle_Collision")),
                "EffectMaterial": self.amax.type_labels(self._type("amax", "EffectMaterial")),
                "WheelSurfaceParticleEventTrigger": self.amax.type_labels(self._type("amax", "WheelSurfaceParticleEventTrigger")),
                "SurfaceModifier": self.amax.type_labels(self._type("amax", "SurfaceModifier")),
                "WheelSurfaceTrackMaterialBlendMode": self.amax.type_labels(self._type("amax", "WheelSurfaceTrackMaterialBlendMode")),
                "MiscParticleEventType": self.amax.type_labels(self._type("amax", "MiscParticleEventType")),
            },
            "counts": counts,
            "recordInventory": inventory,
            "effects": effects,
            "textures": sorted(self.textures.values(), key=lambda x: x["path"]),
            "implementation": IMPLEMENTATION,
            "limits": [
                "Effect definitions only: this manifest does not spawn, simulate or render a particle.",
                "Runtime-only inputs (wheel contact transforms, dome placement, vehicle attachment points) "
                "are typed per effect; no value is invented for them.",
                "External/unloaded handles are reported, never replaced by a guessed record.",
                "No retail visual-parity claim; no browser capture was made.",
            ],
        }
        manifest["hashes"] = {
            "manifestContent": canonical_hash(manifest),
            "sources": {k: v["sha256Decoded"] for k, v in self.sources.items()},
            "textures": {v["name"]: v["sha256Decoded"] for v in self.textures.values()},
        }
        OUT.mkdir(parents=True, exist_ok=True)
        text = json.dumps(manifest, indent=1, sort_keys=True) + "\n"
        (OUT / "effects.json").write_text(text, encoding="utf-8")
        print(f"wrote {OUT / 'effects.json'} ({len(text)} bytes)")
        print("counts", json.dumps(counts, sort_keys=True))
        print("effects", ", ".join(f"{e['id']}({e['status']})" for e in effects))
        print("textures", len(self.textures))
        print("manifestContent", manifest["hashes"]["manifestContent"])
        return manifest

    def _type(self, pack, name):
        flask = self.dyn if pack == "dynamiceffects" else self.amax
        for i in range(len(flask.types)):
            if flask.type_name(i) == name:
                return i
        raise SystemExit(f"missing type {pack}.{name}")

    def specialfx_params_gate(self, index):
        doc = self.dyn.decode_record(index)
        comps = []
        for item in doc["Components"]["items"]:
            node = item.get("Component")
            if not isinstance(node, dict):
                comps.append({"type": "Null"})
                continue
            if node.get("unloaded"):
                comps.append({"type": node.get("typeName"), "refId": node.get("refId"),
                              "record": None, "unloaded": True})
                continue
            comps.append(self.specialfx_component(node))
        return {**self.record_meta(self.dyn, index, "dynamiceffects"),
                "components": comps, "componentCount": len(comps)}

    def provenance_for(self, spec, events, effects, tracks, impacts, pickup_fx, meshes):
        rows = []
        for ev in events:
            rows.append({"field": f"events[{ev['record']}].emitters", "tag": "data",
                         "source": f"{ev['type']} refId {ev['refId']} payload @ {ev['payloadOffset']}"})
        for e in effects:
            rows.append({"field": f"effects[{e['record']}].render", "tag": "data",
                         "source": f"Particle_Effect refId {e['refId']} @ {e['payloadOffset']}"})
            rows.append({"field": f"effects[{e['record']}].physics", "tag": "data",
                         "source": f"Particle_Effect refId {e['refId']} @ {e['payloadOffset']}"})
        for t in tracks:
            rows.append({"field": f"trackEvents[{t['record']}]", "tag": "data",
                         "source": f"WheelSurfaceTrackEvent refId {t['refId']} @ {t['payloadOffset']}"})
        for i in impacts:
            rows.append({"field": f"impactTables[{i['record']}]", "tag": "data",
                         "source": f"AmaxImpactSurfaceEffect refId {i['refId']} @ {i['payloadOffset']}"})
        for p in pickup_fx:
            if p.get("record") is not None:
                rows.append({"field": f"pickupSpecialFx[{p['record']}]", "tag": "data",
                             "source": f"pickups.bin SpecialFX refId {p['refId']} @ {p['payloadOffset']}"})
        for m in meshes:
            rows.append({"field": f"gateMeshes[{m['record']}]", "tag": "data",
                         "source": f"AnimatedMeshSpecialFX refId {m['refId']} @ {m['payloadOffset']}"})
        for t in spec["triggers"]:
            rows.append({"field": f"trigger.{t['contract']}", "tag": "code" if t["contract"] in
                         ("nitro-activated", "supershield-activated", "shield-activated",
                          "mine-placed", "mine-detonated", "repaired", "shock-activated",
                          "shock-hit", "barge-activated", "barge-hit", "projectile-fired",
                          "projectile-hit", "damage", "wrecked", "start-crossing",
                          "checkpoint", "lap", "finish") else "provisional",
                         "source": TRIGGER_CONTRACTS.get(t["contract"], "unknown")})
        for field in spec.get("missing", []):
            tag = "code" if field["status"] in ("runtime-only", "code") else "provisional"
            rows.append({"field": f"missing.{field['field']}", "tag": tag,
                         "source": field["reason"]})
        return rows


IMPLEMENTATION = {
    "recommendation": "hybrid-cpu-sim-gpu-instanced-billboards",
    "summary": (
        "Simulate the particle pool on the CPU (spawn/age/velocity, fixed 60 Hz) and draw each "
        "blend/shape group with one GPU-instanced quad batch. Keep skid marks out of the particle "
        "pool as a CPU-built ribbon mesh with a dynamic vertex buffer. This is the cheapest faithful "
        "path for the current WebGPU consumer (one pipeline per blend mode, no compute, no GPGPU)."
    ),
    "whyNotFullGpu": (
        "The recovered effects are small (median emitter counts in the single digits), spawn from "
        "runtime transforms (wheels, bone attachments, spline domes) and need per-particle collision "
        "and child-emitter logic. A GPU-only simulation would need those transforms and collision "
        "inputs on the GPU every frame, which is more work than the pool costs at this scale."
    ),
    "whyNotCpuQuads": (
        "A CPU-only implementation re-uploads four vertices per particle per frame and needs one "
        "draw call per texture page. Instanced quads keep per-frame upload to one instance record "
        "and one draw per blend group."
    ),
    "atlas": {
        "layout": "3 pages, 512x512, original pages copied at native size (no repack scaling)",
        "pages": [
            {"name": "alpha-smoke", "contents": ["smokeVolume", "smoke", "smoke_new_01"],
             "blend": "Alpha", "depthWrite": False, "sort": "back-to-front"},
            {"name": "additive-sparks", "contents": ["flare", "flare2", "spark_pop_01",
                                                     "lightflare", "glow", "flares_*"],
             "blend": "Additive", "depthWrite": False, "sort": "none"},
            {"name": "opaque-debris", "contents": ["damage_parts_02", "glassshards01",
                                                   "gravel", "stone", "plate", "skid_mark*"],
             "blend": "AlphaTest/Multiply", "depthWrite": True, "sort": "none"},
        ],
        "note": ("The original effect records carry atlas=Default1x1/atlasType=Random for the "
                 "selected effects; the game's own atlas pages are not used by these records. "
                 "Repacking is a project choice, not a recovered value."),
    },
    "state": {
        "depth": "test on, write off for alpha/additive; test+write for debris and decals",
        "cull": "back-face cull off (billboards), two-sided decals",
        "blend": "Alpha (srcAlpha, 1-srcAlpha), Additive (srcAlpha, 1), AlphaTest for debris",
        "sorting": "sort alpha groups per particle; additive and debris unsorted",
        "sampling": "linear, clamp; no mip chain needed beyond 128x128 at current camera distance",
    },
    "costAt8Cars": {
        "assumption": "8 cars, all effects active simultaneously, 60 Hz, desktop Chromium",
        "liveParticles": "~1,500-2,500 quads (smoke 8x2x~20, sparks bursts 8x~80, shields 8x~24)",
        "drawCalls": "3-5 (one per blend/shape group) + 1 skid ribbon draw per material group",
        "perFrameUpload": "~2,500 x 32 B instance data = 80 KB/frame = 4.8 MB/s",
        "cpu": "~0.1-0.25 ms/frame particle update on a desktop CPU (provisional estimate)",
        "gpu": "<0.5 ms/frame at 1080p for 2,500 small transparent quads (provisional estimate)",
        "vram": "~1.5 MB for the three 512x512 RGBA atlas pages + mips",
        "verdict": "fits the current WebGPU consumer without a compute pass or a second renderer",
        "provenance": "provisional",
    },
    "overdraw": (
        "Smoke and additive flares are the overdraw risk. Cap the smoke pool per car (e.g. 24 live "
        "quads per rear wheel) and fade sub-pixel quads; the recovered size curves already shrink "
        "particles at end of life."
    ),
}


def main():
    build = Build()
    manifest = build.build()
    print("verifier seed checks", build.checks)
    return manifest


if __name__ == "__main__":
    main()
