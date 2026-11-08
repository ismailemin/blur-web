"""Independent verifier for the shipped-locale catalog.

This module deliberately does **not** import `olt.py`.  It re-derives every
header field, key table, locale blob and UTF-16LE value with its own minimal
reader, then compares the result with the committed build outputs under
`_work/loc/`.

Run:
  python probes/loc/tools/verify_loc_catalog.py [--out _work/loc]

Exit code 0 only when every check passes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
for path in (ROOT / "tools",):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from inspect_asset_layout import pak_index  # noqa: E402

PAK = ROOT / "game-data/Blur/cache/gamedata.pak"
SOURCE_LOCALES = ["en", "fr", "de", "it", "es"]
KNOWN_CONFLICTS = {
    "MP_MESSAGE_OF_THE_DAY": ("multiplayer.loc", "multiplayerts.loc"),
    "POB_COMMUNITY_TMS_TEXT": ("multiplayer.loc", "multiplayerts.loc"),
    "POB_DLC_TMS_TEXT": ("multiplayer.loc", "multiplayerts.loc"),
    "POB_NEWS_TMS_TEXT": ("multiplayer.loc", "multiplayerts.loc"),
}
KNOWN_ODD_KEYS = {
    "MP_UNLOCKS_BMWM3(E92)",
    "MP_UNLOCKS_CHEVROLETSO-CALHHR",
    "MP_UNLOCKS_DRIVER'SED.",
    '"',
}
KNOWN_EMPTY_TOTAL = 46


class VerifyError(RuntimeError):
    pass


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(document) -> bytes:
    return (json.dumps(document, indent=1, sort_keys=True, ensure_ascii=False)
            + "\n").encode("utf-8")


class Checker:
    def __init__(self):
        self.checks = []
        self.failures = []

    def check(self, name, ok, detail=""):
        self.checks.append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            self.failures.append({"name": name, "detail": detail})
        return bool(ok)

    def summary(self):
        return {
            "kind": "blur.loc-verify",
            "status": "PASS" if not self.failures else "FAIL",
            "checks": len(self.checks),
            "passed": sum(1 for row in self.checks if row["ok"]),
            "failed": len(self.failures),
            "failures": self.failures,
            "results": self.checks,
        }


def read_entry(path: str) -> bytes:
    index = pak_index(PAK)
    entry = next((row for row in index["entries"]
                  if row["path"].lower() == path.lower()), None)
    if entry is None or entry.get("directory"):
        raise VerifyError(f"missing pak entry {path}")
    with PAK.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    if index["codec"] != 2:
        raise VerifyError(f"unsupported pak codec {index['codec']}")
    data = zlib.decompress(packed)
    if len(data) != entry["logical_bytes"]:
        raise VerifyError(f"{path}: decoded length differs")
    return data


def parse_independent(raw: bytes, label: str) -> dict:
    """Minimal OLTX v1 reader written independently of olt.py."""
    if raw[:4] != b"OLTX":
        raise VerifyError(f"{label}: magic")
    version = struct.unpack_from("<I", raw, 4)[0]
    base = struct.unpack_from("<I", raw, 8)[0]
    locale_area = struct.unpack_from("<I", raw, 0x0C)[0] + base
    middle = struct.unpack_from("<I", raw, 0x10)[0]
    count = struct.unpack_from("<I", raw, 0x14)[0]
    key_rel = struct.unpack_from("<I", raw, 0x18)[0]
    if base != 16 or middle != 12:
        raise VerifyError(f"{label}: header constants {base}/{middle}")
    table = 0x10 + middle
    key_table = base + key_rel
    locales = []
    for i in range(count):
        at = table + i * 24
        code = raw[at:at + 2].decode("ascii")
        reserved = raw[at + 4:at + 16]
        off, size = struct.unpack_from("<2I", raw, at + 16)
        if reserved != b"\0" * 12:
            raise VerifyError(f"{label}: locale reserved")
        locales.append({"code": code, "offset": off, "size": size})
    n_keys, stride = struct.unpack_from("<2I", raw, key_table)
    if stride != 8:
        raise VerifyError(f"{label}: key stride")
    keys = []
    for i in range(n_keys):
        loc_id, name_rel = struct.unpack_from("<2I", raw, key_table + 8 + i * 8)
        at = key_table + name_rel
        end = raw.index(b"\0", at)
        keys.append((loc_id, raw[at:end].decode("ascii"), at))
    values = {}
    for locale in locales:
        n, stride = struct.unpack_from("<2I", raw, locale["offset"])
        if stride != 8 or n != n_keys:
            raise VerifyError(f"{label}: locale {locale['code']} shape")
        rows = {}
        offsets = {}
        for i in range(n):
            loc_id, rel = struct.unpack_from(
                "<2I", raw, locale["offset"] + 8 + i * 8)
            at = locale["offset"] + rel
            end = at
            while raw[end:end + 2] != b"\0\0":
                end += 2
            rows[loc_id] = raw[at:end].decode("utf-16-le")
            offsets[loc_id] = at
        values[locale["code"]] = rows
        locale["offsets"] = offsets
    return {
        "version": version, "base": base, "middle": middle,
        "localeArea": locale_area, "keyTable": key_table,
        "keys": keys, "locales": locales, "values": values,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=ROOT / "_work/loc")
    args = parser.parse_args()
    out = args.out
    check = Checker()

    catalog = json.loads((out / "strings.json").read_text(encoding="utf-8"))
    catalog_locales = {code: catalog[code] for code in SOURCE_LOCALES}
    inventory = json.loads((out / "inventory.json").read_text(encoding="utf-8"))
    index_doc = json.loads((out / "index.json").read_text(encoding="utf-8"))
    slots_doc = json.loads((out / "slots.json").read_text(encoding="utf-8"))
    coverage = json.loads((out / "coverage.json").read_text(encoding="utf-8"))
    shell = {code: json.loads((out / "shell" / f"{code}.json").read_text(encoding="utf-8"))
             for code in SOURCE_LOCALES}
    inventory_by_file = {row["file"]: row for row in inventory["files"]}

    pak = pak_index(PAK)
    rows = sorted((row for row in pak["entries"]
                   if row["path"].lower().endswith(".loc")),
                  key=lambda row: row["path"])
    check.check("inventory.fileCount", len(rows) == 23, str(len(rows)))
    check.check("inventory.matchesPak", len(inventory["files"]) == len(rows))
    check.check("inventory.locales", inventory["counts"]["locales"] == SOURCE_LOCALES)

    parsed = {}
    total_keys = 0
    for row in rows:
        name = row["path"].replace("\\", "/").rsplit("/", 1)[-1]
        raw = read_entry(row["path"])
        loc = parse_independent(raw, name)
        parsed[name] = {"raw": raw, "loc": loc, "entry": row}
        total_keys += len(loc["keys"])
        tag = f"format.{name}"
        check.check(f"{tag}.magic", raw[:4] == b"OLTX")
        check.check(f"{tag}.version", loc["version"] == 1)
        check.check(f"{tag}.base16", loc["base"] == 16)
        check.check(f"{tag}.middle12", loc["middle"] == 12)
        check.check(f"{tag}.localeCount", len(loc["locales"]) == 5)
        check.check(f"{tag}.localeOrder",
                    [item["code"] for item in loc["locales"]] == SOURCE_LOCALES)
        check.check(f"{tag}.keyTableFollowsLocales",
                    loc["keyTable"] == 0x10 + loc["middle"]
                    + len(loc["locales"]) * 24)
        check.check(f"{tag}.localeArea",
                    loc["locales"][0]["offset"] == loc["localeArea"])
        check.check(f"{tag}.keyCountMatch",
                    all(len(values) == len(loc["keys"])
                        for values in loc["values"].values()))
        check.check(f"{tag}.sha256", sha256(raw) == inventory_by_file[name]["sha256"])
        check.check(f"{tag}.recordCount",
                    len(loc["keys"]) == inventory_by_file[name]["recordCount"])
        check.check(f"{tag}.uniqueLocIds",
                    len({item[0] for item in loc["keys"]}) == len(loc["keys"]))
        check.check(f"{tag}.uniqueNames",
                    len({item[1] for item in loc["keys"]}) == len(loc["keys"]))
        for locale in SOURCE_LOCALES:
            values = loc["values"][locale]
            tag2 = f"encoding.{name}.{locale}"
            check.check(f"{tag2}.decoded", len(values) == len(loc["keys"]))
            check.check(f"{tag2}.noNul",
                        all("\x00" not in text for text in values.values()))
            ok = True
            for loc_id, text in values.items():
                at = loc["locales"][SOURCE_LOCALES.index(locale)]["offsets"][loc_id]
                ok = ok and raw[at:at + len(text.encode("utf-16-le"))].decode(
                    "utf-16-le") == text
            check.check(f"{tag2}.utf16RoundTrip", ok)

    check.check("inventory.totalKeys", total_keys == 5098, str(total_keys))
    check.check("catalog.keyCount", catalog["_meta"]["counts"]["keys"] == total_keys)
    check.check("catalog.uniqueNames",
                catalog["_meta"]["counts"]["uniqueKeyNames"] == len(
                    {key for loc in parsed.values() for _, key, _ in loc["loc"]["keys"]}))

    # --- key names / odd keys / duplicates ---------------------------------
    all_keys = [(name, loc_id, key) for name, loc in parsed.items()
                for loc_id, key, _ in loc["loc"]["keys"]]
    odd = {key for _, _, key in all_keys
           if not __import__("re").fullmatch(r"[A-Za-z0-9_]+", key)}
    check.check("keys.oddCharset", odd == KNOWN_ODD_KEYS, sorted(odd))
    check.check("keys.ascii", all(key.isascii() for _, _, key in all_keys))

    by_name = {}
    for name, loc_id, key in all_keys:
        by_name.setdefault(key, []).append((name, loc_id))
    duplicates = {key: rows for key, rows in by_name.items() if len(rows) > 1}
    check.check("keys.duplicateCount", len(duplicates) == 4, sorted(duplicates))
    check.check("keys.duplicateKnown",
                set(duplicates) == set(KNOWN_CONFLICTS), sorted(duplicates))
    conflicts = []
    for key, rows in duplicates.items():
        values = {code: [catalog_locales[code][key][i]
                         for i in range(len(rows))] for code in SOURCE_LOCALES}
        if any(len(set(value)) > 1 for value in values.values()):
            conflicts.append(key)
    check.check("keys.conflicts", set(conflicts) == set(KNOWN_CONFLICTS), conflicts)
    for key, (file_a, file_b) in KNOWN_CONFLICTS.items():
        entries = catalog["_provenance"]["en"][key]
        check.check(f"conflict.{key}.twoFiles",
                    {entry["file"] for entry in entries} == {file_a, file_b})
        check.check(f"conflict.{key}.twoValues",
                    len(catalog_locales["en"][key]) == 2)
        check.check(f"conflict.{key}.locIdAgrees",
                    len({entry["locId"] for entry in entries}) == 1)

    # --- catalogue agrees with the independent parse ------------------------
    check.check("catalog.localeSet",
                sorted(catalog_locales) == sorted(SOURCE_LOCALES))
    check.check("catalog.topLevelLocales",
                all(code in catalog for code in SOURCE_LOCALES))
    check.check("catalog.metadataKeys",
                all(key.startswith("_") for key in catalog
                    if key not in SOURCE_LOCALES))
    for name, loc in parsed.items():
        for locale in SOURCE_LOCALES:
            expected = {key: text for loc_id, key, _ in loc["loc"]["keys"]
                        for text in [loc["loc"]["values"][locale][loc_id]]}
            got = {}
            for key, values in catalog_locales[locale].items():
                for index, entry in enumerate(catalog["_provenance"][locale][key]):
                    if entry["file"] == name:
                        got[key] = values[index]
            check.check(f"values.{name}.{locale}", got == expected,
                        f"{len(got)} keys")

    # --- empty strings are preserved ---------------------------------------
    empty_total = 0
    for name, loc in parsed.items():
        for locale in SOURCE_LOCALES:
            empty_total += sum(1 for text in loc["loc"]["values"][locale].values()
                               if text == "")
    check.check("values.emptyTotal", empty_total == KNOWN_EMPTY_TOTAL, str(empty_total))

    # --- per-locale files and hashes ---------------------------------------
    for code in SOURCE_LOCALES:
        document = json.loads((out / "locales" / f"{code}.json").read_text(encoding="utf-8"))
        expected = {}
        for name, loc in parsed.items():
            for loc_id, key, _ in loc["loc"]["keys"]:
                expected[f"{name}:{key}"] = loc["loc"]["values"][code][loc_id]
        check.check(f"localeFile.{code}.entries", document["strings"] == expected,
                    f"{len(expected)} keys")
        check.check(f"localeFile.{code}.canonical",
                    (out / "locales" / f"{code}.json").read_bytes() == canonical(document))
        check.check(f"localeFile.{code}.hash",
                    sha256(canonical(document)) ==
                    next(row["file"]["sha256"] for row in index_doc["locales"]
                         if row["code"] == code))
        check.check(f"payload.{code}.hash",
                    sha256(canonical(catalog_locales[code]))
                    == catalog["_hashes"][code])
        listed = next(row for row in index_doc["locales"] if row["code"] == code)
        check.check(f"index.{code}.payloadHash",
                    listed["file"]["payloadSha256"] == catalog["_hashes"][code])
        check.check(f"index.{code}.bytes",
                    listed["file"]["bytes"] == (out / "locales" / f"{code}.json").stat().st_size)

    # --- sources -----------------------------------------------------------
    sources = catalog["_meta"]["sources"]
    check.check("source.gamedata",
                sources["gamedataPak"]["sha256"] == sha256(PAK.read_bytes()))
    amax_raw = read_entry("\\gamedata\\xt\\amax.bin")
    check.check("source.amax", sources["amax"]["sha256"] == sha256(amax_raw))
    check.check("source.amaxBytes", sources["amax"]["bytes"] == len(amax_raw))
    for key, path in (("cars", ROOT / "_work/vehicle-pipeline/cars.json"),
                      ("cAliases", ROOT / "_work/vehicle-pipeline/c-aliases.json"),
                      ("powerups", ROOT / "_work/powerups/powerups.json")):
        check.check(f"source.{key}", sources[key]["sha256"] == sha256(path.read_bytes()))

    # --- slots / coverage --------------------------------------------------
    slots = slots_doc["slots"]
    key_tables = {name: {key: loc_id for loc_id, key, _ in loc["loc"]["keys"]}
                  for name, loc in parsed.items()}
    check.check("slots.total", len(slots) == slots_doc["counts"]["total"])
    check.check("slots.unique", len({row["slot"] for row in slots}) == len(slots))
    for row in slots:
        if row["status"] != "resolved":
            continue
        name, key = row["file"], row["key"]
        check.check(f"slot.{row['slot']}.key", key in key_tables[name])
        check.check(f"slot.{row['slot']}.locId",
                    f"{key_tables[name][key]:08x}" == row["locId"])
        check.check(f"slot.{row['slot']}.allLocales",
                    all(row["values"].get(code) not in (None, "")
                        for code in SOURCE_LOCALES))

    missing = [row for row in slots if row["status"] == "missing"]
    check.check("slots.missingCount", len(missing) == 10, str(len(missing)))
    check.check("slots.missingTyped",
                all(row.get("reason") for row in missing))
    check.check("slots.missingVehicles",
                {row["slot"] for row in missing if row["category"] == "vehicle"}
                == {"vehicle.8.name", "vehicle.8.manufacturer"})
    check.check("slots.missingPowerups",
                {row["slot"] for row in missing if row["category"] == "powerup"} == {
                    "powerup.Fan.hud_name", "powerup.Fan.hit",
                    "powerup.Fan.description", "powerup.Stopwatch.name",
                    "powerup.Stopwatch.hud_name", "powerup.Stopwatch.hit",
                    "powerup.Stopwatch.description", "powerup.SuperShield.description"})

    for category in ("menu", "hud", "results", "countdown", "modes", "errors",
                     "level", "level-variant", "manufacturer"):
        total = sum(1 for row in slots if row["category"] == category)
        ok = sum(1 for row in slots if row["category"] == category
                 and row["status"] == "resolved")
        check.check(f"category.{category}", total == ok and total > 0, f"{ok}/{total}")

    # --- vehicles ----------------------------------------------------------
    vehicle_names = [row for row in slots
                     if row["category"] == "vehicle" and row["slot"].endswith(".name")]
    check.check("vehicles.records", slots_doc["vehicles"]["records"] == 62)
    check.check("vehicles.mapped", slots_doc["vehicles"]["mapped"] == 61)
    check.check("vehicles.unresolvedDefaultCar",
                [row["name"] for row in slots_doc["vehicles"]["unresolved"]] == ["DefaultCar"])
    check.check("vehicles.nameSlots",
                len(vehicle_names) == 62
                and sum(1 for row in vehicle_names if row["status"] == "resolved") == 61)
    for row in vehicle_names:
        if row["status"] != "resolved":
            continue
        check.check(f"vehicle.{row['slot']}.allLocales",
                    all(row["values"].get(code) for code in SOURCE_LOCALES))
        check.check(f"vehicle.{row['slot']}.nonEmpty",
                    all(row["values"][code].strip() for code in SOURCE_LOCALES))
    manufacturers = [row for row in slots if row["category"] == "manufacturer"]
    check.check("manufacturers.count", len(manufacturers) == 24)
    check.check("manufacturers.resolved",
                all(row["status"] == "resolved" for row in manufacturers))
    for row in manufacturers:
        check.check(f"manufacturer.{row['slot']}.allLocales",
                    all(row["values"].get(code) for code in SOURCE_LOCALES))

    # --- levels ------------------------------------------------------------
    level_names = [row for row in slots
                   if row["category"] == "level" and row["slot"].endswith(".name")]
    check.check("levels.count", len(level_names) == 19)
    check.check("levels.directories",
                sorted(row["slot"].split(".")[1] for row in level_names)
                == sorted(path.name for path in (ROOT / "game-data/Blur/levels").iterdir()
                          if path.is_dir()))
    for row in level_names:
        check.check(f"level.{row['slot']}.allLocales",
                    all(row["values"].get(code) for code in SOURCE_LOCALES))
    variants = [row for row in slots if row["category"] == "level-variant"]
    check.check("levels.variants", len(variants) == 59, str(len(variants)))
    check.check("levels.variantLocales",
                all(all(row["values"].get(code) for code in SOURCE_LOCALES)
                    for row in variants))

    # --- power-ups ---------------------------------------------------------
    powerups = [row for row in slots if row["category"] == "powerup"]
    check.check("powerups.slots", len(powerups) == 44, str(len(powerups)))
    check.check("powerups.names", sum(1 for row in powerups
                                     if row["slot"].endswith(".name")
                                     and row["status"] == "resolved") == 10)
    check.check("powerups.hits", sum(1 for row in powerups
                                    if row["slot"].endswith(".hit")
                                    and row["status"] == "resolved") == 9)
    check.check("powerups.tips", sum(1 for row in powerups
                                    if row["slot"].endswith(".description")
                                    and row["status"] == "resolved"
                                    and row.get("binding") == "prose-name-mention") == 8)

    # --- coverage and shell ------------------------------------------------
    check.check("coverage.locales", sorted(coverage["locales"]) == sorted(SOURCE_LOCALES))
    for code in SOURCE_LOCALES:
        row = coverage["locales"][code]
        check.check(f"coverage.{code}.resolved", row["resolved"] == 490, str(row["resolved"]))
        check.check(f"coverage.{code}.missing", row["missing"] == 10, str(row["missing"]))
        check.check(f"coverage.{code}.empty", row["empty"] == 0)
        check.check(f"shell.{code}.slotCount",
                    len(shell[code]["strings"]) == len(slots))
        check.check(f"shell.{code}.fallback",
                    shell[code]["fallbackLocale"] == "en")
        # en shell equals the slot table; every other locale falls back to en.
        ok = True
        for row in slots:
            value = shell[code]["strings"][row["slot"]]
            expected = None if row["status"] == "missing" else (
                row["values"].get(code) or row["values"].get("en"))
            ok = ok and value == expected
        check.check(f"shell.{code}.values", ok)
        check.check(f"shell.{code}.missing",
                    set(shell[code]["missing"]) == {row["slot"] for row in missing})

    # --- artifact hashes ---------------------------------------------------
    for key in ("strings", "inventory", "slots", "coverage", "index"):
        path = out / f"{key}.json"
        check.check(f"artifact.{key}.exists", path.exists())
        document = json.loads(path.read_text(encoding="utf-8"))
        check.check(f"artifact.{key}.canonical", path.read_bytes() == canonical(document))
    check.check("hashes.keys", sorted(catalog["_hashes"]) == sorted(SOURCE_LOCALES))

    summary = check.summary()
    (out / "verify.json").write_bytes(canonical(summary))
    print(json.dumps({key: summary[key] for key in
                      ("status", "checks", "passed", "failed")},
                     indent=1, sort_keys=True))
    if summary["failed"]:
        print(json.dumps(summary["failures"][:10], indent=1, ensure_ascii=False))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
