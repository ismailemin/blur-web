"""Bounded PC FLSK v1/v2 record decoder (read-only, no runtime import).

This module re-uses the table/layout validation semantics of the committed
reference reader (`tools/prepare_xt_fixture.py`) and adds payload decoding for
the serialized field behaviours:

  behaviour 3 struct  : inline struct at the field offset
  behaviour 4 ptr     : FlaskPtr {u16 component, u16 element}; `component` is an
                        index into the *owning record's* component table, exactly
                        as `FlaskDecodePtr` reads it (XtFlaskImport.cpp:696-713).
  behaviour 5 handle  : FlaskHandle {u32 id}; after `CompileRefList` the u32 is
                        an index into the sorted refs table, not the record id
                        (XtFlaskImport.cpp:715-727; XtFlaskExport.cpp CompileRefList).
  field array flag    : FlaskArray {u16 component, u16 element, u32 length};
                        `component` is an index into the owning record's table,
                        exactly as `FlaskDecodeArray` reads it.

Enum values are stored as *label indices*: `FlaskDecodeEnum` looks the index up
in the type's label rows and assigns the label's declared value
(XtFlaskImport.cpp:656-666). The declared value is not serialized in the flask,
so this reader exposes the label index and label name only; it never invents the
retail integer. Atoms use the serialized width from `XtAtomType`
(XtReflection.h:134-153).

No offsets are guessed: every read is bounds-checked and any mismatch raises.
"""
from __future__ import annotations

import struct

MAX_BYTES = 64 * 1024 * 1024
TABLE_ROWS = [
    ("types", 12, 4096),
    ("bases", 4, 65535),
    ("fields", 8, 100000),
    ("strings", 1, 4 * 1024 * 1024),
    ("refs", 8, 65535),
    ("records", 16, 65535),
    ("components", 6, 100000),
    ("data", 1, MAX_BYTES),
]
ATOMS = {
    1: ("bool", "<I", 4, lambda v: bool(v)),
    2: ("i8", "<b", 1, int),
    3: ("i16", "<h", 2, int),
    4: ("i32", "<i", 4, int),
    5: ("i64", "<q", 8, int),
    6: ("u8", "<B", 1, int),
    7: ("u16", "<H", 2, int),
    8: ("u32", "<I", 4, int),
    9: ("u64", "<Q", 8, int),
    10: ("f32", "<f", 4, float),
    11: ("f64", "<d", 8, float),
    12: ("sz8", "<I", 4, int),
    13: ("sz16", "<I", 4, int),
    14: ("locId", "<I", 4, int),
}


class FlaskError(ValueError):
    pass


def decode_pc_strings(encoded: bytes) -> bytes:
    """XtFlaskDecodeStrings, XtFlask.cpp:11-28 (v2 XOR/prev-byte transform)."""
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


class Flask:
    def __init__(self, data: bytes):
        if not 72 <= len(data) <= MAX_BYTES:
            raise FlaskError("XT input outside bounds")
        self.data = data
        header = struct.unpack_from("<18I", data)
        if header[0] != 0x464C534B or header[1] not in (1, 2):
            raise FlaskError("Unsupported PC FLSK tag/version")
        self.version = header[1]
        self.tables = {}
        regions = []
        for i, (name, size, limit) in enumerate(TABLE_ROWS):
            offset, count = header[2 + i * 2:4 + i * 2]
            length = count * size
            if offset % 4 or count > limit or offset > len(data) or length > len(data) - offset:
                raise FlaskError(f"{name} table outside bounds")
            if length:
                if offset < 72:
                    raise FlaskError("Table overlaps header")
                regions.append((offset, offset + length))
            self.tables[name] = {"offset": offset, "count": count, "elementBytes": size}
        regions.sort()
        if any(a[1] > b[0] for a, b in zip(regions, regions[1:])):
            raise FlaskError("Overlapping XT tables")

        st = self.tables["strings"]
        encoded = data[st["offset"]:st["offset"] + st["count"]]
        strings = bytearray(encoded)
        if self.version == 2 and strings:
            previous = 0xCC
            for i, byte in enumerate(encoded[:-1]):
                decoded = (previous - (byte ^ 0xB3)) & 255
                strings[i] = decoded
                previous = (previous + decoded - i) & 255
            strings[-1] = 0
        else:
            strings[-1:] = b"\0" if strings else b""
        self.strings = bytes(strings)
        self._name_cache: dict[int, str] = {}

        def rows(name, fmt):
            t = self.tables[name]
            return [struct.unpack_from("<" + fmt, data, t["offset"] + i * t["elementBytes"])
                    for i in range(t["count"])]

        self.types = rows("types", "6H")
        self.bases = rows("bases", "2H")
        self.fields = rows("fields", "3H2B")
        self.refs = rows("refs", "I2H")
        self.records = rows("records", "4I")
        self.components = rows("components", "3H")
        self._validate_schema()
        self._data_base = self.tables["data"]["offset"]
        self._component_start = []
        start = 0
        for row in self.records:
            self._component_start.append(start)
            start += row[1]
        self._data_start = []
        start = 0
        for row in self.records:
            self._data_start.append(start)
            start += row[2] + row[3]
        if start != self.tables["data"]["count"]:
            raise FlaskError("Record data/string bytes do not consume the data table")

    # ---------------------------------------------------------------- schema
    def name(self, at: int) -> str:
        if at in self._name_cache:
            return self._name_cache[at]
        if at >= len(self.strings):
            raise FlaskError("Schema name outside string table")
        end = self.strings.find(b"\0", at)
        if end < at or end - at > 4096:
            raise FlaskError("Unterminated/oversize schema name")
        value = self.strings[at:end]
        if any(x < 32 or x > 126 for x in value):
            raise FlaskError("Unsupported schema name encoding")
        self._name_cache[at] = value.decode("ascii")
        return self._name_cache[at]

    def _validate_schema(self) -> None:
        base_at = field_at = 0
        for index, (nm, nf, nb, behaviour, atom, size) in enumerate(self.types):
            if behaviour >= 4 or (behaviour == 0 and not 0 < atom < 15) or (behaviour != 0 and atom != 0):
                raise FlaskError("Invalid XT type behaviour/atom")
            if (behaviour == 0 and nf) or (behaviour != 3 and nb):
                raise FlaskError("Invalid XT atom/base count")
            if nb > len(self.bases) - base_at or nf > len(self.fields) - field_at:
                raise FlaskError("Type schema range outside table")
            for bt, offset in self.bases[base_at:base_at + nb]:
                if bt >= len(self.types) or self.types[bt][3] != 3 or offset > size or self.types[bt][5] > size - offset:
                    raise FlaskError("Invalid XT base reference/range")
            for fi in range(field_at, field_at + nf):
                fn, ft, off, fb, arr = self.fields[fi]
                if fb >= 7:
                    raise FlaskError("Invalid XT field behaviour")
                if behaviour in (1, 2):
                    if ft != 65535 or off or fb != 6 or arr:
                        raise FlaskError("Invalid XT enum/flag label")
                elif behaviour == 3:
                    if ft >= len(self.types) or fb >= 6:
                        raise FlaskError("Invalid XT struct field type")
                    expected = [0, 1, 2, 3, 3, 3][fb]
                    if self.types[ft][3] != expected:
                        raise FlaskError("Mismatched XT field/type behaviour")
                    width = 8 if arr else 4 if fb in (4, 5) else self.types[ft][5]
                    if off > size or width > size - off:
                        raise FlaskError("XT field exceeds containing type")
            base_at += nb
            field_at += nf
        if base_at != len(self.bases) or field_at != len(self.fields):
            raise FlaskError("Unused XT schema table rows")
        last_id = 0
        for ident, typ, record in self.refs:
            if ident <= last_id or typ >= len(self.types) or (record != 65535 and record >= len(self.records)):
                raise FlaskError("Invalid XT ref ordering/type/record")
            last_id = ident
        component_at = data_at = 0
        for i, (ref, nc, nd, ns) in enumerate(self.records):
            if ref >= len(self.refs) or nc == 0 or nc > len(self.components) - component_at:
                raise FlaskError("Invalid XT record/component range")
            used = 0
            for typ, count, behaviour in self.components[component_at:component_at + nc]:
                if typ >= len(self.types) or behaviour >= 3:
                    raise FlaskError("Invalid XT component type/behaviour")
                used = (used + count * (self.types[typ][5] if behaviour == 0 else 4) + 3) & ~3
            if used != nd or nd + ns > self.tables["data"]["count"] - data_at:
                raise FlaskError("XT record data extent mismatch")
            component_at += nc
            data_at += nd + ns

    # --------------------------------------------------------------- schema
    def type_name(self, index: int) -> str:
        return self.name(self.types[index][0])

    def type_fields(self, index: int) -> list[dict]:
        _nm, nf, nb, _b, _a, _s = self.types[index]
        start = sum(self.types[i][1] for i in range(index))
        out = []
        for fi in range(start, start + nf):
            fn, ft, off, fb, arr = self.fields[fi]
            out.append({"name": self.name(fn), "typeIndex": None if ft == 65535 else ft,
                        "offset": off, "behaviour": fb, "array": bool(arr)})
        return out

    def type_bases(self, index: int) -> list[dict]:
        _nm, _nf, nb, _b, _a, _s = self.types[index]
        start = sum(self.types[i][2] for i in range(index))
        return [{"typeIndex": bt, "offset": off} for bt, off in self.bases[start:start + nb]]

    def all_fields(self, index: int, base_offset: int = 0) -> list[dict]:
        """Own fields plus inherited base fields, with absolute struct offsets."""
        out = []
        for b in self.type_bases(index):
            out.extend(self.all_fields(b["typeIndex"], base_offset + b["offset"]))
        for field in self.type_fields(index):
            out.append({**field, "offset": base_offset + field["offset"]})
        return out

    def type_labels(self, index: int) -> list[str]:
        return [f["name"] for f in self.type_fields(index)]

    def is_base_of(self, base: int, derived: int) -> bool:
        if base == derived:
            return True
        return any(self.is_base_of(base, b["typeIndex"]) for b in self.type_bases(derived))

    # -------------------------------------------------------------- records
    def record_type(self, index: int) -> int:
        return self.refs[self.records[index][0]][1]

    def record_id(self, index: int) -> int:
        return self.refs[self.records[index][0]][0]

    def record_payload(self, index: int) -> bytes:
        rec = self.records[index]
        off = self._data_base + self._data_start[index]
        return self.data[off:off + rec[2]]

    def record_strings(self, index: int) -> bytes:
        rec = self.records[index]
        off = self._data_base + self._data_start[index] + rec[2]
        return decode_pc_strings(self.data[off:off + rec[3]])

    # --------------------------------------------------------------- decode
    def decode_record(self, index: int, depth: int = 0, stack: tuple = ()) -> dict:
        if depth > 32:
            raise FlaskError("Record graph too deep")
        if index in stack:
            return {"$cycle": index}
        rec = self.records[index]
        root = rec[0]
        type_index = self.refs[root][1]
        payload = self.record_payload(index)
        prev = self._current_strings
        self._current_strings = self.record_strings(index)
        try:
            return self._decode_component(index, type_index, payload, 0,
                                          depth + 1, stack + (index,))
        finally:
            self._current_strings = prev

    def _decode_component(self, record: int, type_index: int,
                          payload: bytes, base: int, depth: int, stack: tuple) -> dict:
        """Decode one serialized struct element that starts at `base`."""
        type_behaviour = self.types[type_index][3]
        if type_behaviour in (0, 1, 2):  # atom / enum / flags element
            return self._decode_atom(type_index, type_behaviour, payload, base)
        out: dict = {}
        for b in self.type_bases(type_index):
            out.update(self._decode_component(record, b["typeIndex"],
                                              payload, base + b["offset"], depth, stack))
        out["$type"] = self.type_name(type_index)
        for field in self.type_fields(type_index):
            off = base + field["offset"]
            value = self._decode_field(record, field, payload, off,
                                       depth, stack)
            out[field["name"]] = value
        return out

    def _decode_field(self, record: int, field: dict,
                      payload: bytes, off: int, depth: int, stack: tuple):
        ft = field["typeIndex"]
        if field["array"]:
            if off + 8 > len(payload):
                raise FlaskError("Array field outside payload")
            component, element, length = struct.unpack_from("<2HI", payload, off)
            if component == 0xFFFF:
                if length != 0:
                    raise FlaskError("Null array with nonzero length")
                return {"length": 0, "items": [], "component": None, "element": None}
            target = self._component_at(record, component)
            return {
                "component": component,
                "element": element,
                "length": length,
                "typeName": self.type_name(target["typeIndex"]),
                "items": [self._component_element(record, component, element + i,
                                                  depth + 1, stack)
                          for i in range(length)],
            }
        kind = field["behaviour"]
        if kind == 4:  # FlaskPtr: index into the owning record's components
            if off + 4 > len(payload):
                raise FlaskError("Pointer field outside payload")
            return self._resolve_ptr(record, payload, off, depth, stack)
        if kind == 5:  # FlaskHandle: post-fixup index into the refs table
            if off + 4 > len(payload):
                raise FlaskError("Handle field outside payload")
            return self._resolve_handle(payload, off, depth, stack)
        if kind == 3:  # inline struct
            return self._decode_struct(record, ft, payload, off, depth, stack)
        if kind in (0, 1, 2):  # atom / enum / flags
            return self._decode_atom(ft, kind, payload, off)
        raise FlaskError(f"Unsupported field behaviour {kind}")

    def _decode_struct(self, record: int, type_index: int,
                       payload: bytes, base: int, depth: int, stack: tuple) -> dict:
        if base + self.types[type_index][5] > len(payload):
            raise FlaskError("Struct field outside payload")
        return self._decode_component(record, type_index, payload, base,
                                      depth, stack)

    def _decode_atom(self, type_index: int, kind: int, payload: bytes, off: int):
        t = self.types[type_index]
        if kind == 1:  # enum: stored label index, declared value not serialized
            if off + 4 > len(payload):
                raise FlaskError("Enum field outside payload")
            index = struct.unpack_from("<I", payload, off)[0]
            labels = self.type_labels(type_index)
            if index >= len(labels):
                raise FlaskError("Enum label index out of range")
            return {"labelIndex": index, "label": labels[index]}
        if kind == 2:  # flags
            if off + 4 > len(payload):
                raise FlaskError("Flags field outside payload")
            bits = struct.unpack_from("<I", payload, off)[0]
            labels = self.type_labels(type_index)
            return {"bits": bits, "labels": [n for i, n in enumerate(labels) if bits & (1 << i)]}
        atom = t[4]
        if atom not in ATOMS:
            raise FlaskError("Unsupported atom")
        name = ATOMS[atom][0]
        width = 8 if t[5] == 8 else 4
        if off + width > len(payload):
            raise FlaskError("Atom field outside payload")
        if atom in (12, 13):
            raw = struct.unpack_from("<I", payload, off)[0]
            return {"atom": name, "stringOffset": raw,
                    "value": self._record_string(self._current_strings, raw)}
        if atom == 14:
            raw = struct.unpack_from("<I", payload, off)[0]
            return {"atom": name, "id": f"{raw:08x}"}
        if atom == 1:
            return struct.unpack_from("<I", payload, off)[0] != 0
        if atom in (10, 11):
            return struct.unpack_from("<d" if width == 8 else "<f", payload, off)[0]
        if atom in (2, 3, 4, 5):
            return struct.unpack_from("<q" if width == 8 else "<i", payload, off)[0]
        return struct.unpack_from("<Q" if width == 8 else "<I", payload, off)[0]

    _current_strings = b""

    def _record_string(self, strings: bytes, offset: int):
        if offset >= len(strings):
            return None
        end = strings.find(b"\0", offset)
        if end < 0:
            return None
        return strings[offset:end].decode("latin-1")

    def _component_at(self, record: int, relative: int) -> dict:
        component = self._component_start[record] + relative
        if not 0 <= relative < self.records[record][1] or component >= len(self.components):
            raise FlaskError("Component index out of range")
        return {"typeIndex": self.components[component][0],
                "count": self.components[component][1],
                "behaviour": self.components[component][2]}

    def _component_offset(self, record: int, relative: int) -> int:
        offset = 0
        for typ, count, behaviour in self.components[
                self._component_start[record]:
                self._component_start[record] + relative]:
            offset = (offset + count * (self.types[typ][5] if behaviour == 0 else 4) + 3) & ~3
        return offset

    def _resolve_ptr(self, record: int, payload: bytes, at: int, depth: int, stack: tuple):
        component, element = struct.unpack_from("<2H", payload, at)
        if component == 0xFFFF:
            return None
        target = self._component_at(record, component)
        if target["behaviour"] != 0:
            raise FlaskError("Pointer target is not an object component")
        return self._component_element(record, component, element, depth + 1, stack)

    def _resolve_handle(self, payload: bytes, at: int, depth: int, stack: tuple):
        ref_index = struct.unpack_from("<I", payload, at)[0]
        if ref_index == 0xFFFFFFFF:
            return None
        if ref_index >= len(self.refs):
            raise FlaskError("Handle ref index out of range")
        ref_id, ref_type, ref_record = self.refs[ref_index]
        if ref_record == 0xFFFF:
            return {"refIndex": ref_index, "refId": ref_id,
                    "typeName": self.type_name(ref_type), "record": None,
                    "unloaded": True, "value": None}
        return {"refIndex": ref_index, "refId": ref_id,
                "typeName": self.type_name(ref_type), "record": ref_record,
                "value": self.decode_record(ref_record, depth + 1, stack)}

    def _component_element(self, record: int, component: int,
                           element: int, depth: int, stack: tuple):
        meta = self._component_at(record, component)
        if not 0 <= element < meta["count"]:
            raise FlaskError("Component element out of range")
        payload = self.record_payload(record)
        base = self._component_offset(record, component) + element * (
            self.types[meta["typeIndex"]][5] if meta["behaviour"] == 0 else 4)
        if base + (self.types[meta["typeIndex"]][5] if meta["behaviour"] == 0 else 4) > len(payload):
            raise FlaskError("Component element outside payload")
        prev = self._current_strings
        self._current_strings = self.record_strings(record)
        try:
            if meta["behaviour"] == 0:
                return self._decode_component(record, meta["typeIndex"], payload, base,
                                              depth, stack)
            if meta["behaviour"] == 1:
                return self._resolve_ptr(record, payload, base, depth, stack)
            if meta["behaviour"] == 2:
                return self._resolve_handle(payload, base, depth, stack)
            raise FlaskError("Unsupported component behaviour")
        finally:
            self._current_strings = prev


def load(path) -> Flask:
    return Flask(open(path, "rb").read())
