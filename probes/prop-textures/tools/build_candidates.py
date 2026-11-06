"""Build the deterministic P72a prop-texture candidate manifest.

Read-only inputs:
  * `_work/e1-drive/geometry.json` (geometry v6: 22 level prop draws + 394 track draws)
  * `_work/e1-drive/track-textures.json` + `track-uv.bin` + `textures/*.rgba`
  * `_work/prop-textures/level-props.json` (extract_level_props.py output)
  * `_work/prop-collision/colliders.json`, `_work/free-roam-prop/colliders-r04.json`
  * `_work/e1-drive/packet.json` (committed 301-tick default-car camera timeline)

Outputs (never committed):
  * `_work/prop-textures/candidates.json`
  * `_work/prop-textures/summary.json`

The screen-area proxy is a geometric projection of the committed world triangles
through the committed packet cameras. It is not a GPU render: no depth test, no
occlusion, no backface cull (the committed consumer uses cullMode:'none'), and the
triangle-area sum double-counts overlapping geometry. The unique-coverage raster
is the primary proxy; the triangle sum is reported as an upper bound.
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
GEOMETRY = ROOT / '_work/e1-drive/geometry.json'
TRACK_TEXTURES = ROOT / '_work/e1-drive/track-textures.json'
TRACK_UV = ROOT / '_work/e1-drive/track-uv.bin'
TRACK_TEX_DIR = ROOT / '_work/e1-drive/textures'
LEVEL_PROPS = ROOT / '_work/prop-textures/level-props.json'
PC66 = ROOT / '_work/prop-collision/colliders.json'
PC68 = ROOT / '_work/free-roam-prop/colliders-r04.json'
PACKET = ROOT / '_work/e1-drive/packet.json'
OUT = ROOT / '_work/prop-textures/candidates.json'
SUMMARY = ROOT / '_work/prop-textures/summary.json'

VIEWPORT = (1600, 900)
GRID = (320, 180)
CAMERA_TICKS = tuple(range(0, 301, 10))
LEVEL_PROP_TICKS = (0, 60, 90, 120, 150)
PLACEMENT_TICKS = (0, 30, 60, 90, 120, 150)
TRACK_TICKS = (0, 150, 240, 300)

STATUS_BOUND = 'bound-static-albedo'
STATUS_RUNTIME = 'runtimeOnlyAlbedoParameter'
STATUS_NO_BINDING = 'noBindingRowForSection'


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_json(obj) -> str:
    return 'sha256:' + sha256_bytes(json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))


def load_json(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT)).replace('\\', '/')


def rnd(value: float, digits: int = 6) -> float:
    return float(round(float(value), digits))


def section_of(draw_id: str) -> str:
    return draw_id.split('.draw.')[0] if '.draw.' in draw_id else draw_id.split('.instance')[0]


# ---------------------------------------------------------------- screen proxy

def view_proj(camera: dict) -> np.ndarray:
    view = np.array(camera['view'], dtype=np.float64).reshape(4, 4).T
    projection = np.array(camera['projection'], dtype=np.float64).reshape(4, 4).T
    return projection @ view


def triangle_area_ndc(ndc: np.ndarray) -> float:
    """Area of one triangle clipped to the [-1,1]^2 NDC square."""
    poly = [tuple(ndc[0]), tuple(ndc[1]), tuple(ndc[2])]
    for axis, bound, keep in ((0, -1.0, True), (0, 1.0, False), (1, -1.0, True), (1, 1.0, False)):
        out = []
        n = len(poly)
        for i in range(n):
            a = poly[i]
            b = poly[(i + 1) % n]
            va = a[axis] - bound
            vb = b[axis] - bound
            ina = va >= 0 if keep else va <= 0
            inb = vb >= 0 if keep else vb <= 0
            if ina:
                out.append(a)
            if ina != inb:
                t = va / (va - vb)
                out.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
        poly = out
    if len(poly) < 3:
        return 0.0
    s = 0.0
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % len(poly)]
        s += x1 * y2 - x2 * y1
    return abs(s) * 0.5


def projected_area(tris: np.ndarray, vp: np.ndarray) -> float:
    """Sum of projected triangle areas in pixels (clipped to the viewport)."""
    n = tris.shape[0]
    if n == 0:
        return 0.0
    hom = np.concatenate([tris, np.ones((n, 3, 1))], axis=2)
    clip = hom @ vp.T
    w = clip[:, :, 3]
    z = clip[:, :, 2] / np.where(np.abs(w) > 1e-12, w, 1.0)
    ok = np.all((w > 1e-6) & (z >= 0.0) & (z <= 1.0), axis=1)
    if not ok.any():
        return 0.0
    c = clip[ok]
    ndc = c[:, :, :2] / c[:, :, 3:4]
    x = ndc[:, :, 0]
    y = ndc[:, :, 1]
    cross = (x[:, 1] - x[:, 0]) * (y[:, 2] - y[:, 0]) - (x[:, 2] - x[:, 0]) * (y[:, 1] - y[:, 0])
    area = 0.5 * np.abs(cross)
    inside = np.all((ndc >= -1.0) & (ndc <= 1.0), axis=(1, 2))
    total = float(area[inside].sum())
    for tri in ndc[~inside]:
        total += triangle_area_ndc(tri)
    return total * (VIEWPORT[0] * VIEWPORT[1] / 4.0)


def coverage_fraction(tris: np.ndarray, vp: np.ndarray) -> float:
    """Fraction of a 320x180 grid covered by the projected triangles (no depth)."""
    n = tris.shape[0]
    if n == 0:
        return 0.0
    hom = np.concatenate([tris, np.ones((n, 3, 1))], axis=2)
    clip = hom @ vp.T
    w = clip[:, :, 3]
    z = clip[:, :, 2] / np.where(np.abs(w) > 1e-12, w, 1.0)
    ok = np.all((w > 1e-6) & (z >= 0.0) & (z <= 1.0), axis=1)
    if not ok.any():
        return 0.0
    c = clip[ok]
    ndc = c[:, :, :2] / c[:, :, 3:4]
    px = (ndc[:, :, 0] * 0.5 + 0.5) * GRID[0]
    py = (1.0 - (ndc[:, :, 1] * 0.5 + 0.5)) * GRID[1]
    mask = np.zeros((GRID[1], GRID[0]), dtype=bool)
    width, height = GRID
    for i in range(px.shape[0]):
        xs = px[i]
        ys = py[i]
        x0 = max(0, int(math.floor(xs.min())))
        x1 = min(width - 1, int(math.ceil(xs.max())))
        y0 = max(0, int(math.floor(ys.min())))
        y1 = min(height - 1, int(math.ceil(ys.max())))
        if x1 < x0 or y1 < y0:
            continue
        xx, yy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        ax, ay = xs[0], ys[0]
        bx, by = xs[1], ys[1]
        cx, cy = xs[2], ys[2]
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-12:
            continue
        wa = ((by - cy) * (xx - cx) + (cx - bx) * (yy - cy)) / den
        wb = ((cy - ay) * (xx - cx) + (ax - cx) * (yy - cy)) / den
        wc = 1.0 - wa - wb
        inside = (wa >= -1e-9) & (wb >= -1e-9) & (wc >= -1e-9)
        mask[y0:y1 + 1, x0:x1 + 1] |= inside
    return float(mask.mean())


def screen_for_draw(tris: np.ndarray, vps: dict[int, np.ndarray], coverage_ticks) -> dict:
    total = 0.0
    peak = 0.0
    peak_tick = None
    for tick in sorted(vps):
        area = projected_area(tris, vps[tick])
        total += area
        if area > peak:
            peak = area
            peak_tick = tick
    coverage = {}
    for tick in coverage_ticks:
        if tick in vps:
            coverage[str(tick)] = rnd(coverage_fraction(tris, vps[tick]), 8)
    peak_cov = max(coverage.values()) if coverage else 0.0
    peak_cov_tick = None
    if coverage:
        peak_cov_tick = int(max(coverage, key=lambda k: coverage[k]))
    return {
        'triangleAreaProxy': {
            'ticks': len(vps),
            'totalPixelFrames': rnd(total, 3),
            'meanPixelsPerTick': rnd(total / len(vps), 3),
            'maxPixelsPerTick': rnd(peak, 3),
            'maxTick': peak_tick,
            'maxFractionOfFrame': rnd(peak / (VIEWPORT[0] * VIEWPORT[1]), 8),
        },
        'coverageProxy': {
            'grid': list(GRID),
            'ticks': coverage,
            'peakFraction': rnd(peak_cov, 8),
            'peakTick': peak_cov_tick,
        },
    }


# ---------------------------------------------------------------- classification

def collider_classes(path: Path):
    doc = load_json(path)
    by_draw = {}
    for collider in doc['colliders']:
        prov = collider.get('provenance', {})
        if collider['source'] == 'level-instance':
            ids = prov.get('drawIds', [])
        else:
            ids = [prov.get('drawId')] if prov.get('drawId') else []
        for draw_id in ids:
            by_draw.setdefault(draw_id, set()).add(collider['classification'])
    counts = {}
    for collider in doc['colliders']:
        key = (collider['source'], collider['classification'])
        counts[key] = counts.get(key, 0) + 1
    return {
        'manifest': rel(path),
        'sha256': 'sha256:' + sha256_bytes(path.read_bytes()),
        'contentSha256': doc.get('contentSha256'),
        'colliders': len(doc['colliders']),
        'counts': {'%s/%s' % k: v for k, v in sorted(counts.items())},
        'triangles': sum(c['triangles'] for c in doc['colliders']),
        'byDraw': by_draw,
    }


def texture_status(track_draw: dict) -> str:
    return track_draw['textureBinding']['status']


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default=str(OUT))
    parser.add_argument('--summary', default=str(SUMMARY))
    args = parser.parse_args(argv)

    for path in (GEOMETRY, TRACK_TEXTURES, TRACK_UV, LEVEL_PROPS, PC66, PC68, PACKET):
        if not path.is_file():
            raise SystemExit('BLOCKED: missing ' + rel(path))

    geometry = load_json(GEOMETRY)
    track_manifest = load_json(TRACK_TEXTURES)
    level_props = load_json(LEVEL_PROPS)
    packet = load_json(PACKET)
    pc66 = collider_classes(PC66)
    pc68 = collider_classes(PC68)

    if geometry.get('version') != 6:
        raise SystemExit('geometry version changed: %r' % geometry.get('version'))
    track_visual = geometry['trackVisual']
    if track_visual['drawCount'] != 394 or track_visual['texturedDrawCount'] != 297:
        raise SystemExit('track draw counts changed')
    if len(geometry['levelDraws']) != 22:
        raise SystemExit('level draw count changed')
    if track_manifest['coverage']['trackDraws'] != 394:
        raise SystemExit('track-textures manifest draw count changed')
    if len(level_props['draws']) != 22 or len(level_props['textures']) != 5:
        raise SystemExit('level-props artifact changed')
    if len(packet['updates']) != 301:
        raise SystemExit('packet camera timeline changed')

    meshes = {m['id']: m for m in geometry['meshes']}
    level_mesh = meshes['river.block27.instances-all']
    track_mesh = meshes['river.track.visual']
    level_pos = np.array(level_mesh['positions'], dtype=np.float64).reshape(-1, 3)
    level_idx = np.array(level_mesh['indices'], dtype=np.int64)
    track_pos = np.array(track_mesh['positions'], dtype=np.float64).reshape(-1, 3)
    track_idx = np.array(track_mesh['indices'], dtype=np.int64)

    # UV stream check: the committed UV file is the merged track mesh UV0.
    uv_bytes = TRACK_UV.read_bytes()
    uv_values = np.frombuffer(uv_bytes, dtype='<f4')
    if uv_values.size != 2 * track_mesh['vertexCount']:
        raise SystemExit('track-uv.bin size does not match the track mesh')

    cameras = {}
    for update in packet['updates']:
        cameras[update['tick']] = view_proj(update['camera'])
    camera_ticks = sorted(cameras)

    # ------------------------------------------------------------ draw records
    collider_map = {}
    for name, doc in (('pc66', pc66), ('pc68', pc68)):
        for draw_id, classes in doc['byDraw'].items():
            collider_map.setdefault(draw_id, {})[name] = sorted(classes)

    track_texture_by_id = {t['id']: t for t in track_manifest['textures']}
    level_texture_by_id = {t['id']: t for t in level_props['textures']}

    records = []
    candidates = []
    track_sections = {}
    for draw in track_visual['draws']:
        section = section_of(draw['id'])
        track_sections.setdefault(section, []).append(draw)
        status = texture_status(draw)
        binding = draw['textureBinding']
        is_candidate = status != STATUS_BOUND
        texture = track_texture_by_id.get(draw.get('textureId')) if draw.get('textureId') else None
        classes = collider_map.get(draw['id'], {})
        prop_classes = sorted({c for group in classes.values() for c in group})
        if status == STATUS_BOUND:
            candidate_status = 'already-textured'
            blockers = []
        elif status == STATUS_RUNTIME:
            candidate_status = 'blocked-runtime-only-albedo'
            blockers = ['runtime-only-albedo-parameter']
        elif status == STATUS_NO_BINDING:
            candidate_status = 'blocked-unmeasured-albedo'
            blockers = ['no-p44-p45-p47-binding-row']
        else:
            raise SystemExit('unknown texture status ' + status)

        if status == STATUS_BOUND:
            uv = {
                'availableInSource': True,
                'perDrawHash': binding.get('uvHash'),
                'provenance': binding.get('uvProvenance'),
                'exportedByCurrentReader': True,
            }
        elif status == STATUS_RUNTIME:
            uv = {
                'availableInSource': True,
                'perDrawHash': binding.get('uvHash'),
                'provenance': binding.get('uvProvenance'),
                'exportedByCurrentReader': True,
            }
        else:
            uv = {
                'availableInSource': True,
                'perDrawHash': None,
                'provenance': 'level-mesh-uv0 (reference-mesh-88-283.json; not hashed by the P45 pass)',
                'exportedByCurrentReader': True,
                'measured': False,
            }

        tri_offset = draw['indexOffset']
        tri_count = draw['indexCount']
        if is_candidate:
            tris = track_pos[track_idx[tri_offset:tri_offset + tri_count].reshape(-1, 3)]
            screen = screen_for_draw(tris, cameras, TRACK_TICKS)
        else:
            screen = {'skipped': 'already-textured'}

        record = {
            'id': draw['id'],
            'meshId': draw['meshId'],
            'sourceKind': 'track-visual',
            'sectionKey': section,
            'drawIndex': int(draw['id'].rsplit('.', 1)[1]),
            'vertexCount': draw['vertexCount'],
            'triangleCount': draw['indexCount'] // 3,
            'indexRange': [draw['indexOffset'], draw['indexCount']],
            'vertexRange': [draw['vertexOffset'], draw['vertexCount']],
            'bounds': draw['bounds'],
            'materialId': draw['materialId'],
            'materialReason': draw['materialReason'],
            'texture': {
                'id': draw.get('textureId'),
                'source': binding.get('source'),
                'name': binding.get('name'),
                'width': texture['width'] if texture else None,
                'height': texture['height'] if texture else None,
                'format': texture['formatName'] if texture else None,
                'rgbaBytes': texture['rgbaBytes'] if texture else None,
                'rgbaSha256': texture['rgbaSha256'] if texture else None,
                'bindingStatus': status,
                'bindingReason': binding.get('reason'),
            },
            'uv0': uv,
            'classification': {
                'kind': ('track-structure' if status == STATUS_BOUND else
                         'track-runtime-only' if status == STATUS_RUNTIME else 'track-no-material'),
                'propClasses': prop_classes,
                'colliderSources': classes,
            },
            'diagnostic': is_candidate,
            'candidateStatus': candidate_status,
            'blockers': blockers,
            'safeToBind': False,
            'screen': screen,
            'provenance': {
                'tool': draw['source'].get('tool'),
                'reference': draw['source'].get('reference'),
                'referenceSha256': draw['source'].get('referenceSha256'),
                'sourceSection': draw['source'].get('sourceSection'),
                'geometryBlock': draw['source'].get('geometryBlock'),
                'nodeBlock': draw['source'].get('nodeBlock'),
                'primitiveIndex': draw['source'].get('primitiveIndex'),
                'sourceIndexRange': [draw['source'].get('sourceFirstIndex'), draw['source'].get('sourceIndexCount')],
                'world': draw['source'].get('world'),
                'worldReason': draw['source'].get('worldReason'),
            },
        }
        record['hash'] = sha256_json(record)
        records.append(record)
        if is_candidate:
            candidates.append({'id': record['id'], 'hash': record['hash'], 'status': candidate_status})

    # ------------------------------------------------------- level prop records
    level_by_id = {d['drawId']: d for d in level_props['draws']}
    placement_index = {}
    placement_members = []
    for draw in geometry['levelDraws']:
        key = tuple(draw['source']['instanceMatrix'])
        if key not in placement_index:
            placement_index[key] = len(placement_members)
            placement_members.append([])
        placement_members[placement_index[key]].append(draw)

    for draw in geometry['levelDraws']:
        draw_id = draw['id']
        level = level_by_id[draw_id]
        classes = collider_map.get(draw_id, {})
        prop_classes = sorted({c for group in classes.values() for c in group})
        texture = level_texture_by_id[level['textureId']]
        alpha = texture['formatName'] == 'DXT5/BC3'
        blockers = ['instance-reader-omits-uv0', 'instance-reader-omits-material-binding']
        if alpha:
            candidate_status = 'blocked-alpha-source'
            blockers.append('bc3-alpha-not-applied')
            safe = False
        else:
            candidate_status = 'candidate-static-albedo-not-exported'
            safe = True
        key = tuple(draw['source']['instanceMatrix'])
        pidx = placement_index[key]
        members = placement_members[pidx]

        tris = level_pos[level_idx[draw['indexOffset']:draw['indexOffset'] + draw['indexCount']].reshape(-1, 3)]
        screen = screen_for_draw(tris, cameras, LEVEL_PROP_TICKS)

        record = {
            'id': draw_id,
            'meshId': draw['meshId'],
            'sourceKind': 'level-instance',
            'sectionKey': 'river.block27.instance',
            'drawIndex': int(draw['source']['instanceIndex']),
            'instanceIndex': int(draw['source']['instanceIndex']),
            'basePrimitiveIndex': int(level['basePrimitiveIndex']),
            'vertexCount': draw['vertexCount'],
            'triangleCount': draw['indexCount'] // 3,
            'indexRange': [draw['indexOffset'], draw['indexCount']],
            'vertexRange': [draw['vertexOffset'], draw['vertexCount']],
            'bounds': draw['bounds'],
            'materialId': draw['materialId'],
            'materialReason': draw['materialReason'],
            'texture': {
                'id': texture['id'],
                'source': level['albedoSource'],
                'name': texture['name'],
                'width': texture['width'],
                'height': texture['height'],
                'format': texture['formatName'],
                'rgbaBytes': texture['rgbaBytes'],
                'rgbaSha256': texture['rgbaSha256'],
                'blobSha256': texture['blobSha256'],
                'bindingStatus': 'resolved-static-g_tAlbedo-not-exported',
                'bindingReason': 'the node253 material chain resolves g_tAlbedo; the committed instance reader emits material:"diagnostic-only"',
                'alpha': alpha,
            },
            'uv0': {
                'availableInSource': True,
                'perDrawHash': None,
                'provenance': 'node253 declaration 0, UV0 usage5 type8 @16; stride 20 (level-instance-streams.md s3)',
                'exportedByCurrentReader': False,
                'currentReaderReason': level['currentReader'],
            },
            'classification': {
                'kind': 'level-instance-prop',
                'propClasses': prop_classes,
                'shapeRule': 'prop-collision.md section 3: level instances have no material binding, so they are classified by shape',
                'placementIndex': pidx,
                'placementDrawCount': len(members),
                'placementTriangleCount': sum(m['indexCount'] // 3 for m in members),
                'colliderSources': classes,
            },
            'diagnostic': True,
            'candidateStatus': candidate_status,
            'blockers': blockers,
            'safeToBind': safe,
            'materialChain': level['materialChain'],
            'materialStack': level['materialStack'],
            'instanceTransformRow': level['instanceTransformRow'],
            'screen': screen,
            'provenance': {
                'tool': draw['source'].get('tool'),
                'instanceMatrix': draw['source'].get('instanceMatrix'),
                'archivedInstanceBounds': draw['source'].get('archivedInstanceBounds'),
                'geometryBlock': draw['source'].get('geometryBlock'),
                'nodeBlock': draw['source'].get('nodeBlock'),
                'instanceIndex': draw['source'].get('instanceIndex'),
                'basePrimitiveIndex': draw['source'].get('basePrimitiveIndex'),
                'worldKind': draw.get('worldKind'),
                'worldReason': 'level_inspect --instances-all: the instance constant affine is baked into the world mesh; the draw itself has no instance placement wrapper',
            },
        }
        record['hash'] = sha256_json(record)
        records.append(record)
        candidates.append({'id': record['id'], 'hash': record['hash'], 'status': candidate_status})

    # ------------------------------------------------------------- aggregates
    level_records = [r for r in records if r['sourceKind'] == 'level-instance']
    level_tris_all = np.concatenate([
        level_pos[level_idx[r['indexRange'][0]:r['indexRange'][0] + r['indexRange'][1]].reshape(-1, 3)]
        for r in level_records
    ], axis=0)
    curve = []
    for tick in CAMERA_TICKS:
        curve.append({'tick': tick, 'fraction': rnd(coverage_fraction(level_tris_all, cameras[tick]), 8)})
    peak = max(curve, key=lambda row: row['fraction'])

    placements = []
    for pidx, members in enumerate(placement_members):
        tris = np.concatenate([
            level_pos[level_idx[d['indexOffset']:d['indexOffset'] + d['indexCount']].reshape(-1, 3)]
            for d in members
        ], axis=0)
        cov = {str(tick): rnd(coverage_fraction(tris, cameras[tick]), 8) for tick in PLACEMENT_TICKS}
        placements.append({
            'index': pidx,
            'drawIds': [m['id'] for m in members],
            'instanceIndices': [int(m['source']['instanceIndex']) for m in members],
            'triangles': int(sum(m['indexCount'] // 3 for m in members)),
            'bounds': members[0]['bounds'],
            'coverageTicks': cov,            'peakCoverage': max(cov.values()),
            'peakTick': int(max(cov, key=lambda k: cov[k])),
        })

    # Track diagnostics are far outside the camera; record the measured zero.
    track_candidates = [r for r in records if r['sourceKind'] == 'track-visual' and r['diagnostic']]
    track_area_total = sum(r['screen']['triangleAreaProxy']['totalPixelFrames'] for r in track_candidates)
    track_cov_max = max((r['screen']['coverageProxy']['peakFraction'] for r in track_candidates), default=0.0)

    status_counts = {}
    for record in records:
        key = record['candidateStatus']
        status_counts[key] = status_counts.get(key, 0) + 1

    candidate_counts = {}
    for entry in candidates:
        item = candidate_counts.setdefault(entry['status'], {'draws': 0, 'triangles': 0, 'levels': 0})
        matching = next(r for r in records if r['id'] == entry['id'])
        item['draws'] += 1
        item['triangles'] += matching['triangleCount']
        item['levels'] += 1 if matching['sourceKind'] == 'level-instance' else 0

    level_texture_totals = {}
    for record in level_records:
        key = record['texture']['id']
        item = level_texture_totals.setdefault(key, {
            'name': record['texture']['name'],
            'source': record['texture']['source'],
            'format': record['texture']['format'],
            'width': record['texture']['width'],
            'height': record['texture']['height'],
            'rgbaBytes': record['texture']['rgbaBytes'],
            'rgbaSha256': record['texture']['rgbaSha256'],
            'draws': 0,
            'triangles': 0,
        })
        item['draws'] += 1
        item['triangles'] += record['triangleCount']

    track_sources = {(t['block'], t['index']) for t in track_manifest['textures']}
    level_sources = {(t['block'], t['index']) for t in level_props['textures']}
    already_in_track_pack = sorted(level_sources & track_sources)
    new_level_sources = sorted(level_sources - track_sources)

    inputs = {
        'geometry': {'path': rel(GEOMETRY), 'bytes': GEOMETRY.stat().st_size, 'sha256': 'sha256:' + sha256_bytes(GEOMETRY.read_bytes())},
        'trackTextures': {'path': rel(TRACK_TEXTURES), 'bytes': TRACK_TEXTURES.stat().st_size, 'sha256': 'sha256:' + sha256_bytes(TRACK_TEXTURES.read_bytes())},
        'trackUv': {'path': rel(TRACK_UV), 'bytes': TRACK_UV.stat().st_size, 'sha256': 'sha256:' + sha256_bytes(uv_bytes)},
        'levelProps': {'path': rel(LEVEL_PROPS), 'bytes': LEVEL_PROPS.stat().st_size, 'sha256': 'sha256:' + sha256_bytes(LEVEL_PROPS.read_bytes())},
        'packetCameras': {'path': rel(PACKET), 'bytes': PACKET.stat().st_size, 'sha256': 'sha256:' + sha256_bytes(PACKET.read_bytes())},
        'propCollision': {'path': pc66['manifest'], 'sha256': pc66['sha256'], 'contentSha256': pc66['contentSha256']},
        'freeRoamProp': {'path': pc68['manifest'], 'sha256': pc68['sha256'], 'contentSha256': pc68['contentSha256']},
    }

    output = {
        'kind': 'prop-textures.candidates',
        'version': 1,
        'generator': 'probes/prop-textures/tools/build_candidates.py',
        'scope': (
            'read-only feasibility manifest for texturing the visible E1 props; it classifies the 394 '
            'committed track draws and the 22 level instance draws, records why each diagnostic draw is '
            'untextured, resolves only committed source fields, and estimates screen weight with a '
            'geometric projection through the committed packet cameras. No renderer, packet, texture or '
            'game-data file is modified'
        ),
        'limits': [
            'screen metrics are a geometric proxy: no depth test, no occlusion, no backface cull '
            '(the committed consumer uses cullMode:none), and the triangle-area sum double-counts '
            'overlapping geometry; the unique-coverage raster is the primary proxy',
            'a candidate is not a rendered result; no GPU/browser claim is made',
            'level-prop UV0 is declared by the source stream but not exported by the committed reader; '
            'no per-vertex UV value or per-draw UV hash is claimed',
            'material colour, g_tMaterial lookup, blend state, shader stages, sampler, mips and sRGB are '
            'not resolved for any draw',
        ],
        'viewport': {'width': VIEWPORT[0], 'height': VIEWPORT[1], 'grid': list(GRID), 'cameraSource': rel(PACKET)},
        'inputs': inputs,
        'summary': {
            'trackDraws': len(track_visual['draws']),
            'trackTexturedDraws': sum(1 for d in track_visual['draws'] if texture_status(d) == STATUS_BOUND),
            'trackDiagnosticDraws': sum(1 for d in track_visual['draws'] if texture_status(d) != STATUS_BOUND),
            'levelPropDraws': len(level_records),
            'levelPropTriangles': sum(r['triangleCount'] for r in level_records),
            'candidateDraws': len(candidates),
            'candidateTriangles': sum(r['triangleCount'] for r in records if r['diagnostic']),
            'statusCounts': status_counts,
            'candidateCounts': candidate_counts,
            'levelTextures': len(level_props['textures']),
            'levelTextureBytes': sum(t['rgbaBytes'] for t in level_props['textures']),
            'levelTexturesAlreadyInTrackPack': len(already_in_track_pack),
            'levelTexturesAdded': len(new_level_sources),
            'levelTextureSourcesAlreadyInTrackPack': ['%d:%d' % key for key in already_in_track_pack],
            'levelTextureSourcesAdded': ['%d:%d' % key for key in new_level_sources],
            'trackDiagnosticScreen': {
                'triangleAreaPixelFrames': rnd(track_area_total, 3),
                'maxCoverageFraction': rnd(track_cov_max, 8),
            },
            'levelPropsScreen': {
                'curve': curve,
                'meanFraction': rnd(sum(row['fraction'] for row in curve) / len(curve), 8),
                'peakFraction': rnd(peak['fraction'], 8),
                'peakTick': peak['tick'],
                'sumFrameEquivalents': rnd(sum(row['fraction'] for row in curve), 6),
                'samples': len(curve),
            },
        },
        'classification': {
            'track': {
                'textured': 'bound-static-albedo',
                'runtimeOnly': 'runtimeOnlyAlbedoParameter (block50/node265 primitives 241,242)',
                'noBinding': 'noBindingRowForSection (block88/node283; the P44/P45/P47 pass covers the six corridor sections only)',
                'note': (
                    'the 97 diagnostic track draws are exactly the P66 no-material class (97 draws / 9,347 '
                    'triangles = 95 block88 draws / 9,343 + 2 runtime-only draws / 4). They are not the '
                    'structural props: all 460 P66/P68 track-visual prop components resolve to '
                    'bound-static-albedo draws'
                ),
            },
            'levelInstances': {
                'shapeRule': 'prop-collision.md: 6 vehicle-sized-wreck + 2 building-sized placements, no material binding',
                'note': (
                    'the 22 level draws group by instanceMatrix into 8 placements; the two height>2.1 m '
                    'placements resolve to bigtruck02_diff + cab01alphas_diff, the six lower placements to '
                    'car01/02/03_lic_diff'
                ),
            },
        },
        'texturedProps': {
            'pc66': {'manifest': pc66['manifest'], 'sha256': pc66['sha256'], 'colliders': pc66['colliders'],
                     'counts': pc66['counts'], 'triangles': pc66['triangles']},
            'pc68': {'manifest': pc68['manifest'], 'sha256': pc68['sha256'], 'colliders': pc68['colliders'],
                     'counts': pc68['counts'], 'triangles': pc68['triangles']},
            'levelInstanceColliders': {
                'pc66': {k: v for k, v in pc66['counts'].items() if k.startswith('level-instance/')},
                'pc68': {k: v for k, v in pc68['counts'].items() if k.startswith('level-instance/')},
            },
            'trackComponentColliders': {
                'pc66': {k: v for k, v in pc66['counts'].items() if k.startswith('track-visual/')},
                'pc68': {k: v for k, v in pc68['counts'].items() if k.startswith('track-visual/')},
            },
        },
        'levelTextures': level_texture_totals,
        'placements': placements,
        'candidates': candidates,
        'draws': records,
    }
    output['contentSha256'] = sha256_json({'draws': records, 'candidates': candidates})

    text = json.dumps(output, indent=1, sort_keys=True, ensure_ascii=False) + '\n'
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(text.encode('utf-8'))

    summary = {
        'candidates': len(candidates),
        'candidateTriangles': output['summary']['candidateTriangles'],
        'statusCounts': status_counts,
        'candidateCounts': candidate_counts,
        'levelPropsScreen': output['summary']['levelPropsScreen'],
        'trackDiagnosticScreen': output['summary']['trackDiagnosticScreen'],
        'levelTextures': {
            key: {'name': value['name'], 'format': value['format'], 'draws': value['draws'],
                  'triangles': value['triangles'], 'rgbaBytes': value['rgbaBytes']}
            for key, value in level_texture_totals.items()
        },
        'manifest': {'path': rel(out), 'bytes': len(text.encode('utf-8')),
                     'sha256': 'sha256:' + sha256_bytes(text.encode('utf-8')),
                     'contentSha256': output['contentSha256']},
    }
    summary_text = json.dumps(summary, indent=1, sort_keys=True, ensure_ascii=False) + '\n'
    Path(args.summary).write_bytes(summary_text.encode('utf-8'))
    print(summary_text)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(__import__('sys').argv[1:]))
