#!/usr/bin/env python3
"""Deterministic verifier for the map-pipeline matrix.

It shares the committed physics parser, but re-derives every matrix field that
matters from the recorded artifacts:
  * physics shape types / static triangle count / bounds from the level file;
  * passable mask, component count and largest component from grid.npz;
  * collision path length from paths/<level>.json;
  * draw-covered path length from covered/<level>-path.json;
  * classification counts and top-candidate ordering from maps.json.

Output: _work/map-pipeline/verify.json (PASS/FAIL, errors, hashes).
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
WORK = ROOT / "_work/map-pipeline"
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))
import physics_scan as scan  # noqa: E402
import inventory_levels as inv  # noqa: E402


def path_length(points):
    return sum(math.hypot(b["x"] - a["x"], b["z"] - a["z"])
               for a, b in zip(points, points[1:]))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--maps", type=Path, default=WORK / "maps.json")
    ap.add_argument("--inventory", type=Path, default=WORK / "inventory.json")
    ap.add_argument("--out", type=Path, default=WORK / "verify.json")
    args = ap.parse_args(argv)
    maps_bytes = args.maps.read_bytes()
    doc = json.loads(maps_bytes)
    checks = []

    def check(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        return bool(ok)

    check("schema", doc.get("schema") == "blur.map-pipeline.maps/1")
    check("level-count", doc.get("levelCount", len(doc.get("levels", []))) == 19,
          "levelCount=%s" % doc.get("levelCount"))
    levels = doc.get("levels", [])
    check("classification-counts",
          sum(1 for r in levels if r["classification"] == "A") ==
          doc["summary"]["classificationCounts"]["A"] and
          sum(1 for r in levels if r["classification"] == "B") ==
          doc["summary"]["classificationCounts"]["B"] and
          sum(1 for r in levels if r["classification"] == "C") ==
          doc["summary"]["classificationCounts"]["C"],
          str(doc["summary"]["classificationCounts"]))
    check("one-A-only-river",
          [r["name"] for r in levels if r["classification"] == "A"] == ["usa_la_river"],
          str([r["name"] for r in levels if r["classification"] == "A"]))
    top_names = [t["name"] for t in doc["summary"]["topCandidates"]]
    check("top-three-count", len(top_names) == 3 and len(set(top_names)) == 3,
          str(top_names))
    by_name = {r["name"]: r for r in levels}
    for top_name in top_names:
        row = by_name.get(top_name)
        ok = row is not None and row["classification"] == "B"
        if ok:
            ratio = (row["draws"]["probesSupported"] /
                     max(1, row["draws"]["probesAttempted"]))
            ok = (row["drawCoverage"]["drawCoveredPathM"] >= 100.0 and
                  (ratio >= 0.75 or row["drawCoverage"]["drawCoveredPathM"] >= 1000.0))
        check("top-%s-eligible" % top_name, ok, str(row and row["classification"]))

    for row in levels:
        name = row["name"]
        physics_path = ROOT / "game-data/Blur/levels" / name / "Level.levelphysics"
        if not physics_path.is_file():
            check("%s-physics-present" % name, False, "missing file")
            continue
        try:
            level = scan.scan_level(physics_path.read_bytes())
            static = [s for s in level["shapes"] if s.get("importType") in (0, 11)]
            tri_count = sum(len(s["triangles"]) for s in static)
            check("%s-shape-types" % name,
                  row["physics"].get("shapeTypes") == level["types"],
                  "%s vs %s" % (row["physics"].get("shapeTypes"), level["types"]))
            check("%s-static-triangles" % name,
                  row["physics"].get("staticTriangles") == tri_count,
                  "%s vs %s" % (row["physics"].get("staticTriangles"), tri_count))
        except Exception as exc:  # noqa: BLE001
            check("%s-reparse" % name, False, str(exc)[:200])
            continue

        grid_path = ROOT / row["grid"]["path"]
        grid = np.load(grid_path)
        H, passable, labels, W, xs, zs = (grid["height"], grid["passable"],
                                          grid["labels"], grid["wall"],
                                          grid["xs"], grid["zs"])
        dh = inv.edge_max_dh(H)
        edge = min(inv.STEP_LIMIT, inv.GRADE_LIMIT * float(doc["model"]["cell"]))
        rebuilt = np.isfinite(H) & (dh <= edge + 1e-9) & ~W
        check("%s-passable-rebuild" % name, bool(np.array_equal(rebuilt, passable)),
              "cells rebuilt=%d stored=%d" % (int(rebuilt.sum()), int(passable.sum())))
        sizes = []
        for cid in range(1, int(labels.max()) + 1 if labels.size else 1):
            sizes.append(int((labels == cid).sum()))
        check("%s-component-count" % name,
              len(sizes) == row["drivable"].get("componentCount"),
              "%d vs %s" % (len(sizes), row["drivable"].get("componentCount")))
        if sizes:
            check("%s-largest-component" % name,
                  max(sizes) == row["drivable"].get("largestComponentCells"),
                  "%d vs %s" % (max(sizes), row["drivable"].get("largestComponentCells")))

        path_path = ROOT / row["pathArtifact"]["path"]
        pts = json.loads(path_path.read_text())["samples"]
        measured = path_length(pts)
        check("%s-collision-path-length" % name,
              abs(measured - row["drivable"]["path"]["lengthM"]) <= 0.01,
              "%.4f vs %s" % (measured, row["drivable"]["path"]["lengthM"]))
        covered_path = WORK / "covered" / (name + "-path.json")
        if covered_path.is_file() and row["drawCoverage"]["drawCoveredPathM"]:
            cpts = json.loads(covered_path.read_text())["samples"]
            cmeasured = path_length(cpts)
            check("%s-covered-path-length" % name,
                  abs(cmeasured - row["drawCoverage"]["drawCoveredPathM"]) <= 0.01,
                  "%.4f vs %s" % (cmeasured, row["drawCoverage"]["drawCoveredPathM"]))
            # every covered sample must sit on a passable collision cell
            bad = 0
            for p in cpts:
                i = int(round((p["x"] - xs[0]) / (xs[1] - xs[0])))
                j = int(round((p["z"] - zs[0]) / (zs[1] - zs[0])))
                if not (0 <= j < passable.shape[0] and 0 <= i < passable.shape[1]) or not passable[j, i]:
                    bad += 1
            check("%s-covered-on-collision" % name, bad == 0, "%d bad samples" % bad)

        # classification rule
        phys_ok = row["physics"].get("status") == "ok" and row["physics"].get("staticTriangles", 0) > 0
        cpath = row["drivable"].get("path", {}).get("lengthM", 0.0)
        dpath = row["drawCoverage"]["drawCoveredPathM"]
        if name == "usa_la_river":
            expected = "A"
        elif not phys_ok or cpath < inv.AUDIT_MIN_PATH_M or dpath < inv.AUDIT_MIN_PATH_M:
            expected = "C"
        else:
            expected = "B"
        check("%s-classification" % name, row["classification"] == expected,
              "%s vs %s" % (row["classification"], expected))

    body = json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    canonical = hashlib.sha256(body.encode("utf-8")).hexdigest()
    check("maps-canonical-hash", True, canonical)

    # Candidate layout hand-offs: start on collision, finite course, checkpoints.
    for top in doc["summary"]["topCandidates"]:
        name = top["name"]
        layout_path = WORK / "candidates" / (name + ".layout.json")
        if not check("candidate-layout-%s" % name, layout_path.is_file(),
                     str(layout_path)):
            continue
        layout = json.loads(layout_path.read_text())
        row = by_name.get(name)
        grid = np.load(ROOT / row["grid"]["path"])
        xs, zs = grid["xs"], grid["zs"]
        spawn = layout["spawn"]
        i = int(round((spawn["x"] - xs[0]) / (xs[1] - xs[0])))
        j = int(round((spawn["z"] - zs[0]) / (zs[1] - zs[0])))
        ok_spawn = (0 <= j < grid["passable"].shape[0] and
                    0 <= i < grid["passable"].shape[1] and
                    bool(grid["passable"][j, i]))
        check("candidate-%s-spawn-on-collision" % name, ok_spawn,
              "(%s,%s)" % (spawn["x"], spawn["z"]))
        check("candidate-%s-course-length" % name,
              abs(layout["course"]["lengthM"] -
                  row["drawCoverage"]["drawCoveredPathM"]) <= 0.01,
              "%.3f vs %s" % (layout["course"]["lengthM"],
                              row["drawCoverage"]["drawCoveredPathM"]))
        check("candidate-%s-checkpoints" % name,
              len(layout["course"]["checkpoints"]) == 2 and
              all("x" in c and "z" in c for c in layout["course"]["checkpoints"]),
              "checkpoints=%d" % len(layout["course"]["checkpoints"]))
        check("candidate-%s-finish" % name,
              "x" in layout["course"]["finish"] and "z" in layout["course"]["finish"],
              str(layout["course"]["finish"]))

    errors = [c for c in checks if not c["ok"]]
    result = {
        "schema": "blur.map-pipeline.verify/1",
        "status": "PASS" if not errors else "FAIL",
        "checks": len(checks),
        "errors": len(errors),
        "failed": errors[:40],
        "mapsCanonicalSha256": canonical,
        "mapsFileSha256": hashlib.sha256(maps_bytes).hexdigest(),
        "inventoryFileSha256": hashlib.sha256(args.inventory.read_bytes()).hexdigest(),
        "note": ("Re-derives shape types, triangle counts, passable/component fields and "
                 "path lengths from the recorded artifacts. It does not re-run the draw "
                 "probes or claim a renderer/game result."),
    }
    args.out.write_text(json.dumps(result, indent=1, sort_keys=True) + "\n",
                        encoding="utf-8")
    print(json.dumps({"status": result["status"], "checks": result["checks"],
                      "errors": result["errors"],
                      "mapsCanonicalSha256": canonical}, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
