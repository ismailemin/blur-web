"""Independent verifier for ``_work/powerups/supershield.json`` (SS1).

This reader does **not** import ``xt_decode``. It re-parses the FLSK tables and
payloads at direct offsets, re-reads the PAK entries, re-hashes the source
citations, re-checks the existing 1,783-check powerups manifest, and re-derives
every SuperShield value in the manifest.

Output: ``_work/powerups/supershield.verify.json``.
"""
from __future__ import annotations

import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from inspect_asset_layout import pak_index  # noqa: E402

PACK = "gamedata.pak"
GAME = ROOT / "game-data" / "Blur"
OUT = ROOT / "_work" / "powerups" / "supershield.verify.json"
MANIFEST = ROOT / "_work" / "powerups" / "supershield.json"
SOURCE_ROOT = ROOT / "_work" / "engine-vehicle-spike" / "tree"

TABLE_ROWS = [
    ("types", 12, 4096),
    ("bases", 4, 65535),
    ("fields", 8, 100000),
    ("strings", 1, 4 * 1024 * 1024),
    ("refs", 8, 65535),
    ("records", 16, 65535),
    ("components", 6, 100000),
    ("data", 1, 64 * 1024 * 1024),
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def decode_pc_strings(encoded: bytes) -> bytes:
    if not encoded:
        return b""
    out = bytearray(len(encoded))
    previous = 0xCC
    for i in range(len(encoded) - 1):
        decoded = (previous - (encoded[i] ^ 0xB3)) & 255
        out[i] = decoded
        previous = (previous + decoded - i) & 255
    out[-1] = 0
    return bytes(out)


def canonical_hash(obj: dict) -> str:
    body = {k: v for k, v in obj.items() if k != "hashes"}
    return sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode())


def load_entry(index: dict, path: str) -> dict:
    entry = next(r for r in index["entries"] if r["path"].lower() == path.lower())
    with (GAME / "cache" / PACK).open("rb") as stream:
        stream.seek(entry["offset"])
        stored = stream.read(entry["stored_bytes"])
    inflater = zlib.decompressobj()
    data = inflater.decompress(stored, entry["logical_bytes"] + 1)
    return {
        "path": entry["path"],
        "offset": entry["offset"],
        "storedBytes": entry["stored_bytes"],
        "logicalBytes": entry["logical_bytes"],
        "pathCrc32": entry["path_crc32"],
        "sha256Decoded": sha256(data),
        "bytes": data,
    }


class RawFlask:
    def __init__(self, data: bytes):
        if not 72 <= len(data) <= 64 * 1024 * 1024:
            raise ValueError("XT bounds")
        header = struct.unpack_from("<18I", data)
        if header[0] != 0x464C534B or header[1] not in (1, 2):
            raise ValueError("XT tag/version")
        self.version = header[1]
        self.data = data
        self.tables = {}
        for i, (name, size, limit) in enumerate(TABLE_ROWS):
            offset, count = header[2 + i * 2:4 + i * 2]
            if offset % 4 or count > limit or offset > len(data) or count * size > len(data) - offset:
                raise ValueError(f"{name} bounds")
            self.tables[name] = {"offset": offset, "count": count, "size": size}
        self.types = self._rows("types", "6H")
        self.bases = self._rows("bases", "2H")
        self.fields = self._rows("fields", "3H2B")
        self.refs = self._rows("refs", "I2H")
        self.records = self._rows("records", "4I")
        self.components = self._rows("components", "3H")
        self.strings = self._strings()
        self._data_base = self.tables["data"]["offset"]
        self._component_start = []
        self._data_start = []
        c = d = 0
        for row in self.records:
            self._component_start.append(c)
            self._data_start.append(d)
            c += row[1]
            d += row[2] + row[3]

    def _rows(self, name, fmt):
        t = self.tables[name]
        return [struct.unpack_from("<" + fmt, self.data, t["offset"] + i * t["size"])
                for i in range(t["count"])]

    def _strings(self):
        t = self.tables["strings"]
        raw = self.data[t["offset"]:t["offset"] + t["count"]]
        out = bytearray(raw)
        if self.version == 2 and out:
            previous = 0xCC
            for i, byte in enumerate(raw[:-1]):
                decoded = (previous - (byte ^ 0xB3)) & 255
                out[i] = decoded
                previous = (previous + decoded - i) & 255
            out[-1] = 0
        return bytes(out)

    def name(self, at):
        if at >= len(self.strings):
            raise ValueError("name offset")
        end = self.strings.find(b"\0", at)
        if end < 0:
            raise ValueError("unterminated name")
        return self.strings[at:end].decode("ascii")

    def type_name(self, index):
        return self.name(self.types[index][0])

    def type_fields(self, index):
        _n, nf, _nb, _b, _a, _s = self.types[index]
        start = sum(self.types[i][1] for i in range(index))
        return [{"name": self.name(fn), "typeIndex": None if ft == 65535 else ft,
                 "offset": off, "behaviour": fb, "array": bool(arr)}
                for fn, ft, off, fb, arr in self.fields[start:start + nf]]

    def type_labels(self, index):
        return [f["name"] for f in self.type_fields(index)]

    def type_bases(self, index):
        _n, _nf, nb, _b, _a, _s = self.types[index]
        start = sum(self.types[i][2] for i in range(index))
        return [{"typeIndex": bt, "offset": off} for bt, off in self.bases[start:start + nb]]

    def all_fields(self, index, base=0):
        out = []
        for b in self.type_bases(index):
            out.extend(self.all_fields(b["typeIndex"], base + b["offset"]))
        for f in self.type_fields(index):
            out.append({**f, "offset": base + f["offset"]})
        return out

    def record_type(self, index):
        return self.refs[self.records[index][0]][1]

    def record_id(self, index):
        return self.refs[self.records[index][0]][0]

    def record_payload(self, index):
        rec = self.records[index]
        return self.data[self._data_base + self._data_start[index]:
                         self._data_base + self._data_start[index] + rec[2]]

    def record_strings(self, index):
        rec = self.records[index]
        base = self._data_base + self._data_start[index] + rec[2]
        return decode_pc_strings(self.data[base:base + rec[3]])

    def component_offset(self, record, component):
        off = 0
        for typ, count, behaviour in self.components[
                self._component_start[record]:
                self._component_start[record] + component]:
            off = (off + count * (self.types[typ][5] if behaviour == 0 else 4) + 3) & ~3
        return off

    def component_type(self, record, component):
        return self.components[self._component_start[record] + component]


def u32(payload, off):
    return struct.unpack_from("<I", payload, off)[0]


def u16(payload, off):
    return struct.unpack_from("<H", payload, off)[0]


def f32(payload, off):
    return struct.unpack_from("<f", payload, off)[0]


def read_atom(flask: RawFlask, type_index: int, payload: bytes, off: int):
    atom = flask.types[type_index][4]
    if atom == 1:
        return u32(payload, off) != 0
    if atom == 10:
        return f32(payload, off)
    if atom in (2, 3, 4, 5):
        fmt = {2: "<b", 3: "<h", 4: "<i", 5: "<q"}[atom]
        return struct.unpack_from(fmt, payload, off)[0]
    if atom in (6, 7, 8, 9):
        fmt = {6: "<B", 7: "<H", 8: "<I", 9: "<Q"}[atom]
        return struct.unpack_from(fmt, payload, off)[0]
    return None


def probability_items(flask: RawFlask, record: int):
    payload = flask.record_payload(record)
    record_type = flask.record_type(record)
    field = next(f for f in flask.type_fields(record_type)
                 if f["name"] == "PickupProbabilities")
    comp, elem, length = struct.unpack_from("<2HI", payload, field["offset"])
    item_type = flask.component_type(record, comp)[0]
    stride = flask.types[item_type][5]
    base = flask.component_offset(record, comp) + elem * stride
    enum_type = next(f["typeIndex"] for f in flask.type_fields(item_type)
                     if f["name"] == "PickupType")
    labels = flask.type_labels(enum_type)
    return [{"pickup": labels[u32(payload, base + i * stride)],
             "labelIndex": u32(payload, base + i * stride),
             "probability": f32(payload, base + i * stride + 4)}
            for i in range(length)]


class Verifier:
    def __init__(self):
        self.checks = 0
        self.failures = []

    def check(self, condition, label):
        self.checks += 1
        if not condition:
            self.failures.append(label)
            raise AssertionError(label)

    def equal(self, got, want, label):
        self.check(got == want, f"{label}: got {got!r} want {want!r}")

    def close(self, got, want, label, eps=1e-6):
        self.check(abs(got - want) <= eps, f"{label}: got {got!r} want {want!r}")

    def section(self, label):
        print(f"[verify] {label}")


def main() -> None:
    v = Verifier()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    index = pak_index(GAME / "cache" / PACK)
    entries = {
        "pickups.bin": load_entry(index, "\\gamedata\\xt\\pickups.bin"),
        "multiplayer.bin": load_entry(index, "\\gamedata\\xt\\multiplayer.bin"),
        "singleplayer.bin": load_entry(index, "\\gamedata\\xt\\singleplayer.bin"),
        "ui.bin": load_entry(index, "\\gamedata\\xt\\ui.bin"),
        "audioentities.bin": load_entry(index, "\\gamedata\\xt\\audioentities.bin"),
    }

    v.section("source hashes and extents")
    by_name = {s["path"].split("\\")[-1]: s for s in manifest["sources"]}
    for name, row in entries.items():
        claim = by_name[name]
        v.equal(row["sha256Decoded"], claim["sha256Decoded"], f"{name} sha256")
        v.equal(row["offset"], claim["offset"], f"{name} offset")
        v.equal(row["storedBytes"], claim["storedBytes"], f"{name} stored")
        v.equal(row["logicalBytes"], claim["logicalBytes"], f"{name} logical")
        v.equal(row["pathCrc32"], claim["pathCrc32"], f"{name} crc")

    pick = RawFlask(entries["pickups.bin"]["bytes"])
    mp = RawFlask(entries["multiplayer.bin"]["bytes"])
    sp = RawFlask(entries["singleplayer.bin"]["bytes"])
    ui = RawFlask(entries["ui.bin"]["bytes"])
    audio = RawFlask(entries["audioentities.bin"]["bytes"])

    v.section("existing 1,783-check powerups manifest unchanged")
    existing_path = ROOT / "_work" / "powerups" / "powerups.json"
    existing_bytes = existing_path.read_bytes()
    v.equal(sha256(existing_bytes), "6ee5a3e699187086665b4b5330abcda29859e77b4464edae65e6ed00b7bc73d7",
            "powerups.json sha256")
    existing = json.loads(existing_bytes.decode("utf-8"))
    v.equal(existing["hashes"]["manifestContent"],
            "543b059ab7bc511cc61947ba584ff461f8f54b86ea02c06fbd2538f5d2c654df",
            "powerups.json content hash")
    verify = json.loads((ROOT / "_work" / "powerups" / "verify.json").read_text(encoding="utf-8"))
    v.equal(verify["checks"], 1783, "existing verify checks")
    v.equal(verify["failed"], 0, "existing verify failures")
    v.equal(manifest["existingManifest"]["sha256"], sha256(existing_bytes),
            "manifest existing sha")
    v.equal(manifest["existingManifest"]["contentHash"], existing["hashes"]["manifestContent"],
            "manifest existing content hash")
    v.equal(manifest["existingManifest"]["verifierChecks"], verify["checks"],
            "manifest existing checks")

    v.section("SuperShield PickupType")
    entity = manifest["entity"]
    rec = entity["record"]
    v.equal(pick.record_id(rec), entity["refId"], "entity refId")
    v.equal(pick.type_name(pick.record_type(rec)), "PickupType", "entity type")
    payload = pick.record_payload(rec)
    v.equal(pick._data_base + pick._data_start[rec], entity["payloadAbs"], "entity payload abs")
    v.equal(pick.records[rec][2], entity["payloadBytes"], "entity payload bytes")
    type_field = entity["typeField"]
    v.equal(type_field["fieldOffset"], 4, "Type field offset")
    v.equal(pick._data_base + pick._data_start[rec] + 4, type_field["absOffset"],
            "Type field abs")
    type_index = next(f["typeIndex"] for f in pick.type_fields(pick.record_type(rec))
                      if f["name"] == "Type")
    labels = pick.type_labels(type_index)
    v.equal(labels[u32(payload, 4)], "SuperShield", "Type label")
    v.equal(u32(payload, 4), type_field["labelIndex"], "Type label index")
    v.equal(f32(payload, 52), entity["baseProbability"]["value"], "BaseProbability")
    v.equal(entity["baseProbability"]["value"], 0.0, "BaseProbability zero")
    v.equal(u32(payload, 48) != 0, entity["doNotRandomise"]["value"], "DoNotRandomise")
    v.equal(entity["doNotRandomise"]["value"], False, "DoNotRandomise false")
    normal = entity["normal"]
    v.equal(normal["handleFieldOffset"], 8, "Normal handle offset")
    v.equal(normal["handleAbsOffset"], pick._data_base + pick._data_start[rec] + 8,
            "Normal handle abs")
    ref_index = u32(payload, 8)
    ref_id, ref_type, ref_record = pick.refs[ref_index]
    v.equal(ref_id, normal["refId"], "Normal refId")
    v.equal(ref_record, normal["record"], "Normal record")
    v.equal(pick.type_name(ref_type), "PickupLevel", "Normal type")
    v.equal(pick.record_id(ref_record), 2601055738, "Normal record id")
    v.equal(ref_record, 523, "Normal record index")
    v.equal(normal["payloadAbs"], pick._data_base + pick._data_start[ref_record],
            "Normal payload abs")
    v.equal(normal["payloadBytes"], pick.records[ref_record][2], "Normal payload bytes")

    v.section("PickupLevel balancing pointer and absolute offsets")
    level_payload = pick.record_payload(ref_record)
    level_abs = pick._data_base + pick._data_start[ref_record]
    comp = u16(level_payload, 12)
    elem = u16(level_payload, 14)
    bal = manifest["balancing"]
    v.equal(comp, bal["component"], "balancing component")
    v.equal(elem, bal["element"], "balancing element")
    comp_type, comp_count, comp_behaviour = pick.component_type(ref_record, comp)
    v.equal(comp_behaviour, 0, "balancing component behaviour")
    v.equal(pick.type_name(comp_type), bal["type"], "balancing type")
    v.equal(comp_count, bal["componentCount"], "balancing component count")
    comp_offset = pick.component_offset(ref_record, comp)
    v.equal(comp_offset, bal["componentOffsetInPayload"], "balancing component offset")
    stride = pick.types[comp_type][5]
    v.equal(stride, bal["sizeBytes"], "balancing size")
    base = comp_offset + elem * stride
    v.equal(base, bal["payloadOffset"], "balancing payload offset")
    v.equal(level_abs + base, bal["absOffset"], "balancing abs offset")
    v.equal(bal["absOffset"], 96048, "balancing abs literal")
    bal_fields = {f["name"]: f for f in pick.all_fields(comp_type)}
    for fname, claim in bal["fields"].items():
        f = bal_fields[fname]
        v.equal(f["offset"], claim["structOffset"], f"{fname} struct offset")
        v.equal(base + f["offset"], claim["payloadOffset"], f"{fname} payload offset")
        v.equal(level_abs + base + f["offset"], claim["absOffset"], f"{fname} abs offset")
        got = read_atom(pick, f["typeIndex"], level_payload, base + f["offset"])
        if isinstance(got, float):
            v.close(got, claim["value"], f"{fname} value")
        else:
            v.equal(got, claim["value"], f"{fname} value")
        if fname in ("Health", "BrakingBoost"):
            v.equal(claim["status"], "serialized-unused", f"{fname} status")
        else:
            v.equal(claim["status"], "serialized", f"{fname} status")
    v.equal(bal["fields"]["Lifetime"]["value"], 10.0, "Lifetime 10")
    v.equal(bal["fields"]["Health"]["value"], 50.0, "Health 50 serialized")
    v.equal(bal["fields"]["DamagePointsOnImpact"]["value"], 100, "DamagePointsOnImpact 100")
    v.equal(bal["fields"]["IncreasedMass"]["value"], 10000, "IncreasedMass 10000")
    v.equal(bal["fields"]["BrakingBoost"]["value"], 1500.0, "BrakingBoost 1500")

    v.section("HUD UiPerkInfo.superShield")
    hud = manifest["hud"]
    hud_rec = hud["source"]["record"]
    v.equal(ui.record_id(hud_rec), hud["source"]["refId"], "UiXtConfig refId")
    v.equal(ui.type_name(ui.record_type(hud_rec)), "UiXtConfig", "UiXtConfig type")
    ui_payload = ui.record_payload(hud_rec)
    perk_field = next(f for f in ui.type_fields(ui.record_type(hud_rec))
                      if f["name"] == "PerkDisplayParameters")
    v.equal(perk_field["offset"], hud["source"]["fieldOffset"], "HUD field offset")
    perk_type = next(i for i in range(len(ui.types))
                     if ui.type_name(i) == "UiPerkDisplayParameters")
    perk_offsets = {f["name"]: f["offset"] for f in ui.all_fields(perk_type)}
    v.equal(perk_offsets["superShield"], hud["source"]["entryOffset"], "HUD entry offset")
    v.equal(ui._data_base + ui._data_start[hud_rec] + perk_field["offset"] +
            perk_offsets["superShield"], hud["source"]["entryAbsOffset"], "HUD entry abs")
    entry_off = perk_field["offset"] + perk_offsets["superShield"]
    v.equal(u32(ui_payload, entry_off), hud["entry"]["texture_index"], "HUD texture_index")
    v.equal(hud["entry"]["texture_index"], 104, "HUD texture_index 104")
    strings = ui.record_strings(hud_rec)
    fill_off = u32(ui_payload, entry_off + 4)
    fill_end = strings.find(b"\0", fill_off)
    v.equal(strings[fill_off:fill_end].decode("latin-1"), hud["entry"]["colour_fill"]["value"],
            "HUD colour_fill")
    text_off = u32(ui_payload, entry_off + 12)
    text_end = strings.find(b"\0", text_off)
    v.equal(strings[text_off:text_end].decode("latin-1"), hud["entry"]["colour_text"]["value"],
            "HUD colour_text")
    v.equal(f"{u32(ui_payload, entry_off + 16):08x}", hud["entry"]["loc_id_name"]["id"],
            "HUD loc id")
    v.equal(f"{u32(ui_payload, entry_off + 20):08x}", hud["entry"]["past_loc_id_name"]["id"],
            "HUD past loc id")

    v.section("audio: no SuperShield entity, Shield exists")
    names = []
    for i in range(len(audio.records)):
        payload = audio.record_payload(i)
        offset = u32(payload, 0)
        strings = audio.record_strings(i)
        end = strings.find(b"\0", offset) if offset < len(strings) else -1
        if end >= 0:
            names.append({"name": strings[offset:end].decode("latin-1"),
                          "record": i, "refId": audio.record_id(i)})
    v.equal(len(names), 228, "audio entity count")
    v.equal([n for n in names if "SuperShield" in n["name"]], [], "no SuperShield audio")
    shield = next(n for n in names if n["name"] == "Shield")
    v.equal(shield["record"], 214, "Shield audio record")
    v.equal(shield["refId"], 3973355297, "Shield audio refId")
    v.equal(manifest["audio"]["superShieldEntity"], None, "manifest no super audio")
    v.equal(manifest["audio"]["shieldEntity"]["refId"], shield["refId"], "manifest Shield audio")

    v.section("probability lists 279 and 737")
    prob = manifest["probability"]
    list_279 = prob["superShieldList"]
    v.equal(pick.record_id(279), list_279["refId"], "list 279 refId")
    v.equal(pick.type_name(pick.record_type(279)), "PickupProbabilityList", "list 279 type")
    raw_279 = probability_items(pick, 279)
    v.equal(len(raw_279), len(list_279["items"]), "list 279 length")
    v.equal(len(raw_279), 10, "list 279 ten items")
    item_type = pick.component_type(279, u16(pick.record_payload(279), 0))[0]
    v.equal(pick.types[item_type][5], 8, "PickupProbability size")
    for i, (got, want) in enumerate(zip(raw_279, list_279["items"])):
        v.equal(got["pickup"], want["pickup"], f"list 279 item {i} label")
        v.equal(got["labelIndex"], want["labelIndex"], f"list 279 item {i} index")
        v.close(got["probability"], want["probability"], f"list 279 item {i} probability")
    v.equal(raw_279[9]["pickup"], "SuperShield", "list 279 item 9 is SuperShield")
    v.equal(raw_279[9]["probability"], 0.0, "list 279 SuperShield probability zero")
    v.equal(list_279["sum"], 0.0, "list 279 sum zero")
    v.equal(prob["bossList"]["record"], 737, "boss list record")
    raw_737 = probability_items(pick, 737)
    v.equal(len(raw_737), 7, "boss list length")
    v.equal(any(item["pickup"] == "SuperShield" for item in raw_737), False,
            "boss list no SuperShield")

    v.section("multiplayer race 203")
    race = prob["multiplayerRace203"]
    v.equal(mp.record_id(203), race["refId"], "race 203 refId")
    v.equal(mp.type_name(mp.record_type(203)), "MultiplayerRace", "race 203 type")
    race_type = next(i for i in range(len(mp.types)) if mp.type_name(i) == "MultiplayerRace")
    race_fields = {f["name"]: f for f in mp.type_fields(race_type)}
    race_payload = mp.record_payload(203)
    v.equal(u32(race_payload, race_fields["powerups"]["offset"]), 0, "race 203 powerups bits")
    v.equal(race["powerupsBits"], 0, "manifest race bits")
    prob_ref = u32(race_payload, race_fields["PickupProbabilities"]["offset"])
    v.equal(prob_ref, race["probabilityRefIndex"], "race 203 probability ref index")
    ref_id, ref_type, ref_record = mp.refs[prob_ref]
    v.equal(ref_id, list_279["refId"], "race 203 probability ref id")
    v.equal(pick.record_id(279), ref_id, "race 203 list resolves to pickups 279")
    v.equal(ref_record, 0xFFFF, "race 203 probability external")
    v.equal(race["probabilityExternal"], True, "manifest external")
    v.equal(race["probabilityRecord"], 279, "manifest record 279")

    v.section("multiplayer selection surface has eight bits")
    mp_type = next(i for i in range(len(mp.types)) if mp.type_name(i) == "MpPickup")
    mp_labels = mp.type_labels(mp_type)
    v.equal(len(mp_labels), 8, "MpPickup count")
    v.equal(any("super" in x.lower() for x in mp_labels), False, "MpPickup no SuperShield")
    v.equal(mp_labels, ["nitro", "shock", "barge", "mine", "shunt", "bolt", "shield",
                        "repair"], "MpPickup labels")
    type_list = next(i for i in range(len(pick.types))
                     if pick.type_name(i) == "PickupTypeList")
    type_list_labels = pick.type_labels(type_list)
    v.equal(len(type_list_labels), 8, "PickupTypeList count")
    v.equal(any("super" in x.lower() for x in type_list_labels), False,
            "PickupTypeList no SuperShield")
    v.equal(manifest["multiplayer"]["mpPickupFlagCount"], 8, "manifest flag count")
    v.equal(manifest["multiplayer"]["pickupTypeListBitCount"], 8, "manifest bit count")
    v.equal(manifest["multiplayer"]["wire"]["pickupFiredTypeNibble"], 10,
            "wire type nibble 10")
    v.check(10 < 16, "10 fits the 4-bit PickupFired type nibble")

    v.section("single-player evidence")
    event_type = next(i for i in range(len(sp.types)) if sp.type_name(i) == "AmaxEvent")
    events = [i for i in range(len(sp.records)) if sp.record_type(i) == event_type]
    v.equal(len(events), 86, "AmaxEvent count")
    v.equal(manifest["singlePlayer"]["eventCount"], 86, "manifest event count")
    diff_perks = next((i for i in range(len(sp.types))
                       if sp.type_name(i) == "DifficultyPerks"), None)
    diff_perk_records = sum(1 for i in range(len(sp.records))
                            if sp.record_type(i) == diff_perks)
    v.equal(diff_perk_records, 0, "DifficultyPerks records")
    event_fields = {f["name"]: f for f in sp.all_fields(event_type)}
    difficulty_type = next(i for i in range(len(sp.types))
                           if sp.type_name(i) == "DifficultySettings")
    difficulty_fields = {f["name"]: f for f in sp.type_fields(difficulty_type)}
    ai_perk = 0
    always = 0
    always_detail = None
    opponent_type = next(i for i in range(len(sp.types))
                         if sp.type_name(i) == "OpponentSetup")
    always_off = next(f["offset"] for f in sp.type_fields(opponent_type)
                      if f["name"] == "AlwaysShields")
    for r in events:
        payload = sp.record_payload(r)
        for block in ("Easy", "Medium", "Hard"):
            base_off = event_fields[block]["offset"]
            comp3, elem3, length3 = struct.unpack_from(
                "<2HI", payload, base_off + difficulty_fields["AIPerkUse"]["offset"])
            ai_perk += length3
        comp4, elem4, length4 = struct.unpack_from(
            "<2HI", payload, event_fields["Opponents"]["offset"])
        if comp4 != 0xFFFF:
            base4 = sp.component_offset(r, comp4) + elem4 * sp.types[opponent_type][5]
            for k in range(length4):
                off4 = base4 + k * sp.types[opponent_type][5] + always_off
                if u32(payload, off4):
                    always += 1
                    if always_detail is None:
                        name_off = u32(payload, event_fields["Name"]["offset"])
                        strings = sp.record_strings(r)
                        end = strings.find(b"\0", name_off)
                        always_detail = {
                            "eventRecord": r,
                            "eventRefId": sp.record_id(r),
                            "eventName": strings[name_off:end].decode("latin-1") if end >= 0 else None,
                            "opponentIndex": k,
                            "absOffset": sp._data_base + sp._data_start[r] + off4,
                        }
    v.equal(ai_perk, 0, "AIPerkUse entries")
    v.equal(always, 1, "AlwaysShields opponents")
    v.equal(manifest["singlePlayer"]["aiPerkUseEntries"], 0, "manifest ai perk")
    v.equal(manifest["singlePlayer"]["opponentsAlwaysShields"], 1, "manifest always shields")
    v.equal(manifest["singlePlayer"]["difficultyPerkRecords"], 0, "manifest difficulty perks")
    claim = manifest["singlePlayer"]["alwaysShieldsEvent"]
    v.equal(claim["eventRecord"], always_detail["eventRecord"], "alwaysShields event record")
    v.equal(claim["eventRefId"], always_detail["eventRefId"], "alwaysShields event refId")
    v.equal(claim["eventName"], always_detail["eventName"], "alwaysShields event name")
    v.equal(claim["opponentIndex"], always_detail["opponentIndex"], "alwaysShields opponent")
    v.equal(claim["absOffset"], always_detail["absOffset"], "alwaysShields abs offset")
    v.equal(u32(sp.data, always_detail["absOffset"]), 1, "alwaysShields value at abs offset")
    offsets = manifest["singlePlayer"]["offsets"]
    v.equal(offsets["opponentsArrayFieldOffset"], event_fields["Opponents"]["offset"],
            "Opponents field offset")
    v.equal(offsets["alwaysShieldsFieldOffset"], always_off, "AlwaysShields field offset")
    v.equal(offsets["aiPerkUseFieldOffset"], difficulty_fields["AIPerkUse"]["offset"],
            "AIPerkUse field offset")
    for block in ("Easy", "Medium", "Hard"):
        v.equal(offsets["difficultyBlockOffsets"][block], event_fields[block]["offset"],
                f"{block} block offset")

    v.section("runtime claims match serialized fields")
    runtime = manifest["runtime"]
    v.close(runtime["activation"]["lifetimeSeconds"], bal["fields"]["Lifetime"]["value"],
            "runtime lifetime")
    v.close(runtime["activation"]["delaySeconds"], bal["fields"]["Delay"]["value"],
            "runtime delay")
    v.equal(runtime["ram"]["damage"], bal["fields"]["DamagePointsOnImpact"]["value"],
            "runtime ram damage")
    v.equal(runtime["ram"]["damageCap"], bal["fields"]["DamagePointsOnImpact"]["value"],
            "runtime ram damage cap")
    v.equal(runtime["mass"]["activeMassKg"], bal["fields"]["IncreasedMass"]["value"],
            "runtime active mass")
    v.close(runtime["nitro"]["targetMph"], bal["fields"]["NitroTargetSpeedInMPH"]["value"],
            "runtime nitro mph")
    v.close(runtime["nitro"]["targetMps"],
            bal["fields"]["NitroTargetSpeedInMPH"]["value"] * 0.44704, "runtime nitro mps")
    v.equal(runtime["boosts"]["steeringBoost"], bal["fields"]["SteeringBoost"]["value"],
            "runtime steering")
    v.equal(runtime["boosts"]["accelerationBoost"],
            bal["fields"]["AccelerationBoost"]["value"], "runtime acceleration")
    v.equal(runtime["boosts"]["downForceBoost"], bal["fields"]["DownForceBoost"]["value"],
            "runtime downforce")
    v.close(runtime["boosts"]["minimumTriggerValue"],
            bal["fields"]["MinimumTriggerValue"]["value"], "runtime trigger")
    v.equal(runtime["absorb"]["healthField"]["value"], bal["fields"]["Health"]["value"],
            "runtime health value")
    v.equal(runtime["absorb"]["healthField"]["status"], "serialized-unused",
            "runtime health status")
    v.equal(runtime["boosts"]["brakingBoost"]["value"],
            bal["fields"]["BrakingBoost"]["value"], "runtime braking value")
    v.equal(runtime["boosts"]["brakingBoost"]["status"], "serialized-unused",
            "runtime braking status")
    v.equal(runtime["ram"]["cooldownSeconds"], 1.0, "runtime cooldown 1.0")
    v.equal(runtime["collision"]["weightClass"], "Ultra", "runtime weight class")
    v.equal(manifest["decision"]["status"], "integrable-project-extension",
            "decision status")
    v.equal(manifest["decision"]["provisional"], True, "decision provisional")
    v.equal(manifest["decision"]["missingRuntimeRule"], False, "no missing runtime rule")
    v.equal(manifest["decision"]["missingMultiplayerEnableRule"], True,
            "missing MP enable rule")

    v.section("source citations and negative checks")
    file_hashes = {row["path"]: row["sha256"] for row in manifest["sourceCode"]["files"]}
    for row in manifest["sourceCode"]["citations"]:
        path = ROOT / row["file"]
        v.check(path.exists(), f"source exists {row['file']}")
        v.equal(sha256(path.read_bytes()), file_hashes[row["file"]],
                f"source hash {row['file']}")
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        v.check(1 <= row["line"] <= len(lines), f"source line bounds {row['file']}")
        v.check(row["token"] in lines[row["line"] - 1],
                f"source token {row['file']}:{row['line']}")
        v.equal(lines[row["line"] - 1].strip(), row["text"],
                f"source text {row['file']}:{row['line']}")
    for row in manifest["sourceCode"]["negativeChecks"]:
        path = ROOT / row["file"]
        v.equal(sha256(path.read_bytes()), file_hashes[row["file"]],
                f"negative source hash {row['file']}")
        text = path.read_text(encoding="utf-8", errors="replace")
        v.equal(text.count(row["mustNotContain"]), 0,
                f"negative {row['file']} {row['mustNotContain']}")

    v.section("canonical hash")
    v.equal(canonical_hash(manifest), manifest["hashes"]["manifestContent"],
            "canonical content hash")
    v.equal(manifest["hashes"]["sources"]["pickups.bin"],
            entries["pickups.bin"]["sha256Decoded"], "hash map pickups")
    v.equal(manifest["hashes"]["sourceCode"]["_work/engine-vehicle-spike/tree/code/amax/"
            "game/GameLogic/Pickups/Normal/PickupSuperShield.cpp"],
            file_hashes["_work/engine-vehicle-spike/tree/code/amax/game/GameLogic/"
                        "Pickups/Normal/PickupSuperShield.cpp"],
            "hash map PickupSuperShield.cpp")

    result = {
        "schema": "blur-powerups-supershield-verify/1",
        "manifest": "_work/powerups/supershield.json",
        "manifestContent": manifest["hashes"]["manifestContent"],
        "checks": v.checks,
        "passed": v.checks - len(v.failures),
        "failed": len(v.failures),
        "status": "PASS" if not v.failures else "FAIL",
        "failures": v.failures,
        "evidence": {
            "sources": {k: row["sha256Decoded"] for k, row in entries.items()},
            "existingManifestSha256": sha256(existing_bytes),
            "existingVerifierChecks": verify["checks"],
        },
    }
    OUT.write_text(json.dumps(result, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{v.checks} checks, {len(v.failures)} failures")
    if v.failures:
        print("failures:", v.failures[:12])
        raise SystemExit(1)


if __name__ == "__main__":
    main()
