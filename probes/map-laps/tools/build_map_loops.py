#!/usr/bin/env python3
"""Generalized P61 lap search for the point-to-point maps.

Builds the collision passability raster (P48 model, 0.5 m), labels every
8-connected component, finds enclosed 4-connected islands, measures how many
clearance erosions each island survives, and extracts a closed loop line at
`k = min(3, survival)` for every island >= 100 m2.

    python probes/map-laps/tools/build_map_loops.py --level usa_amboy
    python probes/map-laps/tools/build_map_loops.py --level spa_barcelona_gracia

Outputs under `_work/map-laps/<level>/`:
    loops.json   components, islands, loops, spawn/path component, barriers
    grid.npz     height / base / wall / dh rasters

No draw geometry is read. No renderer, vehicle-physics or game claim is made.
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from map_laps_common import (  # noqa: E402
    ROOT, LEVELS, CELL, SURFACE_MIN_NY, STEP_LIMIT, GRADE_LIMIT, WALL_DILATE,
    ISLAND_MIN_M2, ISLAND_MIN_CELLS, LOOP_ERODE, MAX_ERODE, SAMPLE_STEP,
    CAR_LENGTH, CAR_WIDTH, SAFETY_MARGIN, HALF_LENGTH, HALF_WIDTH, NEED_WIDTH,
    load_level, flatten_static, build_raster, erode, label_components,
    enclosed_islands, eroded_background, island_still_enclosed, moore_trace,
    map_to_foreground, simplify_cyclic, resample_closed, loop_metrics,
    path_component, json_hash, write_json, out_dir,
)

MAX_LOOPS = 80            # extraction cap; islands are ranked by area
CLEARANCE_WINDOW_M = 20.0


def component_boundary(lab, cid):
    m = lab == cid
    p = np.pad(m, 1, constant_values=False)
    inner = (p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1]
             & p[1:-1, :-2] & p[1:-1, 2:])
    return np.argwhere(m & ~inner)


def nearest_gap(lab, a, b):
    A = component_boundary(lab, a)
    B = component_boundary(lab, b)
    if len(A) == 0 or len(B) == 0:
        return None
    best = (1e18, None, None)
    Bf = B.astype(np.float64)
    for k0 in range(0, len(A), 512):
        chunk = A[k0:k0 + 512].astype(np.float64)
        d2 = ((chunk[:, None, 0] - Bf[None, :, 0]) ** 2
              + (chunk[:, None, 1] - Bf[None, :, 1]) ** 2)
        idx = np.unravel_index(np.argmin(d2), d2.shape)
        if d2[idx] < best[0]:
            best = (d2[idx], A[k0 + idx[0]], B[idx[1]])
    d, pa, pb = best
    return math.sqrt(d), tuple(int(v) for v in pa), tuple(int(v) for v in pb)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", required=True, choices=sorted(LEVELS))
    ap.add_argument("--cell", type=float, default=CELL)
    ap.add_argument("--max-loops", type=int, default=MAX_LOOPS)
    ap.add_argument("--step-limit", type=float, default=STEP_LIMIT,
                    help="max neighbour height difference (m); P48 = 0.05")
    ap.add_argument("--grade-limit", type=float, default=GRADE_LIMIT,
                    help="max edge grade; P48 = 0.05")
    ap.add_argument("--island-min-m2", type=float, default=ISLAND_MIN_M2)
    ap.add_argument("--tag", default="",
                    help="output subdirectory suffix, e.g. 'relaxed'")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args(argv)
    cell = args.cell
    level_name = args.level
    tag = args.tag
    outp = args.out or (out_dir(level_name) / tag if tag else out_dir(level_name))
    outp.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    def log(msg):
        print("[%7.1fs] %s" % (time.time() - t0, msg), flush=True)

    cfg, phys_path, phys_bytes, parsed = load_level(level_name)
    tris = flatten_static(parsed)
    log("physics %d bytes, %d static triangles (types 0/11)"
        % (len(phys_bytes), len(tris)))
    if len(tris) != cfg["triangles"]:
        raise SystemExit("triangle count %d != committed %d (refusing to guess)"
                         % (len(tris), cfg["triangles"]))

    R = build_raster(tris, cell, log=log,
                     step_limit=args.step_limit, grade_limit=args.grade_limit)
    H, dh, W, base, xs, zs = R["H"], R["dh"], R["W"], R["base"], R["xs"], R["zs"]
    edge_dh = R["edge_dh"]
    island_min_cells = int(round(args.island_min_m2 / (cell * cell)))
    log("base passable cells %d (%.1f m2)"
        % (int(base.sum()), base.sum() * cell * cell))

    lab, sizes = label_components(base, conn=8)
    log("components %d" % len(sizes))

    spawn = cfg["spawn"]
    sj = int(round((spawn["z"] - zs[0]) / cell))
    si = int(round((spawn["x"] - xs[0]) / cell))
    spawn_cid = int(lab[sj, si])
    log("spawn %s cell (%d,%d) component %d cells %d"
        % ((spawn["x"], spawn["z"]), sj, si, spawn_cid, sizes[spawn_cid - 1]
           if spawn_cid else 0))

    path_doc = json.loads((ROOT / cfg["pathDoc"]).read_text())
    pc = path_component(path_doc, lab, xs, zs, cell)
    log("path components %s" % (pc["components"][:3],))

    islands0 = enclosed_islands(base, lab)
    log("islands total %d, >= %.0f m2: %d (cells %d)"
        % (len(islands0), args.island_min_m2,
           sum(1 for h in islands0 if h["size"] >= island_min_cells),
           sum(h["size"] for h in islands0)))
    big = [h for h in islands0 if h["size"] >= island_min_cells]

    # --- erosion survival ------------------------------------------------
    blab0, _ = label_components(~base, conn=4)
    log("background labelled (%d regions)" % int(blab0.max()))
    coords0 = [_island_coords(blab0, h) for h in big]
    surv = {}
    for k in range(1, MAX_ERODE + 1):
        Fk, blabk, borderk = eroded_background(base, k)
        enclosed_now = 0
        for idx in range(len(big)):
            if island_still_enclosed(blabk, borderk, coords0[idx]):
                enclosed_now += 1
                surv[idx] = k          # survival = the LAST k that stays enclosed
        del Fk, blabk
        log("erosion %d done, islands still enclosed %d/%d"
            % (k, enclosed_now, len(big)))
        if enclosed_now == 0:
            break

    rows = []
    for idx, h in enumerate(big):
        x0i, x1i, z0i, z1i = h["bbox"]
        im = blab0[z0i:z1i + 1, x0i:x1i + 1] == h["bgLabel"]
        Hsub = H[z0i:z1i + 1, x0i:x1i + 1]
        Wsub = W[z0i:z1i + 1, x0i:x1i + 1]
        dhsub = dh[z0i:z1i + 1, x0i:x1i + 1]
        no_surface = int((im & ~np.isfinite(Hsub)).sum())
        steep = int((im & Wsub).sum())
        step = int((im & np.isfinite(Hsub) & ~Wsub & (dhsub > edge_dh + 1e-9)).sum())
        other = int(h["size"]) - no_surface - steep - step
        maxk = surv.get(idx, 0)
        rows.append(dict(
            island=dict(
                cells=int(h["size"]), areaM2=round(h["size"] * cell * cell, 2),
                bgLabel=int(h["bgLabel"]),
                bbox=[float(xs[x0i]), float(xs[x1i]), float(zs[z0i]), float(zs[z1i])],
                component=int(h["owner"]),
                componentCells=int(sizes[h["owner"] - 1]) if h["owner"] else 0,
                blockedBy=dict(noSurfaceCells=no_surface, steepCells=steep,
                               stepOrGradeCells=step, neighbourRuleCells=other),
            ),
            survivesErosion=int(maxk),
            ringHalfWidthLowerBoundM=round(maxk * cell, 2),
        ))
    log("survival table done")

    # --- loop extraction --------------------------------------------------
    order = sorted(range(len(rows)), key=lambda i: -rows[i]["island"]["cells"])
    loops = []
    erode_cache = {}
    for idx in order:
        row = rows[idx]
        if len(loops) >= args.max_loops:
            row["loop"] = None
            row["reject"] = "not extracted: extraction cap %d reached" % args.max_loops
            continue
        maxk = row["survivesErosion"]
        if maxk < 2:
            row["loop"] = None
            row["reject"] = ("island does not survive 2 clearance erosions "
                             "(no 1.5 m loop line)")
            continue
        k = min(LOOP_ERODE, maxk)
        if k not in erode_cache:
            erode_cache[k] = eroded_background(base, k)
        F, blab_k, border = erode_cache[k]
        coords = coords0[idx]
        labs = blab_k[coords[:, 0], coords[:, 1]]
        vals, cnts = np.unique(labs, return_counts=True)
        pick = None
        best = 0
        for v, c in zip(vals.tolist(), cnts.tolist()):
            if v == 0 or v in border:
                continue
            if c > best:
                best, pick = c, v
        if pick is None or best < 0.5 * len(coords):
            row["loop"] = None
            row["reject"] = "no matching eroded island"
            continue
        I = blab_k == pick
        contour = moore_trace(I)
        fg = map_to_foreground(contour, F)
        if len(fg) < 8:
            row["loop"] = None
            row["reject"] = "boundary contour too short"
            continue
        simp = simplify_cyclic(F, fg, passes=4)
        if len(simp) < 4:
            row["loop"] = None
            row["reject"] = "simplified contour too short"
            continue
        pts = [(float(xs[c[1]]), float(zs[c[0]])) for c in simp]
        if pts[0] != pts[-1]:
            seam = math.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1])
            pts.append(pts[0])
        else:
            seam = 0.0
        if not (line_ok(simp, F)):
            row["loop"] = None
            row["reject"] = "closing seam leaves the passable mask"
            continue
        if seam > 1.0:
            row["loop"] = None
            row["reject"] = ("closure seam %.3f m exceeds the 1.0 m limit; "
                             "the ring does not close on the passable mask" % seam)
            continue
        samples = resample_closed(pts, SAMPLE_STEP)
        length = sum(math.hypot(b[0] - a[0], b[1] - a[1])
                     for a, b in zip(samples, samples[1:]))
        met = loop_metrics(samples, H, W, dh, xs, zs, cell, edge_dh)
        gnd = []
        for x, z in samples:
            i = int(round((x - xs[0]) / cell))
            j = int(round((z - zs[0]) / cell))
            if 0 <= j < H.shape[0] and 0 <= i < H.shape[1] and np.isfinite(H[j, i]):
                gnd.append(round(float(H[j, i]), 4))
            else:
                gnd.append(None)
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
            component=int(row["island"]["component"]),
            points=[[round(x, 4), round(z, 4)] for x, z in samples],
            ground=gnd,
            **{k2: (round(v, 6) if isinstance(v, float) else v)
               for k2, v in met.items()},
        )
        loops.append(loop)
        row["loop"] = loop["id"]
        log("  %s island %d comp %d: %.3f m, survive %d, maxstep %s, clearance %s"
            % (loop["id"], idx, loop["component"], length, maxk,
               loop["maxStep"], loop["minClearance"]))

    loops.sort(key=lambda q: -q["length"])
    for rank, loop in enumerate(loops, start=1):
        loop["rank"] = rank

    for loop in loops:
        row = rows[loop["islandIndex"]]
        blocked = row["island"]["blockedBy"]
        real_cells = blocked["noSurfaceCells"] + blocked["steepCells"]
        loop["islandRealBarrier"] = bool(
            real_cells >= 0.10 * row["island"]["cells"]
            and row["survivesErosion"] >= LOOP_ERODE)

    # --- components -------------------------------------------------------
    comp_loops = {}
    for loop in loops:
        comp_loops.setdefault(loop["component"], []).append(loop["id"])
    comp_islands = {}
    for idx, h in enumerate(islands0):
        comp_islands.setdefault(int(h["owner"]), []).append(idx)

    top = np.argsort(-np.asarray(sizes))[:12]
    comp_records = []
    for c in top.tolist():
        cid = c + 1
        bnd = component_boundary(lab, cid)
        comp_records.append(dict(
            id=int(cid), cells=int(sizes[c]),
            areaM2=round(sizes[c] * cell * cell, 2),
            bbox=[float(xs[bnd[:, 1].min()]), float(xs[bnd[:, 1].max()]),
                  float(zs[bnd[:, 0].min()]), float(zs[bnd[:, 0].max()])],
            islands=len(comp_islands.get(cid, [])),
            islandsAtLeast100M2=sum(1 for i in comp_islands.get(cid, [])
                                    if islands0[i]["size"] >= island_min_cells),
            loops=comp_loops.get(cid, []),
            isSpawnComponent=(cid == spawn_cid),
        ))

    spawn_islands = comp_islands.get(spawn_cid, [])
    spawn_rec = dict(
        id=spawn_cid, cells=int(sizes[spawn_cid - 1]) if spawn_cid else 0,
        areaM2=round(sizes[spawn_cid - 1] * cell * cell, 2) if spawn_cid else 0.0,
        islands=len(spawn_islands),
        islandsAtLeast100M2=sum(1 for i in spawn_islands
                                if islands0[i]["size"] >= island_min_cells),
        largestIslandM2=round(max((islands0[i]["size"] for i in spawn_islands),
                                  default=0) * cell * cell, 2),
        pathInSpawnComponent=any(r["component"] == spawn_cid for r in pc["components"]),
        loopsInSpawnComponent=comp_loops.get(spawn_cid, []),
    )

    barrier = None
    loop_comps = sorted(comp_loops)
    for cid in loop_comps:
        if cid == spawn_cid:
            continue
        g = nearest_gap(lab, spawn_cid, cid)
        if g is None:
            continue
        d, pa, pb = g
        barrier = dict(
            loopComponent=dict(id=int(cid), gapM=round(d * cell, 4),
                               cells=int(sizes[cid - 1]),
                               fromWorld=[round(float(xs[pa[1]]), 3), round(float(zs[pa[0]]), 3)],
                               toWorld=[round(float(xs[pb[1]]), 3), round(float(zs[pb[0]]), 3)],
                               needWidthM=round(NEED_WIDTH, 3),
                               gapWiderThanCar=bool(d * cell >= NEED_WIDTH)),
            note=("nearest passable cells of the spawn component and this loop "
                  "component; a gap is not a path"))
        break

    phys_sha = hashlib.sha256(phys_bytes).hexdigest()
    doc = dict(
        kind="map-laps.loops",
        version=1,
        level=level_name,
        modelLabel=("P48" if (args.step_limit == STEP_LIMIT
                              and args.grade_limit == GRADE_LIMIT) else "sensitivity-relaxed"),
        scope=dict(
            collisionOnly=True,
            drawGeometryRead=False,
            rendererClaim=False,
            vehiclePhysics=False,
            gameRun=False,
            engineTrace="separate artifact engine-trace.json",
            note=("closed collision-only loops from Level.levelphysics; no draw "
                  "coverage or renderer claim in this artifact"),
        ),
        inputs=dict(
            physics=dict(path=cfg["physics"], bytes=len(phys_bytes), sha256=phys_sha),
            parser="probes/map-pipeline/tools/physics_scan.py (read-only import)",
            rasterPrimitives="probes/lap-search/tools/raster.py (read-only import)",
            spawn=dict(x=spawn["x"], z=spawn["z"], heading=spawn["heading"],
                       source="map-slice spawn"),
            pathDoc=dict(path=cfg["pathDoc"], declaredLengthM=cfg["pathLengthM"]),
            carEnvelope=dict(length=CAR_LENGTH, width=CAR_WIDTH,
                             safetyMargin=SAFETY_MARGIN,
                             halfLength=HALF_LENGTH, halfWidth=HALF_WIDTH,
                             needWidth=NEED_WIDTH,
                             source=("documented maximum XT envelope (largest roster "
                                     "wheelbase 2.981 m; the project resolver uses a "
                                     "2.98 x 1.68 m box proxy) plus a labelled 0.30 m "
                                     "margin; not a recovered retail hull")),
            collisionShapes=dict(static=cfg["staticShapes"],
                                 notInRaster=cfg["undecodedShapes"]),
        ),
        model=dict(
            cell=cell, surfaceMinNormalY=SURFACE_MIN_NY,
            surfaceMinNormalDeg=round(math.degrees(math.acos(SURFACE_MIN_NY)), 4),
            stepLimit=args.step_limit, gradeLimit=args.grade_limit, edgeDhLimit=edge_dh,
            wallMask="steep |ny|<0.5, height band ground+0.05..2.0 m, XZ dilated 0.5 m",
            islandMinM2=args.island_min_m2,
            loopErodeCells=LOOP_ERODE,
            ringCriterion=("island still enclosed after k 8-connected erosions; "
                           "retained cells are >=(k+1)*0.5 m from blocked cells"),
            search="all base-passable components; enclosed 4-connected background islands",
            sampleStep=SAMPLE_STEP,
            clearanceWindowM=CLEARANCE_WINDOW_M,
        ),
        raster=dict(shape=[int(H.shape[0]), int(H.shape[1])],
                    x0=float(xs[0]), z0=float(zs[0]), cell=cell,
                    passableCells=int(base.sum()),
                    passableAreaM2=round(float(base.sum()) * cell * cell, 2)),
        components=dict(total=len(sizes), top=comp_records),
        spawnComponent=spawn_rec,
        pathComponents=pc,
        islandCounts=dict(total=len(islands0),
                          atLeast100M2=len(big),
                          cellsTotal=int(sum(h["size"] for h in islands0))),
        islands=rows,
        loops=loops,
        bestLoop=None,
        longestLoop=loops[0]["id"] if loops else None,
        nearestLoopComponentToSpawn=barrier,
        result=dict(
            loopFound=bool(loops),
            loopInSpawnComponent=bool(spawn_rec["loopsInSpawnComponent"]),
            spawnComponentIslands=spawn_rec["islands"],
            loopCount=len(loops),
        ),
    )

    # Ranking rule for the hand-off (documented, not silent):
    #   * the loop must be in a component the measured point-to-point path also
    #     uses (a lap is only useful where the course already is);
    #   * its island must be a real obstacle (>=10 % void/steep cells);
    #   * its ring must survive >= 3 clearance erosions (>= 2.0 m);
    #   * among those, the longest loop inside 150..1500 m wins.
    candidates = []
    for loop in loops:
        row = rows[loop["islandIndex"]]
        same_path = any(r["component"] == loop["component"] for r in pc["components"])
        length_ok = 150.0 <= loop["length"] <= 1500.0
        candidates.append((loop, same_path, length_ok))
    pool = [c for c in candidates if c[1] and c[2] and c[0]["islandRealBarrier"]]
    rule = ("longest loop in a component used by the measured point-to-point path, "
            "with an island that has >=10 % void/steep cells and a ring that "
            "survives >=3 clearance erosions, within 150..1500 m")
    if not pool:
        pool = [c for c in candidates if c[1] and c[2]]
        rule = ("fallback: no loop has an island with >=10 % void/steep cells; "
                "longest loop in a component used by the measured path, "
                "within 150..1500 m")
    if not pool:
        pool = [c for c in candidates if c[2]]
        rule = ("fallback: no loop shares a component with the measured path; "
                "longest loop within 150..1500 m")
    if not pool:
        pool = candidates
        rule = "fallback: longest loop of any length"
    best = max(pool, key=lambda c: c[0]["length"])[0] if pool else None
    if best is not None:
        best["recommended"] = True
        doc["bestLoop"] = best["id"]
        doc["result"]["bestLoopM"] = best["length"]
        doc["result"]["bestReason"] = rule
        for loop in loops:
            if loop is not best:
                loop["recommended"] = False

    doc["hash"] = json_hash(doc)
    write_json(outp / "loops.json", doc)
    np.savez_compressed(outp / "grid.npz", base=base, wall=W,
                        height=H.astype(np.float32), dh=dh.astype(np.float32),
                        xs=xs, zs=zs)
    log("wrote %s hash %s" % (outp / "loops.json", doc["hash"]))
    print(json.dumps(doc["result"]))
    return 0


def _island_coords(blab0, h):
    """Cell coordinates (row, col) of one enclosed background island."""
    x0i, x1i, z0i, z1i = h["bbox"]
    sub = blab0[z0i:z1i + 1, x0i:x1i + 1] == h["bgLabel"]
    jj, ii = np.nonzero(sub)
    jj = jj + z0i
    ii = ii + x0i
    idx = np.arange(len(jj))
    if len(idx) > 4000:
        idx = np.linspace(0, len(idx) - 1, 4000).astype(np.int64)
    return np.stack([jj[idx], ii[idx]], axis=1)


def line_ok(simp, F):
    from map_laps_common import line_of_sight
    return line_of_sight(F, simp[-1], simp[0])


if __name__ == "__main__":
    raise SystemExit(main())
