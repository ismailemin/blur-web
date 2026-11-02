"""Compare the range-file probe with existing full-file probes and a Python reference.

Read-only. Every compared file is an installed reference asset. The script
starts the existing native probes and the new probe, never modifies inputs and
never opens the game.

Checks per file:
  * range probe output equals the existing full-file probe (record by record)
  * two runs of the range probe are byte-identical (determinism)
  * a 4 KiB window produces the same records (window independence)
  * no whole-file copy is reported and every source request stays in the window
  * for V2 PAKs, the independent Python PAK index agrees as well
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_PROBE = ROOT / "_work/range-file-probe/build/range_probe.exe"
DEFAULT_NATIVE = ROOT / "_work/build/asset-reader-native/Release"
DEFAULT_GAME = ROOT / "game-data/Blur"
DEFAULT_OUT = ROOT / "_work/range-file-probe/reference-comparison.json"

PAK_HEADER_FIELDS = (
    "version", "sectorSize", "codec", "codecName", "codecFlags", "fatEntryType",
    "fileCount", "stringTableBytes", "metadataBytes", "fileBytes", "endian",
)
PAK_ENTRY_FIELDS = (
    "index", "path", "pathCrc", "isDirectory", "logicalBytes", "physicalBytes",
    "dataOffset", "parentIndex",
)
PY_PAK_FIELDS = ("index", "path", "isDirectory", "logicalBytes", "physicalBytes", "dataOffset")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run_json(arguments: list[str], timeout: int = 180) -> tuple[dict, str]:
    completed = subprocess.run(arguments, capture_output=True, text=True, encoding="utf-8",
                               timeout=timeout, check=False)
    if completed.returncode:
        raise RuntimeError(f"{Path(arguments[0]).name} failed ({completed.returncode}): "
                           f"{(completed.stdout + completed.stderr)[:800]}")
    return json.loads(completed.stdout), completed.stdout


def run_probe(probe: Path, mode: str, path: Path, window: int) -> tuple[dict, str]:
    result, raw = run_json([str(probe), mode, str(path), "--window", str(window)])
    if result.get("status") != "ok":
        raise RuntimeError(f"{mode} {path.name}: {result.get('error')}")
    return result, raw


def check_range_stats(result: dict, window: int, file_size: int, error: str) -> None:
    stats = result.get("rangeRead")
    if not stats:
        raise RuntimeError("rangeRead statistics missing")
    if stats["windowBytes"] != window:
        raise RuntimeError(f"reported window {stats['windowBytes']} != requested {window}")
    if stats["largestSourceRequest"] > window:
        raise RuntimeError(f"source request {stats['largestSourceRequest']} exceeds window")
    if stats["fullFileBytesCopied"] != 0:
        raise RuntimeError("whole-file copy was reported")
    if stats["sourceRequests"] == 0:
        raise RuntimeError("no source requests were issued")
    if stats["bytesRead"] > file_size:
        raise RuntimeError("bytes read exceeds file size")
    if error and stats["bytesRead"] >= file_size:
        raise RuntimeError(f"{error}: range parser read the whole file")


def compare_pak(path: Path, probe: Path, pak_ref: Path, python_index, window: int,
                small_window: int) -> dict:
    result, raw = run_probe(probe, "pak", path, window)
    _, raw_again = run_probe(probe, "pak", path, window)
    deterministic = raw == raw_again
    if not deterministic:
        raise RuntimeError("two range-probe runs produced different bytes")
    small, _ = run_probe(probe, "pak", path, small_window)
    check_range_stats(result, window, path.stat().st_size, "PAK")

    reference, _ = run_json([str(pak_ref), str(path)])
    if reference.get("status") != "ok":
        raise RuntimeError(f"reference PAK probe failed: {reference.get('error')}")
    mismatches: list[str] = []
    for field in PAK_HEADER_FIELDS:
        if result["header"][field] != reference["header"][field]:
            mismatches.append(f"header.{field}")
    if len(result["entries"]) != len(reference["entries"]):
        mismatches.append("entry_count")
    field_comparisons = 0
    for left, right in zip(result["entries"], reference["entries"]):
        for field in PAK_ENTRY_FIELDS:
            field_comparisons += 1
            if left[field] != right[field]:
                if len(mismatches) < 20:
                    mismatches.append(f"entry[{left['index']}].{field}")
    if small["entries"] != result["entries"]:
        mismatches.append(f"entries_differ_at_window_{small_window}")
    if small["header"] != result["header"]:
        mismatches.append(f"header_differs_at_window_{small_window}")

    python_status = "skipped_v1"
    python_compared = 0
    if reference["header"]["version"] == 2:
        python = python_index(path)
        if python["status"] != "indexed":
            raise RuntimeError(f"Python PAK reference status {python['status']}")
        expected = [{
            "index": row["fat_index"],
            "path": row["path"],
            "isDirectory": row["directory"],
            "logicalBytes": row["logical_bytes"],
            "physicalBytes": None if row["directory"] else row["stored_bytes"],
            "dataOffset": row["offset"],
        } for row in python["entries"]]
        actual = [{field: row[field] for field in PY_PAK_FIELDS} for row in result["entries"]]
        for left, right in zip(expected, actual):
            python_compared += 1
            for field in PY_PAK_FIELDS:
                if left[field] != right[field]:
                    if len(mismatches) < 20:
                        mismatches.append(f"python[{left['index']}].{field}")
        # CRC is present in both independent references.
        for row in python["entries"]:
            if f"{result['entries'][row['fat_index']]['pathCrc']:08x}" != row["path_crc32"]:
                mismatches.append(f"python[{row['fat_index']}].pathCrc")
                break
        python_status = "compared"

    return {
        "file": path.name,
        "bytes": path.stat().st_size,
        "status": "pass" if not mismatches else "fail",
        "mismatches": mismatches,
        "entries_compared": min(len(result["entries"]), len(reference["entries"])),
        "field_comparisons": field_comparisons,
        "python_reference": python_status,
        "python_entries_compared": python_compared,
        "deterministic": deterministic,
        "window_bytes": window,
        "small_window_bytes": small_window,
        "largest_source_request": result["rangeRead"]["largestSourceRequest"],
        "source_requests": result["rangeRead"]["sourceRequests"],
        "bytes_read": result["rangeRead"]["bytesRead"],
        "output_sha256": sha256(raw.encode("utf-8")),
    }


def compare_level(path: Path, probe: Path, level_ref: Path, window: int,
                  small_window: int) -> dict:
    result, raw = run_probe(probe, "level", path, window)
    _, raw_again = run_probe(probe, "level", path, window)
    deterministic = raw == raw_again
    if not deterministic:
        raise RuntimeError("two range-probe runs produced different bytes")
    small, _ = run_probe(probe, "level", path, small_window)
    check_range_stats(result, window, path.stat().st_size, "")

    reference, _ = run_json([str(level_ref), "--index", str(path)])
    if reference.get("status") != "ok":
        raise RuntimeError(f"reference level probe failed: {reference.get('error')}")
    mismatches: list[str] = []
    for field in ("resourceBlockCount", "initiallyLoadedBlocks"):
        if result[field] != reference[field]:
            mismatches.append(field)
    if result["streamChunks"] != reference["streamChunks"]:
        if len(result["streamChunks"]) != len(reference["streamChunks"]):
            mismatches.append("streamChunk_count")
        else:
            for index, (left, right) in enumerate(zip(result["streamChunks"],
                                                      reference["streamChunks"])):
                if left != right:
                    mismatches.append(f"streamChunk[{index}]")
                    break
    if result["metadata"]["parsedUntilOffset"] != reference["metadata"]["parsedUntilOffset"]:
        mismatches.append("parsedUntilOffset")
    for field in ("resourceBlockCount", "initiallyLoadedBlocks", "streamChunks"):
        if small[field] != result[field]:
            mismatches.append(f"{field}_differs_at_window_{small_window}")
    if small["metadata"]["parsedUntilOffset"] != result["metadata"]["parsedUntilOffset"]:
        mismatches.append(f"parsedUntilOffset_differs_at_window_{small_window}")
    if result["rangeRead"]["bytesRead"] > result["metadata"]["parsedUntilOffset"]:
        mismatches.append("bytesRead_exceeds_parsedUntilOffset")

    return {
        "file": str(path.relative_to(path.parents[2])),
        "bytes": path.stat().st_size,
        "status": "pass" if not mismatches else "fail",
        "mismatches": mismatches,
        "stream_chunks_compared": len(result["streamChunks"]),
        "deterministic": deterministic,
        "window_bytes": window,
        "small_window_bytes": small_window,
        "parsed_until_offset": result["metadata"]["parsedUntilOffset"],
        "largest_source_request": result["rangeRead"]["largestSourceRequest"],
        "source_requests": result["rangeRead"]["sourceRequests"],
        "bytes_read": result["rangeRead"]["bytesRead"],
        "output_sha256": sha256(raw.encode("utf-8")),
    }


def load_python_reference():
    path = ROOT / "tools/inspect_asset_layout.py"
    spec = importlib.util.spec_from_file_location("blur_range_python_reference", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.pak_index


def find_level_render(directory: Path) -> Path | None:
    # The installed tree mixes Level.levelrender and level.levelrender. Match
    # the actual on-disk case instead of relying on a case-insensitive host.
    for entry in directory.iterdir():
        if entry.is_file() and entry.name.lower() == "level.levelrender":
            return entry
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", type=Path, default=DEFAULT_PROBE)
    parser.add_argument("--native-dir", type=Path, default=DEFAULT_NATIVE)
    parser.add_argument("--game-dir", type=Path, default=DEFAULT_GAME)
    parser.add_argument("--window", type=int, default=65536)
    parser.add_argument("--small-window", type=int, default=4096)
    parser.add_argument("--pak", action="append", type=Path)
    parser.add_argument("--level", action="append", type=Path)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    probe = args.probe.resolve(strict=True)
    pak_ref = (args.native_dir / "pak_inspect.exe").resolve(strict=True)
    level_ref = (args.native_dir / "level_inspect.exe").resolve(strict=True)
    game = args.game_dir.resolve(strict=True)
    python_index = load_python_reference()

    paks = args.pak or sorted((game / "cache").glob("*.pak"))
    levels = args.level or sorted(
        path for path in (find_level_render(child) for child in (game / "levels").iterdir()
                          if child.is_dir()) if path is not None)
    if not paks:
        raise SystemExit("no PAK files selected")
    if not levels:
        raise SystemExit("no Level.levelrender files selected")

    pak_reports = []
    for path in paks:
        try:
            pak_reports.append(compare_pak(path.resolve(strict=True), probe, pak_ref,
                                           python_index, args.window, args.small_window))
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
            pak_reports.append({"file": path.name, "status": "fail", "error": str(error)})
        print(f"PAK   {pak_reports[-1]['file']}: {pak_reports[-1]['status']}", flush=True)

    level_reports = []
    for path in levels:
        try:
            level_reports.append(compare_level(path.resolve(strict=True), probe, level_ref,
                                               args.window, args.small_window))
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
            level_reports.append({"file": path.name, "status": "fail", "error": str(error)})
        print(f"LEVEL {level_reports[-1]['file']}: {level_reports[-1]['status']}", flush=True)

    reports = pak_reports + level_reports
    passed = all(row["status"] == "pass" for row in reports)
    report = {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "status": "pass" if passed else "fail",
        "scope": "T-005b slice 1: range-driven PAK and level index metadata parity. "
                 "No payload decode, no engine link, no browser/GPU path.",
        "probe": str(probe),
        "probe_sha256": sha256(probe.read_bytes()),
        "references": {
            "pak_native": str(pak_ref),
            "pak_native_sha256": sha256(pak_ref.read_bytes()),
            "level_native": str(level_ref),
            "level_native_sha256": sha256(level_ref.read_bytes()),
            "python": str(ROOT / "tools/inspect_asset_layout.py"),
        },
        "window_bytes": args.window,
        "small_window_bytes": args.small_window,
        "packages": pak_reports,
        "levels": level_reports,
        "totals": {
            "packages": len(pak_reports),
            "pak_entries_compared": sum(row.get("entries_compared", 0) for row in pak_reports),
            "levels": len(level_reports),
            "stream_chunks_compared": sum(row.get("stream_chunks_compared", 0)
                                          for row in level_reports),
        },
    }
    output = args.out.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {output}")
    print(f"RESULT: {'PASS' if passed else 'FAIL'}")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
