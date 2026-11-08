// Validate every map-lap candidate with the engine's own collision trace.
//
// Reads _work/map-laps/<level>/loops.json, resamples each closed loop at 0.5 m,
// and for every sample:
//   * e1_ground_probe -> engine ground (the same FillCache/Trace path the wheels
//     use);
//   * eight horizontal e1_ray_probe rays from the car centre at +0.20 m and
//     +1.00 m, in the car frame;
//   * hard violation: hit inside the car footprint support + 0.05 m;
//     safety-margin violation: hit inside support + 0.30 m.
// Step and 2 m grade are measured from the engine ground sequence, cyclically
// across the closure seam. A 29 m straight on the measured point-to-point path
// is kept as a control so a broken module is visible.
//
// Read-only use of the committed e1_drive wasm and the car roster. No e1-drive
// file is modified, no car is simulated and no renderer claim is made.
//
//   node probes/map-laps/tools/verify_engine_map_loops.mjs --level usa_amboy
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const E1 = path.join(ROOT, '_work/e1-drive');
const MODULE = path.join(E1, 'module/e1_drive.mjs');
const SPACING = 0.5;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf('--' + name);
  return at >= 0 ? argv[at + 1] : fallback;
};
const level = arg('level', 'usa_amboy');
const dir = path.resolve(ROOT, arg('dir', '_work/map-laps/' + level));

const loopsDoc = JSON.parse(readFileSync(path.join(dir, 'loops.json'), 'utf8'));
if (loopsDoc.level !== level) throw new Error('loops.json is for ' + loopsDoc.level);
const physics = path.join(ROOT, loopsDoc.inputs.physics.path);
const levelBytes = readFileSync(physics);
const physicsSha = createHash('sha256').update(levelBytes).digest('hex');
if (physicsSha !== loopsDoc.inputs.physics.sha256) {
  throw new Error('physics sha256 mismatch: ' + physicsSha);
}

const roster = JSON.parse(readFileSync(path.join(E1, 'cars.json'), 'utf8'));
const car = roster.roster.cars.find((entry) => entry.slug === 'corvette-zr1-stock');
const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));

const factory = (await import(pathToFileURL(MODULE).href)).default;
const module = await factory();
const levelPtr = module._malloc(levelBytes.length);
const fieldsPtr = module._malloc(fieldBytes.length);
module.HEAPU8.set(levelBytes, levelPtr);
module.HEAPU8.set(fieldBytes, fieldsPtr);

const env = loopsDoc.inputs.carEnvelope;
const HARD_MARGIN = 0.05;
const SOFT_MARGIN = 0.30;

const ray = (px, py, pz, dx, dy, dz, distance) => JSON.parse(module.UTF8ToString(
  module._e1_ray_probe(px, py, pz, dx, dy, dz, distance)));
const ground = (px, pz) => JSON.parse(module.UTF8ToString(module._e1_ground_probe(px, pz)));

function resampleClosed(points, groundArr, step) {
  const out = [];
  let carry = 0;
  let prev = points[0];
  let prevH = groundArr ? groundArr[0] : null;
  const pushPoint = (x, z, h) => out.push([x, z, h]);
  for (let k = 1; k < points.length; k += 1) {
    const cur = points[k];
    const curH = groundArr ? groundArr[k] : null;
    let seg = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const segLen = seg;
    while (carry + seg >= step) {
      const t = (step - carry) / seg;
      const x = prev[0] + (cur[0] - prev[0]) * t;
      const z = prev[1] + (cur[1] - prev[1]) * t;
      let h = null;
      if (prevH !== null && curH !== null) {
        const u = segLen > 0 ? 1 - (seg / segLen) : 0;
        h = prevH + (curH - prevH) * u;
      }
      pushPoint(x, z, h);
      prev = [x, z];
      seg = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
      carry = 0;
    }
    carry += seg;
    prev = cur;
    prevH = curH;
  }
  pushPoint(points[0][0], points[0][1], groundArr ? groundArr[0] : null);
  return out;
}

function traceLoop(loop) {
  const samples = resampleClosed(loop.points, loop.ground, SPACING);
  const [sx, sz] = samples[0];
  const [nx, nz] = samples[1];
  const heading = Math.atan2(nx - sx, nz - sz);

  const violations = [];
  const tightViolations = [];
  const rows = [];
  let maxStep = 0;
  let maxStepAt = -1;
  let prevH = null;
  let downRayCount = 0;
  for (let k = 0; k < samples.length; k += 1) {
    const [x, z, hSample] = samples[k];
    let g = ground(x, z);
    let mode = 'ground-probe';
    if (!g.hit) {
      // The legacy e1_ground_probe window starts its ray at y = 130.0, which
      // clips a map whose road sits at that exact height (Gracia, y ~ 130).
      // Fall back to a vertical e1_ray_probe from 2 m above the raster ground.
      if (hSample !== null && hSample !== undefined) {
        const r = ray(x, hSample + 2.0, z, 0, -1, 0, 6.0);
        if (r.hit) {
          g = { hit: true, y: r.point[1], normal: r.normal, cachedTriangles: r.cachedTriangles };
          mode = 'down-ray';
        }
      }
    }
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
    if (mode !== 'ground-probe') { downRayCount += 1; }
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
    for (const dirn of dirs) {
      const dl = Math.hypot(dirn.d[0], dirn.d[1]) || 1;
      const dx = dirn.d[0] / dl;
      const dz = dirn.d[1] / dl;
      for (const off of [0.20, 1.00]) {
        const hit = ray(x, h + off, z, dx, 0, dz, dirn.support + SOFT_MARGIN + 0.01);
        if (hit.hit) {
          const rec = { dir: dirn.name, height: off, distance: hit.distance,
                        normal: hit.normal,
                        point: [x + dx * hit.distance, z + dz * hit.distance],
                        support: dirn.support,
                        clearance: dirn.support + SOFT_MARGIN - hit.distance };
          if (hit.distance < dirn.support + HARD_MARGIN) hits.push(rec);
          else tightHits.push(rec);
        }
      }
    }
    if (hits.length) violations.push({ sample: k, x, z, ground: h, kind: 'engine-wall-hit', hits });
    if (tightHits.length) tightViolations.push({ sample: k, x, z, ground: h, kind: 'safety-margin', hits: tightHits });
    rows.push({ k, x, z, ground: h, hits, tightHits });
  }

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
    component: loop.component,
    samples: rows.length,
    spacing: SPACING,
    downRaySamples: downRayCount,
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

// One world for the whole run: `e1_create` needs ground under its start point,
// and the map spawn is the committed measured point. Ground/ray probes do not
// depend on the car pose, so every loop is traced in this single world.
const spawn = loopsDoc.inputs.spawn;
const createdAt = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
  spawn.x, spawn.z, spawn.heading);
if (!createdAt) {
  throw new Error('create failed at the map spawn: ' + module.UTF8ToString(module._e1_last_error()));
}
const engineInfo = JSON.parse(module.UTF8ToString(module._e1_info()));

const loops = loopsDoc.loops.map(traceLoop);
// Control: the first 29 m of the measured point-to-point path.
const pathDoc = JSON.parse(readFileSync(path.join(ROOT, loopsDoc.inputs.pathDoc.path), 'utf8'));
const controlRows = [];
let controlHits = 0;
let controlMaxStep = 0;
let controlPrev = null;
let controlMissing = 0;
let controlDownRay = 0;
let acc = 0;
let prevPt = null;
for (const sample of pathDoc.samples) {
  if (prevPt) acc += Math.hypot(sample.x - prevPt.x, sample.z - prevPt.z);
  prevPt = sample;
  if (acc > 29 + 1e-9) break;
  let g = ground(sample.x, sample.z);
  if (!g.hit && typeof sample.h === 'number') {
    const r = ray(sample.x, sample.h + 2.0, sample.z, 0, -1, 0, 6.0);
    if (r.hit) {
      g = { hit: true, y: r.point[1] };
      controlDownRay += 1;
    }
  }
  if (!g.hit) { controlRows.push({ arc: acc, hit: false }); controlMissing += 1; controlPrev = null; continue; }
  if (controlPrev !== null) controlMaxStep = Math.max(controlMaxStep, Math.abs(g.y - controlPrev));
  controlPrev = g.y;
  let hits = 0;
  for (const off of [0.20, 1.00]) {
    const hit = ray(sample.x, g.y + off, sample.z, 1, 0, 0, 2.0);
    if (hit.hit) hits += 1;
  }
  controlHits += hits;
  controlRows.push({ arc: Math.round(acc * 1000) / 1000, ground: g.y, hits });
}

module._free(levelPtr);
module._free(fieldsPtr);

const document = {
  kind: 'map-laps.engine-trace',
  version: 1,
  level,
  source: {
    module: '_work/e1-drive/module/e1_drive.mjs',
    moduleWasmSha256: createHash('sha256')
      .update(readFileSync(path.join(E1, 'module/e1_drive.wasm'))).digest('hex'),
    physicsSha256: physicsSha,
    path: '_work/map-laps/' + level + '/loops.json',
    loopsHash: loopsDoc.hash,
    car: car.slug,
  },
  scope: {
    engineIntegration: true,
    vehiclePhysics: false,
    gameRun: false,
    note: 'e1_ray_probe = C_Scene::FillCache + C_LineCollisionCache::Trace (thin ray, radius 0), the same path the wheels use',
  },
  engine: { created: Boolean(createdAt), info: engineInfo },
  loops,
  control29m: {
    source: loopsDoc.inputs.pathDoc.path,
    samples: controlRows.length,
    missingGround: controlMissing,
    downRaySamples: controlDownRay,
    wallHits: controlHits,
    maxStep: controlMaxStep,
    passable: controlHits === 0 && controlMissing === 0,
  },
};
const hash = createHash('sha256').update(JSON.stringify(document)).digest('hex');
document.hash = 'sha256:' + hash;
writeFileSync(path.join(dir, 'engine-trace.json'), JSON.stringify(document, null, 1) + '\n');
console.log(JSON.stringify({
  level,
  loops: loops.map((l) => ({
    id: l.id, samples: l.samples, violations: l.violations.length,
    tightViolations: l.tightViolations.length, minTightClearance: l.minTightClearance,
    maxStep: l.maxStep, maxStepAt: l.maxStepAt, maxGrade: l.maxGrade, maxGradeAt: l.maxGradeAt,
  })),
  control29m: document.control29m,
  hash: document.hash,
}, null, 1));
if (loops.some((l) => l.violations.length)) process.exit(1);
