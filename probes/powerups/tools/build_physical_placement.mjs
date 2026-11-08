#!/usr/bin/env node
// Deterministic builder for the physically-corresponded retail pickup placement.
//
//   node probes/powerups/tools/build_physical_placement.mjs
//   node probes/powerups/tools/build_physical_placement.mjs --out <json> --module-out <mjs> --quiet
//
// Inputs (read-only):
//   probes/powerups/data/pickup-routes.json       retail .aid route network + pickup arc/lateral
//   probes/powerups/data/arc-correspondence.json  measured-arc <-> retail-arc monotone table
//   _work/e1-drive/amboy/layout.json              measured Amboy layout the page drives
//   _work/e1-drive/gracia/layout.json             measured Gracia layout the page drives
//   _work/e1-drive/sprint.json                    measured River 310 m layout the page drives
//
// Outputs (committed):
//   probes/powerups/data/retail-placement-physical.json
//   probes/powerups/retail-placement-physical.mjs
//
// Rule (recorded in every `source` string):
//
//   segment       = the arc-correspondence segment of the pickup's route whose
//                   retail-arc interval contains the pickup's retail arc
//   measuredArc   = interpolate(segment.points, retail.arc)   // physical, per segment
//   sample        = nearest measured sample to measuredArc (ties to the earlier)
//   appliedLateral= clamp(retail.lateral, -band, +band)
//   x/z           = sample.x/z + leftNormal(sample) * appliedLateral
//   y             = sample.groundY
//
// A pickup whose retail arc is not covered by a correspondence segment is
// returned in `unsupported` with the reason. No coordinate is invented and no
// pickup is moved by a global fraction.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const ROUTES_RELATIVE = 'probes/powerups/data/pickup-routes.json';
const CORRESPONDENCE_RELATIVE = 'probes/powerups/data/arc-correspondence.json';
const DEFAULT_JSON = path.join(ROOT, 'probes/powerups/data/retail-placement-physical.json');
const DEFAULT_MODULE = path.join(ROOT, 'probes/powerups/retail-placement-physical.mjs');
const TEMPLATE = path.join(HERE, 'retail_physical_module.template.mjs');
const PLACEHOLDER_CORRESPONDENCE = '/*__ARC_CORRESPONDENCE__*/';
const PLACEHOLDER_PLACEMENT = '/*__PHYSICAL_PLACEMENT_DATA__*/';

const SOURCE_SCHEMA = 'blur.powerups-retail-placement-physical-source/1';
const RUNTIME_SCHEMA = 'blur.powerups-physical-placement/1';
const CORRESPONDENCE_SCHEMA = 'blur.powerups-arc-correspondence/1';
const ROUTES_SCHEMA = 'blur-powerups-pickup-routes/1';

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
const round9 = (value) => round(value, 9);

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

function nearestSample(samples, targetArc) {
  let bestIndex = 0;
  let bestDelta = Math.abs((samples[0].arc ?? 0) - targetArc);
  for (let index = 1; index < samples.length; index++) {
    const delta = Math.abs((samples[index].arc ?? 0) - targetArc);
    if (delta < bestDelta) {
      bestIndex = index;
      bestDelta = delta;
    }
  }
  return { index: bestIndex, sample: samples[bestIndex], delta: bestDelta };
}

function leftNormalAt(samples, index) {
  const a = samples[Math.max(0, index - 1)];
  const b = samples[Math.min(samples.length - 1, index + 1)];
  const tx = (b.x ?? 0) - (a.x ?? 0);
  const tz = (b.z ?? 0) - (a.z ?? 0);
  const length = Math.hypot(tx, tz);
  if (!(length > 0)) return { x: 0, z: 0 };
  return { x: -tz / length, z: tx / length };
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Move a retail arc into the segment's unwrapped frame (one closure at most). */
function toSegmentFrame(arc, segment) {
  const routeLength = segment.routeLengthM;
  const mid = (segment.retailArcStart + segment.retailArcEnd) / 2;
  let value = arc;
  while (value < mid - routeLength / 2) value += routeLength;
  while (value > mid + routeLength / 2) value -= routeLength;
  return value;
}

/** Interpolate measured arc and residual at a retail arc inside a segment. */
function interpolateSegment(segment, retailArc) {
  const points = segment.points;
  const value = toSegmentFrame(retailArc, segment);
  if (value < segment.retailArcStart - 1e-9 || value > segment.retailArcEnd + 1e-9) {
    return null;
  }
  if (value <= points[0][1]) {
    return { measuredArc: points[0][0], residualM: points[0][2] };
  }
  const last = points[points.length - 1];
  if (value >= last[1]) {
    return { measuredArc: last[0], residualM: last[2] };
  }
  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (points[mid][1] <= value) low = mid;
    else high = mid;
  }
  const a = points[low];
  const b = points[high];
  const span = b[1] - a[1];
  const t = span > 0 ? (value - a[1]) / span : 0;
  return {
    measuredArc: a[0] + (b[0] - a[0]) * t,
    residualM: a[2] + (b[2] - a[2]) * t
  };
}

function findSegment(segments, routeIndex, retailArc) {
  for (const segment of segments) {
    if (segment.routeIndex !== routeIndex) continue;
    const hit = interpolateSegment(segment, retailArc);
    if (hit !== null) return { segment, ...hit };
  }
  return null;
}

function unsupportedReason(pickup, segments, gateMetres) {
  const routeSegments = segments.filter((segment) => segment.routeIndex === pickup.routeIndex);
  if (routeSegments.length === 0) {
    return 'no-measured-correspondence: route ' + pickup.route + ' (index ' +
      pickup.routeIndex + ') has no measured-arc correspondence segment; the measured ' +
      'layout is not on this retail racing line within the ' + gateMetres.toFixed(3) + ' m gate';
  }
  const ranges = routeSegments
    .map((segment) => segment.retailArcStart.toFixed(3) + '..' + segment.retailArcEnd.toFixed(3))
    .join(', ');
  return 'no-measured-correspondence: retail arc ' + pickup.arc.toFixed(6) +
    ' m on route ' + pickup.route + ' (index ' + pickup.routeIndex +
    ') is outside the measured-arc correspondence [' + ranges + '] m';
}

function buildMap(map, routesDocument, correspondenceDocument, correspondenceSha) {
  const routesMap = routesDocument.maps[map.mapId];
  if (!routesMap) throw new Error('pickup-routes.json has no map ' + map.mapId);
  const correspondenceMap = correspondenceDocument.maps[map.mapId];
  if (!correspondenceMap) {
    throw new Error('arc-correspondence.json has no map ' + map.mapId);
  }

  const layoutBytes = readFileSync(path.join(ROOT, map.layoutPath));
  const layout = JSON.parse(layoutBytes.toString('utf8'));
  const band = bandOf(layout);
  const measuredLength = measuredLengthOf(layout);
  const samples = layout.course.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error(map.mapId + ': measured layout has no course.samples');
  }
  const segments = correspondenceMap.segments;

  const rows = [];
  const pickups = [];
  const unsupported = [];
  const residuals = [];
  const worldErrors = [];

  for (const pickup of routesMap.pickups) {
    const route = routesMap.routes.find((candidate) => candidate.index === pickup.routeIndex);
    if (!route) {
      throw new Error(map.mapId + ': pickup ' + pickup.uid +
        ' names route index ' + pickup.routeIndex + ' which is not in the route network');
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

    const hit = findSegment(segments, row.routeIndex, row.arc);
    if (!hit) {
      unsupported.push({
        id: map.mapId + ':' + row.uid,
        uid: row.uid,
        type: row.type,
        reason: unsupportedReason(row, segments, correspondenceDocument.gateMetres)
      });
      continue;
    }

    const sampleHit = nearestSample(samples, hit.measuredArc);
    const normal = leftNormalAt(samples, sampleHit.index);
    const retailLateral = row.lateral;
    const clamped = Math.abs(retailLateral) > band.halfWidthMetres;
    const appliedLateral = clamped
      ? Math.sign(retailLateral) * band.halfWidthMetres
      : retailLateral;
    const sampleArc = sampleHit.sample.arc ?? hit.measuredArc;
    const x = (sampleHit.sample.x ?? 0) + normal.x * appliedLateral;
    const z = (sampleHit.sample.z ?? 0) + normal.z * appliedLateral;
    const y = sampleHit.sample.groundY ?? sampleHit.sample.height ?? 0;
    residuals.push(hit.residualM);
    const worldError = Math.hypot(
      (pickup.position?.[0] ?? x) - x,
      (pickup.position?.[2] ?? z) - z
    );
    worldErrors.push(worldError);

    pickups.push({
      id: map.mapId + ':' + row.uid,
      uid: row.uid,
      type: row.type,
      route: row.route,
      routeIndex: row.routeIndex,
      retailArc: round6(row.arc),
      routeLengthM: round6(row.routeLengthM),
      retailLateral: round6(retailLateral),
      segmentId: hit.segment.id,
      measuredArc: round6(sampleArc),
      arc: round6(sampleArc),
      mappingResidualM: round6(hit.residualM),
      lateral: round6(appliedLateral),
      clamped,
      clampedBy: round6(Math.max(0, Math.abs(retailLateral) - band.halfWidthMetres)),
      x: round6(x),
      y: round6(y),
      z: round6(z),
      sampleIndex: sampleHit.index,
      physicalProjection: true,
      source: 'retail uid ' + row.uid + ' route ' + row.route +
        ' (index ' + row.routeIndex + ') retail arc ' + row.arc.toFixed(6) + ' m' +
        ' -> correspondence ' + hit.segment.id + ' residual ' + hit.residualM.toFixed(6) +
        ' m -> measured ' + map.layoutId + ' arc ' + sampleArc.toFixed(6) +
        ' m (sample ' + sampleHit.index + ' of ' + samples.length + ')' +
        '; lateral ' + retailLateral.toFixed(6) + ' m ' +
        (clamped ? 'clamped to ' + appliedLateral.toFixed(6) : 'kept') +
        ' (band +/-' + band.halfWidthMetres.toFixed(6) + ' m from ' + band.source + ')' +
        '; rule retail-arc-correspondence + banded-lateral; physicalProjection true'
    });
  }

  const clampedRows = pickups.filter((pickup) => pickup.clamped);
  const clampedOvers = clampedRows.map((pickup) =>
    Math.abs(pickup.retailLateral) - band.halfWidthMetres);

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
    correspondence: {
      path: CORRESPONDENCE_RELATIVE,
      sha256: correspondenceSha,
      gateMetres: correspondenceDocument.gateMetres,
      segmentCount: segments.length
    },
    counts: {
      retailPlacements: routesMap.pickups.length,
      placeable: pickups.length,
      unsupported: unsupported.length,
      clamped: clampedRows.length,
      clampedMaxOverM: round6(clampedOvers.reduce((max, value) => Math.max(max, value), 0)),
      clampedOverTotalM: round6(clampedOvers.reduce((sum, value) => sum + value, 0)),
      mappingResidualMedianM: residuals.length > 0 ? round6(median(residuals)) : null,
      mappingResidualMaxM: residuals.length > 0 ? round6(Math.max(...residuals)) : null,
      retailWorldErrorMedianM: worldErrors.length > 0 ? round6(median(worldErrors)) : null,
      retailWorldErrorMaxM: worldErrors.length > 0 ? round6(Math.max(...worldErrors)) : null
    },
    rows,
    pickups,
    unsupported
  };
}

function buildDocument() {
  const routesBytes = readFileSync(path.join(ROOT, ROUTES_RELATIVE));
  const routesDocument = JSON.parse(routesBytes.toString('utf8'));
  if (routesDocument.schema !== ROUTES_SCHEMA) {
    throw new Error('pickup-routes.json schema is ' + routesDocument.schema);
  }
  const correspondenceBytes = readFileSync(path.join(ROOT, CORRESPONDENCE_RELATIVE));
  const correspondenceDocument = JSON.parse(correspondenceBytes.toString('utf8'));
  if (correspondenceDocument.schema !== CORRESPONDENCE_SCHEMA) {
    throw new Error('arc-correspondence.json schema is ' + correspondenceDocument.schema);
  }
  const correspondenceSha = sha256(correspondenceBytes);

  const maps = {};
  for (const map of MAPS) {
    maps[map.mapId] = buildMap(map, routesDocument, correspondenceDocument, correspondenceSha);
  }

  const sources = {
    [ROUTES_RELATIVE]: {
      sha256: sha256(routesBytes),
      bytes: routesBytes.length
    },
    [CORRESPONDENCE_RELATIVE]: {
      sha256: correspondenceSha,
      bytes: correspondenceBytes.length
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
    kind: 'powerups.retail-placement-physical-source',
    version: 1,
    runtimeSchema: RUNTIME_SCHEMA,
    arcCorrespondenceSchema: CORRESPONDENCE_SCHEMA,
    generatedBy: 'probes/powerups/tools/build_physical_placement.mjs',
    scope: 'Physically-corresponded retail pickup placement for the e1-drive power-up ' +
      'slice. Each pickup is placed at its retail arc mapped through the committed ' +
      'measured-arc <-> retail-arc correspondence table, not by a global arc fraction. ' +
      'A pickup whose retail arc has no correspondence segment is unsupported.',
    placementRule: 'segment = the arc-correspondence segment of the pickup route whose ' +
      'retail-arc interval contains the pickup retail arc; measuredArc = ' +
      'interpolate(segment.points, retail.arc); sample = nearest measured sample to ' +
      'measuredArc (ties to the earlier sample); appliedLateral = clamp(retail.lateral, ' +
      '-band, +band); x/z = sample.x/z + leftNormal(sample) * appliedLateral; y = ' +
      'sample.groundY. The left normal is (-tz, tx) of the measured polyline.',
    unsupportedRule: 'A pickup is unsupported when its route has no correspondence segment ' +
      'or its retail arc falls outside every segment of its route. The reason names the ' +
      'route, the retail arc and the correspondence ranges. No pickup is dropped silently.',
    lateralRule: 'Every retail pickup in pickup-routes.json sits on the retail racing line: ' +
      'lateral = width * offset to within 1e-4 m. The applied lateral is still the ' +
      'origin-relative pickup-routes.json lateral, clamped to +/-band, because that is the ' +
      'documented PWR9 convention and the task keeps it. It is a corridor coordinate, not ' +
      'an offset from the racing line, so it is a project placement choice. The physical ' +
      'claim is the along-track arc correspondence; counts.retailWorldError* records how ' +
      'far the placed point is from the retail world position, dominated by that clamp.',
    layoutIdentityRule: 'The correspondence is tied to the exact measured layout it was ' +
      'built from. The module rejects a layout whose length, sample count or first/last ' +
      'sample differ, and returns every retail uid as unsupported with a layout-mismatch ' +
      'reason instead of placing on the wrong course.',
    sources,
    maps
  };
}

function renderModule(document, correspondenceDocument) {
  const template = readFileSync(TEMPLATE, 'utf8');
  if (!template.includes(PLACEHOLDER_CORRESPONDENCE)) {
    throw new Error('module template is missing ' + PLACEHOLDER_CORRESPONDENCE);
  }
  if (!template.includes(PLACEHOLDER_PLACEMENT)) {
    throw new Error('module template is missing ' + PLACEHOLDER_PLACEMENT);
  }
  return template
    .replace(PLACEHOLDER_CORRESPONDENCE, () => JSON.stringify(correspondenceDocument))
    .replace(PLACEHOLDER_PLACEMENT, () => JSON.stringify(document));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const document = buildDocument();
  const correspondenceDocument = readJson(CORRESPONDENCE_RELATIVE);
  const text = JSON.stringify(document, null, 2) + '\n';
  const moduleText = renderModule(document, correspondenceDocument);
  mkdirSync(path.dirname(options.json), { recursive: true });
  mkdirSync(path.dirname(options.module), { recursive: true });
  writeFileSync(options.json, text);
  writeFileSync(options.module, moduleText);
  if (!options.quiet) {
    for (const [mapId, map] of Object.entries(document.maps)) {
      console.log('physical-placement: ' + mapId + ' ' + map.counts.placeable +
        ' placeable / ' + map.counts.unsupported + ' unsupported, ' +
        map.counts.clamped + ' clamped; residual median ' +
        map.counts.mappingResidualMedianM + ' m max ' + map.counts.mappingResidualMaxM + ' m');
    }
    console.log('wrote ' + path.relative(ROOT, options.json) + ' sha256 ' +
      sha256(Buffer.from(text)) + ' (' + text.length + ' bytes)');
    console.log('wrote ' + path.relative(ROOT, options.module) + ' sha256 ' +
      sha256(Buffer.from(moduleText)) + ' (' + moduleText.length + ' bytes)');
  }
}

main();
