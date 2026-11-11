"""Build a sprint course from a level's draw-covered component path.

The five blocked levels were rejected on the retail `.aid` line and on the
widened raster. The map pipeline also measures a draw-covered component
(collision passable AND a draw triangle within 0.5 m). This producer turns
that component's geodesic path into a committed sprint layout.

  python probes/map-laps-aid/tools/build_covered_course.py --map hackney --truncate 640
  python probes/map-laps-aid/tools/build_covered_course.py --map brighton

`--truncate` ends the course at an arc before a feature the committed
controller cannot drive (hackney: a ~4 m hairpin at arc 660). The finish is
the last kept sample; nothing is invented.

Steps: read `_work/map-pipeline/covered/<level>-path.json`, resample to 0.25 m,
detour every station that does not carry the car band to the nearest band-clear
lateral offset inside +/-12 m, relax the offset field with a clamped 1-2-1 pass,
relax the polyline itself (band-clamped), truncate at `--truncate` if given, and
write a sprint layout with start / two checkpoints / finish gates.
"""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-laps/tools"))
sys.path.insert(0, str(ROOT / "probes/map-laps-aid/tools"))

from map_laps_common import CELL, ground_edge_rows  # noqa: E402
from longbeach_path_common import canonical_hash, num  # noqa: E402
from build_aid_paths import lateral_band_clear, band_passable  # noqa: E402

LEVELS = {
    "hackney": ("uk_london_hackney", "_work/map-laps/hackney/grid.npz"),
    "brighton": ("uk_brighton", "_work/map-laps/brighton/grid.npz"),
    "russianhill": ("usa_sanfran_russianhill", "_work/map-laps/russianhill/grid.npz"),
}
STEP = 0.25
SEARCH_M = 12.0
RELAX = 300


def _sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def resample(points, step):
    out = []
    for index in range(len(points) - 1):
        x0, z0 = points[index]
        x1, z1 = points[index + 1]
        span = math.hypot(x1 - x0, z1 - z0)
        count = max(1, int(math.ceil(span / step)))
        for k in range(count):
            t = k / count
            out.append((x0 + (x1 - x0) * t, z0 + (z1 - z0) * t))
    out.append(points[-1])
    return out


def tangents(line):
    out = []
    last = len(line) - 1
    for index in range(len(line)):
        a = line[max(0, index - 2)]
        b = line[min(last, index + 2)]
        tx, tz = b[0] - a[0], b[1] - a[1]
        norm = math.hypot(tx, tz) or 1.0
        out.append((tx / norm, tz / norm))
    return out


def build(map_id, truncate, out_path, smooth=6, path_file=None, centre_edge=False):
    level, grid_rel = LEVELS[map_id]
    source_path = path_file or ("_work/map-pipeline/covered/%s-path.json" % level)
    covered = json.loads((ROOT / source_path).read_text(encoding="utf-8"))
    line = resample([(p["x"], p["z"]) for p in covered["samples"]], STEP)
    grid = np.load(ROOT / grid_rel)
    base, H, xs, zs = grid["base"], grid["height"], grid["xs"], grid["zs"]

    dirs = tangents(line)
    offsets = []
    clear_count = 0
    for index, (x, z) in enumerate(line):
        tx, tz = dirs[index]
        if band_passable(base, xs, zs, x, z, tx, tz):
            offsets.append(0.0)
            clear_count += 1
            continue
        candidates, clear = lateral_band_clear(base, xs, zs, x, z, tx, tz,
                                               search_m=SEARCH_M)
        best = None
        for offset, ok in zip(candidates, clear):
            if ok and (best is None or abs(offset) < abs(best)):
                best = float(offset)
        offsets.append(best if best is not None else 0.0)

    lower = [None] * len(offsets)
    upper = [None] * len(offsets)
    for index, (x, z) in enumerate(line):
        tx, tz = dirs[index]
        candidates, clear = lateral_band_clear(base, xs, zs, x, z, tx, tz,
                                               search_m=SEARCH_M)
        ok = [float(o) for o, c in zip(candidates, clear) if c]
        if ok:
            lower[index] = min(ok)
            upper[index] = max(ok)
    for _ in range(RELAX):
        previous = offsets
        offsets = previous[:]
        for index in range(len(offsets)):
            left = previous[max(0, index - 1)]
            right = previous[min(len(offsets) - 1, index + 1)]
            value = 0.25 * left + 0.5 * previous[index] + 0.25 * right
            if lower[index] is not None:
                value = min(max(value, lower[index]), upper[index])
            offsets[index] = value

    points = []
    for index, (x, z) in enumerate(line):
        tx, tz = dirs[index]
        nx, nz = -tz, tx
        points.append((x + nx * offsets[index], z + nz * offsets[index]))

    # Centre the line on the measured ground edge. The band detour only moves a
    # station when the car does not fit; a station can carry the band while
    # sitting 3 m from a ledge, and the scripted controller drives wide. The
    # shift balances the distance to the void on both sides, clamped to +/-6 m
    # and relaxed, then the band check is re-applied.
    if centre_edge:
        def void_distance(x, z, nx, nz, sign):
            step = 0
            while step * CELL < 24.0:
                step += 1
                offset = sign * step * CELL
                i = int(round((x + nx * offset - xs[0]) / CELL))
                j = int(round((z + nz * offset - zs[0]) / CELL))
                inside = 0 <= j < H.shape[0] and 0 <= i < H.shape[1]
                if not inside or not np.isfinite(H[j, i]):
                    return offset
            return None

        edge_shift = []
        for index, (x, z) in enumerate(points):
            tx, tz = dirs[index]
            nx, nz = -tz, tx
            left = void_distance(x, z, nx, nz, 1.0)
            right = void_distance(x, z, nx, nz, -1.0)
            # +n is the left normal: a positive shift moves the line left.
            # No void on the left means there is room there, so the line moves
            # left; no void on the right moves it right.
            # Target a 6 m clearance on the near side: the respawn band is
            # `min(void) - 3`, so 6 m gives a 3 m band, wide enough for the
            # scripted controller (which drives up to ~3 m off the line).
            if left is None and right is None:
                edge_shift.append(0.0)
            elif left is None:
                edge_shift.append(min(6.0, max(0.0, abs(right) - 6.0)))
            elif right is None:
                edge_shift.append(-min(6.0, max(0.0, abs(left) - 6.0)))
            else:
                edge_shift.append(max(-6.0, min(6.0, (abs(left) - abs(right)) / 2.0)))
        for _ in range(200):
            previous = edge_shift
            edge_shift = previous[:]
            for index in range(len(edge_shift)):
                a = previous[max(0, index - 1)]
                b = previous[min(len(edge_shift) - 1, index + 1)]
                edge_shift[index] = 0.25 * a + 0.5 * previous[index] + 0.25 * b
        for index, (x, z) in enumerate(points):
            tx, tz = dirs[index]
            nx, nz = -tz, tx
            shifted = (x + nx * edge_shift[index], z + nz * edge_shift[index])
            if band_passable(base, xs, zs, shifted[0], shifted[1], tx, tz):
                points[index] = shifted

    # The covered path is a 1 m grid geodesic: its corners are sharper than a
    # driven racing line. Relax the polyline, but keep every smoothed point only
    # where it still carries the band; otherwise keep the measured point.
    for _ in range(smooth):
        previous = points
        smoothed = previous[:]
        for index in range(1, len(previous) - 1):
            x = 0.25 * previous[index - 1][0] + 0.5 * previous[index][0] + 0.25 * previous[index + 1][0]
            z = 0.25 * previous[index - 1][1] + 0.5 * previous[index][1] + 0.25 * previous[index + 1][1]
            tx, tz = dirs[index]
            if band_passable(base, xs, zs, x, z, tx, tz):
                smoothed[index] = (x, z)
        points = smoothed

    # Arc table, then optional truncation before a feature the controller cannot
    # drive (a hairpin). The finish becomes the last kept sample.
    arcs = [0.0]
    for index in range(1, len(points)):
        arcs.append(arcs[-1] + math.hypot(points[index][0] - points[index - 1][0],
                                          points[index][1] - points[index - 1][1]))
    if truncate:
        keep = [index for index, arc in enumerate(arcs) if arc <= truncate]
        if len(keep) < 10:
            raise SystemExit("truncate leaves too few samples")
        points = [points[index] for index in keep]
        arcs = [arcs[index] for index in keep]

    samples = []
    for index, (x, z) in enumerate(points):
        i = int(round((x - xs[0]) / CELL))
        j = int(round((z - zs[0]) / CELL))
        ground = float(H[j, i]) if np.isfinite(H[j, i]) else 0.0
        samples.append({"arc": num(arcs[index], 6), "x": num(x, 6), "z": num(z, 6),
                        "groundY": num(ground, 4), "covered": None})
    length = arcs[-1]

    def straightest(target):
        best = None
        for index in range(2, len(samples) - 2):
            if abs(samples[index]["arc"] - target) > 12.0:
                continue
            a = samples[index - 2]
            b = samples[index + 2]
            h1 = math.atan2(b["z"] - a["z"], b["x"] - a["x"])
            c = samples[index + 4] if index + 4 < len(samples) else samples[-1]
            h2 = math.atan2(c["z"] - samples[index]["z"], c["x"] - samples[index]["x"])
            turn = abs((h2 - h1 + math.pi) % (2 * math.pi) - math.pi)
            if best is None or turn < best[0]:
                best = (turn, index)
        return best[1] if best else len(samples) // 2

    cp1 = straightest(length / 3.0)
    cp2 = straightest(2.0 * length / 3.0)

    def gate(kind, index, gate_id, sample_index):
        sample = samples[sample_index]
        a = samples[max(0, sample_index - 2)]
        b = samples[min(len(samples) - 1, sample_index + 2)]
        tx, tz = b["x"] - a["x"], b["z"] - a["z"]
        norm = math.hypot(tx, tz) or 1.0
        ux, uz = tx / norm, tz / norm
        nx, nz = -uz, ux
        half = 4.0
        return {
            "id": gate_id, "kind": kind, "index": index,
            "sampleIndex": sample_index, "arc": sample["arc"],
            "x": sample["x"], "z": sample["z"],
            "groundY": sample["groundY"], "height": sample["groundY"],
            "headingRad": num(math.atan2(ux, uz), 9),
            # A near-zero tangent component must be an exact 0: Python writes
            # 1e-06 where JavaScript writes 0.000001, and the committed hash is
            # canonical JSON.
            "tangent": {"tx": num(ux if abs(ux) >= 1e-4 else 0.0, 6),
                        "tz": num(uz if abs(uz) >= 1e-4 else 0.0, 6),
                        "windowMetres": 5},
            "widthMetres": 8, "requestedWidthMetres": 8, "narrowed": False,
            "a": [num(sample["x"] - nx * half, 6), num(sample["z"] - nz * half, 6)],
            "b": [num(sample["x"] + nx * half, 6), num(sample["z"] + nz * half, 6)],
            "coverage": {"source": "covered-path experiment; not measured",
                         "coveredSamples": None},
            "groundCheck": None,
        }

    gates = [
        gate("start", 0, "start", 0),
        gate("checkpoint", 1, "checkpoint-1", cp1),
        gate("checkpoint", 2, "checkpoint-2", cp2),
        gate("finish", 3, "finish", len(samples) - 1),
    ]

    edge_rows = [
        {"arc": num(row["arc"], 6),
         "respawnHalfWidthMetres": num(row["respawnHalfWidthMetres"], 3),
         "voidLeftMetres": num(row["voidLeftMetres"], 3),
         "voidRightMetres": num(row["voidRightMetres"], 3)}
        for row in ground_edge_rows(samples, H, xs, zs, CELL)
    ]

    doc = {
        "kind": "e1-drive.sprint",
        "version": 1,
        "courseId": map_id,
        "scope": {
            "collisionOnly": True,
            "drawGeometryRead": True,
            "drawPathReadForCorridor": True,
            "drawCoverageSource": "map-pipeline covered component path",
            "rendererClaim": "none",
            "vehiclePhysics": "committed e1-drive module",
            "gameRun": "experiment only",
            "pathDriven": False,
            "engineTrace": False,
            "note": "covered-path experiment; not a committed map",
        },
        "source": {
            "map": map_id,
            "level": level,
            # The map package validator compares these two against the package
            # pins, so the layout carries the same identity the map does.
            "physics": {
                "path": "game-data/Blur/levels/%s/Level.levelphysics" % level,
                "sha256": "sha256:" + _sha256(ROOT / ("game-data/Blur/levels/%s/Level.levelphysics" % level)),
            },
            "render": {
                "path": "_work/map-batch/%s/draws.json" % level,
                "contentHash": "sha256:" + _sha256(ROOT / ("_work/map-batch/%s/draws.json" % level)),
            },
            "slice": {
                "path": "_work/map-batch/%s/collision.json" % level,
                "contentHash": "sha256:" + _sha256(ROOT / ("_work/map-batch/%s/collision.json" % level)),
            },
            "coveredPath": source_path,
            "raster": grid_rel,
            "spawnSource": "the covered path's first station (not the committed spawn)",
            "truncateArc": num(truncate),
        },
        "course": {
            "rule": ("draw-covered component geodesic path; 0.25 m stations; "
                     "band-clear detour inside +/-12 m; experiment"),
            "name": "%s covered-path experiment" % level,
            "spawn": {"x": samples[0]["x"], "z": samples[0]["z"],
                      "headingRad": gates[0]["headingRad"]},
            "spawnGroundY": samples[0]["groundY"],
            "start": {"x": samples[0]["x"], "z": samples[0]["z"], "arc": 0,
                      "groundY": samples[0]["groundY"]},
            "finish": {"x": samples[-1]["x"], "z": samples[-1]["z"],
                       "arc": num(length, 6), "groundY": samples[-1]["groundY"]},
            "measuredEnd": {"x": samples[-1]["x"], "z": samples[-1]["z"],
                            "arc": num(length, 6), "groundY": samples[-1]["groundY"]},
            "lengthMetres": num(length, 6),
            "finishArc": num(length, 6),
            "sampleStepMetres": STEP,
            "sampleCount": len(samples),
            "span": {"startArc": 0, "finishArc": num(length, 6),
                     "lengthMetres": num(length, 6),
                     "measuredLengthMetres": num(length, 6),
                     "finishClearanceMetres": 0,
                     "note": "covered-path experiment"},
            "band": {"halfWidthMetres": 6,
                     "source": "declared controller and respawn band",
                     "note": "not a road-width claim"},
            "corridor": {"halfWidthMetres": 6,
                         "rule": "declared +/-6 m respawn band",
                         "source": {"note": "experiment"}},
            "groundEdge": {
                "rule": ("per-arc half-width from the nearest ground edge, inset "
                         "3 m, clamped 2..12 m"),
                "halfWidthMetres": num(min(row["respawnHalfWidthMetres"]
                                           for row in edge_rows), 3),
                "rows": edge_rows,
                "source": {"raster": grid_rel, "scanHalfMetres": 24,
                           "insetMetres": 3, "declaredBandMetres": 6},
            },
            "gateRule": "arc-progression",
            "samples": samples,
        },
        "gates": gates,
        "countdown": {"ticks": 90, "stepTicks": 30, "labels": ["3", "2", "1"],
                      "goLabel": "GO",
                      "rule": "input is held at zero until GO; the timer starts at GO"},
        "rules": {
            "tickHz": 60,
            "timer": "counts up from GO",
            "gateOrder": "start, checkpoint-1, checkpoint-2, finish",
            "finishRequiresAllCheckpoints": True,
            "progress": "furthest measured arc",
            "respawn": {
                "fallBelowGroundMetres": 1,
                "airborneTicks": 30,
                "outsideBandMarginMetres": 1,
                "overshootMarginMetres": 2,
                "target": "the gate point of the last passed checkpoint",
                "rule": ("respawn when the chassis falls more than 1 m below the "
                         "measured ground, stays airborne for 30 ticks, or leaves "
                         "the measured band"),
            },
            "limits": ["covered-path experiment; not a committed map"],
        },
        "integration": {"integrated": False,
                        "needed": ["engine sprint", "registry pins"]},
    }
    doc["hash"] = canonical_hash(doc)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    print("wrote %s  %.3f m  %d samples  band-clear %.1f%%  groundEdge min %.2f"
          % (out_path, length, len(samples), 100.0 * clear_count / len(line),
             doc["course"]["groundEdge"]["halfWidthMetres"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", required=True, choices=sorted(LEVELS))
    ap.add_argument("--truncate", type=float, default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--smooth", type=int, default=6)
    ap.add_argument("--path", default=None, help="covered path document")
    ap.add_argument("--centre-edge", action="store_true",
                    help="centre the line on the measured ground edge")
    args = ap.parse_args()
    out = Path(args.out) if args.out else (
        ROOT / ("probes/map-laps-aid/data/%s-covered-path.json" % args.map))
    build(args.map, args.truncate, out, args.smooth, args.path, args.centre_edge)


if __name__ == "__main__":
    main()
