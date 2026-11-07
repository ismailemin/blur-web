"""Recover shipped PickupPosition placements for any raced level (read-only).

This generalizes PWR3's `extract_pickup_placement.py` (usa_la_river) to a level
parameter. The chain is the same:

    multiplayer.bin  MultiplayerRace.route        (handle)
      -> amax.bin    Route.City / RouteNumber / MultiplayerActorLists (handles)
      -> actorpack.xt LevelActorList               (record id)
      -> actorpack.xt PickupPosition               (WorldMatrix + type + row)

A level/city can ship several raced routes (different circuit variants). This
tool recovers **every route that a racing MultiplayerRace references** and marks
one `primary` using a documented rule (most racing races, then most total races,
then lowest route record id). It never invents a route choice silently.

The tool writes `_work/powerups/placements-<key>.json`. It never writes to game
data, upstream, probes/e1-drive or any other probe. Course projections use the
committed measured layout (`_work/e1-drive/<key>/layout.json`). Collision checks
use the committed collision oracle parser read-only.

No position, type, row or transform is invented. Anything not serialized is
recorded as missing/typed, not filled in.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import zlib
from collections import Counter, OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "powerups" / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "collision-oracle" / "tests"))
sys.path.insert(0, str(ROOT / "probes" / "map-pipeline" / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402  (committed PAK index)
import xt_decode  # noqa: E402  (committed PWR1 FLSK decoder)

PACK = ROOT / "game-data/Blur/cache/gamedata.pak"
OUT_DIR = ROOT / "_work/powerups"

# Level id -> measured e1-drive layout key (they happen to be identical).
LAYOUT_KEYS = {"usa_amboy": "amboy", "spa_barcelona_gracia": "gracia"}

PICKUP_RADIUS = 2.0  # PickupSystem.PickupRadius (PWR1 powerups.md §4.1)
BAND_HALF_WIDTH = 6.0  # declared e1-drive measurement band, not a road width

ROW_LABEL_ALIASES = {"Bolt": "Blindfire", "Mine": "Bomb"}

# PWR2's provisional plan. Read-only snapshot: the SHA-256 pins the compared
# file so a change is detected instead of silently comparing a different plan.
PROVISIONAL_JS = ROOT / "probes/e1-drive/web/powerups.js"


def canonical_row_type(label: str) -> str:
    return ROW_LABEL_ALIASES.get(label, label)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def sha256_file_if_exists(path: Path) -> str | None:
    return sha256_file(path) if path.exists() else None


def normalize_name(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def decode_pak_entry(entry: dict) -> bytes:
    with PACK.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    if len(packed) != entry["stored_bytes"]:
        raise ValueError("short PAK read")
    inflater = zlib.decompressobj()
    decoded = inflater.decompress(packed, entry["logical_bytes"] + 1)
    if (len(decoded) != entry["logical_bytes"] or not inflater.eof
            or inflater.unused_data or inflater.unconsumed_tail):
        raise ValueError(f"zlib extent mismatch for {entry['path']}")
    return decoded


def source_record(entry: dict, data: bytes) -> dict:
    return {
        "pack": "game-data/Blur/cache/gamedata.pak",
        "path": entry["path"],
        "pakOffset": entry["offset"],
        "storedBytes": entry["stored_bytes"],
        "logicalBytes": entry["logical_bytes"],
        "fatIndex": entry["fat_index"],
        "pathCrc32": entry["path_crc32"],
        "sha256": sha256_bytes(data),
    }


# ---------------------------------------------------------------- projections
def project_polyline(poly: list[tuple[float, float]], x: float, z: float) -> dict:
    best = None
    arc = 0.0
    for i in range(len(poly) - 1):
        ax, az = poly[i]
        bx, bz = poly[i + 1]
        dx, dz = bx - ax, bz - az
        length2 = dx * dx + dz * dz
        t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / length2))
        qx, qz = ax + t * dx, az + t * dz
        distance = math.hypot(x - qx, z - qz)
        if best is None or distance < best["distance"]:
            best = {
                "distance": distance,
                "arc": arc + t * math.sqrt(length2),
                "point": [qx, qz],
                "segment": i,
            }
        arc += math.sqrt(length2)
    return best


# ------------------------------------------------------------ collision probe
class CollisionProbe:
    def __init__(self, level_path: Path) -> None:
        # The committed collision oracle decodes only import type 0/11 meshes and
        # stops at the first Box/Cylinder shape. usa_amboy and
        # spa_barcelona_gracia start their shape stream with simple shapes, so the
        # committed map-pipeline scanner (physics_scan) is used instead. It follows
        # the upstream serializer and returns the same static triangle meshes that
        # the committed map-slice package exports; simple shapes and
        # InstancedTriangleMesh are excluded and labelled, never guessed.
        import physics_scan  # committed read-only scanner
        level = physics_scan.scan_level(level_path.read_bytes())
        self.triangles = []
        for a, b, c in physics_scan.flatten_static_triangles(level):
            ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
            vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
            nx = uy * vz - uz * vy
            ny = uz * vx - ux * vz
            nz = ux * vy - uy * vx
            length = math.sqrt(nx * nx + ny * ny + nz * nz)
            if length < 1e-12:
                continue
            self.triangles.append((a, b, c, (nx / length, ny / length, nz / length)))

    def ground(self, x: float, z: float):
        best = None
        for a, b, c, normal in self.triangles:
            if normal[1] <= 0.1:
                continue
            ax, az = a[0], a[2]
            bx, bz = b[0], b[2]
            cx, cz = c[0], c[2]
            det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
            if abs(det) < 1e-12:
                continue
            u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det
            v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det
            w = 1.0 - u - v
            if u < -1e-9 or v < -1e-9 or w < -1e-9:
                continue
            y = u * a[1] + v * b[1] + w * c[1]
            if best is None or y > best[0]:
                best = (y, normal[1])
        return best


# ------------------------------------------------------------------ extractors
def decode_pickup_types(pickups: xt_decode.Flask) -> tuple[dict, list]:
    system_type = next(i for i in range(len(pickups.types)) if pickups.type_name(i) == "PickupSystem")
    record_index = next(i for i in range(len(pickups.records))
                        if pickups.record_type(i) == system_type)
    system = pickups.decode_record(record_index)
    types = OrderedDict()
    for item in system["Types"]["items"]:
        rid = item["refId"]
        name = item["value"]["Type"]["label"]
        types[str(rid)] = name
    return types, [item["refId"] for item in system["Types"]["items"]]


def decode_rows(pickups: xt_decode.Flask, row_type_index: int) -> dict:
    rows = {}
    for ri in range(len(pickups.records)):
        if pickups.record_type(ri) != row_type_index:
            continue
        record = pickups.decode_record(ri)
        flags = record["TypeList"]
        rows[str(pickups.record_id(ri))] = {
            "bits": flags["bits"],
            "types": flags["labels"],
        }
    return rows


def pickup_components(flask: xt_decode.Flask, record_index: int) -> list[tuple[int, str, int]]:
    start = flask._component_start[record_index]
    count = flask.records[record_index][1]
    out = []
    for relative, (type_index, element_count, behaviour) in enumerate(
            flask.components[start:start + count]):
        out.append((relative, flask.type_name(type_index), element_count))
    return out


def decode_actor(flask: xt_decode.Flask, record_index: int, component: int, element: int) -> dict:
    return flask._component_element(record_index, component, element, 0, ())


def all_actor_lists(actorpack) -> dict:
    lists = {}
    for ri in range(len(actorpack.records)):
        if actorpack.type_name(actorpack.record_type(ri)) != "LevelActorList":
            continue
        counts = Counter()
        for _, name, element_count in pickup_components(actorpack, ri):
            counts[name] += element_count
        lists[actorpack.record_id(ri)] = {
            "record": ri,
            "counts": dict(counts),
            "pickups": counts.get("PickupPosition", 0),
            "starts": counts.get("StartPosition", 0),
        }
    return lists


def extract_routes(amax, multiplayer, singleplayer) -> dict:
    routes = []
    route_type = next(i for i in range(len(amax.types)) if amax.type_name(i) == "Route")
    for ri in range(len(amax.records)):
        if amax.record_type(ri) != route_type:
            continue
        record = amax.decode_record(ri)
        city = record.get("City")
        city_name = None
        if isinstance(city, dict):
            value = city.get("value")
            if isinstance(value, dict) and isinstance(value.get("Name"), dict):
                city_name = value["Name"].get("value")
            elif isinstance(value, dict):
                city_name = value.get("Name")
        def ids(name):
            field = record.get(name)
            if not isinstance(field, dict):
                return []
            return [item.get("refId") if isinstance(item, dict) else item
                    for item in field.get("items", [])]
        routes.append({
            "recordId": amax.record_id(ri),
            "recordIndex": ri,
            "cityRefId": city.get("refId") if isinstance(city, dict) else None,
            "cityName": city_name,
            "routeNumber": record.get("RouteNumber"),
            "actorLists": ids("ActorLists"),
            "multiplayerActorLists": ids("MultiplayerActorLists"),
            "cutsceneActorLists": ids("CutsceneActorLists"),
        })

    race_type = next(i for i in range(len(multiplayer.types)) if multiplayer.type_name(i) == "MultiplayerRace")
    route_counts = Counter()
    racing_counts = Counter()
    races_by_route = OrderedDict()
    for ri in range(len(multiplayer.records)):
        if multiplayer.record_type(ri) != race_type:
            continue
        record = multiplayer.decode_record(ri)
        route = record.get("route")
        route_id = route.get("refId") if isinstance(route, dict) else None
        route_counts[route_id] += 1
        race_type_field = record.get("type")
        race_label = race_type_field.get("label") if isinstance(race_type_field, dict) else race_type_field
        if race_label == "racing":
            racing_counts[route_id] += 1
        probability = record.get("PickupProbabilities")
        races_by_route.setdefault(route_id, []).append({
            "recordId": multiplayer.record_id(ri),
            "raceType": race_label,
            "laps": record.get("laps"),
            "minPlayers": record.get("min_players"),
            "maxPlayers": record.get("max_players"),
            "powerups": record.get("powerups"),
            "powerupRespawn": record.get("poweruprespawn"),
            "randomPowerups": record.get("randompowerups"),
            "damageMode": record.get("damage_mode"),
            "pickupProbabilityList": None if not isinstance(probability, dict)
            else {"refId": probability.get("refId"), "unloaded": probability.get("unloaded")},
        })

    for route in routes:
        route["multiplayerRaceCount"] = route_counts.get(route["recordId"], 0)
        route["racingRaceCount"] = racing_counts.get(route["recordId"], 0)
        route["races"] = races_by_route.get(route["recordId"], [])

    # Single-player events (provenance only, and a fallback when a level has no
    # racing multiplayer route at all).
    event_type = next(i for i in range(len(singleplayer.types)) if singleplayer.type_name(i) == "AmaxEvent")
    events_by_route = OrderedDict()
    for ri in range(len(singleplayer.records)):
        if singleplayer.record_type(ri) != event_type:
            continue
        record = singleplayer.decode_record(ri)
        route = record.get("Route")
        route_id = route.get("refId") if isinstance(route, dict) else None
        if route_id is None:
            continue
        name = record.get("Name")
        events_by_route.setdefault(route_id, []).append({
            "recordId": singleplayer.record_id(ri),
            "name": name.get("value") if isinstance(name, dict) else name,
        })
    for route in routes:
        route["singlePlayerEvents"] = events_by_route.get(route["recordId"], [])

    return {"routes": routes}


def extract_placement(actorpack, record_index, component, element, types, rows,
                      probe, measured) -> dict:
    actor = decode_actor(actorpack, record_index, component, element)
    matrix = actor["WorldMatrix"]
    position = [matrix["aw"]["vx"], matrix["aw"]["vy"], matrix["aw"]["vz"]]
    type_handle = actor.get("PickupType")
    type_ref = type_handle.get("refId") if isinstance(type_handle, dict) else None
    row_handle = actor.get("RowType")
    row_ref = row_handle.get("refId") if isinstance(row_handle, dict) else None
    row_info = rows.get(str(row_ref)) if row_ref is not None else None
    excluded = actor["ExcludedPickupTypes"]
    excluded_ids = []
    for item in excluded.get("items", []):
        if isinstance(item, dict) and item.get("refId") is not None:
            excluded_ids.append(item["refId"])
    projection = project_polyline(measured, position[0], position[2])
    ground = probe.ground(position[0], position[2])
    return {
        "uid": actor["SerialisableUid"],
        "name": actor["Name"]["value"] if isinstance(actor.get("Name"), dict) else actor.get("Name"),
        "actorListId": actorpack.record_id(record_index),
        "actorListRecord": record_index,
        "component": component,
        "element": element,
        "position": {"x": position[0], "y": position[1], "z": position[2]},
        "basis": {
            "ax": [matrix["ax"]["vx"], matrix["ax"]["vy"], matrix["ax"]["vz"]],
            "ay": [matrix["ay"]["vx"], matrix["ay"]["vy"], matrix["ay"]["vz"]],
            "az": [matrix["az"]["vx"], matrix["az"]["vy"], matrix["az"]["vz"]],
        },
        "serializedType": {
            "refId": type_ref,
            "name": types.get(str(type_ref)),
            "unloaded": bool(type_handle.get("unloaded", False)) if isinstance(type_handle, dict) else None,
        },
        "row": None if row_ref is None else {
            "refId": row_ref,
            "id": actor["RowId"],
            "allowedTypes": row_info["types"] if row_info else None,
            "bits": row_info["bits"] if row_info else None,
            "shuffleGroup": f"{row_ref}:{actor['RowId']}",
        },
        "rowIdRaw": actor["RowId"],
        "runtimeTypeRule": ("row-assignment-without-replacement"
                            if row_ref is not None else "serialized-fixed"),
        "overrides": {
            "pickupActiveLevel": actor["PickupActiveLevel"],
            "rotateGraphic": actor["RotateGraphic"],
            "activationTimer": actor["ActivationTimer"],
            "activationLap": actor["ActivationLap"],
            "respawnTimerOverride": actor["RespawnTimerOverride"],
            "constantShuffle": actor["ConstantShuffle"],
            "shuffleTypes": actor["ShuffleTypes"],
            "excludedPickupTypes": excluded_ids,
        },
        "collision": {
            "groundY": None if ground is None else ground[0],
            "normalY": None if ground is None else ground[1],
            "heightAboveGround": None if ground is None else position[1] - ground[0],
            "drivableSurface": ground is not None and ground[1] > 0.94,
            "surfacePresent": ground is not None,
        },
        "courseProjection": {"measuredLayout": projection},
        "onMeasuredPath": {
            "withinPickupRadius": projection["distance"] <= PICKUP_RADIUS,
            "withinBandHalfWidth": projection["distance"] <= BAND_HALF_WIDTH,
        },
    }


def read_provisional_plan() -> dict:
    if not PROVISIONAL_JS.exists():
        return {
            "status": "not-found",
            "path": "probes/e1-drive/web/powerups.js",
            "note": "no provisional placement artifact in this checkout",
        }
    text = PROVISIONAL_JS.read_text(encoding="utf-8")
    arcs_match = re.search(r"POWERUP_PLACEMENT_ARCS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)", text)
    types_match = re.search(r"POWERUP_PLACEMENT_TYPES\s*=\s*Object\.freeze\(\[([^\]]*)\]\)", text)
    if not arcs_match or not types_match:
        return {
            "status": "unparsed",
            "path": "probes/e1-drive/web/powerups.js",
            "sha256": sha256_bytes(text.encode("utf-8")),
            "note": "the provisional constants were not found in the expected form",
        }
    arcs = [float(value) for value in arcs_match.group(1).split(",") if value.strip()]
    types = [value.strip().strip("'\"") for value in types_match.group(1).split(",") if value.strip()]
    return {
        "status": "found",
        "path": "probes/e1-drive/web/powerups.js",
        "sha256": sha256_bytes(text.encode("utf-8")),
        "scope": ("untracked PWR2 work-in-progress at recovery time; the SHA-256 "
                  "pins the compared snapshot"),
        "arcs": arcs,
        "types": types,
        "placementLabel": "provisional-measured-arc",
        "rule": ("provisionalPickupPlan(): nearest layout sample (0.25 m) to each "
                 "arc, no interpolation; one item per arc, types cycle"),
    }


def nearest_sample(samples: list[dict], target: float) -> dict:
    return min(samples, key=lambda sample: (abs(sample["arc"] - target), sample["index"]))


def count_within(values, limit):
    return sum(1 for value in values if value <= limit)


def summarize_placements(placements, measured_len) -> dict:
    if not placements:
        return {
            "courseAnalysis": {
                "source": "measured e1-drive layout samples",
                "length": measured_len,
                "pickupRadius": PICKUP_RADIUS,
                "placements": 0,
                "note": "this route has no PickupPosition actor list",
            },
            "duplicates": {"exactXZ1mm": [], "duplicateUids": [],
                           "nearestNeighbour": [], "minNearestNeighbour": None},
            "reachability": {"pickupRadius": PICKUP_RADIUS, "collisionSurfaceMissing": [],
                             "surfacePresentButNotDrivable": [],
                             "offMeasuredPathWithin2m": [], "offMeasuredPathCount": 0,
                             "note": "no placements on this route"},
        }
    distances = [p["courseProjection"]["measuredLayout"]["distance"] for p in placements]
    arcs = [p["courseProjection"]["measuredLayout"]["arc"] for p in placements]
    nearest = min(placements, key=lambda p: p["courseProjection"]["measuredLayout"]["distance"])
    rounded = Counter((round(p["position"]["x"], 3), round(p["position"]["z"], 3)) for p in placements)
    duplicate_groups = []
    for (x, z), count in rounded.items():
        if count > 1:
            duplicate_groups.append({
                "xz": [x, z], "count": count,
                "uids": [p["uid"] for p in placements
                         if round(p["position"]["x"], 3) == x and round(p["position"]["z"], 3) == z],
            })
    uid_counts = Counter(p["uid"] for p in placements)
    nearest_neighbours = []
    for placement in placements:
        best = None
        for other in placements:
            if other is placement:
                continue
            d = math.hypot(placement["position"]["x"] - other["position"]["x"],
                           placement["position"]["z"] - other["position"]["z"])
            if best is None or d < best[0]:
                best = (d, other["uid"])
        nearest_neighbours.append({"uid": placement["uid"], "distance": best[0],
                                   "otherUid": best[1]})
    surface_missing = [p["uid"] for p in placements if not p["collision"]["surfacePresent"]]
    not_drivable = [p["uid"] for p in placements if p["collision"]["surfacePresent"]
                    and not p["collision"]["drivableSurface"]]
    off_path = [p["uid"] for p in placements
                if not p["onMeasuredPath"]["withinPickupRadius"]]
    return {
        "courseAnalysis": {
            "source": "measured e1-drive layout samples",
            "length": measured_len,
            "pickupRadius": PICKUP_RADIUS,
            "proximityThresholdLabel": ("PickupSystem.PickupRadius 2.0 m used as a "
                                        "proximity threshold; the collection trigger "
                                        "is the box in collectionModel"),
            "minDistance": min(distances),
            "minDistancePlacementUid": nearest["uid"],
            "minDistanceArc": nearest["courseProjection"]["measuredLayout"]["arc"],
            "medianDistance": sorted(distances)[len(distances) // 2],
            "withinPickupRadius": count_within(distances, PICKUP_RADIUS),
            "within2m": count_within(distances, 2.0),
            "within5m": count_within(distances, 5.0),
            "within10m": count_within(distances, 10.0),
            "within25m": count_within(distances, 25.0),
            "withinBandHalfWidth6m": count_within(distances, BAND_HALF_WIDTH),
            "arcMin": min(arcs),
            "arcMax": max(arcs),
            "placementsOnPath": [p["uid"] for p in placements
                                 if p["onMeasuredPath"]["withinPickupRadius"]],
        },
        "duplicates": {
            "exactXZ1mm": duplicate_groups,
            "duplicateUids": [uid for uid, count in uid_counts.items() if count > 1],
            "nearestNeighbour": nearest_neighbours,
            "minNearestNeighbour": (min(n["distance"] for n in nearest_neighbours)
                                    if nearest_neighbours else None),
        },
        "reachability": {
            "pickupRadius": PICKUP_RADIUS,
            "collisionSurfaceMissing": surface_missing,
            "surfacePresentButNotDrivable": not_drivable,
            "offMeasuredPathWithin2m": off_path,
            "offMeasuredPathCount": len(off_path),
            "note": ("'offMeasuredPathWithin2m' means farther than the 2.0 m pickup radius "
                     "from the measured layout centreline; it is not a claim that the "
                     "retail route cannot reach them. The retail .aid route is not decoded."),
        },
    }


def build_route(actorpack, lists, route, types, rows, probe, measured, measured_len,
                provisional_plan, layout_samples) -> dict:
    # A route can reference several LevelActorLists. Every list carrying
    # PickupPosition actors is recorded; a raced route must resolve to one.
    pickup_lists = []
    for list_id in route["multiplayerActorLists"]:
        info = lists.get(list_id)
        if info and info["pickups"]:
            pickup_lists.append((list_id, info["record"], info["pickups"]))
    if not pickup_lists:
        route["pickupActorListId"] = None
        route["pickupActorLists"] = []
        route["placements"] = []
        route["groups"] = []
        route["counts"] = {"placements": 0}
        route.update(summarize_placements([], measured_len))
        return route
    if len(pickup_lists) != 1:
        raise ValueError(f"route {route['recordId']} references {len(pickup_lists)} "
                         f"pickup actor lists; refusing to merge them silently")

    list_id, list_record, list_count = pickup_lists[0]
    route["pickupActorListId"] = list_id
    route["pickupActorListRecord"] = list_record
    route["placementCount"] = list_count

    placements = []
    for component, name, element_count in pickup_components(actorpack, list_record):
        if name != "PickupPosition":
            continue
        for element in range(element_count):
            placements.append(extract_placement(actorpack, list_record, component, element,
                                                types, rows, probe, measured))
    placements.sort(key=lambda p: (p["component"], p["element"]))
    for index_, placement in enumerate(placements):
        placement["index"] = index_

    group_map = OrderedDict()
    for placement in placements:
        row = placement["row"]
        key = row["shuffleGroup"] if row else f"fixed:{placement['uid']}"
        group_map.setdefault(key, []).append(placement)
    groups = []
    for key, members in group_map.items():
        row = members[0]["row"]
        serialized = [m["serializedType"]["name"] for m in members]
        allowed = row["allowedTypes"] if row else None
        complete = None
        if allowed is not None:
            complete = (sorted(serialized)
                        == sorted(canonical_row_type(name) for name in allowed))
        groups.append({
            "groupId": key,
            "rowRefId": row["refId"] if row else None,
            "rowId": row["id"] if row else None,
            "allowedTypes": allowed,
            "canonicalAllowedTypes": (None if allowed is None
                                      else [canonical_row_type(name) for name in allowed]),
            "placementUids": [m["uid"] for m in members],
            "serializedTypes": serialized,
            "count": len(members),
            "serializedTypesEqualAllowedSet": complete,
        })

    route["placements"] = placements
    route["groups"] = groups
    route.update(summarize_placements(placements, measured_len))
    route["counts"] = {
        "placements": len(placements),
        "withRow": sum(1 for p in placements if p["row"]),
        "fixedType": sum(1 for p in placements if not p["row"]),
        "groups": len(groups),
        "types": dict(Counter(p["serializedType"]["name"] for p in placements)),
        "pickupActiveLevel": dict(Counter(p["overrides"]["pickupActiveLevel"] for p in placements)),
        "rotateGraphic": dict(Counter(p["overrides"]["rotateGraphic"] for p in placements)),
        "constantShuffle": dict(Counter(p["overrides"]["constantShuffle"] for p in placements)),
        "respawnTimerOverrideNonZero": [p["uid"] for p in placements
                                        if p["overrides"]["respawnTimerOverride"] != 0.0],
        "activationTimerNonZero": [p["uid"] for p in placements
                                   if p["overrides"]["activationTimer"] != 0.0],
        "activationLapNonZero": [p["uid"] for p in placements
                                 if p["overrides"]["activationLap"] != 0],
        "shuffleTypesNonZero": [p["uid"] for p in placements
                                if p["overrides"]["shuffleTypes"]["bits"] != 0],
        "excludedTypesNonEmpty": [p["uid"] for p in placements
                                  if p["overrides"]["excludedPickupTypes"]],
    }

    # Start grid on the same route (provenance: locates the retail start).
    start_grid = None
    for list_id2 in route["multiplayerActorLists"]:
        info = lists.get(list_id2)
        if not info or not info["starts"]:
            continue
        positions = []
        for component, name, element_count in pickup_components(actorpack, info["record"]):
            if name != "StartPosition":
                continue
            for element in range(element_count):
                actor = decode_actor(actorpack, info["record"], component, element)
                matrix = actor["WorldMatrix"]
                projection = project_polyline(measured, matrix["aw"]["vx"], matrix["aw"]["vz"])
                positions.append({
                    "name": actor["Name"]["value"] if isinstance(actor.get("Name"), dict)
                    else actor.get("Name"),
                    "startNumber": actor["StartNumber"],
                    "position": [matrix["aw"]["vx"], matrix["aw"]["vy"], matrix["aw"]["vz"]],
                    "measuredDistance": projection["distance"],
                    "measuredArc": projection["arc"],
                })
        if len(positions) == 20:
            xs = [p["position"][0] for p in positions]
            zs = [p["position"][2] for p in positions]
            start_grid = {
                "actorListId": list_id2,
                "actorListRecord": info["record"],
                "count": len(positions),
                "positions": positions,
                "bbox": {"x": [min(xs), max(xs)], "z": [min(zs), max(zs)]},
                "measuredDistanceMin": min(p["measuredDistance"] for p in positions),
                "measuredDistanceMax": max(p["measuredDistance"] for p in positions),
            }
    route["startGrid"] = start_grid

    # Provisional plan applied to this map's measured layout (same arcs/types).
    provisional_slots = []
    if provisional_plan["status"] == "found":
        for index_, arc in enumerate(provisional_plan["arcs"]):
            sample = nearest_sample(layout_samples, arc)
            if placements:
                best = min(placements, key=lambda p: math.hypot(
                    sample["x"] - p["position"]["x"], sample["z"] - p["position"]["z"]))
                distance = math.hypot(sample["x"] - best["position"]["x"],
                                      sample["z"] - best["position"]["z"])
                best_uid = best["uid"]
            else:
                distance = None
                best_uid = None
            provisional_slots.append({
                "index": index_,
                "arcRequested": arc,
                "arc": sample["arc"],
                "sampleIndex": sample["index"],
                "x": sample["x"],
                "z": sample["z"],
                "pickupType": provisional_plan["types"][index_ % len(provisional_plan["types"])],
                "nearestRealDistance": distance,
                "nearestRealUid": best_uid,
                "coveredWithin2m": distance is not None and distance <= PICKUP_RADIUS,
            })
    real_covered = 0
    if provisional_slots and placements:
        for placement in placements:
            nearest_slot = min(math.hypot(slot["x"] - placement["position"]["x"],
                                          slot["z"] - placement["position"]["z"])
                               for slot in provisional_slots)
            if nearest_slot <= PICKUP_RADIUS:
                real_covered += 1
    recovered_types = sorted({p["serializedType"]["name"] for p in placements})
    slot_types = sorted({slot["pickupType"] for slot in provisional_slots})
    route["provisionalComparison"] = {
        "artifact": provisional_plan,
        "course": ("the same PWR2 arc values applied to this map's measured "
                   "layout; the '310 m' name belongs to usa_la_river"),
        "slots": provisional_slots,
        "diff": {
            "realPlacements": len(placements),
            "provisionalSlots": len(provisional_slots),
            "provisionalSlotsCoveredByRealWithin2m": sum(
                1 for slot in provisional_slots if slot["coveredWithin2m"]),
            "realPlacementsCoveredByProvisionalWithin2m": real_covered,
            "realPlacementsOnMeasuredPath": route["courseAnalysis"]["withinPickupRadius"],
            "nearestSlotToRealDistance": (min(slot["nearestRealDistance"]
                                              for slot in provisional_slots
                                              if slot["nearestRealDistance"] is not None)
                                          if provisional_slots and placements else None),
            "typeSets": {
                "provisional": slot_types,
                "recovered": recovered_types,
                "provisionalOnly": sorted(set(slot_types) - set(recovered_types)),
                "recoveredOnly": sorted(set(recovered_types) - set(slot_types)),
            },
            "duplicates": {
                "provisional": 0 if len({(round(slot["x"], 3), round(slot["z"], 3))
                                         for slot in provisional_slots}) == len(provisional_slots) else 1,
                "recovered": len(route["duplicates"]["exactXZ1mm"]),
            },
            "note": ("the provisional plan is 6 slots on the measured path; the "
                     "recovered set is the retail route whose length is not decoded. "
                     "Counts are not proportionally comparable and no such claim is made."),
        },
    }
    return route


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--level", required=True, help="level id, e.g. usa_amboy")
    parser.add_argument("--layout", help="measured layout key (default derived)")
    parser.add_argument("--out", help="output manifest path")
    args = parser.parse_args()

    level = args.level
    layout_key = args.layout or LAYOUT_KEYS.get(level, level)
    layout_path = ROOT / f"_work/e1-drive/{layout_key}/layout.json"
    level_physics = ROOT / f"game-data/Blur/levels/{level}/Level.levelphysics"
    actorpack_path = f"\\gamedata\\levels\\{level}\\actorpack.xt"
    out_path = Path(args.out) if args.out else OUT_DIR / f"placements-{layout_key}.json"

    index = pak_index(PACK)
    if index.get("codec") != 2:
        raise ValueError("expected the known zlib gamedata.pak")
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
    lists = all_actor_lists(actorpack)

    city_routes = [r for r in authority["routes"]
                   if r["cityName"] and normalize_name(r["cityName"]) == normalize_name(level)]
    if not city_routes:
        raise ValueError(f"no Route record for level {level}")
    raced_routes = [r for r in city_routes if r["racingRaceCount"] > 0]
    unraced_routes = [r for r in city_routes if r["racingRaceCount"] == 0]

    # Documented primary rule; alternates are kept in the manifest.
    raced_routes.sort(key=lambda r: (-r["racingRaceCount"], -r["multiplayerRaceCount"],
                                     r["recordId"]))
    primary_rule = ("highest racing MultiplayerRace count, then highest total "
                    "MultiplayerRace count, then lowest Route record id")
    primary = raced_routes[0] if raced_routes else None

    layout_data = json.loads(layout_path.read_text(encoding="utf-8"))
    samples = layout_data["course"]["samples"]
    measured = [(sample["x"], sample["z"]) for sample in samples]
    measured_len = layout_data["course"]["lengthMetres"]
    layout_samples = [{"arc": sample["arc"], "x": sample["x"], "z": sample["z"],
                       "index": i} for i, sample in enumerate(samples)]

    provisional_plan = read_provisional_plan()
    probe = CollisionProbe(level_physics)

    built = []
    for route in raced_routes:
        built.append(build_route(actorpack, lists, route, types, rows, probe,
                                 measured, measured_len, provisional_plan, layout_samples))

    # City record (name/id) for the provenance block.
    city_ref = city_routes[0]["cityRefId"]
    city_name = city_routes[0]["cityName"]

    doc = {
        "kind": "powerups.pickup-placement",
        "version": 1,
        "date": "2026-11-07",
        "owner": "PWR5",
        "scope": ("recovered shipped placement for " + level + "; data/analysis only; "
                  "no e1-drive, race-rules, net-mvp, asset-reader or tools change"),
        "level": level,
        "measuredLayout": layout_key,
        "sources": sources,
        "courseInputs": {
            "measuredLayout": {"path": f"_work/e1-drive/{layout_key}/layout.json",
                               "sha256": sha256_file(layout_path),
                               "lengthMetres": measured_len,
                               "sampleCount": len(samples)},
            "levelphysics": {"path": f"game-data/Blur/levels/{level}/Level.levelphysics",
                             "sha256": sha256_file(level_physics)},
        },
        "reader": {
            "module": "probes/powerups/tools/xt_decode.py",
            "sha256": sha256_file(ROOT / "probes/powerups/tools/xt_decode.py"),
            "method": ("FLSK v2 tables -> typed fields; PickupPosition elements decoded by "
                       "component offset; handles resolved to ref ids (records unloaded in "
                       "actorpack and resolved against pickups.bin by id)"),
        },
        "verifier": {
            "tool": "probes/powerups/tools/verify_pickup_placement_levels.py",
            "sha256": sha256_file_if_exists(ROOT / "probes/powerups/tools/verify_pickup_placement_levels.py"),
            "independentOfBuilderDecoder": True,
            "method": ("committed reference table validation + second direct-offset field "
                       "reader; recomputes every placement, route, projection, collision, "
                       "group, duplicate and provisional comparison"),
            "result": f"_work/powerups/placements-{layout_key}.verify.json",
        },
        "authority": {
            "city": {"refId": city_ref, "name": city_name},
            "primaryRouteRecordId": primary["recordId"] if primary else None,
            "primaryRouteSelectionRule": primary_rule,
            "racedRouteCount": len(raced_routes),
            "unracedRoutes": [{
                "recordId": r["recordId"], "routeNumber": r["routeNumber"],
                "multiplayerRaceCount": r["multiplayerRaceCount"],
                "pickupActorLists": [lid for lid in r["multiplayerActorLists"]
                                     if lists.get(lid, {}).get("pickups")],
            } for r in unraced_routes],
            "routes": built,
        },
        "typeTable": {
            "order": [{"refId": rid, "name": types[str(rid)]} for rid in type_order],
            "byRefId": types,
        },
        "collectionModel": {
            "triggerShape": ("oriented Gravity box at WorldMatrix.AW, oriented by "
                             "ax/ay/az; matrix is the actor WorldMatrix"),
            "halfExtentsMetres": {
                "static": [1.25, 1.25, 0.25],
                "rotating": [1.25, 1.25, 1.25],
                "fan": [2.5, 2.5, 0.5],
            },
            "activeHalfExtentsMetres": [1.25, 1.25, 0.25],
            "rotateGraphicAllFalse": all(
                not p["overrides"]["rotateGraphic"]
                for route in built for p in route["placements"]),
            "pickupRadiusMetres": PICKUP_RADIUS,
            "pickupRadiusUse": ("mCollisionRadius initialisation and AI/debug; the "
                                "collection trigger itself is the box above, not a "
                                "2.0 m sphere"),
            "source": "PickupPositionActor.cpp:215, 451-463, 478-520",
            "note": ("the 2.0 m value used for the path-coverage column is a labelled "
                     "proximity threshold, not the collection volume"),
        },
        "rowTable": rows,
        "rowLabelAliases": {
            "map": ROW_LABEL_ALIASES,
            "status": "inferred (PWR1 powerups.md §3.2); not a serialized equality",
            "use": "compares PickupTypeList flag labels with PickupType enum labels",
        },
        "missing": [
            {"item": "retail route arc length and ordering", "status": "not-decoded",
             "reason": "the .aid v6 route spline is not parsed; only the route record and "
                       "its actor lists are decoded"},
            {"item": "Normal respawn seconds / per-row respawn timing", "status": "not-serialized",
             "reason": "RespawnTimerOverride is 0.0 for every placement; the row record "
                       "carries only the allowed type mask; the respawn timer comes from "
                       "MpPowerupRespawn / PickupParametersStoredOnline at runtime (PWR1)"},
            {"item": "runtime RNG order for row assignment", "status": "runtime-only",
             "reason": "AddPickupActor shuffles the row's available list with the race RNG; "
                       "the serialized set is one of each allowed type, but execution order "
                       "is not in the file"},
            {"item": "per-mode probability filtering", "status": "runtime-only",
             "reason": "races enable different MpPickup masks; a raced type with probability "
                       "0 is reassigned by code (PickupPositionActor.cpp)"},
            {"item": "route-to-measured-path binding", "status": "not-decoded",
             "reason": "the measured e1-drive layout is draw coverage, not a retail start "
                       "line; the level can ship several raced routes and none is provably "
                       "the measured path"},
        ],
        "limits": [
            "This is actor placement data, not a renderer or full-game claim.",
            "No position is invented; every placement comes from actorpack.xt PickupPosition.",
            "The type is the serialized explicit type; row entries are re-assigned from the "
            "row mask at runtime without replacement (engine source cited in the analysis).",
            "The measured layout is not the retail route; projections are reported, not used "
            "to move a placement.",
            "The .aid retail spline and its arc are not decoded, so no retail arc coordinate "
            "is claimed.",
            "A level may ship several raced circuit variants; the manifest keeps every one "
            "and marks the primary by a documented rule, not by a guess.",
        ],
    }

    canonical = json.dumps(doc, sort_keys=True, separators=(",", ":"), allow_nan=False)
    doc["hashes"] = {
        "canonicalSha256": sha256_bytes(canonical.encode("utf-8")),
        "canonicalRule": "sha256(json.dumps(doc_without_hashes, sort_keys=True, separators=(',',':')))",
        "fileSha256": "recorded by verify_pickup_placement_levels.py in the .verify.json",
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n"
    out_path.write_text(text, encoding="utf-8")

    print(json.dumps({
        "output": str(out_path.relative_to(ROOT)),
        "level": level,
        "city": city_name,
        "racedRoutes": [{"recordId": r["recordId"], "routeNumber": r["routeNumber"],
                         "racingRaces": r["racingRaceCount"],
                         "placements": r["counts"]["placements"],
                         "types": r["counts"]["types"]} for r in built],
        "primaryRoute": primary["recordId"] if primary else None,
        "primaryPlacements": primary and built[0]["counts"]["placements"],
        "fileSha256": sha256_file(out_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
