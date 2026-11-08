#!/usr/bin/env python3
"""Verify the per-map material recipe packages.

Checks are independent of the builder's recipe assembly: the verifier re-parses
each node chunk with its own render-list walker, re-reads the committed
map-slice packages and re-runs the builder twice for byte determinism.

Usage:
  python probes/map-materials/tools/verify_map_materials.py [--no-rebuild]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes/map-materials/tools"))

from inspect_car_level_assets import render_layout, resource_prefix, stream_prefix
from inspect_car_materials import MaterialReader
from inspect_level_chunk import NodeReader
from map_materials_common import (BLEND_FACTORS, BLEND_OPS, CULL_MODES,
                                  LEVELS, PASS_BLEND_ENABLE, PASS_DEPTH,
                                  RENDER_PASSES)

PROBES = ROOT / "_work/map-pipeline/probes"
PY = sys.executable
BUILDER = ROOT / "probes/map-materials/tools/build_map_materials.py"
ALLOWED_BLOCKERS = {
    "alpha-rule-missing", "decoder-size-limit", "runtime-albedo-parameter",
    "effect-not-static-albedo", "no-static-albedo", "texture-stage-unresolved",
}
CLASSES = {"opaque", "alpha-tested", "alpha-blended", "additive-decal", "emissive-light"}


class Checker:
    def __init__(self):
        self.checks = 0
        self.failures = []
        self.categories = Counter()
        self.category_failures = Counter()

    def check(self, condition, category, message):
        self.checks += 1
        self.categories[category] += 1
        if not condition:
            self.failures.append("%s: %s" % (category, message))
            self.category_failures[category] += 1

    def fail(self, category, message):
        self.failures.append("%s: %s" % (category, message))
        self.category_failures[category] += 1


class IndependentReader(MaterialReader):
    """Second implementation of the render-list walk, written for this gate."""

    material = NodeReader.material
    stream = NodeReader.stream
    instance = NodeReader.instance

    def primitive(self):
        start = self.p
        version = self.ar(1)
        effect, declaration, topology, index_buffer, flags = self.unpack("5i")
        base = self.material()
        instance = self.material() if version else None
        self.ar()
        raw = self.b[self.p:self.p + 24]
        if len(raw) != 24:
            raise ValueError("truncated blend state")
        self.p += 24
        src, dst, op, ab, at, ref, am, cull, zbias = struct.unpack("<iiiBBBBii", raw)
        lods = []
        for _ in range(self.vec(64)):
            self.ar()
            lods.append(self.unpack("4I"))
        streams = [self.stream() for _ in range(self.vec(32))]
        return {
            "offset": start, "version": version, "effect": effect,
            "declaration": declaration, "topology": topology,
            "indexBuffer": index_buffer, "flags": flags,
            "baseMaterial": base, "instanceMaterial": instance,
            "blend": (src, dst, op, ab, at, ref, am, cull, zbias),
            "lods": lods, "streams": streams,
        }

    def render_list(self):
        version = self.ar(4)
        if version < 2:
            raise ValueError("legacy render list")
        self.cull()
        inline = self.material_list()
        primitives = [self.primitive() for _ in range(self.vec())]
        instances = [self.instance() for _ in range(self.vec())]
        for _ in range(self.vec()):
            self.ar()
            self.instance()
            self.stream()
        bases = [self.primitive() for _ in range(self.vec())]
        constants = self.material_data(inline["types"])
        pass_infos = []
        for _ in range(self.vec()):
            self.ar()
            pass_infos.append(self.unpack("6i"))
        for _ in range(3):
            for _ in range(self.vec()):
                self.bounds()
        for _ in range(3):
            flag = self.ar(1)
            self.take(4)
            if flag:
                self.take(self.vec() * 2)
            self.take(4)
            self.take(self.vec(16 * 1024 * 1024))
        self.take(self.vec() * 4)
        for _ in range(self.vec()):
            self.ar()
            self.bits()
            self.bits()
        for _ in range(2 if version == 3 else self.vec(256) if version > 3 else 0):
            self.material_list()
        sources = {key: [self.unpack("ii") for _ in range(self.vec())]
                   for key in ("indexBuffer", "vertexBuffer", "texture")}
        for _ in range(self.vec()):
            self.ar()
            self.unpack("i")
            for _ in range(3):
                for _ in range(self.vec()):
                    self.ar()
                    self.unpack("3i")
        return {
            "primitives": primitives, "basePrimitives": bases,
            "constants": constants["materials"], "passInfos": pass_infos,
            "sources": sources,
        }


def independent_lists(data: bytes, resources: dict):
    reader = IndependentReader(data, resources["firstNodeOffset"])
    result = []
    for _ in range(resources["nodeCount"]):
        tag = reader.unpack("B")
        if tag == 0:
            continue
        if tag != 3:
            raise ValueError("bad node pointer")
        name = reader.string()
        version = reader.ar(4)
        if name == "RenderingData::RenderListNode_Common":
            if version:
                raise ValueError("bad render list version")
            result.append(reader.render_list())
        elif name == "RenderingData::CullNode":
            reader.node()
            reader.bounds()
            reader.bits()
            if version > 0:
                reader.take(4)
            if version > 1:
                reader.bits()
        elif name == "RenderingData::RootNode":
            reader.cull()
        elif name == "RenderingData::GroupNode":
            reader.cull()
            reader.string()
        elif name == "RenderingData::LodNode":
            reader.cull()
            reader.take(reader.vec() * 4)
        elif name == "RenderingData::Node":
            reader.string()
            reader.take(reader.vec() * 8 + 16)
        else:
            raise ValueError("bad node " + name)
    return result


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_hash(doc: dict) -> str:
    body = {key: value for key, value in doc.items() if key != "hashes"}
    return "sha256:" + hashlib.sha256(
        json.dumps(body, sort_keys=True, separators=(",", ":"),
                   ensure_ascii=True, allow_nan=False).encode("utf-8")).hexdigest()


def stack_ids(render_list: dict, primitive: dict) -> list[str]:
    constants = render_list["constants"]
    order = []

    def apply(ref, stack):
        index, list_index = ref["index"], ref["listIndex"]
        if list_index != 0:
            return
        if index in stack or len(stack) >= 32:
            raise ValueError("recursive material")
        order.append("list0-material%d" % index)
        for field in constants[index]["fields"]:
            if field["type"] == 8:
                for child in field["values"]:
                    apply(child, stack + (index,))

    if primitive.get("instanceMaterial") is not None:
        apply(primitive["instanceMaterial"], ())
    apply(primitive["baseMaterial"], ())
    for stream in primitive["streams"]:
        if stream["streamIndex"] != -1:
            apply(stream["material"], ())
    return order


def texture_refs(render_list: dict, primitive: dict) -> dict:
    constants = render_list["constants"]
    sources = render_list["sources"]["texture"]
    refs = {}

    def apply(ref, stack):
        index, list_index = ref["index"], ref["listIndex"]
        if list_index != 0:
            return
        if index in stack or len(stack) >= 32:
            raise ValueError("recursive material")
        for field in constants[index]["fields"]:
            if field["type"] == 8:
                for child in field["values"]:
                    apply(child, stack + (index,))
            elif field["type"] == 7 and field["count"] == 1 and len(field["values"]) == 1:
                slot = field["values"][0]
                if 0 <= slot < len(sources):
                    refs[field["name"]] = tuple(sources[slot])
                else:
                    refs[field["name"]] = None

    if primitive.get("instanceMaterial") is not None:
        apply(primitive["instanceMaterial"], ())
    apply(primitive["baseMaterial"], ())
    for stream in primitive["streams"]:
        if stream["streamIndex"] != -1:
            apply(stream["material"], ())
    return refs


def pass_name(pass_infos: list, index: int) -> str | None:
    for number, info in enumerate(pass_infos):
        if info[1] <= index < info[1] + info[0]:
            return RENDER_PASSES[number]
    return None


def verify_map(short: str, doc: dict, checker: Checker, rebuild: bool, temp_root: Path):
    level = doc["level"]
    level_dir = ROOT / "game-data/Blur/levels" / level
    header = (level_dir / "level.levelrender").read_bytes()
    scene = render_layout(header, "level")["scene"]
    records = scene["stream"]["chunks"]

    checker.check(doc.get("schema") == "blur.map-materials/1", "schema", short + " schema")
    checker.check(doc.get("kind") == "map-material-recipes", "schema", short + " kind")
    checker.check(doc.get("level") == level, "schema", short + " level")
    checker.check(doc.get("shortName") == short, "schema", short + " shortName")
    checker.check(doc["inputs"]["levelrender"]["sha256"] == hashlib.sha256(header).hexdigest(),
                  "inputs", short + " levelrender hash")

    slice_doc = None
    binding_doc = None
    if short != "river":
        slice_path = ROOT / f"_work/map-slice/{short}/slice.json"
        bind_path = ROOT / f"_work/map-slice/{short}-textures/bindings.json"
        slice_doc = json.loads(slice_path.read_text(encoding="utf-8"))
        binding_doc = json.loads(bind_path.read_text(encoding="utf-8"))
        checker.check(doc["inputs"]["slice"]["sha256"] == sha256_file(slice_path), "inputs", short + " slice pin")
        checker.check(doc["inputs"]["bindings"]["sha256"] == sha256_file(bind_path), "inputs", short + " bindings pin")
        supported = [s for s in slice_doc["draws"]["sections"] if s["status"] == "supported"]
        checker.check(len(doc["sections"]) == len(supported), "counts", short + " section count")
        checker.check(doc["counts"]["draws"] == len(binding_doc["draws"]), "counts", short + " draw count vs bindings")
        checker.check(doc["counts"]["draws"] == slice_doc["draws"]["drawCount"], "counts", short + " draw count vs slice")
    else:
        checker.check(len(doc["sections"]) == 46, "counts", "river 46 sections")

    checker.check(doc["counts"]["draws"] == len(doc["draws"]), "counts", short + " draws array length")
    checker.check(doc["counts"]["triangles"] == sum(d["triangleCount"] for d in doc["draws"]),
                  "counts", short + " triangle total")
    checker.check(doc["counts"]["sections"] == len(doc["sections"]), "counts", short + " section total")

    class_counter = Counter(d["blendClass"] for d in doc["draws"])
    for name, count in class_counter.items():
        checker.check(name in CLASSES, "class", "%s unknown class %s" % (short, name))
        checker.check(doc["classes"].get(name, {}).get("draws") == count,
                      "class", "%s class %s count" % (short, name))
    checker.check(sum(class_counter.values()) == len(doc["draws"]), "class", short + " class coverage")
    checker.check(doc["counts"]["recipesComplete"] + doc["counts"]["recipesPartial"] == len(doc["draws"]),
                  "recipes", short + " recipe status coverage")
    checker.check(doc["counts"]["recipesComplete"] == sum(1 for d in doc["draws"] if d["recipeStatus"] == "complete"),
                  "recipes", short + " complete count")
    checker.check(doc["counts"]["recipesPartial"] == sum(1 for d in doc["draws"] if d["recipeStatus"] == "partial"),
                  "recipes", short + " partial count")

    section_counts = {s["id"]: s["drawCount"] for s in doc["sections"]}
    checker.check(sum(section_counts.values()) == len(doc["draws"]), "counts", short + " section draw sum")

    ids = set()
    for draw in doc["draws"]:
        did = draw["id"]
        checker.check(did not in ids, "identity", short + " duplicate id " + did)
        ids.add(did)
        checker.check(did == "%s:%s:%d" % (short, draw["section"], draw["drawIndex"]),
                      "identity", short + " id shape " + did)
        checker.check(draw["blendClass"] in CLASSES, "class", did)
        pass_record = draw["pass"]
        checker.check(pass_record["name"] in RENDER_PASSES, "pass", did)
        checker.check(pass_record["index"] == RENDER_PASSES.index(pass_record["name"]), "pass", did)
        checker.check(pass_record["depthTest"] == PASS_DEPTH[pass_record["name"]]["depthTest"], "depth", did)
        checker.check(pass_record["depthWrite"] == PASS_DEPTH[pass_record["name"]]["depthWrite"], "depth", did)
        checker.check(pass_record["blendEnable"] == PASS_BLEND_ENABLE[pass_record["name"]], "pass", did)
        blend = draw["blend"]
        checker.check(0 <= blend["srcBlend"] < len(BLEND_FACTORS), "blend", did + " srcBlend")
        checker.check(0 <= blend["destBlend"] < len(BLEND_FACTORS), "blend", did + " destBlend")
        checker.check(0 <= blend["blendOp"] < len(BLEND_OPS), "blend", did + " blendOp")
        checker.check(blend["srcBlendName"] == BLEND_FACTORS[blend["srcBlend"]], "blend", did + " src name")
        checker.check(blend["destBlendName"] == BLEND_FACTORS[blend["destBlend"]], "blend", did + " dst name")
        checker.check(blend["blendOpName"] == BLEND_OPS[blend["blendOp"]], "blend", did + " op name")
        checker.check(blend["alphaBlendEnable"] == pass_record["blendEnable"], "blend", did + " pass/blend")
        if pass_record["name"] in ("OVERLAY", "BACK_FRONT", "RACIFICATION"):
            checker.check(blend["alphaBlendEnable"] is True, "blend", did + " overlay must blend")
        else:
            checker.check(blend["alphaBlendEnable"] is False, "blend", did + " opaque must not blend")
        checker.check(0 <= draw["cull"]["mode"] < len(CULL_MODES), "cull", did)
        checker.check(draw["cull"]["name"] == CULL_MODES[draw["cull"]["mode"]], "cull", did)
        checker.check(0 <= draw["zBias"] <= 15, "cull", did + " zBias")
        checker.check(0 <= draw["alphaTest"]["ref"] <= 255, "alpha-test", did)
        if draw["alphaTest"]["enable"] or draw["alphaTest"]["toMask"]:
            checker.check(pass_record["name"] in ("ALPHA_TEST", "OVERLAY", "BACK_FRONT", "RACIFICATION"),
                          "alpha-test", did + " alpha-test pass")
        if pass_record["name"] == "ALPHA_TEST":
            checker.check(draw["alphaTest"]["enable"] or draw["alphaTest"]["toMask"],
                          "alpha-test", did + " ALPHA_TEST state")
        checker.check(draw["recipeStatus"] in ("complete", "partial"), "recipes", did)
        if draw["recipeStatus"] == "complete":
            checker.check(len(draw["blockers"]) == 0, "recipes", did + " complete with blockers")
        else:
            checker.check(len(draw["blockers"]) > 0, "recipes", did + " partial without blocker")
        for blocker in draw["blockers"]:
            checker.check(blocker["kind"] in ALLOWED_BLOCKERS, "blockers", did + " " + str(blocker.get("kind")))
            checker.check(bool(blocker.get("reason", "").strip()) or blocker["kind"] == "texture-stage-unresolved",
                          "blockers", did + " reason")
        material = draw["material"]
        checker.check(len(material["stack"]) > 0, "material", did + " empty stack")
        checker.check(len(material["parameters"]) > 0, "material", did + " empty parameters")
        for name, parameter in material["parameters"].items():
            checker.check(parameter["serializedOffset"] > 0, "material", did + " " + name + " offset")
            checker.check(parameter["type"] in range(11), "material", did + " " + name + " type")
            if "values" in parameter:
                checker.check(all(not isinstance(v, float) or math.isfinite(v) for v in parameter["values"]),
                              "material", did + " " + name + " finite")
        for key in ("colour", "alpha", "specular", "emissive"):
            checker.check(material[key]["provenance"] in ("data", "code", "provisional"),
                          "provenance", did + " " + key)
        for name, stage in draw["textureStages"].items():
            checker.check(stage["name"] is not None, "textures", did + " " + name + " name")
            checker.check(stage["format"] is not None, "textures", did + " " + name + " format")
            checker.check(stage["pixelsDecoded"] is False, "textures", did + " " + name + " pixel claim")
            checker.check(stage["block"] == -1 or stage["block"] >= 0, "textures", did + " " + name + " block")
        checker.check(draw["uv"]["set"] == 0, "uv", did + " uv set")
        checker.check(draw["uv"]["declaration"] is not None, "uv", did + " uv0 declaration")
        # recipe hash
        body = {
            "pass": pass_record["name"],
            "blend": {
                "srcBlend": blend["srcBlend"], "destBlend": blend["destBlend"],
                "blendOp": blend["blendOp"],
                "alphaBlendEnable": int(blend["alphaBlendEnable"]),
                "alphaTestEnable": int(blend["alphaTestEnable"]),
                "alphaRef": blend["alphaRef"],
                "alphaToMaskEnable": int(blend["alphaToMaskEnable"]),
                "cullMode": blend["cullMode"], "zBias": blend["zBias"],
            },
            "alphaTest": [int(blend["alphaTestEnable"]), blend["alphaRef"],
                          int(blend["alphaToMaskEnable"])],
            "cull": draw["cull"]["mode"], "zBias": draw["zBias"],
            "stack": [entry["id"] for entry in material["stack"]],
            "parameters": material["parameters"], "stages": draw["textureStages"],
            "uv": draw["uv"]["declaration"],
        }
        expected = "sha256:" + hashlib.sha256(
            json.dumps(body, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=True, allow_nan=False).encode("utf-8")).hexdigest()[:32]
        checker.check(draw["recipeHash"] == expected, "recipe-hash", did)

    # ------------------------------------------------------------------
    # independent source re-parse
    # ------------------------------------------------------------------
    cursor = 0
    for section in doc["sections"]:
        stage = ROOT / f"_work/map-pipeline/probes/{level}-g{section['geometryBlock']}-n{section['nodeBlock']}"
        if not stage.exists():
            # River section key order may differ from the stage path; locate by id.
            stage = ROOT / f"_work/map-pipeline/probes/{level}-{section['id']}"
        raw = (stage / "node.chunk").read_bytes()
        record = next((r for r in records if r["items"] and r["items"][0] ==
                       {"block": section["nodeBlock"], "lod": 0}), None)
        checker.check(record is not None, "source", section["id"] + " node record")
        stream_prefix(raw, record)
        resources = resource_prefix(raw, {"resourcePayloadOffset": 24, "scenePayloadOffset": 0}, streamed=True)
        lists = independent_lists(raw, resources)
        checker.check(len(lists) > 0, "source", section["id"] + " render list")
        render_list = lists[0]
        vertex_sources = render_list["sources"]["vertexBuffer"]
        index_sources = render_list["sources"]["indexBuffer"]
        emitted = 0
        for primitive_index, primitive in enumerate(render_list["primitives"]):
            declaration = scene["declarations"][primitive["declaration"]]
            position = next((e for e in declaration if e["usage"] == 0 and e["usageIndex"] == 0), None)
            stream = next((s for s in primitive["streams"]
                           if position and s["streamIndex"] == position["stream"] and s["frequency"] == 0), None)
            if position is None or stream is None:
                continue
            if not 0 <= stream["vertexBuffer"] < len(vertex_sources) or \
                    not 0 <= primitive["indexBuffer"] < len(index_sources):
                continue
            if vertex_sources[stream["vertexBuffer"]][0] != section["geometryBlock"] or \
                    index_sources[primitive["indexBuffer"]][0] != section["geometryBlock"]:
                continue
            if cursor >= len(doc["draws"]):
                checker.fail("source", section["id"] + " has more source draws than JSON")
                break
            draw = doc["draws"][cursor]
            checker.check(draw["section"] == section["id"] and draw["drawIndex"] == emitted,
                          "source", section["id"] + " draw order %d" % emitted)
            expected_pass = pass_name(render_list["passInfos"], primitive_index)
            checker.check(draw["pass"]["name"] == expected_pass,
                          "source", draw["id"] + " pass")
            src, dst, op, ab, at, ref, am, cull, zbias = primitive["blend"]
            checker.check((draw["blend"]["srcBlend"], draw["blend"]["destBlend"],
                           draw["blend"]["blendOp"], int(draw["blend"]["alphaBlendEnable"]),
                           int(draw["blend"]["alphaTestEnable"]), draw["blend"]["alphaRef"],
                           int(draw["blend"]["alphaToMaskEnable"]), draw["cull"]["mode"],
                           draw["zBias"]) == (src, dst, op, ab, at, ref, am, cull, zbias),
                          "source", draw["id"] + " blend state")
            checker.check([entry["id"] for entry in draw["material"]["stack"]] ==
                          stack_ids(render_list, primitive), "source", draw["id"] + " stack")
            refs = texture_refs(render_list, primitive)
            for name, stage in draw["textureStages"].items():
                checker.check(name in refs and refs[name] == (stage["block"], stage["index"]),
                              "source", draw["id"] + " stage " + name)
            checker.check(draw["effect"] ==
                          scene["effects"][primitive["effect"]].replace("\\", "/").rsplit("/", 1)[-1].removesuffix(".fx"),
                          "source", draw["id"] + " effect")
            cursor += 1
            emitted += 1
        checker.check(emitted == section["drawCount"], "source",
                      "%s emitted %d vs %d" % (section["id"], emitted, section["drawCount"]))
    checker.check(cursor == len(doc["draws"]), "source", short + " all draws consumed")
    checker.check(doc["hashes"]["contentSha256"] == canonical_hash(doc), "hash", short + " content hash")

    # ------------------------------------------------------------------
    # determinism: two fresh builds
    # ------------------------------------------------------------------
    if rebuild:
        hashes = []
        for run in ("a", "b"):
            out = temp_root / run / short
            subprocess.run([PY, str(BUILDER), "--level", level, "--out", str(out)],
                           check=True, capture_output=True, timeout=1800)
            data = (out / "materials.json").read_bytes()
            hashes.append(hashlib.sha256(data).hexdigest())
            checker.check(json.loads(data)["hashes"]["contentSha256"] == doc["hashes"]["contentSha256"],
                          "determinism", "%s rebuild %s content hash" % (short, run))
        checker.check(hashes[0] == hashes[1], "determinism", short + " builds differ")
        checker.check(hashes[0] == hashlib.sha256((ROOT / f"_work/map-materials/{short}/materials.json").read_bytes()).hexdigest(),
                      "determinism", short + " committed package differs from rebuild")
    else:
        checker.check(True, "determinism", short + " rebuild skipped")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-rebuild", action="store_true")
    args = parser.parse_args()
    checker = Checker()
    temp_root = Path(tempfile.mkdtemp(prefix="map-materials-verify-", dir=ROOT / "_work/map-materials"))
    summary = {}
    for short in ("river", "amboy", "gracia", "longbeach"):
        path = ROOT / f"_work/map-materials/{short}/materials.json"
        if not path.exists():
            checker.fail("package", "missing " + str(path))
            continue
        doc = json.loads(path.read_text(encoding="utf-8"))
        before = checker.checks
        verify_map(short, doc, checker, not args.no_rebuild, temp_root)
        summary[short] = {"checks": checker.checks - before,
                          "failures": sum(checker.category_failures.values())}
    result = {
        "schema": "blur.map-materials.verify/1",
        "status": "PASS" if not checker.failures else "FAIL",
        "checks": checker.checks,
        "failures": len(checker.failures),
        "categories": dict(checker.categories),
        "categoryFailures": dict(checker.category_failures),
        "firstFailure": checker.failures[0] if checker.failures else None,
        "perMap": summary,
    }
    out = ROOT / "_work/map-materials/verify.json"
    out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=1))
    return 0 if not checker.failures else 1


if __name__ == "__main__":
    sys.exit(main())
