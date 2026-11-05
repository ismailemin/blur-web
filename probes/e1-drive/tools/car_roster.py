"""Decode the RP_CarDynamics records into the E1 drive-slice car roster.

    python probes/e1-drive/tools/car_roster.py [--list]

Exactly one decoder is used: `engine/harness/t005d-vehicle/car_xt.py`, the
extractor that produced the verified T-005d `car.fields`. This tool does not
re-derive the XT layout. It

  1. extracts `gamedata\\xt\\racingphysics.bin` from the installed PAK,
  2. enumerates **every** `RP_CarDynamics` record (index, id, name),
  3. decodes each record to the `name<TAB>value` field list the wasm ABI consumes
     and runs the completeness gate below on the decoded values,
  4. validates the committed selection in `probes/e1-drive/cars/roster.json`
     (name, record id, record index; a mismatch is a hard failure),
  5. writes one field file per selected car and the roster document.

Outputs (never committed; decoded game data):
  _work/e1-drive/cars/<slug>.fields   per-car field list (CRLF, as T-005d)
  _work/e1-drive/cars.json            the roster document (all records + gate)

The gate is the definition of "can be driven faithfully": a car whose record has
a non-positive mass/wheelbase/track/tyre radius/gear/final ratio/brake force, a
missing or short gear/torque/grip array, an out-of-range top gear or an unknown
drive type is **excluded with the exact field and value**, never patched or
guessed. Nothing here invents a value.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work/e1-drive"
CARS_OUT = OUT / "cars"
ROSTER = ROOT / "probes/e1-drive/cars/roster.json"
HARNESS = ROOT / "engine/harness/t005d-vehicle"

if str(HARNESS) not in sys.path:
    sys.path.insert(0, str(HARNESS))
import car_xt  # noqa: E402

DRIVE_TYPE = {0: "RWD", 1: "FWD", 2: "AWD"}

# Fields the physics actually needs, with the reason each one is required. A
# zero here is not a tuning choice: mass 0 has no inertia, a zero gear ratio has
# no torque path, a zero tyre radius has no wheel.
POSITIVE = [
    ("mass.mass", "gravity body mass"),
    ("geometry.wheelBase", "box proxy + wheel placement"),
    ("geometry.trackWidthFront", "box proxy half extent"),
    ("geometry.trackWidthRear", "track width"),
    ("tyres.frontTyres.radius", "ride height + wheel radius"),
    ("tyres.rearTyres.radius", "wheel radius"),
    ("engine.limiterRPM", "engine speed range"),
    ("engine.engineTorque_Rpm.x1", "torque curve x extent"),
    ("engine.engineTorque_Rpm.yScale", "torque scale"),
    ("gears.gearRatios[0]", "first gear ratio"),
    ("gears.finalRatio", "final drive"),
    ("brakes.frontBrakeForce", "front brakes"),
    ("brakes.rearBrakeForce", "rear brakes"),
]

COUNTS = [
    ("gears.gearRatios", 2, "at least first and second gear"),
    ("engine.engineTorque_Rpm.dataPoints", 2, "a torque curve needs two points"),
    ("tyres.frontTyres.grip.data", 2, "front grip curve"),
    ("tyres.rearTyres.grip.data", 2, "rear grip curve"),
]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def record_names(xt: dict) -> list[dict]:
    """Every record of type RP_CarDynamics: index, id, name (from the XtSz8 blob)."""
    car_type = {t["name"]: t["index"] for t in xt["types"]}["RP_CarDynamics"]
    data = xt["data"]
    out = []
    for rec in xt["records"]:
        if rec["type"] != car_type:
            continue
        blob = car_xt._string_blob(xt, rec)
        name_off = struct.unpack_from("<I", data, rec["dataOffset"])[0]
        end = blob.find(b"\0", name_off)
        out.append({"index": rec["index"], "id": rec["id"],
                    "name": blob[name_off:end].decode("ascii", "replace")})
    return out


def hex_f32(raw: str) -> float:
    """The field file stores a binary32 bit pattern as 8 hex digits (value, not bytes)."""
    return struct.unpack("<f", struct.pack("<I", int(raw, 16)))[0]


def typed_values(xt: dict, lines: list[tuple[str, str]]) -> dict:
    """Turn the field lines back into typed values using the record's schema."""
    car_type = {t["name"]: t["index"] for t in xt["types"]}["RP_CarDynamics"]
    kinds = {leaf["name"]: leaf["kind"] for leaf in car_xt.leaves(xt, car_type)}
    counts = {leaf["name"] for leaf in car_xt.leaves(xt, car_type)
              if leaf.get("array") or leaf["kind"] == "structArray"}
    values: dict[str, float | int] = {}
    for name, raw in lines:
        if name == "record.name":
            values[name] = raw
        elif name == "record.physicsParametersHandle":
            values[name] = int(raw)
        elif name in counts:
            values[name] = int(raw)
        elif name in kinds:
            if kinds[name] == "f32":
                values[name] = hex_f32(raw)
            else:
                values[name] = int(raw)
        elif "[" in name:  # array element: always a f32 bit pattern
            values[name] = hex_f32(raw)
        else:
            raise ValueError(f"unexpected field line {name!r}")
    return values


def gate(values: dict) -> dict:
    problems: list[str] = []
    for path, why in POSITIVE:
        if path not in values:
            problems.append(f"missing {path} ({why})")
            continue
        value = values[path]
        if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            problems.append(f"{path}={value!r} is not finite ({why})")
        elif value <= 0:
            problems.append(f"{path}={value!r} must be > 0 ({why})")

    for path, least, why in COUNTS:
        n = values.get(path)
        if not isinstance(n, int):
            problems.append(f"missing array {path} ({why})")
        elif n < least:
            problems.append(f"{path} has {n} elements, needs at least {least} ({why})")

    top = values.get("gears.topGear")
    ratios = values.get("gears.gearRatios")
    if isinstance(top, int) and isinstance(ratios, int) and not (1 <= top <= ratios):
        problems.append(f"gears.topGear={top} outside 1..{ratios} gear ratios")

    drive = values.get("transmission.driveType")
    if drive not in DRIVE_TYPE:
        problems.append(f"transmission.driveType={drive!r} is not one of {sorted(DRIVE_TYPE)}")

    non_finite = sorted(name for name, value in values.items()
                        if isinstance(value, float) and not math.isfinite(value))
    if non_finite:
        problems.append("non-finite fields: " + ", ".join(non_finite))

    return {"ok": not problems, "problems": problems}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="print every record and exit")
    args = parser.parse_args()

    data = car_xt.extract(ROOT / "game-data/Blur")
    xt = car_xt.parse(data)
    records = record_names(xt)
    roster_doc = json.loads(ROSTER.read_text(encoding="utf-8"))
    selected = {entry["name"]: entry for entry in roster_doc["cars"]}

    decoded = {}
    for rec in records:
        lines, evidence = car_xt.decode_car(xt, rec["name"])
        values = typed_values(xt, lines)
        decoded[rec["name"]] = {
            "record": {"index": rec["index"], "id": rec["id"], "name": rec["name"]},
            "lines": lines,
            "values": values,
            "gate": gate(values),
            "fieldLines": len(lines),
            "arrayComponentsUsed": evidence["record"]["arrayComponentsUsed"],
            "physicsParametersHandleId": evidence["physicsParametersHandleId"],
        }

    if args.list:
        for name, entry in decoded.items():
            values = entry["values"]
            print(f"{entry['record']['index']:3d} {entry['record']['id']:10d} {name:34s} "
                  f"{DRIVE_TYPE.get(values['transmission.driveType'], '?'):3s} "
                  f"m={values['mass.mass']:7.1f} wb={values['geometry.wheelBase']:5.3f} "
                  f"gears={values['gears.gearRatios']} gate={'ok' if entry['gate']['ok'] else 'FAIL'}")
            for problem in entry["gate"]["problems"]:
                print("      -", problem)
        return 0

    failures: list[str] = []

    default = roster_doc["default"]

    # ---- the committed selection must still describe these records -----------
    for name, entry in selected.items():
        if name not in decoded:
            failures.append(f"roster car {name!r} is not an RP_CarDynamics record")
            continue
        record = decoded[name]["record"]
        if record["id"] != entry["recordId"]:
            failures.append(f"{name}: roster says record id {entry['recordId']}, data has {record['id']}")
        if record["index"] != entry["recordIndex"]:
            failures.append(f"{name}: roster says record index {entry['recordIndex']}, data has {record['index']}")
        if not decoded[name]["gate"]["ok"]:
            failures.append(f"{name} fails the completeness gate: " + "; ".join(decoded[name]["gate"]["problems"]))

    if not any(entry["slug"] == default for entry in roster_doc["cars"]):
        failures.append(f"default car slug {default!r} is not in the roster")

    # ---- write per-car field lists ------------------------------------------
    CARS_OUT.mkdir(parents=True, exist_ok=True)
    cars = []
    for order, (name, entry) in enumerate(selected.items()):
        record = decoded[name]["record"]
        lines = decoded[name]["lines"]
        text = "".join(f"{key}\t{value}\r\n" for key, value in lines)
        path = CARS_OUT / f"{entry['slug']}.fields"
        path.write_bytes(text.encode("utf-8"))
        values = decoded[name]["values"]
        cars.append({
            "slug": entry["slug"],
            "name": name,
            "order": order,
            "default": entry["slug"] == default,
            "record": record,
            "layout": entry["layout"],
            "why": entry["why"],
            "drivetrain": DRIVE_TYPE.get(values["transmission.driveType"], "?"),
            "driveType": values["transmission.driveType"],
            "fieldLines": decoded[name]["fieldLines"],
            "fields": {
                "path": path.relative_to(ROOT).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            },
            "values": {
                "mass": values["mass.mass"],
                "wheelBase": values["geometry.wheelBase"],
                "trackWidthFront": values["geometry.trackWidthFront"],
                "trackWidthRear": values["geometry.trackWidthRear"],
                "tyreRadiusFront": values["tyres.frontTyres.radius"],
                "tyreRadiusRear": values["tyres.rearTyres.radius"],
                "gears": values["gears.gearRatios"],
                "topGear": values["gears.topGear"],
                "finalRatio": values["gears.finalRatio"],
                "gearRatios": [values[f"gears.gearRatios[{i}]"] for i in range(values["gears.gearRatios"])],
                "torquePoints": values["engine.engineTorque_Rpm.dataPoints"],
                "torqueScaleNm": values["engine.engineTorque_Rpm.yScale"],
                "torqueCurve": [values[f"engine.engineTorque_Rpm.dataPoints[{i}]"]
                                for i in range(values["engine.engineTorque_Rpm.dataPoints"])],
                "limiterRPM": values["engine.limiterRPM"],
                "brakesFront": values["brakes.frontBrakeForce"],
                "brakesRear": values["brakes.rearBrakeForce"],
                "frontGripPoints": values["tyres.frontTyres.grip.data"],
                "rearGripPoints": values["tyres.rearTyres.grip.data"],
            },
            "gate": decoded[name]["gate"],
            "physicsParametersHandleId": decoded[name]["physicsParametersHandleId"],
        })

    all_records = []
    for name, entry in decoded.items():
        values = entry["values"]
        all_records.append({
            "index": entry["record"]["index"],
            "id": entry["record"]["id"],
            "name": name,
            "drivetrain": DRIVE_TYPE.get(values.get("transmission.driveType"), "?"),
            "mass": values.get("mass.mass"),
            "wheelBase": values.get("geometry.wheelBase"),
            "gears": values.get("gears.gearRatios"),
            "topGear": values.get("gears.topGear"),
            "gate": entry["gate"]["ok"],
            "problems": entry["gate"]["problems"],
            "selected": name in selected,
        })

    doc = {
        "kind": "e1-drive.car-roster",
        "version": 1,
        "status": "PASS" if not failures else "FAIL",
        "source": {
            "container": "game-data/Blur/cache/gamedata.pak",
            "file": "gamedata\\xt\\racingphysics.bin",
            "bytes": len(data),
            "sha256": sha256_bytes(data),
            "recordType": "RP_CarDynamics",
            "recordTypeSize": xt["types"][{t["name"]: t["index"] for t in xt["types"]}["RP_CarDynamics"]]["size"],
            "records": len(records),
        },
        "decoder": {
            "tool": "engine/harness/t005d-vehicle/car_xt.py",
            "sha256": sha256_file(HARNESS / "car_xt.py"),
            "format": "probes/asset-reader/FORMAT-xt.md",
            "note": "same extractor that produced the verified T-005d car.fields; nothing is re-derived",
        },
        "roster": {
            "manifest": ROSTER.relative_to(ROOT).as_posix(),
            "default": default,
            "cars": cars,
        },
        "gate": {
            "positive": [{"field": path, "why": why} for path, why in POSITIVE],
            "minimumCounts": [{"field": path, "min": least, "why": why} for path, least, why in COUNTS],
            "topGearWithinRatios": True,
            "driveTypeIn": sorted(DRIVE_TYPE),
            "nonFiniteRejected": True,
        },
        "records": all_records,
        "counts": {
            "records": len(records),
            "gatePass": sum(1 for entry in all_records if entry["gate"]),
            "gateFail": sum(1 for entry in all_records if not entry["gate"]),
            "selected": len(cars),
        },
        "failures": failures,
    }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "cars.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

    # The single-car slice always used this path; keep it pointing at the default
    # car and prove it is the T-005d extractor's own output, byte for byte.
    default_fields = CARS_OUT / f"{default}.fields"
    legacy = OUT / "car.fields"
    legacy.write_bytes(default_fields.read_bytes())
    t005_fields = ROOT / "_work/engine-vehicle-spike/car.fields"
    legacy_matches = None
    if t005_fields.is_file():
        legacy_matches = sha256_file(t005_fields) == sha256_file(legacy)

    print(json.dumps({
        "status": doc["status"],
        "records": len(records),
        "gatePass": doc["counts"]["gatePass"],
        "gateFail": doc["counts"]["gateFail"],
        "cars": [{"slug": car["slug"], "name": car["name"], "record": car["record"],
                  "drivetrain": car["drivetrain"], "mass": car["values"]["mass"],
                  "fields": car["fields"]["sha256"][:16]} for car in cars],
        "defaultFieldsIdenticalToT005d": legacy_matches,
        "failures": failures,
    }, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
