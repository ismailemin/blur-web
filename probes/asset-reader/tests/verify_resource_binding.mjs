import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import createModule from '../web/generated/pak_reader.mjs';
import {bindResourceTextures} from '../web/resource-textures.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=path.join(root,'_work/car-level-assets/corvette_c3_race.model.decoded');
const bytes=await readFile(fixture);
const hash=value=>createHash('sha256').update(value).digest('hex');
assert.equal(hash(bytes),'77840511e5ca416ff9e7cbdc9ee9fc960fce0205f83c9be77e0803607c32cb9d');

const mod=await createModule();
const pointer=mod._malloc(bytes.length);
let output=0,mesh;
try{
  mod.HEAPU8.set(bytes,pointer);
  output=mod._scene_inspect(pointer,bytes.length);
  assert.ok(output);
  mesh=JSON.parse(mod.UTF8ToString(output));
}finally{if(output)mod._scene_free(output);}
assert.equal(mesh.status,'ok');
assert.equal(mesh.draws.length,80);

const textures=[];
const binding=bindResourceTextures(mod,pointer,bytes.length,mesh,textures);
assert.equal(binding.error,'');
assert.equal(binding.bound,12);
assert.equal(textures.length,2);
assert.deepEqual(textures.map(texture=>[texture.width,texture.height,texture.rgba.length]),[[16,16,1024],[16,16,1024]]);

const expected=new Map([[6,0],[15,0],[16,0],[17,0],[18,0],[19,0],[20,0],[21,1],[61,0],[65,0],[66,0],[79,1]]);
for(const [draw,index] of expected){
  assert.equal(mesh.draws[draw].albedoTexture,index,`Draw ${draw}: resource texture binding differs`);
  assert.equal(mesh.draws[draw].textureSource,'resource-block',`Draw ${draw}: resource texture source missing`);
  assert.equal(mesh.draws[draw].uv0Available,true,`Draw ${draw}: placeholder UVs cannot bind a texture`);
}
const textured=mesh.draws.filter(draw=>Number.isInteger(draw.albedoTexture)).length;
assert.equal(textured,26,'Expected 14 shared plus 12 resource-block textured draws');
assert.equal(mesh.draws.filter(draw=>draw.resourceBlock!==null&&draw.albedoTexture===null).length,0);

const evidence={modelSha256:hash(bytes),sharedAlbedoDraws:14,resourceTextureDraws:binding.bound,texturedDraws:textured,resourceTextures:textures.map((texture,index)=>({index,width:texture.width,height:texture.height,rgbaSha256:hash(Buffer.from(texture.rgba))})),drawBindings:[...expected].map(([draw,index])=>({draw,textureIndex:index})),scope:'complete original LOD0 resource images bound to the 12 static draws; higher resource LODs and runtime paint/light are not applied'};
await writeFile(path.join(root,'_work/verification/resource-binding.json'),JSON.stringify(evidence,null,2));
mod._free(pointer);
console.log(JSON.stringify(evidence,null,2));
