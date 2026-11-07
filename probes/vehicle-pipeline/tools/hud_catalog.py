"""Build the HUD name/icon/manufacturer catalog for the batch-3 cars.

Inputs are read-only game data plus the committed vehicle-pipeline artifacts:

* `\\gamedata\\xt\\loc\\vehicles.loc` and `hud.loc` (OLTX v1 localization),
* `\\ui\\data\\ipf\\car_icons*.ipf` (IPF vector icon packages; **names only**),
* `\\gamedata\\xt\\amax.bin` (`AmaxVehicle.LocString`, `locStringFull`,
  `UiIconName`, `Manufacturer`).

The HUD identity of a car is taken from the `AmaxVehicle` record selected by
exact body-model tag (`tag.lower() == body model stem`) and, for C aliases, the
`AmaxVehicle` tag proven by `c-aliases.json`. The display name is the exact
`LocId` stored in `AmaxVehicle.LocString` (`locStringFull` wins when non-zero),
resolved through the OLTX key table. No name is matched by similarity.

Limit: the IPF icon packages are vector art. This tool validates the sprite
name table (length-prefixed lowercase names) and records each sprite's byte
offset, but does not decode or rasterise the vector icon. That limit is emitted
in the artifact; it is not a guessed pixel result.

Usage:
  python probes/vehicle-pipeline/tools/hud_catalog.py [--out _work/vehicle-pipeline/batch3/hud/hud-catalog.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
for path in (TOOLS, ROOT / "engine/harness/t005d-vehicle",
             ROOT / "probes/vehicle-pipeline/tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import audit_c_aliases as aliases  # noqa: E402
import car_xt  # noqa: E402
from inspect_asset_layout import pak_index  # noqa: E402
from prepare_asset_fixture import decode_packet_zlib  # noqa: E402

GAMEDATA_PAK = ROOT / "game-data/Blur/cache/gamedata.pak"
ROOT_PAK = ROOT / "game-data/Blur/cache/root.pak"
VEHICLES_LOC = "\\gamedata\\xt\\loc\\vehicles.loc"
HUD_LOC = "\\gamedata\\xt\\loc\\hud.loc"
AMAX_PATH = "\\gamedata\\xt\\amax.bin"
ICON_FILES = [
    "\\ui\\data\\ipf\\car_icons.ipf",
    "\\ui\\data\\ipf\\car_icons_a.ipf",
    "\\ui\\data\\ipf\\car_icons_b.ipf",
    "\\ui\\data\\ipf\\car_icons_c.ipf",
    "\\ui\\data\\ipf\\car_icons_d.ipf",
]
OUT_DEFAULT = ROOT / "_work/vehicle-pipeline/batch3/hud/hud-catalog.json"
C_INDEXES = (1, 7, 23, 31, 39, 48, 71)
B_INDEXES = (21, 24, 26)

NAME_RE = re.compile(r"[A-Z0-9_]+")
TOKEN_RE = re.compile(rb"[a-z][a-z0-9_]*")
LANG_RE = re.compile(r"[a-z]{2}")


class Unsupported(ValueError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def extract_gamedata(path: str) -> tuple[bytes, dict]:
    index = pak_index(GAMEDATA_PAK)
    entry = next((row for row in index["entries"]
                  if row["path"].lower() == path.lower()), None)
    if entry is None or entry.get("directory"):
        raise Unsupported(f"missing gamedata entry {path}")
    with GAMEDATA_PAK.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    if index["codec"] != 2:
        raise Unsupported(f"unsupported gamedata codec {index['codec']}")
    decoded = zlib.decompress(packed)
    if len(decoded) != entry["logical_bytes"]:
        raise Unsupported(f"decoded length mismatch for {path}")
    return decoded, entry


def extract_root(path: str) -> tuple[bytes, dict]:
    index = pak_index(ROOT_PAK)
    entry = next((row for row in index["entries"]
                  if row["path"].lower() == path.lower()), None)
    if entry is None or entry.get("directory"):
        raise Unsupported(f"missing root entry {path}")
    with ROOT_PAK.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    decoded = decode_packet_zlib(packed, entry["logical_bytes"])
    return decoded, entry


def parse_loc(data: bytes, label: str) -> dict:
    """Bounded OLTX v1 reader: language table, hash-key table, UTF-16LE values."""
    if len(data) < 0x1c or data[:4] != b"OLTX":
        raise Unsupported(f"{label}: not OLTX")
    version, = struct.unpack_from("<I", data, 4)
    if version != 1:
        raise Unsupported(f"{label}: unsupported OLTX version {version}")
    language_count, = struct.unpack_from("<I", data, 0x14)
    if not 1 <= language_count <= 32:
        raise Unsupported(f"{label}: language count {language_count}")
    languages = []
    previous_end = None
    for index in range(language_count):
        record_at = 0x1c + index * 24
        if record_at + 24 > len(data):
            raise Unsupported(f"{label}: language record outside file")
        code = data[record_at:record_at + 4].rstrip(b"\0").decode("ascii", "replace")
        if not LANG_RE.fullmatch(code):
            raise Unsupported(f"{label}: bad language code {code!r}")
        offset, size = struct.unpack_from("<2I", data, record_at + 16)
        if offset < 0x1c + language_count * 24 or size == 0 or offset + size > len(data):
            raise Unsupported(f"{label}: language {code} outside file")
        if previous_end is not None and offset != previous_end:
            raise Unsupported(f"{label}: language {code} is not contiguous")
        previous_end = offset + size
        languages.append({"code": code, "offset": offset, "size": size})

    key_base = 0x1c + language_count * 24
    if key_base + 8 > len(data):
        raise Unsupported(f"{label}: key table outside file")
    key_count, key_stride = struct.unpack_from("<2I", data, key_base)
    if not 1 <= key_count <= 4096 or key_stride != 8:
        raise Unsupported(f"{label}: key table shape {key_count}/{key_stride}")
    if key_base + 8 + key_count * key_stride > len(data):
        raise Unsupported(f"{label}: key table rows outside file")
    keys = []
    key_end = 0
    seen_hashes = set()
    for index in range(key_count):
        key_hash, offset = struct.unpack_from("<2I", data, key_base + 8 + index * key_stride)
        at = key_base + offset
        if at >= len(data):
            raise Unsupported(f"{label}: key {index} outside file")
        end = data.find(b"\0", at)
        if end < at or end - at > 200:
            raise Unsupported(f"{label}: key {index} is not terminated")
        text = data[at:end].decode("ascii", "replace")
        if not NAME_RE.fullmatch(text):
            raise Unsupported(f"{label}: key {index} is not ASCII upper/underscore")
        if key_hash in seen_hashes:
            raise Unsupported(f"{label}: duplicate key hash")
        seen_hashes.add(key_hash)
        key_end = max(key_end, end + 1)
        keys.append({"hash": key_hash, "key": text})

    for language in languages:
        if language["offset"] < key_end:
            raise Unsupported(f"{label}: language {language['code']} overlaps the key table")
        offset = language["offset"]
        count, stride = struct.unpack_from("<2I", data, offset)
        if count != key_count or stride != 8:
            raise Unsupported(f"{label}: language {language['code']} table shape")
        if offset + 8 + count * stride > language["offset"] + language["size"]:
            raise Unsupported(f"{label}: language {language['code']} rows outside blob")
        values = {}
        for index in range(count):
            key_hash, string_offset = struct.unpack_from(
                "<2I", data, offset + 8 + index * stride)
            if key_hash not in seen_hashes:
                raise Unsupported(f"{label}: language hash outside the key table")
            if key_hash in values:
                raise Unsupported(f"{label}: duplicate language hash")
            at = offset + string_offset
            end = at
            while True:
                if end + 1 >= language["offset"] + language["size"]:
                    raise Unsupported(f"{label}: language string {index} not terminated")
                if data[end] == 0 and data[end + 1] == 0:
                    break
                end += 2
            try:
                value = data[at:end].decode("utf-16-le")
            except UnicodeDecodeError as error:
                raise Unsupported(f"{label}: bad UTF-16 in {index}: {error}") from error
            if not value:
                raise Unsupported(f"{label}: empty value for hash {key_hash}")
            values[key_hash] = value
        if set(values) != seen_hashes:
            raise Unsupported(f"{label}: language {language['code']} misses keys")
        language["values"] = values

    english = next((entry for entry in languages if entry["code"] == "en"), None)
    if english is None:
        raise Unsupported(f"{label}: no en locale")
    if len(english["values"]) != key_count:
        raise Unsupported(f"{label}: en value count differs")
    return {
        "format": "OLTX",
        "version": version,
        "keys": keys,
        "languages": [{key: entry[key] for key in ("code", "offset", "size")}
                      for entry in languages],
        "values": {entry["code"]: entry["values"] for entry in languages},
    }


def parse_ipf_names(data: bytes, label: str) -> list[dict]:
    """Length-prefixed sprite-name scan for an IPF vector package.

    The package header (`00 00 10 00`, version 1) is validated, and every name
    accepted here is immediately preceded by its own 32-bit byte length. The
    vector payload is not decoded.
    """
    if len(data) < 32 or data[:4] != b"\x00\x00\x10\x00":
        raise Unsupported(f"{label}: not an IPF package")
    version, = struct.unpack_from("<I", data, 4)
    if version not in (1, 10):
        raise Unsupported(f"{label}: unsupported IPF version {version}")
    found = []
    seen_offsets = set()
    for offset in range(0, len(data) - 8):
        length, = struct.unpack_from("<I", data, offset)
        if not 3 <= length <= 64 or offset + 4 + length > len(data):
            continue
        token = data[offset + 4:offset + 4 + length]
        if not TOKEN_RE.fullmatch(token) or b"_" not in token:
            continue
        after = data[offset + 4 + length:offset + 5 + length]
        if after and re.match(rb"[a-z0-9_]", after):
            continue
        text = token.decode("ascii")
        if offset + 4 in seen_offsets:
            continue
        seen_offsets.add(offset + 4)
        found.append({"name": text, "offset": offset + 4, "length": length})
    if not 1 <= len(found) <= 512:
        raise Unsupported(f"{label}: implausible sprite count {len(found)}")
    if len({row["name"] for row in found}) != len(found):
        raise Unsupported(f"{label}: duplicate sprite names")
    return found


def amax_hud(loc: dict) -> dict:
    xt, data = aliases.load_xt(aliases.AMAX_BIN, aliases.AMAX_PATH)
    type_index = next(t["index"] for t in xt["types"] if t["name"] == "AmaxVehicle")
    leaves = {leaf["name"]: leaf for leaf in car_xt.leaves(xt, type_index)}
    loc_offset = aliases.leaves_offset(xt, "AmaxGameDataObject", "LocString")
    manufacturer_leaves = {
        leaf["name"]: leaf
        for leaf in car_xt.leaves(
            xt, next(t["index"] for t in xt["types"] if t["name"] == "AmaxManufacturer"))
    }
    refs_table = xt["tables"]["refs"]
    width = refs_table["units"]
    refs = [struct.unpack_from("<I2H", data, refs_table["offset"] + index * width)
            for index in range(refs_table["count"])]
    records = {record["id"]: record for record in xt["records"]
               if record["id"] != 0xFFFFFFFF}
    known_hashes = {row["hash"]: row["key"] for row in loc["keys"]}

    vehicles = {}
    unresolved = 0
    for record in xt["records"]:
        if record["type"] != type_index:
            continue
        tag = aliases._record_name(xt, data, record)
        loc_id, = struct.unpack_from("<I", data, record["dataOffset"] + loc_offset)
        full_id = struct.unpack_from(
            "<I", data, record["dataOffset"] + leaves["locStringFull"]["offset"])[0]
        if loc_id and loc_id not in known_hashes:
            unresolved += 1
        if full_id and full_id not in known_hashes:
            unresolved += 1
        manufacturer = None
        handle = struct.unpack_from(
            "<I", data, record["dataOffset"] + leaves["Manufacturer"]["offset"])[0]
        if handle != 0xFFFFFFFF and handle < len(refs):
            record_id, type_id, _ = refs[handle]
            target = records.get(record_id)
            if target is not None and xt["types"][type_id]["name"] == "AmaxManufacturer":
                manufacturer = {
                    "tag": aliases._record_name(xt, data, target),
                    "texture": aliases._sz8(
                        xt, data, target, manufacturer_leaves["UiTexture"]["offset"]),
                }
        dynamics_handle = struct.unpack_from(
            "<I", data, record["dataOffset"] + leaves["dynamics"]["offset"])[0]
        dynamics_id = (refs[dynamics_handle][0]
                       if dynamics_handle != 0xFFFFFFFF and dynamics_handle < len(refs)
                       else None)
        vehicles[tag] = {
            "tag": tag,
            "recordId": record["id"],
            "dynamicsRecordId": dynamics_id,
            "locStringHash": loc_id,
            "locStringKey": known_hashes.get(loc_id),
            "locString": loc["values"]["en"].get(loc_id) if loc_id else None,
            "locStringFullHash": full_id,
            "locStringFullKey": known_hashes.get(full_id),
            "locStringFull": loc["values"]["en"].get(full_id) if full_id else None,
            "iconTag": aliases._sz8(xt, data, record, leaves["UiIconName"]["offset"]),
            "manufacturer": manufacturer,
        }
    if unresolved:
        raise Unsupported(f"amax: {unresolved} LocId values do not resolve in vehicles.loc")
    return {
        "vehicles": vehicles,
        "locOffset": loc_offset,
        "unresolvedLocIds": unresolved,
        "count": len(vehicles),
        "sha256": sha256_bytes(data),
        "bytes": len(data),
    }


def build() -> dict:
    vehicles_raw, vehicles_entry = extract_gamedata(VEHICLES_LOC)
    hud_raw, hud_entry = extract_gamedata(HUD_LOC)
    vehicles_loc = parse_loc(vehicles_raw, "vehicles.loc")
    hud_loc = parse_loc(hud_raw, "hud.loc")
    amax = amax_hud(vehicles_loc)

    atlases = []
    for path in ICON_FILES:
        raw, entry = extract_root(path)
        names = parse_ipf_names(raw, path)
        atlases.append({
            "pakPath": path,
            "sha256": sha256_bytes(raw),
            "logicalBytes": entry["logical_bytes"],
            "sprites": names,
        })
    master = atlases[0]
    master_names = {row["name"]: row for row in master["sprites"]}
    if len(master_names) != len(master["sprites"]):
        raise Unsupported("car_icons.ipf contains duplicate sprite names")

    cars = json.loads((ROOT / "_work/vehicle-pipeline/cars.json").read_text(encoding="utf-8"))
    by_index = {record["index"]: record for record in cars["records"]}
    c_doc = json.loads(
        (ROOT / "_work/vehicle-pipeline/c-aliases.json").read_text(encoding="utf-8"))
    c_by_index = {record["index"]: record for record in c_doc["records"]}

    records = []
    for index in C_INDEXES + B_INDEXES:
        car = by_index[index]
        is_c = index in C_INDEXES
        if is_c:
            alias = c_by_index[index]
            if alias["status"] != "provable":
                raise Unsupported(f"record {index} is not a provable C alias")
            body_pak = alias["intendedModel"]["pakPath"]
            expected_tag = alias["identity"]["amaxTag"]
        else:
            if car["class"] != "B":
                raise Unsupported(f"record {index} is not class B")
            body_pak = car["model"]["pakPath"]
            expected_tag = None
        body_stem = Path(body_pak.replace("\\", "/")).stem
        candidate = amax["vehicles"].get(next(
            (tag for tag in amax["vehicles"] if tag.lower() == body_stem.lower()), None))
        if candidate is None:
            raise Unsupported(f"record {index}: no AmaxVehicle tag {body_stem}")
        if expected_tag is not None and candidate["tag"] != expected_tag:
            raise Unsupported(f"record {index}: AmaxVehicle tag differs from the alias")
        icon_sprite = (candidate["iconTag"] or "").lower()
        if not icon_sprite:
            raise Unsupported(f"record {index}: no UiIconName")
        if icon_sprite not in master_names:
            raise Unsupported(f"record {index}: icon sprite {icon_sprite} not in car_icons.ipf")
        pages = []
        for atlas in atlases:
            row = next((sprite for sprite in atlas["sprites"] if sprite["name"] == icon_sprite), None)
            if row is not None:
                pages.append({"pakPath": atlas["pakPath"], "sha256": atlas["sha256"],
                              "offset": row["offset"], "length": row["length"]})
        if not pages:
            raise Unsupported(f"record {index}: no icon page")
        full = candidate["locStringFull"] or candidate["locString"]
        full_key = candidate["locStringFullKey"] or candidate["locStringKey"]
        if not candidate["locString"]:
            raise Unsupported(f"record {index}: no LocString")
        records.append({
            "recordIndex": index,
            "recordId": car["id"],
            "recordName": car["name"],
            "slug": car["slug"],
            "class": car["class"],
            "amaxTag": candidate["tag"],
            "amaxRecordId": candidate["recordId"],
            "nameKey": candidate["locStringKey"],
            "name": candidate["locString"],
            "fullNameKey": candidate["locStringFullKey"],
            "fullName": candidate["locStringFull"],
            "hudNameKey": full_key,
            "hudName": full,
            "iconTag": candidate["iconTag"],
            "iconSprite": icon_sprite,
            "iconPages": pages,
            "manufacturerTag": (candidate["manufacturer"] or {}).get("tag"),
            "manufacturerTexture": (candidate["manufacturer"] or {}).get("texture"),
        })

    master_car_sprites = sorted(master_names)
    return {
        "kind": "blur.vehicle-batch3-hud-catalog",
        "version": 1,
        "generatedBy": "probes/vehicle-pipeline/tools/hud_catalog.py",
        "status": "PASS",
        "sources": {
            "vehiclesLoc": {
                "pakPath": VEHICLES_LOC, "sha256": sha256_bytes(vehicles_raw),
                "bytes": len(vehicles_raw), "keys": len(vehicles_loc["keys"]),
                "languages": vehicles_loc["languages"],
                "entry": {key: vehicles_entry[key] for key in
                          ("logical_bytes", "stored_bytes", "offset")},
            },
            "hudLoc": {
                "pakPath": HUD_LOC, "sha256": sha256_bytes(hud_raw),
                "bytes": len(hud_raw), "keys": len(hud_loc["keys"]),
                "languages": hud_loc["languages"],
                "entry": {key: hud_entry[key] for key in
                          ("logical_bytes", "stored_bytes", "offset")},
            },
            "amax": {
                "pakPath": AMAX_PATH, "sha256": amax["sha256"], "bytes": amax["bytes"],
                "vehicleCount": amax["count"],
                "locOffset": amax["locOffset"],
                "unresolvedLocIds": amax["unresolvedLocIds"],
            },
            "iconAtlases": [{key: atlas[key] for key in
                             ("pakPath", "sha256", "logicalBytes")}
                            | {"spriteCount": len(atlas["sprites"])}
                            for atlas in atlases],
        },
        "iconCatalog": {
            "masterPakPath": master["pakPath"],
            "masterSha256": master["sha256"],
            "spriteCount": len(master["sprites"]),
            "carSprites": master_car_sprites,
        },
        "records": records,
        "counts": {
            "records": len(records),
            "exactName": sum(1 for row in records if row["nameKey"]),
            "fullName": sum(1 for row in records if row["fullNameKey"]),
            "iconsResolved": sum(1 for row in records if row["iconSprite"]),
            "manufacturers": len({row["manufacturerTag"] for row in records}),
        },
        "checks": {
            "oltVersion": 1,
            "vehiclesLocKeys": len(vehicles_loc["keys"]),
            "hudLocKeys": len(hud_loc["keys"]),
            "amaxVehicles": amax["count"],
            "amaxLocIdsResolved": amax["count"] and amax["unresolvedLocIds"] == 0,
            "iconsNamesOnly": True,
        },
        "limits": [
            "IPF icon packages are vector art; only the length-prefixed sprite name table is read. "
            "No icon pixels/shapes are decoded, rasterised or claimed.",
            "Display names are the exact AmaxVehicle.LocString / locStringFull ids resolved in "
            "vehicles.loc (en locale); no similarity match is used.",
            "The HUD name/icon list is data evidence, not a browser HUD screenshot or a rendered "
            "icon claim.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=OUT_DEFAULT)
    args = parser.parse_args()
    document = build()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(
        (json.dumps(document, indent=1, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8"))
    print(json.dumps({"status": document["status"], "output": rel(args.out),
                      "sha256": sha256_file(args.out), "counts": document["counts"]},
                     indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
