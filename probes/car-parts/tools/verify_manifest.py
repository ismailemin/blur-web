"""Verify the car-part manifest and the browser evidence.

Checks performed:
  * two independent `build_manifest.py` runs produce byte-identical manifests,
    meshes and scene reports;
  * the manifest schema and the 80-draw accounting are internally consistent;
  * the four wheel groups use the original MdlDat names and translations;
  * tyre tread+sidewall AABB unions equal the MdlDat tyre element bounds;
  * the proven/unclassified split is exactly 76/4 draws;
  * headless Edge evidence has five captures, two geometry uploads, a clean
    console and `drawsIssued == frame * 80`;
  * the fixed-angle screenshots are non-blank and the wheel angle actually
    changes pixels (Pillow, no image is committed).

Usage:
  python probes/car-parts/tools/verify_manifest.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[3]
WORK = ROOT / "_work/car-parts"
PYTHON = sys.executable


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_build(out_dir: Path) -> dict:
    command = [PYTHON, str(ROOT / "probes/car-parts/tools/build_manifest.py"),
               "--out-dir", str(out_dir)]
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    if completed.returncode != 0:
        raise SystemExit(f"build failed ({completed.returncode}):\n{completed.stderr}")
    return json.loads(completed.stdout)


def check(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true",
                        help="verify the existing _work/car-parts outputs only")
    args = parser.parse_args()
    failures: list[str] = []

    if not args.skip_build:
        a = WORK / "verify-a"
        b = WORK / "verify-b"
        for directory in (a, b):
            if directory.exists():
                shutil.rmtree(directory)
        summary_a = run_build(a)
        summary_b = run_build(b)
        for name in ("manifest.json", "mesh.json", "scene-report.json"):
            check(sha256(a / name) == sha256(b / name),
                  f"determinism: {name} differs between two builds", failures)
        check(summary_a["manifestSha256"] == summary_b["manifestSha256"],
              "determinism: reported manifest hash differs", failures)
        for name in ("manifest.json", "mesh.json", "scene-report.json"):
            shutil.copyfile(WORK / name, a / (name + ".main"))
            check(sha256(WORK / name) == sha256(a / name),
                  f"the main output {name} differs from a fresh build", failures)

    manifest = json.loads((WORK / "manifest.json").read_text(encoding="utf-8"))
    mesh = json.loads((WORK / "mesh.json").read_text(encoding="utf-8"))
    evidence = json.loads((WORK / "browser-evidence.json").read_text(encoding="utf-8"))

    check(manifest["kind"] == "blur.car-part-manifest" and manifest["version"] == 1,
          "manifest kind/version is wrong", failures)
    check(manifest["source"]["modelSha256"] ==
          "77840511e5ca416ff9e7cbdc9ee9fc960fce0205f83c9be77e0803607c32cb9d",
          "source model SHA-256 differs from the recorded Corvette fixture", failures)
    check(manifest["mdlDat"]["modelCount"] == 18 and manifest["mdlDat"]["elementCount"] == 71,
          "MdlDat model/element counts differ", failures)

    draws = manifest["draws"]
    check(len(draws) == 80, f"expected 80 draws, got {len(draws)}", failures)
    parts = manifest["parts"]
    check(len(parts) == 29, f"expected 29 parts, got {len(parts)}", failures)
    check(len({part["id"] for part in parts}) == len(parts), "part ids are not unique", failures)

    ownership: dict[int, str] = {}
    for part in parts:
        check(bool(part["draws"]), f"part {part['id']} has no draws", failures)
        for index in part["draws"]:
            check(0 <= index < 80, f"part {part['id']} has draw {index} out of range", failures)
            check(index not in ownership,
                  f"draw {index} is owned by both {ownership.get(index)} and {part['id']}", failures)
            ownership[index] = part["id"]
    check(sorted(ownership) == list(range(80)),
          "parts do not cover every draw exactly once", failures)

    diagnostics = manifest["diagnostics"]
    check(diagnostics["drawCount"] == 80, "diagnostics drawCount is not 80", failures)
    check(diagnostics["provenDrawCount"] == 76, "diagnostics provenDrawCount is not 76", failures)
    check(diagnostics["unclassifiedDrawCount"] == 4,
          "diagnostics unclassifiedDrawCount is not 4", failures)
    check(diagnostics["wheelDrawCount"] == 20, "diagnostics wheelDrawCount is not 20", failures)
    check(diagnostics["provenWheelDrawCount"] == 16,
          "diagnostics provenWheelDrawCount is not 16", failures)
    check(diagnostics["ambiguousWheelDrawCount"] == 4,
          "diagnostics ambiguousWheelDrawCount is not 4", failures)

    unclassified = [draw for draw in draws if draw["partKind"] == "unclassified"]
    check(len(unclassified) == 4, "draw records do not mark exactly four unclassified draws", failures)
    for draw in unclassified:
        check(draw["partId"] is None and draw["previewPartId"] in
              {"wheel.frontleft", "wheel.frontright"}, f"draw {draw['index']} has a bad preview id", failures)
        check("not provable" in draw.get("unclassifiedReason", ""),
              f"draw {draw['index']} is missing an ambiguity reason", failures)

    wheel_groups = {group["name"]: group for group in manifest["wheelGroups"]}
    check(set(wheel_groups) == {"e_wheel_frontleft", "e_wheel_frontright",
                               "e_wheel_backleft", "e_wheel_backright"},
          "wheel group names differ from the four MdlDat names", failures)
    expected_translation = {
        "e_wheel_frontleft": [-0.7742999792098999, 1.1691604839825231e-07, 1.2391999959945679],
        "e_wheel_frontright": [0.7742999792098999, -1.1691604839825231e-07, 1.2391999959945679],
        "e_wheel_backleft": [-0.7743351459503174, 1.1692135615248844e-07, -1.2392492294311523],
        "e_wheel_backright": [0.7742999792098999, -1.1691604839825231e-07, -1.2392492294311523],
    }
    for name, group in wheel_groups.items():
        for axis in range(3):
            check(abs(group["worldTransform"]["translation"][axis] - expected_translation[name][axis]) < 1e-6,
                  f"{name} translation axis {axis} differs", failures)
        check(group["spin"]["axis"] == [1.0, 0.0, 0.0], f"{name} spin axis is not +X", failures)
        check(group["spin"]["staticMembers"] == ["brakeCaliper"],
              f"{name} does not mark the caliper static", failures)
        expected_proven = 3 if "front" in name else 5
        check(len(group["provenDraws"]) == expected_proven,
              f"{name} has {len(group['provenDraws'])} proven draws, expected {expected_proven}", failures)
        check(len(group["previewDraws"]) == 5,
              f"{name} preview draw count is not 5", failures)

    # Tyre tread + sidewall union must equal the MdlDat tyre element bounds.
    elements = {element["name"]: element for element in manifest["mdlDat"]["elements"]
                if element["modelIndex"] == 0}
    tyre_pairs = {
        "E_Tyre_FrontLeft": (40, 41),
        "E_Tyre_FrontRight": (39, 38),
        "E_Tyre_BackLeft": (36, 37),
        "E_Tyre_BackRight": (43, 42),
    }
    for name, (tread, wall) in tyre_pairs.items():
        element = elements[name]
        lo = [min(draws[tread]["bounds"]["min"][i], draws[wall]["bounds"]["min"][i]) for i in range(3)]
        hi = [max(draws[tread]["bounds"]["max"][i], draws[wall]["bounds"]["max"][i]) for i in range(3)]
        difference = sum(abs(lo[i] - element["localBounds"]["min"][i]) +
                         abs(hi[i] - element["localBounds"]["max"][i]) for i in range(3))
        check(difference < 0.01, f"tyre pair {name} union differs by {difference}", failures)
    return finish(failures, manifest, mesh, evidence)


def finish(failures: list[str], manifest: dict, mesh: dict, evidence: dict) -> int:
    images = {}
    for label in ("parts-angle090", "parts-angle000", "parts-side", "parts-rear",
                  "parts-angle090-repeat"):
        path = WORK / f"browser-{label}.png"
        if not path.is_file():
            failures.append(f"missing screenshot {path.name}")
            continue
        images[label] = Image.open(path).convert("RGB")
        if images[label].size != (1600, 900):
            failures.append(f"{path.name} is {images[label].size}, expected 1600x900")

    if "parts-angle000" in images and "parts-angle090" in images:
        before = images["parts-angle000"]
        after = images["parts-angle090"]
        difference = ImageChops.difference(before, after)
        red, green, blue = difference.split()
        mask = ImageChops.lighter(ImageChops.lighter(red, green), blue)
        changed = sum(mask.histogram()[9:])
        if changed < 500:
            failures.append(f"only {changed} pixels change between wheel angles 0 and 0.9 rad")
        evidence["pixelDifferenceAngle0To090"] = changed

    if "parts-angle090" in images and "parts-angle090-repeat" in images:
        if ImageChops.difference(images["parts-angle090"], images["parts-angle090-repeat"]).getbbox() is not None:
            failures.append("the repeated angle-0.9 screenshot is not pixel-identical")

    if "parts-side" in images:
        # A non-blank frame: the body/wheels cover a meaningful part of the canvas.
        background = (14, 17, 20)
        side = images["parts-side"]
        difference = ImageChops.difference(side, Image.new("RGB", side.size, background))
        red, green, blue = difference.split()
        mask = ImageChops.lighter(ImageChops.lighter(red, green), blue)
        non_background = sum(mask.histogram()[31:])
        evidence["sideNonBackgroundPixels"] = non_background
        if non_background < 20000:
            failures.append(f"side screenshot has only {non_background} non-background pixels")

    check(evidence.get("consoleClean") is True, "browser evidence reports a dirty console", failures)
    check(len(evidence.get("captures", [])) == 5, "browser evidence does not have five captures", failures)
    for capture in evidence.get("captures", []):
        check(capture["console"] == [], f"{capture['label']} has console messages", failures)
        check(capture["probe"]["geometryUploads"] == 2,
              f"{capture['label']} uploaded geometry more than once", failures)
        check(capture["probe"]["drawsIssued"] == capture["probe"]["frame"] * 80,
              f"{capture['label']} draw count is not frame*80", failures)
    check(evidence["determinism"]["screenshotBytesEqual"] is True,
          "repeated fixed-angle screenshot bytes differ", failures)
    check(evidence["determinism"]["probeEqual"] is True,
          "repeated fixed-angle probe differs", failures)
    check(mesh["vertexCount"] == 30591 and mesh["indexCount"] == 108579,
          "mesh counts differ from the documented Corvette result", failures)

    evidence["verification"] = {
        "draws": len(manifest["draws"]),
        "parts": len(manifest["parts"]),
        "wheelGroups": len(manifest["wheelGroups"]),
        "provenDraws": manifest["diagnostics"]["provenDrawCount"],
        "unclassifiedDraws": manifest["diagnostics"]["unclassifiedDrawCount"],
        "checks": "car-part manifest accounting, wheel names/transforms, tyre bounds, browser console and screenshots",
        "failures": failures,
        "passed": not failures,
    }
    (WORK / "verify.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    if failures:
        print("FAIL")
        for failure in failures:
            print(" -", failure)
        return 1
    print("PASS")
    print(json.dumps({
        "draws": len(manifest["draws"]),
        "parts": len(manifest["parts"]),
        "wheelGroups": len(manifest["wheelGroups"]),
        "provenDraws": manifest["diagnostics"]["provenDrawCount"],
        "unclassifiedDraws": manifest["diagnostics"]["unclassifiedDrawCount"],
        "pixelDifferenceAngle0To090": evidence.get("pixelDifferenceAngle0To090"),
        "sideNonBackgroundPixels": evidence.get("sideNonBackgroundPixels"),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
