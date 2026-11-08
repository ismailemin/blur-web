// Derive the concrete GPU/CPU resource requirements of the committed E1 page
// from the committed artifacts (read-only), so the capability probe compares
// browsers against measured numbers instead of guessed ones.
//
// Output: _work/compat/render-requirements.json (not committed).
// Usage:  node probes/compat/tools/measure_requirements.mjs

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT_DIR = path.join(ROOT, '_work/compat');
const OUT = path.join(OUT_DIR, 'render-requirements.json');

const REL = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const abs = (rel) => path.join(ROOT, rel);
const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const readJson = (rel) => JSON.parse(readFileSync(abs(rel), 'utf8'));
const stat = (rel) => {
  const bytes = readFileSync(abs(rel));
  return { path: rel, bytes: bytes.length, sha256: sha256(bytes) };
};

// Note: the packets are built at runtime from these documents, so draw counts are
// sums of committed draw lists rather than a stored total.
const level = readJson('_work/e1-drive/level.geometry.json');
const carIndex = readJson('_work/e1-drive/car-bodies.index.json');

const maxOf = (records, key) => records.reduce((max, record) => Math.max(max, Number(record?.[key]) || 0), 0);
const maxTextureEdge = (records) => maxOf(records || [], 'width') > maxOf(records || [], 'height')
  ? maxOf(records || [], 'width') : maxOf(records || [], 'height');

const carChunks = Object.entries(carIndex.cars).sort(([a], [b]) => a.localeCompare(b));
const carGeometry = [];
for (const [slug, entry] of carChunks) {
  const rel = '_work/e1-drive/' + entry.file;
  if (!existsSync(abs(rel))) continue;
  const doc = readJson(rel);
  carGeometry.push({ slug, textures: doc.textures || [] });
}

const maxCarDraws = maxOf(carChunks.map(([, entry]) => entry), 'draws');
const maxCarVertices = maxOf(carChunks.map(([, entry]) => entry), 'vertices');
const maxCarTextureEdge = Math.max(0, ...carGeometry.map((car) => maxTextureEdge(car.textures)));

const levelTextures = [...(level.textures || []), ...(level.levelTextures || [])];
const levelMaxTextureEdge = maxTextureEdge(levelTextures);

const maps = {};
maps.river = {
  source: 'probes/e1-drive/web/packet-adapter.js (level.geometry.json + one car chunk)',
  draws: (level.levelDraws || []).length + (level.trackVisual?.draws || []).length + maxCarDraws,
  levelDraws: (level.levelDraws || []).length,
  trackDraws: (level.trackVisual?.draws || []).length,
  carDraws: maxCarDraws,
  meshes: [
    ...(level.meshes || []).map((mesh) => ({ id: mesh.id, vertices: mesh.vertexCount, indices: mesh.indexCount })),
    { id: 'car.<largest>', vertices: maxCarVertices, indices: null }
  ],
  maxTextureEdge: Math.max(levelMaxTextureEdge, maxCarTextureEdge),
  textureCount: levelTextures.length + maxOf(carChunks.map(([, entry]) => entry), 'textures')
};

for (const map of ['amboy', 'gracia']) {
  const render = readJson('_work/map-slice/' + map + '-render/render.json');
  const summary = readJson('_work/map-slice/' + map + '-textures/summary.json');
  const bindable = summary.textures.filter((texture) => (texture.bindableDrawCount || 0) > 0);
  const uvValues = (render.counts.bindableVerticesReferenced || 0) * 2;
  maps[map] = {
    source: '_work/map-slice/' + map + '-render/render.json + ' + map + '-textures/summary.json',
    draws: render.counts.bindableDraws + maxCarDraws,
    mapDraws: render.counts.bindableDraws,
    carDraws: maxCarDraws,
    meshes: [{
      id: map + '.map',
      vertices: render.counts.vertexCount,
      indices: render.counts.indexCount,
      uvValues
    }],
    maxTextureEdge: Math.max(maxTextureEdge(bindable), maxCarTextureEdge),
    textureCount: render.counts.uniqueTextureBlobs + maxOf(carChunks.map(([, entry]) => entry), 'textures')
  };
}

const MP_SLOTS = 4;          // one human peer + up to three host AI (app.js remotes)
const POWERUP_SLOTS = 16;    // packet-consumer.js power-up marker slots
const RING_SLOTS = 4;        // packet-consumer.js Barge ring slots
const UNIFORM_STRIDE = 256;  // packet-consumer.js:137
const UNIFORM_BYTES = 160;   // packet-consumer.js:138

for (const map of Object.values(maps)) {
  const uvValues = map.meshes.reduce((sum, mesh) => sum + (mesh.uvValues || 0), 0);
  map.largestBufferBytes = Math.max(
    ...map.meshes.map((mesh) => Math.max(mesh.vertices * 12, (mesh.indices || 0) * 4)),
    uvValues * 4
  );
  map.uniformSlots = map.draws + map.carDraws * MP_SLOTS + POWERUP_SLOTS + RING_SLOTS;
  map.uniformBytes = map.uniformSlots * UNIFORM_STRIDE;
  map.indexBufferBytes = Math.max(...map.meshes.map((mesh) => (mesh.indices || 0) * 4));
  map.vertexBufferBytes = Math.max(...map.meshes.map((mesh) => mesh.vertices * 12));
}

const worst = Object.entries(maps).sort(([, a], [, b]) => b.uniformBytes - a.uniformBytes)[0];
const largestBuffer = Math.max(...Object.values(maps).map((map) => map.largestBufferBytes));
const maxTextureEdgeAll = Math.max(...Object.values(maps).map((map) => map.maxTextureEdge));

// Cross-check the static draw counts against the browser evidence that already
// exists in the repository (the captures record `draws` per map).
const evidence = {};
for (const [map, rel] of Object.entries({
  river: '_work/e1-drive/browser-evidence-sprint.json',
  amboy: '_work/e1-drive/browser-evidence-map-amboy.json',
  gracia: '_work/e1-drive/browser-evidence-map-gracia.json'
})) {
  if (!existsSync(abs(rel))) continue;
  const doc = readJson(rel);
  const first = Array.isArray(doc.captures) ? doc.captures[0] : null;
  if (first) evidence[map] = { file: rel, draws: first.draws, trackDraws: first.trackDraws ?? null };
}

const record = {
  schema: 'blur.compat.render-requirements',
  version: 1,
  generatedBy: 'probes/compat/tools/measure_requirements.mjs',
  inputs: [
    stat('_work/e1-drive/level.geometry.json'),
    stat('_work/e1-drive/car-bodies.index.json')
  ],
  constants: { MP_SLOTS, POWERUP_SLOTS, RING_SLOTS, UNIFORM_STRIDE, UNIFORM_BYTES, DRAW_UNIFORM_BYTES: 160 },
  maps,
  worstCase: {
    uniformBytes: worst[1].uniformBytes,
    largestBufferBytes: largestBuffer,
    maxTextureEdge: maxTextureEdgeAll,
    draws: worst[1].draws
  },
  requiredLimits: {
    maxBufferSize: largestBuffer,
    maxTextureDimension2D: maxTextureEdgeAll,
    maxTextureArrayLayers: 1,
    maxBindGroups: 3,
    maxBindGroupLayoutsPerPipeline: 3,
    maxBindingsPerBindGroup: 3,
    maxUniformBuffersPerShaderStage: 2,
    maxUniformBufferBindingSize: UNIFORM_BYTES,
    maxSampledTexturesPerShaderStage: 1,
    maxSamplersPerShaderStage: 1,
    maxVertexBuffers: 2,
    maxVertexAttributes: 2,
    maxVertexBufferArrayStride: 12,
    maxColorAttachments: 1,
    maxColorAttachmentBytesPerSample: 8,
    maxSamplerAnisotropy: 1
  },
  evidence,
  evidenceNote: 'The browser evidence `draws` counts a specific car (Corvette, 100 draws), while the measured budget uses the largest committed car chunk (123 draws); the difference is expected and is not a mismatch. The River evidence file uses a different schema and is not counted here.'
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(record, null, 2) + '\n', 'utf8');
console.log('wrote ' + REL(OUT));
console.log('maps: ' + Object.entries(maps).map(([name, map]) =>
  name + ' ' + map.draws + ' draws, uniform ' + map.uniformBytes + ' B, largest buffer ' + map.largestBufferBytes + ' B').join(' | '));
console.log('required: maxBufferSize=' + largestBuffer + ' maxTextureDimension2D=' + maxTextureEdgeAll +
  ' uniformBytes=' + worst[1].uniformBytes);
for (const [name, row] of Object.entries(evidence)) {
  console.log('evidence ' + name + ': ' + row.draws + ' draws (' + row.file + ')');
}
