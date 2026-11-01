// Bounded model container and WebGPU inspection; Windows engine is not linked.
// This parses the ordinary format; no hash/signature validation is claimed.
import { decodePacketZlib } from './packet.js';
import { MeshViewer } from './mesh-viewer.js';
let viewer;

export async function showMesh(mesh,textures=[]){
  const status=document.getElementById('mesh-status');
  document.getElementById('viewer-panel').hidden=false;
  document.getElementById('mesh-canvas').hidden=false;
  if(!viewer){
    viewer=new MeshViewer(document.getElementById('mesh-canvas'),status);
    document.getElementById('reset-camera').addEventListener('click',()=>viewer.reset());
    const setMode=mode=>{viewer.setMode(mode);for(const name of ['surface','wire','texture'])document.getElementById(`${name}-mode`).setAttribute('aria-pressed',String(mode===name));};
    for(const name of ['surface','wire','texture'])document.getElementById(`${name}-mode`).addEventListener('click',()=>setMode(name));
  }
  const hasTextures=textures.some(Boolean),mode=hasTextures?'texture':'surface';
  const textureButton=document.getElementById('texture-mode');textureButton.disabled=!hasTextures;textureButton.textContent=hasTextures?'Orijinal doku':'Doku çözülemedi';
  for(const name of ['surface','wire','texture'])document.getElementById(`${name}-mode`).setAttribute('aria-pressed',String(mode===name));
  viewer.mode=mode;
  await viewer.load(mesh.positions,mesh.indices,{uv0:mesh.uv0,draws:mesh.draws,textures});
  if(mesh.metadata?.fixtureOnly)status.textContent+=' · bu örnek için doğrulanmış okuyucu · model yerel uzayı';
  if(mesh.metadata?.partialSceneTraversal)status.textContent+=' · ilk render düğümü / LOD0 · dönüşümler uygulanmadı';
}

async function previewMesh(mod, pointer, length) {
  const panel = document.getElementById('viewer-panel');
  const status = document.getElementById('mesh-status');
  panel.hidden = false;
  document.getElementById('mesh-canvas').hidden = true;
  status.textContent = 'Geometri WebAssembly ile çözülüyor…';
  const inspect=mod._scene_inspect||mod._mesh_inspect,free=mod._scene_free||mod._mesh_free;
  if (!inspect) { status.textContent = 'Geometri okuyucusu henüz derlenmedi.'; return; }
  let output = 0;
  try {
    output = inspect(pointer, length);
    if (!output) throw new Error('Mesh okuyucu sonuç döndürmedi.');
    const mesh = JSON.parse(mod.UTF8ToString(output));
    if (mesh.status !== 'ok') throw new Error(mesh.error || mesh.message || 'Bu modelin geometri düzeni henüz desteklenmiyor.');
    const textures=[];
    if(mod._texture_raw_inspect&&mesh.uv0?.length&&mesh.draws){
      const used=[...new Set(mesh.draws.map(draw=>draw.albedoTexture).filter(Number.isInteger))];
      if(used.length>16)throw new Error('Bu önizleme en fazla 16 materyal dokusu açabilir.');
      for(const index of used){
        const source=mesh.sharedTextures[index];
        if(!source||!Number.isSafeInteger(source.dataOffset)||!Number.isSafeInteger(source.dataBytes)||source.dataOffset<0||source.dataBytes<28||source.dataOffset+source.dataBytes>length)throw new Error('Gömülü doku sınırları geçersiz.');
        let textureOutput=0;
        try{
          textureOutput=mod._texture_raw_inspect(pointer+source.dataOffset,source.dataBytes);
          if(!textureOutput)throw new Error('Gömülü doku okuyucu sonuç döndürmedi.');
          const decoded=JSON.parse(mod.UTF8ToString(textureOutput));
          if(decoded.status==='ok')textures[index]=decoded;
        }finally{if(textureOutput)mod._texture_free(textureOutput);}
      }
    }
    await showMesh(mesh,textures);
  } catch (error) { status.textContent = `Geometri önizlemesi: ${error.message}`; }
  finally { if (output) free(output); }
}
export { decodeSinglePacket } from './packet.js';

export async function inspectSmallModel(mod, source, entry, {signal} = {}) {
  const panel = document.getElementById('model-result');
  panel.hidden = false;
  document.getElementById('viewer-panel').hidden = true;
  document.getElementById('model-chunks').closest('.table-wrap').hidden=false;
  document.getElementById('model-name').textContent = entry.path.split('\\').at(-1);
  const status = document.getElementById('model-status');
  status.textContent = 'Model verisi okunuyor ve sıkıştırması açılıyor…';
  document.getElementById('model-chunks').replaceChildren();
  const packed = new Uint8Array(await source.readRange(entry.dataOffset, entry.physicalBytes));
  const decoded = await decodePacketZlib(packed, entry.logicalBytes, {signal,onProgress:(done,total)=>{status.textContent=`Model açılıyor: ${Math.round(done/total*100)}%`;}});
  signal?.throwIfAborted();
  const ptr = mod._malloc(decoded.length);
  if (!ptr) throw new Error('Model belleği ayrılamadı.');
  let output = 0;
  try {
    mod.HEAPU8.set(decoded, ptr);
    output = mod._model_inspect(ptr, decoded.length);
    if (!output) throw new Error('Model okuyucu sonuç döndürmedi.');
    const report = JSON.parse(mod.UTF8ToString(output));
    if (report.status !== 'ok') throw new Error(report.error || report.message || 'Model blokları okunamadı.');
    const fragment = document.createDocumentFragment();
    const append = (chunks, depth = 0) => { for (const chunk of chunks) {
      const row = document.createElement('tr');
      for (const value of [`${'↳ '.repeat(depth)}${chunk.id}`, chunk.offset, chunk.bytes, chunk.count]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
      fragment.append(row); if (chunk.children) append(chunk.children, depth + 1);
    } };
    append(report.chunks);
    document.getElementById('model-chunks').replaceChildren(fragment);
    status.textContent = `${packed.length.toLocaleString('tr-TR')} bayt paket → ${decoded.length.toLocaleString('tr-TR')} bayt model · ${report.platform || 'PC'}`;
    await previewMesh(mod, ptr, decoded.length);
    return report;
  } catch (error) { status.textContent = error.message; throw error; }
  finally { if (output) mod._model_free(output); mod._free(ptr); }
}

