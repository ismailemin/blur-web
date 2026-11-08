#!/usr/bin/env node
// Deterministic builder for the committed retail pickup placement artifact.
//
//   node probes/powerups/tools/build_retail_placement.mjs
//   node probes/powerups/tools/build_retail_placement.mjs --out <json> --module-out <mjs>
//
// Inputs (read-only):
//   probes/powerups/data/pickup-routes.json      retail .aid route network + pickup arc/lateral
//   _work/e1-drive/amboy/layout.json             measured Amboy layout the page drives
//   _work/e1-drive/gracia/layout.json            measured Gracia layout the page drives
//   _work/e1-drive/sprint.json                   measured River 310 m layout the page drives
//
// Outputs (committed):
//   probes/powerups/data/retail-placement.json
//   probes/powerups/retail-placement.mjs
//
// The builder does not invent a coordinate. It copies the retail `arc`,
// `lateral`, `route` and route length from the committed `pickup-routes.json`,
// records the measured layout identity (path, sha256, length, sample count,
// band), and leaves the actual placement to `retailPlacementsFor(mapId, layout)`
// in the generated module. The module applies the documented project rule:
//
//   fraction      = retail.arc / retail.routeLengthM
//   measuredArc   = fraction * layout.course.lengthMetres
//   sample        = nearest committed measured sample (ties to the earlier)
//   appliedLateral= clamp(retail.lateral, -band, +band)
//   x/z           = sample.x/z + leftNormal(sample) * appliedLateral
//   y             = sample.groundY
//
// This is a project placement rule, not a physical projection. The measured
// layout is a sub-course of the retail route and its arc origin is not the
// retail origin; the `soundness` block records those offsets so the claim is
// bounded and auditable.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const ROUTES_RELATIVE = 'probes/powerups/data/pickup-routes.json';
const DEFAULT_JSON = path.join(ROOT, 'probes/powerups/data/retail-placement.json');
const DEFAULT_MODULE = path.join(ROOT, 'probes/powerups/retail-placement.mjs');
const TEMPLATE = path.join(HERE, 'retail_placement_module.template.mjs');
const PLACEHOLDER = '/*__RETAIL_PLACEMENT_DATA__*/';

const SOURCE_SCHEMA = 'blur.powerups-retail-placement-source/1';
const RUNTIME_SCHEMA = 'blur.powerups-retail-placement/1';

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

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
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

/** Nearest retail MainLoop point to a measured-layout point. */
function nearestPoint(points, x, z) {
  let best = { distance: Infinity, arc: null, point: null };
  for (const point of points) {
    const distance = Math.hypot(point[0] - x, point[2] - z);
    if (distance < best.distance) {
      best = { distance, arc: point[3], point };
    }
  }
  return best;
}

function unsupportedReason(row) {
  if (!Number.isFinite(row.arc)) return 'no-route-arc: retail arc is not a finite number';
  if (!Number.isFinite(row.routeLengthM) || !(row.routeLengthM > 0)) {
    return 'no-route-arc: retail route length is not a finite positive number';
  }
  if (!(row.arc >= 0)) return 'arc-outside-route: retail arc is negative';
  if (row.arc > row.routeLengthM) {
    return 'arc-outside-route: retail arc ' + row.arc.toFixed(6) +
      ' m is outside route length ' + row.routeLengthM.toFixed(6) + ' m';
  }
  return null;
}

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
  const unsupported = [];
  for (const pickup of routesMap.pickups) {
    const route = routesMap.routes.find((row) => row.index === pickup.routeIndex);
    if (!route) {
      throw new Error(map.mapId + ': pickup ' + pickup.uid +
        ' names route index ' + pickup.routeIndex + ' which is not in the route network');
    }
    if (route.name !== pickup.route) {
      throw new Error(map.mapId + ': pickup ' + pickup.uid + ' route ' + pickup.route +
        ' != route index ' + pickup.routeIndex + ' name ' + route.name);
    }
    const row = {
      uid: pickup.uid,
      type: pickup.type,
      route: pickup.route,
      routeIndex: pickup.routeIndex,
      arc: pickup.arc,
      routeLengthM: route.lengthMetres,
      lateral: pickup.lateral,
      width: pickup.width,
      offset: pickup.offset
    };
    rows.push(row);
    const reason = unsupportedReason(row);
    if (reason) {
      unsupported.push({
        id: map.mapId + ':' + pickup.uid,
        uid: pickup.uid,
        type: pickup.type,
        reason
      });
    }
  }

  const supported = rows.filter((row) => unsupportedReason(row) === null);
  const clamped = supported.filter((row) => Math.abs(row.lateral) > band.halfWidthMetres);
  const clampedOvers = clamped.map((row) => Math.abs(row.lateral) - band.halfWidthMetres);

  const mainLoop = routesMap.routes.find((route) => route.name === 'MainLoop');
  if (!mainLoop) throw new Error(map.mapId + ': route network has no MainLoop');
  const measuredStart = samples[0];
  const measuredEnd = samples[samples.length - 1];
  const startNearest = nearestPoint(mainLoop.points, measuredStart.x, measuredStart.z);
  const endNearest = nearestPoint(mainLoop.points, measuredEnd.x, measuredEnd.z);

  return {
    mapId: map.mapId,
    level: map.level,
    routeRecordId: routesMap.routeRecordId,
    measuredLayout: {
      id: map.layoutId,
      path: map.layoutPath,
      sha256: sha256(layoutBytes),
      bytes: layoutBytes.length,
      lengthMetres: round(measuredLength, 6),
      sampleCount: samples.length,
      sampleStepMetres: round(layout.course.sampleStepMetres ?? 0, 6),
      bandHalfWidthMetres: round(band.halfWidthMetres, 6),
      bandSource: band.source,
      courseId: layout.courseId ?? null,
      courseName: layout.course?.name ?? null
    },
    soundness: {
      rule: 'normalized-retail-arc-fraction',
      status: 'applicable',
      physicalProjection: false,
      retailMainLoopLengthMetres: round(mainLoop.lengthMetres, 6),
      measuredLengthMetres: round(measuredLength, 6),
      lengthRatio: round(measuredLength / mainLoop.lengthMetres, 6),
      measuredStartNearestRetailMainLoop: {
        distanceM: round(startNearest.distance, 3),
        arcM: round(startNearest.arc, 3)
      },
      measuredEndNearestRetailMainLoop: {
        distanceM: round(endNearest.distance, 3),
        arcM: round(endNearest.arc, 3)
      },
      note: 'The normalized-retail-arc rule is applicable to every retail pickup ' +
        '(finite arc, positive route length, non-empty measured samples, finite band). ' +
        'It is a linear arc-fraction remap, not a physical projection: the measured ' +
        'layout is a sub-course of the retail route and its arc origin differs from ' +
        'the retail MainLoop origin (see the nearest-point numbers).'
    },
    counts: {
      retailPlacements: routesMap.pickups.length,
      pickups: supported.length,
      unsupported: unsupported.length,
      clamped: clamped.length,
      clampedMaxOverM: round(clampedOvers.reduce((max, value) => Math.max(max, value), 0), 6),
      clampedOverTotalM: round(clampedOvers.reduce((sum, value) => sum + value, 0), 6)
    },
    pickups: rows,
    unsupported
  };
}

function buildDocument() {
  const routesBytes = readFileSync(path.join(ROOT, ROUTES_RELATIVE));
  const routesDocument = JSON.parse(routesBytes.toString('utf8'));
  if (routesDocument.schema !== 'blur-powerups-pickup-routes/1') {
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
    kind: 'powerups.retail-placement-source',
    version: 1,
    runtimeSchema: RUNTIME_SCHEMA,
    generatedBy: 'probes/powerups/tools/build_retail_placement.mjs',
    scope: 'Retail pickup source rows and measured-layout identity for the e1-drive ' +
      'power-up slice. The module applies a documented project rule to place each ' +
      'retail pickup on the measured layout the page drives. No coordinate is ' +
      'invented: every placement is derived from the retail arc/lateral in ' +
      'pickup-routes.json and a committed measured sample.',
    projectionRule: 'fraction = retail.arc / retail.routeLengthM; measuredArc = ' +
      'fraction * layout.course.lengthMetres; sample = nearest measured sample ' +
      '(ties to the earlier sample); appliedLateral = clamp(retail.lateral, -band, ' +
      '+band); x/z = sample.x/z + leftNormal(sample) * appliedLateral; y = ' +
      'sample.groundY. The left normal is (-tz, tx) of the measured polyline, the ' +
      'same convention as CourseModel.positionAtArc.',
    bandRule: 'The measured band is layout.course.band.halfWidthMetres when present, ' +
      'otherwise layout.course.corridor.halfWidthMetres. A retail lateral outside ' +
      'the band is clamped and the pickup carries clamped:true with the applied value.',
    soundnessRule: 'The rule is a project placement rule, not a physical projection. ' +
      'Each map records the measured layout length, the retail MainLoop length and ' +
      'the nearest retail MainLoop point to the measured start/end, so the arc-origin ' +
      'difference is explicit. A map whose pickups lack a finite arc, a positive route ' +
      'length or a measured sample is listed under unsupported instead of guessed.',
    sources,
    maps
  };
}

function renderModule(document) {
  const template = readFileSync(TEMPLATE, 'utf8');
  if (!template.includes(PLACEHOLDER)) {
    throw new Error('module template is missing the ' + PLACEHOLDER + ' placeholder');
  }
  return template.replace(PLACEHOLDER, JSON.stringify(document, null, 2));
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
      console.log('retail-placement: ' + mapId + ' ' + map.counts.pickups + ' pickups / ' +
        map.counts.unsupported + ' unsupported, ' + map.counts.clamped + ' clamped; ' +
        'layout ' + map.measuredLayout.id + ' ' + map.measuredLayout.lengthMetres +
        ' m band +/-' + map.measuredLayout.bandHalfWidthMetres + ' m');
    }
    console.log('wrote ' + path.relative(ROOT, options.json) + ' sha256 ' +
      sha256(Buffer.from(text)) + ' (' + text.length + ' bytes)');
    console.log('wrote ' + path.relative(ROOT, options.module) + ' sha256 ' +
      sha256(Buffer.from(moduleText)) + ' (' + moduleText.length + ' bytes)');
  }
}

main();
