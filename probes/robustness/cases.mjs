// Hand-written malformed-input cases for every browser-build input.
//
// Each case names the contract (`stage`), the expected outcome and the impact
// used for ranking. `run()` throws when the input is rejected; returning means
// it was accepted. Validators that return `{ok, errors}` are wrapped with
// `rejectOnErrors`, so a validator rejection is recorded as a typed detection.
//
// Where the live page has no guard, the case runs the real downstream function
// that would run (createSession / isRigid / Uint32Array / matrixFromQuaternion)
// and cites the source lines that show the missing check. Those cases are
// labelled `page-contract` and are reimplementations of the *absence* of a
// check, not of a format.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  ChunkLoadError, assembleGeometry, parseBaseChunk, parseCarChunk, parseChunkIndex, parseLevelChunk,
  verifyChunkBytes, verifyChunkSha
} from '../e1-drive/web/geometry-chunks.js';
import { validateMapPackage } from '../e1-drive/web/map-package.js';
import { validateSprintLayout } from '../e1-drive/web/sprint-layout.js';
import {
  GHOST_KEY_PREFIX, createGhostStore, decodeGhost, ghostHash, matrixFromQuaternion, validateGhostRecord
} from '../e1-drive/web/ghost-replay.js';
import { createBestTimes } from '../e1-drive/web/sprint-best.js';
import {
  MpMapError, assertMpMapAgreement, buildMpResult, compareMpMapRecords, normalizePlayerName, normalizeRoomCode
} from '../e1-drive/web/mp-client.js';
import { fieldsUrl, loadRoster, resolveCar } from '../e1-drive/web/cars.js';
import { SPRINT_PROP_PINS, checkPropManifest } from '../e1-drive/web/prop-layer.js';
import { createSession } from '../e1-drive/web/packet-adapter.js';
import { hashOf } from '../e1-drive/web/packet-hash.js';
import { isRigid } from '../render-packet/web/interpolate.js';
import { packetHash, validatePacket } from '../render-packet/tools/packet-format.mjs';
import { checkInput, checkState, quantizeInput, quantizeState, validRoomCode } from '../net-mvp/protocol.mjs';

import {
  CAR_MESH_ID, IDENTITY, REAL_PATHS, ROOT, SLUG, WHEEL_CORNERS, hashOf as hashOfLocal, readCommittedJson,
  syntheticGeometry, tick0State, validBaseDoc, validCarDoc, validIndexDoc, validLevelDoc, validPacket
} from './lib/fixtures.mjs';
import { assert, rejectOnErrors } from './lib/probe.mjs';

const clone = (value) => structuredClone(value);
const sha = (text) => 'sha256:' + createHash('sha256').update(text).digest('hex');
const json = (value) => JSON.stringify(value);

/** Recompute a layout hash after a structural mutation. */
function rehash(doc) {
  const body = { ...doc };
  delete body.hash;
  doc.hash = hashOf(body);
  return doc;
}

/** Minimal legal sprint layout used by validateMapPackage cases. */
function syntheticMapFixture() {
  const renderContentHash = 'sha256:' + '1'.repeat(64);
  const physicsSha = 'sha256:' + '2'.repeat(64);
  const map = {
    kind: 'e1-drive.map-package',
    version: 1,
    hash: 'sha256:' + '3'.repeat(64),
    level: 'synthetic',
    source: {
      render: { path: '_work/synthetic/render.json', sha256: 'sha256:' + '4'.repeat(64), contentHash: renderContentHash },
      slice: { path: '_work/synthetic/slice.json', sha256: 'sha256:' + '5'.repeat(64), contentHash: 'sha256:' + '6'.repeat(64) },
      physics: { sha256: physicsSha, bytes: 10 }
    },
    counts: {
      draws: 1, drawTriangles: 1, textures: 1, textureBytes: 4, vertices: 1, indices: 3,
      blockedDraws: 0, decalDraws: 0, diagnosticDraws: 0, collisionTriangles: 0
    },
    meshes: [{ id: 'synthetic.merged', uv: { vertexCount: 1 } }],
    mapRender: {
      label: 'synthetic-direct-draws',
      meshId: 'synthetic.merged',
      draws: [{ id: 'synthetic.draw.0', indexCount: 3, indexOffset: 0, textureId: 'tex.0' }],
      textures: [{ id: 'tex.0', rgbaBase64: 'AAAAAA==', rgbaBytes: 4, width: 1, height: 1 }],
      vertexCount: 1,
      blocked: { effectDecal: { draws: 0 }, diagnosticOnly: { draws: 0 } },
      instances: { applied: false, descriptions: 0 },
      unsupportedSections: 0,
      normals: { vertexNormals: 0, fallback: 'screen-space derivative normals' },
      limits: {},
      texturePack: { uniqueBlobs: 1, bytesMip0: 4 }
    }
  };
  const gate = (index, kind, arc) => ({
    id: kind + '.' + index,
    kind,
    index,
    arc,
    x: arc,
    z: 0,
    headingRad: 0,
    a: [arc, -1],
    b: [arc, 1],
    tangent: { tx: 1, tz: 0 },
    coverage: { covered: true }
  });
  const layout = {
    kind: 'e1-drive.sprint',
    version: 1,
    hash: null,
    courseId: 'synthetic',
    course: {
      sampleCount: 3,
      samples: [
        { x: 0, z: 0, groundY: 0, arc: 0 },
        { x: 1, z: 0, groundY: 0, arc: 1 },
        { x: 2, z: 0, groundY: 0, arc: 2 }
      ],
      lengthMetres: 2,
      finishArc: 2,
      spawn: { x: 0, z: 0, headingRad: 0 },
      band: { halfWidthMetres: 6 }
    },
    gates: [gate(0, 'start', 0), gate(1, 'checkpoint', 1), gate(2, 'checkpoint', 1.5), gate(3, 'finish', 2)],
    countdown: { ticks: 90 },
    rules: { respawn: { fallBelowGroundMetres: 1 } },
    source: { render: { contentHash: renderContentHash }, physics: { sha256: physicsSha } }
  };
  rehash(layout);
  const pins = {
    mapContentHash: map.hash,
    layoutContentHash: layout.hash,
    renderFileSha256: map.source.render.sha256,
    renderContentHash,
    sliceFileSha256: map.source.slice.sha256,
    sliceContentHash: map.source.slice.contentHash,
    physicsFileSha256: physicsSha,
    physicsBytes: 10,
    renderLabel: 'synthetic-direct-draws',
    draws: 1,
    drawTriangles: 1,
    textures: 1,
    textureBytes: 4,
    vertices: 1,
    indices: 3,
    blockedDraws: 0,
    decalDraws: 0,
    diagnosticDraws: 0,
    collisionTriangles: 0,
    instanceDescriptions: 0,
    unsupportedSections: 0,
    courseId: 'synthetic',
    sampleCount: 3,
    pathLengthMetres: 2,
    checkpointArcs: [1, 1.5]
  };
  return { map, layout, pins };
}

function rosterFixture() {
  return {
    kind: 'e1-drive.car-roster',
    version: 1,
    status: 'PASS',
    failures: [],
    roster: {
      default: SLUG,
      cars: [{
        slug: SLUG,
        name: 'Corvette_ZR1_Stock',
        drivetrain: 'RWD',
        record: { index: 37, id: 1554942492 },
        values: { mass: 1600, gears: 6 },
        fields: { path: '_work/e1-drive/cars/' + SLUG + '.fields', bytes: 7489, sha256: sha('fields') }
      }]
    }
  };
}

function fakeFetch(document, { status = 200, text = null } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (typeof document === 'string') return JSON.parse(document);
      return document;
    },
    async text() { return text ?? json(document); }
  });
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map)
  };
}

function throwingStorage(message = 'QuotaExceededError') {
  return {
    getItem: () => { throw new Error(message); },
    setItem: () => { throw new Error(message); }
  };
}

function validGhostRecord() {
  return readCommittedJson(REAL_PATHS.ghost);
}

function withGhostFloats(record, mutator) {
  const next = clone(record);
  const bytes = Buffer.from(next.sample.data, 'base64');
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  mutator(floats);
  next.sample.data = Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
  next.hash = ghostHash(next);
  return next;
}

function validSprintLayout() {
  return readCommittedJson(REAL_PATHS.sprintShort);
}

function validPropManifest() {
  return readCommittedJson(REAL_PATHS.publishedManifest);
}

function validNetState(overrides = {}) {
  return { tick: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1], speed: 0, ...overrides };
}

function validNetInput(overrides = {}) {
  return { throttle: 0, brake: 0, steer: 0, handbrake: 0, ...overrides };
}

const allCases = [];

function add(cases) {
  for (const entry of cases) allCases.push(entry);
}

// ------------------------------------------------------------------ chunk index
function chunkIndexCases() {
  const cases = [];
  const valid = validIndexDoc();
  const mutate = (fn) => { const next = clone(valid); fn(next); return json(next); };

  cases.push({
    id: 'chunk.index.valid', group: 'chunk-index', input: 'car-bodies.index.json', stage: 'parseChunkIndex',
    description: 'the synthetic index with the same shape as the committed one', expected: 'accept', impact: 0,
    run: () => parseChunkIndex(json(valid))
  });
  cases.push({
    id: 'chunk.index.empty', group: 'chunk-index', input: 'car-bodies.index.json', stage: 'parseChunkIndex',
    description: 'zero-byte file (truncated download)', expected: 'reject', impact: 4,
    remediation: 'keep the typed INDEX_SCHEMA path and add the byte count to the message',
    run: () => parseChunkIndex('')
  });
  cases.push({
    id: 'chunk.index.truncated-json', group: 'chunk-index', input: 'car-bodies.index.json', stage: 'parseChunkIndex',
    description: 'JSON cut mid-object', expected: 'reject', impact: 4,
    run: () => parseChunkIndex(json(valid).slice(0, 120))
  });
  for (const [id, mutateFn, impact] of [
    ['kind', (doc) => { doc.kind = 'wrong'; }, 4],
    ['version', (doc) => { doc.version = 2; }, 4],
    ['geometry-version', (doc) => { doc.geometryVersion = 5; }, 5],
    ['level-missing', (doc) => { delete doc.level; }, 4],
    ['base-missing', (doc) => { delete doc.base; }, 4],
    ['cars-array', (doc) => { doc.cars = []; }, 4],
    ['level-sha-uppercase', (doc) => { doc.level.sha256 = doc.level.sha256.toUpperCase(); }, 3],
    ['level-sha-short', (doc) => { doc.level.sha256 = doc.level.sha256.slice(0, 20); }, 4],
    ['default-car-uncovered', (doc) => { doc.defaultCar = 'not-a-car'; }, 4],
    ['car-key-names-other', (doc) => { doc.cars[SLUG].slug = 'other-car'; }, 4],
    ['car-sha-missing', (doc) => { delete doc.cars[SLUG].sha256; }, 4],
    ['car-fallback', (doc) => { doc.cars[SLUG].fallback = true; }, 5]
  ]) {
    cases.push({
      id: 'chunk.index.' + id, group: 'chunk-index', input: 'car-bodies.index.json', stage: 'parseChunkIndex',
      description: 'index field "' + id + '" corrupted', expected: 'reject', impact,
      run: () => parseChunkIndex(mutate(mutateFn))
    });
  }
  cases.push({
    id: 'chunk.index.extra-field', group: 'chunk-index', input: 'car-bodies.index.json', stage: 'parseChunkIndex',
    description: 'unknown top-level field (forward compatibility)', expected: 'accept', impact: 1,
    run: () => parseChunkIndex(mutate((doc) => { doc.futureField = { ignored: true }; }))
  });
  cases.push({
    id: 'chunk.index.car-bytes-negative', group: 'chunk-index', input: 'car-bodies.index.json',
    stage: 'parseChunkIndex + verifyChunkBytes', description:
      'negative byte count: the index parser accepts it, verifyChunkBytes rejects it (delegated, typed)',
    expected: 'reject', impact: 4,
    evidence: 'geometry-chunks.js:102-113 checks only sha256; geometry-chunks.js:52-62 checks bytes',
    run: () => {
      const index = parseChunkIndex(mutate((doc) => { doc.cars[SLUG].bytes = -1; }));
      return verifyChunkBytes(new Uint8Array(4), index.cars[SLUG], 'car', { schema: 'S', bytes: 'B' });
    }
  });
  cases.push({
    id: 'chunk.index.car-bytes-float', group: 'chunk-index', input: 'car-bodies.index.json',
    stage: 'parseChunkIndex + verifyChunkBytes', description: 'fractional byte count is rejected by the byte check',
    expected: 'reject', impact: 3,
    run: () => {
      const index = parseChunkIndex(mutate((doc) => { doc.cars[SLUG].bytes = 1.5; }));
      return verifyChunkBytes(new Uint8Array(4), index.cars[SLUG], 'car', { schema: 'S', bytes: 'B' });
    }
  });
  cases.push({
    id: 'chunk.index.car-file-missing', group: 'chunk-index', input: 'car-bodies.index.json',
    stage: 'parseChunkIndex + URL construction', description:
      'a missing file name is accepted by the parser; the loader would fetch /undefined and fail with CAR_MISSING (loud, but the message names a wrong URL)',
    expected: 'accept', impact: 2,
    evidence: 'app.js:2238 new URL(entry.file, ...)',
    run: () => {
      const index = parseChunkIndex(mutate((doc) => { delete doc.cars[SLUG].file; }));
      if (index.cars[SLUG].file !== undefined) throw new Error('test setup: file was not removed');
    }
  });
  cases.push({
    id: 'chunk.index.policy-missing', group: 'chunk-index', input: 'car-bodies.index.json', stage: 'parseChunkIndex',
    description: 'the documented residency policy block removed', expected: 'accept', impact: 1,
    run: () => parseChunkIndex(mutate((doc) => { delete doc.policy; }))
  });
  cases.push({
    id: 'chunk.index.duplicate-car-key-json', group: 'chunk-index', input: 'car-bodies.index.json', stage: 'parseChunkIndex',
    description: 'duplicate JSON key for one car: JSON.parse keeps the last entry',
    expected: 'accept', impact: 2,
    run: () => {
      const text = json(valid).replace('"cars":{', '"cars":{"' + SLUG + '":{"sha256":"sha256:' + '0'.repeat(64) + '","file":"bogus"},');
      return parseChunkIndex(text);
    }
  });
  return cases;
}

// ------------------------------------------------------------------ level chunk
function levelChunkCases() {
  const cases = [];
  const valid = validLevelDoc();
  const mutate = (fn) => { const next = clone(valid); fn(next); return json(next); };
  const reject = (id, description, mutateFn, impact, stage = 'parseLevelChunk') => cases.push({
    id: 'chunk.level.' + id, group: 'level-chunk', input: 'level.geometry.json', stage,
    description, expected: 'reject', impact, run: () => parseLevelChunk(mutate(mutateFn))
  });

  cases.push({
    id: 'chunk.level.valid', group: 'level-chunk', input: 'level.geometry.json', stage: 'parseLevelChunk',
    description: 'synthetic level chunk with the committed header shape', expected: 'accept', impact: 0,
    run: () => parseLevelChunk(json(valid))
  });
  cases.push({
    id: 'chunk.level.empty', group: 'level-chunk', input: 'level.geometry.json', stage: 'parseLevelChunk',
    description: 'zero-byte level chunk', expected: 'reject', impact: 5,
    run: () => parseLevelChunk('')
  });
  cases.push({
    id: 'chunk.level.truncated-json', group: 'level-chunk', input: 'level.geometry.json', stage: 'parseLevelChunk',
    description: 'level chunk cut mid-array (truncated download)', expected: 'reject', impact: 5,
    run: () => parseLevelChunk(json(valid).slice(0, Math.floor(json(valid).length / 2)))
  });
  reject('kind', 'kind is not e1-drive.geometry', (doc) => { doc.kind = 'blur.render-packet'; }, 5);
  reject('version', 'version 5 (stale cache from the previous build)', (doc) => { doc.version = 5; }, 5);
  reject('chunk-header', 'chunk header missing', (doc) => { delete doc.chunk; }, 4);
  reject('car-bodies', 'level chunk carries a car body', (doc) => { doc.carBodies = { x: {} }; }, 4);
  reject('mesh-count', 'only one static mesh', (doc) => { doc.meshes = doc.meshes.slice(0, 1); }, 4);
  reject('mesh-count-3', 'three static meshes (schema drift)', (doc) => { doc.meshes.push(doc.meshes[0]); }, 3);

  // Deep checks are delegated. The page runs createSession/consumer, so show
  // what that path actually does with the synthetic geometry the adapter accepts.
  const pageGeometry = (fn) => { const geometry = syntheticGeometry(); fn(geometry); return geometry; };
  cases.push({
    id: 'chunk.level.huge-vertex-count', group: 'level-chunk', input: 'level.geometry.json',
    stage: 'page-contract (producer + consumer count check)', description:
      'vertexCount 1e9 with three positions passes the chunk parser; the consumer rejects it later with an untyped count error',
    expected: 'reject', impact: 4,
    evidence: 'geometry-chunks.js:118-141 has no deep mesh check; packet-consumer.js:764',
    run: () => {
      const geometry = pageGeometry((value) => { value.meshes[0].vertexCount = 1e9; });
      const session = createSession(geometry, tick0State(), { car: { slug: SLUG, name: 'x' } });
      const mesh = session.packet.meshes[0];
      if (mesh.positions.length !== mesh.vertexCount * 3) {
        throw new Error('mesh ' + mesh.id + ' position count mismatch');
      }
    }
  });
  cases.push({
    id: 'chunk.level.negative-index-count', group: 'level-chunk', input: 'level.geometry.json',
    stage: 'page-contract (consumer draw range check)', description:
      'negative indexCount passes both the chunk parser and the consumer range check (-3 % 3 is -0) and reaches drawIndexed',
    expected: 'reject', impact: 4,
    evidence: 'packet-consumer.js:981 tests Number.isInteger(indexCount) and indexCount % 3 but not indexCount > 0 or indexOffset >= 0',
    run: () => {
      const geometry = pageGeometry((value) => { value.levelDraws[0].indexCount = -3; });
      const session = createSession(geometry, tick0State(), { car: { slug: SLUG, name: 'x' } });
      const mesh = session.packet.meshes.find((entry) => entry.id === geometry.levelDraws[0].meshId);
      const draw = session.packet.draws.find((entry) => entry.id === geometry.levelDraws[0].id);
      const validRange = Number.isInteger(draw.indexOffset) && Number.isInteger(draw.indexCount) &&
        !(draw.indexCount % 3) && !(draw.indexOffset + draw.indexCount > mesh.indexCount);
      if (!validRange) throw new Error('draw ' + draw.id + ' has an invalid index range');
    }
  });
  cases.push({
    id: 'chunk.level.null-positions-page', group: 'level-chunk', input: 'level.geometry.json',
    stage: 'page-contract (createSession occluder)', description:
      'null mesh positions reach camera-occlusion and throw an untyped TypeError instead of LEVEL_SCHEMA',
    expected: 'reject', impact: 3,
    evidence: 'probes/e1-drive/web/camera-occlusion.js:60 reads mesh.positions.length',
    run: () => {
      const geometry = pageGeometry((value) => { value.meshes[0].positions = null; });
      return createSession(geometry, tick0State(), { car: { slug: SLUG, name: 'x' } });
    }
  });
  cases.push({
    id: 'chunk.level.nan-position-page', group: 'level-chunk', input: 'level.geometry.json',
    stage: 'page-contract (producer + consumer float upload)', description:
      'a non-finite mesh position is accepted by createSession; the consumer uploads it to the GPU verbatim',
    expected: 'reject', impact: 4,
    evidence: 'packet-adapter.js:437-449 copies positions; packet-consumer.js:762-767 uploads without a finite check; validatePacket is not called by the page',
    run: () => {
      const geometry = pageGeometry((value) => { value.meshes[0].positions = [NaN, 0, 0, 1, 0, 0, 0, 1, 0]; });
      const session = createSession(geometry, tick0State(), { car: { slug: SLUG, name: 'x' } });
      const uploaded = Float32Array.from(session.packet.meshes[0].positions);
      if (!uploaded.some(Number.isNaN)) throw new Error('test setup: NaN was not preserved');
    }
  });
  cases.push({
    id: 'chunk.level.index-out-of-range-page', group: 'level-chunk', input: 'level.geometry.json',
    stage: 'page-contract (consumer index upload)', description:
      'an index reference outside the vertex range is uploaded as a Uint32 index (GPU reads out of bounds)',
    expected: 'reject', impact: 4,
    evidence: 'packet-consumer.js:980-983 checks draw ranges, not index values',
    run: () => {
      const geometry = pageGeometry((value) => { value.meshes[0].indices = [0, 1, 99]; });
      const session = createSession(geometry, tick0State(), { car: { slug: SLUG, name: 'x' } });
      const uploaded = Uint32Array.from(session.packet.meshes[0].indices);
      if (uploaded[2] !== 99) throw new Error('test setup: index was not preserved');
    }
  });
  cases.push({
    id: 'chunk.level.index-u32-wrap', group: 'level-chunk', input: 'level.geometry.json',
    stage: 'page-contract (consumer Uint32 conversion)', description:
      'an index >= 2^32 wraps silently in Uint32Array and points at a different vertex',
    expected: 'reject', impact: 4,
    evidence: 'packet-consumer.js:767 Uint32Array.from(mesh.indices)',
    run: () => {
      const wrapped = Uint32Array.from([4294967296]);
      if (wrapped[0] !== 0) throw new Error('test setup: Uint32Array did not wrap');
    }
  });
  cases.push({
    id: 'chunk.level.extra-field', group: 'level-chunk', input: 'level.geometry.json', stage: 'parseLevelChunk',
    description: 'unknown level field (forward compatibility)', expected: 'accept', impact: 1,
    run: () => parseLevelChunk(mutate((doc) => { doc.future = true; }))
  });
  return cases;
}

// ------------------------------------------------------------------- base chunk
function baseChunkCases() {
  const valid = validBaseDoc();
  const mutate = (fn) => { const next = clone(valid); fn(next); return json(next); };
  return [
    {
      id: 'chunk.base.valid', group: 'base-chunk', input: 'base.geometry.json', stage: 'parseBaseChunk',
      description: 'synthetic base chunk', expected: 'accept', impact: 0, run: () => parseBaseChunk(json(valid))
    },
    ...[
      ['empty', (doc) => { doc.carBodies = {}; delete doc.kind; }, 4],
      ['kind', (doc) => { doc.kind = 'x'; }, 4],
      ['version', (doc) => { doc.version = 5; }, 4],
      ['chunk-header', (doc) => { doc.chunk.kind = 'level'; }, 4],
      ['car-bodies', (doc) => { doc.carBodies[SLUG] = {}; }, 4]
    ].map(([id, fn, impact]) => ({
      id: 'chunk.base.' + id, group: 'base-chunk', input: 'base.geometry.json', stage: 'parseBaseChunk',
      description: 'base field "' + id + '" corrupted', expected: 'reject', impact,
      run: () => parseBaseChunk(mutate(fn))
    })),
    {
      id: 'chunk.base.extra-field', group: 'base-chunk', input: 'base.geometry.json', stage: 'parseBaseChunk',
      description: 'unknown base field', expected: 'accept', impact: 1,
      run: () => parseBaseChunk(mutate((doc) => { doc.future = 1; }))
    }
  ];
}

// -------------------------------------------------------------------- car chunk
function carChunkCases() {
  const cases = [];
  const validIndex = validIndexDoc();
  const valid = validCarDoc();
  const mutate = (fn) => { const next = clone(valid); fn(next); return json(next); };
  const reject = (id, description, fn, impact) => cases.push({
    id: 'chunk.car.' + id, group: 'car-chunk', input: 'cars/<slug>.geometry.json', stage: 'parseCarChunk',
    description, expected: 'reject', impact, run: () => parseCarChunk(mutate(fn), validIndex, SLUG)
  });

  cases.push({
    id: 'chunk.car.valid', group: 'car-chunk', input: 'cars/<slug>.geometry.json', stage: 'parseCarChunk',
    description: 'synthetic car chunk matching its index entry', expected: 'accept', impact: 0,
    run: () => parseCarChunk(json(valid), validIndex, SLUG)
  });
  cases.push({
    id: 'chunk.car.unknown-slug', group: 'car-chunk', input: 'cars/<slug>.geometry.json', stage: 'parseCarChunk',
    description: 'car not present in the index', expected: 'reject', impact: 4,
    run: () => parseCarChunk(json(valid), validIndex, 'not-a-car')
  });
  cases.push({
    id: 'chunk.car.empty', group: 'car-chunk', input: 'cars/<slug>.geometry.json', stage: 'parseCarChunk',
    description: 'zero-byte car chunk', expected: 'reject', impact: 5,
    run: () => parseCarChunk('', validIndex, SLUG)
  });
  reject('kind', 'kind is not e1-drive.car-chunk', (doc) => { doc.kind = 'x'; }, 5);
  reject('version', 'car chunk version 2', (doc) => { doc.version = 2; }, 5);
  reject('geometry-version', 'car chunk built for geometry v5', (doc) => { doc.geometryVersion = 5; }, 5);
  reject('slug', 'chunk names another car', (doc) => { doc.slug = 'other'; }, 5);
  reject('chunk-kind', 'chunk header kind is not car', (doc) => { doc.chunk.kind = 'level'; }, 4);
  reject('draws-missing', 'carDraws missing', (doc) => { delete doc.carDraws; }, 4);
  cases.push({
    id: 'chunk.car.draws-count', group: 'car-chunk', input: 'cars/<slug>.geometry.json', stage: 'parseCarChunk',
    description: 'one draw but the index pins two', expected: 'reject', impact: 4,
    run: () => {
      const index = clone(validIndex);
      index.cars[SLUG].draws = 2;
      return parseCarChunk(json(valid), index, SLUG);
    }
  });
  reject('wheel-groups', 'only three wheel groups', (doc) => { doc.wheelGroups = doc.wheelGroups.slice(0, 3); }, 5);
  reject('mesh-id', 'mesh id differs from the index', (doc) => { doc.mesh.id = 'other'; }, 4);
  reject('fallback', 'documented fallback body', (doc) => { doc.manifest.fallback = true; }, 5);
  reject('nodes-missing', 'carNodes missing', (doc) => { delete doc.carNodes; }, 4);

  // Deep/producer cases.
  cases.push({
    id: 'chunk.car.duplicate-draw-ids', group: 'car-chunk', input: 'cars/<slug>.geometry.json',
    stage: 'page-contract (createSession)', description:
      'two car draws with the same id: the node ownership check sees 1 of 2 draws and throws an untyped Error',
    expected: 'reject', impact: 3,
    evidence: 'packet-adapter.js:412-425',
    run: () => {
      const doc = clone(valid);
      doc.carDraws.push({ ...doc.carDraws[0] });
      const geometry = syntheticGeometry(); geometry.carBodies[SLUG] = doc;
      return createSession(geometry, tick0State(), { car: { slug: SLUG, name: 'x' } });
    }
  });
  cases.push({
    id: 'chunk.car.wheel-matrix-null', group: 'car-chunk', input: 'cars/<slug>.geometry.json',
    stage: 'page-contract (createSession matrix coercion)', description:
      'a null wheel-rest translation coerces to 0 in multiplyMat4, so the car is accepted with the wheel offset silently lost',
    expected: 'reject', impact: 4,
    evidence: 'packet-adapter.js:62-74 multiplyMat4 (null * n === 0); no finite/type check before the matrix is used',
    run: () => {
      const doc = clone(valid);
      doc.wheelGroups[0].matrixColumnMajor[12] = null;
      const geometry = syntheticGeometry();
      geometry.carBodies[SLUG] = doc;
      const session = createSession(geometry, tick0State(), { car: { slug: SLUG, name: 'x' } });
      const update = session.appendState(tick0State({ tick: 1, speed: 1 }));
      for (const entry of update.matrices) {
        if (!isRigid(entry.world)) throw new Error('tick 1 matrix for ' + entry.nodeId + ' is not rigid');
      }
    }
  });
  cases.push({
    id: 'chunk.car.duplicate-texture-ids', group: 'car-chunk', input: 'cars/<slug>.geometry.json',
    stage: 'page-contract (createSession)', description: 'duplicate texture id across the packet texture set',
    expected: 'reject', impact: 3, evidence: 'packet-adapter.js:483-488',
    run: () => {
      const doc = clone(valid);
      doc.textures.push({ ...doc.textures[0] });
      const geometry = syntheticGeometry(); geometry.carBodies[SLUG] = doc;
      return createSession(geometry, tick0State(), { car: { slug: SLUG, name: 'x' } });
    }
  });
  cases.push({
    id: 'chunk.car.texture-unknown', group: 'car-chunk', input: 'cars/<slug>.geometry.json',
    stage: 'page-contract (createSession)', description: 'a car draw names a texture absent from the packet',
    expected: 'reject', impact: 3, evidence: 'packet-adapter.js:505-513',
    run: () => {
      const doc = clone(valid);
      doc.carDraws[0].textureId = 'missing.texture';
      doc.carDraws[0].uvFlipU = true;
      const geometry = syntheticGeometry(); geometry.carBodies[SLUG] = doc;
      return createSession(geometry, tick0State(), { car: { slug: SLUG, name: 'x' } });
    }
  });
  cases.push({
    id: 'chunk.car.extra-field', group: 'car-chunk', input: 'cars/<slug>.geometry.json', stage: 'parseCarChunk',
    description: 'unknown car chunk field', expected: 'accept', impact: 1,
    run: () => parseCarChunk(mutate((doc) => { doc.future = { x: 1 }; }), validIndex, SLUG)
  });
  return cases;
}

// --------------------------------------------------------------- byte/hash checks
function chunkByteCases() {
  const spec = { bytes: 4, sha256: 'sha256:' + 'a'.repeat(64) };
  const reject = (id, description, run, impact = 4) => ({
    id: 'chunk.bytes.' + id, group: 'chunk-bytes', input: 'chunk bytes + index entry', stage: 'verifyChunkBytes/verifyChunkSha',
    description, expected: 'reject', impact, run
  });
  return [
    {
      id: 'chunk.bytes.valid', group: 'chunk-bytes', input: 'chunk bytes + index entry', stage: 'verifyChunkBytes',
      description: 'matching length and hash', expected: 'accept', impact: 0,
      run: () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        verifyChunkBytes(bytes, spec, 'x', { schema: 'S', bytes: 'B' });
        return verifyChunkSha(bytes, { ...spec, sha256: sha(Buffer.from(bytes)) }, 'x', async (value) => sha(Buffer.from(value)), { sha: 'H' });
      }
    },
    reject('truncated', 'three of four bytes (truncated download)',
      () => verifyChunkBytes(new Uint8Array([1, 2, 3]), spec, 'x', { schema: 'S', bytes: 'B' })),
    reject('empty', 'zero bytes', () => verifyChunkBytes(new Uint8Array(0), spec, 'x', { schema: 'S', bytes: 'B' })),
    reject('spec-bytes-missing', 'index entry has no byte count',
      () => verifyChunkBytes(new Uint8Array(4), { sha256: spec.sha256 }, 'x', { schema: 'S', bytes: 'B' })),
    reject('spec-sha-missing', 'index entry has no hash',
      () => verifyChunkBytes(new Uint8Array(4), { bytes: 4 }, 'x', { schema: 'S', bytes: 'B' })),
    reject('wrong-hash', 'same length, different bytes (stale cache)',
      () => verifyChunkSha(new Uint8Array([9, 9, 9, 9]), spec, 'x', async (value) => 'sha256:' + createHash('sha256').update(value).digest('hex'), { sha: 'H' })),
    reject('not-bytes', 'a string instead of a byte body',
      () => verifyChunkBytes('abcd', spec, 'x', { schema: 'S', bytes: 'B' })),
    reject('hash-uppercase', 'index hash with uppercase hex',
      () => verifyChunkBytes(new Uint8Array(4), { ...spec, sha256: spec.sha256.toUpperCase() }, 'x', { schema: 'S', bytes: 'B' }))
  ];
}

// ----------------------------------------------------------------- packet schema
function packetCases() {
  const cases = [];
  const base = validPacket();
  const mutate = (fn) => { const next = clone(base); fn(next); return next; };
  const offline = (id, description, fn, impact = 4) => cases.push({
    id: 'packet.' + id, group: 'packet', input: 'packet v1.1 JSON', stage: 'validatePacket (offline contract)',
    description, expected: 'reject', impact,
    run: () => rejectOnErrors(validatePacket(fn()), 'validatePacket')
  });
  cases.push({
    id: 'packet.valid', group: 'packet', input: 'packet v1.1 JSON', stage: 'validatePacket (offline contract)',
    description: 'packet produced by the live adapter', expected: 'accept', impact: 0,
    run: () => rejectOnErrors(validatePacket(base), 'validatePacket')
  });
  offline('kind', 'kind is not blur.render-packet', () => mutate((p) => { p.kind = 'x'; }), 4);
  offline('version', 'unsupported packet version 2', () => mutate((p) => { p.version = 2; }), 4);
  offline('missing-camera', 'camera removed', () => mutate((p) => { delete p.camera; }), 5);
  offline('camera-near-above-far', 'camera near > far', () => mutate((p) => { p.camera.near = 10; p.camera.far = 1; }));
  offline('alpha-nan', 'update alpha is NaN', () => mutate((p) => { p.updates[1].alpha = NaN; }));
  offline('duplicate-mesh-id', 'two meshes with the same id', () => mutate((p) => { p.meshes[1].id = p.meshes[0].id; }), 3);
  offline('duplicate-draw-id', 'two draws with the same id', () => mutate((p) => { p.draws[1].id = p.draws[0].id; }), 3);
  offline('index-out-of-range', 'mesh index 99 with three vertices', () => mutate((p) => { p.meshes[0].indices[0] = 99; }), 4);
  offline('index-u32-wrap', 'mesh index 2^32', () => mutate((p) => { p.meshes[0].indices[0] = 4294967296; }), 4);
  offline('position-nan', 'mesh position NaN', () => mutate((p) => { p.meshes[0].positions[0] = NaN; }), 4);
  offline('duplicate-ticks', 'two updates with the same tick', () => mutate((p) => { p.updates[2].tick = p.updates[1].tick; }), 4);
  offline('matrix-not-rigid', 'draw world matrix with shear', () => mutate((p) => { p.draws[0].world[1] = 0.5; }), 4);
  cases.push({
    id: 'packet.extra-field', group: 'packet', input: 'packet v1.1 JSON', stage: 'validatePacket (offline contract)',
    description: 'unknown top-level field', expected: 'accept', impact: 1,
    run: () => {
      const packet = mutate((p) => { p.future = 1; });
      packet.hash = packetHash(packet);
      return rejectOnErrors(validatePacket(packet), 'validatePacket');
    }
  });

  // What the page actually runs: the WebGPU consumer, not validatePacket.
  cases.push({
    id: 'packet.position-nan-page', group: 'packet', input: 'packet v1.1 JSON', stage: 'page-contract (consumer upload)',
    description: 'NaN position reaches the GPU buffer: no finite check in Consumer.load, validatePacket is never called',
    expected: 'reject', impact: 4,
    evidence: 'packet-consumer.js:762-767; app.js never imports packet-format.mjs',
    run: () => {
      const uploaded = Float32Array.from(mutate((p) => { p.meshes[0].positions[0] = NaN; }).meshes[0].positions);
      if (!Number.isNaN(uploaded[0])) throw new Error('test setup: NaN lost');
    }
  });
  cases.push({
    id: 'packet.camera-nan-page', group: 'packet', input: 'packet v1.1 JSON', stage: 'page-contract (consumer camera)',
    description: 'a NaN camera projection is used without a finite check; the frame is silently invalid',
    expected: 'reject', impact: 4,
    evidence: 'packet-consumer.js:749-752 validates only kind/version/matrixConvention',
    run: () => {
      const packet = mutate((p) => { p.camera.projection[0] = NaN; });
      if (packet.camera.projection.every(Number.isFinite)) throw new Error('test setup: camera stayed finite');
    }
  });
  cases.push({
    id: 'packet.duplicate-mesh-page', group: 'packet', input: 'packet v1.1 JSON', stage: 'page-contract (consumer mesh map)',
    description: 'duplicate mesh ids silently overwrite in the consumer Map',
    expected: 'reject', impact: 2,
    evidence: 'packet-consumer.js:806-812 this.meshes.set(mesh.id, ...)',
    run: () => {
      const packet = mutate((p) => { p.meshes[1].id = p.meshes[0].id; });
      const map = new Map();
      for (const mesh of packet.meshes) map.set(mesh.id, mesh);
      if (map.size !== packet.meshes.length) throw new Error('test setup: ids were unique');
    }
  });
  return cases;
}

// ------------------------------------------------------------- engine state path
function stateCases() {
  const build = () => createSession(syntheticGeometry(), tick0State(), { car: { slug: SLUG, name: 'x' } });
  const cases = [];
  cases.push({
    id: 'state.valid', group: 'engine-state', input: 'wasm e1_get_state()', stage: 'createSession.appendState',
    description: 'settled tick and one driven tick', expected: 'accept', impact: 0,
    run: () => { const session = build(); session.appendState(tick0State({ tick: 1, speed: 2 })); }
  });
  cases.push({
    id: 'state.position-nan', group: 'engine-state', input: 'wasm e1_get_state()', stage: 'page-contract (appendState + isRigid)',
    description: 'NaN position from a diverged engine step becomes a non-rigid matrix; rejected untyped by the consumer',
    expected: 'reject', impact: 5,
    evidence: 'packet-adapter.js:1087-1117 emits without finite checks; packet-consumer.js:1138 rejects untyped',
    run: () => {
      const session = build();
      const update = session.appendState(tick0State({ tick: 1, position: [NaN, 0, 0] }));
      for (const entry of update.matrices) {
        if (!isRigid(entry.world)) throw new Error('tick ' + update.tick + ' matrix for ' + entry.nodeId + ' is not rigid');
      }
    }
  });
  cases.push({
    id: 'state.axis-infinity', group: 'engine-state', input: 'wasm e1_get_state()', stage: 'page-contract (appendState + isRigid)',
    description: 'Infinity in a body axis produces a non-rigid matrix',
    expected: 'reject', impact: 5,
    evidence: 'same path as state.position-nan',
    run: () => {
      const session = build();
      const update = session.appendState(tick0State({ tick: 1, axisX: [Infinity, 0, 0] }));
      for (const entry of update.matrices) if (!isRigid(entry.world)) throw new Error('non-rigid matrix');
    }
  });
  cases.push({
    id: 'state.wheel-angular-nan', group: 'engine-state', input: 'wasm e1_get_state()', stage: 'packet-adapter.appendState',
    description: 'a NaN wheel angular velocity on the first appended tick is silently skipped (the first tick returns before the finite check)',
    expected: 'reject', impact: 3,
    evidence: 'packet-adapter.js:1069-1074 returns when lastTick is null before the check at 1081',
    run: () => {
      const session = build();
      const state = tick0State({ tick: 1 });
      state.wheels[0].angular = NaN;
      session.appendState(state);
    }
  });
  cases.push({
    id: 'state.wheel-angular-nan-second-tick', group: 'engine-state', input: 'wasm e1_get_state()', stage: 'packet-adapter.appendState',
    description: 'a NaN wheel angular velocity on the second tick is rejected (untyped Error)', expected: 'reject', impact: 3,
    run: () => {
      const session = build();
      session.appendState(tick0State({ tick: 1 }));
      const state = tick0State({ tick: 2 });
      state.wheels[0].angular = NaN;
      session.appendState(state);
    }
  });
  cases.push({
    id: 'state.wheels-missing', group: 'engine-state', input: 'wasm e1_get_state()', stage: 'packet-adapter.appendState',
    description: 'state has three wheel records', expected: 'reject', impact: 4,
    run: () => { const session = build(); session.appendState(tick0State({ tick: 1, wheels: [] })); }
  });
  cases.push({
    id: 'state.duplicate-tick', group: 'engine-state', input: 'wasm e1_get_state()', stage: 'page-contract (appendState + syncTimeline)',
    description: 'the same tick appended twice is accepted by appendState; syncTimeline rejects it untyped',
    expected: 'reject', impact: 3,
    evidence: 'packet-consumer.js:1132-1134',
    run: () => {
      const session = build();
      session.appendState(tick0State({ tick: 1 }));
      session.appendState(tick0State({ tick: 1 }));
      const updates = session.packet.updates;
      if (!(updates[updates.length - 1].tick > updates[updates.length - 2].tick)) {
        throw new Error('appended tick ' + updates[updates.length - 1].tick + ' does not increase');
      }
    }
  });
  cases.push({
    id: 'state.tick-huge', group: 'engine-state', input: 'wasm e1_get_state()', stage: 'packet-adapter.appendState',
    description: 'tick 1e15 (over Number.MAX_SAFE_INTEGER) is accepted as a matrix update',
    expected: 'reject', impact: 2,
    run: () => { const session = build(); session.appendState(tick0State({ tick: 1e15 })); }
  });
  return cases;
}

// ------------------------------------------------------------------ sprint layout
function sprintLayoutCases() {
  const cases = [];
  const short = validSprintLayout();
  const pathLayout = () => readCommittedJson(REAL_PATHS.sprint);
  const mutate = (base, fn, { rehashDoc = true } = {}) => {
    const next = clone(base);
    fn(next);
    if (rehashDoc) rehash(next);
    return next;
  };
  const reject = (base, id, description, fn, impact = 4, stage = 'validateSprintLayout') => cases.push({
    id: 'layout.sprint.' + id, group: 'sprint-layout', input: 'sprint.json', stage,
    description, expected: 'reject', impact,
    run: () => rejectOnErrors(validateSprintLayout(mutate(base, fn)), 'validateSprintLayout')
  });
  cases.push({
    id: 'layout.sprint.valid', group: 'sprint-layout', input: 'sprint-short.json', stage: 'validateSprintLayout',
    description: 'committed 29 m regression layout', expected: 'accept', impact: 0,
    run: () => rejectOnErrors(validateSprintLayout(short), 'validateSprintLayout')
  });
  cases.push({
    id: 'layout.sprint.path-valid', group: 'sprint-layout', input: 'sprint.json', stage: 'validateSprintLayout',
    description: 'committed 310 m path layout', expected: 'accept', impact: 0,
    run: () => rejectOnErrors(validateSprintLayout(pathLayout()), 'validateSprintLayout')
  });
  cases.push({
    id: 'layout.sprint.stale-hash', group: 'sprint-layout', input: 'sprint-short.json', stage: 'validateSprintLayout',
    description: 'hand-edited gate without recomputing the content hash', expected: 'reject', impact: 5,
    run: () => rejectOnErrors(validateSprintLayout(mutate(short, (doc) => { doc.gates[3].x -= 1; }, { rehashDoc: false })), 'validateSprintLayout')
  });
  reject(short, 'kind', 'kind is not e1-drive.sprint', (doc) => { doc.kind = 'x'; }, 4);
  reject(short, 'version', 'layout version 2', (doc) => { doc.version = 2; }, 4);
  reject(short, 'gate-count', 'only two gates', (doc) => { doc.gates = doc.gates.slice(0, 2); }, 4);
  reject(short, 'gate-order', 'finish and start swapped', (doc) => {
    [doc.gates[0], doc.gates[3]] = [doc.gates[3], doc.gates[0]];
    doc.gates.forEach((gate, index) => { gate.index = index; });
  }, 4);
  reject(short, 'gate-null-x', 'gate x is null', (doc) => { doc.gates[1].x = null; }, 4);
  reject(short, 'gate-not-ahead', 'checkpoint 2 behind checkpoint 1', (doc) => { doc.gates[2].x = doc.gates[1].x - 1; }, 4);
  reject(short, 'span-finish', 'span finish no longer matches the finish gate', (doc) => { doc.course.span.finishX -= 2; }, 4);
  reject(pathLayout(), 'path-gate-not-ahead', 'checkpoint 2 arc behind checkpoint 1', (doc) => { doc.gates[2].arc = doc.gates[1].arc - 1; }, 4);
  reject(pathLayout(), 'path-gate-line', 'gate line parallel to the path tangent', (doc) => {
    doc.gates[1].a = [0, 0]; doc.gates[1].b = [1, 0]; doc.gates[1].tangent = { tx: 1, tz: 0 };
  }, 3);
  cases.push({
    id: 'layout.sprint.path-sample-null', group: 'sprint-layout', input: 'sprint.json', stage: 'validateSprintLayout',
    description: 'null ground height in a measured sample is accepted: validateSprintLayout never inspects course samples',
    expected: 'reject', impact: 4,
    evidence: 'sprint-layout.js:1672-1825 reads samples only to test Array.isArray(course.samples); map-package.js:116-126 has the sample loop',
    run: () => rejectOnErrors(validateSprintLayout(mutate(pathLayout(), (doc) => { doc.course.samples[3].groundY = null; })), 'validateSprintLayout')
  });
  cases.push({
    id: 'layout.sprint.path-sample-order', group: 'sprint-layout', input: 'sprint.json', stage: 'validateSprintLayout',
    description: 'non-monotonic sample arcs are accepted: the arc order is never checked on the River path',
    expected: 'reject', impact: 4,
    evidence: 'same as path-sample-null',
    run: () => rejectOnErrors(validateSprintLayout(mutate(pathLayout(), (doc) => { doc.course.samples[3].arc = -1; })), 'validateSprintLayout')
  });
  reject(pathLayout(), 'path-span-finish', 'gate arcs do not match the measured span', (doc) => { doc.gates[3].arc -= 1; }, 4);

  // The River sprint does not route through checkLayoutShape, so the band and
  // countdown declared by the layout are never validated here.
  cases.push({
    id: 'layout.sprint.band-unchecked', group: 'sprint-layout', input: 'sprint-short.json', stage: 'validateSprintLayout',
    description: 'band 7 m instead of the declared 6 m is accepted: River layouts never validate band half-width',
    expected: 'reject', impact: 3,
    evidence: 'sprint-layout.js:1672-1825 has no band check; map-package.js:127 checks only map layouts',
    run: () => rejectOnErrors(validateSprintLayout(mutate(short, (doc) => { doc.course.band.halfWidthMetres = 7; })), 'validateSprintLayout')
  });
  cases.push({
    id: 'layout.sprint.countdown-unchecked', group: 'sprint-layout', input: 'sprint-short.json', stage: 'validateSprintLayout',
    description: 'countdown 999 ticks is accepted: the page starts the timer from an unvalidated countdown',
    expected: 'reject', impact: 4,
    evidence: 'sprint-layout.js:1672-1825 has no countdown check',
    run: () => rejectOnErrors(validateSprintLayout(mutate(short, (doc) => { doc.countdown.ticks = 999; })), 'validateSprintLayout')
  });
  cases.push({
    id: 'layout.sprint.respawn-unchecked', group: 'sprint-layout', input: 'sprint-short.json', stage: 'validateSprintLayout',
    description: 'respawn rule removed is accepted; createSprintRules later assumes it exists',
    expected: 'reject', impact: 3,
    evidence: 'sprint-layout.js:1672-1825 never checks layout.rules',
    run: () => rejectOnErrors(validateSprintLayout(mutate(short, (doc) => { delete doc.rules.respawn; })), 'validateSprintLayout')
  });
  cases.push({
    id: 'layout.sprint.extra-field', group: 'sprint-layout', input: 'sprint-short.json', stage: 'validateSprintLayout',
    description: 'unknown layout field', expected: 'accept', impact: 1,
    run: () => rejectOnErrors(validateSprintLayout(mutate(short, (doc) => { doc.future = 1; })), 'validateSprintLayout')
  });
  cases.push({
    id: 'layout.sprint.coherent-unpinned-edit', group: 'sprint-layout', input: 'sprint-short.json', stage: 'validateSprintLayout',
    description: 'a coherently re-hashed layout that moves the finish 5 m earlier is accepted: the page checks the self hash, not a registry pin',
    expected: 'reject', impact: 4,
    evidence: 'app.js:2468 calls validateSprintLayout only; sprint-layout.js:1677-1682 verifies the self hash; map-registry.js:34 river bestKey has no layout pin',
    run: () => {
      const next = mutate(short, (doc) => {
        doc.gates[3].x -= 5;
        doc.course.span.finishX -= 5;
      });
      return rejectOnErrors(validateSprintLayout(next), 'validateSprintLayout');
    }
  });
  return cases;
}

// ------------------------------------------------------------------- map package
function mapPackageCases() {
  const { map, layout, pins } = syntheticMapFixture();
  const cases = [];
  const pair = (fn) => {
    const nextMap = clone(map);
    const nextLayout = clone(layout);
    fn(nextMap, nextLayout, pins);
    return [nextMap, nextLayout, pins];
  };
  const reject = (id, description, fn, impact = 4) => cases.push({
    id: 'map.package.' + id, group: 'map-package', input: 'map.json + layout.json', stage: 'validateMapPackage',
    description, expected: 'reject', impact,
    run: () => rejectOnErrors(validateMapPackage(...pair(fn)), 'validateMapPackage')
  });
  cases.push({
    id: 'map.package.valid', group: 'map-package', input: 'map.json + layout.json', stage: 'validateMapPackage',
    description: 'synthetic map and layout against synthetic pins', expected: 'accept', impact: 0,
    run: () => rejectOnErrors(validateMapPackage(map, layout, pins), 'validateMapPackage')
  });
  reject('map-kind', 'map kind wrong', (m) => { m.kind = 'x'; }, 4);
  reject('layout-kind', 'layout kind wrong', (m, l) => { l.kind = 'x'; }, 4);
  reject('map-hash', 'map content hash differs from the pin', (m) => { m.hash = 'sha256:' + '0'.repeat(64); }, 5);
  reject('layout-hash-pin', 'layout hash differs from the pin', (m, l) => { l.hash = 'sha256:' + '0'.repeat(64); }, 5);
  reject('render-source', 'render source hash differs from the pin', (m) => { m.source.render.sha256 = 'sha256:' + '0'.repeat(64); }, 4);
  reject('slice-source', 'slice source hash differs from the pin', (m) => { m.source.slice.sha256 = 'sha256:' + '0'.repeat(64); }, 4);
  reject('physics-bytes', 'physics byte count differs from the pin', (m) => { m.source.physics.bytes = 11; }, 4);
  reject('draw-count', 'draw list length differs from the pin', (m) => { m.mapRender.draws = []; m.counts.draws = 0; }, 4);
  reject('draw-range', 'draw index range exceeds the merged index count', (m) => {
    m.mapRender.draws[0].indexOffset = 3; m.mapRender.draws[0].indexCount = 3;
  }, 4);
  reject('draw-texture', 'draw names an unknown texture', (m) => { m.mapRender.draws[0].textureId = 'nope'; }, 3);
  reject('texture-bytes', 'texture RGBA length differs from its size', (m) => { m.mapRender.textures[0].rgbaBytes = 8; }, 3);
  reject('texture-empty', 'texture has no base64 payload', (m) => { m.mapRender.textures[0].rgbaBase64 = ''; }, 3);
  reject('instances', 'instances declare applied:true (unsupported)', (m) => { m.mapRender.instances.applied = true; }, 3);
  reject('normals', 'derivative-normal fallback missing', (m) => { m.mapRender.normals.fallback = 'none'; }, 3);
  reject('mesh-uv', 'merged mesh has no UV stream', (m) => { delete m.meshes[0].uv; }, 4);
  reject('layout-gates', 'layout gate order is not start..finish', (m, l) => {
    l.gates[1].kind = 'finish';
  }, 4);
  reject('layout-gate-null', 'layout gate x is null', (m, l) => { l.gates[1].x = null; }, 4);
  reject('layout-sample-null', 'layout sample is not finite', (m, l) => { l.course.samples[0].x = null; }, 4);
  reject('layout-hash-content', 'layout self hash does not match its content', (m, l) => { l.gates[1].id = 'edited'; }, 4);
  cases.push({
    id: 'map.package.extra-field', group: 'map-package', input: 'map.json + layout.json', stage: 'validateMapPackage',
    description: 'unknown map field', expected: 'accept', impact: 1,
    run: () => rejectOnErrors(validateMapPackage(...pair((m) => { m.future = 1; })), 'validateMapPackage')
  });
  cases.push({
    id: 'map.package.missing-spawn-app', group: 'map-package', input: 'map.json + layout.json',
    stage: 'page-contract (app.js spawn read)', description:
      'validateMapPackage accepts a layout without course.spawn; app.js then dereferences mapLayout.course.spawn.x and throws a TypeError',
    expected: 'reject', impact: 5,
    evidence: 'app.js:2376-2381',
    run: () => {
      const [nextMap, nextLayout] = pair((m, l) => { delete l.course.spawn; });
      rejectOnErrors(validateMapPackage(nextMap, nextLayout, pins), 'validateMapPackage');
      const spawn = {
        x: nextLayout.course.spawn.x,
        z: nextLayout.course.spawn.z,
        heading: nextLayout.course.spawn.headingRad
      };
      return spawn;
    }
  });
  cases.push({
    id: 'map.package.mesh-positions-absent', group: 'map-package', input: 'map.json + layout.json',
    stage: 'page-contract (consumer mesh upload)', description:
      'validateMapPackage never checks mesh positions; the consumer then fails with an untyped position-count error',
    expected: 'reject', impact: 4,
    evidence: 'packet-consumer.js:764',
    run: () => {
      const nextMap = clone(map);
      delete nextMap.meshes[0].positions;
      rejectOnErrors(validateMapPackage(nextMap, layout, pins), 'validateMapPackage');
      if (nextMap.meshes[0].positions.length !== nextMap.meshes[0].vertexCount * 3) {
        throw new Error('mesh ' + nextMap.meshes[0].id + ' position count mismatch');
      }
    }
  });
  return cases;
}

// ------------------------------------------------------------------------ ghosts
function ghostCases() {
  const cases = [];
  const base = validGhostRecord();
  const check = (record) => rejectOnErrors(validateGhostRecord(record), 'validateGhostRecord');
  const reject = (id, description, fn, impact = 4) => cases.push({
    id: 'ghost.' + id, group: 'ghost', input: 'ghost JSON', stage: 'validateGhostRecord',
    description, expected: 'reject', impact, run: () => check(fn(base))
  });
  cases.push({
    id: 'ghost.valid', group: 'ghost', input: 'ghosts/<slug>-310m.json', stage: 'validateGhostRecord',
    description: 'committed reference ghost', expected: 'accept', impact: 0, run: () => check(base)
  });
  cases.push({
    id: 'ghost.empty', group: 'ghost', input: 'ghost JSON', stage: 'validateGhostRecord',
    description: 'empty object', expected: 'reject', impact: 3, run: () => check({})
  });
  reject('hash-mismatch', 'one sample byte changed without recomputing the hash', (record) => {
    const next = clone(record);
    next.sample.data = next.sample.data.slice(0, -2) + (next.sample.data.endsWith('A=') ? 'B=' : 'A=');
    return next;
  }, 4);
  reject('tick-count', 'tickCount 1', (record) => { const n = clone(record); n.tickCount = 1; n.hash = ghostHash(n); return n; }, 3);
  reject('finish-tick', 'finishTick is not tickCount-1', (record) => { const n = clone(record); n.finishTick -= 1; n.hash = ghostHash(n); return n; }, 3);
  reject('time-zero', 'timeSeconds 0', (record) => { const n = clone(record); n.timeSeconds = 0; n.hash = ghostHash(n); return n; }, 3);
  reject('tick-hz', 'tickHz 30', (record) => { const n = clone(record); n.tickHz = 30; n.hash = ghostHash(n); return n; }, 3);
  reject('course', 'course "lap"', (record) => { const n = clone(record); n.course = 'lap'; n.hash = ghostHash(n); return n; }, 4);
  reject('car', 'missing car slug', (record) => { const n = clone(record); n.car = ''; n.hash = ghostHash(n); return n; }, 3);
  reject('sample-bytes', 'sample data one byte short', (record) => {
    const n = clone(record);
    const bytes = Buffer.from(n.sample.data, 'base64');
    n.sample.data = bytes.subarray(0, bytes.length - 1).toString('base64');
    n.hash = ghostHash(n);
    return n;
  }, 3);
  reject('sample-encoding', 'sample encoding is not float32le-base64', (record) => {
    const n = clone(record); n.sample.encoding = 'float64le-base64'; n.hash = ghostHash(n); return n;
  }, 3);
  reject('hash-missing', 'hash removed', (record) => { const n = clone(record); delete n.hash; return n; }, 3);
  cases.push({
    id: 'ghost.base64-non-alphabet', group: 'ghost', input: 'ghost JSON', stage: 'validateGhostRecord',
    description: 'non-base64 character in sample data: the decoder throws instead of returning an error list',
    expected: 'reject', impact: 3,
    run: () => { const n = clone(base); n.sample.data = '!!!!' + n.sample.data.slice(4); n.hash = ghostHash(n); return check(n); }
  });
  cases.push({
    id: 'ghost.base64-length', group: 'ghost', input: 'ghost JSON', stage: 'validateGhostRecord',
    description: 'sample data length is not a multiple of 4', expected: 'reject', impact: 3,
    run: () => { const n = clone(base); n.sample.data = n.sample.data.slice(0, -1); return check(n); }
  });
  cases.push({
    id: 'ghost.nan-sample', group: 'ghost', input: 'ghost JSON', stage: 'validateGhostRecord',
    description: 'a NaN sample with a recomputed hash is accepted by the store; the consumer later rejects it as non-rigid',
    expected: 'reject', impact: 4,
    evidence: 'ghost-replay.js:246-278 checks length/hash but not finite floats; packet-consumer.js:1261 isRigid',
    run: () => {
      const n = withGhostFloats(base, (floats) => { floats[0] = NaN; });
      check(n);
      const matrix = matrixFromQuaternion([n.sample.data ? 0 : 0, 0, 0, 1], [NaN, 0, 0]);
      if (isRigid(matrix)) throw new Error('test setup: NaN matrix stayed rigid');
    }
  });
  cases.push({
    id: 'ghost.zero-quaternion', group: 'ghost', input: 'ghost JSON', stage: 'validateGhostRecord',
    description: 'a zero quaternion is accepted and produces a plausible identity rotation instead of being rejected',
    expected: 'reject', impact: 3,
    evidence: 'ghost-replay.js:266-277; matrixFromQuaternion normalises no quaternion (ghost-replay.js:131-143)',
    run: () => {
      const n = withGhostFloats(base, (floats) => { floats[3] = 0; floats[4] = 0; floats[5] = 0; floats[6] = 0; });
      check(n);
      const matrix = matrixFromQuaternion([0, 0, 0, 0], [0, 0, 0]);
      if (!isRigid(matrix)) throw new Error('test setup: zero quaternion did not stay rigid');
    }
  });
  cases.push({
    id: 'ghost.time-huge', group: 'ghost', input: 'ghost JSON', stage: 'validateGhostRecord',
    description: 'timeSeconds 1e308 is finite and positive, so it is accepted', expected: 'reject', impact: 2,
    run: () => { const n = clone(base); n.timeSeconds = 1e308; n.hash = ghostHash(n); return check(n); }
  });
  cases.push({
    id: 'ghost.extra-field', group: 'ghost', input: 'ghost JSON', stage: 'validateGhostRecord',
    description: 'unknown ghost field', expected: 'accept', impact: 1,
    run: () => { const n = clone(base); n.future = 1; n.hash = ghostHash(n); return check(n); }
  });
  cases.push({
    id: 'ghost.decode-nan', group: 'ghost', input: 'ghost JSON', stage: 'decodeGhost + ghostMatrices',
    description: 'decodeGhost accepts a NaN sample (validate passes) and ghostPoseAt returns NaN position',
    expected: 'reject', impact: 4,
    evidence: 'ghost-replay.js:280-289',
    run: () => {
      const n = withGhostFloats(base, (floats) => { floats[0] = NaN; });
      const decoded = decodeGhost(n);
      if (!Number.isNaN(decoded.values[0])) throw new Error('test setup: NaN lost');
    }
  });
  return cases;
}

// -------------------------------------------------------------- localStorage best
function bestTimeCases() {
  const key = 'e1-drive.sprint.best.v2.310m';
  const cases = [];
  cases.push({
    id: 'storage.best.valid', group: 'storage-best', input: 'localStorage', stage: 'createBestTimes',
    description: 'a stored best time is read back', expected: 'accept', impact: 0,
    run: () => {
      const storage = fakeStorage({ [key]: JSON.stringify({ kind: 'e1-drive.sprint-best', version: 1, cars: { [SLUG]: { seconds: 14.65 } } }) });
      if (createBestTimes(storage, key).bestFor(SLUG) !== 14.65) throw new Error('best time was not read');
    }
  });
  cases.push({
    id: 'storage.best.malformed-json', group: 'storage-best', input: 'localStorage', stage: 'createBestTimes',
    description: 'truncated JSON degrades to no best time (documented)', expected: 'accept', impact: 1,
    run: () => { if (createBestTimes(fakeStorage({ [key]: '{oops' }), key).bestFor(SLUG) !== null) throw new Error('bad'); }
  });
  cases.push({
    id: 'storage.best.wrong-kind', group: 'storage-best', input: 'localStorage', stage: 'createBestTimes',
    description: 'wrong kind degrades to no best time', expected: 'accept', impact: 1,
    run: () => { createBestTimes(fakeStorage({ [key]: JSON.stringify({ kind: 'x', version: 1, cars: {} }) }), key).read(); }
  });
  cases.push({
    id: 'storage.best.seconds-string', group: 'storage-best', input: 'localStorage', stage: 'createBestTimes',
    description: 'a string seconds value is dropped instead of being coerced', expected: 'accept', impact: 1,
    run: () => {
      const storage = fakeStorage({ [key]: JSON.stringify({ kind: 'e1-drive.sprint-best', version: 1, cars: { [SLUG]: { seconds: '14.0' } } }) });
      if (createBestTimes(storage, key).bestFor(SLUG) !== null) throw new Error('string was accepted');
    }
  });
  cases.push({
    id: 'storage.best.huge-seconds', group: 'storage-best', input: 'localStorage', stage: 'createBestTimes',
    description: 'seconds 1e308 is accepted and displayed as the best time', expected: 'reject', impact: 1,
    run: () => {
      const storage = fakeStorage({ [key]: JSON.stringify({ kind: 'e1-drive.sprint-best', version: 1, cars: { [SLUG]: { seconds: 1e308 } } }) });
      if (createBestTimes(storage, key).bestFor(SLUG) !== 1e308) throw new Error('test setup');
    }
  });
  cases.push({
    id: 'storage.best.submit-nan', group: 'storage-best', input: 'localStorage', stage: 'createBestTimes.submit',
    description: 'submitting NaN seconds is rejected', expected: 'reject', impact: 2,
    run: () => { createBestTimes(fakeStorage(), key).submit(SLUG, { seconds: NaN }); }
  });
  cases.push({
    id: 'storage.best.quota', group: 'storage-best', input: 'localStorage', stage: 'createBestTimes',
    description: 'a setItem quota error disables persistence instead of breaking the drive loop', expected: 'accept', impact: 1,
    run: () => {
      const store = createBestTimes(throwingStorage('QuotaExceededError'), key);
      if (store.bestFor(SLUG) !== null) throw new Error('bad');
      store.submit(SLUG, { seconds: 12 });
    }
  });
  return cases;
}

// -------------------------------------------------------------- localStorage ghost
function ghostStoreCases() {
  const key = GHOST_KEY_PREFIX + '310m';
  const record = validGhostRecord();
  const store = (raw) => ({ getItem: () => raw, setItem: () => {} });
  const cases = [];
  cases.push({
    id: 'storage.ghost.valid', group: 'storage-ghost', input: 'localStorage', stage: 'createGhostStore',
    description: 'a valid stored record is returned', expected: 'accept', impact: 0,
    run: () => {
      const raw = JSON.stringify({ kind: 'e1-drive.sprint-ghost-store', version: 1, course: '310m', cars: { [SLUG]: record } });
      if (!createGhostStore(store(raw), '310m').get(SLUG)) throw new Error('record not returned');
    }
  });
  cases.push({
    id: 'storage.ghost.malformed-json', group: 'storage-ghost', input: 'localStorage', stage: 'createGhostStore',
    description: 'truncated JSON degrades to an empty store and records lastError', expected: 'accept', impact: 1,
    run: () => {
      const ghostStore = createGhostStore(store('{"kind":'), '310m');
      if (ghostStore.get(SLUG) !== null || !ghostStore.lastError) throw new Error('bad');
    }
  });
  cases.push({
    id: 'storage.ghost.wrong-course', group: 'storage-ghost', input: 'localStorage', stage: 'createGhostStore',
    description: 'a store for another course is dropped', expected: 'accept', impact: 1,
    run: () => {
      const raw = JSON.stringify({ kind: 'e1-drive.sprint-ghost-store', version: 1, course: 'short', cars: { [SLUG]: record } });
      if (createGhostStore(store(raw), '310m').get(SLUG) !== null) throw new Error('wrong-course record accepted');
    }
  });
  cases.push({
    id: 'storage.ghost.bad-hash', group: 'storage-ghost', input: 'localStorage', stage: 'createGhostStore',
    description: 'a record whose hash does not recompute is dropped', expected: 'accept', impact: 1,
    run: () => {
      const bad = clone(record); bad.timeSeconds += 1;
      const raw = JSON.stringify({ kind: 'e1-drive.sprint-ghost-store', version: 1, course: '310m', cars: { [SLUG]: bad } });
      if (createGhostStore(store(raw), '310m').get(SLUG) !== null) throw new Error('bad hash accepted');
    }
  });
  cases.push({
    id: 'storage.ghost.submit-wrong-car', group: 'storage-ghost', input: 'localStorage', stage: 'createGhostStore.submit',
    description: 'submitting a record under another slug is rejected', expected: 'reject', impact: 2,
    run: () => { createGhostStore(fakeStorage(), '310m').submit('other-car', record); }
  });
  cases.push({
    id: 'storage.ghost.submit-layout-mismatch', group: 'storage-ghost', input: 'localStorage', stage: 'createGhostStore.submit',
    description: 'submitting a ghost from another layout is rejected', expected: 'reject', impact: 3,
    run: () => { createGhostStore(fakeStorage(), '310m', { layoutHash: 'sha256:' + '0'.repeat(64) }).submit(SLUG, record); }
  });
  cases.push({
    id: 'storage.ghost.huge-tickcount', group: 'storage-ghost', input: 'localStorage', stage: 'validateGhostRecord',
    description: 'tickCount 1e9 with no matching bytes is rejected before allocation', expected: 'reject', impact: 3,
    run: () => {
      const bad = clone(record); bad.tickCount = 1e9; bad.hash = ghostHash(bad);
      rejectOnErrors(validateGhostRecord(bad), 'validateGhostRecord');
    }
  });
  return cases;
}

// -------------------------------------------------------------------- roster/cars
function rosterCases() {
  const doc = rosterFixture();
  const cases = [];
  cases.push({
    id: 'roster.valid', group: 'roster', input: 'cars.json', stage: 'loadRoster',
    description: 'synthetic PASS roster', expected: 'accept', impact: 0,
    run: () => loadRoster(fakeFetch(doc))
  });
  cases.push({
    id: 'roster.http-500', group: 'roster', input: 'cars.json', stage: 'loadRoster',
    description: 'roster fetch HTTP 500', expected: 'reject', impact: 3,
    run: () => loadRoster(fakeFetch(doc, { status: 500 }))
  });
  cases.push({
    id: 'roster.not-json', group: 'roster', input: 'cars.json', stage: 'loadRoster',
    description: 'roster body is truncated JSON', expected: 'reject', impact: 3,
    run: () => loadRoster(fakeFetch('{"kind":'))
  });
  cases.push({
    id: 'roster.kind', group: 'roster', input: 'cars.json', stage: 'loadRoster',
    description: 'wrong roster kind', expected: 'reject', impact: 3,
    run: () => loadRoster(fakeFetch({ ...doc, kind: 'x' }))
  });
  cases.push({
    id: 'roster.status-fail', group: 'roster', input: 'cars.json', stage: 'loadRoster',
    description: 'roster gate status FAIL', expected: 'reject', impact: 4,
    run: () => loadRoster(fakeFetch({ ...doc, status: 'FAIL', failures: ['mass <= 0'] }))
  });
  cases.push({
    id: 'roster.cars-not-array', group: 'roster', input: 'cars.json', stage: 'loadRoster',
    description: 'roster.cars is not an array', expected: 'reject', impact: 3,
    run: () => loadRoster(fakeFetch({ ...doc, roster: { cars: {} } }))
  });
  cases.push({
    id: 'roster.duplicate-slug', group: 'roster', input: 'cars.json', stage: 'loadRoster + resolveCar',
    description: 'two cars with the same slug: resolveCar silently takes the first', expected: 'reject', impact: 2,
    run: () => {
      const second = { ...doc.roster.cars[0], fields: { ...doc.roster.cars[0].fields, sha256: sha('other') } };
      const roster = { ...doc, roster: { ...doc.roster, cars: [doc.roster.cars[0], second] } };
      const car = resolveCar(roster, SLUG);
      if (car.fields.sha256 !== doc.roster.cars[0].fields.sha256) throw new Error('unexpected pick');
    }
  });
  cases.push({
    id: 'roster.default-missing', group: 'roster', input: 'cars.json', stage: 'loadRoster + resolveCar',
    description: 'roster default is not covered by the cars list; rejected only when the car is resolved', expected: 'reject', impact: 3,
    run: () => {
      const roster = { ...doc, roster: { ...doc.roster, default: 'missing' } };
      const car = resolveCar(roster, null);
      if (!car) throw new Error('unreachable');
    }
  });
  cases.push({
    id: 'roster.fields-hash-unchecked', group: 'roster', input: 'cars/<slug>.fields', stage: 'page-contract (fields load)',
    description: 'the page never compares the fetched fields bytes with the roster fields.sha256 / bytes; a stale car silently drives',
    expected: 'reject', impact: 5,
    evidence: 'app.js:2301-2309 fetches and uses fieldBytes; cars.js:44-46 builds the URL; the roster sha is never read',
    run: () => {
      const roster = { ...doc, roster: { ...doc.roster, cars: [{ ...doc.roster.cars[0], fields: { path: '_work/e1-drive/cars/' + SLUG + '.fields', bytes: 1, sha256: sha('different') } }] } };
      const car = resolveCar(roster, SLUG);
      const url = fieldsUrl(car);
      if (!url.includes(SLUG)) throw new Error('test setup');
      // The page would feed the fetched bytes straight to e1_create.
    }
  });
  return cases;
}

// -------------------------------------------------------------- collision manifest
function propCases() {
  const base = validPropManifest();
  const cases = [];
  const check = (manifest, pins = SPRINT_PROP_PINS) => rejectOnErrors(checkPropManifest(manifest, pins), 'checkPropManifest');
  cases.push({
    id: 'props.valid', group: 'prop-manifest', input: 'colliders-v2.json', stage: 'checkPropManifest',
    description: 'committed V2 manifest against the 310 m pins', expected: 'accept', impact: 0,
    run: () => check(base)
  });
  cases.push({
    id: 'props.kind', group: 'prop-manifest', input: 'colliders-v2.json', stage: 'checkPropManifest',
    description: 'wrong manifest kind', expected: 'reject', impact: 3,
    run: () => check({ ...base, kind: 'x' })
  });
  cases.push({
    id: 'props.variant', group: 'prop-manifest', input: 'colliders-v2.json', stage: 'checkPropManifest',
    description: 'wrong manifest variant', expected: 'reject', impact: 4,
    run: () => check({ ...base, variant: 'v1' })
  });
  cases.push({
    id: 'props.collider-count', group: 'prop-manifest', input: 'colliders-v2.json', stage: 'checkPropManifest',
    description: 'one collider removed', expected: 'reject', impact: 4,
    run: () => check({ ...base, colliders: base.colliders.slice(1) })
  });
  cases.push({
    id: 'props.content-hash', group: 'prop-manifest', input: 'colliders-v2.json', stage: 'checkPropManifest',
    description: 'content hash unchanged while colliders were edited (hand-edited file)', expected: 'reject', impact: 4,
    run: () => check({ ...base, colliders: base.colliders.map((collider, index) => index === 0 ? { ...collider, active: false } : collider) })
  });
  cases.push({
    id: 'props.profile-count', group: 'prop-manifest', input: 'colliders-v2.json', stage: 'checkPropManifest',
    description: 'profile collider count differs from the pin', expected: 'reject', impact: 3,
    run: () => check({ ...base, profiles: { ...base.profiles, roadside: { ...base.profiles.roadside, colliders: 1 } } })
  });
  cases.push({
    id: 'props.extra-field', group: 'prop-manifest', input: 'colliders-v2.json', stage: 'checkPropManifest',
    description: 'unknown manifest field', expected: 'accept', impact: 1,
    run: () => check({ ...base, future: 1 })
  });
  return cases;
}

// ------------------------------------------------------------------ multiplayer
function multiplayerCases() {
  const cases = [];
  const layout = validSprintLayout();
  const room = {
    players: [
      { id: 'a', slot: 1, name: 'Host', car: SLUG, host: true, connected: true },
      { id: 'b', slot: 2, name: 'Guest', car: SLUG, host: false, connected: true }
    ]
  };
  const results = [{ playerId: 'a', tick: 500, hash: 'sha256:a' }, { playerId: 'b', tick: 600, hash: 'sha256:b' }];
  const build = (roomValue = room, resultValue = results) => buildMpResult({ layout, room: roomValue, results: resultValue });

  cases.push({
    id: 'mp.result.valid', group: 'multiplayer', input: 'room.finished', stage: 'buildMpResult',
    description: 'two-player result table', expected: 'accept', impact: 0,
    run: () => {
      const first = build();
      const second = build();
      if (first.hash !== second.hash) throw new Error('result hash is not deterministic');
    }
  });
  cases.push({
    id: 'mp.result.missing-layout', group: 'multiplayer', input: 'room.finished', stage: 'buildMpResult',
    description: 'layout missing', expected: 'reject', impact: 3,
    run: () => buildMpResult({ room, results })
  });
  cases.push({
    id: 'mp.result.empty-room', group: 'multiplayer', input: 'room.finished', stage: 'buildMpResult',
    description: 'room with no players', expected: 'reject', impact: 3,
    run: () => build({ players: [] })
  });
  cases.push({
    id: 'mp.result.results-not-array', group: 'multiplayer', input: 'room.finished', stage: 'buildMpResult',
    description: 'results is not an array', expected: 'reject', impact: 3,
    run: () => buildMpResult({ layout, room, results: {} })
  });
  cases.push({
    id: 'mp.result.duplicate-player-ids', group: 'multiplayer', input: 'room.finished', stage: 'page-contract (buildMpResult)',
    description: 'two players share one id: both rows take the same finish and the table is silently wrong',
    expected: 'reject', impact: 4,
    run: () => {
      const table = build({ players: [room.players[0], { ...room.players[1], id: 'a' }] });
      const finished = table.rows.filter((row) => row.status === 'finished');
      if (finished.length !== 2) throw new Error('the duplicate id was rejected (this is the fixed behaviour)');
    }
  });
  cases.push({
    id: 'mp.result.huge-tick', group: 'multiplayer', input: 'room.finished', stage: 'page-contract (buildMpResult)',
    description: 'a 1e12 finish tick is accepted and produces a 1.6e10 s race time', expected: 'reject', impact: 3,
    run: () => {
      const table = build(room, [{ playerId: 'a', tick: 1e12, hash: 'x' }, { playerId: 'b', tick: 600, hash: 'y' }]);
      const row = table.rows.find((entry) => entry.playerId === 'a');
      if (!(row.timeSeconds > 1e9)) throw new Error('the huge finish tick was rejected (this is the fixed behaviour)');
    }
  });
  cases.push({
    id: 'mp.result.duplicate-slots', group: 'multiplayer', input: 'room.finished', stage: 'page-contract (buildMpResult)',
    description: 'two players share slot 1: ordering is silently resolved by sort stability', expected: 'reject', impact: 2,
    run: () => {
      build({ players: [room.players[0], { ...room.players[1], slot: 1 }] });
    }
  });
  cases.push({
    id: 'mp.result.name-object', group: 'multiplayer', input: 'room.finished', stage: 'page-contract (buildMpResult)',
    description: 'a non-string player name is accepted and rendered as [object Object]', expected: 'reject', impact: 2,
    run: () => {
      const table = build({ players: [{ ...room.players[0], name: { evil: true } }, room.players[1]] });
      if (typeof table.rows[0].name === 'string') throw new Error('the non-string name was rejected (this is the fixed behaviour)');
    }
  });
  cases.push({
    id: 'mp.result.tick-nan', group: 'multiplayer', input: 'room.finished', stage: 'buildMpResult',
    description: 'a NaN finish tick becomes an explicit DNF row (documented, not guessed)', expected: 'accept', impact: 1,
    run: () => {
      const table = build(room, [{ playerId: 'a', tick: NaN, hash: 'x' }, { playerId: 'b', tick: 600, hash: 'y' }]);
      if (table.rows.find((row) => row.playerId === 'a').status !== 'dnf') throw new Error('NaN tick was not DNF');
    }
  });

  // Room code / name normalisation.
  for (const [id, value, expect] of [
    ['valid', 'ABCDE', 'accept'],
    ['too-short', 'ABCD', 'reject'],
    ['ambiguous-letters', 'ABCIO', 'reject'],
    ['lower-case', 'abcde', 'accept'],
    ['symbols', 'AB-DE', 'reject'],
    ['non-string', 12345, 'reject']
  ]) {
    cases.push({
      id: 'mp.room-code.' + id, group: 'multiplayer', input: 'room-server message', stage: 'normalizeRoomCode',
      description: 'room code ' + JSON.stringify(value), expected: expect, impact: expect === 'reject' ? 2 : 0,
      run: () => {
        const code = normalizeRoomCode(value);
        if (expect === 'reject') {
          if (code === null) {
            const error = new Error('room code rejected: ' + JSON.stringify(value));
            error.code = 'ROOM_CODE_INVALID';
            throw error;
          }
          return;
        }
        if (!code) {
          const error = new Error('valid room code rejected: ' + JSON.stringify(value));
          error.code = 'ROOM_CODE_OVER_STRICT';
          throw error;
        }
      }
    });
  }
  cases.push({
    id: 'mp.name-control-characters', group: 'multiplayer', input: 'room-server message', stage: 'normalizePlayerName',
    description: 'a 30-character HTML-shaped name is trimmed to the 24-character rule; the page renders it as textContent',
    expected: 'accept', impact: 1,
    run: () => {
      const name = normalizePlayerName('<img src=x onerror=alert(1)>');
      if (name.length > 24) throw new Error('name was not trimmed: ' + name.length);
    }
  });
  cases.push({
    id: 'mp.map-compare-record', group: 'multiplayer', input: 'room-server message', stage: 'compareMpMapRecords',
    description: 'map record hash mismatch is a typed refusal', expected: 'reject', impact: 4,
    run: () => {
      const expected = { id: 'river', packageHash: 'sha256:a', layoutHash: 'sha256:b', physicsHash: 'sha256:c' };
      assertMpMapAgreement(expected, { ...expected, physicsHash: 'sha256:d' }, 'room map');
    }
  });

  // Net protocol validators (the room server is an untrusted input too).
  for (const [id, state, expect] of [
    ['valid', validNetState(), 'accept'],
    ['nan-position', validNetState({ position: [NaN, 0, 0] }), 'reject'],
    ['zero-quaternion', validNetState({ quaternion: [0, 0, 0, 0] }), 'reject'],
    ['negative-tick', validNetState({ tick: -1 }), 'reject'],
    ['fractional-tick', validNetState({ tick: 1.5 }), 'reject'],
    ['tick-over-limit', validNetState({ tick: 100_000_001 }), 'reject'],
    ['negative-speed', validNetState({ speed: -3 }), 'accept']
  ]) {
    cases.push({
      id: 'mp.state.' + id, group: 'multiplayer', input: 'room-server message', stage: 'quantizeState',
      description: 'peer state: ' + id, expected: expect, impact: expect === 'reject' ? 3 : 0,
      run: () => {
        if (expect === 'reject') quantizeState(state);
        else quantizeState(state);
      }
    });
  }
  for (const [id, input, expect] of [
    ['valid', validNetInput(), 'accept'],
    ['out-of-range', validNetInput({ throttle: 1.1 }), 'reject'],
    ['nan', validNetInput({ steer: NaN }), 'reject'],
    ['missing-field', { throttle: 0 }, 'reject']
  ]) {
    cases.push({
      id: 'mp.input.' + id, group: 'multiplayer', input: 'room-server message', stage: 'quantizeInput',
      description: 'peer input: ' + id, expected: expect, impact: 2,
      run: () => { quantizeInput(input); }
    });
  }
  return cases;
}

// ------------------------------------------------------------ source-contract probes
// These re-read the page and cite the exact lines for gaps that have no runtime
// function to call. They are findings, not guesses: the check asserts that the
// guard is absent, and the case is `expected:'reject'` so the harness records a
// silent gap only if the guard really is absent.
export function sourceContractCases() {
  const app = readFileSync(path.join(ROOT, 'probes/e1-drive/web/app.js'), 'utf8');
  const page = readFileSync(path.join(ROOT, 'probes/e1-drive/web/index.html'), 'utf8');
  const cars = readFileSync(path.join(ROOT, 'probes/e1-drive/web/cars.js'), 'utf8');
  const registry = readFileSync(path.join(ROOT, 'probes/e1-drive/web/map-registry.js'), 'utf8');
  const cases = [];
  const sourceCase = (id, input, description, evidence, condition) => cases.push({
    id, group: 'source-contract', input, stage: 'static source contract', description,
    expected: 'reject', impact: 5, evidence,
    run: () => assert(condition(), 'the guard is present (this is the fixed behaviour)')
  });
  sourceCase('source.index-no-bootstrap-error', 'index.html',
    'index.html registers no error handler before app.js; a failed chunk/import leaves a blank page with no message',
    'index.html:107 loads app.js; app.js:1231-1232 registers window.onerror only after the module has executed',
    () => !/onerror|window\.addEventListener\(\s*['"]error['"]/.test(page));
  sourceCase('source.module-no-integrity', 'app.js / e1_drive.wasm',
    'the wasm module is dynamically imported with no hash or size pin; a truncated/mismatched module only fails inside factory()',
    'app.js:2254 await import(ENGINE_MODULE); e1_drive.wasm has no page-level pin',
    () => !/e1_drive\.wasm/.test(app) && /await import\(ENGINE_MODULE\)/.test(app));
  sourceCase('source.river-physics-unpinned', 'Level.levelphysics',
    'the River route computes the physics SHA-256 but never compares it with a pin; only map-package mode checks physics',
    'app.js:2308 physicsSha; app.js:2339-2341 the only comparison is inside if (MAP_IS_PACKAGE); map-registry.js:39 river pins:null',
    () => /if \(physicsSha !== MAP\.pins\.physicsFileSha256\)/.test(app) && /pins: null/.test(registry));
  sourceCase('source.car-fields-unpinned', 'cars/<slug>.fields',
    'the roster records fields.sha256 and fields.bytes but the page never verifies the fetched field bytes',
    'cars.js:44-46; app.js:2301-2302,2307-2309; roster entries in _work/e1-drive/cars.json carry fields.sha256',
    () => !/fields\.sha256/.test(app) && !/fields\.sha256/.test(cars));
  sourceCase('source.spawn-json-unvalidated', 'spawn.json',
    'spawn.json is parsed and used without a finite/schema check (x, z, heading)',
    'app.js:2416 JSON.parse(spawnText) then layoutStartPosition(layout, spawn) at 2576',
    () => !/spawn\.x.*Number\.isFinite|Number\.isFinite\(spawn/.test(app));
  sourceCase('source.packet-not-validated-live', 'live packet',
    'the page never runs validatePacket on the live timeline; only consumer structural checks run',
    'app.js has no import of packet-format.mjs; packet-consumer.js:749-752 checks kind/version/convention',
    () => !/validatePacket/.test(app));
  return cases;
}

export function buildCases() {
  allCases.length = 0;
  add(chunkIndexCases());
  add(levelChunkCases());
  add(baseChunkCases());
  add(carChunkCases());
  add(chunkByteCases());
  add(packetCases());
  add(stateCases());
  add(sprintLayoutCases());
  add(mapPackageCases());
  add(ghostCases());
  add(bestTimeCases());
  add(ghostStoreCases());
  add(rosterCases());
  add(propCases());
  add(multiplayerCases());
  return allCases;
}

export { allCases };
