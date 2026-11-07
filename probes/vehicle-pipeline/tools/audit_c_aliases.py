"""Resolve the 15 class-C RP_CarDynamics records to a shipped body model (data only).

V1 classified 62 `RP_CarDynamics` records as 5 A / 42 B / 15 C. The 15 C records
have no model whose file name equals the record name, so the committed
name-equality rule blocks them. This probe asks a different, record-level
question: which `AmaxVehicle` record in `gamedata\\xt\\amax.bin` carries the
record, and what body model does that vehicle name?

Authority chain (nothing is inferred from string similarity):

1. `AmaxVehicle.dynamics` is a `FlaskHandle` (FORMAT-xt.md: 4 bytes, U32 id).
   The id indexes the XT `refs` table; `refs[h]` yields the referenced record id
   and type. For every resolved record here the type is `RP_CarDynamics` and the
   id equals the `RP_CarDynamics` record id in `_work/e1-drive/cars.json`.
2. The shipped engine builds the body path from the vehicle tag:
   `upstream/BlurRebuilt/code/amax/game/GameLogic/Structures/LevelState.cpp:334`
   and `.../RaceLogicCore/Core/RaceLogicCore.cpp:1489`:
   `models/vehicles/%s.model` with `veh->tag` / `pAmaxVehicle->tag`.
   Therefore `AmaxVehicle` tag -> `\\models\\vehicles\\<tag>.model`.
3. The wheel path is built from `wheelModel->fileName`:
   `models/vehicles/wheels/%s.model` (LevelState.cpp:360).

A record is `provable` only when a vehicle handle resolves to its exact record
id, the vehicle's tag model exists in `root.pak`, the wheel model exists, and the
vehicle is `use`d (the engine replaces a missing/unused body with
`shelby_mustanggt500_stock.model`; LevelState.cpp:339-345). Otherwise the record
stays `unsupported` with the exact missing evidence.

Outputs (under `_work/vehicle-pipeline/`):
  * `c-aliases.json`  per-record status, identity, intended model, hashes
  * `c-models/`       decoded body/wheel models used by the audit
  * `c-aliases.log`   stdout (also copied to `_work/logs/vehicle-pipeline/`)

Usage:
  python probes/vehicle-pipeline/tools/audit_c_aliases.py [--skip-models]
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
HARNESS = ROOT / "engine/harness/t005d-vehicle"
for path in (TOOLS, HARNESS):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from inspect_asset_layout import pak_index  # noqa: E402
from prepare_asset_fixture import decode_packet_zlib  # noqa: E402
import car_xt  # noqa: E402

OUT = ROOT / "_work/vehicle-pipeline"
CMODELS = OUT / "c-models"
LOGS = ROOT / "_work/logs/vehicle-pipeline"

CARS_JSON = OUT / "cars.json"
PAK = ROOT / "game-data/Blur/cache/root.pak"
GAMEDATA = ROOT / "game-data/Blur/cache/gamedata.pak"
AMAX_PATH = "\\gamedata\\xt\\amax.bin"
AMAX_BIN = GAMEDATA

VEHICLE_PREFIX = "\\models\\vehicles\\"
WHEEL_PREFIX = "\\models\\vehicles\\wheels\\"

# Shipped-source citations that define the tag -> body-model rule.
UPSTREAM = ROOT / "upstream/BlurRebuilt/code"
RULE_CITATIONS = [
    {
        "path": "upstream/BlurRebuilt/code/amax/game/GameLogic/Structures/LevelState.cpp",
        "line": 334,
        "text": 'mCars[a].mFilename = Util::C_String::Format("models/vehicles/%s.model", static_cast<const char*>(veh->tag));',
        "meaning": "body model = \\models\\vehicles\\<AmaxVehicle tag>.model",
    },
    {
        "path": "upstream/BlurRebuilt/code/amax/game/GameLogic/RaceLogicCore/Core/RaceLogicCore.cpp",
        "line": 1489,
        "text": 'pVehicleActorCreate->m_ModelFilename = Util::C_String::Format("models/vehicles/%s.model", static_cast<const char*>(pAmaxVehicle->tag));',
        "meaning": "same rule on the showroom/race spawn path",
    },
    {
        "path": "upstream/BlurRebuilt/code/amax/game/GameLogic/Structures/LevelState.cpp",
        "line": 339,
        "text": "if (!fs.FileExists(filePath) || !veh->use) { ... mCars[a].mFilename = \"models/vehicles/shelby_mustanggt500_stock.model\"; }",
        "meaning": "a missing or unused body is replaced by the Shelby fallback, so use=false is never a proof",
    },
    {
        "path": "upstream/BlurRebuilt/code/amax/game/GameLogic/Structures/LevelState.cpp",
        "line": 360,
        "text": 'mCars[a].mWheelFilename = Util::C_String::Format("models/vehicles/wheels/%s.model", static_cast<const char*>(veh->wheelModel->fileName));',
        "meaning": "wheel model = \\models\\vehicles\\wheels\\<AmaxWheelModel.fileName>.model",
    },
    {
        "path": "upstream/BlurRebuilt/code/amax/game/GameLogic/Structures/LevelState.cpp",
        "line": 408,
        "text": 'mCars[a].mDynamicsFilename = "DefaultCar";',
        "meaning": "DefaultCar is the physics fallback name; it is not an AmaxVehicle and has no body tag",
    },
]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def similarity(a: str, b: str) -> float:
    return round(difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio(), 4)


def extract_pak_entry(pak: Path, entry: dict) -> bytes:
    with pak.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    return decode_packet_zlib(packed, entry["logical_bytes"])


def extract_zlib_entry(pak: Path, entry: dict) -> bytes:
    """Raw zlib entry (XT `.bin`), with the same extent check as car_xt.extract."""
    with pak.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    inflater = zlib.decompressobj()
    data = inflater.decompress(packed, entry["logical_bytes"] + 1)
    if len(data) != entry["logical_bytes"] or not inflater.eof or inflater.unused_data:
        raise ValueError(f"zlib extent mismatch for {entry['path']}")
    return data


def decode_model(entry: dict, stem: str, cache_dir: Path) -> dict:
    """Decode a pak `.model` entry once; return path/bytes/hash."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    data = extract_pak_entry(PAK, entry)
    digest = sha256_bytes(data)
    path = cache_dir / f"{stem}.decoded"
    if not path.exists() or sha256_file(path) != digest:
        path.write_bytes(data)
    return {
        "decodedPath": rel(path),
        "decodedBytes": len(data),
        "sha256": digest,
    }


# ---------------------------------------------------------------------------
# XT: gamedata\xt\amax.bin
# ---------------------------------------------------------------------------

def load_xt(pak: Path, logical_path: str) -> tuple[dict, bytes]:
    index = pak_index(pak)
    entry = next((row for row in index["entries"] if row["path"] == logical_path), None)
    if entry is None:
        raise SystemExit(f"missing pak entry {logical_path}")
    data = extract_zlib_entry(pak, entry)
    return car_xt.parse(data), data


def _record_name(xt: dict, data: bytes, rec: dict) -> str | None:
    if rec["stringBytes"] == 0:
        return None
    try:
        blob = car_xt._string_blob(xt, rec)
    except IndexError:
        return None
    offset = struct.unpack_from("<I", data, rec["dataOffset"])[0]
    if offset >= len(blob):
        return None
    end = blob.find(b"\0", offset)
    return blob[offset:end].decode("ascii", "replace")


def _sz8(xt: dict, data: bytes, rec: dict, offset: int) -> str | None:
    string_offset = struct.unpack_from("<I", data, rec["dataOffset"] + offset)[0]
    blob = car_xt._string_blob(xt, rec)
    if string_offset >= len(blob):
        return None
    end = blob.find(b"\0", string_offset)
    return blob[string_offset:end].decode("ascii", "replace")


def load_amax() -> dict:
    """Return {vehicles, refs, wheel_models, sha256, bytes} for amax.bin."""
    xt, data = load_xt(AMAX_BIN, AMAX_PATH)
    refs_table = xt["tables"]["refs"]
    width = refs_table["units"]
    refs = [struct.unpack_from("<I2H", data, refs_table["offset"] + i * width)
            for i in range(refs_table["count"])]
    records = {rec["id"]: rec for rec in xt["records"] if rec["id"] != 0xFFFFFFFF}
    names = {rec_id: _record_name(xt, data, rec) for rec_id, rec in records.items()}

    def resolve(handle: int | None) -> dict | None:
        if handle is None or handle >= len(refs):
            return None
        record_id, type_id, _ = refs[handle]
        rec = records.get(record_id)
        return {
            "refIndex": handle,
            "recordId": record_id,
            "typeId": type_id,
            "typeName": xt["types"][type_id]["name"] if type_id < len(xt["types"]) else None,
            "tag": names.get(record_id),
            "record": rec,
        }

    type_index = next(t["index"] for t in xt["types"] if t["name"] == "AmaxVehicle")
    leaves = {leaf["name"]: leaf for leaf in car_xt.leaves(xt, type_index)}

    def raw(rec: dict, field: str, size: int = 4, signed: bool = False) -> int:
        code = {1: "B", 2: "H", 4: "I"}[size]
        value = struct.unpack_from("<" + code, data, rec["dataOffset"] + leaves[field]["offset"])[0]
        if signed:
            sign = 1 << (size * 8 - 1)
            return value - (1 << (size * 8)) if value & sign else value
        return value

    def handle(rec: dict, field: str) -> int | None:
        value = raw(rec, field)
        return None if value == 0xFFFFFFFF else value

    vehicles = []
    wheel_models = {}
    for rec in xt["records"]:
        if rec["type"] != type_index:
            continue
        dynamics = resolve(handle(rec, "dynamics"))
        ai_dynamics = resolve(handle(rec, "aiDynamics"))
        parent = resolve(handle(rec, "parentVehicle"))
        wheel = resolve(handle(rec, "wheelModel"))
        wheel_file = None
        if wheel and wheel["record"] is not None:
            wheel_file = _sz8(xt, data, wheel["record"], leaves_offset(xt, "AmaxWheelModel", "fileName"))
            wheel_models[wheel["recordId"]] = {
                "recordId": wheel["recordId"],
                "tag": wheel["tag"],
                "fileName": wheel_file,
            }
        vehicles.append({
            "tag": _record_name(xt, data, rec),
            "recordId": rec["id"],
            "dynamics": dynamics,
            "aiDynamics": ai_dynamics,
            "parent": parent,
            "wheel": wheel,
            "wheelFileName": wheel_file,
            "use": bool(raw(rec, "use")),
            "doNotShowInGame": bool(raw(rec, "DoNotShowInGame")),
            "locked": bool(raw(rec, "Locked")),
            "contentPack": raw(rec, "ContentPack", 2),
            "carClass": raw(rec, "class", 4, signed=True),
            "icon": _sz8(xt, data, rec, leaves["UiIconName"]["offset"]),
        })
    return {
        "vehicles": vehicles,
        "refs": refs,
        "wheelModels": wheel_models,
        "sha256": sha256_bytes(data),
        "bytes": len(data),
        "records": len(xt["records"]),
    }


def leaves_offset(xt: dict, type_name: str, field_name: str) -> int:
    type_index = next(t["index"] for t in xt["types"] if t["name"] == type_name)
    for leaf in car_xt.leaves(xt, type_index):
        if leaf["name"] == field_name:
            return leaf["offset"]
    raise KeyError(f"{type_name}.{field_name}")


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------

def build_document(write: bool = True, skip_models: bool = False) -> dict:
    cars = json.loads(CARS_JSON.read_text(encoding="utf-8"))
    amax = load_amax()
    index = pak_index(PAK)
    pak_rows = {row["path"].lower(): row for row in index["entries"] if not row["directory"]}

    by_dynamics = {}
    by_ai = {}
    for vehicle in amax["vehicles"]:
        if vehicle["dynamics"] and vehicle["dynamics"]["recordId"]:
            by_dynamics.setdefault(vehicle["dynamics"]["recordId"], []).append(vehicle)
        if vehicle["aiDynamics"] and vehicle["aiDynamics"]["recordId"]:
            by_ai.setdefault(vehicle["aiDynamics"]["recordId"], []).append(vehicle)

    # Size baseline for the "placeholder" argument (real car bodies are MBs).
    real_sizes = sorted(
        row["logical_bytes"] for row in index["entries"]
        if not row["directory"] and row["path"].lower().startswith(VEHICLE_PREFIX.rstrip("\\").lower() + "\\")
        and row["path"].lower().endswith(".model") and "\\wheels\\" not in row["path"].lower()
    )
    median_real = real_sizes[len(real_sizes) // 2] if real_sizes else 0

    records = []
    for record in cars["records"]:
        if record["class"] != "C":
            continue
        vehicles = by_dynamics.get(record["id"], [])
        ai_vehicles = by_ai.get(record["id"], [])
        bases = [v for v in vehicles if v["parent"] is None]
        primary = bases[0] if len(bases) == 1 else (vehicles[0] if len(vehicles) == 1 else None)

        entry = {
            "index": record["index"],
            "id": record["id"],
            "name": record["name"],
            "slug": record["slug"],
            "drivetrain": record["drivetrain"],
            "mass": record["mass"],
            "recordNameStem": record["name"].strip().lower(),
            "status": "unsupported",
            "identity": None,
            "explicitVehicles": [],
            "additionalExplicitModels": [],
            "intendedModel": None,
            "wheelModel": None,
            "recordNameSimilarityToIntendedModelStem": None,
            "nameSimilarityUsed": False,
            "missingEvidence": [],
            "reason": "",
        }

        for vehicle in vehicles:
            entry["explicitVehicles"].append({
                "amaxTag": vehicle["tag"],
                "amaxRecordId": vehicle["recordId"],
                "refIndex": vehicle["dynamics"]["refIndex"],
                "parentAmaxTag": vehicle["parent"]["tag"] if vehicle["parent"] else None,
                "use": vehicle["use"],
                "doNotShowInGame": vehicle["doNotShowInGame"],
                "carClass": vehicle["carClass"],
                "wheelRecord": vehicle["wheel"]["tag"] if vehicle["wheel"] else None,
                "wheelFileName": vehicle["wheelFileName"],
            })

        if not vehicles:
            entry["missingEvidence"] = [
                f"no AmaxVehicle.dynamics handle in {AMAX_PATH} resolves to RP_CarDynamics id {record['id']}",
                f"no AmaxVehicle.aiDynamics handle resolves to it either ({len(ai_vehicles)} AI references)",
                "the shipped engine only assigns a body from an AmaxVehicle tag "
                "(LevelState.cpp:334); DefaultCar is the physics fallback name (LevelState.cpp:407)",
            ]
            default_row = pak_rows.get((VEHICLE_PREFIX + "default.model").lower())
            if default_row:
                entry["nearestPakModel"] = {
                    "pakPath": default_row["path"],
                    "logicalBytes": default_row["logical_bytes"],
                    "medianRealCarBytes": median_real,
                    "isPlaceholder": default_row["logical_bytes"] < 1_000_000,
                }
                entry["missingEvidence"].append(
                    f"\\models\\vehicles\\default.model exists but is {default_row['logical_bytes']} bytes "
                    f"(median real car body {median_real} bytes); it is not referenced as a DefaultCar body"
                )
            entry["reason"] = (
                "unsupported: no vehicle record and no body model reference; DefaultCar is a physics "
                "fallback, not a car body"
            )
            records.append(entry)
            continue

        if primary is None:
            entry["missingEvidence"] = [
                "multiple base AmaxVehicle records reference the same RP_CarDynamics record; "
                "the body identity is ambiguous without an event/racebook selection",
            ]
            entry["reason"] = "unsupported: ambiguous body identity"
            records.append(entry)
            continue

        tag = primary["tag"]
        model_path = VEHICLE_PREFIX + tag.lower() + ".model"
        model_row = pak_rows.get(model_path.lower())
        wheel_path = None
        wheel_row = None
        if primary["wheelFileName"]:
            wheel_path = WHEEL_PREFIX + primary["wheelFileName"].lower() + ".model"
            wheel_row = pak_rows.get(wheel_path.lower())

        if model_row is None:
            entry["missingEvidence"] = [
                f"AmaxVehicle tag {tag!r} resolves to {model_path}, which is absent from root.pak",
            ]
            entry["reason"] = f"unsupported: AmaxVehicle tag {tag!r} has no body model in the pak"
            records.append(entry)
            continue
        if not primary["use"]:
            entry["missingEvidence"] = [
                f"AmaxVehicle {tag!r} has use=false; the engine replaces the body with "
                "shelby_mustanggt500_stock.model (LevelState.cpp:339-345)",
            ]
            entry["reason"] = "unsupported: vehicle is not used"
            records.append(entry)
            continue
        if wheel_row is None:
            entry["missingEvidence"] = [
                f"AmaxVehicle {tag!r} wheel fileName {primary['wheelFileName']!r} resolves to "
                f"{wheel_path}, which is absent from root.pak",
            ]
            entry["reason"] = "unsupported: wheel model missing"
            records.append(entry)
            continue

        model = {
            "pakPath": model_row["path"],
            "stem": tag.lower(),
            "logicalBytes": model_row["logical_bytes"],
            "storedBytes": model_row["stored_bytes"],
            "pakOffset": model_row["offset"],
        }
        wheel = {
            "pakPath": wheel_row["path"],
            "stem": primary["wheelFileName"].lower(),
            "logicalBytes": wheel_row["logical_bytes"],
            "storedBytes": wheel_row["stored_bytes"],
            "pakOffset": wheel_row["offset"],
        }
        if not skip_models:
            model.update(decode_model(model_row, model["stem"], CMODELS / "body"))
            wheel.update(decode_model(wheel_row, wheel["stem"], CMODELS / "wheels"))

        entry.update({
            "status": "provable",
            "identity": {
                "kind": "amax.bin AmaxVehicle.dynamics FlaskHandle",
                "amaxRefIndex": primary["dynamics"]["refIndex"],
                "amaxRecordId": primary["recordId"],
                "amaxTag": tag,
                "rpRecordId": record["id"],
                "rpType": primary["dynamics"]["typeName"],
                "parentAmaxTag": primary["parent"]["tag"] if primary["parent"] else None,
                "use": primary["use"],
                "doNotShowInGame": primary["doNotShowInGame"],
                "handleResolvesToExactRecordId": primary["dynamics"]["recordId"] == record["id"],
            },
            "intendedModel": model,
            "wheelModel": wheel,
            "recordNameSimilarityToIntendedModelStem": similarity(record["name"], model["stem"]),
            "reason": (
                f"provable: AmaxVehicle {tag!r} (record {primary['recordId']}) carries this exact "
                f"RP_CarDynamics id via its dynamics handle; the engine builds {model_path} from the tag"
            ),
        })
        for vehicle in vehicles:
            if vehicle is primary:
                continue
            alt_path = VEHICLE_PREFIX + vehicle["tag"].lower() + ".model"
            alt_row = pak_rows.get(alt_path.lower())
            entry["additionalExplicitModels"].append({
                "amaxTag": vehicle["tag"],
                "amaxRecordId": vehicle["recordId"],
                "parentAmaxTag": vehicle["parent"]["tag"] if vehicle["parent"] else None,
                "pakPath": alt_row["path"] if alt_row else alt_path,
                "exists": alt_row is not None,
                "logicalBytes": alt_row["logical_bytes"] if alt_row else None,
            })
        records.append(entry)

    provable = [r for r in records if r["status"] == "provable"]
    unique_models = {}
    unique_wheels = {}
    for row in provable:
        unique_models[row["intendedModel"]["pakPath"].lower()] = row["intendedModel"]
        unique_wheels[row["wheelModel"]["pakPath"].lower()] = row["wheelModel"]

    counts = {
        "records": len(records),
        "provable": len(provable),
        "unsupported": len(records) - len(provable),
        "uniqueIntendedModels": len(unique_models),
        "intendedModelLogicalBytes": sum(m["logicalBytes"] for m in unique_models.values()),
        "uniqueWheelModels": len(unique_wheels),
        "wheelModelLogicalBytes": sum(m["logicalBytes"] for m in unique_wheels.values()),
        "additionalExplicitModels": sum(len(r["additionalExplicitModels"]) for r in records),
        "recordsWithMultipleExplicitVehicles": sum(1 for r in records if len(r["explicitVehicles"]) > 1),
        "recordsWhereRecordNameEqualsAmaxTag": sum(
            1 for r in records if r["identity"] and r["name"].strip().lower()
            == r["identity"]["amaxTag"].lower()),
    }

    document = {
        "kind": "blur.vehicle-c-aliases",
        "version": 1,
        "status": "PASS" if counts["records"] == 15 else "FAIL",
        "generatedBy": "probes/vehicle-pipeline/tools/audit_c_aliases.py",
        "rule": {
            "identity": "AmaxVehicle.dynamics FlaskHandle -> refs[h] -> RP_CarDynamics record id",
            "bodyModel": "\\models\\vehicles\\<AmaxVehicle tag>.model (shipped engine rule)",
            "wheelModel": "\\models\\vehicles\\wheels\\<AmaxWheelModel.fileName>.model (shipped engine rule)",
            "rejected": "string similarity to the record name is recorded, never used as a mapping",
            "fallback": "a missing or unused body becomes shelby_mustanggt500_stock.model; that is not a proof",
        },
        "sources": {
            "cars": {"path": rel(CARS_JSON), "sha256": sha256_file(CARS_JSON)},
            "amax": {"pakPath": AMAX_PATH, "sha256": amax["sha256"], "bytes": amax["bytes"],
                     "records": amax["records"]},
            "pak": {"path": rel(PAK), "bytes": PAK.stat().st_size, "entries": index["entry_count"]},
            "formats": [
                {"path": "probes/asset-reader/FORMAT-xt.md", "line": 27,
                 "sha256": sha256_file(ROOT / "probes/asset-reader/FORMAT-xt.md"),
                 "meaning": "FlaskHandle is 4 bytes (U32 id)"},
            ],
            "engineRule": RULE_CITATIONS,
        },
        "counts": counts,
        "records": records,
        "uniqueIntendedModels": sorted(unique_models.values(), key=lambda m: m["pakPath"]),
        "uniqueWheelModels": sorted(unique_wheels.values(), key=lambda m: m["pakPath"]),
        "limits": [
            "Data/identity audit only; no car was added to the E1 roster and no drive claim is made.",
            "The body model is the one the shipped engine would load for the AmaxVehicle tag; "
            "paint, damage, LOD and runtime material state are out of scope.",
            "Staging manifest/material results are recorded separately in c-staging-results.json.",
            "No full-game claim.",
        ],
    }
    if write:
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "c-aliases.json").write_bytes(
            (json.dumps(document, indent=1, sort_keys=True) + "\n").encode("utf-8"))
    return document


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-models", action="store_true",
                        help="do not decode body/wheel model bytes (identity only)")
    args = parser.parse_args()

    document = build_document(write=True, skip_models=args.skip_models)
    counts = document["counts"]
    print(json.dumps({
        "status": document["status"],
        "counts": counts,
        "records": [
            {"index": r["index"], "name": r["name"], "status": r["status"],
             "intendedModel": (r["intendedModel"] or {}).get("pakPath"),
             "identity": (r["identity"] or {}).get("amaxTag")}
            for r in document["records"]
        ],
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
