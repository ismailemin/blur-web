"""Export per-car UV0 streams and static albedo textures for the E1 drive slice.

P52 resolved every draw of the five E1 roster cars to its committed material
binding (`_work/car-materials/roster/cars/<slug>/materials.json`, kind
`blur.car-material-texture-manifest` v1) and decoded the referenced static
`g_MeshTexture` images to mip0 RGBA8. This tool turns that record into PoC
artefacts for the vehicle half of `geometry.json`:

  * one float32 UV0 array per car mesh vertex (the committed `scene_inspect.exe`
    stream in `_work/car-parts/cars/<slug>/scene-report.json`, whose `uv0` array
    is parallel to the `positions` array the part manifest's mesh was built from);
  * one manifest that, for every one of the 491 car draws, records the P52
    material row, the resolved texture identity and the per-draw UV0 value hash;
  * the RGBA file path + SHA-256 of every referenced image.

Nothing is guessed and nothing is re-decoded here:

  * the texture pixels are the committed P52 `textures/*.rgba` files, re-hashed
    before they are pinned (the P52 gate already re-decoded them 40/40 with the
    committed `texture_inspect.exe --raw`);
  * the UV0 values are the committed `scene_inspect.exe` mesh stream, and the
    draw ranges are required to equal the car-parts manifest's ranges and the
    scene report's own draw ranges before a single UV byte is written;
  * a draw whose P52 status is runtime-only (paint lookup, light off/on blend,
    `_NO_ALBEDO`) keeps `textureId:null` and the exact committed reason.

Inputs (read-only):

  * `_work/car-materials/roster/index.json` + `cars/<slug>/materials.json`
  * `_work/car-materials/roster/cars/<slug>/textures/<id>.rgba`
  * `_work/car-parts/cars/index.json`, `cars/<slug>/{manifest,mesh,scene-report}.json`

Outputs (never committed):

  * `_work/e1-drive/car-uv-<slug>.bin` — float32 LE UV0 pairs, mesh vertex order
  * `_work/e1-drive/car-textures.json` — the manifest

Usage:
    python probes/e1-drive/tools/build_car_textures.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CAR_MATERIALS = ROOT / "_work/car-materials/roster"
CAR_PARTS = ROOT / "_work/car-parts/cars"
OUT_DIR = ROOT / "_work/e1-drive"
MANIFEST_OUT = OUT_DIR / "car-textures.json"

# Committed identities. The P52 roster index is the per-car record; the
# car-parts index is the model/manifest/mesh map `build_geometry.mjs` already
# pins. A regenerated or hand-edited input is a hard failure.
COMMITTED_ROSTER_INDEX = "77e73bfff8e324459d337f9ec1817f717e39aabfe0134433ca886c2a1774cd76"
COMMITTED_CAR_INDEX = "5042e714a309e28e19498a0d35e18fef941c0fac850e87bc0f986117bb9bc315"

# The committed `scene_inspect.exe` output per car, which carries the merged
# `uv0` array parallel to `positions`. The car-parts index does not record this
# file's hash, so the consumed bytes are pinned here: a regenerated scene report
# must be re-pinned deliberately, it cannot slip in silently.
COMMITTED_SCENE_REPORTS = {
    "corvette-zr1-stock": "6db850a23754af49d9ec78b99f4e50523d1db3453c44c7487ae05d64d5abe0db",
    "lotus-exige-cup260-stock": "e7483a8b7be2be9ef25ebf6633fed29b9b1337b330e38ac427cde59e8c184f0f",
    "dodge-challenger-stock": "b2284325b49fc663db1083b1032b93247ffd240d723c8564ac79893aa71b54fe",
    "ford-focusrs-stock": "d69f46ce09ba1759bbef7063f6f769b387814174af40a6199c617b7c9ad2e5f1",
    "audi-r8v10-stock": "948548055a1ff7f59482661d752a9a0542e023c8774315ceb8021545156f8639",
}

# P52 totals (docs/work/analysis/car-materials.md §2). Every derived count is
# compared with these before the manifest is written.
EXPECTED = {
    "draws": 491,
    "staticAlbedoDraws": 224,
    "paintDraws": 45,
    "lightDraws": 66,
    "noAlbedoDraws": 156,
    "textures": 40,
    "rgbaBytes": 18178048,
    "uvValues": 2 * (33048 + 32136 + 28365 + 32267 + 31429),
}

# One declared sampling choice, identical to the track pack. P52 records that no
# sampler state is recovered from the engine, so this is not retail fidelity.
SAMPLER = {
    "addressModeU": "repeat",
    "addressModeV": "repeat",
    "magFilter": "linear",
    "minFilter": "linear",
    "mipmapFilter": "not-applied",
    "mipLevelsUploaded": 1,
    "textureFormat": "rgba8unorm",
    "colourSpace": "raw-decoded-texels",
    "reason": (
        "P52 records that sampler wrap/filter/anisotropy/mip selection, sRGB, material colour, blend "
        "state and shader stages are not recovered. 'repeat' + linear on the uploaded mip0 is the single "
        "explicit PoC choice, shared with the track texture pack. The RGBA bytes are the committed P52 "
        "decode, uploaded as rgba8unorm with no channel transform. This is not retail sampling fidelity"
    ),
}

# UV0 sampling convention. The exported stream is the reader's raw value, byte
# for byte; the sampler applies `v' = 1 - v` for car draws because the committed
# plate/emblem pixels prove the images are authored with the opposite V direction.
# Evidence: the ZR1 licence plate (`nyc_10`, shared 6) renders "NEW YORK" at the
# bottom and mirrored with the raw stream, and upright with `v' = 1 - v`; the
# same for the Audi plate (`spain10`, shared 7) and the ZR1 rear emblem
# (`corvette_zr1_decals`, resource block 8). Both storage kinds behave the same,
# so this is one convention, not a per-texture flag. No UV value is modified.
UV_CONVENTION = {
    "uv0": "committed scene_inspect.exe stream, exported unchanged (signed zeros preserved)",
    "sampleV": "1 - uv0.v",
    "appliesTo": "the 224 car draws whose P52 static albedo image is bound",
    "reason": (
        "the decoded images are stored V-down (image row 0 is the top row); the car UV0 stream addresses "
        "them V-up, so sampling one-minus-v makes the authored artwork read correctly. The committed UV0 "
        "values and the committed RGBA pixels are unmodified: only the sampling choice is declared"),
    "evidence": [
        "ZR1 rear plate nyc_10 (shared 6): raw v shows 'NEW YORK' mirrored at the plate bottom; 1-v shows it upright at the top",
        "Audi rear plate spain10 (shared 7): same behaviour",
        "ZR1 rear emblem corvette_zr1_decals (resource block 8): same behaviour",
    ],
    "notApplied": "no per-material texture matrix, UV transform, wrap state or mip state is recovered; this is one declared PoC convention",
}


# Draw classes. The 267 runtime-only draws keep the committed P52 reason verbatim;
# they are never given an invented image.
STATUS_TO_CLASS = {
    "static_albedo_image_resolved": "staticAlbedo",
    "runtime_light_blend": "runtimeLightBlend",
    "shader_no_albedo": "noAlbedoShader",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fnv1a64(data: bytes) -> str:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{value:016x}"


def mix_f32(value: int, component: float) -> int:
    for byte in struct.pack("<f", component):
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT)).replace("\\", "/")


def load_pinned(path: Path, expected_sha: str, what: str) -> bytes:
    if not path.is_file():
        raise SystemExit(f"BLOCKED: missing {what} {rel(path)}")
    data = path.read_bytes()
    digest = sha256_bytes(data)
    if digest != expected_sha:
        raise SystemExit(f"FAILED: {what} is not the committed one ({digest} != {expected_sha})")
    return data


class JsonReader:
    """Float32-preserving JSON writer: the reader prints `-0`, keep its sign."""

    @staticmethod
    def load(path: Path) -> dict:
        return json.loads(
            path.read_text(encoding="utf-8"),
            parse_int=lambda token: float(token) if token == "-0" else int(token),
        )


def build_car(entry: dict, car_index_entry: dict) -> dict:
    slug = entry["slug"]
    materials_path = CAR_MATERIALS / entry["manifest"]
    materials = JsonReader.load(materials_path)
    if materials.get("kind") != "blur.car-material-texture-manifest" or materials.get("version") != 1:
        raise SystemExit(f"FAILED: {slug} materials kind/version is not blur.car-material-texture-manifest v1")
    if sha256_bytes(materials_path.read_bytes()) != entry["manifestSha256"]:
        raise SystemExit(f"FAILED: {slug} materials.json is not the one the roster index pinned")

    manifest_path = ROOT / car_index_entry["manifest"]
    parts = json.loads(manifest_path.read_text(encoding="utf-8"))
    if parts.get("kind") != "blur.car-part-manifest" or parts.get("version") != 1:
        raise SystemExit(f"FAILED: {slug} part manifest kind/version is wrong")
    if sha256_bytes(manifest_path.read_bytes()) != car_index_entry["manifestSha256"][7:]:
        raise SystemExit(f"FAILED: {slug} part manifest differs from the car index pin")

    mesh_path = ROOT / car_index_entry["mesh"]
    mesh_bytes = mesh_path.read_bytes()
    if sha256_bytes(mesh_bytes) != car_index_entry["meshSha256"][7:]:
        raise SystemExit(f"FAILED: {slug} mesh differs from the car index pin")
    mesh = json.loads(mesh_bytes)
    vertex_count = mesh["vertexCount"]
    if vertex_count * 3 != len(mesh["positions"]):
        raise SystemExit(f"FAILED: {slug} mesh positions do not match its vertex count")

    scene_path = CAR_PARTS / slug / "scene-report.json"
    scene_raw = load_pinned(scene_path, COMMITTED_SCENE_REPORTS[slug], f"{slug} scene report")
    scene = JsonReader.load(scene_path)
    if scene.get("status") != "ok":
        raise SystemExit(f"FAILED: {slug} scene report status is {scene.get('status')}")
    if scene["positions"] != mesh["positions"]:
        raise SystemExit(f"FAILED: {slug} scene report positions differ from the part manifest mesh")
    uv = scene["uv0"]
    if len(uv) != 2 * vertex_count:
        raise SystemExit(f"FAILED: {slug} uv0 has {len(uv)} values, expected 2 x {vertex_count}")
    for component in uv:
        if not (component == component and abs(component) != float("inf")):
            raise SystemExit(f"FAILED: {slug} uv0 has a non-finite component")
    if len(scene["draws"]) != len(parts["draws"]) or len(materials["draws"]) != len(parts["draws"]):
        raise SystemExit(f"FAILED: {slug} draw counts disagree between the three readers")
    for index, (part_draw, scene_draw) in enumerate(zip(parts["draws"], scene["draws"])):
        if part_draw["index"] != index or scene_draw.get("firstIndex") is None:
            raise SystemExit(f"FAILED: {slug} draw {index} is not in serialized order")
        if part_draw["firstIndex"] != scene_draw["firstIndex"] or \
                part_draw["indexCount"] != scene_draw["indexCount"]:
            raise SystemExit(f"FAILED: {slug} draw {index} index range differs from the scene report")

    # Texture identity: P52 records the resolved static image per draw. The RGBA
    # files are the committed decodes; each is re-hashed here before it is pinned.
    texture_records = {}
    for texture in materials["textures"]:
        decoded = texture.get("decoded") or {}
        rgba_info = decoded.get("rgba") or {}
        if texture.get("undecodedReason"):
            raise SystemExit(f"FAILED: {slug} texture {texture['id']} is undecoded: {texture['undecodedReason']}")
        if not rgba_info.get("path"):
            raise SystemExit(f"FAILED: {slug} texture {texture['id']} has no decoded RGBA")
        rgba_path = (CAR_MATERIALS / Path(entry["manifest"]).parent / rgba_info["path"]).resolve()
        rgba_bytes = rgba_path.read_bytes()
        if sha256_bytes(rgba_bytes) != rgba_info["sha256"]:
            raise SystemExit(f"FAILED: {slug} texture {texture['id']} RGBA does not match its P52 hash")
        width, height = texture["decoded"]["nativeDecoder"]["width"], texture["decoded"]["nativeDecoder"]["height"]
        if len(rgba_bytes) != width * height * 4 or len(rgba_bytes) != rgba_info["bytes"]:
            raise SystemExit(f"FAILED: {slug} texture {texture['id']} RGBA length does not match its size")
        texture_id = f"car.{slug}." + texture["id"].replace(":", "-")
        texture_records[texture["id"]] = {
            "id": texture_id,
            "p52Id": texture["id"],
            "kind": texture["kind"],
            "block": texture.get("block"),
            "index": texture.get("index"),
            "sharedIndex": texture.get("sharedIndex"),
            "name": texture["name"],
            "textureHash": texture["hash"],
            "roles": texture["roles"],
            "width": width,
            "height": height,
            "levels": (texture["lods"][0]["descriptor"].get("levels") if texture.get("lods") else None),
            "formatName": (texture["lods"][0]["descriptor"].get("formatName") if texture.get("lods") else None),
            "samplerRecorded": texture.get("sampler"),
            "sourceLod": texture["decoded"].get("sourceLod"),
            "source": texture["decoded"].get("source"),
            "rgbaPath": rel(rgba_path),
            "rgbaBytes": len(rgba_bytes),
            "rgbaSha256": "sha256:" + rgba_info["sha256"],
            "rgbaFnv1a64": fnv1a64(rgba_bytes),
            "drawIndices": texture["drawIndices"],
            "p52DrawCount": len(texture["drawIndices"]),
            "drawCount": 0,
        }

    draws = []
    uv_values = []
    per_texture_draws: dict[str, int] = {}
    uv_values_sha = None

    for index, (material_draw, part_draw) in enumerate(zip(materials["draws"], parts["draws"])):
        if material_draw["index"] != index:
            raise SystemExit(f"FAILED: {slug} materials draw order differs at {index}")
        if (material_draw.get("partId") or None) != (part_draw.get("partId") or None) or \
                (material_draw.get("renderPartId") or None) != (part_draw.get("renderPartId") or None):
            raise SystemExit(f"FAILED: {slug} draw {index} part identity differs between P52 and the part manifest")
        status = material_draw["status"]
        draw_class = STATUS_TO_CLASS.get(status)
        if draw_class is None:
            raise SystemExit(f"FAILED: {slug} draw {index} has unknown P52 status {status!r}")

        first, count = part_draw["firstIndex"], part_draw["indexCount"]
        digest = 0xCBF29CE484222325
        low = [None, None]
        high = [None, None]
        for vertex in mesh["indices"][first:first + count]:
            pair = (uv[2 * vertex], uv[2 * vertex + 1])
            for axis in range(2):
                digest = mix_f32(digest, pair[axis])
                if low[axis] is None or pair[axis] < low[axis]:
                    low[axis] = pair[axis]
                if high[axis] is None or pair[axis] > high[axis]:
                    high[axis] = pair[axis]

        record = {
            "index": index,
            "firstIndex": first,
            "indexCount": count,
            "partId": material_draw.get("partId"),
            "partKind": material_draw.get("partKind"),
            "renderPartId": material_draw.get("renderPartId"),
            "effect": material_draw.get("effect"),
            "shaderFamily": material_draw.get("shaderFamily"),
            "p52Status": status,
            "drawClass": draw_class,
            "uv0Available": bool(material_draw["uv0Available"]),
            "uvHash": "0x" + f"{digest:016x}",
            "uvRange": [[low[0], high[0]], [low[1], high[1]]],
            "uvFlipV": False,
        }

        if draw_class == "staticAlbedo":
            texture_ids = material_draw.get("textureIds") or []
            if len(texture_ids) != 1:
                raise SystemExit(f"FAILED: {slug} draw {index} resolves {len(texture_ids)} textures, expected 1")
            texture = texture_records.get(texture_ids[0])
            if texture is None:
                raise SystemExit(f"FAILED: {slug} draw {index} names unknown texture {texture_ids[0]}")
            if not material_draw["uv0Available"]:
                raise SystemExit(f"FAILED: {slug} draw {index} is textured but has no original UV0")
            if index not in texture["drawIndices"]:
                raise SystemExit(f"FAILED: {slug} texture {texture['id']} does not list draw {index}")
            per_texture_draws[texture["id"]] = per_texture_draws.get(texture["id"], 0) + 1
            record.update({
                "textureId": texture["id"],
                "textureName": texture["name"],
                "textureHash": texture["textureHash"],
                "textureSource": texture["p52Id"],
                "uvFlipV": True,
                "material": {
                    "id": material_draw["material"]["id"],
                    "stage": material_draw["material"]["stage"],
                    "typeName": material_draw["material"]["typeName"],
                    "albedoParameter": material_draw["material"]["parameter"],
                    "archiveOffset": material_draw["material"]["archiveOffset"],
                    "fieldSerializedOffset": material_draw["material"]["fieldSerializedOffset"],
                },
                "bindingStatus": "boundStaticAlbedoImage",
                "reason": "P52 resolved this draw's g_MeshTexture to a decoded static image; sampled with the "
                          "car mesh's own UV0 stream",
            })
        else:
            if material_draw.get("textureIds"):
                raise SystemExit(f"FAILED: {slug} draw {index} is {draw_class} but names a texture")
            runtime_reason = material_draw.get("runtimeReason") or ""
            if not runtime_reason:
                raise SystemExit(f"FAILED: {slug} draw {index} has no committed runtime reason")
            material_row = material_draw.get("material") or {}
            record.update({
                "textureId": None,
                "textureName": None,
                "textureHash": None,
                "textureSource": None,
                "material": {
                    "id": material_row.get("id"),
                    "stage": material_row.get("stage"),
                    "typeName": material_row.get("typeName"),
                    "albedoParameter": material_row.get("parameter"),
                    "archiveOffset": material_row.get("archiveOffset"),
                    "fieldSerializedOffset": material_row.get("fieldSerializedOffset"),
                },
                "runtimeBinding": material_draw.get("binding"),
                "bindingStatus": {
                    "runtimeLightBlend": "runtimeLightBlend",
                    "noAlbedoShader": "runtimePaintLookup" if material_draw.get("shaderFamily") == "paint"
                        else "runtimeShaderNoAlbedo",
                }[draw_class],
                "reason": runtime_reason,
            })
        draws.append(record)

    light_counts = {}
    for material_draw in materials["draws"]:
        # A light draw names the off and the on input, which here resolve to the
        # same image, so count the draw once per distinct referenced texture.
        for texture_id in set((material_draw.get("lightBlendInputs") or {}).values()):
            light_counts[texture_id] = light_counts.get(texture_id, 0) + 1
    for texture in texture_records.values():
        texture["drawCount"] = per_texture_draws.get(texture["id"], 0)
        texture["lightDrawCount"] = light_counts.get(texture["p52Id"], 0)
        # P52's drawIndices list every draw that references the image: the static
        # albedo draws plus the runtime light off/on inputs.
        if texture["drawCount"] + texture["lightDrawCount"] != texture["p52DrawCount"]:
            raise SystemExit(f"FAILED: {slug} texture {texture['id']} draw count differs from P52")
        texture["referenceDrawCount"] = texture["p52DrawCount"]

    uv_bytes = struct.pack("<%df" % len(uv), *uv)
    uv_path = OUT_DIR / f"car-uv-{slug}.bin"
    uv_path.parent.mkdir(parents=True, exist_ok=True)
    uv_path.write_bytes(uv_bytes)
    uv_values_sha = "sha256:" + sha256_bytes(uv_bytes)
    if sha256_bytes(uv_path.read_bytes()) != uv_values_sha[7:]:
        raise SystemExit(f"FAILED: {slug} written UV stream does not re-hash")
    uv_values = len(uv)

    textured = [draw for draw in draws if draw["drawClass"] == "staticAlbedo"]
    paint = [draw for draw in draws if draw["bindingStatus"] == "runtimePaintLookup"]
    light = [draw for draw in draws if draw["bindingStatus"] == "runtimeLightBlend"]
    no_albedo = [draw for draw in draws if draw["bindingStatus"] == "runtimeShaderNoAlbedo"]
    coverage = {
        "drawCount": len(draws),
        "staticAlbedoDraws": len(textured),
        "runtimePaintDraws": len(paint),
        "runtimeLightBlendDraws": len(light),
        "runtimeNoAlbedoDraws": len(no_albedo),
        "textureCount": len(texture_records),
        "rgbaBytes": sum(texture["rgbaBytes"] for texture in texture_records.values()),
        "uvValues": uv_values,
        "uvBytes": len(uv_bytes),
        "uv0AvailableDraws": sum(1 for draw in draws if draw["uv0Available"]),
    }
    if len(textured) + len(paint) + len(light) + len(no_albedo) != len(draws):
        raise SystemExit(f"FAILED: {slug} draw classes do not cover every draw")

    return {
        "slug": slug,
        "name": entry["name"],
        "materials": {
            "path": rel(materials_path),
            "sha256": "sha256:" + entry["manifestSha256"],
            "kind": materials["kind"],
            "version": materials["version"],
        },
        "partManifest": {
            "path": rel(manifest_path),
            "sha256": car_index_entry["manifestSha256"],
        },
        "mesh": {
            "path": rel(mesh_path),
            "sha256": car_index_entry["meshSha256"],
            "vertexCount": vertex_count,
            "indexCount": mesh["indexCount"],
            "positionsSha256": car_index_entry["meshPositionsSha256"],
            "indicesSha256": car_index_entry["meshIndicesSha256"],
        },
        "sceneReport": {
            "path": rel(scene_path),
            "sha256": "sha256:" + COMMITTED_SCENE_REPORTS[slug],
            "positionsSha256": "sha256:" + sha256_bytes(
                struct.pack("<%df" % len(scene["positions"]), *scene["positions"])),
            "positionsNote": (
                "the scene report and the part manifest mesh are numerically identical; the scene report "
                "keeps the reader's signed zeros (-0) for positions and UV, while mesh.json serialized them "
                "as 0, so a byte hash over the two position arrays differs in the sign of zero only. The "
                "exported UV0 stream is the scene-report bit pattern, signed zeros included"),
            "uv0Source": "scene_inspect.exe merged mesh uv0 array, parallel to positions",
        },
        "uvStream": {
            "path": rel(uv_path),
            "storage": "float32-le",
            "components": 2,
            "vertexCount": vertex_count,
            "values": uv_values,
            "bytes": len(uv_bytes),
            "sha256": uv_values_sha,
            "order": "the car mesh vertex order in geometry.json",
            "bounds": {
                "min": [min(uv[0::2]), min(uv[1::2])],
                "max": [max(uv[0::2]), max(uv[1::2])],
            },
        },
        "textures": [texture_records[key] for key in sorted(
            texture_records, key=lambda value: (value.startswith("block"), value))],
        "draws": draws,
        "coverage": coverage,
    }


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(MANIFEST_OUT))
    args = parser.parse_args(argv)

    roster_index_path = CAR_MATERIALS / "index.json"
    roster_index_raw = load_pinned(roster_index_path, COMMITTED_ROSTER_INDEX, "P52 roster index")
    roster_index = json.loads(roster_index_raw)
    if roster_index.get("kind") != "blur.car-material-texture-index" or roster_index.get("version") != 1:
        raise SystemExit("FAILED: P52 roster index kind/version is wrong")

    car_index_path = CAR_PARTS / "index.json"
    car_index_raw = load_pinned(car_index_path, COMMITTED_CAR_INDEX, "car-parts index")
    car_index = json.loads(car_index_raw)
    if car_index.get("kind") != "car-parts.car-model-index" or car_index.get("version") != 1:
        raise SystemExit("FAILED: car-parts index kind/version is wrong")

    cars = [entry["slug"] for entry in roster_index["cars"]]
    by_slug = {entry["slug"]: entry for entry in roster_index["cars"]}
    car_index_by_slug = {entry["slug"]: entry for entry in car_index["cars"]}
    if set(cars) != set(car_index_by_slug):
        raise SystemExit("FAILED: the P52 roster and the car-parts index do not cover the same cars")
    roster_order = [car["slug"] for car in JsonReader.load(
        ROOT / "probes/e1-drive/cars/roster.json")["cars"]]
    if set(roster_order) != set(cars):
        raise SystemExit("FAILED: the e1-drive roster and the P52 roster do not cover the same cars")

    records = []
    for slug in roster_order:
        entry = by_slug[slug]
        car_index_entry = car_index_by_slug[slug]
        if not car_index_entry.get("mapped"):
            raise SystemExit(f"FAILED: {slug} is not mapped in the car-parts index")
        records.append(build_car(entry, car_index_entry))

    totals = {
        "cars": len(records),
        "draws": sum(record["coverage"]["drawCount"] for record in records),
        "staticAlbedoDraws": sum(record["coverage"]["staticAlbedoDraws"] for record in records),
        "runtimePaintDraws": sum(record["coverage"]["runtimePaintDraws"] for record in records),
        "runtimeLightBlendDraws": sum(record["coverage"]["runtimeLightBlendDraws"] for record in records),
        "runtimeNoAlbedoDraws": sum(record["coverage"]["runtimeNoAlbedoDraws"] for record in records),
        "textures": sum(record["coverage"]["textureCount"] for record in records),
        "rgbaBytes": sum(record["coverage"]["rgbaBytes"] for record in records),
        "uvValues": sum(record["coverage"]["uvValues"] for record in records),
        "uvBytes": sum(record["coverage"]["uvBytes"] for record in records),
    }
    expected_map = {
        "cars": 5,
        "draws": EXPECTED["draws"],
        "staticAlbedoDraws": EXPECTED["staticAlbedoDraws"],
        "runtimePaintDraws": EXPECTED["paintDraws"],
        "runtimeLightBlendDraws": EXPECTED["lightDraws"],
        "runtimeNoAlbedoDraws": EXPECTED["noAlbedoDraws"],
        "textures": EXPECTED["textures"],
        "rgbaBytes": EXPECTED["rgbaBytes"],
        "uvValues": EXPECTED["uvValues"],
    }
    for key, value in expected_map.items():
        if totals[key] != value:
            raise SystemExit(f"FAILED: total {key} is {totals[key]}, P52 recorded {value}")

    # P52 also states that per-car static + paint + light + no-albedo == draws.
    for record in records:
        coverage = record["coverage"]
        if coverage["staticAlbedoDraws"] + coverage["runtimePaintDraws"] + \
                coverage["runtimeLightBlendDraws"] + coverage["runtimeNoAlbedoDraws"] != coverage["drawCount"]:
            raise SystemExit(f"FAILED: {record['slug']} draw classes do not add up")
        for draw in record["draws"]:
            if draw["drawClass"] == "staticAlbedo" and not draw["uv0Available"]:
                raise SystemExit(f"FAILED: {record['slug']} textured draw {draw['index']} has no UV0")

    manifest = {
        "kind": "e1-drive.car-textures",
        "version": 1,
        "generator": "probes/e1-drive/tools/build_car_textures.py",
        "scope": (
            "UV0 and static g_MeshTexture bindings for the five E1 roster cars. Draw/material/texture "
            "resolution and the decoded RGBA are the committed P52 manifest; the UV0 array is the "
            "committed scene_inspect.exe mesh stream whose positions equal the part manifest mesh. No UV, "
            "colour, address mode, mip level or runtime input is synthesised"
        ),
        "pins": {
            "p52RosterIndex": "sha256:" + COMMITTED_ROSTER_INDEX,
            "carPartsIndex": "sha256:" + COMMITTED_CAR_INDEX,
            "p52RosterIndexBytes": len(roster_index_raw),
            "carPartsIndexBytes": len(car_index_raw),
        },
        "sampler": SAMPLER,
        "uvConvention": UV_CONVENTION,
        "scopeLabels": {
            "materialsApplied": False,
            "shaderExecuted": False,
            "samplerApplied": False,
            "paintLookupRecovered": False,
            "lightBlendRecovered": False,
            "mipsApplied": False,
            "srgbApplied": False,
            "rendererClaim": False,
        },
        "cars": records,
        "totals": totals,
        "coverage": {
            "drawClasses": {
                "staticAlbedo": totals["staticAlbedoDraws"],
                "runtimePaintLookup": totals["runtimePaintDraws"],
                "runtimeLightBlend": totals["runtimeLightBlendDraws"],
                "runtimeShaderNoAlbedo": totals["runtimeNoAlbedoDraws"],
            },
            "note": (
                "224 draws sample a decoded static albedo image with the car's own UV0; 267 draws are "
                "runtime-only and keep the committed P52 reason and the diagnostic albedo (45 paint lookup, "
                "66 light off/on blend, 156 _NO_ALBEDO). No runtime image is invented"),
        },
        "limits": [
            "First RenderList base primitives, LOD0 only: later render lists, higher LODs, damage states, "
            "paint variants and runtime light states are not imported.",
            "No mip chain, sRGB conversion, anisotropy, material colour, blend state or shader stages: only the "
            "decoded mip0 albedo pixels are bound.",
            "The sampler is a declared PoC choice (repeat/linear on mip0), not recovered engine state.",
            "Paint lookups and light off/on blends are runtime inputs and stay unresolved by design.",
            "The car mesh is drawn in the engine body frame; the retail mesh import offset is not recovered.",
        ],
    }
    text = json.dumps(manifest, indent=1)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # Write the exact bytes that were hashed, LF newlines, no platform translation.
    out.write_bytes(text.encode("utf-8"))

    print(json.dumps({
        "output": rel(out),
        "bytes": len(text.encode("utf-8")),
        "sha256": "sha256:" + sha256_bytes(text.encode("utf-8")),
        "cars": len(records),
        "totals": totals,
        "perCar": [
            {
                "slug": record["slug"],
                "draws": record["coverage"]["drawCount"],
                "textured": record["coverage"]["staticAlbedoDraws"],
                "paint": record["coverage"]["runtimePaintDraws"],
                "light": record["coverage"]["runtimeLightBlendDraws"],
                "noAlbedo": record["coverage"]["runtimeNoAlbedoDraws"],
                "textures": record["coverage"]["textureCount"],
                "rgbaBytes": record["coverage"]["rgbaBytes"],
                "uvValues": record["coverage"]["uvValues"],
                "uvSha256": record["uvStream"]["sha256"],
            }
            for record in records
        ],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
