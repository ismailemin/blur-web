"""Shared read-only XT helpers for the livery probe.

Reuses the committed generic XT table parser (`engine/harness/t005d-vehicle/
car_xt.py`) and the PAK index reader (`tools/inspect_asset_layout.py`).  Nothing
here re-derives the FLSK layout: every offset comes from the parsed tables.

Only reads `game-data/Blur/cache/gamedata.pak`; nothing is written outside the
probe's own `_work/liveries/` output directory.
"""

from __future__ import annotations

import hashlib
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
for path in (ROOT / "tools", ROOT / "engine/harness/t005d-vehicle", ROOT / "probes/loc/tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import car_xt  # noqa: E402
from inspect_asset_layout import pak_index  # noqa: E402

GAME_DIR = ROOT / "game-data/Blur"
GAMEDATA_PAK = GAME_DIR / "cache/gamedata.pak"
ROOT_PAK = GAME_DIR / "cache/root.pak"

VEHICLES_BIN = "\\gamedata\\xt\\vehicles.bin"
UI_BIN = "\\gamedata\\xt\\ui.bin"
AMAX_BIN = "\\gamedata\\xt\\amax.bin"
SPLITSCREEN_BIN = "\\gamedata\\xt\\splitscreen.bin"
MULTIPLAYER_BIN = "\\gamedata\\xt\\multiplayer.bin"
ACHIEVEMENTS_BIN = "\\gamedata\\xt\\achievements.bin"
RACINGPHYSICS_BIN = "\\gamedata\\xt\\racingphysics.bin"
VEHICLES_LOC = "\\gamedata\\xt\\loc\\vehicles.loc"

XT_FILES = (VEHICLES_BIN, UI_BIN, AMAX_BIN, SPLITSCREEN_BIN, MULTIPLAYER_BIN,
            ACHIEVEMENTS_BIN, RACINGPHYSICS_BIN)

_CACHE: dict[str, tuple[dict, bytes]] = {}


def read_pak_entry(pak: Path, logical_path: str) -> tuple[dict, bytes]:
    """Decode one pak entry (raw zlib), returning (entry metadata, bytes)."""
    index = pak_index(pak)
    entry = next((row for row in index["entries"] if row["path"] == logical_path), None)
    if entry is None:
        raise SystemExit(f"missing pak entry {logical_path} in {pak.name}")
    with pak.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    if len(packed) != entry["stored_bytes"]:
        raise ValueError(f"short read for {logical_path}")
    inflater = zlib.decompressobj()
    data = inflater.decompress(packed, entry["logical_bytes"] + 1)
    if len(data) != entry["logical_bytes"] or not inflater.eof or inflater.unused_data:
        raise ValueError(f"zlib extent mismatch for {logical_path}")
    return entry, data


def load_xt(pak: Path, logical_path: str) -> tuple[dict, bytes]:
    key = f"{pak}|{logical_path}"
    if key not in _CACHE:
        _, data = read_pak_entry(pak, logical_path)
        _CACHE[key] = (car_xt.parse(data), data)
    return _CACHE[key]


def type_index(xt: dict, name: str) -> int:
    for row in xt["types"]:
        if row["name"] == name:
            return row["index"]
    raise KeyError(name)


def type_name(xt: dict, index: int) -> str:
    return xt["types"][index]["name"]


def record_name(xt: dict, data: bytes, rec: dict) -> str | None:
    """`AmaxGameDataObject.Name` (sz8 at offset 12); 0 is also the first string."""
    return sz8(xt, data, rec, 12)


def sz8(xt: dict, data: bytes, rec: dict, offset: int) -> str | None:
    """Read an `XtSz8` field at a schema offset inside a record image."""
    if rec["stringBytes"] == 0:
        return None
    string_offset = struct.unpack_from("<I", data, rec["dataOffset"] + offset)[0]
    blob = car_xt._string_blob(xt, rec)
    if string_offset >= len(blob):
        return None
    end = blob.find(b"\0", string_offset)
    return blob[string_offset:end].decode("ascii", "replace")


def refs_table(xt: dict, data: bytes) -> list[tuple[int, int, int]]:
    table = xt["tables"]["refs"]
    return [struct.unpack_from("<I2H", data, table["offset"] + i * table["units"])
            for i in range(table["count"])]


def record_components(xt: dict, rec: dict) -> list[dict]:
    """Component layout of one record image: type/count/behaviour/offset/width."""
    comps = []
    cursor = 0
    for i in range(rec["componentStart"], rec["componentStart"] + rec["componentCount"]):
        typ, count, beh = xt["components"][i]
        width = xt["types"][typ]["size"] if beh == 0 else 4
        comps.append({"type": typ, "count": count, "behaviour": beh,
                      "offset": cursor, "width": width})
        cursor = (cursor + count * width + 3) & ~3
    return comps


def resolve_array(xt: dict, rec: dict, off: int, image: bytes) -> list[int]:
    """Resolve a FlaskArray descriptor at `off`; return absolute image offsets."""
    component, element, length = struct.unpack_from("<HHI", image, off)
    if component == 0xFFFF or length == 0:
        return []
    comps = record_components(xt, rec)
    if component >= len(comps):
        raise ValueError("array component outside component table")
    comp = comps[component]
    if element + length > comp["count"]:
        raise ValueError("array extent exceeds component count")
    base = comp["offset"] + element * comp["width"]
    return [base + k * comp["width"] for k in range(length)]


def enum_labels(xt: dict, type_index_: int) -> list[str]:
    t = xt["types"][type_index_]
    return [xt["fields"][i]["name"]
            for i in range(t["fieldStart"], t["fieldStart"] + t["fieldCount"])]


class XtWorld:
    """All shipped XT databases needed for liveries, plus cross-file handles.

    A handle stored in a record is an index into that file's own `refs` table.
    The row gives the global record id, type index and a local record index; an
    index of 0xFFFF marks a record that lives in another file.  The global id
    then resolves through every loaded file (the runtime merges them).
    """

    def __init__(self, pak: Path = GAMEDATA_PAK):
        self.pak = pak
        self.files: dict[str, dict] = {}
        self.by_id: dict[int, tuple[str, dict]] = {}
        self.sha256: dict[str, str] = {}
        for logical in XT_FILES:
            xt, data = load_xt(pak, logical)
            refs = refs_table(xt, data)
            self.files[logical] = {"xt": xt, "data": data, "refs": refs}
            self.sha256[logical] = sha256_bytes(data)
            for rec in xt["records"]:
                if rec["id"] == 0xFFFFFFFF:
                    continue
                if rec["id"] in self.by_id:
                    raise ValueError(f"duplicate global XT id {rec['id']}")
                self.by_id[rec["id"]] = (logical, rec)

    def record(self, logical: str, rec: dict) -> dict:
        xt = self.files[logical]["xt"]
        return {"file": logical, "record": rec, "type": type_name(xt, rec["type"]),
                "id": rec["id"], "index": rec["index"],
                "dataOffset": rec["dataOffset"], "dataBytes": rec["dataBytes"],
                "stringBytes": rec["stringBytes"]}

    def local(self, logical: str, rec: dict) -> bytes:
        data = self.files[logical]["data"]
        return data[rec["dataOffset"]:rec["dataOffset"] + rec["dataBytes"]]

    def resolve(self, logical: str, handle: int):
        """Resolve a FlaskHandle to (file, record); None for the null handle."""
        if handle == 0xFFFFFFFF:
            return None
        refs = self.files[logical]["refs"]
        if handle >= len(refs):
            raise ValueError(f"handle {handle} outside {logical} refs table")
        rid, tid, ridx = refs[handle]
        expected = type_name(self.files[logical]["xt"], tid)
        if ridx != 0xFFFF:
            rec = self.files[logical]["xt"]["records"][ridx]
            if rec["id"] != rid:
                raise ValueError(f"local ref id mismatch for {logical} handle {handle}")
            return logical, rec
        hit = self.by_id.get(rid)
        if hit is None:
            raise ValueError(f"external XT id {rid} ({expected}) has no record")
        actual = type_name(self.files[hit[0]]["xt"], hit[1]["type"])
        if actual != expected:
            raise ValueError(f"external XT type mismatch {actual} != {expected} for {rid}")
        return hit

    def name_of(self, logical: str, rec: dict) -> str | None:
        return record_name(self.files[logical]["xt"], self.files[logical]["data"], rec)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()
