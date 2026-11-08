#!/usr/bin/env python3
"""Shared, read-only derivation of the 19-level map decision document.

The document answers one question per level directory: can it become a playable
map today, and if not, which committed record blocks it?

Every field is derived from the committed probe/batch documents:

  _work/map-pipeline/maps.json
  _work/map-pipeline/inventory.json
  _work/map-pipeline/blocked/inventory-19.json
  _work/map-pipeline/<level>-probe/probe.json          (3 extended probes)
  _work/map-batch/batch-summary.json
  _work/map-batch/determinism.json
  _work/map-batch/verify.json
  _work/map-batch/<level>/{manifest,report,path,draws,collision,blockers}.json
  _work/map-batch/<level>/textures/index.json
  probes/e1-drive/web/map-registry.js                  (integration fact)
  docs/work/analysis/localization.md#3.2               (city names)

No renderer, GPU, browser, engine or playable-game claim is made. "Playable"
means the level is integrated in the E1 map registry and its map-batch package
verifies; it is not a frame or a drive claim.

This module writes nothing. `build_map_decisions.py` serialises the result and
`verify_map_decisions.py` re-derives it and compares.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WORK = ROOT / "_work/map-pipeline"
BATCH = ROOT / "_work/map-batch"
DECISIONS_PATH = ROOT / "probes/map-pipeline/data/map-decisions.json"

SCHEMA = "blur.map-pipeline.map-decisions/1"
PATH_FLOOR_M = 25.0
CITY_SOURCE = "docs/work/analysis/localization.md#3.2"
REGISTRY_PATH = ROOT / "probes/e1-drive/web/map-registry.js"
LOCALIZATION_PATH = ROOT / "docs/work/analysis/localization.md"

# The extended probes that carry a byte-level extractor proof. The preferred
# blocks are the geometry blocks named by the probe document's node chunks
# (docs/work/analysis/map-pipeline-blocked.md §4.3).
PROBE_PREFERRED_BLOCKS = {
    "spa_barcelona_bowl_multiplayer": {15, 18, 26},
    "usa_la_multiplayer_highrise": {7, 10, 11, 14, 15},
    "usa_la_longbeachdocks": set(),
}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT)).replace("\\", "/")


def source(path: Path) -> dict:
    return {"path": rel(path), "bytes": path.stat().st_size,
            "sha256": sha256_file(path)}


def content_hash(doc, volatile: set[str]) -> str:
    """Hash a document with volatile timing fields removed.

    `batch-summary.json` carries per-level timings and `verify.json` carries a
    wall-clock `seconds`; neither is a decision input. Pinning only the stable
    content keeps the decision document reproducible after the batch verifier
    rewrites its timing field.
    """
    def strip(value):
        if isinstance(value, dict):
            return {key: strip(item) for key, item in value.items()
                    if key not in volatile}
        if isinstance(value, list):
            return [strip(item) for item in value]
        return value

    text = json.dumps(strip(doc), sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def content_source(path: Path, volatile: set[str]) -> dict:
    return {"path": rel(path),
            "contentSha256": content_hash(load_json(path), volatile),
            "volatileFields": sorted(volatile),
            "pin": "content"}


def level_dirs() -> list[str]:
    return sorted(path.name for path in (ROOT / "game-data/Blur/levels").iterdir()
                  if path.is_dir())


def parse_registry(text: str) -> dict:
    """Read MAP_IDS and the id -> level mapping from the E1 registry.

    The registry is a frozen JS module. Only the two exported facts needed for
    the integration decision are read: the accepted map ids and each map's
    level directory. No JavaScript is executed.
    """
    match = re.search(r"MAP_IDS\s*=\s*Object\.freeze\(\[(.*?)\]\)", text, re.S)
    if not match:
        raise ValueError("MAP_IDS not found in map-registry.js")
    map_ids = re.findall(r"'([^']+)'", match.group(1))
    by_level: dict[str, str] = {}
    by_id: dict[str, str] = {}
    for map_id in map_ids:
        entry = re.search(
            r"id:\s*'%s'[\s\S]{0,800}?level:\s*'([^']+)'" % re.escape(map_id),
            text)
        if not entry:
            raise ValueError("registry entry for %s has no level" % map_id)
        level = entry.group(1)
        if level in by_level:
            raise ValueError("registry level %s appears twice" % level)
        by_level[level] = map_id
        by_id[map_id] = level
    return {"mapIds": map_ids, "byLevel": by_level, "byId": by_id}


def parse_localization(text: str) -> dict:
    """Read the 19 level -> (city key, English city) rows from the analysis."""
    cities: dict[str, dict] = {}
    for line in text.splitlines():
        match = re.match(
            r"^\|\s*`([a-z0-9_]+)`\s*\|\s*`([A-Z0-9_]+)`\s*\|\s*([^|]+?)\s*\|",
            line)
        if not match:
            continue
        level, city_key, city = match.group(1), match.group(2), match.group(3).strip()
        if level in cities:
            raise ValueError("duplicate localization row for %s" % level)
        cities[level] = {"cityKey": city_key, "city": city}
    return cities


def load_sources() -> dict:
    maps_path = WORK / "maps.json"
    inventory_path = WORK / "inventory.json"
    blocked_path = WORK / "blocked/inventory-19.json"
    batch_path = BATCH / "batch-summary.json"
    determinism_path = BATCH / "determinism.json"
    verify_path = BATCH / "verify.json"
    return {
        "maps": load_json(maps_path),
        "inventory": load_json(inventory_path),
        "blocked": load_json(blocked_path),
        "batch": load_json(batch_path),
        "determinism": load_json(determinism_path),
        "batchVerify": load_json(verify_path),
        "registry": parse_registry(REGISTRY_PATH.read_text(encoding="utf-8")),
        "cities": parse_localization(LOCALIZATION_PATH.read_text(encoding="utf-8")),
        "paths": {
            "maps": maps_path,
            "inventory": inventory_path,
            "blocked": blocked_path,
            "batch": batch_path,
            "determinism": determinism_path,
            "batchVerify": verify_path,
            "registry": REGISTRY_PATH,
            "localization": LOCALIZATION_PATH,
        },
    }


def _chunk_offset(level: str, chunk_index: int) -> int:
    """Re-read the levelrender Scene ChunkInfo and return the chunk offset."""
    tools = str(ROOT / "tools")
    if tools not in sys.path:
        sys.path.insert(0, tools)
    from inspect_car_level_assets import render_layout  # noqa: E402

    data = (ROOT / "game-data/Blur/levels" / level / "level.levelrender").read_bytes()
    scene = render_layout(data, "level")["scene"]
    return int(scene["stream"]["chunks"][chunk_index]["offset"])


def _probe_records(level: str, probe: dict) -> list[dict]:
    """The probe sections that carry the extractor proof, with chunk offsets."""
    preferred = PROBE_PREFERRED_BLOCKS.get(level, set())
    rows = [section for section in probe["sections"]
            if section.get("status") == "ok"
            and (not preferred or section.get("block") in preferred)]
    records = []
    for section in rows:
        records.append({
            "id": "g%d-n%d" % (section["block"], section["nodeBlock"]),
            "geometryBlock": int(section["block"]),
            "nodeBlock": int(section["nodeBlock"]),
            "chunk": int(section["chunk"]),
            "item": int(section["item"]),
            "byteOffset": _chunk_offset(level, int(section["chunk"])),
            "byteOffsetKind": "levelstream chunk offset",
            "triangles": int(section["triangles"]),
            "draws": int(section["draws"]),
            "chunkPrerequisites": list(section.get("chunkPrerequisites") or []),
            "reason": ("non-first chunk item" if int(section["item"]) > 0
                       else "chunk with declared prerequisites"),
        })
    records.sort(key=lambda row: (row["geometryBlock"], row["chunk"], row["item"]))
    return records


def _primary_probe_record(records: list[dict]) -> dict | None:
    """Prefer a non-first item, then the largest triangle count.

    A non-first item demonstrates both committed extractor conditions at once
    (the block is not the chunk's first item and the chunk declares
    prerequisites). If every preferred section is a first item, the largest
    prerequisite chunk is the representative record.
    """
    if not records:
        return None
    non_first = [row for row in records if row["item"] > 0]
    pool = non_first or records
    return max(pool, key=lambda row: (row["triangles"], row["geometryBlock"]))


def _unsupported_sections(level: str, draws: dict, draws_path: Path) -> list[dict]:
    rows = []
    for section in draws.get("unsupportedSections", []):
        rows.append({
            "id": section["id"],
            "geometryBlock": int(section["geometryBlock"]),
            "nodeBlock": int(section["nodeBlock"]),
            "byteOffset": int(section["byteOffset"]),
            "reason": section["reason"],
            "source": rel(draws_path) + "#unsupportedSections",
        })
    return rows


def _verdict(level: str, registry_id: str | None, batch_grade: str) -> str:
    if registry_id:
        return "playable"
    return "blocked"


def _blocker(level: str, verdict: str, registry_id: str | None,
             batch_grade: str, inventory: dict, probe: dict | None,
             probe_path: Path | None, probe_records: list[dict],
             byte_gaps: list[dict], registry_ids: list[str]) -> dict | None:
    if verdict == "playable":
        return None

    if batch_grade == "blocked":
        primary = _primary_probe_record(probe_records)
        if primary is None:
            raise ValueError("%s is draw-blocked but has no probe record" % level)
        return {
            "kind": "draw-coverage",
            "code": "extractor-chunk-association",
            "reason": inventory["singleBlocker"],
            "detail": ("committed first-RenderList extraction covers less than the "
                       "25 m audit floor; the drivable geometry is in a non-first "
                       "chunk item and/or a chunk with declared prerequisites"),
            "sourceRecord": {
                "file": rel(probe_path) if probe_path else "",
                "recordId": "sections[block=%d,chunk=%d,item=%d]" % (
                    primary["geometryBlock"], primary["chunk"], primary["item"]),
                "byteOffset": primary["byteOffset"],
                "byteOffsetKind": primary["byteOffsetKind"],
                "detail": ("block %d, chunk %d, item %d, %d triangles, %d draws, "
                           "chunk prerequisites %s" % (
                               primary["geometryBlock"], primary["chunk"],
                               primary["item"], primary["triangles"],
                               primary["draws"], primary["chunkPrerequisites"])),
            },
            "records": probe_records,
            "byteGaps": byte_gaps,
            "evidence": {
                "committedDrawCoveredM": inventory["drawCoveredPathM"],
                "recoveredDrawCoveredM": inventory["extendedProbe"]["componentPathM"],
                "recoveredCoverage": inventory["recoverableCoverage"],
                "collisionPathM": inventory["collisionPathM"],
                "committedSections": inventory["extendedProbe"]["committedSections"],
                "probeSections": inventory["extendedProbe"]["sections"],
                "probeTriangles": inventory["extendedProbe"]["triangles"],
                "newSections": inventory["extendedProbe"]["newSections"],
                "newTriangles": inventory["extendedProbe"]["newTriangles"],
            },
        }

    if level == "showroom":
        return {
            "kind": "mode",
            "code": "showroom-mode",
            "reason": inventory["singleBlocker"],
            "sourceRecord": {
                "file": "_work/map-pipeline/blocked/inventory-19.json",
                "recordId": "levels[showroom].singleBlocker",
                "byteOffset": None,
                "byteOffsetNote": ("mode gap: the level is a showroom, not a "
                                   "race/sprint; the missing record is a showroom "
                                   "mode, not a byte range"),
                "detail": inventory["singleBlocker"],
            },
            "records": [],
            "byteGaps": byte_gaps,
            "evidence": {
                "playableDistanceItems": inventory["playableDistanceItems"],
                "batchGrade": batch_grade,
            },
        }

    return {
        "kind": "integration",
        "code": "e1-map-package-missing",
        "reason": inventory["singleBlocker"],
        "sourceRecord": {
            "file": rel(REGISTRY_PATH),
            "recordId": "MAP_IDS",
            "byteOffset": None,
            "byteOffsetNote": ("integration gap: the level bytes and the map-batch "
                               "package exist; the missing record is the E1 registry "
                               "entry, not a byte range"),
            "detail": ("MAP_IDS has no entry for %s; registry ids are %s" % (
                level, ", ".join(sorted(registry_ids)))),
        },
        "records": [],
        "byteGaps": byte_gaps,
        "evidence": {
            "playableDistanceItems": inventory["playableDistanceItems"],
            "batchGrade": batch_grade,
            "extendedProbe": (None if not inventory.get("extendedProbe") else {
                "sections": inventory["extendedProbe"]["sections"],
                "triangles": inventory["extendedProbe"]["triangles"],
                "newSections": inventory["extendedProbe"]["newSections"],
                "newTriangles": inventory["extendedProbe"]["newTriangles"],
                "coverageFraction": inventory["extendedProbe"]["coverageFraction"],
                "recoveredPathM": inventory["extendedProbe"]["componentPathM"],
            }),
        },
    }


def _verdict_reason(level: str, verdict: str, batch_grade: str,
                    inventory: dict) -> str:
    if verdict == "playable":
        return ("integrated in probes/e1-drive/web/map-registry.js MAP_IDS and "
                "the map-batch package verifies")
    if batch_grade == "blocked":
        return ("committed first-RenderList extraction covers %.3f m of the "
                "%.3f m collision path; the extended probe recovers %.3f m "
                "(coverage %.3f); the blocker is the extractor's first-item / "
                "no-prerequisite chunk policy" % (
                    inventory["drawCoveredPathM"], inventory["collisionPathM"],
                    inventory["extendedProbe"]["componentPathM"],
                    inventory["recoverableCoverage"]))
    if level == "showroom":
        return ("showroom is not a race/sprint map; it needs a showroom mode, "
                "not a sprint layout")
    return ("no committed retail spawn/course and no E1 map package; the "
            "map-batch package verifies but is not integrated")


def build_document() -> dict:
    src = load_sources()
    maps_by = {row["name"]: row for row in src["maps"]["levels"]}
    inv_by = {row["name"]: row for row in src["inventory"]["levels"]}
    blocked_by = {row["level"]: row for row in src["blocked"]["levels"]}
    batch_by = {row["level"]: row for row in src["batch"]["levels"]}
    verify_by = {row["level"]: row for row in src["batchVerify"]["levels"]}
    det_by = {row["level"]: row for row in src["determinism"]["levels"]}
    levels = level_dirs()

    expected = set(levels)
    for label, table in (("maps.json", maps_by), ("inventory.json", inv_by),
                         ("blocked inventory", blocked_by),
                         ("batch summary", batch_by),
                         ("batch verify", verify_by),
                         ("determinism", det_by),
                         ("localization", src["cities"])):
        if set(table) != expected:
            raise ValueError("%s level set differs: missing=%s extra=%s" % (
                label, sorted(expected - set(table)), sorted(set(table) - expected)))
    if len(levels) != 19:
        raise ValueError("expected 19 level directories, found %d" % len(levels))

    rows = []
    for level in levels:
        batch = batch_by[level]
        inv = blocked_by[level]
        registry_id = src["registry"]["byLevel"].get(level)
        batch_grade = batch["grade"]
        verdict = _verdict(level, registry_id, batch_grade)
        if registry_id and batch_grade != "playable":
            raise ValueError("%s is registered but batch grade is %s" % (level, batch_grade))
        if not registry_id and batch_grade == "playable":
            raise ValueError("%s has a playable batch grade but no registry entry" % level)

        base = BATCH / level
        report = load_json(base / "report.json")
        manifest = load_json(base / "manifest.json")
        path = load_json(base / "path.json")
        draws = load_json(base / "draws.json")
        collision = load_json(base / "collision.json")
        textures = load_json(base / "textures/index.json")
        blockers = load_json(base / "blockers.json")
        for label, doc in (("report", report), ("path", path), ("draws", draws),
                           ("collision", collision), ("textures", textures),
                           ("blockers", blockers)):
            if doc.get("level") != level:
                raise ValueError("%s %s level is %r" % (level, label, doc.get("level")))

        probe = None
        probe_path = None
        if inv.get("extendedProbe"):
            probe_path = ROOT / inv["extendedProbe"]["file"]
            probe = load_json(probe_path)
            if probe.get("level") != level:
                raise ValueError("%s probe level is %r" % (level, probe.get("level")))

        probe_records = _probe_records(level, probe) if probe else []
        byte_gaps = _unsupported_sections(level, draws, base / "draws.json")
        blocker = _blocker(level, verdict, registry_id, batch_grade, inv,
                           probe, probe_path, probe_records, byte_gaps,
                           src["registry"]["mapIds"])
        city = src["cities"][level]
        recovered = (float(probe["coverage"]["drawCoveredComponentPath"]["lengthM"])
                     if probe and probe["coverage"].get("drawCoveredComponentPath")
                     else None)

        counts = {
            "collisionTriangles": int(collision["counts"]["triangles"]),
            "collisionVertices": int(collision["counts"]["vertices"]),
            "draws": int(draws["counts"]["drawCount"]),
            "drawTriangles": int(draws["counts"]["triangleCount"]),
            "bindableDraws": int(draws["counts"]["bindableDraws"]),
            "textureBlobs": int(textures["counts"]["uniqueBlobs"]),
            "textureSources": int(textures["counts"]["distinctTextureSources"]),
            "sectionsSupported": int(draws["counts"]["sectionsSupported"]),
            "sectionsProbed": int(draws["counts"]["sectionsProbed"]),
            "sectionsUnsupported": int(draws["counts"]["sectionsUnsupported"]),
            "instanceDescriptionsSkipped": int(
                draws["counts"]["instanceDescriptionsSkipped"]),
        }

        rows.append({
            "level": level,
            "city": city["city"],
            "cityKey": city["cityKey"],
            "citySource": CITY_SOURCE,
            "kind": inv["kind"],
            "distanceRank": int(inv["distanceRank"]),
            "verdict": verdict,
            "verdictReason": _verdict_reason(level, verdict, batch_grade, inv),
            "paths": {
                "drawCoveredM": float(path["drawCovered"]["lengthM"]),
                "collisionM": float(path["collisionOnly"]["lengthM"]),
                "packageM": float(path["lengthM"]),
                "packageKind": path["kind"],
                "recoveredM": recovered,
                "samples": int(path["sampleCount"]),
            },
            "counts": counts,
            "blocker": blocker,
            "evidence": {
                "batchGrade": batch_grade,
                "batchVerifyChecks": int(verify_by[level]["checks"]),
                "batchVerifyFailures": int(verify_by[level]["failures"]),
                "determinismIdentical": bool(det_by[level]["identical"]),
                "manifestMapId": manifest.get("mapId"),
                "manifestGrade": manifest.get("grade"),
                "reportMapId": report.get("mapId"),
                "reportGrade": report.get("grade"),
                "inventoryGrade": inv["committedGrade"],
                "inventoryPlayableToday": bool(inv["playableToday"]),
                "inventorySingleBlocker": inv["singleBlocker"],
                "playableDistanceItems": list(inv["playableDistanceItems"]),
                "registryMapId": registry_id,
            },
        })

    rows.sort(key=lambda row: row["distanceRank"])
    playable = [row["level"] for row in rows if row["verdict"] == "playable"]
    blocked = [row["level"] for row in rows if row["verdict"] == "blocked"]
    unsupported = [row["level"] for row in rows if row["verdict"] == "unsupported"]
    doc = {
        "schema": SCHEMA,
        "generatedBy": "probes/map-pipeline/tools/build_map_decisions.py",
        "scope": ("one decision per shipped level directory, derived from the "
                  "committed map-pipeline and map-batch documents; no renderer, "
                  "GPU, browser, engine or playable-game claim"),
        "rules": {
            "playable": ("level is integrated in probes/e1-drive/web/map-registry.js "
                         "MAP_IDS and its map-batch package verifies"),
            "blocked": ("a committed record prevents playable today; the blocker "
                        "is named with its source record and, where the blocker is "
                        "byte-level, its byte offset"),
            "unsupported": ("no buildable package or no measured path exists, so "
                            "the level cannot be decided from committed data"),
            "pathFloorM": PATH_FLOOR_M,
        },
        "sources": {
            "maps": source(src["paths"]["maps"]),
            "inventory": source(src["paths"]["inventory"]),
            "blockedInventory": source(src["paths"]["blocked"]),
            "batchSummary": content_source(src["paths"]["batch"],
                                           {"timings", "totalSeconds"}),
            "batchDeterminism": source(src["paths"]["determinism"]),
            "batchVerify": content_source(src["paths"]["batchVerify"],
                                          {"seconds"}),
            "mapRegistry": source(src["paths"]["registry"]),
            "localization": source(src["paths"]["localization"]),
        },
        "summary": {
            "levelCount": len(rows),
            "counts": {"playable": len(playable), "blocked": len(blocked),
                       "unsupported": len(unsupported)},
            "playable": playable,
            "blocked": blocked,
            "unsupported": unsupported,
            "playableSource": "probes/e1-drive/web/map-registry.js#MAP_IDS",
            "premiseNote": ("The committed registry MAP_IDS is river/amboy/gracia. "
                            "usa_la_longbeachdocks has a verified map-batch package "
                            "and an 818.372 m committed draw-covered path, but no E1 "
                            "map-registry entry, so it is blocked by two integration "
                            "items, not playable. The '4 playable maps' premise is "
                            "not supported by the committed registry in this tree."),
        },
        "levels": rows,
    }
    doc["canonicalSha256"] = canonical_hash(doc)
    return doc


def canonical_hash(doc: dict) -> str:
    body = {key: value for key, value in doc.items() if key != "canonicalSha256"}
    text = json.dumps(body, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def serialise(doc: dict) -> str:
    return json.dumps(doc, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
