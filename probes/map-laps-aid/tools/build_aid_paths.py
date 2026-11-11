#!/usr/bin/env python3
"""Build sprint paths from the retail AI racing line (`.aid`) for the seven
map-laps levels that the collision point-to-point builder could not solve.

Inputs (read-only):

  game-data/Blur/cache/gamedata.pak                  retail pak (2KAP v2, zlib)
  \\gamedata\\levels\\<level>\\<level>_<n>.aid         retail AI track data
  _work/powerups/routes.json                         AmaxRoute records (record id)
  _work/map-batch/<level>/collision.json             committed collision slice
  _work/map-batch/<level>/collision.positions.f32.bin
  _work/map-batch/<level>/collision.indices.u32.bin
  _work/map-batch/<level>/spawn.json                 committed spawn pose
  _work/map-batch/<level>/path.json                  committed draw-covered path
  _work/map-batch/<level>/draws.json                 committed draw list
  _work/map-batch/<level>/blockers.json              committed blockers
  _work/map-batch/<level>/textures/index.json        committed texture index
  _work/map-laps/<mapId>/grid.npz                    P48 passable raster
  game-data/Blur/levels/<level>/Level.levelphysics   committed physics file

Outputs:

  probes/map-laps-aid/data/<mapId>-aid-path.json     `e1-drive.sprint` v1
  probes/map-laps-aid/data/aid-paths.json            per-level verdict summary

Why this file exists
--------------------
`probes/map-laps/tools/build_batch_paths.py` builds the path from the
committed draw-covered path and the P48 raster. Eight levels are typed
blockers because that construction fails (see
`docs/work/analysis/remaining-maps.md`). The retail game ships an AI racing
line per level: `LevelState.cpp:298` builds
  ".\\gamedata\\levels\\%s\\%s.aid" (cityName, route->tag)
and `AI_Amax.cpp:1595-2163` (`LoadVersionSix`) decodes it. This builder uses
that line as the course source:

  * every `.aid` file in the level directory is decoded with the committed
    reader (`probes/course/tools/aid_decode.py`, a re-implementation of
    `LoadVersionSix`);
  * the racing line is line index 5 (`RACING`) of the chosen route;
  * the route is a closed loop (`ROUTE_LOOPED`) that is not a logic corridor
    (`ROUTE_LOGIC_ZONE`) and is at least `MIN_LOOP_M` long; the winner is the
    one whose polyline passes nearest the committed spawn pose;
  * the path is the forward segment from the point on that line nearest the
    committed spawn to the point nearest the committed draw-path end;
  * the segment is resampled at 0.25 m and every sample is checked against
    the P48 passable raster and the tier's car band. If the racing line itself
    is band-clear, it is the path. If not, a station may move along its own
    normal to a band-clear position in a bounded window, searched at 0.25 m.
    Three tiers are tried in order: `band` (the declared +/-12 m respawn band,
    2.276 m band), `wide` (+/-24 m, a new course, same 2.276 m band) and
    `narrow` (+/-24 m, 1.680 m band: the documented car width with no safety
    margin, a design choice, not a recovered retail hull). A later tier is only
    attempted when the previous one has a station with no band-clear lateral
    position or no continuous detour. The detour must be continuous
    (consecutive detour points at most 0.5 m apart) and must return to the
    racing line when it becomes clear. A deterministic second-order dynamic
    program minimises total lateral deviation plus 8x the lateral change, so
    the detour neither zigzags nor lingers. A station with no band-clear
    lateral position in the tier window is a typed blocker with its exact
    coordinate; a station that no continuous detour can reach is a typed
    blocker with its exact coordinate. A level is a path only when the whole
    detoured line is band-clear and continuous.
  * when no racing line passes within 25 m of the committed spawn, the
    nearest band-clear point on the line is measured as a snap candidate. A
    snap farther than 25 m keeps the level blocked with the snap distance and
    the candidate pose recorded.

No coordinate is invented: the path is the decoded `.aid` racing line or a
lateral shift along its own normal inside the attempted detour tier window
(band +/-12 m, wide/narrow +/-24 m), and every emitted sample is on the P48
passable raster with a passable car band. The path is the retail AI racing line
projected onto collision; it is not a retail start line and it is not a driven
lap.

Run:

    python probes/map-laps-aid/tools/build_aid_paths.py
    python probes/map-laps-aid/tools/build_aid_paths.py --map dumbo
    python probes/map-laps-aid/tools/build_aid_paths.py --check
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/course/tools"))
sys.path.insert(0, str(ROOT / "probes/map-laps/tools"))
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))

import aid_decode as aid  # noqa: E402  (read-only committed decoder)
import longbeach_path_common as lb  # noqa: E402  (read-only reuse)
from map_laps_common import (  # noqa: E402
    CELL, SURFACE_MIN_NY, STEP_LIMIT, GRADE_LIMIT, WALL_DILATE,
    CAR_LENGTH, CAR_WIDTH, SAFETY_MARGIN, HALF_LENGTH, HALF_WIDTH, NEED_WIDTH,
    ground_edge_rows,
)
import build_batch_paths as batch  # noqa: E402  (read-only reuse of the gate rule)

# --------------------------------------------------------------------------
# registry
# --------------------------------------------------------------------------
LEVELS = {
    "hackney": dict(
        map_id="hackney",
        level="uk_london_hackney",
        city="UK_London_Hackney",
        batch="_work/map-batch/uk_london_hackney",
        grid="_work/map-laps/hackney/grid.npz",
        out="probes/map-laps-aid/data/hackney-aid-path.json",
        course_name="uk_london_hackney retail racing-line path",
    ),
    "dumbo": dict(
        map_id="dumbo",
        level="usa_ny_dumbo",
        city="USA_NY_Dumbo",
        batch="_work/map-batch/usa_ny_dumbo",
        grid="_work/map-laps/dumbo/grid.npz",
        out="probes/map-laps-aid/data/dumbo-aid-path.json",
        course_name="usa_ny_dumbo retail racing-line path",
    ),
    "brighton": dict(
        map_id="brighton",
        level="uk_brighton",
        city="UK_Brighton",
        batch="_work/map-batch/uk_brighton",
        grid="_work/map-laps/brighton/grid.npz",
        out="probes/map-laps-aid/data/brighton-aid-path.json",
        course_name="uk_brighton retail racing-line path",
    ),
    "sausalito": dict(
        map_id="sausalito",
        level="usa_sanfran_sausalito",
        city="USA_SanFran_Sausalito",
        batch="_work/map-batch/usa_sanfran_sausalito",
        grid="_work/map-laps/sausalito/grid.npz",
        out="probes/map-laps-aid/data/sausalito-aid-path.json",
        course_name="usa_sanfran_sausalito retail racing-line path",
    ),
    "russianhill": dict(
        map_id="russianhill",
        level="usa_sanfran_russianhill",
        city="USA_SanFran_RussianHill",
        batch="_work/map-batch/usa_sanfran_russianhill",
        grid="_work/map-laps/russianhill/grid.npz",
        out="probes/map-laps-aid/data/russianhill-aid-path.json",
        course_name="usa_sanfran_russianhill retail racing-line path",
    ),
    "downtown-mp": dict(
        map_id="downtown-mp",
        level="usa_la_downtown_multiplayer",
        city="USA_LA_Downtown_Multiplayer",
        batch="_work/map-batch/usa_la_downtown_multiplayer",
        grid="_work/map-laps/downtown-mp/grid.npz",
        out="probes/map-laps-aid/data/downtown-mp-aid-path.json",
        course_name="usa_la_downtown_multiplayer retail racing-line path",
    ),
    "bowl": dict(
        map_id="bowl",
        level="spa_barcelona_bowl_multiplayer",
        city="SPA_Barcelona_Bowl_Multiplayer",
        batch="_work/map-batch/spa_barcelona_bowl_multiplayer",
        grid="_work/map-laps/bowl/grid.npz",
        out="probes/map-laps-aid/data/bowl-aid-path.json",
        course_name="spa_barcelona_bowl_multiplayer retail racing-line path",
    ),
}

PAK_RELATIVE = "game-data/Blur/cache/gamedata.pak"
ROUTES_RELATIVE = "_work/powerups/routes.json"
SUMMARY_RELATIVE = "probes/map-laps-aid/data/aid-paths.json"

SAMPLE_STEP = 0.25
RACING_LINE = 5
MIN_LOOP_M = 300.0                 # a "long loop", not a junction or a catch route
MAX_SPAWN_OFFSET_M = 25.0          # 6 retail 4 m route steps
GATE_HALF_WIDTH = 4.0              # 8 m requested gate line
GATE_LINE_FRACTION_MIN = 0.5
BAND_HALF_WIDTH = 6.0              # page validator's declared 6 m band
CORRIDOR_HALF_WIDTH = 12.0         # declared respawn band
# Detour tiers, tried in order. The first tier that yields a fully band-clear,
# continuous line wins. A later tier is only attempted when the previous one has
# a station with no band-clear lateral position (or no continuous detour).
#
#   band   +/-12 m window, 2.276 m band (1.676 m car + 0.30 m margin per side)
#   wide   +/-24 m window, 2.276 m band (a new course)
#   narrow +/-24 m window, 1.680 m band (the documented car width, no margin)
#
# The narrow tier is a design choice, not a recovered retail hull: it drops the
# 0.30 m safety margin, so the tested band is the documented maximum car width.
DETOUR_TIERS = (
    dict(
        tier="band",
        search_m=CORRIDOR_HALF_WIDTH,
        band_metres=NEED_WIDTH,
        half_width=HALF_WIDTH,
        margin_metres=SAFETY_MARGIN,
        band_step=SAMPLE_STEP,
        reason=("the documented car envelope (%.3f m) plus the %.2f m safety "
                "margin on each side" % (CAR_WIDTH, SAFETY_MARGIN)),
    ),
    dict(
        tier="wide",
        search_m=24.0,
        band_metres=NEED_WIDTH,
        half_width=HALF_WIDTH,
        margin_metres=SAFETY_MARGIN,
        band_step=SAMPLE_STEP,
        reason=("the documented car envelope (%.3f m) plus the %.2f m safety "
                "margin on each side, in a wider +/-24 m window (a new course)"
                % (CAR_WIDTH, SAFETY_MARGIN)),
    ),
    dict(
        tier="narrow",
        search_m=24.0,
        band_metres=1.68,
        half_width=0.84,
        margin_metres=0.0,
        band_step=0.21,
        reason=("the documented maximum car width with no safety margin; a "
                "design choice, not a recovered retail hull"),
    ),
)
DETOUR_SEARCH_M = DETOUR_TIERS[0]["search_m"]  # default (band) window
DETOUR_STEP_M = 0.25               # lateral search step
DETOUR_MAX_JUMP_M = 0.5            # continuity bound between consecutive samples
DETOUR_SMOOTHNESS = 8.0            # cost per metre of lateral change (anti-zigzag)
TANGENT_WINDOW = 5.0
CAR_CIRCUMRADIUS = math.hypot(HALF_LENGTH, HALF_WIDTH)

XOR_KEY = b"xVXo40j3@$%\\%`"


class AidBlocked(Exception):
    """A typed, recorded reason why the .aid racing line has no sprint path."""

    def __init__(self, record):
        super().__init__(record["reason"])
        self.record = record


# --------------------------------------------------------------------------
# pak reader (same rule as probes/powerups/tools/build_pickup_routes.mjs)
# --------------------------------------------------------------------------
def read_pak_index(path: Path):
    data = path.read_bytes()
    if len(data) < 48 or data[:4] != b"2KAP":
        raise SystemExit("%s: unsupported preheader" % path)
    version, sector, header_size = struct.unpack_from("<III", data, 4)
    codec, fat_type = data[16], data[17]
    if version != 2 or header_size != 32:
        raise SystemExit("%s: unsupported pak header" % path)
    string_block, fat_block = struct.unpack_from("<II", data, 36)
    metadata_end = sector + string_block + fat_block
    string_size = struct.unpack_from("<I", data, sector)[0]
    if string_size + 4 > string_block:
        raise SystemExit("%s: string table exceeds its block" % path)
    raw = data[sector + 4:sector + 4 + string_size]
    strings = bytes(byte ^ XOR_KEY[(index + 1) % len(XOR_KEY)]
                    for index, byte in enumerate(raw))
    count, fat_size = struct.unpack_from("<II", data, sector + string_block)
    stride = {0: 40, 1: 64}.get(fat_type)
    if stride is None or count * stride != fat_size:
        raise SystemExit("%s: invalid FAT geometry" % path)
    fat_start = sector + string_block + 8
    entries = {}
    for index in range(count):
        row = fat_start + index * stride
        crc, string_offset, _parent, logical, _timestamp, start, _unknown, stored = \
            struct.unpack_from("<IIIIQQII", data, row)
        if string_offset >= len(strings):
            raise SystemExit("%s: path outside string table" % path)
        end = strings.find(b"\0", string_offset)
        if end < 0:
            raise SystemExit("%s: unterminated path" % path)
        name = strings[string_offset:end].decode("utf-8")
        if start == 0xFFFFFFFFFFFFFFFF:
            continue
        offset = start * sector
        if offset < metadata_end or offset + stored > len(data):
            raise SystemExit("%s: payload bounds invalid for %s" % (path, name))
        entries[name.lower()] = dict(
            path=name, offset=offset, storedBytes=stored, logicalBytes=logical,
            pathCrc32="%08x" % crc, fatIndex=index,
        )
    return data, entries, codec, fat_type


def read_pak_entry(data, entry):
    packed = data[entry["offset"]:entry["offset"] + entry["storedBytes"]]
    logical = zlib.decompress(packed)
    if len(logical) != entry["logicalBytes"]:
        raise SystemExit("%s: inflated %d bytes, expected %d"
                         % (entry["path"], len(logical), entry["logicalBytes"]))
    return logical


def level_aid_entries(entries, level):
    prefix = ("\\gamedata\\levels\\%s\\" % level).lower()
    out = [entry for key, entry in entries.items()
           if key.startswith(prefix) and key.endswith(".aid")]
    out.sort(key=lambda entry: entry["path"].lower())
    return out


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def load_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def file_sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(Path(path).read_bytes()).hexdigest()


def canonical_hash(doc: dict) -> str:
    return lb.canonical_hash(doc)


def num(value, nd=6):
    return lb.num(value, nd)


def cell_of(x, z, xs, zs):
    return lb.cell_of(x, z, xs, zs)


def passable(base, xs, zs, x, z):
    nz, nx = base.shape
    i, j = cell_of(x, z, xs, zs)
    return 0 <= i < nx and 0 <= j < nz and bool(base[j, i])


def band_passable(base, xs, zs, x, z, tx, tz, half_width=HALF_WIDTH,
                  band_step=SAMPLE_STEP):
    """The car band at `band_step` spacing, centred on the station normal.

    With the defaults this is exactly the `build_batch_paths.lateral_band`
    rule (0.25 m stations to the rounded half-width). A tier may pass a finer
    `band_step` so the outermost samples land on its exact band edge.
    """
    nz, nx = base.shape
    nxv, nzv = -tz, tx
    steps = int(round(half_width / band_step))
    for k in range(-steps, steps + 1):
        d = k * band_step
        i, j = cell_of(x + nxv * d, z + nzv * d, xs, zs)
        if not (0 <= i < nx and 0 <= j < nz and base[j, i]):
            return False
    return True


def arc_table(points):
    arc = [0.0]
    for a, b in zip(points, points[1:]):
        arc.append(arc[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    return arc


def nearest_on_polyline(points, x, z):
    best = dict(distance=math.inf, segment=0, t=0.0, arc=0.0)
    arc = arc_table(points)
    for index in range(len(points) - 1):
        a, b = points[index], points[index + 1]
        vx, vz = b[0] - a[0], b[1] - a[1]
        length_squared = vx * vx + vz * vz
        t = 0.0 if length_squared == 0 else max(
            0.0, min(1.0, ((x - a[0]) * vx + (z - a[1]) * vz) / length_squared))
        px, pz = a[0] + vx * t, a[1] + vz * t
        distance = math.hypot(x - px, z - pz)
        if distance < best["distance"]:
            best = dict(distance=distance, segment=index, t=t,
                        arc=arc[index] + (arc[index + 1] - arc[index]) * t)
    return best


def resample_with_frame(points, widths, start_arc, end_arc, closed):
    """0.25 m stations along the forward arc, with the local tangent and width."""
    arc = arc_table(points)
    total = arc[-1]
    length = (end_arc - start_arc) % total if closed else end_arc - start_arc
    if length <= 0:
        raise AidBlocked({
            "stage": "segment",
            "reason": "the committed finish projects at or before the committed spawn "
                      "on the chosen route; the route does not connect them forward",
        })
    stations = []
    s = 0.0
    while s <= length + 1e-9:
        a_arc = (start_arc + s) % total if closed else start_arc + s
        index = int(np.searchsorted(arc, a_arc)) - 1
        index = max(0, min(len(points) - 2, index))
        span = arc[index + 1] - arc[index]
        t = (a_arc - arc[index]) / span if span > 0 else 0.0
        a, b = points[index], points[index + 1]
        x = a[0] + (b[0] - a[0]) * t
        z = a[1] + (b[1] - a[1]) * t
        dx, dz = b[0] - a[0], b[1] - a[1]
        norm = math.hypot(dx, dz) or 1.0
        stations.append((x, z, dx / norm, dz / norm, float(widths[index])))
        s += SAMPLE_STEP
    return stations, length


def lateral_band_clear(base, xs, zs, x, z, tx, tz, half_width=HALF_WIDTH,
                       search_m=DETOUR_SEARCH_M, band_step=SAMPLE_STEP):
    """Band clearance at every lateral offset in the detour window.

    Returns `(offsets, clear)`: the 0.25 m offsets from -search_m to +search_m
    and a boolean per offset. The band is evaluated with the station tangent,
    the racing-line frame in which the lateral detour is searched. With the
    default `band_step` this is the same 11-station 0.25 m band the single-point
    `band_passable` test uses, computed once per station with a sliding window.
    A tier with a finer `band_step` (the 1.68 m narrow band) tests each band
    sample at its own spacing, so the outermost samples are the exact edges.
    """
    nz, nx = base.shape
    nxv, nzv = -tz, tx
    steps = int(round(search_m / DETOUR_STEP_M))
    band_steps = int(round(half_width / band_step))
    offsets = np.arange(-steps, steps + 1) * DETOUR_STEP_M
    if abs(band_step - DETOUR_STEP_M) < 1e-12:
        # Fast path: the band samples sit on the 0.25 m search grid, so one
        # sliding window over the fine grid is enough (the original rule).
        fine = np.arange(-steps - band_steps, steps + band_steps + 1) * DETOUR_STEP_M
        px = x + nxv * fine
        pz = z + nzv * fine
        ii = np.floor((px - xs[0]) / CELL + 0.5).astype(np.int64)
        jj = np.floor((pz - zs[0]) / CELL + 0.5).astype(np.int64)
        inside = (ii >= 0) & (ii < nx) & (jj >= 0) & (jj < nz)
        ok = np.zeros(len(fine), dtype=bool)
        ok[inside] = base[jj[inside], ii[inside]]
        window = 2 * band_steps + 1
        cumulative = np.concatenate(([0], np.cumsum(ok.astype(np.int64))))
        return offsets, (cumulative[window:] - cumulative[:-window]) == window
    # Exact-band path: test each band sample at its own spacing.
    clear = np.ones(len(offsets), dtype=bool)
    for k in range(-band_steps, band_steps + 1):
        d = k * band_step
        px = x + nxv * (offsets + d)
        pz = z + nzv * (offsets + d)
        ii = np.floor((px - xs[0]) / CELL + 0.5).astype(np.int64)
        jj = np.floor((pz - zs[0]) / CELL + 0.5).astype(np.int64)
        inside = (ii >= 0) & (ii < nx) & (jj >= 0) & (jj < nz)
        ok = np.zeros(len(offsets), dtype=bool)
        ok[inside] = base[jj[inside], ii[inside]]
        clear &= ok
    return offsets, clear


def window_phrase(tier):
    """The exact window wording, so the band tier keeps its committed text."""
    if tier["tier"] == "band":
        return "the declared +/-%.0f m respawn band" % tier["search_m"]
    if tier["tier"] == "wide":
        return ("the +/-%.0f m wide detour window (a new course, not the declared "
                "+/-%.0f m respawn band)" % (tier["search_m"], CORRIDOR_HALF_WIDTH))
    return ("the +/-%.0f m wide detour window with the %.2f m band (no safety "
            "margin)" % (tier["search_m"], tier["band_metres"]))


def project_stations(base, xs, zs, stations, tier):
    """Return (points, offsets, detours) or raise AidBlocked with the station.

    Detour rule (documented in README.md):

      * the racing line is used unchanged when every station's car band is
        clear;
      * otherwise a station may move along its own normal to a band-clear
        position inside the tier window (band: the declared +/-12 m respawn
        band; wide/narrow: +/-24 m, a new course), searched at 0.25 m;
      * the band is the tier's band: 2.276 m (1.676 m car + 0.30 m margin per
        side) for band/wide, 1.680 m (the documented car width, no margin) for
        narrow;
      * consecutive detour points are at most 0.5 m apart;
      * the line returns to the racing line (offset 0) as soon as continuity
        allows; the dynamic program minimises total lateral deviation plus
        8x the lateral change, so it does not zigzag or linger;
      * the band at every sample is evaluated with the sample's own local
        tangent (the 0.5 m central difference the verifier uses).

    The dynamic program is second order: the state is the previous and current
    lateral offset, so the tangent at station i (which depends on the points at
    i-1 and i+1) is known when station i is validated. A first-order program
    cannot see that tangent and produces a zigzag whose rotated band fails.
    """
    count = len(stations)
    search_m = tier["search_m"]
    half_width = tier["half_width"]
    band_step = tier["band_step"]
    steps = int(round(search_m / DETOUR_STEP_M))
    offsets = np.arange(-steps, steps + 1) * DETOUR_STEP_M
    k_count = len(offsets)
    phrase = window_phrase(tier)

    # Per-station band in the racing-line frame: the no-detour test and the
    # racing-clear short circuit.
    valid = []
    racing_clear = []
    for (x, z, tx, tz, _width) in stations:
        _offsets, clear = lateral_band_clear(
            base, xs, zs, x, z, tx, tz, half_width=half_width,
            search_m=search_m, band_step=band_step)
        valid.append(clear)
        racing_clear.append(bool(clear[steps]))

    bad = [index for index, clear in enumerate(valid) if not clear.any()]
    if bad:
        index = bad[0]
        x, z, _tx, _tz, width = stations[index]
        raise AidBlocked({
            "stage": "no-band-clear-lateral",
            "stationIndex": int(index),
            "stationCount": count,
            "x": num(x, 6),
            "z": num(z, 6),
            "widthMetres": num(width, 3),
            "detourTier": tier["tier"],
            "detourSearchMetres": num(search_m, 3),
            "bandMetres": num(tier["band_metres"], 3),
            "marginMetres": num(tier["margin_metres"], 3),
            "blockedStations": len(bad),
            "reason": ("the retail racing line has no %.3f m band-clear lateral "
                       "position within %s at station "
                       "%d of %d (%.3f, %.3f); %d stations "
                       "have no band-clear position"
                       % (tier["band_metres"], phrase, index, count, x, z,
                          len(bad))),
        })

    if all(racing_clear):
        return ([(x, z) for x, z, _tx, _tz, _w in stations],
                [0.0] * count, [])

    # Candidate points: racing point + station normal * offset.
    px = np.empty((count, k_count))
    pz = np.empty((count, k_count))
    for i, (x, z, tx, tz, _width) in enumerate(stations):
        px[i] = x - tz * offsets
        pz[i] = z + tx * offsets

    def band_ok(index, k, tx, tz):
        # The candidate must be clear in the racing-line frame (the search
        # frame) and in the line's own frame (the final validation frame).
        return valid[index][k] and band_passable(
            base, xs, zs, px[index, k], pz[index, k], tx, tz,
            half_width=half_width, band_step=band_step)

    def unreachable(index):
        x, z, _tx, _tz, _width = stations[index]
        return AidBlocked({
            "stage": "detour-dp",
            "stationIndex": int(index),
            "stationCount": count,
            "x": num(x, 6),
            "z": num(z, 6),
            "detourTier": tier["tier"],
            "detourSearchMetres": num(search_m, 3),
            "bandMetres": num(tier["band_metres"], 3),
            "marginMetres": num(tier["margin_metres"], 3),
            "detourMaxJumpMetres": num(DETOUR_MAX_JUMP_M, 3),
            "reason": ("no continuous band-clear detour sequence reaches station "
                       "%d of %d (%.3f, %.3f) inside %s with the %.1f m "
                       "continuity bound"
                       % (index, count, x, z, phrase,
                          DETOUR_MAX_JUMP_M)),
        })

    # Second-order DP. State (a, b) = (offset index at i-1, offset index at i).
    states = {}
    for a in range(k_count):
        if racing_clear[0] and a != steps:
            continue
        for b in range(max(0, a - 1), min(k_count, a + 2)):
            if math.hypot(px[1, b] - px[0, a],
                          pz[1, b] - pz[0, a]) > DETOUR_MAX_JUMP_M + 1e-9:
                continue
            tx = px[1, b] - px[0, a]
            tz = pz[1, b] - pz[0, a]
            norm = math.hypot(tx, tz) or 1.0
            if not band_ok(0, a, tx / norm, tz / norm):
                continue
            states[(a, b)] = (
                abs(offsets[a]) + abs(offsets[b])
                + DETOUR_SMOOTHNESS * abs(offsets[b] - offsets[a]), None)
    history = [states]
    for i in range(1, count - 1):
        new = {}
        for (a, b), (cost, _back) in states.items():
            for c in range(max(0, b - 1), min(k_count, b + 2)):
                if math.hypot(px[i + 1, c] - px[i, b],
                              pz[i + 1, c] - pz[i, b]) > DETOUR_MAX_JUMP_M + 1e-9:
                    continue
                tx = px[i + 1, c] - px[i - 1, a]
                tz = pz[i + 1, c] - pz[i - 1, a]
                norm = math.hypot(tx, tz) or 1.0
                if not band_ok(i, b, tx / norm, tz / norm):
                    continue
                value = (cost + abs(offsets[c])
                         + DETOUR_SMOOTHNESS * abs(offsets[c] - offsets[b]))
                key = (b, c)
                if key not in new or value < new[key][0]:
                    new[key] = (value, (a, b))
        if not new:
            raise unreachable(i)
        states = new
        history.append(states)

    best = None
    for (a, b), (cost, _back) in states.items():
        if racing_clear[count - 1] and b != steps:
            continue
        tx = px[count - 1, b] - px[count - 2, a]
        tz = pz[count - 1, b] - pz[count - 2, a]
        norm = math.hypot(tx, tz) or 1.0
        if not band_ok(count - 1, b, tx / norm, tz / norm):
            continue
        if best is None or cost < best[0]:
            best = (cost, (a, b))
    if best is None:
        raise unreachable(count - 1)

    sequence = [best[1][1]]
    state = best[1]
    for i in range(count - 2, 0, -1):
        previous = history[i][state][1]
        sequence.append(previous[1])
        state = previous
    sequence.append(state[0])
    sequence.reverse()

    points = [(float(px[i, sequence[i]]), float(pz[i, sequence[i]]))
              for i in range(count)]
    chosen_offsets = [float(offsets[sequence[i]]) for i in range(count)]
    detours = []
    for i, value in enumerate(chosen_offsets):
        if abs(value) <= 1e-9:
            continue
        x, z, _tx, _tz, _width = stations[i]
        reason = (
            "the racing point is not car-half-width clear; the detour is the "
            "nearest continuous band-clear lateral position in %s" % phrase
            if not racing_clear[i] else
            "continuity ramp to or from an adjacent detour station; the racing "
            "point itself is band-clear")
        detours.append({
            "station": i,
            "racingPoint": {"x": num(x, 6), "z": num(z, 6)},
            "detourPoint": {"x": num(points[i][0], 6),
                            "z": num(points[i][1], 6)},
            "lateralOffset": num(value, 4),
            "reason": reason,
        })
    return points, chosen_offsets, detours


def final_band_failures(base, xs, zs, points, half_width=HALF_WIDTH,
                        band_step=SAMPLE_STEP):
    failures = []
    for index, (x, z) in enumerate(points):
        a = points[max(0, index - 1)]
        b = points[min(len(points) - 1, index + 1)]
        tx, tz = b[0] - a[0], b[1] - a[1]
        norm = math.hypot(tx, tz) or 1.0
        if not band_passable(base, xs, zs, x, z, tx / norm, tz / norm,
                             half_width=half_width, band_step=band_step):
            failures.append((index, x, z))
    return failures


def tier_attempt(tier, record):
    """One tier's typed result, kept even when a later tier is tried."""
    return {
        "tier": tier["tier"],
        "searchMetres": num(tier["search_m"], 3),
        "bandMetres": num(tier["band_metres"], 3),
        "marginMetres": num(tier["margin_metres"], 3),
        "stage": record.get("stage"),
        "stationIndex": record.get("stationIndex"),
        "stationCount": record.get("stationCount"),
        "x": record.get("x"),
        "z": record.get("z"),
        "blockedStations": (record.get("blockedStations")
                            if record.get("blockedStations") is not None
                            else record.get("blockedSamples")),
        "reason": record.get("reason"),
    }


def project_with_tiers(base, xs, zs, stations):
    """Try each detour tier in order; return the first fully clear projection.

    Returns `dict(points, offsets, detours, tier, attempts)`. Raises the last
    tier's AidBlocked with every attempt attached when no tier yields a fully
    band-clear, continuous line.
    """
    attempts = []
    last = None
    for tier in DETOUR_TIERS:
        try:
            points, offsets, detours = project_stations(
                base, xs, zs, stations, tier)
        except AidBlocked as exc:
            attempts.append(tier_attempt(tier, exc.record))
            last = exc
            continue
        failures = final_band_failures(
            base, xs, zs, points, half_width=tier["half_width"],
            band_step=tier["band_step"])
        if failures:
            index, x, z = failures[0]
            exc = AidBlocked({
                "stage": "resampled-band",
                "stationIndex": int(index),
                "stationCount": len(points),
                "x": num(x, 6),
                "z": num(z, 6),
                "detourTier": tier["tier"],
                "detourSearchMetres": num(tier["search_m"], 3),
                "bandMetres": num(tier["band_metres"], 3),
                "marginMetres": num(tier["margin_metres"], 3),
                "blockedSamples": len(failures),
                "reason": ("the detoured racing-line path fails the %.3f m band "
                           "at %d of %d resampled samples; first at station "
                           "%d (%.3f, %.3f) in the %s tier"
                           % (tier["band_metres"], len(failures), len(points),
                              index, x, z, tier["tier"])),
            })
            attempts.append(tier_attempt(tier, exc.record))
            last = exc
            continue
        return dict(points=points, offsets=offsets, detours=detours,
                    tier=tier, attempts=attempts)
    last.record["detourTierAttempts"] = attempts
    last.record["detourTier"] = attempts[-1]["tier"]
    last.record["detourSearchMetres"] = attempts[-1]["searchMetres"]
    last.record["bandMetres"] = attempts[-1]["bandMetres"]
    last.record["marginMetres"] = attempts[-1]["marginMetres"]
    raise last


def loop_stations(points, widths):
    """0.25 m stations over the whole closed racing line (arc 0 .. total)."""
    arc = arc_table(points)
    total = arc[-1]
    stations = []
    s = 0.0
    while s < total - 1e-9:
        index = int(np.searchsorted(arc, s)) - 1
        index = max(0, min(len(points) - 2, index))
        span = arc[index + 1] - arc[index]
        t = (s - arc[index]) / span if span > 0 else 0.0
        a, b = points[index], points[index + 1]
        x = a[0] + (b[0] - a[0]) * t
        z = a[1] + (b[1] - a[1]) * t
        dx, dz = b[0] - a[0], b[1] - a[1]
        norm = math.hypot(dx, dz) or 1.0
        stations.append((x, z, dx / norm, dz / norm, float(widths[index]), s))
        s += SAMPLE_STEP
    return stations, total


def nearest_band_clear(base, H, xs, zs, points, widths, x, z):
    """Nearest band-clear 0.25 m station on the whole closed racing line.

    The band is tested with the same 0.5 m central-difference tangent the
    final path validation uses, so a snap candidate is a point the path rule
    would accept.
    """
    stations, total = loop_stations(points, widths)
    count = len(stations)
    best = None
    for index, (sx, sz, _tx, _tz, _width, arc) in enumerate(stations):
        a = stations[(index - 1) % count]
        b = stations[(index + 1) % count]
        tx, tz = b[0] - a[0], b[1] - a[1]
        norm = math.hypot(tx, tz) or 1.0
        if not band_passable(base, xs, zs, sx, sz, tx / norm, tz / norm):
            continue
        distance = math.hypot(sx - x, sz - z)
        if best is None or distance < best["metres"]:
            i, j = cell_of(sx, sz, xs, zs)
            best = dict(x=sx, z=sz, metres=distance, arc=arc,
                        heading=math.atan2(tx / norm, tz / norm),
                        ground=float(H[j, i]))
    return best, total


# --------------------------------------------------------------------------
# .aid selection
# --------------------------------------------------------------------------
def route_record(routes, city, route_number):
    matches = [row for row in routes
               if str(row.get("cityName", "")).lower() == city.lower()
               and int(row.get("routeNumber", -1)) == int(route_number)]
    if len(matches) == 1:
        return matches[0]
    return None


def route_number_from_path(path: str):
    stem = Path(path).stem
    tail = stem.rsplit("_", 1)[-1]
    return int(tail) if tail.isdigit() else None


def choose_racing_line(cfg, data, entries, routes):
    """Pick the closed, non-logic, long racing line nearest the committed spawn."""
    spawn = cfg["_spawn"]
    candidates = []
    for entry in level_aid_entries(entries, cfg["level"]):
        logical = read_pak_entry(data, entry)
        doc = aid.parse_aid(logical)
        digest = "sha256:" + hashlib.sha256(logical).hexdigest()
        for route in doc["routes"]:
            if route["segmentCount"] * aid.STEP_SIZE_M < MIN_LOOP_M:
                continue
            if not (route["flags"] & 1) or (route["flags"] & 32):
                continue
            if route["lineCountSet"] != [11]:
                continue
            points = [(p["x"], p["z"]) for p in aid.route_polyline(route)]
            points.append(points[0])
            nearest = nearest_on_polyline(points, spawn[0], spawn[1])
            length = arc_table(points)[-1]
            candidates.append(dict(
                entry=entry, doc=doc, route=route, points=points,
                sha256=digest, spawnDistance=nearest["distance"],
                spawnArc=nearest["arc"], length=length,
            ))
    if not candidates:
        return None
    candidates.sort(key=lambda row: (row["spawnDistance"], -row["length"],
                                     row["entry"]["path"].lower(), row["route"]["index"]))
    chosen = candidates[0]
    route_number = route_number_from_path(chosen["entry"]["path"])
    record = None
    if route_number is not None:
        record = route_record(routes, cfg["city"], route_number)
    else:
        matches = [row for row in routes
                   if str(row.get("cityName", "")).lower() == cfg["city"].lower()]
        if len(matches) == 1:
            record = matches[0]
    chosen["routeNumber"] = route_number if route_number is not None else (
        record.get("routeNumber") if record else None)
    chosen["record"] = record
    return chosen


# --------------------------------------------------------------------------
# gates (same rule as build_batch_paths.py)
# --------------------------------------------------------------------------
def build_gates(cfg, batch_pkg, base, H, xs, zs, samples_xy, arc, ground):
    length = arc[-1]
    gates = []

    def straightest(nominal_arc):
        low = max(0.0, nominal_arc - 0.12 * length)
        high = min(length, nominal_arc + 0.12 * length)
        best_index = min(range(len(arc)), key=lambda k: abs(arc[k] - nominal_arc))
        best_turn = None
        for k in range(len(arc)):
            if arc[k] < low or arc[k] > high:
                continue
            a = max(0, k - 10)
            b = min(len(samples_xy) - 1, k + 10)
            ax, az = samples_xy[a]
            bx, bz = samples_xy[b]
            cx, cz = samples_xy[k]
            turn = abs(math.atan2(bx - cx, bz - cz) - math.atan2(cx - ax, cz - az))
            if turn > math.pi:
                turn = 2 * math.pi - turn
            if best_turn is None or turn < best_turn:
                best_turn = turn
                best_index = k
        return best_index

    i1 = straightest(length / 3.0)
    i2 = straightest(2.0 * length / 3.0)

    def make_gate(index, kind, gate_id, sample_index, gate_arc):
        x, z = samples_xy[index]
        tx, tz, window = batch.tangent_at(samples_xy, index, window=TANGENT_WINDOW)
        heading = math.atan2(tx, tz)

        def approach_point(start_index, direction):
            x0, z0 = samples_xy[start_index]
            k = start_index + direction
            while 0 <= k < len(samples_xy):
                if math.hypot(samples_xy[k][0] - x0, samples_xy[k][1] - z0) >= 1.0:
                    return samples_xy[k]
                k += direction
            k = max(0, min(len(samples_xy) - 1, start_index + direction))
            return samples_xy[k]

        approach = approach_point(index, +1) if index == 0 else approach_point(index, -1)
        half_width, narrowed, requested = batch.choose_gate_half_width(
            base, xs, zs, x, z, tx, tz)
        a, b = batch.gate_line(x, z, tx, tz, half_width, approach)
        g = ground[index]
        check = batch.raster_check(base, H, xs, zs, x, z, tx, tz, g,
                                   half_width=half_width)
        gate = {
            "id": gate_id,
            "kind": kind,
            "index": len(gates),
            "sampleIndex": int(sample_index),
            "arc": num(gate_arc, 6),
            "x": num(x, 6),
            "z": num(z, 6),
            "groundY": num(g, 4),
            "height": num(g, 4),
            "headingRad": num(heading, 9),
            "tangent": {
                "tx": num(tx, 9),
                "tz": num(tz, 9),
                "windowMetres": num(window, 3),
            },
            "widthMetres": num(half_width * 2, 6),
            "requestedWidthMetres": num(GATE_HALF_WIDTH * 2, 6),
            "narrowed": bool(narrowed),
            "a": [num(a[0], 6), num(a[1], 6)],
            "b": [num(b[0], 6), num(b[1], 6)],
            "coverage": {
                "measured": False,
                "source": "not measured",
                "note": ("the racing-line path has no draw-coverage measurement; "
                         "the gate line is rules geometry only"),
            },
            "groundCheck": check,
        }
        if narrowed:
            gate["narrowedReason"] = (
                "the requested %.1f m line is %d/%d (%.0f %%) passable on the P48 "
                "raster; the widest line that is at least %.0f %% passable with a "
                "fully passable car-half-width centre is %.2f m"
                % (GATE_HALF_WIDTH * 2, requested[1], requested[0],
                   100.0 * requested[1] / max(1, requested[0]),
                   100.0 * GATE_LINE_FRACTION_MIN, half_width * 2))
        return gate

    gates.append(make_gate(0, "start", "start", 0, 0.0))
    gates.append(make_gate(i1, "checkpoint", "checkpoint-1", i1, arc[i1]))
    gates.append(make_gate(i2, "checkpoint", "checkpoint-2", i2, arc[i2]))
    gates.append(make_gate(len(samples_xy) - 1, "finish", "finish",
                           len(samples_xy) - 1, length))
    return gates


# --------------------------------------------------------------------------
# document
# --------------------------------------------------------------------------
def build_document(cfg, batch_pkg, grid_path, base, H, xs, zs, chosen, built):
    samples_xy = built["samples_xy"]
    arc = built["arc"]
    ground = built["ground"]
    length = arc[-1]
    gates = build_gates(cfg, batch_pkg, base, H, xs, zs, samples_xy, arc, ground)

    spawn = built["spawn"]
    committed_spawn = built["committed_spawn"]
    finish = batch_pkg["path"]["end"]
    tier = built["tier"]
    search_m = tier["search_m"]
    half_width = tier["half_width"]
    phrase = window_phrase(tier)
    start_gate = gates[0]
    finish_gate = gates[3]
    if abs(start_gate["x"] - samples_xy[0][0]) > 1e-6 or \
            abs(start_gate["z"] - samples_xy[0][1]) > 1e-6:
        raise SystemExit("the start gate is not the path start")
    if abs(finish_gate["x"] - samples_xy[-1][0]) > 1e-6 or \
            abs(finish_gate["z"] - samples_xy[-1][1]) > 1e-6:
        raise SystemExit("the finish gate is not the path end")

    samples = []
    for index, (x, z) in enumerate(samples_xy):
        samples.append({
            "arc": num(arc[index], 6),
            "x": num(x, 6),
            "z": num(z, 6),
            "groundY": num(ground[index], 4),
            "covered": None,
        })

    # ---------------------------------------------------------------- clearance
    min_clearance = None
    min_clearance_index = None
    for index, (x, z) in enumerate(samples_xy):
        distance, _cell = batch.nearest_blocked(base, xs, zs, x, z)
        if distance is not None and (min_clearance is None or distance < min_clearance):
            min_clearance = distance
            min_clearance_index = index
    racing_min = None
    racing_min_index = None
    for index, (x, z, _tx, _tz, _width) in enumerate(built["stations"]):
        distance, _cell = batch.nearest_blocked(base, xs, zs, x, z)
        if distance is not None and (racing_min is None or distance < racing_min):
            racing_min = distance
            racing_min_index = index

    # ---------------------------------------------------------------- source
    physics_path = ROOT / ("game-data/Blur/levels/%s/Level.levelphysics" % cfg["level"])
    physics_bytes = physics_path.read_bytes()
    batch_dir = ROOT / cfg["batch"]
    collision_path = batch_dir / "collision.json"
    draws_path = batch_dir / "draws.json"
    blockers_path = batch_dir / "blockers.json"
    textures_path = batch_dir / "textures" / "index.json"
    spawn_path = batch_dir / "spawn.json"
    path_path = batch_dir / "path.json"
    collision = batch_pkg["collision"]
    excluded = [shape for shape in collision["shapes"] if not shape.get("shipped")]
    excluded_types = {}
    for shape in excluded:
        excluded_types[shape["importName"]] = excluded_types.get(shape["importName"], 0) + 1
    not_in_raster = ("the committed collision buffer ships %d static triangle-mesh "
                     "shapes; %d excluded shapes (%s) are not in the buffer and are "
                     "not in the raster"
                     % (collision["counts"]["shippedShapeCount"], len(excluded),
                        ", ".join("%dx %s" % (value, key)
                                  for key, value in sorted(excluded_types.items()))))
    aid_entry = chosen["entry"]
    route = chosen["route"]
    aid_doc = chosen["doc"]
    record = chosen["record"]
    offsets = built["offsets"]
    detours = built["detours"]
    shifted = sum(1 for value in offsets if abs(value) > 1e-9)
    detour_runs = 0
    in_run = False
    for value in offsets:
        if abs(value) > 1e-9 and not in_run:
            detour_runs += 1
            in_run = True
        elif abs(value) <= 1e-9:
            in_run = False
    detour_max = max((abs(value) for value in offsets), default=0.0)
    source = {
        "map": cfg["map_id"],
        "level": cfg["level"],
        "probe": "probes/map-laps-aid (retail AI racing line projected onto collision)",
        "probeScope": "retailRacingLineCollisionProjection",
        "physics": {
            "path": "game-data/Blur/levels/%s/Level.levelphysics" % cfg["level"],
            "bytes": len(physics_bytes),
            "sha256": file_sha256(physics_path),
        },
        "slice": {
            "path": cfg["batch"] + "/collision.json",
            "bytes": collision_path.stat().st_size,
            "sha256": file_sha256(collision_path),
            "contentHash": file_sha256(collision_path),
            "contentHashSource": ("the map-batch package records no canonical content "
                                  "hash for collision.json; its committed file pin is "
                                  "used"),
            "note": ("the collision slice document; the map-batch manifest is not "
                     "pinned here because it pins map-registry.js, which pins this "
                     "package"),
        },
        "render": {
            "path": cfg["batch"] + "/draws.json",
            "bytes": draws_path.stat().st_size,
            "sha256": file_sha256(draws_path),
            "contentHash": file_sha256(draws_path),
            "contentHashSource": ("the map-batch package records no canonical content "
                                  "hash for draws.json; its committed file pin is used"),
        },
        "blockers": {
            "path": cfg["batch"] + "/blockers.json",
            "bytes": blockers_path.stat().st_size,
            "sha256": file_sha256(blockers_path),
        },
        "textures": {
            "path": cfg["batch"] + "/textures/index.json",
            "bytes": textures_path.stat().st_size,
            "sha256": file_sha256(textures_path),
        },
        "spawnDocument": {
            "path": cfg["batch"] + "/spawn.json",
            "bytes": spawn_path.stat().st_size,
            "sha256": file_sha256(spawn_path),
        },
        "drawPathDocument": {
            "path": cfg["batch"] + "/path.json",
            "bytes": path_path.stat().st_size,
            "sha256": file_sha256(path_path),
        },
        "raster": {
            "path": cfg["grid"],
            "fileSha256": file_sha256(ROOT / cfg["grid"]),
            "cell": CELL,
            "surfaceMinNormalY": SURFACE_MIN_NY,
            "stepLimit": STEP_LIMIT,
            "gradeLimit": GRADE_LIMIT,
            "wallDilateMetres": WALL_DILATE,
            "staticTriangles": int(len(batch_pkg["tris"])),
            "notInRaster": not_in_raster,
            "source": ("P48 passable raster built from the committed "
                       "collision.positions.f32.bin / collision.indices.u32.bin "
                       "triangle buffer"),
        },
        "sliceCollision": {
            "positions": {
                "path": cfg["batch"] + "/collision.positions.f32.bin",
                "bytes": batch_pkg["pos_path"].stat().st_size,
                "sha256": file_sha256(batch_pkg["pos_path"]),
            },
            "indices": {
                "path": cfg["batch"] + "/collision.indices.u32.bin",
                "bytes": batch_pkg["idx_path"].stat().st_size,
                "sha256": file_sha256(batch_pkg["idx_path"]),
            },
            "note": ("the same %d triangles as the raster; the buffer is the "
                     "committed collision surface" % len(batch_pkg["tris"])),
        },
        "aid": {
            "pakPath": aid_entry["path"],
            "pakOffset": aid_entry["offset"],
            "fatIndex": aid_entry["fatIndex"],
            "pathCrc32": aid_entry["pathCrc32"],
            "storedBytes": aid_entry["storedBytes"],
            "logicalBytes": aid_entry["logicalBytes"],
            "sha256": chosen["sha256"],
            "revision": int(aid_doc["version"]),
            "routeCount": aid_doc["routeCount"],
            "parsedBytes": aid_doc["parsedBytes"],
            "routeName": route["name"],
            "routeIndex": route["index"],
            "routeRecordId": record.get("recordId") if record else None,
            "routeNumber": chosen["routeNumber"],
            "cityName": cfg["city"],
            "flags": route["flags"],
            "flagNames": route["flagNames"],
            "segmentCount": route["segmentCount"],
            "lineIndex": RACING_LINE,
            "lineName": aid.LINE_NAMES[RACING_LINE],
            "stepSizeM": int(aid.STEP_SIZE_M),
            "loopLengthMetres": num(chosen["length"], 6),
            "spawnNearestArc": num(chosen["spawnArc"], 6),
            "finishNearestArc": num(built["finish_arc"], 6),
            "segmentArcStart": num(built["start_arc"], 6),
            "segmentArcEnd": num(built["finish_arc"], 6),
            "segmentLengthMetres": num(length, 6),
            "spawnProjectionMetres": num(built["spawn_distance"], 4),
            "finishProjectionMetres": num(built["finish_distance"], 4),
            "pathStartProjectionMetres": num(built["path_start_distance"], 4),
            "pathFinishProjectionMetres": num(built["path_finish_distance"], 4),
            "projectionNote": ("the spawn/finish projections are the racing-line "
                               "points nearest the committed poses; the path "
                               "projections include the lateral detour offset"),
            "selectionRule": ("closed non-logic route (ROUTE_LOOPED without "
                              "ROUTE_LOGIC_ZONE) at least %.0f m long whose racing "
                              "line passes nearest the committed spawn; ties go to "
                              "the longer route then the lower route index" % MIN_LOOP_M),
            "projectionRule": ("the racing line is used unchanged when its car "
                               "half-width band is passable; otherwise a station "
                               "moves along its own normal to a band-clear "
                               "position inside %s (%.2f m steps) by a "
                               "deterministic second-order "
                               "dynamic program; consecutive detour points are at "
                               "most %.1f m apart and the line returns to the "
                               "racing line when it becomes clear"
                               % (phrase, DETOUR_STEP_M,
                                  DETOUR_MAX_JUMP_M)),
            "detourRule": ("bounded lateral detour: a station whose racing point "
                           "is not car-half-width clear moves along its own normal "
                           "to the nearest continuous band-clear position inside "
                           "%s; the detour is "
                           "continuous (<= %.1f m between consecutive samples) and "
                           "returns to the racing line when the racing point "
                           "becomes clear; every detour point is validated with the "
                           "line's own local tangent"
                           % (phrase, DETOUR_MAX_JUMP_M)),
            "detourSearchMetres": num(search_m, 3),
            "detourStepMetres": num(DETOUR_STEP_M, 3),
            "detourMaxJumpMetres": num(DETOUR_MAX_JUMP_M, 3),
            "detourStationCount": len(detours),
            "detourRunCount": detour_runs,
            "detourMaxLateralOffsetMetres": num(detour_max, 4),
            "detours": detours,
            "lateralOffsetMin": num(min(offsets), 4),
            "lateralOffsetMax": num(max(offsets), 4),
            "lateralOffsetMean": num(sum(offsets) / len(offsets), 4),
            "shiftedSamples": shifted,
            "lateralOffsets": [num(value, 4) for value in offsets],
        },
        "clearance": {
            "cells": 0,
            "lowerBoundMetres": 0,
            "metric": ("no isotropic erosion; the path is validated by the car "
                       "half-width lateral band at every 0.25 m sample"),
            "carHalfWidthM": num(half_width, 3),
            "carHalfLengthM": num(HALF_LENGTH, 4),
            "carCircumradiusM": num(CAR_CIRCUMRADIUS, 6),
            "carEnvelope": {
                "length": CAR_LENGTH,
                "width": CAR_WIDTH,
                "safetyMargin": SAFETY_MARGIN,
                "source": ("documented maximum XT envelope plus a labelled 0.30 m "
                           "margin; not a recovered retail hull"),
            },
            "interiorMinClearanceM": num(min_clearance, 4),
            "interiorMinSample": int(min_clearance_index),
            "lateralBandMetres": num(half_width, 3),
            "lateralBandSamples": len(samples_xy),
            "lateralBandBlocked": 0,
            "lateralBandFrame": ("the detoured line's own local tangent (0.5 m "
                                 "central difference) at every sample"),
        },
        "corridor": {
            "aidPath": aid_entry["path"],
            "aidRoute": route["name"],
            "aidWidthMinMetres": num(min(segment["width"] for segment in route["segments"]), 3),
            "aidWidthMaxMetres": num(max(segment["width"] for segment in route["segments"]), 3),
            "lateralSearchMetres": num(search_m, 3),
            "note": ("the .aid serialized width is the AI corridor; the path is the "
                     "racing line (line index 5) shifted along its own normal only "
                     "when the racing line's car band is blocked, inside %s"
                     % phrase),
        },
        "endpoints": {
            "spawn": {
                "x": num(spawn["x"], 6),
                "z": num(spawn["z"], 6),
                "headingRad": num(spawn["heading"], 9),
                "groundY": num(spawn["ground"], 4),
                "rasterCell": [int(cell_of(spawn["x"], spawn["z"], xs, zs)[0]),
                               int(cell_of(spawn["x"], spawn["z"], xs, zs)[1])],
            },
            "finish": {
                "x": num(finish["x"], 6),
                "z": num(finish["z"], 6),
                "groundY": num(finish["h"], 4),
                "rasterCell": [int(cell_of(finish["x"], finish["z"], xs, zs)[0]),
                               int(cell_of(finish["x"], finish["z"], xs, zs)[1])],
            },
            "spawnProjection": {
                "x": num(samples_xy[0][0], 6),
                "z": num(samples_xy[0][1], 6),
                "metres": num(built["path_start_distance"], 4),
                "racingLineProjectionMetres": num(built["spawn_distance"], 4),
                "arc": num(built["start_arc"], 6),
            },
            "finishProjection": {
                "x": num(samples_xy[-1][0], 6),
                "z": num(samples_xy[-1][1], 6),
                "metres": num(built["path_finish_distance"], 4),
                "racingLineProjectionMetres": num(built["finish_distance"], 4),
                "arc": num(built["finish_arc"], 6),
            },
            "rule": ("the path starts at the point on the retail racing line nearest "
                     "the committed spawn and ends at the point nearest the committed "
                     "draw-path end; the committed poses are recorded, not moved"),
        },
        "obstruction": {
            "label": "narrowest retail racing-line clearance to a blocked raster cell",
            "racingLine": {
                "sampleIndex": int(racing_min_index) if racing_min_index is not None else None,
                "clearanceM": num(racing_min, 4) if racing_min is not None else None,
            },
            "path": {
                "minInteriorClearanceM": num(min_clearance, 4),
                "sampleIndex": int(min_clearance_index) if min_clearance_index is not None else None,
                "arc": num(arc[min_clearance_index], 6) if min_clearance_index is not None else None,
                "x": num(samples_xy[min_clearance_index][0], 6) if min_clearance_index is not None else None,
                "z": num(samples_xy[min_clearance_index][1], 6) if min_clearance_index is not None else None,
            },
            "statedMarginM": 0,
            "source": ("P48 raster blocked-cell distance on the 0.5 m grid; the "
                       "path is validated by the car half-width lateral band, not "
                       "an isotropic erosion margin"),
        },
        "spawn": {
            "x": start_gate["x"],
            "z": start_gate["z"],
            "headingRad": start_gate["headingRad"],
        },
        "spawnSource": ("the path start is the point on the retail racing line "
                        "nearest the committed spawn.json pose, shifted along the "
                        "racing-line normal when that point is not band-clear; the "
                        "committed pose is recorded in source.endpoints.spawn"),
        "groundSource": ("P48 collision raster H at each 0.25 m sample's 0.5 m cell "
                         "(4 decimals); the committed spawn/finish ground is recorded "
                         "in source.endpoints"),
        "gateLineSource": ("5 m tangent window, 8 m line, narrowed to the widest line "
                           "that is at least 50 % passable with a fully passable "
                           "car-half-width centre; oriented so the approach side is "
                           "positive"),
        "checkpointStationSource": ("straightest sample within +/-12 % of one-third / "
                                    "two-thirds of the measured racing-line arc"),
    }
    # The band tier is the default and is already recorded as
    # source.aid.detourSearchMetres = 12. A wide or narrow path is a new course,
    # so it names the tier and its band explicitly. (Leaving the band documents
    # byte-identical keeps the e1-drive layoutFileSha256 pins valid.)
    if tier["tier"] != "band":
        source["aid"]["detourTier"] = tier["tier"]
        source["aid"]["bandMetres"] = num(tier["band_metres"], 3)
        source["aid"]["marginMetres"] = num(tier["margin_metres"], 3)
        source["aid"]["detourTierReason"] = tier["reason"]
        source["aid"]["detourTierAttempts"] = built["tier_attempts"]
        source["clearance"]["band"] = {
            "metres": num(tier["band_metres"], 3),
            "halfWidthMetres": num(tier["half_width"], 3),
            "marginMetres": num(tier["margin_metres"], 3),
            "stepMetres": num(tier["band_step"], 3),
            "reason": tier["reason"],
        }
    if built["spawn_snap"] is not None:
        source["spawnSnap"] = built["spawn_snap"]
        source["endpoints"]["committedSpawn"] = {
            "x": num(committed_spawn["x"], 6),
            "z": num(committed_spawn["z"], 6),
            "headingRad": num(committed_spawn["heading"], 9),
            "groundY": num(committed_spawn["ground"], 4),
        }

    # ---------------------------------------------------------------- course
    course = {
        "rule": ("retail AI racing-line segment; the path starts at the point on the "
                 ".aid racing line (line index 5) nearest the committed spawn and ends "
                 "at the point nearest the committed draw-path end; every 0.25 m "
                 "sample is on the P48 passable raster and its car half-width lateral "
                 "band is passable; a blocked station moves along its own normal to a "
                 "band-clear position inside %s; no "
                 "point is invented" % phrase),
        "name": cfg["course_name"],
        "spawn": {
            "x": start_gate["x"],
            "z": start_gate["z"],
            "headingRad": start_gate["headingRad"],
        },
        "spawnGroundY": start_gate["groundY"],
        "start": {
            "x": start_gate["x"],
            "z": start_gate["z"],
            "arc": 0,
            "groundY": start_gate["groundY"],
        },
        "finish": {
            "x": finish_gate["x"],
            "z": finish_gate["z"],
            "arc": num(length, 6),
            "groundY": finish_gate["groundY"],
        },
        "measuredEnd": {
            "x": finish_gate["x"],
            "z": finish_gate["z"],
            "arc": num(length, 6),
            "groundY": finish_gate["groundY"],
        },
        "lengthMetres": num(length, 6),
        "finishArc": num(length, 6),
        "sampleStepMetres": num(SAMPLE_STEP, 3),
        "sampleCount": len(samples),
        "detour": {
            "stations": len(detours),
            "runs": detour_runs,
            "maxLateralOffsetMetres": num(detour_max, 4),
            "searchMetres": num(search_m, 3),
            "stepMetres": num(DETOUR_STEP_M, 3),
            "maxJumpMetres": num(DETOUR_MAX_JUMP_M, 3),
            "rule": ("a station whose racing point is not car-half-width clear "
                     "moves along its own normal to the nearest continuous "
                     "band-clear position inside %s; consecutive detour "
                     "points are at most %.1f m apart; "
                     "the line returns to the racing line when the racing point "
                     "becomes clear"
                     % (phrase, DETOUR_MAX_JUMP_M)),
        },
        "span": {
            "startArc": 0,
            "finishArc": num(length, 6),
            "lengthMetres": num(length, 6),
            "measuredLengthMetres": num(length, 6),
            "drawPathLengthMetres": num(batch_pkg["path"]["lengthM"], 6),
            "finishClearanceMetres": num(built["path_finish_distance"], 4),
            "racingLineFinishProjectionMetres": num(built["finish_distance"], 4),
            "note": ("arcs are measured along the detoured racing-line segment; the "
                     "committed draw path is %.6f m and is not the authority; the "
                     "path end is %.3f m from the committed draw-path end (the "
                     "racing-line point nearest it is %.3f m away; the difference "
                     "is the finish detour offset)"
                     % (batch_pkg["path"]["lengthM"],
                        built["path_finish_distance"],
                        built["finish_distance"])),
        },
        "band": {
            "halfWidthMetres": num(BAND_HALF_WIDTH, 3),
            "source": ("declared controller and respawn band for this path; the page "
                       "validator requires the committed 6 m value"),
            "note": "not a road-width claim",
        },
        "corridor": {
            "rule": ("off-course respawn band is a declared +/-%.1f m around the "
                     "retail racing-line path" % CORRIDOR_HALF_WIDTH),
            "halfWidthMetres": num(CORRIDOR_HALF_WIDTH, 3),
            "source": {
                "minRasterClearanceM": num(min_clearance, 4),
                "clearanceLowerBoundM": 0,
                "carHalfWidthM": num(half_width, 3),
                "carCircumradiusM": num(CAR_CIRCUMRADIUS, 6),
                "note": ("declared respawn rule at the measured %.3f m raster "
                         "clearance; the path is validated by the %.3f m car "
                         "half-width lateral band, not an isotropic margin"
                         % (min_clearance, half_width)),
            },
        },
        "endpointConnectors": {
            "spawn": {"arc": 0, "metres": 0, "samples": 0},
            "finish": {"arc": num(length, 6), "metres": 0, "samples": 0},
            "note": ("the path starts and ends on the retail racing line; there are "
                     "no endpoint connectors"),
        },
        "coverage": {
            "measured": False,
            "source": "not measured",
            "note": ("draw coverage of this racing-line path was not measured; the "
                     "committed draw path's coverage does not apply to this line"),
        },
        "samples": samples,
        "gateRule": "arc-progression",
    }

    # Measured ground edge: where the P48 height raster has no drivable surface.
    # The page respawns at min(declared band, this edge) + margin, so a human
    # cannot reach the void. Maps whose raster has more than one deck opt out
    # with `ground_edge=False` and keep the declared band.
    if cfg.get("ground_edge", True):
        edge_rows = [
            {
                "arc": num(row["arc"], 6),
                "respawnHalfWidthMetres": num(row["respawnHalfWidthMetres"], 3),
                "voidLeftMetres": num(row["voidLeftMetres"], 3),
                "voidRightMetres": num(row["voidRightMetres"], 3),
            }
            for row in ground_edge_rows(samples, H, xs, zs, CELL)
        ]
        course["groundEdge"] = {
            "rule": ("per-arc half-width from the nearest ground edge (P48 height "
                     "raster, no surface = void), inset by 3 m and clamped to "
                     "2..12 m; the page respawns at min(declared band, this edge)"),
            "halfWidthMetres": num(min(row["respawnHalfWidthMetres"]
                                       for row in edge_rows), 3),
            "rows": edge_rows,
            "source": {
                "raster": cfg["grid"],
                "scanHalfMetres": num(24.0),
                "insetMetres": num(3.0),
                "declaredBandMetres": num(CORRIDOR_HALF_WIDTH, 3),
                "note": ("measured ground edge, not a declared lane; the scripted "
                         "sprint keeps the declared band"),
            },
        }
    else:
        course["groundEdge"] = {
            "enabled": False,
            "reason": cfg.get("ground_edge_reason",
                              "not emitted for this map"),
        }

    doc = {
        "kind": "e1-drive.sprint",
        "version": 1,
        "courseId": cfg["map_id"],
        "scope": {
            "collisionOnly": True,
            "drawGeometryRead": False,
            "drawPathReadForCorridor": False,
            "drawCoverageSource": "not measured for this racing-line path",
            "retailRacingLine": True,
            "retailStartLine": False,
            "rendererClaim": False,
            "vehiclePhysics": False,
            "gameRun": False,
            "pathDriven": False,
            "engineTrace": ("not run by this builder; the path is a geometric "
                            "raster result, not a driven lap"),
            "note": ("a data layout, not an e1-drive integration: no gate mesh, no "
                     "race director, no lap timing, no car simulated. The path is "
                     "the retail AI racing line projected onto collision, not a "
                     "retail start line."),
        },
        "source": source,
        "course": course,
        "gates": gates,
        "countdown": {
            "ticks": 90,
            "stepTicks": 30,
            "labels": ["3", "2", "1"],
            "goLabel": "GO",
            "rule": ("input is held at zero until the countdown reaches GO; the "
                     "timer starts at GO and the car is on the start line"),
        },
        "rules": {
            "tickHz": 60,
            "timer": ("elapsed engine ticks from GO at 1/60 s; it keeps running "
                      "across a respawn and freezes on the finish"),
            "gateOrder": ("checkpoints count only in index order; a finish crossing "
                          "is rejected until every checkpoint is passed"),
            "finishRequiresAllCheckpoints": True,
            "progress": ("progress is the arc length of the nearest point on the "
                         "retail racing-line path, clamped to the finish arc"),
            "respawn": {
                "fallBelowGroundMetres": num(1.0, 3),
                "airborneTicks": 30,
                "outsideBandMarginMetres": 1,
                "overshootMarginMetres": 2,
                "target": ("the gate point of the last passed checkpoint (the start "
                           "line before the first checkpoint)"),
                "rule": ("respawn when the chassis falls more than 1 m below the "
                         "measured ground at its arc, stays airborne for 30 ticks, "
                         "or leaves the declared band; the attempt timer keeps "
                         "running and the last checkpoint is kept"),
            },
            "limits": [
                ("one point-to-point sprint on the retail AI racing-line segment, "
                 "not a lap and not a retail start line"),
                ("the path is the .aid %s racing line (line index 5) between the "
                 "point nearest the committed spawn and the point nearest the "
                 "committed draw-path end" % route["name"]),
                ("the path start is %.3f m from the committed spawn and the path "
                 "end is %.3f m from the committed draw-path end (racing-line "
                 "projections: %.3f m and %.3f m); the committed poses are "
                 "recorded, not moved"
                 % (built["path_start_distance"], built["path_finish_distance"],
                    built["spawn_distance"], built["finish_distance"])),
                ("the path is validated by the %.3f m car half-width lateral band "
                 "at every 0.25 m sample; there is no isotropic erosion margin"
                 % half_width),
                ("%d of %d samples are detoured up to %.3f m along the racing-line "
                 "normal inside %s; the detour is "
                 "continuous (<= %.1f m between consecutive samples) and returns to "
                 "the racing line when the racing point becomes clear"
                 % (len(detours), len(samples), detour_max, phrase,
                    DETOUR_MAX_JUMP_M)),
                ("the 6 m band is the page validator's declared controller/respawn "
                 "band; the measured respawn corridor is %.1f m"
                 % CORRIDOR_HALF_WIDTH),
                ("gates are rules geometry only; no gate mesh is added to the render "
                 "packet"),
                ("the %d excluded collision shapes are not in the raster; no prop "
                 "collider, opponent, AI or race audio is added" % len(excluded)),
            ],
        },
        "integration": {
            "integrated": False,
            "needed": [
                ("map-registry.js needs the new layout file/content pins "
                 "(sampleCount, lengthMetres, checkpointArcs) for "
                 "?map=%s&script=sprint" % cfg["map_id"]),
                ("the E1 map-batch package builder copies this document verbatim as "
                 "_work/e1-drive/%s/layout.json" % cfg["map_id"]),
                ("the e1-drive %s geometry packet must be loaded before this "
                 "layout; this document carries no draw geometry" % cfg["map_id"]),
                ("gate lines are rules geometry only; no gate mesh, start banner or "
                 "race director exists for this map"),
                ("draw coverage of this racing-line path is not measured; the "
                 "committed draw path's coverage does not apply"),
            ],
            "missingData": [
                ("decoded InstancedTriangleMesh / FluidMesh collision shapes (%s)"
                 % ", ".join("%dx %s" % (value, key)
                             for key, value in sorted(excluded_types.items()))),
                ("draw coverage of the racing-line path at 0.25 m samples and across "
                 "the 8 m gate lines"),
                ("retail start-line / route record for the map (the .aid route is "
                 "the AI racing line, not the start line)"),
                ("a driven or AI-simulated check of the detour line; the detour is "
                 "a geometric lateral shift inside the declared respawn band, not a "
                 "driven racing line"),
            ],
        },
    }
    doc["hash"] = canonical_hash(doc)
    return doc


# --------------------------------------------------------------------------
# per-level build
# --------------------------------------------------------------------------
def build_level(cfg, data, entries, routes):
    batch_pkg = batch.load_batch(cfg, log=lambda *_args: None)
    grid = np.load(ROOT / cfg["grid"])
    base, H, xs, zs = grid["base"], grid["height"], grid["xs"], grid["zs"]
    committed_spawn = batch_pkg["spawn"]["layout"]["spawn"]
    spawn = committed_spawn
    finish = batch_pkg["path"]["end"]
    cfg["_spawn"] = (float(spawn["x"]), float(spawn["z"]))

    chosen = choose_racing_line(cfg, data, entries, routes)
    if chosen is None:
        prefix = ("\\gamedata\\levels\\%s\\" % cfg["level"]).lower()
        directory = sorted(entry["path"] for key, entry in entries.items()
                           if key.startswith(prefix))
        aid_files = level_aid_entries(entries, cfg["level"])
        if not aid_files:
            reason = ("no .aid file exists under \\gamedata\\levels\\%s\\; the "
                      "level directory ships %d file%s (%s)"
                      % (cfg["level"], len(directory),
                         "" if len(directory) == 1 else "s",
                         ", ".join(directory) if directory else "none"))
        else:
            reason = ("no .aid file with a closed non-logic racing line at least "
                      "%.0f m long exists under \\gamedata\\levels\\%s\\"
                      % (MIN_LOOP_M, cfg["level"]))
        raise AidBlocked({
            "stage": "aid-missing",
            "aidEntriesFound": len(aid_files),
            "levelDirectoryEntries": directory,
            "reason": reason,
        })

    widths = [segment["width"] for segment in chosen["route"]["segments"]]
    spawn_snap = None
    if chosen["spawnDistance"] > MAX_SPAWN_OFFSET_M:
        nearest = nearest_on_polyline(chosen["points"], spawn["x"], spawn["z"])
        index = nearest["segment"]
        t = nearest["t"]
        px = chosen["points"][index][0] + (chosen["points"][index + 1][0]
                                           - chosen["points"][index][0]) * t
        pz = chosen["points"][index][1] + (chosen["points"][index + 1][1]
                                           - chosen["points"][index][1]) * t
        snap, _loop_length = nearest_band_clear(
            base, H, xs, zs, chosen["points"], widths, spawn["x"], spawn["z"])
        spawn_snap = {
            "attempted": True,
            "limitMetres": num(MAX_SPAWN_OFFSET_M, 3),
            "nearestRacingLinePoint": {
                "x": num(px, 6),
                "z": num(pz, 6),
                "metres": num(chosen["spawnDistance"], 4),
            },
            "nearestBandClearPoint": (None if snap is None else {
                "x": num(snap["x"], 6),
                "z": num(snap["z"], 6),
                "metres": num(snap["metres"], 4),
                "arc": num(snap["arc"], 6),
                "headingRad": num(snap["heading"], 9),
                "groundY": num(snap["ground"], 4),
            }),
            "withinLimit": bool(snap is not None
                                and snap["metres"] <= MAX_SPAWN_OFFSET_M),
        }
        if not spawn_snap["withinLimit"]:
            snap_text = ("no band-clear point on the line" if snap is None else
                         "the nearest band-clear point on that line is %.3f m away"
                         % snap["metres"])
            raise AidBlocked({
                "stage": "spawn-match",
                "aid": chosen,
                "x": num(px, 6),
                "z": num(pz, 6),
                "spawnDistanceMetres": num(chosen["spawnDistance"], 4),
                "maxSpawnOffsetMetres": MAX_SPAWN_OFFSET_M,
                "spawnSnap": spawn_snap,
                "reason": ("no retail .aid racing line passes within %.0f m of the "
                           "committed spawn; the nearest is %s route %d at %.3f m "
                           "(nearest point %.3f, %.3f); %s, beyond the %.0f m "
                           "snap limit"
                           % (MAX_SPAWN_OFFSET_M, chosen["route"]["name"],
                              chosen["route"]["index"], chosen["spawnDistance"],
                              px, pz, snap_text, MAX_SPAWN_OFFSET_M)),
            })
        # The snap is inside the match limit: build from the snapped pose.
        spawn = {"x": snap["x"], "z": snap["z"], "heading": snap["heading"],
                 "ground": snap["ground"]}
        cfg["_spawn"] = (spawn["x"], spawn["z"])
        chosen = choose_racing_line(cfg, data, entries, routes)
        widths = [segment["width"] for segment in chosen["route"]["segments"]]

    finish_nearest = nearest_on_polyline(chosen["points"], finish["x"], finish["z"])
    stations, length = resample_with_frame(
        chosen["points"], widths, chosen["spawnArc"], finish_nearest["arc"],
        closed=True)
    try:
        projected = project_with_tiers(base, xs, zs, stations)
    except AidBlocked as exc:
        exc.record.setdefault("aid", chosen)
        if spawn_snap is not None:
            exc.record.setdefault("spawnSnap", spawn_snap)
        raise
    points = projected["points"]
    offsets = projected["offsets"]
    detours = projected["detours"]

    arc = arc_table(points)
    ground = []
    for x, z in points:
        i, j = cell_of(x, z, xs, zs)
        ground.append(round(float(H[j, i]), 4))
    path_start_distance = math.hypot(points[0][0] - spawn["x"],
                                     points[0][1] - spawn["z"])
    path_finish_distance = math.hypot(points[-1][0] - finish["x"],
                                      points[-1][1] - finish["z"])
    built = dict(samples_xy=points, arc=arc, ground=ground, stations=stations,
                 offsets=offsets, detours=detours, start_arc=chosen["spawnArc"],
                 finish_arc=finish_nearest["arc"],
                 spawn_distance=chosen["spawnDistance"],
                 finish_distance=finish_nearest["distance"],
                 path_start_distance=path_start_distance,
                 path_finish_distance=path_finish_distance,
                 tier=projected["tier"],
                 tier_attempts=projected["attempts"],
                 spawn_snap=spawn_snap,
                 spawn=spawn,
                 committed_spawn=committed_spawn)
    doc = build_document(cfg, batch_pkg, ROOT / cfg["grid"], base, H, xs, zs,
                         chosen, built)
    return doc, chosen, projected["tier"]


def blocker_record(cfg, exc):
    record = exc.record
    chosen = record.get("aid")
    aid_block = None
    if chosen is not None:
        route = chosen["route"]
        aid_block = {
            "pakPath": chosen["entry"]["path"],
            "sha256": chosen["sha256"],
            "routeName": route["name"],
            "routeIndex": route["index"],
            "routeRecordId": (chosen["record"].get("recordId")
                              if chosen["record"] else None),
            "routeNumber": chosen["routeNumber"],
            "flags": route["flags"],
            "segmentCount": route["segmentCount"],
            "loopLengthMetres": num(chosen["length"], 6),
            "spawnProjectionMetres": num(chosen["spawnDistance"], 4),
        }
    attempts = record.get("detourTierAttempts", [])
    return {
        "level": cfg["level"],
        "mapId": cfg["map_id"],
        "verdict": "blocked",
        "lengthMetres": None,
        "samples": 0,
        "gateArcs": [],
        "aid": aid_block,
        "detourTier": record.get("detourTier"),
        "detourSearchMetres": record.get("detourSearchMetres"),
        "bandMetres": record.get("bandMetres"),
        "marginMetres": record.get("marginMetres"),
        "blocker": {
            "stage": record.get("stage"),
            "x": record.get("x"),
            "z": record.get("z"),
            "stationIndex": record.get("stationIndex"),
            "stationCount": record.get("stationCount"),
            "spawnDistanceMetres": record.get("spawnDistanceMetres"),
            "maxSpawnOffsetMetres": record.get("maxSpawnOffsetMetres"),
            "detourTier": record.get("detourTier"),
            "detourSearchMetres": record.get("detourSearchMetres"),
            "bandMetres": record.get("bandMetres"),
            "marginMetres": record.get("marginMetres"),
            "detourMaxJumpMetres": record.get("detourMaxJumpMetres"),
            "blockedStations": record.get("blockedStations"),
            "blockedSamples": record.get("blockedSamples"),
            "aidEntriesFound": record.get("aidEntriesFound"),
            "levelDirectoryEntries": record.get("levelDirectoryEntries"),
            "spawnSnap": record.get("spawnSnap"),
            "detourTierAttempts": attempts,
        },
        "reason": record["reason"],
        "pathFile": None,
        "pathFileSha256": None,
        "pathContentHash": None,
    }


def summary_entry(cfg, doc, chosen, path_file, tier):
    text = json.dumps(doc, indent=1, ensure_ascii=False) + "\n"
    encoded = text.encode("utf-8")
    return {
        "level": cfg["level"],
        "mapId": cfg["map_id"],
        "verdict": "path",
        "lengthMetres": doc["course"]["lengthMetres"],
        "samples": doc["course"]["sampleCount"],
        "gateArcs": [gate["arc"] for gate in doc["gates"]],
        "aid": {
            "pakPath": chosen["entry"]["path"],
            "sha256": chosen["sha256"],
            "routeName": chosen["route"]["name"],
            "routeIndex": chosen["route"]["index"],
            "routeRecordId": (chosen["record"].get("recordId")
                              if chosen["record"] else None),
            "routeNumber": chosen["routeNumber"],
            "flags": chosen["route"]["flags"],
            "segmentCount": chosen["route"]["segmentCount"],
            "loopLengthMetres": num(chosen["length"], 6),
            "spawnProjectionMetres": num(chosen["spawnDistance"], 4),
            "finishProjectionMetres": num(doc["source"]["aid"]["finishProjectionMetres"], 4),
        },
        "reason": ("the retail racing line is band-clear on this segment after %d "
                   "detour stations (max %.3f m) in the %s tier (%.3f m band); the "
                   "path starts at the point nearest the committed spawn and ends at "
                   "the point nearest the committed draw-path end"
                   % (doc["course"]["detour"]["stations"],
                      doc["course"]["detour"]["maxLateralOffsetMetres"],
                      tier["tier"], tier["band_metres"])),
        "detours": doc["course"]["detour"]["stations"],
        "detourRuns": doc["course"]["detour"]["runs"],
        "maxLateralOffsetMetres": doc["course"]["detour"]["maxLateralOffsetMetres"],
        "detourTier": tier["tier"],
        "detourSearchMetres": doc["course"]["detour"]["searchMetres"],
        "bandMetres": num(tier["band_metres"], 3),
        "marginMetres": num(tier["margin_metres"], 3),
        "pathFile": path_file,
        "pathFileSha256": "sha256:" + hashlib.sha256(encoded).hexdigest(),
        "pathContentHash": doc["hash"],
    }


def build_summary(entries):
    return {
        "schema": "blur.map-laps-aid.aid-paths/4",
        "source": {
            "builder": "probes/map-laps-aid/tools/build_aid_paths.py",
            "aidDecoder": "probes/course/tools/aid_decode.py",
            "aidLoader": ("upstream/BlurRebuilt/code/amax/game/AI/AI_Amax.cpp:1595-2163 "
                          "(LoadVersionSix)"),
            "aidFilename": ("upstream/BlurRebuilt/code/amax/game/GameLogic/Structures/"
                            "LevelState.cpp:298"),
            "pak": PAK_RELATIVE,
            "routes": ROUTES_RELATIVE,
            "detourTiers": [
                {"tier": tier["tier"],
                 "searchMetres": num(tier["search_m"], 3),
                 "bandMetres": num(tier["band_metres"], 3),
                 "marginMetres": num(tier["margin_metres"], 3),
                 "bandStepMetres": num(tier["band_step"], 3),
                 "reason": tier["reason"]}
                for tier in DETOUR_TIERS
            ],
            "detourRule": ("tiers are tried in order: 'band' is the declared "
                           "+/-12 m respawn band with the 2.276 m band (1.676 m car "
                           "+ 0.30 m margin per side); 'wide' is a +/-24 m window "
                           "with the same band (a new course); 'narrow' is the "
                           "+/-24 m window with the 1.680 m band (the documented car "
                           "width, no safety margin; a design choice, not a "
                           "recovered retail hull). A later tier is only attempted "
                           "when the previous one has a station with no band-clear "
                           "lateral position (or no continuous detour). A tier "
                           "succeeds only when the whole detoured line is band-clear "
                           "and continuous (<= 0.5 m between consecutive samples); a "
                           "station whose racing point is not clear moves along its "
                           "own normal to the nearest continuous band-clear position "
                           "in the tier window (0.25 m steps) and the line returns to "
                           "the racing line when the racing point becomes clear"),
            "note": ("lengths are the committed path documents; blocked reasons are "
                     "the builder's typed records, never paraphrased"),
        },
        "scope": {
            "collisionOnly": True,
            "retailRacingLine": True,
            "retailStartLine": False,
            "rendererClaim": False,
            "vehiclePhysics": False,
            "gameRun": False,
            "pathDriven": False,
            "note": ("a data summary only; a path is not a playable map and no lap "
                     "was driven. The path is the retail AI racing line projected "
                     "onto collision, not a retail start line."),
        },
        "levels": entries,
        "summary": {
            "counts": {
                "path": sum(1 for row in entries if row["verdict"] == "path"),
                "blocked": sum(1 for row in entries if row["verdict"] == "blocked"),
            },
            "levelCount": len(entries),
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--map", choices=sorted(LEVELS) + ["all"], default="all")
    parser.add_argument("--check", action="store_true",
                        help="compare the generated documents with the committed files")
    args = parser.parse_args(argv)

    data, entries, _codec, _fat = read_pak_index(ROOT / PAK_RELATIVE)
    routes = load_json(ROOT / ROUTES_RELATIVE)
    keys = sorted(LEVELS) if args.map == "all" else [args.map]
    summary_rows = []
    status = 0
    for key in keys:
        cfg = LEVELS[key]
        try:
            doc, chosen, tier = build_level(cfg, data, entries, routes)
        except AidBlocked as exc:
            row = blocker_record(cfg, exc)
            summary_rows.append(row)
            print(json.dumps({
                "level": row["level"],
                "mapId": row["mapId"],
                "verdict": "blocked",
                "stage": row["blocker"]["stage"],
                "detourTier": row["detourTier"],
                "detourSearchMetres": row["detourSearchMetres"],
                "bandMetres": row["bandMetres"],
                "marginMetres": row["marginMetres"],
                "tierAttempts": [
                    {"tier": attempt["tier"],
                     "searchMetres": attempt["searchMetres"],
                     "bandMetres": attempt["bandMetres"],
                     "stage": attempt["stage"],
                     "blockedStations": attempt["blockedStations"],
                     "stationIndex": attempt["stationIndex"]}
                    for attempt in row["blocker"]["detourTierAttempts"]
                ],
                "reason": row["reason"],
            }, indent=1))
            continue
        except SystemExit as exc:
            print("FAILED %s: %s" % (key, exc))
            status = 1
            continue
        text = json.dumps(doc, indent=1, ensure_ascii=False) + "\n"
        encoded = text.encode("utf-8")
        out = ROOT / cfg["out"]
        if args.check:
            if not out.exists() or out.read_bytes() != encoded:
                print("STALE %s" % out)
                status = 1
            else:
                print("OK %s" % out)
        else:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(encoded)
        row = summary_entry(cfg, doc, chosen, cfg["out"], tier)
        summary_rows.append(row)
        print(json.dumps({
            "level": row["level"],
            "mapId": row["mapId"],
            "verdict": "path",
            "lengthMetres": row["lengthMetres"],
            "samples": row["samples"],
            "gates": row["gateArcs"],
            "detourTier": row["detourTier"],
            "bandMetres": row["bandMetres"],
        }, indent=1))

    summary = build_summary(summary_rows)
    summary_text = json.dumps(summary, indent=1, ensure_ascii=False) + "\n"
    summary_path = ROOT / SUMMARY_RELATIVE
    if args.map != "all":
        # A single-map run must not truncate the all-level summary.
        print("single-map run: %s is not rewritten" % SUMMARY_RELATIVE)
        return status
    if args.check:
        if not summary_path.exists() or summary_path.read_text(encoding="utf-8") != summary_text:
            print("STALE %s" % summary_path)
            status = 1
        else:
            print("OK %s" % summary_path)
    else:
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(summary_text, encoding="utf-8")
        print("wrote %s sha256 %s"
              % (SUMMARY_RELATIVE,
                 hashlib.sha256(summary_text.encode("utf-8")).hexdigest()))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
