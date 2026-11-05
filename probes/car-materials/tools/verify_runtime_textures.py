"""Verification gate for ``build_runtime_textures.py``.

Checks, with no renderer or game claim:

1. coverage: the manifests cover exactly the 267 runtime-only roster draws
   (45 paint, 66 light, 156 other ``_NO_ALBEDO``) and never reclassify a
   static-albedo draw;
2. every paint draw keeps the runtime ``g_sPaintMaterialTexture`` lookup
   unresolved with the documented reason and no invented colour, while its
   static dent/scratch/bump references are resolved;
3. every light draw keeps the runtime ``g_vRenderColour.w`` blend unresolved
   with the documented reason, while its static off/on/damage masks are
   resolved;
4. every resolved texture identity agrees with the committed C++ ``--resources``
   metadata, and every decoded texture is re-decoded by the committed
   ``texture_inspect.exe --raw`` byte-for-byte (first mismatch reported);
5. two fresh builds into different directories are byte-identical and equal
   the final output tree.
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
BUILDER = ROOT / "probes/car-materials/tools/build_runtime_textures.py"
TEXTURE_EXE = ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe"
SCENE_EXE = ROOT / "_work/build/asset-reader-native/Release/scene_inspect.exe"
CARS_INDEX = ROOT / "_work/car-parts/cars/index.json"
ALLOWED_FORMATS = {
    int.from_bytes(b"DXT1", "little"),
    int.from_bytes(b"DXT3", "little"),
    int.from_bytes(b"DXT5", "little"),
}

PAINT_REASON = (
    "The _a variant defines _NO_ALBEDO; this draw does not sample an albedo "
    "image; paint appearance comes from runtime g_sPaintMaterialTexture"
)
LIGHT_REASON = (
    "Off/On texture blend depends on runtime g_vRenderColour.w, and uses both "
    "UV0.xy/zw"
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def tree_hashes(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): sha256_file(path)
        for path in sorted(root.rglob("*")) if path.is_file()
    }


def run_json(exe: Path, *args: str) -> dict:
    process = subprocess.run(
        [str(exe), *args], capture_output=True, text=True, check=False
    )
    if process.returncode != 0:
        raise RuntimeError(f"{exe.name} {' '.join(args)} failed: {process.stderr.strip()}")
    parsed = json.loads(process.stdout)
    if parsed.get("status") != "ok":
        raise RuntimeError(f"{exe.name} returned {parsed.get('status')}")
    return parsed


def decode_native_raw(path: Path) -> tuple[dict, bytes]:
    parsed = run_json(TEXTURE_EXE, str(path), "--raw")
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
    draws = manifest["draws"]
    coverage = manifest["coverage"]
    textures = {texture["id"]: texture for texture in manifest["textures"]}

    def check(condition: bool, message: str) -> None:
        if not condition:
            failures.append(f"{slug}: {message}")

    check(manifest.get("kind") == "blur.car-runtime-texture-manifest", "kind")
    check(manifest.get("version") == 1, "version")
    check(source["car"]["slug"] == slug, "car slug")
    check(source["model"]["sha256"] == car["modelSha256"], "model sha")
    check(source["partManifest"]["sha256"] ==
          car["manifestSha256"].removeprefix("sha256:"), "part manifest sha")
    check(source["sceneReport"]["reproducedByteIdentical"] is True,
          "scene report is not byte-identical")
    check(source["rosterManifest"]["sha256"] ==
          sha256_file(ROOT / source["rosterManifest"]["path"]), "roster manifest sha")
    scope = manifest["scope"]
    for key in ("materialsApplied", "shaderExecuted", "samplerApplied",
                "paintLookupRecovered", "lightBlendRecovered", "rendererClaim"):
        check(scope[key] is False, f"scope {key}")
    check(scope["staticReferencesDecoded"] is True, "scope staticReferencesDecoded")

    # Coverage invariants.
    roster_manifest = json.loads(
        (ROOT / source["rosterManifest"]["path"]).read_text(encoding="utf-8")
    )
    roster_runtime_indices = [
        draw["index"] for draw in roster_manifest["draws"]
        if draw["albedoParameter"] is None
    ]
    check(source["rosterManifest"]["kind"] == "blur.car-material-texture-manifest",
          "roster manifest kind")
    check(sorted(draw["index"] for draw in draws) == roster_runtime_indices,
          "draw indices do not match the roster runtime-only set")
    check(coverage["drawCount"] == len(roster_manifest["draws"]), "drawCount")
    check(len(draws) == coverage["runtimeDrawCount"], "runtime draw count")
    check(coverage["runtimeDrawCount"] == (
        coverage["runtimePaintLookupDrawCount"]
        + coverage["runtimeLightBlendDrawCount"]
        + coverage["runtimeShaderNoAlbedoDrawCount"]), "runtime split")
    check(coverage["runtimeDrawCount"] +
          coverage["staticAlbedoDrawCount"] == coverage["drawCount"],
          "static + runtime != drawCount")

    paint_draws = [d for d in draws if d["kind"] == "paint"]
    light_draws = [d for d in draws if d["kind"] == "light"]
    no_albedo_draws = [d for d in draws if d["kind"] == "no_albedo"]
    check(len(paint_draws) == coverage["runtimePaintLookupDrawCount"], "paint list")
    check(len(light_draws) == coverage["runtimeLightBlendDrawCount"], "light list")
    check(len(no_albedo_draws) == coverage["runtimeShaderNoAlbedoDrawCount"],
          "no-albedo list")
    classification = manifest.get("classification", {})
    check(classification.get("runtimeDrawCount") == len(draws),
          "classification runtime count")
    for key, expected in (("paint", len(paint_draws)), ("light", len(light_draws)),
                          ("noAlbedo", len(no_albedo_draws))):
        entry = classification.get(key, {})
        check(entry.get("drawCount") == expected, f"classification {key} count")
        check(bool(entry.get("sourceLines")), f"classification {key} source lines")

    for draw in draws:
        check(draw["ordinaryAlbedoParameter"] is None,
              f"draw {draw['index']} must not claim an ordinary albedo")
        check(draw["ordinaryAlbedoResolved"] is False,
              f"draw {draw['index']} ordinaryAlbedoResolved")
        check(draw["paintLookupResolved"] is False,
              f"draw {draw['index']} paintLookupResolved")
        check(draw["lightBlendResolved"] is False,
              f"draw {draw['index']} lightBlendResolved")
        check(bool(draw["runtimeReason"]), f"draw {draw['index']} runtime reason")
        binding_ids = [b["textureId"] for b in draw["staticTextureBindings"]]
        check(draw["staticReferenceResolved"] == bool(binding_ids),
              f"draw {draw['index']} staticReferenceResolved")
        for binding in draw["staticTextureBindings"]:
            texture = textures.get(binding["textureId"])
            check(texture is not None,
                  f"draw {draw['index']} unknown texture {binding['textureId']}")
            if texture is not None:
                check(draw["index"] in texture["drawIndices"],
                      f"{binding['textureId']} missing draw {draw['index']}")
                check(binding["parameter"] in texture["parameters"],
                      f"{binding['textureId']} missing parameter")

    # Paint: runtime lookup unresolved, static auxiliary textures resolved.
    for draw in paint_draws:
        lookup = draw["runtimeOnly"]["paintLookup"]
        check(lookup is not None, f"paint draw {draw['index']} lacks paintLookup")
        if lookup is not None:
            check(lookup["resolved"] is False,
                  f"paint draw {draw['index']} claims a resolved paint lookup")
            check(lookup["resolution"] == "unsupported",
                  f"paint draw {draw['index']} paint resolution")
            check(lookup["field"] == "g_sPaintMaterialTexture",
                  f"paint draw {draw['index']} paint field")
            check(lookup["reason"] == PAINT_REASON,
                  f"paint draw {draw['index']} paint reason")
            check(lookup["presentInSerializedMaterial"] is False,
                  f"paint draw {draw['index']} claims a serialized paint texture")
            check(lookup["paintColourRecovered"] is False,
                  f"paint draw {draw['index']} claims a paint colour")
            check(lookup["paintTextureRecovered"] is False,
                  f"paint draw {draw['index']} claims a paint texture")
            check(bool(lookup["sourceLines"]),
                  f"paint draw {draw['index']} lacks source lines")
        check(draw["staticReferenceResolved"] is True,
              f"paint draw {draw['index']} has no static auxiliary texture")
        check(all(b["parameter"] != "g_sPaintMaterialTexture"
                  for b in draw["staticTextureBindings"]),
              f"paint draw {draw['index']} wrongly binds g_sPaintMaterialTexture")

    # Light: blend unresolved, static masks resolved.
    for draw in light_draws:
        blend = draw["runtimeOnly"]["lightBlend"]
        check(blend is not None, f"light draw {draw['index']} lacks lightBlend")
        if blend is not None:
            check(blend["resolved"] is False,
                  f"light draw {draw['index']} claims a resolved blend")
            check(blend["resolution"] == "unsupported",
                  f"light draw {draw['index']} light resolution")
            check(blend["field"] == "g_vRenderColour.w",
                  f"light draw {draw['index']} light field")
            check(blend["reason"] == LIGHT_REASON,
                  f"light draw {draw['index']} light reason")
            check(blend["blendWeightRecovered"] is False,
                  f"light draw {draw['index']} claims a blend weight")
            check(bool(blend["staticMaskTextureIds"]),
                  f"light draw {draw['index']} lacks static masks")
            check(bool(blend["sourceLines"]),
                  f"light draw {draw['index']} lacks source lines")
        check(draw["staticReferenceResolved"] is True,
              f"light draw {draw['index']} has no static mask")

    # No-albedo: either static references or none; no fabricated binding.
    for draw in no_albedo_draws:
        check(draw["runtimeOnly"]["paintLookup"] is None,
              f"no-albedo draw {draw['index']} has a paint lookup record")
        check(draw["runtimeOnly"]["lightBlend"] is None,
              f"no-albedo draw {draw['index']} has a light blend record")

    # Texture identities must agree with the committed C++ metadata.
    scene = run_json(SCENE_EXE, str(ROOT / source["model"]["path"]))
    resources = run_json(SCENE_EXE, str(ROOT / source["model"]["path"]), "--resources")
    cpp_blocks = {
        (block["index"], texture["index"]): texture
        for block in resources["resourceBlocks"] for texture in block["textures"]
    }
    cpp_shared = {index: texture for index, texture in enumerate(scene["sharedTextures"])}
    decoded = [t for t in textures.values() if t["decoded"]]
    check(len(decoded) == coverage["decodedTextureCount"], "decoded texture count")
    check(len(textures) - len(decoded) == coverage["undecodedTextureCount"],
          "undecoded texture count")
    comparisons = []
    for texture_id, texture in sorted(textures.items()):
        if texture["kind"] == "shared":
            cpp = cpp_shared.get(texture["sharedIndex"])
            check(cpp is not None, f"{texture_id}: missing shared texture")
            if cpp is not None:
                check((cpp["name"], cpp["hash"]) == (texture["name"], texture["hash"]),
                      f"{texture_id}: shared C++ identity")
                check(cpp["dataOffset"] == texture["dataOffset"],
                      f"{texture_id}: shared data offset")
                check(cpp["dataBytes"] == texture["dataBytes"],
                      f"{texture_id}: shared data bytes")
        else:
            cpp = cpp_blocks.get((texture["block"], texture["index"]))
            check(cpp is not None, f"{texture_id}: missing C++ block texture")
            if cpp is not None:
                check((cpp["name"], cpp["hash"]) == (texture["name"], texture["hash"]),
                      f"{texture_id}: block C++ identity")
        if not texture["decoded"]:
            check(bool(texture["undecodedReason"]), f"{texture_id}: no undecoded reason")
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

    return {
        "slug": slug,
        "manifestSha256": sha256_file(manifest_path),
        "runtimeDraws": len(draws),
        "paintDraws": len(paint_draws),
        "lightDraws": len(light_draws),
        "noAlbedoDraws": len(no_albedo_draws),
        "drawsWithStaticReferences": sum(
            1 for d in draws if d["staticReferenceResolved"]),
        "textures": len(textures),
        "decodedTextures": len(decoded),
        "undecodedTextures": len(textures) - len(decoded),
        "decodedRgbaBytes": sum(t["decoded"]["rgba"]["bytes"] for t in decoded),
        "decodedRawtextureBytes": sum(
            t["decoded"]["rawtexture"]["bytes"] for t in decoded),
        "textureComparisons": comparisons,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path,
                        default=ROOT / "_work/car-materials/runtime")
    parser.add_argument("--verify-a", type=Path,
                        default=ROOT / "_work/car-materials/runtime-verify-a")
    parser.add_argument("--verify-b", type=Path,
                        default=ROOT / "_work/car-materials/runtime-verify-b")
    parser.add_argument("--python", default=sys.executable)
    args = parser.parse_args()
    out_root = args.out_dir.resolve()
    failures: list[str] = []

    index = json.loads(CARS_INDEX.read_text(encoding="utf-8"))
    cars = sorted(index["cars"], key=lambda row: row["slug"])
    aggregate_path = out_root / "index.json"
    if not aggregate_path.is_file():
        raise SystemExit(f"missing {aggregate_path}")
    aggregate = json.loads(aggregate_path.read_text(encoding="utf-8"))
    if aggregate.get("carCount") != 5 or len(aggregate.get("cars", [])) != 5:
        failures.append("aggregate does not cover five cars")
    totals = aggregate.get("totals", {})
    for key, expected in (
        ("runtimeDraws", 267), ("paintDraws", 45), ("lightDraws", 66),
        ("noAlbedoDraws", 156), ("paintDrawsWithResolvedPaintLookup", 0),
        ("lightDrawsWithResolvedBlend", 0),
    ):
        if totals.get(key) != expected:
            failures.append(f"aggregate {key}={totals.get(key)} expected {expected}")
    if totals.get("drawsWithStaticReferences", 0) + \
            totals.get("drawsWithoutStaticReferences", 0) != 267:
        failures.append("aggregate static/no-static split")

    car_results = [check_car(car, out_root, failures) for car in cars]
    result_totals = {
        "cars": len(car_results),
        "runtimeDraws": sum(car["runtimeDraws"] for car in car_results),
        "paintDraws": sum(car["paintDraws"] for car in car_results),
        "lightDraws": sum(car["lightDraws"] for car in car_results),
        "noAlbedoDraws": sum(car["noAlbedoDraws"] for car in car_results),
        "drawsWithStaticReferences": sum(
            car["drawsWithStaticReferences"] for car in car_results),
        "textures": sum(car["textures"] for car in car_results),
        "decodedTextures": sum(car["decodedTextures"] for car in car_results),
        "undecodedTextures": sum(car["undecodedTextures"] for car in car_results),
        "decodedRgbaBytes": sum(car["decodedRgbaBytes"] for car in car_results),
        "decodedRawtextureBytes": sum(
            car["decodedRawtextureBytes"] for car in car_results),
        "nativeReDecodes": sum(len(car["textureComparisons"]) for car in car_results),
        "nativeMismatches": sum(
            1 for car in car_results for c in car["textureComparisons"]
            if c["firstMismatch"]),
    }
    if result_totals["nativeMismatches"]:
        failures.append(f"{result_totals['nativeMismatches']} native re-decode mismatches")

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
                    if tree_a.get(key) != tree_b.get(key))
                failures.append(f"two builds differ: {differing[:8]}")
            if tree_a != final_tree:
                differing = sorted(
                    key for key in set(tree_a) | set(final_tree)
                    if tree_a.get(key) != final_tree.get(key))
                failures.append(f"final output differs from a fresh build: {differing[:8]}")

    result = {
        "status": "PASS" if not failures else "FAIL",
        "failures": failures,
        "totals": result_totals,
        "cars": [
            {key: value for key, value in car.items() if key != "textureComparisons"}
            for car in car_results
        ],
        "textureComparisonCount": result_totals["nativeReDecodes"],
        "firstMismatch": next(
            (
                {"car": car["slug"], "textureId": comparison["textureId"],
                 **comparison["firstMismatch"]}
                for car in car_results for comparison in car["textureComparisons"]
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
            "Verification proves static TEXTURE_INDEX identity, descriptor/chain "
            "assembly, byte-identical native decoding and deterministic output. It "
            "does not prove shader, sampler, paint-lookup, light-blend, renderer or "
            "game behaviour.",
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
        "totals": result_totals,
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
