#!/usr/bin/env python3
"""Independent exact-triangle verifier for the P61 lap candidates.

Shares no search, raster or path code with build_loops.py. Re-parses
`Level.levelphysics` through the committed collision-oracle parser and builds its
own bucket index. For every 0.25 m sample of every closed loop it re-measures:

  * exact ground (highest up-facing triangle) at the centre and eight footprint
    points (four corners, four edge midpoints);
  * no missing ground and no ledge under the car (footprint height range);
  * adjacent step and 2 m grade, cyclically across the closure seam;
  * exact XZ distance to every steep face whose height band intersects the car;
  * the canonical hash of loops.json.

This is the second instrument; the engine's own FillCache/Trace is the third
(verify_engine_loops.mjs).

    python probes/lap-search/tools/verify_loops.py
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
OUT = ROOT / "_work/lap-search"
PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"

SURFACE_MIN_NY = 0.5
WALL_MAX_NY = 0.5
STEP_LIMIT = 0.05
GRADE_LIMIT = 0.05
FOOTPRINT_RANGE = 0.20
CAR_LENGTH = 2.981
CAR_WIDTH = 1.676
SAFETY_MARGIN = 0.30
HALF_LENGTH = CAR_LENGTH / 2.0 + SAFETY_MARGIN
HALF_WIDTH = CAR_WIDTH / 2.0 + SAFETY_MARGIN
BUCKET = 4.0
CLOSURE_LIMIT = 1.0


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
    doc = json.loads((OUT / "loops.json").read_text(encoding="utf-8"))
    checks = []
    fail = []

    def check(name, ok, detail=None):
        checks.append(dict(name=name, ok=bool(ok), detail=detail))
        if not ok:
            fail.append(name)

    check("canonical-hash", canonical(doc) == doc["hash"].split(":", 1)[1], doc.get("hash"))

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

    results = []
    for loop in doc["loops"]:
        pts = loop["points"]
        n = len(pts)
        loop_checks = []

        def lcheck(name, ok, detail=None):
            loop_checks.append(dict(name=name, ok=bool(ok), detail=detail))
            if not ok:
                fail.append(loop["id"] + ":" + name)

        seam = math.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1])
        lcheck("closed", seam <= 1e-6, dict(seam=round(seam, 6)))
        lcheck("closure-seam", loop["closureSeam"] <= CLOSURE_LIMIT,
               dict(seam=loop["closureSeam"], limit=CLOSURE_LIMIT))
        total = 0.0
        for k in range(1, n):
            total += math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])
        lcheck("length-matches", abs(total - loop["length"]) <= 0.05,
               dict(recomputed=round(total, 4), recorded=loop["length"]))

        heights = [ground_height(x, z) for x, z in pts]
        missing = [k for k, h in enumerate(heights) if h is None]
        lcheck("no-missing-ground", not missing, dict(count=len(missing), first=missing[:5]))

        max_step = 0.0
        max_step_at = -1
        max_grade = 0.0
        max_grade_at = -1
        min_wall = float("inf")
        min_wall_at = -1
        min_wall_tri = None
        max_foot = 0.0
        max_foot_at = -1
        missing_foot = 0
        # footprint points are computed from the local heading
        for k, (x, z) in enumerate(pts):
            if heights[k] is None:
                continue
            a = pts[max(0, k - 1)]
            b = pts[min(n - 1, k + 1)]
            fx, fz = b[0] - a[0], b[1] - a[1]
            fl = math.hypot(fx, fz) or 1.0
            fwd = (fx / fl, fz / fl)
            right = (-fwd[1], fwd[0])
            fps = [(0.0, 0.0)]
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
                    missing_foot += 1
                else:
                    hs.append(hh)
            if hs:
                rng = max(hs) - min(hs)
                if rng > max_foot:
                    max_foot = rng
                    max_foot_at = k
            for idx in wall.near(x, z):
                t = tris[idx]
                ymin = min(t[0][1], t[1][1], t[2][1])
                ymax = max(t[0][1], t[1][1], t[2][1])
                if ymax <= heights[k] + 0.05 or ymin >= heights[k] + 2.0:
                    continue
                d = dist_to_triangle_xz(t, x, z)
                if d < min_wall:
                    min_wall = d
                    min_wall_at = k
                    min_wall_tri = idx
            if k:
                step = abs(heights[k] - heights[k - 1])
                if step > max_step:
                    max_step = step
                    max_step_at = k

        # cyclic 2 m grade over the unique samples (the last point duplicates the first)
        m = n - 1
        for a in range(m):
            acc = 0.0
            j = a
            while acc < 2.0:
                j2 = (j + 1) % m
                acc += math.hypot(pts[j2][0] - pts[j][0], pts[j2][1] - pts[j][1])
                j = j2
                if j == a:
                    break
            if acc >= 1.9 and heights[a] is not None and heights[j] is not None:
                g = abs(heights[j] - heights[a]) / acc
                if g > max_grade:
                    max_grade = g
                    max_grade_at = a

        lcheck("step-limit", max_step <= STEP_LIMIT + 1e-6,
               dict(maxStep=round(max_step, 5), at=max_step_at))
        lcheck("grade-limit", max_grade <= GRADE_LIMIT + 1e-6,
               dict(maxGrade=round(max_grade, 6), at=max_grade_at))
        lcheck("footprint-range", max_foot <= FOOTPRINT_RANGE + 1e-6 and missing_foot == 0,
               dict(maxRange=round(max_foot, 5), at=max_foot_at, missingPoints=missing_foot))
        lcheck("wall-clearance", min_wall >= HALF_WIDTH - 1e-6,
               dict(minDistance=round(min_wall, 5), at=min_wall_at,
                    triangle=min_wall_tri, need=round(HALF_WIDTH, 4)))

        # exact flat-band width perpendicular to the loop line, 0.25 m stations,
        # stop at missing ground or a > 0.20 m step from the centre ground.
        widths = []
        for k, (x, z) in enumerate(pts):
            if heights[k] is None:
                continue
            a = pts[max(0, k - 1)]
            b = pts[min(n - 1, k + 1)]
            fx, fz = b[0] - a[0], b[1] - a[1]
            fl = math.hypot(fx, fz) or 1.0
            right = (-fz / fl, fx / fl)
            wtotal = 0.0
            for sign in (1, -1):
                step = 0.25
                for q in range(1, 33):
                    px = x + right[0] * sign * q * step
                    pz = z + right[1] * sign * q * step
                    hh = ground_height(px, pz)
                    if hh is None or abs(hh - heights[k]) > FOOTPRINT_RANGE + 1e-9:
                        break
                    wtotal += step
            widths.append(wtotal)
        widths.sort()
        min_width = widths[0] if widths else 0.0
        med_width = widths[len(widths) // 2] if widths else 0.0
        lcheck("band-width", min_width >= CAR_WIDTH + 2.0 * SAFETY_MARGIN - 1e-6,
               dict(minWidth=round(min_width, 3), medianWidth=round(med_width, 3),
                    need=round(CAR_WIDTH + 2.0 * SAFETY_MARGIN, 4),
                    stations=len(widths), capM=16.0))

        passed = all(c["ok"] for c in loop_checks)
        results.append(dict(
            id=loop["id"], **{"pass": passed}, checks=loop_checks,
            metrics=dict(samples=n, length=round(total, 4),
                         maxStep=round(max_step, 5), maxStepAt=max_step_at,
                         maxGrade=round(max_grade, 6), maxGradeAt=max_grade_at,
                         footprintMaxRange=round(max_foot, 5), footprintMaxAt=max_foot_at,
                         footprintMissingPoints=missing_foot,
                         minWallDistance=round(min_wall, 5), minWallAt=min_wall_at,
                         minWallTriangle=min_wall_tri,
                         minBandWidth=round(min_width, 3),
                         medianBandWidth=round(med_width, 3),
                         halfWidth=round(HALF_WIDTH, 4), halfLength=round(HALF_LENGTH, 4),
                         closureSeam=loop["closureSeam"]),
        ))

    # Barrier profile: the straight line between the nearest drivable cells of
    # the spawn component and each loop component, sampled on exact triangles.
    barriers = []
    spawn_id = doc["spawnComponent"]["id"]
    for comp in doc["loopComponents"]:
        if comp["isSpawnComponent"]:
            continue
        nt = comp["nearestToSpawn"]
        ax, az = nt["fromWorld"]
        bx, bz = nt["toWorld"]
        gap = math.hypot(bx - ax, bz - az)
        nseg = max(2, min(4000, int(math.ceil(gap / 0.05)) + 1))
        hs = []
        missing = 0
        steps = []
        min_wall_b = float("inf")
        min_wall_tri_b = None
        min_wall_h = None
        prev = None
        for q in range(nseg):
            t = q / (nseg - 1)
            x = ax + (bx - ax) * t
            z = az + (bz - az) * t
            h = ground_height(x, z)
            if h is None:
                missing += 1
                prev = None
                continue
            if prev is not None:
                steps.append(abs(h - prev))
            prev = h
            hs.append(h)
            for idx in wall.near(x, z):
                tri = tris[idx]
                ymin = min(tri[0][1], tri[1][1], tri[2][1])
                ymax = max(tri[0][1], tri[1][1], tri[2][1])
                if ymax <= h + 0.05 or ymin >= h + 2.0:
                    continue
                d = dist_to_triangle_xz(tri, x, z)
                if d < min_wall_b:
                    min_wall_b = d
                    min_wall_tri_b = idx
                    min_wall_h = h
        max_step_b = max(steps) if steps else None
        continuous_ground = (missing == 0 and max_step_b is not None
                             and max_step_b <= STEP_LIMIT + 1e-6)
        blocked_by_wall = (math.isfinite(min_wall_b)
                           and min_wall_b < HALF_WIDTH - 1e-6)
        if blocked_by_wall:
            kind = "thin steep face between the components"
        elif not continuous_ground:
            kind = "void or step between the components"
        else:
            kind = "no passable cell path; nearest cells wider than the car but not connected"
        steep = None
        if min_wall_tri_b is not None:
            tri = tris[min_wall_tri_b]
            ys = (tri[0][1], tri[1][1], tri[2][1])
            steep = dict(
                triangle=int(min_wall_tri_b),
                distance=round(min_wall_b, 5),
                groundAtSample=round(min_wall_h, 4),
                yMin=round(min(ys), 4), yMax=round(max(ys), 4),
                normalY=round(normals[min_wall_tri_b][1], 6),
                vertices=[[round(float(v[0]), 3), round(float(v[1]), 3),
                           round(float(v[2]), 3)] for v in tri],
            )
        barriers.append(dict(
            component=comp["id"],
            gapM=round(gap, 4),
            fromWorld=nt["fromWorld"], toWorld=nt["toWorld"],
            samples=nseg,
            missingGroundSamples=missing,
            maxGroundStep=round(max_step_b, 5) if max_step_b is not None else None,
            minSteepDistance=round(min_wall_b, 4) if math.isfinite(min_wall_b) else None,
            nearestSteepFace=steep,
            continuousGround=continuous_ground,
            blockedByWall=blocked_by_wall,
            barrierKind=kind,
            carNeedWidthM=round(CAR_WIDTH + 2.0 * SAFETY_MARGIN, 4),
        ))
        check("barrier-%d-not-car-passable" % comp["id"],
              (not continuous_ground) or blocked_by_wall or gap < CAR_WIDTH + 2.0 * SAFETY_MARGIN,
              dict(gapM=round(gap, 4), kind=kind,
                   minSteepDistance=round(min_wall_b, 4) if math.isfinite(min_wall_b) else None))

    check("spawn-component-has-no-loop",
          doc["spawnComponent"]["islandsAtLeast100M2"] == 0
          and not any(q["component"] == spawn_id for q in doc["loops"]),
          dict(spawnComponent=spawn_id,
               islands=doc["spawnComponent"]["islands"],
               largestIslandM2=doc["spawnComponent"]["largestIslandM2"]))
    check("loop-found", bool(doc["loops"]), dict(loops=len(doc["loops"])))
    check("loops-separate-from-spawn",
          all(not q["isSpawnComponent"] for q in doc["loopComponents"]),
          dict(components=[q["id"] for q in doc["loopComponents"]]))

    out = dict(
        kind="lap-search.verify",
        version=1,
        **{"pass": not fail},
        failures=fail,
        inputs=dict(physicsSha256=hashlib.sha256(PHYSICS.read_bytes()).hexdigest(),
                    loopsHash=doc["hash"]),
        loops=results,
        barriers=barriers,
    )
    body = json.dumps(out, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    out["hash"] = "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
    (OUT / "verify.json").write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    print("PASS" if not fail else "FAIL")
    for r in results:
        print(r["id"], "PASS" if r["pass"] else "FAIL", json.dumps(r["metrics"]))
    print("failures", fail)
    print("hash", out["hash"])
    return 0 if not fail else 1


if __name__ == "__main__":
    raise SystemExit(main())
