#!/usr/bin/env python3
"""Resolve static albedo + UV0 for a level's first-RenderList direct draws.

Defaults to ``usa_amboy`` so the committed package is unchanged; pass
``--level spa_barcelona_gracia`` to build the Gracia manifest. Data/analysis
only. The script consumes the committed map-pipeline draw probe stages
(node.chunk / geometry.chunk / native.json / reference.json), the original
levelrender/levelstream archives and the committed scene/material reader modules
under tools/. It writes a deterministic binding manifest under
``_work/map-slice/<short>-textures/``.

Nothing under probes/e1-drive, probes/map-pipeline, probes/asset-reader, the
engine, tools/, upstream/ or game-data/ is modified.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes/map-slice/tools"))

from inspect_car_level_assets import render_layout, resource_prefix, stream_prefix  # noqa: E402
from inspect_car_materials import texture_lod  # noqa: E402
from inspect_level_instances import InstanceReader, read_lists  # noqa: E402
from map_slice_common import package_dir, short_name, texture_dir  # noqa: E402

LEVEL = "usa_amboy"
PACKAGE = package_dir(LEVEL)
OUT = texture_dir(LEVEL)
STAGES = ROOT / "_work/map-pipeline/probes"
LEVEL_DIR = ROOT / "game-data/Blur/levels" / LEVEL
NATIVE = ROOT / "_work/build/asset-reader-native/Release/texture_inspect.exe"
PREFIX = short_name(LEVEL)

BC1 = 0x31545844
BC2 = 0x33545844
BC3 = 0x35545844
FORMAT_NAMES = {
    BC1: "DXT1/BC1",
    BC2: "DXT3/BC2",
    BC3: "DXT5/BC3",
    21: "A8R8G8B8",
    22: "X8R8G8B8",
    32: "A8B8G8R8",
    33: "X8B8G8R8",
    28: "A8",
    50: "L8",
}
SCHEMA = "blur.map-slice.amboy-textures/1"


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False,
                               allow_nan=False) + "\n", encoding="utf-8")


def fnv1a64(data: bytes) -> int:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def fnv_mix_f32(value: int, component: float) -> int:
    for byte in struct.pack("<f", component):
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def uv_range_hash(native: dict, first: int, count: int) -> str:
    uv = native["uv0"]
    indices = native["indices"]
    digest = 0xCBF29CE484222325
    for index in indices[first:first + count]:
        for axis in range(2):
            digest = fnv_mix_f32(digest, uv[index * 2 + axis])
    return "0x%016x" % digest


def constant_ref(ref: dict):
    return ref["index"], ref["listIndex"]


class Resolver:
    """Source-shaped replica of scene_reader.cpp bind_albedo() order."""

    def __init__(self, render_list: dict, effects: list[str]):
        self.list = render_list
        self.effects = effects
        self.constants = render_list["constants"]
        self.sources = render_list["sources"]["texture"]

    def _apply(self, ref, state, stack):
        index = ref["index"]
        list_index = ref["listIndex"]
        if list_index != 0:
            state.update(seen=True, known=False, slot=None, row=-1,
                         material=None, reason="Dynamic material list is rebuilt at runtime")
            return
        if not 0 <= index < len(self.constants):
            state.update(seen=True, known=False, slot=None, row=-1,
                         material=None, reason="Constant material index out of bounds")
            return
        if index in stack or len(stack) >= 32:
            raise ValueError("Recursive constant material reference")
        stack.append(index)
        material = self.constants[index]
        for field in material["fields"]:
            if field["type"] == 8:
                for child in field["values"]:
                    self._apply(child, state, stack)
            elif field["name"] == "g_tAlbedo":
                state.update(seen=True, row=index, material=material["typeName"])
                if field["type"] == 7 and field["count"] == 1 and field["values"]:
                    state.update(known=True, slot=field["values"][0], reason=None)
                else:
                    state.update(known=False, slot=None,
                                 reason="Albedo parameter depends on unsupported scalar shape or runtime material data")
            elif ("Texture" in field["name"] or "Albedo" in field["name"]) and \
                    field["type"] == 7 and field["count"] == 1 and field["values"]:
                state["otherTextures"].append({
                    "parameter": field["name"],
                    "slot": field["values"][0],
                    "materialRow": index,
                    "material": material["typeName"],
                })
        stack.pop()

    def resolve(self, primitive: dict) -> dict:
        state = {"seen": False, "known": False, "slot": None, "row": -1,
                 "material": None, "reason": None, "otherTextures": []}
        if primitive.get("instanceMaterial") is not None:
            self._apply(primitive["instanceMaterial"], state, [])
        self._apply(primitive["baseMaterial"], state, [])
        for stream in primitive["streams"]:
            if stream["streamIndex"] != -1:
                self._apply(stream["material"], state, [])
        return dict(state)

    def effect(self, primitive: dict) -> str:
        if not 0 <= primitive["effect"] < len(self.effects):
            raise ValueError("Primitive effect index out of bounds")
        effect = self.effects[primitive["effect"]]
        effect = effect.replace("\\", "/").rsplit("/", 1)[-1]
        if "." in effect:
            effect = effect.rsplit(".", 1)[0]
        return effect

    def vehicle_parameter(self, primitive: dict):
        """Return (is_vehicle, forced_reason). Mirrors bind_albedo's veh_ path."""
        effect = self.effect(primitive).lower()
        if not effect.startswith("veh_"):
            return False, None
        family_end = effect.find("_", 4)
        family = effect[4:family_end if family_end != -1 else len(effect)]
        if family == "light":
            return True, "Vehicle light Off/On blend depends on runtime colour and UV0.xy/zw"
        at = family_end
        while at != -1:
            nxt = effect.find("_", at + 1)
            flag = effect[at + 1:nxt if nxt != -1 else len(effect)]
            if flag == "a":
                reason = ("Vehicle _NO_ALBEDO paint uses a runtime paint lookup texture"
                          if family in ("paint", "paintm")
                          else "Vehicle _NO_ALBEDO shader does not sample an albedo image")
                return True, reason
            at = nxt
        return True, None


def section_stage(section: dict) -> Path:
    return STAGES / ("%s-g%d-n%d" % (LEVEL, section["geometryBlock"], section["nodeBlock"]))


def emitted_direct_draws(render_list: dict, scene: dict, geometry_block: int) -> list[dict]:
    """Draw order of scene_reader.cpp level_mesh(): filter + LOD0 nondegenerate count."""
    declarations = scene["declarations"]
    vertex_sources = render_list["sources"]["vertexBuffer"]
    index_sources = render_list["sources"]["indexBuffer"]
    draws = []
    for primitive_index, primitive in enumerate(render_list["primitives"]):
        declaration = declarations[primitive["declaration"]]
        position = next((e for e in declaration if e["usage"] == 0 and e["usageIndex"] == 0), None)
        if position is None:
            raise ValueError("primitive lacks POSITION0 declaration")
        selected = None
        for stream in primitive["streams"]:
            if stream["streamIndex"] == position["stream"] and stream["frequency"] == 0:
                selected = stream
                break
        if selected is None:
            raise ValueError("POSITION0 stream binding missing")
        if not 0 <= primitive["indexBuffer"] < len(index_sources):
            raise ValueError("invalid index source")
        vb_source = vertex_sources[selected["vertexBuffer"]]
        ib_source = index_sources[primitive["indexBuffer"]]
        if vb_source["block"] != geometry_block or ib_source["block"] != geometry_block:
            continue
        draws.append({"primitiveIndex": primitive_index,
                      "declaration": primitive["declaration"],
                      "topology": primitive["topology"],
                      "indexSource": ib_source,
                      "lod": primitive["lods"][0]})
    return draws


def triangle_count(geometry_data: bytes, resources: dict, draw: dict) -> int:
    ib = resources["indexBuffers"][draw["indexSource"]["index"]]
    lod = draw["lod"]
    fmt = "H" if ib["width"] == 2 else "I"
    width = ib["width"]
    values = [struct.unpack_from("<" + fmt, geometry_data,
                                 ib["dataOffset"] + (lod["offset"] + j) * width)[0]
              for j in range(lod["indexCount"])]
    step = 1 if draw["topology"] == 1 else 3
    if draw["topology"] not in (0, 1):
        raise ValueError("unsupported topology")
    if draw["topology"] == 0 and len(values) % 3:
        raise ValueError("invalid triangle list count")
    triangles = 0
    for j in range(2, len(values), step):
        a, b, c = values[j - 2:j + 1]
        if draw["topology"] == 1 and j % 2:
            a, b = b, a
        if len({a, b, c}) == 3:
            triangles += 1
    return triangles


class TextureArchive:
    """Lazily parse one levelstream ChunkInfo record and its resource items."""

    def __init__(self, records: list[dict], stream_path: Path):
        self.records = records
        self.stream_path = stream_path
        self.block_index = {}
        for record_index, record in enumerate(records):
            for item_index, item in enumerate(record["items"]):
                if item["lod"] == 0:
                    self.block_index.setdefault(item["block"], (record_index, item_index))
        self.record_cache = {}
        self.item_textures = {}
        self.texture_cache = {}

    def record_data(self, record_index: int) -> bytes:
        if record_index not in self.record_cache:
            record = self.records[record_index]
            with self.stream_path.open("rb") as handle:
                handle.seek(record["offset"])
                data = handle.read(record["storedBytes"])
            if len(data) != record["storedBytes"]:
                raise ValueError("short levelstream read")
            self.record_cache[record_index] = data
        return self.record_cache[record_index]

    def textures_for_item(self, record_index: int, item_index: int):
        key = (record_index, item_index)
        if key in self.item_textures:
            return self.item_textures[key]
        record = self.records[record_index]
        data = self.record_data(record_index)
        stream_prefix(data, record)
        cursor = 24
        for number, item in enumerate(record["items"]):
            if item["lod"] != 0:
                raise ValueError("texture item is not LOD0")
            resources = resource_prefix(data, {"resourcePayloadOffset": cursor,
                                               "scenePayloadOffset": 0}, streamed=True)
            if resources["nodeCount"]:
                read_lists(data, resources)
                reader = InstanceReader(data, resources["parsedNodesEnd"])
            else:
                reader = InstanceReader(data, resources["firstNodeOffset"])
            count = reader.count(16)
            textures = [texture_lod(reader, item["lod"], 0) for _ in range(count)]
            self.item_textures[(record_index, number)] = textures
            cursor = reader.p
            if number == item_index:
                return textures
        raise ValueError("item index outside record")

    def texture(self, block: int, index: int):
        if (block, index) in self.texture_cache:
            return self.texture_cache[(block, index)]
        location = self.block_index.get(block)
        if location is None:
            self.texture_cache[(block, index)] = None
            return None
        record_index, item_index = location
        textures = self.textures_for_item(record_index, item_index)
        if not 0 <= index < len(textures):
            self.texture_cache[(block, index)] = None
            return None
        result = dict(textures[index])
        result["_recordIndex"] = record_index
        result["_itemIndex"] = item_index
        result["_data"] = self.record_data(record_index)
        self.texture_cache[(block, index)] = result
        return result


def decode_texture(blob: bytes, raw_path: Path, rgba_path: Path) -> dict:
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_bytes(blob)
    process = subprocess.run([str(NATIVE), str(raw_path), "--raw"],
                             capture_output=True, timeout=120)
    if process.returncode != 0 or not process.stdout:
        raise ValueError("committed decoder rejected the texture: " +
                         process.stderr.decode("utf-8", "replace")[-300:])
    doc = json.loads(process.stdout.decode("utf-8"))
    if doc.get("status") != "ok":
        raise ValueError("committed decoder status: " + str(doc.get("status")))
    width, height = doc["width"], doc["height"]
    rgba = bytes(doc["rgba"])
    if len(rgba) != width * height * 4:
        raise ValueError("decoded RGBA length differs from dimensions")
    rgba_path.parent.mkdir(parents=True, exist_ok=True)
    rgba_path.write_bytes(rgba)
    alphas = rgba[3::4]
    return {
        "width": width,
        "height": height,
        "rgbaBytes": len(rgba),
        "rgbaSha256": sha256_bytes(rgba),
        "rgbaFnv1a64": "0x%016x" % fnv1a64(rgba),
        "alpha": {
            "min": min(alphas) if alphas else 255,
            "max": max(alphas) if alphas else 255,
            "distinct": len(set(alphas)),
            "alphaOpaque": all(value == 255 for value in alphas),
        },
    }


def texture_source_record(source: dict, archive: TextureArchive, scene: dict):
    block, index = source["block"], source["index"]
    if block == -1:
        if not 0 <= index < len(scene["sharedTextures"]):
            return None
        shared = scene["sharedTextures"][index]
        data = (LEVEL_DIR / "level.levelrender").read_bytes()
        blob = data[shared["dataOffset"]:shared["dataOffset"] + shared["dataBytes"]]
        if len(blob) < 28:
            return None
        descriptor = dict(zip(("width", "height", "depth", "levels", "format",
                               "usage", "type"), struct.unpack_from("<7I", blob, 0)))
        return {
            "kind": "shared",
            "block": -1,
            "index": index,
            "name": shared["name"],
            "textureHash": shared["sharedHash"],
            "sampler": shared.get("sampler"),
            "descriptor": descriptor,
            "width": descriptor["width"],
            "height": descriptor["height"],
            "levels": descriptor["levels"],
            "format": descriptor["format"],
            "payloadBytes": shared["dataBytes"],
            "blob": blob,
            "id": "%s.shared.%d" % (PREFIX, index),
        }
    record = archive.texture(block, index)
    if record is None:
        return None
    descriptor = record.get("descriptor")
    if not descriptor:
        return None
    blob = (record["_data"][record["headerOffset"]:record["headerOffset"] + record["headerBytes"]] +
            record["_data"][record["dataOffset"]:record["dataOffset"] + record["dataBytes"]])
    return {
        "kind": "resource-block",
        "block": block,
        "index": index,
        "name": record["name"],
        "textureHash": record["hash"],
        "sampler": record["sampler"],
        "descriptor": descriptor,
        "width": descriptor["width"],
        "height": descriptor["height"],
        "levels": descriptor["levels"],
        "format": descriptor["format"],
        "payloadBytes": record["dataBytes"],
        "blob": blob,
        "id": "%s.albedo.%d.%d" % (PREFIX, block, index),
    }


def texture_identity(source: dict, archive: TextureArchive, scene: dict):
    block, index = source["block"], source["index"]
    if block == -1:
        if 0 <= index < len(scene["sharedTextures"]):
            shared = scene["sharedTextures"][index]
            return {"block": block, "index": index, "kind": "shared",
                    "name": shared["name"], "textureHash": shared["sharedHash"]}
        return None
    record = archive.texture(block, index)
    if record is None:
        return {"block": block, "index": index, "kind": "resource-block",
                "name": None, "textureHash": None,
                "reason": "resource block has no LOD0 stream item"}
    descriptor = record.get("descriptor") or {}
    return {"block": block, "index": index, "kind": "resource-block",
            "name": record["name"], "textureHash": record["hash"],
            "width": descriptor.get("width"), "height": descriptor.get("height"),
            "levels": descriptor.get("levels"), "format": descriptor.get("format"),
            "formatName": FORMAT_NAMES.get(descriptor.get("format"), "unsupported")}


def classify_draw(draw: dict, texture) -> tuple[str, str | None]:
    if draw["uvHash"] is None:
        return "blocked-uv0-missing", "no original UV0 for this draw"
    material = draw["material"]
    if not material["seen"]:
        if material.get("otherTextures"):
            names = ", ".join(sorted({item["parameter"] for item in material["otherTextures"]}))
            return ("blocked-effect-not-static-albedo",
                    "no g_tAlbedo assignment; shader exposes %s (%s) from an additive layer/effect shader"
                    % (names, draw["effect"]))
        return "blocked-no-static-albedo", "no g_tAlbedo assignment in the primitive material stack"
    if not material["known"]:
        return "blocked-runtime-albedo-parameter", material["reason"]
    if material.get("forced_reason"):
        return "blocked-effect-not-static-albedo", material["forced_reason"]
    if texture is None:
        return "blocked-missing-texture-source", "node texture source could not be resolved"
    if not texture.get("decoded"):
        if texture.get("decodeBlocker") == "decoder-size-limit":
            return "blocked-decoder-size-limit", texture.get("decodeError")
        return "blocked-unsupported-texture-format", texture.get("decodeError", "texture decode failed")
    fmt = texture["format"]
    if fmt not in FORMAT_NAMES:
        return "blocked-unsupported-texture-format", "unsupported texture format %d" % fmt
    alpha = texture["alpha"]
    if not alpha["alphaOpaque"]:
        return "blocked-alpha-rule-missing", "source alpha is not opaque; no alpha-test/blend rule is declared"
    return "bindable-static-albedo", None


def main() -> int:
    global LEVEL, PACKAGE, OUT, LEVEL_DIR, PREFIX, SCHEMA
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--level", default=LEVEL)
    parser.add_argument("--package", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    LEVEL = args.level
    PREFIX = short_name(LEVEL)
    PACKAGE = (args.package or package_dir(LEVEL)).resolve()
    OUT = (args.out or texture_dir(LEVEL)).resolve()
    LEVEL_DIR = ROOT / "game-data/Blur/levels" / LEVEL
    SCHEMA = ("blur.map-slice.amboy-textures/1" if LEVEL == "usa_amboy"
              else "blur.map-slice.textures/1")
    package, out = PACKAGE, OUT
    out.mkdir(parents=True, exist_ok=True)

    slice_doc = load_json(package / "slice.json")
    levelrender = (LEVEL_DIR / "level.levelrender").read_bytes()
    stream_path = LEVEL_DIR / "level.levelstream"
    layout = render_layout(levelrender, "level")
    scene = layout["scene"]
    records = scene["stream"]["chunks"]
    archive = TextureArchive(records, stream_path)

    section_rows = []
    draw_rows = []
    texture_cache = {}
    bindable_texture_ids = set()

    for section in slice_doc["draws"]["sections"]:
        stage = section_stage(section)
        node_raw = (stage / "node.chunk").read_bytes()
        record = records[section["nodeChunkIndex"]]
        if not record["items"] or record["items"][0] != {"block": section["nodeBlock"], "lod": 0}:
            raise SystemExit("node chunk record mismatch for " + section["id"])
        stream_prefix(node_raw, record)
        resources = resource_prefix(node_raw, {"resourcePayloadOffset": 24,
                                               "scenePayloadOffset": 0}, streamed=True)
        lists = read_lists(node_raw, resources)
        if not lists:
            raise SystemExit("node chunk has no RenderList for " + section["id"])
        # The committed reader emits the first node-chunk RenderList; later
        # lists in the same chunk are not part of the direct-draw pass.
        render_list = lists[0]
        resolver = Resolver(render_list, scene["effects"])

        geometry_data = (stage / "geometry.chunk").read_bytes()
        stream_prefix(geometry_data, records[section["geometryChunkIndex"]])
        geometry_resources = resource_prefix(
            geometry_data, {"resourcePayloadOffset": 24, "scenePayloadOffset": 0}, streamed=True)

        native = load_json(stage / "native.json")
        reference = load_json(stage / "reference.json")
        expected = emitted_direct_draws(render_list, scene, section["geometryBlock"])
        if len(expected) != len(native["draws"]) or len(expected) != len(reference["draws"]):
            raise SystemExit("draw count mismatch for " + section["id"])
        triangles = 0
        section_first_index = 0
        for draw_index, (emit, native_draw, ref_draw) in enumerate(
                zip(expected, native["draws"], reference["draws"])):
            if emit["primitiveIndex"] != ref_draw["primitiveIndex"]:
                raise SystemExit("primitive order mismatch for " + section["id"])
            tri = triangle_count(geometry_data, geometry_resources, emit)
            if tri * 3 != native_draw["indexCount"] or \
                    native_draw["firstIndex"] != section_first_index:
                raise SystemExit("draw range mismatch for " + section["id"])
            section_first_index += native_draw["indexCount"]
            triangles += tri
            primitive = render_list["primitives"][emit["primitiveIndex"]]
            is_vehicle, forced = resolver.vehicle_parameter(primitive)
            material = resolver.resolve(primitive)
            material["forced_reason"] = forced
            parameter = "g_MeshTexture" if is_vehicle else "g_tAlbedo"
            source = None
            texture = None
            if material["known"] and material["slot"] is not None and not forced and not is_vehicle:
                if 0 <= material["slot"] < len(render_list["sources"]["texture"]):
                    source = dict(render_list["sources"]["texture"][material["slot"]])
                    key = (source["block"], source["index"])
                    if key not in texture_cache:
                        record_tex = texture_source_record(source, archive,
                                                           layout["scene"])
                        if record_tex is not None:
                            blob = record_tex.pop("blob")
                            blob_name = record_tex["id"] + ".raw"
                            blob_path = out / "raw" / blob_name
                            blob_path.parent.mkdir(parents=True, exist_ok=True)
                            blob_path.write_bytes(blob)
                            record_tex["blobPath"] = rel(blob_path)
                            record_tex["blobSha256"] = sha256_bytes(blob)
                            record_tex["blobBytes"] = len(blob)
                            record_tex["format"] = record_tex["descriptor"]["format"]
                            if record_tex["width"] > 512 or record_tex["height"] > 512:
                                record_tex["decoded"] = False
                                record_tex["decodeBlocker"] = "decoder-size-limit"
                                record_tex["decodeError"] = (
                                    "committed texture_inspect decodes 2D textures up to 512x512; "
                                    "source is %dx%d" % (record_tex["width"], record_tex["height"]))
                            else:
                                try:
                                    decoded = decode_texture(
                                        blob, blob_path,
                                        out / "textures" / (record_tex["id"] + ".rgba"))
                                    record_tex.update(decoded)
                                    record_tex["decoded"] = True
                                except ValueError as error:
                                    record_tex["decoded"] = False
                                    record_tex["decodeBlocker"] = "decoder-rejected"
                                    record_tex["decodeError"] = str(error)
                            record_tex["formatName"] = FORMAT_NAMES.get(
                                record_tex.get("format"), "unsupported/%s" % record_tex.get("format"))
                            texture_cache[key] = record_tex
                        else:
                            texture_cache[key] = None
                    texture = texture_cache.get(key)
            uv_hash = uv_range_hash(native, native_draw["firstIndex"], native_draw["indexCount"])
            aux = None
            if not material["seen"] and material.get("otherTextures"):
                first = material["otherTextures"][0]
                if 0 <= first["slot"] < len(render_list["sources"]["texture"]):
                    aux_source = dict(render_list["sources"]["texture"][first["slot"]])
                    aux = {"parameter": first["parameter"], **texture_identity(
                        aux_source, archive, scene)}
            row = {
                "section": section["id"],
                "drawIndex": draw_index,
                "primitiveIndex": emit["primitiveIndex"],
                "firstIndex": native_draw["firstIndex"],
                "indexCount": native_draw["indexCount"],
                "triangleCount": tri,
                "effect": resolver.effect(primitive),
                "parameter": parameter,
                "material": material,
                "textureSource": source,
                "textureId": texture["id"] if texture else None,
                "textureName": texture["name"] if texture else None,
                "textureFormat": texture.get("formatName") if texture else None,
                "textureRgbaSha256": texture.get("rgbaSha256") if texture else None,
                "textureRgbaFnv1a64": texture.get("rgbaFnv1a64") if texture else None,
                "auxTexture": aux,
                "uv0Available": bool(native_draw.get("uv0Available")),
                "uvHash": uv_hash,
            }
            status, reason = classify_draw(row, texture)
            row["status"] = status
            row["blocker"] = reason
            row["bindable"] = status == "bindable-static-albedo"
            if row["bindable"] and texture:
                bindable_texture_ids.add(texture["id"])
            draw_rows.append(row)

        section_rows.append({
            "id": section["id"],
            "geometryBlock": section["geometryBlock"],
            "nodeBlock": section["nodeBlock"],
            "drawCount": len(expected),
            "triangleCount": triangles,
            "statuses": dict(Counter(row["status"] for row in draw_rows
                                     if row["section"] == section["id"])),
        })

    textures = []
    for key, texture in texture_cache.items():
        if texture is None:
            continue
        entry = {k: v for k, v in texture.items() if k not in ("decoded",)}
        entry["drawCount"] = sum(1 for row in draw_rows if row["textureId"] == texture["id"])
        entry["triangleCount"] = sum(row["triangleCount"] for row in draw_rows
                                     if row["textureId"] == texture["id"])
        entry["bindableDrawCount"] = sum(1 for row in draw_rows
                                         if row["textureId"] == texture["id"] and row["bindable"])
        entry["sections"] = sorted({row["section"] for row in draw_rows
                                    if row["textureId"] == texture["id"]})
        textures.append(entry)
    textures.sort(key=lambda item: item["id"])

    status_counts = Counter(row["status"] for row in draw_rows)
    status_triangles = Counter()
    for row in draw_rows:
        status_triangles[row["status"]] += row["triangleCount"]
    aux_groups = Counter()
    for row in draw_rows:
        if row["auxTexture"]:
            aux_groups[(row["effect"], row["auxTexture"].get("name"),
                        row["auxTexture"].get("block"),
                        row["auxTexture"].get("index"))] += 1
    status_effects = Counter()
    for row in draw_rows:
        status_effects[(row["status"], row["effect"])] += 1
    effect_layer_names = sorted({row["effect"] for row in draw_rows
                                 if row["status"] == "blocked-effect-not-static-albedo"})
    unsupported_count = len(slice_doc["draws"]["unsupportedSections"])
    if "Racification" in " ".join(effect_layer_names) or \
            any(name.startswith("Racification") for name in effect_layer_names):
        effect_limit = ("Racification draws expose a static g_tTexture from an "
                        "additive alpha-tested layer shader; they are not bound as "
                        "albedo.")
    else:
        effect_limit = ("Effect-layer draws (%d, %s) expose a shader texture that is "
                        "not a static g_tAlbedo; they are recorded but not bound as "
                        "albedo." % (status_counts.get(
                            "blocked-effect-not-static-albedo", 0),
                            ", ".join(effect_layer_names) or "none"))

    result = {
        "schema": SCHEMA,
        "kind": "map-slice-texture-bindings",
        "level": LEVEL,
        "scope": {
            "dataOnly": True,
            "rendererChanged": False,
            "gpuClaim": False,
            "browserFrameProduced": False,
            "texturesBoundInRenderer": False,
            "instancesApplied": False,
            "materialsBeyondStaticAlbedoApplied": False,
            "alphaRuleApplied": False,
            "samplerApplied": False,
            "normalsExported": False,
            "source": "first-RenderList direct LOD0 primitives only",
        },
        "inputs": {
            "levelrender": {"path": rel(LEVEL_DIR / "level.levelrender"),
                            "bytes": len(levelrender),
                            "sha256": sha256_bytes(levelrender)},
            "levelstream": {"path": rel(stream_path),
                            "bytes": stream_path.stat().st_size,
                            "sha256": sha256_file(stream_path)},
            "slice": {"path": rel(package / "slice.json"),
                      "sha256": sha256_file(package / "slice.json")},
            "committedTextureDecoder": {"path": rel(NATIVE),
                                        "sha256": sha256_file(NATIVE)},
        },
        "materialResolution": {
            "reader": "source-shaped replica of scene_reader.cpp bind_albedo(): instance -> base -> every active stream material, nested type-8 rows followed, last g_tAlbedo wins",
            "albedoParameters": ["g_tAlbedo", "g_MeshTexture"],
            "vehicleEffects": "the veh_ path is implemented and none of the %s draws "
                              "uses it" % format(len(draw_rows), ","),
        },
        "counts": {
            "sections": len(section_rows),
            "draws": len(draw_rows),
            "triangles": sum(row["triangleCount"] for row in draw_rows),
            "statuses": dict(status_counts),
            "statusTriangles": dict(status_triangles),
            "bindableDraws": status_counts.get("bindable-static-albedo", 0),
            "bindableTriangles": status_triangles.get("bindable-static-albedo", 0),
            "blockedDraws": len(draw_rows) - status_counts.get("bindable-static-albedo", 0),
            "distinctTextureSources": len(textures),
            "bindableTextureSources": len(bindable_texture_ids),
            "textureBytes": sum(texture.get("rgbaBytes", 0) for texture in textures),
            "bindableTextureBytes": sum(texture.get("rgbaBytes", 0) for texture in textures
                                        if texture["id"] in bindable_texture_ids),
            "statusEffects": {"%s | %s" % key: value
                              for key, value in sorted(status_effects.items())},
            "auxTextureGroups": [
                {"effect": key[0], "name": key[1], "block": key[2],
                 "index": key[3], "draws": value}
                for key, value in sorted(aux_groups.items(),
                                         key=lambda item: (-item[1], item[0]))
            ],
        },
        "sections": section_rows,
        "draws": draw_rows,
        "textures": textures,
        "limits": [
            "Data only: no renderer, GPU, browser, playable-game or full-game claim.",
            "Static g_tAlbedo/g_MeshTexture identity and UV0 only; g_tMaterial, material colour, blend, alpha test, shader stages, sampler wrap/filter, mips and sRGB are not applied.",
            effect_limit,
            "First-RenderList direct LOD0 primitives only; instances and the %d "
            "unsupported sections are reported separately." % unsupported_count,
        ],
    }
    write_json(out / "bindings.json", result)
    write_json(out / "summary.json", {
        "schema": SCHEMA,
        "kind": "map-slice-texture-bindings-summary",
        "level": LEVEL,
        "counts": result["counts"],
        "statusCounts": dict(status_counts),
        "statusTriangles": dict(status_triangles),
        "textures": [{"id": texture["id"], "name": texture["name"],
                      "formatName": texture.get("formatName"),
                      "width": texture.get("width"), "height": texture.get("height"),
                      "rgbaBytes": texture.get("rgbaBytes"),
                      "rgbaSha256": texture.get("rgbaSha256"),
                      "bindableDrawCount": texture["bindableDrawCount"]}
                     for texture in textures],
        "inputs": result["inputs"],
    })
    print(json.dumps(result["counts"], indent=1))
    print("bindings:", rel(out / "bindings.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
