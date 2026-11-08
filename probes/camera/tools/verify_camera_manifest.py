#!/usr/bin/env python
"""Verify the camera parity manifest (>=120 checks, deterministic).

Run:
  python probes/camera/tools/verify_camera_manifest.py
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "powerups" / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "camera" / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402
import xt_decode  # noqa: E402
import build_camera_manifest as builder  # noqa: E402

MANIFEST = ROOT / "_work/camera/camera.json"
OUT = ROOT / "_work/camera/verify.json"
PACK = ROOT / "game-data/Blur/cache/gamedata.pak"

SEMANTIC_UNITS = {
    "fov": {"degrees"},
    "range": {"metres"},
    "distance": {"metres"},
    "height": {"metres"},
    "offset": {"metres"},
    "pitch": {"degrees"},
    "tilt": {"degrees"},
    "angle": {"degrees"},
    "smoothing": {"seconds", "per_second"},
    "smoothingAlpha": {"ratio"},
    "near": {"metres"},
    "far": {"metres"},
    "aspect": {"ratio"},
    "speed": {"metres_per_second"},
    "acceleration": {"metres_per_second_squared"},
    "frequency": {"hertz"},
    "ratio": {"ratio"},
    "count": {"count"},
    "time": {"seconds"},
    "angularRate": {"radians_per_second", "degrees_per_second"},
    "compositeGain": {"degrees_per_acceleration"},
}

RANGES = {
    "fov": (0.0, 130.0),
    "range": (0.0, 500.0),
    "distance": (0.0, 50.0),
    "height": (-5.0, 10.0),
    "offset": (-10.0, 10.0),
    "pitch": (-45.0, 45.0),
    "tilt": (-45.0, 45.0),
    "angle": (0.0, 360.0),
    "smoothing": (0.0, 10.0),
    "smoothingAlpha": (0.0, 1.0),
    "near": (0.0, 10.0),
    "far": (10.0, 100000.0),
    "aspect": (0.1, 10.0),
    "speed": (0.0, 200.0),
    "acceleration": (-100.0, 100.0),
    "frequency": (0.0, 200.0),
    "ratio": (0.0, 10.0),
    "count": (0.0, 100000.0),
    "time": (0.0, 10000.0),
    "angularRate": (0.0, 720.0),
    "compositeGain": (-10.0, 10.0),
}

REQUIRED_NORMAL = {
    "normalFov", "idealDistanceNormal", "idealDistanceAtFullAcceleration",
    "idealDistanceAtFullDeceleration", "idealDistanceAirbourne",
    "idealDistanceSmoothing", "idealDistanceSmoothingAccelerating",
    "idealDistanceSmoothingDecelerating", "idealPitch", "idealBaseY",
    "lookAtY", "lookAtZ", "pitchDampingNormal", "yawDampingNormal",
    "lookAtSmoothing", "maxAcceleration", "maxDeceleration",
    "highSpeedFovMultiplier",
}
REQUIRED_LEGACY = {
    "distance", "height", "fov", "tilt", "behindSpring",
    "angularLimit", "angularFade", "pivotZ", "safeHeight",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def decode_pak_entry(entry: dict) -> bytes:
    import zlib
    with PACK.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    inflater = zlib.decompressobj()
    decoded = inflater.decompress(packed, entry["logical_bytes"] + 1)
    if len(decoded) != entry["logical_bytes"] or not inflater.eof:
        raise ValueError("PAK entry extent mismatch")
    return decoded


def record_data_offset(flask, index: int) -> int:
    return flask.tables["data"]["offset"] + sum(
        flask.records[i][2] + flask.records[i][3] for i in range(index))


def resolve_path(record: dict, path: str):
    node = record
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return False, None
        node = node[part]
    return True, node


class Checker:
    def __init__(self) -> None:
        self.checks = 0
        self.failures = []

    def check(self, ok: bool, name: str, detail=None) -> None:
        self.checks += 1
        if not ok:
            item = {"check": name}
            if detail is not None:
                item["detail"] = detail
            self.failures.append(item)

    def report(self) -> dict:
        return {
            "status": "PASS" if not self.failures else "FAIL",
            "checks": self.checks,
            "failures": len(self.failures),
            "firstFailure": self.failures[0] if self.failures else None,
        }


def main() -> int:
    checker = Checker()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    # ------------------------------------------------------------ manifest hash
    body = dict(manifest)
    recorded_hash = body.pop("manifestHash", None)
    body["manifestHash"] = ""
    canonical = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    checker.check(recorded_hash == "sha256:" + sha256_bytes(canonical.encode("utf-8")),
                  "manifestHash matches canonical manifest")
    checker.check(manifest.get("kind") == "blur.camera-parity", "manifest kind")
    checker.check(manifest.get("version") == 1, "manifest version")

    # -------------------------------------------------------------- determinism
    rebuilt = builder.build()
    checker.check(rebuilt == manifest, "builder is deterministic (full object equal)")
    checker.check(rebuilt.get("manifestHash") == manifest.get("manifestHash"),
                  "builder is deterministic (manifest hash equal)")

    # ------------------------------------------------------------------- source
    source = manifest["source"]
    index = pak_index(PACK)
    entries = {row["path"]: row for row in index["entries"]}
    entry = entries[source["entry"]["path"]]
    checker.check(entry["offset"] == source["entry"]["offset"], "entry offset")
    checker.check(entry["stored_bytes"] == source["entry"]["storedBytes"], "entry stored bytes")
    checker.check(entry["logical_bytes"] == source["entry"]["logicalBytes"], "entry logical bytes")
    checker.check(entry["fat_index"] == source["entry"]["fatIndex"], "entry FAT index")
    checker.check(entry["path_crc32"] == source["entry"]["pathCrc32"], "entry path CRC32")
    decoded = decode_pak_entry(entry)
    checker.check(sha256_bytes(decoded) == source["decodedSha256"], "decoded amax.bin sha256")
    checker.check(len(decoded) == source["decodedBytes"], "decoded amax.bin bytes")
    flask = xt_decode.Flask(decoded)
    checker.check(len(flask.types) == source["types"], "decoded type count")
    checker.check(len(flask.records) == source["records"], "decoded record count")
    checker.check(source["decodedBytes"] == 1078940, "decoded amax.bin is 1,078,940 B")
    checker.check(source["decodedSha256"] == "a833487bd66552ecf61b1f13790ee228b18ca8f4d76c524dcd94e44c63d1e3c7",
                  "decoded amax.bin pinned hash")
    checker.check(sha256_file(ROOT / source["decoder"]["file"]) == source["decoder"]["sha256"],
                  "xt_decode.py hash")
    checker.check(sha256_file(ROOT / source["amaxVehicles"]["file"]) == source["amaxVehicles"]["sha256"],
                  "amax-vehicles.jsonl hash")
    checker.check(sha256_file(ROOT / source["roster"]["file"]) == source["roster"]["sha256"],
                  "cars.json hash")
    checker.check(sha256_file(ROOT / source["rootPakIndex"]["file"]) == source["rootPakIndex"]["sha256"],
                  "root.pak index hash")

    # --------------------------------------------------------------- roster map
    roster = manifest["roster"]
    checker.check(len(roster) == 5, "roster has five cars")
    checker.check({row["slug"] for row in roster} == {
        "corvette-zr1-stock", "lotus-exige-cup260-stock", "dodge-challenger-stock",
        "ford-focusrs-stock", "audi-r8v10-stock"}, "roster slugs")
    roster_doc = json.loads((ROOT / "_work/e1-drive/cars.json").read_text(encoding="utf-8"))
    roster_rows = {row["slug"]: row for row in roster_doc["roster"]["cars"]}
    for row in roster:
        checker.check(row["recordId"] == roster_rows[row["slug"]]["record"]["id"],
                      f"roster record id {row['slug']}")
        checker.check(row["name"] == roster_rows[row["slug"]]["name"],
                      f"roster name {row['slug']}")

    # ---------------------------------------------------------- parameter walk
    allowed_units = set(manifest["units"])
    allowed_provenance = {"data", "code", "provisional"}
    seen_paths = set()
    seen_params = []
    provenance_counts = {"data": 0, "code": 0, "provisional": 0}

    def walk(node, path):
        if isinstance(node, dict):
            if "value" in node and "provenance" in node:
                seen_params.append((path, node))
                provenance_counts[node["provenance"]] = provenance_counts.get(node["provenance"], 0) + 1
            for key, value in node.items():
                walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for i, value in enumerate(node):
                walk(value, f"{path}[{i}]")

    walk(manifest, "$")
    checker.check(len(seen_params) >= 400,
                  f"parameter count >= 400 (actual {len(seen_params)})")

    for path, param in seen_params:
        checker.check(path not in seen_paths, f"unique parameter path: {path}")
        seen_paths.add(path)
        provenance = param.get("provenance")
        unit = param.get("unit")
        semantic = param.get("semantic")
        source = param.get("source") or {}
        checker.check(provenance in allowed_provenance, f"provenance tag: {path}")
        checker.check(unit in allowed_units, f"unit declared in manifest.units: {path}")
        checker.check(semantic in SEMANTIC_UNITS, f"semantic known: {path}")
        checker.check(unit in SEMANTIC_UNITS.get(semantic, set()),
                      f"unit fits semantic: {path} ({semantic} vs {unit})")
        checker.check(isinstance(source, dict) and bool(source), f"source present: {path}")

        value = param.get("value")
        if isinstance(value, bool):
            checker.check(source.get("kind") == provenance, f"source kind matches provenance: {path}")
        else:
            checker.check(isinstance(value, (int, float)) and math.isfinite(float(value)),
                          f"value finite numeric: {path}")
            lo, hi = RANGES.get(semantic, (-1e12, 1e12))
            if path.endswith(".delta"):
                lo, hi = -1000.0, 1000.0
            if "expectedMin" in param:
                lo = param["expectedMin"]
            if "expectedMax" in param:
                hi = param["expectedMax"]
            checker.check(lo <= float(value) <= hi,
                          f"value in plausible range: {path} ({value} not in [{lo},{hi}])")

        kind = source.get("kind")
        checker.check(kind == provenance, f"source kind equals provenance: {path}")
        if provenance == "data":
            ri = source.get("recordIndex")
            if ri is not None:
                checker.check(source.get("pak") == manifest["source"]["pak"],
                              f"data source pak: {path}")
                checker.check(source.get("entry") == manifest["source"]["entry"]["path"],
                              f"data source entry: {path}")
                checker.check(source.get("decodedSha256") == manifest["source"]["decodedSha256"],
                              f"data source decoded hash: {path}")
                checker.check(isinstance(ri, int) and 0 <= ri < len(flask.records),
                              f"data record index in range: {path}")
                checker.check(source.get("recordId") == flask.record_id(ri),
                              f"data record id matches: {path}")
                checker.check(source.get("type") == flask.type_name(flask.record_type(ri)),
                              f"data record type matches: {path}")
                expected_offset = record_data_offset(flask, ri)
                checker.check(source.get("recordDataOffset") == expected_offset,
                              f"data record offset: {path}")
                if "fieldOffsetInRecord" in source:
                    off = source["fieldOffsetInRecord"]
                    checker.check(isinstance(off, int) and 0 <= off <= flask.records[ri][2],
                                  f"field offset inside record: {path}")
                    checker.check(source.get("fileOffset") == expected_offset + off,
                                  f"file offset equals record+field: {path}")
                    checker.check(0 <= source["fileOffset"] < len(decoded),
                                  f"file offset inside decoded file: {path}")
                field = source.get("field")
                if field:
                    value_path = source.get("valuePath", field)
                    resolved, actual = resolve_path(flask.decode_record(ri), value_path)
                    checker.check(resolved, f"data field path resolves: {path} ({value_path})")
                    if resolved and not isinstance(actual, (dict, list)):
                        if isinstance(value, bool):
                            checker.check(bool(actual) == value, f"decoded bool matches: {path}")
                        else:
                            tolerance = max(1e-6, abs(float(value)) * 1e-7)
                            checker.check(abs(float(actual) - float(value)) <= tolerance,
                                          f"decoded value matches: {path}")
            else:
                checker.check(semantic == "count",
                              f"recordless data source is a count value: {path}")
                checker.check(bool(source.get("file")), f"recordless data source file: {path}")
                checker.check(bool(source.get("fileSha256")), f"recordless data source file hash: {path}")
                checker.check(bool(source.get("symbol")), f"recordless data source symbol: {path}")
        elif provenance == "code":
            file_path = ROOT / source.get("file", "")
            checker.check(file_path.is_file(), f"code source file exists: {path}")
            if file_path.is_file():
                checker.check(sha256_file(file_path) == source.get("fileSha256"),
                              f"code source file hash: {path}")
            checker.check(source.get("line") is None or isinstance(source.get("line"), int),
                          f"code source line: {path}")
            checker.check(bool(source.get("symbol")), f"code source symbol: {path}")
        elif provenance == "provisional":
            checker.check(bool(source.get("derivation")), f"provisional derivation: {path}")
            checker.check(isinstance(source.get("inputs"), list) and len(source["inputs"]) > 0,
                          f"provisional inputs: {path}")

    # -------------------------------------------------------------- provenance
    checker.check(manifest["provenanceSummary"] == provenance_counts,
                  "provenance summary counts match")
    for tag in ("data", "code", "provisional"):
        checker.check(provenance_counts.get(tag, 0) > 0,
                      f"provenance tag {tag} is used")

    # ------------------------------------------------------------------ modes
    modes = manifest["modes"]
    for mode in ("normalChaseHollywood", "legacyChase", "bumper", "hoodAndDash", "orbitDebug"):
        checker.check(mode in modes, f"mode present: {mode}")
    checker.check(modes["farChase"]["status"] == "unsupported", "far chase is explicitly unsupported")
    checker.check(modes["replayCinematic"]["status"] == "unsupported-for-chase-parity",
                  "replay/cinematic is explicitly out of scope")

    normal = modes["normalChaseHollywood"]["cars"]
    legacy = modes["legacyChase"]["cars"]
    bumper = modes["bumper"]["cars"]
    hood = modes["hoodAndDash"]["cars"]
    checker.check(set(normal) == set(roster_rows) & {row["slug"] for row in roster},
                  "normal mode covers the roster")
    checker.check(set(legacy) == set(normal), "legacy mode covers the roster")
    checker.check(set(bumper) == set(normal), "bumper mode covers the roster")
    checker.check(set(hood) == set(normal), "hood/dash mode covers the roster")

    normal_distances = set()
    normal_ids = set()
    legacy_ids = set()
    for slug in normal:
        entry_normal = normal[slug]
        checker.check(REQUIRED_NORMAL <= set(entry_normal["fields"]),
                      f"normal required fields: {slug}")
        checker.check(entry_normal["paramsRecord"]["usedFallback"] is False,
                      f"normal per-car params used: {slug}")
        checker.check(entry_normal["paramsRecord"]["id"] not in normal_ids,
                      f"normal params record unique: {slug}")
        normal_ids.add(entry_normal["paramsRecord"]["id"])
        normal_distances.add(entry_normal["fields"]["idealDistanceNormal"]["value"])
        checker.check(entry_normal["amaxVehicle"]["dynamicsHandle"]["refId"] ==
                      roster_rows[slug]["record"]["id"],
                      f"normal dynamics handle matches roster: {slug}")
        checker.check(entry_normal["fields"]["normalFov"]["value"] == 65.0,
                      f"normal FOV 65 deg: {slug}")
        checker.check(entry_normal["derived"]["eyeHeightAboveCar"]["value"] > 0.5,
                      f"normal derived eye height positive: {slug}")
        checker.check(entry_normal["derived"]["t63Yaw"]["value"] > 0.1,
                      f"normal yaw t63 positive: {slug}")

    checker.check(len(normal_distances) >= 3,
                  "normal chase has per-car distance variation")
    checker.check(modes["legacyChase"]["singleProfile"] is True,
                  "legacy chase is a single profile")
    for slug in legacy:
        entry_legacy = legacy[slug]
        checker.check(REQUIRED_LEGACY <= set(entry_legacy["fields"]),
                      f"legacy required fields: {slug}")
        checker.check(entry_legacy["paramsRecord"]["usedFallback"] is False,
                      f"legacy per-car params used: {slug}")
        checker.check(entry_legacy["paramsRecord"]["id"] not in legacy_ids,
                      f"legacy params record unique: {slug}")
        legacy_ids.add(entry_legacy["paramsRecord"]["id"])
        checker.check(entry_legacy["fields"]["distance"]["value"] ==
                      legacy[roster[0]["slug"]]["fields"]["distance"]["value"],
                      f"legacy distance identical: {slug}")
        checker.check(entry_legacy["fields"]["fov"]["value"] == 65.0,
                      f"legacy FOV 65 deg: {slug}")
        checker.check(entry_legacy["fields"]["tilt"]["value"] == -8.0,
                      f"legacy tilt -8 deg: {slug}")
        checker.check(entry_legacy["fields"]["behindSpring"]["value"] == 3.0,
                      f"legacy behindSpring 3/s: {slug}")

    # --------------------------------------------------------------- comparison
    def cmp_value(group, key):
        return manifest["comparison"][group][key]

    for group in ("standstill", "at30mps", "legacyStandstill"):
        for key, item in manifest["comparison"][group].items():
            checker.check(abs(item["delta"]["value"] -
                              (item["retail"]["value"] - item["poc"]["value"])) <= 1e-9,
                          f"comparison delta math: {group}.{key}")
            checker.check(item["poc"]["unit"] == item["retail"]["unit"] == item["delta"]["unit"],
                          f"comparison units agree: {group}.{key}")

    ratio_normal = (cmp_value("standstill", "distance")["retail"]["value"] *
                    math.tan(math.radians(cmp_value("standstill", "fov")["retail"]["value"]) / 2.0)) / (
                    cmp_value("standstill", "distance")["poc"]["value"] *
                    math.tan(math.radians(cmp_value("standstill", "fov")["poc"]["value"]) / 2.0))
    checker.check(abs(manifest["comparison"]["angularSizeRatio"]["normal"]["value"] - ratio_normal) <= 1e-12,
                  "angular size ratio normal")
    ratio_legacy = (cmp_value("legacyStandstill", "distance")["retail"]["value"] *
                    math.tan(math.radians(cmp_value("legacyStandstill", "fov")["retail"]["value"]) / 2.0)) / (
                    cmp_value("legacyStandstill", "distance")["poc"]["value"] *
                    math.tan(math.radians(cmp_value("legacyStandstill", "fov")["poc"]["value"]) / 2.0))
    checker.check(abs(manifest["comparison"]["angularSizeRatio"]["legacy"]["value"] - ratio_legacy) <= 1e-12,
                  "angular size ratio legacy")

    # -------------------------------------------------------------------- patch
    patch = manifest["patch"]["primary"]
    corvette = normal["corvette-zr1-stock"]
    checker.check(abs(patch["distance"]["value"] - corvette["derived"]["horizontalDistance"]["value"]) <= 1e-12,
                  "patch distance equals derived horizontal distance")
    checker.check(abs(patch["height"]["value"] - corvette["derived"]["heightAboveAim"]["value"]) <= 1e-12,
                  "patch height equals derived height above aim")
    checker.check(abs(patch["eyeHeightAboveCar"]["value"] - corvette["derived"]["eyeHeightAboveCar"]["value"]) <= 1e-12,
                  "patch eye height equals derived eye height")
    checker.check(abs(patch["lookDownAngle"]["value"] - corvette["derived"]["lookDownAngle"]["value"]) <= 1e-12,
                  "patch look-down equals derived look-down")
    checker.check(patch["lookHeight"]["value"] == 1.0, "patch lookHeight 1.0")
    checker.check(patch["lookAhead"]["value"] == corvette["fields"]["lookAtZ"]["value"],
                  "patch look-ahead equals LookAtPos.vz")
    checker.check(patch["verticalFov"]["value"] == corvette["fields"]["normalFov"]["value"],
                  "patch FOV equals NormalFOV")
    checker.check(abs(patch["near"]["value"] - (0.1 + 0.01745 / math.radians(65.0))) <= 1e-12,
                  "patch near clip formula")
    checker.check(patch["far"]["value"] == 4000.0, "patch far clip 4000 m")
    checker.check(patch["occlusionMargin"]["value"] == 0.35, "patch Hollywood trace margin 0.35 m")
    checker.check(patch["yawSmoothingAlpha"]["value"] > 0.0 and patch["yawSmoothingAlpha"]["value"] < 0.1,
                  "patch yaw alpha plausible")
    checker.check(patch["pitchSmoothingAlpha"]["value"] > 0.0 and patch["pitchSmoothingAlpha"]["value"] < 0.2,
                  "patch pitch alpha plausible")
    checker.check(patch["distanceSmoothingAlpha"]["value"] > 0.0 and patch["distanceSmoothingAlpha"]["value"] < 0.2,
                  "patch distance alpha plausible")
    legacy_patch = manifest["patch"]["legacyOrbit"]
    checker.check(abs(legacy_patch["distance"]["value"] - 4.65) <= 1e-6, "legacy patch distance 4.65 m")
    checker.check(abs(legacy_patch["height"]["value"] - 1.4) <= 1e-6, "legacy patch height 1.4 m")
    checker.check(legacy_patch["verticalFov"]["value"] == 65.0, "legacy patch FOV 65 deg")
    checker.check(legacy_patch["tilt"]["value"] == -8.0, "legacy patch tilt -8 deg")

    # ------------------------------------------------------------------- shake
    checker.check(manifest["shake"]["perCarChaseShakeSerialized"] is False,
                  "no per-car chase shake serialized")
    checker.check(len(manifest["shake"]["dyCamShakeDefs"]) == 4,
                  "four DyCamShakeDef records")
    for item in manifest["shake"]["dyCamShakeDefs"]:
        checker.check(set(item["values"]) == {"x", "y", "z", "frequency"},
                      "shake def fields")

    # ---------------------------------------------------------------- final gate
    checker.check(checker.checks >= 120,
                  f"at least 120 checks (actual {checker.checks})")
    result = checker.report()
    result.update({
        "manifest": str(MANIFEST.relative_to(ROOT)).replace("\\", "/"),
        "manifestSha256": sha256_file(MANIFEST),
        "manifestHash": manifest["manifestHash"],
        "parameterCount": len(seen_params),
        "provenance": provenance_counts,
        "modes": list(manifest["modes"].keys()),
        "normalCars": len(normal),
        "legacyCars": len(legacy),
        "legacySingleProfile": manifest["modes"]["legacyChase"]["singleProfile"],
        "normalDistanceProfiles": len(normal_distances),
        "failureList": checker.failures,
    })
    OUT.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
