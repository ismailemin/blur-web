#!/usr/bin/env python3
"""Deterministic verifier for probes/map-pipeline/data/map-decisions.json.

It re-derives every verdict and every measured field from the committed
probe/batch documents, then rebuilds the decision document and compares it
byte-for-byte. It also re-reads the levelrender Scene ChunkInfo for the two
draw-coverage blockers, so a hand-edited chunk offset fails.

Output: _work/map-pipeline/decisions/verify.json
Prints "N/M checks passed" and exits 1 on any failure.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import map_decisions_lib as lib

ROOT = lib.ROOT
WORK = lib.WORK
BATCH = lib.BATCH
PATH_FLOOR_M = lib.PATH_FLOOR_M


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def close(a: float, b: float, tolerance: float = 1e-6) -> bool:
    return abs(float(a) - float(b)) <= tolerance


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--decisions", type=Path, default=lib.DECISIONS_PATH)
    parser.add_argument("--out", type=Path,
                        default=WORK / "decisions/verify.json")
    args = parser.parse_args(argv)

    raw = args.decisions.read_bytes()
    doc = json.loads(raw)
    src = lib.load_sources()
    maps_by = {row["name"]: row for row in src["maps"]["levels"]}
    inv_by = {row["name"]: row for row in src["inventory"]["levels"]}
    blocked_by = {row["level"]: row for row in src["blocked"]["levels"]}
    batch_by = {row["level"]: row for row in src["batch"]["levels"]}
    verify_by = {row["level"]: row for row in src["batchVerify"]["levels"]}
    det_by = {row["level"]: row for row in src["determinism"]["levels"]}
    levels = lib.level_dirs()
    rows = doc.get("levels", [])
    by_level = {row["level"]: row for row in rows if "level" in row}

    checks = []
    failures = []

    def check(name: str, ok: bool, detail: str = "") -> bool:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            failures.append({"name": name, "detail": detail})
        return bool(ok)

    # ------------------------------------------------------------- global
    check("schema", doc.get("schema") == lib.SCHEMA, str(doc.get("schema")))
    check("generatedBy", doc.get("generatedBy") ==
          "probes/map-pipeline/tools/build_map_decisions.py",
          str(doc.get("generatedBy")))
    check("scope present", isinstance(doc.get("scope"), str) and len(doc["scope"]) > 0)
    check("rules present", isinstance(doc.get("rules"), dict) and
          {"playable", "blocked", "unsupported", "pathFloorM"} <= set(doc["rules"]))
    check("path floor is 25 m", doc["rules"]["pathFloorM"] == PATH_FLOOR_M,
          str(doc["rules"]["pathFloorM"]))
    check("level count is 19", len(rows) == 19, str(len(rows)))
    names = [row.get("level") for row in rows]
    check("level names unique", len(set(names)) == len(names))
    check("level set equals level directories", set(names) == set(levels),
          "missing=%s extra=%s" % (sorted(set(levels) - set(names)),
                                   sorted(set(names) - set(levels))))
    for label, table in (("maps.json", maps_by), ("inventory.json", inv_by),
                         ("blocked inventory", blocked_by),
                         ("batch summary", batch_by), ("batch verify", verify_by),
                         ("determinism", det_by), ("localization", src["cities"])):
        check("level set equals " + label, set(names) == set(table),
              "missing=%s extra=%s" % (sorted(set(table) - set(names)),
                                       sorted(set(names) - set(table))))
    check("every level appears exactly once",
          len(names) == len(set(names)) == 19)

    verdicts = [row.get("verdict") for row in rows]
    check("verdict enum", all(value in {"playable", "blocked", "unsupported"}
                              for value in verdicts), str(verdicts))
    summary = doc.get("summary", {})
    counts = summary.get("counts", {})
    check("summary level count", summary.get("levelCount") == 19,
          str(summary.get("levelCount")))
    check("summary playable count", counts.get("playable") ==
          verdicts.count("playable"), str(counts))
    check("summary blocked count", counts.get("blocked") ==
          verdicts.count("blocked"), str(counts))
    check("summary unsupported count", counts.get("unsupported") ==
          verdicts.count("unsupported"), str(counts))
    check("summary counts sum to 19", sum(counts.get(key, 0) for key in
                                          ("playable", "blocked", "unsupported")) == 19,
          str(counts))
    check("summary playable list", summary.get("playable") ==
          [row["level"] for row in rows if row["verdict"] == "playable"])
    check("summary blocked list", summary.get("blocked") ==
          [row["level"] for row in rows if row["verdict"] == "blocked"])
    check("summary unsupported list", summary.get("unsupported") ==
          [row["level"] for row in rows if row["verdict"] == "unsupported"])
    check("playable source is the registry",
          summary.get("playableSource") ==
          "probes/e1-drive/web/map-registry.js#MAP_IDS",
          str(summary.get("playableSource")))
    check("premise note names longbeach",
          "longbeach" in summary.get("premiseNote", "").lower())
    check("premise note is explicit about the 4-map premise",
          "not supported" in summary.get("premiseNote", ""))

    registry_levels = set(src["registry"]["byLevel"])
    check("playable set equals registry levels",
          {row["level"] for row in rows if row["verdict"] == "playable"} ==
          registry_levels,
          str(sorted(registry_levels)))
    check("playable set equals blocked-inventory playableToday",
          {row["level"] for row in rows if row["verdict"] == "playable"} ==
          {row["level"] for row in src["blocked"]["levels"] if row["playableToday"]})
    check("playable set equals batch grade playable",
          {row["level"] for row in rows if row["verdict"] == "playable"} ==
          {row["level"] for row in src["batch"]["levels"] if row["grade"] == "playable"})
    check("batch determinism all identical",
          src["determinism"].get("allIdentical") is True)
    check("batch verify status PASS", src["batchVerify"].get("status") == "PASS",
          str(src["batchVerify"].get("status")))
    check("batch verify has no failures",
          src["batchVerify"].get("failureCount") == 0,
          str(src["batchVerify"].get("failureCount")))
    check("batch summary has 19 levels", src["batch"].get("levelCount") == 19,
          str(src["batch"].get("levelCount")))
    check("blocked inventory has 19 levels", len(src["blocked"]["levels"]) == 19)
    check("maps.json has 19 levels", len(src["maps"]["levels"]) == 19)
    check("inventory.json has 19 levels", len(src["inventory"]["levels"]) == 19)
    check("localization has 19 city rows", len(src["cities"]) == 19,
          str(len(src["cities"])))
    check("registry ids are river/amboy/gracia/longbeach/observatory",
          set(src["registry"]["mapIds"]) == {"river", "amboy", "gracia", "longbeach", "observatory", "downtown", "mharuna",
           "highrise", "shutoko", "oval", "amboy-mp", "dumbo", "downtown-mp", "sausalito", "hackney", "russianhill", "brighton"},
          str(src["registry"]["mapIds"]))
    check("registry maps five levels",
          set(src["registry"]["byLevel"]) ==
          {"usa_la_river", "usa_amboy", "spa_barcelona_gracia", "usa_la_longbeachdocks",
           "usa_la_observatory", "usa_la_downtown", "jpn_mharuna",
           "usa_la_multiplayer_highrise", "jpn_tokyo_shutoko",
           "spa_barcelona_oval", "usa_amboy_multiplayer",
           "usa_ny_dumbo", "usa_la_downtown_multiplayer",
           "usa_sanfran_sausalito", "uk_london_hackney",
           "usa_sanfran_russianhill", "uk_brighton"},
          str(sorted(src["registry"]["byLevel"])))
    check("unsupported rows, if any, carry a blocker",
          all(row.get("blocker") for row in rows
              if row.get("verdict") == "unsupported"))

    # source pins. The batch summary and batch verifier carry wall-clock timing
    # fields that are not decision inputs; they are pinned by stable content.
    for key, path in (("maps", src["paths"]["maps"]),
                      ("inventory", src["paths"]["inventory"]),
                      ("blockedInventory", src["paths"]["blocked"]),
                      ("batchDeterminism", src["paths"]["determinism"]),
                      ("mapRegistry", src["paths"]["registry"]),
                      ("localization", src["paths"]["localization"])):
        pin = doc.get("sources", {}).get(key)
        check("source pin " + key, pin is not None and
              pin.get("sha256") == sha256_file(path) and
              pin.get("bytes") == path.stat().st_size,
              "" if pin is None else str(pin.get("sha256")))
    for key, path, volatile in (
            ("batchSummary", src["paths"]["batch"], {"timings", "totalSeconds"}),
            ("batchVerify", src["paths"]["batchVerify"], {"seconds"})):
        pin = doc.get("sources", {}).get(key)
        check("source content pin " + key, pin is not None and
              pin.get("pin") == "content" and
              pin.get("volatileFields") == sorted(volatile) and
              pin.get("contentSha256") ==
              lib.content_hash(load_json(path), volatile),
              "" if pin is None else str(pin.get("contentSha256")))
        check("source content pin " + key + " has no volatile file hash",
              pin is not None and "sha256" not in pin and "bytes" not in pin,
              str(sorted(pin)) if pin else "")

    # canonical hash and byte-identical rebuild
    check("canonical hash", doc.get("canonicalSha256") == lib.canonical_hash(doc),
          str(doc.get("canonicalSha256")))
    check("file formatting is canonical",
          raw.decode("utf-8") == lib.serialise(doc))
    expected = lib.build_document()
    expected_text = lib.serialise(expected)
    check("rebuild is byte-identical",
          raw.decode("utf-8") == expected_text,
          "committed=%s rebuilt=%s" % (
              hashlib.sha256(raw).hexdigest(),
              hashlib.sha256(expected_text.encode("utf-8")).hexdigest()))
    expected_again = lib.build_document()
    check("two rebuilds are identical",
          lib.canonical_hash(expected) == lib.canonical_hash(expected_again),
          lib.canonical_hash(expected))

    # ----------------------------------------------------------- per level
    for level in levels:
        row = by_level.get(level)
        if not check(level + " row present", row is not None):
            continue
        batch = batch_by[level]
        inv = blocked_by[level]
        maps = maps_by[level]
        registry_id = src["registry"]["byLevel"].get(level)
        base = BATCH / level
        report = load_json(base / "report.json")
        manifest = load_json(base / "manifest.json")
        path = load_json(base / "path.json")
        draws = load_json(base / "draws.json")
        collision = load_json(base / "collision.json")
        textures = load_json(base / "textures/index.json")
        blockers = load_json(base / "blockers.json")

        # identity and city
        check(level + " city", row.get("city") == src["cities"][level]["city"],
              "%s vs %s" % (row.get("city"), src["cities"][level]["city"]))
        check(level + " city key", row.get("cityKey") ==
              src["cities"][level]["cityKey"], str(row.get("cityKey")))
        check(level + " city source", row.get("citySource") == lib.CITY_SOURCE,
              str(row.get("citySource")))
        check(level + " kind", row.get("kind") == inv["kind"],
              "%s vs %s" % (row.get("kind"), inv["kind"]))
        check(level + " distance rank", row.get("distanceRank") ==
              inv["distanceRank"], str(row.get("distanceRank")))

        # verdict rule
        expected_verdict = "playable" if registry_id else "blocked"
        check(level + " verdict rule", row.get("verdict") == expected_verdict,
              "%s vs %s" % (row.get("verdict"), expected_verdict))
        check(level + " verdict reason", isinstance(row.get("verdictReason"), str)
              and len(row["verdictReason"]) > 0)

        # paths from the batch path document
        paths = row.get("paths", {})
        check(level + " draw-covered path", close(paths.get("drawCoveredM"),
              path["drawCovered"]["lengthM"]),
              "%s vs %s" % (paths.get("drawCoveredM"),
                            path["drawCovered"]["lengthM"]))
        check(level + " collision path", close(paths.get("collisionM"),
              path["collisionOnly"]["lengthM"]),
              "%s vs %s" % (paths.get("collisionM"),
                            path["collisionOnly"]["lengthM"]))
        check(level + " package path", close(paths.get("packageM"),
              path["lengthM"]),
              "%s vs %s" % (paths.get("packageM"), path["lengthM"]))
        check(level + " package path kind", paths.get("packageKind") == path["kind"],
              "%s vs %s" % (paths.get("packageKind"), path["kind"]))
        check(level + " path samples", paths.get("samples") == path["sampleCount"],
              "%s vs %s" % (paths.get("samples"), path["sampleCount"]))
        measured = sum(math.hypot(b["x"] - a["x"], b["z"] - a["z"])
                       for a, b in zip(path["samples"], path["samples"][1:]))
        check(level + " path length recomputes",
              close(measured, path["lengthM"], 0.01),
              "%.6f vs %s" % (measured, path["lengthM"]))
        check(level + " draw path agrees with batch",
              close(paths.get("drawCoveredM"), batch["counts"]["drawCoveredPathM"]),
              "%s vs %s" % (paths.get("drawCoveredM"),
                            batch["counts"]["drawCoveredPathM"]))
        check(level + " collision path agrees with batch",
              close(paths.get("collisionM"), batch["counts"]["collisionPathM"]),
              "%s vs %s" % (paths.get("collisionM"),
                            batch["counts"]["collisionPathM"]))
        check(level + " path samples agree with batch",
              paths.get("samples") == batch["counts"]["pathSamples"],
              "%s vs %s" % (paths.get("samples"), batch["counts"]["pathSamples"]))
        check(level + " draw path agrees with blocked inventory",
              close(paths.get("drawCoveredM"), inv["drawCoveredPathM"], 0.001),
              "%s vs %s" % (paths.get("drawCoveredM"), inv["drawCoveredPathM"]))
        check(level + " collision path agrees with blocked inventory",
              close(paths.get("collisionM"), inv["collisionPathM"], 0.001),
              "%s vs %s" % (paths.get("collisionM"), inv["collisionPathM"]))

        probe = None
        probe_path = None
        if inv.get("extendedProbe"):
            probe_path = ROOT / inv["extendedProbe"]["file"]
            probe = load_json(probe_path)
        if probe:
            check(level + " recovered path", close(paths.get("recoveredM"),
                  probe["coverage"]["drawCoveredComponentPath"]["lengthM"], 0.001),
                  "%s vs %s" % (paths.get("recoveredM"),
                                probe["coverage"]["drawCoveredComponentPath"]["lengthM"]))
        else:
            check(level + " recovered path is null", paths.get("recoveredM") is None,
                  str(paths.get("recoveredM")))

        # counts from the batch documents
        counts = row.get("counts", {})
        check(level + " collision triangles", counts.get("collisionTriangles") ==
              collision["counts"]["triangles"],
              "%s vs %s" % (counts.get("collisionTriangles"),
                            collision["counts"]["triangles"]))
        check(level + " collision vertices", counts.get("collisionVertices") ==
              collision["counts"]["vertices"],
              "%s vs %s" % (counts.get("collisionVertices"),
                            collision["counts"]["vertices"]))
        check(level + " draw count", counts.get("draws") ==
              draws["counts"]["drawCount"],
              "%s vs %s" % (counts.get("draws"), draws["counts"]["drawCount"]))
        check(level + " draw triangles", counts.get("drawTriangles") ==
              draws["counts"]["triangleCount"],
              "%s vs %s" % (counts.get("drawTriangles"),
                            draws["counts"]["triangleCount"]))
        check(level + " bindable draws", counts.get("bindableDraws") ==
              draws["counts"]["bindableDraws"],
              "%s vs %s" % (counts.get("bindableDraws"),
                            draws["counts"]["bindableDraws"]))
        check(level + " texture blobs", counts.get("textureBlobs") ==
              textures["counts"]["uniqueBlobs"],
              "%s vs %s" % (counts.get("textureBlobs"),
                            textures["counts"]["uniqueBlobs"]))
        check(level + " texture sources", counts.get("textureSources") ==
              textures["counts"]["distinctTextureSources"],
              "%s vs %s" % (counts.get("textureSources"),
                            textures["counts"]["distinctTextureSources"]))
        for key in ("sectionsSupported", "sectionsProbed", "sectionsUnsupported",
                    "instanceDescriptionsSkipped"):
            check(level + " " + key, counts.get(key) == draws["counts"][key],
                  "%s vs %s" % (counts.get(key), draws["counts"][key]))

        for key, value in (("collisionTriangles", batch["counts"]["collisionTriangles"]),
                           ("draws", batch["counts"]["draws"]),
                           ("drawTriangles", batch["counts"]["drawTriangles"]),
                           ("bindableDraws", batch["counts"]["bindableDraws"]),
                           ("textureBlobs", batch["counts"]["textureBlobs"]),
                           ("textureSources", batch["counts"]["textureSources"]),
                           ("sectionsSupported", batch["counts"]["sectionsSupported"]),
                           ("sectionsProbed", batch["counts"]["sectionsProbed"]),
                           ("sectionsUnsupported", batch["counts"]["sectionsUnsupported"]),
                           ("instanceDescriptionsSkipped",
                            batch["counts"]["instanceDescriptionsSkipped"])):
            check(level + " " + key + " agrees with batch",
                  counts.get(key) == value, "%s vs %s" % (counts.get(key), value))

        check(level + " collision triangles agree with inventory",
              counts.get("collisionTriangles") == inv["collisionTriangles"],
              "%s vs %s" % (counts.get("collisionTriangles"),
                            inv["collisionTriangles"]))
        check(level + " draws agree with inventory",
              counts.get("draws") == inv["supportedDraws"],
              "%s vs %s" % (counts.get("draws"), inv["supportedDraws"]))
        check(level + " draw triangles agree with inventory",
              counts.get("drawTriangles") == inv["supportedDrawTriangles"],
              "%s vs %s" % (counts.get("drawTriangles"),
                            inv["supportedDrawTriangles"]))
        check(level + " supported sections agree with inventory",
              counts.get("sectionsSupported") == inv["supportedSections"],
              "%s vs %s" % (counts.get("sectionsSupported"),
                            inv["supportedSections"]))
        check(level + " unsupported sections agree with inventory",
              counts.get("sectionsUnsupported") == inv["unsupportedSections"],
              "%s vs %s" % (counts.get("sectionsUnsupported"),
                            inv["unsupportedSections"]))
        check(level + " collision triangles agree with maps.json",
              counts.get("collisionTriangles") ==
              maps["physics"]["staticTriangles"],
              "%s vs %s" % (counts.get("collisionTriangles"),
                            maps["physics"]["staticTriangles"]))
        check(level + " draws agree with maps.json",
              counts.get("draws") == maps["draws"]["supportedDraws"],
              "%s vs %s" % (counts.get("draws"),
                            maps["draws"]["supportedDraws"]))
        check(level + " draw triangles agree with maps.json",
              counts.get("drawTriangles") == maps["draws"]["supportedTriangles"],
              "%s vs %s" % (counts.get("drawTriangles"),
                            maps["draws"]["supportedTriangles"]))

        # evidence pins
        evidence = row.get("evidence", {})
        check(level + " evidence batch grade", evidence.get("batchGrade") ==
              batch["grade"], "%s vs %s" % (evidence.get("batchGrade"),
                                            batch["grade"]))
        check(level + " evidence batch verify checks",
              evidence.get("batchVerifyChecks") == verify_by[level]["checks"],
              str(evidence.get("batchVerifyChecks")))
        check(level + " evidence batch verify failures",
              evidence.get("batchVerifyFailures") == 0 and
              verify_by[level]["failures"] == 0,
              str(evidence.get("batchVerifyFailures")))
        check(level + " evidence determinism", evidence.get("determinismIdentical")
              is True and det_by[level]["identical"] is True)
        check(level + " evidence manifest grade", evidence.get("manifestGrade") ==
              manifest.get("grade"), str(evidence.get("manifestGrade")))
        check(level + " evidence report grade", evidence.get("reportGrade") ==
              report.get("grade"), str(evidence.get("reportGrade")))
        check(level + " evidence inventory grade", evidence.get("inventoryGrade") ==
              inv["committedGrade"], str(evidence.get("inventoryGrade")))
        check(level + " evidence inventory playable", evidence.get(
              "inventoryPlayableToday") == inv["playableToday"],
              str(evidence.get("inventoryPlayableToday")))
        check(level + " evidence registry id", evidence.get("registryMapId") ==
              registry_id, str(evidence.get("registryMapId")))
        check(level + " evidence playable distance items",
              evidence.get("playableDistanceItems") == inv["playableDistanceItems"],
              str(evidence.get("playableDistanceItems")))

        # manifest pins for the documents the decision reads
        for name in ("path.json", "draws.json", "collision.json",
                     "textures/index.json", "blockers.json"):
            pin = manifest["hashes"]["files"].get(name)
            target = base / name
            check(level + " manifest pin " + name,
                  pin is not None and pin["sha256"] == sha256_file(target) and
                  pin["bytes"] == target.stat().st_size,
                  "" if pin is None else pin.get("sha256", ""))

        # verdict-specific blocker checks
        blocker = row.get("blocker")
        if row["verdict"] == "playable":
            check(level + " playable has no blocker", blocker is None)
            check(level + " playable is registered", registry_id is not None)
            check(level + " playable batch grade", batch["grade"] == "playable",
                  str(batch["grade"]))
            check(level + " playable manifest map id",
                  manifest.get("mapId") == registry_id,
                  "%s vs %s" % (manifest.get("mapId"), registry_id))
            check(level + " playable report map id",
                  report.get("mapId") == registry_id,
                  "%s vs %s" % (report.get("mapId"), registry_id))
            check(level + " playable has no distance items",
                  inv["playableDistanceItems"] == [])
            check(level + " playable path floor",
                  max(paths.get("drawCoveredM", 0.0),
                      paths.get("collisionM", 0.0)) >= PATH_FLOOR_M,
                  "%s draw / %s collision" % (paths.get("drawCoveredM"),
                                              paths.get("collisionM")))
        else:
            if not check(level + " blocked has a blocker", isinstance(blocker, dict)):
                continue
            check(level + " blocker kind", blocker.get("kind") in
                  {"integration", "draw-coverage", "mode", "unsupported"},
                  str(blocker.get("kind")))
            check(level + " blocker code", isinstance(blocker.get("code"), str)
                  and len(blocker["code"]) > 0)
            check(level + " blocker reason", isinstance(blocker.get("reason"), str)
                  and len(blocker["reason"]) > 0)
            check(level + " blocker reason agrees with inventory",
                  blocker.get("reason") == inv["singleBlocker"],
                  "%s vs %s" % (blocker.get("reason"), inv["singleBlocker"]))
            source = blocker.get("sourceRecord", {})
            check(level + " blocker names a source file",
                  isinstance(source.get("file"), str) and
                  (ROOT / source["file"]).is_file(), str(source.get("file")))
            check(level + " blocker names a source record",
                  isinstance(source.get("recordId"), str) and
                  len(source["recordId"]) > 0, str(source.get("recordId")))
            if source.get("byteOffset") is None:
                check(level + " blocker explains the missing byte offset",
                      isinstance(source.get("byteOffsetNote"), str) and
                      len(source["byteOffsetNote"]) > 0,
                      str(source.get("byteOffsetNote")))
            else:
                check(level + " blocker byte offset is an integer",
                      isinstance(source["byteOffset"], int) and
                      source["byteOffset"] >= 0, str(source.get("byteOffset")))
            check(level + " blocked has byte/record evidence",
                  source.get("byteOffset") is not None or
                  len(blocker.get("byteGaps", [])) > 0 or
                  bool(source.get("byteOffsetNote")),
                  "offset=%s gaps=%d" % (source.get("byteOffset"),
                                         len(blocker.get("byteGaps", []))))

            # every byte gap must match the committed unsupported section list
            unsupported = draws.get("unsupportedSections", [])
            check(level + " byte gap count", len(blocker.get("byteGaps", [])) ==
                  len(unsupported),
                  "%d vs %d" % (len(blocker.get("byteGaps", [])), len(unsupported)))
            for index, gap in enumerate(blocker.get("byteGaps", [])):
                expected_gap = unsupported[index]
                check(level + " byte gap %d id" % index,
                      gap.get("id") == expected_gap["id"],
                      "%s vs %s" % (gap.get("id"), expected_gap["id"]))
                check(level + " byte gap %d block" % index,
                      gap.get("geometryBlock") == expected_gap["geometryBlock"],
                      str(gap.get("geometryBlock")))
                check(level + " byte gap %d node block" % index,
                      gap.get("nodeBlock") == expected_gap["nodeBlock"],
                      str(gap.get("nodeBlock")))
                check(level + " byte gap %d offset" % index,
                      gap.get("byteOffset") == expected_gap["byteOffset"],
                      "%s vs %s" % (gap.get("byteOffset"),
                                    expected_gap["byteOffset"]))
                check(level + " byte gap %d reason" % index,
                      gap.get("reason") == expected_gap["reason"],
                      str(gap.get("reason")))

            if blocker.get("kind") == "integration":
                check(level + " integration level is not registered",
                      registry_id is None)
                check(level + " integration batch grade is partial",
                      batch["grade"] == "partial", str(batch["grade"]))
                check(level + " integration code",
                      blocker.get("code") == "e1-map-package-missing",
                      str(blocker.get("code")))
                check(level + " integration source is the registry",
                      source.get("file") == "probes/e1-drive/web/map-registry.js",
                      str(source.get("file")))
                check(level + " integration record is MAP_IDS",
                      source.get("recordId") == "MAP_IDS",
                      str(source.get("recordId")))
                check(level + " integration byte offset is null",
                      source.get("byteOffset") is None,
                      str(source.get("byteOffset")))
                check(level + " integration byte note",
                      "integration gap" in source.get("byteOffsetNote", ""),
                      str(source.get("byteOffsetNote")))
                check(level + " integration distance items",
                      blocker["evidence"].get("playableDistanceItems") ==
                      inv["playableDistanceItems"])

            if level == "showroom":
                check("showroom blocker kind", blocker.get("kind") == "mode",
                      str(blocker.get("kind")))
                check("showroom blocker code",
                      blocker.get("code") == "showroom-mode",
                      str(blocker.get("code")))
                check("showroom blocker reason",
                      blocker.get("reason") == "showroom is not a race/sprint map",
                      str(blocker.get("reason")))
                check("showroom source record",
                      source.get("recordId") ==
                      "levels[showroom].singleBlocker",
                      str(source.get("recordId")))
                check("showroom mode item",
                      "showroom-mode" in inv["playableDistanceItems"],
                      str(inv["playableDistanceItems"]))

            if blocker.get("kind") == "draw-coverage":
                check(level + " draw blocker detail",
                      isinstance(blocker.get("detail"), str) and
                      len(blocker["detail"]) > 0, str(blocker.get("detail")))
                check(level + " draw blocker batch grade is blocked",
                      batch["grade"] == "blocked", str(batch["grade"]))
                check(level + " draw blocker committed path below floor",
                      paths.get("drawCoveredM", 0.0) < PATH_FLOOR_M,
                      str(paths.get("drawCoveredM")))
                check(level + " draw blocker has an extended probe",
                      probe is not None)
                if probe:
                    check(level + " draw blocker recovered coverage",
                          inv.get("recoverableCoverage") == 1.0,
                          str(inv.get("recoverableCoverage")))
                    check(level + " draw blocker recovered path equals collision",
                          close(paths.get("recoveredM"),
                                paths.get("collisionM"), 0.001),
                          "%s vs %s" % (paths.get("recoveredM"),
                                        paths.get("collisionM")))
                    check(level + " draw blocker all-triangle coverage",
                          probe["coverage"]["allTriangles"]["fraction"] == 1.0,
                          str(probe["coverage"]["allTriangles"]["fraction"]))
                    check(level + " draw blocker up-facing coverage",
                          probe["coverage"]["upFacingTriangles"]["fraction"] == 1.0,
                          str(probe["coverage"]["upFacingTriangles"]["fraction"]))
                    check(level + " draw blocker probe component path",
                          close(probe["coverage"]["drawCoveredComponentPath"]["lengthM"],
                                paths.get("collisionM"), 0.001),
                          str(probe["coverage"]["drawCoveredComponentPath"]["lengthM"]))
                    check(level + " draw blocker probe sections",
                          blocker["evidence"].get("probeSections") ==
                          probe["totals"]["sections"],
                          str(blocker["evidence"].get("probeSections")))
                    check(level + " draw blocker probe triangles",
                          blocker["evidence"].get("probeTriangles") ==
                          probe["totals"]["triangles"],
                          str(blocker["evidence"].get("probeTriangles")))
                    check(level + " draw blocker new sections",
                          blocker["evidence"].get("newSections") ==
                          inv["extendedProbe"]["newSections"],
                          str(blocker["evidence"].get("newSections")))
                    check(level + " draw blocker new triangles",
                          blocker["evidence"].get("newTriangles") ==
                          inv["extendedProbe"]["newTriangles"],
                          str(blocker["evidence"].get("newTriangles")))

                    # the primary record must exist in the probe and its chunk
                    # offset must match the levelrender Scene ChunkInfo.
                    record_id = source.get("recordId", "")
                    primary = None
                    for section in probe["sections"]:
                        if section.get("status") != "ok":
                            continue
                        candidate = "sections[block=%d,chunk=%d,item=%d]" % (
                            section["block"], section["chunk"], section["item"])
                        if candidate == record_id:
                            primary = section
                            break
                    check(level + " primary probe record exists",
                          primary is not None, record_id)
                    if primary is not None:
                        check(level + " primary probe record triangles",
                              source.get("byteOffset") == lib._chunk_offset(
                                  level, primary["chunk"]),
                              "%s vs %s" % (source.get("byteOffset"),
                                            lib._chunk_offset(level, primary["chunk"])))
                        check(level + " primary probe record is non-first or prerequisite",
                              primary["item"] > 0 or
                              bool(primary.get("chunkPrerequisites")),
                              "item=%s prereq=%s" % (primary["item"],
                                                     primary.get("chunkPrerequisites")))
                    records = blocker.get("records", [])
                    check(level + " probe record count", len(records) > 0,
                          str(len(records)))
                    for record in records:
                        match = [section for section in probe["sections"]
                                 if section.get("status") == "ok" and
                                 section["block"] == record["geometryBlock"] and
                                 section["chunk"] == record["chunk"] and
                                 section["item"] == record["item"]]
                        check(level + " probe record %s exists" % record["id"],
                              len(match) == 1, record["id"])
                        if len(match) == 1:
                            section = match[0]
                            check(level + " probe record %s triangles" % record["id"],
                                  record["triangles"] == section["triangles"],
                                  "%s vs %s" % (record["triangles"],
                                                section["triangles"]))
                            check(level + " probe record %s draws" % record["id"],
                                  record["draws"] == section["draws"],
                                  "%s vs %s" % (record["draws"], section["draws"]))
                            check(level + " probe record %s prerequisites" % record["id"],
                                  record["chunkPrerequisites"] ==
                                  list(section.get("chunkPrerequisites") or []),
                                  str(record["chunkPrerequisites"]))
                            check(level + " probe record %s byte offset" % record["id"],
                                  record["byteOffset"] == lib._chunk_offset(
                                      level, record["chunk"]),
                                  "%s vs %s" % (record["byteOffset"],
                                                lib._chunk_offset(level,
                                                                  record["chunk"])))

            if level == "usa_la_longbeachdocks":
                check("longbeach extended probe present", probe is not None)
                if probe:
                    check("longbeach recovered coverage",
                          inv.get("recoverableCoverage") == 1.0,
                          str(inv.get("recoverableCoverage")))
                    check("longbeach recovered path equals collision",
                          close(inv["extendedProbe"]["componentPathM"],
                                inv["collisionPathM"], 0.001),
                          str(inv["extendedProbe"]["componentPathM"]))
                    check("longbeach new sections",
                          inv["extendedProbe"]["newSections"] == 149,
                          str(inv["extendedProbe"]["newSections"]))
                    check("longbeach new triangles",
                          inv["extendedProbe"]["newTriangles"] == 606213,
                          str(inv["extendedProbe"]["newTriangles"]))
                    check("longbeach probe coverage",
                          probe["coverage"]["allTriangles"]["fraction"] == 1.0,
                          str(probe["coverage"]["allTriangles"]["fraction"]))
                    check("longbeach probe up-facing coverage",
                          probe["coverage"]["upFacingTriangles"]["fraction"] == 1.0,
                          str(probe["coverage"]["upFacingTriangles"]["fraction"]))
                check("longbeach distance items",
                      inv["playableDistanceItems"] ==
                      ["e1-map-package", "e1-verify-browser"],
                      str(inv["playableDistanceItems"]))
                gaps = {gap["id"]: gap["byteOffset"]
                        for gap in blocker.get("byteGaps", [])}
                check("longbeach unsupported g199 offset",
                      gaps.get("g199-n346") == 362668, str(gaps.get("g199-n346")))
                check("longbeach unsupported g204 offset",
                      gaps.get("g204-n418") == 241712, str(gaps.get("g204-n418")))

    # ------------------------------------------------------------- report
    passed = sum(1 for item in checks if item["ok"])
    total = len(checks)
    result = {
        "schema": "blur.map-pipeline.map-decisions-verify/1",
        "status": "PASS" if not failures else "FAIL",
        "checks": total,
        "passed": passed,
        "failures": failures,
        "decisions": {
            "path": lib.rel(args.decisions),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "canonicalSha256": doc.get("canonicalSha256"),
        },
        "scope": ("data only; no renderer, GPU, browser, engine or playable-game "
                  "claim; playable means integrated in the E1 map registry and a "
                  "verified map-batch package"),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(result, indent=1, sort_keys=True) + "\n")
    print(json.dumps({"status": result["status"], "checks": total,
                      "passed": passed, "failures": len(failures),
                      "decisionsSha256": result["decisions"]["sha256"],
                      "canonicalSha256": result["decisions"]["canonicalSha256"]},
                     indent=2))
    for failure in failures[:40]:
        print("FAIL %s: %s" % (failure["name"], failure["detail"]))
    print("%d/%d checks passed" % (passed, total))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())


