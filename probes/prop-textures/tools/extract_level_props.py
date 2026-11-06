"""Read-only extraction of the River node253 (block27) prop material chain and UV0 declaration.

This tool is part of the P72a prop-texture feasibility study. It writes only to
`_work/prop-textures/` and never edits game data, e1-drive, upstream or any other
probe.

What it derives, only from the committed readers and the retail files:

  * the 22 block27 instance draws (`river.block27.instance*.primitive*`) emitted by
    the committed `level_inspect --instances-all`;
  * each draw's base primitive, its material stack (instance -> base -> stream) and
    the resolved static `g_tAlbedo` texture source slot;
  * the source texture identity from the committed P34/P47 texture registry and a
    decode through the committed `texture_inspect --raw` BC reader;
  * the node253 declaration 0 layout, which declares UV0 at byte offset 16
    (usage 5, type 8) behind the POSITION element at 0 and NORMAL at 12.

It deliberately does *not* export UV0 values: the current committed instance reader
does not, and the chunk item's vertex resource is not addressed by the Python
resource parser (the chunk has 203 items, block27 is item 7). The output records
that limit instead of guessing.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools'))

from inspect_car_level_assets import render_layout, resource_prefix, stream_prefix  # noqa: E402
from inspect_level_chunk import NodeReader  # noqa: E402

LEVEL_DIR = ROOT / 'game-data/Blur/levels/usa_la_river'
LEVEL_RENDER = LEVEL_DIR / 'level.levelrender'
LEVEL_STREAM = LEVEL_DIR / 'level.levelstream'
LEVEL_INSPECT = ROOT / '_work/build/asset-reader-native/Release/level_inspect.exe'
TEXTURE_INSPECT = ROOT / '_work/build/asset-reader-native/Release/texture_inspect.exe'
REGISTRY_FILES = [
    ROOT / '_work/logs/engine-stream-spike/engine-textures.json',
    ROOT / '_work/logs/engine-stream-spike/track-textures.json',
]
TEXTURE_BLOBS = ROOT / '_work/logs/engine-stream-spike/textures'
OUT_DIR = ROOT / '_work/prop-textures'
TEX_DIR = OUT_DIR / 'level-textures'
INSTANCE_JSON = OUT_DIR / 'level-instances-all.json'
OUT_JSON = OUT_DIR / 'level-props.json'

NODE_CHUNK_INDEX = 53
GEOMETRY_CHUNK_INDEX = 88
GEOMETRY_ITEM_INDEX = 7
NODE_BLOCK = 253
GEOMETRY_BLOCK = 27


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fnv1a64(data: bytes) -> str:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{value:016x}"


class NamedMaterialReader(NodeReader):
    """NodeReader variant that keeps material field names and material rows."""

    def __init__(self, data: bytes, offset: int):
        super().__init__(data, offset)
        self.constants: list[dict] = []
        self.header_rows: list[dict] = []
        self._type_table: list[tuple[str, list[tuple[str, int, int]]]] = []
        self._call = 0

    def material_types_named(self):
        self.ar()
        types = []
        for _ in range(self.vec(4096)):
            self.ar()
            name = self.string()
            fields = []
            for _ in range(self.vec(4096)):
                self.ar()
                field_name = self.string()
                kind, count = self.unpack('iI')
                fields.append((field_name, kind, count))
            self.take(8)
            self.take(self.vec(4096) * 2)
            self.take(8)
            types.append((name, fields))
        self._type_table = types
        return types

    def material_rows_named(self, types):
        count, declared = self.unpack('II')
        if count > 10000 or declared > 16 * 1024 * 1024:
            raise SystemExit('material payload out of bounds')
        rows = []
        for _ in range(count):
            index = self.count(len(types) - 1)
            type_name, fields = types[index]
            row = {'typeIndex': index, 'typeName': type_name, 'fields': []}
            for field_name, kind, n in fields:
                if n > 4096:
                    raise SystemExit('material field count out of bounds')
                if kind in (8, 9):
                    refs = []
                    for _ in range(n):
                        self.ar()
                        refs.append(dict(zip(('index', 'listIndex'), self.unpack('ii'))))
                    row['fields'].append({'name': field_name, 'type': kind, 'count': n, 'refs': refs})
                elif kind == 6:
                    values = [float(self.unpack('f')) for _ in range(n)]
                    row['fields'].append({'name': field_name, 'type': kind, 'count': n, 'values': values})
                else:
                    size = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 4, 10: 4}.get(kind)
                    if size is None:
                        raise SystemExit('unknown material field type %d' % kind)
                    values = []
                    raw = self.take(n * size)
                    for i in range(n):
                        values.append(int.from_bytes(raw[i * size:(i + 1) * size], 'little'))
                    row['fields'].append({'name': field_name, 'type': kind, 'count': n, 'values': values})
            rows.append(row)
        self._call += 1
        if self._call == 1:
            self.header_rows = rows
        else:
            self.constants = rows
        return count, declared

    def render_list(self):
        base = self.ar(4)
        if base < 2:
            raise SystemExit('legacy render list unsupported')
        node = self.cull()
        types = self.material_types_named()
        self.material_rows_named(types)  # header material rows
        primitives = [self.primitive() for _ in range(self.vec())]
        instances = [self.instance() for _ in range(self.vec())]
        batches = []
        for _ in range(self.vec()):
            self.ar()
            batches.append({'instance': self.instance(), 'stream': self.stream()})
        base_primitives = [self.primitive() for _ in range(self.vec())]
        self.material_rows_named(types)  # the constant material rows
        for _ in range(self.vec()):
            self.ar()
            self.take(24)
        for _ in range(3):
            for _ in range(self.vec()):
                self.bounds()
        for _ in range(3):
            version = self.ar(1)
            self.take(4)
            if version:
                self.take(self.vec() * 2)
            self.take(4)
            self.take(self.vec(16 * 1024 * 1024))
        self.take(self.vec() * 4)
        for _ in range(self.vec()):
            self.ar()
            self.bits()
            self.bits()
        if base == 3:
            self.material_types_named()
            self.material_types_named()
        elif base > 3:
            for _ in range(self.vec()):
                self.material_types_named()
        sources = {}
        for key in ('indexBuffer', 'vertexBuffer', 'texture'):
            sources[key] = [dict(zip(('block', 'index'), self.unpack('ii'))) for _ in range(self.vec())]
        chunks = []
        for _ in range(self.vec()):
            self.ar()
            entry = {'chunkIndex': self.unpack('i')}
            for key in ('indexBuffer', 'vertexBuffer', 'texture'):
                rows = []
                for _ in range(self.vec()):
                    self.ar()
                    rows.append(dict(zip(('block', 'index', 'indexInList'), self.unpack('3i'))))
                entry[key] = rows
            chunks.append(entry)
        return {
            'name': node['name'],
            'baseVersion': base,
            'primitives': primitives,
            'instances': instances,
            'instanceBatches': batches,
            'basePrimitives': base_primitives,
            'constants': self.constants,
            'sources': sources,
            'chunkData': chunks,
            'end': self.p,
        }


def read_record(stream_bytes: bytes, record: dict) -> bytes:
    offset = record['offset']
    size = record['storedBytes']
    if offset + size > len(stream_bytes):
        raise SystemExit('record outside level.levelstream')
    return stream_bytes[offset:offset + size]


def parse_node(level_header: bytes, level_stream: bytes):
    layout = render_layout(level_header, 'level')
    scene = layout['scene']
    records = scene['stream']['chunks']
    node_record = records[NODE_CHUNK_INDEX]
    if not any(item['block'] == NODE_BLOCK for item in node_record['items']):
        raise SystemExit('node chunk 53 does not carry block253')
    node_raw = read_record(level_stream, node_record)
    stream_prefix(node_raw, node_record)
    resources = resource_prefix(node_raw, {'resourcePayloadOffset': 24, 'scenePayloadOffset': 0}, streamed=True)
    reader = NamedMaterialReader(node_raw, resources['firstNodeOffset'])
    lists = []
    for index in range(resources['nodeCount']):
        tag = reader.unpack('B')
        if tag == 0:
            continue
        if tag != 3:
            raise SystemExit('unsupported node tag %d' % tag)
        name = reader.string()
        version = reader.ar(4)
        if name == 'RenderingData::RenderListNode_Common':
            render_list = reader.render_list()
            render_list['nodeIndex'] = index
            lists.append(render_list)
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
            raise SystemExit('unsupported node ' + name)
    if len(lists) != 1:
        raise SystemExit('expected one render list, got %d' % len(lists))
    return layout, scene, records, node_record, node_raw, lists[0]


def load_registry():
    registry = {}
    for path in REGISTRY_FILES:
        doc = json.loads(path.read_text(encoding='utf-8'))
        for record in doc['textures']:
            key = (int(record['block']), int(record['index']))
            if key in registry:
                raise SystemExit('duplicate texture registry source %s' % (key,))
            entry = dict(record)
            entry['registry'] = path.name
            registry[key] = entry
    return registry


def decode_texture(key, record):
    block, index = key
    blob = TEXTURE_BLOBS / f'tex-{block}-{index}.raw'
    if not blob.is_file():
        raise SystemExit('missing texture blob %s' % blob)
    process = subprocess.run([str(TEXTURE_INSPECT), str(blob), '--raw'], capture_output=True)
    if process.returncode != 0:
        raise SystemExit('texture_inspect rejected %s: %s' % (key, process.stderr.decode('utf-8', 'replace')[-300:]))
    decoded = json.loads(process.stdout.decode('utf-8'))
    if decoded.get('status') != 'ok':
        raise SystemExit('texture_inspect status for %s: %s' % (key, decoded.get('status')))
    width, height = decoded['width'], decoded['height']
    rgba = bytes(decoded['rgba'])
    if (width, height) != (record['width'], record['height']):
        raise SystemExit('decoded size differs for %s' % (key,))
    if len(rgba) != width * height * 4 or len(rgba) != record['rgbaBytes']:
        raise SystemExit('decoded RGBA length differs for %s' % (key,))
    if fnv1a64(rgba) != record['rgbaHash']:
        raise SystemExit('decoded RGBA hash differs for %s' % (key,))
    if record.get('blobHash') and fnv1a64(blob.read_bytes()) != record['blobHash']:
        raise SystemExit('texture blob hash differs for %s' % (key,))
    return {
        'id': 'level.albedo.%d.%d' % (block, index),
        'block': block,
        'index': index,
        'name': record['name'],
        'textureHash': record['textureHash'],
        'width': width,
        'height': height,
        'levels': record['levels'],
        'format': record['format'],
        'formatName': decoded['metadata']['format'],
        'payloadBytes': record['payloadBytes'],
        'rgbaBytes': len(rgba),
        'rgbaSha256': 'sha256:' + sha256_bytes(rgba),
        'rgbaFnv1a64': fnv1a64(rgba),
        'blob': str(blob.relative_to(ROOT)).replace('\\', '/'),
        'blobSha256': 'sha256:' + sha256_bytes(blob.read_bytes()),
        'registry': record['registry'],
        'rgba': rgba,
    }


def find_field(row, name):
    for field in row['fields']:
        if field['name'] == name:
            return field
    return None


def material_row_summary(row):
    fields = {}
    for field in row['fields']:
        fields[field['name']] = field.get('values', field.get('refs'))
    return {'typeIndex': row['typeIndex'], 'typeName': row['typeName'], 'fields': fields}


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default=str(OUT_JSON))
    args = parser.parse_args(argv)

    for path in (LEVEL_RENDER, LEVEL_STREAM, LEVEL_INSPECT, TEXTURE_INSPECT):
        if not path.is_file():
            raise SystemExit('BLOCKED: missing ' + str(path.relative_to(ROOT)))

    header = LEVEL_RENDER.read_bytes()
    level_stream = LEVEL_STREAM.read_bytes()
    layout, scene, records, node_record, node_raw, render_list = parse_node(header, level_stream)

    geometry_record = records[GEOMETRY_CHUNK_INDEX]
    if len(geometry_record['items']) <= GEOMETRY_ITEM_INDEX or geometry_record['items'][GEOMETRY_ITEM_INDEX]['block'] != GEOMETRY_BLOCK:
        raise SystemExit('geometry chunk item 7 is not block27')
    geometry_raw = read_record(level_stream, geometry_record)

    # The committed C++ instance reader is the authority for what the current
    # pipeline exports. Write the two chunk slices it consumes under our output
    # directory and run it read-only.
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / 'block27-geometry.chunk').write_bytes(geometry_raw)
    (OUT_DIR / 'node253.chunk').write_bytes(node_raw)
    process = subprocess.run([
        str(LEVEL_INSPECT), '--instances-all', str(LEVEL_RENDER),
        str(OUT_DIR / 'block27-geometry.chunk'), str(OUT_DIR / 'node253.chunk'),
        str(GEOMETRY_BLOCK), str(NODE_BLOCK),
    ], capture_output=True)
    if process.returncode != 0:
        raise SystemExit('level_inspect failed: ' + process.stderr.decode('utf-8', 'replace')[-400:])
    INSTANCE_JSON.write_bytes(process.stdout)
    instance_doc = json.loads(process.stdout)
    if instance_doc.get('status') != 'ok':
        raise SystemExit('level_inspect status: ' + str(instance_doc.get('status')))
    if len(instance_doc['draws']) != 22:
        raise SystemExit('level_inspect emitted %d instance draws, expected 22' % len(instance_doc['draws']))

    registry = load_registry()
    declarations = scene.get('declarations')
    if not declarations:
        raise SystemExit('level scene header has no declarations')
    declaration0 = declarations[0]
    uv_elements = [e for e in declaration0 if e['usage'] == 5 and e['usageIndex'] == 0]
    if len(uv_elements) != 1:
        raise SystemExit('declaration 0 must have exactly one UV0 element')
    uv = uv_elements[0]
    if uv['type'] != 8 or uv['offset'] != 16:
        raise SystemExit('declaration 0 UV0 layout changed: %r' % (uv,))

    constants = render_list['constants']
    texture_sources = render_list['sources']['texture']
    base_primitives = render_list['basePrimitives']
    instances = render_list['instances']

    draw_records = []
    seen = {}
    for draw in instance_doc['draws']:
        instance_index = draw['instanceIndex']
        base_index = draw['basePrimitiveIndex']
        base = base_primitives[base_index]
        instance = instances[instance_index]
        if instance['primitiveIndex'] != base_index:
            raise SystemExit('instance/base primitive mismatch at %d' % instance_index)
        chain = []
        stack = []
        # RenderPrimitive sets the instance material, then the base material, then
        # every active stream material (scene_reader.cpp apply_material order).
        stages = [('instance', instance['material']), ('base', base['baseMaterial'])]
        stages += [('stream', stream['material']) for stream in base['streams']]
        albedo = None
        transform_row = None
        for stage_name, ref in stages:
            if ref['listIndex'] != 0:
                raise SystemExit('runtime material list %d at instance %d' % (ref['listIndex'], instance_index))
            if ref['index'] == 0:
                continue
            row = constants[ref['index']]
            field = find_field(row, 'g_tAlbedo')
            if field is None and find_field(row, 'g_mWorld') is not None:
                transform_row = ref['index']
                stack.append({'stage': stage_name, 'materialIndex': ref['index'], 'kind': 'transform',
                              'typeIndex': row['typeIndex'], 'typeName': row['typeName']})
                continue
            summary = material_row_summary(row)
            chain.append({'stage': stage_name, 'materialIndex': ref['index'], **summary})
            stack.append({'stage': stage_name, 'materialIndex': ref['index'], 'kind': 'material',
                          'typeIndex': row['typeIndex'], 'typeName': row['typeName']})
            if field is not None and field.get('values'):
                albedo = field['values'][0]
        if albedo is None:
            raise SystemExit('no static g_tAlbedo for instance %d' % instance_index)
        if albedo < 0 or albedo >= len(texture_sources):
            raise SystemExit('g_tAlbedo slot out of range at instance %d' % instance_index)
        source = texture_sources[albedo]
        key = (int(source['block']), int(source['index']))
        if key not in registry:
            raise SystemExit('g_tAlbedo source %s has no P34/P47 registry record' % (key,))
        record = registry[key]
        texture = seen.get(key)
        if texture is None:
            texture = decode_texture(key, record)
            seen[key] = texture
        draw_records.append({
            'drawId': 'river.block27.instance%d.primitive%d' % (instance_index, base_index),
            'instanceIndex': instance_index,
            'basePrimitiveIndex': base_index,
            'firstIndex': draw['firstIndex'],
            'indexCount': draw['indexCount'],
            'triangleCount': draw['indexCount'] // 3,
            'materialChain': chain,
            'materialStack': stack,
            'instanceTransformRow': transform_row,
            'albedoSlot': albedo,
            'albedoSource': '%d:%d' % key,
            'textureId': texture['id'],
            'textureSource': {'block': key[0], 'index': key[1]},
            'currentReader': {
                'uv0Available': draw['uv0Available'],
                'albedoTexture': draw['albedoTexture'],
                'binding': draw['binding'],
            },
        })

    if len(draw_records) != 22:
        raise SystemExit('expected 22 draw records')

    TEX_DIR.mkdir(parents=True, exist_ok=True)
    textures = []
    for key in sorted(seen, key=lambda k: (k[0], k[1])):
        texture = seen[key]
        rgba = texture.pop('rgba')
        path = TEX_DIR / (texture['id'] + '.rgba')
        path.write_bytes(rgba)
        if sha256_bytes(path.read_bytes()) != texture['rgbaSha256'][7:]:
            raise SystemExit('written RGBA does not re-hash for %s' % (key,))
        texture['rgbaPath'] = str(path.relative_to(ROOT)).replace('\\', '/')
        texture['drawCount'] = sum(1 for d in draw_records if d['textureId'] == texture['id'])
        texture['alphaChannelUsed'] = texture['formatName'] == 'DXT5/BC3'
        textures.append(texture)

    output = {
        'kind': 'prop-textures.level-props',
        'version': 1,
        'generator': 'probes/prop-textures/tools/extract_level_props.py',
        'scope': (
            'read-only extraction of the River block27/node253 instance prop material chain and '
            'UV0 declaration for the P72a feasibility study; no pixel, UV value, material colour or '
            'sampling state is invented'
        ),
        'inputs': {
            'levelRender': {
                'path': str(LEVEL_RENDER.relative_to(ROOT)).replace('\\', '/'),
                'bytes': len(header),
                'sha256': 'sha256:' + sha256_bytes(header),
            },
            'levelStream': {
                'path': str(LEVEL_STREAM.relative_to(ROOT)).replace('\\', '/'),
                'bytes': len(level_stream),
                'sha256': 'sha256:' + sha256_bytes(level_stream),
            },
            'nodeChunk': {
                'chunkIndex': NODE_CHUNK_INDEX,
                'block': NODE_BLOCK,
                'offset': node_record['offset'],
                'storedBytes': node_record['storedBytes'],
                'sha256': 'sha256:' + sha256_bytes(node_raw),
            },
            'geometryChunk': {
                'chunkIndex': GEOMETRY_CHUNK_INDEX,
                'itemIndex': GEOMETRY_ITEM_INDEX,
                'block': GEOMETRY_BLOCK,
                'offset': geometry_record['offset'],
                'storedBytes': geometry_record['storedBytes'],
                'items': len(geometry_record['items']),
                'sha256': 'sha256:' + sha256_bytes(geometry_raw),
            },
            'committedReaderOutput': {
                'path': str(INSTANCE_JSON.relative_to(ROOT)).replace('\\', '/'),
                'sha256': 'sha256:' + sha256_bytes(process.stdout),
                'tool': 'level_inspect.exe --instances-all',
            },
            'textureRegistry': [
                {'path': str(p.relative_to(ROOT)).replace('\\', '/'), 'sha256': 'sha256:' + sha256_bytes(p.read_bytes())}
                for p in REGISTRY_FILES
            ],
        },
        'declaration0': {
            'elements': declaration0,
            'uv0': uv,
            'position': next(e for e in declaration0 if e['usage'] == 0 and e['usageIndex'] == 0),
            'normal': next(e for e in declaration0 if e['usage'] == 3 and e['usageIndex'] == 0),
            'stride': 20,
            'strideSource': (
                'level-instance-streams.md section 3: the referenced block27 vertex buffers are stride 20, '
                'three elements, POSITION @0, NORMAL @12, UV0 @16; the declaration alone does not carry a stride'
            ),
            'uv0AvailableInSource': True,
            'uv0ExportedByCurrentReader': False,
            'currentReaderReason': (
                'level_instances_all() writes uv0Available:false and material:"diagnostic-only"; it emits '
                'POSITION only and never calls apply_material() for instance draws'
            ),
        },
        'instances': {
            'count': len(instances),
            'emittedDraws': len(instance_doc['draws']),
            'basePrimitiveCount': len(base_primitives),
            'materialConstantRows': len(constants),
            'textureSourceSlots': len(texture_sources),
        },
        'draws': draw_records,
        'textures': textures,
        'totals': {
            'draws': len(draw_records),
            'triangles': sum(d['triangleCount'] for d in draw_records),
            'textures': len(textures),
            'rgbaBytes': sum(t['rgbaBytes'] for t in textures),
            'bc1Draws': sum(1 for d in draw_records if next(t for t in textures if t['id'] == d['textureId'])['formatName'] == 'DXT1/BC1'),
            'bc3Draws': sum(1 for d in draw_records if next(t for t in textures if t['id'] == d['textureId'])['formatName'] == 'DXT5/BC3'),
        },
        'limits': [
            'UV0 values are declared by the source stream but not exported by the committed instance reader, '
            'so no per-vertex UV value or per-draw UV hash is claimed here',
            'material colour, g_tMaterial lookup, blend state, shader stages, sampler state and mip selection '
            'are not resolved; only the static g_tAlbedo image is identified',
            'no rendered result is produced or claimed',
        ],
    }
    text = json.dumps(output, indent=1, sort_keys=True, ensure_ascii=False) + '\n'
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(text.encode('utf-8'))
    print(json.dumps({
        'output': str(out.relative_to(ROOT)).replace('\\', '/'),
        'bytes': len(text.encode('utf-8')),
        'sha256': 'sha256:' + sha256_bytes(text.encode('utf-8')),
        'draws': output['totals']['draws'],
        'triangles': output['totals']['triangles'],
        'textures': [(t['id'], t['name'], t['width'], t['height'], t['formatName'], t['rgbaBytes']) for t in textures],
        'uv0': uv,
        'currentReader': output['declaration0']['currentReaderReason'],
    }, indent=1))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
