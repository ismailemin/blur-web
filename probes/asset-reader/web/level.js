import {showMesh} from './model.js';
import {MAX_ASSET_BYTES} from './packet.js';

// An explicit development selection; file offsets come from the actual WASM
// stream index, never from cached diagnostic JSON or guessed whole-IB topology.
const DEMOS={
  'river-wide':{level:'usa_la_river',geometryBlock:88,nodeBlock:283,label:'USA LA River · geniş sahne parçası'},
  'river-small':{level:'usa_la_river',geometryBlock:252,nodeBlock:253,label:'USA LA River · küçük doğrulama parçası'},
  'river-instance':{level:'usa_la_river',geometryBlock:27,nodeBlock:253,label:'USA LA River · instance dönüşümü',instances:true},
  'river-instances':{level:'usa_la_river',geometryBlock:27,nodeBlock:253,label:'USA LA River · blok27 desteklenen instance’lar',instances:true,allInstances:true},
  'river-cross-chunk':{level:'usa_la_river',geometryBlock:26,nodeBlock:253,label:'USA LA River · blok26+32 · 20 instance',instances:true,bundledBlocks:[26,32]},
  'river-all-blocks':{level:'usa_la_river',geometryBlock:27,nodeBlock:253,label:'USA LA River · tüm desteklenen · 56 instance',instances:true,bundledBlocks:[15,17,26,27,32]},
  'showroom':{level:'showroom',geometryBlock:3,nodeBlock:10,label:'Showroom · ilk sahne parçası'},
};
function invoke(mod,name,args){
  const output=mod[name](...args);
  if(!output)throw new Error('Pist okuyucu sonuç döndürmedi.');
  try{const report=JSON.parse(mod.UTF8ToString(output));if(report.status!=='ok')throw new Error(report.error||'Pist verisi desteklenmiyor.');return report;}
  finally{mod._scene_free(output);}
}

export async function inspectReferenceLevel(mod,{signal}={}){
  const DEMO=DEMOS[document.getElementById('level-sample').value];
  if(!DEMO)throw new Error('Sahne örneği desteklenmiyor.');
  const status=document.getElementById('level-status');
  if(!mod._level_index_inspect||!mod._level_mesh_inspect)throw new Error('Pist WebAssembly okuyucusu henüz derlenmedi.');
  const level=encodeURIComponent(DEMO.level);
  status.textContent='Pist başlığı okunuyor…';
  const infoResponse=await fetch(`/reference/level/info?level=${level}`,{signal});
  if(!infoResponse.ok)throw new Error('Kurulu pist verisi bulunamadı.');
  const info=await infoResponse.json();
  if(!Number.isSafeInteger(info.renderBytes)||info.renderBytes<20||info.renderBytes>MAX_ASSET_BYTES||!Number.isSafeInteger(info.streamBytes)||info.streamBytes<1)throw new Error('Pist dosyası boyutu desteklenmiyor.');
  const range=async(part,offset,length)=>{
    const size=part==='render'?info.renderBytes:info.streamBytes;
    if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<1||length>MAX_ASSET_BYTES||offset+length>size)throw new Error('Pist okuma aralığı geçersiz.');
    const response=await fetch(`/reference/level/range?level=${level}&part=${part}&offset=${offset}&bytes=${length}`,{signal});
    if(!response.ok)throw new Error('Pist veri aralığı okunamadı.');
    const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length!==length)throw new Error('Pist okuması eksik döndü.');return bytes;
  };
  const header=await range('render',0,info.renderBytes),allocations=[];
  const allocate=bytes=>{const pointer=mod._malloc(bytes.length);if(!pointer)throw new Error('Pist belleği ayrılamadı.');allocations.push(pointer);mod.HEAPU8.set(bytes,pointer);return pointer;};
  try{
    signal?.throwIfAborted();const headerPtr=allocate(header);
    const index=invoke(mod,'_level_index_inspect',[headerPtr,header.length]);
    const chunkFor=block=>index.streamChunks.find(chunk=>chunk.items[0]?.block===block&&chunk.items[0]?.lod===0);
    const chunkItemFor=block=>index.streamChunks.find(chunk=>chunk.items.some(item=>item.block===block&&item.lod===0));
    const selectChunk=DEMO.instances?chunkItemFor:chunkFor;
    const geometryChunk=selectChunk(DEMO.geometryBlock),nodeChunk=selectChunk(DEMO.nodeBlock);
    if(!geometryChunk||!nodeChunk)throw new Error('Bu pist sürümünde seçili geometri/düğüm bloğu bulunamadı.');
    status.textContent='Geometri ve çizim bağlantıları akış dosyasından okunuyor…';
    const [geometry,node]=await Promise.all([range('stream',geometryChunk.offset,geometryChunk.storedBytes),range('stream',nodeChunk.offset,nodeChunk.storedBytes)]);
    signal?.throwIfAborted();
    const geometryPtr=allocate(geometry),nodePtr=allocate(node);
    if(DEMO.bundledBlocks){
      if(!mod._level_instances_bundle_inspect)throw new Error('Çoklu chunk instance okuyucusu henüz derlenmedi.');
      status.textContent='Chunk’lar arası CullNode grupları birleştiriliyor…';
      const entries=[];
      const fetched=new Map([[geometryChunk.offset,geometry]]);
      for(const block of DEMO.bundledBlocks){
        const chunk=chunkItemFor(block);
        if(!chunk)throw new Error(`Blok ${block} için akış kaydı bulunamadı.`);
        let bytes=fetched.get(chunk.offset);
        if(!bytes){bytes=await range('stream',chunk.offset,chunk.storedBytes);fetched.set(chunk.offset,bytes);}
        entries.push({block,bytes});
      }
      signal?.throwIfAborted();
      const chunkPointers=entries.map(entry=>allocate(entry.bytes));
      const count=entries.length;
      const blocksPointer=mod._malloc(count*4),pointersPointer=mod._malloc(count*4),sizesPointer=mod._malloc(count*4);
      if(!blocksPointer||!pointersPointer||!sizesPointer)throw new Error('Instance bundle belleği ayrılamadı.');
      allocations.push(blocksPointer,pointersPointer,sizesPointer);
      const blocksView=new Int32Array(mod.HEAPU8.buffer,blocksPointer,count);
      const pointersView=new Uint32Array(mod.HEAPU8.buffer,pointersPointer,count);
      const sizesView=new Uint32Array(mod.HEAPU8.buffer,sizesPointer,count);
      entries.forEach((entry,index)=>{blocksView[index]=entry.block;pointersView[index]=chunkPointers[index];sizesView[index]=entry.bytes.length;});
      const mesh=invoke(mod,'_level_instances_bundle_inspect',[headerPtr,header.length,nodePtr,node.length,DEMO.nodeBlock,blocksPointer,pointersPointer,sizesPointer,count]);
      const outside=(mesh.metadata.unsuppliedGeometryBlocks||[]).length;
      document.getElementById('model-result').hidden=false;
      document.getElementById('model-name').textContent=DEMO.label;
      document.getElementById('model-status').textContent=`${mesh.metadata.geometryBlocks.join('+')} bloklarından ${mesh.metadata.emittedInstanceCount} instance · ${mesh.metadata.unsupportedBoundsInstances} sınır uyuşmazlığı · ${outside} blok kapsam dışı · materyaller uygulanmadı.`;
      document.getElementById('model-chunks').replaceChildren();
      document.getElementById('model-chunks').closest('.table-wrap').hidden=true;
      await showMesh(mesh);
      status.textContent=`${index.streamChunks.length} akış kaydı · ${mesh.metadata.emittedInstanceCount} instance çizildi · ${mesh.metadata.unsupportedBoundsInstances} sınır uyuşmazlığı · ${outside} blok kapsam dışı · ${mesh.indices.length/3} üçgen`;
      return mesh;
    }
    if(DEMO.allInstances&&!mod._level_instances_all_inspect)throw new Error('Çoklu instance okuyucusu henüz derlenmedi.');
    if(DEMO.instances&&!DEMO.allInstances&&!mod._level_instances_inspect)throw new Error('Instance okuyucusu henüz derlenmedi.');
    const mesh=DEMO.allInstances
      ?invoke(mod,'_level_instances_all_inspect',[headerPtr,header.length,geometryPtr,geometry.length,nodePtr,node.length,DEMO.geometryBlock,DEMO.nodeBlock])
      :DEMO.instances
        ?invoke(mod,'_level_instances_inspect',[headerPtr,header.length,geometryPtr,geometry.length,nodePtr,node.length,DEMO.geometryBlock,DEMO.nodeBlock])
        :invoke(mod,'_level_mesh_inspect',[headerPtr,header.length,geometryPtr,geometry.length,nodePtr,node.length,DEMO.geometryBlock,DEMO.nodeBlock]);
    document.getElementById('model-result').hidden=false;
    document.getElementById('model-name').textContent=DEMO.label;
    document.getElementById('model-status').textContent=DEMO.allInstances
      ?'Blok27’ye bağlı ve arşiv sınırlarıyla uyuşan instance’lar · sabit affine g_mWorld · materyaller uygulanmadı.'
      :DEMO.instances
        ?'Özgün levelstream instance0 · sabit affine g_mWorld · dünya uzayı; diğer instance ve materyaller uygulanmadı.'
        :'Özgün levelrender başlığı ve levelstream aralıkları · doğrudan çizimler; instance ve oyun mantığı uygulanmadı.';
    document.getElementById('model-chunks').replaceChildren();
    document.getElementById('model-chunks').closest('.table-wrap').hidden=true;
    await showMesh(mesh);
    status.textContent=DEMO.allInstances
      ?`${index.streamChunks.length} akış kaydı · ${mesh.metadata.emittedInstanceCount} instance çizildi · ${mesh.metadata.unsupportedBoundsInstances} sınır uyuşmazlığı · ${mesh.metadata.omittedOtherBlockInstances} başka blok · ${mesh.indices.length/3} üçgen`
      :DEMO.instances
        ?`${index.streamChunks.length} akış kaydı · instance0 · ${mesh.indices.length/3} gerçek üçgen · dönüşüm hatası ${mesh.metadata.boundsMaxAbsoluteDifference.toExponential(2)}`
        :`${index.streamChunks.length} akış kaydı · ${geometry.length.toLocaleString('tr-TR')} bayt geometri + ${node.length.toLocaleString('tr-TR')} bayt düğüm · ${mesh.indices.length/3} gerçek üçgen`;
    return mesh;
  }finally{for(const pointer of allocations)mod._free(pointer);}
}
