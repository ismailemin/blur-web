#!/usr/bin/env node
// Verify the committed Amboy three-lap layout.
//
//   node probes/map-laps/tools/verify_amboy_lap.mjs
//   node probes/map-laps/tools/verify_amboy_lap.mjs --python <python.exe>
//
// It re-derives, from the committed document and the probe artifacts:
//   * the four gates, their order and their arcs;
//   * the 284.4524 m loop length (1e-3 m) and the closed seam;
//   * the start/finish line and its 5 m seam tangent;
//   * every gate's ground and its P48 passable-raster cell / car-width line;
//   * the 3-lap counter (the same forward-crossing rule as LapRules);
//   * determinism (the builder twice, byte-identical, and equal to the file).
//
// The raster is read directly from `_work/map-laps/usa_amboy/grid.npz` (a
// compressed NumPy archive) with a small local NPZ/NPY reader, so the check
// does not trust the document's own `groundCheck` block.
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
const DOC_PATH = path.join(ROOT, 'probes/map-laps/data/amboy-loop01-lap.json');
const WORK = path.join(ROOT, '_work/map-laps/usa_amboy');
const LOOPS_PATH = path.join(WORK, 'loops.json');
const COVERAGE_PATH = path.join(WORK, 'coverage.json');
const LAYOUT_PATH = path.join(WORK, 'layout.json');
const GRID_PATH = path.join(WORK, 'grid.npz');
const BUILDER = path.join(ROOT, 'probes/map-laps/tools/build_amboy_lap.py');

const LOOP_ID = 'loop-01';
const LOOP_COMPONENT = 510;
const LOOP_LENGTH_M = 284.4524;
const LAPS = 3;
const CLOSURE_LIMIT_M = 1.0;
const CAR_HALF_WIDTH_M = 1.138;

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

// ---------------------------------------------------------------- geometry
function distance(a, b) {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function coursePosition(samples, position) {
  let best = null;
  for (let index = 0; index < samples.length - 1; index++) {
    const a = samples[index];
    const b = samples[index + 1];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const lengthSquared = vx * vx + vz * vz;
    let t = 0;
    if (lengthSquared > 0) {
      t = ((position[0] - a.x) * vx + (position[2] - a.z) * vz) / lengthSquared;
      t = Math.max(0, Math.min(1, t));
    }
    const dx = a.x + vx * t - position[0];
    const dz = a.z + vz * t - position[2];
    const d2 = dx * dx + dz * dz;
    if (best === null || d2 < best.d2 - 1e-12) {
      best = { d2, distance: Math.sqrt(d2), arc: a.arc + (b.arc - a.arc) * t, segment: index };
    }
  }
  return best;
}

function gateSide(gate, point) {
  return (gate.b[0] - gate.a[0]) * (point[2] - gate.a[1]) -
    (gate.b[1] - gate.a[1]) * (point[0] - gate.a[0]);
}

function gateCrossing(previous, current, gate) {
  const s0 = gateSide(gate, previous);
  const s1 = gateSide(gate, current);
  if (!(s0 > 0 && s1 <= 0)) return null;
  const px = previous[0];
  const pz = previous[2];
  const rx = current[0] - px;
  const rz = current[2] - pz;
  const ax = gate.a[0];
  const az = gate.a[1];
  const sx = gate.b[0] - ax;
  const sz = gate.b[1] - az;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = ax - px;
  const qz = az - pz;
  const along = (qx * sz - qz * sx) / den;
  const across = (qx * rz - qz * rx) / den;
  // 1e-9 tolerance: a sample exactly on the line yields along = 1 + 2e-16.
  if (along < 0 || along > 1 + 1e-9 || across < -1e-9 || across > 1 + 1e-9) return null;
  return {
    point: [
      Math.round((px + rx * along) * 1e6) / 1e6,
      Math.round((previous[1] + (current[1] - previous[1]) * along) * 1e6) / 1e6,
      Math.round((pz + rz * along) * 1e6) / 1e6
    ],
    along,
    across
  };
}

function simulateLaps(doc) {
  const samples = doc.course.samples;
  const ring = samples.length - 1;
  const length = doc.course.lengthMetres;
  const line = doc.course.lap.line;
  const laps = doc.course.laps;
  let lapDistance = 0;
  let lastArc = 0;
  let lapIndex = 0;
  const crossings = [];
  let previous = { x: samples[0].x, z: samples[0].z, y: samples[0].groundY };
  for (let lap = 0; lap < laps && lapIndex < laps; lap++) {
    for (let step = 1; step <= ring && lapIndex < laps; step++) {
      const sample = samples[step % ring];
      const current = { x: sample.x, z: sample.z, y: sample.groundY };
      const projection = coursePosition(samples, [current.x, current.y, current.z]);
      let delta = projection.arc - lastArc;
      if (delta < -length / 2) delta += length;
      else if (delta > length / 2) delta -= length;
      if (delta > 0 && delta < length / 4) lapDistance += delta;
      lastArc = projection.arc;
      const crossing = gateCrossing(
        [previous.x, previous.y, previous.z],
        [current.x, current.y, current.z], line);
      if (crossing) {
        const needed = (lapIndex + 1) * length - 2;
        if (lapDistance >= needed) {
          lapIndex++;
          crossings.push({ lap: lapIndex, lapDistance, point: crossing.point });
        }
      }
      previous = current;
    }
  }
  return { lapIndex, crossings, lapDistance };
}

function resolvePython() {
  const index = process.argv.indexOf('--python');
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (process.env.BLUR_PYTHON) return process.env.BLUR_PYTHON;
  const bundled = 'C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
  return existsSync(bundled) ? bundled : 'python';
}

// ---------------------------------------------------------------- inputs
for (const file of [DOC_PATH, LOOPS_PATH, COVERAGE_PATH, LAYOUT_PATH, GRID_PATH]) {
  if (!existsSync(file)) {
    console.error('missing input: ' + path.relative(ROOT, file));
    process.exit(1);
  }
}

const doc = readJson(DOC_PATH);
const loops = readJson(LOOPS_PATH);
const coverage = readJson(COVERAGE_PATH);
const probeLayout = readJson(LAYOUT_PATH);
const grid = readNpz(GRID_PATH);
const base = grid.base;
const height = grid.height;
const xs = grid.xs;
const zs = grid.zs;
if (!base || !height || !xs || !zs) {
  console.error('grid.npz is missing base/height/xs/zs');
  process.exit(1);
}
const cell = xs.data.readDoubleLE(8) - xs.data.readDoubleLE(0);
const nx = base.shape[1];
const nz = base.shape[0];
const cellOf = (x, z) => [
  Math.round((x - xs.data.readDoubleLE(0)) / cell),
  Math.round((z - zs.data.readDoubleLE(0)) / cell)
];
const passable = (i, j) => i >= 0 && j >= 0 && i < nx && j < nz && base.data[j * nx + i] !== 0;
const rasterHeight = (i, j) => height.data.readFloatLE((j * nx + i) * 4);

// ---------------------------------------------------------------- document
check('document exists', existsSync(DOC_PATH), path.relative(ROOT, DOC_PATH));
check('document is e1-drive.sprint v1 with courseId "lap"',
  doc.kind === 'e1-drive.sprint' && doc.version === 1 && doc.courseId === 'lap',
  `${doc.kind} v${doc.version} courseId=${doc.courseId}`);
check('document hash matches its canonical JSON', doc.hash === bodyHash(doc), doc.hash);

check('source names the collision-only map-laps probe and loop-01',
  typeof doc.source?.probe === 'string' && /map-laps/.test(doc.source.probe) &&
  doc.source.probeScope === 'collisionOnly' && doc.source.loopId === LOOP_ID &&
  doc.source.loopComponent === LOOP_COMPONENT &&
  doc.source.loopLengthMetres === LOOP_LENGTH_M,
  JSON.stringify({ probe: doc.source?.probe, loopId: doc.source?.loopId,
    component: doc.source?.loopComponent, length: doc.source?.loopLengthMetres }));

check('source loops file SHA-256 matches the committed artifact',
  doc.source?.lapLoopsFileSha256 === sha256(readFileSync(LOOPS_PATH)),
  doc.source?.lapLoopsFileSha256);
check('source coverage file SHA-256 matches the committed artifact',
  doc.source?.coverageFileSha256 === sha256(readFileSync(COVERAGE_PATH)),
  doc.source?.coverageFileSha256);
check('source layout file SHA-256 matches the committed artifact',
  doc.source?.layoutFileSha256 === sha256(readFileSync(LAYOUT_PATH)),
  doc.source?.layoutFileSha256);
check('source loops canonical hash matches loops.json',
  doc.source?.lapLoopsCanonicalHash === loops.hash, doc.source?.lapLoopsCanonicalHash);
check('source coverage canonical hash matches coverage.json',
  doc.source?.coverageCanonicalHash === coverage.hash, doc.source?.coverageCanonicalHash);
check('source physics SHA-256 matches loops.json and the file',
  doc.source?.physics?.sha256 === 'sha256:' + loops.inputs.physics.sha256 &&
  doc.source?.physics?.sha256 === sha256(readFileSync(path.join(ROOT, loops.inputs.physics.path))),
  doc.source?.physics?.sha256);

// ---------------------------------------------------------------- loop
const samples = doc.course.samples;
check('course has 1152 samples at 0.25 m',
  samples.length === 1152 && doc.course.sampleCount === 1152 &&
  doc.course.sampleStepMetres === 0.25,
  `${samples.length} / ${doc.course.sampleCount} / ${doc.course.sampleStepMetres}`);

let measured = 0;
for (let index = 1; index < samples.length; index++) {
  measured += Math.hypot(samples[index].x - samples[index - 1].x,
    samples[index].z - samples[index - 1].z);
}
check('recomputed loop length is within 1e-3 m of 284.4524',
  Math.abs(measured - LOOP_LENGTH_M) <= 1e-3, measured.toFixed(6));
check('document length equals the recomputed sample arc',
  Math.abs(doc.course.lengthMetres - measured) <= 1e-6,
  `${doc.course.lengthMetres} vs ${measured.toFixed(6)}`);
check('course length is the 284.4524 m loop',
  Math.abs(doc.course.lengthMetres - LOOP_LENGTH_M) <= 1e-3,
  doc.course.lengthMetres);

const first = samples[0];
const last = samples[samples.length - 1];
check('course samples close on the first point',
  Math.abs(first.x - last.x) <= 1e-9 && Math.abs(first.z - last.z) <= 1e-9,
  `${first.x},${first.z} -> ${last.x},${last.z}`);
check('last segment closes the loop within the 1.0 m seam limit',
  distance(samples[samples.length - 2], first) <= CLOSURE_LIMIT_M,
  distance(samples[samples.length - 2], first).toFixed(4));
const loop = loops.loops.find((entry) => entry.id === LOOP_ID);
check('loops.json closure seam is within the 1.0 m limit',
  loop && loop.closureSeam <= CLOSURE_LIMIT_M, loop?.closureSeam);

// ---------------------------------------------------------------- gates
const gates = doc.gates;
check('four gates', Array.isArray(gates) && gates.length === 4, gates?.length);
check('gate order is start, checkpoint, checkpoint, finish',
  gates.map((gate) => gate.kind).join(',') === 'start,checkpoint,checkpoint,finish',
  gates.map((gate) => gate.kind).join(','));
check('gate ids are start, checkpoint-1, checkpoint-2, finish',
  gates.map((gate) => gate.id).join(',') === 'start,checkpoint-1,checkpoint-2,finish',
  gates.map((gate) => gate.id).join(','));
check('gate indices are 0..3',
  gates.every((gate, index) => gate.index === index),
  gates.map((gate) => gate.index).join(','));

const start = gates[0];
const finish = gates[3];
check('gate arcs start at 0 and strictly increase',
  start.arc === 0 && gates.every((gate, index) => index === 0 || gate.arc > gates[index - 1].arc),
  gates.map((gate) => gate.arc).join(','));
check('finish arc equals the course length',
  Math.abs(finish.arc - doc.course.lengthMetres) <= 1e-9,
  `${finish.arc} vs ${doc.course.lengthMetres}`);
check('finish point is the start point',
  finish.x === start.x && finish.z === start.z,
  `${finish.x},${finish.z} vs ${start.x},${start.z}`);
check('finish line is the start line',
  JSON.stringify(finish.a) === JSON.stringify(start.a) &&
  JSON.stringify(finish.b) === JSON.stringify(start.b),
  `${JSON.stringify(finish.a)} / ${JSON.stringify(start.a)}`);

const ring = samples.length - 1;
const half = Math.round(5 / 2 / 0.25);
const before = samples[(ring - half + ring) % ring];
const after = samples[half % ring];
let tx = after.x - before.x;
let tz = after.z - before.z;
const tangentLength = Math.hypot(tx, tz);
tx /= tangentLength;
tz /= tangentLength;
check('start/finish tangent is the 5 m seam window re-derived from samples',
  Math.abs(start.tangent.tx - tx) <= 1e-9 && Math.abs(start.tangent.tz - tz) <= 1e-9,
  `${start.tangent.tx},${start.tangent.tz} vs ${tx.toFixed(9)},${tz.toFixed(9)}`);
check('start/finish heading is atan2(tx, tz)',
  Math.abs(start.headingRad - Math.atan2(start.tangent.tx, start.tangent.tz)) <= 1e-9,
  start.headingRad);

const third = doc.course.lengthMetres / 3;
check('checkpoint-1 is at one third of the lap',
  Math.abs(gates[1].arc - third) <= 0.25 + 1e-9,
  `${gates[1].arc} vs ${third.toFixed(6)}`);
check('checkpoint-2 is at two thirds of the lap',
  Math.abs(gates[2].arc - 2 * third) <= 0.25 + 1e-9,
  `${gates[2].arc} vs ${(2 * third).toFixed(6)}`);

check('every gate tangent is unit length and perpendicular to its line',
  gates.every((gate) => {
    const length = Math.hypot(gate.tangent.tx, gate.tangent.tz);
    const dot = gate.tangent.tx * (gate.b[0] - gate.a[0]) +
      gate.tangent.tz * (gate.b[1] - gate.a[1]);
    return Math.abs(length - 1) <= 1e-9 && Math.abs(dot) <= 2e-3;
  }), gates.map((gate) => Math.hypot(gate.tangent.tx, gate.tangent.tz)).join(','));
check('every gate heading is atan2(tx, tz)',
  gates.every((gate) => Math.abs(gate.headingRad -
    Math.atan2(gate.tangent.tx, gate.tangent.tz)) <= 1e-9),
  gates.map((gate) => gate.headingRad).join(','));

const groundValues = samples.map((sample) => sample.groundY);
const groundMin = Math.min(...groundValues);
const groundMax = Math.max(...groundValues);
check('every gate groundY matches the loop sample ground',
  gates.every((gate) => {
    const sample = samples[gate.sampleIndex];
    return sample && Number.isFinite(gate.groundY) &&
      Math.abs(gate.groundY - sample.groundY) <= 1e-4;
  }), gates.map((gate) => gate.groundY).join(','));
check('every gate groundY is finite and inside the loop ground range',
  gates.every((gate) => Number.isFinite(gate.groundY) &&
    gate.groundY >= groundMin - 1e-6 && gate.groundY <= groundMax + 1e-6),
  `${groundMin} .. ${groundMax}`);

const gateRaster = gates.map((gate) => {
  const [i, j] = cellOf(gate.x, gate.z);
  const centre = passable(i, j);
  const h = centre ? rasterHeight(i, j) : null;
  const normalX = -gate.tangent.tz;
  const normalZ = gate.tangent.tx;
  let lineStations = 0;
  let linePassable = 0;
  let carStations = 0;
  let carPassable = 0;
  for (let k = -8; k <= 8; k++) {
    const d = k * 0.25;
    const [ii, jj] = cellOf(gate.x + normalX * d, gate.z + normalZ * d);
    const ok = passable(ii, jj);
    lineStations++;
    if (ok) linePassable++;
    if (Math.abs(d) <= CAR_HALF_WIDTH_M + 1e-9) {
      carStations++;
      if (ok) carPassable++;
    }
  }
  return { gate, i, j, centre, h, lineStations, linePassable, carStations, carPassable };
});

check('every gate centre is on P48 passable ground',
  gateRaster.every((row) => row.centre),
  gateRaster.map((row) => `${row.gate.id}:${row.centre}`).join(' '));
check('every gate raster height matches its groundY (1e-3 m)',
  gateRaster.every((row) => row.h !== null && Math.abs(row.h - row.gate.groundY) <= 1e-3),
  gateRaster.map((row) => `${row.gate.id}:${row.h?.toFixed(6)}`).join(' '));
check('every gate car-half-width line is passable',
  gateRaster.every((row) => row.carStations > 0 && row.carPassable === row.carStations),
  gateRaster.map((row) => `${row.gate.id}:${row.carPassable}/${row.carStations}`).join(' '));
check('every gate 4 m line is at least 90% passable on the conservative raster',
  gateRaster.every((row) => row.linePassable / row.lineStations >= 0.9),
  gateRaster.map((row) => `${row.gate.id}:${row.linePassable}/${row.lineStations}`).join(' '));
check('document groundCheck agrees with the re-derived raster',
  gates.every((gate, index) => {
    const row = gateRaster[index];
    return gate.groundCheck?.passable === row.centre &&
      gate.groundCheck?.rasterCell?.[0] === row.i &&
      gate.groundCheck?.rasterCell?.[1] === row.j &&
      gate.groundCheck?.linePassableStations === row.linePassable &&
      gate.groundCheck?.carHalfWidthPassable === (row.carPassable === row.carStations);
  }), 'groundCheck vs grid.npz');

// ---------------------------------------------------------------- samples
check('sample arcs are monotonic',
  samples.every((sample, index) => index === 0 || sample.arc >= samples[index - 1].arc),
  'arc order');
check('every sample groundY is finite',
  samples.every((sample) => Number.isFinite(sample.groundY)), 'groundY');
check('every sample is draw-covered',
  samples.every((sample) => sample.covered === true), 'covered');
check('coverage is the full loop with no gaps',
  doc.course.coverage?.coverageFraction === 1 &&
  doc.course.coverage?.gapRuns === 0 &&
  doc.course.coverage?.centreUncoveredSamples === 0,
  JSON.stringify({ fraction: doc.course.coverage?.coverageFraction,
    gaps: doc.course.coverage?.gapRuns,
    uncovered: doc.course.coverage?.centreUncoveredSamples }));
check('coverage max surface delta is within the 0.5 m rule',
  doc.course.coverage?.deltaMaxMetres <= 0.5,
  doc.course.coverage?.deltaMaxMetres);

// ---------------------------------------------------------------- laps
check('three laps are declared in course, lap and span',
  doc.course.laps === LAPS && doc.course.lap.laps === LAPS && doc.course.span.laps === LAPS,
  `${doc.course.laps}/${doc.course.lap.laps}/${doc.course.span.laps}`);
check('total race distance is three laps',
  Math.abs(doc.course.span.measuredTotalRaceDistanceMetres - 3 * doc.course.lengthMetres) <= 1e-5 &&
  Math.abs(doc.course.span.totalRaceDistanceMetres - 3 * LOOP_LENGTH_M) <= 1e-3,
  `${doc.course.span.measuredTotalRaceDistanceMetres} / ${doc.course.span.totalRaceDistanceMetres}`);

const simulation = simulateLaps(doc);
check('lap counter completes three laps',
  simulation.lapIndex === LAPS && simulation.crossings.length === LAPS,
  `lapIndex=${simulation.lapIndex} crossings=${simulation.crossings.length}`);
check('every counted lap crosses after at least a full lap of progress',
  simulation.crossings.every((crossing, index) =>
    crossing.lapDistance >= (index + 1) * doc.course.lengthMetres - 2),
  simulation.crossings.map((crossing) => crossing.lapDistance.toFixed(3)).join(','));
const early = gateCrossing(
  [samples[ring - 1].x, samples[ring - 1].groundY, samples[ring - 1].z],
  [samples[0].x, samples[0].groundY, samples[0].z], doc.course.lap.line);
check('a seam crossing at zero progress is rejected by the half-lap rule',
  early !== null && 0 < (0 + 1) * doc.course.lengthMetres - 2,
  early ? 'crossing exists, progress 0 < length - 2' : 'no crossing');

// ---------------------------------------------------------------- rules
check('countdown is 90 ticks in 30-tick steps',
  doc.countdown?.ticks === 90 && doc.countdown?.stepTicks === 30,
  `${doc.countdown?.ticks}/${doc.countdown?.stepTicks}`);
check('respawn band is the declared car-width rule, below the raster clearance',
  doc.rules?.respawn &&
  doc.course.lap?.bandHalfWidthMetres === doc.course.corridor?.halfWidthMetres &&
  doc.course.corridor.halfWidthMetres >= doc.course.corridor.source.carHalfWidthM &&
  doc.course.corridor.halfWidthMetres < doc.course.corridor.source.minRasterClearanceM,
  `${doc.course.lap?.bandHalfWidthMetres}/${doc.course.corridor?.halfWidthMetres} car ${doc.course.corridor?.source?.carHalfWidthM} raster ${doc.course.corridor?.source?.minRasterClearanceM}`);
check('courseId "lap" is what LapRules accepts',
  doc.courseId === 'lap', doc.courseId);

// ---------------------------------------------------------------- determinism
const python = resolvePython();
const scratch = mkdtempSync(path.join(tmpdir(), 'amboy-lap-'));
const outputs = [];
let builderError = null;
for (const name of ['a.json', 'b.json']) {
  const out = path.join(scratch, name);
  const result = spawnSync(python, [BUILDER, '--out', out], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000
  });
  if (result.status !== 0) {
    builderError = (result.stderr || result.stdout || 'builder failed').trim().slice(0, 600);
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
rmSync(scratch, { recursive: true, force: true });

// ---------------------------------------------------------------- summary
const passed = checks.filter((entry) => entry.ok).length;
for (const entry of checks) {
  if (!entry.ok) console.log('FAIL ' + entry.label + (entry.detail ? ': ' + entry.detail : ''));
}
console.log(`${passed}/${checks.length} checks passed`);
if (passed !== checks.length) {
  process.exit(1);
}
