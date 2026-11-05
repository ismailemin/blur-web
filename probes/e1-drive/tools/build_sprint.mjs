// Build the point-to-point sprint layout for the E1 drive slice.
//
//   node probes/e1-drive/tools/build_sprint.mjs
//
// Inputs (read-only):
//   _work/e1-drive/geometry.json  real track visual + hidden collision surface
//   _work/e1-drive/spawn.json     the committed spawn (written by the verifier)
// Output:
//   _work/e1-drive/sprint.json    gate layout, measured coverage and the sprint rules
//
// Every coordinate is derived in web/sprint-layout.js from the geometry; this
// tool only loads, derives and writes. The verifier re-derives the layout and
// compares it with the file, so a hand-edited sprint.json is a hard failure.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveSprintLayout } from '../web/sprint-layout.js';
import { TICK0_LIMITS } from './spawn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORK = path.join(ROOT, '_work/e1-drive');
const GEOMETRY = path.join(WORK, 'geometry.json');
const SPAWN = path.join(WORK, 'spawn.json');
const OUT = path.join(WORK, 'sprint.json');

if (!existsSync(GEOMETRY)) {
  throw new Error('missing _work/e1-drive/geometry.json — run `node probes/e1-drive/tools/build_geometry.mjs` first');
}
const geometryBytes = readFileSync(GEOMETRY);
const geometry = JSON.parse(geometryBytes.toString('utf8'));
const spawn = existsSync(SPAWN)
  ? JSON.parse(readFileSync(SPAWN, 'utf8'))
  : { x: TICK0_LIMITS.x, z: TICK0_LIMITS.z, heading: TICK0_LIMITS.heading, source: TICK0_LIMITS.source };

const layout = deriveSprintLayout(geometry, spawn);
const text = JSON.stringify(layout, null, 2) + '\n';
writeFileSync(OUT, text, 'utf8');

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
console.log(JSON.stringify({
  output: path.relative(ROOT, OUT).split(path.sep).join('/'),
  bytes: Buffer.byteLength(text, 'utf8'),
  fileSha256: 'sha256:' + sha256(Buffer.from(text, 'utf8')),
  geometrySha256: 'sha256:' + sha256(geometryBytes),
  layoutHash: layout.hash,
  spawn: layout.source.spawn,
  span: layout.course.span,
  groundY: layout.course.spawnGroundY,
  gates: layout.gates.map((gate) => ({
    id: gate.id,
    kind: gate.kind,
    x: gate.x,
    z: gate.z,
    widthMetres: gate.widthMetres,
    drawnSamples: gate.coverage.drawnSamples + '/' + gate.coverage.samples,
    collisionSamples: gate.coverage.collisionSamples + '/' + gate.coverage.samples,
    heightRange: gate.coverage.drawnHeightRange
  })),
  columns: layout.course.columns.length
}, null, 2));
