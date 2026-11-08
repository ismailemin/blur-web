#!/usr/bin/env node
// Independent verifier for probes/map-laps-aid/data.
//
//   node probes/map-laps-aid/tools/verify_aid_paths.mjs
//
// It re-derives every verdict from the committed data:
//
//   * the `.aid` route choice (closed, non-logic, >= 300 m, nearest the
//     committed spawn) is recomputed from the pak and compared with the
//     recorded route;
//   * the `.aid` record identity (pak path, route name/index, record id,
//     route number, sha256) is checked against routes.json and the pak;
//   * every path sample is checked against the P48 passable raster
//     (`_work/map-laps/<mapId>/grid.npz` base) and the car half-width band;
//   * the gates are checked for order, arcs, the +/-12 % checkpoint window,
//     the 1 m approach side and the gate-line passability;
//   * every blocked verdict is re-derived from its witness: the spawn match
//     distance, the station with no band-clear lateral position, or the
//     resampled path's band failure.
//
// The `.aid` decoder and pak reader mirror
// probes/powerups/tools/build_pickup_routes.mjs (read-only reference); the
// npz reader is a small ZIP + NPY reader for the committed grid.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const PAK_RELATIVE = 'game-data/Blur/cache/gamedata.pak';
const ROUTES_RELATIVE = '_work/powerups/routes.json';
const SUMMARY_RELATIVE = 'probes/map-laps-aid/data/aid-paths.json';

const CELL = 0.5;
const SAMPLE_STEP = 0.25;
const HALF_WIDTH = 1.138;
const MIN_LOOP_M = 300;
const MAX_SPAWN_OFFSET_M = 25;
const LATERAL_SEARCH_M = 10;
const LATERAL_STEP_M = 0.25;
const RACING_LINE = 5;
const GATE_HALF_WIDTH = 4.0;
const GATE_LINE_FRACTION_MIN = 0.5;
const TANGENT_WINDOW = 5.0;

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

// ---------------------------------------------------------------- pak reader
const XOR_KEY = Buffer.from('xVXo40j3@$%\\%`', 'latin1');

function readPakIndex(buffer) {
  if (buffer.length < 48 || buffer.toString('latin1', 0, 4) !== '2KAP') {
    throw new Error('gamedata.pak: unsupported preheader');
  }
  const version = buffer.readUInt32LE(4);
  const sector = buffer.readUInt32LE(8);
  const headerSize = buffer.readUInt32LE(12);
  const codec = buffer[16];
  const fatType = buffer[17];
  if (version !== 2) throw new Error('gamedata.pak: version ' + version);
  if (headerSize !== 32) throw new Error('gamedata.pak: header size ' + headerSize);
  const stringBlock = buffer.readUInt32LE(36);
  const fatBlock = buffer.readUInt32LE(40);
  const metadataEnd = sector + stringBlock + fatBlock;
  const stringSize = buffer.readUInt32LE(sector);
  if (stringSize + 4 > stringBlock) throw new Error('gamedata.pak: string table');
  const raw = buffer.subarray(sector + 4, sector + 4 + stringSize);
  const strings = Buffer.alloc(stringSize);
  for (let index = 0; index < stringSize; index++) {
    strings[index] = raw[index] ^ XOR_KEY[(index + 1) % XOR_KEY.length];
  }
  const count = buffer.readUInt32LE(sector + stringBlock);
  const fatSize = buffer.readUInt32LE(sector + stringBlock + 4);
  const stride = fatType === 0 ? 40 : fatType === 1 ? 64 : null;
  if (stride === null || count * stride !== fatSize) {
    throw new Error('gamedata.pak: invalid FAT geometry');
  }
  const fatStart = sector + stringBlock + 8;
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    const row = fatStart + index * stride;
    const crc = buffer.readUInt32LE(row);
    const stringOffset = buffer.readUInt32LE(row + 4);
    const logical = buffer.readUInt32LE(row + 12);
    const start = buffer.readBigUInt64LE(row + 24);
    const stored = buffer.readUInt32LE(row + 36);
    if (stringOffset >= strings.length) throw new Error('gamedata.pak: path');
    const end = strings.indexOf(0, stringOffset);
    if (end < 0) throw new Error('gamedata.pak: unterminated path');
    const name = strings.toString('utf8', stringOffset, end);
    if (start === 0xffffffffffffffffn) continue;
    const offset = Number(start) * sector;
    if (offset < metadataEnd || offset + stored > buffer.length) {
      throw new Error('gamedata.pak: payload bounds invalid for ' + name);
    }
    entries.set(name.toLowerCase(), {
      path: name, offset, storedBytes: stored, logicalBytes: logical,
      pathCrc32: crc.toString(16).padStart(8, '0'), fatIndex: index,
    });
  }
  return { entries, codec, fatType };
}

function readPakEntry(buffer, index, relative) {
  const entry = index.entries.get(relative.toLowerCase());
  if (!entry) throw new Error('gamedata.pak: missing entry ' + relative);
  if (index.codec !== 2) throw new Error('gamedata.pak: codec ' + index.codec);
  const packed = buffer.subarray(entry.offset, entry.offset + entry.storedBytes);
  const logical = inflateSync(packed);
  if (logical.length !== entry.logicalBytes) {
    throw new Error(relative + ': inflated ' + logical.length + ' bytes');
  }
  return { entry, logical };
}

// ---------------------------------------------------------------- aid reader
const FLAG_NAMES = {
  1: 'ROUTE_LOOPED', 2: 'ROUTE_START_ZONE', 4: 'ROUTE_FINISH_ZONE',
  8: 'ROUTE_INTERMEDIATE_ZONE_1', 16: 'ROUTE_INTERMEDIATE_ZONE_2',
  32: 'ROUTE_LOGIC_ZONE', 64: 'ROUTE_JUNCTION',
  128: 'ROUTE_DYNAMIC_JUNCTION_ZONE', 256: 'ROUTE_VALID_RESET',
  512: 'ROUTE_VALID_NITRO', 1024: 'ROUTE_VALID_DROP_PRIORITY',
};

function parseAid(buffer) {
  let pos = 0;
  const need = (count, what) => {
    if (count < 0 || pos + count > buffer.length) {
      throw new Error(what + ' at byte ' + pos + ' runs past ' + buffer.length);
    }
  };
  const i32 = (what) => { need(4, what); const value = buffer.readInt32LE(pos); pos += 4; return value; };
  const f32 = (what) => { need(4, what); const value = buffer.readFloatLE(pos); pos += 4; return value; };
  const i8 = (what) => { need(1, what); const value = buffer.readInt8(pos); pos += 1; return value; };
  const text = (what) => {
    const start = pos;
    const length = i32(what + ' length');
    if (length < 0 || length > (1 << 20)) throw new Error(what + ' length');
    need(length, what);
    const value = buffer.toString('latin1', pos, pos + length);
    pos += length;
    return value;
  };
  const junction = (rule) => {
    const out = { rule };
    if (rule === 1) out.state = i32('state');
    else if (rule === 2) { out.routeName = text('route'); out.state = i32('state'); }
    else if (rule === 3) { out.routeName = text('route'); out.state = i32('state'); out.seconds = f32('seconds'); }
    else if (rule === 4) { out.routeName = text('route'); out.state = [i32('s0')]; out.seconds = [f32('s0')]; out.state.push(i32('s1')); out.seconds.push(f32('s1')); }
    else if (rule === 5) { out.state = [i32('s0')]; out.seconds = [f32('s0')]; out.state.push(i32('s1')); out.seconds.push(f32('s1')); }
    else if (rule === 6 || rule === 7) { out.state = i32('state'); out.lap = Math.trunc(f32('lap')); }
    else if (rule === 8) { out.state = i32('state'); out.laps = [0, 1, 2].map((k) => Math.trunc(f32('lap' + k))); }
    else if (rule === 9) { out.state = i32('state'); out.cars = Math.trunc(f32('cars')); out.resetSeconds = f32('reset'); }
    else out.unsupportedRule = true;
    return out;
  };

  const version = f32('version');
  if (version !== 6) throw new Error('unsupported .aid revision ' + version);
  const routeCount = i32('route count');
  const routes = [];
  for (let r = 0; r < routeCount; r++) {
    const name = text('route name');
    const inputRoute = text('route input');
    const outputRoute = text('route output');
    const flags = i32('route flags');
    const routeJunction = (flags & 128) ? junction(i32('junction rule')) : null;
    const segmentCount = i32('segment count');
    if (segmentCount < 0 || segmentCount > 200000) throw new Error('segment count');
    const segments = [];
    const lineCountSet = new Set();
    for (let s = 0; s < segmentCount; s++) {
      const xFile = f32('x');
      const yFile = f32('y');
      const zFile = f32('z');
      const width = f32('width');
      const tangentXFile = f32('tangentX');
      const tangentZFile = f32('tangentZ');
      f32('t3x'); f32('t3y'); f32('t3z');
      const minY = f32('minY');
      const maxY = f32('maxY');
      const lineCount = i32('line count');
      if (lineCount < 0 || lineCount > 64) throw new Error('line count');
      lineCountSet.add(lineCount);
      const heights = [];
      const offsets = [];
      for (let k = 0; k < lineCount; k++) {
        f32('curvature'); f32('distance'); i32('pointFlags');
        heights.push(f32('height')); offsets.push(f32('offset'));
        i8('surfaceFlags'); f32('yAngle');
      }
      segments.push({ index: s, xFile, yFile, zFile, width,
        tangentXFile, tangentZFile, minY, maxY, lineCount, heights, offsets });
    }
    routes.push({ index: r, name, inputRoute, outputRoute, flags, junction: routeJunction,
      segmentCount, lineCountSet: [...lineCountSet].sort((a, b) => a - b), segments });
  }
  const cacheSize = i32('data cache size');
  for (let c = 0; c < cacheSize; c++) {
    const records = i32('cache record count');
    for (let k = 0; k < records; k++) { i32('cache index'); text('cache route name'); }
  }
  if (pos !== buffer.length) throw new Error('trailing bytes: ' + pos + ' of ' + buffer.length);
  return { version, routeCount, routes, parsedBytes: pos, fileBytes: buffer.length };
}

function segmentFrame(segment) {
  const x = segment.xFile;
  const z = -segment.zFile;
  let nx = segment.tangentXFile;
  let nz = -segment.tangentZFile;
  const length = Math.hypot(nx, nz);
  if (length > 0) { nx /= length; nz /= length; }
  return { x, z, nx, nz };
}

function linePoint(segment, lineIndex) {
  const frame = segmentFrame(segment);
  const offset = segment.offsets[lineIndex];
  return {
    x: frame.x + frame.nx * segment.width * offset,
    z: frame.z + frame.nz * segment.width * offset,
    y: segment.heights[lineIndex],
  };
}

function buildPolyline(route) {
  const points = [];
  let arc = 0;
  let previous = null;
  for (const segment of route.segments) {
    const point = linePoint(segment, RACING_LINE);
    if (previous) arc += Math.hypot(point.x - previous.x, point.z - previous.z);
    points.push({ x: point.x, z: point.z, y: point.y, arc });
    previous = point;
  }
  return points;
}

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

// ---------------------------------------------------------------- geometry
function cellOf(x, z, xs, zs) {
  return [Math.floor((x - xs[0]) / CELL + 0.5), Math.floor((z - zs[0]) / CELL + 0.5)];
}

function passable(raster, x, z) {
  const [i, j] = cellOf(x, z, raster.xs, raster.zs);
  return i >= 0 && i < raster.nx && j >= 0 && j < raster.nz
    && Boolean(raster.base[j * raster.nx + i]);
}

function bandPassable(raster, x, z, tx, tz, halfWidth = HALF_WIDTH) {
  const nx = -tz;
  const nz = tx;
  const steps = Math.round(halfWidth / SAMPLE_STEP);
  for (let k = -steps; k <= steps; k++) {
    const d = k * SAMPLE_STEP;
    if (!passable(raster, x + nx * d, z + nz * d)) return false;
  }
  return true;
}

function arcTable(points) {
  const arc = [0];
  for (let index = 0; index < points.length - 1; index++) {
    arc.push(arc[arc.length - 1]
      + Math.hypot(points[index + 1][0] - points[index][0], points[index + 1][1] - points[index][1]));
  }
  return arc;
}

function nearestOnPolyline(points, x, z) {
  const arc = arcTable(points);
  let best = { distance: Infinity, segment: 0, t: 0, arc: 0 };
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    const vx = b[0] - a[0];
    const vz = b[1] - a[1];
    const lengthSquared = vx * vx + vz * vz;
    let t = lengthSquared > 0 ? ((x - a[0]) * vx + (z - a[1]) * vz) / lengthSquared : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + vx * t;
    const pz = a[1] + vz * t;
    const distance = Math.hypot(x - px, z - pz);
    if (distance < best.distance) {
      best = { distance, segment: index, t, arc: arc[index] + (arc[index + 1] - arc[index]) * t };
    }
  }
  return best;
}

function resampleWithFrame(points, widths, startArc, endArc, closed) {
  const arc = arcTable(points);
  const total = arc[arc.length - 1];
  const length = closed ? ((endArc - startArc) % total + total) % total : endArc - startArc;
  const stations = [];
  let s = 0;
  while (s <= length + 1e-9) {
    const aArc = closed ? (startArc + s) % total : startArc + s;
    let index = 0;
    while (index < arc.length - 2 && arc[index + 1] < aArc) index++;
    const span = arc[index + 1] - arc[index];
    const t = span > 0 ? (aArc - arc[index]) / span : 0;
    const a = points[index];
    const b = points[index + 1];
    const x = a[0] + (b[0] - a[0]) * t;
    const z = a[1] + (b[1] - a[1]) * t;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const norm = Math.hypot(dx, dz) || 1;
    stations.push({ x, z, tx: dx / norm, tz: dz / norm, width: widths[index] });
    s += SAMPLE_STEP;
  }
  return { stations, length };
}

function projectStations(raster, stations) {
  const racingClear = stations.every((station) => bandPassable(raster, station.x, station.z, station.tx, station.tz));
  if (racingClear) {
    return { points: stations.map((station) => [station.x, station.z]), offsets: stations.map(() => 0) };
  }
  const candidates = [];
  const valid = [];
  for (const station of stations) {
    const nx = -station.tz;
    const nz = station.tx;
    const limit = Math.min(LATERAL_SEARCH_M, station.width / 2);
    const steps = Math.floor(limit / LATERAL_STEP_M + 1e-9);
    const offsets = [];
    const points = [];
    const ok = [];
    for (let k = -steps; k <= steps; k++) {
      const d = k * LATERAL_STEP_M;
      offsets.push(d);
      points.push([station.x + nx * d, station.z + nz * d]);
      ok.push(bandPassable(raster, station.x + nx * d, station.z + nz * d, station.tx, station.tz));
    }
    candidates.push({ offsets, points });
    valid.push(ok);
  }
  const bad = [];
  for (let index = 0; index < valid.length; index++) {
    if (!valid[index].some(Boolean)) bad.push(index);
  }
  if (bad.length > 0) {
    return { blocked: { stage: 'no-band-clear-lateral', stationIndex: bad[0], blockedStations: bad.length } };
  }
  const count = stations.length;
  const inf = 1e18;
  const firstOk = [];
  for (let k = 0; k < valid[0].length; k++) if (valid[0][k]) firstOk.push(k);
  let first = firstOk[0];
  for (const k of firstOk) {
    if (Math.abs(candidates[0].offsets[k]) < Math.abs(candidates[0].offsets[first])) first = k;
  }
  let cost = candidates[0].offsets.map((_, index) => index === first ? Math.abs(candidates[0].offsets[first]) : inf);
  const back = [];
  for (let index = 1; index < count; index++) {
    const offsets = candidates[index].offsets;
    const previous = candidates[index - 1].offsets;
    const newCost = offsets.map(() => inf);
    const newBack = offsets.map(() => -1);
    for (let k = 0; k < offsets.length; k++) {
      if (!valid[index][k]) continue;
      const baseCost = Math.abs(offsets[k]);
      let best = inf;
      let bestPrevious = -1;
      for (let p = 0; p < previous.length; p++) {
        if (cost[p] >= inf) continue;
        const value = cost[p] + baseCost + 0.5 * Math.abs(offsets[k] - previous[p]);
        if (value < best) { best = value; bestPrevious = p; }
      }
      newCost[k] = best;
      newBack[k] = bestPrevious;
    }
    cost = newCost;
    back.push(newBack);
  }
  const lastOk = [];
  for (let k = 0; k < cost.length; k++) if (cost[k] < inf) lastOk.push(k);
  if (lastOk.length === 0) return { blocked: { stage: 'lateral-dp' } };
  let last = lastOk[0];
  for (const k of lastOk) if (cost[k] < cost[last]) last = k;
  const sequence = [last];
  for (let index = count - 1; index > 0; index--) sequence.push(back[index - 1][sequence[sequence.length - 1]]);
  sequence.reverse();
  return {
    points: sequence.map((k, index) => candidates[index].points[k]),
    offsets: sequence.map((k, index) => candidates[index].offsets[k]),
  };
}

function finalBandFailures(raster, points) {
  const failures = [];
  for (let index = 0; index < points.length; index++) {
    const a = points[Math.max(0, index - 1)];
    const b = points[Math.min(points.length - 1, index + 1)];
    const tx = b[0] - a[0];
    const tz = b[1] - a[1];
    const norm = Math.hypot(tx, tz) || 1;
    if (!bandPassable(raster, points[index][0], points[index][1], tx / norm, tz / norm)) {
      failures.push(index);
    }
  }
  return failures;
}

// ---------------------------------------------------------------- gates
function tangentAt(points, index, window = TANGENT_WINDOW) {
  const half = Math.max(1, Math.round(window / 2 / SAMPLE_STEP));
  let a;
  let b;
  if (index === 0) { a = points[0]; b = points[Math.min(points.length - 1, half * 2)]; }
  else if (index === points.length - 1) { a = points[Math.max(0, points.length - 1 - half * 2)]; b = points[points.length - 1]; }
  else { a = points[Math.max(0, index - half)]; b = points[Math.min(points.length - 1, index + half)]; }
  const tx = b[0] - a[0];
  const tz = b[1] - a[1];
  const length = Math.hypot(tx, tz) || 1;
  return { tx: tx / length, tz: tz / length, window: Math.min(window, Math.hypot(b[0] - a[0], b[1] - a[1])) };
}

function straightest(samples, arc, nominal, length) {
  const low = Math.max(0, nominal - 0.12 * length);
  const high = Math.min(length, nominal + 0.12 * length);
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < arc.length; index++) {
    const distance = Math.abs(arc[index] - nominal);
    if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
  }
  let bestTurn = null;
  for (let index = 0; index < arc.length; index++) {
    if (arc[index] < low || arc[index] > high) continue;
    const a = Math.max(0, index - 10);
    const b = Math.min(samples.length - 1, index + 10);
    const [ax, az] = samples[a];
    const [bx, bz] = samples[b];
    const [cx, cz] = samples[index];
    let turn = Math.abs(Math.atan2(bx - cx, bz - cz) - Math.atan2(cx - ax, cz - az));
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (bestTurn === null || turn < bestTurn) { bestTurn = turn; bestIndex = index; }
  }
  return bestIndex;
}

function lineSide(a, b, point) {
  return (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
}

function gateLineStats(raster, x, z, tx, tz, halfWidth) {
  const nx = -tz;
  const nz = tx;
  const steps = Math.round(halfWidth / SAMPLE_STEP);
  let stations = 0;
  let passableStations = 0;
  let carStations = 0;
  let carPassable = 0;
  for (let k = -steps; k <= steps; k++) {
    const d = k * SAMPLE_STEP;
    const ok = passable(raster, x + nx * d, z + nz * d);
    stations++;
    if (ok) passableStations++;
    if (Math.abs(d) <= HALF_WIDTH + 1e-9) {
      carStations++;
      if (ok) carPassable++;
    }
  }
  return { stations, passableStations, carStations, carPassable };
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
  const summary = JSON.parse(readFileSync(path.join(ROOT, SUMMARY_RELATIVE), 'utf8'));
  const pakBuffer = readFileSync(path.join(ROOT, PAK_RELATIVE));
  const pakIndex = readPakIndex(pakBuffer);
  const routes = JSON.parse(readFileSync(path.join(ROOT, ROUTES_RELATIVE), 'utf8'));

  check('summary schema', summary.schema === 'blur.map-laps-aid.aid-paths/1');
  check('summary level count', summary.levels.length === 7, 'got ' + summary.levels.length);
  const counts = summary.summary.counts;
  check('summary path count', counts.path === summary.levels.filter((row) => row.verdict === 'path').length);
  check('summary blocked count', counts.blocked === summary.levels.filter((row) => row.verdict === 'blocked').length);

  const rasterCache = new Map();
  function rasterFor(mapId) {
    if (!rasterCache.has(mapId)) {
      const file = path.join(ROOT, '_work/map-laps', mapId, 'grid.npz');
      const npz = readNpz(file);
      const base = npz['base.npy'];
      const xs = npz['xs.npy'];
      const zs = npz['zs.npy'];
      rasterCache.set(mapId, {
        base: base.data, nx: base.shape[1], nz: base.shape[0],
        xs: xs.data, zs: zs.data,
      });
    }
    return rasterCache.get(mapId);
  }

  for (const row of summary.levels) {
    const level = row.level;
    const mapId = row.mapId;
    const prefix = '\\gamedata\\levels\\' + level + '\\';
    const aidEntries = [...pakIndex.entries.values()]
      .filter((entry) => entry.path.toLowerCase().startsWith(prefix.toLowerCase())
        && entry.path.toLowerCase().endsWith('.aid'))
      .sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
    const spawnDoc = JSON.parse(readFileSync(path.join(ROOT, '_work/map-batch', level, 'spawn.json'), 'utf8'));
    const spawn = spawnDoc.layout.spawn;
    const pathDoc = JSON.parse(readFileSync(path.join(ROOT, '_work/map-batch', level, 'path.json'), 'utf8'));
    const raster = rasterFor(mapId);

    if (row.verdict === 'blocked' && row.blocker.stage === 'aid-missing') {
      check(level + ': no .aid file', aidEntries.length === 0,
        'expected no .aid, found ' + aidEntries.map((entry) => entry.path).join(', '));
      check(level + ': summary aid null', row.aid === null);
      check(level + ': blocker reason', typeof row.reason === 'string' && row.reason.length > 0);
      continue;
    }

    // Re-derive the route choice from the pak.
    const decoded = [];
    for (const entry of aidEntries) {
      const { logical } = readPakEntry(pakBuffer, pakIndex, entry.path);
      const doc = parseAid(logical);
      const sha256 = 'sha256:' + createHash('sha256').update(logical).digest('hex');
      for (const route of doc.routes) {
        if (route.segmentCount * 4 < MIN_LOOP_M) continue;
        if (!(route.flags & 1) || (route.flags & 32)) continue;
        if (route.lineCountSet.length !== 1 || route.lineCountSet[0] !== 11) continue;
        const points = buildPolyline(route).map((point) => [point.x, point.z]);
        points.push(points[0]);
        const nearest = nearestOnPolyline(points, spawn.x, spawn.z);
        const length = arcTable(points)[arcTable(points).length - 1];
        decoded.push({ entry, doc, route, points, sha256, spawnDistance: nearest.distance, spawnArc: nearest.arc, length });
      }
    }
    decoded.sort((a, b) => a.spawnDistance - b.spawnDistance
      || b.length - a.length
      || a.entry.path.toLowerCase().localeCompare(b.entry.path.toLowerCase())
      || a.route.index - b.route.index);
    const chosen = decoded[0];
    check(level + ': has a chosen racing line', Boolean(chosen));
    if (!chosen) continue;
    check(level + ': recorded route is the nearest spawn match',
      row.aid && row.aid.pakPath.toLowerCase() === chosen.entry.path.toLowerCase()
        && row.aid.routeName === chosen.route.name
        && row.aid.routeIndex === chosen.route.index,
      row.aid ? row.aid.pakPath + ' ' + row.aid.routeName : 'no aid');
    check(level + ': recorded route sha256', row.aid && row.aid.sha256 === chosen.sha256);
    check(level + ': recorded route flags', row.aid && row.aid.flags === chosen.route.flags);
    check(level + ': recorded route segments', row.aid && row.aid.segmentCount === chosen.route.segmentCount);

    // Record id from routes.json (city + route number).
    const stem = path.basename(chosen.entry.path, '.aid');
    const tail = stem.split('_').pop();
    const routeNumber = /^\d+$/.test(tail) ? Number(tail) : null;
    let record = null;
    if (routeNumber !== null) {
      const matches = routes.filter((item) => String(item.cityName).toLowerCase() === String(chosen.entry.path.split('\\')[3]).toLowerCase()
        && Number(item.routeNumber) === routeNumber);
      if (matches.length === 1) record = matches[0];
    } else {
      const city = chosen.entry.path.split('\\')[3];
      const matches = routes.filter((item) => String(item.cityName).toLowerCase() === city.toLowerCase());
      if (matches.length === 1) record = matches[0];
    }
    check(level + ': recorded route record id',
      row.aid && row.aid.routeRecordId === (record ? record.recordId : null),
      'expected ' + (record ? record.recordId : null) + ' got ' + (row.aid ? row.aid.routeRecordId : null));

    if (row.verdict === 'path') {
      const file = path.join(ROOT, row.pathFile);
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      check(level + ': path kind', doc.kind === 'e1-drive.sprint');
      check(level + ': path courseId', doc.courseId === mapId);
      check(level + ': path hash', doc.hash === canonicalHash(doc), doc.hash + ' != ' + canonicalHash(doc));
      check(level + ': path file sha256', row.pathFileSha256 === fileSha256(file));
      check(level + ': path content hash', row.pathContentHash === doc.hash);
      check(level + ': summary length', Math.abs(row.lengthMetres - doc.course.lengthMetres) < 1e-6);
      check(level + ': summary samples', row.samples === doc.course.sampleCount);
      check(level + ': summary gate arcs',
        row.gateArcs.length === doc.gates.length
          && row.gateArcs.every((value, index) => Math.abs(value - doc.gates[index].arc) < 1e-6));
      check(level + ': source aid identity',
        doc.source.aid.pakPath.toLowerCase() === row.aid.pakPath.toLowerCase()
          && doc.source.aid.routeName === row.aid.routeName
          && doc.source.aid.routeIndex === row.aid.routeIndex
          && doc.source.aid.sha256 === row.aid.sha256);

      const samples = doc.course.samples;
      check(level + ': sample count', samples.length === doc.course.sampleCount);
      check(level + ': start arc', samples[0].arc === 0);
      check(level + ': finish arc',
        Math.abs(samples[samples.length - 1].arc - doc.course.lengthMetres) < 1e-6);
      let monotone = true;
      for (let index = 1; index < samples.length; index++) {
        if (!(samples[index].arc > samples[index - 1].arc)) monotone = false;
      }
      check(level + ': arcs strictly increasing', monotone);

      let rasterOk = true;
      let bandOk = true;
      let firstRaster = null;
      let firstBand = null;
      for (let index = 0; index < samples.length; index++) {
        const sample = samples[index];
        if (!passable(raster, sample.x, sample.z)) {
          rasterOk = false;
          if (firstRaster === null) firstRaster = index;
        }
        const a = samples[Math.max(0, index - 1)];
        const b = samples[Math.min(samples.length - 1, index + 1)];
        const tx = b.x - a.x;
        const tz = b.z - a.z;
        const norm = Math.hypot(tx, tz) || 1;
        if (!bandPassable(raster, sample.x, sample.z, tx / norm, tz / norm)) {
          bandOk = false;
          if (firstBand === null) firstBand = index;
        }
      }
      check(level + ': every sample on P48 passable ground', rasterOk, 'first ' + firstRaster);
      check(level + ': every sample car band passable', bandOk, 'first ' + firstBand);

      const points = samples.map((sample) => [sample.x, sample.z]);
      const arc = samples.map((sample) => sample.arc);
      const length = doc.course.lengthMetres;
      check(level + ': 4 gates', doc.gates.length === 4);
      const kinds = doc.gates.map((gate) => gate.kind).join(',');
      check(level + ': gate kinds', kinds === 'start,checkpoint,checkpoint,finish', kinds);
      const ids = doc.gates.map((gate) => gate.id).join(',');
      check(level + ': gate ids', ids === 'start,checkpoint-1,checkpoint-2,finish', ids);
      let gateMonotone = true;
      for (let index = 1; index < doc.gates.length; index++) {
        if (!(doc.gates[index].arc > doc.gates[index - 1].arc)) gateMonotone = false;
      }
      check(level + ': gate arcs strictly increasing', gateMonotone);
      check(level + ': start gate arc', doc.gates[0].arc === 0);
      check(level + ': finish gate arc', Math.abs(doc.gates[3].arc - length) < 1e-6);
      check(level + ': checkpoint-1 window',
        Math.abs(doc.gates[1].arc - length / 3) <= 0.12 * length + 1e-6,
        doc.gates[1].arc + ' vs ' + length / 3);
      check(level + ': checkpoint-2 window',
        Math.abs(doc.gates[2].arc - 2 * length / 3) <= 0.12 * length + 1e-6,
        doc.gates[2].arc + ' vs ' + 2 * length / 3);
      const expected1 = straightest(points, arc, length / 3, length);
      const expected2 = straightest(points, arc, 2 * length / 3, length);
      check(level + ': checkpoint-1 station', doc.gates[1].sampleIndex === expected1,
        'expected ' + expected1 + ' got ' + doc.gates[1].sampleIndex);
      check(level + ': checkpoint-2 station', doc.gates[2].sampleIndex === expected2,
        'expected ' + expected2 + ' got ' + doc.gates[2].sampleIndex);
      for (const gate of doc.gates) {
        const sample = samples[gate.sampleIndex];
        check(level + ': gate ' + gate.id + ' sample/arc',
          Math.abs(sample.arc - gate.arc) < 1e-6
            && Math.abs(sample.x - gate.x) < 1e-6
            && Math.abs(sample.z - gate.z) < 1e-6);
        const tangent = tangentAt(points, gate.sampleIndex);
        check(level + ': gate ' + gate.id + ' tangent',
          Math.abs(tangent.tx - gate.tangent.tx) < 1e-6
            && Math.abs(tangent.tz - gate.tangent.tz) < 1e-6);
        const stats = gateLineStats(raster, gate.x, gate.z, gate.tangent.tx, gate.tangent.tz,
          gate.widthMetres / 2);
        check(level + ': gate ' + gate.id + ' line',
          stats.carStations > 0 && stats.carPassable === stats.carStations
            && stats.passableStations / stats.stations >= GATE_LINE_FRACTION_MIN,
          JSON.stringify(stats));
        check(level + ': gate ' + gate.id + ' width',
          gate.widthMetres <= gate.requestedWidthMetres + 1e-6);
        const approach = gate.kind === 'start'
          ? points[Math.min(points.length - 1, gate.sampleIndex + 1)]
          : points[Math.max(0, gate.sampleIndex - 1)];
        check(level + ': gate ' + gate.id + ' approach side',
          lineSide(gate.a, gate.b, approach) > 0);
        check(level + ': gate ' + gate.id + ' ground check',
          gate.groundCheck.passable === true && gate.groundCheck.carHalfWidthPassable === true);
      }
      continue;
    }

    // ---------------------------------------------------------------- blocked
    if (row.blocker.stage === 'spawn-match') {
      check(level + ': spawn match is the blocker',
        chosen.spawnDistance > MAX_SPAWN_OFFSET_M,
        chosen.spawnDistance + ' <= ' + MAX_SPAWN_OFFSET_M);
      check(level + ': recorded spawn distance',
        Math.abs(row.blocker.spawnDistanceMetres - chosen.spawnDistance) < 0.01,
        row.blocker.spawnDistanceMetres + ' vs ' + chosen.spawnDistance);
      const nearest = nearestOnPolyline(chosen.points, spawn.x, spawn.z);
      const a = chosen.points[nearest.segment];
      const b = chosen.points[nearest.segment + 1];
      const x = a[0] + (b[0] - a[0]) * nearest.t;
      const z = a[1] + (b[1] - a[1]) * nearest.t;
      check(level + ': recorded nearest point',
        Math.abs(row.blocker.x - x) < 0.01 && Math.abs(row.blocker.z - z) < 0.01,
        row.blocker.x + ',' + row.blocker.z + ' vs ' + x + ',' + z);
      continue;
    }

    if (row.blocker.stage === 'no-band-clear-lateral') {
      const finishNearest = nearestOnPolyline(chosen.points, pathDoc.end.x, pathDoc.end.z);
      const widths = chosen.route.segments.map((segment) => segment.width);
      const { stations } = resampleWithFrame(chosen.points, widths, chosen.spawnArc,
        finishNearest.arc, true);
      check(level + ': recorded station index in range',
        row.blocker.stationIndex >= 0 && row.blocker.stationIndex < stations.length);
      const station = stations[row.blocker.stationIndex];
      check(level + ': recorded station coordinate',
        Math.abs(row.blocker.x - station.x) < 0.01 && Math.abs(row.blocker.z - station.z) < 0.01,
        row.blocker.x + ',' + row.blocker.z + ' vs ' + station.x + ',' + station.z);
      check(level + ': racing line band fails at the witness',
        !bandPassable(raster, station.x, station.z, station.tx, station.tz));
      const limit = Math.min(LATERAL_SEARCH_M, station.width / 2);
      const steps = Math.floor(limit / LATERAL_STEP_M + 1e-9);
      let anyClear = false;
      for (let k = -steps; k <= steps; k++) {
        const d = k * LATERAL_STEP_M;
        const x = station.x - station.tz * d;
        const z = station.z + station.tx * d;
        if (bandPassable(raster, x, z, station.tx, station.tz)) { anyClear = true; break; }
      }
      check(level + ': no band-clear lateral at the witness', !anyClear);
      continue;
    }

    if (row.blocker.stage === 'resampled-band') {
      const finishNearest = nearestOnPolyline(chosen.points, pathDoc.end.x, pathDoc.end.z);
      const widths = chosen.route.segments.map((segment) => segment.width);
      const { stations } = resampleWithFrame(chosen.points, widths, chosen.spawnArc,
        finishNearest.arc, true);
      const projected = projectStations(raster, stations);
      check(level + ': projection exists', !projected.blocked);
      if (!projected.blocked) {
        const failures = finalBandFailures(raster, projected.points);
        check(level + ': resampled band fails', failures.length > 0);
        check(level + ': recorded resampled station',
          failures.includes(row.blocker.stationIndex),
          'expected one of ' + failures.slice(0, 5).join(',') + ' got ' + row.blocker.stationIndex);
        const point = projected.points[row.blocker.stationIndex];
        check(level + ': recorded resampled coordinate',
          Math.abs(row.blocker.x - point[0]) < 0.01 && Math.abs(row.blocker.z - point[1]) < 0.01,
          row.blocker.x + ',' + row.blocker.z + ' vs ' + point[0] + ',' + point[1]);
      }
      continue;
    }

    check(level + ': known blocker stage', false, row.blocker.stage);
  }

  const passed = checks.filter((item) => item.ok).length;
  for (const failure of failures) {
    console.log('FAIL ' + failure.name + (failure.detail ? ': ' + failure.detail : ''));
  }
  console.log(passed + '/' + checks.length + ' checks passed');
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = main();
