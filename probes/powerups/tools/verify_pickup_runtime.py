"""Independent verifier for the PWR6 runtime pickup placement manifests.

Deliberately does **not** import the builder's `xt_decode`. It re-reads the PAK
entries, validates the FLSK tables with the committed reference parser
(`tools/prepare_xt_fixture.inspect`), decodes every field with the second
direct-offset reader from `verify_pickup_placement.py`, and then:

  * re-reads every documented byte offset from the raw actorpack bytes;
  * recomputes the measured-path projection, signed lateral offset and yaw;
  * recomputes ground-below / surface-above / steep-wall clearances against the
    committed collision mesh with a different point/triangle formula;
  * recomputes the draw-geometry clearance from the committed draw buffers;
  * recomputes every reachability status, flag and exclusion;
  * recomputes groups, duplicates, counts and the runtime sets;
  * rebuilds the manifest twice with the builder and requires byte identity.

Usage:
    python probes/powerups/tools/verify_pickup_runtime.py --level usa_amboy
    python probes/powerups/tools/verify_pickup_runtime.py --level spa_barcelona_gracia

Output: `_work/powerups/runtime-<key>.verify.json`.
"""
from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import struct
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "powerups" / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "map-pipeline" / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402
from verify_pickup_placement import DirectFlask, close, decode_entry, sha256  # noqa: E402
import physics_scan  # noqa: E402

PACK = ROOT / "game-data/Blur/cache/gamedata.pak"
OUT_DIR = ROOT / "_work/powerups"
LAYOUT_KEYS = {"usa_amboy": "amboy", "spa_barcelona_gracia": "gracia"}

CHECKS = []
FAILURES = []


def check(name, ok, detail=None):
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})
    if not ok:
        FAILURES.append({"name": name, "detail": detail})


# ------------------------------------------------------------------ geometry
def normal_of(a, b, c):
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx = uy * vz - uz * vy
    ny = uz * vx - ux * vz
    nz = ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    if length < 1e-12:
        return None
    return (nx / length, ny / length, nz / length)


def segment_distance(p, a, b):
    abx, aby, abz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    apx, apy, apz = p[0] - a[0], p[1] - a[1], p[2] - a[2]
    denom = abx * abx + aby * aby + abz * abz
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (apx * abx + apy * aby + apz * abz) / denom))
    qx, qy, qz = a[0] + t * abx, a[1] + t * aby, a[2] + t * abz
    return math.sqrt((p[0] - qx) ** 2 + (p[1] - qy) ** 2 + (p[2] - qz) ** 2)


def triangle_distance(p, a, b, c, normal):
    """Project onto the plane; if inside, use the plane distance, else edges.

    This is a different formulation from the builder's Ericson routine; both are
    exact for non-degenerate triangles.
    """
    d = (p[0] - a[0]) * normal[0] + (p[1] - a[1]) * normal[1] + (p[2] - a[2]) * normal[2]
    q = (p[0] - normal[0] * d, p[1] - normal[1] * d, p[2] - normal[2] * d)
    # barycentric containment in the triangle's plane
    v0 = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    v1 = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    v2 = (q[0] - a[0], q[1] - a[1], q[2] - a[2])
    d00 = v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2]
    d01 = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2]
    d11 = v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2]
    d20 = v2[0] * v0[0] + v2[1] * v0[1] + v2[2] * v0[2]
    d21 = v2[0] * v1[0] + v2[1] * v1[1] + v2[2] * v1[2]
    denom = d00 * d11 - d01 * d01
    if abs(denom) < 1e-15:
        return min(segment_distance(p, a, b), segment_distance(p, b, c),
                   segment_distance(p, c, a))
    v = (d11 * d20 - d01 * d21) / denom
    w = (d00 * d21 - d01 * d20) / denom
    if v >= -1e-9 and w >= -1e-9 and v + w <= 1.0 + 1e-9:
        return abs(d)
    return min(segment_distance(p, a, b), segment_distance(p, b, c),
               segment_distance(p, c, a))


def barycentric_y(a, b, c, x, z):
    ax, az = a[0], a[2]
    bx, bz = b[0], b[2]
    cx, cz = c[0], c[2]
    det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
    if abs(det) < 1e-12:
        return None
    u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det
    v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det
    w = 1.0 - u - v
    if u < -1e-9 or v < -1e-9 or w < -1e-9:
        return None
    return u * a[1] + v * b[1] + w * c[1]


class Grid:
    def __init__(self, triangles, cell=4.0):
        self.cell = cell
        self.triangles = triangles
        self.cells = {}
        for index, tri in enumerate(triangles):
            xs = (tri[0][0], tri[1][0], tri[2][0])
            zs = (tri[0][2], tri[1][2], tri[2][2])
            x0 = math.floor(min(xs) / cell)
            x1 = math.floor(max(xs) / cell)
            z0 = math.floor(min(zs) / cell)
            z1 = math.floor(max(zs) / cell)
            for cx in range(x0, x1 + 1):
                for cz in range(z0, z1 + 1):
                    self.cells.setdefault((cx, cz), []).append(index)

    def at(self, x, z):
        return self.cells.get((math.floor(x / self.cell), math.floor(z / self.cell)), [])

    def near(self, x, z, radius):
        cells = int(math.ceil(radius / self.cell)) + 1
        cx = math.floor(x / self.cell)
        cz = math.floor(z / self.cell)
        seen = set()
        out = []
        for ix in range(cx - cells, cx + cells + 1):
            for iz in range(cz - cells, cz + cells + 1):
                for index in self.cells.get((ix, iz), ()):
                    if index not in seen:
                        seen.add(index)
                        out.append(index)
        return out


def read_f32(path):
    data = array.array("f")
    data.frombytes(path.read_bytes())
    if sys.byteorder == "big":
        data.byteswap()
    return data


def read_u32(path):
    data = array.array("I")
    data.frombytes(path.read_bytes())
    if sys.byteorder == "big":
        data.byteswap()
    return data


def project(poly, x, z):
    best = None
    arc = 0.0
    for i in range(len(poly) - 1):
        ax, az = poly[i]
        bx, bz = poly[i + 1]
        dx, dz = bx - ax, bz - az
        length2 = dx * dx + dz * dz
        t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / length2))
        qx, qz = ax + t * dx, az + t * dz
        distance = math.hypot(x - qx, z - qz)
        if best is None or distance < best["distance"]:
            length = math.sqrt(length2)
            tx, tz = (dx / length, dz / length) if length else (0.0, 0.0)
            best = {"distance": distance, "arc": arc + t * length,
                    "point": [qx, qz], "segment": i,
                    "tangent": [tx, tz],
                    "tangentYawRadians": math.atan2(tx, tz),
                    "signedCross2d": tx * (z - qz) - tz * (x - qx)}
        arc += math.sqrt(length2)
    return best


def normalize_angle(value):
    while value <= -math.pi:
        value += 2.0 * math.pi
    while value > math.pi:
        value -= 2.0 * math.pi
    return value


def label_of(value):
    return value.get("label") if isinstance(value, dict) else value


def bits_of(value):
    return value.get("bits") if isinstance(value, dict) else value


def mask_types(bits, labels, mapping):
    return sorted(mapping[name] for index, name in enumerate(labels)
                  if bits & (1 << index))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--level", required=True)
    parser.add_argument("--layout")
    parser.add_argument("--manifest")
    parser.add_argument("--out")
    args = parser.parse_args()

    level = args.level
    layout_key = args.layout or LAYOUT_KEYS.get(level, level)
    layout_path = ROOT / f"_work/e1-drive/{layout_key}/layout.json"
    level_physics = ROOT / f"game-data/Blur/levels/{level}/Level.levelphysics"
    draw_package = ROOT / f"_work/map-slice/{layout_key}"
    manifest_path = Path(args.manifest) if args.manifest else OUT_DIR / f"runtime-{layout_key}.json"
    out_path = Path(args.out) if args.out else OUT_DIR / f"runtime-{layout_key}.verify.json"
    actorpack_path = f"\\gamedata\\levels\\{level}\\actorpack.xt"

    doc = json.loads(manifest_path.read_text(encoding="utf-8"))
    thresholds = doc["geometryModel"]["thresholds"]
    pickup_radius = thresholds["pickupRadiusProximityThreshold"]
    near_band = thresholds["nearBandMetres"]
    static_half = thresholds["staticBoxHalfWidthMetres"]
    wall_inside = thresholds["wallInsideMetres"]
    wall_low = thresholds["wallLowMetres"]
    cover_inside = thresholds["coverInsideMetres"]
    cover_low = thresholds["coverLowMetres"]
    visible_overlap = thresholds["visibleOverlapMetres"]
    elevated_ground = thresholds["elevatedGroundMetres"]
    drivable_normal = doc["geometryModel"]["collision"]["drivableNormalY"]

    verifier_path = ROOT / "probes/powerups/tools/verify_pickup_runtime.py"
    check("verifier.sha256",
          doc["verifier"]["sha256"] == sha256(verifier_path.read_bytes()),
          {"documented": doc["verifier"]["sha256"], "actual": sha256(verifier_path.read_bytes())})
    reader_path = ROOT / "probes/powerups/tools/xt_decode.py"
    check("reader.sha256", doc["reader"]["sha256"] == sha256(reader_path.read_bytes()))
    geometry_path = ROOT / "probes/powerups/tools/pickup_runtime_common.py"
    check("reader.geometrySha256",
          doc["reader"]["geometrySha256"] == sha256(geometry_path.read_bytes()))

    index = pak_index(PACK)
    entries = {
        "actorpack": actorpack_path,
        "pickups": "\\gamedata\\xt\\pickups.bin",
        "multiplayer": "\\gamedata\\xt\\multiplayer.bin",
        "amax": "\\gamedata\\xt\\amax.bin",
        "singleplayer": "\\gamedata\\xt\\singleplayer.bin",
    }
    blobs = {}
    for key, path in entries.items():
        entry = next(row for row in index["entries"] if row["path"] == path)
        data = decode_entry(entry)
        blobs[key] = data
        source = doc["sources"][key]
        check(f"source.{key}.sha256", sha256(data) == source["sha256"],
              {"expected": source["sha256"], "actual": sha256(data)})
        check(f"source.{key}.extent",
              entry["offset"] == source["pakOffset"]
              and entry["stored_bytes"] == source["storedBytes"]
              and entry["logical_bytes"] == source["logicalBytes"])

    actor = DirectFlask(blobs["actorpack"])
    pickups = DirectFlask(blobs["pickups"])
    multiplayer = DirectFlask(blobs["multiplayer"])
    amax = DirectFlask(blobs["amax"])

    # ---------------------------------------------------------- type table
    system_records = pickups.record_of_type("PickupSystem")
    check("pickupSystem.records", len(system_records) == 1, len(system_records))
    system = pickups.read_struct(system_records[0]["index"],
                                 pickups.type_index("PickupSystem"), 0)
    pickup_type_index = pickups.type_index("PickupType")
    raw_types = []
    for item in system["Types"]["items"]:
        enum = pickups.read_field_by_name(item["record"], pickup_type_index, "Type")
        raw_types.append({"refId": item["refId"], "label": enum["label"]})
    documented = doc["typeTable"]["order"]
    check("typeTable.ids", [item["refId"] for item in raw_types]
          == [item["refId"] for item in documented])
    check("typeTable.names", [item["label"] for item in raw_types]
          == [item["name"] for item in documented])
    mp_types = {item["refId"]: item["name"] for item in doc["typeTable"]["multiplayerTypes"]}
    check("typeTable.mpCount", len(mp_types) == 8, mp_types)
    not_placed = {item["refId"] for item in doc["typeTable"]["notPlacedByDefault"]}
    check("typeTable.noOverlap", not (set(mp_types) & not_placed))
    check("typeTable.superShieldNotMp", 3093073274 not in mp_types)

    # rows
    row_records = pickups.record_of_type("PickupPositionRow")
    row_type_index = pickups.type_index("PickupPositionRow")
    rows = {}
    for entry in row_records:
        flags = pickups.read_field_by_name(entry["index"], row_type_index, "TypeList")
        rows[str(entry["id"])] = {"bits": flags["bits"], "types": flags["labels"]}
    check("rowTable.count", len(rows) > 0)

    # ------------------------------------------------ multiplayer mask labels
    race_type = multiplayer.type_index("MultiplayerRace")
    mask_field = next(field for field in multiplayer.all_fields(race_type)
                      if field["name"] == "powerups")
    mask_labels = [multiplayer.fields[row]["name"] for row in range(
        multiplayer.types[mask_field["typeIndex"]]["fieldStart"],
        multiplayer.types[mask_field["typeIndex"]]["fieldStart"]
        + multiplayer.types[mask_field["typeIndex"]]["fieldCount"])]
    check("mask.labels", mask_labels == doc["typeTable"]["maskLabels"])
    mapping = doc["typeTable"]["maskLabelToType"]
    check("mask.mapping", sorted(mapping.values()) == sorted(mp_types.values()))
    respawn_field = next(field for field in multiplayer.all_fields(race_type)
                         if field["name"] == "poweruprespawn")
    respawn_labels = [multiplayer.fields[row]["name"] for row in range(
        multiplayer.types[respawn_field["typeIndex"]]["fieldStart"],
        multiplayer.types[respawn_field["typeIndex"]]["fieldStart"]
        + multiplayer.types[respawn_field["typeIndex"]]["fieldCount"])]
    check("respawn.labels", respawn_labels == doc["typeTable"]["respawnLabels"])

    # ------------------------------------------------ course inputs / constants
    layout_data = json.loads(layout_path.read_text(encoding="utf-8"))
    samples = layout_data["course"]["samples"]
    measured = [(sample["x"], sample["z"]) for sample in samples]
    layout_samples = [{"arc": sample["arc"], "x": sample["x"], "z": sample["z"],
                       "groundY": sample.get("groundY"), "index": i}
                      for i, sample in enumerate(samples)]
    check("courseInputs.layout.sha256",
          sha256(layout_path.read_bytes()) == doc["courseInputs"]["measuredLayout"]["sha256"])
    check("courseInputs.layout.length",
          layout_data["course"]["lengthMetres"]
          == doc["courseInputs"]["measuredLayout"]["lengthMetres"])
    check("courseInputs.layout.samples",
          len(samples) == doc["courseInputs"]["measuredLayout"]["sampleCount"])
    check("courseInputs.layout.hash",
          layout_data.get("hash") == doc["courseInputs"]["measuredLayout"]["layoutHash"])
    check("courseInputs.physics.sha256",
          sha256(level_physics.read_bytes()) == doc["courseInputs"]["levelphysics"]["sha256"])
    for name in ("positions", "indices"):
        path = ROOT / doc["courseInputs"]["drawBuffers"][name]["path"]
        check(f"courseInputs.draw.{name}.sha256",
              sha256(path.read_bytes()) == doc["courseInputs"]["drawBuffers"][name]["sha256"])
        check(f"courseInputs.draw.{name}.bytes",
              path.stat().st_size == doc["courseInputs"]["drawBuffers"][name]["bytes"])

    constants = doc["courseInputs"]["powerupsManifest"]
    check("constants.status", constants["status"] == "found")
    if constants["status"] == "found":
        manifest_path_pwr1 = ROOT / constants["path"]
        check("constants.sha256",
              sha256(manifest_path_pwr1.read_bytes()) == constants["sha256"])
        pwr1 = json.loads(manifest_path_pwr1.read_text(encoding="utf-8"))
        params = pwr1["pickupSystem"]["parameters"]
        check("constants.pickupRadius",
              params["PickupRadius"] == constants["pickupRadiusMetres"] == pickup_radius)
        check("constants.deactivateSeconds",
              params["PickupDeactivateTimer"] == constants["deactivateSeconds"])
        check("constants.long", pwr1["modes"]["config"]["powerupRespawnToggleLong"]
              == constants["longSeconds"])
        check("constants.veryLong", pwr1["modes"]["config"]["powerupRespawnToggleVeryLong"]
              == constants["veryLongSeconds"])
        check("respawn.deactivateDocumented",
              doc["respawnModel"]["riverParity"]["deactivateSeconds"] == constants["deactivateSeconds"])
        check("respawn.normalNull",
              doc["respawnModel"]["riverParity"]["normalSeconds"] is None)

    # ---------------------------------------------------- geometry rebuild
    physics_level = physics_scan.scan_level(level_physics.read_bytes())
    collision_triangles = []
    for a, b, c in physics_scan.flatten_static_triangles(physics_level):
        normal = normal_of(a, b, c)
        if normal is not None:
            collision_triangles.append((a, b, c, normal))
    check("geometry.collisionTriangleCount",
          len(collision_triangles) == doc["geometryModel"]["collision"]["triangleCount"])

    positions = read_f32(draw_package / "draws.positions.f32.bin")
    indices = read_u32(draw_package / "draws.indices.u32.bin")
    draw_triangles = []
    for i in range(0, len(indices), 3):
        a = (positions[indices[i] * 3], positions[indices[i] * 3 + 1], positions[indices[i] * 3 + 2])
        b = (positions[indices[i + 1] * 3], positions[indices[i + 1] * 3 + 1], positions[indices[i + 1] * 3 + 2])
        c = (positions[indices[i + 2] * 3], positions[indices[i + 2] * 3 + 1], positions[indices[i + 2] * 3 + 2])
        normal = normal_of(a, b, c)
        if normal is not None:
            draw_triangles.append((a, b, c, normal))
    check("geometry.drawTriangleCount",
          len(draw_triangles) == doc["courseInputs"]["drawBuffers"]["triangleCount"]
          == doc["geometryModel"]["visible"]["triangleCount"])

    collision_grid = Grid(collision_triangles)
    draw_grid = Grid(draw_triangles)

    def surface_at(position):
        x, y, z = position
        below = above = highest = None
        for index in collision_grid.at(x, z):
            a, b, c, normal = collision_triangles[index]
            height = barycentric_y(a, b, c, x, z)
            if height is None:
                continue
            if normal[1] > 0.1:
                if highest is None or height > highest[0]:
                    highest = (height, normal[1])
                if height <= y + 1e-3 and (below is None or height > below[0]):
                    below = (height, normal[1])
            if height > y + 1e-3 and (above is None or height < above[0]):
                above = (height, None)
        draw_highest = draw_above = None
        for index in draw_grid.at(x, z):
            a, b, c, normal = draw_triangles[index]
            height = barycentric_y(a, b, c, x, z)
            if height is None:
                continue
            if normal[1] > 0.1 and (draw_highest is None or height > draw_highest[0]):
                draw_highest = (height, normal[1])
            if height > y + 1e-3 and (draw_above is None or height < draw_above[0]):
                draw_above = (height, None)
        wall = None
        for index in collision_grid.near(x, z, 12.0):
            a, b, c, normal = collision_triangles[index]
            if abs(normal[1]) > 0.5:
                continue
            distance = triangle_distance((x, y, z), a, b, c, normal)
            if wall is None or distance < wall:
                wall = distance
        if wall is not None and wall > 12.0:
            wall = None
        visible_wall = None
        for index in draw_grid.near(x, z, 12.0):
            a, b, c, normal = draw_triangles[index]
            if abs(normal[1]) > 0.5:
                continue
            distance = triangle_distance((x, y, z), a, b, c, normal)
            if visible_wall is None or distance < visible_wall:
                visible_wall = distance
        if visible_wall is not None and visible_wall > 12.0:
            visible_wall = None
        return {
            "groundBelowY": None if below is None else below[0],
            "groundBelowNormalY": None if below is None else below[1],
            "heightAboveGround": None if below is None else y - below[0],
            "groundBelowPresent": below is not None,
            "highestUpFacingY": None if highest is None else highest[0],
            "highestUpFacingNormalY": None if highest is None else highest[1],
            "heightAboveHighestUpFacing": None if highest is None else y - highest[0],
            "surfacePresent": highest is not None,
            "firstSurfaceAboveY": None if above is None else above[0],
            "coverAboveMetres": None if above is None else above[0] - y,
            "nearestSteepCollisionDistance3d": wall,
            "nearestSteepDrawDistance3d": visible_wall,
            "drawHighestUpFacingY": None if draw_highest is None else draw_highest[0],
            "firstDrawSurfaceAboveY": None if draw_above is None else draw_above[0],
            "drawCoverAboveMetres": None if draw_above is None else draw_above[0] - y,
            "drivableSurface": below is not None and below[1] > drivable_normal,
        }

    def classify(surface, projection):
        reasons = []
        hard = []
        if not surface["groundBelowPresent"]:
            hard.append("no-collision-ground-below")
        if (surface["nearestSteepCollisionDistance3d"] is not None
                and surface["nearestSteepCollisionDistance3d"] < wall_inside):
            hard.append("inside-collision-structure")
        if (surface["coverAboveMetres"] is not None
                and surface["coverAboveMetres"] < cover_inside):
            hard.append("inside-collision-structure")
        if surface["groundBelowPresent"] and not surface["drivableSurface"]:
            reasons.append("non-drivable-surface")
        if (surface["heightAboveGround"] is not None
                and surface["heightAboveGround"] > elevated_ground):
            reasons.append("elevated-above-detected-ground")
        if (surface["nearestSteepCollisionDistance3d"] is not None
                and wall_inside <= surface["nearestSteepCollisionDistance3d"] < wall_low):
            reasons.append("collision-clearance-low")
        if (surface["coverAboveMetres"] is not None
                and cover_inside <= surface["coverAboveMetres"] < cover_low):
            reasons.append("collision-cover-low")
        if (surface["nearestSteepDrawDistance3d"] is not None
                and surface["nearestSteepDrawDistance3d"] < visible_overlap):
            reasons.append("visible-structure-overlap")
        if (surface["drawCoverAboveMetres"] is not None
                and surface["drawCoverAboveMetres"] < visible_overlap):
            reasons.append("inside-visible-structure")
        distance = projection["distance"]
        path_class = ("on-path" if distance <= pickup_radius
                      else "near-path" if distance <= near_band else "off-path")
        if path_class == "off-path":
            reasons.append("off-measured-path")
        status = "exclude" if hard else "flag" if reasons else "spawn"
        return {"pathClass": path_class, "status": status,
                "hardExclusions": hard, "flags": reasons,
                "spawnable": status != "exclude",
                "onMeasuredCourse": status != "exclude"
                and path_class in ("on-path", "near-path"),
                "collectableAtCentreline": status != "exclude" and distance <= static_half,
                "collectableWithOffset": status != "exclude" and distance <= near_band}

    # ------------------------------------------------------- route authority
    def races_for(route_id):
        out = []
        for entry in multiplayer.record_of_type("MultiplayerRace"):
            handle = multiplayer.read_field_by_name(entry["index"], race_type, "route")
            if handle and handle["refId"] == route_id:
                out.append({
                    "recordId": entry["id"],
                    "raceType": label_of(multiplayer.read_field_by_name(
                        entry["index"], race_type, "type")),
                    "laps": multiplayer.read_field_by_name(entry["index"], race_type, "laps"),
                    "powerupsBits": bits_of(multiplayer.read_field_by_name(
                        entry["index"], race_type, "powerups")),
                    "powerupRespawn": label_of(multiplayer.read_field_by_name(
                        entry["index"], race_type, "poweruprespawn")),
                    "randomPowerups": label_of(multiplayer.read_field_by_name(
                        entry["index"], race_type, "randompowerups")),
                })
        return out

    def route_number(record_index):
        return amax.read_field_by_name(record_index, amax.type_index("Route"), "RouteNumber")

    def route_lists(record_index):
        handle = amax.read_field_by_name(record_index, amax.type_index("Route"),
                                         "MultiplayerActorLists")
        return [item["refId"] for item in handle["items"]]

    def route_city(record_index):
        city = amax.read_field_by_name(record_index, amax.type_index("Route"), "City")
        city_index = amax.record_index(city["refId"])
        raw = amax.read_field_by_name(city_index, amax.type_index("City"), "Name")
        return city["refId"], amax.sz8_value(city_index, raw)

    variants = doc["authority"]["variants"]
    recomputed_primary = []
    for variant in variants:
        route_index = amax.record_index(variant["recordId"])
        check(f"variant.{variant['recordId']}.type",
              amax.records[route_index]["typeIndex"] == amax.type_index("Route"))
        check(f"variant.{variant['recordId']}.number",
              route_number(route_index) == variant["routeNumber"])
        city_ref, city_name = route_city(route_index)
        check(f"variant.{variant['recordId']}.cityRef", city_ref == variant["cityRefId"])
        check(f"variant.{variant['recordId']}.cityName", city_name == variant["cityName"])
        lists = route_lists(route_index)
        check(f"variant.{variant['recordId']}.mpLists",
              lists == variant["multiplayerActorLists"])
        races = races_for(variant["recordId"])
        racing = [race for race in races if race["raceType"] == "racing"]
        check(f"variant.{variant['recordId']}.racingCount",
              len(racing) == variant["racingRaceCount"])
        check(f"variant.{variant['recordId']}.raceCount",
              len(races) == variant["multiplayerRaceCount"])
        documented_races = {race["recordId"]: race for race in variant["races"]}
        check(f"variant.{variant['recordId']}.raceRecords",
              sorted(documented_races) == sorted(race["recordId"] for race in races))
        for race in races:
            stored = documented_races.get(race["recordId"])
            check(f"variant.{variant['recordId']}.race.{race['recordId']}",
                  stored is not None
                  and stored["powerupsBits"] == race["powerupsBits"]
                  and stored["powerupRespawn"] == race["powerupRespawn"]
                  and stored["randomPowerups"] == race["randomPowerups"]
                  and stored["laps"] == race["laps"])
        if racing:
            modal_bits = Counter(race["powerupsBits"] for race in racing).most_common()
            check(f"variant.{variant['recordId']}.defaultConfig",
                  variant["defaultRaceConfig"]["powerupsModalBits"] in
                  [bits for bits, _count in modal_bits])
        recomputed_primary.append({"recordId": variant["recordId"],
                                   "racing": len(racing), "total": len(races)})
    recomputed_primary.sort(key=lambda row: (-row["racing"], -row["total"], row["recordId"]))
    check("authority.primaryRule",
          doc["authority"]["primaryRouteRecordId"]
          == (recomputed_primary[0]["recordId"] if recomputed_primary else None))
    check("authority.racedRouteCount",
          len(variants) == doc["authority"]["racedRouteCount"] == len(recomputed_primary))
    check("authority.city",
          doc["authority"]["city"]["name"] == variants[0]["cityName"]
          and doc["authority"]["city"]["refId"] == variants[0]["cityRefId"])

    pickup_type_index_actor = actor.type_index("PickupPosition")
    total_slots = 0
    for variant in variants:
        route_name = variant["recordId"]
        list_id = variant["pickupActorListId"]
        list_record = actor.record_index(list_id)
        check(f"list.{route_name}.record",
              list_record == variant["pickupActorListRecord"])
        check(f"list.{route_name}.type",
              actor.types[actor.records[list_record]["typeIndex"]]["name"] == "LevelActorList")
        components = []
        for relative in range(actor.records[list_record]["componentCount"]):
            type_index, count, behaviour = actor.component_meta(list_record, relative)
            if type_index == pickup_type_index_actor:
                components.append((relative, count, behaviour))
        check(f"list.{route_name}.pickupComponents", len(components) == 1, components)
        component, count, behaviour = components[0]
        check(f"list.{route_name}.count",
              count == variant["placementCount"] == len(variant["slots"]))
        check(f"list.{route_name}.behaviour", behaviour == 0)

        slots = variant["slots"]
        total_slots += len(slots)
        check(f"order.{route_name}",
              [slot["index"] for slot in slots] == list(range(len(slots)))
              and [slot["retailOrder"] for slot in slots] == list(range(len(slots))))
        check(f"order.{route_name}.retail",
              [(slot["component"], slot["element"]) for slot in slots]
              == sorted((slot["component"], slot["element"]) for slot in slots))

        stride = actor.type_size(pickup_type_index_actor)
        schema_fields = {field["name"]: field for field in actor.all_fields(pickup_type_index_actor)}
        for slot in slots:
            uid = slot["uid"]
            tag = f"slot.{route_name}.{uid}"
            decoded = actor.read_component(list_record, slot["component"], slot["element"])
            matrix = decoded["WorldMatrix"]
            position = [matrix["aw"]["vx"], matrix["aw"]["vy"], matrix["aw"]["vz"]]
            basis = {axis: [matrix[axis]["vx"], matrix[axis]["vy"], matrix[axis]["vz"]]
                     for axis in ("ax", "ay", "az")}
            expected_position = [slot["position"]["x"], slot["position"]["y"],
                                 slot["position"]["z"]]
            check(f"{tag}.position", position == expected_position,
                  {"expected": expected_position, "actual": position})
            check(f"{tag}.basis", basis == slot["basis"])
            check(f"{tag}.uid", decoded["SerialisableUid"] == uid)
            check(f"{tag}.name",
                  actor.sz8_value(list_record, decoded["Name"]) == slot["name"])
            check(f"{tag}.typeRef",
                  decoded["PickupType"]["refId"] == slot["serializedType"]["refId"])
            check(f"{tag}.typeName",
                  doc["typeTable"]["byRefId"].get(str(decoded["PickupType"]["refId"]))
                  == slot["serializedType"]["name"])
            check(f"{tag}.mpType",
                  mp_types.get(decoded["PickupType"]["refId"]) == slot["serializedType"]["mpType"])
            check(f"{tag}.rowRef",
                  (decoded["RowType"]["refId"] if decoded["RowType"] else None)
                  == (slot["row"]["refId"] if slot["row"] else None))
            expected_row_id = slot["row"]["id"] if slot["row"] else slot["rowIdRaw"]
            check(f"{tag}.rowId", decoded["RowId"] == expected_row_id)
            check(f"{tag}.rowIdRaw", decoded["RowId"] == slot["rowIdRaw"])
            if slot["row"]:
                check(f"{tag}.groupKey",
                      slot["row"]["shuffleGroup"] == f"{decoded['RowType']['refId']}:{decoded['RowId']}")
                stored_row = rows.get(str(decoded["RowType"]["refId"]))
                check(f"{tag}.rowAllowed",
                      stored_row is not None
                      and slot["row"]["allowedTypes"] == stored_row["types"]
                      and slot["row"]["bits"] == stored_row["bits"])
            else:
                check(f"{tag}.rowAbsent", decoded["RowType"] is None)
            check(f"{tag}.activeLevel",
                  decoded["PickupActiveLevel"] == slot["overrides"]["pickupActiveLevel"])
            check(f"{tag}.rotate",
                  decoded["RotateGraphic"] == slot["overrides"]["rotateGraphic"])
            check(f"{tag}.activationTimer",
                  decoded["ActivationTimer"] == slot["overrides"]["activationTimer"])
            check(f"{tag}.activationLap",
                  decoded["ActivationLap"] == slot["overrides"]["activationLap"])
            check(f"{tag}.respawnOverride",
                  decoded["RespawnTimerOverride"] == slot["overrides"]["respawnTimerOverride"])
            check(f"{tag}.constantShuffle",
                  decoded["ConstantShuffle"] == slot["overrides"]["constantShuffle"])
            check(f"{tag}.shuffleTypes",
                  decoded["ShuffleTypes"]["bits"] == slot["overrides"]["shuffleTypes"]["bits"])
            check(f"{tag}.excluded",
                  [item["refId"] for item in decoded["ExcludedPickupTypes"]["items"]]
                  == slot["overrides"]["excludedPickupTypes"])

            # ---- documented byte offsets read straight from the raw file
            provenance = slot["provenance"]
            record_index = list_record
            element_offset = (actor.records[record_index]["dataOffset"]
                              + actor.component_offset(record_index, slot["component"])
                              + slot["element"] * stride)
            check(f"{tag}.offset.element", provenance["elementOffset"] == element_offset,
                  {"documented": provenance["elementOffset"], "actual": element_offset})
            check(f"{tag}.offset.stride",
                  provenance["elementStrideBytes"] == stride == provenance["elementBytes"])
            check(f"{tag}.offset.recordTable",
                  provenance["recordTableOffset"]
                  == actor.tables["records"]["offset"] + record_index * 16)
            check(f"{tag}.offset.recordData",
                  provenance["recordDataOffset"] == actor.records[record_index]["dataOffset"])
            field_offsets = {name: element_offset + field["offset"]
                             for name, field in schema_fields.items()}
            check(f"{tag}.offset.fields", provenance["fieldOffsets"] == field_offsets)
            matrix_offsets = {}
            for axis, offset in (("ax", 0), ("ay", 12), ("az", 24), ("aw", 36)):
                base = field_offsets["WorldMatrix"] + offset
                matrix_offsets[axis] = {"base": base, "vx": base, "vy": base + 4, "vz": base + 8}
            check(f"{tag}.offset.matrix", provenance["matrixOffsets"] == matrix_offsets)

            raw = actor.raw
            raw_uid = struct.unpack_from("<I", raw, element_offset)[0]
            check(f"{tag}.raw.uid", raw_uid == uid)
            raw_aw = [struct.unpack_from("<f", raw, element_offset + 48 + index * 4)[0]
                      for index in range(3)]
            check(f"{tag}.raw.position", raw_aw == position)
            raw_type = struct.unpack_from("<I", raw, element_offset + 60)[0]
            check(f"{tag}.raw.typeRef", actor.refs[raw_type][0] == decoded["PickupType"]["refId"])
            raw_level = struct.unpack_from("<I", raw, element_offset + 72)[0]
            check(f"{tag}.raw.activeLevel", raw_level == decoded["PickupActiveLevel"])
            raw_rotate = struct.unpack_from("<I", raw, element_offset + 76)[0] != 0
            check(f"{tag}.raw.rotate", raw_rotate == decoded["RotateGraphic"])
            raw_respawn = struct.unpack_from("<f", raw, element_offset + 88)[0]
            check(f"{tag}.raw.respawnOverride", raw_respawn == decoded["RespawnTimerOverride"])
            raw_row = struct.unpack_from("<I", raw, element_offset + 104)[0]
            check(f"{tag}.raw.rowId", raw_row == decoded["RowId"])
            raw_row_handle = struct.unpack_from("<I", raw, element_offset + 100)[0]
            if raw_row_handle == 0xFFFFFFFF:
                check(f"{tag}.raw.rowHandle", decoded["RowType"] is None)
            else:
                check(f"{tag}.raw.rowHandle",
                      actor.refs[raw_row_handle][0] == decoded["RowType"]["refId"])

            # ---- yaw and measured-path projection
            yaw = normalize_angle(math.atan2(basis["az"][0], basis["az"][2]))
            check(f"{tag}.yaw", yaw == slot["yaw"]["radians"])
            check(f"{tag}.yaw.degrees", math.degrees(yaw) == slot["yaw"]["degrees"])
            projection = project(measured, position[0], position[2])
            stored_projection = slot["measuredPath"]
            check(f"{tag}.projection",
                  close(projection["distance"], stored_projection["distance"])
                  and close(projection["arc"], stored_projection["arc"]))
            check(f"{tag}.projection.cross",
                  close(projection["signedCross2d"], stored_projection["signedCross2d"]))
            check(f"{tag}.projection.tangent",
                  close(projection["tangentYawRadians"],
                        slot["yaw"]["measuredTangentRadians"]))
            sample = min(layout_samples, key=lambda item: (abs(item["arc"] - projection["arc"]),
                                                           item["index"]))
            check(f"{tag}.projection.sample",
                  sample["index"] == stored_projection["nearestSampleIndex"]
                  and sample["arc"] == stored_projection["nearestSampleArc"])
            expected_height = (position[1] - sample["groundY"]
                               if sample.get("groundY") is not None else None)
            check(f"{tag}.projection.height", expected_height
                  == stored_projection["heightAbovePathSurface"])

            # ---- collision / visible geometry
            surface = surface_at(position)
            stored_surface = slot["surface"]
            for key, value in surface.items():
                same = (close(value, stored_surface[key], 1e-6)
                        if isinstance(value, float) or isinstance(stored_surface[key], float)
                        else value == stored_surface[key])
                check(f"{tag}.surface.{key}", same,
                      {"expected": stored_surface[key], "actual": value})
            reach = classify(surface, projection)
            if decoded["PickupActiveLevel"] != 1:
                reach["hardExclusions"].append("pickup-active-level-0")
                reach["status"] = "exclude"
                reach["spawnable"] = False
                reach["onMeasuredCourse"] = False
                reach["collectableAtCentreline"] = False
                reach["collectableWithOffset"] = False
            check(f"{tag}.reach", reach == slot["reachability"],
                  {"expected": slot["reachability"], "actual": reach})

        # ---- groups
        alias = {"Bolt": "Blindfire", "Mine": "Bomb"}
        documented_groups = {group["groupId"]: group for group in variant["groups"]}
        recomputed_groups = {}
        for slot in slots:
            key = slot["row"]["shuffleGroup"] if slot["row"] else f"fixed:{slot['uid']}"
            recomputed_groups.setdefault(key, []).append(slot)
        check(f"groups.{route_name}.keys", sorted(documented_groups) == sorted(recomputed_groups))
        for key, members in recomputed_groups.items():
            group = documented_groups.get(key)
            if group is None:
                continue
            check(f"groups.{route_name}.{key}.members",
                  group["placementUids"] == [member["uid"] for member in members])
            check(f"groups.{route_name}.{key}.count", group["count"] == len(members))
            if group["rowRefId"] is None:
                check(f"groups.{route_name}.{key}.singleton", len(members) == 1)
                continue
            allowed = [alias.get(name, name) for name in group["allowedTypes"]]
            serialized = [alias.get(member["serializedType"]["name"],
                                    member["serializedType"]["name"]) for member in members]
            complete = sorted(allowed) == sorted(serialized)
            check(f"groups.{route_name}.{key}.set",
                  complete == group["serializedTypesEqualAllowedSet"],
                  {"allowed": allowed, "serialized": serialized,
                   "documentedComplete": group["serializedTypesEqualAllowedSet"]})
            check(f"groups.{route_name}.{key}.available",
                  group["availableTypesAtRaceStart"] == sorted(set(allowed)))
            check(f"groups.{route_name}.{key}.cycle",
                  ("without replacement" in group["cycleRule"]) == bool(group["rowRefId"]))

        # ---- summary recomputation
        summary = variant["summary"]
        distances = [slot["measuredPath"]["distance"] for slot in slots]
        arcs = [slot["measuredPath"]["arc"] for slot in slots]
        check(f"summary.{route_name}.counts",
              summary["placements"] == len(slots)
              and summary["spawnable"] == sum(1 for slot in slots
                                              if slot["reachability"]["spawnable"])
              and summary["excluded"] == sum(1 for slot in slots
                                             if slot["reachability"]["status"] == "exclude"))
        check(f"summary.{route_name}.paths",
              summary["pathClasses"] == dict(Counter(
                  slot["reachability"]["pathClass"] for slot in slots)))
        check(f"summary.{route_name}.types",
              summary["typeCounts"] == dict(Counter(
                  slot["serializedType"]["name"] for slot in slots)))
        check(f"summary.{route_name}.mpTypes",
              summary["mpTypeCounts"] == dict(Counter(
                  slot["serializedType"]["mpType"] for slot in slots)))
        coverage = summary["onPathCoverage"]
        check(f"summary.{route_name}.coverage",
              coverage["minDistance"] == min(distances)
              and coverage["arcMin"] == min(arcs)
              and coverage["arcMax"] == max(arcs))
        for limit, key in ((2.0, "within2m"), (5.0, "within5m"), (6.0, "within6m"),
                           (10.0, "within10m"), (25.0, "within25m")):
            check(f"summary.{route_name}.{key}",
                  sum(1 for value in distances if value <= limit) == coverage[key])
        check(f"summary.{route_name}.centreline",
              coverage["collectableAtCentreline"] == [slot["uid"] for slot in slots
                                                      if slot["reachability"]["collectableAtCentreline"]])
        check(f"summary.{route_name}.withOffset",
              coverage["collectableWithOffset"] == [slot["uid"] for slot in slots
                                                    if slot["reachability"]["collectableWithOffset"]])
        rounded = Counter((round(slot["position"]["x"], 3),
                           round(slot["position"]["z"], 3)) for slot in slots)
        check(f"summary.{route_name}.duplicates",
              [list(key) for key, count in rounded.items() if count > 1]
              == [item["xz"] for item in summary["duplicates"]["exactXZ1mm"]])
        check(f"summary.{route_name}.uidDuplicates",
              summary["duplicates"]["duplicateUids"]
              == [uid for uid, count in Counter(slot["uid"] for slot in slots).items()
                  if count > 1])
        nearest = min((item["distance"] for item in summary["duplicates"]["nearestNeighbour"]),
                      default=None)
        check(f"summary.{route_name}.minNN",
              nearest == summary["duplicates"]["minNearestNeighbour"])

        # ---- sets, exclusions, flags
        spawn_set = [slot["uid"] for slot in slots if slot["reachability"]["spawnable"]]
        check(f"set.{route_name}.spawn", variant["defaultSpawnSet"] == spawn_set)
        check(f"set.{route_name}.course",
              variant["measuredCourseSet"] == [slot["uid"] for slot in sorted(
                  (slot for slot in slots if slot["reachability"]["onMeasuredCourse"]),
                  key=lambda slot: slot["measuredPath"]["arc"])])
        check(f"set.{route_name}.excluded",
              variant["excluded"] == [{"uid": slot["uid"],
                                       "type": slot["serializedType"]["name"],
                                       "reasons": slot["reachability"]["hardExclusions"]}
                                      for slot in slots
                                      if slot["reachability"]["status"] == "exclude"])
        check(f"set.{route_name}.flagged",
              variant["flagged"] == [{"uid": slot["uid"],
                                      "type": slot["serializedType"]["name"],
                                      "reasons": slot["reachability"]["flags"]}
                                     for slot in slots
                                     if slot["reachability"]["status"] == "flag"])
        check(f"set.{route_name}.offPath",
              variant["offPath"] == [{"uid": slot["uid"],
                                      "type": slot["serializedType"]["name"],
                                      "distance": slot["measuredPath"]["distance"]}
                                     for slot in slots
                                     if slot["reachability"]["pathClass"] == "off-path"])

    # --------------------------------------------------------------- runtime
    runtime = doc["runtime"]
    primary = next(variant for variant in variants
                   if variant["recordId"] == runtime["routeRecordId"])
    check("runtime.route", runtime["routeRecordId"]
          == doc["authority"]["primaryRouteRecordId"])
    check("runtime.counts",
          runtime["slotCount"] == primary["placementCount"]
          and runtime["spawnableCount"] == primary["summary"]["spawnable"])
    check("runtime.spawnSet", runtime["defaultSpawnSet"] == primary["defaultSpawnSet"])
    check("runtime.courseSet", runtime["measuredCourseSet"] == primary["measuredCourseSet"])
    check("runtime.groups", runtime["groups"] == primary["groups"])
    check("runtime.excluded", runtime["excluded"] == primary["excluded"])
    check("runtime.flagged", runtime["flagged"] == primary["flagged"])
    check("runtime.offPath", runtime["offPath"] == primary["offPath"])
    check("runtime.typeCoverage",
          runtime["typeCoverage"]["allEightPresent"]
          == (len(runtime["typeCoverage"]["placedMpTypes"]) == 8)
          and set(runtime["typeCoverage"]["placedMpTypes"]) == set(mp_types.values())
          and runtime["typeCoverage"]["missingMpTypes"] == [])
    check("runtime.maskFilter",
          all(slot["serializedType"]["mpType"]
              in primary["defaultRaceConfig"]["enabledTypesDefault"]
              for slot in primary["slots"] if slot["uid"] in runtime["defaultSpawnSet"]))

    # 9th type
    extension = doc["extensions"]["SuperShield"]
    check("extension.superShield", extension["refId"] == 3093073274
          and extension["placedByDefault"] is False
          and extension["status"] == "project-extension")
    check("extension.notPlaced",
          all(slot["serializedType"]["refId"] != 3093073274
              for variant in variants for slot in variant["slots"]))

    # ------------------------------------------------ collection/respawn model
    collection = doc["collectionModel"]
    check("collection.staticExtents",
          collection["halfExtentsMetres"]["static"] == [1.25, 1.25, 0.25])
    check("collection.activeExtents", collection["activeHalfExtentsMetres"] == [1.25, 1.25, 0.25])
    check("collection.rotateAllFalse",
          collection["rotateGraphicAllFalse"] == all(
              not slot["overrides"]["rotateGraphic"]
              for variant in variants for slot in variant["slots"]))
    check("collection.radiusNotTrigger",
          "not a 2.0 m sphere" in collection["pickupRadiusUse"])
    parity = doc["respawnModel"]["riverParity"]
    check("respawn.sameAsRiver",
          parity["deactivateSeconds"] == 0.6000000238418579
          and parity["normalSeconds"] is None
          and parity["longSeconds"] == 5.0
          and parity["veryLongSeconds"] == 20.0)
    check("respawn.allOverridesZero",
          parity["respawnOverrideNonZero"] == [])
    check("respawn.constantShuffle",
          parity["constantShuffleAllFalse"] == all(
              not slot["overrides"]["constantShuffle"]
              for variant in variants for slot in variant["slots"]))
    check("respawn.resetRule",
          "activationLap is 0" in doc["respawnModel"]["reset"]["lapReset"]
          or "none" in doc["respawnModel"]["reset"]["lapReset"])

    # ---------------------------------------------------------- determinism
    builder = ROOT / "probes/powerups/tools/build_pickup_runtime.py"
    runs = []
    for attempt in (1, 2):
        target = OUT_DIR / f"runtime-{layout_key}.det{attempt}.json"
        result = subprocess.run(
            [sys.executable, str(builder), "--level", level, "--layout", layout_key,
             "--out", str(target)],
            cwd=str(ROOT), capture_output=True, text=True)
        check(f"determinism.run{attempt}.exit", result.returncode == 0, result.stderr[-2000:])
        if result.returncode == 0:
            runs.append(target)
    if len(runs) == 2:
        first = runs[0].read_bytes()
        second = runs[1].read_bytes()
        check("determinism.byteIdentical", first == second)
        check("determinism.matchesManifest", first == manifest_path.read_bytes(),
              {"manifest": sha256(manifest_path.read_bytes()),
               "rebuild": sha256(first)})

    # --------------------------------------------------------------- hashes
    canonical_doc = {key: value for key, value in doc.items() if key != "hashes"}
    canonical = json.dumps(canonical_doc, sort_keys=True, separators=(",", ":"),
                           allow_nan=False)
    check("hashes.canonical",
          sha256(canonical.encode("utf-8")) == doc["hashes"]["canonicalSha256"])
    file_hash = sha256(manifest_path.read_bytes())

    result = {
        "kind": "powerups.pickup-runtime.verify",
        "version": 1,
        "level": level,
        "document": str(manifest_path.relative_to(ROOT)),
        "documentFileSha256": file_hash,
        "documentCanonicalSha256": doc["hashes"]["canonicalSha256"],
        "variants": len(variants),
        "placements": total_slots,
        "checks": len(CHECKS),
        "passed": sum(1 for item in CHECKS if item["ok"]),
        "failed": len(FAILURES),
        "status": "PASS" if not FAILURES else "FAIL",
        "failures": FAILURES,
        "details": CHECKS,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in
                      ("status", "checks", "passed", "failed", "variants", "placements",
                       "documentFileSha256", "documentCanonicalSha256")}, indent=2))
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    raise SystemExit(main())
