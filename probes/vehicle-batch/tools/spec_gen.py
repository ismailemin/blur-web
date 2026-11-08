"""Generate the 62-car batch-compiler spec from the committed audit data.

Every value in `probes/vehicle-batch/spec/cars.json` is copied or resolved from
an existing, committed artifact:

  * records, ids, class, drivetrain, mass, gears, physics gate and model
    mapping  -> `_work/vehicle-pipeline/cars.json`
  * class-C record-level aliases (AmaxVehicle.dynamics handle ->
    RP_CarDynamics id -> engine tag model) -> `_work/vehicle-pipeline/c-aliases.json`
  * AmaxVehicle identity (tag, wheel model, icon tag) ->
    `_work/vehicle-pipeline/amax-vehicles.jsonl`
  * HUD name LocId / icon sprite -> the proven `hud_catalog.py` parsers over
    `vehicles.loc`, `amax.bin` and `car_icons*.ipf` (its functions are reused;
    no parsing is reimplemented)
  * wheel proof status -> the committed batch-3 summary and every manifest
    already staged under `_work/vehicle-pipeline/manifests/`

No value is guessed. A field that cannot be resolved is written as `null`
together with a `reason` object of the shape `{code, detail}`; the compiler then
reports the car as blocked with that typed reason.

Usage:
  python probes/vehicle-batch/tools/spec_gen.py [--out <path>] [--check]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
for path in (TOOLS, ROOT / "engine/harness/t005d-vehicle",
             ROOT / "probes/vehicle-pipeline/tools",
             ROOT / "probes/car-parts/tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import hud_catalog  # noqa: E402  (proven LocId / IPF sprite readers)
from inspect_asset_layout import pak_index  # noqa: E402  (proven PAK index)

CARS_JSON = ROOT / "_work/vehicle-pipeline/cars.json"
C_ALIASES = ROOT / "_work/vehicle-pipeline/c-aliases.json"
AMAX_JSONL = ROOT / "_work/vehicle-pipeline/amax-vehicles.jsonl"
BATCH3_SUMMARY = ROOT / "_work/vehicle-pipeline/batch3/summary.json"
MANIFEST_ROOT = ROOT / "_work/vehicle-pipeline/manifests"
ROSTER = ROOT / "probes/e1-drive/cars/roster.json"
ROOT_PAK = ROOT / "game-data/Blur/cache/root.pak"
OUT_DEFAULT = ROOT / "probes/vehicle-batch/spec/cars.json"
VEHICLE_PREFIX = "\\models\\vehicles\\"

# Typed, evidence-based builder decisions. Each one is re-derived from the
# decoded model or the committed Scene reader; nothing is guessed. The staging
# wrapper in `probes/vehicle-pipeline/tools/stage_batch3.py` applies the decision
# to the committed builder, and the decision must be ported into
# `probes/car-parts/tools/build_manifest.py` for the committed build to
# reproduce the artifacts.
BUILDER_DECISIONS = {
    "ratrod-na-stock": {
        "kind": "wheel-axis-from-parent-envelope",
        "detail": (
            "wheel.backleft member union X extent 1.626399 m is the rear brake-disc "
            "element local bounds offset (E_BrakeDisc_BackLeft X 1.429031..1.498138) "
            "while its matrix translation equals the e_wheel_backleft parent; the "
            "parent's own serialized bounds [0.272146, 0.876655, 0.833748] are thin "
            "on X and round on Y/Z (relative delta 0.0489), so the wheel axis is X"),
    },
    "toyota-supra-smooth": {
        "kind": "skip-empty-draws",
        "detail": (
            "scene draws 48 and 50 have indexCount 0 at firstIndex 57156 and 57192; "
            "they contribute no geometry and are skipped; the other 82 draws are "
            "classified unchanged"),
    },
    "hummer-h2-rat": {
        "kind": "wheel-orphan-corner-from-translation",
        "detail": (
            "E_BrakeDisc_FrontRight1 (element 26, matrix translation "
            "[-0.915054, 0.000000, 1.578988]) and E_BrakeCaliper_FrontRight1 "
            "(element 27, [-0.926925, 0.000000, 1.577787]) are serialized as "
            "children of DefaultElement (0). Their translations match exactly one "
            "e_wheel_* parent, e_wheel_frontleft (index 1, [-0.914971, 0.000036, "
            "1.579840]), at 0.000857 m and 0.012129 m; the second-nearest wheel "
            "parent is 1.830054 m / 1.841926 m away. The corner is frontleft by "
            "the element matrix, not by a rewritten chain: the serialized parent "
            "stays DefaultElement and is restored before the manifest is written. "
            "Element 26 local bounds equal E_BrakeDisc_BackLeft (element 43), so "
            "the two brake-disc draws (29, 30) are tied between frontleft and "
            "backleft and remain preview-paired; element 27 shares no local bounds "
            "and its caliper draw (23) matches uniquely."),
    },
    "ford-supervan-stock": {
        "kind": "wheel-member-name-variant-and-axis-fallback",
        "detail": (
            "The two rear calipers serialize as E_Brake_Caliper_BackLeft (element "
            "50) and E_Brake_Caliper_BackRight (element 38), with an extra "
            "underscore; both are direct children of e_wheel_backleft/backright. "
            "The committed prefix table has e_brakecaliper_; matching the "
            "e_brake_caliper_ variant gives four caliper elements and four caliper "
            "draws: draw 12 matches element 50 and draw 17 matches element 38 at "
            "0.00101 AABB difference, in addition to the front draws 24/25 at "
            "0.00012. The rear caliper element bounds are model-space (matrix "
            "translation 0, X -0.69414..-0.64127 / 0.64127..0.69414, Z "
            "-1.33025..-1.25717), which inflates the rear member union; the "
            "e_wheel_* parent envelope [0.33770, 0.69222, 0.69222] is thin on X "
            "and round on Y/Z and proves the axle. No element is renamed and no "
            "draw or caliper is invented."),
    },
}

# The remaining refusal is a genuine asset/structure case. The diagnosis keeps
# the exact record evidence next to the typed reason; it is never used to
# invent a body, a parent chain, a wheel axis or an index range.
BUILDER_DIAGNOSES = {
    "defaultcar": (
        "RP_CarDynamics record 8 / id 515172551 / name DefaultCar is class C with "
        "classReason 'no exact normalised `\\models\\vehicles\\<name>.model` entry'. "
        "cars.json records expectedPath '\\models\\vehicles\\defaultcar.model', "
        "mapping 'none', missing ['exact model file: "
        "\\models\\vehicles\\defaultcar.model'], logicalBytes null, pakPath null "
        "and wheelResource null. c-aliases.json records status 'unsupported', "
        "identity null, intendedModel null and wheelModel null: no "
        "AmaxVehicle.dynamics or aiDynamics handle resolves to id 515172551. The "
        "nearest pak model is the 78602-byte placeholder "
        "'\\models\\vehicles\\default.model' (median real car body 4615848 bytes) "
        "and is not referenced as a DefaultCar body. DefaultCar is the engine's "
        "physics fallback (LevelState.cpp:407), not a car body; no model or wheel "
        "is substituted."),
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def reason(code: str, detail: str) -> dict:
    return {"code": code, "detail": detail}


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("COUNT "):
            continue
        rows.append(json.loads(line))
    return rows


def amax_rows() -> dict[str, dict]:
    out = {}
    for row in load_jsonl(AMAX_JSONL):
        out[row["name"]] = {
            "tag": row["name"],
            "recordId": row["id"],
            "dynamicsRecordId": (row.get("dynamics") or {}).get("id"),
            "dynamicsRef": (row.get("dynamics") or {}).get("ref"),
            "wheelModel": (row.get("wheel") or {}).get("name"),
            "iconTag": row.get("icon"),
            "parentTag": (row.get("parent") or {}).get("name"),
        }
    return out


def hud_identity() -> tuple[dict[str, dict], dict]:
    """All-vehicle HUD identity, using the proven batch-3 catalog parsers."""
    vehicles_raw, _ = hud_catalog.extract_gamedata(hud_catalog.VEHICLES_LOC)
    vehicles_loc = hud_catalog.parse_loc(vehicles_raw, "vehicles.loc")
    hum = hud_catalog.amax_hud(vehicles_loc)
    atlases = []
    for path in hud_catalog.ICON_FILES:
        raw, _ = hud_catalog.extract_root(path)
        atlases.append({"path": path, "raw": raw,
                        "names": hud_catalog.parse_ipf_names(raw, path)})
    master = {row["name"] for row in atlases[0]["names"]}
    out = {}
    for tag, row in hum["vehicles"].items():
        icon = (row.get("iconTag") or "").lower()
        pages = []
        for atlas in atlases:
            sprite = next((s for s in atlas["names"] if s["name"] == icon), None)
            if sprite is not None:
                pages.append({"pakPath": atlas["path"], "offset": sprite["offset"],
                              "length": sprite["length"]})
        full = row.get("locStringFull") or row.get("locString")
        full_key = row.get("locStringFullKey") or row.get("locStringKey")
        out[tag] = {
            "amaxTag": tag,
            "amaxRecordId": row["recordId"],
            "dynamicsRecordId": row.get("dynamicsRecordId"),
            "nameKey": row.get("locStringKey"),
            "name": row.get("locString"),
            "fullNameKey": row.get("locStringFullKey"),
            "fullName": row.get("locStringFull"),
            "hudNameKey": full_key,
            "hudName": full,
            "iconTag": row.get("iconTag"),
            "iconSprite": icon or None,
            "iconPages": pages,
            "iconSpriteKnown": bool(icon) and icon in master,
            "manufacturerTag": (row.get("manufacturer") or {}).get("tag"),
            "manufacturerTexture": (row.get("manufacturer") or {}).get("texture"),
        }
    sources = {
        "vehiclesLocSha256": sha256_bytes(vehicles_raw),
        "amaxSha256": hum["sha256"],
        "amaxBytes": hum["bytes"],
        "amaxVehicles": hum["count"],
        "unresolvedLocIds": hum["unresolvedLocIds"],
        "iconAtlases": [{"pakPath": atlas["path"], "sha256": sha256_bytes(atlas["raw"]),
                         "spriteCount": len(atlas["names"])} for atlas in atlases],
        "reader": "probes/vehicle-pipeline/tools/hud_catalog.py (proven parsers)",
    }
    return out, sources


def committed_wheel_evidence(cars_doc: dict) -> dict[int, dict]:
    """Wheel-corner proof status from already staged manifests, by record index."""
    by_slug = {row["slug"]: row["index"] for row in cars_doc["records"]}
    evidence: dict[int, dict] = {}

    def from_diagnostics(diagnostics: dict, source: str) -> dict:
        proven = int(diagnostics.get("provenWheelDrawCount") or 0)
        ambiguous = int(diagnostics.get("ambiguousWheelDrawCount") or 0)
        absent = diagnostics.get("absentWheelParts") or []
        return {
            "status": "preview-only" if ambiguous else ("proven" if proven else None),
            "provenDraws": proven,
            "previewDraws": ambiguous,
            "tyreProofTier": diagnostics.get("tyreProofTier"),
            "caliper": "absent" if "brakeCaliper" in absent else "present",
            "source": source,
        }

    if BATCH3_SUMMARY.is_file():
        doc = json.loads(BATCH3_SUMMARY.read_text(encoding="utf-8"))
        for row in doc["records"]:
            if row.get("status") == "staged":
                evidence[row["recordIndex"]] = from_diagnostics(
                    row["body"], "_work/vehicle-pipeline/batch3/summary.json")
    if MANIFEST_ROOT.is_dir():
        for manifest_path in sorted(MANIFEST_ROOT.glob("*/manifest.json")):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            slug = ((manifest.get("source") or {}).get("car") or {}).get("slug")
            index = by_slug.get(slug)
            if index is None:
                continue
            evidence.setdefault(index, from_diagnostics(
                manifest["diagnostics"], rel(manifest_path)))
    return evidence


def build(verbose: bool = False) -> dict:
    cars_doc = json.loads(CARS_JSON.read_text(encoding="utf-8"))
    alias_doc = json.loads(C_ALIASES.read_text(encoding="utf-8"))
    roster = json.loads(ROSTER.read_text(encoding="utf-8"))
    roster_by_index = {car["recordIndex"]: car for car in roster["cars"]}
    roster_order = {car["recordIndex"]: position
                    for position, car in enumerate(roster["cars"], start=1)}
    aliases = {row["index"]: row for row in alias_doc["records"]}
    batch3_records = {}
    if BATCH3_SUMMARY.is_file():
        batch3_records = {row["recordIndex"]: row
                          for row in json.loads(
                              BATCH3_SUMMARY.read_text(encoding="utf-8"))["records"]}
    amax = amax_rows()
    hud, hud_sources = hud_identity()
    if verbose:
        print(f"amax vehicles: {len(amax)}, hud identities: {len(hud)}", flush=True)

    index = pak_index(ROOT_PAK)
    if index["status"] != "indexed":
        raise SystemExit("root.pak is not indexable")
    wheel_entries = {row["path"].lower(): row for row in index["entries"]
                     if not row["directory"]
                     and row["path"].lower().startswith(VEHICLE_PREFIX + "wheels\\")
                     and row["path"].lower().endswith(".model")}
    wheel_evidence = committed_wheel_evidence(cars_doc)

    entries = []
    for car in cars_doc["records"]:
        idx = car["index"]
        in_roster = idx in roster_by_index
        alias = aliases.get(idx)
        body = None
        body_reason = None
        alias_identity = None
        if car["class"] in ("A", "B"):
            model = car["model"]
            body = {
                "route": "exact",
                "pakPath": model.get("pakPath"),
                "expectedPath": model.get("expectedPath"),
                "logicalBytes": model.get("logicalBytes"),
                "sha256": model.get("modelSha256"),
                "decodedPath": model.get("decodedPath"),
                "rule": model.get("rule"),
                "prefixCandidates": model.get("prefixCandidates") or [],
            }
        elif alias is not None and alias.get("status") == "provable":
            body = {
                "route": "alias",
                "pakPath": alias["intendedModel"]["pakPath"],
                "expectedPath": car["model"].get("expectedPath"),
                "logicalBytes": alias["intendedModel"]["logicalBytes"],
                "sha256": alias["intendedModel"]["sha256"],
                "decodedPath": alias["intendedModel"]["decodedPath"],
                "rule": "record-level AmaxVehicle.dynamics handle -> RP_CarDynamics id "
                        "-> engine tag -> \\models\\vehicles\\%s.model",
                "prefixCandidates": [row["model"] for row in
                                     (car["model"].get("nearCandidates") or [])],
            }
            alias_identity = {
                "amaxTag": alias["identity"]["amaxTag"],
                "amaxRecordId": alias["identity"]["amaxRecordId"],
                "amaxRefIndex": alias["identity"]["amaxRefIndex"],
                "rpRecordId": alias["id"],
                "handleResolvesToExactRecordId":
                    alias["identity"]["handleResolvesToExactRecordId"],
                "nameSimilarityUsed": alias["nameSimilarityUsed"],
                "source": "_work/vehicle-pipeline/c-aliases.json",
                "reason": alias["reason"],
            }
        else:
            body_reason = reason(
                "no-body-model",
                (alias or {}).get("reason")
                or car.get("classReason")
                or "no exact or record-level model mapping exists")

        wheel = {
            "pakPath": None,
            "logicalBytes": None,
            "sha256": None,
            "decodedPath": None,
            "source": None,
            "proof": wheel_evidence.get(idx) or {
                "status": None,
                "provenDraws": None,
                "previewDraws": None,
                "tyreProofTier": None,
                "caliper": None,
                "reason": reason(
                    "wheel-proof-not-committed",
                    "no committed manifest classifies this car's wheel draws; the "
                    "batch compiler measures proven/preview draws at stage time"),
            },
        }
        if body is None:
            wheel["reason"] = reason(
                "no-body-model",
                "no body model means no wheel model can be resolved for this record")
        body_stem = Path((body or {}).get("pakPath") or "").name
        if body_stem.lower().endswith(".model"):
            body_stem = body_stem[:-len(".model")]
        candidate = next((row for row in amax.values()
                          if row["tag"].lower() == body_stem.lower()), None)
        if candidate is not None:
            wheel_name = candidate.get("wheelModel")
            if wheel_name:
                path = f"{VEHICLE_PREFIX}wheels\\{wheel_name}.model"
                entry = wheel_entries.get(path.lower())
                wheel.update({
                    "pakPath": entry["path"] if entry else path,
                    "logicalBytes": entry["logical_bytes"] if entry else None,
                    "source": f"AmaxVehicle.wheelModel.fileName ({candidate['tag']})",
                })
                if entry is None:
                    wheel["reason"] = reason(
                        "wheel-model-missing",
                        f"AmaxVehicle {candidate['tag']} names {path!r}, which is not "
                        f"in root.pak")
            else:
                wheel["reason"] = reason(
                    "wheel-model-unknown",
                    f"AmaxVehicle {candidate['tag']} has no wheel model name")
        elif body is not None:
            wheel["reason"] = reason(
                "wheel-identity-unresolved",
                f"no AmaxVehicle tag matches the body model stem {body_stem!r}")
        if alias is not None and alias.get("status") == "provable":
            wheel.update({
                "pakPath": alias["wheelModel"]["pakPath"],
                "logicalBytes": alias["wheelModel"]["logicalBytes"],
                "sha256": alias["wheelModel"]["sha256"],
                "decodedPath": alias["wheelModel"]["decodedPath"],
                "source": "c-aliases.json wheelModel (engine wheel path for the tag)",
            })
            wheel.pop("reason", None)

        if candidate is not None and candidate["tag"] in hud:
            row = hud[candidate["tag"]]
            hud_entry = {
                "nameKey": row["nameKey"],
                "name": row["name"],
                "fullNameKey": row["fullNameKey"],
                "fullName": row["fullName"],
                "hudNameKey": row["hudNameKey"],
                "hudName": row["hudName"],
                "iconSprite": row["iconSprite"],
                "iconTag": row["iconTag"],
                "iconSpriteKnown": row["iconSpriteKnown"],
                "iconPages": row["iconPages"],
                "manufacturerTag": row["manufacturerTag"],
                "manufacturerTexture": row["manufacturerTexture"],
                "amaxTag": row["amaxTag"],
                "amaxRecordId": row["amaxRecordId"],
            }
            if not hud_entry["iconSpriteKnown"]:
                hud_entry["iconReason"] = reason(
                    "icon-sprite-not-in-atlas",
                    f"sprite {hud_entry['iconSprite']!r} is not a length-prefixed "
                    f"name in car_icons.ipf; vector pixels are not decoded")
        else:
            hud_entry = None

        blockers = []
        if body is None:
            blockers.append({
                "kind": body_reason["code"],
                "detail": body_reason["detail"],
                "source": "cars.json / c-aliases.json",
            })
        if alias_identity is not None:
            blockers.append({
                "kind": "c-alias-record-level",
                "detail": f"body model comes from AmaxVehicle "
                          f"{alias_identity['amaxTag']} (dynamics ref "
                          f"{alias_identity['amaxRefIndex']}); the record name does "
                          f"not match the model file",
                "source": "_work/vehicle-pipeline/c-aliases.json",
            })
        proof = wheel["proof"]
        if proof["status"] == "preview-only":
            blockers.append({
                "kind": "wheel-corner-preview-only",
                "detail": f"{proof['previewDraws']} wheel draws are preview-paired; "
                          f"no corner is guessed",
                "source": proof["source"],
            })
        elif proof["status"] is None:
            blockers.append({
                "kind": "wheel-proof-not-committed",
                "detail": proof["reason"]["detail"],
                "source": "spec",
            })
        if wheel.get("reason"):
            blockers.append({"kind": wheel["reason"]["code"],
                             "detail": wheel["reason"]["detail"], "source": "spec"})
        if car["physics"].get("gatePass") is not True:
            blockers.append({"kind": "physics-gate-failed",
                             "detail": "RP_CarDynamics fields fail the committed gate",
                             "source": "cars.json physics.gatePass"})
        if hud_entry is None:
            blockers.append({
                "kind": "hud-identity-unresolved",
                "detail": "no AmaxVehicle LocId resolves for this record",
                "source": "_work/vehicle-pipeline/amax-vehicles.jsonl",
            })
        blockers.append({
            "kind": "hud-icon-vector-decode-unsupported",
            "detail": "IPF car icons are vector art; only sprite names/offsets are proven",
            "source": "docs/work/analysis/vehicle-batch3-prep.md §4",
        })
        if body is not None:
            blockers.append({
                "kind": "partial-scene-traversal",
                "detail": "first resource block / first RenderList LOD0 only; no high "
                          "LODs, visibility or runtime materials",
                "source": "probes/car-parts/tools/build_manifest.py",
            })
            blockers.append({
                "kind": "e1-integration-pending",
                "detail": "roster entry, P52 materials, geometry pins, ghosts and "
                          "browser captures are main-agent work; this compiler stages "
                          "data only",
                "source": "docs/work/analysis/vehicle-batch-compiler.md",
            })

        entries.append({
            "slug": car["slug"],
            "recordIndex": idx,
            "recordId": car["id"],
            "recordName": car["name"],
            "class": car["class"],
            "classReason": car["classReason"],
            "scope": "roster" if in_roster else "remaining",
            "rosterPosition": roster_order.get(idx),
            "drivetrain": car["drivetrain"],
            "massKg": car["mass"],
            "gears": int(car["physics"]["values"]["gearCount"]),
            "physics": {
                "fieldsPath": car["physics"]["fieldsPath"],
                "fieldsSha256": car["physics"]["fieldsSha256"],
                "gatePass": car["physics"]["gatePass"],
                "driveType": car["physics"]["driveType"],
                "wheelBase": car["physics"]["wheelBase"],
            },
            "body": body,
            "bodyReason": body_reason,
            "alias": alias_identity,
            "wheel": wheel,
            "hud": hud_entry,
            "blockers": blockers,
            "builderDecision": BUILDER_DECISIONS.get(car["slug"]),
            "builderDiagnosis": BUILDER_DIAGNOSES.get(car["slug"]),
            "evidence": {
                "inCommittedRoster": in_roster,
                "batch3Staged": bool(
                    batch3_records.get(idx, {}).get("status") == "staged"),
                "v1Mapped": car["class"] in ("A", "B")
                            and car["model"].get("mapping") == "exact",
            },
        })

    sources = {
        "carsJson": {"path": rel(CARS_JSON), "sha256": sha256_file(CARS_JSON)},
        "cAliases": {"path": rel(C_ALIASES), "sha256": sha256_file(C_ALIASES)},
        "amaxJsonl": {"path": rel(AMAX_JSONL), "sha256": sha256_file(AMAX_JSONL)},
        "roster": {"path": rel(ROSTER), "sha256": sha256_file(ROSTER)},
        "rootPak": {"path": "game-data/Blur/cache/root.pak",
                    "fileBytes": index["bytes"], "entryCount": index["entry_count"]},
        "hud": hud_sources,
    }

    classes = {name: 0 for name in ("A", "B", "C")}
    for entry in entries:
        classes[entry["class"]] += 1
    return {
        "kind": "blur.vehicle-batch.spec",
        "version": 1,
        "generatedBy": "probes/vehicle-batch/tools/spec_gen.py",
        "rule": (
            "One entry per RP_CarDynamics record. Values are copied from the "
            "committed audit; unknown values stay null with a typed reason. No model "
            "alias is invented: class-B entries use the exact normalised pak name, "
            "class-C entries use the record-level AmaxVehicle.dynamics identity only."),
        "sources": sources,
        "counts": {
            "records": len(entries),
            "classA": classes["A"], "classB": classes["B"], "classC": classes["C"],
            "inRoster": sum(1 for e in entries if e["scope"] == "roster"),
            "remaining": sum(1 for e in entries if e["scope"] == "remaining"),
            "withBody": sum(1 for e in entries if e["body"] is not None),
            "withHud": sum(1 for e in entries if e["hud"] is not None),
            "wheelProofKnown": sum(1 for e in entries
                                   if e["wheel"]["proof"]["status"] is not None),
        },
        "cars": entries,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=OUT_DEFAULT)
    parser.add_argument("--check", action="store_true",
                        help="regenerate in memory and compare with the stored spec")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    document = build(verbose=not args.quiet)
    if args.check:
        if not args.out.is_file():
            raise SystemExit(f"missing spec {args.out}")
        stored = json.loads(args.out.read_text(encoding="utf-8"))
        if stored != document:
            raise SystemExit(f"spec drift: {args.out} differs from the generated document")
        print(json.dumps({"status": "PASS", "spec": rel(args.out),
                          "sha256": sha256_file(args.out),
                          "counts": document["counts"]}, indent=1, sort_keys=True))
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(
        (json.dumps(document, indent=1, sort_keys=True, ensure_ascii=False) + "\n")
        .encode("utf-8"))
    print(json.dumps({"status": "PASS", "spec": rel(args.out),
                      "sha256": sha256_file(args.out),
                      "counts": document["counts"]}, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
