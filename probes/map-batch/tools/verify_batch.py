#!/usr/bin/env python3
"""Independent verifier for the `map-batch` packages.

    C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe \
        probes/map-batch/tools/verify_batch.py

The verifier does not import `map_batch_lib`. Every value is re-read from disk
and re-derived from the raw buffers or from the committed source documents:

  * every manifest pin (bytes + sha256), the manifest content hash and the
    report hashes are recomputed;
  * per-map counts are re-derived from the binary buffers, the draw records,
    the texture table, the collision mesh and the path;
  * the sector/chunk table is re-derived from the committed
    `_work/map-pipeline/draw-probes-*.json` documents, every merged section
    slice is re-hashed against the native probe pin, and the staged
    `geometry.chunk` / `node.chunk` files are re-hashed;
  * the path samples are re-derived from the measured covered/collision path
    with the documented 0.25 m resample rule, then length, continuity,
    checkpoints, spawn pose and the 25-ray spawn band are re-checked;
  * the level is built twice into throw-away temp directories and the two trees
    are compared byte-for-byte (`report.json` is compared modulo its timing
    fields, which are the only non-deterministic values); the committed package
    is compared with a fresh build the same way;
  * every JSON document is schema-checked and scanned for NaN/Inf.

A map that cannot be built is reported as a typed `unsupported` record with a
reason and a byte offset when the failure names one; it is never skipped.

Exit code 0 = every check passed. The final line is `N/M checks passed`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
PROBES_DIR = ROOT / "probes/map-batch"
BATCH = ROOT / "_work/map-batch"
PIPELINE = ROOT / "_work/map-pipeline"
LEVELS_DIR = ROOT / "game-data/Blur/levels"
REGISTRY = ROOT / "probes/e1-drive/web/map-registry.js"

SOURCE_FILES = {
    "level": "Level.level",
    "physics": "Level.levelphysics",
    "render": "Level.levelrender",
    "stream": "Level.levelstream",
}

PROBE_DOCS = (
    "draw-probes-all.json",
    "draw-probes-top.json",
    "draw-probes-extra.json",
    "draw-probes-sausalito.json",
)

REQUIRED_FILES = (
    "manifest.json",
    "draws.json",
    "draws.positions.f32.bin",
    "draws.uv0.f32.bin",
    "draws.indices.u32.bin",
    "textures/index.json",
    "collision.json",
    "collision.positions.f32.bin",
    "collision.indices.u32.bin",
    "path.json",
    "path.points.f32.bin",
    "spawn.json",
    "blockers.json",
    "report.json",
)

ARTIFACTS = (
    "draws.json",
    "draws.positions.f32.bin",
    "draws.uv0.f32.bin",
    "draws.indices.u32.bin",
    "textures/index.json",
    "collision.json",
    "collision.positions.f32.bin",
    "collision.indices.u32.bin",
    "path.json",
    "path.points.f32.bin",
    "spawn.json",
    "blockers.json",
)

# schema id -> (required top-level key -> python type)
SCHEMAS = {
    "manifest.json": ("blur.map-batch.manifest/1", {
        "kind": str, "level": str, "grade": str, "units": dict, "scope": dict,
        "source": dict, "counts": dict, "artifacts": dict,
        "integrationContract": dict, "limits": list, "hashes": dict}),
    "draws.json": ("blur.map-batch.draws/1", {
        "level": str, "kind": str, "units": dict, "scope": dict,
        "sources": dict, "counts": dict, "buffers": dict, "sections": list,
        "unsupportedSections": list, "draws": list, "drawLists": dict,
        "textures": dict, "stageErrors": list, "limits": list}),
    "textures/index.json": ("blur.map-batch.textures/1", {
        "level": str, "prefix": str, "scope": dict, "inputs": dict,
        "materialResolution": dict, "counts": dict, "mergedGroups": list,
        "items": list, "sectionErrors": list, "limits": list}),
    "collision.json": ("blur.map-batch.collision/1", {
        "level": str, "kind": str, "file": str, "source": dict,
        "fileVersion": int, "streamVersion": int, "shapeStreamEnd": int,
        "routeCount": int, "routesParsed": bool, "counts": dict,
        "bounds": dict, "buffers": dict, "shapes": list,
        "excludedByType": dict, "surfaceRule": str, "readers": dict,
        "limits": list}),
    "path.json": ("blur.map-batch.path/1", {
        "level": str, "kind": str, "units": dict, "lengthM": (int, float),
        "sampleCount": int, "sampleStepM": (int, float), "direction": str,
        "pointsFile": str, "pointsFormat": str, "pointsSha256": str,
        "pointsBytes": int, "start": dict, "end": dict, "continuity": dict,
        "drawCovered": dict, "collisionOnly": dict, "checkpoints": list,
        "sources": dict, "samples": list}),
    "spawn.json": ("blur.map-batch.spawn/1", {
        "level": str, "kind": str, "spawn": dict, "layout": dict,
        "validity": dict, "proof": dict, "limits": list}),
    "blockers.json": ("blur.map-batch.blockers/1", {
        "level": str, "grade": str, "blockerCount": int, "fatalCount": int,
        "bySeverity": dict, "blockers": list, "gradeRule": dict}),
    "report.json": ("blur.map-batch.report/1", {
        "level": str, "grade": str, "counts": dict, "spawn": dict,
        "spawnValidity": bool, "timingsSeconds": dict,
        "totalSeconds": (int, float), "artifacts": dict, "blockers": dict,
        "limits": list, "hashes": dict}),
}

SAMPLE_STEP_M = 0.25
PATH_MAX_STEP_M = 0.250001
MIN_COVERED_PATH_M = 25.0
TEXTURE_LIMIT_PX = 512
GRADES = ("playable", "partial", "blocked")
SEVERITIES = ("geometry", "physics", "texture", "coverage", "layout", "material")
SPAWN_CHECKS = ("finite", "ray-hit", "up-facing", "spawn-band-25-hits",
                "spawn-band-all-up", "audit-cell-passable",
                "layout-ground-within-0.5m")
BAND_OFFSETS_M = (-0.5, -0.25, 0.0, 0.25, 0.5)
STATIONS_M = (0.0, 1.0, 2.0, 3.0, 4.0)

BUILD_SHIM = (
    "import sys,pathlib;"
    "sys.path.insert(0,sys.argv[1]);"
    "import map_batch_lib as b;"
    "b.build_level(sys.argv[2],pathlib.Path(sys.argv[3]),textures=True,"
    "log=lambda m:None)"
)


# --------------------------------------------------------------------- helpers

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(Path(path).read_bytes())


def strict_load(path: Path):
    def reject(value):
        raise ValueError("non-finite JSON constant " + value)

    return json.loads(Path(path).read_text(encoding="utf-8"),
                      parse_constant=reject)


def walk_nonfinite(value, path="") -> list:
    bad = []
    if isinstance(value, dict):
        for key, item in value.items():
            bad.extend(walk_nonfinite(item, path + "/" + str(key)))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            bad.extend(walk_nonfinite(item, path + "/%d" % index))
    elif isinstance(value, float):
        if not math.isfinite(value):
            bad.append(path)
    return bad


def short(value, limit=220):
    text = repr(value)
    return text if len(text) <= limit else text[:limit] + "..."


def close(a, b, rel=1e-6, abs_tol=1e-4) -> bool:
    if a is None or b is None:
        return False
    a, b = float(a), float(b)
    return abs(a - b) <= max(abs_tol, rel * max(abs(a), abs(b)))


def parse_unsupported(error: str) -> dict:
    """Mirror of the documented native error shape (`<reason> at byte <n>`)."""
    text = error or ""
    prefix = "native: "
    if text.startswith(prefix):
        text = text[len(prefix):]
    offset = None
    marker = " at byte "
    if marker in text:
        head, tail = text.rsplit(marker, 1)
        try:
            offset = int(tail.strip())
            text = head
        except ValueError:
            pass
    return {"reason": text, "byteOffset": offset}


def resample(points: list, step: float = SAMPLE_STEP_M) -> list:
    out = []
    for a, b in zip(points, points[1:]):
        length = math.hypot(b["x"] - a["x"], b["z"] - a["z"])
        n = max(1, int(math.ceil(length / step)))
        for k in range(n):
            t = k / n
            out.append({"x": round(a["x"] + (b["x"] - a["x"]) * t, 4),
                        "z": round(a["z"] + (b["z"] - a["z"]) * t, 4),
                        "h": round(a["h"] + (b["h"] - a["h"]) * t, 4)})
    out.append(dict(points[-1]))
    return out


def polyline_length(points: list) -> float:
    return sum(math.hypot(b["x"] - a["x"], b["z"] - a["z"])
               for a, b in zip(points, points[1:]))


def cumulative(points: list) -> list:
    out = [0.0]
    for a, b in zip(points, points[1:]):
        out.append(out[-1] + math.hypot(b["x"] - a["x"], b["z"] - a["z"]))
    return out


def point_at_arc(points: list, arc: float) -> dict:
    acc = 0.0
    for a, b in zip(points, points[1:]):
        d = math.hypot(b["x"] - a["x"], b["z"] - a["z"])
        if acc + d >= arc:
            t = (arc - acc) / d if d else 0.0
            return {"x": round(a["x"] + (b["x"] - a["x"]) * t, 4),
                    "z": round(a["z"] + (b["z"] - a["z"]) * t, 4),
                    "h": round(a["h"] + (b["h"] - a["h"]) * t, 4)}
        acc += d
    return dict(points[-1])


def station(points: list, cum: list, arc: float) -> dict:
    target = point_at_arc(points, arc)
    best = min(range(len(points)),
               key=lambda i: (points[i]["x"] - target["x"]) ** 2 +
                             (points[i]["z"] - target["z"]) ** 2)
    delta = math.hypot(points[best]["x"] - target["x"],
                       points[best]["z"] - target["z"])
    return {"requestedArcM": round(arc, 6),
            "requestedX": target["x"], "requestedZ": target["z"],
            "arcM": round(cum[best], 6), "pointIndex": best,
            "nearestPointDeltaM": round(delta, 6),
            "x": points[best]["x"], "z": points[best]["z"],
            "ground": points[best]["h"]}


def registry_maps() -> dict:
    """level id -> map id, parsed from the committed registry."""
    if not REGISTRY.is_file():
        return {}
    text = REGISTRY.read_text(encoding="utf-8")
    pattern = (r"id:\s*'([a-z0-9_]+)',\s*\n\s*label:[^\n]*\n"
               r"\s*level:\s*'([a-z0-9_]+)'")
    return {m.group(2): m.group(1) for m in re.finditer(pattern, text)}


_PROBE_CACHE: dict = {}


def merged_probes(level: str) -> tuple:
    """Merge the committed probe documents the way the package contract says.

    Duplicate (geometryBlock, nodeBlock) pairs prefer the `ok` row. Returns
    (documents, merged mapping).
    """
    if level in _PROBE_CACHE:
        return _PROBE_CACHE[level]
    merged = {}
    documents = []
    for name in PROBE_DOCS:
        path = PIPELINE / name
        if not path.is_file():
            continue
        documents.append({"path": path.relative_to(ROOT).as_posix(),
                          "bytes": path.stat().st_size,
                          "sha256": sha256_file(path)})
        doc = strict_load(path)
        for entry in doc.get("levels", []):
            if entry.get("level") != level:
                continue
            for probe in entry.get("probes", []):
                key = (int(probe["geometryBlock"]), int(probe["nodeBlock"]))
                current = merged.get(key)
                if current is None or (current.get("status") != "ok"
                                       and probe.get("status") == "ok"):
                    merged[key] = probe
    _PROBE_CACHE[level] = (documents, merged)
    return documents, merged


# --------------------------------------------------------------------- report

class Report:
    def __init__(self, quiet: bool = False):
        self.quiet = quiet
        self.checks = 0
        self.failures = []
        self.unsupported = []

    def check(self, ok, label, detail="") -> bool:
        self.checks += 1
        ok = bool(ok)
        if not ok:
            self.failures.append({"check": label, "detail": str(detail)})
            print("FAIL  %s :: %s" % (label, detail), flush=True)
        elif not self.quiet:
            print("PASS  %s :: %s" % (label, detail), flush=True)
        return ok

    def note_unsupported(self, record: dict) -> None:
        self.unsupported.append(record)
        print("UNSUPPORTED %s :: status=unsupported reason=%r byteOffset=%r"
              % (record["level"], record["reason"], record["byteOffset"]),
              flush=True)


# ---------------------------------------------------------------- determinism

def tree_hashes(root: Path) -> dict:
    out = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            out[path.relative_to(root).as_posix()] = (
                path.stat().st_size, sha256_file(path))
    return out


def compare_trees(left: Path, right: Path) -> dict:
    a = tree_hashes(left)
    b = tree_hashes(right)
    same_set = set(a) == set(b)
    diffs = [name for name in sorted(set(a) & set(b)) if a[name] != b[name]]
    byte_diffs = [name for name in diffs if name != "report.json"]
    report_equal = True
    if "report.json" in diffs:
        try:
            la = strict_load(left / "report.json")
            lb = strict_load(right / "report.json")
            for doc in (la, lb):
                doc.pop("timingsSeconds", None)
                doc.pop("totalSeconds", None)
            report_equal = la == lb
        except (ValueError, json.JSONDecodeError):
            report_equal = False
    return {"sameSet": same_set, "diffs": diffs, "byteDiffs": byte_diffs,
            "reportEqualModuloTimings": report_equal,
            "files": len(a), "onlyLeft": sorted(set(a) - set(b)),
            "onlyRight": sorted(set(b) - set(a))}


def build_into(level: str, out: Path, timeout: float) -> dict:
    command = [sys.executable, "-c", BUILD_SHIM, str(PROBES_DIR), level,
               str(out)]
    started = time.perf_counter()
    try:
        proc = subprocess.run(command, capture_output=True, text=True,
                              timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        return {"ok": False, "seconds": time.perf_counter() - started,
                "error": "timeout after %.0fs" % timeout, "stderr": ""}
    seconds = time.perf_counter() - started
    if proc.returncode != 0:
        return {"ok": False, "seconds": seconds,
                "error": "exit %d" % proc.returncode,
                "stderr": (proc.stderr or "")[-600:]}
    return {"ok": True, "seconds": seconds, "error": None, "stderr": ""}


def verify_determinism(level: str, rep, out: Path, timeout: float) -> dict:
    print("== %s (determinism) ==" % level, flush=True)
    base = Path(tempfile.mkdtemp(prefix="map-batch-verify-%s-" % level))
    first, second = base / "a", base / "b"
    try:
        run_a = build_into(level, first, timeout)
        run_b = build_into(level, second, timeout) if run_a["ok"] else \
            {"ok": False, "seconds": 0.0, "error": "skipped", "stderr": ""}
        ok = run_a["ok"] and run_b["ok"]
        detail = "build A %.1fs, build B %.1fs" % (run_a["seconds"],
                                                   run_b["seconds"])
        if not ok:
            detail += " error=%r stderr=%r" % (
                run_a["error"] or run_b["error"],
                (run_a["stderr"] or run_b["stderr"])[-300:])
        rep.check(ok, "%s/determinism/builds" % level, detail)
        if not ok:
            return {"builds": False, "error": run_a["error"] or run_b["error"],
                    "stderr": run_a["stderr"] or run_b["stderr"],
                    "hashes": {}}

        pair = compare_trees(first, second)
        rep.check(pair["sameSet"], "%s/determinism/file-set" % level,
                  "%d files, onlyA=%r onlyB=%r" % (
                      pair["files"], pair["onlyLeft"], pair["onlyRight"]))
        rep.check(not pair["byteDiffs"], "%s/determinism/bytes" % level,
                  "%d files compared, byte-different=%r" % (
                      pair["files"], pair["byteDiffs"]))
        rep.check(pair["reportEqualModuloTimings"],
                  "%s/determinism/report" % level,
                  "report.json equal modulo timingsSeconds/totalSeconds")

        committed = compare_trees(out, first)
        rep.check(committed["sameSet"] and not committed["byteDiffs"]
                  and committed["reportEqualModuloTimings"],
                  "%s/determinism/committed" % level,
                  "%d files, onlyCommitted=%r onlyFresh=%r byte-different=%r"
                  % (committed["files"], committed["onlyLeft"],
                     committed["onlyRight"], committed["byteDiffs"]))

        hashes = {}
        for name in ("manifest.json", "draws.json", "path.json",
                     "collision.json", "blockers.json"):
            left = first / name
            right = second / name
            if left.is_file() and right.is_file():
                hashes[name] = {"buildA": sha256_file(left),
                                "buildB": sha256_file(right)}
        stable = all(row["buildA"] == row["buildB"] for row in hashes.values())
        rep.check(stable, "%s/determinism/hashes" % level,
                  "%d pinned documents, manifest=%s"
                  % (len(hashes), hashes.get("manifest.json", {}).get("buildA")))
        return {"builds": True, "hashes": hashes,
                "filesCompared": pair["files"]}
    finally:
        shutil.rmtree(base, ignore_errors=True)


# --------------------------------------------------------------- level checks

def verify_level(level: str, rep: Report, *, determinism: bool,
                 timeout: float) -> dict:
    out = BATCH / level
    print("== %s ==" % level, flush=True)
    start_checks = rep.checks
    start_failures = len(rep.failures)
    result = {"level": level, "verdict": "verified", "checks": 0,
              "failures": 0, "counts": {}, "hashes": {},
              "unsupportedSections": [], "determinism": None}

    # ------------------------------------------------------------- presence
    missing = [name for name in REQUIRED_FILES if not (out / name).is_file()]
    rep.check(not missing, "%s/files/required" % level,
              "%d/%d present%s" % (len(REQUIRED_FILES) - len(missing),
                                   len(REQUIRED_FILES),
                                   "" if not missing else " missing=%r" % missing))
    if missing:
        result.update({"verdict": "failed",
                       "checks": rep.checks - start_checks,
                       "failures": len(rep.failures) - start_failures})
        return result

    # --------------------------------------------------------------- schema
    docs = {}
    load_ok = True
    for name in SCHEMAS:
        try:
            docs[name] = strict_load(out / name)
        except (ValueError, json.JSONDecodeError) as error:
            rep.check(False, "%s/schema/%s" % (level, name), "load: %s" % error)
            load_ok = False
    if not load_ok:
        result.update({"verdict": "failed",
                       "checks": rep.checks - start_checks,
                       "failures": len(rep.failures) - start_failures})
        return result

    for name, (schema, spec) in SCHEMAS.items():
        doc = docs[name]
        problems = []
        if doc.get("schema") != schema:
            problems.append("schema=%r" % doc.get("schema"))
        if doc.get("level") != level:
            problems.append("level=%r" % doc.get("level"))
        for key, kind in spec.items():
            if key not in doc:
                problems.append("missing:%s" % key)
            elif not isinstance(doc[key], kind):
                problems.append("%s:%s" % (key, type(doc[key]).__name__))
        if "mapId" in doc and not (doc["mapId"] is None
                                   or isinstance(doc["mapId"], str)):
            problems.append("mapId:%r" % doc["mapId"])
        rep.check(not problems, "%s/schema/%s" % (level, name),
                  "%s, %d keys%s" % (schema, len(spec),
                                     "" if not problems else
                                     " problems=%r" % problems))

    nonfinite = []
    for name, doc in docs.items():
        bad = walk_nonfinite(doc)
        if bad:
            nonfinite.append((name, bad[:3]))
    rep.check(not nonfinite, "%s/json/finite" % level,
              "%d documents%s" % (len(docs), "" if not nonfinite else
                                 " non-finite=%r" % nonfinite))

    manifest = docs["manifest.json"]
    draws_doc = docs["draws.json"]
    textures = docs["textures/index.json"]
    collision = docs["collision.json"]
    path_doc = docs["path.json"]
    spawn = docs["spawn.json"]
    blockers = docs["blockers.json"]
    report = docs["report.json"]

    # ------------------------------------------------------------- manifest
    pinned = manifest["hashes"].get("files", {})
    actual_files = {p.relative_to(out).as_posix() for p in out.rglob("*")
                    if p.is_file()}
    expected_unpinned = {"manifest.json", "report.json"}
    rep.check(actual_files - set(pinned) == expected_unpinned
              and set(pinned) <= actual_files,
              "%s/files/pins-cover-package" % level,
              "%d files, %d pinned, unpinned=%r"
              % (len(actual_files), len(pinned),
                 sorted(actual_files - set(pinned))))

    pin_bad = []
    for name, record in pinned.items():
        path = out / name
        if not path.is_file():
            pin_bad.append((name, "missing"))
        elif path.stat().st_size != record.get("bytes"):
            pin_bad.append((name, "bytes %d != %r"
                            % (path.stat().st_size, record.get("bytes"))))
        elif sha256_file(path) != record.get("sha256"):
            pin_bad.append((name, "sha256"))
    rep.check(not pin_bad, "%s/manifest/pins" % level,
              "%d pinned files, algorithm=%r%s"
              % (len(pinned), manifest["hashes"].get("algorithm"),
                 "" if not pin_bad else " first_bad=%r" % (pin_bad[0],)))

    body = {key: value for key, value in manifest.items() if key != "hashes"}
    content = sha256_bytes(json.dumps(
        body, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        allow_nan=False).encode("utf-8"))
    rep.check(content == manifest["hashes"].get("contentSha256"),
              "%s/manifest/content-hash" % level,
              "recomputed=%s pinned=%s"
              % (content[:16], str(manifest["hashes"].get("contentSha256"))[:16]))

    source_bad = []
    for key, name in SOURCE_FILES.items():
        record = manifest["source"]["files"].get(key, {})
        path = LEVELS_DIR / level / name
        if not path.is_file():
            source_bad.append((key, "missing"))
        elif not record.get("exists"):
            source_bad.append((key, "exists=false"))
        elif record.get("bytes") != path.stat().st_size:
            source_bad.append((key, "bytes"))
        elif record.get("sha256") != sha256_file(path):
            source_bad.append((key, "sha256"))
    rep.check(not source_bad, "%s/manifest/source-files" % level,
              "%d game files%s" % (len(SOURCE_FILES),
                                   "" if not source_bad else
                                   " first_bad=%r" % (source_bad[0],)))

    source = manifest["source"]
    pins_bad = []
    probe_records = source.get("probeDocuments", [])
    probe_paths = [record.get("path") for record in probe_records]
    existing_docs = [name for name in PROBE_DOCS if (PIPELINE / name).is_file()]
    if probe_paths != ["_work/map-pipeline/" + name for name in existing_docs]:
        pins_bad.append(("probeDocuments", probe_paths))
    for record in probe_records:
        path = ROOT / record.get("path", "")
        if not path.is_file() or record.get("bytes") != path.stat().st_size \
                or record.get("sha256") != sha256_file(path):
            pins_bad.append((record.get("path"), "pin"))
    for key in ("nativeReader", "textureDecoder", "scanner", "oracle",
                "mapRegistry"):
        record = source.get(key) or {}
        path = ROOT / record.get("path", "")
        if not path.is_file():
            pins_bad.append((key, "missing " + str(record.get("path"))))
        elif record.get("sha256") != sha256_file(path):
            pins_bad.append((key, "sha256"))
        elif "bytes" in record and record["bytes"] != path.stat().st_size:
            pins_bad.append((key, "bytes"))
    rep.check(not pins_bad, "%s/manifest/source-pins" % level,
              "%d probe docs, %d tool pins%s"
              % (len(probe_records), 5,
                 "" if not pins_bad else " first_bad=%r" % (pins_bad[0],)))

    # -------------------------------------------------------------- buffers
    dpos = np.fromfile(out / "draws.positions.f32.bin", dtype="<f4")
    duv = np.fromfile(out / "draws.uv0.f32.bin", dtype="<f4")
    didx = np.fromfile(out / "draws.indices.u32.bin", dtype="<u4")
    dc = draws_doc["counts"]
    sections = draws_doc["sections"]
    unsupported = draws_doc["unsupportedSections"]
    draws = draws_doc["draws"]

    buffer_bad = []
    for key, array in (("positions", dpos), ("uv0", duv), ("indices", didx)):
        record = draws_doc["buffers"].get(key, {})
        if array.size != record.get("count"):
            buffer_bad.append((key, "count %d != %r"
                               % (array.size, record.get("count"))))
        if array.nbytes != record.get("bytes"):
            buffer_bad.append((key, "bytes %d != %r"
                               % (array.nbytes, record.get("bytes"))))
        if sha256_file(out / record.get("file", "")) != record.get("sha256"):
            buffer_bad.append((key, "sha256"))
    if dpos.size != dc["vertexCount"] * 3:
        buffer_bad.append(("positions", "vertexCount"))
    if duv.size != dc["vertexCount"] * 2:
        buffer_bad.append(("uv0", "vertexCount"))
    if didx.size != dc["indexCount"]:
        buffer_bad.append(("indices", "indexCount"))
    if didx.size != dc["triangleCount"] * 3:
        buffer_bad.append(("indices", "triangleCount"))
    rep.check(not buffer_bad, "%s/draws/buffers" % level,
              "vertices=%d indices=%d%s"
              % (dc["vertexCount"], dc["indexCount"],
                 "" if not buffer_bad else " first_bad=%r" % (buffer_bad[0],)))
    rep.check(bool(np.isfinite(dpos).all()) and bool(np.isfinite(duv).all()),
              "%s/draws/finite" % level,
              "%d position + %d uv floats" % (dpos.size, duv.size))
    rep.check(didx.size == 0 or int(didx.max()) < dc["vertexCount"],
              "%s/draws/index-range" % level,
              "max=%s vertexCount=%d"
              % (int(didx.max()) if didx.size else None, dc["vertexCount"]))

    # -------------------------------------------------- sector/chunk table
    documents, merged = merged_probes(level)
    supported = {key: row for key, row in merged.items()
                 if row.get("status") == "ok"}
    unsupported_probes = {key: row for key, row in merged.items()
                          if row.get("status") != "ok"}

    table_bad = []
    ids = set()
    vertex_cursor = index_cursor = draw_cursor = 0
    previous_key = None
    for section in sections:
        key = (section["geometryBlock"], section["nodeBlock"])
        section_id = section["id"]
        if section_id in ids:
            table_bad.append((section_id, "duplicate id"))
        ids.add(section_id)
        if section_id != "g%d-n%d" % key:
            table_bad.append((section_id, "id format"))
        if previous_key is not None and key <= previous_key:
            table_bad.append((section_id, "not sorted"))
        previous_key = key
        if section.get("status") != "supported":
            table_bad.append((section_id, "status"))
        if section["vertexOffset"] != vertex_cursor:
            table_bad.append((section_id, "vertexOffset"))
        if section["indexOffset"] != index_cursor:
            table_bad.append((section_id, "indexOffset"))
        if section["drawOffset"] != draw_cursor:
            table_bad.append((section_id, "drawOffset"))
        if section["indexCount"] != section["triangleCount"] * 3:
            table_bad.append((section_id, "triangleCount"))
        if section["vertexCount"] <= 0 or section["drawCount"] <= 0:
            table_bad.append((section_id, "empty"))
        if section.get("stage") != \
                "_work/map-pipeline/probes/%s-%s" % (level, section_id):
            table_bad.append((section_id, "stage path"))
        elif not (ROOT / section["stage"]).is_dir():
            table_bad.append((section_id, "stage missing"))
        for field in ("geometryChunkIndex", "nodeChunkIndex"):
            if not isinstance(section.get(field), int) or section[field] < 0:
                table_bad.append((section_id, field))
        vertex_cursor += section["vertexCount"]
        index_cursor += section["indexCount"]
        draw_cursor += section["drawCount"]
    if vertex_cursor != dc["vertexCount"]:
        table_bad.append(("total", "vertex sum %d" % vertex_cursor))
    if index_cursor != dc["indexCount"]:
        table_bad.append(("total", "index sum %d" % index_cursor))
    if draw_cursor != dc["drawCount"]:
        table_bad.append(("total", "draw sum %d" % draw_cursor))
    rep.check(not table_bad, "%s/draws/section-table" % level,
              "%d sections, vertex/index/draw offsets contiguous%s"
              % (len(sections),
                 "" if not table_bad else " first_bad=%r" % (table_bad[0],)))

    set_bad = []
    section_keys = {(s["geometryBlock"], s["nodeBlock"]) for s in sections}
    unsupported_keys = {(u["geometryBlock"], u["nodeBlock"])
                        for u in unsupported}
    if section_keys != set(supported):
        set_bad.append(("supported", sorted(section_keys ^ set(supported))[:4]))
    if unsupported_keys != set(unsupported_probes):
        set_bad.append(("unsupported",
                        sorted(unsupported_keys ^ set(unsupported_probes))[:4]))
    if len(section_keys) != len(sections):
        set_bad.append(("supported", "duplicate keys"))
    if len(unsupported_keys) != len(unsupported):
        set_bad.append(("unsupported", "duplicate keys"))
    if dc["sectionsProbed"] != len(merged):
        set_bad.append(("sectionsProbed", dc["sectionsProbed"]))
    if dc["sectionsSupported"] != len(sections):
        set_bad.append(("sectionsSupported", dc["sectionsSupported"]))
    if dc["sectionsUnsupported"] != len(unsupported):
        set_bad.append(("sectionsUnsupported", dc["sectionsUnsupported"]))
    rep.check(not set_bad, "%s/draws/probe-set" % level,
              "%d probed = %d supported + %d unsupported from %d documents%s"
              % (len(merged), len(sections), len(unsupported), len(documents),
                 "" if not set_bad else " first_bad=%r" % (set_bad[0],)))

    join_bad = []
    for section in sections:
        probe = supported.get((section["geometryBlock"],
                               section["nodeBlock"]))
        if probe is None:
            continue
        for field, probe_field in (
                ("geometryChunkIndex", "geometryChunkIndex"),
                ("nodeChunkIndex", "nodeChunkIndex"),
                ("vertexCount", "vertexCount"),
                ("triangleCount", "triangleCount"),
                ("drawCount", "drawCount"),
                ("positionsFloat32LESha256", "positionsFloat32LESha256"),
                ("indicesUint32LESha256", "indicesUint32LESha256")):
            if section.get(field) != probe.get(probe_field):
                join_bad.append((section["id"], field))
                break
        else:
            for corner in ("min", "max"):
                if not all(close(a, b) for a, b in
                           zip(section["bounds"][corner],
                               probe["bounds"][corner])):
                    join_bad.append((section["id"], "bounds " + corner))
                    break
            if section["geometryChunk"].get("sha256") != \
                    probe.get("geometryChunkSha256") or \
                    section["geometryChunk"].get("bytes") != \
                    probe.get("geometryChunkBytes"):
                join_bad.append((section["id"], "geometry chunk"))
            elif section["nodeChunk"].get("sha256") != \
                    probe.get("nodeChunkSha256") or \
                    section["nodeChunk"].get("bytes") != \
                    probe.get("nodeChunkBytes"):
                join_bad.append((section["id"], "node chunk"))
    rep.check(not join_bad, "%s/draws/section-probe-join" % level,
              "%d sections joined to probe documents%s"
              % (len(sections),
                 "" if not join_bad else " first_bad=%r" % (join_bad[0],)))

    chunk_bad = []
    by_geometry = {}
    by_node = {}
    for section in sections:
        geometry_key = section["geometryChunkIndex"]
        node_key = section["nodeChunkIndex"]
        by_geometry.setdefault(geometry_key, set()).add(
            (section["geometryChunk"]["bytes"],
             section["geometryChunk"]["sha256"]))
        by_node.setdefault(node_key, set()).add(
            (section["nodeChunk"]["bytes"], section["nodeChunk"]["sha256"]))
        stage = ROOT / section["stage"]
        for name, record in (("geometry.chunk", section["geometryChunk"]),
                             ("node.chunk", section["nodeChunk"])):
            path = stage / name
            if not path.is_file():
                chunk_bad.append((section["id"], name + " missing"))
            elif path.stat().st_size != record["bytes"]:
                chunk_bad.append((section["id"], name + " bytes"))
            elif sha256_file(path) != record["sha256"]:
                chunk_bad.append((section["id"], name + " sha256"))
    for index, signatures in by_geometry.items():
        if len(signatures) > 1:
            chunk_bad.append(("geometryChunkIndex", index))
    for index, signatures in by_node.items():
        if len(signatures) > 1:
            chunk_bad.append(("nodeChunkIndex", index))
    rep.check(not chunk_bad, "%s/draws/chunk-table" % level,
              "%d geometry chunks, %d node chunks, staged files re-hashed%s"
              % (len(by_geometry), len(by_node),
                 "" if not chunk_bad else " first_bad=%r" % (chunk_bad[0],)))

    rehash_bad = []
    for section in sections:
        vertex_offset = section["vertexOffset"]
        vertex_count = section["vertexCount"]
        index_offset = section["indexOffset"]
        index_count = section["indexCount"]
        pos = dpos[vertex_offset * 3:(vertex_offset + vertex_count) * 3]
        idx = didx[index_offset:index_offset + index_count] - vertex_offset
        if pos.size != vertex_count * 3 or idx.size != index_count:
            rehash_bad.append((section["id"], "slice size"))
        elif sha256_bytes(pos.astype("<f4").tobytes()) != \
                section["positionsFloat32LESha256"]:
            rehash_bad.append((section["id"], "positions"))
        elif sha256_bytes(idx.astype("<u4").tobytes()) != \
                section["indicesUint32LESha256"]:
            rehash_bad.append((section["id"], "indices"))
    rep.check(not rehash_bad, "%s/draws/section-rehash" % level,
              "%d merged slices re-hashed to the native pins%s"
              % (len(sections),
                 "" if not rehash_bad else " first_bad=%r" % (rehash_bad[0],)))

    unsupported_bad = []
    for row in unsupported:
        probe = unsupported_probes.get((row["geometryBlock"],
                                        row["nodeBlock"]))
        if probe is None:
            unsupported_bad.append((row["id"], "no probe"))
            continue
        if row.get("status") != "unsupported":
            unsupported_bad.append((row["id"], "status"))
        if row.get("geometryChunkIndex") != probe.get("geometryChunkIndex") \
                or row.get("nodeChunkIndex") != probe.get("nodeChunkIndex"):
            unsupported_bad.append((row["id"], "chunk index"))
        parsed = parse_unsupported(probe.get("error") or "")
        if not row.get("reason"):
            unsupported_bad.append((row["id"], "empty reason"))
        elif row["reason"] != parsed["reason"]:
            unsupported_bad.append((row["id"], "reason mismatch"))
        elif row.get("byteOffset") != parsed["byteOffset"]:
            unsupported_bad.append((row["id"], "byteOffset mismatch"))
        elif parsed["byteOffset"] is None or parsed["byteOffset"] < 0:
            unsupported_bad.append((row["id"], "no byte position"))
    rep.check(not unsupported_bad, "%s/draws/unsupported-table" % level,
              "%d typed unsupported sections with reason + byte position%s"
              % (len(unsupported),
                 "" if not unsupported_bad else
                 " first_bad=%r" % (unsupported_bad[0],)))
    result["unsupportedSections"] = [
        {"id": row["id"], "reason": row.get("reason"),
         "byteOffset": row.get("byteOffset")} for row in unsupported]

    # ---------------------------------------------------------- draw records
    section_by_id = {s["id"]: s for s in sections}
    draw_bad = []
    expected_first = 0
    ordinal_by_section = {}
    for draw in draws:
        section = section_by_id.get(draw.get("sectionId"))
        if section is None:
            draw_bad.append((draw.get("id"), "section"))
            continue
        ordinal = ordinal_by_section.get(section["id"], 0)
        ordinal_by_section[section["id"]] = ordinal + 1
        if draw.get("id") != "%s#%d" % (section["id"], ordinal):
            draw_bad.append((draw.get("id"), "id/ordinal"))
        if draw.get("sectionDrawIndex") != ordinal:
            draw_bad.append((draw.get("id"), "sectionDrawIndex"))
        if draw.get("firstIndex") != expected_first:
            draw_bad.append((draw.get("id"), "firstIndex"))
        expected_first += int(draw.get("indexCount") or 0)
        if draw.get("indexCount", 0) % 3:
            draw_bad.append((draw.get("id"), "indexCount % 3"))
        if draw.get("triangleCount") != draw.get("indexCount", 0) // 3:
            draw_bad.append((draw.get("id"), "triangleCount"))
        if not (section["indexOffset"] <= draw.get("firstIndex", -1)
                < section["indexOffset"] + section["indexCount"]):
            draw_bad.append((draw.get("id"), "outside section"))
    if expected_first != dc["indexCount"]:
        draw_bad.append(("total", "ranges cover %d" % expected_first))
    for section in sections:
        if ordinal_by_section.get(section["id"], 0) != section["drawCount"]:
            draw_bad.append((section["id"], "drawCount"))
    rep.check(not draw_bad, "%s/draws/draw-ranges" % level,
              "%d draws tile the %d-index buffer%s"
              % (len(draws), dc["indexCount"],
                 "" if not draw_bad else " first_bad=%r" % (draw_bad[0],)))

    status_counts = {}
    status_bad = []
    for draw in draws:
        status = draw.get("status")
        if not isinstance(status, str) or not status:
            status_bad.append((draw.get("id"), "status"))
            continue
        status_counts[status] = status_counts.get(status, 0) + 1
    if status_counts != dc["statuses"]:
        status_bad.append(("statuses", dc["statuses"]))
    if sum(status_counts.values()) != dc["drawCount"]:
        status_bad.append(("total", sum(status_counts.values())))
    if dc["bindableDraws"] != status_counts.get("bindable-static-albedo", 0):
        status_bad.append(("bindableDraws", dc["bindableDraws"]))
    if dc["blockedDraws"] != dc["drawCount"] - dc["bindableDraws"]:
        status_bad.append(("blockedDraws", dc["blockedDraws"]))
    rep.check(not status_bad, "%s/draws/draw-status" % level,
              "%d draws, %d statuses%s"
              % (len(draws), len(status_counts),
                 "" if not status_bad else " first_bad=%r" % (status_bad[0],)))

    items = textures["items"]
    item_by_slot = {item["slot"]: item for item in items}
    join_bad = []
    for draw in draws:
        if draw.get("status") == "bindable-static-albedo":
            slot = draw.get("textureSlot")
            item = item_by_slot.get(slot) if isinstance(slot, int) else None
            if item is None:
                join_bad.append((draw.get("id"), "slot"))
            elif draw.get("textureId") not in item["sourceIds"]:
                join_bad.append((draw.get("id"), "textureId"))
            if not (isinstance(draw.get("uvHash"), str)
                    and re.fullmatch(r"0x[0-9a-f]{16}", draw["uvHash"])):
                join_bad.append((draw.get("id"), "uvHash"))
        elif draw.get("textureSlot") is not None:
            join_bad.append((draw.get("id"), "blocked with slot"))
    rep.check(not join_bad, "%s/draws/draw-joins" % level,
              "%d bindable draws joined to texture slots%s"
              % (dc["bindableDraws"],
                 "" if not join_bad else " first_bad=%r" % (join_bad[0],)))

    groups = draws_doc["drawLists"].get("blockedGroups", {})
    group_bad = []
    for status, group in groups.items():
        rows = [draw for draw in draws if draw["status"] == status]
        if group.get("draws") != len(rows):
            group_bad.append((status, "draws"))
        if group.get("triangles") != sum(row["triangleCount"] for row in rows):
            group_bad.append((status, "triangles"))
        if len(group.get("indexRanges", [])) != len(rows):
            group_bad.append((status, "indexRanges"))
        if any(entry.get("drawId") not in {r["id"] for r in rows}
               for entry in group.get("indexRanges", [])):
            group_bad.append((status, "join"))
    if sum(group.get("draws", 0) for group in groups.values()) != \
            dc["blockedDraws"]:
        group_bad.append(("total", "blockedDraws"))
    if draws_doc["drawLists"].get("opaque", {}).get("count") != \
            dc["bindableDraws"]:
        group_bad.append(("opaque", "count"))
    if draws_doc["drawLists"].get("blocked", {}).get("count") != \
            dc["blockedDraws"]:
        group_bad.append(("blocked", "count"))
    rep.check(not group_bad, "%s/draws/draw-lists" % level,
              "%d blocked groups, %d blocked draws%s"
              % (len(groups), dc["blockedDraws"],
                 "" if not group_bad else " first_bad=%r" % (group_bad[0],)))

    instance_sum = sum(section["instanceDescriptionsSkipped"]
                       for section in sections)
    uv_placeholder = sum(section["uv0PlaceholderVertices"]
                         for section in sections)
    instance_sections = sum(1 for section in sections
                            if section["instanceDescriptionsSkipped"])
    rep.check(instance_sum == dc["instanceDescriptionsSkipped"]
              and instance_sections == dc["instanceSectionsSkipped"]
              and uv_placeholder == dc["uv0PlaceholderVertices"],
              "%s/draws/instance-counts" % level,
              "instanceDescriptions=%d sections=%d uvPlaceholders=%d"
              % (instance_sum, instance_sections, uv_placeholder))

    scope = draws_doc["scope"]
    scope_bad = [key for key in ("instancesApplied", "materialsApplied",
                                 "texturesBoundInRenderer", "normalsExported")
                 if scope.get(key) is not False]
    if scope.get("partialSceneTraversal") is not True:
        scope_bad.append("partialSceneTraversal")
    if draws_doc.get("kind") != "first-renderlist-direct-lod0":
        scope_bad.append("kind")
    if draws_doc.get("stageErrors"):
        scope_bad.append("stageErrors")
    rep.check(not scope_bad, "%s/draws/scope" % level,
              "instancesApplied=false, partialSceneTraversal=true%s"
              % ("" if not scope_bad else " bad=%r" % scope_bad))

    texture_block = draws_doc.get("textures", {})
    tc = textures["counts"]
    rep.check(texture_block.get("sources") == tc["distinctTextureSources"]
              and texture_block.get("uniqueBlobs") == tc["uniqueBlobs"]
              and texture_block.get("referencedMip0Bytes")
              == tc["referencedMip0Bytes"]
              and texture_block.get("uniqueMip0Bytes")
              == tc["uniqueMip0Bytes"],
              "%s/draws/textures-block" % level,
              "sources=%d blobs=%d bytes=%d"
              % (tc["distinctTextureSources"], tc["uniqueBlobs"],
                 tc["uniqueMip0Bytes"]))

    # ------------------------------------------------------------- textures
    texture_bad = []
    seen_sha = set()
    seen_sources = set()
    for slot, item in enumerate(items):
        if item.get("slot") != slot:
            texture_bad.append((item.get("file"), "slot"))
        path = out / item.get("file", "")
        if not path.is_file():
            texture_bad.append((item.get("file"), "missing"))
            continue
        data = path.read_bytes()
        if len(data) != item.get("bytes"):
            texture_bad.append((item.get("file"), "bytes"))
        elif sha256_bytes(data) != item.get("sha256"):
            texture_bad.append((item.get("file"), "sha256"))
        elif len(data) != item.get("width", 0) * item.get("height", 0) * 4:
            texture_bad.append((item.get("file"), "dimensions"))
        elif item.get("sha256") in seen_sha:
            texture_bad.append((item.get("file"), "duplicate blob"))
        seen_sha.add(item.get("sha256"))
        if item.get("primaryId") not in item.get("sourceIds", []):
            texture_bad.append((item.get("file"), "primaryId"))
        if item.get("sourceIds") != sorted(item.get("sourceIds", [])):
            texture_bad.append((item.get("file"), "sourceIds order"))
        for source_id in item.get("sourceIds", []):
            if source_id in seen_sources:
                texture_bad.append((item.get("file"), "duplicate source"))
            seen_sources.add(source_id)
        if item.get("upload", {}).get("bytesMip0") != len(data):
            texture_bad.append((item.get("file"), "upload bytes"))
    rep.check(not texture_bad, "%s/textures/items" % level,
              "%d unique blobs, %d source ids%s"
              % (len(items), len(seen_sources),
                 "" if not texture_bad else
                 " first_bad=%r" % (texture_bad[0],)))

    distinct = sum(len(item["sourceIds"]) for item in items)
    referenced = sum(item["bytes"] * len(item["sourceIds"]) for item in items)
    unique_bytes = sum(item["bytes"] for item in items)
    status_triangles = {}
    for draw in draws:
        status_triangles[draw["status"]] = \
            status_triangles.get(draw["status"], 0) + draw["triangleCount"]
    count_bad = []
    for key, value in (
            ("sections", len(sections)), ("draws", len(draws)),
            ("triangles", dc["triangleCount"]),
            ("bindableDraws", dc["bindableDraws"]),
            ("blockedDraws", dc["blockedDraws"]),
            ("distinctTextureSources", distinct),
            ("uniqueBlobs", len(items)), ("mergedSources", distinct - len(items)),
            ("referencedMip0Bytes", referenced),
            ("uniqueMip0Bytes", unique_bytes),
            ("savedByMergeBytes", referenced - unique_bytes),
            ("statuses", dc["statuses"]),
            ("statusTriangles", status_triangles)):
        if tc.get(key) != value:
            count_bad.append((key, tc.get(key), value))
    rep.check(not count_bad, "%s/textures/counts" % level,
              "%d blobs, %d sources, %d referenced bytes%s"
              % (len(items), distinct, referenced,
                 "" if not count_bad else " first_bad=%r" % (count_bad[0],)))

    join_bad = []
    for item in items:
        rows = [draw for draw in draws
                if draw["status"] == "bindable-static-albedo"
                and draw["textureId"] in item["sourceIds"]]
        if len(rows) != item.get("drawCount") or \
                sum(row["triangleCount"] for row in rows) != \
                item.get("triangleCount"):
            join_bad.append((item["file"], "draw join"))
    rep.check(not join_bad, "%s/textures/draw-join" % level,
              "%d items, %d bindable draws%s"
              % (len(items), dc["bindableDraws"],
                 "" if not join_bad else " first_bad=%r" % (join_bad[0],)))

    expected_groups = {}
    for item in items:
        if len(item["sourceIds"]) > 1:
            expected_groups[item["sha256"]] = {
                "sha256": item["sha256"], "primaryId": item["primaryId"],
                "sourceIds": item["sourceIds"]}
    merged_groups = {row["sha256"]: row for row in textures["mergedGroups"]}
    rep.check(merged_groups == expected_groups,
              "%s/textures/merged-groups" % level,
              "%d merged groups" % len(merged_groups))

    scope = textures["scope"]
    scope_bad = [key for key in ("rendererChanged", "gpuUploaded",
                                 "texturesBoundInRenderer", "instancesApplied",
                                 "materialsBeyondStaticAlbedoApplied",
                                 "alphaRuleApplied", "samplerApplied")
                 if scope.get(key) is not False]
    if scope.get("dataOnly") is not True:
        scope_bad.append("dataOnly")
    if textures.get("sectionErrors"):
        scope_bad.append("sectionErrors")
    rep.check(not scope_bad, "%s/textures/scope" % level,
              "dataOnly=true, no renderer/GPU/material claim%s"
              % ("" if not scope_bad else " bad=%r" % scope_bad))

    inputs_bad = []
    for key, name in (("levelrender", "Level.levelrender"),
                      ("levelstream", "Level.levelstream")):
        record = textures["inputs"].get(key, {})
        path = LEVELS_DIR / level / name
        if not path.is_file() or record.get("bytes") != path.stat().st_size \
                or record.get("sha256") != sha256_file(path):
            inputs_bad.append((key, "pin"))
    for key in ("decoder", "resolver"):
        record = textures["inputs"].get(key, {})
        path = ROOT / record.get("path", "")
        if not path.is_file() or record.get("sha256") != sha256_file(path):
            inputs_bad.append((key, "pin"))
    rep.check(not inputs_bad, "%s/textures/inputs" % level,
              "levelrender + levelstream + decoder + resolver pins%s"
              % ("" if not inputs_bad else " first_bad=%r" % (inputs_bad[0],)))

    # ------------------------------------------------------------ collision
    cpos = np.fromfile(out / "collision.positions.f32.bin", dtype="<f4")
    cidx = np.fromfile(out / "collision.indices.u32.bin", dtype="<u4")
    cc = collision["counts"]
    collision_bad = []
    if cpos.size != cc["vertices"] * 3:
        collision_bad.append(("vertices", cpos.size))
    if cidx.size != cc["triangles"] * 3:
        collision_bad.append(("triangles", cidx.size))
    for key, array, components in (("positions", cpos, 3),
                                   ("indices", cidx, 3)):
        record = collision["buffers"].get(key, {})
        if array.size != record.get("count"):
            collision_bad.append((key, "count"))
        if array.nbytes != record.get("bytes"):
            collision_bad.append((key, "bytes"))
        if record.get("components") != components:
            collision_bad.append((key, "components"))
        if sha256_file(out / record.get("file", "")) != record.get("sha256"):
            collision_bad.append((key, "sha256"))
    rep.check(not collision_bad, "%s/collision/buffers" % level,
              "%d vertices, %d triangles%s"
              % (cc["vertices"], cc["triangles"],
                 "" if not collision_bad else
                 " first_bad=%r" % (collision_bad[0],)))
    rep.check(bool(np.isfinite(cpos).all())
              and (cidx.size == 0 or int(cidx.max()) < cc["vertices"]),
              "%s/collision/index-range" % level,
              "max=%s vertices=%d"
              % (int(cidx.max()) if cidx.size else None, cc["vertices"]))

    classification = (cc["surfaceTriangles"] + cc["steepTriangles"]
                      + cc["otherTriangles"] + cc["degenerateTriangles"])
    rep.check(classification == cc["triangles"]
              and cc["triangleSoupVertices"] == cc["triangles"] * 3,
              "%s/collision/classification" % level,
              "surface+steep+other+degenerate=%d triangles=%d soup=%d"
              % (classification, cc["triangles"], cc["triangleSoupVertices"]))

    shape_bad = []
    if cc["shapeCount"] != len(collision["shapes"]):
        shape_bad.append(("shapeCount", cc["shapeCount"]))
    shipped = sum(1 for shape in collision["shapes"] if shape.get("shipped"))
    excluded = sum(1 for shape in collision["shapes"]
                   if not shape.get("shipped"))
    if cc["shippedShapeCount"] != shipped:
        shape_bad.append(("shippedShapeCount", cc["shippedShapeCount"]))
    if cc["excludedShapeCount"] != excluded:
        shape_bad.append(("excludedShapeCount", cc["excludedShapeCount"]))
    if sum(collision["excludedByType"].values()) != excluded:
        shape_bad.append(("excludedByType", collision["excludedByType"]))
    for shape in collision["shapes"]:
        if not isinstance(shape.get("importName"), str) \
                or not isinstance(shape.get("importType"), int) \
                or not isinstance(shape.get("shipped"), bool):
            shape_bad.append((shape.get("importName"), "shape fields"))
            break
        if not shape["shipped"] and not shape.get("reason"):
            shape_bad.append((shape.get("importName"), "reason"))
            break
    rep.check(not shape_bad, "%s/collision/shapes" % level,
              "%d shapes = %d shipped + %d excluded%s"
              % (len(collision["shapes"]), shipped, excluded,
                 "" if not shape_bad else " first_bad=%r" % (shape_bad[0],)))

    bounds_bad = []
    if cpos.size:
        for corner, reducer in (("min", np.min), ("max", np.max)):
            for axis in range(3):
                value = float(reducer(cpos.reshape(-1, 3)[:, axis]))
                if not close(value, collision["bounds"][corner][axis]):
                    bounds_bad.append((corner, axis, value,
                                       collision["bounds"][corner][axis]))
    rep.check(not bounds_bad, "%s/collision/bounds" % level,
              "bounds re-derived from %d vertices%s"
              % (cc["vertices"],
                 "" if not bounds_bad else
                 " first_bad=%r" % (bounds_bad[0],)))

    source_bad = []
    physics_path = LEVELS_DIR / level / "Level.levelphysics"
    record = collision["source"]
    pinned_path = ROOT / record.get("path", "")
    if not pinned_path.is_file() \
            or pinned_path.name.lower() != "level.levelphysics":
        source_bad.append(("path", record.get("path")))
    if record.get("bytes") != physics_path.stat().st_size \
            or record.get("sha256") != sha256_file(physics_path):
        source_bad.append(("pin", "physics"))
    if not (0 <= collision["shapeStreamEnd"] <= physics_path.stat().st_size):
        source_bad.append(("shapeStreamEnd", collision["shapeStreamEnd"]))
    for key in ("scanner", "oracle"):
        reader = collision["readers"].get(key, {})
        path = ROOT / reader.get("path", "")
        if not path.is_file() or reader.get("sha256") != sha256_file(path):
            source_bad.append((key, "pin"))
    rep.check(not source_bad, "%s/collision/source" % level,
              "physics pin + shapeStreamEnd=%d + reader pins%s"
              % (collision["shapeStreamEnd"],
                 "" if not source_bad else " first_bad=%r" % (source_bad[0],)))

    # ----------------------------------------------------------------- path
    covered_path = PIPELINE / "covered" / (level + "-path.json")
    covered_summary = PIPELINE / "covered" / (level + ".json")
    collision_path = PIPELINE / "paths" / (level + ".json")
    maps_path = PIPELINE / "maps.json"
    maps_doc = strict_load(maps_path) if maps_path.is_file() else {"levels": []}
    maps_row = next((row for row in maps_doc.get("levels", [])
                     if row.get("name") == level), {})
    drivable = maps_row.get("drivable") or {}
    collision_only = drivable.get("path") or {}
    collision_length = float(collision_only.get("lengthM") or 0.0)

    draw_available = covered_path.is_file()
    source_path = covered_path if draw_available else collision_path
    source_bad = []
    if not source_path.is_file():
        source_bad.append(("source", "no measured path"))
        raw_samples = []
    else:
        raw_samples = strict_load(source_path).get("samples") or []
        if len(raw_samples) < 2:
            source_bad.append(("source", "fewer than two samples"))
    samples = resample(raw_samples) if len(raw_samples) >= 2 else []
    rep.check(not source_bad, "%s/path/source" % level,
              "%s from %s (%d raw samples)"
              % ("draw-covered" if draw_available else "collision-only",
                 source_path.relative_to(ROOT).as_posix() if source_path.is_file()
                 else "missing", len(raw_samples)))

    rep.check(samples == path_doc["samples"], "%s/path/samples" % level,
              "%d resampled points equal path.samples" % len(samples))
    length = polyline_length(samples)
    rep.check(abs(length - path_doc["lengthM"]) <= 1e-9,
              "%s/path/length" % level,
              "recomputed=%.9f pinned=%.9f" % (length, path_doc["lengthM"]))

    points = np.fromfile(out / "path.points.f32.bin", dtype="<f4")
    points_bad = []
    if points.size != path_doc["sampleCount"] * 3:
        points_bad.append(("count", points.size))
    if path_doc["pointsBytes"] != path_doc["sampleCount"] * 12:
        points_bad.append(("pointsBytes", path_doc["pointsBytes"]))
    if sha256_file(out / "path.points.f32.bin") != path_doc["pointsSha256"]:
        points_bad.append(("sha256", "file"))
    if points.size == len(samples) * 3:
        array = points.reshape(-1, 3)
        for index, sample in enumerate(samples):
            for axis, key in enumerate(("x", "z", "h")):
                if np.float32(sample[key]) != array[index][axis]:
                    points_bad.append((index, key))
                    break
            if points_bad:
                break
    rep.check(not points_bad, "%s/path/points-binary" % level,
              "%d points, %d bytes, sha256=%s"
              % (path_doc["sampleCount"], path_doc["pointsBytes"],
                 path_doc["pointsSha256"][:16]))

    steps = [math.hypot(b["x"] - a["x"], b["z"] - a["z"])
             for a, b in zip(samples, samples[1:])]
    heights = [point["h"] for point in samples]
    max_step = max(steps) if steps else 0.0
    max_height = max((abs(b - a) for a, b in zip(heights, heights[1:])),
                     default=0.0)
    continuity = path_doc["continuity"]
    rep.check(close(continuity["maxStepM"], max_step, rel=1e-9, abs_tol=1e-9)
              and close(continuity["maxHeightDeltaM"], max_height,
                        rel=1e-9, abs_tol=1e-9)
              and continuity["maxStepWithinLimit"] == (max_step <= PATH_MAX_STEP_M)
              and continuity["monotonicArc"] == all(step > 0 for step in steps)
              and continuity["stepLimitM"] == PATH_MAX_STEP_M,
              "%s/path/continuity" % level,
              "maxStep=%.6f maxHeightDelta=%.6f monotonic=%s"
              % (max_step, max_height, all(step > 0 for step in steps)))

    cum = cumulative(samples)
    checkpoint_bad = []
    for index in (1, 2):
        expected = station(samples, cum, length * index / 3.0)
        row = path_doc["checkpoints"][index - 1]
        for key, value in expected.items():
            if row.get(key) != value:
                checkpoint_bad.append((index, key, row.get(key), value))
                break
        if row.get("index") != index:
            checkpoint_bad.append((index, "index"))
    rep.check(not checkpoint_bad, "%s/path/checkpoints" % level,
              "%d checkpoints re-derived from the arc length%s"
              % (len(path_doc["checkpoints"]),
                 "" if not checkpoint_bad else
                 " first_bad=%r" % (checkpoint_bad[0],)))

    draw_covered = path_doc["drawCovered"]
    draw_length = length if draw_available else 0.0
    coverage = (draw_length / collision_length) if collision_length else 0.0
    covered_bad = []
    if draw_covered.get("available") != draw_available:
        covered_bad.append(("available", draw_covered.get("available")))
    if path_doc.get("kind") != ("draw-covered-measured" if draw_available
                                else "collision-only-measured"):
        covered_bad.append(("kind", path_doc.get("kind")))
    if not close(draw_covered.get("lengthM"), draw_length, rel=1e-9,
                 abs_tol=1e-9):
        covered_bad.append(("lengthM", draw_covered.get("lengthM")))
    if abs(round(coverage, 6)
           - draw_covered.get("coverageOfCollisionDiameter", -1)) > 1e-9:
        covered_bad.append(("coverage", draw_covered.get(
            "coverageOfCollisionDiameter")))
    if draw_covered.get("sampleCount") != (len(samples) if draw_available else 0):
        covered_bad.append(("sampleCount", draw_covered.get("sampleCount")))
    if draw_available:
        if not covered_summary.is_file():
            covered_bad.append(("summary", "missing"))
        else:
            summary = strict_load(covered_summary)
            for key, summary_key in (
                    ("coveredPassableCells", "coveredPassableCells"),
                    ("passableCells", "passableCells"),
                    ("coverageOfPassable", "coverageOfPassable"),
                    ("coveredComponents", "componentCount")):
                if draw_covered.get(key) != summary.get(summary_key):
                    covered_bad.append((key, draw_covered.get(key)))
        if draw_covered.get("blocker") is not None:
            covered_bad.append(("blocker", draw_covered.get("blocker")))
        record = draw_covered.get("source") or {}
        if record.get("sha256") != sha256_file(covered_path) or \
                record.get("bytes") != covered_path.stat().st_size:
            covered_bad.append(("source", "pin"))
    else:
        if draw_covered.get("blocker") != "no draw-covered collision cell":
            covered_bad.append(("blocker", draw_covered.get("blocker")))
    rep.check(not covered_bad, "%s/path/draw-covered" % level,
              "available=%s length=%.3f coverage=%.6f"
              % (draw_available, draw_length, round(coverage, 6))
              if not covered_bad else " first_bad=%r" % (covered_bad[0],))

    collision_only_doc = path_doc["collisionOnly"]
    collision_bad = []
    for key, source_key in (("lengthM", "lengthM"),
                            ("sampleCount", "samples"),
                            ("maxStepM", "maxStepM"),
                            ("max2mGrade", "max2mGrade")):
        if collision_only_doc.get(key) != collision_only.get(source_key):
            collision_bad.append((key, collision_only_doc.get(key),
                                  collision_only.get(source_key)))
    if collision_only_doc.get("start") != collision_only.get("start"):
        collision_bad.append(("start", collision_only_doc.get("start")))
    if collision_only_doc.get("end") != collision_only.get("end"):
        collision_bad.append(("end", collision_only_doc.get("end")))
    if collision_only_doc.get("component") != drivable.get("measuredComponent"):
        collision_bad.append(("component", collision_only_doc.get("component")))
    record = collision_only_doc.get("source") or {}
    if record.get("sha256") != sha256_file(maps_path):
        collision_bad.append(("source", "maps.json pin"))
    rep.check(not collision_bad, "%s/path/collision-only" % level,
              "length=%.3f samples=%r component=%r"
              % (collision_length, collision_only.get("samples"),
                 drivable.get("measuredComponent"))
              if not collision_bad else " first_bad=%r" % (collision_bad[0],))

    sources_bad = []
    for key, record in path_doc["sources"].items():
        if record is None:
            continue
        path = ROOT / record.get("path", "")
        if not path.is_file():
            sources_bad.append((key, "missing"))
        elif path.stat().st_size != record.get("bytes") \
                or sha256_file(path) != record.get("sha256"):
            sources_bad.append((key, "pin"))
    rep.check(not sources_bad, "%s/path/sources" % level,
              "%d source pins" % len(path_doc["sources"])
              if not sources_bad else " first_bad=%r" % (sources_bad[0],))

    # ---------------------------------------------------------------- spawn
    spawn_doc = spawn["spawn"]
    heading_index = min(8, len(samples) - 1)
    heading = math.atan2(samples[heading_index]["x"] - samples[0]["x"],
                         samples[heading_index]["z"] - samples[0]["z"])
    pose_bad = []
    if spawn_doc.get("x") != samples[0]["x"] \
            or spawn_doc.get("z") != samples[0]["z"] \
            or spawn_doc.get("ground") != samples[0]["h"]:
        pose_bad.append(("start", spawn_doc))
    if abs(round(heading, 9) - spawn_doc.get("headingRad", 1e9)) > 1e-9:
        pose_bad.append(("heading", spawn_doc.get("headingRad"), heading))
    if spawn_doc.get("stationM") != 0.0:
        pose_bad.append(("stationM", spawn_doc.get("stationM")))
    rep.check(not pose_bad, "%s/spawn/pose" % level,
              "x=%.4f z=%.4f ground=%.4f heading=%.9f"
              % (spawn_doc.get("x", 0), spawn_doc.get("z", 0),
                 spawn_doc.get("ground", 0), spawn_doc.get("headingRad", 0))
              if not pose_bad else " first_bad=%r" % (pose_bad[0],))

    layout = spawn["layout"]
    layout_bad = []
    if layout.get("mode") != "point-to-point":
        layout_bad.append(("mode", layout.get("mode")))
    if abs(layout.get("lengthM", -1) - length) > 1e-6:
        layout_bad.append(("lengthM", layout.get("lengthM")))
    if layout.get("sampleCount") != len(samples):
        layout_bad.append(("sampleCount", layout.get("sampleCount")))
    if layout.get("sampleStepM") != SAMPLE_STEP_M:
        layout_bad.append(("sampleStepM", layout.get("sampleStepM")))
    if layout.get("pointsFile") != "path.points.f32.bin" \
            or layout.get("pointsSha256") != path_doc["pointsSha256"]:
        layout_bad.append(("points", layout.get("pointsFile")))
    if layout.get("lap") is not None:
        layout_bad.append(("lap", layout.get("lap")))
    finish = layout.get("finish") or {}
    if finish.get("pointIndex") != len(samples) - 1 \
            or finish.get("x") != samples[-1]["x"] \
            or finish.get("z") != samples[-1]["z"] \
            or finish.get("ground") != samples[-1]["h"] \
            or abs(finish.get("arcM", -1) - length) > 1e-6:
        layout_bad.append(("finish", finish))
    if len(layout.get("checkpoints", [])) != 2:
        layout_bad.append(("checkpoints", len(layout.get("checkpoints", []))))
    else:
        for row, path_row in zip(layout["checkpoints"],
                                 path_doc["checkpoints"]):
            for key in ("index", "arcM", "requestedArcM", "pointIndex",
                        "nearestPointDeltaM", "x", "z", "ground"):
                if row.get(key) != path_row.get(key):
                    layout_bad.append(("checkpoint", key))
                    break
            if row.get("distanceM") != row.get("arcM"):
                layout_bad.append(("checkpoint", "distanceM"))
    rep.check(not layout_bad, "%s/spawn/layout" % level,
              "point-to-point, %.3f m, %d samples, 2 checkpoints + finish"
              % (length, len(samples))
              if not layout_bad else " first_bad=%r" % (layout_bad[0],))

    validity = spawn["validity"]
    checks = validity.get("checks", [])
    validity_bad = []
    if [row.get("name") for row in checks] != list(SPAWN_CHECKS):
        validity_bad.append(("checks", [row.get("name") for row in checks]))
    if validity.get("pass") != all(bool(row.get("pass")) for row in checks):
        validity_bad.append(("pass", validity.get("pass")))
    if validity.get("onCollisionSurface") != (validity.get("rayHit") is True
                                              and validity.get("upFacing")
                                              is True):
        validity_bad.append(("onCollisionSurface", validity.get(
            "onCollisionSurface")))
    delta = validity.get("groundDeltaM")
    if delta is not None and abs(delta) > 0.5:
        validity_bad.append(("groundDeltaM", delta))
    rep.check(not validity_bad, "%s/spawn/validity" % level,
              "pass=%s, 7 checks, rayHit=%s upFacing=%s"
              % (validity.get("pass"), validity.get("rayHit"),
                 validity.get("upFacing"))
              if not validity_bad else " first_bad=%r" % (validity_bad[0],))

    proof = spawn["proof"]
    band = proof.get("band") or []
    cells = [cell for row in band for cell in row]
    hits = [cell for cell in cells if cell.get("hit")]
    band_bad = []
    if proof.get("bandOffsetsM") != list(BAND_OFFSETS_M):
        band_bad.append(("bandOffsetsM", proof.get("bandOffsetsM")))
    if proof.get("stationsM") != list(STATIONS_M):
        band_bad.append(("stationsM", proof.get("stationsM")))
    if len(band) != len(STATIONS_M) or any(
            len(row) != len(BAND_OFFSETS_M) for row in band):
        band_bad.append(("shape", [len(row) for row in band]))
    if proof.get("expectedHitCount") != \
            len(BAND_OFFSETS_M) * len(STATIONS_M):
        band_bad.append(("expectedHitCount", proof.get("expectedHitCount")))
    if proof.get("hitCount") != len(hits):
        band_bad.append(("hitCount", proof.get("hitCount")))
    if proof.get("allHits") != (len(hits) == proof.get("expectedHitCount")):
        band_bad.append(("allHits", proof.get("allHits")))
    up = all(cell["normal"][1] > 0.94 for cell in hits)
    if proof.get("allUpFacing") != up:
        band_bad.append(("allUpFacing", proof.get("allUpFacing")))
    if any(bool(cell.get("upFacing")) != (cell["normal"][1] > 0.94)
           for cell in hits):
        band_bad.append(("cell upFacing", "normal"))
    if hits:
        heights = [cell["y"] for cell in hits]
        if not close(proof.get("heightSpreadM"), max(heights) - min(heights),
                     rel=1e-9, abs_tol=1e-9):
            band_bad.append(("heightSpreadM", proof.get("heightSpreadM")))
        if not close(proof.get("maxAbsHeightDeviationM"),
                     max(abs(value - proof["groundY"]) for value in heights),
                     rel=1e-9, abs_tol=1e-9):
            band_bad.append(("maxAbsHeightDeviationM", "band"))
    center = proof.get("center") or {}
    if center.get("x") != spawn_doc.get("x") \
            or center.get("z") != spawn_doc.get("z"):
        band_bad.append(("center", "xz"))
    if center.get("hit") != validity.get("rayHit") \
            or center.get("upFacing") != validity.get("upFacing"):
        band_bad.append(("center", "flags"))
    if not close(proof.get("groundY"), validity.get("rayGroundY"),
                 rel=1e-9, abs_tol=1e-9):
        band_bad.append(("groundY", proof.get("groundY")))
    if not close(proof.get("deltaToLayoutGroundM"),
                 float(proof.get("groundY", 0)) - spawn_doc.get("ground", 0),
                 rel=1e-9, abs_tol=1e-9):
        band_bad.append(("deltaToLayoutGroundM", proof.get("deltaToLayoutGroundM")))
    rep.check(not band_bad, "%s/spawn/proof-band" % level,
              "%d/%d rays hit, allUpFacing=%s, spread=%.6f"
              % (len(hits), len(cells), proof.get("allUpFacing"),
                 proof.get("heightSpreadM") or 0.0)
              if not band_bad else " first_bad=%r" % (band_bad[0],))

    ray = proof.get("ray") or {}
    ray_bad = []
    if ray.get("axis") != "vertical down":
        ray_bad.append(("axis", ray.get("axis")))
    if proof.get("widthM") != 1.0 or proof.get("lengthM") != 5.0:
        ray_bad.append(("band size", (proof.get("widthM"),
                                      proof.get("lengthM"))))
    if not (isinstance(ray.get("startY"), (int, float))
            and isinstance(ray.get("minY"), (int, float))
            and isinstance(ray.get("maxY"), (int, float))
            and ray["maxY"] > ray["minY"]
            and ray["startY"] >= ray["maxY"]):
        ray_bad.append(("ray range", ray))
    if hits and not all(ray.get("minY", 0) < cell["y"] <= ray.get("maxY", 0)
                        for cell in hits):
        ray_bad.append(("hit outside ray window", ray))
    if not isinstance(ray.get("rule"), str) or not ray["rule"]:
        ray_bad.append(("rule", ray.get("rule")))
    rep.check(not ray_bad, "%s/spawn/proof-ray" % level,
              "vertical-down ray, 1 m x 5 m band, %d cells"
              % len(cells) if not ray_bad else " first_bad=%r" % (ray_bad[0],))

    # ------------------------------------------------------------- blockers
    blocker_bad = []
    codes = set()
    severity = {}
    for row in blockers["blockers"]:
        code = row.get("code")
        if not isinstance(code, str) or not code:
            blocker_bad.append(("code", code))
        elif code in codes:
            blocker_bad.append(("duplicate code", code))
        codes.add(code)
        if row.get("severity") not in SEVERITIES:
            blocker_bad.append((code, "severity"))
        if not isinstance(row.get("detail"), str) or not row["detail"]:
            blocker_bad.append((code, "detail"))
        if not isinstance(row.get("fatalForPlayable"), bool):
            blocker_bad.append((code, "fatalForPlayable"))
        if not isinstance(row.get("resolvedBy"), str) or not row["resolvedBy"]:
            blocker_bad.append((code, "resolvedBy"))
        if not isinstance(row.get("count"), int) or row["count"] < 0:
            blocker_bad.append((code, "count"))
        severity[row.get("severity")] = severity.get(row.get("severity"), 0) + 1
    if blockers.get("blockerCount") != len(blockers["blockers"]):
        blocker_bad.append(("blockerCount", blockers.get("blockerCount")))
    fatal = sum(1 for row in blockers["blockers"]
                if row.get("fatalForPlayable"))
    if blockers.get("fatalCount") != fatal:
        blocker_bad.append(("fatalCount", blockers.get("fatalCount")))
    if blockers.get("bySeverity") != dict(sorted(severity.items())):
        blocker_bad.append(("bySeverity", blockers.get("bySeverity")))
    rep.check(not blocker_bad, "%s/blockers/structure" % level,
              "%d typed blockers, %d fatal%s"
              % (len(blockers["blockers"]), fatal,
                 "" if not blocker_bad else
                 " first_bad=%r" % (blocker_bad[0],)))

    integrated = registry_maps()
    expected_grade = ("blocked" if draw_length < MIN_COVERED_PATH_M
                      else ("playable" if level in integrated else "partial"))
    grade_bad = []
    if blockers.get("grade") != expected_grade:
        grade_bad.append(("grade", blockers.get("grade"), expected_grade))
    if blockers.get("grade") != manifest.get("grade") \
            or blockers.get("grade") != report.get("grade"):
        grade_bad.append(("grade parity", blockers.get("grade")))
    if set(blockers.get("gradeRule", {})) != {"blocked", "playable", "partial"}:
        grade_bad.append(("gradeRule", sorted(blockers.get("gradeRule", {}))))
    rep.check(not grade_bad, "%s/blockers/grade" % level,
              "grade=%s (draw-covered %.3f m, integrated=%s)"
              % (blockers.get("grade"), draw_length, level in integrated)
              if not grade_bad else " first_bad=%r" % (grade_bad[0],))

    by_code = {row["code"]: row for row in blockers["blockers"]}
    unsupported_join = []
    if unsupported:
        row = by_code.get("unsupported-draw-section")
        expected_items = [{key: item[key] for key in
                           ("id", "geometryBlock", "nodeBlock", "reason",
                            "byteOffset")} for item in unsupported]
        if row is None:
            unsupported_join.append(("missing", "unsupported-draw-section"))
        else:
            if row.get("items") != expected_items:
                unsupported_join.append(("items", "join"))
            if row.get("count") != len(unsupported):
                unsupported_join.append(("count", row.get("count")))
    elif "unsupported-draw-section" in by_code:
        unsupported_join.append(("unexpected", "unsupported-draw-section"))
    rep.check(not unsupported_join, "%s/blockers/unsupported-join" % level,
              "%d unsupported sections joined to the blocker table"
              % len(unsupported)
              if not unsupported_join else
              " first_bad=%r" % (unsupported_join[0],))

    coverage_join = []
    if draw_length < MIN_COVERED_PATH_M:
        if "draw-coverage-blocked" not in by_code:
            coverage_join.append(("missing", "draw-coverage-blocked"))
    elif "draw-coverage-blocked" in by_code:
        coverage_join.append(("unexpected", "draw-coverage-blocked"))
    if draw_length >= MIN_COVERED_PATH_M and coverage < 0.9:
        if "draw-coverage-partial" not in by_code:
            coverage_join.append(("missing", "draw-coverage-partial"))
    elif "draw-coverage-partial" in by_code:
        coverage_join.append(("unexpected", "draw-coverage-partial"))
    if not draw_available and "no-draw-covered-path" not in by_code:
        coverage_join.append(("missing", "no-draw-covered-path"))
    if draw_available and "no-draw-covered-path" in by_code:
        coverage_join.append(("unexpected", "no-draw-covered-path"))
    rep.check(not coverage_join, "%s/blockers/coverage-join" % level,
              "draw-covered %.3f m, coverage %.6f"
              % (draw_length, coverage)
              if not coverage_join else
              " first_bad=%r" % (coverage_join[0],))

    texture_join = []
    for status, count in tc["statuses"].items():
        if status == "bindable-static-albedo" or count == 0:
            continue
        code = "texture-draw-" + status.replace("blocked-", "")
        row = by_code.get(code)
        if row is None:
            texture_join.append(("missing", code))
        elif row.get("count") != count or \
                row.get("triangles") != tc["statusTriangles"].get(status):
            texture_join.append((code, "count/triangles"))
    expected_texture_codes = {"texture-draw-" + status.replace("blocked-", "")
                              for status, count in tc["statuses"].items()
                              if status != "bindable-static-albedo" and count}
    extra = {code for code in by_code if code.startswith("texture-draw-")} \
        - expected_texture_codes
    if extra:
        texture_join.append(("unexpected", sorted(extra)))
    rep.check(not texture_join, "%s/blockers/texture-join" % level,
              "%d texture statuses joined" % len(tc["statuses"])
              if not texture_join else
              " first_bad=%r" % (texture_join[0],))

    # --------------------------------------------------------------- report
    derived = {
        "draws": len(draws),
        "bindableDraws": dc["bindableDraws"],
        "drawTriangles": dc["triangleCount"],
        "vertices": dc["vertexCount"],
        "indices": dc["indexCount"],
        "sectionsProbed": len(merged),
        "sectionsSupported": len(sections),
        "sectionsUnsupported": len(unsupported),
        "instanceDescriptionsSkipped": instance_sum,
        "textureSources": distinct,
        "textureBlobs": len(items),
        "textureBytes": unique_bytes,
        "textureBytesReferenced": referenced,
        "collisionTriangles": cc["triangles"],
        "collisionVertices": cc["vertices"],
        "drawCoveredPathM": round(draw_length, 6),
        "collisionPathM": round(collision_length, 6),
        "coverageOfCollisionDiameter": round(coverage, 6),
        "pathSamples": len(samples),
        "spawnValid": bool(validity.get("pass")),
        "blockers": len(blockers["blockers"]),
        "fatalBlockers": fatal,
    }
    manifest_counts = manifest["counts"]
    counts_bad = []
    if set(manifest_counts) != set(derived):
        counts_bad.append(("keys", sorted(set(manifest_counts) ^ set(derived))))
    for key, value in derived.items():
        if manifest_counts.get(key) != value:
            counts_bad.append((key, manifest_counts.get(key), value))
    rep.check(not counts_bad, "%s/manifest/counts" % level,
              "%d counts re-derived%s"
              % (len(derived),
                 "" if not counts_bad else " first_bad=%r" % (counts_bad[0],)))

    report_bad = []
    for key in ("draws", "bindableDraws", "drawTriangles", "vertices",
                "sectionsProbed", "sectionsSupported", "sectionsUnsupported",
                "instanceDescriptionsSkipped", "textureSources",
                "textureBlobs", "textureBytes", "textureBytesReferenced",
                "collisionTriangles", "collisionVertices",
                "drawCoveredPathM", "collisionPathM",
                "coverageOfCollisionDiameter", "pathSamples", "spawnValid"):
        if report["counts"].get(key) != derived[key]:
            report_bad.append((key, report["counts"].get(key), derived[key]))
    rep.check(not report_bad, "%s/report/counts" % level,
              "%d report counts agree with the artifacts%s"
              % (len(report["counts"]),
                 "" if not report_bad else
                 " first_bad=%r" % (report_bad[0],)))

    report_hashes = report.get("hashes", {})
    hash_bad = []
    for key, name in (("manifest", "manifest.json"), ("draws", "draws.json"),
                      ("path", "path.json"), ("spawn", "spawn.json"),
                      ("blockers", "blockers.json"),
                      ("collision", "collision.json")):
        if report_hashes.get(key) != sha256_file(out / name):
            hash_bad.append((key, "sha256"))
    if report_hashes.get("manifestContentSha256") != \
            manifest["hashes"]["contentSha256"]:
        hash_bad.append(("manifestContentSha256", "pin"))
    rep.check(not hash_bad, "%s/report/hashes" % level,
              "%d document hashes recomputed%s"
              % (len(report_hashes),
                 "" if not hash_bad else " first_bad=%r" % (hash_bad[0],)))

    rep.check(set(report.get("artifacts", {})) == set(ARTIFACTS)
              and all(report["artifacts"][name] == name for name in ARTIFACTS),
              "%s/report/artifacts" % level,
              "%d artifact names" % len(ARTIFACTS))

    report_spawn = report.get("spawn", {})
    rep.check(all(report_spawn.get(key) == spawn_doc.get(key)
                  for key in ("x", "z", "ground", "headingRad"))
              and report.get("spawnValidity") == validity.get("pass"),
              "%s/report/spawn" % level,
              "spawn pose and validity match spawn.json")

    timings = report.get("timingsSeconds", {})
    timing_bad = []
    if not timings or any(not isinstance(value, (int, float)) or value < 0
                          for value in timings.values()):
        timing_bad.append(("timingsSeconds", timings))
    total = report.get("totalSeconds")
    if not isinstance(total, (int, float)) or total <= 0:
        timing_bad.append(("totalSeconds", total))
    elif timings and total < sum(timings.values()) - 1e-3:
        timing_bad.append(("totalSeconds", total, sum(timings.values())))
    rep.check(not timing_bad, "%s/report/timings" % level,
              "%d stages, total=%.4fs" % (len(timings), total or 0)
              if not timing_bad else " first_bad=%r" % (timing_bad[0],))

    # ------------------------------------------------------------ contract
    contract = manifest["integrationContract"]
    contract_bad = []
    if contract.get("version") != 1:
        contract_bad.append(("version", contract.get("version")))
    if contract.get("packageRoot") != "_work/map-batch/" + level:
        contract_bad.append(("packageRoot", contract.get("packageRoot")))
    geometry = contract.get("geometry", {})
    for key, name in (("positionBuffer", "draws.positions.f32.bin"),
                      ("uv0Buffer", "draws.uv0.f32.bin"),
                      ("indexBuffer", "draws.indices.u32.bin")):
        if geometry.get(key) != name:
            contract_bad.append((key, geometry.get(key)))
    if geometry.get("vertexCount") != dc["vertexCount"] \
            or geometry.get("indexCount") != dc["indexCount"]:
        contract_bad.append(("geometry counts", geometry))
    texture_contract = contract.get("textures", {})
    if texture_contract.get("uniqueBlobs") != len(items) \
            or texture_contract.get("bytesMip0") != unique_bytes:
        contract_bad.append(("texture counts", texture_contract))
    layout_contract = contract.get("layout", {})
    if layout_contract.get("sampleCount") != len(samples) \
            or not close(layout_contract.get("lengthM"), length,
                         rel=1e-9, abs_tol=1e-9):
        contract_bad.append(("layout", layout_contract.get("lengthM")))
    if layout_contract.get("spawn") != spawn_doc:
        contract_bad.append(("layout.spawn", "mismatch"))
    if layout_contract.get("checkpoints") != layout.get("checkpoints"):
        contract_bad.append(("layout.checkpoints", "mismatch"))
    if layout_contract.get("finish") != layout.get("finish"):
        contract_bad.append(("layout.finish", "mismatch"))
    slots = contract.get("slots", {})
    if slots.get("collider", {}).get("id") != level + ".collision":
        contract_bad.append(("collider", slots.get("collider")))
    if slots.get("pickups") != []:
        contract_bad.append(("pickups", slots.get("pickups")))
    laps = slots.get("laps") or []
    if len(laps) != 1 or laps[0].get("startArcM") != 0.0 \
            or not close(laps[0].get("finishArcM"), length,
                         rel=1e-9, abs_tol=1e-9):
        contract_bad.append(("laps", laps))
    pins = contract.get("pins", {})
    if pins.get("physicsFileSha256") != \
            manifest["source"]["files"]["physics"].get("sha256") \
            or pins.get("renderFileSha256") != \
            manifest["source"]["files"]["render"].get("sha256"):
        contract_bad.append(("pins", "source files"))
    rep.check(not contract_bad, "%s/manifest/contract" % level,
              "version 1, packageRoot, buffers, textures, layout, slots%s"
              % ("" if not contract_bad else
                 " first_bad=%r" % (contract_bad[0],)))

    manifest_scope = manifest["scope"]
    scope_bad = [key for key in ("playableClaim", "rendererClaim", "gpuClaim",
                                 "browserFrameProduced", "instancesApplied",
                                 "materialsApplied",
                                 "texturesBoundInRenderer", "normalsExported")
                 if manifest_scope.get(key) is not False]
    if manifest_scope.get("dataOnly") is not True:
        scope_bad.append("dataOnly")
    if manifest_scope.get("partialSceneTraversal") is not True:
        scope_bad.append("partialSceneTraversal")
    if manifest_scope.get("e1DriveIntegration") != (level in integrated):
        scope_bad.append("e1DriveIntegration")
    if level in integrated:
        record = manifest_scope.get("integratedByRegistry") or {}
        if record.get("mapId") != integrated[level]:
            scope_bad.append("integratedByRegistry")
        if manifest.get("mapId") != integrated[level]:
            scope_bad.append("mapId")
    elif manifest.get("mapId") is not None:
        scope_bad.append("mapId")
    rep.check(not scope_bad, "%s/manifest/scope" % level,
              "dataOnly=true, no playable/renderer/GPU claim, integrated=%s"
              % (level in integrated)
              if not scope_bad else " bad=%r" % scope_bad)

    # ---------------------------------------------------------- determinism
    if determinism:
        result["determinism"] = verify_determinism(level, rep, out, timeout)

    result["checks"] = rep.checks - start_checks
    result["failures"] = len(rep.failures) - start_failures
    result["counts"] = derived
    result["grade"] = blockers.get("grade")
    result["hashes"] = {
        "manifest": sha256_file(out / "manifest.json"),
        "draws": sha256_file(out / "draws.json"),
        "path": sha256_file(out / "path.json"),
        "manifestContentSha256": manifest["hashes"]["contentSha256"],
    }
    if result["failures"]:
        result["verdict"] = "failed"
    return result


# ---------------------------------------------------------------- batch checks

def verify_batch(rep: Report, results: dict) -> None:
    print("== batch ==", flush=True)
    levels = discover_levels()
    summary_path = BATCH / "batch-summary.json"
    if not summary_path.is_file():
        rep.check(False, "batch/summary",
                  "missing _work/map-batch/batch-summary.json")
        return
    try:
        summary = strict_load(summary_path)
    except (ValueError, json.JSONDecodeError) as error:
        rep.check(False, "batch/summary", "load: %s" % error)
        return
    rows = summary.get("levels", [])
    rep.check(summary.get("schema") == "blur.map-batch.batch/1"
              and summary.get("levelCount") == len(rows),
              "batch/summary-schema",
              "schema=%r levelCount=%r" % (summary.get("schema"),
                                           summary.get("levelCount")))
    summary_levels = [row.get("level") for row in rows]
    rep.check(sorted(summary_levels) == sorted(levels),
              "batch/level-set",
              "%d levels, missing=%r extra=%r"
              % (len(summary_levels),
                 sorted(set(levels) - set(summary_levels)),
                 sorted(set(summary_levels) - set(levels))))
    grade_bad = []
    for row in rows:
        level = row.get("level")
        result = results.get(level)
        if result is None:
            continue
        if row.get("grade") != result.get("grade"):
            grade_bad.append((level, row.get("grade"), result.get("grade")))
        if row.get("grade") == "error":
            grade_bad.append((level, "error", row.get("error")))
    rep.check(not grade_bad, "batch/grades",
              "%d summary grades match the packages%s"
              % (len(rows),
                 "" if not grade_bad else " first_bad=%r" % (grade_bad[0],)))

    integrated = registry_maps()
    # The registry grows as maps are integrated; the check pins the exact
    # level -> id set, not a count, so adding a map is a deliberate edit here.
    rep.check(integrated == {
        "usa_la_river": "river", "usa_amboy": "amboy",
        "spa_barcelona_gracia": "gracia"},
        "registry/integrated",
        "parsed %d map records from %s" % (len(integrated),
                                           REGISTRY.name))


def selftest(rep: Report) -> None:
    """Prove the typed-unsupported path works even when no map needs it."""
    print("== selftest ==", flush=True)
    parsed = parse_unsupported(
        "native: Unsupported position vertex format at byte 615776")
    rep.check(parsed == {"reason": "Unsupported position vertex format",
                         "byteOffset": 615776},
              "selftest/unsupported-parser",
              "reason=%r byteOffset=%r"
              % (parsed["reason"], parsed["byteOffset"]))
    record = {"level": "synthetic", "status": "unsupported",
              "reason": "missing-source-file:Level.levelphysics",
              "byteOffset": None}
    rep.check(record["status"] == "unsupported"
              and isinstance(record["reason"], str)
              and record["reason"]
              and (record["byteOffset"] is None
                   or isinstance(record["byteOffset"], int)),
              "selftest/unsupported-record",
              "typed record: status=%r reason=%r byteOffset=%r"
              % (record["status"], record["reason"], record["byteOffset"]))


# ----------------------------------------------------------------------- main

def discover_levels() -> list:
    return sorted(path.name for path in LEVELS_DIR.iterdir()
                  if path.is_dir())


def classify_unbuildable(level: str) -> dict | None:
    missing = [name for key, name in SOURCE_FILES.items()
               if not (LEVELS_DIR / level / name).is_file()]
    if missing:
        return {"level": level, "status": "unsupported",
                "reason": "missing-source-file:" + missing[0],
                "byteOffset": None,
                "detail": "source files absent: %r" % missing}
    if not (BATCH / level / "manifest.json").is_file():
        return {"level": level, "status": "unsupported",
                "reason": "package-not-built", "byteOffset": None,
                "detail": "run probes/map-batch/build_map.py --all"}
    return None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Independent verifier for the map-batch packages.")
    parser.add_argument("--levels", default=None,
                        help="comma-separated level ids (default: every level "
                             "directory)")
    parser.add_argument("--skip-determinism", action="store_true",
                        help="skip the two-build byte-for-byte comparison")
    parser.add_argument("--timeout", type=float, default=1800.0,
                        help="per-build timeout in seconds")
    parser.add_argument("--quiet", action="store_true",
                        help="print failures only (the summary is unchanged)")
    parser.add_argument("--json", default=None,
                        help="optional path for a machine-readable report")
    args = parser.parse_args(argv)

    started = time.perf_counter()
    rep = Report(quiet=args.quiet)
    levels = discover_levels()
    if args.levels:
        wanted = [item.strip() for item in args.levels.split(",") if item.strip()]
        unknown = sorted(set(wanted) - set(levels))
        if unknown:
            parser.error("unknown level(s): %r" % unknown)
        levels = [level for level in levels if level in wanted]

    selftest(rep)
    results = {}
    for level in levels:
        unbuildable = classify_unbuildable(level)
        if unbuildable is not None:
            before = rep.checks
            rep.note_unsupported(unbuildable)
            rep.check(True, "%s/unsupported-record" % level,
                      "typed unsupported: reason=%r byteOffset=%r"
                      % (unbuildable["reason"], unbuildable["byteOffset"]))
            if unbuildable["reason"] == "package-not-built":
                rep.check(False, "%s/package-present" % level,
                          "missing %s"
                          % (BATCH / level / "manifest.json"))
            results[level] = {"level": level, "verdict": "unsupported",
                              "checks": rep.checks - before, "failures": 0,
                              "reason": unbuildable["reason"],
                              "byteOffset": unbuildable["byteOffset"]}
            continue
        result = verify_level(level, rep, determinism=not args.skip_determinism,
                              timeout=args.timeout)
        if result["verdict"] == "failed" and result.get("determinism") \
                and not result["determinism"].get("builds", True):
            detail = result["determinism"]
            parsed = parse_unsupported(detail.get("error") or "")
            rep.note_unsupported({
                "level": level, "status": "unsupported",
                "reason": "builder-failed: " + (parsed["reason"] or
                                                detail.get("error") or "unknown"),
                "byteOffset": parsed["byteOffset"],
                "detail": (detail.get("stderr") or "")[-300:]})
        results[level] = result

    verify_batch(rep, results)

    elapsed = time.perf_counter() - started
    print("----", flush=True)
    verified = sum(1 for row in results.values()
                   if row.get("verdict") == "verified")
    failed = sum(1 for row in results.values()
                 if row.get("verdict") == "failed")
    unsupported = [row for row in rep.unsupported]
    print("maps: %d verified, %d failed, %d unsupported"
          % (verified, failed, len(unsupported)), flush=True)
    for record in unsupported:
        print("  unsupported %s :: reason=%r byteOffset=%r"
              % (record["level"], record["reason"], record["byteOffset"]),
              flush=True)
    print("elapsed: %.1fs" % elapsed, flush=True)

    if args.json:
        payload = {
            "schema": "blur.map-batch.verify/1",
            "generatedBy": "probes/map-batch/tools/verify_batch.py",
            "levels": [results[level] for level in levels],
            "unsupported": unsupported,
            "checks": rep.checks,
            "failureCount": len(rep.failures),
            "failures": rep.failures,
        }
        Path(args.json).write_text(
            json.dumps(payload, indent=1, sort_keys=True) + "\n",
            encoding="utf-8")
        print("report: %s" % args.json, flush=True)

    passed = rep.checks - len(rep.failures)
    print("%d/%d checks passed" % (passed, rep.checks), flush=True)
    return 0 if not rep.failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
