"""Compare the C++ PAK index with the independent Python format diagnostic.

Read-only game access. This checks agreement between two source-informed readers,
not retail authenticity, payload decoding, signature validation, or rendering.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from inspect_asset_layout import pak_index


FIELDS = ("index", "path", "isDirectory", "logicalBytes", "physicalBytes", "dataOffset")


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def normalized_reference(record: dict) -> dict:
    return {
        "index": record["fat_index"],
        "path": record["path"],
        "isDirectory": record["directory"],
        "logicalBytes": record["logical_bytes"],
        # The C ABI deliberately reports no payload range for a directory.
        "physicalBytes": None if record["directory"] else record["stored_bytes"],
        "dataOffset": record["offset"],
    }


def canonical_hash(records: list[dict]) -> str:
    value = json.dumps(records, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def compare(path: Path, native_exe: Path) -> dict:
    reference = pak_index(path)
    if reference["status"] != "indexed":
        return {"file": path.name, "status": "skipped", "reason": reference["status"],
                "version": reference["version"]}
    completed = subprocess.run([str(native_exe), str(path)], capture_output=True,
                               text=True, encoding="utf-8", timeout=30, check=False)
    if completed.returncode:
        raise RuntimeError(f"{path.name}: native reader failed ({completed.returncode}): "
                           f"{completed.stderr[:500]} {completed.stdout[:500]}")
    native = json.loads(completed.stdout)
    if native.get("status") != "ok":
        raise RuntimeError(f"{path.name}: native status was {native.get('status')}")
    expected = [normalized_reference(row) for row in reference["entries"]]
    actual = [{field: row[field] for field in FIELDS} for row in native["entries"]]
    mismatches = []
    if len(expected) != len(actual):
        mismatches.append({"field": "entry_count", "reference": len(expected), "native": len(actual)})
    checked = 0
    for i, (left, right) in enumerate(zip(expected, actual)):
        for field in FIELDS:
            checked += 1
            if left[field] != right[field] and len(mismatches) < 20:
                mismatches.append({"index": i, "field": field, "reference": left[field], "native": right[field]})
    expected_hash, actual_hash = canonical_hash(expected), canonical_hash(actual)
    same = expected == actual
    return {
        "file": path.name, "file_bytes": path.stat().st_size,
        "status": "pass" if same else "fail", "version": reference["version"],
        "codec": reference["codec_name"], "fat_type": reference["fat_type"],
        "entries_compared": min(len(expected), len(actual)),
        "directory_entries": sum(row["isDirectory"] for row in expected),
        "field_comparisons": checked,
        "fields": list(FIELDS), "mismatch_examples": mismatches,
        "canonical_reference_sha256": expected_hash,
        "canonical_native_sha256": actual_hash,
        "native_integrity_validation_performed": native["validationPerformed"],
        "reference_integrity_validation_performed": reference["integrity_validation_performed"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-dir", type=Path, default=Path("game-data/Blur"))
    parser.add_argument("--native-exe", type=Path,
                        default=Path("_work/build/asset-reader-native/Release/pak_inspect.exe"))
    parser.add_argument("--out", type=Path,
                        default=Path("_work/verification/pak-reference-comparison.json"))
    args = parser.parse_args()
    root = args.game_dir.resolve(strict=True)
    native_exe = args.native_exe.resolve(strict=True)
    output = args.out.resolve()
    if output.is_relative_to(root):
        parser.error("Output must be outside the game directory")
    reports = []
    for path in sorted((root / "cache").glob("*.pak")):
        try:
            reports.append(compare(path, native_exe))
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
            reports.append({"file": path.name, "status": "fail", "error": str(error)})
    tested = [row for row in reports if row["status"] != "skipped"]
    passed = bool(tested) and all(row["status"] == "pass" for row in tested)
    report = {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "status": "pass" if passed else "fail",
        "scope": "Independent Python/C++ metadata-reader agreement on installed V2 PAKs only. "
                 "Both readers are informed by the upstream serializers. "
                 "This is not a retail-authenticity or hash/signature validation claim.",
        "python_reference": str(Path(__file__).with_name("inspect_asset_layout.py").resolve()),
        "python_reference_sha256": digest(Path(__file__).with_name("inspect_asset_layout.py")),
        "native_executable": str(native_exe), "native_executable_sha256": digest(native_exe),
        "packages_compared": len(tested),
        "total_entries_compared": sum(row.get("entries_compared", 0) for row in tested),
        "total_field_comparisons": sum(row.get("field_comparisons", 0) for row in tested),
        "packages": reports,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for row in reports:
        print(f"{row['file']}: {row['status']} ({row.get('entries_compared', 0)} entries)")
    print(f"Saved {output}")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
