#!/usr/bin/env python3
"""Independent exact-triangle verifier for the map-lap candidates.

Shares no search, raster, erosion, path or metric code with
build_map_loops.py. It re-parses `Level.levelphysics` (through the committed
map-pipeline scanner, the only parser that decodes these levels) and builds its
own 4 m triangle bucket index. For every 0.25 m sample of every closed loop it
re-measures:

  * exact ground (highest up-facing triangle) at the centre and eight footprint
    points (four corners, four edge midpoints) of the car envelope + margin;
  * no missing ground and no ledge under the car (footprint height range);
  * adjacent step and 2 m grade, cyclically across the closure seam, at the
    limits declared in the loops artifact;
  * exact XZ distance to every steep face whose height band intersects the car;
  * exact flat-band width perpendicular to the loop line;
  * the canonical hash of loops.json and the recorded level/physics hash.

    python probes/map-laps/tools/verify_map_loops.py --level usa_amboy
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
import physics_scan as scan  # noqa: E402

SURFACE_MIN_NY = 0.5
WALL_MAX_NY = 0.5
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


def flatten(parsed):
    tris, normals = [], []
    for mesh in parsed["shapes"]:
        if mesh.get("importType") not in (0, 11):
            continue
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


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", required=True)
    ap.add_argument("--dir", type=Path,
                    help="artifact directory (default _work/map-laps/<level>)")
    args = ap.parse_args(argv)
    base_dir = args.dir or (ROOT / "_work/map-laps" / args.level)
    doc = json.loads((base_dir / "loops.json").read_text(encoding="utf-8"))
    if doc["level"] != args.level:
        raise SystemExit("loops.json is for %s, not %s" % (doc["level"], args.level))
    phys_path = ROOT / doc["inputs"]["physics"]["path"]
    phys_bytes = phys_path.read_bytes()

    step_limit = float(doc["model"]["stepLimit"])
    grade_limit = float(doc["model"]["gradeLimit"])

    checks = []
    fail = []

    def check(name, ok, detail=None):
        checks.append(dict(name=name, ok=bool(ok), detail=detail))
        if not ok:
            fail.append(name)

    check("canonical-hash", canonical(doc) == doc["hash"].split(":", 1)[1], doc.get("hash"))
    check("physics-sha256",
          hashlib.sha256(phys_bytes).hexdigest() == doc["inputs"]["physics"]["sha256"],
          dict(recorded=doc["inputs"]["physics"]["sha256"]))
    check("loop-count-recorded", doc["result"]["loopCount"] == len(doc["loops"]),
          dict(recorded=doc["result"]["loopCount"], found=len(doc["loops"])))

    parsed = scan.scan_level(phys_bytes)
    tris, normals = flatten(parsed)
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
        lcheck("no-missing-ground", not missing,
               dict(count=len(missing), first=missing[:5]))

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
        foot_fail = []
        wall_fail = []
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
                if rng > FOOTPRINT_RANGE + 1e-6 or len(hs) < len(fps):
                    foot_fail.append(k)
            min_wall_here = float("inf")
            for idx in wall.near(x, z):
                t = tris[idx]
                ymin = min(t[0][1], t[1][1], t[2][1])
                ymax = max(t[0][1], t[1][1], t[2][1])
                if ymax <= heights[k] + 0.05 or ymin >= heights[k] + 2.0:
                    continue
                d = dist_to_triangle_xz(t, x, z)
                if d < min_wall_here:
                    min_wall_here = d
                if d < min_wall:
                    min_wall = d
                    min_wall_at = k
                    min_wall_tri = idx
            if min_wall_here < HALF_WIDTH - 1e-6:
                wall_fail.append(k)
            if k:
                step = abs(heights[k] - heights[k - 1])
                if step > max_step:
                    max_step = step
                    max_step_at = k

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

        lcheck("step-limit", max_step <= step_limit + 1e-6,
               dict(maxStep=round(max_step, 5), at=max_step_at, limit=step_limit))
        lcheck("grade-limit", max_grade <= grade_limit + 1e-6,
               dict(maxGrade=round(max_grade, 6), at=max_grade_at, limit=grade_limit))
        lcheck("footprint-range",
               max_foot <= FOOTPRINT_RANGE + 1e-6 and missing_foot == 0,
               dict(maxRange=round(max_foot, 5), at=max_foot_at,
                    missingPoints=missing_foot))
        lcheck("wall-clearance", min_wall >= HALF_WIDTH - 1e-6,
               dict(minDistance=round(min_wall, 5) if math.isfinite(min_wall) else None,
                    at=min_wall_at, triangle=min_wall_tri,
                    need=round(HALF_WIDTH, 4)))

        widths = []
        band_fail = []
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
            if wtotal < CAR_WIDTH + 2.0 * SAFETY_MARGIN - 1e-6:
                band_fail.append(k)
        widths.sort()
        min_width = widths[0] if widths else 0.0
        med_width = widths[len(widths) // 2] if widths else 0.0
        lcheck("band-width", min_width >= CAR_WIDTH + 2.0 * SAFETY_MARGIN - 1e-6,
               dict(minWidth=round(min_width, 3), medianWidth=round(med_width, 3),
                    need=round(CAR_WIDTH + 2.0 * SAFETY_MARGIN, 4),
                    stations=len(widths), capM=16.0))

        passed = all(c["ok"] for c in loop_checks)

        def spans(idxs):
            """Collapse failing sample indices into arc runs (0.25 m samples)."""
            out = []
            for k in idxs[:400]:
                if out and k <= out[-1]["toSample"] + 1:
                    out[-1]["toSample"] = k
                else:
                    out.append({"fromSample": k, "toSample": k})
            for run in out:
                run["fromArcM"] = round(run["fromSample"] * 0.25, 2)
                run["toArcM"] = round(run["toSample"] * 0.25, 2)
                run["metres"] = round((run["toSample"] - run["fromSample"] + 1) * 0.25, 2)
            return out

        results.append(dict(
            id=loop["id"], **{"pass": passed}, checks=loop_checks,
            metrics=dict(samples=n, length=round(total, 4),
                         component=loop["component"],
                         maxStep=round(max_step, 5), maxStepAt=max_step_at,
                         maxGrade=round(max_grade, 6), maxGradeAt=max_grade_at,
                         footprintMaxRange=round(max_foot, 5), footprintMaxAt=max_foot_at,
                         footprintMissingPoints=missing_foot,
                         footprintOverLimitSamples=len(foot_fail),
                         footprintFailRuns=spans(foot_fail),
                         wallOverLimitSamples=len(wall_fail),
                         wallFailRuns=spans(wall_fail),
                         bandOverLimitSamples=len(band_fail),
                         minWallDistance=(round(min_wall, 5)
                                          if math.isfinite(min_wall) else None),
                         minWallAt=min_wall_at, minWallTriangle=min_wall_tri,
                         minBandWidth=round(min_width, 3),
                         medianBandWidth=round(med_width, 3),
                         halfWidth=round(HALF_WIDTH, 4),
                         halfLength=round(HALF_LENGTH, 4),
                         closureSeam=loop["closureSeam"]),
        ))

    # Topology statements are re-derived from the artifact, not trusted blindly.
    spawn = doc["spawnComponent"]
    path_comps = [c["component"] for c in doc["pathComponents"]["components"]]
    check("spawn-component-islands-recorded",
          isinstance(spawn["islands"], int) and spawn["id"] > 0,
          dict(id=spawn["id"], islands=spawn["islands"],
               islandsAtLeast100M2=spawn["islandsAtLeast100M2"]))
    check("path-component-is-recorded",
          bool(path_comps), dict(components=path_comps[:8]))
    check("loops-inside-or-outside-spawn-declared",
          all((q["component"] == spawn["id"]) == (q["id"] in spawn["loopsInSpawnComponent"])
              for q in doc["loops"]),
          dict(spawnComponent=spawn["id"],
               loops=[q["id"] for q in doc["loops"] if q["component"] == spawn["id"]]))

    out = dict(
        kind="map-laps.verify",
        version=1,
        level=args.level,
        modelLabel=doc.get("modelLabel"),
        **{"pass": not fail},
        failures=fail,
        inputs=dict(physicsSha256=hashlib.sha256(phys_bytes).hexdigest(),
                    loopsHash=doc["hash"],
                    parser="probes/map-pipeline/tools/physics_scan.py"),
        checks=checks,
        loops=results,
    )
    body = json.dumps(out, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    out["hash"] = "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
    (base_dir / "verify.json").write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    print("PASS" if not fail else "FAIL")
    for r in results:
        print(r["id"], "PASS" if r["pass"] else "FAIL", json.dumps(r["metrics"]))
    print("failures", fail)
    print("hash", out["hash"])
    return 0 if not fail else 1


if __name__ == "__main__":
    raise SystemExit(main())
