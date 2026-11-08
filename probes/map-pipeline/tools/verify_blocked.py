#!/usr/bin/env python3
"""Deterministic verifier for the 19-map blocked inventory and the three
extended-extraction probes.

Re-derives every number from the source files:
  game-data/Blur/levels/<name>/Level.levelphysics  (re-parsed shape stream)
  game-data/Blur/levels/<name>/Level.levelrender
  _work/map-pipeline/maps.json
  _work/map-pipeline/inventory.json
  _work/map-pipeline/draw-probes-all.json
  _work/map-pipeline/node-inventory.json
  _work/map-pipeline/<level>-probe/probe.json
  _work/map-slice/<package>/render.json + blockers.json

Output: _work/map-pipeline/blocked/verify.json

No renderer, GPU, browser, engine or playable claim is made.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WORK = ROOT / "_work/map-pipeline"
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
import physics_scan as scan  # noqa: E402
import inventory_levels as inv  # noqa: E402

LEVEL_FILES = {
    "level": "Level.level",
    "physics": "Level.levelphysics",
    "render": "level.levelrender",
    "stream": "Level.levelstream",
}
PROBE_DIRS = {
    "usa_la_longbeachdocks": "usa_la_longbeachdocks-probe",
    "spa_barcelona_bowl_multiplayer": "spa_barcelona_bowl_multiplayer-probe",
    "usa_la_multiplayer_highrise": "usa_la_multiplayer_highrise-probe",
}
PLAYABLE = {"usa_la_river", "usa_amboy", "spa_barcelona_gracia", "usa_la_longbeachdocks",
            "usa_la_observatory", "usa_la_downtown", "jpn_mharuna",
            "usa_la_multiplayer_highrise", "jpn_tokyo_shutoko",
            "spa_barcelona_oval", "usa_amboy_multiplayer",
            "usa_ny_dumbo", "usa_la_downtown_multiplayer"}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--inventory", type=Path,
                    default=WORK / "blocked/inventory-19.json")
    ap.add_argument("--out", type=Path, default=WORK / "blocked/verify.json")
    args = ap.parse_args(argv)

    doc = json.loads(args.inventory.read_text())
    maps = json.loads((WORK / "maps.json").read_text())
    inventory = json.loads((WORK / "inventory.json").read_text())
    draws = json.loads((WORK / "draw-probes-all.json").read_text())
    draws_extra = json.loads((WORK / "draw-probes-extra.json").read_text())
    nodes = json.loads((WORK / "node-inventory.json").read_text())
    maps_by = {row["name"]: row for row in maps["levels"]}
    inv_by = {row["name"]: row for row in inventory["levels"]}
    draws_by = {row["level"]: row for row in draws["levels"]}
    for level in draws_extra["levels"]:
        if len(level.get("probes", [])) == level.get("pairCount"):
            draws_by[level["level"]] = level
    nodes_by = {row["level"]: row for row in nodes["levels"]}

    checks = []
    failures = []

    def check(name, condition, detail=""):
        checks.append({"name": name, "pass": bool(condition), "detail": detail})
        if not condition:
            failures.append({"name": name, "detail": detail})

    # ------------------------------------------------------------- global
    check("schema", doc.get("schema") == "blur.map-pipeline.blocked-inventory/1",
          str(doc.get("schema")))
    rows = doc["levels"]
    check("level count is 19", len(rows) == 19, str(len(rows)))
    names = [row["level"] for row in rows]
    check("level names unique", len(set(names)) == len(names))
    check("level set equals maps.json", set(names) == set(maps_by))
    check("level set equals inventory.json", set(names) == set(inv_by))
    check("level set equals draw-probes-all.json", set(names) == set(draws_by))
    grade_counts = {grade: sum(1 for row in rows if row["committedGrade"] == grade)
                    for grade in ("A", "B", "C")}
    check("committed grade counts A/B/C = 1/16/2", grade_counts == {"A": 1, "B": 16, "C": 2},
          json.dumps(grade_counts))
    check("playable set is river/amboy/gracia",
          set(doc["summary"]["playableToday"]) == PLAYABLE,
          str(doc["summary"]["playableToday"]))
    check("nextThree has three entries", len(doc["nextThree"]) == 3)
    # The next three are the highest-ranked rows that are not playable today.
    blocked_ranked = [row["level"] for row in sorted(rows, key=lambda row: row["distanceRank"])
                      if row["level"] not in PLAYABLE]
    check("nextThree is the top three non-playable rows",
          doc["nextThree"] == blocked_ranked[:3],
          str(doc["nextThree"]))
    ranks = sorted(row["distanceRank"] for row in rows)
    check("distance ranks are 1..19", ranks == list(range(1, 20)), str(ranks[:5]))
    check("ranking rule text present", "distinct engineering items" in doc["rankingRule"])

    # source hashes
    for key, path in (("maps", WORK / "maps.json"),
                      ("inventory", WORK / "inventory.json"),
                      ("draws", WORK / "draw-probes-all.json"),
                      ("nodeInventory", WORK / "node-inventory.json"),
                      ("mapRegistry", ROOT / "probes/e1-drive/web/map-registry.js")):
        source = doc["sources"].get(key)
        check("source hash " + key, source is not None and source["sha256"] == sha256(path),
              "" if source is None else source.get("sha256", ""))

    # ----------------------------------------------------------- per level
    physics_cache = {}
    for row in rows:
        name = row["level"]
        m = maps_by[name]
        i = inv_by[name]
        d = draws_by[name]
        n = nodes_by[name]

        check(name + " file hashes: level", row["files"]["level"]["sha256"] ==
              sha256(ROOT / "game-data/Blur/levels" / name / LEVEL_FILES["level"]))
        for file_key in ("physics", "render", "stream"):
            check(name + " file hashes: " + file_key,
                  row["files"][file_key]["sha256"] ==
                  sha256(ROOT / "game-data/Blur/levels" / name / LEVEL_FILES[file_key]))
            check(name + " file bytes: " + file_key,
                  row["files"][file_key]["bytes"] ==
                  (ROOT / "game-data/Blur/levels" / name / LEVEL_FILES[file_key]).stat().st_size)

        if name not in physics_cache:
            data = (ROOT / "game-data/Blur/levels" / name / LEVEL_FILES["physics"]).read_bytes()
            level = scan.scan_level(data)
            tris, per_mesh = inv.flatten_top_level(level)
            physics_cache[name] = (tris, per_mesh)
        tris, per_mesh = physics_cache[name]
        check(name + " re-parsed physics triangles", int(len(tris)) == row["collisionTriangles"],
              "%d vs %d" % (len(tris), row["collisionTriangles"]))
        check(name + " inventory.json triangles agree",
              i["physics"]["staticTriangles"] == row["collisionTriangles"])
        check(name + " triangle bounds min",
              [round(float(v), 6) for v in tris.reshape(-1, 3).min(axis=0)] ==
              [round(float(v), 6) for v in row["collisionBounds"]["min"]])
        check(name + " triangle bounds max",
              [round(float(v), 6) for v in tris.reshape(-1, 3).max(axis=0)] ==
              [round(float(v), 6) for v in row["collisionBounds"]["max"]])
        check(name + " top-level static mesh count",
              sum(1 for mesh in per_mesh) == i["physics"]["topLevelStaticMeshCount"])

        check(name + " pair count agrees", row["firstRenderListPairs"] == d["pairCount"],
              "%d vs %d" % (row["firstRenderListPairs"], d["pairCount"]))
        ok_count = sum(1 for probe in d["probes"] if probe["status"] == "ok")
        bad_count = sum(1 for probe in d["probes"] if probe["status"] != "ok")
        check(name + " supported sections agree", row["supportedSections"] == ok_count)
        check(name + " unsupported sections agree", row["unsupportedSections"] == bad_count)
        check(name + " supported + unsupported == pairs",
              row["supportedSections"] + row["unsupportedSections"] == row["firstRenderListPairs"])
        check(name + " supported draws agree", row["supportedDraws"] == m["draws"]["supportedDraws"])
        check(name + " supported draw triangles agree",
              row["supportedDrawTriangles"] == m["draws"]["supportedTriangles"])
        check(name + " collision path agrees",
              row["collisionPathM"] == m["drivable"]["path"]["lengthM"])
        check(name + " draw-covered path agrees",
              row["drawCoveredPathM"] == m["drawCoverage"]["drawCoveredPathM"])
        check(name + " coverage is draw/col",
              row["coverageOfCollisionPath"] ==
              round(min(1.0, row["drawCoveredPathM"] / row["collisionPathM"]), 6))
        check(name + " covered cells <= passable cells",
              row["coveredCells"] <= row["passableCells"])
        check(name + " committed grade agrees", row["committedGrade"] == m["classification"])
        expected_grade = ("A" if name == "usa_la_river" else
                          "C" if row["drawCoveredPathM"] < 25.0 else "B")
        check(name + " grade rule recomputes", row["committedGrade"] == expected_grade,
              "%s vs %s" % (row["committedGrade"], expected_grade))
        path_file = ROOT / row["pathArtifact"]["path"]
        check(name + " path artifact exists", path_file.is_file())
        path_doc = json.loads(path_file.read_text())
        check(name + " path artifact samples",
              row["pathArtifact"]["samples"] == len(path_doc["samples"]))
        xs = [sample["x"] for sample in path_doc["samples"]]
        zs = [sample["z"] for sample in path_doc["samples"]]
        check(name + " path artifact bbox",
              row["pathArtifact"]["bbox"] == [min(xs), max(xs), min(zs), max(zs)])
        check(name + " path artifact actual hash",
              row["pathArtifact"]["actualSha256"] == sha256(path_file))
        if row.get("coveredArtifact"):
            check(name + " covered artifact exists", (ROOT / row["coveredArtifact"]).is_file())
            covered_doc = json.loads((WORK / "covered" / (name + ".json")).read_text())
            artifact = covered_doc["path"]["artifact"]
            check(name + " covered path pin",
                  covered_doc["path"]["artifactSha256"] == sha256(ROOT / artifact))
            check(name + " covered artifact path agrees",
                  row["coveredArtifact"] == artifact)
        else:
            check(name + " covered path absent for no-coverage map",
                  row["drawCoveredPathM"] == 0.0)
        check(name + " grid exists", (ROOT / row["grid"]["path"]).is_file())
        check(name + " grid hash", row["grid"]["sha256"] == sha256(ROOT / row["grid"]["path"]))
        check(name + " instance descriptions agree",
              row["instancesMeasured"] == n["instances"].get("descriptions"))
        check(name + " instance node chunks agree",
              row["instanceNodeChunksWithInstances"] == n["instances"].get("nodesWithInstances"))
        check(name + " skipped block refs agree",
              row["skippedBlockRefs"] == n["skippedBlockRefs"])
        check(name + " playable flag agrees", row["playableToday"] == (name in PLAYABLE))
        check(name + " distance item count", row["playableDistanceCount"] ==
              len(row["playableDistanceItems"]))
        if name in PLAYABLE:
            check(name + " playable distance is zero", row["playableDistanceCount"] == 0)
        else:
            check(name + " blocked has a single blocker",
                  isinstance(row["singleBlocker"], str) and len(row["singleBlocker"]) > 0)
        check(name + " limiter set", isinstance(row["limiter"], str) and len(row["limiter"]) > 0)
        check(name + " distance rank is bounded", 1 <= row["distanceRank"] <= 19)

        package_expected = name in {"usa_amboy", "spa_barcelona_gracia", "usa_la_longbeachdocks"}
        check(name + " texture package presence",
              (row["texturePackage"] is not None) == package_expected)
        if row["texturePackage"]:
            render_file = ROOT / row["texturePackage"]["source"]
            render = json.loads(render_file.read_text())
            check(name + " texture package hash",
                  row["texturePackage"]["sourceSha256"] == sha256(render_file))
            check(name + " bindable draws agree",
                  row["texturePackage"]["bindableDraws"] == render["counts"]["bindableDraws"])
            check(name + " blocked draws agree",
                  row["texturePackage"]["blockedDraws"] == render["counts"]["blockedDraws"])

    # ------------------------------------------------------- probe checks
    probe_thresholds = {
        "usa_la_longbeachdocks": {"sections": 223, "triangles": 1143507,
                                  "newSections": 149, "newTriangles": 606213},
        "spa_barcelona_bowl_multiplayer": {"sections": 25, "triangles": 185267,
                                           "newSections": 22, "newTriangles": 164621},
        "usa_la_multiplayer_highrise": {"sections": 45, "triangles": 161464,
                                         "newSections": 38, "newTriangles": 146277},
    }
    for name, expected in probe_thresholds.items():
        row = next(item for item in rows if item["level"] == name)
        probe = row["extendedProbe"]
        check(name + " extended probe present", probe is not None)
        if not probe:
            continue
        probe_file = ROOT / probe["file"]
        check(name + " extended probe hash", probe["sha256"] == sha256(probe_file))
        source = json.loads(probe_file.read_text())
        ok_rows = [item for item in source["sections"] if item["status"] == "ok"]
        new_rows = {(item["chunk"], item["item"]): item for item in ok_rows
                    if "nativeValidation" not in item}
        check(name + " probe section count", probe["sections"] == len(ok_rows))
        check(name + " probe triangle sum", probe["triangles"] ==
              sum(item["triangles"] for item in ok_rows))
        check(name + " probe vertex sum", probe["vertices"] ==
              sum(item["vertices"] for item in ok_rows))
        check(name + " probe draw sum", probe["draws"] == sum(item["draws"] for item in ok_rows))
        check(name + " probe new section count", probe["newSections"] == len(new_rows))
        check(name + " probe new triangle sum", probe["newTriangles"] ==
              sum(item["triangles"] for item in new_rows.values()))
        # Coverage is re-derived from the probe document itself (the producer's
        # output) rather than from `extendedProbe`, which is only a mirror and
        # was missing `newOnlyCoverageFraction` until the inventory was rebuilt.
        # The documented invariant (docs/work/analysis/map-pipeline-blocked.md
        # §4.2, §5.2) is that the extended extraction as a whole covers 100 % of
        # the committed collision path, on all triangles and on up-facing
        # triangles only. `newSectionsOnly` is a subset view: the same stations
        # tested against only the newly extracted (non-committed) sections, so it
        # must be a consistent subset, not 100 % (Longbeach 0.598021; the
        # committed sections carry the remaining stations).
        coverage = source["coverage"]
        all_cov = coverage["allTriangles"]
        up_cov = coverage["upFacingTriangles"]
        new_cov = coverage["newSectionsOnly"]
        check(name + " probe coverage fraction 1.0",
              all_cov["fraction"] == 1.0, str(all_cov["fraction"]))
        check(name + " probe up-facing coverage 1.0",
              up_cov["fraction"] == 1.0, str(up_cov["fraction"]))
        check(name + " probe coverage fraction recomputes",
              all_cov["fraction"] ==
              round(all_cov["coveredStations"] / max(1, all_cov["stationTests"]), 6),
              "%d/%d" % (all_cov["coveredStations"], all_cov["stationTests"]))
        check(name + " probe up-facing fraction recomputes",
              up_cov["fraction"] ==
              round(up_cov["coveredStations"] / max(1, up_cov["stationTests"]), 6),
              "%d/%d" % (up_cov["coveredStations"], up_cov["stationTests"]))
        check(name + " probe full coverage has no gaps",
              all_cov["gapRuns"] == 0 and all_cov["gapMetres"] == 0,
              "%s runs / %s m" % (all_cov["gapRuns"], all_cov["gapMetres"]))
        check(name + " probe up-facing coverage has no gaps",
              up_cov["gapRuns"] == 0 and up_cov["gapMetres"] == 0,
              "%s runs / %s m" % (up_cov["gapRuns"], up_cov["gapMetres"]))
        check(name + " probe new-sections-only tests the same stations",
              new_cov["samples"] == all_cov["samples"] and
              new_cov["stationTests"] == all_cov["stationTests"],
              "%s/%s vs %s/%s" % (new_cov["samples"], new_cov["stationTests"],
                                  all_cov["samples"], all_cov["stationTests"]))
        check(name + " probe new-sections-only is a subset of the full set",
              new_cov["coveredStations"] <= all_cov["coveredStations"] and
              new_cov["fraction"] <= all_cov["fraction"],
              "%d vs %d" % (new_cov["coveredStations"], all_cov["coveredStations"]))
        check(name + " probe new-sections-only fraction recomputes",
              new_cov["fraction"] ==
              round(new_cov["coveredStations"] / max(1, new_cov["stationTests"]), 6),
              "%d/%d" % (new_cov["coveredStations"], new_cov["stationTests"]))
        check(name + " probe new sections cover part of the path",
              new_cov["coveredStations"] > 0, str(new_cov["coveredStations"]))
        # The inventory mirror must agree with the probe output wherever the
        # field exists, so a stale or hand-edited `extendedProbe` fails instead
        # of silently masking a changed measurement.
        for field, value in (("coverageFraction", all_cov["fraction"]),
                             ("upFacingCoverageFraction", up_cov["fraction"]),
                             ("newOnlyCoverageFraction", new_cov["fraction"])):
            if field in probe:
                check(name + " probe " + field + " mirror agrees",
                      probe[field] == value, "%s vs %s" % (probe[field], value))
        check(name + " recovered path equals collision diameter",
              abs(probe["componentPathM"] - row["collisionPathM"]) <= 0.001,
              "%s vs %s" % (probe["componentPathM"], row["collisionPathM"]))
        check(name + " native validation count", probe["nativeValidated"] == sum(
            1 for item in ok_rows if "nativeValidation" in item))
        validations = [item["nativeValidation"] for item in ok_rows if "nativeValidation" in item]
        check(name + " every native validation matched positions",
              all(item["positionsMatch"] for item in validations))
        check(name + " every native validation matched indices",
              all(item["indicesMatch"] for item in validations))
        check(name + " every native validation matched vertex count",
              all(item["vertexCountMatch"] for item in validations))
        check(name + " every native validation matched triangle count",
              all(item["triangleCountMatch"] for item in validations))
        check(name + " probe expected sections", probe["sections"] == expected["sections"],
              str(probe["sections"]))
        check(name + " probe expected triangles", probe["triangles"] == expected["triangles"],
              str(probe["triangles"]))
        check(name + " probe expected new sections", probe["newSections"] == expected["newSections"],
              str(probe["newSections"]))
        check(name + " probe expected new triangles", probe["newTriangles"] == expected["newTriangles"],
              str(probe["newTriangles"]))

    # --------------------------------------------- longbeach gap checks
    lb = next(item for item in rows if item["level"] == "usa_la_longbeachdocks")
    blockers_file = ROOT / "_work/map-slice/longbeach-textures/blockers.json"
    blockers = json.loads(blockers_file.read_text())
    documented = lb["instancesDocumented"]
    check("longbeach documented instance source hash",
          documented["sourceSha256"] == sha256(blockers_file))
    check("longbeach instance sections are 33", documented["sections"] == 33, str(documented["sections"]))
    check("longbeach instance descriptions are 7476", documented["descriptions"] == 7476,
          str(documented["descriptions"]))
    check("longbeach instance upper-bound triangles",
          documented["triangleUpperBound"] == 5948518, str(documented["triangleUpperBound"]))
    check("longbeach instance referenced blocks",
          documented["referencedBlocks"] == 588, str(documented["referencedBlocks"]))
    check("longbeach instance first-item blocks",
          documented["firstItemBlocks"] == 116, str(documented["firstItemBlocks"]))
    check("longbeach instance prerequisite errors",
          documented["bundlePrerequisiteErrors"] == 29,
          str(documented["bundlePrerequisiteErrors"]))
    unsupported = blockers["unsupportedSections"]["sections"]
    check("longbeach unsupported section count is 2", len(unsupported) == 2, str(len(unsupported)))
    check("longbeach unsupported ids",
          {item["id"] for item in unsupported} == {"g199-n346", "g204-n418"})
    check("longbeach g199 byte offset",
          next(item for item in unsupported if item["id"] == "g199-n346")["nativeByteOffset"] == 362668)
    check("longbeach g204 byte offset",
          next(item for item in unsupported if item["id"] == "g204-n418")["nativeByteOffset"] == 241712)
    check("longbeach committed draw path below collision diameter",
          lb["drawCoveredPathM"] < lb["collisionPathM"])
    check("longbeach recovered path equals collision diameter",
          abs(lb["extendedProbe"]["componentPathM"] - lb["collisionPathM"]) <= 0.001)
    check("longbeach new sections add more triangles than the committed set",
          lb["extendedProbe"]["newTriangles"] > 0)
    check("longbeach missing metres = collision - committed draw",
          abs((lb["collisionPathM"] - lb["drawCoveredPathM"]) - 912.139) <= 0.01,
          str(round(lb["collisionPathM"] - lb["drawCoveredPathM"], 3)))

    # ------------------------------------------------------------- report
    result = {
        "schema": "blur.map-pipeline.blocked-verify/1",
        "inventory": {"path": str(args.inventory.relative_to(ROOT)).replace("\\", "/"),
                      "sha256": sha256(args.inventory)},
        "checks": len(checks),
        "failures": len(failures),
        "status": "PASS" if not failures else "FAIL",
        "failed": failures,
        "levels": len(rows),
        "probeLevels": sorted(PROBE_DIRS),
        "scope": ("data only; no renderer, GPU, browser, engine or playable claim; "
                  "draw coverage is first-RenderList direct LOD0, instancesApplied:false"),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "checks": result["checks"],
                      "failures": result["failures"],
                      "firstFailure": failures[0] if failures else None}, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())

