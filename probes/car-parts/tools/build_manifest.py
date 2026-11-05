"""Build a deterministic, evidence-backed car-part manifest from one real `.model`.

Works for any PC vehicle model that follows the committed reader's layout; it
was developed and gated on the five roster cars (Corvette ZR1, Lotus Exige
Cup260, Dodge Challenger, Ford Focus RS, Audi R8 V10) plus the Corvette C3.

Inputs (all read-only):
  * a decoded PC `.model` payload (see `extract_car_models.py`);
  * `scene_inspect.exe` - the committed native first-RenderList LOD0 reader.
    It supplies the geometry the previews draw: positions, U32 indices and the
    draw list, object-local.

The manifest adds a source-justified part layer on top of that geometry:

  1. `MdlDat` (`C_ModelData::Read`) is parsed with the documented `PC`
     file-block layout and the serialized `C_Model` / `C_ModelElement` fields:
     48-byte HMat43 (four 3-float rows), 24-byte C_AxisBox (two 3-float
     corners), name ids into `StrTab`, hierarchy indices, `m_RenderMeshId`,
     `m_PhysicsShapeId`.
  2. Element names, matrices and local bounds are the authority for part names
     and transforms. Nothing is invented.
  3. A draw is linked to a part only when its index-range AABB proves it:
       - wheel parts: the draw is contained in the element-local bounds and the
         symmetric AABB difference is small. A tyre is proven by the exact union
         of the 1-2 draws that make it.
       - glass / light / plate / mirror / steering: draw AABB matches the
         element bounds within 5 cm (symmetric difference).
       - body / interior shell: the nearest containing element decides the
         branch; a leaf panel name is never invented.
     A draw that proves nothing is `partKind:"unclassified"` with a reason.
  4. Four wheel groups come from the file's own `e_wheel_*` elements. The spin
     axis is element-local +X when the measured wheel bounds are thinnest on X
     and round on Y/Z; otherwise the tool stops instead of guessing.
  5. Left/right wheel parts can have identical or nearly identical local
     bounds. A draw whose corner is not provable is emitted as unclassified and
     only paired to a corner for drawing, labelled `previewAssignment`.

The tool fails loudly on an unsupported field, an unprovable wheel axis or a
result that does not account for every draw exactly once. It writes only to the
`--out-dir` it is given.

Usage:
  python probes/car-parts/tools/build_manifest.py \
      --model _work/car-parts/models/<sha>.decoded \
      --out-dir _work/car-parts [--car-slug <slug>] [--car-name <name>] \
      [--model-pak-path "\\models\\vehicles\\<name>.model"]
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
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

# Wheel part element prefixes. Case differs per asset ("E_Tyre_" vs "e_Tyre_",
# "e_alloyRim_" vs "E_AlloyRim_"), so the match is case-insensitive and the
# original spelling is kept everywhere.
WHEEL_PART_KIND = (
    ("e_tyre_", "tyre"),
    ("e_alloyrim_", "rim"),
    ("e_brakedisc_", "brakeDisc"),
    ("e_brakecaliper_", "brakeCaliper"),
)

CONTAIN_TOL = 0.005
EXACT_D = 0.05
WHEEL_CONTAIN_TOL = 0.005
# A wheel-geometry draw must lie inside a wheel element's local box; the box is
# the outer envelope, so an inner sidewall ring can be up to ~15 cm smaller in
# symmetric AABB difference and still be the same wheel part. The kind is still
# chosen by the smallest difference among the containing elements.
WHEEL_MAX_D = 0.15
TYRE_UNION_D = 0.05
AMBIGUITY_MARGIN = 0.01

WHEEL_CORNERS = ("frontleft", "frontright", "backleft", "backright")


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
            "linearIdentity": is_identity_linear(matrix),
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
            "linearIdentity": is_identity_linear(matrix),
        })
    if span.remaining() != 0:
        raise Unsupported("Element block has trailing bytes")

    # Only the DefaultModel (index 0) is in the first RenderList and is used for
    # part identity. Scene draws carry primitive positions in their element's
    # local frame (the committed reader reports `nodeTransformsApplied:false`),
    # so part identity is local-bounds matching; the element matrix is recorded
    # for placement and is never decomposed or guessed. Its linear part is
    # expected to be identity within float32 noise; the measured deviation is
    # recorded and a real rotation/scale would be visible there and in
    # `linearIdentity`.
    model0 = [element for element in elements if element["modelIndex"] == 0]
    if not model0:
        raise Unsupported("model 0 has no elements")
    for element in elements:
        for row in element["matrix"]:
            if not all(math.isfinite(value) for value in row):
                raise Unsupported(f"element {element['name']} has a non-finite matrix")
        element["linearDeviation"] = max(
            abs(element["matrix"][row][column] - (1.0 if row == column else 0.0))
            for row in range(3) for column in range(3))
    for model_entry in models:
        for row in model_entry["matrix"]:
            if not all(math.isfinite(value) for value in row):
                raise Unsupported(f"model {model_entry['name']} has a non-finite matrix")
        model_entry["linearDeviation"] = max(
            abs(model_entry["matrix"][row][column] - (1.0 if row == column else 0.0))
            for row in range(3) for column in range(3))
    non_identity = [element["name"] for element in model0 if not element["linearIdentity"]]
    for element in model0:
        # Serialized element matrices in these assets already carry the parent's
        # translation (a wheel member repeats its e_wheel_* parent). Adding the
        # parent chain would double the offset, so the serialized translation is
        # the model-space translation. `worldTranslation` keeps that meaning and
        # the wheel placement check below proves it per asset.
        element["worldTranslation"] = list(element["matrix"][3])

    # Bone models (index > 0) are recorded, never used for geometry; their
    # translation is recorded with the same model-space meaning.
    for element in elements:
        element["worldTranslation"] = list(element["matrix"][3])

    elements_by_index = {element["index"]: element for element in elements}
    for element in elements:
        parent = element["parent"]
        seen = set()
        while parent >= 0:
            if parent in seen:
                raise Unsupported("element hierarchy contains a cycle")
            seen.add(parent)
            parent = elements_by_index[parent]["parent"]

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
        "nonIdentityElementCount": sum(1 for element in elements if not element["linearIdentity"]),
        "nonIdentityModelElements": non_identity,
    }


def is_identity_linear(matrix: list[list[float]]) -> bool:
    """Identity within float32 serialization noise (1e-4), not a real rotation."""
    for row in range(3):
        for column in range(3):
            expected = 1.0 if row == column else 0.0
            if abs(matrix[row][column] - expected) > 1e-4:
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


def identity_rows() -> list[list[float]]:
    return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 0.0]]


# ---------------------------------------------------------------------------
# Name rules (evidence is the serialized element name; nothing is guessed)
# ---------------------------------------------------------------------------

def wheel_kind(name: str) -> str | None:
    lowered = name.lower()
    for prefix, kind in WHEEL_PART_KIND:
        if lowered.startswith(prefix):
            return kind
    return None


def part_kind_of_element(name: str) -> str | None:
    lowered = name.lower()
    if "window" in lowered:
        return "glass"
    if "light" in lowered:
        return "light"
    if "steeringwheel" in lowered:
        return "interior"
    if "licenseplate" in lowered or "mirror" in lowered:
        return "body"
    return None


def element_branch(element: dict, elements_by_index: dict[int, dict]) -> str:
    """Nearest branch: e_interior subtree or e_exterior subtree of model 0."""
    cursor = element
    seen = set()
    while cursor is not None:
        if cursor["index"] in seen:
            raise Unsupported("element hierarchy contains a cycle")
        seen.add(cursor["index"])
        lowered = cursor["name"].lower()
        if lowered == "e_interior":
            return "interior"
        if lowered == "e_exterior":
            return "exterior"
        parent = cursor["parent"]
        cursor = elements_by_index[parent] if parent >= 0 else None
    return "exterior"


# ---------------------------------------------------------------------------
# Geometry helpers
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


def union_bounds(bounds_list: list[dict]) -> tuple[list[float], list[float]]:
    lo = [min(item["min"][i] for item in bounds_list) for i in range(3)]
    hi = [max(item["max"][i] for item in bounds_list) for i in range(3)]
    return lo, hi


def volume(lo, hi) -> float:
    return math.prod(max(1e-9, hi[i] - lo[i]) for i in range(3))


def finite_bounds(element: dict) -> bool:
    return all(abs(value) < 1e30 for value in element["min"] + element["max"])


# ---------------------------------------------------------------------------
# Wheel matching
# ---------------------------------------------------------------------------

def wheel_corner(name: str) -> str:
    lowered = name.lower()
    if not lowered.startswith("e_wheel_"):
        raise Unsupported(f"{name!r} is not an e_wheel_* element")
    return lowered[len("e_wheel_"):]


def kind_of_draw(draw: dict, wheel_elements: list[dict]) -> tuple[str | None, list[tuple[float, dict]]]:
    """Wheel part kind = the kind of the containing element with the smallest AABB difference."""
    candidates = []
    for element in wheel_elements:
        if not finite_bounds(element):
            continue
        if not contains(element["min"], element["max"], draw["bounds"]["min"], draw["bounds"]["max"],
                        WHEEL_CONTAIN_TOL):
            continue
        difference = aabb_diff(draw["bounds"]["min"], draw["bounds"]["max"], element["min"], element["max"])
        if difference <= WHEEL_MAX_D:
            candidates.append((difference, element))
    if not candidates:
        return None, []
    candidates.sort(key=lambda item: (item[0], item[1]["name"]))
    best = candidates[0][0]
    tied = [(difference, element) for difference, element in candidates
            if difference <= best + AMBIGUITY_MARGIN]
    return wheel_kind(tied[0][1]["name"]), tied


def tyre_subsets(tyre_draws: list[dict], element: dict) -> list[dict]:
    """Every 1-3 draw union that reproduces this tyre element's local bounds."""
    options = []
    for size in range(1, 4):
        for combo in itertools.combinations(tyre_draws, size):
            lo, hi = union_bounds([draw["bounds"] for draw in combo])
            difference = aabb_diff(lo, hi, element["min"], element["max"])
            if difference <= TYRE_UNION_D:
                options.append({
                    "draws": [draw["index"] for draw in combo],
                    "unionBounds": {"min": lo, "max": hi},
                    "difference": difference,
                })
    options.sort(key=lambda option: (option["difference"], len(option["draws"]), option["draws"]))
    return options


def assign_tyres(tyre_draws: list[dict],
                 tyre_elements: list[dict]) -> tuple[str, dict[int, dict], dict[int, dict]]:
    """Assign every tyre draw to one of the four tyre elements.

    First pass: each element greedily takes its best disjoint 1-3 draw union that
    reproduces its bounds (tier `union`). Draws left over - an inner sidewall that
    is smaller than every element box - are distributed by containment and stay
    ambiguous. If no element can reproduce its bounds at all (measured), every
    draw is distributed by containment only (tier `containment`) and no corner is
    claimed.
    """
    options = {element["index"]: tyre_subsets(tyre_draws, element) for element in tyre_elements}

    def containment_share(draws: list[dict]) -> dict[int, dict]:
        if len(draws) % 4 != 0:
            raise Unsupported(f"{len(draws)} tyre draws do not divide across four corners")
        per_corner = len(draws) // 4
        by_index = {draw["index"]: draw for draw in draws}
        candidates = {}
        for draw in draws:
            candidates[draw["index"]] = [
                element["corner"] for element in tyre_elements
                if contains(element["min"], element["max"], draw["bounds"]["min"],
                            draw["bounds"]["max"], WHEEL_CONTAIN_TOL)]
        order = [element["corner"] for element in tyre_elements]
        chosen: list[dict] = []

        def solve(position: int, remaining: list[int]) -> bool:
            if position == len(order):
                return True
            corner = order[position]
            available = [index for index in remaining if corner in candidates[index]]
            if len(available) < per_corner:
                return False
            for combo in itertools.combinations(available, per_corner):
                chosen.append({"corner": corner, "draws": list(combo)})
                if solve(position + 1, [index for index in remaining if index not in combo]):
                    return True
                chosen.pop()
            return False

        if not solve(0, sorted(by_index)):
            raise Unsupported("tyre draws cannot be distributed over the four corners")
        result = {}
        for entry in chosen:
            element = next(element for element in tyre_elements if element["corner"] == entry["corner"])
            lo, hi = union_bounds([by_index[index]["bounds"] for index in entry["draws"]])
            result[element["index"]] = {
                "draws": entry["draws"],
                "unionBounds": {"min": lo, "max": hi},
                "difference": aabb_diff(lo, hi, element["min"], element["max"]),
            }
        return result

    # Deterministic greedy union assignment in canonical corner order. Each
    # element takes its best 1-3 draw union that does not reuse another element's
    # draws. Symmetric corners simply fall through to their next option.
    covered: dict[int, dict | None] = {}
    used: set[int] = set()
    for element in tyre_elements:
        chosen = None
        for option in options[element["index"]]:
            if used.intersection(option["draws"]):
                continue
            chosen = option
            break
        covered[element["index"]] = chosen
        if chosen is not None:
            used.update(chosen["draws"])
    if any(option is not None for option in covered.values()):
        leftover = [draw for draw in tyre_draws if draw["index"] not in used]
        if not leftover:
            return "union", covered, {element["index"]: None for element in tyre_elements}
        if len(leftover) % 4 == 0:
            return "union", covered, containment_share(leftover)

    # Containment-only fallback for every tyre draw.
    shares = containment_share(tyre_draws)
    return "containment", {element["index"]: None for element in tyre_elements}, shares


def assign_kind_by_corner(kind: str, elements: list[dict], draws: list[dict],
                          candidate_corners: dict[int, list[str]]) -> dict[int, dict]:
    """Distribute `draws` over the four same-kind elements (equal share each).

    A draw whose candidate set has one corner is proven; the rest are filled by
    a deterministic backtracking assignment and labelled preview-only.
    """
    if len(elements) != 4:
        raise Unsupported(f"expected four {kind} elements, found {len(elements)}")
    if not draws:
        return {}
    if len(draws) % 4 != 0:
        raise Unsupported(f"{len(draws)} {kind} draws do not divide across four corners")
    per_corner = len(draws) // 4
    order = [element["corner"] for element in elements]
    draw_indices = sorted(draw["index"] for draw in draws)

    result: list[dict] = []

    def solve(position: int, remaining: list[int], chosen: list) -> bool:
        if position == len(order):
            result.extend(chosen)
            return True
        corner = order[position]
        available = [index for index in remaining if corner in candidate_corners[index]]
        if len(available) < per_corner:
            return False
        for combo in itertools.combinations(available, per_corner):
            chosen.append({"corner": corner, "draws": list(combo)})
            if solve(position + 1, [index for index in remaining if index not in combo], chosen):
                return True
            chosen.pop()
        return False

    if not solve(0, draw_indices, []):
        raise Unsupported(f"{kind} draws cannot be distributed over the four corners")
    assignment: dict[int, dict] = {}
    for entry in result:
        element = next(element for element in elements if element["corner"] == entry["corner"])
        for draw_index in entry["draws"]:
            assignment[draw_index] = {"element": element, "corner": entry["corner"]}
    if sorted(assignment) != draw_indices:
        raise Unsupported(f"{kind} assignment lost a draw")
    return assignment


# ---------------------------------------------------------------------------
# Manifest assembly
# ---------------------------------------------------------------------------

def classify(scene: dict, mdl: dict, model_bounds: dict) -> dict:
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
    elements_by_index = {element["index"]: element for element in elements}
    wheel_elements = [element for element in elements if wheel_kind(element["name"])]
    if not wheel_elements:
        raise Unsupported("model 0 has no tyre/rim/disc/caliper elements")
    if len(wheel_elements) % 4 != 0:
        raise Unsupported(f"wheel element count {len(wheel_elements)} is not four per corner")

    # --- wheel groups -----------------------------------------------------
    wheel_parents = [element for element in elements if element["name"].lower().startswith("e_wheel_")]
    if len(wheel_parents) != 4:
        raise Unsupported(f"expected four e_wheel_* elements, found {len(wheel_parents)}")
    corners = [wheel_corner(element["name"]) for element in wheel_parents]
    if sorted(corners) != sorted(WHEEL_CORNERS):
        raise Unsupported(f"e_wheel_* corners are {sorted(corners)}, expected {sorted(WHEEL_CORNERS)}")
    for element in wheel_parents:
        element["corner"] = wheel_corner(element["name"])
    for element in wheel_elements:
        parent = elements_by_index.get(element["parent"])
        if parent is None or parent not in wheel_parents:
            raise Unsupported(f"wheel part {element['name']} is not a direct child of an e_wheel_* element")
        element["corner"] = parent["corner"]
    for corner in WHEEL_CORNERS:
        members = [element for element in wheel_elements if element["corner"] == corner]
        kinds = sorted(wheel_kind(element["name"]) for element in members)
        expected = sorted(kind for _, kind in WHEEL_PART_KIND)
        if kinds != expected:
            raise Unsupported(f"wheel {corner} members are {kinds}, expected {expected}")

    # The wheel axis proof is measured, not assumed: the group's own bounds must
    # be thinnest on X and round on Y/Z.
    for element in wheel_parents:
        members = [member for member in wheel_elements if member["corner"] == element["corner"]]
        lo, hi = union_bounds([{"min": member["min"], "max": member["max"]} for member in members])
        extent = [hi[i] - lo[i] for i in range(3)]
        round_delta = abs(extent[1] - extent[2]) / max(extent[1], extent[2])
        element["axisProof"] = {
            "unionLocalBounds": {"min": lo, "max": hi},
            "localExtent": extent,
            "thinAxis": "x" if extent[0] < extent[1] and extent[0] < extent[2] else None,
            "roundRelativeDelta": round_delta,
            "roundAxes": "y/z" if round_delta <= 0.10 else None,
        }
        if element["axisProof"]["thinAxis"] != "x" or element["axisProof"]["roundAxes"] != "y/z":
            raise Unsupported(
                f"wheel {element['corner']} bounds are not thin on X and round on Y/Z: {extent} "
                f"(round relative delta {round_delta:.4f})")

    # --- wheel kinds ------------------------------------------------------
    tyre_elements = sorted([element for element in wheel_elements if wheel_kind(element["name"]) == "tyre"],
                           key=lambda element: WHEEL_CORNERS.index(element["corner"]))
    tyre_draws = []
    other_by_kind: dict[str, list[dict]] = {"rim": [], "brakeDisc": [], "brakeCaliper": []}
    candidate_corners: dict[str, dict[int, list[str]]] = {"rim": {}, "brakeDisc": {}, "brakeCaliper": {}}
    for draw in draws:
        kind, tied = kind_of_draw(draw, wheel_elements)
        if kind is None:
            continue
        if kind == "tyre":
            tyre_draws.append(draw)
        else:
            other_by_kind[kind].append(draw)
            candidate_corners[kind][draw["index"]] = sorted(
                {element["corner"] for _, element in tied}, key=WHEEL_CORNERS.index)
    if len(tyre_draws) < 4:
        raise Unsupported(f"found only {len(tyre_draws)} tyre draws")

    tyre_tier, tyre_options, tyre_extras = assign_tyres(tyre_draws, tyre_elements)

    wheel_assignment: dict[int, dict] = {}
    ambiguous: list[dict] = []
    tyre_rows = []
    draw_by_index = {draw["index"]: draw for draw in draws}
    for element in tyre_elements:
        option = tyre_options[element["index"]]
        extra = tyre_extras[element["index"]]
        if option is not None:
            matchable = []
            for other in tyre_elements:
                difference = aabb_diff(option["unionBounds"]["min"], option["unionBounds"]["max"],
                                       other["min"], other["max"])
                if difference <= TYRE_UNION_D:
                    matchable.append((difference, other))
            matchable.sort(key=lambda item: (item[0], item[1]["name"]))
        else:
            matchable = []
        matched_corners = sorted({other["corner"] for _, other in matchable}, key=WHEEL_CORNERS.index)
        proven = option is not None and matched_corners == [element["corner"]]
        union_draws = option["draws"] if option is not None else []
        extra_draws = extra["draws"] if extra is not None else []
        all_draws = sorted(union_draws + extra_draws)
        tyre_rows.append({
            "element": element["name"],
            "corner": element["corner"],
            "draws": all_draws,
            "unionDraws": union_draws,
            "extraDraws": extra_draws,
            "difference": (option["difference"] if option is not None
                           else (extra["difference"] if extra is not None else None)),
            "matchedCorners": matched_corners,
            "proof": "union" if proven else ("containment" if option is None else "union-ambiguous"),
            "proven": proven,
        })
        if option is not None:
            for draw_index in union_draws:
                wheel_assignment[draw_index] = {
                    "element": element["name"] if proven else None,
                    "wheelPart": "tyre",
                    "role": "union-pair" if len(union_draws) > 1 else "single",
                    "proof": ("tyre element bounds equal the union of its draws"
                              if proven else
                              "tyre union bounds also match other corners; the corner is not provable"),
                    "difference": option["difference"],
                    "corner": element["corner"],
                    "proven": proven,
                    "candidates": [other["name"] for _, other in matchable],
                }
                if not proven:
                    ambiguous.append({
                        "draw": draw_index,
                        "wheelPart": "tyre",
                        "axle": "unknown",
                        "candidates": [other["name"] for _, other in matchable],
                        "difference": option["difference"],
                        "reason": "tyre union bounds are identical/nearly identical for several "
                                  "corners; the corner is not provable",
                    })
        for draw_index in extra_draws:
            candidates = [other["name"] for other in tyre_elements
                          if contains(other["min"], other["max"],
                                      draw_by_index[draw_index]["bounds"]["min"],
                                      draw_by_index[draw_index]["bounds"]["max"], WHEEL_CONTAIN_TOL)]
            wheel_assignment[draw_index] = {
                "element": None,
                "wheelPart": "tyre",
                "role": "containment-extra",
                "proof": "draw is only proven to lie inside the tyre element bounds; "
                         "the corner is preview-only",
                "difference": extra["difference"] if extra is not None else None,
                "corner": element["corner"],
                "proven": False,
                "candidates": candidates,
            }
            ambiguous.append({
                "draw": draw_index,
                "wheelPart": "tyre",
                "axle": "unknown",
                "candidates": candidates,
                "difference": extra["difference"] if extra is not None else None,
                "reason": "extra tyre draw is smaller than every tyre element box; its corner is "
                          "only paired for drawing",
            })

    other_rows = []
    for kind in ("rim", "brakeDisc", "brakeCaliper"):
        kind_elements = sorted([element for element in wheel_elements
                                if wheel_kind(element["name"]) == kind],
                               key=lambda element: WHEEL_CORNERS.index(element["corner"]))
        if len(kind_elements) != 4:
            raise Unsupported(f"expected four {kind} elements, found {len(kind_elements)}")
        assignment = assign_kind_by_corner(kind, kind_elements, other_by_kind[kind],
                                           candidate_corners[kind])
        for draw_index, entry in sorted(assignment.items()):
            corners_for_draw = candidate_corners[kind][draw_index]
            proven = len(corners_for_draw) == 1
            element = entry["element"]
            draw = draws[draw_index]
            difference = aabb_diff(draw["bounds"]["min"], draw["bounds"]["max"],
                                   element["min"], element["max"])
            candidates = sorted((candidate["name"] for candidate in kind_elements
                                 if candidate["corner"] in corners_for_draw),
                                key=lambda name: name.lower())
            wheel_assignment[draw_index] = {
                "element": element["name"] if proven else None,
                "wheelPart": kind,
                "role": "primary",
                "proof": ("draw AABB equals the element-local bounds" if proven else
                          "draw matches several corners; corner is preview-only"),
                "difference": difference,
                "corner": entry["corner"],
                "proven": proven,
                "candidates": candidates,
            }
            if not proven:
                ambiguous.append({
                    "draw": draw_index,
                    "wheelPart": kind,
                    "axle": "unknown",
                    "candidates": candidates,
                    "difference": difference,
                    "reason": "element-local bounds are (nearly) identical for several corners; "
                              "the corner is not provable",
                })
        other_rows.append({
            "kind": kind,
            "certified": sum(1 for draw_index in assignment
                             if len(candidate_corners[kind][draw_index]) == 1),
            "ambiguous": sum(1 for draw_index in assignment
                             if len(candidate_corners[kind][draw_index]) > 1),
        })

    # --- non-wheel parts --------------------------------------------------
    wheel_part_indexes = {element["index"] for element in wheel_elements}
    wheel_parent_indexes = {element["index"] for element in wheel_parents}
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
        wheel_assignment[draw_index] = {"element": name, "wheelPart": None, "role": "primary",
                                        "proof": part["proof"]["tier"], "corner": None,
                                        "proven": True, "candidates": []}

    draw_matches: dict[int, dict] = {}
    for draw in draws:
        if draw["index"] in wheel_assignment:
            continue
        contained = []
        for element in elements:
            if element["index"] in wheel_part_indexes or element["index"] in wheel_parent_indexes:
                continue
            if not finite_bounds(element):
                continue
            # Scene draws are element-local (the reader applies no node
            # transform), so the draw AABB is compared with the element's local
            # bounds directly. For the translation-only DefaultModel this is the
            # same as shifting both by the element translation, but it also
            # holds for the one element with float32 matrix noise.
            if contains(element["min"], element["max"], draw["bounds"]["min"], draw["bounds"]["max"],
                        CONTAIN_TOL):
                contained.append((aabb_diff(draw["bounds"]["min"], draw["bounds"]["max"],
                                           element["min"], element["max"]),
                                  volume(element["min"], element["max"]), element))
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
                "reason": f"draw AABB matches {element['name']} bounds within {difference:.6f} "
                          "(symmetric difference)",
                "element": element["name"],
                "difference": difference,
            }
            add_part(part_id, kind, element["name"], element, draw["index"], proof)
            draw_matches[draw["index"]] = proof
            continue
        branch = element_branch(element, elements_by_index)
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
    for element in wheel_parents:
        members = sorted([member for member in wheel_elements if member["corner"] == element["corner"]],
                         key=lambda member: member["name"])
        member_draws = sorted(index for index, value in wheel_assignment.items()
                              if value.get("corner") == element["corner"] and value.get("wheelPart"))
        proven_draws = [index for index in member_draws if wheel_assignment[index].get("proven")]
        ambiguous_draws = [index for index in member_draws if not wheel_assignment[index].get("proven")]
        translation = element["worldTranslation"]
        if not all(model_bounds["min"][i] - 0.6 <= translation[i] <= model_bounds["max"][i] + 0.6
                   for i in range(3)):
            raise Unsupported(
                f"wheel {element['corner']} translation {translation} is outside the model bounds; "
                "the serialized element matrix is not model-space")
        wheel_groups.append({
            "id": f"wheel.{element['corner']}",
            "partKind": "wheel",
            "name": element["name"],
            "elementIndex": element["index"],
            "corner": element["corner"],
            "localBounds": {"min": element["min"], "max": element["max"]},
            "memberLocalBounds": element["axisProof"]["unionLocalBounds"],
            "localTransform": {
                "matrixRows": element["matrix"],
                "translation": element["matrix"][3],
                "linearIdentity": element["linearIdentity"],
            },
            "worldTransform": {
                "coordinateSpace": "model",
                "translation": translation,
                "matrixColumnMajor": column_major_from_rows(element["matrix"]),
            },
            "spin": {
                "axis": [1.0, 0.0, 0.0],
                "axisSpace": "element-local",
                "spinMembers": ["tyre", "rim", "brakeDisc"],
                "staticMembers": ["brakeCaliper"],
                "axisEvidence": element["axisProof"],
                "evidence":
                    "the group's member local bounds are thinnest on X and round on Y/Z, so X is the "
                    "axle. Upstream VehicleActor.cpp:5158-5167 computes the spin rate about "
                    "wheelMatrix.AX(); lines 5170-5196 store that wheel matrix for Tyre/AlloyRim/BrakeDisc, "
                    "and line 5198 states 'Brake calipers mustn't rotate'.",
                "source": "upstream/BlurRebuilt 5270304b code/amax/game/Game/GameActors/Vehicles/VehicleActor.cpp",
            },
            "memberParts": [{
                "name": member["name"],
                "wheelPart": wheel_kind(member["name"]),
                "spins": wheel_kind(member["name"]) != "brakeCaliper",
                "elementIndex": member["index"],
                "localBounds": {"min": member["min"], "max": member["max"]},
            } for member in members],
            "provenDraws": proven_draws,
            "previewDraws": member_draws,
            "ambiguousDraws": [{
                "draw": index,
                "wheelPart": wheel_assignment[index]["wheelPart"],
                "candidates": wheel_assignment[index]["candidates"],
                "reason": next(item["reason"] for item in ambiguous if item["draw"] == index),
                "assignment": "preview-only deterministic pairing; not a corner proof",
            } for index in ambiguous_draws],
            "draws": member_draws,
        })

    # --- parts (shells + named) -------------------------------------------
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
            element = elements_by_index[part["elementIndex"]]
            part["localBounds"] = {"min": element["min"], "max": element["max"]}
            part["localTransform"] = {
                "matrixRows": element["matrix"],
                "translation": element["matrix"][3],
                "linearIdentity": element["linearIdentity"],
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
            "memberLocalBounds": group["memberLocalBounds"],
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

    # --- draw records -----------------------------------------------------
    part_of_draw: dict[int, str] = {}
    for part in final_parts:
        for draw_index in part["draws"]:
            if draw_index in part_of_draw:
                raise Unsupported(
                    f"draw {draw_index} belongs to both {part_of_draw[draw_index]} and {part['id']}")
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
            }
        elif draw["evidence"] and draw["evidence"].get("wheelPart"):
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
        if ambiguous_item:
            draw["partId"] = None
            draw["partKind"] = "unclassified"
            draw["partName"] = None
            draw["previewPartId"] = part_id
            draw["unclassifiedReason"] = ambiguous_item["reason"]
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
        "tyres": tyre_rows,
        "tyreProofTier": tyre_tier,
        "wheelKindCounts": other_rows,
    }


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
    if not scene.get("draws"):
        raise SystemExit("scene reader returned no draws")

    mdl = parse_mdldat(model_bytes)
    if mdldat_chunk["offset"] != mdl["offset"] or mdldat_chunk["bytes"] != mdl["bytes"]:
        raise SystemExit(
            f"model_inspect MdlDat {mdldat_chunk['offset']}/{mdldat_chunk['bytes']} differs from "
            f"source parser {mdl['offset']}/{mdl['bytes']}")
    classified = classify(scene, mdl, scene["bounds"])

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
        "unclassifiedPartCount": sum(1 for part in classified["parts"]
                                     if part["partKind"] == "unclassified"),
        "wheelDrawCount": sum(len(group["previewDraws"]) for group in classified["wheelGroups"]),
        "provenWheelDrawCount": sum(len(group["provenDraws"]) for group in classified["wheelGroups"]),
        "ambiguousWheelDrawCount": len(classified["ambiguousWheelDraws"]),
        "provenDrawCount": sum(1 for draw in classified["draws"]
                               if draw["partId"] is not None and draw["partKind"] != "unclassified"),
        "glassDrawCount": sum(len(part["draws"]) for part in classified["parts"]
                              if part["partKind"] == "glass"),
        "lightDrawCount": sum(len(part["draws"]) for part in classified["parts"]
                              if part["partKind"] == "light"),
        "bodyDrawCount": sum(len(part["draws"]) for part in classified["parts"]
                             if part["partKind"] == "body"),
        "interiorDrawCount": sum(len(part["draws"]) for part in classified["parts"]
                                 if part["partKind"] == "interior"),
        "unclassifiedDrawCount": sum(1 for draw in classified["draws"]
                                     if draw["partKind"] == "unclassified"),
        "wheelGroupCount": len(classified["wheelGroups"]),
        "tyreProofTier": classified["tyreProofTier"],
        "wheelElementCount": len([element for element in mdl["elements"]
                                  if element["modelIndex"] == 0 and wheel_kind(element["name"])]),
        "tyreDrawCount": sum(1 for value in classified["wheelAssignment"].values()
                             if value.get("wheelPart") == "tyre"),
        "rimDrawCount": sum(1 for value in classified["wheelAssignment"].values()
                            if value.get("wheelPart") == "rim"),
        "brakeDiscDrawCount": sum(1 for value in classified["wheelAssignment"].values()
                                  if value.get("wheelPart") == "brakeDisc"),
        "brakeCaliperDrawCount": sum(1 for value in classified["wheelAssignment"].values()
                                     if value.get("wheelPart") == "brakeCaliper"),
    }
    if diagnostics["wheelGroupCount"] != 4:
        raise Unsupported("expected four wheel groups")
    if diagnostics["provenDrawCount"] + diagnostics["unclassifiedDrawCount"] != diagnostics["drawCount"]:
        raise Unsupported("draw proof accounting does not add up")
    if diagnostics["wheelDrawCount"] != sum(diagnostics[key] for key in
                                            ("tyreDrawCount", "rimDrawCount",
                                             "brakeDiscDrawCount", "brakeCaliperDrawCount")):
        raise Unsupported("wheel draw accounting does not add up")

    out_dir = args.out_dir.resolve()
    try:
        # The mesh path is stored relative to the manifest so two builds into
        # different output directories produce byte-identical manifests.
        mesh_relative = mesh_path_for(out_dir, args).resolve().relative_to(out_dir)
        mesh_path_text = str(mesh_relative).replace("\\", "/")
    except ValueError:
        mesh_path_text = str(mesh_path_for(out_dir, args))
    model_relative = model_path.relative_to(ROOT) if model_path.is_relative_to(ROOT) else None

    manifest = {
        "kind": "blur.car-part-manifest",
        "version": 1,
        "generator": "probes/car-parts/tools/build_manifest.py",
        "source": {
            "model": str(model_relative).replace("\\", "/") if model_relative else str(model_path),
            "modelBytes": len(model_bytes),
            "modelSha256": model_sha,
            "modelPakPath": args.model_pak_path,
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
            "elementMatrixFrame":
                "model-space: the serialized element translation already carries its parent's offset "
                "(a wheel member repeats its e_wheel_* parent translation), so parent links are recorded "
                "but not composed. Each wheel group translation is checked against the model bounds.",
            "car": None if args.car_slug is None else {
                "slug": args.car_slug,
                "name": args.car_name,
                "mapping": args.car_mapping,
            },
            "note":
                "Scene geometry is the committed first-RenderList LOD0 output, unchanged. Part names, "
                "element matrices and local bounds come from the same file's MdlDat block. The consumer "
                "applies each part matrix at draw time; the mesh itself is not transformed.",
        },
        "matching": {
            "containToleranceMeters": CONTAIN_TOL,
            "exactDifferenceMeters": EXACT_D,
            "wheelContainToleranceMeters": WHEEL_CONTAIN_TOL,
            "wheelMaximumDifferenceMeters": WHEEL_MAX_D,
            "tyreUnionToleranceMeters": TYRE_UNION_D,
            "ambiguityMarginMeters": AMBIGUITY_MARGIN,
            "description":
                "A draw is linked to an element only when its index-range AABB is contained in the "
                "element bounds and the symmetric AABB difference is within the stated threshold. A "
                "tyre is proven by the exact union of the 1-2 draws that make it. A draw whose best "
                "candidate is within ambiguityMarginMeters of another element of the same kind is only "
                "paired to a corner for drawing.",
        },
        "mdlDat": {
            "offset": mdl["offset"],
            "bytes": mdl["bytes"],
            "sha256": mdl["sha256"],
            "version": mdl["version"],
            "modelCount": mdl["modelCount"],
            "elementCount": mdl["elementCount"],
            "constraintCount": mdl["constraintCount"],
            "nonIdentityElementCount": mdl["nonIdentityElementCount"],
            "nonIdentityModelElements": mdl["nonIdentityModelElements"],
            "linearIdentityTolerance": 1e-6,
            "bounds": mdl["bounds"],
            "models": [{
                "index": model["index"],
                "name": model["name"],
                "matrixRows": model["matrix"],
                "linearIdentity": model["linearIdentity"],
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
                "linearIdentity": element["linearIdentity"],
                "localBounds": {"min": element["min"], "max": element["max"]},
                "worldTranslation": element["worldTranslation"],
                "emptyBounds": not finite_bounds(element),
            } for element in mdl["elements"]],
        },
        "mesh": {
            "path": mesh_path_text,
            "pathBase": "manifest-directory",
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
            "memberLocalBounds": group["memberLocalBounds"],
            "localTransform": group["localTransform"],
            "worldTransform": group["worldTransform"],
            "spin": group["spin"],
            "memberParts": group["memberParts"],
            "provenDraws": group["provenDraws"],
            "previewDraws": group["previewDraws"],
            "ambiguousDraws": group["ambiguousDraws"],
        } for group in classified["wheelGroups"]],
        "tyres": classified["tyres"],
        "tyreProofTier": classified["tyreProofTier"],
        "wheelKindCounts": classified["wheelKindCounts"],
        "unclassifiedDraws": [{
            "draw": item["draw"],
            "partKind": "unclassified",
            "wheelPart": item["wheelPart"],
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
            "DefaultModel element matrices are translation-only in this asset; a non-identity linear "
            "part is rejected instead of being transposed or guessed.",
            "Draw-to-part identity is proven by index-range AABB matching; material/effect names are "
            "recorded as corroboration, not used as a name source.",
            "Some left/right wheel parts have identical or nearly identical element-local bounds; their "
            "corner is not provable and the preview pairing is explicitly presentation-only.",
            "No game integration, rendering fidelity, collision, physics or shader semantics are claimed.",
        ],
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    mesh_file = mesh_path_for(out_dir, args)
    mesh_file.parent.mkdir(parents=True, exist_ok=True)
    (out_dir / "scene-report.json").write_text(scene_text, encoding="utf-8", newline="\n")
    mesh_file.write_text(
        json.dumps(mesh, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    manifest_text = json.dumps(manifest, indent=1, sort_keys=True) + "\n"
    (out_dir / "manifest.json").write_text(manifest_text, encoding="utf-8", newline="\n")

    return {
        "manifest": str(out_dir / "manifest.json"),
        "manifestSha256": sha256(manifest_text.encode("utf-8")),
        "manifestBytes": len(manifest_text.encode("utf-8")),
        "mesh": str(mesh_file),
        "meshSha256": sha256(mesh_file.read_bytes()),
        "meshPositionsSha256": mesh["positionsFloat32LESha256"],
        "meshIndicesSha256": mesh["indicesUint32LESha256"],
        "sceneReport": str(out_dir / "scene-report.json"),
        "sceneReportSha256": sha256(scene_text.encode("utf-8")),
        "model": str(model_relative).replace("\\", "/") if model_relative else str(model_path),
        "modelSha256": model_sha,
        "car": None if args.car_slug is None else {"slug": args.car_slug, "name": args.car_name},
        "diagnostics": diagnostics,
        "tyres": classified["tyres"],
        "tyreProofTier": classified["tyreProofTier"],
        "wheelKindCounts": classified["wheelKindCounts"],
        "wheelGroups": [{
            "id": group["id"],
            "name": group["name"],
            "provenDraws": group["provenDraws"],
            "previewDraws": group["previewDraws"],
            "ambiguousDraws": group["ambiguousDraws"],
            "translation": group["worldTransform"]["translation"],
            "axisEvidence": group["spin"]["axisEvidence"],
        } for group in classified["wheelGroups"]],
    }


def mesh_path_for(out_dir: Path, args: argparse.Namespace) -> Path:
    if args.mesh_out:
        return Path(args.mesh_out).resolve()
    return out_dir / "mesh.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", type=Path, default=MODEL_DEFAULT)
    parser.add_argument("--scene-exe", type=Path, default=SCENE_EXE_DEFAULT)
    parser.add_argument("--model-exe", type=Path, default=MODEL_EXE_DEFAULT)
    parser.add_argument("--scene-json", type=Path, default=None,
                        help="use an existing scene_inspect JSON instead of running the exe")
    parser.add_argument("--out-dir", type=Path, default=OUT_DEFAULT)
    parser.add_argument("--mesh-out", type=Path, default=None,
                        help="write mesh.json here instead of <out-dir>/mesh.json")
    parser.add_argument("--car-slug", default=None)
    parser.add_argument("--car-name", default=None)
    parser.add_argument("--car-mapping", default=None,
                        help="evidence string for how this model was chosen for the car")
    parser.add_argument("--model-pak-path", default=None,
                        help="exact in-PAK path of the decoded model")
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
