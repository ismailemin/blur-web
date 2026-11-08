"""Minimal OLTX (XtLocFile) reader for the race-rules mode catalogue.

Format authority: upstream `xt/impl/XtLocFile.h` and
`ui/Graphics/Localisation/XtLocHack.cpp`.

  XtLocHeader  { u32 tag 'XTLO'; u32 version; XtLocBlock toc; }
  XtLocBlock   { u32 offset; u32 size; }            // absolute file offsets
  XtLocToc     { u32 langOffset; u32 langCount; u32 lookupOffset; }  // relative to toc
  XtLocLang    { char name[16]; XtLocBlock data; }  // data offsets absolute
  XtLocTable   { u32 count; u32 offset; }           // offset relative to the table
  XtLocEntry   { u32 id; u32 offset; }              // name offset relative to table;
                                                    // translation offset relative to block

Only English is read. Strings are UTF-16LE and NUL-terminated. This module does
not invent a string when the id is absent: `text` is None.
"""

from __future__ import annotations

import struct

TAG = 0x58544C4F  # 'XTLO' as stored by the little-endian PC build


class LocError(ValueError):
    pass


def _u16z(data: bytes, offset: int) -> str:
    chars = []
    end = len(data) - 1
    while offset + 1 < end:
        unit = struct.unpack_from("<H", data, offset)[0]
        if unit == 0:
            break
        chars.append(chr(unit))
        offset += 2
    return "".join(chars)


def parse(data: bytes, language: str = "en") -> tuple[dict, dict]:
    """Return (lookup id->name, translation id->text) for one language."""
    if len(data) < 16:
        raise LocError("loc file shorter than header")
    tag, version, toc_offset, toc_size = struct.unpack_from("<4I", data, 0)
    if tag != TAG or version != 1:
        raise LocError("unsupported loc tag/version")
    if toc_offset + toc_size > len(data):
        raise LocError("loc toc outside file")
    toc = data[toc_offset:toc_offset + toc_size]
    lang_offset, lang_count, lookup_offset = struct.unpack_from("<3I", toc, 0)
    langs = {}
    for index in range(lang_count):
        name, offset, size = struct.unpack_from("<16sII", toc, lang_offset + index * 24)
        langs[name.split(b"\0")[0].decode("latin-1")] = (offset, size)
    if language not in langs:
        raise LocError("language not in loc file: " + language)
    count, entries_offset = struct.unpack_from("<2I", toc, lookup_offset)
    base = toc_offset + lookup_offset
    lookup = {}
    for index in range(count):
        ident, offset = struct.unpack_from("<2I", data, base + entries_offset + index * 8)
        start = base + offset
        end = data.find(b"\0", start)
        if end < 0:
            raise LocError("unterminated loc name")
        lookup[ident] = data[start:end].decode("latin-1")
    offset, size = langs[language]
    block = data[offset:offset + size]
    tcount, tentries = struct.unpack_from("<2I", block, 0)
    translation = {}
    for index in range(tcount):
        ident, toffset = struct.unpack_from("<2I", block, tentries + index * 8)
        translation[ident] = _u16z(block, toffset)
    return lookup, translation
