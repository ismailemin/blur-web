"""Verification gate for ``build_roster_materials.py``.

Checks, with no renderer or game claim:

1. every decoded texture is re-decoded by the committed
   ``texture_inspect.exe --raw`` and compared byte-for-byte with the manifest,
   reporting the first mismatching byte offset;
2. the manifest's independent Pillow RGBA reference agrees with the native
   decoder under the documented BC3 alpha-rounding policy;
3. draw coverage, texture roles, part grouping and runtime-only reasons are
   internally consistent and agree with the committed car/scene indices;
4. two fresh builds into different directories are byte-identical, and both
   equal the final committed-output directory.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BUILDER = ROOT / "probes/car-materials/tools/build_roster_materials.py"
TEXTURE_EXE = ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe"
CARS_INDEX = ROOT / "_work/car-parts/cars/index.json"
ALLOWED_FORMATS = {
    int.from_bytes(b"DXT1", "little"),
    int.from_bytes(b"DXT3", "little"),
    int.from_bytes(b"DXT5", "little"),
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def tree_hashes(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): sha256_file(path)
        for path in sorted(root.rglob("*")) if path.is_file()
    }


def decode_native_raw(path: Path) -> tuple[dict, bytes]:
    process = subprocess.run(
        [str(TEXTURE_EXE), str(path), "--raw"], capture_output=True, text=True, check=False
    )
    if process.returncode != 0:
        raise RuntimeError(f"{path}: native decoder failed: {process.stderr.strip()}")
    parsed = json.loads(process.stdout)
    if parsed.get("status") != "ok":
        raise RuntimeError(f"{path}: native decoder returned {parsed.get('status')}")
    return parsed, bytes(parsed["rgba"])


def decode_pillow_raw(raw: bytes) -> bytes:
    from PIL import Image

    desc = struct.unpack_from("<7I", raw, 0)
    width, height, depth, levels, fmt, _usage, kind = desc
    if depth != 1 or kind != 3:
        raise RuntimeError("test wrapper only supports 2D textures")
    chain = raw[28:]
    header = [124, 0x1007, height, width, 0, 0, 1] + [0] * 11
    header += [32, 4, fmt, 0, 0, 0, 0, 0, 0x1000, 0, 0, 0, 0]
    image = Image.open(io.BytesIO(b"DDS " + struct.pack("<31I", *header) + chain))
    return image.convert("RGBA").tobytes()


def first_difference(recorded: bytes, actual: bytes) -> dict | None:
    if len(recorded) != len(actual):
        return {
            "offset": min(len(recorded), len(actual)),
            "reason": "length",
            "recordedBytes": len(recorded),
            "actualBytes": len(actual),
        }
    for offset, (left, right) in enumerate(zip(recorded, actual)):
        if left != right:
            return {"offset": offset, "recorded": left, "actual": right, "reason": "byte"}
    return None


def check_car(car: dict, out_root: Path, failures: list[str]) -> dict:
    slug = car["slug"]
    manifest_path = out_root / "cars" / slug / "materials.json"
    if not manifest_path.is_file():
        failures.append(f"{slug}: missing materials.json")
        return {}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    source = manifest["source"]

    def check(condition: bool, message: str) -> None:
        if not condition:
            failures.append(f"{slug}: {message}")

    check(manifest.get("kind") == "blur.car-material-texture-manifest", "kind")
    check(manifest.get("version") == 1, "version")
    check(source["car"]["slug"] == slug, "car slug")
    check(source["model"]["sha256"] == car["modelSha256"], "model sha")
    check(source["partManifest"]["sha256"] == car["manifestSha256"].removeprefix("sha256:"),
          "part manifest sha")
    check(source["sceneReport"]["reproducedByteIdentical"] is True,
          "scene report is not byte-identical to the committed report")
    check(source["sceneReport"]["committedSha256"] == source["sceneReport"]["reproducedSha256"],
          "scene report hash")
    check(manifest["scope"]["materialsApplied"] is False, "scope materialsApplied")
    check(manifest["scope"]["rendererClaim"] is False, "scope rendererClaim")

    draws = manifest["draws"]
    coverage = manifest["coverage"]
    check(len(draws) == coverage["drawCount"], "draw count")
    check(len({draw["index"] for draw in draws}) == len(draws), "duplicate draw index")
    check(sorted(draw["index"] for draw in draws) == list(range(len(draws))), "draw order gap")
    check(sum(1 for draw in draws if draw["partId"]) == coverage["drawsWithPartId"],
          "drawsWithPartId")
    check(sum(1 for draw in draws if not draw["partId"]) == coverage["drawsWithoutPartId"],
          "drawsWithoutPartId")

    textures = {texture["id"]: texture for texture in manifest["textures"]}
    check(len(textures) == coverage["uniqueTextureCount"], "unique texture count")
    decoded = [texture for texture in textures.values() if texture["decoded"]]
    check(len(decoded) == coverage["decodedTextureCount"], "decoded texture count")
    check(len(textures) - len(decoded) == coverage["undecodedTextureCount"],
          "undecoded texture count")

    static_draws = [draw for draw in draws if draw["albedoParameter"] == "g_MeshTexture"]
    check(len(static_draws) == coverage["staticAlbedoDrawCount"], "static draw count")
    check(all(draw["uv0Available"] for draw in static_draws), "static draw without UV0")
    check(all(len(draw["textureIds"]) == 1 for draw in static_draws),
          "static draw must reference exactly one image")
    for draw in static_draws:
        for texture_id in draw["textureIds"]:
            texture = textures.get(texture_id)
            check(texture is not None, f"draw {draw['index']} references unknown texture")
            if texture is not None:
                check(texture["decoded"] is not None,
                      f"draw {draw['index']} texture {texture_id} is not decoded")
                check("albedo" in texture["roles"], f"{texture_id} lacks albedo role")
    for draw in draws:
        if draw["albedoParameter"] is None:
            check(bool(draw["runtimeReason"]), f"draw {draw['index']} has no runtime reason")
            check(not draw["textureIds"], f"draw {draw['index']} has a texture but no parameter")
        else:
            check(draw["material"] is not None, f"draw {draw['index']} lacks material row")
            check(draw["material"]["parameter"] == draw["albedoParameter"],
                  f"draw {draw['index']} material parameter")
        for texture_id in draw["textureIds"]:
            texture = textures.get(texture_id)
            if texture is not None:
                check(draw["index"] in texture["drawIndices"],
                      f"{texture_id} does not list draw {draw['index']}")
        if draw["lightBlendInputs"]:
            check(draw["status"] == "runtime_light_blend",
                  f"draw {draw['index']} has light inputs but is not a light draw")

    # Part grouping must own each draw exactly once.
    ownership: dict[int, list[str]] = {}
    for part in manifest["parts"]:
        for index in part["drawIndices"]:
            ownership.setdefault(index, []).append(part["partId"])
        for index in part["staticAlbedoDrawIndices"]:
            check(index in part["drawIndices"],
                  f"part {part['partId']} static draw outside its draw list")
    check(sorted(ownership) == list(range(len(draws))), "part grouping does not own every draw")
    check(all(len(owners) == 1 for owners in ownership.values()), "draw owned by several parts")

    # Re-decode every texture with the committed decoder.
    comparisons = []
    for texture_id, texture in sorted(textures.items()):
        if not texture["decoded"]:
            continue
        entry = texture["decoded"]
        raw_path = out_root / "cars" / slug / entry["rawtexture"]["path"]
        rgba_path = out_root / "cars" / slug / entry["rgba"]["path"]
        png_path = out_root / "cars" / slug / entry["png"]["path"]
        check(raw_path.is_file(), f"{texture_id}: missing rawtexture")
        check(rgba_path.is_file(), f"{texture_id}: missing rgba")
        check(png_path.is_file(), f"{texture_id}: missing png")
        if not (raw_path.is_file() and rgba_path.is_file()):
            continue
        check(sha256_file(raw_path) == entry["rawtexture"]["sha256"],
              f"{texture_id}: rawtexture hash")
        check(sha256_file(png_path) == entry["png"]["sha256"], f"{texture_id}: png hash")
        recorded_rgba = rgba_path.read_bytes()
        check(sha256_bytes(recorded_rgba) == entry["rgba"]["sha256"],
              f"{texture_id}: recorded rgba hash")
        parsed, native_rgba = decode_native_raw(raw_path)
        difference = first_difference(recorded_rgba, native_rgba)
        check(difference is None, f"{texture_id}: native re-decode mismatch {difference}")
        check((parsed["width"], parsed["height"]) ==
              (entry["nativeDecoder"]["width"], entry["nativeDecoder"]["height"]),
              f"{texture_id}: native dimensions")
        check(sha256_bytes(native_rgba) == entry["nativeDecoder"]["rgbaSha256"],
              f"{texture_id}: native rgba hash")
        check(parsed["metadata"]["container"] == "PC embedded texture",
              f"{texture_id}: native container metadata")

        raw = raw_path.read_bytes()
        desc = struct.unpack_from("<7I", raw, 0)
        check(desc[4] in ALLOWED_FORMATS, f"{texture_id}: unsupported format")
        check(max(desc[0], desc[1]) <= 512, f"{texture_id}: exceeds decoder bound")
        pillow_rgba = decode_pillow_raw(raw)
        pillow_difference = first_difference(native_rgba, pillow_rgba)
        dxt5 = desc[4] == int.from_bytes(b"DXT5", "little")
        allowed = pillow_difference is None or (
            dxt5 and pillow_difference["reason"] == "byte"
            and pillow_difference["offset"] % 4 == 3
            and abs(pillow_difference["recorded"] - pillow_difference["actual"]) <= 1
        )
        if not allowed:
            # Enforce the policy over every byte, not just the first.
            bad = [
                (index, left, right)
                for index, (left, right) in enumerate(zip(native_rgba, pillow_rgba))
                if left != right
                and not (dxt5 and index % 4 == 3 and abs(left - right) <= 1)
            ]
            check(not bad, f"{texture_id}: Pillow mismatch outside policy {bad[:1]}")
        comparisons.append({
            "textureId": texture_id,
            "nativeRgbaSha256": sha256_bytes(native_rgba),
            "firstMismatch": difference,
            "pillowFirstMismatch": pillow_difference,
            "dimensions": [parsed["width"], parsed["height"]],
        })

    # LOD metadata must record unsupported chains, never silently drop them.
    for texture_id, texture in textures.items():
        for lod in texture["lods"]:
            if not lod["present"]:
                continue
            check("descriptor" in lod, f"{texture_id}: present LOD without descriptor")
            if lod.get("decodable") is False:
                check(bool(lod.get("reason")), f"{texture_id}: undecodable LOD without reason")

    return {
        "slug": slug,
        "manifestSha256": sha256_file(manifest_path),
        "draws": len(draws),
        "staticAlbedoDraws": len(static_draws),
        "textures": len(textures),
        "decodedTextures": len(decoded),
        "decodedRgbaBytes": sum(t["decoded"]["rgba"]["bytes"] for t in decoded),
        "decodedRawtextureBytes": sum(t["decoded"]["rawtexture"]["bytes"] for t in decoded),
        "textureComparisons": comparisons,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=ROOT / "_work/car-materials/roster")
    parser.add_argument("--verify-a", type=Path, default=ROOT / "_work/car-materials/verify-a")
    parser.add_argument("--verify-b", type=Path, default=ROOT / "_work/car-materials/verify-b")
    parser.add_argument("--python", default=sys.executable)
    args = parser.parse_args()
    out_root = args.out_dir.resolve()
    failures: list[str] = []

    index = json.loads(CARS_INDEX.read_text(encoding="utf-8"))
    cars = sorted(index["cars"], key=lambda row: row["slug"])
    if index.get("kind") != "car-parts.car-model-index" or len(index.get("mapped", [])) != len(cars) \
            or len(cars) < 4:
        failures.append(
            f"committed car index does not map its {len(cars)} roster cars"
        )
    aggregate_path = out_root / "index.json"
    if not aggregate_path.is_file():
        raise SystemExit(f"missing {aggregate_path}")
    aggregate = json.loads(aggregate_path.read_text(encoding="utf-8"))
    if aggregate.get("carCount") != len(cars) or len(aggregate.get("cars", [])) != len(cars):
        failures.append(
            f"aggregate covers {aggregate.get('carCount')} cars, the roster has {len(cars)}"
        )

    car_results = [check_car(car, out_root, failures) for car in cars]

    totals = {
        "cars": len(car_results),
        "draws": sum(car["draws"] for car in car_results),
        "staticAlbedoDraws": sum(car["staticAlbedoDraws"] for car in car_results),
        "textures": sum(car["textures"] for car in car_results),
        "decodedTextures": sum(car["decodedTextures"] for car in car_results),
        "decodedRgbaBytes": sum(car["decodedRgbaBytes"] for car in car_results),
        "decodedRawtextureBytes": sum(car["decodedRawtextureBytes"] for car in car_results),
        "nativeReDecodes": sum(len(car["textureComparisons"]) for car in car_results),
        "nativeMismatches": sum(
            1 for car in car_results for c in car["textureComparisons"] if c["firstMismatch"]
        ),
    }
    if totals["nativeMismatches"]:
        failures.append(f"{totals['nativeMismatches']} native re-decode mismatches")

    # Two fresh independent builds, compared by relative path and SHA-256.
    tree_a = tree_b = None
    if args.verify_a.exists() or args.verify_b.exists():
        failures.append("verify build directories already exist; remove them first")
    else:
        for target in (args.verify_a, args.verify_b):
            process = subprocess.run(
                [args.python, str(BUILDER), "--out-dir", str(target)],
                capture_output=True, text=True, check=False,
            )
            if process.returncode != 0:
                failures.append(
                    f"determinism build failed for {target.name}: {process.stderr.strip()}"
                )
        if not failures:
            tree_a = tree_hashes(args.verify_a)
            tree_b = tree_hashes(args.verify_b)
            final_tree = {
                key: value for key, value in tree_hashes(out_root).items()
                if key != "verify.json"
            }
            if tree_a != tree_b:
                differing = sorted(
                    key for key in set(tree_a) | set(tree_b)
                    if tree_a.get(key) != tree_b.get(key)
                )
                failures.append(f"two builds differ: {differing[:8]}")
            if tree_a != final_tree:
                differing = sorted(
                    key for key in set(tree_a) | set(final_tree)
                    if tree_a.get(key) != final_tree.get(key)
                )
                failures.append(f"final output differs from a fresh build: {differing[:8]}")

    result = {
        "status": "PASS" if not failures else "FAIL",
        "failures": failures,
        "totals": totals,
        "cars": [
            {key: value for key, value in car.items() if key != "textureComparisons"}
            for car in car_results
        ],
        "textureComparisonCount": totals["nativeReDecodes"],
        "firstMismatch": next(
            (
                {"car": car["slug"], "textureId": comparison["textureId"], **comparison["firstMismatch"]}
                for car in car_results
                for comparison in car["textureComparisons"]
                if comparison["firstMismatch"]
            ),
            None,
        ),
        "determinism": {
            "verifyA": str(args.verify_a.relative_to(ROOT)).replace("\\", "/"),
            "verifyB": str(args.verify_b.relative_to(ROOT)).replace("\\", "/"),
            "fileCount": len(tree_a) if tree_a is not None else 0,
            "treeEqual": tree_a == tree_b if tree_a is not None else False,
            "finalEqual": tree_a == {
                key: value for key, value in tree_hashes(out_root).items()
                if key != "verify.json"
            } if tree_a is not None else False,
        },
        "limits": [
            "Verification proves descriptor/chain assembly, byte-identical native "
            "decoding and deterministic output. It does not prove shader, sampler, "
            "paint, light-blend, renderer or game behaviour.",
        ],
    }
    verify_path = out_root / "verify.json"
    verify_path.write_text(
        json.dumps(result, indent=2, ensure_ascii=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "status": result["status"],
        "failures": len(failures),
        "totals": totals,
        "firstMismatch": result["firstMismatch"],
        "determinism": result["determinism"],
    }, indent=2))
    if failures:
        for failure in failures[:20]:
            print(f"FAIL: {failure}")
        print(f"wrote {verify_path.relative_to(ROOT)}")
        return 1
    print(f"wrote {verify_path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
