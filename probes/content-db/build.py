#!/usr/bin/env python
"""Build the versioned Blur Web content index.

The builder reads committed (and disposable ``_work``) artifacts read-only and
emits one document that the shell, the loader, the packager and the room server
can agree on.  Nothing in this file writes outside ``_work/content-db/`` and
``_work/logs/content-db/``.

Typed missing policy
--------------------
A value that does not exist yet is never guessed.  It is emitted as::

    {"status": "missing", "reason": "<machine-readable>", "expected": "..."}

Every other reference is emitted as::

    {"status": "available", "path": "...", "bytes": 1, "sha256": "sha256:..."}

A file whose recorded hash does not match its bytes is emitted with
``status: "mismatch"`` and the build exits non-zero.

Canonical hashing
-----------------
``blur.content-db.canonical/1``: recursively sort object keys, encode strings
as ASCII JSON (non-ASCII as ``\\uXXXX``), and encode every number as
``#<16 hex chars>`` containing its IEEE-754 binary64 big-endian representation.
That representation is exactly reproducible in Python and Node, so the loader
can re-derive every per-entry and top-level hash.

Usage
-----
    python probes/content-db/build.py
    python probes/content-db/build.py --out _work/content-db --quiet
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
OUT_DEFAULT = ROOT / "_work" / "content-db"
LOG_DEFAULT = ROOT / "_work" / "logs" / "content-db"

SCHEMA = "blur.content-index/1"
CONTENT_VERSION = 1
GENERATOR = "probes/content-db/build.py"
GENERATOR_VERSION = "1.0.0"

SHA_PREFIX = "sha256:"
LAYOUT_RE = re.compile(r"^(RWD|FWD|AWD),\s*([0-9]+)\s*kg,\s*([0-9]+)-speed$")

CAREER_MODE_IDS = {
    "street-race": "sp.race",
    "boss-battle": "sp.boss",
    "checkpoint": "sp.checkpoint",
    "destruction": "sp.destruction",
}


class ContentBuildError(RuntimeError):
    """Typed build failure.  The message is stable and greppable."""

    def __init__(self, code: str, detail: str):
        super().__init__("%s: %s" % (code, detail))
        self.code = code
        self.detail = detail


# --------------------------------------------------------------------------
# hashing / canonical form
# --------------------------------------------------------------------------


def sha256_bytes(data: bytes) -> str:
    return SHA_PREFIX + hashlib.sha256(data).hexdigest()


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return SHA_PREFIX + digest.hexdigest()


def _canonical(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ContentBuildError("CANON_NUMBER", "non-finite number in payload")
        return "#" + struct.pack(">d", float(value)).hex()
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        pieces = []
        for key in sorted(value.keys()):
            if not isinstance(key, str):
                raise ContentBuildError("CANON_KEY", "non-string object key")
            pieces.append(json.dumps(key, ensure_ascii=True) + ":" + _canonical(value[key]))
        return "{" + ",".join(pieces) + "}"
    raise ContentBuildError("CANON_TYPE", "unsupported type %r" % type(value).__name__)


def canonical_bytes(value: Any) -> bytes:
    return _canonical(value).encode("utf-8")


def digest(value: Any) -> str:
    return SHA_PREFIX + hashlib.sha256(canonical_bytes(value)).hexdigest()


def entry_hash(entry: dict) -> str:
    payload = {key: value for key, value in entry.items() if key != "hash"}
    return digest(payload)


def section_hash(entries: list, missing: list, meta: Any = None) -> str:
    return digest({"entries": entries, "missing": missing, "meta": meta})


# --------------------------------------------------------------------------
# typed references
# --------------------------------------------------------------------------


def typed_missing(reason: str, expected: Any = None, artifact: Any = None, note: Any = None) -> dict:
    value = {"status": "missing", "reason": reason}
    if expected is not None:
        value["expected"] = expected
    if artifact is not None:
        value["artifact"] = artifact
    if note is not None:
        value["note"] = note
    return value


def _norm_sha(value: Any) -> Any:
    if value is None:
        return None
    text = str(value)
    return text if text.startswith(SHA_PREFIX) else SHA_PREFIX + text


def file_ref(path: str, expected_sha: Any = None, role: str | None = None) -> dict:
    target = ROOT / path
    if not target.exists():
        return typed_missing("file-absent", expected=path, artifact=path)
    actual = sha256_file(target)
    value = {
        "status": "available",
        "path": path,
        "bytes": target.stat().st_size,
        "sha256": actual,
    }
    if role:
        value["role"] = role
    if expected_sha is not None:
        expected = _norm_sha(expected_sha)
        value["expectedSha256"] = expected
        if expected != actual:
            value["status"] = "mismatch"
            value["reason"] = "recorded hash does not match bytes"
    return value


def url_to_path(url: str | None) -> str | None:
    if not url or not isinstance(url, str):
        return None
    if url.startswith("http://") or url.startswith("https://"):
        return None
    if url.startswith("/_work/"):
        return url[1:]
    if url.startswith("/map-data/"):
        return "game-data/Blur/levels/" + url[len("/map-data/"):]
    if url.startswith("/"):
        return None
    return url


def find_bare_key(strings: dict, key: str) -> str | None:
    """Resolve a bare loc key (``VEH_MOD_ZR1``) in ``<file>:<KEY>`` maps."""

    matches = sorted(name for name in strings if name.rsplit(":", 1)[-1] == key)
    return matches[0] if matches else None


def loc_ref(slot: dict | None, strings: dict, key: str | None, source: str) -> dict:
    if slot and slot.get("status") == "resolved":
        return {
            "status": "available",
            "key": slot["key"],
            "locId": slot.get("locId"),
            "value": slot.get("values", {}).get("en"),
            "slot": slot.get("slot"),
            "source": source,
        }
    if slot and slot.get("status") == "missing":
        return typed_missing(
            "loc-slot-missing",
            expected=slot.get("slot"),
            artifact=source,
            note=slot.get("key"),
        )
    if key:
        full = find_bare_key(strings, key)
        if full:
            return {
                "status": "available",
                "key": key,
                "locId": None,
                "value": strings[full],
                "slot": None,
                "source": source + "#" + full,
            }
    return typed_missing("loc-key-unresolved", expected=key, artifact=source)


# --------------------------------------------------------------------------
# io
# --------------------------------------------------------------------------


def read_json(path: str, required: bool = True) -> tuple[Any, dict]:
    target = ROOT / path
    if not target.exists():
        ref = {"path": path, "exists": False, "status": "missing"}
        if required:
            raise ContentBuildError("SOURCE_MISSING", path)
        return None, ref
    data = json.loads(target.read_text(encoding="utf-8"))
    ref = {
        "path": path,
        "exists": True,
        "status": "present",
        "bytes": target.stat().st_size,
        "sha256": sha256_file(target),
    }
    return data, ref


def source_file(path: str, role: str) -> dict:
    target = ROOT / path
    ref = {"path": path, "role": role}
    if not target.exists():
        ref.update({"exists": False, "status": "missing"})
        return ref
    ref.update(
        {
            "exists": True,
            "status": "present",
            "bytes": target.stat().st_size,
            "sha256": sha256_file(target),
        }
    )
    return ref


def load_map_registry() -> tuple[dict, dict]:
    path = "probes/e1-drive/web/map-registry.js"
    target = ROOT / path
    if not target.exists():
        raise ContentBuildError("SOURCE_MISSING", path)
    script = (
        "const m=await import(process.argv[1]);"
        "console.log(JSON.stringify({"
        "defaultMap:m.MAP_DEFAULT,"
        "ids:m.MAP_IDS,"
        "mpIds:m.MP_MAP_IDS,"
        "maps:Object.fromEntries(Object.entries(m.MAPS).map(([k,v])=>[k,{"
        "id:v.id,label:v.label,level:v.level,kind:v.kind,"
        "geometryUrl:v.geometryUrl,levelGeometryUrl:v.levelGeometryUrl ?? null,"
        "baseGeometryUrl:v.baseGeometryUrl ?? null,carIndexUrl:v.carIndexUrl ?? null,"
        "physicsUrl:v.physicsUrl,spawnUrl:v.spawnUrl,layoutUrl:v.layoutUrl,"
        "bestKey:v.bestKey,courses:v.courses,multiplayer:v.multiplayer,"
        "propLayer:v.propLayer,ghost:v.ghost,pins:v.pins,mpPins:v.mpPins ?? null"
        "}]))}))"
    )
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script, target.as_uri()],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if proc.returncode != 0:
        raise ContentBuildError(
            "MAP_REGISTRY_NODE",
            (proc.stderr or proc.stdout or "node failed").strip().splitlines()[-1],
        )
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ContentBuildError("MAP_REGISTRY_JSON", str(exc)) from exc
    return data, source_file(path, "map-registry")


# --------------------------------------------------------------------------
# section builders
# --------------------------------------------------------------------------


def parse_layout(text: str | None) -> dict:
    if not text:
        return {
            "drivetrain": typed_missing("layout-absent"),
            "massKg": typed_missing("layout-absent"),
            "gears": typed_missing("layout-absent"),
        }
    match = LAYOUT_RE.match(text.strip())
    if not match:
        return {
            "drivetrain": typed_missing("layout-unparsed", expected=text),
            "massKg": typed_missing("layout-unparsed", expected=text),
            "gears": typed_missing("layout-unparsed", expected=text),
        }
    return {
        "drivetrain": match.group(1),
        "massKg": int(match.group(2)),
        "gears": int(match.group(3)),
    }


def _norm_tag(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(text).lower())


def build_vehicle_slot_index(slots: dict) -> tuple[dict, dict]:
    by_tag: dict[str, list[dict]] = {}
    by_norm: dict[str, list[dict]] = {}
    for row in slots.get("slots", []):
        if row.get("category") != "vehicle" or not row.get("amaxTag"):
            continue
        by_tag.setdefault(row["amaxTag"], []).append(row)
        by_norm.setdefault(_norm_tag(row["amaxTag"]), []).append(row)
    return by_tag, by_norm


def resolve_vehicle_slot(car: dict, index_row: dict | None, by_tag: dict, by_norm: dict) -> tuple[dict | None, str]:
    model_path = (index_row or {}).get("sourceModelPakPath") or car.get("model") or ""
    stem = Path(str(model_path).replace("\\", "/")).stem
    candidates = []
    for value in (
        car.get("name"),
        (car.get("modelMapping") or {}).get("amaxTag"),
        stem,
        stem.replace("_", " "),
    ):
        if value:
            candidates.append(str(value))
    found: dict[str, dict] = {}
    for candidate in candidates:
        for row in by_tag.get(candidate, []):
            found[row["slot"]] = row
        for row in by_norm.get(_norm_tag(candidate), []):
            found[row["slot"]] = row
    if len(found) == 1:
        row = next(iter(found.values()))
        return row, "matched-amax-tag-or-model-stem"
    if len(found) > 1:
        return None, "ambiguous-loc-slot"
    return None, "not-found"


def build_cars(ctx: dict) -> tuple[list, list, dict]:
    roster = ctx["roster"]
    index = ctx["car_bodies"]
    ghosts = ctx["ghosts"]
    classes = ctx["car_classes"].get("classes", {})
    hud_by_slug = {row["slug"]: row for row in ctx["hud_catalog"].get("records", [])}
    sprites = set(ctx["hud_catalog"].get("iconCatalog", {}).get("carSprites", []))
    slots = ctx["slot_by_name"]
    by_tag, by_norm = build_vehicle_slot_index(ctx["slots"])
    en_strings = ctx["en_strings"]
    batch3 = ctx["batch3"]

    cars: list[dict] = []

    for order, car in enumerate(roster.get("cars", [])):
        slug = car["slug"]
        index_row = index.get("cars", {}).get(slug)
        parsed = parse_layout(car.get("layout"))
        class_name = classes.get(slug)
        slot, slot_reason = resolve_vehicle_slot(car, index_row, by_tag, by_norm)
        display_ref = (
            loc_ref(slot, en_strings, slot.get("key"), "_work/loc/slots.json")
            if slot
            else typed_missing(
                slot_reason,
                expected=car.get("name"),
                artifact="_work/loc/slots.json",
            )
        )
        full_ref = typed_missing("no-full-name-key", expected=slug + " full name")

        if index_row:
            chunk = file_ref(
                "_work/e1-drive/" + index_row["file"],
                expected_sha=index_row.get("sha256"),
                role="e1-car-geometry-chunk",
            )
        else:
            chunk = typed_missing(
                "no-e1-geometry-chunk",
                expected="_work/e1-drive/cars/%s.geometry.json" % slug,
                artifact="probes/e1-drive/tools/build_geometry.mjs",
            )

        ghost_entries = ghosts.get("cars", {}).get(slug, {})
        ghost_refs = {}
        for course in ("310m", "short"):
            row = ghost_entries.get(course)
            if row:
                ghost_refs[course] = file_ref(
                    row["file"], expected_sha=row.get("sha256"), role="committed-ghost"
                )
                ghost_refs[course]["ghostHash"] = row.get("ghostHash")
                ghost_refs[course]["timeSeconds"] = row.get("timeSeconds")
                ghost_refs[course]["layoutHash"] = row.get("layoutHash")
            else:
                ghost_refs[course] = typed_missing(
                    "no-committed-ghost",
                    expected="probes/e1-drive/ghosts/%s-%s.json" % (slug, course),
                    artifact="probes/e1-drive/ghosts/index.json",
                )

        model_path = index_row.get("sourceModelPakPath") if index_row else car.get("model")
        sprite = Path(str(model_path).replace("\\", "/")).stem.lower() if model_path else None
        if sprite and sprite in sprites:
            icon_ref = {
                "status": "available",
                "kind": "car-icon-sprite",
                "sprite": sprite,
                "atlas": "\\ui\\data\\ipf\\car_icons.ipf",
                "resolution": "lowercase-model-tag",
                "basis": "the exact lowercase model filename equals a catalog sprite key",
                "source": "_work/vehicle-pipeline/batch3/hud/hud-catalog.json",
            }
        else:
            icon_ref = typed_missing(
                "hud-icon-sprite-absent",
                expected=sprite,
                artifact="_work/vehicle-pipeline/batch3/hud/hud-catalog.json",
            )

        blockers = []
        telemetry = car.get("telemetry")
        if isinstance(telemetry, dict) and telemetry.get("lateralMissedReversals"):
            blockers.append(
                {
                    "kind": "telemetry-lateral-missed-reversal",
                    "count": telemetry.get("lateralMissedReversals"),
                    "note": telemetry.get("reason"),
                }
            )
        if car.get("shortCourseController"):
            blockers.append(
                {
                    "kind": "short-course-controller-override",
                    "note": car["shortCourseController"].get("reason"),
                    "scope": car["shortCourseController"].get("scope"),
                }
            )
        if (car.get("modelMapping") or {}).get("doNotShowInGame"):
            blockers.append(
                {
                    "kind": "do-not-show-in-game",
                    "note": "record flag is recorded, not used as a proof",
                }
            )
        blockers.append(
            {
                "kind": "livery-catalog-absent",
                "note": "no committed VEH_PaintJob catalog exists; probe/liveries contains read-only tooling only",
            }
        )

        entry = {
            "id": slug,
            "kind": "integrated",
            "sourceOrder": order,
            "recordId": car.get("recordId"),
            "recordIndex": car.get("recordIndex"),
            "recordName": car.get("name"),
            "modelPath": model_path,
            "class": class_name if class_name else typed_missing("car-class-absent"),
            "classSource": "probes/game-shell/data/car-classes.json",
            "drivetrain": parsed["drivetrain"],
            "massKg": parsed["massKg"],
            "gears": parsed["gears"],
            "layout": car.get("layout"),
            "displayNameKey": display_ref,
            "displayName": display_ref.get("value") if display_ref.get("status") == "available" else None,
            "fullNameKey": full_ref,
            "manufacturer": typed_missing(
                "manufacturer-mapping-absent",
                expected="an AmaxManufacturer tag for this vehicle",
                artifact="_work/loc/slots.json",
            ),
            "hud": {
                "nameKey": display_ref,
                "iconRef": icon_ref,
                "manufacturer": typed_missing(
                    "manufacturer-mapping-absent",
                    expected="an AmaxManufacturer tag for this vehicle",
                    artifact="_work/loc/slots.json",
                ),
            },
            "chunks": {
                "geometry": chunk,
                "carIndex": "_work/e1-drive/car-bodies.index.json",
            },
            "ghosts": ghost_refs,
            "liveryRefs": [
                typed_missing(
                    "no-committed-livery-catalog",
                    expected="VEH_PaintJob records in \\gamedata\\xt\\vehicles.bin",
                    artifact="probes/liveries/tools/xtlib.py",
                    note="read-only tooling exists; no catalog artifact was produced",
                )
            ],
            "blockers": blockers,
            "availability": "integrated",
        }
        entry["hash"] = entry_hash(entry)
        cars.append(entry)

    for order, record in enumerate(batch3.get("records", [])):
        slug = record["slug"]
        hud_row = hud_by_slug.get(slug, {})
        display_key = hud_row.get("nameKey")
        full_key = hud_row.get("fullNameKey")
        display_ref = loc_ref(None, en_strings, display_key, "_work/vehicle-pipeline/batch3/hud/hud-catalog.json")
        full_ref = loc_ref(None, en_strings, full_key, "_work/vehicle-pipeline/batch3/hud/hud-catalog.json")

        icon_sprite = hud_row.get("iconSprite")
        sprites_now = set(ctx["hud_catalog"].get("iconCatalog", {}).get("carSprites", []))
        if icon_sprite and icon_sprite in sprites_now:
            icon_ref = {
                "status": "available",
                "kind": "car-icon-sprite",
                "sprite": icon_sprite,
                "atlas": "\\ui\\data\\ipf\\car_icons.ipf",
                "resolution": "hud-catalog-record",
                "basis": "hud_catalog.py resolved AmaxVehicle.UiIconName to a named sprite",
                "pages": hud_row.get("iconPages", []),
                "source": "_work/vehicle-pipeline/batch3/hud/hud-catalog.json",
            }
        else:
            icon_ref = typed_missing(
                "hud-icon-sprite-absent",
                expected=icon_sprite,
                artifact="_work/vehicle-pipeline/batch3/hud/hud-catalog.json",
            )

        blockers = []
        for raw in record.get("blockers", []):
            item = {"kind": raw.get("kind"), "note": raw.get("note")}
            if raw.get("count") is not None:
                item["count"] = raw.get("count")
            if raw.get("scope") is not None:
                item["scope"] = raw.get("scope")
            if raw.get("iconSprite") is not None:
                item["iconSprite"] = raw.get("iconSprite")
            blockers.append(item)
        blockers.append(
            {
                "kind": "livery-catalog-absent",
                "note": "no committed VEH_PaintJob catalog exists",
            }
        )

        staged = {}
        for key, rel_path in (
            ("manifest", record.get("artifacts", {}).get("manifest")),
            ("mesh", record.get("artifacts", {}).get("mesh")),
            ("sceneReport", record.get("artifacts", {}).get("sceneReport")),
        ):
            if rel_path:
                expected = {
                    "manifest": record.get("artifacts", {}).get("manifestSha256"),
                    "mesh": record.get("artifacts", {}).get("meshSha256"),
                    "sceneReport": record.get("artifacts", {}).get("sceneReportSha256"),
                }[key]
                staged[key] = file_ref(rel_path, expected_sha=expected, role="staged-" + key)
            else:
                staged[key] = typed_missing("staged-artifact-absent", expected=key)

        entry = {
            "id": slug,
            "kind": "staged",
            "sourceOrder": len(cars) + order,
            "recordId": record.get("recordId"),
            "recordIndex": record.get("recordIndex"),
            "recordName": record.get("recordName"),
            "modelPath": record.get("model"),
            "class": record.get("class"),
            "classSource": "_work/vehicle-pipeline/batch3/summary.json",
            "drivetrain": record.get("drivetrain"),
            "massKg": record.get("mass"),
            "gears": record.get("gearCount"),
            "layout": "%s, %s kg, %s-speed"
            % (record.get("drivetrain"), record.get("mass"), record.get("gearCount")),
            "displayNameKey": display_ref,
            "displayName": display_ref.get("value") if display_ref.get("status") == "available" else None,
            "fullNameKey": full_ref,
            "manufacturer": hud_row.get("manufacturerTag"),
            "hud": {
                "nameKey": display_ref,
                "iconRef": icon_ref,
                "manufacturerTexture": hud_row.get("manufacturerTexture"),
            },
            "chunks": {
                "geometry": typed_missing(
                    "no-e1-geometry-chunk",
                    expected="_work/e1-drive/cars/%s.geometry.json" % slug,
                    artifact="probes/e1-drive/tools/build_geometry.mjs",
                ),
                "stagedArtifacts": staged,
            },
            "ghosts": {
                "310m": typed_missing(
                    "no-committed-ghost",
                    expected="probes/e1-drive/ghosts/%s-310m.json" % slug,
                    artifact="probes/e1-drive/ghosts/index.json",
                ),
                "short": typed_missing(
                    "no-committed-ghost",
                    expected="probes/e1-drive/ghosts/%s-short.json" % slug,
                    artifact="probes/e1-drive/ghosts/index.json",
                ),
            },
            "liveryRefs": [
                typed_missing(
                    "no-committed-livery-catalog",
                    expected="VEH_PaintJob records in \\gamedata\\xt\\vehicles.bin",
                    artifact="probes/liveries/tools/xtlib.py",
                )
            ],
            "blockers": blockers,
            "availability": "staged",
            "status": record.get("status"),
        }
        entry["hash"] = entry_hash(entry)
        cars.append(entry)

    missing = []
    return cars, missing, {
        "integrated": sum(1 for car in cars if car["availability"] == "integrated"),
        "staged": sum(1 for car in cars if car["availability"] == "staged"),
    }


def build_maps(ctx: dict) -> tuple[list, list, dict]:
    maps_doc = ctx["maps_doc"]
    registry = ctx["registry"]
    registry_by_level = {row["level"]: row for row in registry["maps"].values()}
    slots = ctx["slot_by_name"]
    en_strings = ctx["en_strings"]
    placements = ctx["placements"]
    locations = ctx["locations"]
    base = ctx["base_geometry_index"]

    levels = sorted(maps_doc.get("levels", []), key=lambda row: row["name"])
    maps: list[dict] = []

    river_layouts = {
        "310m": ("_work/e1-drive/sprint.json", "310m"),
        "short": ("_work/e1-drive/sprint-short.json", "short"),
        "lap": ("_work/e1-drive/sprint-lap.json", "lap"),
        "free": ("_work/e1-drive/sprint-free.json", "free"),
    }

    for row in levels:
        name = row["name"]
        registry_row = registry_by_level.get(name)
        slot = slots.get("level.%s.name" % name)
        label_ref = loc_ref(slot, en_strings, slot.get("key") if slot else None, "_work/loc/slots.json")

        layouts: dict[str, dict] = {}
        if registry_row:
            if name == "usa_la_river":
                for course, (path, course_id) in river_layouts.items():
                    layouts[course] = file_ref(path, role="e1-layout")
                    layouts[course]["courseId"] = course_id
            elif registry_row.get("layoutUrl"):
                path = url_to_path(registry_row["layoutUrl"])
                if path:
                    expected = (registry_row.get("mpPins") or {}).get("layoutFileSha256")
                    layouts[registry_row["id"]] = file_ref(path, expected_sha=expected, role="map-layout")
                    layouts[registry_row["id"]]["courseId"] = registry_row["id"]

        primary_layout = None
        if name == "usa_la_river":
            primary_layout = layouts.get("310m")
        elif registry_row:
            primary_layout = layouts.get(registry_row["id"])

        course_length = None
        if primary_layout and primary_layout.get("status") == "available":
            layout_doc, _ = read_json(primary_layout["path"], required=False)
            if layout_doc:
                course_length = layout_doc.get("course", {}).get("lengthMetres")

        draw_length = row.get("drawCoverage", {}).get("drawCoveredPathM")
        collision_length = row.get("drivable", {}).get("path", {}).get("lengthM")
        length = course_length if course_length is not None else draw_length

        package = typed_missing(
            "no-e1-map-package",
            expected="a registry map package",
            artifact="probes/e1-drive/web/map-registry.js",
        )
        if registry_row:
            url = registry_row.get("levelGeometryUrl") or registry_row.get("geometryUrl")
            path = url_to_path(url)
            if path:
                expected = (registry_row.get("mpPins") or {}).get("packageFileSha256") or (
                    registry_row.get("pins") or {}
                ).get("mapFileSha256")
                package = file_ref(path, expected_sha=expected, role="e1-map-package")

        collider = typed_missing(
            "no-collider-path",
            expected="Level.levelphysics",
            artifact="probes/e1-drive/web/map-registry.js",
        )
        if registry_row:
            path = url_to_path(registry_row.get("physicsUrl"))
            if path:
                expected = (registry_row.get("mpPins") or {}).get("physicsFileSha256") or (
                    row.get("files", {}).get("physics", {}) or {}
                ).get("sha256")
                collider = file_ref(path, expected_sha=expected, role="level-collision")

        if name == "usa_la_river" and placements:
            pickup_path = file_ref("_work/powerups/placements.json", role="pickup-placement")
            pickup_path["count"] = len([p for p in placements.get("placements", []) if p])
        else:
            pickup_path = typed_missing(
                "no-pickup-placement-artifact",
                expected="_work/powerups/placements.json for this level",
                artifact="probes/powerups",
            )

        lap_layout = typed_missing(
            "no-lap-layout",
            expected="_work/e1-drive/sprint-lap.json for this level",
            artifact="probes/e1-drive/tools/build_sprint.mjs",
        )
        if name == "usa_la_river":
            lap_layout = file_ref("_work/e1-drive/sprint-lap.json", role="lap-layout")
            lap_layout["loopId"] = "loop-01"
            lap_layout["loopLengthMetres"] = 222.0402

        # Mode support is derived from the committed registry plus artifacts.
        mode_support: dict[str, dict] = {}
        if registry_row and registry_row.get("courses"):
            if name == "usa_la_river":
                mode_support["sprint.310m"] = {
                    "status": "available",
                    "courseId": "310m",
                    "reason": "committed 310.395 m sprint layout",
                    "source": "_work/e1-drive/sprint.json",
                }
                mode_support["sprint.short"] = {
                    "status": "available",
                    "courseId": "short",
                    "reason": "committed 29 m short layout",
                    "source": "_work/e1-drive/sprint-short.json",
                }
                mode_support["lap"] = {
                    "status": "available",
                    "courseId": "lap",
                    "reason": "committed loop-01 three-lap layout",
                    "source": "_work/e1-drive/sprint-lap.json",
                }
                mode_support["free-roam"] = {
                    "status": "available",
                    "courseId": "free",
                    "reason": "committed free-roam basin layout",
                    "source": "_work/e1-drive/sprint-free.json",
                }
            else:
                layout_id = registry_row["id"]
                mode_support["sprint.custom"] = {
                    "status": "available",
                    "courseId": layout_id,
                    "reason": "committed point-to-point measured layout",
                    "source": layouts.get(layout_id, {}).get("path"),
                }
            if registry_row.get("multiplayer"):
                if name == "usa_la_river":
                    mode_support["mp.racing"] = {
                        "status": "available",
                        "reason": "registry multiplayer map, pinned MP record and pickup placements",
                        "source": "probes/e1-drive/web/map-registry.js",
                    }
                else:
                    mode_support["mp.racing"] = {
                        "status": "partial",
                        "reason": "registry multiplayer map, but no pickup placement artifact for this level",
                        "source": "probes/e1-drive/web/map-registry.js",
                    }

        # Career data proves an event exists for a map; it is not a playable mode.
        for event in ctx["career_events"]:
            if event.get("mapId") == name:
                mode_id = event.get("modeId")
                if mode_id and mode_id not in mode_support:
                    mode_support[mode_id] = {
                        "status": "partial",
                        "reason": "career event data exists; race rules and UI are not implemented",
                        "source": "_work/career/career.json",
                    }

        classification = row.get("classification")
        completeness = row.get("drawCoverage", {}).get("completenessOfCollisionPath")
        features = {}
        features["collision"] = {
            "status": "available" if row.get("drivable", {}).get("measured") else "unsupported",
            "reason": "Level.levelphysics parsed and a passable component was measured"
            if row.get("drivable", {}).get("measured")
            else "no measured passable component",
            "source": "_work/map-pipeline/maps.json",
        }
        if classification == "A":
            features["drawCoverage"] = {
                "status": "available",
                "reason": "P51 committed proof covers the 310.395 m course at centre and margins",
                "drawCoveredPathMetres": draw_length,
                "completeness": completeness,
                "source": "_work/map-pipeline/maps.json",
            }
        elif classification == "B":
            features["drawCoverage"] = {
                "status": "partial",
                "reason": "draw-covered path measured; first-RenderList direct LOD0 only, instances not applied",
                "drawCoveredPathMetres": draw_length,
                "completeness": completeness,
                "source": "_work/map-pipeline/maps.json",
            }
        else:
            features["drawCoverage"] = {
                "status": "unsupported",
                "reason": row.get("blocker") or "draw-covered path below 25 m",
                "drawCoveredPathMetres": draw_length,
                "completeness": completeness,
                "source": "_work/map-pipeline/maps.json",
            }

        spawn = row.get("drivable", {}).get("committedSpawn")
        candidate = row.get("drivable", {}).get("candidateSpawn")
        if spawn:
            features["spawn"] = {
                "status": "available",
                "reason": "committed spawn record",
                "source": "_work/e1-drive/spawn.json",
            }
        elif candidate:
            features["spawn"] = {
                "status": "partial",
                "reason": "derived component endpoint; the level files contain no original start line",
                "source": "_work/map-pipeline/maps.json",
            }
        else:
            features["spawn"] = {
                "status": "unsupported",
                "reason": "no spawn and no candidate component endpoint",
                "source": "_work/map-pipeline/maps.json",
            }

        features["layout"] = (
            {
                "status": "available",
                "reason": "committed e1 layout",
                "source": primary_layout.get("path"),
            }
            if primary_layout and primary_layout.get("status") == "available"
            else {
                "status": "missing",
                "reason": "no committed spawn/course/checkpoint/finish layout for e1-drive",
                "source": "_work/map-pipeline/maps.json",
            }
        )

        if name == "usa_la_river":
            features["materials"] = {
                "status": "available",
                "reason": "committed track textures and the g56/P73a-P75 albedo subset",
                "source": "_work/e1-drive/track-textures.json",
            }
        elif name in ("usa_amboy", "spa_barcelona_gracia"):
            features["materials"] = {
                "status": "available",
                "reason": "map package carries bound levels textures",
                "source": "probes/e1-drive/web/map-registry.js",
            }
        else:
            features["materials"] = {
                "status": "unsupported",
                "reason": "native level draws are diagnostic; no albedo/sampler binding",
                "source": "_work/map-pipeline/maps.json",
            }

        features["instances"] = {
            "status": "unsupported",
            "reason": "instancesApplied:false; instance-only geometry can add or change surfaces",
            "source": "_work/map-pipeline/maps.json",
        }
        features["pickups"] = (
            {
                "status": "available",
                "reason": "54 retail PickupPosition actors recovered for the raced River route",
                "count": 54,
                "source": "_work/powerups/placements.json",
            }
            if name == "usa_la_river"
            else {
                "status": "missing",
                "reason": "no pickup placement artifact for this level",
                "source": "_work/powerups/placements.json",
            }
        )
        features["ghosts"] = (
            {
                "status": "available",
                "reason": "committed 310 m and short ghosts for every integrated car",
                "count": 50,
                "source": "probes/e1-drive/ghosts/index.json",
            }
            if name == "usa_la_river"
            else {
                "status": "missing",
                "reason": "no committed ghosts for this level",
                "source": "probes/e1-drive/ghosts/index.json",
            }
        )
        features["propLayer"] = (
            {
                "status": "available",
                "reason": "committed prop layer for the River basin",
                "source": "_work/e1-drive/level.geometry.json",
            }
            if name == "usa_la_river"
            else {
                "status": "missing",
                "reason": "no committed prop layer for this level",
                "source": "probes/e1-drive/web/map-registry.js",
            }
        )
        features["multiplayer"] = (
            {
                "status": "available" if name == "usa_la_river" else "partial",
                "reason": "registry multiplayer map with pinned MP record"
                if name == "usa_la_river"
                else "registry multiplayer map; pickup content is absent for this level",
                "source": "probes/e1-drive/web/map-registry.js",
            }
            if registry_row and registry_row.get("multiplayer")
            else {
                "status": "unsupported",
                "reason": "not a registry multiplayer map",
                "source": "probes/e1-drive/web/map-registry.js",
            }
        )

        blockers = []
        if row.get("blocker"):
            blockers.append({"kind": "map-blocker", "note": row.get("blocker")})
        for note in row.get("missingData", []) or []:
            blockers.append({"kind": "map-missing-data", "note": note})

        availability = {
            "A": "integrated-playable",
            "B": "candidate",
            "C": "blocked",
        }.get(classification, "unknown")

        entry = {
            "id": name,
            "registryId": registry_row.get("id") if registry_row else None,
            "kind": row.get("kind"),
            "labelKey": label_ref,
            "label": label_ref.get("value") if label_ref.get("status") == "available" else None,
            "classification": classification,
            "classificationReason": row.get("classificationReason"),
            "rank": row.get("rank"),
            "availability": availability,
            "lengthMetres": length,
            "courseLengthMetres": course_length,
            "drawCoveredPathMetres": draw_length,
            "collisionPathMetres": collision_length,
            "sourceFiles": row.get("files", {}),
            "package": package,
            "collider": collider,
            "chunk": {
                "geometry": package,
                "carIndex": "_work/e1-drive/car-bodies.index.json",
            },
            "layouts": layouts,
            "lapLayout": lap_layout,
            "pickupPath": pickup_path,
            "modes": sorted(mode_support.keys()),
            "blockers": blockers,
        }
        entry["hash"] = entry_hash(entry)
        maps.append(entry)

    return maps, [], {
        "A": sum(1 for row in maps if row["classification"] == "A"),
        "B": sum(1 for row in maps if row["classification"] == "B"),
        "C": sum(1 for row in maps if row["classification"] == "C"),
    }


def build_modes(ctx: dict, maps: list[dict]) -> tuple[list, list, dict]:
    slots = ctx["slot_by_name"]
    en_strings = ctx["en_strings"]

    specs = [
        ("sprint.310m", "Sprint 310 m", "sprint", None, "race-content"),
        ("sprint.short", "Sprint 29 m", "sprint", None, "race-content"),
        ("sprint.custom", "Sprint (measured point-to-point)", "sprint", None, "race-content"),
        ("lap", "Lap race", "lap", None, "race-content"),
        ("free-roam", "Free roam", "free-roam", None, "race-content"),
        ("mp.racing", "Racing", "multiplayer", "mode.mp.racing", "race-content"),
        ("mp.destruction", "Motor Mash", "multiplayer", "mode.mp.destruction", "race-content"),
        ("mp.elimination", "Countdown Chaos", "multiplayer", "mode.mp.elimination", "race-content"),
        ("mp.hardcore", "Hardcore", "multiplayer", "mode.mp.hardcore", "race-content"),
        ("mp.points", "Fans", "multiplayer", "mode.mp.points", "race-content"),
        ("sp.race", "Race", "career", "mode.sp.race", "career-data-only"),
        ("sp.destruction", "Destruction", "career", "mode.sp.destruction", "career-data-only"),
        ("sp.checkpoint", "Checkpoint", "career", "mode.sp.checkpoint", "career-data-only"),
        ("sp.boss", "One-on-One", "career", "mode.sp.boss", "career-data-only"),
        ("sp.fan", "Fan", "career", "mode.sp.fan", "career-data-only"),
        ("sp.fan_run", "Fan Run", "career", "mode.sp.fan_run", "career-data-only"),
    ]

    by_id = {row["id"]: row for row in maps}
    supported_by_mode: dict[str, list[str]] = {}
    status_by_mode: dict[str, list[str]] = {}
    for map_row in maps:
        for mode_id, support in ctx["map_mode_support"].get(map_row["id"], {}).items():
            supported_by_mode.setdefault(mode_id, []).append(map_row["id"])
            status_by_mode.setdefault(mode_id, []).append(support["status"])

    modes: list[dict] = []
    for mode_id, label, family, slot_name, basis in specs:
        slot = slots.get(slot_name) if slot_name else None
        key_ref = loc_ref(slot, en_strings, slot.get("key") if slot else None, "_work/loc/slots.json")
        if not slot_name:
            key_ref = typed_missing(
                "no-mode-loc-slot",
                expected="a mode.<family> loc slot",
                artifact="_work/loc/slots.json",
            )
        map_ids = sorted(supported_by_mode.get(mode_id, []))
        statuses = status_by_mode.get(mode_id, [])
        if "available" in statuses:
            availability = "available"
        elif "partial" in statuses:
            availability = "partial"
        else:
            availability = "unsupported"
        if basis == "career-data-only" and availability == "unsupported":
            availability = "partial"

        entry = {
            "id": mode_id,
            "label": label,
            "labelKey": key_ref,
            "family": family,
            "basis": basis,
            "maps": map_ids,
            "availability": availability,
            "rulesRef": (
                {
                    "status": "available",
                    "path": "probes/e1-drive/web/sprint-rules.js",
                    "role": "sprint rules",
                }
                if family in ("sprint", "lap", "free-roam")
                else {
                    "status": "missing",
                    "reason": "no committed rules module for this mode",
                    "artifact": "docs/work/analysis/race-rules.md",
                }
            ),
        }
        entry["hash"] = entry_hash(entry)
        modes.append(entry)

    return modes, [], {
        "available": sum(1 for row in modes if row["availability"] == "available"),
        "partial": sum(1 for row in modes if row["availability"] == "partial"),
        "unsupported": sum(1 for row in modes if row["availability"] == "unsupported"),
    }


def build_powerups(ctx: dict) -> tuple[list, list, dict]:
    powerups = ctx["powerups"]
    slots = ctx["slot_by_name"]
    en_strings = ctx["en_strings"]
    placements = ctx["placements"].get("placements", []) if ctx["placements"] else []
    maps_with = sorted({"_usa_la_river"} - {"_usa_la_river"})
    river_types = set()
    for placement in placements:
        serialized = placement.get("serializedType") or {}
        if serialized.get("name"):
            river_types.add(serialized["name"])

    entries: list[dict] = []
    for entity in powerups.get("entities", []):
        label = entity.get("pickupLabel")
        name_slot = slots.get("powerup.%s.name" % label)
        hud_slot = slots.get("powerup.%s.hud_name" % label)
        name_ref = loc_ref(name_slot, en_strings, name_slot.get("key") if name_slot else None, "_work/loc/slots.json")
        if not name_slot:
            name_ref = typed_missing(
                "loc-slot-missing",
                expected="powerup.%s.name" % label,
                artifact="_work/loc/slots.json",
            )
        hud_name_ref = loc_ref(
            hud_slot, en_strings, hud_slot.get("key") if hud_slot else None, "_work/loc/slots.json"
        )

        hud_entries = (entity.get("hud") or {}).get("entries") or {}
        icon_ref = typed_missing(
            "no-hud-icon-entry",
            expected="ui.bin UiPerkInfo entry",
            artifact="_work/powerups/powerups.json",
        )
        if hud_entries:
            first_key = sorted(hud_entries.keys())[0]
            raw = hud_entries[first_key]
            icon_ref = {
                "status": "partial",
                "kind": "perk-icon-slot",
                "key": first_key,
                "textureIndex": raw.get("texture_index"),
                "fill": (raw.get("colour_fill") or {}).get("value"),
                "glow": (raw.get("colour_glow") or {}).get("value"),
                "text": (raw.get("colour_text") or {}).get("value"),
                "note": "ui.bin string fields; no typed atlas/texture binding is serialized",
                "source": "_work/powerups/powerups.json",
            }

        audio_entities = (entity.get("audio") or {}).get("entities") or []
        blockers = []
        if (entity.get("multiplayer") or {}).get("multiplayer") is None:
            blockers.append(
                {
                    "kind": "not-in-mp-pickup-enum",
                    "note": "single-player-only pickup; no multiplayer flag is serialized",
                }
            )
        if not hud_entries:
            blockers.append({"kind": "hud-icon-entry-absent", "note": "no UiPerkInfo entry"})
        if name_ref.get("status") == "missing":
            blockers.append({"kind": "loc-key-missing", "note": "no powerup.<name>.name loc slot"})

        entry = {
            "id": "pickup.%s" % label,
            "kind": "pickup-type",
            "label": label,
            "record": entity.get("record"),
            "refId": entity.get("refId"),
            "typeField": entity.get("typeField"),
            "baseProbability": entity.get("baseProbability"),
            "nameKey": name_ref,
            "hudNameKey": hud_name_ref,
            "iconRef": icon_ref,
            "rulesRef": {
                "status": "available",
                "manifest": "_work/powerups/powerups.json",
                "pointer": "entities[%d]" % powerups.get("entities", []).index(entity),
                "refId": entity.get("refId"),
                "prototype": "probes/powerups/rules/engine.js",
                "note": "definitions are recovered; the prototype is not retail parity",
            },
            "multiplayer": entity.get("multiplayer"),
            "variants": sorted((entity.get("levels") or {}).keys()),
            "audioRefs": [
                {"name": row.get("name"), "refId": row.get("refId"), "record": row.get("record")}
                for row in audio_entities
            ],
            "maps": ["usa_la_river"] if label in river_types else [],
            "blockers": blockers,
            "availability": (
                "available"
                if entity.get("multiplayer", {}).get("multiplayer") and hud_entries
                else "partial"
            ),
        }
        entry["hash"] = entry_hash(entry)
        entries.append(entry)

    return entries, [], {
        "total": len(entries),
        "multiplayer": sum(1 for row in entries if (row.get("multiplayer") or {}).get("multiplayer")),
        "withHudIcon": sum(1 for row in entries if row["iconRef"].get("status") != "missing"),
        "placedOnRiver": sum(1 for row in entries if row["maps"]),
    }


def build_placements(ctx: dict) -> tuple[list, list, dict]:
    source = ctx["placements"]
    if not source:
        return [], [
            typed_missing(
                "placement-artifact-absent",
                expected="_work/powerups/placements.json",
                artifact="probes/powerups",
            )
        ], {"total": 0}

    powerup_ids = {row["label"]: row["id"] for row in ctx["powerup_entries"]}
    maps_with = []
    entries: list[dict] = []
    for index, placement in enumerate(source.get("placements", [])):
        serialized = placement.get("serializedType") or {}
        label = serialized.get("name")
        type_id = powerup_ids.get(label) or ("pickup.%s" % label if label else None)
        position = placement.get("position") or {}
        row = placement.get("row")
        entry = {
            "id": "pickup-placement.%03d" % index,
            "kind": "pickup-placement",
            "mapId": source.get("level"),
            "typeId": type_id if type_id else typed_missing("placement-type-unresolved", expected=label),
            "typeLabel": label,
            "typeRefId": serialized.get("refId"),
            "uid": placement.get("uid"),
            "position": {
                "x": position.get("x"),
                "y": position.get("y"),
                "z": position.get("z"),
            },
            "component": placement.get("component"),
            "actorListId": placement.get("actorListId"),
            "runtimeTypeRule": placement.get("runtimeTypeRule"),
            "row": (
                {
                    "id": row.get("id"),
                    "refId": row.get("refId"),
                    "allowedTypes": row.get("allowedTypes"),
                    "bits": row.get("bits"),
                }
                if row
                else None
            ),
            "collision": {
                "drivableSurface": (placement.get("collision") or {}).get("drivableSurface"),
                "surfacePresent": (placement.get("collision") or {}).get("surfacePresent"),
                "heightAboveGround": (placement.get("collision") or {}).get("heightAboveGround"),
            },
            "onMeasuredArc": placement.get("onMeasuredArc"),
            "availability": "available" if type_id else "partial",
        }
        entry["hash"] = entry_hash(entry)
        entries.append(entry)
    maps_with = sorted({row.get("mapId") for row in entries if row.get("mapId")})
    return entries, [], {"total": len(entries), "maps": maps_with}


def build_audio(ctx: dict) -> tuple[list, list, dict]:
    powerups = ctx["powerups"]
    entries: list[dict] = []
    seen = set()
    for entity in powerups.get("entities", []):
        audio = entity.get("audio") or {}
        for row in audio.get("entities") or []:
            key = (row.get("name"), row.get("refId"))
            if key in seen:
                continue
            seen.add(key)
            entry = {
                "id": "audio.perk.%s" % re.sub(r"[^a-z0-9]+", "-", str(row.get("name")).lower()).strip("-"),
                "kind": "perk-audio-entity",
                "name": row.get("name"),
                "record": row.get("record"),
                "refId": row.get("refId"),
                "pickupId": entity.get("pickupLabel"),
                "artifact": source_file("_work/powerups/powerups.json", "powerup audio references"),
                "availability": "partial",
                "note": "entity name/id recovered; the perk audio graph wiring and mix are not decoded",
            }
            entry["hash"] = entry_hash(entry)
            entries.append(entry)

    bank_specs = [
        ("_work/audio/car_collisions.baf.json", "car-collisions", True),
        ("_work/audio/wheel_dry.baf.json", "wheel-dry", True),
        ("_work/audio/wheel_offroad.baf.json", "wheel-offroad", True),
    ]
    for path, bank_id, decoded in bank_specs:
        doc, ref = read_json(path, required=False)
        if not doc:
            entries.append(
                {
                    "id": "audio.bank.%s" % bank_id,
                    "kind": "audio-bank",
                    "name": bank_id,
                    "artifact": typed_missing("audio-artifact-absent", expected=path),
                    "availability": "missing",
                    "hash": None,
                }
            )
            entries[-1]["hash"] = entry_hash(entries[-1])
            continue
        entry = {
            "id": "audio.bank.%s" % bank_id,
            "kind": "audio-bank",
            "name": doc.get("bankName"),
            "path": doc.get("asset", {}).get("path"),
            "waveCount": doc.get("waveCount"),
            "bankSha256": _norm_sha(doc.get("bankSha256")),
            "artifact": source_file(path, "decoded audio bank"),
            "availability": "available" if decoded else "partial",
        }
        entry["hash"] = entry_hash(entry)
        entries.append(entry)

    engine, engine_ref = read_json("_work/audio/engine-model.json", required=False)
    if engine:
        entry = {
            "id": "audio.engine.race-v8",
            "kind": "engine-audio-model",
            "name": engine.get("object"),
            "dat": engine.get("dat"),
            "datBytes": engine.get("datBytes"),
            "datSha256": _norm_sha(engine.get("datSha256")),
            "loops": len(engine.get("loops", [])),
            "artifact": source_file("_work/audio/engine-model.json", "engine audio model"),
            "availability": "available",
        }
    else:
        entry = {
            "id": "audio.engine.race-v8",
            "kind": "engine-audio-model",
            "name": "Race_V8_engine",
            "artifact": typed_missing("audio-artifact-absent", expected="_work/audio/engine-model.json"),
            "availability": "missing",
        }
    entry["hash"] = entry_hash(entry)
    entries.append(entry)

    tyre, tyre_ref = read_json("_work/audio/tyre-collision-model.json", required=False)
    if tyre:
        entry = {
            "id": "audio.tyre.collision-model",
            "kind": "tyre-collision-model",
            "name": "tyre-collision",
            "effectMaterials": len(tyre.get("effectMaterials", [])),
            "banks": len(tyre.get("banks", [])),
            "graphs": len(tyre.get("graphs", [])),
            "artifact": source_file("_work/audio/tyre-collision-model.json", "tyre collision model"),
            "availability": "partial",
            "note": "decoded data only; no fitted or invented values",
        }
    else:
        entry = {
            "id": "audio.tyre.collision-model",
            "kind": "tyre-collision-model",
            "name": "tyre-collision",
            "artifact": typed_missing("audio-artifact-absent", expected="_work/audio/tyre-collision-model.json"),
            "availability": "missing",
        }
    entry["hash"] = entry_hash(entry)
    entries.append(entry)

    entries.sort(key=lambda row: row["id"])
    return entries, [], {
        "total": len(entries),
        "perkEntities": sum(1 for row in entries if row["kind"] == "perk-audio-entity"),
        "banks": sum(1 for row in entries if row["kind"] == "audio-bank"),
    }


def build_hud(ctx: dict) -> tuple[list, list, dict]:
    hud = ctx["hud_catalog"]
    powerups = ctx["powerups"]
    sprites = hud.get("iconCatalog", {}).get("carSprites", [])
    atlases = hud.get("sources", {}).get("iconAtlases", [])
    manufacturers = sorted(
        {row.get("manufacturerTexture") for row in hud.get("records", []) if row.get("manufacturerTexture")}
    )
    master_path = hud.get("iconCatalog", {}).get("masterPakPath")
    master_sha = _norm_sha(hud.get("iconCatalog", {}).get("masterSha256"))

    entries: list[dict] = []
    for sprite in sorted(sprites):
        entry = {
            "id": "hud.icon.%s" % sprite,
            "kind": "car-icon-sprite",
            "sprite": sprite,
            "atlas": master_path,
            "atlasSha256": master_sha,
            "status": "name-only",
            "reason": "IPF vector sprite name resolves; pixels and shapes are not decoded",
            "source": "_work/vehicle-pipeline/batch3/hud/hud-catalog.json",
        }
        entry["hash"] = entry_hash(entry)
        entries.append(entry)

    for atlas in atlases:
        name = str(atlas.get("pakPath")).replace("\\", "/").rsplit("/", 1)[-1]
        entry = {
            "id": "hud.atlas.%s" % name.rsplit(".", 1)[0],
            "kind": "icon-atlas",
            "name": name,
            "pakPath": atlas.get("pakPath"),
            "logicalBytes": atlas.get("logicalBytes"),
            "sha256": _norm_sha(atlas.get("sha256")),
            "spriteCount": atlas.get("spriteCount"),
            "status": "name-only",
            "source": "_work/vehicle-pipeline/batch3/hud/hud-catalog.json",
        }
        entry["hash"] = entry_hash(entry)
        entries.append(entry)

    for name in manufacturers:
        entry = {
            "id": "hud.manufacturer.%s" % name,
            "kind": "manufacturer-texture",
            "name": name,
            "status": "name-only",
            "reason": "manufacturer texture name is recorded; no typed texture binding is serialized",
            "source": "_work/vehicle-pipeline/batch3/hud/hud-catalog.json",
        }
        entry["hash"] = entry_hash(entry)
        entries.append(entry)

    source = hud.get("sources", {}).get("hudLoc", {})
    entry = {
        "id": "hud.loc",
        "kind": "string-table",
        "name": "hud.loc",
        "pakPath": source.get("pakPath"),
        "keys": source.get("keys"),
        "sha256": _norm_sha(source.get("sha256")),
        "languages": [row.get("code") for row in source.get("languages", [])],
        "status": "available",
        "source": "_work/vehicle-pipeline/batch3/hud/hud-catalog.json",
    }
    entry["hash"] = entry_hash(entry)
    entries.append(entry)

    sheets = (powerups.get("hud") or {}).get("iconSheets") or []
    for sheet in sheets:
        entry = {
            "id": "hud.sheet.%s" % sheet.get("name"),
            "kind": "perk-icon-sheet",
            "name": sheet.get("name"),
            "stringOffset": sheet.get("stringOffset"),
            "status": "name-only",
            "reason": "string evidence only; no typed atlas binding",
            "source": "_work/powerups/powerups.json",
        }
        entry["hash"] = entry_hash(entry)
        entries.append(entry)

    entries.sort(key=lambda row: row["id"])
    return entries, [], {
        "total": len(entries),
        "carIconSprites": len(sprites),
        "atlasPages": len(atlases),
        "manufacturerTextures": len(manufacturers),
    }


def build_career(ctx: dict, maps: list[dict], modes: list[dict]) -> tuple[list, list, dict]:
    career = ctx["career"]
    map_ids = {row["id"] for row in maps}
    mode_ids = {row["id"] for row in modes}
    entries: list[dict] = []
    for tier in career.get("tiers", []):
        for event in tier.get("events", []):
            route = event.get("route") or {}
            level = route.get("level")
            mode_id = CAREER_MODE_IDS.get(event.get("mode"))
            loc = route.get("loc") or {}
            entry = {
                "id": "career.%s" % event.get("key"),
                "kind": "career-event",
                "key": event.get("key"),
                "eventId": event.get("eventId"),
                "amaxEventId": event.get("amaxEventId"),
                "tierIndex": tier.get("index"),
                "indexInTier": event.get("indexInTier"),
                "kindLabel": event.get("kindLabel"),
                "mode": event.get("mode"),
                "modeId": mode_id if mode_id in mode_ids else typed_missing(
                    "career-mode-unmapped", expected=event.get("mode")
                ),
                "mapId": level if level in map_ids else typed_missing(
                    "career-map-missing", expected=level
                ),
                "mapLabelKey": (
                    {
                        "status": "available",
                        "key": loc.get("key"),
                        "locId": loc.get("locId"),
                        "value": loc.get("value"),
                        "source": "_work/career/career.json",
                    }
                    if loc.get("key")
                    else typed_missing("career-route-loc-absent", expected=route.get("name"))
                ),
                "routeName": route.get("name"),
                "laps": event.get("laps"),
                "carClass": event.get("carClass"),
                "fanPar": event.get("fanPar"),
                "opponentCount": (event.get("opponents") or {}).get("count"),
                "pickups": event.get("pickups"),
                "availability": "data-only",
                "blockers": [
                    {"kind": "career-rules-not-implemented", "note": "data recovered; rules are not implemented"},
                    {"kind": "career-ui-not-implemented", "note": "data recovered; no UI is implemented"},
                ],
            }
            entry["hash"] = entry_hash(entry)
            entries.append(entry)

    entries.sort(key=lambda row: (row["tierIndex"] or 0, row["indexInTier"] or 0, row["id"]))
    return entries, [], {
        "total": len(entries),
        "tiers": len(career.get("tiers", [])),
        "maps": len({row["mapId"] for row in entries if isinstance(row["mapId"], str)}),
        "modes": len({row["modeId"] for row in entries if isinstance(row["modeId"], str)}),
    }


def build_locales(ctx: dict) -> tuple[list, list, dict]:
    index = ctx["loc_index"]
    locale_entries = []
    for row in index.get("locales", []):
        file_row = row.get("file") or {}
        ref = file_ref(file_row.get("path"), expected_sha=file_row.get("sha256"), role="locale")
        entry = {
            "id": "locale.%s" % row.get("code"),
            "kind": "locale",
            "code": row.get("code"),
            "default": row.get("code") == index.get("defaultLocale"),
            "fallback": row.get("code") in index.get("fallbackOrder", []),
            "keys": row.get("keys"),
            "file": ref,
            "slotCount": index.get("slotCount"),
            "availability": "available" if ref.get("status") == "available" else "missing",
        }
        entry["hash"] = entry_hash(entry)
        locale_entries.append(entry)

    slots = ctx["slots"]
    counts = slots.get("counts", {})
    missing_slots = [
        row for row in slots.get("slots", []) if row.get("status") != "resolved"
    ]
    meta = {
        "defaultLocale": index.get("defaultLocale"),
        "fallbackOrder": index.get("fallbackOrder"),
        "fileCount": len(index.get("files", [])),
        "keys": sum(row.get("keys", 0) for row in index.get("files", [])),
        "requiredSlotCount": counts.get("total"),
        "resolvedSlots": counts.get("resolved"),
        "missingSlots": counts.get("missing"),
        "missingSlotIds": [row.get("slot") for row in missing_slots],
    }
    return locale_entries, [], meta


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------


def run_checks(doc: dict, ctx: dict) -> dict:
    checks: list[dict] = []
    missing_counts: dict[str, dict[str, int]] = {}
    resolved_keys = set(ctx["resolved_loc_keys"])
    sprite_set = set(ctx["hud_catalog"].get("iconCatalog", {}).get("carSprites", []))

    def check(check_id: str, ok: bool, detail: Any = None) -> None:
        item = {"id": check_id, "ok": bool(ok)}
        if detail is not None:
            item["detail"] = detail
        checks.append(item)

    def bump(section: str, key: str, amount: int = 1) -> None:
        missing_counts.setdefault(section, {})
        missing_counts[section][key] = missing_counts[section].get(key, 0) + amount

    def ref_file_ok(ref: dict) -> bool:
        if not isinstance(ref, dict):
            return False
        status = ref.get("status")
        if status == "missing":
            return True  # typed missing is a valid state
        if status not in ("available", "present"):
            return False
        path = ref.get("path")
        if not path or not (ROOT / path).exists():
            return False
        if ref.get("sha256") and sha256_file(ROOT / path) != ref["sha256"]:
            return False
        return True

    sections = {
        "cars": doc.get("cars", []),
        "maps": doc.get("maps", []),
        "modes": doc.get("modes", []),
        "powerups": doc.get("powerups", []),
        "pickupPlacements": doc.get("pickupPlacements", []),
        "audioEvents": doc.get("audioEvents", []),
        "hudAssets": doc.get("hudAssets", []),
        "careerEvents": doc.get("careerEvents", []),
        "locales": doc.get("locales", []),
    }

    check("schema.id", doc.get("schema") == SCHEMA, doc.get("schema"))
    check("schema.contentVersion", doc.get("contentVersion") == CONTENT_VERSION, doc.get("contentVersion"))
    check("schema.kind", doc.get("kind") == "blur.content-index")
    check("schema.sections", all(isinstance(value, list) for value in sections.values()))

    for section, rows in sections.items():
        ids = [row.get("id") for row in rows]
        check("section.%s.ids" % section, all(isinstance(value, str) and value for value in ids))
        check("section.%s.unique" % section, len(ids) == len(set(ids)), "%d/%d" % (len(set(ids)), len(ids)))
        for row in rows:
            check("entry.%s.%s.hash" % (section, row.get("id")), row.get("hash") == entry_hash(row))
            if row.get("hash") != entry_hash(row):
                check("entry.%s.%s.hash-detail" % (section, row.get("id")), False, row.get("hash"))

    car_ids = {row["id"] for row in sections["cars"]}
    map_ids = {row["id"] for row in sections["maps"]}
    mode_ids = {row["id"] for row in sections["modes"]}
    powerup_ids = {row["id"] for row in sections["powerups"]}
    hud_ids = {row["id"] for row in sections["hudAssets"]}

    check("ids.unique-across-cars", len(car_ids) == len(sections["cars"]))
    check("ids.unique-across-maps", len(map_ids) == len(sections["maps"]))
    check("ids.unique-across-powerups", len(powerup_ids) == len(sections["powerups"]))

    for car in sections["cars"]:
        cid = car["id"]
        check("car.%s.required" % cid, all(key in car for key in ("availability", "class", "chunks", "ghosts", "liveryRefs")))
        check("car.%s.class" % cid, car.get("class") in ("A", "B", "C", "D") or isinstance(car.get("class"), dict))
        chunk = car.get("chunks", {}).get("geometry", {})
        check("car.%s.chunk-ref" % cid, ref_file_ok(chunk))
        if chunk.get("status") == "missing":
            bump("cars", "geometryChunkMissing")
        elif chunk.get("status") != "available":
            check("car.%s.chunk-status" % cid, False, chunk.get("status"))
        for course, ghost in car.get("ghosts", {}).items():
            check("car.%s.ghost.%s" % (cid, course), ref_file_ok(ghost))
            if ghost.get("status") == "missing":
                bump("cars", "ghostMissing")
        key_ref = car.get("displayNameKey", {})
        if key_ref.get("status") == "available":
            check("car.%s.display-key" % cid, key_ref.get("key") in resolved_keys, key_ref.get("key"))
        elif key_ref.get("status") == "missing":
            bump("cars", "displayKeyMissing")
        else:
            check("car.%s.display-key-status" % cid, False, key_ref.get("status"))
        icon = car.get("hud", {}).get("iconRef", {})
        if icon.get("status") == "available":
            check("car.%s.hud-sprite" % cid, icon.get("sprite") in sprite_set, icon.get("sprite"))
            check("car.%s.hud-asset" % cid, ("hud.icon.%s" % icon.get("sprite")) in hud_ids)
        elif icon.get("status") == "missing":
            bump("cars", "hudIconMissing")
        else:
            check("car.%s.hud-icon-status" % cid, False, icon.get("status"))
        livery = car.get("liveryRefs") or []
        check("car.%s.livery-typed" % cid, livery and all(ref.get("status") == "missing" for ref in livery))
        if livery and all(ref.get("status") == "missing" for ref in livery):
            bump("cars", "liveryMissing")
        check("car.%s.blockers" % cid, isinstance(car.get("blockers"), list))

    for map_row in sections["maps"]:
        mid = map_row["id"]
        check("map.%s.required" % mid, all(key in map_row for key in ("package", "collider", "pickupPath", "modes", "lengthMetres")))
        check("map.%s.package-ref" % mid, ref_file_ok(map_row.get("package", {})))
        check("map.%s.collider-ref" % mid, ref_file_ok(map_row.get("collider", {})))
        check("map.%s.pickup-ref" % mid, ref_file_ok(map_row.get("pickupPath", {})))
        check("map.%s.lap-ref" % mid, ref_file_ok(map_row.get("lapLayout", {})))
        if map_row.get("package", {}).get("status") == "missing":
            bump("maps", "packageMissing")
        if map_row.get("pickupPath", {}).get("status") == "missing":
            bump("maps", "pickupMissing")
        if map_row.get("lapLayout", {}).get("status") == "missing":
            bump("maps", "lapLayoutMissing")
        for mode_id in map_row.get("modes", []):
            check("map.%s.mode.%s" % (mid, mode_id), mode_id in mode_ids, mode_id)
        key_ref = map_row.get("labelKey", {})
        if key_ref.get("status") == "available":
            check("map.%s.label-key" % mid, key_ref.get("key") in resolved_keys, key_ref.get("key"))
        elif key_ref.get("status") == "missing":
            bump("maps", "labelKeyMissing")
        else:
            check("map.%s.label-status" % mid, False, key_ref.get("status"))
        check("map.%s.length" % mid, isinstance(map_row.get("lengthMetres"), (int, float)))
        layout_ref = map_row.get("layouts", {})
        for course, ref in layout_ref.items():
            check("map.%s.layout.%s" % (mid, course), ref_file_ok(ref))

    for mode in sections["modes"]:
        mid = mode["id"]
        check("mode.%s.required" % mid, all(key in mode for key in ("family", "maps", "availability", "labelKey")))
        for map_id in mode.get("maps", []):
            check("mode.%s.map.%s" % (mid, map_id), map_id in map_ids)
        key_ref = mode.get("labelKey", {})
        if key_ref.get("status") == "available":
            check("mode.%s.label-key" % mid, key_ref.get("key") in resolved_keys, key_ref.get("key"))
        elif key_ref.get("status") == "missing":
            bump("modes", "labelKeyMissing")
        else:
            check("mode.%s.label-status" % mid, False, key_ref.get("status"))

    for powerup in sections["powerups"]:
        pid = powerup["id"]
        check("powerup.%s.required" % pid, all(key in powerup for key in ("nameKey", "iconRef", "rulesRef")))
        key_ref = powerup.get("nameKey", {})
        if key_ref.get("status") == "available":
            check("powerup.%s.name-key" % pid, key_ref.get("key") in resolved_keys, key_ref.get("key"))
        elif key_ref.get("status") == "missing":
            bump("powerups", "nameKeyMissing")
        else:
            check("powerup.%s.name-status" % pid, False, key_ref.get("status"))
        icon = powerup.get("iconRef", {})
        if icon.get("status") == "partial":
            check("powerup.%s.icon-index" % pid, isinstance(icon.get("textureIndex"), int))
        elif icon.get("status") == "missing":
            bump("powerups", "iconMissing")
        else:
            check("powerup.%s.icon-status" % pid, False, icon.get("status"))
        if (powerup.get("multiplayer") or {}).get("multiplayer") is None:
            bump("powerups", "multiplayerFlagMissing")
        rules = powerup.get("rulesRef", {})
        check("powerup.%s.rules" % pid, rules.get("status") == "available" and (ROOT / rules.get("prototype", "")).exists())

    placement_ids = set()
    for placement in sections["pickupPlacements"]:
        pid = placement["id"]
        placement_ids.add(pid)
        check("placement.%s.required" % pid, all(key in placement for key in ("mapId", "typeId", "position", "uid")))
        check("placement.%s.map" % pid, placement.get("mapId") in map_ids)
        type_id = placement.get("typeId")
        check("placement.%s.type" % pid, isinstance(type_id, str) and type_id in powerup_ids, type_id)
        check("placement.%s.position" % pid, all(isinstance(placement.get("position", {}).get(k), (int, float)) for k in ("x", "y", "z")))

    for audio in sections["audioEvents"]:
        aid = audio["id"]
        artifact = audio.get("artifact", {})
        check("audio.%s.artifact" % aid, ref_file_ok(artifact))
        check("audio.%s.kind" % aid, isinstance(audio.get("kind"), str))

    for hud in sections["hudAssets"]:
        hid = hud["id"]
        check("hud.%s.kind" % hid, isinstance(hud.get("kind"), str))
        check("hud.%s.status" % hid, hud.get("status") in ("available", "name-only", "partial"))

    for event in sections["careerEvents"]:
        eid = event["id"]
        map_id = event.get("mapId")
        mode_id = event.get("modeId")
        check("career.%s.map" % eid, (isinstance(map_id, str) and map_id in map_ids) or isinstance(map_id, dict))
        check("career.%s.mode" % eid, (isinstance(mode_id, str) and mode_id in mode_ids) or isinstance(mode_id, dict))

    for locale in sections["locales"]:
        lid = locale["id"]
        check("locale.%s.file" % lid, ref_file_ok(locale.get("file", {})))

    # Capability consistency.
    caps = doc.get("capabilities", {})
    check("capabilities.present", isinstance(caps, dict))
    cap_maps = caps.get("maps", {}) if isinstance(caps, dict) else {}
    check("capabilities.maps-count", len(cap_maps) == len(sections["maps"]), "%d/%d" % (len(cap_maps), len(sections["maps"])))
    allowed_feature = {"available", "partial", "unsupported", "missing"}
    for map_id, cap in cap_maps.items():
        check("capabilities.map.%s.exists" % map_id, map_id in map_ids)
        map_row = next((row for row in sections["maps"] if row["id"] == map_id), None)
        if map_row:
            check(
                "capabilities.map.%s.modes-match" % map_id,
                sorted(cap.get("modes", {}).keys()) == sorted(map_row.get("modes", [])),
            )
            for mode_id, support in cap.get("modes", {}).items():
                check("capabilities.map.%s.mode.%s" % (map_id, mode_id), mode_id in mode_ids and support.get("status") in allowed_feature)
            for feature, value in cap.get("features", {}).items():
                check("capabilities.map.%s.feature.%s" % (map_id, feature), value.get("status") in allowed_feature)
            if (map_row.get("pickupPath") or {}).get("status") == "available":
                check("capabilities.map.%s.pickups" % map_id, cap.get("features", {}).get("pickups", {}).get("status") == "available")
            if (map_row.get("package") or {}).get("status") == "available":
                check("capabilities.map.%s.package" % map_id, cap.get("features", {}).get("layout", {}).get("status") == "available")

    summary = caps.get("summary", {}) if isinstance(caps, dict) else {}
    check("capabilities.summary.maps", summary.get("maps") == doc.get("counts", {}).get("maps"))
    check("capabilities.summary.cars", summary.get("cars") == doc.get("counts", {}).get("cars"))

    passed = sum(1 for item in checks if item["ok"])
    failed = [item for item in checks if not item["ok"]]
    return {
        "checks": checks,
        "counts": {
            "total": len(checks),
            "passed": passed,
            "failed": len(failed),
        },
        "failures": failed,
        "missing": missing_counts,
    }


def build_capabilities(ctx: dict, maps: list[dict], modes: list[dict], doc_counts: dict) -> dict:
    cap_maps = {}
    for map_row in maps:
        support = ctx["map_mode_support"].get(map_row["id"], {})
        features = ctx.get("map_features", {}).get(map_row["id"], {})
        cap_maps[map_row["id"]] = {
            "registryId": map_row.get("registryId"),
            "classification": map_row.get("classification"),
            "availability": map_row.get("availability"),
            "modes": support,
            "features": features,
        }

    feature_counts: dict[str, dict[str, int]] = {}
    for cap in cap_maps.values():
        for feature, value in cap["features"].items():
            status = value.get("status")
            feature_counts.setdefault(feature, {"available": 0, "partial": 0, "unsupported": 0, "missing": 0})
            feature_counts[feature][status] = feature_counts[feature].get(status, 0) + 1

    mode_summary = {}
    for mode in modes:
        mode_summary[mode["id"]] = {
            "label": mode["label"],
            "family": mode["family"],
            "availability": mode["availability"],
            "maps": mode["maps"],
        }

    return {
        "schema": SCHEMA + "#capabilities",
        "maps": cap_maps,
        "modes": mode_summary,
        "features": feature_counts,
        "summary": {
            "cars": doc_counts.get("cars"),
            "maps": doc_counts.get("maps"),
            "modes": doc_counts.get("modes"),
            "powerups": doc_counts.get("powerups"),
            "pickupPlacements": doc_counts.get("pickupPlacements"),
            "careerEvents": doc_counts.get("careerEvents"),
            "featureStatus": feature_counts,
        },
    }


# --------------------------------------------------------------------------
# assembly
# --------------------------------------------------------------------------


def build_document() -> dict:
    source_refs: dict[str, dict] = {}

    def load(name: str, path: str, role: str, required: bool = True):
        data, ref = read_json(path, required=required)
        source_refs[name] = dict(ref, role=role)
        return data

    roster = load("cars.roster", "probes/e1-drive/cars/roster.json", "car roster")
    car_bodies = load("cars.bodies", "_work/e1-drive/car-bodies.index.json", "e1 car chunk index")
    ghosts = load("cars.ghosts", "probes/e1-drive/ghosts/index.json", "ghost index")
    car_classes = load("cars.classes", "probes/game-shell/data/car-classes.json", "content completeness class")
    registry, registry_ref = load_map_registry()
    source_refs["maps.registry"] = registry_ref
    maps_doc = load("maps.pipeline", "_work/map-pipeline/maps.json", "19-level map audit")
    batch3 = load("cars.batch3", "_work/vehicle-pipeline/batch3/summary.json", "staged batch 3")
    hud_catalog = load("hud.catalog", "_work/vehicle-pipeline/batch3/hud/hud-catalog.json", "HUD catalog")
    powerups = load("powerups.manifest", "_work/powerups/powerups.json", "powerup definitions")
    placements = load("powerups.placements", "_work/powerups/placements.json", "River pickup placements")
    loc_index = load("loc.index", "_work/loc/index.json", "locale index")
    slots = load("loc.slots", "_work/loc/slots.json", "required loc slots")
    career = load("career.manifest", "_work/career/career.json", "career manifest")
    source_refs["loc.en"] = source_file("_work/loc/locales/en.json", "English strings")
    source_refs["rules.powerups"] = source_file("probes/powerups/rules/engine.js", "powerup rules prototype")
    source_refs["liveries.tooling"] = source_file("probes/liveries/tools/xtlib.py", "livery tooling")

    for path in (
        "_work/e1-drive/sprint.json",
        "_work/e1-drive/sprint-short.json",
        "_work/e1-drive/sprint-lap.json",
        "_work/e1-drive/sprint-free.json",
        "_work/e1-drive/amboy/layout.json",
        "_work/e1-drive/gracia/layout.json",
        "_work/audio/_entities-raw.json",
        "_work/audio/engine-model.json",
        "_work/audio/tyre-collision-model.json",
    ):
        key = "aux." + path.replace("/", ".").replace("_work.", "")
        source_refs[key] = source_file(path, "read-only input")

    en_doc = json.loads((ROOT / "_work/loc/locales/en.json").read_text(encoding="utf-8"))
    en_strings = en_doc.get("strings", {})
    slot_by_name = {row["slot"]: row for row in slots.get("slots", [])}
    resolved_loc_keys = {
        row["key"] for row in slots.get("slots", []) if row.get("status") == "resolved" and row.get("key")
    }
    resolved_loc_keys.update(name.rsplit(":", 1)[-1] for name in en_strings)
    base_geometry_index = car_bodies

    ctx: dict = {
        "roster": roster,
        "car_bodies": car_bodies,
        "ghosts": ghosts,
        "car_classes": car_classes,
        "registry": registry,
        "maps_doc": maps_doc,
        "batch3": batch3,
        "hud_catalog": hud_catalog,
        "powerups": powerups,
        "placements": placements,
        "loc_index": loc_index,
        "slots": slots,
        "slot_by_name": slot_by_name,
        "cars_loc_map": cars_loc_map,
        "career": career,
        "en_strings": en_strings,
        "resolved_loc_keys": resolved_loc_keys,
        "base_geometry_index": base_geometry_index,
        "locations": {},
        "powerup_entries": [],
        "career_events": [],
        "map_mode_support": {},
    }

    cars, cars_missing, cars_meta = build_cars(ctx)
    maps, maps_missing, maps_meta = build_maps(ctx)
    modes, modes_missing, modes_meta = build_modes(ctx, maps)
    powerups_section, powerups_missing, powerups_meta = build_powerups(ctx)
    ctx["powerup_entries"] = powerups_section
    placements_section, placements_missing, placements_meta = build_placements(ctx)
    audio_section, audio_missing, audio_meta = build_audio(ctx)
    hud_section, hud_missing, hud_meta = build_hud(ctx)
    career_section, career_missing, career_meta = build_career(ctx, maps, modes)
    ctx["career_events"] = career_section
    locales_section, locales_missing, locales_meta = build_locales(ctx)

    # Rebuild mode support now that career events exist, then attach capabilities.
    ctx["map_mode_support"] = {}
    for map_row in maps:
        support: dict[str, dict] = {}
        name = map_row["id"]
        registry_row = next((row for row in registry["maps"].values() if row["level"] == name), None)
        if registry_row:
            if name == "usa_la_river":
                support["sprint.310m"] = {"status": "available", "courseId": "310m", "reason": "committed 310.395 m sprint layout"}
                support["sprint.short"] = {"status": "available", "courseId": "short", "reason": "committed 29 m short layout"}
                support["lap"] = {"status": "available", "courseId": "lap", "reason": "committed loop-01 three-lap layout"}
                support["free-roam"] = {"status": "available", "courseId": "free", "reason": "committed free-roam basin layout"}
            else:
                support["sprint.custom"] = {"status": "available", "courseId": registry_row["id"], "reason": "committed point-to-point measured layout"}
            if registry_row.get("multiplayer"):
                support["mp.racing"] = {
                    "status": "available" if name == "usa_la_river" else "partial",
                    "reason": "registry multiplayer map"
                    + ("" if name == "usa_la_river" else "; no pickup placement artifact for this level"),
                }
        for event in career_section:
            if event.get("mapId") == name and isinstance(event.get("modeId"), str):
                support.setdefault(
                    event["modeId"],
                    {
                        "status": "partial",
                        "reason": "career event data exists; race rules and UI are not implemented",
                    },
                )
        map_row["modes"] = sorted(support.keys())
        ctx["map_mode_support"][name] = support

    # Derive per-map feature state from the map audit and the committed artifacts.
    ctx["map_features"] = {}
    maps_by_id = {row["id"]: row for row in maps}
    for row in maps_doc.get("levels", []):
        map_row = maps_by_id.get(row["name"])
        if not map_row:
            continue
        features = {
            "collision": {
                "status": "available" if row.get("drivable", {}).get("measured") else "unsupported",
                "reason": "Level.levelphysics parsed and a passable component was measured"
                if row.get("drivable", {}).get("measured")
                else "no measured passable component",
            },
            "drawCoverage": {
                "status": {"A": "available", "B": "partial"}.get(row.get("classification"), "unsupported"),
                "reason": row.get("classificationReason"),
                "drawCoveredPathMetres": row.get("drawCoverage", {}).get("drawCoveredPathM"),
                "completeness": row.get("drawCoverage", {}).get("completenessOfCollisionPath"),
            },
            "spawn": {
                "status": "available"
                if row.get("drivable", {}).get("committedSpawn")
                else ("partial" if row.get("drivable", {}).get("candidateSpawn") else "unsupported"),
                "reason": "committed spawn" if row.get("drivable", {}).get("committedSpawn") else "derived component endpoint or none",
            },
            "layout": {
                "status": "available" if map_row.get("layouts") else "missing",
                "reason": "committed e1 layout" if map_row.get("layouts") else "no committed e1 layout",
            },
            "materials": {
                "status": "available"
                if row["name"] in ("usa_la_river", "usa_amboy", "spa_barcelona_gracia")
                else "unsupported",
                "reason": "committed material/texture binding"
                if row["name"] in ("usa_la_river", "usa_amboy", "spa_barcelona_gracia")
                else "native level draws are diagnostic; no albedo/sampler binding",
            },
            "instances": {
                "status": "unsupported",
                "reason": "instancesApplied:false; instance-only geometry can add or change surfaces",
            },
            "pickups": {
                "status": "available" if map_row.get("pickupPath", {}).get("status") == "available" else "missing",
                "reason": "pickup placements present" if map_row.get("pickupPath", {}).get("status") == "available" else "no pickup placement artifact",
            },
            "ghosts": {
                "status": "available" if map_row["id"] == "usa_la_river" else "missing",
                "reason": "committed ghosts" if map_row["id"] == "usa_la_river" else "no committed ghosts",
            },
            "propLayer": {
                "status": "available" if map_row["id"] == "usa_la_river" else "missing",
                "reason": "committed prop layer" if map_row["id"] == "usa_la_river" else "no committed prop layer",
            },
            "multiplayer": {
                "status": "available"
                if map_row["id"] == "usa_la_river"
                else ("partial" if map_row.get("registryId") else "unsupported"),
                "reason": "registry multiplayer map" if map_row.get("registryId") else "not a registry multiplayer map",
            },
        }
        ctx["map_features"][map_row["id"]] = features

    # Modes now see the career events and the final per-map mode support.
    modes, modes_missing, modes_meta = build_modes(ctx, maps)

    # Re-hash maps after the dynamic mode reconciliation; no internal keys leak.
    for map_row in maps:
        map_row.pop("_features", None)
        map_row.pop("hash", None)
        map_row["hash"] = entry_hash(map_row)

    counts = {
        "cars": len(cars),
        "carsIntegrated": cars_meta.get("integrated", 0),
        "carsStaged": cars_meta.get("staged", 0),
        "maps": len(maps),
        "mapsA": maps_meta.get("A", 0),
        "mapsB": maps_meta.get("B", 0),
        "mapsC": maps_meta.get("C", 0),
        "modes": len(modes),
        "powerups": len(powerups_section),
        "pickupPlacements": len(placements_section),
        "audioEvents": len(audio_section),
        "hudAssets": len(hud_section),
        "careerEvents": len(career_section),
        "locales": len(locales_section),
    }

    capabilities = build_capabilities(ctx, maps, modes, counts)

    sections = {
        "cars": (cars, cars_missing, cars_meta),
        "maps": (maps, maps_missing, maps_meta),
        "modes": (modes, modes_missing, modes_meta),
        "powerups": (powerups_section, powerups_missing, powerups_meta),
        "pickupPlacements": (placements_section, placements_missing, placements_meta),
        "audioEvents": (audio_section, audio_missing, audio_meta),
        "hudAssets": (hud_section, hud_missing, hud_meta),
        "careerEvents": (career_section, career_missing, career_meta),
        "locales": (locales_section, locales_missing, locales_meta),
    }

    missing_summary = {
        "cars": {
            "liveryCatalogMissing": sum(
                1
                for car in cars
                if car.get("liveryRefs") and car["liveryRefs"][0].get("status") == "missing"
            ),
            "geometryChunkMissing": sum(
                1 for car in cars if car["chunks"]["geometry"].get("status") == "missing"
            ),
            "ghostMissing": sum(
                1
                for car in cars
                for ghost in car["ghosts"].values()
                if ghost.get("status") == "missing"
            ),
            "hudIconMissing": sum(
                1 for car in cars if car["hud"]["iconRef"].get("status") == "missing"
            ),
        },
        "maps": {
            "packageMissing": sum(1 for row in maps if row["package"].get("status") == "missing"),
            "pickupPlacementMissing": sum(1 for row in maps if row["pickupPath"].get("status") == "missing"),
            "lapLayoutMissing": sum(1 for row in maps if row["lapLayout"].get("status") == "missing"),
            "layoutMissing": sum(1 for row in maps if not row.get("layouts")),
        },
        "powerups": {
            "nameKeyMissing": sum(1 for row in powerups_section if row["nameKey"].get("status") == "missing"),
            "iconMissing": sum(1 for row in powerups_section if row["iconRef"].get("status") == "missing"),
            "multiplayerFlagMissing": sum(
                1 for row in powerups_section if (row.get("multiplayer") or {}).get("multiplayer") is None
            ),
        },
        "locales": {
            "missingSlots": locales_meta.get("missingSlots"),
            "missingSlotIds": locales_meta.get("missingSlotIds"),
        },
    }

    section_hashes = {}
    for name, (entries, missing, _meta) in sections.items():
        section_hashes[name] = section_hash(entries, missing, _meta)

    stamp_payload = {
        "schema": SCHEMA,
        "contentVersion": CONTENT_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "sources": source_refs,
    }
    build_stamp = "sha256:" + hashlib.sha256(canonical_bytes(stamp_payload)).hexdigest()

    doc: dict = {
        "schema": SCHEMA,
        "contentVersion": CONTENT_VERSION,
        "kind": "blur.content-index",
        "build": {
            "id": "content-db-%d" % CONTENT_VERSION,
            "stamp": build_stamp,
            "generator": GENERATOR,
            "generatorVersion": GENERATOR_VERSION,
            "deterministic": True,
            "canonicalForm": "blur.content-db.canonical/1",
        },
        "defaults": {
            "car": roster.get("default"),
            "map": "usa_la_river",
            "registryMap": registry.get("defaultMap"),
        },
        "sources": source_refs,
        "counts": counts,
        "missing": missing_summary,
        "cars": cars,
        "maps": maps,
        "modes": modes,
        "powerups": powerups_section,
        "pickupPlacements": placements_section,
        "audioEvents": audio_section,
        "hudAssets": hud_section,
        "careerEvents": career_section,
        "locales": locales_section,
        "localesMeta": locales_meta,
        "sectionMeta": {
            name: {"missing": missing, "meta": meta}
            for name, (_entries, missing, meta) in sections.items()
        },
        "capabilities": capabilities,
    }

    validation = run_checks(doc, ctx)
    doc["validation"] = validation

    section_hashes = {}
    for name, (entries, missing, meta) in sections.items():
        section_hashes[name] = section_hash(entries, missing, meta)

    doc["hashes"] = {
        "algorithm": "sha256",
        "canonicalForm": "blur.content-db.canonical/1",
        "top": digest({key: value for key, value in doc.items() if key != "hashes"}),
        "sections": section_hashes,
    }
    return doc


# --------------------------------------------------------------------------
# output
# --------------------------------------------------------------------------


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def compact_index(doc: dict) -> dict:
    return {
        "schema": doc["schema"],
        "contentVersion": doc["contentVersion"],
        "build": {"id": doc["build"]["id"], "stamp": doc["build"]["stamp"]},
        "hashes": {"top": doc["hashes"]["top"]},
        "counts": doc["counts"],
        "defaults": doc["defaults"],
        "files": {
            "content": "content.json",
            "cars": "cars.json",
            "maps": "maps.json",
            "modes": "modes.json",
            "powerups": "powerups.json",
            "pickupPlacements": "pickupPlacements.json",
            "audioEvents": "audioEvents.json",
            "hudAssets": "hudAssets.json",
            "careerEvents": "careerEvents.json",
            "locales": "locales.json",
            "capabilities": "capabilities.json",
            "validation": "validation.json",
        },
        "cars": [
            {
                "id": car["id"],
                "displayName": car.get("displayName"),
                "class": car.get("class"),
                "drivetrain": car.get("drivetrain"),
                "massKg": car.get("massKg"),
                "gears": car.get("gears"),
                "availability": car.get("availability"),
            }
            for car in doc["cars"]
        ],
        "maps": [
            {
                "id": row["id"],
                "registryId": row.get("registryId"),
                "label": row.get("label"),
                "lengthMetres": row.get("lengthMetres"),
                "modes": row.get("modes", []),
                "availability": row.get("availability"),
            }
            for row in doc["maps"]
        ],
        "modes": [
            {
                "id": row["id"],
                "label": row["label"],
                "availability": row["availability"],
                "maps": row["maps"],
            }
            for row in doc["modes"]
        ],
    }


def emit(doc: dict, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    content_path = out_dir / "content.json"
    write_json(content_path, doc)
    written.append(content_path)

    section_map = {
        "cars": doc["cars"],
        "maps": doc["maps"],
        "modes": doc["modes"],
        "powerups": doc["powerups"],
        "pickupPlacements": doc["pickupPlacements"],
        "audioEvents": doc["audioEvents"],
        "hudAssets": doc["hudAssets"],
        "careerEvents": doc["careerEvents"],
        "locales": doc["locales"],
    }
    for name, entries in section_map.items():
        meta_row = doc.get("sectionMeta", {}).get(name, {})
        missing = meta_row.get("missing", [])
        meta = meta_row.get("meta")
        payload = {
            "schema": doc["schema"],
            "contentVersion": doc["contentVersion"],
            "section": name,
            "build": {"id": doc["build"]["id"], "stamp": doc["build"]["stamp"]},
            "count": len(entries),
            "hash": doc["hashes"]["sections"][name],
            "entries": entries,
            "missing": missing,
            "meta": meta,
        }
        path = out_dir / ("%s.json" % name)
        write_json(path, payload)
        written.append(path)

    extra = {
        "capabilities": {
            "schema": doc["schema"] + "#capabilities",
            "contentVersion": doc["contentVersion"],
            "build": doc["build"],
            "top": doc["hashes"]["top"],
            "capabilities": doc["capabilities"],
        },
        "validation": {
            "schema": doc["schema"] + "#validation",
            "contentVersion": doc["contentVersion"],
            "build": doc["build"],
            "top": doc["hashes"]["top"],
            "validation": doc["validation"],
        },
        "index": compact_index(doc),
    }
    for name, payload in extra.items():
        path = out_dir / ("%s.json" % name)
        write_json(path, payload)
        written.append(path)
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the Blur Web content index.")
    parser.add_argument("--out", default=str(OUT_DEFAULT), help="output directory")
    parser.add_argument("--log-dir", default=str(LOG_DEFAULT), help="log directory")
    parser.add_argument("--quiet", action="store_true", help="do not print the summary")
    parser.add_argument("--no-log", action="store_true", help="do not write a build log")
    args = parser.parse_args(argv)

    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = ROOT / out_dir

    try:
        doc = build_document()
    except ContentBuildError as exc:
        print("FAIL %s" % exc, file=sys.stderr)
        return 1

    written = emit(doc, out_dir)
    validation = doc["validation"]
    summary = {
        "ok": validation["counts"]["failed"] == 0,
        "contentVersion": doc["contentVersion"],
        "buildStamp": doc["build"]["stamp"],
        "topHash": doc["hashes"]["top"],
        "counts": doc["counts"],
        "validation": validation["counts"],
        "files": [str(path.relative_to(ROOT)) for path in written],
    }

    if not args.no_log:
        log_dir = Path(args.log_dir)
        if not log_dir.is_absolute():
            log_dir = ROOT / log_dir
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "build.log"
        with log_path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(summary, indent=2, sort_keys=True) + "\n")
            for failure in validation.get("failures", []):
                handle.write("FAIL %s %s\n" % (failure.get("id"), failure.get("detail", "")))

    if not args.quiet:
        print(json.dumps(summary, indent=2, sort_keys=True))

    return 0 if summary["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
