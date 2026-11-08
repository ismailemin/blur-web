// AI driver evidence run for the measured point-to-point maps.
//
//   amboy        usa_amboy            2,060.595 m
//   gracia       spa_barcelona_gracia   624.914 m
//   longbeach    usa_la_longbeachdocks  785.823 m
//   observatory  usa_la_observatory     536.622 m
//   downtown     usa_la_downtown        153.861 m
//   mharuna      jpn_mharuna            309.170 m
//
// Reads read-only:
//
//   _work/e1-drive/module/e1_drive.mjs + .wasm + build.json
//   _work/e1-drive/cars.json and every roster car's .fields   (57 cars)
//   _work/e1-drive/<map>/layout.json                          (E1 layout)
//   probes/map-laps/data/<map>-path.json                      (committed path)
//   game-data/Blur/levels/<level>/Level.levelphysics
//   _work/e1-drive/map-<map>-run.json                         (committed follower)
//
// Drives every roster car on every measured path with the reference and
// standard skill profiles on the real wasm, replays every recorded input
// sequence into a fresh wasm instance comparing every per-tick state hash,
// runs 4-AI races on every map twice in fresh instance sets, and writes
// `_work/ai-driver/results-maps.json`.
//
// The ground probe column is centred on the layout's measured
// `course.spawnGroundY` through `_e1_set_ground_hint` before `_e1_create` when
// the spawn is outside the fixed Y -170..130 column. Mount Haruna spawns at
// Y 1064; without the hint `e1_create` reports "no ground". A spawn inside the
// column keeps the committed fixed-column result bit for bit.
//
// Determinism: no Date, no performance.now, no Math.random and no wall clock in
// any recorded value. Two process-separated runs produce byte-identical JSON
// (the verifier compares the file hashes).
//
// This probe does not modify e1-drive, race-rules, net-mvp, powerups,
// map-slice, tools, upstream or game-data.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DRIVER_KIND, DRIVER_VERSION, SKILL_PROFILES, MAP_CONTROL,
  createAiDriver, layoutSummary, hashOf, aggregateHash, sha256Hex, stateIsFinite
} from './ai-driver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/ai-driver');
const E1 = path.join(ROOT, '_work/e1-drive');
const MODULE = path.join(E1, 'module/e1_drive.mjs');
const BUILD = path.join(E1, 'module/build.json');
const MAP_IDS = ['amboy', 'gracia', 'longbeach', 'observatory', 'downtown', 'mharuna'];
const POST_FINISH_TICKS = 120;

// `maxRaceTicks` is a DNF bound, not a speed target: it is roughly twice the
// committed follower's finish tick so a slow-but-driving car is not cut off.
const MAPS = {
  amboy: {
    layoutPath: path.join(E1, 'amboy/layout.json'),
    committedPathPath: null,
    levelPath: path.join(ROOT, 'game-data/Blur/levels/usa_amboy/Level.levelphysics'),
    maxRaceTicks: 20000,
    committedRunPath: path.join(E1, 'map-amboy-run.json')
  },
  gracia: {
    layoutPath: path.join(E1, 'gracia/layout.json'),
    committedPathPath: null,
    levelPath: path.join(ROOT, 'game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics'),
    maxRaceTicks: 6000,
    committedRunPath: path.join(E1, 'map-gracia-run.json')
  },
  longbeach: {
    layoutPath: path.join(E1, 'longbeach/layout.json'),
    committedPathPath: path.join(ROOT, 'probes/map-laps/data/longbeach-path.json'),
    levelPath: path.join(ROOT, 'game-data/Blur/levels/usa_la_longbeachdocks/Level.levelphysics'),
    maxRaceTicks: 12000,
    committedRunPath: path.join(E1, 'map-longbeach-run.json')
  },
  observatory: {
    layoutPath: path.join(E1, 'observatory/layout.json'),
    committedPathPath: path.join(ROOT, 'probes/map-laps/data/observatory-path.json'),
    levelPath: path.join(ROOT, 'game-data/Blur/levels/usa_la_observatory/Level.levelphysics'),
    maxRaceTicks: 8000,
    committedRunPath: path.join(E1, 'map-observatory-run.json')
  },
  downtown: {
    layoutPath: path.join(E1, 'downtown/layout.json'),
    committedPathPath: path.join(ROOT, 'probes/map-laps/data/downtown-path.json'),
    levelPath: path.join(ROOT, 'game-data/Blur/levels/usa_la_downtown/Level.levelphysics'),
    maxRaceTicks: 4000,
    committedRunPath: path.join(E1, 'map-downtown-run.json')
  },
  mharuna: {
    layoutPath: path.join(E1, 'mharuna/layout.json'),
    committedPathPath: path.join(ROOT, 'probes/map-laps/data/mharuna-path.json'),
    levelPath: path.join(ROOT, 'game-data/Blur/levels/jpn_mharuna/Level.levelphysics'),
    maxRaceTicks: 6000,
    committedRunPath: path.join(E1, 'map-mharuna-run.json')
  }
};

const round6 = (value) => Math.round(value * 1e6) / 1e6;

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const hasFlag = (name) => args.includes(name);
const list = (value) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : null);
// `--roster` pins the car roster document (default `_work/e1-drive/cars.json`).
// A pinned snapshot keeps two process-separated runs comparable while another
// task edits the shared roster.
const ROSTER = path.resolve(ROOT, option('--roster', path.join(E1, 'cars.json')));
const ONLY_CARS = list(option('--cars'));
const ONLY_PROFILES = list(option('--profiles'));
const ONLY_MAPS = list(option('--maps'));
const SKIP_REPLAY = hasFlag('--skip-replay');
const SKIP_RACES = hasFlag('--skip-races');
// `committed` uses the committed AMBOY_CONTROL min-speed floor unchanged.
// `tuned` lowers only the Amboy floor to 3.5 m/s (the measured 6.06 m minimum
// radius needs ~3.9 m/s); Gracia keeps the committed control.
const CONTROL_MODE = option('--control', 'tuned');
if (CONTROL_MODE !== 'committed' && CONTROL_MODE !== 'tuned') {
  throw new Error('--control must be committed or tuned');
}
const AMBOY_TUNED_MIN_SPEED = 3.5;
const controlOverridesFor = (mapId) =>
  CONTROL_MODE === 'tuned' && mapId === 'amboy'
    ? { minSpeed: AMBOY_TUNED_MIN_SPEED }
    : null;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// The engine's ground probe column is fixed at Y -170..130 unless the page
// supplies the measured spawn ground. `e1_set_ground_hint` must run before
// `e1_create`; a layout without `spawnGroundY` is a hard error, never a guess.
//
// The hint is applied only when the spawn ground is outside that fixed column
// (Mount Haruna at Y 1064). For a spawn inside the column the committed
// fixed-column result is preserved bit for bit, which is what the committed
// Amboy/Gracia follower runs were recorded with. The decision and its reason
// are recorded per map; nothing is inferred at run time.
const FIXED_PROBE_MIN_Y = -170;
const FIXED_PROBE_MAX_Y = 130;
function groundHintFor(layout) {
  const value = layout.course?.spawnGroundY;
  if (!Number.isFinite(value)) {
    throw new Error(`layout ${layout.courseId} has no finite course.spawnGroundY`);
  }
  const applied = value < FIXED_PROBE_MIN_Y || value > FIXED_PROBE_MAX_Y;
  return {
    value,
    applied,
    reason: applied
      ? 'spawn-ground-outside-fixed-probe-column'
      : 'spawn-ground-inside-fixed-probe-column'
  };
}

function createWorld(module, levelBytes, fieldBytes, x, z, heading, groundHint) {
  if (!groundHint || !Number.isFinite(groundHint.value)) {
    throw new Error('createWorld needs a ground hint with a finite value');
  }
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  module._e1_set_ground_hint(groundHint.applied ? groundHint.value : -1.0e30);
  if (!module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length, x, z, heading)) {
    throw new Error('e1_create failed: ' + module.UTF8ToString(module._e1_last_error()));
  }
  return JSON.parse(module.UTF8ToString(module._e1_get_state()));
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
    maxArcMetres: 0,
    finalArcMetres: 0,
    maxSpeed: 0,
    minSpeed: Infinity,
    respawns: 0
  };
}

// `countContacts` is false after the finish: the 120 post-finish brake ticks
// are not part of the driven run. A finish-line crest can keep the car
// airborne while it brakes, and that must not be reported as a driving contact
// gap. NaN ticks are counted in every phase.
function mergeMetrics(metrics, state, projection, countLateral = true, countContacts = true) {
  const contacts = Array.isArray(state.contacts) ? state.contacts : [0, 0, 0, 0];
  if (countContacts) {
    metrics.runningTicks += 1;
    if (contacts.some((contact) => contact)) metrics.ticksWithAnyContact += 1;
    if (contacts.every((contact) => contact)) metrics.ticksWithAllFourContacts += 1;
    if (contacts.every((contact) => !contact)) metrics.airborneTicks += 1;
  }
  if (!stateIsFinite(state)) metrics.nanTicks += 1;
  if (projection) {
    metrics.maxArcMetres = Math.max(metrics.maxArcMetres, projection.arc);
    metrics.finalArcMetres = projection.arc;
    if (countLateral) {
      metrics.maxLateralMetres = Math.max(metrics.maxLateralMetres, projection.distance);
    }
  }
  if (Number.isFinite(state.speed)) {
    metrics.maxSpeed = Math.max(metrics.maxSpeed, state.speed);
    metrics.minSpeed = Math.min(metrics.minSpeed, state.speed);
  }
}

function mapStart(layout) {
  return {
    x: layout.course.spawn.x,
    z: layout.course.spawn.z,
    heading: layout.gates[0].headingRad
  };
}

async function createSim({ factory, levelBytes, fieldBytes, layout, profile, controlOverrides = null }) {
  const module = await factory();
  const start = mapStart(layout);
  const groundHint = groundHintFor(layout);
  let state = createWorld(module, levelBytes, fieldBytes, start.x, start.z, start.heading, groundHint);
  const driver = createAiDriver({ layout, profile, controlOverrides });
  driver.prime(state);
  return {
    module,
    state,
    driver,
    start,
    groundHint,
    hashes: [hashOf(state)],
    inputs: [],
    rebuilds: [],
    events: [],
    steps: 0,
    finishHashIndex: null,
    metrics: newMetrics()
  };
}

function countdownStep(sim, ticks) {
  for (let tick = 0; tick < ticks; tick++) {
    sim.module._e1_set_input(0, 0, 0, 0);
    sim.module._e1_step();
    sim.state = JSON.parse(sim.module.UTF8ToString(sim.module._e1_get_state()));
    sim.steps += 1;
    sim.inputs.push([0, 0, 0, 0]);
    sim.hashes.push(hashOf(sim.state));
  }
}

function stepSim(sim, raceTick, input, observe = true) {
  const wasFinished = sim.driver.finished;
  sim.module._e1_set_input(input[0], input[1], input[2], input[3]);
  sim.module._e1_step();
  sim.state = JSON.parse(sim.module.UTF8ToString(sim.module._e1_get_state()));
  sim.steps += 1;
  sim.inputs.push(input);
  sim.hashes.push(hashOf(sim.state));
  const events = observe ? sim.driver.observe(sim.state, raceTick) : [];
  if (observe) {
    mergeMetrics(sim.metrics, sim.state, sim.driver.projection, !wasFinished, !wasFinished);
    sim.events.push(...events);
    if (sim.driver.finished && sim.finishHashIndex === null) sim.finishHashIndex = sim.hashes.length - 1;
  }
  const respawn = events.find((event) => event.type === 'respawn');
  if (respawn) {
    sim.metrics.respawns += 1;
    const target = respawn.target;
    const levelBytes = sim.levelBytes;
    const fieldBytes = sim.fieldBytes;
    sim.state = createWorld(sim.module, levelBytes, fieldBytes, target.x, target.z,
      target.headingRad, sim.groundHint);
    sim.hashes[sim.hashes.length - 1] = hashOf(sim.state);
    sim.driver.reprime(sim.state);
    sim.rebuilds.push({
      afterStep: sim.steps,
      tick: raceTick,
      reason: respawn.reasons,
      observed: respawn.observed ?? null,
      target
    });
  }
  return events;
}

async function runSolo({ factory, levelBytes, fieldBytes, car, layout, profile, mapId, controlOverrides }) {
  const sim = await createSim({
    factory, levelBytes, fieldBytes, layout, profile,
    controlOverrides: controlOverrides === undefined ? controlOverridesFor(mapId) : controlOverrides
  });
  sim.levelBytes = levelBytes;
  sim.fieldBytes = fieldBytes;
  const countdownTicks = layout.countdown?.ticks ?? 0;
  countdownStep(sim, countdownTicks);
  const maxRaceTicks = MAPS[mapId].maxRaceTicks;
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
      if (!finishRecorded) finishRecorded = true;
      else postFinish += 1;
    }
  }
  const finishHashIndex = sim.finishHashIndex ?? sim.hashes.length - 1;
  return {
    car,
    profile: sim.driver.profile,
    courseId: layout.courseId,
    mapId,
    layoutHash: layout.hash,
    start: sim.start,
    groundHint: sim.groundHint,
    finishArc: layout.course?.span?.finishArc ?? layout.course?.finishArc ?? null,
    status,
    countdownTicks,
    steps: sim.steps,
    raceTicks: raceTick,
    inputs: sim.inputs,
    rebuilds: sim.rebuilds,
    events: sim.events,
    metrics: sim.metrics,
    stateSequenceHash: aggregateHash(sim.hashes),
    finishStateSequenceHash: aggregateHash(sim.hashes.slice(0, finishHashIndex + 1)),
    finishHashCount: finishHashIndex + 1,
    tickHashes: sim.hashes,
    finish: sim.driver.finish,
    lapTimes: sim.driver.lapTimes.slice(),
    checkpointsPassed: sim.driver.checkpointsPassed,
    levelBytes,
    fieldBytes
  };
}

async function replaySolo({ factory, levelBytes, fieldBytes, layout, start, groundHint, inputs, rebuilds,
  expectedHashes, expectedFinishHashCount, expectedFinishSequenceHash }) {
  const module = await factory();
  let state = createWorld(module, levelBytes, fieldBytes, start.x, start.z, start.heading, groundHint);
  const hashes = [hashOf(state)];
  let matched = hashes[0] === expectedHashes[0];
  let firstMismatch = matched ? null : 0;
  const rebuildByStep = new Map(rebuilds.map((rebuild) => [rebuild.afterStep, rebuild]));
  const rebuildSteps = new Set(rebuilds.map((rebuild) => rebuild.afterStep));
  for (let index = 0; index < inputs.length; index++) {
    const rebuild = rebuildByStep.get(index);
    if (rebuild) {
      state = createWorld(module, levelBytes, fieldBytes,
        rebuild.target.x, rebuild.target.z, rebuild.target.headingRad, groundHint);
      const rebuiltHash = hashOf(state);
      hashes[hashes.length - 1] = rebuiltHash;
      if (matched && rebuiltHash !== expectedHashes[hashes.length - 1]) {
        matched = false;
        firstMismatch = hashes.length - 1;
      }
    }
    module._e1_set_input(inputs[index][0], inputs[index][1], inputs[index][2], inputs[index][3]);
    module._e1_step();
    state = JSON.parse(module.UTF8ToString(module._e1_get_state()));
    const hash = hashOf(state);
    hashes.push(hash);
    // A rebuild recorded after step N replaces the hash at index N; that hash is
    // compared when the rebuild is applied above, not here.
    if (matched && !rebuildSteps.has(index + 1) &&
        (index + 1 >= expectedHashes.length || hash !== expectedHashes[index + 1])) {
      matched = false;
      firstMismatch = index + 1;
    }
  }
  const lengthMatch = hashes.length === expectedHashes.length;
  if (!lengthMatch) matched = false;
  const finishSequenceHash = aggregateHash(hashes.slice(0, expectedFinishHashCount));
  if (finishSequenceHash !== expectedFinishSequenceHash) matched = false;
  return {
    matched,
    lengthMatch,
    firstMismatch,
    statesCompared: Math.min(hashes.length, expectedHashes.length),
    stateSequenceHash: aggregateHash(hashes),
    finishStateSequenceHash: finishSequenceHash
  };
}

function summarizeRun(run, replay) {
  const metrics = run.metrics;
  return {
    mapId: run.mapId,
    courseId: run.courseId,
    profile: run.profile.id,
    speedScale: run.profile.speedScale,
    car: run.car.slug,
    carName: run.car.name,
    status: run.status,
    finish: run.finish,
    checkpointsPassed: run.checkpointsPassed,
    raceTicks: run.raceTicks,
    timeSeconds: run.finish ? run.finish.timeSeconds : null,
    respawns: metrics.respawns,
    respawnEvents: run.rebuilds.map((rebuild) => ({
      afterStep: rebuild.afterStep, tick: rebuild.tick, reason: rebuild.reason,
      observed: rebuild.observed ?? null, target: rebuild.target
    })),
    contacts: {
      ticksWithAnyContact: metrics.ticksWithAnyContact,
      ticksWithAllFourContacts: metrics.ticksWithAllFourContacts,
      airborneTicks: metrics.airborneTicks,
      runningTicks: metrics.runningTicks
    },
    contactTicks: metrics.ticksWithAnyContact,
    nanTicks: metrics.nanTicks,
    maxLateralMetres: round6(metrics.maxLateralMetres),
    maxArcMetres: round6(metrics.maxArcMetres),
    finalArcMetres: round6(metrics.finalArcMetres),
    finishArcMetres: run.finishArc,
    maxSpeed: round6(metrics.maxSpeed),
    minSpeed: round6(metrics.minSpeed === Infinity ? 0 : metrics.minSpeed),
    stateSequenceHash: run.stateSequenceHash,
    finishStateSequenceHash: run.finishStateSequenceHash,
    inputCount: run.inputs.length,
    inputHash: hashOf(run.inputs),
    replay: replay ? {
      matchedEveryTick: replay.matched,
      lengthMatch: replay.lengthMatch,
      firstMismatch: replay.firstMismatch,
      statesCompared: replay.statesCompared,
      stateSequenceHash: replay.stateSequenceHash,
      finishStateSequenceHash: replay.finishStateSequenceHash
    } : null,
    clean: run.status === 'finished' && metrics.respawns === 0 && metrics.nanTicks === 0 &&
      (!replay || replay.matched)
  };
}

// ---------------------------------------------------------------------------
// Multi-AI race: one wasm instance per AI, stepped in lockstep.
// ---------------------------------------------------------------------------

async function runRace({ factory, levelBytes, fieldsBySlug, carBySlug, layout, entries, name, mapId }) {
  const sims = [];
  for (const entry of entries) {
    const car = carBySlug.get(entry.car);
    if (!car) throw new Error('race entry has no car ' + entry.car);
    const fieldBytes = fieldsBySlug.get(entry.car);
    const sim = await createSim({
      factory, levelBytes, fieldBytes, layout, profile: entry.profile,
      controlOverrides: controlOverridesFor(mapId)
    });
    sim.levelBytes = levelBytes;
    sim.fieldBytes = fieldBytes;
    sims.push({ entry, car, sim, finishTick: null, status: 'running' });
  }
  for (const slot of sims) countdownStep(slot.sim, layout.countdown?.ticks ?? 0);

  const maxRaceTicks = MAPS[mapId].maxRaceTicks;
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
  const replayInputs = rows.map((row) => ({
    car: row.car,
    inputs: row.inputs,
    rebuilds: row.rebuilds,
    tickHashes: sims.find((slot) => slot.car.slug === row.car).sim.hashes.slice()
  }));
  return {
    name, raceHash, rows, replayInputs, raceTicks: raceTick,
    start: mapStart(layout), groundHint: sims[0].sim.groundHint
  };
}

async function replayRace({ factory, levelBytes, fieldsBySlug, start, groundHint, replayInputs, expectedRows }) {
  const checks = [];
  for (const entry of replayInputs) {
    const expected = expectedRows.find((row) => row.car === entry.car);
    if (!expected) {
      checks.push({ car: entry.car, matchedEveryTick: false, reason: 'no expected row' });
      continue;
    }
    const module = await factory();
    let state = createWorld(module, levelBytes, fieldsBySlug.get(entry.car),
      start.x, start.z, start.heading, groundHint);
    const hashes = [hashOf(state)];
    const expectedHashes = entry.tickHashes;
    let matched = hashes[0] === expectedHashes[0];
    let firstMismatch = matched ? null : 0;
    const rebuildByStep = new Map(entry.rebuilds.map((rebuild) => [rebuild.afterStep, rebuild]));
    const rebuildSteps = new Set(entry.rebuilds.map((rebuild) => rebuild.afterStep));
    for (let step = 0; step < entry.inputs.length; step++) {
      const rebuild = rebuildByStep.get(step);
      if (rebuild) {
        state = createWorld(module, levelBytes, fieldsBySlug.get(entry.car),
          rebuild.target.x, rebuild.target.z, rebuild.target.headingRad, groundHint);
        const rebuiltHash = hashOf(state);
        hashes[hashes.length - 1] = rebuiltHash;
        if (matched && rebuiltHash !== expectedHashes[hashes.length - 1]) {
          matched = false;
          firstMismatch = hashes.length - 1;
        }
      }
      module._e1_set_input(entry.inputs[step][0], entry.inputs[step][1],
        entry.inputs[step][2], entry.inputs[step][3]);
      module._e1_step();
      state = JSON.parse(module.UTF8ToString(module._e1_get_state()));
      const hash = hashOf(state);
      hashes.push(hash);
      if (matched && !rebuildSteps.has(step + 1) &&
          (step + 1 >= expectedHashes.length || hash !== expectedHashes[step + 1])) {
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
// Main.
// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

const build = readJson(BUILD);
const roster = readJson(ROSTER).roster;
const mapIds = ONLY_MAPS ? MAP_IDS.filter((id) => ONLY_MAPS.includes(id)) : MAP_IDS;
const allCars = roster.cars;
const cars = ONLY_CARS ? allCars.filter((car) => ONLY_CARS.includes(car.slug)) : allCars;
// Reference (1.00) and standard (0.95) are the requested map profiles. The
// cautious/aggressive profiles are not part of this map matrix.
const PROFILE_IDS = ['reference', 'standard'];
const profiles = ONLY_PROFILES
  ? SKILL_PROFILES.filter((profile) => PROFILE_IDS.includes(profile.id) && ONLY_PROFILES.includes(profile.id))
  : SKILL_PROFILES.filter((profile) => PROFILE_IDS.includes(profile.id));

if (cars.length === 0) throw new Error('no roster cars selected');
if (profiles.length === 0) throw new Error('no skill profiles selected');
if (mapIds.length === 0) throw new Error('no maps selected');

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

const mapDocuments = {};
for (const mapId of mapIds) {
  const spec = MAPS[mapId];
  const layoutBytes = readFileSync(spec.layoutPath);
  const levelBytes = readFileSync(spec.levelPath);
  const layout = JSON.parse(layoutBytes.toString('utf8'));
  const doc = {
    layout,
    layoutFileSha256: sha256Hex(layoutBytes),
    layoutBytes: layoutBytes.length,
    level: levelBytes,
    levelSha256: sha256Hex(levelBytes),
    levelBytes: levelBytes.length,
    groundHint: groundHintFor(layout),
    committedPath: null
  };
  // The E1 layout is the run authority, but it must still describe the same
  // committed collision path: same canonical hash and the same sample polyline.
  // A stale layout is a hard error, never a silent substitution.
  if (spec.committedPathPath) {
    const pathBytes = readFileSync(spec.committedPathPath);
    const committedPath = JSON.parse(pathBytes.toString('utf8'));
    if (committedPath.hash !== layout.hash) {
      throw new Error(`${mapId}: E1 layout hash ${layout.hash} != committed path hash ${committedPath.hash}`);
    }
    if (JSON.stringify(committedPath.course.samples) !== JSON.stringify(layout.course.samples) ||
        JSON.stringify(committedPath.gates) !== JSON.stringify(layout.gates)) {
      throw new Error(`${mapId}: E1 layout samples/gates differ from the committed path`);
    }
    doc.committedPath = {
      path: path.relative(ROOT, spec.committedPathPath).split(path.sep).join('/'),
      fileSha256: sha256Hex(pathBytes),
      bytes: pathBytes.length,
      hash: committedPath.hash
    };
  }
  mapDocuments[mapId] = doc;
  process.stdout.write(`[ai-driver-maps] ${mapId}: layout ${doc.layoutFileSha256.slice(0, 16)} ` +
    `level ${doc.levelSha256.slice(0, 16)} groundHint ${doc.groundHint.value} ` +
    `applied=${doc.groundHint.applied} (${doc.groundHint.reason})\n`);
}

const factory = await loadFactory();
const runSummaries = [];
const committedComparison = [];

for (const mapId of mapIds) {
  const doc = mapDocuments[mapId];
  const layout = doc.layout;
  for (const profile of profiles) {
    for (const car of cars) {
      const fieldBytes = fieldsBySlug.get(car.slug);
      process.stdout.write(`[ai-driver-maps] run ${mapId}/${profile.id}/${car.slug}\n`);
      const run = await runSolo({
        factory, levelBytes: doc.level, fieldBytes, car, layout, profile, mapId
      });
      let replay = null;
      if (!SKIP_REPLAY) {
        replay = await replaySolo({
          factory, levelBytes: doc.level, fieldBytes, layout, start: run.start,
          groundHint: run.groundHint,
          inputs: run.inputs, rebuilds: run.rebuilds, expectedHashes: run.tickHashes,
          expectedFinishHashCount: run.finishHashCount,
          expectedFinishSequenceHash: run.finishStateSequenceHash
        });
      }
      const summary = summarizeRun(run, replay);
      runSummaries.push(summary);
      process.stdout.write(
        `[ai-driver-maps]   ${summary.status} time=${summary.timeSeconds ?? 'DNF'} ` +
        `respawns=${summary.respawns} nan=${summary.nanTicks} lateral=${summary.maxLateralMetres} ` +
        `replay=${replay ? replay.matched : 'skipped'} hash=${summary.finishStateSequenceHash.slice(0, 19)}\n`);
    }
  }
}

// Committed M3 follower comparison for the Corvette (the car with a committed
// scripted map run). The committed `finish.tick` includes the 90-tick countdown;
// `timeSeconds` is the comparison value.
for (const mapId of mapIds) {
  const spec = MAPS[mapId];
  let committed = null;
  try {
    const source = readJson(spec.committedRunPath);
    committed = {
      car: source.car?.slug ?? 'corvette-zr1-stock',
      timeSeconds: source.sprint?.finish?.timeSeconds ?? null,
      tick: source.sprint?.finish?.tick ?? null,
      checkpoints: source.sprint?.finish?.checkpoints ?? null,
      maxSpeedMps: source.sprint?.maxSpeedMps ?? null,
      maxLateralMetres: source.sprint?.maxLateralMetres ?? null,
      stateSequenceHash: source.sprint?.stateSequenceHash ?? null,
      source: path.relative(ROOT, spec.committedRunPath).split(path.sep).join('/')
    };
  } catch { /* missing committed run is reported by verify */ }
  if (!committed || committed.timeSeconds === null) continue;
  const ours = runSummaries.find((run) =>
    run.courseId === mapId && run.profile === 'reference' && run.car === committed.car);
  // The committed new-map runs were produced by the sprint follower (its
  // recorded top speed is ~24.7 m/s); the AI matrix uses the measured-path
  // MAP_CONTROL (12 m/s cruise). The two are recorded side by side but the
  // times are only directly comparable when the committed run stayed inside
  // the measured controller's speed class. The threshold is derived from the
  // recorded top speed, not assumed.
  const comparable = Number.isFinite(committed.maxSpeedMps) &&
    committed.maxSpeedMps <= MAP_CONTROL.cruiseSpeed * 1.2;
  committedComparison.push({
    mapId,
    car: committed.car,
    committed,
    comparable,
    committedControlClass: comparable ? 'measured' : 'sprint',
    ai: ours ? {
      status: ours.status,
      timeSeconds: ours.timeSeconds,
      finishStateSequenceHash: ours.finishStateSequenceHash,
      maxSpeed: ours.maxSpeed,
      maxLateralMetres: ours.maxLateralMetres,
      respawns: ours.respawns
    } : null,
    differenceSeconds: comparable && ours?.timeSeconds !== null && ours?.timeSeconds !== undefined
      ? round6(ours.timeSeconds - committed.timeSeconds) : null,
    timeMatchesExactly: ours ? ours.timeSeconds === committed.timeSeconds : false,
    stateSequenceMatchesExactly: ours
      ? ours.finishStateSequenceHash === committed.stateSequenceHash : false
  });
}

// ---------------------------------------------------------------------------
// Committed-control anchor: the reference Corvette is re-run with the committed
// MAP_CONTROL (no tuning override) on every map. This proves the driver's
// fidelity to the committed scripted follower independently of the matrix's
// tuning choice.
// ---------------------------------------------------------------------------

const anchorRuns = [];
{
  let anchorCar = carBySlug.get('corvette-zr1-stock');
  if (!anchorCar && cars.length > 0) anchorCar = cars[0];
  if (anchorCar) {
    const fieldBytes = fieldsBySlug.get(anchorCar.slug);
    const referenceProfile = SKILL_PROFILES.find((profile) => profile.id === 'reference');
    for (const mapId of mapIds) {
      const doc = mapDocuments[mapId];
      process.stdout.write(`[ai-driver-maps] anchor ${mapId}/reference/${anchorCar.slug} (committed control)\n`);
      const run = await runSolo({
        factory, levelBytes: doc.level, fieldBytes, car: anchorCar,
        layout: doc.layout, profile: referenceProfile, mapId, controlOverrides: null
      });
      let replay = null;
      if (!SKIP_REPLAY) {
        replay = await replaySolo({
          factory, levelBytes: doc.level, fieldBytes, layout: doc.layout, start: run.start,
          groundHint: run.groundHint,
          inputs: run.inputs, rebuilds: run.rebuilds, expectedHashes: run.tickHashes,
          expectedFinishHashCount: run.finishHashCount,
          expectedFinishSequenceHash: run.finishStateSequenceHash
        });
      }
      const summary = summarizeRun(run, replay);
      let committed = null;
      try {
        const source = readJson(MAPS[mapId].committedRunPath);
        committed = {
          timeSeconds: source.sprint?.finish?.timeSeconds ?? null,
          stateSequenceHash: source.sprint?.stateSequenceHash ?? null,
          maxSpeedMps: source.sprint?.maxSpeedMps ?? null,
          maxLateralMetres: source.sprint?.maxLateralMetres ?? null
        };
      } catch { /* reported by verify */ }
      const comparable = Boolean(committed) && Number.isFinite(committed.maxSpeedMps) &&
        committed.maxSpeedMps <= MAP_CONTROL.cruiseSpeed * 1.2;
      anchorRuns.push({
        mapId,
        car: anchorCar.slug,
        profile: 'reference',
        control: 'committed',
        controlTable: 'MAP_CONTROL',
        comparable,
        committedControlClass: comparable ? 'measured' : 'sprint',
        status: summary.status,
        timeSeconds: summary.timeSeconds,
        finishStateSequenceHash: summary.finishStateSequenceHash,
        maxLateralMetres: summary.maxLateralMetres,
        respawns: summary.respawns,
        nanTicks: summary.nanTicks,
        replayMatchedEveryTick: summary.replay?.matchedEveryTick ?? null,
        committed,
        differenceSeconds: comparable ? round6(summary.timeSeconds - committed.timeSeconds) : null,
        timeMatchesExactly: committed ? summary.timeSeconds === committed.timeSeconds : false,
        stateSequenceMatchesExactly: committed
          ? summary.finishStateSequenceHash === committed.stateSequenceHash : false
      });
      process.stdout.write(
        `[ai-driver-maps]   anchor ${mapId} ${summary.status} time=${summary.timeSeconds} ` +
        `comparable=${comparable} ` +
        `exactTime=${anchorRuns[anchorRuns.length - 1].timeMatchesExactly} ` +
        `exactHash=${anchorRuns[anchorRuns.length - 1].stateSequenceMatchesExactly}\n`);
    }
  }
}

// Classify non-clean runs.
//
// A run is only acceptable as a *declared limit* when the physics replay
// reproduced every tick and there was no NaN: the car drove, it simply could
// not finish (or needed a respawn). A replay mismatch or a NaN is a
// determinism/physics failure and is always unexpected.
//
// Every limit is classified from its own recorded evidence (status, respawn
// reason codes, observed lateral distance, arc reached) and keeps the car, the
// course and the cause. A car that never gets off the start line is a spawn
// failure, not a hairpin/turning-circle claim: the arc it reached is recorded
// and the cause names the observed mode. Nothing is dropped.
function classifyLimit(run) {
  const reasons = run.respawnEvents.flatMap((event) => event.reason ?? []);
  const codes = [...new Set(reasons.map((item) => item.code))];
  const outside = reasons.filter((item) => item.code === 'outside-corridor');
  const worstOutside = outside.length
    ? outside.reduce((max, item) => (item.distance > max.distance ? item : max), outside[0])
    : null;
  const lastEvent = run.respawnEvents[run.respawnEvents.length - 1] ?? null;
  const lastArc = lastEvent?.observed?.arc ?? run.finalArcMetres;
  const common = `course ${run.courseId} (${run.finishArcMetres} m), car ${run.car}, ` +
    `profile ${run.profile}, status ${run.status}, respawns ${run.respawns}, ` +
    `max lateral ${run.maxLateralMetres} m, arc reached ${run.maxArcMetres}/${run.finishArcMetres} m`;
  const spawnFailure = run.maxArcMetres < 2;
  if (run.status !== 'finished') {
    if (spawnFailure && run.respawns === 0) {
      return {
        cause: 'spawn-no-launch',
        detail: `${common}; the car moved only ${run.maxArcMetres} m from the start ` +
          `line in ${run.raceTicks} race ticks and never reached the first corner.`
      };
    }
    if (spawnFailure && codes.includes('airborne')) {
      return {
        cause: 'spawn-airborne-respawn-loop',
        detail: `${common}; every respawn was airborne at the start line ` +
          `(max arc ${run.maxArcMetres} m), so the car never launched.`
      };
    }
    if (spawnFailure) {
      return {
        cause: 'spawn-respawn-loop',
        detail: `${common}; respawn reasons ${codes.join(',') || 'none'} repeated at ` +
          `the start line (max arc ${run.maxArcMetres} m).`
      };
    }
    if (worstOutside) {
      return {
        cause: 'outside-corridor-dnf',
        detail: `${common}; the car left the declared corridor ` +
          `(${round6(worstOutside.distance)} m > ${worstOutside.allowed} m) at arc ` +
          `${lastArc} and did not reach the finish inside ${run.raceTicks} race ticks.`
      };
    }
    if (codes.includes('below-ground')) {
      return {
        cause: 'below-ground-dnf',
        detail: `${common}; the chassis fell below the measured ground and did not reach the finish.`
      };
    }
    if (codes.includes('airborne')) {
      return {
        cause: 'airborne-dnf',
        detail: `${common}; the car stayed airborne past the respawn limit and did not reach the finish.`
      };
    }
    if (run.respawns > 0) {
      return {
        cause: 'respawn-loop-dnf',
        detail: `${common}; respawn reasons ${codes.join(',') || 'none'} repeated without a finish.`
      };
    }
    return {
      cause: 'no-finish-within-tick-budget',
      detail: `${common}; the car never left the corridor and never crossed the finish ` +
        `inside ${run.raceTicks} race ticks.`
    };
  }
  const firstEvent = run.respawnEvents[0] ?? null;
  const firstArc = firstEvent?.observed?.arc ?? null;
  if (firstArc !== null && firstArc < 2 && codes.includes('airborne')) {
    return {
      cause: 'spawn-airborne-recovered',
      detail: `${common}; the first launch was airborne at the start line ` +
        `(arc ${firstArc} m) and the observer respawned; the rebuilt car then finished.`
    };
  }
  return {
    cause: 'recovered-with-respawns',
    detail: `${common}; the car finished after ${run.respawns} respawn(s) ` +
      `(reasons ${codes.join(',') || 'none'}).`
  };
}

const knownLimits = [];
const unexpectedFailures = [];
for (const run of runSummaries.filter((item) => !item.clean)) {
  const replayMatched = run.replay?.matchedEveryTick ?? null;
  // A replay mismatch or a NaN is never a map/car limit.
  if (run.nanTicks !== 0 || replayMatched === false) {
    unexpectedFailures.push({
      mapId: run.mapId, courseId: run.courseId, car: run.car, profile: run.profile,
      status: run.status, respawns: run.respawns, nanTicks: run.nanTicks,
      replayMatchedEveryTick: replayMatched,
      reason: run.nanTicks !== 0 ? 'nan-ticks' : 'replay-mismatch'
    });
    continue;
  }
  const classified = classifyLimit(run);
  knownLimits.push({
    mapId: run.mapId, courseId: run.courseId, car: run.car, profile: run.profile,
    cause: classified.cause, detail: classified.detail,
    status: run.status, respawns: run.respawns, nanTicks: run.nanTicks,
    raceTicks: run.raceTicks, finishArcMetres: run.finishArcMetres,
    maxArcMetres: run.maxArcMetres, maxSpeed: run.maxSpeed,
    maxLateralMetres: run.maxLateralMetres,
    respawnReasons: [...new Set(run.respawnEvents.flatMap((event) =>
      (event.reason ?? []).map((item) => item.code)))],
    respawnEvents: run.respawnEvents,
    stateSequenceHash: run.stateSequenceHash,
    replayMatchedEveryTick: replayMatched
  });
}

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
    byMap: Object.fromEntries(mapIds.map((mapId) => {
      const mapRuns = runs.filter((run) => run.courseId === mapId);
      const mapFinished = mapRuns.filter((run) => run.status === 'finished');
      return [mapId, {
        runs: mapRuns.length,
        finished: mapFinished.length,
        clean: mapRuns.filter((run) => run.clean).length,
        meanTimeSeconds: mapFinished.length
          ? round6(mapFinished.reduce((sum, run) => sum + run.timeSeconds, 0) / mapFinished.length)
          : null
      }];
    }))
  };
});

// ---------------------------------------------------------------------------
// Multi-AI races: 4 cars per map, each run twice in fresh module instances.
// ---------------------------------------------------------------------------

const races = [];
if (!SKIP_RACES) {
  for (const mapId of mapIds) {
    const doc = mapDocuments[mapId];
    const layout = doc.layout;
    const definition = {
      name: `${mapId}-4ai`,
      entries: [
        { car: 'corvette-zr1-stock', profile: 'reference' },
        { car: 'lotus-exige-cup260-stock', profile: 'standard' },
        { car: 'audi-r8v10-stock', profile: 'reference' },
        { car: 'ford-focusrs-stock', profile: 'standard' }
      ]
    };
    const available = definition.entries.filter((entry) => carBySlug.has(entry.car));
    if (available.length < 2) {
      races.push({ name: definition.name, skipped: 'fewer than two cars available' });
      continue;
    }
    process.stdout.write(`[ai-driver-maps] race ${definition.name}\n`);
    const first = await runRace({
      factory, levelBytes: doc.level, fieldsBySlug, carBySlug, layout,
      entries: available, name: definition.name, mapId
    });
    const second = await runRace({
      factory, levelBytes: doc.level, fieldsBySlug, carBySlug, layout,
      entries: available, name: definition.name, mapId
    });
    const replayChecks = await replayRace({
      factory, levelBytes: doc.level, fieldsBySlug, start: first.start,
      groundHint: first.groundHint,
      replayInputs: first.replayInputs, expectedRows: first.rows
    });
    const orderA = first.rows.map((row) => `${row.position}:${row.car}:${row.finishTick}`);
    const orderB = second.rows.map((row) => `${row.position}:${row.car}:${row.finishTick}`);
    races.push({
      name: definition.name,
      courseId: mapId,
      entries: first.rows.map((row) => ({
        position: row.position,
        car: row.car,
        carName: row.carName,
        profile: row.profile,
        speedScale: row.speedScale,
        status: row.status,
        finishTick: row.finishTick,
        timeSeconds: row.timeSeconds,
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
      `[ai-driver-maps]   order ${first.rows.map((row) => `${row.position}.${row.car}(${row.timeSeconds ?? 'DNF'})`).join(' ')} ` +
      `deterministic=${races[races.length - 1].deterministic} replay=${races[races.length - 1].replayMatchedEveryTick}\n`);
  }
}

const results = {
  kind: 'blur.ai-driver-map-results',
  version: 1,
  driver: {
    kind: DRIVER_KIND,
    version: DRIVER_VERSION,
    mapControl: MAP_CONTROL,
    measuredMapIds: MAP_IDS,
    mapTunedOverrides: Object.fromEntries(mapIds.map((mapId) => [
      mapId, CONTROL_MODE === 'tuned' && mapId === 'amboy'
        ? { minSpeed: AMBOY_TUNED_MIN_SPEED } : null
    ])),
    controlMode: CONTROL_MODE,
    profiles: SKILL_PROFILES.filter((profile) => PROFILE_IDS.includes(profile.id))
  },
  inputs: {
    module: {
      path: path.relative(ROOT, MODULE).split(path.sep).join('/'),
      wasmSha256: build.wasmSha256,
      wasmBytes: build.wasmBytes,
      actualWasmSha256: sha256Hex(readFileSync(path.join(E1, 'module/e1_drive.wasm'))),
      buildDeterministic: build.buildDeterministic,
      objects: build.objects
    },
    roster: {
      path: path.relative(ROOT, ROSTER).split(path.sep).join('/'),
      selected: allCars.length,
      cars: allCars.map((car) => ({
        slug: car.slug, name: car.name, drivetrain: car.drivetrain,
        fieldsPath: car.fields.path, fieldsSha256: car.fields.sha256
      }))
    },
    maps: Object.fromEntries(mapIds.map((mapId) => [mapId, {
      summary: layoutSummary(mapDocuments[mapId].layout),
      layoutPath: path.relative(ROOT, MAPS[mapId].layoutPath).split(path.sep).join('/'),
      layoutFileSha256: mapDocuments[mapId].layoutFileSha256,
      layoutBytes: mapDocuments[mapId].layoutBytes,
      levelPath: path.relative(ROOT, MAPS[mapId].levelPath).split(path.sep).join('/'),
      levelSha256: mapDocuments[mapId].levelSha256,
      levelBytes: mapDocuments[mapId].levelBytes,
      groundHint: mapDocuments[mapId].groundHint,
      committedPath: mapDocuments[mapId].committedPath
    }]))
  },
  config: {
    postFinishTicks: POST_FINISH_TICKS,
    maxRaceTicks: Object.fromEntries(mapIds.map((mapId) => [mapId, MAPS[mapId].maxRaceTicks])),
    replayPerTick: !SKIP_REPLAY,
    races: !SKIP_RACES,
    controlMode: CONTROL_MODE,
    controlPolicy: Object.fromEntries(mapIds.map((mapId) => [mapId,
      CONTROL_MODE === 'tuned' && mapId === 'amboy'
        ? { table: 'MAP_CONTROL', overrides: { minSpeed: AMBOY_TUNED_MIN_SPEED } }
        : { table: 'MAP_CONTROL', overrides: null }
    ])),
    selection: {
      cars: cars.map((car) => car.slug),
      profiles: profiles.map((profile) => profile.id),
      maps: mapIds
    }
  },
  runs: runSummaries,
  committedComparison,
  anchorRuns,
  profileSummary,
  knownLimits,
  unexpectedFailures,
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

try {
  writeFileSync(path.join(OUT, 'results-maps.previous.json'),
    readFileSync(path.join(OUT, 'results-maps.json')));
} catch {
  // First run: nothing to rotate.
}
writeFileSync(path.join(OUT, 'results-maps.json'), JSON.stringify(results, null, 2) + '\n');
process.stdout.write(`[ai-driver-maps] wrote ${path.relative(ROOT, path.join(OUT, 'results-maps.json'))}\n`);
process.stdout.write(`[ai-driver-maps] runs=${runSummaries.length} ` +
  `clean=${runSummaries.filter((run) => run.clean).length} ` +
  `finished=${runSummaries.filter((run) => run.status === 'finished').length} ` +
  `knownLimits=${knownLimits.length} unexpected=${unexpectedFailures.length}\n`);
for (const failure of unexpectedFailures) {
  process.stdout.write(`[ai-driver-maps] UNEXPECTED ${failure.courseId}/${failure.profile}/${failure.car} ` +
    `status=${failure.status} respawns=${failure.respawns}\n`);
}
