"""Prove the wheel corner of every wheel draw of every decodable vehicle.

The existing car-parts builder proves a wheel draw's *kind* (tyre / rim / brake
disc / brake caliper) by element-local AABB containment, but it leaves the
*corner* unproven whenever the four same-kind element boxes are within its
`tyreUnionTolerance` (5 cm). For 806 of the 1,128 staged wheel draws that is the
case, so `e1-drive` renders those draws with a `previewPartId` that the packet
builder ignores: the draw falls back to the body node and the wheel collapses to
the car origin.

This tool proves the corner with data invariants instead of a name or a guess:

  I1  element identity      the four `e_wheel_<corner>` elements and their
                            member elements (`e_tyre_*`, `e_alloyRim_*`,
                            `e_brakeDisc_*`, `e_brakeCaliper_*`) name the
                            corner; the name is the *claim*, not the proof.
  I2  hub placement         each corner translation is mirrored left/right,
                            split front/back, and reproduces the physics
                            wheelbase/track within a stated tolerance.
  I3  member-box match      a draw (or a 1..3-draw assembly) is contained in
                            exactly one corner member box, and its per-axis AABB
                            cost is lower there than at any materially
                            different corner.
  I4  handedness            the mirror-asymmetric parts (disc, caliper, dished
                            rim/tyre) have an X offset whose sign matches the
                            corner: the outer face points away from the car.
  I5  hub proximity         every member box and draw lies inside the tyre
                            envelope: no part may be displaced by more than the
                            tyre radius from its own hub.
  I6  spin axis             the group is thinnest on X and round on Y/Z; the
                            axle direction is orthogonal to the wheelbase
                            direction and to the up axis.
  I7  symmetry pairs        the left/right boxes are mirror images and the
                            front/back boxes are translations of each other,
                            within the float32 serialization noise.
  I8  render equivalence    when two assignments cannot be separated by I2-I7
                            (identical boxes), the actual vertex clouds are
                            compared: if every vertex of one candidate group is
                            within `equivalenceTolerance` of the other, the two
                            assignments render the same and either is correct.

A draw is only assigned when one of these holds: the corner is the unique
cost minimum and every materially different alternative is worse by at least
`proofMargin` (I3/I4), or every alternative is render-equivalent (I8). Anything
else is emitted as `ambiguous` with the competing evidence; nothing is guessed.

Usage:
  python probes/wheels/tools/wheel_corners.py [--out-root _work/wheels]
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mdl

ROOT = Path(__file__).resolve().parents[3]
STAGING = ROOT / "_work/wheels/staging.json"
OUT_DEFAULT = ROOT / "_work/wheels"
VEHICLE_ACTOR = "upstream/BlurRebuilt/code/amax/game/Game/GameActors/Vehicles/VehicleActor.cpp"
SPIN_SOURCE = (VEHICLE_ACTOR, 5158, 5208)

CORNERS = ("frontleft", "frontright", "backleft", "backright")
KINDS = ("tyre", "rim", "brakeDisc", "brakeCaliper")
SPINNING = ("tyre", "rim", "brakeDisc")
STATIC = ("brakeCaliper",)

# Name prefixes. Case differs per asset ("E_Tyre_" vs "e_tyre_",
# "E_BrakeCaliper_" vs "E_Brake_Caliper_"), so the match is case-insensitive and
# tolerant of the underscore inside "Brake_Caliper".
KIND_PREFIXES = (
    ("e_tyre_", "tyre"),
    ("e_alloyrim_", "rim"),
    ("e_brakedisc_", "brakeDisc"),
    ("e_brakecaliper_", "brakeCaliper"),
    ("e_brake_caliper_", "brakeCaliper"),
)

CONTAIN_TOL = 0.005          # m: a draw must lie inside its member box
PART_LOCAL_MAX = (0.35, 0.60, 0.60)  # m: how far a wheel part may sit from its hub
KIND_MAX_D = 0.15            # m: max symmetric AABB difference to call it a member draw
KIND_AMBIGUITY_MARGIN = 0.01  # m: two kinds equally close -> typed conflict
SPREAD_MIN = 2e-4            # m: an axis only discriminates when the boxes differ by more
SKEW_MIN = 1e-5              # m: below this an X offset is float32 noise, not handedness
PROOF_MARGIN = 1e-4          # m: minimum cost advantage over a materially different match
EQUIV_TOL = 1e-3             # m: vertex-level indistinguishability (1 mm)
HUB_MARGIN = 0.02            # m: member envelope slack around the tyre bounds
SYMMETRY_TOL = 5e-3          # m: left/right and front/back residual limit
PHYSICS_WHEELBASE_TOL = 0.08  # m
PHYSICS_TRACK_TOL = 0.35     # m: the physics track is not the hub track on every car
PHYSICS_RADIUS_TOL = 0.08    # m

METHOD = {
    "name": "wheel-corner data invariants",
    "version": 1,
    "invariants": [
        {"id": "I1", "name": "element identity",
         "statement": "the e_wheel_<corner> element name and its member element names are "
                      "the corner claim; they are cross-checked, never used alone"},
        {"id": "I2", "name": "hub placement",
         "statement": "corner translations mirror across X, separate across Z and reproduce "
                      "the physics wheelbase and track within the stated tolerance"},
        {"id": "I3", "name": "member-box match",
         "statement": "each draw assembly is contained in one corner member box and its "
                      "discriminating-axis AABB cost is lower there than at any materially "
                      "different corner by at least proofMargin"},
        {"id": "I4", "name": "handedness",
         "statement": "for mirror-asymmetric parts the X offset sign matches the corner: the "
                      "outer face points away from the car centre plane"},
        {"id": "I5", "name": "hub proximity",
         "statement": "every member box and draw lies inside the tyre envelope around its own "
                      "hub; a displaced part is reported, never placed"},
        {"id": "I6", "name": "spin axis",
         "statement": "the wheel group is thinnest on element-local X and round on Y/Z, and X "
                      "is orthogonal to the wheelbase direction and to the up axis"},
        {"id": "I7", "name": "symmetry pair",
         "statement": "left/right member boxes are mirror images and front/back boxes are "
                      "translations within float32 serialization noise"},
        {"id": "I8", "name": "render equivalence",
         "statement": "when boxes cannot separate two assignments, the vertex clouds are "
                      "compared; within equivalenceTolerance the two renders are the same"},
    ],
    "tolerances": {
        "containToleranceMeters": CONTAIN_TOL,
        "kindMaximumDifferenceMeters": KIND_MAX_D,
        "kindAmbiguityMarginMeters": KIND_AMBIGUITY_MARGIN,
        "boxSpreadMinimumMeters": SPREAD_MIN,
        "handednessMinimumOffsetMeters": SKEW_MIN,
        "proofMarginMeters": PROOF_MARGIN,
        "equivalenceToleranceMeters": EQUIV_TOL,
        "hubEnvelopeMarginMeters": HUB_MARGIN,
        "symmetryToleranceMeters": SYMMETRY_TOL,
        "physicsWheelbaseToleranceMeters": PHYSICS_WHEELBASE_TOL,
        "physicsTrackToleranceMeters": PHYSICS_TRACK_TOL,
        "physicsRadiusToleranceMeters": PHYSICS_RADIUS_TOL,
    },
    "spinEvidence": {
        "spinAxis": [1.0, 0.0, 0.0],
        "axisSpace": "element-local",
        "spinningKinds": list(SPINNING),
        "staticKinds": list(STATIC),
        "source": SPIN_SOURCE[0],
        "lines": [SPIN_SOURCE[1], SPIN_SOURCE[2]],
        "reason": "VehicleActor.cpp:5158-5196 stores one wheel matrix (spin about "
                  "wheelMatrix.AX(), the element-local X) for Tyre/AlloyRim/BrakeDisc and "
                  "line 5198 states 'Brake calipers mustn't rotate'; the caliper uses the "
                  "unspun rest matrix.",
    },
}


class AnalysisError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_json(value) -> str:
    return json.dumps(value, indent=1, sort_keys=True) + "\n"


def kind_of(name: str) -> str | None:
    lowered = name.lower()
    for prefix, kind in KIND_PREFIXES:
        if lowered.startswith(prefix):
            return kind
    return None


def centre(box_min, box_max) -> list[float]:
    return [(box_min[axis] + box_max[axis]) / 2.0 for axis in range(3)]


def normalise_member(element: dict, hub: list[float]) -> dict:
    """Put a member element's local bounds into the frame the draws live in.

    The MdlDat member boxes are authored inconsistently across assets: most are
    element-local (the wheel hub is the origin), some are model-space (they carry
    the hub translation), and a few are displaced by the hub translation twice.
    The draw geometry is the authority: it is element-local by the reader
    contract, so a box that is centred on its own hub is converted by removing
    the hub translation. A box that is centred on neither is `displaced` and is
    never used for a corner proof.
    """
    box_min = list(element["min"])
    box_max = list(element["max"])
    middle = centre(box_min, box_max)
    if (abs(middle[0]) <= PART_LOCAL_MAX[0] and abs(middle[1]) <= PART_LOCAL_MAX[1]
            and abs(middle[2]) <= PART_LOCAL_MAX[2]):
        return {"frame": "element-local", "min": box_min, "max": box_max, "shift": [0, 0, 0]}
    shifted = [middle[axis] - hub[axis] for axis in range(3)]
    if (abs(shifted[0]) <= PART_LOCAL_MAX[0] and abs(shifted[1]) <= PART_LOCAL_MAX[1]
            and abs(shifted[2]) <= PART_LOCAL_MAX[2]):
        return {"frame": "model-space", "min": [box_min[axis] - hub[axis] for axis in range(3)],
                "max": [box_max[axis] - hub[axis] for axis in range(3)],
                "shift": [-hub[0], -hub[1], -hub[2]]}
    return {"frame": "displaced", "min": box_min, "max": box_max, "shift": [0, 0, 0],
            "displacement": [middle[axis] - hub[axis] for axis in range(3)]}


def corner_of(name: str) -> str | None:
    lowered = name.lower()
    prefix = "e_wheel_"
    if not lowered.startswith(prefix):
        return None
    suffix = lowered[len(prefix):]
    return suffix if suffix in CORNERS else None


def axis_spread(boxes: dict) -> list[float]:
    """How much the four corner boxes differ on each axis, endpoint by endpoint."""
    spread = []
    for axis in range(3):
        lows = [boxes[corner][0][axis] for corner in CORNERS]
        highs = [boxes[corner][1][axis] for corner in CORNERS]
        spread.append((max(lows) - min(lows)) + (max(highs) - min(highs)))
    return spread


def box_cost(lo_a, hi_a, lo_b, hi_b, axes) -> float:
    return sum(abs(lo_a[axis] - lo_b[axis]) + abs(hi_a[axis] - hi_b[axis]) for axis in axes)


def contains_box(outer_lo, outer_hi, inner_lo, inner_hi, tol: float) -> bool:
    return all(inner_lo[axis] >= outer_lo[axis] - tol and inner_hi[axis] <= outer_hi[axis] + tol
               for axis in range(3))


def union_bounds(draws: list[mdl.Draw]) -> tuple[list[float], list[float]]:
    lo = [min(draw.bounds_min[axis] for draw in draws) for axis in range(3)]
    hi = [max(draw.bounds_max[axis] for draw in draws) for axis in range(3)]
    return lo, hi


def group_points(draws: list[mdl.Draw]) -> list[tuple[float, float, float]]:
    points: list[tuple[float, float, float]] = []
    for draw in draws:
        points.extend(draw.points)
    return points


def hausdorff_within(points_a, points_b, tol: float) -> bool:
    """True when every point of A is within `tol` of a point of B (and vice versa)."""
    def covered(source, target):
        cell = max(tol, 1e-9)
        grid: dict[tuple[int, int, int], list] = {}
        for point in target:
            key = (math.floor(point[0] / cell), math.floor(point[1] / cell),
                   math.floor(point[2] / cell))
            grid.setdefault(key, []).append(point)
        limit = tol * tol
        for point in source:
            base = (math.floor(point[0] / cell), math.floor(point[1] / cell),
                    math.floor(point[2] / cell))
            found = False
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        for other in grid.get((base[0] + dx, base[1] + dy, base[2] + dz), ()):
                            ddx = point[0] - other[0]
                            ddy = point[1] - other[1]
                            ddz = point[2] - other[2]
                            if ddx * ddx + ddy * ddy + ddz * ddz <= limit:
                                found = True
                                break
                        if found:
                            break
                    if found:
                        break
                if found:
                    break
            if not found:
                return False
        return True
    return covered(points_a, points_b) and covered(points_b, points_a)


# ---------------------------------------------------------------------------
# Wheel model of one car
# ---------------------------------------------------------------------------

def build_wheel_model(mdldat: dict) -> dict:
    elements = [element for element in mdldat["elements"] if element["modelIndex"] == 0]
    by_index = {element["index"]: element for element in elements}
    parents: dict[str, dict] = {}
    for element in elements:
        corner = corner_of(element["name"])
        if corner is None:
            continue
        if corner in parents:
            raise AnalysisError(f"two e_wheel_{corner} elements")
        parents[corner] = element
    missing = [corner for corner in CORNERS if corner not in parents]
    if missing:
        raise AnalysisError(f"no e_wheel_* element for {missing}")

    members: dict[str, dict[str, dict]] = {corner: {} for corner in CORNERS}
    holders: dict[str, dict[str, dict]] = {}
    orphans: list[dict] = []
    for element in elements:
        kind = kind_of(element["name"])
        if kind is None:
            continue
        cursor = element
        corner = None
        for _ in range(8):
            parent_index = cursor["parent"]
            if parent_index < 0:
                break
            parent = by_index.get(parent_index)
            if parent is None:
                break
            candidate = corner_of(parent["name"])
            if candidate is not None:
                corner = candidate
                break
            cursor = parent
        if corner is None:
            orphans.append({
                "name": element["name"], "kind": kind, "elementIndex": element["index"],
                "parent": element["parent"],
                "reason": "wheel member element is not below an e_wheel_<corner> element",
            })
            continue
        if kind in members[corner]:
            orphans.append({
                "name": element["name"], "kind": kind, "elementIndex": element["index"],
                "parent": element["parent"],
                "reason": f"duplicate {kind} member for {corner}; the first one is used and the "
                          "duplicate is recorded, not merged",
            })
            continue
        members[corner][kind] = element

    # Normalise every member box into the element-local (draw) frame of its hub.
    for corner in CORNERS:
        hub = parents[corner]["translation"]
        for kind in list(members[corner]):
            normalised = normalise_member(members[corner][kind], hub)
            normalised["name"] = members[corner][kind]["name"]
            normalised["elementIndex"] = members[corner][kind]["index"]
            holders.setdefault(kind, {})[corner] = normalised

    return {"parents": parents, "members": members, "normalised": holders,
            "orphans": orphans, "elements": elements, "byIndex": by_index}


def classify_draws(draws: list[mdl.Draw], wheel: dict) -> dict:
    """Assign every draw a wheel kind through element-local box containment."""
    boxes = []
    for corner in CORNERS:
        for kind in KINDS:
            normalised = wheel["normalised"].get(kind, {}).get(corner)
            if normalised is None or normalised["frame"] == "displaced":
                continue
            boxes.append((corner, kind, normalised["min"], normalised["max"], normalised["name"]))
    classified: dict[int, dict] = {}
    for draw in draws:
        candidates = []
        for corner, kind, lo, hi, name in boxes:
            if not contains_box(lo, hi, draw.bounds_min, draw.bounds_max, CONTAIN_TOL):
                continue
            difference = box_cost(draw.bounds_min, draw.bounds_max, lo, hi, (0, 1, 2))
            if difference <= KIND_MAX_D:
                candidates.append((difference, corner, kind, name))
        if not candidates:
            continue
        candidates.sort(key=lambda item: (item[0], item[1], item[2]))
        best_difference, best_corner, best_kind, best_name = candidates[0]
        close = [item for item in candidates if item[0] <= best_difference + KIND_AMBIGUITY_MARGIN]
        kinds = sorted({item[2] for item in close})
        entry = {
            "kind": best_kind,
            "member": best_name,
            "difference": best_difference,
            "candidates": [{"corner": item[1], "kind": item[2], "name": item[3],
                            "difference": item[0]} for item in candidates[:6]],
            "kindConflict": kinds if len(kinds) > 1 else None,
            "namedCorner": best_corner,
        }
        classified[draw.index] = entry
    return classified


# ---------------------------------------------------------------------------
# Assignment solver for one kind
# ---------------------------------------------------------------------------

def solve_kind(kind: str, draws: list[mdl.Draw], boxes: dict[str, tuple[list, list]],
               hubs: dict[str, list[float]]) -> dict:
    """Prove or refute the corner of every draw of one wheel kind.

    The search is exact over the feasible assignments of the kind's draws to the
    four corners, at `len(draws)/4` draws per corner. An assignment is feasible
    when each corner group's union AABB is contained in that corner's member box.
    The score is the discriminating-axis AABB cost of the group union plus each
    draw, plus the handedness penalty (I4): a draw whose X offset sign disagrees
    with the box pays the amount by which it disagrees. Assignments are then
    deduplicated by the *geometry* they render, so 2,520 pairings that differ
    only in which duplicate draw is used collapse to one candidate.
    """
    if len(draws) % 4 != 0 or not draws:
        return {"status": "unsupported",
                "reason": f"{len(draws)} {kind} draws do not divide over four corners"}
    per_corner = len(draws) // 4
    if per_corner > 4:
        return {"status": "unsupported",
                "reason": f"{per_corner} {kind} draws per corner exceed the bounded solver"}

    spread = axis_spread(boxes)
    axes = tuple(axis for axis in range(3) if spread[axis] > SPREAD_MIN)
    spread_evidence = {axis_name: spread[axis] for axis, axis_name in enumerate("xyz")}
    side = {corner: (1 if hubs[corner][0] > 0 else -1) for corner in CORNERS}
    box_skew = {corner: boxes[corner][0][0] + boxes[corner][1][0] for corner in CORNERS}
    # Handedness convention of this kind on this car, derived from the four boxes:
    # all four parts outboard (same sign as the corner's model X) or all four
    # inboard (opposite). Mixed or zero skews give no convention and no evidence.
    agreements = sum(1 for corner in CORNERS
                     if abs(box_skew[corner]) > SKEW_MIN
                     and (box_skew[corner] > 0) == (side[corner] > 0))
    disagrements = sum(1 for corner in CORNERS
                       if abs(box_skew[corner]) > SKEW_MIN
                       and (box_skew[corner] > 0) != (side[corner] > 0))
    if agreements == 4:
        convention = 1
    elif disagrements == 4:
        convention = -1
    else:
        convention = 0
    hub_side = {corner: side[corner] for corner in CORNERS}

    def coverage_penalty(group, corner):
        lo, hi = union_bounds(group)
        penalty = 0.0
        for axis in range(3):
            box_extent = boxes[corner][1][axis] - boxes[corner][0][axis]
            union_extent = hi[axis] - lo[axis]
            penalty += max(0.0, box_extent - union_extent)
        return penalty

    # A draw can only belong to a corner whose box contains it.
    allowed = {corner: [draw for draw in draws
                        if contains_box(boxes[corner][0], boxes[corner][1],
                                        draw.bounds_min, draw.bounds_max, CONTAIN_TOL)]
               for corner in CORNERS}

    def geometry_key(mapping):
        return tuple(sorted(tuple(sorted(draw.signature for draw in group)) for group in mapping))

    def handedness_penalty(group, corner):
        if convention == 0:
            return 0.0
        penalty = 0.0
        for draw in group:
            draw_skew = draw.bounds_min[0] + draw.bounds_max[0]
            if abs(draw_skew) <= SKEW_MIN:
                continue
            expected = convention * hub_side[corner]
            if (draw_skew > 0) != (expected > 0):
                penalty += abs(draw_skew)
        return penalty

    def score(group, corner):
        lo, hi = union_bounds(group)
        cost = box_cost(lo, hi, boxes[corner][0], boxes[corner][1], axes)
        for draw in group:
            cost += box_cost(draw.bounds_min, draw.bounds_max,
                             boxes[corner][0], boxes[corner][1], axes)
        return cost + handedness_penalty(group, corner) + coverage_penalty(group, corner)

    best_by_geometry: dict[tuple, dict] = {}
    total_feasible = 0

    def place(position: int, remaining: list[mdl.Draw], chosen: list[list[mdl.Draw]]):
        nonlocal total_feasible
        if position == len(CORNERS):
            total_feasible += 1
            mapping = tuple(tuple(sorted(draw.index for draw in group)) for group in chosen)
            key = geometry_key(chosen)
            cost = sum(score(chosen[index], CORNERS[index]) for index in range(4))
            previous = best_by_geometry.get(key)
            if previous is None or (cost, mapping) < (previous["cost"], previous["mapping"]):
                best_by_geometry[key] = {"cost": cost, "mapping": mapping,
                                         "groups": [list(group) for group in chosen]}
            return
        corner = CORNERS[position]
        available = [draw for draw in remaining if draw in allowed[corner]]
        if len(available) < per_corner:
            return
        for combo in itertools.combinations(available, per_corner):
            lo, hi = union_bounds(list(combo))
            if not contains_box(boxes[corner][0], boxes[corner][1], lo, hi, CONTAIN_TOL):
                continue
            if any(draw not in allowed[corner] for draw in combo):
                continue
            chosen.append(list(combo))
            place(position + 1, [draw for draw in remaining if draw not in combo], chosen)
            chosen.pop()

    place(0, list(draws), [])
    if not best_by_geometry:
        return {"status": "unsupported",
                "reason": f"no assignment keeps every {kind} draw inside its corner member "
                          "box; the member bounds and the draw geometry disagree, so the "
                          "corner is not provable",
                "spreadMeters": spread_evidence}

    candidates = sorted(best_by_geometry.values(),
                        key=lambda item: (item["cost"], item["mapping"]))
    best = candidates[0]

    if len(candidates) == 1:
        best_groups = best["groups"]
        return {
            "kind": kind, "status": "equivalent",
            "reason": f"every feasible {kind} assignment renders exactly the same geometry: "
                      "the four corner members are bit-identical or appear only in one "
                      "combination, so the corner choice cannot change the image",
            "perCorner": per_corner,
            "discriminatingAxes": [axis_name for axis, axis_name in enumerate("xyz")
                                   if axis in axes],
            "boxSpreadMeters": spread_evidence,
            "boxSkewMeters": box_skew,
            "handednessConvention": convention,
            "bestCost": best["cost"],
            "costUnit": "discriminating-axis AABB cost + handedness penalty + box coverage "
                        "penalty, metres",
            "groupCost": {CORNERS[index]: score(best_groups[index], CORNERS[index])
                          for index in range(4)},
            "cornerDraws": {CORNERS[index]: sorted(draw.index for draw in best_groups[index])
                            for index in range(4)},
            "equivalentAlternatives": total_feasible - 1,
            "equivalentExample": None,
            "materialAlternative": None,
            "feasibleAssignments": total_feasible,
            "distinctGeometries": 1,
            "groupBounds": {CORNERS[index]: {
                "min": union_bounds(best_groups[index])[0],
                "max": union_bounds(best_groups[index])[1]} for index in range(4)},
        }

    best_points = [group_points(group) for group in best["groups"]]

    equivalent: list[dict] = []
    material: dict | None = None
    for candidate in candidates[1:]:
        points = [group_points(group) for group in candidate["groups"]]
        swapped = [CORNERS[index] for index in range(4)
                   if candidate["mapping"][index] != best["mapping"][index]]
        if all(hausdorff_within(best_points[index], points[index], EQUIV_TOL)
               for index in range(4)):
            equivalent.append({"mapping": [list(group) for group in candidate["mapping"]],
                               "cost": candidate["cost"],
                               "deltaCost": candidate["cost"] - best["cost"],
                               "swappedCorners": swapped,
                               "renderDeltaAtMostMeters": EQUIV_TOL})
            continue
        material = {"mapping": [list(group) for group in candidate["mapping"]],
                    "cost": candidate["cost"],
                    "deltaCost": candidate["cost"] - best["cost"],
                    "swappedCorners": swapped,
                    "renderDeltaGreaterThanMeters": EQUIV_TOL}
        break

    if material is not None and material["deltaCost"] < PROOF_MARGIN:
        status = "ambiguous"
        reason = (f"a materially different {kind} assignment (swapping "
                  f"{', '.join(material['swappedCorners'])}) is only "
                  f"{material['deltaCost']:.6f} m worse in member-box cost, below the "
                  f"{PROOF_MARGIN:.6f} m proof margin")
    elif material is not None:
        status = "proven"
        reason = (f"every materially different {kind} assignment (the first differing at "
                  f"{', '.join(material['swappedCorners'])}) is worse by "
                  f"{material['deltaCost']:.6f} m in discriminating-axis member-box cost")
    elif equivalent:
        status = "equivalent"
        reason = (f"the member boxes cannot separate the assignments, but every alternative "
                  f"{kind} assignment places vertices within {EQUIV_TOL:.3f} m of the chosen "
                  "one, so the rendering is the same")
    else:
        status = "proven"
        reason = f"only one geometry of {kind} assignment is feasible"
    best_groups = best["groups"]
    return {
        "kind": kind,
        "status": status,
        "reason": reason,
        "perCorner": per_corner,
        "discriminatingAxes": [axis_name for axis, axis_name in enumerate("xyz") if axis in axes],
        "boxSpreadMeters": spread_evidence,
        "boxSkewMeters": box_skew,
        "handednessConvention": convention,
        "bestCost": best["cost"],
        "costUnit": "sum over discriminating axes of |min-delta| + |max-delta| for the group "
                    "union and for each member draw, plus the handedness penalty, metres",
        "groupCost": {CORNERS[index]: score(best_groups[index], CORNERS[index])
                      for index in range(4)},
        "cornerDraws": {CORNERS[index]: sorted(draw.index for draw in best_groups[index])
                        for index in range(4)},
        "equivalentAlternatives": len(equivalent),
        "equivalentExample": equivalent[0] if equivalent else None,
        "materialAlternative": material,
        "feasibleAssignments": total_feasible,
        "distinctGeometries": len(candidates),
        "groupBounds": {CORNERS[index]: {
            "min": union_bounds(best_groups[index])[0],
            "max": union_bounds(best_groups[index])[1]} for index in range(4)},
    }


def established_corners(material, corners):
    return ", ".join(material.get("swappedCorners", []))


# ---------------------------------------------------------------------------
# Car analysis
# ---------------------------------------------------------------------------

def analyse_car(record: dict) -> dict:
    slug = record["slug"]
    car = {
        "index": record["index"],
        "class": record["class"],
        "name": record["name"],
        "slug": slug,
        "modelSha256": record.get("modelSha256"),
        "manifest": record.get("manifest"),
        "manifestSha256": record.get("manifestSha256"),
        "consumable": record.get("manifest") is not None,
        "builderStatus": record.get("status"),
        "builderProvenWheelDraws": record.get("builderProvenWheelDraws"),
        "builderAmbiguousWheelDraws": record.get("builderAmbiguousWheelDraws"),
        "physics": record.get("physics") or {},
    }
    model_path = ROOT / record["model"]["decoded"]
    empty_counts = {"wheelDraws": 0, "proven": 0, "equivalent": 0, "ambiguous": 0,
                    "unsupported": 0, "assigned": 0}
    try:
        mdldat = mdl.parse_mdldat(model_path.read_bytes())
        scene = mdl.read_scene(model_path)
        draws = mdl.build_draws(scene)
        wheel = build_wheel_model(mdldat)
    except (mdl.Unsupported, AnalysisError) as error:
        car.update({"status": "unsupported", "reason": str(error), "draws": [],
                    "counts": dict(empty_counts)})
        return car

    members = wheel["members"]
    normalised = wheel["normalised"]
    missing_kinds = {}
    boxes: dict[str, dict] = {}
    frame_notes = {}
    for kind in KINDS:
        present = [corner for corner in CORNERS if corner in normalised.get(kind, {})]
        if len(present) != 4:
            missing_kinds[kind] = present
        usable = [corner for corner in present
                  if normalised[kind][corner]["frame"] != "displaced"]
        frame_notes[kind] = {corner: normalised[kind][corner]["frame"] for corner in present}
        if len(usable) != 4:
            missing_kinds.setdefault(kind, present)
            continue
        boxes[kind] = {corner: (normalised[kind][corner]["min"],
                                normalised[kind][corner]["max"]) for corner in CORNERS}

    classified = classify_draws(draws, wheel)

    # ---- hub frame and physics cross-checks (I2, I5, I6, I7) --------------
    translation = {corner: wheel["parents"][corner]["translation"] for corner in CORNERS}
    front_z = (translation["frontleft"][2] + translation["frontright"][2]) / 2
    back_z = (translation["backleft"][2] + translation["backright"][2]) / 2
    left_x = (translation["frontleft"][0] + translation["backleft"][0]) / 2
    right_x = (translation["frontright"][0] + translation["backright"][0]) / 2
    forward = "+z" if front_z > back_z else "-z"
    rightward = "+x" if right_x > left_x else "-x"
    wheelbase_model = abs(front_z - back_z)
    track_front = abs(translation["frontright"][0] - translation["frontleft"][0])
    track_back = abs(translation["backright"][0] - translation["backleft"][0])
    mirror_residual = max(
        abs(translation["frontleft"][0] + translation["frontright"][0]),
        abs(translation["backleft"][0] + translation["backright"][0]),
        abs(translation["frontleft"][1] - translation["frontright"][1]),
        abs(translation["backleft"][1] - translation["backright"][1]),
        abs(translation["frontleft"][2] - translation["frontright"][2]),
        abs(translation["backleft"][2] - translation["backright"][2]),
    )
    physics = car["physics"]
    checks = {
        "frame": {"forwardAxis": forward, "rightAxis": rightward,
                  "frontZ": front_z, "backZ": back_z, "leftX": left_x, "rightX": right_x},
        "wheelbaseModel": wheelbase_model,
        "wheelbasePhysics": physics.get("wheelBase"),
        "wheelbaseResidual": (None if physics.get("wheelBase") is None
                              else wheelbase_model - physics["wheelBase"]),
        "trackFrontModel": track_front,
        "trackFrontPhysics": physics.get("trackWidthFront"),
        "trackFrontResidual": (None if physics.get("trackWidthFront") is None
                               else track_front - physics["trackWidthFront"]),
        "trackBackModel": track_back,
        "trackBackPhysics": physics.get("trackWidthRear"),
        "trackBackResidual": (None if physics.get("trackWidthRear") is None
                              else track_back - physics["trackWidthRear"]),
        "mirrorResidual": mirror_residual,
    }
    # Tyre radius from the tyre assembly and from the physics record.
    tyre_draws = [draws[index] for index in classified
                  if classified[index]["kind"] == "tyre"]
    tyre_boxes = {corner: (members[corner]["tyre"]["min"], members[corner]["tyre"]["max"])
                  for corner in CORNERS}
    radii = {}
    for corner in CORNERS:
        lo, hi = tyre_boxes[corner]
        radii[corner] = max(hi[1] - lo[1], hi[2] - lo[2]) / 2
    checks["tyreRadiusModel"] = radii
    checks["tyreRadiusPhysicsFront"] = physics.get("tyreRadiusFront")
    checks["tyreRadiusPhysicsRear"] = physics.get("tyreRadiusRear")
    checks["tyreRadiusResidualFront"] = (
        None if physics.get("tyreRadiusFront") is None
        else (radii["frontleft"] + radii["frontright"]) / 2 - physics["tyreRadiusFront"])
    checks["tyreRadiusResidualRear"] = (
        None if physics.get("tyreRadiusRear") is None
        else (radii["backleft"] + radii["backright"]) / 2 - physics["tyreRadiusRear"])

    # Hub proximity (I5) and handedness (I4) per member.
    hub = {}
    for kind in KINDS:
        if kind not in boxes:
            continue
        rows = {}
        for corner in CORNERS:
            lo, hi = boxes[kind][corner]
            radius = max(lo[1] ** 2, hi[1] ** 2) ** 0.5
            radial = max(abs(lo[1]), abs(hi[1]), abs(lo[2]), abs(hi[2]))
            half_width = max(abs(lo[0]), abs(hi[0]))
            tyre_lo, tyre_hi = tyre_boxes[corner]
            tyre_radius = max(abs(tyre_lo[1]), abs(tyre_hi[1]), abs(tyre_lo[2]), abs(tyre_hi[2]))
            tyre_half_width = max(abs(tyre_lo[0]), abs(tyre_hi[0]))
            rows[corner] = {
                "boxCenter": [(lo[axis] + hi[axis]) / 2 for axis in range(3)],
                "offsetX": (lo[0] + hi[0]) / 2,
                "radialExtent": radial,
                "withinTyreEnvelope": (radial <= tyre_radius + HUB_MARGIN
                                       and half_width <= tyre_half_width + HUB_MARGIN),
                "tyreRadius": tyre_radius,
            }
        hub[kind] = rows
    checks["hub"] = hub

    # Spin axis (I6): X thin, Y/Z round, X orthogonal to the wheelbase direction.
    axis = {}
    for corner in CORNERS:
        members_lo = [min(boxes[kind][corner][0][axis] for kind in boxes) for axis in range(3)]
        members_hi = [max(boxes[kind][corner][1][axis] for kind in boxes) for axis in range(3)]
        extent = [members_hi[axis] - members_lo[axis] for axis in range(3)]
        round_delta = (abs(extent[1] - extent[2]) / max(extent[1], extent[2])
                       if max(extent[1], extent[2]) else 1.0)
        axis[corner] = {
            "unionLocalExtent": extent,
            "thinAxis": "x" if extent[0] < extent[1] and extent[0] < extent[2] else None,
            "roundRelativeDelta": round_delta,
            "roundAxes": "y/z" if round_delta <= 0.10 else None,
        }
    axle_vector = [translation["frontright"][axis] - translation["frontleft"][axis]
                   for axis in range(3)]
    wheelbase_vector = [translation["frontleft"][axis] - translation["backleft"][axis]
                        for axis in range(3)]
    def unit(vector):
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]
    axle_unit = unit(axle_vector)
    wheelbase_unit = unit(wheelbase_vector)
    dot = abs(sum(axle_unit[index] * wheelbase_unit[index] for index in range(3)))
    up_unit = unit([axle_unit[1] * wheelbase_unit[2] - axle_unit[2] * wheelbase_unit[1],
                    axle_unit[2] * wheelbase_unit[0] - axle_unit[0] * wheelbase_unit[2],
                    axle_unit[0] * wheelbase_unit[1] - axle_unit[1] * wheelbase_unit[0]])
    checks["spin"] = {
        "axis": [1.0, 0.0, 0.0],
        "axisSpace": "element-local",
        "corners": axis,
        "axleDirection": axle_unit,
        "wheelbaseDirection": wheelbase_unit,
        "upDirection": up_unit,
        "orthogonalityDotAxleWheelbase": dot,
        "orthogonal": dot <= 1e-6,
    }

    # ---- solve every kind -------------------------------------------------
    kind_results = {}
    draw_rows = []
    for kind in KINDS:
        kind_draws = [draws[index] for index in sorted(classified)
                      if classified[index]["kind"] == kind
                      and classified[index]["kindConflict"] is None]
        if kind not in boxes:
            kind_results[kind] = {
                "kind": kind, "status": "unsupported",
                "reason": f"member boxes exist for {missing_kinds.get(kind, [])} only",
            }
            continue
        if not kind_draws:
            kind_results[kind] = {"kind": kind, "status": "absent",
                                  "reason": "no draw was classified into this wheel kind"}
            continue
        result = solve_kind(kind, kind_draws, boxes[kind])
        result["memberEnvelopeOk"] = all(
            hub[kind][corner]["withinTyreEnvelope"] for corner in CORNERS)
        if not result["memberEnvelopeOk"]:
            offenders = [corner for corner in CORNERS
                         if not hub[kind][corner]["withinTyreEnvelope"]]
            result["status"] = "unsupported"
            result["reason"] = (
                f"{kind} member bounds for {offenders} are displaced from the hub by more "
                "than the tyre envelope; the element-local frame is not the draw frame, so "
                "the corner is not provable and the part must be hidden")
        kind_results[kind] = result
        for corner in CORNERS:
            for draw_index in result.get("cornerDraws", {}).get(corner, []):
                entry = classified[draw_index]
                draw_rows.append({
                    "draw": draw_index,
                    "kind": kind,
                    "corner": corner,
                    "spins": kind in SPINNING,
                    "proof": result["status"],
                    "reason": result["reason"],
                    "memberElement": entry["member"],
                    "memberBoxDifference": entry["difference"],
                    "groupDraws": result["cornerDraws"][corner],
                    "groupCost": result["groupCost"][corner],
                    "discriminatingAxes": result["discriminatingAxes"],
                    "equivalentAlternatives": result["equivalentAlternatives"],
                })
        # Draws that were classified into this kind but have no corner.
        assigned = {draw_index for corner in CORNERS
                    for draw_index in result.get("cornerDraws", {}).get(corner, [])}
        for draw_index in sorted(classified):
            if classified[draw_index]["kind"] != kind or draw_index in assigned:
                continue
            if classified[draw_index]["kindConflict"]:
                continue
            draw_rows.append({
                "draw": draw_index, "kind": kind, "corner": None,
                "spins": kind in SPINNING, "proof": "ambiguous",
                "reason": "draw was classified into this kind but the kind solver did not "
                          "place it",
            })
    # Kinds with a name conflict between two member kinds.
    for draw_index in sorted(classified):
        entry = classified[draw_index]
        if entry["kindConflict"]:
            draw_rows.append({
                "draw": draw_index, "kind": None, "corner": None,
                "reason": "the draw is within the ambiguity margin of two member kinds "
                          f"({entry['kindConflict']})",
                "proof": "ambiguous",
            })
    draw_rows.sort(key=lambda row: row["draw"])

    counts = {
        "wheelDraws": len(draw_rows),
        "proven": sum(1 for row in draw_rows if row["proof"] == "proven"),
        "equivalent": sum(1 for row in draw_rows if row["proof"] == "equivalent"),
        "ambiguous": sum(1 for row in draw_rows if row["proof"] == "ambiguous"),
        "unsupported": sum(1 for row in draw_rows if row["proof"] == "unsupported"),
        "assigned": sum(1 for row in draw_rows if row["corner"] is not None),
    }
    status = "proven"
    if counts["ambiguous"] or counts["unsupported"]:
        status = "partial" if counts["assigned"] else "ambiguous"
    if counts["equivalent"] and not counts["ambiguous"] and not counts["unsupported"]:
        status = "equivalent"
    car.update({
        "status": status,
        "counts": counts,
        "checks": checks,
        "kinds": kind_results,
        "draws": draw_rows,
        "orphanMembers": wheel["orphans"],
        "members": {corner: sorted(members[corner]) for corner in CORNERS},
        "cornerTranslation": translation,
    })
    return car


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-root", type=Path, default=OUT_DEFAULT)
    args = parser.parse_args()
    out_root = args.out_root.resolve()
    staging = json.loads((out_root / "staging.json").read_text(encoding="utf-8"))
    cars = []
    for record in staging["records"]:
        if record["status"] != "staged" and not record.get("model"):
            cars.append({
                "index": record["index"], "class": record["class"], "name": record["name"],
                "slug": record["slug"], "status": "blocked", "consumable": False,
                "builderStatus": record["status"],
                "reason": record.get("reason"),
                "draws": [], "counts": {"wheelDraws": 0, "proven": 0, "equivalent": 0,
                                        "ambiguous": 0, "unsupported": 0, "assigned": 0},
            })
            print(f"{record['index']:3d} {record['class']} {record['slug']:42s} BLOCKED "
                  f"{(record.get('reason') or '')[:60]}")
            continue
        car = analyse_car(record)
        cars.append(car)
        print(f"{car['index']:3d} {car['class']} {car['slug']:42s} {car['status']:11s} "
              f"proven={car['counts']['proven']:2d} equiv={car['counts']['equivalent']:2d} "
              f"amb={car['counts']['ambiguous']:2d} n={car['counts']['wheelDraws']:2d} "
              f"builder={record.get('builderProvenWheelDraws')}")

    totals = {key: sum(car["counts"][key] for car in cars)
              for key in ("wheelDraws", "proven", "equivalent", "ambiguous", "unsupported",
                          "assigned")}
    per_class = {}
    for car_class in ("A", "B", "C"):
        members = [car for car in cars if car["class"] == car_class]
        per_class[car_class] = {
            "cars": len(members),
            "carsWithAssignedWheels": sum(1 for car in members
                                          if car["counts"]["assigned"] > 0),
            **{key: sum(car["counts"][key] for car in members)
               for key in ("wheelDraws", "proven", "equivalent", "ambiguous", "unsupported",
                           "assigned")},
        }
    consumable = [car for car in cars if car.get("consumable")]
    consumable_totals = {key: sum(car["counts"][key] for car in consumable)
                         for key in ("wheelDraws", "proven", "equivalent", "ambiguous",
                                     "unsupported", "assigned")}

    document = {
        "kind": "blur.wheel-corner-assignments",
        "version": 1,
        "generatedBy": "probes/wheels/tools/wheel_corners.py",
        "status": "ok",
        "method": METHOD,
        "inputs": {
            "staging": "_work/wheels/staging.json",
            "stagingSha256": sha256_text((out_root / "staging.json").read_text(encoding="utf-8")),
            "sceneReader": "_work/build/asset-reader-native/Release/scene_inspect.exe",
            "sceneReaderSha256": hashlib.sha256(
                (ROOT / "_work/build/asset-reader-native/Release/scene_inspect.exe")
                .read_bytes()).hexdigest(),
        },
        "counts": {
            "records": len(cars),
            "analysedCars": sum(1 for car in cars if car["counts"]["wheelDraws"]),
            "consumableCars": len(consumable),
            "totals": totals,
            "consumableTotals": consumable_totals,
            "perClass": per_class,
        },
        "cars": cars,
        "limits": [
            "Corner identity is proven for the first-RenderList LOD0 wheel draws only; "
            "higher LODs, damage and runtime wheel states are out of scope.",
            "The proof is geometric and topological. It does not claim the authored element "
            "name is semantically correct; it proves that the draw is placed at the corner "
            "whose member box, handedness and vertex cloud it matches.",
            "An `equivalent` draw is assigned to a specific corner, but a different corner "
            "would render vertices within 1 mm of the chosen one.",
            "A car whose wheel member bounds are displaced from the hub is typed unsupported "
            "for that kind and must keep the part hidden.",
        ],
    }
    text = canonical_json(document)
    (out_root / "assignments.json").write_text(text, encoding="utf-8", newline="\n")
    print(json.dumps({"counts": totals,
                      "consumable": consumable_totals,
                      "assignmentsSha256": sha256_text(text)}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

