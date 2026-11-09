#!/usr/bin/env node
// Independent verifier for the collision-raster project courses in
// probes/map-laps-aid/data/<map>-raster-course.json.
//
//   node probes/map-laps-aid/tools/verify_raster_course.mjs
//
// It re-derives, from the committed P48 passable raster and the committed
// spawn document only:
//
//   * the raster and spawn file hashes;
//   * the 2-cell 8-connected erosion of the passable raster;
//   * the 8-connected eroded component that contains the committed spawn (or
//     the nearest eroded cell within the 25 m snap limit), its cell count,
//     area and bounding box;
//   * every station: on the passable raster, on the eroded mask, inside the
//     component, and with a passable 1.68 m car band perpendicular to the
//     station's central-difference tangent;
//   * the closure (the seam from the last station to the first is <= 0.5 m),
//     the station spacing, the loop length and the arcs;
//   * the start: station 0 is the station nearest the committed spawn, and
//     the recorded spawn projection distance is that distance;
//   * the ground height at every station;
//   * the minimum raster clearance and its station;
//   * the document's canonical hash and the recorded algorithm parameters.
//
// The npz reader, the band rule and the canonical hash mirror
// probes/map-laps-aid/tools/verify_aid_paths.mjs (read-only reference).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const CELL = 0.5;
const BAND_METRES = 1.68;
const HALF_WIDTH = 0.84;
const BAND_STEP = 0.21;
const EROSION_CELLS = 2;
const GUARANTEED_CLEARANCE = (EROSION_CELLS + 1) * CELL;
const SAMPLE_STEP = 0.25;
const MAX_STATION_SPACING = 0.5;
const SPAWN_SNAP_LIMIT = 25.0;
const MAX_CLEARANCE_RADIUS_CELLS = 12;

const LEVELS = {
  hackney: {
    level: 'uk_london_hackney',
    data: 'probes/map-laps-aid/data/hackney-raster-course.json',
    grid: '_work/map-laps/hackney/grid.npz',
    spawn: '_work/map-batch/uk_london_hackney/spawn.json',
  },
  brighton: {
    level: 'uk_brighton',
    data: 'probes/map-laps-aid/data/brighton-raster-course.json',
    grid: '_work/map-laps/brighton/grid.npz',
    spawn: '_work/map-batch/uk_brighton/spawn.json',
  },
  sausalito: {
    level: 'usa_sanfran_sausalito',
    data: 'probes/map-laps-aid/data/sausalito-raster-course.json',
    grid: '_work/map-laps/sausalito/grid.npz',
    spawn: '_work/map-batch/usa_sanfran_sausalito/spawn.json',
  },
  russianhill: {
    level: 'usa_sanfran_russianhill',
    data: 'probes/map-laps-aid/data/russianhill-raster-course.json',
    grid: '_work/map-laps/russianhill/grid.npz',
    spawn: '_work/map-batch/usa_sanfran_russianhill/spawn.json',
  },
  bowl: {
    level: 'spa_barcelona_bowl_multiplayer',
    data: 'probes/map-laps-aid/data/bowl-raster-course.json',
    grid: '_work/map-laps/bowl/grid.npz',
    spawn: '_work/map-batch/spa_barcelona_bowl_multiplayer/spawn.json',
  },
};

const checks = [];
const failures = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok });
  if (!ok) failures.push({ name, detail });
}

const round = (value, digits) => {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};

// ---------------------------------------------------------------- npz reader
function findEocd(buffer) {
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  throw new Error('npz: no end-of-central-directory');
}

function parseNpy(data) {
  if (data.toString('latin1', 0, 6) !== '\x93NUMPY') throw new Error('npy: bad magic');
  const major = data[6];
  let headerLength;
  let headerStart;
  if (major === 1) { headerLength = data.readUInt16LE(8); headerStart = 10; }
  else if (major === 2) { headerLength = data.readUInt32LE(8); headerStart = 12; }
  else throw new Error('npy: version ' + major);
  const header = data.toString('latin1', headerStart, headerStart + headerLength);
  const descrMatch = /'descr':\s*'([^']+)'/.exec(header);
  const shapeMatch = /'shape':\s*\(([^)]*)\)/.exec(header);
  if (!descrMatch || !shapeMatch) throw new Error('npy: header');
  const descr = descrMatch[1];
  const shape = shapeMatch[1].split(',').map((value) => value.trim())
    .filter((value) => value.length > 0).map(Number);
  const dataStart = headerStart + headerLength;
  const count = shape.reduce((a, b) => a * b, 1);
  if (descr === '|u1' || descr === '|b1') {
    return { descr, shape, data: data.subarray(dataStart, dataStart + count) };
  }
  if (descr === '<f8') {
    const out = new Float64Array(count);
    for (let index = 0; index < count; index++) out[index] = data.readDoubleLE(dataStart + index * 8);
    return { descr, shape, data: out };
  }
  if (descr === '<f4') {
    const out = new Float32Array(count);
    for (let index = 0; index < count; index++) out[index] = data.readFloatLE(dataStart + index * 4);
    return { descr, shape, data: out };
  }
  throw new Error('npy: unsupported dtype ' + descr);
}

function readNpz(file) {
  const buffer = readFileSync(file);
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = {};
  let pos = centralOffset;
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('npz: central directory');
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const packed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? packed : inflateRawSync(packed);
    entries[name] = parseNpy(data);
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---------------------------------------------------------------- raster
function loadRaster(file) {
  const npz = readNpz(file);
  const base = npz['base.npy'];
  const height = npz['height.npy'];
  const xs = npz['xs.npy'];
  const zs = npz['zs.npy'];
  const nx = base.shape[1];
  const nz = base.shape[0];
  return {
    base: base.data,
    height: height.data,
    xs: xs.data,
    zs: zs.data,
    nx,
    nz,
  };
}

function cellOf(x, z, xs, zs) {
  return [Math.floor((x - xs[0]) / CELL + 0.5), Math.floor((z - zs[0]) / CELL + 0.5)];
}

function passable(raster, x, z) {
  const [i, j] = cellOf(x, z, raster.xs, raster.zs);
  return i >= 0 && i < raster.nx && j >= 0 && j < raster.nz
    && Boolean(raster.base[j * raster.nx + i]);
}

function bandPassable(raster, x, z, tx, tz, halfWidth = HALF_WIDTH, bandStep = BAND_STEP) {
  const nx = -tz;
  const nz = tx;
  const steps = Math.round(halfWidth / bandStep);
  for (let k = -steps; k <= steps; k++) {
    const d = k * bandStep;
    if (!passable(raster, x + nx * d, z + nz * d)) return false;
  }
  return true;
}

// k-layer 8-connected erosion. The raster border is treated as blocked.
function erode(base, nx, nz, k) {
  let current = base;
  for (let pass = 0; pass < k; pass++) {
    const next = new Uint8Array(nx * nz);
    for (let j = 1; j < nz - 1; j++) {
      const row = j * nx;
      for (let i = 1; i < nx - 1; i++) {
        const p = row + i;
        if (!current[p]) continue;
        if (current[p - 1] && current[p + 1]
          && current[p - nx] && current[p + nx]
          && current[p - nx - 1] && current[p - nx + 1]
          && current[p + nx - 1] && current[p + nx + 1]) {
          next[p] = 1;
        }
      }
    }
    current = next;
  }
  return current;
}

function nearestErodedCell(eroded, raster, sx, sz, limit) {
  const [i, j] = cellOf(sx, sz, raster.xs, raster.zs);
  if (i >= 0 && i < raster.nx && j >= 0 && j < raster.nz
    && eroded[j * raster.nx + i]) {
    return { i, j, metres: 0 };
  }
  const radius = Math.ceil(limit / CELL);
  let best = null;
  for (let dj = -radius; dj <= radius; dj++) {
    const jj = j + dj;
    if (jj < 0 || jj >= raster.nz) continue;
    for (let di = -radius; di <= radius; di++) {
      const ii = i + di;
      if (ii < 0 || ii >= raster.nx) continue;
      if (!eroded[jj * raster.nx + ii]) continue;
      const metres = Math.hypot(di * CELL, dj * CELL);
      if (best === null || metres < best.metres) best = { i: ii, j: jj, metres };
    }
  }
  if (best === null || best.metres > limit + 1e-9) return null;
  return best;
}

function floodComponent(eroded, raster, startI, startJ) {
  const { nx, nz } = raster;
  const mark = new Uint8Array(nx * nz);
  const stack = [startJ * nx + startI];
  mark[startJ * nx + startI] = 1;
  let cells = 0;
  let minI = startI;
  let maxI = startI;
  let minJ = startJ;
  let maxJ = startJ;
  while (stack.length > 0) {
    const p = stack.pop();
    const j = Math.floor(p / nx);
    const i = p - j * nx;
    cells += 1;
    if (i < minI) minI = i;
    if (i > maxI) maxI = i;
    if (j < minJ) minJ = j;
    if (j > maxJ) maxJ = j;
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= nz) continue;
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ii = i + di;
        if (ii < 0 || ii >= nx) continue;
        const q = jj * nx + ii;
        if (mark[q] || !eroded[q]) continue;
        mark[q] = 1;
        stack.push(q);
      }
    }
  }
  return {
    mark,
    cells,
    bbox: [raster.xs[minI], raster.xs[maxI], raster.zs[minJ], raster.zs[maxJ]],
  };
}

function nearestBlockedDistance(raster, x, z) {
  const [i, j] = cellOf(x, z, raster.xs, raster.zs);
  const radius = MAX_CLEARANCE_RADIUS_CELLS;
  let best = null;
  for (let dj = -radius; dj <= radius; dj++) {
    const jj = j + dj;
    if (jj < 0 || jj >= raster.nz) continue;
    for (let di = -radius; di <= radius; di++) {
      const ii = i + di;
      if (ii < 0 || ii >= raster.nx) continue;
      if (raster.base[jj * raster.nx + ii]) continue;
      const distance = Math.hypot(di * CELL, dj * CELL);
      if (best === null || distance < best) best = distance;
    }
  }
  return best;
}

// ---------------------------------------------------------------- canonical hash
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function canonicalHash(doc) {
  const body = {};
  for (const [key, value] of Object.entries(doc)) if (key !== 'hash') body[key] = value;
  return 'sha256:' + createHash('sha256').update(stableStringify(body), 'utf8').digest('hex');
}

function fileSha256(file) {
  return 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------- main
function main() {
  const rasterCache = new Map();
  function rasterFor(mapId) {
    if (!rasterCache.has(mapId)) {
      rasterCache.set(mapId, loadRaster(path.join(ROOT, LEVELS[mapId].grid)));
    }
    return rasterCache.get(mapId);
  }

  for (const [mapId, cfg] of Object.entries(LEVELS)) {
    const doc = JSON.parse(readFileSync(path.join(ROOT, cfg.data), 'utf8'));
    const raster = rasterFor(mapId);
    const spawnDoc = JSON.parse(readFileSync(path.join(ROOT, cfg.spawn), 'utf8'));
    const spawn = spawnDoc.layout.spawn;
    const prefix = mapId + ': ';

    check(prefix + 'kind', doc.kind === 'blur.map-laps-aid.raster-course');
    check(prefix + 'version', doc.version === 1);
    check(prefix + 'courseId', doc.courseId === mapId);
    check(prefix + 'level', doc.level === cfg.level);
    check(prefix + 'courseSource', doc.courseSource === 'collision-raster-project-course');
    check(prefix + 'retailLineUsed', doc.retailLineUsed === false);
    check(prefix + 'verdict', doc.verdict === 'course');
    check(prefix + 'scope collisionOnly', doc.scope && doc.scope.collisionOnly === true);
    check(prefix + 'scope retailRacingLine', doc.scope && doc.scope.retailRacingLine === false);
    check(prefix + 'scope retailStartLine', doc.scope && doc.scope.retailStartLine === false);
    check(prefix + 'document hash', doc.hash === canonicalHash(doc),
      doc.hash + ' != ' + canonicalHash(doc));

    // ------------------------------------------------------------ inputs
    check(prefix + 'raster path', doc.source.raster.path === cfg.grid);
    check(prefix + 'raster file sha256',
      doc.source.raster.fileSha256 === fileSha256(path.join(ROOT, cfg.grid)));
    check(prefix + 'spawn document path', doc.source.spawnDocument.path === cfg.spawn);
    check(prefix + 'spawn document sha256',
      doc.source.spawnDocument.sha256 === fileSha256(path.join(ROOT, cfg.spawn)));
    check(prefix + 'spawn document schema',
      doc.source.spawnDocument.schema === 'blur.map-batch.spawn/1');
    check(prefix + 'raster shape',
      Array.isArray(doc.source.raster.shape)
        && doc.source.raster.shape[0] === raster.nz
        && doc.source.raster.shape[1] === raster.nx);
    check(prefix + 'raster cell', doc.source.raster.cellMetres === CELL);
    let passableCells = 0;
    for (let index = 0; index < raster.base.length; index++) passableCells += raster.base[index] ? 1 : 0;
    check(prefix + 'raster passable cells',
      doc.source.raster.passableCells === passableCells,
      doc.source.raster.passableCells + ' vs ' + passableCells);

    // ------------------------------------------------------------ spawn
    check(prefix + 'spawn x', Math.abs(doc.source.spawn.x - spawn.x) < 1e-6);
    check(prefix + 'spawn z', Math.abs(doc.source.spawn.z - spawn.z) < 1e-6);
    check(prefix + 'spawn heading',
      Math.abs(doc.source.spawn.headingRad - spawn.heading) < 1e-9);
    check(prefix + 'spawn ground',
      Math.abs(doc.source.spawn.groundY - spawn.ground) < 1e-3);

    // ------------------------------------------------------------ parameters
    const algorithm = doc.source.algorithm;
    check(prefix + 'algorithm cell', algorithm.cellMetres === CELL);
    check(prefix + 'algorithm erosion cells', algorithm.erosionCells === EROSION_CELLS);
    check(prefix + 'algorithm band', algorithm.bandMetres === BAND_METRES);
    check(prefix + 'algorithm half width', algorithm.bandHalfWidthMetres === HALF_WIDTH);
    check(prefix + 'algorithm band step', algorithm.bandStepMetres === BAND_STEP);
    check(prefix + 'algorithm band samples', algorithm.bandSamples === 9);
    check(prefix + 'algorithm sample step', algorithm.sampleStepMetres === SAMPLE_STEP);
    check(prefix + 'algorithm max spacing',
      algorithm.maxStationSpacingMetres === MAX_STATION_SPACING);
    check(prefix + 'algorithm spawn snap limit',
      algorithm.spawnSnapLimitMetres === SPAWN_SNAP_LIMIT);
    check(prefix + 'algorithm loop rule',
      typeof algorithm.loopRule === 'string' && algorithm.loopRule.length > 0);
    check(prefix + 'algorithm start rule',
      typeof algorithm.startRule === 'string' && algorithm.startRule.length > 0);
    check(prefix + 'algorithm validation rule',
      typeof algorithm.validationRule === 'string' && algorithm.validationRule.length > 0);

    const clearance = doc.clearance;
    check(prefix + 'clearance band', clearance.bandMetres === BAND_METRES);
    check(prefix + 'clearance half width', clearance.halfWidthMetres === HALF_WIDTH);
    check(prefix + 'clearance step', clearance.stepMetres === BAND_STEP);
    check(prefix + 'clearance erosion cells', clearance.erosionCells === EROSION_CELLS);
    check(prefix + 'clearance guaranteed',
      Math.abs(clearance.guaranteedClearanceMetres - GUARANTEED_CLEARANCE) < 1e-9);
    check(prefix + 'clearance tier', clearance.bandTier === 'narrow');
    check(prefix + 'clearance tier reason',
      typeof clearance.bandTierReason === 'string' && clearance.bandTierReason.length > 0);

    // ------------------------------------------------------------ erosion / component
    const eroded = erode(raster.base, raster.nx, raster.nz, EROSION_CELLS);
    let erodedCells = 0;
    for (let index = 0; index < eroded.length; index++) erodedCells += eroded[index] ? 1 : 0;
    check(prefix + 'eroded cells', doc.source.raster.erodedCells === erodedCells,
      doc.source.raster.erodedCells + ' vs ' + erodedCells);

    const snap = nearestErodedCell(eroded, raster, spawn.x, spawn.z, SPAWN_SNAP_LIMIT);
    check(prefix + 'spawn snap exists', snap !== null);
    if (!snap) continue;
    check(prefix + 'spawn snap distance',
      Math.abs(algorithm.spawnSnapMetres - snap.metres) < 1e-4,
      algorithm.spawnSnapMetres + ' vs ' + snap.metres);

    const component = floodComponent(eroded, raster, snap.i, snap.j);
    check(prefix + 'component cells', algorithm.componentCells === component.cells,
      algorithm.componentCells + ' vs ' + component.cells);
    check(prefix + 'component area',
      Math.abs(algorithm.componentAreaM2 - component.cells * CELL * CELL) < 1e-4);
    check(prefix + 'component bbox',
      Array.isArray(algorithm.componentBbox)
        && algorithm.componentBbox.length === 4
        && Math.abs(algorithm.componentBbox[0] - component.bbox[0]) < 1e-4
        && Math.abs(algorithm.componentBbox[1] - component.bbox[1]) < 1e-4
        && Math.abs(algorithm.componentBbox[2] - component.bbox[2]) < 1e-4
        && Math.abs(algorithm.componentBbox[3] - component.bbox[3]) < 1e-4,
      JSON.stringify(algorithm.componentBbox) + ' vs ' + JSON.stringify(component.bbox));

    // ------------------------------------------------------------ stations
    const course = doc.course;
    const stations = course.stations;
    const count = stations.length;
    check(prefix + 'station count', course.stationCount === count,
      course.stationCount + ' vs ' + count);
    check(prefix + 'station count >= 8', count >= 8);
    check(prefix + 'closed', course.closed === true);
    check(prefix + 'start arc', stations[0].arc === 0);

    const spacings = [];
    for (let index = 0; index < count; index++) {
      const a = stations[index];
      const b = stations[(index + 1) % count];
      spacings.push(Math.hypot(b.x - a.x, b.z - a.z));
    }
    const length = spacings.reduce((sum, value) => sum + value, 0);
    const seam = spacings[count - 1];
    check(prefix + 'loop length',
      Math.abs(course.loopLengthMetres - length) < 1e-6,
      course.loopLengthMetres + ' vs ' + length);
    check(prefix + 'closure seam',
      Math.abs(course.closureSeamMetres - seam) < 1e-6,
      course.closureSeamMetres + ' vs ' + seam);
    check(prefix + 'closure seam <= 0.5 m', seam <= MAX_STATION_SPACING + 1e-6, String(seam));
    const maxSpacing = Math.max(...spacings);
    check(prefix + 'max station spacing',
      Math.abs(course.maxStationSpacingMetres - maxSpacing) < 1e-6,
      course.maxStationSpacingMetres + ' vs ' + maxSpacing);
    check(prefix + 'max station spacing <= 0.5 m',
      maxSpacing <= MAX_STATION_SPACING + 1e-6, String(maxSpacing));

    let arcOk = true;
    let arcDetail = '';
    let cumulative = 0;
    for (let index = 0; index < count; index++) {
      if (Math.abs(stations[index].arc - cumulative) > 1e-6) {
        arcOk = false;
        arcDetail = 'station ' + index + ': ' + stations[index].arc + ' vs ' + cumulative;
        break;
      }
      cumulative += spacings[index];
    }
    check(prefix + 'arcs', arcOk, arcDetail);
    check(prefix + 'finish arc',
      Math.abs(stations[count - 1].arc + seam - course.loopLengthMetres) < 1e-6);

    // Start is the station nearest the committed spawn.
    let nearestIndex = 0;
    let nearestDistance = Infinity;
    for (let index = 0; index < count; index++) {
      const distance = Math.hypot(stations[index].x - spawn.x, stations[index].z - spawn.z);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    check(prefix + 'station 0 is the nearest spawn station', nearestIndex === 0,
      'nearest station ' + nearestIndex);
    check(prefix + 'spawn projection distance',
      Math.abs(course.spawnProjection.metres - nearestDistance) < 1e-4,
      course.spawnProjection.metres + ' vs ' + nearestDistance);
    check(prefix + 'spawn projection point',
      Math.abs(course.spawnProjection.x - stations[0].x) < 1e-6
        && Math.abs(course.spawnProjection.z - stations[0].z) < 1e-6);
    check(prefix + 'start point',
      Math.abs(course.start.x - stations[0].x) < 1e-6
        && Math.abs(course.start.z - stations[0].z) < 1e-6
        && Math.abs(course.start.groundY - stations[0].groundY) < 1e-4);

    // Ground min/max.
    let groundMin = Infinity;
    let groundMax = -Infinity;
    for (const station of stations) {
      groundMin = Math.min(groundMin, station.groundY);
      groundMax = Math.max(groundMax, station.groundY);
    }
    check(prefix + 'ground min', Math.abs(course.groundMinY - groundMin) < 1e-4);
    check(prefix + 'ground max', Math.abs(course.groundMaxY - groundMax) < 1e-4);

    // ------------------------------------------------------------ per station
    let rasterOk = true;
    let erodedOk = true;
    let componentOk = true;
    let bandOk = true;
    let groundOk = true;
    let firstRaster = null;
    let firstEroded = null;
    let firstComponent = null;
    let firstBand = null;
    let firstGround = null;
    let minClearance = null;
    let minClearanceStation = null;
    for (let index = 0; index < count; index++) {
      const station = stations[index];
      const [i, j] = cellOf(station.x, station.z, raster.xs, raster.zs);
      const inside = i >= 0 && i < raster.nx && j >= 0 && j < raster.nz;
      if (!inside || !raster.base[j * raster.nx + i]) {
        rasterOk = false;
        if (firstRaster === null) firstRaster = index;
      }
      if (!inside || !eroded[j * raster.nx + i]) {
        erodedOk = false;
        if (firstEroded === null) firstEroded = index;
      }
      if (!inside || !component.mark[j * raster.nx + i]) {
        componentOk = false;
        if (firstComponent === null) firstComponent = index;
      }
      const previous = stations[(index - 1 + count) % count];
      const following = stations[(index + 1) % count];
      const tx = following.x - previous.x;
      const tz = following.z - previous.z;
      const norm = Math.hypot(tx, tz) || 1;
      if (!bandPassable(raster, station.x, station.z, tx / norm, tz / norm)) {
        bandOk = false;
        if (firstBand === null) firstBand = index;
      }
      if (inside) {
        const ground = round(raster.height[j * raster.nx + i], 4);
        if (Math.abs(station.groundY - ground) > 1e-3) {
          groundOk = false;
          if (firstGround === null) firstGround = index;
        }
      }
      const distance = nearestBlockedDistance(raster, station.x, station.z);
      if (distance !== null && (minClearance === null || distance < minClearance)) {
        minClearance = distance;
        minClearanceStation = index;
      }
    }
    check(prefix + 'every station on the P48 raster', rasterOk, 'first ' + firstRaster);
    check(prefix + 'every station on the eroded mask', erodedOk, 'first ' + firstEroded);
    check(prefix + 'every station in the eroded component', componentOk,
      'first ' + firstComponent);
    check(prefix + 'every station car band passable', bandOk, 'first ' + firstBand);
    check(prefix + 'every station ground height', groundOk, 'first ' + firstGround);

    check(prefix + 'min raster clearance',
      clearance.minRasterClearanceMetres === null
        ? minClearance === null
        : Math.abs(clearance.minRasterClearanceMetres - minClearance) < 1e-3,
      clearance.minRasterClearanceMetres + ' vs ' + minClearance);
    check(prefix + 'min raster clearance station',
      clearance.minRasterClearanceStation === minClearanceStation,
      clearance.minRasterClearanceStation + ' vs ' + minClearanceStation);
    check(prefix + 'min raster clearance >= band half width',
      minClearance === null || minClearance + 1e-9 >= HALF_WIDTH,
      String(minClearance));
  }

  const passed = checks.filter((entry) => entry.ok).length;
  for (const failure of failures) {
    console.error('FAIL ' + failure.name + (failure.detail ? ': ' + failure.detail : ''));
  }
  console.log(passed + '/' + checks.length + ' checks passed');
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = main();
