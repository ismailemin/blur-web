#!/usr/bin/env node
// Independent verifier for the true world-position retail pickup placement.
//
//   node probes/powerups-aid/tools/verify_physical_placement.mjs
//   node probes/powerups-aid/tools/verify_physical_placement.mjs --quiet
//
// This file deliberately does not import the builder. It re-reads the committed
// pickup-route document, the measured layout files, the committed placement
// source and the generated module, re-implements the .aid world-position
// reconstruction and the measured-band test, and compares its own numbers with
// the committed documents.
//
// Checks
//   1. schemas, source pins, module exports and embedded data identity.
//   2. layout identity: path, sha256, bytes, length, sample count, band.
//   3. retail world reconstruction: every pickup is re-derived from the
//      committed .aid route, arc and lateral; the normal sign and the residual to
//      the committed retail position are checked.
//   4. band test: every placeable pickup is inside the measured band; every
//      off-course pickup is outside it with the exact centreline distance,
//      distance beyond the band and nearest measured arc.
//   5. counts: per map against pickup-routes.json; every retail uid appears
//      exactly once in rows and once in placeable or offCourse.
//   6. module output matches the committed lists and re-derives the same values.
//   7. determinism: two builder runs are byte-identical and match the committed
//      JSON and module.
//
// Prints "<passed>/<total> checks passed" and exits 1 on any failure.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const ROUTES_PATH = path.join(ROOT, 'probes/powerups/data/pickup-routes.json');
const DATA_PATH = path.join(ROOT, 'probes/powerups-aid/data/physical-placement.json');
const MODULE_PATH = path.join(ROOT, 'probes/powerups-aid/physical-placement.mjs');
const BUILDER = path.join(HERE, 'build_physical_placement.mjs');

const SOURCE_SCHEMA = 'blur.powerups-aid-physical-placement-source/1';
const RUNTIME_SCHEMA = 'blur.powerups-aid-physical-placement/1';
const ROUTES_SCHEMA = 'blur-powerups-pickup-routes/1';
const RULE = 'retail-world-position-band-test';
const EPS = 1e-6;

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

const close = (a, b, tolerance) =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;

const round6 = (value) => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseArgs(argv) {
  const options = { quiet: false };
  for (const arg of argv) {
    if (arg === '--quiet') options.quiet = true;
    else throw new Error('unknown argument ' + JSON.stringify(arg));
  }
  return options;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bandOf(layout) {
  const band = layout?.course?.band?.halfWidthMetres;
  if (Number.isFinite(band) && band > 0) {
    return { halfWidthMetres: band, source: 'course.band.halfWidthMetres' };
  }
  const corridor = layout?.course?.corridor?.halfWidthMetres;
  if (Number.isFinite(corridor) && corridor > 0) {
    return { halfWidthMetres: corridor, source: 'course.corridor.halfWidthMetres' };
  }
  return null;
}

function measuredLengthOf(layout) {
  const length = layout?.course?.lengthMetres;
  if (Number.isFinite(length) && length > 0) return length;
  const samples = layout?.course?.samples;
  if (Array.isArray(samples) && samples.length > 0) {
    const last = samples[samples.length - 1];
    if (Number.isFinite(last?.arc) && last.arc > 0) return last.arc;
  }
  return null;
}

// ------------------------------------------------- independent retail .aid line
function interpolatePoint(points, arc) {
  const first = points[0];
  if (arc <= first[3]) return { x: first[0], y: first[1], z: first[2], index: 0 };
  const lastIndex = points.length - 1;
  const last = points[lastIndex];
  if (arc >= last[3]) return { x: last[0], y: last[1], z: last[2], index: lastIndex };
  let low = 0;
  let high = lastIndex;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (points[mid][3] <= arc) low = mid;
    else high = mid;
  }
  const a = points[low];
  const b = points[high];
  const span = b[3] - a[3];
  const t = span > 0 ? (arc - a[3]) / span : 0;
  return {
    x: a[0] + (b[0] - a[0]) * t,
    y: a[1] + (b[1] - a[1]) * t,
    z: a[2] + (b[2] - a[2]) * t,
    index: low
  };
}

function lineNormal(points, index) {
  const a = points[Math.max(0, index - 1)];
  const b = points[Math.min(points.length - 1, index + 1)];
  const tx = b[0] - a[0];
  const tz = b[2] - a[2];
  const length = Math.hypot(tx, tz);
  if (!(length > 0)) return { x: 0, z: 0 };
  return { x: tz / length, z: -tx / length };
}

function rebuildRetailWorld(pickup, route) {
  const point = interpolatePoint(route.points, pickup.arc);
  const normal = lineNormal(route.points, point.index);
  const racingOffset = route.racingOffsets[pickup.segment] ?? 0;
  const lateralOffset = pickup.lateral - pickup.width * racingOffset;
  const plusX = point.x + normal.x * lateralOffset;
  const plusZ = point.z + normal.z * lateralOffset;
  const minusX = point.x - normal.x * lateralOffset;
  const minusZ = point.z - normal.z * lateralOffset;
  const plusError = Math.hypot(pickup.position[0] - plusX, pickup.position[2] - plusZ);
  const minusError = Math.hypot(pickup.position[0] - minusX, pickup.position[2] - minusZ);
  const plusWins = plusError <= minusError;
  return {
    x: plusWins ? plusX : minusX,
    z: plusWins ? plusZ : minusZ,
    normalSign: plusWins ? 1 : -1,
    aidResidualM: plusWins ? plusError : minusError,
    racingOffset,
    lateralOffset
  };
}

// ------------------------------------------------- independent measured query
function projectOnMeasured(samples, x, z) {
  let best = { distance: Infinity, arc: 0, index: 0 };
  for (let index = 0; index < samples.length - 1; index++) {
    const a = samples[index];
    const b = samples[index + 1];
    const ax = a.x ?? 0;
    const az = a.z ?? 0;
    const vx = (b.x ?? 0) - ax;
    const vz = (b.z ?? 0) - az;
    const lengthSquared = vx * vx + vz * vz;
    let t = lengthSquared > 0 ? ((x - ax) * vx + (z - az) * vz) / lengthSquared : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + vx * t;
    const pz = az + vz * t;
    const distance = Math.hypot(x - px, z - pz);
    if (distance < best.distance) {
      const arcStart = a.arc ?? 0;
      const arcEnd = b.arc ?? arcStart;
      best = { distance, arc: arcStart + (arcEnd - arcStart) * t, index };
    }
  }
  return best;
}

function nearestSampleIndex(samples, arc) {
  let bestIndex = 0;
  let bestDelta = Math.abs((samples[0].arc ?? 0) - arc);
  for (let index = 1; index < samples.length; index++) {
    const delta = Math.abs((samples[index].arc ?? 0) - arc);
    if (delta < bestDelta) {
      bestIndex = index;
      bestDelta = delta;
    }
  }
  return bestIndex;
}

function groundAt(samples, index) {
  const sample = samples[index];
  return sample.groundY ?? sample.height ?? 0;
}

// --------------------------------------------------------------- builder runs
function runBuilder(args) {
  execFileSync(process.execPath, [BUILDER, ...args, '--quiet'], {
    cwd: ROOT,
    stdio: 'pipe'
  });
}

// ------------------------------------------------------------------- main
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const routesBytes = readFileSync(ROUTES_PATH);
  const routes = JSON.parse(routesBytes.toString('utf8'));
  const dataBytes = readFileSync(DATA_PATH);
  const data = JSON.parse(dataBytes.toString('utf8'));
  const module = await import(pathToFileURL(MODULE_PATH).href);

  // ------------------------------------------------------------- schemas
  check('routes schema', routes.schema === ROUTES_SCHEMA, routes.schema);
  check('data schema', data.schema === SOURCE_SCHEMA, data.schema);
  check('data kind', data.kind === 'powerups.aid-physical-placement-source', data.kind);
  check('data version', data.version === 1, data.version);
  check('data runtimeSchema', data.runtimeSchema === RUNTIME_SCHEMA, data.runtimeSchema);
  check('data generatedBy names builder',
    data.generatedBy === 'probes/powerups-aid/tools/build_physical_placement.mjs',
    data.generatedBy);
  check('module PHYSICAL_PLACEMENT_SCHEMA',
    module.PHYSICAL_PLACEMENT_SCHEMA === RUNTIME_SCHEMA, module.PHYSICAL_PLACEMENT_SCHEMA);
  check('module PHYSICAL_PLACEMENT_DATA_SCHEMA',
    module.PHYSICAL_PLACEMENT_DATA_SCHEMA === SOURCE_SCHEMA,
    module.PHYSICAL_PLACEMENT_DATA_SCHEMA);
  check('module physicalPlacementsFor export',
    typeof module.physicalPlacementsFor === 'function');
  check('module PHYSICAL_PLACEMENT_DATA matches committed source',
    JSON.stringify(module.PHYSICAL_PLACEMENT_DATA) === JSON.stringify(data));

  check('source pin pickup-routes sha256',
    data.sources?.['probes/powerups/data/pickup-routes.json']?.sha256 === sha256(routesBytes),
    data.sources?.['probes/powerups/data/pickup-routes.json']?.sha256);
  check('source pin pickup-routes bytes',
    data.sources?.['probes/powerups/data/pickup-routes.json']?.bytes === routesBytes.length,
    data.sources?.['probes/powerups/data/pickup-routes.json']?.bytes);

  for (const [mapId, map] of Object.entries(data.maps)) {
    const label = '[' + mapId + '] ';
    const routesMap = routes.maps[mapId];
    check(label + 'routes map exists', routesMap !== undefined);
    if (!routesMap) continue;

    // ------------------------------------------------ measured layout identity
    const layoutBytes = readFileSync(path.join(ROOT, map.measuredLayout.path));
    const layout = JSON.parse(layoutBytes.toString('utf8'));
    const samples = layout.course.samples;
    const band = bandOf(layout);
    const measuredLength = measuredLengthOf(layout);

    check(label + 'layout sha256', sha256(layoutBytes) === map.measuredLayout.sha256,
      sha256(layoutBytes) + ' != ' + map.measuredLayout.sha256);
    check(label + 'layout bytes', layoutBytes.length === map.measuredLayout.bytes,
      layoutBytes.length + ' != ' + map.measuredLayout.bytes);
    check(label + 'layout source pin',
      data.sources?.[map.measuredLayout.path]?.sha256 === map.measuredLayout.sha256 &&
      data.sources?.[map.measuredLayout.path]?.bytes === map.measuredLayout.bytes,
      JSON.stringify(data.sources?.[map.measuredLayout.path]));
    check(label + 'layout length', close(measuredLength, map.measuredLayout.lengthMetres, EPS),
      measuredLength + ' != ' + map.measuredLayout.lengthMetres);
    check(label + 'layout sampleCount', samples.length === map.measuredLayout.sampleCount,
      samples.length + ' != ' + map.measuredLayout.sampleCount);
    check(label + 'layout band', band !== null &&
      close(band.halfWidthMetres, map.measuredLayout.bandHalfWidthMetres, 1e-9),
      band?.halfWidthMetres + ' != ' + map.measuredLayout.bandHalfWidthMetres);
    check(label + 'layout band source', band !== null &&
      band.source === map.measuredLayout.bandSource,
      band?.source + ' != ' + map.measuredLayout.bandSource);
    check(label + 'layout first sample',
      close(samples[0].x ?? 0, map.measuredLayout.firstSample.x, EPS) &&
      close(samples[0].z ?? 0, map.measuredLayout.firstSample.z, EPS),
      JSON.stringify(map.measuredLayout.firstSample));
    check(label + 'layout last sample',
      close(samples[samples.length - 1].x ?? 0, map.measuredLayout.lastSample.x, EPS) &&
      close(samples[samples.length - 1].z ?? 0, map.measuredLayout.lastSample.z, EPS),
      JSON.stringify(map.measuredLayout.lastSample));

    // ------------------------------------------------ retail world rebuild
    const routeByUid = new Map(routesMap.pickups.map((pickup) => [pickup.uid, pickup]));
    const rowByUid = new Map(map.rows.map((row) => [row.uid, row]));
    const placeableByUid = new Map(map.placeable.map((entry) => [entry.uid, entry]));
    const offCourseByUid = new Map(map.offCourse.map((entry) => [entry.uid, entry]));
    const unsupportedByUid = new Map(map.unsupported.map((entry) => [entry.uid, entry]));

    check(label + 'pickup count matches pickup-routes',
      map.rows.length === routesMap.pickups.length,
      map.rows.length + ' != ' + routesMap.pickups.length);
    check(label + 'counts.retailPlacements',
      map.counts.retailPlacements === routesMap.pickups.length,
      map.counts.retailPlacements + ' != ' + routesMap.pickups.length);
    check(label + 'counts.rows', map.counts.rows === map.rows.length,
      map.counts.rows + ' != ' + map.rows.length);
    check(label + 'counts.placeable', map.counts.placeable === map.placeable.length,
      map.counts.placeable + ' != ' + map.placeable.length);
    check(label + 'counts.offCourse', map.counts.offCourse === map.offCourse.length,
      map.counts.offCourse + ' != ' + map.offCourse.length);
    check(label + 'counts.unsupported', map.counts.unsupported === map.unsupported.length,
      map.counts.unsupported + ' != ' + map.unsupported.length);
    check(label + 'placeable + offCourse + unsupported = retailPlacements',
      map.counts.placeable + map.counts.offCourse + map.counts.unsupported ===
        map.counts.retailPlacements,
      map.counts.placeable + ' + ' + map.counts.offCourse + ' + ' +
        map.counts.unsupported);

    const rowUidSet = new Set();
    for (const row of map.rows) {
      check(label + 'row uid unique ' + row.uid, !rowUidSet.has(row.uid));
      rowUidSet.add(row.uid);
    }
    check(label + 'every retail uid present exactly once in rows',
      rowUidSet.size === routeByUid.size &&
      [...routeByUid.keys()].every((uid) => rowUidSet.has(uid)),
      rowUidSet.size + ' vs ' + routeByUid.size);
    check(label + 'every row classified once',
      map.rows.every((row) =>
        (placeableByUid.has(row.uid) ? 1 : 0) +
        (offCourseByUid.has(row.uid) ? 1 : 0) +
        (unsupportedByUid.has(row.uid) ? 1 : 0) === 1),
      'classification is not exactly one per row');

    const aidResiduals = [];
    const placeableDistances = [];
    const offCourseDistances = [];
    const offCourseExcesses = [];

    for (const row of map.rows) {
      const tag = label + 'uid ' + row.uid + ' ';
      const pickup = routeByUid.get(row.uid);
      const route = pickup
        ? routesMap.routes.find((candidate) => candidate.index === pickup.routeIndex)
        : null;
      check(tag + 'retail pickup exists', pickup !== undefined);
      check(tag + 'retail route exists', route !== undefined, pickup?.routeIndex);
      if (!pickup || !route) continue;

      check(tag + 'row type', row.type === pickup.type, row.type + ' != ' + pickup.type);
      check(tag + 'row route', row.route === pickup.route, row.route + ' != ' + pickup.route);
      check(tag + 'row routeIndex', row.routeIndex === pickup.routeIndex);
      check(tag + 'row segment', row.segment === pickup.segment);
      check(tag + 'row retailArc', close(row.retailArc, pickup.arc, EPS),
        row.retailArc + ' != ' + pickup.arc);
      check(tag + 'row lateral', close(row.lateral, pickup.lateral, EPS));
      check(tag + 'row width', close(row.width, pickup.width, EPS));
      check(tag + 'row retailPosition',
        close(row.retailPosition[0], pickup.position[0], EPS) &&
        close(row.retailPosition[1], pickup.position[1], EPS) &&
        close(row.retailPosition[2], pickup.position[2], EPS),
        JSON.stringify(row.retailPosition) + ' != ' + JSON.stringify(pickup.position));

      const rebuilt = rebuildRetailWorld(pickup, route);
      const worldX = round6(rebuilt.x);
      const worldZ = round6(rebuilt.z);
      const aidResidual = round6(rebuilt.aidResidualM);
      check(tag + 'retailWorldX', close(row.retailWorldX, worldX, EPS),
        row.retailWorldX + ' != ' + worldX);
      check(tag + 'retailWorldZ', close(row.retailWorldZ, worldZ, EPS),
        row.retailWorldZ + ' != ' + worldZ);
      check(tag + 'normalSign', row.normalSign === rebuilt.normalSign,
        row.normalSign + ' != ' + rebuilt.normalSign);
      check(tag + 'aidResidualM', close(row.aidResidualM, aidResidual, EPS),
        row.aidResidualM + ' != ' + aidResidual);
      check(tag + 'racingOffset', close(row.racingOffset, rebuilt.racingOffset, EPS));
      check(tag + 'lateralOffset', close(row.lateralOffset, rebuilt.lateralOffset, EPS));
      aidResiduals.push(rebuilt.aidResidualM);

      const projection = projectOnMeasured(samples, worldX, worldZ);
      const inside = projection.distance <= band.halfWidthMetres + 1e-9;
      const sampleIndex = nearestSampleIndex(samples, projection.arc);
      const placeable = placeableByUid.get(row.uid);
      const offCourse = offCourseByUid.get(row.uid);

      if (inside) {
        placeableDistances.push(projection.distance);
        check(tag + 'inside band is placeable', placeable !== undefined);
        check(tag + 'inside band is not off-course', offCourse === undefined);
        if (!placeable) continue;
        check(tag + 'placeable x', close(placeable.x, worldX, EPS),
          placeable.x + ' != ' + worldX);
        check(tag + 'placeable z', close(placeable.z, worldZ, EPS),
          placeable.z + ' != ' + worldZ);
        check(tag + 'placeable y is nearest sample groundY',
          close(placeable.y, groundAt(samples, sampleIndex), EPS),
          placeable.y + ' != ' + groundAt(samples, sampleIndex));
        check(tag + 'placeable measured arc',
          close(placeable.arc, projection.arc, EPS),
          placeable.arc + ' != ' + projection.arc);
        check(tag + 'placeable measuredArc equals arc',
          close(placeable.measuredArc, placeable.arc, EPS));
        check(tag + 'placeable retailArc', close(placeable.retailArc, pickup.arc, EPS));
        check(tag + 'placeable lateral', close(placeable.lateral, pickup.lateral, EPS));
        check(tag + 'placeable residualM',
          close(placeable.residualM, projection.distance, EPS),
          placeable.residualM + ' != ' + projection.distance);
        check(tag + 'placeable residual inside band',
          placeable.residualM <= band.halfWidthMetres + EPS,
          placeable.residualM + ' > ' + band.halfWidthMetres);
        check(tag + 'placeable sampleIndex', placeable.sampleIndex === sampleIndex,
          placeable.sampleIndex + ' != ' + sampleIndex);
        check(tag + 'placeable physicalProjection', placeable.physicalProjection === true);
        check(tag + 'placeable source names uid',
          typeof placeable.source === 'string' && placeable.source.includes('uid ' + row.uid));
        check(tag + 'placeable source names route',
          typeof placeable.source === 'string' && placeable.source.includes('route ' + row.route));
        check(tag + 'placeable source names rule',
          typeof placeable.source === 'string' && placeable.source.includes(RULE));
        check(tag + 'placeable source names physicalProjection',
          typeof placeable.source === 'string' &&
          placeable.source.includes('physicalProjection true'));
      } else {
        offCourseDistances.push(projection.distance);
        offCourseExcesses.push(projection.distance - band.halfWidthMetres);
        check(tag + 'outside band is off-course', offCourse !== undefined);
        check(tag + 'outside band is not placeable', placeable === undefined);
        if (!offCourse) continue;
        check(tag + 'off-course x', close(offCourse.x, worldX, EPS),
          offCourse.x + ' != ' + worldX);
        check(tag + 'off-course z', close(offCourse.z, worldZ, EPS),
          offCourse.z + ' != ' + worldZ);
        check(tag + 'off-course distanceToCourseM',
          close(offCourse.distanceToCourseM, projection.distance, EPS),
          offCourse.distanceToCourseM + ' != ' + projection.distance);
        check(tag + 'off-course distanceToBandM',
          close(offCourse.distanceToBandM, projection.distance - band.halfWidthMetres, EPS),
          offCourse.distanceToBandM + ' != ' + (projection.distance - band.halfWidthMetres));
        check(tag + 'off-course distance is outside the band',
          offCourse.distanceToBandM > 0, offCourse.distanceToBandM);
        check(tag + 'off-course nearestMeasuredArc',
          close(offCourse.nearestMeasuredArc, projection.arc, EPS),
          offCourse.nearestMeasuredArc + ' != ' + projection.arc);
        check(tag + 'off-course retailArc', close(offCourse.retailArc, pickup.arc, EPS));
        check(tag + 'off-course reason names off-course',
          typeof offCourse.reason === 'string' && offCourse.reason.startsWith('off-course:'),
          offCourse.reason);
        check(tag + 'off-course reason names distance',
          typeof offCourse.reason === 'string' &&
          offCourse.reason.includes(projection.distance.toFixed(6)),
          offCourse.reason);
      }
    }

    // ------------------------------------------------ residual statistics
    check(label + 'counts.aidResidualMedianM',
      close(map.counts.aidResidualMedianM, round6(median(aidResiduals)), EPS),
      map.counts.aidResidualMedianM + ' vs ' + round6(median(aidResiduals)));
    check(label + 'counts.aidResidualMaxM',
      close(map.counts.aidResidualMaxM, round6(Math.max(...aidResiduals)), EPS),
      map.counts.aidResidualMaxM + ' vs ' + round6(Math.max(...aidResiduals)));
    check(label + 'counts.placeableDistanceMedianM',
      placeableDistances.length === 0
        ? map.counts.placeableDistanceMedianM === null
        : close(map.counts.placeableDistanceMedianM, round6(median(placeableDistances)), EPS),
      map.counts.placeableDistanceMedianM + ' vs ' +
        (placeableDistances.length === 0 ? null : round6(median(placeableDistances))));
    check(label + 'counts.placeableDistanceMaxM',
      placeableDistances.length === 0
        ? map.counts.placeableDistanceMaxM === null
        : close(map.counts.placeableDistanceMaxM, round6(Math.max(...placeableDistances)), EPS),
      map.counts.placeableDistanceMaxM + ' vs ' +
        (placeableDistances.length === 0 ? null : round6(Math.max(...placeableDistances))));
    check(label + 'counts.offCourseDistanceMinM',
      offCourseDistances.length === 0
        ? map.counts.offCourseDistanceMinM === null
        : close(map.counts.offCourseDistanceMinM, round6(Math.min(...offCourseDistances)), EPS),
      map.counts.offCourseDistanceMinM + ' vs ' +
        (offCourseDistances.length === 0 ? null : round6(Math.min(...offCourseDistances))));
    check(label + 'counts.offCourseDistanceMedianM',
      offCourseDistances.length === 0
        ? map.counts.offCourseDistanceMedianM === null
        : close(map.counts.offCourseDistanceMedianM, round6(median(offCourseDistances)), EPS),
      map.counts.offCourseDistanceMedianM + ' vs ' +
        (offCourseDistances.length === 0 ? null : round6(median(offCourseDistances))));
    check(label + 'counts.offCourseDistanceMaxM',
      offCourseDistances.length === 0
        ? map.counts.offCourseDistanceMaxM === null
        : close(map.counts.offCourseDistanceMaxM, round6(Math.max(...offCourseDistances)), EPS),
      map.counts.offCourseDistanceMaxM + ' vs ' +
        (offCourseDistances.length === 0 ? null : round6(Math.max(...offCourseDistances))));
    check(label + 'counts.offCourseExcessMinM',
      offCourseExcesses.length === 0
        ? map.counts.offCourseExcessMinM === null
        : close(map.counts.offCourseExcessMinM, round6(Math.min(...offCourseExcesses)), EPS),
      map.counts.offCourseExcessMinM + ' vs ' +
        (offCourseExcesses.length === 0 ? null : round6(Math.min(...offCourseExcesses))));
    check(label + 'counts.offCourseExcessMaxM',
      offCourseExcesses.length === 0
        ? map.counts.offCourseExcessMaxM === null
        : close(map.counts.offCourseExcessMaxM, round6(Math.max(...offCourseExcesses)), EPS),
      map.counts.offCourseExcessMaxM + ' vs ' +
        (offCourseExcesses.length === 0 ? null : round6(Math.max(...offCourseExcesses))));

    // ------------------------------------------------ module output
    const moduleOutput = module.physicalPlacementsFor(mapId, layout);
    check(label + 'module output schema', moduleOutput.schema === RUNTIME_SCHEMA,
      moduleOutput.schema);
    check(label + 'module output mapId', moduleOutput.mapId === mapId, moduleOutput.mapId);
    check(label + 'module output physicalProjection',
      moduleOutput.physicalProjection === true, moduleOutput.physicalProjection);
    check(label + 'module output source names map',
      typeof moduleOutput.source === 'string' && moduleOutput.source.includes(mapId));
    check(label + 'module output source names rule',
      typeof moduleOutput.source === 'string' && moduleOutput.source.includes(RULE));
    check(label + 'module output placeable count',
      moduleOutput.pickups.length === map.placeable.length,
      moduleOutput.pickups.length + ' != ' + map.placeable.length);
    check(label + 'module output offCourse count',
      moduleOutput.offCourse.length === map.offCourse.length,
      moduleOutput.offCourse.length + ' != ' + map.offCourse.length);
    check(label + 'module output unsupported count',
      moduleOutput.unsupported.length === map.unsupported.length,
      moduleOutput.unsupported.length + ' != ' + map.unsupported.length);
    check(label + 'module counts',
      JSON.stringify(moduleOutput.counts) === JSON.stringify({
        retailPlacements: map.counts.retailPlacements,
        placeable: map.counts.placeable,
        offCourse: map.counts.offCourse,
        unsupported: map.counts.unsupported
      }),
      JSON.stringify(moduleOutput.counts));

    const modulePlaceableByUid = new Map(
      moduleOutput.pickups.map((entry) => [entry.uid, entry]));
    const moduleOffCourseByUid = new Map(
      moduleOutput.offCourse.map((entry) => [entry.uid, entry]));

    for (const entry of map.placeable) {
      const fromModule = modulePlaceableByUid.get(entry.uid);
      check(label + 'module placeable ' + entry.uid, fromModule !== undefined);
      if (!fromModule) continue;
      check(label + 'module placeable ' + entry.uid + ' x',
        close(fromModule.x, entry.x, EPS));
      check(label + 'module placeable ' + entry.uid + ' y',
        close(fromModule.y, entry.y, EPS));
      check(label + 'module placeable ' + entry.uid + ' z',
        close(fromModule.z, entry.z, EPS));
      check(label + 'module placeable ' + entry.uid + ' arc',
        close(fromModule.arc, entry.arc, EPS));
      check(label + 'module placeable ' + entry.uid + ' residualM',
        close(fromModule.residualM, entry.residualM, EPS));
      check(label + 'module placeable ' + entry.uid + ' physicalProjection',
        fromModule.physicalProjection === true);
    }
    for (const entry of map.offCourse) {
      const fromModule = moduleOffCourseByUid.get(entry.uid);
      check(label + 'module off-course ' + entry.uid, fromModule !== undefined);
      if (!fromModule) continue;
      check(label + 'module off-course ' + entry.uid + ' distanceToCourseM',
        close(fromModule.distanceToCourseM, entry.distanceToCourseM, EPS));
      check(label + 'module off-course ' + entry.uid + ' distanceToBandM',
        close(fromModule.distanceToBandM, entry.distanceToBandM, EPS));
      check(label + 'module off-course ' + entry.uid + ' nearestMeasuredArc',
        close(fromModule.nearestMeasuredArc, entry.nearestMeasuredArc, EPS));
    }

    // ------------------------------------------------ module guards
    const empty = module.physicalPlacementsFor(mapId, { course: { samples: [] } });
    check(label + 'empty layout: no pickups', empty.pickups.length === 0,
      empty.pickups.length);
    check(label + 'empty layout: no off-course', empty.offCourse.length === 0,
      empty.offCourse.length);
    check(label + 'empty layout: every retail uid unsupported',
      empty.unsupported.length === map.rows.length &&
      new Set(empty.unsupported.map((entry) => entry.uid)).size === map.rows.length,
      empty.unsupported.length + ' vs ' + map.rows.length);
    check(label + 'empty layout: reason names no-measured-sample',
      empty.unsupported.every((entry) => entry.reason.startsWith('no-measured-sample')),
      empty.unsupported[0]?.reason);

    const noBand = JSON.parse(JSON.stringify(layout));
    delete noBand.course.band;
    delete noBand.course.corridor;
    const noBandOutput = module.physicalPlacementsFor(mapId, noBand);
    check(label + 'no-band layout: no pickups', noBandOutput.pickups.length === 0,
      noBandOutput.pickups.length);
    check(label + 'no-band layout: every retail uid unsupported',
      noBandOutput.unsupported.length === map.rows.length,
      noBandOutput.unsupported.length + ' vs ' + map.rows.length);
    check(label + 'no-band layout: reason names no-band',
      noBandOutput.unsupported.every((entry) => entry.reason.startsWith('no-band')),
      noBandOutput.unsupported[0]?.reason);
  }

  // ------------------------------------------------------------- determinism
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'blur-powerups-aid-'));
  try {
    const dataA = path.join(tmpRoot, 'data-a.json');
    const dataB = path.join(tmpRoot, 'data-b.json');
    const moduleA = path.join(tmpRoot, 'module-a.mjs');
    const moduleB = path.join(tmpRoot, 'module-b.mjs');
    let built = true;
    try {
      runBuilder(['--out', dataA, '--module-out', moduleA]);
      runBuilder(['--out', dataB, '--module-out', moduleB]);
    } catch (error) {
      built = false;
      check('builders run', false, error.message);
    }
    if (built) {
      const dataABytes = readFileSync(dataA);
      const dataBBytes = readFileSync(dataB);
      const moduleABytes = readFileSync(moduleA);
      const moduleBBytes = readFileSync(moduleB);
      check('determinism: two data builds byte-identical', dataABytes.equals(dataBBytes));
      check('determinism: two module builds byte-identical', moduleABytes.equals(moduleBBytes));
      check('committed data matches builder output', dataABytes.equals(dataBytes));
      check('committed module matches builder output',
        moduleABytes.equals(readFileSync(MODULE_PATH)));
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  if (!options.quiet) {
    for (const failure of failures) console.error('FAIL ' + failure);
    for (const [mapId, map] of Object.entries(data.maps)) {
      console.log(mapId + ': ' + map.counts.placeable + ' placeable / ' +
        map.counts.offCourse + ' off-course / ' + map.counts.retailPlacements +
        ' retail; aid residual median ' + map.counts.aidResidualMedianM +
        ' m max ' + map.counts.aidResidualMaxM + ' m');
    }
  }
  console.log(passed + '/' + total + ' checks passed');
  if (passed !== total) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
