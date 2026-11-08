#!/usr/bin/env node
// Independent verifier for the physically-corresponded retail pickup placement.
//
//   node probes/powerups/tools/verify_physical_placement.mjs
//   node probes/powerups/tools/verify_physical_placement.mjs --quiet
//
// This file deliberately does not import either builder. It re-reads the
// committed pickup-route document, the measured layout files, the committed
// correspondence table and the committed placement source, re-implements the
// correspondence and the placement rule, and compares its own numbers with the
// committed documents and the generated module.
//
// Checks
//   1. schemas, source pins, module exports and embedded data identity.
//   2. layout identity: path, sha256, bytes, length, sample count, band.
//   3. correspondence: independently rebuilt segments match the committed table;
//      every segment is monotone in measured arc and retail arc; every residual
//      is inside the gate; every segment meets the minimum chain rules.
//   4. placement: every retail pickup is re-derived from the committed
//      documents; placeable vs unsupported matches the committed source and the
//      module; every placed pickup is inside the measured band and carries
//      physicalProjection:true, the measured arc, the retail arc, the mapping
//      residual and a source string.
//   5. counts: per map against pickup-routes.json; no retail uid is dropped.
//   6. module guards: empty layout and mismatched layout return every uid as
//      unsupported instead of placing on the wrong course.
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
const CORRESPONDENCE_PATH = path.join(ROOT, 'probes/powerups/data/arc-correspondence.json');
const DATA_PATH = path.join(ROOT, 'probes/powerups/data/retail-placement-physical.json');
const MODULE_PATH = path.join(ROOT, 'probes/powerups/retail-placement-physical.mjs');
const CORRESPONDENCE_BUILDER = path.join(HERE, 'build_arc_correspondence.mjs');
const PLACEMENT_BUILDER = path.join(HERE, 'build_physical_placement.mjs');

const CORRESPONDENCE_SCHEMA = 'blur.powerups-arc-correspondence/1';
const SOURCE_SCHEMA = 'blur.powerups-retail-placement-physical-source/1';
const RUNTIME_SCHEMA = 'blur.powerups-physical-placement/1';
const ROUTES_SCHEMA = 'blur-powerups-pickup-routes/1';
const RULE = 'retail-arc-correspondence';

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

// ------------------------------------------------------------- layout helpers
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

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// --------------------------------------------------- independent correspondence
function nearestOnRoute(route, x, z) {
  const pts = route.points;
  const n = pts.length;
  const routeLength = route.lengthMetres;
  const segments = route.closed ? n : n - 1;
  let best = Infinity;
  let bestArc = 0;
  for (let i = 0; i < segments; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const ex = b[0] - a[0];
    const ez = b[2] - a[2];
    const norm = ex * ex + ez * ez;
    let u = norm > 0 ? ((x - a[0]) * ex + (z - a[2]) * ez) / norm : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const dx = x - (a[0] + ex * u);
    const dz = z - (a[2] + ez * u);
    const squared = dx * dx + dz * dz;
    if (squared < best) {
      best = squared;
      let length = b[3] - a[3];
      if (length < 0) length += routeLength;
      bestArc = a[3] + length * u;
    }
  }
  return { distance: Math.sqrt(best), arc: bestArc };
}

function unwrap(arcs, routeLength) {
  const out = [];
  let last = null;
  for (const raw of arcs) {
    let value = raw;
    if (last !== null) {
      while (value < last - routeLength / 2) value += routeLength;
      while (value > last + routeLength / 2) value -= routeLength;
    }
    out.push(value);
    last = value;
  }
  return out;
}

function monotoneChain(values) {
  const tails = [];
  const tailIndex = [];
  const back = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] <= values[i] + 1e-9) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) back[i] = tailIndex[lo - 1];
    tails[lo] = values[i];
    tailIndex[lo] = i;
  }
  const out = [];
  let cursor = tailIndex[tails.length - 1];
  while (cursor >= 0) {
    out.push(cursor);
    cursor = back[cursor];
  }
  return out.reverse();
}

function rebuildCorrespondence(mapId, layout, routesMap, gate, minChainSamples, minChainSpan, minRetailSpan) {
  const samples = layout.course.samples;
  const segments = [];
  const nearestNetwork = new Array(samples.length).fill(Infinity);
  for (const route of routesMap.routes) {
    const projections = samples.map((sample) => nearestOnRoute(route, sample.x, sample.z));
    for (let i = 0; i < projections.length; i++) {
      if (projections[i].distance < nearestNetwork[i]) nearestNetwork[i] = projections[i].distance;
    }
    let runStart = -1;
    const runs = [];
    for (let i = 0; i < projections.length; i++) {
      const inside = projections[i].distance <= gate + 1e-9;
      if (inside && runStart < 0) runStart = i;
      if ((!inside || i === projections.length - 1) && runStart >= 0) {
        runs.push([runStart, inside ? i : i - 1]);
        runStart = -1;
      }
    }
    for (const [start, end] of runs) {
      const rows = [];
      for (let i = start; i <= end; i++) {
        rows.push({
          measuredArc: samples[i].arc,
          retailArc: projections[i].arc,
          distance: projections[i].distance
        });
      }
      const arcs = unwrap(rows.map((row) => row.retailArc), route.lengthMetres);
      const chain = monotoneChain(arcs);
      if (chain.length < minChainSamples) continue;
      const points = chain.map((i) => [
        round6(rows[i].measuredArc),
        round6(arcs[i]),
        round6(rows[i].distance)
      ]);
      const measuredSpan = points[points.length - 1][0] - points[0][0];
      const retailSpan = points[points.length - 1][1] - points[0][1];
      if (measuredSpan < minChainSpan) continue;
      if (retailSpan < minRetailSpan) continue;
      const distances = points.map((point) => point[2]);
      segments.push({
        route: route.name,
        routeIndex: route.index,
        routeLengthM: round6(route.lengthMetres),
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
    segment.id = mapId + ':' + segment.route + ':' + index;
  });
  return { segments, nearestNetwork };
}

// ------------------------------------------------------- independent placement
function toSegmentFrame(arc, segment) {
  const mid = (segment.retailArcStart + segment.retailArcEnd) / 2;
  let value = arc;
  while (value < mid - segment.routeLengthM / 2) value += segment.routeLengthM;
  while (value > mid + segment.routeLengthM / 2) value -= segment.routeLengthM;
  return value;
}

function interpolate(segment, retailArc) {
  const points = segment.points;
  const value = toSegmentFrame(retailArc, segment);
  if (value < segment.retailArcStart - 1e-9 || value > segment.retailArcEnd + 1e-9) return null;
  if (value <= points[0][1]) return { measuredArc: points[0][0], residualM: points[0][2] };
  const last = points[points.length - 1];
  if (value >= last[1]) return { measuredArc: last[0], residualM: last[2] };
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][1] <= value) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b[1] - a[1];
  const t = span > 0 ? (value - a[1]) / span : 0;
  return {
    measuredArc: a[0] + (b[0] - a[0]) * t,
    residualM: a[2] + (b[2] - a[2]) * t
  };
}

function nearestSample(samples, targetArc) {
  let bestIndex = 0;
  let bestDelta = Math.abs((samples[0].arc ?? 0) - targetArc);
  for (let i = 1; i < samples.length; i++) {
    const delta = Math.abs((samples[i].arc ?? 0) - targetArc);
    if (delta < bestDelta) {
      bestIndex = i;
      bestDelta = delta;
    }
  }
  return { index: bestIndex, sample: samples[bestIndex] };
}

function leftNormal(samples, index) {
  const a = samples[Math.max(0, index - 1)];
  const b = samples[Math.min(samples.length - 1, index + 1)];
  const tx = (b.x ?? 0) - (a.x ?? 0);
  const tz = (b.z ?? 0) - (a.z ?? 0);
  const length = Math.hypot(tx, tz);
  if (!(length > 0)) return { x: 0, z: 0 };
  return { x: -tz / length, z: tx / length };
}

function placePickup(row, segments, samples, band, mapId) {
  let hit = null;
  for (const segment of segments) {
    if (segment.routeIndex !== row.routeIndex) continue;
    const mapped = interpolate(segment, row.arc);
    if (mapped !== null) {
      hit = { segment, ...mapped };
      break;
    }
  }
  if (hit === null) return null;
  const sampleHit = nearestSample(samples, hit.measuredArc);
  const normal = leftNormal(samples, sampleHit.index);
  const clamped = Math.abs(row.lateral) > band.halfWidthMetres;
  const appliedLateral = clamped
    ? Math.sign(row.lateral) * band.halfWidthMetres
    : row.lateral;
  const sampleArc = sampleHit.sample.arc ?? hit.measuredArc;
  return {
    id: mapId + ':' + row.uid,
    uid: row.uid,
    type: row.type,
    x: round6((sampleHit.sample.x ?? 0) + normal.x * appliedLateral),
    y: round6(sampleHit.sample.groundY ?? sampleHit.sample.height ?? 0),
    z: round6((sampleHit.sample.z ?? 0) + normal.z * appliedLateral),
    arc: round6(sampleArc),
    measuredArc: round6(sampleArc),
    retailArc: round6(row.arc),
    routeLengthM: round6(row.routeLengthM),
    lateral: round6(appliedLateral),
    retailLateral: round6(row.lateral),
    clamped,
    clampedBy: round6(Math.max(0, Math.abs(row.lateral) - band.halfWidthMetres)),
    route: row.route,
    routeIndex: row.routeIndex,
    segmentId: hit.segment.id,
    mappingResidualM: round6(hit.residualM),
    sampleIndex: sampleHit.index,
    physicalProjection: true
  };
}

function nearestPolylineDistance(samples, x, z) {
  let best = Infinity;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const vx = (b.x ?? 0) - (a.x ?? 0);
    const vz = (b.z ?? 0) - (a.z ?? 0);
    const lengthSquared = vx * vx + vz * vz;
    let t = lengthSquared > 0
      ? ((x - (a.x ?? 0)) * vx + (z - (a.z ?? 0)) * vz) / lengthSquared
      : 0;
    t = Math.max(0, Math.min(1, t));
    const distance = Math.hypot(x - ((a.x ?? 0) + vx * t), z - ((a.z ?? 0) + vz * t));
    if (distance < best) best = distance;
  }
  return best;
}

const PICKUP_FIELDS = [
  'id', 'uid', 'type', 'x', 'y', 'z', 'arc', 'measuredArc', 'retailArc',
  'routeLengthM', 'lateral', 'retailLateral', 'clamped', 'clampedBy', 'route',
  'routeIndex', 'segmentId', 'mappingResidualM', 'sampleIndex', 'physicalProjection'
];

function comparePickup(label, expected, actual) {
  let ok = true;
  for (const field of PICKUP_FIELDS) {
    const a = expected[field];
    const b = actual[field];
    const same = typeof a === 'number' && typeof b === 'number'
      ? close(a, b, 1e-6)
      : JSON.stringify(a) === JSON.stringify(b);
    ok = check(label + ' ' + field, same, JSON.stringify(b) + ' != ' + JSON.stringify(a)) && ok;
  }
  return ok;
}

// --------------------------------------------------------------- builder runs
function runBuilder(builder, args) {
  execFileSync(process.execPath, [builder, ...args, '--quiet'], {
    cwd: ROOT,
    stdio: 'pipe'
  });
}

// ------------------------------------------------------------------- main
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const routesBytes = readFileSync(ROUTES_PATH);
  const routes = JSON.parse(routesBytes.toString('utf8'));
  const correspondenceBytes = readFileSync(CORRESPONDENCE_PATH);
  const correspondence = JSON.parse(correspondenceBytes.toString('utf8'));
  const dataBytes = readFileSync(DATA_PATH);
  const data = JSON.parse(dataBytes.toString('utf8'));
  const module = await import(pathToFileURL(MODULE_PATH).href);

  // ------------------------------------------------------------- schemas
  check('routes schema', routes.schema === ROUTES_SCHEMA, routes.schema);
  check('correspondence schema', correspondence.schema === CORRESPONDENCE_SCHEMA,
    correspondence.schema);
  check('correspondence kind', correspondence.kind === 'powerups.arc-correspondence',
    correspondence.kind);
  check('correspondence version', correspondence.version === 1, correspondence.version);
  check('data schema', data.schema === SOURCE_SCHEMA, data.schema);
  check('data kind', data.kind === 'powerups.retail-placement-physical-source', data.kind);
  check('data version', data.version === 1, data.version);
  check('data runtimeSchema', data.runtimeSchema === RUNTIME_SCHEMA, data.runtimeSchema);
  check('data arcCorrespondenceSchema',
    data.arcCorrespondenceSchema === CORRESPONDENCE_SCHEMA, data.arcCorrespondenceSchema);
  check('module PHYSICAL_PLACEMENT_SCHEMA',
    module.PHYSICAL_PLACEMENT_SCHEMA === RUNTIME_SCHEMA, module.PHYSICAL_PLACEMENT_SCHEMA);
  check('module ARC_CORRESPONDENCE_SCHEMA',
    module.ARC_CORRESPONDENCE_SCHEMA === CORRESPONDENCE_SCHEMA,
    module.ARC_CORRESPONDENCE_SCHEMA);
  check('module physicalPlacementsFor export',
    typeof module.physicalPlacementsFor === 'function');
  check('module ARC_CORRESPONDENCE matches committed table',
    JSON.stringify(module.ARC_CORRESPONDENCE) === JSON.stringify(correspondence));
  check('module PHYSICAL_PLACEMENT_DATA matches committed source',
    JSON.stringify(module.PHYSICAL_PLACEMENT_DATA) === JSON.stringify(data));

  check('source pin pickup-routes sha256',
    data.sources?.['probes/powerups/data/pickup-routes.json']?.sha256 === sha256(routesBytes),
    data.sources?.['probes/powerups/data/pickup-routes.json']?.sha256);
  check('source pin pickup-routes bytes',
    data.sources?.['probes/powerups/data/pickup-routes.json']?.bytes === routesBytes.length,
    data.sources?.['probes/powerups/data/pickup-routes.json']?.bytes);
  check('source pin correspondence sha256',
    data.sources?.['probes/powerups/data/arc-correspondence.json']?.sha256 ===
      sha256(correspondenceBytes),
    data.sources?.['probes/powerups/data/arc-correspondence.json']?.sha256);
  check('source pin correspondence bytes',
    data.sources?.['probes/powerups/data/arc-correspondence.json']?.bytes ===
      correspondenceBytes.length,
    data.sources?.['probes/powerups/data/arc-correspondence.json']?.bytes);
  check('correspondence pin pickup-routes sha256',
    correspondence.sources?.['probes/powerups/data/pickup-routes.json']?.sha256 ===
      sha256(routesBytes),
    correspondence.sources?.['probes/powerups/data/pickup-routes.json']?.sha256);

  const gate = correspondence.gateMetres;
  check('gate is the measured band half-width', Number.isFinite(gate) && gate > 0, gate);

  for (const [mapId, map] of Object.entries(data.maps)) {
    const label = '[' + mapId + '] ';
    const routesMap = routes.maps[mapId];
    const correspondenceMap = correspondence.maps[mapId];
    check(label + 'routes map exists', routesMap !== undefined);
    check(label + 'correspondence map exists', correspondenceMap !== undefined);
    if (!routesMap || !correspondenceMap) continue;

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
    check(label + 'layout length', close(measuredLength, map.measuredLayout.lengthMetres, 1e-6),
      measuredLength + ' != ' + map.measuredLayout.lengthMetres);
    check(label + 'layout sampleCount', samples.length === map.measuredLayout.sampleCount,
      samples.length + ' != ' + map.measuredLayout.sampleCount);
    check(label + 'layout band', band !== null &&
      close(band.halfWidthMetres, map.measuredLayout.bandHalfWidthMetres, 1e-9),
      band?.halfWidthMetres + ' != ' + map.measuredLayout.bandHalfWidthMetres);
    check(label + 'layout band is the correspondence gate',
      band !== null && close(band.halfWidthMetres, gate, 1e-9),
      band?.halfWidthMetres + ' != ' + gate);
    check(label + 'correspondence measured layout identity',
      correspondenceMap.measuredLayout.sha256 === map.measuredLayout.sha256 &&
      correspondenceMap.measuredLayout.path === map.measuredLayout.path,
      JSON.stringify(correspondenceMap.measuredLayout));

    // ------------------------------------------------ correspondence rebuild
    const rebuilt = rebuildCorrespondence(
      mapId,
      layout,
      routesMap,
      gate,
      correspondence.minChainSamples,
      correspondence.minChainSpanMetres,
      correspondence.minRetailSpanMetres
    );
    check(label + 'correspondence segment count',
      rebuilt.segments.length === correspondenceMap.segments.length,
      rebuilt.segments.length + ' != ' + correspondenceMap.segments.length);
    check(label + 'stats.segmentCount',
      correspondenceMap.stats.segmentCount === rebuilt.segments.length,
      correspondenceMap.stats.segmentCount + ' != ' + rebuilt.segments.length);
    check(label + 'stats.nearestNetwork median',
      close(correspondenceMap.stats.nearestNetwork.medianM, round6(median(rebuilt.nearestNetwork)), 1e-6),
      correspondenceMap.stats.nearestNetwork.medianM + ' != ' +
        round6(median(rebuilt.nearestNetwork)));
    check(label + 'stats.nearestNetwork max',
      close(correspondenceMap.stats.nearestNetwork.maxM, round6(Math.max(...rebuilt.nearestNetwork)), 1e-6),
      correspondenceMap.stats.nearestNetwork.maxM + ' != ' +
        round6(Math.max(...rebuilt.nearestNetwork)));

    const rebuiltPointDistances = rebuilt.segments.flatMap((segment) =>
      segment.points.map((point) => point[2]));
    check(label + 'stats.correspondenceResidual median',
      rebuiltPointDistances.length === 0
        ? correspondenceMap.stats.correspondenceResidual === null
        : close(correspondenceMap.stats.correspondenceResidual.medianM,
          round6(median(rebuiltPointDistances)), 1e-6),
      JSON.stringify(correspondenceMap.stats.correspondenceResidual));
    check(label + 'stats.correspondenceResidual max',
      rebuiltPointDistances.length === 0
        ? correspondenceMap.stats.correspondenceResidual === null
        : close(correspondenceMap.stats.correspondenceResidual.maxM,
          round6(Math.max(...rebuiltPointDistances)), 1e-6),
      JSON.stringify(correspondenceMap.stats.correspondenceResidual));

    for (let index = 0; index < Math.min(rebuilt.segments.length, correspondenceMap.segments.length); index++) {
      const expected = rebuilt.segments[index];
      const actual = correspondenceMap.segments[index];
      const tag = label + 'segment ' + index + ' ';
      check(tag + 'id', actual.id === expected.id, actual.id + ' != ' + expected.id);
      check(tag + 'route', actual.route === expected.route,
        actual.route + ' != ' + expected.route);
      check(tag + 'routeIndex', actual.routeIndex === expected.routeIndex);
      check(tag + 'routeLengthM', close(actual.routeLengthM, expected.routeLengthM, 1e-6));
      check(tag + 'measuredArcStart',
        close(actual.measuredArcStart, expected.measuredArcStart, 1e-6));
      check(tag + 'measuredArcEnd',
        close(actual.measuredArcEnd, expected.measuredArcEnd, 1e-6));
      check(tag + 'retailArcStart',
        close(actual.retailArcStart, expected.retailArcStart, 1e-6));
      check(tag + 'retailArcEnd',
        close(actual.retailArcEnd, expected.retailArcEnd, 1e-6));
      check(tag + 'sampleCount', actual.sampleCount === expected.sampleCount,
        actual.sampleCount + ' != ' + expected.sampleCount);
      check(tag + 'residual median',
        close(actual.residual.medianM, expected.residual.medianM, 1e-6));
      check(tag + 'residual max',
        close(actual.residual.maxM, expected.residual.maxM, 1e-6));
      check(tag + 'points count', actual.points.length === expected.points.length,
        actual.points.length + ' != ' + expected.points.length);

      let pointsMatch = true;
      for (let p = 0; p < Math.min(actual.points.length, expected.points.length); p++) {
        for (let k = 0; k < 3; k++) {
          if (!close(actual.points[p][k], expected.points[p][k], 1e-6)) pointsMatch = false;
        }
      }
      check(tag + 'points values', pointsMatch);

      // Monotone chain and gate.
      let measuredMonotone = true;
      let retailMonotone = true;
      let residualInside = true;
      for (let p = 0; p < actual.points.length; p++) {
        if (p > 0 && actual.points[p][0] < actual.points[p - 1][0] - 1e-9) measuredMonotone = false;
        if (p > 0 && actual.points[p][1] < actual.points[p - 1][1] - 1e-9) retailMonotone = false;
        if (actual.points[p][2] > gate + 1e-6) residualInside = false;
      }
      check(tag + 'measured arc monotone non-decreasing', measuredMonotone);
      check(tag + 'retail arc monotone non-decreasing', retailMonotone);
      check(tag + 'every residual inside the gate', residualInside);
      check(tag + 'measured span >= minimum',
        actual.measuredArcSpan >= correspondence.minChainSpanMetres - 1e-6,
        actual.measuredArcSpan);
      check(tag + 'retail span >= minimum',
        actual.retailArcSpan >= correspondence.minRetailSpanMetres - 1e-6,
        actual.retailArcSpan);
      check(tag + 'sample count >= minimum',
        actual.sampleCount >= correspondence.minChainSamples, actual.sampleCount);
      check(tag + 'direction forward', actual.direction === 'forward', actual.direction);
    }

    // ------------------------------------------------ placement rebuild
    const committedByUid = new Map(map.pickups.map((pickup) => [pickup.uid, pickup]));
    const unsupportedByUid = new Map(map.unsupported.map((entry) => [entry.uid, entry]));
    const routeByUid = new Map(routesMap.pickups.map((pickup) => [pickup.uid, pickup]));
    const worldErrors = [];

    check(label + 'pickup count matches pickup-routes',
      map.rows.length === routesMap.pickups.length,
      map.rows.length + ' != ' + routesMap.pickups.length);
    check(label + 'counts.retailPlacements',
      map.counts.retailPlacements === routesMap.pickups.length,
      map.counts.retailPlacements + ' != ' + routesMap.pickups.length);
    check(label + 'counts.placeable', map.counts.placeable === map.pickups.length,
      map.counts.placeable + ' != ' + map.pickups.length);
    check(label + 'counts.unsupported', map.counts.unsupported === map.unsupported.length,
      map.counts.unsupported + ' != ' + map.unsupported.length);
    check(label + 'placeable + unsupported = retailPlacements',
      map.counts.placeable + map.counts.unsupported === map.counts.retailPlacements,
      map.counts.placeable + ' + ' + map.counts.unsupported);

    const uidSet = new Set();
    for (const row of map.rows) {
      check(label + 'row uid unique ' + row.uid, !uidSet.has(row.uid));
      uidSet.add(row.uid);
    }
    check(label + 'every retail uid present exactly once',
      uidSet.size === routeByUid.size &&
      [...routeByUid.keys()].every((uid) => uidSet.has(uid)),
      uidSet.size + ' vs ' + routeByUid.size);

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
    check(label + 'module output pickup count',
      moduleOutput.pickups.length === map.pickups.length,
      moduleOutput.pickups.length + ' != ' + map.pickups.length);
    check(label + 'module output unsupported count',
      moduleOutput.unsupported.length === map.unsupported.length,
      moduleOutput.unsupported.length + ' != ' + map.unsupported.length);

    const moduleByUid = new Map(moduleOutput.pickups.map((pickup) => [pickup.uid, pickup]));
    const moduleUnsupported = new Map(
      moduleOutput.unsupported.map((entry) => [entry.uid, entry]));

    for (const row of map.rows) {
      const tag = label + 'uid ' + row.uid + ' ';
      const pickup = routeByUid.get(row.uid);
      if (!pickup) continue;
      check(tag + 'row type', row.type === pickup.type, row.type + ' != ' + pickup.type);
      check(tag + 'row route', row.route === pickup.route, row.route + ' != ' + pickup.route);
      check(tag + 'row routeIndex', row.routeIndex === pickup.routeIndex);
      check(tag + 'row arc', close(row.arc, pickup.arc, 1e-9), row.arc + ' != ' + pickup.arc);
      check(tag + 'row lateral', close(row.lateral, pickup.lateral, 1e-9));

      const expected = placePickup(row, rebuilt.segments, samples, band, mapId);
      const committed = committedByUid.get(row.uid);
      const fromModule = moduleByUid.get(row.uid);

      if (expected === null) {
        check(tag + 'unsupported in committed source', committed === undefined);
        check(tag + 'unsupported in module', fromModule === undefined);
        const entry = unsupportedByUid.get(row.uid);
        check(tag + 'unsupported entry present', entry !== undefined);
        check(tag + 'unsupported reason', typeof entry?.reason === 'string' &&
          entry.reason.startsWith('no-measured-correspondence'),
          entry?.reason);
        check(tag + 'module unsupported reason matches',
          moduleUnsupported.get(row.uid)?.reason === entry?.reason,
          moduleUnsupported.get(row.uid)?.reason);
        continue;
      }

      check(tag + 'placeable in committed source', committed !== undefined);
      check(tag + 'placeable in module', fromModule !== undefined);
      check(tag + 'not in unsupported list', unsupportedByUid.get(row.uid) === undefined);
      if (!committed || !fromModule) continue;

      comparePickup(tag + 'committed', expected, committed);
      comparePickup(tag + 'module', expected, fromModule);

      check(tag + 'physicalProjection true', committed.physicalProjection === true);
      check(tag + 'mapping residual inside gate',
        committed.mappingResidualM <= gate + 1e-6, committed.mappingResidualM);
      check(tag + 'source names uid',
        typeof committed.source === 'string' && committed.source.includes('uid ' + row.uid));
      check(tag + 'source names route',
        typeof committed.source === 'string' && committed.source.includes('route ' + row.route));
      check(tag + 'source names segment',
        typeof committed.source === 'string' && committed.source.includes(committed.segmentId));
      check(tag + 'source names rule',
        typeof committed.source === 'string' && committed.source.includes(RULE));
      check(tag + 'source names physicalProjection',
        typeof committed.source === 'string' && committed.source.includes('physicalProjection true'));

      const distance = nearestPolylineDistance(samples, committed.x, committed.z);
      check(tag + 'inside measured band', distance <= band.halfWidthMetres + 1e-6,
        distance.toFixed(6) + ' > ' + band.halfWidthMetres);
      worldErrors.push(Math.hypot(
        (pickup.position?.[0] ?? committed.x) - committed.x,
        (pickup.position?.[2] ?? committed.z) - committed.z
      ));
      if (committed.clamped) {
        check(tag + 'clamped retail lateral exceeds band',
          Math.abs(committed.retailLateral) > band.halfWidthMetres);
        check(tag + 'clamped applied value is the band edge',
          close(Math.abs(committed.lateral), band.halfWidthMetres, 1e-6),
          committed.lateral + ' vs +/-' + band.halfWidthMetres);
      } else {
        check(tag + 'unclamped applied value is the retail lateral',
          close(committed.lateral, committed.retailLateral, 1e-6));
      }
    }

    check(label + 'counts.retailWorldErrorMedianM',
      worldErrors.length === 0
        ? map.counts.retailWorldErrorMedianM === null
        : close(map.counts.retailWorldErrorMedianM, round6(median(worldErrors)), 1e-6),
      map.counts.retailWorldErrorMedianM + ' vs ' +
        (worldErrors.length === 0 ? null : round6(median(worldErrors))));
    check(label + 'counts.retailWorldErrorMaxM',
      worldErrors.length === 0
        ? map.counts.retailWorldErrorMaxM === null
        : close(map.counts.retailWorldErrorMaxM, round6(Math.max(...worldErrors)), 1e-6),
      map.counts.retailWorldErrorMaxM + ' vs ' +
        (worldErrors.length === 0 ? null : round6(Math.max(...worldErrors))));

    // ------------------------------------------------ module guards
    const empty = module.physicalPlacementsFor(mapId, { course: { samples: [] } });
    check(label + 'empty layout: no pickups', empty.pickups.length === 0,
      empty.pickups.length);
    check(label + 'empty layout: every retail uid unsupported',
      empty.unsupported.length === map.rows.length &&
      new Set(empty.unsupported.map((entry) => entry.uid)).size === map.rows.length,
      empty.unsupported.length + ' vs ' + map.rows.length);
    check(label + 'empty layout: reason names no-measured-sample',
      empty.unsupported.every((entry) => entry.reason.startsWith('no-measured-sample')),
      empty.unsupported[0]?.reason);

    const mismatched = JSON.parse(JSON.stringify(layout));
    mismatched.course.lengthMetres = (mismatched.course.lengthMetres ?? 0) + 1;
    const mismatch = module.physicalPlacementsFor(mapId, mismatched);
    check(label + 'mismatched layout: no pickups', mismatch.pickups.length === 0,
      mismatch.pickups.length);
    check(label + 'mismatched layout: every retail uid unsupported',
      mismatch.unsupported.length === map.rows.length,
      mismatch.unsupported.length + ' vs ' + map.rows.length);
    check(label + 'mismatched layout: reason names layout-mismatch',
      mismatch.unsupported.every((entry) => entry.reason.startsWith('layout-mismatch')),
      mismatch.unsupported[0]?.reason);
  }

  // ------------------------------------------------------------- determinism
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'blur-physical-placement-'));
  try {
    const corrA = path.join(tmpRoot, 'corr-a.json');
    const corrB = path.join(tmpRoot, 'corr-b.json');
    const dataA = path.join(tmpRoot, 'data-a.json');
    const dataB = path.join(tmpRoot, 'data-b.json');
    const moduleA = path.join(tmpRoot, 'module-a.mjs');
    const moduleB = path.join(tmpRoot, 'module-b.mjs');
    let built = true;
    try {
      runBuilder(CORRESPONDENCE_BUILDER, ['--out', corrA]);
      runBuilder(CORRESPONDENCE_BUILDER, ['--out', corrB]);
      runBuilder(PLACEMENT_BUILDER, ['--out', dataA, '--module-out', moduleA]);
      runBuilder(PLACEMENT_BUILDER, ['--out', dataB, '--module-out', moduleB]);
    } catch (error) {
      built = false;
      check('builders run', false, error.message);
    }
    if (built) {
      const corrABytes = readFileSync(corrA);
      const corrBBytes = readFileSync(corrB);
      const dataABytes = readFileSync(dataA);
      const dataBBytes = readFileSync(dataB);
      const moduleABytes = readFileSync(moduleA);
      const moduleBBytes = readFileSync(moduleB);
      check('determinism: two correspondence builds byte-identical',
        corrABytes.equals(corrBBytes));
      check('determinism: two placement builds byte-identical',
        dataABytes.equals(dataBBytes));
      check('determinism: two module builds byte-identical',
        moduleABytes.equals(moduleBBytes));
      check('committed correspondence matches builder output',
        corrABytes.equals(correspondenceBytes));
      check('committed placement source matches builder output',
        dataABytes.equals(dataBytes));
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
        map.counts.unsupported + ' unsupported; correspondence segments ' +
        map.correspondence.segmentCount + ', residual median ' +
        map.counts.mappingResidualMedianM + ' m max ' + map.counts.mappingResidualMaxM + ' m');
    }
  }
  console.log(passed + '/' + total + ' checks passed');
  if (passed !== total) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
