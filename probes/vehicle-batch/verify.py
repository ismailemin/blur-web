"""Verify the batch-compiler staging output.

The gate re-reads the spec, every staged car directory and a second independent
build root, then checks:

  * spec schema and coverage (62 records, unique ids, typed reasons),
  * artifact presence, hashes and cross-document agreement per staged car,
  * deterministic output: the same per-car artifact hashes in two build roots,
  * typed reasons for every blocked car and no invented values,
  * aggregate consistency with `summary.json`,
  * one path-independence regression against the committed car-parts build.

Usage:
  python probes/vehicle-batch/verify.py [--primary <dir>] [--repeat <dir>]
         [--spec <path>] [--out <json>] [--skip-regression]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for path in (ROOT / "tools", ROOT / "probes/vehicle-pipeline/tools",
             ROOT / "probes/car-parts/tools", ROOT / "probes/vehicle-batch/tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

SPEC_DEFAULT = ROOT / "probes/vehicle-batch/spec/cars.json"
PRIMARY_DEFAULT = ROOT / "_work/vehicle-batch"
REPEAT_DEFAULT = ROOT / "_work/vehicle-batch/_repeat"
OUT_DEFAULT = ROOT / "_work/vehicle-batch/verify.json"
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ALLOWED_BLOCKER = {
    "no-body-model",
    "builder-unsupported",
    "stage-unsupported",
    "mapping-failed",
    "body-hash-drift",
    "material-traversal-failed",
    "wheel-model-missing",
    "wheel-decode-failed",
    "wheel-reader-failed",
    "wheel-proof-not-committed",
    "hud-identity-unresolved",
    "hud-icon-vector-decode-unsupported",
}
ARTIFACT_FILES = (
    "manifest.json",
    "mesh.json",
    "scene-report.json",
    "materials/corvette-materials.json",
    "materials/corvette-materials.raw.json",
    "materials/corvette-uv0.json",
    "wheels/wheel.json",
    "wheels/scene.json",
    "wheels/model.json",
)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rel(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(ROOT).as_posix()
    except ValueError:
        return resolved.as_posix()


class Gate:
    def __init__(self) -> None:
        self.checks: list[dict] = []

    def check(self, name: str, ok: bool, detail: object = "") -> bool:
        self.checks.append({"name": name, "ok": bool(ok), "detail": str(detail)})
        return bool(ok)

    def failures(self) -> list[dict]:
        return [row for row in self.checks if not row["ok"]]


def verify_spec(gate: Gate, spec: dict, spec_path: Path) -> dict[int, dict]:
    cars = spec["cars"]
    by_index = {car["recordIndex"]: car for car in cars}
    gate.check("spec.kind", spec.get("kind") == "blur.vehicle-batch.spec",
               spec.get("kind"))
    gate.check("spec.version", spec.get("version") == 1, spec.get("version"))
    gate.check("spec.records=62", len(cars) == 62, len(cars))
    classes = {"A": 0, "B": 0, "C": 0}
    for car in cars:
        classes[car["class"]] = classes.get(car["class"], 0) + 1
    gate.check("spec.classes 5/42/15",
               (classes["A"], classes["B"], classes["C"]) == (5, 42, 15), classes)
    gate.check("spec.inRoster+remaining=62",
               spec["counts"]["inRoster"] + spec["counts"]["remaining"] == 62,
               spec["counts"])
    gate.check("spec.slugs unique",
               len({car["slug"] for car in cars}) == len(cars),
               len({car["slug"] for car in cars}))
    gate.check("spec.recordIndex unique",
               len(by_index) == len(cars), len(by_index))
    gate.check("spec.recordId unique",
               len({car["recordId"] for car in cars}) == len(cars),
               len({car["recordId"] for car in cars}))
    gate.check("spec.sources pinned", len(spec.get("sources") or {}) >= 5,
               sorted(spec.get("sources") or {}))
    gate.check("spec.specGen path exists",
               (ROOT / "probes/vehicle-batch/tools/spec_gen.py").is_file(), "")

    for car in cars:
        label = f"spec[{car['recordIndex']}]"
        gate.check(f"{label}.slug", bool(SLUG_RE.match(car["slug"])), car["slug"])
        gate.check(f"{label}.class", car["class"] in ("A", "B", "C"), car["class"])
        gate.check(f"{label}.scope", car["scope"] in ("roster", "remaining"),
                   car["scope"])
        gate.check(f"{label}.physicsGate", car["physics"]["gatePass"] is True, "")
        gate.check(f"{label}.massKg", float(car["massKg"]) > 0, car["massKg"])
        gate.check(f"{label}.gears", int(car["gears"]) >= 2, car["gears"])
        body = car["body"]
        if body is None:
            gate.check(f"{label}.bodyReason typed",
                       bool(car["bodyReason"] and car["bodyReason"].get("code")
                            and car["bodyReason"].get("detail")),
                       car["bodyReason"])
        else:
            gate.check(f"{label}.bodyRoute", body["route"] in ("exact", "alias"),
                       body["route"])
            gate.check(f"{label}.bodyHash", bool(HASH_RE.match(body["sha256"] or "")),
                       body["sha256"])
            decoded = ROOT / body["decodedPath"]
            gate.check(f"{label}.bodyDecodedExists", decoded.is_file(),
                       body["decodedPath"])
            gate.check(f"{label}.bodyDecodedHash",
                       decoded.is_file() and sha256_file(decoded) == body["sha256"],
                       body["decodedPath"])
            if body["route"] == "exact":
                expected = "\\models\\vehicles\\" + car["recordName"].lower() + ".model"
                gate.check(f"{label}.exactModelName",
                           (body["pakPath"] or "").lower() == expected.lower(),
                           f"{body['pakPath']} vs {expected}")
            else:
                alias = car["alias"] or {}
                gate.check(f"{label}.aliasEvidence",
                           alias.get("handleResolvesToExactRecordId") is True
                           and alias.get("nameSimilarityUsed") is False,
                           alias)
                gate.check(f"{label}.aliasTagDerivesModel",
                           (body["pakPath"] or "").lower().endswith(
                               (alias.get("amaxTag") or "").lower() + ".model"),
                           f"{alias.get('amaxTag')} -> {body['pakPath']}")
        wheel = car["wheel"]
        gate.check(f"{label}.wheelPathOrReason",
                   bool(wheel.get("pakPath") or wheel.get("reason")), wheel.get("pakPath"))
        hud = car["hud"]
        if body is not None:
            gate.check(f"{label}.hudPresent", hud is not None, "")
            if hud:
                gate.check(f"{label}.hudLocId", bool(hud.get("hudNameKey")),
                           hud.get("hudNameKey"))
                gate.check(f"{label}.iconSprite", bool(hud.get("iconSprite")),
                           hud.get("iconSprite"))
                gate.check(f"{label}.iconKnown", hud.get("iconSpriteKnown") is True,
                           hud.get("iconSprite"))
        else:
            gate.check(f"{label}.hudTypedNull", hud is None, hud)
        blockers = car["blockers"]
        gate.check(f"{label}.blockersTyped",
                   bool(blockers) and all(b.get("kind") and b.get("detail")
                                          and b.get("source") for b in blockers),
                   len(blockers))
    return by_index


def verify_car(gate: Gate, car: dict, primary: Path, summary_row: dict) -> dict:
    slug = car["slug"]
    label = f"car[{car['recordIndex']}]"
    out_dir = primary / slug
    staged_path = out_dir / "staged.json"
    gate.check(f"{label}.stagedExists", staged_path.is_file(), slug)
    if not staged_path.is_file():
        return {}
    staged = json.loads(staged_path.read_text(encoding="utf-8"))
    gate.check(f"{label}.statusStaged", staged.get("status") == "staged",
               staged.get("status"))
    gate.check(f"{label}.kind", staged.get("kind") == "blur.vehicle-batch.car-staging",
               staged.get("kind"))
    gate.check(f"{label}.recordIndex", staged.get("recordIndex") == car["recordIndex"],
               staged.get("recordIndex"))
    gate.check(f"{label}.inputBody", staged["input"]["body"] == car["body"]["sha256"],
               "")

    hashes = staged.get("hashes") or {}
    actual = {}
    for name in ARTIFACT_FILES:
        path = out_dir / name
        gate.check(f"{label}.artifact[{name}]", path.is_file(), rel(path))
        if path.is_file():
            actual[name] = {"bytes": path.stat().st_size, "sha256": sha256_file(path)}
    gate.check(f"{label}.stagedArtifactsMatch", staged.get("artifacts") == actual,
               f"{len(actual)} files")

    manifest_path = out_dir / "manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        gate.check(f"{label}.manifestKind",
                   manifest.get("kind") == "blur.car-part-manifest",
                   manifest.get("kind"))
        gate.check(f"{label}.manifestSlug",
                   (manifest.get("source") or {}).get("car", {}).get("slug") == slug,
                   "")
        gate.check(f"{label}.manifestHash", hashes.get("manifest") == actual["manifest.json"]["sha256"],
                   "")
        gate.check(f"{label}.manifestModelPath",
                   ((manifest.get("source") or {}).get("model") or "")
                   .endswith(car["body"]["sha256"] + ".decoded"),
                   (manifest.get("source") or {}).get("model"))
        draws = manifest.get("draws") or []
        diagnostics = manifest.get("diagnostics") or {}
        gate.check(f"{label}.drawsOwnedOnce",
                   len(draws) == diagnostics.get("drawCount") and len(draws) > 0,
                   f"{len(draws)}/{diagnostics.get('drawCount')}")
        gate.check(f"{label}.fourWheelGroups",
                   diagnostics.get("wheelGroupCount") == 4,
                   diagnostics.get("wheelGroupCount"))
        gate.check(f"{label}.wheelDraws",
                   int(diagnostics.get("wheelDrawCount") or 0) > 0,
                   diagnostics.get("wheelDrawCount"))
    if (out_dir / "mesh.json").is_file():
        mesh = json.loads((out_dir / "mesh.json").read_text(encoding="utf-8"))
        gate.check(f"{label}.meshPositions",
                   mesh["vertexCount"] * 3 == len(mesh["positions"]),
                   f"{mesh['vertexCount']}")
        gate.check(f"{label}.meshIndices", len(mesh["indices"]) % 3 == 0,
                   len(mesh["indices"]))
    if (out_dir / "scene-report.json").is_file():
        scene = json.loads((out_dir / "scene-report.json").read_text(encoding="utf-8"))
        gate.check(f"{label}.sceneStatus", scene.get("status") == "ok",
                   scene.get("status"))
        gate.check(f"{label}.sceneUv0", len(scene.get("uv0") or []) > 0
                   and len(scene.get("uv0") or []) % 2 == 0,
                   len(scene.get("uv0") or []))
    if (out_dir / "materials" / "corvette-materials.json").is_file():
        materials = json.loads(
            (out_dir / "materials" / "corvette-materials.json").read_text(encoding="utf-8"))
        gate.check(f"{label}.materialsDraws",
                   materials.get("drawCount") == (json.loads(
                       (out_dir / "manifest.json").read_text(encoding="utf-8"))
                       .get("diagnostics") or {}).get("drawCount"),
                   materials.get("drawCount"))
        gate.check(f"{label}.materialsTextures",
                   int((materials.get("statusCounts") or {})
                       .get("static_albedo_image_resolved", 0)) > 0, "")
    wheel_path = out_dir / "wheels" / "wheel.json"
    if wheel_path.is_file():
        wheel = json.loads(wheel_path.read_text(encoding="utf-8"))
        gate.check(f"{label}.wheelHash", wheel.get("sha256") == hashes.get("wheelModel"),
                   wheel.get("sha256"))
        gate.check(f"{label}.wheelScene", wheel["scene"].get("status") == "ok"
                   and wheel["scene"].get("drawCount", 0) > 0,
                   wheel["scene"].get("drawCount"))
        gate.check(f"{label}.wheelModel", wheel["model"].get("status") == "ok",
                   wheel["model"].get("status"))
        gate.check(f"{label}.wheelSceneHash",
                   wheel["artifactSha256"]["scene"]
                   == actual["wheels/scene.json"]["sha256"], "")
        gate.check(f"{label}.wheelModelHash",
                   wheel["artifactSha256"]["model"]
                   == actual["wheels/model.json"]["sha256"], "")

    ghost_path = out_dir / "ghost-inputs.json"
    gate.check(f"{label}.ghostInputs", ghost_path.is_file(), "")
    if ghost_path.is_file():
        ghost = json.loads(ghost_path.read_text(encoding="utf-8"))
        gate.check(f"{label}.ghostCourses",
                   tuple(ghost["courses"]) == ("310m", "short"), ghost["courses"])
        gate.check(f"{label}.ghostFiles",
                   all(Path(name).name.startswith(slug) for name in ghost["files"]),
                   ghost["files"])
        gate.check(f"{label}.ghostPending",
                   ghost.get("status") == "pending-main-agent"
                   and "--write-ghosts" in ghost.get("command", ""), ghost.get("status"))
        gate.check(f"{label}.ghostNoInventedValues",
                   all(row.get("sha256") is None and row.get("timeSeconds") is None
                       and row.get("stateSequenceHash") is None
                       for row in ghost["indexFragment"].values()), "")

    integration_path = out_dir / "integration.json"
    gate.check(f"{label}.integration", integration_path.is_file(), "")
    if integration_path.is_file():
        integration = json.loads(integration_path.read_text(encoding="utf-8"))
        entry = integration["rosterFragment"]
        gate.check(f"{label}.rosterEntry",
                   entry["slug"] == slug
                   and entry["recordId"] == car["recordId"]
                   and entry["recordIndex"] == car["recordIndex"], "")
        gate.check(f"{label}.rosterLayout",
                   entry["layout"].startswith(car["drivetrain"]), entry["layout"])
        if car["body"]["route"] == "alias":
            gate.check(f"{label}.rosterModelMapping",
                       entry.get("model") == car["body"]["pakPath"]
                       and entry.get("modelMapping", {}).get("amaxTag")
                       == car["alias"]["amaxTag"], "")
        pins = integration["guardPins"]["geometry"]
        gate.check(f"{label}.pinMesh",
                   pins["meshPositionsSha256"]
                   == (staged.get("record") or {}).get("artifacts", {})
                   .get("mesh", {}).get("positionsSha256"), "")
        gate.check(f"{label}.patchOrder",
                   len(integration["patchOrder"]) >= 9, len(integration["patchOrder"]))
        gate.check(f"{label}.pinTargets",
                   len(integration["pinTargets"]) == 5, len(integration["pinTargets"]))

    if summary_row:
        gate.check(f"{label}.summaryStatus", summary_row["status"] in
                   ("staged", "skipped"), summary_row["status"])
    return staged


def verify_determinism(gate: Gate, staged_by_slug: dict[str, dict],
                       primary: Path, repeat: Path) -> None:
    gate.check("determinism.repeatRootExists", repeat.is_dir(), rel(repeat))
    if not repeat.is_dir():
        return
    for slug, staged in staged_by_slug.items():
        label = f"det[{slug}]"
        repeat_path = repeat / slug / "staged.json"
        gate.check(f"{label}.stagedExists", repeat_path.is_file(), "")
        if not repeat_path.is_file():
            continue
        second = json.loads(repeat_path.read_text(encoding="utf-8"))
        gate.check(f"{label}.inputEqual", second["input"] == staged["input"], "")
        gate.check(f"{label}.hashesEqual", second["hashes"] == staged["hashes"], "")
        first_artifacts = {name: row["sha256"]
                           for name, row in staged["artifacts"].items()}
        second_artifacts = {name: row["sha256"]
                            for name, row in second["artifacts"].items()}
        gate.check(f"{label}.artifactsEqual", first_artifacts == second_artifacts, "")
        for name in ARTIFACT_FILES:
            gate.check(f"{label}.file[{name}]",
                       (primary / slug / name).is_file()
                       and (repeat / slug / name).is_file()
                       and sha256_file(primary / slug / name)
                       == sha256_file(repeat / slug / name), name)


def verify_summary(gate: Gate, summary: dict, repeat: dict, spec: dict,
                   staged: dict[str, dict], blocked: list[dict]) -> None:
    counts = summary["counts"]
    gate.check("summary.selected=remaining",
               counts["selected"] == spec["counts"]["remaining"], counts)
    gate.check("summary.staged+blocked+errors=selected",
               counts["staged"] + counts["blocked"] + counts["errors"] == counts["selected"],
               counts)
    gate.check("summary.stagedMatchesDirs",
               counts["staged"] == len(staged), f"{counts['staged']}/{len(staged)}")
    gate.check("summary.blockedMatchesDirs",
               counts["blocked"] == len(blocked), f"{counts['blocked']}/{len(blocked)}")
    gate.check("summary.rosterCountAfter",
               summary["roster"]["countAfter"]
               == summary["roster"]["countBefore"] + sum(
                   1 for row in staged.values()
                   if row["record"].get("scope") == "remaining"), "")
    gate.check("summary.rosterEntries",
               len(summary["roster"]["entries"]) == counts["staged"], "")
    gate.check("summary.ghostsRequired",
               summary["ghosts"]["required"] == 2 * counts["staged"], "")

    aggregates = summary["aggregates"]
    records = {slug: row.get("record", row) for slug, row in staged.items()}
    sums = {
        "bodyDraws": sum(row["body"]["drawCount"] for row in records.values()),
        "parts": sum(row["body"]["partCount"] for row in records.values()),
        "triangles": sum(row["body"]["triangleCount"] for row in records.values()),
        "vertices": sum(row["body"]["vertexCount"] for row in records.values()),
        "uniqueTextures": sum(row["body"]["materials"]["uniqueTextureCount"]
                              for row in records.values()),
        "textureSourceBytes": sum(row["body"]["materials"]["sourceBytes"]
                                  for row in records.values()),
        "wheelDraws": sum(row["body"]["wheelDrawCount"] for row in records.values()),
        "uv0ValidVertices": sum(row["body"]["scene"]["uv0ValidVertices"]
                                for row in records.values()),
    }
    for key, value in sums.items():
        gate.check(f"summary.aggregate[{key}]", aggregates[key] == value,
                   f"{aggregates[key]} vs {value}")

    # Determinism of the summary projection (paths and run counts excluded).
    def projection(document: dict) -> dict:
        return {
            "aggregates": document["aggregates"],
            "roster": document["roster"],
            "records": [{
                "slug": row["slug"],
                "recordIndex": row["recordIndex"],
                "class": row["class"],
                "status": ("complete" if row["status"] in ("staged", "skipped")
                           else row["status"]),
                "draws": (row.get("body") or {}).get("drawCount"),
                "triangles": (row.get("body") or {}).get("triangleCount"),
                "textures": (row.get("body") or {}).get("uniqueTextureCount"),
                "reason": (None if row["status"] == "skipped"
                           else row.get("reason")),
            } for row in document["records"]],
            "spec": {"sha256": document["spec"]["sha256"],
                     "counts": document["spec"]["counts"]},
            "tools": document["tools"],
        }

    gate.check("determinism.summaryProjection",
               projection(summary) == projection(repeat), "")

    # No duplicate body models or outputs among staged cars.
    body_paths = [row["identity"]["pakPath"].lower() for row in records.values()]
    gate.check("duplicates.bodyModels", len(set(body_paths)) == len(body_paths),
               len(body_paths) - len(set(body_paths)))
    wheel_paths = [row["wheel"]["pakPath"].lower() for row in records.values()]
    shared = {}
    for body, wheel in zip(body_paths, wheel_paths):
        shared.setdefault(wheel, set()).add(body)
    gate.check("duplicates.wheelModelsShareOnlyDistinctBodies",
               all(len(bodies) == len({b for b in bodies}) for bodies in shared.values())
               and all(len(bodies) > 0 for bodies in shared.values()),
               f"{len(wheel_paths)} wheels, {len(set(wheel_paths))} unique")
    indexes = [row["recordIndex"] for row in records.values()]
    gate.check("duplicates.recordIndexes", len(set(indexes)) == len(indexes), "")
    slugs = list(staged)
    gate.check("duplicates.stagedSlugs", len(set(slugs)) == len(slugs), "")
    gate.check("duplicates.noWheelEqualsBody",
               not set(p.lower() for p in body_paths) & set(p.lower() for p in wheel_paths),
               "")


def verify_blocked(gate: Gate, blocked: list[dict], primary: Path) -> None:
    gate.check("blocked.nonEmpty", len(blocked) > 0, len(blocked))
    for row in blocked:
        slug = row["slug"]
        label = f"blocked[{slug}]"
        payload_path = primary / slug / "blocked.json"
        gate.check(f"{label}.file", payload_path.is_file(), rel(payload_path))
        if not payload_path.is_file():
            continue
        payload = json.loads(payload_path.read_text(encoding="utf-8"))
        gate.check(f"{label}.status", payload.get("status") == "blocked", "")
        reasons = payload.get("reasons") or []
        gate.check(f"{label}.typedReasons",
                   bool(reasons) and all(reason.get("code") and reason.get("detail")
                                         for reason in reasons), len(reasons))
        gate.check(f"{label}.allowedCodes",
                   all(reason.get("code") in ALLOWED_BLOCKER for reason in reasons),
                   [reason.get("code") for reason in reasons])
        gate.check(f"{label}.noArtifacts",
                   not (primary / slug / "manifest.json").exists(), "")


def verify_regression(gate: Gate, spec: dict) -> None:
    """Prove mesh/scene-report path independence against the committed build."""
    car = next((row for row in spec["cars"] if row["recordIndex"] == 10), None)
    committed = ROOT / "_work/car-parts/cars/audi-tt-stock"
    if car is None or not committed.is_dir():
        gate.check("regression.available", False,
                   "audi-tt-stock committed build not found")
        return
    out_root = ROOT / "_work/vehicle-batch/_regression"
    proc = subprocess.run(
        [sys.executable, str(ROOT / "probes/vehicle-batch/build.py"),
         "--scope", "roster", "--only", "10", "--out-root", str(out_root),
         "--no-resume"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    gate.check("regression.buildExit", proc.returncode == 0,
               (proc.stderr or proc.stdout)[-400:])
    for name in ("mesh.json", "scene-report.json"):
        ours = out_root / car["slug"] / name
        gate.check(f"regression.{name}",
                   ours.is_file() and sha256_file(ours) == sha256_file(committed / name),
                   rel(ours))
    manifest = out_root / car["slug"] / "manifest.json"
    if manifest.is_file():
        ours = json.loads(manifest.read_text(encoding="utf-8"))
        theirs = json.loads((committed / "manifest.json").read_text(encoding="utf-8"))
        ours["source"]["model"] = theirs["source"]["model"]
        gate.check("regression.manifestOnlyModelPath",
                   ours == theirs, "")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--spec", type=Path, default=SPEC_DEFAULT)
    parser.add_argument("--primary", type=Path, default=PRIMARY_DEFAULT)
    parser.add_argument("--repeat", type=Path, default=REPEAT_DEFAULT)
    parser.add_argument("--out", type=Path, default=OUT_DEFAULT)
    parser.add_argument("--skip-regression", action="store_true")
    args = parser.parse_args()

    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    summary = json.loads((args.primary / "summary.json").read_text(encoding="utf-8"))
    repeat = json.loads((args.repeat / "summary.json").read_text(encoding="utf-8"))

    gate = Gate()
    by_index = verify_spec(gate, spec, args.spec)

    summary_rows = {row["slug"]: row for row in summary["records"]}
    staged_by_slug = {}
    blocked = []
    for row in summary["records"]:
        car = by_index[row["recordIndex"]]
        if row["status"] in ("staged", "skipped"):
            if car["body"] is None:
                gate.check(f"car[{car['recordIndex']}].bodyRequired", False,
                           "staged car without a body model")
                continue
            staged = verify_car(gate, car, args.primary, row)
            if staged:
                staged_by_slug[car["slug"]] = staged
                gate.check(f"car[{car['recordIndex']}].stagedPresent",
                           True, car["slug"])
        elif row["status"] == "blocked":
            blocked.append(row)
        else:
            gate.check(f"car[{car['recordIndex']}].noErrorStatus", False,
                       row["status"])

    verify_blocked(gate, blocked, args.primary)
    verify_determinism(gate, staged_by_slug, args.primary, args.repeat)
    verify_summary(gate, summary, repeat, spec, staged_by_slug, blocked)
    if not args.skip_regression:
        verify_regression(gate, spec)

    failures = gate.failures()
    payload = {
        "kind": "blur.vehicle-batch.verify",
        "version": 1,
        "status": "PASS" if not failures else "FAIL",
        "generatedBy": "probes/vehicle-batch/verify.py",
        "inputs": {
            "spec": {"path": rel(args.spec), "sha256": sha256_file(args.spec)},
            "primary": {"path": rel(args.primary),
                        "summarySha256": sha256_file(args.primary / "summary.json")},
            "repeat": {"path": rel(args.repeat),
                       "summarySha256": sha256_file(args.repeat / "summary.json")},
        },
        "counts": {
            "checks": len(gate.checks),
            "passed": len(gate.checks) - len(failures),
            "failed": len(failures),
            "cars": len(staged_by_slug),
            "blocked": len(blocked),
        },
        "failures": failures,
        "checks": gate.checks,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(
        (json.dumps(payload, indent=1, sort_keys=True, ensure_ascii=False) + "\n")
        .encode("utf-8"))
    print(json.dumps({"status": payload["status"], "counts": payload["counts"],
                      "out": rel(args.out), "sha256": sha256_file(args.out)},
                     indent=1, sort_keys=True))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
