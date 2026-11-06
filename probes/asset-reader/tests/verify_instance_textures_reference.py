"""Independent River node253 level-instance UV0/material reference (P73a).

Rebuilds the 22 block27 instance draws from the original levelrender/levelstream
inputs: source declaration 0, the bound stride-20 vertex buffers, the ordered
instance/base/stream material stack, the node texture-source table and the
per-draw P45/P47-style FNV-1a 64 UV0 hash. No C++ reader output is used.

Run with --json to print the complete deterministic report.
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
from inspect_level_instances import InstanceReader, read_geometry_block  # noqa: E402

LIMIT = 16 * 1024 * 1024
LEVEL = ROOT / 'game-data/Blur/levels/usa_la_river'
NODE_BLOCK = 253
GEOMETRY_BLOCK = 27
DRAW_COUNT = 22
UV_VALUES = 26324
UV_BYTES = 105296
F32 = struct.Struct('<f')


def fnv1a64(data: bytes) -> int:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def fnv_mix_f32(value: int, component: float) -> int:
    for byte in F32.pack(component):
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


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


def material_albedo(render_list, primitive):
    """Follow Context::RenderPrimitive/SetPrimitive order exactly.

    The C++ reader applies primitive.instanceMaterial, then primitive base
    material, then every active primitive stream material. Nested MATERIAL_INDEX
    rows are followed recursively. The last assignment to g_tAlbedo wins.
    """
    constants = render_list['constants']
    result = {'seen': False, 'known': False, 'slot': None, 'row': -1, 'material': None}

    def apply(ref):
        if ref['listIndex'] != 0:
            result.update(seen=True, known=False, slot=None, row=-1,
                          material='runtime material list rebuilt at runtime')
            return
        index = ref['index']
        if not 0 <= index < len(constants):
            raise ValueError('Constant material index out of bounds')
        material = constants[index]
        for field in material['fields']:
            if field['type'] == 8:
                for child in field['values']:
                    apply(child)
            elif field['name'] == 'g_tAlbedo':
                if field['type'] == 7 and field['count'] == 1:
                    result.update(seen=True, known=True, slot=field['values'][0],
                                  row=index, material=material['typeName'])
                else:
                    result.update(seen=True, known=False, slot=None, row=index,
                                  material=material['typeName'])

    if primitive.get('instanceMaterial') is not None:
        apply(primitive['instanceMaterial'])
    apply(primitive['baseMaterial'])
    for stream in primitive['streams']:
        if stream['streamIndex'] != -1:
            apply(stream['material'])
    return result


def build_reference():
    header = (LEVEL / 'level.levelrender').read_bytes()
    scene = render_layout(header, 'level')['scene']
    records = scene['stream']['chunks']

    node_index = next(i for i, r in enumerate(records)
                      if r['items'] and r['items'][0] == {'block': NODE_BLOCK, 'lod': 0})
    node_record = records[node_index]
    node_data = read_record(records, node_index)
    if len(node_data) > LIMIT:
        raise ValueError('node chunk exceeds limit')
    stream_prefix(node_data, node_record)
    node_resources = resource_prefix(node_data, {'resourcePayloadOffset': 24, 'scenePayloadOffset': 0}, streamed=True)
    _, lists = parse_nodes(node_data, node_resources)
    if not lists:
        raise ValueError('no RenderList in node chunk')
    render_list = lists[0]
    instances = render_list['instances']
    bases = render_list['basePrimitives']
    if len(instances) < DRAW_COUNT:
        raise ValueError('too few instances')

    geometry_data, geometry_resources, geometry_meta = read_geometry_block(LEVEL, records, GEOMETRY_BLOCK)
    vertex_buffers = geometry_resources['vertexBuffers']
    index_buffers = geometry_resources['indexBuffers']

    uv_values = []
    aggregate = 0xCBF29CE484222325
    draws = []
    for instance_index in range(DRAW_COUNT):
        instance = instances[instance_index]
        base = bases[instance['primitiveIndex']]
        declaration = scene['declarations'][base['declaration']]
        position = next((e for e in declaration if e['usage'] == 0 and e['usageIndex'] == 0), None)
        uv = next((e for e in declaration if e['usage'] == 5 and e['usageIndex'] == 0), None)
        if position is None or uv is None:
            raise ValueError('instance %d lacks POSITION0/UV0 declaration' % instance_index)
        if uv['method'] != 0 or uv['type'] != 8:
            raise ValueError('unsupported UV0 declaration at instance %d' % instance_index)

        streams = {}
        for stream in instance['streams']:
            if stream['streamIndex'] != -1:
                streams[stream['streamIndex']] = stream
        for stream in base['streams']:
            if stream['streamIndex'] != -1:
                streams[stream['streamIndex']] = stream
        stream = streams.get(position['stream'])
        if stream is None:
            raise ValueError('missing POSITION0 stream at instance %d' % instance_index)

        vertex_source = render_list['sources']['vertexBuffer'][stream['vertexBuffer']]
        index_source = render_list['sources']['indexBuffer'][base['indexBuffer']]
        if vertex_source['block'] != GEOMETRY_BLOCK or index_source['block'] != GEOMETRY_BLOCK:
            raise ValueError('instance %d source is not block %d' % (instance_index, GEOMETRY_BLOCK))
        vb = vertex_buffers[vertex_source['index']]
        ib = index_buffers[index_source['index']]

        element = next((e for e in vb['elements'] if e['usage'] == 0 and e['usageIndex'] == 0), None)
        uv_element = next((e for e in vb['elements'] if e['usage'] == 5 and e['usageIndex'] == 0), None)
        if element is None or uv_element is None:
            raise ValueError('instance %d vertex buffer lacks POSITION0/UV0' % instance_index)
        for stored, declared in ((element, position), (uv_element, uv)):
            if any(stored[k] != declared[k] for k in ('type', 'method', 'usage', 'usageIndex', 'offset')):
                raise ValueError('declaration/buffer mismatch at instance %d' % instance_index)
        if uv_element['offset'] + 4 > vb['stride']:
            raise ValueError('UV0 exceeds stride at instance %d' % instance_index)
        if stream['vertexOffset'] < 0 or stream['vertexOffset'] % vb['stride']:
            raise ValueError('unaligned instance stream at instance %d' % instance_index)
        shift = stream['vertexOffset'] // vb['stride']

        lod = base['lods'][0]
        if lod['offset'] + lod['indexCount'] > ib['count']:
            raise ValueError('index range outside buffer at instance %d' % instance_index)
        fmt = 'H' if ib['width'] == 2 else 'I'
        source_indices = [struct.unpack_from('<' + fmt, geometry_data,
                                             ib['dataOffset'] + (lod['offset'] + j) * ib['width'])[0]
                          for j in range(lod['indexCount'])]
        if any(v < lod['minIndex'] or v >= lod['minIndex'] + lod['vertexCount'] for v in source_indices):
            raise ValueError('index outside LOD vertex range at instance %d' % instance_index)

        step = 1 if base['topology'] == 1 else 3
        triangles = []
        for j in range(2, len(source_indices), step):
            a, b, c = source_indices[j - 2:j + 1]
            if base['topology'] == 1 and j % 2:
                a, b = b, a
            if len({a, b, c}) == 3:
                triangles.append((a, b, c))
        if not triangles:
            raise ValueError('no nondegenerate triangles at instance %d' % instance_index)

        used = sorted(set(source_indices))
        compact = {source: position_index for position_index, source in enumerate(used)}
        draw_uv = []
        for vertex in used:
            uv_pair = struct.unpack_from('<2e', geometry_data,
                                         vb['dataOffset'] + (vertex + shift) * vb['stride'] + uv_element['offset'])
            if not all(math.isfinite(value) for value in uv_pair):
                raise ValueError('nonfinite UV0 at instance %d' % instance_index)
            uv_values.extend(uv_pair)
            draw_uv.extend(uv_pair)
            aggregate = fnv_mix_f32(aggregate, uv_pair[0])
            aggregate = fnv_mix_f32(aggregate, uv_pair[1])

        digest = 0xCBF29CE484222325
        for a, b, c in triangles:
            for source in (a, b, c):
                vertex = compact[source]
                for axis in range(2):
                    digest = fnv_mix_f32(digest, draw_uv[vertex * 2 + axis])

        texture = material_albedo(render_list, base)
        if not texture['seen']:
            raise ValueError('no g_tAlbedo assignment at instance %d' % instance_index)
        if not texture['known']:
            raise ValueError('g_tAlbedo is runtime-only at instance %d' % instance_index)
        sources = render_list['sources']['texture']
        if not 0 <= texture['slot'] < len(sources):
            raise ValueError('g_tAlbedo slot outside texture source table at instance %d' % instance_index)
        source = sources[texture['slot']]

        draws.append({
            'instanceIndex': instance_index,
            'basePrimitiveIndex': instance['primitiveIndex'],
            'firstIndex': sum(len(draw['indices']) for draw in draws),
            'indexCount': len(triangles) * 3,
            'triangleCount': len(triangles),
            'usedVertexCount': len(used),
            'uvHash': '0x%016x' % digest,
            'uvType': uv['type'],
            'uvOffset': uv['offset'],
            'uvStride': vb['stride'],
            'materialRow': texture['row'],
            'material': texture['material'],
            'albedoParameter': 'g_tAlbedo',
            'albedoSlot': texture['slot'],
            'resourceBlock': source['block'],
            'resourceIndex': source['index'],
            'indices': [compact[source] for triangle in triangles for source in triangle],
        })

    uv_bytes_le = struct.pack('<%df' % len(uv_values), *uv_values)
    if len(uv_values) != UV_VALUES or len(uv_bytes_le) != UV_BYTES:
        raise ValueError('UV stream length differs: %d values / %d bytes' % (len(uv_values), len(uv_bytes_le)))

    texture_sources = []
    for draw in draws:
        key = (draw['resourceBlock'], draw['resourceIndex'])
        entry = next((item for item in texture_sources if (item['block'], item['index']) == key), None)
        if entry is None:
            entry = {'block': key[0], 'index': key[1], 'draws': [], 'triangles': 0}
            texture_sources.append(entry)
        entry['draws'].append(draw['instanceIndex'])
        entry['triangles'] += draw['triangleCount']

    return {
        'level': 'usa_la_river',
        'nodeBlock': NODE_BLOCK,
        'geometryBlock': GEOMETRY_BLOCK,
        'nodeChunkIndex': node_index,
        'geometryChunkIndex': geometry_meta['chunkIndex'],
        'instanceCount': DRAW_COUNT,
        'vertexCount': sum(draw['usedVertexCount'] for draw in draws),
        'triangleCount': sum(draw['triangleCount'] for draw in draws),
        'uvValues': len(uv_values),
        'uvBytes': len(uv_bytes_le),
        'uvSha256': hashlib.sha256(uv_bytes_le).hexdigest(),
        'uvAggregate': '0x%016x' % aggregate,
        'draws': draws,
        'textureSources': texture_sources,
        'note': 'independent Python rebuild from original levelrender/levelstream; no C++ output used',
    }


def compact_report(report):
    return {key: value for key, value in report.items() if key != 'draws'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true', help='print only the JSON report')
    parser.add_argument('--out', type=Path, help='optional evidence path')
    args = parser.parse_args()
    report = build_reference()
    text = json.dumps(report, allow_nan=False, sort_keys=True)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2, allow_nan=False, sort_keys=True) + '\n', encoding='utf-8')
    if args.json:
        print(text)
    elif not args.out:
        print(json.dumps({k: v for k, v in compact_report(report).items()}, indent=2, allow_nan=False, sort_keys=True))


if __name__ == '__main__':
    main()
