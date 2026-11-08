"""Verify `_work/vehicle-batch/batch-roster.json` against the committed source.

The gate re-derives every entry from the committed audit data, not from the
staging output:

  * the `.fields` file bytes, SHA-256 and field count;
  * the decoded body model identity and hash;
  * the record identity, drivetrain, mass and wheelbase;
  * the staged manifest/mesh/scene-report hashes and their internal arithmetic;
  * the typed unsupported reason and the exact missing field/byte;
  * record-index order, uniqueness and full 62-record coverage with the
    committed 25-car roster;
  * determinism: the primary and repeat build roots must produce identical
    batch-roster bytes and identical per-car staged identities.

Usage:
  python probes/vehicle-batch/tools/verify_batch_roster.py
         [--spec <path>] [--primary <dir>] [--repeat <dir>]
         [--out <json>] [--skip-determinism]

Exit code: 0 when every check passes, 1 otherwise.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC_DEFAULT = ROOT / "probes/vehicle-batch/spec/cars.json"
PRIMARY_DEFAULT = ROOT / "_work/vehicle-batch"
REPEAT_DEFAULT = ROOT / "_work/vehicle-batch/_repeat"
OUT_DEFAULT = ROOT / "_work/vehicle-batch/batch-roster-verify.json"
ROSTER = ROOT / "probes/e1-drive/cars/roster.json"
STAGE_SCHEMA = 2
ALLOWED_UNSUPPORTED = {
    "no-body-model",
    "builder-unsupported",
    "stage-unsupported",
    "stage-failed",
    "mapping-failed",
    "body-hash-drift",
    "fields-missing",
    "fields-hash-drift",
    "material-traversal-failed",
    "wheel-model-missing",
    "wheel-decode-failed",
    "wheel-reader-failed",
    "wheel-proof-not-committed",
    "wheel-model-unknown",
    "wheel-identity-unresolved",
    "hud-identity-unresolved",
    "hud-icon-vector-decode-unsupported",
}
ARTIFACTS = (
    ("manifest", "manifest.json"),
    ("mesh", "mesh.json"),
    ("sceneReport", "scene-report.json"),
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(ROOT).as_posix()
    except ValueError:
        return resolved.as_posix()


def field_count(data: bytes) -> int:
    return len([line for line in data.decode("utf-8").splitlines() if line.strip()])


class Gate:
    def __init__(self) -> None:
        self.checks: list[dict] = []

    def check(self, name: str, ok: bool, detail: object = "") -> bool:
        self.checks.append({"name": name, "ok": bool(ok), "detail": str(detail)})
        return bool(ok)

    def failures(self) -> list[dict]:
        return [row for row in self.checks if not row["ok"]]


def verify_inputs(gate: Gate, spec_path: Path, roster_path: Path,
                  primary: Path, repeat: Path, require_repeat: bool) -> None:
    gate.check("input.spec", spec_path.is_file(), rel(spec_path))
    gate.check("input.roster", roster_path.is_file(), rel(roster_path))
    gate.check("input.batchRoster", (primary / "batch-roster.json").is_file(),
               rel(primary / "batch-roster.json"))
    if require_repeat:
        gate.check("input.repeatBatchRoster",
                   (repeat / "batch-roster.json").is_file(),
                   rel(repeat / "batch-roster.json"))


def verify_document(gate: Gate, spec: dict, roster: dict, document: dict,
                    primary: Path) -> tuple[int, int]:
    entries = document.get("entries") or []
    spec_by_index = {car["recordIndex"]: car for car in spec["cars"]}
    remaining = [car for car in spec["cars"] if car["scope"] == "remaining"]
    expected_indexes = [car["recordIndex"] for car in remaining]
    entry_indexes = [entry.get("recordIndex") for entry in entries]

    gate.check("roster.kind",
               document.get("kind") == "blur.vehicle-batch.roster",
               document.get("kind"))
    gate.check("roster.version", document.get("version") == 1,
               document.get("version"))
    gate.check("roster.specSha",
               (document.get("spec") or {}).get("sha256") == sha256_file(
                   ROOT / document["spec"]["path"]),
               (document.get("spec") or {}).get("sha256"))
    gate.check("roster.entries=37", len(entries) == 37, len(entries))
    gate.check("roster.order", entry_indexes == expected_indexes,
               f"{len(entry_indexes)} entries")
    gate.check("roster.uniqueSlugs",
               len({entry.get("slug") for entry in entries}) == len(entries),
               len({entry.get("slug") for entry in entries}))
    gate.check("roster.uniqueIndexes", len(set(entry_indexes)) == len(entries),
               len(set(entry_indexes)))
    gate.check("roster.uniqueRecordIds",
               len({entry.get("recordId") for entry in entries}) == len(entries),
               len({entry.get("recordId") for entry in entries}))
    gate.check("roster.onlyRemaining",
               all(entry.get("scope") == "remaining" for entry in entries), "")

    roster_indexes = {car["recordIndex"] for car in roster["cars"]}
    all_indexes = set(spec_by_index)
    gate.check("roster.committedCount", len(roster["cars"]) == 25,
               len(roster["cars"]))
    gate.check("roster.noOverlap",
               not (set(entry_indexes) & roster_indexes),
               sorted(set(entry_indexes) & roster_indexes))
    gate.check("roster.coversAll62",
               set(entry_indexes) | roster_indexes == all_indexes,
               f"{len(set(entry_indexes) | roster_indexes)}/62")

    staged = 0
    unsupported = 0
    for entry in entries:
        index = entry.get("recordIndex")
        label = f"entry[{index}]"
        car = spec_by_index.get(index)
        gate.check(f"{label}.specPresent", car is not None, index)
        if car is None:
            continue
        gate.check(f"{label}.slug", entry.get("slug") == car["slug"],
                   entry.get("slug"))
        gate.check(f"{label}.recordId", entry.get("recordId") == car["recordId"],
                   entry.get("recordId"))
        gate.check(f"{label}.recordName",
                   entry.get("recordName") == car["recordName"],
                   entry.get("recordName"))
        gate.check(f"{label}.class", entry.get("class") == car["class"],
                   entry.get("class"))
        gate.check(f"{label}.drivetrain",
                   entry.get("drivetrain") == car["drivetrain"],
                   entry.get("drivetrain"))
        gate.check(f"{label}.massKg",
                   float(entry.get("massKg") or 0) == float(car["massKg"]),
                   entry.get("massKg"))
        gate.check(f"{label}.wheelBase",
                   entry.get("wheelBase") == car["physics"]["wheelBase"],
                   entry.get("wheelBase"))
        gate.check(f"{label}.gears", entry.get("gears") == car["gears"],
                   entry.get("gears"))
        gate.check(f"{label}.status",
                   entry.get("status") in ("staged", "unsupported"),
                   entry.get("status"))

        fields = entry.get("fields") or {}
        fields_path = ROOT / (fields.get("path") or "")
        gate.check(f"{label}.fieldsPath",
                   fields.get("path") == car["physics"]["fieldsPath"],
                   fields.get("path"))
        gate.check(f"{label}.fieldsExists", fields_path.is_file(),
                   rel(fields_path))
        data = fields_path.read_bytes() if fields_path.is_file() else b""
        gate.check(f"{label}.fieldsBytes", fields.get("bytes") == len(data),
                   f"{fields.get('bytes')} vs {len(data)}")
        gate.check(f"{label}.fieldsSha",
                   fields.get("sha256") == sha256_bytes(data)
                   == car["physics"]["fieldsSha256"],
                   fields.get("sha256"))
        gate.check(f"{label}.fieldCount",
                   fields.get("fieldCount") == field_count(data),
                   f"{fields.get('fieldCount')} vs {field_count(data)}")
        gate.check(f"{label}.flatFieldsBytes",
                   entry.get("fieldsBytes") == fields.get("bytes"),
                   entry.get("fieldsBytes"))
        gate.check(f"{label}.flatFieldsSha",
                   entry.get("fieldsSha256") == fields.get("sha256"),
                   entry.get("fieldsSha256"))
        gate.check(f"{label}.flatFieldCount",
                   entry.get("fieldCount") == fields.get("fieldCount"),
                   entry.get("fieldCount"))

        body = car["body"]
        model = entry.get("model")
        if body is None:
            gate.check(f"{label}.modelNull", model is None, model)
        else:
            gate.check(f"{label}.modelRoute",
                       bool(model) and model.get("route") == body["route"],
                       (model or {}).get("route"))
            gate.check(f"{label}.modelPakPath",
                       bool(model) and model.get("pakPath") == body["pakPath"],
                       (model or {}).get("pakPath"))
            gate.check(f"{label}.modelSha",
                       bool(model) and model.get("sha256") == body["sha256"],
                       (model or {}).get("sha256"))
            decoded = ROOT / body["decodedPath"]
            gate.check(f"{label}.modelDecodedExists", decoded.is_file(),
                       body["decodedPath"])
            gate.check(f"{label}.modelDecodedSha",
                       decoded.is_file() and sha256_file(decoded) == body["sha256"],
                       body["decodedPath"])

        out_dir = primary / entry["slug"]
        if entry["status"] == "staged":
            staged += 1
            gate.check(f"{label}.unsupportedNull",
                       entry.get("unsupported") is None, "")
            verify_staged(gate, label, entry, car, out_dir)
        else:
            unsupported += 1
            gate.check(f"{label}.artifactsNull",
                       entry.get("artifacts") is None, "")
            verify_unsupported(gate, label, entry, out_dir)

    counts = document.get("counts") or {}
    gate.check("counts.records", counts.get("records") == 62, counts.get("records"))
    gate.check("counts.inRoster", counts.get("inRoster") == 25,
               counts.get("inRoster"))
    gate.check("counts.remaining", counts.get("remaining") == 37,
               counts.get("remaining"))
    gate.check("counts.selected", counts.get("selected") == len(entries),
               counts.get("selected"))
    gate.check("counts.staged", counts.get("staged") == staged,
               f"{counts.get('staged')} vs {staged}")
    gate.check("counts.unsupported", counts.get("unsupported") == unsupported,
               f"{counts.get('unsupported')} vs {unsupported}")
    gate.check("counts.split", staged + unsupported == len(entries),
               f"{staged}+{unsupported}")
    gate.check("counts.coverage",
               counts.get("coverage") == counts.get("inRoster", 0) + staged,
               counts.get("coverage"))
    gate.check("counts.coverage=57", counts.get("coverage") == 57,
               counts.get("coverage"))
    return staged, unsupported


def verify_staged(gate: Gate, label: str, entry: dict, car: dict,
                  out_dir: Path) -> None:
    staged_path = out_dir / "staged.json"
    gate.check(f"{label}.stagedExists", staged_path.is_file(), rel(staged_path))
    if not staged_path.is_file():
        return
    staged = json.loads(staged_path.read_text(encoding="utf-8"))
    gate.check(f"{label}.stagedKind",
               staged.get("kind") == "blur.vehicle-batch.car-staging",
               staged.get("kind"))
    gate.check(f"{label}.stagedSchema", staged.get("schema") == STAGE_SCHEMA,
               staged.get("schema"))
    gate.check(f"{label}.stagedStatus", staged.get("status") == "staged",
               staged.get("status"))
    gate.check(f"{label}.stagedIndex",
               staged.get("recordIndex") == entry["recordIndex"],
               staged.get("recordIndex"))
    gate.check(f"{label}.inputBody",
               (staged.get("input") or {}).get("body") == car["body"]["sha256"],
               (staged.get("input") or {}).get("body"))

    record = staged.get("record") or {}
    gate.check(f"{label}.recordSlug", record.get("slug") == entry["slug"], "")
    gate.check(f"{label}.recordId", record.get("recordId") == entry["recordId"],
               "")
    gate.check(f"{label}.recordName",
               record.get("recordName") == entry["recordName"], "")
    gate.check(f"{label}.recordDrive",
               record.get("drivetrain") == car["drivetrain"], "")
    gate.check(f"{label}.recordMass",
               float(record.get("massKg") or 0) == float(car["massKg"]), "")
    gate.check(f"{label}.recordWheelBase",
               (record.get("physics") or {}).get("wheelBase")
               == car["physics"]["wheelBase"], "")
    physics = record.get("physics") or {}
    fields = entry["fields"]
    gate.check(f"{label}.recordFieldsBytes",
               physics.get("fieldsBytes") == fields["bytes"], "")
    gate.check(f"{label}.recordFieldsSha",
               physics.get("fieldsSha256") == fields["sha256"], "")
    gate.check(f"{label}.recordFieldCount",
               physics.get("fieldCount") == fields["fieldCount"], "")

    artifacts = entry.get("artifacts") or {}
    staged_artifacts = staged.get("artifacts") or {}
    for key, filename in ARTIFACTS:
        path = out_dir / filename
        gate.check(f"{label}.artifact[{key}].exists", path.is_file(), rel(path))
        if not path.is_file():
            continue
        actual = {"bytes": path.stat().st_size, "sha256": sha256_file(path)}
        gate.check(f"{label}.artifact[{key}].roster",
                   artifacts.get(key) == actual,
                   f"{artifacts.get(key)} vs {actual}")
        gate.check(f"{label}.artifact[{key}].staged",
                   staged_artifacts.get(filename) == actual, filename)

    manifest_path = out_dir / "manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        gate.check(f"{label}.manifestKind",
                   manifest.get("kind") == "blur.car-part-manifest",
                   manifest.get("kind"))
        source = manifest.get("source") or {}
        gate.check(f"{label}.manifestSlug",
                   (source.get("car") or {}).get("slug") == entry["slug"], "")
        gate.check(f"{label}.manifestModel",
                   (source.get("model") or "").endswith(
                       car["body"]["sha256"] + ".decoded"),
                   source.get("model"))
        diagnostics = manifest.get("diagnostics") or {}
        draws = manifest.get("draws") or []
        gate.check(f"{label}.manifestDraws",
                   int(diagnostics.get("drawCount") or 0) > 0
                   and len(draws) == diagnostics.get("drawCount"),
                   f"{len(draws)}/{diagnostics.get('drawCount')}")
        gate.check(f"{label}.manifestWheels",
                   diagnostics.get("wheelGroupCount") == 4,
                   diagnostics.get("wheelGroupCount"))

    mesh_path = out_dir / "mesh.json"
    if mesh_path.is_file():
        mesh = json.loads(mesh_path.read_text(encoding="utf-8"))
        gate.check(f"{label}.meshPositions",
                   int(mesh.get("vertexCount") or 0) * 3
                   == len(mesh.get("positions") or []),
                   mesh.get("vertexCount"))
        gate.check(f"{label}.meshIndices",
                   len(mesh.get("indices") or []) % 3 == 0,
                   len(mesh.get("indices") or []))

    scene_path = out_dir / "scene-report.json"
    if scene_path.is_file():
        scene = json.loads(scene_path.read_text(encoding="utf-8"))
        gate.check(f"{label}.sceneStatus", scene.get("status") == "ok",
                   scene.get("status"))
        uv0 = scene.get("uv0") or []
        gate.check(f"{label}.sceneUv0", len(uv0) > 0 and len(uv0) % 2 == 0,
                   len(uv0))


def verify_unsupported(gate: Gate, label: str, entry: dict,
                       out_dir: Path) -> None:
    unsupported = entry.get("unsupported") or {}
    gate.check(f"{label}.unsupportedPresent", bool(unsupported), "")
    gate.check(f"{label}.unsupportedCode", bool(unsupported.get("code")),
               unsupported.get("code"))
    gate.check(f"{label}.unsupportedDetail", bool(unsupported.get("detail")),
               "")
    gate.check(f"{label}.unsupportedSummary", bool(unsupported.get("summary")),
               unsupported.get("summary"))
    gate.check(f"{label}.unsupportedMissing", bool(unsupported.get("missing")),
               unsupported.get("missing"))
    gate.check(f"{label}.unsupportedAllowed",
               unsupported.get("code") in ALLOWED_UNSUPPORTED,
               unsupported.get("code"))
    gate.check(f"{label}.noManifest",
               not (out_dir / "manifest.json").is_file(), "")
    staged_path = out_dir / "staged.json"
    if staged_path.is_file():
        staged = json.loads(staged_path.read_text(encoding="utf-8"))
        gate.check(f"{label}.noStagedClaim", staged.get("status") != "staged",
                   staged.get("status"))
    else:
        gate.check(f"{label}.noStagedClaim", True, "no staged.json")

    blocked_path = out_dir / "blocked.json"
    gate.check(f"{label}.blockedExists", blocked_path.is_file(), rel(blocked_path))
    if blocked_path.is_file():
        blocked = json.loads(blocked_path.read_text(encoding="utf-8"))
        gate.check(f"{label}.blockedStatus", blocked.get("status") == "blocked",
                   blocked.get("status"))
        gate.check(f"{label}.blockedRosterStatus",
                   blocked.get("rosterStatus") == "unsupported",
                   blocked.get("rosterStatus"))
        gate.check(f"{label}.blockedMissing",
                   blocked.get("missing") == unsupported.get("missing"),
                   f"{blocked.get('missing')} vs {unsupported.get('missing')}")


def verify_determinism(gate: Gate, document: dict, primary: Path,
                       repeat: Path) -> None:
    primary_path = primary / "batch-roster.json"
    repeat_path = repeat / "batch-roster.json"
    gate.check("determinism.rosterExists", repeat_path.is_file(), rel(repeat_path))
    if not repeat_path.is_file():
        return
    gate.check("determinism.rosterSha",
               sha256_file(primary_path) == sha256_file(repeat_path),
               f"{sha256_file(primary_path)} vs {sha256_file(repeat_path)}")
    repeat_doc = json.loads(repeat_path.read_text(encoding="utf-8"))
    gate.check("determinism.rosterEntries",
               repeat_doc.get("entries") == document.get("entries"), "")
    gate.check("determinism.rosterCounts",
               repeat_doc.get("counts") == document.get("counts"), "")

    for entry in document.get("entries") or []:
        if entry.get("status") != "staged":
            continue
        slug = entry["slug"]
        label = f"det[{slug}]"
        first_path = primary / slug / "staged.json"
        second_path = repeat / slug / "staged.json"
        gate.check(f"{label}.stagedExists", second_path.is_file(), "")
        if not (first_path.is_file() and second_path.is_file()):
            continue
        first = json.loads(first_path.read_text(encoding="utf-8"))
        second = json.loads(second_path.read_text(encoding="utf-8"))
        gate.check(f"{label}.input", first.get("input") == second.get("input"), "")
        gate.check(f"{label}.hashes", first.get("hashes") == second.get("hashes"),
                   "")
        gate.check(f"{label}.artifacts",
                   first.get("artifacts") == second.get("artifacts"), "")
        for _key, filename in ARTIFACTS:
            gate.check(f"{label}.file[{filename}]",
                       (primary / slug / filename).is_file()
                       and (repeat / slug / filename).is_file()
                       and sha256_file(primary / slug / filename)
                       == sha256_file(repeat / slug / filename),
                       filename)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--spec", type=Path, default=SPEC_DEFAULT)
    parser.add_argument("--primary", type=Path, default=PRIMARY_DEFAULT)
    parser.add_argument("--repeat", type=Path, default=REPEAT_DEFAULT)
    parser.add_argument("--out", type=Path, default=OUT_DEFAULT)
    parser.add_argument("--skip-determinism", action="store_true")
    args = parser.parse_args()

    gate = Gate()
    verify_inputs(gate, args.spec, ROSTER, args.primary, args.repeat,
                  require_repeat=not args.skip_determinism)
    if not (args.primary / "batch-roster.json").is_file():
        payload = {
            "kind": "blur.vehicle-batch.roster-verify",
            "version": 1,
            "status": "FAIL",
            "generatedBy": "probes/vehicle-batch/tools/verify_batch_roster.py",
            "counts": {"checks": len(gate.checks),
                       "passed": len(gate.checks) - len(gate.failures()),
                       "failed": len(gate.failures()),
                       "staged": 0, "unsupported": 0, "coverage": 0},
            "failures": gate.failures(),
            "checks": gate.checks,
        }
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_bytes(
            (json.dumps(payload, indent=1, sort_keys=True, ensure_ascii=False)
             + "\n").encode("utf-8"))
        print(f"FAIL 0/{len(gate.checks)} checks passed")
        return 1

    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    roster = json.loads(ROSTER.read_text(encoding="utf-8"))
    document = json.loads(
        (args.primary / "batch-roster.json").read_text(encoding="utf-8"))
    staged, unsupported = verify_document(gate, spec, roster, document,
                                          args.primary)
    if not args.skip_determinism:
        verify_determinism(gate, document, args.primary, args.repeat)

    failures = gate.failures()
    checks = len(gate.checks)
    passed = checks - len(failures)
    coverage = (document.get("counts") or {}).get("coverage")
    payload = {
        "kind": "blur.vehicle-batch.roster-verify",
        "version": 1,
        "status": "PASS" if not failures else "FAIL",
        "generatedBy": "probes/vehicle-batch/tools/verify_batch_roster.py",
        "inputs": {
            "spec": {"path": rel(args.spec), "sha256": sha256_file(args.spec)},
            "batchRoster": {
                "path": rel(args.primary / "batch-roster.json"),
                "sha256": sha256_file(args.primary / "batch-roster.json"),
            },
            "repeatBatchRoster": {
                "path": rel(args.repeat / "batch-roster.json"),
                "sha256": (sha256_file(args.repeat / "batch-roster.json")
                           if (args.repeat / "batch-roster.json").is_file()
                           else None),
            },
            "roster": {"path": rel(ROSTER), "sha256": sha256_file(ROSTER)},
        },
        "counts": {
            "checks": checks,
            "passed": passed,
            "failed": len(failures),
            "staged": staged,
            "unsupported": unsupported,
            "coverage": coverage,
        },
        "failures": failures,
        "checks": gate.checks,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(
        (json.dumps(payload, indent=1, sort_keys=True, ensure_ascii=False)
         + "\n").encode("utf-8"))

    print(f"batch roster: {staged} staged, {unsupported} unsupported, "
          f"coverage {coverage}/62")
    for failure in failures:
        print(f"  FAIL {failure['name']}: {failure['detail']}")
    print(f"{payload['status']} {passed}/{checks} checks passed")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
