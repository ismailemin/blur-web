"""Extract one PAK asset (zlib or packet-zlib) to a named file under _work/.

Used to materialise the AOBJ graph for inspect_dat.py without keeping a
decrypted fixture in the repository.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from inspect_asset_layout import pak_index  # noqa: E402
from extract_baf import decode_pak_asset  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pak", default="root.pak")
    parser.add_argument("--asset", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    game = (ROOT / "game-data/Blur").resolve(strict=True)
    output = args.out.resolve()
    if output.is_relative_to(game):
        parser.error("output must be outside game-data")
    package = game / "cache" / args.pak
    index = pak_index(package)
    entry = next((r for r in index["entries"] if r["path"].lower() == args.asset.lower()), None)
    if not entry:
        parser.error(f"asset not found: {args.asset}")
    data = decode_pak_asset(package, entry["logical_bytes"], entry)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(data)
    print(f"{entry['path']} -> {output}")
    print(f"bytes={len(data)} sha256={hashlib.sha256(data).hexdigest()}")


if __name__ == "__main__":
    main()
