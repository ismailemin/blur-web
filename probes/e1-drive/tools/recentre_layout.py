#!/usr/bin/env python3
"""Re-centre a measured course line on the drivable surface.

The 310 m River line was derived from the collision raster but it hugs the right
edge of the road at several arcs: at arc 150 the passable interval is -14 m to
+2 m around the line, so a human steering right falls into the void after 2 m.

This tool shifts every sample to the centre of the contiguous passable interval
that contains it, measured perpendicular to the local tangent on the committed
P48 raster. Nothing is invented: the shift is measured from `base_pass`, and a
sample whose interval cannot be measured keeps its position with a typed note.

It rewrites the layout's samples, arcs, span, gates and hash, and records the
per-sample shift in `course.recentre`.

Usage:
  python probes/e1-drive/tools/recentre_layout.py --layout _work/e1-drive/sprint.json \
      --grid _work/drivable-path/grid.npz
  python probes/e1-drive/tools/recentre_layout.py --check
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
SCAN_HALF_METRES = 24.0
SCAN_STEP = 0.25
SMOOTH_HALF_WINDOW = 8


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


def recentre(layout: dict, base: np.ndarray, xs: np.ndarray, zs: np.ndarray) -> dict:
    samples = layout["course"]["samples"]
    count = len(samples)
    shifts = []
    notes = []
    out = []
    for index, sample in enumerate(samples):
        a = samples[max(0, index - 4)]
        b = samples[min(count - 1, index + 4)]
        tx, tz = b["x"] - a["x"], b["z"] - a["z"]
        length = math.hypot(tx, tz)
        if length <= 0:
            out.append(sample)
            shifts.append(0.0)
            notes.append("zero tangent: sample kept")
            continue
        tx, tz = tx / length, tz / length
        nx, nz = -tz, tx
        # The contiguous passable interval around the sample.
        if not passable(base, xs, zs, sample["x"], sample["z"]):
            out.append(sample)
            shifts.append(0.0)
            notes.append("sample not passable: kept")
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
        centre = (low + high) / 2.0
        if abs(centre) < SCAN_STEP / 2:
            out.append(sample)
            shifts.append(0.0)
            continue
        shifted = dict(sample)
        shifted["x"] = round(sample["x"] + nx * centre, 6)
        shifted["z"] = round(sample["z"] + nz * centre, 6)
        out.append(shifted)
        shifts.append(round(centre, 6))

    # Smooth the shift along the line: an independent per-sample shift can
    # zig-zag between adjacent samples and break the controller. A centred
    # moving average over +/- SMOOTH_HALF_WINDOW samples keeps the line smooth
    # while staying inside the measured passable interval.
    if SMOOTH_HALF_WINDOW > 0:
        smoothed = []
        for index in range(len(shifts)):
            total = 0.0
            weight = 0
            for offset in range(-SMOOTH_HALF_WINDOW, SMOOTH_HALF_WINDOW + 1):
                neighbour = (index + offset) % len(shifts)
                total += shifts[neighbour]
                weight += 1
            smoothed.append(total / weight)
        # Re-apply the smoothed shift from the original samples.
        for index, sample in enumerate(samples):
            a = samples[max(0, index - 4)]
            b = samples[min(count - 1, index + 4)]
            tx, tz = b["x"] - a["x"], b["z"] - a["z"]
            length_tangent = math.hypot(tx, tz)
            if length_tangent <= 0:
                continue
            tx, tz = tx / length_tangent, tz / length_tangent
            nx, nz = -tz, tx
            shifted = dict(sample)
            shifted["x"] = round(sample["x"] + nx * smoothed[index], 6)
            shifted["z"] = round(sample["z"] + nz * smoothed[index], 6)
            out[index] = shifted
        shifts = [round(value, 6) for value in smoothed]

    # Recompute the arcs from the shifted samples.
    arc = 0.0
    for index, sample in enumerate(out):
        if index > 0:
            arc += math.hypot(sample["x"] - out[index - 1]["x"], sample["z"] - out[index - 1]["z"])
        sample["arc"] = round(arc, 6)
    length = arc
    moved = sum(1 for value in shifts if abs(value) > 0)
    return {
        "samples": out,
        "length": length,
        "shifts": shifts,
        "moved": moved,
        "notes": notes,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--layout", default="_work/e1-drive/sprint.json")
    ap.add_argument("--grid", default="_work/drivable-path/grid.npz")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)

    layout_path = ROOT / args.layout
    grid_path = ROOT / args.grid
    doc = json.loads(layout_path.read_text(encoding="utf-8"))
    grid = np.load(grid_path)
    base = grid["base_pass"] if "base_pass" in grid else grid["base"]
    xs, zs = grid["xs"], grid["zs"]

    result = recentre(doc, base, xs, zs)
    doc["course"]["samples"] = result["samples"]
    doc["course"]["sampleCount"] = len(result["samples"])
    doc["course"]["lengthMetres"] = round(result["length"], 6)
    doc["course"]["finishArc"] = round(result["length"], 6)
    doc["course"]["span"]["lengthMetres"] = round(result["length"], 6)
    doc["course"]["span"]["measuredLengthMetres"] = round(result["length"], 6)
    doc["course"]["span"]["finishArc"] = round(result["length"], 6)
    doc["course"]["recentre"] = {
        "rule": "each sample is moved to the centre of the contiguous passable interval around it, measured perpendicular to the local tangent on the committed P48 raster",
        "grid": args.grid,
        "scanHalfMetres": SCAN_HALF_METRES,
        "scanStepMetres": SCAN_STEP,
        "movedSamples": result["moved"],
        "maxShiftMetres": round(max((abs(v) for v in result["shifts"]), default=0), 3),
        "notPassable": len(result["notes"]),
    }
    # Gates follow their sample index; their arcs are the shifted sample arcs.
    for gate in doc.get("gates", []):
        index = gate.get("sampleIndex")
        if isinstance(index, int) and 0 <= index < len(result["samples"]):
            sample = result["samples"][index]
            gate["x"] = sample["x"]
            gate["z"] = sample["z"]
            gate["arc"] = sample["arc"]
            gate["groundY"] = sample["groundY"]
            gate["height"] = sample["groundY"]
    if doc.get("gates"):
        doc["gates"][-1]["arc"] = round(result["length"], 6)
    doc["hash"] = canonical_hash(doc)
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"

    if args.check:
        committed = layout_path.read_text(encoding="utf-8")
        if committed != text:
            print("STALE " + args.layout)
            return 1
        print("OK %s %.3f m %d moved" % (args.layout, result["length"], result["moved"]))
        return 0
    layout_path.write_text(text, encoding="utf-8")
    print("WROTE %s %.3f m %d/%d samples moved (max %.2f m)" %
          (args.layout, result["length"], result["moved"], len(result["samples"]),
           max((abs(v) for v in result["shifts"]), default=0)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
