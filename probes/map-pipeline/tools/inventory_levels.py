#!/usr/bin/env python3
"""Deterministic collision/drivable inventory for all Blur level directories.

Read-only inputs:
  game-data/Blur/levels/<name>/Level.levelphysics
  game-data/Blur/levels/<name>/Level.levelrender / Level.levelstream (hashes only)
  probes/collision-oracle/tests/reference_oracle.py (tree/block primitives only)
  probes/map-pipeline/tools/physics_scan.py (documented shape-stream scanner)

Outputs:
  _work/map-pipeline/maps.json       per-level matrix
  _work/map-pipeline/grids/*.npz     1 m height / passable / component rasters
  _work/logs/map-pipeline/*.log

Model (same constants as the P48 drivable-path probe, at a coarser audit cell):
  * surface triangle normal.y > 0.94 (<= 20 deg)
  * edge height delta <= min(0.05 m, 0.05 * cell)
  * conservative wall mask: every steep triangle (|normal.y| < 0.5) whose height
    band reaches local ground +0.05..2.0 m, projected to its XZ bounding box
    and dilated by one cell. This over-blocks, so it can only shorten a path.
  * 8-connected component; geodesic diameter by two BFS passes.
No draw geometry, renderer, GPU, engine or playable-game claim is made.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from collections import deque
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-pipeline/tools"))
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
import physics_scan as scan  # noqa: E402
import reference_oracle as oracle  # noqa: E402

LEVELS_DIR = ROOT / "game-data/Blur/levels"
OUT = ROOT / "_work/map-pipeline"
GRIDS = OUT / "grids"
CELL = 1.0
SURFACE_MIN_NY = 0.94
GRADE_LIMIT = 0.05
STEP_LIMIT = 0.05
WALL_DILATE_CELLS = 1
RIVER_SPAWN = (-88.0, 1050.0)
AUDIT_MIN_PATH_M = 25.0


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def file_record(path: Path) -> dict:
    rec = {"exists": path.is_file()}
    if path.is_file():
        rec["bytes"] = path.stat().st_size
        rec["sha256"] = sha256_file(path)
    return rec


def flatten_top_level(level):
    """Top-level static triangle meshes only; fluid and composite sub-meshes are
    reported separately and never promoted to drivable surface."""
    tris = []
    per_mesh = []
    for mesh in level["shapes"]:
        if mesh.get("importType") not in (0, 11):
            continue
        verts = mesh["vertices"]
        before = len(tris)
        for tri in mesh["triangles"]:
            leaf = mesh["leaves"][tri["leaf"]]
            base = leaf["vertex_start"]
            tris.append((verts[base + tri["a"]], verts[base + tri["b"]],
                         verts[base + tri["c"]]))
        per_mesh.append({
            "index": mesh["index"], "importType": mesh["importType"],
            "importName": mesh["importName"], "triangles": len(tris) - before,
            "vertices": mesh["numVertices"], "nodes": mesh["numNodes"],
            "bounds": {"min": list(mesh["low"]), "max": list(mesh["high"])},
            "instanceIdentity": (
                mesh.get("position") == (0.0, 0.0, 0.0)
                and mesh.get("rotation") == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
            ),
        })
    return np.asarray(tris, dtype=np.float64), per_mesh


def triangle_normals(tris):
    u = tris[:, 1] - tris[:, 0]
    v = tris[:, 2] - tris[:, 0]
    n = np.cross(u, v)
    ln = np.linalg.norm(n, axis=1)
    ln[ln == 0] = 1.0
    return n / ln[:, None]


def rasterise_height(tris, x0, x1, z0, z1, cell):
    nx = int(round((x1 - x0) / cell)) + 1
    nz = int(round((z1 - z0) / cell)) + 1
    H = np.full((nz, nx), -np.inf)
    xs = x0 + np.arange(nx) * cell
    zs = z0 + np.arange(nz) * cell
    for t in tris:
        a, b, c = t
        den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
        if abs(den) < 1e-12:
            continue
        i0 = max(0, int(math.floor((min(a[0], b[0], c[0]) - x0) / cell)))
        i1 = min(nx - 1, int(math.ceil((max(a[0], b[0], c[0]) - x0) / cell)))
        j0 = max(0, int(math.floor((min(a[2], b[2], c[2]) - z0) / cell)))
        j1 = min(nz - 1, int(math.ceil((max(a[2], b[2], c[2]) - z0) / cell)))
        if i1 < i0 or j1 < j0:
            continue
        gx, gz = np.meshgrid(xs[i0:i1 + 1], zs[j0:j1 + 1])
        l1 = ((b[2] - c[2]) * (gx - c[0]) + (c[0] - b[0]) * (gz - c[2])) / den
        l2 = ((c[2] - a[2]) * (gx - c[0]) + (a[0] - c[0]) * (gz - c[2])) / den
        l3 = 1.0 - l1 - l2
        m = (l1 >= -1e-9) & (l2 >= -1e-9) & (l3 >= -1e-9)
        if not m.any():
            continue
        h = l1 * a[1] + l2 * b[1] + l3 * c[1]
        sub = H[j0:j1 + 1, i0:i1 + 1]
        sub[m] = np.maximum(sub[m], h[m])
    H[~np.isfinite(H)] = np.nan
    return H.astype(np.float32), xs.astype(np.float64), zs.astype(np.float64)


def edge_max_dh(H):
    nz, nx = H.shape
    out = np.zeros((nz, nx), dtype=np.float32)
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            if di == 0 and dj == 0:
                continue
            A = H[max(0, -dj):nz - max(0, dj), max(0, -di):nx - max(0, di)]
            B = H[max(0, dj):nz + min(0, dj), max(0, di):nx + min(0, di)]
            invalid = ~np.isfinite(A) | ~np.isfinite(B)
            d = np.where(invalid, np.inf, np.abs(np.nan_to_num(A - B, nan=0.0)))
            tgt = out[max(0, -dj):nz - max(0, dj), max(0, -di):nx - max(0, di)]
            np.fmax(tgt, d, out=tgt)
    return out


def wall_bbox_mask(wall_tris, H, x0, z0, cell, nx, nz):
    """Conservative: whole XZ bounding box of each blocking steep triangle."""
    W = np.zeros((nz, nx), dtype=bool)
    count = 0
    for t in wall_tris:
        t_ymin = min(t[0][1], t[1][1], t[2][1])
        t_ymax = max(t[0][1], t[1][1], t[2][1])
        i0 = max(0, int(math.floor((min(t[0][0], t[1][0], t[2][0]) - x0) / cell)) - WALL_DILATE_CELLS)
        i1 = min(nx - 1, int(math.ceil((max(t[0][0], t[1][0], t[2][0]) - x0) / cell)) + WALL_DILATE_CELLS)
        j0 = max(0, int(math.floor((min(t[0][2], t[1][2], t[2][2]) - z0) / cell)) - WALL_DILATE_CELLS)
        j1 = min(nz - 1, int(math.ceil((max(t[0][2], t[1][2], t[2][2]) - z0) / cell)) + WALL_DILATE_CELLS)
        if i1 < i0 or j1 < j0:
            continue
        Hsub = H[j0:j1 + 1, i0:i1 + 1]
        finite = np.isfinite(Hsub)
        if not finite.any():
            continue
        # Height gate: the face must reach the local ground band.
        gate = finite & (t_ymin < Hsub + 2.0) & (t_ymax > Hsub + 0.05)
        if not gate.any():
            continue
        W[j0:j1 + 1, i0:i1 + 1] |= gate
        count += 1
    return W, count


def component_label(passable):
    """8-connected component labels using a padded flat grid (boundary-safe)."""
    nz, nx = passable.shape
    nxp = nx + 2
    pad = np.zeros((nz + 2, nxp), dtype=bool)
    pad[1:-1, 1:-1] = passable
    flat = pad.ravel()
    comp = np.full(flat.size, -1, dtype=np.int32)
    offs = (-nxp - 1, -nxp, -nxp + 1, -1, 1, nxp - 1, nxp, nxp + 1)
    sizes = []
    bboxes = []
    cid = 0
    for seed in np.flatnonzero(flat):
        if comp[seed] != -1:
            continue
        cid += 1
        comp[seed] = cid
        q = deque([int(seed)])
        size = 0
        # bbox tracking on padded coordinates
        si = int(seed % nxp)
        sj = int(seed // nxp)
        minx = maxx = si
        minz = maxz = sj
        while q:
            cur = q.popleft()
            size += 1
            ci = cur % nxp
            cj = cur // nxp
            if ci < minx: minx = ci
            if ci > maxx: maxx = ci
            if cj < minz: minz = cj
            if cj > maxz: maxz = cj
            for off in offs:
                nb = cur + off
                if flat[nb] and comp[nb] == -1:
                    comp[nb] = cid
                    q.append(nb)
        sizes.append(size)
        bboxes.append((minx - 1, maxx - 1, minz - 1, maxz - 1))
    labels = comp.reshape(nz + 2, nxp)[1:-1, 1:-1]
    return labels, sizes, bboxes


def bfs_from(labels, cid, seed_flat, nx, nz, want_parent=False):
    """BFS on one component. seed_flat is on the unpadded grid."""
    nxp = nx + 2
    pad = np.zeros((nz + 2, nxp), dtype=bool)
    pad[1:-1, 1:-1] = labels == cid
    flat = pad.ravel()
    dist = np.full(flat.size, -1, dtype=np.int32)
    parent = np.full(flat.size, -1, dtype=np.int32) if want_parent else None
    seed = (seed_flat // nx + 1) * nxp + (seed_flat % nx + 1)
    if not flat[seed]:
        return dist, parent, None
    dist[seed] = 0
    q = deque([seed])
    offs = (-nxp - 1, -nxp, -nxp + 1, -1, 1, nxp - 1, nxp, nxp + 1)
    far = seed
    while q:
        cur = q.popleft()
        d = dist[cur]
        if d > dist[far]:
            far = cur
        for off in offs:
            nb = cur + off
            if flat[nb] and dist[nb] == -1:
                dist[nb] = d + 1
                if want_parent:
                    parent[nb] = cur
                q.append(nb)
    return dist, parent, far


def reconstruct(parent, far, seed, nx, nz):
    nxp = nx + 2
    path = []
    cur = far
    while cur != -1:
        j = cur // nxp - 1
        i = cur % nxp - 1
        path.append((j, i))
        if cur == seed:
            break
        cur = parent[cur]
    path.reverse()
    return path


def analyze(name, physics_path, cell, out_dir, grids_dir):
    t0 = time.time()
    data = physics_path.read_bytes()
    result = {
        "name": name,
        "files": {
            "level": file_record(physics_path.with_name("Level.level")),
            "physics": file_record(physics_path),
            "render": file_record(physics_path.with_name("Level.levelrender")),
            "stream": file_record(physics_path.with_name("Level.levelstream")),
        },
    }
    try:
        level = scan.scan_level(data)
    except Exception as exc:  # noqa: BLE001 - the exact parser reason is the result
        result["physics"] = {"status": "error", "errorType": type(exc).__name__,
                             "error": str(exc)[:400]}
        result["drivable"] = {"measured": False, "reason": "physics parse failed"}
        result["draws"] = {"status": "not-inventoried"}
        return result

    result["physics"] = {
        "status": "ok",
        "fileVersion": level["fileVersion"],
        "streamVersion": level["streamVersion"],
        "shapeTypes": level["types"],
        "shapeTypeNames": [scan.IMPORT_NAMES.get(t, str(t)) for t in level["types"]],
        "topLevelStaticMeshCount": sum(1 for s in level["shapes"]
                                       if s.get("importType") in (0, 11)),
        "fluidMeshCount": sum(1 for s in level["shapes"]
                              if s.get("importType") == 17),
        "compositeCount": sum(1 for s in level["shapes"]
                              if s.get("importType") == 7),
        "compositeSubMeshCount": sum(s.get("compositeSubMeshes", 0)
                                     for s in level["shapes"]),
        "routesParsed": False,
    }

    tris, per_mesh = flatten_top_level(level)
    result["physics"]["staticTriangles"] = int(len(tris))
    result["physics"]["staticVertices"] = int(sum(m["vertices"] for m in per_mesh))
    result["physics"]["meshes"] = per_mesh
    if len(tris) == 0:
        result["drivable"] = {
            "measured": False,
            "reason": "no top-level static triangle mesh (fluid/composite only)",
        }
        return result

    all_pts = tris.reshape(-1, 3)
    bounds = {
        "min": [float(all_pts[:, 0].min()), float(all_pts[:, 1].min()),
                float(all_pts[:, 2].min())],
        "max": [float(all_pts[:, 0].max()), float(all_pts[:, 1].max()),
                float(all_pts[:, 2].max())],
    }
    result["physics"]["bounds"] = bounds

    nrm = triangle_normals(tris)
    surface = tris[nrm[:, 1] > SURFACE_MIN_NY]
    wall = tris[np.abs(nrm[:, 1]) < 0.5]
    result["physics"]["surfaceTriangles"] = int(len(surface))
    result["physics"]["steepTriangles"] = int(len(wall))

    x0 = math.floor(all_pts[:, 0].min()) - 2
    x1 = math.ceil(all_pts[:, 0].max()) + 2
    z0 = math.floor(all_pts[:, 2].min()) - 2
    z1 = math.ceil(all_pts[:, 2].max()) + 2
    nx = int(round((x1 - x0) / cell)) + 1
    nz = int(round((z1 - z0) / cell)) + 1
    result["model"] = {
        "cell": cell,
        "surfaceMinNormalY": SURFACE_MIN_NY,
        "surfaceMinNormalDeg": round(math.degrees(math.acos(SURFACE_MIN_NY)), 3),
        "stepLimit": STEP_LIMIT,
        "gradeLimit": GRADE_LIMIT,
        "edgeDhLimit": min(STEP_LIMIT, GRADE_LIMIT * cell),
        "wallMask": "steep-triangle XZ bbox, height-gated, dilated 1 cell (conservative)",
        "search": "8-connected component + two-pass BFS geodesic diameter",
        "pathLength": "Euclidean length of the reconstructed cell-centre path",
        "cell": cell,
        "grid": [nx, nz],
    }

    H, xs, zs = rasterise_height(surface, x0, x1, z0, z1, cell)
    dh = edge_max_dh(H)
    edge_dh = min(STEP_LIMIT, GRADE_LIMIT * cell)
    W, wall_count = wall_bbox_mask(wall, H, x0, z0, cell, nx, nz)
    surface_ok = np.isfinite(H) & (dh <= edge_dh + 1e-9)
    passable = surface_ok & ~W
    labels, sizes, bboxes = component_label(passable)
    order = sorted(range(len(sizes)), key=lambda k: sizes[k], reverse=True)
    largest = order[0] if order else None
    result["drivable"] = {
        "measured": False,
        "surfaceCells": int(np.isfinite(H).sum()),
        "surfacePassableCells": int(surface_ok.sum()),
        "wallMaskCells": int(W.sum()),
        "wallTrianglesApplied": int(wall_count),
        "passableCells": int(passable.sum()),
        "componentCount": len(sizes),
        "largestComponentCells": int(sizes[largest]) if largest is not None else 0,
        "largestComponentAreaM2": round(sizes[largest] * cell * cell, 2) if largest is not None else 0.0,
        "largestComponentBbox": list(bboxes[largest]) if largest is not None else None,
        "topComponents": [
            {"cells": int(sizes[k]), "areaM2": round(sizes[k] * cell * cell, 2),
             "bbox": list(bboxes[k])}
            for k in order[:5]
        ],
    }
    if largest is None or sizes[largest] == 0:
        result["drivable"]["reason"] = "no passable cell"
        return result

    # Component to measure. For the E1 level the committed spawn is in a smaller
    # braided band, not the globally largest terrain component; honour it.
    measure_cid = largest + 1
    measure_source = "largest-component"
    river_seed = None
    if name == "usa_la_river":
        si = int(round((RIVER_SPAWN[0] - xs[0]) / cell))
        sj = int(round((RIVER_SPAWN[1] - zs[0]) / cell))
        if 0 <= sj < nz and 0 <= si < nx and labels[sj, si] > 0:
            measure_cid = int(labels[sj, si])
            measure_source = "committed-spawn-component"
            river_seed = sj * nx + si
            result["drivable"]["committedSpawn"] = {
                "source": "committed _work/e1-drive/spawn.json",
                "x": RIVER_SPAWN[0], "z": RIVER_SPAWN[1],
                "ground": float(H[sj, si]) if math.isfinite(H[sj, si]) else None,
                "onCollision": bool(math.isfinite(H[sj, si])),
                "componentCells": int(sizes[measure_cid - 1]),
            }
    result["drivable"]["measuredComponent"] = measure_source
    result["drivable"]["measuredComponentCells"] = int(sizes[measure_cid - 1])
    result["drivable"]["measuredComponentAreaM2"] = round(
        sizes[measure_cid - 1] * cell * cell, 2)

    # Diameter of the measured component: two BFS passes.
    cid = measure_cid
    seeds = np.flatnonzero((labels == cid).ravel())
    seed0 = int(seeds[0])
    _, _, far_a = bfs_from(labels, cid, seed0, nx, nz)
    seed_flat = (int(far_a // (nx + 2) - 1) * nx + int(far_a % (nx + 2) - 1))
    _, parent, far_b = bfs_from(labels, cid, seed_flat, nx, nz, want_parent=True)
    path_cells = reconstruct(parent, far_b, seed_flat, nx, nz)
    pts = [(xs[i], zs[j]) for j, i in path_cells]
    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
    # Heuristic resample at 1 m for step/grade; the length is the cell path.
    heights = [float(H[j, i]) for j, i in path_cells]
    max_step = max((abs(b - a) for a, b in zip(heights, heights[1:])
                    if math.isfinite(a) and math.isfinite(b)), default=0.0)
    max_grade = 0.0
    for k in range(len(pts)):
        j = k
        acc = 0.0
        while j + 1 < len(pts) and acc < 2.0:
            acc += math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1])
            j += 1
        if acc >= 1.5 and math.isfinite(heights[k]) and math.isfinite(heights[j]):
            max_grade = max(max_grade, abs(heights[j] - heights[k]) / acc)
    start = pts[0] if pts else None
    end = pts[-1] if pts else None

    spawn = None
    committed_path = None
    if name == "usa_la_river" and river_seed is not None:
        _, rparent, river_far = bfs_from(labels, cid, river_seed, nx, nz,
                                         want_parent=True)
        rpath = reconstruct(rparent, river_far, river_seed, nx, nz)
        rpts = [(xs[i], zs[j]) for j, i in rpath]
        rlength = sum(math.hypot(b[0] - a[0], b[1] - a[1])
                      for a, b in zip(rpts, rpts[1:]))
        rj = rpath[-1][0]
        ri = rpath[-1][1]
        spawn = {"source": "committed _work/e1-drive/spawn.json",
                 "x": RIVER_SPAWN[0], "z": RIVER_SPAWN[1],
                 "onCollision": bool(math.isfinite(H[sj, si])),
                 "ground": float(H[sj, si]) if math.isfinite(H[sj, si]) else None,
                 "reachableEnd": [float(xs[ri]), float(zs[rj])]}
        committed_path = {
            "kind": "point-to-point from committed spawn to farthest cell",
            "lengthM": round(rlength, 3),
            "samples": len(rpts),
            "start": [RIVER_SPAWN[0], RIVER_SPAWN[1]],
            "end": [round(xs[ri], 4), round(zs[rj], 4)],
            "endGround": round(float(H[rj, ri]), 4),
        }

    result["drivable"].update({
        "measured": True,
        "path": {
            "kind": "geodesic-diameter",
            "lengthM": round(length, 3),
            "samples": len(pts),
            "start": [round(start[0], 4), round(start[1], 4)] if start else None,
            "end": [round(end[0], 4), round(end[1], 4)] if end else None,
            "maxStepM": round(max_step, 5),
            "max2mGrade": round(max_grade, 6),
            "startGround": round(heights[0], 4) if heights else None,
            "endGround": round(heights[-1], 4) if heights else None,
        },
        "candidateSpawn": ({
            "source": "committed _work/e1-drive/spawn.json",
            "x": RIVER_SPAWN[0], "z": RIVER_SPAWN[1],
            "ground": float(H[sj, si]) if math.isfinite(H[sj, si]) else None,
            "onCollision": bool(math.isfinite(H[sj, si])),
        } if name == "usa_la_river" and river_seed is not None else {
            "source": "derived: geodesic-diameter endpoint of the largest component",
            "x": round(start[0], 4), "z": round(start[1], 4),
            "ground": round(heights[0], 4),
            "onCollision": True,
            "note": "not an original start line; the level files contain no spawn record",
        }),
        "committedSpawn": spawn,
        "committedSpawnPath": committed_path,
    })
    result["drivable"]["measured"] = length >= AUDIT_MIN_PATH_M
    if not result["drivable"]["measured"]:
        result["drivable"]["reason"] = ("measured-component diameter %.1f m is below the "
                                        "%.0f m audit floor" % (length, AUDIT_MIN_PATH_M))

    # Persist the grid and the measured path for independent re-measurement.
    grids_dir.mkdir(parents=True, exist_ok=True)
    grid_path = grids_dir / (name + ".npz")
    np.savez_compressed(grid_path, height=H, passable=passable, labels=labels,
                        wall=W, xs=xs, zs=zs)
    grid_hash = sha256_file(grid_path)
    array_hash = hashlib.sha256()
    for arr in (H, passable, labels, W, xs, zs):
        array_hash.update(np.ascontiguousarray(arr).tobytes())
    result["grid"] = {"path": str(grid_path.relative_to(ROOT)).replace("\\", "/"),
                      "sha256": grid_hash,
                      "arraySha256": array_hash.hexdigest(),
                      "note": "arraySha256 is the deterministic value; the .npz container hash may vary with zip metadata"}
    paths_dir = out_dir / "paths"
    paths_dir.mkdir(parents=True, exist_ok=True)
    path_path = paths_dir / (name + ".json")
    path_doc = {
        "schema": "blur.map-pipeline.path/1",
        "level": name,
        "kind": "geodesic-diameter",
        "component": result["drivable"]["measuredComponent"],
        "samples": [{"x": round(xs[i], 3), "z": round(zs[j], 3),
                     "h": round(float(H[j, i]), 4)}
                    for j, i in path_cells],
    }
    path_text = json.dumps(path_doc, separators=(",", ":"), sort_keys=True)
    path_path.write_text(path_text + "\n", encoding="utf-8")
    result["pathArtifact"] = {
        "path": str(path_path.relative_to(ROOT)).replace("\\", "/"),
        "sha256": hashlib.sha256((path_text + "\n").encode()).hexdigest(),
        "samples": len(path_cells),
        "bbox": [
            round(min(p[0] for p in pts), 3), round(max(p[0] for p in pts), 3),
            round(min(p[1] for p in pts), 3), round(max(p[1] for p in pts), 3),
        ] if pts else None,
    }
    return result


def main(argv=None):
    global CELL
    ap = argparse.ArgumentParser()
    ap.add_argument("--cell", type=float, default=CELL)
    ap.add_argument("--levels", nargs="*")
    ap.add_argument("--out", type=Path, default=OUT / "inventory.json")
    args = ap.parse_args(argv)
    CELL = args.cell
    names = args.levels or sorted(p.name for p in LEVELS_DIR.iterdir() if p.is_dir())
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for name in names:
        physics = LEVELS_DIR / name / "Level.levelphysics"
        if not physics.is_file():
            rows.append({"name": name, "physics": {"status": "missing"},
                         "drivable": {"measured": False,
                                      "reason": "Level.levelphysics absent"},
                         "draws": {"status": "not-inventoried"}})
            print(name, "MISSING", flush=True)
            continue
        row = analyze(name, physics, CELL, OUT, GRIDS)
        rows.append(row)
        d = row.get("drivable", {})
        print(name, row["physics"].get("status"), "tri", row["physics"].get("staticTriangles"),
              "pass", d.get("passableCells"), "comp", d.get("componentCount"),
              "path", d.get("path", {}).get("lengthM"), "measured", d.get("measured"),
              flush=True)
    doc = {
        "schema": "blur.map-pipeline.maps/1",
        "scope": {
            "collisionOnly": True,
            "drawGeometryRead": False,
            "rendererClaim": False,
            "engineClaim": False,
            "playableClaim": False,
            "note": ("Read-only inventory of Level.levelphysics plus a deterministic "
                     "collision-only traversability/geodesic model. Draw counts are "
                     "reported separately in draws.json. No map is claimed playable "
                     "without a committed layout and a rendered frame."),
        },
        "model": {
            "cell": CELL,
            "surfaceMinNormalY": SURFACE_MIN_NY,
            "gradeLimit": GRADE_LIMIT,
            "stepLimit": STEP_LIMIT,
            "wallMask": "steep-triangle XZ bbox, height-gated, dilated 1 cell (conservative)",
            "auditMinPathM": AUDIT_MIN_PATH_M,
        },
        "levelCount": len(rows),
        "levels": rows,
    }
    body = json.dumps(doc, indent=1, sort_keys=True)
    args.out.write_text(body + "\n", encoding="utf-8")
    print("wrote", args.out, "sha256", hashlib.sha256((body + "\n").encode()).hexdigest())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
