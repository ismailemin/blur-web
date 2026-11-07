"""Independent verifier for the recovered usa_la_river pickup placement.

This verifier deliberately does not import `xt_decode`. It re-reads the PAK
entries, validates the FLSK tables with the committed reference parser
(`tools/prepare_xt_fixture.inspect`) and then decodes every needed field with a
second direct-offset reader (raw tables + struct offsets). It also re-reads the
committed course artifacts, recomputes every projection and collision query,
and compares the complete placement document field by field.

Output: `_work/powerups/placements.verify.json`.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import struct
import sys
import zlib
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "collision-oracle" / "tests"))

from inspect_asset_layout import pak_index  # noqa: E402
from prepare_xt_fixture import inspect as inspect_xt  # noqa: E402

PACK = ROOT / "game-data/Blur/cache/gamedata.pak"
DOC = ROOT / "_work/powerups/placements.json"
OUT = ROOT / "_work/powerups/placements.verify.json"
P48 = ROOT / "_work/drivable-path/path.json"
LOOPS = ROOT / "_work/lap-search/loops.json"
LEVEL = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"

ENTRIES = {
    "actorpack": "\\gamedata\\levels\\usa_la_river\\actorpack.xt",
    "pickups": "\\gamedata\\xt\\pickups.bin",
    "multiplayer": "\\gamedata\\xt\\multiplayer.bin",
    "amax": "\\gamedata\\xt\\amax.bin",
    "singleplayer": "\\gamedata\\xt\\singleplayer.bin",
}
PICKUP_RADIUS = 2.0

CHECKS = []
FAILURES = []


def check(name: str, ok: bool, detail=None) -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})
    if not ok:
        FAILURES.append({"name": name, "detail": detail})


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def decode_entry(entry: dict) -> bytes:
    with PACK.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    inflater = zlib.decompressobj()
    decoded = inflater.decompress(packed, entry["logical_bytes"] + 1)
    if (len(packed) != entry["stored_bytes"] or len(decoded) != entry["logical_bytes"]
            or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail):
        raise ValueError("PAK entry extent mismatch")
    return decoded


def decode_strings(encoded: bytes, version: int) -> bytes:
    out = bytearray(encoded)
    if version == 2 and encoded:
        previous = 0xCC
        for i, byte in enumerate(encoded[:-1]):
            value = (previous - (byte ^ 0xB3)) & 255
            out[i] = value
            previous = (previous + value - i) & 255
        out[-1] = 0
    return bytes(out)


class DirectFlask:
    """Second direct-offset reader: schema from the committed reference, payload
    offsets from the raw tables. No import of the manifest builder's decoder."""

    def __init__(self, raw: bytes):
        self.raw = raw
        self.report = inspect_xt(raw)
        self.types = self.report["types"]
        self.fields = self.report["fields"]
        self.records = self.report["records"]
        self.tables = self.report["tables"]
        self.version = self.report["version"]
        self._type_by_name = {entry["name"]: entry for entry in self.types}
        self.refs = self._rows("refs", "<I2H")
        self.bases = self._rows("bases", "<2H")
        self.components = self._rows("components", "<3H")

    def _rows(self, name, fmt):
        table = self.tables[name]
        return [struct.unpack_from(fmt, self.raw, table["offset"] + i * table["elementBytes"])
                for i in range(table["count"])]

    # schema ---------------------------------------------------------------
    def type_index(self, name: str) -> int:
        return self._type_by_name[name]["index"]

    def type_size(self, index: int) -> int:
        return self.types[index]["size"]

    def all_fields(self, index: int, base: int = 0, seen=None):
        seen = set() if seen is None else seen
        if index in seen:
            raise ValueError("schema base cycle")
        seen = seen | {index}
        out = []
        entry = self.types[index]
        for row in range(entry["baseStart"], entry["baseStart"] + entry["baseCount"]):
            base_type, base_offset = self.bases[row]
            out.extend(self.all_fields(base_type, base + base_offset, seen))
        for row in range(entry["fieldStart"], entry["fieldStart"] + entry["fieldCount"]):
            field = dict(self.fields[row])
            field["offset"] += base
            out.append(field)
        return out

    def field_index(self, index: int, name: str) -> dict:
        for field in self.all_fields(index):
            if field["name"] == name:
                return field
        raise KeyError(f"{name} not in {self.types[index]['name']}")

    def read_field_by_name(self, record_index: int, type_index: int, name: str):
        field = self.field_index(type_index, name)
        return self.read_field(record_index, type_index, field, self.payload(record_index), 0)

    def record_index(self, record_id: int) -> int:
        for entry in self.records:
            if entry["id"] == record_id:
                return entry["index"]
        raise KeyError(record_id)

    def record_of_type(self, type_name: str):
        index = self.type_index(type_name)
        return [entry for entry in self.records if entry["typeIndex"] == index]

    # payload --------------------------------------------------------------
    def payload(self, record_index: int) -> bytes:
        entry = self.records[record_index]
        start = entry["dataOffset"]
        return self.raw[start:start + entry["dataBytes"]]

    def strings(self, record_index: int) -> bytes:
        entry = self.records[record_index]
        start = entry["dataOffset"] + entry["dataBytes"]
        return decode_strings(self.raw[start:start + entry["stringBytes"]], self.version)

    def component_meta(self, record_index: int, relative: int):
        entry = self.records[record_index]
        if not 0 <= relative < entry["componentCount"]:
            raise ValueError("component outside record")
        return self.components[entry["componentStart"] + relative]

    def component_offset(self, record_index: int, relative: int) -> int:
        entry = self.records[record_index]
        offset = 0
        for i in range(relative):
            type_index, count, behaviour = self.components[entry["componentStart"] + i]
            size = self.type_size(type_index) if behaviour == 0 else 4
            offset = (offset + count * size + 3) & ~3
        return offset

    def component_element_type(self, record_index: int, relative: int) -> int:
        return self.component_meta(record_index, relative)[0]

    def read_atom(self, type_index: int, payload: bytes, offset: int):
        entry = self.types[type_index]
        atom = entry["atom"]
        if atom == 1:
            return struct.unpack_from("<I", payload, offset)[0] != 0
        if atom in (2, 3, 4, 5):
            fmt = {2: "<b", 3: "<h", 4: "<i", 5: "<q"}[atom]
            return struct.unpack_from(fmt, payload, offset)[0]
        if atom in (6, 7, 8, 9):
            fmt = {6: "<B", 7: "<H", 8: "<I", 9: "<Q"}[atom]
            return struct.unpack_from(fmt, payload, offset)[0]
        if atom == 10:
            return struct.unpack_from("<f", payload, offset)[0]
        if atom == 11:
            return struct.unpack_from("<d", payload, offset)[0]
        if atom in (12, 13):
            return ("sz", struct.unpack_from("<I", payload, offset)[0])
        if atom == 14:
            return ("loc", struct.unpack_from("<I", payload, offset)[0])
        raise ValueError(f"unsupported atom {atom}")

    def read_field(self, record_index: int, type_index: int, field: dict,
                   payload: bytes, base: int):
        behaviour = field["behaviour"]
        field_type = field["typeIndex"]
        offset = base + field["offset"]
        if field["array"]:
            component, element, length = struct.unpack_from("<2HI", payload, offset)
            if component == 0xFFFF:
                return {"length": 0, "items": []}
            entry = self.records[record_index]
            component_index = entry["componentStart"] + component
            if not 0 <= component < entry["componentCount"]:
                raise ValueError("array component outside record")
            element_type, count, element_behaviour = self.components[component_index]
            element_size = self.type_size(element_type) if element_behaviour == 0 else 4
            element_base = self.component_offset(record_index, component) + element * element_size
            items = []
            for i in range(length):
                at = element_base + i * element_size
                if element_behaviour == 0:
                    items.append(self.read_struct(record_index, element_type, at))
                elif element_behaviour == 2:
                    items.append(self.resolve_handle(struct.unpack_from("<I", payload, at)[0]))
                else:
                    raise ValueError("unsupported array element behaviour")
            return {"length": length, "items": items}
        if behaviour == 4:
            component, element = struct.unpack_from("<2H", payload, offset)
            if component == 0xFFFF:
                return None
            return self.read_component(record_index, component, element)
        if behaviour == 5:
            return self.resolve_handle(struct.unpack_from("<I", payload, offset)[0])
        if behaviour == 3:
            return self.read_struct(record_index, field_type, offset)
        if behaviour == 1:
            label_index = struct.unpack_from("<I", payload, offset)[0]
            labels = [self.fields[row]["name"] for row in range(
                self.types[field_type]["fieldStart"],
                self.types[field_type]["fieldStart"] + self.types[field_type]["fieldCount"])]
            return {"labelIndex": label_index,
                    "label": labels[label_index] if label_index < len(labels) else None}
        if behaviour == 2:
            bits = struct.unpack_from("<I", payload, offset)[0]
            labels = [self.fields[row]["name"] for row in range(
                self.types[field_type]["fieldStart"],
                self.types[field_type]["fieldStart"] + self.types[field_type]["fieldCount"])]
            return {"bits": bits, "labels": [name for i, name in enumerate(labels) if bits & (1 << i)]}
        if behaviour == 0:
            return self.read_atom(field_type, payload, offset)
        raise ValueError(f"unsupported field behaviour {behaviour}")

    def read_struct(self, record_index: int, type_index: int, base: int) -> dict:
        payload = self.payload(record_index)
        out = {"$type": self.types[type_index]["name"]}
        for field in self.all_fields(type_index):
            out[field["name"]] = self.read_field(record_index, type_index, field, payload, base)
        return out

    def read_component(self, record_index: int, component: int, element: int) -> dict:
        type_index, count, behaviour = self.component_meta(record_index, component)
        if not 0 <= element < count:
            raise ValueError("component element outside range")
        size = self.type_size(type_index) if behaviour == 0 else 4
        base = self.component_offset(record_index, component) + element * size
        if behaviour != 0:
            raise ValueError("only struct components supported here")
        return self.read_struct(record_index, type_index, base)

    def resolve_handle(self, index: int):
        if index == 0xFFFFFFFF:
            return None
        ref_id, type_index, record = self.refs[index]
        return {"refId": ref_id, "typeName": self.types[type_index]["name"],
                "record": None if record == 0xFFFF else record}

    def sz8_value(self, record_index: int, value) -> str:
        if not (isinstance(value, tuple) and value[0] == "sz"):
            return value
        strings = self.strings(record_index)
        offset = value[1]
        end = strings.find(b"\0", offset)
        if end < 0:
            raise ValueError("unterminated string")
        return strings[offset:end].decode("latin-1")


# ------------------------------------------------------------------ projections
def project(poly, x, z):
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
            best = {"distance": distance, "arc": arc + t * math.sqrt(length2),
                    "point": [qx, qz], "segment": i}
        arc += math.sqrt(length2)
    return best


def close(a, b, tol=1e-9):
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= tol


def main() -> int:
    doc = json.loads(DOC.read_text(encoding="utf-8"))
    index = pak_index(PACK)
    blobs = {}
    for key, path in ENTRIES.items():
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
    types_array = system["Types"]
    type_entries = []
    pickup_type_index = pickups.type_index("PickupType")
    for item in types_array["items"]:
        record_index = item["record"]
        enum = pickups.read_field_by_name(record_index, pickup_type_index, "Type")
        type_entries.append({"refId": item["refId"], "label": enum["label"]})
    expected_types = doc["typeTable"]["order"]
    check("typeTable.ids", [e["refId"] for e in type_entries] == [e["refId"] for e in expected_types],
          type_entries)
    check("typeTable.names", [e["label"] for e in type_entries] == [e["name"] for e in expected_types],
          type_entries)

    # ----------------------------------------------------------- row table
    row_records = pickups.record_of_type("PickupPositionRow")
    check("rowTable.count", len(row_records) == len(doc["rowTable"]),
          {"expected": len(doc["rowTable"]), "actual": len(row_records)})
    row_type_index = pickups.type_index("PickupPositionRow")
    for entry in row_records:
        flags = pickups.read_field_by_name(entry["index"], row_type_index, "TypeList")
        stored = doc["rowTable"].get(str(entry["id"]))
        check(f"rowTable.{entry['id']}",
              stored is not None and stored["bits"] == flags["bits"]
              and stored["types"] == flags["labels"],
              {"expected": stored, "actual": flags})

    # -------------------------------------------------------- placement list
    route = doc["authority"]["route"]
    list_id = route["pickupActorListId"]
    list_record = actor.record_index(list_id)
    check("actorList.recordType",
          actor.types[actor.records[list_record]["typeIndex"]]["name"] == "LevelActorList")
    check("actorList.recordIndexMatchesDoc", list_record == route["pickupActorListRecord"])

    pickup_type_index = actor.type_index("PickupPosition")
    entry = actor.records[list_record]
    pickup_components = []
    for relative in range(entry["componentCount"]):
        type_index, count, behaviour = actor.component_meta(list_record, relative)
        if type_index == pickup_type_index:
            pickup_components.append((relative, count, behaviour))
    check("actorList.onePickupComponent", len(pickup_components) == 1, pickup_components)
    component, count, behaviour = pickup_components[0]
    check("actorList.pickupCount", count == route["placementCount"] == len(doc["placements"]),
          {"component": count, "doc": len(doc["placements"])})
    check("actorList.pickupBehaviour", behaviour == 0)

    # Course polylines are loaded before the placement loop so every stored
    # projection can be recomputed from the committed artifacts.
    path_data = json.loads(P48.read_text(encoding="utf-8"))
    path310 = [(p[0], p[1]) for p in path_data["course"]["points"]]
    loops_data = json.loads(LOOPS.read_text(encoding="utf-8"))
    loop_doc = next(loop for loop in loops_data["loops"] if loop["id"] == "loop-01")
    loop01 = [(p[0], p[1]) for p in loop_doc["points"]]

    placements = doc["placements"]
    for expected in placements:
        actual = actor.read_component(list_record, component, expected["element"])
        matrix = actual["WorldMatrix"]
        position = [matrix["aw"]["vx"], matrix["aw"]["vy"], matrix["aw"]["vz"]]
        check(f"placement.{expected['uid']}.position",
              position == [expected["position"]["x"], expected["position"]["y"],
                           expected["position"]["z"]], {"expected": expected["position"], "actual": position})
        check(f"placement.{expected['uid']}.uid", actual["SerialisableUid"] == expected["uid"])
        name = actor.sz8_value(list_record, actual["Name"])
        check(f"placement.{expected['uid']}.name", name == expected["name"],
              {"expected": expected["name"], "actual": name})
        type_handle = actual["PickupType"]
        type_ref = type_handle["refId"] if type_handle else None
        check(f"placement.{expected['uid']}.type", type_ref == expected["serializedType"]["refId"],
              {"expected": expected["serializedType"]["refId"], "actual": type_ref})
        row_handle = actual["RowType"]
        row_ref = row_handle["refId"] if row_handle else None
        expected_row = expected["row"]
        check(f"placement.{expected['uid']}.rowRef",
              row_ref == (expected_row["refId"] if expected_row else None))
        check(f"placement.{expected['uid']}.rowId",
              actual["RowId"] == (expected_row["id"] if expected_row else 0))
        check(f"placement.{expected['uid']}.activeLevel",
              actual["PickupActiveLevel"] == expected["overrides"]["pickupActiveLevel"])
        check(f"placement.{expected['uid']}.rotate",
              actual["RotateGraphic"] == expected["overrides"]["rotateGraphic"])
        check(f"placement.{expected['uid']}.activationTimer",
              close(actual["ActivationTimer"], expected["overrides"]["activationTimer"]))
        check(f"placement.{expected['uid']}.activationLap",
              actual["ActivationLap"] == expected["overrides"]["activationLap"])
        check(f"placement.{expected['uid']}.respawnOverride",
              close(actual["RespawnTimerOverride"], expected["overrides"]["respawnTimerOverride"]))
        check(f"placement.{expected['uid']}.constantShuffle",
              actual["ConstantShuffle"] == expected["overrides"]["constantShuffle"])
        check(f"placement.{expected['uid']}.shuffleTypes",
              actual["ShuffleTypes"]["bits"] == expected["overrides"]["shuffleTypes"]["bits"])
        excluded = [item["refId"] for item in actual["ExcludedPickupTypes"]["items"]]
        check(f"placement.{expected['uid']}.excluded",
              excluded == expected["overrides"]["excludedPickupTypes"])

        # basis vectors
        for axis in ("ax", "ay", "az"):
            vector = matrix[axis]
            check(f"placement.{expected['uid']}.{axis}",
                  [vector["vx"], vector["vy"], vector["vz"]] == expected["basis"][axis])

        p310 = project(path310, position[0], position[2])
        ploop = project(loop01, position[0], position[2])
        stored310 = expected["courseProjection"]["course310m"]
        stored_loop = expected["courseProjection"]["loop01"]
        check(f"placement.{expected['uid']}.project310",
              close(p310["distance"], stored310["distance"])
              and close(p310["arc"], stored310["arc"])
              and close(p310["point"][0], stored310["point"][0])
              and close(p310["point"][1], stored310["point"][1]),
              {"expected": stored310, "actual": p310})
        check(f"placement.{expected['uid']}.projectLoop",
              close(ploop["distance"], stored_loop["distance"])
              and close(ploop["arc"], stored_loop["arc"]),
              {"expected": stored_loop, "actual": ploop})

    # ------------------------------------------------------ course inputs
    check("courseInputs.310.sha256",
          sha256(P48.read_bytes()) == doc["courseInputs"]["course310m"]["sha256"])
    check("courseInputs.loop.sha256",
          sha256(LOOPS.read_bytes()) == doc["courseInputs"]["loop01"]["sha256"])
    check("courseInputs.physics.sha256",
          sha256(LEVEL.read_bytes()) == doc["courseInputs"]["levelphysics"]["sha256"])

    # ------------------------------------------------------ route authority
    route_type = amax.type_index("Route")
    route_record = amax.record_index(route["recordId"])
    check("route.recordType", amax.records[route_record]["typeIndex"] == route_type)
    route_number = amax.read_field_by_name(route_record, route_type, "RouteNumber")
    check("route.routeNumber", route_number == route["routeNumber"],
          {"expected": route["routeNumber"], "actual": route_number})
    city = amax.read_field_by_name(route_record, route_type, "City")
    city_ref = city["refId"] if city else None
    check("route.cityRef", city_ref == route["cityRefId"])
    city_record = amax.record_index(city_ref)
    city_name_raw = amax.read_field_by_name(city_record, amax.type_index("City"), "Name")
    city_name = amax.sz8_value(city_record, city_name_raw)
    check("route.cityName", city_name == route["cityName"], city_name)
    mp_handle = amax.read_field_by_name(route_record, route_type, "MultiplayerActorLists")
    mp_lists = [item["refId"] for item in mp_handle["items"]]
    check("route.multiplayerActorLists", mp_lists == route["multiplayerActorLists"], mp_lists)
    check("route.containsPickupList", list_id in mp_lists)

    # start list proof: the raced route also references a 20-slot StartPosition list.
    start_lists = []
    start_positions = None
    for list_ref in mp_lists:
        record_index = actor.record_index(list_ref)
        counts = {}
        components = {}
        for relative in range(actor.records[record_index]["componentCount"]):
            type_index, element_count, _ = actor.component_meta(record_index, relative)
            counts[actor.types[type_index]["name"]] = element_count
            components[actor.types[type_index]["name"]] = (relative, element_count)
        if counts.get("StartPosition"):
            start_lists.append({"actorListId": list_ref, "startPositions": counts["StartPosition"]})
            if counts["StartPosition"] == 20:
                component, element_count = components["StartPosition"]
                start_positions = []
                for element in range(element_count):
                    value = actor.read_component(record_index, component, element)
                    matrix = value["WorldMatrix"]
                    start_positions.append({
                        "name": actor.sz8_value(record_index, value["Name"]),
                        "startNumber": value["StartNumber"],
                        "position": [matrix["aw"]["vx"], matrix["aw"]["vy"], matrix["aw"]["vz"]],
                    })
    check("route.startList", len(start_lists) == 1 and start_lists[0]["startPositions"] == 20,
          start_lists)
    stored_grid = doc["authority"].get("startGrid")
    check("route.startGrid.present", stored_grid is not None)
    if stored_grid is not None and start_positions is not None:
        check("route.startGrid.actorList", stored_grid["actorListId"] == start_lists[0]["actorListId"])
        check("route.startGrid.count", stored_grid["count"] == len(start_positions) == 20)
        for stored, actual in zip(stored_grid["positions"], start_positions):
            check(f"startGrid.{stored['name']}.name", stored["name"] == actual["name"])
            check(f"startGrid.{stored['name']}.number", stored["startNumber"] == actual["startNumber"])
            check(f"startGrid.{stored['name']}.position", stored["position"] == actual["position"],
                  {"expected": stored["position"], "actual": actual["position"]})
            p = project(loop01, actual["position"][0], actual["position"][2])
            check(f"startGrid.{stored['name']}.loopDistance",
                  close(stored["loop01Distance"], p["distance"]))
        xs = [p["position"][0] for p in start_positions]
        zs = [p["position"][2] for p in start_positions]
        check("route.startGrid.bbox",
              stored_grid["bbox"] == {"x": [min(xs), max(xs)], "z": [min(zs), max(zs)]},
              stored_grid["bbox"])
        check("route.startGrid.loopMin",
              close(stored_grid["loop01DistanceMin"],
                    min(p["loop01Distance"] for p in stored_grid["positions"])))

    # MultiplayerRace route handle and flags.
    race_type = multiplayer.type_index("MultiplayerRace")

    def race_field(record_index, name):
        return multiplayer.read_field_by_name(record_index, race_type, name)

    race_rows = []
    for entry in multiplayer.record_of_type("MultiplayerRace"):
        route_handle = race_field(entry["index"], "route")
        if route_handle and route_handle["refId"] == route["recordId"]:
            race_rows.append({
                "recordId": entry["id"],
                "laps": race_field(entry["index"], "laps"),
                "powerups": race_field(entry["index"], "powerups"),
                "powerupRespawn": race_field(entry["index"], "poweruprespawn"),
                "randomPowerups": race_field(entry["index"], "randompowerups"),
                "minPlayers": race_field(entry["index"], "min_players"),
                "maxPlayers": race_field(entry["index"], "max_players"),
            })
    documented = doc["authority"]["riverMpRaces"]
    check("races.count", len(race_rows) == len(documented) == route["multiplayerRaceCount"],
          {"decoded": len(race_rows), "documented": len(documented)})
    doc_by_id = {r["recordId"]: r for r in documented}
    for row in race_rows:
        stored = doc_by_id.get(row["recordId"])
        check(f"races.{row['recordId']}",
              stored is not None
              and stored["laps"] == row["laps"]
              and stored["powerups"] == row["powerups"]
              and stored["powerupRespawn"] == row["powerupRespawn"]
              and stored["randomPowerups"] == row["randomPowerups"],
              {"decoded": row, "documented": stored})

    # ---------------------------------------------------------- grouping
    alias = doc["rowLabelAliases"]["map"]
    for group in doc["groups"]:
        if group["rowRefId"] is None:
            check(f"group.{group['groupId']}.singleton", group["count"] == 1)
            continue
        allowed = [alias.get(name, name) for name in group["allowedTypes"]]
        check(f"group.{group['groupId']}.set",
              sorted(allowed) == sorted(group["serializedTypes"]) and group["count"] == len(allowed),
              {"allowed": allowed, "serialized": group["serializedTypes"]})
        members = [p for p in placements if p["row"] and p["row"]["shuffleGroup"] == group["groupId"]]
        check(f"group.{group['groupId']}.members", len(members) == group["count"])

    # ------------------------------------------------------- collision probe
    import reference_oracle as ro
    level = ro.load_level(LEVEL.read_bytes())
    triangles = []
    for ordinal in range(ro.total_triangles(level)):
        tri = ro.global_triangle(level, ordinal)
        triangles.append((tri["a"], tri["b"], tri["c"], tri["normal"]))

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

    for expected in placements:
        result = ground(expected["position"]["x"], expected["position"]["z"])
        collision = expected["collision"]
        check(f"collision.{expected['uid']}",
              (result is None) == (collision["groundY"] is None)
              and (result is None or (
                  close(result[0], collision["groundY"])
                  and close(result[1], collision["normalY"]))),
              {"expected": collision, "actual": result})
        check(f"collision.{expected['uid']}.drivable",
              (result is not None and result[1] > 0.94) == collision["drivableSurface"])

    # ----------------------------------------------------- collection model
    collection = doc.get("collectionModel")
    check("collectionModel.present", collection is not None)
    if collection is not None:
        check("collectionModel.activeExtents",
              collection["activeHalfExtentsMetres"] == [1.25, 1.25, 0.25],
              collection["activeHalfExtentsMetres"])
        check("collectionModel.staticExtents",
              collection["halfExtentsMetres"]["static"] == [1.25, 1.25, 0.25])
        check("collectionModel.rotatingExtents",
              collection["halfExtentsMetres"]["rotating"] == [1.25, 1.25, 1.25])
        check("collectionModel.rotateAllFalse",
              collection["rotateGraphicAllFalse"]
              == all(not p["overrides"]["rotateGraphic"] for p in placements),
              collection["rotateGraphicAllFalse"])
        check("collectionModel.pickupRadius", collection["pickupRadiusMetres"] == 2.0)
        check("collectionModel.thresholdNotTrigger",
              "collection trigger itself is the box" in collection["pickupRadiusUse"])

    # ---------------------------------------------------------- summary math
    distances310 = [p["courseProjection"]["course310m"]["distance"] for p in placements]
    distances_loop = [p["courseProjection"]["loop01"]["distance"] for p in placements]
    ca = doc["courseAnalysis"]
    check("summary.310.min", close(min(distances310), ca["course310m"]["minDistance"]))
    check("summary.310.within2", sum(1 for d in distances310 if d <= 2.0) == ca["course310m"]["within2m"])
    check("summary.loop.min", close(min(distances_loop), ca["loop01"]["minDistance"]))
    check("summary.loop.within2", sum(1 for d in distances_loop if d <= 2.0) == ca["loop01"]["within2m"])
    check("summary.counts", doc["counts"]["placements"] == len(placements))
    check("summary.types", doc["counts"]["types"]
          == dict(Counter(p["serializedType"]["name"] for p in placements)),
          doc["counts"]["types"])
    rounded = Counter((round(p["position"]["x"], 3), round(p["position"]["z"], 3))
                      for p in placements)
    duplicates = [list(key) for key, count in rounded.items() if count > 1]
    documented_duplicates = [d["xz"] for d in doc["duplicates"]["exactXZ1mm"]]
    check("summary.duplicates", sorted(duplicates) == sorted(documented_duplicates),
          {"computed": duplicates, "documented": documented_duplicates})

    # ----------------------------------------------------- provisional diff
    provisional = doc["provisionalComparison"]
    artifact = provisional["artifact"]
    check("provisional.on310",
          provisional["diff"]["realPlacementsOn310m"] == ca["course310m"]["withinPickupRadius"])
    check("provisional.onLoop",
          provisional["diff"]["realPlacementsOnLoop01"] == ca["loop01"]["withinPickupRadius"])
    if artifact["status"] == "found":
        provisional_path = ROOT / artifact["path"]
        check("provisional.filePresent", provisional_path.exists())
        if provisional_path.exists():
            text = provisional_path.read_text(encoding="utf-8")
            check("provisional.fileHash", sha256(text.encode("utf-8")) == artifact["sha256"],
                  {"expected": artifact["sha256"], "actual": sha256(text.encode("utf-8"))})
            arc_match = re.search(r"POWERUP_PLACEMENT_ARCS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)", text)
            type_match = re.search(r"POWERUP_PLACEMENT_TYPES\s*=\s*Object\.freeze\(\[([^\]]*)\]\)", text)
            arcs = [float(v) for v in arc_match.group(1).split(",")] if arc_match else None
            arc_types = [v.strip().strip("'\"") for v in type_match.group(1).split(",")] if type_match else None
            check("provisional.arcs", arcs == artifact["arcs"], {"expected": artifact["arcs"], "actual": arcs})
            check("provisional.types", arc_types == artifact["types"],
                  {"expected": artifact["types"], "actual": arc_types})
        # Recompute the nearest-sample positions and the nearest real distance.
        samples = []
        arc = 0.0
        samples.append({"arc": 0.0, "x": path310[0][0], "z": path310[0][1], "index": 0})
        for i in range(1, len(path310)):
            arc += math.hypot(path310[i][0] - path310[i - 1][0],
                              path310[i][1] - path310[i - 1][1])
            samples.append({"arc": round(arc, 6), "x": path310[i][0],
                            "z": path310[i][1], "index": i})
        for index, stored in enumerate(provisional["slots"]):
            sample = min(samples, key=lambda s: (abs(s["arc"] - stored["arcRequested"]), s["index"]))
            check(f"provisional.slot{index}.arc", close(sample["arc"], stored["arc"]))
            check(f"provisional.slot{index}.position",
                  close(sample["x"], stored["x"]) and close(sample["z"], stored["z"]),
                  {"expected": [stored["x"], stored["z"]], "actual": [sample["x"], sample["z"]]})
            best = min(math.hypot(sample["x"] - p["position"]["x"],
                                  sample["z"] - p["position"]["z"]) for p in placements)
            check(f"provisional.slot{index}.nearest", close(best, stored["nearestRealDistance"]))
            check(f"provisional.slot{index}.covered",
                  (best <= PICKUP_RADIUS) == stored["coveredWithin2m"])
        covered = sum(1 for slot in provisional["slots"] if slot["coveredWithin2m"])
        check("provisional.diff.coverage",
              provisional["diff"]["provisionalSlotsCoveredByRealWithin2m"] == covered)
        real_covered = 0
        for placement in placements:
            nearest = min(math.hypot(slot["x"] - placement["position"]["x"],
                                     slot["z"] - placement["position"]["z"])
                          for slot in provisional["slots"])
            if nearest <= PICKUP_RADIUS:
                real_covered += 1
        check("provisional.diff.realCovered",
              provisional["diff"]["realPlacementsCoveredByProvisionalWithin2m"] == real_covered)

    # --------------------------------------------------------------- hashes
    canonical_doc = {key: value for key, value in doc.items() if key != "hashes"}
    canonical = json.dumps(canonical_doc, sort_keys=True, separators=(",", ":"), allow_nan=False)
    check("hashes.canonical", sha256(canonical.encode("utf-8")) == doc["hashes"]["canonicalSha256"],
          {"expected": doc["hashes"]["canonicalSha256"],
           "actual": sha256(canonical.encode("utf-8"))})
    file_hash = sha256(DOC.read_bytes())

    result = {
        "kind": "powerups.pickup-placement.verify",
        "version": 1,
        "document": str(DOC.relative_to(ROOT)),
        "documentFileSha256": file_hash,
        "documentCanonicalSha256": doc["hashes"]["canonicalSha256"],
        "checks": len(CHECKS),
        "passed": sum(1 for c in CHECKS if c["ok"]),
        "failed": len(FAILURES),
        "status": "PASS" if not FAILURES else "FAIL",
        "failures": FAILURES,
        "details": CHECKS,
    }
    OUT.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in
                      ("status", "checks", "passed", "failed", "documentFileSha256",
                       "documentCanonicalSha256")}, indent=2))
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    raise SystemExit(main())
