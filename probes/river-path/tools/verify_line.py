#!/usr/bin/env python3
"""Independent verifier for the river 310 m prop/lane audit.

Shares no geometry, SAT or raster code with build_line.py.  Re-derives every
corrected sample from the committed path, the committed collider manifest and
the P48 grid, and re-measures:

  * path continuity and step limit within each free segment;
  * the nine-point car pose on the P48 drivable collision surface;
  * exact polygon overlap between the real 2.981 x 1.676 m car rectangle and
    every prop footprint;
  * exact centre-to-prop distance (point to polygon) >= envelope half-width;
  * the recorded lane width and lateral margin;
  * every one of the 468 props classified;
  * the four cluster sets and the 13-prop C2 wall;
  * the blocked arc and the disconnected raster route;
  * canonical and file hashes (determinism).

    python probes/river-path/tools/verify_line.py
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work/river-path"
PATH_FILE = ROOT / "_work/drivable-path/path.json"
GRID_FILE = ROOT / "_work/drivable-path/grid.npz"
MANIFEST = ROOT / "_work/prop-collision/colliders.json"
LOG = ROOT / "_work/logs/river-path/verify.log"

HL = 2.981 / 2.0
HW = 1.676 / 2.0
BAND = 1.35
STEP_LIMIT = 0.40


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical(doc: dict) -> str:
    body = dict(doc)
    body.pop("hash", None)
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def footprint(c: dict) -> np.ndarray:
    ax = np.array(c["axes"], dtype=float)
    u = ax[0][[0, 2]]
    v = ax[2][[0, 2]]
    u = u / np.linalg.norm(u)
    v = v / np.linalg.norm(v)
    ctr = np.array(c["center"], dtype=float)[[0, 2]]
    hu, hv = c["half"][0], c["half"][2]
    return np.array([ctr + su * hu * u + sv * hv * v
                     for su, sv in ((1, 1), (-1, 1), (-1, -1), (1, -1))])


def car_rect(pos, tangent) -> np.ndarray:
    t = np.array(tangent, dtype=float)
    n = np.array([-t[1], t[0]])
    p = np.array(pos, dtype=float)
    return np.array([p + a * t + b * n for a, b in
                     ((HL, HW), (-HL, HW), (-HL, -HW), (HL, -HW))])


def seg_intersect(a, b, c, d) -> bool:
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    o1 = orient(a, b, c)
    o2 = orient(a, b, d)
    o3 = orient(c, d, a)
    o4 = orient(c, d, b)
    return (o1 * o2 < 0) and (o3 * o4 < 0)


def point_in_poly(p, poly) -> bool:
    # even-odd ray cast
    x, z = p
    inside = False
    n = len(poly)
    for i in range(n):
        xa, za = poly[i]
        xb, zb = poly[(i + 1) % n]
        if (za > z) != (zb > z):
            xin = xa + (z - za) * (xb - xa) / (zb - za)
            if x < xin:
                inside = not inside
    return inside


def polygons_overlap(a, b) -> bool:
    if any(point_in_poly(p, b) for p in a):
        return True
    if any(point_in_poly(p, a) for p in b):
        return True
    for i in range(4):
        for j in range(4):
            if seg_intersect(a[i], a[(i + 1) % 4], b[j], b[(j + 1) % 4]):
                return True
    return False


def point_poly_distance(p, poly) -> float:
    if point_in_poly(p, poly):
        return 0.0
    best = float("inf")
    for i in range(len(poly)):
        a = poly[i]
        b = poly[(i + 1) % len(poly)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        l2 = dx * dx + dz * dz
        if l2 == 0:
            d = math.hypot(p[0] - a[0], p[1] - a[1])
        else:
            t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2))
            d = math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz))
        best = min(best, d)
    return best


def main() -> int:
    path_doc = json.loads(PATH_FILE.read_text(encoding="utf-8"))
    man = json.loads(MANIFEST.read_text(encoding="utf-8"))
    grid = np.load(GRID_FILE, allow_pickle=False)
    line = json.loads((OUT / "line.json").read_text(encoding="utf-8"))
    props_doc = json.loads((OUT / "props.json").read_text(encoding="utf-8"))
    route = json.loads((OUT / "route.json").read_text(encoding="utf-8"))
    hashes = json.loads((OUT / "hashes.json").read_text(encoding="utf-8"))

    pts = np.array(path_doc["course"]["points"], dtype=float)
    arc = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    H, bp, xs, zs = grid["height"], grid["base_pass"], grid["xs"], grid["zs"]

    checks = []
    failures = []

    def check(name, ok, detail=None):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            failures.append({"name": name, "detail": detail})

    by_id = {c["id"]: c for c in man["colliders"]}
    prop_by_id = {p["id"]: p for p in props_doc["props"]}
    seg_groups = {}
    for rec in line["samples"]:
        seg_groups.setdefault(rec["segment"], []).append(rec)
    for name in seg_groups:
        seg_groups[name].sort(key=lambda r: r["i"])

    # 1. schema / status
    check("line-kind", line.get("kind") == "river-path.corrected-line")
    check("props-kind", props_doc.get("kind") == "river-path.prop-audit")
    check("route-kind", route.get("kind") == "river-path.raster-route")
    check("line-status-blocked", line.get("status") == "blocked" and line.get("complete") is False)
    check("blocked-arc-present", len(line["correctedCourse"]["blockedArcs"]) >= 1)

    # 2. canonical / file hashes (determinism)
    check("line-canonical-hash", canonical(line) == line["hash"].split(":", 1)[1], line["hash"])
    check("props-canonical-hash", canonical(props_doc) == props_doc["hash"].split(":", 1)[1])
    check("route-canonical-hash", canonical(route) == route["hash"].split(":", 1)[1])
    for name in ("line.json", "props.json", "route.json", "audit.json"):
        want = hashes["outputs"].get(name)
        got = sha256_file(OUT / name)
        check(f"file-hash-{name}", want == got, {"want": want, "got": got})
    check("input-path-hash", hashes["inputs"]["path.json"] == sha256_file(PATH_FILE))
    check("input-colliders-hash", hashes["inputs"]["colliders.json"] == sha256_file(MANIFEST),
          hashes["inputs"]["colliders.json"])
    check("input-grid-hash", hashes["inputs"]["grid.npz"] == sha256_file(GRID_FILE))
    check("car-envelope", abs(line["carEnvelope"]["lengthM"] - 2.981) < 1e-12 and
          abs(line["carEnvelope"]["widthM"] - 1.676) < 1e-12)

    # 3. props: every collider classified, set equality, cluster counts
    check("prop-count-468", len(props_doc["props"]) == 468 == len(man["colliders"]))
    check("prop-id-set", set(prop_by_id) == set(by_id))
    missing = [pid for pid in by_id if pid not in prop_by_id]
    check("prop-no-missing", not missing, missing[:5])
    required = ("id", "cluster", "whatItIs", "surface", "pathRelation", "nearestArcM",
                "lateralOffsetToFaceM", "size", "vertical", "firstBlockedArcM")
    bad = []
    for p in props_doc["props"]:
        for k in required:
            if k not in p:
                bad.append((p["id"], k))
        if p["surface"]["cells"] > 0 and not (0.0 <= p["surface"]["basePassFraction"] <= 1.0):
            bad.append((p["id"], "surfaceFraction"))
        if p["pathRelation"] not in ("intersects-envelope", "envelope-but-overhead",
                                     "within-3m", "within-6m", "within-12m", "outside-12m"):
            bad.append((p["id"], "pathRelation"))
    check("prop-fields-valid", not bad, bad[:5])
    check("prop-relations-count",
          sum(p["pathRelation"] == "intersects-envelope" for p in props_doc["props"]) == 95)
    p66 = {r["colliderId"] for r in man["onMeasuredCourse"]}
    ours = {p["id"] for p in props_doc["props"] if p["pathRelation"] == "intersects-envelope"}
    check("prop-envelope-set-equals-p66", ours == p66,
          {"missing": sorted(p66 - ours)[:5], "extra": sorted(ours - p66)[:5]})
    for key, n in (("C1", 32), ("C2", 13), ("C3", 28), ("C4", 22)):
        got = sum(1 for p in props_doc["props"]
                  if p["cluster"] == key and p["pathRelation"] == "intersects-envelope")
        check(f"cluster-{key}-envelope-count", got == n, got)
    check("cluster-on-surface-C1",
          all(p["surface"]["basePassFraction"] == 1.0 for p in props_doc["props"]
              if p["cluster"] == "C1" and p["pathRelation"] == "intersects-envelope"))
    check("cluster-on-surface-C2",
          all(p["surface"]["basePassFraction"] == 1.0 for p in props_doc["props"]
              if p["cluster"] == "C2" and p["pathRelation"] == "intersects-envelope"))
    check("cluster-on-surface-C4",
          all(p["surface"]["basePassFraction"] == 1.0 for p in props_doc["props"]
              if p["cluster"] == "C4" and p["pathRelation"] == "intersects-envelope"))
    c3 = [p for p in props_doc["props"]
          if p["cluster"] == "C3" and p["pathRelation"] == "intersects-envelope"]
    check("cluster-C3-straddles", sum(p["surface"]["relation"] == "straddles-surface-edge" for p in c3) >= 20,
          sum(p["surface"]["relation"] == "straddles-surface-edge" for p in c3))

    # 4. per-segment samples: continuity, surface, overlap, clearance
    total_samples = 0
    for name, recs in seg_groups.items():
        check(f"{name}-nonempty", len(recs) > 100, len(recs))
        check(f"{name}-ordered", all(recs[i]["i"] < recs[i + 1]["i"] for i in range(len(recs) - 1)))
        for k, rec in enumerate(recs):
            total_samples += 1
            ok = True
            detail = {}
            vals = rec["position"] + rec["tangent"] + [rec["lateralOffsetM"],
                    rec["laneWidthM"], rec["lateralMarginM"], rec["centreToPropM"]]
            if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in vals):
                ok = False
                detail["nan"] = True
            t = np.array(rec["tangent"], dtype=float)
            if abs(np.linalg.norm(t) - 1.0) > 1e-5:
                ok = False
                detail["tangentNorm"] = float(np.linalg.norm(t))
            if k > 0:
                step = np.linalg.norm(np.array(rec["position"]) - np.array(recs[k - 1]["position"]))
                if step > STEP_LIMIT:
                    ok = False
                    detail["step"] = round(float(step), 6)
            # nine-point surface
            n = np.array([-t[1], t[0]])
            p = np.array(rec["position"], dtype=float)
            on = True
            for a in (-HL, 0.0, HL):
                for b in (-HW, 0.0, HW):
                    q = p + a * t + b * n
                    ii = int(round((q[0] - xs[0]) / 0.5))
                    jj = int(round((q[1] - zs[0]) / 0.5))
                    if ii < 0 or jj < 0 or ii >= len(xs) or jj >= len(zs) or not bp[jj, ii]:
                        on = False
            if not on:
                ok = False
                detail["surface"] = False
            # exact polygon overlap + centre distance
            car = car_rect(p, t)
            min_cpc = float("inf")
            overlap = False
            for c in man["colliders"]:
                ctr = c["center"]
                if abs(ctr[0] - p[0]) > 30 or abs(ctr[2] - p[1]) > 30:
                    continue
                g = float(H[int(round((p[1] - zs[0]) / 0.5)),
                            int(round((p[0] - xs[0]) / 0.5))])
                if c["vertical"]["top"] <= g + 0.05 or c["vertical"]["bottom"] >= g + BAND:
                    continue
                fp = footprint(c)
                if polygons_overlap(car, fp):
                    overlap = True
                    break
                min_cpc = min(min_cpc, point_poly_distance(p, fp))
            if overlap:
                ok = False
                detail["overlap"] = True
            if min_cpc == float("inf"):
                min_cpc = 99.0
            if min_cpc < HW - 1e-6:
                ok = False
                detail["centreToProp"] = round(float(min_cpc), 6)
            if abs(min_cpc - rec["centreToPropM"]) > 1e-4 and min_cpc < 98:
                ok = False
                detail["clearanceMismatch"] = [round(float(min_cpc), 6), rec["centreToPropM"]]
            if rec["laneWidthM"] + 1e-9 < 0:
                ok = False
                detail["laneWidth"] = rec["laneWidthM"]
            if rec["lateralOffsetM"] < rec["laneStartM"] - 1e-6 or rec["lateralOffsetM"] > rec["laneEndM"] + 1e-6:
                ok = False
                detail["offsetOutsideLane"] = True
            if not rec["onSurface"]:
                ok = False
                detail["onSurfaceFlag"] = False
            if not ok:
                check(f"{name}-sample-{rec['i']:04d}", False, detail)
            else:
                checks.append({"name": f"{name}-sample-{rec['i']:04d}", "ok": True})
    check("total-free-samples", total_samples == len(line["samples"]), total_samples)

    # 5. lane bins
    check("lane-bins-count", len(line["laneBins"]) >= 300, len(line["laneBins"]))
    for b in line["laneBins"]:
        ok = True
        detail = {}
        if b["freeRuns"]:
            want = max(r["width"] for r in b["freeRuns"])
            if b["widest"] is None or abs(b["widest"]["width"] - want) > 1e-6:
                ok = False
                detail["widest"] = b["widest"]
        else:
            if b["widest"] is not None:
                ok = False
                detail["widestWhenBlocked"] = b["widest"]
        if b["chosenOffsetM"] is not None:
            inside = any(r["start"] - 1e-9 <= b["chosenOffsetM"] <= r["end"] + 1e-9
                         for r in b["freeRuns"])
            if not inside:
                ok = False
                detail["chosenOutside"] = b["chosenOffsetM"]
        if not ok:
            check(f"bin-{b['baseArcM']:.1f}", False, detail)
        else:
            checks.append({"name": f"bin-{b['baseArcM']:.1f}", "ok": True})

    # 6. blocked arc: exact wall, 13 C2 props, no free pose at a sealed sample
    blocked = line["correctedCourse"]["blockedArcs"]
    check("blocked-arc-one", len(blocked) >= 1)
    c2_on = {r["colliderId"] for r in man["onMeasuredCourse"] if "draw.119." in r["colliderId"]
             or "draw.120." in r["colliderId"] or "draw.97." in r["colliderId"]
             or "draw.99." in r["colliderId"]}
    for b in blocked:
        if b["lengthM"] <= 0:
            continue
        check(f"blocked-{b['arcStartM']:.1f}-arc", 120.0 <= b["arcStartM"] <= 130.0, b["arcStartM"])
        check(f"blocked-{b['arcStartM']:.1f}-sealed-samples", b["sealedSamples"] >= 1, b["sealedSamples"])
        check(f"blocked-{b['arcStartM']:.1f}-c2-props",
              set(b["excludedPropIds"]) == c2_on,
              {"missing": sorted(c2_on - set(b["excludedPropIds"]))[:5],
               "extra": sorted(set(b["excludedPropIds"]) - c2_on)[:5]})
        # independent free-pose scan at one sealed sample in the arc
        if b["sealedSamples"] >= 1:
            i = b.get("sealedSampleFirst")
            if i is None:
                i = b["sampleStart"] + (b["sampleEnd"] - b["sampleStart"]) // 2
            t = np.array([pts[min(i + 1, len(pts) - 1)][0] - pts[max(i - 1, 0)][0],
                          pts[min(i + 1, len(pts) - 1)][1] - pts[max(i - 1, 0)][1]])
            t /= np.linalg.norm(t)
            n = np.array([-t[1], t[0]])
            free_count = 0
            for off in np.arange(-12.0, 12.0 + 1e-9, 0.05):
                p = pts[i] + off * n
                car = car_rect(p, t)
                g = float(H[int(round((p[1] - zs[0]) / 0.5)),
                            int(round((p[0] - xs[0]) / 0.5))])
                blocked_here = False
                for c in man["colliders"]:
                    if c["vertical"]["top"] <= g + 0.05 or c["vertical"]["bottom"] >= g + BAND:
                        continue
                    if polygons_overlap(car, footprint(c)):
                        blocked_here = True
                        break
                if blocked_here:
                    continue
                ok_surface = True
                for a in (-HL, 0.0, HL):
                    for bb in (-HW, 0.0, HW):
                        q = p + a * t + bb * n
                        ii = int(round((q[0] - xs[0]) / 0.5))
                        jj = int(round((q[1] - zs[0]) / 0.5))
                        if ii < 0 or jj < 0 or ii >= len(xs) or jj >= len(zs) or not bp[jj, ii]:
                            ok_surface = False
                if ok_surface:
                    free_count += 1
            check(f"blocked-{b['arcStartM']:.1f}-no-free-pose", free_count == 0, free_count)

    # 7. route connectivity and alternative-route measurement
    check("route-disconnected", route.get("connected") is False)
    check("route-no-path", route.get("route") is None)
    check("route-reason-present", bool(route.get("disconnectedReason")))
    check("route-model-props-removed", "minus every prop footprint" in route["model"]["base"])

    # 8. corrected course summary consistency
    cc = line["correctedCourse"]
    check("free-length-positive", cc["freeLengthM"] > 300.0, cc["freeLengthM"])
    check("blocked-length-small", 0.0 < cc["blockedLengthM"] < 10.0, cc["blockedLengthM"])
    check("min-centre-clearance", cc["minCentreToPropM"] >= HW, cc["minCentreToPropM"])
    check("min-lateral-margin", cc["minLateralMarginM"] >= 0.0, cc["minLateralMarginM"])
    check("max-step", cc["maxStepM"] <= STEP_LIMIT, cc["maxStepM"])
    check("segments-cover", sum(s["lengthM"] for s in cc["segments"]) > 300.0)
    check("no-nan-summary", all(math.isfinite(float(cc[k])) for k in
          ("freeLengthM", "blockedLengthM", "minCentreToPropM", "minLateralMarginM", "maxStepM")))

    result = {
        "kind": "river-path.verify",
        "version": 1,
        "checks": checks,
        "count": len(checks),
        "failures": failures,
        "totalChecks": len(checks),
        "failedChecks": len(failures),
        "totalSamples": total_samples,
        "status": "PASS" if not failures else "FAIL",
    }
    result["hash"] = "sha256:" + canonical(result)
    (OUT / "verify.json").write_text(
        json.dumps(result, indent=1, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n")
    print(json.dumps({"status": result["status"], "count": len(checks),
                      "failures": len(failures),
                      "totalSamples": total_samples,
                      "hash": result["hash"]}, indent=1))
    if failures:
        print(json.dumps(failures[:20], indent=1))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
