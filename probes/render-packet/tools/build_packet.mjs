// Render packet v1.1 producer.
//
// Converts two *existing, verified* reader outputs into one packet:
//   1. level_inspect.exe --instances-all   (River block27 / node253, world-space)
//   2. scene_inspect.exe                   (Corvette C3 race body, object-local)
//
// and adds a deterministic 120-tick timeline for the vehicle.
//
// No transform, colour or material is invented here. Values are copied from the
// reader JSON, derived arithmetically from it (vertex ranges, bounds, camera fit,
// path), or declared as a placement/motion with an explicit reason.
//
// The motion is `synthetic`: a parametric circle, not physics. Nothing in this
// file integrates velocity, samples collision or claims a simulation.
//
// Usage:
//   node probes/render-packet/tools/build_packet.mjs [--out <file>]
//        [--car-placement level-center|none|x,y,z] [--ticks 120]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MATRIX_CONVENTION, cameraFromOrbit, fitVertexDistance, identity,
  multiply, rotationY, transformPoint, transformPositions, translation
} from './packet-camera.mjs';
import {
  PACKET_KIND, PACKET_VERSION, formatPacket, hashOf, packetHash, validatePacket
} from './packet-format.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LEVEL_BLOCK = 27;
const NODE_BLOCK = 253;
const FOV_Y = Math.PI / 4;
const ASPECT = 16 / 9;
const TICK_HZ = 60;
const CAMERA_PITCH = 0.3;
const CAMERA_YAW_START = 0.7;
const CAMERA_YAW_SWEEP = 0.9;

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const OUTPUT = path.resolve(ROOT, option('--out', '_work/render-packet/packet.json'));
const CAR_PLACEMENT = option('--car-placement', 'level-ground');
const TICK_COUNT = Number(option('--ticks', '120'));
if (!Number.isInteger(TICK_COUNT) || TICK_COUNT < 2 || TICK_COUNT > 6000) {
  throw new Error('--ticks must be an integer in [2, 6000]');
}

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
  return report;
}

// ---------------------------------------------------------------- geometry math

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

/** Vertex range and local AABB of one index range: derived, never guessed. */
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
    const moved = transformPoint(matrix, point);
    grow(out, moved, moved);
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
const level = runTool(LEVEL_TOOL, levelArgs);
const levelMeta = level.metadata;
if (!levelMeta.instancesApplied || levelMeta.coordinateSpace !== 'world') {
  throw new Error('level reader did not report applied instance transforms in world space');
}

const carArgs = [rel(CAR_MODEL)];
const car = runTool(SCENE_TOOL, carArgs);
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

// ------------------------------------------------------------------ synthetic path
//
// A straight run along the level's long axis, offset sideways into the open side of
// the prop row. The offset is chosen by measuring the clearance from the real
// instance AABBs, so the body does not spend the sequence inside a level prop.
// Nothing here integrates velocity or samples collision.
const levelCenter = boundsCenterRadius(levelBounds).center;
const levelBoundsMinY = levelBounds.min[1];
const tickCount = TICK_COUNT;
const lastTick = tickCount - 1;
let anchor;
let anchorName;
if (CAR_PLACEMENT === 'none') {
  anchor = [0, 0, 0];
  anchorName = 'world-origin';
} else if (CAR_PLACEMENT === 'level-ground') {
  anchor = [levelCenter[0], levelBoundsMinY, levelCenter[2]];
  anchorName = 'level-draw-bounds-ground-centre';
} else if (CAR_PLACEMENT === 'level-center') {
  anchor = levelCenter;
  anchorName = 'level-draw-bounds-centre';
} else {
  const parts = CAR_PLACEMENT.split(',').map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite)) throw new Error('--car-placement must be level-ground, level-center, none or x,y,z');
  anchor = parts;
  anchorName = 'explicit-translation';
}

function distanceToAabb(point, min, max) {
  let sum = 0;
  for (let axis = 0; axis < 3; axis++) {
    const gap = Math.max(min[axis] - point[axis], 0, point[axis] - max[axis]);
    sum += gap * gap;
  }
  return Math.sqrt(sum);
}

const halfExtent = [
  (levelBounds.max[0] - levelBounds.min[0]) / 2,
  (levelBounds.max[1] - levelBounds.min[1]) / 2,
  (levelBounds.max[2] - levelBounds.min[2]) / 2
];
// Long axis of the strip in the XZ plane, from the level's own bounds.
const axisLength = Math.hypot(halfExtent[0], halfExtent[2]);
const pathAxis = [halfExtent[0] / axisLength, 0, halfExtent[2] / axisLength];
const pathPerp = [pathAxis[2], 0, -pathAxis[0]];
const runHalfLength = 0.5 * (Math.abs(pathAxis[0]) * halfExtent[0] + Math.abs(pathAxis[2]) * halfExtent[2]);

const instanceBounds = (levelMeta.instances ?? [])
  .map((instance) => instance.worldBounds)
  .filter((bounds) => bounds && Array.isArray(bounds.min) && Array.isArray(bounds.max));

function clearanceOf(base) {
  let clearance = Infinity;
  for (let sample = 0; sample <= 24; sample++) {
    const along = (sample / 24 - 0.5) * 2 * runHalfLength;
    const point = [base[0] + pathAxis[0] * along, base[1], base[2] + pathAxis[2] * along];
    for (const bounds of instanceBounds) {
      clearance = Math.min(clearance, distanceToAabb(point, bounds.min, bounds.max));
    }
  }
  return clearance;
}

let runBase = [anchor[0], anchor[1], anchor[2]];
let lateralOffset = 0;
let clearance = clearanceOf(runBase);
for (let offset = 4; offset <= 32 && clearance < 8; offset += 4) {
  for (const sign of [1, -1]) {
    const candidate = [anchor[0] + pathPerp[0] * offset * sign, anchor[1], anchor[2] + pathPerp[2] * offset * sign];
    const candidateClearance = clearanceOf(candidate);
    if (candidateClearance > clearance) {
      clearance = candidateClearance;
      runBase = candidate;
      lateralOffset = offset * sign;
    }
  }
}
const runStart = [runBase[0] - pathAxis[0] * runHalfLength, runBase[1], runBase[2] - pathAxis[2] * runHalfLength];
const runEnd = [runBase[0] + pathAxis[0] * runHalfLength, runBase[1], runBase[2] + pathAxis[2] * runHalfLength];
const headingYaw = Math.atan2(pathAxis[0], pathAxis[2]);

const pathPosition = (tick) => {
  const t = tick / lastTick;
  return [
    runStart[0] + (runEnd[0] - runStart[0]) * t,
    runStart[1] + (runEnd[1] - runStart[1]) * t,
    runStart[2] + (runEnd[2] - runStart[2]) * t
  ];
};
const carWorldAt = (tick) => {
  const position = pathPosition(tick);
  // Column-major: translate * rotate, so the body is rotated about its own origin
  // and then moved onto the path. Heading follows the run direction.
  return multiply(translation(position[0], position[1], position[2]), rotationY(headingYaw));
};
const referenceWorld = carWorldAt(0);

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

const carDraws = [];
const carBounds = emptyBounds();
const carLocalBounds = emptyBounds();
car.draws.forEach((draw, index) => {
  const extent = drawExtent(carMesh, draw.firstIndex, draw.indexCount);
  grow(carLocalBounds, extent.localBounds.min, extent.localBounds.max);
  // Bounds describe the reference frame, which is the tick-0 path pose.
  const bounds = worldBoundsOf(extent.localBounds, referenceWorld);
  grow(carBounds, bounds.min, bounds.max);
  const hasAlbedo = draw.albedoTexture !== null && draw.albedoTexture !== undefined;
  const entry = {
    id: 'corvette.body.primitive' + index,
    meshId: carMesh.id,
    vertexOffset: extent.vertexOffset,
    vertexCount: extent.vertexCount,
    indexOffset: draw.firstIndex,
    indexCount: draw.indexCount,
    world: referenceWorld,
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
  };
  carDraws.push(entry);
  draws.push(entry);
});

const carNode = {
  id: carMesh.id,
  meshId: carMesh.id,
  drawIds: carDraws.map((draw) => draw.id),
  reason: 'single rigid vehicle body: every draw of this mesh shares one world transform in the source scene'
};

// ------------------------------------------------------------------- timeline

// Scene bounds must cover every tick, not only the reference frame: the camera
// fit and the far plane are fixed for the whole sequence.
const sceneBounds = emptyBounds();
grow(sceneBounds, levelBounds.min, levelBounds.max);
for (let tick = 0; tick <= lastTick; tick += 5) {
  const bounds = worldBoundsOf(carLocalBounds, carWorldAt(tick));
  grow(sceneBounds, bounds.min, bounds.max);
}
const { center, radius } = boundsCenterRadius(sceneBounds);
if (!(radius > 0)) throw new Error('scene bounds have no spatial extent');

const cameraYawAt = (tick) => CAMERA_YAW_START + (CAMERA_YAW_SWEEP * tick) / lastTick;

// One distance for the whole sequence, fitted at sampled ticks so the level never
// leaves the frame while the camera sweeps.
let distance = 0;
for (let tick = 0; tick <= lastTick; tick += 10) {
  const world = carWorldAt(tick);
  const carWorldPositions = transformPositions(carMesh.positions, world);
  distance = Math.max(
    distance,
    fitVertexDistance([levelMesh.positions, carWorldPositions], center, cameraYawAt(tick), CAMERA_PITCH, FOV_Y, ASPECT, 1.06)
  );
}
const near = Math.max(0.05, distance * 0.002);
const far = distance + radius * 2 + 64;

const cameraAt = (tick) => {
  const yaw = cameraYawAt(tick);
  const built = cameraFromOrbit({
    target: center, distance, yaw, pitch: CAMERA_PITCH,
    near, far, verticalFovRadians: FOV_Y, aspect: ASPECT
  });
  return {
    mode: 'orbit',
    position: built.position,
    target: center,
    up: [0, 1, 0],
    view: built.view,
    projection: built.projection,
    near,
    far,
    verticalFovRadians: FOV_Y,
    aspect: ASPECT,
    matrixConvention: MATRIX_CONVENTION,
    orbit: { yaw, pitch: CAMERA_PITCH, distance }
  };
};

const updates = [];
let travel = 0;
let previousPosition = pathPosition(0);
for (let tick = 0; tick <= lastTick; tick++) {
  const position = pathPosition(tick);
  if (tick > 0) travel += Math.hypot(position[0] - previousPosition[0], position[1] - previousPosition[1], position[2] - previousPosition[2]);
  previousPosition = position;
  const world = carWorldAt(tick);
  const update = {
    tick,
    // Producer-declared alpha for a tick-exact frame. A live fixed-step driver
    // replaces this with its own scheduler alpha (design §4.3).
    alpha: 0,
    camera: cameraAt(tick),
    matrices: [{ nodeId: carNode.id, world }]
  };
  update.hash = hashOf(update);
  updates.push(update);
}

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
    version: '1.1.0',
    producers: [
      { id: 'level', tool: 'level_inspect.exe', args: levelArgs, outputSha256: sha256Text(JSON.stringify(level)) },
      { id: 'car', tool: 'scene_inspect.exe', args: carArgs, outputSha256: sha256Text(JSON.stringify(car)) }
    ]
  },
  tick: 0,
  alpha: 0,
  tickDurationSeconds: 1 / TICK_HZ,
  camera: updates[0].camera,
  lights: [{
    id: 'diagnostic-key',
    type: 'directional',
    direction: [0.4, 0.8, 0.6].map((value) => value / Math.hypot(0.4, 0.8, 0.6)),
    colour: [1, 1, 1, 1],
    intensity: 1,
    source: 'diagnostic: no original level or vehicle light is recovered by this spike'
  }],
  meshes: [levelMesh, carMesh],
  materials: carMaterials,
  draws,
  placedObjects: CAR_PLACEMENT === 'none' ? [] : [{
    meshId: carMesh.id,
    placement: 'synthetic-path-start',
    world: referenceWorld,
    reason:
      'the engine vehicle spawn transform is not recovered; the synthetic path is anchored at ' + anchorName +
      ' (centre of the level draw bounds, a presentation anchor, not a game spawn point) and tick 0 is the path start'
  }],
  nodes: [carNode],
  updates,
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
    scope:
      'River block27/node253 supported instances plus the Corvette C3 race body (first resource block, first render list, LOD0); ' +
      'world transforms are the reader-reported affine g_mWorld, materials and lighting are diagnostic',
    sequence: {
      tickCount,
      tickHz: TICK_HZ,
      motion: 'synthetic',
      motionReason:
        'parametric straight run generated by the producer tool; no velocity integration, no collision, no physics step and no engine tick ran',
      alphaSource: 'per-tick alpha is 0 (tick-exact); the consumer supplies its own fixed-step alpha',
      nodeIds: [carNode.id],
      staticDrawCount: draws.length - carDraws.length,
      movedDrawCount: carDraws.length,
      path: {
        kind: 'straight-run',
        anchor,
        anchorName,
        lateralOffsetMetres: Number(lateralOffset.toFixed(3)),
        clearanceMetres: Number((Number.isFinite(clearance) ? clearance : 0).toFixed(3)),
        start: runStart,
        end: runEnd,
        lengthMetres: Number((runHalfLength * 2).toFixed(3)),
        headingRad: headingYaw,
        travelMetres: Number(travel.toFixed(4))
      },
      cameraMotion: {
        kind: 'orbit-yaw-sweep',
        yawStartRad: CAMERA_YAW_START,
        yawSweepRad: CAMERA_YAW_SWEEP,
        pitchRad: CAMERA_PITCH,
        distanceMetres: Number(distance.toFixed(6))
      },
      firstTickHash: updates[0].hash,
      lastTickHash: updates[lastTick].hash
    },
    approximations: [
      'level and vehicle materials are not applied; every draw is shaded with a neutral albedo under one directional light',
      'no shadow, post-process, particle or effect pass exists in this consumer',
      'face normals come from screen-space derivatives of the world position, not from original vertex normals',
      'the vehicle is placed at a declared presentation anchor because no spawn transform is recovered',
      'vehicle motion is a synthetic parametric path, not physics'
    ],
    notRecovered: [
      'level material list to shader binding',
      'original level and vehicle lighting rigs',
      'vehicle paint lookup texture and runtime light blends',
      'higher LODs, damage states and wheel placement',
      'level blocks 26, 32 and 31 instances (cross-chunk grouping and ChunkInfo prerequisites)'
    ],
    limits: [
      'packet v1.1 is JSON with inline geometry; it is not an engine integration',
      'v1.1 defines directional lights only and carries no texture pixels',
      'the timeline is generated by a tool, not by the wasm engine tick loop',
      'interpolation requires rigid per-tick matrices; scale and shear are rejected'
    ]
  }
};
packet.hash = packetHash(packet);

// Conformance is checked before the file is trusted as an input to anything else.
const validation = validatePacket(packet);
if (!validation.ok) {
  console.error('packet conformance failed:\n  ' + validation.errors.slice(0, 20).join('\n  '));
  process.exitCode = 1;
}

const directory = path.dirname(OUTPUT);
mkdirSync(directory, { recursive: true });
const text = formatPacket(packet);
if (validation.ok) writeFileSync(OUTPUT, text, 'utf8');

const bytes = Buffer.byteLength(text, 'utf8');
const report = {
  packet: rel(OUTPUT),
  version: packet.version,
  hash: packet.hash,
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
    placement: 'synthetic-path-start'
  },
  sequence: {
    tickCount,
    tickHz: TICK_HZ,
    movedDraws: carDraws.length,
    staticDraws: draws.length - carDraws.length,
    travelMetres: Number(travel.toFixed(4)),
    firstTickHash: updates[0].hash,
    lastTickHash: updates[lastTick].hash
  },
  camera: { distance: Number(distance.toFixed(4)), near: Number(near.toFixed(6)), far: Number(far.toFixed(4)), aspect: ASPECT },
  validation
};
writeFileSync(path.join(directory, 'packet.report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
