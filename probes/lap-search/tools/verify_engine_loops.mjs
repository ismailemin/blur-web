// P61: validate every candidate lap with the engine's own collision trace.
//
// Reads _work/lap-search/loops.json, resamples each closed loop at 0.5 m, and
// for every sample:
//   * e1_ground_probe -> engine ground (same FillCache/Trace the wheels use);
//   * eight horizontal e1_ray_probe rays from the car centre at +0.20 m and
//     +1.00 m, in the car frame;
//   * hard violation: hit inside the car footprint support + 0.05 m;
//     safety-margin violation: hit inside support + 0.30 m.
// Step and 2 m grade are measured from the engine ground sequence, cyclically
// across the closure seam.
//
// Read-only use of the committed e1_drive wasm. No e1-drive file is modified.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const E1 = path.join(ROOT, '_work/e1-drive');
const OUT = path.join(ROOT, '_work/lap-search');
const LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics');
const MODULE = path.join(E1, 'module/e1_drive.mjs');
const SPACING = 0.5;

const roster = JSON.parse(readFileSync(path.join(E1, 'cars.json'), 'utf8'));
const car = roster.roster.cars.find((entry) => entry.slug === 'corvette-zr1-stock');
const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
const levelBytes = readFileSync(LEVEL);
const loopsDoc = JSON.parse(readFileSync(path.join(OUT, 'loops.json'), 'utf8'));

const factory = (await import(pathToFileURL(MODULE).href)).default;
const module = await factory();
const levelPtr = module._malloc(levelBytes.length);
const fieldsPtr = module._malloc(fieldBytes.length + 1);
module.HEAPU8.set(levelBytes, levelPtr);
module.HEAPU8.set(fieldBytes, fieldsPtr);

const env = loopsDoc.inputs.carEnvelope;
const HARD_MARGIN = 0.05;
const SOFT_MARGIN = 0.30;

function resampleClosed(points, step) {
  const out = [];
  let carry = 0;
  let prev = points[0];
  for (let k = 1; k < points.length; k += 1) {
    const cur = points[k];
    let seg = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    while (carry + seg >= step) {
      const t = (step - carry) / seg;
      const x = prev[0] + (cur[0] - prev[0]) * t;
      const z = prev[1] + (cur[1] - prev[1]) * t;
      out.push([x, z]);
      prev = [x, z];
      seg = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
      carry = 0;
    }
    carry += seg;
    prev = cur;
  }
  // closed loop: the last sample is the first point again
  out.push([points[0][0], points[0][1]]);
  return out;
}

const ray = (px, py, pz, dx, dy, dz, distance) => JSON.parse(module.UTF8ToString(
  module._e1_ray_probe(px, py, pz, dx, dy, dz, distance)));
const ground = (px, pz) => JSON.parse(module.UTF8ToString(module._e1_ground_probe(px, pz)));

function traceLoop(loop) {
  const samples = resampleClosed(loop.points, SPACING);
  const [sx, sz] = samples[0];
  const [nx, nz] = samples[1];
  const heading = Math.atan2(nx - sx, nz - sz);
  const ok = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
    sx, sz, heading);
  if (!ok) throw new Error('create failed: ' + module.UTF8ToString(module._e1_last_error()));

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
      prevH = null;
      continue;
    }
    const h = g.y;
    if (prevH !== null) {
      const d = Math.abs(h - prevH);
      if (d > maxStep) { maxStep = d; maxStepAt = k; }
    }
    prevH = h;
    const a = samples[(k - 1 + samples.length) % samples.length];
    const b = samples[(k + 1) % samples.length];
    const fx = b[0] - a[0];
    const fz = b[1] - a[1];
    const fl = Math.hypot(fx, fz) || 1;
    const fwd = [fx / fl, fz / fl];
    const right = [-fwd[1], fwd[0]];
    const dirs = [
      { name: 'fwd', d: [fwd[0], fwd[1]], support: env.halfLength },
      { name: 'back', d: [-fwd[0], -fwd[1]], support: env.halfLength },
      { name: 'left', d: [-right[0], -right[1]], support: env.halfWidth },
      { name: 'right', d: [right[0], right[1]], support: env.halfWidth },
      { name: 'fwd-left', d: [fwd[0] - right[0], fwd[1] - right[1]], support: Math.hypot(env.halfLength, env.halfWidth) },
      { name: 'fwd-right', d: [fwd[0] + right[0], fwd[1] + right[1]], support: Math.hypot(env.halfLength, env.halfWidth) },
      { name: 'back-left', d: [-fwd[0] - right[0], -fwd[1] - right[1]], support: Math.hypot(env.halfLength, env.halfWidth) },
      { name: 'back-right', d: [-fwd[0] + right[0], -fwd[1] + right[1]], support: Math.hypot(env.halfLength, env.halfWidth) },
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
          const rec = { dir: dir.name, height: off, distance: hit.distance,
                        normal: hit.normal,
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

  // cyclic 2 m grade over the unique samples
  const m = rows.length - 1;
  let maxGrade = 0;
  let maxGradeAt = -1;
  for (let a = 0; a < m; a += 1) {
    let acc = 0;
    let j = a;
    while (acc < 2.0) {
      const j2 = (j + 1) % m;
      acc += Math.hypot(rows[j2].x - rows[j].x, rows[j2].z - rows[j].z);
      j = j2;
      if (j === a) break;
    }
    if (acc >= 1.9 && rows[a].hit !== false && rows[j].hit !== false) {
      const g = Math.abs(rows[j].ground - rows[a].ground) / acc;
      if (g > maxGrade) { maxGrade = g; maxGradeAt = a; }
    }
  }

  const minTight = tightViolations.length
    ? rows.reduce((acc, r) => Math.min(acc, ...(r.tightHits || []).map((h) => h.clearance)), 1e9)
    : null;
  return {
    id: loop.id,
    length: loop.length,
    samples: rows.length,
    spacing: SPACING,
    violations,
    tightViolations,
    hardMargin: HARD_MARGIN,
    softMargin: SOFT_MARGIN,
    minTightClearance: minTight,
    maxStep,
    maxStepAt,
    maxGrade,
    maxGradeAt,
    hitCount: rows.reduce((n, r) => n + (r.hits ? r.hits.length : 0), 0),
    tightHitCount: rows.reduce((n, r) => n + (r.tightHits ? r.tightHits.length : 0), 0),
    rows,
  };
}

const loops = loopsDoc.loops.map(traceLoop);

// Barrier probe: from the nearest drivable cell of the spawn component toward
// each loop component, the two car-height rays the wall test uses.
const barrierProbes = [];
for (const comp of loopsDoc.loopComponents) {
  if (comp.isSpawnComponent) continue;
  const nt = comp.nearestToSpawn;
  const [ax, az] = nt.fromWorld;
  const [bx, bz] = nt.toWorld;
  const g = ground(ax, az);
  const dist = Math.min(nt.gapM + 1.0, 5.0);
  const dl = Math.hypot(bx - ax, bz - az) || 1;
  const dx = (bx - ax) / dl;
  const dz = (bz - az) / dl;
  const hits = [];
  if (g.hit) {
    for (const off of [0.20, 1.00]) {
      const hit = ray(ax, g.y + off, az, dx, 0, dz, dist);
      if (hit.hit) hits.push({ height: off, distance: hit.distance, normal: hit.normal });
    }
  }
  barrierProbes.push({
    component: comp.id,
    gapM: nt.gapM,
    fromWorld: nt.fromWorld,
    toWorld: nt.toWorld,
    ground: g.hit ? g.y : null,
    rayDistance: dist,
    hits,
  });
}

// Control: the known 29 m P37 sprint straight, z = 1050, x = -88 -> -59.
module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length, -88, 1050, Math.PI / 2);
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
  kind: 'lap-search.engine-trace',
  version: 1,
  source: {
    module: '_work/e1-drive/module/e1_drive.mjs',
    moduleSha256: createHash('sha256').update(readFileSync(path.join(E1, 'module/e1_drive.wasm'))).digest('hex'),
    path: '_work/lap-search/loops.json',
    loopsHash: loopsDoc.hash,
    car: car.slug,
  },
  scope: {
    engineIntegration: true,
    vehiclePhysics: false,
    gameRun: false,
    note: 'e1_ray_probe = C_Scene::FillCache + C_LineCollisionCache::Trace (thin ray, radius 0), the same path the wheels use',
  },
  loops,
  barrierProbes,
  control29m: {
    samples: controlRows.length,
    wallHits: controlHits,
    maxStep: controlMaxStep,
    passable: controlHits === 0,
  },
};
const hash = createHash('sha256').update(JSON.stringify(document)).digest('hex');
document.hash = 'sha256:' + hash;
writeFileSync(path.join(OUT, 'engine-trace.json'), JSON.stringify(document, null, 1) + '\n');
console.log(JSON.stringify({
  loops: loops.map((l) => ({
    id: l.id, samples: l.samples, violations: l.violations.length,
    tightViolations: l.tightViolations.length, minTightClearance: l.minTightClearance,
    maxStep: l.maxStep, maxStepAt: l.maxStepAt, maxGrade: l.maxGrade, maxGradeAt: l.maxGradeAt,
  })),
  control29m: document.control29m,
  hash: document.hash,
}, null, 1));
if (loops.some((l) => l.violations.length)) process.exit(1);
