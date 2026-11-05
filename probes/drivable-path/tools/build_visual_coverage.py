#!/usr/bin/env python3
"""Measure which real draw sections cover the committed 310.395 m drivable path.

The committed drivable path (`_work/drivable-path/path.json`, P48) is a
collision-only course. This tool asks a different, visual question: for every
0.25 m sample of that path, does a *real committed draw triangle* sit on the path
across the car width, with a collision triangle below it? It reads:

  * `_work/drivable-path/path.json`                     course samples + hash
  * `_work/track-coverage/visual.json`                  46-section draw map (pinned)
  * `game-data/.../Level.levelphysics`                  collision mesh (oracle)
  * `probes/collision-oracle/tests/reference_oracle.py`  committed collision parser

and writes only under `_work/drivable-path/`. No geometry is invented: every
triangle comes from a draw range of the committed map, and every used triangle
is attributed to its source section and draw.

Definitions (recorded in the manifest under `model`):

  * collision height  = highest up-facing collision triangle (`normal.y > 0.5`)
    containing the test point (same rule as track-coverage);
  * visual height     = the draw triangle (`normal.y > 0.1`) containing the
    point whose height is nearest the collision height;
  * `covered`         = a draw triangle exists and `|visual - collision| <= 0.5 m`
    (the track-coverage surface-proximity rule, symmetric);
  * car width         = harness box proxy width 1.676 m plus the labelled 0.30 m
    margin, i.e. lateral stations 0, +-0.419, +-0.838, +-1.138 m;
  * continuous width  = symmetric covered run, 0.10 m steps, 12 m cap.

Usage:
    python probes/drivable-path/tools/build_visual_coverage.py
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
import reference_oracle as oracle  # noqa: E402

OUT = ROOT / "_work/drivable-path"
PHYSICS = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
PATH_JSON = OUT / "path.json"
VISUAL_JSON = ROOT / "_work/track-coverage/visual.json"

# Pinned inputs: a different file is a hard failure, never a silent fallback.
PATH_KIND = ("drivable-path.course", 1)
PATH_LENGTH = 310.3952
PATH_HASH = "sha256:4b725b10e6619e7cc2f3ef0b0ea03f3a252660a8ffaad0ffe04cb96e0318605b"
VISUAL_SHA256 = "877b4dc7e1f5ece197f0776239b33d23b0350f8cf77ef462c0c7a266a6abcb67"
VISUAL_KIND = ("track-coverage.visual-sections", 1)
PHYSICS_SHA256 = "1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28"
ORACLE = ROOT / "probes/collision-oracle/tests/reference_oracle.py"

# Geometry rules (see module docstring).
COLLISION_NY_MIN = 0.5
VISUAL_NY_MIN = 0.1
COVER_TOL = 0.5
BUCKET = 4.0

# Car envelope: harness box proxy, widest/longest across the five-car XT roster.
CAR_WIDTH = 1.676
SAFETY_MARGIN = 0.30
ENVELOPE_HALF = CAR_WIDTH / 2.0          # 0.838
MARGIN_HALF = ENVELOPE_HALF + SAFETY_MARGIN  # 1.138
QUARTER_HALF = ENVELOPE_HALF / 2.0       # 0.419
STATIONS = (0.0, -QUARTER_HALF, QUARTER_HALF, -ENVELOPE_HALF, ENVELOPE_HALF,
            -MARGIN_HALF, MARGIN_HALF)
ENVELOPE_STATIONS = (0.0, -QUARTER_HALF, QUARTER_HALF, -ENVELOPE_HALF, ENVELOPE_HALF)
MARGIN_STATIONS = STATIONS

WIDTH_STEP = 0.10
WIDTH_CAP = 12.0


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(doc: dict) -> str:
    body = dict(doc)
    body.pop("hash", None)
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + sha256_bytes(text.encode("utf-8"))


def triangle_normal(a, b, c):
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    return nx / length, ny / length, nz / length


def height_in(tri, x, z):
    """Barycentric height of the triangle at (x, z), or None outside it."""
    a, b, c = tri[0], tri[1], tri[2]
    den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
    if abs(den) < 1e-12:
        return None
    l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / den
    l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / den
    l3 = 1.0 - l1 - l2
    if l1 < -1e-9 or l2 < -1e-9 or l3 < -1e-9:
        return None
    return l1 * a[1] + l2 * b[1] + l3 * c[1]


class Index:
    """Deterministic XZ bucket index; insertion order follows the source order."""

    def __init__(self, triangles):
        self.triangles = triangles
        self.buckets = defaultdict(list)
        for i, tri in enumerate(triangles):
            a, b, c = tri[0], tri[1], tri[2]
            i0 = int(math.floor(min(a[0], b[0], c[0]) / BUCKET))
            i1 = int(math.floor(max(a[0], b[0], c[0]) / BUCKET))
            j0 = int(math.floor(min(a[2], b[2], c[2]) / BUCKET))
            j1 = int(math.floor(max(a[2], b[2], c[2]) / BUCKET))
            for bx in range(i0, i1 + 1):
                for bz in range(j0, j1 + 1):
                    self.buckets[(bx, bz)].append(i)

    def candidates(self, x, z):
        key = (int(math.floor(x / BUCKET)), int(math.floor(z / BUCKET)))
        return self.buckets.get(key, ())


def load_collision_triangles():
    level = oracle.load_level(PHYSICS.read_bytes())
    triangles = []
    meshes = []
    for mesh in level["meshes"]:
        vertices = mesh["vertices"]
        kept = 0
        for tri in mesh["triangles"]:
            leaf = mesh["leaves"][tri["leaf"]]
            base = leaf["vertex_start"]
            a = vertices[base + tri["a"]]
            b = vertices[base + tri["b"]]
            c = vertices[base + tri["c"]]
            if triangle_normal(a, b, c)[1] > COLLISION_NY_MIN:
                triangles.append((a, b, c))
                kept += 1
        meshes.append({"meshIndex": mesh["index"], "triangles": len(mesh["triangles"]),
                       "upFacing": kept})
    return triangles, meshes


def load_visual_sections():
    raw = VISUAL_JSON.read_bytes()
    digest = sha256_bytes(raw)
    if digest != VISUAL_SHA256:
        raise SystemExit(
            "build_visual_coverage: BLOCKED: %s is not the pinned 46-section draw map "
            "(%s != %s); run `python probes/track-coverage/tools/build_reference.py`"
            % (VISUAL_JSON.relative_to(ROOT), digest, VISUAL_SHA256))
    doc = json.loads(raw)
    if (doc.get("kind"), doc.get("version")) != VISUAL_KIND:
        raise SystemExit("build_visual_coverage: BLOCKED: unexpected draw map kind/version")
    sections = [s for s in doc["sections"] if s.get("status") == "ok"]
    return doc, sections, digest


def build_visual_triangles(sections):
    """Flatten every draw range of every ok section into triangles.

    Returns (triangles, owner) where owner[i] = (section_index, triangle_offset,
    draw_index, draw). Triangle offset is the index offset inside the section,
    so a reader can recover the exact 3 indices.
    """
    triangles = []
    owner = []
    for si, section in enumerate(sections):
        positions = section["positions"]
        indices = section["indices"]
        draws = section["draws"]
        ranges = [(d["firstIndex"], d["firstIndex"] + d["indexCount"], di, d)
                  for di, d in enumerate(draws)]
        for offset in range(0, len(indices), 3):
            found = None
            for first, end, di, d in ranges:
                if first <= offset < end:
                    found = (di, d)
                    break
            if found is None:
                raise SystemExit(
                    "build_visual_coverage: FAILED: triangle at index %d of %s is outside "
                    "every draw range (not drawn)" % (offset, section["key"]))
            ia, ib, ic = indices[offset], indices[offset + 1], indices[offset + 2]
            a = (positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2])
            b = (positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2])
            c = (positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2])
            if triangle_normal(a, b, c)[1] <= VISUAL_NY_MIN:
                continue
            triangles.append((a, b, c))
            owner.append((si, offset, found[0], found[1]))
    return triangles, owner


def main() -> int:
    # ---------------------------------------------------------------- inputs
    path_bytes = PATH_JSON.read_bytes()
    path = json.loads(path_bytes)
    if (path.get("kind"), path.get("version")) != PATH_KIND:
        raise SystemExit("build_visual_coverage: BLOCKED: unexpected path.json kind")
    if canonical(path) != PATH_HASH:
        raise SystemExit("build_visual_coverage: BLOCKED: path.json canonical hash changed")
    points = path["course"]["points"]
    if len(points) != path["course"]["samples"]:
        raise SystemExit("build_visual_coverage: BLOCKED: path sample count mismatch")

    physics_bytes = PHYSICS.read_bytes()
    if sha256_bytes(physics_bytes) != PHYSICS_SHA256:
        raise SystemExit("build_visual_coverage: BLOCKED: Level.levelphysics hash changed")

    visual_doc, sections, visual_sha = load_visual_sections()
    section_by_key = {s["key"]: s for s in sections}

    # ------------------------------------------------------------- geometry
    collision, meshes = load_collision_triangles()
    cindex = Index(collision)
    visual, owner = build_visual_triangles(sections)
    vindex = Index(visual)

    def ground_height(x, z):
        best = None
        for i in cindex.candidates(x, z):
            h = height_in(collision[i], x, z)
            if h is not None and (best is None or h > best):
                best = h
        return best

    def visual_hit(x, z, coll):
        """(delta, triangle_index) of the drawn triangle nearest `coll`."""
        best = None
        for i in vindex.candidates(x, z):
            h = height_in(visual[i], x, z)
            if h is None:
                continue
            d = h - coll
            if best is None or abs(d) < abs(best[0]):
                best = (d, i)
        return best

    def station_state(x, z, offset, right):
        px, pz = x + right[0] * offset, z + right[1] * offset
        coll = ground_height(px, pz)
        if coll is None:
            return {"collision": None, "delta": None, "tri": None, "covered": False}
        hit = visual_hit(px, pz, coll)
        covered = hit is not None and abs(hit[0]) <= COVER_TOL
        return {"collision": coll, "delta": None if hit is None else hit[0],
                "tri": None if hit is None else hit[1], "covered": covered}

    # --------------------------------------------------------------- samples
    arc = [0.0]
    for k in range(1, len(points)):
        arc.append(arc[-1] + math.hypot(points[k][0] - points[k - 1][0],
                                        points[k][1] - points[k - 1][1]))
    length = arc[-1]
    if abs(length - PATH_LENGTH) > 5e-3:
        raise SystemExit("build_visual_coverage: BLOCKED: path length %.4f != %.4f"
                         % (length, PATH_LENGTH))

    rows = []
    delta_values = []
    widths = []
    left_widths = []
    right_widths = []
    triangles_hit = set()
    triangles_band = set()
    draw_centre_use = Counter()
    draw_band_use = Counter()
    station_fail = Counter()
    centre_covered = 0
    envelope_covered = 0
    margin_covered = 0
    reason = Counter()

    for k, (x, z) in enumerate(points):
        a = points[max(0, k - 1)]
        b = points[min(len(points) - 1, k + 1)]
        fx, fz = b[0] - a[0], b[1] - a[1]
        norm = math.hypot(fx, fz) or 1.0
        fwd = (fx / norm, fz / norm)
        right = (-fwd[1], fwd[0])

        states = [station_state(x, z, o, right) for o in STATIONS]
        centre = states[0]
        env_ok = all(s["covered"] for s in states[:5])
        margin_ok = all(s["covered"] for s in states)
        for s, o in zip(states, STATIONS):
            if not s["covered"]:
                station_fail[o] += 1
            if s["collision"] is None:
                reason["collisionMissing"] += 1
            elif s["tri"] is None:
                reason["visualMissing"] += 1
            elif abs(s["delta"]) > COVER_TOL:
                reason["deltaOutOfTolerance"] += 1

        # Continuous symmetric covered half-runs (report only; flags above are exact).
        def good(offset):
            state = station_state(x, z, offset, right)
            return state["covered"]

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
        left_widths.append(left)
        right_widths.append(right_w)

        if centre["tri"] is not None:
            triangles_hit.add(centre["tri"])
            si, offset, di, draw = owner[centre["tri"]]
            draw_centre_use[(sections[si]["key"], di)] += 1
        for s in states:
            if s["tri"] is not None:
                triangles_band.add(s["tri"])
                si, offset, di, draw = owner[s["tri"]]
                draw_band_use[(sections[si]["key"], di)] += 1

        centre_covered += 1 if centre["covered"] else 0
        envelope_covered += 1 if env_ok else 0
        margin_covered += 1 if margin_ok else 0

        if centre["covered"]:
            delta_values.append(centre["delta"])
            si, offset, di, draw = owner[centre["tri"]]
            rows.append([
                round(arc[k], 4), round(x, 4), round(z, 4),
                round(centre["collision"], 6), round(centre["delta"], 6),
                sections[si]["key"], di, draw["primitiveIndex"], offset,
                round(left, 2), round(right_w, 2),
                1 if centre["covered"] else 0,
                1 if env_ok else 0,
                1 if margin_ok else 0,
                sorted({"%s#%d" % (sections[owner[s["tri"]][0]]["key"], owner[s["tri"]][2])
                        for s in states if s["tri"] is not None}),
            ])
        else:
            rows.append([
                round(arc[k], 4), round(x, 4), round(z, 4),
                None if centre["collision"] is None else round(centre["collision"], 6),
                None, None, None, None, None,
                round(left, 2), round(right_w, 2), 0, 1 if env_ok else 0,
                1 if margin_ok else 0, [],
            ])

    # ------------------------------------------------------ ablation controls
    # The course test must be able to fail. Two independent ablations recompute
    # centre coverage with geometry removed; a 100 % result there would mean the
    # test does not depend on the draws it claims.
    used_draw_keys = set(draw_centre_use) | set(draw_band_use)
    used_section_keys = {key for key, di in used_draw_keys}

    def ablated_coverage(keep):
        tris = []
        for i, tri in enumerate(visual):
            si, offset, di, draw = owner[i]
            if keep(sections[si]["key"], di):
                tris.append(tri)
        index = Index(tris)
        covered = 0
        for x, z in points:
            coll = ground_height(x, z)
            if coll is None:
                continue
            best = None
            for i in index.candidates(x, z):
                h = height_in(tris[i], x, z)
                if h is None:
                    continue
                d = h - coll
                if best is None or abs(d) < abs(best):
                    best = d
            if best is not None and abs(best) <= COVER_TOL:
                covered += 1
        return covered

    without_used_draws = ablated_coverage(
        lambda key, di: (key, di) not in used_draw_keys)
    without_section = ablated_coverage(
        lambda key, di: key not in used_section_keys)

    # ------------------------------------------------------- runs and spans
    def runs(flags):
        out = []
        start = 0
        for k in range(1, len(flags) + 1):
            if k == len(flags) or flags[k] != flags[start]:
                out.append((start, k - 1, flags[start]))
                start = k
        return out

    def metres(i0, i1):
        return arc[i1] - arc[i0]

    segments = []
    for i0, i1, flag in runs([r[12] for r in rows]):  # margin-covered flag
        segments.append({
            "index": len(segments),
            "status": "covered" if flag else "gap",
            "arcStart": round(arc[i0], 4),
            "arcEnd": round(arc[i1], 4),
            "metres": round(metres(i0, i1), 4),
            "samples": i1 - i0 + 1,
            "start": [round(points[i0][0], 4), round(points[i0][1], 4)],
            "end": [round(points[i1][0], 4), round(points[i1][1], 4)],
        })

    gaps = [s for s in segments if s["status"] == "gap"]
    first_gap = gaps[0] if gaps else None

    # Draw spans: maximal runs of the centre attribution, in draw order of first arc.
    spans = defaultdict(list)
    current = None
    start_index = 0
    for k, row in enumerate(rows):
        key = None if row[5] is None else (row[5], row[6])
        if key != current:
            if current is not None:
                spans[current].append((start_index, k - 1))
            current = key
            start_index = k
    if current is not None:
        spans[current].append((start_index, len(rows) - 1))

    draw_spans = []
    for (key, di), runs_list in spans.items():
        for i0, i1 in runs_list:
            draw_spans.append({
                "section": key,
                "drawIndex": di,
                "arcStart": round(arc[i0], 4),
                "arcEnd": round(arc[i1], 4),
                "metres": round(metres(i0, i1), 4),
                "samples": i1 - i0 + 1,
            })
    draw_spans.sort(key=lambda r: (r["arcStart"], r["section"], r["drawIndex"]))

    # --------------------------------------------------------- manifest
    used_by_section = defaultdict(lambda: {"centre": set(), "band": set()})
    for (key, di), count in draw_centre_use.items():
        used_by_section[key]["centre"].add(di)
    for (key, di), count in draw_band_use.items():
        used_by_section[key]["band"].add(di)

    section_records = []
    section_position = {s["key"]: i for i, s in enumerate(sections)}
    hit_by_section = Counter(sections[owner[t][0]]["key"] for t in triangles_hit)
    band_by_section = Counter(sections[owner[t][0]]["key"] for t in triangles_band)
    for key in sorted(used_by_section):
        section = section_by_key[key]
        used = used_by_section[key]
        span_centre = [s for s in draw_spans if s["section"] == key]
        own = sorted(set(used["centre"]) | set(used["band"]))
        draws = []
        for di, draw in enumerate(section["draws"]):
            entry = {
                "drawIndex": di,
                "primitiveIndex": draw["primitiveIndex"],
                "primitiveOffset": draw["primitiveOffset"],
                "firstIndex": draw["firstIndex"],
                "indexCount": draw["indexCount"],
                "declaration": draw["declaration"],
                "topology": draw["topology"],
                "trianglesInRange": draw["indexCount"] // 3,
                "usedCentre": di in used["centre"],
                "usedBand": di in used["band"],
                "samplesCentre": draw_centre_use.get((key, di), 0),
                "samplesBand": draw_band_use.get((key, di), 0),
                "arcSpans": [{"arcStart": s["arcStart"], "arcEnd": s["arcEnd"]}
                             for s in span_centre if s["drawIndex"] == di],
            }
            draws.append(entry)
        section_records.append({
            "key": key,
            "geometryBlock": section["geometryBlock"],
            "nodeBlock": section["nodeBlock"],
            "geometryChunkIndex": section["geometryChunkIndex"],
            "nodeChunkIndex": section["nodeChunkIndex"],
            "nodeName": section.get("nodeName", ""),
            "drawCount": section["drawCount"],
            "vertexCount": section["vertexCount"],
            "triangleCount": section["triangleCount"],
            "positionsSha256": section["positionsSha256"],
            "indicesSha256": section["indicesSha256"],
            "drawsUsedCentre": len(used["centre"]),
            "drawsUsedBand": len(used["band"]),
            "drawIndexCountUsed": sum(section["draws"][di]["indexCount"] for di in own),
            "trianglesInUsedRanges": sum(section["draws"][di]["indexCount"] // 3 for di in own),
            "trianglesHitCentre": hit_by_section.get(key, 0),
            "trianglesHitBand": band_by_section.get(key, 0),
            "arcStart": round(min(s["arcStart"] for s in span_centre), 4) if span_centre else None,
            "arcEnd": round(max(s["arcEnd"] for s in span_centre), 4) if span_centre else None,
            "metres": round(sum(s["metres"] for s in span_centre), 4),
            "draws": draws,
        })

    abss = [abs(v) for v in delta_values] or [0.0]
    widths_sorted = sorted(widths)
    def percentile(values, q):
        if not values:
            return 0.0
        pos = min(len(values) - 1, max(0, int(round(q * (len(values) - 1)))))
        return values[pos]

    samples_doc = {
        "kind": "drivable-path.visual-coverage-samples",
        "version": 1,
        "fields": ["arc", "x", "z", "collision", "delta", "section", "drawIndex",
                   "primitiveIndex", "triangleOffset", "coveredLeftMetres",
                   "coveredRightMetres", "centreCovered", "envelopeCovered",
                   "marginCovered", "drawsInBand"],
        "rows": rows,
    }

    manifest = {
        "kind": "drivable-path.visual-coverage",
        "version": 1,
        "scope": {
            "collisionOnly": False,
            "drawGeometryRead": True,
            "instancesApplied": False,
            "engineRun": False,
            "rendererClaim": False,
            "gameClaim": False,
            "note": ("first RenderList direct draws at source world positions; the visual "
                     "question is answered against the committed draw ranges, not against a "
                     "renderer, GPU, engine frame or game run"),
        },
        "inputs": {
            "path": str(PATH_JSON.relative_to(ROOT)).replace("\\", "/"),
            "pathHash": PATH_HASH,
            "pathBytes": len(path_bytes),
            "pathSha256": sha256_bytes(path_bytes),
            "visualMap": str(VISUAL_JSON.relative_to(ROOT)).replace("\\", "/"),
            "visualMapProducer": "probes/track-coverage/tools/build_reference.py",
            "visualMapSha256": visual_sha,
            "visualMapSections": len(visual_doc["sections"]),
            "visualMapOkSections": len(sections),
            "physics": str(PHYSICS.relative_to(ROOT)).replace("\\", "/"),
            "physicsSha256": PHYSICS_SHA256,
            "oracle": str(ORACLE.relative_to(ROOT)).replace("\\", "/"),
            "oracleSha256": sha256_bytes(ORACLE.read_bytes()),
            "levelMeshes": len(meshes),
            "collisionTriangles": len(collision),
            "visualTrianglesAllSections": len(visual),
        },
        "model": {
            "pathSampleStepMetres": 0.25,
            "collisionSurface": "highest triangle with normal.y > 0.5 containing the point",
            "visualSurface": "draw triangle with normal.y > 0.1 containing the point, nearest height to collision",
            "coverToleranceMetres": COVER_TOL,
            "coverRule": "|visual - collision| <= 0.5 m (symmetric, track-coverage rule)",
            "carWidthMetres": CAR_WIDTH,
            "safetyMarginMetres": SAFETY_MARGIN,
            "envelopeHalfWidthMetres": round(ENVELOPE_HALF, 4),
            "marginHalfWidthMetres": round(MARGIN_HALF, 4),
            "stationsMetres": [round(v, 4) for v in STATIONS],
            "envelopeStationsMetres": [round(v, 4) for v in ENVELOPE_STATIONS],
            "marginStationsMetres": [round(v, 4) for v in MARGIN_STATIONS],
            "widthScan": {"stepMetres": WIDTH_STEP, "capMetres": WIDTH_CAP,
                          "meaning": "symmetric covered run at 0.10 m steps, capped"},
        },
        "course": {
            "lengthMetres": round(length, 4),
            "start": [round(points[0][0], 4), round(points[0][1], 4)],
            "end": [round(points[-1][0], 4), round(points[-1][1], 4)],
            "samples": len(points),
            "sampleStepMetres": 0.25,
        },
        "coverage": {
            "samples": len(rows),
            "centreCovered": centre_covered,
            "envelopeCovered": envelope_covered,
            "marginCovered": margin_covered,
            "centreFraction": round(centre_covered / len(rows), 6),
            "envelopeFraction": round(envelope_covered / len(rows), 6),
            "marginFraction": round(margin_covered / len(rows), 6),
            "gapRuns": len(gaps),
            "gapTotalMetres": round(sum(g["metres"] for g in gaps), 4),
            "gapSamples": sum(g["samples"] for g in gaps),
            "stationFailures": {("%+g" % o): station_fail.get(o, 0) for o in STATIONS},
            "stationTests": len(rows) * len(STATIONS),
            "failureReasons": {
                "collisionMissing": reason.get("collisionMissing", 0),
                "visualMissing": reason.get("visualMissing", 0),
                "deltaOutOfTolerance": reason.get("deltaOutOfTolerance", 0),
            },
        },
        "delta": {
            "samples": len(delta_values),
            "min": round(min(delta_values), 6) if delta_values else None,
            "max": round(max(delta_values), 6) if delta_values else None,
            "mean": round(sum(delta_values) / len(delta_values), 6) if delta_values else None,
            "maxAbs": round(max(abss), 6),
            "countVisualAbove": sum(1 for v in delta_values if v > 0),
            "countVisualBelow": sum(1 for v in delta_values if v < 0),
            "countWithin1cm": sum(1 for v in delta_values if abs(v) <= 0.01),
        },
        "width": {
            "samples": len(widths),
            "min": round(widths_sorted[0], 2),
            "p05": round(percentile(widths_sorted, 0.05), 2),
            "median": round(percentile(widths_sorted, 0.5), 2),
            "max": round(widths_sorted[-1], 2),
            "mean": round(sum(widths) / len(widths), 2),
            "fullCapSamples": sum(1 for w in widths if w >= 2 * WIDTH_CAP - 1e-9),
            "leftMin": round(min(left_widths), 2),
            "rightMin": round(min(right_widths), 2),
        },
        "control": {
            "withoutUsedDraws": {
                "samples": len(points),
                "covered": without_used_draws,
                "fraction": round(without_used_draws / len(points), 6),
                "removed": sorted("%s#%d" % k for k in used_draw_keys),
                "meaning": ("centre coverage recomputed after removing the draws this probe "
                            "attributes to the course; it must fall, otherwise the attribution "
                            "does not carry the result"),
            },
            "withoutUsedSection": {
                "samples": len(points),
                "covered": without_section,
                "fraction": round(without_section / len(points), 6),
                "removed": sorted(used_section_keys),
                "meaning": ("centre coverage recomputed with every other draw section kept and "
                            "the attributed section(s) removed"),
            },
        },
        "segments": segments,
        "gaps": gaps,
        "firstGap": first_gap,
        "drawSpans": draw_spans,
        "sections": section_records,
        "totals": {
            "sectionsUsed": len(section_records),
            "drawsUsedCentre": sum(1 for (key, di), c in draw_centre_use.items() if c),
            "drawsUsedBand": sum(1 for (key, di), c in draw_band_use.items() if c),
            "drawIndexCountUsed": sum(
                section_by_key[key]["draws"][di]["indexCount"]
                for key in used_by_section for di in
                (used_by_section[key]["centre"] | used_by_section[key]["band"])),
            "trianglesInUsedRanges": sum(
                section_by_key[key]["draws"][di]["indexCount"] // 3
                for key in used_by_section for di in
                (used_by_section[key]["centre"] | used_by_section[key]["band"])),
            "trianglesTouchingCentre": len(triangles_hit),
            "trianglesTouchingBand": len(triangles_band),
        },
        "samplesFile": {
            "path": "_work/drivable-path/visual-coverage-samples.json",
            "fields": samples_doc["fields"],
        },
        "evidence": {
            "map": "_work/drivable-path/visual-coverage.svg",
            "html": "_work/drivable-path/visual-coverage.html",
            "png": "_work/drivable-path/visual-coverage.png",
        },
    }

    manifest_text = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    manifest["hash"] = "sha256:" + sha256_bytes(manifest_text.encode("utf-8"))
    (OUT / "visual-coverage.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    samples_text = json.dumps(samples_doc, sort_keys=False, separators=(",", ":"), ensure_ascii=False)
    (OUT / "visual-coverage-samples.json").write_text(samples_text, encoding="utf-8")

    print(json.dumps({
        "coverage": manifest["coverage"],
        "delta": manifest["delta"],
        "width": manifest["width"],
        "control": manifest["control"],
        "totals": manifest["totals"],
        "drawSpans": manifest["drawSpans"],
        "hash": manifest["hash"],
        "samplesSha256": sha256_bytes(samples_text.encode("utf-8")),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
