#!/usr/bin/env node
// Deterministic builder for the committed retail pickup-route artifact.
//
//   node probes/powerups/tools/build_pickup_routes.mjs
//   node probes/powerups/tools/build_pickup_routes.mjs --out <json> --quiet
//
// Inputs (read-only):
//   game-data/Blur/cache/gamedata.pak                       retail pak (2KAP v2, zlib)
//   \gamedata\levels\usa_amboy\usa_amboy_3.aid              Route USA_Amboy_3        (record 633252245)
//   \gamedata\levels\spa_barcelona_gracia\spa_barcelona_gracia_2.aid
//                                                           Route SPA_Barcelona_Gracia_2 (record 46220414)
//   \gamedata\levels\usa_la_river\usa_la_river_3.aid        Route USA_LA_River_3     (record 1643385212)
//   probes/powerups/data/runtime-placement.json             committed retail pickup xyz
//
// Output (committed):
//   probes/powerups/data/pickup-routes.json
//
// Why this file exists
// --------------------
// PWR6/PWR7 measured every retail pickup against the *measured* e1-drive
// sub-course and found that the slots do not lie on it (Amboy 2/82 within 5 m,
// Gracia 2/59). The slots do lie on the retail route: `LevelState.cpp:298`
// builds the AI track filename as
//   ".\gamedata\levels\%s\%s.aid"  (cityName, route->tag)
// and `AI_Amax.cpp:1595-2163` (`LoadVersionSix`) decodes that file into
// `AITrackDataRoutes` / `AITrackDataSegments` / `AITrackDataLines`. The pickup
// positions project onto that route network (see the README for the counts).
//
// This builder only serialises what the retail loader reads. It does not
// invent widths, offsets, lanes or heights: every number below is either a
// decoded .aid field or a value derived from decoded fields by the documented
// rules in `projectionRule`.
//
// Coordinate convention, exactly as `LoadVersionSix` stores it:
//   segment origin   = (xFile, -zFile)          (world XZ, metres)
//   segment normal   = (tangentX, -tangentZ)    (unit-ish lateral axis)
//   line k position  = origin + normal * width * line[k].offset
//   line k height    = line[k].height           (world Y, metres)
// This matches `AITrackDataSegments::GetPositionFromOffset`
// (`trackdata.h:477-490`) and `GetPositionFromLine` (`trackdata.h:492-564`).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DEFAULT_OUT = path.join(ROOT, 'probes/powerups/data/pickup-routes.json');
const PACK_RELATIVE = 'game-data/Blur/cache/gamedata.pak';
const PLACEMENT_RELATIVE = 'probes/powerups/data/runtime-placement.json';

const SCHEMA = 'blur-powerups-pickup-routes/1';
const STEP_SIZE_M = 4.0;
const RACING_LINE = 5;
const CORRIDOR_TOLERANCE_M = 0.5;
const REPORT_TOLERANCES_M = [2, 5, 10];

const LINE_NAMES = [
  'RIGHT_5', 'RIGHT_4', 'RIGHT_3', 'RIGHT_2', 'RIGHT_1',
  'RACING', 'LEFT_1', 'LEFT_2', 'LEFT_3', 'LEFT_4', 'LEFT_5'
];

const FLAG_NAMES = {
  1: 'ROUTE_LOOPED',
  2: 'ROUTE_START_ZONE',
  4: 'ROUTE_FINISH_ZONE',
  8: 'ROUTE_INTERMEDIATE_ZONE_1',
  16: 'ROUTE_INTERMEDIATE_ZONE_2',
  32: 'ROUTE_LOGIC_ZONE',
  64: 'ROUTE_JUNCTION',
  128: 'ROUTE_DYNAMIC_JUNCTION_ZONE',
  256: 'ROUTE_VALID_RESET',
  512: 'ROUTE_VALID_NITRO',
  1024: 'ROUTE_VALID_DROP_PRIORITY'
};

// Route record -> .aid file. The mapping is the retail rule
// `LevelState.cpp:298` ("<city>\<route->tag>.aid") plus the `Route.Name` value
// recorded by PWR6 in `_work/powerups/routes.json`:
//   633252245 USA_Amboy              RouteNumber 3  Name USA_Amboy_3
//   46220414  SPA_Barcelona_Gracia   RouteNumber 2  Name SPA_Barcelona_Gracia_2
//   1643385212 USA_LA_River          RouteNumber 3  Name USA_LA_River_3
const MAPS = [
  {
    mapId: 'amboy',
    level: 'usa_amboy',
    cityName: 'USA_Amboy',
    routeRecordId: 633252245,
    routeNumber: 3,
    routeName: 'USA_Amboy_3',
    aidPath: '\\gamedata\\levels\\usa_amboy\\usa_amboy_3.aid'
  },
  {
    mapId: 'gracia',
    level: 'spa_barcelona_gracia',
    cityName: 'SPA_Barcelona_Gracia',
    routeRecordId: 46220414,
    routeNumber: 2,
    routeName: 'SPA_Barcelona_Gracia_2',
    aidPath: '\\gamedata\\levels\\spa_barcelona_gracia\\spa_barcelona_gracia_2.aid'
  },
  {
    mapId: 'river',
    level: 'usa_la_river',
    cityName: 'USA_LA_River',
    routeRecordId: 1643385212,
    routeNumber: 3,
    routeName: 'USA_LA_River_3',
    aidPath: '\\gamedata\\levels\\usa_la_river\\usa_la_river_3.aid'
  }
];

const round = (value, digits) => {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/**
 * Pretty printer that keeps numeric arrays on one line. `JSON.stringify(doc,
 * null, 2)` puts every coordinate on its own line, which triples the size of a
 * 15k-point geometry file. Objects stay indented; arrays of numbers stay inline.
 */
function stringify(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((item) => typeof item === 'number')) return '[' + value.join(', ') + ']';
    const items = value.map((item) => '  '.repeat(indent + 1) + stringify(item, indent + 1));
    return '[\n' + items.join(',\n') + '\n' + pad + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const items = keys.map((key) => '  '.repeat(indent + 1) + JSON.stringify(key) + ': ' + stringify(value[key], indent + 1));
    return '{\n' + items.join(',\n') + '\n' + pad + '}';
  }
  return JSON.stringify(value);
}

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, quiet: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--out') options.out = path.resolve(argv[++index]);
    else if (arg === '--quiet') options.quiet = true;
    else throw new Error('unknown argument ' + JSON.stringify(arg));
  }
  return options;
}

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
  if (version !== 2) throw new Error('gamedata.pak: version ' + version + ' is not supported');
  if (headerSize !== 32) throw new Error('gamedata.pak: header size ' + headerSize + ' is not 32');
  const stringBlock = buffer.readUInt32LE(36);
  const fatBlock = buffer.readUInt32LE(40);
  const metadataEnd = sector + stringBlock + fatBlock;

  const stringSize = buffer.readUInt32LE(sector);
  if (stringSize + 4 > stringBlock) throw new Error('gamedata.pak: string table exceeds its block');
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
    if (stringOffset >= strings.length) throw new Error('gamedata.pak: path outside string table');
    const end = strings.indexOf(0, stringOffset);
    if (end < 0) throw new Error('gamedata.pak: unterminated path');
    const name = strings.toString('utf8', stringOffset, end);
    if (start === 0xffffffffffffffffn) continue;
    const offset = Number(start) * sector;
    if (offset < metadataEnd || offset + stored > buffer.length) {
      throw new Error('gamedata.pak: payload bounds invalid for ' + name);
    }
    entries.set(name.toLowerCase(), {
      path: name,
      offset,
      storedBytes: stored,
      logicalBytes: logical,
      pathCrc32: crc.toString(16).padStart(8, '0'),
      fatIndex: index
    });
  }
  return { entries, codec, fatType, metadataEnd };
}

function readPakEntry(buffer, index, relative) {
  const entry = index.entries.get(relative.toLowerCase());
  if (!entry) throw new Error('gamedata.pak: missing entry ' + relative);
  if (index.codec !== 2) throw new Error('gamedata.pak: codec ' + index.codec + ' is not zlib');
  const packed = buffer.subarray(entry.offset, entry.offset + entry.storedBytes);
  const logical = inflateSync(packed);
  if (logical.length !== entry.logicalBytes) {
    throw new Error(relative + ': inflated ' + logical.length + ' bytes, expected ' + entry.logicalBytes);
  }
  return { entry, logical };
}

// ---------------------------------------------------------------- aid reader
function parseAid(buffer) {
  let pos = 0;
  const need = (count, what) => {
    if (count < 0 || pos + count > buffer.length) {
      throw new Error(what + ' at byte ' + pos + ' runs past ' + buffer.length + ' bytes');
    }
  };
  const i32 = (what) => { need(4, what); const value = buffer.readInt32LE(pos); pos += 4; return value; };
  const f32 = (what) => { need(4, what); const value = buffer.readFloatLE(pos); pos += 4; return value; };
  const i8 = (what) => { need(1, what); const value = buffer.readInt8(pos); pos += 1; return value; };
  const text = (what) => {
    const start = pos;
    const length = i32(what + ' length');
    if (length < 0 || length > (1 << 20)) throw new Error(what + ' length is not bounded at ' + start);
    need(length, what);
    const value = buffer.toString('latin1', pos, pos + length);
    pos += length;
    return value;
  };
  const junction = (rule, at) => {
    const out = { rule, byteOffset: at };
    if (rule === 1) out.state = i32('junction rule 1 state');
    else if (rule === 2) { out.routeName = text('junction rule 2 route'); out.state = i32('junction rule 2 state'); }
    else if (rule === 3) { out.routeName = text('junction rule 3 route'); out.state = i32('junction rule 3 state'); out.seconds = f32('junction rule 3 seconds'); }
    else if (rule === 4) { out.routeName = text('junction rule 4 route'); out.state = [i32('state0')]; out.seconds = [f32('seconds0')]; out.state.push(i32('state1')); out.seconds.push(f32('seconds1')); }
    else if (rule === 5) { out.state = [i32('state0')]; out.seconds = [f32('seconds0')]; out.state.push(i32('state1')); out.seconds.push(f32('seconds1')); }
    else if (rule === 6 || rule === 7) { out.state = i32('state'); out.lap = Math.trunc(f32('lap')); }
    else if (rule === 8) { out.state = i32('state'); out.laps = [0, 1, 2].map((k) => Math.trunc(f32('lap' + k))); }
    else if (rule === 9) { out.state = i32('state'); out.cars = Math.trunc(f32('cars')); out.resetSeconds = f32('reset'); }
    else out.unsupportedRule = true;
    return out;
  };

  const version = f32('version');
  if (version !== 6) throw new Error('unsupported .aid revision ' + version + '; this reader implements 6.0');
  const routeCount = i32('route count');
  if (routeCount < 0 || routeCount > 4096) throw new Error('route count is not bounded');

  const routes = [];
  for (let r = 0; r < routeCount; r++) {
    const routeByteOffset = pos;
    const name = text('route ' + r + ' name');
    const inputRoute = text('route ' + r + ' input');
    const outputRoute = text('route ' + r + ' output');
    const flags = i32('route ' + r + ' flags');
    const routeJunction = (flags & 128) ? junction(i32('junction rule'), pos - 4) : null;
    const segmentCount = i32('route ' + r + ' segment count');
    if (segmentCount < 0 || segmentCount > 200000) throw new Error('segment count is not bounded');

    const segments = [];
    const lineCountSet = new Set();
    for (let s = 0; s < segmentCount; s++) {
      const segmentByteOffset = pos;
      const xFile = f32('x');
      const yFile = f32('y');
      const zFile = f32('z');
      const width = f32('width');
      const tangentXFile = f32('tangentX');
      const tangentZFile = f32('tangentZ');
      const tangent3 = [f32('t3x'), f32('t3y'), f32('t3z')];
      const minY = f32('minY');
      const maxY = f32('maxY');
      const lineCount = i32('line count');
      if (lineCount < 0 || lineCount > 64) throw new Error('line count is not bounded');
      lineCountSet.add(lineCount);
      const heights = [];
      const offsets = [];
      for (let k = 0; k < lineCount; k++) {
        f32('curvature');
        f32('distance');
        i32('pointFlags');
        heights.push(f32('height'));
        offsets.push(f32('offset'));
        i8('surfaceFlags');
        f32('yAngle');
      }
      segments.push({
        index: s,
        byteOffset: segmentByteOffset,
        xFile, yFile, zFile, width,
        tangentXFile, tangentZFile, tangent3, minY, maxY,
        lineCount, heights, offsets
      });
    }
    routes.push({
      index: r,
      byteOffset: routeByteOffset,
      name, inputRoute, outputRoute, flags,
      flagNames: Object.keys(FLAG_NAMES).map(Number).filter((bit) => flags & bit).map((bit) => FLAG_NAMES[bit]),
      junction: routeJunction,
      segmentCount,
      lineCountSet: [...lineCountSet].sort((a, b) => a - b),
      segments,
      endByteOffset: pos
    });
  }

  const cacheSize = i32('data cache size');
  if (cacheSize < 0 || cacheSize > 200000) throw new Error('data cache size is not bounded');
  const dataCache = [];
  for (let c = 0; c < cacheSize; c++) {
    const recordCount = i32('cache record count');
    if (recordCount < 0 || recordCount > 200000) throw new Error('cache record count is not bounded');
    const records = [];
    for (let k = 0; k < recordCount; k++) {
      const cacheIndex = i32('cache index');
      records.push({ index: cacheIndex, routeName: text('cache route name') });
    }
    dataCache.push({ index: c, records });
  }

  if (pos !== buffer.length) throw new Error('trailing bytes: parsed ' + pos + ' of ' + buffer.length);
  return { version, routeCount, routes, dataCache, parsedBytes: pos, fileBytes: buffer.length };
}

// ---------------------------------------------------------------- geometry
function segmentFrame(segment) {
  const x = segment.xFile;
  const z = -segment.zFile;
  let nx = segment.tangentXFile;
  let nz = -segment.tangentZFile;
  const length = Math.hypot(nx, nz);
  if (length > 0) { nx /= length; nz /= length; }
  return { x, z, nx, nz, fx: -nz, fz: nx };
}

function linePoint(segment, lineIndex) {
  const frame = segmentFrame(segment);
  const offset = segment.offsets[lineIndex];
  return {
    x: frame.x + frame.nx * segment.width * offset,
    z: frame.z + frame.nz * segment.width * offset,
    y: segment.heights[lineIndex]
  };
}

function buildPolyline(route) {
  const points = [];
  let arc = 0;
  let previous = null;
  let stepMin = Infinity;
  let stepMax = 0;
  for (let index = 0; index < route.segments.length; index++) {
    const point = linePoint(route.segments[index], RACING_LINE);
    if (previous) {
      const step = Math.hypot(point.x - previous.x, point.z - previous.z);
      stepMin = Math.min(stepMin, step);
      stepMax = Math.max(stepMax, step);
      arc += step;
    }
    points.push({ x: point.x, y: point.y, z: point.z, arc });
    previous = point;
  }
  return {
    points,
    lengthMetres: arc,
    stepMinMetres: points.length > 1 ? stepMin : 0,
    stepMaxMetres: points.length > 1 ? stepMax : 0
  };
}

function nearestOnPolyline(points, x, z) {
  let best = { distance: Infinity, segment: 0, t: 0, arc: 0 };
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const lengthSquared = vx * vx + vz * vz;
    let t = lengthSquared > 0 ? ((x - a.x) * vx + (z - a.z) * vz) / lengthSquared : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + vx * t;
    const pz = a.z + vz * t;
    const distance = Math.hypot(x - px, z - pz);
    if (distance < best.distance) {
      best = { distance, segment: index, t, arc: a.arc + (b.arc - a.arc) * t };
    }
  }
  return best;
}

/**
 * Distance from a world XZ point to the engine's segment quad
 * (`AITrackDataSegments::GetSegmentBounds` / `InSegmentWidths`,
 * `trackdata.h:1055-1122`): lateral offset 0..1 of `width`, longitudinal
 * +/- half of the 4 m route step. Returns 0 inside the corridor.
 */
function corridorProjection(route, x, z) {
  let best = null;
  for (const segment of route.segments) {
    const frame = segmentFrame(segment);
    const dx = x - frame.x;
    const dz = z - frame.z;
    const along = dx * frame.fx + dz * frame.fz;
    const lateral = dx * frame.nx + dz * frame.nz;
    const width = segment.width;
    const lateralOutside = lateral < 0 ? -lateral : lateral > width ? lateral - width : 0;
    const alongOutside = along < -2 ? -2 - along : along > 2 ? along - 2 : 0;
    const distance = Math.hypot(lateralOutside, alongOutside);
    if (best === null || distance < best.distance) {
      best = {
        distance,
        segment: segment.index,
        along,
        lateral,
        offset: width > 0 ? lateral / width : 0,
        width
      };
    }
  }
  return best;
}

function classify(mapId, pickups, routes, polylines) {
  const assignments = [];
  for (const pickup of pickups) {
    const candidates = [];
    let networkDistance = Infinity;
    for (const route of routes) {
      const projection = corridorProjection(route, pickup.x, pickup.z);
      const racing = nearestOnPolyline(polylines.get(route.index).points, pickup.x, pickup.z);
      networkDistance = Math.min(networkDistance, racing.distance);
      candidates.push({ route, projection, racing });
    }
    // A pickup can sit inside several overlapping corridors (MainLoop + Logic +
    // an alternate). The most specific carrier is the narrowest containing
    // corridor; every carrier is kept in `containingRoutes`.
    const containing = candidates
      .filter((candidate) => candidate.projection.distance <= CORRIDOR_TOLERANCE_M)
      .sort((a, b) => a.projection.distance - b.projection.distance
        || a.projection.width - b.projection.width
        || a.racing.distance - b.racing.distance
        || a.route.index - b.route.index);
    const primary = containing.length > 0
      ? containing[0]
      : candidates.slice().sort((a, b) => a.projection.distance - b.projection.distance
        || a.racing.distance - b.racing.distance
        || a.route.index - b.route.index)[0];
    const onRoute = primary.projection.distance <= CORRIDOR_TOLERANCE_M;
    assignments.push({
      id: mapId + ':' + pickup.uid,
      uid: pickup.uid,
      type: pickup.type,
      position: [round(pickup.x, 4), round(pickup.y, 4), round(pickup.z, 4)],
      route: primary.route.name,
      routeIndex: primary.route.index,
      segment: primary.projection.segment,
      arc: round(primary.racing.arc, 4),
      offset: round(primary.projection.offset, 6),
      lateral: round(primary.projection.lateral, 4),
      width: round(primary.projection.width, 4),
      along: round(primary.projection.along, 4),
      containingRoutes: containing.map((candidate) => ({
        name: candidate.route.name,
        index: candidate.route.index,
        width: round(candidate.projection.width, 3)
      })),
      distanceToRouteNetwork: round(networkDistance, 4),
      distanceToAssignedRacingLine: round(primary.racing.distance, 4),
      distanceToCorridor: round(primary.projection.distance, 4),
      onRoute,
      status: onRoute ? 'on-route' : 'off-route'
    });
  }
  return assignments;
}

function buildMap(map, pakBuffer, pakIndex, placements) {
  const { entry, logical } = readPakEntry(pakBuffer, pakIndex, map.aidPath);
  const doc = parseAid(logical);
  const polylineByIndex = new Map();
  const routes = [];
  for (const route of doc.routes) {
    const polyline = buildPolyline(route);
    polylineByIndex.set(route.index, polyline);
    const closed = (route.flags & 1) === 1;
    const first = polyline.points[0];
    const last = polyline.points[polyline.points.length - 1];
    routes.push({
      index: route.index,
      name: route.name,
      flags: route.flags,
      flagNames: route.flagNames,
      closed,
      closureMetres: closed ? round(Math.hypot(first.x - last.x, first.z - last.z), 6) : null,
      junction: route.junction,
      segmentCount: route.segmentCount,
      lineCount: route.lineCountSet.length === 1 ? route.lineCountSet[0] : route.lineCountSet,
      byteOffset: route.byteOffset,
      firstSegmentByteOffset: route.segments.length ? route.segments[0].byteOffset : null,
      segmentStrideBytes: route.segments.length > 1
        ? route.segments[1].byteOffset - route.segments[0].byteOffset
        : null,
      endByteOffset: route.endByteOffset,
      routeLengthM: round(route.segmentCount * STEP_SIZE_M, 4),
      lengthMetres: round(polyline.lengthMetres, 4),
      stepMinMetres: round(polyline.stepMinMetres, 4),
      stepMaxMetres: round(polyline.stepMaxMetres, 4),
      points: polyline.points.map((point) => [
        round(point.x, 3), round(point.y, 3), round(point.z, 3), round(point.arc, 2)
      ]),
      widths: route.segments.map((segment) => round(segment.width, 3)),
      racingOffsets: route.segments.map((segment) => round(segment.offsets[RACING_LINE], 4))
    });
  }

  const mapPlacements = placements.maps[map.mapId];
  if (!mapPlacements) throw new Error('runtime-placement.json has no map ' + map.mapId);
  if (mapPlacements.routeRecordId !== map.routeRecordId) {
    throw new Error(map.mapId + ': route record ' + mapPlacements.routeRecordId + ' != ' + map.routeRecordId);
  }
  const pickups = mapPlacements.pickups.map((pickup) => ({
    uid: pickup.uid, type: pickup.type, x: pickup.x, y: pickup.y, z: pickup.z
  }));
  const assignments = classify(map.mapId, pickups, doc.routes, polylineByIndex);

  const offRoute = assignments.filter((row) => !row.onRoute);
  const distances = assignments.map((row) => row.distanceToRouteNetwork).sort((a, b) => a - b);
  const counts = {
    retailPlacements: pickups.length,
    onRoute: assignments.length - offRoute.length,
    offRoute: offRoute.length,
    corridorMaxMetres: round(assignments.reduce((max, row) => Math.max(max, row.distanceToCorridor), 0), 4)
  };
  for (const tolerance of REPORT_TOLERANCES_M) {
    counts['within' + tolerance + 'mOfRouteNetwork'] = assignments.filter((row) => row.distanceToRouteNetwork <= tolerance).length;
  }
  counts.medianDistanceToRouteNetwork = round(distances[Math.floor(distances.length / 2)] ?? 0, 4);

  const aidSha256 = createHash('sha256').update(logical).digest('hex');
  return {
    mapId: map.mapId,
    level: map.level,
    cityName: map.cityName,
    routeRecordId: map.routeRecordId,
    routeNumber: map.routeNumber,
    routeName: map.routeName,
    actorListId: mapPlacements.actorListId ?? null,
    aid: {
      pakPath: map.aidPath,
      pakOffset: entry.offset,
      fatIndex: entry.fatIndex,
      pathCrc32: entry.pathCrc32,
      storedBytes: entry.storedBytes,
      logicalBytes: entry.logicalBytes,
      sha256: aidSha256,
      revision: doc.version,
      routeCount: doc.routeCount,
      parsedBytes: doc.parsedBytes
    },
    stepSizeM: STEP_SIZE_M,
    racingLineIndex: RACING_LINE,
    routes,
    pickups: assignments,
    offRoute: offRoute.map((row) => ({ id: row.id, uid: row.uid, distance: row.distanceToCorridor })),
    counts
  };
}

function buildDocument() {
  const pakRelative = PACK_RELATIVE;
  const pakBuffer = readFileSync(path.join(ROOT, pakRelative));
  const pakIndex = readPakIndex(pakBuffer);
  const placementsText = readFileSync(path.join(ROOT, PLACEMENT_RELATIVE));
  const placements = JSON.parse(placementsText.toString('utf8'));

  const maps = {};
  for (const map of MAPS) maps[map.mapId] = buildMap(map, pakBuffer, pakIndex, placements);

  return {
    schema: SCHEMA,
    kind: 'powerups.pickup-routes',
    version: 1,
    generatedBy: 'probes/powerups/tools/build_pickup_routes.mjs',
    scope: 'Retail .aid route network for the primary raced route of amboy, gracia and river. ' +
      'Each route is the ordered racing-line polyline (line index 5) of the retail ' +
      'AITrackDataRoutes record, with arc length, serialized width and serialized racing-line ' +
      'offset per segment. Every retail pickup of probes/powerups/data/runtime-placement.json is ' +
      'projected onto the network. No coordinate, width or offset is synthesized.',
    formatAuthority: {
      aidLoader: 'upstream/BlurRebuilt/code/amax/game/AI/AI_Amax.cpp:1595-2163 (LoadVersionSix)',
      aidFilename: 'upstream/BlurRebuilt/code/amax/game/GameLogic/Structures/LevelState.cpp:298',
      trackData: 'upstream/BlurRebuilt/code/mercury/library/ai/air/include/trackdata/trackdata.h',
      stepSize: 'ctrackdata.cpp:196 (fixed 4.0 m route step)',
      decoder: 'probes/course/tools/aid_decode.py (read-only reference; this builder re-implements it)'
    },
    coordinateRule: 'segment origin = (xFile, -zFile); segment lateral normal = normalize(tangentX, -tangentZ); ' +
      'line k position = origin + normal * width * line[k].offset; line k y = line[k].height. ' +
      'Matches AITrackDataSegments::GetPositionFromOffset (trackdata.h:477-490).',
    projectionRule: 'A pickup is on-route when it falls inside at least one engine segment quad ' +
      '(AITrackDataSegments::GetSegmentBounds / InSegmentWidths, trackdata.h:1055-1122): ' +
      'lateral offset in [0, 1] * width and longitudinal offset in [-2, +2] m around a 4 m sample. ' +
      '`containingRoutes` lists every route whose corridor contains the pickup, narrowest first. ' +
      '`route`/`routeIndex`/`segment`/`arc`/`offset`/`lateral`/`width`/`along` describe the most ' +
      'specific carrier (narrowest containing corridor, then nearest racing line, then lowest ' +
      'route index). distanceToRouteNetwork is the planar distance to the nearest racing-line ' +
      'polyline of the whole route network; distanceToAssignedRacingLine is the planar distance to ' +
      'the assigned route only; distanceToCorridor is 0 inside the assigned quad. arc is the ' +
      'assigned route racing-line arc at the projected station.',
    tolerances: {
      corridorMetres: CORRIDOR_TOLERANCE_M,
      reportMetres: REPORT_TOLERANCES_M,
      note: 'corridorMetres is numerical slack on the engine quad test; the retail slots are ' +
        'genuinely inside the corridor, not snapped to it.'
    },
    sources: {
      [pakRelative]: {
        sha256: createHash('sha256').update(pakBuffer).digest('hex'),
        bytes: pakBuffer.length,
        entries: pakIndex.entries.size,
        codec: pakIndex.codec,
        fatType: pakIndex.fatType
      },
      [PLACEMENT_RELATIVE]: {
        sha256: createHash('sha256').update(placementsText).digest('hex'),
        bytes: placementsText.length
      }
    },
    maps
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const document = buildDocument();
  const text = stringify(document) + '\n';
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, text);
  if (!options.quiet) {
    for (const mapId of Object.keys(document.maps)) {
      const map = document.maps[mapId];
      console.log('pickup-routes: ' + mapId + ' ' + map.routes.length + ' routes, ' +
        map.pickups.length + ' pickups, ' + map.counts.onRoute + ' on-route / ' +
        map.counts.offRoute + ' off-route (corridor max ' + map.counts.corridorMaxMetres + ' m)');
    }
    console.log('wrote ' + path.relative(ROOT, options.out) + ' sha256 ' +
      createHash('sha256').update(text).digest('hex') + ' (' + text.length + ' bytes)');
  }
}

main();
