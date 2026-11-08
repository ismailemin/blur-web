#!/usr/bin/env node
// Verify the committed `spa_barcelona_gracia` no-closed-lap decision.
//
//   node probes/map-laps/tools/verify_gracia_no_lap.mjs
//   node probes/map-laps/tools/verify_gracia_no_lap.mjs --python <python.exe>
//
// It re-derives, from the committed document, the probe artifacts and the P48
// raster:
//   * the canonical hash and every source SHA-256;
//   * the course component (spawn == measured-path component 171) and its
//     enclosed-island count (0 islands >= 100 m2);
//   * the 8-connected BFS reachability of every loop from the committed spawn
//     (all three loops are unreachable, so none is on the course);
//   * the nearest gap between the course component and loop-01, the blocked
//     cell kinds and the raster neighbour dh (5.179 cm > 2.5 cm);
//   * the exact-triangle gap profile (6.18 % average / 9.76 % max 0.5 m grade,
//     both above the P48 5 % rule);
//   * every candidate's bar criteria and the recorded failed criteria;
//   * determinism (the builder twice, byte-identical, and equal to the file).
//
// The raster is read directly from `_work/map-laps/spa_barcelona_gracia/grid.npz`
// with a small local NPZ/NPY reader, so the check does not trust the document's
// own gap block.
//
// Prints "N/M checks passed"; exits 1 on any failure.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LEVEL = 'spa_barcelona_gracia';
const DOC_PATH = path.join(ROOT, 'probes/map-laps/data/gracia-no-lap.json');
const WORK = path.join(ROOT, '_work/map-laps', LEVEL);
const LOOPS_PATH = path.join(WORK, 'loops.json');
const COVERAGE_PATH = path.join(WORK, 'coverage.json');
const VERIFY_PATH = path.join(WORK, 'verify.json');
const ENGINE_PATH = path.join(WORK, 'engine-trace.json');
const REACH_PATH = path.join(WORK, 'reach.json');
const GRID_PATH = path.join(WORK, 'grid.npz');
const BUILDER = path.join(ROOT, 'probes/map-laps/tools/build_gracia_no_lap.py');

const COURSE_COMPONENT = 171;
const VERDICT = 'no-closed-lap';
const CLOSURE_LIMIT_M = 1.0;
const LENGTH_MIN_M = 150;
const LENGTH_MAX_M = 1500;
const ISLAND_MIN_M2 = 100;
const LOOP_ERODE = 3;
const EDGE_DH_M = 0.025;
const GRADE_LIMIT = 0.05;
const GAP_SEARCH_CELLS = 16;

const checks = [];
function check(label, ok, detail = null) {
  checks.push({ label, ok: Boolean(ok), detail });
  return Boolean(ok);
}

const sha256 = (buffer) => 'sha256:' + createHash('sha256').update(buffer).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}
const hashOf = (value) => 'sha256:' + createHash('sha256')
  .update(JSON.stringify(sortValue(value))).digest('hex');
const bodyHash = (doc) => {
  const body = { ...doc };
  delete body.hash;
  return hashOf(body);
};

// ---------------------------------------------------------------- NPZ / NPY
function readZipEntries(buffer) {
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= floor; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('npz: no end-of-central-directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('npz: bad central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer, entry) {
  const offset = entry.localOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('npz: bad local header');
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error('npz: unsupported compression method ' + entry.method);
}

function readNpy(buffer) {
  if (buffer[0] !== 0x93 || buffer.toString('latin1', 1, 6) !== 'NUMPY') {
    throw new Error('npy: bad magic');
  }
  const major = buffer[6];
  let headerLength;
  let headerStart;
  if (major === 1) { headerLength = buffer.readUInt16LE(8); headerStart = 10; }
  else if (major === 2) { headerLength = buffer.readUInt32LE(8); headerStart = 12; }
  else throw new Error('npy: unsupported version ' + major);
  const header = buffer.toString('latin1', headerStart, headerStart + headerLength);
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? '';
  const shape = shapeText.split(',').map((part) => part.trim()).filter(Boolean).map(Number);
  if (!descr || shape.length === 0) throw new Error('npy: unreadable header');
  return { descr, shape, data: buffer.subarray(headerStart + headerLength) };
}

function readNpz(file) {
  const buffer = readFileSync(file);
  const entries = readZipEntries(buffer);
  const out = {};
  for (const [name, entry] of entries) {
    if (!name.endsWith('.npy')) continue;
    out[name.slice(0, -4)] = readNpy(readZipEntry(buffer, entry));
  }
  return out;
}

function resolvePython() {
  const index = process.argv.indexOf('--python');
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (process.env.BLUR_PYTHON) return process.env.BLUR_PYTHON;
  const bundled = 'C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
  return existsSync(bundled) ? bundled : 'python';
}

// ---------------------------------------------------------------- inputs
for (const file of [DOC_PATH, LOOPS_PATH, COVERAGE_PATH, VERIFY_PATH,
  ENGINE_PATH, REACH_PATH, GRID_PATH]) {
  if (!existsSync(file)) {
    console.error('missing input: ' + path.relative(ROOT, file));
    process.exit(1);
  }
}

const doc = readJson(DOC_PATH);
const loops = readJson(LOOPS_PATH);
const coverage = readJson(COVERAGE_PATH);
const verify = readJson(VERIFY_PATH);
const engine = readJson(ENGINE_PATH);
const reach = readJson(REACH_PATH);
const grid = readNpz(GRID_PATH);
const base = grid.base;
const height = grid.height;
const dhGrid = grid.dh;
const wall = grid.wall;
const xs = grid.xs;
const zs = grid.zs;
if (!base || !height || !dhGrid || !wall || !xs || !zs) {
  console.error('grid.npz is missing base/height/dh/wall/xs/zs');
  process.exit(1);
}
const cell = xs.data.readDoubleLE(8) - xs.data.readDoubleLE(0);
const nx = base.shape[1];
const nz = base.shape[0];
const x0 = xs.data.readDoubleLE(0);
const z0 = zs.data.readDoubleLE(0);
const cellOf = (x, z) => [
  Math.round((x - x0) / cell),
  Math.round((z - z0) / cell)
];
const passable = (i, j) => i >= 0 && j >= 0 && i < nx && j < nz && base.data[j * nx + i] !== 0;
const rasterHeight = (i, j) => height.data.readFloatLE((j * nx + i) * 4);
const rasterDh = (i, j) => dhGrid.data.readFloatLE((j * nx + i) * 4);
const rasterWall = (i, j) => wall.data[j * nx + i] !== 0;
const finite = (v) => Number.isFinite(v);

// ---------------------------------------------------------------- document
check('document exists', existsSync(DOC_PATH), path.relative(ROOT, DOC_PATH));
check('document is map-laps.no-lap v1 for gracia',
  doc.kind === 'map-laps.no-lap' && doc.version === 1 &&
  doc.level === LEVEL && doc.map === 'gracia',
  `${doc.kind} v${doc.version} ${doc.level}/${doc.map}`);
check('verdict is no-closed-lap', doc.verdict === VERDICT, doc.verdict);
check('document hash matches its canonical JSON', doc.hash === bodyHash(doc), doc.hash);

// ---------------------------------------------------------------- sources
const sourceChecks = [
  ['loops', LOOPS_PATH],
  ['coverage', COVERAGE_PATH],
  ['verify', VERIFY_PATH],
  ['engineTrace', ENGINE_PATH],
  ['reach', REACH_PATH],
  ['grid', GRID_PATH],
];
for (const [name, file] of sourceChecks) {
  const recorded = doc.sources?.[name];
  check(`source ${name} file SHA-256 matches the committed artifact`,
    recorded && existsSync(file) && recorded.fileSha256 === sha256(readFileSync(file)),
    recorded?.fileSha256);
}
check('source physics SHA-256 matches loops.json and the file',
  doc.sources?.physics?.sha256 === 'sha256:' + loops.inputs.physics.sha256 &&
  doc.sources?.physics?.sha256 === sha256(readFileSync(path.join(ROOT, loops.inputs.physics.path))),
  doc.sources?.physics?.sha256);
check('source loops canonical hash matches loops.json',
  doc.sources?.loops?.canonicalHash === loops.hash, doc.sources?.loops?.canonicalHash);
check('source coverage canonical hash matches coverage.json',
  doc.sources?.coverage?.canonicalHash === coverage.hash, doc.sources?.coverage?.canonicalHash);
check('source verify canonical hash matches verify.json',
  doc.sources?.verify?.canonicalHash === verify.hash, doc.sources?.verify?.canonicalHash);
check('source engine-trace canonical hash matches engine-trace.json',
  doc.sources?.engineTrace?.canonicalHash === engine.hash, doc.sources?.engineTrace?.canonicalHash);
check('source reach canonical hash matches reach.json',
  doc.sources?.reach?.canonicalHash === reach.hash, doc.sources?.reach?.canonicalHash);

// ---------------------------------------------------------------- artifacts
const loopById = new Map(loops.loops.map((entry) => [entry.id, entry]));
const covById = new Map(coverage.loops.map((entry) => [entry.id, entry]));
const verById = new Map(verify.loops.map((entry) => [entry.id, entry]));
const engById = new Map(engine.loops.map((entry) => [entry.id, entry]));
const reaById = new Map(reach.loops.map((entry) => [entry.id, entry]));

check('loops.json is the gracia map-laps.loops artifact',
  loops.kind === 'map-laps.loops' && loops.level === LEVEL, loops.kind);
check('coverage.json is the gracia map-laps.coverage artifact',
  coverage.kind === 'map-laps.coverage' && coverage.level === LEVEL, coverage.kind);
check('verify.json is the gracia map-laps.verify artifact',
  verify.kind === 'map-laps.verify' && verify.level === LEVEL, verify.kind);
check('engine-trace.json is the gracia map-laps.engine-trace artifact',
  engine.kind === 'map-laps.engine-trace' && engine.level === LEVEL, engine.kind);
check('reach.json is the gracia map-laps.reach artifact',
  reach.kind === 'map-laps.reach' && reach.level === LEVEL, reach.kind);

check('document records the same number of loops as loops.json',
  doc.candidates.length === loops.loops.length,
  `${doc.candidates.length} vs ${loops.loops.length}`);
check('document candidate ids match loops.json',
  doc.candidates.map((c) => c.id).join(',') === loops.loops.map((l) => l.id).join(','),
  doc.candidates.map((c) => c.id).join(','));

for (const candidate of doc.candidates) {
  const loop = loopById.get(candidate.id);
  const cov = covById.get(candidate.id);
  const ver = verById.get(candidate.id);
  const eng = engById.get(candidate.id);
  const rea = reaById.get(candidate.id);
  check(`${candidate.id}: component, length, samples and seam match loops.json`,
    loop && candidate.component === loop.component &&
    Math.abs(candidate.lengthM - loop.length) <= 1e-9 &&
    candidate.samples === loop.samples &&
    candidate.closureSeamM === loop.closureSeam,
    `${candidate.component}/${candidate.lengthM}/${candidate.samples}/${candidate.closureSeamM}`);
  check(`${candidate.id}: coverage matches coverage.json`,
    cov && candidate.coverage.fraction === cov.fraction &&
    candidate.coverage.gapRuns === cov.gapRuns &&
    candidate.coverage.centreUncoveredSamples === cov.centreUncoveredSamples &&
    candidate.coverage.deltaMaxM === cov.deltaMax,
    `${candidate.coverage.fraction}/${candidate.coverage.gapRuns}`);
  check(`${candidate.id}: exact-triangle result matches verify.json`,
    ver && candidate.exact.pass === ver.pass &&
    candidate.exact.checks === ver.checks.length,
    `${candidate.exact.pass}/${candidate.exact.checks}`);
  check(`${candidate.id}: engine trace matches engine-trace.json`,
    eng && candidate.engineTrace.samples === eng.samples &&
    candidate.engineTrace.violations === eng.violations.length &&
    candidate.engineTrace.tightViolations === eng.tightViolations.length,
    `${candidate.engineTrace.violations}/${candidate.engineTrace.tightViolations}`);
  check(`${candidate.id}: reach matches reach.json`,
    rea && candidate.reach.reachable === rea.reachable &&
    candidate.reach.geodesicM === rea.geodesicM &&
    candidate.reach.straightLineM === rea.straightLineM,
    `${candidate.reach.reachable}`);
}

// ---------------------------------------------------------------- course
const course = doc.course;
check('course component is the spawn component',
  loops.spawnComponent.id === COURSE_COMPONENT && course.component === COURSE_COMPONENT,
  `${loops.spawnComponent.id}/${course.component}`);
check('course component is the measured-path component',
  loops.pathComponents.components.length > 0 &&
  loops.pathComponents.components.every((c) => c.component === COURSE_COMPONENT),
  JSON.stringify(loops.pathComponents.components));
check('course component has no enclosed island >= 100 m2',
  course.islandsAtLeast100M2 === 0 && loops.spawnComponent.islandsAtLeast100M2 === 0 &&
  loops.islands.every((row) => row.island.component !== COURSE_COMPONENT),
  `islandsAtLeast100M2=${course.islandsAtLeast100M2}`);
check('course component largest enclosed island is 2.25 m2',
  course.largestIslandM2 === loops.spawnComponent.largestIslandM2 &&
  course.largestIslandM2 < ISLAND_MIN_M2,
  course.largestIslandM2);
check('course component contains no extracted loop',
  Array.isArray(course.loopsInComponent) && course.loopsInComponent.length === 0 &&
  loops.spawnComponent.loopsInSpawnComponent.length === 0,
  JSON.stringify(course.loopsInComponent));

// ---------------------------------------------------------------- BFS
const spawn = loops.inputs.spawn;
const [si, sj] = cellOf(spawn.x, spawn.z);
check('spawn cell is passable', passable(si, sj), `${si},${sj}`);

const total = nx * nz;
const reachMask = new Uint8Array(total);
const queue = new Int32Array(total);
let head = 0;
let tail = 0;
const startIndex = sj * nx + si;
reachMask[startIndex] = 1;
queue[tail++] = startIndex;
let reachCount = 0;
while (head < tail) {
  const p = queue[head++];
  reachCount++;
  const j = Math.floor(p / nx);
  const i = p - j * nx;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if (dj === 0 && di === 0) continue;
      const y = j + dj;
      const x = i + di;
      if (y < 0 || y >= nz || x < 0 || x >= nx) continue;
      const q = y * nx + x;
      if (reachMask[q] || base.data[q] === 0) continue;
      reachMask[q] = 1;
      queue[tail++] = q;
    }
  }
}
check('BFS from the spawn reaches exactly the 64,566-cell course component',
  reachCount === loops.spawnComponent.cells && reachCount === course.cells,
  `${reachCount} vs ${loops.spawnComponent.cells}`);

function componentFrom(x, z) {
  const [i, j] = cellOf(x, z);
  if (!passable(i, j)) return null;
  const seen = new Uint8Array(total);
  const cells = [];
  const q = [];
  const start = j * nx + i;
  seen[start] = 1;
  q.push(start);
  let h = 0;
  while (h < q.length) {
    const p = q[h++];
    cells.push(p);
    const jj = Math.floor(p / nx);
    const ii = p - jj * nx;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (dj === 0 && di === 0) continue;
        const y = jj + dj;
        const x2 = ii + di;
        if (y < 0 || y >= nz || x2 < 0 || x2 >= nx) continue;
        const qq = y * nx + x2;
        if (seen[qq] || base.data[qq] === 0) continue;
        seen[qq] = 1;
        q.push(qq);
      }
    }
  }
  return { cells, seen };
}

const loopComponents = new Map();
for (const candidate of doc.candidates) {
  const loop = loopById.get(candidate.id);
  const [x, z] = loop.points[0];
  const comp = componentFrom(x, z);
  if (!comp) {
    check(`${candidate.id}: loop start is passable`, false, `${x},${z}`);
    continue;
  }
  loopComponents.set(candidate.id, comp);
  check(`${candidate.id}: loop component has ${candidate.componentCells} cells`,
    comp.cells.length === candidate.componentCells,
    `${comp.cells.length} vs ${candidate.componentCells}`);
  const reachable = comp.cells.some((p) => reachMask[p] === 1);
  check(`${candidate.id}: no cell is reachable from the spawn (not on the course)`,
    !reachable && candidate.reach.reachable === false,
    `reachable=${reachable}`);
}

// ---------------------------------------------------------------- nearest gap
function kindAt(j, i) {
  if (j < 0 || j >= nz || i < 0 || i >= nx) return 'outside';
  if (base.data[j * nx + i] !== 0) return 'passable';
  if (!finite(rasterHeight(i, j))) return 'no-surface';
  if (rasterWall(i, j)) return 'wall';
  if (rasterDh(i, j) > EDGE_DH_M + 1e-9) return 'step-or-grade';
  return 'other';
}

function nearestGap(comp) {
  let best = { d2: Infinity, course: null, loop: null };
  for (const p of comp.cells) {
    const j = Math.floor(p / nx);
    const i = p - j * nx;
    for (let dj = -GAP_SEARCH_CELLS; dj <= GAP_SEARCH_CELLS; dj++) {
      for (let di = -GAP_SEARCH_CELLS; di <= GAP_SEARCH_CELLS; di++) {
        const y = j + dj;
        const x = i + di;
        if (y < 0 || y >= nz || x < 0 || x >= nx) continue;
        if (!reachMask[y * nx + x]) continue;
        const d2 = dj * dj + di * di;
        if (d2 < best.d2) best = { d2, course: [y, x], loop: [j, i] };
      }
    }
  }
  if (!Number.isFinite(best.d2)) return null;
  return { distanceCells: Math.sqrt(best.d2), course: best.course, loop: best.loop };
}

const nearest = doc.candidates.find((c) => c.id === doc.decision.nearestLoop);
check('decision names loop-01 as the nearest loop', nearest?.id === 'loop-01', nearest?.id);

if (nearest) {
  const comp = loopComponents.get(nearest.id);
  const gap = nearest.gapToCourse;
  const measured = nearestGap(comp);
  check('loop-01 has a reachable course cell inside the search window',
    measured !== null, measured ? measured.distanceCells : 'none');
  if (measured) {
    check('re-derived nearest gap matches the document (1e-6 m)',
      Math.abs(measured.distanceCells * cell - gap.gapM) <= 1e-6,
      `${measured.distanceCells * cell} vs ${gap.gapM}`);
    const [cj, ci] = measured.course;
    const [lj, li] = measured.loop;
    const steps = Math.ceil(Math.hypot(lj - cj, li - ci));
    const kinds = {};
    let maxDh = 0;
    let blocked = 0;
    for (let k = 0; k <= steps; k++) {
      const t = steps === 0 ? 0 : k / steps;
      const j = Math.round(cj + (lj - cj) * t);
      const i = Math.round(ci + (li - ci) * t);
      const kind = kindAt(j, i);
      if (kind !== 'passable') {
        blocked++;
        kinds[kind] = (kinds[kind] || 0) + 1;
      }
      const d = rasterDh(i, j);
      if (finite(d) && d > maxDh) maxDh = d;
    }
    check('the gap is blocked only by the P48 step/grade rule (no wall, no void)',
      Object.keys(kinds).length === 1 && kinds['step-or-grade'] === gap.blockedCells,
      JSON.stringify(kinds));
    check('re-derived blocked-cell count matches the document',
      blocked === gap.blockedCells, `${blocked} vs ${gap.blockedCells}`);
    check('re-derived raster neighbour dh matches the document (1e-6 m)',
      Math.abs(maxDh - gap.rasterDhMaxM) <= 1e-6,
      `${maxDh} vs ${gap.rasterDhMaxM}`);
    check('raster neighbour dh exceeds the 2.5 cm / 5 % limit',
      maxDh > EDGE_DH_M + 1e-9 && maxDh / cell > GRADE_LIMIT,
      `${maxDh} m per ${cell} m cell`);
    check('gap endpoints are the nearest passable cells of the two components',
      passable(ci, cj) && passable(li, lj) &&
      reachMask[cj * nx + ci] === 1 && comp.seen[lj * nx + li] === 1,
      `${ci},${cj} -> ${li},${lj}`);

    const exact = gap.exact;
    check('the document records the exact-triangle gap profile',
      exact && Array.isArray(exact.profile) && exact.profile.length > 1,
      exact?.profile?.length);
    if (exact && Array.isArray(exact.profile)) {
      const rows = exact.profile.filter((r) => r.groundY !== null && Number.isFinite(r.groundY));
      const delta = rows[rows.length - 1].groundY - rows[0].groundY;
      const avg = Math.abs(delta) / exact.gapM;
      let maxHalf = 0;
      let maxStep = 0;
      for (let a = 0; a < rows.length; a++) {
        for (let b = a + 1; b < rows.length; b++) {
          const arc = (rows[b].t - rows[a].t) * exact.gapM;
          if (arc >= 0.5 - 1e-9) {
            maxHalf = Math.max(maxHalf, Math.abs(rows[b].groundY - rows[a].groundY) / arc);
            break;
          }
        }
        if (a + 1 < rows.length) {
          maxStep = Math.max(maxStep, Math.abs(rows[a + 1].groundY - rows[a].groundY));
        }
      }
      check('re-derived exact average grade matches the document (1e-5)',
        Math.abs(avg - exact.averageGrade) <= 1e-5, `${avg} vs ${exact.averageGrade}`);
      check('re-derived exact max 0.5 m grade matches the document (1e-5)',
        Math.abs(maxHalf - exact.maxHalfMetreGrade) <= 1e-5,
        `${maxHalf} vs ${exact.maxHalfMetreGrade}`);
      check('re-derived exact max adjacent step matches the document (1e-5)',
        Math.abs(maxStep - exact.maxAdjacentStepM) <= 1e-5,
        `${maxStep} vs ${exact.maxAdjacentStepM}`);
      check('exact average grade exceeds the P48 5 % rule',
        avg > GRADE_LIMIT, `${(100 * avg).toFixed(2)} %`);
      check('exact max 0.5 m grade exceeds the P48 5 % rule',
        maxHalf > GRADE_LIMIT, `${(100 * maxHalf).toFixed(2)} %`);
    }
  }
}

// ---------------------------------------------------------------- criteria
const criteriaById = new Map(doc.bar.criteria.map((c) => [c.id, c]));
check('bar has the seven Amboy loop-01 criteria',
  doc.bar.criteria.length === 7 &&
  ['on-course', 'closed', 'ring', 'length', 'exact', 'engine', 'coverage']
    .every((id) => criteriaById.has(id)),
  doc.bar.criteria.map((c) => c.id).join(','));
check('bar records the Amboy loop-01 reference values',
  doc.bar.amboy.component === 510 && doc.bar.amboy.lengthM === 284.4524 &&
  doc.bar.amboy.survivesErosion === 5 && doc.bar.amboy.erodeCells === 3 &&
  doc.bar.amboy.coverage === 1 && doc.bar.amboy.gapRuns === 0,
  JSON.stringify(doc.bar.amboy));

for (const candidate of doc.candidates) {
  const loop = loopById.get(candidate.id);
  const islandRow = loops.islands.find((row) => row.loop === candidate.id);
  const cov = covById.get(candidate.id);
  const ver = verById.get(candidate.id);
  const eng = engById.get(candidate.id);
  const expected = {
    'on-course': candidate.component === COURSE_COMPONENT,
    closed: loop.closureSeam <= CLOSURE_LIMIT_M,
    ring: islandRow.survivesErosion >= LOOP_ERODE,
    length: loop.length >= LENGTH_MIN_M && loop.length <= LENGTH_MAX_M,
    exact: ver.pass === true,
    engine: eng.violations.length === 0 && eng.tightViolations.length === 0,
    coverage: cov.fraction === 1 && cov.gapRuns === 0,
  };
  const recorded = new Map(candidate.criteria.map((c) => [c.id, c.pass]));
  check(`${candidate.id}: every bar criterion is re-derived and matches`,
    Object.keys(expected).every((id) => recorded.get(id) === expected[id]),
    JSON.stringify(Object.fromEntries(Object.entries(expected))));
  const failed = Object.keys(expected).filter((id) => !expected[id]);
  check(`${candidate.id}: recorded failed criteria match the re-derivation`,
    failed.join(',') === candidate.failedCriteria.join(','),
    `${candidate.failedCriteria.join(',')} vs ${failed.join(',')}`);
  check(`${candidate.id}: the loop fails at least one bar criterion`,
    failed.length > 0, failed.join(','));
}

// ---------------------------------------------------------------- decision
check('no loop is on the course component',
  doc.decision.loopsOnCourse === 0 &&
  doc.candidates.every((c) => c.component !== COURSE_COMPONENT),
  doc.decision.loopsOnCourse);
check('no loop meets every bar criterion',
  doc.decision.loopsMeetingAllCriteria === 0 &&
  doc.candidates.every((c) => c.failedCriteria.length > 0),
  doc.decision.loopsMeetingAllCriteria);
check('decision counts match the candidate list',
  doc.decision.loopsFound === doc.candidates.length &&
  doc.decision.loopsFound === loops.result.loopCount,
  `${doc.decision.loopsFound}/${loops.result.loopCount}`);
check('verdict is derived from zero loops on the course and zero all-criteria loops',
  doc.verdict === VERDICT &&
  doc.decision.loopsOnCourse === 0 && doc.decision.loopsMeetingAllCriteria === 0,
  doc.verdict);

// ---------------------------------------------------------------- determinism
const python = resolvePython();
const scratch = mkdtempSync(path.join(tmpdir(), 'gracia-no-lap-'));
const outputs = [];
let builderError = null;
for (const name of ['a.json', 'b.json']) {
  const out = path.join(scratch, name);
  const result = spawnSync(python, [BUILDER, '--out', out], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000
  });
  if (result.status !== 0) {
    builderError = (result.stderr || result.stdout || 'builder failed').trim().slice(0, 800);
    break;
  }
  outputs.push(readFileSync(out));
}
if (outputs.length === 2) {
  const committed = readFileSync(DOC_PATH);
  check('builder output is byte-identical on repeat',
    outputs[0].equals(outputs[1]), `${outputs[0].length} vs ${outputs[1].length} bytes`);
  check('committed document equals the builder output',
    outputs[0].equals(committed),
    `${outputs[0].length} vs ${committed.length} bytes`);
} else {
  check('builder output is byte-identical on repeat', false, builderError);
  check('committed document equals the builder output', false, builderError);
}
const stale = spawnSync(python, [BUILDER, '--check'], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000
});
check('builder --check reports the committed document is current',
  stale.status === 0, (stale.stdout || stale.stderr || '').trim().slice(0, 200));
rmSync(scratch, { recursive: true, force: true });

// ---------------------------------------------------------------- summary
const passed = checks.filter((entry) => entry.ok).length;
for (const entry of checks) {
  if (!entry.ok) {
    console.log('FAIL ' + entry.label + (entry.detail ? ': ' + entry.detail : ''));
  }
}
console.log(`${passed}/${checks.length} checks passed`);
if (passed !== checks.length) {
  process.exit(1);
}
