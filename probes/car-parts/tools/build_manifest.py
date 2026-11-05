"""Build a deterministic car-part manifest from the real Corvette model.

Inputs (all read-only):
  * `_work/car-level-assets/corvette_c3_race.model.decoded` - the decoded PC
    `.model` payload used by the committed asset probes.
  * `scene_inspect.exe` - the committed native first-RenderList LOD0 reader.
    It supplies exactly the geometry the committed browser preview draws:
    30,591 vertices / 36,193 triangles / 80 draws, object-local.

The manifest adds a source-justified part layer on top of that geometry:

  1. `MdlDat` (the model data block, `C_ModelData::Read`) is parsed with the
     documented `PC` file-block layout and the serialized `C_Model` /
     `C_ModelElement` fields: 48-byte HMat43 (four 3-float rows), 24-byte
     C_AxisBox (two 3-float corners), name ids into `StrTab`, hierarchy
     indices, `m_RenderMeshId`, `m_PhysicsShapeId`.
  2. Those element names, matrices and local bounds are the authority for
     part names and transforms. Nothing is invented.
  3. Each scene draw is linked to an element only when its index-range AABB
     proves it:
       - wheel part: draw AABB equals the element-local bounds (tyres are the
         exact union of their tread + sidewall draws),
       - glass / light / plate / mirror / steering: draw AABB matches the
         element bounds within 5 cm (symmetric difference),
       - body/interior shell: nearest containing element decides the branch.
     A draw that proves nothing is emitted as `partKind:"unclassified"` with
     a reason; it is never given a guessed name.
  4. Four wheel groups are emitted with the element translation and the
     documented local X spin axis. Front-left / front-right discs and
     calipers have byte-identical local bounds in this asset, so their side
     is not provable. They are emitted as ambiguous pairs; the manifest may
     carry a deterministic `previewAssignment` for drawing, clearly separate
     from the proof.

The tool fails loudly on any unsupported field or on a result that does not
account for every draw exactly once. It writes only under `_work/car-parts/`.

Usage:
  python probes/car-parts/tools/build_manifest.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MODEL_DEFAULT = ROOT / "_work/car-level-assets/corvette_c3_race.model.decoded"
SCENE_EXE_DEFAULT = ROOT / "_work/build/asset-reader-native/Release/scene_inspect.exe"
MODEL_EXE_DEFAULT = ROOT / "_work/build/asset-reader-native/Release/model_inspect.exe"
OUT_DEFAULT = ROOT / "_work/car-parts"

MAX_MODEL_BYTES = 64 * 1024 * 1024
MAX_STRINGS = 4096
MAX_STRING_BYTES = 1 << 20

# Wheel part element names, as serialized in the Corvette StrTab.
WHEEL_PART_PREFIXES = ("E_Tyre_", "E_AlloyRim_", "E_BrakeDisc_", "E_BrakeCaliper_")
WHEEL_PART_KIND = (
    ("E_Tyre_", "tyre"),
    ("E_AlloyRim_", "rim"),
    ("E_BrakeDisc_", "brakeDisc"),
    ("E_BrakeCaliper_", "brakeCaliper"),
)

GLASS_NAMES = {"e_window_front", "e_window_back", "e_window_left", "e_window_right"}
LIGHT_SUBSTRINGS = ("Light", "Spotlight", "Headlight")
PLATE_NAMES = {"e_licenseplate_front", "e_licenseplate_back"}
MIRROR_NAMES = {"e_mirror_left", "e_mirror_right"}
STEERING_NAME = "e_SteeringWheel"

CONTAIN_TOL = 0.005
EXACT_D = 0.05
WHEEL_D = 0.02


class Unsupported(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Bounded PC file-block + MdlDat parsing
# ---------------------------------------------------------------------------

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_block(data: bytes, offset: int, limit: int) -> dict:
    """Read one C_FileBlock header at `offset`; return header + payload span."""
    if offset < 0 or offset + 16 > limit:
        raise Unsupported(f"truncated file-block header at {offset}")
    ident = data[offset:offset + 8]
    name = ident.split(b"\0", 1)[0]
    if not name or any(c < 0x20 or c > 0x7E for c in name):
        raise Unsupported(f"invalid file-block id at {offset}")
    if any(ident[len(name):]):
        raise Unsupported(f"non-zero id padding at {offset}")
    size, count = struct.unpack_from("<IH", data, offset + 8)
    kind, compression = data[offset + 14], data[offset + 15]
    if size < 16 or offset + size > limit:
        raise Unsupported(f"file-block {name!r} size {size} exceeds input at {offset}")
    if kind not in (0x41, 0x43):
        raise Unsupported(f"unsupported file-block type {kind:#x} at {offset}")
    if kind == 0x43 and compression != 0:
        raise Unsupported(f"compressed container {name!r} at {offset} is not supported")
    return {
        "id": name.decode("ascii"),
        "offset": offset,
        "bytes": size,
        "count": count,
        "type": kind,
        "compression": compression,
        "payloadOffset": offset + 16,
        "payloadBytes": size - 16,
        "end": offset + size,
    }


def child_blocks(data: bytes, parent: dict) -> list[dict]:
    """Walk `parent.count` consecutive child blocks that must fill it exactly."""
    result = []
    cursor = parent["payloadOffset"]
    for _ in range(parent["count"]):
        block = read_block(data, cursor, parent["end"])
        result.append(block)
        cursor = block["end"]
    if cursor != parent["end"]:
        raise Unsupported(f"container {parent['id']!r} children do not fill their declared size")
    return result


class Span:
    """Strict little-endian reader over one block payload."""

    def __init__(self, data: bytes, offset: int, end: int, what: str):
        self.data = data
        self.offset = offset
        self.cursor = offset
        self.end = end
        self.what = what

    def need(self, count: int) -> None:
        if count < 0 or self.cursor + count > self.end:
            raise Unsupported(f"truncated {self.what} at {self.cursor}")

    def i32(self) -> int:
        self.need(4)
        value = struct.unpack_from("<i", self.data, self.cursor)[0]
        self.cursor += 4
        return value

    def u32(self) -> int:
        self.need(4)
        value = struct.unpack_from("<I", self.data, self.cursor)[0]
        self.cursor += 4
        return value

    def f32x3(self) -> list[float]:
        self.need(12)
        values = list(struct.unpack_from("<fff", self.data, self.cursor))
        self.cursor += 12
        if not all(math.isfinite(value) for value in values):
            raise Unsupported(f"non-finite float in {self.what} at {self.cursor - 12}")
        return values

    def remaining(self) -> int:
        return self.end - self.cursor


def parse_mdldat(data: bytes) -> dict:
    if len(data) > MAX_MODEL_BYTES:
        raise Unsupported(f"model is larger than {MAX_MODEL_BYTES} bytes")
    if data[:4] != b"  CP":
        raise Unsupported("model does not start with the PC fourcc marker")
    model = read_block(data, 4, len(data))
    if model["id"] != "Model" or model["type"] != 0x43:
        raise Unsupported("first top-level block is not a Model container")
    children = child_blocks(data, model)
    mdldat = next((block for block in children if block["id"] == "MdlDat"), None)
    if mdldat is None or mdldat["type"] != 0x41:
        raise Unsupported("Model has no MdlDat data block")
    body = data[mdldat["payloadOffset"]:mdldat["end"]]
    if mdldat["payloadBytes"] < 64:
        raise Unsupported("MdlDat is too small")

    # MdlDat is a sequence of file blocks, not a container: Header, StrTab,
    # Models, Element, Constr. Walk them to their declared sizes.
    blocks = []
    cursor = mdldat["payloadOffset"]
    while cursor < mdldat["end"]:
        block = read_block(data, cursor, mdldat["end"])
        blocks.append(block)
        cursor = block["end"]
    if cursor != mdldat["end"]:
        raise Unsupported("MdlDat child blocks do not end at the MdlDat boundary")
    by_id = {block["id"]: block for block in blocks}
    for required in ("Header", "StrTab", "Models", "Element"):
        if required not in by_id:
            raise Unsupported(f"MdlDat is missing {required}")

    header = by_id["Header"]
    span = Span(data, header["payloadOffset"], header["end"], "MdlDat Header")
    version = span.i32()
    model_count = span.i32()
    element_count = span.i32()
    constraint_count = span.i32()
    if version not in (0, 1):
        raise Unsupported(f"unsupported MdlDat version {version}")
    if not (0 <= model_count <= 4096 and 0 <= element_count <= 65536 and 0 <= constraint_count <= 65536):
        raise Unsupported("MdlDat counts out of range")
    bounds_lo = bounds_hi = None
    if version >= 1:
        bounds_lo = span.f32x3()
        bounds_hi = span.f32x3()
    if span.remaining() != 0:
        raise Unsupported("MdlDat Header has trailing bytes")

    strtab = by_id["StrTab"]
    span = Span(data, strtab["payloadOffset"], strtab["end"], "MdlDat StrTab")
    string_count = span.u32()
    if string_count > MAX_STRINGS:
        raise Unsupported("StrTab string count exceeds limit")
    offsets = [span.u32() for _ in range(string_count)]
    data_bytes = span.u32()
    if data_bytes > MAX_STRING_BYTES:
        raise Unsupported("StrTab data exceeds limit")
    span.need(data_bytes)
    raw = data[span.cursor:span.cursor + data_bytes]
    span.cursor += data_bytes
    if span.remaining() != 0:
        raise Unsupported("StrTab has trailing bytes")
    strings = []
    for index, offset in enumerate(offsets):
        if offset >= len(raw) or (index + 1 < len(offsets) and offsets[index + 1] < offset):
            raise Unsupported("StrTab offset is out of range or unordered")
        end = raw.find(b"\0", offset)
        if end < 0:
            raise Unsupported("StrTab string is not NUL-terminated")
        try:
            strings.append(raw[offset:end].decode("ascii"))
        except UnicodeDecodeError:
            raise Unsupported("StrTab string is not ASCII")

    models_block = by_id["Models"]
    expected = model_count * (48 + 24 + 4 * 4 + 3 * 4)
    if models_block["payloadBytes"] != expected:
        raise Unsupported(
            f"Models payload {models_block['payloadBytes']} != {expected} for {model_count} records")
    span = Span(data, models_block["payloadOffset"], models_block["end"], "Models")
    models = []
    for index in range(model_count):
        matrix = [span.f32x3() for _ in range(4)]
        local_min = span.f32x3() if version >= 1 else None
        local_max = span.f32x3() if version >= 1 else None
        name_id = span.i32()
        element_index = span.i32()
        model_element_count = span.i32()
        first_element = span.i32()
        parent = span.i32()
        first_child = span.i32()
        next_sibling = span.i32()
        if not 0 <= name_id < len(strings):
            raise Unsupported(f"model {index} name id {name_id} is out of range")
        for link, name in ((parent, "parent"), (first_child, "firstChild"), (next_sibling, "nextSibling")):
            if link < -1 or link >= model_count:
                raise Unsupported(f"model {index} {name} {link} is out of range")
        if first_element < -1 or first_element + max(0, model_element_count) > element_count:
            raise Unsupported(f"model {index} element range is out of bounds")
        models.append({
            "index": index,
            "name": strings[name_id],
            "matrix": matrix,
            "min": local_min,
            "max": local_max,
            "elementCount": model_element_count,
            "firstElement": first_element,
            "parent": parent,
            "firstChild": first_child,
            "nextSibling": next_sibling,
        })
    if span.remaining() != 0:
        raise Unsupported("Models block has trailing bytes")

    element_block = by_id["Element"]
    expected = element_count * (4 + 48 + 24 + 4 * 4 + 3 * 4)
    if element_block["payloadBytes"] != expected:
        raise Unsupported(
            f"Element payload {element_block['payloadBytes']} != {expected} for {element_count} records")
    span = Span(data, element_block["payloadOffset"], element_block["end"], "Element")
    elements = []
    for index in range(element_count):
        model_index = span.i32()
        matrix = [span.f32x3() for _ in range(4)]
        local_min = span.f32x3()
        local_max = span.f32x3()
        name_id = span.i32()
        element_index = span.i32()
        parent = span.i32()
        first_child = span.i32()
        next_sibling = span.i32()
        render_mesh_id = span.i32()
        physics_shape_id = span.u32()
        if not 0 <= model_index < model_count:
            raise Unsupported(f"element {index} model index {model_index} is out of range")
        if not 0 <= name_id < len(strings):
            raise Unsupported(f"element {index} name id {name_id} is out of range")
        for link, name in ((parent, "parent"), (first_child, "firstChild"), (next_sibling, "nextSibling")):
            if link < -1 or link >= element_count:
                raise Unsupported(f"element {index} {name} {link} is out of range")
        elements.append({
            "index": index,
            "modelIndex": model_index,
            "name": strings[name_id],
            "matrix": matrix,
            "min": local_min,
            "max": local_max,
            "elementIndex": element_index,
            "parent": parent,
            "firstChild": first_child,
            "nextSibling": next_sibling,
            "renderMeshId": render_mesh_id,
            "physicsShapeId": physics_shape_id,
        })
    if span.remaining() != 0:
        raise Unsupported("Element block has trailing bytes")

    # This asset uses translation-only element matrices. Reject rather than
    # silently transpose a rotation/scale that the manifest cannot prove.
    for model_index, model in enumerate(models):
        if not is_identity_linear(model["matrix"]):
            raise Unsupported(f"model {model_index} has a non-identity linear matrix")
    for element in elements:
        if not is_identity_linear(element["matrix"]):
            raise Unsupported(f"element {element['index']} has a non-identity linear matrix")

    # World (model-space) translation: every matrix in the chain is a
    # translation, so translations add.
    for element in elements:
        total = list(element["matrix"][3])
        parent = element["parent"]
        seen = set()
        while parent >= 0:
            if parent in seen:
                raise Unsupported("element hierarchy contains a cycle")
            seen.add(parent)
            total = [total[i] + elements[parent]["matrix"][3][i] for i in range(3)]
            parent = elements[parent]["parent"]
        element["worldTranslation"] = total

    return {
        "offset": mdldat["offset"],
        "bytes": mdldat["bytes"],
        "sha256": sha256(data[mdldat["offset"]:mdldat["end"]]),
        "version": version,
        "bounds": {"min": bounds_lo, "max": bounds_hi},
        "models": models,
        "elements": elements,
        "strings": strings,
        "modelCount": model_count,
        "elementCount": element_count,
        "constraintCount": constraint_count,
    }


def is_identity_linear(matrix: list[list[float]]) -> bool:
    for row in range(3):
        for column in range(3):
            expected = 1.0 if row == column else 0.0
            if abs(matrix[row][column] - expected) > 1e-6:
                return False
    return True


def column_major_from_rows(matrix: list[list[float]]) -> list[float]:
    """Row-vector HMat43 (AX,AY,AZ,AW) -> column-vector 16-float matrix."""
    out = [0.0] * 16
    for column in range(3):
        for row in range(3):
            out[column * 4 + row] = matrix[row][column]
    out[12:15] = matrix[3][:3]
    out[15] = 1.0
    return out


# ---------------------------------------------------------------------------
# Geometry / draw matching
# ---------------------------------------------------------------------------

def draw_bounds(positions: list[float], indices: list[int], draw: dict) -> dict:
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    used = set()
    for offset in range(draw["firstIndex"], draw["firstIndex"] + draw["indexCount"]):
        vertex = indices[offset]
        used.add(vertex)
        for axis in range(3):
            value = positions[vertex * 3 + axis]
            lo[axis] = min(lo[axis], value)
            hi[axis] = max(hi[axis], value)
    if not used:
        raise Unsupported(f"draw {draw['index']} has an empty index range")
    return {"min": lo, "max": hi, "minIndex": min(used), "maxIndex": max(used), "vertexCount": len(used)}


def aabb_diff(a_lo, a_hi, b_lo, b_hi) -> float:
    return sum(abs(a_lo[i] - b_lo[i]) + abs(a_hi[i] - b_hi[i]) for i in range(3))


def contains(outer_lo, outer_hi, inner_lo, inner_hi, tol: float) -> bool:
    return all(inner_lo[i] >= outer_lo[i] - tol and inner_hi[i] <= outer_hi[i] + tol for i in range(3))


def volume(lo, hi) -> float:
    return math.prod(max(1e-9, hi[i] - lo[i]) for i in range(3))


def finite_bounds(element: dict) -> bool:
    return all(abs(value) < 1e30 for value in element["min"] + element["max"])


def element_world_bounds(element: dict) -> tuple[list[float], list[float]]:
    t = element["worldTranslation"]
    return [element["min"][i] + t[i] for i in range(3)], [element["max"][i] + t[i] for i in range(3)]


def part_kind_of_element(name: str) -> str | None:
    if name in GLASS_NAMES:
        return "glass"
    if any(token in name for token in LIGHT_SUBSTRINGS):
        return "light"
    if name in PLATE_NAMES or name in MIRROR_NAMES:
        return "body"
    if name == STEERING_NAME:
        return "interior"
    return None


def wheel_kind(name: str) -> str | None:
    for prefix, kind in WHEEL_PART_KIND:
        if name.startswith(prefix):
            return kind
    return None


def element_branch(element: dict, elements: list[dict]) -> str:
    """Nearest line: e_interior subtree or e_exterior subtree of model 0."""
    cursor = element
    seen = set()
    while cursor is not None:
        if cursor["index"] in seen:
            raise Unsupported("element hierarchy contains a cycle")
        seen.add(cursor["index"])
        if cursor["name"] == "e_interior":
            return "interior"
        if cursor["name"] == "e_exterior":
            return "exterior"
        parent = cursor["parent"]
        cursor = elements[parent] if parent >= 0 else None
    return "exterior"


# ---------------------------------------------------------------------------
# Manifest assembly
# ---------------------------------------------------------------------------

def classify(scene: dict, mdl: dict) -> dict:
    positions = scene["positions"]
    indices = scene["indices"]
    draws = []
    for index, draw in enumerate(scene["draws"]):
        bounds = draw_bounds(positions, indices, draw)
        entry = dict(draw)
        entry["index"] = index
        entry["bounds"] = {"min": bounds["min"], "max": bounds["max"]}
        entry["minIndex"] = bounds["minIndex"]
        entry["maxIndex"] = bounds["maxIndex"]
        entry["uniqueVertexCount"] = bounds["vertexCount"]
        entry["indexRange"] = {"first": draw["firstIndex"], "count": draw["indexCount"]}
        entry["vertexRange"] = {"min": bounds["minIndex"], "max": bounds["maxIndex"],
                               "unique": bounds["vertexCount"]}
        draws.append(entry)

    elements = [element for element in mdl["elements"] if element["modelIndex"] == 0]
    wheel_elements = [element for element in elements if wheel_kind(element["name"])]
    if len(wheel_elements) != 16:
        raise Unsupported(f"expected 16 wheel part elements, found {len(wheel_elements)}")

    # --- tyres: exact union of one tread (albedo tyretred) and one wall
    # (albedo tyrewall) draw per tyre element ------------------------------
    tyre_elements = {element["name"]: element for element in wheel_elements
                     if element["name"].startswith("E_Tyre_")}
    tyre_draws = {kind: [draw for draw in draws if draw.get("albedoTexture") == value]
                  for kind, value in (("tread", 3), ("wall", 5))}
    if len(tyre_elements) != 4 or len(tyre_draws["tread"]) != 4 or len(tyre_draws["wall"]) != 4:
        raise Unsupported("expected four tyre elements, four tread draws and four wall draws")

    import itertools
    best = None
    names = sorted(tyre_elements)
    for tread_order in itertools.permutations(tyre_draws["tread"]):
        for wall_order in itertools.permutations(tyre_draws["wall"]):
            total = 0.0
            pairs = []
            for name, tread, wall in zip(names, tread_order, wall_order):
                element = tyre_elements[name]
                lo = [min(tread["bounds"]["min"][i], wall["bounds"]["min"][i]) for i in range(3)]
                hi = [max(tread["bounds"]["max"][i], wall["bounds"]["max"][i]) for i in range(3)]
                difference = aabb_diff(lo, hi, element["min"], element["max"])
                total += difference
                pairs.append({"element": name, "tread": tread["index"], "wall": wall["index"],
                              "unionBounds": {"min": lo, "max": hi}, "difference": difference})
            key = (total, [(pair["element"], pair["tread"], pair["wall"]) for pair in pairs])
            if best is None or key < best[0]:
                best = (key, pairs, total)
    if best is None or best[2] > 0.05:
        raise Unsupported(f"tyre tread/wall pairing is not proven (best union difference {best[2] if best else None})")
    tyre_pairs = {pair["element"]: pair for pair in best[1]}

    wheel_assignment: dict[int, dict] = {}
    for name, pair in tyre_pairs.items():
        element = tyre_elements[name]
        for role in ("tread", "wall"):
            draw_index = pair[role]
            wheel_assignment[draw_index] = {
                "element": name,
                "wheelPart": "tyre",
                "role": role,
                "proof": "tyre element bounds equal the union of this tread draw and its sidewall draw",
                "difference": pair["difference"],
            }

    # --- rims / discs / calipers: direct local-bounds match ---------------
    handled = set(wheel_assignment)
    ambiguous = []
    for draw in draws:
        if draw["index"] in handled:
            continue
        candidates = []
        for element in wheel_elements:
            if element["name"] in tyre_elements:
                continue
            difference = aabb_diff(draw["bounds"]["min"], draw["bounds"]["max"],
                                   element["min"], element["max"])
            if difference <= WHEEL_D:
                candidates.append((difference, element))
        if not candidates:
            continue
        candidates.sort(key=lambda item: (item[0], item[1]["name"]))
        best_difference, best_element = candidates[0]
        # Left/right parts can have byte-identical local bounds (front brake
        # discs and calipers in this asset). If the best element shares its
        # bounds with another candidate, the draw cannot be assigned a side.
        tied = [element for _, element in candidates
                if aabb_diff(element["min"], element["max"],
                             best_element["min"], best_element["max"]) <= 0.01]
        if len(tied) == 1:
            element = tied[0]
            wheel_assignment[draw["index"]] = {
                "element": element["name"],
                "wheelPart": wheel_kind(element["name"]),
                "role": "primary",
                "proof": "draw AABB equals the element-local bounds",
                "difference": best_difference,
            }
        else:
            axle = "front" if all("Front" in element["name"] for element in tied) else (
                "back" if all("Back" in element["name"] for element in tied) else "unknown")
            if axle == "unknown":
                raise Unsupported(f"draw {draw['index']} matches several unrelated wheel parts")
            ambiguous.append({
                "draw": draw["index"],
                "wheelPart": wheel_kind(tied[0]["name"]),
                "axle": axle,
                "candidates": sorted(element["name"] for element in tied),
                "difference": best_difference,
                "reason": "element-local bounds are identical for this left/right pair; side is not provable",
            })

    # --- non-wheel parts --------------------------------------------------
    assigned = dict(wheel_assignment)
    draw_matches: dict[int, dict] = {}
    for item in ambiguous:
        assigned[item["draw"]] = {
            "element": None,
            "wheelPart": item["wheelPart"],
            "role": "ambiguous-pair",
            "proof": item["reason"],
        }
    parts: dict[str, dict] = {}

    def add_part(part_id: str, kind: str, name: str | None, element: dict | None,
                 draw_index: int, proof: dict) -> None:
        part = parts.setdefault(part_id, {
            "id": part_id,
            "partKind": kind,
            "name": name,
            "elementIndex": element["index"] if element else None,
            "modelIndex": element["modelIndex"] if element else None,
            "draws": [],
            "proof": proof,
        })
        part["draws"].append(draw_index)
        assigned[draw_index] = {"element": name, "wheelPart": None, "role": "primary", "proof": part["proof"]["tier"]}

    for draw in draws:
        if draw["index"] in assigned:
            continue
        contained = []
        for element in elements:
            if not finite_bounds(element):
                continue
            lo, hi = element_world_bounds(element)
            if contains(lo, hi, draw["bounds"]["min"], draw["bounds"]["max"], CONTAIN_TOL):
                contained.append((aabb_diff(draw["bounds"]["min"], draw["bounds"]["max"], lo, hi),
                                  volume(lo, hi), element))
        if not contained:
            proof = {
                "tier": "none",
                "reason": "draw AABB is not contained in any DefaultModel element bounds",
            }
            add_part(f"unclassified.{draw['index']}", "unclassified", None, None, draw["index"], proof)
            draw_matches[draw["index"]] = proof
            continue
        contained.sort(key=lambda item: (item[0], item[1], item[2]["name"]))
        difference, _, element = contained[0]
        kind = part_kind_of_element(element["name"])
        if kind and difference <= EXACT_D:
            part_id = f"{kind}.{element['name']}"
            proof = {
                "tier": "element-bounds",
                "reason": f"draw AABB matches {element['name']} bounds within {difference:.6f} (symmetric difference)",
                "element": element["name"],
                "difference": difference,
            }
            add_part(part_id, kind, element["name"], element, draw["index"], proof)
            draw_matches[draw["index"]] = proof
            continue
        branch = element_branch(element, elements)
        if branch == "interior":
            proof = {
                "tier": "branch-containment",
                "reason": "nearest containing element is in the e_interior subtree; no exact part match",
                "nearestElement": element["name"],
                "difference": difference,
            }
            add_part("interior.shell", "interior", None, element, draw["index"], proof)
        else:
            proof = {
                "tier": "branch-containment",
                "reason": "nearest containing element is in the e_exterior subtree; no exact part match",
                "nearestElement": element["name"],
                "difference": difference,
            }
            add_part("body.shell", "body", None, element, draw["index"], proof)
        draw_matches[draw["index"]] = proof

    # --- wheel groups -----------------------------------------------------
    wheel_groups = []
    wheel_parents = [element for element in elements if element["name"].startswith("e_wheel_")]
    if len(wheel_parents) != 4:
        raise Unsupported(f"expected four e_wheel_* elements, found {len(wheel_parents)}")
    for element in wheel_parents:
        base = element["name"]
        corner = base[len("e_wheel_"):]
        members = []
        for child in wheel_elements:
            if child["parent"] == element["index"] and child["index"] != element["index"]:
                members.append(child["name"])
        # Tyre children have the wheel element as parent; in the Corvette the
        # tyre/rim/disc/caliper elements are direct children of e_wheel_*.
        draw_set = sorted(index for index, value in wheel_assignment.items()
                          if value["element"] in members)
        wheel_groups.append({
            "id": f"wheel.{corner}",
            "partKind": "wheel",
            "name": base,
            "elementIndex": element["index"],
            "corner": corner,
            "localBounds": {"min": element["min"], "max": element["max"]},
            "localTransform": {
                "matrixRows": element["matrix"],
                "translation": element["matrix"][3],
                "linearIdentity": True,
            },
            "worldTransform": {
                "coordinateSpace": "model",
                "translation": element["worldTranslation"],
                "matrixColumnMajor": column_major_from_rows(element["matrix"]),
            },
            "spin": {
                "axis": [1.0, 0.0, 0.0],
                "axisSpace": "element-local",
                "spinMembers": ["tyre", "rim", "brakeDisc"],
                "staticMembers": ["brakeCaliper"],
                "evidence":
                    "wheel/rim/disc local bounds are thin on X and round on Y/Z, so X is the axle. "
                    "Upstream VehicleActor.cpp:5158-5167 computes the spin rate about wheelMatrix.AX(); "
                    "lines 5170-5196 store that wheel matrix for Tyre/AlloyRim/BrakeDisc, and line 5198 "
                    "states 'Brake calipers mustn't rotate'.",
                "source": "upstream/BlurRebuilt 5270304b code/amax/game/Game/GameActors/Vehicles/VehicleActor.cpp",
            },
            "memberParts": [{
                "name": child["name"],
                "wheelPart": wheel_kind(child["name"]),
                "spins": wheel_kind(child["name"]) != "brakeCaliper",
                "elementIndex": child["index"],
                "localBounds": {"min": child["min"], "max": child["max"]},
            } for child in wheel_elements if child["parent"] == element["index"]],
            "draws": draw_set,
        })

    # The four tyre/rim assignments and the back disc/caliper assignments are
    # proven per corner. Front discs and calipers are identical left/right;
    # their draws live in `ambiguous` and are paired for rendering only.
    for group in wheel_groups:
        group["provenDraws"] = list(group["draws"])
        group["previewDraws"] = list(group["draws"])
        group["ambiguousDraws"] = []

    front_groups = [group for group in wheel_groups if group["corner"].startswith("front")]
    back_groups = [group for group in wheel_groups if group["corner"].startswith("back")]
    if len(front_groups) != 2 or len(back_groups) != 2:
        raise Unsupported("expected two front and two back wheel groups")
    by_axle = {"front": sorted(front_groups, key=lambda group: group["corner"]),
               "back": sorted(back_groups, key=lambda group: group["corner"])}
    ambiguous_by_axle_part: dict[tuple[str, str], list[dict]] = {}
    for item in ambiguous:
        ambiguous_by_axle_part.setdefault((item["axle"], item["wheelPart"]), []).append(item)
    for (axle, wheel_part), items in sorted(ambiguous_by_axle_part.items()):
        groups = by_axle[axle]
        # Deterministic presentation pairing: within one wheel-part type on
        # one axle, sort by draw index and give the first draw to the
        # lexicographically first corner. This is explicitly not a proof and
        # is labelled `previewAssignment`.
        items.sort(key=lambda item: item["draw"])
        if len(items) != 2:
            raise Unsupported(
                f"expected one ambiguous {wheel_part} pair on the {axle} axle, got {len(items)}")
        for group, item in zip(groups, items):
            group["previewDraws"].append(item["draw"])
            group["previewDraws"].sort()
            group["ambiguousDraws"].append({
                "draw": item["draw"],
                "wheelPart": item["wheelPart"],
                "candidates": item["candidates"],
                "reason": item["reason"],
                "assignment": "preview-only deterministic pairing; not a corner proof",
            })
            wheel_assignment[item["draw"]] = {
                "element": None,
                "wheelPart": item["wheelPart"],
                "role": "ambiguous-pair",
                "proof": item["reason"],
                "previewCorner": group["corner"],
            }

    # --- final part assembly ---------------------------------------------
    def vertex_span(draw_indices: list[int]) -> dict:
        vertices = set()
        for draw_index in draw_indices:
            draw = draws[draw_index]
            for offset in range(draw["firstIndex"], draw["firstIndex"] + draw["indexCount"]):
                vertices.add(indices[offset])
        return {"min": min(vertices), "max": max(vertices), "unique": len(vertices)}

    final_parts = []
    for part_id in sorted(parts):
        part = parts[part_id]
        part["draws"].sort()
        if part["elementIndex"] is not None:
            element = elements[part["elementIndex"]]
            part["localBounds"] = {"min": element["min"], "max": element["max"]}
            part["localTransform"] = {
                "matrixRows": element["matrix"],
                "translation": element["matrix"][3],
                "linearIdentity": True,
            }
            part["worldTransform"] = {
                "coordinateSpace": "model",
                "translation": element["worldTranslation"],
                "matrixColumnMajor": column_major_from_rows(element["matrix"]),
            }
        else:
            bounds_lo = [math.inf] * 3
            bounds_hi = [-math.inf] * 3
            for draw_index in part["draws"]:
                draw = draws[draw_index]
                for axis in range(3):
                    bounds_lo[axis] = min(bounds_lo[axis], draw["bounds"]["min"][axis])
                    bounds_hi[axis] = max(bounds_hi[axis], draw["bounds"]["max"][axis])
            part["localBounds"] = {"min": bounds_lo, "max": bounds_hi}
            part["localTransform"] = {"matrixRows": identity_rows(), "translation": [0.0, 0.0, 0.0],
                                      "linearIdentity": True}
            part["worldTransform"] = {"coordinateSpace": "model", "translation": [0.0, 0.0, 0.0],
                                      "matrixColumnMajor": column_major_from_rows(identity_rows())}
        part["drawIndexRanges"] = [
            {"firstIndex": draws[index]["firstIndex"], "indexCount": draws[index]["indexCount"]}
            for index in part["draws"]
        ]
        part["vertexRange"] = vertex_span(part["draws"])
        part["provenDraws"] = list(part["draws"])
        part["triangleCount"] = sum(draws[index]["indexCount"] for index in part["draws"]) // 3
        final_parts.append(part)

    # Wheel groups are themselves parts in the renderer's flat part list.
    for group in wheel_groups:
        final_parts.append({
            "id": group["id"],
            "partKind": "wheel",
            "name": group["name"],
            "elementIndex": group["elementIndex"],
            "modelIndex": 0,
            "draws": group["previewDraws"],
            "renderDraws": group["previewDraws"],
            "provenDraws": group["provenDraws"],
            "ambiguousDraws": group["ambiguousDraws"],
            "localBounds": group["localBounds"],
            "localTransform": group["localTransform"],
            "worldTransform": group["worldTransform"],
            "spin": group["spin"],
            "memberParts": group["memberParts"],
            "drawIndexRanges": [
                {"firstIndex": draws[index]["firstIndex"], "indexCount": draws[index]["indexCount"]}
                for index in group["previewDraws"]
            ],
            "vertexRange": vertex_span(group["previewDraws"]),
            "triangleCount": sum(draws[index]["indexCount"] for index in group["previewDraws"]) // 3,
            "proof": {
                "tier": "element-name+matrix+bounds",
                "reason": "e_wheel_* element name, MdlDat matrix translation and draw-local bounds",
            },
        })
    final_parts.sort(key=lambda part: part["id"])

    # Draw records carry their final part identity.
    part_of_draw: dict[int, str] = {}
    for part in final_parts:
        for draw_index in part["draws"]:
            if draw_index in part_of_draw:
                raise Unsupported(f"draw {draw_index} belongs to both {part_of_draw[draw_index]} and {part['id']}")
            part_of_draw[draw_index] = part["id"]

    for draw in draws:
        part_id = part_of_draw.get(draw["index"])
        draw["partId"] = part_id
        draw["renderPartId"] = part_id
        draw["partKind"] = None
        draw["partName"] = None
        if part_id:
            part = next(part for part in final_parts if part["id"] == part_id)
            draw["partKind"] = part["partKind"]
            draw["partName"] = part["name"]
        draw["evidence"] = wheel_assignment.get(draw["index"])
        ambiguous_item = next((item for item in ambiguous if item["draw"] == draw["index"]), None)
        if ambiguous_item:
            draw["match"] = {
                "tier": "none",
                "reason": ambiguous_item["reason"],
                "candidates": ambiguous_item["candidates"],
                "wheelPart": ambiguous_item["wheelPart"],
                "axle": ambiguous_item["axle"],
            }
        elif draw["evidence"]:
            evidence = draw["evidence"]
            draw["match"] = {
                "tier": "element-bounds",
                "element": evidence.get("element"),
                "wheelPart": evidence.get("wheelPart"),
                "role": evidence.get("role"),
                "difference": evidence.get("difference"),
                "reason": evidence.get("proof"),
            }
        else:
            draw["match"] = draw_matches.get(draw["index"])
        ambiguous_reason = ambiguous_item["reason"] if ambiguous_item else None
        if ambiguous_reason:
            # The draw renders with a wheel group, but its own identity is not
            # proven: the left/right element bounds are identical. Keep the
            # presentation id separate from the proof.
            draw["partId"] = None
            draw["partKind"] = "unclassified"
            draw["partName"] = None
            draw["previewPartId"] = part_id
            draw["unclassifiedReason"] = ambiguous_reason
        if part_id and part_id.startswith("unclassified."):
            draw["unclassifiedReason"] = next(part["proof"]["reason"] for part in final_parts
                                              if part["id"] == part_id)

    unaccounted = [draw["index"] for draw in draws if draw["index"] not in part_of_draw]
    if unaccounted:
        raise Unsupported(f"draws without a part: {unaccounted}")

    return {
        "parts": final_parts,
        "draws": draws,
        "wheelGroups": wheel_groups,
        "ambiguousWheelDraws": ambiguous,
        "wheelAssignment": wheel_assignment,
    }

def identity_rows() -> list[list[float]]:
    return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 0.0]]


def build(args: argparse.Namespace) -> dict:
    model_path = args.model.resolve()
    if not model_path.is_file():
        raise SystemExit(f"missing decoded model: {model_path}")
    model_bytes = model_path.read_bytes()
    if len(model_bytes) > MAX_MODEL_BYTES:
        raise SystemExit(f"model exceeds {MAX_MODEL_BYTES} bytes")
    model_sha = sha256(model_bytes)

    if not args.model_exe.is_file():
        raise SystemExit(f"missing model reader: {args.model_exe}")
    model_report_text = subprocess.run(
        [str(args.model_exe), str(model_path)], check=True, capture_output=True, text=True,
        encoding="utf-8").stdout
    model_report = json.loads(model_report_text)
    if model_report.get("status") != "ok":
        raise SystemExit(f"model reader failed: {model_report.get('error') or model_report.get('message')}")
    model_chunk = model_report["chunks"][0]
    mdldat_chunk = next((child for child in model_chunk.get("children", [])
                         if child["id"] == "MdlDat"), None)
    if mdldat_chunk is None:
        raise SystemExit("model reader did not report an MdlDat chunk")

    if args.scene_json:
        scene_text = Path(args.scene_json).read_text(encoding="utf-8")
    else:
        if not args.scene_exe.is_file():
            raise SystemExit(f"missing scene reader: {args.scene_exe}")
        completed = subprocess.run([str(args.scene_exe), str(model_path)],
                                   check=True, capture_output=True, text=True, encoding="utf-8")
        scene_text = completed.stdout
    scene = json.loads(scene_text)
    if scene.get("status") != "ok":
        raise SystemExit(f"scene reader failed: {scene.get('error') or scene.get('message')}")
    if len(scene.get("draws", [])) != 80:
        raise SystemExit(f"expected 80 draws, got {len(scene.get('draws', []))}")
    if scene["metadata"]["vertexCount"] != 30591 or scene["metadata"]["triangleCount"] != 36193:
        raise SystemExit("scene geometry counts differ from the documented Corvette result")

    mdl = parse_mdldat(model_bytes)
    if mdldat_chunk["offset"] != mdl["offset"] or mdldat_chunk["bytes"] != mdl["bytes"]:
        raise SystemExit(
            f"model_inspect MdlDat {mdldat_chunk['offset']}/{mdldat_chunk['bytes']} differs from "
            f"source parser {mdl['offset']}/{mdl['bytes']}")
    classified = classify(scene, mdl)

    positions = scene["positions"]
    indices = scene["indices"]
    position_bytes = struct.pack("<" + "f" * len(positions), *positions)
    index_bytes = struct.pack("<" + "I" * len(indices), *indices)
    mesh = {
        "kind": "blur.car-part-mesh",
        "version": 1,
        "vertexCount": len(positions) // 3,
        "indexCount": len(indices),
        "positions": positions,
        "indices": indices,
        "positionsFloat32LESha256": sha256(position_bytes),
        "indicesUint32LESha256": sha256(index_bytes),
        "bounds": scene["bounds"],
        "coordinateSpace": "object-local",
        "source": {
            "modelSha256": model_sha,
            "reader": str(args.scene_exe),
            "readerOutputSha256": sha256(scene_text.encode("utf-8")),
        },
    }

    diagnostics = {
        "drawCount": len(classified["draws"]),
        "partCount": len(classified["parts"]),
        "namedPartCount": sum(1 for part in classified["parts"] if part["name"]),
        "unclassifiedPartCount": sum(1 for part in classified["parts"] if part["partKind"] == "unclassified"),
        "wheelDrawCount": sum(len(group["previewDraws"]) for group in classified["wheelGroups"]),
        "provenWheelDrawCount": sum(len(group["provenDraws"]) for group in classified["wheelGroups"]),
        "ambiguousWheelDrawCount": len(classified["ambiguousWheelDraws"]),
        "provenDrawCount": sum(1 for draw in classified["draws"] if draw["partId"] is not None),
        "glassDrawCount": sum(len(part["draws"]) for part in classified["parts"] if part["partKind"] == "glass"),
        "lightDrawCount": sum(len(part["draws"]) for part in classified["parts"] if part["partKind"] == "light"),
        "bodyDrawCount": sum(len(part["draws"]) for part in classified["parts"] if part["partKind"] == "body"),
        "interiorDrawCount": sum(len(part["draws"]) for part in classified["parts"] if part["partKind"] == "interior"),
        "unclassifiedDrawCount": sum(1 for draw in classified["draws"] if draw["partKind"] == "unclassified"),
    }
    if diagnostics["wheelDrawCount"] != 20:
        raise Unsupported(f"expected 20 wheel draws, got {diagnostics['wheelDrawCount']}")
    if diagnostics["provenDrawCount"] + diagnostics["unclassifiedDrawCount"] != diagnostics["drawCount"]:
        raise Unsupported("draw proof accounting does not add up")

    manifest = {
        "kind": "blur.car-part-manifest",
        "version": 1,
        "generator": "probes/car-parts/tools/build_manifest.py",
        "source": {
            "model": "_work/car-level-assets/corvette_c3_race.model.decoded",
            "modelBytes": len(model_bytes),
            "modelSha256": model_sha,
            "sceneReader": "_work/build/asset-reader-native/Release/scene_inspect.exe",
            "sceneReaderScope": scene["metadata"].get("scope"),
            "sceneReaderOutputSha256": mesh["source"]["readerOutputSha256"],
            "sceneReaderParsedUntilOffset": scene["metadata"].get("parsedUntilOffset"),
            "sceneNodeIndex": scene["metadata"].get("nodeIndex"),
            "sceneResourceBlock": scene["metadata"].get("resourceBlock"),
            "modelReader": "_work/build/asset-reader-native/Release/model_inspect.exe",
            "modelReaderOutputSha256": sha256(model_report_text.encode("utf-8")),
            "modelChunks": model_report["chunks"],
            "coordinateSpace": "object-local",
            "nodeTransformsApplied": False,
            "partTransformsFromMdlDat": True,
            "transformsBakedIntoMesh": False,
            "note":
                "Scene geometry is the committed first-RenderList LOD0 output, unchanged. Part names, "
                "element matrices and local bounds come from the same file's MdlDat block. The consumer "
                "applies each part matrix at draw time; the mesh itself is not transformed.",
        },
        "matching": {
            "containToleranceMeters": CONTAIN_TOL,
            "exactDifferenceMeters": EXACT_D,
            "wheelDifferenceMeters": WHEEL_D,
            "description":
                "A draw is linked to an element only when its index-range AABB is contained in the "
                "element bounds and the symmetric AABB difference is within the stated threshold. "
                "Tyres are proven by the exact union of their tread and sidewall draws.",
        },
        "mdlDat": {
            "offset": mdl["offset"],
            "bytes": mdl["bytes"],
            "sha256": mdl["sha256"],
            "version": mdl["version"],
            "modelCount": mdl["modelCount"],
            "elementCount": mdl["elementCount"],
            "constraintCount": mdl["constraintCount"],
            "linearIdentityTolerance": 1e-6,
            "bounds": mdl["bounds"],
            "models": [{
                "index": model["index"],
                "name": model["name"],
                "matrixRows": model["matrix"],
                "localBounds": ({"min": model["min"], "max": model["max"]}
                                if model["min"] is not None else None),
                "elementCount": model["elementCount"],
                "parent": model["parent"],
                "firstChild": model["firstChild"],
                "nextSibling": model["nextSibling"],
            } for model in mdl["models"]],
            "elements": [{
                "index": element["index"],
                "modelIndex": element["modelIndex"],
                "name": element["name"],
                "elementIndex": element["elementIndex"],
                "parent": element["parent"],
                "firstChild": element["firstChild"],
                "nextSibling": element["nextSibling"],
                "renderMeshId": element["renderMeshId"],
                "physicsShapeId": element["physicsShapeId"],
                "matrixRows": element["matrix"],
                "localBounds": {"min": element["min"], "max": element["max"]},
                "worldTranslation": element["worldTranslation"],
                "emptyBounds": not finite_bounds(element),
            } for element in mdl["elements"]],
        },
        "mesh": {
            "path": "_work/car-parts/mesh.json",
            "vertexCount": mesh["vertexCount"],
            "indexCount": mesh["indexCount"],
            "positionsFloat32LESha256": mesh["positionsFloat32LESha256"],
            "indicesUint32LESha256": mesh["indicesUint32LESha256"],
            "bounds": mesh["bounds"],
            "coordinateSpace": mesh["coordinateSpace"],
        },
        "parts": classified["parts"],
        "draws": classified["draws"],
        "wheelGroups": [{
            "id": group["id"],
            "name": group["name"],
            "corner": group["corner"],
            "elementIndex": group["elementIndex"],
            "localBounds": group["localBounds"],
            "localTransform": group["localTransform"],
            "worldTransform": group["worldTransform"],
            "spin": group["spin"],
            "provenDraws": group["provenDraws"],
            "previewDraws": group["previewDraws"],
            "ambiguousDraws": group["ambiguousDraws"],
        } for group in classified["wheelGroups"]],
        "unclassifiedDraws": [{
            "draw": item["draw"],
            "partKind": "unclassified",
            "wheelPart": item["wheelPart"],
            "axle": item["axle"],
            "candidates": item["candidates"],
            "reason": item["reason"],
            "previewPartId": next((group["id"] for group in classified["wheelGroups"]
                                   if item["draw"] in group["previewDraws"]), None),
            "previewAssignment": "deterministic pairing for rendering only; not a corner proof",
        } for item in classified["ambiguousWheelDraws"]],
        "diagnostics": diagnostics,
        "limits": [
            "Geometry is the first RenderList's LOD0 only; later render lists, higher LODs, "
            "damage, paint and runtime light states are not imported.",
            "Element matrices in this asset are translation-only; a non-identity linear part is "
            "rejected instead of being transposed or guessed.",
            "Draw-to-part identity is proven by index-range AABB matching; material/effect names are "
            "recorded as corroboration, not used as a name source.",
            "Front left/right brake discs and calipers have identical element-local bounds; their "
            "side is not provable and the preview pairing is explicitly presentation-only.",
            "No game integration, rendering fidelity, collision, physics or shader semantics are claimed.",
        ],
    }

    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "scene-report.json").write_text(scene_text, encoding="utf-8", newline="\n")
    (out_dir / "mesh.json").write_text(
        json.dumps(mesh, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    manifest_text = json.dumps(manifest, indent=1, sort_keys=True) + "\n"
    (out_dir / "manifest.json").write_text(manifest_text, encoding="utf-8", newline="\n")

    return {
        "manifest": str((out_dir / "manifest.json")),
        "manifestSha256": sha256(manifest_text.encode("utf-8")),
        "manifestBytes": len(manifest_text.encode("utf-8")),
        "mesh": str((out_dir / "mesh.json")),
        "meshSha256": sha256((out_dir / "mesh.json").read_bytes()),
        "sceneReport": str((out_dir / "scene-report.json")),
        "sceneReportSha256": sha256(scene_text.encode("utf-8")),
        "modelSha256": model_sha,
        "diagnostics": diagnostics,
        "wheelGroups": [{
            "id": group["id"],
            "name": group["name"],
            "provenDraws": group["provenDraws"],
            "previewDraws": group["previewDraws"],
            "ambiguousDraws": group["ambiguousDraws"],
            "translation": group["worldTransform"]["translation"],
        } for group in classified["wheelGroups"]],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=MODEL_DEFAULT)
    parser.add_argument("--scene-exe", type=Path, default=SCENE_EXE_DEFAULT)
    parser.add_argument("--model-exe", type=Path, default=MODEL_EXE_DEFAULT)
    parser.add_argument("--scene-json", type=Path, default=None,
                        help="use an existing scene_inspect JSON instead of running the exe")
    parser.add_argument("--out-dir", type=Path, default=OUT_DEFAULT)
    args = parser.parse_args()
    try:
        summary = build(args)
    except Unsupported as error:
        print(f"build_manifest: unsupported: {error}", file=sys.stderr)
        return 2
    print(json.dumps(summary, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
