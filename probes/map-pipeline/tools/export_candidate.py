#!/usr/bin/env python3
"""Emit a candidate layout artifact for one draw-covered map path.

This is a data hand-off for the e1-drive integration task, not an integration.
It converts the measured draw-covered centre line into the fields a sprint/lap
layout needs: spawn pose, 0.25 m course samples, 1/3 and 2/3 checkpoints, finish,
and a respawn target. No e1-drive file is modified.

Output: _work/map-pipeline/candidates/<level>.layout.json
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


def load(path: Path):
    return json.loads(path.read_text())


def resample(points, step=0.25):
    out = []
    for a, b in zip(points, points[1:]):
        l = math.hypot(b["x"] - a["x"], b["z"] - a["z"])
        n = max(1, int(math.ceil(l / step)))
        for k in range(n):
            t = k / n
            out.append({"x": round(a["x"] + (b["x"] - a["x"]) * t, 4),
                        "z": round(a["z"] + (b["z"] - a["z"]) * t, 4),
                        "h": round(a["h"] + (b["h"] - a["h"]) * t, 4)})
    out.append(dict(points[-1]))
    return out


def heading_at(points, index=8):
    a = points[0]
    b = points[min(index, len(points) - 1)]
    return round(math.atan2(b["x"] - a["x"], b["z"] - a["z"]), 9)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", required=True)
    ap.add_argument("--maps", type=Path, default=WORK / "maps.json")
    ap.add_argument("--out-dir", type=Path, default=WORK / "candidates")
    args = ap.parse_args(argv)
    doc = load(args.maps)
    row = next((r for r in doc["levels"] if r["name"] == args.level), None)
    if row is None:
        raise SystemExit("level not in maps.json: " + args.level)
    covered_path = WORK / "covered" / (args.level + "-path.json")
    if not covered_path.is_file():
        raise SystemExit("missing draw-covered path: " + str(covered_path))
    src = load(covered_path)
    if len(src["samples"]) < 2:
        raise SystemExit("covered path has fewer than 2 samples")
    pts = resample(src["samples"], 0.25)
    total = sum(math.hypot(b["x"] - a["x"], b["z"] - a["z"])
                for a, b in zip(pts, pts[1:]))

    def at_arc(arc):
        acc = 0.0
        for a, b in zip(pts, pts[1:]):
            d = math.hypot(b["x"] - a["x"], b["z"] - a["z"])
            if acc + d >= arc:
                t = (arc - acc) / d if d else 0.0
                return {"x": round(a["x"] + (b["x"] - a["x"]) * t, 4),
                        "z": round(a["z"] + (b["z"] - a["z"]) * t, 4),
                        "h": round(a["h"] + (b["h"] - a["h"]) * t, 4)}
            acc += d
        return dict(pts[-1])

    spawn = dict(pts[0])
    spawn["heading"] = heading_at(pts)
    checkpoints = [at_arc(total / 3.0), at_arc(2.0 * total / 3.0)]
    finish = dict(pts[-1])
    doc_out = {
        "schema": "blur.map-pipeline.candidate-layout/1",
        "level": args.level,
        "status": "candidate-not-integrated",
        "scope": {
            "measuredCollisionPath": True,
            "measuredDrawCoveredPath": True,
            "rendererClaim": False,
            "playableClaim": False,
            "note": "data hand-off for the integration task; no e1-drive file changed",
        },
        "source": {
            "maps": {"path": "_work/map-pipeline/maps.json",
                     "sha256": hashlib.sha256(args.maps.read_bytes()).hexdigest()},
            "coveredPath": {"path": str(covered_path.relative_to(ROOT)).replace("\\", "/"),
                            "sha256": hashlib.sha256(covered_path.read_bytes()).hexdigest()},
        },
        "spawn": {"x": spawn["x"], "z": spawn["z"], "ground": spawn["h"],
                  "heading": spawn["heading"],
                  "headingReason": "first 2 m tangent of the measured draw-covered centre line",
                  "source": "derived from the measured covered path, not an original start line"},
        "course": {
            "lengthM": round(total, 3),
            "sampleStepM": 0.25,
            "points": pts,
            "checkpoints": checkpoints,
            "finish": finish,
        },
        "rules": {
            "respawnTarget": {"x": spawn["x"], "z": spawn["z"]},
            "respawnBandM": 1.25,
            "note": "band is the existing e1-drive declared rule; not a measured lane width",
        },
        "evidence": {
            "collisionPathM": row["drivable"].get("path", {}).get("lengthM"),
            "drawCoveredPathM": row["drawCoverage"]["drawCoveredPathM"],
            "coveredCollisionCells": row["drawCoverage"]["coveredCollisionCells"],
            "supportedSections": row["draws"]["probesSupported"],
            "sectionsProbed": row["draws"]["probesAttempted"],
            "firstRenderListDirectPairs": row["draws"]["firstRenderListDirectPairs"],
        },
    }
    args.out_dir.mkdir(parents=True, exist_ok=True)
    out = args.out_dir / (args.level + ".layout.json")
    out.write_text(json.dumps(doc_out, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"level": args.level, "lengthM": round(total, 3),
                      "samples": len(pts), "out": str(out)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
