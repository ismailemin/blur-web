#!/usr/bin/env python3
"""Verify that the reader export now prints the direct-draw albedo identity.

Runs the native level reader over the 48 supported `usa_amboy` sections and the
27 geometry-blocked sections, then joins the exported fields to the independent
MAP3 textures manifest.  This is an export agreement check, not a renderer or
GPU claim: the reader exports the material/UV identity; the committed MAP3
manifest supplies the decoder-size and BC3-alpha blockers.

Usage:
    python probes/asset-reader/tests/verify_amboy_direct_bindings.py [--json]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
NATIVE = ROOT / "_work/build/asset-reader-native/Release/level_inspect.exe"
LEVEL = ROOT / "game-data/Blur/levels/usa_amboy/Level.levelrender"
BINDINGS = ROOT / "_work/map-slice/amboy-textures/bindings.json"
BLOCKERS = ROOT / "_work/map-slice/amboy-textures/blockers.json"
STAGES = ROOT / "_work/map-pipeline/probes"

# Bounded sample: one section for each direct-draw blocker class plus one
# wholly bindable section. 44=decoder size, 54=BC3 alpha, 79=effect layer,
# 143=runtime albedo, 74=all bindable.
SAMPLE = ["g44-n290", "g54-n184", "g79-n288", "g143-n284", "g74-n234"]
INSTANCE_SECTIONS = ["g54-n184", "g237-n238", "g251-n252"]


def run_mesh(section: dict, expect_ok: bool = True):
    stage = STAGES / f"usa_amboy-{section['id']}"
    command = [
        str(NATIVE),
        str(LEVEL),
        str(stage / "geometry.chunk"),
        str(stage / "node.chunk"),
        str(section["geometryBlock"]),
        str(section["nodeBlock"]),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    if not expect_ok:
        try:
            payload = json.loads(completed.stdout)
            error = payload.get("error") or completed.stderr.strip()
        except json.JSONDecodeError:
            error = completed.stderr.strip() or completed.stdout.strip()
        return completed.returncode, error
    if completed.returncode != 0:
        raise SystemExit(f"{section['id']}: reader failed: {completed.stderr.strip()[:400]}")
    return json.loads(completed.stdout)


def run_instances(section_id: str, geometry_block: int, node_block: int):
    stage = STAGES / f"usa_amboy-{section_id}"
    command = [
        str(NATIVE),
        "--instances-all",
        str(LEVEL),
        str(stage / "geometry.chunk"),
        str(stage / "node.chunk"),
        str(geometry_block),
        str(node_block),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    if completed.returncode != 0:
        raise SystemExit(f"{section_id} instances: reader failed: {completed.stderr.strip()[:400]}")
    return json.loads(completed.stdout)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="print the full evidence JSON")
    args = parser.parse_args()

    bindings = json.loads(BINDINGS.read_text(encoding="utf-8"))
    blockers = json.loads(BLOCKERS.read_text(encoding="utf-8"))
    manifest = {(draw["section"], draw["drawIndex"]): draw for draw in bindings["draws"]}

    failures: list[str] = []
    checks = 0

    def check(condition: bool, message: str) -> None:
        nonlocal checks
        checks += 1
        if not condition:
            failures.append(message)

    reader_status = Counter()
    joined = Counter()
    identity_fields = 0
    sampled = {}

    for section in bindings["sections"]:
        sid = section["id"]
        mesh = run_mesh(section)
        check(mesh.get("status") == "ok", f"{sid}: status")
        draws = mesh.get("draws", [])
        check(len(draws) == section["drawCount"], f"{sid}: draw count {len(draws)} != {section['drawCount']}")
        uses_shared = any((manifest[(sid, i)].get("textureSource") or {}).get("block") == -1 for i in range(len(draws)))
        if uses_shared:
            check(len(mesh.get("sharedTextures", [])) > 0, f"{sid}: shared texture list empty")
        section_joined = Counter()
        section_reader = Counter()
        for index, draw in enumerate(draws):
            expected = manifest[(sid, index)]
            check(draw["firstIndex"] == expected["firstIndex"] and draw["indexCount"] == expected["indexCount"],
                  f"{sid} draw {index}: span changed")
            check(draw["uvHash"] == expected["uvHash"], f"{sid} draw {index}: UV0 hash changed")
            check(draw["uv0Available"] is expected["uv0Available"], f"{sid} draw {index}: UV0 availability changed")
            material = expected["material"]
            check(draw["material"] == material["material"], f"{sid} draw {index}: material name")
            check(draw["materialRow"] == material["row"], f"{sid} draw {index}: material row")
            source = expected.get("textureSource")
            if source:
                if source["block"] >= 0:
                    check(draw["resourceBlock"] == source["block"] and draw["resourceIndex"] == source["index"],
                          f"{sid} draw {index}: resource identity")
                    check(draw["albedoTexture"] is None, f"{sid} draw {index}: resource draw acquired a shared index")
                else:
                    check(draw["albedoTexture"] == source["index"] and draw["resourceBlock"] is None,
                          f"{sid} draw {index}: shared identity")
                    check(0 <= draw["albedoTexture"] < len(mesh.get("sharedTextures", [])),
                          f"{sid} draw {index}: shared index outside exported list")
                identity_fields += 1
            else:
                check(draw["albedoTexture"] is None and draw["resourceBlock"] is None,
                      f"{sid} draw {index}: no-source draw acquired an invented texture")
            status = draw["bindingStatus"]
            check(status in {"static-resource-albedo-resolved", "static-shared-albedo-resolved", "blocked"},
                  f"{sid} draw {index}: binding status vocabulary")
            if status == "blocked":
                check(draw["bindingReason"], f"{sid} draw {index}: blocked draw lost its reason")
            else:
                check(draw["bindingReason"] is None, f"{sid} draw {index}: resolved draw retained a reason")
            reader_status[status] += 1
            section_reader[status] += 1
            joined[(expected["status"], status)] += 1
            section_joined[expected["status"]] += 1
        if sid in SAMPLE:
            sampled[sid] = {
                "draws": len(draws),
                "manifestStatus": dict(section_joined),
                "readerStatus": dict(section_reader),
                "bindable": section_joined["bindable-static-albedo"],
                "blocked": len(draws) - section_joined["bindable-static-albedo"],
            }

    total = len(bindings["draws"])
    resolved = reader_status["static-resource-albedo-resolved"] + reader_status["static-shared-albedo-resolved"]
    blocked = reader_status["blocked"]
    check(total == 1606, f"manifest draw total {total}")
    check(len(bindings["sections"]) == 48, "supported section count")
    check(resolved == 1268, f"reader identity-resolved {resolved} != 1268")
    check(blocked == 338, f"reader identity-blocked {blocked} != 338")

    expected_matrix = {
        ("bindable-static-albedo", "static-resource-albedo-resolved"): 1144,
        ("bindable-static-albedo", "static-shared-albedo-resolved"): 57,
        ("blocked-decoder-size-limit", "static-resource-albedo-resolved"): 2,
        ("blocked-decoder-size-limit", "static-shared-albedo-resolved"): 48,
        ("blocked-alpha-rule-missing", "static-resource-albedo-resolved"): 17,
        ("blocked-effect-not-static-albedo", "blocked"): 334,
        ("blocked-runtime-albedo-parameter", "blocked"): 4,
    }
    check(dict(joined) == expected_matrix, "manifest x reader status matrix changed")

    # Join the reader's resolved identity to MAP3's decoder/alpha evidence.
    bindable = sum(1 for draw in bindings["draws"] if draw["status"] == "bindable-static-albedo")
    map3_blocked = total - bindable
    check(bindable == 1201 and map3_blocked == 405, "MAP3 bindable/blocked split")
    sample_draws = sum(v["draws"] for v in sampled.values())
    sample_bindable = sum(v["bindable"] for v in sampled.values())
    sample_blocked = sum(v["blocked"] for v in sampled.values())
    sample_reader_blocked = sum(v["readerStatus"].get("blocked", 0) for v in sampled.values())
    check(sample_draws == 135, f"sample draw count {sample_draws}")
    check(sample_bindable == 108, f"sample bindable {sample_bindable}")
    check(sample_blocked == 27, f"sample blocked {sample_blocked}")
    check(sample_reader_blocked == 21, f"sample identity-blocked {sample_reader_blocked}")

    # Geometry-only blockers: 27 sections must fail at POSITION type 7, while the
    # manifest records a resolved static albedo for each.
    unsupported = blockers["unsupportedSections"]
    check(unsupported["summary"]["sections"] == 27, "unsupported section count")
    check(unsupported["summary"]["textureSideResolved"] == 27, "unsupported texture side")
    geometry_errors = 0
    for section in unsupported["sections"]:
        code, error = run_mesh(section, expect_ok=False)
        if code != 0 and "Unsupported position vertex format" in error:
            geometry_errors += 1
        else:
            failures.append(f"{section['id']}: unexpected unsupported-section result {code} {error[:120]}")
        checks += 1
    check(geometry_errors == 27, f"geometry-only error count {geometry_errors}")

    # 366 instance descriptions: geometry-blocked, texture side resolved.
    instance_meta = blockers["instances"]
    check(instance_meta["summary"]["instances"] == 366, "instance count")
    check(instance_meta["summary"]["staticAlbedoInstances"] == 366, "instance static albedo")
    check(instance_meta["summary"]["uv0DeclaredInstances"] == 366, "instance UV0 declaration")
    instance_emitted = 0
    instance_omitted = 0
    for section in instance_meta["sections"]:
        result = run_instances(section["id"], section["geometryBlock"], section["nodeBlock"])
        meta = result.get("metadata", {})
        check(meta.get("instanceCount") == section["instanceCount"], f"{section['id']}: instance description count")
        check(meta.get("emittedInstanceCount") == 0, f"{section['id']}: instance unexpectedly emitted")
        check(meta.get("omittedOtherBlockInstances") == section["instanceCount"],
              f"{section['id']}: other-block instance count")
        check(meta.get("unsupportedBoundsInstances") == 0, f"{section['id']}: bounds instance count")
        instance_emitted += int(meta.get("emittedInstanceCount", -1))
        instance_omitted += int(meta.get("omittedOtherBlockInstances", -1))
    check(instance_emitted == 0, "instances emitted")
    check(instance_omitted == 366, f"instances omitted {instance_omitted}")

    evidence = {
        "kind": "asset-reader.amboy-direct-bindings",
        "version": 1,
        "level": "usa_amboy",
        "scope": "reader export agreement with MAP3; static g_tAlbedo identity and UV0 only; no decode, sampler, alpha, blend, shader or renderer claim",
        "supportedSections": len(bindings["sections"]),
        "draws": total,
        "identityResolved": resolved,
        "resourceResolved": reader_status["static-resource-albedo-resolved"],
        "sharedResolved": reader_status["static-shared-albedo-resolved"],
        "readerBlocked": blocked,
        "identityBearingDraws": identity_fields,
        "joinedWithMap3": {
            "bindable": bindable,
            "blocked": map3_blocked,
            "reasons": {
                "effect-not-static-albedo": 334,
                "decoder-size-limit": 50,
                "alpha-rule-missing": 17,
                "runtime-albedo-parameter": 4,
            },
        },
        "sample5": {"sections": SAMPLE, "draws": sample_draws, "bindable": sample_bindable,
                    "blocked": sample_blocked, "readerIdentityBlocked": sample_reader_blocked,
                    "details": sampled},
        "unsupportedSections": {"count": 27, "geometryPositionType7Errors": geometry_errors,
                                "textureSideResolved": 27},
        "instances": {"descriptions": 366, "emitted": instance_emitted, "omittedOtherBlock": instance_omitted,
                      "staticAlbedoResolved": 366, "uv0Declared": 366},
    }
    check(not failures, "failures present")
    evidence["checks"] = checks
    evidence["failures"] = failures
    output = ROOT / "_work/asset-reader/amboy-direct-bindings.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(evidence, indent=2))
    else:
        print(f"Amboy reader export: {total} draws, identity {resolved} resolved / {blocked} blocked; "
              f"MAP3 join {bindable} bindable / {map3_blocked} blocked; "
              f"27 geometry-only sections; 366 geometry-only instances; {checks} checks, {len(failures)} failures")
    if failures:
        for failure in failures[:20]:
            print("FAIL " + failure, file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
