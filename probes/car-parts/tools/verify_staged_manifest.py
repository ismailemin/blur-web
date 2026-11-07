"""Verify one staged car-part manifest directory (no roster or browser dependency).

This wraps the shared `verify_manifest.verify_manifest` checks and adds optional
evidence checks for the body shell, wheel groups (including a typed absent
caliper), UV0 buffers and the independent material traversal. It is read-only
and writes only the `--out` JSON.

Usage:
  python probes/car-parts/tools/verify_staged_manifest.py \
      --manifest-dir _work/vehicle-pipeline/manifests/hummer-h2-offroad \
      --slug hummer-h2-offroad [--model <decoded> --model-sha256 <hex> --pak-path <path>]
      [--materials <corvette-materials.json>] [--uv0 <corvette-uv0.json>]
      [--model-parts <dump_model_parts.json>] --out <result.json>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import verify_manifest as vm  # noqa: E402


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest-dir", required=True, type=Path)
    parser.add_argument("--slug", default=None)
    parser.add_argument("--model", type=Path, default=None)
    parser.add_argument("--model-sha256", default=None)
    parser.add_argument("--pak-path", default=None)
    parser.add_argument("--materials", type=Path, default=None)
    parser.add_argument("--uv0", type=Path, default=None)
    parser.add_argument("--model-parts", type=Path, default=None,
                        help="output of dump_model_parts.py for the same model")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    failures: list[str] = []
    result: dict = {"kind": "blur.car-part-staged-verify", "version": 1}
    label = args.slug or args.manifest_dir.name

    manifest_path = args.manifest_dir / "manifest.json"
    if not manifest_path.is_file():
        raise SystemExit(f"missing manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    mesh_path = args.manifest_dir / manifest["mesh"]["path"]
    if not mesh_path.is_file():
        failures.append(f"missing mesh: {mesh_path}")

    expected = None
    if args.model_sha256 or args.pak_path or args.slug:
        expected = {
            "modelSha256": args.model_sha256,
            "pakPath": args.pak_path,
            "slug": args.slug,
            "prefixCandidates": [args.pak_path] if args.pak_path else [],
        }
        expected = {key: value for key, value in expected.items() if value is not None}

    try:
        vm.verify_manifest(manifest, expected, failures, label, args.manifest_dir)
    except Exception as exc:  # noqa: BLE001
        failures.append(f"shared verifier raised: {exc}")

    if args.model is not None:
        actual = sha256(args.model)
        if args.model_sha256 and actual != args.model_sha256:
            failures.append(f"model SHA-256 {actual} != {args.model_sha256}")
        result["model"] = {"path": str(args.model), "sha256": actual, "bytes": args.model.stat().st_size}

    # Body shell presence.
    body_parts = [part for part in manifest["parts"] if part["partKind"] == "body"]
    if not body_parts:
        failures.append("no body part")
    result["body"] = {
        "bodyDrawCount": manifest["diagnostics"].get("bodyDrawCount"),
        "bodyParts": [part["id"] for part in body_parts],
        "nonWheelParts": manifest["diagnostics"]["partCount"] - len(manifest["wheelGroups"]),
    }

    # Wheel groups, including a typed absent caliper.
    groups = manifest["wheelGroups"]
    group_rows = []
    for group in groups:
        absent = sorted(member["wheelPart"] for member in group.get("absentMembers", []))
        members = sorted(member["wheelPart"] for member in group["memberParts"])
        if "brakeCaliper" in absent:
            if group.get("caliper") != "absent":
                failures.append(f"{group['id']} declares an absent caliper without caliper:\"absent\"")
            if "brakeCaliper" in members:
                failures.append(f"{group['id']} lists a caliper member and a caliper absence")
            if group["spin"]["staticMembers"]:
                failures.append(f"{group['id']} lists static members for an absent caliper")
        group_rows.append({
            "id": group["id"],
            "members": members,
            "absentMembers": absent,
            "caliper": group.get("caliper"),
            "previewDraws": len(group["previewDraws"]),
            "provenDraws": len(group["provenDraws"]),
            "axis": group["spin"]["axis"],
            "thinAxis": group["spin"]["axisEvidence"]["thinAxis"],
            "roundAxes": group["spin"]["axisEvidence"]["roundAxes"],
        })
    if len(groups) != 4:
        failures.append(f"expected four wheel groups, found {len(groups)}")
    caliper_draws = [draw for draw in manifest["draws"] if draw.get("partKind") == "brakeCaliper"]
    if any(group.get("caliper") == "absent" for group in groups) and caliper_draws:
        failures.append("caliper is marked absent but caliper draws exist")
    result["wheelGroups"] = group_rows
    result["wheelDrawCounts"] = {
        "wheelDrawCount": manifest["diagnostics"]["wheelDrawCount"],
        "tyreDrawCount": manifest["diagnostics"]["tyreDrawCount"],
        "rimDrawCount": manifest["diagnostics"]["rimDrawCount"],
        "brakeDiscDrawCount": manifest["diagnostics"]["brakeDiscDrawCount"],
        "brakeCaliperDrawCount": manifest["diagnostics"]["brakeCaliperDrawCount"],
        "absentWheelParts": manifest["diagnostics"].get("absentWheelParts", []),
    }

    # UV0 evidence.
    if args.uv0 is not None:
        buffers = json.loads(args.uv0.read_text(encoding="utf-8"))
        available = [row for row in buffers if row.get("available")]
        unavailable = [row for row in buffers if not row.get("available")]
        valid_vertices = sum(int(row.get("vertexCount") or 0) for row in available)
        if not available or valid_vertices <= 0:
            failures.append("no valid UV0 buffer")
        for row in available:
            if not row.get("float32LESha256"):
                failures.append(f"UV0 buffer {row.get('globalVertexBuffer')} has no hash")
        result["uv0"] = {
            "buffers": len(buffers),
            "availableBuffers": [row["globalVertexBuffer"] for row in available],
            "unavailableBuffers": [row["globalVertexBuffer"] for row in unavailable],
            "validVertices": valid_vertices,
        }

    # Independent material traversal evidence.
    if args.materials is not None:
        materials = json.loads(args.materials.read_text(encoding="utf-8"))
        if materials.get("drawCount") != manifest["diagnostics"]["drawCount"]:
            failures.append("material draw count differs from the manifest draw count")
        names = set()
        for draw in materials.get("draws", []):
            for known in (draw.get("knownTextures") or {}).values():
                texture = known.get("texture") or {}
                if texture.get("name"):
                    names.add(texture["name"])
        status = dict(sorted((materials.get("statusCounts") or {}).items()))
        result["materials"] = {
            "drawCount": materials.get("drawCount"),
            "statusCounts": status,
            "uniqueReferencedTextures": sorted(names),
            "uniqueTextureCount": len(names),
            "inputSha256": materials.get("sha256"),
        }
        if materials.get("sha256") != manifest["source"]["modelSha256"]:
            failures.append("material input hash differs from the manifest model hash")

    # MdlDat element evidence (optional).
    if args.model_parts is not None:
        parts_doc = json.loads(args.model_parts.read_text(encoding="utf-8"))
        elements = parts_doc["elements"]
        wheel = [element for element in elements
                 if any(token in element["name"].lower()
                        for token in ("e_wheel_", "e_tyre_", "e_alloyrim_", "e_brakedisc_", "e_brakecaliper_"))]
        calipers = [element["name"] for element in wheel if "brakecaliper" in element["name"].lower()]
        result["modelParts"] = {
            "models": len(parts_doc["models"]),
            "elements": len(elements),
            "wheelElements": len(wheel),
            "caliperElements": calipers,
        }

    result["manifest"] = {
        "path": str(manifest_path),
        "sha256": sha256(manifest_path),
        "bytes": manifest_path.stat().st_size,
    }
    if mesh_path.is_file():
        result["mesh"] = {
            "path": str(mesh_path),
            "sha256": sha256(mesh_path),
            "bytes": mesh_path.stat().st_size,
        }
    result["failures"] = failures
    result["passed"] = not failures
    result["checks"] = "shared manifest verifier + body + wheel groups + UV0 + materials + model parts"

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"passed": result["passed"], "failures": failures,
                      "manifestSha256": result["manifest"]["sha256"]}, indent=1))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
