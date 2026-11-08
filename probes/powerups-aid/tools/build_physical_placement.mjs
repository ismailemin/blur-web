#!/usr/bin/env node
// Deterministic builder for true world-position retail pickup placement.
//
//   node probes/powerups-aid/tools/build_physical_placement.mjs
//   node probes/powerups-aid/tools/build_physical_placement.mjs --out <json> --module-out <mjs> --quiet
//
// Inputs (read-only):
//   probes/powerups/data/pickup-routes.json   retail .aid route network + per-pickup route/arc/lateral
//   _work/e1-drive/amboy/layout.json          measured Amboy layout the page drives
//   _work/e1-drive/gracia/layout.json         measured Gracia layout the page drives
//   _work/e1-drive/sprint.json                measured River 310 m layout the page drives
//
// Outputs (committed):
//   probes/powerups-aid/data/physical-placement.json
//   probes/powerups-aid/physical-placement.mjs
//
// Rule (recorded in every `source` string):
//
//   routePoint    = interpolate(route.points, retail.arc)          // racing line, line index 5
//   tangent       = normalize(routePoint[i+1] - routePoint[i-1])   // planar
//   normal        = (tangent.z, -tangent.x)                        // (fz, -fx) of the .aid frame
//   lateralOffset = retail.lateral - retail.width * racingOffsets[retail.segment]
//   candidate     = routePoint + normal * lateralOffset
//   retailWorld   = the candidate (normal or -normal) that reproduces the committed retail
//                   WorldMatrix.aw position; `normalSign` records which one was used
//   aidResidualM  = planar distance between retailWorld and the committed retail position
//
//   nearest       = clamped segment projection of retailWorld onto the measured polyline
//   inside        = nearest.distance <= band.halfWidthMetres
//   placeable     = inside: x/z = retailWorld, y = nearest measured sample groundY,
//                   arc = nearest.arc (exact measured arc), retailArc = retail.arc
//   off-course    = not inside: distanceToCourseM = nearest.distance,
//                   distanceToBandM = nearest.distance - band, nearestMeasuredArc = nearest.arc
//
// No coordinate is invented. The only use of the committed retail position is to
// disambiguate the .aid normal sign; the residual of that check is recorded for
// every pickup. A pickup that cannot be placed stays off-course with its exact
// distance. Nothing is remapped by an arc fraction.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const ROUTES_RELATIVE = 'probes/powerups/data/pickup-routes.json';
const DEFAULT_JSON = path.join(ROOT, 'probes/powerups-aid/data/physical-placement.json');
const DEFAULT_MODULE = path.join(ROOT, 'probes/powerups-aid/physical-placement.mjs');
const TEMPLATE = path.join(HERE, 'physical_placement_module.template.mjs');
const PLACEHOLDER_DATA = '/*__PHYSICAL_PLACEMENT_DATA__*/';

const SOURCE_SCHEMA = 'blur.powerups-aid-physical-placement-source/1';
const RUNTIME_SCHEMA = 'blur.powerups-aid-physical-placement/1';
const ROUTES_SCHEMA = 'blur-powerups-pickup-routes/1';
const RULE = 'retail-world-position-band-test';

const MAPS = [
  {
    mapId: 'amboy',
    level: 'usa_amboy',
    layoutId: 'amboy',
    layoutPath: '_work/e1-drive/amboy/layout.json'
  },
  {
    mapId: 'gracia',
    level: 'spa_barcelona_gracia',
    layoutId: 'gracia',
    layoutPath: '_work/e1-drive/gracia/layout.json'
  },
  {
    mapId: 'river',
    level: 'usa_la_river',
    layoutId: '310m',
    layoutPath: '_work/e1-drive/sprint.json'
  }
];

const round = (value, digits) => {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const round6 = (value) => round(value, 6);

function parseArgs(argv) {
  const options = { json: DEFAULT_JSON, module: DEFAULT_MODULE, quiet: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--out') options.json = path.resolve(argv[++index]);
    else if (arg === '--module-out') options.module = path.resolve(argv[++index]);
    else if (arg === '--quiet') options.quiet = true;
    else throw new Error('unknown argument ' + JSON.stringify(arg));
  }
  return options;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
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
  throw new Error('measured layout has no course.band/corridor halfWidthMetres');
}

function measuredLengthOf(layout) {
  const length = layout?.course?.lengthMetres;
  if (Number.isFinite(length) && length > 0) return length;
  const samples = layout?.course?.samples;
  if (Array.isArray(samples) && samples.length > 0) {
    const last = samples[samples.length - 1];
    if (Number.isFinite(last?.arc) && last.arc > 0) return last.arc;
  }
  throw new Error('measured layout has no positive course.lengthMetres');
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ------------------------------------------------------------- retail .aid line
/**
 * Interpolate the racing-line polyline at a retail arc. `points` entries are
 * [x, y, z, arc]. Returns the interpolated point and the lower point index.
 */
function interpolateRoutePoint(points, arc) {
  if (arc <= points[0][3]) {
    return { x: points[0][0], y: points[0][1], z: points[0][2], index: 0 };
  }
  const last = points.length - 1;
  if (arc >= points[last][3]) {
    return { x: points[last][0], y: points[last][1], z: points[last][2], index: last };
  }
  let low = 0;
  let high = last;
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

function routeNormal(points, index) {
  const a = points[Math.max(0, index - 1)];
  const b = points[Math.min(points.length - 1, index + 1)];
  const tx = b[0] - a[0];
  const tz = b[2] - a[2];
  const length = Math.hypot(tx, tz);
  if (!(length > 0)) return { x: 0, z: 0 };
  // .aid frame: normal = (fz, -fx) for forward f = (tx, tz).
  return { x: tz / length, z: -tx / length };
}

/**
 * Retail world position from the .aid line. The .aid serializes the lateral
 * normal as (tangentX, -tangentZ); its sign relative to the stored point order
 * is authored per route, so the two candidates are compared with the committed
 * retail WorldMatrix.aw and the reproducing one is kept. That comparison is a
 * sign disambiguation, not a position source; `aidResidualM` records the check.
 */
function retailWorldPosition(pickup, route) {
  const point = interpolateRoutePoint(route.points, pickup.arc);
  const normal = routeNormal(route.points, point.index);
  const racingOffset = route.racingOffsets[pickup.segment] ?? 0;
  const lateralOffset = pickup.lateral - pickup.width * racingOffset;
  const plus = {
    x: point.x + normal.x * lateralOffset,
    z: point.z + normal.z * lateralOffset
  };
  const minus = {
    x: point.x - normal.x * lateralOffset,
    z: point.z - normal.z * lateralOffset
  };
  const target = pickup.position;
  const plusError = Math.hypot(target[0] - plus.x, target[2] - plus.z);
  const minusError = Math.hypot(target[0] - minus.x, target[2] - minus.z);
  const plusWins = plusError <= minusError;
  return {
    x: plusWins ? plus.x : minus.x,
    z: plusWins ? plus.z : minus.z,
    normalSign: plusWins ? 1 : -1,
    aidResidualM: plusWins ? plusError : minusError,
    routePoint: { x: point.x, y: point.y, z: point.z, index: point.index },
    normal,
    racingOffset,
    lateralOffset
  };
}

// --------------------------------------------------------- measured course query
/**
 * Clamped segment projection of a world XZ point onto the measured polyline.
 * Returns the planar distance, the interpolated measured arc, the lower sample
 * index and the projection point. Ties keep the earlier segment.
 */
function nearestOnMeasured(samples, x, z) {
  let best = { distance: Infinity, arc: 0, index: 0, px: 0, pz: 0 };
  for (let index = 0; index < samples.length - 1; index++) {
    const a = samples[index];
    const b = samples[index + 1];
    const vx = (b.x ?? 0) - (a.x ?? 0);
    const vz = (b.z ?? 0) - (a.z ?? 0);
    const lengthSquared = vx * vx + vz * vz;
    let t = lengthSquared > 0
      ? ((x - (a.x ?? 0)) * vx + (z - (a.z ?? 0)) * vz) / lengthSquared
      : 0;
    t = Math.max(0, Math.min(1, t));
    const px = (a.x ?? 0) + vx * t;
    const pz = (a.z ?? 0) + vz * t;
    const distance = Math.hypot(x - px, z - pz);
    if (distance < best.distance) {
      const arcStart = a.arc ?? 0;
      const arcEnd = b.arc ?? arcStart;
      best = {
        distance,
        arc: arcStart + (arcEnd - arcStart) * t,
        index,
        px,
        pz
      };
    }
  }
  return best;
}

function nearestSampleIndex(samples, targetArc) {
  let bestIndex = 0;
  let bestDelta = Math.abs((samples[0].arc ?? 0) - targetArc);
  for (let index = 1; index < samples.length; index++) {
    const delta = Math.abs((samples[index].arc ?? 0) - targetArc);
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

// ------------------------------------------------------------------ map builder
function buildMap(map, routesDocument) {
  const routesMap = routesDocument.maps[map.mapId];
  if (!routesMap) throw new Error('pickup-routes.json has no map ' + map.mapId);

  const layoutBytes = readFileSync(path.join(ROOT, map.layoutPath));
  const layout = JSON.parse(layoutBytes.toString('utf8'));
  const band = bandOf(layout);
  const measuredLength = measuredLengthOf(layout);
  const samples = layout.course.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error(map.mapId + ': measured layout has no course.samples');
  }

  const rows = [];
  const placeable = [];
  const offCourse = [];
  const unsupported = [];
  const aidResiduals = [];
  const placeableDistances = [];
  const offCourseDistances = [];
  const offCourseExcesses = [];

  for (const pickup of routesMap.pickups) {
    const route = routesMap.routes.find((candidate) => candidate.index === pickup.routeIndex);
    if (!route) {
      unsupported.push({
        id: map.mapId + ':' + pickup.uid,
        uid: pickup.uid,
        type: pickup.type,
        reason: 'no-retail-route: route index ' + pickup.routeIndex + ' is not in pickup-routes.json'
      });
      continue;
    }
    if (!Array.isArray(route.points) || route.points.length < 2) {
      unsupported.push({
        id: map.mapId + ':' + pickup.uid,
        uid: pickup.uid,
        type: pickup.type,
        reason: 'no-retail-line: route ' + route.name + ' (index ' + route.index +
          ') has fewer than two racing-line points'
      });
      continue;
    }

    const world = retailWorldPosition(pickup, route);
    // Classify on the stored coordinate so the committed lists and the module
    // (which reads retailWorldX/Z) use exactly the same input.
    const worldX = round6(world.x);
    const worldZ = round6(world.z);
    const nearest = nearestOnMeasured(samples, worldX, worldZ);
    const sampleIndex = nearestSampleIndex(samples, nearest.arc);
    const inside = nearest.distance <= band.halfWidthMetres + 1e-9;
    aidResiduals.push(world.aidResidualM);

    const row = {
      uid: pickup.uid,
      type: pickup.type,
      route: pickup.route,
      routeIndex: pickup.routeIndex,
      segment: pickup.segment,
      retailArc: round6(pickup.arc),
      routeLengthM: round6(route.lengthMetres),
      lateral: round6(pickup.lateral),
      width: round6(pickup.width),
      racingOffset: round6(world.racingOffset),
      lateralOffset: round6(world.lateralOffset),
      retailPosition: [
        round6(pickup.position[0]),
        round6(pickup.position[1]),
        round6(pickup.position[2])
      ],
      retailWorldX: worldX,
      retailWorldZ: worldZ,
      normalSign: world.normalSign,
      aidResidualM: round6(world.aidResidualM)
    };
    rows.push(row);

    const id = map.mapId + ':' + pickup.uid;
    if (inside) {
      placeableDistances.push(nearest.distance);
      placeable.push({
        id,
        uid: pickup.uid,
        type: pickup.type,
        x: worldX,
        y: round6(groundAt(samples, sampleIndex)),
        z: worldZ,
        arc: round6(nearest.arc),
        measuredArc: round6(nearest.arc),
        retailArc: round6(pickup.arc),
        routeLengthM: round6(route.lengthMetres),
        lateral: round6(pickup.lateral),
        retailLateral: round6(pickup.lateral),
        route: pickup.route,
        routeIndex: pickup.routeIndex,
        segment: pickup.segment,
        aidResidualM: round6(world.aidResidualM),
        residualM: round6(nearest.distance),
        sampleIndex,
        physicalProjection: true,
        source: 'retail uid ' + pickup.uid + ' route ' + pickup.route +
          ' (index ' + pickup.routeIndex + ') retail arc ' + pickup.arc.toFixed(6) +
          ' m, lateral ' + pickup.lateral.toFixed(6) + ' m -> .aid world (' +
          worldX.toFixed(6) + ', ' + worldZ.toFixed(6) + ') (normal sign ' +
          world.normalSign + ', residual to committed position ' +
          world.aidResidualM.toFixed(6) + ' m) -> measured ' + map.layoutId +
          ' arc ' + nearest.arc.toFixed(6) + ' m, centreline distance ' +
          nearest.distance.toFixed(6) + ' m <= band +/-' +
          band.halfWidthMetres.toFixed(6) + ' m (' + band.source + '), groundY ' +
          groundAt(samples, sampleIndex).toFixed(6) + ' m from sample ' + sampleIndex +
          ' of ' + samples.length + '; rule ' + RULE + '; physicalProjection true'
      });
    } else {
      offCourseDistances.push(nearest.distance);
      offCourseExcesses.push(nearest.distance - band.halfWidthMetres);
      offCourse.push({
        id,
        uid: pickup.uid,
        type: pickup.type,
        reason: 'off-course: retail world position (' + worldX.toFixed(6) + ', ' +
          worldZ.toFixed(6) + ') is ' + nearest.distance.toFixed(6) +
          ' m from the measured ' + map.layoutId + ' centreline, ' +
          (nearest.distance - band.halfWidthMetres).toFixed(6) +
          ' m outside the +/-' + band.halfWidthMetres.toFixed(6) + ' m band (' +
          band.source + '); nearest measured arc ' + nearest.arc.toFixed(6) +
          ' m; retail arc ' + pickup.arc.toFixed(6) + ' m on route ' +
          pickup.route + ' (index ' + pickup.routeIndex + ')',
        x: worldX,
        z: worldZ,
        retailArc: round6(pickup.arc),
        nearestMeasuredArc: round6(nearest.arc),
        distanceToCourseM: round6(nearest.distance),
        distanceToBandM: round6(nearest.distance - band.halfWidthMetres),
        route: pickup.route,
        routeIndex: pickup.routeIndex,
        segment: pickup.segment,
        aidResidualM: round6(world.aidResidualM)
      });
    }
  }

  const allDistances = placeableDistances.concat(offCourseDistances);

  return {
    mapId: map.mapId,
    level: map.level,
    routeRecordId: routesMap.routeRecordId,
    measuredLayout: {
      id: map.layoutId,
      path: map.layoutPath,
      sha256: sha256(layoutBytes),
      bytes: layoutBytes.length,
      lengthMetres: round6(measuredLength),
      sampleCount: samples.length,
      sampleStepMetres: round6(layout.course.sampleStepMetres ?? 0),
      bandHalfWidthMetres: round6(band.halfWidthMetres),
      bandSource: band.source,
      courseId: layout.courseId ?? null,
      courseName: layout.course?.name ?? null,
      firstSample: {
        x: round6(samples[0].x ?? 0),
        z: round6(samples[0].z ?? 0),
        arc: round6(samples[0].arc ?? 0)
      },
      lastSample: {
        x: round6(samples[samples.length - 1].x ?? 0),
        z: round6(samples[samples.length - 1].z ?? 0),
        arc: round6(samples[samples.length - 1].arc ?? 0)
      }
    },
    counts: {
      retailPlacements: routesMap.pickups.length,
      rows: rows.length,
      placeable: placeable.length,
      offCourse: offCourse.length,
      unsupported: unsupported.length,
      aidResidualMedianM: aidResiduals.length > 0 ? round6(median(aidResiduals)) : null,
      aidResidualMaxM: aidResiduals.length > 0 ? round6(Math.max(...aidResiduals)) : null,
      placeableDistanceMedianM: placeableDistances.length > 0
        ? round6(median(placeableDistances))
        : null,
      placeableDistanceMaxM: placeableDistances.length > 0
        ? round6(Math.max(...placeableDistances))
        : null,
      offCourseDistanceMinM: offCourseDistances.length > 0
        ? round6(Math.min(...offCourseDistances))
        : null,
      offCourseDistanceMedianM: offCourseDistances.length > 0
        ? round6(median(offCourseDistances))
        : null,
      offCourseDistanceMaxM: offCourseDistances.length > 0
        ? round6(Math.max(...offCourseDistances))
        : null,
      offCourseExcessMinM: offCourseExcesses.length > 0
        ? round6(Math.min(...offCourseExcesses))
        : null,
      offCourseExcessMedianM: offCourseExcesses.length > 0
        ? round6(median(offCourseExcesses))
        : null,
      offCourseExcessMaxM: offCourseExcesses.length > 0
        ? round6(Math.max(...offCourseExcesses))
        : null,
      distanceToCourseMedianM: allDistances.length > 0 ? round6(median(allDistances)) : null
    },
    rows,
    placeable,
    offCourse,
    unsupported
  };
}

function buildDocument() {
  const routesBytes = readFileSync(path.join(ROOT, ROUTES_RELATIVE));
  const routesDocument = JSON.parse(routesBytes.toString('utf8'));
  if (routesDocument.schema !== ROUTES_SCHEMA) {
    throw new Error('pickup-routes.json schema is ' + routesDocument.schema);
  }

  const maps = {};
  for (const map of MAPS) maps[map.mapId] = buildMap(map, routesDocument);

  const sources = {
    [ROUTES_RELATIVE]: {
      sha256: sha256(routesBytes),
      bytes: routesBytes.length
    }
  };
  for (const map of MAPS) {
    sources[map.layoutPath] = {
      sha256: maps[map.mapId].measuredLayout.sha256,
      bytes: maps[map.mapId].measuredLayout.bytes
    };
  }

  return {
    schema: SOURCE_SCHEMA,
    kind: 'powerups.aid-physical-placement-source',
    version: 1,
    runtimeSchema: RUNTIME_SCHEMA,
    generatedBy: 'probes/powerups-aid/tools/build_physical_placement.mjs',
    scope: 'True world-position retail pickup placement for amboy, gracia and river. ' +
      'Each pickup is reconstructed on its committed retail .aid racing line from the ' +
      'decoded route, arc and lateral, then tested against the measured e1-drive band. ' +
      'A pickup inside the band is placed at its retail world position; every other ' +
      'pickup stays off-course with its exact distance. There is no arc-fraction remap.',
    retailWorldRule: 'routePoint = interpolate(route.points, retail.arc); tangent = ' +
      'normalize(routePoint[i+1] - routePoint[i-1]); normal = (tangent.z, -tangent.x) ' +
      '(.aid frame normal = (fz, -fx)); lateralOffset = retail.lateral - retail.width * ' +
      'racingOffsets[retail.segment]; candidate = routePoint + normal * lateralOffset. ' +
      'The .aid normal sign relative to the stored point order is authored per route, so ' +
      'the candidate (normal or -normal) that reproduces the committed retail ' +
      'WorldMatrix.aw position is kept and normalSign records which one was used. ' +
      'aidResidualM is the planar distance between the kept candidate and that committed ' +
      'position; it is a decode check, not a position source.',
    bandRule: 'nearest = clamped segment projection of the retail world position onto the ' +
      'measured course polyline (ties keep the earlier segment); inside = ' +
      'nearest.distance <= band.halfWidthMetres. The band is course.band.halfWidthMetres ' +
      'when present, otherwise course.corridor.halfWidthMetres. It is a declared ' +
      'controller/respawn band, not a road-width claim.',
    placeableRule: 'A pickup inside the band is placed at its retail world x/z; y is the ' +
      'groundY of the nearest measured sample; arc/measuredArc is the exact interpolated ' +
      'measured arc of the projection; retailArc is the retail .aid arc; lateral is the ' +
      'decoded retail lateral; residualM is the centreline distance; physicalProjection ' +
      'is true.',
    offCourseRule: 'A pickup outside the band is not moved. It is recorded with its retail ' +
      'world x/z, the exact distanceToCourseM to the measured centreline, distanceToBandM ' +
      '(distance beyond the band edge), nearestMeasuredArc and the reason string. No ' +
      'coordinate is invented and no pickup is dropped silently.',
    sources,
    maps
  };
}

function renderModule(document) {
  const template = readFileSync(TEMPLATE, 'utf8');
  if (!template.includes(PLACEHOLDER_DATA)) {
    throw new Error('module template is missing ' + PLACEHOLDER_DATA);
  }
  return template.replace(PLACEHOLDER_DATA, () => JSON.stringify(document));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const document = buildDocument();
  const text = JSON.stringify(document, null, 2) + '\n';
  const moduleText = renderModule(document);
  mkdirSync(path.dirname(options.json), { recursive: true });
  mkdirSync(path.dirname(options.module), { recursive: true });
  writeFileSync(options.json, text);
  writeFileSync(options.module, moduleText);
  if (!options.quiet) {
    for (const [mapId, map] of Object.entries(document.maps)) {
      console.log('physical-placement: ' + mapId + ' ' + map.counts.placeable +
        ' placeable / ' + map.counts.offCourse + ' off-course / ' +
        map.counts.retailPlacements + ' retail; aid residual median ' +
        map.counts.aidResidualMedianM + ' m max ' + map.counts.aidResidualMaxM + ' m');
    }
    console.log('wrote ' + path.relative(ROOT, options.json) + ' sha256 ' +
      sha256(Buffer.from(text)) + ' (' + text.length + ' bytes)');
    console.log('wrote ' + path.relative(ROOT, options.module) + ' sha256 ' +
      sha256(Buffer.from(moduleText)) + ' (' + moduleText.length + ' bytes)');
  }
}

main();
