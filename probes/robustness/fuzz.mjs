// Deterministic seeded fuzzer over the browser input schemas.
//
// 2,000+ cases, no wall clock, no Math.random: every case is a function of its
// seed, so a reported seed reproduces the same document and the same outcome.
//
// The fuzzer distinguishes:
//   rejected-typed    the contract produced a typed rejection
//   rejected-untyped  loud but untyped (no code/location)
//   crash             TypeError/SyntaxError/... escaped the contract
//   silent-accepted   a mutation that must be invalid was accepted
//   accepted-benign   a benign mutation (unknown field) was accepted
//   over-strict       a benign mutation was rejected

import { parseBaseChunk, parseCarChunk, parseChunkIndex, parseLevelChunk
} from '../e1-drive/web/geometry-chunks.js';
import { validateSprintLayout } from '../e1-drive/web/sprint-layout.js';
import { validateMapPackage } from '../e1-drive/web/map-package.js';
import { ghostHash, validateGhostRecord } from '../e1-drive/web/ghost-replay.js';
import { packetHash, validatePacket } from '../render-packet/tools/packet-format.mjs';
import { hashOf } from '../e1-drive/web/packet-hash.js';

import {
  REAL_PATHS, SLUG, readCommittedJson, validBaseDoc, validCarDoc, validIndexDoc, validLevelDoc, validPacket
} from './lib/fixtures.mjs';

export const CONFIG = Object.freeze({
  caseCount: 2048,
  baseSeed: 0x5eed1a7e,
  replicaCheckStride: 61
});

/** Deterministic 32-bit PRNG (mulberry32). */
export function prng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const clone = (value) => structuredClone(value);
const json = (value) => JSON.stringify(value);

function rehash(doc) {
  const body = { ...doc };
  delete body.hash;
  doc.hash = hashOf(body);
  return doc;
}

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
    id: kind + '.' + index, kind, index, arc, x: arc, z: 0, headingRad: 0,
    a: [arc, -1], b: [arc, 1], tangent: { tx: 1, tz: 0 }, coverage: { covered: true }
  });
  const layout = {
    kind: 'e1-drive.sprint', version: 1, hash: null, courseId: 'synthetic',
    course: {
      sampleCount: 3,
      samples: [{ x: 0, z: 0, groundY: 0, arc: 0 }, { x: 1, z: 0, groundY: 0, arc: 1 }, { x: 2, z: 0, groundY: 0, arc: 2 }],
      lengthMetres: 2, finishArc: 2, spawn: { x: 0, z: 0, headingRad: 0 }, band: { halfWidthMetres: 6 }
    },
    gates: [gate(0, 'start', 0), gate(1, 'checkpoint', 1), gate(2, 'checkpoint', 1.5), gate(3, 'finish', 2)],
    countdown: { ticks: 90 },
    rules: { respawn: { fallBelowGroundMetres: 1 } },
    source: { render: { contentHash: renderContentHash }, physics: { sha256: physicsSha } }
  };
  rehash(layout);
  const pins = {
    mapContentHash: map.hash, layoutContentHash: layout.hash,
    renderFileSha256: map.source.render.sha256, renderContentHash,
    sliceFileSha256: map.source.slice.sha256, sliceContentHash: map.source.slice.contentHash,
    physicsFileSha256: physicsSha, physicsBytes: 10,
    renderLabel: 'synthetic-direct-draws', draws: 1, drawTriangles: 1, textures: 1, textureBytes: 4,
    vertices: 1, indices: 3, blockedDraws: 0, decalDraws: 0, diagnosticDraws: 0, collisionTriangles: 0,
    instanceDescriptions: 0, unsupportedSections: 0,
    courseId: 'synthetic', sampleCount: 3, pathLengthMetres: 2, checkpointArcs: [1, 1.5]
  };
  return { map, layout, pins };
}

const INVALID = (target, name, apply, group = name) => ({ target, name, group, benign: false, apply });
const BENIGN = (target, name, apply, group = name) => ({ target, name, group, benign: true, apply });

/**
 * Schema table. Each mutator receives (docs) and mutates in place; `docs` holds
 * the cloned base document(s). `target` says which one.
 */
function schemas() {
  const ghost = readCommittedJson(REAL_PATHS.ghost);
  const shortLayout = readCommittedJson(REAL_PATHS.sprintShort);
  const map = syntheticMapFixture();
  return [
    {
      name: 'packet',
      build: () => ({ packet: validPacket() }),
      run: ({ packet }) => {
        const result = validatePacket(packet);
        if (!result.ok) {
          const error = new Error(result.errors.join('; '));
          error.code = 'PACKET_SCHEMA';
          error.errors = result.errors;
          throw error;
        }
      },
      mutators: [
        INVALID('packet', 'kind', (d) => { d.packet.kind = 'x'; }),
        INVALID('packet', 'version', (d) => { d.packet.version = 2; }),
        INVALID('packet', 'delete-camera', (d) => { delete d.packet.camera; }),
        INVALID('packet', 'camera-near-far', (d) => { if (d.packet.camera) { d.packet.camera.near = 9; d.packet.camera.far = 1; } }),
        INVALID('packet', 'alpha-nan', (d) => { if (d.packet.updates?.[1]) d.packet.updates[1].alpha = NaN; }),
        INVALID('packet', 'duplicate-mesh', (d) => { if (d.packet.meshes?.[1]) d.packet.meshes[1].id = d.packet.meshes[0].id; }),
        INVALID('packet', 'duplicate-draw', (d) => { if (d.packet.draws?.[1]) d.packet.draws[1].id = d.packet.draws[0].id; }),
        INVALID('packet', 'index-oor', (d) => { if (d.packet.meshes?.[0]?.indices) d.packet.meshes[0].indices[0] = 999; }),
        INVALID('packet', 'index-u32-wrap', (d) => { if (d.packet.meshes?.[0]?.indices) d.packet.meshes[0].indices[0] = 4294967296; }),
        INVALID('packet', 'position-nan', (d) => { if (d.packet.meshes?.[0]?.positions) d.packet.meshes[0].positions[0] = NaN; }),
        INVALID('packet', 'tick-duplicate', (d) => { if (d.packet.updates?.[2]) d.packet.updates[2].tick = d.packet.updates[1].tick; }),
        INVALID('packet', 'matrix-shear', (d) => { if (d.packet.draws?.[0]?.world) d.packet.draws[0].world[1] = 0.25; }),
        INVALID('packet', 'mesh-storage', (d) => { if (d.packet.meshes?.[0]) d.packet.meshes[0].storage = 'binary'; }),
        BENIGN('packet', 'extra-field', (d) => { d.packet.future = { note: 'ignored' }; }),
        BENIGN('packet', 'extra-draw-field', (d) => { if (d.packet.draws?.[0]) d.packet.draws[0].future = 1; })
      ]
    },
    {
      name: 'chunk-index',
      build: () => ({ index: validIndexDoc() }),
      run: ({ index }) => parseChunkIndex(json(index)),
      mutators: [
        INVALID('index', 'kind', (d) => { d.index.kind = 'x'; }),
        INVALID('index', 'version', (d) => { d.index.version = 2; }),
        INVALID('index', 'geometry-version', (d) => { d.index.geometryVersion = 5; }),
        INVALID('index', 'delete-level', (d) => { delete d.index.level; }),
        INVALID('index', 'delete-base', (d) => { delete d.index.base; }),
        INVALID('index', 'level-sha', (d) => { if (d.index.level) d.index.level.sha256 = 'sha256:zz'; }),
        INVALID('index', 'default-car', (d) => { d.index.defaultCar = 'missing'; }),
        INVALID('index', 'car-sha', (d) => { if (d.index.cars?.[SLUG]) delete d.index.cars[SLUG].sha256; }),
        INVALID('index', 'fallback', (d) => { if (d.index.cars?.[SLUG]) d.index.cars[SLUG].fallback = true; }),
        BENIGN('index', 'extra-field', (d) => { d.index.policy.future = 1; })
      ]
    },
    {
      name: 'level-chunk',
      build: () => ({ level: validLevelDoc() }),
      run: ({ level }) => parseLevelChunk(json(level)),
      mutators: [
        INVALID('level', 'kind', (d) => { d.level.kind = 'x'; }),
        INVALID('level', 'version', (d) => { d.level.version = 5; }),
        INVALID('level', 'chunk-header', (d) => { delete d.level.chunk; }),
        INVALID('level', 'car-bodies', (d) => { d.level.carBodies = { x: {} }; }),
        INVALID('level', 'meshes-1', (d) => { if (Array.isArray(d.level.meshes)) d.level.meshes = d.level.meshes.slice(0, 1); }, 'mesh-count'),
        INVALID('level', 'meshes-3', (d) => { if (d.level.meshes?.[0]) d.level.meshes.push(d.level.meshes[0]); }, 'mesh-count'),
        INVALID('level', 'null-positions', (d) => { if (d.level.meshes?.[0]) d.level.meshes[0].positions = null; }),
        INVALID('level', 'negative-index-count', (d) => { if (d.level.meshes?.[0]) d.level.meshes[0].indexCount = -3; }),
        BENIGN('level', 'extra-field', (d) => { d.level.future = 1; })
      ]
    },
    {
      name: 'base-chunk',
      build: () => ({ base: validBaseDoc() }),
      run: ({ base }) => parseBaseChunk(json(base)),
      mutators: [
        INVALID('base', 'kind', (d) => { d.base.kind = 'x'; }),
        INVALID('base', 'version', (d) => { d.base.version = 5; }),
        INVALID('base', 'chunk-header', (d) => { if (d.base.chunk) d.base.chunk.kind = 'level'; }),
        INVALID('base', 'car-bodies', (d) => { if (d.base.carBodies) d.base.carBodies[SLUG] = {}; }),
        BENIGN('base', 'extra-field', (d) => { d.base.future = 1; })
      ]
    },
    {
      name: 'car-chunk',
      build: () => ({ car: validCarDoc(), index: validIndexDoc() }),
      run: ({ car, index }) => parseCarChunk(json(car), index, SLUG),
      mutators: [
        INVALID('car', 'kind', (d) => { d.car.kind = 'x'; }),
        INVALID('car', 'version', (d) => { d.car.version = 2; }),
        INVALID('car', 'geometry-version', (d) => { d.car.geometryVersion = 5; }),
        INVALID('car', 'slug', (d) => { d.car.slug = 'other'; }),
        INVALID('car', 'chunk-slug', (d) => { if (d.car.chunk) d.car.chunk.slug = 'other'; }),
        INVALID('car', 'draws', (d) => { delete d.car.carDraws; }),
        INVALID('car', 'wheel-groups', (d) => { if (Array.isArray(d.car.wheelGroups)) d.car.wheelGroups = d.car.wheelGroups.slice(0, 3); }),
        INVALID('car', 'mesh-id', (d) => { if (d.car.mesh) d.car.mesh.id = 'other'; }),
        INVALID('car', 'fallback', (d) => { if (d.car.manifest) d.car.manifest.fallback = true; }),
        INVALID('car', 'nodes', (d) => { delete d.car.carNodes; }),
        INVALID('car', 'negative-index-count', (d) => { if (d.car.carDraws?.[0]) d.car.carDraws[0].indexCount = -3; }),
        BENIGN('car', 'extra-field', (d) => { d.car.future = 1; })
      ]
    },
    {
      name: 'ghost',
      build: () => ({ ghost: clone(ghost) }),
      run: ({ ghost: record }) => {
        const result = validateGhostRecord(record);
        if (!result.ok) {
          const error = new Error(result.errors.join('; '));
          error.code = 'GHOST_SCHEMA';
          error.errors = result.errors;
          throw error;
        }
      },
      mutators: [
        INVALID('ghost', 'kind', (d) => { d.ghost.kind = 'x'; }),
        INVALID('ghost', 'version', (d) => { d.ghost.version = 2; }),
        INVALID('ghost', 'course', (d) => { d.ghost.course = 'lap'; }),
        INVALID('ghost', 'tick-hz', (d) => { d.ghost.tickHz = 30; }),
        INVALID('ghost', 'tick-count', (d) => { d.ghost.tickCount = 1; }),
        INVALID('ghost', 'finish-tick', (d) => { d.ghost.finishTick += 1; }),
        INVALID('ghost', 'time-zero', (d) => { d.ghost.timeSeconds = 0; }),
        INVALID('ghost', 'encoding', (d) => { d.ghost.sample.encoding = 'float64'; }),
        INVALID('ghost', 'sample-bytes', (d) => {
          const bytes = Buffer.from(d.ghost.sample.data, 'base64');
          d.ghost.sample.data = bytes.subarray(0, Math.max(0, bytes.length - 1)).toString('base64');
        }),
        INVALID('ghost', 'no-hash', (d) => { delete d.ghost.hash; }),
        INVALID('ghost', 'non-base64', (d) => { d.ghost.sample.data = '!!!!' + d.ghost.sample.data.slice(4); }),
        INVALID('ghost', 'zero-quaternion', (d) => {
          const bytes = Buffer.from(d.ghost.sample.data, 'base64');
          const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
          floats[3] = 0; floats[4] = 0; floats[5] = 0; floats[6] = 0;
          d.ghost.sample.data = Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
        }),
        BENIGN('ghost', 'extra-field', (d) => { d.ghost.future = 1; })
      ]
    },
    {
      name: 'sprint-layout',
      build: () => ({ layout: clone(shortLayout) }),
      run: ({ layout }) => {
        const result = validateSprintLayout(layout);
        if (!result.ok) {
          const error = new Error(result.errors.join('; '));
          error.code = 'LAYOUT_SCHEMA';
          error.errors = result.errors;
          throw error;
        }
      },
      mutators: [
        INVALID('layout', 'kind', (d) => { d.layout.kind = 'x'; }),
        INVALID('layout', 'version', (d) => { d.layout.version = 2; }),
        INVALID('layout', 'gates', (d) => { if (Array.isArray(d.layout.gates)) d.layout.gates = d.layout.gates.slice(0, 2); }),
        INVALID('layout', 'gate-order', (d) => { if (d.layout.gates?.[0]) d.layout.gates[0].kind = 'finish'; }),
        INVALID('layout', 'gate-null', (d) => { if (d.layout.gates?.[1]) d.layout.gates[1].x = null; }),
        INVALID('layout', 'gate-behind', (d) => { if (d.layout.gates?.[2] && d.layout.gates[1]) d.layout.gates[2].x = d.layout.gates[1].x - 1; }),
        INVALID('layout', 'span-finish', (d) => { if (d.layout.course?.span) d.layout.course.span.finishX -= 1; }),
        BENIGN('layout', 'extra-field', (d) => { d.layout.future = 1; })
      ]
    },
    {
      name: 'map-package',
      build: () => ({ map: clone(map.map), layout: clone(map.layout), pins: clone(map.pins) }),
      run: ({ map: mapDoc, layout, pins }) => {
        const result = validateMapPackage(mapDoc, layout, pins);
        if (!result.ok) {
          const error = new Error(result.errors.join('; '));
          error.code = 'MAP_SCHEMA';
          error.errors = result.errors;
          throw error;
        }
      },
      mutators: [
        INVALID('map', 'kind', (d) => { d.map.kind = 'x'; }),
        INVALID('map', 'hash', (d) => { d.map.hash = 'sha256:' + '0'.repeat(64); }),
        INVALID('map', 'draw-count', (d) => { d.map.mapRender.draws = []; d.map.counts.draws = 0; }),
        INVALID('map', 'draw-range', (d) => { if (d.map.mapRender.draws?.[0]) d.map.mapRender.draws[0].indexOffset = 3; }),
        INVALID('map', 'texture-bytes', (d) => { if (d.map.mapRender.textures?.[0]) d.map.mapRender.textures[0].rgbaBytes = 8; }),
        INVALID('map', 'instances', (d) => { if (d.map.mapRender.instances) d.map.mapRender.instances.applied = true; }),
        INVALID('map', 'normals', (d) => { if (d.map.mapRender.normals) d.map.mapRender.normals.fallback = 'none'; }),
        INVALID('map', 'mesh-uv', (d) => { if (d.map.meshes?.[0]) delete d.map.meshes[0].uv; }),
        INVALID('layout', 'gate-order', (d) => { if (d.layout.gates?.[1]) d.layout.gates[1].kind = 'finish'; }),
        INVALID('layout', 'sample-null', (d) => { if (d.layout.course?.samples?.[0]) d.layout.course.samples[0].x = null; }),
        INVALID('layout', 'self-hash', (d) => { if (d.layout.gates?.[1]) d.layout.gates[1].id = 'edited'; }),
        BENIGN('map', 'extra-field', (d) => { d.map.future = 1; })
      ]
    }
  ];
}

// Ghost hash must be recomputed after a structural mutation, otherwise every
// mutation is caught by the hash check and the taxonomy measures nothing else.
function preparePacket(docs) {
  if (docs.packet) docs.packet.hash = packetHash(docs.packet);
}

function prepareGhost(docs, mutations) {
  const record = docs.ghost;
  if (!record) return;
  const hashTouched = mutations.some((mutation) => ['no-hash', 'non-base64'].includes(mutation.name));
  if (!hashTouched) record.hash = ghostHash(record);
}

function prepareLayouts(docs, schemaName, mutations) {
  const doc = docs.layout;
  if (!doc) return;
  const skip = mutations.some((mutation) => mutation.name === 'self-hash') ||
    schemaName === 'map-package' && mutations.some((mutation) => mutation.name === 'layout-hash');
  if (skip) return;
  rehash(doc);
}

function classifyError(error) {
  const name = error?.name ?? 'Error';
  if (typeof error?.code === 'string') return { category: 'rejected-typed', code: error.code, name };
  if (['TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError'].includes(name)) {
    return { category: 'crash', code: null, name };
  }
  return { category: 'rejected-untyped', code: null, name };
}

export function runFuzz() {
  const table = schemas();
  const cases = [];
  const taxonomy = {};
  const determinants = {};
  const silentSeeds = [];
  const crashSeeds = [];
  let counter = 0;

  while (counter < CONFIG.caseCount) {
    const schema = table[counter % table.length];
    const seed = (CONFIG.baseSeed + Math.imul(counter + 1, 0x9e3779b1)) >>> 0;
    const random = prng(seed);
    const docs = schema.build();
    const mutationCount = 1 + Math.floor(random() * 3);
    const pool = schema.mutators.slice();
    const chosen = [];
    const groups = new Set();
    for (let index = 0; index < mutationCount && pool.length; index++) {
      let pick = Math.floor(random() * pool.length);
      let attempts = 0;
      while (attempts < pool.length && groups.has(pool[pick].group)) {
        pick = (pick + 1) % pool.length;
        attempts++;
      }
      if (groups.has(pool[pick].group)) break;
      const mutation = pool.splice(pick, 1)[0];
      groups.add(mutation.group);
      chosen.push(mutation);
    }
    let prepareError = null;
    try {
      for (const mutation of chosen) mutation.apply(docs);
      if (channelHas(docs, 'packet')) preparePacket(docs);
      if (channelHas(docs, 'ghost')) prepareGhost(docs, chosen);
      if (channelHas(docs, 'layout')) prepareLayouts(docs, schema.name, chosen);
    } catch (error) {
      prepareError = error;
    }

    const benign = chosen.every((mutation) => mutation.benign);
    let outcome;
    let error = null;
    let code = null;
    let errorName = null;
    if (prepareError) {
      outcome = classifyError(prepareError);
      error = prepareError.message;
      code = outcome.code;
      errorName = outcome.name;
      outcome = outcome.category;
    } else {
      try {
        schema.run(docs);
        outcome = benign ? 'accepted-benign' : 'silent-accepted';
        if (!benign) silentSeeds.push(seed);
      } catch (thrown) {
        const classified = classifyError(thrown);
        error = thrown.message;
        code = classified.code;
        errorName = classified.name;
        outcome = benign ? 'over-strict' : classified.category;
        if (outcome === 'crash' && !benign) crashSeeds.push(seed);
      }
    }

    const bucket = (taxonomy[schema.name] ??= {
      total: 0, rejectedTyped: 0, rejectedUntyped: 0, crash: 0, silentAccepted: 0, acceptedBenign: 0, overStrict: 0
    });
    bucket.total++;
    if (outcome === 'rejected-typed') bucket.rejectedTyped++;
    else if (outcome === 'rejected-untyped') bucket.rejectedUntyped++;
    else if (outcome === 'crash') bucket.crash++;
    else if (outcome === 'silent-accepted') bucket.silentAccepted++;
    else if (outcome === 'accepted-benign') bucket.acceptedBenign++;
    else if (outcome === 'over-strict') bucket.overStrict++;
    const determinant = schema.name + '|' + chosen.map((mutation) => mutation.target + ':' + mutation.name).join(',') + '|' + outcome;
    determinants[seed] = determinant;

    const row = {
      index: counter,
      seed,
      schema: schema.name,
      mutations: chosen.map((mutation) => mutation.target + ':' + mutation.name),
      benign,
      outcome,
      error,
      code,
      errorName
    };
    cases.push(row);
    if (counter % CONFIG.replicaCheckStride === 0) {
      // Replica check is performed below on a fresh call.
    }
    counter++;
  }

  return { cases, taxonomy, determinants, seeds: { silent: silentSeeds, crash: crashSeeds } };
}

function channelHas(docs, key) {
  return Object.prototype.hasOwnProperty.call(docs, key);
}

/**
 * Re-run every Nth case from its seed through a fresh fuzz pass and compare the
 * determinant string. Returns {ok, checked, mismatches}; the caller records the
 * hash of the full case list too.
 */
export function fuzzDeterminism(first) {
  const second = runFuzz();
  if (second.cases.length !== first.cases.length) {
    return { ok: false, checked: 0, mismatches: ['case count changed'] };
  }
  const mismatches = [];
  let checked = 0;
  for (let index = 0; index < first.cases.length; index += CONFIG.replicaCheckStride) {
    checked++;
    const a = first.determinants[first.cases[index].seed];
    const b = second.determinants[second.cases[index].seed];
    if (a !== b) mismatches.push({ seed: first.cases[index].seed, first: a, second: b });
  }
  return { ok: mismatches.length === 0, checked, mismatches };
}
