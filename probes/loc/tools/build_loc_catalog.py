"""Build the shipped-locale string catalog for the Blur Web shell.

Inputs (read-only):

* `game-data/Blur/cache/gamedata.pak` — all 23 `\\gamedata\\xt\\loc\\*.loc` files,
* `game-data/Blur/cache/gamedata.pak` `\\gamedata\\xt\\amax.bin` — AmaxVehicle /
  AmaxManufacturer / City / Route localization ids,
* `_work/vehicle-pipeline/cars.json` and `c-aliases.json` — the 62 physics records
  and the 15 class-C alias proofs,
* `_work/powerups/powerups.json` — `ui.bin` `UiPerkInfo` loc ids per pickup.

Outputs (never committed):

* `_work/loc/strings.json` — canonical `{locale: {key: [strings]}}` + provenance + hashes,
* `_work/loc/inventory.json` — per-file format/record/locale inventory,
* `_work/loc/locales/<code>.json` — one file per locale, keys `"<file>:<KEY>"`,
* `_work/loc/shell/<code>.json` — required shell slots, fallback already applied,
* `_work/loc/slots.json`, `_work/loc/coverage.json`, `_work/loc/index.json`.

No string is translated, trimmed, normalized or invented.  Locale values are
copied byte-for-byte after strict UTF-16LE decoding.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
for path in (ROOT / "tools", ROOT / "engine/harness/t005d-vehicle",
             ROOT / "probes/vehicle-pipeline/tools", ROOT / "probes/loc/tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import amax_loc  # noqa: E402
import olt  # noqa: E402
import required_keys  # noqa: E402
from inspect_asset_layout import pak_index  # noqa: E402

PAK = ROOT / "game-data/Blur/cache/gamedata.pak"
CARS = ROOT / "_work/vehicle-pipeline/cars.json"
C_ALIASES = ROOT / "_work/vehicle-pipeline/c-aliases.json"
POWERUPS = ROOT / "_work/powerups/powerups.json"
LEVELS = ROOT / "game-data/Blur/levels"
OUT = ROOT / "_work/loc"
DEFAULT_LOCALE = "en"


class BuildError(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def canonical(document) -> bytes:
    return (json.dumps(document, indent=1, sort_keys=True, ensure_ascii=False)
            + "\n").encode("utf-8")


def basename(pak_path: str) -> str:
    return pak_path.replace("\\", "/").rsplit("/", 1)[-1]


def normalize_manufacturer(tag: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", tag.upper())


def load_loc_files():
    index = pak_index(PAK)
    rows = sorted((row for row in index["entries"]
                   if row["path"].lower().endswith(".loc")),
                  key=lambda row: row["path"])
    files = {}
    order = []
    for row in rows:
        raw = olt.read_pak_entry(PAK, row["path"])
        loc = olt.read_olt(raw, row["path"])
        name = basename(row["path"])
        if name in files:
            raise BuildError(f"duplicate loc basename {name}")
        files[name] = {"loc": loc, "entry": row, "raw": raw}
        order.append(name)
    return files, order, index


def build_inventory(files, order):
    rows = []
    for name in order:
        loc = files[name]["loc"]
        raw = files[name]["raw"]
        entry = files[name]["entry"]
        locales = []
        for locale in loc.locales:
            empty = sum(1 for value in locale.values.values() if value == "")
            locales.append({
                "code": locale.code,
                "offset": locale.offset,
                "size": locale.size,
                "values": len(locale.values),
                "emptyValues": empty,
            })
        rows.append({
            "file": name,
            "pakPath": entry["path"],
            "pakOffset": entry["offset"],
            "storedBytes": entry["stored_bytes"],
            "logicalBytes": entry["logical_bytes"],
            "sha256": sha256_bytes(raw),
            "magic": "OLTX",
            "version": loc.version,
            "offsetBase": loc.offset_base,
            "localeAreaOffset": loc.offset_base + loc.locale_area_rel,
            "keyTableOffset": loc.key_table_offset,
            "recordCount": len(loc.keys),
            "locales": locales,
            "encoding": "UTF-16LE, NUL-terminated per value",
        })
    return {
        "format": "OLTX v1",
        "source": "game-data/Blur/cache/gamedata.pak",
        "sourceCodec": "zlib (gamedata.pak codec 2)",
        "files": rows,
        "counts": {
            "files": len(rows),
            "keys": sum(row["recordCount"] for row in rows),
            "locales": [locale.code for locale in files[order[0]]["loc"].locales],
        },
        "headerNotes": [
            "0x08 = 16 in every file; offsets at 0x0c and 0x18 are relative to it.",
            "0x10 = 12 in every file; the locale table begins at 0x10 + this value (0x1c).",
            "0x14 = locale count (5 in every shipped file).",
            "Locale record = 24 bytes: code[4] (2 ASCII letters + NUL NUL), 12 zero "
            "bytes, uint32 blob offset, uint32 blob size.",
            "Key table = uint32 count, uint32 stride (8), count x (uint32 LocId, "
            "uint32 name offset relative to the table).",
            "Locale blob = uint32 count, uint32 stride (8), count x (uint32 LocId, "
            "uint32 value offset relative to the blob), then UTF-16LE values.",
            "LocId is the 32-bit table hash; the hash function is not derived and is "
            "never recomputed. The table is authoritative.",
        ],
    }


def assemble_strings(files, order, locales):
    strings = {code: {} for code in locales}
    provenance = {code: {} for code in locales}
    key_files = {}
    for name in order:
        loc = files[name]["loc"]
        for loc_id, key in loc.keys:
            key_files.setdefault(key, []).append(name)
            for locale in loc.locales:
                text = locale.values[loc_id]
                strings[locale.code].setdefault(key, []).append(text)
                provenance[locale.code].setdefault(key, []).append({
                    "file": name,
                    "offset": locale.value_offsets[loc_id],
                    "locId": f"{loc_id:08x}",
                    "keyOffset": loc.key_offsets[loc_id],
                })
    return strings, provenance, key_files


def loc_value(files, file, key, code):
    loc = files[file]["loc"]
    locale = next(item for item in loc.locales if item.code == code)
    return locale.values[loc.hash_by_key[key]]


def slot_from_triple(entry, files, locales):
    slot, file, key = entry
    loc = files[file]["loc"]
    by_key = loc.hash_by_key
    if key not in by_key:
        raise BuildError(f"{slot}: {file}:{key} does not exist")
    loc_id = by_key[key]
    return {
        "slot": slot,
        "status": "resolved",
        "file": file,
        "key": key,
        "locId": f"{loc_id:08x}",
        "values": {code: loc_value(files, file, key, code) for code in locales},
    }


def missing_slot(slot, reason, category):
    return {"slot": slot, "status": "missing", "reason": reason, "category": category}


def build_slots(files, strings, locales, amax, cars, aliases, powerups):
    slots = []
    # --- static curated triples
    for category, triples in (
        ("menu", required_keys.MENU),
        ("hud", required_keys.HUD),
        ("results", required_keys.RESULTS),
        ("countdown", required_keys.COUNTDOWN),
        ("modes", required_keys.MODES),
        ("errors", required_keys.ERRORS),
    ):
        for entry in triples:
            row = slot_from_triple(entry, files, locales)
            row["category"] = category
            slots.append(row)

    # --- vehicles
    vehicle_loc = files["vehicles.loc"]["loc"]
    vehicle_key_by_id = vehicle_loc.key_by_hash
    car_doc = amax_loc.resolve_cars(cars, aliases, amax)
    manufacturer_keys = {}
    for manufacturer in amax["manufacturers"]:
        key = f"VEH_MAN_{normalize_manufacturer(manufacturer['tag'])}"
        if key not in vehicle_loc.hash_by_key:
            raise BuildError(
                f"manufacturer {manufacturer['tag']}: expected {key} in vehicles.loc")
        manufacturer_keys[manufacturer["tag"]] = key
        slots.append({
            "slot": f"manufacturer.{normalize_manufacturer(manufacturer['tag']).lower()}",
            "category": "manufacturer",
            "status": "resolved",
            "file": "vehicles.loc",
            "key": key,
            "locId": f"{vehicle_loc.hash_by_key[key]:08x}",
            "values": {code: loc_value(files, "vehicles.loc", key, code)
                       for code in locales},
        })
    for car in car_doc["mapped"]:
        display_id = car["fullLocId"] or car["locId"]
        display_key = vehicle_key_by_id.get(display_id)
        if display_key is None:
            raise BuildError(
                f"record {car['index']}: LocId {display_id:08x} does not resolve")
        slots.append({
            "slot": f"vehicle.{car['index']}.name",
            "category": "vehicle",
            "status": "resolved",
            "file": "vehicles.loc",
            "key": display_key,
            "locId": f"{display_id:08x}",
            "amaxTag": car["amaxTag"],
            "tagSource": car["tagSource"],
            "values": {code: loc_value(files, "vehicles.loc", display_key, code)
                       for code in locales},
        })
        manufacturer = car["manufacturer"]
        if not manufacturer:
            slots.append(missing_slot(
                f"vehicle.{car['index']}.manufacturer",
                "AmaxVehicle.Manufacturer is null for this record", "vehicle"))
        else:
            key = manufacturer_keys[manufacturer]
            slots.append({
                "slot": f"vehicle.{car['index']}.manufacturer",
                "category": "vehicle",
                "status": "resolved",
                "file": "vehicles.loc",
                "key": key,
                "locId": f"{vehicle_loc.hash_by_key[key]:08x}",
                "manufacturer": manufacturer,
                "values": {code: loc_value(files, "vehicles.loc", key, code)
                           for code in locales},
            })
    for car in car_doc["unresolved"]:
        slots.append(missing_slot(
            f"vehicle.{car['index']}.name",
            f"{car['reason']} (record {car['name']})", "vehicle"))
        slots.append(missing_slot(
            f"vehicle.{car['index']}.manufacturer",
            f"{car['reason']} (record {car['name']})", "vehicle"))

    # --- levels: City.Name lowercased is the level directory (proved for all 19)
    crn = files["cityandroutenames.loc"]["loc"]
    crn_key_by_id = crn.key_by_hash
    city_by_name = {row["name"]: row for row in amax["cities"]}
    routes_by_city = {}
    for route in amax["routes"]:
        routes_by_city.setdefault(route["city"], []).append(route)
    level_dirs = sorted(path.name for path in LEVELS.iterdir() if path.is_dir())
    if len(level_dirs) != 19:
        raise BuildError(f"expected 19 level directories, found {len(level_dirs)}")
    for level in level_dirs:
        city = next((row for name, row in city_by_name.items()
                     if name.lower() == level), None)
        if city is None:
            raise BuildError(f"level {level}: no City record with that name")
        city_key = crn_key_by_id.get(city["locId"])
        if city_key is None:
            raise BuildError(f"level {level}: city LocId does not resolve")
        slots.append({
            "slot": f"level.{level}.name",
            "category": "level",
            "status": "resolved",
            "file": "cityandroutenames.loc",
            "key": city_key,
            "locId": f"{city['locId']:08x}",
            "cityRecord": city["name"],
            "values": {code: loc_value(files, "cityandroutenames.loc", city_key, code)
                       for code in locales},
        })
        for route in sorted(routes_by_city.get(city["name"], []),
                            key=lambda row: (row["routeNumber"], row["name"])):
            route_key = crn_key_by_id.get(route["locId"])
            if route_key is None:
                raise BuildError(f"level {level}: route LocId does not resolve")
            suffix = re.sub(r"[^a-z0-9]+", "-", route["name"].lower()).strip("-")
            slots.append({
                "slot": f"level.{level}.variant.{suffix}",
                "category": "level-variant",
                "status": "resolved",
                "file": "cityandroutenames.loc",
                "key": route_key,
                "locId": f"{route['locId']:08x}",
                "routeRecord": route["name"],
                "routeNumber": route["routeNumber"],
                "values": {code: loc_value(files, "cityandroutenames.loc",
                                           route_key, code) for code in locales},
            })

    # --- power-ups
    labels = ["Barge", "Nitrous", "Shock", "Shunt", "Blindfire", "Bomb", "Repair",
              "Fan", "Shield", "Stopwatch", "SuperShield"]
    common = files["common.loc"]["loc"]
    hud = files["hud.loc"]["loc"]
    ui_by_label = {}
    for entity in powerups["entities"]:
        label = entity.get("pickupLabel")
        entries = (entity.get("hud") or {}).get("entries") or {}
        if label and entries:
            ui_by_label[label] = next(iter(entries.values()))
    for label in labels:
        if label in required_keys.POWERUP_NAMES:
            file, key = required_keys.POWERUP_NAMES[label]
            slots.append({
                "slot": f"powerup.{label}.name",
                "category": "powerup",
                "status": "resolved",
                "file": file,
                "key": key,
                "locId": f"{files[file]['loc'].hash_by_key[key]:08x}",
                "binding": "PIK_/CMN_ short name",
                "values": {code: loc_value(files, file, key, code)
                           for code in locales},
            })
        else:
            slots.append(missing_slot(
                f"powerup.{label}.name",
                "no PIK_/CMN_ key exists for this pickup; ui.bin has no UiPerkInfo "
                "entry for it", "powerup"))
        ui = ui_by_label.get(label)
        if ui and ui.get("loc_id_name"):
            loc_id = int(ui["loc_id_name"]["id"], 16)
            key = common.key_by_hash.get(loc_id)
            if key is None:
                slots.append(missing_slot(
                    f"powerup.{label}.hud_name",
                    f"ui.bin LocId {loc_id:08x} does not resolve in common.loc", "powerup"))
            else:
                slots.append({
                    "slot": f"powerup.{label}.hud_name",
                    "category": "powerup",
                    "status": "resolved",
                    "file": "common.loc",
                    "key": key,
                    "locId": f"{loc_id:08x}",
                    "binding": "ui.bin UiPerkInfo.loc_id_name",
                    "values": {code: loc_value(files, "common.loc", key, code)
                               for code in locales},
                })
        else:
            slots.append(missing_slot(
                f"powerup.{label}.hud_name",
                "no ui.bin UiPerkInfo entry for this pickup", "powerup"))
        hit = next((row for row in required_keys.POWERUP_HITS
                    if row[0].lower() == label.lower()), None)
        if hit:
            _, file, key = hit
            slots.append({
                "slot": f"powerup.{label}.hit",
                "category": "powerup",
                "status": "resolved",
                "file": file,
                "key": key,
                "locId": f"{files[file]['loc'].hash_by_key[key]:08x}",
                "binding": "ui.bin UiPerkInfo.past_loc_id_name",
                "values": {code: loc_value(files, file, key, code)
                           for code in locales},
            })
        else:
            slots.append(missing_slot(
                f"powerup.{label}.hit",
                "no HUD_PT_* hit label for this pickup", "powerup"))
        tip = required_keys.POWERUP_TIPS.get(label)
        if tip:
            slots.append({
                "slot": f"powerup.{label}.description",
                "category": "powerup",
                "status": "resolved",
                "file": "multiplayerhelptips.loc",
                "key": tip,
                "locId": f"{files['multiplayerhelptips.loc']['loc'].hash_by_key[tip]:08x}",
                "binding": "prose-name-mention",
                "values": {code: loc_value(files, "multiplayerhelptips.loc", tip, code)
                           for code in locales},
            })
        else:
            slots.append(missing_slot(
                f"powerup.{label}.description",
                "no per-pickup description field or prose tip names this pickup",
                "powerup"))
    return slots, car_doc


def locale_document(code, files, order):
    qualified = {}
    for name in order:
        loc = files[name]["loc"]
        locale = next(item for item in loc.locales if item.code == code)
        for loc_id, key in loc.keys:
            qualified[f"{name}:{key}"] = locale.values[loc_id]
    return qualified


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    out = args.out
    for needed in (CARS, C_ALIASES, POWERUPS):
        if not needed.exists():
            raise BuildError(f"missing required input {needed}")
    cars = json.loads(CARS.read_text(encoding="utf-8"))
    aliases = json.loads(C_ALIASES.read_text(encoding="utf-8"))
    powerups = json.loads(POWERUPS.read_text(encoding="utf-8"))

    files, order, pak = load_loc_files()
    locales = [locale.code for locale in files[order[0]]["loc"].locales]
    for name in order:
        codes = [locale.code for locale in files[name]["loc"].locales]
        if codes != locales:
            raise BuildError(f"{name}: locale list {codes} != {locales}")
    if DEFAULT_LOCALE not in locales:
        raise BuildError("en locale is absent")

    amax = amax_loc.collect()
    inventory = build_inventory(files, order)
    strings, provenance, key_files = assemble_strings(files, order, locales)
    slots, car_doc = build_slots(files, strings, locales, amax, cars, aliases, powerups)

    # --- per-locale canonical documents and hashes
    locale_docs = {}
    for code in locales:
        locale_docs[code] = {
            "locale": code,
            "encoding": "UTF-16LE source, emitted as UTF-8 JSON",
            "strings": locale_document(code, files, order),
        }
    locale_hashes = {code: sha256_bytes(canonical(strings[code]))
                     for code in locales}

    # --- shell subset with deterministic fallback (requested -> en -> null)
    shell_docs = {}
    coverage = {}
    for code in locales:
        values = {}
        missing = {}
        for row in slots:
            slot = row["slot"]
            if row["status"] == "missing":
                values[slot] = None
                missing[slot] = row["reason"]
                continue
            value = row["values"].get(code)
            if (value is None or value == "") and code != DEFAULT_LOCALE:
                fallback = row["values"].get(DEFAULT_LOCALE)
                if fallback:
                    value = fallback
            values[slot] = value
            if value is None or value == "":
                missing[slot] = ("empty value in locale and in the en fallback"
                                 if value == "" else "no value")
        shell_docs[code] = {
            "locale": code,
            "fallbackLocale": DEFAULT_LOCALE,
            "strings": values,
            "missing": missing,
        }
        resolved = sum(1 for row in slots if row["status"] == "resolved"
                       and values[row["slot"]] not in (None, ""))
        coverage[code] = {
            "locale": code,
            "slots": len(slots),
            "resolved": resolved,
            "missing": len(missing),
            "empty": sum(1 for value in values.values() if value == ""),
            "missingSlots": sorted(missing),
        }

    # --- strings.json (canonical, requested shape: locale at top level)
    catalog = {
        "_meta": {
            "formatVersion": 1,
            "generatedBy": "probes/loc/tools/build_loc_catalog.py",
            "kind": "blur.shipped-loc-catalog",
            "sources": {
                "gamedataPak": {"path": "game-data/Blur/cache/gamedata.pak",
                                "sha256": sha256_file(PAK)},
                "amax": {"path": amax_loc.AMAX_PATH, "sha256": amax["sha256"],
                         "bytes": amax["bytes"]},
                "cars": {"path": str(CARS.relative_to(ROOT)).replace("\\", "/"),
                         "sha256": sha256_file(CARS)},
                "cAliases": {"path": str(C_ALIASES.relative_to(ROOT)).replace("\\", "/"),
                             "sha256": sha256_file(C_ALIASES)},
                "powerups": {"path": str(POWERUPS.relative_to(ROOT)).replace("\\", "/"),
                             "sha256": sha256_file(POWERUPS)},
            },
            "counts": {
                "files": len(order),
                "keys": sum(len(files[name]["loc"].keys) for name in order),
                "uniqueKeyNames": len(key_files),
                "duplicateKeyNames": sorted(key for key, rows in key_files.items()
                                            if len(rows) > 1),
                "locales": len(locales),
                "slots": len(slots),
                "slotsResolved": sum(1 for row in slots if row["status"] == "resolved"),
                "slotsMissing": sum(1 for row in slots if row["status"] == "missing"),
            },
            "limits": [
                "Values are copied from the shipped tables; nothing is translated, "
                "trimmed or normalized.",
                "LocIds are table hashes. The hash function was not derived; ids are "
                "always read from the table.",
                "Empty strings are shipped data and are preserved, not filled.",
                "Four key names exist in two files with different values; the catalog "
                "keeps both values and both provenance rows.",
            ],
        },
        "_provenance": provenance,
        "_hashes": locale_hashes,
    }
    for code in locales:
        catalog[code] = strings[code]

    out.mkdir(parents=True, exist_ok=True)
    (out / "locales").mkdir(exist_ok=True)
    (out / "shell").mkdir(exist_ok=True)

    def write(path: Path, document):
        data = canonical(document)
        path.write_bytes(data)
        return {"path": path.relative_to(ROOT).as_posix(), "bytes": len(data),
                "sha256": sha256_bytes(data)}

    written = {"strings": write(out / "strings.json", catalog)}
    written["inventory"] = write(out / "inventory.json", inventory)
    for code in locales:
        written[f"locale.{code}"] = write(out / "locales" / f"{code}.json", locale_docs[code])
        written[f"shell.{code}"] = write(out / "shell" / f"{code}.json", shell_docs[code])
    # The catalog hash covers the `{key: [values]}` payload; the per-locale file
    # hash covers the whole document (locale + encoding + strings).
    for code in locales:
        written[f"locale.{code}"]["payloadSha256"] = locale_hashes[code]

    slot_document = {
        "slots": slots,
        "counts": {
            "total": len(slots),
            "resolved": sum(1 for row in slots if row["status"] == "resolved"),
            "missing": sum(1 for row in slots if row["status"] == "missing"),
            "byCategory": {
                category: {
                    "total": sum(1 for row in slots if row["category"] == category),
                    "resolved": sum(1 for row in slots
                                    if row["category"] == category
                                    and row["status"] == "resolved"),
                }
                for category in sorted({row["category"] for row in slots})
            },
        },
        "vehicles": {
            "records": len(cars["records"]),
            "mapped": len(car_doc["mapped"]),
            "unresolved": car_doc["unresolved"],
        },
        "levels": {
            "directories": sorted(path.name for path in LEVELS.iterdir()
                                  if path.is_dir()),
            "cities": amax["cities"],
        },
    }
    written["slots"] = write(out / "slots.json", slot_document)
    written["coverage"] = write(out / "coverage.json", {
        "locales": coverage,
        "missing": [row for row in slots if row["status"] == "missing"],
    })
    written["index"] = write(out / "index.json", {
        "kind": "blur.shipped-loc-index",
        "version": 1,
        "defaultLocale": DEFAULT_LOCALE,
        "fallbackOrder": [DEFAULT_LOCALE],
        "locales": [{"code": code, "keys": len(locale_docs[code]["strings"]),
                     "file": written[f"locale.{code}"],
                     "shell": written[f"shell.{code}"]} for code in locales],
        "files": [{"file": name, "keys": len(files[name]["loc"].keys),
                   "sha256": sha256_bytes(files[name]["raw"]),
                   "locales": [locale.code for locale in files[name]["loc"].locales]}
                  for name in order],
        "slotCount": len(slots),
        "slotDocument": written["slots"],
        "limits": [
            "Load one locales/<code>.json file per language; keys are '<file>:<KEY>'.",
            "shell/<code>.json has the required slots only and already applies the "
            "requested -> en fallback; null means typed missing.",
        ],
    })

    print(json.dumps({
        "status": "PASS",
        "files": len(order),
        "keys": catalog["_meta"]["counts"]["keys"],
        "uniqueKeyNames": catalog["_meta"]["counts"]["uniqueKeyNames"],
        "locales": locales,
        "slots": len(slots),
        "resolved": catalog["_meta"]["counts"]["slotsResolved"],
        "missing": catalog["_meta"]["counts"]["slotsMissing"],
        "coverage": {code: [coverage[code]["resolved"], coverage[code]["missing"]]
                     for code in locales},
        "written": written,
    }, indent=1, sort_keys=True, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
