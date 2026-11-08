#!/usr/bin/env node
// Verify the committed collision-clear point-to-point paths for every map-batch
// level that has one. The level table below is the authority for the map id,
// the committed document, the P48 grid, the batch package and the per-level
// clearance / corridor overrides.
//
//   node probes/map-laps/tools/verify_batch_paths.mjs
//   node probes/map-laps/tools/verify_batch_paths.mjs --map observatory
//   node probes/map-laps/tools/verify_batch_paths.mjs --python <python.exe>
//
// For each level it re-derives, from the committed collision data:
//   * the document hash, kind, courseId and scope labels;
//   * the source physics / raster / manifest / draws / collision-buffer /
//     spawn-document / draw-path pins;
//   * the 0.5 m grid and the level's clearance erosion, re-computed here;
//   * the level's corridor around the committed draw path, re-computed here;
//   * every 0.25 m sample: passable cell, raster ground, car-half-width lateral
//     band, and the full isotropic margin outside the endpoint connectors;
//   * the length, continuity, start/finish poses and the four gates (order,
//     arcs, positions, lines, ground, car-width line);
//   * the narrowest draw-path pinch and the path's clearance improvement;
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
const BUILDER = path.join(ROOT, 'probes/map-laps/tools/build_batch_paths.py');

const CELL = 0.5;
const CORRIDOR_HALF_WIDTH = 12.0;
const CAR_HALF_WIDTH = 1.138;
const SAMPLE_STEP = 0.25;
const BAND_HALF_WIDTH = 6.0;
const GATE_LINE_FRACTION_MIN = 0.5;
const CONNECTOR_MAX_METRES = 12.0;
// ceil(CAR_HALF_WIDTH / CELL): below this the isotropic erosion cannot contain
// the car's lateral band, so the builder refuses the level.
const MIN_CLEARANCE_CELLS = 3;

// Every level with a committed `*-path.json`. `clearanceCells` / `corridorCells`
// are the builder's per-level overrides; the default is 10 / 14.
const LEVELS = {
  observatory: {
    mapId: 'observatory',
    level: 'usa_la_observatory',
    doc: 'probes/map-laps/data/observatory-path.json',
    grid: '_work/map-laps/observatory/grid.npz',
    batch: '_work/map-batch/usa_la_observatory',
    physics: 'game-data/Blur/levels/usa_la_observatory/Level.levelphysics',
    clearanceCells: 10,
    corridorCells: 14
  },
  downtown: {
    mapId: 'downtown',
    level: 'usa_la_downtown',
    doc: 'probes/map-laps/data/downtown-path.json',
    grid: '_work/map-laps/downtown/grid.npz',
    batch: '_work/map-batch/usa_la_downtown',
    physics: 'game-data/Blur/levels/usa_la_downtown/Level.levelphysics',
    clearanceCells: 10,
    corridorCells: 14
  },
  mharuna: {
    mapId: 'mharuna',
    level: 'jpn_mharuna',
    doc: 'probes/map-laps/data/mharuna-path.json',
    grid: '_work/map-laps/mharuna/grid.npz',
    batch: '_work/map-batch/jpn_mharuna',
    physics: 'game-data/Blur/levels/jpn_mharuna/Level.levelphysics',
    clearanceCells: 10,
    corridorCells: 14
  },
  highrise: {
    mapId: 'highrise',
    level: 'usa_la_multiplayer_highrise',
    doc: 'probes/map-laps/data/highrise-path.json',
    grid: '_work/map-laps/highrise/grid.npz',
    batch: '_work/map-batch/usa_la_multiplayer_highrise',
    physics: 'game-data/Blur/levels/usa_la_multiplayer_highrise/Level.levelphysics',
    clearanceCells: 10,
    corridorCells: 14
  },
  shutoko: {
    mapId: 'shutoko',
    level: 'jpn_tokyo_shutoko',
    doc: 'probes/map-laps/data/shutoko-path.json',
    grid: '_work/map-laps/shutoko/grid.npz',
    batch: '_work/map-batch/jpn_tokyo_shutoko',
    physics: 'game-data/Blur/levels/jpn_tokyo_shutoko/Level.levelphysics',
    clearanceCells: 10,
    corridorCells: 14
  },
  oval: {
    mapId: 'oval',
    level: 'spa_barcelona_oval',
    doc: 'probes/map-laps/data/oval-path.json',
    grid: '_work/map-laps/oval/grid.npz',
    batch: '_work/map-batch/spa_barcelona_oval',
    physics: 'game-data/Blur/levels/spa_barcelona_oval/Level.levelphysics',
    clearanceCells: 10,
    corridorCells: 14
  },
  'amboy-mp': {
    mapId: 'amboy-mp',
    level: 'usa_amboy_multiplayer',
    doc: 'probes/map-laps/data/amboy-mp-path.json',
    grid: '_work/map-laps/amboy-mp/grid.npz',
    batch: '_work/map-batch/usa_amboy_multiplayer',
    physics: 'game-data/Blur/levels/usa_amboy_multiplayer/Level.levelphysics',
    clearanceCells: 3,
    corridorCells: 14
  }
};

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

// ---------------------------------------------------------------- grid model
function erodeMask(base, nx, nz, layers) {
  let cur = Uint8Array.from(base);
  for (let layer = 0; layer < layers; layer++) {
    const next = new Uint8Array(cur.length);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const index = j * nx + i;
        if (!cur[index]) continue;
        let ok = true;
        for (let dj = -1; dj <= 1 && ok; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= nz) { ok = false; break; }
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= nx || !cur[jj * nx + ii]) { ok = false; break; }
          }
        }
        if (ok) next[index] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

function chamferCells(seed, nx, nz) {
  const INF = 1e9;
  const d = new Float32Array(nx * nz);
  for (let index = 0; index < d.length; index++) d[index] = seed[index] ? 0 : INF;
  for (let j = 0; j < nz; j++) {
    const row = j * nx;
    if (j > 0) {
      const prev = (j - 1) * nx;
      for (let i = 0; i < nx; i++) {
        if (d[prev + i] + 3 < d[row + i]) d[row + i] = d[prev + i] + 3;
        if (i > 0 && d[prev + i - 1] + 4 < d[row + i]) d[row + i] = d[prev + i - 1] + 4;
        if (i < nx - 1 && d[prev + i + 1] + 4 < d[row + i]) d[row + i] = d[prev + i + 1] + 4;
      }
    }
    for (let i = 1; i < nx; i++) {
      if (d[row + i - 1] + 3 < d[row + i]) d[row + i] = d[row + i - 1] + 3;
    }
  }
  for (let j = nz - 1; j >= 0; j--) {
    const row = j * nx;
    if (j < nz - 1) {
      const next = (j + 1) * nx;
      for (let i = 0; i < nx; i++) {
        if (d[next + i] + 3 < d[row + i]) d[row + i] = d[next + i] + 3;
        if (i > 0 && d[next + i - 1] + 4 < d[row + i]) d[row + i] = d[next + i - 1] + 4;
        if (i < nx - 1 && d[next + i + 1] + 4 < d[row + i]) d[row + i] = d[next + i + 1] + 4;
      }
    }
    for (let i = nx - 2; i >= 0; i--) {
      if (d[row + i + 1] + 3 < d[row + i]) d[row + i] = d[row + i + 1] + 3;
    }
  }
  for (let index = 0; index < d.length; index++) d[index] /= 3;
  return d;
}

// ---------------------------------------------------------------- runner
const checks = [];
function check(label, ok, detail = null) {
  checks.push({ label, ok: Boolean(ok), detail });
  return Boolean(ok);
}

function verifyMap(key, python, scratch) {
  const spec = LEVELS[key];
  const docPath = path.join(ROOT, spec.doc);
  const gridPath = path.join(ROOT, spec.grid);
  const batchDir = path.join(ROOT, spec.batch);
  const physicsPath = path.join(ROOT, spec.physics);
  const required = [
    docPath, gridPath,
    path.join(batchDir, 'manifest.json'),
    path.join(batchDir, 'draws.json'),
    path.join(batchDir, 'collision.json'),
    path.join(batchDir, 'spawn.json'),
    path.join(batchDir, 'path.json'),
    path.join(batchDir, 'collision.positions.f32.bin'),
    path.join(batchDir, 'collision.indices.u32.bin'),
    physicsPath
  ];
  const missing = required.filter((file) => !existsSync(file));
  if (missing.length) {
    check(key + ': inputs exist', false, missing.map((file) => path.relative(ROOT, file)).join(', '));
    return;
  }
  check(key + ': inputs exist', true, path.relative(ROOT, docPath));

  const doc = readJson(docPath);
  const draws = readJson(path.join(batchDir, 'draws.json'));
  const collision = readJson(path.join(batchDir, 'collision.json'));
  const draw = readJson(path.join(batchDir, 'path.json'));
  const spawnDoc = readJson(path.join(batchDir, 'spawn.json'));
  // The committed spawn pose and the committed draw-path end are the path's
  // endpoints; they are read from the package, not hard-coded here.
  const committedSpawn = spawnDoc.layout.spawn;
  const spawnPose = [committedSpawn.x, committedSpawn.z];
  const heading = committedSpawn.heading;
  const finishPose = [draw.end.x, draw.end.z];
  const clearanceCells = spec.clearanceCells;
  const clearanceMetres = clearanceCells * CELL;
  const corridorCells = spec.corridorCells;
  const grid = readNpz(gridPath);
  const base = grid.base;
  const height = grid.height;
  const xs = grid.xs;
  const zs = grid.zs;
  if (!base || !height || !xs || !zs) {
    check(key + ': grid has base/height/xs/zs', false, 'missing arrays');
    return;
  }
  const nx = base.shape[1];
  const nz = base.shape[0];
  const cell = xs.data.readDoubleLE(8) - xs.data.readDoubleLE(0);
  const x0 = xs.data.readDoubleLE(0);
  const z0 = zs.data.readDoubleLE(0);
  const cellOf = (x, z) => [
    Math.round((x - x0) / cell),
    Math.round((z - z0) / cell)
  ];
  const passable = (i, j) => i >= 0 && j >= 0 && i < nx && j < nz && base.data[j * nx + i] !== 0;
  const rasterHeight = (i, j) => height.data.readFloatLE((j * nx + i) * 4);

  // ------------------------------------------------------------ document
  check(key + ': document is e1-drive.sprint v1 with the committed courseId',
    doc.kind === 'e1-drive.sprint' && doc.version === 1 && doc.courseId === spec.mapId,
    `${doc.kind} v${doc.version} courseId=${doc.courseId}`);
  check(key + ': document hash matches its canonical JSON', doc.hash === bodyHash(doc), doc.hash);
  check(key + ': scope is collision-only with no renderer/vehicle/game/driven claim',
    doc.scope?.collisionOnly === true && doc.scope?.drawGeometryRead === false &&
    doc.scope?.rendererClaim === false && doc.scope?.vehiclePhysics === false &&
    doc.scope?.gameRun === false && doc.scope?.pathDriven === false,
    JSON.stringify(doc.scope));
  check(key + ': source names the collision probe and the level',
    doc.source?.probe === 'probes/map-laps (collision-only point-to-point path)' &&
    doc.source?.probeScope === 'collisionOnly' &&
    doc.source?.level === spec.level && doc.source?.map === spec.mapId,
    JSON.stringify({ probe: doc.source?.probe, level: doc.source?.level }));

  const physicsBytes = readFileSync(physicsPath);
  check(key + ': source physics SHA-256/bytes match Level.levelphysics',
    doc.source?.physics?.sha256 === sha256(physicsBytes) &&
    doc.source?.physics?.bytes === physicsBytes.length,
    doc.source?.physics?.sha256);
  check(key + ': source raster SHA-256 matches grid.npz',
    doc.source?.raster?.fileSha256 === sha256(readFileSync(gridPath)),
    doc.source?.raster?.fileSha256);
  const collisionBytes = readFileSync(path.join(batchDir, 'collision.json'));
  check(key + ': source slice pins match the committed collision slice',
    doc.source?.slice?.sha256 === sha256(collisionBytes) &&
    doc.source?.slice?.bytes === collisionBytes.length &&
    doc.source?.slice?.contentHash === sha256(collisionBytes),
    doc.source?.slice?.contentHash);
  const drawsBytes = readFileSync(path.join(batchDir, 'draws.json'));
  check(key + ': source render pins match the committed draws.json',
    doc.source?.render?.sha256 === sha256(drawsBytes) &&
    doc.source?.render?.bytes === drawsBytes.length &&
    doc.source?.render?.contentHash === sha256(drawsBytes),
    doc.source?.render?.contentHash);
  const posBytes = readFileSync(path.join(batchDir, 'collision.positions.f32.bin'));
  const idxBytes = readFileSync(path.join(batchDir, 'collision.indices.u32.bin'));
  check(key + ': source collision-buffer pins match the committed triangles',
    doc.source?.sliceCollision?.positions?.sha256 === sha256(posBytes) &&
    doc.source?.sliceCollision?.positions?.bytes === posBytes.length &&
    doc.source?.sliceCollision?.indices?.sha256 === sha256(idxBytes) &&
    doc.source?.sliceCollision?.indices?.bytes === idxBytes.length &&
    doc.source?.raster?.staticTriangles === collision.counts.triangles,
    JSON.stringify({ positions: doc.source?.sliceCollision?.positions?.sha256,
      indices: doc.source?.sliceCollision?.indices?.sha256 }));
  check(key + ': source spawn/draw-path document pins match the committed files',
    doc.source?.spawnDocument?.sha256 === sha256(readFileSync(path.join(batchDir, 'spawn.json'))) &&
    doc.source?.drawPathDocument?.sha256 === sha256(readFileSync(path.join(batchDir, 'path.json'))),
    doc.source?.spawnDocument?.sha256);

  check(key + ': grid is a 0.5 m raster with matching shapes',
    Math.abs(cell - CELL) <= 1e-12 && base.shape.length === 2 &&
    height.shape[0] === nz && height.shape[1] === nx &&
    xs.shape[0] === nx && zs.shape[0] === nz,
    `${base.shape.join('x')} cell ${cell}`);
  check(key + `: clearance is ${clearanceCells} cells with a ${clearanceMetres} m lower bound and the car half-width`,
    Number.isInteger(doc.source?.clearance?.cells) &&
    doc.source.clearance.cells === clearanceCells &&
    clearanceCells >= MIN_CLEARANCE_CELLS &&
    doc.source.clearance.lowerBoundMetres === clearanceMetres &&
    doc.source.clearance.carHalfWidthM === CAR_HALF_WIDTH &&
    doc.source.corridor?.cells === corridorCells &&
    doc.source.corridor?.halfWidthMetres === corridorCells * CELL,
    JSON.stringify({ clearance: doc.source?.clearance?.cells,
      corridor: doc.source?.corridor?.cells }));

  // ------------------------------------------------------------ samples
  const samples = doc.course.samples;
  check(key + ': course has 0.25 m samples and a matching sampleCount',
    Array.isArray(samples) && samples.length === doc.course.sampleCount &&
    doc.course.sampleStepMetres === SAMPLE_STEP,
    `${samples.length} / ${doc.course.sampleCount} / ${doc.course.sampleStepMetres}`);

  let measured = 0;
  let maxStep = 0;
  for (let index = 1; index < samples.length; index++) {
    const step = Math.hypot(samples[index].x - samples[index - 1].x,
      samples[index].z - samples[index - 1].z);
    measured += step;
    if (step > maxStep) maxStep = step;
  }
  check(key + ': recomputed sample length equals course.lengthMetres (1e-6 m)',
    Math.abs(measured - doc.course.lengthMetres) <= 1e-6,
    `${measured.toFixed(6)} vs ${doc.course.lengthMetres}`);
  check(key + ': every 0.25 m step is at most 0.250001 m',
    maxStep <= 0.250001, maxStep.toFixed(6));
  check(key + ': course length is positive and recorded in span/finishArc',
    doc.course.lengthMetres > 0 &&
    Math.abs(doc.course.span.finishArc - doc.course.lengthMetres) <= 1e-9 &&
    Math.abs(doc.course.finishArc - doc.course.lengthMetres) <= 1e-9,
    doc.course.lengthMetres);

  const first = samples[0];
  const last = samples[samples.length - 1];
  check(key + ': first sample is the committed spawn pose',
    Math.abs(first.x - spawnPose[0]) <= 1e-6 && Math.abs(first.z - spawnPose[1]) <= 1e-6 &&
    Math.abs(doc.course.spawn.x - spawnPose[0]) <= 1e-6 &&
    Math.abs(doc.course.spawn.z - spawnPose[1]) <= 1e-6 &&
    Math.abs(doc.course.spawn.headingRad - heading) <= 1e-9,
    `${first.x},${first.z} heading ${doc.course.spawn.headingRad}`);
  check(key + ': last sample is the committed draw-path finish',
    Math.abs(last.x - finishPose[0]) <= 1e-6 && Math.abs(last.z - finishPose[1]) <= 1e-6,
    `${last.x},${last.z}`);
  check(key + ': first sample arc is 0 and the last arc is the course length',
    first.arc === 0 && Math.abs(last.arc - doc.course.lengthMetres) <= 1e-9,
    `${first.arc} .. ${last.arc}`);
  check(key + ': sample arcs are monotonic',
    samples.every((sample, index) => index === 0 || sample.arc >= samples[index - 1].arc),
    'arc order');
  check(key + ': no sample carries a draw-coverage claim',
    samples.every((sample) => sample.covered === null) &&
    doc.course.coverage?.measured === false,
    JSON.stringify(doc.course.coverage));

  // ------------------------------------------------------------ endpoint connectors
  const connectors = doc.course.endpointConnectors;
  const spawnConnector = connectors?.spawn?.arc;
  const finishConnector = connectors?.finish?.arc;
  check(key + ': endpoint connectors are recorded and at most 12 m',
    Number.isFinite(spawnConnector) && Number.isFinite(finishConnector) &&
    spawnConnector >= 0 && spawnConnector <= CONNECTOR_MAX_METRES &&
    finishConnector >= 0 && finishConnector <= CONNECTOR_MAX_METRES &&
    Math.abs(connectors.spawn.metres - spawnConnector) <= 1e-3 &&
    Math.abs(connectors.finish.metres - finishConnector) <= 1e-3,
    `spawn ${spawnConnector} m, finish ${finishConnector} m`);
  const isInterior = (arc) => arc >= spawnConnector - 1e-9 &&
    arc <= doc.course.lengthMetres - finishConnector + 1e-9;

  // ------------------------------------------------------------ re-derived masks
  const eroded = erodeMask(base.data, nx, nz, clearanceCells);
  const drawCells = new Uint8Array(nx * nz);
  for (const point of draw.samples) {
    const [i, j] = cellOf(point.x, point.z);
    if (i >= 0 && j >= 0 && i < nx && j < nz) drawCells[j * nx + i] = 1;
  }
  const corridor = chamferCells(drawCells, nx, nz);

  let badCell = 0;
  let badGround = 0;
  let badCarLine = 0;
  let badCarLineAt = null;
  let badEroded = 0;
  let badErodedAt = null;
  let badCorridor = 0;
  let badCorridorAt = null;
  let minClearance = Infinity;
  let minClearanceAt = null;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const [i, j] = cellOf(sample.x, sample.z);
    if (!passable(i, j)) { badCell++; continue; }
    if (Math.abs(rasterHeight(i, j) - sample.groundY) > 1e-3) badGround++;
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
    if (!isInterior(sample.arc)) continue;
    if (!eroded[j * nx + i]) { badEroded++; if (badErodedAt === null) badErodedAt = index; }
    if (corridor[j * nx + i] > corridorCells + 1e-9) {
      badCorridor++;
      if (badCorridorAt === null) badCorridorAt = index;
    }
    let best = 15;
    const radius = 30;
    for (let jj = Math.max(0, j - radius); jj < Math.min(nz, j + radius + 1); jj++) {
      for (let ii = Math.max(0, i - radius); ii < Math.min(nx, i + radius + 1); ii++) {
        if (base.data[jj * nx + ii] !== 0) continue;
        const d = Math.hypot((ii - i) * cell, (jj - j) * cell);
        if (d < best) best = d;
      }
    }
    if (best < minClearance) { minClearance = best; minClearanceAt = index; }
  }
  check(key + ': every sample centre is on P48 passable ground', badCell === 0, `${badCell} bad cells`);
  check(key + ': every sample groundY matches the raster H (1e-3 m)', badGround === 0, `${badGround} bad grounds`);
  check(key + ': every sample car-half-width lateral band is passable',
    badCarLine === 0, `${badCarLine} bad samples, first ${badCarLineAt}`);
  check(key + `: every interior sample is in the re-derived ${clearanceCells}-cell erosion`,
    badEroded === 0, `${badEroded} bad samples, first ${badErodedAt}`);
  check(key + `: every interior sample is inside the re-derived ${corridorCells}-cell corridor`,
    badCorridor === 0, `${badCorridor} bad samples, first ${badCorridorAt}`);
  check(key + `: every interior sample clears the stated ${clearanceMetres} m margin`,
    minClearance >= clearanceMetres - 1e-9,
    `min ${minClearance.toFixed(3)} m at sample ${minClearanceAt}`);

  // ------------------------------------------------------------ gates
  const gates = doc.gates;
  check(key + ': four gates', Array.isArray(gates) && gates.length === 4, gates?.length);
  check(key + ': gate order is start, checkpoint, checkpoint, finish',
    gates.map((gate) => gate.kind).join(',') === 'start,checkpoint,checkpoint,finish',
    gates.map((gate) => gate.kind).join(','));
  check(key + ': gate ids are start, checkpoint-1, checkpoint-2, finish',
    gates.map((gate) => gate.id).join(',') === 'start,checkpoint-1,checkpoint-2,finish',
    gates.map((gate) => gate.id).join(','));
  check(key + ': gate indices are 0..3',
    gates.every((gate, index) => gate.index === index),
    gates.map((gate) => gate.index).join(','));

  const start = gates[0];
  const finish = gates[3];
  check(key + ': gate arcs start at 0 and strictly increase',
    start.arc === 0 && gates.every((gate, index) => index === 0 || gate.arc > gates[index - 1].arc),
    gates.map((gate) => gate.arc).join(','));
  check(key + ': finish arc equals the course length',
    Math.abs(finish.arc - doc.course.lengthMetres) <= 1e-9,
    `${finish.arc} vs ${doc.course.lengthMetres}`);
  check(key + ': finish point is the committed finish point',
    Math.abs(finish.x - finishPose[0]) <= 1e-6 && Math.abs(finish.z - finishPose[1]) <= 1e-6,
    `${finish.x},${finish.z}`);
  check(key + ': checkpoint-1 is the straightest sample within 12 % of one third',
    Math.abs(gates[1].arc - doc.course.lengthMetres / 3) <= 0.12 * doc.course.lengthMetres + 1e-9,
    `${gates[1].arc} vs ${(doc.course.lengthMetres / 3).toFixed(6)}`);
  check(key + ': checkpoint-2 is the straightest sample within 12 % of two thirds',
    Math.abs(gates[2].arc - 2 * doc.course.lengthMetres / 3) <= 0.12 * doc.course.lengthMetres + 1e-9,
    `${gates[2].arc} vs ${(2 * doc.course.lengthMetres / 3).toFixed(6)}`);

  check(key + ': every gate position equals its sample',
    gates.every((gate) => {
      const sample = samples[gate.sampleIndex];
      return sample && Math.abs(gate.x - sample.x) <= 1e-6 &&
        Math.abs(gate.z - sample.z) <= 1e-6 &&
        Math.abs(gate.arc - sample.arc) <= 1e-6 &&
        Math.abs(gate.groundY - sample.groundY) <= 1e-4;
    }), gates.map((gate) => `${gate.id}:${gate.sampleIndex}`).join(' '));
  check(key + ': every gate tangent is unit length and perpendicular to its line',
    gates.every((gate) => {
      const length = Math.hypot(gate.tangent.tx, gate.tangent.tz);
      const dot = gate.tangent.tx * (gate.b[0] - gate.a[0]) +
        gate.tangent.tz * (gate.b[1] - gate.a[1]);
      return Math.abs(length - 1) <= 1e-9 && Math.abs(dot) <= 2e-3;
    }), gates.map((gate) => Math.hypot(gate.tangent.tx, gate.tangent.tz).toFixed(9)).join(','));
  check(key + ': every gate heading is atan2(tx, tz)',
    gates.every((gate) => Math.abs(gate.headingRad -
      Math.atan2(gate.tangent.tx, gate.tangent.tz)) <= 1e-8),
    gates.map((gate) => gate.headingRad).join(','));
  check(key + ': every gate width is between the car width and the requested 8 m',
    gates.every((gate) => gate.widthMetres >= 2 * CAR_HALF_WIDTH - 1e-9 &&
      gate.widthMetres <= gate.requestedWidthMetres + 1e-9 &&
      gate.narrowed === (gate.widthMetres < gate.requestedWidthMetres - 1e-9)),
    gates.map((gate) => `${gate.id}:${gate.widthMetres}/${gate.requestedWidthMetres}`).join(' '));

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
    const gateSteps = Math.round(gate.widthMetres / 2 / 0.25);
    for (let k = -gateSteps; k <= gateSteps; k++) {
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
  check(key + ': every gate centre is on P48 passable ground',
    gateRaster.every((row) => row.centre),
    gateRaster.map((row) => `${row.gate.id}:${row.centre}`).join(' '));
  check(key + ': every gate raster height matches its groundY (1e-3 m)',
    gateRaster.every((row) => row.h !== null && Math.abs(row.h - row.gate.groundY) <= 1e-3),
    gateRaster.map((row) => `${row.gate.id}:${row.h?.toFixed(6)}`).join(' '));
  check(key + ': every gate car-half-width line is passable',
    gateRaster.every((row) => row.carStations > 0 && row.carPassable === row.carStations),
    gateRaster.map((row) => `${row.gate.id}:${row.carPassable}/${row.carStations}`).join(' '));
  check(key + ': every gate line is at least 50% passable on the conservative raster',
    gateRaster.every((row) => row.linePassable / row.lineStations >= GATE_LINE_FRACTION_MIN),
    gateRaster.map((row) => `${row.gate.id}:${row.linePassable}/${row.lineStations}`).join(' '));
  check(key + ': document groundCheck agrees with the re-derived raster',
    gates.every((gate, index) => {
      const row = gateRaster[index];
      return gate.groundCheck?.passable === row.centre &&
        gate.groundCheck?.rasterCell?.[0] === row.i &&
        gate.groundCheck?.rasterCell?.[1] === row.j &&
        gate.groundCheck?.linePassableStations === row.linePassable &&
        gate.groundCheck?.carHalfWidthPassable === (row.carPassable === row.carStations);
    }), 'groundCheck vs grid.npz');

  // ------------------------------------------------------------ obstruction
  const obstruction = doc.source.obstruction;
  let drawMin = { d: Infinity, index: null };
  for (let index = 0; index < draw.samples.length; index++) {
    const point = draw.samples[index];
    const [i, j] = cellOf(point.x, point.z);
    let best = 15;
    const radius = 30;
    for (let jj = Math.max(0, j - radius); jj < Math.min(nz, j + radius + 1); jj++) {
      for (let ii = Math.max(0, i - radius); ii < Math.min(nx, i + radius + 1); ii++) {
        if (base.data[jj * nx + ii] !== 0) continue;
        const d = Math.hypot((ii - i) * cell, (jj - j) * cell);
        if (d < best) best = d;
      }
    }
    if (best < drawMin.d) drawMin = { d: best, index };
  }
  check(key + ': the recorded draw-path pinch is the re-derived minimum',
    Math.abs(drawMin.d - obstruction?.drawPath?.clearanceM) <= 1e-3 &&
    drawMin.index === obstruction?.drawPath?.sampleIndex,
    `${drawMin.d.toFixed(3)} m at ${drawMin.index} vs ${obstruction?.drawPath?.clearanceM} at ${obstruction?.drawPath?.sampleIndex}`);
  check(key + ': the recorded path clearance is the re-derived interior minimum',
    Math.abs(minClearance - obstruction?.path?.minInteriorClearanceM) <= 1e-3 &&
    minClearanceAt === obstruction?.path?.sampleIndex,
    `${minClearance.toFixed(3)} m at ${minClearanceAt} vs ${obstruction?.path?.minInteriorClearanceM} at ${obstruction?.path?.sampleIndex}`);
  check(key + ': the path clears the pinch by the stated margin',
    minClearance >= obstruction.statedMarginM - 1e-9 &&
    obstruction.statedMarginM === clearanceMetres,
    `${minClearance.toFixed(3)} m vs ${obstruction.statedMarginM}`);
  check(key + ': the path improves on the draw-path pinch',
    minClearance > drawMin.d &&
    Math.abs((minClearance - drawMin.d) - obstruction.improvementM) <= 1e-3,
    `draw ${drawMin.d.toFixed(3)} m, path ${minClearance.toFixed(3)} m, improvement ${obstruction.improvementM}`);

  // ------------------------------------------------------------ rules
  check(key + ': countdown is 90 ticks in 30-tick steps',
    doc.countdown?.ticks === 90 && doc.countdown?.stepTicks === 30,
    `${doc.countdown?.ticks}/${doc.countdown?.stepTicks}`);
  check(key + ': band is the page validator 6 m; the corridor is the declared recovery band',
    doc.course.band?.halfWidthMetres === BAND_HALF_WIDTH &&
    doc.course.corridor?.halfWidthMetres === CORRIDOR_HALF_WIDTH &&
    Number.isFinite(doc.course.corridor?.source?.minRasterClearanceM) &&
    doc.course.corridor.source.minRasterClearanceM >= clearanceMetres - 1e-9,
    `${doc.course.band?.halfWidthMetres}/${doc.course.corridor?.halfWidthMetres} clearance ${doc.course.corridor?.source?.minRasterClearanceM}`);
  check(key + ': respawn rule is present and names the last checkpoint target',
    typeof doc.rules?.respawn?.rule === 'string' &&
    /checkpoint/i.test(doc.rules.respawn.target),
    doc.rules?.respawn?.target);
  check(key + ': the finish requires all checkpoints',
    doc.rules?.finishRequiresAllCheckpoints === true &&
    /checkpoint/i.test(doc.rules?.gateOrder),
    doc.rules?.gateOrder);

  // ------------------------------------------------------------ determinism
  const outputs = [];
  let builderError = null;
  for (const name of ['a.json', 'b.json']) {
    const out = path.join(scratch, key + '-' + name);
    const result = spawnSync(python, [BUILDER, '--map', key, '--out', out], {
      cwd: ROOT, encoding: 'utf8', timeout: 600000
    });
    if (result.status !== 0) {
      builderError = (result.stderr || result.stdout || 'builder failed').trim().slice(0, 600);
      break;
    }
    outputs.push(readFileSync(out));
  }
  if (outputs.length === 2) {
    const committed = readFileSync(docPath);
    check(key + ': builder output is byte-identical on repeat',
      outputs[0].equals(outputs[1]), `${outputs[0].length} vs ${outputs[1].length} bytes`);
    check(key + ': committed document equals the builder output',
      outputs[0].equals(committed),
      `${outputs[0].length} vs ${committed.length} bytes`);
  } else {
    check(key + ': builder output is byte-identical on repeat', false, builderError);
    check(key + ': committed document equals the builder output', false, builderError);
  }
  const checkRun = spawnSync(python, [BUILDER, '--map', key, '--check'], {
    cwd: ROOT, encoding: 'utf8', timeout: 600000
  });
  check(key + ': builder --check accepts the committed document',
    checkRun.status === 0, (checkRun.stdout || checkRun.stderr || '').trim().slice(0, 300));
}

// ---------------------------------------------------------------- main
const mapArg = process.argv.includes('--map')
  ? process.argv[process.argv.indexOf('--map') + 1] : 'all';
const keys = mapArg === 'all' ? Object.keys(LEVELS) : [mapArg];
if (keys.some((key) => !LEVELS[key])) {
  console.error('unknown --map ' + JSON.stringify(mapArg) + ' (use ' + Object.keys(LEVELS).join(', ') + ')');
  process.exit(1);
}
const python = resolvePython();
const scratch = mkdtempSync(path.join(tmpdir(), 'batch-paths-'));
for (const key of keys) verifyMap(key, python, scratch);
rmSync(scratch, { recursive: true, force: true });

const passed = checks.filter((entry) => entry.ok).length;
for (const entry of checks) {
  if (!entry.ok) console.log('FAIL ' + entry.label + (entry.detail ? ': ' + entry.detail : ''));
}
console.log(`${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);




