"""Build the final runtime pickup placement set for a raced Blur level (PWR6).

This is a placement artifact, not a renderer or game claim. For every raced
route of the level it re-decodes the retail `PickupPosition` actors from
`actorpack.xt` (with absolute byte offsets), decodes the route / race authority,
and measures each slot against:

  * the committed measured e1-drive layout (distance, arc, signed lateral
    offset, path tangent yaw, height above the measured sample ground);
  * the committed collision mesh (ground below, first surface above, nearest
    steep triangle) and the committed draw buffers (nearest visible steep
    triangle, visible surface above);
  * the retail `RowType` + `RowId` shuffle group.

The runtime block selects the primary route by the documented PWR5 rule and
publishes the ordered slot list, the default spawn set, the measured-course
subset, typed exclusions/flags and the host integration contract. No position,
yaw, type, group, respawn value or route binding is invented.

Usage:
    python probes/powerups/tools/build_pickup_runtime.py --level usa_amboy
    python probes/powerups/tools/build_pickup_runtime.py --level spa_barcelona_gracia
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import Counter, OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "powerups" / "tools"))

import xt_decode  # noqa: E402
from inspect_asset_layout import pak_index  # noqa: E402
from extract_pickup_placement_levels import (  # noqa: E402  (same probe, no edits)
    all_actor_lists,
    canonical_row_type,
    decode_actor,
    decode_pak_entry,
    decode_pickup_types,
    decode_rows,
    extract_routes,
    normalize_name,
    pickup_components,
    sha256_bytes,
    sha256_file,
    source_record,
)
import pickup_runtime_common as geo  # noqa: E402

PACK = ROOT / "game-data/Blur/cache/gamedata.pak"
OUT_DIR = ROOT / "_work/powerups"
POWERUP_MANIFEST = OUT_DIR / "powerups.json"

LAYOUT_KEYS = {"usa_amboy": "amboy", "spa_barcelona_gracia": "gracia"}
# PickupType ref ids recovered by PWR1 (docs/work/analysis/powerups.md §3).
MP_TYPES = OrderedDict([
    (2377082647, "Nitrous"),
    (973327125, "Shock"),
    (736887763, "Shunt"),
    (1291339931, "Blindfire"),
    (1621319152, "Barge"),
    (733160612, "Bomb"),
    (162617178, "Repair"),
    (1866809209, "Shield"),
])
SUPERSHIELD_REF = 3093073274
NON_MP_REFS = {
    3748041782: "Fan",
    3476635578: "Stopwatch",
    3093073274: "SuperShield",
}
# MultiplayerRace.powerups is the serialized MpPickup flag field; its label
# order is read from the file at build time, not hard-coded.
MP_MASK_NAMES = {
    "nitro": "Nitrous",
    "shock": "Shock",
    "barge": "Barge",
    "mine": "Bomb",
    "shunt": "Shunt",
    "bolt": "Blindfire",
    "shield": "Shield",
    "repair": "Repair",
}
PICKUP_RADIUS = 2.0
NEAR_BAND_METRES = 6.0
STATIC_BOX_HALF_WIDTH = 1.25
WALL_INSIDE_METRES = 0.05
WALL_LOW_METRES = 0.30
COVER_INSIDE_METRES = 0.05
COVER_LOW_METRES = 0.50
VISIBLE_OVERLAP_METRES = 0.05
ELEVATED_GROUND_METRES = 2.0


def sha256_file_if_exists(path: Path):
    return sha256_file(path) if path.exists() else None


def finite(value):
    return value is not None and math.isfinite(value)


# ------------------------------------------------------------------- decoding
def route_races(route: dict) -> list[dict]:
    return [race for race in route["races"] if race.get("raceType") == "racing"]


def modal(items):
    """Most frequent item; deterministic tie-break by first occurrence."""
    if not items:
        return None
    counts = Counter(items)
    best = max(counts.values())
    for item in items:
        if counts[item] == best:
            return item
    return items[0]


def label_of(value):
    return value.get("label") if isinstance(value, dict) else value


def bits_of(value):
    return value.get("bits") if isinstance(value, dict) else value


def mask_types(bits: int, labels: list[str]) -> list[str]:
    return sorted(MP_MASK_NAMES[name] for index, name in enumerate(labels)
                  if bits & (1 << index))


def decode_mask_labels(multiplayer):
    race_type = next(i for i in range(len(multiplayer.types))
                     if multiplayer.type_name(i) == "MultiplayerRace")
    field = next(f for f in multiplayer.type_fields(race_type) if f["name"] == "powerups")
    return multiplayer.type_labels(field["typeIndex"])


def decode_respawn_labels(multiplayer):
    race_type = next(i for i in range(len(multiplayer.types))
                     if multiplayer.type_name(i) == "MultiplayerRace")
    field = next(f for f in multiplayer.type_fields(race_type)
                 if f["name"] == "poweruprespawn")
    return multiplayer.type_labels(field["typeIndex"])


def decode_powerup_constants():
    """Read the PWR1 constants instead of re-typing them."""
    if not POWERUP_MANIFEST.exists():
        return {"status": "not-found", "path": "_work/powerups/powerups.json"}
    doc = json.loads(POWERUP_MANIFEST.read_text(encoding="utf-8"))
    parameters = doc.get("pickupSystem", {}).get("parameters", {})
    config = doc.get("modes", {}).get("config", {})
    return {
        "status": "found",
        "path": "_work/powerups/powerups.json",
        "sha256": sha256_file(POWERUP_MANIFEST),
        "manifestContentSha256": doc.get("hashes", {}).get("manifestContent"),
        "pickupRadiusMetres": parameters.get("PickupRadius"),
        "deactivateSeconds": parameters.get("PickupDeactivateTimer"),
        "longSeconds": config.get("powerupRespawnToggleLong"),
        "veryLongSeconds": config.get("powerupRespawnToggleVeryLong"),
    }


def placement_provenance(actorpack: xt_decode.Flask, record_index: int, component: int,
                         element: int, actorpack_source: dict) -> dict:
    entry = actorpack.records[record_index]
    type_index, _count, behaviour = actorpack.components[
        actorpack._component_start[record_index] + component]
    if behaviour != 0:
        raise ValueError("PickupPosition elements must be struct components")
    stride = actorpack.types[type_index][5]
    component_offset = actorpack._component_offset(record_index, component)
    record_data_offset = actorpack._data_base + actorpack._data_start[record_index]
    element_offset = record_data_offset + component_offset + element * stride
    fields = {}
    for field in actorpack.all_fields(type_index):
        fields[field["name"]] = element_offset + field["offset"]
    matrix_base = fields["WorldMatrix"]
    matrix_offsets = {}
    for axis, offset in (("ax", 0), ("ay", 12), ("az", 24), ("aw", 36)):
        matrix_offsets[axis] = {
            "base": matrix_base + offset,
            "vx": matrix_base + offset + 0,
            "vy": matrix_base + offset + 4,
            "vz": matrix_base + offset + 8,
        }
    return {
        "pakPath": actorpack_source["path"],
        "decodedSha256": actorpack_source["sha256"],
        "recordIndex": record_index,
        "recordId": actorpack.record_id(record_index),
        "recordTableOffset": actorpack.tables["records"]["offset"] + record_index * 16,
        "recordDataOffset": record_data_offset,
        "recordDataBytes": entry[2],
        "recordStringBytes": entry[3],
        "componentRelative": component,
        "componentCount": entry[1],
        "componentOffset": component_offset,
        "elementStrideBytes": stride,
        "elementOffset": element_offset,
        "elementBytes": stride,
        "fieldOffsets": fields,
        "matrixOffsets": matrix_offsets,
    }


def surface_metrics(collision_grid, draw_grid, position):
    x, y, z = position
    highest, below, above = collision_grid.vertical(x, z, y)
    draw_highest, draw_below, draw_above = draw_grid.vertical(x, z, y)
    wall = collision_grid.nearest_wall((x, y, z))
    visible_wall = draw_grid.nearest_wall((x, y, z))
    ground_present = below is not None
    surface_present = highest is not None
    cover = None
    if above is not None:
        cover = above[0] - y
    draw_cover = None
    if draw_above is not None:
        draw_cover = draw_above[0] - y
    return {
        "groundBelowY": None if below is None else below[0],
        "groundBelowNormalY": None if below is None else below[1],
        "heightAboveGround": None if below is None else y - below[0],
        "groundBelowPresent": ground_present,
        "highestUpFacingY": None if highest is None else highest[0],
        "highestUpFacingNormalY": None if highest is None else highest[1],
        "heightAboveHighestUpFacing": None if highest is None else y - highest[0],
        "surfacePresent": surface_present,
        "firstSurfaceAboveY": None if above is None else above[0],
        "coverAboveMetres": cover,
        "nearestSteepCollisionDistance3d": wall,
        "nearestSteepDrawDistance3d": visible_wall,
        "drawHighestUpFacingY": None if draw_highest is None else draw_highest[0],
        "firstDrawSurfaceAboveY": None if draw_above is None else draw_above[0],
        "drawCoverAboveMetres": draw_cover,
        "drivableSurface": (below is not None and below[1] > geo.DRIVABLE_NORMAL_Y),
    }


def classify(surface: dict, projection: dict) -> dict:
    reasons = []
    hard = []
    if not surface["groundBelowPresent"]:
        hard.append("no-collision-ground-below")
    if (surface["nearestSteepCollisionDistance3d"] is not None
            and surface["nearestSteepCollisionDistance3d"] < WALL_INSIDE_METRES):
        hard.append("inside-collision-structure")
    if surface["coverAboveMetres"] is not None and surface["coverAboveMetres"] < COVER_INSIDE_METRES:
        hard.append("inside-collision-structure")
    if surface["groundBelowPresent"] and not surface["drivableSurface"]:
        reasons.append("non-drivable-surface")
    if (surface["heightAboveGround"] is not None
            and surface["heightAboveGround"] > ELEVATED_GROUND_METRES):
        reasons.append("elevated-above-detected-ground")
    if (surface["nearestSteepCollisionDistance3d"] is not None
            and WALL_INSIDE_METRES <= surface["nearestSteepCollisionDistance3d"] < WALL_LOW_METRES):
        reasons.append("collision-clearance-low")
    if (surface["coverAboveMetres"] is not None
            and COVER_INSIDE_METRES <= surface["coverAboveMetres"] < COVER_LOW_METRES):
        reasons.append("collision-cover-low")
    if (surface["nearestSteepDrawDistance3d"] is not None
            and surface["nearestSteepDrawDistance3d"] < VISIBLE_OVERLAP_METRES):
        reasons.append("visible-structure-overlap")
    if (surface["drawCoverAboveMetres"] is not None
            and surface["drawCoverAboveMetres"] < VISIBLE_OVERLAP_METRES):
        reasons.append("inside-visible-structure")
    distance = projection["distance"]
    if distance <= PICKUP_RADIUS:
        path_class = "on-path"
    elif distance <= NEAR_BAND_METRES:
        path_class = "near-path"
    else:
        path_class = "off-path"
        reasons.append("off-measured-path")
    if hard:
        status = "exclude"
    elif reasons:
        status = "flag"
    else:
        status = "spawn"
    return {
        "pathClass": path_class,
        "status": status,
        "hardExclusions": hard,
        "flags": reasons,
        # Commissioning semantics: spawn = active + grounded + clear of
        # collision structure. Flags keep the slot spawnable but visible.
        "spawnable": status != "exclude",
        "onMeasuredCourse": status != "exclude" and path_class in ("on-path", "near-path"),
        "collectableAtCentreline": status != "exclude" and distance <= STATIC_BOX_HALF_WIDTH,
        "collectableWithOffset": status != "exclude" and distance <= NEAR_BAND_METRES,
    }


def build_slot(actorpack, layout, layout_samples, record_index, component, element,
               types, rows, collision_grid, draw_grid, actorpack_source):
    actor = decode_actor(actorpack, record_index, component, element)
    matrix = actor["WorldMatrix"]
    position = [matrix["aw"]["vx"], matrix["aw"]["vy"], matrix["aw"]["vz"]]
    az = [matrix["az"]["vx"], matrix["az"]["vy"], matrix["az"]["vz"]]
    yaw = geo.normalize_angle(geo.yaw_from_forward(az))
    type_handle = actor.get("PickupType")
    type_ref = type_handle.get("refId") if isinstance(type_handle, dict) else None
    row_handle = actor.get("RowType")
    row_ref = row_handle.get("refId") if isinstance(row_handle, dict) else None
    row_info = rows.get(str(row_ref)) if row_ref is not None else None
    excluded = [item["refId"] for item in actor["ExcludedPickupTypes"].get("items", [])
                if isinstance(item, dict) and item.get("refId") is not None]
    projection = geo.project_polyline(layout, position[0], position[2])
    sample = min(layout_samples, key=lambda item: (abs(item["arc"] - projection["arc"]),
                                                   item["index"]))
    surface = surface_metrics(collision_grid, draw_grid, position)
    reach = classify(surface, projection)
    type_name = types.get(str(type_ref))
    if actor["PickupActiveLevel"] != 1:
        reach["hardExclusions"].append("pickup-active-level-0")
        reach["status"] = "exclude"
        reach["spawnable"] = False
        reach["onMeasuredCourse"] = False
        reach["collectableAtCentreline"] = False
        reach["collectableWithOffset"] = False
    return {
        "index": 0,  # assigned by the caller after sorting
        "uid": actor["SerialisableUid"],
        "name": actor["Name"]["value"] if isinstance(actor.get("Name"), dict) else actor.get("Name"),
        "actorListId": actorpack.record_id(record_index),
        "actorListRecord": record_index,
        "component": component,
        "element": element,
        "provenance": placement_provenance(actorpack, record_index, component, element,
                                           actorpack_source),
        "position": {"x": position[0], "y": position[1], "z": position[2]},
        "basis": {
            "ax": [matrix["ax"]["vx"], matrix["ax"]["vy"], matrix["ax"]["vz"]],
            "ay": [matrix["ay"]["vx"], matrix["ay"]["vy"], matrix["ay"]["vz"]],
            "az": az,
        },
        "yaw": {
            "radians": yaw,
            "degrees": math.degrees(yaw),
            "source": "WorldMatrix.az (retail actor basis; forward = (sin yaw, cos yaw))",
            "measuredTangentRadians": projection["tangentYawRadians"],
            "measuredTangentDegrees": math.degrees(projection["tangentYawRadians"]),
        },
        "serializedType": {
            "refId": type_ref,
            "name": type_name,
            "mpType": MP_TYPES.get(type_ref),
            "isMultiplayerType": type_ref in MP_TYPES,
        },
        "row": None if row_ref is None else {
            "refId": row_ref,
            "id": actor["RowId"],
            "rowIdRaw": actor["RowId"],
            "shuffleGroup": f"{row_ref}:{actor['RowId']}",
            "allowedTypes": row_info["types"] if row_info else None,
            "canonicalAllowedTypes": (None if not row_info else
                                      [canonical_row_type(name) for name in row_info["types"]]),
            "bits": row_info["bits"] if row_info else None,
            "runtimeTypeRule": "row-assignment-without-replacement",
        },
        "rowIdRaw": actor["RowId"],
        "overrides": {
            "pickupActiveLevel": actor["PickupActiveLevel"],
            "rotateGraphic": actor["RotateGraphic"],
            "activationTimer": actor["ActivationTimer"],
            "activationLap": actor["ActivationLap"],
            "respawnTimerOverride": actor["RespawnTimerOverride"],
            "constantShuffle": actor["ConstantShuffle"],
            "shuffleTypes": actor["ShuffleTypes"],
            "excludedPickupTypes": excluded,
        },
        "measuredPath": {
            "distance": projection["distance"],
            "arc": projection["arc"],
            "signedCross2d": projection["signedCross2d"],
            "signedCrossRule": ("tx*(z-qz) - tz*(x-qx); the sign is the 2D cross of the "
                                "travel tangent and the point offset, not a left/right "
                                "handedness claim"),
            "nearestPoint": projection["point"],
            "segment": projection["segment"],
            "nearestSampleIndex": sample["index"],
            "nearestSampleArc": sample["arc"],
            "nearestSampleGroundY": sample["groundY"],
            "heightAbovePathSurface": (position[1] - sample["groundY"]
                                       if sample.get("groundY") is not None else None),
            "tangent": projection["tangent"],
        },
        "surface": surface,
        "reachability": reach,
        "respawn": {
            "overrideSeconds": actor["RespawnTimerOverride"],
            "overrideUsed": actor["RespawnTimerOverride"] != 0.0,
            "deactivateSeconds": None,  # filled from the PWR1 constants
            "modeSeconds": None,        # filled from the race mode
            "modeStatus": "not-serialized",
        },
    }


def summarise(slots, measured_len):
    distances = [slot["measuredPath"]["distance"] for slot in slots]
    arcs = [slot["measuredPath"]["arc"] for slot in slots]
    mount = min(slots, key=lambda slot: slot["measuredPath"]["distance"])
    duplicates = Counter((round(slot["position"]["x"], 3), round(slot["position"]["z"], 3))
                         for slot in slots)
    duplicate_xz = [
        {"xz": list(key), "count": count,
         "uids": [slot["uid"] for slot in slots
                  if round(slot["position"]["x"], 3) == key[0]
                  and round(slot["position"]["z"], 3) == key[1]]}
        for key, count in duplicates.items() if count > 1
    ]
    uid_counts = Counter(slot["uid"] for slot in slots)
    nearest_neighbours = []
    for slot in slots:
        best = None
        for other in slots:
            if other is slot:
                continue
            distance = math.hypot(slot["position"]["x"] - other["position"]["x"],
                                  slot["position"]["z"] - other["position"]["z"])
            if best is None or distance < best[0]:
                best = (distance, other["uid"])
        nearest_neighbours.append({"uid": slot["uid"], "distance": best[0],
                                   "otherUid": best[1]})
    heights = [slot["surface"]["heightAboveGround"] for slot in slots
               if slot["surface"]["heightAboveGround"] is not None]
    path_counts = Counter(slot["reachability"]["pathClass"] for slot in slots)
    status_counts = Counter(slot["reachability"]["status"] for slot in slots)
    return {
        "placements": len(slots),
        "spawnable": sum(1 for slot in slots if slot["reachability"]["spawnable"]),
        "excluded": sum(1 for slot in slots if slot["reachability"]["status"] == "exclude"),
        "flagged": sum(1 for slot in slots if slot["reachability"]["status"] == "flag"),
        "pathClasses": dict(path_counts),
        "statusCounts": dict(status_counts),
        "onPathCoverage": {
            "measuredLength": measured_len,
            "pickupRadiusProximityThreshold": PICKUP_RADIUS,
            "nearBandMetres": NEAR_BAND_METRES,
            "staticBoxHalfWidthMetres": STATIC_BOX_HALF_WIDTH,
            "minDistance": min(distances),
            "minDistanceUid": mount["uid"],
            "minDistanceArc": mount["measuredPath"]["arc"],
            "medianDistance": sorted(distances)[len(distances) // 2],
            "within2m": sum(1 for value in distances if value <= 2.0),
            "within5m": sum(1 for value in distances if value <= 5.0),
            "within6m": sum(1 for value in distances if value <= 6.0),
            "within10m": sum(1 for value in distances if value <= 10.0),
            "within25m": sum(1 for value in distances if value <= 25.0),
            "arcMin": min(arcs),
            "arcMax": max(arcs),
            "collectableAtCentreline": [slot["uid"] for slot in slots
                                        if slot["reachability"]["collectableAtCentreline"]],
            "collectableWithOffset": [slot["uid"] for slot in slots
                                      if slot["reachability"]["collectableWithOffset"]],
            "onMeasuredCourse": [slot["uid"] for slot in slots
                                 if slot["reachability"]["onMeasuredCourse"]],
        },
        "typeCounts": dict(Counter(slot["serializedType"]["name"] for slot in slots)),
        "mpTypeCounts": dict(Counter(slot["serializedType"]["mpType"] for slot in slots)),
        "duplicates": {
            "duplicateUids": [uid for uid, count in uid_counts.items() if count > 1],
            "exactXZ1mm": duplicate_xz,
            "minNearestNeighbour": min((item["distance"] for item in nearest_neighbours),
                                       default=None),
            "nearestNeighbour": nearest_neighbours,
        },
        "heightAboveGroundRange": [min(heights), max(heights)] if heights else None,
        "yawRangeDegrees": [min(slot["yaw"]["degrees"] for slot in slots),
                            max(slot["yaw"]["degrees"] for slot in slots)],
    }


def build_groups(slots):
    group_map = OrderedDict()
    for slot in slots:
        row = slot["row"]
        key = row["shuffleGroup"] if row else f"fixed:{slot['uid']}"
        group_map.setdefault(key, []).append(slot)
    groups = []
    for key, members in group_map.items():
        row = members[0]["row"]
        serialized = [member["serializedType"]["name"] for member in members]
        canonical = [canonical_row_type(name) for name in serialized]
        allowed = row["canonicalAllowedTypes"] if row else None
        complete = None
        if allowed is not None:
            complete = sorted(canonical) == sorted(allowed)
        groups.append({
            "groupId": key,
            "kind": "row-shuffle" if row else "fixed-singleton",
            "rowRefId": row["refId"] if row else None,
            "rowId": row["id"] if row else None,
            "allowedTypes": row["allowedTypes"] if row else None,
            "canonicalAllowedTypes": allowed,
            "placementUids": [member["uid"] for member in members],
            "serializedTypes": serialized,
            "canonicalSerializedTypes": canonical,
            "count": len(members),
            "serializedTypesEqualAllowedSet": complete,
            "availableTypesAtRaceStart": sorted(set(allowed)) if allowed else sorted(set(canonical)),
            "cycleRule": ("pop one allowed type without replacement per assignment; "
                          "re-initialise from the allowed mask when the list is empty"
                          if row else
                          "fixed serialized type; no row assignment"),
            "respawnsAsGroup": bool(row),
        })
    for group in groups:
        for position, uid in enumerate(group["placementUids"]):
            for slot in slots:
                if slot["uid"] == uid:
                    slot.setdefault("rowMembership", {})["slotIndexInGroup"] = position
    return groups


def start_grid_summary(actorpack, lists, route, measured):
    for list_id in route["multiplayerActorLists"]:
        info = lists.get(list_id)
        if not info or not info["starts"]:
            continue
        positions = []
        for component, name, element_count in pickup_components(actorpack, info["record"]):
            if name != "StartPosition":
                continue
            for element in range(element_count):
                actor = decode_actor(actorpack, info["record"], component, element)
                matrix = actor["WorldMatrix"]
                projection = geo.project_polyline(measured, matrix["aw"]["vx"],
                                                  matrix["aw"]["vz"])
                positions.append({
                    "name": actor["Name"]["value"] if isinstance(actor.get("Name"), dict)
                    else actor.get("Name"),
                    "startNumber": actor["StartNumber"],
                    "position": [matrix["aw"]["vx"], matrix["aw"]["vy"], matrix["aw"]["vz"]],
                    "measuredDistance": projection["distance"],
                    "measuredArc": projection["arc"],
                })
        if len(positions) != 20:
            continue
        return {
            "actorListId": list_id,
            "count": len(positions),
            "measuredDistanceMin": min(item["measuredDistance"] for item in positions),
            "measuredDistanceMax": max(item["measuredDistance"] for item in positions),
            "measuredArcMin": min(item["measuredArc"] for item in positions),
            "measuredArcMax": max(item["measuredArc"] for item in positions),
            "first": positions[0],
        }
    return None


def build_variant(actorpack, lists, route, types, rows, collision_grid, draw_grid,
                  measured, layout_samples, measured_len, actorpack_source,
                  mask_labels, respawn_labels, constants):
    pickup_lists = []
    for list_id in route["multiplayerActorLists"]:
        info = lists.get(list_id)
        if info and info["pickups"]:
            pickup_lists.append((list_id, info["record"], info["pickups"]))
    if len(pickup_lists) > 1:
        raise ValueError(f"route {route['recordId']} references {len(pickup_lists)} "
                         f"pickup actor lists; refusing to merge them silently")

    slots = []
    list_id = list_record = None
    if pickup_lists:
        list_id, list_record, _count = pickup_lists[0]
        for component, name, element_count in pickup_components(actorpack, list_record):
            if name != "PickupPosition":
                continue
            for element in range(element_count):
                slots.append(build_slot(actorpack, measured, layout_samples, list_record,
                                        component, element, types, rows,
                                        collision_grid, draw_grid, actorpack_source))
        slots.sort(key=lambda slot: (slot["component"], slot["element"]))
        for index, slot in enumerate(slots):
            slot["index"] = index
            slot["retailOrder"] = index

    groups = build_groups(slots)
    for slot in slots:
        slot["respawn"]["deactivateSeconds"] = constants.get("deactivateSeconds")
        mode = None
        if slot["row"]:
            mode = "row-group"
        slot["respawn"]["scope"] = mode

    races = route["races"]
    racing_races = route_races(route)
    race_summaries = []
    for race in races:
        bits = bits_of(race.get("powerups"))
        race_summaries.append({
            "recordId": race["recordId"],
            "raceType": race.get("raceType"),
            "laps": race.get("laps"),
            "minPlayers": race.get("minPlayers"),
            "maxPlayers": race.get("maxPlayers"),
            "powerupsBits": bits,
            "enabledTypes": mask_types(bits, mask_labels) if isinstance(bits, int) else [],
            "powerupRespawn": label_of(race.get("powerupRespawn")),
            "randomPowerups": label_of(race.get("randomPowerups")),
            "damageMode": label_of(race.get("damageMode")),
            "pickupProbabilityList": race.get("pickupProbabilityList"),
        })
    racing_summaries = [race for race in race_summaries if race["raceType"] == "racing"]
    modal_mode = modal([race["powerupRespawn"] for race in racing_summaries])
    modal_random = modal([race["randomPowerups"] for race in racing_summaries])
    modal_bits = modal([race["powerupsBits"] for race in racing_summaries])
    common_mask = None
    for race in racing_summaries:
        common_mask = race["powerupsBits"] if common_mask is None else common_mask & race["powerupsBits"]
    union_mask = 0
    for race in racing_summaries:
        union_mask |= race["powerupsBits"] or 0
    if modal_mode == "Normal":
        mode_seconds = None
        mode_status = "not-serialized"
    elif modal_mode == "Long":
        mode_seconds = constants.get("longSeconds")
        mode_status = "serialized-toggle"
    elif modal_mode == "VeryLong":
        mode_seconds = constants.get("veryLongSeconds")
        mode_status = "serialized-toggle"
    else:
        mode_seconds = None
        mode_status = "label-only"
    for slot in slots:
        slot["respawn"]["modeLabel"] = modal_mode
        slot["respawn"]["modeSeconds"] = mode_seconds
        slot["respawn"]["modeStatus"] = mode_status

    summary = summarise(slots, measured_len)
    spawn_set = [slot["uid"] for slot in slots if slot["reachability"]["spawnable"]]
    on_course = [slot["uid"] for slot in sorted(
        (slot for slot in slots if slot["reachability"]["onMeasuredCourse"]),
        key=lambda slot: slot["measuredPath"]["arc"])]
    excluded = [
        {"uid": slot["uid"], "type": slot["serializedType"]["name"],
         "reasons": slot["reachability"]["hardExclusions"]}
        for slot in slots if slot["reachability"]["status"] == "exclude"
    ]
    flagged = [
        {"uid": slot["uid"], "type": slot["serializedType"]["name"],
         "reasons": slot["reachability"]["flags"]}
        for slot in slots if slot["reachability"]["status"] == "flag"
    ]
    off_path = [
        {"uid": slot["uid"], "type": slot["serializedType"]["name"],
         "distance": slot["measuredPath"]["distance"]}
        for slot in slots if slot["reachability"]["pathClass"] == "off-path"
    ]
    enabled_default = mask_types(modal_bits, mask_labels) if modal_bits is not None else []
    default_set = [slot["uid"] for slot in slots
                   if slot["reachability"]["spawnable"]
                   and slot["serializedType"]["mpType"] in enabled_default]
    return {
        "recordId": route["recordId"],
        "routeNumber": route["routeNumber"],
        "cityRefId": route["cityRefId"],
        "cityName": route["cityName"],
        "multiplayerRaceCount": route["multiplayerRaceCount"],
        "racingRaceCount": route["racingRaceCount"],
        "multiplayerActorLists": route["multiplayerActorLists"],
        "pickupActorListId": list_id,
        "pickupActorListRecord": list_record,
        "placementCount": len(slots),
        "races": race_summaries,
        "defaultRaceConfig": {
            "selection": ("modal (powerupRespawn, randomPowerups) over racing races; "
                          "ties resolve to the first race in record order"),
            "powerupRespawn": modal_mode,
            "randomPowerups": modal_random,
            "powerupsModalBits": modal_bits,
            "powerupsIntersectionBits": common_mask,
            "powerupsUnionBits": union_mask,
            "enabledTypesDefault": enabled_default,
            "enabledTypesIntersection": (mask_types(common_mask, mask_labels)
                                         if common_mask is not None else []),
            "enabledTypesUnion": mask_types(union_mask, mask_labels),
            "respawnSeconds": mode_seconds,
            "respawnStatus": mode_status,
        },
        "slots": slots,
        "groups": groups,
        "summary": summary,
        "defaultSpawnSet": default_set,
        "measuredCourseSet": on_course,
        "excluded": excluded,
        "flagged": flagged,
        "offPath": off_path,
        "startGrid": start_grid_summary(actorpack, lists, route, measured),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--level", required=True)
    parser.add_argument("--layout")
    parser.add_argument("--out")
    args = parser.parse_args()

    level = args.level
    layout_key = args.layout or LAYOUT_KEYS.get(level, level)
    layout_path = ROOT / f"_work/e1-drive/{layout_key}/layout.json"
    level_physics = ROOT / f"game-data/Blur/levels/{level}/Level.levelphysics"
    draw_package = ROOT / f"_work/map-slice/{layout_key}"
    actorpack_path = f"\\gamedata\\levels\\{level}\\actorpack.xt"
    out_path = Path(args.out) if args.out else OUT_DIR / f"runtime-{layout_key}.json"

    index = pak_index(PACK)
    entries = {
        "actorpack": actorpack_path,
        "pickups": "\\gamedata\\xt\\pickups.bin",
        "multiplayer": "\\gamedata\\xt\\multiplayer.bin",
        "amax": "\\gamedata\\xt\\amax.bin",
        "singleplayer": "\\gamedata\\xt\\singleplayer.bin",
    }
    sources = {}
    blobs = {}
    for key, path in entries.items():
        entry = next(row for row in index["entries"] if row["path"] == path)
        data = decode_pak_entry(entry)
        blobs[key] = data
        sources[key] = source_record(entry, data)

    actorpack = xt_decode.Flask(blobs["actorpack"])
    pickups = xt_decode.Flask(blobs["pickups"])
    multiplayer = xt_decode.Flask(blobs["multiplayer"])
    amax = xt_decode.Flask(blobs["amax"])
    singleplayer = xt_decode.Flask(blobs["singleplayer"])

    types, type_order = decode_pickup_types(pickups)
    row_type_index = next(i for i in range(len(pickups.types))
                          if pickups.type_name(i) == "PickupPositionRow")
    rows = decode_rows(pickups, row_type_index)
    authority = extract_routes(amax, multiplayer, singleplayer)
    actor_lists = all_actor_lists(actorpack)
    mask_labels = decode_mask_labels(multiplayer)
    respawn_labels = decode_respawn_labels(multiplayer)
    constants = decode_powerup_constants()

    city_routes = [route for route in authority["routes"]
                   if route["cityName"]
                   and normalize_name(route["cityName"]) == normalize_name(level)]
    if not city_routes:
        raise ValueError(f"no Route record for level {level}")
    raced_routes = [route for route in city_routes if route["racingRaceCount"] > 0]
    unraced_routes = [route for route in city_routes if route["racingRaceCount"] == 0]
    raced_routes.sort(key=lambda route: (-route["racingRaceCount"],
                                         -route["multiplayerRaceCount"],
                                         route["recordId"]))
    primary_rule = ("highest racing MultiplayerRace count, then highest total "
                    "MultiplayerRace count, then lowest Route record id")
    primary = raced_routes[0] if raced_routes else None

    layout_data = json.loads(layout_path.read_text(encoding="utf-8"))
    samples = layout_data["course"]["samples"]
    measured = [(sample["x"], sample["z"]) for sample in samples]
    measured_len = layout_data["course"]["lengthMetres"]
    layout_samples = [{"arc": sample["arc"], "x": sample["x"], "z": sample["z"],
                       "groundY": sample.get("groundY"), "index": i}
                      for i, sample in enumerate(samples)]

    collision_triangles = geo.load_collision_triangles(level_physics)
    draw_triangles = geo.load_draw_triangles(draw_package)
    collision_grid = geo.TriangleGrid(collision_triangles)
    draw_grid = geo.TriangleGrid(draw_triangles)

    variants = [
        build_variant(actorpack, actor_lists, route, types, rows, collision_grid,
                      draw_grid, measured, layout_samples, measured_len,
                      sources["actorpack"], mask_labels, respawn_labels, constants)
        for route in raced_routes
    ]
    primary_variant = variants[0] if variants else None

    if primary_variant is None:
        raise ValueError(f"level {level} has no racing multiplayer route")

    placed_refs = {slot["serializedType"]["refId"]
                   for variant in variants for slot in variant["slots"]}
    missing_mp = [name for ref, name in MP_TYPES.items() if ref not in placed_refs]

    doc = {
        "kind": "powerups.pickup-runtime",
        "version": 1,
        "date": "2026-11-08",
        "owner": "PWR6",
        "scope": ("retail PickupPosition extraction + measured-course reachability + "
                  "host runtime placement set for " + level + "; data/analysis only; "
                  "no e1-drive, map-slice, race-rules, net-mvp, asset-reader, tools, "
                  "upstream or game-data change"),
        "level": level,
        "measuredLayout": layout_key,
        "sources": sources,
        "courseInputs": {
            "measuredLayout": {
                "path": f"_work/e1-drive/{layout_key}/layout.json",
                "sha256": sha256_file(layout_path),
                "lengthMetres": measured_len,
                "sampleCount": len(samples),
                "layoutHash": layout_data.get("hash"),
            },
            "levelphysics": {
                "path": f"game-data/Blur/levels/{level}/Level.levelphysics",
                "sha256": sha256_file(level_physics),
            },
            "drawBuffers": {
                "package": f"_work/map-slice/{layout_key}",
                "positions": {"path": f"_work/map-slice/{layout_key}/draws.positions.f32.bin",
                              "sha256": sha256_file(draw_package / "draws.positions.f32.bin"),
                              "bytes": (draw_package / "draws.positions.f32.bin").stat().st_size},
                "indices": {"path": f"_work/map-slice/{layout_key}/draws.indices.u32.bin",
                            "sha256": sha256_file(draw_package / "draws.indices.u32.bin"),
                            "bytes": (draw_package / "draws.indices.u32.bin").stat().st_size},
                "triangleCount": len(draw_triangles),
                "format": "float32x3 world positions + uint32 triangle indices",
                "use": ("visible-geometry clearance only; the draw package is diagnostic "
                        "geometry (materials/textures not applied)"),
            },
            "powerupsManifest": constants,
        },
        "reader": {
            "module": "probes/powerups/tools/xt_decode.py",
            "sha256": sha256_file(ROOT / "probes/powerups/tools/xt_decode.py"),
            "geometryModule": "probes/powerups/tools/pickup_runtime_common.py",
            "geometrySha256": sha256_file(ROOT / "probes/powerups/tools/pickup_runtime_common.py"),
            "method": ("FLSK v2 tables -> typed fields; PickupPosition elements decoded by "
                       "component offset; absolute element/field byte offsets recorded "
                       "per slot; handles resolved to ref ids"),
        },
        "verifier": {
            "tool": "probes/powerups/tools/verify_pickup_runtime.py",
            "sha256": sha256_file_if_exists(ROOT / "probes/powerups/tools/verify_pickup_runtime.py"),
            "independentOfBuilderDecoder": True,
            "determinism": "two builder runs must be byte-identical",
        },
        "typeTable": {
            "order": [{"refId": rid, "name": types[str(rid)]} for rid in type_order],
            "byRefId": types,
            "multiplayerTypes": [{"refId": ref, "name": name, "mpLabel": name}
                                 for ref, name in MP_TYPES.items()],
            "multiplayerCount": 8,
            "notPlacedByDefault": [{"refId": ref, "name": name,
                                    "relation": "not a multiplayer pickup type"}
                                   for ref, name in NON_MP_REFS.items()],
            "maskLabels": mask_labels,
            "maskLabelToType": MP_MASK_NAMES,
            "respawnLabels": respawn_labels,
        },
        "geometryModel": {
            "collision": {
                "source": f"game-data/Blur/levels/{level}/Level.levelphysics",
                "triangleCount": len(collision_triangles),
                "cellMetres": geo.CELL_METRES,
                "nearSearchRadiusMetres": geo.SEARCH_RADIUS_METRES,
                "groundBelow": "highest up-facing triangle (normal.y > 0.1) at or below slot y",
                "surfaceAbove": "lowest triangle above slot y",
                "steepNormalY": geo.STEEP_NORMAL_Y,
                "drivableNormalY": geo.DRIVABLE_NORMAL_Y,
            },
            "visible": {
                "source": f"_work/map-slice/{layout_key}/draws.*",
                "triangleCount": len(draw_triangles),
                "use": "diagnostic draw geometry; clearance only",
            },
            "thresholds": {
                "wallInsideMetres": WALL_INSIDE_METRES,
                "wallLowMetres": WALL_LOW_METRES,
                "coverInsideMetres": COVER_INSIDE_METRES,
                "coverLowMetres": COVER_LOW_METRES,
                "visibleOverlapMetres": VISIBLE_OVERLAP_METRES,
                "elevatedGroundMetres": ELEVATED_GROUND_METRES,
                "pickupRadiusProximityThreshold": PICKUP_RADIUS,
                "nearBandMetres": NEAR_BAND_METRES,
                "staticBoxHalfWidthMetres": STATIC_BOX_HALF_WIDTH,
            },
            "note": ("all thresholds are labelled project thresholds, not retail trigger "
                     "volumes; only the 1.25 x 1.25 x 0.25 m box is the recovered "
                     "collection trigger. `elevatedGroundMetres` flags a slot more than "
                     "2 m above the highest exported collision triangle below it: the "
                     "supporting platform can be a simple Box/Cylinder or an "
                     "InstancedTriangleMesh that the committed scanner does not export, "
                     "or the slot can be a deliberate floating jump pickup"),
        },
        "respawnModel": {
            "riverParity": {
                "deactivateSeconds": constants.get("deactivateSeconds"),
                "normalSeconds": None,
                "normalStatus": "not-serialized",
                "longSeconds": constants.get("longSeconds"),
                "veryLongSeconds": constants.get("veryLongSeconds"),
                "constantShuffleAllFalse": all(
                    not slot["overrides"]["constantShuffle"]
                    for variant in variants for slot in variant["slots"]),
                "respawnOverrideNonZero": [
                    slot["uid"] for variant in variants for slot in variant["slots"]
                    if slot["overrides"]["respawnTimerOverride"] != 0.0],
            },
            "rules": [
                "race start: every spawnable slot is active with its serialized type; "
                "row groups start with the allowed-type list shuffled by the host RNG",
                "collection: deactivate the slot for the recovered 0.6 s, then schedule "
                "the race powerupRespawn timer",
                "Normal respawn seconds are not serialized: emit respawn-unresolved and "
                "keep the slot inactive until the host supplies a value (never guess)",
                "Long = 5.0 s, VeryLong = 20.0 s from MultiplayerConfig; AlwaysOn / None "
                "have label-only semantics and no decoded seconds",
                "row group: on each assignment pop one allowed type without replacement; "
                "re-initialise from the allowed mask when empty; never duplicate inside "
                "one cycle",
                "fixed slot: keep the serialized type unless randomPowerups = On; a "
                "re-draw must be labelled provisional",
                "activationTimer and activationLap are 0 on every recovered slot: no "
                "per-lap or timed activation override is applied",
            ],
            "reset": {
                "raceReset": "re-spawn every slot from the serialized set and reset every "
                             "row group list to its allowed mask",
                "lapReset": "none (activationLap is 0 on every slot; no lap reset exists "
                            "in the recovered data)",
                "respawnLocationsFrame": "slot WorldMatrix is static and absolute; there is "
                                         "no relative-to-route binding in the actor",
            },
        },
        "collectionModel": {
            "trigger": "oriented Gravity box at WorldMatrix.aw, oriented by ax/ay/az",
            "halfExtentsMetres": {
                "static": [1.25, 1.25, 0.25],
                "rotating": [1.25, 1.25, 1.25],
                "fan": [2.5, 2.5, 0.5],
            },
            "activeHalfExtentsMetres": [1.25, 1.25, 0.25],
            "rotateGraphicAllFalse": all(
                not slot["overrides"]["rotateGraphic"]
                for variant in variants for slot in variant["slots"]),
            "pickupRadiusMetres": constants.get("pickupRadiusMetres"),
            "pickupRadiusUse": ("mCollisionRadius initialisation and AI/debug; the "
                                "collection trigger is the box above, not a 2.0 m sphere"),
            "source": "PickupPositionActor.cpp:215, 451-463, 478-520",
        },
        "authority": {
            "city": {"refId": primary_variant["cityRefId"],
                     "name": primary_variant["cityName"]},
            "primaryRouteRecordId": primary_variant["recordId"],
            "primaryRouteSelectionRule": primary_rule,
            "racedRouteCount": len(variants),
            "unracedRoutes": [{
                "recordId": route["recordId"],
                "routeNumber": route["routeNumber"],
                "multiplayerRaceCount": route["multiplayerRaceCount"],
                "pickupActorLists": [list_id for list_id in route["multiplayerActorLists"]
                                     if actor_lists.get(list_id, {}).get("pickups")],
            } for route in unraced_routes],
            "variants": variants,
        },
        "runtime": {
            "level": level,
            "routeRecordId": primary_variant["recordId"],
            "routeSelection": "primary (documented rule in authority.primaryRouteSelectionRule)",
            "ordering": {
                "slotOrder": "retail actor order: component, then element",
                "groupOrder": "sorted groupId string",
                "courseOrder": "measuredPath.arc ascending (only slots with a finite arc)",
            },
            "slotCount": primary_variant["placementCount"],
            "spawnableCount": primary_variant["summary"]["spawnable"],
            "excludedCount": primary_variant["summary"]["excluded"],
            "flaggedCount": primary_variant["summary"]["flagged"],
            "defaultSpawnSet": primary_variant["defaultSpawnSet"],
            "measuredCourseSet": primary_variant["measuredCourseSet"],
            "excluded": primary_variant["excluded"],
            "flagged": primary_variant["flagged"],
            "offPath": primary_variant["offPath"],
            "groups": primary_variant["groups"],
            "counts": primary_variant["summary"],
            "defaultRaceConfig": primary_variant["defaultRaceConfig"],
            "startGrid": primary_variant["startGrid"],
            "typeCoverage": {
                "placedMpTypes": sorted({slot["serializedType"]["mpType"]
                                         for slot in primary_variant["slots"]
                                         if slot["serializedType"]["mpType"]}),
                "missingMpTypes": missing_mp,
                "allEightPresent": not missing_mp,
            },
        },
        "extensions": {
            "SuperShield": {
                "refId": SUPERSHIELD_REF,
                "placedByDefault": False,
                "status": "project-extension",
                "reason": ("no multiplayer flag and no recovered placement on either map; "
                           "adding a slot would invent a coordinate"),
                "source": "docs/work/analysis/supershield.md (SS1)",
            },
        },
        "integration": {
            "consumer": "probes/e1-drive (read-only for PWR6; not modified)",
            "inputFiles": {
                "amboy": "_work/powerups/runtime-amboy.json",
                "gracia": "_work/powerups/runtime-gracia.json",
            },
            "schema": "powerups.pickup-runtime/1",
            "hashPins": {
                "rule": ("verify the fileSha256 recorded in the matching .verify.json and "
                         "the hashes.canonicalSha256 computed over the document without "
                         "the hashes block"),
            },
            "hostMust": [
                "read authority.variants[<runtime.routeRecordId>] and use its slots[] "
                "verbatim: uid, position, yaw.radians, serializedType.refId, row.shuffleGroup, "
                "overrides, respawn",
                "spawn only slots whose uid is in runtime.defaultSpawnSet (or apply a "
                "specific race mask on top and label the filter)",
                "apply race powerups mask: a slot whose mpType is not enabled must not "
                "spawn; no re-draw without the provisional label",
                "own the row group available lists, RNG, deactivation/respawn timers and "
                "collection validation (box test in collectionModel)",
                "send pickup-spawned / pickup / pickup-respawn / pickup-rejected events "
                "with uid, typeRefId, group, position, at, authority, seq",
            ],
            "clientMustNot": [
                "invent or snap a position: every coordinate comes from slots[].position",
                "assume Normal respawn seconds: they are not serialized (modeSeconds is "
                "null for Normal)",
                "assume a measured-path binding: the measured layout is draw coverage, not "
                "a retail start line; off-path slots are flagged, not moved",
                "roll a type, respawn a pickup or judge a collection locally",
                "treat the diagnostic draw geometry as a rendered map or the collision "
                "mesh as complete (simple shapes and InstancedTriangleMesh are excluded)",
            ],
            "lateJoin": ("send the full slot state (active/deactivated, typeRefId, "
                         "respawnAt) plus every row group's remaining available list, then "
                         "continue from the next seq; include routeRecordId and map id so a "
                         "late joiner cannot mix variants"),
            "errorPolicy": ("if a slot is missing, excluded or its group list is empty, "
                            "fail closed and emit a typed reason; never fall back to a "
                            "nearest measured sample"),
        },
        "missing": [
            {"item": "retail route arc and ordering (.aid spline)", "status": "not-decoded",
             "reason": "only the Route record and its actor lists are decoded"},
            {"item": "Normal respawn seconds", "status": "not-serialized",
             "reason": "RespawnTimerOverride is 0.0 on every slot; MultiplayerConfig has "
                       "no Normal seconds"},
            {"item": "runtime RNG order and row draw", "status": "runtime-only",
             "reason": "AssignPickup shuffles the allowed list with the race RNG"},
            {"item": "route-to-measured-path binding", "status": "not-decoded",
             "reason": "the measured e1-drive layout is draw coverage, not a retail start "
                       "line; several raced variants exist per level"},
            {"item": "PickupActiveLevel semantics", "status": "raw-only",
             "reason": "value 1 on almost every slot; Amboy primary uid 4231571987 stores 0"},
            {"item": "AlwaysOn / None respawn semantics", "status": "label-only",
             "reason": "only the enum label is serialized; no timer rule is decoded"},
            {"item": "collision simple shapes and InstancedTriangleMesh", "status": "not-in-package",
             "reason": "the committed scanner exports static triangle meshes only; the "
                       "engine loads the full file at runtime"},
            {"item": "inventory capacity / probability normalisation", "status": "runtime-only",
             "reason": "no raced route on these maps binds a PickupProbabilityList"},
        ],
        "limits": [
            "Placement data only: no renderer, GPU, vehicle, race-loop or full-game claim.",
            "No coordinate, yaw, type, group, respawn value or route binding is invented; "
            "every unknown is typed in `missing`.",
            "The measured e1-drive layout is a draw-covered point-to-point path, not a "
            "retail start line or lap.",
            "Reachability is measured against the committed collision mesh and diagnostic "
            "draw buffers; it is not a driven-route proof.",
            "The 2.0 m value is the labelled PickupRadius proximity threshold, not the "
            "collection trigger.",
            "Row assignment order is runtime-only; only the allowed set and no-replacement "
            "rule are proven.",
        ],
    }
    canonical = json.dumps(doc, sort_keys=True, separators=(",", ":"), allow_nan=False)
    doc["hashes"] = {
        "canonicalSha256": sha256_bytes(canonical.encode("utf-8")),
        "canonicalRule": ("sha256(json.dumps(doc_without_hashes, sort_keys=True, "
                          "separators=(',',':')))"),
        "fileSha256": "recorded by verify_pickup_runtime.py in the .verify.json",
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n"
    out_path.write_text(text, encoding="utf-8")

    print(json.dumps({
        "output": str(out_path.relative_to(ROOT)),
        "level": level,
        "primaryRoute": primary_variant["recordId"],
        "variants": [{"recordId": variant["recordId"],
                      "placements": variant["placementCount"],
                      "spawnable": variant["summary"]["spawnable"],
                      "excluded": variant["summary"]["excluded"],
                      "onCourse": len(variant["measuredCourseSet"]),
                      "types": variant["summary"]["typeCounts"]}
                     for variant in variants],
        "fileSha256": sha256_file(out_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
