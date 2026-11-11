// AI opponent driver evidence run.
//
// Reads the committed drive artifacts read-only:
//
//   _work/e1-drive/module/e1_drive.mjs + .wasm
//   _work/e1-drive/Level.levelphysics
//   _work/e1-drive/cars.json and each roster car's .fields
//   _work/e1-drive/sprint.json, _work/e1-drive/sprint-lap.json
//   _work/e1-drive/sprint-<slug>.json, sprint-lap-<slug>.json  (committed times)
//
// Drives every roster car on the 310 m sprint and on the 222.040 m loop-01 with
// the standalone AI driver, replays each recorded input sequence into a fresh
// wasm instance and compares every per-tick state hash, then runs the multi-AI
// races. Writes `_work/ai-driver/results.json`; `verify.mjs` writes `verify.json`.
//
// Determinism: no Date, no performance.now, no Math.random, no wall clock in
// any recorded value. The same command produces a byte-identical results.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DRIVER_KIND, DRIVER_VERSION, SKILL_PROFILES, CONTROL_TABLES,
  SPRINT_CONTROL, LAP_CONTROL, createAiDriver, layoutSummary,
  hashOf, aggregateHash, sha256Hex, stateIsFinite
} from './ai-driver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/ai-driver');
const E1 = path.join(ROOT, '_work/e1-drive');
const MODULE = path.join(E1, 'module/e1_drive.mjs');
const WASM = path.join(E1, 'module/e1_drive.wasm');
const BUILD = path.join(E1, 'module/build.json');
const LEVEL = path.join(E1, 'Level.levelphysics');
const CARS = path.join(E1, 'cars.json');
const SPRINT_LAYOUT = path.join(E1, 'sprint.json');
const LAP_LAYOUT = path.join(E1, 'sprint-lap.json');

const POST_FINISH_TICKS = 120;
const MAX_RACE_TICKS = { '310m': 3600, lap: 7200 };
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
const SKIP_RACES = hasFlag('--skip-races');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function layoutStart(layout) {
  if (layout.courseId === 'lap') {
    return { x: layout.course.spawn.x, z: layout.course.spawn.z,
      heading: layout.gates[0].headingRad };
  }
  return { x: layout.course.spawn.x, z: layout.course.spawn.z,
    heading: layout.gates[0].headingRad };
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

async function createSim({ factory, levelBytes, fieldBytes, layout, profile, start }) {
  const module = await factory();
  const world = createWorld(module, levelBytes, fieldBytes);
  world.createAt(start.x, start.z, start.heading);
  let state = world.read();
  const driver = createAiDriver({ layout, profile });
  driver.prime(state);
  const sim = {
    module, world, driver, state,
    hashes: [hashOf(state)],
    inputs: [],
    rebuilds: [],
    events: [],
    steps: 0,
    metrics: newMetrics()
  };
  return sim;
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
      afterStep: sim.steps,
      tick: raceTick,
      reason: respawn.reasons,
      target
    });
  }
  return events;
}

async function runSolo({ factory, levelBytes, fieldBytes, car, layout, profile }) {
  const start = layoutStart(layout);
  const sim = await createSim({ factory, levelBytes, fieldBytes, layout, profile, start });
  const countdownTicks = layout.countdown?.ticks ?? 0;
  countdownStep(sim, countdownTicks);
  const maxRaceTicks = MAX_RACE_TICKS[layout.courseId] ?? 7200;
  let raceTick = 0;
  let postFinish = 0;
  let status = 'dnf';
  let finishRecorded = false;
  while (true) {
    if (!sim.driver.finished && raceTick >= maxRaceTicks) break;
    if (sim.driver.finished && postFinish >= POST_FINISH_TICKS) { status = 'finished'; break; }
    raceTick += 1;
    const terms = sim.driver.step(sim.state);
    stepSim(sim, raceTick, terms.input);
    if (sim.driver.finished) {
      if (!finishRecorded) { finishRecorded = true; status = 'finished'; }
      else postFinish += 1;
    }
  }
  return {
    car,
    profile: sim.driver.profile,
    courseId: layout.courseId,
    layoutHash: layout.hash,
    start,
    status,
    countdownTicks,
    steps: sim.steps,
    raceTicks: raceTick,
    inputs: sim.inputs,
    rebuilds: sim.rebuilds,
    events: sim.events,
    metrics: sim.metrics,
    stateSequenceHash: aggregateHash(sim.hashes),
    tickHashes: sim.hashes,
    finish: sim.driver.finish,
    lapTimes: sim.driver.lapTimes.slice(),
    checkpointsPassed: sim.driver.checkpointsPassed,
    sim
  };
}

async function replaySolo({ factory, levelBytes, fieldBytes, layout, start, inputs, rebuilds, expectedHashes }) {
  const module = await factory();
  const world = createWorld(module, levelBytes, fieldBytes);
  world.createAt(start.x, start.z, start.heading);
  let state = world.read();
  const hashes = [hashOf(state)];
  let matched = hashes[0] === expectedHashes[0];
  let firstMismatch = matched ? null : 0;
  const rebuildByStep = new Map(rebuilds.map((rebuild) => [rebuild.afterStep, rebuild]));
  for (let index = 0; index < inputs.length; index++) {
    // A rebuild observed after `index` steps is applied before the next input.
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
  const lengthMatch = hashes.length === expectedHashes.length;
  if (!lengthMatch) matched = false;
  return {
    matched,
    lengthMatch,
    firstMismatch,
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
// Multi-AI race: one wasm instance per AI, stepped in lockstep.
// ---------------------------------------------------------------------------

async function runRace({ factory, levelBytes, fieldsBySlug, carBySlug, layout, entries, name }) {
  const start = layoutStart(layout);
  const countdownTicks = layout.countdown?.ticks ?? 0;
  const sims = [];
  for (const entry of entries) {
    const car = carBySlug.get(entry.car);
    if (!car) throw new Error('race entry has no car ' + entry.car);
    const fieldBytes = fieldsBySlug.get(entry.car);
    const sim = await createSim({
      factory, levelBytes, fieldBytes, layout, profile: entry.profile, start
    });
    sims.push({ entry, car, sim, finishTick: null, status: 'running' });
  }
  for (const slot of sims) countdownStep(slot.sim, countdownTicks);

  const maxRaceTicks = MAX_RACE_TICKS[layout.courseId] ?? 7200;
  let raceTick = 0;
  while (true) {
    const active = sims.filter((slot) => !slot.sim.driver.finished);
    if (active.length === 0) break;
    if (raceTick >= maxRaceTicks) break;
    raceTick += 1;
    for (const slot of active) {
      const terms = slot.sim.driver.step(slot.sim.state);
      stepSim(slot.sim, raceTick, terms.input);
      if (slot.sim.driver.finished) {
        slot.finishTick = slot.sim.driver.finish.tick;
        slot.status = 'finished';
      }
    }
  }
  const rows = sims.map((slot) => ({
    car: slot.car.slug,
    carName: slot.car.name,
    profile: slot.sim.driver.profile.id,
    speedScale: slot.sim.driver.profile.speedScale,
    status: slot.status,
    finishTick: slot.finishTick,
    timeSeconds: slot.sim.driver.finish?.timeSeconds ?? null,
    lapTimes: slot.sim.driver.lapTimes.slice(),
    respawns: slot.sim.metrics.respawns,
    nanTicks: slot.sim.metrics.nanTicks,
    maxLateralMetres: round6(slot.sim.metrics.maxLateralMetres),
    stateSequenceHash: aggregateHash(slot.sim.hashes),
    inputs: slot.sim.inputs,
    rebuilds: slot.sim.rebuilds
  }));
  rows.sort((a, b) => {
    if (a.finishTick === null && b.finishTick === null) return a.car < b.car ? -1 : a.car > b.car ? 1 : 0;
    if (a.finishTick === null) return 1;
    if (b.finishTick === null) return -1;
    if (a.finishTick !== b.finishTick) return a.finishTick - b.finishTick;
    return a.car < b.car ? -1 : a.car > b.car ? 1 : 0;
  });
  rows.forEach((row, index) => { row.position = index + 1; });
  const raceHash = hashOf({
    name,
    courseId: layout.courseId,
    entries: rows.map((row) => ({
      car: row.car, profile: row.profile, finishTick: row.finishTick,
      stateSequenceHash: row.stateSequenceHash
    }))
  });
  // The per-car inputs are kept for a replay proof; strip them from the public
  // summary but retain them for the caller.
  const replayInputs = rows.map((row, index) => ({
    car: row.car,
    inputs: row.inputs,
    rebuilds: row.rebuilds,
    tickHashes: sims.find((slot) => slot.car.slug === row.car).sim.hashes.slice(),
    start
  }));
  return { name, raceHash, rows, replayInputs, raceTicks: raceTick, layout, sims };
}

async function replayRace({ factory, levelBytes, fieldsBySlug, layout, replayInputs, expectedRows }) {
  const start = replayInputs[0]?.start ?? layoutStart(layout);
  const checks = [];
  for (let index = 0; index < replayInputs.length; index++) {
    const entry = replayInputs[index];
    const expected = expectedRows.find((row) => row.car === entry.car);
    if (!expected) {
      checks.push({ car: entry.car, matchedEveryTick: false, reason: 'no expected row' });
      continue;
    }
    const module = await factory();
    const world = createWorld(module, levelBytes, fieldsBySlug.get(entry.car));
    world.createAt(start.x, start.z, start.heading);
    let state = world.read();
    const hashes = [hashOf(state)];
    const expectedHashes = entry.tickHashes;
    let matched = hashes[0] === expectedHashes[0];
    let firstMismatch = matched ? null : 0;
    const rebuildByStep = new Map(entry.rebuilds.map((rebuild) => [rebuild.afterStep, rebuild]));
    for (let step = 0; step < entry.inputs.length; step++) {
      const rebuild = rebuildByStep.get(step);
      if (rebuild) {
        world.createAt(rebuild.target.x, rebuild.target.z, rebuild.target.headingRad);
        state = world.read();
      }
      world.setInput(entry.inputs[step]);
      world.step();
      state = world.read();
      const hash = hashOf(state);
      hashes.push(hash);
      if (matched && (step + 1 >= expectedHashes.length || hash !== expectedHashes[step + 1])) {
        matched = false;
        firstMismatch = step + 1;
      }
    }
    if (hashes.length !== expectedHashes.length) matched = false;
    const aggregate = aggregateHash(hashes);
    if (aggregate !== expected.stateSequenceHash) matched = false;
    checks.push({
      car: entry.car,
      matchedEveryTick: matched,
      firstMismatch,
      statesCompared: Math.min(hashes.length, expectedHashes.length),
      stateSequenceHash: aggregate,
      expectedStateSequenceHash: expected.stateSequenceHash
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Committed follower comparison.
// ---------------------------------------------------------------------------

function committedTimes(car) {
  const result = { sprint: null, lap: null };
  const sprintPath = path.join(E1, `sprint-${car.slug}.json`);
  const lapPath = path.join(E1, `sprint-lap-${car.slug}.json`);
  try {
    const sprint = readJson(sprintPath);
    result.sprint = sprint.finish ? {
      timeSeconds: sprint.finish.timeSeconds,
      tick: sprint.finish.tick,
      stateSequenceHash: sprint.stateSequenceHash,
      // The committed follower was driven on a specific layout; a row from a
      // different layout describes a road that no longer ships and must not be
      // compared as if it were current.
      layoutHash: sprint.layoutHash ?? null,
      source: path.relative(ROOT, sprintPath).split(path.sep).join('/')
    } : null;
  } catch { /* missing committed run is reported by verify */ }
  try {
    const lap = readJson(lapPath);
    result.lap = lap.finish ? {
      timeSeconds: lap.finish.timeSeconds,
      layoutHash: lap.layoutHash ?? null,
      tick: lap.finish.tick,
      lapTimes: lap.finish.lapTimes ?? lap.lapTimes ?? null,
      stateSequenceHash: lap.stateSequenceHash,
      source: path.relative(ROOT, lapPath).split(path.sep).join('/')
    } : null;
  } catch { /* missing committed run is reported by verify */ }
  return result;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

const build = readJson(BUILD);
const levelBytes = readFileSync(LEVEL);
const roster = readJson(CARS).roster;
const sprintLayout = readJson(SPRINT_LAYOUT);
const lapLayout = readJson(LAP_LAYOUT);
const layouts = { '310m': sprintLayout, lap: lapLayout };

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
for (const car of allCars) {
  const bytes = readFileSync(path.join(ROOT, car.fields.path));
  const hash = sha256Hex(bytes);
  if (hash !== car.fields.sha256) {
    throw new Error(`fields hash mismatch for ${car.slug}: ${hash} != ${car.fields.sha256}`);
  }
  fieldsBySlug.set(car.slug, bytes);
  carBySlug.set(car.slug, car);
}

const factory = await loadFactory();
const runSummaries = [];
const committedComparison = [];

for (const courseId of courses) {
  const layout = layouts[courseId];
  for (const profile of profiles) {
    for (const car of cars) {
      const fieldBytes = fieldsBySlug.get(car.slug);
      const started = `run ${courseId}/${profile.id}/${car.slug}`;
      process.stdout.write(`[ai-driver] ${started}\n`);
      const run = await runSolo({ factory, levelBytes, fieldBytes, car, layout, profile });
      let replay = null;
      if (!SKIP_REPLAY) {
        replay = await replaySolo({
          factory, levelBytes, fieldBytes, layout, start: run.start,
          inputs: run.inputs, rebuilds: run.rebuilds, expectedHashes: run.tickHashes
        });
      }
      const summary = summarizeRun(run, replay);
      runSummaries.push(summary);
      process.stdout.write(
        `[ai-driver]   ${summary.status} time=${summary.timeSeconds ?? 'DNF'} ` +
        `respawns=${summary.respawns} nan=${summary.nanTicks} lateral=${summary.maxLateralMetres} ` +
        `replay=${replay ? replay.matched : 'skipped'} hash=${summary.stateSequenceHash.slice(0, 19)}\n`);
      run.sim = null;
      run.tickHashes = null;
      run.inputs = null;
      run.rebuilds = null;
      run.events = null;
    }
  }
}

// Committed follower comparison, reference profile only.
for (const car of cars) {
  const committed = committedTimes(car);
  for (const courseId of courses) {
    const ours = runSummaries.find((run) =>
      run.courseId === courseId && run.profile === 'reference' && run.car === car.slug);
    const committedValue = committed[courseId === '310m' ? 'sprint' : 'lap'];
    const oursValue = ours?.timeSeconds ?? null;
    committedComparison.push({
      car: car.slug,
      courseId,
      committed: committedValue,
      staleLayout: Boolean(committedValue?.layoutHash) &&
        committedValue.layoutHash !== layouts[courseId].hash,
      ai: ours ? {
        status: ours.status,
        timeSeconds: oursValue,
        stateSequenceHash: ours.stateSequenceHash
      } : null,
      differenceSeconds: oursValue !== null && committedValue
        ? round6(oursValue - committedValue.timeSeconds)
        : null
    });
  }
}

// Profile summary. A profile is clean only if every selected car/course finishes
// with 0 respawns, 0 NaN and a matching per-tick replay.
const profileSummary = profiles.map((profile) => {
  const runs = runSummaries.filter((run) => run.profile === profile.id);
  const finished = runs.filter((run) => run.status === 'finished');
  const clean = runs.filter((run) => run.clean);
  const times = finished.map((run) => run.timeSeconds).filter((value) => Number.isFinite(value));
  return {
    id: profile.id,
    speedScale: profile.speedScale,
    status: profile.status,
    runs: runs.length,
    finished: finished.length,
    clean: clean.length,
    failed: runs.filter((run) => !run.clean).map((run) => ({
      courseId: run.courseId, car: run.car, status: run.status,
      respawns: run.respawns, nanTicks: run.nanTicks,
      replayMatched: run.replay?.matchedEveryTick ?? null
    })),
    meanTimeSeconds: times.length
      ? round6(times.reduce((sum, value) => sum + value, 0) / times.length)
      : null,
    byCourse: Object.fromEntries(courses.map((courseId) => {
      const courseRuns = runs.filter((run) => run.courseId === courseId);
      return [courseId, {
        runs: courseRuns.length,
        finished: courseRuns.filter((run) => run.status === 'finished').length,
        clean: courseRuns.filter((run) => run.clean).length,
        meanTimeSeconds: courseRuns.filter((run) => run.status === 'finished').length
          ? round6(courseRuns.filter((run) => run.status === 'finished')
            .reduce((sum, run) => sum + run.timeSeconds, 0) /
            courseRuns.filter((run) => run.status === 'finished').length)
          : null
      }];
    }))
  };
});

// ---------------------------------------------------------------------------
// Multi-AI races, each run twice in fresh module instances.
// ---------------------------------------------------------------------------

const races = [];
if (!SKIP_RACES) {
  const raceDefinitions = [
    {
      name: 'sprint-4ai',
      courseId: '310m',
      entries: [
        { car: 'corvette-zr1-stock', profile: 'reference' },
        { car: 'lotus-exige-cup260-stock', profile: 'standard' },
        { car: 'dodge-challenger-stock', profile: 'cautious' },
        { car: 'audi-r8v10-stock', profile: 'reference' }
      ]
    },
    {
      name: 'lap-3ai',
      courseId: 'lap',
      entries: [
        { car: 'corvette-zr1-stock', profile: 'reference' },
        { car: 'lotus-exige-cup260-stock', profile: 'standard' },
        { car: 'audi-r8v10-stock', profile: 'cautious' }
      ]
    }
  ];
  for (const definition of raceDefinitions) {
    const layout = layouts[definition.courseId];
    const available = definition.entries.filter((entry) => carBySlug.has(entry.car));
    if (available.length < 2) {
      races.push({ name: definition.name, skipped: 'fewer than two cars available' });
      continue;
    }
    process.stdout.write(`[ai-driver] race ${definition.name}\n`);
    const first = await runRace({
      factory, levelBytes, fieldsBySlug, carBySlug, layout, entries: available,
      name: definition.name
    });
    const second = await runRace({
      factory, levelBytes, fieldsBySlug, carBySlug, layout, entries: available,
      name: definition.name
    });
    const replayChecks = await replayRace({
      factory, levelBytes, fieldsBySlug, layout,
      replayInputs: first.replayInputs, expectedRows: first.rows
    });
    const orderA = first.rows.map((row) => `${row.position}:${row.car}:${row.finishTick}`);
    const orderB = second.rows.map((row) => `${row.position}:${row.car}:${row.finishTick}`);
    races.push({
      name: definition.name,
      courseId: definition.courseId,
      entries: first.rows.map((row) => ({
        position: row.position,
        car: row.car,
        carName: row.carName,
        profile: row.profile,
        speedScale: row.speedScale,
        status: row.status,
        finishTick: row.finishTick,
        timeSeconds: row.timeSeconds,
        lapTimes: row.lapTimes,
        respawns: row.respawns,
        nanTicks: row.nanTicks,
        maxLateralMetres: row.maxLateralMetres,
        stateSequenceHash: row.stateSequenceHash
      })),
      order: first.rows.map((row) => row.car),
      raceHash: first.raceHash,
      secondRunRaceHash: second.raceHash,
      deterministic: first.raceHash === second.raceHash && orderA.join('|') === orderB.join('|'),
      replay: replayChecks,
      replayMatchedEveryTick: replayChecks.every((check) => check.matchedEveryTick)
    });
    process.stdout.write(
      `[ai-driver]   order ${first.rows.map((row) => `${row.position}.${row.car}(${row.timeSeconds ?? 'DNF'})`).join(' ')} ` +
      `deterministic=${races[races.length - 1].deterministic} replay=${races[races.length - 1].replayMatchedEveryTick}\n`);
    first.sims = null;
    second.sims = null;
  }
}

const results = {
  kind: 'blur.ai-driver-results',
  version: 1,
  driver: {
    kind: DRIVER_KIND,
    version: DRIVER_VERSION,
    controlTables: CONTROL_TABLES,
    profiles: SKILL_PROFILES
  },
  inputs: {
    module: {
      path: path.relative(ROOT, MODULE).split(path.sep).join('/'),
      wasmSha256: build.wasmSha256,
      wasmBytes: build.wasmBytes,
      buildDeterministic: build.buildDeterministic,
      objects: build.objects
    },
    level: {
      path: path.relative(ROOT, LEVEL).split(path.sep).join('/'),
      bytes: levelBytes.length,
      sha256: sha256Hex(levelBytes)
    },
    roster: {
      path: path.relative(ROOT, CARS).split(path.sep).join('/'),
      selected: allCars.length,
      cars: allCars.map((car) => ({
        slug: car.slug, name: car.name, drivetrain: car.drivetrain,
        fieldsPath: car.fields.path, fieldsSha256: car.fields.sha256
      }))
    },
    layouts: {
      '310m': { summary: layoutSummary(sprintLayout),
        fileSha256: sha256Hex(readFileSync(SPRINT_LAYOUT)) },
      lap: { summary: layoutSummary(lapLayout),
        fileSha256: sha256Hex(readFileSync(LAP_LAYOUT)) }
    }
  },
  config: {
    postFinishTicks: POST_FINISH_TICKS,
    maxRaceTicks: MAX_RACE_TICKS,
    replayPerTick: !SKIP_REPLAY,
    races: !SKIP_RACES,
    selection: {
      cars: cars.map((car) => car.slug),
      profiles: profiles.map((profile) => profile.id),
      courses
    }
  },
  runs: runSummaries,
  committedComparison,
  profileSummary,
  races,
  determinism: {
    perRunReplayRequested: !SKIP_REPLAY,
    perRunReplayAllMatch: SKIP_REPLAY ? null :
      runSummaries.every((run) => run.replay?.matchedEveryTick === true),
    perRunReplayStatesCompared: SKIP_REPLAY ? 0 :
      runSummaries.reduce((sum, run) => sum + (run.replay?.statesCompared ?? 0), 0),
    racesDeterministic: SKIP_RACES ? null : races.every((race) => race.deterministic === true),
    racesReplayMatched: SKIP_RACES ? null : races.every((race) => race.replayMatchedEveryTick === true),
    raceReplayStatesCompared: SKIP_RACES ? 0 : races.reduce((sum, race) =>
      sum + (race.replay ?? []).reduce((inner, check) => inner + (check.statesCompared ?? 0), 0), 0)
  }
};

// Rotate the previous result so `verify.mjs` can compare two consecutive
// process-separated runs (V25). A stale file from an older roster would make
// the comparison meaningless.
try {
  const current = readFileSync(path.join(OUT, 'results.json'));
  writeFileSync(path.join(OUT, 'results.previous.json'), current);
} catch {
  // First run: there is nothing to rotate.
}
writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2) + '\n');
process.stdout.write(`[ai-driver] wrote ${path.relative(ROOT, path.join(OUT, 'results.json'))}\n`);
process.stdout.write(`[ai-driver] runs=${runSummaries.length} clean=${runSummaries.filter((run) => run.clean).length} ` +
  `finished=${runSummaries.filter((run) => run.status === 'finished').length}\n`);
