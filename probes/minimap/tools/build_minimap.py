"""Build per-map minimap geometry from measured track data.

Inputs (all committed, read-only):
  * `Level.levelphysics` collision meshes via the committed map-pipeline scanner
  * e1-drive sprint / sprint-lap layouts (River)
  * map-pipeline candidate layouts (Amboy, Gracia, Longbeach)
  * `_work/free-roam/grid.npz` P48 basin mask (River free mode)
  * Power-up placement decodes (River, Amboy, Gracia)

Outputs (`_work/minimap/`):
  <id>.json   geometry, projection, markers, hashes
  <id>.svg    vector preview
  <id>.png    raster preview (deterministic PNG encoder, 2x supersampled)
  marker-spec.json, index.json

Usage:
  python probes/minimap/tools/build_minimap.py [--only river-sprint]
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

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import minimap_lib as ml  # noqa: E402

REPO = ml.REPO
OUT = REPO / "_work" / "minimap"
LOG = REPO / "_work" / "logs" / "minimap"

COL = {
    "bg": (13, 17, 23),
    "track_fill": (38, 48, 62),
    "track_edge": (86, 104, 126),
    "centre": (150, 170, 190),
    "spawn": (90, 220, 255),
    "start": (90, 230, 130),
    "checkpoint": (250, 200, 80),
    "finish": (245, 245, 245),
    "pickup": (190, 120, 240),
    "basin_fill": (30, 40, 52),
    "basin_edge": (96, 128, 158),
}

PX = 512
BUDGET = {
    "river-sprint": 128,
    "river-lap": 96,
    "river-free": 160,
    "amboy": 256,
    "gracia": 128,
    "longbeach": 128,
}


# ---------------------------------------------------------------------------
# source loading
# ---------------------------------------------------------------------------

def _read_json(rel):
    path = REPO / rel
    raw = path.read_bytes()
    return json.loads(raw), {
        "path": rel.replace("\\", "/"),
        "bytes": len(raw),
        "sha256": ml.sha256_bytes(raw),
    }


def load_e1_path(rel):
    doc, rec = _read_json(rel)
    samples = doc["course"]["samples"]
    pts = [(s["x"], s["z"]) for s in samples]
    ground = [s.get("groundY") for s in samples]
    return pts, ground, doc, rec


def load_candidate_path(rel):
    doc, rec = _read_json(rel)
    pts = [(p["x"], p["z"]) for p in doc["course"]["points"]]
    ground = [p.get("h") for p in doc["course"]["points"]]
    return pts, ground, doc, rec


def nearest_on_path(points, arc, x, z):
    """Nearest arc position / tangent / distance of a world XZ point."""
    best = (float("inf"), 0.0, 0.0, 0.0)
    for i in range(len(points) - 1):
        ax, az = points[i]; bx, bz = points[i + 1]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz
        if L2 <= 0:
            continue
        t = ((x - ax) * dx + (z - az) * dz) / L2
        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
        px, pz = ax + t * dx, az + t * dz
        d = math.hypot(x - px, z - pz)
        if d < best[0]:
            L = math.sqrt(L2)
            best = (d, arc[i] + t * L, dx / L, dz / L)
    return best


# ---------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------

def build_track(points, ground, budget, closed, level, tri_cache,
                cap_half_m=ml.WIDTH_CAP_HALF_M):
    tris, counts, physics_sha = tri_cache[level]
    src_length = ml.polyline_length(points, closed=closed)
    b = ml.bounds_of(points)

    raster = ml.HeightRaster(b["minX"] - 20, b["minZ"] - 20,
                             b["maxX"] + 20, b["maxZ"] + 20)
    sel = tris[
        (tris[:, :, 0].max(axis=1) > b["minX"] - 30)
        & (tris[:, :, 0].min(axis=1) < b["maxX"] + 30)
        & (tris[:, :, 2].max(axis=1) > b["minZ"] - 30)
        & (tris[:, :, 2].min(axis=1) < b["maxZ"] + 30)]
    raster.build(sel)

    # width profile at 1 m for the summary
    prof_pts, prof_g, _ = ml.resample(points, ground, 1.0)
    band = ml.measure_band(raster, prof_pts, prof_g)
    full = band["halfFullM"] * 2.0

    # simplify
    simple, idx, tol = ml.fit_budget(points, budget, closed=closed)
    max_dev, mean_dev = ml.deviation(points, simple, closed=closed)
    arcs = ml.arc_lengths(points)

    # per-vertex width, measured exactly at the simplified stations
    v_ground = [ground[i] if ground[i] is not None else float("nan") for i in idx]
    vb = ml.measure_band(raster, simple, v_ground, step=ml.WIDTH_SAMPLE_STEP_M)
    half_full = vb["halfFullM"]
    half = np.minimum(half_full, cap_half_m)

    outline = ml.ribbon_outline(simple, half, closed=closed)
    outer = [tuple(p) for p in outline["outer"]]
    self_x = ml.count_self_intersections(outer)

    path = {
        "kind": "measured-centre-line",
        "closed": bool(closed),
        "closedByRepeat": bool(closed),
        "points": ml.qpts(simple),
        "vertices": len(simple) - (1 if closed else 0),
        "verticesListed": len(simple),
        "sourceSamples": len(points),
        "sourceStepM": ml.q(float(np.median(
            [math.hypot(b[0] - a[0], b[1] - a[1])
             for a, b in zip(points, points[1:])]))),
        "sourceLengthM": ml.q(src_length),
        "lengthM": ml.q(ml.polyline_length(simple, closed=closed)),
        "arcM": [ml.q(arcs[i]) for i in idx],
        "vertexBudget": int(budget),
        "simplifySignificanceDroppedM": ml.q(tol),
        "maxDeviationM": ml.q(max_dev),
        "meanDeviationM": ml.q(mean_dev),
        "width": {
            "halfWidthM": [ml.q(v) for v in half],
            "halfWidthFullM": [ml.q(v) for v in half_full],
            "capHalfM": ml.q(cap_half_m),
            "capSource": "display constant; 12 m matches P51's scan cap, "
                         "the lap uses half of its measured 11.75 m clearance band",
            "sampleStepM": ml.WIDTH_SAMPLE_STEP_M,
            "crossSlopeToleranceM": ml.WIDTH_TOL_M,
            "rasterCellM": ml.GRID_CELL_M,
            "minFullM": ml.q(float(full.min())),
            "medianFullM": ml.q(float(np.median(full))),
            "maxFullM": ml.q(float(full.max())),
            "cappedStations": int((half_full >= cap_half_m).sum()),
            "profileStations": int(len(full)),
            "centreMissingStations": int(band["centreMissingStations"]),
            "note": "halfWidthFullM is the measured drivable-surface run within "
                    "crossSlopeToleranceM; halfWidthM is display-clamped to "
                    "capHalfM. Raster resolution applies.",
        },
    }

    outline_json = {
        "type": outline["type"],
        "outer": outline["outer"],
        "hole": outline["hole"],
        "selfIntersections": int(self_x),
        "clampedVertices": int(outline["clampedVertices"]),
        "note": "Centre-line offset by the measured display half width, corner-"
                "clamped. Derived, not hand-drawn.",
    }

    return {
        "path": path,
        "outline": outline_json,
        "bounds": dict(b, widthM=ml.q(b["maxX"] - b["minX"]),
                       depthM=ml.q(b["maxZ"] - b["minZ"]),
                       aspect=ml.q(max(b["maxX"] - b["minX"], b["maxZ"] - b["minZ"]) /
                                   max(1e-9, min(b["maxX"] - b["minX"], b["maxZ"] - b["minZ"])))),
        "physics": {"triangles": counts, "sha256": physics_sha},
        "rasterTriangles": int(len(sel)),
    }


def build_basin():
    grid_path = REPO / "_work" / "free-roam" / "grid.npz"
    raw = grid_path.read_bytes()
    z = np.load(grid_path, allow_pickle=False)
    xs, zs, labels = z["xs"], z["zs"], z["labels_p48"]
    cell = float(xs[1] - xs[0])
    ix = int(round((-88.0 - xs[0]) / cell)); iz = int(round((1050.0 - zs[0]) / cell))
    label = int(labels[iz, ix])
    mask = labels == label
    cells = int(mask.sum())
    rings = ml.mask_rings(mask, float(xs[0]), float(zs[0]), cell)
    scored = sorted(((abs(ml.ring_area(r)), i) for i, r in enumerate(rings)),
                    reverse=True)
    outer_raw = rings[scored[0][1]]
    simple, idx, tol = ml.fit_budget(outer_raw, BUDGET["river-free"], closed=True)
    max_dev, mean_dev = ml.deviation(outer_raw, simple, closed=True)
    holes = []
    hole_specks = 0
    for area, i in scored[1:]:
        if area >= 1.0:
            h, hi, ht = ml.fit_budget(rings[i], 24, closed=True)
            hd, _ = ml.deviation(rings[i], h, closed=True)
            holes.append({
                "points": ml.qpts(h), "vertices": len(h),
                "areaM2": ml.q(abs(ml.ring_area(h))),
                "maxDeviationM": ml.q(hd),
                "simplifyToleranceM": ml.q(ht),
            })
        else:
            hole_specks += 1
    b = ml.bounds_of(simple)
    return {
        "basin": {
            "kind": "drivable-basin",
            "source": "P48 2-cell car-clearance mask, free-roam labels_p48",
            "maskLabel": label,
            "cells": cells,
            "cellM": cell,
            "areaM2": ml.q(cells * cell * cell),
            "polygonAreaM2": ml.q(abs(ml.ring_area(simple))),
            "perimeterM": ml.q(ml.polyline_length(simple, closed=True)),
            "vertices": len(simple) - 1,
            "verticesListed": len(simple),
            "vertexBudget": BUDGET["river-free"],
            "simplifySignificanceDroppedM": ml.q(tol),
            "maxDeviationM": ml.q(max_dev),
            "meanDeviationM": ml.q(mean_dev),
            "points": ml.qpts(simple),
            "holes": holes,
            "holeSpecksDropped": hole_specks,
            "note": "Outer boundary traced on the 0.5 m mask and simplified; "
                    "holes below 1 m2 are recorded as dropped specks.",
        },
        "bounds": dict(b, widthM=ml.q(b["maxX"] - b["minX"]),
                       depthM=ml.q(b["maxZ"] - b["minZ"]),
                       aspect=ml.q(max(b["maxX"] - b["minX"], b["maxZ"] - b["minZ"]) /
                                   max(1e-9, min(b["maxX"] - b["minX"], b["maxZ"] - b["minZ"])))),
        "sourceRecord": {
            "path": "_work/free-roam/grid.npz",
            "bytes": len(raw),
            "sha256": ml.sha256_bytes(raw),
        },
    }


# ---------------------------------------------------------------------------
# markers
# ---------------------------------------------------------------------------

def marker_record(proj, x, z, heading=None, extra=None):
    mx, my = ml.project(proj, x, z)
    w = proj["viewport"]["w"]; h = proj["viewport"]["h"]
    inside = 0.0 <= mx <= w and 0.0 <= my <= h
    rec = {
        "world": [ml.q(x), ml.q(z)],
        "map": [ml.q(mx), ml.q(my)],
        "insideViewport": bool(inside),
    }
    if heading is not None:
        rec["headingRad"] = ml.q(heading)
        dx, dy, ca = ml.heading_to_screen(heading, proj["rotationRad"])
        rec["screenDir"] = [ml.q(dx), ml.q(dy)]
        rec["canvasAngleRad"] = ml.q(ca)
    if extra:
        rec.update(extra)
    return rec


def load_pickups(rel, level, proj):
    path = REPO / rel
    if not path.exists():
        return {"available": False,
                "reason": "no PickupPosition placement decode for %s" % level}
    doc, rec = _read_json(rel)
    if "placements" in doc:
        rows = doc["placements"]
        route = doc.get("authority", {}).get("route")
    else:
        route = doc["authority"]["routes"][0]
        rows = route["placements"]
    items = []
    inside = 0
    for p in rows:
        pos = p["position"]
        m = marker_record(proj, pos["x"], pos["z"], extra={
            "uid": int(p["uid"]),
            "type": p.get("name"),
            "onMeasuredPath": bool((p.get("onMeasuredPath") or {}).get("withinPickupRadius")
                                   or p.get("onMeasuredArc", {}).get("withinPickupRadius")
                                   or False),
        })
        inside += 1 if m["insideViewport"] else 0
        items.append(m)
    radius = doc.get("collectionModel", {}).get("pickupRadiusMetres")
    return {
        "available": True,
        "count": len(items),
        "insideViewport": inside,
        "routeRecordId": route.get("recordId") if isinstance(route, dict) else None,
        "pickupRadiusM": radius,
        "items": items,
        "source": rec,
        "note": "Recovered PickupPosition placements; not an icon or art claim.",
    }


def gates_from_e1(doc, proj):
    out = {"start": None, "checkpoints": [], "finish": None}
    for g in doc["gates"]:
        rec = marker_record(proj, g["x"], g["z"], g.get("headingRad"), {
            "id": g["id"], "kind": g["kind"], "arcM": ml.q(g["arc"]),
            "gateWidthM": ml.q(g.get("widthMetres", 0.0)),
        })
        if g["kind"] == "start":
            out["start"] = rec
        elif g["kind"] == "finish":
            out["finish"] = rec
        else:
            out["checkpoints"].append(rec)
    return out


def gates_from_layout(doc, proj, points, arc):
    course = doc["course"]
    spawn = doc["spawn"]
    out = {"start": None, "checkpoints": [], "finish": None}
    sp = marker_record(proj, spawn["x"], spawn["z"], spawn.get("heading"),
                       {"id": "start", "kind": "start", "arcM": 0.0,
                        "gateWidthM": None, "headingSource": "measured spawn heading"})
    out["start"] = sp
    for i, cp in enumerate(course["checkpoints"]):
        d, s, tx, tz = nearest_on_path(points, arc, cp["x"], cp["z"])
        out["checkpoints"].append(marker_record(
            proj, cp["x"], cp["z"], math.atan2(tx, tz), {
                "id": "checkpoint-%d" % (i + 1), "kind": "checkpoint",
                "arcM": ml.q(s), "gateWidthM": None,
                "offsetFromPathM": ml.q(d),
                "headingSource": "path tangent at projected arc",
            }))
    fin = course["finish"]
    d, s, tx, tz = nearest_on_path(points, arc, fin["x"], fin["z"])
    out["finish"] = marker_record(proj, fin["x"], fin["z"], math.atan2(tx, tz), {
        "id": "finish", "kind": "finish", "arcM": ml.q(s), "gateWidthM": None,
        "offsetFromPathM": ml.q(d),
        "headingSource": "path tangent at projected arc",
    })
    return out


# ---------------------------------------------------------------------------
# previews
# ---------------------------------------------------------------------------

def draw_preview(doc, png_path, svg_path):
    proj = doc["projection"]
    w = proj["viewport"]["w"]; h = proj["viewport"]["h"]
    cv = ml.Canvas(w, h, COL["bg"])
    svg = []
    mode = doc["map"]["mode"]

    basin = doc.get("basin")
    if basin:
        ring = [ml.project(proj, p[0], p[1]) for p in basin["points"]]
        cv.polygon(ring, COL["basin_fill"])
        cv.polyline(ring, COL["basin_edge"], 1.5, closed=True)
        svg.append('<path d="%s" fill="#1e2834" stroke="#60809e" stroke-width="1.5"/>'
                   % ml.svg_path_d(ring, True))
        for hole in basin["holes"]:
            hr = [ml.project(proj, p[0], p[1]) for p in hole["points"]]
            cv.polygon(hr, COL["bg"])
            cv.polyline(hr, COL["basin_edge"], 1.0, closed=True)
            svg.append('<path d="%s" fill="#0d1117" stroke="#60809e" stroke-width="1"/>'
                       % ml.svg_path_d(hr, True))

    path = doc.get("path")
    if path:
        pts = [ml.project(proj, p[0], p[1]) for p in path["points"]]
        outline = doc["outline"]
        outer = [ml.project(proj, p[0], p[1]) for p in outline["outer"]]
        cv.polygon(outer, COL["track_fill"])
        if outline.get("hole"):
            hole = [ml.project(proj, p[0], p[1]) for p in outline["hole"]]
            cv.polygon(hole, COL["bg"])
        cv.polyline(pts, COL["centre"], 1.0, closed=path["closed"])
        svg.append('<path d="%s" fill="#26303e" stroke="none"/>' % ml.svg_path_d(outer, True))
        svg.append('<path d="%s" fill="none" stroke="#96aabe" stroke-width="1"/>'
                   % ml.svg_path_d(pts, path["closed"]))

    markers = doc["markers"]
    for item in markers["pickups"].get("items", []):
        if not item["insideViewport"]:
            continue
        cv.dot(item["map"], COL["pickup"], 2.5)
        svg.append('<circle cx="%.2f" cy="%.2f" r="2.5" fill="#be78f0"/>' % tuple(item["map"]))

    for cp in markers["checkpoints"]:
        if cp["insideViewport"]:
            cv.ring(cp["map"], COL["checkpoint"], 5.0, 1.5)
            svg.append('<circle cx="%.2f" cy="%.2f" r="5" fill="none" stroke="#fac850" '
                       'stroke-width="1.5"/>' % tuple(cp["map"]))

    for key, col, r in (("start", COL["start"], 4.5), ("finish", COL["finish"], 4.0)):
        mk = markers.get(key)
        if mk and mk["insideViewport"]:
            cv.dot(mk["map"], col, r)
            svg.append('<circle cx="%.2f" cy="%.2f" r="%.1f" fill="%s"/>'
                       % (mk["map"][0], mk["map"][1], r,
                          "#5ae682" if key == "start" else "#f5f5f5"))

    sp = markers.get("spawn")
    if sp and sp["insideViewport"]:
        cv.ring(sp["map"], COL["spawn"], 7.0, 1.5)
        cv.triangle(sp["map"], COL["spawn"], 5.0,
                    sp.get("screenDir", (0.0, 1.0))[:2])
        svg.append('<circle cx="%.2f" cy="%.2f" r="7" fill="none" stroke="#5adcff" '
                   'stroke-width="1.5"/>' % tuple(sp["map"]))

    cv.polyline([(0.5, 0.5), (w - 0.5, 0.5), (w - 0.5, h - 0.5), (0.5, h - 0.5)],
                (60, 72, 86), 1.0, closed=True)
    ml.write_png(png_path, cv.finish())
    svg_path = Path(svg_path)
    svg_path.write_text(ml.svg_doc(w, h, svg), encoding="utf-8")


# ---------------------------------------------------------------------------
# map table
# ---------------------------------------------------------------------------

MAPS = [
    {
        "id": "river-sprint", "level": "usa_la_river", "name": "USA LA River",
        "mode": "sprint", "label": "310 m sprint",
        "loader": ("e1", "_work/e1-drive/sprint.json"),
        "pickups": "_work/powerups/placements.json",
        "documented": {"lengthM": 310.395196, "finishArcM": 300.159666,
                       "checkpointArcsM": [100.107736, 200.074803],
                       "lengthSource": "docs/work/analysis/drivable-path.md"},
        "laps": None,
    },
    {
        "id": "river-lap", "level": "usa_la_river", "name": "USA LA River",
        "mode": "lap", "label": "222 m loop (loop-01)",
        "loader": ("e1", "_work/e1-drive/sprint-lap.json"),
        "pickups": "_work/powerups/placements.json",
        "documented": {"lengthM": 222.040211, "finishArcM": 222.040211,
                       "checkpointArcsM": [], "laps": 3,
                       "lengthSource": "docs/work/analysis/lap-search.md"},
        "laps": 3,
        "capHalfM": 6.0,
    },
    {
        "id": "river-free", "level": "usa_la_river", "name": "USA LA River",
        "mode": "free", "label": "spawn basin (free roam)",
        "loader": ("e1", "_work/e1-drive/sprint.json"),
        "pickups": "_work/powerups/placements.json",
        "documented": {"lengthM": None, "basinAreaM2": 9689.5,
                       "lengthSource": "docs/work/analysis/free-roam.md"},
        "laps": None,
    },
    {
        "id": "amboy", "level": "usa_amboy", "name": "USA Amboy",
        "mode": "sprint", "label": "2,060.6 m point-to-point",
        "loader": ("candidate", "_work/map-pipeline/candidates/usa_amboy.layout.json"),
        "pickups": "_work/powerups/placements-amboy.json",
        "documented": {"lengthM": 2060.59538,
                       "checkpointArcsM": [686.8623, 1373.6673],
                       "finishArcM": 2060.59538,
                       "lengthSource": "docs/work/analysis/map-slice-amboy.md"},
        "laps": None,
    },
    {
        "id": "gracia", "level": "spa_barcelona_gracia", "name": "Spa Barcelona Gracia",
        "mode": "sprint", "label": "624.9 m point-to-point",
        "loader": ("candidate", "_work/map-pipeline/candidates/spa_barcelona_gracia.layout.json"),
        "pickups": "_work/powerups/placements-gracia.json",
        "documented": {"lengthM": 624.91378,
                       "checkpointArcsM": [208.343397, 416.652055],
                       "finishArcM": 624.91378,
                       "lengthSource": "docs/work/analysis/map-slice-gracia.md"},
        "laps": None,
    },
    {
        "id": "longbeach", "level": "usa_la_longbeachdocks", "name": "USA LA Longbeach Docks",
        "mode": "sprint", "label": "818.4 m point-to-point",
        "loader": ("candidate", "_work/map-pipeline/candidates/usa_la_longbeachdocks.layout.json"),
        "pickups": None,
        "documented": {"lengthM": 818.371716,
                       "checkpointArcsM": [272.892714, 545.610534],
                       "finishArcM": 818.371716,
                       "lengthSource": "docs/work/analysis/map-slice-longbeach.md"},
        "laps": None,
    },
]


def marker_spec():
    return {
        "schema": ml.MARKER_SCHEMA,
        "coordinateSpace": {
            "units": "pixels",
            "origin": "top-left",
            "axis": "+x right = world +X, +y down = world +Z",
            "note": "World-aligned. No compass claim; the retail map orientation is unknown.",
        },
        "transform": {
            "inputs": ["projection.scalePxPerM", "projection.worldCentre",
                       "projection.mapCentre", "projection.rotationRad"],
            "worldToMap": "mapX = mapCentre.x + scale*(worldX-worldCentre.x); "
                          "mapY = mapCentre.y + scale*(worldZ-worldCentre.y)",
            "rotation": "apply rotationRad about mapCentre before clamping if used",
        },
        "heading": {
            "worldConvention": "atan2(dx, dz) in radians; 0 = +Z, +pi/2 = +X (clockwise from +Z)",
            "screenDirection": "a = headingRad - rotationRad; (dx, dy) = (sin a, cos a)",
            "canvasAngleRad": "atan2(dy, dx) for ctx.rotate; 0 points +x on the canvas",
            "note": "The chevron art must be authored pointing +x and rotated by canvasAngleRad.",
        },
        "clamping": {
            "method": "clamp the projected point into the viewport inset by markerRadiusPx",
            "insetPx": 6,
            "clampedFlag": "offMap = (clamped != raw)",
            "keepHeading": True,
            "reason": "A rival 2 km away must stay visible at the border, not vanish.",
        },
        "layers": {
            "order": ["pickups", "ai", "remote", "player"],
            "note": "Player is drawn last so it is never hidden.",
        },
        "styles": {
            "player": {"shape": "chevron", "sizePx": 7, "fill": "--minimap-player",
                       "stroke": "--minimap-player-outline", "strokeWidthPx": 1.5,
                       "heading": True, "z": 30},
            "ai": {"shape": "circle", "sizePx": 5, "fill": "--minimap-ai",
                   "stroke": None, "strokeWidthPx": 0, "heading": False, "z": 20},
            "remote": {"shape": "ring", "sizePx": 6, "fill": None,
                       "stroke": "--minimap-remote", "strokeWidthPx": 2,
                       "heading": True, "z": 25},
        },
        "events": {
            "start": {"shape": "disc", "sizePx": 4.5, "colour": "--minimap-start"},
            "checkpoint": {"shape": "ring", "sizePx": 5, "colour": "--minimap-checkpoint"},
            "finish": {"shape": "disc", "sizePx": 4.0, "colour": "--minimap-finish"},
            "spawn": {"shape": "ring+chevron", "sizePx": 7, "colour": "--minimap-spawn"},
            "pickup": {"shape": "dot", "sizePx": 2.5, "colour": "--minimap-pickup"},
        },
        "updateRate": {
            "geometryHz": 0,
            "markerHz": 20,
            "note": "Geometry is static per map; markers follow the 20 Hz pose snapshot "
                    "from the race rules integration (docs/work/analysis/race-rules.md §6).",
        },
        "notes": [
            "Shapes are neutral primitives, not retail icon art.",
            "Retail HUD/UI icons come from the UI-art streams (see _work/hud/ui_textures_dump.txt); "
            "they are not decoded, extracted or imitated here.",
            "Colour tokens are CSS custom-property names; no palette value is invented as retail.",
        ],
    }


def build_one(spec, tri_cache):
    t0 = time.time()
    kind, rel = spec["loader"]
    if kind == "e1":
        points, ground, src_doc, src_rec = load_e1_path(rel)
    else:
        points, ground, src_doc, src_rec = load_candidate_path(rel)

    if spec["level"] not in tri_cache:
        tri_cache[spec["level"]] = ml.load_surface_triangles(spec["level"])

    closed = spec["mode"] == "lap"
    track = build_track(points, ground, BUDGET[spec["id"]], closed, spec["level"],
                        tri_cache, cap_half_m=spec.get("capHalfM", ml.WIDTH_CAP_HALF_M))
    arcs = ml.arc_lengths(points)

    if spec["mode"] == "free":
        basin = build_basin()
        geometry_bounds = basin["bounds"]
        path_json = None
        outline_json = None
        basin_json = basin["basin"]
        path_bounds = None
    else:
        path_bounds = track["bounds"]
        path_json = track["path"]
        outline_json = track["outline"]
        basin_json = None
        geometry_bounds = ml.bounds_of(outline_json["outer"])
        geometry_bounds.update({
            "widthM": ml.q(geometry_bounds["maxX"] - geometry_bounds["minX"]),
            "depthM": ml.q(geometry_bounds["maxZ"] - geometry_bounds["minZ"]),
            "aspect": ml.q(max(geometry_bounds["maxX"] - geometry_bounds["minX"],
                               geometry_bounds["maxZ"] - geometry_bounds["minZ"]) /
                           max(1e-9, min(geometry_bounds["maxX"] - geometry_bounds["minX"],
                                         geometry_bounds["maxZ"] - geometry_bounds["minZ"]))),
        })

    proj = ml.make_projection(geometry_bounds, PX, PX, pad_frac=0.06)
    rot = ml.principal_axis(points if spec["mode"] != "free"
                            else [(p[0], p[1]) for p in basin_json["points"]])
    rb = ml.rotated_bounds(points if spec["mode"] != "free"
                           else [(p[0], p[1]) for p in basin_json["points"]], rot)

    spawn = src_doc.get("spawn") or src_doc["course"].get("spawn")
    if spec["mode"] == "free":
        spawn_x, spawn_z = -88.0, 1050.0
        spawn_heading = src_doc["gates"][0]["headingRad"]
    else:
        spawn_x = spawn["x"]; spawn_z = spawn["z"]
        spawn_heading = spawn.get("heading", spawn.get("headingRad"))
        if spawn_heading is None:
            # River sprint/lap carry the spawn heading on the start gate.
            start_gate = next((g for g in src_doc.get("gates", [])
                               if g.get("kind") == "start"), None)
            spawn_heading = start_gate.get("headingRad") if start_gate else None

    if spec["mode"] == "free":
        gates = {"start": None, "checkpoints": [], "finish": None}
    elif kind == "e1":
        gates = gates_from_e1(src_doc, proj)
    else:
        gates = gates_from_layout(src_doc, proj, points, arcs)

    spawn_rec = marker_record(proj, spawn_x, spawn_z, spawn_heading)

    markers = {
        "spawn": spawn_rec,
        "start": gates["start"],
        "checkpoints": gates["checkpoints"],
        "finish": gates["finish"],
        "pickups": (load_pickups(spec["pickups"], spec["level"], proj)
                    if spec["pickups"] else
                    {"available": False,
                     "reason": "no PickupPosition placement decode for %s" % spec["level"]}),
    }

    if spec["mode"] == "free":
        mode_block = {
            "kind": "free", "shows": "basin", "closed": True,
            "note": "Shows the P48 drivable basin around the spawn, not a race segment.",
        }
    elif spec["mode"] == "lap":
        mode_block = {
            "kind": "lap", "shows": "loop", "closed": True,
            "laps": spec["laps"],
            "lapLengthM": ml.q(ml.polyline_length(points, closed=True)),
            "startFinishShared": True,
            "note": "Start and finish share one physical line; three laps.",
        }
    else:
        mode_block = {
            "kind": "sprint", "shows": "segment", "closed": False,
            "startArcM": 0.0,
            "finishArcM": ml.q(spec["documented"].get("finishArcM") or 0.0),
            "note": "One-way segment; the measured surface past the finish line is kept "
                    "and the finish is marked at its measured arc.",
        }

    doc = {
        "schema": ml.SCHEMA,
        "id": spec["id"],
        "map": {"level": spec["level"], "name": spec["name"],
                "mode": spec["mode"], "label": spec["label"]},
        "scope": {
            "geometryDerivedFrom": "measured collision drivable surface + measured centre line",
            "handDrawn": False,
            "retailOrientationKnown": False,
            "rendererClaim": False,
            "browserClaim": False,
            "note": "Data + preview only. No retail minimap texture, icon or layout is claimed.",
        },
        "mode": mode_block,
        "sources": [
            {"role": "centre-line", **src_rec},
            {"role": "collision", "level": spec["level"],
             "triangles": track["physics"]["triangles"],
             "sha256": track["physics"]["sha256"]},
        ],
        "path": path_json,
        "outline": outline_json,
        "basin": basin_json,
        "bounds": geometry_bounds,
        "pathBounds": path_bounds,
        "projection": proj,
        "rotatedFit": rb,
        "layout": {
            "aspect": geometry_bounds["aspect"],
            "longThin": bool(geometry_bounds["aspect"] > 4.0),
            "recommendedRotationRad": ml.q(rot),
            "note": "rotationRad is a consumer choice; the emitted projection is world-aligned "
                    "(rotationRad 0). rot fit bounds are supplied for a long-thin layout.",
        },
        "markers": markers,
        "markerSpec": {"schema": ml.MARKER_SCHEMA, "ref": "_work/minimap/marker-spec.json"},
        "documented": spec["documented"],
        "hashes": {},
    }

    # canonical hash over the body without the hashes block
    body = {k: v for k, v in doc.items() if k != "hashes"}
    doc["hashes"] = {"canonical": ml.canonical_hash(body),
                     "canonicalRule": "sha256 of sorted-key compact JSON, body excluding hashes"}

    OUT.mkdir(parents=True, exist_ok=True)
    png_path = OUT / (spec["id"] + ".png")
    svg_path = OUT / (spec["id"] + ".svg")
    draw_preview(doc, png_path, svg_path)

    json_path = OUT / (spec["id"] + ".json")
    json_path.write_text(json.dumps(doc, indent=1, sort_keys=False) + "\n",
                         encoding="utf-8")
    doc["_file"] = {
        "json": {"path": json_path.relative_to(REPO).as_posix(),
                 "bytes": json_path.stat().st_size,
                 "sha256": ml.sha256_file(json_path)},
        "svg": {"path": svg_path.relative_to(REPO).as_posix(),
                "bytes": svg_path.stat().st_size,
                "sha256": ml.sha256_file(svg_path)},
        "png": {"path": png_path.relative_to(REPO).as_posix(),
                "bytes": png_path.stat().st_size,
                "sha256": ml.sha256_file(png_path)},
    }
    print("%-14s %5.1fs  vertices=%3d  dev=%6.3f m  len=%9.3f m" % (
        spec["id"], time.time() - t0,
        (path_json or basin_json)["vertices"],
        (path_json or basin_json)["maxDeviationM"],
        (path_json or basin_json).get("lengthM", basin_json and basin_json["perimeterM"]) or 0.0))
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None)
    args = ap.parse_args(argv)
    OUT.mkdir(parents=True, exist_ok=True)
    LOG.mkdir(parents=True, exist_ok=True)

    tri_cache = {}
    docs = []
    for spec in MAPS:
        if args.only and spec["id"] != args.only:
            continue
        docs.append(build_one(spec, tri_cache))

    spec = marker_spec()
    spec_path = OUT / "marker-spec.json"
    spec_path.write_text(json.dumps(spec, indent=1) + "\n", encoding="utf-8")

    index = {
        "schema": "blur.minimap.index/1",
        "maps": [{"id": d["id"], "map": d["map"], "mode": d["mode"]["kind"],
                  "canonical": d["hashes"]["canonical"],
                  "files": d["_file"]} for d in docs],
        "markerSpec": {"path": spec_path.relative_to(REPO).as_posix(),
                       "bytes": spec_path.stat().st_size,
                       "sha256": ml.sha256_file(spec_path)},
    }
    if not args.only:
        (OUT / "index.json").write_text(json.dumps(index, indent=1) + "\n",
                                        encoding="utf-8")
    print("wrote", ", ".join(d["id"] for d in docs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
