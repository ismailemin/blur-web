#!/usr/bin/env python
"""E1 browser PoC readiness check (stdlib only).

Verifies the artifacts that `tools/run_e1_poc.ps1` serves, using the sizes and
SHA-256 values recorded *inside* those artifacts:

  - module glue + wasm against `module/build.json`
  - geometry.json payloads against the pins it carries
  - Level.levelphysics against the collision-surface source hash in geometry
  - sprint.json / sprint-short.json against their own gates and per-car runs
  - cars.json roster entries against the per-car `cars/<slug>.fields` files
  - track/car texture manifests, UV streams and decoded RGBA files

It does not build, write, start or stop anything. The server probe runs only
when something already listens on 127.0.0.1:8801.

Usage:
    python tools/check_e1_poc.py            # human readable, PASS/FAIL per item
    python tools/check_e1_poc.py --json     # machine readable report
    python tools/check_e1_poc.py --hash     # also print artifact SHA-256 values
    python tools/check_e1_poc.py --json --hash

Exit codes: 0 = all required checks pass, 1 = a check failed,
2 = a required artifact (file) is missing.
"""

import argparse
import base64
import hashlib
import http.client
import json
import re
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "_work" / "e1-drive"
SERVER = "http://127.0.0.1:8801"

CARS = [
    {
        "slug": "corvette-zr1-stock",
        "name": "Corvette_ZR1_Stock",
        "record_index": 37,
        "record_id": 1554942492,
        "drivetrain": "RWD",
        "mass": 1600.0,
        "sprint310": 14.650,
        "short": 2.800,
    },
    {
        "slug": "lotus-exige-cup260-stock",
        "name": "Lotus_ExigeCup260_Stock",
        "record_index": 15,
        "record_id": 805568925,
        "drivetrain": "RWD",
        "mass": 890.0,
        "sprint310": 14.766667,
        "short": 2.850,
    },
    {
        "slug": "dodge-challenger-stock",
        "name": "Dodge_Challenger_Stock",
        "record_index": 9,
        "record_id": 528964602,
        "drivetrain": "RWD",
        "mass": 1700.0,
        "sprint310": 14.916667,
        "short": 3.000,
    },
    {
        "slug": "ford-focusrs-stock",
        "name": "Ford_FocusRS_Stock",
        "record_index": 50,
        "record_id": 2563977008,
        "drivetrain": "FWD",
        "mass": 1400.0,
        "sprint310": 15.216667,
        "short": 3.266667,
    },
    {
        "slug": "audi-r8v10-stock",
        "name": "Audi_R8V10_Stock",
        "record_index": 55,
        "record_id": 2936683857,
        "drivetrain": "AWD",
        "mass": 1600.0,
        "sprint310": 14.150,
        "short": 2.283333,
    },
]

# Gates of the default 310 m course (T-007-310m-course.md section 1.1).
EXPECTED_310_GATES = [
    ("start", 0, 0.000000, -88.0000, 1050.0000, 0.767411),
    ("checkpoint", 1, 100.107736, -18.4982, 1122.0490, 0.767411),
    ("checkpoint", 2, 200.074803, 42.8327, 1200.5576, 0.583878),
    ("finish", 3, 300.159666, 97.5348, 1284.1824, 0.622165),
]

# Gates of the 29 m regression course (?course=short).
EXPECTED_SHORT_X = [-88.0, -78.25, -68.75, -59.0]
EXPECTED_SHORT_KINDS = ["start", "checkpoint", "checkpoint", "finish"]

WEB_FILES = [
    "probes/e1-drive/web/index.html",
    "probes/e1-drive/web/style.css",
    "probes/e1-drive/web/app.js",
    "probes/e1-drive/web/cars.js",
    "probes/e1-drive/web/packet-adapter.js",
    "probes/e1-drive/web/packet-camera.mjs",
    "probes/e1-drive/web/packet-consumer.js",
    "probes/e1-drive/web/packet-hash.js",
    "probes/e1-drive/web/camera-occlusion.js",
    "probes/e1-drive/web/sha256.js",
    "probes/e1-drive/web/fixed-step.js",
    "probes/e1-drive/web/interpolate.js",
    "probes/e1-drive/web/drive-script.js",
    "probes/e1-drive/web/sprint-layout.js",
    "probes/e1-drive/web/sprint-rules.js",
    "probes/e1-drive/web/sprint-script.js",
    "probes/e1-drive/web/sprint-best.js",
    "probes/e1-drive/web/ghost-replay.js",
    "probes/e1-drive/web/prop-layer.js",
    "probes/prop-collision/lib/resolver.mjs",
    "probes/e1-drive/web/telemetry.js",
    "probes/e1-drive/web/corridor-survey.js",
]

LEVEL_MAGIC = b"  CPPhysic"
_JSON_CACHE = {}


def rel(path):
    try:
        return Path(path).resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return Path(path).as_posix()


def sha256_bytes(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def pin_is(pin, data):
    """Compare a recorded pin (bare hex or sha256:hex) with bytes."""
    if not pin:
        return None
    return hashlib.sha256(data).hexdigest() == str(pin).split(":")[-1].lower()


def sha256_file(path):
    return sha256_bytes(Path(path).read_bytes())


def load_json(path):
    """Parse once per run: geometry.json is 45 MB and is read by several checks."""
    key = str(Path(path))
    if key not in _JSON_CACHE:
        with Path(path).open("r", encoding="utf-8") as handle:
            _JSON_CACHE[key] = json.load(handle)
    return _JSON_CACHE[key]


def fmt_bytes(value):
    return "{:,}".format(value) + " B"


class Report:
    def __init__(self, root):
        self.root = root
        self.items = []
        self.hashes = []
        self.missing = []

    def _add(self, item_id, label, status, detail, paths=(), missing=False):
        item = {
            "id": item_id,
            "label": label,
            "status": status,
            "detail": detail,
            "paths": [p for p in paths],
        }
        self.items.append(item)
        if status == "FAIL" and missing:
            self.missing.append(item_id)
        return item

    def ok(self, item_id, label, detail, paths=()):
        return self._add(item_id, label, "PASS", detail, paths)

    def fail(self, item_id, label, detail, paths=(), missing=False):
        return self._add(item_id, label, "FAIL", detail, paths, missing)

    def info(self, item_id, label, detail, paths=()):
        return self._add(item_id, label, "INFO", detail, paths)

    def record_hash(self, path):
        path = Path(path)
        if not path.is_file():
            return None
        data = path.read_bytes()
        entry = {
            "path": rel(path),
            "bytes": len(data),
            "sha256": sha256_bytes(data),
        }
        self.hashes.append(entry)
        return entry

    @property
    def failed(self):
        return [i for i in self.items if i["status"] == "FAIL"]

    @property
    def counts(self):
        out = {"PASS": 0, "FAIL": 0, "INFO": 0}
        for item in self.items:
            out[item["status"]] += 1
        return out


def check_library(report):
    item = "library"
    label = "wasm module and glue (as run_e1_poc.ps1 requires)"
    mjs = WORK / "module" / "e1_drive.mjs"
    wasm = WORK / "module" / "e1_drive.wasm"
    build_file = WORK / "module" / "build.json"
    paths = [rel(mjs), rel(wasm), rel(build_file)]
    missing = [rel(p) for p in (mjs, wasm) if not p.is_file()]
    if missing:
        return report.fail(item, label, "missing " + ", ".join(missing), missing, True)

    problems = []
    text = mjs.read_text(encoding="utf-8", errors="replace")
    referenced = re.findall(r'"([A-Za-z0-9_.-]+\.wasm)"', text)
    if not referenced:
        problems.append("glue does not name a .wasm file")
    for name in sorted(set(referenced)):
        sibling = mjs.parent / name
        if not sibling.is_file():
            problems.append("glue loads " + name + " but that file is missing")
    if "export default" not in text:
        problems.append("glue has no default export (not the ES module build)")

    wasm_bytes = wasm.read_bytes()
    if wasm_bytes[:4] != b"\x00asm" or struct.unpack("<I", wasm_bytes[4:8])[0] != 1:
        problems.append("wasm header is not version 1")

    detail = rel(wasm) + " " + fmt_bytes(len(wasm_bytes))
    if build_file.is_file():
        build = load_json(build_file)
        if build.get("wasmBytes") != len(wasm_bytes):
            problems.append(
                "wasm size {:,} != build.json wasmBytes {:,}".format(len(wasm_bytes), build.get("wasmBytes") or 0)
            )
        actual = sha256_bytes(wasm_bytes)
        if actual.split(":")[1] != build.get("wasmSha256"):
            problems.append("wasm sha256 != build.json wasmSha256")
        detail += ", sha256 " + actual.split(":")[1][:16] + "..., " + str(build.get("objects")) + " objects"
        if build.get("buildDeterministic") is not True:
            problems.append("build.json does not record a deterministic build")
        for name in sorted(set(referenced)):
            sibling = mjs.parent / name
            if sibling.is_file() and sha256_file(sibling) != actual:
                problems.append(name + " differs from e1_drive.wasm")
        a = WORK / "module" / "e1_drive_a.wasm"
        b = WORK / "module" / "e1_drive_b.wasm"
        if a.is_file() and b.is_file():
            if sha256_file(a) != sha256_file(b) or sha256_file(a) != actual:
                problems.append("module_a/module_b wasm differ from e1_drive.wasm")
            else:
                detail += ", rebuild A/B identical"
    else:
        problems.append("missing module/build.json (wasm hash cannot be checked)")

    if problems:
        return report.fail(item, label, "; ".join(problems), paths)
    return report.ok(item, label, detail, paths)


def check_geometry_document(report):
    item = "geometry"
    label = "geometry.json document (level + track visual + 5 car bodies)"
    path = WORK / "geometry.json"
    if not path.is_file():
        return report.fail(item, label, "missing " + rel(path), [rel(path)], True)
    try:
        doc = load_json(path)
    except Exception as exc:  # noqa: BLE001 - report instead of crashing
        return report.fail(item, label, "unreadable JSON: " + str(exc), [rel(path)])

    problems = []
    if doc.get("kind") != "e1-drive.geometry":
        problems.append("kind is not e1-drive.geometry")
    version = doc.get("version")
    if not isinstance(version, int) or version < 5:
        problems.append("unexpected geometry version " + repr(version))

    track = doc.get("trackVisual") or {}
    expected_track = {"drawCount": 394, "vertexCount": 96494, "triangleCount": 57133, "texturedDrawCount": 297}
    for key, want in expected_track.items():
        if track.get(key) != want:
            problems.append("trackVisual." + key + " " + repr(track.get(key)) + " != " + str(want))

    meshes = doc.get("meshes") or []
    mesh_ids = {m.get("id"): m for m in meshes}
    if len(meshes) != 2:
        problems.append("meshes[] has " + str(len(meshes)) + " entries, expected 2 (level + track visual)")
    if track.get("meshId") not in mesh_ids:
        problems.append("track visual mesh " + repr(track.get("meshId")) + " is not in meshes[]")
    if len(doc.get("levelDraws") or []) != 22:
        problems.append("levelDraws count " + str(len(doc.get("levelDraws") or [])) + " != 22")

    collision = doc.get("collisionSurface") or {}
    if collision.get("visible") is not False or collision.get("physicsOnly") is not True:
        problems.append("collisionSurface is not labelled visible:false/physicsOnly:true")
    if not collision.get("triangleCount"):
        problems.append("collisionSurface has no triangles")

    bodies = doc.get("carBodies") or {}
    for car in CARS:
        body = bodies.get(car["slug"])
        if not body:
            problems.append("carBodies is missing " + car["slug"])
            continue
        mesh = body.get("mesh") or {}
        if mesh.get("vertexCount", 0) <= 0 or mesh.get("indexCount", 0) <= 0:
            problems.append(car["slug"] + " body mesh has no vertices/indices")
        if len(body.get("carNodes") or []) != 9:
            problems.append(car["slug"] + " carNodes " + str(len(body.get("carNodes") or [])) + " != 9")
        if len(body.get("wheelGroups") or []) != 4:
            problems.append(car["slug"] + " wheelGroups " + str(len(body.get("wheelGroups") or [])) + " != 4")

    if problems:
        return report.fail(item, label, "; ".join(problems), [rel(path)])
    return report.ok(
        item,
        label,
        "v{} {} draws, {} verts / {} tris track, 5 bodies, {} B".format(
            version, track.get("drawCount"), track.get("vertexCount"),
            track.get("triangleCount"), path.stat().st_size),
        [rel(path)],
    )


def _packed_hashes(mesh):
    positions = mesh.get("positions") or []
    indices = mesh.get("indices") or []
    if len(positions) % 3 != 0:
        return None, None
    pos_bytes = struct.pack("<{}f".format(len(positions)), *positions)
    idx_bytes = struct.pack("<{}I".format(len(indices)), *indices) if indices else b""
    return sha256_bytes(pos_bytes), (sha256_bytes(idx_bytes) if idx_bytes else None)


def check_geometry_payloads(report):
    item = "geometry-payload"
    label = "geometry mesh payloads and embedded UV streams"
    path = WORK / "geometry.json"
    if not path.is_file():
        return report.fail(item, label, "missing " + rel(path), [rel(path)], True)
    try:
        doc = load_json(path)
    except Exception as exc:  # noqa: BLE001
        return report.fail(item, label, "unreadable JSON: " + str(exc), [rel(path)])

    problems = []
    checked = 0
    targets = []
    for mesh in doc.get("meshes") or []:
        targets.append(("mesh:" + str(mesh.get("id")), mesh))
    for slug, body in (doc.get("carBodies") or {}).items():
        targets.append(("car:" + slug, body.get("mesh") or {}))

    for name, mesh in targets:
        vertex_count = mesh.get("vertexCount")
        index_count = mesh.get("indexCount")
        positions = mesh.get("positions") or []
        indices = mesh.get("indices") or []
        if vertex_count != len(positions) // 3:
            problems.append(name + " vertexCount != positions/3")
        if index_count != len(indices):
            problems.append(name + " indexCount != indices length")
        pos_sha, idx_sha = _packed_hashes(mesh)
        if pos_sha is None:
            problems.append(name + " positions length is not a multiple of 3")
        elif pos_sha != mesh.get("positionsSha256"):
            problems.append(name + " positionsSha256 mismatch")
        if idx_sha and idx_sha != mesh.get("indicesSha256"):
            problems.append(name + " indicesSha256 mismatch")
        uv = mesh.get("uv")
        if isinstance(uv, dict) and uv.get("data"):
            try:
                data = base64.b64decode(uv["data"], validate=True)
            except Exception:  # noqa: BLE001
                problems.append(name + " uv data is not base64")
                continue
            if len(data) != uv.get("bytes"):
                problems.append(name + " uv bytes != decoded length")
            if sha256_bytes(data) != uv.get("sha256"):
                problems.append(name + " uv sha256 mismatch")
            if uv.get("vertexCount") != vertex_count:
                problems.append(name + " uv vertexCount != mesh vertexCount")
        checked += 1

    if problems:
        return report.fail(item, label, "; ".join(problems), [rel(path)])
    return report.ok(item, label, str(checked) + " meshes: vertex/index counts and pinned sha256 match", [rel(path)])


def _check_texture_files(report, item, label, records, expect_bytes):
    problems = []
    total = 0
    seen = set()
    for record in records:
        rgba = record.get("rgbaPath")
        if not rgba:
            problems.append(str(record.get("id") or record.get("name")) + ": no rgbaPath")
            continue
        file_path = ROOT / rgba
        if not file_path.is_file():
            problems.append(rel(file_path) + ": missing")
            continue
        data = file_path.read_bytes()
        if record.get("rgbaBytes") not in (None, len(data)):
            problems.append(rel(file_path) + ": size {:,} != {:,}".format(len(data), record.get("rgbaBytes")))
        expected = record.get("rgbaSha256")
        if expected and sha256_bytes(data) != expected:
            problems.append(rel(file_path) + ": sha256 mismatch")
        total += len(data)
        seen.add(rel(file_path))
    if expect_bytes is not None and total != expect_bytes:
        problems.append("RGBA total {:,} B != {:,} B".format(total, expect_bytes))
    if problems:
        return report.fail(item, label, "; ".join(problems[:6]) + (" (+{} more)".format(len(problems) - 6) if len(problems) > 6 else ""))
    return report.ok(item, label, "{:,} files / {:,} B, sizes and sha256 match the manifest".format(len(seen), total))


def check_textures(report):
    geometry_path = WORK / "geometry.json"
    if not geometry_path.is_file():
        return report.fail("textures", "textures and UV streams", "missing " + rel(geometry_path), [rel(geometry_path)], True)
    try:
        geometry = load_json(geometry_path)
    except Exception as exc:  # noqa: BLE001
        return report.fail("textures", "textures and UV streams", "geometry.json unreadable: " + str(exc), [rel(geometry_path)])

    track_manifest = WORK / "track-textures.json"
    car_manifest = WORK / "car-textures.json"

    # 1. track manifest pin and document
    pack = geometry.get("texturePack") or {}
    if not track_manifest.is_file():
        report.fail("track-manifest", "track texture manifest", "missing " + rel(track_manifest), [rel(track_manifest)], True)
        track_doc = None
    else:
        actual = sha256_file(track_manifest)
        problems = []
        if pack.get("manifestSha256") != actual:
            problems.append("geometry.texturePack.manifestSha256 != " + actual)
        try:
            track_doc = load_json(track_manifest)
        except Exception as exc:  # noqa: BLE001
            track_doc = None
            problems.append("unreadable JSON: " + str(exc))
        coverage = (track_doc or {}).get("coverage") or {}
        if track_doc is not None:
            if track_doc.get("kind") != "e1-drive.track-textures":
                problems.append("kind is not e1-drive.track-textures")
            if coverage.get("trackDraws") != 394 or coverage.get("texturedDraws") != 297:
                problems.append("coverage is not 394 draws / 297 textured")
            if coverage.get("fallbackDraws") != 97:
                problems.append("fallbackDraws " + repr(coverage.get("fallbackDraws")) + " != 97")
            if len(track_doc.get("textures") or []) != 136:
                problems.append("texture count != 136")
            sampler = track_doc.get("sampler") or {}
            if sampler.get("textureFormat") != "rgba8unorm":
                problems.append("sampler format is not rgba8unorm")
        if problems:
            report.fail("track-manifest", "track texture manifest", "; ".join(problems), [rel(track_manifest)])
        else:
            report.ok("track-manifest", "track texture manifest",
                      "394 draws / 297 textured / 97 diagnostic / 136 textures, pin matches geometry",
                      [rel(track_manifest)])

    # 2. car manifest pin and document
    car_pack = geometry.get("carTextures") or {}
    if not car_manifest.is_file():
        report.fail("car-manifest", "car texture manifest", "missing " + rel(car_manifest), [rel(car_manifest)], True)
        car_doc = None
    else:
        actual = sha256_file(car_manifest)
        problems = []
        if car_pack.get("manifestSha256") != actual:
            problems.append("geometry.carTextures.manifestSha256 != " + actual)
        try:
            car_doc = load_json(car_manifest)
        except Exception as exc:  # noqa: BLE001
            car_doc = None
            problems.append("unreadable JSON: " + str(exc))
        if car_doc is not None:
            totals = car_doc.get("totals") or {}
            if car_doc.get("kind") != "e1-drive.car-textures":
                problems.append("kind is not e1-drive.car-textures")
            if totals.get("cars") != 5 or totals.get("draws") != 491:
                problems.append("totals are not 5 cars / 491 draws")
            if totals.get("staticAlbedoDraws") != 224 or totals.get("textures") != 40:
                problems.append("totals are not 224 textured draws / 40 textures")
            if len(car_doc.get("cars") or []) != 5:
                problems.append("per-car list != 5")
        if problems:
            report.fail("car-manifest", "car texture manifest", "; ".join(problems), [rel(car_manifest)])
        else:
            report.ok("car-manifest", "car texture manifest",
                      "5 cars / 491 draws / 224 textured / 40 textures, pin matches geometry",
                      [rel(car_manifest)])

    # 3. track UV stream
    track_uv_entry = pack.get("uvStream") or {}
    track_uv = WORK / "track-uv.bin"
    if not track_uv.is_file():
        report.fail("track-uv", "track UV0 stream", "missing " + rel(track_uv), [rel(track_uv)], True)
    else:
        data = track_uv.read_bytes()
        problems = []
        if track_uv_entry.get("bytes") not in (None, len(data)):
            problems.append("size {:,} != {:,}".format(len(data), track_uv_entry.get("bytes")))
        if track_uv_entry.get("sha256") and sha256_bytes(data) != track_uv_entry["sha256"]:
            problems.append("sha256 != geometry.texturePack.uvStream.sha256")
        if track_uv_entry.get("vertexCount") != 96494:
            problems.append("vertexCount != 96494")
        if problems:
            report.fail("track-uv", "track UV0 stream", "; ".join(problems), [rel(track_uv)])
        else:
            report.ok("track-uv", "track UV0 stream",
                      "{:,} B, {:,.0f} UV values, sha256 matches".format(len(data), len(data) / 4), [rel(track_uv)])

    # 4. track RGBA files
    if track_doc is not None:
        _check_texture_files(report, "track-textures", "track RGBA bitmaps",
                             track_doc.get("textures") or [], 439360)
    else:
        report.fail("track-textures", "track RGBA bitmaps", "manifest unavailable", [rel(track_manifest)])

    # 5. car UV streams + RGBA files
    if car_doc is None:
        report.fail("car-uv", "car UV0 streams", "manifest unavailable", [rel(car_manifest)])
        report.fail("car-textures", "car RGBA bitmaps", "manifest unavailable", [rel(car_manifest)])
        return

    problems = []
    uv_total = 0
    uv_files = 0
    uv_paths = []
    for entry in car_doc.get("cars") or []:
        stream = entry.get("uvStream") or {}
        uv_path = ROOT / str(stream.get("path") or "")
        if not stream.get("path") or not uv_path.is_file():
            problems.append(str(stream.get("path") or entry.get("slug")) + ": missing")
            continue
        uv_paths.append(rel(uv_path))
        data = uv_path.read_bytes()
        if stream.get("bytes") not in (None, len(data)):
            problems.append(rel(uv_path) + ": size != " + str(stream.get("bytes")))
        if stream.get("sha256") and sha256_bytes(data) != stream["sha256"]:
            problems.append(rel(uv_path) + ": sha256 mismatch")
        if stream.get("vertexCount") and len(data) != stream["vertexCount"] * 8:
            problems.append(rel(uv_path) + ": byte count != vertexCount * 8")
        uv_total += len(data)
        uv_files += 1
    if problems:
        report.fail("car-uv", "car UV0 streams", "; ".join(problems), uv_paths)
    else:
        report.ok("car-uv", "car UV0 streams",
                  "{:,} files / {:,} B, sizes and sha256 match the manifest".format(uv_files, uv_total))

    car_textures = []
    for entry in car_doc.get("cars") or []:
        car_textures.extend(entry.get("textures") or [])
    _check_texture_files(report, "car-textures", "car RGBA bitmaps", car_textures, 18178048)


def check_levelphysics(report):
    item = "levelphysics"
    label = "Level.levelphysics collision file"
    path = WORK / "Level.levelphysics"
    if not path.is_file():
        return report.fail(item, label, "missing " + rel(path), [rel(path)], True)
    data = path.read_bytes()
    problems = []
    if data[: len(LEVEL_MAGIC)] != LEVEL_MAGIC:
        problems.append("header does not start with " + repr(LEVEL_MAGIC))
    pinned = None
    geometry_path = WORK / "geometry.json"
    if geometry_path.is_file():
        try:
            source = (load_json(geometry_path).get("collisionSurface") or {}).get("source") or {}
            if str(source.get("file", "")).endswith("Level.levelphysics"):
                pinned = source.get("sha256")
        except Exception:  # noqa: BLE001 - geometry document check reports it
            pinned = None
    actual = sha256_bytes(data)
    if pinned:
        if not pin_is(pinned, data):
            problems.append("sha256 != geometry.collisionSurface.source.sha256")
        detail = fmt_bytes(len(data)) + ", sha256 matches the pinned collision source"
    else:
        detail = fmt_bytes(len(data)) + ", sha256 " + actual.split(":")[1][:16] + "... (no pin found)"
    if problems:
        return report.fail(item, label, "; ".join(problems), [rel(path)])
    return report.ok(item, label, detail, [rel(path)])


def check_spawn(report):
    item = "spawn"
    label = "spawn.json"
    path = WORK / "spawn.json"
    if not path.is_file():
        return report.fail(item, label, "missing " + rel(path), [rel(path)], True)
    try:
        spawn = load_json(path)
    except Exception as exc:  # noqa: BLE001
        return report.fail(item, label, "unreadable JSON: " + str(exc), [rel(path)])
    problems = []
    if spawn.get("x") != -88 or spawn.get("z") != 1050:
        problems.append("spawn point is not (-88, 1050)")
    heading = spawn.get("heading")
    if not isinstance(heading, (int, float)) or abs(heading - 1.5707963267948966) > 1e-9:
        problems.append("heading is not the committed pi/2")
    sprint = WORK / "sprint.json"
    if sprint.is_file():
        try:
            course = load_json(sprint).get("course") or {}
            course_spawn = course.get("spawn") or {}
            if course_spawn.get("x") != spawn.get("x") or course_spawn.get("z") != spawn.get("z"):
                problems.append("sprint.json course.spawn differs from spawn.json")
        except Exception:  # noqa: BLE001
            pass
    if problems:
        return report.fail(item, label, "; ".join(problems), [rel(path)])
    return report.ok(item, label, "({}, {}) heading {:.6f}".format(spawn.get("x"), spawn.get("z"), heading), [rel(path)])


def _gate_problems(layout, expected):
    problems = []
    gates = layout.get("gates") or []
    if len(gates) != len(expected):
        return ["gate count " + str(len(gates)) + " != " + str(len(expected))]
    for gate, want in zip(gates, expected):
        kind, index, arc, x, z, heading = want
        name = "gate " + str(index) + " (" + kind + ")"
        if gate.get("kind") != kind or gate.get("index") != index:
            problems.append(name + " kind/index mismatch")
        if abs((gate.get("arc") or 0) - arc) > 1e-5:
            problems.append(name + " arc " + repr(gate.get("arc")))
        if abs((gate.get("x") or 0) - x) > 5e-4 or abs((gate.get("z") or 0) - z) > 5e-4:
            problems.append(name + " point (" + repr(gate.get("x")) + ", " + repr(gate.get("z")) + ")")
        if abs((gate.get("headingRad") or 0) - heading) > 1e-4:
            problems.append(name + " heading " + repr(gate.get("headingRad")))
        if gate.get("widthMetres") != 6:
            problems.append(name + " width " + repr(gate.get("widthMetres")))
        coverage = gate.get("coverage") or {}
        if coverage.get("drawnSamples") != 61 or coverage.get("collisionSamples") != 61:
            problems.append(name + " coverage is not 61/61 drawn + 61/61 collision")
        if coverage.get("covered") is not True:
            problems.append(name + " is not covered")
    return problems


def check_sprint_310(report):
    item = "sprint-310"
    label = "sprint.json (default 310 m P48 course)"
    path = WORK / "sprint.json"
    if not path.is_file():
        return report.fail(item, label, "missing " + rel(path), [rel(path)], True), None
    try:
        layout = load_json(path)
    except Exception as exc:  # noqa: BLE001
        return report.fail(item, label, "unreadable JSON: " + str(exc), [rel(path)]), None

    problems = []
    if layout.get("kind") != "e1-drive.sprint":
        problems.append("kind is not e1-drive.sprint")
    if layout.get("courseId") != "310m":
        problems.append("courseId is not 310m")
    course = layout.get("course") or {}
    span = course.get("span") or {}
    if abs((course.get("lengthMetres") or 0) - 310.395196) > 1e-6:
        problems.append("course length " + repr(course.get("lengthMetres")))
    if course.get("sampleCount") != 1245 or course.get("sampleStepMetres") != 0.25:
        problems.append("course is not 1,245 samples at 0.25 m")
    if abs((course.get("finishArc") or 0) - 300.159666) > 1e-6:
        problems.append("finish arc " + repr(course.get("finishArc")))
    if abs((span.get("measuredLengthMetres") or 0) - 310.395196) > 1e-6:
        problems.append("span.measuredLengthMetres is not 310.395196")
    clearance = (span.get("measuredLengthMetres") or 0) - (course.get("finishArc") or 0)
    if abs(clearance - 10.2355) > 1e-3:
        problems.append("finish clearance {:.4f} m != 10.2355 m".format(clearance))
    coverage = course.get("coverage") or {}
    if coverage.get("samples") != 1204 or coverage.get("coveredSamples") != 1204:
        problems.append("course coverage is not 1,204/1,204")
    if coverage.get("gaps"):
        problems.append("course has coverage gaps")

    problems.extend(_gate_problems(layout, EXPECTED_310_GATES))

    source = layout.get("source") or {}
    geometry_path = WORK / "geometry.json"
    if geometry_path.is_file():
        try:
            geometry = load_json(geometry_path)
            if source.get("geometryVersion") != geometry.get("version"):
                problems.append("source.geometryVersion != geometry.version")
            if source.get("trackVisual") != (geometry.get("trackVisual") or {}).get("label"):
                problems.append("source.trackVisual != geometry track label")
        except Exception:  # noqa: BLE001
            pass

    digest = layout.get("hash") or ""
    if not digest.startswith("sha256:") or len(digest) != 71:
        problems.append("layout hash is not a sha256")

    if problems:
        return report.fail(item, label, "; ".join(problems), [rel(path)]), layout
    return report.ok(
        item, label,
        "310.395 m / 1,245 samples, finish arc 300.160 m (10.24 m clearance), 4 gates 61/61, hash "
        + digest.split(":")[1][:16] + "...",
        [rel(path)],
    ), layout


def check_per_car(report, layout, expected_key, file_prefix, tag, label):
    item = "runs-" + tag
    hashes = []
    problems = []
    summary = []
    if layout is None:
        return report.fail(item, label, "layout unavailable", [])
    layout_hash = layout.get("hash")
    for car in CARS:
        name = file_prefix + car["slug"] + ".json"
        path = WORK / name
        if not path.is_file():
            problems.append(rel(path) + ": missing")
            continue
        try:
            run = load_json(path)
        except Exception as exc:  # noqa: BLE001
            problems.append(rel(path) + ": unreadable JSON (" + str(exc) + ")")
            continue
        finish = run.get("finish") or {}
        time_s = finish.get("timeSeconds")
        if not finish or finish.get("type") != "finish":
            problems.append(rel(path) + ": no finish event")
            continue
        if abs(float(time_s) - car[expected_key]) > 1e-3:
            problems.append(rel(path) + ": finish {:.3f} s != expected {:.3f} s".format(time_s, car[expected_key]))
        if finish.get("checkpoints") != 2 or len(run.get("checkpoints") or []) != 2:
            problems.append(rel(path) + ": did not cross 2 checkpoints")
        if run.get("respawns"):
            problems.append(rel(path) + ": " + str(len(run["respawns"])) + " respawn(s)")
        if run.get("layoutHash") != layout_hash:
            problems.append(rel(path) + ": layoutHash != current layout hash")
        if (run.get("car") or {}).get("slug") != car["slug"]:
            problems.append(rel(path) + ": car.slug mismatch")
        if not str(run.get("stateSequenceHash") or "").startswith("sha256:"):
            problems.append(rel(path) + ": no state sequence hash")
        hashes.append(rel(path))
        summary.append(car["slug"].replace("-stock", "") + " {:.3f}s".format(float(time_s)))

    if problems:
        return report.fail(item, label, "; ".join(problems), hashes)
    return report.ok(item, label, ", ".join(summary), hashes)


def check_sprint_short(report):
    item = "sprint-short"
    label = "sprint-short.json (29 m regression course)"
    path = WORK / "sprint-short.json"
    if not path.is_file():
        return report.fail(item, label, "missing " + rel(path), [rel(path)], True), None
    try:
        layout = load_json(path)
    except Exception as exc:  # noqa: BLE001
        return report.fail(item, label, "unreadable JSON: " + str(exc), [rel(path)]), None
    problems = []
    if layout.get("courseId") != "short":
        problems.append("courseId is not short")
    gates = layout.get("gates") or []
    if [g.get("kind") for g in gates] != EXPECTED_SHORT_KINDS:
        problems.append("gate kinds are not start/checkpoint/checkpoint/finish")
    if len(gates) == 4:
        for gate, x in zip(gates, EXPECTED_SHORT_X):
            if abs((gate.get("x") or 0) - x) > 1e-6:
                problems.append("gate " + str(gate.get("index")) + " x " + repr(gate.get("x")) + " != " + str(x))
            if gate.get("widthMetres") != 6:
                problems.append("gate " + str(gate.get("index")) + " width != 6 m")
            coverage = gate.get("coverage") or {}
            if coverage.get("drawnSamples") != 61 or coverage.get("collisionSamples") != 61:
                problems.append("gate " + str(gate.get("index")) + " coverage is not 61/61")
    digest = layout.get("hash") or ""
    if not digest.startswith("sha256:"):
        problems.append("layout hash is not a sha256")
    if problems:
        return report.fail(item, label, "; ".join(problems), [rel(path)]), layout
    return report.ok(item, label, "29 m, 4 gates 61/61, hash " + digest.split(":")[1][:16] + "...", [rel(path)]), layout


def check_roster(report):
    item = "roster"
    label = "cars.json roster (62 records, 5 selected)"
    path = WORK / "cars.json"
    if not path.is_file():
        return report.fail(item, label, "missing " + rel(path), [rel(path)], True), None
    try:
        doc = load_json(path)
    except Exception as exc:  # noqa: BLE001
        return report.fail(item, label, "unreadable JSON: " + str(exc), [rel(path)]), None

    problems = []
    if doc.get("kind") != "e1-drive.car-roster":
        problems.append("kind is not e1-drive.car-roster")
    if doc.get("status") != "PASS":
        problems.append("status is " + repr(doc.get("status")))
    if doc.get("failures"):
        problems.append("gate failures recorded")
    counts = doc.get("counts") or {}
    if counts.get("records") != 62 or counts.get("gatePass") != 62 or counts.get("gateFail") != 0:
        problems.append("counts are not 62 records / 62 pass / 0 fail")
    if counts.get("selected") != 5:
        problems.append("selected count != 5")
    roster = doc.get("roster") or {}
    if roster.get("default") != "corvette-zr1-stock":
        problems.append("roster default is not corvette-zr1-stock")
    entries = {entry.get("slug"): entry for entry in roster.get("cars") or []}
    for car in CARS:
        entry = entries.get(car["slug"])
        if not entry:
            problems.append("roster is missing " + car["slug"])
            continue
        record = entry.get("record") or {}
        if record.get("index") != car["record_index"] or record.get("id") != car["record_id"]:
            problems.append(car["slug"] + " record index/id mismatch")
        if record.get("name") != car["name"] or entry.get("name") != car["name"]:
            problems.append(car["slug"] + " name mismatch")
        if entry.get("drivetrain") != car["drivetrain"]:
            problems.append(car["slug"] + " drivetrain mismatch")
        values = entry.get("values") or {}
        if abs(float(values.get("mass") or 0) - car["mass"]) > 1e-3:
            problems.append(car["slug"] + " mass mismatch")
        if not (entry.get("fields") or {}).get("path"):
            problems.append(car["slug"] + " has no fields path")
    if problems:
        return report.fail(item, label, "; ".join(problems), [rel(path)]), doc
    return report.ok(item, label, "62/62 gated, 5 selected, default corvette-zr1-stock", [rel(path)]), doc


def check_fields(report, roster):
    item = "car-fields"
    label = "per-car .fields lists (the e1_create car selector)"
    if roster is None:
        return report.fail(item, label, "cars.json unavailable", [])
    entries = {entry.get("slug"): entry for entry in (roster.get("roster") or {}).get("cars") or []}
    problems = []
    summary = []
    paths = []
    for car in CARS:
        entry = entries.get(car["slug"])
        if not entry:
            problems.append(car["slug"] + ": not in cars.json roster")
            continue
        info = entry.get("fields") or {}
        fields_path = ROOT / str(info.get("path") or "")
        paths.append(rel(fields_path))
        if not fields_path.is_file():
            problems.append(rel(fields_path) + ": missing")
            continue
        data = fields_path.read_bytes()
        if info.get("bytes") not in (None, len(data)):
            problems.append(rel(fields_path) + ": size {:,} != {:,}".format(len(data), info.get("bytes")))
        if info.get("sha256") and not pin_is(info["sha256"], data):
            problems.append(rel(fields_path) + ": sha256 != cars.json pin")
        lines = [line for line in data.decode("utf-8", errors="replace").splitlines() if line]
        if entry.get("fieldLines") is not None and len(lines) != entry["fieldLines"]:
            problems.append(rel(fields_path) + ": " + str(len(lines)) + " lines != fieldLines " + str(entry["fieldLines"]))
        if not lines or lines[0] != "record.name\t" + car["name"]:
            problems.append(rel(fields_path) + ": first line is not record.name\\t" + car["name"])
        summary.append(car["slug"] + " " + fmt_bytes(len(data)))
    if problems:
        return report.fail(item, label, "; ".join(problems), paths)
    return report.ok(item, label, "; ".join(summary), paths)


def check_web(report):
    item = "web"
    label = "page sources served at http://127.0.0.1:8801/"
    missing = []
    for name in WEB_FILES:
        if not (ROOT / name).is_file():
            missing.append(name)
    index = ROOT / "probes/e1-drive/web/index.html"
    problems = list(missing)
    if index.is_file():
        text = index.read_text(encoding="utf-8", errors="replace")
        if 'id="scene"' not in text:
            problems.append("index.html has no #scene canvas")
        if "./app.js" not in text:
            problems.append("index.html does not load ./app.js")
    if problems:
        return report.fail(item, label, "missing/invalid: " + ", ".join(problems), missing or [rel(index)])
    return report.ok(item, label, str(len(WEB_FILES)) + " files present, index loads ./app.js", [rel(index)])


def _http_get(url, timeout=1.0):
    request = urllib.request.Request(url, headers={"cache-control": "no-store"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.headers.get("content-type", ""), response.read()


def _http_head(url, size=64, timeout=1.0):
    """Read only the first `size` bytes so a 45 MB file is not downloaded."""
    request = urllib.request.Request(url, headers={"cache-control": "no-store"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.headers.get("content-type", ""), response.read(size)


def check_server(report):
    item = "server"
    label = "static server on 127.0.0.1:8801"
    try:
        status, _content_type, body = _http_get(SERVER + "/", timeout=0.4)
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as exc:
        reason = getattr(exc, "reason", exc)
        return report.info(item, label, "not running (" + str(reason) + "); start it with tools/run_e1_poc.ps1")

    index = ROOT / "probes/e1-drive/web/index.html"
    problems = []
    if status != 200:
        problems.append("index HTTP " + str(status))
    if b'id="scene"' not in body or b"./app.js" not in body:
        problems.append("index body is not the E1 page")
    if index.is_file() and body != index.read_bytes():
        problems.append("served index.html differs from probes/e1-drive/web/index.html")

    probes = [
        ("/_work/e1-drive/module/e1_drive.mjs", WORK / "module" / "e1_drive.mjs"),
        ("/_work/e1-drive/module/e1_drive.wasm", WORK / "module" / "e1_drive.wasm"),
        ("/_work/e1-drive/cars.json", WORK / "cars.json"),
        ("/_work/e1-drive/spawn.json", WORK / "spawn.json"),
        ("/_work/e1-drive/sprint.json", WORK / "sprint.json"),
        ("/_work/e1-drive/sprint-short.json", WORK / "sprint-short.json"),
    ]
    for url, local in probes:
        if not local.is_file():
            problems.append(rel(local) + ": local file missing")
            continue
        try:
            http_status, _content_type, payload = _http_get(SERVER + url, timeout=1.0)
        except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as exc:
            problems.append(url + ": " + str(getattr(exc, "reason", exc)))
            continue
        if http_status != 200:
            problems.append(url + ": HTTP " + str(http_status))
        elif payload != local.read_bytes():
            problems.append(url + ": served bytes differ from " + rel(local))

    # geometry + level are large: check the first bytes and the content type only
    for url, local, head in [
        ("/_work/e1-drive/geometry.json", WORK / "geometry.json", b'{"kind"'),
        ("/_work/e1-drive/Level.levelphysics", WORK / "Level.levelphysics", LEVEL_MAGIC),
    ]:
        if not local.is_file():
            problems.append(rel(local) + ": local file missing")
            continue
        try:
            http_status, content_type, payload = _http_head(SERVER + url, timeout=2.0)
        except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as exc:
            problems.append(url + ": " + str(getattr(exc, "reason", exc)))
            continue
        if http_status != 200:
            problems.append(url + ": HTTP " + str(http_status))
        elif not payload.startswith(head):
            problems.append(url + ": unexpected content start")
        elif url.endswith(".json") and "application/json" not in content_type:
            problems.append(url + ": content-type is " + repr(content_type))

    if problems:
        return report.fail(item, label, "; ".join(problems), [SERVER + "/"])
    return report.ok(item, label,
                     "index + 8 artifacts served, bytes match the local files", [SERVER + "/"])


LAP_EXPECTED = {
    "corvette-zr1-stock": 86.100,
    "lotus-exige-cup260-stock": 86.283333,
    "dodge-challenger-stock": 86.116667,
    "ford-focusrs-stock": 86.250,
    "audi-r8v10-stock": 85.466667,
}
LAP_LENGTH = 222.040211
LAP_SPAWN = (115.5, 1164.0, 1.638873)
LAP_HASH = "sha256:167643a9a108bc927d093da2b3d1408d639c1cc4110920511455b68c68ad1f91"


def check_sprint_lap(report):
    item = "sprint-lap"
    label = "sprint-lap.json (P61 loop-01 3-lap race)"
    path = WORK / "sprint-lap.json"
    if not path.is_file():
        return report.fail(item, label, "missing " + rel(path), [rel(path)], True), None
    try:
        layout = load_json(path)
    except Exception as exc:  # noqa: BLE001
        return report.fail(item, label, "unreadable JSON: " + str(exc), [rel(path)]), None

    problems = []
    if layout.get("kind") != "e1-drive.sprint":
        problems.append("kind is not e1-drive.sprint")
    if layout.get("courseId") != "lap":
        problems.append("courseId is not lap")
    course = layout.get("course") or {}
    if abs((course.get("lengthMetres") or 0) - LAP_LENGTH) > 1e-6:
        problems.append("course length " + repr(course.get("lengthMetres")))
    if course.get("sampleCount") != 902 or course.get("sampleStepMetres") != 0.25:
        problems.append("course is not 902 samples at 0.25 m")
    if (course.get("laps") or 0) != 3:
        problems.append("course is not 3 laps")
    spawn = course.get("spawn") or {}
    if abs((spawn.get("x") or 0) - LAP_SPAWN[0]) > 1e-9 or abs((spawn.get("z") or 0) - LAP_SPAWN[1]) > 1e-9:
        problems.append("lap spawn is not (115.5, 1164.0)")
    if abs((spawn.get("headingRad") or 0) - LAP_SPAWN[2]) > 1e-6:
        problems.append("lap spawn heading " + repr(spawn.get("headingRad")))
    coverage = course.get("coverage") or {}
    if coverage.get("samples") != 902 or coverage.get("coveredSamples") != 902:
        problems.append("lap centreline coverage is not 902/902")
    if coverage.get("gaps"):
        problems.append("lap centreline has coverage gaps")
    band = coverage.get("band") or {}
    if (band.get("drawnSamples") or 0) < 6286:
        problems.append("lap band coverage " + str(band.get("drawnSamples")) + " < 6286")
    gates = layout.get("gates") or []
    if len(gates) != 2:
        problems.append("lap gate count " + str(len(gates)) + " != 2")
    else:
        for gate, want_arc, kind in ((gates[0], 0.0, "start"), (gates[1], LAP_LENGTH, "finish")):
            if gate.get("kind") != kind:
                problems.append("lap gate " + kind + " kind mismatch")
            if abs((gate.get("arc") or 0) - want_arc) > 1e-6:
                problems.append("lap gate " + kind + " arc " + repr(gate.get("arc")))
            if abs((gate.get("x") or 0) - LAP_SPAWN[0]) > 5e-4 or abs((gate.get("z") or 0) - LAP_SPAWN[1]) > 5e-4:
                problems.append("lap gate " + kind + " point")
            if gate.get("widthMetres") != 4:
                problems.append("lap gate " + kind + " width " + repr(gate.get("widthMetres")))
            line_coverage = gate.get("coverage") or {}
            if line_coverage.get("drawnSamples") != 41 or line_coverage.get("collisionSamples") != 41:
                problems.append("lap gate " + kind + " coverage is not 41/41")
            if line_coverage.get("covered") is not True:
                problems.append("lap gate " + kind + " is not covered")
    digest = layout.get("hash") or ""
    if digest != LAP_HASH:
        problems.append("lap layout hash " + digest + " != " + LAP_HASH)

    if problems:
        return report.fail(item, label, "; ".join(problems), [rel(path)]), layout
    return report.ok(
        item, label,
        "222.040 m / 902 samples, 3 laps, 4 m line 41/41, band {}/{} drawn, hash {}...".format(
            band.get("drawnSamples"), band.get("samples"), digest.split(":")[1][:16]),
        [rel(path)],
    ), layout


def check_lap_runs(report, layout):
    item = "runs-lap"
    label = "per-car 3-lap race runs (expected totals, lap order, no respawn)"
    if layout is None:
        return report.fail(item, label, "lap layout unavailable", [])
    problems = []
    summary = []
    for car in CARS:
        path = WORK / ("sprint-lap-" + car["slug"] + ".json")
        if not path.is_file():
            problems.append(rel(path) + ": missing")
            continue
        try:
            run = load_json(path)
        except Exception as exc:  # noqa: BLE001
            problems.append(rel(path) + ": unreadable JSON (" + str(exc) + ")")
            continue
        finish = run.get("finish") or {}
        expected = LAP_EXPECTED.get(car["slug"])
        if not finish or finish.get("type") != "finish":
            problems.append(rel(path) + ": no finish event")
            continue
        if expected is None or abs(float(finish.get("timeSeconds")) - expected) > 1e-3:
            problems.append(rel(path) + ": finish {:.3f} s != expected {:.3f} s".format(
                float(finish.get("timeSeconds")), expected or -1))
        laps = run.get("laps") or []
        if len(laps) != 3:
            problems.append(rel(path) + ": " + str(len(laps)) + " lap events != 3")
        else:
            if laps[0].get("type") != "lap" or laps[0].get("lap") != 1:
                problems.append(rel(path) + ": lap 1 event mismatch")
            if laps[1].get("type") != "lap" or laps[1].get("lap") != 2:
                problems.append(rel(path) + ": lap 2 event mismatch")
            if laps[2].get("type") != "finish" or laps[2].get("lap") != 3:
                problems.append(rel(path) + ": lap 3 finish event mismatch")
        lap_times = run.get("lapTimes") or []
        if len(lap_times) != 3 or any(seconds <= 1 for seconds in lap_times):
            problems.append(rel(path) + ": lapTimes is not three valid laps")
        elif abs(sum(lap_times) - float(finish.get("timeSeconds"))) > 2e-5:
            problems.append(rel(path) + ": lap times do not add up to the finish")
        if run.get("respawns"):
            problems.append(rel(path) + ": " + str(len(run["respawns"])) + " respawn(s)")
        if run.get("layoutHash") != layout.get("hash"):
            problems.append(rel(path) + ": layoutHash != current lap layout hash")
        if (run.get("car") or {}).get("slug") != car["slug"]:
            problems.append(rel(path) + ": car.slug mismatch")
        if not str(run.get("stateSequenceHash") or "").startswith("sha256:"):
            problems.append(rel(path) + ": stateSequenceHash is not a sha256")
        max_lateral = run.get("maxLateralMetres")
        if not isinstance(max_lateral, (int, float)) or max_lateral > 1.25 + 1e-9:
            problems.append(rel(path) + ": max lateral " + repr(max_lateral) + " > 1.25 m")
        if not problems:
            summary.append("{} {:.3f} s".format(car["slug"], float(finish.get("timeSeconds"))))
    if problems:
        return report.fail(item, label, "; ".join(problems), [])
    return report.ok(item, label, "5 cars, 3 laps each, no respawn: " + " / ".join(summary), [])


def run_checks():
    report = Report(ROOT)
    check_library(report)
    check_geometry_document(report)
    check_geometry_payloads(report)
    check_levelphysics(report)
    check_spawn(report)
    _item, layout = check_sprint_310(report)
    check_per_car(report, layout, "sprint310", "sprint-", "310m", "per-car 310 m sprint runs (expected finish times)")
    _item, short_layout = check_sprint_short(report)
    check_per_car(report, short_layout, "short", "sprint-short-", "short", "per-car 29 m regression runs")
    _item, lap_layout = check_sprint_lap(report)
    check_lap_runs(report, lap_layout)
    _item, roster = check_roster(report)
    check_fields(report, roster)
    check_textures(report)
    check_web(report)
    check_server(report)
    return report


def hash_targets():
    files = [
        WORK / "module" / "e1_drive.mjs",
        WORK / "module" / "e1_drive.wasm",
        WORK / "geometry.json",
        WORK / "Level.levelphysics",
        WORK / "spawn.json",
        WORK / "sprint.json",
        WORK / "sprint-short.json",
        WORK / "sprint-lap.json",
        WORK / "cars.json",
        WORK / "track-textures.json",
        WORK / "track-uv.bin",
        WORK / "car-textures.json",
    ]
    for car in CARS:
        files.append(WORK / "cars" / (car["slug"] + ".fields"))
        files.append(WORK / ("car-uv-" + car["slug"] + ".bin"))
    return files


def render_human(report, elapsed):
    counts = report.counts
    lines = []
    lines.append("E1 PoC readiness check - " + str(report.root))
    lines.append("")
    for item in report.items:
        detail = item["detail"]
        lines.append("{:<5} {} - {}".format(item["status"], item["label"], detail))
        if item["status"] == "FAIL":
            for path in item["paths"][:8]:
                lines.append("      path: " + path)
    lines.append("")
    lines.append("{} PASS, {} FAIL, {} INFO  ({:.2f} s)".format(
        counts["PASS"], counts["FAIL"], counts["INFO"], elapsed))
    if report.failed:
        lines.append("")
        lines.append("FAILED items:")
        for item in report.failed:
            lines.append("  - " + item["label"] + ": " + item["detail"])
        if report.missing:
            lines.append("  required artifacts are missing: run tools/run_e1_poc.ps1 once to see the build commands")
    else:
        lines.append("Ready: powershell -ExecutionPolicy Bypass -File tools\\run_e1_poc.ps1")
        lines.append("Open:   http://127.0.0.1:8801/")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check the E1 browser PoC artifacts (read-only).")
    parser.add_argument("--json", action="store_true", help="print a machine readable report")
    parser.add_argument("--hash", action="store_true", help="also print the artifact SHA-256 values")
    args = parser.parse_args(argv)

    started = time.perf_counter()
    report = run_checks()
    if args.hash:
        for path in hash_targets():
            report.record_hash(path)
    elapsed = time.perf_counter() - started

    exit_code = 0
    if report.missing:
        exit_code = 2
    elif report.failed:
        exit_code = 1

    if args.json:
        payload = {
            "schema": "e1-poc-readiness/1",
            "root": str(report.root),
            "ok": exit_code == 0,
            "exitCode": exit_code,
            "elapsedSeconds": round(elapsed, 3),
            "counts": report.counts,
            "missing": report.missing,
            "items": report.items,
        }
        if args.hash:
            payload["hashes"] = report.hashes
        print(json.dumps(payload, indent=2))
    else:
        print(render_human(report, elapsed))
        if args.hash:
            print("")
            print("Artifact hashes:")
            for entry in report.hashes:
                print("{}  {:>11}  {}".format(entry["sha256"], entry["bytes"], entry["path"]))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
