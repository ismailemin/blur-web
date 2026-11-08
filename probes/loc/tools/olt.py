"""Strict OLTX v1 localization reader, derived from the shipped bytes.

The format is proven against all 23 `*.loc` files in `gamedata.pak` (see
`docs/work/analysis/localization.md`).  Nothing here is guessed: every offset
below is cross-checked while parsing, and any deviation raises `LocFormatError`
instead of falling back.

Layout (all integers little-endian, offsets absolute unless marked *rel*):

```
0x00  char[4]   magic "OLTX"
0x04  uint32    version (1)
0x08  uint32    offset base (16 in every shipped file)
0x0c  uint32    locale-area offset, *rel* to 0x08
0x10  uint32    middle-header size; locale table starts at 0x10 + this (12)
0x14  uint32    locale count (5 in every shipped file)
0x18  uint32    key-table offset, *rel* to 0x08
0x1c  locale[count] { char[4] code; u8 reserved[12]; uint32 offset; uint32 size; }

key table (at 0x08 + 0x18):
    uint32 count; uint32 stride (8);
    count x { uint32 hash; uint32 nameOffset *rel* to key table; }
    NUL-terminated ASCII key names between the rows and the locale area.

locale blob (at entry.offset, length entry.size):
    uint32 count; uint32 stride (8);
    count x { uint32 hash; uint32 valueOffset *rel* to blob; }
    UTF-16LE, NUL-terminated (two zero bytes on an even boundary) values.
```

A key hash (`LocId`) is a 32-bit value stored in the table.  It is **not**
recomputed by this module: the exact hash function was not derived, and the
tables are authoritative.  `LocId -> key` therefore comes from the table.
"""

from __future__ import annotations

import hashlib
import re
import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path

MAGIC = b"OLTX"
VERSION = 1
LOCALE_RECORD_BYTES = 24
ROW_STRIDE = 8
MAX_LOCALES = 32
MAX_KEYS = 8192
NAME_RE = r"[\x21-\x7e]+"


class LocFormatError(ValueError):
    """The bytes do not match the proven OLTX v1 layout."""


@dataclass
class Locale:
    code: str
    offset: int
    size: int
    values: dict[int, str] = field(default_factory=dict)
    value_offsets: dict[int, int] = field(default_factory=dict)


@dataclass
class LocFile:
    pak_path: str
    sha256: str
    raw_bytes: int
    version: int
    offset_base: int
    locale_area_rel: int
    middle_header_size: int
    key_table_offset: int
    keys: list[tuple[int, str]]
    locales: list[Locale]
    key_offsets: dict[int, int] = field(default_factory=dict)

    @property
    def key_by_hash(self) -> dict[int, str]:
        return dict(self.keys)

    @property
    def hash_by_key(self) -> dict[str, int]:
        return {key: loc_id for loc_id, key in self.keys}

    def strings(self, code: str) -> dict[str, str]:
        by_hash = self.key_by_hash
        locale = next((item for item in self.locales if item.code == code), None)
        if locale is None:
            raise KeyError(code)
        return {by_hash[loc_id]: text for loc_id, text in locale.values.items()}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _u32(data: bytes, at: int, label: str) -> int:
    if at < 0 or at + 4 > len(data):
        raise LocFormatError(f"{label}: uint32 at {at} outside file")
    return struct.unpack_from("<I", data, at)[0]


def read_olt(data: bytes, pak_path: str = "<memory>") -> LocFile:
    if len(data) < 0x1C:
        raise LocFormatError(f"{pak_path}: shorter than the 28-byte header")
    if data[:4] != MAGIC:
        raise LocFormatError(f"{pak_path}: magic is {data[:4]!r}, not OLTX")
    version = _u32(data, 4, pak_path)
    if version != VERSION:
        raise LocFormatError(f"{pak_path}: version {version} != {VERSION}")

    offset_base = _u32(data, 8, pak_path)
    locale_area_rel = _u32(data, 0x0C, pak_path)
    middle_header_size = _u32(data, 0x10, pak_path)
    locale_count = _u32(data, 0x14, pak_path)
    key_table_rel = _u32(data, 0x18, pak_path)

    if offset_base != 0x10:
        raise LocFormatError(f"{pak_path}: offset base {offset_base} != 16")
    if middle_header_size != 0x1C - 0x10:
        raise LocFormatError(f"{pak_path}: middle header {middle_header_size} != 12")
    if not 1 <= locale_count <= MAX_LOCALES:
        raise LocFormatError(f"{pak_path}: locale count {locale_count}")

    locale_table = 0x10 + middle_header_size
    if locale_table != 0x1C:
        raise LocFormatError(f"{pak_path}: locale table at {locale_table} != 0x1c")
    if locale_table + locale_count * LOCALE_RECORD_BYTES > len(data):
        raise LocFormatError(f"{pak_path}: locale table outside file")

    key_table_offset = offset_base + key_table_rel
    locale_area_offset = offset_base + locale_area_rel
    if key_table_offset != locale_table + locale_count * LOCALE_RECORD_BYTES:
        raise LocFormatError(
            f"{pak_path}: key table {key_table_offset} does not follow the locale table")

    locales: list[Locale] = []
    previous_end = None
    for index in range(locale_count):
        at = locale_table + index * LOCALE_RECORD_BYTES
        code_bytes = data[at:at + 4]
        if code_bytes[2:] != b"\0\0":
            raise LocFormatError(f"{pak_path}: locale {index} code is not 2+NUL")
        try:
            code = code_bytes[:2].decode("ascii")
        except UnicodeDecodeError as error:
            raise LocFormatError(f"{pak_path}: locale {index} code is not ASCII") from error
        if not (len(code) == 2 and code.islower() and code.isalpha()):
            raise LocFormatError(f"{pak_path}: locale {index} code {code!r}")
        if data[at + 4:at + 16] != b"\0" * 12:
            raise LocFormatError(f"{pak_path}: locale {code} reserved bytes are not zero")
        offset, size = struct.unpack_from("<2I", data, at + 16)
        if index == 0 and offset != locale_area_offset:
            raise LocFormatError(f"{pak_path}: first locale {code} not at locale area")
        if size < 8 or offset + size > len(data):
            raise LocFormatError(f"{pak_path}: locale {code} blob outside file")
        if previous_end is not None and offset != previous_end:
            raise LocFormatError(f"{pak_path}: locale {code} is not contiguous")
        previous_end = offset + size
        locales.append(Locale(code=code, offset=offset, size=size))
    if len({locale.code for locale in locales}) != len(locales):
        raise LocFormatError(f"{pak_path}: duplicate locale code")

    key_count = _u32(data, key_table_offset, pak_path)
    key_stride = _u32(data, key_table_offset + 4, pak_path)
    if not 0 <= key_count <= MAX_KEYS:
        raise LocFormatError(f"{pak_path}: key count {key_count}")
    if key_stride != ROW_STRIDE:
        raise LocFormatError(f"{pak_path}: key stride {key_stride}")
    key_rows_end = key_table_offset + 8 + key_count * ROW_STRIDE
    if key_rows_end > locale_area_offset:
        raise LocFormatError(f"{pak_path}: key rows overlap the locale area")

    keys: list[tuple[int, str]] = []
    key_offsets: dict[int, int] = {}
    seen_hashes: set[int] = set()
    for index in range(key_count):
        loc_id, name_rel = struct.unpack_from(
            "<2I", data, key_table_offset + 8 + index * ROW_STRIDE)
        at = key_table_offset + name_rel
        if not key_rows_end <= at < locale_area_offset:
            raise LocFormatError(f"{pak_path}: key {index} name outside name region")
        end = data.find(b"\0", at, locale_area_offset)
        if end < 0 or end == at or end - at > 200:
            raise LocFormatError(f"{pak_path}: key {index} name is not terminated")
        try:
            name = data[at:end].decode("ascii")
        except UnicodeDecodeError as error:
            raise LocFormatError(f"{pak_path}: key {index} name is not ASCII") from error
        if not re.fullmatch(NAME_RE, name):
            raise LocFormatError(f"{pak_path}: key {index} name {name!r}")
        if loc_id in seen_hashes:
            raise LocFormatError(f"{pak_path}: duplicate key hash {loc_id:08x}")
        seen_hashes.add(loc_id)
        keys.append((loc_id, name))
        key_offsets[loc_id] = at
    if len({name for _, name in keys}) != len(keys):
        raise LocFormatError(f"{pak_path}: duplicate key name")

    for locale in locales:
        count = _u32(data, locale.offset, pak_path)
        stride = _u32(data, locale.offset + 4, pak_path)
        if count != key_count:
            raise LocFormatError(
                f"{pak_path}: locale {locale.code} has {count} values, {key_count} keys")
        if stride != ROW_STRIDE:
            raise LocFormatError(f"{pak_path}: locale {locale.code} stride {stride}")
        rows_end = locale.offset + 8 + count * ROW_STRIDE
        if rows_end > locale.offset + locale.size:
            raise LocFormatError(f"{pak_path}: locale {locale.code} rows outside blob")
        values: dict[int, str] = {}
        spans: list[tuple[int, int]] = []
        for index in range(count):
            loc_id, value_rel = struct.unpack_from(
                "<2I", data, locale.offset + 8 + index * ROW_STRIDE)
            if loc_id not in seen_hashes:
                raise LocFormatError(
                    f"{pak_path}: locale {locale.code} hash {loc_id:08x} has no key")
            if loc_id in values:
                raise LocFormatError(
                    f"{pak_path}: locale {locale.code} duplicate hash {loc_id:08x}")
            at = locale.offset + value_rel
            if at < rows_end or at + 2 > locale.offset + locale.size:
                raise LocFormatError(
                    f"{pak_path}: locale {locale.code} value {index} outside string area")
            if (at - locale.offset) % 2:
                raise LocFormatError(
                    f"{pak_path}: locale {locale.code} value {index} is not 2-aligned")
            end = at
            limit = locale.offset + locale.size
            while True:
                if end + 1 >= limit:
                    raise LocFormatError(
                        f"{pak_path}: locale {locale.code} value {index} unterminated")
                if data[end] == 0 and data[end + 1] == 0:
                    break
                end += 2
            try:
                text = data[at:end].decode("utf-16-le")
            except UnicodeDecodeError as error:
                raise LocFormatError(
                    f"{pak_path}: locale {locale.code} value {index} invalid UTF-16: {error}"
                ) from error
            if "\x00" in text:
                raise LocFormatError(
                    f"{pak_path}: locale {locale.code} value {index} contains U+0000")
            values[loc_id] = text
            locale.value_offsets[loc_id] = at
            spans.append((at, end))
        if set(values) != seen_hashes:
            missing = sorted(f"{h:08x}" for h in seen_hashes - set(values))
            raise LocFormatError(f"{pak_path}: locale {locale.code} misses {missing[:4]}")
        # Values must be non-overlapping and every gap must be zero padding.
        spans.sort()
        cursor = rows_end
        for span_start, span_end in spans:
            if span_start < cursor:
                raise LocFormatError(f"{pak_path}: locale {locale.code} overlapping values")
            if data[cursor:span_start] != b"\0" * (span_start - cursor):
                raise LocFormatError(f"{pak_path}: locale {locale.code} non-zero gap")
            cursor = span_end + 2
        if data[cursor:locale.offset + locale.size] != b"\0" * (
                locale.offset + locale.size - cursor):
            raise LocFormatError(f"{pak_path}: locale {locale.code} non-zero tail")
        locale.values = values

    return LocFile(
        pak_path=pak_path,
        sha256=sha256_bytes(data),
        raw_bytes=len(data),
        version=version,
        offset_base=offset_base,
        locale_area_rel=locale_area_rel,
        middle_header_size=middle_header_size,
        key_table_offset=key_table_offset,
        keys=keys,
        locales=locales,
        key_offsets=key_offsets,
    )


def read_pak_entry(pak_path: Path, entry_path: str) -> bytes:
    """Read one logical file from a Blur PAK (gamedata codec 2 = zlib)."""
    from inspect_asset_layout import pak_index

    index = pak_index(pak_path)
    if index["codec"] != 2:
        raise LocFormatError(f"{pak_path.name}: unsupported codec {index['codec']}")
    entry = next((row for row in index["entries"]
                  if row["path"].lower() == entry_path.lower()), None)
    if entry is None or entry.get("directory"):
        raise LocFormatError(f"{pak_path.name}: missing entry {entry_path}")
    with pak_path.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    try:
        decoded = zlib.decompress(packed)
    except zlib.error as error:
        raise LocFormatError(f"{entry_path}: zlib error {error}") from error
    if len(decoded) != entry["logical_bytes"]:
        raise LocFormatError(
            f"{entry_path}: decoded {len(decoded)} != logical {entry['logical_bytes']}")
    return decoded
