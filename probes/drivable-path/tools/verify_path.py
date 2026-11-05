#!/usr/bin/env python3
"""Independent verifier for the drivable-path course.

It shares no search code with `build_path.py`. It re-parses
`Level.levelphysics` through the committed collision-oracle parser, rebuilds its
own point and wall indices from the raw triangles, and re-measures every 0.25 m
sample:

  * exact ground height (highest up-facing triangle) at the centre, four car
    corners and four edge midpoints;
  * no void and no ledge under the car (footprint height range);
  * adjacent step and 2 m grade;
  * exact XZ distance to every steep collision triangle whose height band
    intersects the car at that sample (solid or one-sided; no engine filter);
  * the recorded canonical hash of `path.json`.

This deliberately does *not* trust the builder's rasters. The engine trace
(`verify_engine_trace.mjs`) is the second, independent physical check.

    python probes/drivable-path/tools/verify_path.py
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "probes/collision-oracle/tests"))
import reference_oracle as oracle  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work/drivable-path"
PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"

CELL = 0.5
SURFACE_MIN_NY = 0.5          # ground candidate: any up-facing triangle
WALL_MAX_NY = 0.5             # wall: steeper than 60 degrees
STEP_LIMIT = 0.05
GRADE_LIMIT = 0.05
FOOTPRINT_RANGE = 0.20        # max-min ground height under the car
CAR_LENGTH = 2.981            # Dodge XT wheelBase, max roster
CAR_WIDTH = 1.676             # Audi XT rear track, max roster
SAFETY_MARGIN = 0.30
HALF_LENGTH = CAR_LENGTH / 2.0 + SAFETY_MARGIN
HALF_WIDTH = CAR_WIDTH / 2.0 + SAFETY_MARGIN
BUCKET = 4.0


def canonical(doc):
    body = dict(doc)
    body.pop("hash", None)
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def flatten(level):
    tris = []
    normals = []
    for mesh in level["meshes"]:
        verts = mesh["vertices"]
        for tri in mesh["triangles"]:
            leaf = mesh["leaves"][tri["leaf"]]
            base = leaf["vertex_start"]
            a = verts[base + tri["a"]]
            b = verts[base + tri["b"]]
            c = verts[base + tri["c"]]
            u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
            v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
            n = (u[1] * v[2] - u[2] * v[1],
                 u[2] * v[0] - u[0] * v[2],
                 u[0] * v[1] - u[1] * v[0])
            ln = math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) or 1.0
            tris.append((a, b, c))
            normals.append((n[0] / ln, n[1] / ln, n[2] / ln))
    return tris, normals


class Index:
    def __init__(self, tris, keep):
        self.tris = tris
        self.buckets = {}
        for idx, t in enumerate(tris):
            if not keep[idx]:
                continue
            xs = (t[0][0], t[1][0], t[2][0])
            zs = (t[0][2], t[1][2], t[2][2])
            i0 = int(math.floor(min(xs) / BUCKET)); i1 = int(math.floor(max(xs) / BUCKET))
            j0 = int(math.floor(min(zs) / BUCKET)); j1 = int(math.floor(max(zs) / BUCKET))
            for i in range(i0, i1 + 1):
                for j in range(j0, j1 + 1):
                    self.buckets.setdefault((i, j), []).append(idx)

    def near(self, x, z):
        key = (int(math.floor(x / BUCKET)), int(math.floor(z / BUCKET)))
        out = []
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                out.extend(self.buckets.get((key[0] + di, key[1] + dj), ()))
        return out


def height_in_triangle(t, x, z):
    a, b, c = t
    den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
    if abs(den) < 1e-12:
        return None
    l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / den
    l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / den
    l3 = 1.0 - l1 - l2
    if l1 < -1e-9 or l2 < -1e-9 or l3 < -1e-9:
        return None
    return l1 * a[1] + l2 * b[1] + l3 * c[1]


def dist_to_triangle_xz(t, x, z):
    ax, az = t[0][0], t[0][2]
    bx, bz = t[1][0], t[1][2]
    cx, cz = t[2][0], t[2][2]
    den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
    if abs(den) > 1e-12:
        l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den
        l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den
        l3 = 1.0 - l1 - l2
        if l1 >= 0 and l2 >= 0 and l3 >= 0:
            return 0.0
    best = float("inf")
    for (px, pz, qx, qz) in ((ax, az, bx, bz), (bx, bz, cx, cz), (cx, cz, ax, az)):
        dx, dz = qx - px, qz - pz
        l2 = dx * dx + dz * dz
        if l2 == 0:
            d = math.hypot(x - px, z - pz)
        else:
            tt = max(0.0, min(1.0, ((x - px) * dx + (z - pz) * dz) / l2))
            d = math.hypot(x - (px + tt * dx), z - (pz + tt * dz))
        best = min(best, d)
    return best


def main() -> int:
    path_doc = json.loads((OUT / "path.json").read_text())
    checks = []
    fail = []

    def check(name, ok, detail=None):
        checks.append(dict(name=name, ok=bool(ok), detail=detail))
        if not ok:
            fail.append(name)

    check("canonical-hash", canonical(path_doc) == path_doc["hash"].split(":", 1)[1],
          path_doc.get("hash"))

    level = oracle.load_level(PHYSICS.read_bytes())
    tris, normals = flatten(level)
    ground = Index(tris, [n[1] > SURFACE_MIN_NY for n in normals])
    wall = Index(tris, [abs(n[1]) < WALL_MAX_NY for n in normals])

    def ground_height(x, z):
        hs = []
        for idx in ground.near(x, z):
            h = height_in_triangle(tris[idx], x, z)
            if h is not None:
                hs.append(h)
        return max(hs) if hs else None

    pts = path_doc["course"]["points"]
    samples = len(pts)
    total = 0.0
    max_step = 0.0
    max_step_at = -1
    max_grade = 0.0
    max_grade_at = -1
    min_wall = float("inf")
    min_wall_at = -1
    min_wall_tri = None
    max_foot = 0.0
    max_foot_at = -1
    missing = []
    heights = [ground_height(x, z) for x, z in pts]
    for k, (x, z) in enumerate(pts):
        if k:
            total += math.hypot(x - pts[k - 1][0], z - pts[k - 1][1])
        h = heights[k]
        if h is None:
            missing.append(k)
            continue
        # heading
        a = pts[max(0, k - 1)]
        b = pts[min(samples - 1, k + 1)]
        fx, fz = b[0] - a[0], b[1] - a[1]
        fl = math.hypot(fx, fz) or 1.0
        fwd = (fx / fl, fz / fl)
        right = (-fwd[1], fwd[0])
        # footprint points: corners, edge midpoints, centre
        fps = [(0, 0)]
        for sl in (-1, 1):
            for sw in (-1, 1):
                fps.append((sl * HALF_LENGTH, sw * HALF_WIDTH))
            fps.append((sl * HALF_LENGTH, 0.0))
            fps.append((0.0, sl * HALF_WIDTH))
        hs = []
        for sl, sw in fps:
            px = x + fwd[0] * sl + right[0] * sw
            pz = z + fwd[1] * sl + right[1] * sw
            hh = ground_height(px, pz)
            if hh is None:
                missing.append((k, sl, sw))
            else:
                hs.append(hh)
        if hs:
            rng = max(hs) - min(hs)
            if rng > max_foot:
                max_foot = rng
                max_foot_at = k
        # walls within the car height band
        for idx in wall.near(x, z):
            t = tris[idx]
            ymin = min(t[0][1], t[1][1], t[2][1])
            ymax = max(t[0][1], t[1][1], t[2][1])
            if ymax <= h + 0.05 or ymin >= h + 2.0:
                continue
            d = dist_to_triangle_xz(t, x, z)
            if d < min_wall:
                min_wall = d
                min_wall_at = k
                min_wall_tri = idx
        # step and 2 m grade
        if k and heights[k - 1] is not None:
            step = abs(h - heights[k - 1])
            if step > max_step:
                max_step = step
                max_step_at = k
        # 2 m window
        m = k
        acc = 0.0
        while m + 1 < samples and acc < 2.0:
            acc += math.hypot(pts[m + 1][0] - pts[m][0], pts[m + 1][1] - pts[m][1])
            m += 1
        if acc >= 1.9 and heights[m] is not None:
            g = abs(heights[m] - h) / acc
            if g > max_grade:
                max_grade = g
                max_grade_at = k

    check("no-missing-ground", not missing, dict(count=len(missing), first=missing[:5]))
    check("start-is-spawn", abs(pts[0][0] + 88.0) < 1e-6 and abs(pts[0][1] - 1050.0) < 1e-6,
          pts[0])
    check("step-limit", max_step <= STEP_LIMIT + 1e-6,
          dict(maxStep=round(max_step, 5), at=max_step_at))
    check("grade-limit", max_grade <= GRADE_LIMIT + 1e-6,
          dict(maxGrade=round(max_grade, 6), at=max_grade_at))
    check("footprint-range", max_foot <= FOOTPRINT_RANGE + 1e-6,
          dict(maxRange=round(max_foot, 5), at=max_foot_at))
    check("wall-clearance", min_wall >= HALF_WIDTH - 1e-6,
          dict(minDistance=round(min_wall, 5), at=min_wall_at, triangle=min_wall_tri,
               need=round(HALF_WIDTH, 4)))
    check("length-matches", abs(total - path_doc["course"]["length"]) <= 0.05,
          dict(recomputed=round(total, 4), recorded=path_doc["course"]["length"]))

    doc = dict(
        kind="drivable-path.verify",
        version=1,
        **{"pass": not fail},        checks=checks,
        failures=fail,
        inputs=dict(
            physicsSha256=hashlib.sha256(PHYSICS.read_bytes()).hexdigest(),
            pathHash=path_doc["hash"],
        ),
        metrics=dict(
            samples=samples,
            length=round(total, 4),
            maxStep=round(max_step, 5),
            maxStepAt=max_step_at,
            maxGrade=round(max_grade, 6),
            maxGradeAt=max_grade_at,
            footprintMaxRange=round(max_foot, 5),
            footprintMaxAt=max_foot_at,
            minWallDistance=round(min_wall, 5),
            minWallAt=min_wall_at,
            minWallTriangle=min_wall_tri,
            halfWidth=round(HALF_WIDTH, 4),
            halfLength=round(HALF_LENGTH, 4),
        ),
    )
    body = json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    doc["hash"] = "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
    (OUT / "verify.json").write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps(doc["metrics"], indent=1))
    print("checks", sum(1 for c in checks if c["ok"]), "/", len(checks), "failures", fail)
    print("hash", doc["hash"])
    return 0 if not fail else 1


if __name__ == "__main__":
    raise SystemExit(main())
