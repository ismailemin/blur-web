#!/usr/bin/env python3
"""Independent recomputation of the 310.395 m course visual coverage.

This verifier shares no coverage, index or attribution code with
`build_visual_coverage.py`. It re-reads the committed draw geometry with the
*native* C++ reader (`_work/build/asset-reader-native/Release/level_inspect.exe`,
`level_mesh` entry point), not with the Python `visual.json` the builder consumed,
and it re-parses `Level.levelphysics` through the collision-oracle reference
parser. Every check is computed from those two byte sources:

  * the native positions/indices hashes and draw ranges must match the manifest;
  * every sample's collision height, nearest draw height, delta, covering draw,
    triangle offset, car-width flags and continuous width are recomputed;
  * coverage fractions, gaps, segments, draw spans and totals are recomputed;
  * the canonical manifest hash is recomputed.

Additional cross-check: if `_work/drivable-path/engine-trace.json` exists, the
oracle collision height is compared with the engine's own `_e1_ground_probe`
ground at the same coordinates. That validates the collision plane only; the
draw geometry question is answered by the native reader.

Usage:
    python probes/drivable-path/tools/verify_visual_coverage.py
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
import reference_oracle as oracle  # noqa: E402
sys.path.insert(0, str(ROOT / "tools"))
import inspect_level_candidates as cand  # noqa: E402

OUT = ROOT / "_work/drivable-path"
PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
LEVEL_RENDER = ROOT / "game-data/Blur/levels/usa_la_river/level.levelrender"
MANIFEST = OUT / "visual-coverage.json"
SAMPLES = OUT / "visual-coverage-samples.json"
ENGINE_TRACE = OUT / "engine-trace.json"
NATIVE = ROOT / "_work/build/asset-reader-native/Release/level_inspect.exe"
STAGE = OUT / "verify-native"

COVER_TOL = 0.5
COLLISION_NY_MIN = 0.5
VISUAL_NY_MIN = 0.1
CAR_WIDTH = 1.676
SAFETY_MARGIN = 0.30
ENVELOPE_HALF = CAR_WIDTH / 2.0
MARGIN_HALF = ENVELOPE_HALF + SAFETY_MARGIN
QUARTER_HALF = ENVELOPE_HALF / 2.0
STATIONS = (0.0, -QUARTER_HALF, QUARTER_HALF, -ENVELOPE_HALF, ENVELOPE_HALF,
            -MARGIN_HALF, MARGIN_HALF)
WIDTH_STEP = 0.10
WIDTH_CAP = 12.0
BUCKET = 2.5          # deliberately different from the builder's 4.0 m buckets


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(doc: dict) -> str:
    body = dict(doc)
    body.pop("hash", None)
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + sha256_bytes(text.encode("utf-8"))


def normal(a, b, c):
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    return nx / length, ny / length, nz / length


def plane_height(tri, x, z):
    a, b, c = tri[0], tri[1], tri[2]
    den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
    if abs(den) < 1e-12:
        return None
    w0 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / den
    w1 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / den
    w2 = 1.0 - w0 - w1
    if w0 < -1e-9 or w1 < -1e-9 or w2 < -1e-9:
        return None
    return w0 * a[1] + w1 * b[1] + w2 * c[1]


class Grid:
    def __init__(self, triangles):
        self.tris = triangles
        self.cells = defaultdict(list)
        for i, (a, b, c, *_rest) in enumerate(triangles):
            for cx in range(int(math.floor(min(a[0], b[0], c[0]) / BUCKET)),
                            int(math.floor(max(a[0], b[0], c[0]) / BUCKET)) + 1):
                for cz in range(int(math.floor(min(a[2], b[2], c[2]) / BUCKET)),
                                int(math.floor(max(a[2], b[2], c[2]) / BUCKET)) + 1):
                    self.cells[(cx, cz)].append(i)

    def at(self, x, z):
        return self.cells.get((int(math.floor(x / BUCKET)), int(math.floor(z / BUCKET))), ())


def native_section(key):
    """Re-extract one section with the native C++ level reader."""
    if not NATIVE.is_file():
        raise SystemExit("verify_visual_coverage: BLOCKED: native reader missing: "
                         + str(NATIVE.relative_to(ROOT)))
    statistics = Counter()
    pairs, _ = cand.inspect_level("usa_la_river", statistics, [])
    pair = None
    for candidate in pairs:
        node_block = candidate["node"]["record"]["items"][0]["block"]
        if "g%d-n%d" % (candidate["geometryBlock"], node_block) == key:
            pair = candidate
            break
    if pair is None:
        raise SystemExit("verify_visual_coverage: BLOCKED: section %s not in the committed "
                         "level reader enumeration" % key)
    geometry_bytes = pair["readRecord"](pair["geometryRecord"])
    node_bytes = pair["node"]["raw"]
    STAGE.mkdir(parents=True, exist_ok=True)
    geometry_file = STAGE / ("%s.geometry.chunk" % key)
    node_file = STAGE / ("%s.node.chunk" % key)
    geometry_file.write_bytes(geometry_bytes)
    node_file.write_bytes(node_bytes)
    process = subprocess.run(
        [str(NATIVE), str(LEVEL_RENDER), str(geometry_file), str(node_file),
         str(pair["geometryBlock"]), str(pair["node"]["record"]["items"][0]["block"])],
        capture_output=True, text=True, encoding="utf-8", timeout=60, check=False)
    if process.returncode != 0:
        raise SystemExit("verify_visual_coverage: BLOCKED: native reader failed: "
                         + (process.stderr or process.stdout)[:300])
    doc = json.loads(process.stdout)
    if doc.get("status") != "ok":
        raise SystemExit("verify_visual_coverage: BLOCKED: native reader status "
                         + str(doc.get("error")))
    doc["geometryChunkSha256"] = sha256_bytes(geometry_bytes)
    doc["nodeChunkSha256"] = sha256_bytes(node_bytes)
    doc["levelSha256"] = sha256_bytes(LEVEL_RENDER.read_bytes())
    return doc


def main() -> int:
    for required in (MANIFEST, SAMPLES):
        if not required.is_file():
            print("verify_visual_coverage: BLOCKED: missing %s; run "
                  "build_visual_coverage.py first" % required.relative_to(ROOT),
                  file=sys.stderr)
            return 3
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    sample_doc = json.loads(SAMPLES.read_text(encoding="utf-8"))
    errors = []
    warnings = []
    checked = Counter()

    def check(name, ok, detail=None, warn=False):
        checked[name] += 1
        if not ok:
            (warnings if warn else errors).append(
                {"check": name, "detail": str(detail)[:400]})

    # ------------------------------------------------------------- 1. hashes
    check("manifest-canonical-hash", canonical(manifest) == manifest["hash"],
          (canonical(manifest), manifest["hash"]))
    if sha256_bytes(PHYSICS.read_bytes()) != manifest["inputs"]["physicsSha256"]:
        errors.append({"check": "physics-hash", "detail": "Level.levelphysics changed"})
    path_doc = json.loads((OUT / "path.json").read_text(encoding="utf-8"))
    check("path-hash", canonical(path_doc) == manifest["inputs"]["pathHash"],
          canonical(path_doc))
    visual_bytes = (ROOT / manifest["inputs"]["visualMap"]).read_bytes()
    check("visual-map-hash",
          sha256_bytes(visual_bytes) == manifest["inputs"]["visualMapSha256"],
          sha256_bytes(visual_bytes))
    visual_map = json.loads(visual_bytes)
    map_section = {s["key"]: s for s in visual_map["sections"]}
    rows = sample_doc["rows"]
    fields = sample_doc["fields"]
    check("sample-fields", fields == manifest["samplesFile"]["fields"], fields)

    # ------------------------------------------- 2. native geometry vs manifest
    used_keys = [s["key"] for s in manifest["sections"]]
    native = {key: native_section(key) for key in used_keys}
    native_section_errors = []
    for record in manifest["sections"]:
        key = record["key"]
        doc = native[key]
        positions = doc["positions"]
        indices = doc["indices"]
        draw_ranges = [(d["firstIndex"], d["indexCount"]) for d in doc["draws"]]
        map_draws = [(d["firstIndex"], d["indexCount"]) for d in record["draws"]]
        if len(positions) // 3 != record["vertexCount"]:
            native_section_errors.append("%s vertex count" % key)
        if len(indices) // 3 != record["triangleCount"]:
            native_section_errors.append("%s triangle count" % key)
        if draw_ranges != map_draws:
            native_section_errors.append("%s draw ranges" % key)
        if sha256_bytes(b"".join(struct_pack_float(v) for v in positions)) != record["positionsSha256"]:
            native_section_errors.append("%s positions hash" % key)
        if sha256_bytes(b"".join(struct_pack_uint(v) for v in indices)) != record["indicesSha256"]:
            native_section_errors.append("%s indices hash" % key)
        # The manifest's draw entries must also reproduce the pinned draw map.
        source = map_section[key]["draws"]
        if len(record["draws"]) != len(source):
            native_section_errors.append("%s draw count %d != %d"
                                         % (key, len(record["draws"]), len(source)))
        for di, (draw, src) in enumerate(zip(record["draws"], source)):
            if (draw["primitiveIndex"], draw["firstIndex"], draw["indexCount"]) != \
                    (src["primitiveIndex"], src["firstIndex"], src["indexCount"]):
                native_section_errors.append("%s draw %d differs from the pinned map" % (key, di))
    check("native-geometry-equals-manifest", not native_section_errors, native_section_errors)

    # ------------------------------------------------ 3. own triangle universe
    level = oracle.load_level(PHYSICS.read_bytes())
    collision = []
    for mesh in level["meshes"]:
        vertices = mesh["vertices"]
        for tri in mesh["triangles"]:
            leaf = mesh["leaves"][tri["leaf"]]
            base = leaf["vertex_start"]
            a = vertices[base + tri["a"]]
            b = vertices[base + tri["b"]]
            c = vertices[base + tri["c"]]
            if normal(a, b, c)[1] > COLLISION_NY_MIN:
                collision.append((a, b, c))
    cgrid = Grid(collision)

    # Visual universe: native positions/indices, restricted to draw ranges.
    visual = []          # (a, b, c, section key, triangle offset, draw index)
    for record in manifest["sections"]:
        key = record["key"]
        doc = native[key]
        positions = doc["positions"]
        indices = doc["indices"]
        ranges = [(d["firstIndex"], d["firstIndex"] + d["indexCount"], di)
                  for di, d in enumerate(doc["draws"])]
        for offset in range(0, len(indices), 3):
            draw_index = None
            for first, end, di in ranges:
                if first <= offset < end:
                    draw_index = di
                    break
            if draw_index is None:
                errors.append({"check": "triangle-outside-draw",
                               "detail": "%s triangle %d is outside every draw range"
                                         % (key, offset)})
                continue
            ia, ib, ic = indices[offset], indices[offset + 1], indices[offset + 2]
            a = (positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2])
            b = (positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2])
            c = (positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2])
            if normal(a, b, c)[1] <= VISUAL_NY_MIN:
                continue
            visual.append((a, b, c, key, offset, draw_index))
    vgrid = Grid(visual)

    def ground(x, z):
        best = None
        for i in cgrid.at(x, z):
            h = plane_height(collision[i], x, z)
            if h is not None and (best is None or h > best):
                best = h
        return best

    def drawn(x, z, coll):
        best = None
        for i in vgrid.at(x, z):
            h = plane_height(visual[i], x, z)
            if h is None:
                continue
            d = h - coll
            if best is None or abs(d) < abs(best[0]):
                best = (d, i)
        return best

    def station(x, z, offset, right):
        px, pz = x + right[0] * offset, z + right[1] * offset
        coll = ground(px, pz)
        if coll is None:
            return None
        hit = drawn(px, pz, coll)
        if hit is None:
            return (coll, None, None, False)
        return (coll, hit[0], hit[1], abs(hit[0]) <= COVER_TOL)

    # ---------------------------------------------------- 4. per-sample replay
    primitive_of = {}
    for record in manifest["sections"]:
        for draw in record["draws"]:
            primitive_of[(record["key"], draw["drawIndex"])] = draw["primitiveIndex"]
    points = path_doc["course"]["points"]
    check("sample-count", len(rows) == len(points), (len(rows), len(points)))
    arc = [0.0]
    for k in range(1, len(points)):
        arc.append(arc[-1] + math.hypot(points[k][0] - points[k - 1][0],
                                        points[k][1] - points[k - 1][1]))
    delta_mismatch = 0
    label_mismatch = 0
    flag_mismatch = 0
    width_mismatch = 0
    band_mismatch = 0
    covered_flags = []
    draw_use_centre = Counter()
    draw_use_band = Counter()
    triangles_centre = set()
    triangles_band = set()
    first_gap = None
    widths = []
    deltas = []
    for k, row in enumerate(rows):
        (row_arc, x, z, row_coll, row_delta, row_section, row_draw, row_prim,
         row_tri, row_left, row_right, row_c, row_e, row_m, row_band) = row
        a = points[max(0, k - 1)]
        b = points[min(len(points) - 1, k + 1)]
        fx, fz = b[0] - a[0], b[1] - a[1]
        length = math.hypot(fx, fz) or 1.0
        right = (-fz / length, fx / length)
        states = [station(x, z, o, right) for o in STATIONS]
        coll0 = states[0][0]
        if coll0 is None:
            errors.append({"check": "collision-missing", "detail": "(%s, %s)" % (x, z)})
            continue
        if row_coll is not None and abs(coll0 - row_coll) > 1e-5:
            delta_mismatch += 1
        centre = states[0]
        env_ok = all(s is not None and s[3] for s in states[:5])
        margin_ok = all(s is not None and s[3] for s in states)
        covered_flags.append(margin_ok)
        if centre[1] is not None:
            deltas.append(centre[1])
            d, i = centre[1], centre[2]
            key, offset, di = visual[i][3], visual[i][4], visual[i][5]
            primitive = primitive_of.get((key, di))
            triangles_centre.add((key, offset))
            draw_use_centre[(key, di)] += 1
            if row_delta is not None and abs(d - row_delta) > 1e-5:
                delta_mismatch += 1
            if (row_section, row_draw, row_prim, row_tri) != (key, di, primitive, offset):
                label_mismatch += 1
        else:
            if row_delta is not None:
                delta_mismatch += 1
        if (row_c, row_e, row_m) != (1 if centre[3] else 0, 1 if env_ok else 0,
                                     1 if margin_ok else 0):
            flag_mismatch += 1
        band_keys = set()
        for s in states:
            if s is not None and s[2] is not None:
                tri = visual[s[2]]
                band_keys.add("%s#%d" % (tri[3], tri[5]))
                triangles_band.add((tri[3], tri[4]))
                draw_use_band[(tri[3], tri[5])] += 1
        if sorted(band_keys) != row_band:
            band_mismatch += 1
        # continuous width, same scan as the builder
        def good(offset):
            s = station(x, z, offset, right)
            return s is not None and s[3]
        left = 0.0
        step = 0.0
        while step < WIDTH_CAP:
            step += WIDTH_STEP
            if good(-step):
                left = step
            else:
                break
        right_w = 0.0
        step = 0.0
        while step < WIDTH_CAP:
            step += WIDTH_STEP
            if good(step):
                right_w = step
            else:
                break
        widths.append(left + right_w)
        if abs(left - row_left) > 1e-4 or abs(right_w - row_right) > 1e-4:
            width_mismatch += 1
        if not margin_ok and first_gap is None:
            first_gap = {"arc": round(arc[k], 4), "x": round(x, 4), "z": round(z, 4)}

    for name, count in (("delta", delta_mismatch), ("label", label_mismatch),
                        ("flags", flag_mismatch), ("width", width_mismatch),
                        ("band", band_mismatch)):
        check("sample-" + name, count == 0, "%d mismatching samples" % count)

    # -------------------------------------------------- 5. recomputed metrics
    covered = sum(1 for f in covered_flags if f)
    coverage = {"samples": len(covered_flags), "covered": covered,
                "fraction": round(covered / len(covered_flags), 6)}
    check("coverage-fraction", coverage["fraction"] ==
          manifest["coverage"]["marginFraction"],
          (coverage["fraction"], manifest["coverage"]["marginFraction"]))
    gaps = []
    run = []
    for k, flag in enumerate(covered_flags):
        if flag:
            if run:
                gaps.append(run)
                run = []
        else:
            run.append(k)
    if run:
        gaps.append(run)
    check("gap-runs", len(gaps) == manifest["coverage"]["gapRuns"],
          (len(gaps), manifest["coverage"]["gapRuns"]))
    gap_total = sum(arc[r[-1]] - arc[r[0]] for r in gaps) if gaps else 0.0
    check("gap-total", abs(gap_total - manifest["coverage"]["gapTotalMetres"]) < 1e-3,
          gap_total)
    check("first-gap", (first_gap is None) == (manifest["firstGap"] is None), first_gap)
    if deltas:
        summary = {"min": round(min(deltas), 6), "max": round(max(deltas), 6),
                   "mean": round(sum(deltas) / len(deltas), 6)}
        check("delta-summary",
              summary["min"] == manifest["delta"]["min"] and
              summary["max"] == manifest["delta"]["max"],
              (summary, manifest["delta"]["min"], manifest["delta"]["max"]))
    check("width-min", round(min(widths), 2) == manifest["width"]["min"],
          (round(min(widths), 2), manifest["width"]["min"]))
    check("draws-used-centre", len(draw_use_centre) == manifest["totals"]["drawsUsedCentre"],
          (len(draw_use_centre), manifest["totals"]["drawsUsedCentre"]))
    check("draws-used-band", len(draw_use_band) == manifest["totals"]["drawsUsedBand"],
          (len(draw_use_band), manifest["totals"]["drawsUsedBand"]))
    check("triangles-centre", len(triangles_centre) ==
          manifest["totals"]["trianglesTouchingCentre"],
          (len(triangles_centre), manifest["totals"]["trianglesTouchingCentre"]))
    check("triangles-band", len(triangles_band) ==
          manifest["totals"]["trianglesTouchingBand"],
          (len(triangles_band), manifest["totals"]["trianglesTouchingBand"]))

    # Draw spans recomputed from the independent attribution.
    spans = defaultdict(list)
    current = None
    start = 0
    for k, row in enumerate(rows):
        key = None if row[5] is None else (row[5], row[6])
        if key != current:
            if current is not None:
                spans[current].append((start, k - 1))
            current = key
            start = k
    if current is not None:
        spans[current].append((start, len(rows) - 1))
    recomputed_spans = []
    span_index = []
    for (key, di), runs_list in spans.items():
        for i0, i1 in runs_list:
            recomputed_spans.append({"section": key, "drawIndex": di,
                                     "arcStart": round(arc[i0], 4),
                                     "arcEnd": round(arc[i1], 4),
                                     "metres": round(arc[i1] - arc[i0], 4),
                                     "samples": i1 - i0 + 1})
            span_index.append((i0, i1, key))
    recomputed_spans.sort(key=lambda r: (r["arcStart"], r["section"], r["drawIndex"]))
    check("draw-spans", recomputed_spans == manifest["drawSpans"],
          (recomputed_spans[:2], manifest["drawSpans"][:2]))

    # Sub-sample refinement at the draw seams: the 0.25 m samples can step over a
    # narrow hole, so interpolate each draw transition at 0.02 m and re-test.
    seams = []
    uncovered_seam_samples = 0
    span_index.sort(key=lambda r: r[0])
    for i in range(1, len(span_index)):
        k0, k1 = span_index[i - 1][1], span_index[i][0]
        if span_index[i - 1][2] != span_index[i][2] or k1 <= k0:
            continue
        x0, z0 = points[k0]
        x1, z1 = points[k1]
        distance = math.hypot(x1 - x0, z1 - z0)
        steps = max(2, int(math.ceil(distance / 0.02)))
        fx, fz = (x1 - x0) / distance, (z1 - z0) / distance
        right = (-fz, fx)
        lo = 0.0
        hi = 0.0
        bad = 0
        for s in range(steps + 1):
            t = s / steps
            x = x0 + (x1 - x0) * t
            z = z0 + (z1 - z0) * t
            state = station(x, z, 0.0, right)
            if state is None or not state[3]:
                bad += 1
                continue
            l = 0.0
            step = 0.0
            while step < WIDTH_CAP:
                step += WIDTH_STEP
                st = station(x, z, -step, right)
                if st is not None and st[3]:
                    l = step
                else:
                    break
            r = 0.0
            step = 0.0
            while step < WIDTH_CAP:
                step += WIDTH_STEP
                st = station(x, z, step, right)
                if st is not None and st[3]:
                    r = step
                else:
                    break
            lo = l
            hi = r
        uncovered_seam_samples += bad
        seams.append({"arc": round(arc[k0], 4), "to": round(arc[k1], 4),
                      "metres": round(distance, 4), "subSamples": steps + 1,
                      "uncovered": bad, "leftMetres": round(lo, 2),
                      "rightMetres": round(hi, 2)})
    check("draw-seam-refinement", uncovered_seam_samples == 0, seams)

    # ------------------------------------------- 6. engine collision cross-check
    engine_check = {"status": "skipped", "reason": "engine-trace.json absent"}
    if ENGINE_TRACE.is_file():
        engine = json.loads(ENGINE_TRACE.read_text(encoding="utf-8"))
        engine_rows = engine.get("rows", [])
        diffs = []
        for row in engine_rows:
            h = ground(row["x"], row["z"])
            if h is None:
                diffs.append({"k": row["k"], "oracle": None, "engine": row["ground"]})
                continue
            diffs.append({"k": row["k"], "oracle": h, "engine": row["ground"],
                          "absDiff": abs(h - row["ground"])})
        values = [d["absDiff"] for d in diffs if "absDiff" in d]
        engine_check = {
            "status": "ok",
            "samples": len(diffs),
            "spacingMetres": engine.get("spacing"),
            "maxAbsDifferenceMetres": round(max(values), 6) if values else None,
            "over1cm": sum(1 for v in values if v > 0.01),
            "over5cm": sum(1 for v in values if v > 0.05),
            "missingCollision": sum(1 for d in diffs if "absDiff" not in d),
            "meaning": ("oracle collision height vs the engine's own _e1_ground_probe at the "
                        "same coordinates; validates the collision plane, not the draw geometry"),
            "engineTraceHash": engine.get("hash"),
        }
        check("engine-ground-agreement", engine_check["over5cm"] == 0,
              engine_check)

    # ----------------------------------------------------------- 7. report
    status = "PASS" if not errors else "FAIL"
    result = {
        "kind": "drivable-path.visual-coverage-verify",
        "version": 1,
        "status": status,
        "manifestHash": manifest["hash"],
        "recomputedManifestHash": canonical(manifest),
        "independentReader": {
            "kind": "native C++ level_mesh (asset-reader)",
            "executable": str(NATIVE.relative_to(ROOT)).replace("\\", "/"),
            "executableSha256": sha256_bytes(NATIVE.read_bytes()),
            "builderReader": "Python tools/inspect_level_candidates.py via track-coverage visual.json",
        },
        "sectionsVerified": used_keys,
        "checks": dict(checked),
        "errors": errors[:20],
        "warnings": warnings[:20],
        "coverage": coverage,
        "gapRuns": len(gaps),
        "gapTotalMetres": round(gap_total, 4),
        "firstGap": first_gap,
        "delta": ({"min": round(min(deltas), 6), "max": round(max(deltas), 6),
                   "mean": round(sum(deltas) / len(deltas), 6)} if deltas else None),
        "width": {"min": round(min(widths), 2), "median": round(sorted(widths)[len(widths) // 2], 2)},
        "drawsUsedCentre": len(draw_use_centre),
        "drawsUsedBand": len(draw_use_band),
        "trianglesTouchingCentre": len(triangles_centre),
        "trianglesTouchingBand": len(triangles_band),
        "drawSeams": seams,
        "engineCollisionCheck": engine_check,
        "nativeInputs": {
            key: {"geometryChunkSha256": native[key]["geometryChunkSha256"],
                  "nodeChunkSha256": native[key]["nodeChunkSha256"],
                  "vertexCount": len(native[key]["positions"]) // 3,
                  "triangleCount": len(native[key]["indices"]) // 3,
                  "drawCount": len(native[key]["draws"])}
            for key in used_keys
        },
        "collisionTriangles": len(collision),
        "visualTriangles": len(visual),
    }
    (OUT / "visual-coverage-verify.json").write_text(
        json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({k: result[k] for k in
                      ("status", "coverage", "gapRuns", "firstGap", "delta", "width",
                       "drawsUsedCentre", "drawsUsedBand", "trianglesTouchingCentre",
                       "trianglesTouchingBand", "checks", "errors", "warnings",
                       "engineCollisionCheck")}, indent=2))
    return 0 if status == "PASS" else 1


def struct_pack_float(value):
    import struct
    return struct.pack("<f", value)


def struct_pack_uint(value):
    import struct
    return struct.pack("<I", value)


if __name__ == "__main__":
    raise SystemExit(main())
