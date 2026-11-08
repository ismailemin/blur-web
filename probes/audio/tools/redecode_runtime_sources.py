"""Re-decode runtime-audio sources from the retail PAK and print their hashes.

Reads a JSON request from stdin:

    {"sources": [
      {"key": "...", "pak": "root.pak", "asset": "\\audio\\pickups.baf",
       "dataStart": 1568262, "dataLength": 12342, "channels": 1,
       "samples": 23906, "sampleRate": 48000}
    ]}

Writes {"results": [{"key", "sha256", "bytes", "extent"}]} to stdout.

This is the independent reference used by `verify_runtime_audio.mjs`. It uses
the same PAK reader and ADPCM decoder as `extract_baf.py` and the same WAV
serialiser as `verify_audio_catalog.py`; no runtime-audio catalog value is
consulted.
"""
from __future__ import annotations

import hashlib
import io
import json
import struct
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes/audio"))

from inspect_asset_layout import pak_index  # noqa: E402
from extract_baf import decode_pak_asset, decode_adpcm  # noqa: E402

GAME = ROOT / "game-data/Blur/cache"


def wav_bytes(samples: list[float], channels: int, rate: int) -> bytes:
    frames = bytearray()
    for value in samples:
        clipped = max(-1.0, min(1.0, value))
        frames += struct.pack("<h", int(round(clipped * 32767.0)))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(frames)
    return buf.getvalue()


def main() -> None:
    request = json.load(sys.stdin)
    cache: dict[tuple[str, str], bytes] = {}
    results = []
    for source in request.get("sources", []):
        key = source["key"]
        try:
            pak_name = source["pak"]
            asset = source["asset"]
            cache_key = (pak_name, asset.lower())
            if cache_key not in cache:
                pak = GAME / pak_name
                entry = next(
                    item for item in pak_index(pak)["entries"]
                    if item["path"].lower() == asset.lower()
                )
                cache[cache_key] = decode_pak_asset(pak, entry["logical_bytes"], entry)
            data = cache[cache_key]
            payload = data[source["dataStart"]:source["dataStart"] + source["dataLength"]]
            samples, extent = decode_adpcm(payload, source["channels"], source["samples"])
            wav = wav_bytes(samples, source["channels"], source["sampleRate"])
            results.append({
                "key": key,
                "sha256": hashlib.sha256(wav).hexdigest(),
                "bytes": len(wav),
                "extent": extent,
            })
        except Exception as exc:  # report per-source, do not abort the batch
            results.append({"key": key, "error": f"{type(exc).__name__}: {exc}"})
    json.dump({"results": results}, sys.stdout)


if __name__ == "__main__":
    main()
