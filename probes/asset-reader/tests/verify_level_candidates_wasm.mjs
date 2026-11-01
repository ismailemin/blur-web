import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import createModule from '../web/generated/pak_reader.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const manifest=JSON.parse(await readFile(path.join(root,'_work/level-candidates/manifest.json'),'utf8'));
const report=JSON.parse(await readFile(path.join(root,'_work/level-candidates/report.json'),'utf8'));
const cases=[...manifest.candidates];
const showroom=report.allValidCandidateSummaries.find(row=>row.level==='showroom'&&row.geometryBlock===3&&row.nodeBlock===10);
assert.ok(showroom&&showroom.status==='ok');cases.push(showroom);
const mod=await createModule(),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),results=[];
for(const candidate of cases){
  const stage=candidate.stageDirectory;
  const levelFile=path.join(root,'game-data/Blur/levels',candidate.level,'level.levelrender');
  const geometryFile=path.join(stage,'geometry.chunk'),nodeFile=path.join(stage,'node.chunk');
  const [level,geometry,nodes]=await Promise.all([readFile(levelFile),readFile(geometryFile),readFile(nodeFile)]);
  assert.equal(hash(level),candidate.levelRenderSha256);assert.equal(hash(geometry),candidate.geometryChunkSha256);assert.equal(hash(nodes),candidate.nodeChunkSha256);
  const reference=JSON.parse(await readFile(path.join(stage,'reference.json'),'utf8'));
  const native=JSON.parse(execFileSync(path.join(root,'_work/build/asset-reader-native/Release/level_inspect.exe'),[levelFile,geometryFile,nodeFile,String(candidate.geometryBlock),String(candidate.nodeBlock)],{encoding:'utf8',maxBuffer:16*1024*1024}));
  const allocations=[];let output=0,wasm;
  try{
    const allocate=bytes=>{const pointer=mod._malloc(bytes.length);assert.ok(pointer);allocations.push(pointer);mod.HEAPU8.set(bytes,pointer);return pointer;};
    const levelPtr=allocate(level),geometryPtr=allocate(geometry),nodePtr=allocate(nodes);
    output=mod._level_mesh_inspect(levelPtr,level.length,geometryPtr,geometry.length,nodePtr,nodes.length,candidate.geometryBlock,candidate.nodeBlock);
    assert.ok(output);wasm=JSON.parse(mod.UTF8ToString(output));
  }finally{if(output)mod._scene_free(output);for(const pointer of allocations)mod._free(pointer);}
  assert.equal(wasm.status,'ok');
  const label=`${candidate.level} ${candidate.geometryBlock}/${candidate.nodeBlock}`;
  assert.ok(isDeepStrictEqual(wasm,native),`${label}: native/WASM reports differ`);
  assert.ok(isDeepStrictEqual(wasm.positions.map(Math.fround),reference.positions),`${label}: independent positions differ`);
  assert.ok(isDeepStrictEqual(wasm.indices,reference.indices),`${label}: independent indices differ`);
  const positions=Buffer.alloc(wasm.positions.length*4),indices=Buffer.alloc(wasm.indices.length*4);
  wasm.positions.forEach((value,i)=>positions.writeFloatLE(value,i*4));wasm.indices.forEach((value,i)=>indices.writeUInt32LE(value,i*4));
  assert.equal(hash(positions),reference.positionsFloat32LESha256);assert.equal(hash(indices),reference.indicesUint32LESha256);
  results.push({level:candidate.level,geometryBlock:candidate.geometryBlock,nodeBlock:candidate.nodeBlock,vertices:wasm.positions.length/3,triangles:wasm.indices.length/3,draws:wasm.draws.length,nativeWasmEqual:true,independentPythonGeometryEqual:true,positionSha256:hash(positions),indexSha256:hash(indices)});
}
await writeFile(path.join(root,'_work/verification/level-candidates-native-wasm.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
