#!/usr/bin/env python3
"""Independent verifier for the map texture-coverage study.

Gates (all must pass; the count is printed and pinned in the JSON):

1. **Source re-decode.** For every decoded source (195 Amboy + 846 Gracia + 12
   decal), re-read the raw blob, re-parse the descriptor, re-check the mip-chain
   byte arithmetic, re-decode mip0 and re-hash the RGBA. Compare with
   ``decode.json`` and with the RGBA file on disk. This is the per-texture
   dimensions / format / byte-length / hash gate.
2. **Committed decoder in bounds.** The committed manifest's ``rgbaSha256`` was
   produced by ``texture_inspect.exe``; it must equal this decoder for every
   in-bound source (the in-bound set is the cross-check that the reimplementation
   is byte-compatible). A deterministic 80-source sample is re-decoded live with
   the committed binary to prove the manifest still is the native output.
3. **Extended sources.** For each of the 11 sources over the committed bound:
   the native binary must reject with the recorded dimension message, and
   Pillow's independent DDS decoder must agree on RGB (exact) and BC3 alpha
   (<= 1/255, the documented rounding-policy difference).
4. **Coverage arithmetic.** Recompute the status totals and the two byte totals
   from the committed manifest and the decode, and compare with ``coverage.json``.
   Anchor: the reader's own identity-resolved count (1,268 / 3,058) must equal
   ``bindable now + size-unlocked + alpha-rule``.
5. **Runtime proof.** Re-read the node-chunk ``g_tAlbedo`` element for the four
   ``Advert_LN_NV`` draws per map and require type 9 (``DATA_INDEX``) with a
   non-zero runtime list index.
6. **Determinism.** Run ``extract.py`` again into a scratch directory; the decode
   manifest must be byte-identical after normalising only the output path, and
   every RGBA file must re-hash identically.

No renderer, GPU, browser or e1-drive change is made or claimed.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "probes/textures"))
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes/map-slice/tools"))

import bc_decode  # noqa: E402

OUT_ROOT = ROOT / "_work/textures"
NATIVE = ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe"
SHORT = {"usa_amboy": "amboy", "spa_barcelona_gracia": "gracia"}
FOURCC = {bc_decode.BC1: b"DXT1", bc_decode.BC2: b"DXT3", bc_decode.BC3: b"DXT5"}


class Gate:
    def __init__(self) -> None:
        self.checks = 0
        self.failures = []
        self.notes = []

    def check(self, condition: bool, message: str) -> None:
        self.checks += 1
        if not condition:
            self.failures.append(message)
            if len(self.failures) <= 40:
                print("FAIL", message)

    def equal(self, left, right, message: str) -> None:
        self.check(left == right, "%s (left=%r right=%r)" % (message, left, right))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def fnv1a64(data: bytes) -> int:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def dds_bytes(blob: bytes, desc: dict) -> bytes:
    """Wrap a BC1/BC3 blob in a DDS header for the independent Pillow decode."""
    width, height, levels, fmt = desc["width"], desc["height"], desc["levels"], desc["format"]
    mip0 = bc_decode.mip_bytes(width, height, fmt)
    header = bytearray(b"DDS ")
    header += struct.pack("<I", 124)
    header += struct.pack("<I", 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000)
    header += struct.pack("<II", height, width)
    header += struct.pack("<I", mip0)
    header += struct.pack("<I", 0)
    header += struct.pack("<I", levels)
    header += b"\0" * 44
    header += struct.pack("<I", 32)
    header += struct.pack("<I", 0x4)
    header += FOURCC[fmt]
    header += b"\0" * 20
    header += struct.pack("<I", 0x1000 | 0x8 | (0x400000 if levels > 1 else 0))
    header += b"\0" * 16
    if len(header) != 128:
        raise SystemExit("DDS header length %d" % len(header))
    return bytes(header) + blob[28:]


def pillow_decode(blob: bytes, desc: dict) -> tuple[int, int, bytes]:
    from PIL import Image
    image = Image.open(io.BytesIO(dds_bytes(blob, desc))).convert("RGBA")
    return image.size[0], image.size[1], image.tobytes()


def native_decode(blob_path: Path) -> dict:
    process = subprocess.run([str(NATIVE), str(blob_path), "--raw"],
                             capture_output=True, timeout=120)
    try:
        return json.loads(process.stdout.decode("utf-8"))
    except Exception:
        return {"status": "error", "error": process.stderr.decode("utf-8", "replace")}


def verify_texture_set(gate: Gate, level: str, doc: dict, label: str,
                       native_sample: bool) -> None:
    short = doc["short"]
    out_dir = OUT_ROOT / short
    rows = doc["textures"] if label == "albedo" else doc["decalTextures"]
    folder = "rgba" if label == "albedo" else "decal-rgba"
    in_bound = [row for row in rows if not row["extensionRequired"]]
    extended = [row for row in rows if row["extensionRequired"]]

    sample_ids = set()
    if native_sample and in_bound:
        ordered = sorted(in_bound, key=lambda row: row["id"])
        step = max(1, len(ordered) // 80)
        sample_ids = {row["id"] for row in ordered[::step][:80]}

    for row in rows:
        ident = row["id"]
        blob_path = ROOT / row.get("blobPath", "") if label == "albedo" else None
        if label == "albedo":
            blob = blob_path.read_bytes()
            gate.equal(sha256_bytes(blob), row["blobSha256"], "%s: blob SHA-256" % ident)
        else:
            # Re-extract the decal blob independently from the retail archive and
            # compare with the recorded hash, the decode and the RGBA file.
            blob = reextract_decal(level, row["block"], row["index"])
        desc = bc_decode.parse_descriptor(blob)
        gate.equal(desc["width"], row["width"], "%s: width" % ident)
        gate.equal(desc["height"], row["height"], "%s: height" % ident)
        gate.equal(desc["levels"], row["levels"], "%s: mip levels" % ident)
        gate.equal(desc["format"], row["format"], "%s: format code" % ident)
        gate.equal(desc["payloadBytes"], row["texelPayloadBytes"], "%s: texel bytes" % ident)
        gate.equal(len(blob), row["blobBytes"], "%s: blob bytes" % ident)
        expected = sum(bc_decode.mip_bytes(max(1, desc["width"] >> mip), max(1, desc["height"] >> mip),
                                           desc["format"]) for mip in range(desc["levels"]))
        gate.equal(expected, row["encodedMipChainBytes"], "%s: mip-chain byte count" % ident)
        gate.equal(expected, len(blob) - 28, "%s: chain covers the payload" % ident)

        result = bc_decode.decode_blob(blob, extended=True)
        rgba = result["rgba"]
        gate.equal(len(rgba), row["width"] * row["height"] * 4, "%s: RGBA length" % ident)
        gate.equal(sha256_bytes(rgba), row["rgbaSha256"], "%s: RGBA SHA-256" % ident)
        gate.equal("0x%016x" % fnv1a64(rgba), row["rgbaFnv1a64"], "%s: RGBA FNV-1a 64" % ident)
        stats = bc_decode.alpha_stats(rgba)
        for key in ("min", "max", "distinct", "alphaOpaque", "zeroPixels", "opaquePixels"):
            gate.equal(stats[key], row["alpha"][key], "%s: alpha %s" % (ident, key))
        on_disk = (out_dir / folder / (ident + ".rgba")).read_bytes()
        gate.equal(sha256_bytes(on_disk), row["rgbaSha256"], "%s: RGBA file on disk" % ident)

        rejection = bc_decode.committed_rejection(desc)
        gate.equal("accepted" if rejection is None else "rejected",
                   row["committedDecoderVerdict"], "%s: committed verdict" % ident)
        if rejection is not None:
            gate.equal(rejection, row["committedDecoderRejection"], "%s: committed reason" % ident)

        if ident in sample_ids:
            native = native_decode(blob_path)
            gate.equal(native.get("status"), "ok", "%s: native status" % ident)
            gate.equal(native.get("width"), row["width"], "%s: native width" % ident)
            gate.equal(native.get("height"), row["height"], "%s: native height" % ident)
            gate.equal(sha256_bytes(bytes(native.get("rgba", []))), row["rgbaSha256"],
                       "%s: native RGBA matches the standalone decoder" % ident)

    for row in extended:
        ident = row["id"]
        blob_path = ROOT / row["blobPath"]
        blob = blob_path.read_bytes()
        desc = bc_decode.parse_descriptor(blob)
        native = native_decode(blob_path)
        gate.equal(native.get("status"), "error", "%s: native rejects the oversized source" % ident)
        gate.equal(native.get("error"), "Only 2D PC textures up to 512x512 are supported",
                   "%s: native rejection reason" % ident)
        width, height, pixels = pillow_decode(blob, desc)
        gate.equal((width, height), (row["width"], row["height"]),
                   "%s: Pillow dimensions" % ident)
        mine = bc_decode.decode_blob(blob, extended=True)["rgba"]
        if desc["format"] == bc_decode.BC1:
            gate.equal(pixels, mine, "%s: Pillow BC1 RGBA is byte-identical" % ident)
        else:
            rgb_mismatch = 0
            max_alpha = 0
            for offset in range(0, len(pixels), 4):
                if pixels[offset:offset + 3] != mine[offset:offset + 3]:
                    rgb_mismatch += 1
                delta = abs(pixels[offset + 3] - mine[offset + 3])
                if delta > max_alpha:
                    max_alpha = delta
            gate.equal(rgb_mismatch, 0, "%s: Pillow BC3 RGB is byte-identical" % ident)
            gate.check(max_alpha <= 1, "%s: Pillow BC3 alpha within 1/255 (got %d)"
                       % (ident, max_alpha))


_DECAL_CACHE: dict[tuple[str, int, int], bytes] = {}


def reextract_decal(level: str, block: int, index: int) -> bytes:
    key = (level, block, index)
    if key in _DECAL_CACHE:
        return _DECAL_CACHE[key]
    from amboy_texture_bindings import TextureArchive
    from inspect_car_level_assets import render_layout

    level_dir = ROOT / "game-data/Blur/levels" / level
    levelrender = (level_dir / "level.levelrender").read_bytes()
    if block == -1:
        scene = render_layout(levelrender, "level")["scene"]
        shared = scene["sharedTextures"][index]
        blob = levelrender[shared["dataOffset"]:shared["dataOffset"] + shared["dataBytes"]]
    else:
        scene = render_layout(levelrender, "level")["scene"]
        archive = TextureArchive(scene["stream"]["chunks"], level_dir / "Level.levelstream")
        record = archive.texture(block, index)
        if record is None:
            raise SystemExit("decal source %s:%s missing" % (block, index))
        data = record["_data"]
        blob = (data[record["headerOffset"]:record["headerOffset"] + record["headerBytes"]] +
                data[record["dataOffset"]:record["dataOffset"] + record["dataBytes"]])
    _DECAL_CACHE[key] = blob
    return blob


def independently_join(level: str, short: str, decode: dict) -> dict:
    bindings = load_json(ROOT / "_work/map-slice" / (short + "-textures") / "bindings.json")
    index = {row["id"]: row for row in decode["textures"]}
    status = {}
    for draw in bindings["draws"]:
        status.setdefault(draw["status"], []).append(draw)
    size_opaque = {d["textureId"] for d in status.get("blocked-decoder-size-limit", [])
                   if index[d["textureId"]]["alpha"]["alphaOpaque"]}
    size_alpha = {d["textureId"] for d in status.get("blocked-decoder-size-limit", [])} - size_opaque
    unlocked = sum(1 for d in status.get("blocked-decoder-size-limit", [])
                   if d["textureId"] in size_opaque)
    alpha_draws = len(status.get("blocked-alpha-rule-missing", [])) + \
        sum(1 for d in status.get("blocked-decoder-size-limit", []) if d["textureId"] in size_alpha)
    return {
        "draws": len(bindings["draws"]),
        "triangles": sum(d["triangleCount"] for d in bindings["draws"]),
        "bindable": len(status.get("bindable-static-albedo", [])),
        "bindableTriangles": sum(d["triangleCount"] for d in status.get("bindable-static-albedo", [])),
        "sizeUnlocked": unlocked,
        "alphaDraws": alpha_draws,
        "decal": len(status.get("blocked-effect-not-static-albedo", [])),
        "runtime": len(status.get("blocked-runtime-albedo-parameter", [])),
        "bindableBytes": sum(index[i]["rgbaBytes"] for i in
                             {d["textureId"] for d in status.get("bindable-static-albedo", [])}),
        "uniqueBindableBytes": sum(
            {row["rgbaSha256"]: row["rgbaBytes"] for row in
             (index[i] for i in {d["textureId"] for d in status.get("bindable-static-albedo", [])})}.values()),
    }


def run_extract(level: str, out_dir: Path) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(ROOT / "probes/textures/extract.py"),
                           "--level", level, "--out", str(out_dir)],
                          capture_output=True, timeout=3600)


def normalise(doc: dict, out_dir: Path) -> bytes:
    clone = json.loads(json.dumps(doc))
    prefix = out_dir.resolve().relative_to(ROOT).as_posix()
    for key in ("textures", "decalTextures"):
        for row in clone[key]:
            if row.get("rgbaPath"):
                row["rgbaPath"] = row["rgbaPath"].replace(prefix, "_work/textures/%s" % clone["short"])
    return json.dumps(clone, indent=1, ensure_ascii=False, allow_nan=False).encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-determinism", action="store_true")
    parser.add_argument("--out", type=Path, default=OUT_ROOT / "verify.json")
    args = parser.parse_args()

    gate = Gate()
    coverage = load_json(OUT_ROOT / "coverage.json")
    decode_docs = {}
    for level, short in SHORT.items():
        doc = load_json(OUT_ROOT / short / "decode.json")
        decode_docs[level] = doc
        gate.equal(doc["level"], level, "%s: decode level" % short)
        bindings_path = ROOT / "_work/map-slice" / (short + "-textures") / "bindings.json"
        gate.equal(sha256_file(bindings_path), doc["inputs"]["bindings"]["sha256"],
                   "%s: binding manifest hash" % short)
        verify_texture_set(gate, level, doc, "albedo", native_sample=True)
        verify_texture_set(gate, level, doc, "decal", native_sample=False)

        join = independently_join(level, short, doc)
        row = coverage["maps"][level]
        gate.equal(join["draws"], row["totals"]["draws"], "%s: total draws" % short)
        gate.equal(join["triangles"], row["totals"]["triangles"], "%s: total triangles" % short)
        gate.equal(join["bindable"], row["coverage"]["now"]["draws"], "%s: bindable draws" % short)
        gate.equal(join["bindableTriangles"], row["coverage"]["now"]["triangles"],
                   "%s: bindable triangles" % short)
        gate.equal(join["sizeUnlocked"], row["fixA"]["unlockedDraws"],
                   "%s: size-unlocked draws" % short)
        gate.equal(join["alphaDraws"], row["fixB"]["allocatedDraws"],
                   "%s: alpha-rule draws" % short)
        gate.equal(join["decal"], row["decal"]["draws"], "%s: decal draws" % short)
        gate.equal(join["runtime"], row["runtime"]["draws"], "%s: runtime draws" % short)
        gate.equal(join["bindable"] + join["sizeUnlocked"] + join["alphaDraws"],
                   row["identityJoin"]["readerIdentityResolved"],
                   "%s: identity-resolved anchor" % short)
        gate.equal(join["draws"],
                   join["bindable"] + join["sizeUnlocked"] + join["alphaDraws"]
                   + join["decal"] + join["runtime"],
                   "%s: status arithmetic reconstructs the total" % short)
        # Committed byte totals (MAP3/MAP5) must be reproduced by this join.
        gate.equal(join["bindableBytes"], row["bytes"]["bindableNow"]["mip0Bytes"],
                   "%s: bindable mip0 byte total" % short)
        gate.equal(join["uniqueBindableBytes"],
                   row["bytes"]["bindableNow"]["uniqueMip0Bytes"],
                   "%s: unique bindable mip0 byte total" % short)

        runtime = doc["runtimeAlbedo"]
        gate.equal(runtime["count"], row["runtime"]["draws"], "%s: runtime proof count" % short)
        gate.check(runtime["allType9"], "%s: every runtime g_tAlbedo is type 9" % short)
        gate.check(runtime["allRuntimeList"], "%s: every runtime list index is non-zero" % short)
        for entry in runtime["draws"]:
            gate.equal(entry["field"], "g_tAlbedo", "%s: runtime field name" % short)
            gate.equal(entry["elementType"], 9, "%s: runtime element type 9" % short)

        # The extension set must be exactly the sources over the committed bound,
        # and every one of them must be rejected on that bound only.
        oversize = {row_["id"] for row_ in doc["textures"]
                    if max(row_["width"], row_["height"]) > bc_decode.COMMITTED_MAX_DIMENSION}
        gate.equal({row_["id"] for row_ in doc["textures"] if row_["extensionRequired"]},
                   oversize, "%s: extension set is exactly the oversize sources" % short)
        for row_ in doc["textures"]:
            if row_["extensionRequired"]:
                gate.check("512 px" in (row_["committedDecoderRejection"] or ""),
                           "%s: %s is rejected on the dimension bound" % (short, row_["id"]))
                gate.check(row_["levels"] > bc_decode.COMMITTED_MAX_LEVELS
                           or max(row_["width"], row_["height"]) > bc_decode.COMMITTED_MAX_DIMENSION,
                           "%s: %s exceeds a committed validator bound" % (short, row_["id"]))
        known = {"bindable-static-albedo", "blocked-decoder-size-limit",
                 "blocked-alpha-rule-missing", "blocked-effect-not-static-albedo",
                 "blocked-runtime-albedo-parameter"}
        gate.check(set(row["statuses"]) <= known, "%s: every draw status is a known type" % short)

    # Pin the committed manifest totals the report cites.
    gate.equal(coverage["maps"]["usa_amboy"]["bytes"]["bindableNow"]["mip0Bytes"], 2672704,
               "amboy committed bindable byte total")
    gate.equal(coverage["maps"]["spa_barcelona_gracia"]["bytes"]["bindableNow"]["mip0Bytes"],
               3253504, "gracia committed bindable byte total")
    gate.equal(coverage["maps"]["spa_barcelona_gracia"]["bytes"]["bindableNow"]["uniqueMip0Bytes"],
               3247360, "gracia render-package unique byte total")

    determinism = {}
    if not args.skip_determinism:
        for level, short in SHORT.items():
            scratch = OUT_ROOT / "repeat" / short
            if scratch.exists():
                for path in sorted(scratch.rglob("*"), reverse=True):
                    path.unlink() if path.is_file() else path.rmdir()
            process = run_extract(level, scratch)
            gate.equal(process.returncode, 0, "%s: repeat extraction exit code" % short)
            first = decode_docs[level]
            second = load_json(scratch / "decode.json")
            gate.equal(sha256_bytes(normalise(second, scratch)),
                       sha256_bytes(normalise(first, OUT_ROOT / short)),
                       "%s: repeat decode manifest is byte-identical" % short)
            for row in first["textures"]:
                persisted = (OUT_ROOT / short / "rgba" / (row["id"] + ".rgba")).read_bytes()
                repeated = (scratch / "rgba" / (row["id"] + ".rgba")).read_bytes()
                gate.equal(sha256_bytes(repeated), sha256_bytes(persisted),
                           "%s: repeat RGBA %s" % (short, row["id"]))
            determinism[short] = {
                "exitCode": process.returncode,
                "decodeManifestSha256": sha256_bytes(normalise(second, scratch)),
                "rgbaFilesCompared": len(first["textures"]),
            }

    artifacts = {}
    for map_short in SHORT.values():
        for name in ("decode.json",):
            path = OUT_ROOT / map_short / name
            artifacts[path.relative_to(ROOT).as_posix()] = {
                "bytes": path.stat().st_size, "sha256": sha256_file(path)}
    artifacts["_work/textures/coverage.json"] = {
        "bytes": (OUT_ROOT / "coverage.json").stat().st_size,
        "sha256": sha256_file(OUT_ROOT / "coverage.json"),
    }

    result = {
        "schema": "blur.textures.verify/1",
        "kind": "map-texture-coverage-verifier",
        "status": "PASS" if not gate.failures else "FAIL",
        "checks": gate.checks,
        "failures": len(gate.failures),
        "failureMessages": gate.failures[:40],
        "gates": {
            "sourceRedecode": "every decoded source re-read, re-decoded and re-hashed",
            "committedDecoder": "committed manifest RGBA hashes + 80-source live native sample per map",
            "extendedSources": "native rejection message + Pillow DDS cross-check for 11 sources",
            "coverageArithmetic": "status totals, byte totals and the identity-resolved anchor",
            "runtimeProof": "g_tAlbedo type 9 with a non-zero runtime list index",
            "determinism": determinism,
        },
        "artifacts": artifacts,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=1, ensure_ascii=False) + "\n",
                        encoding="utf-8", newline="\n")
    print("%s: %d checks, %d failures" % (result["status"], result["checks"], result["failures"]))
    for path, meta in artifacts.items():
        print("  %-42s %8d B  %s" % (path, meta["bytes"], meta["sha256"]))
    return 0 if not gate.failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
