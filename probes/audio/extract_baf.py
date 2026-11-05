"""Read-only BAF (wave bank) extractor and PS2-VAG ADPCM decoder.

Reads the retail PAK index only. Outputs go outside game-data (default
_work/audio). No game file is modified.

BAF layout is taken from upstream source:
  code/mercury/library/audio/source/common/WaveBank.h
  code/mercury/library/audio/source/common/WaveBankReader.cpp
  code/mercury/library/audio/source/core/decoderadpcm4bit.cpp

Format ids:
  code/mercury/library/audio/source/common/SampleTypes.h
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
import wave
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from inspect_asset_layout import pak_index  # noqa: E402

PACKET = 65536
# decoderadpcm4bit.cpp BATCH_SIZE_IN_SAMPLES / BATCH_SIZE_IN_BYTES
BATCH_SAMPLES = 64
BATCH_BYTES_MONO = 33
BATCH_BYTES_STEREO = 66

# decoderadpcm4bit.cpp DecodeBlock tables (verbatim)
ADPCM_PREDICT = (
    (0.0, 0.0),
    (60.0 / 64.0, 0.0),
    (115.0 / 64.0, -52.0 / 64.0),
    (98.0 / 64.0, -55.0 / 64.0),
    (122.0 / 64.0, -60.0 / 64.0),
)
ADPCM_SCALE = tuple(2.0 ** -(15.0 + i) for i in range(16))
ADPCM_SAMPLE = (
    0.0, 4096.0, 8192.0, 12288.0, 16384.0, 20480.0, 24576.0, 28672.0,
    -32768.0, -28672.0, -24576.0, -20480.0, -16384.0, -12288.0, -8192.0, -4096.0,
)


def decode_pak_asset(package: Path, logical: int, entry: dict) -> bytes:
    """Decode one PAK payload for the codecs used by retail audio assets."""
    index = pak_index(package)
    with package.open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    if len(packed) != entry["stored_bytes"]:
        raise ValueError("short PAK read")
    codec = index["codec"]
    if codec == 1:  # raw
        return packed[:logical]
    if codec == 2:  # ordinary zlib
        inflater = zlib.decompressobj()
        out = inflater.decompress(packed, logical + 1)
        if len(out) != logical or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
            raise ValueError("zlib stream extent mismatch")
        return out
    if codec != 4:
        raise ValueError(f"unsupported PAK codec {codec}")
    # packet-zlib
    cursor = 4
    out = bytearray()
    if struct.unpack_from("<I", packed, 0)[0] != PACKET:
        raise ValueError("unsupported packet size")
    max_packets = (logical + PACKET - 1) // PACKET + 1
    count = 0
    while cursor < len(packed):
        count += 1
        if count > max_packets or cursor + 4 > len(packed):
            raise ValueError("invalid packet header")
        stored = struct.unpack_from("<I", packed, cursor)[0]
        cursor += 4
        raw = stored == 0xFFFFFFFF
        size = PACKET if raw else stored
        if not 1 <= size <= PACKET or cursor + size > len(packed):
            raise ValueError("invalid packet bounds")
        expected = min(PACKET, logical - len(out))
        payload = packed[cursor:cursor + size]
        cursor += size
        if raw:
            out.extend(payload[:expected])
        else:
            inflater = zlib.decompressobj(-15)
            decoded = inflater.decompress(payload, expected + 1)
            if len(decoded) != expected or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
                raise ValueError("invalid DEFLATE packet")
            out.extend(decoded)
    if len(out) != logical:
        raise ValueError("decoded asset length mismatch")
    return bytes(out)


def decode_adpcm_block(source: bytes, prev1: float, prev2: float, delta: float,
                       out: list[float]) -> tuple[float, float, float]:
    """Port of Audio::Core::ADPCM4bitDecoder::DecodeBlock (mono, 64 samples)."""
    if len(source) < BATCH_BYTES_MONO:
        raise ValueError("short ADPCM block")
    d = 0.9025 * delta
    vol = 1.0 - d
    predictor = source[0] >> 4
    shift = source[0] & 0xF
    if predictor > 4:
        raise ValueError(f"invalid ADPCM predictor {predictor}")
    scale = ADPCM_SCALE[shift]
    a, b = ADPCM_PREDICT[predictor]
    p1, p2 = prev1, prev2
    for i in range(1, BATCH_BYTES_MONO):
        byte = source[i]
        for nibble in (byte & 0xF, byte >> 4):
            value = ADPCM_SAMPLE[nibble] * scale
            value += p1 * a + p2 * b
            p2 = p1
            p1 = value
            out.append(value * vol)
    return p1, p2, d


def decode_adpcm(data: bytes, channels: int, samples: int) -> list[float]:
    """Decode interleaved VAG blocks; returns per-channel-major float samples."""
    block = BATCH_BYTES_MONO if channels == 1 else BATCH_BYTES_STEREO
    frames = len(data) // block
    if frames * BATCH_SAMPLES != samples:
        raise ValueError(f"ADPCM extent mismatch: {frames} blocks, {samples} samples")
    out: list[float] = []
    if channels == 1:
        p1 = p2 = 0.0
        delta = 1.0
        for f in range(frames):
            p1, p2, delta = decode_adpcm_block(data[f * 33:(f + 1) * 33], p1, p2, delta, out)
    elif channels == 2:
        p1l = p2l = p1r = p2r = 0.0
        dl = dr = 1.0
        left: list[float] = []
        right: list[float] = []
        for f in range(frames):
            base = f * BATCH_BYTES_STEREO
            p1l, p2l, dl = decode_adpcm_block(data[base:base + 33], p1l, p2l, dl, left)
            p1r, p2r, dr = decode_adpcm_block(data[base + 33:base + 66], p1r, p2r, dr, right)
        for i in range(min(len(left), len(right))):
            out.extend((left[i], right[i]))
    else:
        raise ValueError(f"unsupported ADPCM channels {channels}")
    return out


def parse_baf(data: bytes) -> dict:
    """Parse BANK/WAVE/DATA chunks exactly as WaveBankReader::Read does."""
    if len(data) < 52:
        raise ValueError("short BAF")
    tag, header_size, version, num_waves = struct.unpack_from("<4sIII", data, 0)
    if tag != b"BANK":
        raise ValueError("missing BANK tag")
    endian, streaming = data[16], data[17]
    bank_name = data[18:50].split(b"\x00")[0].decode("latin-1")
    waves: list[dict] = []
    data_chunks: list[dict] = []
    off = 52  # sizeof(BankHeader) == 52 on the writer/runtime
    while off + 8 <= len(data):
        chunk_tag, chunk_size = struct.unpack_from("<4sI", data, off)
        if chunk_size < 8 or off + chunk_size > len(data):
            raise ValueError(f"chunk out of bounds at {off}")
        if chunk_tag == b"WAVE":
            if chunk_size < 60 + 16:
                raise ValueError(f"short WAVE header at {off}")
            fmt = struct.unpack_from("<I", data, off + 8)[0]
            name = data[off + 12:off + 44].split(b"\x00")[0].decode("latin-1")
            data_start, data_length, level, flags = struct.unpack_from("<IIfI", data, off + 44)
            extra = data[off + 60:off + chunk_size]
            info = {
                "index": len(waves), "name": name, "format": fmt,
                "dataStart": data_start, "dataLength": data_length,
                "defaultLevel": level, "flags": flags,
                "extraHeaderHex": extra.hex(),
            }
            if fmt == 7:  # Audio::Core::uADPCM4Bit
                size, rate, samples, loop, interleaved, bps, channels = struct.unpack_from("<IIIBBBB", extra)
                info.update({"adpcm": {
                    "size": size, "sampleRate": rate, "samples": samples,
                    "loop": loop, "interleavedStreams": interleaved,
                    "bitsPerSample": bps, "channels": channels,
                }})
            elif fmt == 3:  # PCM 16-bit signed
                rate, bps, channels, stride, loops = struct.unpack_from("<IIIIB", extra)
                info.update({"pcm": {
                    "sampleRate": rate, "bitsPerSample": bps,
                    "channels": channels, "stride": stride, "loopCount": loops,
                }})
            waves.append(info)
        elif chunk_tag == b"DATA":
            data_chunks.append({"offset": off + 8, "bytes": chunk_size - 8})
        off += chunk_size
    if len(waves) != num_waves:
        raise ValueError(f"wave count {len(waves)} != header {num_waves}")
    return {
        "bankName": bank_name, "version": version, "endian": endian,
        "streaming": streaming, "waveCount": num_waves,
        "waves": waves, "dataChunks": data_chunks,
    }


def wave_pcm(bank: bytes, info: dict, chunk: dict | None) -> tuple[list[float], int, int]:
    """Return (samples, channels, sample_rate) for one wave."""
    if info["format"] != 7:
        raise ValueError(f"wave {info['name']}: format {info['format']} not decoded")
    meta = info["adpcm"]
    start = info["dataStart"]
    length = info["dataLength"]
    if chunk is not None and chunk["bytes"] != length:
        raise ValueError(f"wave {info['name']}: DATA length differs from header")
    payload = bank[start:start + length]
    if len(payload) != length:
        raise ValueError(f"wave {info['name']}: payload out of bounds")
    samples = decode_adpcm(payload, meta["channels"], meta["samples"])
    return samples, meta["channels"], meta["sampleRate"]


def write_wav(path: Path, samples: list[float], channels: int, rate: int) -> None:
    frames = bytearray()
    for value in samples:
        clipped = max(-1.0, min(1.0, value))
        frames += struct.pack("<h", int(round(clipped * 32767.0)))
    with wave.open(str(path), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(frames)


def stats(samples: list[float]) -> dict:
    peak = max(abs(x) for x in samples) if samples else 0.0
    rms = math.sqrt(sum(x * x for x in samples) / len(samples)) if samples else 0.0
    return {"samples": len(samples), "peak": peak, "rms": rms}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pak", default="root.pak")
    parser.add_argument("--asset", default=r"\audio\race_v8.baf")
    parser.add_argument("--out-dir", type=Path, default=ROOT / "_work/audio")
    parser.add_argument("--wave", action="append", default=[],
                        help="wave name to decode (repeatable); default: all ADPCM waves")
    parser.add_argument("--list", action="store_true", help="list waves only")
    args = parser.parse_args()

    game = (ROOT / "game-data/Blur").resolve(strict=True)
    outdir = args.out_dir.resolve()
    if outdir.is_relative_to(game):
        parser.error("output must be outside game-data")
    outdir.mkdir(parents=True, exist_ok=True)

    package = game / "cache" / args.pak
    index = pak_index(package)
    entry = next((r for r in index["entries"] if r["path"].lower() == args.asset.lower()), None)
    if not entry:
        parser.error(f"asset not found: {args.asset}")

    bank = decode_pak_asset(package, entry["logical_bytes"], entry)
    bank_sha = hashlib.sha256(bank).hexdigest()
    parsed = parse_baf(bank)
    (outdir / (args.asset.replace("\\", "_").strip("_") + ".baf")).write_bytes(bank)

    report = {
        "pak": args.pak, "asset": entry, "bankSha256": bank_sha,
        **parsed,
        "decoder": {
            "source": [
                "code/mercury/library/audio/source/common/WaveBank.h",
                "code/mercury/library/audio/source/common/WaveBankReader.cpp",
                "code/mercury/library/audio/source/core/decoderadpcm4bit.cpp",
                "code/mercury/library/audio/source/common/SampleTypes.h",
            ],
            "blockSamples": BATCH_SAMPLES,
            "blockBytesMono": BATCH_BYTES_MONO,
            "blockBytesStereo": BATCH_BYTES_STEREO,
        },
        "outputs": [],
    }
    if args.list:
        for w in parsed["waves"]:
            print(w["index"], w["name"], w.get("adpcm"))
        (outdir / "race_v8.baf.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"bank": parsed["bankName"], "waves": len(parsed["waves"])}))
        return

    wanted = set(args.wave) if args.wave else None
    for info in parsed["waves"]:
        if wanted is not None and info["name"] not in wanted:
            continue
        if info["format"] != 7:
            continue
        samples, channels, rate = wave_pcm(bank, info, parsed["dataChunks"][info["index"]])
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in info["name"])
        wav = outdir / f"{safe}.wav"
        write_wav(wav, samples, channels, rate)
        digest = hashlib.sha256(wav.read_bytes()).hexdigest()
        st = stats(samples)
        report["outputs"].append({
            "wave": info["name"], "wav": wav.name, "bytes": wav.stat().st_size,
            "sha256": digest, "sampleRate": rate, "channels": channels,
            "samples": st["samples"], "durationSeconds": st["samples"] / channels / rate,
            "peak": st["peak"], "rms": st["rms"],
            "adpcm": info["adpcm"],
        })
        print(f"{info['name']}: {channels}ch {rate}Hz {st['samples']/channels/rate:.3f}s "
              f"peak={st['peak']:.3f} rms={st['rms']:.4f} sha256={digest[:16]}")

    if not report["outputs"]:
        parser.error("no matching ADPCM waves")
    (outdir / "race_v8.baf.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"bank sha256={bank_sha}")


if __name__ == "__main__":
    main()
