"""Read-only car/level inventory and source-shaped Scene/stream dependency diagnostic."""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess
from inspect_asset_layout import pak_index
from prepare_asset_fixture import decode_packet_zlib

ROOT=Path(__file__).resolve().parent.parent
LIMIT=16*1024*1024


class Reader:
    def __init__(self,data:bytes,start=0,end=None):self.b,self.p,self.end=data,start,len(data) if end is None else end
    def need(self,n):
        if n<0 or self.p>self.end or n>self.end-self.p:raise ValueError(f'Truncated data at {self.p}')
    def take(self,n):self.need(n);start=self.p;self.p+=n;return self.b[start:self.p]
    def unpack(self,fmt):
        n=struct.calcsize('<'+fmt);v=struct.unpack('<'+fmt,self.take(n));return v[0] if len(v)==1 else v
    def count(self,maximum=100000):
        n=self.unpack('I')
        if n>maximum:raise ValueError(f'Collection limit {n} at {self.p-4}')
        return n
    def ar(self,maximum=0):
        tag,version=self.unpack('2sH')
        if tag!=b'RA' or version>maximum:raise ValueError(f'Unsupported object marker/version {tag!r}/{version} at {self.p-4}')
        return version
    def vec(self,maximum=100000):self.ar();return self.count(maximum)
    def string(self):return self.take(self.count(4096)).decode('utf-8').rstrip('\0')
    def bits(self):
        self.ar();bits=self.count(8*LIMIT);size=self.vec(LIMIT)
        if size<(bits+7)//8:raise ValueError('Bit vector byte buffer smaller than bit count')
        self.take(size);return {'bits':bits,'bufferBytes':size}
    def bounds(self):self.ar();return list(self.unpack('8f'))
    def node(self):
        self.ar();name=self.string();self.take(self.vec()*8);self.take(16);return name
    def cull(self):
        version=self.ar(2);name=self.node();bounds=self.bounds();pvs=self.bits()
        if version>0:self.take(4)
        if version>1:self.bits()
        return {'name':name,'bounds':bounds,'pvs':pvs}
    def texture(self):
        self.ar();self.ar()
        if self.unpack('I')!=2:raise ValueError('Expected PC texture platform')
        name=self.string();version=self.ar(1);self.take(40 if version else 36)
        digest,size=self.unpack('II');self.need(size)
        offset=self.p;self.take(size)
        return {'name':name,'hash':digest,'dataOffset':offset,'dataBytes':size}
    def material_list(self,target=False):
        if target:self.ar()
        self.ar();types=[]
        for _ in range(self.vec(4096)):
            self.ar();name=self.string();fields=[]
            for _ in range(self.vec(4096)):
                self.ar();field=self.string();kind,n=self.unpack('iI');fields.append((kind,n))
            self.take(8);self.take(self.vec(4096)*2);self.take(8);types.append((name,fields))
        self.material_types=types
        count,declared=self.material_data(types)
        return {'types':[name for name,_ in types],'materialCount':count,'declaredBytes':declared}
    def material_data(self,types):
        count,declared=self.unpack('II')
        if count>10000 or declared>LIMIT:raise ValueError('Material payload limits')
        for _ in range(count):
            index=self.count(len(types)-1)
            for kind,n in types[index][1]:
                if n>4096:raise ValueError('Material components limit')
                if kind in (8,9):
                    for _ in range(n):self.ar();self.take(8)
                else:
                    size={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:4,10:4}.get(kind)
                    if size is None:raise ValueError('Unknown material type')
                    self.take(n*size)
        return count,declared
    def chunk_info(self):
        start=self.p;version=self.ar(1);bounds=self.bounds();items=[]
        for _ in range(self.vec()):self.ar();items.append(dict(zip(('block','lod'),self.unpack('ii'))))
        lists={}
        for key in ('blocks','prerequisites','dependants'):lists[key]=[self.unpack('i') for _ in range(self.vec())]
        offset,stored=self.unpack('QQ');logical=self.unpack('Q') if version else stored
        return {'archiveOffset':start,'bounds':bounds,'items':items,**lists,'offset':offset,'storedBytes':stored,'logicalBytes':logical}
    def stream_data(self):
        start=self.p;self.ar();version=self.ar(3)
        chunks=[self.chunk_info() for _ in range(self.vec())]
        pvs=[self.bits() for _ in range(self.vec())]
        bounds=[];groups=[];rooms=[]
        if version>0:
            bounds=[self.bounds() for _ in range(self.vec())]
            groups=[self.bits() for _ in range(self.vec())]
        if version>1:rooms=[self.bits() for _ in range(self.vec())]
        chunk_version=self.unpack('i') if version>2 else 0
        return {'archiveOffset':start,'version':version,'chunkVersion':chunk_version,'chunks':chunks,
                'pvsCount':len(pvs),'boundsCount':len(bounds),'groupCount':len(groups),'roomCount':len(rooms)}


def chunk(data:bytes,offset:int,end:int)->dict:
    if offset<0 or offset+16>end:raise ValueError('Truncated FileBlock')
    name,size,count,kind,compression=struct.unpack_from('<8sIHBB',data,offset)
    if size<16 or offset+size>end or kind not in (0x41,0x43) or compression:raise ValueError('Unsupported FileBlock')
    return {'id':name.split(b'\0',1)[0].decode('ascii'),'offset':offset,'bytes':size,'count':count,'type':kind,'end':offset+size,'payload':offset+16}


def children(data:bytes,parent:dict,opaque=False)->list[dict]:
    if parent['type']!=0x43 and not opaque:raise ValueError('Expected FileBlock container')
    at=parent['payload'];result=[]
    while at<parent['end']:
        child=chunk(data,at,parent['end']);result.append(child);at=child['end']
        if len(result)>1000:raise ValueError('Too many FileBlock children')
    if at!=parent['end'] or (parent['type']==0x43 and len(result)!=parent['count']):raise ValueError('FileBlock child count mismatch')
    return result


def scene_header(data:bytes,scene:dict)->dict:
    r=Reader(data,scene['payload'],scene['end'])
    if r.take(4)!=b'ARCH' or r.unpack('II')!=(1,0) or r.take(4)!=b'ARCH' or r.unpack('I')!=0:
        raise ValueError('Unsupported ARCH envelope')
    file_version=r.unpack('I');target_version=r.ar(1);r.ar()
    if r.unpack('i')!=2:raise ValueError('Expected PC scene')
    r.ar();name=r.string();r.ar();root=r.cull()
    declarations=[]
    for _ in range(r.vec(256)):
        r.ar();elements=[]
        for _ in range(r.count(32)):
            r.ar();elements.append(dict(zip(('stream','offset','type','method','usage','usageIndex'),r.unpack('hhiiib'))))
        declarations.append(elements)
    effects=[]
    for _ in range(r.vec(256)):r.ar();r.ar();effects.append(r.string())
    blocks=r.count(100000)
    r.ar();r.ar()
    if r.unpack('i')!=2:raise ValueError('Expected PC shared texture list')
    shared=[]
    for _ in range(r.count(10000)):
        shared_name=r.string();shared_hash=r.unpack('I');shared.append({'sharedName':shared_name,'sharedHash':shared_hash,**r.texture()})
    stream=r.stream_data()
    dynamic=[]
    if target_version>0:
        for _ in range(r.vec(256)):
            tag=r.unpack('B')
            if tag==0:dynamic.append(None)
            elif tag==2:dynamic.append(r.material_list(target=True))
            else:raise ValueError(f'Unsupported scene dynamic material pointer {tag}')
    loaded=r.unpack('B')*blocks if file_version==0 else r.count(100000)
    if loaded>blocks:raise ValueError('Loaded resource count exceeds declared blocks')
    return {'name':name,'scenePayloadOffset':scene['payload'],'fileVersion':file_version,'targetVersion':target_version,
            'root':root,'declarationElementCounts':[len(d) for d in declarations],'declarations':declarations,'effects':effects,'resourceBlockCount':blocks,
            'sharedTextures':shared,'stream':stream,'dynamicMaterialLists':dynamic,'loadedResourceBlocks':loaded,
            'resourcePayloadOffset':r.p}


def render_layout(data:bytes,kind:str)->dict:
    if data[:4]!=b'  CP':raise ValueError('Expected PC file marker')
    outer=chunk(data,4,len(data))
    if kind=='model':
        wrapper=next(c for c in children(data,outer) if c['id']=='Render')
        render=chunk(data,wrapper['payload'],wrapper['end'])
    else:render=outer
    if render['id']!='Render':raise ValueError('Missing Render root')
    chunks=children(data,render,opaque=render['type']==0x41)
    header=next(c for c in chunks if c['id']=='Header')
    version=struct.unpack_from('<I',data,header['payload'])[0]
    effect_variation=None
    if kind=='level' and version>=1:
        hr=Reader(data,header['payload']+4,header['end']);effect_variation=hr.string()
        if hr.p!=header['end']:raise ValueError('EffectVariation header size mismatch')
    scene=next(c for c in chunks if c['id']=='Scene')
    return {'outer':outer,'render':render,'chunks':chunks,'renderVersion':version,'effectVariation':effect_variation,
            'scene':scene_header(data,scene)}


def resource_prefix(data:bytes,scene:dict,streamed=False)->dict:
    r=Reader(data,scene['resourcePayloadOffset'])
    lods=None
    if not streamed:
        r.ar();r.ar()
        if r.unpack('I')!=2:raise ValueError('Expected PC resource block')
        lods=r.count(64)
    r.ar();r.ar()
    if r.unpack('II')!=(2,0):raise ValueError('Expected PC LOD0 resources')
    vbs=[]
    for _ in range(r.vec(256)):
        if r.unpack('B')!=2:raise ValueError('Expected non-null vertex buffer')
        version=r.ar(1);r.ar();stride=r.count(4096);elements=[]
        for _ in range(r.vec(32)):
            r.ar();elements.append(dict(zip(('type','method','usage','usageIndex'),r.unpack('4i'))))
        offsets=[r.unpack('H') for _ in range(r.vec(32))]
        if len(offsets)!=len(elements):raise ValueError('Vertex element offsets mismatch')
        for element,offset in zip(elements,offsets):element['offset']=offset
        count=r.count(1000000);size=stride*count;blob=None
        if version:
            r.ar();stored,alignment,compression=r.unpack('III');swap=r.unpack('B')
            if stored!=size or alignment<1 or alignment>4096 or alignment&(alignment-1) or compression or swap:raise ValueError('Unsupported VB blob layout')
            relative=r.p-scene['scenePayloadOffset'];r.take((-relative)%alignment)
            blob={'alignment':alignment,'compression':compression}
        start=r.p;r.take(size)
        vbs.append({'stride':stride,'vertexCount':count,'elements':elements,'dataOffset':start,'dataBytes':size,'blob':blob})
    ibs=[]
    for _ in range(r.vec(256)):
        if r.unpack('B')!=2:raise ValueError('Expected non-null index buffer')
        version=r.ar(1);count,kind=r.unpack('II')
        if kind not in (0,1) or count>6000000:raise ValueError('Index type/count limit')
        size=count*(2 if kind==0 else 4)
        if version:
            r.ar();stored,alignment,compression=r.unpack('III');swap=r.unpack('B')
            if stored!=size or alignment<1 or alignment>4096 or alignment&(alignment-1) or compression or swap:raise ValueError('Unsupported IB blob layout')
            relative=r.p-scene['scenePayloadOffset'];r.take((-relative)%alignment)
        start=r.p;r.take(size);ibs.append({'count':count,'width':2 if kind==0 else 4,'dataOffset':start,'dataBytes':size})
    nodes=r.vec(100000)
    return {'lodCount':lods,'vertexBuffers':vbs,'indexBuffers':ibs,'nodeCount':nodes,'firstNodeOffset':r.p}


def native_probe(path:Path)->dict:
    exe=ROOT/'_work/build/asset-reader-native/Release/scene_inspect.exe'
    if not exe.exists():return {'status':'unavailable'}
    process=subprocess.run([str(exe),str(path)],capture_output=True,text=True,check=False)
    result=json.loads(process.stdout)
    return {'exitCode':process.returncode,'status':result['status'],'error':result.get('error'),
            'vertices':len(result.get('positions',[]))//3,'triangles':len(result.get('indices',[]))//3,
            'metadata':result.get('metadata')}


def car_position_reference(data:bytes,resources:dict)->dict:
    positions=[];buffers=[]
    for index,vb in enumerate(resources['vertexBuffers']):
        element=next(e for e in vb['elements'] if e['usage']==0 and e['usageIndex']==0)
        formats={6:'fff',7:'ffff',9:'eeee'}
        if element['method']!=0 or element['type'] not in formats:raise ValueError('Unsupported independent position format')
        fmt=formats[element['type']];values=[]
        for vertex in range(vb['vertexCount']):
            point=struct.unpack_from('<'+fmt,data,vb['dataOffset']+vertex*vb['stride']+element['offset'])
            if not all(math.isfinite(v) for v in point):raise ValueError('Nonfinite position')
            values.append(point)
            positions.extend(point[:3])
        buffers.append({'index':index,'element':element,'stride':vb['stride'],'count':vb['vertexCount'],
                        'bounds':[[min(p[a] for p in values),max(p[a] for p in values)] for a in range(3)],
                        'fourthComponents':dict(Counter(p[3] for p in values)) if len(values[0])==4 else None})
    raw=struct.pack('<'+'f'*len(positions),*positions)
    return {'vertexCount':len(positions)//3,'xyzFloat32LESha256':hashlib.sha256(raw).hexdigest(),
            'buffers':buffers,'positions':positions}


def first_render_list(data:bytes,resources:dict)->dict:
    r=Reader(data,resources['firstNodeOffset'])
    def cull_remainder(version):
        name=r.node();r.bounds();r.bits()
        if version>0:r.take(4)
        if version>1:r.bits()
        return name
    def material():r.ar();return dict(zip(('index','listIndex'),r.unpack('ii')))
    for index in range(resources['nodeCount']):
        tag=r.unpack('B')
        if tag==0:continue
        if tag!=3:raise ValueError('Unsupported node pointer tag')
        typename=r.string();version=r.ar(4)
        if typename=='RenderingData::RenderListNode_Common':
            if version!=0:raise ValueError('Unsupported target RenderList version')
            base_version=r.ar(4);node=r.cull();materials=r.material_list();types=r.material_types;primitives=[]
            for _ in range(r.vec()):
                start=r.p;primitive_version=r.ar(1)
                effect,declaration,topology,ib,flags=r.unpack('5i')
                base_material=material();instance_material=material() if primitive_version else None
                r.ar();r.take(24)
                lods=[]
                for _ in range(r.vec(64)):
                    r.ar();lods.append(dict(zip(('offset','indexCount','minIndex','vertexCount'),r.unpack('4I'))))
                streams=[]
                for _ in range(r.vec(32)):
                    r.ar();stream=dict(zip(('vertexBuffer','streamIndex','vertexOffset','frequency'),r.unpack('4i')))
                    stream['material']=material();streams.append(stream)
                primitives.append({'offset':start,'end':r.p,'effect':effect,'declaration':declaration,'topology':topology,
                                   'indexBuffer':ib,'flags':flags,'baseMaterial':base_material,'instanceMaterial':instance_material,
                                   'lods':lods,'streams':streams})
            end=r.p
            for _ in range(3):
                if r.vec():raise ValueError('Nonempty instances/base-primitives not implemented in independent car tail')
            r.material_data(types)
            for _ in range(r.vec()):r.ar();r.take(24)
            for _ in range(3):
                for _ in range(r.vec()):r.bounds()
            for _ in range(3):
                version=r.ar(1);r.take(4)
                if version:r.take(r.vec()*2)
                r.take(4);r.take(r.vec(LIMIT))
            r.take(r.vec()*4)
            for _ in range(r.vec()):r.ar();r.bits();r.bits()
            for _ in range(r.vec()):r.material_list()
            sources={}
            for name in ('indexBuffer','vertexBuffer','texture'):
                sources[name]=[dict(zip(('block','index'),r.unpack('ii'))) for _ in range(r.vec())]
            return {'nodeIndex':index,'nodeName':node['name'],'baseVersion':base_version,'materials':materials,
                    'primitives':primitives,'primitivesEnd':end,'sources':sources,'sourcesEnd':r.p}
        if typename=='RenderingData::RootNode':r.cull()
        elif typename=='RenderingData::CullNode':cull_remainder(version)
        elif typename=='RenderingData::GroupNode':r.cull();r.string()
        elif typename=='RenderingData::Node':r.string();r.take(r.vec()*8+16)
        else:raise ValueError('Unsupported pre-render-list node '+typename)
    raise ValueError('No render list found')


def car_geometry_reference(data:bytes,scene:dict,resources:dict,render_list:dict)->dict:
    bindings=[];used=set()
    for p in render_list['primitives']:
        declaration=scene['declarations'][p['declaration']]
        position=[e for e in declaration if e['usage']==0 and e['usageIndex']==0]
        if len(position)!=1:raise ValueError('POSITION declaration must be unique')
        e=position[0]
        streams=[s for s in p['streams'] if s['streamIndex']==e['stream']]
        if len(streams)!=1 or any(s['frequency'] for s in p['streams']):raise ValueError('Unsupported stream/instancing binding')
        stream=streams[0];source=render_list['sources']['vertexBuffer'][stream['vertexBuffer']]
        if source['block']!=0 or source['index']<0:raise ValueError('External POSITION source')
        vb=resources['vertexBuffers'][source['index']]
        if not any(x['type']==e['type'] and x['method']==e['method'] and x['usage']==0 and x['usageIndex']==0 and x['offset']==e['offset'] for x in vb['elements']):raise ValueError('POSITION declaration and VB format disagree')
        if stream['vertexOffset']<0 or stream['vertexOffset']%vb['stride']:raise ValueError('Unaligned POSITION byte offset')
        bindings.append((p,stream,source['index']));used.add(source['index'])
    positions=[];bases={}
    for index in sorted(used):
        vb=resources['vertexBuffers'][index];e=next(e for e in vb['elements'] if e['usage']==0 and e['usageIndex']==0)
        fmt={6:'fff',7:'ffff',9:'eeee'}[e['type']];bases[index]=len(positions)//3
        for vertex in range(vb['vertexCount']):
            point=struct.unpack_from('<'+fmt,data,vb['dataOffset']+vertex*vb['stride']+e['offset'])
            if not all(math.isfinite(v) for v in point):raise ValueError('Nonfinite source position')
            positions.extend(point[:3])
    indices=[];draws=[]
    for p,stream,index in bindings:
        source=render_list['sources']['indexBuffer'][p['indexBuffer']]
        if source['block']!=0 or source['index']<0:raise ValueError('External index source')
        ib=resources['indexBuffers'][source['index']];vb=resources['vertexBuffers'][index];lod=p['lods'][0]
        if lod['offset']+lod['indexCount']>ib['count']:raise ValueError('LOD exceeds IB')
        fmt='H' if ib['width']==2 else 'I';shift=stream['vertexOffset']//vb['stride'];values=[]
        for j in range(lod['indexCount']):
            v=struct.unpack_from('<'+fmt,data,ib['dataOffset']+(lod['offset']+j)*ib['width'])[0]
            if v<lod['minIndex'] or v>=lod['minIndex']+lod['vertexCount'] or v+shift>=vb['vertexCount']:raise ValueError('LOD index outside declared VB range')
            values.append(bases[index]+shift+v)
        first=len(indices)
        if p['topology'] not in (0,1):raise ValueError('Unsupported topology')
        step=3 if p['topology']==0 else 1
        if step==3 and len(values)%3:raise ValueError('Invalid triangle list')
        for j in range(2,len(values),step):
            a,b,c=values[j-2:j+1]
            if p['topology']==1 and j%2:a,b=b,a
            if a==b or b==c or a==c:continue
            indices.extend((a,b,c))
        draws.append({'primitiveOffset':p['offset'],'firstIndex':first,'indexCount':len(indices)-first,
                      'globalVertexBuffer':index,'sourceByteOffset':stream['vertexOffset'],'declaration':p['declaration']})
    return {'source':'source-shaped first RenderList base primitives LOD0; undeformed object-local',
            'usedGlobalVertexBuffers':sorted(used),'positions':positions,'indices':indices,'draws':draws,
            'vertexCount':len(positions)//3,'triangleCount':len(indices)//3,
            'bounds':{'min':[min(positions[a::3]) for a in range(3)],'max':[max(positions[a::3]) for a in range(3)]},
            'positionsFloat32LESha256':hashlib.sha256(struct.pack('<'+'f'*len(positions),*positions)).hexdigest(),
            'indicesUint32LESha256':hashlib.sha256(struct.pack('<'+'I'*len(indices),*indices)).hexdigest()}


def stream_prefix(data:bytes,record:dict)->dict:
    r=Reader(data)
    if r.take(4)!=b'ARCH' or r.unpack('II')!=(1,0) or r.take(4)!=b'ARCH' or r.unpack('I')!=0:raise ValueError('Unsupported stream ARCH envelope')
    count=r.count(100000)
    if count!=len(record['items']):raise ValueError('Stream item count differs from Scene ChunkInfo')
    if not count:return {'itemCount':0}
    r.ar();r.ar();platform,lod=r.unpack('Ii')
    if platform!=2 or lod!=record['items'][0]['lod']:raise ValueError('Stream first item platform/LOD mismatch')
    result={'itemCount':count,'firstItem':record['items'][0],'firstItemLod':lod}
    if lod==0:result['firstVertexBufferCount']=r.vec(256)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out-dir',type=Path,default=ROOT/'_work/car-level-assets')
    args=parser.parse_args();out=args.out_dir.resolve();game=(ROOT/'game-data/Blur').resolve()
    if out.is_relative_to(game):parser.error('Output cannot be inside game data')
    out.mkdir(parents=True,exist_ok=True)
    root=pak_index(game/'cache/root.pak');stream=pak_index(game/'cache/root_streaming.pak')
    cars=sorted([r for r in root['entries'] if r['path'].startswith('\\models\\vehicles\\') and r['path'].endswith('.model') and '\\wheels\\' not in r['path']],key=lambda r:r['logical_bytes'])
    result={'rootStreaming':{'codec':stream['codec_name'],'fileExtensions':dict(Counter(Path(r['path']).suffix for r in stream['entries'] if not r['directory']))},
            'carCandidates':cars,'carFixtures':[],'levels':[]}
    for name in ('default.model','corvette_c3_race.model'):
        row=next(r for r in cars if r['path']=='\\models\\vehicles\\'+name)
        with (game/'cache/root.pak').open('rb') as file:file.seek(row['offset']);packed=file.read(row['stored_bytes'])
        decoded=decode_packet_zlib(packed,row['logical_bytes']);digest=hashlib.sha256(decoded).hexdigest()
        target=out/(name+'.decoded');target.write_bytes(decoded)
        evidence={'pak':'root.pak',**row,'sha256':digest,'decodedFile':str(target),'native':native_probe(target)}
        try:
            evidence['layout']=render_layout(decoded,'model')
            evidence['resources']=resource_prefix(decoded,evidence['layout']['scene'])
            evidence['firstRenderList']=first_render_list(decoded,evidence['resources'])
            positions=car_position_reference(decoded,evidence['resources'])
            (out/(name+'.positions.json')).write_text(json.dumps(positions)+'\n',encoding='utf-8')
            evidence['positionReference']={k:v for k,v in positions.items() if k!='positions'}
            geometry=car_geometry_reference(decoded,evidence['layout']['scene'],evidence['resources'],evidence['firstRenderList'])
            geometry_name='corvette-geometry.json' if name=='corvette_c3_race.model' else 'default-geometry.json'
            (out/geometry_name).write_text(json.dumps(geometry)+'\n',encoding='utf-8')
            evidence['geometryReference']={k:v for k,v in geometry.items() if k not in ('positions','indices','draws')}
        except (ValueError,StopIteration,struct.error) as e:evidence['layoutError']=str(e)
        result['carFixtures'].append(evidence)
    for folder in sorted((game/'levels').iterdir()):
        file=folder/'level.levelrender'
        if not file.exists() or file.stat().st_size>LIMIT:continue
        data=file.read_bytes();record={'level':folder.name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),
                                     'streamBytes':(folder/'level.levelstream').stat().st_size if (folder/'level.levelstream').exists() else None}
        try:
            record['layout']=render_layout(data,'level')
            record['firstResources']=resource_prefix(data,record['layout']['scene'])
            chunks=record['layout']['scene']['stream']['chunks']
            if record['streamBytes'] is not None:
                for c in chunks:
                    if c['offset']>record['streamBytes'] or c['storedBytes']>record['streamBytes']-c['offset']:raise ValueError('Stream chunk outside companion file')
                record['streamRangesValidated']=True
                prefixes=[]
                with (folder/'level.levelstream').open('rb') as f:
                    for i,c in enumerate(chunks):
                        f.seek(c['offset']);prefix=f.read(min(64,c['storedBytes']))
                        prefixes.append({'chunkIndex':i,**stream_prefix(prefix,c)})
                record['streamPrefixes']=prefixes
                candidates=[p for p in prefixes if p.get('firstVertexBufferCount',0)>0]
                if candidates and folder.name in ('showroom','spa_barcelona_bowl_multiplayer','usa_la_river'):
                    chosen=min(candidates,key=lambda p:chunks[p['chunkIndex']]['storedBytes'])
                    c=chunks[chosen['chunkIndex']]
                    record['smallestFirstItemGeometryChunk']={**chosen,**c}
                    if c['storedBytes']<=LIMIT:
                        with (folder/'level.levelstream').open('rb') as f:f.seek(c['offset']);block=f.read(c['storedBytes'])
                        (out/(folder.name+'.geometry-chunk.bin')).write_bytes(block)
                        record['smallestFirstItemGeometryChunk']['sha256']=hashlib.sha256(block).hexdigest()
                        try:
                            resources=resource_prefix(block,{'resourcePayloadOffset':24,'scenePayloadOffset':0},streamed=True)
                            record['geometryChunkFirstResources']=resources
                            record['geometryChunkFirstRenderList']=first_render_list(block,resources)
                        except (ValueError,StopIteration,struct.error) as e:record['geometryChunkInspectionError']=str(e)
                if folder.name=='showroom' and chunks:
                    c=chunks[0]
                    if c['storedBytes']<=LIMIT:
                        with (folder/'level.levelstream').open('rb') as f:f.seek(c['offset']);block=f.read(c['storedBytes'])
                        (out/'showroom.chunk0.bin').write_bytes(block)
                        record['firstChunkSha256']=hashlib.sha256(block).hexdigest()
                        record['firstChunkPrefixHex']=block[:48].hex()
        except (ValueError,StopIteration,struct.error) as e:record['layoutError']=str(e)
        result['levels'].append(record)
    (out/'inventory.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'rootStreaming':result['rootStreaming'],
                     'cars':[{k:v for k,v in c.items() if k not in ('layout','resources','firstRenderList','positionReference')} for c in result['carFixtures']],
                     'levels':[{'name':r['level'],'bytes':r['bytes'],'error':r.get('layoutError'),
                                'blocks':r.get('layout',{}).get('scene',{}).get('resourceBlockCount'),
                                'chunks':len(r.get('layout',{}).get('scene',{}).get('stream',{}).get('chunks',[]))} for r in result['levels']]},indent=2))


if __name__=='__main__':main()
