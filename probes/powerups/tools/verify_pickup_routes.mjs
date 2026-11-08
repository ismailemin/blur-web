#!/usr/bin/env node
// Independent verifier for probes/powerups/data/pickup-routes.json.
//
//   node probes/powerups/tools/verify_pickup_routes.mjs
//   node probes/powerups/tools/verify_pickup_routes.mjs --data <json> --quiet
//
// This file deliberately does not import the builder. It re-reads the retail
// pak, re-inflates the `.aid`, re-parses revision 6.0 and re-derives every
// racing-line polyline and every pickup projection from scratch. It then
// compares its own numbers with the committed artifact.
//
// Checks
//   1. pak entry identity: path, logical/stored bytes, sha256 of the `.aid`.
//   2. route identity: count, names, flags, segment count, byte offsets.
//   3. geometry: every point (x, y, z, arc), width and racing offset.
//   4. closure: ROUTE_LOOPED routes end where they start.
//   5. ordering: arcs strictly increasing, every 4 m step non-zero.
//   6. length: committed lengthMetres equals the recomputed chord sum.
//   7. projection: every committed retail pickup is re-projected; on-route
//      pickups must be inside the engine segment quad within the stated
//      tolerance, off-route pickups must be listed with their distance.
//
// Prints "<passed>/<total> checks passed" and exits 1 on any failure.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DEFAULT_DATA = path.join(ROOT, 'probes/powerups/data/pickup-routes.json');
const PACK_PATH = path.join(ROOT, 'game-data/Blur/cache/gamedata.pak');
const PLACEMENT_PATH = path.join(ROOT, 'probes/powerups/data/runtime-placement.json');

const RACING_LINE = 5;
const STEP_SIZE_M = 4.0;
const SCHEMA = 'blur-powerups-pickup-routes/1';

const XZ_TOLERANCE_M = 1e-3;
const ARC_TOLERANCE_M = 0.01;
const WIDTH_TOLERANCE_M = 1e-3;
const OFFSET_TOLERANCE = 1e-4;
const LENGTH_TOLERANCE_M = 0.01;
const CLOSURE_TOLERANCE_M = 1e-6;

let passed = 0;
let total = 0;
const failures = [];

function check(name, condition, detail) {
  total += 1;
  if (condition) {
    passed += 1;
    return true;
  }
  failures.push(name + (detail === undefined ? '' : ': ' + detail));
  return false;
}

function parseArgs(argv) {
  const options = { data: DEFAULT_DATA, quiet: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--data') options.data = path.resolve(argv[++index]);
    else if (arg === '--quiet') options.quiet = true;
    else throw new Error('unknown argument ' + JSON.stringify(arg));
  }
  return options;
}

// --------------------------------------------------------------- pak reader
// Independent implementation: DataView instead of Buffer read helpers, and the
// FAT row is decoded field by field at the documented offsets.
const XOR_KEY = 'xVXo40j3@$%\\%`';

function pakEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== '2KAP') throw new Error('gamedata.pak: bad magic ' + JSON.stringify(magic));
  const version = view.getUint32(4, true);
  const sector = view.getUint32(8, true);
  const headerSize = view.getUint32(12, true);
  const codec = view.getUint8(16);
  const fatType = view.getUint8(17);
  if (version !== 2 || headerSize !== 32) throw new Error('gamedata.pak: unsupported header');
  const stringBlock = view.getUint32(36, true);
  const fatBlock = view.getUint32(40, true);
  const metadataEnd = sector + stringBlock + fatBlock;

  const stringSize = view.getUint32(sector, true);
  const table = new Uint8Array(stringSize);
  for (let index = 0; index < stringSize; index++) {
    table[index] = bytes[sector + 4 + index] ^ XOR_KEY.charCodeAt((index + 1) % XOR_KEY.length);
  }
  const text = Buffer.from(table).toString('latin1');

  const count = view.getUint32(sector + stringBlock, true);
  const fatSize = view.getUint32(sector + stringBlock + 4, true);
  const stride = fatType === 1 ? 64 : fatType === 0 ? 40 : -1;
  if (stride < 0 || count * stride !== fatSize) throw new Error('gamedata.pak: bad FAT');

  const result = new Map();
  for (let index = 0; index < count; index++) {
    const row = sector + stringBlock + 8 + index * stride;
    const stringOffset = view.getUint32(row + 4, true);
    const logical = view.getUint32(row + 12, true);
    const startLow = view.getUint32(row + 24, true);
    const startHigh = view.getUint32(row + 28, true);
    const stored = view.getUint32(row + 36, true);
    const end = text.indexOf('\0', stringOffset);
    if (end < 0) throw new Error('gamedata.pak: unterminated path');
    const name = text.slice(stringOffset, end);
    if (startHigh === 0xffffffff && startLow === 0xffffffff) continue;
    const offset = startLow * sector;
    if (offset < metadataEnd || offset + stored > bytes.length) {
      throw new Error('gamedata.pak: payload out of bounds for ' + name);
    }
    result.set(name.toLowerCase(), { name, offset, stored, logical });
  }
  return { entries: result, codec };
}

function inflateEntry(bytes, index, name) {
  const entry = index.entries.get(name.toLowerCase());
  if (!entry) throw new Error('gamedata.pak: missing ' + name);
  if (index.codec !== 2) throw new Error('gamedata.pak: codec ' + index.codec + ' is not zlib');
  const out = inflateSync(bytes.subarray(entry.offset, entry.offset + entry.stored));
  if (out.length !== entry.logical) throw new Error(name + ': wrong inflated length');
  return out;
}

// --------------------------------------------------------------- aid reader
function aidRoutes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0;
  const take = (count) => {
    if (cursor + count > bytes.length) throw new Error('aid: read past end at ' + cursor);
    const at = cursor;
    cursor += count;
    return at;
  };
  const i32 = () => view.getInt32(take(4), true);
  const f32 = () => view.getFloat32(take(4), true);
  const i8 = () => view.getInt8(take(1));
  const str = () => {
    const length = i32();
    if (length < 0 || length > (1 << 20)) throw new Error('aid: bad string length');
    const at = take(length);
    return Buffer.from(bytes.subarray(at, at + length)).toString('latin1');
  };

  const version = f32();
  if (version !== 6) throw new Error('aid: revision ' + version + ' is not 6.0');
  const routeCount = i32();
  const routes = [];
  for (let r = 0; r < routeCount; r++) {
    const byteOffset = cursor;
    const name = str();
    str();
    str();
    const flags = i32();
    if (flags & 128) {
      const rule = i32();
      if (rule === 1) i32();
      else if (rule === 2 || rule === 3) { str(); i32(); if (rule === 3) f32(); }
      else if (rule === 4) { str(); i32(); f32(); i32(); f32(); }
      else if (rule === 5) { i32(); f32(); i32(); f32(); }
      else if (rule === 6 || rule === 7) { i32(); f32(); }
      else if (rule === 8) { i32(); f32(); f32(); f32(); }
      else if (rule === 9) { i32(); f32(); f32(); }
    }
    const segmentCount = i32();
    if (segmentCount < 0 || segmentCount > 200000) throw new Error('aid: bad segment count');
    const segments = [];
    for (let s = 0; s < segmentCount; s++) {
      const x = f32();
      const y = f32();
      const z = f32();
      const width = f32();
      const tangentX = f32();
      const tangentZ = f32();
      f32(); f32(); f32();
      f32(); f32();
      const lineCount = i32();
      if (lineCount < 0 || lineCount > 64) throw new Error('aid: bad line count');
      const heights = [];
      const offsets = [];
      for (let k = 0; k < lineCount; k++) {
        f32(); f32(); i32();
        heights.push(f32());
        offsets.push(f32());
        i8(); f32();
      }
      segments.push({ x, y, z, width, tangentX, tangentZ, heights, offsets });
    }
    routes.push({ index: r, byteOffset, name, flags, segmentCount, segments, endByteOffset: cursor });
  }
  const cacheSize = i32();
  for (let c = 0; c < cacheSize; c++) {
    const records = i32();
    for (let k = 0; k < records; k++) { i32(); str(); }
  }
  if (cursor !== bytes.length) throw new Error('aid: trailing bytes ' + cursor + '/' + bytes.length);
  return { version, routeCount, routes };
}

// --------------------------------------------------------------- geometry
function frame(segment) {
  const length = Math.hypot(segment.tangentX, segment.tangentZ);
  const nx = length > 0 ? segment.tangentX / length : 0;
  const nz = length > 0 ? -segment.tangentZ / length : 0;
  return { ox: segment.x, oz: -segment.z, nx, nz, fx: -nz, fz: nx };
}

function racingPolyline(route) {
  const points = [];
  let arc = 0;
  for (let index = 0; index < route.segments.length; index++) {
    const segment = route.segments[index];
    const f = frame(segment);
    const offset = segment.offsets[RACING_LINE];
    const x = f.ox + f.nx * segment.width * offset;
    const z = f.oz + f.nz * segment.width * offset;
    const y = segment.heights[RACING_LINE];
    if (index > 0) {
      const previous = points[index - 1];
      arc += Math.hypot(x - previous.x, z - previous.z);
    }
    points.push({ x, y, z, arc });
  }
  return points;
}

function nearest(points, x, z) {
  let best = { distance: Infinity, arc: 0 };
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const lengthSquared = vx * vx + vz * vz;
    let t = lengthSquared > 0 ? ((x - a.x) * vx + (z - a.z) * vz) / lengthSquared : 0;
    t = Math.max(0, Math.min(1, t));
    const distance = Math.hypot(x - (a.x + vx * t), z - (a.z + vz * t));
    if (distance < best.distance) best = { distance, arc: a.arc + (b.arc - a.arc) * t };
  }
  return best;
}

function corridor(route, x, z) {
  let best = null;
  for (let index = 0; index < route.segments.length; index++) {
    const segment = route.segments[index];
    const f = frame(segment);
    const dx = x - f.ox;
    const dz = z - f.oz;
    const along = dx * f.fx + dz * f.fz;
    const lateral = dx * f.nx + dz * f.nz;
    const lateralOut = lateral < 0 ? -lateral : lateral > segment.width ? lateral - segment.width : 0;
    const alongOut = along < -2 ? -2 - along : along > 2 ? along - 2 : 0;
    const distance = Math.hypot(lateralOut, alongOut);
    if (best === null || distance < best.distance) {
      best = { distance, segment: index, along, lateral, width: segment.width };
    }
  }
  return best;
}

function assign(routes, polylines, pickup, tolerance) {
  const candidates = routes.map((route) => ({
    route,
    projection: corridor(route, pickup.x, pickup.z),
    racing: nearest(polylines.get(route.index), pickup.x, pickup.z)
  }));
  const containing = candidates
    .filter((candidate) => candidate.projection.distance <= tolerance)
    .sort((a, b) => a.projection.distance - b.projection.distance
      || a.projection.width - b.projection.width
      || a.racing.distance - b.racing.distance
      || a.route.index - b.route.index);
  const primary = containing.length > 0
    ? containing[0]
    : candidates.slice().sort((a, b) => a.projection.distance - b.projection.distance
      || a.racing.distance - b.racing.distance
      || a.route.index - b.route.index)[0];
  return { primary, containing, candidates };
}

// --------------------------------------------------------------- main
function main() {
  const options = parseArgs(process.argv.slice(2));
  const document = JSON.parse(readFileSync(options.data, 'utf8'));
  const placements = JSON.parse(readFileSync(PLACEMENT_PATH, 'utf8'));
  const pakBytes = readFileSync(PACK_PATH);
  const pak = pakEntries(pakBytes);

  check('schema', document.schema === SCHEMA, document.schema);
  check('kind', document.kind === 'powerups.pickup-routes', document.kind);
  check('version', document.version === 1, document.version);
  check('tolerances.corridorMetres', typeof document.tolerances?.corridorMetres === 'number',
    'missing corridorMetres');
  check('tolerances.reportMetres', Array.isArray(document.tolerances?.reportMetres)
    && document.tolerances.reportMetres.length === 3, 'missing reportMetres');
  const corridorTolerance = document.tolerances?.corridorMetres ?? 0.5;

  for (const [mapId, map] of Object.entries(document.maps)) {
    const label = '[' + mapId + '] ';
    const aidBytes = inflateEntry(pakBytes, pak, map.aid.pakPath);
    const aidSha = createHash('sha256').update(aidBytes).digest('hex');
    check(label + 'aid.sha256', aidSha === map.aid.sha256, aidSha + ' != ' + map.aid.sha256);
    check(label + 'aid.logicalBytes', aidBytes.length === map.aid.logicalBytes,
      aidBytes.length + ' != ' + map.aid.logicalBytes);
    check(label + 'aid.stepSizeM', map.stepSizeM === STEP_SIZE_M, map.stepSizeM);
    check(label + 'aid.racingLineIndex', map.racingLineIndex === RACING_LINE, map.racingLineIndex);

    const placementMap = placements.maps[mapId];
    check(label + 'routeRecordId', placementMap?.routeRecordId === map.routeRecordId,
      placementMap?.routeRecordId + ' != ' + map.routeRecordId);
    check(label + 'actorListId', (placementMap?.actorListId ?? null) === map.actorListId,
      placementMap?.actorListId + ' != ' + map.actorListId);
    check(label + 'aid filename matches routeNumber',
      map.aid.pakPath.toLowerCase().endsWith('_' + map.routeNumber + '.aid'), map.aid.pakPath);

    const aid = aidRoutes(aidBytes);
    check(label + 'aid.revision', aid.version === 6, aid.version);
    check(label + 'routeCount', aid.routeCount === map.aid.routeCount,
      aid.routeCount + ' != ' + map.aid.routeCount);
    check(label + 'routes.length', aid.routes.length === map.routes.length,
      aid.routes.length + ' != ' + map.routes.length);

    const polylines = new Map();
    for (const route of aid.routes) polylines.set(route.index, racingPolyline(route));

    for (const committed of map.routes) {
      const route = aid.routes[committed.index];
      const tag = label + committed.name + ' ';
      if (!check(tag + 'exists', route !== undefined)) continue;
      check(tag + 'name', route.name === committed.name, route.name + ' != ' + committed.name);
      check(tag + 'flags', route.flags === committed.flags, route.flags + ' != ' + committed.flags);
      check(tag + 'segmentCount', route.segmentCount === committed.segmentCount,
        route.segmentCount + ' != ' + committed.segmentCount);
      check(tag + 'byteOffset', route.byteOffset === committed.byteOffset,
        route.byteOffset + ' != ' + committed.byteOffset);
      check(tag + 'endByteOffset', route.endByteOffset === committed.endByteOffset,
        route.endByteOffset + ' != ' + committed.endByteOffset);
      check(tag + 'points.length', committed.points.length === route.segmentCount,
        committed.points.length + ' != ' + route.segmentCount);
      check(tag + 'widths.length', committed.widths.length === route.segmentCount,
        committed.widths.length + ' != ' + route.segmentCount);
      check(tag + 'racingOffsets.length', committed.racingOffsets.length === route.segmentCount,
        committed.racingOffsets.length + ' != ' + route.segmentCount);

      const points = polylines.get(route.index);
      let geometryOk = true;
      let widthOk = true;
      let offsetOk = true;
      let orderingOk = true;
      let worstPoint = 0;
      for (let index = 0; index < points.length; index++) {
        const point = points[index];
        const row = committed.points[index];
        if (!row) { geometryOk = false; break; }
        const dx = Math.abs(point.x - row[0]);
        const dy = Math.abs(point.y - row[1]);
        const dz = Math.abs(point.z - row[2]);
        const da = Math.abs(point.arc - row[3]);
        worstPoint = Math.max(worstPoint, dx, dy, dz);
        if (dx > XZ_TOLERANCE_M || dy > XZ_TOLERANCE_M || dz > XZ_TOLERANCE_M || da > ARC_TOLERANCE_M) {
          geometryOk = false;
        }
        if (Math.abs(route.segments[index].width - committed.widths[index]) > WIDTH_TOLERANCE_M) {
          widthOk = false;
        }
        if (Math.abs(route.segments[index].offsets[RACING_LINE] - committed.racingOffsets[index]) > OFFSET_TOLERANCE) {
          offsetOk = false;
        }
        if (index > 0 && !(point.arc > points[index - 1].arc)) orderingOk = false;
      }
      check(tag + 'points match aid', geometryOk, 'worst ' + worstPoint.toFixed(6) + ' m');
      check(tag + 'widths match aid', widthOk);
      check(tag + 'racingOffsets match aid', offsetOk);
      check(tag + 'arc strictly increasing', orderingOk);

      const closed = (route.flags & 1) === 1;
      check(tag + 'closed flag', committed.closed === closed, committed.closed + ' != ' + closed);
      if (closed) {
        const first = points[0];
        const last = points[points.length - 1];
        const closure = Math.hypot(first.x - last.x, first.z - last.z);
        check(tag + 'closure', closure <= CLOSURE_TOLERANCE_M, closure + ' m');
        check(tag + 'closureMetres', Math.abs((committed.closureMetres ?? Infinity) - closure) <= CLOSURE_TOLERANCE_M,
          committed.closureMetres + ' != ' + closure);
      } else {
        check(tag + 'closureMetres null', committed.closureMetres === null, committed.closureMetres);
      }

      let length = 0;
      for (let index = 1; index < points.length; index++) {
        length += Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z);
      }
      check(tag + 'lengthMetres', Math.abs(length - committed.lengthMetres) <= LENGTH_TOLERANCE_M,
        length + ' != ' + committed.lengthMetres);
      check(tag + 'routeLengthM', Math.abs(committed.routeLengthM - route.segmentCount * STEP_SIZE_M) <= 1e-6,
        committed.routeLengthM + ' != ' + route.segmentCount * STEP_SIZE_M);
      check(tag + 'stepMinMetres', Math.abs(committed.stepMinMetres - Math.min(...steps(points))) <= LENGTH_TOLERANCE_M,
        committed.stepMinMetres);
      check(tag + 'stepMaxMetres', Math.abs(committed.stepMaxMetres - Math.max(...steps(points))) <= LENGTH_TOLERANCE_M,
        committed.stepMaxMetres);
    }

    // Pickups: the committed set must be exactly the runtime-placement set.
    const placementUids = placementMap.pickups.map((pickup) => pickup.uid).sort((a, b) => a - b);
    const routeUids = map.pickups.map((pickup) => pickup.uid).sort((a, b) => a - b);
    check(label + 'pickup uid set', JSON.stringify(placementUids) === JSON.stringify(routeUids),
      placementUids.length + ' vs ' + routeUids.length);

    const byUid = new Map(placementMap.pickups.map((pickup) => [pickup.uid, pickup]));
    let projectionOk = true;
    let assignmentOk = true;
    let worstCorridor = 0;
    let onRoute = 0;
    const offRoute = [];
    for (const committed of map.pickups) {
      const pickup = byUid.get(committed.uid);
      if (!pickup) { projectionOk = false; continue; }
      const dx = Math.abs(pickup.x - committed.position[0]);
      const dy = Math.abs(pickup.y - committed.position[1]);
      const dz = Math.abs(pickup.z - committed.position[2]);
      if (dx > XZ_TOLERANCE_M || dy > XZ_TOLERANCE_M || dz > XZ_TOLERANCE_M) projectionOk = false;
      const best = assign(aid.routes, polylines, pickup, corridorTolerance);
      const distance = best.primary.projection.distance;
      worstCorridor = Math.max(worstCorridor, distance);
      const routed = distance <= corridorTolerance;
      if (routed) onRoute += 1;
      else offRoute.push({ uid: committed.uid, distance });
      if (routed !== committed.onRoute) assignmentOk = false;
      if (Math.abs(distance - committed.distanceToCorridor) > 1e-3) assignmentOk = false;
      if (best.primary.route.name !== committed.route) assignmentOk = false;
      if (best.primary.projection.segment !== committed.segment) assignmentOk = false;
      if (Math.abs(best.primary.racing.distance - committed.distanceToAssignedRacingLine) > 1e-3) assignmentOk = false;
      const containing = best.containing.map((candidate) => candidate.route.name);
      if (JSON.stringify(containing) !== JSON.stringify((committed.containingRoutes ?? []).map((row) => row.name))) {
        assignmentOk = false;
      }
      let network = Infinity;
      for (const route of aid.routes) {
        network = Math.min(network, nearest(polylines.get(route.index), pickup.x, pickup.z).distance);
      }
      if (Math.abs(network - committed.distanceToRouteNetwork) > 1e-3) assignmentOk = false;
    }
    check(label + 'pickup positions match runtime-placement', projectionOk);
    check(label + 'pickup projection matches aid', assignmentOk);
    check(label + 'onRoute count', onRoute === map.counts.onRoute, onRoute + ' != ' + map.counts.onRoute);
    check(label + 'offRoute count', offRoute.length === map.counts.offRoute,
      offRoute.length + ' != ' + map.counts.offRoute);
    check(label + 'offRoute list', JSON.stringify(offRoute.map((row) => row.uid).sort((a, b) => a - b))
      === JSON.stringify(map.offRoute.map((row) => row.uid).sort((a, b) => a - b)));
    check(label + 'corridor max', Math.abs(worstCorridor - map.counts.corridorMaxMetres) <= 1e-3,
      worstCorridor + ' != ' + map.counts.corridorMaxMetres);
    for (const tolerance of document.tolerances.reportMetres) {
      const expected = map.pickups.filter((row) => row.distanceToRouteNetwork <= tolerance).length;
      check(label + 'within' + tolerance + 'mOfRouteNetwork',
        expected === map.counts['within' + tolerance + 'mOfRouteNetwork'],
        expected + ' != ' + map.counts['within' + tolerance + 'mOfRouteNetwork']);
    }
  }

  if (!options.quiet) {
    for (const failure of failures) console.error('FAIL ' + failure);
    for (const [mapId, map] of Object.entries(document.maps)) {
      const counts = map.counts;
      console.log(mapId + ': ' + counts.onRoute + '/' + counts.retailPlacements + ' on-route, ' +
        counts.offRoute + ' off-route; route network <=2/5/10 m: ' +
        [2, 5, 10].map((t) => counts['within' + t + 'mOfRouteNetwork']).join('/') +
        '; corridor max ' + counts.corridorMaxMetres + ' m');
    }
  }
  console.log(passed + '/' + total + ' checks passed');
  if (passed !== total) process.exit(1);
}

function steps(points) {
  const out = [];
  for (let index = 1; index < points.length; index++) {
    out.push(Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z));
  }
  return out;
}

main();
