#!/usr/bin/env python
"""Build a distributable Blur Web bundle (PACK1).

The builder reads the working tree, never writes to it, and emits one of two
targets under `_work/pack/`:

  release  a self-contained folder: static site + generated chunks/textures/
           ghosts + map packages + the room service + manifest + launchers.
  dev      a manifest + server + launchers that serve the working tree in
           place (no asset copy).

Every shipped byte is hashed into `manifest.json`; `manifest.sha256` pins the
manifest itself. The runtime server verifies both before it listens and refuses
unknown URLs, so a missing or edited asset is a typed boot failure rather than
a silent fallback.

Determinism: the build stamp is derived from the ordered (url, bytes, sha256)
list by default. `--stamp` overrides the recorded value for CI; the rest of the
manifest is unchanged.

Usage:
    python probes/pack/build.py --target release
    python probes/pack/build.py --target dev
    python probes/pack/build.py --target release --manifest-only
    python probes/pack/build.py --target release --stamp ci-2026-11-08

Exit codes: 0 ok, 1 missing/invalid source asset, 2 usage, 3 copy/hash failure.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACK_DIR = ROOT / "probes" / "pack"
WORK = ROOT / "_work" / "e1-drive"
WORK_PACK = ROOT / "_work" / "pack"

SCHEMA = "blur-web.pack"
SCHEMA_VERSION = 1
TOOL_VERSION = "1.0.0"
PACK_VERSION = "2026.11.08-pack1"

# The six retail Race_V8 RPM loops the page's engine-audio module fetches.
ENGINE_WAVES = (
    "RaceV8_Engine_1500.wav",
    "RaceV8_Engine_1995.wav",
    "RaceV8_Engine_3015.wav",
    "RaceV8_Engine_4005.wav",
    "RaceV8_Engine_4995.wav",
    "RaceV8_Engine_6000.wav",
)

# Runtime NetClient + room service modules. The selftest/harness/capture tools
# are development-only and are not shipped.
NET_MVP_FILES = (
    "client.mjs",
    "hash.mjs",
    "protocol.mjs",
    "race.mjs",
    "server.mjs",
    "README.md",
    "web/app.js",
    "web/index.html",
    "web/solo.html",
    "web/solo.js",
    "web/style.css",
)

POWERUP_RULES_FILES = ("engine.js", "projectiles.js")

EXCLUSIONS = [
    ("_work/e1-drive/geometry.json",
     "combined pre-chunking debug artifact (181 MB); the page never fetches it"),
    ("_work/e1-drive/packet*.json, run*.json, sprint-<car>.json, sprint-<car>-*.json, state*.json, telemetry*.json, soak*.json, reset-cycles.json, browser*.json, *.png",
     "build/verify/capture traces, not runtime assets"),
    ("_work/e1-drive/track-uv.bin, car-uv-*.bin, track-textures.json, car-textures.json, level-instance-textures.json, track.json, course.json, corridor-*.json/html",
     "build inputs already embedded in the level/car chunks, or survey/diagnostic records"),
    ("_work/e1-drive/module/e1_drive_{a,b,debug}.*, *.o, *.symbols",
     "determinism/debug build products; only e1_drive.mjs + e1_drive.wasm ship"),
    ("_work/map-slice/*/{textures,raw,instance-chunks,instance-native}/**, longbeach*, *-repeat, amboy-textures*",
     "raw package inputs and maps outside the committed registry (river/amboy/gracia)"),
    ("_work/audio/*", "only the six Race_V8 engine loops + engine-model.json are fetched; the other 1,200 decoded files are not runtime assets"),
    ("game-data/**", "read-only installed game tree; only the three Level.levelphysics byte files the page fetches are copied, under www/map-data/"),
    ("upstream/**, _work/pack/**, .git/**", "read-only reference / build output / repository metadata"),
    ("probes/net-mvp/{selftest,harness,capture}.mjs", "development test tools; the runtime client, protocol and room service ship"),
    ("probes/powerups/rules/{supershield.js,*.test.mjs,tests.mjs}", "not imported by the page; engine.js + projectiles.js ship"),
    ("probes/ai-driver/**", "Node tools; the browser copy probes/e1-drive/web/ai-driver-browser.js ships"),
    ("probes/prop-collision/{tools/**,README.md}", "only lib/*.mjs is imported at runtime"),
]

REQUIRED_URLS = (
    "/",
    "/app.js",
    "/style.css",
    "/_work/e1-drive/level.geometry.json",
    "/_work/e1-drive/base.geometry.json",
    "/_work/e1-drive/car-bodies.index.json",
    "/_work/e1-drive/cars.json",
    "/_work/e1-drive/spawn.json",
    "/_work/e1-drive/sprint.json",
    "/_work/e1-drive/sprint-short.json",
    "/_work/e1-drive/sprint-lap.json",
    "/_work/e1-drive/sprint-free.json",
    "/_work/e1-drive/Level.levelphysics",
    "/_work/e1-drive/module/e1_drive.mjs",
    "/_work/e1-drive/module/e1_drive.wasm",
    "/_work/e1-drive/amboy/map.json",
    "/_work/e1-drive/amboy/layout.json",
    "/_work/e1-drive/gracia/map.json",
    "/_work/e1-drive/gracia/layout.json",
    "/ghosts/index.json",
    "/net-mvp/server.mjs",
    "/race-rules/index.mjs",
    "/powerups/engine.js",
    "/powerups/projectiles.js",
    "/_work/powerups/powerups.json",
    "/_work/powerups/projectiles.json",
    "/prop-collision/lib/resolver.mjs",
    "/_work/prop-collision/colliders-v2.json",
    "/_work/free-roam-prop/colliders-r04-v2.json",
    "/map-data/usa_amboy/Level.levelphysics",
    "/map-data/spa_barcelona_gracia/Level.levelphysics",
)

CONTROL_FILES = (
    ("server.mjs", "pack-server"),
    ("start.cmd", "windows-launcher"),
    ("start.sh", "linux-launcher"),
    ("README.txt", "user-steps"),
    ("VERSION", "version"),
    ("build.json", "build-record"),
)


def rel(path):
    return Path(path).resolve().relative_to(ROOT).as_posix()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path, chunk=1024 * 1024):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def file_size(path):
    return Path(path).stat().st_size


def safe_rel(value):
    value = str(value).replace("\\", "/")
    if not value or value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        return False
    return not any(part in ("", ".", "..") for part in value.split("/"))


class Bundle:
    def __init__(self, target):
        self.target = target
        self.entries = []
        self._urls = {}
        self.missing = []
        self.default_car = None
        self.cars = []
        self.ghost_by_car = {}

    def add(self, url, source, group, role, *, preload=False, car=None,
            map_id=None, kind="asset", control_path=None):
        if url is not None and not url.startswith("/"):
            raise ValueError("url must start with /: " + url)
        source_path = Path(source)
        if control_path is None and not source_path.is_file():
            self.missing.append(rel(source_path) if source_path.is_absolute() else source_path.as_posix())
            return None
        if url is not None and url in self._urls:
            raise ValueError("duplicate url " + url + " (" + self._urls[url]["source"] +
                             " vs " + str(source) + ")")
        entry = {
            "url": url,
            "path": control_path,
            "source": rel(source_path) if source_path.is_absolute() and source_path.exists()
            else source_path.as_posix(),
            "bytes": file_size(source_path) if control_path is None else 0,
            "sha256": "sha256:" + sha256_file(source_path) if control_path is None else "",
            "group": group,
            "role": role,
            "kind": kind,
            "preload": bool(preload),
        }
        if car is not None:
            entry["car"] = car
        if map_id is not None:
            entry["map"] = map_id
        entry["_control_path"] = control_path
        self.entries.append(entry)
        if url is not None:
            self._urls[url] = entry
        return entry

    def add_tree(self, source_dir, url_prefix, group, role, *, preload=False,
                 include=None, map_id=None):
        base = Path(source_dir)
        if not base.is_dir():
            self.missing.append(rel(base))
            return
        for path in sorted(p for p in base.rglob("*") if p.is_file()):
            relative = path.relative_to(base).as_posix()
            if include is not None and not include(relative):
                continue
            if url_prefix == "/":
                url = "/" if relative == "index.html" else "/" + relative
            else:
                url = url_prefix.rstrip("/") + "/" + relative
            self.add(url, path, group, role, preload=preload, map_id=map_id)


def build_entries(target):
    bundle = Bundle(target)
    index_path = WORK / "car-bodies.index.json"
    if not index_path.is_file():
        raise SystemExit("PACK_BUILD_MISSING: " + rel(index_path))
    index_doc = json.loads(index_path.read_text(encoding="utf-8"))
    names = {row.get("slug"): row.get("name")
             for row in (index_doc.get("roster") or {}).get("cars", [])}
    cars = sorted((index_doc.get("cars") or {}).items())
    bundle.cars = [(slug, {**record, "name": names.get(slug)}) for slug, record in cars]
    bundle.default_car = index_doc.get("defaultCar") or (cars[0][0] if cars else None)

    # --- page, committed modules, data -------------------------------------
    bundle.add_tree(ROOT / "probes/e1-drive/web", "/", "page", "page", preload=True)
    bundle.add_tree(ROOT / "probes/e1-drive/ghosts", "/ghosts", "ghosts", "reference-ghost")
    bundle.add_tree(ROOT / "probes/audio/web", "/audio", "audio", "engine-audio-runtime")

    for name in NET_MVP_FILES:
        role = "room-service" if name == "server.mjs" else "room-client"
        bundle.add("/net-mvp/" + name, ROOT / "probes/net-mvp" / name, "net-mvp", role)
    bundle.add_tree(ROOT / "probes/race-rules", "/race-rules", "race-rules", "race-rules",
                    include=lambda name: name.endswith(".mjs"))
    for name in POWERUP_RULES_FILES:
        bundle.add("/powerups/" + name, ROOT / "probes/powerups/rules" / name,
                   "powerups", "powerup-rules")
    bundle.add_tree(ROOT / "probes/prop-collision/lib", "/prop-collision/lib",
                    "prop-collision", "prop-resolver",
                    include=lambda name: name.endswith(".mjs"))

    for name, role in (("powerups.json", "powerup-manifest"),
                       ("projectiles.json", "projectile-manifest")):
        bundle.add("/_work/powerups/" + name, ROOT / "_work/powerups" / name, "powerups", role)
    bundle.add("/_work/prop-collision/colliders-v2.json",
               ROOT / "_work/prop-collision/colliders-v2.json",
               "prop-collision", "prop-colliders")
    bundle.add("/_work/free-roam-prop/colliders-r04-v2.json",
               ROOT / "_work/free-roam-prop/colliders-r04-v2.json",
               "prop-collision", "free-roam-colliders")

    # --- River runtime assets ---------------------------------------------
    for name, role in (
        ("level.geometry.json", "level-chunk"),
        ("base.geometry.json", "map-base-chunk"),
        ("car-bodies.index.json", "car-chunk-index"),
        ("cars.json", "car-roster"),
        ("spawn.json", "spawn"),
        ("sprint.json", "layout-310m"),
        ("sprint-short.json", "layout-short"),
        ("sprint-lap.json", "layout-lap"),
        ("sprint-free.json", "layout-free"),
        ("Level.levelphysics", "physics"),
    ):
        bundle.add("/_work/e1-drive/" + name, WORK / name, "river", role, preload=True)
    for name, role in (("e1_drive.mjs", "wasm-glue"),
                       ("e1_drive.wasm", "wasm-module"),
                       ("build.json", "module-build-record")):
        bundle.add("/_work/e1-drive/module/" + name, WORK / "module" / name,
                   "river", role, preload=True)

    # --- cars: every roster chunk + fields, ghosts attributed by slug ------
    ghost_by_car = {}
    ghost_dir = ROOT / "probes/e1-drive/ghosts"
    for path in sorted(ghost_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        for slug, _record in cars:
            if path.name in (slug + "-310m.json", slug + "-short.json"):
                ghost_by_car[slug] = ghost_by_car.get(slug, 0) + file_size(path)
                break
    bundle.ghost_by_car = ghost_by_car
    for slug, record in cars:
        preload = slug == bundle.default_car
        chunk_name = Path(record.get("file") or ("cars/" + slug + ".geometry.json")).name
        bundle.add("/_work/e1-drive/cars/" + chunk_name, WORK / "cars" / chunk_name,
                   "cars", "car-chunk", preload=preload, car=slug)
        bundle.add("/_work/e1-drive/cars/" + slug + ".fields", WORK / "cars" / (slug + ".fields"),
                   "cars", "car-fields", preload=preload, car=slug)

    # --- maps: only the registry maps, sourced from the map documents ------
    for map_id in ("amboy", "gracia"):
        map_dir = WORK / map_id
        map_doc_path = map_dir / "map.json"
        layout_path = map_dir / "layout.json"
        if not map_doc_path.is_file() or not layout_path.is_file():
            bundle.missing.extend(rel(p) for p in (map_doc_path, layout_path) if not p.is_file())
            continue
        map_doc = json.loads(map_doc_path.read_text(encoding="utf-8"))
        bundle.add("/_work/e1-drive/" + map_id + "/map.json", map_doc_path,
                   "map:" + map_id, "map-package", map_id=map_id)
        bundle.add("/_work/e1-drive/" + map_id + "/layout.json", layout_path,
                   "map:" + map_id, "map-layout", map_id=map_id)
        source = map_doc.get("source") or {}
        for key, role in (("render", "map-render-source"),
                          ("slice", "map-slice-source"),
                          ("diagnostics", "map-diagnostics")):
            record = source.get(key) or {}
            source_path = record.get("path")
            if not source_path:
                bundle.missing.append(map_id + ".source." + key)
                continue
            bundle.add("/" + source_path, ROOT / source_path, "map:" + map_id, role,
                       map_id=map_id)
        level = map_doc.get("level") or ""
        physics_source = (source.get("physics") or {}).get("path")
        if level and physics_source:
            bundle.add("/map-data/" + level + "/Level.levelphysics",
                       ROOT / physics_source, "map:" + map_id, "map-physics", map_id=map_id)
        else:
            bundle.missing.append(map_id + ".source.physics")

    # --- audio: the six engine loops + their model reference ----------------
    for name in ENGINE_WAVES:
        bundle.add("/_work/audio/" + name, ROOT / "_work/audio" / name,
                   "audio", "engine-loop")
    bundle.add("/_work/audio/engine-model.json", ROOT / "_work/audio/engine-model.json",
               "audio", "engine-model")

    # --- runtime control files (content generated by write_control_files) ---
    for name, role in CONTROL_FILES:
        bundle.add(None, PACK_DIR / "server.mjs" if name == "server.mjs" else PACK_DIR / "build.py",
                   "control", role, kind="control", control_path=name)

    bundle.missing = sorted(set(bundle.missing))
    return bundle


def derive_stamp(entries, target, pack_version):
    digest = hashlib.sha256()
    digest.update(("schema=" + SCHEMA + "/" + str(SCHEMA_VERSION) + "\n").encode("utf-8"))
    digest.update(("target=" + target + "\n").encode("utf-8"))
    digest.update(("pack=" + pack_version + "\n").encode("utf-8"))
    for entry in sorted((e for e in entries if e.get("url")), key=lambda item: item["url"]):
        digest.update((entry["url"] + "\t" + str(entry["bytes"]) + "\t" +
                       entry["sha256"] + "\n").encode("utf-8"))
    return "b1-" + digest.hexdigest()[:24]


def group_totals(entries):
    groups = {}
    for entry in entries:
        group = entry["group"]
        row = groups.setdefault(group, {"id": group, "files": 0, "bytes": 0})
        row["files"] += 1
        row["bytes"] += entry["bytes"]
    return [groups[key] for key in sorted(groups)]


def car_totals(bundle, entries):
    rows = {}
    for slug, record in bundle.cars:
        rows[slug] = {
            "slug": slug,
            "name": record.get("name"),
            "files": 0,
            "bytes": 0,
            "chunkBytes": 0,
            "fieldsBytes": 0,
            "ghostBytes": bundle.ghost_by_car.get(slug, 0),
            "draws": record.get("draws"),
            "textures": record.get("textures"),
        }
    for entry in entries:
        slug = entry.get("car")
        if not slug or slug not in rows:
            continue
        row = rows[slug]
        row["files"] += 1
        row["bytes"] += entry["bytes"]
        if entry["role"] == "car-chunk":
            row["chunkBytes"] = entry["bytes"]
        elif entry["role"] == "car-fields":
            row["fieldsBytes"] = entry["bytes"]
    return [rows[slug] for slug in sorted(rows)]


def map_totals(entries):
    rows = {}
    for entry in entries:
        map_id = entry.get("map")
        if not map_id:
            continue
        row = rows.setdefault(map_id, {"id": map_id, "files": 0, "bytes": 0, "parts": {}})
        row["files"] += 1
        row["bytes"] += entry["bytes"]
        row["parts"][entry["role"]] = row["parts"].get(entry["role"], 0) + entry["bytes"]
    river = [e for e in entries if e["group"] == "river"]
    if river:
        rows["river"] = {"id": "river", "files": len(river),
                         "bytes": sum(e["bytes"] for e in river), "parts": {}}
    return [rows[key] for key in sorted(rows)]


def preload_summary(entries):
    rows = [e for e in entries if e.get("preload") and e.get("url")]
    return {"files": len(rows), "bytes": sum(e["bytes"] for e in rows),
            "urls": sorted(e["url"] for e in rows)}


def readme_text(target, manifest):
    lines = [
        "Blur Web - %s pack" % target,
        "",
        "Version: %s" % manifest["packVersion"],
        "Build stamp: %s" % manifest["buildStamp"],
        "Files: %d" % manifest["counts"]["files"],
        "Bytes: %d" % manifest["counts"]["bytes"],
        "",
        "RUN (Windows)",
        "  start.cmd",
        "",
        "RUN (Linux / macOS)",
        "  sh start.sh",
        "",
        "Then open: http://127.0.0.1:8830/",
        "",
        "Single player modes:",
        "  http://127.0.0.1:8830/",
        "  http://127.0.0.1:8830/?course=lap",
        "  http://127.0.0.1:8830/?course=free",
        "  http://127.0.0.1:8830/?map=amboy&script=sprint",
        "  http://127.0.0.1:8830/?map=gracia&script=sprint",
        "",
        "Multiplayer, localhost (room service starts with the launcher on 8811):",
        "  host:  http://127.0.0.1:8830/?mp=1&host=1",
        "  guest: http://127.0.0.1:8830/?mp=1&room=<CODE>",
        "",
        "Multiplayer, another machine:",
        "  host:  http://<host-ip>:8830/?mp=1&host=1",
        "  guest: http://<host-ip>:8830/?mp=1&room=<CODE>",
        "  The page connects to ws://<host-ip>:8811/ws by default.",
        "  If the room port is different, append: &mpServer=ws://<host-ip>:<port>/ws",
        "  Allow inbound TCP 8830 and 8811 on the host firewall.",
        "",
        "Integrity:",
        "  The server verifies manifest.json against manifest.sha256 and every",
        "  listed file before it listens. A missing or edited file stops the boot",
        "  with PACK_INTEGRITY_MISSING / PACK_INTEGRITY_SIZE / PACK_INTEGRITY_SHA256.",
        "  Requests for files that are not in the manifest return 404 with",
        "  PACK_NOT_IN_MANIFEST; there is no silent fallback.",
        "",
        "No Python, npm install, database or build step is required to run this folder.",
    ]
    if target == "dev":
        lines.insert(2, "Dev target: serves the working tree in place; do not move this folder.")
        lines.insert(3, "")
    return "\n".join(lines) + "\n"


def launcher_cmd():
    return (
        "@echo off\r\n"
        "setlocal\r\n"
        "where node >nul 2>nul\r\n"
        "if errorlevel 1 (\r\n"
        "  echo PACK LAUNCH FAILED: Node.js is required on PATH.\r\n"
        "  exit /b 2\r\n"
        ")\r\n"
        "node \"%~dp0server.mjs\" --port 8830 --with-room --room-port 8811 %*\r\n"
    )


def launcher_sh():
    return (
        "#!/bin/sh\n"
        "set -eu\n"
        "if ! command -v node >/dev/null 2>&1; then\n"
        "  echo \"PACK LAUNCH FAILED: Node.js is required on PATH.\" >&2\n"
        "  exit 2\n"
        "fi\n"
        "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n"
        "exec node \"$DIR/server.mjs\" --port 8830 --with-room --room-port 8811 \"$@\"\n"
    )


def write_control_files(out, target, manifest):
    texts = {
        "VERSION": (
            "Blur Web pack\n"
            "schema: %s/%d\n"
            "pack: %s\n"
            "target: %s\n"
            "buildStamp: %s\n"
            "files: %d\n"
            "bytes: %d\n" % (
                SCHEMA, SCHEMA_VERSION, manifest["packVersion"], target,
                manifest["buildStamp"], manifest["counts"]["files"],
                manifest["counts"]["bytes"],
            )
        ),
        "README.txt": readme_text(target, manifest),
        "start.cmd": launcher_cmd(),
        "start.sh": launcher_sh(),
        "build.json": json.dumps({
            "schema": "blur-web.pack.build/1",
            "tool": {"name": "probes/pack/build.py", "version": TOOL_VERSION},
            "target": target,
            "packVersion": manifest["packVersion"],
            "buildStamp": manifest["buildStamp"],
            "stampSource": manifest["stampSource"],
            "counts": manifest["counts"],
            "totals": manifest["totals"],
            "manifestFile": "manifest.json",
            "manifestShaFile": "manifest.sha256",
        }, indent=2) + "\n",
    }
    records = {}
    for name, text in texts.items():
        path = Path(out) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        records[name] = {"path": name, "bytes": path.stat().st_size,
                         "sha256": "sha256:" + sha256_bytes(path.read_bytes())}
    return records


def build_manifest(bundle, target, pack_version, stamp_override=None):
    # Ensure control entries carry their final path before stamp derivation.
    for entry in bundle.entries:
        if entry["kind"] == "control":
            entry["path"] = entry["_control_path"]
        elif target == "release":
            entry["path"] = "index.html" if entry["url"] == "/" else entry["url"].lstrip("/")
        else:
            entry["path"] = entry["source"]
    derived = derive_stamp(bundle.entries, target, pack_version)
    stamp = stamp_override or derived
    counts = {"files": len(bundle.entries),
              "bytes": sum(e["bytes"] for e in bundle.entries)}
    largest = sorted(bundle.entries, key=lambda e: (-e["bytes"], e.get("url") or e["path"]))[:20]
    manifest = {
        "schema": SCHEMA,
        "schemaVersion": SCHEMA_VERSION,
        "tool": {"name": "probes/pack/build.py", "version": TOOL_VERSION},
        "target": target,
        "packVersion": pack_version,
        "buildStamp": stamp,
        "stampSource": "override" if stamp_override else "derived",
        "contentRoot": "www" if target == "release" else "../../..",
        "deterministic": True,
        "counts": counts,
        "totals": {"bytes": counts["bytes"], "files": counts["files"]},
        "groups": group_totals(bundle.entries),
        "cars": car_totals(bundle, bundle.entries),
        "maps": map_totals(bundle.entries),
        "preload": preload_summary(bundle.entries),
        "largestFiles": [
            {"url": e.get("url"), "path": e["path"], "bytes": e["bytes"],
             "sha256": e["sha256"], "group": e["group"], "role": e["role"]}
            for e in largest
        ],
        "requiredUrls": list(REQUIRED_URLS),
        "excluded": [{"pattern": p, "reason": r} for p, r in EXCLUSIONS],
        "files": [],
    }
    for entry in bundle.entries:
        clean = {key: value for key, value in entry.items() if not key.startswith("_")}
        manifest["files"].append(clean)
    manifest["files"].sort(key=lambda e: (e.get("url") or "~" + e["path"]))
    return manifest, derived


def write_bundle(bundle, out, target, pack_version, stamp_override, manifest_only):
    out = Path(out)
    tmp = out.parent / (out.name + ".tmp-" + str(os.getpid()))
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)

    # Seed control files so the first manifest has real hashes.
    seed = {"packVersion": pack_version, "buildStamp": "", "stampSource": "",
            "counts": {"files": 0, "bytes": 0}, "totals": {"bytes": 0, "files": 0}}
    control = write_control_files(tmp, target, seed)
    shutil.copyfile(PACK_DIR / "server.mjs", tmp / "server.mjs")
    server_path = tmp / "server.mjs"
    control["server.mjs"] = {"path": "server.mjs", "bytes": server_path.stat().st_size,
                             "sha256": "sha256:" + sha256_bytes(server_path.read_bytes())}
    for entry in bundle.entries:
        if entry["kind"] == "control":
            record = control[entry["_control_path"]]
            entry["bytes"] = record["bytes"]
            entry["sha256"] = record["sha256"]

    manifest, derived = build_manifest(bundle, target, pack_version, stamp_override)

    if not manifest_only and target == "release":
        for entry in manifest["files"]:
            if entry["kind"] == "control":
                continue
            source = ROOT / entry["source"]
            target_path = tmp / manifest["contentRoot"] / entry["path"]
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target_path)
            if target_path.stat().st_size != entry["bytes"] or \
                    "sha256:" + sha256_file(target_path) != entry["sha256"]:
                raise SystemExit("PACK_BUILD_COPY_MISMATCH: " + entry["source"])

    # Converge build.json/VERSION/README hashes with the final counts. Each
    # pass only changes build.json if a digit count changed.
    for _pass in range(6):
        control = write_control_files(tmp, target, manifest)
        server_path = tmp / "server.mjs"
        control["server.mjs"] = {"path": "server.mjs", "bytes": server_path.stat().st_size,
                                 "sha256": "sha256:" + sha256_bytes(server_path.read_bytes())}
        changed = False
        for entry in manifest["files"]:
            if entry["kind"] != "control":
                continue
            record = control[entry["path"]]
            if entry["bytes"] != record["bytes"] or entry["sha256"] != record["sha256"]:
                entry["bytes"] = record["bytes"]
                entry["sha256"] = record["sha256"]
                changed = True
        manifest["counts"] = {"files": len(manifest["files"]),
                              "bytes": sum(e["bytes"] for e in manifest["files"])}
        manifest["totals"] = {"bytes": manifest["counts"]["bytes"],
                              "files": manifest["counts"]["files"]}
        manifest["groups"] = group_totals(manifest["files"])
        if not changed:
            break
    else:
        raise SystemExit("PACK_BUILD_UNSTABLE: control hashes did not converge")

    manifest_text = json.dumps(manifest, indent=2, ensure_ascii=True) + "\n"
    manifest_path = tmp / "manifest.json"
    manifest_path.write_text(manifest_text, encoding="utf-8", newline="\n")
    manifest_sha = sha256_bytes(manifest_path.read_bytes())
    (tmp / "manifest.sha256").write_text(manifest_sha + "  manifest.json\n",
                                         encoding="utf-8", newline="\n")

    if out.exists():
        shutil.rmtree(out)
    os.replace(tmp, out)
    return manifest, derived, manifest_sha


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build the Blur Web pack")
    parser.add_argument("--target", choices=("release", "dev"), default="release")
    parser.add_argument("--out", default=None)
    parser.add_argument("--pack-version", default=PACK_VERSION)
    parser.add_argument("--stamp", default=None)
    parser.add_argument("--manifest-only", action="store_true",
                        help="write manifest/control files without copying assets")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    out = Path(args.out) if args.out else WORK_PACK / args.target
    bundle = build_entries(args.target)
    if bundle.missing:
        print("PACK_BUILD_MISSING: required source assets are missing:", file=sys.stderr)
        for item in bundle.missing:
            print("  " + item, file=sys.stderr)
        return 1

    manifest, derived, manifest_sha = write_bundle(
        bundle, out, args.target, args.pack_version, args.stamp, args.manifest_only)
    summary = {
        "schema": "blur-web.pack.build-summary/1",
        "target": args.target,
        "out": str(out),
        "packVersion": manifest["packVersion"],
        "buildStamp": manifest["buildStamp"],
        "stampSource": manifest["stampSource"],
        "derivedStamp": derived,
        "manifestSha256": "sha256:" + manifest_sha,
        "files": manifest["counts"]["files"],
        "bytes": manifest["counts"]["bytes"],
        "groups": manifest["groups"],
        "cars": len(manifest["cars"]),
        "maps": len(manifest["maps"]),
        "preload": manifest["preload"],
        "largestFiles": manifest["largestFiles"][:10],
        "manifestOnly": bool(args.manifest_only),
    }
    if args.json:
        print(json.dumps(summary, indent=2))
    elif not args.quiet:
        print("PACK_BUILD OK target=%s out=%s" % (args.target, out))
        print("  packVersion   %s" % manifest["packVersion"])
        print("  buildStamp    %s (%s)" % (manifest["buildStamp"], manifest["stampSource"]))
        print("  files         %d" % manifest["counts"]["files"])
        print("  bytes         %d (%.2f MiB)" % (manifest["counts"]["bytes"],
                                                 manifest["counts"]["bytes"] / (1024 * 1024)))
        print("  manifest      sha256:%s" % manifest_sha)
        print("  preload       %d files / %d B" % (manifest["preload"]["files"],
                                                   manifest["preload"]["bytes"]))
        if not args.manifest_only:
            print("  launch        %s" % (out / ("start.cmd" if os.name == "nt" else "start.sh")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
