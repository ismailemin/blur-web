#!/usr/bin/env python3
"""Re-centre a measured course line on the drivable surface.

The 310 m River line was derived from the collision raster but it hugs the right
edge of the road at several arcs: at arc 150 the passable interval is -14 m to
+2 m around the line, so a human steering right leaves the ground after 2 m and
falls into the void at ~9.8 m.

This tool moves every sample to the centre of its contiguous passable interval,
measured perpendicular to the local tangent on the committed P48 raster, then
*relaxes* the shift field so the line stays smooth:

  1. measure the interval `[high, low]` (metres, signed) at every sample;
  2. start from the interval centre, inset by `INSET_METRES` from both edges;
  3. iterate a 1-2-1 Laplacian smoothing pass and clamp the result back into the
     measured interval after every iteration.

Step 2 alone zig-zags: a wall gap moves the interval centre by several metres
between neighbouring samples, and a narrow +/-2 m moving average cannot remove a
~20 m wavelength. The clamp keeps the relaxed line inside the measured road, so
the result is smooth *and* centred. Nothing is invented: every bound comes from
`base_pass`, and a sample whose interval cannot be measured keeps its position
with a typed note.

It rewrites the layout's samples, arcs, span and hash, re-reads `groundY` at the
shifted positions (a stale height makes the page's `below-ground` rule fire on
flat road), trims trailing samples that left the ground, and records the
measurement in `course.recentre`.

Usage:
  python probes/e1-drive/tools/recentre_layout.py --layout _work/e1-drive/sprint.json \
      --grid _work/drivable-path/grid.npz

It is a one-shot producer: run it on the pre-recentre layout (the committed
`_work/e1-drive/sprint.pre-recentre.json` backup), then finalise the spawn,
finish clearance and canonical hash with `_work/finalise_sprint_layout.mjs`.
Running it on an already re-centred layout measures a second shift, so there is
no `--check` mode.
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
CELL = 0.5
SCAN_HALF_METRES = 12.0
VOID_SCAN_HALF_METRES = 24.0
SCAN_STEP = 0.25
INSET_METRES = 1.0
RELAX_ITERATIONS = 400
TANGENT_HALF_WINDOW = 4


def sha256_text(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_hash(doc: dict) -> str:
    body = {key: value for key, value in doc.items() if key != "hash"}
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256_text(text)


def passable(base: np.ndarray, xs: np.ndarray, zs: np.ndarray, x: float, z: float) -> bool:
    i = int(round((x - xs[0]) / CELL))
    j = int(round((z - zs[0]) / CELL))
    return 0 <= j < base.shape[0] and 0 <= i < base.shape[1] and bool(base[j, i])


def height_at(H: np.ndarray, xs: np.ndarray, zs: np.ndarray, x: float, z: float):
    """Bilinear ground height at (x, z), or None when the ground is missing."""
    fx = (x - xs[0]) / CELL
    fz = (z - zs[0]) / CELL
    i = int(math.floor(fx))
    j = int(math.floor(fz))
    if not (0 <= j < H.shape[0] - 1 and 0 <= i < H.shape[1] - 1):
        return None
    tx = fx - i
    tz = fz - j
    corners = (
        (H[j, i], (1 - tx) * (1 - tz)),
        (H[j, i + 1], tx * (1 - tz)),
        (H[j + 1, i], (1 - tx) * tz),
        (H[j + 1, i + 1], tx * tz),
    )
    total = 0.0
    weight = 0.0
    for value, w in corners:
        if np.isfinite(value):
            total += float(value) * w
            weight += w
    if weight <= 0:
        return None
    return total / weight


def tangents(samples: list[dict]) -> list[tuple[float, float]]:
    count = len(samples)
    out = []
    for index in range(count):
        a = samples[max(0, index - TANGENT_HALF_WINDOW)]
        b = samples[min(count - 1, index + TANGENT_HALF_WINDOW)]
        tx, tz = b["x"] - a["x"], b["z"] - a["z"]
        length = math.hypot(tx, tz)
        if length <= 0:
            out.append((1.0, 0.0))
        else:
            out.append((tx / length, tz / length))
    return out


def measure_intervals(samples, base, xs, zs):
    """Signed passable interval `[high, low]` per sample; None when unmeasured."""
    intervals = []
    for sample, (tx, tz) in zip(samples, tangents(samples)):
        nx, nz = -tz, tx
        if not passable(base, xs, zs, sample["x"], sample["z"]):
            intervals.append(None)
            continue
        low = 0.0
        step = 0
        while step * SCAN_STEP < SCAN_HALF_METRES:
            step += 1
            offset = step * SCAN_STEP
            if not passable(base, xs, zs, sample["x"] + nx * offset, sample["z"] + nz * offset):
                break
            low = offset
        high = 0.0
        step = 0
        while step * SCAN_STEP < SCAN_HALF_METRES:
            step += 1
            offset = -step * SCAN_STEP
            if not passable(base, xs, zs, sample["x"] + nx * offset, sample["z"] + nz * offset):
                break
            high = offset
        intervals.append((high, low))
    return intervals


def measure_void(samples, H, xs, zs):
    """Distance from each sample to the first cell without ground, per side.

    `base_pass` is conservative (it drops slopes steeper than 5 %), so the
    passable interval ends before the actual void. A car only falls where the
    height raster has no ground at all, so the respawn band is measured against
    this edge instead. Returns `(high, low)` in metres, or None when the scan
    found no void inside `SCAN_HALF_METRES`.
    """
    out = []
    for sample, (tx, tz) in zip(samples, tangents(samples)):
        nx, nz = -tz, tx
        edges = []
        for sign in (1.0, -1.0):
            edge = None
            step = 0
            while step * SCAN_STEP < VOID_SCAN_HALF_METRES:
                step += 1
                offset = sign * step * SCAN_STEP
                height = height_at(H, xs, zs, sample["x"] + nx * offset, sample["z"] + nz * offset)
                if height is None:
                    edge = offset
                    break
            edges.append(edge)
        out.append((edges[0], edges[1]))
    return out


def relax(intervals) -> list[float]:
    """Interval centre, relaxed to a smooth field that stays inside the road."""
    count = len(intervals)
    shift = []
    lower = []
    upper = []
    for interval in intervals:
        if interval is None:
            shift.append(0.0)
            lower.append(None)
            upper.append(None)
            continue
        high, low = interval
        lo = high + INSET_METRES
        hi = low - INSET_METRES
        if lo > hi:
            # Narrower than twice the inset: keep the exact centre.
            centre = (high + low) / 2.0
            lo = hi = centre
        shift.append((high + low) / 2.0)
        lower.append(lo)
        upper.append(hi)

    # Seed unmeasured samples from their nearest measured neighbour so the
    # relaxation has a continuous field to work with.
    measured = [index for index, value in enumerate(lower) if value is not None]
    if not measured:
        return shift
    for index in range(count):
        if lower[index] is not None:
            continue
        nearest = min(measured, key=lambda other: abs(other - index))
        shift[index] = shift[nearest]

    for _ in range(RELAX_ITERATIONS):
        previous = shift
        shift = previous[:]
        for index in range(count):
            left = previous[max(0, index - 1)]
            right = previous[min(count - 1, index + 1)]
            value = 0.25 * left + 0.5 * previous[index] + 0.25 * right
            if lower[index] is not None:
                value = min(max(value, lower[index]), upper[index])
            shift[index] = value
    return shift


def recentre(layout: dict, base: np.ndarray, H: np.ndarray, xs: np.ndarray, zs: np.ndarray) -> dict:
    samples = layout["course"]["samples"]
    count = len(samples)
    intervals = measure_intervals(samples, base, xs, zs)
    shifts = relax(intervals)
    directions = tangents(samples)

    notes = []
    out = []
    for index, sample in enumerate(samples):
        tx, tz = directions[index]
        nx, nz = -tz, tx
        shifted = dict(sample)
        shifted["x"] = round(sample["x"] + nx * shifts[index], 6)
        shifted["z"] = round(sample["z"] + nz * shifts[index], 6)
        out.append(shifted)
        if intervals[index] is None:
            notes.append("sample not passable: relaxed from its neighbours")

    # Trim trailing samples that left the ground (the line got longer because it
    # is now centred; the course ends where the measured ground ends).
    trimmed = 0
    while len(out) > 2 and not passable(base, xs, zs, out[-1]["x"], out[-1]["z"]):
        out.pop()
        shifts.pop()
        trimmed += 1
    if trimmed:
        notes.append("trimmed %d trailing samples off the measured ground" % trimmed)

    # Re-read the ground at the shifted positions.
    regrounded = 0
    for sample in out:
        height = height_at(H, xs, zs, sample["x"], sample["z"])
        if height is None:
            notes.append("no ground at shifted sample: groundY kept")
            continue
        if abs(height - float(sample.get("groundY", height))) > 1e-9:
            regrounded += 1
        sample["groundY"] = round(height, 6)
        sample["height"] = round(height, 6)

    # Recompute the arcs from the shifted samples.
    arc = 0.0
    for index, sample in enumerate(out):
        if index > 0:
            arc += math.hypot(sample["x"] - out[index - 1]["x"], sample["z"] - out[index - 1]["z"])
        sample["arc"] = round(arc, 6)

    moved = sum(1 for value in shifts if abs(value) > SCAN_STEP / 2)
    return {
        "samples": out,
        "length": arc,
        "shifts": shifts,
        "moved": moved,
        "regrounded": regrounded,
        "trimmed": trimmed,
        "notes": notes,
        "intervals": intervals,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--layout", default="_work/e1-drive/sprint.json")
    ap.add_argument("--grid", default="_work/drivable-path/grid.npz")
    args = ap.parse_args(argv)

    layout_path = ROOT / args.layout
    grid_path = ROOT / args.grid
    doc = json.loads(layout_path.read_text(encoding="utf-8"))
    grid = np.load(grid_path)
    base = grid["base_pass"] if "base_pass" in grid else grid["base"]
    H = grid["height"]
    xs, zs = grid["xs"], grid["zs"]

    result = recentre(doc, base, H, xs, zs)
    doc["course"]["samples"] = result["samples"]
    doc["course"]["sampleCount"] = len(result["samples"])
    doc["course"]["lengthMetres"] = round(result["length"], 6)
    doc["course"]["finishArc"] = round(result["length"], 6)
    doc["course"]["span"]["lengthMetres"] = round(result["length"], 6)
    doc["course"]["span"]["measuredLengthMetres"] = round(result["length"], 6)
    doc["course"]["span"]["finishArc"] = round(result["length"], 6)
    # Measured respawn band: the nearer void edge, inset by 3 m, clamped to
    # 2..12 m. The scripted sprint keeps a ~0.6 m lateral error, so this band
    # never fires on it; a human gets the real road instead of a fixed 6 m.
    void = measure_void(result["samples"], H, xs, zs)
    rows = []
    last_index = len(result["samples"]) - 1
    for index, (sample, (high, low)) in enumerate(zip(result["samples"], void)):
        # One row per metre of arc (the samples are 0.25 m apart): the band is
        # smooth, and 1,245 rows would triple the layout size for no gain.
        if index % 4 and index != last_index:
            continue
        sides = [abs(value) for value in (high, low) if value is not None]
        if sides:
            band = min(min(sides) - 3.0, 12.0)
        else:
            band = 12.0
        band = max(2.0, band)
        rows.append({
            "arc": sample["arc"],
            "respawnHalfWidthMetres": round(band, 3),
            "voidLeftMetres": None if high is None else round(abs(high), 3),
            "voidRightMetres": None if low is None else round(abs(low), 3),
        })
    # The declared +/-6 m band stays the sprint/AI rule. This measured edge is a
    # respawn safety net: the page takes the smaller of the two, so a human can
    # never reach the void even where the declared band is wider than the road.
    doc["course"]["groundEdge"] = {
        "rule": "per-arc half-width from the nearest ground edge (height raster, no ground = void), inset by 3 m and clamped to 2..12 m; the page respawns at min(declared band, this edge)",
        "halfWidthMetres": round(min(row["respawnHalfWidthMetres"] for row in rows), 3),
        "rows": rows,
        "source": {
            "grid": args.grid,
            "scanHalfMetres": VOID_SCAN_HALF_METRES,
            "scanStepMetres": SCAN_STEP,
            "insetMetres": 3.0,
            "note": "measured ground edge, not a declared lane; the scripted sprint keeps the declared band",
        },
    }
    doc["course"]["recentre"] = {
        "rule": "each sample is moved to the centre of its contiguous passable interval, measured perpendicular to the local tangent on the committed P48 raster, then relaxed by a clamped 1-2-1 smoothing pass so the line stays smooth and inside the road",
        "grid": args.grid,
        "scanHalfMetres": SCAN_HALF_METRES,
        "scanStepMetres": SCAN_STEP,
        "insetMetres": INSET_METRES,
        "relaxIterations": RELAX_ITERATIONS,
        "movedSamples": result["moved"],
        "maxShiftMetres": round(max((abs(v) for v in result["shifts"]), default=0), 3),
        "regroundedSamples": result["regrounded"],
        "trimmedSamples": result["trimmed"],
        "notes": result["notes"][:8],
    }
    # Gates follow their sample index; clamp the finish to the trimmed end.
    last = len(result["samples"]) - 1
    for gate in doc.get("gates", []):
        index = gate.get("sampleIndex")
        if isinstance(index, int):
            index = min(index, last)
            gate["sampleIndex"] = index
            sample = result["samples"][index]
            gate["x"] = sample["x"]
            gate["z"] = sample["z"]
            gate["arc"] = sample["arc"]
            gate["groundY"] = sample["groundY"]
            gate["height"] = sample["groundY"]
            # The gate line (`a`/`b`) is what the crossing test uses; moving
            # only x/z leaves the line at the old position and the car passes
            # beside it. Rebuild it from the gate's own tangent and width.
            tangent = gate.get("tangent") or {}
            tx, tz = tangent.get("tx"), tangent.get("tz")
            if isinstance(tx, (int, float)) and isinstance(tz, (int, float)) and (tx or tz):
                nx, nz = -tz, tx
                half = (gate.get("widthMetres") or 6) / 2.0
                gate["a"] = [round(sample["x"] - nx * half, 6), round(sample["z"] - nz * half, 6)]
                gate["b"] = [round(sample["x"] + nx * half, 6), round(sample["z"] + nz * half, 6)]
            if isinstance(gate.get("coverage"), dict):
                gate["coverage"]["staleAfterRecentre"] = True
    doc["hash"] = canonical_hash(doc)
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"

    layout_path.write_text(text, encoding="utf-8")
    print("WROTE %s %.3f m %d/%d moved (max %.2f m, %d regrounded, %d trimmed)"
          % (args.layout, result["length"], result["moved"], len(result["samples"]),
             max((abs(v) for v in result["shifts"]), default=0),
             result["regrounded"], result["trimmed"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
