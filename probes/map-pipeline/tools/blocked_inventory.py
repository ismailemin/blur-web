#!/usr/bin/env python3
"""Merge the committed map manifests, the node/instance inventory and the three
extended-extraction probes into one deterministic 19-map blocked inventory.

Read-only inputs:
  _work/map-pipeline/maps.json
  _work/map-pipeline/inventory.json
  _work/map-pipeline/draw-probes-all.json
  _work/map-pipeline/node-inventory.json
  _work/map-pipeline/<level>-probe/probe.json  (bowl, highrise, longbeach)
  _work/map-slice/<package>-render/render.json (texture counts, three maps)
  probes/e1-drive/web/map-registry.js           (playable map ids)

Output: _work/map-pipeline/blocked/inventory-19.json

No number is derived by guessing: every field names its source manifest.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WORK = ROOT / "_work/map-pipeline"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def short_hashes(paths):
    return {str(p.relative_to(ROOT)).replace("\\", "/"): sha256(p) for p in paths}


def read_playable_ids() -> list[str]:
    text = (ROOT / "probes/e1-drive/web/map-registry.js").read_text(encoding="utf-8")
    block = re.search(r"export const MAP_IDS = Object\.freeze\(\[(.*?)\]\)", text, re.S)
    if not block:
        raise SystemExit("MAP_IDS not found in map-registry.js")
    return re.findall(r"'([^']+)'", block.group(1))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=WORK / "blocked/inventory-19.json")
    args = ap.parse_args(argv)

    maps = json.loads((WORK / "maps.json").read_text())
    inv = json.loads((WORK / "inventory.json").read_text())
    draws = json.loads((WORK / "draw-probes-all.json").read_text())
    draws_extra = json.loads((WORK / "draw-probes-extra.json").read_text()) if (WORK / "draw-probes-extra.json").is_file() else {"levels": []}
    nodes = json.loads((WORK / "node-inventory.json").read_text()) if (WORK / "node-inventory.json").is_file() else {"levels": []}

    inv_by_name = {level["name"]: level for level in inv["levels"]}
    draws_by_name = {level["level"]: level for level in draws["levels"]}
    for level in draws_extra["levels"]:
        if len(level.get("probes", [])) == level.get("pairCount"):
            draws_by_name[level["level"]] = level
    nodes_by_name = {level["level"]: level for level in nodes["levels"]}

    package_map = {
        "usa_amboy": ("amboy", "amboy-render"),
        "spa_barcelona_gracia": ("gracia", "gracia-render"),
        "usa_la_longbeachdocks": ("longbeach", "longbeach-render"),
    }
    textures = {}
    documented_instances = {}
    for level, (pkg, render_pkg) in package_map.items():
        render_file = ROOT / "_work/map-slice" / render_pkg / "render.json"
        if render_file.is_file():
            doc = json.loads(render_file.read_text())
            counts = doc["counts"]
            textures[level] = {
                "source": str(render_file.relative_to(ROOT)).replace("\\", "/"),
                "sourceSha256": sha256(render_file),
                "bindableDraws": counts["bindableDraws"],
                "blockedDraws": counts["blockedDraws"],
                "draws": counts["draws"],
                "bindableTriangles": counts["bindableTriangles"],
                "textureSources": counts["textureSources"],
                "uniqueTextureBlobs": counts["uniqueTextureBlobs"],
            }
        blockers_file = ROOT / "_work/map-slice" / (pkg + "-textures") / "blockers.json"
        if blockers_file.is_file():
            blockers = json.loads(blockers_file.read_text())
            summary = blockers["instances"]["summary"]
            documented_instances[level] = {
                "source": str(blockers_file.relative_to(ROOT)).replace("\\", "/"),
                "sourceSha256": sha256(blockers_file),
                "sections": summary["sections"],
                "descriptions": summary["instances"],
                "triangleUpperBound": summary["triangleUpperBound"],
                "referencedBlocks": summary["referencedBlocks"],
                "availableBlocks": summary["availableBlocks"],
                "firstItemBlocks": summary["firstItemBlocks"],
                "bundlePrerequisiteErrors": summary["bundlePrerequisiteErrors"],
            }

    playable = {"river": "usa_la_river", "amboy": "usa_amboy", "gracia": "spa_barcelona_gracia",
                "longbeach": "usa_la_longbeachdocks",
                "observatory": "usa_la_observatory",
                "downtown": "usa_la_downtown",
                "mharuna": "jpn_mharuna",
                "highrise": "usa_la_multiplayer_highrise",
                "shutoko": "jpn_tokyo_shutoko",
                "oval": "spa_barcelona_oval",
                "amboy-mp": "usa_amboy_multiplayer",
                "dumbo": "usa_ny_dumbo",
                "downtown-mp": "usa_la_downtown_multiplayer",
                "sausalito": "usa_sanfran_sausalito"}
    playable_levels = {playable[mid] for mid in read_playable_ids() if mid in playable}

    probe_levels = {
        "usa_la_longbeachdocks": "usa_la_longbeachdocks-probe",
        "spa_barcelona_bowl_multiplayer": "spa_barcelona_bowl_multiplayer-probe",
        "usa_la_multiplayer_highrise": "usa_la_multiplayer_highrise-probe",
    }
    probes = {}
    for level, folder in probe_levels.items():
        file = WORK / folder / "probe.json"
        if file.is_file():
            doc = json.loads(file.read_text())
            rows = [row for row in doc["sections"] if row["status"] == "ok"]
            new = {}
            for row in rows:
                if "nativeValidation" not in row:
                    new[(row["chunk"], row["item"])] = row
            probes[level] = {
                "file": str(file.relative_to(ROOT)).replace("\\", "/"),
                "sha256": sha256(file),
                "sections": doc["totals"]["sections"],
                "triangles": doc["totals"]["triangles"],
                "vertices": doc["totals"]["vertices"],
                "draws": doc["totals"]["draws"],
                "committedSections": sum(1 for row in rows if "nativeValidation" in row),
                "newSections": len(new),
                "newTriangles": sum(row["triangles"] for row in new.values()),
                "coverageFraction": doc["coverage"]["allTriangles"]["fraction"],
                "upFacingCoverageFraction": doc["coverage"]["upFacingTriangles"]["fraction"],
                "newOnlyCoverageFraction": doc["coverage"]["newSectionsOnly"]["fraction"],
                "componentPathM": (doc["coverage"]["drawCoveredComponentPath"] or {}).get("lengthM", 0.0),
                "componentPathStart": (doc["coverage"]["drawCoveredComponentPath"] or {}).get("start"),
                "componentPathEnd": (doc["coverage"]["drawCoveredComponentPath"] or {}).get("end"),
                "nativeValidated": doc["totals"]["nativeValidated"],
                "unsupportedRows": sum(1 for row in doc["sections"] if row["status"] != "ok"),
            }

    def item_list(level_row, name):
        """Distinct engineering items between the current state and a sprint page."""
        if name in playable_levels:
            return []
        items = []
        if name in probes and probes[name]["coverageFraction"] > 0.99 and name not in package_map:
            items.append("extended-extractor")
        if name not in package_map:
            items += ["slice-package", "texture-bindings", "render-package"]
        if not (WORK / "candidates" / (name + ".layout.json")).is_file():
            items.append("layout")
        items += ["e1-map-package", "e1-verify-browser"]
        if level_row["kind"] == "showroom":
            items.append("showroom-mode")
        return items

    rows = []
    for level in maps["levels"]:
        name = level["name"]
        irow = inv_by_name[name]
        drow = draws_by_name[name]
        nrow = nodes_by_name.get(name, {})
        rows.append({
            "level": name,
            "kind": level["kind"],
            "committedGrade": level["classification"],
            "committedGradeReason": level["classificationReason"],
            "playableToday": name in playable_levels,
            "collisionTriangles": irow["physics"]["staticTriangles"],
            "collisionBounds": irow["physics"]["bounds"],
            "firstRenderListPairs": drow["pairCount"],
            "supportedSections": sum(1 for probe in drow["probes"] if probe["status"] == "ok"),
            "unsupportedSections": sum(1 for probe in drow["probes"] if probe["status"] != "ok"),
            "supportedDraws": level["draws"]["supportedDraws"],
            "supportedDrawTriangles": level["draws"]["supportedTriangles"],
            "instancesMeasured": nrow.get("instances", {}).get("descriptions"),
            "instanceSectionsMeasured": nrow.get("instances", {}).get("nodesWithInstances"),
            "instanceNodeChunksWithInstances": nrow.get("instances", {}).get("nodesWithInstances"),
            "instancesDocumented": documented_instances.get(name),
            "skippedBlockRefs": nrow.get("skippedBlockRefs"),
            "texturePackage": textures.get(name),
            "collisionPathM": level["drivable"]["path"]["lengthM"],
            "collisionPathKind": level["drivable"]["path"]["kind"],
            "drawCoveredPathM": level["drawCoverage"]["drawCoveredPathM"],
            "coverageOfCollisionPath": level["drawCoverage"]["completenessOfCollisionPath"],
            "coveredCells": level["drawCoverage"]["coveredCollisionCells"],
            "passableCells": level["drawCoverage"]["passableCells"],
            "grid": irow["grid"],
            "pathArtifact": {
                "path": level["pathArtifact"]["path"],
                "declaredSha256": level["pathArtifact"]["sha256"],
                "actualSha256": sha256(ROOT / level["pathArtifact"]["path"]),
                "samples": level["pathArtifact"]["samples"],
                "bbox": level["pathArtifact"]["bbox"],
            },
            "coveredArtifact": level["drawCoverage"]["drawCoveredPathArtifact"],
            "files": irow["files"],
            "singleBlocker": (
                None if name in playable_levels else
                ("draw coverage below 25 m under the committed extractor" if level["classification"] == "C" else
                 "no committed retail spawn/course; e1-drive has no map package" if level["kind"] != "showroom" else
                 "showroom is not a race/sprint map")
            ),
            "limiter": (
                "none: integrated in e1-drive" if name in playable_levels else
                ("extractor + integration" if name in probes else "integration (layout/materials/packet)")
            ),
            "recoverableCoverage": probes.get(name, {}).get("coverageFraction"),
            "extendedProbe": probes.get(name),
        })
    for row in rows:
        row["playableDistanceItems"] = item_list(row, row["level"])
        row["playableDistanceCount"] = len(row["playableDistanceItems"])

    def rank_key(row):
        # primary: distinct engineering items; then recovered (if measured) or
        # committed draw coverage; then fewer unsupported sections; then
        # smaller collision mesh.
        return (row["playableDistanceCount"],
                -round(row["recoverableCoverage"] if row["recoverableCoverage"] is not None
                       else row["coverageOfCollisionPath"], 6),
                row["unsupportedSections"],
                row["collisionTriangles"])

    ranked = sorted(rows, key=rank_key)
    for index, row in enumerate(ranked, 1):
        row["distanceRank"] = index

    by_grade = {"A": 0, "B": 0, "C": 0}
    for row in rows:
        by_grade[row["committedGrade"]] += 1

    doc = {
        "schema": "blur.map-pipeline.blocked-inventory/1",
        "scope": {
            "dataOnly": True,
            "rendererClaim": False,
            "playableClaim": False,
            "note": ("committed grade is the map-pipeline A/B/C audit; playableToday is read from "
                     "probes/e1-drive/web/map-registry.js. Amboy and Gracia are graded B by the audit "
                     "but are integrated and playable in e1-drive."),
        },
        "sources": {
            "maps": {"path": "_work/map-pipeline/maps.json", "sha256": sha256(WORK / "maps.json")},
            "inventory": {"path": "_work/map-pipeline/inventory.json", "sha256": sha256(WORK / "inventory.json")},
            "draws": {"path": "_work/map-pipeline/draw-probes-all.json", "sha256": sha256(WORK / "draw-probes-all.json")},
            "nodeInventory": ({"path": "_work/map-pipeline/node-inventory.json",
                               "sha256": sha256(WORK / "node-inventory.json")}
                              if (WORK / "node-inventory.json").is_file() else None),
            "mapRegistry": {"path": "probes/e1-drive/web/map-registry.js",
                            "sha256": sha256(ROOT / "probes/e1-drive/web/map-registry.js")},
        },
        "summary": {
            "levels": len(rows),
            "committedGrades": by_grade,
            "playableToday": sorted(row["level"] for row in rows if row["playableToday"]),
            "withExtendedProbe": sorted(probes),
            "recoveredCoverage": {name: probes[name]["coverageFraction"] for name in probes},
            "newSections": {name: probes[name]["newSections"] for name in probes},
            "newTriangles": {name: probes[name]["newTriangles"] for name in probes},
        },
        "levels": ranked,
        "nextThree": [row["level"] for row in ranked if not row["playableToday"]][:3],
        "rankingRule": ("distinct engineering items to a working ?map=<id>&script=sprint, then "
                        "committed/recovered draw coverage, then unsupported section count, then "
                        "collision triangle count"),
        "limits": [
            "committed coverage is first-RenderList direct LOD0 only; instancesApplied:false",
            "the extended probe is measured for three levels only (longbeach, highrise, bowl)",
            "no materials, textures, shaders, culling or GPU state are applied by map-pipeline",
            "no renderer, GPU, browser, vehicle-physics or playable claim",
        ],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "levels": len(rows),
        "grades": by_grade,
        "playable": doc["summary"]["playableToday"],
        "nextThree": doc["nextThree"],
        "rank": [(row["distanceRank"], row["level"], row["playableDistanceCount"],
                  row["coverageOfCollisionPath"]) for row in ranked],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


