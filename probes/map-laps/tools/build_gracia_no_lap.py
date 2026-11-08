#!/usr/bin/env python3
"""Build the committed `spa_barcelona_gracia` no-closed-lap decision.

The Gracia course component (171) has no enclosed island >= 100 m2, so the same
island-based lap search that produced `usa_amboy` loop-01 cannot extract a loop
on the course. The search does extract three loops, but every one is in another
component and unreachable from the committed spawn. This builder records that
decision with the measured values and the source hashes.

Inputs (read-only):

  _work/map-laps/spa_barcelona_gracia/loops.json      components, islands, loops
  _work/map-laps/spa_barcelona_gracia/coverage.json   draw coverage per loop
  _work/map-laps/spa_barcelona_gracia/verify.json     exact-triangle verifier
  _work/map-laps/spa_barcelona_gracia/engine-trace.json  engine FillCache/Trace
  _work/map-laps/spa_barcelona_gracia/reach.json      spawn BFS reachability
  _work/map-laps/spa_barcelona_gracia/grid.npz        P48 raster (base/height/dh/wall)
  game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics

Output:

  probes/map-laps/data/gracia-no-lap.json

The nearest gap between the course component and loop-01 is measured twice:
once on the 0.5 m P48 raster (blocked-cell kind + neighbour dh) and once on the
exact collision triangles at 0.05 m (ground profile, average and max 0.5 m
grade). Both are recorded; the verifier re-derives the raster side from
grid.npz and recomputes the exact side from the recorded profile.

    python probes/map-laps/tools/build_gracia_no_lap.py
    python probes/map-laps/tools/build_gracia_no_lap.py --check
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))
sys.path.insert(0, str(ROOT / "probes/lap-search/tools"))

from map_laps_common import (  # noqa: E402
    STEP_LIMIT, GRADE_LIMIT, ISLAND_MIN_M2, LOOP_ERODE, load_level,
)
from raster import label_components  # noqa: E402
import verify_map_loops as exact  # noqa: E402  (read-only import)

LEVEL = "spa_barcelona_gracia"
MAP_ID = "gracia"
WORK = ROOT / "_work/map-laps" / LEVEL
DEFAULT_OUT = ROOT / "probes/map-laps/data/gracia-no-lap.json"
VERDICT = "no-closed-lap"
CLOSURE_LIMIT_M = 1.0
LENGTH_MIN_M = 150.0
LENGTH_MAX_M = 1500.0
GAP_EXACT_STEP_M = 0.05
GAP_EXACT_MAX_M = 10.0          # exact profile only for a near gap


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def file_sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def js_number(x: float) -> str:
    """Format a float the way `JSON.stringify` does (shortest round-trip).

    Python's `repr` uses exponent notation for |x| < 1e-4; JavaScript uses
    decimal notation down to 1e-6. The canonical hash is computed over this
    JavaScript-compatible form so the Node verifier can recompute it.
    """
    x = float(x)
    if x == 0:
        return "0"
    if x == int(x) and abs(x) < 1e21:
        return str(int(x))
    r = repr(x)
    if "e" in r:
        mant, exp_text = r.split("e")
        exp = int(exp_text)
        if -6 <= exp < 21:
            sign = ""
            if mant.startswith("-"):
                sign, mant = "-", mant[1:]
            if "." in mant:
                ip, fp = mant.split(".")
            else:
                ip, fp = mant, ""
            digits = ip + fp
            point = len(ip) + exp
            if point <= 0:
                return sign + "0." + "0" * (-point) + digits
            if point >= len(digits):
                return sign + digits + "0" * (point - len(digits))
            return sign + digits[:point] + "." + digits[point:]
        return mant + "e" + ("+" if exp >= 0 else "-") + str(abs(exp))
    return r


def canonical_json_js(value) -> str:
    """Canonical JSON matching `JSON.stringify(sortValue(body))` in Node."""
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: kv[0])
        return "{" + ",".join(
            json.dumps(k, ensure_ascii=False) + ":" + canonical_json_js(v)
            for k, v in items) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json_js(v) for v in value) + "]"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, (int, np.integer)):
        return str(int(value))
    if isinstance(value, (float, np.floating)):
        return js_number(float(value))
    raise TypeError("unsupported canonical type: %r" % (type(value),))


def canonical_hash(doc: dict) -> str:
    body = {k: v for k, v in doc.items() if k != "hash"}
    text = canonical_json_js(body)
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def canon(value, nd=6):
    """Round floats and emit ints for integral values (Python/JS hash parity)."""
    if isinstance(value, dict):
        return {k: canon(v, nd) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [canon(v, nd) for v in value]
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        if not math.isfinite(float(value)):
            return None
        rounded = round(float(value), nd)
        if rounded == 0:
            return 0
        if rounded == int(rounded) and abs(rounded) < 1e15:
            return int(rounded)
        return rounded
    return value


def component_boundary(lab, cid):
    m = lab == cid
    p = np.pad(m, 1, constant_values=False)
    inner = (p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1]
             & p[1:-1, :-2] & p[1:-1, 2:])
    return np.argwhere(m & ~inner)


def nearest_pair(lab, a, b):
    """Nearest passable-cell pair between two components (boundary cells)."""
    A = component_boundary(lab, a)
    B = component_boundary(lab, b)
    if len(A) == 0 or len(B) == 0:
        return None
    best = (1e18, None, None)
    Bf = B.astype(np.float64)
    for k in range(0, len(A), 256):
        chunk = A[k:k + 256].astype(np.float64)
        d2 = ((chunk[:, None, 0] - Bf[None, :, 0]) ** 2
              + (chunk[:, None, 1] - Bf[None, :, 1]) ** 2)
        idx = np.unravel_index(np.argmin(d2), d2.shape)
        if d2[idx] < best[0]:
            best = (d2[idx], A[k + idx[0]], B[idx[1]])
    d, pa, pb = best
    return math.sqrt(d), (int(pa[0]), int(pa[1])), (int(pb[0]), int(pb[1]))


def raster_kind(base, height, dh, wall, edge_dh, j, i):
    nz, nx = base.shape
    if not (0 <= j < nz and 0 <= i < nx):
        return "outside"
    if base[j, i]:
        return "passable"
    if not np.isfinite(height[j, i]):
        return "no-surface"
    if wall[j, i]:
        return "wall"
    if dh[j, i] > edge_dh + 1e-9:
        return "step-or-grade"
    return "other"


def raster_profile(base, height, dh, wall, edge_dh, xs, zs, pa, pb):
    (ja, ia), (jb, ib) = pa, pb
    steps = int(math.ceil(math.hypot(jb - ja, ib - ia)))
    rows = []
    for k in range(steps + 1):
        t = k / steps
        j = int(round(ja + (jb - ja) * t))
        i = int(round(ia + (ib - ia) * t))
        rows.append(dict(
            t=round(t, 6),
            x=float(xs[i]), z=float(zs[j]),
            heightM=(float(height[j, i]) if np.isfinite(height[j, i]) else None),
            dhM=(float(dh[j, i]) if np.isfinite(dh[j, i]) else None),
            kind=raster_kind(base, height, dh, wall, edge_dh, j, i),
        ))
    return rows


def exact_profile(ground_index, tris, pa_world, pb_world):
    """Exact up-facing triangle ground at 0.05 m along the straight gap line."""
    ax, az = pa_world
    bx, bz = pb_world
    length = math.hypot(bx - ax, bz - az)
    n = int(math.ceil(length / GAP_EXACT_STEP_M))
    rows = []
    for k in range(n + 1):
        t = k / n
        x = ax + (bx - ax) * t
        z = az + (bz - az) * t
        hs = []
        for idx in ground_index.near(x, z):
            h = exact.height_in_triangle(tris[idx], x, z)
            if h is not None:
                hs.append(h)
        rows.append(dict(t=round(t, 6), x=x, z=z,
                         groundY=(max(hs) if hs else None)))
    return length, rows


def exact_grade(rows, length):
    """Average grade, max 0.5 m grade and max adjacent step on the exact line."""
    finite = [r for r in rows if r["groundY"] is not None]
    if len(finite) < 2:
        return None
    delta = finite[-1]["groundY"] - finite[0]["groundY"]
    max_step = 0.0
    max_step_at = None
    for a, b in zip(finite, finite[1:]):
        d = abs(b["groundY"] - a["groundY"])
        if d > max_step:
            max_step, max_step_at = d, b["t"]
    max_half = 0.0
    max_half_at = None
    for i, a in enumerate(finite):
        for b in finite[i + 1:]:
            arc = (b["t"] - a["t"]) * length
            if arc >= 0.5 - 1e-9:
                g = abs(b["groundY"] - a["groundY"]) / arc
                if g > max_half:
                    max_half, max_half_at = g, a["t"]
                break
    return dict(
        groundFromM=finite[0]["groundY"],
        groundToM=finite[-1]["groundY"],
        groundDeltaM=delta,
        averageGrade=abs(delta) / length if length else None,
        maxHalfMetreGrade=max_half,
        maxHalfMetreGradeAtT=max_half_at,
        maxAdjacentStepM=max_step,
        maxAdjacentStepAtT=max_step_at,
        sampleStepM=GAP_EXACT_STEP_M,
    )


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true",
                    help="compare the generated document with --out; exit 1 if it differs")
    args = ap.parse_args(argv)

    loops_path = WORK / "loops.json"
    coverage_path = WORK / "coverage.json"
    verify_path = WORK / "verify.json"
    engine_path = WORK / "engine-trace.json"
    reach_path = WORK / "reach.json"
    grid_path = WORK / "grid.npz"

    loops_doc = load_json(loops_path)
    coverage_doc = load_json(coverage_path)
    verify_doc = load_json(verify_path)
    engine_doc = load_json(engine_path)
    reach_doc = load_json(reach_path)

    if loops_doc.get("kind") != "map-laps.loops" or loops_doc.get("level") != LEVEL:
        raise SystemExit("loops.json is not the %s map-laps.loops artifact" % LEVEL)
    if coverage_doc.get("kind") != "map-laps.coverage" or coverage_doc.get("level") != LEVEL:
        raise SystemExit("coverage.json is not the %s map-laps.coverage artifact" % LEVEL)
    if verify_doc.get("kind") != "map-laps.verify" or verify_doc.get("level") != LEVEL:
        raise SystemExit("verify.json is not the %s map-laps.verify artifact" % LEVEL)
    if engine_doc.get("kind") != "map-laps.engine-trace" or engine_doc.get("level") != LEVEL:
        raise SystemExit("engine-trace.json is not the %s map-laps.engine-trace artifact" % LEVEL)
    if reach_doc.get("kind") != "map-laps.reach" or reach_doc.get("level") != LEVEL:
        raise SystemExit("reach.json is not the %s map-laps.reach artifact" % LEVEL)

    grid = np.load(grid_path)
    base, height, dh, wall = grid["base"], grid["height"], grid["dh"], grid["wall"]
    xs, zs = grid["xs"], grid["zs"]
    cell = float(xs[1] - xs[0])
    edge_dh = min(STEP_LIMIT, GRADE_LIMIT * cell)
    lab, sizes = label_components(base, conn=8)

    spawn = loops_doc["inputs"]["spawn"]
    sj = int(round((spawn["z"] - zs[0]) / cell))
    si = int(round((spawn["x"] - xs[0]) / cell))
    spawn_cid = int(lab[sj, si])
    path_comps = loops_doc["pathComponents"]["components"]
    course_cid = spawn_cid
    if not any(c["component"] == course_cid for c in path_comps):
        raise SystemExit("the spawn component is not a measured-path component")
    if loops_doc["spawnComponent"]["id"] != course_cid:
        raise SystemExit("spawnComponent disagrees with the raster label")

    # Exact collision ground index (same parser + rule as verify_map_loops.py).
    cfg, phys_path, phys_bytes, parsed = load_level(LEVEL)
    tris, normals = exact.flatten(parsed)
    ground_index = exact.Index(tris, [n[1] > exact.SURFACE_MIN_NY for n in normals])

    coverage_by_id = {q["id"]: q for q in coverage_doc["loops"]}
    verify_by_id = {q["id"]: q for q in verify_doc["loops"]}
    engine_by_id = {q["id"]: q for q in engine_doc["loops"]}
    reach_by_id = {q["id"]: q for q in reach_doc["loops"]}

    criteria = [
        dict(id="on-course",
             rule=("the loop lies in the component the measured point-to-point "
                   "path uses (the spawn component)"),
             amboy="component 510, 934/1628 measured path samples"),
        dict(id="closed", rule="closure seam <= 1.0 m", amboy="0.5 m"),
        dict(id="ring",
             rule=("the enclosed island survives >= 3 clearance erosions "
                   "(>= 2.0 m ring lower bound)"),
             amboy="survives 5, k=3, minClearance 2.0 m"),
        dict(id="length", rule="150 m <= loop length <= 1500 m",
             amboy="284.4524 m"),
        dict(id="exact",
             rule="verify_map_loops.py exact-triangle PASS (step/grade/footprint/wall/band)",
             amboy="PASS 9/9"),
        dict(id="engine",
             rule="engine trace 0 hard / 0 safety-margin violations",
             amboy="569 samples, 0 / 0"),
        dict(id="coverage",
             rule="draw coverage fraction 1.0 with 0 gaps",
             amboy="1.000, 0 gaps"),
    ]

    candidates = []
    for loop in loops_doc["loops"]:
        lid = loop["id"]
        cov = coverage_by_id.get(lid)
        ver = verify_by_id.get(lid)
        eng = engine_by_id.get(lid)
        rea = reach_by_id.get(lid)
        if cov is None or ver is None or eng is None or rea is None:
            raise SystemExit("missing coverage/verify/engine/reach record for " + lid)
        island_row = next((row for row in loops_doc["islands"]
                           if row["loop"] == lid), None)
        if island_row is None:
            raise SystemExit("missing island record for " + lid)

        comp = int(loop["component"])
        gap = None
        if comp != course_cid:
            pair = nearest_pair(lab, course_cid, comp)
            if pair is not None:
                gap_cells, pa, pb = pair
                pa_world = (float(xs[pa[1]]), float(zs[pa[0]]))
                pb_world = (float(xs[pb[1]]), float(zs[pb[0]]))
                prof = raster_profile(base, height, dh, wall, edge_dh,
                                      xs, zs, pa, pb)
                blocked = [r for r in prof if r["kind"] != "passable"]
                kinds = {}
                for r in blocked:
                    kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
                finite_dh = [r["dhM"] for r in prof if r["dhM"] is not None]
                gap = dict(
                    gapCells=gap_cells,
                    gapM=gap_cells * cell,
                    courseCell=pa, loopCell=pb,
                    courseWorld=pa_world, loopWorld=pb_world,
                    blockedCells=len(blocked),
                    blockedKinds=kinds,
                    rasterDhMaxM=(max(finite_dh) if finite_dh else None),
                    rasterProfile=prof,
                )
                if gap_cells * cell <= GAP_EXACT_MAX_M:
                    length, erows = exact_profile(ground_index, tris,
                                                  pa_world, pb_world)
                    gap["exact"] = exact_grade(erows, length)
                    gap["exact"]["gapM"] = length
                    gap["exact"]["profile"] = erows

        def measured(cid):
            if cid == "on-course":
                return dict(component=comp, courseComponent=course_cid,
                            reachable=bool(rea["reachable"]),
                            geodesicM=rea["geodesicM"])
            if cid == "closed":
                return dict(closureSeamM=loop["closureSeam"])
            if cid == "ring":
                return dict(survivesErosion=int(island_row["survivesErosion"]),
                            erodeCells=int(loop["erodeCells"]),
                            tight=bool(loop["tight"]),
                            minClearanceM=loop["minClearance"])
            if cid == "length":
                return dict(lengthM=loop["length"])
            if cid == "exact":
                return {"pass": bool(ver["pass"]),
                        "checks": len(ver["checks"]),
                        "failures": [q["name"] for q in ver["checks"] if not q["ok"]]}
            if cid == "engine":
                return dict(samples=int(eng["samples"]),
                            violations=len(eng["violations"]),
                            tightViolations=len(eng["tightViolations"]))
            if cid == "coverage":
                return dict(fraction=cov["fraction"],
                            gapRuns=int(cov["gapRuns"]),
                            centreUncoveredSamples=int(cov["centreUncoveredSamples"]),
                            deltaMaxM=cov["deltaMax"])
            raise KeyError(cid)

        def passed(cid):
            if cid == "on-course":
                return comp == course_cid
            if cid == "closed":
                return loop["closureSeam"] <= CLOSURE_LIMIT_M
            if cid == "ring":
                return int(island_row["survivesErosion"]) >= LOOP_ERODE
            if cid == "length":
                return LENGTH_MIN_M <= loop["length"] <= LENGTH_MAX_M
            if cid == "exact":
                return bool(ver["pass"])
            if cid == "engine":
                return not eng["violations"] and not eng["tightViolations"]
            if cid == "coverage":
                return cov["fraction"] == 1.0 and cov["gapRuns"] == 0
            raise KeyError(cid)

        evaluation = []
        for c in criteria:
            m = measured(c["id"])
            ok = passed(c["id"])
            evaluation.append({"id": c["id"], "pass": ok, "measured": m})

        candidates.append(dict(
            id=lid,
            component=comp,
            componentCells=int(island_row["island"]["componentCells"]),
            lengthM=loop["length"],
            samples=int(loop["samples"]),
            closureSeamM=loop["closureSeam"],
            island=dict(
                areaM2=island_row["island"]["areaM2"],
                cells=int(island_row["island"]["cells"]),
                blockedBy=island_row["island"]["blockedBy"],
                survivesErosion=int(island_row["survivesErosion"]),
                ringHalfWidthLowerBoundM=island_row["ringHalfWidthLowerBoundM"],
            ),
            erodeCells=int(loop["erodeCells"]),
            tight=bool(loop["tight"]),
            minClearanceM=loop["minClearance"],
            maxStepM=loop["maxStep"],
            maxGrade=loop["maxGrade"],
            groundRangeM=loop["groundRange"],
            coverage=dict(
                fraction=cov["fraction"],
                samples=int(cov["samples"]),
                stations=int(cov["stations"]),
                coveredStations=int(cov["coveredStations"]),
                centreUncoveredSamples=int(cov["centreUncoveredSamples"]),
                gapRuns=int(cov["gapRuns"]),
                gapMetresM=cov["gapMetres"],
                deltaMinM=cov["deltaMin"],
                deltaMaxM=cov["deltaMax"],
                deltaMedianM=cov["deltaMedian"],
            ),
            exact={"pass": bool(ver["pass"]),
                   "checks": len(ver["checks"]),
                   "failures": [q["name"] for q in ver["checks"] if not q["ok"]],
                   "metrics": ver["metrics"]},
            engineTrace=dict(samples=int(eng["samples"]),
                             violations=len(eng["violations"]),
                             tightViolations=len(eng["tightViolations"]),
                             maxStepM=eng["maxStep"],
                             maxGrade=eng["maxGrade"]),
            reach=dict(reachable=bool(rea["reachable"]),
                       geodesicM=rea["geodesicM"],
                       straightLineM=rea["straightLineM"]),
            gapToCourse=gap,
            criteria=evaluation,
            failedCriteria=[e["id"] for e in evaluation if not e["pass"]],
            passedCriteria=[e["id"] for e in evaluation if e["pass"]],
        ))

    on_course = [c for c in candidates if c["component"] == course_cid]
    all_pass = [c for c in candidates if not c["failedCriteria"]]
    nearest = min((c for c in candidates if c["gapToCourse"]),
                  key=lambda c: c["gapToCourse"]["gapM"], default=None)

    course = dict(
        component=course_cid,
        cells=int(sizes[course_cid - 1]),
        areaM2=float(loops_doc["spawnComponent"]["areaM2"]),
        isSpawnComponent=True,
        pathSamples=int(loops_doc["pathComponents"]["samples"]),
        pathComponents=path_comps,
        enclosedIslands=int(loops_doc["spawnComponent"]["islands"]),
        islandsAtLeast100M2=int(loops_doc["spawnComponent"]["islandsAtLeast100M2"]),
        largestIslandM2=float(loops_doc["spawnComponent"]["largestIslandM2"]),
        loopsInComponent=list(loops_doc["spawnComponent"]["loopsInSpawnComponent"]),
        islandThresholdM2=ISLAND_MIN_M2,
        conclusion=("the course component has no enclosed island >= 100 m2 "
                    "(largest 2.25 m2), so the same island-based search cannot "
                    "extract a closed loop on the course"),
    )

    physics = loops_doc["inputs"]["physics"]
    physics_sha = file_sha256(ROOT / physics["path"])
    if physics_sha != "sha256:" + physics["sha256"]:
        raise SystemExit("the physics file does not match the recorded SHA-256")
    if len(phys_bytes) != physics["bytes"]:
        raise SystemExit("the physics file size does not match the recorded size")

    sources = {
        "physics": dict(path=physics["path"], bytes=len(phys_bytes),
                        sha256=physics_sha),
        "loops": dict(path="_work/map-laps/%s/loops.json" % LEVEL,
                      bytes=loops_path.stat().st_size,
                      fileSha256=file_sha256(loops_path),
                      canonicalHash=loops_doc["hash"]),
        "coverage": dict(path="_work/map-laps/%s/coverage.json" % LEVEL,
                         bytes=coverage_path.stat().st_size,
                         fileSha256=file_sha256(coverage_path),
                         canonicalHash=coverage_doc["hash"]),
        "verify": dict(path="_work/map-laps/%s/verify.json" % LEVEL,
                       bytes=verify_path.stat().st_size,
                       fileSha256=file_sha256(verify_path),
                       canonicalHash=verify_doc["hash"]),
        "engineTrace": dict(path="_work/map-laps/%s/engine-trace.json" % LEVEL,
                            bytes=engine_path.stat().st_size,
                            fileSha256=file_sha256(engine_path),
                            canonicalHash=engine_doc["hash"]),
        "reach": dict(path="_work/map-laps/%s/reach.json" % LEVEL,
                      bytes=reach_path.stat().st_size,
                      fileSha256=file_sha256(reach_path),
                      canonicalHash=reach_doc["hash"]),
        "grid": dict(path="_work/map-laps/%s/grid.npz" % LEVEL,
                     bytes=grid_path.stat().st_size,
                     fileSha256=file_sha256(grid_path)),
        "parser": "probes/map-pipeline/tools/physics_scan.py (read-only import)",
        "exactTriangles": ("probes/map-laps/tools/verify_map_loops.py Index/"
                           "height_in_triangle (read-only import)"),
    }

    doc = dict(
        kind="map-laps.no-lap",
        version=1,
        level=LEVEL,
        map=MAP_ID,
        verdict=VERDICT,
        scope=dict(
            collisionOnly=True,
            drawGeometryRead=False,
            rendererClaim=False,
            vehiclePhysics=False,
            gameRun=False,
            lapDriven=False,
            note=("a collision-only decision document, not a lap layout: no gate "
                  "mesh, no race director, no lap timing, no car simulated"),
        ),
        bar=dict(
            source=("probes/map-laps loop-01 (usa_amboy) acceptance: the same "
                    "collision-only search, enclosed islands, clearance erosion, "
                    "exact triangles, engine trace and draw coverage"),
            amboy=dict(
                loop="loop-01", component=510, lengthM=284.4524,
                survivesErosion=5, erodeCells=3, minClearanceM=2.0,
                exact="PASS 9/9", engine="569 samples, 0 / 0",
                coverage=1.0, gapRuns=0, laps=3,
            ),
            criteria=criteria,
        ),
        course=course,
        candidates=candidates,
        decision=dict(
            rule=("a loop is a lap only if it meets every bar criterion; the "
                  "decisive topology test is that it lies in the component the "
                  "measured point-to-point path uses"),
            loopsFound=len(candidates),
            loopsOnCourse=len(on_course),
            loopsMeetingAllCriteria=len(all_pass),
            nearestLoop=(nearest["id"] if nearest else None),
            nearestGapM=(nearest["gapToCourse"]["gapM"] if nearest else None),
            reason=("the course component 171 has no enclosed island >= 100 m2 "
                    "(largest 2.25 m2); the three extracted loops are all in "
                    "other components and unreachable from the committed spawn; "
                    "the nearest (loop-01) is 1.581139 m away across a ramp whose "
                    "raster neighbour dh is 5.179 cm per 0.5 m cell (limit "
                    "2.5 cm) and whose exact grade is 6.18 % average / 9.76 % "
                    "over 0.5 m (limit 5 %); loop-02 and loop-03 are 420.8102 m "
                    "and 315.0127 m away and 0.000 / 0.209 drawn"),
        ),
        sources=sources,
    )
    doc = canon(doc)
    doc["hash"] = canonical_hash(doc)

    text = json.dumps(doc, indent=1, ensure_ascii=False) + "\n"
    encoded = text.encode("utf-8")
    if args.check:
        if not args.out.exists():
            print("MISSING %s" % args.out)
            return 1
        if args.out.read_bytes() != encoded:
            print("STALE %s" % args.out)
            return 1
        print("OK %s" % args.out)
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(encoded)
    try:
        output = str(args.out.relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        output = str(args.out)
    print(json.dumps({
        "output": output,
        "bytes": len(encoded),
        "hash": doc["hash"],
        "verdict": doc["verdict"],
        "courseComponent": course_cid,
        "loopsFound": len(candidates),
        "loopsOnCourse": len(on_course),
        "loopsMeetingAllCriteria": len(all_pass),
        "candidates": [dict(id=c["id"], component=c["component"],
                            lengthM=c["lengthM"],
                            failed=c["failedCriteria"]) for c in candidates],
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
