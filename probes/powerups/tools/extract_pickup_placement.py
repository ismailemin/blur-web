"""Recover the shipped power-up pickup placement for usa_la_river (read-only).

Chain proven by this tool (all sources are entries inside gamedata.pak):

    multiplayer.bin  MultiplayerRace.route        (handle)
      -> amax.bin    Route.City / RouteNumber / MultiplayerActorLists (handles)
      -> actorpack.xt LevelActorList               (record id)
      -> actorpack.xt PickupPosition               (WorldMatrix + type + row)

The tool writes `_work/powerups/placements.json`. It never writes to game data,
upstream, probes/e1-drive or any other probe. Course projections use the
committed 310.395 m P48 path and the committed P61 loop-01 samples. Collision
checks use the committed collision oracle parser read-only.

No position, type, row or transform is invented. Anything not serialized is
recorded as missing/typed, not filled in.
"""
from __future__ import annotations

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

from inspect_asset_layout import pak_index  # noqa: E402  (committed PAK index)
import xt_decode  # noqa: E402  (committed PWR1 FLSK decoder)

PACK = ROOT / "game-data/Blur/cache/gamedata.pak"
OUT = ROOT / "_work/powerups/placements.json"
P48 = ROOT / "_work/drivable-path/path.json"
LOOPS = ROOT / "_work/lap-search/loops.json"
LEVEL = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
# PWR2's provisional plan. It is a parallel work-in-progress file (untracked at
# the time of this recovery); the manifest pins its SHA-256 so a change is
# detected instead of silently comparing against a different plan.
PROVISIONAL_JS = ROOT / "probes/e1-drive/web/powerups.js"

ENTRIES = {
    "actorpack": "\\gamedata\\levels\\usa_la_river\\actorpack.xt",
    "pickups": "\\gamedata\\xt\\pickups.bin",
    "multiplayer": "\\gamedata\\xt\\multiplayer.bin",
    "amax": "\\gamedata\\xt\\amax.bin",
    "singleplayer": "\\gamedata\\xt\\singleplayer.bin",
}

PICKUP_RADIUS = 2.0  # PickupSystem.PickupRadius (PWR1 powerups.md §4.1)

# `PickupTypeList` flag labels use the multiplayer names for two classes while
# the PickupType enum uses the internal names (PWR1 powerups.md §3.2). The
# mapping is recorded as inferred evidence in PWR1; it is used here only to
# compare a row's allowed set with the serialized per-slot types.
ROW_LABEL_ALIASES = {"Bolt": "Blindfire", "Mine": "Bomb"}


def canonical_row_type(label: str) -> str:
    return ROW_LABEL_ALIASES.get(label, label)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


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
    def __init__(self) -> None:
        import reference_oracle as ro  # committed oracle, read-only
        self.ro = ro
        self.level = ro.load_level(LEVEL.read_bytes())
        self.triangles = []
        for ordinal in range(ro.total_triangles(self.level)):
            tri = ro.global_triangle(self.level, ordinal)
            self.triangles.append((tri["a"], tri["b"], tri["c"], tri["normal"]))

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


# ------------------------------------------------------------------ extactors
def decode_pickup_types(pickups: xt_decode.Flask) -> tuple[dict, list]:
    system_type = next(i for i in range(len(pickups.types)) if pickups.type_name(i) == "PickupSystem")
    record_index = next(i for i in range(len(pickups.records))
                        if pickups.record_type(i) == system_type)
    system = pickups.decode_record(record_index)
    types = OrderedDict()
    for item in system["Types"]["items"]:
        rid = item["refId"]
        # PickupType has no string Name field; its serialized identity is the
        # `Type` enum label (PWR1 powerups.md §3).
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


def extract_route_authority(actorpack, amax, multiplayer, singleplayer) -> dict:
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

    # Multiplayer races: route handle at MultiplayerRace.route (+12).
    race_type = next(i for i in range(len(multiplayer.types)) if multiplayer.type_name(i) == "MultiplayerRace")
    route_counts = Counter()
    river_races = []
    for ri in range(len(multiplayer.records)):
        if multiplayer.record_type(ri) != race_type:
            continue
        record = multiplayer.decode_record(ri)
        route = record.get("route")
        route_id = route.get("refId") if isinstance(route, dict) else None
        route_counts[route_id] += 1
        if route_id in {r["recordId"] for r in routes if r["cityName"] == "USA_LA_River"}:
            probability = record.get("PickupProbabilities")
            river_races.append({
                "recordIndex": ri,
                "recordId": multiplayer.record_id(ri),
                "routeRefId": route_id,
                "raceType": record.get("type"),
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

    # Single-player events that reference the River routes (provenance only).
    event_type = next(i for i in range(len(singleplayer.types)) if singleplayer.type_name(i) == "AmaxEvent")
    events = []
    for ri in range(len(singleplayer.records)):
        if singleplayer.record_type(ri) != event_type:
            continue
        record = singleplayer.decode_record(ri)
        route = record.get("Route")
        route_id = route.get("refId") if isinstance(route, dict) else None
        if route_id not in {r["recordId"] for r in routes if r["cityName"] == "USA_LA_River"}:
            continue
        actor_lists = record.get("ActorLists")
        ids = [item.get("refId") if isinstance(item, dict) else item
               for item in actor_lists.get("items", [])] if isinstance(actor_lists, dict) else []
        name = record.get("Name")
        events.append({
            "recordId": singleplayer.record_id(ri),
            "name": name.get("value") if isinstance(name, dict) else name,
            "routeRefId": route_id,
            "actorLists": ids,
        })

    return {"routes": routes, "riverMpRaces": river_races, "riverSpEvents": events}


def extract_placement(actorpack, record_index, component, element, types, rows,
                      probe, path310, loop01) -> dict:
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
    projection310 = project_polyline(path310, position[0], position[2])
    projection_loop = project_polyline(loop01, position[0], position[2])
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
        "courseProjection": {
            "course310m": projection310,
            "loop01": projection_loop,
        },
        "onMeasuredArc": {
            "course310m": projection310["distance"] <= PICKUP_RADIUS,
            "loop01": projection_loop["distance"] <= PICKUP_RADIUS,
        },
    }


def read_provisional_plan() -> dict:
    """Read PWR2's provisional arcs/types without executing the module."""
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
        "rule": ("measuredArcPosition(): nearest 0.25 m sample of the committed P48 "
                 "path, no interpolation; one item per arc, types cycle"),
    }


def arc_samples(poly: list[tuple[float, float]]) -> list[dict]:
    """Arc table of the committed P48 polyline (same accumulation as PWR2)."""
    out = [{"arc": 0.0, "x": poly[0][0], "z": poly[0][1], "index": 0}]
    arc = 0.0
    for i in range(1, len(poly)):
        arc += math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1])
        out.append({"arc": round(arc, 6), "x": poly[i][0], "z": poly[i][1], "index": i})
    return out


def nearest_arc_sample(samples: list[dict], target: float) -> dict:
    return min(samples, key=lambda sample: (abs(sample["arc"] - target), sample["index"]))


def count_within(values, limit):
    return sum(1 for value in values if value <= limit)


def main() -> int:
    index = pak_index(PACK)
    if index.get("codec") != 2:
        raise ValueError("expected the known zlib gamedata.pak")
    sources = {}
    blobs = {}
    for key, path in ENTRIES.items():
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
    authority = extract_route_authority(actorpack, amax, multiplayer, singleplayer)

    river_routes = [r for r in authority["routes"]
                    if r["cityName"] == "USA_LA_River" and r["multiplayerRaceCount"] > 0]
    if len(river_routes) != 1:
        raise ValueError(f"expected exactly one raced River route, found {len(river_routes)}")
    route = river_routes[0]

    # The route's MultiplayerActorLists are the placement authority. Exactly one
    # referenced LevelActorList carries PickupPosition actors.
    pickup_lists = []
    for list_id in route["multiplayerActorLists"]:
        for ri in range(len(actorpack.records)):
            if actorpack.record_id(ri) != list_id:
                continue
            count = sum(element_count for _, name, element_count
                        in pickup_components(actorpack, ri) if name == "PickupPosition")
            if count:
                pickup_lists.append((list_id, ri, count))
    if len(pickup_lists) != 1:
        raise ValueError(f"expected one pickup actor list for the raced route, found {pickup_lists}")
    list_id, list_record, list_count = pickup_lists[0]
    route["pickupActorListId"] = list_id
    route["pickupActorListRecord"] = list_record
    route["placementCount"] = list_count

    # The raced route also references the 20-slot start grid. It is recorded
    # because it locates the retail start relative to the measured loop-01.
    start_grid = None
    for list_id2 in route["multiplayerActorLists"]:
        for ri in range(len(actorpack.records)):
            if actorpack.record_id(ri) != list_id2:
                continue
            for component, name, element_count in pickup_components(actorpack, ri):
                if name != "StartPosition":
                    continue
                positions = []
                for element in range(element_count):
                    actor = decode_actor(actorpack, ri, component, element)
                    matrix = actor["WorldMatrix"]
                    position = [matrix["aw"]["vx"], matrix["aw"]["vy"], matrix["aw"]["vz"]]
                    positions.append({
                        "name": actor["Name"]["value"] if isinstance(actor.get("Name"), dict)
                        else actor.get("Name"),
                        "startNumber": actor["StartNumber"],
                        "position": position,
                    })
                start_grid = {
                    "actorListId": list_id2,
                    "actorListRecord": ri,
                    "count": element_count,
                    "positions": positions,
                }

    # Other River routes are recorded but not used for the raced route.
    def pickup_lists_for(ids):
        out = []
        for list_id2 in ids:
            for ri in range(len(actorpack.records)):
                if actorpack.record_id(ri) != list_id2:
                    continue
                count = sum(element_count for _, name, element_count
                            in pickup_components(actorpack, ri) if name == "PickupPosition")
                if count and (list_id2, ri, count) not in out:
                    out.append((list_id2, ri, count))
        return [{"actorListId": a, "record": r, "placementCount": c} for a, r, c in out]

    other_routes = []
    for other in authority["routes"]:
        if other["cityName"] != "USA_LA_River" or other["recordId"] == route["recordId"]:
            continue
        other_routes.append({
            "recordId": other["recordId"],
            "routeNumber": other["routeNumber"],
            "multiplayerRaceCount": other["multiplayerRaceCount"],
            "multiplayerPickupActorLists": pickup_lists_for(other["multiplayerActorLists"]),
            "singlePlayerPickupActorLists": pickup_lists_for(other["actorLists"]),
        })

    path_data = json.loads(P48.read_text(encoding="utf-8"))
    path310 = [(p[0], p[1]) for p in path_data["course"]["points"]]
    loops_data = json.loads(LOOPS.read_text(encoding="utf-8"))
    loop_doc = next(loop for loop in loops_data["loops"] if loop["id"] == "loop-01")
    loop01 = [(p[0], p[1]) for p in loop_doc["points"]]

    if start_grid is not None:
        xs = [p["position"][0] for p in start_grid["positions"]]
        zs = [p["position"][2] for p in start_grid["positions"]]
        for item in start_grid["positions"]:
            item["loop01Distance"] = project_polyline(
                loop01, item["position"][0], item["position"][2])["distance"]
        start_grid["bbox"] = {"x": [min(xs), max(xs)], "z": [min(zs), max(zs)]}
        start_grid["loop01DistanceMin"] = min(item["loop01Distance"]
                                             for item in start_grid["positions"])
        start_grid["loop01DistanceMax"] = max(item["loop01Distance"]
                                             for item in start_grid["positions"])

    probe = CollisionProbe()
    placements = []
    for component, name, element_count in pickup_components(actorpack, list_record):
        if name != "PickupPosition":
            continue
        for element in range(element_count):
            placements.append(extract_placement(actorpack, list_record, component, element,
                                                types, rows, probe, path310, loop01))
    placements.sort(key=lambda p: (p["component"], p["element"]))
    for index_, placement in enumerate(placements):
        placement["index"] = index_

    # Groups: one shuffle group per (RowType, RowId), as the engine keys its map.
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

    distances310 = [p["courseProjection"]["course310m"]["distance"] for p in placements]
    distances_loop = [p["courseProjection"]["loop01"]["distance"] for p in placements]
    nearest310 = min(placements, key=lambda p: p["courseProjection"]["course310m"]["distance"])
    nearest_loop = min(placements, key=lambda p: p["courseProjection"]["loop01"]["distance"])

    # Duplicates: identical XZ to 1 mm, and identical UID (should be impossible).
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
    duplicate_uids = [uid for uid, count in uid_counts.items() if count > 1]

    # Nearest-neighbour spacing (XZ) inside the real set.
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
        nearest_neighbours.append({
            "uid": placement["uid"], "distance": best[0], "otherUid": best[1],
        })

    provisional_plan = read_provisional_plan()
    provisional_slots = []
    if provisional_plan["status"] == "found":
        samples = arc_samples(path310)
        for index_, arc in enumerate(provisional_plan["arcs"]):
            sample = nearest_arc_sample(samples, arc)
            best = min(placements, key=lambda p: math.hypot(
                sample["x"] - p["position"]["x"], sample["z"] - p["position"]["z"]))
            distance = math.hypot(sample["x"] - best["position"]["x"],
                                  sample["z"] - best["position"]["z"])
            provisional_slots.append({
                "index": index_,
                "arcRequested": arc,
                "arc": sample["arc"],
                "sampleIndex": sample["index"],
                "x": sample["x"],
                "z": sample["z"],
                "pickupType": provisional_plan["types"][index_ % len(provisional_plan["types"])],
                "nearestRealDistance": distance,
                "nearestRealUid": best["uid"],
                "coveredWithin2m": distance <= PICKUP_RADIUS,
            })

    course_analysis = {
        "course310m": {
            "source": "_work/drivable-path/path.json",
            "length": path_data["course"]["length"],
            "samples": path_data["course"]["samples"],
            "pickupRadius": PICKUP_RADIUS,
            "proximityThresholdLabel": ("PickupSystem.PickupRadius 2.0 m used as a "
                                        "proximity threshold; the collection trigger "
                                        "is the box in collectionModel"),
            "minDistance": min(distances310),
            "minDistancePlacementUid": nearest310["uid"],
            "medianDistance": sorted(distances310)[len(distances310) // 2],
            "withinPickupRadius": count_within(distances310, PICKUP_RADIUS),
            "within2m": count_within(distances310, 2.0),
            "within5m": count_within(distances310, 5.0),
            "within10m": count_within(distances310, 10.0),
            "within25m": count_within(distances310, 25.0),
            "placementsOnArc": [p["uid"] for p in placements if p["onMeasuredArc"]["course310m"]],
        },
        "loop01": {
            "source": "_work/lap-search/loops.json",
            "loopId": loop_doc["id"],
            "length": loop_doc["length"],
            "samples": loop_doc["samples"],
            "closed": loop_doc["closed"],
            "pickupRadius": PICKUP_RADIUS,
            "proximityThresholdLabel": ("PickupSystem.PickupRadius 2.0 m used as a "
                                        "proximity threshold; the collection trigger "
                                        "is the box in collectionModel"),
            "minDistance": min(distances_loop),
            "minDistancePlacementUid": nearest_loop["uid"],
            "medianDistance": sorted(distances_loop)[len(distances_loop) // 2],
            "withinPickupRadius": count_within(distances_loop, PICKUP_RADIUS),
            "within2m": count_within(distances_loop, 2.0),
            "within5m": count_within(distances_loop, 5.0),
            "within10m": count_within(distances_loop, 10.0),
            "within25m": count_within(distances_loop, 25.0),
            "placementsOnArc": [p["uid"] for p in placements if p["onMeasuredArc"]["loop01"]],
        },
    }

    real_covered_by_provisional = 0
    if provisional_slots:
        for placement in placements:
            nearest_slot = min(math.hypot(slot["x"] - placement["position"]["x"],
                                          slot["z"] - placement["position"]["z"])
                               for slot in provisional_slots)
            if nearest_slot <= PICKUP_RADIUS:
                real_covered_by_provisional += 1

    provisional_real_types = sorted({p["serializedType"]["name"] for p in placements})
    provisional_slot_types = sorted({slot["pickupType"] for slot in provisional_slots})
    provisional = {
        "artifact": provisional_plan,
        "slots": provisional_slots,
        "diff": {
            "realPlacements": len(placements),
            "provisionalSlots": len(provisional_slots),
            "provisionalSlotsCoveredByRealWithin2m": sum(
                1 for slot in provisional_slots if slot["coveredWithin2m"]),
            "realPlacementsCoveredByProvisionalWithin2m": real_covered_by_provisional,
            "realPlacementsOn310m": course_analysis["course310m"]["withinPickupRadius"],
            "realPlacementsOnLoop01": course_analysis["loop01"]["withinPickupRadius"],
            "realPlacementsOnBothMeasuredArcs": sum(
                1 for p in placements
                if p["onMeasuredArc"]["course310m"] and p["onMeasuredArc"]["loop01"]),
            "realPlacementsOffBothMeasuredArcs": sum(
                1 for p in placements
                if not p["onMeasuredArc"]["course310m"] and not p["onMeasuredArc"]["loop01"]),
            "nearestSlotToRealDistance": (min(slot["nearestRealDistance"]
                                              for slot in provisional_slots)
                                          if provisional_slots else None),
            "typeSets": {
                "provisional": provisional_slot_types,
                "recovered": provisional_real_types,
                "provisionalOnly": sorted(set(provisional_slot_types) - set(provisional_real_types)),
                "recoveredOnly": sorted(set(provisional_real_types) - set(provisional_slot_types)),
            },
            "countRatio": (len(provisional_slots) / len(placements) if placements else None),
            "duplicates": {
                "provisional": 0 if len({(round(slot["x"], 3), round(slot["z"], 3))
                                         for slot in provisional_slots}) == len(provisional_slots) else 1,
                "recovered": len(duplicate_groups),
            },
            "note": ("the provisional plan is 6 slots on the measured 310 m arc; the "
                     "recovered set is the retail route whose length is not decoded. "
                     "Counts are not proportionally comparable and no such claim is made."),
        },
    }

    surface_missing = [p["uid"] for p in placements if not p["collision"]["surfacePresent"]]
    not_drivable = [p["uid"] for p in placements if p["collision"]["surfacePresent"]
                    and not p["collision"]["drivableSurface"]]
    off_arcs = [p["uid"] for p in placements
                if not p["onMeasuredArc"]["course310m"] and not p["onMeasuredArc"]["loop01"]]

    doc = {
        "kind": "powerups.pickup-placement",
        "version": 1,
        "date": "2026-11-07",
        "owner": "PWR3",
        "scope": ("recovered shipped placement for usa_la_river; data/analysis only; "
                  "no e1-drive, race-rules, net-mvp, asset-reader or tools change"),
        "level": "usa_la_river",
        "sources": sources,
        "courseInputs": {
            "course310m": {"path": "_work/drivable-path/path.json",
                           "sha256": sha256_file(P48)},
            "loop01": {"path": "_work/lap-search/loops.json",
                       "sha256": sha256_file(LOOPS)},
            "levelphysics": {"path": "game-data/Blur/levels/usa_la_river/Level.levelphysics",
                             "sha256": sha256_file(LEVEL)},
        },
        "reader": {
            "module": "probes/powerups/tools/xt_decode.py",
            "sha256": sha256_file(ROOT / "probes/powerups/tools/xt_decode.py"),
            "method": ("FLSK v2 tables -> typed fields; PickupPosition elements decoded by "
                       "component offset; handles resolved to ref ids (records unloaded in "
                       "actorpack and resolved against pickups.bin by id)"),
        },
        "verifier": {
            "tool": "probes/powerups/tools/verify_pickup_placement.py",
            "sha256": sha256_file(ROOT / "probes/powerups/tools/verify_pickup_placement.py"),
            "independentOfBuilderDecoder": True,
            "method": ("committed reference table validation + second direct-offset field "
                       "reader; recomputes every placement, route, projection, collision, "
                       "group, duplicate and provisional comparison"),
            "result": "_work/powerups/placements.verify.json",
        },
        "authority": {
            "city": {"refId": 751655752, "name": "USA_LA_River"},
            "route": route,
            "startGrid": start_grid,
            "otherRiverRoutes": other_routes,
            "riverMpRaces": authority["riverMpRaces"],
            "riverSpEvents": authority["riverSpEvents"],
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
            "rotateGraphicAllFalse": all(not p["overrides"]["rotateGraphic"]
                                         for p in placements),
            "pickupRadiusMetres": PICKUP_RADIUS,
            "pickupRadiusUse": ("mCollisionRadius initialisation and AI/debug; the "
                                "collection trigger itself is the box above, not a "
                                "2.0 m sphere"),
            "source": "PickupPositionActor.cpp:215, 451-463, 478-520",
            "note": ("the 2.0 m value used for the arc-coverage column is a labelled "
                     "proximity threshold, not the collection volume"),
        },
        "rowTable": rows,
        "rowLabelAliases": {
            "map": ROW_LABEL_ALIASES,
            "status": "inferred (PWR1 powerups.md §3.2); not a serialized equality",
            "use": "compares PickupTypeList flag labels with PickupType enum labels",
        },
        "placements": placements,
        "groups": groups,
        "counts": {
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
        },
        "duplicates": {
            "exactXZ1mm": duplicate_groups,
            "duplicateUids": duplicate_uids,
            "nearestNeighbour": nearest_neighbours,
            "minNearestNeighbour": min(n["distance"] for n in nearest_neighbours),
        },
        "courseAnalysis": course_analysis,
        "provisionalComparison": provisional,
        "reachability": {
            "pickupRadius": PICKUP_RADIUS,
            "collisionSurfaceMissing": surface_missing,
            "surfacePresentButNotDrivable": not_drivable,
            "offBothMeasuredArcs": off_arcs,
            "offBothMeasuredArcsCount": len(off_arcs),
            "note": ("'offBothMeasuredArcs' means farther than the 2.0 m pickup radius from "
                     "the measured 310 m and loop-01 centrelines; it is not a claim that the "
                     "retail route cannot reach them. The retail .aid route is not decoded."),
        },
        "missing": [
            {"item": "retail route arc length and ordering",
             "status": "not-decoded",
             "reason": "the .aid v6 route spline is not parsed by this task; only the route "
                       "record and its actor lists are decoded"},
            {"item": "Normal respawn seconds / per-row respawn timing",
             "status": "not-serialized",
             "reason": "RespawnTimerOverride is 0.0 for all 54 placements; the row record "
                       "carries only the allowed type mask; the respawn timer comes from "
                       "MpPowerupRespawn / PickupParametersStoredOnline at runtime (PWR1)"},
            {"item": "runtime RNG order for row assignment",
             "status": "runtime-only",
             "reason": "AddPickupActor shuffles the row's available list with the race RNG; "
                       "the serialized set is one of each allowed type, but execution order "
                       "is not in the file"},
            {"item": "per-mode probability filtering",
             "status": "runtime-only",
             "reason": "the 11 River MP races enable different MpPickup masks; a raced type "
                       "with probability 0 is reassigned by code (PickupPositionActor.cpp)"},
        ],
        "limits": [
            "This is the actor placement data, not a renderer or full-game claim.",
            "No position is invented; every placement comes from actorpack.xt PickupPosition.",
            "The type is the serialized explicit type; row entries are re-assigned from the "
            "row mask at runtime without replacement (engine source cited in the analysis).",
            "The measured 310 m and loop-01 courses are not the retail route; projections are "
            "reported, not used to move a placement.",
            "The .aid retail spline and its arc are not decoded, so no retail arc coordinate "
            "is claimed.",
        ],
    }

    # The canonical hash is taken over the document *without* the hashes block;
    # the verifier recomputes the same bytes and also records the file hash.
    canonical = json.dumps(doc, sort_keys=True, separators=(",", ":"), allow_nan=False)
    doc["hashes"] = {
        "canonicalSha256": sha256_bytes(canonical.encode("utf-8")),
        "canonicalRule": "sha256(json.dumps(doc_without_hashes, sort_keys=True, separators=(',',':')))",
        "fileSha256": "recorded by verify_pickup_placement.py in placements.verify.json",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n"
    OUT.write_text(text, encoding="utf-8")

    print(json.dumps({
        "output": str(OUT),
        "placements": len(placements),
        "types": doc["counts"]["types"],
        "groups": len(groups),
        "routeId": route["recordId"],
        "routeNumber": route["routeNumber"],
        "actorListId": list_id,
        "min310": course_analysis["course310m"]["minDistance"],
        "on310": course_analysis["course310m"]["withinPickupRadius"],
        "minLoop": course_analysis["loop01"]["minDistance"],
        "onLoop": course_analysis["loop01"]["withinPickupRadius"],
        "surfaceMissing": len(surface_missing),
        "notDrivable": len(not_drivable),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
