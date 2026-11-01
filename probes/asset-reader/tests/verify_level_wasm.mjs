import assert from 'node:assert/strict';
import {readFile,writeFile,open} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import createModule from '../web/generated/pak_reader.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const levelFile=path.join(root,'game-data/Blur/levels/usa_la_river/level.levelrender');
const geometryFile=path.join(root,'_work/level-chunk/geometry.chunk'),nodeFile=path.join(root,'_work/level-chunk/node-53.chunk');
const reference=JSON.parse(await readFile(path.join(root,'_work/level-chunk/reference.json'),'utf8'));
const [level,geometry,nodes]=await Promise.all([readFile(levelFile),readFile(geometryFile),readFile(nodeFile)]);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(level),reference.levelRenderSha256);assert.equal(hash(geometry),reference.geometryChunkSha256);
const stream=await open(path.join(root,'game-data/Blur/levels/usa_la_river/level.levelstream'));
try{for(const [expected,record] of [[geometry,reference.geometryRecord],[nodes,reference.matches[0].record]]){const actual=Buffer.alloc(record.storedBytes);assert.equal((await stream.read(actual,0,actual.length,record.offset)).bytesRead,actual.length);assert.deepEqual(actual,expected);}}
finally{await stream.close();}
const mod=await createModule(),allocations=[];
function allocate(bytes){const pointer=mod._malloc(bytes.length);assert.ok(pointer);allocations.push(pointer);mod.HEAPU8.set(bytes,pointer);return pointer;}
function call(name,args){let output=0;try{output=mod[name](...args);assert.ok(output);return JSON.parse(mod.UTF8ToString(output));}finally{if(output)mod._scene_free(output);}}
let evidence;
try{
  const levelPtr=allocate(level),geometryPtr=allocate(geometry),nodePtr=allocate(nodes);
  const index=call('_level_index_inspect',[levelPtr,level.length]);assert.equal(index.status,'ok');assert.equal(index.streamChunks.length,359);
  const executable=path.join(root,'_work/build/asset-reader-native/Release/level_inspect.exe');
  const nativeIndex=JSON.parse(execFileSync(executable,['--index',levelFile],{encoding:'utf8',maxBuffer:8*1024*1024}));assert.deepEqual(index,nativeIndex);
  const find=block=>index.streamChunks.find(record=>record.items[0]?.block===block&&record.items[0]?.lod===0);
  assert.equal(find(252).offset,reference.geometryRecord.offset);assert.equal(find(252).storedBytes,geometry.length);
  assert.equal(find(253).offset,reference.matches[0].record.offset);assert.equal(find(253).storedBytes,nodes.length);
  const args=[levelPtr,level.length,geometryPtr,geometry.length,nodePtr,nodes.length,252,253];
  const mesh=call('_level_mesh_inspect',args);assert.equal(mesh.status,'ok');
  const native=JSON.parse(execFileSync(executable,[levelFile,geometryFile,nodeFile,'252','253'],{encoding:'utf8',maxBuffer:8*1024*1024}));assert.deepEqual(mesh,native);
  const expected=reference.matches[0].geometry;
  assert.deepEqual(mesh.positions.map(Math.fround),expected.positions);assert.deepEqual(mesh.indices,expected.indices);assert.equal(mesh.draws.length,5);
  const positions=Buffer.alloc(mesh.positions.length*4),indices=Buffer.alloc(mesh.indices.length*4);
  mesh.positions.forEach((value,i)=>positions.writeFloatLE(value,i*4));mesh.indices.forEach((value,i)=>indices.writeUInt32LE(value,i*4));
  assert.equal(hash(positions),expected.positionsFloat32LESha256);assert.equal(hash(indices),expected.indicesUint32LESha256);
  const shortGeometry=[...args];shortGeometry[3]--;assert.equal(call('_level_mesh_inspect',shortGeometry).status,'error');
  const wrongBlock=[...args];wrongBlock[7]=254;assert.equal(call('_level_mesh_inspect',wrongBlock).status,'error');
  assert.equal(call('_level_mesh_inspect',[levelPtr,level.length,nodePtr,nodes.length,geometryPtr,geometry.length,252,253]).status,'error');
  mod.HEAPU8[levelPtr]^=1;assert.equal(call('_level_index_inspect',[levelPtr,level.length]).status,'error');mod.HEAPU8[levelPtr]^=1;
  evidence={nativeWasmEqual:true,independentPythonGeometryEqual:true,streamRangesMatchOriginalFiles:true,streamChunks:index.streamChunks.length,vertexCount:mesh.positions.length/3,triangleCount:mesh.indices.length/3,draws:mesh.draws.length,positionSha256:hash(positions),indexSha256:hash(indices),geometryBytes:geometry.length,nodeBytes:nodes.length,malformedInputsRejected:4,scope:'selected level block direct LOD0 draws; instances, materials, visibility and gameplay are not applied',metadata:mesh.metadata};
}finally{for(const pointer of allocations)mod._free(pointer);}
await writeFile(path.join(root,'_work/verification/level-native-wasm.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
