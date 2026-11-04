// Render packet v1.1 gate: build twice, prove byte determinism, validate, and
// assert the timeline's shape.
//
// Usage: node probes/render-packet/tools/verify_render_packet.mjs
//
// Produces:
//   _work/render-packet/packet.json            final packet (last build)
//   _work/render-packet/packet.run1.json       first determinism build
//   _work/render-packet/packet.run2.json       second determinism build
//   _work/render-packet/verify.json            gate evidence

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRigid } from '../web/interpolate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TOOLS = path.join(ROOT, 'probes/render-packet/tools');
const OUT = path.join(ROOT, '_work/render-packet');

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const node = (script, args) => execFileSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(label + (detail ? ': ' + detail : ''));
  return condition;
};

// 1. Determinism: two independent producer runs must be byte-identical.
const build = (target) => node(path.join(TOOLS, 'build_packet.mjs'), ['--out', target]);
build('_work/render-packet/packet.run1.json');
build('_work/render-packet/packet.run2.json');
const run1 = path.join(OUT, 'packet.run1.json');
const run2 = path.join(OUT, 'packet.run2.json');
const hash1 = sha256File(run1);
const hash2 = sha256File(run2);
check('determinism', hash1 === hash2, 'run1 ' + hash1 + ' vs run2 ' + hash2);

// 2. Conformance of the produced packet (structural + per-tick containment).
const validate = (file) => JSON.parse(node(path.join(TOOLS, 'validate_packet.mjs'), [file]));
const validation = validate('_work/render-packet/packet.run1.json');
check('conformance', validation.conformance.ok, validation.conformance.errors.slice(0, 6).join('; '));

build('_work/render-packet/packet.json');
const canonical = path.join(OUT, 'packet.json');
const canonicalHash = sha256File(canonical);
check('canonical build matches run1', canonicalHash === hash1, canonicalHash + ' vs ' + hash1);

const packet1 = JSON.parse(readFileSync(run1, 'utf8'));
const packet2 = JSON.parse(readFileSync(run2, 'utf8'));
check('run1 and run2 are equal as JSON', JSON.stringify(packet1) === JSON.stringify(packet2));

// 3. Expected content, taken from the reader verification evidence.
const packet = JSON.parse(readFileSync(canonical, 'utf8'));
check('packet version', packet.version === 1.1, String(packet.version));
const levelMesh = packet.meshes.find((mesh) => mesh.id === 'river.block27.instances-all');
const carMesh = packet.meshes.find((mesh) => mesh.id === 'corvette.c3.race.body');
check('level mesh present', Boolean(levelMesh));
check('car mesh present', Boolean(carMesh));
if (levelMesh) {
  check('level instance geometry', levelMesh.vertexCount === 13162 && levelMesh.indexCount / 3 === 10308,
    levelMesh.vertexCount + ' vertices / ' + levelMesh.indexCount / 3 + ' triangles');
  const levelDraws = packet.draws.filter((draw) => draw.meshId === levelMesh.id);
  check('level draws', levelDraws.length === 22, String(levelDraws.length));
  check('level draws all baked', levelDraws.every((draw) => draw.worldKind === 'baked-into-mesh' && draw.world.every((value, index) => value === (index % 5 === 0 ? 1 : 0))));
  check('level materials reported, not guessed', levelDraws.every((draw) => draw.materialId === null && draw.materialReason.length > 20));
}
if (carMesh) {
  check('car body geometry', carMesh.vertexCount === 30591 && carMesh.indexCount / 3 === 36193,
    carMesh.vertexCount + ' vertices / ' + carMesh.indexCount / 3 + ' triangles');
  const carDraws = packet.draws.filter((draw) => draw.meshId === carMesh.id);
  check('car draws', carDraws.length === 80, String(carDraws.length));
  check('car draws all packet-transformed', carDraws.every((draw) => draw.worldKind === 'packet-transform'));
  const bound = carDraws.filter((draw) => draw.materialId !== null).length;
  check('car albedo identities', bound === 14, String(bound) + ' draws bound to a declared material id');
  check('car materials carry no pixels', packet.materials.every((material) => material.pixelsIncluded === false));
}
check('draw total', packet.draws.length === 102, String(packet.draws.length));
check('triangle total', packet.diagnostics.triangleTotal === 46501, String(packet.diagnostics.triangleTotal));
check('cull count', packet.diagnostics.culled === 0, String(packet.diagnostics.culled));
check('approximations declared', packet.diagnostics.approximations.length > 0 && packet.diagnostics.limits.length > 0);
check('no textures in v1', !('textures' in packet));

// 4. Timeline shape: the whole point of 1.1.
const sequence = packet.diagnostics.sequence;
check('sequence motion is synthetic', sequence.motion === 'synthetic', sequence.motion);
check('sequence states it is not physics', /no .*physics|not physics/i.test(sequence.motionReason), sequence.motionReason);
check('tick count', packet.updates.length === 120, String(packet.updates.length));
check('sequence tickCount agrees', sequence.tickCount === packet.updates.length, String(sequence.tickCount));
check('tick rate', sequence.tickHz === 60 && Math.abs(packet.tickDurationSeconds - 1 / 60) < 1e-12);
check('ticks are 0..119 in order', packet.updates.every((update, index) => update.tick === index));
check('one moved node', packet.nodes.length === 1 && packet.nodes[0].drawIds.length === 80, String(packet.nodes.length));
check('static draws untouched', sequence.staticDrawCount === 22 && sequence.movedDrawCount === 80,
  sequence.staticDrawCount + ' static / ' + sequence.movedDrawCount + ' moved');

const tickHashes = packet.updates.map((update) => update.hash);
check('per-tick hashes are distinct', new Set(tickHashes).size === tickHashes.length, new Set(tickHashes).size + ' unique of ' + tickHashes.length);
check('per-tick hashes match run2', JSON.stringify(tickHashes) === JSON.stringify(packet2.updates.map((update) => update.hash)));
check('every tick matrix is rigid', packet.updates.every((update) => update.matrices.every((entry) => isRigid(entry.world))));

const firstWorld = packet.updates[0].matrices[0].world;
const lastWorld = packet.updates[packet.updates.length - 1].matrices[0].world;
check('tick 0 equals draws[].world', packet.draws.filter((draw) => draw.meshId === carMesh?.id).every((draw) => draw.world.every((value, index) => Math.abs(value - firstWorld[index]) <= 1e-9)));
const moved = Math.hypot(lastWorld[12] - firstWorld[12], lastWorld[13] - firstWorld[13], lastWorld[14] - firstWorld[14]);
check('the car actually moves', moved > 10, moved.toFixed(3) + ' m between tick 0 and tick 119');
check('the camera changes per tick', packet.updates[0].camera.view.some((value, index) => Math.abs(value - packet.updates[119].camera.view[index]) > 1e-4));

// 5. Schema must not drift from the structural validator.
const schema = JSON.parse(readFileSync(path.join(ROOT, 'probes/render-packet/schema/render-packet.v1.schema.json'), 'utf8'));
const schemaKeys = new Set(schema.required);
const packetKeys = new Set(Object.keys(packet));
check('schema required keys are present', [...schemaKeys].every((key) => packetKeys.has(key)));
check('schema accepts the packet version', schema.properties.version.enum.includes(packet.version), JSON.stringify(schema.properties.version));
const timelineRequired = schema.allOf[0].then.required;
check('schema requires the timeline for 1.1', timelineRequired.every((key) => packetKeys.has(key)), timelineRequired.join(','));
check('every packet member is described by the schema', [...packetKeys].every((key) => key in schema.properties));

const evidence = {
  packet: '_work/render-packet/packet.json',
  version: packet.version,
  packetHash: packet.hash,
  packetBytes: readFileSync(canonical).byteLength,
  canonicalBodyBytes: validation.canonicalBodyBytes,
  determinism: { run1FileSha256: hash1, run2FileSha256: hash2, identical: hash1 === hash2 },
  conformance: validation.conformance,
  sequence: {
    tickCount: packet.updates.length,
    tickHz: sequence.tickHz,
    motion: sequence.motion,
    firstTickHash: tickHashes[0],
    lastTickHash: tickHashes[tickHashes.length - 1],
    uniqueTickHashes: new Set(tickHashes).size,
    chordMetres: Number(moved.toFixed(4)),
    ticksWithFullContainment: validation.sequence?.ticksWithFullContainment ?? null,
    movedDraws: sequence.movedDrawCount,
    staticDraws: sequence.staticDrawCount
  },
  content: {
    meshes: packet.diagnostics.meshCount,
    draws: packet.diagnostics.drawCount,
    vertices: packet.diagnostics.vertexTotal,
    triangles: packet.diagnostics.triangleTotal,
    instancesEmitted: packet.diagnostics.instancesEmitted,
    instancesOmitted: packet.diagnostics.instancesOmitted,
    culled: packet.diagnostics.culled,
    materialsApplied: packet.diagnostics.materialsApplied,
    materialsDeclared: packet.materials.length,
    placement: packet.placedObjects.map((placed) => placed.placement),
    level: levelMesh && {
      vertexCount: levelMesh.vertexCount,
      triangleCount: levelMesh.indexCount / 3,
      drawCount: packet.draws.filter((draw) => draw.meshId === levelMesh.id).length,
      positionsSha256: levelMesh.positionsSha256,
      indicesSha256: levelMesh.indicesSha256
    },
    car: carMesh && {
      vertexCount: carMesh.vertexCount,
      triangleCount: carMesh.indexCount / 3,
      drawCount: packet.draws.filter((draw) => draw.meshId === carMesh.id).length,
      positionsSha256: carMesh.positionsSha256,
      indicesSha256: carMesh.indicesSha256
    }
  },
  failures
};
writeFileSync(path.join(OUT, 'verify.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(evidence, null, 2));
if (failures.length) {
  console.error('\nrender-packet gate FAILED');
  process.exit(1);
}
console.log('\nrender-packet gate PASSED');
