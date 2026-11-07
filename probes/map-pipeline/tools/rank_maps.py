#!/usr/bin/env python3
"""Merge inventory + draw coverage evidence into the ranked maps.json matrix.

Inputs:
  _work/map-pipeline/inventory.json       collision/drivable inventory
  _work/map-pipeline/draws.json           native index + first-RenderList pairs
  _work/map-pipeline/draw-probes-all.json native draw probe results
  _work/map-pipeline/covered/<level>.json draw-covered collision path

Output:
  _work/map-pipeline/maps.json            ranked 19-level matrix (deterministic)

Classification is deliberately conservative:
  A  integrated in the existing e1-drive pipeline with a measured, draw-covered
     committed spawn path (currently only usa_la_river; P51 proof exists).
  B  collision parsed, a measured collision path exists, and at least 25 m of a
     draw-covered collision component was measured, but a layout/reader step is
     still required (spawn source, more draw sections, instance traversal...).
  C  blocked with an exact reason: no static triangle mesh, no measured path, or
     no draw-covered collision surface under the extracted first-RenderList
     sections.
No level is claimed playable by this file.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WORK = ROOT / "_work/map-pipeline"
LEVELS_DIR = ROOT / "game-data/Blur/levels"
MIN_B_PATH_M = 25.0


def load(path: Path, default=None):
    if not path.is_file():
        return default
    return json.loads(path.read_text())


def canonical_hash(doc) -> str:
    body = json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def level_kind(name: str) -> str:
    if name == "showroom":
        return "showroom"
    if "multiplayer" in name:
        return "multiplayer"
    return "race"


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--inventory", type=Path, default=WORK / "inventory.json")
    ap.add_argument("--draws", type=Path, default=WORK / "draws.json")
    ap.add_argument("--probes", type=Path, default=WORK / "draw-probes-all.json")
    ap.add_argument("--covered", type=Path, default=WORK / "covered")
    ap.add_argument("--out", type=Path, default=WORK / "maps.json")
    args = ap.parse_args(argv)
    inventory = load(args.inventory)
    if inventory is None:
        raise SystemExit("missing inventory.json; run inventory_levels.py first")
    draws = load(args.draws, {"levels": []})
    probes_all = load(args.probes, {"levels": []})
    probes_top_path = WORK / "draw-probes-top.json"
    probes_top = load(probes_top_path, {"levels": []})
    probes_extra = load(WORK / "draw-probes-extra.json", {"levels": []})
    probe_by_level = {r["level"]: r for r in probes_all.get("levels", [])}
    for group in (probes_top, probes_extra):
        for r in group.get("levels", []):
            old = probe_by_level.get(r["level"])
            if old is None or len(r.get("probes", [])) > len(old.get("probes", [])):
                probe_by_level[r["level"]] = r
    draw_by_level = {r["level"]: r for r in draws.get("levels", [])}

    rows = []
    for base in inventory["levels"]:
        name = base["name"]
        row = {
            "name": name,
            "kind": level_kind(name),
            "files": base.get("files", {}),
            "physics": base.get("physics", {}),
            "drivable": base.get("drivable", {}),
            "grid": base.get("grid"),
            "pathArtifact": base.get("pathArtifact"),
        }
        draw = draw_by_level.get(name, {})
        probe = probe_by_level.get(name, {})
        covered = load(args.covered / (name + ".json"), {}) or {}
        probe_ok = [p for p in probe.get("probes", []) if p.get("status") == "ok"]
        probe_bad = [p for p in probe.get("probes", []) if p.get("status") != "ok"]
        row["draws"] = {
            "nativeIndex": draw.get("nativeIndex"),
            "firstRenderListDirectPairs": draw.get("correlatedPairCount", 0),
            "estimatedTriangles": draw.get("correlatedPairTriangleEstimate", 0),
            "nodeChunksParsed": draw.get("reader", {}).get("nodeChunksParsed"),
            "geometryBlocks": draw.get("reader", {}).get("geometryBlocks"),
            "probesAttempted": len(probe.get("probes", [])),
            "probesSupported": len(probe_ok),
            "probesUnsupported": len(probe_bad),
            "supportedTriangles": sum(p.get("triangleCount", 0) for p in probe_ok),
            "supportedDraws": sum(p.get("drawCount", 0) for p in probe_ok),
            "unsupportedReasons": sorted({p.get("error", "")[:160] for p in probe_bad}),
            "instancesApplied": False,
        }
        row["drawCoverage"] = {
            "coveredCollisionCells": covered.get("coveredPassableCells", 0),
            "passableCells": covered.get("passableCells", 0),
            "coverageOfPassable": covered.get("coverageOfPassable", 0.0),
            "drawTriangles": covered.get("drawTriangles", 0),
            "coveredComponents": covered.get("componentCount", 0),
            "drawCoveredPathM": covered.get("path", {}).get("lengthM", 0.0),
            "drawCoveredPathStart": covered.get("path", {}).get("start"),
            "drawCoveredPathEnd": covered.get("path", {}).get("end"),
            "drawCoveredPathArtifact": covered.get("path", {}).get("artifact"),
            "hardErrors": covered.get("hardErrors", []),
        }
        row["missingData"] = []
        if name != "usa_la_river":
            row["missingData"].append(
                "original spawn/start-line record: level files expose none; measured "
                "candidate is a derived component endpoint")
            row["missingData"].append(
                "level material/shader/texture binding: native level draws are diagnostic "
                "(no albedo/sampler upload); only the River g56/P73a-P75 subset has "
                "proven UV0/albedo bindings")
        if row["draws"]["probesUnsupported"]:
            row["missingData"].append(
                "%d/%d probed first-RenderList sections use unsupported position vertex "
                "formats" % (row["draws"]["probesUnsupported"],
                             row["draws"]["probesAttempted"]))
        if row["physics"].get("fluidMeshCount"):
            row["missingData"].append(
                "%d fluid mesh(es) parsed and excluded from drivable surface; fluid payload "
                "is not collision road" % row["physics"]["fluidMeshCount"])
        if row["physics"].get("compositeSubMeshCount"):
            row["missingData"].append(
                "%d composite sub-mesh(es) are counted but not transformed/applied; only "
                "top-level static triangle meshes are used" %
                row["physics"]["compositeSubMeshCount"])
        if row["draws"]["firstRenderListDirectPairs"] > row["draws"]["probesAttempted"]:
            row["missingData"].append(
                "only %d of %d first-RenderList correlated pairs were probed; the rest are "
                "not yet extracted" % (row["draws"]["probesAttempted"],
                                       row["draws"]["firstRenderListDirectPairs"]))
        if not row["drawCoverage"]["drawCoveredPathM"]:
            row["missingData"].append(
                "no draw-covered collision component among the extracted sections")

        physics_ok = row["physics"].get("status") == "ok" and row["physics"].get("staticTriangles", 0) > 0
        collision_path = row["drivable"].get("path", {}).get("lengthM", 0.0)
        draw_path = row["drawCoverage"]["drawCoveredPathM"]
        if draw_path < MIN_B_PATH_M:
            if row["draws"]["probesUnsupported"]:
                row["missingData"].append(
                    "blocker detail: %d supported section(s) cover only %.1f m of collision "
                    "surface; %d section(s) stop on unsupported position formats" % (
                        row["draws"]["probesSupported"], draw_path,
                        row["draws"]["probesUnsupported"]))
            else:
                row["missingData"].append(
                    "blocker detail: all %d probed first-RenderList sections are readable but "
                    "cover only %.1f m of collision surface; the drivable surface needs an "
                    "instance/other-block traversal or a different draw pass" % (
                        row["draws"]["probesSupported"], draw_path))
        if name == "usa_la_river":
            row["classification"] = "A"
            row["blocker"] = None
            row["classificationReason"] = (
                "integrated e1-drive level: committed spawn (-88,1050), measured 328.1 m "
                "collision path at 1 m audit cell, and P51's committed proof covers the "
                "310.395 m course 100% at centre, envelope and +0.30 m margin")
        elif not physics_ok:
            row["classification"] = "C"
            row["blocker"] = row["physics"].get("error") or "no top-level static triangle mesh"
            row["classificationReason"] = "collision reader/format blocker"
        elif collision_path < MIN_B_PATH_M:
            row["classification"] = "C"
            row["blocker"] = "measured collision path %.1f m < %.0f m" % (
                collision_path, MIN_B_PATH_M)
            row["classificationReason"] = "no usable collision course"
        elif draw_path < MIN_B_PATH_M:
            row["classification"] = "C"
            row["blocker"] = (
                "no draw-covered collision path >= %.0f m under the extracted "
                "first-RenderList sections (best %.1f m)" % (MIN_B_PATH_M, draw_path))
            row["classificationReason"] = "draw coverage blocker"
        else:
            row["classification"] = "B"
            row["blocker"] = None
            row["classificationReason"] = (
                "collision and a %.1f m draw-covered component measured; needs a committed "
                "spawn/course layout and %d more extracted sections" %
                (draw_path, max(0, row["draws"]["firstRenderListDirectPairs"] -
                                row["draws"]["probesAttempted"])))

        # Ranking score for B candidates: measured draw-covered length, how much
        # of the collision diameter is draw-covered (completeness), reader
        # success, and simplicity. This is a prioritisation heuristic, not a
        # playability claim.
        supported_ratio = (row["draws"]["probesSupported"] /
                           max(1, row["draws"]["probesAttempted"]))
        coverage_fraction = row["drawCoverage"]["coverageOfPassable"]
        pairs_covered = (row["draws"]["probesAttempted"] /
                         max(1, row["draws"]["firstRenderListDirectPairs"]))
        completeness = min(1.0, draw_path / max(1e-6, collision_path))
        row["drawCoverage"]["completenessOfCollisionPath"] = round(completeness, 6)
        row["rankScore"] = round(
            0.4 * draw_path
            + 500.0 * completeness
            + 120.0 * supported_ratio
            + 30.0 * min(1.0, pairs_covered)
            - 0.0015 * row["physics"].get("staticTriangles", 0)
            - 1.0 * row["draws"]["firstRenderListDirectPairs"], 3)
        rows.append(row)

    order = {"A": 0, "B": 1, "C": 2}
    rows.sort(key=lambda r: (order[r["classification"]], -r["rankScore"], r["name"]))
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank

    counts = {k: sum(1 for r in rows if r["classification"] == k) for k in "ABC"}
    by_name = {r["name"]: r for r in rows}
    curated = ["usa_amboy", "spa_barcelona_gracia", "usa_la_longbeachdocks"]
    candidates = [by_name[n] for n in curated if n in by_name and
                  by_name[n]["classification"] == "B"]
    # Fallback: if a curated name is not B, take the best eligible B candidates.
    if len(candidates) < 3:
        eligible = []
        for r in rows:
            if r["classification"] != "B" or r["kind"] == "showroom":
                continue
            supported_ratio = (r["draws"]["probesSupported"] /
                               max(1, r["draws"]["probesAttempted"]))
            if r["drawCoverage"]["drawCoveredPathM"] >= 100.0 and supported_ratio >= 0.75:
                eligible.append(r)
        for r in eligible:
            if len(candidates) >= 3:
                break
            if r not in candidates:
                candidates.append(r)
    top = []
    for row in candidates:
        top.append({
            "name": row["name"],
            "kind": row["kind"],
            "rankScore": row["rankScore"],
            "drawCoveredPathM": row["drawCoverage"]["drawCoveredPathM"],
            "collisionPathM": row["drivable"].get("path", {}).get("lengthM"),
            "coveredCells": row["drawCoverage"]["coveredCollisionCells"],
            "supportedSections": row["draws"]["probesSupported"],
            "firstRenderListDirectPairs": row["draws"]["firstRenderListDirectPairs"],
            "staticTriangles": row["physics"].get("staticTriangles"),
            "missingData": row["missingData"],
            "why": (
                "measured %.1f m draw-covered collision component, %.1f%% of the %.1f m "
                "collision diameter, %.0f m2 covered, %d/%d probed sections supported, "
                "%d/%d correlated pairs attempted" % (
                    row["drawCoverage"]["drawCoveredPathM"],
                    100.0 * row["drawCoverage"].get("completenessOfCollisionPath", 0.0),
                    row["drivable"].get("path", {}).get("lengthM", 0.0),
                    row["drawCoverage"]["coveredCollisionCells"],
                    row["draws"]["probesSupported"], row["draws"]["probesAttempted"],
                    row["draws"]["probesAttempted"],
                    row["draws"]["firstRenderListDirectPairs"])),
        })

    doc = {
        "schema": "blur.map-pipeline.maps/1",
        "scope": {
            "collisionOnly": True,
            "drawGeometryRead": True,
            "drawScope": "first RenderList direct LOD0 geometry only; instancesApplied:false",
            "rendererClaim": False,
            "engineClaim": False,
            "playableClaim": False,
            "note": ("Ranked content audit. A means integrated in e1-drive with a proven "
                     "committed course, not that the matrix rendered a frame. B/C are "
                     "candidates/blockers for the next integration wave."),
        },
        "model": inventory.get("model"),
        "inputs": {
            "inventory": {"path": "_work/map-pipeline/inventory.json",
                          "sha256": hashlib.sha256(args.inventory.read_bytes()).hexdigest()},
            "draws": {"path": "_work/map-pipeline/draws.json",
                      "sha256": hashlib.sha256(args.draws.read_bytes()).hexdigest()},
            "drawProbes": {"path": "_work/map-pipeline/draw-probes-all.json",
                           "sha256": hashlib.sha256(args.probes.read_bytes()).hexdigest()},
            "drawProbesTop": ({"path": "_work/map-pipeline/draw-probes-top.json",
                               "sha256": hashlib.sha256(probes_top_path.read_bytes()).hexdigest()}
                              if probes_top_path.is_file() else None),
            "drawProbesExtra": ({"path": "_work/map-pipeline/draw-probes-extra.json",
                                 "sha256": hashlib.sha256((WORK / "draw-probes-extra.json").read_bytes()).hexdigest()}
                                if (WORK / "draw-probes-extra.json").is_file() else None),
        },
        "summary": {
            "levelCount": len(rows),
            "classificationCounts": counts,
            "integrated": [r["name"] for r in rows if r["classification"] == "A"],
            "needsLayoutOrReader": [r["name"] for r in rows if r["classification"] == "B"],
            "blocked": [{"name": r["name"], "reason": r["blocker"]}
                        for r in rows if r["classification"] == "C"],
            "topCandidates": top,
            "selectionRule": (
                "curated for the next integration wave: measure a draw-covered path, "
                "then prefer (a) the longest measured draw-covered route, (b) near-complete "
                "draw coverage of the collision diameter, (c) high native section support "
                "with a low collision triangle count. A close fourth is "
                "spa_barcelona_oval (786.1 m, simple oval, 31/56 sections supported)."),
        },
        "levels": rows,
    }
    body = json.dumps(doc, indent=1, sort_keys=True) + "\n"
    args.out.write_text(body, encoding="utf-8")
    print(json.dumps({"counts": counts, "top": [t["name"] for t in top],
                      "sha256": hashlib.sha256(body.encode()).hexdigest()}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
