#!/usr/bin/env node
// Deterministic builder for the measured-arc <-> retail-arc correspondence table.
//
//   node probes/powerups/tools/build_arc_correspondence.mjs
//   node probes/powerups/tools/build_arc_correspondence.mjs --out <json> --quiet
//
// Inputs (read-only):
//   probes/powerups/data/pickup-routes.json   retail .aid route network (racing lines)
//   _work/e1-drive/amboy/layout.json          measured Amboy layout the page drives
//   _work/e1-drive/gracia/layout.json         measured Gracia layout the page drives
//   _work/e1-drive/sprint.json                measured River 310 m layout the page drives
//
// Output (committed):
//   probes/powerups/data/arc-correspondence.json
//
// Method
//   1. For every measured sample, project it onto every retail route polyline
//      (clamped segment projection; closed routes wrap). That gives a nearest
//      racing-line point, a residual distance and a retail arc.
//   2. Split each route's samples into contiguous runs whose residual is at
//      most `gateMetres`.
//   3. Unwrap the retail arc across a route closure, then take the longest
//      non-decreasing subsequence (monotone chain) of the run. A run whose
//      measured course travels backwards along the retail route collapses to
//      one point and is dropped.
//   4. Keep a chain only when it has at least `minChainSamples` samples, spans
//      at least `minChainSpanMetres` of measured arc and at least
//      `minRetailSpanMetres` of retail arc.
//
// The gate is the measured band half-width (6 m). It is a placement-consistency
// gate, not a road-width claim: the placement clamps the retail lateral to
// +/-band, so a correspondence residual larger than the band would move a
// pickup further than the band the placement itself declares.
//
// No coordinate is invented. Every segment point is a committed measured sample
// and its projection onto a committed retail racing line.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const ROUTES_RELATIVE = 'probes/powerups/data/pickup-routes.json';
const DEFAULT_JSON = path.join(ROOT, 'probes/powerups/data/arc-correspondence.json');

const SOURCE_SCHEMA = 'blur.powerups-arc-correspondence/1';
const ROUTES_SCHEMA = 'blur-powerups-pickup-routes/1';

const GATE_METRES = 6;
const MIN_CHAIN_SAMPLES = 8;
const MIN_CHAIN_SPAN_METRES = 2;
const MIN_RETAIL_SPAN_METRES = 1;

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
  const options = { json: DEFAULT_JSON, quiet: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--out') options.json = path.resolve(argv[++index]);
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

/**
 * Clamped segment projection of a point onto a retail racing line.
 * Returns the planar distance and the retail racing-line arc at the station.
 */
function projectRoute(route, x, z) {
  const points = route.points;
  const count = points.length;
  const routeLength = route.lengthMetres;
  const last = route.closed ? count : count - 1;
  let bestDistance = Infinity;
  let bestArc = 0;
  for (let index = 0; index < last; index++) {
    const a = points[index];
    const b = points[(index + 1) % count];
    const vx = b[0] - a[0];
    const vz = b[2] - a[2];
    const lengthSquared = vx * vx + vz * vz;
    let t = lengthSquared > 0
      ? ((x - a[0]) * vx + (z - a[2]) * vz) / lengthSquared
      : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = x - (a[0] + vx * t);
    const dz = z - (a[2] + vz * t);
    const distanceSquared = dx * dx + dz * dz;
    if (distanceSquared < bestDistance) {
      bestDistance = distanceSquared;
      let segmentLength = b[3] - a[3];
      if (segmentLength < 0) segmentLength += routeLength;
      bestArc = a[3] + segmentLength * t;
    }
  }
  return { distance: Math.sqrt(bestDistance), arc: bestArc };
}

/** Unwrap retail arcs across a route closure so a run is a continuous coordinate. */
function unwrapArcs(arcs, routeLength) {
  const out = new Array(arcs.length);
  let previous = null;
  for (let index = 0; index < arcs.length; index++) {
    let arc = arcs[index];
    if (previous !== null) {
      while (arc < previous - routeLength / 2) arc += routeLength;
      while (arc > previous + routeLength / 2) arc -= routeLength;
    }
    out[index] = arc;
    previous = arc;
  }
  return out;
}

/**
 * Longest non-decreasing subsequence (monotone chain). Returns the selected
 * indices in ascending order. Ties are allowed (non-decreasing, not strict).
 */
function longestNonDecreasing(values) {
  const tails = [];
  const tailIndex = [];
  const previous = new Array(values.length).fill(-1);
  for (let index = 0; index < values.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tails[mid] <= values[index] + 1e-9) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous[index] = tailIndex[low - 1];
    tails[low] = values[index];
    tailIndex[low] = index;
  }
  const out = [];
  let cursor = tailIndex[tails.length - 1];
  while (cursor >= 0) {
    out.push(cursor);
    cursor = previous[cursor];
  }
  return out.reverse();
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
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

  const nearestNetwork = new Array(samples.length).fill(Infinity);
  const segments = [];
  const rejectedRuns = [];

  for (const route of routesMap.routes) {
    const routeLength = route.lengthMetres;
    const projections = samples.map((sample) =>
      projectRoute(route, sample.x, sample.z));

    for (let index = 0; index < projections.length; index++) {
      if (projections[index].distance < nearestNetwork[index]) {
        nearestNetwork[index] = projections[index].distance;
      }
    }

    // Contiguous runs whose residual is inside the gate.
    let runStart = -1;
    const runs = [];
    for (let index = 0; index < projections.length; index++) {
      const inside = projections[index].distance <= GATE_METRES + 1e-9;
      if (inside && runStart < 0) runStart = index;
      if ((!inside || index === projections.length - 1) && runStart >= 0) {
        const end = inside ? index : index - 1;
        runs.push({ start: runStart, end });
        runStart = -1;
      }
    }

    for (const run of runs) {
      const runSamples = [];
      for (let index = run.start; index <= run.end; index++) {
        runSamples.push({
          measuredArc: samples[index].arc,
          retailArc: projections[index].arc,
          distance: projections[index].distance
        });
      }
      const unwrapped = unwrapArcs(runSamples.map((row) => row.retailArc), routeLength);
      const chain = longestNonDecreasing(unwrapped);
      const runMeasuredSpan = runSamples[runSamples.length - 1].measuredArc - runSamples[0].measuredArc;
      const runRetailSpan = chain.length > 0
        ? unwrapped[chain[chain.length - 1]] - unwrapped[chain[0]]
        : 0;
      let rejected = null;
      if (chain.length < MIN_CHAIN_SAMPLES) rejected = 'chain-too-short';
      else if (runMeasuredSpan < MIN_CHAIN_SPAN_METRES) rejected = 'measured-span-too-short';
      else if (runRetailSpan < MIN_RETAIL_SPAN_METRES) rejected = 'retail-span-too-short';
      if (rejected) {
        rejectedRuns.push({
          route: route.name,
          routeIndex: route.index,
          measuredArcStart: round6(runSamples[0].measuredArc),
          measuredArcEnd: round6(runSamples[runSamples.length - 1].measuredArc),
          measuredArcSpan: round6(runMeasuredSpan),
          retailArcSpan: round6(runRetailSpan),
          runSamples: runSamples.length,
          chainSamples: chain.length,
          residualMaxM: round6(Math.max(...runSamples.map((row) => row.distance))),
          reason: rejected
        });
        continue;
      }

      const points = chain.map((index) => [
        round6(runSamples[index].measuredArc),
        round6(unwrapped[index]),
        round6(runSamples[index].distance)
      ]);
      const measuredSpan = points[points.length - 1][0] - points[0][0];
      const retailSpan = points[points.length - 1][1] - points[0][1];
      if (measuredSpan < MIN_CHAIN_SPAN_METRES) continue;
      if (retailSpan < MIN_RETAIL_SPAN_METRES) continue;

      const distances = points.map((point) => point[2]);
      segments.push({
        route: route.name,
        routeIndex: route.index,
        routeLengthM: round6(routeLength),
        measuredArcStart: points[0][0],
        measuredArcEnd: points[points.length - 1][0],
        measuredArcSpan: round6(measuredSpan),
        retailArcStart: points[0][1],
        retailArcEnd: points[points.length - 1][1],
        retailArcSpan: round6(retailSpan),
        direction: 'forward',
        sampleCount: points.length,
        residual: {
          medianM: round6(median(distances)),
          maxM: round6(Math.max(...distances))
        },
        points
      });
    }
  }

  segments.sort((a, b) =>
    a.measuredArcStart - b.measuredArcStart ||
    a.routeIndex - b.routeIndex ||
    a.measuredArcEnd - b.measuredArcEnd);
  segments.forEach((segment, index) => {
    segment.id = map.mapId + ':' + segment.route + ':' + index;
  });

  const samplesInsideGate = nearestNetwork.filter((distance) => distance <= GATE_METRES + 1e-9).length;
  const segmentSamples = segments.reduce((sum, segment) => sum + segment.sampleCount, 0);
  const matchedMeasuredMetres = segments.reduce((sum, segment) => sum + segment.measuredArcSpan, 0);
  const segmentPointDistances = segments.flatMap((segment) =>
    segment.points.map((point) => point[2]));
  const nearestMainLoop = routesMap.routes.find((route) => route.name === 'MainLoop');
  const mainLoopDistances = nearestMainLoop
    ? samples.map((sample) => projectRoute(nearestMainLoop, sample.x, sample.z).distance)
    : [];

  const routeCoverage = {};
  for (const segment of segments) {
    const entry = routeCoverage[segment.route] ?? { routeIndex: segment.routeIndex, segments: 0, measuredMetres: 0, retailMetres: 0 };
    entry.segments += 1;
    entry.measuredMetres = round6(entry.measuredMetres + segment.measuredArcSpan);
    entry.retailMetres = round6(entry.retailMetres + segment.retailArcSpan);
    routeCoverage[segment.route] = entry;
  }

  rejectedRuns.sort((a, b) => b.runSamples - a.runSamples || a.measuredArcStart - b.measuredArcStart);

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
      courseName: layout.course?.name ?? null
    },
    stats: {
      sampleCount: samples.length,
      samplesInsideGate,
      samplesInsideGateFraction: round6(samplesInsideGate / samples.length),
      segmentCount: segments.length,
      segmentSamples,
      segmentMeasuredMetres: round6(matchedMeasuredMetres),
      correspondenceResidual: segmentPointDistances.length > 0
        ? {
            medianM: round6(median(segmentPointDistances)),
            maxM: round6(Math.max(...segmentPointDistances))
          }
        : null,
      nearestNetwork: {
        minM: round6(Math.min(...nearestNetwork)),
        medianM: round6(median(nearestNetwork)),
        maxM: round6(Math.max(...nearestNetwork))
      },
      nearestMainLoop: nearestMainLoop
        ? {
            minM: round6(Math.min(...mainLoopDistances)),
            medianM: round6(median(mainLoopDistances)),
            maxM: round6(Math.max(...mainLoopDistances))
          }
        : null
    },
    routeCoverage,
    rejectedRuns: rejectedRuns.slice(0, 40),
    rejectedRunCount: rejectedRuns.length,
    segments
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
    kind: 'powerups.arc-correspondence',
    version: 1,
    generatedBy: 'probes/powerups/tools/build_arc_correspondence.mjs',
    scope: 'Measured-arc to retail-arc correspondence for the e1-drive power-up slice. ' +
      'Each segment is a monotone chain of committed measured samples projected onto a ' +
      'committed retail .aid racing line. A pickup can only be placed where its retail ' +
      'arc falls inside one of these segments; every other pickup is unsupported.',
    method: 'For every measured sample, project it onto every retail route polyline ' +
      '(clamped segment projection, closed routes wrap) and keep the residual distance ' +
      'and retail arc. Split each route into contiguous runs whose residual is at most ' +
      'gateMetres. Unwrap the retail arc across a route closure and take the longest ' +
      'non-decreasing subsequence (monotone chain) of each run. Keep a chain only when it ' +
      'has at least minChainSamples samples, spans at least minChainSpanMetres of measured ' +
      'arc and at least minRetailSpanMetres of retail arc. A run that travels backwards ' +
      'along the retail route collapses to one point and is dropped.',
    gateRule: 'gateMetres is the measured band half-width (course.band or course.corridor). ' +
      'It is a placement-consistency gate, not a road-width claim: the placement clamps the ' +
      'retail lateral to +/-band, so a correspondence residual larger than the band would ' +
      'move a pickup further than the band the placement itself declares.',
    gateMetres: GATE_METRES,
    minChainSamples: MIN_CHAIN_SAMPLES,
    minChainSpanMetres: MIN_CHAIN_SPAN_METRES,
    minRetailSpanMetres: MIN_RETAIL_SPAN_METRES,
    sources,
    maps
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const document = buildDocument();
  const text = JSON.stringify(document, null, 2) + '\n';
  mkdirSync(path.dirname(options.json), { recursive: true });
  writeFileSync(options.json, text);
  if (!options.quiet) {
    for (const [mapId, map] of Object.entries(document.maps)) {
      console.log('arc-correspondence: ' + mapId + ' ' + map.segments.length +
        ' segments, ' + map.stats.samplesInsideGate + '/' + map.stats.sampleCount +
        ' samples inside the ' + document.gateMetres + ' m gate, ' +
        map.stats.segmentMeasuredMetres + ' measured m; nearest network median ' +
        map.stats.nearestNetwork.medianM + ' m');
    }
    console.log('wrote ' + path.relative(ROOT, options.json) + ' sha256 ' +
      sha256(Buffer.from(text)) + ' (' + text.length + ' bytes)');
  }
}

main();
