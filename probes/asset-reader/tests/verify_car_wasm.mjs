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
const sharedBindings=[];let unsupportedBlockImages=0;const resourceBindings=[];
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
      assert.equal(draw.resourceBlock,texture.block,`Draw ${index}: resource texture block differs`);
      assert.equal(draw.resourceIndex,texture.index,`Draw ${index}: resource texture index differs`);
      assert.match(draw.binding,/Original resource-block texture input/,`Draw ${index}: resource texture identity scope missing`);
      resourceBindings.push({draw:index,block:texture.block,index:texture.index,name:texture.name});
    }else if(source.status==='runtime_light_blend')assert.match(draw.binding,/Off\/On blend/,`Draw ${index}: light runtime scope missing`);
    else assert.match(draw.binding,/_NO_ALBEDO/,`Draw ${index}: shader's no-albedo definition lost`);
  }
}
assert.equal(sharedBindings.length,14);assert.equal(new Set(sharedBindings.map(draw=>draw.sharedTexture)).size,4);
assert.equal(unsupportedBlockImages,12);
assert.equal(resourceBindings.length,12);
assert.deepEqual([...new Set(resourceBindings.map(item=>`${item.block}:${item.index}`))].sort(),['2:0','6:0']);
const nativeResources=JSON.parse(execFileSync(path.join(root,'_work/build/asset-reader-native/Release/scene_inspect.exe'),[fixture,'--resources'],{encoding:'utf8',maxBuffer:32*1024*1024}));
const resourcePointer=mod._malloc(bytes.length);let resourceOutput=0,wasmResources;
try{mod.HEAPU8.set(bytes,resourcePointer);resourceOutput=mod._scene_resource_textures_inspect(resourcePointer,bytes.length);assert.ok(resourceOutput);wasmResources=JSON.parse(mod.UTF8ToString(resourceOutput));}
finally{if(resourceOutput)mod._scene_free(resourceOutput);mod._free(resourcePointer);}
assert.equal(wasmResources.status,'ok');
equal(wasmResources,nativeResources,'Complete native/WASM resource metadata JSON differs');
assert.equal(wasmResources.metadata.parsedUntilOffset,wasmResources.sceneEnd);
const resourceReport=JSON.parse(await readFile(path.join(root,'_work/car-resource-textures/report.json'),'utf8'));
assert.equal(resourceReport.modelSha256,hash(bytes));
const decodedResourceTextures=[];
for(const expected of resourceReport.textures){
  const block=wasmResources.resourceBlocks[expected.block];
  assert.ok(block,`Resource block ${expected.block} missing`);
  const texture=block.textures[expected.texture];
  assert.ok(texture,`Resource texture ${expected.block}/${expected.texture} missing`);
  assert.equal(texture.name,expected.name);
  const lod0=texture.lods[0],expectedLod0=expected.lods[0];
  assert.equal(lod0.present,true);assert.equal(lod0.supported,true);
  assert.equal(lod0.descriptorOffset,expectedLod0.headerOffset);
  assert.equal(lod0.descriptorBytes,expectedLod0.headerBytes);
  assert.equal(lod0.payloadOffset,expectedLod0.newPayloadOffset);
  assert.equal(lod0.payloadBytes,expectedLod0.newPayloadBytes);
  assert.equal(lod0.completeMipBytes,expectedLod0.completeMipBytes);
  assert.equal(lod0.topMipLevels,expectedLod0.topMipLevelsInPayload);
  for(const key of ['width','height','depth','levels','format','usage','type'])assert.equal(lod0.descriptor[key],expectedLod0.descriptor[key],`${expected.name} LOD0 descriptor ${key} differs`);
  const descriptor=bytes.subarray(lod0.descriptorOffset,lod0.descriptorOffset+28);
  assert.equal(hash(descriptor),expectedLod0.descriptorSha256,`${expected.name} descriptor bytes differ`);
  const raw=Buffer.alloc(28+lod0.payloadBytes);
  bytes.copy(raw,0,lod0.descriptorOffset,lod0.descriptorOffset+28);
  bytes.copy(raw,28,lod0.payloadOffset,lod0.payloadOffset+lod0.payloadBytes);
  const rawPointer=mod._malloc(raw.length);let rawOutput=0;
  try{mod.HEAPU8.set(raw,rawPointer);rawOutput=mod._texture_raw_inspect(rawPointer,raw.length);assert.ok(rawOutput);const decoded=JSON.parse(mod.UTF8ToString(rawOutput));assert.equal(decoded.status,'ok');assert.equal(decoded.width,lod0.descriptor.width);assert.equal(decoded.height,lod0.descriptor.height);const rgba=Buffer.from(decoded.rgba);const expectedRgba=expectedLod0.nativeComparison?.nativeRgbaSha256??expectedLod0.independentPillowRgbaSha256;assert.equal(hash(rgba),expectedRgba,`${expected.name} decoded LOD0 RGBA differs`);decodedResourceTextures.push({block:expected.block,index:expected.texture,name:expected.name,width:decoded.width,height:decoded.height,rgbaSha256:hash(rgba)});}
  finally{if(rawOutput)mod._texture_free(rawOutput);mod._free(rawPointer);}
}
assert.equal(decodedResourceTextures.length,2);
const evidence={nativeWasmEqual:true,independentPythonGeometryEqual:true,independentPythonUvEqual:true,independentPythonMaterialBindingsEqual:true,vertexCount:30591,triangleCount:36193,draws:80,uv0ValidVertices:validVertices,uv0PlaceholderVertices:placeholderVertices,uvBuffers:uvBufferEvidence,staticSharedAlbedoDraws:sharedBindings.length,sharedBindings,unsupportedResourceTextureDraws:unsupportedBlockImages,resourceTextureDraws:resourceBindings.length,resourceBindings,resourceNativeWasmEqual:true,resourceLod0Decoded:decodedResourceTextures,runtimePaintColourRecovered:false,runtimePaintTextureRecovered:false,positionSha256:hash(positions),indexSha256:hash(indices),bounds:wasm.bounds,scope:'first RenderList LOD0, undeformed object-local geometry, original UV0 and 14 static shared plus 12 resource-block albedo inputs; diagnostic lighting, runtime paint/light materials and higher resource LODs are not reproduced'};
await writeFile(path.join(root,'_work/verification/car-native-wasm.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
