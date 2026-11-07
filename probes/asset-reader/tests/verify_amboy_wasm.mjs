import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import createModule from '../web/generated/pak_reader.mjs';

// Amboy bounded native/WASM agreement for the additive direct-draw fields.
// The full 48-section native/Python identity check is
// probes/asset-reader/tests/verify_amboy_direct_bindings.py.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const levelPath=path.join(root,'game-data/Blur/levels/usa_amboy/Level.levelrender');
const stage=id=>path.join(root,'_work/map-pipeline/probes','usa_amboy-'+id);
const sections=[
  {id:'g44-n290',geometryBlock:44,nodeBlock:290},
  {id:'g54-n184',geometryBlock:54,nodeBlock:184},
  {id:'g79-n288',geometryBlock:79,nodeBlock:288},
  {id:'g143-n284',geometryBlock:143,nodeBlock:284},
  {id:'g74-n234',geometryBlock:74,nodeBlock:234},
];
const instanceSections=[
  {id:'g54-n184',geometryBlock:54,nodeBlock:184},
  {id:'g237-n238',geometryBlock:237,nodeBlock:238},
  {id:'g251-n252',geometryBlock:251,nodeBlock:252},
];
const level=await readFile(levelPath);
const bindings=JSON.parse(await readFile(path.join(root,'_work/map-slice/amboy-textures/bindings.json'),'utf8'));
const manifest=new Map(bindings.draws.map(draw=>[draw.section+'/'+draw.drawIndex,draw]));
const hash=value=>createHash('sha256').update(value).digest('hex');
const executable=path.join(root,'_work/build/asset-reader-native/Release/level_inspect.exe');
const mod=await createModule();
const allocations=[];
function allocate(bytes){const pointer=mod._malloc(bytes.length);assert.ok(pointer);allocations.push(pointer);mod.HEAPU8.set(bytes,pointer);return pointer;}
function call(name,args){let output=0;try{output=mod[name](...args);assert.ok(output);return JSON.parse(mod.UTF8ToString(output));}finally{if(output)mod._scene_free(output);}}
const levelPointer=allocate(level);
const evidence={kind:'asset-reader.amboy-native-wasm',version:1,level:'usa_amboy',sections:[],instances:[],scope:'bounded sample; additive export fields only; no renderer/GPU claim'};
try{
  let draws=0,bindable=0,blocked=0,identityResolved=0,readerBlocked=0;
  for(const section of sections){
    const geometry=await readFile(path.join(stage(section.id),'geometry.chunk'));
    const node=await readFile(path.join(stage(section.id),'node.chunk'));
    const geometryPointer=allocate(geometry),nodePointer=allocate(node);
    const args=[levelPointer,level.length,geometryPointer,geometry.length,nodePointer,node.length,section.geometryBlock,section.nodeBlock];
    const wasm=call('_level_mesh_inspect',args);
    const native=JSON.parse(execFileSync(executable,[levelPath,path.join(stage(section.id),'geometry.chunk'),path.join(stage(section.id),'node.chunk'),String(section.geometryBlock),String(section.nodeBlock)],{encoding:'utf8',maxBuffer:32*1024*1024}));
    assert.ok(isDeepStrictEqual(wasm,native),section.id+': native/WASM direct-draw JSON differs');
    assert.equal(wasm.status,'ok');
    assert.ok(wasm.sharedTextures.length>0,section.id+': shared texture list empty');
    for(let index=0;index<wasm.draws.length;index++){
      const draw=wasm.draws[index],original=manifest.get(section.id+'/'+index);
      assert.ok(original,section.id+' draw '+index+': missing MAP3 record');
      assert.equal(draw.uvHash,original.uvHash,section.id+' draw '+index+': UV0 hash');
      assert.equal(draw.materialRow,original.material.row,section.id+' draw '+index+': material row');
      assert.equal(draw.material,original.material.material,section.id+' draw '+index+': material name');
      assert.ok(['static-resource-albedo-resolved','static-shared-albedo-resolved','blocked'].includes(draw.bindingStatus));
      draws++;
      if(original.status==='bindable-static-albedo')bindable++;else blocked++;
      if(draw.bindingStatus==='blocked')readerBlocked++;else identityResolved++;
    }
    evidence.sections.push({id:section.id,draws:wasm.draws.length,jsonSha256:hash(JSON.stringify(wasm)),nativeWasmEqual:true});
  }
  assert.equal(draws,135,'sample draw count');
  assert.equal(bindable,108,'sample bindable split');
  assert.equal(blocked,27,'sample blocked split');
  assert.equal(identityResolved,114,'sample reader identity-resolved');
  assert.equal(readerBlocked,21,'sample reader identity-blocked');

  let instanceDescriptions=0;
  for(const section of instanceSections){
    const geometry=await readFile(path.join(stage(section.id),'geometry.chunk'));
    const node=await readFile(path.join(stage(section.id),'node.chunk'));
    const geometryPointer=allocate(geometry),nodePointer=allocate(node);
    const args=[levelPointer,level.length,geometryPointer,geometry.length,nodePointer,node.length,section.geometryBlock,section.nodeBlock];
    const wasm=call('_level_instances_all_inspect',args);
    const native=JSON.parse(execFileSync(executable,['--instances-all',levelPath,path.join(stage(section.id),'geometry.chunk'),path.join(stage(section.id),'node.chunk'),String(section.geometryBlock),String(section.nodeBlock)],{encoding:'utf8',maxBuffer:32*1024*1024}));
    assert.ok(isDeepStrictEqual(wasm,native),section.id+': native/WASM instance JSON differs');
    assert.equal(wasm.metadata.emittedInstanceCount,0,section.id+': instance unexpectedly emitted');
    assert.equal(wasm.metadata.omittedOtherBlockInstances,wasm.metadata.instanceCount,section.id+': instance omission');
    instanceDescriptions+=wasm.metadata.instanceCount;
    evidence.instances.push({id:section.id,instanceCount:wasm.metadata.instanceCount,emitted:wasm.metadata.emittedInstanceCount,nativeWasmEqual:true});
  }
  assert.equal(instanceDescriptions,366,'instance description count');
  evidence.sampleDraws=draws;evidence.sampleBindable=bindable;evidence.sampleBlocked=blocked;
  evidence.identityResolved=identityResolved;evidence.readerBlocked=readerBlocked;evidence.instanceDescriptions=instanceDescriptions;
  evidence.nativeWasmEqual=true;
}finally{for(const pointer of allocations)mod._free(pointer);}
await writeFile(path.join(root,'_work/verification/amboy-reader-native-wasm.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
