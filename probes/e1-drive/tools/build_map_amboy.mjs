// Build the E1 `usa_amboy` map artifacts from the committed map-slice packages.
//
//   node probes/e1-drive/tools/build_map_amboy.mjs
//   node probes/e1-drive/tools/build_map_amboy.mjs --check   (re-build and compare)
//
// Inputs (read-only, generated game data):
//   _work/map-slice/amboy/slice.json                 MAP2/READ1 slice manifest
//   _work/map-slice/amboy/collision.*.bin            hidden collision provenance
//   _work/map-slice/amboy-render/render.json         AMB1 render manifest
//   _work/map-slice/amboy-render/diagnostics.json    blocked / decal label list
//   _work/map-slice/amboy-render/draws.*.bin         the three geometry buffers
//   _work/map-slice/amboy-render/layout.points.f32.bin
//   _work/map-slice/amboy-render/textures/tex-NNN.rgba
//
// Outputs (generated game data, never committed):
//   _work/e1-drive/amboy/map.json     E1 map document: one merged mesh, 1,201
//                                     opaque draws, 179 textures, hidden collision
//   _work/e1-drive/amboy/layout.json  E1 sprint layout: 8,673 measured samples,
//                                     spawn/checkpoints/finish gates, R1 rules
//
// Every value is read from the packages; the builder makes no format, offset,
// normal, texture or coordinate guess. A changed package is a hard failure: the
// file and content hashes recorded here are also the page's pin set.
//
// This tool does not modify the map-slice packages, game data or the engine.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashOf } from '../web/packet-hash.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, '_work/e1-drive/amboy');
const CHECK = process.argv.includes('--check');

const PATHS = Object.freeze({
  slice: '_work/map-slice/amboy/slice.json',
  render: '_work/map-slice/amboy-render/render.json',
  diagnostics: '_work/map-slice/amboy-render/diagnostics.json',
  physics: 'game-data/Blur/levels/usa_amboy/Level.levelphysics'
});

const sha256 = (buffer) => 'sha256:' + createHash('sha256').update(buffer).digest('hex');
const readBytes = (relative) => readFileSync(path.join(ROOT, relative));
const readJson = (relative) => JSON.parse(readBytes(relative).toString('utf8'));

function pin(relative, expectedBytes, expectedSha) {
  const bytes = readBytes(relative);
  const actual = sha256(bytes);
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(relative + ': ' + bytes.byteLength + ' bytes, package pins ' + expectedBytes);
  }
  if (actual !== 'sha256:' + expectedSha && actual !== expectedSha) {
    throw new Error(relative + ': sha256 ' + actual + ', package pins ' + expectedSha);
  }
  return { path: relative, bytes: bytes.byteLength, sha256: actual.replace(/^sha256:/, '') };
}

// ------------------------------------------------------------------ package
if (!existsSync(path.join(ROOT, PATHS.render))) {
  throw new Error('missing ' + PATHS.render + ' — run the committed map-slice builder first');
}
if (!existsSync(path.join(ROOT, PATHS.slice))) {
  throw new Error('missing ' + PATHS.slice + ' — run the committed map-slice builder first');
}

const renderBytes = readBytes(PATHS.render);
const render = JSON.parse(renderBytes.toString('utf8'));
const sliceBytes = readBytes(PATHS.slice);
const slice = JSON.parse(sliceBytes.toString('utf8'));

if (render.level !== 'usa_amboy' || slice.layout?.level !== undefined && slice.layout.level !== 'usa_amboy') {
  throw new Error('render/slice package is not usa_amboy');
}
if (render.hashes?.contentSha256 !== '626d39534bc3a37e5878c6801443c580aba576e45f3cba10ddb73a7edc50bf71') {
  throw new Error('render.json content hash ' + render.hashes?.contentSha256 +
    ' is not the committed usa_amboy render package (626d3953…bf71)');
}
if (slice.hashes?.contentSha256 !== '61915aedfaab43b6b327c3ef803c896ea55397bc7dc7a4d2757f340632043ec8') {
  throw new Error('slice.json content hash ' + slice.hashes?.contentSha256 +
    ' is not the committed usa_amboy slice (61915aed…43ec8)');
}

// Verify every render payload file this builder consumes against render.json.
const decode = (buffer) => buffer;
const positionsBytes = readBytes('_work/map-slice/amboy-render/draws.positions.f32.bin');
const uv0Bytes = readBytes('_work/map-slice/amboy-render/draws.uv0.f32.bin');
const indexBytes = readBytes('_work/map-slice/amboy-render/draws.indices.u32.bin');
const layoutBytes = readBytes('_work/map-slice/amboy-render/layout.points.f32.bin');
const diagnosticsBytes = readBytes(PATHS.diagnostics);
const collisionPositionsBytes = readBytes('_work/map-slice/amboy/collision.positions.f32.bin');
const collisionIndexBytes = readBytes('_work/map-slice/amboy/collision.indices.u32.bin');

const buffers = render.buffers;
const pinBuffer = (name, buffer) => {
  const record = buffers?.[name];
  if (!record) throw new Error('render.json has no buffer record ' + name);
  const actual = sha256(buffer);
  if (buffer.byteLength !== record.bytes || actual !== 'sha256:' + record.sha256) {
    throw new Error(name + ' does not match render.json (' + actual + ' / ' + buffer.byteLength + ')');
  }
};
pinBuffer('positions', positionsBytes);
pinBuffer('uv0', uv0Bytes);
pinBuffer('indices', indexBytes);

if (sha256(layoutBytes) !== 'sha256:' + render.layout.pointsSha256) {
  throw new Error('layout.points.f32.bin does not match render.json pointsSha256');
}
if (sha256(diagnosticsBytes) !== 'sha256:' + render.hashes.files['diagnostics.json'].sha256) {
  throw new Error('diagnostics.json does not match render.json file pin');
}
if (sha256(collisionPositionsBytes) !== 'sha256:' + slice.hashes.files['collision.positions.f32.bin'].sha256 ||
    collisionPositionsBytes.byteLength !== slice.hashes.files['collision.positions.f32.bin'].bytes) {
  throw new Error('collision.positions.f32.bin does not match slice.json');
}
if (sha256(collisionIndexBytes) !== 'sha256:' + slice.hashes.files['collision.indices.u32.bin'].sha256 ||
    collisionIndexBytes.byteLength !== slice.hashes.files['collision.indices.u32.bin'].bytes) {
  throw new Error('collision.indices.u32.bin does not match slice.json');
}
const physicsBytes = readBytes(PATHS.physics);
if (physicsBytes.byteLength !== slice.source.levelPhysics.bytes ||
    sha256(physicsBytes) !== 'sha256:' + slice.source.levelPhysics.sha256) {
  throw new Error(PATHS.physics + ' does not match the slice levelPhysics pin');
}

// ------------------------------------------------------------------ geometry
const positions = Float32Array.from(
  new Float32Array(positionsBytes.buffer, positionsBytes.byteOffset, positionsBytes.byteLength / 4));
const uv0 = Float32Array.from(
  new Float32Array(uv0Bytes.buffer, uv0Bytes.byteOffset, uv0Bytes.byteLength / 4));
const indices = Uint32Array.from(
  new Uint32Array(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength / 4));
const vertexCount = positions.length / 3;
const indexCount = indices.length;
if (vertexCount !== render.counts.vertexCount || indexCount !== render.counts.indexCount) {
  throw new Error('geometry counts do not match render.json');
}
if (uv0.length !== vertexCount * 2) throw new Error('UV0 count does not match the vertex count');

const MESH_ID = 'amboy.direct';
const mesh = {
  id: MESH_ID,
  storage: 'inline-json',
  vertexCount,
  indexCount,
  positions: Array.from(positions),
  indices: Array.from(indices),
  positionsSha256: 'sha256:' + sha256(positionsBytes).slice(7),
  indicesSha256: 'sha256:' + sha256(indexBytes).slice(7),
  uv: {
    storage: 'base64-float32le',
    components: 2,
    vertexCount,
    values: vertexCount * 2,
    bytes: uv0Bytes.byteLength,
    data: uv0Bytes.toString('base64'),
    sha256: 'sha256:' + sha256(uv0Bytes).slice(7),
    source: {
      provenance: 'map-slice merged draws.uv0.f32.bin (1,606/1,606 UV0 hashes verified by MAP3/AMB1)'
    }
  },
  coordinateSpace: 'world',
  source: {
    package: '_work/map-slice/amboy-render',
    buffers: ['draws.positions.f32.bin', 'draws.uv0.f32.bin', 'draws.indices.u32.bin'],
    note: 'byte-identical to the MAP2 slice buffers; positions and UV0 are separate per-vertex streams, indices are global'
  }
};

// ------------------------------------------------------------------ draws
const boundsFor = (firstIndex, count) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = firstIndex; index < firstIndex + count; index++) {
    const vertex = indices[index] * 3;
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[vertex + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { min, max };
};

const manifestDraws = new Map(render.draws.map((draw) => [draw.drawId, draw]));
const draws = render.draws.map((draw, ordinal) => {
  if (draw.status !== 'bindable-static-albedo') {
    throw new Error('render.json draw ' + draw.drawId + ' status is ' + draw.status);
  }
  if (!(draw.firstIndex >= 0) || !(draw.indexCount > 0) || draw.indexCount % 3 !== 0 ||
      draw.firstIndex + draw.indexCount > indexCount) {
    throw new Error('render.json draw ' + draw.drawId + ' has an invalid index range');
  }
  const bounds = boundsFor(draw.firstIndex, draw.indexCount);
  if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) {
    throw new Error('draw ' + draw.drawId + ' bounds are not finite');
  }
  return {
    id: 'amboy.draw.' + ordinal,
    meshId: MESH_ID,
    indexOffset: draw.firstIndex,
    indexCount: draw.indexCount,
    triangleCount: draw.triangleCount,
    textureId: draw.textureId,
    textureSlot: draw.textureSlot,
    textureName: draw.textureName,
    uvHash: draw.uvHash,
    section: draw.section,
    sectionDrawIndex: draw.sectionDrawIndex,
    primitiveIndex: draw.primitiveIndex,
    effect: draw.effect,
    material: draw.material,
    materialRow: draw.materialRow,
    layer: 'opaque',
    worldKind: 'baked-into-mesh',
    bounds,
    source: { package: '_work/map-slice/amboy-render', drawId: draw.drawId, status: draw.status }
  };
});
if (draws.length !== render.counts.bindableDraws) {
  throw new Error('opaque draw count ' + draws.length + ' != ' + render.counts.bindableDraws);
}

// ------------------------------------------------------------------ textures
const textures = render.textures.items.map((item) => {
  const file = path.posix.join('_work/map-slice/amboy-render', item.file);
  const bytes = readBytes(file);
  if (bytes.byteLength !== item.bytes || sha256(bytes) !== 'sha256:' + item.sha256) {
    throw new Error('texture ' + item.file + ' does not match render.json');
  }
  if (bytes.byteLength !== item.width * item.height * 4) {
    throw new Error('texture ' + item.file + ' byte length does not match its dimensions');
  }
  return {
    id: item.primaryId,
    sourceIds: item.sourceIds.slice(),
    slot: item.slot,
    name: item.name,
    width: item.width,
    height: item.height,
    levels: item.levels,
    format: item.format,
    formatName: item.formatName,
    alphaOpaque: item.alpha?.alphaOpaque === true,
    sampler: Array.isArray(item.sampler) ? item.sampler.slice() : null,
    samplerReason: Array.isArray(item.sampler) ? null : 'no raw sampler state recorded for this shared source; not applied',
    bytes: bytes.byteLength,
    rgbaBytes: bytes.byteLength,
    rgbaSha256: 'sha256:' + item.sha256,
    rgbaBase64: bytes.toString('base64'),
    srgbHint: item.srgbHint,
    mipHint: item.mipHint,
    upload: item.upload,
    drawCount: item.drawCount,
    triangleCount: item.triangleCount,
    source: { package: '_work/map-slice/amboy-render', file: item.file, sha256: 'sha256:' + item.sha256 }
  };
});
if (textures.length !== render.textures.uniqueBlobs) {
  throw new Error('texture count ' + textures.length + ' != ' + render.textures.uniqueBlobs);
}
const textureIds = new Set(textures.map((texture) => texture.id));
const textureIdBySource = new Map();
for (const texture of textures) {
  for (const sourceId of texture.sourceIds) textureIdBySource.set(sourceId, texture.id);
}
for (const draw of draws) {
  const merged = textureIdBySource.get(draw.textureId);
  if (!merged) throw new Error('draw ' + draw.id + ' names unknown texture source ' + draw.textureId);
  draw.textureSourceId = draw.textureId;
  draw.textureId = merged;
}

// ------------------------------------------------------------------ collision
const collisionPositions = Float32Array.from(
  new Float32Array(collisionPositionsBytes.buffer, collisionPositionsBytes.byteOffset,
    collisionPositionsBytes.byteLength / 4));
const collisionIndices = Uint32Array.from(
  new Uint32Array(collisionIndexBytes.buffer, collisionIndexBytes.byteOffset,
    collisionIndexBytes.byteLength / 4));
const collisionVertexCount = collisionPositions.length / 3;
const collisionIndexCount = collisionIndices.length;
const collisionBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (let index = 0; index < collisionPositions.length; index += 3) {
  for (let axis = 0; axis < 3; axis++) {
    const value = collisionPositions[index + axis];
    if (value < collisionBounds.min[axis]) collisionBounds.min[axis] = value;
    if (value > collisionBounds.max[axis]) collisionBounds.max[axis] = value;
  }
}
const collisionSurface = {
  id: 'amboy.collision',
  meshId: 'amboy.collision.mesh',
  visible: false,
  physicsOnly: true,
  vertexCount: collisionVertexCount,
  triangleCount: collisionIndexCount / 3,
  bounds: collisionBounds,
  source: {
    package: '_work/map-slice/amboy',
    note: 'static triangle meshes only; the Box, four Cylinders and the InstancedTriangleMesh are not in this buffer'
  },
  reason: 'hidden physics provenance; the engine loads the complete Level.levelphysics, this mesh is not uploaded or drawn',
  mesh: {
    id: 'amboy.collision.mesh',
    storage: 'inline-json',
    vertexCount: collisionVertexCount,
    indexCount: collisionIndexCount,
    positions: Array.from(collisionPositions),
    indices: Array.from(collisionIndices),
    positionsSha256: 'sha256:' + sha256(collisionPositionsBytes).slice(7),
    indicesSha256: 'sha256:' + sha256(collisionIndexBytes).slice(7),
    uv: null,
    coordinateSpace: 'world',
    source: { package: '_work/map-slice/amboy' }
  },
  draw: {
    id: 'amboy.collision.draw',
    meshId: 'amboy.collision.mesh',
    indexOffset: 0,
    indexCount: collisionIndexCount,
    visible: false
  }
};

// ------------------------------------------------------------------ blocked lists
const diagnostics = JSON.parse(diagnosticsBytes.toString('utf8'));
if (diagnostics.groups?.effectDecal?.indexRanges?.length !== 334) {
  throw new Error('diagnostics decal list is not the committed 334 ranges');
}
if (diagnostics.draws?.length !== render.counts.blockedDraws) {
  throw new Error('diagnostics draw count is not the committed 405 blocked draws');
}
const blocked = {
  draws: render.counts.blockedDraws,
  triangles: render.counts.blockedTriangles,
  effectDecal: {
    draws: diagnostics.groups.effectDecal.draws,
    triangles: diagnostics.groups.effectDecal.triangles,
    indexRanges: diagnostics.groups.effectDecal.indexRanges,
    treatment: 'skipped: a separate additive/alpha-tested pass is not implemented; not bound as opaque albedo',
    textureBound: false,
    fallback: 'none'
  },
  diagnosticOnly: {
    draws: diagnostics.groups.decoderSize.draws + diagnostics.groups.alphaRule.draws +
      diagnostics.groups.runtimeAlbedo.draws,
    groups: {
      decoderSize: diagnostics.groups.decoderSize.draws,
      alphaRule: diagnostics.groups.alphaRule.draws,
      runtimeAlbedo: diagnostics.groups.runtimeAlbedo.draws
    },
    treatment: 'skipped: no texture is bound and no fallback texture or colour is invented',
    textureBound: false,
    fallback: 'none'
  },
  note: 'the shared index buffer still contains every blocked range; it is only reachable through this list, never through the opaque draw list'
};

// ------------------------------------------------------------------ layout
const layoutPoints = new Float32Array(
  layoutBytes.buffer, layoutBytes.byteOffset, layoutBytes.byteLength / 4);
const pointCount = layoutPoints.length / 3;
if (pointCount !== render.layout.pointCount) throw new Error('layout point count does not match render.json');

const samples = [];
let arc = 0;
for (let index = 0; index < pointCount; index++) {
  const x = layoutPoints[index * 3];
  const z = layoutPoints[index * 3 + 1];
  const groundY = layoutPoints[index * 3 + 2];
  if (index > 0) {
    const dx = x - samples[index - 1].x;
    const dz = z - samples[index - 1].z;
    arc += Math.hypot(dx, dz);
  }
  samples.push({ x, z, groundY, arc: Math.round(arc * 1e6) / 1e6 });
}
const measuredLength = samples[samples.length - 1].arc;
const spawnPoint = samples[0];
const checkpointRecords = render.layout.checkpoints.map((checkpoint) => {
  const sample = samples[checkpoint.pointIndex];
  if (!sample) throw new Error('checkpoint ' + checkpoint.index + ' point index is out of range');
  return { index: checkpoint.index, pointIndex: checkpoint.pointIndex, sourceDistanceM: checkpoint.distanceM,
    x: sample.x, z: sample.z, arc: sample.arc, groundY: sample.groundY,
    nearestPointDeltaM: Math.hypot(checkpoint.x - sample.x, checkpoint.z - sample.z) };
});
const finishPoint = samples[render.layout.finish.pointIndex];
if (!finishPoint) throw new Error('finish point index is out of range');

/** Point on the measured polyline at an arc (linear between samples). */
function pointAtArc(value) {
  if (value <= samples[0].arc) return samples[0];
  const last = samples[samples.length - 1];
  if (value >= last.arc) return last;
  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (samples[middle].arc <= value) low = middle; else high = middle;
  }
  const a = samples[low];
  const b = samples[high];
  const span = b.arc - a.arc;
  const t = span > 0 ? (value - a.arc) / span : 0;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, arc: value };
}

const GATE_WIDTH_METRES = 6;
const GATE_HALF_WIDTH = GATE_WIDTH_METRES / 2;
const TANGENT_WINDOW_METRES = 5;

function gateAt(kind, index, id, sample) {
  const before = pointAtArc(Math.max(0, sample.arc - TANGENT_WINDOW_METRES / 2));
  const after = pointAtArc(Math.min(measuredLength, sample.arc + TANGENT_WINDOW_METRES / 2));
  const tx = after.x - before.x;
  const tz = after.z - before.z;
  const length = Math.hypot(tx, tz);
  if (!(length > 0)) throw new Error('gate ' + id + ' has no measured tangent');
  const ux = tx / length;
  const uz = tz / length;
  // b - a is the left normal of travel so the positive side is the approach side
  // (the same sign convention as the River sprint layout).
  const nx = -uz;
  const nz = ux;
  return {
    id,
    kind,
    index,
    sampleIndex: samples.indexOf(sample),
    arc: sample.arc,
    x: sample.x,
    z: sample.z,
    groundY: sample.groundY,
    headingRad: Math.atan2(ux, uz),
    tangent: { tx: ux, tz: uz, windowMetres: TANGENT_WINDOW_METRES },
    widthMetres: GATE_WIDTH_METRES,
    requestedWidthMetres: GATE_WIDTH_METRES,
    narrowed: false,
    a: [sample.x - nx * GATE_HALF_WIDTH, sample.z - nz * GATE_HALF_WIDTH],
    b: [sample.x + nx * GATE_HALF_WIDTH, sample.z + nz * GATE_HALF_WIDTH],
    coverage: {
      source: 'map-slice layout verification (measured path points, not a car-width band test)',
      coveredSamples: null,
      note: 'the gate line is derived from the measured polyline; gate-width draw/collision coverage was not measured for usa_amboy'
    }
  };
}

const gates = [
  gateAt('start', 0, 'start', spawnPoint),
  ...checkpointRecords.map((checkpoint) => gateAt('checkpoint', checkpoint.index,
    'checkpoint-' + checkpoint.index, samples[checkpoint.pointIndex])),
  gateAt('finish', checkpointRecords.length + 1, 'finish', finishPoint)
];
// The start pose uses the slice spawn heading (the first 2 m tangent). The gate
// line itself stays perpendicular to the measured 5 m tangent below.
gates[0].headingRad = render.layout.spawn.heading;

const layoutBody = {
  kind: 'e1-drive.sprint',
  version: 1,
  courseId: 'amboy',
  source: {
    map: 'amboy',
    level: 'usa_amboy',
    package: '_work/e1-drive/amboy/layout.json',
    slice: { path: PATHS.slice, bytes: sliceBytes.byteLength, sha256: 'sha256:' + sha256(sliceBytes).slice(7),
      contentHash: 'sha256:' + slice.hashes.contentSha256 },
    render: { path: PATHS.render, bytes: renderBytes.byteLength, sha256: 'sha256:' + sha256(renderBytes).slice(7),
      contentHash: 'sha256:' + render.hashes.contentSha256 },
    physics: { path: PATHS.physics, bytes: physicsBytes.byteLength,
      sha256: 'sha256:' + sha256(physicsBytes).slice(7) },
    layoutPoints: { path: '_work/map-slice/amboy-render/layout.points.f32.bin',
      bytes: layoutBytes.byteLength, sha256: 'sha256:' + sha256(layoutBytes).slice(7) },
    spawn: { x: spawnPoint.x, z: spawnPoint.z, headingRad: render.layout.spawn.heading },
    spawnSource: 'measured draw-covered path first point + the slice spawn heading (first 2 m tangent); not a retail start line',
    trackVisual: 'amboy-direct-draws',
    geometryVersion: 6
  },
  course: {
    rule: 'point-to-point measured path; the spawn is the first layout point and the finish is the last',
    name: 'usa_amboy measured draw-covered path',
    spawn: { x: spawnPoint.x, z: spawnPoint.z, ground: spawnPoint.groundY, headingRad: render.layout.spawn.heading },
    spawnGroundY: spawnPoint.groundY,
    start: { x: gates[0].x, z: gates[0].z },
    finish: { x: finishPoint.x, z: finishPoint.z },
    measuredEnd: { x: finishPoint.x, z: finishPoint.z },
    lengthMetres: measuredLength,
    finishArc: finishPoint.arc,
    sampleStepMetres: render.layout.sampleStepM,
    sampleCount: samples.length,
    span: {
      startArc: 0,
      finishArc: finishPoint.arc,
      lengthMetres: finishPoint.arc,
      measuredLengthMetres: measuredLength,
      declaredLengthMetres: render.layout.lengthM,
      finishClearanceMetres: 0,
      note: 'arcs are measured by summing the float32 layout buffer in this builder (2,060.595408 m); the declared 2,060.595 m path agrees within 2.8e-5 m'
    },
    band: {
      halfWidthMetres: 6,
      source: 'declared controller and respawn band for this measured path; usa_amboy has no measured car-width band',
      note: 'not a road-width claim'
    },
    coverage: {
      source: 'map-slice layout verification, copied read-only',
      pathCoverageOfCollisionDiameter: 0.9762,
      coveredSamples: slice.layout.verification.coveredSampleCount,
      layoutPoints: slice.layout.verification.layoutPoints,
      coveredSamplesAllPassable: slice.layout.verification.coveredSamplesAllPassable,
      note: 'draw coverage, not car-width gate coverage; see docs/work/analysis/map-slice-amboy.md'
    },
    samples
  },
  gates,
  countdown: {
    ticks: 90,
    stepTicks: 30,
    labels: ['3', '2', '1'],
    goLabel: 'GO',
    rule: 'input is held at zero until the countdown reaches GO; the timer starts at GO and the car is on the start line'
  },
  rules: {
    tickHz: 60,
    timer: 'elapsed engine ticks from GO at 1/60 s; keeps running across a respawn and freezes on the finish',
    gateOrder: 'checkpoints count only in index order; a finish crossing is rejected until every checkpoint is passed',
    finishRequiresAllCheckpoints: true,
    progress: 'progress is the arc length of the nearest point on the measured usa_amboy path, clamped to the finish arc',
    respawn: {
      fallBelowGroundMetres: 1,
      airborneTicks: 30,
      outsideBandMarginMetres: 1,
      overshootMarginMetres: 2,
      target: 'the gate point of the last passed checkpoint (the start line before the first checkpoint)',
      rule: 'respawn when the chassis falls more than 1 m below the measured ground at its arc, stays airborne for 30 ticks, or leaves the declared band; the attempt timer keeps running and the last checkpoint is kept'
    },
    limits: [
      'one point-to-point sprint on the measured usa_amboy draw-covered path, not a lap and not a retail start line',
      'the 6 m band is a declared controller/respawn band, not a measured road width',
      'gates are rules geometry only; no gate mesh is added to the render packet',
      'no Amboy prop colliders, opponents, AI or race audio'
    ]
  }
};
const layout = { ...layoutBody, hash: hashOf(layoutBody) };

// ------------------------------------------------------------------ document
const mapBody = {
  kind: 'e1-drive.map-package',
  version: 1,
  level: 'usa_amboy',
  source: {
    slice: { path: PATHS.slice, bytes: sliceBytes.byteLength, sha256: 'sha256:' + sha256(sliceBytes).slice(7),
      contentHash: 'sha256:' + slice.hashes.contentSha256 },
    render: { path: PATHS.render, bytes: renderBytes.byteLength, sha256: 'sha256:' + sha256(renderBytes).slice(7),
      contentHash: 'sha256:' + render.hashes.contentSha256 },
    diagnostics: { path: PATHS.diagnostics, bytes: diagnosticsBytes.byteLength,
      sha256: 'sha256:' + sha256(diagnosticsBytes).slice(7) },
    physics: { path: PATHS.physics, bytes: physicsBytes.byteLength,
      sha256: 'sha256:' + sha256(physicsBytes).slice(7) },
    module: { path: '_work/e1-drive/module/e1_drive.wasm', policy: 'behaviour-based; see docs/work/analysis/map-slice-module-pin-policy.md' },
    packet: '_work/map-slice/amboy-render/render.json',
    packetHash: 'sha256:' + render.hashes.contentSha256,
    packetSha256: 'sha256:' + sha256(renderBytes).slice(7)
  },
  counts: {
    draws: draws.length,
    drawTriangles: draws.reduce((sum, draw) => sum + draw.triangleCount, 0),
    textures: textures.length,
    textureBytes: textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
    vertices: vertexCount,
    indices: indexCount,
    triangles: indexCount / 3,
    blockedDraws: blocked.draws,
    blockedTriangles: blocked.triangles,
    decalDraws: blocked.effectDecal.draws,
    diagnosticDraws: blocked.diagnosticOnly.draws,
    collisionVertices: collisionVertexCount,
    collisionTriangles: collisionIndexCount / 3
  },
  meshes: [mesh],
  mapRender: {
    label: 'amboy-direct-draws',
    meshId: MESH_ID,
    drawCount: draws.length,
    triangleCount: draws.reduce((sum, draw) => sum + draw.triangleCount, 0),
    texturedDrawCount: draws.length,
    vertexCount,
    triangleTotal: indexCount / 3,
    draws,
    textures,
    sections: [],
    texturePack: {
      format: 'rgba8unorm',
      srgbVariant: 'rgba8unorm-srgb',
      srgbAppliedByProducer: false,
      mipPolicy: 'mip0 decoded; the consumer derives a full mip chain',
      sampler: 'raw sampler state recorded per texture; wrap/filter not applied by the producer',
      uniqueBlobs: textures.length,
      bytesMip0: textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0)
    },
    bounds: {
      min: [0, 1, 2].map((axis) => Math.min(...draws.map((draw) => draw.bounds.min[axis]))),
      max: [0, 1, 2].map((axis) => Math.max(...draws.map((draw) => draw.bounds.max[axis])))
    },
    collisionSurface,
    blocked,
    normals: {
      vertexNormals: 0,
      source: 'the committed direct-draw reader exports no normal stream',
      fallback: 'the existing consumer screen-space derivative normal path (cross(dpdx,dpdy) of world position)',
      note: 'no vertex normal was invented'
    },
    instances: {
      applied: false,
      descriptions: 366,
      sections: 3,
      note: 'not applied; instance-only geometry can add surfaces'
    },
    unsupportedSections: slice.draws.unsupportedSections?.length ?? 27,
    limits: [
      'direct LOD0 draws only; 27 unsupported sections and 366 instance descriptions are not applied',
      '334 effect/decal draws and 71 decoder/alpha/runtime draws are skipped with labels; no fallback texture or colour',
      'collision triangles exclude the Box, four Cylinders and the InstancedTriangleMesh',
      'spawn, checkpoints and finish are derived from the measured path, not a retail start line'
    ]
  }
};
const map = { ...mapBody, hash: hashOf(mapBody) };

const mapText = JSON.stringify(map) + '\n';
const layoutText = JSON.stringify(layout, null, 2) + '\n';

if (CHECK) {
  const currentMap = existsSync(path.join(OUT, 'map.json'))
    ? readFileSync(path.join(OUT, 'map.json'), 'utf8') : null;
  const currentLayout = existsSync(path.join(OUT, 'layout.json'))
    ? readFileSync(path.join(OUT, 'layout.json'), 'utf8') : null;
  if (currentMap !== mapText) throw new Error('_work/e1-drive/amboy/map.json is stale or hand-edited; rebuild it');
  if (currentLayout !== layoutText) throw new Error('_work/e1-drive/amboy/layout.json is stale or hand-edited; rebuild it');
  console.log(JSON.stringify({ mode: 'check', ok: true, mapHash: map.hash, layoutHash: layout.hash }, null, 2));
} else {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'map.json'), mapText, 'utf8');
  writeFileSync(path.join(OUT, 'layout.json'), layoutText, 'utf8');
  console.log(JSON.stringify({
    mode: 'build',
    map: {
      path: '_work/e1-drive/amboy/map.json',
      bytes: Buffer.byteLength(mapText),
      sha256: 'sha256:' + sha256(Buffer.from(mapText)).slice(7),
      contentHash: map.hash
    },
    layout: {
      path: '_work/e1-drive/amboy/layout.json',
      bytes: Buffer.byteLength(layoutText),
      sha256: 'sha256:' + sha256(Buffer.from(layoutText)).slice(7),
      contentHash: layout.hash
    },
    counts: map.counts,
    layoutSpan: layout.course.span,
    gates: layout.gates.map((gate) => ({ id: gate.id, arc: gate.arc, x: gate.x, z: gate.z, headingRad: gate.headingRad }))
  }, null, 2));
}
