"""Index every raced route that ships a PickupPosition actor list (read-only).

This is a discovery aid, not a recovered manifest. It walks `amax.bin` +
`multiplayer.bin`, keeps routes referenced by a `racing` MultiplayerRace,
matches the city to a level `actorpack.xt` in `gamedata.pak`, and counts the
`PickupPosition` elements in that route's `MultiplayerActorLists`.

Run the generalized extractor for a level to get the verified placement
manifest:

    python probes/powerups/tools/extract_pickup_placement_levels.py --level <level>

Output: `_work/powerups/placement-route-index.json`.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import zlib
from collections import Counter, OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "powerups" / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402
import xt_decode  # noqa: E402

PACK = ROOT / "game-data/Blur/cache/gamedata.pak"
OUT = ROOT / "_work/powerups/placement-route-index.json"


def normalize(value):
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def decode(entry):
    with PACK.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    return zlib.decompressobj().decompress(packed, entry["logical_bytes"] + 1)


def components(flask, record_index):
    start = flask._component_start[record_index]
    count = flask.records[record_index][1]
    return [(relative, flask.type_name(type_index), element_count)
            for relative, (type_index, element_count, behaviour)
            in enumerate(flask.components[start:start + count])]


def main() -> int:
    index = pak_index(PACK)
    entries = {row["path"]: row for row in index["entries"]}
    amax = xt_decode.Flask(decode(entries["\\gamedata\\xt\\amax.bin"]))
    multiplayer = xt_decode.Flask(decode(entries["\\gamedata\\xt\\multiplayer.bin"]))

    level_entries = {}
    for path, entry in entries.items():
        match = re.match(r"\\gamedata\\levels\\([^\\]+)\\actorpack\.xt$", path, re.I)
        if match:
            level_entries[normalize(match.group(1))] = (match.group(1), entry)

    routes = OrderedDict()
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
        def ids(name):
            field = record.get(name)
            if not isinstance(field, dict):
                return []
            return [item.get("refId") if isinstance(item, dict) else item
                    for item in field.get("items", [])]
        routes[amax.record_id(ri)] = {
            "recordId": amax.record_id(ri),
            "routeNumber": record.get("RouteNumber"),
            "cityName": city_name,
            "multiplayerActorLists": ids("MultiplayerActorLists"),
            "races": [],
        }

    race_type = next(i for i in range(len(multiplayer.types)) if multiplayer.type_name(i) == "MultiplayerRace")
    for ri in range(len(multiplayer.records)):
        if multiplayer.record_type(ri) != race_type:
            continue
        record = multiplayer.decode_record(ri)
        route = record.get("route")
        route_id = route.get("refId") if isinstance(route, dict) else None
        race_type_field = record.get("type")
        label = race_type_field.get("label") if isinstance(race_type_field, dict) else race_type_field
        if route_id in routes:
            routes[route_id]["races"].append(label)

    out = []
    for route in routes.values():
        racing = sum(1 for label in route["races"] if label == "racing")
        if not racing:
            continue
        city_key = normalize(route["cityName"])
        level = level_entries.get(city_key)
        entry = {"recordId": route["recordId"], "routeNumber": route["routeNumber"],
                 "cityName": route["cityName"], "racingRaceCount": racing,
                 "multiplayerRaceCount": len(route["races"])}
        if not level:
            entry.update({"level": None, "status": "no-level-actorpack"})
            out.append(entry)
            continue
        level_id, pak_entry = level
        actorpack = xt_decode.Flask(decode(pak_entry))
        lists = []
        for list_id in route["multiplayerActorLists"]:
            record_index = next((ri for ri in range(len(actorpack.records))
                                 if actorpack.record_id(ri) == list_id), None)
            if record_index is None:
                continue
            elements = sum(count for _, name, count in components(actorpack, record_index)
                           if name == "PickupPosition")
            if elements:
                lists.append({"actorListId": list_id, "record": record_index,
                              "placements": elements})
        entry.update({
            "level": level_id,
            "actorpack": {
                "path": pak_entry["path"],
                "sha256": hashlib.sha256(decode(pak_entry)).hexdigest(),
            },
            "pickupActorLists": lists,
            "status": "has-placements" if lists else "no-pickup-list",
        })
        out.append(entry)

    doc = {
        "kind": "powerups.pickup-route-index",
        "version": 1,
        "date": "2026-11-07",
        "owner": "PWR5",
        "scope": "discovery index only; run extract_pickup_placement_levels.py per level for a verified manifest",
        "sources": {
            "amax": {"path": "\\gamedata\\xt\\amax.bin",
                     "sha256": hashlib.sha256(decode(entries["\\gamedata\\xt\\amax.bin"])).hexdigest()},
            "multiplayer": {"path": "\\gamedata\\xt\\multiplayer.bin",
                            "sha256": hashlib.sha256(decode(entries["\\gamedata\\xt\\multiplayer.bin"])).hexdigest()},
        },
        "summary": {
            "racedRoutes": len(out),
            "withPlacements": sum(1 for row in out if row["status"] == "has-placements"),
            "placements": sum(sum(item["placements"] for item in row["pickupActorLists"])
                              for row in out if row["status"] == "has-placements"),
            "byCity": dict(Counter(row["cityName"] for row in out if row["status"] == "has-placements")),
        },
        "routes": out,
    }
    canonical = json.dumps(doc, sort_keys=True, separators=(",", ":"), allow_nan=False)
    doc["hashes"] = {"canonicalSha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest()}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
                   encoding="utf-8")
    print(json.dumps({"output": str(OUT.relative_to(ROOT)), **doc["summary"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
