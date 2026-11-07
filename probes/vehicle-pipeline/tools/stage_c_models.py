"""Stage-load every provable C model with the committed builders (read-only inputs).

For each `provable` record in `_work/vehicle-pipeline/c-aliases.json` this probe:

1. uses the decoded body model from the alias audit (decoded from `root.pak`);
2. runs `probes/car-parts/tools/build_manifest.py` into a staging directory only
   (`_work/vehicle-pipeline/c-staging/<slug>/`) - no committed car-parts file and
   no e1-drive file is touched;
3. reads the builder's `scene-report.json` for body draws, LOD0 vertices,
   triangles and UV0 validity;
4. runs `tools/inspect_car_materials.py` into the same staging directory for the
   independent static-albedo / texture counts;
5. parses the referenced wheel model with `scene_inspect.exe` and
   `model_inspect.exe` to prove the wheel asset loads too.

The tool records exact failures and never substitutes a model.

Usage:
  python probes/vehicle-pipeline/tools/stage_c_models.py [--only 23]
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
HARNESS = ROOT / "engine/harness/t005d-vehicle"
E1_TOOLS = ROOT / "probes/e1-drive/tools"
for path in (TOOLS, HARNESS, E1_TOOLS):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

OUT = ROOT / "_work/vehicle-pipeline"
STAGING = OUT / "c-staging"
ALIASES = OUT / "c-aliases.json"
SCENE_EXE = ROOT / "_work/build/asset-reader-native/Release/scene_inspect.exe"
MODEL_EXE = ROOT / "_work/build/asset-reader-native/Release/model_inspect.exe"
BUILD_MANIFEST = ROOT / "probes/car-parts/tools/build_manifest.py"
MATERIAL_TRAVERSAL = ROOT / "tools/inspect_car_materials.py"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(command: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=timeout)


def scene_info(decoded: Path) -> dict:
    proc = run([str(SCENE_EXE), str(decoded)], timeout=300)
    if proc.returncode != 0:
        return {"status": "error", "reason": (proc.stderr or proc.stdout or "").strip()[:500]}
    doc = json.loads(proc.stdout)
    positions = doc.get("positions") or []
    indices = doc.get("indices") or []
    meta = doc.get("metadata") or {}
    uv0 = doc.get("uv0") or []
    return {
        "status": doc.get("status"),
        "drawCount": len(doc.get("draws") or []),
        "vertexCount": int(meta.get("vertexCount") or len(positions) // 3),
        "triangleCount": int(meta.get("triangleCount") or len(indices) // 3),
        "uv0ValidVertices": int(meta.get("uv0ValidVertices") or 0),
        "uv0PlaceholderVertices": int(meta.get("uv0PlaceholderVertices") or 0),
        "uv0Bytes": len(uv0) * 4,
        "partialSceneTraversal": bool(meta.get("partialSceneTraversal")),
        "scope": meta.get("scope"),
    }


def model_info(decoded: Path) -> dict:
    proc = run([str(MODEL_EXE), str(decoded)], timeout=300)
    if proc.returncode != 0:
        return {"status": "error", "reason": (proc.stderr or proc.stdout or "").strip()[:500]}
    doc = json.loads(proc.stdout)
    return {"status": doc.get("status"), "chunks": len(doc.get("chunks") or [])}


def basic_scene(decoded: Path) -> dict:
    """Compact scene summary used for body geometry/UV (audit_cars authority)."""
    proc = run([str(SCENE_EXE), str(decoded)], timeout=300)
    if proc.returncode != 0:
        return {"status": "error", "reason": (proc.stderr or proc.stdout or "").strip()[:500]}
    doc = json.loads(proc.stdout)
    return audit_cars.scene_summary(doc)


def material_summary(decoded: Path, out_dir: Path) -> dict:
    if out_dir.exists():
        for child in out_dir.iterdir():
            child.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)
    proc = run([sys.executable, str(MATERIAL_TRAVERSAL),
                "--input", str(decoded), "--out-dir", str(out_dir)], timeout=600)
    if proc.returncode != 0:
        return {"status": "error", "reason": (proc.stderr or proc.stdout or "").strip()[:500]}
    resolved = json.loads((out_dir / "corvette-materials.json").read_text(encoding="utf-8"))
    raw = json.loads((out_dir / "corvette-materials.raw.json").read_text(encoding="utf-8"))
    tex = audit_cars.texture_summary(resolved, raw)
    counts = resolved.get("statusCounts") or {}
    return {
        "status": "ok",
        "drawCount": resolved.get("drawCount"),
        "statusCounts": dict(sorted(counts.items())),
        "staticAlbedoDraws": int(counts.get("static_albedo_image_resolved", 0)),
        "uniqueTextureCount": tex["uniqueTextureCount"],
        "decodableTextureCount": tex["decodableTextureCount"],
        "undecodableTextureCount": tex["undecodableTextureCount"],
        "sourceBytes": tex["sourceBytes"],
        "rgbaBytes": tex["rgbaBytes"],
        "formats": tex["formats"],
        "manifest": rel(out_dir / "corvette-materials.json"),
        "manifestSha256": sha256_file(out_dir / "corvette-materials.json"),
        "rawManifestSha256": sha256_file(out_dir / "corvette-materials.raw.json"),
    }


def stage(record: dict) -> dict:
    slug = record["slug"]
    out_dir = STAGING / slug
    if out_dir.exists():
        for child in out_dir.iterdir():
            if child.is_dir():
                for grandchild in child.iterdir():
                    grandchild.unlink()
                child.rmdir()
            else:
                child.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)

    body_path = ROOT / record["intendedModel"]["decodedPath"]
    wheel_path = ROOT / record["wheelModel"]["decodedPath"]
    identity = record["identity"]
    mapping = (
        f"C alias (provable): record {record['index']}/{record['id']} {record['name']} -> "
        f"AmaxVehicle {identity['amaxTag']} (record {identity['amaxRecordId']}, dynamics ref "
        f"{identity['amaxRefIndex']}) -> {record['intendedModel']['pakPath']} "
        f"({record['intendedModel']['logicalBytes']} bytes, SHA-256 "
        f"{record['intendedModel']['sha256']})"
    )

    result = {
        "index": record["index"],
        "name": record["name"],
        "slug": slug,
        "identity": {key: identity[key] for key in
                     ("amaxTag", "amaxRecordId", "amaxRefIndex", "rpRecordId", "use")},
        "body": {"modelSha256": record["intendedModel"]["sha256"]},
        "wheel": {"modelSha256": record["wheelModel"]["sha256"]},
        "status": "error",
        "reason": "",
    }

    builder = run([
        sys.executable, str(BUILD_MANIFEST),
        "--model", str(body_path),
        "--scene-exe", str(SCENE_EXE),
        "--model-exe", str(MODEL_EXE),
        "--out-dir", str(out_dir),
        "--car-slug", slug,
        "--car-name", record["name"],
        "--car-mapping", mapping,
        "--model-pak-path", record["intendedModel"]["pakPath"],
    ], timeout=900)
    if builder.returncode != 0:
        result["reason"] = "build_manifest: " + (builder.stderr or builder.stdout or "").strip()[:800]
        return result
    summary = json.loads(builder.stdout)
    diag = summary["diagnostics"]
    body_scene = basic_scene(body_path)
    materials = material_summary(body_path, out_dir / "materials")
    wheel_scene = scene_info(wheel_path)
    wheel_model = model_info(wheel_path)

    result["body"] = {
        "modelSha256": record["intendedModel"]["sha256"],
        "manifest": rel(Path(summary["manifest"])),
        "manifestSha256": summary["manifestSha256"],
        "manifestBytes": summary["manifestBytes"],
        "mesh": rel(Path(summary["mesh"])),
        "meshSha256": summary["meshSha256"],
        "meshPositionsSha256": summary["meshPositionsSha256"],
        "meshIndicesSha256": summary["meshIndicesSha256"],
        "drawCount": diag["drawCount"],
        "partCount": diag["partCount"],
        "namedPartCount": diag["namedPartCount"],
        "bodyDrawCount": diag["bodyDrawCount"],
        "interiorDrawCount": diag["interiorDrawCount"],
        "glassDrawCount": diag["glassDrawCount"],
        "lightDrawCount": diag["lightDrawCount"],
        "unclassifiedDrawCount": diag["unclassifiedDrawCount"],
        "wheelGroupCount": diag["wheelGroupCount"],
        "wheelDrawCount": diag["wheelDrawCount"],
        "provenWheelDrawCount": diag["provenWheelDrawCount"],
        "ambiguousWheelDrawCount": diag["ambiguousWheelDrawCount"],
        "tyreProofTier": diag["tyreProofTier"],
        "scene": body_scene,
        "materials": materials,
    }
    result["wheel"] = {
        "pakPath": record["wheelModel"]["pakPath"],
        "logicalBytes": record["wheelModel"]["logicalBytes"],
        "modelSha256": record["wheelModel"]["sha256"],
        "model": wheel_model,
        "scene": wheel_scene,
    }

    checks = {
        "manifestBuilt": True,
        "bodyDraws": diag["bodyDrawCount"] > 0,
        "fourWheelGroups": diag["wheelGroupCount"] == 4,
        "wheelDraws": diag["wheelDrawCount"] > 0,
        "uv0": body_scene.get("uv0ValidVertices", 0) > 0,
        "textures": materials.get("status") == "ok"
                     and materials.get("staticAlbedoDraws", 0) > 0
                     and materials.get("uniqueTextureCount", 0) > 0,
        "wheelScene": wheel_scene.get("status") == "ok" and wheel_scene.get("drawCount", 0) > 0,
        "wheelModel": wheel_model.get("status") == "ok",
    }
    result["checks"] = checks
    if all(checks.values()):
        result["status"] = "loads"
        result["reason"] = (
            f"body {diag['drawCount']} draws / {diag['partCount']} parts / "
            f"{diag['wheelGroupCount']} wheel groups / {diag['wheelDrawCount']} wheel draws; "
            f"UV0 {body_scene.get('uv0ValidVertices')} valid vertices; "
            f"{materials.get('uniqueTextureCount')} textures; wheel model "
            f"{wheel_scene.get('drawCount')} draws"
        )
    else:
        failed_checks = [key for key, value in checks.items() if not value]
        result["status"] = "partial"
        result["reason"] = "failed checks: " + ", ".join(failed_checks)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", type=int, default=None, help="stage one record index")
    args = parser.parse_args()

    document = json.loads(ALIASES.read_text(encoding="utf-8"))
    records = [record for record in document["records"] if record["status"] == "provable"]
    if args.only is not None:
        records = [record for record in records if record["index"] == args.only]

    results = []
    for record in records:
        print(f"staging {record['index']:3d} {record['name']} -> "
              f"{record['intendedModel']['pakPath']}", flush=True)
        result = stage(record)
        print(f"  {result['status']}: {result['reason'][:220]}", flush=True)
        results.append(result)

    if args.only is None:
        payload = {
            "kind": "blur.vehicle-c-staging",
            "version": 1,
            "status": "PASS" if all(r["status"] == "loads" for r in results) else "PARTIAL",
            "generatedBy": "probes/vehicle-pipeline/tools/stage_c_models.py",
            "sources": {
                "aliases": {"path": rel(ALIASES), "sha256": sha256_file(ALIASES),
                            "bytes": ALIASES.stat().st_size},
                "builder": {"path": rel(BUILD_MANIFEST), "sha256": sha256_file(BUILD_MANIFEST)},
                "materialTraversal": {"path": rel(MATERIAL_TRAVERSAL),
                                      "sha256": sha256_file(MATERIAL_TRAVERSAL)},
                "sceneReader": {"path": rel(SCENE_EXE), "sha256": sha256_file(SCENE_EXE)},
                "modelReader": {"path": rel(MODEL_EXE), "sha256": sha256_file(MODEL_EXE)},
            },
            "counts": {
                "staged": len(results),
                "loads": sum(1 for r in results if r["status"] == "loads"),
                "partial": sum(1 for r in results if r["status"] == "partial"),
                "error": sum(1 for r in results if r["status"] == "error"),
                "bodyDraws": sum((r["body"].get("drawCount") or 0) for r in results),
                "bodyParts": sum((r["body"].get("partCount") or 0) for r in results),
                "wheelDraws": sum((r["body"].get("wheelDrawCount") or 0) for r in results),
                "uv0ValidVertices": sum((r["body"].get("scene", {}).get("uv0ValidVertices") or 0)
                                       for r in results),
                "uniqueTextures": sum((r["body"].get("materials", {}).get("uniqueTextureCount") or 0)
                                      for r in results),
                "textureSourceBytes": sum((r["body"].get("materials", {}).get("sourceBytes") or 0)
                                          for r in results),
            },
            "records": results,
            "limits": [
                "Staging output only; no committed car-parts, P52, E1 roster, geometry or web file changed.",
                "A load proves the body and wheel assets parse and have draws/UV/textures; it is not a drive claim.",
                "No full-game claim.",
            ],
        }
        (OUT / "c-staging-results.json").write_bytes(
            (json.dumps(payload, indent=1, sort_keys=True) + "\n").encode("utf-8"))
        print(json.dumps({"status": payload["status"], "counts": payload["counts"]}, indent=1))
    return 0


audit_cars = load_module(ROOT / "probes/vehicle-pipeline/tools/audit_cars.py", "vp_audit_cars")

if __name__ == "__main__":
    raise SystemExit(main())
