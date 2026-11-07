"""Verify the 62-record vehicle-pipeline audit against the committed readers.

Checks:
  * artifact schema, 62 unique records, A/B/C counts and classification rules;
  * A = exactly the five committed reference cars (fields + manifest + P52 + drive);
  * B = exact model + Scene reader + MdlDat + physics gate + material traversal;
  * C = no exact model, exact missing path and near-name evidence only;
  * every generated `.fields` file re-decodes byte-identically from `car_xt.py`;
  * every decoded model re-hashes to its recorded SHA-256;
  * every mapped model's Scene report and chunk tree reproduce exactly;
  * a sample of B material traversals reproduces its status counts;
  * all ten next-car part manifests exist, hash-match and cover their draws;
  * `summary.csv` and `hashes.json` agree with `cars.json`.

Output: `_work/vehicle-pipeline/verify.json`.
Usage: python probes/vehicle-pipeline/tools/verify_vehicle_pipeline.py
"""

from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
HARNESS = ROOT / "engine/harness/t005d-vehicle"
E1_TOOLS = ROOT / "probes/e1-drive/tools"
for path in (TOOLS, HARNESS, E1_TOOLS):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import car_xt  # noqa: E402
import car_roster  # noqa: E402

OUT = ROOT / "_work/vehicle-pipeline"
CARS_JSON = OUT / "cars.json"
SUMMARY_CSV = OUT / "summary.csv"
HASHES_JSON = OUT / "hashes.json"
VERIFY = OUT / "verify.json"
GAME = ROOT / "game-data/Blur"
PAK = ROOT / "game-data/Blur/cache/root.pak"
SCENE_EXE = ROOT / "_work/build/asset-reader-native/Release/scene_inspect.exe"
MODEL_EXE = ROOT / "_work/build/asset-reader-native/Release/model_inspect.exe"
MATERIAL_TRAVERSAL = ROOT / "tools/inspect_car_materials.py"

PROVEN_SLUGS = {
    "corvette-zr1-stock",
    "lotus-exige-cup260-stock",
    "dodge-challenger-stock",
    "ford-focusrs-stock",
    "audi-r8v10-stock",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    checks: list[dict] = []
    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            failures.append(name + (": " + detail if detail else ""))
        print(("PASS " if ok else "FAIL ") + name + (" - " + detail if detail else ""), flush=True)

    for path in (CARS_JSON, SUMMARY_CSV, HASHES_JSON):
        check("artifact exists " + path.name, path.is_file(), str(path))
    if failures:
        VERIFY.write_text(json.dumps({"status": "FAIL", "checks": checks, "failures": failures}, indent=1) + "\n",
                          encoding="utf-8")
        return 1

    doc = json.loads(CARS_JSON.read_text(encoding="utf-8"))
    records = doc["records"]

    check("kind/version", doc.get("kind") == "blur.vehicle-pipeline-audit" and doc.get("version") == 1,
          f"{doc.get('kind')} v{doc.get('version')}")
    check("status PASS", doc.get("status") == "PASS", str(doc.get("status")))
    check("62 records", len(records) == 62, str(len(records)))
    check("unique record indices", len({r["index"] for r in records}) == 62)
    check("unique record ids", len({r["id"] for r in records}) == 62)
    check("unique slugs", len({r["slug"] for r in records}) == 62)

    classes = Counter(r["class"] for r in records)
    counts = doc["counts"]
    check("class counts sum to 62", classes.get("A", 0) + classes.get("B", 0) + classes.get("C", 0) == 62,
          str(dict(classes)))
    check("counts match classes", counts["classA"] == classes.get("A", 0)
          and counts["classB"] == classes.get("B", 0) and counts["classC"] == classes.get("C", 0),
          json.dumps({k: counts[k] for k in ("classA", "classB", "classC")}))
    check("A is exactly five", classes.get("A", 0) == 5, str(classes.get("A", 0)))
    check("physics gate passes all 62", counts["physicsGatePass"] == 62, str(counts["physicsGatePass"]))
    check("exact model mapped 47", counts["exactModelMapped"] == 47, str(counts["exactModelMapped"]))
    check("scene parsed 47", counts["sceneParsed"] == 47, str(counts["sceneParsed"]))
    check("MdlDat parsed 47", counts["mdlDatParsed"] == 47, str(counts["mdlDatParsed"]))
    check("materials traversed 47", counts["materialsTraversed"] == 47, str(counts["materialsTraversed"]))
    check("next cars 5..10", 5 <= counts["nextCarCount"] <= 10, str(counts["nextCarCount"]))

    proven = {r["slug"] for r in records if r["class"] == "A"}
    check("proven set equals committed roster", proven == PROVEN_SLUGS, ",".join(sorted(proven)))
    check("proven list matches", set(doc["provenReferences"]) == PROVEN_SLUGS)

    # ---- classification invariants -----------------------------------------
    for r in records:
        if r["class"] == "A":
            check(f"A {r['slug']} reference flags",
                  r["proven"]["reference"] and r["proven"]["carPartsManifest"]
                  and r["proven"]["materials"] and r["proven"]["driveVerification"],
                  json.dumps(r["proven"]))
            check(f"A {r['slug']} exact model + scene + mdl",
                  r["model"]["mapping"] == "exact" and r["scene"]["status"] == "ok"
                  and r["mdlDat"]["status"] == "ok" and r["mdlDat"]["wheelGroupCount"] == 4,
                  f"{r['model'].get('pakPath')} draws={r['scene'].get('drawCount')}")
            check(f"A {r['slug']} P52 materials", r["materials"]["status"] == "proven",
                  str(r["materials"].get("manifest")))
        elif r["class"] == "B":
            check(f"B {r['slug']} exact model", r["model"]["mapping"] == "exact",
                  str(r["model"].get("pakPath")))
            check(f"B {r['slug']} scene + mdl + gate",
                  r["scene"]["status"] == "ok" and r["mdlDat"]["status"] == "ok"
                  and r["physics"]["gatePass"],
                  f"draws={r['scene'].get('drawCount')} wheelGroups={r['mdlDat'].get('wheelGroupCount')}")
            check(f"B {r['slug']} material traversal",
                  r["materials"]["status"] == "ok" and r["materials"].get("staticAlbedoDraws", 0) > 0,
                  f"{r['materials'].get('staticAlbedoDraws')} static draws")
        elif r["class"] == "C":
            check(f"C {r['slug']} no exact model", r["model"]["mapping"] == "none",
                  str(r["model"].get("expectedPath")))
            check(f"C {r['slug']} missing recorded", bool(r["missing"]),
                  "; ".join(r["missing"])[:180])
            check(f"C {r['slug']} near candidates are evidence only",
                  bool(r["model"].get("nearCandidates")),
                  str([c["model"] for c in r["model"].get("nearCandidates", [])[:2]]))

    # ---- fields re-decode byte-identically ---------------------------------
    xt = car_xt.parse(car_xt.extract(GAME))
    decoded = {}
    for rec in car_roster.record_names(xt):
        lines, _evidence = car_xt.decode_car(xt, rec["name"])
        decoded[rec["name"]] = "".join(f"{key}\t{value}\r\n" for key, value in lines).encode("utf-8")
    check("car_xt decodes 62 records", len(decoded) == 62, str(len(decoded)))
    for r in records:
        expected = decoded.get(r["name"])
        path = ROOT / r["physics"]["fieldsPath"]
        actual = path.read_bytes() if path.is_file() else b""
        check(f"fields {r['slug']} byte-identical", actual == expected,
              f"{len(actual)} B / {sha256_bytes(actual)[:12]}")
        check(f"fields {r['slug']} hash", sha256_file(path) == r["physics"]["fieldsSha256"],
              r["physics"]["fieldsSha256"][:12])

    # ---- models re-hash + reader reproduction -------------------------------
    for r in records:
        if r["model"]["mapping"] != "exact":
            continue
        model_path = ROOT / r["model"]["decodedPath"]
        check(f"model {r['slug']} bytes/hash",
              model_path.is_file() and sha256_file(model_path) == r["model"]["modelSha256"],
              f"{model_path.stat().st_size if model_path.is_file() else -1} B")

        proc = subprocess.run([str(MODEL_EXE), str(model_path)], capture_output=True, text=True,
                              encoding="utf-8")
        chunk_doc = json.loads(proc.stdout) if proc.returncode == 0 else {}
        chunks = [
            {"id": c.get("id"), "offset": c.get("offset"), "bytes": c.get("bytes"),
             "children": [{"id": ch.get("id"), "offset": ch.get("offset"), "bytes": ch.get("bytes")}
                          for ch in c.get("children") or []]}
            for c in chunk_doc.get("chunks") or []
        ]
        check(f"chunks {r['slug']} reproduce", proc.returncode == 0 and chunks == r["model"].get("chunks"),
              str(proc.stderr[:120]))

        scene_proc = subprocess.run([str(SCENE_EXE), str(model_path)], capture_output=True, text=True,
                                    encoding="utf-8")
        scene_doc = json.loads(scene_proc.stdout) if scene_proc.returncode == 0 else {}
        stored = {
            "status": scene_doc.get("status"),
            "sharedTextures": scene_doc.get("sharedTextures"),
            "draws": scene_doc.get("draws"),
            "bounds": scene_doc.get("bounds"),
            "metadata": scene_doc.get("metadata"),
        }
        digest = sha256_bytes((json.dumps(stored, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8"))
        check(f"scene {r['slug']} reproduces", scene_proc.returncode == 0
              and digest == r["scene"].get("reportSha256")
              and len(scene_doc.get("draws") or []) == r["scene"].get("drawCount"),
              f"{len(scene_doc.get('draws') or [])} draws")

    # ---- sample material traversals ----------------------------------------
    sample = ["audi-tt-stock", "ford-fr100-stock", "dodge-viperacr-stock"]
    for slug in sample:
        record = next(r for r in records if r["slug"] == slug)
        out_dir = OUT / "verify-materials" / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run([sys.executable, str(MATERIAL_TRAVERSAL),
                               "--input", str(ROOT / record["model"]["decodedPath"]),
                               "--out-dir", str(out_dir)],
                              capture_output=True, text=True, encoding="utf-8")
        if proc.returncode != 0:
            check(f"materials {slug} reproduce", False, proc.stderr[:180])
            continue
        resolved = json.loads((out_dir / "corvette-materials.json").read_text(encoding="utf-8"))
        counts = resolved.get("statusCounts") or {}
        record_counts = record["materials"].get("statusCounts") or {}
        check(f"materials {slug} status counts reproduce",
              dict(sorted(counts.items())) == dict(sorted(record_counts.items())),
              f"{dict(sorted(counts.items()))}")

    # ---- next-car manifests -------------------------------------------------
    for car in doc["nextCars"]:
        manifest = car.get("nextManifest") or {}
        check(f"next {car['slug']} built", manifest.get("status") == "built", str(manifest.get("reason")))
        if manifest.get("status") != "built":
            continue
        path = Path(manifest["manifest"])
        mesh = Path(manifest["mesh"])
        check(f"next {car['slug']} manifest hash",
              path.is_file() and "sha256:" + sha256_file(path) == manifest["manifestSha256"],
              manifest["manifestSha256"][:18])
        check(f"next {car['slug']} mesh hash",
              mesh.is_file() and "sha256:" + sha256_file(mesh) == manifest["meshSha256"],
              manifest["meshSha256"][:18])
        built = json.loads(path.read_text(encoding="utf-8"))
        record = next(r for r in records if r["slug"] == car["slug"])
        check(f"next {car['slug']} manifest content",
              built["diagnostics"]["drawCount"] == manifest["draws"]
              and built["diagnostics"]["partCount"] == manifest["parts"]
              and built["source"]["model"] == record["model"]["decodedPath"],
              f"draws={built['diagnostics']['drawCount']} parts={built['diagnostics']['partCount']}")
        check(f"next {car['slug']} wheel groups", built["diagnostics"]["wheelGroupCount"] == 4,
              str(built["diagnostics"]["wheelGroupCount"]))
        check(f"next {car['slug']} every draw owned once",
              len(built["draws"]) == built["diagnostics"]["drawCount"]
              and len({d["index"] for d in built["draws"]}) == built["diagnostics"]["drawCount"],
              f"{len(built['draws'])} draws")

    # ---- summary.csv and hashes.json ---------------------------------------
    with SUMMARY_CSV.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    check("summary.csv rows", len(rows) == 62, str(len(rows)))
    check("summary.csv classes", Counter(row["class"] for row in rows) == classes,
          str(Counter(row["class"] for row in rows)))
    check("summary.csv slugs", {row["slug"] for row in rows} == {r["slug"] for r in records})
    hashes = json.loads(HASHES_JSON.read_text(encoding="utf-8"))
    check("hashes cars.json", hashes["outputs"]["cars.json"]["sha256"] == sha256_file(CARS_JSON),
          hashes["outputs"]["cars.json"]["sha256"][:16])
    check("hashes summary.csv", hashes["outputs"]["summary.csv"]["sha256"] == sha256_file(SUMMARY_CSV),
          hashes["outputs"]["summary.csv"]["sha256"][:16])
    check("hashes inputs", hashes["inputs"] == doc["source"])
    check("no writes outside the probe output tree",
          all(str(p).startswith(str(OUT)) for p in [
              CARS_JSON, SUMMARY_CSV, HASHES_JSON, VERIFY,
              *[ROOT / r["physics"]["fieldsPath"] for r in records],
              *[ROOT / r["scene"]["reportPath"] for r in records if r["scene"].get("reportPath")],
          ]),
          "all artifacts under _work/vehicle-pipeline/")

    status = "PASS" if not failures else "FAIL"
    document = {
        "kind": "blur.vehicle-pipeline-verify",
        "version": 1,
        "status": status,
        "checks": len(checks),
        "passed": sum(1 for c in checks if c["ok"]),
        "failed": len(failures),
        "failures": failures,
        "counts": dict(classes),
        "inputs": doc["source"],
        "outputs": {
            "cars.json": hashes["outputs"]["cars.json"],
            "summary.csv": hashes["outputs"]["summary.csv"],
        },
        "results": checks,
    }
    VERIFY.write_bytes((json.dumps(document, indent=1, sort_keys=True) + "\n").encode("utf-8"))
    print(json.dumps({"status": status, "checks": len(checks),
                      "passed": document["passed"], "failed": len(failures),
                      "counts": dict(classes)}, indent=1))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
