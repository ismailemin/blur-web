"""Bounded source-shaped level instance and constant transform diagnostic."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import struct
import math
from copy import deepcopy
from collections import Counter
from inspect_car_level_assets import render_layout, resource_prefix, stream_prefix
from inspect_car_materials import MaterialReader, texture_lod
from inspect_level_chunk import NodeReader

ROOT=Path(__file__).resolve().parent.parent
LIMIT=16*1024*1024

class InstanceReader(MaterialReader):
    material=NodeReader.material
    stream=NodeReader.stream
    primitive=NodeReader.primitive
    instance=NodeReader.instance

    def render_list(self):
        version=self.ar(4)
        if version<2:raise ValueError('Legacy RenderList unsupported')
        node=self.cull();inline=self.material_list()
        primitives=[self.primitive() for _ in range(self.vec())]
        instances=[self.instance() for _ in range(self.vec())]
        batches=[]
        for _ in range(self.vec()):self.ar();batches.append({'instance':self.instance(),'stream':self.stream()})
        bases=[self.primitive() for _ in range(self.vec())]
        constants=self.material_data(inline['types'])
        for _ in range(self.vec()):self.ar();self.take(24)
        bounds={key:[self.bounds() for _ in range(self.vec())] for key in ('primitive','instance','batch')}
        for _ in range(3):
            v=self.ar(1);self.take(4)
            if v:self.take(self.vec()*2)
            self.take(4);self.take(self.vec(LIMIT))
        self.take(self.vec()*4)
        for _ in range(self.vec()):self.ar();self.bits();self.bits()
        dynamic=[self.material_list() for _ in range(2 if version==3 else self.vec(256) if version>3 else 0)]
        sources={key:[dict(zip(('block','index'),self.unpack('ii'))) for _ in range(self.vec())] for key in ('indexBuffer','vertexBuffer','texture')}
        for _ in range(self.vec()):
            self.ar();self.take(4)
            for _ in range(3):
                for _ in range(self.vec()):self.ar();self.take(12)
        return {'name':node['name'],'primitives':primitives,'instances':instances,'batches':batches,
                'basePrimitives':bases,'constants':constants['materials'],'inline':inline,'dynamic':dynamic,
                'sources':sources,'bounds':bounds,'end':self.p}

def read_lists(data,resources):
    r=InstanceReader(data,resources['firstNodeOffset']);out=[]
    for index in range(resources['nodeCount']):
        tag=r.unpack('B')
        if tag==0:continue
        if tag!=3:raise ValueError('Unsupported node pointer')
        name=r.string();version=r.ar(4)
        if name=='RenderingData::RenderListNode_Common':
            if version:raise ValueError('Unsupported target RenderList')
            out.append(dict(nodeIndex=index,**r.render_list()))
        elif name=='RenderingData::CullNode':
            r.node();r.bounds();r.bits()
            if version>0:r.take(4)
            if version>1:r.bits()
        elif name=='RenderingData::RootNode':r.cull()
        elif name=='RenderingData::GroupNode':r.cull();r.string()
        elif name=='RenderingData::LodNode':r.cull();r.take(r.vec()*4)
        elif name=='RenderingData::Node':r.string();r.take(r.vec()*8+16)
        else:raise ValueError('Unsupported node '+name)
    resources['parsedNodesEnd']=r.p
    return out

def constant_world(node,instance,primitive):
    matrix=None;trace=[]
    def apply(ref,stack=()):
        nonlocal matrix
        if ref['listIndex']!=0:raise ValueError('Runtime material transform unsupported')
        index=ref['index']
        if index<0 or index>=len(node['constants']):raise ValueError('Constant index out of bounds')
        if index in stack or len(stack)>=32:raise ValueError('Recursive material transform')
        for field in node['constants'][index]['fields']:
            if field['type']==8:
                for child in field['values']:apply(child,stack+(index,))
            elif field['name']=='g_mWorld':
                if field['type']!=6 or field['count']!=16 or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in field['values']):raise ValueError('Unsupported world matrix field')
                matrix=field['values'];trace.append({'material':index,'serializedOffset':field['serializedOffset']})
    apply(instance['material'])
    for stream in instance['streams']:
        if stream['streamIndex']!=-1:apply(stream['material'])
    apply(primitive['baseMaterial'])
    for stream in primitive['streams']:
        if stream['streamIndex']!=-1:apply(stream['material'])
    if matrix is None:raise ValueError('No explicit constant world matrix')
    if matrix[3]!=0 or matrix[7]!=0 or matrix[11]!=0 or matrix[15]!=1:raise ValueError('Only affine world matrices supported')
    return matrix,trace

def read_geometry_block(directory,records,block):
    matches=[(i,c) for i,c in enumerate(records) if {'block':block,'lod':0} in c['items']]
    if len(matches)!=1:raise ValueError('Ambiguous/missing geometry record')
    number,record=matches[0]
    if not 24<=record['storedBytes']<=LIMIT:raise ValueError('Geometry chunk size limit')
    source=directory/'level.levelstream'
    if record['offset']+record['storedBytes']>source.stat().st_size:raise ValueError('Geometry range outside stream')
    with source.open('rb') as stream:stream.seek(record['offset']);data=stream.read(record['storedBytes'])
    stream_prefix(data,record);cursor=24;parsed=[]
    for item in record['items']:
        if item['lod']!=0:raise ValueError('Target not in initial LOD0 resource run')
        start=cursor;resources=resource_prefix(data,{'resourcePayloadOffset':cursor,'scenePayloadOffset':0},streamed=True)
        read_lists(data,resources);r=InstanceReader(data,resources['parsedNodesEnd'])
        for _ in range(r.count(16)):texture_lod(r,0,0)
        cursor=r.p;parsed.append({'block':item['block'],'start':start,'end':cursor})
        if item['block']==block:return data,resources,{'chunkIndex':number,'record':record,'parsedResourcePrefixes':parsed,'sha256':hashlib.sha256(data).hexdigest()}
    raise ValueError('Geometry block absent from item order')

def first_instance_proof(directory,scene,node,out):
    instance=node['instances'][0];primitive=node['basePrimitives'][instance['primitiveIndex']]
    declaration=scene['declarations'][primitive['declaration']]
    element=next(e for e in declaration if e['usage']==0 and e['usageIndex']==0)
    streams={s['streamIndex']:s for s in instance['streams'] if s['streamIndex']!=-1}
    streams.update({s['streamIndex']:s for s in primitive['streams'] if s['streamIndex']!=-1})
    stream=streams[element['stream']]
    vb_source=node['sources']['vertexBuffer'][stream['vertexBuffer']]
    ib_source=node['sources']['indexBuffer'][primitive['indexBuffer']]
    if vb_source['block']!=ib_source['block']:raise ValueError('Proof requires same VB/IB resource block')
    raw,resources,provenance=read_geometry_block(directory,scene['stream']['chunks'],vb_source['block'])
    (out/'instance-geometry.chunk').write_bytes(raw)
    vb=resources['vertexBuffers'][vb_source['index']];ib=resources['indexBuffers'][ib_source['index']]
    if stream['frequency'] or stream['vertexOffset']<0 or stream['vertexOffset']%vb['stride']:raise ValueError('Unsupported instance stream offset/frequency')
    position=next(e for e in vb['elements'] if e['usage']==0 and e['usageIndex']==0)
    if any(position[k]!=element[k] for k in ('type','method','offset')):raise ValueError('Declaration mismatch')
    fmt={6:'fff',9:'eeee'}.get(element['type'])
    if not fmt or element['method']:raise ValueError('Unsupported instance position format')
    lod=primitive['lods'][0]
    if lod['offset']+lod['indexCount']>ib['count']:raise ValueError('LOD outside index buffer')
    source_indices=list(struct.unpack_from('<'+('H' if ib['width']==2 else 'I')*lod['indexCount'],raw,ib['dataOffset']+lod['offset']*ib['width']))
    if primitive['topology'] not in (0,1):raise ValueError('Unsupported topology')
    if primitive['topology']==0 and len(source_indices)%3:raise ValueError('Incomplete triangle list')
    indices=[]
    for j in range(2,len(source_indices),3 if primitive['topology']==0 else 1):
        a,b,c=source_indices[j-2:j+1]
        if primitive['topology']==1 and j%2:a,b=b,a
        if len({a,b,c})==3:indices.extend((a,b,c))
    used=sorted(set(indices));matrix,trace=constant_world(node,instance,primitive)
    local=[];world=[];index_map={v:i for i,v in enumerate(used)}
    for v in used:
        if not lod['minIndex']<=v<lod['minIndex']+lod['vertexCount']:raise ValueError('Index outside LOD vertex range')
        shifted=v+stream['vertexOffset']//vb['stride']
        if shifted>=vb['vertexCount']:raise ValueError('Index outside VB')
        xyz=struct.unpack_from('<'+fmt,raw,vb['dataOffset']+shifted*vb['stride']+element['offset'])[:3]
        local.extend(xyz)
        # Original shader is mul(float4(xyz,1),g_mWorld), row-vector matrix.
        world.extend(sum(xyz[k]*matrix[k*4+a] for k in range(3))+matrix[12+a] for a in range(3))
    bounds={'min':[min(world[a::3]) for a in range(3)],'max':[max(world[a::3]) for a in range(3)]}
    archived=node['bounds']['instance'][0]
    error=max(abs(bounds['min'][a]-archived[a]) for a in range(3))
    error=max(error,max(abs(bounds['max'][a]-archived[a+3]) for a in range(3)))
    if error>0.0001:raise ValueError('Transformed geometry disagrees with archived instance bounds')
    compact_indices=[index_map[v] for v in indices]
    return {'instanceIndex':0,'basePrimitiveIndex':instance['primitiveIndex'],'effect':scene['effects'][primitive['effect']],
            'vertexSource':vb_source,'indexSource':ib_source,'geometry':provenance,'matrix':matrix,'matrixAssignments':trace,
            'matrixSemantics':'row vector: out[a]=x*m[a]+y*m[4+a]+z*m[8+a]+m[12+a]',
            'localPositions':local,'worldPositions':world,'indices':compact_indices,'vertexCount':len(used),'triangleCount':len(indices)//3,
            'worldBounds':bounds,'archivedInstanceBounds':archived,'boundsMaxAbsoluteDifference':error,
            'worldPositionsFloat32LESha256':hashlib.sha256(struct.pack('<'+'f'*len(world),*world)).hexdigest(),
            'indicesUint32LESha256':hashlib.sha256(struct.pack('<'+'I'*len(compact_indices),*compact_indices)).hexdigest(),
            'roundingScope':'Python binary64 products/sums rounded once to F32 for hash; not native shader FMA bit identity'}

def verify_instance_errors(directory,scene,node,out):
    cases=[]
    def reject(label,change):
        modified=deepcopy(node);change(modified)
        try:first_instance_proof(directory,scene,modified,out)
        except (ValueError,IndexError,StopIteration) as error:cases.append({'case':label,'rejected':True,'error':str(error)})
        else:raise ValueError('Malformed instance case accepted: '+label)
    def bad_rotation(n):
        material=n['constants'][n['instances'][0]['material']['index']]
        next(f for f in material['fields'] if f['name']=='g_mWorld')['values'][0]*=-1
    def bad_lod(n):n['basePrimitives'][0]['lods'][0]['indexCount']=10000000
    def bad_stream(n):n['basePrimitives'][0]['streams'][0]['frequency']=1
    def dynamic_matrix(n):n['instances'][0]['material']['listIndex']=1
    def no_matrix(n):n['instances'][0]['material']['index']=0
    def recursive_matrix(n):
        index=n['instances'][0]['material']['index']
        n['constants'][index]['fields'].append({'name':'nested','type':8,'count':1,'values':[{'index':index,'listIndex':0}]})
    for name,change in [('wrong-rotation-versus-archived-bounds',bad_rotation),('lod-outside-buffer',bad_lod),
                        ('frequency-stream',bad_stream),('dynamic-matrix',dynamic_matrix),
                        ('missing-explicit-matrix',no_matrix),('recursive-material',recursive_matrix)]:reject(name,change)
    return cases

def main():
    out=ROOT/'_work/level-instances';out.mkdir(parents=True,exist_ok=True)
    reports=[]
    for level,geo,node in [('usa_la_river',88,283),('showroom',3,10),('usa_la_river',252,253)]:
        directory=ROOT/'game-data/Blur/levels'/level
        header=(directory/'level.levelrender').read_bytes()
        layout=render_layout(header,'level');scene=layout['scene'];records=scene['stream']['chunks']
        record=next(c for c in records if c['items'] and c['items'][0]=={'block':node,'lod':0})
        if not 24<=record['storedBytes']<=LIMIT:raise ValueError('Chunk size limit')
        with (directory/'level.levelstream').open('rb') as stream:
            if record['offset']+record['storedBytes']>(directory/'level.levelstream').stat().st_size:raise ValueError('Chunk range')
            stream.seek(record['offset']);raw=stream.read(record['storedBytes'])
        stream_prefix(raw,record)
        resources=resource_prefix(raw,{'resourcePayloadOffset':24,'scenePayloadOffset':0},streamed=True)
        lists=read_lists(raw,resources)
        bindings=[]
        for row in lists:
            for number,inst in enumerate(row['instances']):
                base=row['basePrimitives'][inst['primitiveIndex']]
                matrix,assignments=constant_world(row,inst,base)
                ib=row['sources']['indexBuffer'][base['indexBuffer']]
                matches=[i for i,c in enumerate(records) if {'block':ib['block'],'lod':0} in c['items']]
                bindings.append({'instanceIndex':number,'basePrimitiveIndex':inst['primitiveIndex'],
                                 'indexSource':ib,'sourceChunkCandidates':matches,'matrix':matrix,'matrixAssignments':assignments})
        if lists and lists[0]['instances']:
            proof=first_instance_proof(directory,scene,lists[0],out)
            repeat=first_instance_proof(directory,scene,lists[0],out)
            if proof!=repeat:raise ValueError('Repeated original instance parse differs')
            verification={'repeatable':True,'archivedBoundsMaximumError':proof['boundsMaxAbsoluteDifference'],
                          'boundsTolerance':0.0001,'rejectedCases':verify_instance_errors(directory,scene,lists[0],out)}
            (out/'verification.json').write_text(json.dumps(verification,indent=2)+'\n',encoding='utf8')
            proof.update(nodeChunkSha256=hashlib.sha256(raw).hexdigest(),nodeStreamRecord=record,
                         levelRenderSha256=hashlib.sha256(header).hexdigest())
            (out/'instance-node.chunk').write_bytes(raw)
            (out/'first-instance.json').write_text(json.dumps(proof,allow_nan=False)+'\n',encoding='utf8')
            print(json.dumps({k:v for k,v in proof.items() if k not in ('localPositions','worldPositions','indices','geometry')},indent=2))
        report={'level':level,'geometryBlock':geo,'nodeBlock':node,'chunk':record,'nodeSha256':hashlib.sha256(raw).hexdigest(),
                'renderLists':lists,'instanceBindings':bindings,'sceneEffects':scene['effects'],'sceneDeclarations':scene['declarations']}
        (out/(level+f'-g{geo}-n{node}.json')).write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf8')
        reports.append({'level':level,'lists':[{'instances':len(row['instances']),'bases':len(row['basePrimitives']),
                      'constantFieldCounts':dict(Counter(f['name'] for m in row['constants'] for f in m['fields']))} for row in lists]})
    print(json.dumps(reports,indent=2))

if __name__=='__main__':main()
