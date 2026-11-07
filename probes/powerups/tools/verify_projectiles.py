"""Independent verifier for ``_work/powerups/projectiles.json`` (PWR4).

This reader does **not** import ``xt_decode``. It re-parses the FLSK tables and
payload at direct offsets, re-reads the PAK entries, re-hashes the source
citations, and re-checks the existing 1,783-check powerups manifest.

Output: ``_work/powerups/projectiles.verify.json``.
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
OUT = ROOT / "_work" / "powerups" / "projectiles.verify.json"
MANIFEST = ROOT / "_work" / "powerups" / "projectiles.json"
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


def f32(payload, off):
    return struct.unpack_from("<f", payload, off)[0]


def u32(payload, off):
    return struct.unpack_from("<I", payload, off)[0]


def u16(payload, off):
    return struct.unpack_from("<H", payload, off)[0]


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
        "ui.bin": load_entry(index, "\\gamedata\\xt\\ui.bin"),
        "audioentities.bin": load_entry(index, "\\gamedata\\xt\\audioentities.bin"),
        "rldatabase.bin": load_entry(index, "\\gamedata\\xt\\rldatabase.bin"),
        "amax.bin": load_entry(index, "\\gamedata\\xt\\amax.bin"),
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
    ui = RawFlask(entries["ui.bin"]["bytes"])
    audio = RawFlask(entries["audioentities.bin"]["bytes"])
    rld = RawFlask(entries["rldatabase.bin"]["bytes"])
    amax = RawFlask(entries["amax.bin"]["bytes"])

    v.section("existing 1,783-check manifest")
    existing_path = ROOT / "_work" / "powerups" / "powerups.json"
    existing_bytes = existing_path.read_bytes()
    v.equal(sha256(existing_bytes), "6ee5a3e699187086665b4b5330abcda29859e77b4464edae65e6ed00b7bc73d7",
            "powerups.json sha256")
    existing = json.loads(existing_bytes.decode("utf-8"))
    v.equal(existing["hashes"]["manifestContent"],
            "543b059ab7bc511cc61947ba584ff461f8f54b86ea02c06fbd2538f5d2c654df",
            "powerups.json content hash")
    verify = json.loads((ROOT / "_work" / "powerups" / "verify.json").read_text(encoding="utf-8"))
    v.equal(verify["checks"], 1783, "verify checks")
    v.equal(verify["failed"], 0, "verify failures")
    v.equal(manifest["existingManifest"]["sha256"], sha256(existing_bytes), "manifest existing sha")
    v.equal(manifest["existingManifest"]["intact"], True, "manifest existing intact")

    v.section("PickupLevel / balancing payload offsets and values")
    for label, typ in manifest["types"].items():
        rec = typ["record"]
        v.equal(pick.record_id(rec), typ["refId"], f"{label} entity refId")
        v.equal(pick.type_name(pick.record_type(rec)), "PickupType", f"{label} entity type")
        for slot, lvl in typ["levels"].items():
            lr = lvl["levelRecord"]
            v.equal(pick.record_id(lr), lvl["levelRefId"], f"{label}.{slot} level refId")
            payload = pick.record_payload(lr)
            comp = u16(payload, 12)
            elem = u16(payload, 14)
            v.equal(comp, lvl["balancingComponent"], f"{label}.{slot} component")
            v.equal(elem, lvl["balancingElement"], f"{label}.{slot} element")
            comp_type, _count, behaviour = pick.component_type(lr, comp)
            stride = pick.types[comp_type][5] if behaviour == 0 else 4
            base = pick.component_offset(lr, comp) + elem * stride
            v.equal(base, lvl["balancingPayloadOffset"], f"{label}.{slot} payload offset")
            v.equal(pick.type_name(comp_type), lvl["balancingType"], f"{label}.{slot} bal type")
            for fname, fv in lvl["fields"].items():
                field = next(f for f in pick.all_fields(comp_type) if f["name"] == fname)
                v.equal(base + field["offset"], fv["offset"], f"{label}.{slot}.{fname} field offset")
                if field["behaviour"] == 0 and field["array"] is False:
                    atom = pick.types[field["typeIndex"]][4]
                    if atom == 10:
                        v.close(f32(payload, base + field["offset"]), fv["value"],
                                f"{label}.{slot}.{fname}")
                    elif atom == 1:
                        v.equal(u32(payload, base + field["offset"]) != 0, fv["value"],
                                f"{label}.{slot}.{fname}")
                    elif atom in (2, 3, 4, 5, 6, 7, 8):
                        width = {2: "b", 3: "h", 4: "i", 5: "q", 6: "B", 7: "H", 8: "I"}[atom]
                        v.equal(struct.unpack_from("<" + width, payload, base + field["offset"])[0],
                                fv["value"], f"{label}.{slot}.{fname}")
            # Graph field offset is 0 by schema; verify the level type has a BalancingGraph at 0.
            v.equal(next(f["offset"] for f in pick.type_fields(pick.record_type(lr))
                         if f["name"] == "BalancingGraph"), 0, f"{label}.{slot} graph field")

    v.section("PerkForceEffects")
    pfe = manifest["perkForceEffects"]
    rec = pfe["record"]
    v.equal(pick.record_id(rec), pfe["refId"], "PFE refId")
    v.equal(pick.type_name(pick.record_type(rec)), "PerkForceEffects", "PFE type")
    pfe_type = pick.record_type(rec)
    prefix = pick.record_payload(rec)
    for effect, row in pfe["effects"].items():
        field = next(f for f in pick.type_fields(pfe_type) if f["name"] == effect)
        v.equal(field["offset"], row["recordOffset"], f"PFE {effect} record offset")
        effect_type = next(i for i in range(len(pick.types)) if pick.type_name(i) == "ForceEffect")
        for fname, fv in row["fields"].items():
            f = next(x for x in pick.type_fields(effect_type) if x["name"] == fname)
            v.equal(f["offset"], fv["offset"] - row["recordOffset"], f"PFE {effect}.{fname} field offset")
            if fname == "ElectricalEffect":
                v.equal(u32(prefix, row["recordOffset"] + f["offset"]) != 0, fv["value"],
                        f"PFE {effect}.{fname}")
            elif fname == "ForceType":
                labels = [x["name"] for x in pick.type_fields(f["typeIndex"])]
                idx = u32(prefix, row["recordOffset"] + f["offset"])
                v.equal(labels[idx], fv["value"]["label"], f"PFE {effect}.{fname}")
            elif fname != "ElectricalEffectColour":
                v.close(f32(prefix, row["recordOffset"] + f["offset"]), fv["value"],
                        f"PFE {effect}.{fname}")
    # Cross-pack handle: rldatabase System.PerkForceEffects -> pickups record id.
    sys_rec = 40
    v.equal(rld.record_id(sys_rec), pfe["crossReference"]["fromRefId"], "PFE system refId")
    sys_payload = rld.record_payload(sys_rec)
    sys_field = next(f for f in rld.all_fields(rld.record_type(sys_rec))
                     if f["name"] == "PerkForceEffects")
    v.equal(sys_field["offset"], pfe["crossReference"]["fieldOffset"], "PFE system field offset")
    ref_index = u32(sys_payload, sys_field["offset"])
    ref_id, ref_type, ref_record = rld.refs[ref_index]
    v.equal(ref_id, pfe["refId"], "PFE cross ref id")
    v.equal(rld.type_name(ref_type), "PerkForceEffects", "PFE cross type")
    v.equal(ref_record, 0xFFFF, "PFE cross unloaded")
    v.equal(ref_id, pick.record_id(rec), "PFE cross resolves by id")

    v.section("AI pickup controller")
    ai = manifest["aiController"]
    ai_rec = ai["record"]
    v.equal(pick.record_id(ai_rec), ai["refId"], "AI controller refId")
    v.equal(pick.type_name(pick.record_type(ai_rec)), "AIPickupControllerSetup", "AI controller type")
    ai_payload = pick.record_payload(ai_rec)
    for name, value in ai["values"].items():
        field = next(f for f in pick.all_fields(pick.record_type(ai_rec)) if f["name"] == name)
        atom = pick.types[field["typeIndex"]][4]
        if atom == 10:
            v.close(f32(ai_payload, field["offset"]), value, f"AI {name}")
        elif atom == 1:
            v.equal(u32(ai_payload, field["offset"]) != 0, value, f"AI {name}")
        elif atom in (2, 3, 4, 5, 6, 7, 8):
            width = {2: "b", 3: "h", 4: "i", 5: "q", 6: "B", 7: "H", 8: "I"}[atom]
            v.equal(struct.unpack_from("<" + width, ai_payload, field["offset"])[0], value,
                    f"AI {name}")
    v.equal(len(ai["accuracyGraphs"]), 7, "AI graph count")
    for g in ai["accuracyGraphs"]:
        v.check(len(g["keyframes"]) >= 2, "AI graph has keyframes")

    v.section("HUD bindings")
    hud = manifest["hud"]
    ui_config_rec = hud["source"]["record"]
    v.equal(ui.record_id(ui_config_rec), hud["source"]["refId"], "UiXtConfig refId")
    ui_payload = ui.record_payload(ui_config_rec)
    perk_type = next(i for i in range(len(ui.types)) if ui.type_name(i) == "UiPerkDisplayParameters")
    perk_field = next(f for f in ui.type_fields(ui.record_type(ui_config_rec))
                      if f["name"] == "PerkDisplayParameters")
    v.equal(perk_field["offset"], hud["source"]["fieldOffset"], "HUD field offset")
    offsets = {f["name"]: f["offset"] for f in ui.all_fields(perk_type)}
    for key, row in hud["entries"].items():
        v.equal(offsets[key], row["fieldOffset"], f"HUD {key} field offset")
        v.equal(hud["source"]["fieldOffset"] + offsets[key], row["recordOffset"],
                f"HUD {key} record offset")
        # texture_index is the first field of UIPerkInfo, 24 bytes per entry.
        tex_off = hud["source"]["fieldOffset"] + offsets[key]
        v.equal(u32(ui_payload, tex_off), row["entry"]["texture_index"], f"HUD {key} texture_index")
    v.check(any(s["name"] == "perk_icons" for s in hud["iconSheets"]), "perk_icons string")

    v.section("Audio graph ids and ports")
    for label, rows in manifest["audio"].items():
        for row in rows:
            if not row.get("found"):
                continue
            v.equal(audio.record_id(row["record"]), row["refId"], f"audio {row['name']} refId")
            payload = audio.record_payload(row["record"])
            raw = u32(payload, 0)
            strings = audio.record_strings(row["record"])
            end = strings.find(b"\0", raw)
            v.equal(strings[raw:end].decode("latin-1"), row["name"], f"audio {row['name']} name")
            v.check(any(port in row["externs"] for port in (
                "PickupFire", "PickupCharging", "PickupProjectileActive",
                "PickupHitCar", "PickupHitWorld", "PickupEnded",
                "PickupHitShield", "PickupBackwardsFire")), f"audio {row['name']} ports")

    v.section("Route ShockWidthWeighting")
    route_type = next(i for i in range(len(amax.types)) if amax.type_name(i) == "Route")
    route_rec = next(i for i in range(len(amax.records))
                     if amax.record_id(i) == 1643385212)
    payload = amax.record_payload(route_rec)
    field = next(f for f in amax.all_fields(route_type) if f["name"] == "ShockWidthWeighting")
    v.equal(field["offset"], manifest["shockRoute"]["fieldOffset"], "route field offset")
    v.close(f32(payload, field["offset"]), manifest["shockRoute"]["shockWidthWeighting"],
            "route shock width weighting")

    v.section("Source citations")
    for row in manifest["sourceCode"]["citations"]:
        path = ROOT / row["file"]
        v.check(path.exists(), f"source exists {row['file']}")
        v.equal(sha256(path.read_bytes()), manifest["sourceCode"]["files"][
            next(i for i, f in enumerate(manifest["sourceCode"]["files"])
                 if f["path"] == row["file"])]["sha256"], f"source hash {row['file']}")
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        v.check(1 <= row["line"] <= len(lines), f"source line bounds {row['file']}")
        v.check(row["token"] in lines[row["line"] - 1], f"source token {row['file']}:{row['line']}")
        v.equal(lines[row["line"] - 1].strip(), row["text"], f"source text {row['file']}:{row['line']}")

    v.section("Runtime values vs source citations")
    citations = {c["field"]: c for c in manifest["sourceCode"]["citations"]}
    runtime_map = {
        ("Blindfire", "lifetimeSeconds"): "blindfire.lifetimeSeconds",
        ("Blindfire", "charges"): "charges.blindfire",
        ("Shunt", "lifetimeSeconds"): "shunt.lifetimeSeconds",
        ("Shunt", "minSpeedMps"): "shunt.minSpeed",
        ("Shunt", "maxSpeedMps"): "shunt.maxSpeed",
        ("Shunt", "maxHomingSpeedMps"): "shunt.maxHomingSpeed",
        ("Shunt", "heightFromGroundM"): "shunt.heightFromGround",
        ("Shunt", "homingTurnRateDegPerSec"): "shunt.homingTurnRate",
        ("Shunt", "maxTurnRateDegPerSec"): "shunt.maxTurnRate",
        ("Shunt", "warningRangeM"): "shunt.warningRange",
        ("Shunt", "warningDot"): "shunt.warningDot",
        ("Barge", "paddingM"): "barge.radiusAddition",
        ("Barge", "innerBandM"): "barge.outerRadius",
        ("Barge", "extentsFudgeAverageM"): "barge.extentsFudge",
        ("Barge", "idiotLeniencyM"): "barge.idiotLeniency",
        ("Shock", "domesPerUse"): "shock.domesPerUse",
        ("Shock", "sizeMultiplierLow"): "shock.sizeMultiplierLow",
        ("Shock", "sizeMultiplierHigh"): "shock.sizeMultiplierHigh",
        ("Shock", "growthCutoffSeconds"): "shock.growthCutoffSeconds",
        ("Shock", "growthInitial"): "shock.growthInitial",
        ("Shock", "growthLate"): "shock.growthLate",
        ("Shock", "minWidth"): "shock.minWidth",
        ("Shock", "maxWidth"): "shock.maxWidth",
        ("Shock", "sizeDenominator"): "shock.sizeDenominator",
    }
    for (type_name, key), citation_name in runtime_map.items():
        claim = manifest["runtimeValues"][type_name][key]
        cit = citations[citation_name]
        v.equal(claim, cit["expectedValue"], f"runtime {type_name}.{key} vs {citation_name}")
    for type_name in ("Shunt", "Barge", "Shock"):
        v.equal(manifest["runtimeValues"][type_name]["charges"], 1, f"runtime {type_name} charges")

    v.section("Canonical hash")
    v.equal(canonical_hash(manifest), manifest["hashes"]["manifestContent"], "canonical content hash")
    v.equal(manifest["hashes"]["sources"]["pickups.bin"],
            entries["pickups.bin"]["sha256Decoded"], "hash map pickups")

    result = {
        "schema": "blur-powerups-projectiles-verify/1",
        "manifest": "_work/powerups/projectiles.json",
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
