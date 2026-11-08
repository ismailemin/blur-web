// Deterministic fixtures for the ROBUST1 validation harness.
//
// Everything here is either synthetic (small, hermetic documents that satisfy
// the same contract the page enforces) or the committed artefact read
// read-only. No file under probes/e1-drive, probes/net-mvp, tools/ or _work/
// is written by this probe.
//
// The synthetic geometry exists so `createSession()` (the live packet producer)
// can be exercised without loading the 18 MB real chunks on every case. One
// separate case group loads the real level/car chunks read-only and proves the
// synthetic shape agrees with them.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSession, multiplyMat4, rotationXMatrix } from '../../e1-drive/web/packet-adapter.js';
import { GEOMETRY_VERSION, parseCarChunk, parseChunkIndex, parseLevelChunk } from '../../e1-drive/web/geometry-chunks.js';
import { hashOf } from '../../e1-drive/web/packet-hash.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const E1 = path.join(ROOT, '_work/e1-drive');

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const SLUG = 'corvette-zr1-stock';
export const WHEEL_CORNERS = ['frontleft', 'frontright', 'backleft', 'backright'];
export const CAR_MESH_ID = 'car.' + SLUG + '.body';

/** A tiny 1x1 RGBA texture record; createSession only checks identity, not pixels. */
function texture(id) {
  return {
    id,
    kind: 'rgba8',
    width: 1,
    height: 1,
    levels: 1,
    rgbaBytes: 4,
    rgbaSha256: 'sha256:' + '0'.repeat(64),
    rgbaBase64: 'AAAAAA=='
  };
}

/** One mesh record with a real triangle. `coordinateSpace:'world'` for occluders. */
function mesh(id, coordinateSpace = 'world') {
  return {
    id,
    storage: 'inline-json',
    vertexCount: 3,
    indexCount: 3,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    uv: null,
    positionsSha256: 'sha256:' + '1'.repeat(64),
    indicesSha256: 'sha256:' + '2'.repeat(64),
    coordinateSpace,
    source: { tool: 'probes/robustness/lib/fixtures.mjs', note: 'synthetic validation fixture' }
  };
}

function wheelGroup(corner, tx) {
  return {
    id: 'e1.wheel.' + corner,
    corner,
    name: corner,
    translation: [tx, 0, 0],
    matrixColumnMajor: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, 0, 0, 1],
    localBounds: { min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] },
    memberLocalBounds: {},
    spinAxis: [1, 0, 0],
    axisSpace: 'element',
    spinMembers: ['tyre'],
    staticMembers: ['brakeCaliper'],
    axisEvidence: 'synthetic fixture',
    spinDraws: [corner + '.spin'],
    staticDraws: [],
    provenDraws: [corner + '.spin'],
    previewDraws: [corner + '.spin'],
    ambiguousDraws: [],
    spinEvidence: 'synthetic fixture',
    spinSource: 'synthetic fixture'
  };
}

/**
 * A minimal geometry document that satisfies `createSession()`:
 * camera intrinsics, two world meshes (level props + track visual), a hidden
 * collision surface, one texture pack for the static half, four level-prop
 * textures, and one car body with four wheel groups and its own UV stream.
 */
export function syntheticGeometry() {
  const levelMesh = mesh('level.props');
  const trackMesh = mesh('river.track.visual');
  trackMesh.uv = {
    storage: 'base64-float32le', components: 2, vertexCount: 3, values: 6, bytes: 24,
    sha256: 'sha256:' + '8'.repeat(64), data: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    source: { provenance: 'synthetic fixture' }
  };
  const carMesh = mesh(CAR_MESH_ID, 'object-local');
  carMesh.uv = { storage: 'base64-float32le', components: 2, vertexCount: 3, bytes: 24, data: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
  const wheelGroups = WHEEL_CORNERS.map((corner, index) => wheelGroup(corner, index % 2 ? 0.8 : -0.8));
  const texturePackRecord = {
    manifest: 'synthetic',
    manifestSha256: 'sha256:' + '7'.repeat(64),
    p52Manifest: 'synthetic',
    sceneReport: 'synthetic',
    sampler: 'synthetic',
    scopeLabels: [],
    coverage: { drawCount: 1, staticAlbedoDraws: 0 },
    uvConvention: { sampleUV: 'synthetic' },
    materialScope: 'synthetic fixture'
  };
  const body = {
    slug: SLUG,
    name: 'Synthetic Corvette',
    meshId: CAR_MESH_ID,
    mesh: carMesh,
    textures: [texture('car.tex.0')],
    texturePack: texturePackRecord,
    manifest: {
      path: 'synthetic',
      sha256: 'sha256:' + '3'.repeat(64),
      fallback: false,
      sourceModelPakPath: '\\models\\vehicles\\synthetic.model',
      sourceModelSha256: '4'.repeat(64)
    },
    carDraws: [{
      id: SLUG + '.draw.0',
      meshId: CAR_MESH_ID,
      vertexOffset: 0,
      vertexCount: 3,
      indexOffset: 0,
      indexCount: 3,
      materialId: null,
      materialReason: 'synthetic fixture',
      textureId: null,
      layer: 'opaque',
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      worldKind: 'packet-transform',
      source: { tool: 'synthetic' },
      localBounds: { min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] },
      renderPartId: null,
      nodeId: 'e1.car.body'
    }],
    carNodes: [{ id: 'e1.car.body', meshId: CAR_MESH_ID, drawIds: [SLUG + '.draw.0'], reason: 'synthetic body' }],
    carParts: [{ id: 'body', partKind: 'body', name: 'body', draws: [0], provenDraws: [0], ambiguousDraws: [] }],
    wheelGroups
  };
  return {
    kind: 'e1-drive.geometry',
    version: GEOMETRY_VERSION,
    chunk: { kind: 'assembled', version: 1, level: 'level', car: SLUG },
    cameraIntrinsics: {
      near: 0.1,
      far: 2000,
      verticalFovRadians: 60 * Math.PI / 180,
      aspect: 16 / 9,
      up: [0, 1, 0]
    },
    materials: [],
    light: {
      type: 'directional',
      direction: [0, -1, 0],
      colour: [1, 1, 1, 1],
      intensity: 1,
      source: 'synthetic fixture'
    },
    meshes: [levelMesh, trackMesh],
    levelDraws: [{
      id: 'level.draw.0',
      meshId: levelMesh.id,
      vertexOffset: 0,
      vertexCount: 3,
      indexOffset: 0,
      indexCount: 3,
      materialId: null,
      materialReason: 'synthetic fixture',
      textureId: null,
      layer: 'opaque',
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      worldKind: 'baked-into-mesh',
      source: { tool: 'synthetic' }
    }],
    trackVisual: {
      label: 'asset-reader-direct-draws',
      meshId: trackMesh.id,
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sections: [],
      draws: [{
        id: 'track.draw.0',
        meshId: trackMesh.id,
        vertexOffset: 0,
        vertexCount: 3,
        indexOffset: 0,
        indexCount: 3,
        materialId: null,
        materialReason: 'synthetic fixture',
        textureId: null,
        layer: 'opaque',
        bounds: { min: [0, 0, 0], max: [1, 1, 0] },
        worldKind: 'baked-into-mesh',
        source: { tool: 'synthetic' }
      }]
    },
    collisionSurface: {
      id: 'river.collision.surface',
      meshId: 'river.collision.surface',
      visible: false,
      vertexCount: 3,
      triangleCount: 1,
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      source: { tool: 'synthetic' },
      reason: 'synthetic physics provenance',
      mesh: mesh('river.collision.surface')
    },
    textures: [texture('level.tex.0')],
    texturePack: { manifest: 'synthetic', sampler: 'synthetic', coverage: { drawCount: 1 } },
    levelTextures: [texture('level.prop.0'), texture('level.prop.1'), texture('level.prop.2'), texture('level.prop.3')],
    levelPropTexturePack: { manifest: 'synthetic' },
    levelInstances: { emitted: 0, omitted: 0, culled: 0 },
    carBodies: { [SLUG]: body },
    fallbackBodies: [],
    source: {
      packet: 'synthetic',
      packetHash: 'sha256:' + '5'.repeat(64),
      packetSha256: 'sha256:' + '6'.repeat(64)
    },
    roster: { cars: [{ slug: SLUG }], default: SLUG },
    diagnostics: { extras: {} }
  };
}

/** A settled engine state shaped like `e1_get_state()`. */
export function tick0State(overrides = {}) {
  return {
    tick: 0,
    dt: 1 / 60,
    position: [0, 0, 0],
    axisX: [1, 0, 0],
    axisY: [0, 1, 0],
    axisZ: [0, 0, 1],
    velocity: [0, 0, 0],
    angular: [0, 0, 0],
    speed: 0,
    contacts: '1111',
    wheels: WHEEL_CORNERS.map((corner, index) => ({
      onGround: true,
      suspension: 0,
      position: [index % 2 ? 0.8 : -0.8, 0, index < 2 ? 1.2 : -1.2],
      angular: 0,
      surface: 0,
      userData: 0,
      groundNormal: [0, 1, 0]
    })),
    finite: 1,
    anyContact: true,
    input: [0, 0, 0, 0],
    ...overrides
  };
}

/** A valid v1.1 packet built by the real live producer, small enough for fuzzing. */
export function validPacket() {
  const geometry = syntheticGeometry();
  const session = createSession(geometry, tick0State(), { car: { slug: SLUG, name: 'Synthetic Corvette' } });
  for (let tick = 1; tick < 4; tick++) {
    session.appendState(tick0State({ tick, position: [tick * 0.5, 0, 0], speed: 2 }));
  }
  return session.finalise();
}

// ---------------------------------------------------------------- chunk fixtures
export function validIndexDoc() {
  return {
    kind: 'e1-drive.car-bodies-index',
    version: 1,
    geometryVersion: GEOMETRY_VERSION,
    generator: 'probes/robustness fixtures',
    policy: {
      levelChunksLoaded: 1,
      carChunksResident: 2,
      carChunks: 'synthetic fixture',
      missingChunk: 'typed load error',
      streaming: 'none'
    },
    level: { file: 'level.geometry.json', sha256: 'sha256:' + 'a'.repeat(64), bytes: 1000, meshes: 2 },
    base: { file: 'base.geometry.json', sha256: 'sha256:' + 'b'.repeat(64), bytes: 500 },
    cars: {
      [SLUG]: {
        file: 'cars/' + SLUG + '.geometry.json',
        sha256: 'sha256:' + 'c'.repeat(64),
        bytes: 2000,
        meshId: CAR_MESH_ID,
        draws: 1,
        vertices: 3,
        triangles: 1
      }
    },
    defaultCar: SLUG
  };
}

export function validLevelDoc() {
  return {
    kind: 'e1-drive.geometry',
    version: GEOMETRY_VERSION,
    chunk: { kind: 'level', version: 1 },
    carBodies: {},
    meshes: [mesh('level.props'), mesh('river.track.visual')],
    materials: [],
    light: {},
    cameraIntrinsics: {},
    levelDraws: [],
    trackVisual: { label: 'asset-reader-direct-draws', meshId: 'river.track.visual', draws: [] },
    textures: [],
    levelTextures: [],
    source: {},
    diagnostics: {}
  };
}

export function validBaseDoc() {
  return {
    kind: 'e1-drive.geometry',
    version: GEOMETRY_VERSION,
    chunk: { kind: 'base', version: 1 },
    carBodies: {},
    materials: [],
    light: {},
    cameraIntrinsics: {},
    roster: { cars: [{ slug: SLUG }], default: SLUG }
  };
}

export function validCarDoc() {
  const body = syntheticGeometry().carBodies[SLUG];
  return {
    kind: 'e1-drive.car-chunk',
    version: 1,
    geometryVersion: GEOMETRY_VERSION,
    slug: SLUG,
    chunk: { kind: 'car', slug: SLUG, levelSha256: 'sha256:' + 'd'.repeat(64), version: 1 },
    ...body
  };
}

// ------------------------------------------------------------- committed artefacts
export function readCommitted(relative) {
  return readFileSync(path.join(ROOT, relative));
}

export function readCommittedJson(relative) {
  return JSON.parse(readCommitted(relative).toString('utf8'));
}

/**
 * Load the committed chunk index, level chunk and one car chunk read-only.
 * Used once to prove the synthetic fixtures have the same contract as the
 * shipped files (and that the real files still pass the harness).
 */
export function loadRealChunks({ full = false } = {}) {
  const indexBytes = readCommitted('_work/e1-drive/car-bodies.index.json');
  const index = parseChunkIndex(indexBytes.toString('utf8'));
  const levelText = readCommitted('_work/e1-drive/level.geometry.json').toString('utf8');
  const level = parseLevelChunk(levelText);
  const carFile = index.cars[SLUG].file;
  const carText = readCommitted('_work/e1-drive/' + carFile).toString('utf8');
  const car = parseCarChunk(carText, index, SLUG);
  return {
    index,
    indexBytes: indexBytes.length,
    level,
    levelText,
    car,
    carText,
    base: full ? readCommittedJson('_work/e1-drive/base.geometry.json') : null
  };
}

export const REAL_PATHS = {
  index: '_work/e1-drive/car-bodies.index.json',
  level: '_work/e1-drive/level.geometry.json',
  base: '_work/e1-drive/base.geometry.json',
  car: '_work/e1-drive/cars/' + SLUG + '.geometry.json',
  sprint: '_work/e1-drive/sprint.json',
  sprintShort: '_work/e1-drive/sprint-short.json',
  ghost: 'probes/e1-drive/ghosts/' + SLUG + '-310m.json',
  ghostIndex: 'probes/e1-drive/ghosts/index.json',
  roster: '_work/e1-drive/cars.json',
  publishedManifest: '_work/prop-collision/colliders-v2.json'
};

// Re-export the two matrix helpers so case files do not import packet-adapter twice.
export { multiplyMat4, rotationXMatrix, hashOf };
