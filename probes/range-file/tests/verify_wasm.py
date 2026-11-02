"""Build the range-file probe for wasm32 with the project Emscripten toolchain
and compare its JSON with the native executable.

NODERAWFS is used so the wasm module reads the installed files through bounded
seek/read calls. The module is not linked into the engine and no browser
storage/GPU path is exercised.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "probes/range-file/src"
DEFAULT_EMXX = ROOT / "_work/toolchains/emsdk/upstream/emscripten/em++.exe"
DEFAULT_WASM_DIR = ROOT / "_work/range-file-probe/wasm"
DEFAULT_NATIVE = ROOT / "_work/range-file-probe/build/range_probe.exe"
DEFAULT_GAME = ROOT / "game-data/Blur"
DEFAULT_OUT = ROOT / "_work/range-file-probe/wasm-comparison.json"

SOURCES = ["range_file.cpp", "pak_index_range.cpp", "level_index_range.cpp",
           "range_probe_cli.cpp"]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build(emxx: Path, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / "range_probe.js"
    command = [
        str(emxx), "-std=c++17", "-O2",
        *[str(SRC / name) for name in SOURCES],
        "-o", str(output),
        "-sNODERAWFS=1", "-sENVIRONMENT=node",
        "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=16777216",
        "-sMAXIMUM_MEMORY=268435456", "-sEXIT_RUNTIME=1",
    ]
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                               timeout=600, check=False)
    if completed.returncode:
        raise RuntimeError(f"wasm build failed:\n{completed.stdout}\n{completed.stderr}")
    return output


def find_level_render(directory: Path) -> Path | None:
    # Match the on-disk case; the installed levels mix Level and level.
    for entry in directory.iterdir():
        if entry.is_file() and entry.name.lower() == "level.levelrender":
            return entry
    return None


def run(executable: list[str], mode: str, path: Path) -> tuple[dict, str]:
    completed = subprocess.run([*executable, mode, str(path)], capture_output=True, text=True,
                               encoding="utf-8", timeout=600, check=False)
    if completed.returncode:
        raise RuntimeError(f"{mode} {path}: exit {completed.returncode}: "
                           f"{(completed.stdout + completed.stderr)[:800]}")
    return json.loads(completed.stdout), completed.stdout


def compare_one(native: list[str], wasm: list[str], mode: str, path: Path) -> dict:
    native_result, native_raw = run(native, mode, path)
    wasm_result, wasm_raw = run(wasm, mode, path)
    _, wasm_again = run(wasm, mode, path)
    mismatches: list[str] = []
    if native_result.get("status") != "ok" or wasm_result.get("status") != "ok":
        mismatches.append("status")
    if mode == "pak":
        if native_result["header"] != wasm_result["header"]:
            mismatches.append("header")
        if native_result["entries"] != wasm_result["entries"]:
            mismatches.append("entries")
        records = len(native_result.get("entries", []))
    else:
        for field in ("resourceBlockCount", "initiallyLoadedBlocks", "streamChunks", "metadata"):
            if native_result[field] != wasm_result[field]:
                mismatches.append(field)
        records = len(native_result.get("streamChunks", []))
    if native_result["rangeRead"] != wasm_result["rangeRead"]:
        mismatches.append("rangeRead")
    if wasm_raw != wasm_again:
        mismatches.append("wasm_determinism")
    return {
        "file": str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else path.name,
        "mode": mode,
        "status": "pass" if not mismatches else "fail",
        "mismatches": mismatches,
        "records_compared": records,
        "native_sha256": sha256(native_raw.encode("utf-8")),
        "wasm_sha256": sha256(wasm_raw.encode("utf-8")),
        "range": wasm_result.get("rangeRead", {}),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emxx", type=Path, default=DEFAULT_EMXX)
    parser.add_argument("--wasm-dir", type=Path, default=DEFAULT_WASM_DIR)
    parser.add_argument("--native", type=Path, default=DEFAULT_NATIVE)
    parser.add_argument("--game-dir", type=Path, default=DEFAULT_GAME)
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    emxx = args.emxx.resolve(strict=True)
    native = args.native.resolve(strict=True)
    wasm = (args.wasm_dir / "range_probe.js").resolve()
    if not args.skip_build:
        wasm = build(emxx, args.wasm_dir.resolve()).resolve()
    if not wasm.exists():
        raise SystemExit(f"missing wasm output: {wasm}")
    game = args.game_dir.resolve(strict=True)
    paks = sorted((game / "cache").glob("*.pak"))
    levels = sorted(path for path in
                    (find_level_render(child) for child in (game / "levels").iterdir()
                     if child.is_dir()) if path is not None)
    if not paks or not levels:
        raise SystemExit("missing PAK or level inputs")

    wasm_runner = ["node", str(wasm)]
    reports = []
    for path in paks:
        try:
            reports.append(compare_one([str(native)], wasm_runner, "pak", path.resolve()))
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
            reports.append({"file": path.name, "mode": "pak", "status": "fail",
                            "error": str(error)})
        print(f"PAK   {reports[-1]['file']}: {reports[-1]['status']}", flush=True)
    for path in levels:
        try:
            reports.append(compare_one([str(native)], wasm_runner, "level", path.resolve()))
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
            reports.append({"file": path.name, "mode": "level", "status": "fail",
                            "error": str(error)})
        print(f"LEVEL {reports[-1]['file']}: {reports[-1]['status']}", flush=True)

    passed = all(row["status"] == "pass" for row in reports)
    report = {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "status": "pass" if passed else "fail",
        "scope": "wasm32 parity for the range-file index probe via Node NODERAWFS. "
                 "No engine link, browser storage or GPU path.",
        "toolchain": str(emxx),
        "native_executable": str(native),
        "native_executable_sha256": sha256(native.read_bytes()),
        "wasm_js": str(wasm),
        "wasm_js_sha256": sha256(wasm.read_bytes()),
        "wasm_binary": str(wasm.with_suffix(".wasm")),
        "wasm_binary_bytes": wasm.with_suffix(".wasm").stat().st_size,
        "memory": {"initial_bytes": 16777216, "maximum_bytes": 268435456,
                   "allow_growth": True},
        "checks": reports,
        "totals": {"paks": sum(row["mode"] == "pak" for row in reports),
                   "levels": sum(row["mode"] == "level" for row in reports),
                   "records": sum(row.get("records_compared", 0) for row in reports)},
    }
    output = args.out.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {output}")
    print(f"RESULT: {'PASS' if passed else 'FAIL'}")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
