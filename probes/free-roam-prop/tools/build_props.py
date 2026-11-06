#!/usr/bin/env python
"""P68a — can the P66 `all-visible` prop layer be enabled on the free-roam basin R04?

Reads, read-only and pinned by hash:

  _work/free-roam/grid.npz             P65 rasters (height, passable, labels)
  _work/prop-collision/colliders.json  P66 manifest (468 oriented colliders)
  _work/drivable-path/path.json        P48 310.395 m course
  _work/e1-drive/spawn.json            committed spawn (-88, 1050)

Rasterises the P66 `all-visible` collider footprints over the R04 basin at the
same 0.5 m / P48 2-cell model as P65, subtracts the prop obstacles from the
passable mask, re-erodes, and measures the remaining free area, its connected
components, enclosed pockets and the collider clusters that create them.

Writes _work/free-roam-prop/{props.json,route.json,ground.json,map.png,
hashes.json,mask.npz}. No engine, renderer, browser or game claim.
"""

import hashlib
import heapq
import json
import math
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
GRID_IN = ROOT / "_work/free-roam/grid.npz"
COLL_IN = ROOT / "_work/prop-collision/colliders.json"
P48_IN = ROOT / "_work/drivable-path/path.json"
SPAWN_IN = ROOT / "_work/e1-drive/spawn.json"
OUT = ROOT / "_work/free-roam-prop"

CELL = 0.5
SPAWN = (-88.0, 1050.0)
P48_ERODE = 2          # P65 P48 mask, 2 cells = 1.0 m
STRICT_ERODE = 3       # P65 strict sensitivity, 3 cells = 1.5 m
CAR = {"length": 2.98, "width": 1.68, "height": 1.35}
CAR_HU = CAR["length"] / 2.0
CAR_HV = CAR["width"] / 2.0
CAR_CIRCUM = math.hypot(CAR_HU, CAR_HV)   # 1.71026 m: union over all headings
HEADINGS = 24

GRID_ARRAY_HASHES = {
    "labels_p48": "64a193471e54376654b766db1270e7b05ede052396dfc1e3c0702327ad1e70c5",
    "height": "553785673908e17bfc27c3ca35f2c64bacaa6d765013c71de85d55e51b9d8d56",
    "base_pass": "4683403d9d2e536b2f68779b8ad508510b8984c44793c42e0f9d32e8b82ace36",
    "wall": "657524f6d08d701eb4a98e9c4d0b3f46fac9cdb5e4e5fd89b6116e88c1b5ae0a",
}
COLL_SHA256 = "a98fb8eb7e7a6f6851e0c6b5671d40be2c346d0c28a2442df0fe6ab497317af4"
STEP8 = ((0, 1, CELL), (0, -1, CELL), (1, 0, CELL), (-1, 0, CELL),
         (1, 1, CELL * math.sqrt(2)), (1, -1, CELL * math.sqrt(2)),
         (-1, 1, CELL * math.sqrt(2)), (-1, -1, CELL * math.sqrt(2)))


# --------------------------------------------------------------------------- #
# hashing helpers
# --------------------------------------------------------------------------- #

def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def array_hash(key, a):
    """P65's exact per-array content digest: sha256(key + dtype + shape + bytes)."""
    a = np.ascontiguousarray(a)
    h = hashlib.sha256()
    h.update(key.encode("ascii"))
    h.update(str(a.dtype).encode("ascii"))
    h.update(str(a.shape).encode("ascii"))
    h.update(a.tobytes())
    return h.hexdigest()


def write_json(path, obj, indent=1):
    def check(o, where):
        if isinstance(o, float):
            if not math.isfinite(o):
                raise SystemExit("refusing to write a non-finite number at %s" % where)
        elif isinstance(o, dict):
            for k, v in o.items():
                check(v, "%s.%s" % (where, k))
        elif isinstance(o, list):
            for i, v in enumerate(o):
                check(v, "%s[%d]" % (where, i))
    check(obj, path.name)
    path.write_text(json.dumps(obj, indent=indent, ensure_ascii=False, allow_nan=False) + "\n",
                    encoding="utf-8")


# --------------------------------------------------------------------------- #
# raster helpers
# --------------------------------------------------------------------------- #

def erode(mask, k):
    """P65's exact 8-connected erosion: k passes of a 3x3 all-true element."""
    out = mask.copy()
    nz, nx = out.shape
    for _ in range(k):
        p = np.pad(out, 1, constant_values=False)
        nxt = np.ones_like(out)
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                nxt &= p[1 + dj:1 + dj + nz, 1 + di:1 + di + nx]
        out = nxt
    return out


def label_components(mask):
    """8-connected components in row-major seed order (deterministic)."""
    nz, nx = mask.shape
    labels = np.zeros((nz, nx), dtype=np.int32)
    order = []
    for j, i in np.argwhere(mask):
        if labels[j, i]:
            continue
        lab = len(order) + 1
        stack = [(j, i)]
        labels[j, i] = lab
        count = 0
        sumx = sumz = 0.0
        minj = maxj = j
        mini = maxi = i
        while stack:
            cj, ci = stack.pop()
            count += 1
            sumx += ci
            sumz += cj
            if cj < minj: minj = cj
            if cj > maxj: maxj = cj
            if ci < mini: mini = ci
            if ci > maxi: maxi = ci
            for dj in (-1, 0, 1):
                for di in (-1, 0, 1):
                    if dj == 0 and di == 0:
                        continue
                    jj, ii = cj + dj, ci + di
                    if 0 <= jj < nz and 0 <= ii < nx and mask[jj, ii] and not labels[jj, ii]:
                        labels[jj, ii] = lab
                        stack.append((jj, ii))
        order.append({"label": lab, "cells": count,
                      "bboxRows": [minj, maxj], "bboxCols": [mini, maxi],
                      "centroidCells": [sumx / count, sumz / count]})
    return labels, order


def point_rect_distance(px, pz, cx, cz, u, v, hu, hv):
    """Exact Euclidean distance from points to an oriented rectangle (0 inside)."""
    dx = px - cx
    dz = pz - cz
    lu = dx * u[0] + dz * u[1]
    lv = dx * v[0] + dz * v[1]
    qu = np.maximum(np.abs(lu) - hu, 0.0)
    qv = np.maximum(np.abs(lv) - hv, 0.0)
    inside = (np.abs(lu) <= hu) & (np.abs(lv) <= hv)
    return np.where(inside, 0.0, np.hypot(qu, qv))


def sat_cell_vs_obb(gx, gz, cell_half, cx, cz, u, v, hu, hv):
    """Vectorised SAT: axis-aligned cell square (centre gx,gz) vs oriented box."""
    ok = np.ones(gx.shape, dtype=bool)
    for ax, az in ((1.0, 0.0), (0.0, 1.0), (u[0], u[1]), (v[0], v[1])):
        ra = cell_half * (abs(ax) + abs(az))
        rb = hu * abs(ax * u[0] + az * u[1]) + hv * abs(ax * v[0] + az * v[1])
        d = np.abs((cx - gx) * ax + (cz - gz) * az)
        ok &= d < (ra + rb)
    return ok


def sat_obb_vs_obb(gx, gz, aux, auz, ahx, ahz, cx, cz, u, v, hu, hv):
    """Vectorised SAT: car OBB at (gx,gz), axes (aux,auz)/(bux,buz), vs collider."""
    bux, buz = -auz, aux
    ok = np.ones(gx.shape, dtype=bool)
    for ax, az in ((aux, auz), (bux, buz), (u[0], u[1]), (v[0], v[1])):
        ra = ahx * abs(ax * aux + az * auz) + ahz * abs(ax * bux + az * buz)
        rb = hu * abs(ax * u[0] + az * u[1]) + hv * abs(ax * v[0] + az * v[1])
        d = np.abs((cx - gx) * ax + (cz - gz) * az)
        ok &= d < (ra + rb)
    return ok


def obb_of(c):
    ax = np.array([c["axes"][0][0], c["axes"][0][2]], dtype=float)
    az = np.array([c["axes"][2][0], c["axes"][2][2]], dtype=float)
    lu = np.linalg.norm(ax) or 1.0
    lv = np.linalg.norm(az) or 1.0
    return {
        "cx": float(c["center"][0]), "cz": float(c["center"][2]),
        "u": (float(ax[0] / lu), float(ax[1] / lu)),
        "v": (float(az[0] / lv), float(az[1] / lv)),
        "hu": float(c["half"][0] * lu), "hv": float(c["half"][2] * lv),
        "bottom": float(c["vertical"]["bottom"]),
        "top": float(c["vertical"]["top"]),
        "groundY": float(c["vertical"]["groundY"]),
    }


def arc_lookup(points, cum, x, z):
    """Nearest point on the course polyline: (arc, distance)."""
    best = (0.0, float("inf"))
    for k in range(len(points) - 1):
        ax, az = points[k]
        bx, bz = points[k + 1]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz
        t = 0.0 if L2 <= 0 else max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / L2))
        qx, qz = ax + t * dx, az + t * dz
        d = math.hypot(x - qx, z - qz)
        if d < best[1]:
            best = (cum[k] + t * math.sqrt(L2), d)
    return best


def rect_corners(cx, cz, u, v, hu, hv):
    return [(cx + su * hu * u[0] + sv * hv * v[0], cz + su * hu * u[1] + sv * hv * v[1])
            for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))]


def rect_rect_distance(a, b):
    """Exact XZ distance between two oriented rectangles (0 when they overlap).

    a, b = (cx, cz, u, v, hu, hv), u/v unit and orthogonal.
    """
    ca = rect_corners(*a)
    cb = rect_corners(*b)
    # SAT separation first
    separated = False
    for (ox, oz, u, v, hu, hv) in (a, b):
        for ax, az in ((u[0], u[1]), (v[0], v[1])):
            pa = [x * ax + z * az for x, z in ca]
            pb = [x * ax + z * az for x, z in cb]
            if max(pa) < min(pb) or max(pb) < min(pa):
                separated = True
    if not separated:
        return 0.0
    best = float("inf")
    for (px, pz) in ca:
        best = min(best, float(point_rect_distance(
            np.array([px]), np.array([pz]), b[0], b[1], b[2], b[3], b[4], b[5])[0]))
    for (px, pz) in cb:
        best = min(best, float(point_rect_distance(
            np.array([px]), np.array([pz]), a[0], a[1], a[2], a[3], a[4], a[5])[0]))
    return best


def car_rect(x, z, heading):
    return (x, z, (math.cos(heading), math.sin(heading)),
            (-math.sin(heading), math.cos(heading)), CAR_HU, CAR_HV)


def distance_to_colliders(x, z, heading, obbs):
    best = (float("inf"), None)
    car = car_rect(x, z, heading)
    for o, cid in obbs:
        # coarse cull: nothing beyond 60 m can be the nearest collider here
        if abs(o["cx"] - x) > 60.0 or abs(o["cz"] - z) > 60.0:
            continue
        b = (o["cx"], o["cz"], o["u"], o["v"], o["hu"], o["hv"])
        d = rect_rect_distance(car, b)
        if d < best[0]:
            best = (d, cid)
    return best


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main() -> int:
    import sys

    argv = sys.argv[1:]
    coll_path = COLL_IN
    out_dir = OUT
    write_region = True
    i = 0
    while i < len(argv):
        if argv[i] == "--manifest":
            coll_path = Path(argv[i + 1])
            i += 2
        elif argv[i] == "--out":
            out_dir = Path(argv[i + 1])
            i += 2
        elif argv[i] == "--no-region":
            write_region = False
            i += 1
        else:
            raise SystemExit("unknown argument %r" % argv[i])
    if not coll_path.is_absolute():
        coll_path = ROOT / coll_path
    if not out_dir.is_absolute():
        out_dir = ROOT / out_dir

    out_dir.mkdir(parents=True, exist_ok=True)
    (ROOT / "_work/logs/free-roam-prop").mkdir(parents=True, exist_ok=True)

    grid_bytes = GRID_IN.read_bytes()
    coll_bytes = coll_path.read_bytes()
    p48_bytes = P48_IN.read_bytes()
    spawn_doc = json.loads(SPAWN_IN.read_text(encoding="utf-8"))
    spawn = (float(spawn_doc["x"]), float(spawn_doc["z"]))
    if spawn != SPAWN:
        raise SystemExit("BLOCKED: committed spawn is not (-88, 1050)")

    z = np.load(GRID_IN)
    H, base_pass, labels_p48 = z["height"], z["base_pass"], z["labels_p48"]
    xs, zs = z["xs"], z["zs"]
    grid_hashes = {}
    for k, expect in GRID_ARRAY_HASHES.items():
        got = array_hash(k, z[k])
        if got != expect:
            raise SystemExit("BLOCKED: grid array %s hash changed (%s)" % (k, got))
        grid_hashes[k] = got
    manifest = json.loads(coll_bytes)
    if manifest.get("kind") != "prop-collision-colliders" or manifest.get("version") != 1:
        raise SystemExit("BLOCKED: unexpected collider manifest")
    manifest_sha = sha256_bytes(coll_bytes)
    manifest_variant = manifest.get("variant")
    if manifest_sha != COLL_SHA256 and manifest_variant != "free-roam-r04":
        raise SystemExit("BLOCKED: colliders.json sha256 changed and it is not the "
                         "documented free-roam-r04 variant")
    nz, nx = H.shape
    x0, z0 = float(xs[0]), float(zs[0])

    ce = manifest["carEnvelope"]
    if (ce["length"], ce["width"], ce["height"]) != (CAR["length"], CAR["width"], CAR["height"]):
        raise SystemExit("BLOCKED: car envelope differs from the documented P66 envelope")
    colliders = manifest["colliders"]
    if manifest_sha == COLL_SHA256 and len(colliders) != 468:
        raise SystemExit("BLOCKED: expected 468 colliders in the committed manifest")

    p48 = json.loads(p48_bytes)
    pts = [(float(p[0]), float(p[1])) for p in p48["course"]["points"]]
    cum = [0.0]
    for k in range(1, len(pts)):
        cum.append(cum[-1] + math.hypot(pts[k][0] - pts[k - 1][0],
                                        pts[k][1] - pts[k - 1][1]))
    course_len = cum[-1]

    # -- R04 ------------------------------------------------------------
    sj = int(round((SPAWN[1] - z0) / CELL))
    si = int(round((SPAWN[0] - x0) / CELL))
    r04_label = int(labels_p48[sj, si])
    r04 = labels_p48 == r04_label
    r04_cells = int(r04.sum())
    jj, ii = np.nonzero(r04)
    j0, j1, i0, i1 = int(jj.min()), int(jj.max()), int(ii.min()), int(ii.max())
    pad = 3
    cj0, cj1 = max(0, j0 - pad), min(nz - 1, j1 + pad)
    ci0, ci1 = max(0, i0 - pad), min(nx - 1, i1 + pad)
    sl = (slice(cj0, cj1 + 1), slice(ci0, ci1 + 1))
    Hc, passc, r04c = H[sl], base_pass[sl], r04[sl]
    sh, sw = Hc.shape
    gx = x0 + np.arange(ci0, ci1 + 1) * CELL
    gz = z0 + np.arange(cj0, cj1 + 1) * CELL
    GX, GZ = np.meshgrid(gx, gz)
    print("R04 label %d cells %d area %.2f bbox x %.1f..%.1f z %.1f..%.1f"
          % (r04_label, r04_cells, r04_cells * CELL * CELL,
             xs[i0], xs[i1], zs[j0], zs[j1]))

    # -- collider footprints --------------------------------------------
    patches = {}          # collider index -> (e, f, a, b, hit)
    union_all_rot = np.zeros((sh, sw), dtype=bool)
    overlap_by_heading = np.zeros((HEADINGS, sh, sw), dtype=bool)
    coll_rows = []
    overhead_ids = []
    for ci_, c in enumerate(colliders):
        o = obb_of(c)
        r = CAR_CIRCUM + CELL
        rbx = abs(o["u"][0]) * o["hu"] + abs(o["v"][0]) * o["hv"] + r
        rbz = abs(o["u"][1]) * o["hu"] + abs(o["v"][1]) * o["hv"] + r
        a = max(0, int(math.floor((o["cx"] - rbx - x0) / CELL)) - ci0)
        b = min(sw - 1, int(math.ceil((o["cx"] + rbx - x0) / CELL)) - ci0)
        e = max(0, int(math.floor((o["cz"] - rbz - z0) / CELL)) - cj0)
        f = min(sh - 1, int(math.ceil((o["cz"] + rbz - z0) / CELL)) - cj0)
        if b < a or f < e:
            continue
        lx = GX[e:f + 1, a:b + 1]
        lz = GZ[e:f + 1, a:b + 1]
        lh = Hc[e:f + 1, a:b + 1]
        with np.errstate(invalid="ignore"):
            gate = np.isfinite(lh) & (o["top"] > lh) & (o["bottom"] < lh + CAR["height"])
        if not gate.any():
            overhead_ids.append(c["id"])
            continue
        hit = sat_cell_vs_obb(lx, lz, CELL / 2.0, o["cx"], o["cz"], o["u"], o["v"],
                              o["hu"], o["hv"]) & gate
        dist = point_rect_distance(lx, lz, o["cx"], o["cz"], o["u"], o["v"],
                                   o["hu"], o["hv"])
        union_all_rot[e:f + 1, a:b + 1] |= (dist <= CAR_CIRCUM) & gate
        for h in range(HEADINGS):
            th = 2.0 * math.pi * h / HEADINGS
            ov = sat_obb_vs_obb(lx, lz, math.cos(th), math.sin(th), CAR_HU, CAR_HV,
                                o["cx"], o["cz"], o["u"], o["v"], o["hu"], o["hv"]) & gate
            overlap_by_heading[h, e:f + 1, a:b + 1] |= ov
        patches[ci_] = (e, f, a, b, hit)
        arc, darc = arc_lookup(pts, cum, o["cx"], o["cz"])
        coll_rows.append({
            "index": ci_,
            "id": c["id"], "classification": c["classification"], "source": c["source"],
            "active": bool(c["active"]),
            "center": [round(o["cx"], 3), round(o["cz"], 3)],
            "sizeXZ": [round(2 * o["hu"], 3), round(2 * o["hv"], 3)],
            "top": round(o["top"], 3), "groundY": round(o["groundY"], 3),
            "height": round(o["top"] - o["bottom"], 3),
            "inR04Cells": int((hit & r04c[e:f + 1, a:b + 1]).sum()),
            "arc": round(arc, 3), "distanceToCourse": round(darc, 3),
            "triangles": int(c["triangles"]),
            "exclusion": (c.get("exclusion") or {}).get("rule"),
        })

    obstacle = np.zeros((sh, sw), dtype=bool)
    for (e, f, a, b, hit) in patches.values():
        obstacle[e:f + 1, a:b + 1] |= hit
    print("colliders without an in-band footprint over the window: %d %s"
          % (len(overhead_ids), overhead_ids))
    print("prop footprint over R04: %d cells = %.2f m2"
          % (int((obstacle & r04c).sum()), (obstacle & r04c).sum() * CELL * CELL))

    # -- free masks -----------------------------------------------------
    pass_no_props = passc & ~obstacle
    free2 = erode(pass_no_props, P48_ERODE) & r04c
    full_obst = np.zeros(H.shape, dtype=bool)
    full_obst[sl] = obstacle
    free2_full = erode(base_pass & ~full_obst, P48_ERODE)[sl] & r04c
    crop_matches_full = bool(np.array_equal(free2, free2_full))
    free3 = erode(pass_no_props, STRICT_ERODE) & r04c
    free_no_clear = pass_no_props & r04c
    fits_some = ~np.all(overlap_by_heading, axis=0) & r04c
    any_rot_blocked = union_all_rot & r04c

    def area(m):
        return float(m.sum()) * CELL * CELL

    print("free P48 2-cell %.2f | strict 3-cell %.2f | no-clearance %.2f | fits-any-heading %.2f"
          % (area(free2), area(free3), area(free_no_clear), area(fits_some)))
    print("crop erosion == full-grid erosion:", crop_matches_full)

    # -- components ------------------------------------------------------
    def components_of(mask):
        labels, order = label_components(mask)
        spawn_lab = int(labels[sj - cj0, si - ci0])
        out = []
        for rec in order:
            lab = rec["label"]
            m = labels == lab
            p = np.pad(m, 1, constant_values=False)
            ring = np.zeros_like(m)
            for dj in (-1, 0, 1):
                for di in (-1, 0, 1):
                    if dj == 0 and di == 0:
                        continue
                    ring |= p[1 + dj:1 + dj + sh, 1 + di:1 + di + sw]
            ring &= ~m
            out.append({
                "label": lab,
                "cells": int(rec["cells"]),
                "areaM2": round(rec["cells"] * CELL * CELL, 3),
                "containsSpawn": lab == spawn_lab,
                "bboxMetres": [round(x0 + (rec["bboxCols"][0] + ci0) * CELL, 2),
                               round(x0 + (rec["bboxCols"][1] + ci0) * CELL, 2),
                               round(z0 + (rec["bboxRows"][0] + cj0) * CELL, 2),
                               round(z0 + (rec["bboxRows"][1] + cj0) * CELL, 2)],
                "centroidMetres": [round(x0 + (rec["centroidCells"][0] + ci0) * CELL, 2),
                                   round(z0 + (rec["centroidCells"][1] + cj0) * CELL, 2)],
                "perimeterCells": int(ring.sum()),
                "perimeterObstacleCells": int((ring & obstacle).sum()),
                "perimeterClearanceCells": int((ring & r04c & ~obstacle).sum()),
                "perimeterTerrainCells": int((ring & ~r04c).sum()),
                "enclosedByProps": bool(ring.sum() > 0 and (ring & r04c).sum() == ring.sum()
                                        and (ring & obstacle).sum() > 0),
            })
        out.sort(key=lambda q: (-q["areaM2"], q["bboxMetres"]))
        for k, rec in enumerate(out):
            rec["rank"] = k
        return labels, out, spawn_lab

    labels2, comps2, spawn_lab2 = components_of(free2)
    labels3, comps3, spawn_lab3 = components_of(free3)
    labels_nc, comps_nc, spawn_lab_nc = components_of(free_no_clear)
    labels_raw, comps_raw, spawn_lab_raw = components_of(passc & ~obstacle)
    _, comps_fs, spawn_lab_fs = components_of(fits_some)

    def summarise(comps, spawn_lab):
        spawn_area = next((c["areaM2"] for c in comps if c["label"] == spawn_lab), 0.0)
        big = [c for c in comps if c["cells"] >= 4]
        return {
            "areaM2": round(sum(c["areaM2"] for c in comps), 3),
            "componentCount": len(comps),
            "componentsAtLeast4Cells": len(big),
            "fragmentCount": sum(1 for c in comps if c["cells"] < 4),
            "fragmentAreaM2": round(sum(c["areaM2"] for c in comps if c["cells"] < 4), 3),
            "largestM2": comps[0]["areaM2"] if comps else 0.0,
            "largestIsSpawn": bool(comps and comps[0]["containsSpawn"]),
            "spawnComponentM2": spawn_area,
            "pockets": [c for c in comps if not c["containsSpawn"] and c["cells"] >= 4],
            "oneConnectedComponent": len(big) == 1,
        }

    s2 = summarise(comps2, spawn_lab2)
    s3 = summarise(comps3, spawn_lab3)
    snc = summarise(comps_nc, spawn_lab_nc)
    sfs = summarise(comps_fs, spawn_lab_fs)
    sraw = summarise(comps_raw, spawn_lab_raw)
    east_cell = (int(round((1292.5 - z0) / CELL)) - cj0,
                 int(round((103.5 - x0) / CELL)) - ci0)
    east_connected = bool(0 <= east_cell[0] < sh and 0 <= east_cell[1] < sw
                          and spawn_lab_raw != 0
                          and labels_raw[east_cell] == spawn_lab_raw)
    print("P48 2-cell   comps=%d largest=%.2f spawn=%.2f pockets=%d"
          % (s2["componentsAtLeast4Cells"], s2["largestM2"], s2["spawnComponentM2"],
             len(s2["pockets"])))
    print("strict 3-cell comps=%d largest=%.2f spawn=%.2f pockets=%d"
          % (s3["componentsAtLeast4Cells"], s3["largestM2"], s3["spawnComponentM2"],
             len(s3["pockets"])))
    print("no-clearance comps=%d largest=%.2f spawn=%.2f pockets=%d"
          % (snc["componentsAtLeast4Cells"], snc["largestM2"], snc["spawnComponentM2"],
             len(snc["pockets"])))
    print("fits-any-heading comps=%d largest=%.2f spawn=%.2f pockets=%d"
          % (sfs["componentsAtLeast4Cells"], sfs["largestM2"], sfs["spawnComponentM2"],
             len(sfs["pockets"])))

    spawn_free = bool(free2[sj - cj0, si - ci0])
    if not spawn_free:
        raise SystemExit("BLOCKED: the committed spawn cell is not free under all-visible")

    # -- clusters --------------------------------------------------------
    parent = list(range(len(coll_rows)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    boxes = []
    for r in coll_rows:
        hu, hv = r["sizeXZ"][0] / 2, r["sizeXZ"][1] / 2
        cx, cz = r["center"]
        boxes.append((cx - hu, cx + hu, cz - hv, cz + hv))
    for a_ in range(len(coll_rows)):
        for b_ in range(a_ + 1, len(coll_rows)):
            if (boxes[a_][0] <= boxes[b_][1] + 1.0 and boxes[b_][0] <= boxes[a_][1] + 1.0
                    and boxes[a_][2] <= boxes[b_][3] + 1.0 and boxes[b_][2] <= boxes[a_][3] + 1.0):
                union(a_, b_)
    groups = {}
    for k, r in enumerate(coll_rows):
        groups.setdefault(find(k), []).append(k)
    clusters = []
    for root, members in groups.items():
        cs = [coll_rows[k] for k in members if coll_rows[k]["inR04Cells"] > 0]
        if not cs:
            continue
        clusters.append({
            "memberCount": len(members),
            "membersInR04": len(cs),
            "colliderIds": [r["id"] for r in cs],
            "memberColliderIds": [coll_rows[k]["id"] for k in members],
            "memberIndices": [coll_rows[k]["index"] for k in members],
            "classes": dict(Counter(r["classification"] for r in cs)),
            "sources": dict(Counter(r["source"] for r in cs)),
            "activeCount": sum(1 for r in cs if r["active"]),
            "inactiveOnCourseCount": sum(1 for r in cs if not r["active"]),
            "centroid": [round(sum(r["center"][0] for r in cs) / len(cs), 2),
                         round(sum(r["center"][1] for r in cs) / len(cs), 2)],
            "bboxMetres": [round(min(boxes[k][0] for k in members), 2),
                           round(max(boxes[k][1] for k in members), 2),
                           round(min(boxes[k][2] for k in members), 2),
                           round(max(boxes[k][3] for k in members), 2)],
            "footprintCellsInR04": int(sum(r["inR04Cells"] for r in cs)),
            "arcRange": [round(min(r["arc"] for r in cs), 2),
                         round(max(r["arc"] for r in cs), 2)],
            "distanceToCourseRange": [round(min(r["distanceToCourse"] for r in cs), 2),
                                      round(max(r["distanceToCourse"] for r in cs), 2)],
        })
    clusters.sort(key=lambda q: (-q["footprintCellsInR04"], q["bboxMetres"]))
    for k, c in enumerate(clusters):
        c["id"] = "C%02d" % (k + 1)
        c["indexSet"] = sorted(c["memberIndices"])
        del c["memberIndices"]
    cluster_of = {}
    for c in clusters:
        for idx in c["indexSet"]:
            for row in coll_rows:
                if row["index"] == idx:
                    cluster_of[row["id"]] = c["id"]
                    break
    for r in coll_rows:
        r["cluster"] = cluster_of.get(r["id"])
    print("clusters touching R04:", len(clusters))

    # -- ablation --------------------------------------------------------
    spawn_area_now = s2["spawnComponentM2"]

    def ablate(skip_idx, tag):
        ob = np.zeros((sh, sw), dtype=bool)
        for idx, (e, f, a, b, hit) in patches.items():
            if idx in skip_idx:
                continue
            ob[e:f + 1, a:b + 1] |= hit
        fr = erode(passc & ~ob, P48_ERODE) & r04c
        lab, order = label_components(fr)
        sl_ = int(lab[sj - cj0, si - ci0])
        if sl_ == 0:
            return {"target": tag, "error": "spawn lost"}
        ab = float((lab == sl_).sum()) * CELL * CELL
        pockets_after = sum(1 for rec in order if rec["label"] != sl_ and rec["cells"] >= 4)
        pocket_area = sum(rec["cells"] * CELL * CELL for rec in order
                          if rec["label"] != sl_ and rec["cells"] >= 4)
        return {"target": tag, "spawnAreaM2": round(ab, 3),
                "gainM2": round(ab - spawn_area_now, 3),
                "pocketsAfter": pockets_after,
                "pocketAreaM2": round(pocket_area, 3),
                "freeAreaM2": round(float(fr.sum()) * CELL * CELL, 3)}

    ablation = []
    for cl in clusters:
        if cl["footprintCellsInR04"] == 0:
            continue
        rec = ablate(set(cl["indexSet"]), cl["id"])
        ablation.append(rec)
        print("ablate %s: spawn %.2f m2 (gain %+.2f), pockets %d"
              % (cl["id"], rec.get("spawnAreaM2", 0), rec.get("gainM2", 0),
                 rec.get("pocketsAfter", -1)))
    on_course_idx = {r["index"] for r in coll_rows if not r["active"]}
    active_idx = {r["index"] for r in coll_rows if r["active"]}
    for tag, idxs in (
            ("allOnCourseRemoved (= roadside)", on_course_idx),
            ("allActiveRemoved", active_idx),
            ("allPropsRemoved (= R04)", on_course_idx | active_idx)):
        rec = ablate(idxs, tag)
        ablation.append(rec)
        print("ablate %-34s spawn %.2f m2 (gain %+.2f), pockets %d"
              % (tag, rec.get("spawnAreaM2", 0), rec.get("gainM2", 0),
                 rec.get("pocketsAfter", -1)))

    # which clusters sit on each pocket's cut line
    obs_by_cluster = {}
    for cl in clusters:
        m = np.zeros((sh, sw), dtype=bool)
        for idx in cl["indexSet"]:
            if idx not in patches:
                continue
            e, f, a, b, hit = patches[idx]
            m[e:f + 1, a:b + 1] |= hit
        obs_by_cluster[cl["id"]] = m
        cl["footprintCellsInR04Union"] = int((m & r04c).sum())
        cl["footprintAreaInR04M2"] = round(float((m & r04c).sum()) * CELL * CELL, 3)
        cl["memberFootprintCellsSum"] = cl["footprintCellsInR04"]

    def dilate(m, k):
        out = m.copy()
        for _ in range(k):
            p = np.pad(out, 1, constant_values=False)
            nd = out.copy()
            for dj in (-1, 0, 1):
                for di in (-1, 0, 1):
                    if dj == 0 and di == 0:
                        continue
                    nd |= p[1 + dj:1 + dj + sh, 1 + di:1 + di + sw]
            out = nd
        return out

    spawn_mask = labels2 == spawn_lab2
    for pocket in s2["pockets"]:
        m = labels2 == pocket["label"]
        dil = dilate(m, 4)
        hits = []
        for cid, cm in obs_by_cluster.items():
            n = int((cm & dil).sum())
            if n:
                hits.append({"cluster": cid, "footprintCellsNearPocket": n})
        hits.sort(key=lambda q: -q["footprintCellsNearPocket"])
        pocket["adjacentClusters"] = hits
        # geometric separation from the spawn component (props + clearance)
        gap = None
        for k in range(1, 41):
            inter = dilate(spawn_mask, k) & dilate(m, k)
            if inter.any():
                gap = k
                break
        if gap is None:
            pocket["separationFromSpawn"] = {"found": False}
            continue
        inter = dilate(spawn_mask, gap) & dilate(m, gap)
        jj_, ii_ = np.nonzero(inter)
        gate_cells = obstacle & inter
        gate_by_cluster = {}
        for cid, cm in obs_by_cluster.items():
            n = int((cm & gate_cells).sum())
            if n:
                gate_by_cluster[cid] = n
        pocket["separationFromSpawn"] = {
            "found": True,
            "halfGapCells": int(gap),
            "gapMetres": round(2.0 * gap * CELL, 2),
            "gateBboxMetres": [round(x0 + (ii_.min() + ci0) * CELL, 2),
                               round(x0 + (ii_.max() + ci0) * CELL, 2),
                               round(z0 + (jj_.min() + cj0) * CELL, 2),
                               round(z0 + (jj_.max() + cj0) * CELL, 2)],
            "gateCentreMetres": [round(x0 + (0.5 * (ii_.min() + ii_.max()) + ci0) * CELL, 2),
                                 round(z0 + (0.5 * (jj_.min() + jj_.max()) + cj0) * CELL, 2)],
            "gateCells": int(inter.sum()),
            "gateObstacleCells": int(gate_cells.sum()),
            "gateClusters": dict(sorted(gate_by_cluster.items(),
                                        key=lambda kv: -kv[1])),
            "note": "gapMetres is twice the smallest k for which the k-cell dilations of "
                    "the two components intersect; it is the width of the band that "
                    "separates them (prop footprint + the 1.0 m clearance on each side)",
        }

    # separation with NO extra clearance: does the prop footprint alone split it?
    nc_pockets = [c for c in comps_nc if not c["containsSpawn"] and c["cells"] >= 4]
    nc_sep = {"separated": bool(nc_pockets)}
    if nc_pockets:
        big_nc = max(nc_pockets, key=lambda q: q["areaM2"])
        A_ = labels_nc == spawn_lab_nc
        B_ = labels_nc == big_nc["label"]
        for k in range(1, 21):
            if (dilate(A_, k) & dilate(B_, k)).any():
                nc_sep.update({"halfGapCells": k, "gapMetres": round(2.0 * k * CELL, 2)})
                break
        nc_sep["pocketAreaM2"] = big_nc["areaM2"]
        nc_sep["spawnAreaM2"] = snc["spawnComponentM2"]

    # -- reachability -----------------------------------------------------
    INF = float("inf")
    dist = np.full((sh, sw), INF)
    prev = np.full((sh, sw, 2), -1, dtype=np.int32)
    start = (sj - cj0, si - ci0)
    dist[start] = 0.0
    heap = [(0.0, start[0], start[1])]
    while heap:
        d, cj, ci = heapq.heappop(heap)
        if d > dist[cj, ci]:
            continue
        for dj, di, w in STEP8:
            jj_, ii_ = cj + dj, ci + di
            if not (0 <= jj_ < sh and 0 <= ii_ < sw and free2[jj_, ii_]):
                continue
            if dj != 0 and di != 0 and not (free2[cj, ii_] and free2[jj_, ci]):
                continue
            nd = d + w
            if nd < dist[jj_, ii_] - 1e-12:
                dist[jj_, ii_] = nd
                prev[jj_, ii_] = (cj, ci)
                heapq.heappush(heap, (nd, jj_, ii_))

    def cell_of(x, zc):
        return (int(round((zc - z0) / CELL)) - cj0, int(round((x - x0) / CELL)) - ci0)

    reach = {}
    for name, pt in (("westDiameterEnd", (-103.5, 1012.5)),
                     ("eastDiameterEnd", (103.5, 1292.5)),
                     ("suggestedSpawn", (-66.0, 1108.5))):
        c = cell_of(*pt)
        reach[name] = {"point": list(pt), "freeCell": bool(free2[c]),
                       "onR04": bool(r04c[c]),
                       "geodesicFromSpawnM": (round(float(dist[c]), 3)
                                              if np.isfinite(dist[c]) else None)}
    finite = np.isfinite(dist)
    far = np.unravel_index(np.argmax(np.where(finite, dist, -1.0)), dist.shape)
    far_pt = (round(x0 + (far[1] + ci0) * CELL, 2), round(z0 + (far[0] + cj0) * CELL, 2))
    reach["farthest"] = {"point": list(far_pt),
                         "geodesicFromSpawnM": round(float(dist[far]), 3)}
    reach["reachableCells"] = int(finite.sum())
    reach["reachableAreaM2"] = round(float(finite.sum()) * CELL * CELL, 3)
    print("reachability", json.dumps(reach))

    # -- clearance field + route -----------------------------------------
    clear = np.where(free2, 1e9, 0.0)
    for _ in range(600):
        p = np.pad(clear, 1, constant_values=0.0)
        cand = np.minimum.reduce(
            [p[1 + dj:1 + dj + sh, 1 + di:1 + di + sw] +
             (0.0 if (dj == 0 or di == 0) else 0.4142 * CELL)
             for dj in (-1, 0, 1) for di in (-1, 0, 1) if not (dj == 0 and di == 0)])
        nxt = np.where(free2, np.minimum(clear, cand + CELL), 0.0)
        if np.allclose(nxt, clear, atol=1e-9):
            break
        clear = nxt

    cost = np.full((sh, sw), INF)
    cprev = np.full((sh, sw, 2), -1, dtype=np.int32)
    cost[start] = 0.0
    heap = [(0.0, start[0], start[1])]
    while heap:
        d, cj, ci = heapq.heappop(heap)
        if d > cost[cj, ci]:
            continue
        for dj, di, w in STEP8:
            jj_, ii_ = cj + dj, ci + di
            if not (0 <= jj_ < sh and 0 <= ii_ < sw and free2[jj_, ii_]):
                continue
            if dj != 0 and di != 0 and not (free2[cj, ii_] and free2[jj_, ci]):
                continue
            nd = d + w * (1.0 + 6.0 / max(clear[jj_, ii_], CELL))
            if nd < cost[jj_, ii_] - 1e-12:
                cost[jj_, ii_] = nd
                cprev[jj_, ii_] = (cj, ci)
                heapq.heappush(heap, (nd, jj_, ii_))

    path = []
    margin_cells = 4
    cand = np.where(finite & (clear >= margin_cells), dist, -1.0)
    if float(cand.max()) <= 0.0:
        cand = np.where(finite, dist, -1.0)
    tgt = np.unravel_index(np.argmax(cand), cand.shape)
    tgt_pt = (round(x0 + (tgt[1] + ci0) * CELL, 2),
              round(z0 + (tgt[0] + cj0) * CELL, 2))
    cj, ci = tgt
    guard = 0
    while (cj, ci) != start and guard < 2_000_000:
        path.append((cj, ci))
        pj, pi = cprev[cj, ci]
        if pj < 0:
            raise SystemExit("route reconstruction failed")
        cj, ci = int(pj), int(pi)
        guard += 1
    path.append(start)
    path.reverse()
    route_pts = [{"x": round(x0 + (ci + ci0) * CELL, 3),
                  "z": round(z0 + (cj + cj0) * CELL, 3),
                  "freeEdgeDistanceM": round(float(clear[cj, ci]), 3)} for cj, ci in path]

    resampled = [route_pts[0]]
    acc = 0.0
    for k in range(1, len(route_pts)):
        acc += math.hypot(route_pts[k]["x"] - route_pts[k - 1]["x"],
                          route_pts[k]["z"] - route_pts[k - 1]["z"])
        if acc >= 1.0 or k == len(route_pts) - 1:
            resampled.append(route_pts[k])
            acc = 0.0
    for k, p in enumerate(resampled):
        a = resampled[max(0, k - 1)]
        b = resampled[min(len(resampled) - 1, k + 1)]
        p["heading"] = round(math.atan2(b["z"] - a["z"], b["x"] - a["x"]), 6)
    route_len = sum(math.hypot(resampled[k + 1]["x"] - resampled[k]["x"],
                               resampled[k + 1]["z"] - resampled[k]["z"])
                    for k in range(len(resampled) - 1))
    obbs = [(obb_of(c), c["id"]) for c in colliders]
    route_clear = []
    for p in resampled:
        d, cid = distance_to_colliders(p["x"], p["z"], p["heading"], obbs)
        p["propClearanceM"] = round(float(d), 3)
        p["nearestCollider"] = cid
        route_clear.append(float(d))
    print("route: %d cells, %d samples, %.2f m, min prop clearance %.3f m"
          % (len(route_pts), len(resampled), route_len, min(route_clear)))

    spawn_heading = float(spawn_doc.get("heading", math.pi / 2))
    spawn_clear, spawn_near = distance_to_colliders(spawn[0], spawn[1], spawn_heading, obbs)
    worst = (float("inf"), None, None)
    for h in range(HEADINGS):
        th = 2.0 * math.pi * h / HEADINGS
        d, cid = distance_to_colliders(spawn[0], spawn[1], th, obbs)
        if d < worst[0]:
            worst = (d, cid, th)
    print("spawn clearance: committed heading %.1f deg -> %.3f m from %s; "
          "worst heading -> %.3f m" % (math.degrees(spawn_heading), spawn_clear,
                                       spawn_near, worst[0]))

    # -- ground lattice ---------------------------------------------------
    gstep = 1.0
    gxs = np.arange(x0 + i0 * CELL, x0 + i1 * CELL + 1e-9, gstep)
    gzs = np.arange(z0 + j0 * CELL, z0 + j1 * CELL + 1e-9, gstep)
    jidx = np.clip(np.round((gzs - z0) / CELL).astype(int), 0, nz - 1)
    iidx = np.clip(np.round((gxs - x0) / CELL).astype(int), 0, nx - 1)
    samples = H[np.ix_(jidx, iidx)].astype(np.float64)
    finite_s = np.isfinite(samples)
    ground_err = 0.0
    if not finite_s.all():
        samples[~finite_s] = float(np.nanmedian(samples[finite_s]))
    ground_err = float(np.nanmax(np.abs(samples - H[np.ix_(jidx, iidx)])))
    print("ground lattice %dx%d max |1m - 0.5m| = %.4f m"
          % (len(gxs), len(gzs), ground_err))

    # -- write -----------------------------------------------------------
    np.savez_compressed(out_dir / "mask.npz",
                        r04=r04c, obstacle=obstacle, free2=free2, free3=free3,
                        fitsSomeHeading=fits_some, anyRotationBlocked=any_rot_blocked,
                        labels2=labels2, gx=gx, gz=gz)
    zz = np.load(out_dir / "mask.npz")
    mask_content = hashlib.sha256("".join(
        "%s:%s" % (k, array_hash(k, zz[k])) for k in sorted(zz.files)).encode()).hexdigest()

    write_json(out_dir / "route.json", {
        "kind": "free-roam-prop.route", "version": 1, "profile": "all-visible",
        "model": "P48 2-cell free mask, clearance-weighted 8-connected Dijkstra",
        "spawn": list(SPAWN), "target": list(tgt_pt),
        "lengthM": round(route_len, 3), "pathCells": len(route_pts),
        "points": resampled,
        "note": "freeEdgeDistanceM is the chamfer distance (m) from the cell to the nearest "
                "non-free cell; the mask already includes the 1.0 m P48 clearance. "
                "propClearanceM is the exact car-rectangle to collider-rectangle distance. "
                "headings are the local path tangent, not a vehicle yaw",
    })
    write_json(out_dir / "ground.json", {
        "kind": "free-roam-prop.ground", "version": 1, "sampleStepM": gstep,
        "x0": round(float(gxs[0]), 3), "z0": round(float(gzs[0]), 3),
        "nx": int(len(gxs)), "nz": int(len(gzs)),
        "maxErrorVsHalfMetreRaster": round(ground_err, 5),
        "values": [[round(float(v), 4) for v in row] for row in samples],
        "note": "nearest-neighbour ground lattice; used only for the 1.35 m car-body "
                "vertical filter in the Node resolver tests",
    })

    route_notes = []
    if s2["pockets"]:
        sep = s2["pockets"][0].get("separationFromSpawn") or {}
        if sep.get("found"):
            route_notes.append(("C03 gate, %.1f m band" % sep["gapMetres"],
                                sep["gateCentreMetres"]))
        route_notes.append(("cut off %.0f m2" % s2["pockets"][0]["areaM2"],
                            (s2["pockets"][0]["centroidMetres"][0],
                             s2["pockets"][0]["centroidMetres"][1])))
    route_notes.append(("reachable %.0f m2" % s2["spawnComponentM2"], (-62.0, 1148.0)))

    map_path = out_dir / "map.png"
    draw_map(r04c, obstacle, free2, free3, colliders, pts, spawn,
             (x0 + ci0 * CELL, x0 + ci1 * CELL, z0 + cj0 * CELL, z0 + cj1 * CELL),
             resampled, labels2, spawn_lab2, route_notes, map_path)

    props = {
        "kind": "free-roam-prop.props", "version": 1,        "scope": {
            "visibleMeshApproximation": True,
            "retailCollision": False,
            "collisionSurfaceUsedAsCollider": False,
            "engineRun": False,
            "rendererClaim": False,
            "gameClaim": False,
            "e1DriveIntegration": False,
            "statement": "P66 all-visible collider footprints rasterised over the P65 R04 "
                         "basin at 0.5 m with the P48 2-cell clearance model. Data-only; "
                         "no engine, renderer, browser or playable-game claim.",
        },
        "inputs": {
            "grid": {"path": "_work/free-roam/grid.npz", "sha256": sha256_bytes(grid_bytes),
                     "arrays": grid_hashes,
                     "source": "P65 committed rasters; consumed, not re-derived"},
            "colliders": {"path": (coll_path.relative_to(ROOT).as_posix()
                                   if coll_path.is_relative_to(ROOT) else str(coll_path)),
                          "sha256": sha256_bytes(coll_bytes),
                          "contentSha256": manifest.get("contentSha256"),
                          "variant": manifest_variant,
                          "committedP66": manifest_sha == COLL_SHA256,
                          "colliderCount": len(colliders)},
            "course": {"path": "_work/drivable-path/path.json",
                       "sha256": sha256_bytes(p48_bytes),
                       "lengthM": round(course_len, 4), "samples": len(pts)},
            "spawn": {"path": "_work/e1-drive/spawn.json", "x": spawn[0], "z": spawn[1]},
        },
        "model": {
            "cellMetres": CELL,
            "r04Definition": "P65 labels_p48 == spawn label (%d)" % r04_label,
            "p48ErodeCells": P48_ERODE, "p48ErodeMetres": P48_ERODE * CELL,
            "strictErodeCells": STRICT_ERODE, "strictErodeMetres": STRICT_ERODE * CELL,
            "obstacleRaster": "a cell is marked when its 0.5 m square intersects a collider "
                              "XZ footprint (2D SAT) and the collider span crosses the cell's "
                              "[ground, ground + 1.35 m] car-body band",
            "clearanceModel": "free = erode(base_pass AND NOT obstacle, 2 cells); the prop "
                              "obstacle gets the same 1.0 m clearance the P48 mask gives the "
                              "collision walls",
            "carEnvelope": dict(CAR, circumradius=round(CAR_CIRCUM, 5),
                                source=ce["source"]),
            "headingSamples": HEADINGS,
            "routeModel": "clearance-weighted 8-connected Dijkstra, no corner cutting, "
                          "resampled at 1.0 m with the local tangent heading",
        },
        "r04": {
            "label": r04_label, "cells": r04_cells,
            "areaM2": round(r04_cells * CELL * CELL, 3),
            "bboxMetres": [round(xs[i0], 2), round(xs[i1], 2),
                           round(zs[j0], 2), round(zs[j1], 2)],
            "spawnCell": [int(si), int(sj)],
            "spawnCellFree": spawn_free,
            "spawnClearance": {
                "committedHeadingRad": round(spawn_heading, 6),
                "committedHeadingDistanceM": round(float(spawn_clear), 3),
                "committedHeadingNearestCollider": spawn_near,
                "worstHeadingRad": round(float(worst[2]), 6),
                "worstHeadingDistanceM": round(float(worst[0]), 3),
                "worstHeadingNearestCollider": worst[1],
                "overlaps": bool(spawn_clear <= 0.0),
                "note": "exact XZ distance between the 2.98 x 1.68 m car rectangle and the "
                        "nearest collider rectangle, before any vehicle motion",
            },
            "spawnInsideObstacle": bool(obstacle[sj - cj0, si - ci0]),
            "areaWithin30mOfCourseM2": None,
            "areaBeyond30mOfCourseM2": None,
        },
        "props": {
            "colliderCount": len(colliders),
            "collidersOverWindow": len(coll_rows),
            "overheadExcluded": overhead_ids,
            "footprintCellsInR04": int((obstacle & r04c).sum()),
            "footprintAreaM2": round(area(obstacle & r04c), 3),
            "byClass": dict(Counter(r["classification"] for r in coll_rows
                                    if r["inR04Cells"] > 0)),
            "inactiveOnCourseBlocksR04": sum(1 for r in coll_rows
                                             if not r["active"] and r["inR04Cells"] > 0),
            "activeBlocksR04": sum(1 for r in coll_rows
                                   if r["active"] and r["inR04Cells"] > 0),
            "colliders": sorted([r for r in coll_rows if r["inR04Cells"] > 0],
                                key=lambda q: (-q["inR04Cells"], q["id"])),
        },
        "free": {
            "areaM2": s2["areaM2"],
            "fractionOfR04": round(s2["areaM2"] / (r04_cells * CELL * CELL), 6),
            "largestComponentM2": s2["largestM2"],
            "largestComponentIsSpawn": s2["largestIsSpawn"],
            "spawnComponentM2": s2["spawnComponentM2"],
            "componentCount": s2["componentCount"],
            "componentsAtLeast4Cells": s2["componentsAtLeast4Cells"],
            "fragmentCount": s2["fragmentCount"],
            "fragmentAreaM2": s2["fragmentAreaM2"],
            "pocketCount": len(s2["pockets"]),
            "pockets": s2["pockets"],
            "oneConnectedComponent": s2["oneConnectedComponent"],
            "components": comps2,
        },
        "blocked": {
            "lostFromR04M2": round(r04_cells * CELL * CELL - s2["areaM2"], 3),
            "footprintM2": round(area(obstacle & r04c), 3),
            "clearanceRingM2": round(r04_cells * CELL * CELL - s2["areaM2"]
                                     - area(obstacle & r04c), 3),
            "freeWithoutClearanceM2": round(area(free_no_clear), 3),
        },
        "sensitivities": {
            "strict3Cell": {
                "areaM2": s3["areaM2"], "componentCount": s3["componentCount"],
                "componentsAtLeast4Cells": s3["componentsAtLeast4Cells"],
                "pocketCount": len(s3["pockets"]), "pockets": s3["pockets"],
                "spawnComponentM2": s3["spawnComponentM2"],
                "oneConnectedComponent": s3["oneConnectedComponent"],
                "components": comps3,
            },
            "noClearance": {
                "areaM2": snc["areaM2"], "componentCount": snc["componentCount"],
                "componentsAtLeast4Cells": snc["componentsAtLeast4Cells"],
                "pocketCount": len(snc["pockets"]),
                "oneConnectedComponent": snc["oneConnectedComponent"],
                "spawnComponentM2": snc["spawnComponentM2"],
                "largestPocketSeparation": nc_sep,
                "note": "props only, no extra clearance: the obstacle footprint itself "
                        "separates the same largest pocket",
            },
            "envelopeFitsSomeHeading": {
                "areaM2": sfs["areaM2"], "componentCount": sfs["componentCount"],
                "componentsAtLeast4Cells": sfs["componentsAtLeast4Cells"],
                "pocketCount": len(sfs["pockets"]),
                "spawnComponentM2": sfs["spawnComponentM2"],
                "oneConnectedComponent": sfs["oneConnectedComponent"],
                "note": "cell free when the 2.98x1.68 m envelope at the cell centre clears "
                        "every collider in at least one of 24 headings; props only, terrain "
                        "boundary not included",
            },
            "envelopeAnyRotationBlocked": {
                "areaM2": round(area(any_rot_blocked), 3),
                "note": "union over all headings = collider dilated by the car circumradius "
                        "1.7103 m; pessimistic upper bound, not a drivable set",
            },
            "rawPassableNoErosion": {
                "areaM2": sraw["areaM2"],
                "componentCount": sraw["componentCount"],
                "componentsAtLeast4Cells": sraw["componentsAtLeast4Cells"],
                "spawnComponentM2": sraw["spawnComponentM2"],
                "pocketCount": len(sraw["pockets"]),
                "eastDiameterEndConnectedToSpawn": east_connected,
                "note": "the P48 passable mask (step/grade/wall limits) minus the prop "
                        "footprints, with zero erosion: even a point car is cut off from "
                        "the eastern channel, so the split is not produced by the 1.0 m "
                        "clearance rule alone",
            },
        },
        "clusters": clusters,
        "ablation": ablation,
        "reachability": reach,
        "route": {"lengthM": round(route_len, 3), "points": len(resampled),
                  "target": list(tgt_pt),
                  "minPropClearanceM": round(min(route_clear), 3)},
        "cropErosionMatchesFullGrid": crop_matches_full,
    }

    px = xs[ii]
    pz = zs[jj]
    dd = np.full(px.shape, np.inf)
    for k in range(len(pts) - 1):
        ax, az = pts[k]
        bx, bz = pts[k + 1]
        abx, abz = bx - ax, bz - az
        L2 = abx * abx + abz * abz
        t = 0.0 if L2 <= 0 else np.clip(((px - ax) * abx + (pz - az) * abz) / L2, 0.0, 1.0)
        dd = np.minimum(dd, np.hypot(px - (ax + t * abx), pz - (az + t * abz)))
    props["r04"]["areaWithin30mOfCourseM2"] = round(float((dd <= 30.0).sum()) * CELL * CELL, 3)
    props["r04"]["areaBeyond30mOfCourseM2"] = round(float((dd > 30.0).sum()) * CELL * CELL, 3)
    props["r04"]["fractionBeyond30mOfCourse"] = round(float((dd > 30.0).sum()) / len(dd), 6)

    # same split restricted to the area reachable from the spawn under all-visible
    reach_flat = (free2 & (labels2 == spawn_lab2))[jj - cj0, ii - ci0]
    props["r04"]["reachableWithin30mOfCourseM2"] = round(
        float(((dd <= 30.0) & reach_flat).sum()) * CELL * CELL, 3)
    props["r04"]["reachableBeyond30mOfCourseM2"] = round(
        float(((dd > 30.0) & reach_flat).sum()) * CELL * CELL, 3)
    props["r04"]["reachableFractionBeyond30mOfCourse"] = round(
        float(((dd > 30.0) & reach_flat).sum()) / max(int(reach_flat.sum()), 1), 6)
    props["r04"]["colliderRegionNote"] = (
        "the P66 manifest is bounded to 30 m around the measured course; the prop "
        "footprints outside that band are not colliders in any profile, so the "
        "reachableBeyond30m figure is the part of the reachable basin with no prop "
        "collision coverage")

    # -- region export for the extended collider build --------------------
    # Run-length rows of the reachable component, so the Node builder can test
    # "inside the component or within a ring" without a raster library.
    region_rows = []
    reach_mask_r = free2 & (labels2 == spawn_lab2)
    reach_idx = np.argwhere(reach_mask_r)
    reach_area = float(reach_mask_r.sum()) * CELL * CELL
    by_row = {}
    for j_, i_ in reach_idx:
        by_row.setdefault(int(j_), []).append(int(i_))
    for j_ in sorted(by_row):
        cols = sorted(by_row[j_])
        runs = []
        start = cols[0]
        prev = cols[0]
        for c_ in cols[1:]:
            if c_ == prev + 1:
                prev = c_
                continue
            runs.append([round(x0 + (start + ci0) * CELL, 3),
                         round(x0 + (prev + ci0) * CELL, 3)])
            start = prev = c_
        runs.append([round(x0 + (start + ci0) * CELL, 3),
                     round(x0 + (prev + ci0) * CELL, 3)])
        region_rows.append({"z": round(z0 + (j_ + cj0) * CELL, 3), "runs": runs})
    region_doc = {
        "kind": "free-roam-prop.region", "version": 1,
        "cellMetres": CELL,
        "component": "labels2 == spawn component under the manifest in inputs",
        "manifestSha256": sha256_bytes(coll_bytes),
        "manifestCommittedP66": manifest_sha == COLL_SHA256,
        "cells": int(reach_mask_r.sum()),
        "areaM2": round(reach_area, 3),
        "bboxMetres": [round(x0 + (int(reach_idx[:, 1].min()) + ci0) * CELL, 2),
                       round(x0 + (int(reach_idx[:, 1].max()) + ci0) * CELL, 2),
                       round(z0 + (int(reach_idx[:, 0].min()) + cj0) * CELL, 2),
                       round(z0 + (int(reach_idx[:, 0].max()) + cj0) * CELL, 2)],
        "ringMetres": 30.0,
        "rows": region_rows,
        "note": "each run is a contiguous set of 0.5 m cell centres at the row z; the "
                "region for the extended collider build is the union of those cells "
                "plus a 30 m ring",
    }
    if write_region:
        write_json(out_dir / "region.json", region_doc)
        region_sha = sha256_bytes((out_dir / "region.json").read_bytes())
    else:
        region_sha = None

    # P48 course classified against the all-visible free mask
    reach_mask = free2 & (labels2 == spawn_lab2)
    course_rows = []
    counts = {"reachable": 0, "pocket": 0, "blocked": 0, "outsideR04": 0}
    for k, (px_, pz_) in enumerate(pts):
        c = cell_of(px_, pz_)
        if not (0 <= c[0] < sh and 0 <= c[1] < sw):
            kind = "outsideR04"
        elif reach_mask[c]:
            kind = "reachable"
        elif free2[c]:
            kind = "pocket"
        elif r04c[c]:
            kind = "blocked"
        else:
            kind = "outsideR04"
        counts[kind] += 1
        course_rows.append((cum[k], kind))
    arcs = {}
    for arc, kind in course_rows:
        a = arcs.setdefault(kind, {"first": arc, "last": arc, "samples": 0})
        a["last"] = arc
        a["samples"] += 1
    props["course"] = {
        "samples": len(pts),
        "counts": counts,
        "arcs": {k: {"firstArc": round(v["first"], 3), "lastArc": round(v["last"], 3),
                     "samples": v["samples"]} for k, v in arcs.items()},
        "note": "every 4th committed 0.25 m course sample classified against the "
                "all-visible free mask; a 'pocket' sample is free but not reachable from "
                "the spawn component",
    }

    write_json(out_dir / "props.json", props)

    outputs = {
        "props.json": sha256_bytes((out_dir / "props.json").read_bytes()),
        "route.json": sha256_bytes((out_dir / "route.json").read_bytes()),
        "ground.json": sha256_bytes((out_dir / "ground.json").read_bytes()),
        "map.png": sha256_bytes(map_path.read_bytes()),
        "mask.npz.content": mask_content,
    }
    if region_sha is not None:
        outputs["region.json"] = region_sha
    inputs_hashes = {
        "_work/free-roam/grid.npz": sha256_bytes(grid_bytes),
        "_work/drivable-path/path.json": sha256_bytes(p48_bytes),
    }
    inputs_hashes[(coll_path.relative_to(ROOT).as_posix()
                   if coll_path.is_relative_to(ROOT) else str(coll_path))] = \
        sha256_bytes(coll_bytes)
    write_json(out_dir / "hashes.json", {
        "kind": "free-roam-prop.hashes", "version": 1,
        "inputs": inputs_hashes,
        "outputs": outputs,
        "propsCanonical": "sha256:" + sha256_bytes(canonical(props).encode("utf-8")),
    })
    print("wrote", out_dir)
    return 0


# --------------------------------------------------------------------------- #
# map
# --------------------------------------------------------------------------- #

def draw_map(r04c, obstacle, free2, free3, colliders, pts, spawn, bounds, route,
             labels2=None, spawn_label=0, notes=None, out_png=None):
    xa, xb, za, zb = bounds
    scale = 3.0
    sh, sw = r04c.shape

    reachable = free2.copy()
    if labels2 is not None:
        reachable = free2 & (labels2 == spawn_label)

    cell_rgb = np.zeros((sh, sw, 3), dtype=np.uint8)
    cell_rgb[..., :] = (245, 245, 240)
    cell_rgb[r04c & ~free3] = (238, 196, 96)
    cell_rgb[free3 & ~free2] = (150, 205, 140)
    cell_rgb[free2] = (86, 176, 96)
    cell_rgb[free2 & ~reachable] = (110, 200, 220)
    cell_rgb[obstacle] = (196, 48, 48)

    img = Image.fromarray(cell_rgb, "RGB").resize(
        (int(round(sw * scale)), int(round(sh * scale))), Image.NEAREST)
    d = ImageDraw.Draw(img, "RGBA")

    def S(x, z):
        return (int(round((x - xa) / CELL * scale)), int(round((z - za) / CELL * scale)))

    d.line([S(p[0], p[1]) for p in pts], fill=(20, 20, 20, 255), width=2)

    COLOURS = {
        "vehicle-sized-wreck": (120, 20, 140),
        "building-sized": (60, 20, 140),
        "structure": (40, 70, 180),
    }
    for c in colliders:
        ax, az = c["axes"][0], c["axes"][2]
        lu = math.hypot(ax[0], ax[2]) or 1.0
        lv = math.hypot(az[0], az[2]) or 1.0
        ux, uz = ax[0] / lu, ax[2] / lu
        vx, vz = az[0] / lv, az[2] / lv
        hu, hv = c["half"][0] * lu, c["half"][2] * lv
        cx, cz = c["center"][0], c["center"][2]
        corners = [S(cx + su * hu * ux + sv * hv * vx, cz + su * hu * uz + sv * hv * vz)
                   for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        col = COLOURS.get(c["classification"], (0, 0, 0))
        if not c["active"]:
            d.polygon(corners, outline=(110, 110, 110, 255))
        d.line(corners + [corners[0]], fill=col + (255,), width=1)

    if route:
        d.line([S(p["x"], p["z"]) for p in route], fill=(0, 90, 220, 255), width=2)

    sx, sz = S(spawn[0], spawn[1])
    d.ellipse([sx - 5, sz - 5, sx + 5, sz + 5], fill=(255, 255, 255, 255),
              outline=(0, 0, 0, 255), width=2)
    d.line([(sx - 10, sz), (sx + 10, sz)], fill=(0, 0, 0, 255), width=1)
    d.line([(sx, sz - 10), (sx, sz + 10)], fill=(0, 0, 0, 255), width=1)

    for text, (nx_, nz_) in (notes or []):
        px_, pz_ = S(nx_, nz_)
        d.ellipse([px_ - 4, pz_ - 4, px_ + 4, pz_ + 4], outline=(180, 0, 160, 255), width=2)
        d.rectangle([px_ + 6, pz_ - 7, px_ + 8 + 7 * len(text), pz_ + 7],
                    fill=(255, 255, 255, 225))
        d.text((px_ + 8, pz_ - 5), text, fill=(120, 0, 110))

    legend = [
        ("reachable from spawn (P48 2-cell)", (86, 176, 96)),
        ("free but cut off from spawn (pocket)", (110, 200, 220)),
        ("free only at 1.5 m strict clearance", (150, 205, 140)),
        ("inside R04, blocked by prop + clearance", (238, 196, 96)),
        ("prop footprint (cell square hit)", (196, 48, 48)),
        ("310 m P48 course", (20, 20, 20)),
        ("route across the reachable basin", (0, 90, 220)),
    ]
    w, h = img.size
    d.rectangle([8, 6, 330, 8 + 16 + 15 * len(legend)], fill=(255, 255, 255, 235))
    d.text((12, 8), "R04 spawn basin with P66 all-visible props (3 px/m)", fill=(0, 0, 0))
    y = 24
    for label, col in legend:
        d.rectangle([12, y, 24, y + 8], fill=col, outline=(0, 0, 0))
        d.text((30, y - 1), label, fill=(0, 0, 0))
        y += 15
    d.line([(20, h - 24), (20 + int(50 * scale), h - 24)], fill=(0, 0, 0), width=3)
    d.line([(20, h - 28), (20, h - 20)], fill=(0, 0, 0), width=2)
    d.line([(20 + int(50 * scale), h - 28), (20 + int(50 * scale), h - 20)],
           fill=(0, 0, 0), width=2)
    d.text((20, h - 40), "50 m", fill=(0, 0, 0))
    d.text((20, h - 14), "data-only; no renderer or game claim", fill=(60, 60, 60))
    img.save(out_png or (OUT / "map.png"))


if __name__ == "__main__":
    raise SystemExit(main())
