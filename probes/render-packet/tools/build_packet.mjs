// Render packet v1 producer.
//
// Converts two *existing, verified* reader outputs into one packet:
//   1. level_inspect.exe --instances-all   (River block27 / node253, world-space)
//   2. scene_inspect.exe                   (Corvette C3 race body, object-local)
//
// No transform, colour or material is invented here. Values are copied from the
// reader JSON, derived arithmetically from it (vertex ranges, bounds, camera fit)
// or declared as a placement with an explicit reason.
//
// Usage: node probes/render-packet/tools/build_packet.mjs [--out <file>] [--car-placement level-center|none|x,y,z]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKET_KIND, PACKET_VERSION, MATRIX_CONVENTION, formatPacket, packetHash, validatePacket } from './packet-format.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LEVEL_BLOCK = 27;
const NODE_BLOCK = 253;
const FOV_Y = Math.PI / 4;
const YAW = 0.7;
const PITCH = 0.3;

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const OUTPUT = path.resolve(ROOT, option('--out', '_work/render-packet/packet.json'));
const CAR_PLACEMENT = option('--car-placement', 'level-center');

const rel = (absolute) => path.relative(ROOT, absolute).split(path.sep).join('/');
const requireFile = (absolute, hint) => {
  if (!existsSync(absolute)) throw new Error('missing input ' + rel(absolute) + ' — ' + hint);
  return absolute;
};
const sha256 = (buffer) => 'sha256:' + createHash('sha256').update(buffer).digest('hex');
const sha256Text = (text) => sha256(Buffer.from(text, 'utf8'));

const LEVEL_RENDER = requireFile(
  path.join(ROOT, 'game-data/Blur/levels/usa_la_river/level.levelrender'),
  'the retail River level is a read-only reference and must be installed.');
const GEOMETRY_CHUNK = requireFile(
  path.join(ROOT, '_work/level-instances/instance-geometry.chunk'),
  'run `node probes/asset-reader/tests/verify_instances_wasm.mjs` once to materialise the block27 chunk.');
const NODE_CHUNK = requireFile(
  path.join(ROOT, '_work/level-instances/instance-node.chunk'),
  'run `node probes/asset-reader/tests/verify_instances_wasm.mjs` once to materialise the node253 chunk.');
const CAR_MODEL = requireFile(
  path.join(ROOT, '_work/car-level-assets/corvette_c3_race.model.decoded'),
  'run `python tools/inspect_car_level_assets.py` once to decode the Corvette model.');
const LEVEL_TOOL = requireFile(
  path.join(ROOT, '_work/build/asset-reader-native/Release/level_inspect.exe'),
  'run `python tools/build_asset_probe.py` to build the native readers.');
const SCENE_TOOL = requireFile(
  path.join(ROOT, '_work/build/asset-reader-native/Release/scene_inspect.exe'),
  'run `python tools/build_asset_probe.py` to build the native readers.');

function runTool(tool, toolArgs) {
  const stdout = execFileSync(tool, toolArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const report = JSON.parse(stdout);
  if (report.status !== 'ok') throw new Error(rel(tool) + ' returned status ' + report.status);
  return { report, stdout };
}

// ---------------------------------------------------------------- geometry math

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function translation(x, y, z) {
  const matrix = identity();
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return matrix;
}
/** Column-major a*b, matching the shader's mat4x4f * vec4f. */
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}
function transformPoint(matrix, point) {
  return [
    point[0] * matrix[0] + point[1] * matrix[4] + point[2] * matrix[8] + matrix[12],
    point[0] * matrix[1] + point[1] * matrix[5] + point[2] * matrix[9] + matrix[13],
    point[0] * matrix[2] + point[1] * matrix[6] + point[2] * matrix[10] + matrix[14]
  ];
}
const normalize = (vector) => {
  const length = Math.hypot(...vector);
  if (!(length > 0)) throw new Error('cannot normalise a zero-length vector');
  return vector.map((value) => value / length);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Right-handed orbit view with the same layout mesh-viewer.js already ships. */
function orbitView(target, distance, yaw, pitch) {
  const z = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
  const eye = [target[0] + distance * z[0], target[1] + distance * z[1], target[2] + distance * z[2]];
  const x = normalize([z[2], 0, -z[0]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const view = [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
  ];
  return { view, eye };
}
function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (near * far) / (near - far), 0
  ];
}

/**
 * Tight orbit distance: the smallest distance at which every given vertex stays
 * inside the frustum for the chosen yaw/pitch. This is the same projection test
 * mesh-viewer.js uses, measured from a real target instead of the origin.
 */
function fitVertexDistance(positionArrays, target, yaw, pitch, fovY, aspect, margin) {
  const z = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
  const x = normalize([z[2], 0, -z[0]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const slopeY = Math.tan(fovY / 2);
  const slopeX = slopeY * aspect;
  let distance = 1e-3;
  for (const positions of positionArrays) {
    for (let index = 0; index < positions.length; index += 3) {
      const vx = positions[index] - target[0];
      const vy = positions[index + 1] - target[1];
      const vz = positions[index + 2] - target[2];
      const depth = x[0] * vx + x[1] * vy + x[2] * vz;
      const up = y[0] * vx + y[1] * vy + y[2] * vz;
      const along = z[0] * vx + z[1] * vy + z[2] * vz;
      distance = Math.max(
        distance,
        along + Math.abs(depth) / slopeX,
        along + Math.abs(up) / slopeY,
        along + 0.05
      );
    }
  }
  return distance * margin;
}
const emptyBounds = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
function grow(bounds, min, max) {
  for (let axis = 0; axis < 3; axis++) {
    bounds.min[axis] = Math.min(bounds.min[axis], min[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], max[axis]);
  }
}
function boundsCenterRadius(bounds) {
  const center = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) center[axis] = (bounds.min[axis] + bounds.max[axis]) / 2;
  const radius = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) / 2;
  return { center, radius };
}

// -------------------------------------------------------------- draw extraction

/** Vertex range and local AABB of one index range: everything is derived, nothing guessed. */
function drawExtent(mesh, firstIndex, indexCount) {
  const { positions, indices, vertexCount } = mesh;
  let minIndex = Infinity, maxIndex = -Infinity;
  const bounds = emptyBounds();
  for (let offset = firstIndex; offset < firstIndex + indexCount; offset++) {
    const vertex = indices[offset];
    if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= vertexCount) {
      throw new Error('index ' + vertex + ' outside mesh at offset ' + offset);
    }
    if (vertex < minIndex) minIndex = vertex;
    if (vertex > maxIndex) maxIndex = vertex;
    const base = vertex * 3;
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[base + axis];
      if (!Number.isFinite(value)) throw new Error('non-finite position at vertex ' + vertex);
      if (value < bounds.min[axis]) bounds.min[axis] = value;
      if (value > bounds.max[axis]) bounds.max[axis] = value;
    }
  }
  return { vertexOffset: minIndex, vertexCount: maxIndex - minIndex + 1, localBounds: bounds };
}
/** AABB of an AABB under an affine matrix: transform the eight corners. */
function worldBoundsOf(bounds, matrix) {
  const out = emptyBounds();
  for (let corner = 0; corner < 8; corner++) {
    const point = [
      (corner & 1 ? bounds.max : bounds.min)[0],
      (corner & 2 ? bounds.max : bounds.min)[1],
      (corner & 4 ? bounds.max : bounds.min)[2]
    ];
    grow(out, transformPoint(matrix, point), transformPoint(matrix, point));
  }
  return out;
}

function meshHashes(mesh) {
  const positionBuffer = Buffer.alloc(mesh.positions.length * 4);
  mesh.positions.forEach((value, index) => positionBuffer.writeFloatLE(value, index * 4));
  const indexBuffer = Buffer.alloc(mesh.indices.length * 4);
  mesh.indices.forEach((value, index) => indexBuffer.writeUInt32LE(value, index * 4));
  return { positionsSha256: sha256(positionBuffer), indicesSha256: sha256(indexBuffer) };
}

// ------------------------------------------------------------------- producers

const levelArgs = [
  '--instances-all',
  rel(LEVEL_RENDER), rel(GEOMETRY_CHUNK), rel(NODE_CHUNK),
  String(LEVEL_BLOCK), String(NODE_BLOCK)
];
const level = runTool(LEVEL_TOOL, levelArgs).report;
const levelMeta = level.metadata;
if (!levelMeta.instancesApplied || levelMeta.coordinateSpace !== 'world') {
  throw new Error('level reader did not report applied instance transforms in world space');
}

const carArgs = [rel(CAR_MODEL)];
const car = runTool(SCENE_TOOL, carArgs).report;
if (car.metadata.coordinateSpace !== 'object-local') {
  throw new Error('car reader reported an unexpected coordinate space: ' + car.metadata.coordinateSpace);
}

const levelMesh = {
  id: 'river.block27.instances-all',
  storage: 'inline-json',
  vertexCount: level.positions.length / 3,
  indexCount: level.indices.length,
  positions: level.positions,
  indices: level.indices,
  coordinateSpace: 'world',
  source: {
    tool: 'level_inspect.exe',
    args: levelArgs,
    status: level.status,
    geometryBlock: levelMeta.geometryBlock,
    nodeBlock: levelMeta.nodeBlock,
    geometryChunkIndex: levelMeta.geometryChunkIndex,
    geometryItemIndex: levelMeta.geometryItemIndex,
    nodeChunkIndex: levelMeta.nodeChunkIndex,
    geometryStreamOffset: levelMeta.geometryStreamOffset,
    nodeStreamOffset: levelMeta.nodeStreamOffset,
    instancesApplied: levelMeta.instancesApplied,
    nodeTransformsApplied: levelMeta.nodeTransformsApplied,
    instanceCount: levelMeta.instanceCount,
    emittedInstanceCount: levelMeta.emittedInstanceCount,
    omittedOtherBlockInstances: levelMeta.omittedOtherBlockInstances,
    unsupportedBoundsInstances: levelMeta.unsupportedBoundsInstances,
    boundsMaxAbsoluteDifference: levelMeta.boundsMaxAbsoluteDifference,
    matrixSemantics: levelMeta.matrixSemantics
  }
};
Object.assign(levelMesh, meshHashes(levelMesh));

const carMesh = {
  id: 'corvette.c3.race.body',
  storage: 'inline-json',
  vertexCount: car.positions.length / 3,
  indexCount: car.indices.length,
  positions: car.positions,
  indices: car.indices,
  coordinateSpace: 'object-local',
  source: {
    tool: 'scene_inspect.exe',
    args: carArgs,
    status: car.status,
    resourceBlock: car.metadata.resourceBlock,
    nodeIndex: car.metadata.nodeIndex,
    primitiveCount: car.metadata.primitiveCount,
    partialSceneTraversal: car.metadata.partialSceneTraversal,
    nodeTransformsApplied: car.metadata.nodeTransformsApplied,
    runtimeMaterialsApplied: car.metadata.runtimeMaterialsApplied,
    parsedUntilOffset: car.metadata.parsedUntilOffset,
    scope: car.metadata.scope
  }
};
Object.assign(carMesh, meshHashes(carMesh));

// Level draws: the reader already baked each instance's affine g_mWorld into the
// vertex positions, so `world` is identity and `worldKind` says so explicitly.
const levelBounds = emptyBounds();
const draws = level.draws.map((draw) => {
  const extent = drawExtent(levelMesh, draw.firstIndex, draw.indexCount);
  const bounds = worldBoundsOf(extent.localBounds, identity());
  grow(levelBounds, bounds.min, bounds.max);
  return {
    id: 'river.block27.instance' + draw.instanceIndex + '.primitive' + draw.basePrimitiveIndex,
    meshId: levelMesh.id,
    vertexOffset: extent.vertexOffset,
    vertexCount: extent.vertexCount,
    indexOffset: draw.firstIndex,
    indexCount: draw.indexCount,
    world: identity(),
    worldKind: 'baked-into-mesh',
    materialId: null,
    materialReason:
      'level material list is decoded but not applied by the asset reader (' + draw.binding + '); ' +
      'no colour or texture is assigned by this packet',
    layer: 'opaque',
    bounds,
    source: {
      tool: 'level_inspect.exe',
      instanceIndex: draw.instanceIndex,
      basePrimitiveIndex: draw.basePrimitiveIndex,
      geometryBlock: levelMeta.geometryBlock,
      nodeBlock: levelMeta.nodeBlock,
      archivedInstanceBounds: levelMeta.instances[draw.instanceIndex]?.archivedInstanceBounds ?? null,
      instanceMatrix: levelMeta.instances[draw.instanceIndex]?.matrix ?? null
    }
  };
});

// Car placement: the engine spawn transform is not in scope, so the packet states
// the placement it chose and why. `level-center` uses the level draw-bounds centre
// derived from real geometry; it is a presentation anchor, not a game spawn.
const levelCenter = boundsCenterRadius(levelBounds).center;
let carWorld;
let carPlacementName;
if (CAR_PLACEMENT === 'none') {
  carWorld = identity();
  carPlacementName = 'identity';
} else if (CAR_PLACEMENT === 'level-center') {
  carWorld = translation(levelCenter[0], levelCenter[1], levelCenter[2]);
  carPlacementName = 'level-draw-bounds-center';
} else {
  const parts = CAR_PLACEMENT.split(',').map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite)) throw new Error('--car-placement must be level-center, none or x,y,z');
  carWorld = translation(parts[0], parts[1], parts[2]);
  carPlacementName = 'explicit-translation';
}

const carMaterials = [];
const carMaterialIds = [];
for (const draw of car.draws) {
  if (draw.albedoTexture === null || draw.albedoTexture === undefined) continue;
  if (carMaterialIds.includes(draw.albedoTexture)) continue;
  carMaterialIds.push(draw.albedoTexture);
  carMaterials.push({
    id: 'corvette.albedo.sharedTexture.' + draw.albedoTexture,
    albedoTextureIndex: draw.albedoTexture,
    pixelsIncluded: false,
    source:
      'scene_inspect.exe: shared texture index ' + draw.albedoTexture +
      ' bound through ordered instance/base/stream materials; packet v1 carries no texture pixels'
  });
}

const carBounds = emptyBounds();
car.draws.forEach((draw, index) => {
  const extent = drawExtent(carMesh, draw.firstIndex, draw.indexCount);
  const bounds = worldBoundsOf(extent.localBounds, carWorld);
  grow(carBounds, bounds.min, bounds.max);
  const hasAlbedo = draw.albedoTexture !== null && draw.albedoTexture !== undefined;
  draws.push({
    id: 'corvette.body.primitive' + index,
    meshId: carMesh.id,
    vertexOffset: extent.vertexOffset,
    vertexCount: extent.vertexCount,
    indexOffset: draw.firstIndex,
    indexCount: draw.indexCount,
    world: carWorld,
    worldKind: 'packet-transform',
    materialId: hasAlbedo ? 'corvette.albedo.sharedTexture.' + draw.albedoTexture : null,
    materialReason: hasAlbedo
      ? 'original shared albedo image index resolved; packet v1 carries material identity only, so no texture pixels are bound'
      : 'no albedo image for this draw: ' + draw.binding,
    layer: 'opaque',
    bounds,
    source: {
      tool: 'scene_inspect.exe',
      instanceIndex: null,
      basePrimitiveIndex: index,
      albedoTexture: draw.albedoTexture ?? null,
      binding: draw.binding
    }
  });
});

// ---------------------------------------------------------------------- camera

const sceneBounds = emptyBounds();
grow(sceneBounds, levelBounds.min, levelBounds.max);
grow(sceneBounds, carBounds.min, carBounds.max);
const { center, radius } = boundsCenterRadius(sceneBounds);
if (!(radius > 0)) throw new Error('scene bounds have no spatial extent');
const aspect = 16 / 9;
// The car mesh is object-local, so it must be fitted in its placed world position.
const carWorldPositions = new Float64Array(carMesh.positions.length);
for (let index = 0; index < carMesh.positions.length; index += 3) {
  carWorldPositions[index] = carMesh.positions[index] + carWorld[12];
  carWorldPositions[index + 1] = carMesh.positions[index + 1] + carWorld[13];
  carWorldPositions[index + 2] = carMesh.positions[index + 2] + carWorld[14];
}
const distance = fitVertexDistance([levelMesh.positions, carWorldPositions], center, YAW, PITCH, FOV_Y, aspect, 1.05);
const { view, eye } = orbitView(center, distance, YAW, PITCH);
const near = Math.max(0.05, distance * 0.002);
const far = distance + radius * 2 + 64;
const projection = perspective(FOV_Y, aspect, near, far);

// ------------------------------------------------------------------ diagnostics

let vertexTotal = 0;
let triangleTotal = 0;
for (const mesh of [levelMesh, carMesh]) {
  vertexTotal += mesh.vertexCount;
  triangleTotal += mesh.indexCount / 3;
}

const packet = {
  kind: PACKET_KIND,
  version: PACKET_VERSION,
  generator: {
    name: 'blur-e1-render-packet-spike',
    version: '1.0.0',
    producers: [
      { id: 'level', tool: 'level_inspect.exe', args: levelArgs, outputSha256: sha256Text(JSON.stringify(level)) },
      { id: 'car', tool: 'scene_inspect.exe', args: carArgs, outputSha256: sha256Text(JSON.stringify(car)) }
    ]
  },
  tick: 0,
  alpha: 0,
  camera: {
    mode: 'orbit',
    position: eye,
    target: center,
    up: [0, 1, 0],
    view,
    projection,
    near,
    far,
    verticalFovRadians: FOV_Y,
    aspect,
    matrixConvention: MATRIX_CONVENTION
  },
  lights: [{
    id: 'diagnostic-key',
    type: 'directional',
    direction: normalize([0.4, 0.8, 0.6]),
    colour: [1, 1, 1, 1],
    intensity: 1,
    source: 'diagnostic: no original level or vehicle light is recovered by this spike'
  }],
  meshes: [levelMesh, carMesh],
  materials: carMaterials,
  draws,
  placedObjects: CAR_PLACEMENT === 'none' ? [] : [{
    meshId: carMesh.id,
    placement: carPlacementName,
    world: carWorld,
    reason:
      'the engine vehicle spawn transform is not recovered; the placement is a presentation anchor ' +
      '(centre of the level draw bounds) recorded so the choice is auditable, not a game spawn point'
  }],
  diagnostics: {
    drawCount: draws.length,
    meshCount: 2,
    vertexTotal,
    triangleTotal,
    instancesEmitted: levelMeta.emittedInstanceCount,
    instancesOmitted: levelMeta.omittedOtherBlockInstances,
    culled: 0,
    materialsApplied: false,
    lighting: 'diagnostic-directional',
    approximations: [
      'level and vehicle materials are not applied; every draw is shaded with a neutral albedo under one directional light',
      'no shadow, post-process, particle or effect pass exists in this consumer',
      'face normals come from screen-space derivatives of the world position, not from original vertex normals',
      'the vehicle is placed at a declared presentation anchor because no spawn transform is recovered'
    ],
    notRecovered: [
      'level material list to shader binding',
      'original level and vehicle lighting rigs',
      'vehicle paint lookup texture and runtime light blends',
      'higher LODs, damage states and wheel placement',
      'level blocks 26, 32 and 31 instances (cross-chunk grouping and ChunkInfo prerequisites)'
    ],
    limits: [
      'packet v1 is JSON with inline geometry; it is not an engine integration',
      'v1 defines directional lights only and carries no texture pixels',
      'this packet is a spike fixture, not a product of the wasm engine tick loop'
    ],
    scope:
      'River block27/node253 supported instances plus the Corvette C3 race body (first resource block, first render list, LOD0); ' +
      'world transforms are the reader-reported affine g_mWorld, materials and lighting are diagnostic'
  }
};
packet.hash = packetHash(packet);

// Conformance is checked before the file is trusted as an input to anything else.
const validation = validatePacket(packet);
if (!validation.ok) {
  console.error('packet conformance failed:\n  ' + validation.errors.join('\n  '));
  process.exitCode = 1;
}

const directory = path.dirname(OUTPUT);
mkdirSync(directory, { recursive: true });
const text = formatPacket(packet);
if (validation.ok) writeFileSync(OUTPUT, text, 'utf8');

const bytes = Buffer.byteLength(text, 'utf8');
const report = {
  packet: rel(OUTPUT),
  hash: packet.hash,
  canonicalBodySha256: packetHash(packet).slice('sha256:'.length),
  bytes,
  draws: packet.diagnostics.drawCount,
  meshes: packet.diagnostics.meshCount,
  vertexTotal,
  triangleTotal,
  level: {
    vertices: levelMesh.vertexCount,
    triangles: levelMesh.indexCount / 3,
    draws: level.draws.length,
    instancesEmitted: levelMeta.emittedInstanceCount,
    instancesOmitted: levelMeta.omittedOtherBlockInstances,
    boundsMaxAbsoluteDifference: levelMeta.boundsMaxAbsoluteDifference
  },
  car: {
    vertices: carMesh.vertexCount,
    triangles: carMesh.indexCount / 3,
    draws: car.draws.length,
    materials: carMaterials.length,
    placement: carPlacementName
  },
  camera: { position: eye.map((value) => Number(value.toFixed(4))), target: center.map((value) => Number(value.toFixed(4))), distance: Number(distance.toFixed(4)), near, far, aspect },
  validation
};
writeFileSync(path.join(directory, 'packet.report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
