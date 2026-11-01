"""Source-shaped binding diagnostic for the exact decoded trafficcylinder fixture.

Offsets are identity-gated profile anchors, never candidate/magic scans. The
objects selected at those anchors are consumed sequentially by source serializers.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import math
import struct
from pathlib import Path
from inspect_mesh_layout import FIXTURE_SHA256, FIXTURE_SIZE, Reader, inspect as inspect_mesh
from inspect_asset_layout import pak_index

ROOT = Path(__file__).resolve().parent.parent


class BindingReader(Reader):
    def string(self):
        n = self.unpack('I')
        if n > 4096 or self.offset + n > len(self.data):
            raise ValueError('Invalid material string length')
        value = self.data[self.offset:self.offset+n].decode('utf-8')
        self.offset += n
        return value.rstrip('\0')

    def material_type(self):
        self.marker(0)
        name = self.string()
        fields = []
        for _ in range(self.vector_count()):
            self.marker(0)
            fields.append({'name': self.string(), 'type': self.unpack('i'), 'count': self.unpack('I')})
        size, alignment = self.unpack('II')
        offsets = [self.unpack('H') for _ in range(self.vector_count())]
        effect, list_index = self.unpack('ii')
        return {'name': name, 'elements': fields, 'dataSize': size, 'alignment': alignment,
                'offsets': offsets, 'effect': effect, 'listIndex': list_index}

    def material_data(self, types):
        count, size = self.unpack('II')
        if count > 64 or size > 4096:
            raise ValueError('Material limits exceeded')
        materials = []
        for _ in range(count):
            index = self.unpack('I')
            if index >= len(types):
                raise ValueError('Invalid material type index')
            values = {}
            for field in types[index]['elements']:
                if field['count'] > 64:
                    raise ValueError('Too many material components')
                fmt = {0:'b',1:'B',2:'h',3:'H',4:'i',5:'I',6:'f',7:'i',10:'i'}.get(field['type'])
                if fmt is None:
                    raise ValueError('Unsupported binding diagnostic field type')
                values[field['name']] = [self.unpack(fmt) for _ in range(field['count'])]
            materials.append({'typeIndex': index, 'values': values})
        return {'declaredDataBytes': size, 'materials': materials}

    def material_list(self):
        self.marker(0)  # RenderingData::MaterialList
        types = [self.material_type() for _ in range(self.vector_count())]
        return {'types': types, **self.material_data(types)}

    def pvs(self):
        self.marker(1)
        cells = self.unpack('I')
        offsets = [self.unpack('h') for _ in range(self.vector_count())]
        size = self.unpack('I')
        count = self.vector_count()
        values = [self.unpack('B') for _ in range(count)]
        return {'cells': cells, 'offsets': offsets, 'cellSize': size, 'data': values}

    def resources(self):
        return [dict(zip(('block','index'),self.unpack('ii'))) for _ in range(self.vector_count())]


def inspect(data: bytes) -> dict:
    if len(data) != FIXTURE_SIZE or hashlib.sha256(data).hexdigest() != FIXTURE_SHA256:
        raise ValueError('Unsupported fixture identity')
    mesh = inspect_mesh(data)
    # SharedTextureList archive follows the Scene's single effect/resource count.
    r = BindingReader(data, 1023)
    r.marker(0); r.marker(0)
    if r.unpack('i') != 2 or r.unpack('I') != 1:
        raise ValueError('Expected PC shared texture list of one texture')
    shared_name, shared_hash = r.string(), r.unpack('I')
    r.marker(0); r.marker(0)
    if r.unpack('i') != 2:
        raise ValueError('Expected PC shared texture')
    texture_name = r.string()
    r.marker(1)
    sampler = dict(zip(('addressU','addressV','addressW','magFilter','minFilter','mipFilter',
                        'maxAnisotropy','maxMipLevel','lodBias','sRGB'), r.unpack('iiiiiiiiiI')))
    texture_hash, size = r.unpack('II')
    payload = r.offset
    if not 28 <= size <= 65536 or payload + size != 2599:
        raise ValueError('Unexpected embedded texture extent')
    width, height, depth, levels, fmt, usage, kind = struct.unpack_from('<7I',data,payload)
    embedded = {'sharedName': shared_name, 'textureName': texture_name, 'sharedHash': shared_hash,
                'textureHash': texture_hash, 'payloadOffset':payload,'payloadBytes':size,
                'payloadSha256':hashlib.sha256(data[payload:payload+size]).hexdigest(),
                'width':width,'height':height,'depth':depth,'levels':levels,'format':fmt,'usage':usage,'type':kind,
                'texelOffset':payload+28,'sampler':sampler}
    r = BindingReader(data, 5897)
    r.marker(0)
    types = [r.material_type() for _ in range(r.vector_count())]
    inline = r.material_data(types)
    if r.offset != 6086:
        raise ValueError(f'Material-type boundary mismatch {r.offset}')
    # Continue exactly after both serialized Primitive objects, not by search.
    r.offset = 6382
    for label in ('instances','instanceBatches','basePrimitives'):
        if r.vector_count():
            raise ValueError(f'Unsupported nonempty {label}')
    constants = r.material_data(types)
    passes = []
    for _ in range(r.vector_count()):
        r.marker(0)
        passes.append(list(r.unpack('6i')))
    bound_counts = []
    for _ in range(3):
        count = r.vector_count();bound_counts.append(count)
        for _ in range(count):
            r.marker(0);r.unpack('8f')
    pvs = [r.pvs() for _ in range(3)]
    room_count = r.vector_count()
    rooms = [r.unpack('I') for _ in range(room_count)]
    if r.vector_count():
        raise ValueError('Unsupported nonempty portal map')
    dynamic=[]
    for _ in range(r.vector_count()):
        dynamic.append(r.material_list())
    source_offsets = {}
    sources = {}
    for name in ('indexBuffer','vertexBuffer','texture'):
        source_offsets[name]=r.offset
        sources[name]=r.resources()
    end = r.offset
    # Original UV0: F16_2 at offset16 of the source's stride20 vertex records.
    uv = [list(struct.unpack_from('<ee',data,2846+i*20+16)) for i in range(100)]
    if not all(math.isfinite(v) for pair in uv for v in pair):
        raise ValueError('Invalid original UV')
    binding=[]
    for draw in mesh['draws']:
        material=draw['streams'][0]['material']
        if material['listIndex']!=0:raise ValueError('Unexpected material source list')
        entry=constants['materials'][material['index']]
        shader=types[entry['typeIndex']]['name']
        if 'g_tAlbedo' not in entry['values']:raise ValueError('Missing albedo')
        index=entry['values']['g_tAlbedo'][0]
        resource=sources['texture'][index]
        if resource!={'block':-1,'index':0}:raise ValueError('Unexpected texture resource')
        binding.append({'primitiveOffset':draw['primitiveOffset'],'streamMaterial':material,'shader':shader,
                        'parameter':'g_tAlbedo','nodeTextureIndex':index,'source':resource,
                        'sharedTextureName':shared_name})
    return {'fixtureOnly':True,'fixtureSha256':FIXTURE_SHA256,'sharedTexture':embedded,
            'constantTypes':types,'inlineTypeData':inline,'constantData':constants,
            'renderPasses':passes,'boundsCounts':bound_counts,'pvs':pvs,'rooms':rooms,
            'dynamicMaterialLists':dynamic,'resourceSourceOffsets':source_offsets,
            'resourceSources':sources,'parsedUntilOffset':end,'bindings':binding,
            'uv0':uv,'uv0Bounds':{'min':[min(p[i] for p in uv) for i in range(2)],
                                  'max':[max(p[i] for p in uv) for i in range(2)]},
            'uv0Float32LEsha256':hashlib.sha256(b''.join(struct.pack('<ff',*p) for p in uv)).hexdigest()}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,default=ROOT/'_work/model-probe/trafficcylinder.model')
    parser.add_argument('--out',type=Path,default=ROOT/'_work/material-binding/trafficcylinder.json')
    args=parser.parse_args()
    result=inspect(args.input.read_bytes())
    args.out.parent.mkdir(parents=True,exist_ok=True)
    data=args.input.read_bytes()
    t=result['sharedTexture']
    raw=data[t['payloadOffset']:t['payloadOffset']+t['payloadBytes']]
    (args.out.parent/'trafficcylinder_diff.rawtexture').write_bytes(raw)
    # Standard standalone wrapper for the exact embedded TextureDesc+texel bytes;
    # this adapter does not change a single descriptor/texel byte.
    def block(name,size,count,kind):
        return struct.pack('<8sIHBB',name.encode(),size,count,kind,0)
    wrapped=block('Texture',56+len(raw),2,0x43)+block('Header',24,0,0x41)+struct.pack('<II',0,0)+block('Data',16+len(raw),0,0x41)+raw
    (args.out.parent/'trafficcylinder_diff.texture').write_bytes(wrapped)
    from PIL import Image
    header=[124,0x1007,t['height'],t['width'],0,0,1]+[0]*11
    header += [32,4,t['format'],0,0,0,0,0,0x1000,0,0,0,0]
    image=Image.open(io.BytesIO(b'DDS '+struct.pack('<31I',*header)+raw[28:])).convert('RGBA')
    image.save(args.out.parent/'trafficcylinder_diff.png')
    (args.out.parent/'trafficcylinder_diff.rgba').write_bytes(image.tobytes())
    result['independentPillowRgbaSha256']=hashlib.sha256(image.tobytes()).hexdigest()
    standalone=[]
    for path in sorted((ROOT/'game-data/Blur/cache').glob('*.pak')):
        index=pak_index(path)
        for row in index.get('entries',[]):
            if row['path'].lower().endswith('\\trafficcylinder_diff.texture'):
                standalone.append({'pak':path.name,**row})
    result['matchingStandaloneTextureInV2Paks']=standalone
    args.out.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in ['uv0','pvs','dynamicMaterialLists']},indent=2))


if __name__=='__main__':main()
