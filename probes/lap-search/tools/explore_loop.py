#!/usr/bin/env python3
"""P61 prototype: trace one island ring into a closed path and measure it."""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/lap-search/tools"))
from raster import label_components, enclosed_islands, erode  # noqa: E402

CELL = 0.5
DIRS = [(0, -1), (-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1)]


def moore_trace(mask):
    ys, xs = np.nonzero(mask)
    j0, i0 = int(ys[0]), int(xs[ys == ys[0]][0])
    start = (j0, i0)
    b = start
    c = (j0, i0 - 1)
    contour = [start]
    seen = set()
    while True:
        dj, di = c[0] - b[0], c[1] - b[1]
        k = DIRS.index((dj, di))
        found = False
        for t in range(1, 9):
            kk = (k + t) % 8
            nb = (b[0] + DIRS[kk][0], b[1] + DIRS[kk][1])
            if 0 <= nb[0] < mask.shape[0] and 0 <= nb[1] < mask.shape[1] and mask[nb]:
                c = (b[0] + DIRS[(kk - 1) % 8][0], b[1] + DIRS[(kk - 1) % 8][1])
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


def map_to_fg(contour, F):
    nz, nx = F.shape
    out = []
    prev = None
    for (j, i) in contour:
        cands = []
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                if dj == 0 and di == 0:
                    continue
                y, x = j + dj, i + di
                if 0 <= y < nz and 0 <= x < nx and F[y, x]:
                    cands.append((abs(dj) + abs(di), y, x))
        if not cands:
            continue
        if prev is None:
            cands.sort()
            pick = cands[0]
        else:
            cands.sort(key=lambda q: (abs(q[1] - prev[0]) + abs(q[2] - prev[1]), q[0]))
            pick = cands[0]
        out.append((pick[1], pick[2]))
        prev = (pick[1], pick[2])
    return out


def line_of_sight(mask, a, b):
    j0, i0 = a
    j1, i1 = b
    steps = max(abs(j1 - j0), abs(i1 - i0))
    if steps == 0:
        return mask[j0, i0]
    for k in range(steps + 1):
        t = k / steps
        j = int(round(j0 + (j1 - j0) * t))
        i = int(round(i0 + (i1 - i0) * t))
        if not mask[j, i]:
            return False
    return True


def taut_loop(mask, cells):
    # drop consecutive duplicates
    seq = [cells[0]]
    for c in cells[1:]:
        if c != seq[-1]:
            seq.append(c)
    if len(seq) < 4:
        return seq
    # start from the cell farthest from the centroid to reduce seam weirdness
    js = np.array([c[0] for c in seq], dtype=float)
    is_ = np.array([c[1] for c in seq], dtype=float)
    cj, ci = js.mean(), is_.mean()
    d = (js - cj) ** 2 + (is_ - ci) ** 2
    s = int(np.argmax(d))
    seq = seq[s:] + seq[:s]
    out = [seq[0]]
    k = 0
    n = len(seq)
    while k < n - 1:
        best = k + 1
        for m in range(n - 1, k, -1):
            if line_of_sight(mask, seq[k], seq[m]):
                best = m
                break
        out.append(seq[best])
        k = best
    # closing segment back to the start
    if out[-1] != out[0]:
        out.append(out[0])
    return out


def resample(points, step):
    out = []
    for a, b in zip(points, points[1:]):
        l = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(math.ceil(l / step)))
        for k in range(n):
            t = k / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    out.append(points[-1])
    return out


def main():
    z = np.load(ROOT / "_work/lap-search/_full05.npz")
    base = z["base"]
    H = z["height"].astype(np.float32)
    xs, zs = z["xs"], z["zs"]
    lab, sizes = label_components(base, conn=8)
    isl = enclosed_islands(base, lab)
    blab0, _ = label_components(~base, conn=4)
    k = 3
    F = erode(base, k)
    lf, sf = label_components(F, conn=8)
    isf = enclosed_islands(F, lf)
    blab, _ = label_components(~F, conn=4)
    for target in [h for h in isl if h["size"] >= 100]:
        base_mask = blab0 == target["bgLabel"]
        best = None
        for q in isf:
            qm = blab == q["bgLabel"]
            ov = int((base_mask & qm).sum())
            if best is None or ov > best[0]:
                best = (ov, q)
        if best is None or best[0] < 0.5 * target["size"]:
            print("island", target["size"], "no eroded match at k", k, "best overlap", best[0] if best else 0)
            continue
        match = best[1]
        print("island", target["size"], "match at k", k, match, "overlap", best[0])
        I = blab == match["bgLabel"]
        contour = moore_trace(I)
        print("  contour pixels", len(contour))
        fg = map_to_fg(contour, F)
        print("  fg cells", len(fg))
        taut = taut_loop(F, fg)
        print("  taut points", len(taut))
        pts = [(float(xs[c[1]]), float(zs[c[0]])) for c in taut]
        # close
        if pts[0] != pts[-1]:
            pts.append(pts[0])
        smp = resample(pts, 0.25)
        length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(smp, smp[1:]))
        # raster height metrics
        hs = []
        for x, z in smp:
            i = int(round((x - xs[0]) / CELL))
            j = int(round((z - zs[0]) / CELL))
            hs.append(float(H[j, i]) if 0 <= j < H.shape[0] and 0 <= i < H.shape[1] else float("nan"))
        step = max(abs(b - a) for a, b in zip(hs, hs[1:]) if math.isfinite(a) and math.isfinite(b))
        grade = 0.0
        for a in range(len(smp)):
            m = a
            acc = 0.0
            while m + 1 < len(smp) and acc < 2.0:
                acc += math.hypot(smp[m + 1][0] - smp[m][0], smp[m + 1][1] - smp[m][1])
                m += 1
            if acc >= 1.9 and math.isfinite(hs[a]) and math.isfinite(hs[m]):
                grade = max(grade, abs(hs[m] - hs[a]) / acc)
        print("  length %.3f m samples %d max step %.4f max grade %.3f%%"
              % (length, len(smp), step, 100 * grade))
        print("  first pts", smp[:3], "last", smp[-3:])
        print("  bbox", min(p[0] for p in smp), max(p[0] for p in smp),
              min(p[1] for p in smp), max(p[1] for p in smp))


if __name__ == "__main__":
    main()
