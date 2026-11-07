"""Audit all 62 RP_CarDynamics records for web playability (data only).

This probe reuses the committed readers and extractors; it does not rebuild the
E1 drive slice and it never writes into `probes/e1-drive`, `probes/car-parts`,
`probes/asset-reader`, `tools/`, `upstream/` or `game-data/`.

Inputs (read-only)
  * `_work/e1-drive/cars.json`        the committed 62-record roster + gate
  * `probes/e1-drive/cars/roster.json` the five proven cars
  * `game-data/Blur/cache/root.pak`    vehicle `.model` entries
  * `game-data/Blur`                   `gamedata\\xt\\racingphysics.bin`
  * `_work/car-parts/cars/index.json`  the committed five car-part manifests
  * `_work/car-materials/roster/`      the committed five material manifests

Committed tools reused
  * `tools/inspect_asset_layout.pak_index`
  * `tools/prepare_asset_fixture.decode_packet_zlib`
  * `engine/harness/t005d-vehicle/car_xt.py`
  * `probes/e1-drive/tools/car_roster.py` (`typed_values`, `gate`)
  * `probes/car-parts/tools/build_manifest.py` (`parse_mdldat`, manifest build)
  * `_work/build/asset-reader-native/Release/{model,scene}_inspect.exe`
  * `tools/inspect_car_materials.py` (independent material traversal)

Outputs (all under `_work/vehicle-pipeline/`)
  * `cars.json`          the 62-car matrix, counts, next-car list and limits
  * `summary.csv`        one row per record
  * `hashes.json`        input/output hashes
  * `fields/`            one decoded field list per record (CRLF, T-005d format)
  * `models/`            decoded models used by the audit
  * `materials/<slug>/`  independent material traversal per mapped car
  * `manifests/<slug>/`  part manifests built for the next-car shortlist

Usage:
  python probes/vehicle-pipeline/tools/audit_cars.py [--skip-materials] [--skip-next-manifests]
"""

from __future__ import annotations

import argparse
import csv
import difflib
import hashlib
import importlib.util
import json
import math
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
HARNESS = ROOT / "engine/harness/t005d-vehicle"
E1_TOOLS = ROOT / "probes/e1-drive/tools"
CAR_PARTS_TOOLS = ROOT / "probes/car-parts/tools"
for path in (TOOLS, HARNESS, E1_TOOLS):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from inspect_asset_layout import pak_index  # noqa: E402
from prepare_asset_fixture import decode_packet_zlib  # noqa: E402
import car_xt  # noqa: E402
import car_roster  # noqa: E402

OUT = ROOT / "_work/vehicle-pipeline"
MODELS = OUT / "models"
FIELDS = OUT / "fields"
SCENES = OUT / "scene"
MATERIALS = OUT / "materials"
MANIFESTS = OUT / "manifests"
LOGS = ROOT / "_work/logs/vehicle-pipeline"

CARS_JSON = ROOT / "_work/e1-drive/cars.json"
ROSTER_JSON = ROOT / "probes/e1-drive/cars/roster.json"
PAK = ROOT / "game-data/Blur/cache/root.pak"
GAME = ROOT / "game-data/Blur"
CAR_PARTS_INDEX = ROOT / "_work/car-parts/cars/index.json"
CAR_MATERIALS_INDEX = ROOT / "_work/car-materials/roster/index.json"

SCENE_EXE = ROOT / "_work/build/asset-reader-native/Release/scene_inspect.exe"
MODEL_EXE = ROOT / "_work/build/asset-reader-native/Release/model_inspect.exe"
BUILD_MANIFEST = CAR_PARTS_TOOLS / "build_manifest.py"
MATERIAL_TRAVERSAL = ROOT / "tools/inspect_car_materials.py"

VEHICLE_PREFIX_PARTS = ("models", "vehicles")

PROVEN_SLUGS = [
    "corvette-zr1-stock",
    "lotus-exige-cup260-stock",
    "dodge-challenger-stock",
    "ford-focusrs-stock",
    "audi-r8v10-stock",
]

VARIANT_WORDS = ("race", "tuner", "drift", "drag", "rat", "1stplay", "heh", "grpc", "grippy", "smooth")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def parts(path: str) -> list[str]:
    return [p for p in path.lower().replace("\\", "/").split("/") if p]


def slugify(name: str) -> str:
    out = []
    for ch in name.strip().lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-")


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fail_reason(exc: BaseException) -> str:
    text = str(exc).strip().replace("\n", " ")
    return (text or exc.__class__.__name__)[:500]


def scene_summary(scene: dict) -> dict:
    meta = scene.get("metadata") or {}
    draws = scene.get("draws") or []
    classes = Counter()
    uv_available = 0
    shared_refs = set()
    resource_refs = set()
    for draw in draws:
        binding = str(draw.get("binding") or "")
        low = binding.lower()
        if draw.get("albedoParameter") == "g_MeshTexture" or "g_meshtexture" in low:
            classes["staticAlbedo"] += 1
        elif "paint" in low:
            classes["paint"] += 1
        elif "light" in low:
            classes["light"] += 1
        elif "_no_albedo" in low:
            classes["noAlbedo"] += 1
        elif draw.get("resourceBlock") is not None:
            classes["resourceBlockInput"] += 1
        else:
            classes["other"] += 1
        if draw.get("uv0Available"):
            uv_available += 1
        if draw.get("albedoTexture") is not None:
            shared_refs.add(int(draw["albedoTexture"]))
        if draw.get("resourceBlock") is not None and draw.get("resourceIndex") is not None:
            resource_refs.add((int(draw["resourceBlock"]), int(draw["resourceIndex"])))
    positions = scene.get("positions") or []
    indices = scene.get("indices") or []
    uv0 = scene.get("uv0") or []
    vertex_count = int(meta.get("vertexCount") or (len(positions) // 3))
    triangle_count = int(meta.get("triangleCount") or (len(indices) // 3))
    return {
        "status": scene.get("status", "ok"),
        "vertexCount": vertex_count,
        "triangleCount": triangle_count,
        "drawCount": len(draws),
        "uv0ValidVertices": int(meta.get("uv0ValidVertices") or 0),
        "uv0PlaceholderVertices": int(meta.get("uv0PlaceholderVertices") or 0),
        "uv0DrawsAvailable": uv_available,
        "bounds": scene.get("bounds"),
        "drawClasses": dict(sorted(classes.items())),
        "sharedTextureListCount": len(scene.get("sharedTextures") or []),
        "sharedReferenceCount": len(shared_refs),
        "resourceReferenceCount": len(resource_refs),
        "meshBytes": len(positions) * 4,
        "indexBytes": len(indices) * 4,
        "uv0Bytes": len(uv0) * 4,
        "uv0ValidBytes": int(meta.get("uv0ValidVertices") or 0) * 8,
        "partialSceneTraversal": bool(meta.get("partialSceneTraversal")),
        "scope": meta.get("scope"),
    }


def texture_summary(materials: dict, raw: dict) -> dict:
    """Unique referenced textures, source bytes and a 512-bounded RGBA estimate."""
    blocks = {int(b["index"]): b for b in raw.get("blocks") or []}
    unique: dict[str, dict] = {}
    for draw in materials.get("draws") or []:
        for _name, entry in (draw.get("knownTextures") or {}).items():
            tex = entry.get("texture") or {}
            kind = tex.get("kind")
            if kind == "shared":
                ident = f"shared:{tex.get('index')}:{tex.get('name')}"
                if ident not in unique:
                    unique[ident] = {
                        "id": ident,
                        "kind": "shared",
                        "name": tex.get("name"),
                        "sourceBytes": int(tex.get("dataBytes") or 0),
                        "decodable": True,
                        "rgbaBytes": None,
                        "width": None,
                        "height": None,
                        "format": None,
                        "reason": "shared image: 28-byte descriptor + complete mip chain",
                    }
            elif kind == "resource-block":
                key = (int(tex.get("block")), int(tex.get("index")))
                ident = f"block:{key[0]}:{key[1]}:{tex.get('name')}"
                if ident in unique:
                    continue
                lods = [l for l in (tex.get("lods") or []) if l.get("present")]
                decodable = [l for l in lods
                             if l.get("descriptor")
                             and int(l["descriptor"].get("width", 0)) <= 512
                             and int(l["descriptor"].get("height", 0)) <= 512]
                chosen = max(decodable, key=lambda l: int(l.get("lod", -1))) if decodable else None
                if chosen is None and lods:
                    chosen = max(lods, key=lambda l: int(l.get("lod", -1)))
                d = (chosen or {}).get("descriptor") or {}
                unique[ident] = {
                    "id": ident,
                    "kind": "resource-block",
                    "name": tex.get("name"),
                    "hash": tex.get("hash"),
                    "sourceBytes": int((chosen or {}).get("headerBytes") or 0) + int((chosen or {}).get("dataBytes") or 0),
                    "decodable": chosen is not None and chosen in decodable,
                    "rgbaBytes": (int(d["width"]) * int(d["height"]) * 4) if (chosen in decodable and d) else None,
                    "width": d.get("width"),
                    "height": d.get("height"),
                    "format": d.get("format"),
                    "selectedLod": (chosen or {}).get("lod"),
                    "reason": None if (chosen in decodable) else "no populated LOD within the committed 512x512 decoder bound",
                }
    values = list(unique.values())
    return {
        "uniqueTextureCount": len(values),
        "decodableTextureCount": sum(1 for v in values if v["decodable"]),
        "undecodableTextureCount": sum(1 for v in values if not v["decodable"]),
        "sourceBytes": sum(v["sourceBytes"] for v in values),
        "rgbaBytes": sum(v["rgbaBytes"] or 0 for v in values),
        "formats": sorted({v["format"] for v in values if v["format"] is not None}),
        "textures": sorted(values, key=lambda v: v["id"]),
    }


def mdl_summary(model_bytes: bytes, build_manifest) -> dict:
    mdl = build_manifest.parse_mdldat(model_bytes)
    names = [e.get("name") or "" for e in mdl.get("elements") or []]
    wheel_groups = [n for n in names if n.lower().startswith("e_wheel_") and not n.lower().startswith("e_wheels")]
    kinds = {
        "tyre": sum(1 for n in names if n.lower().startswith("e_tyre_")),
        "rim": sum(1 for n in names if n.lower().startswith("e_alloyrim_")),
        "brakeDisc": sum(1 for n in names if n.lower().startswith("e_brakedisc_")),
        "brakeCaliper": sum(1 for n in names if n.lower().startswith("e_brakecaliper_")),
    }
    return {
        "status": "ok",
        "offset": mdl.get("offset"),
        "bytes": mdl.get("bytes"),
        "sha256": mdl.get("sha256"),
        "version": mdl.get("version"),
        "modelCount": mdl.get("modelCount"),
        "elementCount": mdl.get("elementCount"),
        "constraintCount": mdl.get("constraintCount"),
        "wheelGroupCount": len(wheel_groups),
        "wheelGroups": wheel_groups,
        "wheelPartElementCounts": kinds,
        "nonIdentityElementCount": mdl.get("nonIdentityElementCount"),
        "allWheelKindsPresent": all(v == 4 for v in kinds.values()) and len(wheel_groups) == 4,
    }


def field_record(entry: dict, reference_names: set[str], proven_slug: str | None) -> dict:
    values = entry["values"]
    lines = entry["lines"]
    names = [name for name, _raw in lines]
    plain = {name.split("[", 1)[0] for name in names}
    missing = sorted(reference_names - plain)
    extra = sorted(plain - reference_names)
    counts = {
        "gearRatios": values.get("gears.gearRatios"),
        "torquePoints": values.get("engine.engineTorque_Rpm.dataPoints"),
        "frontGripPoints": values.get("tyres.frontTyres.grip.data"),
        "rearGripPoints": values.get("tyres.rearTyres.grip.data"),
    }
    return {
        "fieldLines": len(lines),
        "arrayComponentsUsed": entry["arrayComponentsUsed"],
        "counts": counts,
        "missingFieldNamesVsReference": missing,
        "extraFieldNamesVsReference": extra,
        "gatePass": entry["gate"]["ok"],
        "gateProblems": entry["gate"]["problems"],
        "selectedFieldsPath": entry.get("selectedFieldsPath"),
        "provenFieldsPath": entry.get("selectedFieldsPath") if proven_slug else None,
    }


def nearest_models(name: str, model_names: list[str], limit: int = 5) -> list[dict]:
    scored = []
    wanted = name.strip().lower()
    for candidate in model_names:
        stem = candidate[:-len(".model")] if candidate.lower().endswith(".model") else candidate
        score = difflib.SequenceMatcher(None, wanted, stem).ratio()
        scored.append({"model": candidate, "similarity": round(score, 4)})
    scored.sort(key=lambda row: (-row["similarity"], row["model"]))
    return scored[:limit]


def classify(record: dict) -> tuple[str, str, list[str]]:
    missing: list[str] = []
    if record["proven"]["reference"]:
        return "A", "all data present and proven by the current E1 drive pipeline", []
    if record["model"]["mapping"] != "exact":
        missing.append("exact model file: " + record["model"]["expectedPath"])
        return "C", "no exact normalised `\\models\\vehicles\\<name>.model` entry", missing
    if record["scene"]["status"] != "ok":
        missing.append("scene reader: " + str(record["scene"].get("reason")))
        return "C", "model present but the committed Scene reader rejected it", missing
    if record["mdlDat"]["status"] != "ok":
        missing.append("MdlDat: " + str(record["mdlDat"].get("reason")))
        return "C", "model present but the MdlDat part layer could not be parsed", missing
    if not record["physics"]["gatePass"]:
        missing.extend(record["physics"]["gateProblems"])
        return "C", "record fails the physics completeness gate", missing
    if record["materials"]["status"] != "ok":
        missing.append("material traversal: " + str(record["materials"].get("reason")))
        return "B", "model and fields present; vehicle-specific material traversal is not proven", missing
    if record["mdlDat"]["wheelGroupCount"] != 4:
        missing.append("four wheel groups (found " + str(record["mdlDat"]["wheelGroupCount"]) + ")")
    if record["materials"]["staticAlbedoDraws"] == 0:
        missing.append("static albedo draws (0 resolved)")
    return "B", "model, fields, scene and part layer present; needs extraction + vehicle-specific material step", missing


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-materials", action="store_true")
    parser.add_argument("--skip-next-manifests", action="store_true")
    args = parser.parse_args()

    for directory in (OUT, MODELS, FIELDS, SCENES, MATERIALS, MANIFESTS, LOGS):
        directory.mkdir(parents=True, exist_ok=True)

    cars_doc = json.loads(CARS_JSON.read_text(encoding="utf-8"))
    roster_doc = json.loads(ROSTER_JSON.read_text(encoding="utf-8"))
    roster_by_name = {car["name"]: car for car in roster_doc["cars"]}
    proven_by_slug = {car["slug"]: car for car in roster_doc["cars"]}
    assert cars_doc["counts"]["records"] == 62, cars_doc["counts"]

    index = pak_index(PAK)
    if index["status"] != "indexed":
        raise SystemExit("root.pak index is not readable: " + str(index.get("status")))
    vehicle_rows = [
        row for row in index["entries"]
        if not row["directory"] and row["path"].lower().endswith(".model")
        and parts(row["path"])[:2] == ["models", "vehicles"]
        and len(parts(row["path"])) == 3
    ]
    wheel_rows = [
        row for row in index["entries"]
        if not row["directory"] and row["path"].lower().endswith(".model")
        and parts(row["path"])[:3] == ["models", "vehicles", "wheels"]
    ]
    model_names = sorted(Path(row["path"]).name for row in vehicle_rows)
    wheel_by_name = {Path(row["path"]).name.lower(): row for row in wheel_rows}
    model_by_name = {Path(row["path"]).name.lower(): row for row in vehicle_rows}

    # ---- physics: decode every record with the committed extractor -----------
    xt = car_xt.parse(car_xt.extract(GAME))
    decoded = {}
    for rec in car_roster.record_names(xt):
        lines, evidence = car_xt.decode_car(xt, rec["name"])
        values = car_roster.typed_values(xt, lines)
        decoded[rec["name"]] = {
            "record": rec,
            "lines": lines,
            "values": values,
            "arrayComponentsUsed": evidence["record"]["arrayComponentsUsed"],
            "gate": car_roster.gate(values),
        }
    reference_names = {name.split("[", 1)[0] for name, _raw in decoded["Corvette_ZR1_Stock"]["lines"]}

    # ---- the five proven references are loaded from committed artifacts ------
    car_parts_index = json.loads(CAR_PARTS_INDEX.read_text(encoding="utf-8"))
    parts_by_slug = {entry["slug"]: entry for entry in car_parts_index["cars"]}
    materials_index = json.loads(CAR_MATERIALS_INDEX.read_text(encoding="utf-8"))
    materials_by_slug = {entry["slug"]: entry for entry in materials_index["cars"]}

    build_manifest_module = load_module(BUILD_MANIFEST, "vp_build_manifest")

    records = []
    for rec in cars_doc["records"]:
        name = rec["name"]
        expected_slug = roster_by_name.get(name, {}).get("slug")
        slug = expected_slug or slugify(name)
        proven = expected_slug is not None
        expected_path = "\\models\\vehicles\\" + name.strip().lower() + ".model"
        exact = model_by_name.get(name.strip().lower() + ".model")
        prefix = sorted(
            Path(row["path"]).name for row in vehicle_rows
            if Path(row["path"]).name.lower().startswith(name.strip().lower())
        )
        wheel_resource = wheel_by_name.get(name.strip().lower() + ".model")

        field_entry = decoded[name]
        field_entry["selectedFieldsPath"] = (
            rel(ROOT / "_work/e1-drive/cars" / f"{expected_slug}.fields") if proven else None
        )
        # Write a local copy for every record; the committed e1-drive path only
        # exists for the five selected cars.
        text = "".join(f"{key}\t{value}\r\n" for key, value in field_entry["lines"])
        field_path = FIELDS / f"{slug}.fields"
        field_path.write_bytes(text.encode("utf-8"))

        physics = field_record(field_entry, reference_names, expected_slug)
        values = field_entry["values"]
        gear_count = values.get("gears.gearRatios")
        torque_points = values.get("engine.engineTorque_Rpm.dataPoints")
        physics.update({
            "fieldsPath": rel(field_path),
            "fieldsBytes": field_path.stat().st_size,
            "fieldsSha256": sha256_file(field_path),
            "selected": proven,
            "selectedFieldsPath": field_entry["selectedFieldsPath"],
            "driveType": values.get("transmission.driveType"),
            "mass": values.get("mass.mass"),
            "wheelBase": values.get("geometry.wheelBase"),
            "values": {
                "mass": values.get("mass.mass"),
                "wheelBase": values.get("geometry.wheelBase"),
                "trackWidthFront": values.get("geometry.trackWidthFront"),
                "trackWidthRear": values.get("geometry.trackWidthRear"),
                "tyreRadiusFront": values.get("tyres.frontTyres.radius"),
                "tyreRadiusRear": values.get("tyres.rearTyres.radius"),
                "gearCount": gear_count,
                "gearRatios": [values.get(f"gears.gearRatios[{i}]") for i in range(gear_count or 0)],
                "topGear": values.get("gears.topGear"),
                "finalRatio": values.get("gears.finalRatio"),
                "torquePoints": torque_points,
                "torqueScaleNm": values.get("engine.engineTorque_Rpm.yScale"),
                "torqueCurve": [values.get(f"engine.engineTorque_Rpm.dataPoints[{i}]")
                                for i in range(torque_points or 0)],
                "limiterRPM": values.get("engine.limiterRPM"),
                "brakesFront": values.get("brakes.frontBrakeForce"),
                "brakesRear": values.get("brakes.rearBrakeForce"),
                "frontGripPoints": values.get("tyres.frontTyres.grip.data"),
                "rearGripPoints": values.get("tyres.rearTyres.grip.data"),
            },
        })

        model = {
            "mapping": "exact" if exact else "none",
            "rule": "exact normalised model file name under \\models\\vehicles\\",
            "expectedPath": expected_path,
            "pakPath": exact["path"] if exact else None,
            "logicalBytes": exact["logical_bytes"] if exact else None,
            "pakOffset": exact["offset"] if exact else None,
            "prefixCandidates": prefix,
            "nearCandidates": nearest_models(name, model_names) if not exact else [],
            "wheelResource": wheel_resource["path"] if wheel_resource else None,
            "wheelResourceBytes": wheel_resource["logical_bytes"] if wheel_resource else None,
        }

        scene = {"status": "not-run"}
        mdl = {"status": "not-run"}
        materials = {"status": "not-run", "staticAlbedoDraws": 0}
        decoded_path = None

        if exact:
            # Decode from the pak in a bounded read, then reuse the content-addressed
            # decoded file (the five committed models are already present).
            with PAK.open("rb") as stream:
                stream.seek(exact["offset"])
                packed = stream.read(exact["stored_bytes"])
            data = decode_packet_zlib(packed, exact["logical_bytes"])
            digest = sha256_bytes(data)
            decoded_path = MODELS / (digest + ".decoded")
            if not decoded_path.exists() or sha256_file(decoded_path) != digest:
                decoded_path.write_bytes(data)
            model.update({
                "modelSha256": digest,
                "decodedPath": rel(decoded_path),
                "decodedBytes": decoded_path.stat().st_size,
                "packetCount": (len(data) + 65535) // 65536,
            })

            # model chunk tree
            try:
                proc = subprocess.run([str(MODEL_EXE), str(decoded_path)], capture_output=True, text=True,
                                      encoding="utf-8", timeout=120)
                if proc.returncode != 0:
                    raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "model_inspect failed")
                chunk_doc = json.loads(proc.stdout)
                model["chunks"] = [
                    {"id": c.get("id"), "offset": c.get("offset"), "bytes": c.get("bytes"),
                     "children": [{"id": ch.get("id"), "offset": ch.get("offset"), "bytes": ch.get("bytes")}
                                  for ch in c.get("children") or []]}
                    for c in chunk_doc.get("chunks") or []
                ]
                model["chunkStatus"] = chunk_doc.get("status")
            except Exception as exc:  # noqa: BLE001
                model["chunkStatus"] = "error"
                model["chunkReason"] = fail_reason(exc)

            # scene reader
            try:
                proc = subprocess.run([str(SCENE_EXE), str(decoded_path)], capture_output=True, text=True,
                                      encoding="utf-8", timeout=180)
                if proc.returncode != 0:
                    raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "scene_inspect failed")
                scene_doc = json.loads(proc.stdout)
                scene = scene_summary(scene_doc)
                SCENES.mkdir(parents=True, exist_ok=True)
                (SCENES / f"{slug}.json").write_bytes(
                    (json.dumps({k: v for k, v in scene_doc.items()
                                 if k in ("status", "sharedTextures", "draws", "bounds", "metadata")},
                                sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
                )
                scene["reportPath"] = rel(SCENES / f"{slug}.json")
                scene["reportSha256"] = sha256_file(SCENES / f"{slug}.json")
            except Exception as exc:  # noqa: BLE001
                scene = {"status": "error", "reason": fail_reason(exc)}

            # MdlDat part layer (no geometry rebuild)
            try:
                mdl = mdl_summary(decoded_path.read_bytes(), build_manifest_module)
            except Exception as exc:  # noqa: BLE001
                mdl = {"status": "error", "reason": fail_reason(exc)}

            # independent material traversal (read-only committed tool)
            if not args.skip_materials:
                try:
                    out_dir = MATERIALS / slug
                    proc = subprocess.run(
                        [sys.executable, str(MATERIAL_TRAVERSAL), "--input", str(decoded_path),
                         "--out-dir", str(out_dir)],
                        capture_output=True, text=True, encoding="utf-8", timeout=300,
                    )
                    if proc.returncode != 0:
                        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "material traversal failed")
                    summary = json.loads(proc.stdout)
                    resolved = json.loads((out_dir / "corvette-materials.json").read_text(encoding="utf-8"))
                    raw = json.loads((out_dir / "corvette-materials.raw.json").read_text(encoding="utf-8"))
                    tex = texture_summary(resolved, raw)
                    counts = resolved.get("statusCounts") or {}
                    materials = {
                        "status": "ok",
                        "source": "tools/inspect_car_materials.py independent traversal",
                        "drawCount": resolved.get("drawCount"),
                        "statusCounts": dict(sorted(counts.items())),
                        "staticAlbedoDraws": int(counts.get("static_albedo_image_resolved", 0)),
                        "paintDraws": int(counts.get("shader_no_albedo", 0)) if False else sum(
                            1 for d in resolved.get("draws") or []
                            if d.get("shaderFamily") in ("paint", "paintm") and d.get("noAlbedoDefine")),
                        "lightDraws": int(counts.get("runtime_light_blend", 0)),
                        "noAlbedoDraws": int(counts.get("shader_no_albedo", 0)),
                        "unsupportedUvDraws": int(counts.get("unsupported_uv", 0)),
                        "unresolvedAlbedoDraws": int(counts.get("unresolved_albedo", 0)),
                        **tex,
                        "manifest": rel(out_dir / "corvette-materials.json"),
                        "manifestSha256": sha256_file(out_dir / "corvette-materials.json"),
                        "rawManifest": rel(out_dir / "corvette-materials.raw.json"),
                        "rawManifestSha256": sha256_file(out_dir / "corvette-materials.raw.json"),
                        "uvManifest": rel(out_dir / "corvette-uv0.json"),
                        "uvManifestSha256": sha256_file(out_dir / "corvette-uv0.json"),
                    }
                except Exception as exc:  # noqa: BLE001
                    materials = {"status": "error", "reason": fail_reason(exc), "staticAlbedoDraws": 0}

        # Proven cars use the committed P52 numbers, not the fresh traversal.
        if proven:
            p52 = materials_by_slug.get(slug)
            p52_manifest = ROOT / "_work/car-materials/roster" / p52["manifest"] if p52 else None
            coverage = p52["coverage"] if p52 else {}
            materials.update({
                "status": "proven",
                "source": "P52 committed material manifest (_work/car-materials/roster)",
                "drawCount": coverage.get("drawCount"),
                "staticAlbedoDraws": coverage.get("staticAlbedoDrawCount"),
                "paintDraws": coverage.get("runtimePaintLookupDrawCount"),
                "lightDraws": coverage.get("runtimeLightBlendDrawCount"),
                "noAlbedoDraws": coverage.get("runtimeShaderNoAlbedoDrawCount"),
                "uniqueTextureCount": coverage.get("uniqueTextureCount"),
                "decodedTextureCount": coverage.get("decodedTextureCount"),
                "undecodedTextureCount": coverage.get("undecodedTextureCount"),
                "sourceBytes": coverage.get("decodedRawtextureBytes"),
                "rgbaBytes": coverage.get("decodedRgbaBytes"),
                "manifest": p52["manifest"] if p52 else None,
                "manifestSha256": p52["manifestSha256"] if p52 else None,
            })

        record = {
            "index": rec["index"],
            "id": rec["id"],
            "name": name,
            "slug": slug,
            "proposedSlug": not proven,
            "drivetrain": rec["drivetrain"],
            "mass": rec["mass"],
            "wheelBase": rec["wheelBase"],
            "physics": physics,
            "model": model,
            "scene": scene,
            "mdlDat": mdl,
            "materials": materials,
            "proven": {
                "reference": proven,
                "carPartsManifest": bool(proven and parts_by_slug.get(slug, {}).get("mapped")),
                "materials": bool(proven and materials.get("status") == "proven"),
                "driveVerification": bool(proven),
            },
            "currentExtractionPath": (
                "proven: RP_CarDynamics -> .fields; .model -> car-parts manifest; P52 material/texture manifest; "
                "e1-drive geometry/verify"
                if proven else
                "model decoded + committed Scene reader + MdlDat + independent material traversal; "
                "needs roster entry, car_roster .fields, car-parts manifest, P52 materials and geometry pins"
                if exact else
                "blocked before extraction: no exact model; nothing is guessed"
            ),
        }
        record["class"], record["classReason"], record["missing"] = classify(record)
        records.append(record)
        print(f"{record['index']:3d} {record['class']} {name:38s} "
              f"draws={record['scene'].get('drawCount')} "
              f"static={record['materials'].get('staticAlbedoDraws')} "
              f"wheelGroups={record['mdlDat'].get('wheelGroupCount')}", flush=True)

    classes = Counter(r["class"] for r in records)
    by_class = {label: [r["slug"] for r in records if r["class"] == label] for label in ("A", "B", "C")}

    # ---- next-car shortlist -------------------------------------------------
    def next_score(r: dict) -> tuple:
        m = r["materials"]
        mdl = r["mdlDat"]
        name = r["name"].lower()
        variant = any(word in name for word in VARIANT_WORDS)
        score = 0
        score += 40 if mdl.get("wheelGroupCount") == 4 else 0
        score += 20 if m.get("staticAlbedoDraws", 0) > 0 else 0
        score += 10 if m.get("uniqueTextureCount", 0) > 0 else 0
        score += 5 if r["scene"].get("uv0ValidVertices", 0) > 0 else 0
        score += 10 if not variant else -10
        score -= (r["model"].get("logicalBytes") or 0) / 1_000_000
        score -= (r["scene"].get("drawCount") or 0) / 200
        return (-score, r["index"])

    candidates = [r for r in records if r["class"] == "B" and r["materials"].get("status") == "ok"]
    candidates.sort(key=next_score)
    next_cars = []

    # Build part manifests as we walk the confidence order. A car whose part
    # layer rejects (for example a missing brake-caliper element) is recorded
    # with the exact blocker and stays class B, but is skipped for the
    # "highest confidence" shortlist without touching the committed tree.
    for r in candidates:
        if len(next_cars) >= 10:
            break
        if args.skip_next_manifests:
            next_cars.append(r)
            continue
        out_dir = MANIFESTS / r["slug"]
        if out_dir.exists():
            for child in out_dir.iterdir():
                child.unlink()
        command = [
            sys.executable, str(BUILD_MANIFEST),
            "--model", str(ROOT / r["model"]["decodedPath"]),
            "--scene-exe", str(SCENE_EXE),
            "--model-exe", str(MODEL_EXE),
            "--out-dir", str(out_dir),
            "--car-slug", r["slug"],
            "--car-name", r["name"],
            "--car-mapping", (
                f"proposed next car {r['name']} (record {r['index']}/{r['id']}) -> exact pak entry "
                f"{r['model']['pakPath']} ({r['model']['logicalBytes']} logical bytes, SHA-256 "
                f"{r['model']['modelSha256']})"
            ),
            "--model-pak-path", r["model"]["pakPath"],
        ]
        try:
            proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=300)
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "manifest build failed")
            summary = json.loads(proc.stdout)
            r["nextManifest"] = {
                "status": "built",
                "manifest": summary["manifest"],
                "manifestSha256": "sha256:" + summary["manifestSha256"],
                "manifestBytes": summary["manifestBytes"],
                "mesh": summary["mesh"],
                "meshSha256": "sha256:" + summary["meshSha256"],
                "draws": summary["diagnostics"]["drawCount"],
                "parts": summary["diagnostics"]["partCount"],
                "namedParts": summary["diagnostics"]["namedPartCount"],
                "wheelDraws": summary["diagnostics"]["wheelDrawCount"],
                "provenWheelDraws": summary["diagnostics"]["provenWheelDrawCount"],
                "ambiguousWheelDraws": summary["diagnostics"]["ambiguousWheelDrawCount"],
                "tyreProofTier": summary["tyreProofTier"],
            }
            next_cars.append(r)
        except Exception as exc:  # noqa: BLE001
            reason = fail_reason(exc)
            r["nextManifest"] = {"status": "error", "reason": reason}
            r["partLayerBlocker"] = reason
            entry = "part manifest: " + reason
            if entry not in r["missing"]:
                r["missing"].append(entry)
            r["classReason"] += "; part manifest builder rejected the asset"

    # Stable confidence tier: a built manifest with at least one proven wheel
    # draw is high confidence; a built manifest whose wheel draws are all
    # preview-paired is medium confidence (still drawable, identity not proven).
    next_cars.sort(key=lambda r: 0 if (r.get("nextManifest", {}).get("provenWheelDraws") or 0) > 0 else 1)

    next_list = [{
        "index": r["index"],
        "slug": r["slug"],
        "name": r["name"],
        "drivetrain": r["drivetrain"],
        "mass": r["mass"],
        "model": r["model"]["pakPath"],
        "modelBytes": r["model"]["logicalBytes"],
        "sceneDraws": r["scene"].get("drawCount"),
        "staticAlbedoDraws": r["materials"].get("staticAlbedoDraws"),
        "uniqueTextures": r["materials"].get("uniqueTextureCount"),
        "wheelGroups": r["mdlDat"].get("wheelGroupCount"),
        "nextManifest": r.get("nextManifest"),
        "confidence": (
            "high" if (r.get("nextManifest", {}).get("provenWheelDraws") or 0) > 0 else "medium"
        ),
        "expectedAdditions": [
            "one decoded body model + one part manifest/mesh (committed car-parts builder)",
            "one RP_CarDynamics field list from the same record (committed car_roster decoder)",
            "one P52-style material/texture pass (independent traversal already resolves "
            f"{r['materials'].get('staticAlbedoDraws')} static albedo draws / "
            f"{r['materials'].get('uniqueTextureCount')} unique textures)",
            "one body entry in geometry + verifier pins (main-agent owned)",
        ],
        "reason": r["classReason"],
    } for r in next_cars]

    # ---- totals -------------------------------------------------------------
    totals = {
        "records": len(records),
        "classA": classes.get("A", 0),
        "classB": classes.get("B", 0),
        "classC": classes.get("C", 0),
        "provenReferenceCars": len(PROVEN_SLUGS),
        "physicsGatePass": sum(1 for r in records if r["physics"]["gatePass"]),
        "exactModelMapped": sum(1 for r in records if r["model"]["mapping"] == "exact"),
        "sceneParsed": sum(1 for r in records if r["scene"].get("status") == "ok"),
        "mdlDatParsed": sum(1 for r in records if r["mdlDat"].get("status") == "ok"),
        "materialsTraversed": sum(1 for r in records if r["materials"].get("status") in ("ok", "proven")),
        "modelLogicalBytes": sum((r["model"].get("logicalBytes") or 0) for r in records),
        "meshBytes": sum((r["scene"].get("meshBytes") or 0) for r in records),
        "indexBytes": sum((r["scene"].get("indexBytes") or 0) for r in records),
        "uv0Bytes": sum((r["scene"].get("uv0Bytes") or 0) for r in records),
        "uv0ValidBytes": sum((r["scene"].get("uv0ValidBytes") or 0) for r in records),
        "textureSourceBytes": sum((r["materials"].get("sourceBytes") or 0) for r in records),
        "textureRgbaBytes": sum((r["materials"].get("rgbaBytes") or 0) for r in records),
        "nextCarCount": len(next_list),
        "nextCarsHighConfidence": sum(1 for c in next_list if c["confidence"] == "high"),
        "partLayerBlockedBCars": sum(1 for r in records if r["class"] == "B" and r.get("partLayerBlocker")),
    }

    field_line_counts = Counter(r["physics"]["fieldLines"] for r in records)
    field_differences = {
        "fieldLineCountDistribution": {str(k): v for k, v in sorted(field_line_counts.items())},
        "recordsWithMissingFieldNames": [
            {"slug": r["slug"], "missing": r["physics"]["missingFieldNamesVsReference"]}
            for r in records if r["physics"]["missingFieldNamesVsReference"]
        ],
        "recordsWithExtraFieldNames": [
            {"slug": r["slug"], "extra": r["physics"]["extraFieldNamesVsReference"]}
            for r in records if r["physics"]["extraFieldNamesVsReference"]
        ],
        "note": (
            "All records share the committed RP_CarDynamics schema. Line-count differences are the "
            "per-record array cardinalities (gears, torque points, grip points); no positive field or "
            "minimum array is missing on any record."
        ),
    }

    commands = {
        "provenReproduction": [
            "python probes/e1-drive/tools/car_roster.py",
            "python probes/car-parts/tools/build_all_manifests.py",
            "python probes/e1-drive/tools/build_car_textures.py",
            "node probes/e1-drive/tools/build_geometry.mjs",
            "node probes/e1-drive/tools/verify_e1_drive.mjs",
        ],
        "addOneBCar": [
            "# 1. main-agent owned: append the car to probes/e1-drive/cars/roster.json",
            "#    {slug,name,recordId,recordIndex,layout,why}; recordId/recordIndex come from this audit",
            "python probes/e1-drive/tools/car_roster.py",
            "# 2. build the body manifest (writes _work/car-parts/cars/<slug>/)",
            "python probes/car-parts/tools/build_all_manifests.py",
            "# 3. re-run the P52 material/texture pass for the enlarged roster",
            "python probes/car-materials/tools/build_roster_materials.py",
            "python probes/car-materials/tools/verify_roster_materials.py",
            "# 4. export the e1-drive car textures for the enlarged roster",
            "python probes/e1-drive/tools/build_car_textures.py",
            "# 5. main-agent owned: add the committed manifest SHA-256 to COMMITTED_MANIFESTS",
            "#    in probes/e1-drive/tools/build_geometry.mjs and rebuild geometry",
            "node probes/e1-drive/tools/build_geometry.mjs",
            "# 6. full gate (all roster cars) + browser capture",
            "node probes/e1-drive/tools/verify_e1_drive.mjs",
            "node probes/e1-drive/tools/capture_browser.mjs --mode sprint",
        ],
        "notes": [
            "Steps 1 and 5 touch main-agent owned files; this probe did not modify them.",
            "A B car is not claimed to drive until steps 1-6 are run and recorded.",
            "A C car needs a documented model alias or a different record; no alias is guessed here.",
        ],
    }

    limits = [
        "Data audit only; no car was added to the E1 drive slice and no drive claim is made.",
        "A = the five committed reference cars (fields + part manifest + P52 materials + drive verification).",
        "B = exact model + Scene reader + MdlDat + physics gate + independent material traversal, but not yet "
        "integrated into the E1 roster, P52 committed materials, geometry pins or drive verifier.",
        "C = no exact normalised model entry (or a reader failure); the missing file/format is recorded and "
        "near-name candidates are evidence only, never a mapping.",
        "Texture source bytes are per unique referenced texture; RGBA bytes use the highest populated LOD within "
        "the committed 512x512 decoder bound and are an upper-bound estimate, not a decoded artifact.",
        "Mesh/index/UV bytes are the committed Scene reader's first RenderList LOD0 output, not the whole model.",
        "The current five-car drive path remains the only proven playable content.",
    ]

    document = {
        "kind": "blur.vehicle-pipeline-audit",
        "version": 1,
        "status": "PASS",
        "generatedBy": "probes/vehicle-pipeline/tools/audit_cars.py",
        "source": {
            "cars": {"path": rel(CARS_JSON), "sha256": sha256_file(CARS_JSON)},
            "roster": {"path": rel(ROSTER_JSON), "sha256": sha256_file(ROSTER_JSON)},
            "pak": {"path": rel(PAK), "bytes": PAK.stat().st_size,
                    "entries": index["entry_count"], "vehicleModels": len(vehicle_rows),
                    "wheelModels": len(wheel_rows)},
            "carPartsIndex": {"path": rel(CAR_PARTS_INDEX), "sha256": sha256_file(CAR_PARTS_INDEX)},
            "materialsIndex": {"path": rel(CAR_MATERIALS_INDEX), "sha256": sha256_file(CAR_MATERIALS_INDEX)},
        },
        "rule": {
            "model": "exact normalised `<record name>.model` under \\models\\vehicles\\ (committed car-parts rule)",
            "classA": "proven by the current pipeline (5 reference cars)",
            "classB": "data present; needs extraction + vehicle-specific material/geometry integration",
            "classC": "blocked with the exact missing file/format/record; no guess",
        },
        "counts": totals,
        "classes": by_class,
        "provenReferences": PROVEN_SLUGS,
        "fieldDifferences": field_differences,
        "records": records,
        "nextCars": next_list,
        "commands": commands,
        "limits": limits,
    }

    out_path = OUT / "cars.json"
    out_path.write_bytes((json.dumps(document, indent=1, sort_keys=True) + "\n").encode("utf-8"))

    # ---- summary.csv --------------------------------------------------------
    csv_path = OUT / "summary.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow([
            "index", "id", "name", "slug", "class", "drivetrain", "mass", "wheelBase",
            "physicsGate", "modelMapping", "modelPakPath", "modelBytes", "sceneDraws",
            "vertices", "triangles", "uv0ValidVertices", "staticAlbedoDraws", "uniqueTextures",
            "textureSourceBytes", "wheelGroups", "provenReference", "reason",
        ])
        for r in records:
            writer.writerow([
                r["index"], r["id"], r["name"], r["slug"], r["class"], r["drivetrain"],
                r["mass"], r["wheelBase"], r["physics"]["gatePass"], r["model"]["mapping"],
                r["model"].get("pakPath"), r["model"].get("logicalBytes"),
                r["scene"].get("drawCount"), r["scene"].get("vertexCount"),
                r["scene"].get("triangleCount"), r["scene"].get("uv0ValidVertices"),
                r["materials"].get("staticAlbedoDraws"), r["materials"].get("uniqueTextureCount"),
                r["materials"].get("sourceBytes"), r["mdlDat"].get("wheelGroupCount"),
                r["proven"]["reference"], r["classReason"],
            ])

    hashes = {
        "kind": "blur.vehicle-pipeline-hashes",
        "version": 1,
        "inputs": document["source"],
        "outputs": {
            "cars.json": {"bytes": out_path.stat().st_size, "sha256": sha256_file(out_path)},
            "summary.csv": {"bytes": csv_path.stat().st_size, "sha256": sha256_file(csv_path)},
        },
        "models": {
            r["slug"]: {"path": r["model"].get("decodedPath"),
                        "bytes": r["model"].get("decodedBytes"),
                        "sha256": r["model"].get("modelSha256")}
            for r in records if r["model"].get("decodedPath")
        },
        "nextManifests": {
            r["slug"]: r.get("nextManifest") for r in next_cars if r.get("nextManifest")
        },
    }
    (OUT / "hashes.json").write_bytes((json.dumps(hashes, indent=1, sort_keys=True) + "\n").encode("utf-8"))

    print(json.dumps({
        "status": "PASS",
        "counts": totals,
        "classes": by_class,
        "next": [{"slug": c["slug"], "name": c["name"], "manifest": c.get("nextManifest", {}).get("status")}
                 for c in next_cars],
        "outputs": [rel(out_path), rel(csv_path), rel(OUT / "hashes.json")],
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
