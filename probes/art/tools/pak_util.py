"""Read-only PAK access helpers for the ART1 pickup/weapon asset probe.

This module only reads `game-data/Blur/cache/*.pak` and re-uses the committed
composite readers:

  * `tools/inspect_asset_layout.py::pak_index`   (V2 secure-FAT index)
  * `tools/prepare_asset_fixture.py::decode_packet_zlib` (codec 4 packet zlib)
  * `_work/build/asset-reader-native/Release/{model_inspect,scene_inspect}.exe`

Nothing is written into `game-data/`, `upstream/`, `tools/` or any other
probe. Callers may only write under `_work/art/`.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402
from prepare_asset_fixture import decode_packet_zlib  # noqa: E402

GAME = ROOT / "game-data" / "Blur"
CACHE = GAME / "cache"
NATIVE = ROOT / "_work" / "build" / "asset-reader-native" / "Release"
LIMIT = 16 * 1024 * 1024

_INDEX_CACHE: dict[str, tuple[dict, dict[str, dict]]] = {}


def index_pak(name: str) -> tuple[dict, dict[str, dict]]:
    """Return (index, {lowercase_path: entry}) for one cache pak."""
    if name not in _INDEX_CACHE:
        index = pak_index(CACHE / name)
        if index.get("status") != "indexed":
            raise SystemExit(f"{name}: unsupported pak ({index.get('status')})")
        rows = {r["path"].lower(): r for r in index["entries"] if not r["directory"]}
        _INDEX_CACHE[name] = (index, rows)
    return _INDEX_CACHE[name]


def find_entry(pak: str, path: str) -> dict | None:
    _, rows = index_pak(pak)
    return rows.get(path.lower())


def decode_entry(pak: str, path: str, out_dir: Path | None = None) -> tuple[bytes, dict]:
    """Decode one codec-4 packet-zlib asset. Optionally cache the bytes."""
    entry = find_entry(pak, path)
    if entry is None:
        raise SystemExit(f"missing asset: {pak}:{path}")
    if not 1 <= entry["logical_bytes"] <= LIMIT:
        raise SystemExit(f"{path}: logical_bytes outside decoder scope")
    with (CACHE / pak).open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    decoded = decode_packet_zlib(packed, entry["logical_bytes"])
    return _finish(entry, decoded, out_dir)


def decode_zlib_entry(pak: str, path: str) -> tuple[bytes, dict]:
    """Decode one codec-2 plain-zlib asset (the `\\gamedata\\xt\\*.bin` packs)."""
    import zlib

    index, _ = index_pak(pak)
    if index.get("codec") != 2:
        raise SystemExit(f"{pak}: expected codec 2 zlib, got {index.get('codec')}")
    entry = find_entry(pak, path)
    if entry is None:
        raise SystemExit(f"missing asset: {pak}:{path}")
    with (CACHE / pak).open("rb") as stream:
        stream.seek(entry["offset"])
        stored = stream.read(entry["stored_bytes"])
    inflater = zlib.decompressobj()
    decoded = inflater.decompress(stored, entry["logical_bytes"] + 1)
    if (not inflater.eof or inflater.unused_data or inflater.unconsumed_tail
            or len(decoded) != entry["logical_bytes"]):
        raise SystemExit(f"{path}: zlib stream/length mismatch")
    return _finish(entry, decoded, None)


def _finish(entry: dict, decoded: bytes, out_dir: Path | None) -> tuple[bytes, dict]:
    digest = hashlib.sha256(decoded).hexdigest()
    info = {
        "path": entry["path"],
        "pakOffset": entry["offset"],
        "storedBytes": entry["stored_bytes"],
        "logicalBytes": entry["logical_bytes"],
        "fatIndex": entry["fat_index"],
        "pathCrc32": entry["path_crc32"],
        "sha256": digest,
    }
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"{digest}.decoded").write_bytes(decoded)
    return decoded, info


TMP = ROOT / "_work" / "art" / "tmp"


def _run_json(exe: str, args: list[str]) -> dict:
    proc = subprocess.run(
        [str(NATIVE / exe), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    text = proc.stdout.decode("utf-8", "replace").strip()
    if not text:
        raise SystemExit(f"{exe} produced no JSON (exit {proc.returncode}): "
                         f"{proc.stderr.decode('utf-8', 'replace')[:400]}")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:  # pragma: no cover
        raise SystemExit(f"{exe} JSON error: {exc}: {text[:400]}") from exc


def _materialise(payload: bytes, name: str) -> Path:
    TMP.mkdir(parents=True, exist_ok=True)
    path = TMP / name
    path.write_bytes(payload)
    return path


def model_inspect(payload: bytes, name: str = "inspect.model") -> dict:
    return _run_json("model_inspect.exe", [str(_materialise(payload, name))])


def scene_inspect(payload: bytes, name: str = "inspect.model") -> dict:
    return _run_json("scene_inspect.exe", [str(_materialise(payload, name))])


def scene_resource_textures(payload: bytes, name: str = "inspect.model") -> dict:
    """Resource-block texture metadata path of the committed scene reader."""
    return _run_json("scene_inspect.exe",
                     [str(_materialise(payload, name)), "--resources"])


def texture_raw_inspect(blob: bytes, name: str = "embedded.tex") -> dict:
    """Decode one embedded PC TextureDesc + mip texels (raw, no FileBlock)."""
    return _run_json("texture_inspect.exe",
                     [str(_materialise(blob, name)), "--raw"])


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
                    encoding="utf-8")
