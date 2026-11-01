"""Independent source-shaped Corvette material/UV/resource diagnostic.

Consumes real archive fields sequentially; no guessed offsets or material colours.
Game/source files remain unchanged. Output is local evidence, not a runtime importer.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import struct
import inspect_car_level_assets as car

ROOT=Path(__file__).resolve().parent.parent
LIMIT=16*1024*1024


class MaterialReader(car.Reader):
    def material_type(self):
        start=self.p;self.ar();name=self.string();fields=[]
        for _ in range(self.vec(4096)):
            self.ar();field_name=self.string();kind,count=self.unpack('iI')
            if kind not in range(11) or count>4096:raise ValueError('Material field type/count limit')
            fields.append({'name':field_name,'type':kind,'count':count})
        size,alignment=self.unpack('II');offsets=[self.unpack('H') for _ in range(self.vec(4096))]
        if len(offsets)!=len(fields):raise ValueError('Material field offsets count mismatch')
        effect,list_index=self.unpack('ii')
        return {'archiveOffset':start,'name':name,'fields':fields,'dataBytes':size,'alignment':alignment,
                'offsets':offsets,'effect':effect,'listIndex':list_index}

    def material_data(self,types):
        start=self.p;count,declared=self.unpack('II')
        if count>10000 or declared>LIMIT:raise ValueError('Material data limit')
        materials=[]
        for _ in range(count):
            row_start=self.p;type_index=self.count(len(types)-1);values=[]
            for field in types[type_index]['fields']:
                offset=self.p;kind,n=field['type'],field['count']
                if kind in (8,9):
                    content=[]
                    for _ in range(n):self.ar();content.append(dict(zip(('index','listIndex'),self.unpack('ii'))))
                else:
                    fmt={0:'b',1:'B',2:'h',3:'H',4:'i',5:'I',6:'f',7:'i',10:'I'}[kind]
                    content=[self.unpack(fmt) for _ in range(n)]
                    content=[value if not isinstance(value,float) or math.isfinite(value) else {'nonfiniteBits':struct.pack('<f',value).hex()} for value in content]
                values.append({**field,'serializedOffset':offset,'values':content})
            materials.append({'typeIndex':type_index,'typeName':types[type_index]['name'],
                              'archiveOffset':row_start,'end':self.p,'fields':values})
        return {'archiveOffset':start,'materialCount':count,'declaredBytes':declared,'materials':materials,'end':self.p}

    def material_list(self,target=False):
        start=self.p
        if target:self.ar()
        self.ar();types=[self.material_type() for _ in range(self.vec(4096))]
        return {'archiveOffset':start,'types':types,**self.material_data(types)}

    def texture(self):
        start=self.p;self.ar();self.ar()
        if self.unpack('I')!=2:raise ValueError('Expected PC texture')
        name=self.string();version=self.ar(1)
        sampler=list(self.unpack('10I' if version else '9I'))
        digest,size=self.unpack('II');offset=self.p;self.take(size)
        return {'archiveOffset':start,'name':name,'hash':digest,'dataOffset':offset,'dataBytes':size,'sampler':sampler}


def material_index(r):
    r.ar();return dict(zip(('index','listIndex'),r.unpack('ii')))


def primitive_stream(r):
    start=r.p;r.ar();result=dict(zip(('vertexBuffer','streamIndex','vertexOffset','frequency'),r.unpack('4i')))
    result.update(archiveOffset=start,material=material_index(r));return result


def primitive(r):
    start=r.p;version=r.ar(1);effect,declaration,topology,ib,flags=r.unpack('5i')
    base=material_index(r);instance=material_index(r) if version else None
    r.ar();r.take(24);lods=[]
    for _ in range(r.vec(64)):
        r.ar();lods.append(dict(zip(('offset','indexCount','minIndex','vertexCount'),r.unpack('4I'))))
    streams=[primitive_stream(r) for _ in range(r.vec(32))]
    return {'archiveOffset':start,'end':r.p,'effect':effect,'declaration':declaration,'topology':topology,'indexBuffer':ib,
            'flags':flags,'baseMaterial':base,'instanceMaterial':instance,'lods':lods,'streams':streams}


def instance(r):
    r.ar();r.take(4);material_index(r)
    for _ in range(r.vec(32)):primitive_stream(r)
    r.take(4)


def resource_sources(r):return [dict(zip(('block','index'),r.unpack('ii'))) for _ in range(r.vec(4096))]


def render_list(r):
    base_version=r.ar(4)
    if base_version<2:raise ValueError('Legacy RenderList unsupported')
    node=r.cull();inline=r.material_list();primitives=[primitive(r) for _ in range(r.vec(10000))]
    primitives_end=r.p
    instance_count=r.vec(10000)
    for _ in range(instance_count):instance(r)
    batch_count=r.vec(10000)
    for _ in range(batch_count):r.ar();instance(r);primitive_stream(r)
    base_primitives=[primitive(r) for _ in range(r.vec(10000))]
    constants=r.material_data(inline['types'])
    for _ in range(r.vec()):r.ar();r.take(24)
    for _ in range(3):
        for _ in range(r.vec()):r.bounds()
    for _ in range(3):
        version=r.ar(1);r.take(4)
        if version:r.take(r.vec()*2)
        r.take(4);r.take(r.vec(LIMIT))
    r.take(r.vec()*4)
    for _ in range(r.vec()):r.ar();r.bits();r.bits()
    dynamic=[r.material_list() for _ in range(2 if base_version==3 else r.vec(256) if base_version>3 else 0)]
    sources={name:resource_sources(r) for name in ('indexBuffer','vertexBuffer','texture')}
    sources_end=r.p
    for _ in range(r.vec()):
        r.ar();r.take(4)
        for _ in range(3):
            for _ in range(r.vec()):r.ar();r.take(12)
    return {'name':node['name'],'baseVersion':base_version,'types':inline['types'],'inlineMaterials':inline['materials'],
            'constants':constants,'primitives':primitives,'primitivesEnd':primitives_end,'instanceCount':instance_count,
            'instanceBatchCount':batch_count,'basePrimitives':base_primitives,'dynamicMaterialLists':dynamic,
            'sources':sources,'sourcesEnd':sources_end,'end':r.p}


def node(r):
    start=r.p;tag=r.unpack('B')
    if not tag:return {'archiveOffset':start,'type':None}
    if tag!=3:raise ValueError('Unsupported polymorphic node pointer')
    name=r.string();version=r.ar(4)
    if name=='RenderingData::RenderListNode_Common':
        if version:raise ValueError('Unsupported target RenderList version')
        return {'archiveOffset':start,'type':name,**render_list(r)}
    if name=='RenderingData::CullNode':
        result={'name':r.node()};r.bounds();r.bits()
        if version>0:r.take(4)
        if version>1:r.bits()
    elif name=='RenderingData::RootNode':result=r.cull()
    elif name=='RenderingData::GroupNode':result=r.cull();r.string()
    elif name=='RenderingData::Node':result={'name':r.string()};r.take(r.vec()*8+16)
    else:raise ValueError('Unsupported node '+name)
    return {'archiveOffset':start,'type':name,'name':result['name'],'end':r.p}


def texture_lod(r,lod,origin):
    start=r.p;version=r.ar(2);r.ar()
    if r.unpack('I')!=2:raise ValueError('Expected PC texture LOD')
    name=None;sampler=None;digest=None
    if lod==0:
        name=r.string();sv=r.ar(1);sampler=list(r.unpack('10I' if sv else '9I'));digest=r.unpack('I')
    present=r.unpack('I');result={'archiveOffset':start,'version':version,'lod':lod,'name':name,'sampler':sampler,'hash':digest,'present':present}
    if present:
        header_size=r.count(256);header_offset=r.p;header=r.take(header_size)
        result.update(headerOffset=header_offset,headerBytes=header_size)
        if header_size==28:
            result['descriptor']=dict(zip(('width','height','depth','levels','format','usage','type'),struct.unpack('<7I',header)))
        if present>1:result['pairedSource']=dict(zip(('block','index'),r.unpack('ii')))
        elif version:
            r.ar();size,alignment,compression=r.unpack('III');swap=r.unpack('B')
            if not alignment or alignment>4096 or alignment&(alignment-1) or compression or swap:raise ValueError('Unsupported PC texture LOD buffer')
            r.take((origin-r.p)%alignment);result.update(dataOffset=r.p,dataBytes=size,alignment=alignment);r.take(size)
        else:
            size=r.count(LIMIT);result.update(dataOffset=r.p,dataBytes=size);r.take(size)
    result['end']=r.p;return result


def resource_blocks(data,scene,scene_end):
    r=MaterialReader(data,scene['resourcePayloadOffset'],scene_end);blocks=[]
    for block_index in range(scene['loadedResourceBlocks']):
        start=r.p;r.ar();r.ar()
        if r.unpack('I')!=2:raise ValueError('Expected PC resource block')
        lod_count=r.count(64);block={'index':block_index,'archiveOffset':start,'lodCount':lod_count,'nodes':[],'textures':[]}
        for lod in range(lod_count):
            r.ar();r.ar()
            if r.unpack('II')!=(2,lod):raise ValueError('Resource LOD number/platform mismatch')
            if lod==0:
                prefix=car.resource_prefix(data,{'resourcePayloadOffset':start,'scenePayloadOffset':scene['scenePayloadOffset']})
                if prefix['firstNodeOffset']>scene_end:raise ValueError('Node range outside scene')
                r.p=prefix['firstNodeOffset'];block.update(vertexBuffers=prefix['vertexBuffers'],indexBuffers=prefix['indexBuffers'])
                block['nodes']=[node(r) for _ in range(prefix['nodeCount'])]
            count=r.count(16)
            if lod and count!=len(block['textures']):raise ValueError('Texture count changes between LODs')
            if lod==0:block['textures']=[{'index':i,'lods':[]} for i in range(count)]
            for i in range(count):
                record=texture_lod(r,lod,scene['scenePayloadOffset'])
                if lod==0:block['textures'][i].update(name=record['name'],sampler=record['sampler'],hash=record['hash'])
                block['textures'][i]['lods'].append(record)
        block['end']=r.p;blocks.append(block)
    if r.p!=scene_end:raise ValueError(f'Resource blocks ended at {r.p}, Scene ends at {scene_end}')
    return blocks


def material_assignments(render_list, primitive_record):
    """Direct assignments in Context::RenderPrimitive/SetPrimitive order.

    Dynamic model input records are recipes, not the runtime rebuilt list, so
    they must never be treated as ready shader parameter values.
    """
    constants=render_list['constants']['materials'];calls=[];assignments={};unknown=[]
    def apply(index,stage,stack=()):
        ref=(index['listIndex'],index['index'])
        if len(stack)>32 or ref in stack:raise ValueError('Recursive material reference')
        if index['listIndex']!=0:
            calls.append({'stage':stage,**index,'runtimeRebuiltList':True})
            unknown.append({'stage':stage,**index,'reason':'Dynamic material input is rebuilt by C_Model, not imported here'})
            return
        if not 0<=index['index']<len(constants):raise ValueError('Constant material index outside list')
        material=constants[index['index']]
        calls.append({'stage':stage,**index,'type':material['typeName']})
        for field in material['fields']:
            value={'stage':stage,'materialIndex':index['index'],'materialList':0,
                   'type':field['type'],'count':field['count'],'values':field['values'],
                   'serializedOffset':field['serializedOffset']}
            if field['type']==8:
                for child in field['values']:apply(child,stage+'/'+field['name'],stack+(ref,))
            else:
                # DATA_INDEX supplies a different material's payload at runtime.
                value['static']=field['type'] not in (9,10)
                assignments[field['name']]=value
    if primitive_record['instanceMaterial'] is not None:apply(primitive_record['instanceMaterial'],'instance')
    apply(primitive_record['baseMaterial'],'base')
    for stream_index,stream in enumerate(primitive_record['streams']):
        if stream['streamIndex']==-1:continue
        apply(stream['material'],f'stream[{stream_index}]/slot{stream["streamIndex"]}')
    return calls,assignments,unknown


def texture_binding(index,render_list,scene,blocks):
    sources=render_list['sources']['texture']
    if not 0<=index<len(sources):raise ValueError('Texture source index outside node list')
    source=sources[index]
    if source['block']==-1:
        if not 0<=source['index']<len(scene['sharedTextures']):raise ValueError('Shared texture reference outside list')
        texture=scene['sharedTextures'][source['index']]
        return {'nodeTextureIndex':index,**source,'name':texture['name'],'kind':'shared',
                'dataOffset':texture['dataOffset'],'dataBytes':texture['dataBytes'],'sampler':texture['sampler']}
    if not 0<=source['block']<len(blocks) or not 0<=source['index']<len(blocks[source['block']]['textures']):
        raise ValueError('Texture block/index outside loaded resource blocks')
    texture=blocks[source['block']]['textures'][source['index']]
    return {'nodeTextureIndex':index,**source,'name':texture['name'],'kind':'resource-block',
            'sampler':texture['sampler'],'lods':texture['lods']}


def uv_buffers(data,vertex_buffers):
    result=[]
    for index,vb in enumerate(vertex_buffers):
        elements=[e for e in vb['elements'] if e['usage']==5 and e['usageIndex']==0]
        if not elements:
            result.append({'globalVertexBuffer':index,'vertexCount':vb['vertexCount'],'available':False,'reason':'No TEXCOORD0 in source format'})
            continue
        if len(elements)!=1:raise ValueError('Ambiguous TEXCOORD0 semantic')
        element=elements[0]
        fmt={5:'ff',8:'ee',9:'eeee'}.get(element['type'])
        if fmt is None or element['method']!=0:raise ValueError('Unsupported UV0 format')
        if element['offset']+struct.calcsize('<'+fmt)>vb['stride']:raise ValueError('UV0 outside vertex stride')
        values=[]
        for vertex in range(vb['vertexCount']):
            uv=struct.unpack_from('<'+fmt,data,vb['dataOffset']+vertex*vb['stride']+element['offset'])[:2]
            if not all(math.isfinite(x) for x in uv):raise ValueError('Nonfinite UV0')
            values.extend(uv)
        result.append({'globalVertexBuffer':index,'vertexCount':vb['vertexCount'],'available':True,
                       'element':element,'uv0':values,'bounds':{'min':[min(values[a::2]) for a in range(2)],'max':[max(values[a::2]) for a in range(2)]},
                       'float32LESha256':hashlib.sha256(struct.pack('<'+'f'*len(values),*values)).hexdigest()})
    return result


def draw_uv(data,scene,render_list,block,primitive_record,uv_by_buffer):
    declaration=scene['declarations'][primitive_record['declaration']]
    elements=[e for e in declaration if e['usage']==5 and e['usageIndex']==0]
    if not elements:return {'available':False,'reason':'This shader declaration has no TEXCOORD0'}
    if len(elements)!=1:raise ValueError('Ambiguous declaration UV0')
    element=elements[0]
    streams=[s for s in primitive_record['streams'] if s['streamIndex']==element['stream']]
    if len(streams)!=1:raise ValueError('UV0 declaration binding missing or ambiguous')
    stream=streams[0];source=render_list['sources']['vertexBuffer'][stream['vertexBuffer']]
    if source['block']!=0 or source['index']<0:return {'available':False,'reason':'UV0 buffer is external or a runtime placeholder'}
    vb=block['vertexBuffers'][source['index']];uv=uv_by_buffer[source['index']]
    if not uv['available'] or any(element[k]!=uv['element'][k] for k in ('type','method','usage','usageIndex','offset')):
        raise ValueError('UV0 declaration and bound vertex format disagree')
    if stream['vertexOffset']<0 or stream['vertexOffset']%vb['stride']:raise ValueError('Unaligned UV stream byte offset')
    shift=stream['vertexOffset']//vb['stride'];ib_source=render_list['sources']['indexBuffer'][primitive_record['indexBuffer']]
    if ib_source['block']!=0:return {'available':False,'reason':'Index buffer is external'}
    ib=block['indexBuffers'][ib_source['index']];lod=primitive_record['lods'][0]
    if lod['offset']+lod['indexCount']>ib['count']:raise ValueError('UV draw index range outside buffer')
    indices=struct.unpack_from('<'+str(lod['indexCount'])+('H' if ib['width']==2 else 'I'),data,ib['dataOffset']+lod['offset']*ib['width'])
    used=sorted(set(value+shift for value in indices))
    if not used or used[-1]>=vb['vertexCount']:raise ValueError('UV draw range outside vertex buffer')
    values=[uv['uv0'][value*2+a] for value in used for a in range(2)]
    return {'available':True,'globalVertexBuffer':source['index'],'streamIndex':element['stream'],
            'format':element['type'],'offset':element['offset'],'stride':vb['stride'],'sourceByteOffset':stream['vertexOffset'],
            'usedVertexCount':len(used),'bounds':{'min':[min(values[a::2]) for a in range(2)],'max':[max(values[a::2]) for a in range(2)]},
            'vFlipApplied':False}


def resolved_report(data,scene,blocks,render_list):
    uv=uv_buffers(data,blocks[0]['vertexBuffers']);draws=[]
    for index,p in enumerate(render_list['primitives']):
        effect=scene['effects'][p['effect']];tokens=Path(effect.lower()).stem.split('_')[2:]
        family=Path(effect.lower()).stem.split('_')[1]
        no_albedo='a' in tokens
        calls,assignments,unknown=material_assignments(render_list,p)
        selected={}
        for name in ('g_MeshTexture','g_sOffTexture','g_sOnTexture'):
            value=assignments.get(name)
            if value and value['static'] and value['type']==7 and value['count']==1:
                selected[name]={'assignment':value,'texture':texture_binding(value['values'][0],render_list,scene,blocks)}
        texcoord=draw_uv(data,scene,render_list,blocks[0],p,uv)
        if family=='light':status='runtime_light_blend';reason='Off/On texture blend depends on runtime g_vRenderColour.w, and uses both UV0.xy/zw'
        elif no_albedo:
            status='shader_no_albedo';reason='The _a variant defines _NO_ALBEDO; this draw does not sample an albedo image'
            if family in ('paint','paintm'):reason+='; paint appearance comes from runtime g_sPaintMaterialTexture'
        elif not texcoord['available']:status='unsupported_uv';reason=texcoord['reason']
        elif 'g_MeshTexture' in selected:status='static_albedo_image_resolved';reason='Original scalar g_MeshTexture TEXTURE_INDEX resolves through the node texture source list'
        else:status='unresolved_albedo';reason='No provable static g_MeshTexture assignment in this draw; no carried/stale state guessed'
        draws.append({'draw':index,'effect':effect,'shaderFamily':family,'noAlbedoDefine':no_albedo,
                      'status':status,'reason':reason,'uv0':texcoord,'materialCalls':calls,
                      'knownTextures':selected,'runtimeMaterialInputs':unknown,
                      'serializedSurfaceParameters':{name:value for name,value in assignments.items() if name in ('g_vMtlParameters','g_vMaterialColour','g_vRenderColour')},
                      'completeOriginalMaterialReproduced':False})
    return {'scope':'Original first RenderList direct LOD0 draw inputs only; no shader/runtime material reconstruction',
            'drawCount':len(draws),'statusCounts':dict(Counter(d['status'] for d in draws)),
            'globalVertexBuffersWithoutUv0':[u['globalVertexBuffer'] for u in uv if not u['available']],
            'runtimePaintColourRecovered':False,'runtimePaintTextureRecovered':False,
            'draws':draws},uv


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,default=ROOT/'_work/car-level-assets/corvette_c3_race.model.decoded')
    parser.add_argument('--out-dir',type=Path,default=ROOT/'_work/car-materials')
    args=parser.parse_args();data=args.input.read_bytes()
    if not 20<=len(data)<=LIMIT:raise ValueError('Input outside bounded car diagnostic')
    old=car.Reader
    try:car.Reader=MaterialReader;layout=car.render_layout(data,'model')
    finally:car.Reader=old
    scene_end=next(c['end'] for c in layout['chunks'] if c['id']=='Scene')
    blocks=resource_blocks(data,layout['scene'],scene_end)
    output=args.out_dir.resolve();game=(ROOT/'game-data/Blur').resolve()
    if output.is_relative_to(game):parser.error('Output cannot be inside game data')
    output.mkdir(parents=True,exist_ok=True)
    result={'inputBytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'scene':layout['scene'],'blocks':blocks}
    (output/'corvette-materials.raw.json').write_text(json.dumps(result,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    first=next(n for n in blocks[0]['nodes'] if n['type']=='RenderingData::RenderListNode_Common')
    resolved,uv=resolved_report(data,layout['scene'],blocks,first)
    resolved.update(inputBytes=len(data),sha256=result['sha256'])
    (output/'corvette-materials.json').write_text(json.dumps(resolved,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    (output/'corvette-uv0.json').write_text(json.dumps(uv,allow_nan=False)+'\n',encoding='utf-8')
    print(json.dumps({key:resolved[key] for key in ('inputBytes','sha256','drawCount','statusCounts','globalVertexBuffersWithoutUv0','runtimePaintColourRecovered','runtimePaintTextureRecovered')},indent=2))


if __name__=='__main__':main()
