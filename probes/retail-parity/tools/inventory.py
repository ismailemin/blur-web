"""Read-only inventory of what the browser slice carries for one car and one
track band. No file under probes/e1-drive is read-modified; every input is a
committed artifact under _work/.

Outputs _work/retail-parity/inventory.json.
"""

import json
import math
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
WORK = os.path.join(ROOT, '_work')
OUT = os.path.join(WORK, 'retail-parity')
GEOMETRY = os.path.join(WORK, 'e1-drive', 'level.geometry.json')
CAR = os.path.join(WORK, 'e1-drive', 'cars', 'corvette-zr1-stock.geometry.json')
PATH = os.path.join(WORK, 'drivable-path', 'path.json')
SPRINT = os.path.join(WORK, 'e1-drive', 'sprint-corvette-zr1-stock.json')
SWEEP = os.path.join(WORK, 'e1-drive', 'sprint.json')

BAND_METRES = 100.0
# A triangle belongs to the band when its centroid is within this distance of
# the measured 0..100 m centre line. The measured corridor is 6 m half-width
# (sprint.json), so 12 m keeps every draw the car can see from the band while
# excluding the far embankment behind it.
BAND_RADIUS = 12.0


def load(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def main():
    geometry = load(GEOMETRY)
    car = load(CAR)
    path = load(PATH)['course']
    sprint = load(SPRINT)
    sweep = load(SWEEP)

    points = [(float(p[0]), float(p[1])) for p in path['points']]
    sample_step = float(path['length']) / (len(points) - 1)
    band_points = [points[i] for i in range(len(points))
                   if i * sample_step <= BAND_METRES]
    # Dense resample so a triangle between two samples is not missed.
    dense = []
    for i in range(len(band_points) - 1):
        ax, az = band_points[i]
        bx, bz = band_points[i + 1]
        for step in range(10):
            f = step / 10.0
            dense.append((ax + (bx - ax) * f, az + (bz - az) * f))
    dense.append(band_points[-1])

    def near_band(x, z):
        best = float('inf')
        for bx, bz in dense:
            dx = x - bx
            dz = z - bz
            d = dx * dx + dz * dz
            if d < best:
                best = d
                if best <= BAND_RADIUS * BAND_RADIUS:
                    return math.sqrt(best)
        return math.sqrt(best)

    def band_triangles(mesh, draw):
        positions = mesh['positions']
        indices = mesh['indices']
        first = int(draw['indexOffset'])
        count = int(draw['indexCount'])
        kept = 0
        total = count // 3
        for t in range(total):
            i0 = indices[first + t * 3]
            i1 = indices[first + t * 3 + 1]
            i2 = indices[first + t * 3 + 2]
            cx = (positions[i0 * 3] + positions[i1 * 3] + positions[i2 * 3]) / 3.0
            cz = (positions[i0 * 3 + 2] + positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 3.0
            if near_band(cx, cz) <= BAND_RADIUS:
                kept += 1
        return kept, total

    meshes = {mesh['id']: mesh for mesh in geometry['meshes']}

    track = geometry['trackVisual']
    track_mesh = meshes[track['meshId']]
    track_band = []
    track_band_triangles = 0
    track_band_textured = 0
    track_band_diagnostic = 0
    track_band_by_section = {}
    for draw in track['draws']:
        kept, total = band_triangles(track_mesh, draw)
        if kept == 0:
            continue
        section = draw['id'].split('.draw.')[0]
        bucket = track_band_by_section.setdefault(section, {
            'draws': 0, 'trianglesInBand': 0, 'textured': 0, 'diagnostic': 0,
            'textureIds': set()
        })
        bucket['draws'] += 1
        bucket['trianglesInBand'] += kept
        textured = draw.get('textureId') is not None
        if textured:
            bucket['textured'] += 1
            bucket['textureIds'].add(draw['textureId'])
            track_band_textured += 1
        else:
            bucket['diagnostic'] += 1
            track_band_diagnostic += 1
        track_band_triangles += kept
        track_band.append({
            'id': draw['id'],
            'trianglesInBand': kept,
            'triangles': total,
            'textureId': draw.get('textureId'),
            'status': draw['textureBinding']['status'],
            'uvFlipU': draw.get('uvFlipU', False),
            'uvFlipV': draw.get('uvFlipV', False),
        })
    for bucket in track_band_by_section.values():
        bucket['textureIds'] = sorted(bucket['textureIds'])

    level = geometry['levelDraws']
    level_mesh = meshes[level[0]['meshId']] if level else None
    level_band = []
    level_band_triangles = 0
    level_band_textured = 0
    if level_mesh is not None:
        for draw in level:
            kept, total = band_triangles(level_mesh, draw)
            if kept == 0:
                continue
            textured = draw.get('textureId') is not None
            level_band_textured += 1 if textured else 0
            level_band_triangles += kept
            level_band.append({
                'id': draw['id'],
                'trianglesInBand': kept,
                'triangles': total,
                'textureId': draw.get('textureId'),
                'status': draw['textureBinding']['status'],
                'bounds': draw.get('bounds'),
            })

    body = car
    car_textures = body['textures']
    car_status = {}
    for draw in body['carDraws']:
        status = draw['textureBinding']['status']
        car_status[status] = car_status.get(status, 0) + 1

    # Course/section facts used by the camera poses.
    checkpoint_one = sprint['checkpoints'][0]
    tick_at_100 = checkpoint_one['tick']
    raw = sprint['rawTicks']
    tick_row = next(row for row in raw if row['tick'] == tick_at_100)

    def tangent_at(index):
        a = points[max(0, index - 2)]
        b = points[min(len(points) - 1, index + 2)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dz)
        return (dx / length, dz / length)

    index_50 = int(round(50.0 / sample_step))
    index_100 = int(round(100.0 / sample_step))

    result = {
        'kind': 'retail-parity.inventory',
        'version': 1,
        'target': {
            'car': 'corvette-zr1-stock',
            'carChunk': os.path.relpath(CAR, ROOT).replace('\\', '/'),
            'map': 'usa_la_river',
            'band': '0..100 m of the measured 310.395 m P48 path',
            'bandRadiusMetres': BAND_RADIUS,
        },
        'car': {
            'parts': len(body['carParts']),
            'draws': len(body['carDraws']),
            'mesh': {
                'id': body['meshId'],
                'vertices': body['mesh']['vertexCount'],
                'triangles': body['mesh']['indexCount'] // 3,
                'uvValues': len(body['mesh']['uv']['data']) and body['mesh']['uv']['bytes'] // 4,
                'coordinateSpace': body['mesh'].get('coordinateSpace'),
            },
            'statusCounts': car_status,
            'textures': [{
                'id': record['id'],
                'width': record['width'],
                'height': record['height'],
                'rgbaBytes': record['rgbaBytes'],
            } for record in car_textures],
            'textureBytes': sum(record['rgbaBytes'] for record in car_textures),
            'wheelGroups': [{
                'corner': group['corner'],
                'draws': len(group.get('drawIds', [])),
            } for group in body['wheelGroups']],
            'carNodes': [node['id'] for node in body['carNodes']],
        },
        'track': {
            'meshVertices': track_mesh['vertexCount'],
            'meshTriangles': track_mesh['indexCount'] // 3,
            'meshUvValues': track_mesh['uv']['bytes'] // 4,
            'drawsTotal': len(track['draws']),
            'texturedDrawsTotal': sum(1 for d in track['draws'] if d.get('textureId')),
            'diagnosticDrawsTotal': sum(1 for d in track['draws'] if not d.get('textureId')),
            'sections': [{
                'key': section['key'],
                'draws': section['drawCount'],
                'triangles': section['triangleCount'],
                'courseMetres': section.get('courseMetres'),
                'courseOverlap': section.get('courseOverlap'),
            } for section in track['sections']],
            'band': {
                'draws': len(track_band),
                'trianglesInBand': track_band_triangles,
                'texturedDraws': track_band_textured,
                'diagnosticDraws': track_band_diagnostic,
                'bySection': track_band_by_section,
                'drawsDetail': track_band,
            },
        },
        'levelProps': {
            'drawsTotal': len(level),
            'trianglesTotal': sum(d['indexCount'] for d in level) // 3,
            'texturedDrawsTotal': sum(1 for d in level if d.get('textureId')),
            'diagnosticDrawsTotal': sum(1 for d in level if not d.get('textureId')),
            'band': {
                'draws': len(level_band),
                'trianglesInBand': level_band_triangles,
                'texturedDraws': level_band_textured,
                'drawsDetail': level_band,
            },
        },
        'poses': {
            'start': {
                'tick': 0,
                'carPosition': raw[0]['position'],
                'pathPoint': points[0],
                'tangent': tangent_at(0),
            },
            'exit100': {
                'tick': tick_at_100,
                'carPosition': tick_row['position'],
                'pathPoint': points[index_100],
                'tangent': tangent_at(index_100),
            },
            'arc50': {
                'pathPoint': points[index_50],
                'tangent': tangent_at(index_50),
            },
        },
        'sprint': {
            'layoutHash': sprint['layoutHash'],
            'stateSequenceHash': sprint['stateSequenceHash'],
            'finishTick': sprint['finish']['tick'],
            'checkpointTicks': [checkpoint['tick'] for checkpoint in sprint['checkpoints']],
            'courseLengthMetres': sweep['course']['lengthMetres'],
            'finishArc': sweep['course']['finishArc'],
        },
    }
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, 'inventory.json'), 'w', encoding='utf-8', newline='\n') as handle:
        json.dump(result, handle, indent=1, sort_keys=True)
        handle.write('\n')
    print(json.dumps({
        'trackBandDraws': len(track_band),
        'trackBandTriangles': track_band_triangles,
        'trackBandTextured': track_band_textured,
        'trackBandDiagnostic': track_band_diagnostic,
        'levelBandDraws': len(level_band),
        'levelBandTriangles': level_band_triangles,
        'carDraws': len(body['carDraws']),
        'carVertices': body['mesh']['vertexCount'],
        'carTriangles': body['mesh']['indexCount'] // 3,
        'carStatus': car_status,
        'textureBytes': sum(record['rgbaBytes'] for record in car_textures),
    }, indent=1))


if __name__ == '__main__':
    sys.exit(main())
