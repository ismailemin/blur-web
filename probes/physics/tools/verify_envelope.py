"""Verify the per-car physics envelope manifest (PHYS1).

The gate is deliberately independent of the builder's in-memory objects:

* two fresh builder processes (different ``PYTHONHASHSEED``) must produce
  byte-identical manifests;
* the XT record is re-decoded and every extracted value compared;
* every value is compared with the committed ``.fields`` consumer input (25
  roster cars) and with the V1 audit ``_work/vehicle-pipeline/cars.json`` (62);
* self-consistency ranges and envelope relations are checked per car;
* body bounds are cross-checked between the car-part manifest and the Scene
  report wherever both exist.

Usage: ``python probes/physics/tools/verify_envelope.py``
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE.parents[1] / "lib"))

from envelope import (  # noqa: E402
    EXTRACT_SET,
    FIXED_ENVELOPE,
    ROOT as LIB_ROOT,
    build_manifest,
    canonical,
    load_json,
    rel,
    sha256_bytes,
)

BUILD = HERE.parent / "build_envelope.py"
OUT = ROOT / "_work/physics"
REPORT = OUT / "verify.json"
LOG = ROOT / "_work/logs/physics/verify.log"

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append({"name": name, "ok": bool(ok), "detail": str(detail)})


def finite(value):
    return isinstance(value, (int, float)) and value == value and abs(value) != float("inf")


def within(value, low, high):
    return finite(value) and low <= value <= high


def parse_fields(path: Path):
    scalars = {}
    arrays = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        name, _, value = line.partition("\t")
        if name.endswith("]"):
            base, index = name[:-1].split("[")
            arrays.setdefault(base, {})[int(index)] = value
        elif "]" in name and name.rsplit(".", 1)[-1] in ("x", "y"):
            base, rest = name.split("[")
            index, component = rest.split("].")
            arrays.setdefault(base, {}).setdefault(int(index), {})[component] = value
        else:
            scalars[name] = value
    return scalars, arrays


def f32(hex_bits: str) -> float:
    return struct.unpack("<f", struct.pack("<I", int(hex_bits, 16)))[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default=str(OUT / "envelope.json"))
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    cars = manifest["cars"]
    by_name = {c["name"]: c for c in cars}
    scope = manifest["scope"]
    schema = manifest["schema"]
    catalog = {leaf["path"]: leaf for leaf in schema["leaves"]}

    # ---- 1. determinism: two fresh processes, different hash seeds --------
    dirs = [OUT / "verify-a", OUT / "verify-b"]
    for directory in dirs:
        if directory.exists():
            shutil.rmtree(directory)
    for index, directory in enumerate(dirs):
        env = dict(os.environ)
        env["PYTHONHASHSEED"] = str(index)
        result = subprocess.run(
            [sys.executable, str(BUILD), "--out", str(directory),
             "--log", str(directory / "build.log")],
            cwd=str(ROOT), env=env, capture_output=True, text=True)
        check(f"build {directory.name} exits 0", result.returncode == 0,
              result.stderr.strip()[-300:])
    blobs = [(d / "envelope.json").read_bytes() for d in dirs]
    check("two fresh builds are byte-identical", blobs[0] == blobs[1],
          sha256_bytes(blobs[0]) if blobs[0] == blobs[1] else "differ")
    check("final manifest equals both fresh builds",
          manifest_bytes == blobs[0] == blobs[1],
          sha256_bytes(manifest_bytes))
    check("in-process rebuild is byte-identical",
          json.dumps(build_manifest(), indent=2, sort_keys=True,
                     ensure_ascii=True, allow_nan=False).encode("utf-8") + b"\n"
          == manifest_bytes)

    # ---- 2. schema census ------------------------------------------------
    check("62 RP_CarDynamics records", len(cars) == 62, len(cars))
    check("15 integrated cars", scope["integratedCars"] == 15, scope["integratedCars"])
    check("10 staged batch-2 cars", scope["stagedBatch2Cars"] == 10,
          scope["stagedBatch2Cars"])
    check("61 cars carry a body AABB", scope["carsWithBodyAabb"] == 61,
          scope["carsWithBodyAabb"])
    check("one body AABB explicitly absent", scope["carsWithoutBodyAabb"] == 1,
          [c["name"] for c in cars if "length" not in c["bodyEnvelope"]])
    offsets = [leaf["imageOffset"] for leaf in schema["leaves"]]
    check("every schema leaf has a unique image offset", len(offsets) == len(set(offsets)),
          f"{len(offsets)} leaves")
    field_ids = [leaf["fieldIndex"] for leaf in schema["leaves"]]
    check("every field id is inside the schema field table",
          field_ids and min(field_ids) >= 0
          and max(field_ids) < manifest["inputs"]["fieldTableCount"],
          f"{min(field_ids)}..{max(field_ids)} of {manifest['inputs']['fieldTableCount']}")
    check("field-id reuse is only struct reuse (152 leaves, fewer ids)",
          len(set(field_ids)) < len(field_ids),
          f"{len(set(field_ids))} unique ids for {len(field_ids)} leaves")
    check("every leaf carries a unit label",
          all(leaf["unit"] and leaf["unitEvidence"] for leaf in schema["leaves"]),
          f"{len(schema['leaves'])} leaves")
    check("9 typed missing/additional fields are recorded",
          len(schema["missingFields"]) == 9, len(schema["missingFields"]))
    for missing in schema["missingFields"]:
        check(f"missing field {missing['path']} has a status and reason",
              missing["status"] in ("absent", "derived", "unresolved-handle")
              and len(missing["reason"]) > 20,
              missing["status"])
    check("extracted field count matches the census",
          schema["counts"]["extracted"] == len(EXTRACT_SET),
          f"{schema['counts']['extracted']} vs {len(EXTRACT_SET)}")
    check("geometry-relevant fields >= 30", schema["counts"]["geometryRelevant"] >= 30,
          schema["counts"]["geometryRelevant"])
    check("coverage table covers every leaf",
          set(manifest["coverage"]) == {leaf["path"] for leaf in schema["leaves"]},
          len(manifest["coverage"]))
    check("every schema leaf is present in all 62 records",
          all(entry["present"] == 62 for entry in manifest["coverage"].values()),
          sum(1 for entry in manifest["coverage"].values() if entry["present"] != 62))
    check("integration contract lists nine consumers",
          len(manifest["integration"]["consumers"]) == 9,
          len(manifest["integration"]["consumers"]))
    check("integration contract names the per-car value sources",
          len(manifest["integration"]["perCarValues"]) == 4)

    # ---- 3. fixed-envelope derivation -----------------------------------
    fixed = manifest["fixedEnvelope"]
    five = fixed["recomputedFromFiveCarRoster"]
    all62 = fixed["recomputedFromAll62"]
    check("fixed box is 2.98 x 1.68 x 1.35",
          fixed["length"] == 2.98 and fixed["width"] == 1.68 and fixed["height"] == 1.35)
    check("five-car roster reproduces 2.981 m wheelbase",
          abs(five["maxWheelbase"] - 2.981) < 0.005, five["maxWheelbase"])
    check("five-car roster reproduces 1.676 m track",
          abs(five["maxTrack"] - 1.676) < 0.005, five["maxTrack"])
    check("five-car derivation matches the documented envelope",
          five["matches"] is True)
    check("all-62 max wheelbase exceeds the fixed length",
          all62["maxWheelbase"] > fixed["length"] + 0.5, all62["maxWheelbase"])
    check("all-62 max track exceeds the fixed width",
          all62["maxTrack"] > fixed["width"] + 0.3, all62["maxTrack"])
    check("all-62 axle-box overflow matches the per-car flags",
          all62["carsWithAxleBoxOutsideFixed"] + all62["carsWithAxleBoxInsideFixed"] == 62,
          all62["carsWithAxleBoxOutsideFixed"])

    # ---- 4. independent value sources -----------------------------------
    v1 = load_json(ROOT / "_work/vehicle-pipeline/cars.json")
    v1_by_name = {r["name"]: r for r in v1["records"]}
    pairs = [
        ("mass", "mass.mass"),
        ("wheelBase", "geometry.wheelBase"),
        ("trackWidthFront", "geometry.trackWidthFront"),
        ("trackWidthRear", "geometry.trackWidthRear"),
        ("tyreRadiusFront", "tyres.frontTyres.radius"),
        ("tyreRadiusRear", "tyres.rearTyres.radius"),
        ("limiterRPM", "engine.limiterRPM"),
        ("brakesFront", "brakes.frontBrakeForce"),
        ("brakesRear", "brakes.rearBrakeForce"),
    ]
    for car in cars:
        record = v1_by_name.get(car["name"])
        check(f"{car['name']}: V1 audit record exists", record is not None)
        if not record:
            continue
        bad = []
        for audit_key, path in pairs:
            expected = record["physics"]["values"][audit_key]
            got = car["physics"]["values"][path]["value"]
            if abs(expected - got) > 1e-6:
                bad.append(f"{path}: {got} vs {expected}")
        check(f"{car['name']}: 9 physics values equal the V1 audit", not bad, bad[:3])
        audit_ratios = record["physics"]["values"]["gearRatios"]
        own_ratios = [v["value"] for v in car["physics"]["arrays"]["gears.gearRatios"]["values"]]
        check(f"{car['name']}: gear stack equals the V1 audit",
              len(audit_ratios) == len(own_ratios)
              and all(abs(a - b) <= 1e-6 for a, b in zip(audit_ratios, own_ratios)),
              f"{len(own_ratios)} gears")
        audit_curve = record["physics"]["values"]["torqueCurve"]
        own_curve = [v["value"] for v in car["physics"]["arrays"]["engine.engineTorque_Rpm.dataPoints"]["values"]]
        check(f"{car['name']}: torque curve equals the V1 audit",
              len(audit_curve) == len(own_curve)
              and all(abs(a - b) <= 1e-6 for a, b in zip(audit_curve, own_curve)),
              f"{len(own_curve)} points")

    # committed .fields consumer input for the drive roster
    roster = load_json(ROOT / "_work/e1-drive/cars.json")["roster"]["cars"]
    roster_by_name = {c["name"]: c for c in roster}
    for car in cars:
        if car["name"] not in roster_by_name:
            continue
        entry = roster_by_name[car["name"]]
        path = ROOT / entry["fields"]["path"]
        check(f"{car['name']}: committed .fields exists", path.exists(), rel(path))
        if not path.exists():
            continue
        scalars, arrays = parse_fields(path)
        bad = []
        for field, item in car["physics"]["values"].items():
            if field not in scalars:
                bad.append(f"{field}: absent from .fields")
                continue
            kind = catalog[field]["kind"]
            if kind == "f32":
                expected = f32(scalars[field])
            elif kind in ("i32", "bool"):
                expected = int(scalars[field])
            else:
                bad.append(f"{field}: unsupported kind {kind}")
                continue
            if abs(expected - item["value"]) > 1e-9:
                bad.append(f"{field}: {item['value']} vs {expected}")
        check(f"{car['name']}: every extracted scalar equals the committed .fields",
              not bad, bad[:3])
        bad = []
        for field, item in car["physics"]["arrays"].items():
            if item["count"] == 0:
                if scalars.get(field) != "0":
                    bad.append(f"{field}: empty array descriptor not '0' in .fields")
                continue
            if field not in arrays:
                bad.append(f"{field}: absent from .fields")
                continue
            values = arrays[field]
            if len(values) != item["count"]:
                bad.append(f"{field}: count {len(values)} vs {item['count']}")
                continue
            for index in range(item["count"]):
                own = item["values"][index]
                if "value" in own:
                    expected = f32(values[index])
                    if abs(expected - own["value"]) > 1e-9:
                        bad.append(f"{field}[{index}]: {own['value']} vs {expected}")
                else:
                    expected_x = f32(values[index]["x"])
                    expected_y = f32(values[index]["y"])
                    if abs(expected_x - own["x"]) > 1e-9 or abs(expected_y - own["y"]) > 1e-9:
                        bad.append(f"{field}[{index}]: graph point differs")
        check(f"{car['name']}: every extracted array equals the committed .fields",
              not bad, bad[:3])

    # ---- 5. per-car self-consistency ------------------------------------
    for car in cars:
        name = car["name"]
        v = car["physics"]["values"]

        def val(path):
            return v[path]["value"]

        tf = val("geometry.trackWidthFront")
        tr = val("geometry.trackWidthRear")
        wb = val("geometry.wheelBase")
        check(f"{name}: mass in 600-2600 kg", within(val("mass.mass"), 600, 2600), val("mass.mass"))
        check(f"{name}: wheelbase in 1.9-3.7 m", within(val("geometry.wheelBase"), 1.9, 3.7),
              val("geometry.wheelBase"))
        check(f"{name}: front track in 1.15-2.10 m",
              within(val("geometry.trackWidthFront"), 1.15, 2.10),
              val("geometry.trackWidthFront"))
        check(f"{name}: rear track in 1.15-2.10 m",
              within(val("geometry.trackWidthRear"), 1.15, 2.10),
              val("geometry.trackWidthRear"))
        check(f"{name}: front tyre radius in 0.30-0.50 m",
              within(val("tyres.frontTyres.radius"), 0.30, 0.50),
              val("tyres.frontTyres.radius"))
        check(f"{name}: rear tyre radius in 0.30-0.50 m",
              within(val("tyres.rearTyres.radius"), 0.30, 0.50),
              val("tyres.rearTyres.radius"))
        check(f"{name}: front/rear tyre radius within 0.15 m",
              abs(val("tyres.frontTyres.radius") - val("tyres.rearTyres.radius")) <= 0.15,
              abs(val("tyres.frontTyres.radius") - val("tyres.rearTyres.radius")))
        check(f"{name}: wheelbase exceeds the widest track",
              val("geometry.wheelBase") > max(val("geometry.trackWidthFront"),
                                              val("geometry.trackWidthRear")))
        for side in ("front", "rear"):
            for direction in ("movementUp", "movementDown"):
                path = f"suspension.{side}.{direction}"
                check(f"{name}: {path} in 0.02-0.40 m", within(val(path), 0.02, 0.40), val(path))
        check(f"{name}: steerLimit in 0.3-1.6 rad", within(val("steering.steerLimit"), 0.3, 1.6),
              val("steering.steerLimit"))
        check(f"{name}: front brake scalar in 0.5-2.0",
              within(val("brakes.frontBrakeForce"), 0.5, 2.0), val("brakes.frontBrakeForce"))
        check(f"{name}: rear brake scalar in 0.5-2.0",
              within(val("brakes.rearBrakeForce"), 0.5, 2.0), val("brakes.rearBrakeForce"))
        check(f"{name}: downforce scalar in 0.5-2.0", within(val("friction.downforce"), 0.5, 2.0),
              val("friction.downforce"))
        check(f"{name}: final ratio in 1.5-6.0", within(val("gears.finalRatio"), 1.5, 6.0),
              val("gears.finalRatio"))
        ratios = [x["value"] for x in car["physics"]["arrays"]["gears.gearRatios"]["values"]]
        check(f"{name}: every gear ratio is positive",
              len(ratios) >= 6 and all(r > 0 for r in ratios), ratios)
        check(f"{name}: top gear inside the gear stack",
              1 <= val("gears.topGear") <= len(ratios), val("gears.topGear"))
        check(f"{name}: torque curve has 10 points",
              car["physics"]["arrays"]["engine.engineTorque_Rpm.dataPoints"]["count"] == 10)
        check(f"{name}: both grip curves have 3 points",
              car["physics"]["arrays"]["tyres.frontTyres.grip.data"]["count"] == 3
              and car["physics"]["arrays"]["tyres.rearTyres.grip.data"]["count"] == 3)
        wheel = car["derived"]["wheelGeometry"]
        check(f"{name}: ride height exceeds the tyre radius",
              wheel["rideHeightFront"] > wheel["frontRadius"] + 0.01,
              wheel["rideHeightFront"])
        check(f"{name}: ride height below 0.9 m", wheel["rideHeightFront"] < 0.9,
              wheel["rideHeightFront"])
        axle = car["derived"]["axleRectangle"]
        wheel_points = [
            (-wb / 2.0, -tf / 2.0), (-wb / 2.0, tf / 2.0),
            (wb / 2.0, -tr / 2.0), (wb / 2.0, tr / 2.0),
        ]
        inside_axle = all(abs(long) <= axle["length"] / 2.0 + 1e-6
                          and abs(lat) <= axle["width"] / 2.0 + 1e-6
                          for long, lat in wheel_points)
        inside_fixed = all(abs(long) <= FIXED_ENVELOPE["length"] / 2.0 + 1e-6
                           and abs(lat) <= FIXED_ENVELOPE["width"] / 2.0 + 1e-6
                           for long, lat in wheel_points)
        check(f"{name}: four wheel contact points lie inside the axle rectangle",
              inside_axle, wheel_points)
        check(f"{name}: wheel-point containment matches the fixed-box flag",
              inside_fixed == car["derived"]["fixedBoxContainsAxle"],
              f"inside_fixed={inside_fixed}")
        contained = axle["length"] <= FIXED_ENVELOPE["length"] + 1e-9 and \
            axle["width"] <= FIXED_ENVELOPE["width"] + 1e-9
        check(f"{name}: fixed-box containment flag matches the axle dimensions",
              car["derived"]["fixedBoxContainsAxle"] == contained,
              f"{axle['length']} x {axle['width']}")
        check(f"{name}: harness box width equals the front track",
              abs(car["derived"]["harnessBodyBox"]["width"] - tf) < 1e-6,
              car["derived"]["harnessBodyBox"]["width"])
        check(f"{name}: harness box height is the front tyre diameter",
              abs(car["derived"]["harnessBodyBox"]["height"] - 2 * wheel["frontRadius"]) < 1e-6)
        finite_values = all(finite(item["value"]) for item in v.values())
        raw_values = all(len(item["raw"]) == 8 for item in v.values())
        check(f"{name}: all extracted scalars are finite with an 8-hex raw word",
              finite_values and raw_values)
        offsets_match = all(item["imageOffset"] == catalog[path]["imageOffset"]
                            for path, item in v.items())
        check(f"{name}: every extracted offset equals the schema offset", offsets_match)
        check(f"{name}: mass duplicate agrees with the value table",
              car["physics"]["mass"]["value"] == val("mass.mass"))

    # ---- 6. body envelope checks ---------------------------------------
    for car in cars:
        name = car["name"]
        body = car["bodyEnvelope"]
        choices = car["envelopeChoices"]
        check(f"{name}: collision choice is present and typed",
              "collisionUpperBound" in choices and "recommendedCollision" in choices
              and "chassisFootprint" in choices and "engineBodyBox" in choices)
        if "length" not in body:
            check(f"{name}: body AABB is typed absent, not invented",
                  body.get("status") == "absent" and "reason" in body)
            check(f"{name}: absent body does not silently fall back to the fixed box",
                  choices["collisionUpperBound"].get("status") == "absent")
            continue
        check(f"{name}: collisionUpperBound equals the body AABB",
              choices["collisionUpperBound"]["length"] == body["length"]
              and choices["collisionUpperBound"]["width"] == body["width"]
              and choices["collisionUpperBound"]["height"] == body["height"])
        check(f"{name}: chassisFootprint equals the axle rectangle",
              choices["chassisFootprint"]["length"] == car["derived"]["axleRectangle"]["length"]
              and choices["chassisFootprint"]["width"] == car["derived"]["axleRectangle"]["width"])
        v = car["physics"]["values"]
        wb = v["geometry.wheelBase"]["value"]
        tf = v["geometry.trackWidthFront"]["value"]
        tr = v["geometry.trackWidthRear"]["value"]
        radius = v["tyres.frontTyres.radius"]["value"]
        check(f"{name}: body length positive", body["length"] > 1.0, body["length"])
        check(f"{name}: body width positive", body["width"] > 1.0, body["width"])
        check(f"{name}: body height positive", body["height"] > 0.5, body["height"])
        check(f"{name}: body length exceeds the wheelbase",
              body["length"] > wb, f"{body['length']} vs {wb}")
        check(f"{name}: body width exceeds the widest track",
              body["width"] > max(tf, tr), f"{body['width']} vs {max(tf, tr)}")
        check(f"{name}: body height exceeds the tyre diameter",
              body["height"] > 2 * radius, f"{body['height']} vs {2 * radius}")
        check(f"{name}: axis mapping is X=width, Y=up, Z=length",
              body["axisMapping"] == {"x": "width", "y": "height", "z": "length"})
        check(f"{name}: body bounds are finite",
              all(finite(x) for x in body["min"] + body["max"]))
        delta = car["deltaVsFixed"]["bodyVsFixed"]
        check(f"{name}: body length delta recomputes",
              abs(delta["length"] - (body["length"] - FIXED_ENVELOPE["length"])) < 1e-6)
        check(f"{name}: body width delta recomputes",
              abs(delta["width"] - (body["width"] - FIXED_ENVELOPE["width"])) < 1e-6)
        check(f"{name}: body height delta recomputes",
              abs(delta["height"] - (body["height"] - FIXED_ENVELOPE["height"])) < 1e-6)
        if "meshWheelbase" in body:
            check(f"{name}: mesh wheelbase agrees with XT within 0.10 m",
                  abs(body["meshWheelbase"] - wb) <= 0.10,
                  body["meshWheelbase"] - wb)
            check(f"{name}: mesh tyre radius agrees with XT within 0.05 m",
                  abs(body["tyreRadiusDeltaMeshVsXt"]) <= 0.05,
                  body["tyreRadiusDeltaMeshVsXt"])
            check(f"{name}: total overhang recomputes",
                  abs(body["overhangTotal"] - (body["length"] - wb)) < 1e-6,
                  body["overhangTotal"])
            check(f"{name}: four wheel corners carry mesh evidence",
                  all(corner in body["meshWheels"] for corner in
                      ("frontleft", "frontright", "backleft", "backright")))

    # ---- 7. body-source cross-check (manifest vs Scene report) ---------
    scene_agree = 0
    scene_checked = 0
    for car in cars:
        body = car["bodyEnvelope"]
        other = body.get("sceneBoundsCrossCheck")
        if not other or "min" not in body:
            continue
        scene_checked += 1
        ok = all(abs(a - b) < 1e-6 for a, b in zip(body["min"] + body["max"],
                                                   other["min"] + other["max"]))
        scene_agree += 1 if ok else 0
        check(f"{car['name']}: car-part AABB equals the Scene-report AABB", ok,
              f"{body['min']} vs {other['min']}")
    check("Scene cross-check covered the roster cars that have both sources",
          scene_checked >= 15, scene_checked)
    check("every Scene cross-check agreed", scene_agree == scene_checked,
          f"{scene_agree}/{scene_checked}")

    # ---- 8. content hash ------------------------------------------------
    check("contentSha256 matches the canonical car array",
          manifest["contentSha256"] == sha256_bytes(canonical(cars)),
          manifest["contentSha256"])
    check("manifest has no non-finite numbers",
          "NaN" not in manifest_bytes.decode("utf-8")
          and "Infinity" not in manifest_bytes.decode("utf-8"))

    # ---- report ---------------------------------------------------------
    failures = [c for c in CHECKS if not c["ok"]]
    report = {
        "kind": "blur.vehicle-physics-envelope-verify",
        "version": 1,
        "status": "PASS" if not failures else "FAIL",
        "checks": len(CHECKS),
        "passed": len(CHECKS) - len(failures),
        "failed": len(failures),
        "failures": failures,
        "checks": [{"name": item["name"], "ok": item["ok"]} for item in CHECKS],
        "manifest": {
            "path": rel(manifest_path),
            "bytes": len(manifest_bytes),
            "sha256": sha256_bytes(manifest_bytes),
            "contentSha256": manifest["contentSha256"],
        },
        "determinism": {
            "builds": [sha256_bytes(blob) for blob in blobs],
            "byteIdentical": blobs[0] == blobs[1] == manifest_bytes,
        },
        "independentSources": {
            "v1AuditRecords": len(v1_by_name),
            "committedFields": len([c for c in cars if c["name"] in roster_by_name]),
            "sceneCrossChecks": scene_checked,
        },
        "limits": [
            "no retail collision hull is decoded; the body AABB is a visible-mesh "
            "upper bound",
            "no physics step is executed; the values are the serialised XT record",
            "one platform (this installed game-data pak); no native/wasm parity claim",
        ],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(report, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
    (OUT / "verify.json").write_text(text, encoding="utf-8", newline="\n")
    LOG.write_text(text, encoding="utf-8", newline="\n")

    print(f"{report['status']}: {report['passed']}/{report['checks']} checks, "
          f"{report['failed']} failures")
    for failure in failures[:20]:
        print(f"  FAIL {failure['name']}: {failure['detail']}")
    print(f"manifest {report['manifest']['sha256']}")
    print(f"determinism byteIdentical={report['determinism']['byteIdentical']}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
