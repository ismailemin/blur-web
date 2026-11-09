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
//     (`_work/map-laps/<mapId>/grid.npz` base) and the tier's band;
//   * every detour record is checked against the racing point and the path
//     sample: band clearance, lateral offset, continuity (<= 0.5 m) and the
//     return to the racing line;
//   * the detour tier is checked against its window and band: `band` is the
//     declared +/-12 m respawn band with the 2.276 m band, `wide` is +/-24 m
//     with the same band, and `narrow` is +/-24 m with the 1.680 m band (the
//     documented car width, no margin). A path is only accepted when the whole
//     detoured line is band-clear and continuous;
//   * the gates are checked for order, arcs, the +/-12 % checkpoint window,
//     the 1 m approach side and the gate-line passability;
//   * every blocked verdict is re-derived from its witness: the spawn match
//     distance and its band-clear snap candidate, the station with no
//     band-clear lateral position at each attempted tier, or the detour-dp
//     station.
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
const DETOUR_TIERS = [
  { tier: 'band', searchMetres: 12, bandMetres: 2.276, marginMetres: 0.30,
    halfWidth: 1.138, bandStep: 0.25 },
  { tier: 'wide', searchMetres: 24, bandMetres: 2.276, marginMetres: 0.30,
    halfWidth: 1.138, bandStep: 0.25 },
  { tier: 'narrow', searchMetres: 24, bandMetres: 1.68, marginMetres: 0,
    halfWidth: 0.84, bandStep: 0.21 },
];
const DETOUR_STEP_M = 0.25;
const DETOUR_MAX_JUMP_M = 0.5;
const RACING_LINE = 5;
const GATE_HALF_WIDTH = 4.0;
const GATE_LINE_FRACTION_MIN = 0.5;
const TANGENT_WINDOW = 5.0;

function tierFor(searchMetres, bandMetres) {
  return DETOUR_TIERS.find((entry) =>
    Math.abs(entry.searchMetres - searchMetres) < 1e-9
    && Math.abs(entry.bandMetres - bandMetres) < 1e-9) || null;
}

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

function bandPassable(raster, x, z, tx, tz, halfWidth = HALF_WIDTH,
  bandStep = SAMPLE_STEP) {
  const nx = -tz;
  const nz = tx;
  const steps = Math.round(halfWidth / bandStep);
  for (let k = -steps; k <= steps; k++) {
    const d = k * bandStep;
    if (!passable(raster, x + nx * d, z + nz * d)) return false;
  }
  return true;
}

// The car band at every 0.25 m lateral offset in the tier window, in the
// racing-line frame. With the default 0.25 m band step this is the same
// sliding window as the builder's lateral_band_clear; a finer band step (the
// 1.68 m narrow band) tests each band sample at its own spacing.
// Returns one byte per offset (-searchM .. +searchM).
function bandClearWindow(raster, x, z, tx, tz, searchMetres,
  halfWidth = HALF_WIDTH, bandStep = SAMPLE_STEP) {
  const steps = Math.round(searchMetres / DETOUR_STEP_M);
  const bandSteps = Math.round(halfWidth / bandStep);
  const nx = -tz;
  const nz = tx;
  const clear = new Uint8Array(2 * steps + 1);
  if (Math.abs(bandStep - DETOUR_STEP_M) < 1e-12) {
    const total = 2 * (steps + bandSteps) + 1;
    const ok = new Uint8Array(total);
    for (let k = 0; k < total; k++) {
      const d = (k - steps - bandSteps) * DETOUR_STEP_M;
      ok[k] = passable(raster, x + nx * d, z + nz * d) ? 1 : 0;
    }
    const window = 2 * bandSteps + 1;
    let sum = 0;
    for (let w = 0; w < window; w++) sum += ok[w];
    clear[0] = sum === window ? 1 : 0;
    for (let k = 1; k <= 2 * steps; k++) {
      sum += ok[k + window - 1] - ok[k - 1];
      clear[k] = sum === window ? 1 : 0;
    }
    return clear;
  }
  clear.fill(1);
  for (let k = 0; k <= 2 * steps; k++) {
    const offset = (k - steps) * DETOUR_STEP_M;
    for (let j = -bandSteps; j <= bandSteps; j++) {
      const d = offset + j * bandStep;
      if (!passable(raster, x + nx * d, z + nz * d)) {
        clear[k] = 0;
        break;
      }
    }
  }
  return clear;
}

// Count the stations with no band-clear lateral position at a tier window and
// record the first one. This is the builder's typed blocker, re-derived.
function tierStats(raster, stations, tier) {
  let blocked = 0;
  let first = null;
  for (let index = 0; index < stations.length; index++) {
    const station = stations[index];
    const clear = bandClearWindow(raster, station.x, station.z,
      station.tx, station.tz, tier.searchMetres, tier.halfWidth, tier.bandStep);
    let any = false;
    for (let k = 0; k < clear.length; k++) if (clear[k]) { any = true; break; }
    if (!any) {
      blocked += 1;
      if (first === null) first = index;
    }
  }
  return { blocked, first };
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

// 0.25 m stations over the whole closed racing line (arc 0 .. total), the
// same sampler the builder uses for the spawn-snap candidate.
function resampleLoop(points, widths) {
  const arc = arcTable(points);
  const total = arc[arc.length - 1];
  const stations = [];
  let s = 0;
  while (s < total - 1e-9) {
    let index = 0;
    while (index < arc.length - 2 && arc[index + 1] < s) index++;
    const span = arc[index + 1] - arc[index];
    const t = span > 0 ? (s - arc[index]) / span : 0;
    const a = points[index];
    const b = points[index + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const norm = Math.hypot(dx, dz) || 1;
    stations.push({
      x: a[0] + dx * t, z: a[1] + dz * t, tx: dx / norm, tz: dz / norm, arc: s,
    });
    s += SAMPLE_STEP;
  }
  return { stations, total };
}

// Nearest band-clear point on the closed line, tested with the 0.5 m
// central-difference tangent the path validation uses.
function nearestBandClear(raster, points, widths, x, z) {
  const { stations, total } = resampleLoop(points, widths);
  const count = stations.length;
  let best = null;
  for (let index = 0; index < count; index++) {
    const station = stations[index];
    const a = stations[(index - 1 + count) % count];
    const b = stations[(index + 1) % count];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const norm = Math.hypot(tx, tz) || 1;
    if (!bandPassable(raster, station.x, station.z, tx / norm, tz / norm)) continue;
    const metres = Math.hypot(station.x - x, station.z - z);
    if (best === null || metres < best.metres) {
      best = { x: station.x, z: station.z, metres, arc: station.arc,
        tx: tx / norm, tz: tz / norm };
    }
  }
  return { best, total };
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

  check('summary schema', summary.schema === 'blur.map-laps-aid.aid-paths/4');
  check('summary level count', summary.levels.length === 7, 'got ' + summary.levels.length);
  const counts = summary.summary.counts;
  check('summary path count', counts.path === summary.levels.filter((row) => row.verdict === 'path').length);
  check('summary blocked count', counts.blocked === summary.levels.filter((row) => row.verdict === 'blocked').length);
  check('summary detour tiers',
    Array.isArray(summary.source.detourTiers) && summary.source.detourTiers.length === DETOUR_TIERS.length
      && summary.source.detourTiers.every((entry, index) =>
        entry.tier === DETOUR_TIERS[index].tier
        && entry.searchMetres === DETOUR_TIERS[index].searchMetres
        && entry.bandMetres === DETOUR_TIERS[index].bandMetres
        && entry.marginMetres === DETOUR_TIERS[index].marginMetres
        && entry.bandStepMetres === DETOUR_TIERS[index].bandStep));

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
      check(level + ': recorded aid entry count', row.blocker.aidEntriesFound === aidEntries.length,
        row.blocker.aidEntriesFound + ' vs ' + aidEntries.length);
      const directory = [...pakIndex.entries.values()]
        .filter((entry) => entry.path.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((entry) => entry.path)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      check(level + ': recorded level directory',
        Array.isArray(row.blocker.levelDirectoryEntries)
          && row.blocker.levelDirectoryEntries.length === directory.length
          && row.blocker.levelDirectoryEntries.every((value, index) => value === directory[index]),
        JSON.stringify(row.blocker.levelDirectoryEntries) + ' vs ' + JSON.stringify(directory));
      check(level + ': no detour tier attempted',
        row.detourTier === null && Array.isArray(row.blocker.detourTierAttempts)
          && row.blocker.detourTierAttempts.length === 0);
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
      const pathBandMetres = doc.source.aid.bandMetres ?? 2.276;
      const tier = tierFor(row.detourSearchMetres, pathBandMetres);
      const tierHalfWidth = tier ? tier.halfWidth : HALF_WIDTH;
      const tierBandStep = tier ? tier.bandStep : SAMPLE_STEP;
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
        if (!bandPassable(raster, sample.x, sample.z, tx / norm, tz / norm,
          tier ? tier.halfWidth : HALF_WIDTH, tier ? tier.bandStep : SAMPLE_STEP)) {
          bandOk = false;
          if (firstBand === null) firstBand = index;
        }
      }
      check(level + ': every sample on P48 passable ground', rasterOk, 'first ' + firstRaster);
      check(level + ': every sample car band passable', bandOk, 'first ' + firstBand);

      // ---------------------------------------------------------------- detours
      const lateralOffsets = doc.source.aid.lateralOffsets;
      check(level + ': lateral offset count',
        Array.isArray(lateralOffsets) && lateralOffsets.length === samples.length,
        lateralOffsets ? lateralOffsets.length + ' vs ' + samples.length : 'missing');
      const detourStations = [];
      for (let index = 0; index < lateralOffsets.length; index++) {
        if (Math.abs(lateralOffsets[index]) > 1e-9) detourStations.push(index);
      }
      check(level + ': summary detour count', row.detours === detourStations.length,
        row.detours + ' vs ' + detourStations.length);
      check(level + ': summary detour runs', typeof row.detourRuns === 'number');
      check(level + ': summary max lateral offset',
        Math.abs(row.maxLateralOffsetMetres - doc.source.aid.detourMaxLateralOffsetMetres) < 1e-6);
      check(level + ': source detour count',
        doc.source.aid.detourStationCount === detourStations.length);
      check(level + ': source detour runs',
        typeof doc.source.aid.detourRunCount === 'number');

      // ---------------------------------------------------------------- tier
      check(level + ': summary detour tier', tier !== null, String(row.detourTier));
      check(level + ': summary tier name', tier !== null && row.detourTier === tier.tier,
        row.detourTier + ' vs ' + (tier ? tier.tier : 'unknown'));
      check(level + ': summary band', tier !== null
        && Math.abs(row.bandMetres - tier.bandMetres) < 1e-9,
        row.bandMetres + ' vs ' + (tier ? tier.bandMetres : 'unknown'));
      check(level + ': summary margin', tier !== null
        && Math.abs(row.marginMetres - tier.marginMetres) < 1e-9,
        row.marginMetres + ' vs ' + (tier ? tier.marginMetres : 'unknown'));
      check(level + ': path detour window matches the tier',
        tier !== null && doc.source.aid.detourSearchMetres === tier.searchMetres,
        doc.source.aid.detourSearchMetres + ' vs ' + (tier ? tier.searchMetres : 'unknown'));
      check(level + ': course detour window matches the tier',
        tier !== null && doc.course.detour.searchMetres === tier.searchMetres);
      check(level + ': band tier is the default',
        row.detourTier !== 'band' || doc.source.aid.detourTier === undefined,
        'band paths record the tier as detourSearchMetres = 12');
      check(level + ': non-band tier is named in the path document',
        row.detourTier === 'band' || doc.source.aid.detourTier === row.detourTier,
        String(doc.source.aid.detourTier));
      check(level + ': non-band path records its band',
        row.detourTier === 'band'
          || (Math.abs(doc.source.aid.bandMetres - tier.bandMetres) < 1e-9
            && Math.abs(doc.source.aid.marginMetres - tier.marginMetres) < 1e-9
            && typeof doc.source.aid.detourTierReason === 'string'
            && doc.source.aid.detourTierReason.length > 0),
        JSON.stringify({ band: doc.source.aid.bandMetres,
          margin: doc.source.aid.marginMetres }));
      check(level + ': non-band clearance records the band',
        row.detourTier === 'band'
          || (doc.source.clearance.band
            && Math.abs(doc.source.clearance.band.metres - tier.bandMetres) < 1e-9
            && Math.abs(doc.source.clearance.band.halfWidthMetres - tier.halfWidth) < 1e-9
            && Math.abs(doc.source.clearance.band.marginMetres - tier.marginMetres) < 1e-9
            && Math.abs(doc.source.clearance.band.stepMetres - tier.bandStep) < 1e-9));
      check(level + ': clearance half-width matches the tier',
        tier !== null && Math.abs(doc.source.clearance.carHalfWidthM - tier.halfWidth) < 1e-9,
        doc.source.clearance.carHalfWidthM + ' vs ' + (tier ? tier.halfWidth : 'unknown'));
      check(level + ': lateral band matches the tier',
        tier !== null && Math.abs(doc.source.clearance.lateralBandMetres - tier.halfWidth) < 1e-9);
      check(level + ': detour step',
        doc.source.aid.detourStepMetres === DETOUR_STEP_M);
      check(level + ': detour continuity bound',
        doc.source.aid.detourMaxJumpMetres === DETOUR_MAX_JUMP_M);
      check(level + ': detour rule text',
        typeof doc.source.aid.detourRule === 'string'
          && doc.source.aid.detourRule.length > 0);
      check(level + ': detour records count',
        Array.isArray(doc.source.aid.detours)
          && doc.source.aid.detours.length === detourStations.length);
      check(level + ': every lateral offset inside the tier window',
        tier !== null && lateralOffsets.every((value) =>
          Math.abs(value) <= tier.searchMetres + 1e-6),
        'max ' + Math.max(...lateralOffsets.map((value) => Math.abs(value))));
      check(level + ': max lateral offset inside the tier window',
        tier !== null && Math.abs(row.maxLateralOffsetMetres) <= tier.searchMetres + 1e-6);

      // Re-derive the 0.25 m stations from the pak.
      const finishNearest = nearestOnPolyline(chosen.points, pathDoc.end.x, pathDoc.end.z);
      const widths = chosen.route.segments.map((segment) => segment.width);
      const { stations } = resampleWithFrame(chosen.points, widths,
        chosen.spawnArc, finishNearest.arc, true);
      check(level + ': station count', stations.length === samples.length,
        stations.length + ' vs ' + samples.length);

      let maxJump = 0;
      for (let index = 1; index < samples.length; index++) {
        maxJump = Math.max(maxJump, Math.hypot(
          samples[index].x - samples[index - 1].x,
          samples[index].z - samples[index - 1].z));
      }
      check(level + ': detour continuity', maxJump <= DETOUR_MAX_JUMP_M + 1e-6,
        maxJump + ' > ' + DETOUR_MAX_JUMP_M);

      let recordsOk = true;
      let recordsDetail = '';
      for (const record of doc.source.aid.detours) {
        const index = record.station;
        const station = stations[index];
        const sample = samples[index];
        if (!station || !sample) {
          recordsOk = false;
          recordsDetail = 'station ' + index + ' out of range';
          break;
        }
        const signed = -(sample.x - station.x) * station.tz
          + (sample.z - station.z) * station.tx;
        const reasonText = typeof record.reason === 'string' ? record.reason : '';
        const racingClear = bandPassable(raster, station.x, station.z,
          station.tx, station.tz, tierHalfWidth, tierBandStep);
        const reasonOk = racingClear
          ? reasonText.startsWith('continuity ramp')
          : reasonText.startsWith('the racing point is not');
        const ok = record.racingPoint
          && Math.abs(record.racingPoint.x - station.x) < 1e-4
          && Math.abs(record.racingPoint.z - station.z) < 1e-4
          && record.detourPoint
          && Math.abs(record.detourPoint.x - sample.x) < 1e-6
          && Math.abs(record.detourPoint.z - sample.z) < 1e-6
          && Math.abs(record.lateralOffset - lateralOffsets[index]) < 1e-6
          && Math.abs(record.lateralOffset - signed) < 1e-3
          && Math.abs(record.lateralOffset) <= (tier ? tier.searchMetres : 0) + 1e-6
          && reasonText.length > 0
          && reasonOk;
        if (!ok) {
          recordsOk = false;
          recordsDetail = 'station ' + index;
          break;
        }
      }
      check(level + ': detour records', recordsOk, recordsDetail);

      let runCount = 0;
      let runsOk = true;
      let runsDetail = '';
      let runIndex = 0;
      while (runIndex < lateralOffsets.length) {
        if (Math.abs(lateralOffsets[runIndex]) <= 1e-9) { runIndex++; continue; }
        const start = runIndex;
        while (runIndex < lateralOffsets.length
          && Math.abs(lateralOffsets[runIndex]) > 1e-9) runIndex++;
        const end = runIndex - 1;
        runCount++;
        if (start > 0 && Math.abs(lateralOffsets[start - 1]) > 1e-9) {
          runsOk = false;
          runsDetail = 'run at ' + start + ' does not start on the line';
        }
        if (end < lateralOffsets.length - 1
          && Math.abs(lateralOffsets[end + 1]) > 1e-9) {
          runsOk = false;
          runsDetail = 'run at ' + end + ' does not end on the line';
        }
        if (start > 0 && Math.abs(lateralOffsets[start]) > DETOUR_STEP_M + 1e-6) {
          runsOk = false;
          runsDetail = 'run at ' + start + ' starts at ' + lateralOffsets[start];
        }
        if (end < lateralOffsets.length - 1
          && Math.abs(lateralOffsets[end]) > DETOUR_STEP_M + 1e-6) {
          runsOk = false;
          runsDetail = 'run at ' + end + ' ends at ' + lateralOffsets[end];
        }
        let needed = false;
        for (let k = start; k <= end; k++) {
          const station = stations[k];
          if (!bandPassable(raster, station.x, station.z, station.tx, station.tz,
            tierHalfWidth, tierBandStep)) {
            needed = true;
            break;
          }
        }
        if (!needed) {
          runsOk = false;
          runsDetail = 'run ' + start + '-' + end + ' has no blocked racing point';
        }
      }
      check(level + ': detour runs return to the line', runsOk, runsDetail);
      check(level + ': summary detour runs match', row.detourRuns === runCount,
        row.detourRuns + ' vs ' + runCount);
      check(level + ': source detour runs match',
        doc.source.aid.detourRunCount === runCount);

      const startClear = bandPassable(raster, stations[0].x, stations[0].z,
        stations[0].tx, stations[0].tz, tierHalfWidth, tierBandStep);
      const lastStation = stations[stations.length - 1];
      const finishClear = bandPassable(raster, lastStation.x, lastStation.z,
        lastStation.tx, lastStation.tz, tierHalfWidth, tierBandStep);
      check(level + ': start returns to the line',
        !startClear || Math.abs(lateralOffsets[0]) < 1e-9,
        'offset ' + lateralOffsets[0]);
      check(level + ': finish returns to the line',
        !finishClear || Math.abs(lateralOffsets[lateralOffsets.length - 1]) < 1e-9,
        'offset ' + lateralOffsets[lateralOffsets.length - 1]);

      let detourBandOk = true;
      for (const index of detourStations) {
        const a = samples[Math.max(0, index - 1)];
        const b = samples[Math.min(samples.length - 1, index + 1)];
        const tx = b.x - a.x;
        const tz = b.z - a.z;
        const norm = Math.hypot(tx, tz) || 1;
        if (!bandPassable(raster, samples[index].x, samples[index].z,
          tx / norm, tz / norm, tierHalfWidth, tierBandStep)) detourBandOk = false;
      }
      check(level + ': every detour point band clear', detourBandOk);

      let detourStationBandOk = true;
      for (const index of detourStations) {
        const station = stations[index];
        if (!bandPassable(raster, samples[index].x, samples[index].z,
          station.tx, station.tz, tierHalfWidth, tierBandStep)) detourStationBandOk = false;
      }
      check(level + ': every detour point band clear in the racing-line frame',
        detourStationBandOk);

      const pathStartDistance = Math.hypot(samples[0].x - spawn.x,
        samples[0].z - spawn.z);
      const pathFinishDistance = Math.hypot(
        samples[samples.length - 1].x - pathDoc.end.x,
        samples[samples.length - 1].z - pathDoc.end.z);
      check(level + ': path start projection',
        Math.abs(doc.source.aid.pathStartProjectionMetres - pathStartDistance) < 1e-3,
        doc.source.aid.pathStartProjectionMetres + ' vs ' + pathStartDistance);
      check(level + ': path finish projection',
        Math.abs(doc.source.aid.pathFinishProjectionMetres - pathFinishDistance) < 1e-3,
        doc.source.aid.pathFinishProjectionMetres + ' vs ' + pathFinishDistance);
      check(level + ': recorded path start projection',
        Math.abs(doc.source.endpoints.spawnProjection.metres - pathStartDistance) < 1e-3);
      check(level + ': recorded path finish projection',
        Math.abs(doc.source.endpoints.finishProjection.metres - pathFinishDistance) < 1e-3);
      check(level + ': recorded racing-line finish projection',
        Math.abs(doc.source.endpoints.finishProjection.racingLineProjectionMetres
          - finishNearest.distance) < 1e-3);
      check(level + ': course finish clearance',
        Math.abs(doc.course.span.finishClearanceMetres - pathFinishDistance) < 1e-3);

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

      // Re-derive the nearest band-clear point on the whole racing line.
      const snap = row.blocker.spawnSnap;
      check(level + ': spawn snap recorded',
        snap && snap.attempted === true && snap.limitMetres === MAX_SPAWN_OFFSET_M);
      const widths = chosen.route.segments.map((segment) => segment.width);
      const { best } = nearestBandClear(raster, chosen.points, widths, spawn.x, spawn.z);
      check(level + ': a band-clear snap candidate exists', best !== null);
      if (best && snap && snap.nearestBandClearPoint) {
        const point = snap.nearestBandClearPoint;
        check(level + ': snap distance',
          Math.abs(point.metres - best.metres) < 0.01,
          point.metres + ' vs ' + best.metres);
        check(level + ': snap point',
          Math.abs(point.x - best.x) < 0.01 && Math.abs(point.z - best.z) < 0.01,
          point.x + ',' + point.z + ' vs ' + best.x + ',' + best.z);
        check(level + ': snap heading',
          Math.abs(point.headingRad - Math.atan2(best.tx, best.tz)) < 1e-3,
          point.headingRad + ' vs ' + Math.atan2(best.tx, best.tz));
        check(level + ': snap exceeds the match limit',
          best.metres > MAX_SPAWN_OFFSET_M, best.metres + ' <= ' + MAX_SPAWN_OFFSET_M);
        check(level + ': snap is not accepted', snap.withinLimit === false);
      }
      check(level + ': no detour tier attempted',
        row.detourTier === null && Array.isArray(row.blocker.detourTierAttempts)
          && row.blocker.detourTierAttempts.length === 0);
      continue;
    }

    if (row.blocker.stage === 'no-band-clear-lateral') {
      const finishNearest = nearestOnPolyline(chosen.points, pathDoc.end.x, pathDoc.end.z);
      const widths = chosen.route.segments.map((segment) => segment.width);
      const { stations } = resampleWithFrame(chosen.points, widths, chosen.spawnArc,
        finishNearest.arc, true);

      const attempts = row.blocker.detourTierAttempts;
      check(level + ': tier attempts recorded',
        Array.isArray(attempts) && attempts.length >= 1);
      check(level + ': tier attempts follow the tier table',
        Array.isArray(attempts) && attempts.every((attempt, index) =>
          DETOUR_TIERS[index]
            && attempt.tier === DETOUR_TIERS[index].tier
            && attempt.searchMetres === DETOUR_TIERS[index].searchMetres
            && Math.abs(attempt.bandMetres - DETOUR_TIERS[index].bandMetres) < 1e-9
            && Math.abs(attempt.marginMetres - DETOUR_TIERS[index].marginMetres) < 1e-9));
      check(level + ': band tier is attempted first',
        Array.isArray(attempts) && attempts.length >= 1 && attempts[0].tier === 'band');
      const lastTier = Array.isArray(attempts) && attempts.length > 0
        ? attempts[attempts.length - 1] : null;
      check(level + ': recorded blocker is the last attempted tier',
        lastTier !== null && row.detourTier === lastTier.tier
          && row.detourSearchMetres === lastTier.searchMetres
          && Math.abs(row.bandMetres - lastTier.bandMetres) < 1e-9
          && Math.abs(row.marginMetres - lastTier.marginMetres) < 1e-9,
        row.detourTier + ' vs ' + (lastTier ? lastTier.tier : 'none'));
      check(level + ': blocker tier fields agree',
        lastTier !== null && row.blocker.detourTier === lastTier.tier
          && row.blocker.detourSearchMetres === lastTier.searchMetres
          && Math.abs(row.blocker.bandMetres - lastTier.bandMetres) < 1e-9
          && Math.abs(row.blocker.marginMetres - lastTier.marginMetres) < 1e-9);

      // Re-derive every attempted tier: the full undetourable count and the
      // first station. This is the builder's typed blocker, not a paraphrase.
      for (const attempt of (Array.isArray(attempts) ? attempts : [])) {
        const attemptTier = tierFor(attempt.searchMetres, attempt.bandMetres);
        check(level + ': ' + attempt.tier + ' tier is known',
          attemptTier !== null && attemptTier.tier === attempt.tier);
        if (!attemptTier) continue;
        const stats = tierStats(raster, stations, attemptTier);
        check(level + ': ' + attempt.tier + ' blocked station count',
          attempt.blockedStations === stats.blocked,
          attempt.blockedStations + ' vs ' + stats.blocked);
        check(level + ': ' + attempt.tier + ' first blocked station',
          attempt.stationIndex === stats.first,
          attempt.stationIndex + ' vs ' + stats.first);
        check(level + ': ' + attempt.tier + ' blocker stage',
          attempt.stage === 'no-band-clear-lateral', String(attempt.stage));
        if (stats.first !== null) {
          const first = stations[stats.first];
          check(level + ': ' + attempt.tier + ' first station coordinate',
            Math.abs(attempt.x - first.x) < 0.01
              && Math.abs(attempt.z - first.z) < 0.01,
            attempt.x + ',' + attempt.z + ' vs ' + first.x + ',' + first.z);
        }
      }

      check(level + ': recorded station index in range',
        row.blocker.stationIndex >= 0 && row.blocker.stationIndex < stations.length);
      const station = stations[row.blocker.stationIndex];
      check(level + ': recorded station coordinate',
        Math.abs(row.blocker.x - station.x) < 0.01 && Math.abs(row.blocker.z - station.z) < 0.01,
        row.blocker.x + ',' + row.blocker.z + ' vs ' + station.x + ',' + station.z);
      const witnessTier = lastTier
        ? tierFor(lastTier.searchMetres, lastTier.bandMetres) : null;
      check(level + ': witness tier is known', witnessTier !== null);
      check(level + ': racing line band fails at the witness',
        witnessTier !== null && !bandPassable(raster, station.x, station.z,
          station.tx, station.tz, witnessTier.halfWidth, witnessTier.bandStep));
      check(level + ': detour search window recorded',
        lastTier !== null && row.blocker.detourSearchMetres === lastTier.searchMetres
          && witnessTier !== null,
        row.blocker.detourSearchMetres + ' vs ' + (lastTier ? lastTier.searchMetres : 'none'));
      const clear = witnessTier === null ? null : bandClearWindow(
        raster, station.x, station.z, station.tx, station.tz,
        witnessTier.searchMetres, witnessTier.halfWidth, witnessTier.bandStep);
      check(level + ': no band-clear lateral at the witness',
        clear !== null && !clear.some((value) => value === 1));
      check(level + ': later tiers are only tried after the previous fails',
        Array.isArray(attempts) && attempts.slice(1).every((attempt, index) =>
          attempts[index].stage === 'no-band-clear-lateral'
            || attempts[index].stage === 'detour-dp'));
      continue;
    }

    if (row.blocker.stage === 'detour-dp') {
      const finishNearest = nearestOnPolyline(chosen.points, pathDoc.end.x, pathDoc.end.z);
      const widths = chosen.route.segments.map((segment) => segment.width);
      const { stations } = resampleWithFrame(chosen.points, widths, chosen.spawnArc,
        finishNearest.arc, true);
      check(level + ': detour-dp station in range',
        row.blocker.stationIndex >= 0 && row.blocker.stationIndex < stations.length);
      const station = stations[row.blocker.stationIndex];
      check(level + ': detour-dp station coordinate',
        Math.abs(row.blocker.x - station.x) < 0.01
          && Math.abs(row.blocker.z - station.z) < 0.01,
        row.blocker.x + ',' + row.blocker.z + ' vs ' + station.x + ',' + station.z);
      const dpTier = tierFor(row.blocker.detourSearchMetres, row.blocker.bandMetres);
      check(level + ': detour-dp tier recorded',
        dpTier !== null && row.detourTier === dpTier.tier);
      const clear = dpTier === null ? null : bandClearWindow(
        raster, station.x, station.z, station.tx, station.tz,
        dpTier.searchMetres, dpTier.halfWidth, dpTier.bandStep);
      check(level + ': detour-dp station has a band-clear lateral',
        clear !== null && clear.some((value) => value === 1));
      check(level + ': detour-dp continuity bound',
        row.blocker.detourMaxJumpMetres === DETOUR_MAX_JUMP_M);
      continue;
    }

    if (row.blocker.stage === 'resampled-band') {
      check(level + ': resampled band reason',
        typeof row.reason === 'string' && row.reason.length > 0);
      check(level + ': resampled band station in range',
        row.blocker.stationIndex >= 0);
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
