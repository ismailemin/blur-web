import {decodePacketZlib} from './packet.js';

export async function inspectTexture(mod,source,entry,{signal}={}){
  const panel=document.getElementById('texture-result');
  const status=document.getElementById('texture-status');
  const canvas=document.getElementById('texture-canvas');
  panel.hidden=false;canvas.hidden=true;
  document.getElementById('texture-name').textContent=entry.path.split('\\').at(-1);
  status.textContent='Doku okunuyor ve açılıyor…';
  const packed=new Uint8Array(await source.readRange(entry.dataOffset,entry.physicalBytes));
  const decoded=await decodePacketZlib(packed,entry.logicalBytes,{signal});
  signal?.throwIfAborted();
  const pointer=mod._malloc(decoded.length);if(!pointer)throw new Error('Doku belleği ayrılamadı.');
  let output=0;
  try{
    mod.HEAPU8.set(decoded,pointer);
    output=mod._texture_inspect(pointer,decoded.length);
    if(!output)throw new Error('Doku okuyucu sonuç döndürmedi.');
    const texture=JSON.parse(mod.UTF8ToString(output));
    if(texture.status!=='ok')throw new Error(texture.error||'Bu doku düzeni henüz desteklenmiyor.');
    const {width,height,rgba}=texture;
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>512||height>512||rgba.length!==width*height*4)throw new Error('Doku piksel sınırları geçersiz.');
    canvas.width=width;canvas.height=height;
    canvas.getContext('2d').putImageData(new ImageData(Uint8ClampedArray.from(rgba),width,height),0,0);
    canvas.hidden=false;
    status.textContent=`${width} × ${height} · ${texture.metadata.format} · ${texture.metadata.mipLevels} mip · ${packed.length.toLocaleString('tr-TR')} bayt paket → ${decoded.length.toLocaleString('tr-TR')} bayt doku`;
    return texture;
  }catch(error){status.textContent=error.message;throw error;}
  finally{if(output)mod._texture_free(output);mod._free(pointer);}
}
