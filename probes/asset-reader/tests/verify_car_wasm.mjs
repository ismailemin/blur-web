import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import createModule from '../web/generated/pak_reader.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=path.join(root,'_work/car-level-assets/corvette_c3_race.model.decoded');
const bytes=await readFile(fixture);
assert.equal(createHash('sha256').update(bytes).digest('hex'),'77840511e5ca416ff9e7cbdc9ee9fc960fce0205f83c9be77e0803607c32cb9d');
const reference=JSON.parse(await readFile(path.join(root,'_work/car-level-assets/corvette-geometry.json'),'utf8'));
const materialReference=JSON.parse(await readFile(path.join(root,'_work/car-materials/corvette-materials.json'),'utf8'));
const uvReference=JSON.parse(await readFile(path.join(root,'_work/car-materials/corvette-uv0.json'),'utf8'));
const native=JSON.parse(execFileSync(path.join(root,'_work/build/asset-reader-native/Release/scene_inspect.exe'),[fixture],{encoding:'utf8',maxBuffer:32*1024*1024}));
const mod=await createModule();
const pointer=mod._malloc(bytes.length);let output=0,wasm;
try{mod.HEAPU8.set(bytes,pointer);output=mod._scene_inspect(pointer,bytes.length);assert.ok(output);wasm=JSON.parse(mod.UTF8ToString(output));}
finally{if(output)mod._scene_free(output);mod._free(pointer);}
// Keep failures bounded: the complete JSON includes hundreds of thousands of numbers.
const equal=(actual,expected,message)=>assert.ok(isDeepStrictEqual(actual,expected),message);
assert.equal(wasm.status,'ok');equal(wasm,native,'Complete native/WASM Scene JSON differs');
assert.equal(wasm.metadata.vertexCount,30591);assert.equal(wasm.metadata.triangleCount,36193);assert.equal(wasm.draws.length,80);
equal(wasm.positions.map(Math.fround),reference.positions,'Independent Python positions differ');
equal(wasm.indices,reference.indices,'Independent Python triangle indices differ');
equal(wasm.draws.map(({firstIndex,indexCount})=>({firstIndex,indexCount})),reference.draws.map(({firstIndex,indexCount})=>({firstIndex,indexCount})),'Independent Python draw ranges differ');
const positions=Buffer.alloc(wasm.positions.length*4),indices=Buffer.alloc(wasm.indices.length*4);
wasm.positions.forEach((value,i)=>positions.writeFloatLE(value,i*4));wasm.indices.forEach((value,i)=>indices.writeUInt32LE(value,i*4));
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
assert.equal(hash(positions),reference.positionsFloat32LESha256);assert.equal(hash(indices),reference.indicesUint32LESha256);
assert.equal(materialReference.sha256,hash(bytes),'Material report belongs to another model');
assert.equal(materialReference.drawCount,80);
equal(materialReference.statusCounts,{shader_no_albedo:44,static_albedo_image_resolved:26,runtime_light_blend:10},'Independent material classification changed');
assert.equal(wasm.uv0.length,30591*2,'Full-length UV/placeholder pairs must align with position vertices');
let uvOffset=0,validVertices=0,placeholderVertices=0;
const uvBufferEvidence=[];
for(const bufferIndex of reference.usedGlobalVertexBuffers){
  const source=uvReference.find(buffer=>buffer.globalVertexBuffer===bufferIndex);
  assert.ok(source,`Independent UV report missing buffer ${bufferIndex}`);
  const count=source.vertexCount*2;
  const expected=source.available?source.uv0:Array(count).fill(0);
  assert.equal(expected.length,count,`Independent UV buffer ${bufferIndex} has wrong length`);
  const actual=wasm.uv0.slice(uvOffset,uvOffset+count).map(Math.fround);
  equal(actual,expected,`Original UV0/placeholder values differ in global buffer ${bufferIndex}`);
  if(source.available){
    const packed=Buffer.alloc(count*4);actual.forEach((value,i)=>packed.writeFloatLE(value,i*4));
    assert.equal(hash(packed),source.float32LESha256,`Original UV0 hash differs in global buffer ${bufferIndex}`);
    validVertices+=source.vertexCount;
  }else placeholderVertices+=source.vertexCount;
  uvBufferEvidence.push({globalVertexBuffer:bufferIndex,vertexCount:source.vertexCount,available:source.available});
  uvOffset+=count;
}
assert.equal(uvOffset,wasm.uv0.length);
assert.equal(validVertices,17955);assert.equal(placeholderVertices,12636);
assert.equal(wasm.metadata.uv0ValidVertices,validVertices);
assert.equal(wasm.metadata.uv0PlaceholderVertices,placeholderVertices);
assert.equal(wasm.metadata.runtimeMaterialsApplied,false);
assert.equal(wasm.metadata.runtimePaintColourRecovered,false);
assert.equal(wasm.metadata.runtimePaintTextureRecovered,false);
const sharedBindings=[];let unsupportedBlockImages=0;
for(const [index,draw] of wasm.draws.entries()){
  const source=materialReference.draws[index];
  assert.equal(source.draw,index);
  assert.equal(draw.uv0Available,source.uv0.available,`Draw ${index}: original UV availability differs`);
  const texture=source.knownTextures.g_MeshTexture?.texture;
  const supported=source.status==='static_albedo_image_resolved'&&texture?.kind==='shared';
  if(supported){
    assert.equal(draw.albedoTexture,texture.index,`Draw ${index}: independent shared image index differs`);
    assert.equal(draw.albedoParameter,'g_MeshTexture',`Draw ${index}: original vehicle parameter missing`);
    assert.equal(draw.uv0Available,true,`Draw ${index}: placeholder UVs cannot justify a texture`);
    const actualTexture=wasm.sharedTextures[draw.albedoTexture];
    equal(actualTexture,{name:texture.name,hash:actualTexture.hash,dataOffset:texture.dataOffset,dataBytes:texture.dataBytes},`Draw ${index}: shared image name or exact byte range differs`);
    sharedBindings.push({draw:index,sharedTexture:draw.albedoTexture,name:texture.name});
  }else{
    assert.equal(draw.albedoTexture,null,`Draw ${index}: unsupported/runtime material acquired a guessed albedo`);
    assert.equal(draw.albedoParameter,null,`Draw ${index}: unsupported material acquired a parameter binding`);
    if(source.status==='static_albedo_image_resolved'){
      unsupportedBlockImages++;
      assert.match(draw.binding,/Non-shared texture resource unsupported/,`Draw ${index}: resource texture scope missing`);
    }else if(source.status==='runtime_light_blend')assert.match(draw.binding,/Off\/On blend/,`Draw ${index}: light runtime scope missing`);
    else assert.match(draw.binding,/_NO_ALBEDO/,`Draw ${index}: shader's no-albedo definition lost`);
  }
}
assert.equal(sharedBindings.length,14);assert.equal(new Set(sharedBindings.map(draw=>draw.sharedTexture)).size,4);
assert.equal(unsupportedBlockImages,12);
const evidence={nativeWasmEqual:true,independentPythonGeometryEqual:true,independentPythonUvEqual:true,independentPythonMaterialBindingsEqual:true,vertexCount:30591,triangleCount:36193,draws:80,uv0ValidVertices:validVertices,uv0PlaceholderVertices:placeholderVertices,uvBuffers:uvBufferEvidence,staticSharedAlbedoDraws:sharedBindings.length,sharedBindings,unsupportedResourceTextureDraws:unsupportedBlockImages,runtimePaintColourRecovered:false,runtimePaintTextureRecovered:false,positionSha256:hash(positions),indexSha256:hash(indices),bounds:wasm.bounds,scope:'first RenderList LOD0, undeformed object-local geometry, original UV0 and 14 static shared albedo inputs; diagnostic lighting, runtime paint/light materials and external resource textures are not reproduced'};
await writeFile(path.join(root,'_work/verification/car-native-wasm.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
