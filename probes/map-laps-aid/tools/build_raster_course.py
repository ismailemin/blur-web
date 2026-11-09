#!/usr/bin/env python3
"""Build a closed course from the P48 passable collision raster for the five
levels whose retail `.aid` racing line has no band-clear projection.

This is a **project course**, not retail data:

  * `courseSource` is `collision-raster-project-course`;
  * `retailLineUsed` is `false`;
  * no `.aid` file, route, racing-line point or retail start line is read.

The course is the outer boundary of the clearance-eroded passable component
that contains the committed spawn (or the nearest eroded cell to it):

  1. Load the committed P48 passable raster `_work/map-laps/<mapId>/grid.npz`
     (`base`, `height`, `xs`, `zs`).
  2. Erode `base` by `EROSION_CELLS` 8-connected layers. A retained cell has
     every cell within Chebyshev distance `EROSION_CELLS` passable, so the
     nearest blocked cell is at least `(EROSION_CELLS + 1) * 0.5 m` away
     (1.5 m for 2 cells). The raster border is treated as blocked.
  3. Label the eroded mask, take the 8-connected component that contains the
     committed spawn cell, or the component of the nearest eroded cell when
     the spawn cell itself is eroded. The snap is capped at 25 m and recorded.
  4. Trace the outer boundary of that component with an 8-connected Moore
     boundary trace and map the contour to the eroded foreground cells.
  5. Resample the closed ring at 0.25 m, rotate it so station 0 is the station
     nearest the committed spawn, and validate every station:
       - on the P48 passable raster;
       - on the eroded mask;
       - the 1.68 m car band is passable perpendicular to the station's
         central-difference tangent (half-width 0.84 m, 0.21 m steps, 9
         samples);
       - the closed loop is continuous (station spacing <= 0.5 m).
  6. Emit `data/<mapId>-raster-course.json`.

The 1.68 m band is the documented maximum car width (1.676 m) with no safety
margin, the same `narrow` band the `.aid` probe tests. The 2.276 m band
(1.676 m car + 0.30 m margin per side) is a stronger clearance; it needs a
3-cell erosion and selects a smaller component. This builder deliberately
uses the documented minimum car band, so the course stays in the main
clearance-eroded component.

If a level has no closed band-clear loop, the builder writes a `blocked`
document with the exact reason and the largest connected passable component's
size. It never invents a corridor.

Run:

    python probes/map-laps-aid/tools/build_raster_course.py
    python probes/map-laps-aid/tools/build_raster_course.py --map hackney
    python probes/map-laps-aid/tools/build_raster_course.py --check
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-laps/tools"))
sys.path.insert(0, str(ROOT / "probes/lap-search/tools"))

import longbeach_path_common as lb  # noqa: E402  (read-only reuse)
from raster import erode, label_components  # noqa: E402  (read-only reuse)
from build_loops import moore_trace, map_to_foreground  # noqa: E402

# --------------------------------------------------------------------------
# registry
# --------------------------------------------------------------------------
LEVELS = {
    "hackney": dict(
        map_id="hackney",
        level="uk_london_hackney",
        grid="_work/map-laps/hackney/grid.npz",
        spawn="_work/map-batch/uk_london_hackney/spawn.json",
        out="probes/map-laps-aid/data/hackney-raster-course.json",
        course_name="uk_london_hackney collision-raster project course",
    ),
    "brighton": dict(
        map_id="brighton",
        level="uk_brighton",
        grid="_work/map-laps/brighton/grid.npz",
        spawn="_work/map-batch/uk_brighton/spawn.json",
        out="probes/map-laps-aid/data/brighton-raster-course.json",
        course_name="uk_brighton collision-raster project course",
    ),
    "sausalito": dict(
        map_id="sausalito",
        level="usa_sanfran_sausalito",
        grid="_work/map-laps/sausalito/grid.npz",
        spawn="_work/map-batch/usa_sanfran_sausalito/spawn.json",
        out="probes/map-laps-aid/data/sausalito-raster-course.json",
        course_name="usa_sanfran_sausalito collision-raster project course",
    ),
    "russianhill": dict(
        map_id="russianhill",
        level="usa_sanfran_russianhill",
        grid="_work/map-laps/russianhill/grid.npz",
        spawn="_work/map-batch/usa_sanfran_russianhill/spawn.json",
        out="probes/map-laps-aid/data/russianhill-raster-course.json",
        course_name="usa_sanfran_russianhill collision-raster project course",
    ),
    "bowl": dict(
        map_id="bowl",
        level="spa_barcelona_bowl_multiplayer",
        grid="_work/map-laps/bowl/grid.npz",
        spawn="_work/map-batch/spa_barcelona_bowl_multiplayer/spawn.json",
        out="probes/map-laps-aid/data/bowl-raster-course.json",
        course_name="spa_barcelona_bowl_multiplayer collision-raster project course",
    ),
}

# --------------------------------------------------------------------------
# documented constants (P48 raster and the `.aid` probe's narrow band)
# --------------------------------------------------------------------------
CELL = 0.5
SURFACE_MIN_NY = 0.94
STEP_LIMIT = 0.05
GRADE_LIMIT = 0.05
WALL_DILATE = 0.5

BAND_METRES = 1.68                 # documented maximum car width, no margin
BAND_HALF_WIDTH = 0.84             # 1.68 / 2
BAND_STEP = 0.21                   # 9 samples: -0.84 .. +0.84
EROSION_CELLS = 2                  # >= (2 + 1) * 0.5 = 1.5 m clearance
GUARANTEED_CLEARANCE = (EROSION_CELLS + 1) * CELL
SAMPLE_STEP = 0.25
MAX_STATION_SPACING = 0.5
SPAWN_SNAP_LIMIT = 25.0

CAR_WIDTH = 1.676
SAFETY_MARGIN = 0.30
BAND_2_276 = CAR_WIDTH + 2.0 * SAFETY_MARGIN   # 2.276

CANONICAL_HASH = lb.canonical_hash
NUM = lb.num
CELL_OF = lb.cell_of


class RasterBlocked(Exception):
    """A typed, recorded reason why the raster has no closed band-clear loop."""

    def __init__(self, record):
        super().__init__(record["reason"])
        self.record = record


# --------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------
def load_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def file_sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(Path(path).read_bytes()).hexdigest()


def passable(base, xs, zs, x, z):
    nz, nx = base.shape
    i, j = CELL_OF(x, z, xs, zs)
    return 0 <= i < nx and 0 <= j < nz and bool(base[j, i])


def band_passable(base, xs, zs, x, z, tx, tz,
                  half_width=BAND_HALF_WIDTH, band_step=BAND_STEP):
    """The car band perpendicular to (tx, tz), sampled at `band_step`."""
    nz, nx = base.shape
    nxv, nzv = -tz, tx
    steps = int(round(half_width / band_step))
    for k in range(-steps, steps + 1):
        d = k * band_step
        i, j = CELL_OF(x + nxv * d, z + nzv * d, xs, zs)
        if not (0 <= i < nx and 0 <= j < nz and base[j, i]):
            return False
    return True


def resample_closed(points, step):
    """Resample a closed ring at `step`; no repeated closing point.

    The returned list has one station per `step` along every ring segment,
    including the closing segment from the last point to the first. The
    closing seam is therefore the distance from the last returned station to
    the first returned station.
    """
    n = len(points)
    out = []
    for index in range(n):
        a = points[index]
        b = points[(index + 1) % n]
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        count = max(1, int(math.ceil(length / step)))
        for k in range(count):
            t = k / count
            out.append((a[0] + (b[0] - a[0]) * t,
                        a[1] + (b[1] - a[1]) * t))
    return out


def ring_from_mask(mask, eroded, xs, zs):
    """Outer boundary of `mask`, mapped to the eroded foreground cells."""
    contour = moore_trace(mask)
    foreground = map_to_foreground(contour, eroded)
    points = []
    for cell in foreground:
        point = (float(xs[cell[1]]), float(zs[cell[0]]))
        if not points or math.hypot(point[0] - points[-1][0],
                                    point[1] - points[-1][1]) > 1e-9:
            points.append(point)
    if len(points) > 1 and math.hypot(points[0][0] - points[-1][0],
                                      points[0][1] - points[-1][1]) < 1e-9:
        points.pop()
    return points


def nearest_eroded_cell(eroded, xs, zs, x, z, limit_m):
    """Nearest eroded cell to (x, z), searched in a bounded local window."""
    nz, nx = eroded.shape
    i, j = CELL_OF(x, z, xs, zs)
    if 0 <= i < nx and 0 <= j < nz and eroded[j, i]:
        return dict(i=int(i), j=int(j), metres=0.0)
    radius = int(math.ceil(limit_m / CELL))
    i0, i1 = max(0, i - radius), min(nx, i + radius + 1)
    j0, j1 = max(0, j - radius), min(nz, j + radius + 1)
    sub = eroded[j0:j1, i0:i1]
    jj, ii = np.nonzero(sub)
    if len(jj) == 0:
        return None
    d = np.hypot((jj + j0 - j) * CELL, (ii + i0 - i) * CELL)
    best = int(np.argmin(d))
    metres = float(d[best])
    if metres > limit_m + 1e-9:
        return None
    return dict(i=int(ii[best] + i0), j=int(jj[best] + j0), metres=metres)


def nearest_blocked_distance(base, xs, zs, x, z, radius_cells=12):
    """Distance to the nearest blocked cell in a local window (or None)."""
    nz, nx = base.shape
    i, j = CELL_OF(x, z, xs, zs)
    j0, j1 = max(0, j - radius_cells), min(nz, j + radius_cells + 1)
    i0, i1 = max(0, i - radius_cells), min(nx, i + radius_cells + 1)
    sub = ~base[j0:j1, i0:i1]
    jj, ii = np.nonzero(sub)
    if len(jj) == 0:
        return None
    return float(np.hypot((jj + j0 - j) * CELL,
                          (ii + i0 - i) * CELL).min())


def component_bbox(component, xs, zs):
    jj, ii = np.nonzero(component)
    return [float(xs[int(ii.min())]), float(xs[int(ii.max())]),
            float(zs[int(jj.min())]), float(zs[int(jj.max())])]


def largest_component_size(base):
    _labels, sizes = label_components(base, conn=8)
    return int(max(sizes)) if len(sizes) else 0


# --------------------------------------------------------------------------
# course construction
# --------------------------------------------------------------------------
def build_course(cfg, grid, spawn_doc):
    base = grid["base"]
    height = grid["height"]
    xs = grid["xs"]
    zs = grid["zs"]
    spawn = spawn_doc["layout"]["spawn"]
    sx, sz = float(spawn["x"]), float(spawn["z"])

    eroded = erode(base, EROSION_CELLS)
    labels, sizes = label_components(eroded, conn=8)
    snap = nearest_eroded_cell(eroded, xs, zs, sx, sz, SPAWN_SNAP_LIMIT)
    if snap is None:
        raise RasterBlocked({
            "stage": "spawn-snap",
            "reason": ("no cell of the %d-cell eroded P48 passable raster is within "
                       "%.0f m of the committed spawn (%.6f, %.6f); the largest "
                       "connected passable component has %d cells"
                       % (EROSION_CELLS, SPAWN_SNAP_LIMIT, sx, sz,
                          largest_component_size(base))),
            "largestPassableComponentCells": largest_component_size(base),
        })
    cid = int(labels[snap["j"], snap["i"]])
    if cid == 0:
        raise RasterBlocked({
            "stage": "component",
            "reason": ("the nearest eroded cell to the committed spawn (%.6f, %.6f) "
                       "has no 8-connected eroded component; the largest connected "
                       "passable component has %d cells"
                       % (sx, sz, largest_component_size(base))),
            "largestPassableComponentCells": largest_component_size(base),
        })
    component = labels == cid
    component_cells = int(sizes[cid - 1])

    ring = ring_from_mask(component, eroded, xs, zs)
    if len(ring) < 8:
        raise RasterBlocked({
            "stage": "boundary",
            "reason": ("the eroded component %d containing the committed spawn has a "
                       "boundary of only %d cells; no closed course"
                       % (cid, len(ring))),
            "largestPassableComponentCells": largest_component_size(base),
        })
    samples = resample_closed(ring, SAMPLE_STEP)
    count = len(samples)
    if count < 8:
        raise RasterBlocked({
            "stage": "resample",
            "reason": ("the boundary ring resampled to only %d stations at %.2f m"
                       % (count, SAMPLE_STEP)),
            "largestPassableComponentCells": largest_component_size(base),
        })

    # Rotate so station 0 is the station nearest the committed spawn.
    start = min(range(count), key=lambda k: math.hypot(
        samples[k][0] - sx, samples[k][1] - sz))
    samples = samples[start:] + samples[:start]
    # Round the emitted coordinates first, so the recorded length, arcs and
    # ground heights are exactly the values in the document.
    samples = [(round(x, 6), round(z, 6)) for x, z in samples]

    # Validate the closed loop.
    failures = []
    for index, (x, z) in enumerate(samples):
        previous = samples[(index - 1) % count]
        following = samples[(index + 1) % count]
        tx, tz = following[0] - previous[0], following[1] - previous[1]
        norm = math.hypot(tx, tz) or 1.0
        if not passable(base, xs, zs, x, z):
            failures.append((index, "raster", x, z))
            break
        i, j = CELL_OF(x, z, xs, zs)
        if not eroded[j, i]:
            failures.append((index, "erosion", x, z))
            break
        if not band_passable(base, xs, zs, x, z, tx / norm, tz / norm):
            failures.append((index, "band", x, z))
            break
    if failures:
        index, kind, x, z = failures[0]
        raise RasterBlocked({
            "stage": "validation",
            "stationIndex": int(index),
            "stationCount": count,
            "x": NUM(x, 6),
            "z": NUM(z, 6),
            "reason": ("the raster boundary loop fails the %s check at station %d "
                       "of %d (%.6f, %.6f); the largest connected passable component "
                       "has %d cells"
                       % (kind, index, count, x, z,
                          largest_component_size(base))),
            "largestPassableComponentCells": largest_component_size(base),
        })

    # Closed-loop length, arcs and closure seam.
    spacings = [math.hypot(samples[(k + 1) % count][0] - samples[k][0],
                           samples[(k + 1) % count][1] - samples[k][1])
                for k in range(count)]
    length = sum(spacings)
    seam = spacings[-1]
    if max(spacings) > MAX_STATION_SPACING + 1e-9:
        raise RasterBlocked({
            "stage": "spacing",
            "reason": ("the resampled loop has a station spacing of %.6f m, above "
                       "the %.1f m bound" % (max(spacings), MAX_STATION_SPACING)),
            "largestPassableComponentCells": largest_component_size(base),
        })
    arcs = [0.0]
    for value in spacings[:-1]:
        arcs.append(arcs[-1] + value)

    # Ground heights and clearance.
    grounds = []
    min_clearance = None
    min_clearance_station = None
    for index, (x, z) in enumerate(samples):
        i, j = CELL_OF(x, z, xs, zs)
        value = float(height[j, i])
        if not math.isfinite(value):
            raise RasterBlocked({
                "stage": "ground",
                "reason": ("station %d (%.6f, %.6f) is on a passable cell with no "
                           "finite ground height" % (index, x, z)),
                "largestPassableComponentCells": largest_component_size(base),
            })
        grounds.append(round(value, 4))
        distance = nearest_blocked_distance(base, xs, zs, x, z)
        if distance is not None and (min_clearance is None
                                     or distance < min_clearance):
            min_clearance = distance
            min_clearance_station = index

    spawn_projection = math.hypot(samples[0][0] - sx, samples[0][1] - sz)
    bbox = component_bbox(component, xs, zs)
    return dict(
        samples=samples,
        count=count,
        length=length,
        seam=seam,
        arcs=arcs,
        grounds=grounds,
        min_clearance=min_clearance,
        min_clearance_station=min_clearance_station,
        spawn_projection=spawn_projection,
        snap=snap,
        component_cells=component_cells,
        component_bbox=bbox,
        component_label=cid,
        eroded_cells=int(eroded.sum()),
        base_cells=int(base.sum()),
    )


# --------------------------------------------------------------------------
# document
# --------------------------------------------------------------------------
def build_document(cfg, grid, spawn_doc, built):
    grid_path = ROOT / cfg["grid"]
    spawn_path = ROOT / cfg["spawn"]
    spawn = spawn_doc["layout"]["spawn"]
    samples = built["samples"]
    count = built["count"]
    length = built["length"]
    seam = built["seam"]
    arcs = built["arcs"]
    grounds = built["grounds"]
    snap = built["snap"]

    stations = []
    for index, (x, z) in enumerate(samples):
        stations.append({
            "arc": NUM(arcs[index], 6),
            "x": NUM(x, 6),
            "z": NUM(z, 6),
            "groundY": NUM(grounds[index], 4),
        })

    doc = {
        "kind": "blur.map-laps-aid.raster-course",
        "version": 1,
        "courseId": cfg["map_id"],
        "level": cfg["level"],
        "courseSource": "collision-raster-project-course",
        "retailLineUsed": False,
        "verdict": "course",
        "scope": {
            "collisionOnly": True,
            "retailRacingLine": False,
            "retailStartLine": False,
            "rendererClaim": False,
            "vehiclePhysics": False,
            "gameRun": False,
            "pathDriven": False,
            "note": ("a project course derived from the committed P48 passable "
                     "raster, not from the retail .aid racing line and not from a "
                     "retail start line. It is a data layout, not a driven lap; no "
                     "gate mesh, race director, lap timing or car simulation is "
                     "claimed."),
        },
        "source": {
            "probe": ("probes/map-laps-aid (collision-raster project course; the "
                      "retail .aid line is not read)"),
            "builder": "probes/map-laps-aid/tools/build_raster_course.py",
            "raster": {
                "path": cfg["grid"],
                "fileSha256": file_sha256(grid_path),
                "cellMetres": CELL,
                "shape": [int(grid["base"].shape[0]), int(grid["base"].shape[1])],
                "passableCells": built["base_cells"],
                "erodedCells": built["eroded_cells"],
                "surfaceMinNormalY": SURFACE_MIN_NY,
                "stepLimit": STEP_LIMIT,
                "gradeLimit": GRADE_LIMIT,
                "wallDilateMetres": WALL_DILATE,
                "source": ("P48 passable raster built from the committed "
                           "collision.positions.f32.bin / "
                           "collision.indices.u32.bin triangle buffer"),
            },
            "spawnDocument": {
                "path": cfg["spawn"],
                "bytes": spawn_path.stat().st_size,
                "sha256": file_sha256(spawn_path),
                "schema": spawn_doc.get("schema"),
            },
            "spawn": {
                "x": NUM(spawn["x"], 6),
                "z": NUM(spawn["z"], 6),
                "headingRad": NUM(spawn["heading"], 9),
                "groundY": NUM(spawn["ground"], 4),
                "source": ("the committed spawn pose in %s (layout.spawn); the "
                           "course start is the raster loop station nearest this "
                           "pose" % cfg["spawn"]),
            },
            "algorithm": {
                "name": "clearance-eroded component-boundary cycle",
                "cellMetres": CELL,
                "erosionCells": EROSION_CELLS,
                "erosionRule": ("%d-layer 8-connected erosion of the P48 passable "
                                "raster; a retained cell has every cell within "
                                "Chebyshev distance %d passable, so the nearest "
                                "blocked cell is at least %.1f m away; the raster "
                                "border is treated as blocked"
                                % (EROSION_CELLS, EROSION_CELLS,
                                   GUARANTEED_CLEARANCE)),
                "bandMetres": BAND_METRES,
                "bandHalfWidthMetres": BAND_HALF_WIDTH,
                "bandStepMetres": BAND_STEP,
                "bandSamples": int(round(BAND_HALF_WIDTH / BAND_STEP)) * 2 + 1,
                "sampleStepMetres": SAMPLE_STEP,
                "maxStationSpacingMetres": MAX_STATION_SPACING,
                "spawnSnapLimitMetres": NUM(SPAWN_SNAP_LIMIT, 3),
                "spawnSnapMetres": NUM(snap["metres"], 4),
                "componentCells": built["component_cells"],
                "componentAreaM2": NUM(built["component_cells"] * CELL * CELL, 4),
                "componentBbox": [NUM(value, 4) for value in built["component_bbox"]],
                "boundaryTrace": ("8-connected Moore boundary trace of the component "
                                  "mask, mapped to the eroded foreground cells"),
                "loopRule": ("the outer boundary of the 8-connected component of the "
                             "%d-cell-eroded P48 passable raster that contains the "
                             "committed spawn cell, or the component of the nearest "
                             "eroded cell when the spawn cell is eroded (snap capped "
                             "at %.0f m); no point is hand-placed"
                             % (EROSION_CELLS, SPAWN_SNAP_LIMIT)),
                "startRule": ("the closed ring is resampled at %.2f m and rotated so "
                              "station 0 is the station nearest the committed spawn; "
                              "the spawn projection is recorded, not moved"
                              % SAMPLE_STEP),
                "validationRule": ("every station is on the P48 passable raster and "
                                   "on the eroded mask, and its %.2f m car band is "
                                   "passable perpendicular to the station's "
                                   "central-difference tangent; the closed loop is "
                                   "continuous (station spacing <= %.1f m)"
                                   % (BAND_METRES, MAX_STATION_SPACING)),
            },
        },
        "clearance": {
            "bandMetres": BAND_METRES,
            "halfWidthMetres": BAND_HALF_WIDTH,
            "stepMetres": BAND_STEP,
            "erosionCells": EROSION_CELLS,
            "guaranteedClearanceMetres": NUM(GUARANTEED_CLEARANCE, 3),
            "minRasterClearanceMetres": (NUM(built["min_clearance"], 4)
                                         if built["min_clearance"] is not None
                                         else None),
            "minRasterClearanceStation": built["min_clearance_station"],
            "metric": ("the car band at every %.2f m station, perpendicular to the "
                       "station's central-difference tangent; the loop is traced on "
                       "the passable raster eroded by %d 8-connected layers"
                       % (SAMPLE_STEP, EROSION_CELLS)),
            "bandTier": "narrow",
            "bandTierReason": ("1.680 m is the documented maximum car width "
                               "(%.3f m) with no safety margin, the same narrow band "
                               "the .aid probe tests; the %.3f m band (car + %.2f m "
                               "margin per side) is a stronger clearance that needs "
                               "a 3-cell erosion and selects a smaller component"
                               % (CAR_WIDTH, BAND_2_276, SAFETY_MARGIN)),
        },
        "course": {
            "name": cfg["course_name"],
            "loopLengthMetres": NUM(length, 6),
            "stationCount": count,
            "sampleStepMetres": SAMPLE_STEP,
            "maxStationSpacingMetres": NUM(max(
                math.hypot(samples[(k + 1) % count][0] - samples[k][0],
                           samples[(k + 1) % count][1] - samples[k][1])
                for k in range(count)), 6),
            "closed": True,
            "closureSeamMetres": NUM(seam, 6),
            "start": {
                "x": NUM(samples[0][0], 6),
                "z": NUM(samples[0][1], 6),
                "groundY": NUM(grounds[0], 4),
                "arc": 0,
            },
            "spawnProjection": {
                "x": NUM(samples[0][0], 6),
                "z": NUM(samples[0][1], 6),
                "metres": NUM(built["spawn_projection"], 4),
                "station": 0,
            },
            "groundMinY": NUM(min(grounds), 4),
            "groundMaxY": NUM(max(grounds), 4),
            "stations": stations,
        },
    }
    doc["hash"] = CANONICAL_HASH(doc)
    return doc


def build_blocked_document(cfg, grid, spawn_doc, record):
    grid_path = ROOT / cfg["grid"]
    spawn_path = ROOT / cfg["spawn"]
    spawn = spawn_doc["layout"]["spawn"]
    doc = {
        "kind": "blur.map-laps-aid.raster-course",
        "version": 1,
        "courseId": cfg["map_id"],
        "level": cfg["level"],
        "courseSource": "collision-raster-project-course",
        "retailLineUsed": False,
        "verdict": "blocked",
        "scope": {
            "collisionOnly": True,
            "retailRacingLine": False,
            "retailStartLine": False,
            "rendererClaim": False,
            "vehiclePhysics": False,
            "gameRun": False,
            "pathDriven": False,
            "note": ("a project-course search result, not retail data. No corridor "
                     "is invented; the level stays blocked."),
        },
        "source": {
            "probe": ("probes/map-laps-aid (collision-raster project course; the "
                      "retail .aid line is not read)"),
            "builder": "probes/map-laps-aid/tools/build_raster_course.py",
            "raster": {
                "path": cfg["grid"],
                "fileSha256": file_sha256(grid_path),
                "cellMetres": CELL,
                "shape": [int(grid["base"].shape[0]), int(grid["base"].shape[1])],
                "passableCells": int(grid["base"].sum()),
                "surfaceMinNormalY": SURFACE_MIN_NY,
                "stepLimit": STEP_LIMIT,
                "gradeLimit": GRADE_LIMIT,
                "wallDilateMetres": WALL_DILATE,
            },
            "spawnDocument": {
                "path": cfg["spawn"],
                "bytes": spawn_path.stat().st_size,
                "sha256": file_sha256(spawn_path),
                "schema": spawn_doc.get("schema"),
            },
            "spawn": {
                "x": NUM(spawn["x"], 6),
                "z": NUM(spawn["z"], 6),
                "headingRad": NUM(spawn["heading"], 9),
                "groundY": NUM(spawn["ground"], 4),
                "source": "the committed spawn pose in %s (layout.spawn)" % cfg["spawn"],
            },
            "algorithm": {
                "name": "clearance-eroded component-boundary cycle",
                "cellMetres": CELL,
                "erosionCells": EROSION_CELLS,
                "bandMetres": BAND_METRES,
                "bandHalfWidthMetres": BAND_HALF_WIDTH,
                "bandStepMetres": BAND_STEP,
                "sampleStepMetres": SAMPLE_STEP,
                "maxStationSpacingMetres": MAX_STATION_SPACING,
                "spawnSnapLimitMetres": NUM(SPAWN_SNAP_LIMIT, 3),
            },
        },
        "blocker": {
            "stage": record.get("stage"),
            "stationIndex": record.get("stationIndex"),
            "stationCount": record.get("stationCount"),
            "x": record.get("x"),
            "z": record.get("z"),
            "largestPassableComponentCells": record.get(
                "largestPassableComponentCells"),
            "largestPassableComponentAreaM2": (
                NUM(record["largestPassableComponentCells"] * CELL * CELL, 4)
                if record.get("largestPassableComponentCells") is not None else None),
        },
        "reason": record["reason"],
    }
    doc["hash"] = CANONICAL_HASH(doc)
    return doc


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def build_level(cfg):
    grid = np.load(ROOT / cfg["grid"])
    spawn_doc = load_json(ROOT / cfg["spawn"])
    built = build_course(cfg, grid, spawn_doc)
    return build_document(cfg, grid, spawn_doc, built)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--map", choices=sorted(LEVELS) + ["all"], default="all")
    parser.add_argument("--check", action="store_true",
                        help="compare the generated documents with the committed files")
    args = parser.parse_args(argv)

    keys = sorted(LEVELS) if args.map == "all" else [args.map]
    status = 0
    for key in keys:
        cfg = LEVELS[key]
        grid = np.load(ROOT / cfg["grid"])
        spawn_doc = load_json(ROOT / cfg["spawn"])
        try:
            built = build_course(cfg, grid, spawn_doc)
            doc = build_document(cfg, grid, spawn_doc, built)
        except RasterBlocked as exc:
            doc = build_blocked_document(cfg, grid, spawn_doc, exc.record)
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
        if doc["verdict"] == "course":
            print(json.dumps({
                "level": cfg["level"],
                "mapId": cfg["map_id"],
                "verdict": "course",
                "loopLengthMetres": doc["course"]["loopLengthMetres"],
                "stationCount": doc["course"]["stationCount"],
                "bandMetres": doc["clearance"]["bandMetres"],
                "erosionCells": doc["clearance"]["erosionCells"],
                "spawnProjectionMetres": doc["course"]["spawnProjection"]["metres"],
                "componentCells": doc["source"]["algorithm"]["componentCells"],
                "sha256": hashlib.sha256(encoded).hexdigest(),
            }, indent=1))
        else:
            print(json.dumps({
                "level": cfg["level"],
                "mapId": cfg["map_id"],
                "verdict": "blocked",
                "stage": doc["blocker"]["stage"],
                "reason": doc["reason"],
                "largestPassableComponentCells":
                    doc["blocker"]["largestPassableComponentCells"],
                "sha256": hashlib.sha256(encoded).hexdigest(),
            }, indent=1))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
