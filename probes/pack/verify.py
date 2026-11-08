#!/usr/bin/env python
"""Verify a Blur Web pack against its manifest and the working tree.

Checks (>= 150; the per-file checks alone are > 1,000):

  * manifest schema, hashes, counts, groups, car/map attribution;
  * every entry: path safety, source existence, size, SHA-256;
  * chunk/index pins, roster fields pins, ghost index pins, map registry pins;
  * required runtime URLs and the six engine audio loops;
  * no game-data/upstream/_work-pack leakage, no debug/capture artifacts;
  * no absolute paths, no secrets, no extra files in the release folder;
  * deterministic build stamp: two fixed-stamp manifest-only builds are
    byte-identical, the derived stamp matches, and a pack-version change
    produces a different stamp;
  * a clean-room run (copy to a temp folder, boot, fetch, hash, negative
    integrity cases) unless --skip-cleanroom is passed.

Usage:
    python probes/pack/verify.py
    python probes/pack/verify.py --bundle _work/pack/release
    python probes/pack/verify.py --skip-cleanroom
    python probes/pack/verify.py --json _work/logs/pack/verify.json

Exit codes: 0 all checks pass, 1 a check failed, 2 usage/bundle missing.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACK_DIR = ROOT / "probes" / "pack"
DEFAULT_BUNDLE = ROOT / "_work" / "pack" / "release"
LOG_DIR = ROOT / "_work" / "logs" / "pack"
PYTHON = sys.executable

FORBIDDEN_PATH = re.compile(
    r"(^|/)(geometry\.json$|packet[^/]*\.json$|run[^/]*\.json$|state[^/]*\.json$|"
    r"telemetry[^/]*\.json$|soak[^/]*\.json$|reset-cycles\.json$|browser[^/]*|"
    r"[^/]*\.png$|[^/]*\.o$|[^/]*\.symbols$|e1_drive_(a|b|debug)\.(wasm|mjs)$)"
)
ABSOLUTE = re.compile(r"((?<![A-Za-z0-9])[A-Za-z]:[\\/]|/Users/|/home/[^/]+/|file://|ismailemin)", re.IGNORECASE)
SECRET = re.compile(r"(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|"
                    r"\bghp_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9]{20,}\b|"
                    r"(password|secret|api[_-]?key)\s*[:=]\s*['\"][^'\"]{8,})", re.IGNORECASE)


def sha256_file(path, chunk=1024 * 1024):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


class Report:
    def __init__(self):
        self.checks = []
        self.failures = []
        self.notes = []

    def check(self, name, condition, detail=""):
        ok = bool(condition)
        self.checks.append({"name": name, "ok": ok, "detail": detail})
        if not ok:
            self.failures.append({"name": name, "detail": detail})
        return ok

    def equal(self, name, actual, expected):
        return self.check(name, actual == expected,
                          "" if actual == expected else "expected %r, got %r" % (expected, actual))

    def note(self, text):
        self.notes.append(text)

    @property
    def counts(self):
        return {"checks": len(self.checks),
                "pass": len(self.checks) - len(self.failures),
                "fail": len(self.failures)}


def safe_rel(value):
    value = str(value).replace("\\", "/")
    if not value or value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        return False
    return not any(part in ("", ".", "..") for part in value.split("/"))


def extract_block(text, start_marker, end_marker):
    start = text.find(start_marker)
    if start < 0:
        return ""
    end = text.find(end_marker, start)
    return text[start:end if end >= 0 else len(text)]


def pin(text, key):
    match = re.search(re.escape(key) + r"\s*:\s*'(sha256:[0-9a-f]{64})'", text)
    return match.group(1) if match else None


def number(text, key):
    match = re.search(re.escape(key) + r"\s*:\s*([0-9]+)", text)
    return int(match.group(1)) if match else None


def index_by_url(manifest):
    return {entry["url"]: entry for entry in manifest["files"] if entry.get("url")}


def verify_manifest(report, bundle, manifest, manifest_sha, target):
    report.equal("manifest.schema", manifest.get("schema"), "blur-web.pack")
    report.equal("manifest.schemaVersion", manifest.get("schemaVersion"), 1)
    report.equal("manifest.target", manifest.get("target"), target)
    report.check("manifest.packVersion", re.fullmatch(r"[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[a-z0-9]+",
                 str(manifest.get("packVersion"))), str(manifest.get("packVersion")))
    report.check("manifest.buildStamp", re.fullmatch(r"b1-[0-9a-f]{24}",
                 str(manifest.get("buildStamp"))), str(manifest.get("buildStamp")))
    report.check("manifest.stampSource", manifest.get("stampSource") in ("derived", "override"))
    report.equal("manifest.contentRoot", manifest.get("contentRoot"),
                 "www" if target == "release" else "../../..")
    report.check("manifest.deterministic", manifest.get("deterministic") is True)
    report.check("manifest.tool.version", bool((manifest.get("tool") or {}).get("version")))

    files = manifest.get("files") or []
    report.check("manifest.files.nonempty", len(files) >= 150, "%d files" % len(files))
    report.equal("manifest.counts.files", manifest.get("counts", {}).get("files"), len(files))
    report.equal("manifest.counts.bytes", manifest.get("counts", {}).get("bytes"),
                 sum(e.get("bytes", 0) for e in files))
    report.equal("manifest.totals.files", manifest.get("totals", {}).get("files"), len(files))
    report.equal("manifest.totals.bytes", manifest.get("totals", {}).get("bytes"),
                 sum(e.get("bytes", 0) for e in files))

    urls = [e["url"] for e in files if e.get("url")]
    paths = [e["path"] for e in files]
    report.equal("manifest.urls.unique", len(urls), len(set(urls)))
    report.equal("manifest.paths.unique", len(paths), len(set(paths)))
    report.check("manifest.urls.have_index",
                 any(e.get("url") == "/" and str(e.get("path", "")).endswith("index.html")
                     for e in files))
    report.check("manifest.control.entries", sum(1 for e in files if e.get("kind") == "control") == 6)

    # Required URLs declared in the manifest.
    declared = set(manifest.get("requiredUrls") or [])
    report.check("manifest.requiredUrls", len(declared) >= 30, "%d declared" % len(declared))
    for url in declared:
        report.check("required-url:" + url, url in set(urls))

    # Group totals.
    group_rows = {row["id"]: row for row in manifest.get("groups") or []}
    report.check("manifest.groups.nonempty", bool(group_rows))
    group_files = {}
    group_bytes = {}
    for entry in files:
        group_files[entry["group"]] = group_files.get(entry["group"], 0) + 1
        group_bytes[entry["group"]] = group_bytes.get(entry["group"], 0) + entry["bytes"]
    for group, row in group_rows.items():
        report.equal("group.%s.files" % group, row.get("files"), group_files.get(group, 0))
        report.equal("group.%s.bytes" % group, row.get("bytes"), group_bytes.get(group, 0))
    report.equal("groups.sum.files", sum(r["files"] for r in group_rows.values()), len(files))
    report.equal("groups.sum.bytes", sum(r["bytes"] for r in group_rows.values()),
                 manifest["counts"]["bytes"])

    # Preload block.
    preload = manifest.get("preload") or {}
    preload_entries = [e for e in files if e.get("preload")]
    report.equal("preload.files", preload.get("files"), len(preload_entries))
    report.equal("preload.bytes", preload.get("bytes"), sum(e["bytes"] for e in preload_entries))
    report.check("preload.reasonable", 5 <= preload.get("files", 0) < len(files))

    # Largest files table.
    largest = manifest.get("largestFiles") or []
    expected_largest = sorted(files, key=lambda e: (-e["bytes"], e.get("url") or e["path"]))[:20]
    report.equal("largest.count", len(largest), 20)
    report.equal("largest.first", largest[0]["url"] if largest else None,
                 expected_largest[0].get("url") if expected_largest else None)
    report.check("largest.sorted", [row["bytes"] for row in largest] ==
                 sorted((row["bytes"] for row in largest), reverse=True))
    report.equal("largest.top.bytes", largest[0]["bytes"] if largest else None,
                 expected_largest[0]["bytes"] if expected_largest else None)

    report.check("excluded.nonempty", len(manifest.get("excluded") or []) >= 10)
    patterns = " ".join(row.get("pattern", "") for row in manifest.get("excluded") or [])
    for needle in ("geometry.json", "game-data", "packet", "_work/audio", "longbeach"):
        report.check("excluded.mentions:" + needle, needle in patterns)

    # No absolute path or secret in the manifest text.
    text = Path(bundle / "manifest.json").read_text(encoding="utf-8")
    report.check("manifest.no-absolute-path", not ABSOLUTE.search(text),
                 (ABSOLUTE.search(text).group(0) if ABSOLUTE.search(text) else ""))
    report.check("manifest.no-secret", not SECRET.search(text))

    report.check("manifest.self-hash", re.fullmatch(r"[0-9a-f]{64}", manifest_sha),
                 manifest_sha[:16] + "...")
    digest_line = (Path(bundle) / "manifest.sha256").read_text(encoding="utf-8").split()
    report.equal("manifest.sha256.line", digest_line[0] if digest_line else None, manifest_sha)


def verify_files(report, bundle, manifest):
    content_root = (Path(bundle) / manifest["contentRoot"]).resolve()
    for entry in manifest["files"]:
        path = entry.get("path")
        prefix = "file." + (entry.get("url") or path)
        report.check(prefix + ".path-safe", safe_rel(path), str(path))
        report.check(prefix + ".bytes-int", isinstance(entry.get("bytes"), int) and entry["bytes"] >= 0)
        report.check(prefix + ".sha-format", bool(re.fullmatch(r"sha256:[0-9a-f]{64}",
                                                              str(entry.get("sha256")))))
        if entry.get("kind") == "control":
            file_path = Path(bundle) / path
        else:
            file_path = content_root / path
        exists = file_path.is_file()
        report.check(prefix + ".exists", exists, str(file_path))
        if not exists:
            continue
        actual_bytes = file_path.stat().st_size
        report.equal(prefix + ".size", actual_bytes, entry["bytes"])
        report.equal(prefix + ".sha256", "sha256:" + sha256_file(file_path), entry["sha256"])
        source = entry.get("source")
        report.check(prefix + ".source-relative", safe_rel(source), str(source))
        report.check(prefix + ".source-exists", (ROOT / source).is_file(), str(source))
        if entry.get("url"):
            if manifest.get("target") == "release":
                expected_path = "index.html" if entry["url"] == "/" else entry["url"].lstrip("/")
                report.equal(prefix + ".url-path", path, expected_path)
            else:
                report.equal(prefix + ".dev-path", path, entry.get("source"))


def verify_pins(report, manifest):
    by_url = index_by_url(manifest)
    index_doc = load_json(ROOT / "_work/e1-drive/car-bodies.index.json")
    roster_doc = load_json(ROOT / "_work/e1-drive/cars.json")
    ghost_doc = load_json(ROOT / "probes/e1-drive/ghosts/index.json")

    # Level/base/index/debug pins from the chunk index.
    for name, key in (("level.geometry.json", "level"),
                      ("base.geometry.json", "base"),
                      ("geometry.json", "debug")):
        record = index_doc.get(key) or {}
        if key == "debug":
            report.check("pin.debug.not-shipped", "/_work/e1-drive/geometry.json" not in by_url)
            continue
        entry = by_url.get("/_work/e1-drive/" + name)
        report.check("pin.%s.present" % key, entry is not None)
        if entry:
            report.equal("pin.%s.sha256" % key, entry["sha256"], record.get("sha256"))
            report.equal("pin.%s.bytes" % key, entry["bytes"], record.get("bytes"))

    # Car chunks and fields.
    index_cars = index_doc.get("cars") or {}
    roster_cars = {row.get("slug"): row for row in (roster_doc.get("roster") or {}).get("cars") or []}
    manifest_cars = {row["slug"]: row for row in manifest.get("cars") or []}
    report.equal("cars.count", len(index_cars), 25)
    report.equal("cars.manifest.count", len(manifest_cars), len(index_cars))
    report.equal("cars.default", index_doc.get("defaultCar"), "corvette-zr1-stock")
    for slug, record in sorted(index_cars.items()):
        chunk_name = Path(record.get("file") or ("cars/" + slug + ".geometry.json")).name
        chunk = by_url.get("/_work/e1-drive/cars/" + chunk_name)
        fields_url = "/_work/e1-drive/cars/" + slug + ".fields"
        fields = by_url.get(fields_url)
        report.check("car.%s.chunk" % slug, chunk is not None)
        report.check("car.%s.fields" % slug, fields is not None)
        if chunk:
            report.equal("car.%s.chunk.sha256" % slug, chunk["sha256"], record.get("sha256"))
            report.equal("car.%s.chunk.bytes" % slug, chunk["bytes"], record.get("bytes"))
        roster = roster_cars.get(slug) or {}
        fields_info = roster.get("fields") or {}
        if fields:
            report.equal("car.%s.fields.sha256" % slug,
                         entry_sha := fields["sha256"].split(":")[-1],
                         str(fields_info.get("sha256") or "").split(":")[-1])
            report.equal("car.%s.fields.bytes" % slug, fields["bytes"], fields_info.get("bytes"))
            report.check("car.%s.fields.url" % slug, fields_url in by_url)
        row = manifest_cars.get(slug) or {}
        report.equal("car.%s.manifest.chunkBytes" % slug, row.get("chunkBytes"),
                     record.get("bytes"))
        report.equal("car.%s.manifest.fieldsBytes" % slug, row.get("fieldsBytes"),
                     (fields_info or {}).get("bytes"))
        report.check("car.%s.preload" % slug,
                     bool(chunk and chunk.get("preload")) == (slug == index_doc.get("defaultCar")))

    # Ghost index: all 50 traces are shipped with the recorded hashes.
    ghost_files = 0
    for slug, courses in sorted((ghost_doc.get("cars") or {}).items()):
        for course, info in sorted(courses.items()):
            ghost_files += 1
            name = Path(info.get("file") or ("probes/e1-drive/ghosts/" + slug + "-" + course + ".json")).name
            entry = by_url.get("/ghosts/" + name)
            report.check("ghost.%s.%s.present" % (slug, course), entry is not None)
            if entry:
                report.equal("ghost.%s.%s.sha256" % (slug, course), entry["sha256"], info.get("sha256"))
                report.equal("ghost.%s.%s.bytes" % (slug, course), entry["bytes"], info.get("bytes"))
    report.equal("ghosts.count", ghost_files, 50)
    report.check("ghosts.index", "/ghosts/index.json" in by_url)

    # Map registry pins, parsed from the committed registry.
    registry_text = (ROOT / "probes/e1-drive/web/map-registry.js").read_text(encoding="utf-8")
    registry = {
        "river": extract_block(registry_text, "river: Object.freeze({", "amboy: Object.freeze({"),
        "amboy": extract_block(registry_text, "amboy: Object.freeze({", "gracia: Object.freeze({"),
        "gracia": extract_block(registry_text, "gracia: Object.freeze({", "\n});"),
    }
    report.check("registry.river", "id: 'river'" in registry["river"])
    report.check("registry.amboy", "id: 'amboy'" in registry["amboy"])
    report.check("registry.gracia", "id: 'gracia'" in registry["gracia"])
    river_package = pin(registry["river"], "packageFileSha256")
    river_layout = pin(registry["river"], "layoutFileSha256")
    river_physics = pin(registry["river"], "physicsFileSha256")
    report.check("registry.river.pins", all((river_package, river_layout, river_physics)))
    if river_package:
        report.equal("pin.river.level", by_url["/_work/e1-drive/level.geometry.json"]["sha256"],
                     river_package)
    if river_layout:
        report.equal("pin.river.layout", by_url["/_work/e1-drive/sprint.json"]["sha256"], river_layout)
    if river_physics:
        report.equal("pin.river.physics",
                     by_url["/_work/e1-drive/Level.levelphysics"]["sha256"], river_physics)
    for map_id in ("amboy", "gracia"):
        block = registry[map_id]
        map_pin = pin(block, "mapFileSha256")
        layout_pin = pin(block, "layoutFileSha256")
        physics_pin = pin(block, "physicsFileSha256")
        render_pin = pin(block, "renderFileSha256")
        slice_pin = pin(block, "sliceFileSha256")
        report.check("registry.%s.pins" % map_id,
                     all((map_pin, layout_pin, physics_pin, render_pin, slice_pin)))
        if map_pin:
            report.equal("pin.%s.map" % map_id,
                         by_url["/_work/e1-drive/" + map_id + "/map.json"]["sha256"], map_pin)
        if layout_pin:
            report.equal("pin.%s.layout" % map_id,
                         by_url["/_work/e1-drive/" + map_id + "/layout.json"]["sha256"], layout_pin)
        level = load_json(ROOT / "_work/e1-drive" / map_id / "map.json").get("level")
        if physics_pin and level:
            report.equal("pin.%s.physics" % map_id,
                         by_url["/map-data/" + level + "/Level.levelphysics"]["sha256"], physics_pin)
        if render_pin:
            report.check("pin.%s.render" % map_id,
                         any(entry["sha256"] == render_pin for entry in manifest["files"]))
        if slice_pin:
            report.check("pin.%s.slice" % map_id,
                         any(entry["sha256"] == slice_pin for entry in manifest["files"]))

    # Map documents must point at the shipped source docs.
    for map_id in ("amboy", "gracia"):
        doc = load_json(ROOT / "_work/e1-drive" / map_id / "map.json")
        source = doc.get("source") or {}
        for key in ("render", "slice", "diagnostics"):
            record = source.get(key) or {}
            url = "/" + str(record.get("path") or "")
            entry = by_url.get(url)
            report.check("mapdoc.%s.%s.present" % (map_id, key), entry is not None)
            if entry:
                report.equal("mapdoc.%s.%s.sha256" % (map_id, key), entry["sha256"],
                             record.get("sha256"))
        report.check("mapdoc.%s.level" % map_id, bool(doc.get("level")))

    # Runtime page sanity.
    page_dir = ROOT / "probes/e1-drive/web"
    index_text = (page_dir / "index.html").read_text(encoding="utf-8")
    report.check("page.index.scene", 'id="scene"' in index_text)
    report.check("page.index.app", "./app.js" in index_text)
    report.check("page.app.engine-module", "/_work/e1-drive/module/e1_drive.mjs" in
                 (page_dir / "app.js").read_text(encoding="utf-8"))
    for name in ("app.js", "style.css", "geometry-chunks.js", "map-registry.js",
                 "mp-client.js", "powerups.js", "prop-layer.js", "engine-audio.js"):
        if name == "engine-audio.js":
            report.check("page.audio-module", "/audio/engine-audio.js" in
                         (page_dir / "app.js").read_text(encoding="utf-8"))
        else:
            report.check("page.module." + name, (page_dir / name).is_file())


def verify_leaks(report, bundle, manifest):
    files = manifest["files"]
    for entry in files:
        path = entry.get("path") or ""
        url = entry.get("url") or ""
        path_ok = not path.startswith(("upstream/", "_work/pack/", "probes/pack/_work"))
        if manifest.get("target") == "release":
            path_ok = path_ok and not path.startswith("game-data/")
        elif path.startswith("game-data/"):
            path_ok = path_ok and path.endswith(("usa_amboy/Level.levelphysics",
                                                 "spa_barcelona_gracia/Level.levelphysics"))
        report.check("leak.path." + (url or path), path_ok)
        report.check("leak.pattern." + (url or path), not FORBIDDEN_PATH.search(url or path))
        source = entry.get("source") or ""
        if source.startswith("game-data/"):
            report.check("leak.game-data.allowed." + url,
                         any(source.endswith(level + "/Level.levelphysics")
                             for level in ("usa_amboy", "spa_barcelona_gracia")))
    # No extra files in the release folder.
    allowed = {entry["path"] for entry in files if entry.get("kind") == "control"}
    if manifest.get("target") == "release":
        allowed |= {(manifest["contentRoot"] + "/" + entry["path"]).replace("\\", "/")
                    for entry in files if entry.get("kind") != "control"}
    allowed |= {"manifest.json", "manifest.sha256"}
    actual = set()
    for path in Path(bundle).rglob("*"):
        if path.is_file():
            actual.add(path.relative_to(bundle).as_posix())
    report.equal("bundle.no-extra-files", actual, allowed)
    report.check("bundle.under-work-pack", str(Path(bundle).resolve()).startswith(
        str((ROOT / "_work/pack").resolve())))

    # Control text sanity.
    server = (Path(bundle) / "server.mjs").read_text(encoding="utf-8")
    for needle in ("manifest.sha256", "PACK_INTEGRITY_MISSING", "PACK_INTEGRITY_SHA256",
                   "PACK_NOT_IN_MANIFEST", "startRoomServer", "verifyEntries"):
        report.check("server.contains:" + needle, needle in server)
    report.check("server.no-absolute", not ABSOLUTE.search(server))
    readme = (Path(bundle) / "README.txt").read_text(encoding="utf-8")
    for needle in ("http://127.0.0.1:8830/", "mp=1&host=1", "mp=1&room=<CODE>",
                   "mpServer=", "8811", "start.cmd", "start.sh", "PACK_INTEGRITY"):
        report.check("readme.contains:" + needle, needle in readme)
    cmd = (Path(bundle) / "start.cmd").read_text(encoding="utf-8")
    sh = (Path(bundle) / "start.sh").read_text(encoding="utf-8")
    report.check("launcher.cmd.node", "node \"%~dp0server.mjs\"" in cmd)
    report.check("launcher.cmd.ports", "--port 8830" in cmd and "--room-port 8811" in cmd)
    report.check("launcher.sh.shebang", sh.startswith("#!/bin/sh"))
    report.check("launcher.sh.node", "exec node \"$DIR/server.mjs\"" in sh)
    report.check("launcher.sh.ports", "--port 8830" in sh and "--room-port 8811" in sh)
    report.check("launcher.no-absolute", not ABSOLUTE.search(cmd + sh))

    # build.json agrees with the manifest.
    build = load_json(Path(bundle) / "build.json")
    report.equal("build.target", build.get("target"), manifest.get("target"))
    report.equal("build.stamp", build.get("buildStamp"), manifest.get("buildStamp"))
    report.equal("build.files", (build.get("counts") or {}).get("files"),
                 manifest.get("counts", {}).get("files"))
    report.equal("build.bytes", (build.get("counts") or {}).get("bytes"),
                 manifest.get("counts", {}).get("bytes"))


def run_build(args, timeout=180):
    command = [PYTHON, str(PACK_DIR / "build.py")] + list(args)
    return subprocess.run(command, cwd=str(ROOT), capture_output=True, text=True, timeout=timeout)


def verify_determinism(report, target):
    base = ROOT / "_work" / "pack" / "_verify"
    if base.exists():
        shutil.rmtree(base)
    base.mkdir(parents=True)
    a = base / "a"
    b = base / "b"
    c = base / "c"
    fixed = "verifier-stamp-2026-11-08"
    first = run_build(["--target", target, "--manifest-only", "--out", str(a),
                       "--stamp", fixed])
    second = run_build(["--target", target, "--manifest-only", "--out", str(b),
                        "--stamp", fixed])
    report.equal("determinism.first.exit", first.returncode, 0)
    report.equal("determinism.second.exit", second.returncode, 0)
    if first.returncode == 0 and second.returncode == 0:
        for name in ("manifest.json", "manifest.sha256", "build.json", "README.txt", "VERSION"):
            report.equal("determinism.byte-identical." + name,
                         sha256_file(a / name), sha256_file(b / name))
        manifest_a = load_json(a / "manifest.json")
        report.equal("determinism.fixed-stamp", manifest_a.get("buildStamp"), fixed)
        report.equal("determinism.fixed-source", manifest_a.get("stampSource"), "override")
    # Derived stamp must equal the recorded default stamp and change with the
    # pack version.
    derived = run_build(["--target", target, "--manifest-only",
                         "--out", str(base / "derived"), "--json"])
    other = run_build(["--target", target, "--manifest-only", "--out", str(c),
                       "--pack-version", "2099.01.01-verifier", "--json"])
    report.equal("determinism.derived.exit", derived.returncode, 0)
    report.equal("determinism.other.exit", other.returncode, 0)
    if derived.returncode == 0:
        payload = json.loads(derived.stdout)
        report.equal("determinism.derived.eq-stamp", payload.get("buildStamp"),
                     payload.get("derivedStamp"))
        report.equal("determinism.derived.source", payload.get("stampSource"), "derived")
    if derived.returncode == 0 and other.returncode == 0:
        left = json.loads(derived.stdout)
        right = json.loads(other.stdout)
        report.check("determinism.version-changes-stamp",
                     left.get("buildStamp") != right.get("buildStamp"),
                     "%s vs %s" % (left.get("buildStamp"), right.get("buildStamp")))
    report.note("determinism evidence: %s" % base)


def run_cleanroom(report, bundle):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    result_path = LOG_DIR / "cleanroom-latest.json"
    command = [PYTHON, str(PACK_DIR / "cleanroom.py"), "--bundle", str(bundle),
               "--report", str(result_path)]
    result = subprocess.run(command, cwd=str(ROOT), capture_output=True, text=True, timeout=600)
    report.equal("cleanroom.exit", result.returncode, 0)
    report.check("cleanroom.report", result_path.is_file())
    if result_path.is_file():
        data = load_json(result_path)
        report.check("cleanroom.ok", data.get("ok") is True)
        report.check("cleanroom.fetched", (data.get("fetched") or {}).get("ok") is True,
                     str((data.get("fetched") or {}).get("count")))
        report.check("cleanroom.hashes", (data.get("fetched") or {}).get("hashes_ok") is True)
        report.check("cleanroom.unknown-url", data.get("unknown_url", {}).get("code") == "PACK_NOT_IN_MANIFEST")
        report.check("cleanroom.ws", (data.get("ws") or {}).get("ok") is True,
                     str(data.get("ws")))
        for name in ("missing", "corrupt", "manifest"):
            row = (data.get("negative") or {}).get(name) or {}
            report.check("cleanroom.negative." + name, row.get("ok") is True,
                         str(row))
        report.check("cleanroom.source-unchanged", data.get("bundle_unchanged") is True)
        report.note("cleanroom: %d files / %d B fetched, %s" % (
            (data.get("fetched") or {}).get("count", 0),
            (data.get("fetched") or {}).get("bytes", 0),
            data.get("temp", "")))
    if result.returncode != 0:
        report.note("cleanroom stderr: " + (result.stderr or "")[-800:])


def main(argv=None):
    parser = argparse.ArgumentParser(description="Verify a Blur Web pack")
    parser.add_argument("--bundle", default=str(DEFAULT_BUNDLE))
    parser.add_argument("--skip-cleanroom", action="store_true")
    parser.add_argument("--json", default=None)
    args = parser.parse_args(argv)

    bundle = Path(args.bundle)
    if not bundle.is_dir():
        print("PACK_VERIFY_USAGE: bundle not found: " + str(bundle), file=sys.stderr)
        return 2
    manifest_path = bundle / "manifest.json"
    digest_path = bundle / "manifest.sha256"
    if not manifest_path.is_file() or not digest_path.is_file():
        print("PACK_VERIFY_USAGE: manifest.json/manifest.sha256 missing", file=sys.stderr)
        return 2

    report = Report()
    manifest_bytes = manifest_path.read_bytes()
    actual_sha = hashlib.sha256(manifest_bytes).hexdigest()
    expected_sha = digest_path.read_text(encoding="utf-8").split()[0]
    report.equal("manifest.bytes-hash", actual_sha, expected_sha)
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    target = manifest.get("target")

    verify_manifest(report, bundle, manifest, actual_sha, target)
    verify_files(report, bundle, manifest)
    verify_pins(report, manifest)
    verify_leaks(report, bundle, manifest)
    verify_determinism(report, target)
    if not args.skip_cleanroom and target == "release":
        run_cleanroom(report, bundle)
    elif target != "release":
        report.note("cleanroom applies to the release target only")
    else:
        report.note("cleanroom skipped (--skip-cleanroom)")

    counts = report.counts
    payload = {
        "schema": "blur-web.pack.verify/1",
        "bundle": str(bundle),
        "manifestSha256": "sha256:" + actual_sha,
        "buildStamp": manifest.get("buildStamp"),
        "files": manifest.get("counts", {}).get("files"),
        "bytes": manifest.get("counts", {}).get("bytes"),
        "counts": counts,
        "failures": report.failures,
        "notes": report.notes,
    }
    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print("PACK_VERIFY %s checks=%d pass=%d fail=%d" % (
        "OK" if not report.failures else "FAILED", counts["checks"], counts["pass"], counts["fail"]))
    print("  bundle        %s" % bundle)
    print("  manifest      sha256:%s" % actual_sha)
    print("  buildStamp    %s" % manifest.get("buildStamp"))
    print("  files/bytes   %d / %d" % (manifest.get("counts", {}).get("files", 0),
                                        manifest.get("counts", {}).get("bytes", 0)))
    for failure in report.failures[:40]:
        print("  FAIL %s %s" % (failure["name"], failure["detail"]))
    if len(report.failures) > 40:
        print("  ... %d more failures" % (len(report.failures) - 40))
    for note in report.notes:
        print("  note %s" % note)
    return 0 if not report.failures else 1


if __name__ == "__main__":
    sys.exit(main())
