// PC normal-FAT codec4. Source: PakCompressPacketZLib.cpp Read/DeflateTask.
export const MAX_ASSET_BYTES=16*1024*1024;
const PACKET=65536;

async function inflate(data,expected,signal,format='deflate-raw'){
  const reader=new Blob([data]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const output=new Uint8Array(expected);let offset=0;
  try{
    while(true){
      signal?.throwIfAborted();
      const {done,value}=await reader.read();if(done)break;
      if(offset+value.length>expected)throw new Error('Açılan paket beklenen boyutu aştı.');
      output.set(value,offset);offset+=value.length;
    }
    if(offset!==expected)throw new Error('Açılan paket boyutu beklenenle eşleşmiyor.');
    return output;
  }finally{await reader.cancel();}
}

export async function decodeAsset(data,logicalBytes,codec,options={}){
  if(codec===4)return decodePacketZlib(data,logicalBytes,options);
  if(!(data instanceof Uint8Array)||!Number.isSafeInteger(logicalBytes)||logicalBytes<1||logicalBytes>MAX_ASSET_BYTES||data.length<1||data.length>MAX_ASSET_BYTES+131072)throw new Error('Varlık boyutu desteklenen sınırların dışında.');
  options.signal?.throwIfAborted();
  if(codec===1){if(data.length!==logicalBytes)throw new Error('Ham varlık boyutu eşleşmiyor.');return data.slice();}
  if(codec!==2)throw new Error('Bu varlığın sıkıştırması henüz desteklenmiyor.');
  const decoded=await inflate(data,logicalBytes,options.signal,'deflate');
  options.signal?.throwIfAborted();return decoded;
}

export async function decodePacketZlib(data,logicalBytes,{signal,onProgress}={}){
  if(!(data instanceof Uint8Array)||!Number.isSafeInteger(logicalBytes)||logicalBytes<1||logicalBytes>MAX_ASSET_BYTES)throw new Error('Varlık boyutu bu deneyin sınırları dışında.');
  const maxPackets=Math.ceil(logicalBytes/PACKET)+1;
  if(data.length<8||data.length>4+maxPackets*(PACKET+4))throw new Error('Paketli veri boyutu geçersiz.');
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  if(view.getUint32(0,true)!==PACKET)throw new Error('Paket blok boyutu desteklenmiyor.');
  const output=new Uint8Array(logicalBytes);let source=4,target=0,count=0;
  while(source<data.length){
    signal?.throwIfAborted();
    if(++count>maxPackets||source+4>data.length)throw new Error('Paket başlığı veya sayısı geçersiz.');
    const stored=view.getUint32(source,true);source+=4;
    const raw=stored===0xffffffff,length=raw?PACKET:stored;
    if(length<1||length>PACKET||source+length>data.length)throw new Error('Paket veri sınırları geçersiz.');
    const expected=Math.min(PACKET,logicalBytes-target);
    // Converter Close can emit an empty final DEFLATE packet at a 64KiB boundary.
    if(expected===0&&(raw||source+length!==data.length||logicalBytes%PACKET!==0))throw new Error('Beklenmeyen son paket.');
    const decoded=raw?data.subarray(source,source+expected):await inflate(data.subarray(source,source+length),expected,signal);
    signal?.throwIfAborted();
    output.set(decoded,target);target+=expected;source+=length;
    onProgress?.(target,logicalBytes);
  }
  if(target!==logicalBytes)throw new Error('Açılan varlık boyutu beklenenle eşleşmiyor.');
  return output;
}

export async function decodeSinglePacket(data,logicalBytes){
  if(!Number.isInteger(logicalBytes)||logicalBytes<1||logicalBytes>PACKET||data.byteLength<8||data.byteLength>PACKET+8)throw new Error('Model boyutu bu küçük deneyin sınırları dışında.');
  const size=new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(4,true);
  if((size===0xffffffff?PACKET:size)+8!==data.length)throw new Error('Model paket sınırları geçersiz.');
  return decodePacketZlib(data,logicalBytes);
}
