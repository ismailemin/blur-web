#!/usr/bin/env python3
"""P61 lap search: closed collision-only loops on USA LA River.

Reuses the P48 traversability model (docs/work/analysis/drivable-path.md §3.1)
but asks a different question: does any connected component of the passable
collision surface contain an enclosed island, i.e. a ring a car can drive
around? Every component is considered, not only the spawn component.

Model (P48 constants, 0.5 m):
  * surface: up-facing triangle normal.y > 0.94 (<= 20 deg)
  * passable: surface in all 8 neighbours, max neighbour dh <= 2.5 cm (5 %)
  * wall mask: |normal.y| < 0.5, height band ground+0.05..2.0 m, dilated 0.5 m

A lap is a closed cell-graph cycle that encloses an island of non-passable
collision surface. Trivial 4-cell raster cycles are excluded by requiring the
island to be at least ISLAND_MIN_M2 and by requiring the ring to survive
clearance erosion.

Ring criterion: erode the passable mask by k 8-connected layers. A base island
that is still enclosed after k erosions has a ring at least k cells from every
non-passable cell (Chebyshev, hence a Euclidean lower bound). With k >= 2 the
nearest retained cell is (k+1)*0.5 m from the blocked set, so k=2 already
exceeds the 1.138 m car half-width; k=3 is used for the reported lap line.

Outputs (all under _work/lap-search/):
  loops.json   islands, loops, metrics, components, barriers, hashes
  loops.svg    top-down map (overview + zoom)
  loops.png    the same map rendered with Pillow
  grid.npz     base pass / wall / height rasters

    python probes/lap-search/tools/build_loops.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
sys.path.insert(0, str(ROOT / "probes/lap-search/tools"))
import reference_oracle as oracle  # noqa: E402
from raster import (  # noqa: E402
    flatten_triangles, triangle_normals, rasterise_height, edge_max_dh,
    rasterise_wall, erode, label_components, enclosed_islands,
)

PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
OUT = ROOT / "_work/lap-search"

CELL = 0.5
SURFACE_MIN_NY = 0.94
STEP_LIMIT = 0.05
GRADE_LIMIT = 0.05
EDGE_DH = min(STEP_LIMIT, GRADE_LIMIT * CELL)          # 0.025 m
WALL_DILATE = 0.5
ISLAND_MIN_M2 = 100.0                                   # meaningful obstacle
ISLAND_MIN_CELLS = int(round(ISLAND_MIN_M2 / (CELL * CELL)))
LOOP_ERODE = 3                                          # clearance >= 2.0 m
MAX_ERODE = 8
SPAWN = (-88.0, 1050.0)
CAR_LENGTH = 2.981
CAR_WIDTH = 1.676
SAFETY_MARGIN = 0.30
HALF_LENGTH = CAR_LENGTH / 2.0 + SAFETY_MARGIN          # 1.7905
HALF_WIDTH = CAR_WIDTH / 2.0 + SAFETY_MARGIN            # 1.138
NEED_WIDTH = CAR_WIDTH + 2.0 * SAFETY_MARGIN            # 2.276

DIRS8 = [(0, -1), (-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1)]


# --------------------------------------------------------------------------
# closed-path extraction
# --------------------------------------------------------------------------

def moore_trace(mask):
    """Ordered outer boundary pixels of one 8-connected region (Moore trace)."""
    ys, xs = np.nonzero(mask)
    j0 = int(ys[0])
    i0 = int(xs[ys == ys[0]][0])
    start = (j0, i0)
    b = start
    c = (j0, i0 - 1)
    contour = [start]
    seen = set()
    while True:
        k = DIRS8.index((c[0] - b[0], c[1] - b[1]))
        found = False
        for t in range(1, 9):
            kk = (k + t) % 8
            nb = (b[0] + DIRS8[kk][0], b[1] + DIRS8[kk][1])
            if 0 <= nb[0] < mask.shape[0] and 0 <= nb[1] < mask.shape[1] and mask[nb]:
                c = (b[0] + DIRS8[(kk - 1) % 8][0], b[1] + DIRS8[(kk - 1) % 8][1])
                b = nb
                found = True
                break
        if not found:
            break
        state = (b, c)
        if state in seen:
            break
        seen.add(state)
        contour.append(b)
        if b == start and len(contour) > 4:
            break
    return contour


def map_to_foreground(contour, mask):
    """Map boundary pixels of the island to the adjacent foreground cells.

    Continuity is preserved by preferring the candidate nearest the previous
    chosen cell. The island at erosion k is at least 2k+1 cells thick, so the
    two sides cannot be confused.
    """
    nz, nx = mask.shape
    out = []
    prev = None
    for (j, i) in contour:
        cands = []
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                if dj == 0 and di == 0:
                    continue
                y, x = j + dj, i + di
                if 0 <= y < nz and 0 <= x < nx and mask[y, x]:
                    cands.append((y, x))
        if not cands:
            continue
        if prev is None:
            cands.sort()
            pick = cands[0]
        else:
            cands.sort(key=lambda q: (abs(q[0] - prev[0]) + abs(q[1] - prev[1]), q))
            pick = cands[0]
        out.append(pick)
        prev = pick
    return out


def line_of_sight(mask, a, b):
    j0, i0 = a
    j1, i1 = b
    steps = max(abs(j1 - j0), abs(i1 - i0))
    if steps == 0:
        return bool(mask[j0, i0])
    for k in range(steps + 1):
        t = k / steps
        j = int(round(j0 + (j1 - j0) * t))
        i = int(round(i0 + (i1 - i0) * t))
        if not mask[j, i]:
            return False
    return True


def simplify_cyclic(mask, cells, passes=4):
    """Corner-cut an ordered closed cell ring, keeping every chord inside `mask`."""
    pts = []
    for c in cells:
        if not pts or c != pts[-1]:
            pts.append(c)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    for _ in range(passes):
        n = len(pts)
        if n < 8:
            break
        # rotate so the seam is not at a corner being removed in this pass
        pts = pts[1:] + pts[:1]
        out = [pts[0]]
        for i in range(1, n - 1):
            a = out[-1]
            b = pts[i]
            c = pts[i + 1]
            if (line_of_sight(mask, a, c)
                    and math.hypot(c[0] - a[0], c[1] - a[1])
                    <= math.hypot(b[0] - a[0], b[1] - a[1])
                    + math.hypot(c[0] - b[0], c[1] - b[1]) - 1e-9):
                continue
            out.append(b)
        out.append(pts[-1])
        # close the seam only when visible
        while len(out) > 2 and not line_of_sight(mask, out[-1], out[0]):
            break
        pts = out
    # drop duplicate closing point
    if len(pts) > 1 and pts[-1] == pts[0]:
        pts.pop()
    return pts


def resample_closed(points, step):
    """Resample a closed polyline at `step`; the first point is repeated at the end."""
    out = []
    for a, b in zip(points, points[1:]):
        l = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(math.ceil(l / step)))
        for k in range(n):
            t = k / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    out.append(points[-1])
    return out


# --------------------------------------------------------------------------
# raster metrics
# --------------------------------------------------------------------------

def raster_metrics(samples, H, xs, zs, base, cell):
    nz, nx = H.shape
    hs = []
    for x, z in samples:
        i = int(round((x - xs[0]) / cell))
        j = int(round((z - zs[0]) / cell))
        hs.append(float(H[j, i]) if 0 <= j < nz and 0 <= i < nx else float("nan"))
    max_step = 0.0
    for a, b in zip(hs, hs[1:]):
        if math.isfinite(a) and math.isfinite(b):
            max_step = max(max_step, abs(b - a))
    n = len(samples)
    max_grade = 0.0
    for a in range(n - 1):
        m = a
        acc = 0.0
        while m + 1 < n and acc < 2.0:
            acc += math.hypot(samples[m + 1][0] - samples[m][0],
                              samples[m + 1][1] - samples[m][1])
            m += 1
        if acc >= 1.9 and math.isfinite(hs[a]) and math.isfinite(hs[m]):
            max_grade = max(max_grade, abs(hs[m] - hs[a]) / acc)
    blocked = ~base
    min_clear = float("inf")
    min_clear_at = 0
    for k, (x, z) in enumerate(samples):
        i = int(round((x - xs[0]) / cell))
        j = int(round((z - zs[0]) / cell))
        rad = 14
        j0, j1 = max(0, j - rad), min(nz, j + rad + 1)
        i0, i1 = max(0, i - rad), min(nx, i + rad + 1)
        sub = blocked[j0:j1, i0:i1]
        if sub.any():
            jj, ii = np.where(sub)
            d = np.sqrt(((jj + j0 - j) * cell) ** 2 + ((ii + i0 - i) * cell) ** 2)
            md = float(d.min())
            if md < min_clear:
                min_clear = md
                min_clear_at = k
    return dict(maxStep=round(max_step, 6), maxGrade=round(max_grade, 6),
                minClearance=round(min_clear, 4), minClearanceAt=min_clear_at,
                groundMin=round(float(np.nanmin(hs)), 4),
                groundMax=round(float(np.nanmax(hs)), 4),
                groundRange=round(float(np.nanmax(hs) - np.nanmin(hs)), 4))


# --------------------------------------------------------------------------
# component / barrier helpers
# --------------------------------------------------------------------------

def component_boundary(lab, cid):
    m = lab == cid
    p = np.pad(m, 1, constant_values=False)
    inner = (p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1]
             & p[1:-1, :-2] & p[1:-1, 2:])
    return np.argwhere(m & ~inner)


def nearest_gap(lab, a, b):
    A = component_boundary(lab, a)
    B = component_boundary(lab, b)
    best = (1e18, None, None)
    for k0 in range(0, len(A), 400):
        chunk = A[k0:k0 + 400].astype(np.float64)
        d2 = ((chunk[:, None, 0] - B[None, :, 0].astype(np.float64)) ** 2
              + (chunk[:, None, 1] - B[None, :, 1].astype(np.float64)) ** 2)
        idx = np.unravel_index(np.argmin(d2), d2.shape)
        if d2[idx] < best[0]:
            best = (d2[idx], A[k0 + idx[0]], B[idx[1]])
    d, pa, pb = best
    return (math.sqrt(d), tuple(int(v) for v in pa), tuple(int(v) for v in pb))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--cell", type=float, default=CELL)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)
    cell = args.cell
    out_dir = args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    level = oracle.load_level(PHYSICS.read_bytes())
    tris = flatten_triangles(level)
    nrm = triangle_normals(tris)
    surface = tris[nrm[:, 1] > SURFACE_MIN_NY]
    wall = tris[np.abs(nrm[:, 1]) < 0.5]
    p = tris.reshape(-1, 3)
    x0 = math.floor(p[:, 0].min()) - 2
    x1 = math.ceil(p[:, 0].max()) + 2
    z0 = math.floor(p[:, 2].min()) - 2
    z1 = math.ceil(p[:, 2].max()) + 2
    H, xs, zs = rasterise_height(surface, x0, x1, z0, z1, cell)
    dh = edge_max_dh(H)
    W = rasterise_wall(wall, H, x0, x1, z0, z1, cell, WALL_DILATE)
    edge_dh = min(STEP_LIMIT, GRADE_LIMIT * cell)
    base = np.isfinite(H) & (dh <= edge_dh + 1e-9) & ~W
    print("raster %.1fs base cells %d" % (time.time() - t0, int(base.sum())), flush=True)

    lab, sizes = label_components(base, conn=8)
    spawn_j = int(round((SPAWN[1] - zs[0]) / cell))
    spawn_i = int(round((SPAWN[0] - xs[0]) / cell))
    spawn_cid = int(lab[spawn_j, spawn_i])
    print("components %d spawn comp %d cells %d"
          % (len(sizes), spawn_cid, sizes[spawn_cid - 1]), flush=True)

    blab0, _ = label_components(~base, conn=4)
    islands0 = enclosed_islands(base, lab)
    big = [h for h in islands0 if h["size"] >= ISLAND_MIN_CELLS]
    print("islands %d, >= %.0f m2: %d" % (len(islands0), ISLAND_MIN_M2, len(big)), flush=True)

    # Erosion survival per island (max k such that the base island stays enclosed).
    coords0 = {i: np.argwhere(blab0 == h["bgLabel"]) for i, h in enumerate(big)}
    surv = {}
    for k in range(1, MAX_ERODE + 1):
        F = erode(base, k)
        lf, sf = label_components(F, conn=8)
        isf = enclosed_islands(F, lf)
        bl = label_components(~F, conn=4)[0]
        for idx, h in enumerate(big):
            need = 0.5 * h["size"]
            cc = coords0[idx]
            best = 0
            for q in isf:
                if q["size"] < need:
                    continue
                lab_at = bl[cc[:, 0], cc[:, 1]]
                ov = int(np.count_nonzero(lab_at == q["bgLabel"]))
                if ov > best:
                    best = ov
            if best >= need:
                surv[idx] = k
        print("  erosion %d done (%.1fs)" % (k, time.time() - t0), flush=True)

    rows = []
    for idx, h in enumerate(big):
        maxk = surv.get(idx, 0)
        x0i, x1i, z0i, z1i = h["bbox"]
        im = blab0 == h["bgLabel"]
        no_surface = int((im & ~np.isfinite(H)).sum())
        steep = int((im & W).sum())
        step = int((im & np.isfinite(H) & ~W & (dh > edge_dh + 1e-9)).sum())
        other = int(h["size"]) - no_surface - steep - step
        rows.append(dict(
            island=dict(
                cells=int(h["size"]), areaM2=round(h["size"] * cell * cell, 2),
                bgLabel=int(h["bgLabel"]),
                bbox=[float(xs[x0i]), float(xs[x1i]), float(zs[z0i]), float(zs[z1i])],
                centroid=[float(xs[int(round(h["centroid"][0]))]),
                          float(zs[int(round(h["centroid"][1]))])],
                component=int(h["owner"]), componentCells=int(sizes[h["owner"] - 1]) if h["owner"] else 0,
                blockedBy=dict(noSurfaceCells=no_surface, steepCells=steep,
                               stepOrGradeCells=step, neighbourRuleCells=other),
            ),
            survivesErosion=maxk,
            ringHalfWidthLowerBoundM=round(maxk * cell, 2),
        ))

    # Build a loop for every island that survives k>=2.
    loops = []
    for idx, row in enumerate(rows):
        maxk = row["survivesErosion"]
        if maxk < 2:
            row["loop"] = None
            row["reject"] = "ring narrower than the 2.276 m car envelope (island is not enclosed after 0.5 m erosion)"
            continue
        k = min(LOOP_ERODE, maxk)
        F = erode(base, k)
        lf, sf = label_components(F, conn=8)
        isf = enclosed_islands(F, lf)
        bl = label_components(~F, conn=4)[0]
        source = big[idx]
        cc = coords0[idx]
        best = (0, None)
        for q in isf:
            lab_at = bl[cc[:, 0], cc[:, 1]]
            ov = int(np.count_nonzero(lab_at == q["bgLabel"]))
            if ov > best[0]:
                best = (ov, q)
        if best[1] is None or best[0] < 0.5 * source["size"]:
            row["loop"] = None
            row["reject"] = "no matching eroded island"
            continue
        isl = best[1]
        I = bl == isl["bgLabel"]
        contour = moore_trace(I)
        fg = map_to_foreground(contour, F)
        simp = simplify_cyclic(F, fg, passes=4)
        pts = [(float(xs[c[1]]), float(zs[c[0]])) for c in simp]
        if pts[0] != pts[-1]:
            seam = math.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1])
            pts.append(pts[0])
        else:
            seam = 0.0
        if not line_of_sight(F, simp[-1], simp[0]):
            row["loop"] = None
            row["reject"] = "closing seam leaves the passable mask"
            continue
        samples = resample_closed(pts, 0.25)
        length = sum(math.hypot(b[0] - a[0], b[1] - a[1])
                     for a, b in zip(samples, samples[1:]))
        met = raster_metrics(samples, H, xs, zs, base, cell)
        loop = dict(
            id="loop-%02d" % (len(loops) + 1),
            islandIndex=idx,
            erodeCells=k,
            tight=(k < LOOP_ERODE),
            clearanceLowerBoundM=round((k + 1) * cell, 2),
            length=round(length, 4),
            samples=len(samples),
            closureSeam=round(seam, 4),
            closed=True,
            component=int(source["owner"]),
            points=[[round(x, 4), round(z, 4)] for x, z in samples],
            **met,
        )
        loops.append(loop)
        row["loop"] = loop["id"]
        print("  loop %s island %d: %.3f m, comp %d, maxstep %.4f, maxgrade %.3f%%"
              % (loop["id"], idx, length, source["owner"], met["maxStep"],
                 100 * met["maxGrade"]), flush=True)

    # Rank loops by length.
    loops.sort(key=lambda q: -q["length"])
    for rank, loop in enumerate(loops, start=1):
        loop["rank"] = rank

    # "Best" = longest loop whose island is a real obstacle (>=10 % void or steep
    # cells, not only a rough step/grade patch) and whose ring survives >=3
    # erosions. `longestLoop` is recorded separately so the rule is visible.
    best = None
    for loop in loops:
        row = rows[loop["islandIndex"]]
        blocked = row["island"]["blockedBy"]
        real_cells = blocked["noSurfaceCells"] + blocked["steepCells"]
        loop["islandRealBarrier"] = bool(real_cells >= 0.10 * row["island"]["cells"]
                                         and row["survivesErosion"] >= LOOP_ERODE)
        loop["recommended"] = False
        if loop["islandRealBarrier"] and (best is None or loop["length"] > best["length"]):
            best = loop
    if best is None:
        best = loops[0]
    best["recommended"] = True
    longest = loops[0]

    # Component / barrier records for every loop component.
    comps = {}
    for loop in loops:
        cid = loop["component"]
        if cid in comps:
            continue
        jj, ii = np.where(lab == cid)
        rec = dict(id=int(cid), cells=int(sizes[cid - 1]),
                   areaM2=round(sizes[cid - 1] * cell * cell, 2),
                   bbox=[float(xs[ii.min()]), float(xs[ii.max()]),
                         float(zs[jj.min()]), float(zs[jj.max()])],
                   isSpawnComponent=(cid == spawn_cid))
        if cid != spawn_cid:
            d, pa, pb = nearest_gap(lab, spawn_cid, cid)
            rec["nearestToSpawn"] = dict(
                gapM=round(d * cell, 4),
                fromCell=[int(pa[0]), int(pa[1])],
                toCell=[int(pb[0]), int(pb[1])],
                fromWorld=[round(float(xs[pa[1]]), 3), round(float(zs[pa[0]]), 3)],
                toWorld=[round(float(xs[pb[1]]), 3), round(float(zs[pb[0]]), 3)],
                needWidthM=round(NEED_WIDTH, 3),
                gapWiderThanCar=bool(d * cell >= NEED_WIDTH),
                barrier="separate connected component of the passable collision mask; no passable cell path exists between it and the spawn component",
            )
        comps[cid] = rec

    spawn_islands = [h for h in islands0 if h["owner"] == spawn_cid]
    spawn_rec = dict(
        id=spawn_cid, cells=int(sizes[spawn_cid - 1]),
        areaM2=round(sizes[spawn_cid - 1] * cell * cell, 2),
        islands=len(spawn_islands),
        largestIslandM2=round(max((h["size"] for h in spawn_islands), default=0) * cell * cell, 2),
        islandsAtLeast100M2=sum(1 for h in spawn_islands if h["size"] >= ISLAND_MIN_CELLS),
    )

    phys_sha = hashlib.sha256(PHYSICS.read_bytes()).hexdigest()
    doc = dict(
        kind="lap-search.loops",
        version=1,
        scope=dict(
            collisionOnly=True,
            drawGeometryRead=False,
            rendererClaim=False,
            vehiclePhysics=False,
            gameRun=False,
            engineTrace="separate artifact engine-trace.json",
            note="closed collision-only loops from Level.levelphysics; no draw coverage or renderer claim",
        ),
        inputs=dict(
            physics=dict(path="game-data/Blur/levels/usa_la_river/Level.levelphysics",
                         bytes=PHYSICS.stat().st_size, sha256=phys_sha),
            spawn=dict(x=SPAWN[0], z=SPAWN[1]),
            carEnvelope=dict(length=CAR_LENGTH, width=CAR_WIDTH,
                             safetyMargin=SAFETY_MARGIN,
                             halfLength=HALF_LENGTH, halfWidth=HALF_WIDTH,
                             needWidth=NEED_WIDTH),
        ),
        model=dict(
            cell=cell, surfaceMinNormalY=SURFACE_MIN_NY,
            surfaceMinNormalDeg=round(math.degrees(math.acos(SURFACE_MIN_NY)), 4),
            stepLimit=STEP_LIMIT, gradeLimit=GRADE_LIMIT, edgeDhLimit=edge_dh,
            wallMask="steep |ny|<0.5, height band ground+0.05..2.0 m, XZ dilated 0.5 m",
            islandMinM2=ISLAND_MIN_M2,
            loopErodeCells=LOOP_ERODE,
            ringCriterion="island still enclosed after k 8-connected erosions; retained cells are >=(k+1)*0.5 m from blocked cells",
            search="all base-passable components; enclosed 4-connected background islands",
            sampleStep=0.25,
        ),
        raster=dict(shape=[int(H.shape[0]), int(H.shape[1])],
                    x0=float(xs[0]), z0=float(zs[0]), cell=cell),
        components=dict(total=len(sizes), passableCells=int(base.sum()),
                        passableAreaM2=round(float(base.sum()) * cell * cell, 2)),
        spawnComponent=spawn_rec,
        islands=rows,
        loops=loops,
        loopComponents=list(comps.values()),
        bestLoop=best["id"] if loops else None,
        longestLoop=longest["id"] if loops else None,
        result=dict(
            loopFound=bool(loops),
            loopInSpawnComponent=any(q["component"] == spawn_cid for q in loops),
            bestLoopM=best["length"] if loops else None,
            longestLoopM=longest["length"] if loops else None,
            bestReason=("longest loop whose island has >=10 % void or steep cells "
                        "(a real obstacle) and whose ring survives >=3 clearance erosions"),
        ),
    )
    body = json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    doc["hash"] = "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
    (out_dir / "loops.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n",
                                        encoding="utf-8")
    np.savez_compressed(out_dir / "grid.npz", base=base, wall=W,
                        height=H.astype(np.float32), xs=xs, zs=zs)
    print("wrote", out_dir / "loops.json", "hash", doc["hash"])
    print("result", json.dumps(doc["result"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
