"""Decode the real RP_CarDynamics record into the harness field list.

This module is imported by engine/verify_vehicle.py. It reads the installed
gamedata.pak, decodes gamedata\\xt\\racingphysics.bin (FLSK v2) with the same
table layout the project's XT metadata reader documents, and turns one
RP_CarDynamics record into the `name<TAB>value` list the C++ harness consumes.

Nothing is invented: every value is read at the schema offset for its field, and
arrays are resolved through the record's FlaskArray descriptors. Format
authority: probes/asset-reader/FORMAT-xt.md.
"""

from __future__ import annotations

import json
import struct
import sys
import zlib
from pathlib import Path

TABLES = [("types", 12), ("bases", 4), ("fields", 8), ("strings", 1),
          ("refs", 8), ("records", 16), ("components", 6), ("data", 1)]


def extract(game_dir: Path) -> bytes:
    tools = Path(__file__).resolve().parents[3] / "tools"
    if str(tools) not in sys.path:
        sys.path.insert(0, str(tools))
    from inspect_asset_layout import pak_index  # noqa: E402

    pak = game_dir / "cache/gamedata.pak"
    index = pak_index(pak)
    entry = next(r for r in index["entries"]
                 if r["path"] == "\\gamedata\\xt\\racingphysics.bin")
    with pak.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    inflater = zlib.decompressobj()
    data = inflater.decompress(packed, entry["logical_bytes"] + 1)
    if len(data) != entry["logical_bytes"] or not inflater.eof or inflater.unused_data:
        raise ValueError("racingphysics.bin zlib extent mismatch")
    return data


def parse(data: bytes) -> dict:
    """Tables + schema, using the layout FORMAT-xt.md proves."""
    header = struct.unpack_from("<18I", data)
    if header[0] != 0x464C534B or header[1] not in (1, 2):
        raise ValueError("unsupported FLSK tag/version")
    t = {}
    for i, (name, width) in enumerate(TABLES):
        offset, count = header[2 + i * 2:4 + i * 2]
        t[name] = {"offset": offset, "count": count, "units": width}

    def rows(name, fmt):
        tb = t[name]
        w = tb["units"]
        return [struct.unpack_from("<" + fmt, data, tb["offset"] + i * w)
                for i in range(tb["count"])]

    raw_strings = bytearray(data[t["strings"]["offset"]:t["strings"]["offset"] + t["strings"]["count"]])
    if header[1] == 2 and raw_strings:
        prev = 0xCC
        encoded = bytes(raw_strings)
        for i in range(len(encoded) - 1):
            decoded = (prev - (encoded[i] ^ 0xB3)) & 255
            raw_strings[i] = decoded
            prev = (prev + decoded - i) & 255
        raw_strings[-1] = 0
    strings = bytes(raw_strings)

    def name_at(at):
        end = strings.find(b"\0", at)
        return strings[at:end].decode("ascii")

    types = [{"index": i, "name": name_at(r[0]), "behaviour": r[3], "atom": r[4], "size": r[5],
              "fieldStart": fs, "fieldCount": fc}
             for i, (r, (fs, fc)) in enumerate(
                 zip(rows("types", "6H"),
                     _field_ranges(rows("types", "6H"))))]
    fields = [{"name": name_at(r[0]), "type": r[1], "offset": r[2],
               "behaviour": r[3], "array": r[4]}
              for r in rows("fields", "3H2B")]
    components = rows("components", "3H")
    records = [{"index": i, "id": refs[0], "type": refs[1],
                "componentStart": cs, "componentCount": cc, "dataBytes": nd,
                "stringBytes": ns, "dataOffset": t["data"]["offset"] + do}
               for i, ((refs, cs, cc, nd, ns, do))
               in enumerate(_record_rows(rows, t))]
    return {"version": header[1], "tables": t, "types": types, "fields": fields,
            "components": components, "records": records, "data": data}


def _field_ranges(type_rows):
    at = 0
    for r in type_rows:
        yield at, r[1]
        at += r[1]


def _record_rows(rows, tables):
    refs = rows("refs", "I2H")
    records = rows("records", "4I")
    types = rows("types", "6H")
    components = rows("components", "3H")
    data_at = 0
    comp_at = 0
    for rec in records:
        ref, nc, nd, ns = rec
        yield (refs[ref], comp_at, nc, nd, ns, data_at)
        used = 0
        for typ, count, beh in components[comp_at:comp_at + nc]:
            used = (used + count * (types[typ][5] if beh == 0 else 4) + 3) & ~3
        data_at += nd + ns
        comp_at += nc


ATOM = {1: "bool", 4: "i32", 12: "sz8", 10: "f32"}


def _string_blob(xt: dict, rec: dict) -> bytes:
    data = xt["data"]
    raw = data[rec["dataOffset"] + rec["dataBytes"]:
               rec["dataOffset"] + rec["dataBytes"] + rec["stringBytes"]]
    if xt["version"] != 2:
        return bytes(raw)
    out = bytearray(raw)
    prev = 0xCC
    for i in range(len(raw) - 1):
        decoded = (prev - (raw[i] ^ 0xB3)) & 255
        out[i] = decoded
        prev = (prev + decoded - i) & 255
    out[-1] = 0
    return bytes(out)


def leaves(xt: dict, type_index: int, path: str = "", base: int = 0) -> list[dict]:
    """Every scalar/array/handle leaf of a struct, in declaration order.

    ase is the offset of this struct inside the record image, so the returned
    offsets are absolute within the RP_CarDynamics image.
    """
    t = xt["types"][type_index]
    out = []
    for i in range(t["fieldStart"], t["fieldStart"] + t["fieldCount"]):
        f = xt["fields"][i]
        name = f"{path}.{f['name']}" if path else f["name"]
        off = base + f["offset"]
        if f["behaviour"] == 3:
            if f["array"]:
                out.append({"kind": "structArray", "name": name, "type": f["type"],
                            "offset": off})
            else:
                out.extend(leaves(xt, f["type"], name, off))
        elif f["behaviour"] == 5:
            out.append({"kind": "handle", "name": name, "type": f["type"],
                        "offset": off})
        elif f["behaviour"] in (1, 2):
            # enum / flags: 4-byte value at the schema offset
            out.append({"kind": "i32", "name": name, "type": f["type"],
                        "offset": off})
        else:
            atom = ATOM.get(xt["types"][f["type"]]["atom"], "?")
            out.append({"kind": atom, "name": name, "type": f["type"],
                        "offset": off, "array": f["array"]})
    return out


def decode_car(xt: dict, wanted: str) -> tuple[list[tuple[str, str]], dict]:
    """Return (field lines, evidence) for the named RP_CarDynamics record."""
    by_name = {t["name"]: t["index"] for t in xt["types"]}
    car_type = by_name["RP_CarDynamics"]
    data = xt["data"]
    chosen = None
    for rec in xt["records"]:
        if rec["type"] != car_type:
            continue
        blob = _string_blob(xt, rec)
        name_off = struct.unpack_from("<I", data, rec["dataOffset"])[0]
        end = blob.find(b"\0", name_off)
        name = blob[name_off:end].decode("ascii")
        if name == wanted:
            chosen = (rec, name)
            break
    if chosen is None:
        raise ValueError(f"no RP_CarDynamics record named {wanted!r}")
    rec, name = chosen
    image = data[rec["dataOffset"]:rec["dataOffset"] + rec["dataBytes"]]

    # component table for this record: component -> (type, count, offset in image)
    comps = []
    cursor = 0
    for i in range(rec["componentStart"], rec["componentStart"] + rec["componentCount"]):
        typ, count, beh = xt["components"][i]
        width = xt["types"][typ]["size"] if beh == 0 else 4
        comps.append({"type": typ, "count": count, "behaviour": beh,
                      "offset": cursor, "width": width})
        cursor = (cursor + count * width + 3) & ~3

    handle_ids = {}
    lines = [("record.name", name)]
    used_components = []

    def emit(leaf_path, value):
        lines.append((leaf_path, value))

    for leaf in leaves(xt, car_type):
        off = leaf["offset"]
        if leaf["kind"] == "sz8":
            continue  # 'name' handled above
        if leaf["kind"] == "handle":
            # FlaskHandle = {U32 id}; -1 means null. Other ids are resolved by the
            # (unported) XT database, which can also see other packs, so the
            # harness installs the null handle and reports the raw id.
            handle_id = struct.unpack_from("<I", image, off)[0]
            if handle_id == 0xFFFFFFFF:
                handle_id = 0
            handle_ids[leaf["name"]] = handle_id
            emit(leaf["name"], "0")
            continue
        if leaf.get("array") or leaf["kind"] == "structArray":
            component, element, length = struct.unpack_from("<HHI", image, off)
            if component == 0xFFFF or length == 0:
                emit(leaf["name"], "0")
                continue
            comp = comps[component]
            elem_size = comp["width"]
            base = comp["offset"] + element * elem_size
            if comp["type"] != leaf["type"]:
                raise ValueError(f"{leaf['name']}: element type mismatch")
            emit(leaf["name"], str(length))
            for k in range(length):
                at = base + k * elem_size
                if leaf["kind"] in ("f32",):
                    v = struct.unpack_from("<I", image, at)[0]
                    lines.append((f"{leaf['name']}[{k}]", f"{v:08x}"))
                elif leaf["kind"] == "structArray" and xt["types"][leaf["type"]]["name"] == "RP_GraphPoint":
                    x, y = struct.unpack_from("<II", image, at)
                    lines.append((f"{leaf['name']}[{k}].x", f"{x:08x}"))
                    lines.append((f"{leaf['name']}[{k}].y", f"{y:08x}"))
                else:
                    raise ValueError(f"{leaf['name']}: unsupported array element {leaf['kind']}")
            used_components.append(component)
            continue
        if leaf["kind"] == "f32":
            bits = struct.unpack_from("<I", image, off)[0]
            emit(leaf["name"], f"{bits:08x}")
        elif leaf["kind"] == "i32":
            emit(leaf["name"], str(struct.unpack_from("<i", image, off)[0]))
        elif leaf["kind"] == "bool":
            emit(leaf["name"], str(struct.unpack_from("<I", image, off)[0]))
        else:
            raise ValueError(f"{leaf['name']}: unsupported leaf {leaf['kind']}")

    lines.insert(1, ("record.physicsParametersHandle",
                     str(handle_ids.get("mass.physicsParameters", 0))))

    evidence = {
        "record": {
            "index": rec["index"], "id": rec["id"], "name": name,
            "type": "RP_CarDynamics", "typeSize": xt["types"][car_type]["size"],
            "components": comps, "arrayComponentsUsed": sorted(set(used_components)),
        },
        "physicsParametersHandleId": handle_ids.get("mass.physicsParameters", 0),
        "fields": [{"name": k, "value": v} for k, v in lines],
    }
    return lines, evidence
