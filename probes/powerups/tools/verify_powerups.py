"""Independent verifier for the power-up manifest.

It re-reads the PAK, re-parses the FLSK tables with a second, direct-offset
implementation (no import of ``xt_decode``), and compares values against
``_work/powerups/powerups.json``. It also runs the committed native
``xt_inspect.exe`` and compares table/record extents, so the schema is agreed by
three paths: this Python reader, the builder, and the native C++ reader.

Usage:
  python probes/powerups/tools/verify_powerups.py [--manifest PATH]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import subprocess
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
from inspect_asset_layout import pak_index  # noqa: E402

GAME = ROOT / "game-data" / "Blur" / "cache" / "gamedata.pak"
OUT = ROOT / "_work" / "powerups"
NATIVE = ROOT / "_work" / "build" / "asset-reader-native" / "Release" / "xt_inspect.exe"
NAMES = ["types", "bases", "fields", "strings", "refs", "records", "components", "data"]
WIDTHS = [12, 4, 8, 1, 8, 16, 6, 1]

checks: list[dict] = []


def check(cid: str, ok: bool, detail) -> None:
    checks.append({"id": cid, "ok": bool(ok), "detail": detail})


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def decode_strings(encoded: bytes) -> bytes:
    if not encoded:
        return b""
    count = len(encoded) - 1
    out = bytearray(len(encoded))
    previous = 0xCC
    for i in range(count):
        out[i] = (previous - (encoded[i] ^ 0xB3)) & 255
        previous = (previous + out[i] - i) & 255
    out[count] = 0
    return bytes(out)


class RawFlask:
    def __init__(self, data: bytes):
        self.data = data
        header = struct.unpack_from("<18I", data)
        assert header[0] == 0x464C534B, "tag"
        self.version = header[1]
        self.tables = {}
        for i, name in enumerate(NAMES):
            self.tables[name] = (header[2 + i * 2], header[3 + i * 2], WIDTHS[i])
        self.types = self.rows("types", "6H")
        self.bases = self.rows("bases", "2H")
        self.fields = self.rows("fields", "3H2B")
        self.refs = self.rows("refs", "I2H")
        self.records = self.rows("records", "4I")
        self.components = self.rows("components", "3H")
        self.strings = decode_strings(
            data[self.tables["strings"][0]:self.tables["strings"][0] + self.tables["strings"][1]])
        self.data_base = self.tables["data"][0]
        self.data_start = []
        total = 0
        for row in self.records:
            self.data_start.append(total)
            total += row[2] + row[3]
        self.comp_start = []
        total = 0
        for row in self.records:
            self.comp_start.append(total)
            total += row[1]

    def rows(self, name, fmt):
        offset, count, width = self.tables[name]
        return [struct.unpack_from("<" + fmt, self.data, offset + i * width) for i in range(count)]

    def name(self, at):
        end = self.strings.find(b"\0", at)
        return self.strings[at:end].decode("ascii")

    def type_name(self, index):
        return self.name(self.types[index][0])

    def type_index(self, name):
        return next(i for i in range(len(self.types)) if self.type_name(i) == name)

    def type_fields(self, index):
        start = sum(self.types[i][1] for i in range(index))
        rows = self.fields[start:start + self.types[index][1]]
        return [{"name": self.name(n), "type": t if t != 0xFFFF else None, "offset": o,
                 "behaviour": b, "array": a} for n, t, o, b, a in rows]

    def all_fields(self, index, base_offset=0):
        out = []
        for base_type, base_off in self.type_bases(index):
            out.extend(self.all_fields(base_type, base_offset + base_off))
        for row in self.type_fields(index):
            out.append({**row, "offset": base_offset + row["offset"]})
        return out

    def field(self, type_index, name):
        return next(f for f in self.all_fields(type_index) if f["name"] == name)

    def type_bases(self, index):
        start = sum(self.types[i][2] for i in range(index))
        return self.bases[start:start + self.types[index][2]]

    def record_type(self, index):
        return self.refs[self.records[index][0]][1]

    def record_id(self, index):
        return self.refs[self.records[index][0]][0]

    def payload(self, index):
        rec = self.records[index]
        at = self.data_base + self.data_start[index]
        return self.data[at:at + rec[2]]

    def strings_of(self, index):
        rec = self.records[index]
        at = self.data_base + self.data_start[index] + rec[2]
        return decode_strings(self.data[at:at + rec[3]])

    def comp(self, record, relative):
        return self.components[self.comp_start[record] + relative]

    def element_base(self, record, relative, element):
        offset = 0
        for typ, count, behaviour in self.components[
                self.comp_start[record]:self.comp_start[record] + relative]:
            size = self.types[typ][5] if behaviour == 0 else 4
            offset = (offset + count * size + 3) & ~3
        meta = self.comp(record, relative)
        size = self.types[meta[0]][5] if meta[2] == 0 else 4
        return offset + element * size

    def ptr(self, record, relative, element):
        """Resolve a component element to (record, absolute component, base)."""
        return record, self.comp_start[record] + relative, self.element_base(record, relative, element)

    def read_f32(self, payload, offset):
        return struct.unpack_from("<f", payload, offset)[0]

    def read_i32(self, payload, offset):
        return struct.unpack_from("<i", payload, offset)[0]

    def read_u32(self, payload, offset):
        return struct.unpack_from("<I", payload, offset)[0]

    def read_bool(self, payload, offset):
        return struct.unpack_from("<I", payload, offset)[0] != 0


def near(a, b) -> bool:
    if isinstance(a, float) or isinstance(b, float):
        return math.isclose(float(a), float(b), rel_tol=1e-9, abs_tol=1e-12)
    return a == b


def compare_map(prefix, manifest: dict, payload: bytes, flask: RawFlask, type_index: int) -> None:
    """Compare every scalar field of manifest map using the schema offsets."""
    for field in flask.type_fields(type_index):
        name = field["name"]
        if name not in manifest or field["array"] or field["behaviour"] not in (0, 1):
            continue
        if field["behaviour"] == 1:
            got = {"labelIndex": flask.read_u32(payload, field["offset"])}
            expect_index = manifest[name]["labelIndex"] if isinstance(manifest[name], dict) else None
            check(f"{prefix}.{name}.labelIndex", got["labelIndex"] == expect_index,
                  {"got": got["labelIndex"], "expected": expect_index})
            continue
        atom = flask.types[field["type"]][4]
        if atom == 1:
            got = flask.read_bool(payload, field["offset"])
        elif atom == 10:
            got = flask.read_f32(payload, field["offset"])
        elif atom == 4:
            got = flask.read_i32(payload, field["offset"])
        elif atom in (6, 7, 8, 9, 14):
            got = flask.read_u32(payload, field["offset"])
        else:
            continue
        check(f"{prefix}.{name}", near(got, manifest[name]),
              {"got": got, "expected": manifest[name]})


def pak_entry(index, path):
    return next(r for r in index["entries"] if r["path"].lower() == path.lower())


def read_entry(index, path):
    entry = pak_entry(index, path)
    with GAME.open("rb") as stream:
        stream.seek(entry["offset"])
        stored = stream.read(entry["stored_bytes"])
    inflater = zlib.decompressobj()
    data = inflater.decompress(stored, entry["logical_bytes"] + 1)
    return entry, stored, data


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=OUT / "powerups.json")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    index = pak_index(GAME)

    # ------------------------------------------------------------- sources
    source_by_name = {s["name"]: s for s in manifest["sources"]}
    flasks = {}
    for src in manifest["sources"]:
        entry, stored, data = read_entry(index, src["path"])
        ok = (sha(stored) == src["sha256Stored"] and sha(data) == src["sha256Decoded"]
              and len(data) == src["logicalBytes"] and len(stored) == src["storedBytes"]
              and entry["fat_index"] == src["fatIndex"] and entry["path"] == src["path"])
        check(f"source.{src['name']}", ok,
              {"path": src["path"], "logicalBytes": len(data),
               "storedBytes": len(stored), "sha256": sha(data)})
        flask = RawFlask(data)
        flasks[src["name"]] = flask
        summary = src["summary"]
        check(f"schema.{src['name']}", all([
            summary["version"] == flask.version,
            summary["types"] == len(flask.types),
            summary["fields"] == len(flask.fields),
            summary["bases"] == len(flask.bases),
            summary["refs"] == len(flask.refs),
            summary["records"] == len(flask.records),
            summary["components"] == len(flask.components),
            summary["dataBytes"] == flask.tables["data"][1],
        ]), {"version": flask.version, "records": len(flask.records)})

    pickups = flasks["pickups"]
    multi = flasks["multiplayer"]
    ui = flasks["ui"]
    audio = flasks["audio"]
    dynamic = flasks["dynamiceffects"]

    # ------------------------------------------------------------- enums
    def labels(name):
        return [f["name"] for f in pickups.type_fields(pickups.type_index(name))]

    check("enum.Pickup", manifest["enums"]["Pickup"] == labels("Pickup"),
          manifest["enums"]["Pickup"])
    check("enum.PickupTypeList", manifest["enums"]["PickupTypeList"] == labels("PickupTypeList"),
          manifest["enums"]["PickupTypeList"])
    mp_labels = [f["name"] for f in multi.type_fields(multi.type_index("MpPickup"))]
    check("enum.MpPickup", manifest["enums"]["MpPickup"] == mp_labels, mp_labels)

    # ------------------------------------------------------ pickup system
    system_record = next(i for i in range(len(pickups.records))
                         if pickups.type_name(pickups.record_type(i)) == "PickupSystem")
    sys_manifest = manifest["pickupSystem"]
    check("system.record", sys_manifest["record"] == system_record
          and sys_manifest["refId"] == pickups.record_id(system_record),
          {"record": system_record, "id": pickups.record_id(system_record)})
    sys_payload = pickups.payload(system_record)
    sys_type = pickups.record_type(system_record)
    # Parameters is a *handle* field (behaviour 5), resolved through the refs table.
    param_field = pickups.field(sys_type, "Parameters")
    param_ref = pickups.read_u32(sys_payload, param_field["offset"])
    _, _, param_record = pickups.refs[param_ref]
    param_payload = pickups.payload(param_record)
    param_type = pickups.record_type(param_record)
    base = 0
    for f in pickups.type_fields(param_type):
        name = f["name"]
        if f["array"] or f["behaviour"] not in (0, 1):
            continue
        atom = pickups.types[f["type"]][4]
        if atom == 10:
            got = pickups.read_f32(param_payload, base + f["offset"])
        elif atom == 1:
            got = pickups.read_bool(param_payload, base + f["offset"])
        else:
            got = pickups.read_u32(param_payload, base + f["offset"])
        check(f"global.{name}", near(got, sys_manifest["parameters"][name]),
              {"got": got, "expected": sys_manifest["parameters"][name]})

    types_field = pickups.field(sys_type, "Types")
    tcomp, telem, tlen = struct.unpack_from("<2HI", sys_payload, types_field["offset"])
    handles = []
    for i in range(tlen):
        comp_entry = pickups.comp(system_record, tcomp)
        at = pickups.element_base(system_record, tcomp, telem + i)
        ref_index = struct.unpack_from("<I", sys_payload, at)[0]
        ref_id, ref_type, ref_record = pickups.refs[ref_index]
        handles.append((ref_index, ref_id, ref_type, ref_record))
    check("system.typeHandles", len(handles) == 11
          and len(manifest["entities"]) == 11
          and {h[3] for h in handles} == {e["record"] for e in manifest["entities"]},
          {"handles": len(handles), "entities": len(manifest["entities"])})

    # ---------------------------------------------------------- entities
    slot_names = ("Normal", "DoubleTap", "Reversed", "ReversedDoubleTap", "Mini",
                  "Modified", "ReversedModified")
    all_strings = set()
    for flask in (pickups, dynamic):
        for i in range(len(flask.records)):
            all_strings |= {p.decode("latin-1") for p in flask.strings_of(i).split(b"\0") if len(p) > 2}

    for entity in manifest["entities"]:
        rec = entity["record"]
        payload = pickups.payload(rec)
        ptype = pickups.type_index("PickupType")
        check(f"entity.{entity['pickupLabel']}.record",
              pickups.record_id(rec) == entity["refId"]
              and pickups.type_name(pickups.record_type(rec)) == "PickupType"
              and entity["pickupLabel"] in labels("Pickup"),
              {"record": rec, "id": pickups.record_id(rec)})
        type_field = pickups.field(ptype, "Type")
        index = pickups.read_u32(payload, type_field["offset"])
        check(f"entity.{entity['pickupLabel']}.typeLabel",
              index == entity["typeField"]["labelIndex"]
              and labels("Pickup")[index] == entity["pickupLabel"],
              {"index": index, "label": labels("Pickup")[index]})
        # direct scalar checks
        for name, atom in (("BaseProbability", "f32"), ("DoNotRandomise", "bool"),
                           ("PickupSpecialFXBeginCycle", "f32"),
                           ("PickupSpecialFXEndCycle", "f32")):
            field = pickups.field(ptype, name)
            got = (pickups.read_f32(payload, field["offset"]) if atom == "f32"
                   else pickups.read_bool(payload, field["offset"]))
            expect = entity["baseProbability"] if name == "BaseProbability" else (
                entity["doNotRandomise"] if name == "DoNotRandomise" else
                entity["specialEffectCycle"]["begin" if name.endswith("BeginCycle") else "end"])
            check(f"entity.{entity['pickupLabel']}.{name}", near(got, expect),
                  {"got": got, "expected": expect})
        ai_field = pickups.field(ptype, "AIUsageType")
        check(f"entity.{entity['pickupLabel']}.aiUsage",
              pickups.read_u32(payload, ai_field["offset"]) == entity["aiUsageType"]["labelIndex"],
              entity["aiUsageType"])

        # every level in the manifest must resolve to a real PickupLevel
        for slot, level in entity["levels"].items():
            lv_rec = level["record"]
            check(f"level.{entity['pickupLabel']}.{slot}.record",
                  pickups.type_name(pickups.record_type(lv_rec)) == "PickupLevel"
                  and pickups.record_id(lv_rec) == level["refId"],
                  {"record": lv_rec})
            lv_payload = pickups.payload(lv_rec)
            lv_type = pickups.record_type(lv_rec)
            bd_field = pickups.field(lv_type, "BalancingData")
            comp, element = struct.unpack_from("<2H", lv_payload, bd_field["offset"])
            if comp == 0xFFFF:
                check(f"level.{entity['pickupLabel']}.{slot}.balancing", level["balancing"] is None,
                      "null balancing")
                continue
            bd_type = pickups.comp(lv_rec, comp)[0]
            check(f"level.{entity['pickupLabel']}.{slot}.balancingType",
                  pickups.type_name(bd_type) == level["balancingType"]
                  and level["balancing"]["$type"] == level["balancingType"],
                  {"record": lv_rec, "type": pickups.type_name(bd_type)})
            rec2, abs_comp, base = pickups.ptr(lv_rec, comp, element)
            bd_payload = pickups.payload(rec2)
            for f in pickups.all_fields(bd_type):
                name = f["name"]
                if f["array"] or f["behaviour"] not in (0, 1):
                    continue
                if f["behaviour"] == 1:
                    got = pickups.read_u32(bd_payload, base + f["offset"])
                    ok = got == level["balancing"][name]["labelIndex"]
                    check(f"level.{entity['pickupLabel']}.{slot}.{name}", ok,
                          {"got": got, "expected": level["balancing"][name]["labelIndex"]})
                    continue
                atom = pickups.types[f["type"]][4]
                if atom == 1:
                    got = pickups.read_bool(bd_payload, base + f["offset"])
                elif atom == 10:
                    got = pickups.read_f32(bd_payload, base + f["offset"])
                elif atom == 4:
                    got = pickups.read_i32(bd_payload, base + f["offset"])
                else:
                    got = pickups.read_u32(bd_payload, base + f["offset"])
                check(f"level.{entity['pickupLabel']}.{slot}.{name}",
                      near(got, level["balancing"][name]),
                      {"got": got, "expected": level["balancing"][name]})
            # graph array
            graph_field = pickups.field(lv_type, "BalancingGraph")
            graph_type = graph_field["type"]
            # inline BalancingGraph at graph_field.offset (struct, not pointer)
            gtype = graph_type
            gfield = pickups.field(gtype, "EffectGraph")
            acomp, aelement, alen = struct.unpack_from(
                "<2HI", lv_payload, graph_field["offset"] + gfield["offset"])
            check(f"level.{entity['pickupLabel']}.{slot}.graphCount",
                  alen == len(level["balancingGraph"]["keyframes"]),
                  {"got": alen, "expected": len(level["balancingGraph"]["keyframes"])})
            if alen:
                kbase = pickups.element_base(lv_rec, acomp, aelement)
                ktype = pickups.comp(lv_rec, acomp)[0]
                for k, frame in enumerate(level["balancingGraph"]["keyframes"]):
                    for n, name in enumerate(("Time", "Value", "InTangent", "OutTangent")):
                        got = pickups.read_f32(lv_payload,
                                               kbase + k * pickups.types[ktype][5] + n * 4)
                        check(f"level.{entity['pickupLabel']}.{slot}.graph.{k}.{name}",
                              near(got, frame[name]), {"got": got, "expected": frame[name]})
            # specialFX array counts
            if level["specialFx"]:
                fx_field = pickups.field(lv_type, "SpecialFX")
                # SpecialFX is a pointer to PickupBaseSpecialFX
                fcomp, felement = struct.unpack_from("<2H", lv_payload, fx_field["offset"])
                if fcomp != 0xFFFF:
                    frec, _, fbase = pickups.ptr(lv_rec, fcomp, felement)
                    fp = pickups.payload(frec)
                    fx_type = pickups.comp(lv_rec, fcomp)[0]
                    for array in level["specialFx"]["arrays"]:
                        f = pickups.field(fx_type, array["slot"])
                        c, e, n = struct.unpack_from("<2HI", fp, fbase + f["offset"])
                        check(f"level.{entity['pickupLabel']}.{slot}.fx.{array['slot']}",
                              n == array["count"], {"got": n, "expected": array["count"]})
        # asset strings must exist in a decoded string table
        missing = [s for s in entity["levels"].get("Normal", {}).get("assets", [])
                   if s not in all_strings]
        check(f"entity.{entity['pickupLabel']}.assets",
              not missing, {"assets": len(entity['levels'].get('Normal', {}).get('assets', [])),
                            "missing": missing[:5]})

    # --------------------------------------------------------------- HUD
    hud = manifest["hud"]
    ui_config = next(i for i in range(len(ui.records))
                     if ui.type_name(ui.record_type(i)) == "UiXtConfig")
    ui_type = ui.record_type(ui_config)
    perk_field = ui.field(ui_type, "PerkDisplayParameters")
    perk_type = perk_field["type"]
    ui_payload = ui.payload(ui_config)
    base = perk_field["offset"]
    for entry, expected in hud["perkEntries"].items():
        f = ui.field(perk_type, entry)
        got = ui.read_i32(ui_payload, base + f["offset"]) if entry else None
        check(f"hud.{entry}.textureIndex", got == expected["texture_index"],
              {"got": got, "expected": expected["texture_index"]})
        for slot in ("colour_fill", "colour_glow", "colour_text"):
            sf = ui.field(ui.type_index("UIPerkInfo"), slot)
            sbase = base + f["offset"] + sf["offset"]
            strings = ui.strings_of(ui_config)
            off = ui.read_u32(ui_payload, sbase)
            end = strings.find(b"\0", off)
            text = strings[off:end].decode("latin-1") if end >= 0 else None
            check(f"hud.{entry}.{slot}", text == expected[slot]["value"],
                  {"got": text, "expected": expected[slot]["value"]})
    for entity in manifest["entities"]:
        for key, entry in entity["hud"]["entries"].items():
            check(f"hud.entity.{entity['pickupLabel']}.{key}",
                  entry == hud["perkEntries"].get(key), {"key": key})

    # ------------------------------------------------------------- audio
    audio_names = {}
    for i in range(len(audio.records)):
        payload = audio.payload(i)
        off = audio.read_u32(payload, 0)
        strings = audio.strings_of(i)
        end = strings.find(b"\0", off)
        audio_names[strings[off:end].decode("latin-1")] = {"record": i,
                                                           "refId": audio.record_id(i)}
    for entity in manifest["entities"]:
        for row in entity["audio"]["entities"]:
            check(f"audio.{entity['pickupLabel']}.{row['name']}",
                  audio_names.get(row["name"]) == {"record": row["record"],
                                                   "refId": row["refId"]},
                  row["name"])

    # ------------------------------------------------------------- modes
    modes = manifest["modes"]
    race_type = multi.type_index("MultiplayerRace")
    race_fields = {f["name"]: f for f in multi.type_fields(race_type)}
    enum_map = {}
    for name in ("MpPickup", "MpPowerupRespawn", "MpRandomPowerups", "DamageMode"):
        enum_map[name] = [f["name"] for f in multi.type_fields(multi.type_index(name))]
    race_labels = [f["name"] for f in multi.type_fields(
        multi.field(race_type, "type")["type"])]
    races = [i for i in range(len(multi.records)) if multi.record_type(i) == race_type]
    check("modes.raceCount", len(races) == 439 and len(modes["races"]) == 439,
          {"records": len(races), "manifest": len(modes["races"])})
    by_record = {r["record"]: r for r in modes["races"]}
    agg = {name: {label: 0 for label in enum_map[name]}
           for name in ("MpPickup", "MpPowerupRespawn", "MpRandomPowerups", "DamageMode")}
    patterns = {}
    for rec in races:
        payload = multi.payload(rec)
        row = by_record[rec]
        type_index = multi.read_u32(payload, race_fields["type"]["offset"])
        bits = multi.read_u32(payload, race_fields["powerups"]["offset"])
        labels = [l for i, l in enumerate(enum_map["MpPickup"]) if bits & (1 << i)]
        resp = multi.read_u32(payload, race_fields["poweruprespawn"]["offset"])
        rand = multi.read_u32(payload, race_fields["randompowerups"]["offset"])
        dmg = multi.read_u32(payload, race_fields["damage_mode"]["offset"])
        prob = multi.read_u32(payload, race_fields["PickupProbabilities"]["offset"])
        ok = (row["type"]["index"] == type_index and row["powerups"]["bits"] == bits
              and row["powerups"]["labels"] == labels
              and row["powerupRespawn"]["index"] == resp
              and row["randomPowerups"]["index"] == rand
              and row["damageMode"]["index"] == dmg
              and row["pickupProbabilityList"] == (None if prob == 0xFFFFFFFF else prob))
        check(f"mode.race.{rec}", ok, {"bits": bits})
        for label in labels:
            agg["MpPickup"][label] += 1
        agg["MpPowerupRespawn"][enum_map["MpPowerupRespawn"][resp]] += 1
        agg["MpRandomPowerups"][enum_map["MpRandomPowerups"][rand]] += 1
        agg["DamageMode"][enum_map["DamageMode"][dmg]] += 1
        patterns[str(bits)] = patterns.get(str(bits), 0) + 1
    check("modes.aggregate.powerups", agg["MpPickup"] == modes["aggregate"]["powerupEnabled"],
          agg["MpPickup"])
    check("modes.aggregate.respawn", agg["MpPowerupRespawn"] == modes["aggregate"]["respawn"],
          agg["MpPowerupRespawn"])
    check("modes.aggregate.random", agg["MpRandomPowerups"] == modes["aggregate"]["randomPowerups"],
          agg["MpRandomPowerups"])
    check("modes.aggregate.damage", agg["DamageMode"] == modes["aggregate"]["damageMode"],
          agg["DamageMode"])
    check("modes.aggregate.patterns", patterns == modes["aggregate"]["powerupBitPatterns"],
          patterns)

    config = modes["config"]
    config_type = multi.type_index("MultiplayerConfig")
    config_record = next(i for i in range(len(multi.records))
                         if multi.record_type(i) == config_type)
    cp = multi.payload(config_record)
    check("modes.config.long", near(multi.read_f32(
        cp, multi.field(config_type, "powerup_respawn_toggle_long")["offset"]),
        config["powerupRespawnToggleLong"]), config["powerupRespawnToggleLong"])
    check("modes.config.veryLong", near(multi.read_f32(
        cp, multi.field(config_type, "powerup_respawn_toggle_very_long")["offset"]),
        config["powerupRespawnToggleVeryLong"]), config["powerupRespawnToggleVeryLong"])
    defaults_field = multi.field(config_type, "defaults")
    dbase = defaults_field["offset"]
    for name in ("powerup_respawn", "random_powerups", "damage"):
        f = multi.field(defaults_field["type"], name)
        got = multi.read_u32(cp, dbase + f["offset"])
        expect = config["defaults"][name]["labelIndex"]
        check(f"modes.defaults.{name}", got == expect, {"got": got, "expected": expect})
    online = modes["onlinePickupParameters"]
    online_record = next(i for i in range(len(multi.records))
                         if multi.type_name(multi.record_type(i)) == "PickupParametersStoredOnline")
    op = multi.payload(online_record)
    otype = multi.record_type(online_record)
    for name in ("RecoveryTime", "RecoveryTimeSpeedMod"):
        got = multi.read_f32(op, multi.field(otype, name)["offset"])
        check(f"modes.online.{name}", near(got, online[name]),
              {"got": got, "expected": online[name]})
    check("modes.online.record", online["record"] == online_record
          and online["refId"] == multi.record_id(online_record), online_record)

    # ---------------------------------------------------------- abilities
    ability_type = multi.type_index("MultiplayerAbility")
    ability_records = [i for i in range(len(multi.records)) if multi.record_type(i) == ability_type]
    check("abilities.count", len(ability_records) == 33 == len(modes["abilities"]),
          {"records": len(ability_records), "manifest": len(modes["abilities"])})
    for row in modes["abilities"]:
        rec = row["record"]
        payload = multi.payload(rec)
        atype = multi.record_type(rec)
        ok = (multi.record_id(rec) == row["refId"]
              and multi.read_u32(payload, multi.field(atype, "AbilityId")["offset"])
              == row["abilityId"]["labelIndex"]
              and near(multi.read_f32(payload, multi.field(atype, "AbilityValue")["offset"]),
                       row["abilityValue"]))
        check(f"ability.{rec}", ok, {"id": row["refId"]})

    # --------------------------------------------------- probability lists
    prob_lists = [r for r in manifest["pickupProbabilityLists"]]
    check("prob.count", len(prob_lists) == 51, len(prob_lists))
    for row in prob_lists:
        rec = row["record"]
        check(f"prob.{rec}.id", pickups.record_id(rec) == row["refId"],
              pickups.record_id(rec))
        payload = pickups.payload(rec)
        atype = pickups.record_type(rec)
        field = pickups.field(atype, "PickupProbabilities")
        comp, element, length = struct.unpack_from("<2HI", payload, field["offset"])
        check(f"prob.{rec}.count", length == len(row["items"]),
              {"got": length, "expected": len(row["items"])})
        if comp != 0xFFFF:
            base = pickups.element_base(rec, comp, element)
            etype = pickups.comp(rec, comp)[0]
            for k, item in enumerate(row["items"]):
                off = base + k * pickups.types[etype][5]
                got_type = pickups.read_u32(payload, off)
                got_prob = pickups.read_f32(payload, off + 4)
                check(f"prob.{rec}.{k}",
                      got_type == item["pickup"]["labelIndex"] and near(got_prob, item["probability"]),
                      {"type": got_type, "prob": got_prob})

    # ------------------------------------------- native schema agreement
    if not NATIVE.exists():
        check("native.present", False, str(NATIVE))
    else:
        for name in ("pickups", "multiplayer", "ui", "audio", "dynamiceffects", "singleplayer"):
            xt = OUT / f"{name}.xt"
            proc = subprocess.run([str(NATIVE), str(xt)], capture_output=True, text=True)
            ok = proc.returncode == 0
            native = json.loads(proc.stdout) if ok else {}
            flask = flasks[name]
            ok = ok and native.get("status") == "ok"
            ok = ok and len(native.get("types", [])) == len(flask.types)
            ok = ok and len(native.get("fields", [])) == len(flask.fields)
            ok = ok and len(native.get("records", [])) == len(flask.records)
            mismatch = None
            if ok:
                for i, row in enumerate(native["records"]):
                    if (row["componentStart"] != flask.comp_start[i]
                            or row["dataOffset"] != flask.data_base + flask.data_start[i]
                            or row["dataBytes"] != flask.records[i][2]):
                        mismatch = {"record": i, "native": row}
                        break
            check(f"native.{name}", ok and mismatch is None,
                  {"returncode": proc.returncode, "mismatch": mismatch,
                   "records": len(flask.records)})

    # ------------------------------------------------------- single player
    sp = flasks["singleplayer"]
    single = manifest["singlePlayer"]
    sp_type = sp.type_index("AmaxEvent")
    sp_fields = {f["name"]: f for f in sp.all_fields(sp_type)}
    sp_records = [i for i in range(len(sp.records)) if sp.record_type(i) == sp_type]
    check("sp.eventCount", len(sp_records) == 86 == len(single["events"]),
          {"records": len(sp_records), "manifest": len(single["events"])})
    sp_by_record = {e["record"]: e for e in single["events"]}
    diff_offsets = {}
    for level in ("Easy", "Medium", "Hard"):
        base = sp_fields[level]["offset"]
        mod = next(f["offset"] for f in sp.type_fields(sp_fields[level]["type"])
                   if f["name"] == "PowerUpDamageModifier")
        diff_offsets[level] = base + mod
    for rec in sp_records:
        payload = sp.payload(rec)
        row = sp_by_record[rec]
        strings = sp.strings_of(rec)
        name_off = sp.read_u32(payload, sp_fields["Name"]["offset"])
        end = strings.find(b"\0", name_off) if name_off < len(strings) else -1
        name = strings[name_off:end].decode("latin-1") if end >= 0 else None
        ok = (sp.record_id(rec) == row["refId"] and name == row["name"]
              and sp.read_bool(payload, sp_fields["PickupsDoNotRespawn"]["offset"])
              == row["pickupsDoNotRespawn"]
              and near(sp.read_f32(payload, sp_fields["PickupDisableTime"]["offset"]),
                       row["pickupDisableTime"])
              and sp.read_i32(payload, sp_fields["PickupSpawnLevel"]["offset"])
              == row["pickupSpawnLevel"]
              and sp.read_bool(payload, sp_fields["AIDontGoForPickups"]["offset"])
              == row["aiDontGoForPickups"])
        for level, offset in diff_offsets.items():
            ok = ok and near(sp.read_f32(payload, offset),
                             row["difficulties"][level]["powerUpDamageModifier"])
        check(f"sp.event.{rec}", ok, {"name": name})
    check("sp.aggregate", single["aggregate"]["eventCount"] == 86
          and single["aggregate"]["pickupsDoNotRespawn"] == 0
          and single["aggregate"]["aiPerkUseEntries"] == 0,
          single["aggregate"])

    # ------------------------------------------------------ counts/hashes
    body = {k: v for k, v in manifest.items() if k != "hashes"}
    recomputed = sha(json.dumps(body, sort_keys=True, separators=(",", ":")).encode())
    check("hash.manifestContent", recomputed == manifest["hashes"]["manifestContent"],
          {"recomputed": recomputed, "recorded": manifest["hashes"]["manifestContent"]})
    check("counts.pickupTypes", manifest["counts"]["pickupTypes"] == 11,
          manifest["counts"]["pickupTypes"])
    check("counts.races", manifest["counts"]["races"] == 439, manifest["counts"]["races"])

    failures = [c for c in checks if not c["ok"]]
    report = {
        "schema": "blur-powerups-verify/1",
        "manifest": str(args.manifest.relative_to(ROOT)).replace("\\", "/"),
        "checks": len(checks),
        "passed": len(checks) - len(failures),
        "failed": len(failures),
        "status": "PASS" if not failures else "FAIL",
        "failures": failures,
        "evidence": {
            "manifestSha256": sha(args.manifest.read_bytes()),
            "manifestContent": manifest["hashes"]["manifestContent"],
            "sources": {s["name"]: {"sha256Decoded": s["sha256Decoded"],
                                    "logicalBytes": s["logicalBytes"]}
                        for s in manifest["sources"]},
        },
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "verify.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    print(f"checks {report['checks']} passed {report['passed']} failed {report['failed']} "
          f"status {report['status']}")
    for failure in failures[:12]:
        print("FAIL", failure["id"], failure["detail"])
    raise SystemExit(0 if not failures else 1)


if __name__ == "__main__":
    main()
