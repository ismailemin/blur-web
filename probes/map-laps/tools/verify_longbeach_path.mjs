#!/usr/bin/env node
// Verify the committed Long Beach collision-clear point-to-point path.
//
//   node probes/map-laps/tools/verify_longbeach_path.mjs
//   node probes/map-laps/tools/verify_longbeach_path.mjs --python <python.exe>
//
// It re-derives, from the committed document, the P48 raster and the committed
// collision triangles:
//   * the document hash, kind, courseId and scope labels;
//   * the source physics / raster / draw-path / slice-collision hashes;
//   * every 0.25 m sample: passable cell, raster ground, >= the stated clearance
//     to the nearest blocked cell, and a passable car-half-width perpendicular;
//   * the length, the start/finish poses and the four gates (order, arcs,
//     positions, lines, ground, car-width line);
//   * the recorded 226.8 m curb: the exact triangles exist in the committed
//     collision buffer, and the path clears them by the stated margin;
//   * determinism: the builder twice, byte-identical, and equal to the file.
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
const DOC_PATH = path.join(ROOT, 'probes/map-laps/data/longbeach-path.json');
const GRID_PATH = path.join(ROOT, '_work/map-laps/longbeach/grid.npz');
const PHYSICS_PATH = path.join(ROOT, 'game-data/Blur/levels/usa_la_longbeachdocks/Level.levelphysics');
const DRAW_PATH = path.join(ROOT, 'probes/map-laps/data/longbeach-draw-layout.json');
const SLICE_POS = path.join(ROOT, '_work/map-slice/longbeach/collision.positions.f32.bin');
const SLICE_IDX = path.join(ROOT, '_work/map-slice/longbeach/collision.indices.u32.bin');
const BUILDER = path.join(ROOT, 'probes/map-laps/tools/build_longbeach_path.py');

const START = [-519.0, 111.0];
const FINISH = [-432.0, -86.0];
const START_HEADING = -2.35619449;
const FINISH_HEADING = 0.7853990838305359;
const STOP_POSE = [-714.73, 49.19];
const DRAW_STOP_ARC = 226.816017;
const CAR_HALF_WIDTH = 1.138;
const CAR_CIRCUMRADIUS = 2.1246;
const SAMPLE_STEP = 0.25;
const BAND_HALF_WIDTH = 6.0;

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

function segmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = 0;
  if (l2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function resolvePython() {
  const index = process.argv.indexOf('--python');
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (process.env.BLUR_PYTHON) return process.env.BLUR_PYTHON;
  const bundled = 'C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
  return existsSync(bundled) ? bundled : 'python';
}

// ---------------------------------------------------------------- inputs
for (const file of [DOC_PATH, GRID_PATH, PHYSICS_PATH, DRAW_PATH, SLICE_POS, SLICE_IDX]) {
  if (!existsSync(file)) {
    console.error('missing input: ' + path.relative(ROOT, file));
    process.exit(1);
  }
}

const doc = readJson(DOC_PATH);
const draw = readJson(DRAW_PATH);
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

function nearestBlockedDistance(i, j, radius = 30) {
  let best = radius * cell;
  const j0 = Math.max(0, j - radius);
  const j1 = Math.min(nz, j + radius + 1);
  const i0 = Math.max(0, i - radius);
  const i1 = Math.min(nx, i + radius + 1);
  for (let jj = j0; jj < j1; jj++) {
    for (let ii = i0; ii < i1; ii++) {
      if (base.data[jj * nx + ii] !== 0) continue;
      const d = Math.hypot((ii - i) * cell, (jj - j) * cell);
      if (d < best) best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------- document
check('document exists', existsSync(DOC_PATH), path.relative(ROOT, DOC_PATH));
check('document is e1-drive.sprint v1 with courseId "longbeach"',
  doc.kind === 'e1-drive.sprint' && doc.version === 1 && doc.courseId === 'longbeach',
  `${doc.kind} v${doc.version} courseId=${doc.courseId}`);
check('document hash matches its canonical JSON', doc.hash === bodyHash(doc), doc.hash);

check('scope is collision-only with no renderer/vehicle/game/driven claim',
  doc.scope?.collisionOnly === true && doc.scope?.drawGeometryRead === false &&
  doc.scope?.rendererClaim === false && doc.scope?.vehiclePhysics === false &&
  doc.scope?.gameRun === false && doc.scope?.pathDriven === false,
  JSON.stringify(doc.scope));
check('source names the collision probe and the level',
  doc.source?.probe === 'probes/map-laps (collision-only point-to-point path)' &&
  doc.source?.probeScope === 'collisionOnly' &&
  doc.source?.level === 'usa_la_longbeachdocks' &&
  doc.source?.map === 'longbeach',
  JSON.stringify({ probe: doc.source?.probe, level: doc.source?.level }));

const physicsBytes = readFileSync(PHYSICS_PATH);
check('source physics SHA-256 matches the committed Level.levelphysics',
  doc.source?.physics?.sha256 === sha256(physicsBytes) &&
  doc.source?.physics?.bytes === physicsBytes.length,
  doc.source?.physics?.sha256);
check('source raster SHA-256 matches grid.npz',
  doc.source?.raster?.fileSha256 === sha256(readFileSync(GRID_PATH)),
  doc.source?.raster?.fileSha256);
check('source draw-path SHA-256 and canonical hash match the committed layout',
  doc.source?.corridor?.drawPathFileSha256 === sha256(readFileSync(DRAW_PATH)) &&
  doc.source?.corridor?.drawPathCanonicalHash === draw.hash,
  doc.source?.corridor?.drawPathFileSha256);
check('source render/slice content hashes match the committed package',
  doc.source?.render?.contentHash === draw.source?.render?.contentHash &&
  doc.source?.slice?.contentHash === draw.source?.slice?.contentHash &&
  doc.source?.render?.sha256 === draw.source?.render?.sha256 &&
  doc.source?.slice?.sha256 === draw.source?.slice?.sha256,
  JSON.stringify({ render: doc.source?.render?.contentHash,
    slice: doc.source?.slice?.contentHash }));
check('source slice collision SHAs match the committed triangle buffers',
  doc.source?.sliceCollision?.positions?.sha256 === sha256(readFileSync(SLICE_POS)) &&
  doc.source?.sliceCollision?.indices?.sha256 === sha256(readFileSync(SLICE_IDX)) &&
  doc.source?.sliceCollision?.positions?.bytes === readFileSync(SLICE_POS).length &&
  doc.source?.sliceCollision?.indices?.bytes === readFileSync(SLICE_IDX).length,
  JSON.stringify({ positions: doc.source?.sliceCollision?.positions?.sha256,
    indices: doc.source?.sliceCollision?.indices?.sha256 }));

check('grid is a 0.5 m raster with base/height/xs/zs',
  Math.abs(cell - 0.5) <= 1e-12 && base.shape.length === 2 &&
  height.shape[0] === nz && height.shape[1] === nx &&
  xs.shape[0] === nx && zs.shape[0] === nz,
  `${base.shape.join('x')} cell ${cell}`);
check('source clearance is an integer cell count with a 6.0 m lower bound',
  Number.isInteger(doc.source?.clearance?.cells) && doc.source.clearance.cells === 12 &&
  doc.source.clearance.lowerBoundMetres === 6 &&
  doc.source.clearance.carHalfWidthM === CAR_HALF_WIDTH,
  JSON.stringify(doc.source?.clearance));

// ---------------------------------------------------------------- samples
const samples = doc.course.samples;
check('course has 0.25 m samples and a matching sampleCount',
  Array.isArray(samples) && samples.length === doc.course.sampleCount &&
  doc.course.sampleStepMetres === SAMPLE_STEP,
  `${samples.length} / ${doc.course.sampleCount} / ${doc.course.sampleStepMetres}`);

let measured = 0;
for (let index = 1; index < samples.length; index++) {
  measured += Math.hypot(samples[index].x - samples[index - 1].x,
    samples[index].z - samples[index - 1].z);
}
check('recomputed sample length equals course.lengthMetres (1e-6 m)',
  Math.abs(measured - doc.course.lengthMetres) <= 1e-6,
  `${measured.toFixed(6)} vs ${doc.course.lengthMetres}`);
check('course length is positive and recorded in span/finishArc',
  doc.course.lengthMetres > 0 &&
  Math.abs(doc.course.span.finishArc - doc.course.lengthMetres) <= 1e-9 &&
  Math.abs(doc.course.finishArc - doc.course.lengthMetres) <= 1e-9,
  doc.course.lengthMetres);

const first = samples[0];
const last = samples[samples.length - 1];
check('first sample is the committed start (-519, 111)',
  Math.abs(first.x - START[0]) <= 1e-6 && Math.abs(first.z - START[1]) <= 1e-6,
  `${first.x},${first.z}`);
check('last sample is the committed finish (-432, -86)',
  Math.abs(last.x - FINISH[0]) <= 1e-6 && Math.abs(last.z - FINISH[1]) <= 1e-6,
  `${last.x},${last.z}`);
check('first sample arc is 0 and the last arc is the course length',
  first.arc === 0 && Math.abs(last.arc - doc.course.lengthMetres) <= 1e-9,
  `${first.arc} .. ${last.arc}`);
check('sample arcs are monotonic',
  samples.every((sample, index) => index === 0 || sample.arc >= samples[index - 1].arc),
  'arc order');
check('no sample carries a draw-coverage claim',
  samples.every((sample) => sample.covered === null) &&
  doc.course.coverage?.measured === false,
  JSON.stringify(doc.course.coverage));

const startHeading = Math.atan2(samples[1].x - samples[0].x, samples[1].z - samples[0].z);
const finishHeading = Math.atan2(last.x - samples[samples.length - 2].x,
  last.z - samples[samples.length - 2].z);
check('start heading is the committed -2.35619449 rad',
  Math.abs(startHeading - START_HEADING) <= 1e-6 &&
  Math.abs(doc.course.spawn.headingRad - START_HEADING) <= 1e-6,
  `${startHeading.toFixed(9)} / ${doc.course.spawn.headingRad}`);
check('finish heading is the committed 0.785399 rad',
  Math.abs(finishHeading - FINISH_HEADING) <= 1e-6,
  finishHeading.toFixed(9));

const statedMargin = doc.source.clearance.lowerBoundMetres;
let minClearance = Infinity;
let minClearanceAt = null;
let badCell = 0;
let badGround = 0;
let badCarLine = 0;
let badCarLineAt = null;
for (let index = 0; index < samples.length; index++) {
  const sample = samples[index];
  const [i, j] = cellOf(sample.x, sample.z);
  if (!passable(i, j)) { badCell++; continue; }
  if (Math.abs(rasterHeight(i, j) - sample.groundY) > 1e-3) badGround++;
  const clearance = nearestBlockedDistance(i, j);
  if (clearance < minClearance) { minClearance = clearance; minClearanceAt = index; }
  const a = samples[Math.max(0, index - 1)];
  const b = samples[Math.min(samples.length - 1, index + 1)];
  let tx = b.x - a.x;
  let tz = b.z - a.z;
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl; tz /= tl;
  const nxv = -tz;
  const nzv = tx;
  for (const d of [-CAR_HALF_WIDTH, -0.838, -0.419, 0, 0.419, 0.838, CAR_HALF_WIDTH]) {
    const [ii, jj] = cellOf(sample.x + nxv * d, sample.z + nzv * d);
    if (!passable(ii, jj)) { badCarLine++; badCarLineAt = index; break; }
  }
}
check('every sample centre is on P48 passable ground', badCell === 0, `${badCell} bad cells`);
check('every sample groundY matches the raster H (1e-3 m)', badGround === 0, `${badGround} bad grounds`);
check('every sample clears the stated 6.0 m margin to the nearest blocked cell',
  minClearance >= statedMargin - 1e-9,
  `min ${minClearance.toFixed(3)} m at sample ${minClearanceAt}`);
check('every sample car-half-width perpendicular is passable',
  badCarLine === 0, `${badCarLine} bad samples, first ${badCarLineAt}`);

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
check('finish point is the committed finish point',
  Math.abs(finish.x - FINISH[0]) <= 1e-6 && Math.abs(finish.z - FINISH[1]) <= 1e-6,
  `${finish.x},${finish.z}`);
check('checkpoint-1 is at one third of the measured arc (0.25 m)',
  Math.abs(gates[1].arc - doc.course.lengthMetres / 3) <= SAMPLE_STEP + 1e-9,
  `${gates[1].arc} vs ${(doc.course.lengthMetres / 3).toFixed(6)}`);
check('checkpoint-2 is at two thirds of the measured arc (0.25 m)',
  Math.abs(gates[2].arc - 2 * doc.course.lengthMetres / 3) <= SAMPLE_STEP + 1e-9,
  `${gates[2].arc} vs ${(2 * doc.course.lengthMetres / 3).toFixed(6)}`);

check('every gate position equals its sample',
  gates.every((gate) => {
    const sample = samples[gate.sampleIndex];
    return sample && Math.abs(gate.x - sample.x) <= 1e-6 &&
      Math.abs(gate.z - sample.z) <= 1e-6 &&
      Math.abs(gate.arc - sample.arc) <= 1e-6 &&
      Math.abs(gate.groundY - sample.groundY) <= 1e-4;
  }), gates.map((gate) => `${gate.id}:${gate.sampleIndex}`).join(' '));
check('every gate tangent is unit length and perpendicular to its line',
  gates.every((gate) => {
    const length = Math.hypot(gate.tangent.tx, gate.tangent.tz);
    const dot = gate.tangent.tx * (gate.b[0] - gate.a[0]) +
      gate.tangent.tz * (gate.b[1] - gate.a[1]);
    return Math.abs(length - 1) <= 1e-9 && Math.abs(dot) <= 2e-3;
  }), gates.map((gate) => Math.hypot(gate.tangent.tx, gate.tangent.tz).toFixed(9)).join(','));
check('every gate heading is atan2(tx, tz)',
  gates.every((gate) => Math.abs(gate.headingRad -
    Math.atan2(gate.tangent.tx, gate.tangent.tz)) <= 1e-9),
  gates.map((gate) => gate.headingRad).join(','));

const gateRaster = gates.map((gate) => {
  const [i, j] = cellOf(gate.x, gate.z);
  const centre = passable(i, j);
  const h = centre ? rasterHeight(i, j) : null;
  const nxv = -gate.tangent.tz;
  const nzv = gate.tangent.tx;
  let lineStations = 0;
  let linePassable = 0;
  let carStations = 0;
  let carPassable = 0;
  for (let k = -16; k <= 16; k++) {
    const d = k * 0.25;
    const [ii, jj] = cellOf(gate.x + nxv * d, gate.z + nzv * d);
    const ok = passable(ii, jj);
    lineStations++;
    if (ok) linePassable++;
    if (Math.abs(d) <= CAR_HALF_WIDTH + 1e-9) {
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
check('every gate 8 m line is at least 90% passable on the conservative raster',
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

// ---------------------------------------------------------------- obstruction
const positionsBuffer = readFileSync(SLICE_POS);
const indicesBuffer = readFileSync(SLICE_IDX);
const positions = new Float32Array(positionsBuffer.buffer, positionsBuffer.byteOffset,
  positionsBuffer.length / 4);
const indices = new Uint32Array(indicesBuffer.buffer, indicesBuffer.byteOffset,
  indicesBuffer.length / 4);
const vertex = (index) => [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
const obstruction = doc.source.obstruction;
check('obstruction records the committed stop pose and two curb segments',
  obstruction?.stopPose?.x === STOP_POSE[0] && obstruction?.stopPose?.z === STOP_POSE[1] &&
  Array.isArray(obstruction?.segments) && obstruction.segments.length === 2,
  JSON.stringify(obstruction?.stopPose));

let triangleFailures = 0;
let coveredSegments = 0;
for (const segment of obstruction.segments) {
  const [ax, az] = segment.a;
  const [bx, bz] = segment.b;
  const segmentLength = Math.hypot(bx - ax, bz - az);
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const triangleIndex of segment.triangles) {
    const tri = [vertex(indices[triangleIndex * 3]),
      vertex(indices[triangleIndex * 3 + 1]),
      vertex(indices[triangleIndex * 3 + 2])];
    for (const point of tri) {
      const along = ((point[0] - ax) * (bx - ax) + (point[2] - az) * (bz - az)) / segmentLength;
      const across = Math.abs((point[0] - ax) * (bz - az) - (point[2] - az) * (bx - ax)) / segmentLength;
      if (across > 1e-3) triangleFailures++;
      minAlong = Math.min(minAlong, along);
      maxAlong = Math.max(maxAlong, along);
      yMin = Math.min(yMin, point[1]);
      yMax = Math.max(yMax, point[1]);
    }
  }
  if (minAlong <= 1e-3 && maxAlong >= segmentLength - 1e-3 &&
      Math.abs(yMin - segment.yMin) <= 1e-3 && Math.abs(yMax - segment.yMax) <= 1e-3) {
    coveredSegments++;
  }
}
check('the recorded obstruction triangles exist in the committed collision buffer',
  triangleFailures === 0 && coveredSegments === 2,
  `${triangleFailures} off-segment vertices, ${coveredSegments}/2 segments covered`);

let pathDistance = Infinity;
let pathDistanceAt = null;
for (let index = 0; index < samples.length; index++) {
  const sample = samples[index];
  for (const segment of obstruction.segments) {
    const d = segmentDistance(sample.x, sample.z,
      segment.a[0], segment.a[1], segment.b[0], segment.b[1]);
    if (d < pathDistance) { pathDistance = d; pathDistanceAt = index; }
  }
}
check('the path clears the recorded curb by the stated 6.0 m margin',
  pathDistance >= obstruction.statedMarginM - 1e-9,
  `${pathDistance.toFixed(3)} m at sample ${pathDistanceAt}`);
check('the recorded path clearance matches the document',
  Math.abs(pathDistance - obstruction.pathDistanceM) <= 1e-3 &&
  pathDistanceAt === obstruction.pathClosestSample,
  `${pathDistance.toFixed(4)} vs ${obstruction.pathDistanceM}`);

let drawDistance = Infinity;
for (const sample of draw.course.samples) {
  for (const segment of obstruction.segments) {
    const d = segmentDistance(sample.x, sample.z,
      segment.a[0], segment.a[1], segment.b[0], segment.b[1]);
    if (d < drawDistance) drawDistance = d;
  }
}
check('the committed draw path passed closer to the curb than the collision path',
  drawDistance < pathDistance &&
  Math.abs(drawDistance - obstruction.drawPathDistanceM) <= 1e-3,
  `draw ${drawDistance.toFixed(3)} m vs path ${pathDistance.toFixed(3)} m`);

const stopSample = samples.reduce((best, sample, index) => {
  const d = Math.hypot(sample.x - STOP_POSE[0], sample.z - STOP_POSE[1]);
  return d < best.d ? { d, index } : best;
}, { d: Infinity, index: null });
const stopDistance = Math.min(...obstruction.segments.map((segment) =>
  segmentDistance(samples[stopSample.index].x, samples[stopSample.index].z,
    segment.a[0], segment.a[1], segment.b[0], segment.b[1])));
check('the path clears the recorded 226.8 m stop by the stated margin',
  stopDistance >= obstruction.statedMarginM - 1e-9 &&
  Math.abs(stopDistance - obstruction.pathStopDistanceM) <= 1e-3 &&
  Math.abs(samples[stopSample.index].arc - obstruction.pathStopArc) <= 1e-6,
  `arc ${samples[stopSample.index].arc} distance ${stopDistance.toFixed(3)} m`);
check('the recorded draw-path stop arc is the analysis arc',
  Math.abs(obstruction.drawPathStopArc - DRAW_STOP_ARC) <= 1e-3,
  obstruction.drawPathStopArc);

// ---------------------------------------------------------------- rules
check('countdown is 90 ticks in 30-tick steps',
  doc.countdown?.ticks === 90 && doc.countdown?.stepTicks === 30,
  `${doc.countdown?.ticks}/${doc.countdown?.stepTicks}`);
check('band is the page validator 6 m and the corridor is within the measured clearance',
  doc.course.band?.halfWidthMetres === BAND_HALF_WIDTH &&
  doc.course.corridor?.halfWidthMetres <= pathDistance + 1e-9 &&
  doc.course.corridor?.halfWidthMetres === BAND_HALF_WIDTH &&
  doc.course.corridor?.source?.minRasterClearanceM >= doc.course.corridor.halfWidthMetres,
  `${doc.course.band?.halfWidthMetres}/${doc.course.corridor?.halfWidthMetres} clearance ${doc.course.corridor?.source?.minRasterClearanceM}`);
check('respawn rule is present and names the last checkpoint target',
  typeof doc.rules?.respawn?.rule === 'string' &&
  /checkpoint/i.test(doc.rules.respawn.target),
  doc.rules?.respawn?.target);
check('the finish requires all checkpoints',
  doc.rules?.finishRequiresAllCheckpoints === true &&
  /checkpoint/i.test(doc.rules?.gateOrder),
  doc.rules?.gateOrder);

// ---------------------------------------------------------------- determinism
const python = resolvePython();
const scratch = mkdtempSync(path.join(tmpdir(), 'longbeach-path-'));
const outputs = [];
let builderError = null;
for (const name of ['a.json', 'b.json']) {
  const out = path.join(scratch, name);
  const result = spawnSync(python, [BUILDER, '--out', out], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000
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
const checkRun = spawnSync(python, [BUILDER, '--check'], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000
});
check('builder --check accepts the committed document',
  checkRun.status === 0, (checkRun.stdout || checkRun.stderr || '').trim().slice(0, 300));
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
