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

const evidence={nativeWasmEqual:true,independentPythonEqual:true,vertexCount:805,triangleCount:726,instanceIndex:0,instanceCount:57,basePrimitiveIndex:0,worldPositionsSha256:hash(positions),indicesSha256:hash(indices),boundsMaxAbsoluteDifference:wasm.metadata.boundsMaxAbsoluteDifference,matrix:wasm.metadata.matrix,worldBounds:wasm.bounds,archivedInstanceBounds:wasm.metadata.archivedInstanceBounds,allInstances:{nativeWasmEqual:true,emittedInstanceCount:wasmAll.metadata.emittedInstanceCount,omittedOtherBlockInstances:wasmAll.metadata.omittedOtherBlockInstances,unsupportedBoundsInstances:wasmAll.metadata.unsupportedBoundsInstances,vertexCount:wasmAll.metadata.vertexCount,triangleCount:wasmAll.metadata.triangleCount,boundsMaxAbsoluteDifference:wasmAll.metadata.boundsMaxAbsoluteDifference,instanceIndices:wasmAll.metadata.instances.map(item=>item.instanceIndex)},scope:wasm.metadata.scope};
await writeFile(path.join(root,'_work/verification/level-instances-native-wasm.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
