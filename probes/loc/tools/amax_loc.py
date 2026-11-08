"""Resolve Amax records that carry localization ids.

Reads (never writes) `\\gamedata\\xt\\amax.bin` with the committed generic XT
helpers used elsewhere in the repository:

* `engine/harness/t005d-vehicle/car_xt.py` — type/leaf/record traversal,
* `probes/vehicle-pipeline/tools/audit_c_aliases.py` — pak extraction + `_sz8`.

The 62 car physics records in `_work/vehicle-pipeline/cars.json` are mapped to
their `AmaxVehicle` wrapper by an explicit, checked rule:

1. a provable C alias (`c-aliases.json` `identity.amaxTag`), else
2. the exact body model stem (`AmaxVehicle` tag == `\\models\\vehicles\\<tag>.model`),
3. the resulting `AmaxVehicle.dynamics` record id must equal the car record id.

`DefaultCar` (record 8) has no model and no AmaxVehicle wrapper; it is returned
as a typed unresolved entry rather than being given an invented name.
"""

from __future__ import annotations

import struct
from pathlib import Path

from audit_c_aliases import _record_name, _sz8, leaves_offset, load_xt
from car_xt import leaves

AMAX_PATH = "\\gamedata\\xt\\amax.bin"
TYPE_VEHICLE = "AmaxVehicle"
TYPE_MANUFACTURER = "AmaxManufacturer"
TYPE_CITY = "City"
TYPE_ROUTE = "Route"
ROUTE_HANDLE = "City"
ROUTE_NUMBER = "RouteNumber"


def _refs(xt, data):
    table = xt["tables"]["refs"]
    return [struct.unpack_from("<I2H", data, table["offset"] + index * table["units"])
            for index in range(table["count"])]


def _u32(data, at):
    return struct.unpack_from("<I", data, at)[0]


def collect(amax_bin: Path = None):
    import audit_c_aliases as aliases

    bin_path = amax_bin or aliases.AMAX_BIN
    xt, data = load_xt(bin_path, AMAX_PATH)
    type_index = {row["name"]: row["index"] for row in xt["types"]}
    records = {row["id"]: row for row in xt["records"] if row["id"] != 0xFFFFFFFF}
    refs = _refs(xt, data)
    loc_offset = leaves_offset(xt, "AmaxGameDataObject", "LocString")

    def base_loc(record):
        loc_id = _u32(data, record["dataOffset"] + loc_offset)
        return loc_id

    def ref_name(handle, type_name):
        if handle == 0xFFFFFFFF or handle >= len(refs):
            return None
        record_id, type_id, _ = refs[handle]
        target = records.get(record_id)
        if target is None or xt["types"][type_id]["name"] != type_name:
            return None
        return _record_name(xt, data, target)

    vehicles = []
    vehicle_type = type_index[TYPE_VEHICLE]
    vehicle_leaves = {leaf["name"]: leaf for leaf in leaves(xt, vehicle_type)}
    for record in xt["records"]:
        if record["type"] != vehicle_type:
            continue
        loc_id = base_loc(record)
        full_id = _u32(data, record["dataOffset"] + vehicle_leaves["locStringFull"]["offset"])
        dynamics_handle = _u32(
            data, record["dataOffset"] + vehicle_leaves["dynamics"]["offset"])
        dynamics_id = None
        if dynamics_handle != 0xFFFFFFFF and dynamics_handle < len(refs):
            dynamics_id = refs[dynamics_handle][0]
        vehicles.append({
            "tag": _record_name(xt, data, record),
            "recordId": record["id"],
            "dynamicsId": dynamics_id,
            "locId": loc_id,
            "fullLocId": full_id,
            "manufacturer": ref_name(
                _u32(data, record["dataOffset"] + vehicle_leaves["Manufacturer"]["offset"]),
                TYPE_MANUFACTURER),
            "iconTag": _sz8(xt, data, record, vehicle_leaves["UiIconName"]["offset"]),
        })

    manufacturers = []
    manufacturer_type = type_index[TYPE_MANUFACTURER]
    manufacturer_leaves = {leaf["name"]: leaf for leaf in leaves(xt, manufacturer_type)}
    for record in xt["records"]:
        if record["type"] != manufacturer_type:
            continue
        manufacturers.append({
            "tag": _record_name(xt, data, record),
            "recordId": record["id"],
            "locId": base_loc(record),
            "uiTexture": _sz8(
                xt, data, record, manufacturer_leaves["UiTexture"]["offset"]),
        })

    cities = []
    city_type = type_index[TYPE_CITY]
    for record in xt["records"]:
        if record["type"] != city_type:
            continue
        cities.append({
            "name": _record_name(xt, data, record),
            "recordId": record["id"],
            "locId": base_loc(record),
        })

    routes = []
    route_type = type_index[TYPE_ROUTE]
    route_leaves = {leaf["name"]: leaf for leaf in leaves(xt, route_type)}
    for record in xt["records"]:
        if record["type"] != route_type:
            continue
        routes.append({
            "name": _record_name(xt, data, record),
            "recordId": record["id"],
            "locId": base_loc(record),
            "city": ref_name(
                _u32(data, record["dataOffset"] + route_leaves[ROUTE_HANDLE]["offset"]),
                TYPE_CITY),
            "routeNumber": _u32(
                data, record["dataOffset"] + route_leaves[ROUTE_NUMBER]["offset"]),
        })

    return {
        "sha256": __import__("hashlib").sha256(data).hexdigest(),
        "bytes": len(data),
        "locOffset": loc_offset,
        "vehicles": vehicles,
        "manufacturers": manufacturers,
        "cities": cities,
        "routes": routes,
    }


def resolve_cars(cars: dict, c_aliases: dict, amax: dict) -> dict:
    """Map each of the 62 physics records to its AmaxVehicle name source."""
    by_tag = {row["tag"].lower(): row for row in amax["vehicles"]}
    c_by_index = {row["index"]: row for row in c_aliases["records"]}
    mapped, unresolved = [], []
    for car in cars["records"]:
        index = car["index"]
        alias = c_by_index.get(index)
        tag = None
        source = None
        if alias and alias.get("identity"):
            tag = alias["identity"]["amaxTag"]
            source = "c-alias"
        if not tag and car["model"].get("pakPath"):
            tag = Path(car["model"]["pakPath"].replace("\\", "/")).stem
            source = "body-model-stem"
        hit = by_tag.get((tag or "").lower())
        if hit is not None:
            if hit["dynamicsId"] != car["id"]:
                raise ValueError(
                    f"record {index} {car['name']}: AmaxVehicle {hit['tag']} dynamics "
                    f"{hit['dynamicsId']} != {car['id']}")
            row = {
                "index": index, "recordId": car["id"], "name": car["name"],
                "slug": car["slug"], "class": car["class"],
                "amaxTag": hit["tag"], "tagSource": source,
                "locId": hit["locId"], "fullLocId": hit["fullLocId"],
                "manufacturer": hit["manufacturer"],
            }
            mapped.append(row)
            continue
        # No tag. Accept a unique dynamics match only when it is unambiguous.
        candidates = [row for row in amax["vehicles"] if row["dynamicsId"] == car["id"]]
        if len(candidates) == 1:
            hit = candidates[0]
            mapped.append({
                "index": index, "recordId": car["id"], "name": car["name"],
                "slug": car["slug"], "class": car["class"],
                "amaxTag": hit["tag"], "tagSource": "unique-dynamics-id",
                "locId": hit["locId"], "fullLocId": hit["fullLocId"],
                "manufacturer": hit["manufacturer"],
            })
            continue
        unresolved.append({
            "index": index, "recordId": car["id"], "name": car["name"],
            "slug": car["slug"], "class": car["class"],
            "reason": "no AmaxVehicle tag, no exact model stem, and no unique dynamics match",
            "candidateDynamicsMatches": [row["tag"] for row in candidates],
        })
    return {"mapped": mapped, "unresolved": unresolved}
