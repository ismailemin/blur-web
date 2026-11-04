// Render packet v1 conformance gate.
//
// Usage: node probes/render-packet/tools/validate_packet.mjs <packet.json> [--out <report.json>]
//
// Checks the v1 contract plus the invariants a WebGPU consumer relies on:
// every draw range inside its mesh, every index inside the vertex count, and a
// hash that still matches the canonical body.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePacket, packetHash, canonicalJson } from './packet-format.mjs';

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

// Independently recomputed stats, so a wrong diagnostics block cannot hide.
let drawVertices = 0;
let drawTriangles = 0;
const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (const draw of packet.draws ?? []) {
  drawTriangles += draw.indexCount / 3;
  drawVertices += draw.vertexCount;
  for (let axis = 0; axis < 3; axis++) {
    bounds.min[axis] = Math.min(bounds.min[axis], draw.bounds.min[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], draw.bounds.max[axis]);
  }
}
const extra = [];
if (packet.diagnostics && packet.diagnostics.triangleTotal !== drawTriangles) {
  extra.push('diagnostics.triangleTotal (' + packet.diagnostics.triangleTotal + ') != sum of draw triangles (' + drawTriangles + ')');
}
for (const key of ['min', 'max']) {
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(bounds[key][axis])) extra.push('draw bounds are empty');
  }
}
if (packet.camera) {
  // The packet camera must actually contain the scene: every draw AABB corner
  // has to project inside the clip volume.
  const { view, projection } = packet.camera;
  const mvp = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += projection[k * 4 + row] * view[column * 4 + k];
      mvp[column * 4 + row] = sum;
    }
  }
  let outside = 0;
  for (const draw of packet.draws ?? []) {
    for (let corner = 0; corner < 8; corner++) {
      const point = [
        (corner & 1 ? draw.bounds.max : draw.bounds.min)[0],
        (corner & 2 ? draw.bounds.max : draw.bounds.min)[1],
        (corner & 4 ? draw.bounds.max : draw.bounds.min)[2]
      ];
      const clip = [0, 0, 0, 0];
      for (let row = 0; row < 4; row++) {
        clip[row] = point[0] * mvp[row] + point[1] * mvp[4 + row] + point[2] * mvp[8 + row] + mvp[12 + row];
      }
      if (clip[3] <= 0) { outside++; continue; }
      const x = clip[0] / clip[3], y = clip[1] / clip[3], z = clip[2] / clip[3];
      if (x < -1.0001 || x > 1.0001 || y < -1.0001 || y > 1.0001 || z < -0.0001 || z > 1.0001) outside++;
    }
  }
  if (outside) extra.push(outside + ' draw AABB corners fall outside the packet camera clip volume');
}

const report = {
  packet: path.relative(ROOT, file).split(path.sep).join('/'),
  bytes: raw.byteLength,
  hash: packet.hash,
  recomputedHash: packetHash(packet),
  canonicalBodyBytes: Buffer.byteLength(canonicalJson(Object.fromEntries(Object.entries(packet).filter(([key]) => key !== 'hash'))), 'utf8'),
  draws: packet.draws?.length ?? 0,
  meshes: packet.meshes?.length ?? 0,
  drawVertices,
  drawTriangles,
  sceneBounds: bounds,
  conformance: { ok: result.ok && extra.length === 0, errors: [...result.errors, ...extra] }
};
mkdirSync(path.dirname(path.resolve(ROOT, outPath)), { recursive: true });
writeFileSync(path.resolve(ROOT, outPath), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
if (!report.conformance.ok) {
  console.error('render-packet v1 conformance FAILED');
  process.exit(1);
}
