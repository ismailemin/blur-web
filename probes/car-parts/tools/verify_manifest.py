"""Verify the car-part manifests (Corvette C3 + every roster car) and the browser evidence.

Checks performed:
  * two independent `build_manifest.py` runs produce byte-identical manifests,
    meshes and scene reports, for the Corvette C3 and for one roster car;
  * each manifest's schema, draw accounting, wheel groups, tyre and spin
    evidence are internally consistent and every draw is owned exactly once;
  * the roster mapping is unambiguous: five cars, five distinct model SHA-256,
    five distinct body mesh hashes, exact pak paths and recorded variant
    candidates;
  * the proven/unclassified split of the Corvette C3 is exactly 76/4 draws
    (regression anchor);
  * headless Edge evidence has five captures, two geometry uploads, a clean
    console and `drawsIssued == frame * 80`;
  * the fixed-angle screenshots are non-blank and the wheel angle actually
    changes pixels (Pillow, no image is committed).

Usage:
  python probes/car-parts/tools/verify_manifest.py [--skip-build]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[3]
WORK = ROOT / "_work/car-parts"
CARS = WORK / "cars"
PYTHON = sys.executable
C3_MODEL_SHA = "77840511e5ca416ff9e7cbdc9ee9fc960fce0205f83c9be77e0803607c32cb9d"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def strip(value: str | None) -> str:
    return str(value or "").replace("sha256:", "")


def run_build(out_dir: Path, extra: list[str] | None = None) -> dict:
    command = [PYTHON, str(ROOT / "probes/car-parts/tools/build_manifest.py"),
               "--out-dir", str(out_dir)] + list(extra or [])
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    if completed.returncode != 0:
        raise SystemExit(f"build failed ({completed.returncode}):\n{completed.stderr}")
    return json.loads(completed.stdout)


def check(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def verify_manifest(manifest: dict, expected: dict, failures: list[str], label: str,
                    manifest_dir: Path) -> None:
    """Schema, accounting and wheel/tyre evidence checks that hold for any car."""
    check(manifest.get("kind") == "blur.car-part-manifest" and manifest.get("version") == 1,
          f"{label}: manifest kind/version is wrong", failures)
    draws = manifest["draws"]
    parts = manifest["parts"]
    diagnostics = manifest["diagnostics"]

    check(len({part["id"] for part in parts}) == len(parts), f"{label}: part ids are not unique", failures)
    ownership: dict[int, str] = {}
    for part in parts:
        check(bool(part["draws"]), f"{label}: part {part['id']} has no draws", failures)
        for index in part["draws"]:
            check(0 <= index < len(draws), f"{label}: part {part['id']} has draw {index} out of range", failures)
            check(index not in ownership,
                  f"{label}: draw {index} is owned by both {ownership.get(index)} and {part['id']}", failures)
            ownership[index] = part["id"]
    check(sorted(ownership) == list(range(len(draws))),
          f"{label}: parts do not cover every draw exactly once", failures)

    check(diagnostics["drawCount"] == len(draws), f"{label}: diagnostics drawCount differs", failures)
    check(diagnostics["partCount"] == len(parts), f"{label}: diagnostics partCount differs", failures)
    check(diagnostics["provenDrawCount"] + diagnostics["unclassifiedDrawCount"] == len(draws),
          f"{label}: proven + unclassified does not equal the draw count", failures)
    check(diagnostics["wheelDrawCount"] == sum(
        diagnostics[key] for key in ("tyreDrawCount", "rimDrawCount",
                                     "brakeDiscDrawCount", "brakeCaliperDrawCount")),
        f"{label}: wheel kind draw counts do not add up", failures)
    check(diagnostics["wheelDrawCount"] == sum(len(group["previewDraws"])
                                               for group in manifest["wheelGroups"]),
          f"{label}: wheel group draws do not add up", failures)
    for kind in ("tyre", "rim", "brakeDisc", "brakeCaliper"):
        check(diagnostics[{"tyre": "tyreDrawCount", "rim": "rimDrawCount",
                           "brakeDisc": "brakeDiscDrawCount",
                           "brakeCaliper": "brakeCaliperDrawCount"}[kind]] % 4 == 0,
              f"{label}: {kind} draws do not divide across four corners", failures)

    unclassified = [draw for draw in draws if draw["partKind"] == "unclassified"]
    check(len(unclassified) == diagnostics["unclassifiedDrawCount"],
          f"{label}: unclassified draw records differ from diagnostics", failures)
    for draw in unclassified:
        check(draw["partId"] is None, f"{label}: unclassified draw {draw['index']} has a partId", failures)
        check(bool(draw.get("unclassifiedReason")), f"{label}: draw {draw['index']} has no ambiguity reason",
              failures)

    groups = manifest["wheelGroups"]
    check(len(groups) == 4, f"{label}: expected four wheel groups, got {len(groups)}", failures)
    check(sorted(group["corner"] for group in groups) ==
          ["backleft", "backright", "frontleft", "frontright"],
          f"{label}: wheel corners are not the four documented names", failures)
    for group in groups:
        check(group["name"].lower() == "e_wheel_" + group["corner"],
              f"{label}: {group['id']} does not use its e_wheel_* name", failures)
        check(group["spin"]["axis"] == [1.0, 0.0, 0.0],
              f"{label}: {group['id']} spin axis is not +X", failures)
        check(group["spin"]["staticMembers"] == ["brakeCaliper"],
              f"{label}: {group['id']} does not mark the caliper static", failures)
        check(group["spin"]["axisEvidence"]["thinAxis"] == "x" and
              group["spin"]["axisEvidence"]["roundAxes"] == "y/z",
              f"{label}: {group['id']} axis evidence is not measured as thin-X/round-YZ", failures)
        members = sorted(member["wheelPart"] for member in group["memberParts"])
        check(members == ["brakeCaliper", "brakeDisc", "rim", "tyre"],
              f"{label}: {group['id']} members are {members}", failures)
        check(len(group["previewDraws"]) == len(group["provenDraws"]) + len(group["ambiguousDraws"]),
              f"{label}: {group['id']} preview draws do not split into proven+ambiguous", failures)
        for member in group["memberParts"]:
            check(member["spins"] == (member["wheelPart"] != "brakeCaliper"),
                  f"{label}: {group['id']} {member['name']} spin flag is wrong", failures)

    elements = {element["name"]: element for element in manifest["mdlDat"]["elements"]
                if element["modelIndex"] == 0}
    for row in manifest["tyres"]:
        element = elements[row["element"]]
        draws_in_row = row["draws"]
        check(bool(draws_in_row), f"{label}: tyre {row['element']} has no draws", failures)
        if row["unionDraws"]:
            lo = [min(draws[index]["bounds"]["min"][i] for index in row["unionDraws"]) for i in range(3)]
            hi = [max(draws[index]["bounds"]["max"][i] for index in row["unionDraws"]) for i in range(3)]
            difference = sum(abs(lo[i] - element["localBounds"]["min"][i]) +
                             abs(hi[i] - element["localBounds"]["max"][i]) for i in range(3))
            check(abs(difference - row["difference"]) < 1e-6,
                  f"{label}: tyre {row['element']} union difference is not reproducible", failures)
    check(manifest["tyreProofTier"] in ("union", "containment"),
          f"{label}: tyre proof tier is not labelled", failures)

    mesh = json.loads((manifest_dir / manifest["mesh"]["path"]).read_text(encoding="utf-8"))
    check(mesh["vertexCount"] == manifest["mesh"]["vertexCount"] and
          mesh["indexCount"] == manifest["mesh"]["indexCount"],
          f"{label}: mesh.json counts differ from the manifest", failures)
    check(mesh["positionsFloat32LESha256"] == manifest["mesh"]["positionsFloat32LESha256"] and
          mesh["indicesUint32LESha256"] == manifest["mesh"]["indicesUint32LESha256"],
          f"{label}: mesh.json value hashes differ from the manifest", failures)
    if expected:
        check(strip(manifest["source"]["modelSha256"]) == strip(expected.get("modelSha256")),
              f"{label}: model SHA-256 differs from the mapping index", failures)
        check(manifest["source"]["modelPakPath"] == expected.get("pakPath"),
              f"{label}: model pak path differs from the mapping index", failures)
        check(manifest["source"]["car"]["slug"] == expected.get("slug"),
              f"{label}: manifest does not name its car slug", failures)
        check(expected.get("pakPath") in expected.get("prefixCandidates", []),
              f"{label}: mapping index does not list its own pak path as a candidate", failures)


def verify_roster(failures: list[str]) -> dict:
    index_path = CARS / "index.json"
    if not index_path.is_file():
        failures.append("missing _work/car-parts/cars/index.json (run build_all_manifests.py)")
        return {}
    index = json.loads(index_path.read_text(encoding="utf-8"))
    check(index["kind"] == "car-parts.car-model-index" and index["version"] == 1,
          "car model index kind/version is wrong", failures)
    check(index["roster"]["path"].endswith("cars/roster.json"),
          "car model index does not reference the e1-drive roster", failures)
    check(len(index["cars"]) == 5, "car model index does not cover five cars", failures)
    check(index["allMapped"] is True and not index["unmapped"],
          "not every roster car is mapped: " + json.dumps(index.get("unmapped")), failures)

    models = set()
    meshes = set()
    for car in index["cars"]:
        label = "car " + car["slug"]
        check(car["mapped"] is True, f"{label}: not mapped ({car.get('reason')})", failures)
        if not car["mapped"]:
            continue
        manifest = json.loads((ROOT / car["manifest"]).read_text(encoding="utf-8"))
        verify_manifest(manifest, car, failures, label, (ROOT / car["manifest"]).parent)
        check(strip(car["manifestSha256"]) == sha256(ROOT / car["manifest"]),
              f"{label}: recorded manifest hash does not match the file", failures)
        check(strip(car["meshSha256"]) == sha256(ROOT / car["mesh"]),
              f"{label}: recorded mesh hash does not match the file", failures)
        check(manifest["source"]["car"]["mapping"] and
              car["pakPath"] in manifest["source"]["car"]["mapping"],
              f"{label}: manifest mapping text does not name its pak path", failures)
        check(manifest["source"]["modelSha256"] == strip(car["modelSha256"]),
              f"{label}: model hash differs between manifest and index", failures)
        models.add(strip(car["modelSha256"]))
        meshes.add(strip(car["meshPositionsSha256"]))
    check(len(models) == len(index["cars"]), "roster cars do not have five distinct source models", failures)
    check(len(meshes) == len(index["cars"]), "roster cars do not have five distinct body mesh hashes", failures)
    return index


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
                  f"determinism: C3 {name} differs between two builds", failures)
        check(summary_a["manifestSha256"] == summary_b["manifestSha256"],
              "determinism: C3 reported manifest hash differs", failures)
        for name in ("manifest.json", "mesh.json", "scene-report.json"):
            shutil.copyfile(WORK / name, a / (name + ".main"))
            check(sha256(WORK / name) == sha256(a / name),
                  f"the main C3 output {name} differs from a fresh build", failures)

        # A non-C3 car proves the builder is not Corvette-shaped: rebuild the first
        # mapped roster car with the same car arguments and compare the hash.
        index = verify_roster([])
        if index.get("cars"):
            car = next((entry for entry in index["cars"] if entry.get("mapped")), None)
            if car:
                manifest = json.loads((ROOT / car["manifest"]).read_text(encoding="utf-8"))
                extra = [
                    "--model", str(ROOT / manifest["source"]["model"]),
                    "--car-slug", car["slug"],
                    "--car-name", car["name"],
                    "--car-mapping", manifest["source"]["car"]["mapping"],
                    "--model-pak-path", car["pakPath"],
                ]
                c = WORK / "verify-car-a"
                d = WORK / "verify-car-b"
                for directory in (c, d):
                    if directory.exists():
                        shutil.rmtree(directory)
                summary_c = run_build(c, extra)
                summary_d = run_build(d, extra)
                for name in ("manifest.json", "mesh.json", "scene-report.json"):
                    check(sha256(c / name) == sha256(d / name),
                          f"determinism: {car['slug']} {name} differs between two builds", failures)
                check(summary_c["manifestSha256"] == summary_d["manifestSha256"],
                      f"determinism: {car['slug']} reported manifest hash differs", failures)
                check("sha256:" + summary_c["manifestSha256"] == car["manifestSha256"],
                      f"{car['slug']} manifest does not reproduce from the builder", failures)

    manifest = json.loads((WORK / "manifest.json").read_text(encoding="utf-8"))
    mesh = json.loads((WORK / "mesh.json").read_text(encoding="utf-8"))
    evidence = json.loads((WORK / "browser-evidence.json").read_text(encoding="utf-8"))

    verify_manifest(manifest, None, failures, "C3", WORK)
    check(strip(manifest["source"]["modelSha256"]) == C3_MODEL_SHA,
          "C3 source model SHA-256 differs from the recorded fixture", failures)
    check(manifest["mdlDat"]["modelCount"] == 18 and manifest["mdlDat"]["elementCount"] == 71,
          "C3 MdlDat model/element counts differ", failures)
    check(len(manifest["draws"]) == 80, f"C3 expected 80 draws, got {len(manifest['draws'])}", failures)
    check(len(manifest["parts"]) == 29, f"C3 expected 29 parts, got {len(manifest['parts'])}", failures)
    check(manifest["diagnostics"]["provenDrawCount"] == 76,
          "C3 diagnostics provenDrawCount is not 76", failures)
    check(manifest["diagnostics"]["unclassifiedDrawCount"] == 4,
          "C3 diagnostics unclassifiedDrawCount is not 4", failures)
    check(manifest["diagnostics"]["wheelDrawCount"] == 20, "C3 diagnostics wheelDrawCount is not 20", failures)
    check(manifest["diagnostics"]["provenWheelDrawCount"] == 16,
          "C3 diagnostics provenWheelDrawCount is not 16", failures)
    check(manifest["diagnostics"]["ambiguousWheelDrawCount"] == 4,
          "C3 diagnostics ambiguousWheelDrawCount is not 4", failures)

    wheel_groups = {group["name"]: group for group in manifest["wheelGroups"]}
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
        expected_proven = 3 if "front" in name else 5
        check(len(group["provenDraws"]) == expected_proven,
              f"{name} has {len(group['provenDraws'])} proven draws, expected {expected_proven}", failures)
        check(len(group["previewDraws"]) == 5, f"{name} preview draw count is not 5", failures)

    draws = manifest["draws"]
    tyre_pairs = {
        "E_Tyre_FrontLeft": (40, 41),
        "E_Tyre_FrontRight": (39, 38),
        "E_Tyre_BackLeft": (36, 37),
        "E_Tyre_BackRight": (43, 42),
    }
    elements = {element["name"]: element for element in manifest["mdlDat"]["elements"]
                if element["modelIndex"] == 0}
    for name, (tread, wall) in tyre_pairs.items():
        element = elements[name]
        lo = [min(draws[tread]["bounds"]["min"][i], draws[wall]["bounds"]["min"][i]) for i in range(3)]
        hi = [max(draws[tread]["bounds"]["max"][i], draws[wall]["bounds"]["max"][i]) for i in range(3)]
        difference = sum(abs(lo[i] - element["localBounds"]["min"][i]) +
                         abs(hi[i] - element["localBounds"]["max"][i]) for i in range(3))
        check(difference < 0.01, f"tyre pair {name} union differs by {difference}", failures)

    index = verify_roster(failures)
    return finish(failures, manifest, mesh, evidence, index)


def finish(failures: list[str], manifest: dict, mesh: dict, evidence: dict, index: dict) -> int:
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
          "C3 mesh counts differ from the documented result", failures)

    evidence["verification"] = {
        "draws": len(manifest["draws"]),
        "parts": len(manifest["parts"]),
        "wheelGroups": len(manifest["wheelGroups"]),
        "provenDraws": manifest["diagnostics"]["provenDrawCount"],
        "unclassifiedDraws": manifest["diagnostics"]["unclassifiedDrawCount"],
        "rosterCars": [{
            "slug": car["slug"],
            "pakPath": car["pakPath"],
            "modelSha256": car["modelSha256"],
            "meshPositionsSha256": car["meshPositionsSha256"],
            "draws": car.get("draws"),
            "parts": car.get("parts"),
            "wheelDraws": car.get("wheelDraws"),
            "tyreProofTier": car.get("diagnostics", {}).get("tyreProofTier"),
        } for car in index.get("cars", [])],
        "checks": "manifest accounting, wheel names/transforms, tyre bounds, roster mapping, "
                  "five distinct body meshes, browser console and screenshots",
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
        "rosterCars": len(index.get("cars", [])),
        "pixelDifferenceAngle0To090": evidence.get("pixelDifferenceAngle0To090"),
        "sideNonBackgroundPixels": evidence.get("sideNonBackgroundPixels"),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
