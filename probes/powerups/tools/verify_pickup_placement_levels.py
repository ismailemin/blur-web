"""Independent verifier for the generalized pickup placement manifests.

It deliberately does not import the builder's `xt_decode`. It re-reads the PAK
entries, validates the FLSK tables with the committed reference parser
(`tools/prepare_xt_fixture.inspect`) and decodes every needed field with the
second direct-offset reader from `verify_pickup_placement.py`. It re-reads the
measured layouts, recomputes every projection and collision query, and compares
the complete placement document field by field.

Usage:
    python probes/powerups/tools/verify_pickup_placement_levels.py --level usa_amboy
    python probes/powerups/tools/verify_pickup_placement_levels.py --level spa_barcelona_gracia

Output: `_work/powerups/placements-<key>.verify.json`.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "powerups" / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "map-pipeline" / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402
from verify_pickup_placement import DirectFlask, close, decode_entry, project, sha256  # noqa: E402
import physics_scan  # noqa: E402

PACK = ROOT / "game-data/Blur/cache/gamedata.pak"
OUT_DIR = ROOT / "_work/powerups"
LAYOUT_KEYS = {"usa_amboy": "amboy", "spa_barcelona_gracia": "gracia"}
PICKUP_RADIUS = 2.0
BAND_HALF_WIDTH = 6.0

CHECKS = []
FAILURES = []


def check(name: str, ok: bool, detail=None) -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})
    if not ok:
        FAILURES.append({"name": name, "detail": detail})


def build_collision(level_path: Path):
    level = physics_scan.scan_level(level_path.read_bytes())
    triangles = []
    for a, b, c in physics_scan.flatten_static_triangles(level):
        ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
        nx = uy * vz - uz * vy
        ny = uz * vx - ux * vz
        nz = ux * vy - uy * vx
        length = math.sqrt(nx * nx + ny * ny + nz * nz)
        if length < 1e-12:
            continue
        triangles.append((a, b, c, (nx / length, ny / length, nz / length)))

    def ground(x, z):
        best = None
        for a, b, c, normal in triangles:
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

    return ground


def nearest_sample(samples, target):
    return min(samples, key=lambda sample: (abs(sample["arc"] - target), sample["index"]))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--level", required=True)
    parser.add_argument("--layout")
    parser.add_argument("--manifest")
    parser.add_argument("--out")
    args = parser.parse_args()

    level = args.level
    layout_key = args.layout or LAYOUT_KEYS.get(level, level)
    layout_path = ROOT / f"_work/e1-drive/{layout_key}/layout.json"
    level_physics = ROOT / f"game-data/Blur/levels/{level}/Level.levelphysics"
    manifest_path = Path(args.manifest) if args.manifest else OUT_DIR / f"placements-{layout_key}.json"
    out_path = Path(args.out) if args.out else OUT_DIR / f"placements-{layout_key}.verify.json"
    actorpack_path = f"\\gamedata\\levels\\{level}\\actorpack.xt"

    doc = json.loads(manifest_path.read_text(encoding="utf-8"))
    verifier_path = ROOT / "probes/powerups/tools/verify_pickup_placement_levels.py"
    check("verifier.sha256",
          doc["verifier"]["sha256"] == sha256(verifier_path.read_bytes()),
          {"documented": doc["verifier"]["sha256"],
           "actual": sha256(verifier_path.read_bytes())})
    reader_path = ROOT / "probes/powerups/tools/xt_decode.py"
    check("reader.sha256",
          doc["reader"]["sha256"] == sha256(reader_path.read_bytes()))
    index = pak_index(PACK)
    entries = {
        "actorpack": actorpack_path,
        "pickups": "\\gamedata\\xt\\pickups.bin",
        "multiplayer": "\\gamedata\\xt\\multiplayer.bin",
        "amax": "\\gamedata\\xt\\amax.bin",
        "singleplayer": "\\gamedata\\xt\\singleplayer.bin",
    }
    blobs = {}
    for key, path in entries.items():
        entry = next(row for row in index["entries"] if row["path"] == path)
        data = decode_entry(entry)
        blobs[key] = data
        source = doc["sources"][key]
        check(f"source.{key}.sha256", sha256(data) == source["sha256"],
              {"expected": source["sha256"], "actual": sha256(data)})
        check(f"source.{key}.extent",
              entry["offset"] == source["pakOffset"]
              and entry["stored_bytes"] == source["storedBytes"]
              and entry["logical_bytes"] == source["logicalBytes"],
              {"packOffset": entry["offset"]})

    actor = DirectFlask(blobs["actorpack"])
    pickups = DirectFlask(blobs["pickups"])
    multiplayer = DirectFlask(blobs["multiplayer"])
    amax = DirectFlask(blobs["amax"])
    singleplayer = DirectFlask(blobs["singleplayer"])

    # ---------------------------------------------------------- type table
    system_records = pickups.record_of_type("PickupSystem")
    check("pickupSystem.records", len(system_records) == 1, len(system_records))
    system_index = system_records[0]["index"]
    system = pickups.read_struct(system_index, pickups.type_index("PickupSystem"), 0)
    pickup_type_index = pickups.type_index("PickupType")
    type_entries = []
    for item in system["Types"]["items"]:
        record_index = item["record"]
        enum = pickups.read_field_by_name(record_index, pickup_type_index, "Type")
        type_entries.append({"refId": item["refId"], "label": enum["label"]})
    expected_types = doc["typeTable"]["order"]
    check("typeTable.ids", [e["refId"] for e in type_entries] == [e["refId"] for e in expected_types])
    check("typeTable.names", [e["label"] for e in type_entries] == [e["name"] for e in expected_types])

    # ----------------------------------------------------------- row table
    row_records = pickups.record_of_type("PickupPositionRow")
    check("rowTable.count", len(row_records) == len(doc["rowTable"]))
    row_type_index = pickups.type_index("PickupPositionRow")
    for entry in row_records:
        flags = pickups.read_field_by_name(entry["index"], row_type_index, "TypeList")
        stored = doc["rowTable"].get(str(entry["id"]))
        check(f"rowTable.{entry['id']}",
              stored is not None and stored["bits"] == flags["bits"]
              and stored["types"] == flags["labels"])

    # ------------------------------------------------------ measured layout
    layout_data = json.loads(layout_path.read_text(encoding="utf-8"))
    samples = layout_data["course"]["samples"]
    measured = [(sample["x"], sample["z"]) for sample in samples]
    layout_samples = [{"arc": sample["arc"], "x": sample["x"], "z": sample["z"],
                       "index": i} for i, sample in enumerate(samples)]
    check("courseInputs.layout.sha256",
          sha256(layout_path.read_bytes()) == doc["courseInputs"]["measuredLayout"]["sha256"])
    check("courseInputs.layout.length",
          close(layout_data["course"]["lengthMetres"],
                doc["courseInputs"]["measuredLayout"]["lengthMetres"]))
    check("courseInputs.layout.samples",
          len(samples) == doc["courseInputs"]["measuredLayout"]["sampleCount"])
    check("courseInputs.physics.sha256",
          sha256(level_physics.read_bytes()) == doc["courseInputs"]["levelphysics"]["sha256"])

    ground = build_collision(level_physics)

    # ------------------------------------------------------ route authority
    route_type = amax.type_index("Route")
    race_type = multiplayer.type_index("MultiplayerRace")

    def races_for(route_id):
        out = []
        for entry in multiplayer.record_of_type("MultiplayerRace"):
            handle = multiplayer.read_field_by_name(entry["index"], race_type, "route")
            if handle and handle["refId"] == route_id:
                out.append({
                    "recordId": entry["id"],
                    "raceType": multiplayer.read_field_by_name(entry["index"], race_type, "type"),
                    "laps": multiplayer.read_field_by_name(entry["index"], race_type, "laps"),
                    "minPlayers": multiplayer.read_field_by_name(entry["index"], race_type, "min_players"),
                    "maxPlayers": multiplayer.read_field_by_name(entry["index"], race_type, "max_players"),
                    "powerups": multiplayer.read_field_by_name(entry["index"], race_type, "powerups"),
                    "powerupRespawn": multiplayer.read_field_by_name(entry["index"], race_type, "poweruprespawn"),
                    "randomPowerups": multiplayer.read_field_by_name(entry["index"], race_type, "randompowerups"),
                    "damageMode": multiplayer.read_field_by_name(entry["index"], race_type, "damage_mode"),
                })
        return out

    def route_mp_lists(route_record):
        handle = amax.read_field_by_name(route_record, route_type, "MultiplayerActorLists")
        return [item["refId"] for item in handle["items"]]

    def route_number(route_record):
        return amax.read_field_by_name(route_record, route_type, "RouteNumber")

    def route_city(route_record):
        city = amax.read_field_by_name(route_record, route_type, "City")
        ref = city["refId"] if city else None
        record_index = amax.record_index(ref)
        raw = amax.read_field_by_name(record_index, amax.type_index("City"), "Name")
        return ref, amax.sz8_value(record_index, raw)

    # Recompute the raced-route ordering from the raw tables.
    doc_routes = doc["authority"]["routes"]
    recomputed = []
    for route_doc in doc_routes:
        record_index = amax.record_index(route_doc["recordId"])
        check(f"route.{route_doc['recordId']}.type",
              amax.records[record_index]["typeIndex"] == route_type)
        number = route_number(record_index)
        check(f"route.{route_doc['recordId']}.number", number == route_doc["routeNumber"])
        city_ref, city_name = route_city(record_index)
        check(f"route.{route_doc['recordId']}.cityRef", city_ref == route_doc["cityRefId"])
        check(f"route.{route_doc['recordId']}.cityName", city_name == route_doc["cityName"])
        lists = route_mp_lists(record_index)
        check(f"route.{route_doc['recordId']}.mpLists",
              lists == route_doc["multiplayerActorLists"], lists)
        races = races_for(route_doc["recordId"])
        racing = sum(1 for race in races
                     if (race["raceType"] or {}).get("label") == "racing")
        check(f"route.{route_doc['recordId']}.racingCount",
              racing == route_doc["racingRaceCount"], {"actual": racing})
        check(f"route.{route_doc['recordId']}.raceCount",
              len(races) == route_doc["multiplayerRaceCount"], {"actual": len(races)})
        documented = {r["recordId"]: r for r in route_doc["races"]}
        for race in races:
            stored = documented.get(race["recordId"])
            check(f"route.{route_doc['recordId']}.race.{race['recordId']}",
                  stored is not None
                  and stored["raceType"] == (race["raceType"] or {}).get("label")
                  and stored["laps"] == race["laps"]
                  and stored["powerups"] == race["powerups"]
                  and stored["powerupRespawn"] == race["powerupRespawn"]
                  and stored["randomPowerups"] == race["randomPowerups"])
        recomputed.append({
            "recordId": route_doc["recordId"],
            "racing": racing,
            "total": len(races),
        })
    recomputed.sort(key=lambda row: (-row["racing"], -row["total"], row["recordId"]))
    check("authority.primaryRule",
          doc["authority"]["primaryRouteRecordId"] == (recomputed[0]["recordId"] if recomputed else None),
          recomputed)
    check("authority.racedRouteCount",
          len(doc_routes) == doc["authority"]["racedRouteCount"] == len(recomputed))
    check("authority.city",
          doc["authority"]["city"]["name"] == doc_routes[0]["cityName"]
          and doc["authority"]["city"]["refId"] == doc_routes[0]["cityRefId"])

    # ------------------------------------------------------- placements
    total_placements = 0
    for route_doc in doc_routes:
        route_name = route_doc["recordId"]
        list_id = route_doc["pickupActorListId"]
        list_record = actor.record_index(list_id)
        check(f"list.{route_name}.type",
              actor.types[actor.records[list_record]["typeIndex"]]["name"] == "LevelActorList")
        check(f"list.{route_name}.record", list_record == route_doc["pickupActorListRecord"])
        entry = actor.records[list_record]
        pickup_type_index = actor.type_index("PickupPosition")
        components = []
        for relative in range(entry["componentCount"]):
            type_index, count, behaviour = actor.component_meta(list_record, relative)
            if type_index == pickup_type_index:
                components.append((relative, count, behaviour))
        check(f"list.{route_name}.componentCount", len(components) == 1, components)
        component, count, behaviour = components[0]
        check(f"list.{route_name}.count",
              count == route_doc["placementCount"] == len(route_doc["placements"]))
        check(f"list.{route_name}.behaviour", behaviour == 0)

        placements = route_doc["placements"]
        total_placements += len(placements)
        for expected in placements:
            actual = actor.read_component(list_record, component, expected["element"])
            matrix = actual["WorldMatrix"]
            position = [matrix["aw"]["vx"], matrix["aw"]["vy"], matrix["aw"]["vz"]]
            uid = expected["uid"]
            check(f"placement.{route_name}.{uid}.position",
                  position == [expected["position"]["x"], expected["position"]["y"],
                               expected["position"]["z"]])
            check(f"placement.{route_name}.{uid}.uid", actual["SerialisableUid"] == uid)
            name = actor.sz8_value(list_record, actual["Name"])
            check(f"placement.{route_name}.{uid}.name", name == expected["name"])
            type_handle = actual["PickupType"]
            type_ref = type_handle["refId"] if type_handle else None
            check(f"placement.{route_name}.{uid}.type",
                  type_ref == expected["serializedType"]["refId"])
            check(f"placement.{route_name}.{uid}.typeName",
                  doc["typeTable"]["byRefId"].get(str(type_ref))
                  == expected["serializedType"]["name"])
            row_handle = actual["RowType"]
            row_ref = row_handle["refId"] if row_handle else None
            expected_row = expected["row"]
            check(f"placement.{route_name}.{uid}.rowRef",
                  row_ref == (expected_row["refId"] if expected_row else None))
            check(f"placement.{route_name}.{uid}.rowIdRaw",
                  actual["RowId"] == expected["rowIdRaw"])
            if expected_row is not None:
                check(f"placement.{route_name}.{uid}.rowId",
                      actual["RowId"] == expected_row["id"])
            check(f"placement.{route_name}.{uid}.activeLevel",
                  actual["PickupActiveLevel"] == expected["overrides"]["pickupActiveLevel"])
            check(f"placement.{route_name}.{uid}.rotate",
                  actual["RotateGraphic"] == expected["overrides"]["rotateGraphic"])
            check(f"placement.{route_name}.{uid}.activationTimer",
                  close(actual["ActivationTimer"], expected["overrides"]["activationTimer"]))
            check(f"placement.{route_name}.{uid}.activationLap",
                  actual["ActivationLap"] == expected["overrides"]["activationLap"])
            check(f"placement.{route_name}.{uid}.respawnOverride",
                  close(actual["RespawnTimerOverride"], expected["overrides"]["respawnTimerOverride"]))
            check(f"placement.{route_name}.{uid}.constantShuffle",
                  actual["ConstantShuffle"] == expected["overrides"]["constantShuffle"])
            check(f"placement.{route_name}.{uid}.shuffleTypes",
                  actual["ShuffleTypes"]["bits"] == expected["overrides"]["shuffleTypes"]["bits"])
            excluded = [item["refId"] for item in actual["ExcludedPickupTypes"]["items"]]
            check(f"placement.{route_name}.{uid}.excluded",
                  excluded == expected["overrides"]["excludedPickupTypes"])
            for axis in ("ax", "ay", "az"):
                vector = matrix[axis]
                check(f"placement.{route_name}.{uid}.{axis}",
                      [vector["vx"], vector["vy"], vector["vz"]] == expected["basis"][axis])

            projection = project(measured, position[0], position[2])
            stored = expected["courseProjection"]["measuredLayout"]
            check(f"placement.{route_name}.{uid}.projection",
                  close(projection["distance"], stored["distance"])
                  and close(projection["arc"], stored["arc"])
                  and close(projection["point"][0], stored["point"][0])
                  and close(projection["point"][1], stored["point"][1]),
                  {"expected": stored, "actual": projection})
            check(f"placement.{route_name}.{uid}.onPath",
                  (projection["distance"] <= PICKUP_RADIUS)
                  == expected["onMeasuredPath"]["withinPickupRadius"]
                  and (projection["distance"] <= BAND_HALF_WIDTH)
                  == expected["onMeasuredPath"]["withinBandHalfWidth"])

            result = ground(position[0], position[2])
            collision = expected["collision"]
            check(f"placement.{route_name}.{uid}.collision",
                  (result is None) == (collision["groundY"] is None)
                  and (result is None or (
                      close(result[0], collision["groundY"])
                      and close(result[1], collision["normalY"]))))
            check(f"placement.{route_name}.{uid}.drivable",
                  (result is not None and result[1] > 0.94) == collision["drivableSurface"])
            check(f"placement.{route_name}.{uid}.surface",
                  (result is not None) == collision["surfacePresent"])

        # groups
        alias = doc["rowLabelAliases"]["map"]
        for group in route_doc["groups"]:
            if group["rowRefId"] is None:
                check(f"group.{route_name}.{group['groupId']}.singleton",
                      group["count"] == 1)
                continue
            allowed = [alias.get(name, name) for name in group["allowedTypes"]]
            complete = sorted(allowed) == sorted(group["serializedTypes"])
            check(f"group.{route_name}.{group['groupId']}.set",
                  complete == group["serializedTypesEqualAllowedSet"],
                  {"allowed": allowed, "serialized": group["serializedTypes"],
                   "documentedComplete": group["serializedTypesEqualAllowedSet"]})
            members = [p for p in placements if p["row"]
                       and p["row"]["shuffleGroup"] == group["groupId"]]
            check(f"group.{route_name}.{group['groupId']}.members",
                  len(members) == group["count"])

        # summary math
        distances = [p["courseProjection"]["measuredLayout"]["distance"] for p in placements]
        arcs = [p["courseProjection"]["measuredLayout"]["arc"] for p in placements]
        ca = route_doc["courseAnalysis"]
        check(f"summary.{route_name}.min", close(min(distances), ca["minDistance"]))
        for limit, key in ((2.0, "within2m"), (5.0, "within5m"),
                           (10.0, "within10m"), (25.0, "within25m"),
                           (BAND_HALF_WIDTH, "withinBandHalfWidth6m")):
            check(f"summary.{route_name}.{key}",
                  sum(1 for d in distances if d <= limit) == ca[key])
        check(f"summary.{route_name}.arcRange",
              close(min(arcs), ca["arcMin"]) and close(max(arcs), ca["arcMax"]))
        check(f"summary.{route_name}.counts",
              route_doc["counts"]["placements"] == len(placements))
        check(f"summary.{route_name}.types",
              route_doc["counts"]["types"]
              == dict(Counter(p["serializedType"]["name"] for p in placements)))
        rounded = Counter((round(p["position"]["x"], 3), round(p["position"]["z"], 3))
                          for p in placements)
        duplicates = [list(key) for key, count in rounded.items() if count > 1]
        documented_dupes = [d["xz"] for d in route_doc["duplicates"]["exactXZ1mm"]]
        check(f"summary.{route_name}.duplicates", sorted(duplicates) == sorted(documented_dupes))
        missing = [p["uid"] for p in placements if not p["collision"]["surfacePresent"]]
        check(f"summary.{route_name}.surfaceMissing",
              missing == route_doc["reachability"]["collisionSurfaceMissing"])
        not_drivable = [p["uid"] for p in placements if p["collision"]["surfacePresent"]
                        and not p["collision"]["drivableSurface"]]
        check(f"summary.{route_name}.notDrivable",
              not_drivable == route_doc["reachability"]["surfacePresentButNotDrivable"])
        off_path = [p["uid"] for p in placements if not p["onMeasuredPath"]["withinPickupRadius"]]
        check(f"summary.{route_name}.offPath",
              off_path == route_doc["reachability"]["offMeasuredPathWithin2m"]
              and len(off_path) == route_doc["reachability"]["offMeasuredPathCount"])

        # start grid
        grid = route_doc.get("startGrid")
        if grid is not None:
            grid_record = actor.record_index(grid["actorListId"])
            grid_component = None
            for relative in range(actor.records[grid_record]["componentCount"]):
                type_index, element_count, _ = actor.component_meta(grid_record, relative)
                if actor.types[type_index]["name"] == "StartPosition":
                    grid_component = (relative, element_count)
            check(f"startGrid.{route_name}.component", grid_component is not None)
            if grid_component is not None:
                relative, element_count = grid_component
                check(f"startGrid.{route_name}.count",
                      element_count == grid["count"] == len(grid["positions"]))
                for element, stored in enumerate(grid["positions"]):
                    value = actor.read_component(grid_record, relative, element)
                    matrix = value["WorldMatrix"]
                    position = [matrix["aw"]["vx"], matrix["aw"]["vy"], matrix["aw"]["vz"]]
                    check(f"startGrid.{route_name}.{stored['name']}.position",
                          position == stored["position"])
                    check(f"startGrid.{route_name}.{stored['name']}.number",
                          value["StartNumber"] == stored["startNumber"])
                    check(f"startGrid.{route_name}.{stored['name']}.name",
                          actor.sz8_value(grid_record, value["Name"]) == stored["name"])
                    projection = project(measured, position[0], position[2])
                    check(f"startGrid.{route_name}.{stored['name']}.distance",
                          close(projection["distance"], stored["measuredDistance"])
                          and close(projection["arc"], stored["measuredArc"]))
                check(f"startGrid.{route_name}.distanceMin",
                      close(grid["measuredDistanceMin"],
                            min(project(measured, s["position"][0], s["position"][2])["distance"]
                                for s in grid["positions"])))
                check(f"startGrid.{route_name}.bbox",
                      grid["bbox"] == {
                          "x": [min(s["position"][0] for s in grid["positions"]),
                                max(s["position"][0] for s in grid["positions"])],
                          "z": [min(s["position"][2] for s in grid["positions"]),
                                max(s["position"][2] for s in grid["positions"])]})

        # provisional comparison
        provisional = route_doc["provisionalComparison"]
        artifact = provisional["artifact"]
        if artifact["status"] == "found":
            provisional_path = ROOT / artifact["path"]
            check(f"provisional.{route_name}.file", provisional_path.exists())
            if provisional_path.exists():
                text = provisional_path.read_text(encoding="utf-8")
                check(f"provisional.{route_name}.fileHash",
                      sha256(text.encode("utf-8")) == artifact["sha256"])
            for index_, stored in enumerate(provisional["slots"]):
                sample = nearest_sample(layout_samples, stored["arcRequested"])
                check(f"provisional.{route_name}.slot{index_}.arc", close(sample["arc"], stored["arc"]))
                check(f"provisional.{route_name}.slot{index_}.position",
                      close(sample["x"], stored["x"]) and close(sample["z"], stored["z"]))
                best = min(math.hypot(sample["x"] - p["position"]["x"],
                                      sample["z"] - p["position"]["z"]) for p in placements)
                check(f"provisional.{route_name}.slot{index_}.nearest",
                      close(best, stored["nearestRealDistance"]))
                check(f"provisional.{route_name}.slot{index_}.covered",
                      (best <= PICKUP_RADIUS) == stored["coveredWithin2m"])
            covered = sum(1 for slot in provisional["slots"] if slot["coveredWithin2m"])
            check(f"provisional.{route_name}.diff.coverage",
                  provisional["diff"]["provisionalSlotsCoveredByRealWithin2m"] == covered)
            real_covered = 0
            for placement in placements:
                nearest = min(math.hypot(slot["x"] - placement["position"]["x"],
                                         slot["z"] - placement["position"]["z"])
                              for slot in provisional["slots"])
                if nearest <= PICKUP_RADIUS:
                    real_covered += 1
            check(f"provisional.{route_name}.diff.realCovered",
                  provisional["diff"]["realPlacementsCoveredByProvisionalWithin2m"] == real_covered)
            check(f"provisional.{route_name}.diff.onPath",
                  provisional["diff"]["realPlacementsOnMeasuredPath"]
                  == ca["withinPickupRadius"])

    # ----------------------------------------------------- collection model
    collection = doc.get("collectionModel")
    check("collectionModel.present", collection is not None)
    if collection is not None:
        check("collectionModel.activeExtents",
              collection["activeHalfExtentsMetres"] == [1.25, 1.25, 0.25])
        check("collectionModel.staticExtents",
              collection["halfExtentsMetres"]["static"] == [1.25, 1.25, 0.25])
        check("collectionModel.rotatingExtents",
              collection["halfExtentsMetres"]["rotating"] == [1.25, 1.25, 1.25])
        all_rotate_false = all(not p["overrides"]["rotateGraphic"]
                               for route in doc["authority"]["routes"]
                               for p in route["placements"])
        check("collectionModel.rotateAllFalse",
              collection["rotateGraphicAllFalse"] == all_rotate_false)
        check("collectionModel.pickupRadius", collection["pickupRadiusMetres"] == 2.0)
        check("collectionModel.thresholdNotTrigger",
              "collection trigger itself is the box" in collection["pickupRadiusUse"])

    # ---------------------------------------------------------------- hashes
    canonical_doc = {key: value for key, value in doc.items() if key != "hashes"}
    canonical = json.dumps(canonical_doc, sort_keys=True, separators=(",", ":"), allow_nan=False)
    check("hashes.canonical",
          sha256(canonical.encode("utf-8")) == doc["hashes"]["canonicalSha256"])
    file_hash = sha256(manifest_path.read_bytes())

    result = {
        "kind": "powerups.pickup-placement.verify",
        "version": 1,
        "level": level,
        "document": str(manifest_path.relative_to(ROOT)),
        "documentFileSha256": file_hash,
        "documentCanonicalSha256": doc["hashes"]["canonicalSha256"],
        "routes": len(doc["authority"]["routes"]),
        "placements": total_placements,
        "checks": len(CHECKS),
        "passed": sum(1 for c in CHECKS if c["ok"]),
        "failed": len(FAILURES),
        "status": "PASS" if not FAILURES else "FAIL",
        "failures": FAILURES,
        "details": CHECKS,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in
                      ("status", "checks", "passed", "failed", "routes", "placements",
                       "documentFileSha256", "documentCanonicalSha256")}, indent=2))
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    raise SystemExit(main())
