"""Verify the staged batch-3 vehicle artifacts against the committed readers.

The gate re-derives every staged artifact instead of trusting `summary.json`:

* body/wheel model hashes and reader output (`scene_inspect`, `model_inspect`);
* manifest/mesh/scene-report hashes, draw ownership and wheel-group shape;
* the independent `tools/inspect_car_materials.py` traversal for every car;
* `probes/car-parts/tools/verify_staged_manifest.py` for every staged directory;
* HUD name/icon/manufacturer resolution (`hud_catalog.build()`);
* roster/ghost/capture plans and the second staging build's hashes.

Output: `_work/vehicle-pipeline/batch3/verify.json`
Usage: python probes/vehicle-pipeline/tools/verify_batch3.py
"""

from __future__ import annotations

import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
for path in (ROOT / "tools", ROOT / "engine/harness/t005d-vehicle",
             ROOT / "probes/vehicle-pipeline/tools",
             ROOT / "probes/car-parts/tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import hud_catalog  # noqa: E402
import stage_batch3 as stage  # noqa: E402

OUT = ROOT / "_work/vehicle-pipeline/batch3"
REPEAT = ROOT / "_work/vehicle-pipeline/batch3-repeat"
SUMMARY = OUT / "summary.json"
REPEAT_SUMMARY = REPEAT / "summary.json"
ROSTER = OUT / "roster.json"
VERIFY = OUT / "verify.json"
VERIFY_MATERIALS = OUT / "verify-materials"
STAGED_VERIFIER = ROOT / "probes/car-parts/tools/verify_staged_manifest.py"
EXPECTED_C = {1, 7, 23, 31, 39, 48, 71}
EXPECTED_B = {21, 24, 26}
CANONICAL_MODES = {"sprint:310m", "sprint:short", "lap", "free", "restart", "chunk"}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical(document: dict) -> str:
    return json.dumps(document, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    checks: list[dict] = []
    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            failures.append(name + (": " + detail if detail else ""))
        print(("PASS " if ok else "FAIL ") + name + (" - " + detail if detail else ""),
              flush=True)

    for path in (SUMMARY, REPEAT_SUMMARY, ROSTER):
        check("artifact exists " + path.name, path.is_file(), stage.rel(path))
    if failures:
        VERIFY.write_bytes((json.dumps({"status": "FAIL", "checks": checks,
                                        "failures": failures}, indent=1) + "\n").encode())
        return 1

    summary = json.loads(SUMMARY.read_text(encoding="utf-8"))
    repeat = json.loads(REPEAT_SUMMARY.read_text(encoding="utf-8"))
    roster = json.loads(ROSTER.read_text(encoding="utf-8"))
    records = summary["records"]
    by_slug = {record["slug"]: record for record in records}
    repeat_by_slug = {record["slug"]: record for record in repeat["records"]}

    # ---- global shape -------------------------------------------------------
    check("summary kind/version",
          summary.get("kind") == "blur.vehicle-batch3-staging"
          and summary.get("version") == 1,
          f"{summary.get('kind')} v{summary.get('version')}")
    check("summary PASS", summary.get("status") == "PASS", str(summary.get("status")))
    check("repeat PASS", repeat.get("status") == "PASS", str(repeat.get("status")))
    check("10 records", len(records) == 10, str(len(records)))
    check("unique slugs", len(by_slug) == 10)
    check("unique record ids", len({record["recordId"] for record in records}) == 10)
    check("unique record indices", len({record["recordIndex"] for record in records}) == 10)
    c_indexes = {record["recordIndex"] for record in records if record["class"] == "C"}
    b_indexes = {record["recordIndex"] for record in records if record["class"] == "B"}
    check("C batch is 1,7,23,31,39,48,71", c_indexes == EXPECTED_C, str(sorted(c_indexes)))
    check("B batch is 21,24,26", b_indexes == EXPECTED_B, str(sorted(b_indexes)))
    check("counts: 7 C / 3 B",
          summary["counts"]["classC"] == 7 and summary["counts"]["classB"] == 3,
          json.dumps({"C": summary["counts"]["classC"], "B": summary["counts"]["classB"]}))
    check("all staged", summary["counts"]["staged"] == 10
          and summary["counts"]["errors"] == 0,
          json.dumps(summary["counts"]))
    check("aggregate body draws", summary["counts"]["bodyDraws"] == 1076,
          str(summary["counts"]["bodyDraws"]))
    check("aggregate parts", summary["counts"]["bodyParts"] == 307,
          str(summary["counts"]["bodyParts"]))
    check("aggregate wheel draws", summary["counts"]["wheelDraws"] == 200,
          str(summary["counts"]["wheelDraws"]))
    check("aggregate UV0 vertices", summary["counts"]["uv0ValidVertices"] == 213062,
          str(summary["counts"]["uv0ValidVertices"]))
    check("aggregate 30 previews", summary["counts"]["previews"] == 30,
          str(summary["counts"]["previews"]))

    for name, source in summary["sources"].items():
        path = ROOT / source["path"]
        check(f"source {name} hash", path.is_file() and sha256_file(path) == source["sha256"],
              source["sha256"][:16])
    for name in ("carsJson", "cAliases", "amaxJsonl", "hudCatalog", "builder",
                 "materialTraversal", "sceneReader", "modelReader", "previewRenderer"):
        check(f"source {name} listed", name in summary["sources"])

    # ---- HUD catalog re-derivation -----------------------------------------
    hud_doc = json.loads(
        (ROOT / "_work/vehicle-pipeline/batch3/hud/hud-catalog.json").read_text(encoding="utf-8"))
    rebuilt = hud_catalog.build()
    check("HUD catalog reproduces byte-identically",
          canonical(rebuilt) == canonical(hud_doc),
          "hud_catalog.build()")
    check("HUD catalog 10 records", len(hud_doc["records"]) == 10)
    check("HUD catalog 65 master sprites", hud_doc["iconCatalog"]["spriteCount"] == 65,
          str(hud_doc["iconCatalog"]["spriteCount"]))
    check("HUD catalog no unresolved LocId", hud_doc["checks"]["amaxLocIdsResolved"],
          str(hud_doc["checks"]["amaxLocIdsResolved"]))
    hud_by_index = {row["recordIndex"]: row for row in hud_doc["records"]}
    master_sprites = set(hud_doc["iconCatalog"]["carSprites"])

    # ---- roster / ghosts / captures ----------------------------------------
    entries = roster["entries"]
    check("roster 10 entries", len(entries) == 10, str(len(entries)))
    check("roster kind", roster.get("kind") == "blur.vehicle-batch3-roster-staging"
          and roster.get("version") == 1)
    check("roster targets the E1 roster",
          roster.get("targetRoster") == "probes/e1-drive/cars/roster.json")
    check("roster ghosts 20 files", len(roster["ghosts"]["files"]) == 20,
          str(len(roster["ghosts"]["files"])))
    check("roster ghost courses", roster["ghosts"]["courses"] == ["310m", "short"],
          str(roster["ghosts"]["courses"]))
    capture_modes = {f"{entry['mode']}:{entry['course']}"
                     if entry.get("course") else entry["mode"]
                     for entry in roster["captures"]["minimum"]}
    capture_modes |= {entry["mode"] for entry in roster["captures"]["sample"]}
    check("capture modes cover sprint/short/lap/free/restart/chunk",
          CANONICAL_MODES <= capture_modes, str(sorted(capture_modes)))
    check("capture requirements mention screenshot",
          any("screenshot" in line for line in roster["captures"]["requirements"]))
    check("capture requirements mention console",
          any("console" in line for line in roster["captures"]["requirements"]))
    check("roster hashes in summary",
          summary["roster"]["sha256"] == sha256_file(ROSTER))

    for entry in entries:
        slug = entry["slug"]
        record = by_slug.get(slug)
        check(f"roster {slug} staged", record is not None)
        if record is None:
            continue
        check(f"roster {slug} id/index",
              entry["recordId"] == record["recordId"]
              and entry["recordIndex"] == record["recordIndex"],
              f"{entry['recordIndex']}/{entry['recordId']}")
        check(f"roster {slug} name", entry["name"] == record["recordName"])
        check(f"roster {slug} layout",
              entry["layout"] == f"{record['drivetrain']}, "
                                 f"{int(round(record['mass']))} kg, "
                                 f"{record['gearCount']}-speed",
              entry["layout"])
        check(f"roster {slug} why", len(entry["why"]) > 40, entry["why"][:60])

    check("ghost plan names every car twice",
          sorted(row["slug"] for row in roster["ghosts"]["files"]) ==
          sorted([record["slug"] for record in records] * 2))
    ghost_paths_ok = True
    ghost_files_absent = True
    for row in roster["ghosts"]["files"]:
        expected = f"probes/e1-drive/ghosts/{row['slug']}-{row['course']}.json"
        ghost_paths_ok = ghost_paths_ok and row["file"] == expected
        ghost_files_absent = ghost_files_absent and not (ROOT / expected).exists()
    check("ghost file names are canonical", ghost_paths_ok)
    check("no ghost is claimed before V7 writes it", ghost_files_absent)
    check("roster entries are not A anchors",
          not ({entry["slug"] for entry in entries} & {
              "corvette-zr1-stock", "lotus-exige-cup260-stock",
              "dodge-challenger-stock", "ford-focusrs-stock", "audi-r8v10-stock"}))

    # ---- per car ------------------------------------------------------------
    totals = {"bodyDraws": 0, "parts": 0, "wheelDraws": 0, "uv0": 0,
              "static": 0, "textures": 0, "sourceBytes": 0}
    for record in records:
        slug = record["slug"]
        label = f"{record['recordIndex']} {slug}"
        body_path = ROOT / record["body"]["decodedPath"]
        wheel_path = ROOT / record["wheel"]["decodedPath"]
        manifest_path = ROOT / record["artifacts"]["manifest"]
        mesh_path = ROOT / record["artifacts"]["mesh"]
        scene_path = ROOT / record["artifacts"]["sceneReport"]

        check(f"{label} status", record["status"] == "staged", record["status"])
        check(f"{label} checks all true", all(record["checks"].values()),
              json.dumps(record["checks"]))
        check(f"{label} body hash",
              body_path.is_file() and sha256_file(body_path) == record["body"]["sha256"],
              record["body"]["sha256"][:16])
        check(f"{label} wheel hash",
              wheel_path.is_file() and sha256_file(wheel_path) == record["wheel"]["sha256"],
              record["wheel"]["sha256"][:16])
        check(f"{label} manifest hash",
              manifest_path.is_file()
              and sha256_file(manifest_path) == record["artifacts"]["manifestSha256"],
              record["artifacts"]["manifestSha256"][:16])
        check(f"{label} mesh hash",
              mesh_path.is_file()
              and sha256_file(mesh_path) == record["artifacts"]["meshSha256"],
              record["artifacts"]["meshSha256"][:16])
        check(f"{label} scene report hash",
              scene_path.is_file()
              and sha256_file(scene_path) == record["artifacts"]["sceneReportSha256"],
              record["artifacts"]["sceneReportSha256"][:16])
        check(f"{label} physics gate", record["physics"]["gatePass"])

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        mesh = json.loads(mesh_path.read_text(encoding="utf-8"))
        scene = json.loads(scene_path.read_text(encoding="utf-8"))
        diagnostics = manifest["diagnostics"]
        draws = manifest["draws"]
        groups = manifest["wheelGroups"]

        check(f"{label} manifest schema",
              manifest.get("kind") == "blur.car-part-manifest" and manifest.get("version") == 1)
        check(f"{label} manifest model hash",
              manifest["source"]["modelSha256"] == record["body"]["sha256"])
        check(f"{label} manifest pak path",
              manifest["source"].get("modelPakPath") == record["body"]["pakPath"],
              record["body"]["pakPath"])
        check(f"{label} draws owned once",
              sorted(draw["index"] for draw in draws) == list(range(len(draws)))
              and len(draws) == diagnostics["drawCount"],
              f"{len(draws)} draws")
        check(f"{label} draw count", diagnostics["drawCount"] == record["body"]["drawCount"])
        check(f"{label} part count", diagnostics["partCount"] == record["body"]["partCount"])
        check(f"{label} four wheel groups", diagnostics["wheelGroupCount"] == 4
              and len(groups) == 4, str(diagnostics["wheelGroupCount"]))
        check(f"{label} 20 wheel draws", diagnostics["wheelDrawCount"] == 20
              and record["body"]["wheelDrawCount"] == 20,
              str(diagnostics["wheelDrawCount"]))
        check(f"{label} numbered wheel groups",
              sorted(group["id"] for group in groups) == sorted([
                  "wheel.frontleft", "wheel.frontright",
                  "wheel.backleft", "wheel.backright"]))
        group_draw_sets = [set(group["previewDraws"]) | set(group["provenDraws"])
                           for group in groups]
        check(f"{label} five wheel draws per group",
              all(len(draw_set) == 5 for draw_set in group_draw_sets),
              str([len(draw_set) for draw_set in group_draw_sets]))
        check(f"{label} wheel draws never shared between corners",
              sum(len(draw_set) for draw_set in group_draw_sets) ==
              len(set().union(*group_draw_sets)),
              str(sum(len(draw_set) for draw_set in group_draw_sets)))
        check(f"{label} wheel set equals wheelDrawCount",
              len(set().union(*group_draw_sets)) == diagnostics["wheelDrawCount"],
              str(len(set().union(*group_draw_sets))))
        caliper_present = diagnostics["brakeCaliperDrawCount"] > 0
        caliper_absent = any(group.get("caliper") == "absent" for group in groups)
        check(f"{label} caliper is present or typed absent",
              caliper_present != caliper_absent,
              f"draws={diagnostics['brakeCaliperDrawCount']} absent={caliper_absent}")
        check(f"{label} caliper draw count is four per corner set",
              diagnostics["brakeCaliperDrawCount"] == 0
              or diagnostics["brakeCaliperDrawCount"] % 4 == 0,
              str(diagnostics["brakeCaliperDrawCount"]))
        check(f"{label} tyre proof tier",
              diagnostics["tyreProofTier"] in ("union", "containment"),
              diagnostics["tyreProofTier"])

        check(f"{label} mesh vertex count",
              len(mesh["positions"]) == mesh["vertexCount"] * 3,
              f"{mesh['vertexCount']} vertices")
        check(f"{label} mesh index count",
              len(mesh["indices"]) == mesh["indexCount"]
              and mesh["indexCount"] % 3 == 0,
              f"{mesh['indexCount']} indices")
        check(f"{label} mesh indices in range",
              max(mesh["indices"]) < mesh["vertexCount"],
              str(max(mesh["indices"])))
        positions_hash = hashlib.sha256(struct.pack(
            "<%df" % len(mesh["positions"]), *mesh["positions"])).hexdigest()
        indices_hash = hashlib.sha256(struct.pack(
            "<%dI" % len(mesh["indices"]), *mesh["indices"])).hexdigest()
        check(f"{label} mesh positions hash",
              positions_hash == mesh["positionsFloat32LESha256"]
              == record["artifacts"]["meshPositionsSha256"],
              positions_hash[:16])
        check(f"{label} mesh indices hash",
              indices_hash == mesh["indicesUint32LESha256"]
              == record["artifacts"]["meshIndicesSha256"],
              indices_hash[:16])

        meta = scene["metadata"]
        check(f"{label} scene draw count", len(scene["draws"]) == record["body"]["drawCount"])
        check(f"{label} scene vertices/triangles",
              meta["vertexCount"] == mesh["vertexCount"]
              and meta["triangleCount"] == mesh["indexCount"] // 3,
              f"{meta['vertexCount']}/{meta['triangleCount']}")
        check(f"{label} scene UV0",
              meta["uv0ValidVertices"] == record["body"]["scene"]["uv0ValidVertices"]
              and meta["uv0ValidVertices"] > 0,
              str(meta["uv0ValidVertices"]))
        check(f"{label} scene UV0 draws",
              record["body"]["scene"]["uv0DrawsAvailable"] > 0,
              str(record["body"]["scene"]["uv0DrawsAvailable"]))
        check(f"{label} scene bounds match summary",
              scene["bounds"] == record["body"]["bounds"])
        check(f"{label} scene partial traversal",
              meta["partialSceneTraversal"] is True
              and meta.get("runtimeMaterialsApplied") is False)

        body_scene = stage.scene_reader(body_path)
        check(f"{label} reader scene draws",
              body_scene["drawCount"] == record["body"]["drawCount"],
              str(body_scene["drawCount"]))
        check(f"{label} reader scene vertices/triangles",
              body_scene["vertexCount"] == mesh["vertexCount"]
              and body_scene["triangleCount"] == mesh["indexCount"] // 3)
        check(f"{label} reader scene UV0",
              body_scene["uv0ValidVertices"] == meta["uv0ValidVertices"])
        body_model = stage.model_reader(body_path)
        check(f"{label} reader model", body_model["status"] == "ok"
              and body_model["chunks"] > 0, str(body_model["chunks"]))
        wheel_scene = stage.scene_reader(wheel_path)
        check(f"{label} reader wheel scene",
              wheel_scene["status"] == "ok" and wheel_scene["drawCount"] > 0
              and wheel_scene["drawCount"] == record["wheel"]["scene"]["drawCount"],
              str(wheel_scene["drawCount"]))
        wheel_model = stage.model_reader(wheel_path)
        check(f"{label} reader wheel model",
              wheel_model["status"] == "ok"
              and wheel_model["chunks"] == record["wheel"]["model"]["chunks"])

        materials = stage.material_pass(body_path, VERIFY_MATERIALS / slug)
        recorded_materials = record["body"]["materials"]
        check(f"{label} materials draw count",
              materials["drawCount"] == recorded_materials["drawCount"]
              == record["body"]["drawCount"])
        check(f"{label} materials status counts",
              materials["statusCounts"] == recorded_materials["statusCounts"],
              str(materials["statusCounts"]))
        check(f"{label} materials static albedo",
              materials["staticAlbedoDraws"] == recorded_materials["staticAlbedoDraws"] > 0,
              str(materials["staticAlbedoDraws"]))
        check(f"{label} materials unique textures",
              materials["uniqueTextureCount"] == recorded_materials["uniqueTextureCount"] > 0,
              str(materials["uniqueTextureCount"]))
        check(f"{label} materials source bytes",
              materials["sourceBytes"] == recorded_materials["sourceBytes"] > 0,
              str(materials["sourceBytes"]))
        check(f"{label} materials UV0 buffers",
              materials["validUv0Vertices"] == recorded_materials["validUv0Vertices"] > 0,
              str(materials["validUv0Vertices"]))

        parts_out = VERIFY_MATERIALS / f"{slug}-model-parts.json"
        parts_proc = subprocess.run([
            sys.executable, str(ROOT / "probes/car-parts/tools/dump_model_parts.py"),
            "--model", str(body_path), "--model-index", "0", "--out", str(parts_out),
        ], capture_output=True, text=True, encoding="utf-8")
        check(f"{label} model parts dump",
              parts_proc.returncode == 0 and parts_out.is_file(),
              parts_proc.stderr[:120])
        parts_doc = (json.loads(parts_out.read_text(encoding="utf-8"))
                     if parts_out.is_file() else {})
        wheel_elements = [element for element in parts_doc.get("elements", [])
                          if any(token in element["name"].lower() for token in
                                 ("e_wheel_", "e_tyre_", "e_alloyrim_",
                                  "e_brakedisc_", "e_brakecaliper_"))]
        caliper_elements = [element for element in wheel_elements
                            if "brakecaliper" in element["name"].lower()]
        check(f"{label} MdlDat wheel elements", len(wheel_elements) > 0,
              str(len(wheel_elements)))
        check(f"{label} MdlDat caliper elements",
              (0 if caliper_absent else 4) == len(caliper_elements),
              str(len(caliper_elements)))

        staged_out = VERIFY_MATERIALS / f"{slug}-staged.json"
        proc = subprocess.run([
            sys.executable, str(STAGED_VERIFIER),
            "--manifest-dir", str(manifest_path.parent),
            "--slug", slug,
            "--model", str(body_path),
            "--model-sha256", record["body"]["sha256"],
            "--pak-path", record["body"]["pakPath"],
            "--materials", str(VERIFY_MATERIALS / slug / "corvette-materials.json"),
            "--uv0", str(VERIFY_MATERIALS / slug / "corvette-uv0.json"),
            "--model-parts", str(parts_out),
            "--out", str(staged_out),
        ], capture_output=True, text=True, encoding="utf-8")
        staged_doc = (json.loads(staged_out.read_text(encoding="utf-8"))
                      if staged_out.is_file() else {})
        check(f"{label} staged manifest verifier",
              proc.returncode == 0 and staged_doc.get("passed") is True,
              str(staged_doc.get("failures") or proc.stderr[:120]))
        check(f"{label} staged verifier material draw count",
              (staged_doc.get("materials") or {}).get("drawCount")
              == record["body"]["drawCount"])
        check(f"{label} staged verifier model parts",
              (staged_doc.get("modelParts") or {}).get("wheelElements", 0) > 0,
              str((staged_doc.get("modelParts") or {}).get("wheelElements")))
        check(f"{label} staged verifier caliper elements",
              len((staged_doc.get("modelParts") or {}).get("caliperElements") or [])
              == len(caliper_elements),
              str(len((staged_doc.get("modelParts") or {}).get("caliperElements") or [])))

        hud = record["hud"]
        catalog_row = hud_by_index.get(record["recordIndex"])
        check(f"{label} HUD catalog row", catalog_row == hud)
        check(f"{label} HUD name", bool(hud["hudName"]) and bool(hud["hudNameKey"]),
              f"{hud['hudNameKey']} = {hud['hudName']}")
        check(f"{label} HUD name key is VEH_*",
              str(hud["hudNameKey"]).startswith("VEH_"),
              str(hud["hudNameKey"]))
        check(f"{label} HUD icon tag/sprite",
              bool(hud["iconTag"])
              and hud["iconSprite"] == hud["iconTag"].lower(),
              f"{hud['iconTag']} -> {hud['iconSprite']}")
        check(f"{label} HUD icon in master atlas",
              hud["iconSprite"] in master_sprites, hud["iconSprite"])
        check(f"{label} HUD icon pages", len(hud["iconPages"]) == 2,
              str(len(hud["iconPages"])))
        check(f"{label} HUD manufacturer",
              bool(hud["manufacturerTag"]) and bool(hud["manufacturerTexture"]),
              f"{hud['manufacturerTag']} / {hud['manufacturerTexture']}")

        previews = record["previews"]
        check(f"{label} three previews", len(previews) == 3, str(len(previews)))
        for view in previews:
            path = ROOT / view["path"]
            check(f"{label} preview {view['view']} exists/hash",
                  path.is_file() and sha256_file(path) == view["sha256"],
                  view["sha256"][:16])
            check(f"{label} preview {view['view']} coverage",
                  view["coverage"] > 0.12, str(view["coverage"]))

        blocker_kinds = {row["kind"] for row in record["blockers"]}
        check(f"{label} row blocker", "wheel-corner-preview-only" in blocker_kinds)
        check(f"{label} partial scene blocker", "partial-scene-traversal" in blocker_kinds)
        check(f"{label} integration still pending", "e1-integration-pending" in blocker_kinds)

        totals["bodyDraws"] += record["body"]["drawCount"]
        totals["parts"] += record["body"]["partCount"]
        totals["wheelDraws"] += record["body"]["wheelDrawCount"]
        totals["uv0"] += record["body"]["scene"]["uv0ValidVertices"]
        totals["static"] += record["body"]["materials"]["staticAlbedoDraws"]
        totals["textures"] += record["body"]["materials"]["uniqueTextureCount"]
        totals["sourceBytes"] += record["body"]["materials"]["sourceBytes"]

    check("recomputed body draws", totals["bodyDraws"] == summary["counts"]["bodyDraws"])
    check("recomputed parts", totals["parts"] == summary["counts"]["bodyParts"])
    check("recomputed wheel draws", totals["wheelDraws"] == summary["counts"]["wheelDraws"])
    check("recomputed UV0", totals["uv0"] == summary["counts"]["uv0ValidVertices"])
    check("recomputed static draws", totals["static"] == summary["counts"]["staticAlbedoDraws"])
    check("recomputed textures", totals["textures"] == summary["counts"]["uniqueTextures"])

    # ---- two-build determinism ---------------------------------------------
    check("repeat has 10 records", len(repeat_by_slug) == 10)
    check("repeat counts equal", repeat["counts"] == summary["counts"])
    for record in records:
        slug = record["slug"]
        other = repeat_by_slug.get(slug)
        check(f"determinism {slug} present", other is not None)
        if other is None:
            continue
        for key in ("manifestSha256", "meshSha256", "meshPositionsSha256",
                    "meshIndicesSha256", "sceneReportSha256"):
            check(f"determinism {slug} {key}",
                  other["artifacts"][key] == record["artifacts"][key],
                  record["artifacts"][key][:16])
        check(f"determinism {slug} previews",
              [view["sha256"] for view in other["previews"]] ==
              [view["sha256"] for view in record["previews"]])
        check(f"determinism {slug} draws/parts",
              (other["body"]["drawCount"], other["body"]["partCount"])
              == (record["body"]["drawCount"], record["body"]["partCount"]))
        check(f"determinism {slug} materials",
              other["body"]["materials"]["manifestSha256"] ==
              record["body"]["materials"]["manifestSha256"])
        check(f"determinism {slug} hud", other["hud"] == record["hud"])

    status = "PASS" if not failures else "FAIL"
    document = {
        "kind": "blur.vehicle-batch3-verify",
        "version": 1,
        "status": status,
        "checks": len(checks),
        "passed": sum(1 for check in checks if check["ok"]),
        "failed": len(failures),
        "failures": failures,
        "counts": summary["counts"],
        "totals": totals,
        "inputs": summary["sources"],
        "outputs": {
            "summary": {"path": stage.rel(SUMMARY), "sha256": sha256_file(SUMMARY)},
            "repeatSummary": {"path": stage.rel(REPEAT_SUMMARY),
                              "sha256": sha256_file(REPEAT_SUMMARY)},
            "roster": {"path": stage.rel(ROSTER), "sha256": sha256_file(ROSTER)},
            "hudCatalog": {"sha256": sha256_file(
                ROOT / "_work/vehicle-pipeline/batch3/hud/hud-catalog.json")},
        },
        "determinism": {
            "builds": 2,
            "identical": not any(name.startswith("determinism ")
                                 for name in failures),
            "covers": ["manifest", "mesh", "positions", "indices", "scene report",
                       "previews", "draws/parts", "materials", "hud"],
        },
        "results": checks,
    }
    VERIFY.write_bytes((json.dumps(document, indent=1, sort_keys=True) + "\n").encode("utf-8"))
    print(json.dumps({"status": status, "checks": len(checks),
                      "passed": document["passed"], "failed": len(failures),
                      "determinism": document["determinism"]["identical"]}, indent=1))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
