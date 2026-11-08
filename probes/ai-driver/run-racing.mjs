// Racing-line AI evidence run.
//
// Reads the committed drive artifacts read-only:
//
//   _work/e1-drive/module/e1_drive.mjs + .wasm
//   _work/e1-drive/Level.levelphysics
//   _work/e1-drive/cars.json and each roster car's .fields
//   _work/e1-drive/sprint.json, sprint-lap.json, amboy/layout.json,
//   gracia/layout.json
//
// For every (course, profile, car) it builds a racing line from the car's XT
// grip fields, drives the real wasm vehicle with the new controller, drives the
// same car/course with the previous controller (`./ai-driver.mjs`) for a
// like-for-like baseline, replays every recorded input sequence into a fresh
// wasm instance and compares every per-tick state hash, then runs the overtake
// scenarios.
//
// Writes `_work/ai-driver/results-racing.json`. `verify-racing.mjs` writes
// `verify-racing.json`. Wall-clock tick cost is written to
// `_work/ai-driver/tick-cost.json` by a separate measurement, never into the
// deterministic results file.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createAiDriver, SKILL_PROFILES, SPRINT_CONTROL, LAP_CONTROL, MAP_CONTROL,
  hashOf, aggregateHash, sha256Hex, stateIsFinite
} from './ai-driver.mjs';
import { deriveCarPhysics } from './car-physics.mjs';
import { buildRacingLine, createRacingLine, LINE_OPTIONS } from './racing-line.mjs';
import { createAiRacer, RACER_CONTROL, RACER_VERSION } from './race-controller.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/ai-driver');
const E1 = path.join(ROOT, '_work/e1-drive');
const MODULE = path.join(E1, 'module/e1_drive.mjs');
const BUILD = path.join(E1, 'module/build.json');
const LEVEL = path.join(E1, 'Level.levelphysics');
const CARS = path.join(E1, 'cars.json');

const LAYOUTS = {
  '310m': path.join(E1, 'sprint.json'),
  lap: path.join(E1, 'sprint-lap.json'),
  amboy: path.join(E1, 'amboy/layout.json'),
  gracia: path.join(E1, 'gracia/layout.json')
};

const POST_FINISH_TICKS = 120;
const MAX_RACE_TICKS = { '310m': 3600, lap: 7200, amboy: 14400, gracia: 7200 };
const round6 = (value) => Math.round(value * 1e6) / 1e6;

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const hasFlag = (name) => args.includes(name);
const list = (value) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : null);
const ONLY_CARS = list(option('--cars'));
const ONLY_PROFILES = list(option('--profiles'));
const ONLY_COURSES = list(option('--courses'));
const SKIP_REPLAY = hasFlag('--skip-replay');
const SKIP_BASELINE = hasFlag('--skip-baseline');
const SKIP_SCENARIOS = hasFlag('--skip-scenarios');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function layoutStart(layout) {
  return {
    x: layout.course.spawn.x,
    z: layout.course.spawn.z,
    heading: layout.gates[0].headingRad
  };
}

function createWorld(module, levelBytes, fieldBytes) {
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const createAt = (x, z, heading) => {
    const ok = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
      x, z, heading);
    if (!ok) throw new Error('e1_create failed: ' + module.UTF8ToString(module._e1_last_error()));
  };
  const read = () => JSON.parse(module.UTF8ToString(module._e1_get_state()));
  const step = () => {
    if (!module._e1_step()) {
      throw new Error('e1_step failed: ' + module.UTF8ToString(module._e1_last_error()));
    }
  };
  const setInput = (input) => module._e1_set_input(input[0], input[1], input[2], input[3]);
  return { module, createAt, read, step, setInput };
}

async function loadFactory() {
  return (await import(pathToFileURL(MODULE).href)).default;
}

function newMetrics() {
  return {
    runningTicks: 0,
    ticksWithAnyContact: 0,
    ticksWithAllFourContacts: 0,
    airborneTicks: 0,
    nanTicks: 0,
    maxLateralMetres: 0,
    maxSpeed: 0,
    minSpeed: 0,
    respawns: 0
  };
}

function mergeMetrics(metrics, state, projection, countLateral = true) {
  metrics.runningTicks += 1;
  const contacts = Array.isArray(state.contacts) ? state.contacts : [0, 0, 0, 0];
  if (contacts.some((contact) => contact)) metrics.ticksWithAnyContact += 1;
  if (contacts.every((contact) => contact)) metrics.ticksWithAllFourContacts += 1;
  if (contacts.every((contact) => !contact)) metrics.airborneTicks += 1;
  if (!stateIsFinite(state)) metrics.nanTicks += 1;
  if (countLateral && projection) {
    metrics.maxLateralMetres = Math.max(metrics.maxLateralMetres, projection.distance);
  }
  if (Number.isFinite(state.speed)) {
    metrics.maxSpeed = Math.max(metrics.maxSpeed, state.speed);
    metrics.minSpeed = Math.min(metrics.minSpeed, state.speed);
  }
}

async function createSim({ factory, levelBytes, fieldBytes, layout, profile, start, kind,
  line, physics }) {
  const module = await factory();
  const world = createWorld(module, levelBytes, fieldBytes);
  world.createAt(start.x, start.z, start.heading);
  let state = world.read();
  const driver = kind === 'baseline'
    ? createAiDriver({ layout, profile })
    : createAiRacer({ layout, line, physics, profile });
  driver.prime(state);
  return {
    module, world, driver, state, kind,
    hashes: [hashOf(state)],
    inputs: [],
    rebuilds: [],
    events: [],
    steps: 0,
    metrics: newMetrics()
  };
}

function countdownStep(sim, ticks) {
  for (let tick = 0; tick < ticks; tick++) {
    sim.world.setInput([0, 0, 0, 0]);
    sim.world.step();
    sim.state = sim.world.read();
    sim.steps += 1;
    sim.inputs.push([0, 0, 0, 0]);
    sim.hashes.push(hashOf(sim.state));
  }
}

function stepSim(sim, raceTick, input, observe = true) {
  const wasFinished = sim.driver.finished;
  sim.world.setInput(input);
  sim.world.step();
  sim.state = sim.world.read();
  sim.steps += 1;
  sim.inputs.push(input);
  sim.hashes.push(hashOf(sim.state));
  const events = observe ? sim.driver.observe(sim.state, raceTick) : [];
  if (observe) {
    mergeMetrics(sim.metrics, sim.state, sim.driver.projection, !wasFinished);
    sim.events.push(...events);
  }
  const respawn = events.find((event) => event.type === 'respawn');
  if (respawn) {
    sim.metrics.respawns += 1;
    const target = respawn.target;
    sim.world.createAt(target.x, target.z, target.headingRad);
    sim.state = sim.world.read();
    sim.driver.reprime(sim.state);
    sim.rebuilds.push({
      afterStep: sim.steps, tick: raceTick, reason: respawn.reasons, target
    });
  }
  return events;
}

async function runSolo({ factory, levelBytes, fieldBytes, car, layout, profile, kind,
  line, physics, opponents = null, start = null }) {
  const from = start ?? layoutStart(layout);
  const sim = await createSim({
    factory, levelBytes, fieldBytes, layout, profile, start: from, kind, line, physics
  });
  const countdownTicks = layout.countdown?.ticks ?? 0;
  countdownStep(sim, countdownTicks);
  const maxRaceTicks = MAX_RACE_TICKS[layout.courseId] ?? 7200;
  let raceTick = 0;
  let postFinish = 0;
  let status = 'dnf';
  let finishRecorded = false;
  let minOpponentSeparation = null;
  while (true) {
    if (!sim.driver.finished && raceTick >= maxRaceTicks) break;
    if (sim.driver.finished && postFinish >= POST_FINISH_TICKS) { status = 'finished'; break; }
    raceTick += 1;
    const ghosts = opponents ? opponents.atTick(raceTick, sim) : [];
    const terms = sim.driver.step(sim.state, { opponents: ghosts, raceTick });
    stepSim(sim, raceTick, terms.input);
    if (opponents) {
      const separation = opponents.minSeparation(sim.state);
      if (separation !== null) {
        minOpponentSeparation = minOpponentSeparation === null
          ? separation : Math.min(minOpponentSeparation, separation);
      }
    }
    if (sim.driver.finished) {
      if (!finishRecorded) { finishRecorded = true; status = 'finished'; } else postFinish += 1;
    }
  }
  return {
    car, profile: sim.driver.profile, courseId: layout.courseId, kind,
    layoutHash: layout.hash, start: from, status, countdownTicks,
    steps: sim.steps, raceTicks: raceTick,
    inputs: sim.inputs, rebuilds: sim.rebuilds, events: sim.events,
    metrics: sim.metrics,
    stateSequenceHash: aggregateHash(sim.hashes),
    tickHashes: sim.hashes,
    finish: sim.driver.finish,
    lapTimes: sim.driver.lapTimes.slice(),
    checkpointsPassed: sim.driver.checkpointsPassed,
    racer: kind === 'racing' ? sim.driver.snapshot() : null,
    minOpponentSeparationMetres: minOpponentSeparation
  };
}

async function replaySolo({ factory, levelBytes, fieldBytes, layout, start, inputs, rebuilds,
  expectedHashes }) {
  const module = await factory();
  const world = createWorld(module, levelBytes, fieldBytes);
  world.createAt(start.x, start.z, start.heading);
  let state = world.read();
  const hashes = [hashOf(state)];
  let matched = hashes[0] === expectedHashes[0];
  let firstMismatch = matched ? null : 0;
  const rebuildByStep = new Map(rebuilds.map((rebuild) => [rebuild.afterStep, rebuild]));
  for (let index = 0; index < inputs.length; index++) {
    const rebuild = rebuildByStep.get(index);
    if (rebuild) {
      world.createAt(rebuild.target.x, rebuild.target.z, rebuild.target.headingRad);
      state = world.read();
    }
    world.setInput(inputs[index]);
    world.step();
    state = world.read();
    const hash = hashOf(state);
    hashes.push(hash);
    if (matched && (index + 1 >= expectedHashes.length || hash !== expectedHashes[index + 1])) {
      matched = false;
      firstMismatch = index + 1;
    }
  }
  if (hashes.length !== expectedHashes.length) matched = false;
  return {
    matched, lengthMatch: hashes.length === expectedHashes.length, firstMismatch,
    statesCompared: Math.min(hashes.length, expectedHashes.length),
    stateSequenceHash: aggregateHash(hashes)
  };
}

function summarizeRun(run, replay) {
  const metrics = run.metrics;
  return {
    courseId: run.courseId,
    profile: run.profile.id,
    speedScale: run.profile.speedScale,
    car: run.car.slug,
    carName: run.car.name,
    status: run.status,
    finish: run.finish,
    lapTimes: run.lapTimes,
    checkpointsPassed: run.checkpointsPassed,
    raceTicks: run.raceTicks,
    timeSeconds: run.finish ? run.finish.timeSeconds : null,
    respawns: metrics.respawns,
    respawnEvents: run.rebuilds.map((rebuild) => ({
      afterStep: rebuild.afterStep, tick: rebuild.tick, reason: rebuild.reason,
      target: rebuild.target
    })),
    contacts: {
      ticksWithAnyContact: metrics.ticksWithAnyContact,
      ticksWithAllFourContacts: metrics.ticksWithAllFourContacts,
      airborneTicks: metrics.airborneTicks,
      runningTicks: metrics.runningTicks
    },
    nanTicks: metrics.nanTicks,
    maxLateralMetres: round6(metrics.maxLateralMetres),
    maxSpeed: round6(metrics.maxSpeed),
    minSpeed: round6(metrics.minSpeed),
    stateSequenceHash: run.stateSequenceHash,
    inputCount: run.inputs.length,
    inputHash: hashOf(run.inputs),
    racer: run.racer ? {
      mode: run.racer.mode,
      recoveries: run.racer.metrics.recoveries,
      overtakes: run.racer.metrics.overtakes,
      aborts: run.racer.metrics.aborts,
      lineHash: run.racer.lineHash
    } : null,
    minOpponentSeparationMetres: run.minOpponentSeparationMetres === null
      ? null : round6(run.minOpponentSeparationMetres),
    replay: replay ? {
      matchedEveryTick: replay.matched,
      lengthMatch: replay.lengthMatch,
      firstMismatch: replay.firstMismatch,
      statesCompared: replay.statesCompared,
      stateSequenceHash: replay.stateSequenceHash
    } : null,
    clean: run.status === 'finished' && metrics.respawns === 0 && metrics.nanTicks === 0 &&
      (!replay || replay.matched)
  };
}

// ---------------------------------------------------------------------------
// Ghost opponent for the overtake scenario.
//
// The probe has no car-to-car physics (`e1_drive_lib.cpp` sets
// `vehicleToVehicleCollisions = false`), so an opponent cannot push the ego.
// The ghost is a kinematic car that follows the same racing line at a lower
// skill scale. The scenario proves three things that *are* measurable:
//   * the planner detects it and picks a side with enough free width,
//   * the ego's actual driven path keeps a geometric separation of at least the
//     widest car envelope (2.276 m) from the ghost's path at every tick,
//   * the ego finishes ahead, with no respawn.
// It does not prove contact response, because this probe has no contact solver.
// ---------------------------------------------------------------------------

function createGhost({ line, startArc, speedScale, id }) {
  const arcHistory = [];
  return {
    id,
    startArc,
    speedScale,
    arc: startArc,
    speed: 0,
    position: null,
    atTick(raceTick, sim) {
      void sim;
      if (raceTick === 1) {
        this.speed = 0;
      }
      const targetSpeed = line.indexAt(this.arc + 2).targetSpeed * this.speedScale;
      const accel = Math.min(9, Math.max(-11, (targetSpeed - this.speed) * 4));
      this.speed = Math.max(0, this.speed + accel / 60);
      this.arc += this.speed / 60;
      const point = line.indexAt(this.arc);
      this.position = [point.x, 0, point.z];
      arcHistory.push([point.x, point.z, this.arc]);
      return [];
    },
    /** Opponent descriptor the controller consumes. */
    descriptor() {
      const point = this.position ? { x: this.position[0], z: this.position[2] } : null;
      if (!point) return null;
      return { id: this.id, arc: this.arc, speed: this.speed, offset: 0 };
    },
    minSeparation(state) {
      if (!this.position) return null;
      return Math.hypot(state.position[0] - this.position[0],
        state.position[2] - this.position[2]);
    },
    history: arcHistory
  };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

const build = readJson(BUILD);
const levelBytes = readFileSync(LEVEL);
const roster = readJson(CARS).roster;
const layouts = Object.fromEntries(Object.entries(LAYOUTS).map(([id, file]) => [id, readJson(file)]));

const allCars = roster.cars;
const cars = ONLY_CARS ? allCars.filter((car) => ONLY_CARS.includes(car.slug)) : allCars;
const profiles = ONLY_PROFILES
  ? SKILL_PROFILES.filter((profile) => ONLY_PROFILES.includes(profile.id))
  : SKILL_PROFILES;
const courses = ONLY_COURSES
  ? Object.keys(layouts).filter((courseId) => ONLY_COURSES.includes(courseId))
  : Object.keys(layouts);
if (cars.length === 0) throw new Error('no roster cars selected');
if (profiles.length === 0) throw new Error('no skill profiles selected');
if (courses.length === 0) throw new Error('no courses selected');

const fieldsBySlug = new Map();
const carBySlug = new Map();
const physicsBySlug = new Map();
for (const car of allCars) {
  const bytes = readFileSync(path.join(ROOT, car.fields.path));
  const hash = sha256Hex(bytes);
  if (hash !== car.fields.sha256) {
    throw new Error(`fields hash mismatch for ${car.slug}: ${hash} != ${car.fields.sha256}`);
  }
  fieldsBySlug.set(car.slug, bytes);
  carBySlug.set(car.slug, car);
  physicsBySlug.set(car.slug, deriveCarPhysics(bytes.toString('utf8'),
    { slug: car.slug, sourcePath: car.fields.path }));
}

const factory = await loadFactory();

// Racing lines are per (course, car): the profile scales speed, not the line.
const lineCache = new Map();
const lineDocs = [];
function lineFor(courseId, carSlug) {
  const key = `${courseId}|${carSlug}`;
  if (lineCache.has(key)) return lineCache.get(key);
  const layout = layouts[courseId];
  const physics = physicsBySlug.get(carSlug);
  const document = buildRacingLine({ layout, physics });
  const line = createRacingLine(document);
  lineCache.set(key, line);
  lineDocs.push({ courseId, car: carSlug, ...line.summary() });
  return line;
}

const racingRuns = [];
const baselineRuns = [];
const comparison = [];

for (const courseId of courses) {
  const layout = layouts[courseId];
  for (const car of cars) {
    const line = lineFor(courseId, car.slug);
    const fieldBytes = fieldsBySlug.get(car.slug);
    const physics = physicsBySlug.get(car.slug);
    for (const profile of profiles) {
      process.stdout.write(`[ai-racing] ${courseId}/${profile.id}/${car.slug}\n`);
      const run = await runSolo({
        factory, levelBytes, fieldBytes, car, layout, profile,
        kind: 'racing', line, physics
      });
      let replay = null;
      if (!SKIP_REPLAY) {
        replay = await replaySolo({
          factory, levelBytes, fieldBytes, layout, start: run.start,
          inputs: run.inputs, rebuilds: run.rebuilds, expectedHashes: run.tickHashes
        });
      }
      const summary = summarizeRun(run, replay);
      racingRuns.push(summary);
      process.stdout.write(
        `[ai-racing]   ${summary.status} t=${summary.timeSeconds ?? 'DNF'} ` +
        `resp=${summary.respawns} nan=${summary.nanTicks} lat=${summary.maxLateralMetres} ` +
        `vmax=${summary.maxSpeed} rec=${summary.racer.recoveries} ovt=${summary.racer.overtakes} ` +
        `replay=${replay ? replay.matched : 'skipped'}\n`);

      if (!SKIP_BASELINE) {
        const base = await runSolo({
          factory, levelBytes, fieldBytes, car, layout, profile, kind: 'baseline'
        });
        const baseSummary = summarizeRun(base, null);
        baselineRuns.push(baseSummary);
        const ours = summary.timeSeconds;
        const theirs = baseSummary.timeSeconds;
        comparison.push({
          courseId, car: car.slug, profile: profile.id,
          baselineSeconds: theirs,
          racingSeconds: ours,
          improvementSeconds: ours !== null && theirs !== null ? round6(theirs - ours) : null,
          improvementFraction: ours !== null && theirs !== null && theirs > 0
            ? round6((theirs - ours) / theirs) : null,
          baselineClean: baseSummary.clean,
          racingClean: summary.clean
        });
        process.stdout.write(
          `[ai-racing]   baseline ${baseSummary.status} t=${baseSummary.timeSeconds ?? 'DNF'} ` +
          `delta=${comparison[comparison.length - 1].improvementSeconds ?? 'n/a'}\n`);
        base.sim = null;
      }
      run.sim = null;
      run.tickHashes = null;
      run.inputs = null;
      run.rebuilds = null;
      run.events = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Overtake scenarios.
// ---------------------------------------------------------------------------

const scenarios = [];
if (!SKIP_SCENARIOS) {
  const scenarioDefinitions = [
    {
      name: 'sprint-overtake-corvette-vs-cautious-focus',
      courseId: '310m',
      ego: { car: 'corvette-zr1-stock', profile: 'reference' },
      ghost: { car: 'ford-focusrs-stock', speedScale: 0.55, startArc: 14 }
    },
    {
      name: 'loop-overtake-blocked-by-band',
      courseId: 'lap',
      ego: { car: 'corvette-zr1-stock', profile: 'reference' },
      ghost: { car: 'ford-focusrs-stock', speedScale: 0.5, startArc: 10 }
    }
  ];
  for (const definition of scenarioDefinitions) {
    const layout = layouts[definition.courseId];
    const car = carBySlug.get(definition.ego.car);
    const line = lineFor(definition.courseId, definition.ego.car);
    const ghost = createGhost({
      line, startArc: definition.ghost.startArc,
      speedScale: definition.ghost.speedScale, id: 'ghost'
    });
    const opponents = {
      atTick(raceTick, sim) {
        ghost.atTick(raceTick, sim);
        const descriptor = ghost.descriptor();
        return descriptor ? [descriptor] : [];
      },
      minSeparation(state) { return ghost.minSeparation(state); }
    };
    process.stdout.write(`[ai-racing] scenario ${definition.name}\n`);
    const run = await runSolo({
      factory, levelBytes, fieldBytes: fieldsBySlug.get(car.slug), car, layout,
      profile: definition.ego.profile, kind: 'racing', line,
      physics: physicsBySlug.get(car.slug), opponents
    });
    const summary = summarizeRun(run, null);
    const finishTick = run.finish ? run.finish.tick : null;
    const ghostFinishTick = ghost.arc >= line.length ? null : null;
    const clearance = RACER_CONTROL.default.overtake.clearanceMetres;
    scenarios.push({
      name: definition.name,
      courseId: definition.courseId,
      ego: definition.ego,
      ghost: definition.ghost,
      status: summary.status,
      timeSeconds: summary.timeSeconds,
      finishTick,
      respawns: summary.respawns,
      nanTicks: summary.nanTicks,
      maxLateralMetres: summary.maxLateralMetres,
      overtakes: summary.racer.overtakes,
      aborts: summary.racer.aborts,
      recoveries: summary.racer.recoveries,
      minOpponentSeparationMetres: summary.minOpponentSeparationMetres,
      clearanceMetres: clearance,
      noContact: summary.minOpponentSeparationMetres !== null &&
        summary.minOpponentSeparationMetres >= clearance,
      ghostArcMetres: round6(ghost.arc),
      egoAheadOfGhostArc: run.finish ? round6(line.indexAt(run.finish.arc).arc) > ghost.arc : null,
      ghostFinishTick,
      stateSequenceHash: summary.stateSequenceHash
    });
    process.stdout.write(
      `[ai-racing]   ${summary.status} t=${summary.timeSeconds ?? 'DNF'} ` +
      `ovt=${summary.racer.overtakes} abort=${summary.racer.aborts} ` +
      `minSep=${summary.minOpponentSeparationMetres} noContact=${scenarios[scenarios.length - 1].noContact}\n`);
    run.sim = null;
    run.tickHashes = null;
    run.inputs = null;
  }
}

// ---------------------------------------------------------------------------
// Summary and output.
// ---------------------------------------------------------------------------

function groupRuns(runs) {
  return courses.flatMap((courseId) => profiles.map((profile) => {
    const subset = runs.filter((run) => run.courseId === courseId && run.profile === profile.id);
    const finished = subset.filter((run) => run.status === 'finished');
    const clean = subset.filter((run) => run.clean);
    const times = finished.map((run) => run.timeSeconds).filter(Number.isFinite);
    const sorted = times.slice().sort((a, b) => a - b);
    const median = sorted.length === 0 ? null : sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : round6((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
    return {
      courseId,
      profile: profile.id,
      speedScale: profile.speedScale,
      runs: subset.length,
      finished: finished.length,
      clean: clean.length,
      respawns: subset.reduce((sum, run) => sum + run.respawns, 0),
      meanTimeSeconds: times.length ? round6(times.reduce((sum, value) => sum + value, 0) / times.length) : null,
      bestTimeSeconds: sorted.length ? sorted[0] : null,
      worstTimeSeconds: sorted.length ? sorted[sorted.length - 1] : null,
      medianTimeSeconds: median,
      minSpeedMetresPerSecond: subset.length
        ? round6(subset.reduce((min, run) => Math.min(min, run.minSpeed), Infinity)) : null,
      failed: subset.filter((run) => !run.clean).map((run) => ({
        car: run.car, status: run.status, respawns: run.respawns,
        nanTicks: run.nanTicks, replayMatched: run.replay?.matchedEveryTick ?? null
      }))
    };
  }));
}

function comparisonSummary() {
  const byCourse = {};
  for (const courseId of courses) {
    const rows = comparison.filter((row) => row.courseId === courseId &&
      Number.isFinite(row.baselineSeconds) && Number.isFinite(row.racingSeconds));
    const improvements = rows.map((row) => row.improvementSeconds);
    const fractions = rows.map((row) => row.improvementFraction);
    byCourse[courseId] = {
      pairs: rows.length,
      meanBaselineSeconds: rows.length
        ? round6(rows.reduce((sum, row) => sum + row.baselineSeconds, 0) / rows.length) : null,
      meanRacingSeconds: rows.length
        ? round6(rows.reduce((sum, row) => sum + row.racingSeconds, 0) / rows.length) : null,
      meanImprovementSeconds: improvements.length
        ? round6(improvements.reduce((sum, value) => sum + value, 0) / improvements.length) : null,
      meanImprovementFraction: fractions.length
        ? round6(fractions.reduce((sum, value) => sum + value, 0) / fractions.length) : null,
      minImprovementSeconds: improvements.length ? round6(Math.min(...improvements)) : null,
      maxImprovementSeconds: improvements.length ? round6(Math.max(...improvements)) : null
    };
  }
  return byCourse;
}

const results = {
  kind: 'blur.ai-racing-results',
  version: 1,
  driver: {
    racerVersion: RACER_VERSION,
    control: RACER_CONTROL,
    lineOptions: LINE_OPTIONS,
    profiles: SKILL_PROFILES,
    previousControl: { sprint: SPRINT_CONTROL, lap: LAP_CONTROL, measured: MAP_CONTROL }
  },
  inputs: {
    module: {
      path: path.relative(ROOT, MODULE).split(path.sep).join('/'),
      wasmSha256: build.wasmSha256,
      wasmBytes: build.wasmBytes,
      objects: build.objects
    },
    level: {
      path: path.relative(ROOT, LEVEL).split(path.sep).join('/'),
      bytes: levelBytes.length,
      sha256: sha256Hex(levelBytes)
    },
    roster: {
      path: path.relative(ROOT, CARS).split(path.sep).join('/'),
      cars: allCars.map((car) => ({
        slug: car.slug, name: car.name, drivetrain: car.drivetrain,
        fieldsPath: car.fields.path, fieldsSha256: car.fields.sha256
      }))
    },
    layouts: Object.fromEntries(courses.map((courseId) => [courseId, {
      file: path.relative(ROOT, LAYOUTS[courseId]).split(path.sep).join('/'),
      fileSha256: sha256Hex(readFileSync(LAYOUTS[courseId])),
      layoutHash: layouts[courseId].hash ?? null
    }]))
  },
  config: {
    postFinishTicks: POST_FINISH_TICKS,
    maxRaceTicks: MAX_RACE_TICKS,
    replayPerTick: !SKIP_REPLAY,
    baseline: !SKIP_BASELINE,
    selection: {
      cars: cars.map((car) => car.slug),
      profiles: profiles.map((profile) => profile.id),
      courses
    }
  },
  physics: Object.fromEntries(cars.map((car) => [car.slug, physicsBySlug.get(car.slug)])),
  lines: lineDocs,
  runs: racingRuns,
  baselineRuns,
  comparison,
  comparisonSummary: comparisonSummary(),
  groups: groupRuns(racingRuns),
  baselineGroups: SKIP_BASELINE ? [] : groupRuns(baselineRuns),
  scenarios,
  determinism: {
    perRunReplayRequested: !SKIP_REPLAY,
    perRunReplayAllMatch: SKIP_REPLAY ? null
      : racingRuns.every((run) => run.replay?.matchedEveryTick === true),
    perRunReplayStatesCompared: SKIP_REPLAY ? 0
      : racingRuns.reduce((sum, run) => sum + (run.replay?.statesCompared ?? 0), 0),
    resultHash: null
  }
};
results.determinism.resultHash = hashOf({
  runs: racingRuns.map((run) => ({
    courseId: run.courseId, car: run.car, profile: run.profile,
    stateSequenceHash: run.stateSequenceHash
  })),
  scenarios: scenarios.map((scenario) => ({
    name: scenario.name, stateSequenceHash: scenario.stateSequenceHash
  }))
});

const target = path.join(OUT, 'results-racing.json');
writeFileSync(target, JSON.stringify(results, null, 2) + '\n');
process.stdout.write(`[ai-racing] wrote ${path.relative(ROOT, target)} ` +
  `runs=${racingRuns.length} clean=${racingRuns.filter((run) => run.clean).length} ` +
  `finished=${racingRuns.filter((run) => run.status === 'finished').length}\n`);
