import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import createModule from '../web/generated/pak_reader.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=path.join(root,'_work/model-probe/trafficcylinder.model');
const bytes=await readFile(fixture);
const python=path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const reference=JSON.parse(execFileSync(python,[path.join(root,'tools/inspect_mesh_layout.py'),fixture,'--geometry'],{encoding:'utf8'}));
const native=JSON.parse(execFileSync(path.join(root,'_work/build/asset-reader-native/Release/mesh_inspect.exe'),[fixture],{encoding:'utf8'}));
const mod=await createModule();
function inspect(input){
  const pointer=mod._malloc(input.length || 1); let output=0;
  try{mod.HEAPU8.set(input,pointer);output=mod._mesh_inspect(pointer,input.length);assert.ok(output);return JSON.parse(mod.UTF8ToString(output));}
  finally{if(output)mod._mesh_free(output);mod._free(pointer);}
}
const wasm=inspect(bytes);
assert.deepEqual(wasm,native);
assert.equal(wasm.metadata.vertexCount,100);assert.equal(wasm.metadata.triangleCount,114);
assert.deepEqual(wasm.indices,reference.geometry.triangleListIndices);
// The JSON uses float32 round-trip precision; compare original binary values.
const positions=Buffer.alloc(wasm.positions.length*4);
wasm.positions.forEach((value,i)=>positions.writeFloatLE(value,i*4));
const triangles=Buffer.alloc(wasm.indices.length*4);
wasm.indices.forEach((value,i)=>triangles.writeUInt32LE(value,i*4));
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
assert.equal(hash(positions),reference.geometryHashes.positionsFloat32LittleEndianSha256);
assert.equal(hash(triangles),reference.geometryHashes.triangleIndicesUint32LittleEndianSha256);
assert.deepEqual(wasm.bounds,JSON.parse(JSON.stringify(native.bounds)));
const mutated=Buffer.from(bytes);mutated[2846]^=1;
assert.equal(inspect(mutated).status,'error');assert.equal(inspect(bytes.subarray(0,8014)).status,'error');
const evidence={nativeWasmEqual:true,independentPythonGeometryEqual:true,vertexCount:100,triangleCount:114,fixtureOnly:true,geometryHashes:reference.geometryHashes,modifiedAndTruncatedRejected:true};
await mkdir(path.join(root,'_work/verification'),{recursive:true});
await writeFile(path.join(root,'_work/verification/mesh-native-wasm.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
