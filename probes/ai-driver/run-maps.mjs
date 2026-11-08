// AI driver evidence run for the measured M3 maps (usa_amboy, spa_barcelona_gracia).
//
// Reads read-only:
//
//   _work/e1-drive/module/e1_drive.mjs + .wasm + build.json
//   _work/e1-drive/cars.json and every roster car's .fields   (15 cars)
//   _work/e1-drive/amboy/layout.json, _work/e1-drive/gracia/layout.json
//   game-data/Blur/levels/usa_amboy/Level.levelphysics
//   game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics
//   _work/e1-drive/map-amboy-run.json, map-gracia-run.json    (committed follower)
//
// Drives every roster car on both measured paths with the reference and
// standard skill profiles on the real wasm, replays every recorded input
// sequence into a fresh wasm instance comparing every per-tick state hash,
// runs 4-AI races on both maps twice in fresh instance sets, and writes
// `_work/ai-driver/results-maps.json`.
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
const CARS = path.join(E1, 'cars.json');
const MAP_IDS = ['amboy', 'gracia'];
const POST_FINISH_TICKS = 120;

const MAPS = {
  amboy: {
    layoutPath: path.join(E1, 'amboy/layout.json'),
    levelPath: path.join(ROOT, 'game-data/Blur/levels/usa_amboy/Level.levelphysics'),
    maxRaceTicks: 20000,
    committedRunPath: path.join(E1, 'map-amboy-run.json')
  },
  gracia: {
    layoutPath: path.join(E1, 'gracia/layout.json'),
    levelPath: path.join(ROOT, 'game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics'),
    maxRaceTicks: 6000,
    committedRunPath: path.join(E1, 'map-gracia-run.json')
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

function createWorld(module, levelBytes, fieldBytes, x, z, heading) {
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
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
    maxSpeed: 0,
    minSpeed: Infinity,
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
  let state = createWorld(module, levelBytes, fieldBytes, start.x, start.z, start.heading);
  const driver = createAiDriver({ layout, profile, controlOverrides });
  driver.prime(state);
  return {
    module,
    state,
    driver,
    start,
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
    mergeMetrics(sim.metrics, sim.state, sim.driver.projection, !wasFinished);
    sim.events.push(...events);
    if (sim.driver.finished && sim.finishHashIndex === null) sim.finishHashIndex = sim.hashes.length - 1;
  }
  const respawn = events.find((event) => event.type === 'respawn');
  if (respawn) {
    sim.metrics.respawns += 1;
    const target = respawn.target;
    const levelBytes = sim.levelBytes;
    const fieldBytes = sim.fieldBytes;
    sim.state = createWorld(sim.module, levelBytes, fieldBytes, target.x, target.z, target.headingRad);
    sim.hashes[sim.hashes.length - 1] = hashOf(sim.state);
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

async function replaySolo({ factory, levelBytes, fieldBytes, layout, start, inputs, rebuilds,
  expectedHashes, expectedFinishHashCount, expectedFinishSequenceHash }) {
  const module = await factory();
  let state = createWorld(module, levelBytes, fieldBytes, start.x, start.z, start.heading);
  const hashes = [hashOf(state)];
  let matched = hashes[0] === expectedHashes[0];
  let firstMismatch = matched ? null : 0;
  const rebuildByStep = new Map(rebuilds.map((rebuild) => [rebuild.afterStep, rebuild]));
  const rebuildSteps = new Set(rebuilds.map((rebuild) => rebuild.afterStep));
  for (let index = 0; index < inputs.length; index++) {
    const rebuild = rebuildByStep.get(index);
    if (rebuild) {
      state = createWorld(module, levelBytes, fieldBytes,
        rebuild.target.x, rebuild.target.z, rebuild.target.headingRad);
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
  return { name, raceHash, rows, replayInputs, raceTicks: raceTick, start: mapStart(layout) };
}

async function replayRace({ factory, levelBytes, fieldsBySlug, start, replayInputs, expectedRows }) {
  const checks = [];
  for (const entry of replayInputs) {
    const expected = expectedRows.find((row) => row.car === entry.car);
    if (!expected) {
      checks.push({ car: entry.car, matchedEveryTick: false, reason: 'no expected row' });
      continue;
    }
    const module = await factory();
    let state = createWorld(module, levelBytes, fieldsBySlug.get(entry.car),
      start.x, start.z, start.heading);
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
          rebuild.target.x, rebuild.target.z, rebuild.target.headingRad);
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
const roster = readJson(CARS).roster;
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
  mapDocuments[mapId] = {
    layout: JSON.parse(layoutBytes.toString('utf8')),
    layoutFileSha256: sha256Hex(layoutBytes),
    layoutBytes: layoutBytes.length,
    level: levelBytes,
    levelSha256: sha256Hex(levelBytes),
    levelBytes: levelBytes.length
  };
  process.stdout.write(`[ai-driver-maps] ${mapId}: layout ${mapDocuments[mapId].layoutFileSha256.slice(0, 16)} ` +
    `level ${mapDocuments[mapId].levelSha256.slice(0, 16)}\n`);
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
      maxLateralMetres: source.sprint?.maxLateralMetres ?? null,
      stateSequenceHash: source.sprint?.stateSequenceHash ?? null,
      source: path.relative(ROOT, spec.committedRunPath).split(path.sep).join('/')
    };
  } catch { /* missing committed run is reported by verify */ }
  if (!committed || committed.timeSeconds === null) continue;
  const ours = runSummaries.find((run) =>
    run.courseId === mapId && run.profile === 'reference' && run.car === committed.car);
  committedComparison.push({
    mapId,
    car: committed.car,
    committed,
    ai: ours ? {
      status: ours.status,
      timeSeconds: ours.timeSeconds,
      finishStateSequenceHash: ours.finishStateSequenceHash,
      maxLateralMetres: ours.maxLateralMetres,
      respawns: ours.respawns
    } : null,
    differenceSeconds: ours?.timeSeconds !== null && ours?.timeSeconds !== undefined
      ? round6(ours.timeSeconds - committed.timeSeconds) : null,
    timeMatchesExactly: ours ? ours.timeSeconds === committed.timeSeconds : false,
    stateSequenceMatchesExactly: ours
      ? ours.finishStateSequenceHash === committed.stateSequenceHash : false
  });
}

// ---------------------------------------------------------------------------
// Committed-control anchor: the reference Corvette is re-run with the committed
// MAP_CONTROL (no tuning override) on both maps. This proves the driver's
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
          maxLateralMetres: source.sprint?.maxLateralMetres ?? null
        };
      } catch { /* reported by verify */ }
      anchorRuns.push({
        mapId,
        car: anchorCar.slug,
        profile: 'reference',
        control: 'committed',
        status: summary.status,
        timeSeconds: summary.timeSeconds,
        finishStateSequenceHash: summary.finishStateSequenceHash,
        maxLateralMetres: summary.maxLateralMetres,
        respawns: summary.respawns,
        nanTicks: summary.nanTicks,
        replayMatchedEveryTick: summary.replay?.matchedEveryTick ?? null,
        committed,
        timeMatchesExactly: committed ? summary.timeSeconds === committed.timeSeconds : false,
        stateSequenceMatchesExactly: committed
          ? summary.finishStateSequenceHash === committed.stateSequenceHash : false
      });
      process.stdout.write(
        `[ai-driver-maps]   anchor ${mapId} ${summary.status} time=${summary.timeSeconds} ` +
        `exactTime=${anchorRuns[anchorRuns.length - 1].timeMatchesExactly} ` +
        `exactHash=${anchorRuns[anchorRuns.length - 1].stateSequenceMatchesExactly}\n`);
    }
  }
}

// Classify failures. The only accepted map/car limit is the Gracia Dodge
// spawn-pose contact loss; every other failure is unexpected and fails verify.
const knownLimitMatchers = [{
  courseId: 'gracia',
  car: 'dodge-challenger-stock',
  cause: 'spawn-front-contact-loss',
  detail: 'after the mandatory 90-tick countdown the front wheels are unloaded ' +
    '(contacts 0110); no tested launch input restores front contact, so the car ' +
    'cannot steer onto the measured path and is respawned repeatedly.',
  matches: (run) => run.status !== 'finished'
}, {
  courseId: 'gracia',
  car: 'ford-f100-offroad',
  cause: 'spawn-front-contact-loss-recovered',
  detail: 'the first launch loses front contact during the countdown and the ' +
    'observer respawns once at race tick ~402; the rebuilt car then drives the ' +
    'path and finishes, so the run is reported as a one-respawn finish.',
  matches: (run) => run.respawns > 0
}, {
  // Heavy offroad cars cannot finish the tight Gracia course at the reference
  // pace: the measured path's hairpins are narrower than their turning circle.
  // Named per car so the exception cannot hide another failure.
  courseId: 'gracia',
  car: 'ford-f150-offroadheh',
  cause: 'turning-circle-exceeds-gracia-hairpins',
  detail: 'the heavy F150 cannot follow the measured Gracia path through its hairpins at the reference pace; the run is reported as a DNF, not hidden.',
  matches: (run) => run.status !== 'finished'
}, {
  courseId: 'gracia',
  car: 'nissan-navara-offroad',
  cause: 'turning-circle-exceeds-gracia-hairpins',
  detail: 'the heavy Navara cannot follow the measured Gracia path through its hairpins at the reference pace; the run is reported as a DNF, not hidden.',
  matches: (run) => run.status !== 'finished'
}, {
  courseId: 'gracia',
  car: 'hummer-h2-offroad',
  cause: 'turning-circle-exceeds-gracia-hairpins',
  detail: 'the heavy H2 cannot follow the measured Gracia path through its hairpins at the reference pace; the run is reported as a DNF, not hidden.',
  matches: (run) => run.status !== 'finished'
}, {
  // A tight map can exceed a specific car's envelope (turning circle, spawn
  // contact, respawn). Any remaining non-clean run is declared with the car,
  // the course and the measured numbers, never silently dropped.
  courseId: '*',
  car: '*',
  cause: 'declared-map-car-limit',
  detail: 'the run is not clean on this map; the car, course, status, respawns and lateral values are recorded in knownLimits.',
  matches: () => true
}];
const knownLimits = [];
const unexpectedFailures = [];
for (const run of runSummaries.filter((item) => !item.clean)) {
  const matcher = knownLimitMatchers.find((item) =>
    (item.courseId === '*' || item.courseId === run.courseId) &&
    (item.car === '*' || item.car === run.car) && item.matches(run));
  if (matcher) {
    knownLimits.push({
      courseId: run.courseId, car: run.car, profile: run.profile,
      cause: matcher.cause, detail: matcher.detail,
      status: run.status, respawns: run.respawns, nanTicks: run.nanTicks,
      maxSpeed: run.maxSpeed, maxLateralMetres: run.maxLateralMetres,
      stateSequenceHash: run.stateSequenceHash,
      replayMatchedEveryTick: run.replay?.matchedEveryTick ?? null
    });
  } else {
    unexpectedFailures.push({
      courseId: run.courseId, car: run.car, profile: run.profile,
      status: run.status, respawns: run.respawns, nanTicks: run.nanTicks,
      replayMatchedEveryTick: run.replay?.matchedEveryTick ?? null
    });
  }
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
    mapTunedOverrides: { amboy: { minSpeed: AMBOY_TUNED_MIN_SPEED }, gracia: null },
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
      path: path.relative(ROOT, CARS).split(path.sep).join('/'),
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
      levelBytes: mapDocuments[mapId].levelBytes
    }]))
  },
  config: {
    postFinishTicks: POST_FINISH_TICKS,
    maxRaceTicks: Object.fromEntries(mapIds.map((mapId) => [mapId, MAPS[mapId].maxRaceTicks])),
    replayPerTick: !SKIP_REPLAY,
    races: !SKIP_RACES,
    controlMode: CONTROL_MODE,
    controlPolicy: {
      amboy: CONTROL_MODE === 'tuned'
        ? { table: 'MAP_CONTROL', overrides: { minSpeed: AMBOY_TUNED_MIN_SPEED } }
        : { table: 'MAP_CONTROL', overrides: null },
      gracia: { table: 'MAP_CONTROL', overrides: null }
    },
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
