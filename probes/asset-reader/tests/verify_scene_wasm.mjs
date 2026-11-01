import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import createModule from '../web/generated/pak_reader.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const manifest=JSON.parse(await readFile(path.join(root,'_work/model-corpus/manifest.json'),'utf8'));
const mod=await createModule();
function inspect(bytes){const pointer=mod._malloc(bytes.length||1);let output=0;try{mod.HEAPU8.set(bytes,pointer);output=mod._scene_inspect(pointer,bytes.length);assert.ok(output);return JSON.parse(mod.UTF8ToString(output));}finally{if(output)mod._scene_free(output);mod._free(pointer);}}
const results=[];
for(const fixture of manifest.models){
  const file=path.join(root,'_work/model-corpus',fixture.file),bytes=await readFile(file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),fixture.decodedSha256);
  const wasm=inspect(bytes);
  const nativeResult=spawnSync(path.join(root,'_work/build/asset-reader-native/Release/scene_inspect.exe'),[file],{encoding:'utf8',maxBuffer:16*1024*1024});
  assert.ok(nativeResult.status===0||nativeResult.status===1,nativeResult.stderr||String(nativeResult.error));
  const native=JSON.parse(nativeResult.stdout);
  assert.deepEqual(wasm,native);
  if(wasm.status==='ok'){
    assert.equal(wasm.metadata.fixtureOnly,false);assert.equal(wasm.metadata.partialSceneTraversal,true);
    assert.equal(wasm.positions.length/3,wasm.metadata.vertexCount);assert.equal(wasm.indices.length/3,wasm.metadata.triangleCount);
    assert.ok(wasm.positions.every(Number.isFinite));assert.ok(wasm.indices.every(i=>Number.isInteger(i)&&i>=0&&i<wasm.positions.length/3));
    assert.ok(wasm.uv0.length===0||wasm.uv0.length/2===wasm.positions.length/3);
  }else assert.ok(wasm.error);
  results.push({file:fixture.file,path:fixture.sourceEntry.path,status:wasm.status,vertices:wasm.metadata?.vertexCount,triangles:wasm.metadata?.triangleCount,uv0:wasm.uv0?.length>0,error:wasm.error});
}
const accepted=results.filter(row=>row.status==='ok').length;assert.ok(accepted>=24);
const fixtureBytes=await readFile(path.join(root,'_work/model-probe/trafficcylinder.model'));
const actual=inspect(fixtureBytes);
const python=path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const reference=JSON.parse(execFileSync(python,[path.join(root,'tools/inspect_mesh_layout.py'),'--geometry'],{encoding:'utf8'}));
assert.deepEqual(actual.indices,reference.geometry.triangleListIndices);
assert.deepEqual(actual.positions.map(Math.fround),reference.geometry.positions.flat());
assert.deepEqual(actual.draws.map(({firstIndex,indexCount,albedoTexture})=>({firstIndex,indexCount,albedoTexture})),[{firstIndex:0,indexCount:30,albedoTexture:0},{firstIndex:30,indexCount:312,albedoTexture:0}]);
// General parser must consume changed valid geometry, rather than select a hash profile.
const changed=Buffer.from(fixtureBytes);changed.writeFloatLE(0.125,2846);
const changedReport=inspect(changed);assert.equal(changedReport.status,'ok');assert.equal(changedReport.positions[0],0.125);
const evidence={accepted,total:results.length,nativeWasmEqual:true,independentFixtureGeometryEqual:true,changedValidGeometryParsed:true,scope:'first resource block first render list base primitives LOD0; object-local',results};
await writeFile(path.join(root,'_work/verification/scene-native-wasm.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({...evidence,results:undefined},null,2));
