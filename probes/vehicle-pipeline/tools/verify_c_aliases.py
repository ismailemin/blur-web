"""Verify `_work/vehicle-pipeline/c-aliases.json` (deterministic, >= 30 checks).

The verifier re-derives the resolution from the same sources, compares it with
the written JSON, re-checks every intended/wheel model against `root.pak`, and
checks the shipped-source citations that justify the tag -> body-model rule.

Usage:
  python probes/vehicle-pipeline/tools/verify_c_aliases.py
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
for path in (TOOLS,):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from inspect_asset_layout import pak_index  # noqa: E402

OUT = ROOT / "_work/vehicle-pipeline"
DOC_PATH = OUT / "c-aliases.json"
LOG_PATH = ROOT / "_work/logs/vehicle-pipeline"
AUDIT_PATH = ROOT / "probes/vehicle-pipeline/tools/audit_c_aliases.py"
PAK = ROOT / "game-data/Blur/cache/root.pak"
BUILD_MANIFEST = ROOT / "probes/car-parts/tools/build_manifest.py"

CHECKS: list[dict] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})
    if not ok:
        print(f"FAIL {name}: {detail}")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def line_text(relative: str, line: int) -> str:
    return (ROOT / relative).read_text(encoding="utf-8").splitlines()[line - 1]


def main() -> int:
    audit = load_module(AUDIT_PATH, "vp_audit_c_aliases")
    document = json.loads(DOC_PATH.read_text(encoding="utf-8"))
    records = document["records"]
    by_index = {record["index"]: record for record in records}
    provable = [record for record in records if record["status"] == "provable"]
    unsupported = [record for record in records if record["status"] == "unsupported"]

    index = pak_index(PAK)
    pak_rows = {row["path"].lower(): row for row in index["entries"] if not row["directory"]}

    # --- document identity and regeneration --------------------------------
    check("doc.kind", document.get("kind") == "blur.vehicle-c-aliases")
    check("doc.version", document.get("version") == 1)
    check("doc.status", document.get("status") == "PASS")
    check("doc.recordCount", len(records) == 15, str(len(records)))
    check("doc.carsHash", document["sources"]["cars"]["sha256"]
          == sha256_file(OUT / "cars.json"))
    check("doc.amaxHash", document["sources"]["amax"]["sha256"] == audit.load_amax()["sha256"])
    check("doc.amaxBytes", document["sources"]["amax"]["bytes"] > 0)

    rebuilt = audit.build_document(write=False)
    check("regen.identical",
          json.dumps(rebuilt, indent=1, sort_keys=True) == json.dumps(document, indent=1, sort_keys=True),
          "fresh re-derivation differs from c-aliases.json")
    again = audit.build_document(write=False, skip_models=True)
    check("regen.deterministic",
          [(r["index"], r["status"], (r["intendedModel"] or {}).get("pakPath"))
           for r in again["records"]]
          == [(r["index"], r["status"], (r["intendedModel"] or {}).get("pakPath"))
              for r in rebuilt["records"]])

    # --- counts --------------------------------------------------------------
    check("counts.records", document["counts"]["records"] == 15)
    check("counts.provable", document["counts"]["provable"] == 14, str(document["counts"]["provable"]))
    check("counts.unsupported", document["counts"]["unsupported"] == 1)
    check("counts.uniqueModels", document["counts"]["uniqueIntendedModels"] == 14)
    check("counts.uniqueWheels", document["counts"]["uniqueWheelModels"] == 12)
    check("counts.additionalExplicit", document["counts"]["additionalExplicitModels"] == 3)
    check("counts.nameEqualsTag", document["counts"]["recordsWhereRecordNameEqualsAmaxTag"] == 0)
    check("counts.provableList", len(provable) == 14)
    check("counts.unsupportedList", len(unsupported) == 1)

    # --- unsupported record --------------------------------------------------
    default = by_index.get(8)
    check("unsupported.exists", default is not None and default["status"] == "unsupported")
    check("unsupported.name", default["name"] == "DefaultCar")
    check("unsupported.noIdentity", default["identity"] is None)
    check("unsupported.noIntendedModel", default["intendedModel"] is None)
    check("unsupported.noVehicles", default["explicitVehicles"] == [])
    check("unsupported.evidence", len(default["missingEvidence"]) >= 3)
    check("unsupported.placeholder",
          default["nearestPakModel"]["logicalBytes"] < 1_000_000
          and default["nearestPakModel"]["medianRealCarBytes"] > 3_000_000,
          json.dumps(default["nearestPakModel"], sort_keys=True))

    # --- per-record identity and models -------------------------------------
    for record in provable:
        prefix = f"record{record['index']:02d}.{record['name']}."
        identity = record["identity"]
        model = record["intendedModel"]
        wheel = record["wheelModel"]
        check(prefix + "status", record["status"] == "provable")
        check(prefix + "identityKind",
              identity["kind"] == "amax.bin AmaxVehicle.dynamics FlaskHandle")
        check(prefix + "exactRecordId",
              identity["handleResolvesToExactRecordId"] is True
              and identity["rpRecordId"] == record["id"])
        check(prefix + "rpType", identity.get("rpType") == "RP_CarDynamics")
        check(prefix + "use", identity["use"] is True)
        check(prefix + "modelPathRule",
              model["pakPath"] == "\\models\\vehicles\\" + identity["amaxTag"].lower() + ".model")
        check(prefix + "modelExists", model["pakPath"].lower() in pak_rows)
        check(prefix + "modelBytes", model["logicalBytes"] == pak_rows[model["pakPath"].lower()]["logical_bytes"])
        check(prefix + "modelHash",
              sha256_file(ROOT / model["decodedPath"]) == model["sha256"]
              and Path(model["decodedPath"]).stat().st_size == model["decodedBytes"])
        check(prefix + "wheelPathRule",
              wheel["pakPath"] == "\\models\\vehicles\\wheels\\" + wheel["stem"] + ".model")
        check(prefix + "wheelExists", wheel["pakPath"].lower() in pak_rows)
        check(prefix + "wheelHash",
              sha256_file(ROOT / wheel["decodedPath"]) == wheel["sha256"])
        check(prefix + "similarityRecorded",
              isinstance(record["recordNameSimilarityToIntendedModelStem"], float))
        check(prefix + "noNameSimilarity", record["nameSimilarityUsed"] is False)

    # --- specific identity proofs -------------------------------------------
    bmw = by_index[23]
    check("proof.bmwTagDiffers",
          bmw["identity"]["amaxTag"] == "BMW_1SeriesTii_Stock"
          and bmw["intendedModel"]["stem"] != bmw["recordNameStem"],
          f"{bmw['recordNameStem']} -> {bmw['intendedModel']['stem']}")
    check("proof.bmwLowSimilarity",
          bmw["recordNameSimilarityToIntendedModelStem"] < 0.70,
          str(bmw["recordNameSimilarityToIntendedModelStem"]))
    check("proof.covetteTypo",
          by_index[75]["identity"]["amaxTag"] == "Corvette_C3_Rat"
          and by_index[75]["intendedModel"]["stem"] == "corvette_c3_rat")
    check("proof.nismoSpace",
          by_index[22]["identity"]["amaxTag"] == "Nissan_350ZNismo_Stock"
          and " " in by_index[22]["name"])
    check("proof.shelbyExplicit",
          by_index[39]["identity"]["amaxTag"] == "Shelby_MustangGT500_Stock"
          and by_index[39]["intendedModel"]["stem"] == "shelby_mustanggt500_stock")
    check("proof.stockgrpcMulti",
          len(by_index[7]["explicitVehicles"]) == 2
          and len(by_index[63]["explicitVehicles"]) == 2
          and len(by_index[71]["explicitVehicles"]) == 2)
    check("proof.alternatesExist",
          all(alt["exists"] for record in records for alt in record["additionalExplicitModels"]))
    check("proof.alternatesParented",
          all(alt["parentAmaxTag"] for record in records for alt in record["additionalExplicitModels"]))

    # --- shipped-source rule citations --------------------------------------
    citations = document["sources"]["engineRule"]
    check("source.citationCount", len(citations) == 5)
    check("source.levelStateBody",
          "models/vehicles/%s.model" in line_text(citations[0]["path"], citations[0]["line"])
          and "veh->tag" in line_text(citations[0]["path"], citations[0]["line"]))
    check("source.raceLogicBody",
          "models/vehicles/%s.model" in line_text(citations[1]["path"], citations[1]["line"])
          and "pAmaxVehicle->tag" in line_text(citations[1]["path"], citations[1]["line"]))
    check("source.wheelRule",
          "models/vehicles/wheels/%s.model" in line_text(citations[3]["path"], citations[3]["line"]))
    check("source.defaultFallback",
          "DefaultCar" in line_text(citations[4]["path"], citations[4]["line"]))
    check("source.xtFormat",
          document["sources"]["formats"][0]["sha256"]
          == sha256_file(ROOT / "probes/asset-reader/FORMAT-xt.md"))

    # --- staging load results ------------------------------------------------
    staging_path = OUT / "c-staging-results.json"
    check("staging.exists", staging_path.exists())
    if staging_path.exists():
        staging = json.loads(staging_path.read_text(encoding="utf-8"))
        staged = {entry["index"]: entry for entry in staging["records"]}
        check("staging.kind", staging.get("kind") == "blur.vehicle-c-staging")
        check("staging.status", staging.get("status") == "PASS")
        check("staging.count", len(staging["records"]) == 14)
        check("staging.loads", staging["counts"]["loads"] == 14)
        check("staging.builderHash",
              staging["sources"]["builder"]["sha256"] == sha256_file(BUILD_MANIFEST))
        for record in provable:
            prefix = f"staging{record['index']:02d}."
            entry = staged.get(record["index"])
            check(prefix + "present", entry is not None)
            if entry is None:
                continue
            body = entry["body"]
            wheel = entry["wheel"]
            check(prefix + "status", entry["status"] == "loads", entry.get("reason", ""))
            check(prefix + "bodyHash", body["modelSha256"] == record["intendedModel"]["sha256"])
            check(prefix + "wheelHash", wheel["modelSha256"] == record["wheelModel"]["sha256"])
            check(prefix + "bodyDraws", body["drawCount"] > 0 and body["partCount"] > 0)
            check(prefix + "fourWheelGroups", body["wheelGroupCount"] == 4)
            check(prefix + "wheelDraws", body["wheelDrawCount"] > 0)
            check(prefix + "uv0", body["scene"]["uv0ValidVertices"] > 0)
            check(prefix + "textures",
                  body["materials"]["staticAlbedoDraws"] > 0
                  and body["materials"]["uniqueTextureCount"] > 0)
            check(prefix + "wheelScene",
                  wheel["scene"]["status"] == "ok" and wheel["scene"]["drawCount"] > 0)
            manifest_path = ROOT / body["manifest"]
            mesh_path = ROOT / body["mesh"]
            check(prefix + "manifestFile",
                  manifest_path.exists() and sha256_file(manifest_path) == body["manifestSha256"])
            check(prefix + "meshFile",
                  mesh_path.exists() and sha256_file(mesh_path) == body["meshSha256"])
            if manifest_path.exists():
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                check(prefix + "manifestDraws",
                      manifest["diagnostics"]["drawCount"] == body["drawCount"])
                check(prefix + "manifestSource",
                      manifest["source"]["modelSha256"] == record["intendedModel"]["sha256"]
                      and manifest["source"]["modelPakPath"] == record["intendedModel"]["pakPath"])
        sums = {
            "bodyDraws": sum(entry["body"]["drawCount"] for entry in staged.values()),
            "bodyParts": sum(entry["body"]["partCount"] for entry in staged.values()),
            "wheelDraws": sum(entry["body"]["wheelDrawCount"] for entry in staged.values()),
            "uv0ValidVertices": sum(entry["body"]["scene"]["uv0ValidVertices"]
                                    for entry in staged.values()),
            "uniqueTextures": sum(entry["body"]["materials"]["uniqueTextureCount"]
                                  for entry in staged.values()),
            "textureSourceBytes": sum(entry["body"]["materials"]["sourceBytes"]
                                      for entry in staged.values()),
        }
        check("staging.sums", all(staging["counts"][key] == value for key, value in sums.items()),
              json.dumps(sums, sort_keys=True))

    # --- result --------------------------------------------------------------
    failed = [item for item in CHECKS if not item["ok"]]
    result = {
        "kind": "blur.vehicle-c-aliases-verify",
        "version": 1,
        "status": "PASS" if not failed else "FAIL",
        "checks": len(CHECKS),
        "passed": len(CHECKS) - len(failed),
        "failed": len(failed),
        "failures": failed,
        "document": {
            "path": "_work/vehicle-pipeline/c-aliases.json",
            "sha256": sha256_file(DOC_PATH),
            "bytes": DOC_PATH.stat().st_size,
        },
        "items": CHECKS,
    }
    LOG_PATH.mkdir(parents=True, exist_ok=True)
    (OUT / "c-aliases-verify.json").write_bytes(
        (json.dumps(result, indent=1, sort_keys=True) + "\n").encode("utf-8"))
    print(json.dumps({
        "status": result["status"],
        "checks": result["checks"],
        "passed": result["passed"],
        "failed": result["failed"],
        "documentSha256": result["document"]["sha256"],
    }, indent=1))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
