#!/usr/bin/env python3
"""Draw-coverage test for one measured map path.

Inputs (read-only):
  _work/map-pipeline/paths/<level>.json       measured collision path
  _work/map-pipeline/grids/<level>.npz        collision height raster
  _work/map-pipeline/probes/<level>-*/native.json  extracted first RenderList draws

Rule (same as track-coverage/P51):
  * a draw triangle is only used when it lies inside a declared
    firstIndex .. firstIndex+indexCount range; a triangle outside every draw is
    a hard error, never a silent vertex-array draw;
  * collision height = highest up-facing grid sample below the point;
  * visual height = draw triangle containing the point whose height is nearest
    the collision height;
  * covered = |visual - collision| <= 0.5 m.
Three lateral stations are tested: centre and +/-1.0 m in the path frame.

No renderer, material, texture, GPU or playable claim is made.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
WORK = ROOT / "_work/map-pipeline"
TOLERANCE = 0.5
SAMPLE_STEP = 0.25
LATERAL = (0.0, -1.0, 1.0)


def load_triangles(level: str):
    tris = []
    meta = []
    hard_errors = []
    for native_path in sorted((WORK / "probes").glob(level + "-*/native.json")):
        doc = json.loads(native_path.read_text())
        if doc.get("status") != "ok":
            hard_errors.append({"file": native_path.name, "error": "native not ok"})
            continue
        pos = np.asarray(doc["positions"], dtype=np.float64).reshape(-1, 3)
        idx = np.asarray(doc["indices"], dtype=np.int64)
        used = np.zeros(len(idx) // 3, dtype=bool)
        for draw_index, draw in enumerate(doc["draws"]):
            first = int(draw["firstIndex"])
            count = int(draw["indexCount"])
            if first < 0 or count % 3 or first + count > len(idx):
                hard_errors.append({"file": native_path.name, "draw": draw_index,
                                    "error": "draw range outside index buffer"})
                continue
            for at in range(first, first + count, 3):
                tri_index = at // 3
                used[tri_index] = True
                a, b, c = pos[idx[at]], pos[idx[at + 1]], pos[idx[at + 2]]
                tris.append((a, b, c))
                meta.append((native_path.parent.name, draw_index, at))
        if not used.all():
            hard_errors.append({"file": native_path.name,
                                "error": "%d triangles outside every draw range" %
                                         int((~used).sum())})
    return np.asarray(tris, dtype=np.float64), meta, hard_errors


def bucket_triangles(tris, cell=4.0):
    buckets = {}
    for k, t in enumerate(tris):
        x0 = math.floor(min(t[0][0], t[1][0], t[2][0]) / cell)
        x1 = math.floor(max(t[0][0], t[1][0], t[2][0]) / cell)
        z0 = math.floor(min(t[0][2], t[1][2], t[2][2]) / cell)
        z1 = math.floor(max(t[0][2], t[1][2], t[2][2]) / cell)
        for bx in range(x0, x1 + 1):
            for bz in range(z0, z1 + 1):
                buckets.setdefault((bx, bz), []).append(k)
    return buckets, cell


def visual_height(px, pz, tris, buckets, cell, ch):
    bx = math.floor(px / cell)
    bz = math.floor(pz / cell)
    best = None
    best_delta = None
    best_tri = None
    for k in buckets.get((bx, bz), ()):
        a, b, c = tris[k]
        den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
        if abs(den) < 1e-12:
            continue
        l1 = ((b[2] - c[2]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[2])) / den
        l2 = ((c[2] - a[2]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[2])) / den
        l3 = 1.0 - l1 - l2
        if l1 < -1e-9 or l2 < -1e-9 or l3 < -1e-9:
            continue
        h = l1 * a[1] + l2 * b[1] + l3 * c[1]
        d = abs(h - ch)
        if best_delta is None or d < best_delta:
            best_delta = d
            best = h
            best_tri = k
    return best, best_delta, best_tri


def resample(path):
    pts = []
    for a, b in zip(path, path[1:]):
        l = math.hypot(b["x"] - a["x"], b["z"] - a["z"])
        n = max(1, int(math.ceil(l / SAMPLE_STEP)))
        for k in range(n):
            t = k / n
            pts.append((a["x"] + (b["x"] - a["x"]) * t,
                        a["z"] + (b["z"] - a["z"]) * t))
    if path:
        pts.append((path[-1]["x"], path[-1]["z"]))
    return pts


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", required=True)
    ap.add_argument("--path", type=Path)
    ap.add_argument("--grid", type=Path)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args(argv)
    path_path = args.path or (WORK / "paths" / (args.level + ".json"))
    grid_path = args.grid or (WORK / "grids" / (args.level + ".npz"))
    out = args.out or (WORK / "coverage" / (args.level + ".json"))
    path_doc = json.loads(path_path.read_text())
    grid = np.load(grid_path)
    H, xs, zs = grid["height"], grid["xs"], grid["zs"]
    tris, meta, hard_errors = load_triangles(args.level)
    if len(tris) == 0:
        raise SystemExit("no extracted draw triangles for " + args.level)
    buckets, bcell = bucket_triangles(tris)
    path = path_doc["samples"]
    samples = resample(path)
    stations = []
    covered_total = 0
    station_total = 0
    covered_by_stage = {}
    deltas = []
    gaps = []
    current_gap = None
    for si, (px, pz) in enumerate(samples):
        # path heading from the previous sample
        if si == 0 and len(samples) > 1:
            hx, hz = samples[1][0] - px, samples[1][1] - pz
        elif si == len(samples) - 1 and len(samples) > 1:
            hx, hz = px - samples[si - 1][0], pz - samples[si - 1][1]
        elif len(samples) > 1:
            hx, hz = samples[si + 1][0] - samples[si - 1][0], samples[si + 1][1] - samples[si - 1][1]
        else:
            hx, hz = 1.0, 0.0
        hl = math.hypot(hx, hz) or 1.0
        nx, nz = -hz / hl, hx / hl
        i = int(round((px - xs[0]) / (xs[1] - xs[0])))
        j = int(round((pz - zs[0]) / (zs[1] - zs[0])))
        if not (0 <= j < H.shape[0] and 0 <= i < H.shape[1]):
            continue
        ch = float(H[j, i])
        if not math.isfinite(ch):
            continue
        for lateral in LATERAL:
            qx, qz = px + nx * lateral, pz + nz * lateral
            vh, delta, tri = visual_height(qx, qz, tris, buckets, bcell, ch)
            station_total += 1
            if delta is not None and delta <= TOLERANCE:
                covered_total += 1
                stage = meta[tri][0]
                covered_by_stage[stage] = covered_by_stage.get(stage, 0) + 1
                deltas.append(delta)
            elif lateral == 0.0:
                if current_gap is None:
                    current_gap = {"start": [round(qx, 3), round(qz, 3)],
                                   "samples": 0}
                current_gap["samples"] += 1
                current_gap["end"] = [round(qx, 3), round(qz, 3)]
            if lateral == 0.0 and delta is not None:
                stations.append(delta)
        if current_gap is not None and current_gap["samples"] and si < len(samples) - 1:
            # close the gap when the next centre sample is covered
            qx, qz = samples[si + 1]
            vh, delta, tri = visual_height(qx, qz, tris, buckets, bcell, ch)
            if delta is not None and delta <= TOLERANCE:
                current_gap["metres"] = round(current_gap["samples"] * SAMPLE_STEP, 3)
                gaps.append(current_gap)
                current_gap = None
    if current_gap is not None:
        current_gap["metres"] = round(current_gap["samples"] * SAMPLE_STEP, 3)
        gaps.append(current_gap)
    doc = {
        "schema": "blur.map-pipeline.coverage/1",
        "level": args.level,
        "inputs": {
            "path": str(path_path.relative_to(ROOT)).replace("\\", "/"),
            "pathSha256": hashlib.sha256(path_path.read_bytes()).hexdigest(),
            "grid": str(grid_path.relative_to(ROOT)).replace("\\", "/"),
            "gridSha256": hashlib.sha256(grid_path.read_bytes()).hexdigest(),
            "nativeProbes": sorted(p.name for p in (WORK / "probes").glob(args.level + "-*")),
        },
        "model": {"toleranceM": TOLERANCE, "sampleStepM": SAMPLE_STEP,
                  "lateralStationsM": list(LATERAL),
                  "rule": "covered = nearest draw triangle |visual-collision| <= 0.5 m"},
        "drawTriangles": int(len(tris)),
        "drawSources": len(set(m[0] for m in meta)),
        "hardErrors": hard_errors,
        "coverage": {
            "samples": len(samples),
            "stationTests": station_total,
            "coveredStations": covered_total,
            "fraction": round(covered_total / station_total, 6) if station_total else 0.0,
            "centreSamplesWithDraw": len(stations),
            "centreDeltaMin": round(min(stations), 6) if stations else None,
            "centreDeltaMax": round(max(stations), 6) if stations else None,
            "gapRuns": len(gaps),
            "gapMetres": round(sum(g["metres"] for g in gaps), 3),
            "gaps": gaps[:40],
            "coveredByStage": covered_by_stage,
        },
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"level": args.level, "triangles": len(tris),
                      "coverage": doc["coverage"]["fraction"],
                      "gaps": doc["coverage"]["gapRuns"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
