"""Scan a packed XT (*.bin / *.xt) for record types and print matching records.

Read-only. Uses the committed pak index + packet-zlib decoder and the committed
bounded FLSK reader. Prints type names, record counts and, for matching type
names, the decoded record payload.

Usage:
    python probes/showroom/tools/xt_scan.py --pak gamedata.pak \
        --path "\\gamedata\\xt\\amax.bin" --match ShowRoomCamera --dump
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import zlib

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "powerups" / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402
from prepare_asset_fixture import decode_packet_zlib  # noqa: E402
import xt_decode  # noqa: E402


def load_entry(pak: Path, path: str) -> tuple[bytes, dict]:
    index = pak_index(pak)
    entry = next((e for e in index["entries"] if e["path"].lower() == path.lower()), None)
    if entry is None:
        raise SystemExit(f"{path} not found in {pak.name}")
    with pak.open("rb") as handle:
        handle.seek(entry["offset"])
        packed = handle.read(entry["stored_bytes"])
    try:
        decoded = decode_packet_zlib(packed, entry["logical_bytes"])
    except ValueError:
        # Some entries store a plain zlib stream without the packet header.
        decoded = zlib.decompress(packed)
    if len(decoded) != entry["logical_bytes"]:
        raise SystemExit(f"decoded size {len(decoded)} != logical {entry['logical_bytes']}")
    return decoded, entry


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pak", default="gamedata.pak")
    parser.add_argument("--path", default="\\gamedata\\xt\\amax.bin")
    parser.add_argument("--match", default="ShowRoomCamera")
    parser.add_argument("--dump", action="store_true")
    parser.add_argument("--out")
    args = parser.parse_args()

    pak = ROOT / "game-data/Blur/cache" / args.pak
    data, entry = load_entry(pak, args.path)
    flask = xt_decode.Flask(data)

    types = [(i, flask.type_name(i)) for i in range(len(flask.types))]
    matches = [i for i, name in types if args.match.lower() in name.lower()]
    print("types", len(types), "records", len(flask.records), "match types", [(i, flask.type_name(i)) for i in matches])

    rows = []
    for index in range(len(flask.records)):
        type_index = flask.record_type(index)
        type_name = flask.type_name(type_index)
        if args.match.lower() not in type_name.lower():
            continue
        row = {"record": index, "recordId": flask.record_id(index), "type": type_name}
        if args.dump:
            row["value"] = flask.decode_record(index)
        rows.append(row)
        print(json.dumps(row, indent=1)[:4000])
    if args.out:
        target = Path(args.out)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({"pak": args.pak, "path": args.path,
                                      "sha256": hashlib.sha256(data).hexdigest(),
                                      "matches": rows}, indent=1) + "\n", encoding="utf-8")
        print("wrote", target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
