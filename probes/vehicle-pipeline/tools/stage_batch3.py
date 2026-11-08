"""Stage the batch-3 vehicle manifests, meshes, scene reports and previews.

Batch 3 is the seven *medium* provable class-C records (1, 7, 23, 31, 39, 48,
71: all 20 wheel draws preview-paired) plus three high-confidence class-B cars
that are not in batch 1 (21 Renault Megane Trophy, 24 LandRover LRX, 26 Nissan
350Z Drift).

Everything is written under the requested staging root (default
`_work/vehicle-pipeline/batch3/`). No `probes/e1-drive`, `probes/car-parts`,
`probes/car-materials`, `tools/`, web, roster, geometry, ghost or P52 file is
touched.

Usage:
  python probes/vehicle-pipeline/tools/stage_batch3.py [--out-root <dir>]
         [--skip-previews]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
for path in (TOOLS, ROOT / "engine/harness/t005d-vehicle",
             ROOT / "probes/vehicle-pipeline/tools",
             ROOT / "probes/car-parts/tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import audit_cars  # noqa: E402
import audit_c_aliases  # noqa: E402
import render_preview  # noqa: E402
from inspect_asset_layout import pak_index  # noqa: E402
from prepare_asset_fixture import decode_packet_zlib  # noqa: E402

OUT_DEFAULT = ROOT / "_work/vehicle-pipeline/batch3"
CARS_JSON = ROOT / "_work/vehicle-pipeline/cars.json"
C_ALIASES = ROOT / "_work/vehicle-pipeline/c-aliases.json"
AMAX_JSONL = ROOT / "_work/vehicle-pipeline/amax-vehicles.jsonl"
HUD_CATALOG = ROOT / "_work/vehicle-pipeline/batch3/hud/hud-catalog.json"
SCENE_EXE = ROOT / "_work/build/asset-reader-native/Release/scene_inspect.exe"
MODEL_EXE = ROOT / "_work/build/asset-reader-native/Release/model_inspect.exe"
BUILD_MANIFEST = ROOT / "probes/car-parts/tools/build_manifest.py"
MATERIAL_TRAVERSAL = ROOT / "tools/inspect_car_materials.py"
ROOT_PAK = ROOT / "game-data/Blur/cache/root.pak"

C_INDEXES = (1, 7, 23, 31, 39, 48, 71)
B_INDEXES = (21, 24, 26)


class Unsupported(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(ROOT).as_posix()
    except ValueError:
        return resolved.as_posix()


def run(command: list[str], timeout: int = 900) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                          timeout=timeout)


def pak_entry(path: str) -> dict:
    index = pak_index(ROOT_PAK)
    entry = next((row for row in index["entries"]
                  if row["path"].lower() == path.lower()), None)
    if entry is None or entry.get("directory"):
        raise Unsupported(f"missing root.pak entry {path}")
    return entry


def amax_vehicles() -> dict[str, dict]:
    """Exact AmaxVehicle identity, including the wheel fileName the engine uses."""
    return {vehicle["tag"]: vehicle
            for vehicle in audit_c_aliases.load_amax()["vehicles"]}


def decode_wheel(pak_path: str, cache_dir: Path) -> dict:
    entry = pak_entry(pak_path)
    stem = Path(pak_path.replace("\\", "/")).stem
    target = cache_dir / f"{stem}.decoded"
    if not target.is_file():
        with ROOT_PAK.open("rb") as stream:
            stream.seek(entry["offset"])
            packed = stream.read(entry["stored_bytes"])
        decoded = decode_packet_zlib(packed, entry["logical_bytes"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(decoded)
    data = target.read_bytes()
    if len(data) != entry["logical_bytes"]:
        raise Unsupported(f"decoded wheel length differs for {pak_path}")
    return {"pakPath": pak_path, "logicalBytes": entry["logical_bytes"],
            "decodedPath": rel(target), "sha256": sha256_bytes(data)}


def scene_reader(path: Path) -> dict:
    proc = run([str(SCENE_EXE), str(path)], timeout=300)
    if proc.returncode != 0:
        raise Unsupported(f"scene_inspect failed: {(proc.stderr or proc.stdout)[:300]}")
    document = json.loads(proc.stdout)
    return {
        "status": document.get("status"),
        "drawCount": len(document.get("draws") or []),
        "vertexCount": int((document.get("metadata") or {}).get("vertexCount") or 0),
        "triangleCount": int((document.get("metadata") or {}).get("triangleCount") or 0),
        "uv0ValidVertices": int((document.get("metadata") or {}).get("uv0ValidVertices") or 0),
        "partialSceneTraversal": bool(
            (document.get("metadata") or {}).get("partialSceneTraversal")),
    }


def model_reader(path: Path) -> dict:
    proc = run([str(MODEL_EXE), str(path)], timeout=300)
    if proc.returncode != 0:
        raise Unsupported(f"model_inspect failed: {(proc.stderr or proc.stdout)[:300]}")
    document = json.loads(proc.stdout)
    return {"status": document.get("status"),
            "chunks": len(document.get("chunks") or [])}


def material_pass(body: Path, out_dir: Path) -> dict:
    if out_dir.exists():
        for child in out_dir.iterdir():
            child.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)
    proc = run([sys.executable, str(MATERIAL_TRAVERSAL),
                "--input", str(body), "--out-dir", str(out_dir)], timeout=900)
    if proc.returncode != 0:
        raise Unsupported(f"material traversal failed: {(proc.stderr or proc.stdout)[:400]}")
    resolved_path = out_dir / "corvette-materials.json"
    raw_path = out_dir / "corvette-materials.raw.json"
    uv0_path = out_dir / "corvette-uv0.json"
    resolved = json.loads(resolved_path.read_text(encoding="utf-8"))
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    tex = audit_cars.texture_summary(resolved, raw)
    uv0 = json.loads(uv0_path.read_text(encoding="utf-8"))
    available = [row for row in uv0 if row.get("available")]
    counts = resolved.get("statusCounts") or {}
    return {
        "status": "ok",
        "drawCount": resolved.get("drawCount"),
        "statusCounts": dict(sorted(counts.items())),
        "staticAlbedoDraws": int(counts.get("static_albedo_image_resolved", 0)),
        "uniqueTextureCount": tex["uniqueTextureCount"],
        "decodableTextureCount": tex["decodableTextureCount"],
        "undecodableTextureCount": tex["undecodableTextureCount"],
        "sourceBytes": tex["sourceBytes"],
        "rgbaBytes": tex["rgbaBytes"],
        "formats": tex["formats"],
        "buffers": len(uv0),
        "availableBuffers": len(available),
        "validUv0Vertices": sum(int(row.get("vertexCount") or 0) for row in available),
        "manifest": rel(resolved_path),
        "manifestSha256": sha256_file(resolved_path),
        "rawManifestSha256": sha256_file(raw_path),
        "uv0Sha256": sha256_file(uv0_path),
    }


def _mapping_text(record: dict) -> str:
    """The same mapping evidence string `build_all_manifests.build_manifest` uses."""
    mapping = record.get("modelMapping")
    if mapping:
        return (
            f"roster name {record['name']} (record {record['record']['index']}/"
            f"{record['record']['id']}) -> explicit record-level model "
            f"{record['pakPath']} ({record['logicalBytes']} logical bytes, SHA-256 "
            f"{record['modelSha256']}); AmaxVehicle {mapping['amaxTag']} "
            f"({mapping['amaxRecordId']}, dynamics ref {mapping['amaxRefIndex']}) "
            f"carries this exact RP_CarDynamics id and the engine derives "
            f"models/vehicles/%s.model from the tag; nameSimilarityUsed=false; "
            f"{len(record['prefixCandidates'])} prefix candidate(s) recorded")
    return (
        f"roster name {record['name']} (record {record['record']['index']}/"
        f"{record['record']['id']}) -> normalised '{record['normalisedName']}' -> "
        f"exact pak entry {record['pakPath']} ({record['logicalBytes']} logical "
        f"bytes, SHA-256 {record['modelSha256']}); "
        f"{len(record['prefixCandidates'])} prefix candidate(s) recorded and "
        f"excluded by exact name")


def _install_parent_envelope_axis(bm, evidence: dict) -> list[tuple[str, object]]:
    """Let an inflated member union fall back to the e_wheel_* parent envelope.

    The committed builder already does this when the member union is thin on X
    and round on Y/Z. This helper makes the same measured fallback available to
    a decision: the parent's own serialized bounds are the authority only when
    the member union fails that test. Nothing is guessed; every fallback is
    recorded.
    """
    member_parent: dict[tuple, dict] = {}
    original_parse = bm.parse_mdldat
    original_union = bm.union_bounds
    fallbacks: list[dict] = []

    def parse(data: bytes) -> dict:
        mdl = original_parse(data)
        elements = [element for element in mdl["elements"]
                    if element["modelIndex"] == 0]
        by_index = {element["index"]: element for element in elements}
        for element in elements:
            parent = by_index.get(element["parent"])
            if parent and parent["name"].lower().startswith("e_wheel_"):
                member_parent[(tuple(element["min"]),
                               tuple(element["max"]))] = parent
        return mdl

    def union_bounds(bounds_list: list[dict]) -> tuple[list[float], list[float]]:
        keys = [(tuple(item["min"]), tuple(item["max"]))
                for item in bounds_list]
        parents = {member_parent[key]["name"] for key in keys
                   if key in member_parent}
        if keys and len(parents) == 1 and all(k in member_parent for k in keys):
            lo, hi = original_union(bounds_list)
            extent = [hi[i] - lo[i] for i in range(3)]
            delta = abs(extent[1] - extent[2]) / max(extent[1], extent[2])
            thin = extent[0] < extent[1] and extent[0] < extent[2]
            if not (thin and delta <= 0.10):
                parent = member_parent[keys[0]]
                parent_extent = [parent["max"][i] - parent["min"][i]
                                 for i in range(3)]
                fallbacks.append({
                    "parent": parent["name"],
                    "memberUnionExtent": extent,
                    "memberUnionRoundRelativeDelta": delta,
                    "parentExtent": parent_extent,
                    "parentRoundRelativeDelta": abs(
                        parent_extent[1] - parent_extent[2])
                        / max(parent_extent[1], parent_extent[2]),
                })
                return list(parent["min"]), list(parent["max"])
        return original_union(bounds_list)

    bm.parse_mdldat = parse
    bm.union_bounds = union_bounds
    evidence["axisFallbacks"] = fallbacks
    evidence["note"] = (
        "the e_wheel_* parent's own serialized bounds are the wheel envelope; "
        "the member union is still used whenever it already proves thin X / "
        "round Y/Z")
    return [("parse_mdldat", original_parse),
            ("union_bounds", original_union)]


def _install_orphan_corner_from_translation(
        bm, evidence: dict) -> list[tuple[str, object]]:
    """Assign a wheel element to the one e_wheel_* parent its matrix matches.

    Some models serialize a wheel part as a child of DefaultElement instead of
    the wheel parent. The serialized parent is never rewritten in the output:
    the builder's `classify` is wrapped, the parent is changed only for the
    duration of that call, and it is restored before `build` writes the
    manifest. The corner proof is the element matrix translation against the
    four e_wheel_* translations; the local bounds are recorded as-is.
    """
    original_classify = bm.classify
    orphan_rows: list[dict] = []

    def classify(scene: dict, mdl: dict, model_bounds: dict) -> dict:
        elements = [element for element in mdl["elements"]
                    if element["modelIndex"] == 0]
        by_index = {element["index"]: element for element in elements}
        wheel_parents = [element for element in elements
                         if element["name"].lower().startswith("e_wheel_")]
        wheel_parent_indexes = {element["index"] for element in wheel_parents}
        saved: list[tuple[dict, int]] = []
        for element in elements:
            if bm.wheel_kind(element["name"]) is None:
                continue
            if element["parent"] in wheel_parent_indexes:
                continue
            translation = element["matrix"][3][:3]
            ranked = sorted(
                ((sum((translation[i] - parent["matrix"][3][i]) ** 2
                      for i in range(3)) ** 0.5, parent)
                 for parent in wheel_parents),
                key=lambda item: (item[0], item[1]["name"]))
            if not ranked:
                raise Unsupported(f"{element['name']}: no e_wheel_* parent exists")
            nearest_distance, nearest = ranked[0]
            second_distance = ranked[1][0] if len(ranked) > 1 else None
            if nearest_distance > 0.05 or (second_distance is not None
                                           and second_distance < 0.5):
                raise Unsupported(
                    f"{element['name']} (element {element['index']}) is parented to "
                    f"{(by_index.get(element['parent']) or {}).get('name')!r} and "
                    f"its translation {translation} does not match exactly one "
                    f"e_wheel_* parent: nearest {nearest['name']} at "
                    f"{nearest_distance:.6f} m, second "
                    f"{second_distance if second_distance is None else round(second_distance, 6)} m")
            shared = sorted(
                other["name"] for other in elements
                if other is not element and bm.wheel_kind(other["name"]) is not None
                and all(abs(other["min"][i] - element["min"][i]) <= 1e-5
                        and abs(other["max"][i] - element["max"][i]) <= 1e-5
                        for i in range(3)))
            orphan_rows.append({
                "name": element["name"],
                "index": element["index"],
                "serializedParent": (by_index.get(element["parent"]) or {}).get("name"),
                "serializedParentIndex": element["parent"],
                "matchedWheelParent": nearest["name"],
                "matchedWheelParentIndex": nearest["index"],
                "elementTranslation": translation,
                "wheelParentTranslation": nearest["matrix"][3][:3],
                "distanceMeters": nearest_distance,
                "secondNearestParent": (ranked[1][1]["name"]
                                        if len(ranked) > 1 else None),
                "secondNearestDistanceMeters": second_distance,
                "localBounds": {"min": element["min"], "max": element["max"]},
                "sharedLocalBoundsWith": shared,
            })
            saved.append((element, element["parent"]))
            element["parent"] = nearest["index"]
        try:
            return original_classify(scene, mdl, model_bounds)
        finally:
            for element, original_parent in saved:
                element["parent"] = original_parent

    bm.classify = classify
    evidence["orphanCorners"] = orphan_rows
    evidence["orphanCornerNote"] = (
        "the serialized parent stays DefaultElement; the corner is proven by the "
        "element matrix translation matching exactly one e_wheel_* parent, and "
        "the parent is restored before the manifest is written")
    return [("classify", original_classify)]


def build_manifest_with_decisions(record: dict, decision: dict, out_root: Path,
                                  scene_exe: Path, model_exe: Path) -> dict:
    """Run the committed part builder with one typed, evidence-based decision.

    The decision is data, not a guess: every substituted value comes from the
    same decoded model or the committed Scene reader. The decision is recorded
    in the returned record (`builderDecision`) and must be ported into
    `probes/car-parts/tools/build_manifest.py` before the committed build can
    reproduce the artifacts; this wrapper only stages them.
    """
    import argparse
    import build_manifest as bm

    slug = record["slug"]
    out_dir = Path(out_root) / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    model_path = ROOT / record["decodedModel"]
    args = argparse.Namespace(
        model=model_path,
        scene_exe=Path(scene_exe),
        model_exe=Path(model_exe),
        scene_json=None,
        out_dir=out_dir,
        mesh_out=None,
        car_slug=slug,
        car_name=record["name"],
        car_mapping=_mapping_text(record),
        model_pak_path=record["pakPath"],
    )
    evidence = {"kind": decision["kind"], "detail": decision["detail"]}
    restore: list[tuple[str, object]] = []
    try:
        if decision["kind"] == "skip-empty-draws":
            raw = run([str(scene_exe), str(model_path)], timeout=300)
            if raw.returncode != 0:
                raise Unsupported(
                    f"scene_inspect failed: {(raw.stderr or raw.stdout)[:300]}")
            raw_text = raw.stdout
            scene = json.loads(raw_text)
            removed = [index for index, draw in enumerate(scene["draws"])
                       if int(draw.get("indexCount") or 0) == 0]
            scene["draws"] = [draw for draw in scene["draws"]
                              if int(draw.get("indexCount") or 0) > 0]
            filtered_path = out_dir / "scene-filtered.json"
            filtered_path.write_text(
                json.dumps(scene, indent=1, sort_keys=True) + "\n",
                encoding="utf-8", newline="\n")
            (out_dir / "scene-report.raw.json").write_text(
                raw_text, encoding="utf-8", newline="\n")
            args.scene_json = filtered_path
            evidence.update({
                "removedDraws": removed,
                "rawDrawCount": len(scene["draws"]) + len(removed),
                "keptDrawCount": len(scene["draws"]),
                "rawSceneSha256": sha256_bytes(raw_text.encode("utf-8")),
                "filteredSceneSha256": sha256_file(filtered_path),
                "note": "indexCount 0 draws contribute no geometry; the committed "
                        "builder is fed the filtered scene through --scene-json",
            })
        elif decision["kind"] == "wheel-axis-from-parent-envelope":
            restore = _install_parent_envelope_axis(bm, evidence)
        elif decision["kind"] == "wheel-orphan-corner-from-translation":
            restore = _install_orphan_corner_from_translation(bm, evidence)
        elif decision["kind"] == "wheel-member-name-variant-and-axis-fallback":
            original_wheel_kind = bm.wheel_kind

            def wheel_kind(name: str) -> str | None:
                if name.lower().startswith("e_brake_caliper_"):
                    return "brakeCaliper"
                return original_wheel_kind(name)

            bm.wheel_kind = wheel_kind
            model_path = ROOT / record["decodedModel"]
            mdl = bm.parse_mdldat(model_path.read_bytes())
            by_index = {element["index"]: element for element in mdl["elements"]}
            evidence["nameVariants"] = [{
                "index": element["index"],
                "name": element["name"],
                "parent": (by_index.get(element["parent"]) or {}).get("name"),
                "parentIndex": element["parent"],
                "matrixTranslation": element["matrix"][3][:3],
                "localBounds": {"min": element["min"], "max": element["max"]},
            } for element in mdl["elements"]
                if element["modelIndex"] == 0
                and element["name"].lower().startswith("e_brake_caliper_")]
            evidence["nameVariantNote"] = (
                "the committed prefix table has e_brakecaliper_; the two rear "
                "calipers serialize as e_brake_caliper_ (an extra underscore). "
                "The variant is matched by the same name rule and every matched "
                "element is recorded; no element is renamed in the output")
            restore = _install_parent_envelope_axis(bm, evidence)
            restore.append(("wheel_kind", original_wheel_kind))
        else:
            raise Unsupported(f"{slug}: unknown builder decision {decision['kind']!r}")
        try:
            summary = bm.build(args)
        except bm.Unsupported as error:
            raise Unsupported(f"{slug}: {error}") from error
    finally:
        for name, original in restore:
            setattr(bm, name, original)

    manifest_path = Path(summary["manifest"])
    mesh_path = Path(summary["mesh"])
    scene_path = Path(summary["sceneReport"])
    built = json.loads(manifest_path.read_text(encoding="utf-8"))
    if decision["kind"] in ("wheel-orphan-corner-from-translation",
                            "wheel-member-name-variant-and-axis-fallback"):
        evidence["builtDiagnostics"] = {
            "wheelElementCount": built["diagnostics"]["wheelElementCount"],
            "brakeCaliperDrawCount": built["diagnostics"]["brakeCaliperDrawCount"],
            "ambiguousWheelDrawCount": built["diagnostics"]["ambiguousWheelDrawCount"],
        }
    record.update({
        "mapped": True,
        "manifest": str(manifest_path.relative_to(ROOT)).replace("\\", "/"),
        "manifestSha256": "sha256:" + summary["manifestSha256"],
        "manifestBytes": summary["manifestBytes"],
        "mesh": str(mesh_path.relative_to(ROOT)).replace("\\", "/"),
        "meshSha256": "sha256:" + summary["meshSha256"],
        "meshPositionsSha256": "sha256:" + summary["meshPositionsSha256"],
        "meshIndicesSha256": "sha256:" + summary["meshIndicesSha256"],
        "sceneReport": str(scene_path.relative_to(ROOT)).replace("\\", "/"),
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
        "builderDecision": evidence,
    })
    return record


def resolve_sources(cars_doc: dict, alias_doc: dict, amax_vehicles: dict,
                    hud_doc: dict) -> list[dict]:
    cars = {row["index"]: row for row in cars_doc["records"]}
    aliases = {row["index"]: row for row in alias_doc["records"]}
    hud = {row["recordIndex"]: row for row in hud_doc["records"]}
    sources = []
    for index in C_INDEXES + B_INDEXES:
        car = cars.get(index)
        if car is None:
            raise Unsupported(f"record {index} missing from cars.json")
        if index in C_INDEXES:
            alias = aliases.get(index)
            if alias is None or alias["status"] != "provable":
                raise Unsupported(f"record {index} is not a provable C alias")
            body = {
                "pakPath": alias["intendedModel"]["pakPath"],
                "logicalBytes": alias["intendedModel"]["logicalBytes"],
                "sha256": alias["intendedModel"]["sha256"],
                "decodedPath": alias["intendedModel"]["decodedPath"],
            }
            wheel = {
                "pakPath": alias["wheelModel"]["pakPath"],
                "logicalBytes": alias["wheelModel"]["logicalBytes"],
                "sha256": alias["wheelModel"]["sha256"],
                "decodedPath": alias["wheelModel"]["decodedPath"],
            }
            identity = {
                "class": "C",
                "amaxTag": alias["identity"]["amaxTag"],
                "amaxRecordId": alias["identity"]["amaxRecordId"],
                "amaxRefIndex": alias["identity"]["amaxRefIndex"],
                "evidence": alias["reason"],
            }
            mapping = (
                f"C alias (provable, batch 3): record {index}/{car['id']} {car['name']} -> "
                f"AmaxVehicle {alias['identity']['amaxTag']} "
                f"(record {alias['identity']['amaxRecordId']}, dynamics ref "
                f"{alias['identity']['amaxRefIndex']}) -> {body['pakPath']} "
                f"({body['logicalBytes']} bytes, SHA-256 {body['sha256']})")
        else:
            if car["class"] != "B" or car["model"]["mapping"] != "exact":
                raise Unsupported(f"record {index} is not an exact class-B model")
            body = {
                "pakPath": car["model"]["pakPath"],
                "logicalBytes": car["model"]["logicalBytes"],
                "sha256": car["model"]["modelSha256"],
                "decodedPath": car["model"]["decodedPath"],
            }
            amax = amax_vehicles.get(hud[index]["amaxTag"])
            if amax is None:
                raise Unsupported(f"record {index}: no AmaxVehicle row for the body tag")
            dynamics = amax.get("dynamics") or {}
            if dynamics.get("recordId") != car["id"]:
                raise Unsupported(f"record {index}: AmaxVehicle dynamics id differs")
            wheel_name = amax.get("wheelFileName")
            if not wheel_name:
                raise Unsupported(f"record {index}: AmaxVehicle has no wheelFileName")
            wheel = {
                "pakPath": f"\\models\\vehicles\\wheels\\{wheel_name}.model",
                "source": f"AmaxVehicle.wheelModel.fileName ({amax['tag']})",
            }
            identity = {
                "class": "B",
                "amaxTag": amax["tag"],
                "amaxRecordId": amax["recordId"],
                "amaxRefIndex": dynamics.get("refIndex"),
                "evidence": (
                    f"exact \\models\\vehicles\\<tag>.model mapping; AmaxVehicle "
                    f"{amax['tag']} dynamics -> RP_CarDynamics {car['id']}"),
            }
            mapping = (
                f"B exact (batch 3): record {index}/{car['id']} {car['name']} -> "
                f"AmaxVehicle {amax['tag']} (record {amax['recordId']}, dynamics ref "
                f"{dynamics.get('refIndex')}) -> {body['pakPath']} "
                f"({body['logicalBytes']} bytes, SHA-256 {body['sha256']})")
        if index not in hud:
            raise Unsupported(f"record {index} missing from the HUD catalog")
        body_path = ROOT / body["decodedPath"]
        if not body_path.is_file():
            raise Unsupported(f"record {index}: decoded body missing {body_path}")
        if sha256_file(body_path) != body["sha256"]:
            raise Unsupported(f"record {index}: decoded body hash differs")
        physics = car["physics"]
        if not physics["gatePass"]:
            raise Unsupported(f"record {index}: physics gate failed")
        sources.append({
            "index": index,
            "class": identity["class"],
            "recordId": car["id"],
            "name": car["name"],
            "slug": car["slug"],
            "drivetrain": car["drivetrain"],
            "mass": physics["mass"],
            "gearCount": int(physics["values"]["gearCount"]),
            "physics": {
                "fieldsPath": physics["fieldsPath"],
                "fieldsSha256": physics["fieldsSha256"],
                "gatePass": physics["gatePass"],
                "wheelBase": physics["wheelBase"],
                "driveType": physics["driveType"],
            },
            "body": body,
            "wheel": wheel,
            "identity": identity,
            "mapping": mapping,
            "hud": hud[index],
        })
    return sources


def stage_car(source: dict, out_root: Path, cache_dir: Path,
              render: bool) -> dict:
    slug = source["slug"]
    out_dir = out_root / slug
    out_dir.mkdir(parents=True, exist_ok=True)

    body_path = ROOT / source["body"]["decodedPath"]
    wheel = dict(source["wheel"])
    if "decodedPath" not in wheel:
        decoded = decode_wheel(wheel["pakPath"], cache_dir)
        wheel.update(decoded)
    wheel_path = ROOT / wheel["decodedPath"]
    if not wheel_path.is_file():
        raise Unsupported(f"{slug}: decoded wheel missing {wheel_path}")
    actual_wheel_hash = sha256_file(wheel_path)
    if "sha256" in wheel and wheel["sha256"] != actual_wheel_hash:
        raise Unsupported(f"{slug}: decoded wheel hash differs")
    wheel["sha256"] = actual_wheel_hash

    builder = run([
        sys.executable, str(BUILD_MANIFEST),
        "--model", str(body_path),
        "--scene-exe", str(SCENE_EXE),
        "--model-exe", str(MODEL_EXE),
        "--out-dir", str(out_dir),
        "--car-slug", slug,
        "--car-name", source["name"],
        "--car-mapping", source["mapping"],
        "--model-pak-path", source["body"]["pakPath"],
    ], timeout=900)
    (out_root / "logs").mkdir(exist_ok=True)
    (out_root / "logs" / f"{slug}-build.json").write_text(
        builder.stdout or "", encoding="utf-8", newline="\n")
    if builder.returncode != 0:
        raise Unsupported(f"{slug}: build_manifest failed: "
                          f"{(builder.stderr or builder.stdout)[:500]}")
    summary = json.loads(builder.stdout)
    manifest_path = out_dir / "manifest.json"
    mesh_path = out_dir / "mesh.json"
    scene_path = out_dir / "scene-report.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    scene = json.loads(scene_path.read_text(encoding="utf-8"))
    scene_summary = audit_cars.scene_summary(scene)
    diagnostics = manifest["diagnostics"]
    groups = manifest["wheelGroups"]
    draws = manifest["draws"]
    materials = material_pass(body_path, out_dir / "materials")
    wheel_scene = scene_reader(wheel_path)
    wheel_model = model_reader(wheel_path)

    previews = []
    if render:
        previews = render_preview.render_all(
            json.loads(mesh_path.read_text(encoding="utf-8")), 480, 270, out_dir)

    wheel_group_rows = []
    for group in groups:
        wheel_group_rows.append({
            "id": group["id"],
            "name": group["name"],
            "provenDraws": len(group["provenDraws"]),
            "previewDraws": len(group["previewDraws"]),
            "ambiguousDraws": len(group["ambiguousDraws"]),
            "axis": group["spin"]["axis"],
            "caliper": group.get("caliper", "present"),
            "absentMembers": [member["wheelPart"]
                              for member in group.get("absentMembers", [])],
        })

    blockers = []
    if diagnostics["ambiguousWheelDrawCount"]:
        blockers.append({
            "kind": "wheel-corner-preview-only",
            "count": diagnostics["ambiguousWheelDrawCount"],
            "note": "Wheel corner identity is preview-paired; no corner is guessed. "
                    "Same tier as the batch-1 medium B cars.",
        })
    if diagnostics.get("absentWheelParts"):
        blockers.append({
            "kind": "brake-caliper-absent",
            "parts": diagnostics["absentWheelParts"],
            "note": "Typed absence recorded by the builder; no caliper mesh is invented.",
        })
    if scene_summary["uv0PlaceholderVertices"]:
        blockers.append({
            "kind": "uv0-placeholder-vertices",
            "count": scene_summary["uv0PlaceholderVertices"],
            "note": "Placeholder UVs stay zero; draws without UV0 cannot bind albedo.",
        })
    if scene_summary["partialSceneTraversal"]:
        blockers.append({
            "kind": "partial-scene-traversal",
            "scope": scene_summary["scope"],
            "note": "First resource block / first render list LOD0 only; no high LODs, "
                    "visibility or runtime materials.",
        })
    blockers.append({
        "kind": "hud-icon-vector-decode-unsupported",
        "note": "IPF sprite names resolve; vector icon pixels/shapes are not decoded.",
    })
    if source["hud"]["iconSprite"] != Path(
            source["body"]["pakPath"].replace("\\", "/")).stem.lower():
        blockers.append({
            "kind": "icon-declared-parent",
            "iconSprite": source["hud"]["iconSprite"],
            "note": "AmaxVehicle.UiIconName declares this parent/base icon; no "
                    "variant-specific sprite exists in car_icons.ipf.",
        })
    blockers.append({
        "kind": "e1-integration-pending",
        "owner": "V7",
        "note": "Roster, P52 materials, geometry pins, ghosts and browser captures "
                "are not touched by this staging probe.",
    })

    checks = {
        "bodyHash": sha256_file(body_path) == source["body"]["sha256"],
        "wheelHash": sha256_file(wheel_path) == wheel["sha256"],
        "manifestBuilt": manifest_path.is_file(),
        "bodyDraws": diagnostics["bodyDrawCount"] > 0,
        "fourWheelGroups": diagnostics["wheelGroupCount"] == 4,
        "twentyWheelDraws": diagnostics["wheelDrawCount"] == 20,
        "drawsOwnedOnce": len(draws) == diagnostics["drawCount"],
        "uv0": scene_summary["uv0ValidVertices"] > 0,
        "uv0Draws": scene_summary["uv0DrawsAvailable"] > 0,
        "textures": materials["staticAlbedoDraws"] > 0
                    and materials["uniqueTextureCount"] > 0,
        "wheelScene": wheel_scene["status"] == "ok" and wheel_scene["drawCount"] > 0,
        "wheelModel": wheel_model["status"] == "ok",
        "physicsGate": source["physics"]["gatePass"],
        "hudName": bool(source["hud"]["hudName"]),
        "hudIcon": bool(source["hud"]["iconSprite"]),
        "previews": (not render) or (len(previews) == 3
                                     and all(view["coverage"] > 0.12 for view in previews)),
    }
    status = "staged" if all(checks.values()) else "partial"
    return {
        "recordIndex": source["index"],
        "recordId": source["recordId"],
        "recordName": source["name"],
        "slug": slug,
        "class": source["class"],
        "drivetrain": source["drivetrain"],
        "mass": source["mass"],
        "gearCount": source["gearCount"],
        "identity": source["identity"],
        "body": {
            "pakPath": source["body"]["pakPath"],
            "logicalBytes": source["body"]["logicalBytes"],
            "sha256": source["body"]["sha256"],
            "decodedPath": source["body"]["decodedPath"],
            "drawCount": diagnostics["drawCount"],
            "partCount": diagnostics["partCount"],
            "namedPartCount": diagnostics["namedPartCount"],
            "vertexCount": scene_summary["vertexCount"],
            "triangleCount": scene_summary["triangleCount"],
            "bounds": scene_summary["bounds"],
            "scene": scene_summary,
            "materials": materials,
            "wheelDrawCount": diagnostics["wheelDrawCount"],
            "tyreDrawCount": diagnostics["tyreDrawCount"],
            "rimDrawCount": diagnostics["rimDrawCount"],
            "brakeDiscDrawCount": diagnostics["brakeDiscDrawCount"],
            "brakeCaliperDrawCount": diagnostics["brakeCaliperDrawCount"],
            "provenWheelDrawCount": diagnostics["provenWheelDrawCount"],
            "ambiguousWheelDrawCount": diagnostics["ambiguousWheelDrawCount"],
            "tyreProofTier": diagnostics["tyreProofTier"],
            "bodyDrawCount": diagnostics["bodyDrawCount"],
            "interiorDrawCount": diagnostics["interiorDrawCount"],
            "glassDrawCount": diagnostics["glassDrawCount"],
            "lightDrawCount": diagnostics["lightDrawCount"],
            "unclassifiedDrawCount": diagnostics["unclassifiedDrawCount"],
        },
        "wheel": {
            "pakPath": wheel["pakPath"],
            "logicalBytes": wheel["logicalBytes"],
            "sha256": wheel["sha256"],
            "decodedPath": wheel["decodedPath"],
            "source": wheel.get("source", "c-aliases.json wheelModel"),
            "scene": wheel_scene,
            "model": wheel_model,
        },
        "wheelGroups": wheel_group_rows,
        "physics": source["physics"],
        "hud": source["hud"],
        "artifacts": {
            "manifest": rel(manifest_path),
            "manifestSha256": summary["manifestSha256"],
            "manifestBytes": summary["manifestBytes"],
            "mesh": rel(mesh_path),
            "meshSha256": summary["meshSha256"],
            "meshPositionsSha256": summary["meshPositionsSha256"],
            "meshIndicesSha256": summary["meshIndicesSha256"],
            "sceneReport": rel(scene_path),
            "sceneReportSha256": summary["sceneReportSha256"],
        },
        "previews": previews,
        "blockers": blockers,
        "checks": checks,
        "status": status,
    }


def roster_document(records: list[dict]) -> dict:
    entries = []
    ghosts = []
    for record in records:
        layout = f"{record['drivetrain']}, {int(round(record['mass']))} kg, " \
                 f"{record['gearCount']}-speed"
        if record["class"] == "C":
            why = (f"V3/V6 batch 3 (medium C): record {record['recordIndex']}/"
                   f"{record['recordId']} resolves through AmaxVehicle "
                   f"{record['identity']['amaxTag']} to {record['body']['pakPath']}; "
                   f"{record['body']['drawCount']} draws, all "
                   f"{record['body']['ambiguousWheelDrawCount']} wheel draws "
                   f"preview-paired (no corner guessed).")
        else:
            why = (f"V1/V6 batch 3 (high-confidence B): exact "
                   f"{record['body']['pakPath']}, {record['body']['drawCount']} draws / "
                   f"{record['body']['materials']['staticAlbedoDraws']} static, "
                   f"{record['body']['materials']['uniqueTextureCount']} textures, "
                   f"{record['drivetrain']}.")
        entries.append({
            "slug": record["slug"],
            "name": record["recordName"],
            "recordId": record["recordId"],
            "recordIndex": record["recordIndex"],
            "layout": layout,
            "why": why,
        })
        for course in ("310m", "short"):
            ghosts.append({
                "slug": record["slug"],
                "course": course,
                "file": f"probes/e1-drive/ghosts/{record['slug']}-{course}.json",
                "generatedBy": "node probes/e1-drive/tools/verify_e1_drive.mjs --write-ghosts",
                "status": "pending-V7",
            })
    return {
        "kind": "blur.vehicle-batch3-roster-staging",
        "version": 1,
        "generatedBy": "probes/vehicle-pipeline/tools/stage_batch3.py",
        "targetRoster": "probes/e1-drive/cars/roster.json",
        "note": "Append these entries verbatim after the batch-2 entries; do not edit "
                "the five A anchors. The main agent owns roster.json and the four "
                "hard-coded count/hash guards.",
        "entries": entries,
        "ghosts": {
            "index": "probes/e1-drive/ghosts/index.json",
            "encoding": "position3 + quaternion4 + wheelAngle4 per engine tick, "
                        "float32le base64",
            "sampleHz": 60,
            "courses": ["310m", "short"],
            "files": ghosts,
        },
        "captures": {
            "minimum": [
                {"mode": "sprint", "course": "310m", "purpose":
                 "every new car finishes the 310 m scripted course; state hash pinned"},
                {"mode": "sprint", "course": "short", "purpose":
                 "29 m regression course and short ghost"},
            ],
            "sample": [
                {"mode": "lap", "course": "loop-01", "purpose":
                 "3-lap restart/replay on a sample of the batch"},
                {"mode": "free", "course": "free", "purpose":
                 "free-roam spawn/reset on a sample of the batch"},
                {"mode": "restart", "purpose": "in-place restart without reload"},
                {"mode": "chunk", "purpose":
                 "per-car chunk load/page budget after the roster grows"},
            ],
            "requirements": [
                "1600x900 screenshot per captured car/mode",
                "console messages 0, no warnings",
                "stateSequenceHash identical across two runs of the same car",
                "existing five A anchors unchanged",
            ],
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out-root", type=Path, default=OUT_DEFAULT)
    parser.add_argument("--skip-previews", action="store_true")
    parser.add_argument("--only", default=None,
                        help="comma-separated record indices (debug/smoke only)")
    args = parser.parse_args()

    out_root = args.out_root if args.out_root.is_absolute() else ROOT / args.out_root
    out_root.mkdir(parents=True, exist_ok=True)
    cache_dir = ROOT / "_work/vehicle-pipeline/batch3/models/wheels"

    for path in (CARS_JSON, C_ALIASES, AMAX_JSONL, HUD_CATALOG):
        if not path.is_file():
            raise Unsupported(f"missing input {rel(path)}")
    cars_doc = json.loads(CARS_JSON.read_text(encoding="utf-8"))
    alias_doc = json.loads(C_ALIASES.read_text(encoding="utf-8"))
    hud_doc = json.loads(HUD_CATALOG.read_text(encoding="utf-8"))
    sources = resolve_sources(cars_doc, alias_doc, amax_vehicles(), hud_doc)
    if args.only:
        wanted = {int(value) for value in args.only.split(",") if value.strip()}
        sources = [source for source in sources if source["index"] in wanted]
        if not sources:
            raise Unsupported(f"--only selected no records: {args.only}")

    records = []
    for source in sources:
        print(f"staging {source['index']:3d} {source['slug']} ({source['class']}) -> "
              f"{source['body']['pakPath']}", flush=True)
        try:
            record = stage_car(source, out_root, cache_dir, not args.skip_previews)
        except Unsupported as error:
            record = {
                "recordIndex": source["index"], "recordId": source["recordId"],
                "recordName": source["name"], "slug": source["slug"],
                "class": source["class"], "status": "error",
                "reason": str(error), "checks": {},
            }
        print(f"  {record['status']}: "
              f"{record.get('body', {}).get('drawCount', '?')} draws / "
              f"{record.get('body', {}).get('partCount', '?')} parts / "
              f"{record.get('body', {}).get('wheelDrawCount', '?')} wheel draws", flush=True)
        records.append(record)

    roster = roster_document([record for record in records if record["status"] == "staged"])
    roster_path = out_root / "roster.json"
    roster_path.write_bytes(
        (json.dumps(roster, indent=1, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8"))

    staged = [record for record in records if record["status"] == "staged"]
    payload = {
        "kind": "blur.vehicle-batch3-staging",
        "version": 1,
        "generatedBy": "probes/vehicle-pipeline/tools/stage_batch3.py",
        "status": "PASS" if len(staged) == len(records) else "PARTIAL",
        "outRoot": rel(out_root),
        "sources": {
            "carsJson": {"path": rel(CARS_JSON), "sha256": sha256_file(CARS_JSON)},
            "cAliases": {"path": rel(C_ALIASES), "sha256": sha256_file(C_ALIASES)},
            "amaxJsonl": {"path": rel(AMAX_JSONL), "sha256": sha256_file(AMAX_JSONL)},
            "hudCatalog": {"path": rel(HUD_CATALOG), "sha256": sha256_file(HUD_CATALOG)},
            "builder": {"path": rel(BUILD_MANIFEST), "sha256": sha256_file(BUILD_MANIFEST)},
            "materialTraversal": {"path": rel(MATERIAL_TRAVERSAL),
                                  "sha256": sha256_file(MATERIAL_TRAVERSAL)},
            "sceneReader": {"path": rel(SCENE_EXE), "sha256": sha256_file(SCENE_EXE)},
            "modelReader": {"path": rel(MODEL_EXE), "sha256": sha256_file(MODEL_EXE)},
            "previewRenderer": {
                "path": "probes/vehicle-pipeline/tools/render_preview.py",
                "sha256": sha256_file(ROOT / "probes/vehicle-pipeline/tools/render_preview.py"),
            },
        },
        "counts": {
            "records": len(records),
            "staged": len(staged),
            "errors": sum(1 for record in records if record["status"] == "error"),
            "classC": sum(1 for record in records if record["class"] == "C"),
            "classB": sum(1 for record in records if record["class"] == "B"),
            "bodyDraws": sum(record["body"]["drawCount"] for record in staged),
            "bodyParts": sum(record["body"]["partCount"] for record in staged),
            "wheelDraws": sum(record["body"]["wheelDrawCount"] for record in staged),
            "uv0ValidVertices": sum(record["body"]["scene"]["uv0ValidVertices"]
                                    for record in staged),
            "staticAlbedoDraws": sum(record["body"]["materials"]["staticAlbedoDraws"]
                                     for record in staged),
            "uniqueTextures": sum(record["body"]["materials"]["uniqueTextureCount"]
                                  for record in staged),
            "textureSourceBytes": sum(record["body"]["materials"]["sourceBytes"]
                                      for record in staged),
            "ambiguousWheelDraws": sum(record["body"]["ambiguousWheelDrawCount"]
                                       for record in staged),
            "previews": sum(len(record["previews"]) for record in staged),
        },
        "roster": {"path": rel(roster_path), "sha256": sha256_file(roster_path),
                   "entries": len(roster["entries"])},
        "records": records,
        "limits": [
            "Staging only: no e1-drive roster, P52 material, geometry pin, ghost, web, "
            "chunk or committed car-parts file is changed.",
            "A staged record proves the body/wheel model, part manifest, LOD0 mesh, "
            "scene report, UV0 and independent material traversal parse and agree. "
            "It is not a drive or full-game claim.",
            "Previews are deterministic CPU rasterisations of the staged LOD0 mesh "
            "(geometry only); they are not browser/GPU captures and sample no textures.",
            "Wheel-corner ambiguity is preserved as a typed blocker; no corner is guessed.",
        ],
    }
    summary_path = out_root / "summary.json"
    summary_path.write_bytes(
        (json.dumps(payload, indent=1, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8"))
    print(json.dumps({"status": payload["status"], "outRoot": rel(out_root),
                      "summary": rel(summary_path), "sha256": sha256_file(summary_path),
                      "counts": payload["counts"]}, indent=1, sort_keys=True))
    return 0 if payload["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
