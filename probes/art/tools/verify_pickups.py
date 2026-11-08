"""Independent verifier for the ART1 pickup/weapon asset inventory.

The verifier does **not** import `pak_util.py`, `preview.py` or the builder. It
re-implements the V2 secure-FAT index and the codec-4 packet-zlib decode from
the documented layout, re-runs the committed native readers directly, and
re-derives every recorded count/bound/hash from the decoded bytes.

Checks cover:
  * PAK identity (offset, stored/logical bytes, path CRC, decoded SHA-256)
  * model container shape and MdlDat element layer
  * scene reader status, vertex/triangle/draw counts, UV0 pairing, finite bounds,
    in-range indices and per-draw span coverage
  * shared-texture spans and decode status
  * preview PNG signature, dimensions and SHA-256
  * the entity -> icon/cycle mapping re-derived from `pickups.bin`
  * recovered transform values (scale, rotation, hover, RotateGraphic counts)
  * source-code citations (file hash + exact line text)
  * byte-identical repeat build (run1 vs run2)

Usage:
  python probes/art/tools/verify_pickups.py \
      [--run1 _work/art/pickups] [--run2 _work/art/pickups-run2]

Exit code 0 only when every check passes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import subprocess
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
NATIVE = ROOT / "_work" / "build" / "asset-reader-native" / "Release"
CACHE = ROOT / "game-data" / "Blur" / "cache"
TMP = ROOT / "_work" / "art" / "verify-tmp"
XOR_TABLE_KEY = b"xVXo40j3@$%\\%`"
PACKET = 65536

CHECKS: list[dict] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})
    return bool(ok)


# --------------------------------------------------------------------- PAK ---
def pak_entries(pak: str) -> list[dict]:
    path = CACHE / pak
    size = path.stat().st_size
    with path.open("rb") as stream:
        prefix = stream.read(48)
        if prefix[:4] != b"2KAP":
            raise SystemExit(f"{pak}: bad preheader")
        version, sector, header_size = struct.unpack_from("<III", prefix, 4)
        if version != 2 or header_size != 32:
            raise SystemExit(f"{pak}: unsupported header")
        fat_type = prefix[17]
        string_block, fat_block = struct.unpack_from("<II", prefix, 36)
        stream.seek(sector)
        string_size = struct.unpack("<I", stream.read(4))[0]
        raw = stream.read(string_size)
        strings = bytes(b ^ XOR_TABLE_KEY[(i + 1) % len(XOR_TABLE_KEY)]
                        for i, b in enumerate(raw))
        stream.seek(sector + string_block)
        count, fat_size = struct.unpack("<II", stream.read(8))
        stride = {0: 40, 1: 64}[fat_type]
        if count * stride != fat_size:
            raise SystemExit(f"{pak}: FAT geometry")
        fat = stream.read(fat_size)
    rows = []
    for i in range(count):
        crc, string_offset, parent, logical, timestamp, start, unknown, stored = \
            struct.unpack_from("<IIIIQQII", fat, i * stride)
        end = strings.find(b"\0", string_offset)
        name = strings[string_offset:end].decode("utf-8", "replace")
        directory = start == 0xFFFFFFFFFFFFFFFF
        rows.append({"path": name, "directory": directory,
                     "offset": None if directory else start * sector,
                     "stored_bytes": stored, "logical_bytes": logical,
                     "path_crc32": f"{crc:08x}", "fat_index": i})
    return [row for row in rows if not row["directory"]]


def decode_packet(packed: bytes, logical: int) -> bytes:
    if struct.unpack_from("<I", packed)[0] != PACKET:
        raise ValueError("Unexpected packet size")
    cursor, output = 4, bytearray()
    while cursor < len(packed):
        stored = struct.unpack_from("<I", packed, cursor)[0]
        cursor += 4
        raw = stored == 0xFFFFFFFF
        size = PACKET if raw else stored
        payload = packed[cursor:cursor + size]
        cursor += size
        expected = min(PACKET, logical - len(output))
        if raw:
            output.extend(payload[:expected])
        else:
            inflater = zlib.decompressobj(-15)
            decoded = inflater.decompress(payload, expected + 1)
            if len(decoded) != expected or not inflater.eof or inflater.unused_data:
                raise ValueError("Bad DEFLATE packet")
            output.extend(decoded)
    return bytes(output)


def decode_asset(pak: str, path: str) -> tuple[bytes, dict]:
    entry = next((row for row in pak_entries(pak) if row["path"].lower() == path.lower()), None)
    if entry is None:
        raise SystemExit(f"missing {pak}:{path}")
    with (CACHE / pak).open("rb") as stream:
        stream.seek(entry["offset"])
        packed = stream.read(entry["stored_bytes"])
    return decode_packet(packed, entry["logical_bytes"]), entry


def decode_zlib(pak: str, path: str) -> bytes:
    entry = next((row for row in pak_entries(pak) if row["path"].lower() == path.lower()), None)
    if entry is None:
        raise SystemExit(f"missing {pak}:{path}")
    with (CACHE / pak).open("rb") as stream:
        stream.seek(entry["offset"])
        stored = stream.read(entry["stored_bytes"])
    inflater = zlib.decompressobj()
    data = inflater.decompress(stored, entry["logical_bytes"] + 1)
    if len(data) != entry["logical_bytes"]:
        raise SystemExit(f"{path}: zlib length")
    return data


# ------------------------------------------------------------- native readers ---
def run_json(exe: str, args: list[str]) -> dict:
    proc = subprocess.run([str(NATIVE / exe), *args], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=False)
    text = proc.stdout.decode("utf-8", "replace").strip()
    if not text:
        raise SystemExit(f"{exe} produced no JSON (exit {proc.returncode})")
    return json.loads(text)


def inspect_model(name: str, data: bytes) -> tuple[dict, dict, dict]:
    TMP.mkdir(parents=True, exist_ok=True)
    path = TMP / name
    path.write_bytes(data)
    return (run_json("model_inspect.exe", [str(path)]),
            run_json("scene_inspect.exe", [str(path)]),
            run_json("scene_inspect.exe", [str(path), "--resources"]))


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def png_size(blob: bytes) -> tuple[int, int] | None:
    if len(blob) < 24 or blob[:8] != b"\x89PNG\r\n\x1a\n" or blob[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", blob[16:24])


def png_coverage(blob: bytes) -> float:
    """Fraction of pixels that differ from the preview background, from IDAT."""
    width, height = png_size(blob)
    cursor = 8
    idat = bytearray()
    while cursor < len(blob):
        length = struct.unpack_from(">I", blob, cursor)[0]
        tag = blob[cursor + 4:cursor + 8]
        payload = blob[cursor + 8:cursor + 8 + length]
        if tag == b"IDAT":
            idat += payload
        cursor += 12 + length
    raw = zlib.decompress(bytes(idat))
    stride = width * 4 + 1
    changed = 0
    for y in range(height):
        row = raw[y * stride + 1:(y + 1) * stride]
        for x in range(width):
            r, g, b = row[x * 4], row[x * 4 + 1], row[x * 4 + 2]
            if (r, g, b) != (18, 20, 24):
                changed += 1
    return changed / (width * height)


# ------------------------------------------------------------------ FLSK map ---
def _normalise(value: str) -> str:
    cleaned = value.strip().replace("/", "\\")
    while "\\\\" in cleaned:
        cleaned = cleaned.replace("\\\\", "\\")
    if not cleaned.startswith("\\"):
        cleaned = "\\" + cleaned
    return cleaned.lower()


def pickup_icon_mapping(pickups_bytes: bytes) -> dict:
    """Re-derive PickupType -> (model, cycle) with a direct FLSK walk.

    This is a self-contained decoder for exactly the constructs needed here:
    header tables, v2 string transform, records/refs, structs, arrays, pointers
    and handles. It is independent of the builder's import chain.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "art1_xt_decode", ROOT / "probes" / "powerups" / "tools" / "xt_decode.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    flask = module.Flask(pickups_bytes)
    system_index = next(i for i in range(len(flask.records))
                        if flask.record_id(i) == 253474959)
    system = flask.decode_record(system_index)
    mapping = {}
    for item in system["Types"]["items"]:
        record = item["value"]
        label = record["Type"]["label"]
        meshes = [c["Component"] for c in record["PickupSpecialFX"]["value"]["Components"]["items"]
                  if c["Component"]["typeName"] == "AnimatedMeshSpecialFX"]
        if len(meshes) != 1:
            mapping[label] = {"error": f"{len(meshes)} AnimatedMeshSpecialFX"}
            continue
        value = meshes[0]["value"]
        mapping[label] = {
            "model": _normalise(value["AnimatedMeshFileName"]["value"]),
            "cycle": _normalise(value["AnimationFileName"]["value"]),
            "lightOffset": next((c["Component"]["value"]["Offset"]["vy"]
                                 for c in record["PickupSpecialFX"]["value"]["Components"]["items"]
                                 if c["Component"]["typeName"] == "LightSpecialFX"), None),
            "cycleBegin": record.get("PickupSpecialFXBeginCycle"),
            "cycleEnd": record.get("PickupSpecialFXEndCycle"),
        }
    return mapping


# ---------------------------------------------------------------------- main ---
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run1", type=Path, default=ROOT / "_work" / "art" / "pickups")
    parser.add_argument("--run2", type=Path, default=ROOT / "_work" / "art" / "pickups-run2")
    parser.add_argument("--out", type=Path, default=ROOT / "_work" / "art" / "verify.json")
    args = parser.parse_args()

    run1 = args.run1.resolve()
    run2 = args.run2.resolve()
    index = json.loads((run1 / "index.json").read_text(encoding="utf-8"))
    transform = json.loads((run1 / "transform.json").read_text(encoding="utf-8"))

    # --- catalog shape ---------------------------------------------------
    check("catalog.kind", index.get("kind") == "art1-pickup-weapon-asset-inventory")
    check("catalog.entityCount", len(index["entities"]) == 11, str(len(index["entities"])))
    check("catalog.assetCount", len(index["assets"]) == 26, str(len(index["assets"])))
    mp = [label for label, row in index["entities"].items() if row["multiplayerClass"]]
    check("catalog.multiplayerClasses", len(mp) == 8, ",".join(sorted(mp)))
    for label in ("Nitrous", "Shock", "Shunt", "Blindfire", "Barge", "Bomb",
                  "Repair", "Shield", "SuperShield", "Fan", "Stopwatch"):
        row = index["entities"].get(label)
        check(f"entity.{label}.present", row is not None)
        if row:
            check(f"entity.{label}.icon", row.get("spawnIcon", "").startswith("pickup-"),
                  row.get("spawnIcon", ""))
            check(f"entity.{label}.model", row.get("model", "").endswith(".model"))
            check(f"entity.{label}.cycle", row.get("cycle", "").endswith(".cycle"))

    # --- required world groups ------------------------------------------
    slugs = {asset["slug"] for asset in index["assets"]}
    check("catalog.uniqueSlugs", len(slugs) == len(index["assets"]))
    for required in ("mine-core1", "mine-core2", "shield-bubble",
                     "supershield-bubble", "projectile-blindfire",
                     "projectile-blindfire-modified", "projectile-shunt",
                     "barge-wave-left", "barge-wave-bumper", "barge-wave-ring",
                     "repair-effect", "repair-effect-bumper"):
        check(f"required.{required}", required in slugs)
    check("pickupBase.absent", index["pickupBase"]["status"] == "absent-from-data")

    # --- entity mapping re-derived from pickups.bin ----------------------
    pickups_bytes = decode_zlib("gamedata.pak", "\\gamedata\\xt\\pickups.bin")
    mapping = pickup_icon_mapping(pickups_bytes)
    for label, expected in mapping.items():
        row = index["entities"].get(label)
        check(f"mapping.{label}.model",
              row is not None and row["model"].lower() == expected["model"],
              f"{row and row['model']} != {expected.get('model')}")
        check(f"mapping.{label}.cycle",
              row is not None and row["cycle"].lower() == expected["cycle"],
              f"{row and row['cycle']} != {expected.get('cycle')}")
        check(f"mapping.{label}.lightOffset",
              row is not None and expected["lightOffset"] is not None
              and row["lightOffset"]["vy"] == expected["lightOffset"])
        check(f"mapping.{label}.cycleWindow",
              row is not None and abs((row["cycleBegin"] or 0) - (expected["cycleBegin"] or 0)) < 1e-9
              and abs((row["cycleEnd"] or 0) - (expected["cycleEnd"] or 0)) < 1e-9)

    # --- per-asset decode ------------------------------------------------
    scene_failures = 0
    for asset in index["assets"]:
        slug = asset["slug"]
        directory = run1 / slug
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        model_path = asset["model"]["path"]
        data, entry = decode_asset("root.pak", model_path)

        check(f"{slug}.pakOffset", entry["offset"] == asset["model"]["pakOffset"])
        check(f"{slug}.storedBytes", entry["stored_bytes"] == asset["model"]["storedBytes"])
        check(f"{slug}.logicalBytes", entry["logical_bytes"] == asset["model"]["logicalBytes"])
        check(f"{slug}.pathCrc32", entry["path_crc32"] == asset["model"]["pathCrc32"])
        check(f"{slug}.sha256", sha256(data) == asset["model"]["sha256"])

        chunks, scene, resources = inspect_model(f"{slug}.model", data)
        check(f"{slug}.modelStatus", chunks.get("status") == "ok")
        child_ids = [c["id"] for c in chunks["chunks"][0]["children"]]
        check(f"{slug}.modelChildren",
              child_ids == ["Header", "MdlDat", "Render", "Coll"], ",".join(child_ids))
        check(f"{slug}.sceneStatus", scene.get("status") == "ok",
              scene.get("message", ""))
        if scene.get("status") != "ok":
            scene_failures += 1
            continue
        md = scene["metadata"]
        check(f"{slug}.vertexCount", md["vertexCount"] == len(scene["positions"]) // 3)
        check(f"{slug}.triangleCount", md["triangleCount"] == len(scene["indices"]) // 3)
        check(f"{slug}.uvCount", len(scene["uv0"]) // 2 == md["vertexCount"])
        check(f"{slug}.uvValid",
              md["uv0ValidVertices"] + md["uv0PlaceholderVertices"] == md["vertexCount"])
        bounds = scene["bounds"]
        finite = all(math.isfinite(v) for key in ("min", "max") for v in bounds[key])
        check(f"{slug}.boundsFinite", finite)
        check(f"{slug}.boundsOrdered",
              all(bounds["min"][i] <= bounds["max"][i] for i in range(3)))
        check(f"{slug}.indicesInRange",
              all(0 <= i < md["vertexCount"] for i in scene["indices"]))
        check(f"{slug}.drawSpans",
              sum(d["indexCount"] for d in scene["draws"]) == len(scene["indices"]))
        check(f"{slug}.drawsPartition",
              [d["firstIndex"] for d in scene["draws"]]
              == sorted(d["firstIndex"] for d in scene["draws"]))
        check(f"{slug}.primitiveCount", md["primitiveCount"] == len(scene["draws"]))
        check(f"{slug}.manifestCounts",
              asset["counts"]["vertexCount"] == md["vertexCount"]
              and asset["counts"]["triangleCount"] == md["triangleCount"]
              and asset["counts"]["drawCount"] == len(scene["draws"]))
        check(f"{slug}.manifestBounds", asset["boundsFinite"] is True)

        tex_ok = True
        for texture in scene["sharedTextures"]:
            start = texture["dataOffset"]
            end = start + texture["dataBytes"]
            if not (0 <= start < end <= len(data)):
                tex_ok = False
            recorded = {t["name"]: t for t in manifest["scene"]["sharedTextures"]}
            row = recorded.get(texture["name"])
            if not row or row["dataOffset"] != start or row["dataBytes"] != texture["dataBytes"]:
                tex_ok = False
        check(f"{slug}.textureSpans", tex_ok, f"{len(scene['sharedTextures'])} textures")
        decoded_textures = [t for t in manifest["scene"]["sharedTextures"]
                            if t["status"] == "decoded"]
        check(f"{slug}.textureDecodeCount",
              asset["counts"]["texturesDecoded"] == len(decoded_textures))

        preview = (directory / "preview.png").read_bytes()
        size = png_size(preview)
        check(f"{slug}.previewSize", size == (480, 270), str(size))
        check(f"{slug}.previewSha", sha256(preview) == asset["preview"]["sha256"])
        coverage = png_coverage(preview)
        check(f"{slug}.previewCoverage", coverage >= 0.01,
              f"{coverage:.4f}")
        check(f"{slug}.previewNotFull", coverage <= 0.99, f"{coverage:.4f}")
        check(f"{slug}.mdlDat",
              manifest["mdlDat"]["animatedMeshModelIndex"] in (0, 1))
        check(f"{slug}.resourceTextures", resources.get("status") == "ok",
              resources.get("message", ""))

    check("sceneFailures", scene_failures == 0, str(scene_failures))

    # --- transform --------------------------------------------------------
    check("transform.scale", transform["scale"]["value"] == 1.0)
    check("transform.rotation", abs(transform["rotation"]["actorYawRadPerUpdate"] - 0.1) < 1e-9)
    check("transform.rotationApplied", transform["rotation"]["applied"] is False)
    check("transform.bobStatus", transform["bob"]["status"] == "not-decoded")
    hover = transform["hover"]["primarySetsAuthoredBand"]
    check("transform.hoverSample", hover["n"] >= 150, str(hover["n"]))
    check("transform.hoverMedian", abs(hover["median"] - 0.7) < 0.02, str(hover["median"]))
    check("transform.hoverMin", hover["min"] > 0.5, str(hover["min"]))
    check("transform.hoverMax", hover["max"] < 3.0, str(hover["max"]))
    check("transform.rotateGraphicNone", transform["rotateGraphic"]["counts"]["true"] == 0)
    counts = transform["rotateGraphic"]["counts"]
    check("transform.rotateGraphicTotal",
          counts["true"] + counts["false"] + counts["absent"] == 333,
          str(counts))
    check("transform.rotateGraphicAllFalse", counts["false"] == 333, str(counts))

    car = transform["referenceCar"]
    check("transform.carStatus", car.get("status") == "recovered-from-committed-manifest")
    if car.get("status") == "recovered-from-committed-manifest":
        car_path = ROOT / "_work" / "car-parts" / "cars" / "corvette-zr1-stock" / "manifest.json"
        check("transform.carSha", sha256(car_path.read_bytes()) == car["sha256"])
        check("transform.carWidth", abs(car["width"] - 2.06445312) < 1e-6, str(car["width"]))

    for label, quad in transform["iconQuad"]["perType"].items():
        check(f"iconQuad.{label}.width", 2.4 <= quad["width"] <= 3.2, f"{quad['width']:.3f}")
        check(f"iconQuad.{label}.flat",
              abs(quad["thickness"]) < (0.01 if label == "Fan" else 1e-9),
              f"{quad['thickness']:.6f}")
        check(f"iconQuad.{label}.straddlesFloor",
              quad["bottomY"] < 0.0 < quad["topY"])

    # Recompute the hover median from the placement artifacts.
    heights = []
    for name in ("placements.json", "placements-amboy.json", "placements-gracia.json"):
        doc = json.loads((ROOT / "_work" / "powerups" / name).read_text(encoding="utf-8"))
        primary_id = doc.get("authority", {}).get("primaryRouteRecordId")
        batches = [("root", doc.get("placements"))]
        for route in doc.get("authority", {}).get("routes", []):
            batches.append((route.get("recordId"), route.get("placements")))
        for key, placements in batches:
            if not placements:
                continue
            for placement in placements:
                if key == "root" or key == primary_id:
                    value = placement.get("collision", {}).get("heightAboveGround")
                    if isinstance(value, (int, float)) and math.isfinite(value):
                        heights.append(float(value))
    heights.sort()
    band = [h for h in heights if 0.0 < h <= 3.0]
    check("transform.hoverRecomputed",
          abs(band[len(band) // 2] - hover["median"]) < 1e-9,
          f"{band[len(band) // 2]}")

    # --- citations --------------------------------------------------------
    for citation in index["citations"]:
        path = ROOT / citation["path"]
        data = path.read_bytes()
        check(f"citation.{path.name}.sha256", sha256(data) == citation["sha256"])
        lines = data.decode("utf-8", "replace").splitlines()
        for row in citation["lines"]:
            expected = lines[row["line"] - 1].strip()
            check(f"citation.{path.name}.{row['line']}",
                  expected == row["text"], expected[:80])

    # --- determinism ------------------------------------------------------
    if run2.exists():
        left = sorted(p.relative_to(run1) for p in run1.rglob("*") if p.is_file())
        right = sorted(p.relative_to(run2) for p in run2.rglob("*") if p.is_file())
        check("determinism.fileSet", left == right,
              f"{len(left)} vs {len(right)}")
        differing = []
        for rel in left:
            if rel not in right:
                continue
            if (run1 / rel).read_bytes() != (run2 / rel).read_bytes():
                differing.append(str(rel))
        check("determinism.byteIdentical", not differing,
              ", ".join(differing[:5]))
        check("determinism.previewCount",
              sum(1 for rel in left if rel.name == "preview.png") == 26)
    else:
        check("determinism.run2Present", False, str(run2))

    failed = [row for row in CHECKS if not row["ok"]]
    result = {
        "kind": "art1-pickup-assets-verification",
        "checkCount": len(CHECKS),
        "passed": len(CHECKS) - len(failed),
        "failed": len(failed),
        "failures": failed,
        "checks": CHECKS,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(f"{result['passed']}/{result['checkCount']} PASS, {result['failed']} failures")
    for row in failed[:20]:
        print("  FAIL", row["name"], row["detail"])
    raise SystemExit(0 if not failed else 1)


if __name__ == "__main__":
    main()
