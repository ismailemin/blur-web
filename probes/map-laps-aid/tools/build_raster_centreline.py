#!/usr/bin/env python3
"""Build a drivable centreline for a level from the P48 passable raster.

The committed raster *course* (`build_raster_course.py`) is the outer boundary of
the clearance-eroded passable component. For these five levels that boundary is
the edge of a plaza/spur, not a road: it turns through the full component width
and is far tighter than any car can follow.

This tool finds the **widest ring** inside the component instead:

1. load the committed P48 passable raster `_work/map-laps/<mapId>/grid.npz`;
2. erode it by `EROSION_CELLS` (the same 1.5 m clearance the course uses);
3. keep the eroded component that contains (or is nearest to) the committed
   spawn;
4. compute the Chebyshev cell distance `D` to the blocked set;
5. scan `t` from `max(D)` down and keep the largest `t` for which the region
   `D >= t` still encloses a hole (a background region that does not touch the
   raster border). That hole is the island the ring road runs around, and the
   ring is the hole's boundary;
6. trace the hole boundary, resample at 0.25 m, smooth it, and emit
   `data/<mapId>-centreline.json` in the same schema as the raster course.

The spawn is the ring station nearest the committed spawn pose; the committed
pose is kept in `source.spawn` as provenance. Every station is a raster cell of
the committed component, and the ground height is the committed raster height.

A component with no enclosing hole at any `t` is reported as `blocked` with the
exact reason (Russian Hill is such a component: 9,582 cells, no hole at any
threshold).

Usage:
  python probes/map-laps-aid/tools/build_raster_centreline.py [--map hackney]
  python probes/map-laps-aid/tools/build_raster_centreline.py --check
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

from raster import erode, label_components  # noqa: E402  (read-only reuse)
from build_loops import moore_trace  # noqa: E402  (read-only reuse)

CELL_METRES = 0.5
EROSION_CELLS = 2
SAMPLE_STEP_METRES = 0.25
MIN_HOLE_CELLS = 64

LEVELS = {
    "russianhill": dict(
        level="usa_sanfran_russianhill",
        grid="_work/map-laps/russianhill/grid.npz",
        spawn="_work/map-batch/usa_sanfran_russianhill/spawn.json",
        out="probes/map-laps-aid/data/russianhill-centreline.json",
    ),
    "hackney": dict(
        level="uk_london_hackney",
        grid="_work/map-laps/hackney/grid.npz",
        spawn="_work/map-batch/uk_london_hackney/spawn.json",
        out="probes/map-laps-aid/data/hackney-centreline.json",
    ),
    "brighton": dict(
        level="uk_brighton",
        grid="_work/map-laps/brighton/grid.npz",
        spawn="_work/map-batch/uk_brighton/spawn.json",
        out="probes/map-laps-aid/data/brighton-centreline.json",
    ),
    "sausalito": dict(
        level="usa_sanfran_sausalito",
        grid="_work/map-laps/sausalito/grid.npz",
        spawn="_work/map-batch/usa_sanfran_sausalito/spawn.json",
        out="probes/map-laps-aid/data/sausalito-centreline.json",
    ),
    "bowl": dict(
        level="spa_barcelona_bowl_multiplayer",
        grid="_work/map-laps/bowl/grid.npz",
        spawn="_work/map-batch/spa_barcelona_bowl_multiplayer/spawn.json",
        out="probes/map-laps-aid/data/bowl-centreline.json",
    ),
}

NEIGHBOURS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def dilate(mask: np.ndarray) -> np.ndarray:
    out = mask.copy()
    for dy, dx in NEIGHBOURS:
        out |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
    return out


def distance_to_blocked(mask: np.ndarray) -> np.ndarray:
    """Chebyshev cell distance from every passable cell to the nearest blocked cell."""
    dist = np.full(mask.shape, -1, dtype=np.int16)
    dist[~mask] = 0
    frontier = ~mask
    for step in range(1, 512):
        grown = dilate(frontier) & mask & (dist < 0)
        if not grown.any():
            break
        dist[grown] = step
        frontier = grown
    return dist


def background_holes(mask: np.ndarray) -> list[tuple[int, int]]:
    """Background components that do not touch the raster border: (label, size)."""
    labels, sizes = label_components(~mask, conn=4)
    border = set(labels[0, :].tolist()) | set(labels[-1, :].tolist()) | \
        set(labels[:, 0].tolist()) | set(labels[:, -1].tolist())
    holes = []
    for label in range(1, len(sizes) + 1):
        if label in border:
            continue
        if sizes[label - 1] < MIN_HOLE_CELLS:
            continue
        holes.append((label, sizes[label - 1]))
    return holes


def resample_closed(points: list[tuple[float, float]], step: float) -> list[tuple[float, float]]:
    closed = points + [points[0]]
    lengths = [0.0]
    for index in range(1, len(closed)):
        lengths.append(lengths[-1] + math.hypot(closed[index][0] - closed[index - 1][0],
                                                closed[index][1] - closed[index - 1][1]))
    total = lengths[-1]
    count = max(8, int(round(total / step)))
    out = []
    cursor = 0
    for index in range(count):
        target = total * index / count
        while cursor + 1 < len(lengths) and lengths[cursor + 1] < target:
            cursor += 1
        span = lengths[cursor + 1] - lengths[cursor]
        t = 0.0 if span <= 0 else (target - lengths[cursor]) / span
        out.append((closed[cursor][0] + (closed[cursor + 1][0] - closed[cursor][0]) * t,
                    closed[cursor][1] + (closed[cursor + 1][1] - closed[cursor][1]) * t))
    return out


def smooth_closed(points: list[tuple[float, float]], half_window: int = 2) -> list[tuple[float, float]]:
    count = len(points)
    out = []
    for index in range(count):
        sx = 0.0
        sz = 0.0
        for offset in range(-half_window, half_window + 1):
            neighbour = points[(index + offset) % count]
            sx += neighbour[0]
            sz += neighbour[1]
        out.append((sx / (2 * half_window + 1), sz / (2 * half_window + 1)))
    return out


def curvature_min_radius(points: list[tuple[float, float]]) -> tuple[float, int]:
    count = len(points)
    best = float("inf")
    best_index = 0
    for index in range(count):
        a = points[(index - 1) % count]
        b = points[index]
        c = points[(index + 1) % count]
        ab = math.hypot(b[0] - a[0], b[1] - a[1])
        bc = math.hypot(c[0] - b[0], c[1] - b[1])
        ca = math.hypot(a[0] - c[0], a[1] - c[1])
        cross = abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
        if cross < 1e-12:
            continue
        radius = (ab * bc * ca) / (2 * cross)
        if radius < best:
            best = radius
            best_index = index
    return best, best_index


def build(map_id: str) -> dict:
    cfg = LEVELS[map_id]
    grid_path = ROOT / cfg["grid"]
    spawn_path = ROOT / cfg["spawn"]
    grid = np.load(grid_path)
    base = grid["base"].astype(bool)
    height = grid["height"]
    xs = grid["xs"]
    zs = grid["zs"]

    spawn_doc = json.loads(spawn_path.read_text(encoding="utf-8"))
    spawn = spawn_doc.get("layout", {}).get("spawn") or spawn_doc.get("spawn") or {}
    spawn_x = float(spawn.get("x"))
    spawn_z = float(spawn.get("z"))

    eroded = erode(base, EROSION_CELLS)
    labels, sizes = label_components(eroded, conn=8)
    col = int(round((spawn_x - xs[0]) / CELL_METRES))
    row = int(round((spawn_z - zs[0]) / CELL_METRES))
    row = max(0, min(labels.shape[0] - 1, row))
    col = max(0, min(labels.shape[1] - 1, col))
    component_id = int(labels[row, col])
    snapped = 0.0
    if component_id == 0:
        rows, cols = np.nonzero(labels)
        if rows.size == 0:
            return {"mapId": map_id, "verdict": "blocked",
                    "reason": "the eroded raster has no passable component"}
        d2 = (xs[cols] - spawn_x) ** 2 + (zs[rows] - spawn_z) ** 2
        nearest = int(np.argmin(d2))
        row, col = int(rows[nearest]), int(cols[nearest])
        component_id = int(labels[row, col])
        snapped = float(math.sqrt(d2[nearest]))
    component = labels == component_id
    component_cells = int(component.sum())

    dist = distance_to_blocked(component)
    max_distance = int(dist.max())

    chosen = None
    for threshold in range(max_distance, 0, -1):
        region = component & (dist >= threshold)
        bg_labels, bg_sizes = label_components(~region, conn=4)
        border = set(bg_labels[0, :].tolist()) | set(bg_labels[-1, :].tolist()) | \
            set(bg_labels[:, 0].tolist()) | set(bg_labels[:, -1].tolist())
        holes = [(label, bg_sizes[label - 1]) for label in range(1, len(bg_sizes) + 1)
                 if label not in border and bg_sizes[label - 1] >= MIN_HOLE_CELLS]
        if not holes:
            continue
        best = None
        for label, size in holes:
            rows, cols = np.nonzero(bg_labels == label)
            d2 = (xs[cols] - spawn_x) ** 2 + (zs[rows] - spawn_z) ** 2
            distance = float(math.sqrt(d2.min()))
            if best is None or distance < best[0]:
                best = (distance, label, size)
        chosen = (threshold, region, best, bg_labels)
        break

    if chosen is None:
        return {"mapId": map_id, "verdict": "blocked",
                "reason": "the eroded component encloses no hole at any distance threshold",
                "componentCells": component_cells,
                "maxDistanceCells": max_distance}

    threshold, region, (hole_distance, hole_label, hole_size), bg_labels = chosen
    hole_mask = bg_labels == hole_label
    contour = moore_trace(hole_mask)
    if contour is None or len(contour) < 32:
        return {"mapId": map_id, "verdict": "blocked",
                "reason": "the hole boundary trace is too short",
                "holeCells": hole_size}

    points = [(float(xs[c]), float(zs[r])) for r, c in contour]
    resampled = resample_closed(points, SAMPLE_STEP_METRES)

    # The hole boundary is a grid staircase. Smooth it with the widest window
    # that keeps every station on a passable cell, and keep the first window
    # whose minimum radius clears the car's turning circle (documented 3.8 m for
    # the 2.652 m wheelbase at full lock; 6 m is the controller target).
    def passable_all(candidate):
        for x, z in candidate:
            c = int(round((x - xs[0]) / CELL_METRES))
            r = int(round((z - zs[0]) / CELL_METRES))
            if not (0 <= r < base.shape[0] and 0 <= c < base.shape[1]):
                return False
            if not base[r, c]:
                return False
        return True

    smoothed = resampled
    smoothing_window = 0
    for half_window in (4, 8, 12, 16, 24, 32):
        candidate = smooth_closed(resampled, half_window)
        if not passable_all(candidate):
            continue
        smoothed = candidate
        smoothing_window = half_window
        radius, _ = curvature_min_radius(candidate)
        if radius >= 6.0:
            break
    best_index = min(range(len(smoothed)),
                     key=lambda i: (smoothed[i][0] - spawn_x) ** 2 + (smoothed[i][1] - spawn_z) ** 2)
    smoothed = smoothed[best_index:] + smoothed[:best_index]

    length = 0.0
    for index in range(len(smoothed)):
        a = smoothed[index]
        b = smoothed[(index + 1) % len(smoothed)]
        length += math.hypot(b[0] - a[0], b[1] - a[1])

    stations = []
    arc = 0.0
    for index, (x, z) in enumerate(smoothed):
        c = int(round((x - xs[0]) / CELL_METRES))
        r = int(round((z - zs[0]) / CELL_METRES))
        c = max(0, min(height.shape[1] - 1, c))
        r = max(0, min(height.shape[0] - 1, r))
        if index > 0:
            previous = smoothed[index - 1]
            arc += math.hypot(x - previous[0], z - previous[1])
        stations.append({"arc": round(arc, 6), "x": round(x, 6), "z": round(z, 6),
                         "groundY": round(float(height[r, c]), 6)})

    min_radius, min_index = curvature_min_radius(smoothed)
    body = {
        "kind": "blur.map-laps-aid.raster-course",
        "version": 1,
        "courseId": map_id,
        "level": cfg["level"],
        "courseSource": "collision-raster-ring",
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
            "note": "the widest ring inside the passable component: the boundary of the largest enclosed hole",
        },
        "source": {
            "probe": "probes/map-laps-aid/tools/build_raster_centreline.py",
            "builder": "probes/map-laps-aid/tools/build_raster_centreline.py",
            "raster": cfg["grid"],
            "rasterSha256": "sha256:" + sha256_file(grid_path),
            "spawnDocument": cfg["spawn"],
            "spawn": {**spawn, "source": "the committed map-batch spawn document"},
            "spawnSnapMetres": round(snapped, 4),
            "algorithm": {
                "name": "widest enclosed-hole ring",
                "cellMetres": CELL_METRES,
                "erosionCells": EROSION_CELLS,
                "thresholdCells": threshold,
                "holeCells": hole_size,
                "holeDistanceFromSpawnMetres": round(hole_distance, 3),
                "sampleStepMetres": SAMPLE_STEP_METRES,
                "smoothingHalfWindow": smoothing_window,
                "metric": "the largest Chebyshev distance t for which the passable component still encloses a hole; the ring is that hole's boundary",
            },
        },
        "clearance": {
            "bandMetres": 1.68,
            "halfWidthMetres": 0.84,
            "stepMetres": 0.21,
            "erosionCells": EROSION_CELLS,
            "guaranteedClearanceMetres": round(EROSION_CELLS * CELL_METRES + threshold * CELL_METRES, 3),
            "minRasterClearanceMetres": round(EROSION_CELLS * CELL_METRES + threshold * CELL_METRES, 3),
            "metric": "the ring is the hole boundary of the region D >= t, so every station is at least t + erosion cells from blocked cells",
            "bandTier": "narrow",
            "bandTierReason": "1.680 m is the documented maximum car width with no safety margin",
        },
        "course": {
            "name": cfg["level"] + " collision-raster ring course",
            "loopLengthMetres": round(length, 6),
            "stationCount": len(stations),
            "sampleStepMetres": SAMPLE_STEP_METRES,
            "maxStationSpacingMetres": round(max(
                math.hypot(stations[(i + 1) % len(stations)]["x"] - stations[i]["x"],
                           stations[(i + 1) % len(stations)]["z"] - stations[i]["z"])
                for i in range(len(stations))), 6),
            "closed": True,
            "closureSeamMetres": round(math.hypot(stations[0]["x"] - stations[-1]["x"],
                                                  stations[0]["z"] - stations[-1]["z"]), 6),
            "start": stations[0],
            "spawnProjection": {
                "x": stations[0]["x"],
                "z": stations[0]["z"],
                "metres": round(math.hypot(stations[0]["x"] - spawn_x, stations[0]["z"] - spawn_z), 4),
                "station": 0,
            },
            "groundMinY": min(s["groundY"] for s in stations),
            "groundMaxY": max(s["groundY"] for s in stations),
            "minRadiusMetres": round(min_radius, 3),
            "minRadiusStation": min_index,
            "componentCells": component_cells,
            "stations": stations,
        },
    }
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    body["hash"] = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return body


_LABEL_CACHE: dict[int, np.ndarray] = {}


def labels_of(mask: np.ndarray) -> np.ndarray:
    key = id(mask)
    cached = _LABEL_CACHE.get(key)
    if cached is not None:
        return cached
    labels, _sizes = label_components(mask, conn=4)
    _LABEL_CACHE[key] = labels
    return labels


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--map", choices=sorted(LEVELS), default=None)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)
    maps = [args.map] if args.map else sorted(LEVELS)
    failures = 0
    for map_id in maps:
        body = build(map_id)
        out = ROOT / LEVELS[map_id]["out"]
        if body.get("verdict") != "course":
            print("BLOCKED %s: %s" % (map_id, body.get("reason")))
            failures += 1
            continue
        text = json.dumps(body, indent=2, ensure_ascii=False) + "\n"
        if args.check:
            if not out.is_file() or out.read_text(encoding="utf-8") != text:
                print("STALE %s" % out.relative_to(ROOT))
                failures += 1
            else:
                print("OK %s %.3f m min radius %.3f m" %
                      (map_id, body["course"]["loopLengthMetres"], body["course"]["minRadiusMetres"]))
        else:
            out.write_text(text, encoding="utf-8")
            print("WROTE %s %.3f m %d stations min radius %.3f m clearance %.2f m" %
                  (map_id, body["course"]["loopLengthMetres"], body["course"]["stationCount"],
                   body["course"]["minRadiusMetres"], body["clearance"]["guaranteedClearanceMetres"]))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
