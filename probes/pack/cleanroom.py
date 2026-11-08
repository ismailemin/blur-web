#!/usr/bin/env python
"""Clean-room test for a Blur Web pack (PACK1).

Copies the release folder to a fresh temp path, boots the bundled Node server
(no Python on the server side), fetches the index and a representative set of
chunks over HTTP, and compares every byte count and SHA-256 with
`manifest.json`. It then exercises the typed integrity failures on the *copy*:

  * missing file          -> PACK_INTEGRITY_MISSING
  * same-size byte edit   -> PACK_INTEGRITY_SHA256
  * edited manifest       -> PACK_MANIFEST_HASH

It also runs the bundled room service and a WebSocket room.create probe.
The source bundle is never modified; the temp copy is removed unless --keep.

Usage:
    python probes/pack/cleanroom.py
    python probes/pack/cleanroom.py --bundle _work/pack/release --keep
    python probes/pack/cleanroom.py --report _work/logs/pack/cleanroom.json

Exit codes: 0 pass, 1 a check failed, 2 usage/bundle missing.
"""

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACK_DIR = ROOT / "probes" / "pack"
DEFAULT_BUNDLE = ROOT / "_work" / "pack" / "release"
LOG_DIR = ROOT / "_work" / "logs" / "pack"


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


def pick_port(preferred):
    for port in range(preferred, preferred + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("no free port near " + str(preferred))


def wait_health(port, timeout=90):
    started = time.perf_counter()
    last = None
    while time.perf_counter() - started < timeout:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/_pack/health" % port,
                                        timeout=1) as response:
                return json.loads(response.read().decode("utf-8")), time.perf_counter() - started
        except Exception as error:  # noqa: BLE001 - retry until timeout
            last = error
            time.sleep(0.1)
    raise RuntimeError("health did not answer: " + str(last))


def fetch_hash(url, expected_bytes, expected_sha):
    request = urllib.request.Request(url, headers={"cache-control": "no-store"})
    digest = hashlib.sha256()
    total = 0
    with urllib.request.urlopen(request, timeout=30) as response:
        content_type = response.headers.get("content-type", "")
        content_length = response.headers.get("content-length")
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
            total += len(block)
        status = response.status
    actual = "sha256:" + digest.hexdigest()
    ok = status == 200 and total == expected_bytes and actual == expected_sha
    return {
        "url": url,
        "ok": ok,
        "status": status,
        "bytes": total,
        "expectedBytes": expected_bytes,
        "sha256": actual,
        "expectedSha256": expected_sha,
        "contentType": content_type,
        "contentLength": content_length,
    }


def http_get(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.status, response.read(), dict(response.headers)


def run_ws_probe(url, timeout=20):
    probe = subprocess.run(["node", str(PACK_DIR / "ws_probe.mjs"), url, "--timeout", "10000"],
                           cwd=str(ROOT), capture_output=True, text=True, timeout=timeout)
    payload = None
    for line in (probe.stdout or "").splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
    return {"ok": bool(probe.returncode == 0 and payload and payload.get("ok")),
            "exit": probe.returncode, "result": payload,
            "stderr": (probe.stderr or "")[-400:]}


def boot_negative(bundle, expected_code):
    port = pick_port(8842)
    started = time.perf_counter()
    process = subprocess.Popen(
        ["node", str(bundle / "server.mjs"), "--port", str(port), "--no-room", "--quiet"],
        cwd=str(bundle), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        out, err = process.communicate(timeout=30)
        timed_out = False
    except subprocess.TimeoutExpired:
        process.kill()
        out, err = process.communicate()
        timed_out = True
    elapsed = time.perf_counter() - started
    combined = (out or "") + (err or "")
    return {
        "ok": (not timed_out and process.returncode == 3 and expected_code in combined),
        "expectedCode": expected_code,
        "exit": process.returncode,
        "timedOut": timed_out,
        "seconds": round(elapsed, 3),
        "output": combined[-900:],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Clean-room test a Blur Web pack")
    parser.add_argument("--bundle", default=str(DEFAULT_BUNDLE))
    parser.add_argument("--report", default=None)
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    source = Path(args.bundle)
    if not source.is_dir() or not (source / "manifest.json").is_file():
        print("PACK_CLEANROOM_USAGE: bundle not found: " + str(source), file=sys.stderr)
        return 2

    manifest_before = sha256_file(source / "manifest.sha256")
    sample_before = sha256_file(source / "www" / "_work/e1-drive/spawn.json")
    manifest = load_json(source / "manifest.json")
    by_url = {entry["url"]: entry for entry in manifest["files"] if entry.get("url")}
    default_car = next((row["slug"] for row in manifest["cars"]
                        if by_url.get("/_work/e1-drive/cars/" + row["slug"] + ".geometry.json", {})
                        .get("preload")), manifest["cars"][0]["slug"])
    other_car = next(row["slug"] for row in manifest["cars"] if row["slug"] != default_car)
    ghost_url = next(url for url in sorted(by_url) if url.startswith("/ghosts/") and url != "/ghosts/index.json")

    wanted = [
        "/",
        "/index.html",
        "/_work/e1-drive/level.geometry.json",
        "/_work/e1-drive/car-bodies.index.json",
        "/_work/e1-drive/cars.json",
        "/_work/e1-drive/spawn.json",
        "/_work/e1-drive/sprint.json",
        "/_work/e1-drive/cars/" + default_car + ".geometry.json",
        "/_work/e1-drive/cars/" + other_car + ".geometry.json",
        "/ghosts/index.json",
        ghost_url,
        "/_work/e1-drive/module/e1_drive.wasm",
        "/_work/e1-drive/module/e1_drive.mjs",
        "/_work/e1-drive/amboy/map.json",
        "/_work/e1-drive/amboy/layout.json",
        "/_work/map-slice/amboy-render/render.json",
        "/_work/map-slice/amboy/slice.json",
        "/map-data/usa_amboy/Level.levelphysics",
        "/_work/audio/RaceV8_Engine_1500.wav",
        "/_work/powerups/powerups.json",
        "/_work/prop-collision/colliders-v2.json",
    ]
    wanted = [url for url in wanted if url in by_url]

    temp_root = Path(tempfile.mkdtemp(prefix="blur-pack-cleanroom-"))
    temp_bundle = temp_root / "bundle"
    result = {
        "schema": "blur-web.pack.cleanroom/1",
        "ok": False,
        "bundle": str(source),
        "temp": str(temp_root),
        "manifestSha256": "sha256:" + sha256_file(source / "manifest.json"),
        "buildStamp": manifest.get("buildStamp"),
        "fetched": {"ok": False, "count": 0, "bytes": 0, "hashes_ok": False, "rows": []},
        "unknown_url": {},
        "method": {},
        "ws": {},
        "negative": {},
        "bundle_unchanged": False,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    game_port = pick_port(8840)
    room_port = pick_port(8841)
    process = None
    try:
        shutil.copytree(source, temp_bundle, copy_function=shutil.copyfile)
        boot_started = time.perf_counter()
        process = subprocess.Popen(
            ["node", str(temp_bundle / "server.mjs"), "--port", str(game_port),
             "--with-room", "--room-port", str(room_port), "--quiet"],
            cwd=str(temp_bundle), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        health, health_seconds = wait_health(game_port)
        result["bootSeconds"] = round(time.perf_counter() - boot_started, 3)
        result["health"] = health

        rows = []
        for url in wanted:
            entry = by_url.get(url) or by_url.get("/")
            rows.append(fetch_hash("http://127.0.0.1:%d%s" % (game_port, url),
                                   entry["bytes"], entry["sha256"]))
        # /index.html is an alias for /; compare the two bodies.
        index_status, index_body, index_headers = http_get("http://127.0.0.1:%d/" % game_port)
        alias_status, alias_body, _alias_headers = http_get(
            "http://127.0.0.1:%d/index.html" % game_port)
        result["index"] = {
            "status": index_status,
            "bytes": len(index_body),
            "aliasStatus": alias_status,
            "aliasEqual": alias_body == index_body,
            "hasScene": b'id="scene"' in index_body,
            "hasApp": b"./app.js" in index_body,
            "contentType": index_headers.get("content-type", ""),
        }
        result["fetched"] = {
            "ok": all(row["ok"] for row in rows) and result["index"]["aliasEqual"] and
                  result["index"]["hasScene"] and result["index"]["hasApp"],
            "count": len(rows),
            "bytes": sum(row["bytes"] for row in rows),
            "hashes_ok": all(row["ok"] for row in rows),
            "rows": rows,
        }
        # Content-type spot checks.
        types = {row["url"]: row["contentType"] for row in rows}
        result["contentTypes"] = {
            "wasm": types.get("/_work/e1-drive/module/e1_drive.wasm"),
            "json": types.get("/_work/e1-drive/car-bodies.index.json"),
            "levelphysics": types.get("/map-data/usa_amboy/Level.levelphysics"),
        }

        # Unknown URL: the combined debug geometry is deliberately not shipped.
        try:
            http_get("http://127.0.0.1:%d/_work/e1-drive/geometry.json" % game_port, timeout=5)
            unknown = {"ok": False, "code": None}
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            unknown = {"ok": error.code == 404 and body.startswith("PACK_NOT_IN_MANIFEST"),
                       "status": error.code, "code": "PACK_NOT_IN_MANIFEST"
                       if body.startswith("PACK_NOT_IN_MANIFEST") else body.splitlines()[0]}
        result["unknown_url"] = unknown

        request = urllib.request.Request("http://127.0.0.1:%d/" % game_port, method="POST",
                                         data=b"x")
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                response.read()
            method = {"ok": False}
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            method = {"ok": error.code == 405 and "PACK_METHOD" in body,
                      "status": error.code, "code": "PACK_METHOD"}
        result["method"] = method

        result["ws"] = run_ws_probe("ws://127.0.0.1:%d/ws" % room_port)
        process.terminate()
        out, err = process.communicate(timeout=30)
        exit_code = process.returncode
        process = None
        result["serverExit"] = {"code": exit_code,
                                "stdout": (out or "")[-800:], "stderr": (err or "")[-800:]}

        # Negative integrity cases, on the temp copy only.
        spawn = temp_bundle / "www" / "_work/e1-drive/spawn.json"
        original_spawn = spawn.read_bytes()
        missing_path = spawn.with_suffix(".missing")
        spawn.rename(missing_path)
        result["negative"]["missing"] = boot_negative(temp_bundle, "PACK_INTEGRITY_MISSING")
        missing_path.rename(spawn)

        corrupted = bytearray(original_spawn)
        corrupted[len(corrupted) // 2] ^= 0xFF
        spawn.write_bytes(bytes(corrupted))
        result["negative"]["corrupt"] = boot_negative(temp_bundle, "PACK_INTEGRITY_SHA256")
        spawn.write_bytes(original_spawn)

        manifest_path = temp_bundle / "manifest.json"
        original_manifest = manifest_path.read_bytes()
        manifest_path.write_bytes(original_manifest + b"\n")
        result["negative"]["manifest"] = boot_negative(temp_bundle, "PACK_MANIFEST_HASH")
        manifest_path.write_bytes(original_manifest)

        result["bundle_unchanged"] = (
            sha256_file(source / "manifest.sha256") == manifest_before and
            sha256_file(source / "www" / "_work/e1-drive/spawn.json") == sample_before)
        result["ok"] = (
            result["fetched"]["ok"] and result["unknown_url"].get("ok") and
            result["method"].get("ok") and result["ws"].get("ok") and
            all(row.get("ok") for row in result["negative"].values()) and
            result["bundle_unchanged"])
    except Exception as error:  # noqa: BLE001 - report the failure
        result["error"] = "%s: %s" % (type(error).__name__, error)
    finally:
        if process is not None:
            try:
                process.kill()
                process.communicate(timeout=10)
            except Exception:  # noqa: BLE001
                pass
        if not args.keep:
            shutil.rmtree(temp_root, ignore_errors=True)
            result["tempRemoved"] = True
        else:
            result["tempRemoved"] = False

    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("PACK_CLEANROOM %s" % ("OK" if result["ok"] else "FAILED"))
        print("  bundle       %s" % source)
        print("  temp         %s%s" % (temp_root, " (kept)" if args.keep else " (removed)"))
        print("  boot         %s s" % result.get("bootSeconds"))
        print("  fetched      %d files / %d B" % (result["fetched"].get("count", 0),
                                                  result["fetched"].get("bytes", 0)))
        print("  hashes       %s" % result["fetched"].get("hashes_ok"))
        print("  unknown URL  %s" % result.get("unknown_url"))
        print("  websocket    %s" % (result.get("ws") or {}).get("result"))
        for name, row in (result.get("negative") or {}).items():
            print("  negative %-8s %s" % (name, row.get("ok")))
        print("  unchanged    %s" % result.get("bundle_unchanged"))
        if result.get("error"):
            print("  error        %s" % result["error"])
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
