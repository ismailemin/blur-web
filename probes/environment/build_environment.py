#!/usr/bin/env python3
"""Build the per-map environment classification and the ranked add plan.

Outputs (generated game data, not committed):

* ``_work/environment/<short>/environment.json`` - sky/fog/lighting values with
  their XT record chain and the sky texture descriptor.
* ``_work/environment/<short>/groups.json`` - every draw classified into one
  semantic group, with per-group section ids, counts, textures, byte budget and
  drawable verdict.
* ``_work/environment/<short>/excluded-draws.json`` - one row per excluded draw.
* ``_work/environment/plan.json`` - ranking by measured angular coverage per MB
  and the smallest first-add set with exact section ids.
* ``_work/environment/manifest.json`` - input and output pins.

Data only: no renderer, GPU, browser or e1-drive change is made.
"""
from __future__ import annotations

import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from env_common import (  # noqa: E402
    BINDABLE, DISTANT_M, GROUP_LABEL, GROUP_ORDER, LEVELS, ROOT, STATUS_LABEL,
    box_distance_xz, canonical_hash, classify_draw, dump_json, fnum,
    group_visual_metrics, level_environment, load_map, playable_predicate,
    sha256_file,
)

OUT = ROOT / "_work/environment"


def _section_rows(pkg: dict) -> dict:
    rows = {}
    for sid, sec in pkg["sections"].items():
        rows[sid] = dict(sec)
        rows[sid]["distanceM"] = fnum(box_distance_xz(sec["bounds"], pkg["paths"]), 3)
    return rows


def _virtual_groups(pkg: dict, cfg: dict) -> list:
    out = []
    blockers = pkg["blockers"]
    if blockers:
        summary = blockers["instances"]["summary"]
        out.append({
            "id": "instance-geometry",
            "label": GROUP_LABEL["instance-geometry"],
            "category": "instance-only",
            "rules": ["instancesApplied:false"],
            "sections": [],
            "sectionCount": summary.get("sections", 0),
            "drawCount": 0,
            "triangleCount": 0,
            "instanceDescriptions": summary.get("instances", 0),
            "triangleUpperBound": summary.get("triangleUpperBound", 0),
            "textures": {"count": 0, "rgbaBytes": 0, "ids": [], "names": []},
            "bytes": {"index": 0, "vertexUpper": 0, "textureRgba": 0, "totalUpper": 0},
            "visual": {"meanAngularCoverageDeg": 0.0, "maxElevationDeg": 0.0, "samples": 0},
            "drawableNow": False,
            "blockedReasons": ["instances not applied by the committed reader"],
        })
    unsupported = pkg["unsupported"]
    if unsupported:
        estimated = sum((u.get("estimatedSourceIndexCount") or 0) for u in unsupported)
        out.append({
            "id": "unsupported-section",
            "label": GROUP_LABEL["unsupported-section"],
            "category": "reader-blocked",
            "rules": ["POSITION0 type 7"],
            "sections": [{"id": u["id"], "reason": u["reason"]} for u in unsupported],
            "sectionCount": len(unsupported),
            "drawCount": 0,
            "triangleCount": 0,
            "estimatedSourceIndexCount": estimated,
            "estimatedTriangles": estimated // 3 if estimated else None,
            "textures": {"count": 0, "rgbaBytes": 0, "ids": [], "names": []},
            "bytes": {"index": 0, "vertexUpper": 0, "textureRgba": 0, "totalUpper": 0},
            "visual": {"meanAngularCoverageDeg": 0.0, "maxElevationDeg": 0.0, "samples": 0},
            "drawableNow": False,
            "blockedReasons": ["no POSITION0 type-7 decoder"],
        })
    return out


def _subset(rows: list, textures: dict) -> dict:
    tri = sum(r["triangleCount"] for r in rows)
    index_count = sum(r["indexCount"] for r in rows)
    tex_ids = sorted({r["textureId"] for r in rows if r["textureId"]})
    rgba = sum(textures[t]["rgbaBytes"] for t in tex_ids if t in textures)
    return {
        "draws": len(rows),
        "triangles": tri,
        "indexBytes": index_count * 4,
        "vertexUpperBytes": tri * 3 * 20,
        "textureRgbaBytes": rgba,
        "totalUpperBytes": index_count * 4 + tri * 3 * 20 + rgba,
        "textureIds": tex_ids,
        "sectionIds": sorted({r["section"] for r in rows}),
    }


def analyse(cfg: dict) -> dict:
    pkg = load_map(cfg)
    sections = _section_rows(pkg)
    in_set = playable_predicate(pkg)
    draw_rows = []
    groups = defaultdict(list)
    for draw in pkg["draws"]:
        sec = sections.get(draw["section"])
        if sec is None:
            raise KeyError("draw references unknown section " + draw["section"])
        cls = classify_draw(draw, sec["distanceM"])
        row = dict(draw)
        row["group"] = cls["group"]
        row["rule"] = cls["rule"]
        row["inCurrentSet"] = bool(in_set(draw))
        row["excluded"] = not row["inCurrentSet"]
        row["distanceM"] = sec["distanceM"]
        draw_rows.append(row)
        groups[cls["group"]].append(row)

    texture_names = {}
    group_records = []
    for gid in GROUP_ORDER:
        rows = groups.get(gid)
        if not rows:
            continue
        sec_ids = sorted({r["section"] for r in rows})
        tri = sum(r["triangleCount"] for r in rows)
        index_count = sum(r["indexCount"] for r in rows)
        tex_ids = sorted({r["textureId"] for r in rows if r["textureId"]})
        rgba = sum(pkg["textures"][t]["rgbaBytes"] for t in tex_ids
                   if t in pkg["textures"])
        names = sorted({(r["textureName"] or "") for r in rows if r["textureName"]})
        status = Counter(r["status"] for r in rows)
        excluded = [r for r in rows if r["excluded"]]
        bindable_excluded = [r for r in excluded if r["bindable"]]
        blocked_excluded = [r for r in excluded if not r["bindable"]]
        secs = []
        for sid in sec_ids:
            srows = [r for r in rows if r["section"] == sid]
            secs.append({
                "id": sid,
                "draws": len(srows),
                "triangles": sum(r["triangleCount"] for r in srows),
                "distanceM": sections[sid]["distanceM"],
            })
        sec_bounds = [{"id": sid, "bounds": sections[sid]["bounds"]} for sid in sec_ids]
        visual = group_visual_metrics(sec_bounds, pkg["paths"])
        bindable_sec_ids = sorted({r["section"] for r in bindable_excluded})
        visual_excluded = group_visual_metrics(
            [{"id": sid, "bounds": sections[sid]["bounds"]} for sid in bindable_sec_ids],
            pkg["paths"])
        reasons = sorted({STATUS_LABEL.get(s, s) for s in status if s != BINDABLE})
        record = {
            "id": gid,
            "label": GROUP_LABEL[gid],
            "category": gid,
            "rules": sorted({r["rule"] for r in rows}),
            "sections": secs,
            "sectionCount": len(sec_ids),
            "drawCount": len(rows),
            "triangleCount": tri,
            "drawsInCurrentSet": len(rows) - len(excluded),
            "drawsExcluded": len(excluded),
            "trianglesExcluded": sum(r["triangleCount"] for r in excluded),
            "status": dict(sorted(status.items())),
            "textures": {"count": len(tex_ids), "rgbaBytes": rgba,
                         "ids": tex_ids, "names": names},
            "bytes": {
                "index": index_count * 4,
                "vertexUpper": tri * 3 * 20,
                "textureRgba": rgba,
                "totalUpper": index_count * 4 + tri * 3 * 20 + rgba,
            },
            "distance": {
                "minM": fnum(min(s["distanceM"] for s in secs), 3),
                "maxM": fnum(max(s["distanceM"] for s in secs), 3),
            },
            "visual": visual,
            "visualExcluded": visual_excluded,
            "excludedBindable": _subset(bindable_excluded, pkg["textures"]),
            "excludedBlocked": _subset(blocked_excluded, pkg["textures"]),
            "drawableNow": bool(bindable_excluded),
            "fullyDrawable": bool(bindable_excluded) and not blocked_excluded,
            "blockedReasons": reasons if blocked_excluded else [],
            "excludedReasons": _excluded_reasons(cfg, excluded),
        }
        group_records.append(record)

    # Sky/atmosphere is a virtual group: no level geometry, values from the XT
    # environment record plus code-derived dome and fog.
    env = level_environment(cfg["level"])
    sky_bytes = env["sky"]["textureDescriptor"]["declaredChainBytes"]
    sky = {
        "id": "sky-atmosphere",
        "label": GROUP_LABEL["sky-atmosphere"],
        "category": "background-pass",
        "rules": ["EnvironmentSettings.skySettings + FogSettings"],
        "sections": [],
        "sectionCount": 0,
        "drawCount": 0,
        "triangleCount": 0,
        "drawsInCurrentSet": 0,
        "drawsExcluded": 0,
        "trianglesExcluded": 0,
        "status": {},
        "textures": {"count": 1, "rgbaBytes": sky_bytes,
                     "ids": [env["sky"]["texture"]],
                     "names": [env["sky"]["texture"].rsplit("/", 1)[-1]]},
        "bytes": {"index": 0, "vertexUpper": 676 * 20,
                  "textureRgba": sky_bytes,
                  "totalUpper": 676 * 20 + sky_bytes},
        "distance": {"minM": 0.0, "maxM": 0.0},
        "visual": {"meanSolidAngleSr": fnum(2.0 * math.pi, 6),
                   "hemispherePercent": 100.0, "maxElevationDeg": 90.0,
                   "samples": len(pkg["paths"])},
        "visualExcluded": {"meanSolidAngleSr": fnum(2.0 * math.pi, 6),
                           "hemispherePercent": 100.0, "maxElevationDeg": 90.0,
                           "samples": len(pkg["paths"])},
        "excludedBindable": {
            "draws": 0, "triangles": 0, "indexBytes": 0, "vertexUpperBytes": 676 * 20,
            "textureRgbaBytes": sky_bytes, "totalUpperBytes": 676 * 20 + sky_bytes,
            "textureIds": [env["sky"]["texture"]],
        },
        "excludedBlocked": {"draws": 0, "triangles": 0, "indexBytes": 0,
                            "vertexUpperBytes": 0, "textureRgbaBytes": 0,
                            "totalUpperBytes": 0, "textureIds": []},
        "drawableNow": True,
        "fullyDrawable": True,
        "blockedReasons": [],
        "excludedReasons": ["no background pass in e1-drive"],
        "isBasePass": True,
    }
    group_records.append(sky)

    totals = {
        "draws": len(draw_rows),
        "triangles": sum(r["triangleCount"] for r in draw_rows),
        "vertices": sum(s["vertexCount"] for s in sections.values()),
        "indexCount": sum(s["indexCount"] for s in sections.values()),
        "sections": len(sections),
        "unsupportedSections": len(pkg["unsupported"]),
        "textures": len(pkg["textures"]),
        "textureRgbaBytes": sum(t["rgbaBytes"] for t in pkg["textures"].values()),
        "drawsInCurrentSet": sum(1 for r in draw_rows if r["inCurrentSet"]),
        "trianglesInCurrentSet": sum(r["triangleCount"] for r in draw_rows
                                     if r["inCurrentSet"]),
        "drawsExcluded": sum(1 for r in draw_rows if r["excluded"]),
        "trianglesExcluded": sum(r["triangleCount"] for r in draw_rows
                                 if r["excluded"]),
    }
    totals["bindableDraws"] = sum(1 for r in draw_rows if r["bindable"])
    totals["bindableTriangles"] = sum(r["triangleCount"] for r in draw_rows
                                      if r["bindable"])
    totals["blockedDraws"] = totals["draws"] - totals["bindableDraws"]
    totals["blockedTriangles"] = totals["triangles"] - totals["bindableTriangles"]

    return {
        "map": cfg["short"],
        "level": cfg["level"],
        "mapWiredInE1": cfg["mapWired"],
        "note": cfg["note"],
        "classificationRules": {
            "order": GROUP_ORDER + ["sky-atmosphere", "instance-geometry",
                                    "unsupported-section"],
            "distantThresholdM": DISTANT_M,
            "distantRule": "section AABB farther than one retail far clip "
                           "(230.0365 m) from the measured racing line",
        },
        "totals": totals,
        "groups": group_records,
        "virtualGroups": _virtual_groups(pkg, cfg),
        "inputPins": _input_pins(cfg),
        "draws": draw_rows,
    }


def _excluded_reasons(cfg: dict, excluded: list) -> list:
    reasons = []
    if not cfg["mapWired"]:
        reasons.append("map not wired in e1-drive (no ?map=%s branch)" % cfg["short"])
    elif cfg["playableMode"] == "sections":
        reasons.append("section is outside the current seven-section River draw set")
    statuses = sorted({r["status"] for r in excluded})
    for status in statuses:
        if status != BINDABLE:
            reasons.append(STATUS_LABEL.get(status, status))
    return reasons


def _input_pins(cfg: dict) -> dict:
    pins = {}
    for key in ("slice", "bindings", "blockers", "render"):
        rel = cfg[key]
        if rel and (ROOT / rel).is_file():
            pins[key] = {"path": rel, "sha256": sha256_file(rel)}
    return pins


def ranking(report: dict) -> list:
    rows = []
    for group in report["groups"]:
        if group.get("isBasePass"):
            subset = group["excludedBindable"]
            bytes_upper = group["bytes"]["totalUpper"]
            solid = group["visual"]["meanSolidAngleSr"]
            excluded_draws = 0
        else:
            subset = group["excludedBindable"]
            if subset["draws"] == 0:
                continue
            bytes_upper = subset["totalUpperBytes"]
            solid = group["visualExcluded"]["meanSolidAngleSr"]
            excluded_draws = subset["draws"]
        mb = max(bytes_upper / 1_000_000.0, 1e-6)
        rows.append({
            "id": group["id"],
            "label": group["label"],
            "rankMetric": "mean visible solid angle per upper-bound MB of the "
                          "excluded bindable subset",
            "meanSolidAngleSr": solid,
            "hemispherePercent": fnum(100.0 * solid / (2.0 * math.pi), 3),
            "maxElevationDeg": group["visualExcluded"]["maxElevationDeg"],
            "uploadBytesUpper": bytes_upper,
            "megabytes": fnum(mb, 4),
            "solidAnglePerMb": fnum(solid / mb, 4),
            "drawableNow": group["drawableNow"],
            "isBasePass": bool(group.get("isBasePass")),
            "drawsExcluded": excluded_draws,
            "trianglesExcluded": subset["triangles"],
        })
    rows.sort(key=lambda r: (not r["isBasePass"], -r["solidAnglePerMb"], r["id"]))
    for i, row in enumerate(rows, 1):
        row["rank"] = i
    return rows


def first_add(report: dict, ranked: list) -> dict:
    candidates = [r for r in ranked if r["drawsExcluded"] > 0]
    total_solid = sum(r["meanSolidAngleSr"] for r in candidates) or 1.0
    chosen, cumulative = [], 0.0
    for row in candidates:
        if len(chosen) >= 5 or cumulative >= 0.7 * total_solid:
            break
        chosen.append(row)
        cumulative += row["meanSolidAngleSr"]
    group_by_id = {g["id"]: g for g in report["groups"]}
    sets = []
    for row in chosen:
        group = group_by_id[row["id"]]
        sets.append({
            "group": row["id"],
            "sectionIds": group["excludedBindable"]["sectionIds"],
            "draws": row["drawsExcluded"],
            "triangles": row["trianglesExcluded"],
            "meanSolidAngleSr": row["meanSolidAngleSr"],
            "uploadBytesUpper": row["uploadBytesUpper"],
            "rank": row["rank"],
        })
    unlocked = [g for g in report["groups"]
                if g["excludedBlocked"]["draws"] > 0]
    blocked_only = [g for g in report["groups"]
                    if g["drawsExcluded"] > 0 and g["excludedBindable"]["draws"] == 0]
    return {
        "basePass": {
            "group": "sky-atmosphere",
            "why": "fills the whole frame behind every draw at 1,048,576 B of BC3 "
                   "sky texture; the level's sky rotation/intensity/fog values "
                   "already exist in the XT environment record",
            "uploadBytesUpper": next(
                (r["uploadBytesUpper"] for r in ranked if r["isBasePass"]), 0),
        },
        "selectedGroups": sets,
        "cumulativeSolidAngleSr": fnum(cumulative, 6),
        "totalDrawableExcludedSolidAngleSr": fnum(total_solid, 6),
        "cumulativeFraction": fnum(cumulative / total_solid, 4),
        "unlockAfterDecoderOrAlpha": [
            {"group": g["id"],
             "draws": g["excludedBlocked"]["draws"],
             "triangles": g["excludedBlocked"]["triangles"],
             "sectionIds": g["excludedBlocked"]["sectionIds"],
             "blockedReasons": g["blockedReasons"],
             "meanSolidAngleSr": g["visualExcluded"]["meanSolidAngleSr"]}
            for g in unlocked
        ],
        "blockedOnlyGroups": [
            {"group": g["id"], "draws": g["drawsExcluded"],
             "triangles": g["trianglesExcluded"],
             "blockedReasons": g["blockedReasons"]}
            for g in blocked_only
        ],
    }


def main() -> int:
    reports = {}
    plans = {}
    for cfg in LEVELS:
        print("building", cfg["short"], "...")
        report = analyse(cfg)
        draw_rows = report.pop("draws")
        ranked = ranking(report)
        plan = first_add(report, ranked)
        out = OUT / cfg["short"]
        hashes = {
            "environment.json": dump_json(out / "environment.json",
                                          level_environment(cfg["level"])),
            "groups.json": dump_json(out / "groups.json", report),
        }
        excluded = [{
            "section": r["section"], "drawIndex": r["drawIndex"],
            "primitiveIndex": r["primitiveIndex"], "firstIndex": r["firstIndex"],
            "indexCount": r["indexCount"], "triangleCount": r["triangleCount"],
            "effect": r["effect"], "textureName": r["textureName"],
            "status": r["status"], "group": r["group"], "rule": r["rule"],
            "inCurrentSet": r["inCurrentSet"], "excluded": r["excluded"],
            "distanceM": r["distanceM"],
        } for r in draw_rows if r["excluded"]]
        hashes["excluded-draws.json"] = dump_json(out / "excluded-draws.json",
                                                  {"map": cfg["short"],
                                                   "count": len(excluded),
                                                   "draws": excluded})
        report["outputHashes"] = hashes
        report["ranking"] = ranked
        report["firstAdd"] = plan
        # rewrite groups.json so the ranking and plan travel with the report
        hashes["groups.json"] = dump_json(out / "groups.json", report)
        reports[cfg["short"]] = report
        plans[cfg["short"]] = {
            "ranking": ranked,
            "firstAdd": plan,
            "totals": report["totals"],
        }
        print("  draws %d (%d excluded) / groups %d"
              % (report["totals"]["draws"], report["totals"]["drawsExcluded"],
                 len(report["groups"])))

    plan_doc = {
        "schema": "blur.environment.plan/1",
        "kind": "environment-add-plan",
        "metric": "mean horizontal angular coverage of the group's section AABBs "
                  "from the measured racing line, divided by the upper-bound upload "
                  "megabytes (index + 3*vertices*20 + mip0 RGBA)",
        "maps": plans,
        "source": "probes/environment/build_environment.py",
    }
    plan_hash = dump_json(OUT / "plan.json", plan_doc)

    manifest = {
        "schema": "blur.environment.manifest/1",
        "kind": "environment-package",
        "maps": {},
        "outputs": {"plan.json": plan_hash},
        "limits": [
            "Data only: no renderer, GPU, browser or e1-drive change.",
            "Angular coverage is a bounding-box proxy from the measured racing line; "
            "it is not visibility, culling or occlusion.",
            "Upload bytes are an upper bound: triangle-soup vertices are counted at "
            "3 per triangle even though the slice buffers may share vertices.",
            "Environment values are the level default record; "
            "ChangeEnvironmentSettings actors can override them at runtime.",
            "Sky texture pixels are not decoded: the descriptor is read from the "
            "84-byte .texture header and the 512 px decoder cannot decode 2048x512.",
        ],
    }
    for short, report in reports.items():
        manifest["maps"][short] = {
            "level": report["level"],
            "inputs": report["inputPins"],
            "outputs": report["outputHashes"],
            "totals": report["totals"],
        }
    manifest_hash = dump_json(OUT / "manifest.json", manifest)
    print("plan", plan_hash)
    print("manifest", manifest_hash)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
