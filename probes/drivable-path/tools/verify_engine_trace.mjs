// P48: verify the candidate path with the engine's own collision trace.
//
// Reads _work/drivable-path/path.json, re-samples it at 0.5 m, and for every
// sample:
//   * e1_ground_probe -> engine ground height (the same FillCache/Trace the
//     wheels use);
//   * eight horizontal e1_ray_probe rays from the car centre at 0.20 m and
//     1.00 m above that ground, in the car frame;
//   * a ray is a violation when its hit distance is inside the car footprint
//     support in that direction plus 0.05 m.
// The engine ground sequence is also checked for step and 2 m grade.
//
// Read-only use of the committed e1_drive wasm. No e1-drive file is modified.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const E1 = path.join(ROOT, '_work/e1-drive');
const OUT = path.join(ROOT, '_work/drivable-path');
const LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics');
const MODULE = path.join(E1, 'module/e1_drive.mjs');
const SPACING = 0.5;

const roster = JSON.parse(readFileSync(path.join(E1, 'cars.json'), 'utf8'));
const car = roster.roster.cars.find((entry) => entry.slug === 'corvette-zr1-stock');
const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
const levelBytes = readFileSync(LEVEL);
const pathDoc = JSON.parse(readFileSync(path.join(OUT, 'path.json'), 'utf8'));

const factory = (await import(pathToFileURL(MODULE).href)).default;
const module = await factory();
const levelPtr = module._malloc(levelBytes.length);
const fieldsPtr = module._malloc(fieldBytes.length + 1);
module.HEAPU8.set(levelBytes, levelPtr);
module.HEAPU8.set(fieldBytes, fieldsPtr);
if (!module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length, pathDoc.course.start[0], pathDoc.course.start[1], 1.5707963267948966)) {
  throw new Error('create failed: ' + module.UTF8ToString(module._e1_last_error()));
}
const ray = (px, py, pz, dx, dy, dz, distance) => JSON.parse(module.UTF8ToString(
  module._e1_ray_probe(px, py, pz, dx, dy, dz, distance)));
const ground = (px, pz) => JSON.parse(module.UTF8ToString(module._e1_ground_probe(px, pz)));

// half extents documented in path.json (car envelope + 0.30 m margin)
const env = pathDoc.inputs.carEnvelope;
const halfL = env.halfLength;
const halfW = env.halfWidth;
const HARD_MARGIN = 0.05;   // no clipping: car envelope + 5 cm
const SOFT_MARGIN = 0.30;   // the documented safety margin

const pts = pathDoc.course.points;
// resample the 0.25 m polyline at SPACING
const samples = [];
let carry = 0;
let prev = pts[0];
for (let k = 1; k < pts.length; k += 1) {
  const cur = pts[k];
  let seg = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
  while (carry + seg >= SPACING) {
    const t = (SPACING - carry) / seg;
    const x = prev[0] + (cur[0] - prev[0]) * t;
    const z = prev[1] + (cur[1] - prev[1]) * t;
    samples.push([x, z]);
    prev = [x, z];
    seg = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    carry = 0;
  }
  carry += seg;
  prev = cur;
}
samples.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);

const violations = [];
const tightViolations = [];
const rows = [];
let maxStep = 0;
let maxStepAt = -1;
let prevH = null;
for (let k = 0; k < samples.length; k += 1) {
  const [x, z] = samples[k];
  const g = ground(x, z);
  if (!g.hit) {
    violations.push({ sample: k, x, z, kind: 'no-engine-ground' });
    rows.push({ k, x, z, hit: false });
    continue;
  }
  const h = g.y;
  if (prevH !== null) {
    const d = Math.abs(h - prevH);
    if (d > maxStep) { maxStep = d; maxStepAt = k; }
  }
  prevH = h;
  // heading from the local path direction
  const a = samples[Math.max(0, k - 1)];
  const b = samples[Math.min(samples.length - 1, k + 1)];
  const fx = b[0] - a[0];
  const fz = b[1] - a[1];
  const fl = Math.hypot(fx, fz) || 1;
  const fwd = [fx / fl, fz / fl];
  const right = [-fwd[1], fwd[0]];
  const dirs = [
    { name: 'fwd', d: [fwd[0], fwd[1]], support: halfL },
    { name: 'back', d: [-fwd[0], -fwd[1]], support: halfL },
    { name: 'left', d: [-right[0], -right[1]], support: halfW },
    { name: 'right', d: [right[0], right[1]], support: halfW },
    { name: 'fwd-left', d: [fwd[0] - right[0], fwd[1] - right[1]], support: Math.hypot(halfL, halfW) },
    { name: 'fwd-right', d: [fwd[0] + right[0], fwd[1] + right[1]], support: Math.hypot(halfL, halfW) },
    { name: 'back-left', d: [-fwd[0] - right[0], -fwd[1] - right[1]], support: Math.hypot(halfL, halfW) },
    { name: 'back-right', d: [-fwd[0] + right[0], -fwd[1] + right[1]], support: Math.hypot(halfL, halfW) },
  ];
  const hits = [];
  const tightHits = [];
  for (const dir of dirs) {
    const dl = Math.hypot(dir.d[0], dir.d[1]) || 1;
    const dx = dir.d[0] / dl;
    const dz = dir.d[1] / dl;
    for (const off of [0.20, 1.00]) {
      const hit = ray(x, h + off, z, dx, 0, dz, dir.support + SOFT_MARGIN + 0.01);
      if (hit.hit) {
        const rec = { dir: dir.name, height: off, distance: hit.distance, normal: hit.normal,
                      point: [x + dx * hit.distance, z + dz * hit.distance],
                      support: dir.support,
                      clearance: dir.support + SOFT_MARGIN - hit.distance };
        if (hit.distance < dir.support + HARD_MARGIN) hits.push(rec);
        else tightHits.push(rec);
      }
    }
  }
  if (hits.length) violations.push({ sample: k, x, z, ground: h, kind: 'engine-wall-hit', hits });
  if (tightHits.length) tightViolations.push({ sample: k, x, z, ground: h, kind: 'safety-margin', hits: tightHits });
  rows.push({ k, x, z, ground: h, hits, tightHits });
}

// 2 m grade from the engine ground sequence
let maxGrade = 0;
let maxGradeAt = -1;
for (let k = 0; k < rows.length; k += 1) {
  let m = k;
  let acc = 0;
  while (m + 1 < rows.length && acc < 2.0) {
    acc += Math.hypot(rows[m + 1].x - rows[m].x, rows[m + 1].z - rows[m].z);
    m += 1;
  }
  if (acc >= 1.9 && rows[k].hit !== false && rows[m].hit !== false) {
    const g = Math.abs(rows[m].ground - rows[k].ground) / acc;
    if (g > maxGrade) { maxGrade = g; maxGradeAt = k; }
  }
}

// Control: the known 29 m P37 sprint straight, z=1050, x=-88 -> -59.
const controlRows = [];
let controlHits = 0;
let controlMaxStep = 0;
let controlPrev = null;
for (let x = -88; x <= -59 + 1e-9; x += 0.5) {
  const g = ground(x, 1050);
  if (!g.hit) { controlRows.push({ x, hit: false }); continue; }
  if (controlPrev !== null) controlMaxStep = Math.max(controlMaxStep, Math.abs(g.y - controlPrev));
  controlPrev = g.y;
  let hits = 0;
  for (const off of [0.20, 1.00]) {
    const hit = ray(x, g.y + off, 1050, 1, 0, 0, 2.0);
    if (hit.hit) hits += 1;
  }
  controlHits += hits;
  controlRows.push({ x, ground: g.y, hits });
}

const document = {
  kind: 'drivable-path.engine-trace',
  version: 1,
  source: {
    module: '_work/e1-drive/module/e1_drive.mjs',
    moduleSha256: createHash('sha256').update(readFileSync(path.join(E1, 'module/e1_drive.wasm'))).digest('hex'),
    path: '_work/drivable-path/path.json',
    pathHash: pathDoc.hash,
    car: car.slug,
  },
  scope: {
    engineIntegration: true,
    vehiclePhysics: false,
    gameRun: false,
    note: 'e1_ray_probe = C_Scene::FillCache + C_LineCollisionCache::Trace (thin ray, radius 0), the same path the wheels use',
  },
  samples: rows.length,
  spacing: SPACING,
  violations,
  tightViolations,
  hardMargin: HARD_MARGIN,
  softMargin: SOFT_MARGIN,
  minTightClearance: tightViolations.length
    ? rows.reduce((m, r) => Math.min(m, ...(r.tightHits || []).map((h) => h.clearance)), 1e9)
    : null,
  maxStep,
  maxStepAt,
  maxGrade,
  maxGradeAt,
  hitCount: rows.reduce((n, r) => n + (r.hits ? r.hits.length : 0), 0),
  tightHitCount: rows.reduce((n, r) => n + (r.tightHits ? r.tightHits.length : 0), 0),
  control29m: {
    samples: controlRows.length,
    wallHits: controlHits,
    maxStep: controlMaxStep,
    passable: controlHits === 0,
  },
  rows,
};
const hash = createHash('sha256').update(JSON.stringify(document)).digest('hex');
document.hash = 'sha256:' + hash;
writeFileSync(path.join(OUT, 'engine-trace.json'), JSON.stringify(document, null, 1) + '\n');
console.log(JSON.stringify({
  samples: document.samples,
  violations: violations.length,
  tightViolations: tightViolations.length,
  minTightClearance: document.minTightClearance,
  maxStep,
  maxStepAt,
  maxGrade,
  maxGradeAt,
  control29m: document.control29m,
  hash: document.hash,
}, null, 1));
if (violations.length) {
  console.log('first violations:', JSON.stringify(violations.slice(0, 5), null, 1));
  process.exit(1);
}
