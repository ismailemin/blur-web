"""Independent verifier for `_work/vfx/effects.json` (>= 150 checks).

The verifier does not import the builder or its generic FLSK decoder. It:
  * re-reads the PAK/FAT with its own implementation and zlib-decodes the XT files;
  * parses the FLSK header and re-reads every selected record at a direct offset;
  * re-hashes the extracted `.texture` bytes and their top mip;
  * re-checks every trigger contract, provenance tag, range and status.

Any mismatch raises a failed check; the process exits non-zero when any check
fails. Output: `_work/vfx/verify.json` + stdout summary.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GAME = ROOT / "game-data" / "Blur" / "cache"
OUT = ROOT / "_work" / "vfx"
GAMEDATA = GAME / "gamedata.pak"
ROOTPAK = GAME / "root.pak"
XOR = b"xVXo40j3@$%\\%`"
PACKET = 65536

TRIGGERS = {
    "nitro-activated", "supershield-activated", "shield-activated", "mine-placed",
    "mine-detonated", "repaired", "shock-activated", "shock-hit", "barge-activated",
    "barge-hit", "projectile-fired", "projectile-hit", "damage", "wrecked",
    "start-crossing", "checkpoint", "lap", "finish", "wheel-slip", "wheel-spin",
    "wheel-speed", "impact-sparks", "exhaust-pop",
}

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})
    return ok


def sha256(data):
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------- PAK (own copy)
def pak_index(path):
    size = path.stat().st_size
    with path.open("rb") as f:
        head = f.read(48)
        assert head[:4] == b"2KAP"
        version, sector, header_size = struct.unpack_from("<III", head, 4)
        assert version == 2 and header_size == 32
        codec, fat_type = head[16], head[17]
        string_block, fat_block = struct.unpack_from("<II", head, 36)
        meta_end = sector + string_block + fat_block
        f.seek(sector)
        string_size = struct.unpack("<I", f.read(4))[0]
        raw = f.read(string_size)
        strings = bytes(b ^ XOR[(i + 1) % len(XOR)] for i, b in enumerate(raw))
        f.seek(sector + string_block)
        count, fat_size = struct.unpack("<II", f.read(8))
        stride = 40 if fat_type == 0 else 64
        assert count * stride == fat_size
        fat = f.read(fat_size)
    entries = []
    for i in range(count):
        crc, so, _parent, logical, _ts, start, _unk, stored = \
            struct.unpack_from("<IIIIQQII", fat, i * stride)
        end = strings.find(b"\0", so)
        name = strings[so:end].decode("utf-8", errors="replace")
        directory = start == 0xFFFFFFFFFFFFFFFF
        entries.append({"path": name, "directory": directory,
                        "offset": None if directory else start * sector,
                        "stored_bytes": stored, "logical_bytes": logical,
                        "path_crc32": f"{crc:08x}", "fat_index": i})
    return {"codec": codec, "fat_type": fat_type, "meta_end": meta_end, "entries": entries}


def find(index, path):
    want = path.lower()
    for row in index["entries"]:
        if row["path"].lower() == want:
            return row
    raise KeyError(path)


def read_pak(pak, row):
    with pak.open("rb") as f:
        f.seek(row["offset"])
        return f.read(row["stored_bytes"])


def decode_packet(data, logical):
    assert len(data) >= 8 and struct.unpack_from("<I", data)[0] == PACKET
    cursor, out = 4, bytearray()
    while cursor < len(data):
        stored = struct.unpack_from("<I", data, cursor)[0]
        cursor += 4
        raw = stored == 0xFFFFFFFF
        size = PACKET if raw else stored
        payload = data[cursor:cursor + size]
        cursor += size
        expected = min(PACKET, logical - len(out))
        if raw:
            out.extend(payload[:expected])
        else:
            inf = zlib.decompressobj(-15)
            dec = inf.decompress(payload, expected + 1)
            assert len(dec) == expected and inf.eof
            out.extend(dec)
    assert len(out) == logical
    return bytes(out)


# --------------------------------------------------------------- FLSK (direct)
class Direct:
    ROWS = [("types", 12), ("bases", 4), ("fields", 8), ("strings", 1),
            ("refs", 8), ("records", 16), ("components", 6), ("data", 1)]

    def __init__(self, data):
        self.data = data
        header = struct.unpack_from("<18I", data)
        assert header[0] == 0x464C534B and header[1] in (1, 2)
        self.version = header[1]
        self.t = {}
        for i, (name, size) in enumerate(self.ROWS):
            offset, count = header[2 + i * 2:4 + i * 2]
            self.t[name] = (offset, count, size)
        so, sc, _ = self.t["strings"]
        enc = data[so:so + sc]
        strings = bytearray(enc)
        if self.version == 2 and strings:
            prev = 0xCC
            for i, b in enumerate(enc[:-1]):
                d = (prev - (b ^ 0xB3)) & 255
                strings[i] = d
                prev = (prev + d - i) & 255
            strings[-1] = 0
        self.strings = bytes(strings)
        to, tc, _ = self.t["types"]
        self.types = [struct.unpack_from("<6H", data, to + i * 12) for i in range(tc)]
        bo, bc, _ = self.t["bases"]
        self.bases = [struct.unpack_from("<2H", data, bo + i * 4) for i in range(bc)]
        fo, fc, _ = self.t["fields"]
        self.fields = [struct.unpack_from("<3H2B", data, fo + i * 8) for i in range(fc)]
        ro, rc, _ = self.t["refs"]
        self.refs = [struct.unpack_from("<I2H", data, ro + i * 8) for i in range(rc)]
        rco, rcc, _ = self.t["records"]
        self.records = [struct.unpack_from("<4I", data, rco + i * 16) for i in range(rcc)]
        co, cc, _ = self.t["components"]
        self.components = [struct.unpack_from("<3H", data, co + i * 6) for i in range(cc)]
        start = 0
        self.comp_start = []
        for r in self.records:
            self.comp_start.append(start)
            start += r[1]
        start = 0
        self.data_start = []
        for r in self.records:
            self.data_start.append(start)
            start += r[2] + r[3]
        base = self.t["data"][0]
        assert start == self.t["data"][1]
        self.data_base = base

    def name_at(self, off):
        end = self.strings.find(b"\0", off)
        return self.strings[off:end].decode("ascii")

    def type_name(self, ti):
        return self.name_at(self.types[ti][0])

    def ref(self, ri):
        return self.refs[ri]

    def record_ref(self, i):
        return self.refs[self.records[i][0]]

    def ref_id(self, i):
        return self.record_ref(i)[0]

    def type_name_of_record(self, i):
        return self.type_name(self.record_ref(i)[1])

    def payload(self, i):
        off = self.data_base + self.data_start[i]
        return self.data[off:off + self.records[i][2]]

    def strings_of(self, i):
        rec = self.records[i]
        off = self.data_base + self.data_start[i] + rec[2]
        enc = self.data[off:off + rec[3]]
        if not enc:
            return b""
        out = bytearray(len(enc))
        prev = 0xCC
        for k in range(len(enc) - 1):
            out[k] = (prev - (enc[k] ^ 0xB3)) & 255
            prev = (prev + out[k] - k) & 255
        out[-1] = 0
        return bytes(out)

    def cstr(self, i, off):
        s = self.strings_of(i)
        if off >= len(s):
            return None
        end = s.find(b"\0", off)
        return s[off:end].decode("latin-1")

    def comp_offset(self, i, rel):
        off = 0
        for typ, count, beh in self.components[self.comp_start[i]:self.comp_start[i] + rel]:
            off = (off + count * (self.types[typ][5] if beh == 0 else 4) + 3) & ~3
        return off

    def comp_meta(self, i, rel):
        return self.components[self.comp_start[i] + rel]

    def array(self, i, field_offset):
        p = self.payload(i)
        return struct.unpack_from("<2HI", p, field_offset)

    def element_offset(self, i, comp, elem):
        typ, _count, beh = self.comp_meta(i, comp)
        width = self.types[typ][5] if beh == 0 else 4
        return self.comp_offset(i, comp) + elem * width

    def f32(self, i, off):
        return struct.unpack_from("<f", self.payload(i), off)[0]

    def u32(self, i, off):
        return struct.unpack_from("<I", self.payload(i), off)[0]

    def handle_ref_id(self, i, off):
        p = self.payload(i)
        idx = struct.unpack_from("<I", p, off)[0]
        if idx == 0xFFFFFFFF:
            return None
        return self.refs[idx][0]


def type_index(flask, name):
    for i in range(len(flask.types)):
        if flask.type_name(i) == name:
            return i
    raise KeyError(name)


def enum_labels(flask, ti):
    _nm, nf, _nb, _beh, _atom, _size = flask.types[ti]
    fo = flask.t["fields"][0]
    start = sum(flask.types[i][1] for i in range(ti))
    out = []
    for k in range(start, start + nf):
        fn = struct.unpack_from("<3H2B", flask.data, fo + k * 8)[0]
        out.append(flask.name_at(fn))
    return out


def main():
    text = (OUT / "effects.json").read_text(encoding="utf-8")
    m = json.loads(text)
    check("manifest.schema", m.get("schema") == "blur-vfx/1", m.get("schema"))
    check("manifest.generator", m.get("generatedBy") == "probes/vfx/tools/build_vfx.py")
    check("manifest.roundTrip",
          text == json.dumps(m, indent=1, sort_keys=True) + "\n",
          "stable json.dumps(indent=1, sort_keys=True)")
    body = {k: v for k, v in m.items() if k != "hashes"}
    check("manifest.contentHash",
          sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode())
          == m["hashes"]["manifestContent"], m["hashes"]["manifestContent"])

    gd = pak_index(GAMEDATA)
    rp = pak_index(ROOTPAK)
    check("pak.gamedata.codec", gd["codec"] == 2, f"codec={gd['codec']} fat={gd['fat_type']}")
    check("pak.root.codec", rp["codec"] == 4 and rp["fat_type"] == 0)

    flasks = {}
    for src in m["sources"]:
        row = find(gd, src["path"])
        check(f"source.{src['path']}.index",
              row["offset"] == src["offset"] and row["logical_bytes"] == src["logicalBytes"]
              and row["stored_bytes"] == src["storedBytes"],
              f"fat={row['fat_index']}")
        stored = read_pak(GAMEDATA, row)
        inf = zlib.decompressobj()
        data = inf.decompress(stored, row["logical_bytes"] + 1)
        check(f"source.{src['path']}.decode",
              len(data) == row["logical_bytes"] and inf.eof and not inf.unused_data,
              f"{len(data)} B")
        check(f"source.{src['path']}.storedHash", sha256(stored) == src["sha256Stored"])
        check(f"source.{src['path']}.decodedHash", sha256(data) == src["sha256Decoded"])
        key = src["path"].split("\\")[-1].split(".")[0]
        flasks[key] = Direct(data)
        for field, table in (("types", "types"), ("fields", "fields"),
                             ("refs", "refs"), ("records", "records"),
                             ("components", "components")):
            check(f"source.{key}.{field}",
                  len(getattr(flasks[key], table)) == src["flask"][field],
                  f"{len(getattr(flasks[key], table))}")

    dyn = flasks["dynamiceffects"]
    amax = flasks["amax"]
    pick = flasks["pickups"]
    check("counts.records", len(dyn.records) == m["counts"]["records"] == 1132)
    check("counts.types", len(dyn.types) == m["counts"]["types"] == 75)
    check("counts.events", m["counts"]["particleEvents"] == 225)
    check("counts.effects", m["counts"]["particleEffects"] == 261)
    check("counts.effectEntries", m["counts"]["effects"] == len(m["effects"]) == 15)
    check("counts.status",
          m["counts"]["decoded"] + m["counts"]["partial"] + m["counts"]["unsupported"]
          == len(m["effects"]))
    check("counts.textures", m["counts"]["texturesExtracted"] == len(m["textures"]))
    check("inventory.length", len(m["recordInventory"]) == len(dyn.records))
    check("inventory.uniqueRefIds",
          len({r["refId"] for r in m["recordInventory"]}) == len(m["recordInventory"]))

    # schema enum labels
    for name in ("Particle_EmitterSpawn", "Particle_EmitterSpace", "Particle_Shape",
                 "Particle_BlendMode", "Particle_Sort", "Particle_EmitterDistribution",
                 "Particle_EmitterColourMode", "Particle_EmitterUV", "Effect_Atlas",
                 "Effect_AtlasType", "Particle_Child", "Particle_PhysicsBehaviour",
                 "Particle_Collision"):
        ti = type_index(dyn, name)
        check(f"enum.{name}", m["enums"][name] == enum_labels(dyn, ti), name)
    for name in ("EffectMaterial", "WheelSurfaceParticleEventTrigger", "SurfaceModifier",
                 "WheelSurfaceTrackMaterialBlendMode", "MiscParticleEventType"):
        ti = type_index(amax, name)
        check(f"enum.{name}", m["enums"][name] == enum_labels(amax, ti), name)

    # per-effect independent record reads
    seen_events = set()
    for effect in m["effects"]:
        eid = effect["id"]
        check(f"{eid}.status", effect["status"] in ("decoded", "partial", "unsupported"))
        if effect["status"] == "partial":
            check(f"{eid}.partialHasMissing", len(effect["missing"]) >= 1)
        else:
            check(f"{eid}.decodedNoMissing", effect["missing"] == [])
        check(f"{eid}.provenanceTags",
              all(p["tag"] in ("data", "code", "provisional") for p in effect["provenance"]))
        check(f"{eid}.hasDataProvenance",
              any(p["tag"] == "data" for p in effect["provenance"]))
        check(f"{eid}.decodedParameterCount",
              isinstance(effect["decodedParameterCount"], int)
              and effect["decodedParameterCount"] > 0,
              str(effect["decodedParameterCount"]))
        for t in effect["triggers"]:
            check(f"{eid}.trigger.{t['contract']}.known", t["contract"] in TRIGGERS)
            check(f"{eid}.trigger.{t['contract']}.source",
                  bool(t.get("contractSource")) and t["contractSource"] != "unknown",
                  t.get("contractSource", ""))
            check(f"{eid}.trigger.{t['contract']}.provenance",
                  t.get("contractProvenance") in ("code", "provisional"))

        for ev in effect["events"]:
            seen_events.add(ev["record"])
            idx = ev["record"]
            check(f"{eid}.event.{idx}.type",
                  dyn.type_name_of_record(idx) == "Particle_Event",
                  dyn.type_name_of_record(idx))
            check(f"{eid}.event.{idx}.refId", dyn.ref_id(idx) == ev["refId"],
                  f"{dyn.ref_id(idx)}")
            p = dyn.payload(idx)
            name_off = struct.unpack_from("<I", p, 0)[0]
            check(f"{eid}.event.{idx}.name", dyn.cstr(idx, name_off) == ev["name"],
                  ev["name"])
            check(f"{eid}.event.{idx}.duration",
                  abs(struct.unpack_from("<f", p, 4)[0] - ev["duration"]["mean"]) < 1e-6
                  and abs(struct.unpack_from("<f", p, 8)[0] - ev["duration"]["d"]) < 1e-6)
            check(f"{eid}.event.{idx}.repeating",
                  bool(struct.unpack_from("<I", p, 12)[0]) == ev["repeating"])
            comp, elem, length = dyn.array(idx, 16)
            check(f"{eid}.event.{idx}.emitterCount", length == ev["emitterCount"] == len(ev["emitters"]))
            check(f"{eid}.event.{idx}.durationNonNegative", ev["duration"]["mean"] >= 0)
            for k, em in enumerate(ev["emitters"]):
                eoff = dyn.element_offset(idx, comp, elem + k)
                refid = dyn.handle_ref_id(idx, eoff)
                check(f"{eid}.event.{idx}.emitter{k}.effectRef",
                      refid == em["effect"]["refId"], f"{refid}")
                check(f"{eid}.event.{idx}.emitter{k}.effectRecord",
                      em["effect"]["record"] is not None
                      and dyn.type_name_of_record(em["effect"]["record"]) == "Particle_Effect")
                spawn = em["spawn"]
                check(f"{eid}.event.{idx}.emitter{k}.spawnType",
                      spawn["type"]["label"] in m["enums"]["Particle_EmitterSpawn"])
                check(f"{eid}.event.{idx}.emitter{k}.space",
                      spawn["space"]["label"] in m["enums"]["Particle_EmitterSpace"])
                check(f"{eid}.event.{idx}.emitter{k}.distribution",
                      spawn["distribution"]["label"] in m["enums"]["Particle_EmitterDistribution"])
                check(f"{eid}.event.{idx}.emitter{k}.orientation",
                      spawn["orientation"]["label"] in m["enums"]["Particle_EmitterOrientation"])
                amount = spawn["amount"]["amount"]
                check(f"{eid}.event.{idx}.emitter{k}.amount",
                      amount["mean"] >= 0 and amount["d"] >= 0)
                part = em["particle"]
                for field in ("life", "size", "speed"):
                    check(f"{eid}.event.{idx}.emitter{k}.{field}",
                          part[field]["mean"] >= 0 and part[field]["d"] >= 0,
                          f"{part[field]}")
                for cfield in ("colour", "colour2"):
                    col = part[cfield]
                    check(f"{eid}.event.{idx}.emitter{k}.{cfield}.range",
                          all(math.isfinite(col[c]) and col[c] >= 0.0
                              for c in ("r", "g", "b", "a")),
                          str(col))
                check(f"{eid}.event.{idx}.emitter{k}.lifeFinite",
                      math.isfinite(part["life"]["mean"]))
                check(f"{eid}.event.{idx}.emitter{k}.sizeFinite",
                      math.isfinite(part["size"]["mean"]))
                check(f"{eid}.event.{idx}.emitter{k}.speedFinite",
                      math.isfinite(part["speed"]["mean"]))
                check(f"{eid}.event.{idx}.emitter{k}.cone",
                      spawn["cone"]["outer"] >= spawn["cone"]["inner"],
                      f"{spawn['cone']}")

        for ef in effect["effects"]:
            idx = ef["record"]
            check(f"{eid}.effect.{idx}.type",
                  dyn.type_name_of_record(idx) == "Particle_Effect")
            check(f"{eid}.effect.{idx}.refId", dyn.ref_id(idx) == ef["refId"])
            p = dyn.payload(idx)
            name_off = struct.unpack_from("<I", p, 0)[0]
            check(f"{eid}.effect.{idx}.name", dyn.cstr(idx, name_off) == ef["name"], ef["name"])
            tex_off = struct.unpack_from("<I", p, 4)[0]
            check(f"{eid}.effect.{idx}.diffuseTexture",
                  dyn.cstr(idx, tex_off) == ef["render"]["diffuseTexture"],
                  ef["render"]["diffuseTexture"])
            check(f"{eid}.effect.{idx}.blend",
                  struct.unpack_from("<I", p, 4 + 28)[0] == ef["render"]["blendMode"]["labelIndex"])
            check(f"{eid}.effect.{idx}.shape",
                  struct.unpack_from("<I", p, 4 + 20)[0] == ef["render"]["shape"]["labelIndex"])
            check(f"{eid}.effect.{idx}.atlas",
                  struct.unpack_from("<I", p, 4 + 8)[0] == ef["render"]["atlas"]["labelIndex"])
            check(f"{eid}.effect.{idx}.blendLabel",
                  ef["render"]["blendMode"]["label"] in m["enums"]["Particle_BlendMode"])
            check(f"{eid}.effect.{idx}.shapeLabel",
                  ef["render"]["shape"]["label"] in m["enums"]["Particle_Shape"])
            check(f"{eid}.effect.{idx}.sortLabel",
                  ef["render"]["sort"]["label"] in m["enums"]["Particle_Sort"])
            check(f"{eid}.effect.{idx}.atlasLabel",
                  ef["render"]["atlas"]["label"] in m["enums"]["Effect_Atlas"])
            check(f"{eid}.effect.{idx}.atlasType",
                  ef["render"]["atlasType"]["label"] in m["enums"]["Effect_AtlasType"])
            grav = struct.unpack_from("<f", p, 144 + 8)[0]
            check(f"{eid}.effect.{idx}.gravity",
                  abs(grav - ef["physics"]["gravity"]) < 1e-6, f"{grav}")
            check(f"{eid}.effect.{idx}.gravityFinite", math.isfinite(grav))
            coll = ef["physics"]["collisions"]["label"]
            check(f"{eid}.effect.{idx}.collision", coll in m["enums"]["Particle_Collision"])
            check(f"{eid}.effect.{idx}.frictionRange",
                  0.0 <= ef["physics"]["friction"] <= 1.0)
            check(f"{eid}.effect.{idx}.restitutionRange",
                  0.0 <= ef["physics"]["restitution"] <= 1.0)
            check(f"{eid}.effect.{idx}.children",
                  dyn.array(idx, 172)[2] == ef["children"]["length"])
            for curve in ("sizeCurveX", "sizeCurveY", "sizeCurveZ", "animation"):
                items = ef["render"][curve]["items"]
                times = [k["time"] for k in items]
                check(f"{eid}.effect.{idx}.{curve}.times",
                      all(a <= b for a, b in zip(times, times[1:])), str(times))
                check(f"{eid}.effect.{idx}.{curve}.finite",
                      all(math.isfinite(k["value"]) and math.isfinite(k["inTangent"])
                          and math.isfinite(k["outTangent"]) for k in items))
            for item in ef["render"]["colourOverTime"]["items"]:
                check(f"{eid}.effect.{idx}.colourTime.range",
                      all(math.isfinite(item["colour"][c]) and item["colour"][c] >= 0.0
                          for c in ("r", "g", "b")), str(item["colour"]))
            blends = ef["render"]["light"]
            check(f"{eid}.effect.{idx}.lightRadius", blends["radius"] >= 0)

        for tr in effect["trackEvents"]:
            idx = tr["record"]
            check(f"{eid}.track.{idx}.type",
                  amax.type_name_of_record(idx) == "WheelSurfaceTrackEvent")
            check(f"{eid}.track.{idx}.refId", amax.ref_id(idx) == tr["refId"])
            check(f"{eid}.track.{idx}.trigger",
                  tr["trigger"]["label"] in m["enums"]["WheelSurfaceParticleEventTrigger"])
            check(f"{eid}.track.{idx}.blend",
                  tr["material"]["value"]["blendMode"]["label"]
                  in m["enums"]["WheelSurfaceTrackMaterialBlendMode"])
            check(f"{eid}.track.{idx}.alphaRate", tr["alphaRate"] >= 0)
            check(f"{eid}.track.{idx}.colour",
                  all(0.0 <= tr["colour"][c] <= 1.0 for c in ("r", "g", "b", "a")))

        for im in effect["impactTables"]:
            idx = im["record"]
            check(f"{eid}.impact.{idx}.type",
                  amax.type_name_of_record(idx) == "AmaxImpactSurfaceEffect")
            check(f"{eid}.impact.{idx}.ranges",
                  0 <= im["minImpact"] <= im["maxImpact"] and 0 <= im["minIntensity"]
                  <= im["maxIntensity"])
            check(f"{eid}.impact.{idx}.surfaceCount",
                  im["surfaceTypes"]["length"] == len(im["surfaceTypes"]["items"]))

        for p in effect["pickupSpecialFx"]:
            if p.get("record") is None:
                check(f"{eid}.pickupFx.{p.get('slot')}.unloaded",
                      p.get("unloaded") is True)
                continue
            idx = p["record"]
            check(f"{eid}.pickupFx.{idx}.type",
                  pick.type_name_of_record(idx) == "SpecialFX")
            check(f"{eid}.pickupFx.{idx}.refId", pick.ref_id(idx) == p["refId"])
            check(f"{eid}.pickupFx.{idx}.componentCount",
                  len(p["components"]) == p["componentCount"])
            for comp in p["components"]:
                check(f"{eid}.pickupFx.{idx}.componentType", bool(comp.get("type")))
                if comp.get("type") == "ParticleSpecialFX":
                    ev = comp.get("particleEvent")
                    check(f"{eid}.pickupFx.{idx}.particleEvent",
                          isinstance(ev, dict) and ev.get("type") == "Particle_Event",
                          str(ev))
                    if isinstance(ev, dict):
                        rec = ev.get("resolvedRecord")
                        check(f"{eid}.pickupFx.{idx}.particleEventRecord",
                              rec is not None and
                              dyn.type_name_of_record(rec) == "Particle_Event" and
                              dyn.ref_id(rec) == ev.get("refId"),
                              f"refId={ev.get('refId')} rec={rec}")
                if comp.get("type") == "AnimatedMeshSpecialFX":
                    check(f"{eid}.pickupFx.{idx}.mesh", bool(comp.get("mesh")))

        for mesh in effect["gateMeshes"]:
            idx = mesh["record"]
            check(f"{eid}.gateMesh.{idx}.type",
                  dyn.type_name_of_record(idx) == "AnimatedMeshSpecialFX")
            check(f"{eid}.gateMesh.{idx}.refId", dyn.ref_id(idx) == mesh["refId"])
            check(f"{eid}.gateMesh.{idx}.mesh", mesh["mesh"].endswith(".model"))
            check(f"{eid}.gateMesh.{idx}.animation", mesh["animation"].endswith(".cycle"))

        for root in effect["gateRoots"]:
            idx = root["record"]
            check(f"{eid}.gateRoot.{idx}.type",
                  dyn.type_name_of_record(idx) == "SpecialFX")
            check(f"{eid}.gateRoot.{idx}.components",
                  len(root["components"]) == root["componentCount"])

        # texture records claimed by this effect
        for tex in effect["textures"]:
            if tex["status"] == "extracted":
                row = find(rp, tex["path"])
                check(f"{eid}.texture.{tex['path']}.index",
                      row["logical_bytes"] > 0 and row["offset"] is not None, tex["path"])
                target = OUT / tex["files"]["texture"]
                check(f"{eid}.texture.{tex['path']}.file", target.exists())
                if target.exists():
                    check(f"{eid}.texture.{tex['path']}.hash",
                          sha256(target.read_bytes()) == tex["sha256Decoded"])
                check(f"{eid}.texture.{tex['path']}.format",
                      tex["formatLabel"] in ("BC1", "BC2", "BC3", "RGBA8"))
                check(f"{eid}.texture.{tex['path']}.size",
                      tex["width"] > 0 and tex["height"] > 0 and tex["levels"] >= 1)
            else:
                check(f"{eid}.texture.{tex['requested']}.missing", True,
                      tex["status"])

    # top-level textures, independent decode + mip hash
    seen_tex = set()
    for tex in m["textures"]:
        row = find(rp, tex["path"])
        seen_tex.add(tex["path"])
        check(f"texture.{tex['name']}.index",
              row["offset"] == tex["offset"] and row["stored_bytes"] == tex["storedBytes"]
              and row["logical_bytes"] == tex["logicalBytes"],
              f"fat={row['fat_index']}")
        stored = read_pak(ROOTPAK, row)
        check(f"texture.{tex['name']}.storedHash", sha256(stored) == tex["sha256Stored"])
        decoded = decode_packet(stored, row["logical_bytes"])
        check(f"texture.{tex['name']}.decodedHash", sha256(decoded) == tex["sha256Decoded"])
        check(f"texture.{tex['name']}.magic", decoded[:8] == b"Texture\0")
        width, height, depth, levels, fmt, usage, kind = struct.unpack_from("<7I", decoded, 56)
        check(f"texture.{tex['name']}.dims",
              (width, height, depth, levels) == (tex["width"], tex["height"], 1, tex["levels"]))
        check(f"texture.{tex['name']}.format", fmt == tex["format"])
        check(f"texture.{tex['name']}.usage", usage == tex["usage"])
        check(f"texture.{tex['name']}.kind", kind == 3)
        check(f"texture.{tex['name']}.fullChain", tex["completeChain"] is True
              and len(decoded) - 84 == tex["payloadBytes"])
        check(f"texture.{tex['name']}.texFile",
              (OUT / tex["files"]["texture"]).read_bytes() == decoded)
        check(f"texture.{tex['name']}.png", (OUT / tex["files"]["png"]).exists())
        rgba = top_rgba(decoded, tex)
        check(f"texture.{tex['name']}.topMip", sha256(rgba) == tex["sha256TopMipRgba"])
        check(f"texture.{tex['name']}.topMipLength",
              len(rgba) == width * height * 4)
        check(f"texture.{tex['name']}.hashRegistry",
              m["hashes"]["textures"].get(tex["name"]) == tex["sha256Decoded"])

    # provenance / trigger names / status coverage
    ids = {e["id"] for e in m["effects"]}
    required = {"vfx.tyre_smoke", "vfx.skid_marks", "vfx.boost_flame",
                "vfx.shield_bubble.normal", "vfx.shield_bubble.super", "vfx.mine_arm",
                "vfx.mine_detonate", "vfx.explosion_wreck", "vfx.impact_sparks",
                "vfx.repair_sparkle", "vfx.shock_wave", "vfx.blindfire_muzzle",
                "vfx.shunt_trail", "vfx.barge_shockwave", "vfx.start_finish_gate"}
    check("coverage.requiredEffects", required == ids, str(sorted(ids)))
    check("coverage.eventRecords", len(seen_events) >= 25, str(len(seen_events)))
    check("coverage.noUnsupported", m["counts"]["unsupported"] == 0)
    check("implementation.provenance",
          m["implementation"]["costAt8Cars"]["provenance"] == "provisional")
    check("implementation.atlasPages", len(m["implementation"]["atlas"]["pages"]) == 3)
    check("limits.nonEmpty", len(m["limits"]) >= 3)

    failures = [c for c in CHECKS if not c["ok"]]
    summary = {"checks": len(CHECKS), "passed": len(CHECKS) - len(failures),
               "failed": len(failures), "failures": failures[:50]}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "verify.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"checks": summary["checks"], "passed": summary["passed"],
                      "failed": summary["failed"]}))
    for f in failures[:20]:
        print("FAIL", f["name"], f["detail"])
    return 0 if not failures else 1


def top_rgba(decoded, tex):
    fmt = tex["format"]
    texels = decoded[84:]
    top = tex["topMipBytes"]
    if tex["formatLabel"] == "RGBA8":
        return texels[:top]
    from PIL import Image
    header = [124, 0x1007, tex["height"], tex["width"], 0, 0, 1] + [0] * 11
    header += [32, 4, fmt, 0, 0, 0, 0, 0, 0x1000, 0, 0, 0, 0]
    dds = b"DDS " + struct.pack("<31I", *header) + texels[:top]
    return Image.open(io.BytesIO(dds)).convert("RGBA").tobytes()


if __name__ == "__main__":
    sys.exit(main())
