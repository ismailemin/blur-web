#!/usr/bin/env node
// Independent verifier for probes/powerups/data/retail-placement.json and the
// generated browser module probes/powerups/retail-placement.mjs.
//
//   node probes/powerups/tools/verify_retail_placement.mjs
//   node probes/powerups/tools/verify_retail_placement.mjs --data <json> --module <mjs> --quiet
//
// This file deliberately does not import the builder. It re-reads the committed
// pickup-route document, re-reads the measured layout files, re-applies the
// documented normalized-retail-arc rule, and compares its own numbers with both
// the committed source data and the generated module.
//
// Checks
//   1. schemas: source document, runtime module export, runtime output.
//   2. layout identity: path, sha256, bytes, length, sample count, band.
//   3. pickup identity: every retail uid appears once; type/route/arc/lateral/
//      route length match pickup-routes.json.
//   4. projection: every pickup is re-derived independently and must match the
//      module's x/y/z/arc/lateral/clamped/sampleIndex.
//   5. band: every placed pickup is inside the measured band; a clamped pickup
//      is exactly on the band and records the applied value.
//   6. unsupported: no retail uid is dropped silently.
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
const DEFAULT_DATA = path.join(ROOT, 'probes/powerups/data/retail-placement.json');
const DEFAULT_MODULE = path.join(ROOT, 'probes/powerups/retail-placement.mjs');
const ROUTES_PATH = path.join(ROOT, 'probes/powerups/data/pickup-routes.json');
const BUILDER = path.join(HERE, 'build_retail_placement.mjs');

const SOURCE_SCHEMA = 'blur.powerups-retail-placement-source/1';
const RUNTIME_SCHEMA = 'blur.powerups-retail-placement/1';
const ROUTES_SCHEMA = 'blur-powerups-pickup-routes/1';
const RULE = 'normalized-retail-arc-fraction';

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

function close(a, b, tolerance) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function parseArgs(argv) {
  const options = { data: DEFAULT_DATA, module: DEFAULT_MODULE, quiet: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--data') options.data = path.resolve(argv[++index]);
    else if (arg === '--module') options.module = path.resolve(argv[++index]);
    else if (arg === '--quiet') options.quiet = true;
    else throw new Error('unknown argument ' + JSON.stringify(arg));
  }
  return options;
}

const round6 = (value) => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const round9 = (value) => {
  const rounded = Math.round(value * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const round3 = (value) => {
  const rounded = Math.round(value * 1e3) / 1e3;
  return Object.is(rounded, -0) ? 0 : rounded;
};

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// --------------------------------------------------------------- layout rules
// Re-implemented independently of the builder and the module.
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
  return { index: bestIndex, sample: samples[bestIndex] };
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

function derive(row, layout) {
  const samples = layout.course.samples;
  const band = bandOf(layout);
  const measuredLength = measuredLengthOf(layout);
  if (!band) throw new Error('layout has no band');
  if (!(measuredLength > 0)) throw new Error('layout has no measured length');
  const fraction = row.arc / row.routeLengthM;
  const targetArc = fraction * measuredLength;
  const hit = nearestSample(samples, targetArc);
  const normal = leftNormalAt(samples, hit.index);
  const retailLateral = row.lateral;
  const clamped = Math.abs(retailLateral) > band.halfWidthMetres;
  const appliedLateral = clamped
    ? Math.sign(retailLateral) * band.halfWidthMetres
    : retailLateral;
  const sampleArc = hit.sample.arc ?? targetArc;
  return {
    x: round6((hit.sample.x ?? 0) + normal.x * appliedLateral),
    y: round6(hit.sample.groundY ?? hit.sample.height ?? 0),
    z: round6((hit.sample.z ?? 0) + normal.z * appliedLateral),
    arc: round6(sampleArc),
    lateral: round6(appliedLateral),
    retailLateral: round6(retailLateral),
    clamped,
    fraction: round9(fraction),
    sampleIndex: hit.index,
    bandHalfWidthMetres: band.halfWidthMetres
  };
}

function nearestPolylineDistance(samples, x, z) {
  let best = Infinity;
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
    const distance = Math.hypot(
      x - ((a.x ?? 0) + vx * t),
      z - ((a.z ?? 0) + vz * t)
    );
    if (distance < best) best = distance;
  }
  return best;
}

function nearestPoint(points, x, z) {
  let best = { distance: Infinity, arc: null };
  for (const point of points) {
    const distance = Math.hypot(point[0] - x, point[2] - z);
    if (distance < best.distance) best = { distance, arc: point[3] };
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

// --------------------------------------------------------------- builder runs
function runBuilder(jsonPath, modulePath) {
  execFileSync(process.execPath, [
    BUILDER,
    '--out', jsonPath,
    '--module-out', modulePath,
    '--quiet'
  ], { cwd: ROOT, stdio: 'pipe' });
}

// --------------------------------------------------------------- main
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataBytes = readFileSync(options.data);
  const data = JSON.parse(dataBytes.toString('utf8'));
  const routesBytes = readFileSync(ROUTES_PATH);
  const routes = JSON.parse(routesBytes.toString('utf8'));
  const module = await import(pathToFileURL(options.module).href);

  check('source schema', data.schema === SOURCE_SCHEMA, data.schema);
  check('source kind', data.kind === 'powerups.retail-placement-source', data.kind);
  check('source version', data.version === 1, data.version);
  check('source runtimeSchema', data.runtimeSchema === RUNTIME_SCHEMA, data.runtimeSchema);
  check('routes schema', routes.schema === ROUTES_SCHEMA, routes.schema);
  check('pickup-routes source sha256',
    data.sources?.['probes/powerups/data/pickup-routes.json']?.sha256 === sha256(routesBytes),
    data.sources?.['probes/powerups/data/pickup-routes.json']?.sha256);
  check('pickup-routes source bytes',
    data.sources?.['probes/powerups/data/pickup-routes.json']?.bytes === routesBytes.length,
    data.sources?.['probes/powerups/data/pickup-routes.json']?.bytes);
  check('module RETAIL_PLACEMENT_SCHEMA', module.RETAIL_PLACEMENT_SCHEMA === RUNTIME_SCHEMA,
    module.RETAIL_PLACEMENT_SCHEMA);
  check('module retailPlacementsFor export', typeof module.retailPlacementsFor === 'function');
  check('module data matches committed source',
    JSON.stringify(module.RETAIL_PLACEMENT_DATA) === JSON.stringify(data));

  for (const [mapId, map] of Object.entries(data.maps)) {
    const label = '[' + mapId + '] ';
    const routesMap = routes.maps[mapId];
    check(label + 'routes map exists', routesMap !== undefined);
    if (!routesMap) continue;

    // ------------------------------------------------ measured layout identity
    const layoutPath = path.join(ROOT, map.measuredLayout.path);
    const layoutBytes = readFileSync(layoutPath);
    const layout = JSON.parse(layoutBytes.toString('utf8'));
    const band = bandOf(layout);
    const measuredLength = measuredLengthOf(layout);
    const samples = layout.course.samples;

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
    check(label + 'layout bandSource', band?.source === map.measuredLayout.bandSource,
      band?.source + ' != ' + map.measuredLayout.bandSource);
    check(label + 'layout courseId', (layout.courseId ?? null) === map.measuredLayout.courseId,
      layout.courseId + ' != ' + map.measuredLayout.courseId);

    // ------------------------------------------------ pickup identity
    const routeByUid = new Map(routesMap.pickups.map((pickup) => [pickup.uid, pickup]));
    const dataUids = map.pickups.map((row) => row.uid);
    const dataUidSet = new Set(dataUids);
    check(label + 'pickup count matches pickup-routes',
      map.pickups.length === routesMap.pickups.length,
      map.pickups.length + ' != ' + routesMap.pickups.length);
    check(label + 'pickup uid set matches pickup-routes',
      dataUidSet.size === routeByUid.size &&
      [...routeByUid.keys()].every((uid) => dataUidSet.has(uid)),
      dataUidSet.size + ' vs ' + routeByUid.size);
    check(label + 'pickup uids unique', dataUidSet.size === dataUids.length,
      dataUids.length + ' rows, ' + dataUidSet.size + ' unique');

    const recomputedUnsupported = map.pickups
      .map((row) => ({ row, reason: unsupportedReason(row) }))
      .filter((entry) => entry.reason !== null);
    check(label + 'unsupported list matches recomputation',
      JSON.stringify(map.unsupported.map((row) => row.uid).sort((a, b) => a - b)) ===
      JSON.stringify(recomputedUnsupported.map((entry) => entry.row.uid).sort((a, b) => a - b)),
      map.unsupported.length + ' vs ' + recomputedUnsupported.length);

    const supportedRows = map.pickups.filter((row) => unsupportedReason(row) === null);
    const clampedRows = supportedRows.filter((row) =>
      Math.abs(row.lateral) > map.measuredLayout.bandHalfWidthMetres);
    const clampedOvers = clampedRows.map((row) =>
      Math.abs(row.lateral) - map.measuredLayout.bandHalfWidthMetres);
    check(label + 'counts.retailPlacements',
      map.counts.retailPlacements === routesMap.pickups.length,
      map.counts.retailPlacements + ' != ' + routesMap.pickups.length);
    check(label + 'counts.pickups', map.counts.pickups === supportedRows.length,
      map.counts.pickups + ' != ' + supportedRows.length);
    check(label + 'counts.unsupported', map.counts.unsupported === recomputedUnsupported.length,
      map.counts.unsupported + ' != ' + recomputedUnsupported.length);
    check(label + 'counts.clamped', map.counts.clamped === clampedRows.length,
      map.counts.clamped + ' != ' + clampedRows.length);
    check(label + 'counts.clampedMaxOverM',
      close(map.counts.clampedMaxOverM,
        round6(clampedOvers.reduce((max, value) => Math.max(max, value), 0)), 1e-6),
      map.counts.clampedMaxOverM);
    check(label + 'counts.clampedOverTotalM',
      close(map.counts.clampedOverTotalM,
        round6(clampedOvers.reduce((sum, value) => sum + value, 0)), 1e-6),
      map.counts.clampedOverTotalM);

    for (const row of map.pickups) {
      const pickup = routeByUid.get(row.uid);
      if (!pickup) continue;
      const route = routesMap.routes.find((candidate) => candidate.index === row.routeIndex);
      check(label + 'uid ' + row.uid + ' type', row.type === pickup.type,
        row.type + ' != ' + pickup.type);
      check(label + 'uid ' + row.uid + ' route', row.route === pickup.route,
        row.route + ' != ' + pickup.route);
      check(label + 'uid ' + row.uid + ' routeIndex', row.routeIndex === pickup.routeIndex,
        row.routeIndex + ' != ' + pickup.routeIndex);
      check(label + 'uid ' + row.uid + ' arc', close(row.arc, pickup.arc, 1e-9),
        row.arc + ' != ' + pickup.arc);
      check(label + 'uid ' + row.uid + ' lateral', close(row.lateral, pickup.lateral, 1e-9),
        row.lateral + ' != ' + pickup.lateral);
      check(label + 'uid ' + row.uid + ' width', close(row.width, pickup.width, 1e-9),
        row.width + ' != ' + pickup.width);
      check(label + 'uid ' + row.uid + ' offset', close(row.offset, pickup.offset, 1e-9),
        row.offset + ' != ' + pickup.offset);
      check(label + 'uid ' + row.uid + ' routeLengthM',
        route !== undefined && close(row.routeLengthM, route.lengthMetres, 1e-9),
        row.routeLengthM + ' != ' + route?.lengthMetres);
    }

    // ------------------------------------------------ soundness numbers
    const mainLoop = routesMap.routes.find((route) => route.name === 'MainLoop');
    check(label + 'MainLoop exists', mainLoop !== undefined);
    if (mainLoop) {
      const start = samples[0];
      const end = samples[samples.length - 1];
      const startNearest = nearestPoint(mainLoop.points, start.x, start.z);
      const endNearest = nearestPoint(mainLoop.points, end.x, end.z);
      check(label + 'soundness rule', map.soundness.rule === RULE, map.soundness.rule);
      check(label + 'soundness status', map.soundness.status === 'applicable',
        map.soundness.status);
      check(label + 'soundness physicalProjection', map.soundness.physicalProjection === false,
        map.soundness.physicalProjection);
      check(label + 'soundness retailMainLoopLength',
        close(map.soundness.retailMainLoopLengthMetres, mainLoop.lengthMetres, 1e-6),
        map.soundness.retailMainLoopLengthMetres + ' != ' + mainLoop.lengthMetres);
      check(label + 'soundness measuredLength',
        close(map.soundness.measuredLengthMetres, measuredLength, 1e-6),
        map.soundness.measuredLengthMetres + ' != ' + measuredLength);
      check(label + 'soundness lengthRatio',
        close(map.soundness.lengthRatio, measuredLength / mainLoop.lengthMetres, 1e-6),
        map.soundness.lengthRatio);
      check(label + 'soundness start distance',
        close(map.soundness.measuredStartNearestRetailMainLoop.distanceM,
          round3(startNearest.distance), 1e-3),
        map.soundness.measuredStartNearestRetailMainLoop.distanceM + ' != ' +
        round3(startNearest.distance));
      check(label + 'soundness start arc',
        close(map.soundness.measuredStartNearestRetailMainLoop.arcM,
          round3(startNearest.arc), 1e-3),
        map.soundness.measuredStartNearestRetailMainLoop.arcM + ' != ' +
        round3(startNearest.arc));
      check(label + 'soundness end distance',
        close(map.soundness.measuredEndNearestRetailMainLoop.distanceM,
          round3(endNearest.distance), 1e-3),
        map.soundness.measuredEndNearestRetailMainLoop.distanceM + ' != ' +
        round3(endNearest.distance));
      check(label + 'soundness end arc',
        close(map.soundness.measuredEndNearestRetailMainLoop.arcM,
          round3(endNearest.arc), 1e-3),
        map.soundness.measuredEndNearestRetailMainLoop.arcM + ' != ' +
        round3(endNearest.arc));
    }

    // ------------------------------------------------ module output
    const output = module.retailPlacementsFor(mapId, layout);
    check(label + 'output schema', output.schema === RUNTIME_SCHEMA, output.schema);
    check(label + 'output mapId', output.mapId === mapId, output.mapId);
    check(label + 'output source names map', typeof output.source === 'string' &&
      output.source.includes(mapId), output.source);
    check(label + 'output source names rule', typeof output.source === 'string' &&
      output.source.includes(RULE), output.source);
    check(label + 'output pickup count', output.pickups.length === supportedRows.length,
      output.pickups.length + ' != ' + supportedRows.length);
    check(label + 'output unsupported count',
      output.unsupported.length === recomputedUnsupported.length,
      output.unsupported.length + ' != ' + recomputedUnsupported.length);
    check(label + 'output uid set',
      JSON.stringify(output.pickups.map((row) => row.uid).sort((a, b) => a - b)) ===
      JSON.stringify(supportedRows.map((row) => row.uid).sort((a, b) => a - b)));

    const rowByUid = new Map(map.pickups.map((row) => [row.uid, row]));
    const outputByUid = new Map(output.pickups.map((row) => [row.uid, row]));
    for (const row of supportedRows) {
      const out = outputByUid.get(row.uid);
      const tag = label + 'uid ' + row.uid + ' ';
      if (!check(tag + 'present in output', out !== undefined)) continue;
      const expected = derive(row, layout);
      check(tag + 'id', out.id === mapId + ':' + row.uid, out.id);
      check(tag + 'type', out.type === row.type, out.type + ' != ' + row.type);
      check(tag + 'route', out.route === row.route, out.route + ' != ' + row.route);
      check(tag + 'routeIndex', out.routeIndex === row.routeIndex,
        out.routeIndex + ' != ' + row.routeIndex);
      check(tag + 'retailArc', close(out.retailArc, round6(row.arc), 1e-6),
        out.retailArc + ' != ' + round6(row.arc));
      check(tag + 'routeLengthM', close(out.routeLengthM, round6(row.routeLengthM), 1e-6),
        out.routeLengthM + ' != ' + round6(row.routeLengthM));
      check(tag + 'retailLateral', close(out.retailLateral, expected.retailLateral, 1e-6),
        out.retailLateral + ' != ' + expected.retailLateral);
      check(tag + 'clamped', out.clamped === expected.clamped,
        out.clamped + ' != ' + expected.clamped);
      check(tag + 'clampedBy', close(out.clampedBy,
        round6(Math.max(0, Math.abs(row.lateral) - expected.bandHalfWidthMetres)), 1e-6),
        out.clampedBy);
      check(tag + 'fraction', close(out.fraction, expected.fraction, 1e-9),
        out.fraction + ' != ' + expected.fraction);
      check(tag + 'x', close(out.x, expected.x, 1e-6), out.x + ' != ' + expected.x);
      check(tag + 'y', close(out.y, expected.y, 1e-6), out.y + ' != ' + expected.y);
      check(tag + 'z', close(out.z, expected.z, 1e-6), out.z + ' != ' + expected.z);
      check(tag + 'arc', close(out.arc, expected.arc, 1e-6), out.arc + ' != ' + expected.arc);
      check(tag + 'lateral', close(out.lateral, expected.lateral, 1e-6),
        out.lateral + ' != ' + expected.lateral);
      check(tag + 'sampleIndex', out.sampleIndex === expected.sampleIndex,
        out.sampleIndex + ' != ' + expected.sampleIndex);

      const distance = nearestPolylineDistance(samples, out.x, out.z);
      check(tag + 'inside measured band', distance <= expected.bandHalfWidthMetres + 1e-6,
        distance.toFixed(6) + ' > ' + expected.bandHalfWidthMetres);
      if (expected.clamped) {
        check(tag + 'clamped retail lateral exceeds band',
          Math.abs(row.lateral) > expected.bandHalfWidthMetres,
          Math.abs(row.lateral) + ' <= ' + expected.bandHalfWidthMetres);
        check(tag + 'clamped applied value is the band edge',
          close(Math.abs(out.lateral), expected.bandHalfWidthMetres, 1e-6),
          out.lateral + ' vs +/-' + expected.bandHalfWidthMetres);
      } else {
        check(tag + 'unclamped applied value is the retail lateral',
          close(out.lateral, round6(row.lateral), 1e-6),
          out.lateral + ' != ' + round6(row.lateral));
      }
      check(tag + 'source names uid', typeof out.source === 'string' &&
        out.source.includes('uid ' + row.uid), out.source);
      check(tag + 'source names route', typeof out.source === 'string' &&
        out.source.includes('route ' + row.route), out.source);
      check(tag + 'source names rule', typeof out.source === 'string' &&
        out.source.includes(RULE), out.source);
    }

    for (const entry of output.unsupported) {
      const row = rowByUid.get(entry.uid);
      const tag = label + 'unsupported uid ' + entry.uid + ' ';
      check(tag + 'row exists', row !== undefined);
      check(tag + 'id', entry.id === mapId + ':' + entry.uid, entry.id);
      check(tag + 'type', row !== undefined && entry.type === row.type,
        entry.type + ' != ' + row?.type);
      check(tag + 'reason', typeof entry.reason === 'string' && entry.reason.length > 0,
        entry.reason);
    }

    // The "never drop silently" contract also has to hold when the host passes
    // a layout with no measured samples: every retail uid must come back as
    // unsupported, not disappear.
    const emptyOutput = module.retailPlacementsFor(mapId, { course: { samples: [] } });
    check(label + 'empty layout: no pickups', emptyOutput.pickups.length === 0,
      emptyOutput.pickups.length);
    check(label + 'empty layout: every retail uid unsupported',
      emptyOutput.unsupported.length === map.pickups.length &&
      new Set(emptyOutput.unsupported.map((entry) => entry.uid)).size === map.pickups.length,
      emptyOutput.unsupported.length + ' vs ' + map.pickups.length);
    check(label + 'empty layout: reason names no-measured-sample',
      emptyOutput.unsupported.every((entry) =>
        typeof entry.reason === 'string' && entry.reason.startsWith('no-measured-sample')),
      emptyOutput.unsupported[0]?.reason);
  }

  // ------------------------------------------------ determinism
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'blur-retail-placement-'));
  try {
    const jsonA = path.join(tmpRoot, 'a.json');
    const moduleA = path.join(tmpRoot, 'a.mjs');
    const jsonB = path.join(tmpRoot, 'b.json');
    const moduleB = path.join(tmpRoot, 'b.mjs');
    let built = true;
    try {
      runBuilder(jsonA, moduleA);
      runBuilder(jsonB, moduleB);
    } catch (error) {
      built = false;
      check('builder runs', false, error.message);
    }
    if (built) {
      const bytesA = readFileSync(jsonA);
      const bytesB = readFileSync(jsonB);
      const moduleAbytes = readFileSync(moduleA);
      const moduleBbytes = readFileSync(moduleB);
      check('determinism: two JSON builds byte-identical', bytesA.equals(bytesB));
      check('determinism: two module builds byte-identical', moduleAbytes.equals(moduleBbytes));
      check('committed JSON matches builder output', bytesA.equals(dataBytes));
      check('committed module matches builder output',
        moduleAbytes.equals(readFileSync(options.module)));
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  if (!options.quiet) {
    for (const failure of failures) console.error('FAIL ' + failure);
    for (const [mapId, map] of Object.entries(data.maps)) {
      console.log(mapId + ': ' + map.counts.pickups + ' pickups / ' +
        map.counts.unsupported + ' unsupported, ' + map.counts.clamped +
        ' clamped; layout ' + map.measuredLayout.id + ' ' +
        map.measuredLayout.lengthMetres + ' m, band +/-' +
        map.measuredLayout.bandHalfWidthMetres + ' m');
    }
  }
  console.log(passed + '/' + total + ' checks passed');
  if (passed !== total) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
