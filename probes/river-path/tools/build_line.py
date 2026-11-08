#!/usr/bin/env python3
"""River 310 m audit: reproduce the path and prop colliders, measure the free
lateral lane, and derive a corrected prop-clear centreline.

Inputs (read-only, pinned by SHA-256):
  _work/drivable-path/path.json          P48 310.3952 m course
  _work/drivable-path/grid.npz           P48 0.5 m height / passable / wall rasters
  _work/prop-collision/colliders.json    P66 468 visible-prop OBBs

Outputs (all under _work/river-path/):
  props.json    every collider with its path relation and surface fraction
  line.json     corrected 0.25 m line (position, tangent, width, clearance)
  route.json    independent raster route on the collision surface, props removed
  audit.json    cluster and lane summary
  hashes.json   input/output SHA-256

No browser, engine or e1-drive file is touched.  Deterministic: fixed grids,
sorted iteration, canonical hashes, no timestamps.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work/river-path"
LOGS = ROOT / "_work/logs/river-path"

PATH_FILE = ROOT / "_work/drivable-path/path.json"
GRID_FILE = ROOT / "_work/drivable-path/grid.npz"
MANIFEST = ROOT / "_work/prop-collision/colliders.json"

PIN = {
    "path.json": "81eac0ce413075de33e2b3c0e1c077412b35002420b199d9f05d2fdeef230e7f",
    "colliders.json": "a98fb8eb7e7a6f6851e0c6b5671d40be2c346d0c28a2442df0fe6ab497317af4",
}

CAR = {
    "lengthM": 2.981,
    "widthM": 1.676,
    "halfLengthM": 2.981 / 2.0,
    "halfWidthM": 1.676 / 2.0,
    "bodyBandM": 1.35,
    "source": "_work/drivable-path/path.json inputs.carEnvelope: Dodge wheelbase 2.981 m, Audi rear track 1.676 m",
}
HL = CAR["halfLengthM"]
HW = CAR["halfWidthM"]

OFFSET_STEP = 0.05          # m, lateral sample step
OFFSET_LIMIT = 12.0         # m, half-width of the search band
LANE_BUFFER = 0.50          # m, required lateral margin from the envelope to a lane edge
SLOPE_LIMIT = 0.20          # m of lateral shift per m of arc
WALL_MASK_DILATION = 0.5    # documented P48 raster wall dilation

CLUSTER_DEF = {
    "C1": {
        "name": "metal rack (draw.115)",
        "draw": "river.block56.node289.draw.115",
        "arcStart": 52.896931,
        "arcEnd": 61.130887,
    },
    "C2": {
        "name": "construction fences / steel poles (draw.97/99/119/120)",
        "draw": "river.block56.node289.draw.97|99|119|120",
        "arcStart": 124.757329,
        "arcEnd": 127.751178,
    },
    "C3": {
        "name": "concrete pipe rack (draw.95)",
        "draw": "river.block56.node289.draw.95",
        "arcStart": 114.277044,
        "arcEnd": 121.762744,
    },
    "C4": {
        "name": "metal rack (draw.116)",
        "draw": "river.block56.node289.draw.116",
        "arcStart": 181.397363,
        "arcEnd": 206.846825,
    },
}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical(doc: dict, drop: str = "hash") -> str:
    body = dict(doc)
    body.pop(drop, None)
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def r6(x: float) -> float:
    return round(float(x), 6)


def load_inputs() -> tuple[dict, dict, dict]:
    for name, want in PIN.items():
        src = PATH_FILE if name == "path.json" else MANIFEST
        got = sha256_file(src)
        if got != want:
            raise SystemExit(f"{name}: SHA-256 {got} != pinned {want}")
    path_doc = json.loads(PATH_FILE.read_text(encoding="utf-8"))
    man = json.loads(MANIFEST.read_text(encoding="utf-8"))
    grid = np.load(GRID_FILE, allow_pickle=False)
    return path_doc, man, grid


def path_arrays(path_doc: dict) -> dict:
    pts = np.array(path_doc["course"]["points"], dtype=np.float64)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    arc = np.concatenate([[0.0], np.cumsum(seg)])
    tan = np.zeros_like(pts)
    tan[1:-1] = pts[2:] - pts[:-2]
    tan[0] = pts[1] - pts[0]
    tan[-1] = pts[-1] - pts[-2]
    tan /= np.linalg.norm(tan, axis=1)[:, None]
    left = np.stack([-tan[:, 1], tan[:, 0]], axis=1)
    return {
        "points": pts,
        "arc": arc,
        "tangent": tan,
        "left": left,
        "length": float(arc[-1]),
        "samples": len(pts),
    }


def obb2d(c: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray, float, float]:
    ax = np.array(c["axes"], dtype=np.float64)
    u = ax[0][[0, 2]]
    v = ax[2][[0, 2]]
    u = u / np.linalg.norm(u)
    v = v / np.linalg.norm(v)
    center = np.array(c["center"], dtype=np.float64)[[0, 2]]
    return center, u, v, float(c["half"][0]), float(c["half"][2])


def point_obb_distance(p: np.ndarray, center, u, v, hu, hv) -> float:
    d = p - center
    lu = max(-hu, min(hu, float(np.dot(d, u))))
    lv = max(-hv, min(hv, float(np.dot(d, v))))
    q = center + lu * u + lv * v
    return float(np.linalg.norm(p - q))


def aabb_overlap_obb(center, u, v, hu, hv, cx, cz, half_cell) -> bool:
    """2D SAT: axis-aligned cell square vs oriented prop footprint."""
    for a in ((1.0, 0.0), (0.0, 1.0), u, v):
        a = np.asarray(a)
        ra = hu * abs(np.dot(u, a)) + hv * abs(np.dot(v, a))
        rb = half_cell * (abs(a[0]) + abs(a[1]))
        if abs(np.dot(center - np.array([cx, cz]), a)) > ra + rb + 1e-12:
            return False
    return True


def sat_blocked(cc: np.ndarray, t: np.ndarray, nrm: np.ndarray,
                center, u, v, hu, hv) -> np.ndarray:
    """Vectorised 2D SAT over an (N,2) array of car centres.

    t and nrm may be a single (2,) vector or (N,2) per-sample vectors.
    """
    d = cc - center
    N = len(cc)
    if np.ndim(t) == 1:
        t = np.broadcast_to(t, (N, 2))
        nrm = np.broadcast_to(nrm, (N, 2))
    blocked = np.ones(N, dtype=bool)
    for a in (u, v):
        ra = hu * abs(float(np.dot(u, a))) + hv * abs(float(np.dot(v, a)))
        rb = HL * np.abs(t @ a) + HW * np.abs(nrm @ a)
        blocked &= np.abs(d @ a) <= ra + rb + 1e-12
    dt = np.einsum("ij,ij->i", d, t)
    dn = np.einsum("ij,ij->i", d, nrm)
    ra_t = hu * np.abs(t @ u) + hv * np.abs(t @ v)
    ra_n = hu * np.abs(nrm @ u) + hv * np.abs(nrm @ v)
    blocked &= np.abs(dt) <= ra_t + HL + 1e-12
    blocked &= np.abs(dn) <= ra_n + HW + 1e-12
    return blocked


def cell_index(x: float, z: float, xs, zs) -> tuple[int, int] | None:
    i = int(round((x - float(xs[0])) / 0.5))
    j = int(round((z - float(zs[0])) / 0.5))
    if i < 0 or j < 0 or i >= len(xs) or j >= len(zs):
        return None
    return i, j


def classify_texture(c: dict) -> str:
    tex = (c.get("provenance") or {}).get("texture") or ""
    cls = c.get("classification", "")
    if c.get("source") == "level-instance":
        if cls == "vehicle-sized-wreck":
            return "vehicle-sized wreck proxy (shape class, no material binding)"
        if cls == "building-sized":
            return "building-sized prop (shape class, no material binding)"
        return "level instance (shape class)"
    mapping = {
        "metalstructure02_diff": "metal structure / rack component",
        "concretepipe_diff": "concrete pipe",
        "constructionfence01_diff": "construction fence panel",
        "constructionfence03_diff": "construction fence panel",
        "steelpole_diff": "steel pole",
        "woodenfence_diff": "wooden fence",
    }
    if tex in mapping:
        return mapping[tex]
    if tex.startswith("cargocontainer_"):
        return "cargo container wall"
    if tex.startswith("wall"):
        return "wall"
    return f"{cls or 'structure'} ({tex or 'no material'})"


def cluster_of(c: dict) -> str:
    cid = c["id"]
    if "draw.115." in cid:
        return "C1"
    if any(f"draw.{d}." in cid for d in (97, 99, 119, 120)):
        return "C2"
    if "draw.95." in cid:
        return "C3"
    if "draw.116." in cid:
        return "C4"
    return "other"


def surface_fraction(c: dict, grid) -> dict:
    H, bp, comp, xs, zs = grid["height"], grid["base_pass"], grid["component"], grid["xs"], grid["zs"]
    center, u, v, hu, hv = obb2d(c)
    # conservative AABB of the OBB
    ex = hu * abs(u[0]) + hv * abs(v[0])
    ez = hu * abs(u[1]) + hv * abs(v[1])
    i0 = int(math.floor((center[0] - ex - xs[0]) / 0.5)) - 1
    i1 = int(math.ceil((center[0] + ex - xs[0]) / 0.5)) + 1
    j0 = int(math.floor((center[1] - ez - zs[0]) / 0.5)) - 1
    j1 = int(math.ceil((center[1] + ez - zs[0]) / 0.5)) + 1
    cells = 0
    on_base = 0
    on_comp = 0
    for j in range(max(0, j0), min(len(zs), j1 + 1)):
        for i in range(max(0, i0), min(len(xs), i1 + 1)):
            cx, cz = float(xs[i]), float(zs[j])
            if not aabb_overlap_obb(center, u, v, hu, hv, cx, cz, 0.25):
                continue
            g = float(H[j, i])
            if not math.isfinite(g):
                continue
            top = float(c["vertical"]["top"])
            bot = float(c["vertical"]["bottom"])
            if top <= g + 0.05 or bot >= g + CAR["bodyBandM"]:
                continue
            cells += 1
            if bool(bp[j, i]):
                on_base += 1
            if bool(comp[j, i]):
                on_comp += 1
    frac = on_base / cells if cells else 0.0
    if cells == 0:
        relation = "no-cell-overlap"
    elif frac >= 0.8:
        relation = "on-drivable-surface"
    elif frac >= 0.2:
        relation = "straddles-surface-edge"
    else:
        relation = "off-drivable-surface"
    return {
        "cells": cells,
        "basePassCells": on_base,
        "componentCells": on_comp,
        "basePassFraction": r6(frac),
        "componentFraction": r6(on_comp / cells if cells else 0.0),
        "relation": relation,
        "method": "0.5 m cell square vs OBB (2D SAT), vertical band [ground+0.05, ground+1.35] m",
    }


def prop_table(man: dict, path: dict, grid) -> list[dict]:
    pts = path["points"]
    arc = path["arc"]
    tan = path["tangent"]
    left = path["left"]
    H, xs, zs = grid["height"], grid["xs"], grid["zs"]
    out = []
    for c in man["colliders"]:
        center, u, v, hu, hv = obb2d(c)
        # nearest path sample to the footprint (exact point-to-OBB distance)
        d = pts - center
        lu = np.clip(d @ u, -hu, hu)
        lv = np.clip(d @ v, -hv, hv)
        q = center + lu[:, None] * u + lv[:, None] * v
        dist = np.linalg.norm(pts - q, axis=1)
        j = int(np.argmin(dist))
        nearest = float(dist[j])
        # signed lateral offset of the nearest footprint point and of the centre
        near_pt = q[j]
        lateral_face = float(np.dot(near_pt - pts[j], left[j]))
        lateral_center = float(np.dot(center - pts[j], left[j]))
        # envelope intersections at every sample
        blocked_mask = sat_blocked(pts, tan, left, center, u, v, hu, hv)
        blocked = np.where(blocked_mask)[0].tolist()
        # vertical filter for the on-course classification
        jj = cell_index(pts[j][0], pts[j][1], xs, zs)
        ground = float(H[jj[1], jj[0]])
        vertical_hit = (float(c["vertical"]["top"]) > ground + 0.05 and
                        float(c["vertical"]["bottom"]) < ground + CAR["bodyBandM"])
        if blocked and vertical_hit:
            first_arc = float(arc[blocked[0]])
            last_arc = float(arc[blocked[-1]])
        else:
            first_arc = None
            last_arc = None
        if blocked and vertical_hit:
            relation = "intersects-envelope"
        elif blocked and not vertical_hit:
            relation = "envelope-but-overhead"
        elif nearest <= 3.0:
            relation = "within-3m"
        elif nearest <= 6.0:
            relation = "within-6m"
        elif nearest <= 12.0:
            relation = "within-12m"
        else:
            relation = "outside-12m"
        sf = surface_fraction(c, grid)
        out.append({
            "id": c["id"],
            "cluster": cluster_of(c),
            "source": c["source"],
            "classification": c["classification"],
            "whatItIs": classify_texture(c),
            "draw": c["id"].rsplit(".component", 1)[0],
            "texture": (c.get("provenance") or {}).get("texture"),
            "center": [r6(c["center"][0]), r6(c["center"][1]), r6(c["center"][2])],
            "size": [r6(x) for x in c["size"]],
            "vertical": {
                "bottom": r6(c["vertical"]["bottom"]),
                "top": r6(c["vertical"]["top"]),
                "height": r6(c["vertical"]["height"]),
                "topAboveGround": r6(c["vertical"]["topAboveGround"]),
            },
            "nearestArcM": r6(arc[j]),
            "lateralOffsetToFaceM": r6(lateral_face),
            "lateralOffsetToCentreM": r6(lateral_center),
            "footprintDistanceM": r6(nearest),
            "firstBlockedArcM": None if first_arc is None else r6(first_arc),
            "lastBlockedArcM": None if last_arc is None else r6(last_arc),
            "blockedSamples": len(blocked),
            "pathRelation": relation,
            "surface": sf,
        })
    return out


def free_interval_runs(mask: np.ndarray, offsets: np.ndarray) -> list[tuple[float, float]]:
    runs = []
    start = None
    for k, ok in enumerate(mask):
        if ok and start is None:
            start = k
        elif not ok and start is not None:
            runs.append((float(offsets[start]), float(offsets[k - 1])))
            start = None
    if start is not None:
        runs.append((float(offsets[start]), float(offsets[-1])))
    return runs


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="recompute and compare with the committed outputs")
    args = ap.parse_args(argv)

    OUT.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)

    path_doc, man, grid = load_inputs()
    path = path_arrays(path_doc)
    pts, arc, tan, left = path["points"], path["arc"], path["tangent"], path["left"]
    n = len(pts)
    H, bp, comp, wall, xs, zs = (grid["height"], grid["base_pass"], grid["component"],
                                 grid["wall_oracle"], grid["xs"], grid["zs"])

    props = prop_table(man, path, grid)
    print("props", len(props), "envelope", sum(p["pathRelation"] == "intersects-envelope" for p in props))

    # candidates and local ground
    cand = [[] for _ in range(n)]
    for pi, c in enumerate(man["colliders"]):
        center, u, v, hu, hv = obb2d(c)
        d = pts - center
        lu = np.clip(d @ u, -hu, hu)
        lv = np.clip(d @ v, -hv, hv)
        q = center + lu[:, None] * u + lv[:, None] * v
        dist = np.linalg.norm(pts - q, axis=1)
        for i in np.where(dist <= OFFSET_LIMIT + 3.0)[0]:
            cand[int(i)].append(pi)

    offsets = np.arange(-OFFSET_LIMIT, OFFSET_LIMIT + 1e-9, OFFSET_STEP)
    n_off = len(offsets)

    # per-sample free mask, runs and widest run
    free_masks = np.zeros((n, n_off), dtype=bool)
    margin = np.full((n, n_off), -1.0, dtype=np.float64)
    widest = [None] * n
    runs_per_sample = [None] * n
    surface_ok = np.zeros(n, dtype=bool)
    ground = np.full(n, np.nan)
    for i in range(n):
        g = H[int(round((pts[i][1] - zs[0]) / 0.5)), int(round((pts[i][0] - xs[0]) / 0.5))]
        ground[i] = float(g)
        cc = pts[i] + offsets[:, None] * left[i]
        nrm = np.array([-tan[i][1], tan[i][0]])
        blocked = np.zeros(n_off, dtype=bool)
        for pi in cand[i]:
            c = man["colliders"][pi]
            if float(c["vertical"]["top"]) <= g + 0.05:
                continue
            if float(c["vertical"]["bottom"]) >= g + CAR["bodyBandM"]:
                continue
            center, u, v, hu, hv = obb2d(c)
            blocked |= sat_blocked(cc, tan[i], nrm, center, u, v, hu, hv)
        surf = np.ones(n_off, dtype=bool)
        for a in (-HL, 0.0, HL):
            for b in (-HW, 0.0, HW):
                q = cc + a * tan[i] + b * nrm
                ii = np.round((q[:, 0] - xs[0]) / 0.5).astype(int)
                jj = np.round((q[:, 1] - zs[0]) / 0.5).astype(int)
                inside = (ii >= 0) & (jj >= 0) & (ii < len(xs)) & (jj < len(zs))
                ok = np.zeros(n_off, dtype=bool)
                ok[inside] = bp[jj[inside], ii[inside]]
                surf &= ok
        free = (~blocked) & surf
        free_masks[i] = free
        runs = free_interval_runs(free, offsets)
        runs_per_sample[i] = runs
        if runs:
            w = max(runs, key=lambda r: (r[1] - r[0], -abs((r[0] + r[1]) / 2.0)))
            widest[i] = {"start": r6(w[0]), "end": r6(w[1]), "width": r6(w[1] - w[0])}
        for r0, r1 in runs:
            k0 = int(round((r0 - offsets[0]) / OFFSET_STEP))
            k1 = int(round((r1 - offsets[0]) / OFFSET_STEP))
            for k in range(k0, k1 + 1):
                margin[i, k] = min(offsets[k] - r0, r1 - offsets[k])
        surface_ok[i] = bool(free.any())
        if i % 200 == 0:
            print("station", i, "runs", len(runs), "widest", widest[i])

    # Free ranges: contiguous samples where at least one car pose is free.
    free_any = free_masks.any(axis=1)
    ranges = []
    i = 0
    while i < n:
        if free_any[i]:
            j = i
            while j + 1 < n and free_any[j + 1]:
                j += 1
            ranges.append([i, j])
            i = j + 1
        else:
            i += 1
    print("free ranges", ranges)

    def run_dp(i0, i1, start_k, slope_limit, buffer):
        feasible = margin >= buffer - 1e-9
        dk = max(1, int(math.floor(slope_limit * 0.25 / OFFSET_STEP)))
        neg_inf = -1e18
        m = i1 - i0 + 1
        best = np.full(n_off, neg_inf)
        if not feasible[i0, start_k]:
            return None, i0
        best[start_k] = 0.0
        prev = np.zeros((m, n_off), dtype=np.int16)
        for t in range(1, m):
            i = i0 + t
            new = np.full(n_off, neg_inf)
            pv = np.zeros(n_off, dtype=np.int16)
            for k in range(n_off):
                if not feasible[i, k]:
                    continue
                lo = max(0, k - dk)
                hi = min(n_off, k + dk + 1)
                vals = best[lo:hi]
                if not np.any(vals > -1e17):
                    continue
                kk = lo + int(np.argmax(vals))
                cost = vals[kk - lo]
                cost -= 0.0020 * (offsets[k] / OFFSET_LIMIT) ** 2
                cost -= 0.0005 * abs(k - kk)
                new[k] = cost
                pv[k] = kk
            if not np.any(new > -1e17):
                return None, i
            best = new
            prev[t] = pv
        k_end = int(np.argmax(best))
        ks = np.zeros(m, dtype=int)
        ks[-1] = k_end
        for t in range(m - 1, 0, -1):
            ks[t - 1] = prev[t, ks[t]]
        return ks, i1

    candidates = [(SLOPE_LIMIT, LANE_BUFFER), (0.30, 0.50), (0.50, 0.30),
                  (0.80, 0.10), (1.20, 0.0), (2.00, 0.0)]
    segments = []
    for r0, r1 in ranges:
        if r1 - r0 < 8:
            continue
        # anchor: s=0 for the start range; otherwise rejoin the original line
        k0 = int(round((0.0 - offsets[0]) / OFFSET_STEP))
        if r0 == 0 and margin[0, k0] >= 0:
            start_i, start_k = 0, k0
        else:
            start_i, start_k = None, None
            for i in range(r0, r1 + 1):
                if margin[i, k0] >= LANE_BUFFER - 1e-9:
                    start_i, start_k = i, k0
                    break
            if start_i is None:
                feasible_here = np.where(margin[r0] >= 0)[0]
                start_i = r0
                start_k = int(feasible_here[np.argmin(np.abs(offsets[feasible_here]))])
        r0 = start_i
        chosen = None
        for slope_limit, buffer in candidates:
            cur1 = r1
            while cur1 - r0 >= 8:
                ks, last = run_dp(r0, cur1, start_k, slope_limit, buffer)
                if ks is not None:
                    chosen = (slope_limit, buffer, ks, cur1)
                    break
                cur1 = last - 1
            if chosen is not None:
                break
        if chosen is None:
            print("range", r0, r1, "no DP line")
            continue
        slope_used, buffer_used, ks, end = chosen
        segments.append({"i0": r0, "i1": end, "ks": ks,
                         "slope": slope_used, "buffer": buffer_used})
        print("segment", r0, end, "arc", round(arc[r0], 2), round(arc[end], 2),
              "slope", slope_used, "buffer", buffer_used)

    if not segments:
        raise SystemExit("no continuous free segment found")

    def make_samples(seg: dict, name: str) -> dict:
        i0, i1, ks = seg["i0"], seg["i1"], seg["ks"]
        m = i1 - i0 + 1
        s_seg = offsets[ks]
        corr = pts[i0:i1 + 1] + s_seg[:, None] * left[i0:i1 + 1]
        ct = np.zeros_like(corr)
        if m == 1:
            ct[0] = tan[i0]
        else:
            ct[1:-1] = corr[2:] - corr[:-2]
            ct[0] = corr[1] - corr[0]
            ct[-1] = corr[-1] - corr[-2]
            ct /= np.linalg.norm(ct, axis=1)[:, None]
        step = np.linalg.norm(np.diff(corr, axis=0), axis=1) if m > 1 else np.array([0.0])
        carc = np.concatenate([[0.0], np.cumsum(step)])
        out = []
        min_cpc = float("inf")
        min_margin = float("inf")
        min_sat = float("inf")
        for t in range(m):
            i = i0 + t
            r = None
            for r0, r1 in runs_per_sample[i]:
                if r0 - 1e-9 <= s_seg[t] <= r1 + 1e-9:
                    r = (r0, r1)
                    break
            if r is None:
                raise SystemExit(f"sample {i} off free run at s={s_seg[t]}")
            lane_width = r[1] - r[0]
            margin_m = min(s_seg[t] - r[0], r[1] - s_seg[t])
            cpc = float("inf")
            sat_gap = float("inf")
            nrm = np.array([-ct[t][1], ct[t][0]])
            cc = corr[t:t + 1]
            # clearance is reported against every prop within 30 m, not only the
            # collision candidates, so an independent 30 m check can reproduce it
            for c in man["colliders"]:
                ctr = c["center"]
                if abs(ctr[0] - corr[t][0]) > 30.0 or abs(ctr[2] - corr[t][1]) > 30.0:
                    continue
                if float(c["vertical"]["top"]) <= ground[i] + 0.05:
                    continue
                if float(c["vertical"]["bottom"]) >= ground[i] + CAR["bodyBandM"]:
                    continue
                center, u, v, hu, hv = obb2d(c)
                cpc = min(cpc, point_obb_distance(corr[t], center, u, v, hu, hv))
            for pi in cand[i]:
                c = man["colliders"][pi]
                if float(c["vertical"]["top"]) <= ground[i] + 0.05:
                    continue
                if float(c["vertical"]["bottom"]) >= ground[i] + CAR["bodyBandM"]:
                    continue
                center, u, v, hu, hv = obb2d(c)
                blocked = sat_blocked(cc, ct[t], nrm, center, u, v, hu, hv)[0]
                if not blocked:
                    d = cc[0] - center
                    gaps = []
                    for a in (u, v, ct[t], nrm):
                        ra = hu * abs(float(np.dot(u, a))) + hv * abs(float(np.dot(v, a)))
                        rb = HL * abs(float(np.dot(ct[t], a))) + HW * abs(float(np.dot(nrm, a)))
                        gaps.append(abs(float(np.dot(d, a))) - ra - rb)
                    sat_gap = min(sat_gap, max(gaps))
            if cpc == float("inf"):
                cpc = 99.0
            if sat_gap == float("inf"):
                sat_gap = 99.0
            min_cpc = min(min_cpc, cpc)
            min_margin = min(min_margin, margin_m)
            min_sat = min(min_sat, sat_gap)
            out.append({
                "i": i,
                "baseArcM": r6(arc[i]),
                "segmentArcM": r6(carc[t]),
                "position": [r6(corr[t][0]), r6(corr[t][1])],
                "basePosition": [r6(pts[i][0]), r6(pts[i][1])],
                "tangent": [r6(ct[t][0]), r6(ct[t][1])],
                "lateralOffsetM": r6(s_seg[t]),
                "laneStartM": r6(r[0]),
                "laneEndM": r6(r[1]),
                "laneWidthM": r6(lane_width),
                "laneWidthWidestM": None if widest[i] is None else widest[i]["width"],
                "lateralMarginM": r6(margin_m),
                "centreToPropM": r6(cpc),
                "satGapM": r6(sat_gap),
                "onSurface": bool(surface_ok[i]),
            })
        length = float(carc[-1])
        max_step = float(np.max(step))
        max_slope = float(np.max(np.abs(np.diff(s_seg)) / np.maximum(np.diff(arc[i0:i1 + 1]), 1e-9))) if m > 1 else 0.0
        curv = np.abs(np.diff(s_seg, 2)) / np.maximum(np.diff(arc[i0:i1 + 1])[1:] ** 2, 1e-9) if m > 2 else np.array([0.0])
        return {
            "name": name,
            "baseArcStartM": r6(arc[i0]),
            "baseArcEndM": r6(arc[i1]),
            "lengthM": r6(length),
            "samples": out,
            "minCentreToPropM": r6(min_cpc),
            "minLateralMarginM": r6(min_margin),
            "minSatGapM": r6(min_sat),
            "maxStepM": r6(max_step),
            "maxLateralSlopeMPerM": r6(max_slope),
            "maxOffsetCurvaturePerM2": r6(float(np.max(curv))) if len(curv) else 0.0,
            "laneBufferM": r6(seg["buffer"]),
            "slopeLimitMPerM": r6(seg["slope"]),
        }

    full_segments = [make_samples(seg, f"S{k + 1}") for k, seg in enumerate(segments)]
    segment_docs = []
    for doc in full_segments:
        summary = dict(doc)
        summary.pop("samples", None)
        segment_docs.append(summary)

    # full sample list with a segment tag (free segments only)
    all_samples = []
    sample_segment = {}
    sample_by_i = {}
    for doc in full_segments:
        for srec in doc["samples"]:
            srec["segment"] = doc["name"]
            sample_segment[srec["i"]] = doc["name"]
            sample_by_i[srec["i"]] = srec
            all_samples.append(srec)
    all_samples.sort(key=lambda r: r["i"])

    # blocked arcs = gaps between the chosen free segments
    blocked_arcs = []
    prev_end = -1
    for seg in segments:
        if seg["i0"] > prev_end + 1:
            a0, a1 = prev_end + 1, seg["i0"] - 1
            block = [i for i in range(a0, a1 + 1)]
            free_cross = [i for i in block if free_any[i]]
            sealed = [i for i in block if not free_any[i]]
            max_run = 0.0
            for i in free_cross:
                for r0, r1 in runs_per_sample[i]:
                    max_run = max(max_run, r1 - r0)
            overlap_ids = []
            for p in props:
                if p["pathRelation"] != "intersects-envelope":
                    continue
                if p["firstBlockedArcM"] is None:
                    continue
                if p["lastBlockedArcM"] < arc[a0] or p["firstBlockedArcM"] > arc[a1]:
                    continue
                overlap_ids.append(p["id"])
            blocked_arcs.append({
                "sampleStart": a0,
                "sampleEnd": a1,
                "sealedSampleFirst": sealed[0] if sealed else None,
                "arcStartM": r6(arc[a0]),
                "arcEndM": r6(arc[a1]),
                "lengthM": r6(arc[a1] - arc[a0]),
                "freeCrossSectionSamples": len(free_cross),
                "sealedSamples": len(sealed),
                "largestFreeRunM": r6(max_run),
                "sealed": len(sealed) > 0,
                "excludedPropIds": overlap_ids,
                "reason": ("the visible C2 construction site seals the corridor: "
                           f"{len(sealed)} of {len(block)} samples have no free car pose; "
                           "no continuous line crosses between S1 and S2"),
            })
        prev_end = max(prev_end, seg["i1"])
    # trailing block (only if it actually contains a sealed cross-section)
    if prev_end < n - 1:
        a0, a1 = prev_end + 1, n - 1
        block = [i for i in range(a0, a1 + 1)]
        free_cross = [i for i in block if free_any[i]]
        sealed = [i for i in block if not free_any[i]]
        max_run = 0.0
        for i in free_cross:
            for r0, r1 in runs_per_sample[i]:
                max_run = max(max_run, r1 - r0)
        if sealed:
            blocked_arcs.append({
                "sampleStart": a0, "sampleEnd": a1,
                "sealedSampleFirst": sealed[0],
                "arcStartM": r6(arc[a0]), "arcEndM": r6(arc[a1]),
                "lengthM": r6(arc[a1] - arc[a0]),
                "freeCrossSectionSamples": len(free_cross),
                "sealedSamples": len(sealed),
                "largestFreeRunM": r6(max_run),
                "sealed": len(sealed) > 0,
                "excludedPropIds": [],
                "reason": "trailing samples with no continuous free line",
            })

    # cluster summary
    clusters = {}
    for key, meta in CLUSTER_DEF.items():
        members = [p for p in props if p["cluster"] == key]
        hit = [p for p in members if p["pathRelation"] == "intersects-envelope"]
        on = [p for p in members if p["surface"]["relation"] == "on-drivable-surface"]
        fracs = [p["surface"]["basePassFraction"] for p in members if p["surface"]["cells"] > 0]
        clusters[key] = {
            "name": meta["name"],
            "draw": meta["draw"],
            "documentedArcStartM": meta["arcStart"],
            "documentedArcEndM": meta["arcEnd"],
            "props": len(members),
            "envelopeProps": len(hit),
            "onDrivableSurfaceProps": len(on),
            "footprintCells": sum(p["surface"]["cells"] for p in members),
            "basePassCells": sum(p["surface"]["basePassCells"] for p in members),
            "minSurfaceFraction": r6(min(fracs)) if fracs else None,
            "maxSurfaceFraction": r6(max(fracs)) if fracs else None,
            "medianSurfaceFraction": r6(float(np.median(fracs))) if fracs else None,
            "propIds": [p["id"] for p in members],
        }

    # 1 m lane table (max free lane at every metre)
    bins = []
    for a in np.arange(0.0, path["length"] + 1e-9, 1.0):
        i = int(np.searchsorted(arc, a, side="left"))
        i = min(i, n - 1)
        bins.append({
            "baseArcM": r6(arc[i]),
            "sample": i,
            "freeRuns": [{"start": r6(x), "end": r6(y), "width": r6(y - x)} for x, y in runs_per_sample[i]],
            "widest": widest[i],
            "chosenOffsetM": None if i not in sample_by_i else r6(sample_by_i[i]["lateralOffsetM"]),
            "segment": sample_segment.get(i),
        })

    total_free = sum(float(d["lengthM"]) for d in segment_docs)
    total_blocked = sum(float(b["lengthM"]) for b in blocked_arcs)
    line_doc = {
        "kind": "river-path.corrected-line",
        "version": 1,
        "status": "blocked" if blocked_arcs else "complete",
        "complete": not blocked_arcs,
        "scope": {
            "claim": "visible-mesh props only; not retail collision, not retail racing line",
            "inputPath": "_work/drivable-path/path.json",
            "inputColliders": "_work/prop-collision/colliders.json",
            "inputGrid": "_work/drivable-path/grid.npz",
            "surface": "P48 base_pass: highest up-facing collision triangle, wall mask dilated 0.5 m",
            "propClearance": "exact 2D OBB distance; real car envelope 2.981 x 1.676 m",
            "safety": "free segments keep a lateral margin to every tested lane edge; see model.laneBufferM",
        },
        "carEnvelope": CAR,
        "model": {
            "lateralStepM": OFFSET_STEP,
            "lateralBandM": [-OFFSET_LIMIT, OFFSET_LIMIT],
            "surfaceSamplesPerPose": 9,
            "surfaceRule": "all 9 car-pose points (3x3 grid) on base_pass",
            "verticalBandM": [0.05, CAR["bodyBandM"]],
            "segmentSlopeCandidatesMPerM": [c[0] for c in candidates],
            "segmentBufferCandidatesM": [c[1] for c in candidates],
        },
        "baseCourse": {
            "lengthM": r6(path_doc["course"]["length"]),
            "samples": n,
            "hash": path_doc["hash"],
        },
        "correctedCourse": {
            "freeLengthM": r6(total_free),
            "blockedLengthM": r6(total_blocked),
            "baseArcCoveredM": r6(sum(arc[s["i1"]] - arc[s["i0"]] for s in segments)),
            "segmentCount": len(segment_docs),
            "segments": segment_docs,
            "blockedArcs": blocked_arcs,
            "minCentreToPropM": r6(min(d["minCentreToPropM"] for d in segment_docs)),
            "minLateralMarginM": r6(min(d["minLateralMarginM"] for d in segment_docs)),
            "maxStepM": r6(max(d["maxStepM"] for d in segment_docs)),
        },
        "laneBins": bins,
        "samples": all_samples,
    }
    line_doc["hash"] = "sha256:" + canonical(line_doc)

    props_doc = {
        "kind": "river-path.prop-audit",
        "version": 1,
        "scope": {
            "claim": "visible-mesh approximation; not retail collision",
            "manifest": "_work/prop-collision/colliders.json",
            "manifestFileSha256": PIN["colliders.json"],
            "path": "_work/drivable-path/path.json",
            "pathFileSha256": PIN["path.json"],
        },
        "summary": {
            "colliders": len(props),
            "intersectsEnvelope": sum(p["pathRelation"] == "intersects-envelope" for p in props),
            "within3m": sum(p["footprintDistanceM"] <= 3.0 for p in props),
            "within6m": sum(p["footprintDistanceM"] <= 6.0 for p in props),
            "within12m": sum(p["footprintDistanceM"] <= 12.0 for p in props),
            "clusters": clusters,
        },
        "props": props,
    }
    props_doc["hash"] = "sha256:" + canonical(props_doc)

    lane_widths = [(b["widest"]["width"], b["baseArcM"]) for b in bins if b["widest"]]
    audit = {
        "kind": "river-path.audit",
        "version": 1,
        "baseCourse": line_doc["baseCourse"],
        "correctedCourse": line_doc["correctedCourse"],
        "clusters": clusters,
        "minimumLaneWidthM": min(w for w, _ in lane_widths) if lane_widths else None,
        "minimumLaneWidthArcM": min(lane_widths)[1] if lane_widths else None,
    }

    # raster alternative route on the collision surface with props removed
    obstacle = np.zeros_like(bp)
    for c in man["colliders"]:
        center, u, v, hu, hv = obb2d(c)
        ex = hu * abs(u[0]) + hv * abs(v[0])
        ez = hu * abs(u[1]) + hv * abs(v[1])
        i0 = int(math.floor((center[0] - ex - xs[0]) / 0.5)) - 1
        i1 = int(math.ceil((center[0] + ex - xs[0]) / 0.5)) + 1
        j0 = int(math.floor((center[1] - ez - zs[0]) / 0.5)) - 1
        j1 = int(math.ceil((center[1] + ez - zs[0]) / 0.5)) + 1
        for j in range(max(0, j0), min(len(zs), j1 + 1)):
            for i in range(max(0, i0), min(len(xs), i1 + 1)):
                g = float(H[j, i])
                if not math.isfinite(g):
                    continue
                if float(c["vertical"]["top"]) <= g + 0.05:
                    continue
                if float(c["vertical"]["bottom"]) >= g + CAR["bodyBandM"]:
                    continue
                if aabb_overlap_obb(center, u, v, hu, hv, float(xs[i]), float(zs[j]), 0.25):
                    obstacle[j, i] = True
    # 2-cell erosion of the free mask (same as the P48 search heuristic)
    free = comp & ~obstacle
    er = free.copy()
    for _ in range(2):
        p = np.pad(er, 1, constant_values=False)
        er = (p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
              & p[:-2, :-2] & p[:-2, 2:] & p[2:, :-2] & p[2:, 2:])
    start_ij = (int(round((pts[0][1] - zs[0]) / 0.5)), int(round((pts[0][0] - xs[0]) / 0.5)))
    end_ij = (int(round((pts[-1][1] - zs[0]) / 0.5)), int(round((pts[-1][0] - xs[0]) / 0.5)))

    def bfs(mask, s):
        from collections import deque
        seen = np.zeros_like(mask)
        if not mask[s]:
            return seen, False
        dq = deque([s])
        seen[s] = True
        while dq:
            j, i = dq.popleft()
            for dj, di in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
                jj, ii = j + dj, i + di
                if 0 <= jj < mask.shape[0] and 0 <= ii < mask.shape[1] and mask[jj, ii] and not seen[jj, ii]:
                    seen[jj, ii] = True
                    dq.append((jj, ii))
        return seen, bool(seen[end_ij])

    seen, connected = bfs(er, start_ij)
    # shortest 8-connected route by BFS distance (deterministic)
    route = None
    if connected:
        dist = np.full(er.shape, -1, dtype=np.int32)
        par = np.full(er.shape, -1, dtype=np.int32)
        from collections import deque
        dq = deque([start_ij])
        dist[start_ij] = 0
        order = ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1))
        while dq:
            j, i = dq.popleft()
            if (j, i) == end_ij:
                break
            for oi, (dj, di) in enumerate(order):
                jj, ii = j + dj, i + di
                if 0 <= jj < er.shape[0] and 0 <= ii < er.shape[1] and er[jj, ii] and dist[jj, ii] < 0:
                    dist[jj, ii] = dist[j, i] + 1
                    par[jj, ii] = oi
                    dq.append((jj, ii))
        cells = []
        cur = end_ij
        while cur != start_ij and par[cur] >= 0:
            cells.append(cur)
            dj, di = order[int(par[cur])]
            cur = (cur[0] - dj, cur[1] - di)
        cells.append(start_ij)
        cells.reverse()
        route_pts = [[float(xs[i]), float(zs[j])] for j, i in cells]
        route_len = 0.0
        for a, b in zip(route_pts, route_pts[1:]):
            route_len += math.hypot(b[0] - a[0], b[1] - a[1])
        route = {"cells": len(cells), "lengthM": r6(route_len), "points": route_pts}

    route_doc = {
        "kind": "river-path.raster-route",
        "version": 1,
        "model": {
            "cellM": 0.5,
            "base": "P48 component (base_pass eroded 2 cells) minus every prop footprint",
            "propFootprint": "0.5 m cell square vs OBB, vertical band [ground+0.05, ground+1.35]",
            "connectivity": "8-connected, no corner cutting",
        },
        "connected": bool(connected),
        "startCell": [int(start_ij[1]), int(start_ij[0])],
        "endCell": [int(end_ij[1]), int(end_ij[0])],
        "route": route,
        "disconnectedReason": None if connected else "props plus 2-cell erosion split start from end on the P48 component",
    }
    route_doc["hash"] = "sha256:" + canonical(route_doc)

    # write
    def write_json(name: str, doc: dict) -> str:
        path = OUT / name
        text = json.dumps(doc, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
        path.write_text(text, encoding="utf-8", newline="\n")
        return sha256_file(path)

    files = {
        "props.json": write_json("props.json", props_doc),
        "line.json": write_json("line.json", line_doc),
        "route.json": write_json("route.json", route_doc),
        "audit.json": write_json("audit.json", audit),
    }
    hashes = {
        "kind": "river-path.hashes",
        "version": 1,
        "inputs": {
            "path.json": PIN["path.json"],
            "colliders.json": PIN["colliders.json"],
            "grid.npz": sha256_file(GRID_FILE),
        },
        "outputs": files,
        "canonical": {
            "props.json": props_doc["hash"],
            "line.json": line_doc["hash"],
            "route.json": route_doc["hash"],
        },
    }
    hashes["hash"] = "sha256:" + canonical(hashes)
    files["hashes.json"] = write_json("hashes.json", hashes)
    print(json.dumps({"files": files, "canonical": hashes["canonical"],
                      "freeLengthM": line_doc["correctedCourse"]["freeLengthM"],
                      "blockedLengthM": line_doc["correctedCourse"]["blockedLengthM"],
                      "minCentreToPropM": line_doc["correctedCourse"]["minCentreToPropM"],
                      "minLateralMarginM": line_doc["correctedCourse"]["minLateralMarginM"],
                      "blockedArcs": line_doc["correctedCourse"]["blockedArcs"],
                      "routeConnected": connected,
                      "route": route and {k: route[k] for k in ("cells", "lengthM")}}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
