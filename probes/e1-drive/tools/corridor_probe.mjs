// Corridor limit probe: can the shipped chassis cross the two measured limits of
// the 539.81 m corridor?
//
// The corridor is a coverage measurement, not a race course (see
// web/corridor-survey.js): its measured line climbs a 6.4 cm section-join rise at
// arc 52.19 m and crosses a 50 m vertical collision face at arc 57.82 m. This probe
// measures the physics answer with no driver in the loop: the car is created *on the
// measured line* a few metres before a limit, pointing along the measured tangent,
// and holds full throttle and zero steer. It can only fail on the surface.
//
//   node probes/e1-drive/tools/corridor_probe.mjs [--car <slug>]
//
// Output (never committed):
//   _work/e1-drive/corridor-probe-<slug>.json   both stations, per-tick rows
//   _work/e1-drive/corridor-probe.json          the per-car summary
//
// The verifier imports `runLimitStations` and re-runs the probe, so the recorded
// limits are measured in the gate instead of trusted from a file.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TICK0_LIMITS } from './spawn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORK = path.join(ROOT, '_work/e1-drive');
const MODULE = path.join(WORK, 'module/e1_drive.mjs');
const ROSTER = path.join(WORK, 'cars.json');
const COURSE = path.join(WORK, 'course.json');
const LEGACY_SPAWN = path.join(WORK, 'spawn.json');
const LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics');

/** Station geometry: where the car is placed and how long it drives. */
export const LIMIT_STATIONS = Object.freeze([
  {
    id: 'section-join-rise',
    limitArc: 54,
    startArc: 47.5,
    ticks: 420,
    note: 'P43 measured a 6.36 cm rise in a 0.94 m window (6.7 %) at the g58 -> g50 join, at arc 52.19 m; ' +
      'passing it means reaching arc 54.0 m, where the surface is level again'
  },
  {
    id: 'cliff-pinch',
    limitArc: 56.5,
    startArc: 54.8,
    ticks: 240,
    note: 'the measured path runs into the pinch between the two 50 m vertical collision faces it crosses at ' +
      'arc 57.82 m; this station measures whether a car on the line can pass the pinch (no car reaches 56.5 m)'
  }
]);

/** Nearest measured sample index and distance to a world position. */
export function nearestSample(course, x, z) {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < course.samples.length; index++) {
    const sample = course.samples[index];
    const distance = (sample.x - x) * (sample.x - x) + (sample.z - z) * (sample.z - z);
    if (distance < bestDistance) { bestDistance = distance; best = index; }
  }
  return { index: best, sample: course.samples[best], distance: Math.sqrt(bestDistance) };
}

/** Index of the sample nearest an arc. */
export function sampleIndexAtArc(course, arc) {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < course.samples.length; index++) {
    const distance = Math.abs(course.samples[index].arc - arc);
    if (distance < bestDistance - 1e-12) { best = index; bestDistance = distance; }
  }
  return best;
}

/** Course heading (engine convention: forward = (sin h, cos h)) at a sample. */
export function sampleTangent(course, index, halfSamples = 24) {
  const before = course.samples[Math.max(0, index - halfSamples)];
  const after = course.samples[Math.min(course.samples.length - 1, index + halfSamples)];
  return Math.atan2(after.x - before.x, after.z - before.z);
}

/**
 * Run one station in an already-created module instance. The caller creates the
 * world at the station's start pose (that is the probe's only setup).
 */
export function runLimitStation(module, course, station) {
  const read = () => JSON.parse(module.UTF8ToString(module._e1_get_state()));
  const states = [read()];
  const rows = [{ tick: 0, arc: nearestSample(course, states[0].position[0], states[0].position[2]).sample.arc,
    position: states[0].position, speed: states[0].speed }];
  for (let tick = 1; tick <= station.ticks; tick++) {
    module._e1_set_input(1, 0, 0, 0);
    if (!module._e1_step()) throw new Error('limit probe step failed at tick ' + tick);
    const state = read();
    states.push(state);
    rows.push({
      tick,
      arc: nearestSample(course, state.position[0], state.position[2]).sample.arc,
      position: state.position,
      speed: state.speed
    });
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  const startSample = nearestSample(course, first.position[0], first.position[2]);
  const endSample = nearestSample(course, last.position[0], last.position[2]);
  return {
    id: station.id,
    limitArc: station.limitArc,
    startArc: +first.arc.toFixed(3),
    endArc: +endSample.sample.arc.toFixed(3),
    endLateralMetres: +endSample.distance.toFixed(3),
    startPosition: first.position,
    endPosition: last.position,
    startTangent: sampleTangent(course, startSample.index),
    advancedMetres: +Math.hypot(last.position[0] - first.position[0], last.position[2] - first.position[2])
      .toFixed(3),
    endSpeed: +last.speed.toFixed(3),
    crossedLimit: endSample.sample.arc > station.limitArc,
    contactTicks: states.filter((state) => state.anyContact === 1).length,
    nonFiniteTicks: states.filter((state) => state.finite !== 1).length,
    rows
  };
}

/** Where the probe places the car for a station. */
export function stationPose(course, station) {
  const index = sampleIndexAtArc(course, station.startArc);
  const sample = course.samples[index];
  return { index, x: sample.x, z: sample.z, heading: sampleTangent(course, index), sample };
}

/** Write the per-car record the verifier and the docs reference. */
export function writeCorridorProbe(car, stations, course, options = {}) {
  const file = path.join(WORK, 'corridor-probe-' + car.slug + '.json');
  const record = {
    kind: 'e1-drive.corridor-probe',
    version: 1,
    car: { slug: car.slug, name: car.name, drivetrain: car.drivetrain, record: car.record, fields: car.fields },
    courseHash: course.hash,
    probe: {
      rule: 'the car is created on the measured line at the station start arc, pointing along the measured ' +
        'tangent, and holds full throttle with zero steer; it can only fail on the surface',
      chassisProxyLiftMetres: options.chassisProxyLift ?? null,
      moduleWasmSha256: options.wasmSha256 ?? null
    },
    stations,
    summary: {
      crossedSectionJoinRise: stations.find((entry) => entry.id === 'section-join-rise')?.crossedLimit ?? null,
      crossedCliffPinch: stations.find((entry) => entry.id === 'cliff-pinch')?.crossedLimit ?? null,
      contactTicks: stations.reduce((sum, entry) => sum + entry.contactTicks, 0),
      nonFiniteTicks: stations.reduce((sum, entry) => sum + entry.nonFiniteTicks, 0)
    }
  };
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return { file: path.relative(ROOT, file).split(path.sep).join('/'), record };
}

async function main() {
  const selector = process.argv.includes('--car')
    ? process.argv[process.argv.indexOf('--car') + 1] : null;
  const roster = JSON.parse(readFileSync(ROSTER, 'utf8'));
  const course = JSON.parse(readFileSync(COURSE, 'utf8'));
  const levelBytes = readFileSync(LEVEL);
  const build = JSON.parse(readFileSync(path.join(WORK, 'module/build.json'), 'utf8'));
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  const cars = selector ? roster.roster.cars.filter((car) => car.slug === selector) : roster.roster.cars;
  const summary = [];
  for (const car of cars) {
    const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
    const stations = [];
    let chassisProxyLift = null;
    for (const station of LIMIT_STATIONS) {
      const pose = stationPose(course, station);
      const instance = await factory();
      const levelPtr = instance._malloc(levelBytes.length);
      const fieldsPtr = instance._malloc(fieldBytes.length + 1);
      instance.HEAPU8.set(levelBytes, levelPtr);
      instance.HEAPU8.set(fieldBytes, fieldsPtr);
      if (!instance._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                               pose.x, pose.z, pose.heading)) {
        throw new Error('e1_create failed for ' + car.name + ' at ' + station.id + ': ' +
          instance.UTF8ToString(instance._e1_last_error()));
      }
      chassisProxyLift = JSON.parse(instance.UTF8ToString(instance._e1_info())).chassisProxyLift;
      stations.push(runLimitStation(instance, course, station));
    }
    const written = writeCorridorProbe(car, stations, course, {
      chassisProxyLift,
      wasmSha256: build.wasmSha256
    });
    summary.push({
      slug: car.slug,
      name: car.name,
      file: written.file,
      stations: stations.map((station) => ({
        id: station.id,
        startArc: station.startArc,
        endArc: station.endArc,
        advancedMetres: station.advancedMetres,
        endSpeed: station.endSpeed,
        crossedLimit: station.crossedLimit,
        contactTicks: station.contactTicks,
        nonFiniteTicks: station.nonFiniteTicks
      }))
    });
    console.log(JSON.stringify(summary[summary.length - 1]));
  }
  writeFileSync(path.join(WORK, 'corridor-probe.json'), JSON.stringify({
    kind: 'e1-drive.corridor-probe-summary',
    version: 1,
    courseHash: course.hash,
    moduleWasmSha256: build.wasmSha256,
    chassisProxyLiftMetres: build.chassisProxyLiftMetres ?? 0,
    cars: summary
  }, null, 2) + '\n', 'utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
