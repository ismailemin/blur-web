"""Inventory installed game data without executing or modifying it (Python stdlib)."""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def pe_machine(path: Path) -> str | None:
    try:
        with path.open("rb") as stream:
            if stream.read(2) != b"MZ":
                return None
            stream.seek(0x3C)
            offset = struct.unpack("<I", stream.read(4))[0]
            stream.seek(offset)
            if stream.read(4) != b"PE\0\0":
                return None
            machine = struct.unpack("<H", stream.read(2))[0]
            return {0x14C: "x86", 0x8664: "x64", 0xAA64: "arm64"}.get(machine, hex(machine))
    except (OSError, struct.error):
        return None


def inventory(root: Path, hash_files: bool) -> dict:
    records = []
    skipped = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            skipped.append(path.relative_to(root).as_posix())
            continue
        if not path.is_file():
            continue
        stat = path.stat()
        record = {"path": path.relative_to(root).as_posix(), "bytes": stat.st_size}
        if path.suffix.lower() in {".exe", ".dll", ".asi"}:
            record["pe_machine"] = pe_machine(path)
        if hash_files:
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            record["sha256"] = digest.hexdigest()
        records.append(record)
    extensions = Counter(Path(row["path"]).suffix.lower() or "<none>" for row in records)
    return {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "root": str(root),
        "file_count": len(records),
        "total_bytes": sum(row["bytes"] for row in records),
        "hash_algorithm": "sha256" if hash_files else None,
        "note": "Inventory only. Hashes identify files; they do not establish authenticity or safety.",
        "extensions": dict(extensions.most_common()),
        "skipped_links": skipped,
        "files": records,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-dir", type=Path, required=True, help="Installed/extracted game directory, not an ISO")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--hash", action="store_true", help="Read all file contents to calculate SHA-256")
    args = parser.parse_args()
    root = args.game_dir.resolve(strict=True)
    output = args.out.resolve()
    if not root.is_dir():
        parser.error("--game-dir must be a directory")
    if output.is_relative_to(root):
        parser.error("--out must be outside the game directory")
    if output.exists():
        parser.error("--out already exists; choose a new manifest name")
    report = inventory(root, args.hash)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(f"{report['file_count']} files, {report['total_bytes']} bytes -> {output}")


if __name__ == "__main__":
    main()
