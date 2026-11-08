"""Per-car vehicle physics envelope extraction (PHYS1).

Authority and scope
-------------------
* Physics values are decoded from ``gamedata\\xt\\racingphysics.bin`` (inside
  ``game-data/Blur/cache/gamedata.pak``) with the committed decoder
  ``engine/harness/t005d-vehicle/car_xt.py``.  That module is imported read-only;
  nothing in it is modified.  The format contract is
  ``probes/asset-reader/FORMAT-xt.md``.
* Body bounds and wheel rest geometry are read from the committed car-part
  manifests (``_work/car-parts/cars/<slug>/manifest.json``) and the staged
  C-alias manifests (``_work/vehicle-pipeline/c-staging/<slug>/manifest.json``);
  the V1 audit ``_work/vehicle-pipeline/cars.json`` supplies the remaining
  Scene-reader bounds.  Every input is hash-pinned in the manifest.
* Nothing is invented.  A value that the XT schema does not carry is reported as
  ``absent`` with the source that would have to supply it.

The module is deterministic: no clock, no randomness, no filesystem iteration
order (every directory listing is sorted, every dictionary emitted with sorted
keys).
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

CAR_XT = ROOT / "engine/harness/t005d-vehicle/car_xt.py"
GAME_DIR = ROOT / "game-data/Blur"
PAK_REL = "cache/gamedata.pak"
XT_ENTRY = "\\gamedata\\xt\\racingphysics.bin"

VP_CARS = ROOT / "_work/vehicle-pipeline/cars.json"
VP_ALIASES = ROOT / "_work/vehicle-pipeline/c-aliases.json"
VP_STAGING = ROOT / "_work/vehicle-pipeline/c-staging-results.json"
CP_INDEX = ROOT / "_work/car-parts/cars/index.json"
ROSTER = ROOT / "_work/e1-drive/cars.json"

# The fixed envelope the prop/power-up consumers use today.
# Source: probes/prop-collision/lib/collider-build.mjs CAR_ENVELOPE.
FIXED_ENVELOPE = {
    "length": 2.98,
    "width": 1.68,
    "height": 1.35,
    "source": "probes/prop-collision/lib/collider-build.mjs CAR_ENVELOPE",
    "derivedFrom": "five-car E1 roster: longest wheelbase 2.981 m "
                   "(Dodge_Challenger_Stock) x widest track 1.676 m "
                   "(Audi_R8V10_Stock, rear), rounded to 2.98 x 1.68",
}

# Body/manifest axis meaning, measured - not assumed: the wheel rest
# translations match +/-track/2 on X and +/-wheelBase/2 on Z for every car
# sampled, so the manifest object-local frame is X=width, Y=up, Z=length.
BODY_AXES = {"x": "width", "y": "height", "z": "length"}

KIND_LABEL = {1: "bool", 4: "i32", 10: "f32", 12: "sz8"}

# Units that the committed consumers establish.  Paths not listed here are
# reported as engine scalars; see unit_for().
UNITS = {
    "mass.mass": ("kg", "SI mass; the harness loads it as float kg "
                        "(vehicle_harness.cpp:978) and the telemetry record "
                        "labels it kg (T-007-telemetry.md)"),
    "mass.cofGOffsetY": ("m", "centre-of-mass offset; same length scale as the "
                              "geometry metres"),
    "mass.cofGOffsetZ": ("m", "centre-of-mass offset; same length scale as the "
                              "geometry metres"),
    "mass.physicsCofMassOffsetY": ("m", "physics centre-of-mass offset"),
    "mass.physicsCofMassOffsetZ": ("m", "physics centre-of-mass offset"),
    "geometry.wheelBase": ("m", "used directly as metres by Car and the harness "
                                "Gravity box (vehicle_harness.cpp:972-1000)"),
    "geometry.trackWidthFront": ("m", "used directly as metres by the harness "
                                      "Gravity box half extent"),
    "geometry.trackWidthRear": ("m", "track width; same unit as the front track"),
    "suspension.front.movementUp": ("m", "suspension travel; added to the tyre "
                                        "radius to get ride height "
                                        "(vehicle_harness.cpp:964)"),
    "suspension.front.movementDown": ("m", "suspension travel; same unit as "
                                          "movementUp (car.cpp:1124)"),
    "suspension.rear.movementUp": ("m", "suspension travel; ride-height term"),
    "suspension.rear.movementDown": ("m", "suspension travel (car.cpp:1141)"),
    "suspension.front.casterAngle": ("rad (small-angle sine)", "assigned to "
                                     "sinCasterAngle directly (car.cpp:1300-1303)"),
    "suspension.rear.casterAngle": ("rad (small-angle sine)", "same struct as "
                                    "the front casterAngle"),
    "suspension.front.camberAngle": ("unknown", "not read by the car step in "
                                     "this build"),
    "suspension.rear.camberAngle": ("unknown", "not read by the car step in "
                                    "this build"),
    "suspension.front.toeAngle": ("unknown", "not read by the car step in this "
                                  "build"),
    "suspension.rear.toeAngle": ("unknown", "not read by the car step in this "
                               "build"),
    "steering.steerLimit": ("rad", "assigned to steerLimitL/R and used as a wheel "
                                   "angle (car.cpp:1620-1631)"),
    "steering.ackerman": ("scalar", "steering geometry scalar"),
    "brakes.frontBrakeForce": ("scalar", "brake force scale, not newtons "
                                         "(T-007-telemetry.md compares it as a "
                                         "scalar)"),
    "brakes.rearBrakeForce": ("scalar", "brake force scale"),
    "brakes.handbrakeForce": ("scalar", "brake force scale"),
    "engine.engineTorque_Rpm.yScale": ("Nm", "torque scale; the committed "
                                           "roster calls the same value "
                                           "torqueScaleNm"),
    "engine.limiterRPM": ("rpm", "rev limiter; the harness and telemetry treat "
                                 "it as RPM"),
    "engine.idleRPM": ("rpm", "idle speed"),
    "engine.engineTorque_Rpm.dataPoints": ("normalised", "torque curve points "
                                                         "scaled by yScale"),
    "tyres.frontTyres.radius": ("m", "tyre radius; added to suspension travel "
                                     "for ride height and used as the Gravity "
                                     "box half height"),
    "tyres.rearTyres.radius": ("m", "tyre radius"),
    "tyres.frontTyres.grip.data": ("normalised", "slip -> grip-scale graph"),
    "tyres.rearTyres.grip.data": ("normalised", "slip -> grip-scale graph"),
    "gears.gearRatios": ("ratio", "gear ratio"),
    "gears.reverseGearRatio": ("ratio", "gear ratio"),
    "gears.finalRatio": ("ratio", "final drive ratio"),
    "gears.topGear": ("count", "forward gear count"),
    "friction.airFriction": ("scalar", "engine friction scalar"),
    "friction.rollingFriction": ("scalar", "engine friction scalar"),
    "friction.constantDownforce": ("scalar", "downforce scalar"),
    "friction.downforce": ("scalar", "downforce scalar"),
    "friction.downforceOffset": ("scalar", "downforce scalar"),
    "friction.rotationalAirFriction": ("scalar", "engine friction scalar"),
    "transmission.driveType": ("enum", "RP_CarDriveType: 0 RWD, 1 FWD, 2 AWD"),
    "transmission.frontDifferential.differentialType": ("enum", "RP_CarDifferentialType"),
    "transmission.rearDifferential.differentialType": ("enum", "RP_CarDifferentialType"),
    "transmission.midDifferential.differentialType": ("enum", "RP_CarDifferentialType"),
    "engine.transverse": ("bool", "engine layout flag"),
}

# Leaves whose value changes the physical envelope / wheel geometry.
GEOMETRY_RELEVANT = {
    "mass.mass", "mass.MIScaleX", "mass.MIScaleY", "mass.MIScaleZ",
    "mass.cofGOffsetY", "mass.cofGOffsetZ",
    "mass.physicsCofMassOffsetY", "mass.physicsCofMassOffsetZ",
    "mass.frontWheelMI", "mass.rearWheelMI",
    "mass.interiaTensorScaleX", "mass.interiaTensorScaleY",
    "mass.interiaTensorScaleZ",
    "geometry.wheelBase", "geometry.trackWidthFront", "geometry.trackWidthRear",
    "steering.steerLimit", "steering.ackerman",
    "suspension.front.casterAngle", "suspension.front.camberAngle",
    "suspension.front.toeAngle", "suspension.front.movementDown",
    "suspension.front.movementUp", "suspension.front.springStiffness",
    "suspension.front.rollStiffness",
    "suspension.rear.casterAngle", "suspension.rear.camberAngle",
    "suspension.rear.toeAngle", "suspension.rear.movementDown",
    "suspension.rear.movementUp", "suspension.rear.springStiffness",
    "suspension.rear.rollStiffness",
    "tyres.frontTyres.radius", "tyres.rearTyres.radius",
}

# Physics-extraction set: every field the PHYS1 brief names.
EXTRACT_SET = GEOMETRY_RELEVANT | {
    "brakes.frontBrakeForce", "brakes.rearBrakeForce", "brakes.handbrakeForce",
    "brakes.brakeSmoothTime", "brakes.handbrakeSmoothTime",
    "engine.engineTorque_Rpm.x0", "engine.engineTorque_Rpm.x1",
    "engine.engineTorque_Rpm.yScale", "engine.engineTorque_Rpm.dataPoints",
    "engine.engineInertia", "engine.limiterRPM", "engine.idleRPM",
    "engine.powerCutFraction", "engine.clutchRPMFraction",
    "engine.engineBraking_RpmFraction.x0", "engine.engineBraking_RpmFraction.y0",
    "engine.engineBraking_RpmFraction.x1", "engine.engineBraking_RpmFraction.y1",
    "engine.tractionControlMaxSpin", "engine.tractionControlMaxSlip",
    "engine.wheelSpinMaxSpeed_Mph", "engine.transverse",
    "gears.gearRatios", "gears.reverseGearRatio", "gears.topGear",
    "gears.finalRatio", "gears.gearDownRPMFraction",
    "gears.maxSpeedForChangeToFirst_Mph", "gears.maxSpeedForReverse_Mph",
    "transmission.driveType",
    "transmission.frontDifferential.differentialType",
    "transmission.frontDifferential.forwardsTorque",
    "transmission.frontDifferential.backwardsTorque",
    "transmission.frontDifferential.viscosity",
    "transmission.rearDifferential.differentialType",
    "transmission.rearDifferential.forwardsTorque",
    "transmission.rearDifferential.backwardsTorque",
    "transmission.rearDifferential.viscosity",
    "transmission.midDifferential.differentialType",
    "transmission.midDifferential.forwardsTorque",
    "transmission.midDifferential.backwardsTorque",
    "transmission.midDifferential.viscosity",
    "tyres.frontTyres.grip.data", "tyres.frontTyres.grip.yScale",
    "tyres.frontTyres.loadDependence", "tyres.frontTyres.transverseGripScale",
    "tyres.frontTyres.forwardsGripScale", "tyres.frontTyres.backwardsGripScale",
    "tyres.frontTyres.transverseTyreSlipScale",
    "tyres.frontTyres.longitudinalTyreSlipScale",
    "tyres.frontTyres.combinedSlipForwards_Mph.x0",
    "tyres.frontTyres.combinedSlipForwards_Mph.y0",
    "tyres.frontTyres.combinedSlipForwards_Mph.x1",
    "tyres.frontTyres.combinedSlipForwards_Mph.y1",
    "tyres.frontTyres.dynamicFrictionSpeed", "tyres.frontTyres.slipSpeed",
    "tyres.frontTyres.forwardsGripScaleInGear",
    "tyres.rearTyres.grip.data", "tyres.rearTyres.grip.yScale",
    "tyres.rearTyres.loadDependence", "tyres.rearTyres.transverseGripScale",
    "tyres.rearTyres.forwardsGripScale", "tyres.rearTyres.backwardsGripScale",
    "tyres.rearTyres.transverseTyreSlipScale",
    "tyres.rearTyres.longitudinalTyreSlipScale",
    "tyres.rearTyres.combinedSlipForwards_Mph.x0",
    "tyres.rearTyres.combinedSlipForwards_Mph.y0",
    "tyres.rearTyres.combinedSlipForwards_Mph.x1",
    "tyres.rearTyres.combinedSlipForwards_Mph.y1",
    "tyres.rearTyres.dynamicFrictionSpeed", "tyres.rearTyres.slipSpeed",
    "tyres.rearTyres.forwardsGripScaleInGear",
    "friction.airFriction", "friction.rollingFriction",
    "friction.constantDownforce", "friction.downforce",
    "friction.downforceOffset", "friction.rotationalAirFriction",
}

# Fields PHYS1 asks for that the XT schema does not carry.
MISSING_FIELDS = [
    {
        "path": "collisionExtents",
        "status": "absent",
        "reason": "RP_CarDynamics has no collision box or body-extents leaf. All "
                  "149 schema leaves were enumerated; the only length fields are "
                  "wheelBase, trackWidthFront/Rear, the tyre radii and the "
                  "suspension travel.",
        "expectedSource": "retail imports the model's composite collision shape "
                          "(VehicleActor.cpp:6905-6970); this project has no such "
                          "import. The visible mesh AABB is the recorded upper bound.",
    },
    {
        "path": "bodyLength",
        "status": "absent",
        "reason": "no serialised body length; wheelBase is the axle distance and "
                  "excludes the front/rear overhang",
        "expectedSource": "mesh AABB (first RenderList LOD0) minus the wheelbase "
                          "gives the total overhang",
    },
    {
        "path": "bodyWidth",
        "status": "absent",
        "reason": "no serialised body width; the track is a wheel-centre distance "
                  "and excludes the tyre width and the body sides",
        "expectedSource": "mesh AABB width, or track + 2 x wheel width as a lower "
                          "bound",
    },
    {
        "path": "bodyHeight",
        "status": "absent",
        "reason": "no serialised body height; only the tyre radius and suspension "
                  "travel exist",
        "expectedSource": "mesh AABB height",
    },
    {
        "path": "wheelWidth",
        "status": "absent",
        "reason": "no serialised wheel or tyre width field",
        "expectedSource": "mesh wheel-member local bounds (tyre element X extent)",
    },
    {
        "path": "rideHeight",
        "status": "derived",
        "reason": "not serialised; the harness derives it as "
                  "tyres.frontTyres.radius + suspension.front.movementUp "
                  "(vehicle_harness.cpp:964)",
        "expectedSource": "derived from two serialised fields",
    },
    {
        "path": "frontOverhang",
        "status": "absent",
        "reason": "no serialised overhang",
        "expectedSource": "mesh AABB front edge minus front axle position",
    },
    {
        "path": "rearOverhang",
        "status": "absent",
        "reason": "no serialised overhang",
        "expectedSource": "mesh AABB rear edge minus rear axle position",
    },
    {
        "path": "mass.physicsParameters",
        "status": "unresolved-handle",
        "reason": "XtHandle id resolves through the XT database across packs; the "
                  "harness installs the null handle and reports the raw id. The "
                  "linked parameters (surface maps, grip scales) are therefore not "
                  "applied: surfaceMappingsApplied:false in the engine spike.",
        "expectedSource": "full XT runtime (not ported)",
    },
]


# --------------------------------------------------------------------------- #
# hashing / io
# --------------------------------------------------------------------------- #

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("utf-8")


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def round6(value):
    if isinstance(value, float):
        return round(value, 6)
    return value


# --------------------------------------------------------------------------- #
# XT decode
# --------------------------------------------------------------------------- #

def load_car_xt():
    spec = importlib.util.spec_from_file_location("phys1_car_xt", CAR_XT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _mirror_leaves(xt, type_index, path="", base=0, depth=0):
    """Mirror of car_xt.leaves() that also records the schema field index.

    The result is asserted equal to car_xt.leaves() for every type, so the
    extra fieldIndex cannot drift from the committed traversal.
    """
    t = xt["types"][type_index]
    out = []
    for index in range(t["fieldStart"], t["fieldStart"] + t["fieldCount"]):
        f = xt["fields"][index]
        name = f"{path}.{f['name']}" if path else f["name"]
        off = base + f["offset"]
        if f["behaviour"] == 3:
            if f["array"]:
                out.append({"kind": "structArray", "name": name, "type": f["type"],
                            "offset": off, "fieldIndex": index, "depth": depth})
            else:
                out.extend(_mirror_leaves(xt, f["type"], name, off, depth + 1))
        elif f["behaviour"] == 5:
            out.append({"kind": "handle", "name": name, "type": f["type"],
                        "offset": off, "fieldIndex": index, "depth": depth})
        elif f["behaviour"] in (1, 2):
            out.append({"kind": "i32", "name": name, "type": f["type"],
                        "offset": off, "fieldIndex": index, "depth": depth})
        else:
            atom = xt["types"][f["type"]]["atom"]
            out.append({"kind": KIND_LABEL.get(atom, "?"), "name": name,
                        "type": f["type"], "offset": off, "fieldIndex": index,
                        "depth": depth, "array": f["array"]})
    return out


# Consumers that hard-code the fixed envelope or the fixed wheel geometry.  The
# line numbers were read from the working tree on the date of this record; the
# file paths are the contract, the lines are the evidence.
INTEGRATION = {
    "status": "recommendation-only; no consumer was modified by PHYS1",
    "perCarValues": [
        "envelopeChoices.collisionUpperBound -> collision length/width/height",
        "envelopeChoices.chassisFootprint -> wheel-centre rectangle (lower bound)",
        "envelopeChoices.engineBodyBox -> Gravity box proxy (engine harness)",
        "derived.wheelGeometry.* -> visual wheel radius, travel and steer clamp",
    ],
    "consumers": [
        {
            "path": "probes/prop-collision/lib/collider-build.mjs",
            "line": 27,
            "symbol": "CAR_ENVELOPE",
            "current": "2.98 x 1.68 x 1.35 m for every car",
            "mustBecomePerCar": "collisionUpperBound (or chassisFootprint when only "
                                "the axle rectangle is wanted)",
            "note": "also feeds the resolver default, build_colliders and the map-props "
                    "tools; changing it changes the committed collider manifests' "
                    "carEnvelope field, so keep the committed files and pass the "
                    "per-car box at query time",
        },
        {
            "path": "probes/e1-drive/web/prop-layer.js",
            "line": 280,
            "symbol": "envelope = carEnvelope ?? manifest.carEnvelope ?? {2.98,1.68,1.35}",
            "current": "one envelope per page, taken from the manifest",
            "mustBecomePerCar": "the selected car's collisionUpperBound",
            "note": "call site probes/e1-drive/web/app.js:2534; the envelope is already "
                    "a parameter, so no resolver change is needed",
        },
        {
            "path": "probes/e1-drive/web/powerups.js",
            "line": 54,
            "symbol": "POWERUP_CAR_ENVELOPE / POWERUP_TARGET_RADIUS_M",
            "current": "one target envelope and one circumradius (1.7104677722775135 m) "
                       "for every target",
            "mustBecomePerCar": "the target car's envelope and circumradius; the "
                                "current radius belongs to the fixed box, not to the "
                                "target",
            "note": "Blindfire, Shunt and Barge use this target volume; a Lotus and a "
                    "Hummer are currently the same target",
        },
        {
            "path": "probes/e1-drive/web/sprint-layout.js",
            "line": 1500,
            "symbol": "options.carEnvelope",
            "current": "passed through from the page/manifest",
            "mustBecomePerCar": "the selected car's collisionUpperBound",
            "note": "used by the prop contact filter on the referenced ghost",
        },
        {
            "path": "probes/free-roam-prop/tools/build_props.py",
            "line": 41,
            "symbol": "CAR = {length:2.98,width:1.68,height:1.35}",
            "current": "fixed box in the free-roam region/prop build",
            "mustBecomePerCar": "collisionUpperBound per car, or keep the fixed box "
                                "only as an explicitly labelled worst case",
            "note": "duplicated in verify_props.py:35 and resolve_r04.mjs:41",
        },
        {
            "path": "probes/map-laps/tools/verify_map_loops.py",
            "line": 38,
            "symbol": "CAR_LENGTH = 2.981",
            "current": "one car length for the lap-clearance test",
            "mustBecomePerCar": "collisionUpperBound.length",
            "note": "a lap that clears a 2.981 m car does not clear a 5.020 m car",
        },
        {
            "path": "probes/free-roam/tools/build_regions.py",
            "line": 89,
            "symbol": "CAR_LENGTH = 2.981",
            "current": "one car length/width proxy (2.981 x 1.676)",
            "mustBecomePerCar": "collisionUpperBound per car",
            "note": "region reachability is measured against this proxy",
        },
        {
            "path": "engine/harness/t005d-vehicle/vehicle_harness.cpp",
            "line": 964,
            "symbol": "rideHeight / boxDesc.m_HalfExtents / bounds",
            "current": "already per car: radius + movementUp, and "
                       "(trackWidthFront/2, tyreRadius, wheelBase/2)",
            "mustBecomePerCar": "no change required for the values; the box is a chassis "
                                "proxy, not the body, so body contacts still need the "
                                "imported composite shape",
            "note": "the box height is the tyre radius, not the body height: a 1.246 m "
                    "tall Corvette body is represented by a 0.712 m band",
        },
        {
            "path": "probes/e1-drive/web/packet-adapter.js",
            "line": 1039,
            "symbol": "mapWheelsToCorners / advanceWheelSpin",
            "current": "wheel corner uses the manifest rest translation (per car) but "
                       "the rendered wheel ignores suspension travel and steer angle",
            "mustBecomePerCar": "suspension.*.movementUp/Down and steering.steerLimit "
                                "already exist in the state; wheel radius for the spin "
                                "rate comes from the mesh, not the XT radius",
            "note": "state.wheels[].suspension is emitted by the harness (line 498) and "
                    "is currently unused by the renderer",
        },
    ],
}


def unit_for(path: str):
    if path in UNITS:
        return UNITS[path]
    if path.startswith(("engine.", "gears.", "brakes.", "transmission.",
                        "friction.", "suspension.")):
        return ("engine-scalar",
                "no unit statement in FORMAT-xt.md or the committed consumer; "
                "the value is consumed as an engine scalar")
    return ("unknown", "no unit statement in FORMAT-xt.md or the committed consumer")


def role_for(path: str) -> str:
    if path.startswith("mass."):
        return "mass" if path == "mass.mass" else "inertia/centre-of-mass"
    if path.startswith("geometry."):
        return "geometry"
    if path.startswith("suspension."):
        return "suspension"
    if path.startswith("steering."):
        return "steering"
    if path.startswith("brakes."):
        return "brakes"
    if path.startswith("engine."):
        return "engine"
    if path.startswith("transmission."):
        return "transmission"
    if path.startswith("gears."):
        return "gears"
    if path.startswith("tyres."):
        return "tyres"
    if path.startswith("friction."):
        return "friction"
    return "other"


def schema_catalog(xt):
    """Every leaf of RP_CarDynamics with id, schema offset, kind and units."""
    car_xt = load_car_xt()
    by_name = {t["name"]: t["index"] for t in xt["types"]}
    car_type = by_name["RP_CarDynamics"]
    mirrored = _mirror_leaves(xt, car_type)
    committed = car_xt.leaves(xt, car_type)

    left = [(l["name"], l["offset"], l["kind"], l.get("array")) for l in mirrored]
    right = [(l["name"], l["offset"], l["kind"], l.get("array")) for l in committed]
    if left != right:
        raise ValueError("PHYS1 leaf walk diverged from the committed car_xt.leaves")

    catalog = []
    for leaf in mirrored:
        tin = xt["types"][leaf["type"]]
        unit, evidence = unit_for(leaf["name"])
        catalog.append({
            "path": leaf["name"],
            "fieldIndex": leaf["fieldIndex"],
            "schemaOffset": leaf["offset"],
            "imageOffset": leaf["offset"],
            "bytes": 4 if leaf["kind"] != "structArray" else 8,
            "kind": leaf["kind"],
            "typeName": tin["name"],
            "atom": tin["atom"],
            "array": bool(leaf.get("array")),
            "depth": leaf["depth"],
            "role": role_for(leaf["name"]),
            "unit": unit,
            "unitEvidence": evidence,
            "geometryRelevant": leaf["name"] in GEOMETRY_RELEVANT,
            "extracted": leaf["name"] in EXTRACT_SET,
        })
    return catalog


def decode_record(xt, rec, catalog=None):
    """Decode one RP_CarDynamics image exactly as car_xt.decode_car does."""
    if catalog is None:
        catalog = schema_catalog(xt)
    image = xt["data"][rec["dataOffset"]:rec["dataOffset"] + rec["dataBytes"]]
    comps = []
    cursor = 0
    for i in range(rec["componentStart"], rec["componentStart"] + rec["componentCount"]):
        typ, count, beh = xt["components"][i]
        width = xt["types"][typ]["size"] if beh == 0 else 4
        comps.append({"type": typ, "count": count, "behaviour": beh,
                      "offset": cursor, "width": width})
        cursor = (cursor + count * width + 3) & ~3

    values = {}
    arrays = {}
    handle_id = None
    for leaf in catalog:
        off = leaf["schemaOffset"]
        name = leaf["path"]
        if leaf["kind"] == "sz8":
            continue
        if leaf["kind"] == "handle":
            handle_id = struct.unpack_from("<I", image, off)[0]
            if handle_id == 0xFFFFFFFF:
                handle_id = 0
            continue
        if leaf["array"] or leaf["kind"] == "structArray":
            component, element, length = struct.unpack_from("<HHI", image, off)
            if component == 0xFFFF or length == 0:
                arrays[name] = {"count": 0, "component": None,
                                "descriptorOffset": off, "elementOffset": None,
                                "elementBytes": None, "values": []}
                continue
            comp = comps[component]
            base = comp["offset"] + element * comp["width"]
            entry = {
                "count": length,
                "component": component,
                "descriptorOffset": off,
                "elementOffset": base,
                "elementBytes": comp["width"],
                "values": [],
            }
            for k in range(length):
                at = base + k * comp["width"]
                if leaf["kind"] == "f32":
                    bits = struct.unpack_from("<I", image, at)[0]
                    entry["values"].append({
                        "value": struct.unpack("<f", struct.pack("<I", bits))[0],
                        "raw": f"{bits:08x}",
                        "imageOffset": at,
                    })
                elif leaf["kind"] == "structArray":
                    xb, yb = struct.unpack_from("<II", image, at)
                    entry["values"].append({
                        "x": struct.unpack("<f", struct.pack("<I", xb))[0],
                        "y": struct.unpack("<f", struct.pack("<I", yb))[0],
                        "xRaw": f"{xb:08x}",
                        "yRaw": f"{yb:08x}",
                        "imageOffset": at,
                    })
                else:
                    raise ValueError(f"{name}: unsupported array element")
            arrays[name] = entry
            continue
        if leaf["kind"] == "f32":
            bits = struct.unpack_from("<I", image, off)[0]
            values[name] = {
                "value": struct.unpack("<f", struct.pack("<I", bits))[0],
                "raw": f"{bits:08x}",
                "imageOffset": off,
                "fieldIndex": leaf["fieldIndex"],
                "unit": leaf["unit"],
            }
        elif leaf["kind"] == "i32":
            values[name] = {
                "value": struct.unpack_from("<i", image, off)[0],
                "raw": f"{struct.unpack_from('<I', image, off)[0]:08x}",
                "imageOffset": off,
                "fieldIndex": leaf["fieldIndex"],
                "unit": leaf["unit"],
            }
        elif leaf["kind"] == "bool":
            values[name] = {
                "value": struct.unpack_from("<I", image, off)[0],
                "raw": f"{struct.unpack_from('<I', image, off)[0]:08x}",
                "imageOffset": off,
                "fieldIndex": leaf["fieldIndex"],
                "unit": leaf["unit"],
            }
        else:
            raise ValueError(f"{name}: unsupported leaf")

    return image, values, arrays, (handle_id or 0)


def xt_source():
    """Decode racingphysics.bin and return the records plus source metadata."""
    car_xt = load_car_xt()
    import sys
    tools = str(ROOT / "tools")
    if tools not in sys.path:
        sys.path.insert(0, tools)
    from inspect_asset_layout import pak_index

    pak = GAME_DIR / PAK_REL
    index = pak_index(pak)
    entry = next(r for r in index["entries"] if r["path"] == XT_ENTRY)
    data = car_xt.extract(GAME_DIR)
    if len(data) != entry["logical_bytes"]:
        raise ValueError("racingphysics.bin extent mismatch")
    xt = car_xt.parse(data)
    by_name = {t["name"]: t["index"] for t in xt["types"]}
    car_type = by_name["RP_CarDynamics"]

    records = []
    catalog = schema_catalog(xt)
    for rec in xt["records"]:
        if rec["type"] != car_type:
            continue
        blob = car_xt._string_blob(xt, rec)
        name_off = struct.unpack_from("<I", xt["data"], rec["dataOffset"])[0]
        end = blob.find(b"\0", name_off)
        name = blob[name_off:end].decode("ascii")
        image, values, arrays, handle = decode_record(xt, rec, catalog)
        records.append({
            "index": rec["index"],
            "id": rec["id"],
            "name": name,
            "imageOffset": rec["dataOffset"],
            "imageBytes": rec["dataBytes"],
            "imageSha256": sha256_bytes(image),
            "stringBytes": rec["stringBytes"],
            "physicsParametersHandleId": handle,
            "values": values,
            "arrays": arrays,
        })

    if len(records) != 62:
        raise ValueError(f"expected 62 RP_CarDynamics records, found {len(records)}")

    source = {
        "pak": rel(pak),
        "pakEntry": entry["path"],
        "entryOffset": entry["offset"],
        "storedBytes": entry["stored_bytes"],
        "logicalBytes": entry["logical_bytes"],
        "xtSha256": sha256_bytes(data),
        "xtVersion": xt["version"],
        "recordType": "RP_CarDynamics",
        "recordTypeSize": xt["types"][car_type]["size"],
        "recordCount": len(records),
        "fieldTableCount": len(xt["fields"]),
        "typeTableCount": len(xt["types"]),
    }
    return records, source, catalog


# --------------------------------------------------------------------------- #
# body / wheel bounds
# --------------------------------------------------------------------------- #

def _manifest_body(path: Path):
    manifest = load_json(path)
    bounds = manifest.get("mesh", {}).get("bounds")
    if not bounds:
        return None
    groups = {}
    for group in manifest.get("wheelGroups", []):
        member = group.get("memberLocalBounds")
        translation = group.get("worldTransform", {}).get("translation")
        groups[group["corner"]] = {
            "restTranslation": translation,
            "memberLocalBounds": member,
            "matrixColumnMajor": group.get("worldTransform", {}).get("matrixColumnMajor"),
            "tyreProof": group.get("tyreProof") or manifest.get("tyreProofTier"),
        }
    return {
        "bounds": bounds,
        "wheelGroups": groups,
        "manifest": rel(path),
        "manifestSha256": sha256_file(path),
        "manifestKind": manifest.get("kind"),
    }


def load_body_sources(records):
    """Record name -> body AABB / mesh wheel evidence, with every source hashed."""
    vp = load_json(VP_CARS)
    staging = load_json(VP_STAGING)
    cp = load_json(CP_INDEX)
    roster = load_json(ROSTER)["roster"]["cars"]

    vp_records = {r["name"]: r for r in vp["records"]}
    staged = {r["name"]: r for r in staging["records"]}
    roster_by_name = {c["name"]: c for c in roster}

    inputs = {
        "vehiclePipelineCars": {"path": rel(VP_CARS), "sha256": sha256_file(VP_CARS)},
        "cStagingResults": {"path": rel(VP_STAGING), "sha256": sha256_file(VP_STAGING)},
        "cAliases": {"path": rel(VP_ALIASES), "sha256": sha256_file(VP_ALIASES)},
        "carPartsIndex": {"path": rel(CP_INDEX), "sha256": sha256_file(CP_INDEX)},
        "roster": {"path": rel(ROSTER), "sha256": sha256_file(ROSTER)},
    }

    out = {}
    for rec in records:
        name = rec["name"]
        slug = None
        sources = []
        body = None
        if name in roster_by_name:
            slug = roster_by_name[name]["slug"]
            path = ROOT / "_work/car-parts/cars" / slug / "manifest.json"
            if path.exists():
                body = _manifest_body(path)
                if body:
                    body["kind"] = "car-part-manifest-mesh-aabb"
                    body["axisMapping"] = dict(BODY_AXES)
                    sources.append("car-part-manifest")
        if body is None and name in staged and staged[name].get("body", {}).get("manifest"):
            path = ROOT / staged[name]["body"]["manifest"]
            if path.exists():
                body = _manifest_body(path)
                if body:
                    body["kind"] = "staged-c-alias-manifest-mesh-aabb"
                    body["axisMapping"] = dict(BODY_AXES)
                    body["cAliasManifestSha256"] = staged[name]["body"].get("manifestSha256")
                    sources.append("staged-c-alias-manifest")
        if body is None:
            scene = vp_records.get(name, {}).get("scene", {})
            if scene.get("bounds"):
                body = {
                    "bounds": scene["bounds"],
                    "wheelGroups": {},
                    "manifest": scene.get("reportPath"),
                    "manifestSha256": scene.get("reportSha256"),
                    "kind": "scene-report-aabb",
                    "axisMapping": dict(BODY_AXES),
                }
                sources.append("vehicle-pipeline-scene-report")
        if body is not None:
            body["sourceChain"] = sources
            # Where two sources exist they must agree.
            scene = vp_records.get(name, {}).get("scene", {})
            if scene.get("bounds") and "vehicle-pipeline-scene-report" not in sources:
                body["sceneBoundsCrossCheck"] = scene["bounds"]
        if slug is None:
            slug = vp_records.get(name, {}).get("slug") or staged.get(name, {}).get("slug")
        out[name] = {"slug": slug, "body": body,
                     "class": vp_records.get(name, {}).get("class"),
                     "rosterOrder": roster_by_name[name]["order"] if name in roster_by_name else None}
    return out, inputs, roster


# --------------------------------------------------------------------------- #
# derived envelope
# --------------------------------------------------------------------------- #

def _span(bounds, axis):
    index = {"x": 0, "y": 1, "z": 2}[axis]
    return bounds["max"][index] - bounds["min"][index]


def _mesh_wheels(body):
    groups = body.get("wheelGroups") or {}
    if not groups:
        return None
    corners = {}
    for corner in ("frontleft", "frontright", "backleft", "backright"):
        group = groups.get(corner)
        if not group:
            return None
        member = group.get("memberLocalBounds")
        rest = group.get("restTranslation")
        entry = {"restTranslation": rest, "tyreProof": group.get("tyreProof")}
        if member:
            entry["tyreWidth"] = member["max"][0] - member["min"][0]
            entry["tyreRadiusFromMesh"] = (
                (member["max"][1] - member["min"][1]) / 2.0
                + (member["max"][2] - member["min"][2]) / 2.0) / 2.0
        corners[corner] = entry
    fl, fr = corners["frontleft"], corners["frontright"]
    bl, br = corners["backleft"], corners["backright"]
    if all(c.get("restTranslation") for c in (fl, fr, bl, br)):
        mesh_base = abs(fl["restTranslation"][2]) + abs(bl["restTranslation"][2])
        mesh_track_front = abs(fl["restTranslation"][0]) + abs(fr["restTranslation"][0])
        mesh_track_rear = abs(bl["restTranslation"][0]) + abs(br["restTranslation"][0])
        corners["meshWheelbase"] = mesh_base
        corners["meshTrackFront"] = mesh_track_front
        corners["meshTrackRear"] = mesh_track_rear
    return corners


def derive(rec, body_info):
    values = {k: v["value"] for k, v in rec["values"].items()}

    mass = values["mass.mass"]
    wb = values["geometry.wheelBase"]
    tf = values["geometry.trackWidthFront"]
    tr = values["geometry.trackWidthRear"]
    rf = values["tyres.frontTyres.radius"]
    rr = values["tyres.rearTyres.radius"]
    up_f = values["suspension.front.movementUp"]
    down_f = values["suspension.front.movementDown"]
    up_r = values["suspension.rear.movementUp"]
    down_r = values["suspension.rear.movementDown"]

    axle_length = wb
    axle_width = max(tf, tr)
    fixed_half_len = FIXED_ENVELOPE["length"] / 2.0
    fixed_half_wid = FIXED_ENVELOPE["width"] / 2.0

    derived = {
        "axleRectangle": {
            "length": round6(axle_length),
            "width": round6(axle_width),
            "half": [round6(fixed_half_len), round6(fixed_half_wid)],
            "halfLength": round6(axle_length / 2.0),
            "halfWidth": round6(axle_width / 2.0),
            "source": "geometry.wheelBase x max(trackWidthFront, trackWidthRear)",
        },
        "harnessBodyBox": {
            "length": round6(wb),
            "width": round6(tf),
            "height": round6(2.0 * rf),
            "halfExtents": [round6(tf / 2.0), round6(rf), round6(wb / 2.0)],
            "source": "vehicle_harness.cpp:972-1000 Gravity C_BoxDesc and "
                      "Car::SetGravityBody bounds",
        },
        "wheelGeometry": {
            "frontRadius": round6(rf),
            "rearRadius": round6(rr),
            "suspensionTravelUpFront": round6(up_f),
            "suspensionTravelDownFront": round6(down_f),
            "suspensionTravelUpRear": round6(up_r),
            "suspensionTravelDownRear": round6(down_r),
            "rideHeightFront": round6(rf + up_f),
            "rideHeightRear": round6(rr + up_r),
            "casterAngleFront": round6(values["suspension.front.casterAngle"]),
            "camberAngleFront": round6(values["suspension.front.camberAngle"]),
            "toeAngleFront": round6(values["suspension.front.toeAngle"]),
            "casterAngleRear": round6(values["suspension.rear.casterAngle"]),
            "camberAngleRear": round6(values["suspension.rear.camberAngle"]),
            "toeAngleRear": round6(values["suspension.rear.toeAngle"]),
            "steerLimit": round6(values["steering.steerLimit"]),
            "ackerman": round6(values["steering.ackerman"]),
            "source": "tyres.frontTyres.radius, tyres.rearTyres.radius, "
                      "suspension.* travel/angles, steering.steerLimit/ackerman",
        },
        "fixedBoxContainsAxle": (axle_length <= FIXED_ENVELOPE["length"] + 1e-9 and
                                 axle_width <= FIXED_ENVELOPE["width"] + 1e-9),
        "fixedBoxOverflow": {
            "length": round6(max(0.0, axle_length - FIXED_ENVELOPE["length"])),
            "width": round6(max(0.0, axle_width - FIXED_ENVELOPE["width"])),
        },
    }

    delta = {
        "axleVsFixed": {
            "length": round6(axle_length - FIXED_ENVELOPE["length"]),
            "width": round6(axle_width - FIXED_ENVELOPE["width"]),
            "lengthPercent": round6((axle_length / FIXED_ENVELOPE["length"] - 1.0) * 100.0),
            "widthPercent": round6((axle_width / FIXED_ENVELOPE["width"] - 1.0) * 100.0),
        },
        "harnessBoxVsFixed": {
            "length": round6(wb - FIXED_ENVELOPE["length"]),
            "width": round6(tf - FIXED_ENVELOPE["width"]),
            "height": round6(2.0 * rf - FIXED_ENVELOPE["height"]),
        },
    }

    body = body_info.get("body") if body_info else None
    if body:
        bounds = body["bounds"]
        body_size = {
            "length": round6(_span(bounds, "z")),
            "width": round6(_span(bounds, "x")),
            "height": round6(_span(bounds, "y")),
            "min": [round6(v) for v in bounds["min"]],
            "max": [round6(v) for v in bounds["max"]],
            "axisMapping": dict(BODY_AXES),
            "kind": body["kind"],
            "manifest": body.get("manifest"),
            "manifestSha256": body.get("manifestSha256"),
            "sourceChain": body.get("sourceChain"),
        }
        if body.get("sceneBoundsCrossCheck"):
            body_size["sceneBoundsCrossCheck"] = body["sceneBoundsCrossCheck"]
        mesh_wheels = _mesh_wheels(body)
        if mesh_wheels:
            body_size["meshWheels"] = mesh_wheels
            body_size["meshWheelbase"] = round6(mesh_wheels["meshWheelbase"])
            body_size["meshTrackFront"] = round6(mesh_wheels["meshTrackFront"])
            body_size["meshTrackRear"] = round6(mesh_wheels["meshTrackRear"])
            body_size["overhangTotal"] = round6(body_size["length"] - wb)
            body_size["wheelbaseDeltaMeshVsXt"] = round6(
                mesh_wheels["meshWheelbase"] - wb)
            body_size["trackDeltaMeshVsXtFront"] = round6(
                mesh_wheels["meshTrackFront"] - tf)
            body_size["trackDeltaMeshVsXtRear"] = round6(
                mesh_wheels["meshTrackRear"] - tr)
            body_size["tyreRadiusDeltaMeshVsXt"] = round6(
                (mesh_wheels["frontleft"].get("tyreRadiusFromMesh", 0.0)
                 + mesh_wheels["frontright"].get("tyreRadiusFromMesh", 0.0)) / 2.0 - rf)
        delta["bodyVsFixed"] = {
            "length": round6(body_size["length"] - FIXED_ENVELOPE["length"]),
            "width": round6(body_size["width"] - FIXED_ENVELOPE["width"]),
            "height": round6(body_size["height"] - FIXED_ENVELOPE["height"]),
            "lengthPercent": round6((body_size["length"] / FIXED_ENVELOPE["length"] - 1.0) * 100.0),
            "widthPercent": round6((body_size["width"] / FIXED_ENVELOPE["width"] - 1.0) * 100.0),
            "heightPercent": round6((body_size["height"] / FIXED_ENVELOPE["height"] - 1.0) * 100.0),
        }
    else:
        body_size = {
            "status": "absent",
            "reason": "no car-part, staged C-alias or Scene-report mesh bounds for "
                      "this record; the body envelope is not invented",
        }

    choices = {
        "chassisFootprint": {
            "length": round6(axle_length),
            "width": round6(axle_width),
            "height": FIXED_ENVELOPE["height"],
            "basis": "geometry.wheelBase x max(trackWidthFront, trackWidthRear); "
                     "the wheel-centre rectangle",
            "status": "source-derived",
        },
        "engineBodyBox": {
            "length": round6(wb),
            "width": round6(tf),
            "height": round6(2.0 * rf),
            "basis": "vehicle_harness.cpp Gravity C_BoxDesc",
            "status": "source-derived",
        },
    }
    if "length" in body_size:
        choices["collisionUpperBound"] = {
            "length": body_size["length"],
            "width": body_size["width"],
            "height": body_size["height"],
            "basis": "visible mesh AABB (first RenderList LOD0); includes mirrors, "
                     "spoilers and any non-body detail inside the mesh bounds",
            "status": "upper-bound",
        }
        choices["recommendedCollision"] = (
            "collisionUpperBound until the retail composite collision shape is imported")
    else:
        choices["collisionUpperBound"] = {
            "status": "absent",
            "reason": body_size["reason"],
        }
        choices["recommendedCollision"] = (
            "unsupported: no body geometry for this record; do not substitute the "
            "fixed box silently")

    car = {
        "name": rec["name"],
        "index": rec["index"],
        "id": rec["id"],
        "slug": body_info.get("slug") if body_info else None,
        "class": body_info.get("class") if body_info else None,
        "rosterOrder": body_info.get("rosterOrder") if body_info else None,
        "integrationStage": (
            "integrated-batch1" if (body_info or {}).get("rosterOrder") is not None
            and body_info["rosterOrder"] < 15 else
            "staged-batch2" if (body_info or {}).get("rosterOrder") is not None else
            "not-integrated"),
        "drivetrain": ("RWD", "FWD", "AWD")[values["transmission.driveType"]]
        if values["transmission.driveType"] in (0, 1, 2) else "unknown",
        "driveType": values["transmission.driveType"],
        "record": {
            "imageOffset": rec["imageOffset"],
            "imageBytes": rec["imageBytes"],
            "imageSha256": rec["imageSha256"],
            "stringBytes": rec["stringBytes"],
            "physicsParametersHandleId": rec["physicsParametersHandleId"],
        },
        "physics": {
            "mass": {
                "value": mass,
                "raw": rec["values"]["mass.mass"]["raw"],
                "imageOffset": rec["values"]["mass.mass"]["imageOffset"],
                "fieldIndex": rec["values"]["mass.mass"]["fieldIndex"],
                "unit": rec["values"]["mass.mass"]["unit"],
            },
            "values": {k: {
                "value": v["value"],
                "raw": v["raw"],
                "imageOffset": v["imageOffset"],
                "fieldIndex": v["fieldIndex"],
                "unit": v["unit"],
            } for k, v in rec["values"].items()},
            "arrays": {k: {
                "count": a["count"],
                "component": a["component"],
                "descriptorOffset": a["descriptorOffset"],
                "elementOffset": a["elementOffset"],
                "elementBytes": a["elementBytes"],
                "values": a["values"],
            } for k, a in rec["arrays"].items()},
        },
        "derived": derived,
        "envelopeChoices": choices,
        "bodyEnvelope": body_size,
        "deltaVsFixed": delta,
    }
    return car


# --------------------------------------------------------------------------- #
# manifest
# --------------------------------------------------------------------------- #

def build_manifest():
    records, source, catalog = xt_source()
    body_sources, inputs, roster = load_body_sources(records)

    cars = [derive(rec, body_sources[rec["name"]]) for rec in records]

    def val(car, path):
        return car["physics"]["values"][path]["value"]

    def max_track(car):
        return max(val(car, "geometry.trackWidthFront"),
                   val(car, "geometry.trackWidthRear"))

    # Fixed-box derivation re-measured over the roster it was taken from (the
    # first five roster entries) and over all 62 records.
    names = [c["name"] for c in roster[:5]]
    five = [c for c in cars if c["name"] in names]
    max_wb_five = max(five, key=lambda c: val(c, "geometry.wheelBase"))
    max_track_five = max(five, key=max_track)
    max_wb_all = max(cars, key=lambda c: val(c, "geometry.wheelBase"))
    max_track_car = max(cars, key=max_track)
    max_wb_value = val(max_wb_all, "geometry.wheelBase")
    max_track_value = max_track(max_track_car)

    fixed = dict(FIXED_ENVELOPE)
    fixed.update({
        "recomputedFromFiveCarRoster": {
            "maxWheelbase": round6(val(max_wb_five, "geometry.wheelBase")),
            "maxWheelbaseRecord": max_wb_five["name"],
            "maxTrack": round6(max_track(max_track_five)),
            "maxTrackRecord": max_track_five["name"],
            "matches": (
                abs(val(max_wb_five, "geometry.wheelBase") - 2.981) < 0.005
                and abs(max_track(max_track_five) - 1.676) < 0.005
            ),
        },
        "recomputedFromAll62": {
            "maxWheelbase": round6(max_wb_value),
            "maxWheelbaseRecord": max_wb_all["name"],
            "maxTrack": round6(max_track_value),
            "maxTrackRecord": max_track_car["name"],
            "axleBoxExceedsFixed": {
                "length": round6(max_wb_value - FIXED_ENVELOPE["length"]),
                "width": round6(max_track_value - FIXED_ENVELOPE["width"]),
            },
            "carsWithAxleBoxInsideFixed": sum(
                1 for c in cars if c["derived"]["fixedBoxContainsAxle"]),
            "carsWithAxleBoxOutsideFixed": sum(
                1 for c in cars if not c["derived"]["fixedBoxContainsAxle"]),
        },
    })

    coverage = {}
    for leaf in catalog:
        path = leaf["path"]
        if path == "name":
            stored = "record.name"
        elif path == "mass.physicsParameters":
            stored = "record.physicsParametersHandleId"
        else:
            stored = "physics." + ("arrays" if path in cars[0]["physics"]["arrays"] else "values")
        entry = {
            "present": len(cars),
            "storedAs": stored,
            "unit": leaf["unit"],
            "role": leaf["role"],
            "geometryRelevant": leaf["geometryRelevant"],
            "extracted": leaf["extracted"],
        }
        if path in cars[0]["physics"]["arrays"]:
            entry["nonEmptyArrays"] = sum(
                1 for c in cars if c["physics"]["arrays"][path]["count"] > 0)
        coverage[path] = entry

    integrated = [c for c in cars if c["integrationStage"] == "integrated-batch1"]
    batch2 = [c for c in cars if c["integrationStage"] == "staged-batch2"]
    with_body = [c for c in cars if "length" in c["bodyEnvelope"]]

    manifest = {
        "kind": "blur.vehicle-physics-envelope",
        "version": 1,
        "scope": {
            "records": len(cars),
            "integratedCars": len(integrated),
            "stagedBatch2Cars": len(batch2),
            "carsWithBodyAabb": len(with_body),
            "carsWithoutBodyAabb": len(cars) - len(with_body),
            "collisionHullRecovered": False,
            "collisionBoxRecovered": False,
            "physicsExecuted": False,
            "rendererClaim": False,
            "gameClaim": False,
            "bodyShape": "visible mesh AABB upper bound; retail imports the model's "
                         "composite collision shape, which is not imported here",
        },
        "units": {
            "length": "metre",
            "mass": "kilogram",
            "angle": "radian",
            "note": "only the units the committed consumers establish are claimed; "
                    "everything else is an engine scalar with an explicit unit label",
        },
        "fixedEnvelope": fixed,
        "integration": INTEGRATION,
        "schema": {
            "leafCount": len(catalog),
            "arrayLeafCount": sum(1 for l in catalog if l["array"] or l["kind"] == "structArray"),
            "leaves": catalog,
            "missingFields": MISSING_FIELDS,
            "counts": {
                "geometryRelevant": sum(1 for l in catalog if l["geometryRelevant"]),
                "extracted": sum(1 for l in catalog if l["extracted"]),
            },
        },
        "inputs": source | {"supportingInputs": inputs},
        "coverage": coverage,
        "cars": cars,
        "summary": {
            "integrated": [
                {
                    "name": c["name"],
                    "slug": c["slug"],
                    "bodyLength": c["bodyEnvelope"].get("length"),
                    "bodyWidth": c["bodyEnvelope"].get("width"),
                    "bodyHeight": c["bodyEnvelope"].get("height"),
                    "wheelbase": c["physics"]["values"]["geometry.wheelBase"]["value"],
                    "trackFront": c["physics"]["values"]["geometry.trackWidthFront"]["value"],
                    "trackRear": c["physics"]["values"]["geometry.trackWidthRear"]["value"],
                    "tyreRadiusFront": c["physics"]["values"]["tyres.frontTyres.radius"]["value"],
                    "delta": c["deltaVsFixed"].get("bodyVsFixed"),
                }
                for c in integrated
            ],
        },
        "contentSha256": sha256_bytes(canonical(cars)),
    }
    return manifest
