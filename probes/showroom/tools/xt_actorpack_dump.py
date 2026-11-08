"""Dump the PC FLSK level actorpack for the showroom level (read-only).

Uses the committed bounded FLSK reader in ``probes/powerups/tools/xt_decode.py``
(imported, not modified) and writes a JSON dump of every serialized actor,
including its WorldMatrix (row-vector Mat43: ax/ay/az = basis, aw = translation).

The actorpack is the level's real entity list: camera director, dynamic camera,
UI locator/spline actors and their serialized transforms. No value is invented;
every number comes from the record payload.

Usage:
    python probes/showroom/tools/xt_actorpack_dump.py \
        --input _work/xt-probe/showroom.xt --output _work/showroom/actorpack.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes" / "powerups" / "tools"))

import xt_decode  # noqa: E402


def jsonable(value):
    """Convert the Flask decoder output to plain JSON types without losing fields."""
    if isinstance(value, dict):
        return {key: jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [jsonable(item) for item in value]
    if isinstance(value, float):
        # Preserve the exact IEEE-754 value; repr() is round-trip exact.
        return value
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=str(ROOT / "_work/xt-probe/showroom.xt"))
    parser.add_argument("--output", default=str(ROOT / "_work/showroom/actorpack.json"))
    args = parser.parse_args()

    data = Path(args.input).read_bytes()
    flask = xt_decode.Flask(data)
    if len(flask.records) != 1:
        raise SystemExit(f"expected 1 actorpack record, found {len(flask.records)}")
    root = flask.decode_record(0)
    if root.get("$type") != "LevelActorList":
        raise SystemExit(f"unexpected root type {root.get('$type')!r}")

    actors = root["LevelActors"]["items"]
    out = {
        "format": "blur.showroom-actorpack",
        "version": 1,
        "source": {
            "file": Path(args.input).name,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "flaskVersion": flask.version,
            "types": len(flask.types),
            "fields": len(flask.fields),
            "records": len(flask.records),
            "recordId": flask.record_id(0),
            "rootType": root["$type"],
        },
        "platforms": root.get("Platforms", {}).get("items", []),
        "levelData": root.get("LevelData", {}).get("items", []),
        "actorCount": len(actors),
        "actors": jsonable(actors),
    }
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out, indent=1, sort_keys=False) + "\n", encoding="utf-8")

    print(f"wrote {target} ({target.stat().st_size} bytes)")
    for index, actor in enumerate(actors):
        wm = actor.get("WorldMatrix")
        translation = None
        if isinstance(wm, dict):
            aw = wm.get("aw", {})
            translation = [aw.get("vx"), aw.get("vy"), aw.get("vz")]
        name = actor.get("Name")
        if isinstance(name, dict):
            name = name.get("value")
        print(index, actor.get("$type"), name, translation)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
