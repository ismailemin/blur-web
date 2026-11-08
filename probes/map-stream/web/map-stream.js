// Map-stream loader contract for the E1 drive page.
//
// DOM-free: the caller injects `reader(url) -> Promise<Uint8Array>` and
// `hashBytes(bytes) -> Promise<hex>` so the same module runs in the browser
// (fetch + sha256.js/WebCrypto) and in Node (fs + crypto).
//
// It is a contract, not a renderer: it fetches the manifest set and the
// required sectors, applies every geometry slice at its committed byte offset
// and resolves the textures the visible draws need. Draw ranges are never
// rewritten, so the packet the renderer builds is byte-identical to the
// committed package.
//
// Failure is always typed. A missing, truncated or modified required sector
// aborts the load; no partial map is ever returned as if it were complete.
// Optional prefetch failures are reported in `degraded`, not swallowed.

export const MAP_STREAM_SCHEMA = 'blur.map-stream/1';
export const MAP_STREAM_VERSION = 1;

export class MapStreamError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'MapStreamError';
    this.code = code;
    this.detail = detail;
  }
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fail(code, message, detail) {
  throw new MapStreamError(code, message, detail);
}

function decode(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseJson(bytes, code, path) {
  try {
    return JSON.parse(decode(bytes));
  } catch (error) {
    fail(code, 'cannot parse ' + path + ': ' + error.message, { path });
  }
}

function normalizeHash(value) {
  if (typeof value !== 'string') return null;
  return value.startsWith('sha256:') ? value : 'sha256:' + value;
}

async function fetchPinned(path, pin, context, codes) {
  const url = context.baseUrl.replace(/\/$/, '') + '/' + path;
  let bytes;
  try {
    bytes = await context.reader(url);
  } catch (error) {
    fail(codes.missing, 'cannot fetch ' + path + ': ' + error.message, { path, url });
  }
  if (!(bytes instanceof Uint8Array)) {
    fail(codes.missing, 'reader returned no bytes for ' + path, { path });
  }
  if (pin) {
    if (bytes.byteLength !== pin.bytes) {
      fail(codes.bytes, path + ' is ' + bytes.byteLength + ' B, pinned ' + pin.bytes + ' B', {
        path,
        got: bytes.byteLength,
        want: pin.bytes
      });
    }
    const digest = normalizeHash(await context.hashBytes(bytes));
    if (digest !== normalizeHash(pin.sha256)) {
      fail(codes.sha, path + ' sha256 does not match its pin', {
        path,
        got: digest,
        want: normalizeHash(pin.sha256)
      });
    }
  }
  context.bytesFetched += bytes.byteLength;
  return bytes;
}

function sectorPins(manifest, path) {
  const pin = manifest.hashes?.files?.[path];
  if (!pin) fail('MAP_STREAM_INDEX_SCHEMA', 'manifest does not pin ' + path, { path });
  return pin;
}

function writeSlices(buffers, record, payload, bucketId) {
  let offset = 0;
  for (const slice of record.geometry.slices) {
    if (slice.payloadOffset !== offset) {
      fail('MAP_STREAM_SECTOR_SCHEMA', bucketId + ' slice offsets are not contiguous', {
        bucketId,
        slice
      });
    }
    const target = buffers.get(slice.meshId)?.[slice.stream];
    if (!target) {
      fail('MAP_STREAM_SECTOR_SCHEMA', bucketId + ' names an unknown stream', {
        bucketId,
        meshId: slice.meshId,
        stream: slice.stream
      });
    }
    const chunk = payload.subarray(slice.payloadOffset, slice.payloadOffset + slice.bytes);
    const end = slice.srcOffset + chunk.byteLength;
    if (end > target.byteLength) {
      fail('MAP_STREAM_SECTOR_SCHEMA', bucketId + ' slice exceeds the stream', {
        bucketId,
        slice
      });
    }
    target.set(chunk, slice.srcOffset);
    offset = slice.payloadOffset + slice.bytes;
  }
  if (offset !== payload.byteLength) {
    fail('MAP_STREAM_SECTOR_SCHEMA', bucketId + ' payload has trailing bytes', {
      bucketId,
      payload: payload.byteLength,
      slices: offset
    });
  }
}

async function loadBucket(recordPath, bucketId, context, manifest, buffers) {
  const jsonPin = sectorPins(manifest, recordPath);
  const jsonBytes = await fetchPinned(recordPath, jsonPin, context, {
    missing: bucketId === 'global' ? 'MAP_STREAM_GLOBAL_MISSING' : 'MAP_STREAM_SECTOR_MISSING',
    bytes: bucketId === 'global' ? 'MAP_STREAM_GLOBAL_BYTES' : 'MAP_STREAM_SECTOR_BYTES',
    sha: bucketId === 'global' ? 'MAP_STREAM_GLOBAL_SHA256' : 'MAP_STREAM_SECTOR_SHA256'
  });
  const record = parseJson(
    jsonBytes,
    bucketId === 'global' ? 'MAP_STREAM_GLOBAL_SCHEMA' : 'MAP_STREAM_SECTOR_SCHEMA',
    recordPath
  );
  if (record.kind !== (bucketId === 'global' ? 'blur.map-stream.global' : 'blur.map-stream.sector')) {
    fail('MAP_STREAM_SECTOR_SCHEMA', recordPath + ' is not a ' + bucketId + ' record', { bucketId });
  }
  if (record.map !== manifest.map.id) {
    fail('MAP_STREAM_SECTOR_SCHEMA', recordPath + ' belongs to another map', { bucketId });
  }
  const geometryBytes = await fetchPinned(record.geometry.path, record.geometry, context, {
    missing: bucketId === 'global' ? 'MAP_STREAM_GLOBAL_MISSING' : 'MAP_STREAM_SECTOR_MISSING',
    bytes: bucketId === 'global' ? 'MAP_STREAM_GLOBAL_BYTES' : 'MAP_STREAM_SECTOR_BYTES',
    sha: bucketId === 'global' ? 'MAP_STREAM_GLOBAL_SHA256' : 'MAP_STREAM_SECTOR_SHA256'
  });
  writeSlices(buffers, record, geometryBytes, bucketId);

  let texturePage = null;
  if (record.textures?.blobs) {
    const pageBytes = await fetchPinned(record.textures.path, record.textures, context, {
      missing: 'MAP_STREAM_SECTOR_MISSING',
      bytes: 'MAP_STREAM_SECTOR_BYTES',
      sha: 'MAP_STREAM_SECTOR_SHA256'
    });
    const slots = new Map();
    let offset = 0;
    for (const blob of record.textures.blobs) {
      if (blob.offset !== offset) {
        fail('MAP_STREAM_SECTOR_SCHEMA', bucketId + ' texture blob offsets are not contiguous', {
          bucketId,
          blob
        });
      }
      slots.set(blob.slot, {
        slots,
        bytes: pageBytes.subarray(blob.offset, blob.offset + blob.bytes),
        record: blob,
        page: bucketId
      });
      offset += blob.bytes;
    }
    if (offset !== pageBytes.byteLength) {
      fail('MAP_STREAM_SECTOR_SCHEMA', bucketId + ' texture page has trailing bytes', { bucketId });
    }
    texturePage = slots;
  }
  return { record, textures: texturePage };
}

function meshBuffers(manifest) {
  const buffers = new Map();
  for (const mesh of manifest.meshes) {
    const streams = {};
    for (const [kind, stream] of Object.entries(mesh.streams)) {
      streams[kind] = new Uint8Array(stream.bytes);
    }
    buffers.set(mesh.meshId, streams);
  }
  return buffers;
}

function residentSet(index, spawn, radius) {
  const size = index.grid.sizeMetres;
  const ox = index.grid.origin.x;
  const oz = index.grid.origin.z;
  const sx = Math.floor((spawn.x - ox) / size);
  const sz = Math.floor((spawn.z - oz) / size);
  const required = [];
  const prefetch = [];
  for (const sector of index.sectors) {
    const dx = Math.abs(sector.sx - sx);
    const dz = Math.abs(sector.sz - sz);
    const ring = Math.max(dx, dz);
    if (ring <= radius) required.push(sector);
    else if (ring <= radius + 1) prefetch.push(sector);
  }
  return { spawnSector: { sx, sz, id: `x${String(sx).padStart(3, '0')}_z${String(sz).padStart(3, '0')}` }, required, prefetch };
}

/**
 * Load a map's chunk set.
 *
 * @returns {{
 *   manifest, index, meshes: Map<string, Record<string, Uint8Array>>,
 *   draws: object[], textures: Map<number, object>, sectors: object[],
 *   spawnSector: string, missingSectors: string[], degraded: object[],
 *   bytesFetched: number, drawCount: number, structure: object
 * }}
 */
export async function loadMapStream(options) {
  const {
    baseUrl,
    reader,
    hashBytes,
    spawn,
    radius = 1,
    prefetch = true,
    expectedManifestSha256 = null,
    expectedContentHash = null
  } = options;
  if (typeof baseUrl !== 'string' || !baseUrl) fail('MAP_STREAM_MANIFEST_MISSING', 'baseUrl is required');
  if (typeof reader !== 'function') fail('MAP_STREAM_MANIFEST_MISSING', 'reader is required');
  if (typeof hashBytes !== 'function') fail('MAP_STREAM_MANIFEST_MISSING', 'hashBytes is required');

  const context = { baseUrl, reader, hashBytes, bytesFetched: 0 };
  let manifestBytes;
  try {
    manifestBytes = await reader(baseUrl.replace(/\/$/, '') + '/manifest.json');
  } catch (error) {
    fail('MAP_STREAM_MANIFEST_MISSING', 'cannot fetch manifest.json: ' + error.message);
  }
  const manifestDigest = normalizeHash(await hashBytes(manifestBytes));
  if (expectedManifestSha256 && manifestDigest !== normalizeHash(expectedManifestSha256)) {
    fail('MAP_STREAM_PIN_MISMATCH', 'manifest.json is not the pinned file', {
      got: manifestDigest,
      want: normalizeHash(expectedManifestSha256)
    });
  }
  context.bytesFetched += manifestBytes.byteLength;
  const manifest = parseJson(manifestBytes, 'MAP_STREAM_MANIFEST_SCHEMA', 'manifest.json');
  if (manifest.kind !== 'blur.map-stream.manifest' || manifest.version !== MAP_STREAM_VERSION) {
    fail('MAP_STREAM_MANIFEST_SCHEMA', 'manifest.json is not blur.map-stream.manifest v1');
  }
  if (manifest.schema !== MAP_STREAM_SCHEMA) {
    fail('MAP_STREAM_MANIFEST_SCHEMA', 'manifest schema is not ' + MAP_STREAM_SCHEMA);
  }
  if (!SHA256.test(manifest.hashes?.contentSha256 || '')) {
    fail('MAP_STREAM_MANIFEST_SCHEMA', 'manifest content hash is missing');
  }
  if (expectedContentHash && manifest.hashes.contentSha256 !== normalizeHash(expectedContentHash)) {
    fail('MAP_STREAM_PIN_MISMATCH', 'manifest content hash is not the pinned value', {
      got: manifest.hashes.contentSha256,
      want: normalizeHash(expectedContentHash)
    });
  }

  const indexBytes = await fetchPinned(
    'index.json',
    sectorPins(manifest, 'index.json'),
    context,
    { missing: 'MAP_STREAM_INDEX_MISSING', bytes: 'MAP_STREAM_INDEX_BYTES', sha: 'MAP_STREAM_INDEX_SHA256' }
  );
  const index = parseJson(indexBytes, 'MAP_STREAM_INDEX_SCHEMA', 'index.json');
  if (index.kind !== 'blur.map-stream.index' || index.map !== manifest.map.id) {
    fail('MAP_STREAM_INDEX_SCHEMA', 'index.json is not this map\'s index');
  }

  const metaStreams = parseJson(
    await fetchPinned('meta/streams.json', index.meta.streams, context, {
      missing: 'MAP_STREAM_META_MISSING',
      bytes: 'MAP_STREAM_META_BYTES',
      sha: 'MAP_STREAM_META_SHA256'
    }),
    'MAP_STREAM_META_SCHEMA',
    'meta/streams.json'
  );
  const lap = parseJson(
    await fetchPinned('meta/lap.json', index.meta.lap, context, {
      missing: 'MAP_STREAM_META_MISSING',
      bytes: 'MAP_STREAM_META_BYTES',
      sha: 'MAP_STREAM_META_SHA256'
    }),
    'MAP_STREAM_META_SCHEMA',
    'meta/lap.json'
  );
  if (index.meta.layoutPoints) {
    await fetchPinned('meta/layout.points.f32.bin', index.meta.layoutPoints, context, {
      missing: 'MAP_STREAM_META_MISSING',
      bytes: 'MAP_STREAM_META_BYTES',
      sha: 'MAP_STREAM_META_SHA256'
    });
  }

  const buffers = meshBuffers(manifest);

  const globalBucket = await loadBucket(index.global.path, 'global', context, manifest, buffers);
  const sharedIndexBytes = await fetchPinned(
    'shared/textures.json',
    sectorPins(manifest, 'shared/textures.json'),
    context,
    { missing: 'MAP_STREAM_GLOBAL_MISSING', bytes: 'MAP_STREAM_GLOBAL_BYTES', sha: 'MAP_STREAM_GLOBAL_SHA256' }
  );
  const sharedIndex = parseJson(sharedIndexBytes, 'MAP_STREAM_GLOBAL_SCHEMA', 'shared/textures.json');
  const sharedPage = await fetchPinned(
    'shared/textures.bin',
    sectorPins(manifest, 'shared/textures.bin'),
    context,
    { missing: 'MAP_STREAM_GLOBAL_MISSING', bytes: 'MAP_STREAM_GLOBAL_BYTES', sha: 'MAP_STREAM_GLOBAL_SHA256' }
  );
  const sharedTextures = new Map();
  let sharedOffset = 0;
  for (const blob of sharedIndex.blobs) {
    if (blob.offset !== sharedOffset) {
      fail('MAP_STREAM_GLOBAL_SCHEMA', 'shared texture offsets are not contiguous', { blob });
    }
    sharedTextures.set(blob.slot, {
      bytes: sharedPage.subarray(blob.offset, blob.offset + blob.bytes),
      record: blob,
      page: 'shared'
    });
    sharedOffset += blob.bytes;
  }
  if (sharedOffset !== sharedPage.byteLength) {
    fail('MAP_STREAM_GLOBAL_SCHEMA', 'shared texture page has trailing bytes');
  }

  const { spawnSector, required, prefetch: prefetchList } = residentSet(index, spawn, radius);
  if (!index.sectors.some((sector) => sector.id === spawnSector.id)) {
    fail('MAP_STREAM_SPAWN_SECTOR_MISSING', 'the spawn sector is not in the index', {
      spawnSector: spawnSector.id
    });
  }

  const loadedSectors = [];
  const sectorTextures = new Map();
  for (const sector of required) {
    const loaded = await loadBucket(sector.path, sector.id, context, manifest, buffers);
    const listed = [...loaded.record.draws.ordinals].sort((a, b) => a - b);
    const expected = [...sector.drawOrdinals].sort((a, b) => a - b);
    if (listed.join(',') !== expected.join(',')) {
      fail('MAP_STREAM_SECTOR_SCHEMA', sector.id + ' draw list does not match the index', {
        sector: sector.id
      });
    }
    loadedSectors.push({ sector, record: loaded.record });
    if (loaded.textures) {
      for (const [slot, entry] of loaded.textures) sectorTextures.set(slot, entry);
    }
  }

  const draws = [...globalBucket.record.draws.records];
  for (const entry of loadedSectors) draws.push(...entry.record.draws.records);
  const ordinals = new Set();
  for (const draw of draws) {
    if (ordinals.has(draw.ordinal)) {
      fail('MAP_STREAM_SECTOR_SCHEMA', 'draw ' + draw.ordinal + ' is in two resident buckets');
    }
    ordinals.add(draw.ordinal);
  }
  const textures = new Map();
  for (const draw of draws) {
    const slot = draw.textureSlot;
    if (slot === null || slot === undefined) continue;
    if (textures.has(slot)) continue;
    const entry = sectorTextures.get(slot) || sharedTextures.get(slot);
    if (!entry) {
      fail('MAP_STREAM_TEXTURE_MISSING', 'texture slot ' + slot + ' is not resident for draw ' + draw.drawId, {
        slot,
        draw: draw.drawId
      });
    }
    textures.set(slot, {
      slot,
      bytes: entry.bytes,
      page: entry.page,
      width: entry.record.width,
      height: entry.record.height,
      format: entry.record.format,
      formatName: entry.record.formatName,
      uploadFormat: entry.record.uploadFormat,
      sourceIds: entry.record.sourceIds,
      sha256: entry.record.sha256
    });
  }

  const degraded = [];
  if (prefetch) {
    for (const sector of prefetchList) {
      try {
        await loadBucket(sector.path, sector.id, context, manifest, buffers);
      } catch (error) {
        degraded.push({
          code: 'MAP_STREAM_PREFETCH_FAILED',
          sector: sector.id,
          error: error.code || error.name,
          message: error.message
        });
      }
    }
  }

  return {
    manifest,
    index,
    meta: { streams: metaStreams, lap },
    meshes: buffers,
    draws,
    textures,
    sectors: loadedSectors.map((entry) => entry.sector.id),
    spawnSector: spawnSector.id,
    requiredSectors: required.map((sector) => sector.id),
    prefetchSectors: prefetchList.map((sector) => sector.id),
    missingSectors: [],
    degraded,
    bytesFetched: context.bytesFetched,
    drawCount: draws.length,
    structure: {
      sectorCount: index.sectors.length,
      drawsTotal: index.draws.count,
      visibleDraws: draws.length,
      residentSectors: loadedSectors.length,
      residentBytes: context.bytesFetched
    }
  };
}
