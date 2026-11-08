"""Bounded reader for Blur race AI track data (`.aid`, on-disk revision 6.0).

Format authority (upstream, unmodified):
  `upstream/BlurRebuilt/code/amax/game/AI/AI_Amax.cpp:1595-2163`
  (`AmaxAIR::LoadAITrackData` / `LoadVersionSix`).
  `upstream/BlurRebuilt/code/amax/game/GameLogic/Structures/LevelState.cpp:298`
  (`.\\gamedata\\levels\\<city>\\<route>.aid`).
  `upstream/BlurRebuilt/code/mercury/library/ai/air/include/trackdata/trackdata.h`
  (`AITrackDataRoutes`, `AITrackDataSegments`, `AITrackDataLines`).
  `upstream/BlurRebuilt/code/mercury/library/ai/air/source/trackdata/ctrackdata.cpp:196`
  (fixed 4.0 m route step).

Serialised layout (little endian, no header block):

  f32 version (=6.0)
  i32 routeCount
  route[routeCount]:
    i32 nameLength;      char[nameLength]      lower-cased for the hash
    i32 inputLength;     char[inputLength]
    i32 outputLength;    char[outputLength]
    i32 routeFlags
    if routeFlags & 128 (DYNAMIC_JUNCTION_ZONE):
      i32 ruleNumber; then the rule payload (rules 1..9; unknown rules carry
      their number only, exactly as the retail switch's default branch)
    i32 segmentCount
    segment[segmentCount]:
      f32 x, y, z            (Maya/level axes; Z is negated on load)
      f32 width
      f32 tangentX, tangentZ
      f32 tangentXYZx, tangentXYZy, tangentXYZz   (read and discarded)
      f32 minY, maxY
      i32 lineCount
      line[lineCount]:
        f32 curvature
        f32 distance
        i32 pointFlags
        f32 height
        f32 offset
        i8  surfaceFlags
        f32 yangle
  i32 dataCacheSize
  cache[dataCacheSize]:
    i32 recordCount
    record[recordCount]:
      i32 index
      i32 routeNameLength; char[routeNameLength]

The reader returns every value with its byte offset. It decodes only what the
retail loader decodes; it does not invent speed, trigger or surface semantics
that revision 6.0 does not serialise (the loader reads `pointFlags`,
`surfaceFlags` and `yangle` and discards them).

Coordinate convention, exactly as `LoadVersionSix` stores it:

  segment.m_position = (x, -z)
  segment.m_tangent  = (tangentX, -tangentZ)

and `AITrackDataSegments::GetPositionFromOffset(offset, position)`:

  position = (m_position.x + m_tangent.x * width * offset,
              0,
              m_position.y + m_tangent.y * width * offset)
  position.y = line.height

So the world XZ point of line `k` at parameter `offset` is

  x = xFile + tangentX * width * offset
  z = -zFile + (-tangentZ) * width * offset
  y = line.height
"""
from __future__ import annotations

import struct

VERSION = 6.0
STEP_SIZE_M = 4.0

FLAG_NAMES = {
    1: "ROUTE_LOOPED",
    2: "ROUTE_START_ZONE",
    4: "ROUTE_FINISH_ZONE",
    8: "ROUTE_INTERMEDIATE_ZONE_1",
    16: "ROUTE_INTERMEDIATE_ZONE_2",
    32: "ROUTE_LOGIC_ZONE",
    64: "ROUTE_JUNCTION",
    128: "ROUTE_DYNAMIC_JUNCTION_ZONE",
    256: "ROUTE_VALID_RESET",
    512: "ROUTE_VALID_NITRO",
    1024: "ROUTE_VALID_DROP_PRIORITY",
}

LINE_NAMES = [
    "RIGHT_5", "RIGHT_4", "RIGHT_3", "RIGHT_2", "RIGHT_1",
    "RACING", "LEFT_1", "LEFT_2", "LEFT_3", "LEFT_4", "LEFT_5",
]
RACING_LINE = 5
EXTREME_LEFT = 12
EXTREME_RIGHT = 13


class AidError(ValueError):
    pass


class _Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def need(self, count: int, what: str) -> None:
        if count < 0 or self.pos + count > len(self.data):
            raise AidError(f"{what} at byte {self.pos} runs past {len(self.data)} bytes")

    def i32(self, what: str) -> int:
        self.need(4, what)
        (value,) = struct.unpack_from("<i", self.data, self.pos)
        self.pos += 4
        return value

    def f32(self, what: str) -> float:
        self.need(4, what)
        (value,) = struct.unpack_from("<f", self.data, self.pos)
        self.pos += 4
        return value

    def i8(self, what: str) -> int:
        self.need(1, what)
        (value,) = struct.unpack_from("<b", self.data, self.pos)
        self.pos += 1
        return value

    def text(self, what: str) -> tuple[str, int, int]:
        start = self.pos
        length = self.i32(f"{what} length")
        if length < 0 or length > (1 << 20):
            raise AidError(f"{what} length {length} at byte {start} is not bounded")
        self.need(length, what)
        raw = self.data[self.pos:self.pos + length]
        self.pos += length
        return raw.decode("latin-1"), start, length


def _parse_junction(reader: _Reader, rule: int, at: int) -> dict:
    """Mirror `LoadVersionSix`'s `switch(ruleNo)`; store only read values."""
    out = {"rule": rule, "byteOffset": at}
    if rule == 1:
        out["state"] = reader.i32("junction rule 1 state")
    elif rule == 2:
        name, off, length = reader.text("junction rule 2 route name")
        out["routeName"] = name
        out["routeNameByteOffset"] = off
        out["state"] = reader.i32("junction rule 2 state")
    elif rule == 3:
        name, off, length = reader.text("junction rule 3 route name")
        out["routeName"] = name
        out["routeNameByteOffset"] = off
        out["state"] = reader.i32("junction rule 3 state")
        out["seconds"] = reader.f32("junction rule 3 seconds")
    elif rule == 4:
        name, off, length = reader.text("junction rule 4 route name")
        out["routeName"] = name
        out["routeNameByteOffset"] = off
        out["state"] = [reader.i32("junction rule 4 state[0]")]
        out["seconds"] = [reader.f32("junction rule 4 seconds[0]")]
        out["state"].append(reader.i32("junction rule 4 state[1]"))
        out["seconds"].append(reader.f32("junction rule 4 seconds[1]"))
    elif rule == 5:
        # Rule 5 stores no route name in LoadVersionSix.
        out["state"] = [reader.i32("junction rule 5 state[0]")]
        out["seconds"] = [reader.f32("junction rule 5 seconds[0]")]
        out["state"].append(reader.i32("junction rule 5 state[1]"))
        out["seconds"].append(reader.f32("junction rule 5 seconds[1]"))
    elif rule in (6, 7):
        out["state"] = reader.i32(f"junction rule {rule} state")
        out["lap"] = int(reader.f32(f"junction rule {rule} lap"))
    elif rule == 8:
        out["state"] = reader.i32("junction rule 8 state")
        out["laps"] = [int(reader.f32(f"junction rule 8 lap[{i}]")) for i in range(3)]
    elif rule == 9:
        out["state"] = reader.i32("junction rule 9 state")
        out["cars"] = int(reader.f32("junction rule 9 car count"))
        out["resetSeconds"] = reader.f32("junction rule 9 reset seconds")
    else:
        out["unsupportedRule"] = True
    return out


def parse_aid(data: bytes) -> dict:
    reader = _Reader(data)
    version = reader.f32("version")
    if version != VERSION:
        raise AidError(f"unsupported .aid revision {version!r}; this reader implements 6.0")
    route_count = reader.i32("route count")
    if route_count < 0 or route_count > 4096:
        raise AidError(f"route count {route_count} is not bounded")

    routes = []
    for index in range(route_count):
        at = reader.pos
        name, name_off, name_len = reader.text(f"route {index} name")
        input_route, input_off, _ = reader.text(f"route {index} input route")
        output_route, output_off, _ = reader.text(f"route {index} output route")
        flags = reader.i32(f"route {index} flags")
        flags_read = FLAG_NAMES.get(flags, None)
        unknown = [bit for bit in (1 << b for b in range(12)) if flags & bit and bit not in FLAG_NAMES]
        junction = None
        if flags & 128:
            rule = reader.i32(f"route {index} junction rule")
            junction = _parse_junction(reader, rule, reader.pos - 4)
        segment_count = reader.i32(f"route {index} segment count")
        if segment_count < 0 or segment_count > 200000:
            raise AidError(f"route {index} segment count {segment_count} is not bounded")
        segments = []
        line_count_set = set()
        for s in range(segment_count):
            seg_at = reader.pos
            x = reader.f32("x")
            y = reader.f32("y")
            z = reader.f32("z")
            width = reader.f32("width")
            tangent_x = reader.f32("tangentX")
            tangent_z = reader.f32("tangentZ")
            t3x = reader.f32("tangentXYZx")
            t3y = reader.f32("tangentXYZy")
            t3z = reader.f32("tangentXYZz")
            min_y = reader.f32("minY")
            max_y = reader.f32("maxY")
            line_count = reader.i32("line count")
            if line_count < 0 or line_count > 64:
                raise AidError(f"route {index} segment {s} line count {line_count} is not bounded")
            line_count_set.add(line_count)
            lines = []
            for k in range(line_count):
                line_at = reader.pos
                lines.append({
                    "index": k,
                    "name": LINE_NAMES[k] if k < len(LINE_NAMES) else f"LINE_{k}",
                    "byteOffset": line_at,
                    "curvature": reader.f32("curvature"),
                    "distance": reader.f32("distance"),
                    "pointFlags": reader.i32("pointFlags"),
                    "height": reader.f32("height"),
                    "offset": reader.f32("offset"),
                    "surfaceFlags": reader.i8("surfaceFlags"),
                    "yAngle": reader.f32("yangle"),
                })
            segments.append({
                "index": s,
                "byteOffset": seg_at,
                "xFile": x,
                "yFile": y,
                "zFile": z,
                "width": width,
                "tangentXFile": tangent_x,
                "tangentZFile": tangent_z,
                "tangent3File": [t3x, t3y, t3z],
                "minY": min_y,
                "maxY": max_y,
                "lineCount": line_count,
                "lines": lines,
            })
        routes.append({
            "index": index,
            "byteOffset": at,
            "name": name,
            "nameByteOffset": name_off,
            "nameLength": name_len,
            "inputRoute": input_route,
            "inputRouteByteOffset": input_off,
            "outputRoute": output_route,
            "outputRouteByteOffset": output_off,
            "flags": flags,
            "flagNames": [FLAG_NAMES[b] for b in (1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024) if flags & b],
            "unknownFlagBits": unknown,
            "junction": junction,
            "segmentCount": segment_count,
            "lineCountSet": sorted(line_count_set),
            "routeLengthM": segment_count * STEP_SIZE_M,
            "segments": segments,
            "endByteOffset": reader.pos,
        })

    cache_size = reader.i32("data cache size")
    if cache_size < 0 or cache_size > 200000:
        raise AidError(f"data cache size {cache_size} is not bounded")
    cache = []
    for i in range(cache_size):
        record_count = reader.i32(f"cache {i} record count")
        if record_count < 0 or record_count > 200000:
            raise AidError(f"cache {i} record count is not bounded")
        records = []
        for j in range(record_count):
            idx = reader.i32("cache index")
            name, off, length = reader.text("cache route name")
            records.append({"index": idx, "routeName": name, "byteOffset": off, "nameLength": length})
        cache.append({"index": i, "recordCount": record_count, "records": records})

    if reader.pos != len(data):
        raise AidError(f"trailing bytes: parsed {reader.pos} of {len(data)}")

    return {
        "format": "blur-aid",
        "version": version,
        "stepSizeM": STEP_SIZE_M,
        "routeCount": route_count,
        "routes": routes,
        "dataCacheSize": cache_size,
        "dataCache": cache,
        "parsedBytes": reader.pos,
        "fileBytes": len(data),
    }


# ------------------------------------------------------------------ geometry
def segment_world(segment: dict) -> dict:
    """Retail storage mapping: position = (x, -z), tangent = (tx, -tz)."""
    return {
        "x": segment["xFile"],
        "z": -segment["zFile"],
        "tangentX": segment["tangentXFile"],
        "tangentZ": -segment["tangentZFile"],
        "width": segment["width"],
    }


def position_from_offset(segment: dict, offset: float) -> dict:
    world = segment_world(segment)
    return {
        "x": world["x"] + world["tangentX"] * world["width"] * offset,
        "z": world["z"] + world["tangentZ"] * world["width"] * offset,
    }


def line_position(segment: dict, line_index: int, offset: float | None = None) -> dict:
    """`GetPositionFromOffset` / `GetPositionFromLine` on a chosen line."""
    world = segment_world(segment)
    if offset is None:
        offset = segment["lines"][line_index]["offset"]
    height = segment["lines"][line_index]["height"]
    return {
        "x": world["x"] + world["tangentX"] * world["width"] * offset,
        "z": world["z"] + world["tangentZ"] * world["width"] * offset,
        "y": height,
    }


def racing_point(segment: dict) -> dict:
    return line_position(segment, RACING_LINE)


def route_polyline(route: dict, line_index: int = RACING_LINE) -> list[dict]:
    """Ordered racing-line samples at the retail 4 m step."""
    out = []
    for segment in route["segments"]:
        point = line_position(segment, line_index)
        point["index"] = segment["index"]
        point["minY"] = segment["minY"]
        point["maxY"] = segment["maxY"]
        point["width"] = segment["width"]
        out.append(point)
    return out


def gate_point(route: dict, segment_index: int = 2, offset: float = 0.5) -> dict:
    """`CTrackDataAI::CalculateTrackData` gate sampling (segment 2, mid-width)."""
    if not 0 <= segment_index < route["segmentCount"]:
        segment_index = min(2, route["segmentCount"] - 1)
    world = segment_world(route["segments"][segment_index])
    racing = route["segments"][segment_index]["lines"][RACING_LINE]
    return {
        "x": world["x"] + world["tangentX"] * world["width"] * offset,
        "z": world["z"] + world["tangentZ"] * world["width"] * offset,
        "y": racing["height"],
        "segmentIndex": segment_index,
        "offset": offset,
    }


def polyline_length(points: list[dict]) -> float:
    total = 0.0
    for a, b in zip(points, points[1:]):
        total += ((b["x"] - a["x"]) ** 2 + (b["z"] - a["z"]) ** 2) ** 0.5
    return total
