#!/usr/bin/env python
"""Build the retail camera parity manifest (read-only data recovery).

Inputs (read-only):
  game-data/Blur/cache/gamedata.pak  ->  \\gamedata\\xt\\amax.bin
  _work/vehicle-pipeline/amax-vehicles.jsonl  (committed tag/record map)
  _work/e1-drive/cars.json                    (committed 5-car roster)
  _work/e1-drive/geometry.json                (committed PoC camera intrinsics)
  probes/e1-drive/web/packet-adapter.js       (read-only PoC camera constants)
  probes/render-packet/tools/build_packet.mjs (read-only PoC FOV choice)
  upstream/BlurRebuilt/...                    (read-only source citations)

Output: _work/camera/camera.json

No value is guessed: every parameter carries a provenance tag (`data`, `code` or
`provisional`), a unit and a source. Derived/provisional values carry the exact
formula. The builder is deterministic: no timestamps, sorted keys, stable JSON.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "powerups" / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402
import xt_decode  # noqa: E402

PACK = ROOT / "game-data/Blur/cache/gamedata.pak"
AMAX_PATH = "\\gamedata\\xt\\amax.bin"
OUT = ROOT / "_work/camera/camera.json"
AMAX_VEHICLES = ROOT / "_work/vehicle-pipeline/amax-vehicles.jsonl"
ROSTER_FILE = ROOT / "_work/e1-drive/cars.json"
POC_GEOMETRY = ROOT / "_work/e1-drive/geometry.json"
POC_ADAPTER = ROOT / "probes/e1-drive/web/packet-adapter.js"
POC_PACKET = ROOT / "probes/render-packet/tools/build_packet.mjs"
ROOT_PAK_INDEX = ROOT / "_work/verification/pak-reader/root.pak.json"

ROSTER = [
    ("corvette-zr1-stock", "Corvette_ZR1_Stock"),
    ("lotus-exige-cup260-stock", "Lotus_ExigeCup260_Stock"),
    ("dodge-challenger-stock", "Dodge_Challenger_Stock"),
    ("ford-focusrs-stock", "Ford_FocusRS_Stock"),
    ("audi-r8v10-stock", "Audi_R8V10_Stock"),
]

SRC_FILES = {
    "amax_chase": "upstream/BlurRebuilt/code/amax/game/Game/AmaxCam/AmaxChaseCamera.cpp",
    "amax_chase_h": "upstream/BlurRebuilt/code/amax/game/Game/AmaxCam/AmaxChaseCamera.h",
    "amax_param": "upstream/BlurRebuilt/code/amax/game/Game/AmaxCam/AmaxChaseParam.h",
    "vehicle_feed": "upstream/BlurRebuilt/code/amax/game/Game/AmaxCam/VehicleFeed.cpp",
    "vfcamera": "upstream/BlurRebuilt/code/amax/game/Game/AmaxCam/VFCamera.h",
    "vehicle_actor": "upstream/BlurRebuilt/code/amax/game/Game/GameActors/Vehicles/VehicleActor.cpp",
    "chase2": "upstream/BlurRebuilt/code/mercury/library/graphics/camera2/source/stock/ChaseCamera2.cpp",
    "chase2_h": "upstream/BlurRebuilt/code/mercury/library/graphics/camera2/include/camera2/stock/ChaseCamera2.h",
    "camera": "upstream/BlurRebuilt/code/mercury/library/graphics/camera2/source/Camera.cpp",
    "camera_h": "upstream/BlurRebuilt/code/mercury/library/graphics/camera2/include/camera2/Camera.h",
    "feed": "upstream/BlurRebuilt/code/mercury/library/graphics/camera2/source/Feed.cpp",
    "hollywood": "upstream/BlurRebuilt/code/amax/library/Kanzen/Camera/HollywoodVehicleCamera.cpp",
    "hollywood_h": "upstream/BlurRebuilt/code/amax/library/Kanzen/Camera/HollywoodVehicleCamera.h",
    "third": "upstream/BlurRebuilt/code/amax/library/Kanzen/Camera/ThirdPersonCamera.cpp",
    "utility": "upstream/BlurRebuilt/code/amax/library/Kanzen/Camera/Utility.cpp",
    "orbit": "upstream/BlurRebuilt/code/mercury/library/graphics/camera2/source/stock/OrbitCamera.cpp",
    "bolted": "upstream/BlurRebuilt/code/amax/game/Game/AmaxCam/BoltedCamera.cpp",
    "bolted_param": "upstream/BlurRebuilt/code/amax/game/Game/AmaxCam/BoltedParam.h",
    "noise": "upstream/BlurRebuilt/code/amax/game/Game/AmaxCam/CameraNoiseSpecialFX.cpp",
    "shake": "upstream/BlurRebuilt/code/mercury/library/graphics/camera2/source/stock/ShakeCamera.cpp",
}

UNITS = {
    "metres": "metres (m)",
    "degrees": "degrees (deg)",
    "degrees_per_second": "degrees per second (deg/s)",
    "radians_per_second": "radians per second (rad/s)",
    "seconds": "seconds (s)",
    "per_second": "per second (1/s)",
    "metres_per_second": "metres per second (m/s)",
    "metres_per_second_squared": "metres per second squared (m/s^2)",
    "hertz": "hertz (Hz)",
    "ratio": "dimensionless ratio",
    "count": "count",
    "seconds_squared": "seconds squared (s^2)",
    "degrees_per_acceleration": "degrees per (m/s^2)",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def decode_pak_entry(entry: dict) -> bytes:
    with PACK.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    if len(packed) != entry["stored_bytes"]:
        raise ValueError("short PAK read")
    inflater = zlib.decompressobj()
    decoded = inflater.decompress(packed, entry["logical_bytes"] + 1)
    if (len(decoded) != entry["logical_bytes"] or not inflater.eof
            or inflater.unused_data or inflater.unconsumed_tail):
        raise ValueError(f"zlib extent mismatch for {entry['path']}")
    return decoded


def source_data(flask, entry, record_index, type_name, field, field_offset=None,
                record_id=None, decoded_sha=None, note=None):
    """Data provenance object for one decoded field."""
    rec_offset = flask.tables["data"]["offset"] + sum(
        flask.records[i][2] + flask.records[i][3] for i in range(record_index))
    out = {
        "kind": "data",
        "pak": "game-data/Blur/cache/gamedata.pak",
        "entry": entry["path"],
        "entryOffset": entry["offset"],
        "entryStoredBytes": entry["stored_bytes"],
        "entryLogicalBytes": entry["logical_bytes"],
        "entryFatIndex": entry["fat_index"],
        "decodedSha256": decoded_sha,
        "recordIndex": record_index,
        "recordId": record_id if record_id is not None else flask.record_id(record_index),
        "type": type_name,
        "field": field,
        "recordDataOffset": rec_offset,
    }
    if field_offset is not None:
        out["fieldOffsetInRecord"] = field_offset
        out["fileOffset"] = rec_offset + field_offset
    if note:
        out["note"] = note
    return out


def code_source(key, line, symbol, note=None):
    path = SRC_FILES[key]
    out = {
        "kind": "code",
        "file": path,
        "fileSha256": sha256_file(ROOT / path),
        "line": line,
        "symbol": symbol,
    }
    if note:
        out["note"] = note
    return out


def param(value, unit, semantic, provenance, source, note=None, unit_note=None,
          min_value=None, max_value=None):
    out = {
        "value": value,
        "unit": unit,
        "semantic": semantic,
        "provenance": provenance,
        "source": source,
    }
    if note:
        out["note"] = note
    if unit_note:
        out["unitNote"] = unit_note
    if min_value is not None:
        out["expectedMin"] = min_value
    if max_value is not None:
        out["expectedMax"] = max_value
    return out


def data_param(flask, entry, record_index, type_name, field, value, unit,
               semantic, field_offset=None, record_id=None, decoded_sha=None,
               note=None, unit_note=None):
    return param(value, unit, semantic, "data",
                 source_data(flask, entry, record_index, type_name, field,
                             field_offset, record_id, decoded_sha, note),
                 note=note, unit_note=unit_note)


def provisional_param(value, unit, semantic, derivation, inputs, note=None,
                      tolerance=None):
    src = {"kind": "provisional", "derivation": derivation, "inputs": inputs}
    if tolerance is not None:
        src["tolerance"] = tolerance
    return param(value, unit, semantic, "provisional", src, note=note)


def smoothing_t63(smooth_time: float, dt: float = 1.0 / 60.0) -> float:
    """Exact t63 of Kanzen::SmoothingFunction (Utility.cpp:20-43)."""
    if smooth_time <= 0.01:
        return 0.0
    from_value, to_value, vel = 1.0, 0.0, 0.0
    for tick in range(1, 6000):
        omega = 2.0 / smooth_time
        x = omega * dt
        exp = 1.0 / (1.0 + x + 0.48 * x * x + 0.235 * x * x * x)
        change = from_value - to_value
        temp = (vel + omega * change) * dt
        vel = (vel - omega * temp) * exp
        update = (change + temp) * exp
        if abs(update) > abs(change) and update * change > 0.0:
            update *= abs(change) / abs(update)
            vel = 0.0
        from_value = to_value + update
        if from_value <= 0.37:
            return tick * dt
    raise ValueError("smoothing did not converge")


def first_order_t63(alpha: float, dt: float = 1.0 / 60.0) -> float:
    if not 0.0 < alpha < 1.0:
        return 0.0
    return math.log(0.37) / math.log(1.0 - alpha) * dt


def horizontal_fov(vertical_degrees: float, aspect: float = 16.0 / 9.0) -> float:
    return math.degrees(2.0 * math.atan(math.tan(math.radians(vertical_degrees) / 2.0) * aspect))


def near_clip(fov_degrees: float) -> float:
    """Cam2::CalculateNearClip (Feed.cpp:71-78): 0.1 + 0.01745/fovRad."""
    return 0.1 + 0.01745 / math.radians(fov_degrees)


def read_poc_constants() -> dict:
    adapter = POC_ADAPTER.read_text(encoding="utf-8")
    packet = POC_PACKET.read_text(encoding="utf-8")
    geometry = json.loads(POC_GEOMETRY.read_text(encoding="utf-8"))["cameraIntrinsics"]

    def grab(pattern: str, text: str, name: str) -> float:
        match = re.search(pattern, text)
        if not match:
            raise ValueError(f"PoC constant {name} not found")
        return float(match.group(1))

    distance = grab(r"this\.distance\s*=\s*options\.distance\s*\?\?\s*([0-9.]+)", adapter, "distance")
    height = grab(r"this\.height\s*=\s*options\.height\s*\?\?\s*([0-9.]+)", adapter, "height")
    look_height = grab(r"this\.lookHeight\s*=\s*options\.lookHeight\s*\?\?\s*([0-9.]+)", adapter, "lookHeight")
    smoothing = grab(r"this\.smoothing\s*=\s*options\.smoothing\s*\?\?\s*([0-9.]+)", adapter, "smoothing")
    margin = grab(r"this\.occlusionMargin\s*=\s*options\.occlusionMargin\s*\?\?\s*([0-9.]+)", adapter, "occlusionMargin")
    minimum = grab(r"this\.occlusionMinimum\s*=\s*options\.occlusionMinimum\s*\?\?\s*([0-9.]+)", adapter, "occlusionMinimum")
    recovery = grab(r"this\.occlusionRecovery\s*=\s*options\.occlusionRecovery\s*\?\?\s*([0-9.]+)", adapter, "occlusionRecovery")
    near_field = grab(r"this\.occlusionNearField\s*=\s*options\.occlusionNearField\s*\?\?\s*([0-9.]+)", adapter, "occlusionNearField")
    fov_expr = re.search(r"const\s+FOV_Y\s*=\s*Math\.PI\s*/\s*([0-9.]+)\s*;", packet)
    if not fov_expr:
        raise ValueError("PoC FOV_Y expression not found")
    fov_y = 180.0 / float(fov_expr.group(1))
    return {
        "distance": distance,
        "height": height,
        "lookHeight": look_height,
        "smoothing": smoothing,
        "occlusionMargin": margin,
        "occlusionMinimum": minimum,
        "occlusionRecovery": recovery,
        "occlusionNearField": near_field,
        "verticalFovDegrees": fov_y,
        "near": float(geometry["near"]),
        "far": float(geometry["far"]),
        "aspect": float(geometry["aspect"]),
        "adapterSha256": sha256_file(POC_ADAPTER),
        "packetSha256": sha256_file(POC_PACKET),
        "geometrySha256": sha256_file(POC_GEOMETRY),
    }


def field_offsets(flask, type_index: int) -> dict:
    return {field["name"]: field["offset"] for field in flask.all_fields(type_index)}


def build() -> dict:
    index = pak_index(PACK)
    entries = {row["path"]: row for row in index["entries"]}
    entry = entries[AMAX_PATH]
    decoded = decode_pak_entry(entry)
    decoded_sha = sha256_bytes(decoded)
    flask = xt_decode.Flask(decoded)

    if decoded_sha != "a833487bd66552ecf61b1f13790ee228b18ca8f4d76c524dcd94e44c63d1e3c7":
        raise ValueError("amax.bin decoded hash changed; update provenance")

    # Record lookup by type.
    by_type = {}
    for i in range(len(flask.records)):
        by_type.setdefault(flask.type_name(flask.record_type(i)), []).append(i)

    # Committed roster names/ids and AmaxVehicle tag map.
    roster_doc = json.loads(ROSTER_FILE.read_text(encoding="utf-8"))
    roster_rows = {row["slug"]: row for row in roster_doc["roster"]["cars"]}
    vehicle_rows = {}
    for line in AMAX_VEHICLES.read_text(encoding="utf-8").splitlines():
        if line.startswith("{"):
            row = json.loads(line)
            vehicle_rows[row["name"]] = row

    vehicle_by_record_id = {
        flask.record_id(i): i for i in by_type.get("AmaxVehicle", [])
    }

    # ---------------------------------------------------------------- defaults
    defaults_index = by_type["AmaxVehicleDefaults"][0]
    defaults = flask.decode_record(defaults_index)
    default_camera = defaults["defaultCamera"]
    default_chase_handle = default_camera["Chase"]
    default_chase_index = default_chase_handle["record"]
    default_chase = default_chase_handle["value"]
    hc_default_handle = defaults["hollywoodCamDefaults"]
    hc_default = hc_default_handle["value"]
    hc_motor_handle = defaults["hollywoodCamMotorMash"]
    hc_motor = hc_motor_handle["value"]

    accel_index = by_type["AmaxAccelEffect"][0]
    accel = flask.decode_record(accel_index)
    right_stick_index = by_type["RightStickCameraParams"][0]
    right_stick = flask.decode_record(right_stick_index)
    fov_scale_index = by_type["AmaxViewportFovScale"][0]
    fov_scale = flask.decode_record(fov_scale_index)

    shake_defs = []
    for i in by_type.get("DyCamShakeDef", []):
        rec = flask.decode_record(i)
        shake_defs.append({
            "recordIndex": i,
            "recordId": flask.record_id(i),
            "values": {
                "x": data_param(flask, entry, i, "DyCamShakeDef", "X", rec["X"], "degrees", "angle",
                                field_offsets(flask, flask.record_type(i))["X"], decoded_sha=decoded_sha),
                "y": data_param(flask, entry, i, "DyCamShakeDef", "Y", rec["Y"], "degrees", "angle",
                                field_offsets(flask, flask.record_type(i))["Y"], decoded_sha=decoded_sha),
                "z": data_param(flask, entry, i, "DyCamShakeDef", "Z", rec["Z"], "degrees", "angle",
                                field_offsets(flask, flask.record_type(i))["Z"], decoded_sha=decoded_sha),
                "frequency": data_param(flask, entry, i, "DyCamShakeDef", "Freq", rec["Freq"], "hertz", "frequency",
                                        field_offsets(flask, flask.record_type(i))["Freq"], decoded_sha=decoded_sha),
            },
        })

    # ------------------------------------------------------------- per-car map
    cars = {}
    for slug, tag in ROSTER:
        roster_row = roster_rows[slug]
        vehicle_row = vehicle_rows[tag]
        record_id = roster_row["record"]["id"]
        if vehicle_row["dynamics"]["id"] != record_id:
            raise ValueError(f"{slug}: AmaxVehicle dynamics id does not match roster record id")
        vehicle_index = vehicle_by_record_id[vehicle_row["id"]]
        vehicle = flask.decode_record(vehicle_index)
        if vehicle.get("dynamics", {}).get("refId") != record_id:
            raise ValueError(f"{slug}: decoded dynamics handle mismatch")

        camera_param = vehicle["CameraParam"]
        chase_handle = camera_param["Chase"]
        if chase_handle is None:
            chase_handle = default_chase_handle
            chase_fallback = True
        else:
            chase_fallback = False
        chase_index = chase_handle["record"]
        chase = chase_handle["value"]

        hp_handle = vehicle["hollywoodVehicleParams"]
        if hp_handle is None:
            hp_handle = hc_default_handle
            hp_fallback = True
        else:
            hp_fallback = False
        hp_index = hp_handle["record"]
        hp = hp_handle["value"]

        hp2_handle = vehicle.get("hollywoodVehicleParams2")
        hp2_index = hp2_handle["record"] if hp2_handle else None
        hp2 = hp2_handle["value"] if hp2_handle else None

        chase_offsets = field_offsets(flask, flask.record_type(chase_index))
        hp_offsets = field_offsets(flask, flask.record_type(hp_index))

        def cp(field, value, unit, semantic, offsets, index_, type_name, note=None):
            return data_param(flask, entry, index_, type_name, field, value, unit, semantic,
                              offsets[field], decoded_sha=decoded_sha, note=note)

        chase_fields = {
            "distance": cp("Distance", chase["Distance"], "metres", "distance", chase_offsets, chase_index, "AmaxChaseParam"),
            "height": cp("Height", chase["Height"], "metres", "height", chase_offsets, chase_index, "AmaxChaseParam"),
            "fov": cp("Fov", chase["Fov"], "degrees", "fov", chase_offsets, chase_index, "AmaxChaseParam"),
            "tilt": cp("Tilt", chase["Tilt"], "degrees", "tilt", chase_offsets, chase_index, "AmaxChaseParam",
                       note="Camera2::ChaseCamera2 applies DegToRad(param.tilt)*0.5 as a view tilt (ChaseCamera2.cpp:132-133)"),
            "behindSpring": cp("BehindSpring", chase["BehindSpring"], "per_second", "smoothing", chase_offsets, chase_index, "AmaxChaseParam",
                               note="Blend factor per second: drive = travel + (behind-travel)*BehindSpring*Period (ChaseCamera2.cpp:64); only used when driveFade > 0"),
            "angularLimit": cp("AngularLimit", chase["AngularLimit"], "degrees", "angle", chase_offsets, chase_index, "AmaxChaseParam"),
            "angularFade": cp("AngularFade", chase["AngularFade"], "degrees", "angle", chase_offsets, chase_index, "AmaxChaseParam"),
            "pivotZ": cp("PivotZ", chase["PivotZ"], "metres", "offset", chase_offsets, chase_index, "AmaxChaseParam"),
            "safeHeight": cp("SafeHeight", chase["SafeHeight"], "metres", "height", chase_offsets, chase_index, "AmaxChaseParam"),
        }

        hp_fields = {
            "normalFov": cp("NormalFOV", hp["NormalFOV"], "degrees", "fov", hp_offsets, hp_index, "HollywoodVehicleParams"),
            "idealDistanceNormal": cp("IdealDistanceNormal", hp["IdealDistanceNormal"], "metres", "distance", hp_offsets, hp_index, "HollywoodVehicleParams"),
            "idealDistanceAtFullAcceleration": cp("IdealDistanceAtFullAcceleration", hp["IdealDistanceAtFullAcceleration"], "metres", "distance", hp_offsets, hp_index, "HollywoodVehicleParams"),
            "idealDistanceAtFullDeceleration": cp("IdealDistanceAtFullDeceleration", hp["IdealDistanceAtFullDeceleration"], "metres", "distance", hp_offsets, hp_index, "HollywoodVehicleParams"),
            "idealDistanceAirbourne": cp("IdealDistanceAirbourne", hp["IdealDistanceAirbourne"], "metres", "distance", hp_offsets, hp_index, "HollywoodVehicleParams"),
            "idealDistanceSmoothing": cp("IdealDistanceSmoothing", hp["IdealDistanceSmoothing"], "seconds", "smoothing", hp_offsets, hp_index, "HollywoodVehicleParams"),
            "idealDistanceSmoothingAccelerating": cp("IdealDistanceSmoothingAccelerating", hp["IdealDistanceSmoothingAccelerating"], "seconds", "smoothing", hp_offsets, hp_index, "HollywoodVehicleParams"),
            "idealDistanceSmoothingDecelerating": cp("IdealDistanceSmoothingDecelerating", hp["IdealDistanceSmoothingDecelerating"], "seconds", "smoothing", hp_offsets, hp_index, "HollywoodVehicleParams"),
            "idealPitch": cp("IdealPitch", hp["IdealPitch"], "degrees", "pitch", hp_offsets, hp_index, "HollywoodVehicleParams",
                             note="Data value is in degrees (surrounding params are degrees). This source revision passes it raw to SetIdealPitch (HollywoodVehicleCamera.cpp:863), whose range is radians (ThirdPersonCamera.cpp:385-389); the derived eye height/look-down is provisional pending a retail binary check."),
            "idealBaseY": cp("IdealBase", hp["IdealBase"]["vy"], "metres", "height", hp_offsets, hp_index, "HollywoodVehicleParams",
                             note="IdealBase.vy (inline Vec3 +4 bytes)"),
            "lookAtY": cp("LookAtPos", hp["LookAtPos"]["vy"], "metres", "height", hp_offsets, hp_index, "HollywoodVehicleParams",
                          note="LookAtPos.vy (inline Vec3 +4 bytes)"),
            "lookAtZ": cp("LookAtPos", hp["LookAtPos"]["vz"], "metres", "offset", hp_offsets, hp_index, "HollywoodVehicleParams",
                          note="LookAtPos.vz (inline Vec3 +8 bytes): forward look-ahead"),
            "pitchDampingNormal": cp("PitchDampingNormal", hp["PitchDampingNormal"], "seconds", "smoothing", hp_offsets, hp_index, "HollywoodVehicleParams"),
            "yawDampingNormal": cp("YawDampingNormal", hp["YawDampingNormal"], "seconds", "smoothing", hp_offsets, hp_index, "HollywoodVehicleParams"),
            "lookAtSmoothing": cp("LookAtSmoothingValue", hp["LookAtSmoothingValue"], "seconds", "smoothing", hp_offsets, hp_index, "HollywoodVehicleParams"),
            "maxAcceleration": cp("MaxAcceleration", hp["MaxAcceleration"], "metres_per_second_squared", "acceleration", hp_offsets, hp_index, "HollywoodVehicleParams"),
            "maxDeceleration": cp("MaxDeceleration", hp["MaxDeceleration"], "metres_per_second_squared", "acceleration", hp_offsets, hp_index, "HollywoodVehicleParams"),
            "highSpeedFovMultiplier": cp("HighSpeedFovMultiplier", hp["HighSpeedFovMultiplier"], "ratio", "ratio", hp_offsets, hp_index, "HollywoodVehicleParams",
                                         note="Only applied when m_highSpeed is true; the committed source never sets m_highSpeed (HollywoodVehicleCamera.cpp:153,1477,1545,1577). Data-only."),
        }

        # Nested Vec3 fields: the decoded value lives at a sub-path of the
        # serialized struct field.
        hp_fields["idealBaseY"]["source"]["valuePath"] = "IdealBase.vy"
        hp_fields["lookAtY"]["source"]["valuePath"] = "LookAtPos.vy"
        hp_fields["lookAtZ"]["source"]["valuePath"] = "LookAtPos.vz"

        # Derived geometry for the orbit mapping (provisional).
        pitch_rad = math.radians(hp["IdealPitch"])
        eye_height = hp["IdealBase"]["vy"] + hp["IdealDistanceNormal"] * math.sin(pitch_rad)
        horizontal_distance = hp["IdealDistanceNormal"] * math.cos(pitch_rad)
        height_above_aim = eye_height - hp["LookAtPos"]["vy"]
        look_down = math.degrees(math.atan2(height_above_aim,
                                            horizontal_distance + hp["LookAtPos"]["vz"]))
        t63_distance = smoothing_t63(hp["IdealDistanceSmoothing"])
        t63_yaw = smoothing_t63(hp["YawDampingNormal"])
        t63_pitch = smoothing_t63(hp["PitchDampingNormal"])
        t63_look = smoothing_t63(hp["LookAtSmoothingValue"])

        cars[slug] = {
            "slug": slug,
            "tag": tag,
            "amaxVehicle": {
                "recordIndex": vehicle_index,
                "recordId": flask.record_id(vehicle_index),
                "dynamicsHandle": {
                    "refIndex": vehicle["dynamics"]["refIndex"],
                    "refId": vehicle["dynamics"]["refId"],
                    "recordIndex": vehicle["dynamics"].get("record"),
                    "unloaded": vehicle["dynamics"].get("unloaded", False),
                    "type": vehicle["dynamics"]["typeName"],
                },
                "cameraParamFieldOffset": field_offsets(flask, flask.record_type(vehicle_index))["CameraParam"],
            },
            "normalChase": {
                "paramsRecord": {
                    "index": hp_index,
                    "id": hp_handle["refId"],
                    "type": "HollywoodVehicleParams",
                    "usedFallback": hp_fallback,
                },
                "fields": hp_fields,
                "derived": {
                    "eyeHeightAboveCar": provisional_param(
                        eye_height, "metres", "height",
                        "IdealBase.vy + IdealDistanceNormal * sin(deg2rad(IdealPitch))",
                        ["normalChase.fields.idealBaseY", "normalChase.fields.idealDistanceNormal",
                         "normalChase.fields.idealPitch"],
                        note="Provisional because the source revision's SetIdealPitch unit disagrees with the data unit; see idealPitch note."),
                    "horizontalDistance": provisional_param(
                        horizontal_distance, "metres", "distance",
                        "IdealDistanceNormal * cos(deg2rad(IdealPitch))",
                        ["normalChase.fields.idealDistanceNormal", "normalChase.fields.idealPitch"],
                        note="Orbit-mapped horizontal distance; provisional for the same pitch-unit reason."),
                    "heightAboveAim": provisional_param(
                        height_above_aim, "metres", "height",
                        "eyeHeightAboveCar - LookAtPos.vy",
                        ["normalChase.derived.eyeHeightAboveCar", "normalChase.fields.lookAtY"],
                        note="Orbit-mapped height above the aim point; provisional for the same pitch-unit reason."),
                    "lookDownAngle": provisional_param(
                        look_down, "degrees", "pitch",
                        "atan2(eyeHeightAboveCar - LookAtPos.vy, horizontalDistance + LookAtPos.vz)",
                        ["normalChase.derived.heightAboveAim", "normalChase.derived.horizontalDistance",
                         "normalChase.fields.lookAtZ"],
                        note="Straight-line rest value; provisional for the same pitch-unit reason."),
                    "t63Distance": provisional_param(
                        t63_distance, "seconds", "smoothing",
                        "exact Kanzen::SmoothingFunction t63 at 60 Hz (Utility.cpp:20-43)",
                        ["normalChase.fields.idealDistanceSmoothing"]),
                    "t63Yaw": provisional_param(
                        t63_yaw, "seconds", "smoothing",
                        "exact Kanzen::SmoothingFunction t63 at 60 Hz (Utility.cpp:20-43)",
                        ["normalChase.fields.yawDampingNormal"]),
                    "t63Pitch": provisional_param(
                        t63_pitch, "seconds", "smoothing",
                        "exact Kanzen::SmoothingFunction t63 at 60 Hz (Utility.cpp:20-43)",
                        ["normalChase.fields.pitchDampingNormal"]),
                    "t63LookAt": provisional_param(
                        t63_look, "seconds", "smoothing",
                        "exact Kanzen::SmoothingFunction t63 at 60 Hz (Utility.cpp:20-43)",
                        ["normalChase.fields.lookAtSmoothing"]),
                },
                "debugVariant": None if hp2 is None else {
                    "paramsRecord": {"index": hp2_index, "id": hp2_handle["refId"], "type": "HollywoodVehicleParams"},
                    "normalFov": data_param(flask, entry, hp2_index, "HollywoodVehicleParams", "NormalFOV", hp2["NormalFOV"], "degrees", "fov",
                                            hp_offsets["NormalFOV"], decoded_sha=decoded_sha, note="debugIndex 1 only"),
                    "idealDistanceNormal": data_param(flask, entry, hp2_index, "HollywoodVehicleParams", "IdealDistanceNormal", hp2["IdealDistanceNormal"], "metres", "distance",
                                                       hp_offsets["IdealDistanceNormal"], decoded_sha=decoded_sha, note="debugIndex 1 only"),
                    "idealBaseY": data_param(flask, entry, hp2_index, "HollywoodVehicleParams", "IdealBase", hp2["IdealBase"]["vy"], "metres", "height",
                                              hp_offsets["IdealBase"], decoded_sha=decoded_sha, note="debugIndex 1 only"),
                    "idealPitch": data_param(flask, entry, hp2_index, "HollywoodVehicleParams", "IdealPitch", hp2["IdealPitch"], "degrees", "pitch",
                                              hp_offsets["IdealPitch"], decoded_sha=decoded_sha, note="debugIndex 1 only"),
                },
            },
            "legacyChase": {
                "paramsRecord": {
                    "index": chase_index,
                    "id": chase_handle["refId"],
                    "type": "AmaxChaseParam",
                    "usedFallback": chase_fallback,
                },
                "fields": chase_fields,
                "derived": {
                    "orbitDistance": provisional_param(
                        math.hypot(chase["Distance"], chase["Height"]), "metres", "distance",
                        "hypot(Distance, Height)", ["legacyChase.fields.distance", "legacyChase.fields.height"]),
                    "orbitElevation": provisional_param(
                        math.degrees(math.atan2(chase["Height"], chase["Distance"])), "degrees", "pitch",
                        "atan2(Height, Distance)", ["legacyChase.fields.height", "legacyChase.fields.distance"]),
                    "perTickAlpha": provisional_param(
                        chase["BehindSpring"] / 60.0, "ratio", "smoothingAlpha",
                        "BehindSpring / 60", ["legacyChase.fields.behindSpring"],
                        note="Only when driveFade > 0; not a general per-tick alpha at standstill."),
                    "t63WhenActive": provisional_param(
                        first_order_t63(chase["BehindSpring"] / 60.0), "seconds", "smoothing",
                        "first-order equivalent of BehindSpring/60 per tick",
                        ["legacyChase.derived.perTickAlpha"],
                        note="Only when driveFade > 0; the legacy camera follows the trail at low angular speed."),
                },
                "collision": {
                    "traceMargin": param(0.2, "metres", "distance", "code",
                                         code_source("chase2", 119, "C_ChaseCamera2::OnUpdate DeferredTrace/RayTrace margin"),
                                         note="DeferredTrace(safe, want, 0.2f); RayTrace(safe, want, 0.2f)"),
                    "safeHeight": chase_fields["safeHeight"],
                    "nearFieldHold": param(False, "ratio", "ratio", "code",
                                           code_source("chase2", 126, "C_ChaseCamera2::OnUpdate trace clamp"),
                                           note="trace in [0,1] is applied directly; no near-field hold"),
                },
            },
            "bumper": {
                "bonnet": {
                    "position": {
                        "x": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Bonnet.Position.vx", camera_param["Bonnet"]["Position"]["vx"], "metres", "offset", decoded_sha=decoded_sha),
                        "y": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Bonnet.Position.vy", camera_param["Bonnet"]["Position"]["vy"], "metres", "offset", decoded_sha=decoded_sha),
                        "z": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Bonnet.Position.vz", camera_param["Bonnet"]["Position"]["vz"], "metres", "offset", decoded_sha=decoded_sha),
                    },
                    "fov": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Bonnet.Fov", camera_param["Bonnet"]["Fov"], "degrees", "fov", decoded_sha=decoded_sha),
                },
                "bumper": {
                    "position": {
                        "x": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Bumper.Position.vx", camera_param["Bumper"]["Position"]["vx"], "metres", "offset", decoded_sha=decoded_sha),
                        "y": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Bumper.Position.vy", camera_param["Bumper"]["Position"]["vy"], "metres", "offset", decoded_sha=decoded_sha),
                        "z": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Bumper.Position.vz", camera_param["Bumper"]["Position"]["vz"], "metres", "offset", decoded_sha=decoded_sha),
                    },
                    "fov": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Bumper.Fov", camera_param["Bumper"]["Fov"], "degrees", "fov", decoded_sha=decoded_sha),
                },
            },
            "hoodAndDash": {
                "hood": {
                    "position": {
                        "x": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Bonnet.Position.vx", camera_param["Bonnet"]["Position"]["vx"], "metres", "offset", decoded_sha=decoded_sha),
                        "y": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Bonnet.Position.vy", camera_param["Bonnet"]["Position"]["vy"], "metres", "offset", decoded_sha=decoded_sha),
                        "z": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Bonnet.Position.vz", camera_param["Bonnet"]["Position"]["vz"], "metres", "offset", decoded_sha=decoded_sha),
                    },
                    "fov": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Bonnet.Fov", camera_param["Bonnet"]["Fov"], "degrees", "fov", decoded_sha=decoded_sha),
                },
                "dash": {
                    "rangeX": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Dash.RangeX", camera_param["Dash"]["RangeX"], "metres", "range", decoded_sha=decoded_sha),
                    "rangeY": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Dash.RangeY", camera_param["Dash"]["RangeY"], "metres", "range", decoded_sha=decoded_sha),
                    "headY": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Dash.HeadY", camera_param["Dash"]["HeadY"], "metres", "offset", decoded_sha=decoded_sha),
                    "offsetZ": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Dash.OffsetZ", camera_param["Dash"]["OffsetZ"], "metres", "offset", decoded_sha=decoded_sha),
                    "headOrient": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Dash.HeadOrient", camera_param["Dash"]["HeadOrient"], "degrees", "pitch", decoded_sha=decoded_sha),
                    "dashFov": data_param(flask, entry, vehicle_index, "AmaxVehicleFeedParam", "Dash.DashFov", camera_param["Dash"]["DashFov"], "degrees", "fov", decoded_sha=decoded_sha),
                },
            },
        }

    # Nested debug-variant Vec3 path.
    for slug, _ in ROSTER:
        debug = cars[slug]["normalChase"].get("debugVariant")
        if debug:
            debug["idealBaseY"]["source"]["valuePath"] = "IdealBase.vy"

    # ------------------------------------------------------- code/data defaults
    def cp_code(value, unit, semantic, key, line, symbol, note=None):
        return param(value, unit, semantic, "code", code_source(key, line, symbol, note))

    code_defaults = {
        "amaxChaseParamConstructor": {
            "distance": cp_code(4.65, "metres", "distance", "amax_chase", 187, "C_AmaxChaseParam::C_AmaxChaseParam m_Distance"),
            "height": cp_code(1.4, "metres", "height", "amax_chase", 188, "C_AmaxChaseParam::C_AmaxChaseParam m_Height"),
            "fov": cp_code(55.0, "degrees", "fov", "amax_chase", 189, "C_AmaxChaseParam::C_AmaxChaseParam m_Fov"),
            "tilt": cp_code(-8.0, "degrees", "tilt", "amax_chase", 190, "C_AmaxChaseParam::C_AmaxChaseParam m_Tilt"),
            "behindSpring": cp_code(5.5, "per_second", "smoothing", "amax_chase", 191, "C_AmaxChaseParam::C_AmaxChaseParam m_BehindSpring"),
            "angularLimit": cp_code(180.0, "degrees", "angle", "amax_chase", 192, "C_AmaxChaseParam::C_AmaxChaseParam m_AngularLimit"),
            "angularFade": cp_code(40.0, "degrees", "angle", "amax_chase", 193, "C_AmaxChaseParam::C_AmaxChaseParam m_AngularFade"),
            "pivotZ": cp_code(0.0, "metres", "offset", "amax_chase", 194, "C_AmaxChaseParam::C_AmaxChaseParam m_PivotZ"),
            "safeHeight": cp_code(0.7, "metres", "height", "amax_chase", 195, "C_AmaxChaseParam::C_AmaxChaseParam m_SafeHeight"),
        },
        "chaseParamConstructor": {
            "distance": cp_code(5.0, "metres", "distance", "chase2", 208, "C_ChaseParam::C_ChaseParam distance"),
            "height": cp_code(1.5, "metres", "height", "chase2", 209, "C_ChaseParam::C_ChaseParam height"),
            "fov": cp_code(60.0, "degrees", "fov", "chase2", 210, "C_ChaseParam::C_ChaseParam fov"),
            "tilt": cp_code(-8.0, "degrees", "tilt", "chase2", 211, "C_ChaseParam::C_ChaseParam tilt"),
            "lag": cp_code(0.1, "seconds", "smoothing", "chase2", 212, "C_ChaseParam::C_ChaseParam lag",
                           note="Declared but not read by C_ChaseCamera2::OnUpdate; do not use as a smoothing constant."),
            "behindSpring": cp_code(3.0, "per_second", "smoothing", "chase2", 215, "C_ChaseParam::C_ChaseParam behindSpring"),
            "angularLimit": cp_code(120.0, "degrees", "angle", "chase2", 216, "C_ChaseParam::C_ChaseParam angularLimit"),
            "angularFade": cp_code(40.0, "degrees", "angle", "chase2", 217, "C_ChaseParam::C_ChaseParam angularFade"),
            "safeHeight": cp_code(0.7, "metres", "height", "chase2", 218, "C_ChaseParam::C_ChaseParam safeHeight"),
        },
        "cameraBase": {
            "defaultFov": cp_code(60.0, "degrees", "fov", "camera", 34, "C_Camera::C_Camera SetFov(DegToRad(60.f))"),
            "nearClip": cp_code(0.0, "metres", "near", "camera", 35, "C_Camera::C_Camera m_NearClip"),
            "farClip": cp_code(4000.0, "metres", "far", "camera", 36, "C_Camera::C_Camera m_FarClip"),
        },
        "nearClipFormula": cp_code(0.1, "metres", "offset", "feed", 74, "CalculateNearClip base 0.1f",
                                   note="near = 0.1 + 0.01745/fovRad when camera near clip is 0 (Feed.cpp:71-78)"),
        "boltedParam": cp_code(58.0, "degrees", "fov", "bolted", 150, "C_BoltedParam::C_BoltedParam m_Fov"),
        "boltedCameraFallbackFov": cp_code(60.0, "degrees", "fov", "bolted", 92, "C_BoltedCamera::OnUpdate fallback DegToRad(60.f)"),
        "bumperHeightOffset": cp_code(0.1, "metres", "offset", "vehicle_feed", 42, "g_debugGlobalBumperCamHeightOffset"),
        "hollywoodTraceMargin": cp_code(0.35, "metres", "distance", "hollywood", 1157, "C_HollywoodVehicleCamera::OnUpdate RayTrace margin"),
        "maxDistanceFactor": cp_code(2.0, "ratio", "ratio", "hollywood", 226, "m_MaxDistanceSmoothData.targetValue = IdealDistanceNormal*2"),
    }

    # ---------------------------------------------------------- mode containers
    normal_cars = {slug: cars[slug]["normalChase"] | {
        "slug": slug, "tag": cars[slug]["tag"], "amaxVehicle": cars[slug]["amaxVehicle"]
    } for slug, _ in ROSTER}
    legacy_cars = {slug: cars[slug]["legacyChase"] | {
        "slug": slug, "tag": cars[slug]["tag"], "amaxVehicle": cars[slug]["amaxVehicle"]
    } for slug, _ in ROSTER}
    bumper_cars = {slug: cars[slug]["bumper"] | {
        "slug": slug, "tag": cars[slug]["tag"], "amaxVehicle": cars[slug]["amaxVehicle"]
    } for slug, _ in ROSTER}
    hood_cars = {slug: cars[slug]["hoodAndDash"] | {
        "slug": slug, "tag": cars[slug]["tag"], "amaxVehicle": cars[slug]["amaxVehicle"]
    } for slug, _ in ROSTER}

    # Single-profile check for the legacy chase (all five values identical).
    legacy_values = {
        key: [legacy_cars[slug]["fields"][key]["value"] for slug, _ in ROSTER]
        for key in legacy_cars[ROSTER[0][0]]["fields"]
    }
    legacy_single = all(len(set(vals)) == 1 for vals in legacy_values.values())

    # Replay/cinematic packs from the committed root.pak index.
    root_index = json.loads(ROOT_PAK_INDEX.read_text(encoding="utf-8"))
    camera_cycles = sorted(
        row["path"] for row in root_index["entries"]
        if row["path"].startswith("\\animations\\cameras\\") and row["path"].endswith(".cycle")
    )
    animated_sequences = len(by_type.get("AnimatedCameraSequence", []))

    # --------------------------------------------------------------- PoC values
    poc_raw = read_poc_constants()
    poc_orbit = math.hypot(poc_raw["distance"], poc_raw["height"])
    poc_pitch = math.degrees(math.asin(poc_raw["height"] / poc_orbit))
    poc_eye = poc_raw["lookHeight"] + poc_raw["height"]
    poc_t63 = first_order_t63(poc_raw["smoothing"])
    poc_hfov = horizontal_fov(poc_raw["verticalFovDegrees"], poc_raw["aspect"])

    poc = {
        "source": {
            "adapter": "probes/e1-drive/web/packet-adapter.js",
            "adapterSha256": poc_raw["adapterSha256"],
            "packetBuilder": "probes/render-packet/tools/build_packet.mjs",
            "packetBuilderSha256": poc_raw["packetSha256"],
            "geometry": "_work/e1-drive/geometry.json",
            "geometrySha256": poc_raw["geometrySha256"],
        },
        "distance": param(poc_raw["distance"], "metres", "distance", "code", {
            "kind": "code", "file": "probes/e1-drive/web/packet-adapter.js",
            "fileSha256": poc_raw["adapterSha256"], "line": 150, "symbol": "ChaseCamera.distance"}),
        "height": param(poc_raw["height"], "metres", "height", "code", {
            "kind": "code", "file": "probes/e1-drive/web/packet-adapter.js",
            "fileSha256": poc_raw["adapterSha256"], "line": 151, "symbol": "ChaseCamera.height"}),
        "lookHeight": param(poc_raw["lookHeight"], "metres", "height", "code", {
            "kind": "code", "file": "probes/e1-drive/web/packet-adapter.js",
            "fileSha256": poc_raw["adapterSha256"], "line": 152, "symbol": "ChaseCamera.lookHeight"}),
        "smoothing": param(poc_raw["smoothing"], "ratio", "smoothingAlpha", "code", {
            "kind": "code", "file": "probes/e1-drive/web/packet-adapter.js",
            "fileSha256": poc_raw["adapterSha256"], "line": 153, "symbol": "ChaseCamera.smoothing per-tick alpha"}),
        "occlusionMargin": param(poc_raw["occlusionMargin"], "metres", "distance", "code", {
            "kind": "code", "file": "probes/e1-drive/web/packet-adapter.js",
            "fileSha256": poc_raw["adapterSha256"], "line": 162, "symbol": "ChaseCamera.occlusionMargin"}),
        "occlusionMinimum": param(poc_raw["occlusionMinimum"], "metres", "distance", "code", {
            "kind": "code", "file": "probes/e1-drive/web/packet-adapter.js",
            "fileSha256": poc_raw["adapterSha256"], "line": 165, "symbol": "ChaseCamera.occlusionMinimum"}),
        "occlusionRecovery": param(poc_raw["occlusionRecovery"], "ratio", "smoothingAlpha", "code", {
            "kind": "code", "file": "probes/e1-drive/web/packet-adapter.js",
            "fileSha256": poc_raw["adapterSha256"], "line": 166, "symbol": "ChaseCamera.occlusionRecovery per tick"}),
        "occlusionNearField": param(poc_raw["occlusionNearField"], "metres", "distance", "code", {
            "kind": "code", "file": "probes/e1-drive/web/packet-adapter.js",
            "fileSha256": poc_raw["adapterSha256"], "line": 172, "symbol": "ChaseCamera.occlusionNearField"}),
        "verticalFov": param(poc_raw["verticalFovDegrees"], "degrees", "fov", "code", {
            "kind": "code", "file": "probes/render-packet/tools/build_packet.mjs",
            "fileSha256": poc_raw["packetSha256"], "line": 36, "symbol": "FOV_Y = Math.PI / 4"}),
        "near": param(poc_raw["near"], "metres", "near", "code", {
            "kind": "code", "file": "_work/e1-drive/geometry.json",
            "fileSha256": poc_raw["geometrySha256"], "line": None, "symbol": "cameraIntrinsics.near"}),
        "far": param(poc_raw["far"], "metres", "far", "code", {
            "kind": "code", "file": "_work/e1-drive/geometry.json",
            "fileSha256": poc_raw["geometrySha256"], "line": None, "symbol": "cameraIntrinsics.far"}),
        "aspect": param(poc_raw["aspect"], "ratio", "aspect", "code", {
            "kind": "code", "file": "_work/e1-drive/geometry.json",
            "fileSha256": poc_raw["geometrySha256"], "line": None, "symbol": "cameraIntrinsics.aspect"}),
        "derived": {
            "orbitDistance": provisional_param(poc_orbit, "metres", "distance",
                                                "hypot(distance, height)", ["poc.distance", "poc.height"]),
            "orbitPitch": provisional_param(poc_pitch, "degrees", "pitch",
                                             "asin(height / hypot(distance, height)) in degrees",
                                             ["poc.distance", "poc.height"]),
            "eyeHeightAboveCar": provisional_param(poc_eye, "metres", "height",
                                                    "lookHeight + height", ["poc.lookHeight", "poc.height"]),
            "lookAhead": provisional_param(0.0, "metres", "offset",
                                            "no look-ahead in ChaseCamera.update(); target = position + lookHeight",
                                            ["probes/e1-drive/web/packet-adapter.js:237"]),
            "t63": provisional_param(poc_t63, "seconds", "smoothing",
                                      "first-order t63 of a per-tick alpha: ln(0.37)/ln(1-alpha)*dt",
                                      ["poc.smoothing"]),
            "horizontalFov": provisional_param(poc_hfov, "degrees", "fov",
                                                "2*atan(tan(vFov/2)*aspect)", ["poc.verticalFov", "poc.aspect"]),
        },
    }

    # --------------------------------------------------------------- comparison
    corvette = cars["corvette-zr1-stock"]
    c_norm = corvette["normalChase"]
    c_leg = corvette["legacyChase"]
    c_norm_f = c_norm["fields"]
    c_leg_f = c_leg["fields"]
    c_norm_d = c_norm["derived"]
    c_leg_d = c_leg["derived"]

    def cmp(poc_param, retail_param, unit, semantic, derivation):
        poc_value = poc_param["value"]
        retail_value = retail_param["value"]
        return {
            "poc": poc_param,
            "retail": retail_param,
            "delta": provisional_param(retail_value - poc_value, unit, semantic,
                                       derivation, ["comparison.poc", "comparison.retail"]),
        }

    comparison = {
        "basis": "Corvette ZR1 + River 0-100 m; primary basis is the normal Hollywood chase (GetHollywoodCameraParams(0)); legacy AmaxChaseParam is shown separately because it is the only complete orbit record and is what the PoC orbit most closely models.",
        "standstill": {
            "fov": cmp(poc["verticalFov"], c_norm_f["normalFov"], "degrees", "fov",
                        "retail - poc"),
            "distance": cmp(poc["distance"], c_norm_d["horizontalDistance"], "metres", "distance",
                             "retail horizontal - poc horizontal"),
            "height": cmp(poc["derived"]["eyeHeightAboveCar"], c_norm_d["eyeHeightAboveCar"], "metres", "height",
                          "retail eye above car - poc eye above car"),
            "pitch": cmp(poc["derived"]["orbitPitch"], c_norm_d["lookDownAngle"], "degrees", "pitch",
                         "retail look-down - poc look-down"),
            "smoothing": cmp(poc["derived"]["t63"], c_norm_d["t63Yaw"], "seconds", "smoothing",
                             "retail yaw t63 - poc yaw t63"),
        },
        "at30mps": {
            "fov": cmp(poc["verticalFov"], c_norm_f["normalFov"], "degrees", "fov",
                        "30 m/s = 108 km/h, below the dormant high-speed threshold; retail FOV stays NormalFOV"),
            "distance": cmp(poc["distance"], c_norm_f["idealDistanceNormal"], "metres", "distance",
                             "constant 30 m/s (accel ~0): retail IdealDistanceNormal; full accel 5.1 m / full decel 4.8 m"),
            "height": cmp(poc["derived"]["eyeHeightAboveCar"], c_norm_d["eyeHeightAboveCar"], "metres", "height",
                          "retail eye above car - poc eye above car"),
            "pitch": cmp(poc["derived"]["orbitPitch"], c_norm_d["lookDownAngle"], "degrees", "pitch",
                         "retail look-down - poc look-down"),
            "smoothing": cmp(poc["derived"]["t63"], c_norm_d["t63Yaw"], "seconds", "smoothing",
                             "retail yaw t63 - poc yaw t63; smoothing is not speed-dependent"),
        },
        "legacyStandstill": {
            "fov": cmp(poc["verticalFov"], c_leg_f["fov"], "degrees", "fov", "retail - poc"),
            "distance": cmp(poc["distance"], c_leg_f["distance"], "metres", "distance", "retail - poc"),
            "height": cmp(poc["derived"]["eyeHeightAboveCar"], c_leg_f["height"], "metres", "height", "retail - poc"),
            "pitch": cmp(poc["derived"]["orbitPitch"], c_leg_d["orbitElevation"], "degrees", "pitch", "retail orbit elevation - poc orbit pitch"),
            "smoothing": cmp(poc["derived"]["t63"], c_leg_d["t63WhenActive"], "seconds", "smoothing", "retail derived t63 - poc t63; active only above AngularLimit"),
        },
        "angularSizeRatio": {
            "normal": provisional_param(
                (c_norm_d["horizontalDistance"]["value"] * math.tan(math.radians(c_norm_f["normalFov"]["value"]) / 2.0)) /
                (poc_raw["distance"] * math.tan(math.radians(poc_raw["verticalFovDegrees"]) / 2.0)),
                "ratio", "ratio",
                "retail distance*tan(retailFov/2) / poc distance*tan(pocFov/2)",
                ["comparison.standstill.distance", "comparison.standstill.fov"],
                note="<1 means the car is smaller in the PoC frame at equal world size."),
            "legacy": provisional_param(
                (c_leg_f["distance"]["value"] * math.tan(math.radians(c_leg_f["fov"]["value"]) / 2.0)) /
                (poc_raw["distance"] * math.tan(math.radians(poc_raw["verticalFovDegrees"]) / 2.0)),
                "ratio", "ratio",
                "retail distance*tan(retailFov/2) / poc distance*tan(pocFov/2)",
                ["comparison.legacyStandstill.distance", "comparison.legacyStandstill.fov"],
                note="<1 means the car is smaller in the PoC frame at equal world size."),
        },
        "accelerationDistance": {
            "fullAcceleration": c_norm_f["idealDistanceAtFullAcceleration"],
            "fullDeceleration": c_norm_f["idealDistanceAtFullDeceleration"],
            "note": "Hollywood distance reacts to longitudinal acceleration, not speed; thresholds +0.1 / -0.1 m/s^2 (HollywoodVehicleCamera.cpp:94-95). PoC distance is constant.",
        },
        "speedFov": {
            "normalFov": c_norm_f["normalFov"],
            "highSpeedMultiplier": c_norm_f["highSpeedFovMultiplier"],
            "note": "The multiplier is data, but the committed source never sets m_highSpeed, so it is not applied. The serialized 199/200 thresholds have an unresolved unit; do not use them as a 30 m/s curve.",
        },
    }

    # ------------------------------------------------------------------- patch
    patch = {
        "primary": {
            "mode": "normalChaseHollywood",
            "car": "corvette-zr1-stock",
            "note": "Exact orbit mapping of the normal Hollywood chase onto the PoC ChaseCamera. lookAhead and separate yaw/pitch smoothing require code changes (the current ChaseCamera has one smoothing field and no look-ahead).",
            "distance": provisional_param(c_norm_d["horizontalDistance"]["value"], "metres", "distance",
                                          "IdealDistanceNormal*cos(deg2rad(IdealPitch))",
                                          ["normalChase.fields.idealDistanceNormal", "normalChase.fields.idealPitch"]),
            "height": provisional_param(c_norm_d["heightAboveAim"]["value"], "metres", "height",
                                         "eyeHeightAboveCar - LookAtPos.vy",
                                         ["normalChase.derived.eyeHeightAboveCar", "normalChase.fields.lookAtY"]),
            "lookHeight": param(1.0, "metres", "height", "provisional",
                                {"kind": "provisional", "derivation": "keep the PoC aim point at car+1.0 m; matches Corvette LookAtPos.vy", "inputs": ["normalChase.fields.lookAtY"]}),
            "lookAhead": param(1.0, "metres", "offset", "provisional",
                               {"kind": "provisional", "derivation": "LookAtPos.vz", "inputs": ["normalChase.fields.lookAtZ"]}),
            "verticalFov": param(c_norm_f["normalFov"]["value"], "degrees", "fov", "data",
                                 c_norm_f["normalFov"]["source"]),
            "near": provisional_param(near_clip(c_norm_f["normalFov"]["value"]), "metres", "near",
                                      "0.1 + 0.01745/deg2rad(fov) (Feed.cpp:71-78)",
                                      ["normalChase.fields.normalFov"]),
            "far": param(4000.0, "metres", "far", "code",
                         code_source("camera", 36, "C_Camera::C_Camera m_FarClip = 4000.f")),
            "yawSmoothingAlpha": provisional_param(
                1.0 - math.exp(-(1.0 / 60.0) / (c_norm_d["t63Yaw"]["value"] / math.log(1.0 / 0.37))),
                "ratio", "smoothingAlpha",
                "first-order alpha matching retail yaw t63: 1-exp(-dt/tau), tau=t63/ln(1/0.37)",
                ["normalChase.derived.t63Yaw"]),
            "pitchSmoothingAlpha": provisional_param(
                1.0 - math.exp(-(1.0 / 60.0) / (c_norm_d["t63Pitch"]["value"] / math.log(1.0 / 0.37))),
                "ratio", "smoothingAlpha",
                "first-order alpha matching retail pitch t63",
                ["normalChase.derived.t63Pitch"]),
            "distanceSmoothingAlpha": provisional_param(
                1.0 - math.exp(-(1.0 / 60.0) / (c_norm_d["t63Distance"]["value"] / math.log(1.0 / 0.37))),
                "ratio", "smoothingAlpha",
                "first-order alpha matching retail distance t63",
                ["normalChase.derived.t63Distance"]),
            "fovSmoothingAlpha": provisional_param(
                1.0 - math.exp(-(1.0 / 60.0) / (smoothing_t63(0.8) / math.log(1.0 / 0.37))),
                "ratio", "smoothingAlpha",
                "first-order alpha matching fixed FOV smoothing s_fovDamping=0.8 s",
                ["HollywoodVehicleCamera.cpp:869"]),
            "lookAtSmoothingAlpha": provisional_param(
                1.0 - math.exp(-(1.0 / 60.0) / (c_norm_d["t63LookAt"]["value"] / math.log(1.0 / 0.37))),
                "ratio", "smoothingAlpha",
                "first-order alpha matching retail look-at t63",
                ["normalChase.derived.t63LookAt"]),
            "occlusionMargin": param(0.35, "metres", "distance", "code",
                                     code_source("hollywood", 1157, "C_HollywoodVehicleCamera::OnUpdate RayTrace margin 0.35f")),
            "occlusionNearField": param(0.0, "metres", "distance", "provisional",
                                        {"kind": "provisional", "derivation": "retail has no fixed near-field hold; the trace clamps to the car-top safe point", "inputs": ["hollywood:1129-1168"]}),
            "eyeHeightAboveCar": provisional_param(c_norm_d["eyeHeightAboveCar"]["value"], "metres", "height",
                                                    "IdealBase.vy + IdealDistanceNormal*sin(deg2rad(IdealPitch))",
                                                    ["normalChase.fields.idealBaseY", "normalChase.fields.idealDistanceNormal", "normalChase.fields.idealPitch"]),
            "lookDownAngle": provisional_param(c_norm_d["lookDownAngle"]["value"], "degrees", "pitch",
                                                "atan2(eyeHeightAboveCar-LookAtPos.vy, horizontalDistance+LookAtPos.vz)",
                                                ["normalChase.derived.eyeHeightAboveCar", "normalChase.derived.horizontalDistance", "normalChase.fields.lookAtZ"]),
        },
        "legacyOrbit": {
            "mode": "legacyChase",
            "car": "corvette-zr1-stock",
            "note": "Use only if the PoC keeps the legacy orbit model; the retail normal feed is the Hollywood camera above.",
            "distance": c_leg_f["distance"],
            "height": c_leg_f["height"],
            "lookHeight": param(0.0, "metres", "height", "provisional",
                                {"kind": "provisional", "derivation": "legacy pivot is the car origin (PivotZ=0)", "inputs": ["legacyChase.fields.pivotZ"]}),
            "lookAhead": param(0.0, "metres", "offset", "provisional",
                               {"kind": "provisional", "derivation": "legacy camera looks at the pivot; no look-ahead", "inputs": ["ChaseCamera2.cpp:106-110"]}),
            "verticalFov": c_leg_f["fov"],
            "tilt": c_leg_f["tilt"],
            "behindSpring": c_leg_f["behindSpring"],
            "perTickAlpha": c_leg_d["perTickAlpha"],
            "near": provisional_param(near_clip(c_leg_f["fov"]["value"]), "metres", "near",
                                      "0.1 + 0.01745/deg2rad(fov) (Feed.cpp:71-78)",
                                      ["legacyChase.fields.fov"]),
            "far": param(4000.0, "metres", "far", "code",
                         code_source("camera", 36, "C_Camera::C_Camera m_FarClip = 4000.f")),
            "occlusionMargin": param(0.2, "metres", "distance", "code",
                                     code_source("chase2", 119, "C_ChaseCamera2::OnUpdate trace margin 0.2f")),
            "safeHeight": c_leg_f["safeHeight"],
        },
    }

    # ------------------------------------------------------------------ manifest
    manifest = {
        "kind": "blur.camera-parity",
        "version": 1,
        "generatedBy": "probes/camera/tools/build_camera_manifest.py",
        "source": {
            "pak": "game-data/Blur/cache/gamedata.pak",
            "entry": {
                "path": entry["path"],
                "offset": entry["offset"],
                "storedBytes": entry["stored_bytes"],
                "logicalBytes": entry["logical_bytes"],
                "fatIndex": entry["fat_index"],
                "pathCrc32": entry["path_crc32"],
            },
            "decodedSha256": decoded_sha,
            "decodedBytes": len(decoded),
            "types": len(flask.types),
            "records": len(flask.records),
            "decoder": {
                "file": "probes/powerups/tools/xt_decode.py",
                "sha256": sha256_file(ROOT / "probes/powerups/tools/xt_decode.py"),
            },
            "amaxVehicles": {
                "file": "_work/vehicle-pipeline/amax-vehicles.jsonl",
                "sha256": sha256_file(AMAX_VEHICLES),
            },
            "roster": {
                "file": "_work/e1-drive/cars.json",
                "sha256": sha256_file(ROSTER_FILE),
            },
            "rootPakIndex": {
                "file": "_work/verification/pak-reader/root.pak.json",
                "sha256": sha256_file(ROOT_PAK_INDEX),
            },
        },
        "units": UNITS,
        "roster": [
            {
                "slug": slug,
                "name": tag,
                "recordId": roster_rows[slug]["record"]["id"],
                "amaxTag": tag,
                "amaxRecordId": vehicle_rows[tag]["id"],
            }
            for slug, tag in ROSTER
        ],
        "modes": {
            "normalChaseHollywood": {
                "role": "normal gameplay chase; C_VehicleFeed::Init creates C_HollywoodVehicleCamera when m_Future=false",
                "activeInSource": True,
                "source": {
                    "selection": code_source("vehicle_feed", 85, "C_VehicleFeed::Init else branch creates C_HollywoodVehicleCamera"),
                    "paramSelection": code_source("vehicle_actor", 9736, "GetHollywoodCameraParams: debugIndex==0 ? m_HollywoodVehicleParams : m_HollywoodVehicleParams2"),
                    "fallback": code_source("vehicle_actor", 9738, "falls back to mVehicleDefaults[0]->hollywoodCamDefaults"),
                    "update": code_source("hollywood", 812, "CalculateDesiredDistance / smoothing / FOV / look-at"),
                },
                "cars": normal_cars,
                "codeDefaults": {
                    "maxDistanceFactor": code_defaults["maxDistanceFactor"],
                    "traceMargin": code_defaults["hollywoodTraceMargin"],
                },
                "defaultsRecord": {
                    "recordIndex": defaults_index,
                    "recordId": flask.record_id(defaults_index),
                    "hollywoodCamDefaults": {
                        "recordIndex": hc_default_handle["record"],
                        "recordId": hc_default_handle["refId"],
                        "normalFov": data_param(flask, entry, hc_default_handle["record"], "HollywoodVehicleParams", "NormalFOV", hc_default["NormalFOV"], "degrees", "fov", field_offsets(flask, flask.record_type(hc_default_handle["record"]))["NormalFOV"], decoded_sha=decoded_sha),
                        "idealDistanceNormal": data_param(flask, entry, hc_default_handle["record"], "HollywoodVehicleParams", "IdealDistanceNormal", hc_default["IdealDistanceNormal"], "metres", "distance", field_offsets(flask, flask.record_type(hc_default_handle["record"]))["IdealDistanceNormal"], decoded_sha=decoded_sha),
                    },
                    "hollywoodCamMotorMash": {
                        "recordIndex": hc_motor_handle["record"],
                        "recordId": hc_motor_handle["refId"],
                        "normalFov": data_param(flask, entry, hc_motor_handle["record"], "HollywoodVehicleParams", "NormalFOV", hc_motor["NormalFOV"], "degrees", "fov", field_offsets(flask, flask.record_type(hc_motor_handle["record"]))["NormalFOV"], decoded_sha=decoded_sha),
                        "idealDistanceNormal": data_param(flask, entry, hc_motor_handle["record"], "HollywoodVehicleParams", "IdealDistanceNormal", hc_motor["IdealDistanceNormal"], "metres", "distance", field_offsets(flask, flask.record_type(hc_motor_handle["record"]))["IdealDistanceNormal"], decoded_sha=decoded_sha),
                    },
                },
            },
            "legacyChase": {
                "role": "legacy/future chase (C_AmaxChaseCamera); only created when C_VehicleFeed::m_Future=true; not the normal retail chase",
                "activeInSource": False,
                "source": {
                    "selection": code_source("vehicle_feed", 77, "C_VehicleFeed::Init if (m_Future) creates C_AmaxChaseCamera"),
                    "paramSelection": code_source("vehicle_feed", 366, "UpdateParam: m_Chase->SetAmaxParam(*m_VehicleParam->m_Chase.Object())"),
                    "update": code_source("amax_chase", 151, "C_AmaxChaseCamera::UpdateParams"),
                },
                "cars": legacy_cars,
                "singleProfile": legacy_single,
                "singleProfileReason": "All five roster cars have a non-null CameraParam.Chase with byte-identical values; only the record ids differ.",
                "dataDefaultRecord": {
                    "recordIndex": default_chase_index,
                    "recordId": default_chase_handle["refId"],
                    "fields": {
                        "distance": data_param(flask, entry, default_chase_index, "AmaxChaseParam", "Distance", default_chase["Distance"], "metres", "distance", field_offsets(flask, flask.record_type(default_chase_index))["Distance"], decoded_sha=decoded_sha),
                        "height": data_param(flask, entry, default_chase_index, "AmaxChaseParam", "Height", default_chase["Height"], "metres", "height", field_offsets(flask, flask.record_type(default_chase_index))["Height"], decoded_sha=decoded_sha),
                        "fov": data_param(flask, entry, default_chase_index, "AmaxChaseParam", "Fov", default_chase["Fov"], "degrees", "fov", field_offsets(flask, flask.record_type(default_chase_index))["Fov"], decoded_sha=decoded_sha),
                        "tilt": data_param(flask, entry, default_chase_index, "AmaxChaseParam", "Tilt", default_chase["Tilt"], "degrees", "tilt", field_offsets(flask, flask.record_type(default_chase_index))["Tilt"], decoded_sha=decoded_sha),
                        "behindSpring": data_param(flask, entry, default_chase_index, "AmaxChaseParam", "BehindSpring", default_chase["BehindSpring"], "per_second", "smoothing", field_offsets(flask, flask.record_type(default_chase_index))["BehindSpring"], decoded_sha=decoded_sha),
                    },
                },
                "codeDefaults": code_defaults["amaxChaseParamConstructor"],
                "accelEffect": {
                    "recordIndex": accel_index,
                    "recordId": flask.record_id(accel_index),
                    "roughness": data_param(flask, entry, accel_index, "AmaxAccelEffect", "Roughness", accel["Roughness"], "ratio", "smoothingAlpha", field_offsets(flask, flask.record_type(accel_index))["Roughness"], decoded_sha=decoded_sha),
                    "zMin": data_param(flask, entry, accel_index, "AmaxAccelEffect", "ZMin", accel["ZMin"], "metres", "offset", field_offsets(flask, flask.record_type(accel_index))["ZMin"], decoded_sha=decoded_sha),
                    "zMax": data_param(flask, entry, accel_index, "AmaxAccelEffect", "ZMax", accel["ZMax"], "metres", "offset", field_offsets(flask, flask.record_type(accel_index))["ZMax"], decoded_sha=decoded_sha),
                    "fovMin": data_param(flask, entry, accel_index, "AmaxAccelEffect", "FovMin", accel["FovMin"], "degrees", "fov", field_offsets(flask, flask.record_type(accel_index))["FovMin"], decoded_sha=decoded_sha),
                    "fovMax": data_param(flask, entry, accel_index, "AmaxAccelEffect", "FovMax", accel["FovMax"], "degrees", "fov", field_offsets(flask, flask.record_type(accel_index))["FovMax"], decoded_sha=decoded_sha),
                    "fovEffect": data_param(flask, entry, accel_index, "AmaxAccelEffect", "FovEffect", accel["FovEffect"], "degrees_per_acceleration", "compositeGain", field_offsets(flask, flask.record_type(accel_index))["FovEffect"], decoded_sha=decoded_sha,
                                           note="FovEffect is 0.0, so the legacy acceleration FOV term is identically zero for this data."),
                },
            },
            "bumper": {
                "role": "Bumper feed (E_VFCamera_Bumper, C_BoltedCamera). C_VehicleFeed::UpdateParam feeds CameraParam.Bonnet to it (source comment says the bumper/bonnet settings are switched).",
                "activeInSource": True,
                "source": {
                    "enum": code_source("vfcamera", 7, "enum E_VFCamera { E_VFCamera_Hollywood=0, E_VFCamera_Bumper }"),
                    "paramSelection": code_source("vehicle_feed", 373, "m_Bumper->SetParam(m_VehicleParam->m_Bonnet)"),
                    "heightOffset": code_defaults["bumperHeightOffset"],
                },
                "cars": bumper_cars,
                "codeDefaults": {
                    "boltedParamFov": code_defaults["boltedParam"],
                    "fallbackFov": code_defaults["boltedCameraFallbackFov"],
                },
            },
            "hoodAndDash": {
                "role": "Per-car CameraParam.Bonnet and CameraParam.Dash are serialized, but C_VehicleFeed only instantiates Hollywood (or legacy Chase) and Bumper in this source revision; hood and dash are data-only.",
                "activeInSource": False,
                "source": {
                    "paramType": "AmaxVehicleFeedParam: Chase handle, Dash/Bonnet/Bumper inline structs",
                    "consumer": code_source("vehicle_feed", 75, "C_VehicleFeed::Init creates only Hollywood/Chase + Bumper"),
                },
                "cars": hood_cars,
                "standaloneDashRecord": {
                    "recordIndex": by_type["AmaxDashParam"][0],
                    "recordId": flask.record_id(by_type["AmaxDashParam"][0]),
                    "dashFov": data_param(flask, entry, by_type["AmaxDashParam"][0], "AmaxDashParam", "DashFov", flask.decode_record(by_type["AmaxDashParam"][0])["DashFov"], "degrees", "fov", field_offsets(flask, flask.record_type(by_type["AmaxDashParam"][0]))["DashFov"], decoded_sha=decoded_sha),
                },
            },
            "orbitDebug": {
                "role": "debug orbit camera (E_DebugCam_OrbitCamera); not a gameplay chase",
                "activeInSource": False,
                "fields": {
                    "radius": cp_code(4.0, "metres", "distance", "orbit", 9, "g_OrbitRadius"),
                    "speed": cp_code(0.05, "ratio", "ratio", "orbit", 10, "g_OrbitSpeed"),
                    "fov": cp_code(60.0, "degrees", "fov", "orbit", 11, "g_OrbitFov"),
                    "xOffset": cp_code(0.0, "metres", "offset", "orbit", 12, "g_OrbitXOffset"),
                    "yOffset": cp_code(1.5, "metres", "offset", "orbit", 13, "g_OrbitYOffset"),
                    "zOffset": cp_code(0.0, "metres", "offset", "orbit", 14, "g_OrbitZOffset"),
                    "xAim": cp_code(0.0, "metres", "offset", "orbit", 15, "g_OrbitXAim"),
                    "yAim": cp_code(-1.5, "metres", "offset", "orbit", 16, "g_OrbitYAim"),
                    "zAim": cp_code(0.0, "metres", "offset", "orbit", 17, "g_OrbitZAim"),
                },
                "derived": {
                    "angularRate": provisional_param(0.05 * math.pi, "radians_per_second", "angularRate",
                                                     "g_OrbitSpeed * pi (OrbitCamera.cpp:45)", ["orbitDebug.fields.speed"]),
                    "period": provisional_param(2.0 / 0.05, "seconds", "time",
                                                "2*pi / (g_OrbitSpeed*pi)", ["orbitDebug.fields.speed"]),
                },
            },
            "replayCinematic": {
                "role": "keyframed camera animation packs and dynamic-camera records; not a chase camera",
                "activeInSource": False,
                "status": "unsupported-for-chase-parity",
                "reason": "Replay/cinematic cameras are .cycle animation packs in root.pak and AnimatedCameraSequence/DyCam records in amax.bin; they are not a parametric chase camera and are not decoded here.",
                "rootPakCameraCycleCount": param(len(camera_cycles), "count", "count", "data", {
                    "kind": "data", "file": "_work/verification/pak-reader/root.pak.json",
                    "fileSha256": sha256_file(ROOT_PAK_INDEX), "line": None,
                    "symbol": "entries under \\animations\\cameras\\ ending .cycle",
                    "note": "Count of root.pak camera animation packs; not decoded."}),
                "rootPakCameraCycleExample": camera_cycles[0] if camera_cycles else None,
                "animatedCameraSequenceRecords": param(animated_sequences, "count", "count", "data", {
                    "kind": "data", "file": "game-data/Blur/cache/gamedata.pak",
                    "fileSha256": decoded_sha, "line": None,
                    "symbol": "\\gamedata\\xt\\amax.bin type AnimatedCameraSequence",
                    "note": "Record count of the cinematic sequence type; not decoded."}),
            },
            "farChase": {
                "status": "unsupported",
                "reason": "E_VFCamera has only Hollywood (normal chase) and Bumper. No far chase camera type or serialized far profile exists in this source/data. The legacy AmaxChaseParam is a separate feed, not a far mode.",
            },
        },
        "codeDefaults": code_defaults,
        "dataDefaults": {
            "amaxVehicleDefaults": {
                "recordIndex": defaults_index,
                "recordId": flask.record_id(defaults_index),
                "note": "defaultCamera/Dash/Bonnet/Bumper are inline fallbacks; all five roster cars have their own CameraParam, so these are not used for the roster. The fallback Chase record is recorded under legacyChase.dataDefaultRecord.",
            },
            "rightStickCameraParams": {
                "recordIndex": right_stick_index,
                "recordId": flask.record_id(right_stick_index),
                "pivotDistance": data_param(flask, entry, right_stick_index, "RightStickCameraParams", "PivotDistance", right_stick["PivotDistance"], "metres", "distance", field_offsets(flask, flask.record_type(right_stick_index))["PivotDistance"], decoded_sha=decoded_sha),
                "dollyDistance": data_param(flask, entry, right_stick_index, "RightStickCameraParams", "DollyDistance", right_stick["DollyDistance"], "metres", "distance", field_offsets(flask, flask.record_type(right_stick_index))["DollyDistance"], decoded_sha=decoded_sha),
                "maxHorizontalAngle": data_param(flask, entry, right_stick_index, "RightStickCameraParams", "MaxHorizontalAngle", right_stick["MaxHorizontalAngle"], "degrees", "angle", field_offsets(flask, flask.record_type(right_stick_index))["MaxHorizontalAngle"], decoded_sha=decoded_sha),
                "maxVerticalAngle": data_param(flask, entry, right_stick_index, "RightStickCameraParams", "MaxVerticalAngle", right_stick["MaxVerticalAngle"], "degrees", "angle", field_offsets(flask, flask.record_type(right_stick_index))["MaxVerticalAngle"], decoded_sha=decoded_sha),
                "blendValue": data_param(flask, entry, right_stick_index, "RightStickCameraParams", "BlendValue", right_stick["BlendValue"], "ratio", "ratio", field_offsets(flask, flask.record_type(right_stick_index))["BlendValue"], decoded_sha=decoded_sha),
            },
            "viewportFovScale": {
                "recordIndex": fov_scale_index,
                "recordId": flask.record_id(fov_scale_index),
                "twoPlayer": data_param(flask, entry, fov_scale_index, "AmaxViewportFovScale", "TwoPlayer", fov_scale["TwoPlayer"], "ratio", "ratio", field_offsets(flask, flask.record_type(fov_scale_index))["TwoPlayer"], decoded_sha=decoded_sha),
                "threePlayer": data_param(flask, entry, fov_scale_index, "AmaxViewportFovScale", "ThreePlayer", fov_scale["ThreePlayer"], "ratio", "ratio", field_offsets(flask, flask.record_type(fov_scale_index))["ThreePlayer"], decoded_sha=decoded_sha),
                "fourPlayer": data_param(flask, entry, fov_scale_index, "AmaxViewportFovScale", "FourPlayer", fov_scale["FourPlayer"], "ratio", "ratio", field_offsets(flask, flask.record_type(fov_scale_index))["FourPlayer"], decoded_sha=decoded_sha),
            },
        },
        "poc": poc,
        "comparison": comparison,
        "patch": patch,
        "shake": {
            "perCarChaseShakeSerialized": False,
            "reason": "No AmaxChaseParam or HollywoodVehicleParams field carries shake. Chase shake is runtime/event driven (C_CameraNoiseSpecialFX / C_ShakeWorld); only dynamic-camera DyCamShakeDef records are serialized.",
            "dyCamShakeDefs": shake_defs,
            "codeShake": {
                "shakeCameraDefaults": "C_ShakeCamera::C_ShakeCamera sets amount 0 and frequency 0 (ShakeCamera.cpp:10-12); SetParam supplies amounts in degrees and frequency in Hz.",
                "noise": "C_CameraNoiseSpecialFX is SpecialFX data with Time, Frequency, TranslationParams and RotationParams; its per-event curves are not a chase camera parameter.",
            },
        },
        "unresolved": {
            "hollywoodIdealPitchUnit": "Data values look like degrees and all surrounding FOV/distance data are degrees, but HollywoodVehicleCamera.cpp:863 passes IdealPitch raw to SetIdealPitch, whose range is radians (ThirdPersonCamera.cpp:385-389). The derived eye height/look-down is provisional; a retail binary check is required before treating it as exact.",
            "highSpeedFov": "HighSpeedLowerVelThreshold 199.0 / HighSpeedUpperVelThreshold 200.0 / HighSpeedFovMultiplier 1.3 are serialized, but the committed source never sets m_highSpeed (only initialized false at HollywoodVehicleCamera.cpp:153). The path is dormant in this source revision. Threshold unit not resolved.",
            "lookSideAtSpeed": "The Hollywood look-side/up-down at speed depends on steering, wheel slip, yaw rate and wheel contact (CalculateDesiredLookSide/UpDown); only the straight-line LookAtPos rest value is used in this manifest.",
            "farMode": "No far chase mode exists.",
            "hoodDashActive": "Bonnet and Dash are serialized per car but not instantiated as separate game feeds by C_VehicleFeed in this source revision.",
            "shakeOwnership": "The four DyCamShakeDef records are not mapped to a specific route/camera here; they are dynamic-camera shake definitions, not per-car chase shake.",
        },
        "limits": [
            "Normal retail chase is C_HollywoodVehicleCamera, not C_AmaxChaseCamera. AmaxChaseParam is the legacy/future feed; the PoC orbit is closest to that legacy record, not to the normal retail camera.",
            "The Hollywood IdealPitch unit is unresolved in the committed source; derived eye height/look-down is provisional.",
            "The high-speed FOV multiplier is data-only in this source revision (m_highSpeed never set true).",
            "The legacy chase is a single profile: all five roster cars have identical AmaxChaseParam values; only record ids differ.",
            "Per-car normal offsets are recovered for the 5 E1 roster cars only, not all 62 RP_CarDynamics records.",
            "Look-ahead, look-side and up/down at speed are reduced to the straight-line rest value; steering/slip/airborne behaviour is not modelled here.",
            "No per-car chase shake is serialized; camera shake is runtime/event driven and is not reproduced.",
            "No retail binary was executed and no browser capture was taken (task constraint); values are data/code-derived, not pixel-verified.",
            "C_ChaseParam.lag is declared but unread by C_ChaseCamera2::OnUpdate; it must not be used as a smoothing constant.",
            "The PoC uses a first-order per-tick alpha; retail uses Kanzen::SmoothingFunction (velocity-based). t63 is the common comparison metric, not a like-for-like formula.",
            "Far chase does not exist; hood/dash are data-only; orbit is a debug camera; replay is keyframed .cycle packs, not a chase camera.",
        ],
        "provenanceSummary": {},
        "manifestHash": "",
    }

    # Inline AmaxVehicleFeedParam components are reached through the AmaxVehicle
    # record's CameraParam pointer; xt_decode does not expose the component byte
    # offset, so label the source as the AmaxVehicle record and keep the path.
    def fix_inline(node):
        if isinstance(node, dict):
            src = node.get("source")
            if isinstance(src, dict) and src.get("kind") == "data" and src.get("type") == "AmaxVehicleFeedParam":
                src["type"] = "AmaxVehicle"
                src["inlineComponent"] = True
                field = src.get("field", "")
                if field and not field.startswith("CameraParam."):
                    src["field"] = "CameraParam." + field
                src.setdefault("note", "inline component reached through AmaxVehicle.CameraParam; byte offset inside the component is not emitted by xt_decode")
            for value in node.values():
                fix_inline(value)
        elif isinstance(node, list):
            for value in node:
                fix_inline(value)

    fix_inline(manifest)

    # Provenance counts over every parameter object.
    counts = {"data": 0, "code": 0, "provisional": 0}

    def walk(node):
        if isinstance(node, dict):
            if "value" in node and "provenance" in node:
                counts[node["provenance"]] = counts.get(node["provenance"], 0) + 1
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(manifest)
    manifest["provenanceSummary"] = counts

    canonical = json.dumps(manifest, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    manifest["manifestHash"] = "sha256:" + sha256_bytes(canonical.encode("utf-8"))
    return manifest


def main() -> None:
    manifest = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    print(f"manifestHash {manifest['manifestHash']}")
    print(f"provenance {manifest['provenanceSummary']}")


if __name__ == "__main__":
    main()
