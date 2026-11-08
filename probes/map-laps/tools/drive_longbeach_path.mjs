#!/usr/bin/env node
// Drive the committed Long Beach collision path with the engine's own physics.
//
//   node probes/map-laps/tools/drive_longbeach_path.mjs
//   node probes/map-laps/tools/drive_longbeach_path.mjs --control AMBOY
//
// This is the real-collision check the raster cannot make: the e1_drive wasm
// loads the complete `Level.levelphysics` (static meshes, the ten
// InstancedTriangleMesh records and the FluidMesh), and the page's sprint
// controller follows the committed samples. It records the finish tick, the
// maximum lateral offset, and the closest approach of the car centre and its
// box-proxy corner to the recorded 226.8 m curb.
//
// Read-only use of the committed e1_drive wasm, the car roster and the physics
// file. No e1-drive file is modified. This is a scripted drive, not a retail
// game run; it makes no renderer claim.
//
// Output: `_work/map-laps/longbeach/drive.json`; exits 1 if the car does not
// reach the finish inside the sprint script's 3600-tick bound.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOC_PATH = path.join(ROOT, 'probes/map-laps/data/longbeach-path.json');
const E1 = path.join(ROOT, '_work/e1-drive');
const MODULE = path.join(E1, 'module/e1_drive.mjs');
const CARS = path.join(E1, 'cars.json');
const PHYSICS = path.join(ROOT, 'game-data/Blur/levels/usa_la_longbeachdocks/Level.levelphysics');
const OUT = path.join(ROOT, '_work/map-laps/longbeach/drive.json');
const TICK_LIMIT = 3600;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf('--' + name);
  return at >= 0 ? argv[at + 1] : fallback;
};
const controlName = arg('control', 'SPRINT');

for (const file of [DOC_PATH, MODULE, CARS, PHYSICS]) {
  if (!existsSync(file)) {
    console.error('missing input: ' + path.relative(ROOT, file));
    process.exit(1);
  }
}

const layout = JSON.parse(readFileSync(DOC_PATH, 'utf8'));
const roster = JSON.parse(readFileSync(CARS, 'utf8'));
const car = roster.roster.cars.find((entry) => entry.slug === 'corvette-zr1-stock');
if (!car) {
  console.error('corvette-zr1-stock is not in the roster');
  process.exit(1);
}
const levelBytes = readFileSync(PHYSICS);
const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));

const script = await import(pathToFileURL(path.join(ROOT, 'probes/e1-drive/web/sprint-script.js')).href);
const rules = await import(pathToFileURL(path.join(ROOT, 'probes/e1-drive/web/sprint-rules.js')).href);
const factory = (await import(pathToFileURL(MODULE).href)).default;
const module = await factory();
const levelPtr = module._malloc(levelBytes.length);
const fieldsPtr = module._malloc(fieldBytes.length);
module.HEAPU8.set(levelBytes, levelPtr);
module.HEAPU8.set(fieldBytes, fieldsPtr);

const spawn = layout.course.spawn;
const created = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
  spawn.x, spawn.z, spawn.headingRad);
if (!created) {
  console.error('create failed: ' + module.UTF8ToString(module._e1_last_error()));
  process.exit(1);
}
const control = controlName === 'AMBOY' ? script.AMBOY_CONTROL : script.SPRINT_CONTROL;

const segments = layout.source.obstruction.segments.map((segment) =>
  [segment.a[0], segment.a[1], segment.b[0], segment.b[1]]);
function segmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = 0;
  if (l2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

let state = JSON.parse(module.UTF8ToString(module._e1_get_state()));
let maxArc = 0;
let maxSpeed = 0;
let maxLateral = 0;
let maxLateralArc = null;
let minCurb = Infinity;
let minCurbArc = null;
let finishTick = null;
let stuckTicks = 0;
const checkpointArcs = layout.gates.filter((gate) => gate.kind === 'checkpoint')
  .map((gate) => gate.arc);
const checkpointLateral = checkpointArcs.map((arc) => ({ arc, lateral: null, x: null, z: null }));
const samples = [];
for (let tick = 1; tick <= TICK_LIMIT; tick += 1) {
  const input = script.sprintControl(state, layout, control);
  module._e1_set_input(input[0], input[1], input[2], input[3]);
  module._e1_step();
  state = JSON.parse(module.UTF8ToString(module._e1_get_state()));
  const course = rules.coursePosition(layout.course.samples, state.position);
  if (course.arc > maxArc) maxArc = course.arc;
  if (state.speed > maxSpeed) maxSpeed = state.speed;
  if (tick > 300 && course.distance > maxLateral) {
    maxLateral = course.distance;
    maxLateralArc = course.arc;
  }
  for (let index = 0; index < checkpointArcs.length; index++) {
    const row = checkpointLateral[index];
    if (row.lateral === null && course.arc >= checkpointArcs[index]) {
      row.lateral = Math.round(course.distance * 1000) / 1000;
      row.x = Math.round(state.position[0] * 1000) / 1000;
      row.z = Math.round(state.position[2] * 1000) / 1000;
    }
  }
  for (const segment of segments) {
    const d = segmentDistance(state.position[0], state.position[2], ...segment);
    if (d < minCurb) { minCurb = d; minCurbArc = course.arc; }
  }
  if (tick > 300 && state.speed < 0.05) stuckTicks += 1; else stuckTicks = 0;
  if (tick % 60 === 0) {
    samples.push({ tick, arc: Math.round(course.arc * 1000) / 1000,
      speed: Math.round(state.speed * 1000) / 1000,
      x: Math.round(state.position[0] * 1000) / 1000,
      z: Math.round(state.position[2] * 1000) / 1000 });
  }
  if (course.arc >= layout.course.span.finishArc - 0.5) { finishTick = tick; break; }
  if (stuckTicks > 600) break;
}

const circumradius = layout.source.clearance.carCircumradiusM;
const result = {
  kind: 'map-laps.drive',
  version: 1,
  level: layout.source.level,
  path: 'probes/map-laps/data/longbeach-path.json',
  pathHash: layout.hash,
  physics: {
    path: layout.source.physics.path,
    bytes: levelBytes.length,
    sha256: layout.source.physics.sha256,
  },
  module: {
    path: '_work/e1-drive/module/e1_drive.mjs',
    wasmSha256: 'sha256:' + createHash('sha256')
      .update(readFileSync(path.join(E1, 'module/e1_drive.wasm'))).digest('hex'),
  },
  car: car.slug,
  control: controlName,
  tickLimit: TICK_LIMIT,
  finishTick,
  finished: finishTick !== null,
  maxArcMetres: Math.round(maxArc * 1000) / 1000,
  finishArcMetres: layout.course.span.finishArc,
  maxSpeedMps: Math.round(maxSpeed * 1000) / 1000,
  maxLateralMetres: Math.round(maxLateral * 1000) / 1000,
  maxLateralArc: Math.round(maxLateralArc * 1000) / 1000,
  checkpointLateral,
  minCurbCentreDistanceM: Math.round(minCurb * 1000) / 1000,
  minCurbCornerDistanceM: Math.round((minCurb - circumradius) * 1000) / 1000,
  minCurbArc: Math.round(minCurbArc * 1000) / 1000,
  finalPosition: state.position.map((value) => Math.round(value * 1000) / 1000),
  finalSpeedMps: Math.round(state.speed * 1000) / 1000,
  scope: {
    engineIntegration: true,
    vehiclePhysics: true,
    gameRun: false,
    rendererClaim: false,
    note: ('the e1_drive wasm loads the complete Level.levelphysics; the page\'s '
      + 'sprint controller follows the committed samples; no renderer or retail '
      + 'game run is claimed'),
  },
  samples,
};
result.hash = 'sha256:' + createHash('sha256')
  .update(JSON.stringify({ ...result, hash: undefined })).digest('hex');
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 1) + '\n');
module._free(levelPtr);
module._free(fieldsPtr);

console.log(JSON.stringify({
  control: controlName,
  finished: result.finished,
  finishTick: result.finishTick,
  maxArcMetres: result.maxArcMetres,
  finishArcMetres: result.finishArcMetres,
  maxSpeedMps: result.maxSpeedMps,
  maxLateralMetres: result.maxLateralMetres,
  maxLateralArc: result.maxLateralArc,
  checkpointLateral: result.checkpointLateral,
  minCurbCentreDistanceM: result.minCurbCentreDistanceM,
  minCurbCornerDistanceM: result.minCurbCornerDistanceM,
  output: path.relative(ROOT, OUT).replace(/\\/g, '/'),
  hash: result.hash,
}, null, 1));
if (!result.finished) process.exit(1);
