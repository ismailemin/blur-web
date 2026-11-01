"""Independent original level draw binding and a bounded streamed mesh reference."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
from inspect_car_level_assets import Reader,render_layout,resource_prefix,stream_prefix

ROOT=Path(__file__).resolve().parent.parent
LIMIT=16*1024*1024


class NodeReader(Reader):
    def material(self):self.ar();return dict(zip(('index','listIndex'),self.unpack('ii')))
    def stream(self):
        self.ar();value=dict(zip(('vertexBuffer','streamIndex','vertexOffset','frequency'),self.unpack('4i')))
        value['material']=self.material();return value
    def primitive(self):
        start=self.p;version=self.ar(1)
        p=dict(zip(('effect','declaration','topology','indexBuffer','flags'),self.unpack('5i')))
        p['offset']=start;p['baseMaterial']=self.material();p['instanceMaterial']=self.material() if version else None
        self.ar();self.take(24);p['lods']=[]
        for _ in range(self.vec(64)):
            self.ar();p['lods'].append(dict(zip(('offset','indexCount','minIndex','vertexCount'),self.unpack('4I'))))
        p['streams']=[self.stream() for _ in range(self.vec(32))];return p
    def instance(self):
        self.ar();p={'primitiveIndex':self.unpack('i'),'material':self.material()}
        p['streams']=[self.stream() for _ in range(self.vec(32))];p['flags']=self.unpack('I');return p
    def render_list(self):
        base=self.ar(4)
        if base<2:raise ValueError('Legacy level RenderList unsupported')
        node=self.cull();types=self.material_list();schemas=self.material_types
        primitives=[self.primitive() for _ in range(self.vec())]
        instances=[self.instance() for _ in range(self.vec())]
        batches=[]
        for _ in range(self.vec()):self.ar();batches.append({'instance':self.instance(),'stream':self.stream()})
        base_primitives=[self.primitive() for _ in range(self.vec())]
        self.material_data(schemas)
        for _ in range(self.vec()):self.ar();self.take(24)
        for _ in range(3):
            for _ in range(self.vec()):self.bounds()
        for _ in range(3):
            version=self.ar(1);self.take(4)
            if version:self.take(self.vec()*2)
            self.take(4);self.take(self.vec(LIMIT))
        self.take(self.vec()*4)
        for _ in range(self.vec()):self.ar();self.bits();self.bits()
        if base==3:
            self.material_list();self.material_list()
        elif base>3:
            for _ in range(self.vec()):self.material_list()
        sources={};source_offsets={}
        for key in ('indexBuffer','vertexBuffer','texture'):
            source_offsets[key]=self.p
            sources[key]=[dict(zip(('block','index'),self.unpack('ii'))) for _ in range(self.vec())]
        chunks=[]
        for _ in range(self.vec()):
            self.ar();entry={'chunkIndex':self.unpack('i')}
            for key in ('indexBuffer','vertexBuffer','texture'):
                rows=[]
                for _ in range(self.vec()):self.ar();rows.append(dict(zip(('block','index','indexInList'),self.unpack('3i'))))
                entry[key]=rows
            chunks.append(entry)
        return {'name':node['name'],'baseVersion':base,'materials':types,'primitives':primitives,
                'instances':instances,'instanceBatches':batches,'basePrimitives':base_primitives,'sources':sources,'sourceOffsets':source_offsets,'chunkData':chunks,'end':self.p}


def read_render_lists(data:bytes,resources:dict)->list[dict]:
    r=NodeReader(data,resources['firstNodeOffset']);result=[]
    for index in range(resources['nodeCount']):
        start=r.p;tag=r.unpack('B')
        if tag==0:continue
        if tag!=3:raise ValueError('Unsupported level node pointer')
        name=r.string();version=r.ar(4)
        if name=='RenderingData::RenderListNode_Common':
            if version:raise ValueError('Unsupported Target RenderList version')
            node=r.render_list();node.update(nodeIndex=index,nodeOffset=start);result.append(node)
        elif name=='RenderingData::CullNode':
            r.node();r.bounds();r.bits()
            if version>0:r.take(4)
            if version>1:r.bits()
        elif name=='RenderingData::RootNode':r.cull()
        elif name=='RenderingData::GroupNode':r.cull();r.string()
        elif name=='RenderingData::LodNode':r.cull();r.take(r.vec()*4)
        elif name=='RenderingData::Node':r.string();r.take(r.vec()*8+16)
        else:raise ValueError('Unsupported level node '+name)
    return result


def geometry(data:bytes,resources:dict,scene:dict,render:dict,block_index:int)->dict:
    selected=[];used=set()
    for i,p in enumerate(render['primitives']):
        es=[e for e in scene['declarations'][p['declaration']] if e['usage']==0 and e['usageIndex']==0]
        if len(es)!=1:raise ValueError('Unique POSITION declaration required')
        e=es[0];streams=[s for s in p['streams'] if s['streamIndex']==e['stream']]
        if len(streams)!=1:raise ValueError('Unique POSITION stream required')
        stream=streams[0];source=render['sources']['vertexBuffer'][stream['vertexBuffer']]
        ib_source=render['sources']['indexBuffer'][p['indexBuffer']]
        if source['block']!=block_index or ib_source['block']!=block_index:continue
        if source['index']<0 or source['index']>=len(resources['vertexBuffers']) or ib_source['index']<0 or ib_source['index']>=len(resources['indexBuffers']):raise ValueError('External level buffer index invalid')
        vb=resources['vertexBuffers'][source['index']]
        if stream['frequency'] or stream['vertexOffset']<0 or stream['vertexOffset']%vb['stride']:raise ValueError('Unsupported level instance/frequency/byte offset')
        if not any(v['usage']==0 and v['usageIndex']==0 and v['offset']==e['offset'] and v['type']==e['type'] and v['method']==e['method'] for v in vb['elements']):raise ValueError('POSITION declaration does not match external VB')
        selected.append((i,p,stream,source['index'],ib_source['index']));used.add(source['index'])
    if not selected:raise ValueError('No direct primitive uses selected geometry block')
    positions=[];bases={}
    for index in sorted(used):
        vb=resources['vertexBuffers'][index];e=next(e for e in vb['elements'] if e['usage']==0 and e['usageIndex']==0)
        fmt={6:'fff',7:'ffff',9:'eeee'}.get(e['type'])
        if e['method'] or not fmt:raise ValueError('Unsupported level position type')
        bases[index]=len(positions)//3
        for vertex in range(vb['vertexCount']):
            point=struct.unpack_from('<'+fmt,data,vb['dataOffset']+vertex*vb['stride']+e['offset'])
            if not all(math.isfinite(v) for v in point):raise ValueError('Nonfinite level position')
            positions.extend(point[:3])
    indices=[];draws=[]
    for number,p,stream,index,ib_index in selected:
        vb=resources['vertexBuffers'][index];ib=resources['indexBuffers'][ib_index];lod=p['lods'][0]
        shift=stream['vertexOffset']//vb['stride']
        if lod['offset']+lod['indexCount']>ib['count']:raise ValueError('Level LOD outside IB')
        values=[]
        for j in range(lod['indexCount']):
            v=struct.unpack_from('<'+('H' if ib['width']==2 else 'I'),data,ib['dataOffset']+(lod['offset']+j)*ib['width'])[0]
            if v<lod['minIndex'] or v>=lod['minIndex']+lod['vertexCount'] or v+shift>=vb['vertexCount']:raise ValueError('Level index outside declared VB range')
            values.append(bases[index]+v+shift)
        first=len(indices)
        if p['topology'] not in (0,1):raise ValueError('Unsupported level topology')
        step=3 if p['topology']==0 else 1
        if step==3 and len(values)%3:raise ValueError('Invalid level triangle list')
        for j in range(2,len(values),step):
            a,b,c=values[j-2:j+1]
            if p['topology']==1 and j%2:a,b=b,a
            if a==b or b==c or a==c:continue
            indices.extend((a,b,c))
        draws.append({'primitiveIndex':number,'primitiveOffset':p['offset'],'firstIndex':first,'indexCount':len(indices)-first,
                      'declaration':p['declaration'],'topology':p['topology'],'sourceVertexBuffer':index,'sourceIndexBuffer':ib_index})
    return {'positions':positions,'indices':indices,'draws':draws,'vertexCount':len(positions)//3,'triangleCount':len(indices)//3,
            'usedVertexBuffers':sorted(used),'bounds':{'min':[min(positions[a::3]) for a in range(3)],'max':[max(positions[a::3]) for a in range(3)]},
            'positionsFloat32LESha256':hashlib.sha256(struct.pack('<'+'f'*len(positions),*positions)).hexdigest(),
            'indicesUint32LESha256':hashlib.sha256(struct.pack('<'+'I'*len(indices),*indices)).hexdigest()}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--level',choices=['usa_la_river','showroom','spa_barcelona_bowl_multiplayer'],default='usa_la_river')
    parser.add_argument('--chunk',type=int,default=157)
    parser.add_argument('--out-dir',type=Path,default=ROOT/'_work/level-chunk')
    args=parser.parse_args();out=args.out_dir.resolve();game=(ROOT/'game-data/Blur').resolve()
    if out.is_relative_to(game):parser.error('Output cannot be inside game data')
    out.mkdir(parents=True,exist_ok=True)
    level=game/'levels'/args.level;data=(level/'level.levelrender').read_bytes()
    layout=render_layout(data,'level');scene=layout['scene'];records=scene['stream']['chunks']
    if args.chunk<0 or args.chunk>=len(records):parser.error('Chunk index outside Scene table')
    target=records[args.chunk]
    if not target['items'] or target['items'][0]['lod']!=0 or not 1<=target['storedBytes']<=LIMIT:parser.error('Target must start with bounded LOD0')
    block_index=target['items'][0]['block'];stream_file=level/'level.levelstream';stream_size=stream_file.stat().st_size
    def read_record(record,prefix=False):
        if record['offset']>stream_size or record['storedBytes']>stream_size-record['offset'] or record['storedBytes']>LIMIT:raise ValueError('Stream record outside bounds')
        with stream_file.open('rb') as file:file.seek(record['offset']);return file.read(min(record['storedBytes'],64) if prefix else record['storedBytes'])
    chunk_data=read_record(target);stream_prefix(chunk_data,target)
    resources=resource_prefix(chunk_data,{'resourcePayloadOffset':24,'scenePayloadOffset':0},streamed=True)
    (out/'geometry.chunk').write_bytes(chunk_data)
    matches=[];errors=[]
    for i,record in enumerate(records):
        try:
            prefix=read_record(record,True);info=stream_prefix(prefix,record)
            if info.get('firstVertexBufferCount')!=0:continue
            r=Reader(prefix,48)
            if r.vec()!=0 or r.vec()==0:continue
            raw=read_record(record);res=resource_prefix(raw,{'resourcePayloadOffset':24,'scenePayloadOffset':0},streamed=True)
            for render in read_render_lists(raw,res):
                if not any(s['block']==block_index for s in render['sources']['vertexBuffer']):continue
                entry={'nodeChunkIndex':i,'record':record,'renderList':render}
                try:
                    entry['geometry']=geometry(chunk_data,resources,scene,render,block_index)
                    (out/'river-geometry.json').write_text(json.dumps(entry['geometry'])+'\n',encoding='utf-8')
                    (out/f'node-{i}.chunk').write_bytes(raw)
                except ValueError as e:entry['geometryError']=str(e)
                matches.append(entry)
        except (ValueError,StopIteration,struct.error) as e:errors.append({'chunk':i,'error':str(e)})
    report={'level':args.level,'levelRenderSha256':hashlib.sha256(data).hexdigest(),'geometryChunkIndex':args.chunk,
            'geometryRecord':target,'geometryChunkSha256':hashlib.sha256(chunk_data).hexdigest(),'resourceBlockIndex':block_index,
            'resources':resources,'matches':matches,'inspectionErrors':errors}
    (out/'reference.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'level':args.level,'block':block_index,'vertices':[v['vertexCount'] for v in resources['vertexBuffers']],
                     'matches':[{'nodeChunk':m['nodeChunkIndex'],'nodeIndex':m['renderList']['nodeIndex'],'primitives':len(m['renderList']['primitives']),
                                 'instances':len(m['renderList']['instances']),'basePrimitives':len(m['renderList']['basePrimitives']),
                                 'geometry':{k:v for k,v in m.get('geometry',{}).items() if k not in ['positions','indices','draws']},
                                 'geometryError':m.get('geometryError')} for m in matches],
                     'inspectionErrors':errors[:10],'errorCount':len(errors)},indent=2))


if __name__=='__main__':main()
