"""Independent grouped-bounds reference for River node253 (T-003 Stage B).

Reads the original levelrender/levelstream inputs with the existing source-shaped
diagnostics, rebuilds each instance's world AABB from its own vertex/index range,
and groups contiguous instances by byte-identical archived CullNode records plus
the single constant transform row that supplied g_mWorld.

No C++ reader output is used. The result is compared by verify_instances_wasm.mjs.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools'))
from inspect_car_level_assets import render_layout, resource_prefix, stream_prefix  # noqa: E402
from inspect_car_materials import texture_lod  # noqa: E402
from inspect_level_instances import InstanceReader, constant_world  # noqa: E402

LIMIT = 16 * 1024 * 1024
LEVEL = ROOT / 'game-data/Blur/levels/usa_la_river'
NODE_BLOCK = 253
SUPPLIED = (15, 17, 26, 27, 32)          # Stage A + Stage B; block31 still excluded
STAGE_A = (27, 15, 17)
CROSS = (26, 32)


def read_record(records, index):
    record = records[index]
    with (LEVEL / 'level.levelstream').open('rb') as stream:
        stream.seek(record['offset'])
        data = stream.read(record['storedBytes'])
    if len(data) != record['storedBytes']:
        raise ValueError('short levelstream read')
    return data


def parse_nodes(data, resources):
    reader = InstanceReader(data, resources['firstNodeOffset'])
    lists = []
    for _ in range(resources['nodeCount']):
        tag = reader.unpack('B')
        if tag == 0:
            continue
        name = reader.string()
        version = reader.ar(4)
        if name == 'RenderingData::RenderListNode_Common':
            lists.append(reader.render_list())
        elif name == 'RenderingData::CullNode':
            reader.node()
            reader.bounds()
            reader.bits()
            if version > 0:
                reader.take(4)
            if version > 1:
                reader.bits()
        elif name == 'RenderingData::RootNode':
            reader.cull()
        elif name == 'RenderingData::GroupNode':
            reader.cull()
            reader.string()
        elif name == 'RenderingData::LodNode':
            reader.cull()
            reader.take(reader.vec() * 4)
        elif name == 'RenderingData::Node':
            reader.string()
            reader.take(reader.vec() * 8 + 16)
        else:
            raise ValueError('unsupported node ' + name)
    return reader, lists


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true', help='print only the JSON report')
    parser.add_argument('--out', type=Path, help='optional evidence path')
    args = parser.parse_args()

    header = (LEVEL / 'level.levelrender').read_bytes()
    scene = render_layout(header, 'level')['scene']
    records = scene['stream']['chunks']
    declarations = scene['declarations']

    node_index = next(i for i, r in enumerate(records)
                      if r['items'] and r['items'][0] == {'block': NODE_BLOCK, 'lod': 0})
    node_record = records[node_index]
    node_data = read_record(records, node_index)
    if len(node_data) > LIMIT:
        raise ValueError('node chunk exceeds limit')
    stream_prefix(node_data, node_record)
    node_resources = resource_prefix(node_data, {'resourcePayloadOffset': 24, 'scenePayloadOffset': 0}, streamed=True)
    _, lists = parse_nodes(node_data, node_resources)
    render_list = lists[0]
    instances = render_list['instances']
    bases = render_list['basePrimitives']
    archived = render_list['bounds']['instance']
    if len(archived) != len(instances):
        raise ValueError('archived instance bounds count differs from instances')

    chunk_cache = {}

    def geometry_items(chunk_index):
        if chunk_index in chunk_cache:
            return chunk_cache[chunk_index]
        record = records[chunk_index]
        data = read_record(records, chunk_index)
        if len(data) > LIMIT:
            raise ValueError('geometry chunk exceeds limit')
        stream_prefix(data, record)
        cursor = 24
        items = []
        for k, item in enumerate(record['items']):
            if item['lod'] != 0:
                break
            resources = resource_prefix(data, {'resourcePayloadOffset': cursor, 'scenePayloadOffset': 0}, streamed=True)
            reader, _ = parse_nodes(data, resources)
            for _ in range(reader.count(16)):
                texture_lod(reader, 0, 0)
            items.append({'block': item['block'], 'data': data, 'resources': resources, 'end': reader.p})
            cursor = reader.p
        chunk_cache[chunk_index] = items
        return items

    def item_for(block):
        matches = []
        for chunk_index, record in enumerate(records):
            for k, item in enumerate(record['items']):
                if item['block'] == block and item['lod'] == 0:
                    matches.append((chunk_index, k))
        if len(matches) != 1:
            raise ValueError('ambiguous/missing block %d' % block)
        chunk_index, k = matches[0]
        return geometry_items(chunk_index)[k], chunk_index, k

    def transform(point, matrix):
        return [sum(point[k] * matrix[k * 4 + a] for k in range(3)) + matrix[12 + a] for a in range(3)]

    def bounds(points):
        return [min(p[a] for p in points) for a in range(3)] + [max(p[a] for p in points) for a in range(3)]

    def record_error(a, b):
        return max(abs(a[k] - b[k]) for k in range(6))

    rows = []
    for index, instance in enumerate(instances):
        base = bases[instance['primitiveIndex']]
        declaration = declarations[base['declaration']]
        position = next(e for e in declaration if e['usage'] == 0 and e['usageIndex'] == 0)
        streams = {s['streamIndex']: s for s in instance['streams'] if s['streamIndex'] != -1}
        for stream in base['streams']:
            if stream['streamIndex'] != -1:
                streams.setdefault(stream['streamIndex'], stream)
        stream = streams[position['stream']]
        vertex_source = render_list['sources']['vertexBuffer'][stream['vertexBuffer']]
        index_source = render_list['sources']['indexBuffer'][base['indexBuffer']]
        vb_item, vb_chunk, vb_k = item_for(vertex_source['block'])
        ib_item, ib_chunk, ib_k = item_for(index_source['block'])
        vb = vb_item['resources']['vertexBuffers'][vertex_source['index']]
        ib = ib_item['resources']['indexBuffers'][index_source['index']]
        element = next(e for e in vb['elements'] if e['usage'] == 0 and e['usageIndex'] == 0)
        if (element['type'], element['method'], element['offset']) != (position['type'], position['method'], position['offset']):
            raise ValueError('POSITION0 declaration mismatch at instance %d' % index)
        fmt = {6: 'fff', 9: 'eeee'}.get(element['type'])
        if not fmt:
            raise ValueError('unsupported position format %d' % element['type'])
        lod = base['lods'][0]
        width = ib['width']
        if lod['offset'] + lod['indexCount'] > ib['count'] or lod['minIndex'] + lod['vertexCount'] > vb['vertexCount']:
            raise ValueError('primitive range outside buffer at instance %d' % index)
        source_indices = [struct.unpack_from('<' + ('H' if width == 2 else 'I'), ib_item['data'],
                                             ib['dataOffset'] + (lod['offset'] + j) * width)[0]
                          for j in range(lod['indexCount'])]
        if any(v < lod['minIndex'] or v >= lod['minIndex'] + lod['vertexCount'] for v in source_indices):
            raise ValueError('index outside LOD range at instance %d' % index)
        step = 1 if base['topology'] == 1 else 3
        if base['topology'] == 0 and len(source_indices) % 3:
            raise ValueError('incomplete triangle list at instance %d' % index)
        triangle_count = 0
        for j in range(2, len(source_indices), step):
            a, b, c = source_indices[j - 2:j + 1]
            if base['topology'] == 1 and j % 2:
                a, b = b, a
            if len({a, b, c}) == 3:
                triangle_count += 1
        used = sorted(set(source_indices))
        shift = stream['vertexOffset'] // vb['stride']
        matrix, trace = constant_world(render_list, instance, base)
        rows_for_matrix = sorted({t['material'] for t in trace})
        if len(rows_for_matrix) != 1:
            raise ValueError('ambiguous transform row at instance %d' % index)
        world = []
        for vertex in used:
            if vertex + shift >= vb['vertexCount']:
                raise ValueError('vertex outside buffer at instance %d' % index)
            xyz = struct.unpack_from('<' + fmt, vb_item['data'],
                                     vb['dataOffset'] + (vertex + shift) * vb['stride'] + element['offset'])[:3]
            if not all(math.isfinite(v) for v in xyz):
                raise ValueError('nonfinite position at instance %d' % index)
            world.append(transform(xyz, matrix))
        if not all(math.isfinite(v) for point in world for v in point):
            raise ValueError('nonfinite transformed position at instance %d' % index)
        rows.append({
            'instance': index,
            'base': instance['primitiveIndex'],
            'transformRow': rows_for_matrix[0],
            'vertexBlock': vertex_source['block'],
            'vertexIndex': vertex_source['index'],
            'indexBlock': index_source['block'],
            'indexIndex': index_source['index'],
            'vertexCount': len(used),
            'triangleCount': triangle_count,
            'worldBounds': bounds(world),
            'archivedRaw': archived[index],
            'recordHex': struct.pack('<8f', *archived[index]).hex(),
        })

    groups = []
    for row in rows:
        same = groups and groups[-1]['_row'] == row['transformRow'] and groups[-1]['_recordHex'] == row['recordHex']
        if not same:
            groups.append({'members': [], '_row': row['transformRow'], '_recordHex': row['recordHex'],
                           'recordHex': row['recordHex'], 'transformRow': row['transformRow']})
        groups[-1]['members'].append(row)

    def scope(blocks):
        selected = [g for g in groups if all(r['vertexBlock'] in blocks and r['indexBlock'] in blocks for r in g['members'])]
        return {
            'instanceCount': sum(len(g['members']) for g in selected),
            'vertexCount': sum(r['vertexCount'] for g in selected for r in g['members']),
            'triangleCount': sum(r['triangleCount'] for g in selected for r in g['members']),
            'groupCount': len(selected),
        }

    report_groups = []
    for group in groups:
        members = group['members']
        record = members[0]['archivedRaw']
        byte_identical = len({m['recordHex'] for m in members}) == 1
        low = [min(m['worldBounds'][a] for m in members) for a in range(3)]
        high = [max(m['worldBounds'][a + 3] for m in members) for a in range(3)]
        union = low + high
        error = record_error(union, record)
        if not byte_identical or error > 1e-4:
            raise ValueError('group %d failed: byte-identical=%s error=%g' % (members[0]['instance'], byte_identical, error))
        report_groups.append({
            'firstInstance': members[0]['instance'],
            'instanceCount': len(members),
            'transformRow': group['transformRow'],
            'recordHex': group['recordHex'],
            'byteIdentical': byte_identical,
            'blocks': [m['vertexBlock'] for m in members],
            'unionMin': low,
            'unionMax': high,
            'maxAbsoluteDifference': error,
        })

    expected = {'instanceCount': 56, 'vertexCount': 34632, 'triangleCount': 25521}
    actual = scope(SUPPLIED)
    if (actual['instanceCount'], actual['vertexCount'], actual['triangleCount']) != \
            (expected['instanceCount'], expected['vertexCount'], expected['triangleCount']):
        raise ValueError('Stage A+B totals differ: %s' % actual)
    stage_a = scope(STAGE_A)
    cross = scope(CROSS)
    if (stage_a['instanceCount'], stage_a['vertexCount'], stage_a['triangleCount']) != (36, 22924, 17301):
        raise ValueError('Stage A totals differ: %s' % stage_a)
    if (cross['instanceCount'], cross['vertexCount'], cross['triangleCount']) != (20, 11708, 8220):
        raise ValueError('cross-chunk totals differ: %s' % cross)
    full = scope((15, 17, 26, 27, 31, 32))

    report = {
        'level': 'usa_la_river',
        'nodeBlock': NODE_BLOCK,
        'nodeChunkIndex': node_index,
        'nodeRecordSha256': hashlib.sha256(node_data).hexdigest(),
        'instanceCount': len(rows),
        'groupCount': len(groups),
        'groups': report_groups,
        'stageA': stage_a,
        'crossChunk': cross,
        'stageAB': actual,
        'fullNodeWithBlock31Reference': full,
        'boundsTolerance': 1e-4,
        'note': 'independent Python rebuild from original levelrender/levelstream; no C++ output used',
    }
    text = json.dumps(report, allow_nan=False)
    if args.out:
        args.out.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    if args.json:
        print(text)
    elif not args.out:
        print(json.dumps({k: v for k, v in report.items() if k not in ('groups',)}, indent=2))


if __name__ == '__main__':
    main()
