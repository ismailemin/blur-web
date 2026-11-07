// Geometry chunk contract for the E1 drive slice.
//
// `tools/build_geometry.mjs` writes one level document, one small map-mode base
// and one document per roster car, plus an index that pins every file by SHA-256
// and byte size. The page loads the level (or the map package + base) and only
// the selected car; the packet adapter still receives the same document shape it
// received before chunking (`carBodies` with exactly the driven body), so the
// packet schema and per-car anchors do not move.
//
// This module is DOM-free and is shared by the browser page and the Node
// verifier. A missing, oversized, short or hash-mismatched chunk is a typed
// `ChunkLoadError`; there is no fallback to another car body.

export const LEVEL_CHUNK_KIND = 'e1-drive.geometry';
export const CAR_CHUNK_KIND = 'e1-drive.car-chunk';
export const INDEX_KIND = 'e1-drive.car-bodies-index';
export const CHUNK_VERSION = 1;
export const GEOMETRY_VERSION = 6;

export const CHUNK_ERROR = Object.freeze({
  INDEX_MISSING: 'CHUNK_INDEX_MISSING',
  INDEX_SCHEMA: 'CHUNK_INDEX_SCHEMA',
  LEVEL_MISSING: 'CHUNK_LEVEL_MISSING',
  LEVEL_SCHEMA: 'CHUNK_LEVEL_SCHEMA',
  LEVEL_SHA: 'CHUNK_LEVEL_SHA256',
  LEVEL_BYTES: 'CHUNK_LEVEL_BYTES',
  CAR_MISSING: 'CHUNK_CAR_MISSING',
  CAR_UNKNOWN: 'CHUNK_CAR_UNKNOWN',
  CAR_SCHEMA: 'CHUNK_CAR_SCHEMA',
  CAR_SHA: 'CHUNK_CAR_SHA256',
  CAR_BYTES: 'CHUNK_CAR_BYTES',
  BASE_MISSING: 'CHUNK_BASE_MISSING',
  BASE_SCHEMA: 'CHUNK_BASE_SCHEMA',
  BASE_SHA: 'CHUNK_BASE_SHA256',
  BASE_BYTES: 'CHUNK_BASE_BYTES'
});

export class ChunkLoadError extends Error {
  constructor(code, message, detail = null) {
    super('[' + code + '] ' + message);
    this.name = 'ChunkLoadError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const shaPattern = /^sha256:[0-9a-f]{64}$/;

/** Verify one fetched chunk's byte length and SHA-256 against the index entry. */
export function verifyChunkBytes(bytes, spec, label, codeFor) {
  if (!spec || !Number.isInteger(spec.bytes) || !shaPattern.test(String(spec.sha256 ?? ''))) {
    throw new ChunkLoadError(codeFor.schema, label + ' index entry is missing bytes/sha256', spec ?? null);
  }
  if (!(bytes instanceof Uint8Array) && !ArrayBuffer.isView(bytes)) {
    throw new ChunkLoadError(codeFor.bytes, label + ' chunk is not a byte array');
  }
  const length = bytes.byteLength ?? bytes.length;
  if (length !== spec.bytes) {
    throw new ChunkLoadError(codeFor.bytes,
      label + ' chunk is ' + length + ' B, the index pins ' + spec.bytes + ' B', { spec, length });
  }
  return { bytes: length, sha256: spec.sha256 };
}

/** Verify a chunk hash using an injected SHA-256 function (WebCrypto/Node). */
export async function verifyChunkSha(bytes, spec, label, sha256, codeFor) {
  const actual = await sha256(bytes);
  if (actual !== spec.sha256) {
    throw new ChunkLoadError(codeFor.sha,
      label + ' chunk SHA-256 is ' + actual + ', the index pins ' + spec.sha256, { spec, actual });
  }
  return actual;
}

/** Parse and validate the chunk index document. */
export function parseChunkIndex(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new ChunkLoadError(CHUNK_ERROR.INDEX_SCHEMA, 'chunk index is not JSON: ' + error.message);
  }
  if (doc?.kind !== INDEX_KIND || doc.version !== CHUNK_VERSION) {
    throw new ChunkLoadError(CHUNK_ERROR.INDEX_SCHEMA,
      'chunk index kind/version is not ' + INDEX_KIND + ' v' + CHUNK_VERSION,
      { kind: doc?.kind ?? null, version: doc?.version ?? null });
  }
  if (doc.geometryVersion !== GEOMETRY_VERSION) {
    throw new ChunkLoadError(CHUNK_ERROR.INDEX_SCHEMA,
      'chunk index was built for geometry v' + doc.geometryVersion + ', expected v' + GEOMETRY_VERSION);
  }
  if (!isObject(doc.level) || !isObject(doc.base) || !isObject(doc.cars)) {
    throw new ChunkLoadError(CHUNK_ERROR.INDEX_SCHEMA, 'chunk index is missing level/base/cars');
  }
  if (!shaPattern.test(String(doc.level.sha256 ?? '')) || !shaPattern.test(String(doc.base.sha256 ?? ''))) {
    throw new ChunkLoadError(CHUNK_ERROR.INDEX_SCHEMA, 'chunk index level/base pins are not SHA-256');
  }
  if (typeof doc.defaultCar !== 'string' || !doc.cars[doc.defaultCar]) {
    throw new ChunkLoadError(CHUNK_ERROR.INDEX_SCHEMA, 'chunk index default car is not covered by the index');
  }
  for (const [slug, entry] of Object.entries(doc.cars)) {
    if (entry?.slug !== undefined && entry.slug !== slug) {
      throw new ChunkLoadError(CHUNK_ERROR.INDEX_SCHEMA, 'chunk index car key ' + slug + ' names ' + entry.slug);
    }
    if (!shaPattern.test(String(entry?.sha256 ?? ''))) {
      throw new ChunkLoadError(CHUNK_ERROR.INDEX_SCHEMA, 'chunk index car ' + slug + ' has no SHA-256');
    }
    if (entry.fallback === true) {
      throw new ChunkLoadError(CHUNK_ERROR.CAR_SCHEMA,
        'car chunk ' + slug + ' is the documented fallback body; this slice does not ship it');
    }
  }
  return doc;
}

/** Parse the always-loaded level document. */
export function parseLevelChunk(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new ChunkLoadError(CHUNK_ERROR.LEVEL_SCHEMA, 'level chunk is not JSON: ' + error.message);
  }
  if (doc?.kind !== LEVEL_CHUNK_KIND || doc.version !== GEOMETRY_VERSION) {
    throw new ChunkLoadError(CHUNK_ERROR.LEVEL_SCHEMA,
      'level chunk kind/version is not ' + LEVEL_CHUNK_KIND + ' v' + GEOMETRY_VERSION,
      { kind: doc?.kind ?? null, version: doc?.version ?? null });
  }
  if (doc.chunk?.kind !== 'level') {
    throw new ChunkLoadError(CHUNK_ERROR.LEVEL_SCHEMA, 'level chunk is missing its chunk header');
  }
  if (!isObject(doc.carBodies) || Object.keys(doc.carBodies).length !== 0) {
    throw new ChunkLoadError(CHUNK_ERROR.LEVEL_SCHEMA,
      'level chunk carries car bodies; expected a level-only document');
  }
  if (!Array.isArray(doc.meshes) || doc.meshes.length !== 2) {
    throw new ChunkLoadError(CHUNK_ERROR.LEVEL_SCHEMA, 'level chunk does not carry the two static meshes');
  }
  return doc;
}

/** Parse the small map-mode base document (materials/light/camera/roster). */
export function parseBaseChunk(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new ChunkLoadError(CHUNK_ERROR.BASE_SCHEMA, 'base chunk is not JSON: ' + error.message);
  }
  if (doc?.kind !== LEVEL_CHUNK_KIND || doc.version !== GEOMETRY_VERSION || doc.chunk?.kind !== 'base') {
    throw new ChunkLoadError(CHUNK_ERROR.BASE_SCHEMA,
      'base chunk kind/version is not ' + LEVEL_CHUNK_KIND + ' v' + GEOMETRY_VERSION + ' base');
  }
  if (!isObject(doc.carBodies) || Object.keys(doc.carBodies).length !== 0) {
    throw new ChunkLoadError(CHUNK_ERROR.BASE_SCHEMA, 'base chunk carries car bodies; expected metadata only');
  }
  return doc;
}

/** Parse and validate one car chunk, pinned by the index entry for that slug. */
export function parseCarChunk(text, index, slug) {
  const entry = index?.cars?.[slug];
  if (!entry) {
    throw new ChunkLoadError(CHUNK_ERROR.CAR_UNKNOWN,
      'car ' + JSON.stringify(slug) + ' is not in the chunk index; available: ' +
      Object.keys(index?.cars ?? {}).join(', '));
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new ChunkLoadError(CHUNK_ERROR.CAR_SCHEMA, 'car chunk ' + slug + ' is not JSON: ' + error.message);
  }
  if (doc?.kind !== CAR_CHUNK_KIND || doc.version !== CHUNK_VERSION) {
    throw new ChunkLoadError(CHUNK_ERROR.CAR_SCHEMA,
      'car chunk ' + slug + ' kind/version is not ' + CAR_CHUNK_KIND + ' v' + CHUNK_VERSION,
      { kind: doc?.kind ?? null, version: doc?.version ?? null });
  }
  if (doc.geometryVersion !== GEOMETRY_VERSION) {
    throw new ChunkLoadError(CHUNK_ERROR.CAR_SCHEMA,
      'car chunk ' + slug + ' was built for geometry v' + doc.geometryVersion);
  }
  if (doc.slug !== slug || doc.chunk?.kind !== 'car' || doc.chunk?.slug !== slug) {
    throw new ChunkLoadError(CHUNK_ERROR.CAR_SCHEMA,
      'car chunk ' + slug + ' names ' + JSON.stringify({ slug: doc.slug, chunk: doc.chunk?.slug ?? null }));
  }
  if (!Array.isArray(doc.carDraws) || doc.carDraws.length !== entry.draws ||
      !Array.isArray(doc.carNodes) || !Array.isArray(doc.wheelGroups) || doc.wheelGroups.length !== 4 ||
      !doc.mesh || doc.mesh.id !== entry.meshId) {
    throw new ChunkLoadError(CHUNK_ERROR.CAR_SCHEMA,
      'car chunk ' + slug + ' does not match its index draw/mesh/wheel counts',
      { entry, draws: doc.carDraws?.length ?? null, meshId: doc.mesh?.id ?? null });
  }
  if (doc.manifest?.fallback === true) {
    throw new ChunkLoadError(CHUNK_ERROR.CAR_SCHEMA,
      'car chunk ' + slug + ' is the documented fallback body; no silent substitute is allowed');
  }
  return doc;
}

/**
 * Merge a level/base document and one car chunk into the document the packet
 * adapter consumed before chunking. `carBodies` holds exactly the driven body,
 * so no other car can be drawn by accident.
 */
export function assembleGeometry(levelDoc, carBody, { index = null } = {}) {
  if (!levelDoc || !carBody?.slug) {
    throw new ChunkLoadError(CHUNK_ERROR.CAR_SCHEMA, 'cannot assemble geometry without a level and a car body');
  }
  const fallback = carBody.manifest?.fallback === true;
  return {
    ...levelDoc,
    carBodies: { [carBody.slug]: carBody },
    fallbackBodies: fallback
      ? [{ slug: carBody.slug, reason: carBody.manifest.fallbackReason ?? 'fallback body' }] : [],
    fallbackBodyCount: fallback ? 1 : 0,
    chunk: {
      kind: 'assembled',
      version: CHUNK_VERSION,
      level: levelDoc.chunk?.kind ?? 'level',
      car: carBody.slug,
      carSha256: index?.cars?.[carBody.slug]?.sha256 ?? null,
      carDrawSlots: index?.cars
        ? Math.max(carBody.carDraws?.length ?? 0,
          ...Object.values(index.cars).map((entry) => entry.draws ?? 0))
        : carBody.carDraws?.length ?? 0,
      note: 'one level/base document + one car chunk; packet schema unchanged'
    }
  };
}

/** Relative chunk URL made absolute against the index URL. */
export function chunkUrl(indexUrl, file) {
  return new URL(file, new URL(indexUrl, globalThis.location?.href ?? 'http://localhost/')).pathname;
}
