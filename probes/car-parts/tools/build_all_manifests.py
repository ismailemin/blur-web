"""Map the E1 roster cars to their real `.model` files and build one manifest each.

Mapping evidence (no guessing):
  * the roster gives a record name (`Corvette_ZR1_Stock`) and id;
  * the model is the root.pak entry `\\models\\vehicles\\<lowercased name>.model`;
  * the committed PAK reader (`tools/inspect_asset_layout.pak_index`, the same
    index the asset probes use) must return exactly one case-insensitive match,
    and every other `\\models\\vehicles\\*.model` entry whose name starts with the
    normalised name must be listed in the evidence so the exclusion of `_race`,
    `_legend_*` and `_tuner` variants is visible;
  * the extracted bytes are decoded with the committed packet-zlib decoder
    (`tools/prepare_asset_fixture.decode_packet_zlib`) and hashed;
  * the committed `scene_inspect.exe` and `model_inspect.exe` must accept the
    file, and `build_manifest.py` must produce a complete manifest.

A car that cannot be mapped unambiguously is recorded as unmapped with the
reason; it is never given a guessed model, and the drive slice keeps the
Corvette C3 body for it under a labelled reason.

Outputs (all ignored by Git):
  _work/car-parts/models/<sha>.decoded + .source.json   decoded models
  _work/car-parts/cars/<slug>/manifest.json + mesh.json + scene-report.json
  _work/car-parts/cars/index.json                       the mapping evidence

Usage:
  python probes/car-parts/tools/build_all_manifests.py [--roster <path>] [--force]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from inspect_asset_layout import pak_index  # noqa: E402  (committed reader)
from prepare_asset_fixture import decode_packet_zlib  # noqa: E402  (committed decoder)

ROSTER_DEFAULT = ROOT / "probes/e1-drive/cars/roster.json"
PAK = ROOT / "game-data/Blur/cache/root.pak"
MODELS_DIR = ROOT / "_work/car-parts/models"
CARS_DIR = ROOT / "_work/car-parts/cars"
SCENE_EXE = ROOT / "_work/build/asset-reader-native/Release/scene_inspect.exe"
MODEL_EXE = ROOT / "_work/build/asset-reader-native/Release/model_inspect.exe"
BUILD = ROOT / "probes/car-parts/tools/build_manifest.py"
VEHICLE_PREFIX = "\\models\\vehicles\\"

# The unmapped fallback. The E1 drive slice draws this committed asset only for a
# car that has no mapped model, labelled with the reason.
FALLBACK_MODEL = ROOT / "_work/car-level-assets/corvette_c3_race.model.decoded"
FALLBACK_SLUG = "corvette-c3-race"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalise(name: str) -> str:
    return name.strip().lower()


def map_car(car: dict, vehicles: list[dict], wheel_models: dict[str, str]) -> dict:
    """Return the mapping record for one roster car; never guesses."""
    wanted = normalise(car["name"]) + ".model"
    exact = [row for row in vehicles if Path(row["path"]).name.lower() == wanted]
    prefix = [row for row in vehicles
              if Path(row["path"]).name.lower().startswith(normalise(car["name"]))]
    record = {
        "slug": car["slug"],
        "name": car["name"],
        "record": {"index": car["recordIndex"], "id": car["recordId"]},
        "normalisedName": normalise(car["name"]),
        "expectedPath": VEHICLE_PREFIX + wanted,
        "rule": "exact normalised model file name under \\models\\vehicles\\",
        "prefixCandidates": sorted(row["path"] for row in prefix),
        "wheelsResource": wheel_models.get(wanted),
        "wheelsResourceReason":
            "a separate cosmetic wheel .model exists under \\models\\vehicles\\wheels\\; this manifest "
            "uses the body model's own e_wheel_* subtree, which carries the tyre/rim/disc/caliper "
            "geometry and the rest-pose transforms, and does not claim the separate resource",
        "mapped": False,
        "reason": None,
    }
    if len(exact) != 1:
        record["reason"] = (
            "no unique model file: expected " + VEHICLE_PREFIX + wanted +
            ", found " + str(len(exact)) + " exact candidate(s)")
        return record
    row = exact[0]
    record.update({
        "mapped": True,
        "pak": "root.pak",
        "pakPath": row["path"],
        "pakOffset": row["offset"],
        "pakStoredBytes": row["stored_bytes"],
        "pakLogicalBytes": row["logical_bytes"],
        "pakFatIndex": row["fat_index"],
        "pakPathCrc32": row["path_crc32"],
        "logicalBytes": row["logical_bytes"],
    })
    return record


def extract(record: dict, force: bool) -> dict:
    """Decode the mapped pak entry; the decoded file name is its SHA-256."""
    if not record["mapped"]:
        return record
    with PAK.open("rb") as stream:
        stream.seek(record["pakOffset"])
        packed = stream.read(record["pakStoredBytes"])
    decoded = decode_packet_zlib(packed, record["logicalBytes"])
    digest = sha256(decoded)
    if len(decoded) != record["logicalBytes"]:
        raise SystemExit(f"decoded length mismatch for {record['pakPath']}")
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    target = MODELS_DIR / (digest + ".decoded")
    if force or not target.exists():
        target.write_bytes(decoded)
    elif sha256(target.read_bytes()) != digest:
        raise SystemExit(f"existing decoded model {target} does not match the pak bytes")
    source = {
        "pak": "root.pak",
        "path": record["pakPath"],
        "directory": False,
        "offset": record["pakOffset"],
        "stored_bytes": record["pakStoredBytes"],
        "logical_bytes": record["logicalBytes"],
        "path_crc32": record["pakPathCrc32"],
        "fat_index": record["pakFatIndex"],
        "sha256": digest,
        "decodedFile": str(target.relative_to(ROOT)).replace("\\", "/"),
        "packetCount": (len(decoded) + 65535) // 65536,
        "car": {"slug": record["slug"], "name": record["name"], "record": record["record"]},
    }
    target.with_suffix(".source.json").write_text(json.dumps(source, indent=2) + "\n", encoding="utf-8")
    record["modelSha256"] = digest
    record["decodedModel"] = str(target.relative_to(ROOT)).replace("\\", "/")
    record["modelSource"] = str(target.with_suffix(".source.json").relative_to(ROOT)).replace("\\", "/")
    record["packetCount"] = source["packetCount"]
    return record


def build_manifest(record: dict, force: bool) -> dict:
    if not record["mapped"]:
        return record
    out_dir = CARS_DIR / record["slug"]
    if force:
        shutil.rmtree(out_dir, ignore_errors=True)
    mapping_text = (
        f"roster name {record['name']} (record {record['record']['index']}/{record['record']['id']}) "
        f"-> normalised '{record['normalisedName']}' -> exact pak entry {record['pakPath']} "
        f"({record['logicalBytes']} logical bytes, SHA-256 {record['modelSha256']}); "
        f"{len(record['prefixCandidates'])} prefix candidate(s) recorded and excluded by exact name"
    )
    command = [
        sys.executable, str(BUILD),
        "--model", record["decodedModel"],
        "--scene-exe", str(SCENE_EXE),
        "--model-exe", str(MODEL_EXE),
        "--out-dir", str(out_dir),
        "--car-slug", record["slug"],
        "--car-name", record["name"],
        "--car-mapping", mapping_text,
        "--model-pak-path", record["pakPath"],
    ]
    completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if completed.returncode != 0:
        record["mapped"] = False
        record["reason"] = "manifest build failed: " + (completed.stderr.strip() or completed.stdout.strip())
        return record
    summary = json.loads(completed.stdout)
    manifest_path = Path(summary["manifest"])
    mesh_path = Path(summary["mesh"])
    built = json.loads(manifest_path.read_text(encoding="utf-8"))
    record.update({
        "manifest": str(manifest_path.relative_to(ROOT)).replace("\\", "/"),
        "manifestSha256": "sha256:" + summary["manifestSha256"],
        "manifestBytes": summary["manifestBytes"],
        "mesh": str(mesh_path.relative_to(ROOT)).replace("\\", "/"),
        "meshSha256": "sha256:" + summary["meshSha256"],
        "meshPositionsSha256": "sha256:" + summary["meshPositionsSha256"],
        "meshIndicesSha256": "sha256:" + summary["meshIndicesSha256"],
        "sceneReport": str(Path(summary["sceneReport"]).relative_to(ROOT)).replace("\\", "/"),
        "vertexCount": built["mesh"]["vertexCount"],
        "indexCount": built["mesh"]["indexCount"],
        "draws": summary["diagnostics"]["drawCount"],
        "parts": summary["diagnostics"]["partCount"],
        "namedParts": summary["diagnostics"]["namedPartCount"],
        "wheelDraws": summary["diagnostics"]["wheelDrawCount"],
        "provenWheelDraws": summary["diagnostics"]["provenWheelDrawCount"],
        "ambiguousWheelDraws": summary["diagnostics"]["ambiguousWheelDrawCount"],
        "tyreDraws": summary["diagnostics"]["tyreDrawCount"],
        "rimDraws": summary["diagnostics"]["rimDrawCount"],
        "brakeDiscDraws": summary["diagnostics"]["brakeDiscDrawCount"],
        "brakeCaliperDraws": summary["diagnostics"]["brakeCaliperDrawCount"],
        "diagnostics": summary["diagnostics"],
        "tyres": summary["tyres"],
        "wheelKindCounts": summary["wheelKindCounts"],
        "wheelGroups": summary["wheelGroups"],
    })
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--roster", type=Path, default=ROSTER_DEFAULT)
    parser.add_argument("--force", action="store_true", help="rebuild even if outputs exist")
    args = parser.parse_args()

    roster = json.loads(args.roster.read_text(encoding="utf-8"))
    if roster.get("kind") != "e1-drive.car-roster":
        raise SystemExit("roster is not an e1-drive.car-roster")
    index = pak_index(PAK)
    if index["status"] != "indexed":
        raise SystemExit("root.pak index is not readable: " + str(index.get("status")))
    vehicles = [row for row in index["entries"]
                if not row["directory"] and row["path"].lower().startswith(VEHICLE_PREFIX)
                and not row["path"].lower().startswith(VEHICLE_PREFIX + "wheels\\")
                and row["path"].lower().endswith(".model")]
    wheel_models = {Path(row["path"]).name.lower(): row["path"] for row in index["entries"]
                    if not row["directory"]
                    and row["path"].lower().startswith(VEHICLE_PREFIX + "wheels\\")
                    and row["path"].lower().endswith(".model")}

    CARS_DIR.mkdir(parents=True, exist_ok=True)
    cars = []
    for car in roster["cars"]:
        record = extract(map_car(car, vehicles, wheel_models), args.force)
        record = build_manifest(record, args.force)
        cars.append(record)
        state = "mapped" if record["mapped"] else "UNMAPPED"
        detail = record.get("pakPath") or record["reason"]
        print(f"{record['slug']}: {state} {detail}", flush=True)

    fallback = {
        "slug": FALLBACK_SLUG,
        "path": str(FALLBACK_MODEL.relative_to(ROOT)).replace("\\", "/"),
        "sha256": "sha256:" + sha256(FALLBACK_MODEL.read_bytes()),
        "reason": "committed Corvette C3 race model; used only for a roster car without a mapped model",
    }
    mapped = [record["slug"] for record in cars if record["mapped"]]
    unmapped = [{"slug": record["slug"], "reason": record["reason"]}
                for record in cars if not record["mapped"]]
    document = {
        "kind": "car-parts.car-model-index",
        "version": 1,
        "generator": "probes/car-parts/tools/build_all_manifests.py",
        "roster": {
            "path": str(args.roster.relative_to(ROOT)).replace("\\", "/"),
            "sha256": "sha256:" + sha256(args.roster.read_bytes()),
            "default": roster.get("default"),
        },
        "pak": {
            "path": "game-data/Blur/cache/root.pak",
            "file_bytes": index["bytes"],
            "entry_count": index["entry_count"],
            "file_count": index["file_count"],
            "codec": index["codec_name"],
            "vehicleModelCount": len(vehicles),
            "vehicleWheelModelCount": len(wheel_models),
            "reader": "tools/inspect_asset_layout.pak_index (committed PAK index reader)",
            "decoder": "tools/prepare_asset_fixture.decode_packet_zlib (committed packet-zlib decoder)",
        },
        "mappingRule": (
            "exact normalised model file name under \\models\\vehicles\\; the roster name lowercased "
            "plus '.model' must match exactly one pak entry, and every other prefix candidate is "
            "recorded so variant exclusions are visible"
        ),
        "cars": cars,
        "mapped": mapped,
        "unmapped": unmapped,
        "allMapped": len(unmapped) == 0,
        "fallback": fallback,
    }
    (CARS_DIR / "index.json").write_text(json.dumps(document, indent=1, sort_keys=True) + "\n",
                                        encoding="utf-8")
    print(json.dumps({
        "index": str((CARS_DIR / "index.json").relative_to(ROOT)).replace("\\", "/"),
        "mapped": len(mapped),
        "unmapped": unmapped,
        "cars": [{
            "slug": record["slug"],
            "mapped": record["mapped"],
            "pakPath": record.get("pakPath"),
            "modelSha256": record.get("modelSha256"),
            "manifestSha256": record.get("manifestSha256"),
            "vertices": record.get("vertexCount"),
            "draws": record.get("draws"),
            "parts": record.get("parts"),
            "wheelDraws": record.get("wheelDraws"),
            "ambiguousWheelDraws": record.get("ambiguousWheelDraws"),
        } for record in cars],
    }, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
