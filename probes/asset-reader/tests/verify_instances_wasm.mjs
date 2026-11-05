import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import createModule from '../web/generated/pak_reader.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const levelPath=path.join(root,'game-data/Blur/levels/usa_la_river/level.levelrender');
const geometryPath=path.join(root,'_work/level-instances/instance-geometry.chunk');
const nodePath=path.join(root,'_work/level-instances/instance-node.chunk');
const level=await readFile(levelPath),geometry=await readFile(geometryPath),node=await readFile(nodePath);
const hash=value=>createHash('sha256').update(value).digest('hex');
const reference=JSON.parse(await readFile(path.join(root,'_work/level-instances/first-instance.json'),'utf8'));
assert.equal(reference.vertexCount,805);assert.equal(reference.triangleCount,726);

const native=JSON.parse(execFileSync(path.join(root,'_work/build/asset-reader-native/Release/level_inspect.exe'),
  ['--instances',levelPath,geometryPath,nodePath,'27','253'],{encoding:'utf8',maxBuffer:32*1024*1024}));
const mod=await createModule();
const allocate=bytes=>{const pointer=mod._malloc(bytes.length);assert.ok(pointer);mod.HEAPU8.set(bytes,pointer);return pointer;};
const levelPointer=allocate(level),geometryPointer=allocate(geometry),nodePointer=allocate(node);
let output=0,wasm;
try{
  output=mod._level_instances_inspect(levelPointer,level.length,geometryPointer,geometry.length,nodePointer,node.length,27,253);
  assert.ok(output);
  wasm=JSON.parse(mod.UTF8ToString(output));
}finally{if(output)mod._scene_free(output);mod._free(levelPointer);mod._free(geometryPointer);mod._free(nodePointer);}

assert.equal(native.status,'ok');
assert.equal(wasm.status,'ok');
assert.ok(isDeepStrictEqual(wasm,native),'Complete native/WASM instance JSON differs');
assert.equal(wasm.metadata.vertexCount,805);
assert.equal(wasm.metadata.triangleCount,726);
assert.equal(wasm.metadata.instanceIndex,0);
assert.equal(wasm.metadata.instanceCount,57);
assert.equal(wasm.metadata.basePrimitiveIndex,0);
assert.equal(wasm.metadata.instancesApplied,true);
assert.equal(wasm.metadata.coordinateSpace,'world');
assert.ok(wasm.metadata.boundsMaxAbsoluteDifference<=0.0001);
assert.equal(wasm.indices.length,reference.indices.length);
assert.equal(wasm.positions.length,reference.worldPositions.length);

const positions=Buffer.alloc(wasm.positions.length*4),indices=Buffer.alloc(wasm.indices.length*4);
wasm.positions.forEach((value,i)=>positions.writeFloatLE(value,i*4));
wasm.indices.forEach((value,i)=>indices.writeUInt32LE(value,i*4));
assert.equal(hash(positions),reference.worldPositionsFloat32LESha256);
assert.equal(hash(indices),reference.indicesUint32LESha256);
assert.equal(hash(positions),'5125314b04f46b997d4575478b11377ea72304aa9f2ee62d82f5bd7b1c1aa116');
assert.equal(hash(indices),'886e28559f186137e3ef5225768f61c4eccebf76ed4292ef5298c6ce887009fa');

for(let i=0;i<16;i++)assert.ok(Math.abs(wasm.metadata.matrix[i]-reference.matrix[i])<=1e-5,`Matrix component ${i} differs`);
for(let i=0;i<6;i++)assert.ok(Math.abs(wasm.metadata.archivedInstanceBounds[i]-reference.archivedInstanceBounds[i])<=1e-5,`Archived bound ${i} differs`);
for(const key of ['min','max'])for(let a=0;a<3;a++)assert.ok(Math.abs(wasm.bounds[key][a]-reference.worldBounds[key][a])<=1e-5,`World ${key}[${a}] differs`);

const nativeAll=JSON.parse(execFileSync(path.join(root,'_work/build/asset-reader-native/Release/level_inspect.exe'),
  ['--instances-all',levelPath,geometryPath,nodePath,'27','253'],{encoding:'utf8',maxBuffer:32*1024*1024}));
const levelPointer2=allocate(level),geometryPointer2=allocate(geometry),nodePointer2=allocate(node);
let outputAll=0,wasmAll;
try{
  outputAll=mod._level_instances_all_inspect(levelPointer2,level.length,geometryPointer2,geometry.length,nodePointer2,node.length,27,253);
  assert.ok(outputAll);
  wasmAll=JSON.parse(mod.UTF8ToString(outputAll));
}finally{if(outputAll)mod._scene_free(outputAll);mod._free(levelPointer2);mod._free(geometryPointer2);mod._free(nodePointer2);}
assert.equal(nativeAll.status,'ok');assert.equal(wasmAll.status,'ok');
assert.ok(isDeepStrictEqual(wasmAll,nativeAll),'Complete native/WASM all-instance JSON differs');
assert.equal(wasmAll.metadata.emittedInstanceCount,22);
assert.equal(wasmAll.metadata.omittedOtherBlockInstances,35);
assert.equal(wasmAll.metadata.unsupportedBoundsInstances,0);
assert.equal(wasmAll.metadata.instanceCount,57);
assert.deepEqual(wasmAll.metadata.requiredGeometryBlocks,[15,17,26,27,31,32]);
assert.equal(wasmAll.metadata.vertexCount,13162);
assert.equal(wasmAll.metadata.triangleCount,10308);
assert.ok(wasmAll.metadata.boundsMaxAbsoluteDifference<=0.0001);
assert.equal(wasmAll.draws.length,22);
assert.deepEqual(wasmAll.metadata.instances.map(item=>item.instanceIndex),[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21]);

const block15=await readFile(path.join(root,'_work/level-instances/block15.chunk'));
const block17=await readFile(path.join(root,'_work/level-instances/block17.chunk'));
const block26=await readFile(path.join(root,'_work/level-instances/block26.chunk'));
const block32=await readFile(path.join(root,'_work/level-instances/block32.chunk'));
const bundleBlocks=[15,17,26,27,32];
const bundleBytes={15:block15,17:block17,26:block26,27:geometry,32:block32};
const levelB=allocate(level),nodeB=allocate(node);
const bundleCall=entries=>{
  const pointers=[];
  const arrays=[];
  try{
    for(const entry of entries)pointers.push(allocate(entry.bytes));
    const count=entries.length;
    const blocksPtr=mod._malloc(count*4),pointersPtr=mod._malloc(count*4),sizesPtr=mod._malloc(count*4);
    arrays.push(blocksPtr,pointersPtr,sizesPtr);
    if(!blocksPtr||!pointersPtr||!sizesPtr)throw new Error('bundle argument allocation failed');
    const blocksView=new Int32Array(mod.HEAPU8.buffer,blocksPtr,count);
    const pointersView=new Uint32Array(mod.HEAPU8.buffer,pointersPtr,count);
    const sizesView=new Uint32Array(mod.HEAPU8.buffer,sizesPtr,count);
    entries.forEach((entry,index)=>{blocksView[index]=entry.block;pointersView[index]=pointers[index];sizesView[index]=entry.bytes.length;});
    let output=0;
    try{
      output=mod._level_instances_bundle_inspect(levelB,level.length,nodeB,node.length,253,blocksPtr,pointersPtr,sizesPtr,count);
      if(!output)throw new Error('bundle reader returned null');
      return JSON.parse(mod.UTF8ToString(output));
    }finally{if(output)mod._scene_free(output);}
  }finally{
    for(const pointer of pointers)mod._free(pointer);
    for(const pointer of arrays)mod._free(pointer);
  }
};
const bundleEntries=blocks=>blocks.map(block=>({block,bytes:bundleBytes[block]}));
let bundleNative,bundleWasm,partialNative,partialWasm,bundleEvidence;
try{
  const nativeArgs=()=>{
    const args=['--instances-bundle',levelPath,nodePath,'253'];
    for(const block of bundleBlocks)args.push(String(block),path.join(root,block===27?'_work/level-instances/instance-geometry.chunk':`_work/level-instances/block${block}.chunk`));
    return args;
  };
  const runNativeBundle=()=>JSON.parse(execFileSync(path.join(root,'_work/build/asset-reader-native/Release/level_inspect.exe'),
    nativeArgs(),{encoding:'utf8',maxBuffer:64*1024*1024}));
  bundleNative=runNativeBundle();
  bundleWasm=bundleCall(bundleEntries(bundleBlocks));
  assert.equal(bundleNative.status,'ok',bundleNative.error);
  assert.equal(bundleWasm.status,'ok',bundleWasm.error);
  assert.ok(isDeepStrictEqual(bundleWasm,bundleNative),'Complete native/WASM bundle JSON differs');
  assert.equal(bundleWasm.metadata.emittedInstanceCount,56);
  assert.equal(bundleWasm.metadata.omittedOtherBlockInstances,1);
  assert.equal(bundleWasm.metadata.unsupportedBoundsInstances,0);
  assert.equal(bundleWasm.metadata.incompleteBoundsGroupInstances,0);
  assert.equal(bundleWasm.metadata.instanceCount,57);
  assert.equal(bundleWasm.metadata.vertexCount,34632);
  assert.equal(bundleWasm.metadata.triangleCount,25521);
  assert.equal(bundleWasm.draws.length,56);
  assert.equal(bundleWasm.metadata.boundsGroups,34);
  assert.deepEqual(bundleWasm.metadata.geometryBlocks,bundleBlocks);
  assert.deepEqual(bundleWasm.metadata.unsuppliedGeometryBlocks,[31]);
  assert.ok(bundleWasm.metadata.boundsMaxAbsoluteDifference<=0.0001);
  assert.deepEqual(bundleWasm.metadata.instances.map(item=>item.instanceIndex),
    Array.from({length:57},(_,index)=>index).filter(index=>index!==55));
  assert.ok(isDeepStrictEqual(bundleWasm,bundleCall(bundleEntries(bundleBlocks))),'Bundle output is nondeterministic');
  for(const group of bundleWasm.metadata.boundsGroupDetails){
    if(group.status!=='emitted')continue;
    const records=group.archivedBounds;
    const members=bundleWasm.metadata.instances.filter(item=>item.instanceIndex>=group.firstInstance&&item.instanceIndex<group.firstInstance+group.instanceCount);
    assert.equal(members.length,group.instanceCount,'Group member list differs');
    for(const member of members)assert.deepEqual(member.archivedInstanceBounds,records,'Group archived record is not byte-identical');
  }
  const positionsAll=Buffer.alloc(bundleWasm.positions.length*4),indicesAll=Buffer.alloc(bundleWasm.indices.length*4);
  bundleWasm.positions.forEach((value,index)=>positionsAll.writeFloatLE(value,index*4));
  bundleWasm.indices.forEach((value,index)=>indicesAll.writeUInt32LE(value,index*4));
  partialNative=JSON.parse(execFileSync(path.join(root,'_work/build/asset-reader-native/Release/level_inspect.exe'),
    ['--instances-bundle',levelPath,nodePath,'253','26',path.join(root,'_work/level-instances/block26.chunk')],
    {encoding:'utf8',maxBuffer:32*1024*1024}));
  partialWasm=bundleCall([{block:26,bytes:block26}]);
  assert.equal(partialNative.status,'ok',partialNative.error);
  assert.ok(isDeepStrictEqual(partialWasm,partialNative),'Partial native/WASM bundle JSON differs');
  assert.equal(partialWasm.metadata.emittedInstanceCount,0);
  assert.equal(partialWasm.metadata.incompleteBoundsGroupInstances,10);
  assert.equal(partialWasm.metadata.incompleteBoundsGroups,6);
  assert.equal(partialWasm.metadata.omittedOtherBlockInstances,47);
  assert.equal(partialWasm.metadata.unsupportedBoundsInstances,0);
  assert.equal(partialWasm.metadata.vertexCount,0);
  const errorReport=entries=>{const report=bundleCall(entries);assert.equal(report.status,'error',JSON.stringify(report.metadata||{}));return report.error;};
  assert.ok(errorReport([{block:26,bytes:block26},{block:26,bytes:block26}]).includes('Duplicate'));
  assert.ok(errorReport([{block:26,bytes:block26.subarray(0,block26.length-1)}]).includes('length'));
  assert.ok(errorReport([{block:26,bytes:block32}]).includes('length'));
  const corrupt=Buffer.from(block26);corrupt[0]=0x58;
  assert.ok(errorReport([{block:26,bytes:corrupt}]).includes('signature'));
  assert.ok(errorReport([{block:999,bytes:block26}]).length>0);
  const python=path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
  const reference=JSON.parse(execFileSync(python,[path.join(root,'probes/asset-reader/tests/verify_instances_bundle_reference.py'),'--json'],
    {encoding:'utf8',maxBuffer:64*1024*1024}));
  assert.equal(reference.instanceCount,57);
  assert.equal(reference.groupCount,34);
  assert.deepEqual(reference.stageAB,{instanceCount:56,vertexCount:34632,triangleCount:25521,groupCount:33});
  assert.deepEqual(reference.crossChunk,{instanceCount:20,vertexCount:11708,triangleCount:8220,groupCount:6});
  assert.deepEqual(reference.stageA,{instanceCount:36,vertexCount:22924,triangleCount:17301,groupCount:27});
  assert.equal(reference.fullNodeWithBlock31Reference.instanceCount,57);
  assert.equal(reference.fullNodeWithBlock31Reference.vertexCount,35386);
  assert.equal(reference.fullNodeWithBlock31Reference.triangleCount,26077);
  for(const group of reference.groups)assert.equal(group.byteIdentical,true,'Python group is not byte-identical');
  for(const group of bundleWasm.metadata.boundsGroupDetails){
    if(group.status!=='emitted')continue;
    const py=reference.groups.find(item=>item.firstInstance===group.firstInstance);
    assert.ok(py,'Python reference is missing group '+group.firstInstance);
    assert.equal(py.instanceCount,group.instanceCount,'Python group size differs');
    assert.equal(py.transformRow,group.transformConstantRow,'Python transform row differs');
    for(let axis=0;axis<3;axis++){
      assert.ok(Math.abs(py.unionMin[axis]-group.unionBounds.min[axis])<=1e-5,'Python union min differs');
      assert.ok(Math.abs(py.unionMax[axis]-group.unionBounds.max[axis])<=1e-5,'Python union max differs');
    }
    assert.ok(Math.abs(py.maxAbsoluteDifference-group.maxAbsoluteDifference)<=1e-9,'Python union error differs');
  }
  bundleEvidence={nativeWasmEqual:true,independentPythonEqual:true,instanceCount:56,vertexCount:34632,triangleCount:25521,draws:56,
    groupCount:34,boundsMaxAbsoluteDifference:bundleWasm.metadata.boundsMaxAbsoluteDifference,
    omittedOtherBlockInstances:1,unsuppliedGeometryBlocks:bundleWasm.metadata.unsuppliedGeometryBlocks,
    geometryBlocks:bundleWasm.metadata.geometryBlocks,positionsSha256:hash(positionsAll),indicesSha256:hash(indicesAll),
    partialGroup:{emittedInstanceCount:0,incompleteBoundsGroupInstances:10,incompleteBoundsGroups:6,omittedOtherBlockInstances:47},
    malformedRejected:5};
}finally{
  mod._free(levelB);mod._free(nodeB);
}

const evidence={nativeWasmEqual:true,independentPythonEqual:true,vertexCount:805,triangleCount:726,instanceIndex:0,instanceCount:57,basePrimitiveIndex:0,worldPositionsSha256:hash(positions),indicesSha256:hash(indices),boundsMaxAbsoluteDifference:wasm.metadata.boundsMaxAbsoluteDifference,matrix:wasm.metadata.matrix,worldBounds:wasm.bounds,archivedInstanceBounds:wasm.metadata.archivedInstanceBounds,allInstances:{nativeWasmEqual:true,emittedInstanceCount:wasmAll.metadata.emittedInstanceCount,omittedOtherBlockInstances:wasmAll.metadata.omittedOtherBlockInstances,unsupportedBoundsInstances:wasmAll.metadata.unsupportedBoundsInstances,vertexCount:wasmAll.metadata.vertexCount,triangleCount:wasmAll.metadata.triangleCount,boundsMaxAbsoluteDifference:wasmAll.metadata.boundsMaxAbsoluteDifference,instanceIndices:wasmAll.metadata.instances.map(item=>item.instanceIndex)},bundle:bundleEvidence,scope:wasm.metadata.scope};
await writeFile(path.join(root,'_work/verification/level-instances-native-wasm.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
