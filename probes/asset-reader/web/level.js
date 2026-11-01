import {showMesh} from './model.js';
import {MAX_ASSET_BYTES} from './packet.js';

// An explicit development selection; file offsets come from the actual WASM
// stream index, never from cached diagnostic JSON or guessed whole-IB topology.
const DEMOS={
  'river-wide':{level:'usa_la_river',geometryBlock:88,nodeBlock:283,label:'USA LA River · geniş sahne parçası'},
  'river-small':{level:'usa_la_river',geometryBlock:252,nodeBlock:253,label:'USA LA River · küçük doğrulama parçası'},
  'river-instance':{level:'usa_la_river',geometryBlock:27,nodeBlock:253,label:'USA LA River · instance dönüşümü',instances:true},
  'river-instances':{level:'usa_la_river',geometryBlock:27,nodeBlock:253,label:'USA LA River · blok27 desteklenen instance’lar',instances:true,allInstances:true},
  'river-all-blocks':{level:'usa_la_river',geometryBlock:27,nodeBlock:253,label:'USA LA River · tüm desteklenen instance’lar',instances:true,allBlocks:true},
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
    if(DEMO.allBlocks){
      if(!mod._level_instances_all_inspect)throw new Error('Çoklu instance okuyucusu henüz derlenmedi.');
      const merged={positions:[],indices:[],draws:[],instances:[],instanceSources:[]};
      const perBlock=[];let unsupported=0,maxError=0;
      const merge=result=>{
        if(result.metadata.emittedInstanceCount===0){perBlock.push({block:result.metadata.geometryBlock,emitted:0,unsupported:result.metadata.unsupportedBoundsInstances});unsupported+=result.metadata.unsupportedBoundsInstances;return;}
        const vertexOffset=merged.positions.length/3,indexOffset=merged.indices.length;
        merged.positions.push(...result.positions);
        for(const index of result.indices)merged.indices.push(index+vertexOffset);
        for(const draw of result.draws)merged.draws.push({...draw,firstIndex:draw.firstIndex+indexOffset});
        for(const instance of result.metadata.instances||[])merged.instances.push({...instance,firstIndex:instance.firstIndex+indexOffset});
        merged.instanceSources.push(...(result.metadata.instanceSources||[]));
        unsupported+=result.metadata.unsupportedBoundsInstances||0;
        maxError=Math.max(maxError,result.metadata.boundsMaxAbsoluteDifference||0);
        perBlock.push({block:result.metadata.geometryBlock,emitted:result.metadata.emittedInstanceCount,unsupported:result.metadata.unsupportedBoundsInstances});
      };
      const first=invoke(mod,'_level_instances_all_inspect',[headerPtr,header.length,geometryPtr,geometry.length,nodePtr,node.length,DEMO.geometryBlock,DEMO.nodeBlock]);
      merge(first);
      const blocks=first.metadata.requiredGeometryBlocks||[DEMO.geometryBlock];
      for(const block of blocks){
        if(block===DEMO.geometryBlock)continue;
        const chunk=chunkItemFor(block);
        if(!chunk){perBlock.push({block,skipped:'no chunk'});continue;}
        try{
          const bytes=await range('stream',chunk.offset,chunk.storedBytes);
          const pointer=allocate(bytes);
          merge(invoke(mod,'_level_instances_all_inspect',[headerPtr,header.length,pointer,bytes.length,nodePtr,node.length,block,DEMO.nodeBlock]));
        }catch(error){perBlock.push({block,skipped:error.message});}
      }
      const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
      for(let i=0;i<merged.positions.length;i++){const axis=i%3;bounds.min[axis]=Math.min(bounds.min[axis],merged.positions[i]);bounds.max[axis]=Math.max(bounds.max[axis],merged.positions[i]);}
      const mesh={status:'ok',positions:merged.positions,indices:merged.indices,draws:merged.draws,bounds,metadata:{instancesApplied:true,nodeTransformsApplied:true,coordinateSpace:'world',instanceCount:first.metadata.instanceCount,emittedInstanceCount:merged.instances.length,unsupportedBoundsInstances:unsupported,omittedOtherBlockInstances:0,vertexCount:merged.positions.length/3,triangleCount:merged.indices.length/3,boundsMaxAbsoluteDifference:maxError,requiredGeometryBlocks:blocks,perBlock,instances:merged.instances,instanceSources:merged.instanceSources,scope:'all instances whose VB/IB bind an available geometry block and whose constant affine transform matches archived bounds; materials and unsupported blocks omitted'}};
      document.getElementById('model-result').hidden=false;
      document.getElementById('model-name').textContent=DEMO.label;
      document.getElementById('model-status').textContent='Birden çok geometri bloğuna bağlı desteklenen instance’lar · sabit affine g_mWorld · materyaller uygulanmadı.';
      document.getElementById('model-chunks').replaceChildren();
      document.getElementById('model-chunks').closest('.table-wrap').hidden=true;
      await showMesh(mesh);
      const skipped=perBlock.filter(row=>row.skipped).length;
      status.textContent=`${index.streamChunks.length} akış kaydı · ${mesh.metadata.emittedInstanceCount} instance çizildi · ${unsupported} sınır uyuşmazlığı · ${skipped} blok atlandı · ${mesh.indices.length/3} üçgen`;
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
