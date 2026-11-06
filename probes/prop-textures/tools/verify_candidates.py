"""Independent verifier for the P72a prop-texture candidate manifest.

The verifier does not import the builder. It re-reads the committed inputs and
re-derives every claim it can:

  * track draw counts, per-draw UV0 hashes (independent FNV-1a 64 over
    `track-uv.bin`), 136 RGBA files, 297/2/95 split;
  * the 22 level prop draws' material chain against the pre-existing committed
    node253 report, the 5 source textures through the committed BC decoder, and
    the current reader's `uv0Available:false` / `albedoTexture:null` output;
  * P66/P68 collider classification (all 460/423 track components are textured,
    the 8 level instances are the diagnostic props);
  * per-draw record hashes and the manifest content hash;
  * the screen proxy at the committed capture ticks and the 301-tick triangle
    area for the 22 level draws;
  * byte-identical reproducibility by running the builder a second time.

Output: `_work/prop-textures/verify.json` (never committed).
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
PYTHON = sys.executable
GEOMETRY = ROOT / '_work/e1-drive/geometry.json'
TRACK_TEXTURES = ROOT / '_work/e1-drive/track-textures.json'
TRACK_UV = ROOT / '_work/e1-drive/track-uv.bin'
TRACK_TEX_DIR = ROOT / '_work/e1-drive/textures'
LEVEL_PROPS = ROOT / '_work/prop-textures/level-props.json'
LEVEL_READER = ROOT / '_work/prop-textures/level-instances-all.json'
MANIFEST = ROOT / '_work/prop-textures/candidates.json'
PC66 = ROOT / '_work/prop-collision/colliders.json'
PC68 = ROOT / '_work/free-roam-prop/colliders-r04.json'
PACKET = ROOT / '_work/e1-drive/packet.json'
NODE_REPORT = ROOT / '_work/level-instances/usa_la_river-g252-n253.json'
LEVEL_RENDER = ROOT / 'game-data/Blur/levels/usa_la_river/level.levelrender'
LEVEL_STREAM = ROOT / 'game-data/Blur/levels/usa_la_river/level.levelstream'
TEXTURE_INSPECT = ROOT / '_work/build/asset-reader-native/Release/texture_inspect.exe'
TEXTURE_BLOBS = ROOT / '_work/logs/engine-stream-spike/textures'
REPEAT = ROOT / '_work/prop-textures/repeat-candidates.json'
REPEAT_SUMMARY = ROOT / '_work/prop-textures/repeat-summary.json'
OUT = ROOT / '_work/prop-textures/verify.json'
BUILDER = ROOT / 'probes/prop-textures/tools/build_candidates.py'

VIEWPORT = (1600, 900)
GRID = (320, 180)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def fnv1a64(data: bytes) -> str:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f'{value:016x}'


def load(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT)).replace('\\', '/')


def view_proj(camera):
    view = np.array(camera['view'], dtype=np.float64).reshape(4, 4).T
    projection = np.array(camera['projection'], dtype=np.float64).reshape(4, 4).T
    return projection @ view


def triangle_area_ndc(ndc):
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


def projected_area(tris, vp):
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


def coverage_fraction(tris, vp):
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


def main():
    checks = []

    def check(check_id, ok, detail):
        checks.append({'id': check_id, 'ok': bool(ok), 'detail': detail})
        return bool(ok)

    for path in (GEOMETRY, TRACK_TEXTURES, TRACK_UV, LEVEL_PROPS, LEVEL_READER, MANIFEST,
                 PC66, PC68, PACKET, NODE_REPORT, LEVEL_RENDER, LEVEL_STREAM, TEXTURE_INSPECT):
        if not path.is_file():
            print('BLOCKED: missing ' + str(path))
            return 2

    geometry = load(GEOMETRY)
    track_manifest = load(TRACK_TEXTURES)
    level_props = load(LEVEL_PROPS)
    level_reader = load(LEVEL_READER)
    manifest = load(MANIFEST)
    pc66 = load(PC66)
    pc68 = load(PC68)
    packet = load(PACKET)
    node_report = load(NODE_REPORT)

    check('geometry.version', geometry.get('version') == 6, 'geometry version %r' % geometry.get('version'))
    track_visual = geometry['trackVisual']
    check('track.draws', track_visual['drawCount'] == 394, 'track draws %d' % track_visual['drawCount'])
    check('track.textured', track_visual['texturedDrawCount'] == 297, 'textured %d' % track_visual['texturedDrawCount'])
    check('level.draws', len(geometry['levelDraws']) == 22, 'level draws %d' % len(geometry['levelDraws']))
    check('level.triangles', sum(d['indexCount'] // 3 for d in geometry['levelDraws']) == 10308,
          'level triangles %d' % sum(d['indexCount'] // 3 for d in geometry['levelDraws']))
    check('level.vertices', sum(d['vertexCount'] for d in geometry['levelDraws']) == 13162,
          'level vertices %d' % sum(d['vertexCount'] for d in geometry['levelDraws']))

    # ---- track manifest and UV stream
    check('trackManifest.draws', len(track_manifest['draws']) == 394, 'manifest draws %d' % len(track_manifest['draws']))
    check('trackManifest.textures', len(track_manifest['textures']) == 136, 'textures %d' % len(track_manifest['textures']))
    coverage = track_manifest['coverage']
    check('trackManifest.split',
          (coverage['texturedDraws'], coverage['fallbackRuntimeOnly'], coverage['fallbackNoBindingRow']) == (297, 2, 95),
          json.dumps(coverage, sort_keys=True))
    uv_bytes = TRACK_UV.read_bytes()
    check('trackUv.bytes', len(uv_bytes) == 771952, 'bytes %d' % len(uv_bytes))
    check('trackUv.sha', 'sha256:' + sha256(uv_bytes) == track_manifest['uvStream']['sha256'],
          'actual %s' % ('sha256:' + sha256(uv_bytes)))
    uv = np.frombuffer(uv_bytes, dtype='<f4')
    track_mesh = next(m for m in geometry['meshes'] if m['id'] == 'river.track.visual')
    track_idx = np.array(track_mesh['indices'], dtype=np.int64)
    check('trackUv.size', uv.size == 2 * track_mesh['vertexCount'],
          'values %d, vertices %d' % (uv.size, track_mesh['vertexCount']))

    # ---- 136 track RGBA files
    tex_dir_ok = True
    tex_bytes = 0
    for texture in track_manifest['textures']:
        path = TRACK_TEX_DIR / (texture['id'] + '.rgba')
        if not path.is_file():
            tex_dir_ok = False
            break
        data = path.read_bytes()
        tex_bytes += len(data)
        if 'sha256:' + sha256(data) != texture['rgbaSha256'] or len(data) != texture['rgbaBytes']:
            tex_dir_ok = False
            break
    check('trackTextures.rgba', tex_dir_ok, 'track RGBA files re-hashed')
    check('trackTextures.rgbaBytes', tex_bytes == 439360, 'RGBA bytes %d' % tex_bytes)

    # ---- independent per-draw UV0 hashes for the 299 measured track draws
    def mix_f32(value, component):
        for byte in np.float32(component).tobytes():
            value ^= int(byte)
            value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
        return value

    uv_ok = 0
    uv_checked = 0
    for draw in track_visual['draws']:
        binding = draw['textureBinding']
        if binding.get('uvHash') is None:
            continue
        uv_checked += 1
        first, count = draw['indexOffset'], draw['indexCount']
        digest = 0xCBF29CE484222325
        for vertex in track_idx[first:first + count]:
            digest = mix_f32(digest, uv[2 * vertex])
            digest = mix_f32(digest, uv[2 * vertex + 1])
        if f'0x{digest:016x}' == binding['uvHash']:
            uv_ok += 1
    check('trackUv.perDrawHashes', uv_checked == 299 and uv_ok == 299,
          '%d/%d recomputed hashes match' % (uv_ok, uv_checked))

    # ---- level props and current reader
    check('levelProps.draws', len(level_props['draws']) == 22, 'draws %d' % len(level_props['draws']))
    check('levelProps.textures', len(level_props['textures']) == 5, 'textures %d' % len(level_props['textures']))
    check('levelProps.triangles', level_props['totals']['triangles'] == 10308,
          'triangles %d' % level_props['totals']['triangles'])
    check('levelReader.draws', len(level_reader['draws']) == 22, 'draws %d' % len(level_reader['draws']))
    reader_ok = all(d['uv0Available'] is False and d['albedoTexture'] is None and
                    d['binding'] == 'Level instance diagnostic; materials not applied'
                    for d in level_reader['draws'])
    check('levelReader.diagnostic', reader_ok, 'all 22 draws uv0Available:false / albedoTexture:null')

    # UV0 declaration from the level scene header
    sys.path.insert(0, str(ROOT / 'tools'))
    from inspect_car_level_assets import render_layout  # noqa: E402
    layout = render_layout(LEVEL_RENDER.read_bytes(), 'level')
    declaration0 = layout['scene']['declarations'][0]
    uv_elem = [e for e in declaration0 if e['usage'] == 5 and e['usageIndex'] == 0]
    check('level.uv0Declaration',
          len(uv_elem) == 1 and uv_elem[0]['offset'] == 16 and uv_elem[0]['type'] == 8,
          'declaration 0: %s' % json.dumps(declaration0, sort_keys=True))

    # level chunk hashes and offsets
    records = layout['scene']['stream']['chunks']
    node_rec = records[level_props['inputs']['nodeChunk']['chunkIndex']]
    level_stream = LEVEL_STREAM.read_bytes()
    node_raw = level_stream[node_rec['offset']:node_rec['offset'] + node_rec['storedBytes']]
    check('level.nodeChunk',
          'sha256:' + sha256(node_raw) == level_props['inputs']['nodeChunk']['sha256'],
          'node chunk %d offset %d' % (level_props['inputs']['nodeChunk']['chunkIndex'], node_rec['offset']))
    geom_rec = records[level_props['inputs']['geometryChunk']['chunkIndex']]
    geom_raw = level_stream[geom_rec['offset']:geom_rec['offset'] + geom_rec['storedBytes']]
    check('level.geometryChunk',
          'sha256:' + sha256(geom_raw) == level_props['inputs']['geometryChunk']['sha256'] and
          len(geom_rec['items']) > level_props['inputs']['geometryChunk']['itemIndex'] and
          geom_rec['items'][level_props['inputs']['geometryChunk']['itemIndex']]['block'] == 27,
          'geometry chunk %d item %d' % (level_props['inputs']['geometryChunk']['chunkIndex'],
                                        level_props['inputs']['geometryChunk']['itemIndex']))
    check('level.sourceFiles',
          'sha256:' + sha256(LEVEL_RENDER.read_bytes()) == level_props['inputs']['levelRender']['sha256'] and
          'sha256:' + sha256(level_stream) == level_props['inputs']['levelStream']['sha256'],
          'level.levelrender / level.levelstream unchanged')

    # ---- level texture decode and material chain cross-check
    registry = {}
    for name in ('engine-textures.json', 'track-textures.json'):
        doc = load(ROOT / '_work/logs/engine-stream-spike' / name)
        for record in doc['textures']:
            registry[(int(record['block']), int(record['index']))] = record

    decode_ok = True
    level_tex_bytes = 0
    for texture in level_props['textures']:
        blob = TEXTURE_BLOBS / ('tex-%d-%d.raw' % (texture['block'], texture['index']))
        process = subprocess.run([str(TEXTURE_INSPECT), str(blob), '--raw'], capture_output=True)
        if process.returncode != 0:
            decode_ok = False
            break
        decoded = json.loads(process.stdout.decode('utf-8'))
        rgba = bytes(decoded['rgba'])
        path = ROOT / texture['rgbaPath']
        level_tex_bytes += len(rgba)
        if ('sha256:' + sha256(rgba) != texture['rgbaSha256'] or
                path.read_bytes() != rgba or
                fnv1a64(rgba) != texture['rgbaFnv1a64'] or
                len(rgba) != texture['rgbaBytes']):
            decode_ok = False
            break
        record = registry.get((texture['block'], texture['index']))
        if record is None or record['name'] != texture['name'] or record['format'] != texture['format']:
            decode_ok = False
            break
    check('levelTextures.decode', decode_ok, '5 source textures decoded by the committed BC reader')
    check('levelTextures.bytes', level_tex_bytes == 9216, 'RGBA bytes %d' % level_tex_bytes)

    # Cross-check the material chain against the pre-existing node report.
    report_constants = node_report['renderLists'][0]['constants']
    report_sources = node_report['renderLists'][0]['sources']['texture']
    report_base = node_report['renderLists'][0]['basePrimitives']
    report_draws = {d['drawId']: d for d in level_props['draws']}
    chain_ok = 0
    for draw in geometry['levelDraws']:
        base_index = int(draw['source']['basePrimitiveIndex'])
        material_index = report_base[base_index]['streams'][0]['material']['index']
        row = report_constants[material_index]
        albedo = next(f['values'][0] for f in row['fields'] if f['name'] == 'g_tAlbedo')
        source = report_sources[albedo]
        expected = '%d:%d' % (source['block'], source['index'])
        record = report_draws[draw['id']]
        record_source = '%d:%d' % (record['textureSource']['block'], record['textureSource']['index'])
        if record_source == expected and record['albedoSource'] == expected:
            chain_ok += 1
    check('level.materialChain', chain_ok == 22, '%d/22 chains match the committed node253 report' % chain_ok)

    # ---- P66/P68 classification
    def collider_stats(doc, level_instance_key):
        track = [c for c in doc['colliders'] if c['source'] == 'track-visual']
        levels = [c for c in doc['colliders'] if c['source'] == level_instance_key]
        draw_status = {d['id']: d['textureBinding']['status'] for d in track_visual['draws']}
        track_ok = all(draw_status.get(c['provenance']['drawId']) == 'bound-static-albedo' for c in track)
        level_ids = {d['id'] for d in geometry['levelDraws']}
        level_ok = all(all(draw_id in level_ids for draw_id in c['provenance'].get('drawIds', [])) for c in levels)
        return track, levels, track_ok, level_ok

    pc66_track, pc66_level, pc66_track_ok, pc66_level_ok = collider_stats(pc66, 'level-instance')
    pc68_track, pc68_level, pc68_track_ok, pc68_level_ok = collider_stats(pc68, 'level-instance')
    check('pc66.trackPropsTextured', len(pc66_track) == 460 and pc66_track_ok,
          '%d track components, all bound-static-albedo' % len(pc66_track))
    check('pc66.levelPropsDiagnostic', len(pc66_level) == 8 and pc66_level_ok,
          '%d level instances, all in the 22 diagnostic draws' % len(pc66_level))
    check('pc68.trackPropsTextured', len(pc68_track) == 423 and pc68_track_ok,
          '%d track components, all bound-static-albedo' % len(pc68_track))
    check('pc68.levelPropsDiagnostic', len(pc68_level) == 8 and pc68_level_ok,
          '%d level instances, all in the 22 diagnostic draws' % len(pc68_level))
    classes = {}
    for collider in pc66_level:
        classes[collider['classification']] = classes.get(collider['classification'], 0) + 1
    check('pc66.levelShapeClasses',
          classes == {'building-sized': 2, 'vehicle-sized-wreck': 6},
          json.dumps(classes, sort_keys=True))

    # ---- manifest structure, per-draw hashes, content hash
    draws = manifest['draws']
    check('manifest.draws', len(draws) == 416, 'records %d' % len(draws))
    check('manifest.candidates', len(manifest['candidates']) == 119, 'candidates %d' % len(manifest['candidates']))
    ids = [r['id'] for r in draws]
    check('manifest.idsUnique', len(ids) == len(set(ids)), '%d unique ids' % len(set(ids)))
    record_by_id = {r['id']: r for r in draws}
    candidate_ids = {c['id'] for c in manifest['candidates']}
    hash_ok = 0
    for record in draws:
        body = {k: v for k, v in record.items() if k != 'hash'}
        if 'sha256:' + sha256(canonical(body)) == record['hash']:
            hash_ok += 1
    check('manifest.perDrawHashes', hash_ok == len(draws), '%d/%d record hashes recompute' % (hash_ok, len(draws)))
    content = 'sha256:' + sha256(canonical({'draws': draws, 'candidates': manifest['candidates']}))
    check('manifest.contentHash', content == manifest['contentSha256'], content)

    # status and triangle totals
    status_counts = {}
    status_triangles = {}
    for record in draws:
        status_counts[record['candidateStatus']] = status_counts.get(record['candidateStatus'], 0) + 1
        status_triangles[record['candidateStatus']] = \
            status_triangles.get(record['candidateStatus'], 0) + record['triangleCount']
    expected_status = {
        'already-textured': 297,
        'candidate-static-albedo-not-exported': 18,
        'blocked-alpha-source': 4,
        'blocked-runtime-only-albedo': 2,
        'blocked-unmeasured-albedo': 95,
    }
    expected_triangles = {
        'already-textured': 57133 - 9347,
        'candidate-static-albedo-not-exported': 10212,
        'blocked-alpha-source': 96,
        'blocked-runtime-only-albedo': 4,
        'blocked-unmeasured-albedo': 9343,
    }
    check('manifest.statusCounts', status_counts == expected_status, json.dumps(status_counts, sort_keys=True))
    check('manifest.statusTriangles', status_triangles == expected_triangles, json.dumps(status_triangles, sort_keys=True))
    check('manifest.diagnosticFlags',
          all(record['diagnostic'] == (record['id'] in candidate_ids) for record in draws),
          'diagnostic flag equals candidate membership')

    # track records must agree with geometry
    track_records = {r['id']: r for r in draws if r['sourceKind'] == 'track-visual'}
    track_ok = True
    for draw in track_visual['draws']:
        record = track_records[draw['id']]
        if record['triangleCount'] != draw['indexCount'] // 3 or \
                record['texture']['bindingStatus'] != draw['textureBinding']['status'] or \
                record['uv0']['perDrawHash'] != draw['textureBinding'].get('uvHash'):
            track_ok = False
            break
    check('manifest.trackRecords', track_ok, '394 track records agree with geometry.json')

    # level records must agree with the two independent level artifacts
    level_records = {r['id']: r for r in draws if r['sourceKind'] == 'level-instance'}
    level_ok = True
    for draw in geometry['levelDraws']:
        record = level_records[draw['id']]
        source = report_draws[draw['id']]
        if record['triangleCount'] != draw['indexCount'] // 3 or \
                record['texture']['source'] != source['albedoSource'] or \
                record['texture']['id'] != source['textureId'] or \
                record['uv0']['exportedByCurrentReader'] is not False:
            level_ok = False
            break
    check('manifest.levelRecords', level_ok, '22 level records agree with geometry.json and level-props.json')

    # texture sets are disjoint from the accepted track pack
    track_sources = {(t['block'], t['index']) for t in track_manifest['textures']}
    level_sources = {(t['block'], t['index']) for t in level_props['textures']}
    check('levelTextures.notInTrackPack', not (track_sources & level_sources),
          'level sources %s' % sorted(level_sources))

    # ---- screen proxy
    cameras = {u['tick']: view_proj(u['camera']) for u in packet['updates']}
    level_pos = np.array(next(m for m in geometry['meshes'] if m['id'] == 'river.block27.instances-all')['positions'],
                         dtype=np.float64).reshape(-1, 3)
    level_idx = np.array(next(m for m in geometry['meshes'] if m['id'] == 'river.block27.instances-all')['indices'],
                         dtype=np.int64)

    def tris_of(draw):
        return level_pos[level_idx[draw['indexOffset']:draw['indexOffset'] + draw['indexCount']].reshape(-1, 3)]

    curve = {row['tick']: row['fraction'] for row in manifest['summary']['levelPropsScreen']['curve']}
    all_tris = np.concatenate([tris_of(d) for d in geometry['levelDraws']], axis=0)
    capture_ok = True
    for tick in (0, 150, 240, 300):
        actual = round(coverage_fraction(all_tris, cameras[tick]), 8)
        if abs(actual - curve[tick]) > 1e-8:
            capture_ok = False
            break
    check('screen.captureTicks', capture_ok, 'level prop coverage at ticks 0/150/240/300 matches')

    # per-draw coverage for one truck body and one BC3 cab draw
    per_draw_ok = True
    for draw_id, ticks in (('river.block27.instance12.primitive6', (0, 60, 90, 120, 150)),
                           ('river.block27.instance14.primitive8', (0, 60, 90, 120, 150))):
        draw = next(d for d in geometry['levelDraws'] if d['id'] == draw_id)
        record = level_records[draw_id]
        tris = tris_of(draw)
        for tick in ticks:
            actual = round(coverage_fraction(tris, cameras[tick]), 8)
            if abs(actual - record['screen']['coverageProxy']['ticks'][str(tick)]) > 1e-8:
                per_draw_ok = False
                break
    check('screen.perDrawCoverage', per_draw_ok, 'truck body and cab draw coverage recompute')

    # 301-tick triangle-area totals for all 22 level draws
    area_ok = True
    for draw in geometry['levelDraws']:
        record = level_records[draw['id']]
        tris = tris_of(draw)
        total = sum(projected_area(tris, cameras[tick]) for tick in sorted(cameras))
        if abs(total - record['screen']['triangleAreaProxy']['totalPixelFrames']) > 0.01:
            area_ok = False
            break
    check('screen.triangleArea301', area_ok, '22 level draws re-summed over all 301 camera ticks')

    # 97 track diagnostics: zero coverage and (practically) zero area
    track_diag = [r for r in draws if r['sourceKind'] == 'track-visual' and r['diagnostic']]
    track_mesh_pos = np.array(track_mesh['positions'], dtype=np.float64).reshape(-1, 3)
    diag_ok = True
    for record in track_diag:
        if record['screen']['coverageProxy']['peakFraction'] != 0.0:
            diag_ok = False
            break
    check('screen.trackDiagnosticsInvisible', diag_ok,
          '97 diagnostic track draws have 0 coverage at the committed capture ticks')
    diag_area = sum(r['screen']['triangleAreaProxy']['totalPixelFrames'] for r in track_diag)
    check('screen.trackDiagnosticsArea', abs(diag_area - manifest['summary']['trackDiagnosticScreen']['triangleAreaPixelFrames']) < 1e-6,
          'total %.3f pixel-frames' % diag_area)

    # ---- reproducibility
    repeat = subprocess.run([PYTHON, str(BUILDER), '--out', str(REPEAT), '--summary', str(REPEAT_SUMMARY)],
                            capture_output=True)
    if repeat.returncode != 0:
        check('reproducible', False, repeat.stderr.decode('utf-8', 'replace')[-500:])
    else:
        first = MANIFEST.read_bytes()
        second = REPEAT.read_bytes()
        check('reproducible', first == second, 'second build is byte-identical (%d B)' % len(second))

    failures = [c for c in checks if not c['ok']]
    result = {
        'kind': 'prop-textures.verify',
        'version': 1,
        'manual': rel(MANIFEST),
        'manualSha256': 'sha256:' + sha256(MANIFEST.read_bytes()),
        'verdict': 'PASS' if not failures else 'FAIL',
        'checks': len(checks),
        'passed': len(checks) - len(failures),
        'failed': len(failures),
        'failures': failures,
        'checkList': checks,
    }
    OUT.write_bytes((json.dumps(result, indent=1, sort_keys=True, ensure_ascii=False) + '\n').encode('utf-8'))
    print(json.dumps({k: result[k] for k in ('verdict', 'checks', 'passed', 'failed', 'manualSha256')}, indent=1))
    for failure in failures:
        print('FAIL', failure['id'], '-', failure['detail'])
    return 0 if not failures else 1


if __name__ == '__main__':
    raise SystemExit(main())
