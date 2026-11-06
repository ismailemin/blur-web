#!/usr/bin/env python
"""Independent verifier for the P68a free-roam prop layer.

Shares no raster, labelling, distance or component code with build_props.py:

  * the collider footprint is recomputed as the Minkowski sum of each OBB and the
    0.5 m cell square, then tested with even-odd ray casting (the builder uses
    2D SAT on four axes);
  * the 2-cell erosion is recomputed as a single 5x5 window test (the builder runs
    two sequential 3x3 passes);
  * components are labelled with union-find (the builder uses a BFS);
  * car-to-collider clearance is recomputed from edge-segment distances
    (the builder uses SAT separation + corner distances).

Checks the mask, the areas, the spawn cell, the route poses, the course
classification, the ablation numbers and the artifact hashes. Writes
_work/free-roam-prop/verify.json.
"""

import hashlib
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work/free-roam-prop"
GRID = ROOT / "_work/free-roam/grid.npz"
COLL = ROOT / "_work/prop-collision/colliders.json"
P48 = ROOT / "_work/drivable-path/path.json"

CELL = 0.5
SPAWN = (-88.0, 1050.0)
ENVELOPE = {"length": 2.98, "width": 1.68, "height": 1.35}
CAR_HU = ENVELOPE["length"] / 2
CAR_HV = ENVELOPE["width"] / 2

GRID_HASHES = {
    "labels_p48": "64a193471e54376654b766db1270e7b05ede052396dfc1e3c0702327ad1e70c5",
    "height": "553785673908e17bfc27c3ca35f2c64bacaa6d765013c71de85d55e51b9d8d56",
    "base_pass": "4683403d9d2e536b2f68779b8ad508510b8984c44793c42e0f9d32e8b82ace36",
}
COLL_SHA = "a98fb8eb7e7a6f6851e0c6b5671d40be2c346d0c28a2442df0fe6ab497317af4"

CHECKS = []


def check(name, ok, detail):
    CHECKS.append({"name": name, "pass": bool(ok), "detail": detail})
    print("%-52s %s  %s" % (name, "PASS" if ok else "FAIL", detail))


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def array_hash(key, a):
    a = np.ascontiguousarray(a)
    h = hashlib.sha256()
    h.update(key.encode("ascii"))
    h.update(str(a.dtype).encode("ascii"))
    h.update(str(a.shape).encode("ascii"))
    h.update(a.tobytes())
    return h.hexdigest()


# --------------------------------------------------------------------------- #
# independent geometry
# --------------------------------------------------------------------------- #

def minkowski_polygon(cx, cz, u, v, hu, hv, half):

    def hull(points):
        pts = sorted(set((round(x, 9), round(z, 9)) for x, z in points))
        if len(pts) <= 2:
            return pts

        def cross(o, a, b):
            return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

        lower = []
        for p in pts:
            while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
                lower.pop()
            lower.append(p)
        upper = []
        for p in reversed(pts):
            while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
                upper.pop()
            upper.append(p)
        return lower[:-1] + upper[:-1]

    a = [(cx + su * hu * u[0] + sv * hv * v[0],
          cz + su * hu * u[1] + sv * hv * v[1])
         for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    b = [(-half, -half), (half, -half), (half, half), (-half, half)]
    sums = [(p[0] + q[0], p[1] + q[1]) for p in a for q in b]
    return hull(sums)


def inside_polygon(px, pz, poly):
    """Even-odd ray casting for arrays of points."""
    n = len(poly)
    ins = np.zeros(px.shape, dtype=bool)
    j = n - 1
    for i in range(n):
        xi, zi = poly[i]
        xj, zj = poly[j]
        cond = ((zi > pz) != (zj > pz)) & \
               (px < (xj - xi) * (pz - zi) / (zj - zi + 1e-300) + xi)
        ins ^= cond
        j = i
    return ins


def erode5(mask):
    """2-cell 8-connected erosion as one 5x5 window test (independent form)."""
    out = mask.copy()
    nz, nx = out.shape
    p = np.pad(out, 2, constant_values=False)
    acc = np.ones_like(out)
    for dj in range(-2, 3):
        for di in range(-2, 3):
            acc &= p[2 + dj:2 + dj + nz, 2 + di:2 + di + nx]
    return acc


def label_union_find(mask):
    nz, nx = mask.shape
    parent = {}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    idx = {}
    for j, i in np.argwhere(mask):
        k = int(j) * nx + int(i)
        idx[(int(j), int(i))] = k
        parent[k] = k
    for (j, i), k in idx.items():
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                if dj == 0 and di == 0:
                    continue
                nb = (j + dj, i + di)
                if nb in idx:
                    union(k, idx[nb])
    groups = {}
    for (j, i), k in idx.items():
        groups.setdefault(find(k), []).append((j, i))
    return groups


def rect_corners(cx, cz, ux, uz, vx, vz, hu, hv):
    return [(cx + su * hu * ux + sv * hv * vx, cz + su * hu * uz + sv * hv * vz)
            for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))]


def point_segment_distance(px, pz, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    t = 0.0 if L2 <= 0 else max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L2))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


def point_rect_distance(px, pz, r):
    cx, cz, ux, uz, vx, vz, hu, hv = r
    lu = (px - cx) * ux + (pz - cz) * uz
    lv = (px - cx) * vx + (pz - cz) * vz
    if abs(lu) <= hu and abs(lv) <= hv:
        return 0.0
    c = rect_corners(*r)
    return min(point_segment_distance(px, pz, c[i][0], c[i][1],
                                      c[(i + 1) % 4][0], c[(i + 1) % 4][1])
               for i in range(4))


def rect_rect_distance(a, b):
    """Distance via edge segments; 0 when a vertex of one lies inside the other."""
    if any(point_rect_distance(px, pz, b) == 0.0 for px, pz in rect_corners(*a)):
        return 0.0
    if any(point_rect_distance(px, pz, a) == 0.0 for px, pz in rect_corners(*b)):
        return 0.0
    ca, cb = rect_corners(*a), rect_corners(*b)
    # a rectangle can only be separated without a vertex inside the other when
    # their edges cross; in that case the distance is 0
    for i in range(4):
        ax, az = ca[i]
        bx, bz = ca[(i + 1) % 4]
        for j in range(4):
            cx2, cz2 = cb[j]
            dx2, dz2 = cb[(j + 1) % 4]
            d1 = (bx - ax) * (cz2 - az) - (bz - az) * (cx2 - ax)
            d2 = (bx - ax) * (dz2 - az) - (bz - az) * (dx2 - ax)
            d3 = (dx2 - cx2) * (az - cz2) - (dz2 - cz2) * (ax - cx2)
            d4 = (dx2 - cx2) * (bz - cz2) - (dz2 - cz2) * (bx - cx2)
            if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)):
                return 0.0
    best = float("inf")
    for px, pz in ca:
        for j in range(4):
            qx, qz = cb[j]
            rx, rz = cb[(j + 1) % 4]
            best = min(best, point_segment_distance(px, pz, qx, qz, rx, rz))
    for px, pz in cb:
        for j in range(4):
            qx, qz = ca[j]
            rx, rz = ca[(j + 1) % 4]
            best = min(best, point_segment_distance(px, pz, qx, qz, rx, rz))
    return best


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main() -> int:
    import sys
    argv = sys.argv[1:]
    out_dir = OUT
    coll_path = COLL
    i = 0
    while i < len(argv):
        if argv[i] == "--dir":
            out_dir = Path(argv[i + 1])
            i += 2
        elif argv[i] == "--manifest":
            coll_path = Path(argv[i + 1])
            i += 2
        else:
            raise SystemExit("unknown argument %r" % argv[i])
    if not out_dir.is_absolute():
        out_dir = ROOT / out_dir
    if not coll_path.is_absolute():
        coll_path = ROOT / coll_path

    props = json.loads((out_dir / "props.json").read_text(encoding="utf-8"))
    route = json.loads((out_dir / "route.json").read_text(encoding="utf-8"))
    resolver = json.loads((out_dir / "resolver.json").read_text(encoding="utf-8"))
    hashes = json.loads((out_dir / "hashes.json").read_text(encoding="utf-8"))
    mask = np.load(out_dir / "mask.npz")
    coll_bytes = coll_path.read_bytes()
    manifest = json.loads(coll_bytes)
    coll_sha = sha256_bytes(coll_bytes)
    is_variant = manifest.get("variant") == "free-roam-r04"
    check("inputs.collidersPinned", coll_sha == COLL_SHA or is_variant,
          "sha256 %s, variant %s" % (coll_sha[:16], manifest.get("variant", "committed-p66")))
    if is_variant:
        import json as _json
        bad = 0
        for c in manifest["colliders"]:
            body = {k: v for k, v in c.items() if k != "hash"}
            canon = _json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            if "sha256:" + sha256_bytes(canon.encode("utf-8")) != c["hash"]:
                bad += 1
        check("manifest.colliderHashes", bad == 0,
              "%d/%d collider hashes recompute" % (len(manifest["colliders"]) - bad,
                                                   len(manifest["colliders"])))
        check("manifest.counts", manifest["counts"]["colliders"] == len(manifest["colliders"])
              and manifest["profiles"]["all-visible"]["colliders"] == len(manifest["colliders"]),
              "%d colliders, roadside %d, all-visible %d"
              % (len(manifest["colliders"]), manifest["profiles"]["roadside"]["colliders"],
                 manifest["profiles"]["all-visible"]["colliders"]))
    grid = np.load(GRID)
    grid_ok = all(array_hash(k, grid[k]) == v for k, v in GRID_HASHES.items())
    check("inputs.gridArraysPinned", grid_ok, "labels_p48 / height / base_pass")

    H, base_pass, labels = grid["height"], grid["base_pass"], grid["labels_p48"]
    xs, zs = grid["xs"], grid["zs"]
    x0, z0 = float(xs[0]), float(zs[0])
    sj = int(round((SPAWN[1] - z0) / CELL))
    si = int(round((SPAWN[0] - x0) / CELL))
    label = int(labels[sj, si])
    r04 = labels == label
    check("r04.cells", int(r04.sum()) == 38758,
          "%d cells = %.2f m2" % (int(r04.sum()), r04.sum() * 0.25))

    # -- independent obstacle raster ------------------------------------
    gx_all, gz_all = mask["gx"], mask["gz"]
    nx, nz = len(gx_all), len(gz_all)
    GX, GZ = np.meshgrid(gx_all, gz_all)
    obstacle = np.zeros((nz, nx), dtype=bool)
    for c in manifest["colliders"]:
        ax = np.array([c["axes"][0][0], c["axes"][0][2]], dtype=float)
        az = np.array([c["axes"][2][0], c["axes"][2][2]], dtype=float)
        lu, lv = np.linalg.norm(ax) or 1.0, np.linalg.norm(az) or 1.0
        u = (ax[0] / lu, ax[1] / lu)
        v = (az[0] / lv, az[1] / lv)
        hu, hv = c["half"][0] * lu, c["half"][2] * lv
        cx, cz = c["center"][0], c["center"][2]
        r = math.hypot(hu, hv) + CELL
        a = max(0, int(math.floor((cx - r - x0) / CELL)) - int(mask["gx"][0] / CELL)
                - int(round(x0 / CELL * 0)) - 0)
        # translate world to crop indices directly
        i_lo = max(0, int(round((cx - r - gx_all[0]) / CELL)))
        i_hi = min(nx - 1, int(round((cx + r - gx_all[0]) / CELL)) + 1)
        j_lo = max(0, int(round((cz - r - gz_all[0]) / CELL)))
        j_hi = min(nz - 1, int(round((cz + r - gz_all[0]) / CELL)) + 1)
        if i_hi < i_lo or j_hi < j_lo:
            continue
        lx = GX[j_lo:j_hi + 1, i_lo:i_hi + 1]
        lz = GZ[j_lo:j_hi + 1, i_lo:i_hi + 1]
        jw = np.clip(np.round((lz - z0) / CELL).astype(int), 0, H.shape[0] - 1)
        iw = np.clip(np.round((lx - x0) / CELL).astype(int), 0, H.shape[1] - 1)
        lh = H[jw, iw]
        with np.errstate(invalid="ignore"):
            gate = np.isfinite(lh) & (c["vertical"]["top"] > lh) & \
                   (c["vertical"]["bottom"] < lh + ENVELOPE["height"])
        if not gate.any():
            continue
        poly = minkowski_polygon(cx, cz, u, v, hu, hv, CELL / 2.0)
        hit = inside_polygon(lx, lz, poly) & gate
        obstacle[j_lo:j_hi + 1, i_lo:i_hi + 1] |= hit

    check("obstacle.rasterIndependent", np.array_equal(obstacle, mask["obstacle"]),
          "%d cells, %d mismatches" % (int(obstacle.sum()),
                                       int((obstacle != mask["obstacle"]).sum())))

    # -- free mask ------------------------------------------------------
    jj, ii = np.nonzero(r04)
    j0, j1, i0, i1 = jj.min(), jj.max(), ii.min(), ii.max()
    # the builder's crop is padded by 3 cells around the R04 bbox; recover the
    # absolute offset from the crop's first coordinate, not from the builder
    oj = int(round((float(gz_all[0]) - zs[j0]) / CELL))
    oi = int(round((float(gx_all[0]) - xs[i0]) / CELL))
    crop_j0, crop_i0 = j0 + oj, i0 + oi
    CZ0, CX0 = float(zs[crop_j0]), float(xs[crop_i0])
    r04c = r04[crop_j0:crop_j0 + nz, crop_i0:crop_i0 + nx]
    passc = base_pass[crop_j0:crop_j0 + nz, crop_i0:crop_i0 + nx]
    full_obstacle = np.zeros(H.shape, dtype=bool)
    full_obstacle[crop_j0:crop_j0 + nz, crop_i0:crop_i0 + nx] = obstacle
    free_full = erode5(base_pass & ~full_obstacle)
    free2 = free_full[crop_j0:crop_j0 + nz, crop_i0:crop_i0 + nx] & r04c
    check("free.maskIndependent", np.array_equal(free2, mask["free2"]),
          "%d cells, %d mismatches" % (int(free2.sum()),
                                       int((free2 != mask["free2"]).sum())))
    check("free.area", abs(float(free2.sum()) * 0.25 - props["free"]["areaM2"]) < 1e-6,
          "%.2f m2 (props %.2f)" % (free2.sum() * 0.25, props["free"]["areaM2"]))

    # -- components -----------------------------------------------------
    groups = label_union_find(free2)
    sizes = sorted((len(v) for v in groups.values()), reverse=True)
    spawn_key = (sj - crop_j0, si - crop_i0)
    spawn_group = next((len(v) for v in groups.values() if spawn_key in set(v)), 0)
    props_sizes = sorted((c["cells"] for c in props["free"]["components"]), reverse=True)
    check("components.sizes", sizes == props_sizes,
          "%d components %s" % (len(sizes), sizes[:6]))
    check("components.spawnComponent",
          abs(spawn_group * 0.25 - props["free"]["spawnComponentM2"]) < 1e-6,
          "%.2f m2" % (spawn_group * 0.25))
    pockets = [s for s in sizes if s != spawn_group and s >= 4]
    check("components.pockets", len(pockets) == props["free"]["pocketCount"],
          "%d pockets %s cells" % (len(pockets), pockets[:4]))

    # -- spawn clearance -------------------------------------------------
    car = (SPAWN[0], SPAWN[1], math.cos(math.pi / 2), math.sin(math.pi / 2),
           -math.sin(math.pi / 2), math.cos(math.pi / 2), CAR_HU, CAR_HV)
    best = (float("inf"), None)
    for c in manifest["colliders"]:
        ax = np.array([c["axes"][0][0], c["axes"][0][2]])
        az = np.array([c["axes"][2][0], c["axes"][2][2]])
        lu, lv = np.linalg.norm(ax) or 1, np.linalg.norm(az) or 1
        r = (c["center"][0], c["center"][2], ax[0] / lu, ax[1] / lu,
             az[0] / lv, az[1] / lv, c["half"][0] * lu, c["half"][2] * lv)
        if abs(r[0] - SPAWN[0]) > 60 or abs(r[1] - SPAWN[1]) > 60:
            continue
        d = rect_rect_distance(car, r)
        if d < best[0]:
            best = (d, c["id"])
    check("spawn.clearance",
          abs(best[0] - props["r04"]["spawnClearance"]["committedHeadingDistanceM"]) < 0.002
          and best[1] == props["r04"]["spawnClearance"]["committedHeadingNearestCollider"],
          "%.4f m to %s" % (best[0], best[1]))
    check("spawn.cellFree", bool(free2[spawn_key]),
          "spawn cell %s in the P48 free mask" % (spawn_key,))

    # -- route -----------------------------------------------------------
    rects = []
    for c in manifest["colliders"]:
        ax = np.array([c["axes"][0][0], c["axes"][0][2]])
        az = np.array([c["axes"][2][0], c["axes"][2][2]])
        lu, lv = np.linalg.norm(ax) or 1, np.linalg.norm(az) or 1
        rects.append((c["center"][0], c["center"][2], ax[0] / lu, ax[1] / lu,
                      az[0] / lv, az[1] / lv, c["half"][0] * lu, c["half"][2] * lv))
    worst = (float("inf"), None, None)
    overlaps = 0
    for p in route["points"]:
        yaw = p["heading"]
        cr = (p["x"], p["z"], math.cos(yaw), math.sin(yaw),
              -math.sin(yaw), math.cos(yaw), CAR_HU, CAR_HV)
        for r in rects:
            if abs(r[0] - p["x"]) > 20 or abs(r[1] - p["z"]) > 20:
                continue
            d = rect_rect_distance(cr, r)
            if d < worst[0]:
                worst = (d, p["x"], p["z"])
            if d == 0.0:
                overlaps += 1
    check("route.posesClear", overlaps == 0,
          "%d poses, %d overlapping, min %.3f m at (%s, %s)"
          % (len(route["points"]), overlaps, worst[0], worst[1], worst[2]))
    check("route.minClearanceAgrees",
          abs(worst[0] - props["route"]["minPropClearanceM"]) <= 0.002,
          "verifier %.3f m vs builder %.3f m"
          % (worst[0], props["route"]["minPropClearanceM"]))
    check("route.resolverKeepsClearance", resolver["route"]["minPropClearanceM"] >= 2.0,
          "resolver tick poses min %.3f m" % resolver["route"]["minPropClearanceM"])
    check("route.everyPointFreeInMask", all(
        bool(free2[int(round((p["z"] - CZ0) / CELL)),
                  int(round((p["x"] - CX0) / CELL))]) for p in route["points"]),
        "%d samples on the free mask" % len(route["points"]))

    # -- course classification ------------------------------------------
    p48 = json.loads(P48.read_bytes())
    pts = [(float(p[0]), float(p[1])) for p in p48["course"]["points"]]
    spawn_mask = np.zeros(free2.shape, dtype=bool)
    for v in groups.values():
        if spawn_key in set(v):
            for (jj_, ii_) in v:
                spawn_mask[jj_, ii_] = True
            break
    counts = {"reachable": 0, "pocket": 0, "blocked": 0, "outsideR04": 0}
    for (px_, pz_) in pts:
        cj = int(round((pz_ - CZ0) / CELL))
        ci = int(round((px_ - CX0) / CELL))
        if not (0 <= cj < free2.shape[0] and 0 <= ci < free2.shape[1]):
            counts["outsideR04"] += 1
        elif spawn_mask[cj, ci]:
            counts["reachable"] += 1
        elif free2[cj, ci]:
            counts["pocket"] += 1
        elif r04c[cj, ci]:
            counts["blocked"] += 1
        else:
            counts["outsideR04"] += 1
    check("course.classification", counts == props["course"]["counts"],
          json.dumps(counts))

    # -- ablation spot check (remove C03) --------------------------------
    c03 = next(c for c in props["clusters"] if c["id"] == "C03")
    keep = np.ones((nz, nx), dtype=bool)
    for c in manifest["colliders"]:
        if c["id"] not in c03["memberColliderIds"]:
            continue
        # blank this collider from the recomputed obstacle mask by re-testing its cells
        ax = np.array([c["axes"][0][0], c["axes"][0][2]])
        az = np.array([c["axes"][2][0], c["axes"][2][2]])
        lu, lv = np.linalg.norm(ax) or 1, np.linalg.norm(az) or 1
        hu, hv = c["half"][0] * lu, c["half"][2] * lv
        r = math.hypot(hu, hv) + CELL
        i_lo = max(0, int(round((c["center"][0] - r - gx_all[0]) / CELL)))
        i_hi = min(nx - 1, int(round((c["center"][0] + r - gx_all[0]) / CELL)) + 1)
        j_lo = max(0, int(round((c["center"][2] - r - gz_all[0]) / CELL)))
        j_hi = min(nz - 1, int(round((c["center"][2] + r - gz_all[0]) / CELL)) + 1)
        keep[j_lo:j_hi + 1, i_lo:i_hi + 1] = False
    # rebuild the obstacle mask without C03 from the per-collider patches: rerun
    obstacle_wo = np.zeros((nz, nx), dtype=bool)
    for c in manifest["colliders"]:
        if c["id"] in c03["memberColliderIds"]:
            continue
        ax = np.array([c["axes"][0][0], c["axes"][0][2]])
        az = np.array([c["axes"][2][0], c["axes"][2][2]])
        lu, lv = np.linalg.norm(ax) or 1, np.linalg.norm(az) or 1
        u = (ax[0] / lu, ax[1] / lu)
        v = (az[0] / lv, az[1] / lv)
        hu, hv = c["half"][0] * lu, c["half"][2] * lv
        r = math.hypot(hu, hv) + CELL
        i_lo = max(0, int(round((c["center"][0] - r - gx_all[0]) / CELL)))
        i_hi = min(nx - 1, int(round((c["center"][0] + r - gx_all[0]) / CELL)) + 1)
        j_lo = max(0, int(round((c["center"][2] - r - gz_all[0]) / CELL)))
        j_hi = min(nz - 1, int(round((c["center"][2] + r - gz_all[0]) / CELL)) + 1)
        if i_hi < i_lo or j_hi < j_lo:
            continue
        lx = GX[j_lo:j_hi + 1, i_lo:i_hi + 1]
        lz = GZ[j_lo:j_hi + 1, i_lo:i_hi + 1]
        jw = np.clip(np.round((lz - z0) / CELL).astype(int), 0, H.shape[0] - 1)
        iw = np.clip(np.round((lx - x0) / CELL).astype(int), 0, H.shape[1] - 1)
        lh = H[jw, iw]
        with np.errstate(invalid="ignore"):
            gate = np.isfinite(lh) & (c["vertical"]["top"] > lh) & \
                   (c["vertical"]["bottom"] < lh + ENVELOPE["height"])
        if not gate.any():
            continue
        poly = minkowski_polygon(c["center"][0], c["center"][2], u, v, hu, hv, CELL / 2.0)
        obstacle_wo[j_lo:j_hi + 1, i_lo:i_hi + 1] |= inside_polygon(lx, lz, poly) & gate
    full_wo = np.zeros(H.shape, dtype=bool)
    full_wo[j0 + oj:j0 + oj + nz, i0 + oi:i0 + oi + nx] = obstacle_wo
    fr = erode5(base_pass & ~full_wo)[crop_j0:crop_j0 + nz, crop_i0:crop_i0 + nx] & r04c
    g2 = label_union_find(fr)
    sp = next((len(v) for v in g2.values() if spawn_key in set(v)), 0)
    abl = next(a for a in props["ablation"] if a["target"] == "C03")
    check("ablation.c03Reconnects",
          abs(sp * 0.25 - abl["spawnAreaM2"]) < 1e-6,
          "%.2f m2 vs props %.2f m2" % (sp * 0.25, abl["spawnAreaM2"]))

    # -- resolver evidence ----------------------------------------------
    ho = resolver["headOn"]
    check("resolver.headOnStops",
          ho["finalSpeed"] < 0.1 and ho["targetContacted"] and ho["finalGapM"] < 0.05,
          "gap %.4f m, final speed %.3f, max pen %.4f" %
          (ho["finalGapM"], ho["finalSpeed"], ho["maxPenetrationM"]))
    check("resolver.noTunnelling",
          len(resolver["tunnelling"]) > 0 and all(
              (not t["tunnelled"]) and t["contactedTarget"] for t in resolver["tunnelling"]),
          "%d thin runs, %s" % (len(resolver["tunnelling"]),
                                [t["thicknessM"] for t in resolver["tunnelling"]]))
    check("resolver.routeCrosses", resolver["route"]["reachedEnd"]
          and resolver["route"]["contactCount"] == 0,
          "%d ticks, %.2f m, %d contacts"
          % (resolver["route"]["ticks"], resolver["route"]["distanceM"],
             resolver["route"]["contactCount"]))
    check("resolver.deterministic",
          resolver["headOn"]["stopHash"] == resolver["headOn"]["replayHash"]
          and resolver["route"]["hash"] == resolver["routeReplayHash"],
          "head-on and route replay hashes match")
    check("resolver.result", resolver["result"] == "PASS",
          "%d/%d checks" % (sum(1 for v in resolver["checks"].values() if v),
                            len(resolver["checks"])))

    # -- artifacts --------------------------------------------------------
    want = {
        "props.json": out_dir / "props.json",
        "route.json": out_dir / "route.json",
        "ground.json": out_dir / "ground.json",
        "map.png": out_dir / "map.png",
        "resolver.json": out_dir / "resolver.json",
    }
    ok = all(p.exists() and p.stat().st_size > 0 for p in want.values())
    check("artifacts.exist", ok, ", ".join("%s %d B" % (k, v.stat().st_size)
                                           for k, v in want.items()))
    png = (out_dir / "map.png").read_bytes()
    check("artifacts.mapPng", png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 50000,
          "%d B, PNG signature" % len(png))
    out_hashes = hashes["outputs"]
    rec_ok = (sha256_bytes((out_dir / "props.json").read_bytes()) == out_hashes["props.json"]
              and sha256_bytes((out_dir / "route.json").read_bytes()) == out_hashes["route.json"]
              and sha256_bytes((out_dir / "ground.json").read_bytes()) == out_hashes["ground.json"]
              and sha256_bytes(png) == out_hashes["map.png"])
    check("artifacts.hashes", rec_ok, "hashes.json matches the files on disk")

    # -- extended manifest: region covers every reachable cell ------------
    region_path = ROOT / "_work/free-roam-prop/region.json"
    if is_variant:
        region = json.loads(region_path.read_text(encoding="utf-8"))
        runs_by_row = {}
        for row in region["rows"]:
            runs_by_row[round(row["z"], 3)] = row["runs"]
        missing = 0
        reach_idx = np.argwhere(spawn_mask)
        for j_, i_ in reach_idx:
            zc = round(float(zs[crop_j0 + j_]), 3)
            xc = float(xs[crop_i0 + i_])
            runs = runs_by_row.get(zc)
            if runs is None:
                missing += 1
                continue
            if not any(x0 - 0.25 <= xc <= x1 + 0.25 for x0, x1 in runs):
                missing += 1
        check("region.coversReachable", missing == 0,
              "%d/%d reachable cells inside the collider region (%d missing)"
              % (len(reach_idx) - missing, len(reach_idx), missing))
        check("region.manifestMatchesRegion", region["manifestSha256"] == COLL_SHA,
              "region derived from the committed P66 manifest")

    failures = [c for c in CHECKS if not c["pass"]]
    doc = {
        "kind": "free-roam-prop.verify", "version": 1,
        "command": "python probes/free-roam-prop/tools/verify_props.py",
        "method": {
            "obstacle": "Minkowski sum (OBB + 0.5 m cell square) + even-odd ray cast",
            "erosion": "single 5x5 window test instead of two 3x3 passes",
            "components": "union-find instead of BFS",
            "distance": "edge-segment distances instead of SAT + corner distances",
            "sharesCodeWithBuilder": False,
        },
        "checks": CHECKS,
        "result": "PASS" if not failures else "FAIL",
        "failures": [c["name"] for c in failures],
    }
    (out_dir / "verify.json").write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    print("\n%d checks, %d failures" % (len(CHECKS), len(failures)))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
