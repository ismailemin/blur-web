// Bounded browser binding for original model resource-block textures. The
// caller supplies decoded model bytes already in WASM memory. Only complete
// original LOD0 chains are accepted; later top-mip-only LODs are not passed to
// the complete-chain decoder. No DOM or GPU dependency, so Node can test it.
export function bindResourceTextures(mod, pointer, length, mesh, textures) {
  const draws = (mesh.draws || []).filter(draw =>
    Number.isInteger(draw.resourceBlock) && Number.isInteger(draw.resourceIndex) && draw.uv0Available);
  if (!mod._scene_resource_textures_inspect || !draws.length) return {bound:0,error:''};

  let metadataOutput = 0, metadata = null, error = '';
  try {
    metadataOutput = mod._scene_resource_textures_inspect(pointer, length);
    if (!metadataOutput) throw new Error('Kaynak doku meta verisi okunamadı.');
    metadata = JSON.parse(mod.UTF8ToString(metadataOutput));
    if (metadata.status !== 'ok') throw new Error(metadata.error || 'Kaynak doku meta verisi desteklenmiyor.');
  } catch (failure) {
    error = failure.message;
  } finally {
    if (metadataOutput) mod._scene_free(metadataOutput);
  }
  if (!metadata) return {bound:0,error};

  let bound = 0;
  const decodedKeys = new Map();
  for (const draw of draws) {
    const key = `${draw.resourceBlock}:${draw.resourceIndex}`;
    if (decodedKeys.has(key)) { draw.albedoTexture = decodedKeys.get(key); draw.textureSource = 'resource-block'; ++bound; continue; }
    try {
      const block = metadata.resourceBlocks?.find(item => item.index === draw.resourceBlock);
      const texture = block?.textures?.find(item => item.index === draw.resourceIndex);
      const lod0 = texture?.lods?.find(item => item.lod === 0);
      if (!texture || !lod0 || !lod0.present || !lod0.supported) throw new Error('Kaynak doku LOD0 desteklenmiyor.');
      if (lod0.pairedBlock !== null || lod0.pairedIndex !== null) throw new Error('Eşleştirilmiş kaynak doku desteklenmiyor.');
      const descriptor = lod0.descriptor, levels = descriptor?.levels;
      if (!descriptor || !Number.isInteger(levels) || lod0.topMipLevels !== levels || lod0.payloadBytes !== lod0.completeMipBytes) throw new Error('Kaynak doku LOD0 tam mip zinciri değil.');
      if (!Number.isSafeInteger(lod0.descriptorOffset) || !Number.isSafeInteger(lod0.payloadOffset)
          || lod0.descriptorBytes !== 28 || lod0.descriptorOffset < 0 || lod0.payloadOffset < 0
          || lod0.descriptorOffset + 28 > length || lod0.payloadOffset + lod0.payloadBytes > length) throw new Error('Kaynak doku byte aralığı geçersiz.');

      const rawLength = 28 + lod0.payloadBytes, rawPointer = mod._malloc(rawLength);
      if (!rawPointer) throw new Error('Kaynak doku belleği ayrılamadı.');
      let textureOutput = 0;
      try {
        const heap = mod.HEAPU8;
        heap.set(heap.subarray(pointer + lod0.descriptorOffset, pointer + lod0.descriptorOffset + 28), rawPointer);
        heap.set(heap.subarray(pointer + lod0.payloadOffset, pointer + lod0.payloadOffset + lod0.payloadBytes), rawPointer + 28);
        textureOutput = mod._texture_raw_inspect(rawPointer, rawLength);
        if (!textureOutput) throw new Error('Kaynak doku okuyucu sonuç döndürmedi.');
        const decoded = JSON.parse(mod.UTF8ToString(textureOutput));
        if (decoded.status !== 'ok') throw new Error(decoded.error || 'Kaynak doku çözülemedi.');
        const index = textures.length;
        textures.push(decoded);
        decodedKeys.set(key, index);
        draw.albedoTexture = index;
        draw.textureSource = 'resource-block';
        ++bound;
      } finally {
        if (textureOutput) mod._texture_free(textureOutput);
        mod._free(rawPointer);
      }
    } catch (failure) {
      error = error || failure.message;
    }
  }
  return {bound,error};
}
