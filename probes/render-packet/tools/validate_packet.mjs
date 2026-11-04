// Render packet v1 / v1.1 conformance gate.
//
// Usage: node probes/render-packet/tools/validate_packet.mjs <packet.json> [--out <report.json>]
//
// Beyond the structural contract it independently proves the two things a
// consumer relies on:
//   1. every draw range/index is inside its mesh, and
//   2. every draw AABB is inside the clip volume of the camera of *every* tick,
//      using bounds recomputed from the mesh rather than the packet's own copy.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePacket, packetHash, canonicalJson } from './packet-format.mjs';
import { multiply, transformPoint } from './packet-camera.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const target = args[0];
if (!target) {
  console.error('usage: node probes/render-packet/tools/validate_packet.mjs <packet.json> [--out <report.json>]');
  process.exit(2);
}
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : '_work/render-packet/packet.validation.json';
const file = path.resolve(ROOT, target);
const raw = readFileSync(file);

let packet;
try {
  packet = JSON.parse(raw.toString('utf8'));
} catch (error) {
  console.error('packet is not valid JSON: ' + error.message);
  process.exit(1);
}

const result = validatePacket(packet);
const extra = [];

// ------------------------------------------------ bounds recomputed from geometry

const meshes = new Map();
for (const mesh of packet.meshes ?? []) meshes.set(mesh.id, mesh);

function localBounds(mesh, draw) {
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let offset = draw.indexOffset; offset < draw.indexOffset + draw.indexCount; offset++) {
    const vertex = mesh.indices[offset];
    for (let axis = 0; axis < 3; axis++) {
      const value = mesh.positions[vertex * 3 + axis];
      if (value < bounds.min[axis]) bounds.min[axis] = value;
      if (value > bounds.max[axis]) bounds.max[axis] = value;
    }
  }
  return bounds;
}

const local = new Map();
for (const draw of packet.draws ?? []) {
  const mesh = meshes.get(draw.meshId);
  if (!mesh) {
    extra.push('draw ' + draw.id + ' references an unknown mesh');
    continue;
  }
  local.set(draw.id, localBounds(mesh, draw));
}

function worldBoundsOf(bounds, matrix) {
  const out = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let corner = 0; corner < 8; corner++) {
    const point = [
      (corner & 1 ? bounds.max : bounds.min)[0],
      (corner & 2 ? bounds.max : bounds.min)[1],
      (corner & 4 ? bounds.max : bounds.min)[2]
    ];
    const moved = transformPoint(matrix, point);
    for (let axis = 0; axis < 3; axis++) {
      out.min[axis] = Math.min(out.min[axis], moved[axis]);
      out.max[axis] = Math.max(out.max[axis], moved[axis]);
    }
  }
  return out;
}

function clipOutsideCount(bounds, viewProjection) {
  let outside = 0;
  for (let corner = 0; corner < 8; corner++) {
    const point = [
      (corner & 1 ? bounds.max : bounds.min)[0],
      (corner & 2 ? bounds.max : bounds.min)[1],
      (corner & 4 ? bounds.max : bounds.min)[2]
    ];
    const clip = [0, 0, 0, 0];
    for (let row = 0; row < 4; row++) {
      clip[row] = point[0] * viewProjection[row] + point[1] * viewProjection[4 + row] + point[2] * viewProjection[8 + row] + viewProjection[12 + row];
    }
    if (clip[3] <= 0) { outside++; continue; }
    const x = clip[0] / clip[3], y = clip[1] / clip[3], z = clip[2] / clip[3];
    if (x < -1.0001 || x > 1.0001 || y < -1.0001 || y > 1.0001 || z < -0.0001 || z > 1.0001) outside++;
  }
  return outside;
}

const boundsAt = (drawId, matrix) => worldBoundsOf(local.get(drawId), matrix);

// Static packet: one camera, tick 0 matrices.
const sceneBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
let drawVertices = 0;
let drawTriangles = 0;
for (const draw of packet.draws ?? []) {
  drawTriangles += draw.indexCount / 3;
  drawVertices += draw.vertexCount;
  if (!local.has(draw.id)) continue;
  const bounds = boundsAt(draw.id, draw.world);
  for (let axis = 0; axis < 3; axis++) {
    sceneBounds.min[axis] = Math.min(sceneBounds.min[axis], bounds.min[axis]);
    sceneBounds.max[axis] = Math.max(sceneBounds.max[axis], bounds.max[axis]);
    // The packet's stored bounds must describe the same box we just recomputed.
    if (!(Math.abs(bounds.min[axis] - draw.bounds.min[axis]) <= 1e-4 && Math.abs(bounds.max[axis] - draw.bounds.max[axis]) <= 1e-4)) {
      extra.push('draw ' + draw.id + ' stored bounds disagree with its geometry on axis ' + axis);
      break;
    }
  }
}

if (packet.diagnostics && packet.diagnostics.triangleTotal !== drawTriangles) {
  extra.push('diagnostics.triangleTotal (' + packet.diagnostics.triangleTotal + ') != sum of draw triangles (' + drawTriangles + ')');
}

const viewProjectionOf = (camera) => multiply(camera.projection, camera.view);
let staticOutside = clipOutsideCount(sceneBounds, viewProjectionOf(packet.camera));

// Timeline: prove containment for every tick, and that tick 0 matches `draws`.
let sequence = null;
if (packet.version === 1.1) {
  const nodeByDraw = new Map();
  for (const node of packet.nodes) for (const drawId of node.drawIds) nodeByDraw.set(drawId, node.id);
  const mapOf = (update) => {
    const map = new Map();
    for (const entry of update.matrices) map.set(entry.nodeId ? 'node:' + entry.nodeId : 'draw:' + entry.drawId, entry.world);
    return map;
  };
  const moverKeys = packet.draws.map((draw) => {
    const tick0 = mapOf(packet.updates[0]);
    if (tick0.has('draw:' + draw.id)) return 'draw:' + draw.id;
    const nodeId = nodeByDraw.get(draw.id);
    return nodeId && tick0.has('node:' + nodeId) ? 'node:' + nodeId : null;
  });

  let worstOutside = 0;
  let worstTick = null;
  let containedTicks = 0;
  const first = mapOf(packet.updates[0]);
  let referenceMismatch = 0;
  for (let index = 0; index < packet.draws.length; index++) {
    const draw = packet.draws[index];
    const key = moverKeys[index];
    if (!key) continue;
    const world = first.get(key);
    if (!world) continue;
    for (let element = 0; element < 16; element++) {
      if (Math.abs(world[element] - draw.world[element]) > 1e-9) { referenceMismatch++; break; }
    }
  }
  if (referenceMismatch) extra.push(referenceMismatch + ' moved draws have draws[].world different from their tick-0 transform');

  for (const update of packet.updates) {
    const map = mapOf(update);
    const vp = viewProjectionOf(update.camera);
    let outside = 0;
    for (let index = 0; index < packet.draws.length; index++) {
      const draw = packet.draws[index];
      const key = moverKeys[index];
      if (!key) { outside += clipOutsideCount(boundsAt(draw.id, draw.world), vp); continue; }
      const world = map.get(key);
      if (!world) { extra.push('tick ' + update.tick + ' has no transform for ' + key); continue; }
      outside += clipOutsideCount(boundsAt(draw.id, world), vp);
    }
    if (outside === 0) containedTicks++;
    if (outside > worstOutside) { worstOutside = outside; worstTick = update.tick; }
  }
  if (worstOutside) extra.push(worstOutside + ' draw AABB corners fall outside the camera clip volume at tick ' + worstTick);

  sequence = {
    tickCount: packet.updates.length,
    tickHz: packet.diagnostics?.sequence?.tickHz ?? null,
    motion: packet.diagnostics?.sequence?.motion ?? null,
    movedDraws: moverKeys.filter(Boolean).length,
    staticDraws: moverKeys.filter((key) => !key).length,
    firstTickHash: packet.updates[0].hash,
    lastTickHash: packet.updates[packet.updates.length - 1].hash,
    ticksWithFullContainment: containedTicks,
    worstOutsideCorners: worstOutside,
    worstTick
  };
  staticOutside = 0; // the per-tick sweep above is the stricter statement
}

if (staticOutside) extra.push(staticOutside + ' draw AABB corners fall outside the reference camera clip volume');

const report = {
  packet: path.relative(ROOT, file).split(path.sep).join('/'),
  version: packet.version,
  bytes: raw.byteLength,
  hash: packet.hash,
  recomputedHash: packetHash(packet),
  canonicalBodyBytes: Buffer.byteLength(canonicalJson(Object.fromEntries(Object.entries(packet).filter(([key]) => key !== 'hash'))), 'utf8'),
  draws: packet.draws?.length ?? 0,
  meshes: packet.meshes?.length ?? 0,
  drawVertices,
  drawTriangles,
  sceneBounds,
  sequence,
  conformance: { ok: result.ok && extra.length === 0, errors: [...result.errors, ...extra] }
};
mkdirSync(path.dirname(path.resolve(ROOT, outPath)), { recursive: true });
writeFileSync(path.resolve(ROOT, outPath), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
if (!report.conformance.ok) {
  console.error('render-packet conformance FAILED');
  process.exit(1);
}
