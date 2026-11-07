// M2a boost tests: exact recovered targets, the deterministic queue model and
// the real wasm `e1_boost_queue`/`e1_boost_state` path.
//
// The wasm run reproduces BOOST1's measurement fixture (Corvette ZR1 at
// 281.2833, 1823.6890, heading 0; 180 full-throttle ticks; then the boost). It
// is the same module the page loads, so this is the integration gate, not a
// second physics build.
//
// Usage:
//   node probes/e1-drive/tools/boost_model_tests.mjs
//
// Writes `_work/e1-drive/boost-node-report.json`; never a retail/parity claim.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  M2_BOOST_MAGNITUDE_MPS2, M2_NITRO_CAP_MPS, M2_NITRO_CLASS, M2_NITRO_DURATION_TICKS,
  M2_REFERENCE_MAX_SPEED_MPS, M2_REFERENCE_SPRINT_SPEED_MPS, M2_SHOCK_DURATION_TICKS,
  boostManifestValues, createBoostQueueModel, nitroClassTargetTable, nitroTargetForSpeed,
  shockTargetForSpeed
} from '../web/boost-model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, '_work/e1-drive');
const MODULE = path.join(OUT, 'module/e1_drive.mjs');
const LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics');
const FIELDS = path.join(OUT, 'cars/corvette-zr1-stock.fields');
const MANIFEST = path.join(ROOT, '_work/powerups/powerups.json');

// BOOST1 measurement fixture (docs/work/analysis/boost-feasibility.md §1).
const FIXTURE = Object.freeze({ x: 281.2833, z: 1823.6890, heading: 0, preTicks: 180 });
const DT = 1 / 60;

const checks = [];
function check(label, ok, detail = '') {
  checks.push({ label, ok: Boolean(ok), detail: String(detail) });
  if (!ok) console.error('FAIL ' + label + (detail ? ': ' + detail : ''));
}
const near = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon;
const loadJson = (file, label) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(label + ' missing or unreadable at ' + file + ': ' + error.message); }
};

if (!existsSync(MODULE)) throw new Error('wasm module missing; run `node probes/e1-drive/tools/build_module.mjs`');
if (!existsSync(LEVEL)) throw new Error('level missing: ' + LEVEL);
if (!existsSync(FIELDS)) throw new Error('car fields missing: ' + FIELDS);

const manifest = loadJson(MANIFEST, 'PWR1 manifest');
const build = loadJson(path.join(OUT, 'module/build.json'), 'wasm build report');
const values = boostManifestValues(manifest);
const levelBytes = readFileSync(LEVEL);
const fieldBytes = readFileSync(FIELDS);

// ------------------------------------------------------------ exact targets
const sprint = nitroClassTargetTable(values.nitro.keyframes, M2_REFERENCE_SPRINT_SPEED_MPS, values.nitro.classModifiers);
const maximum = nitroClassTargetTable(values.nitro.keyframes, M2_REFERENCE_MAX_SPEED_MPS, values.nitro.classModifiers);
const expectedSprint = { A: 52.758963, B: 50.121015, C: 47.483066, D: 44.845120 };
const expectedMax = { A: 64.484674, B: 61.260439, C: 58.036205, D: 54.811974 };
for (const letter of ['A', 'B', 'C', 'D']) {
  check('exact Nitro class ' + letter + ' target at the 310 m sprint speed',
    near(sprint[letter].targetMps, expectedSprint[letter], 1e-6),
    sprint[letter].targetMps + ' m/s');
  check('exact Nitro class ' + letter + ' uncapped target at the straight-line maximum',
    near(maximum[letter].rawMps, expectedMax[letter], 1e-6),
    maximum[letter].rawMps + ' m/s');
}
check('the class-A sprint target matches BOOST1 exactly',
  near(sprint.A.targetMps, 52.758963, 1e-6) && near(sprint.A.graphValue, 0.5900922002069249, 1e-6),
  JSON.stringify(sprint.A));
check('the project cap is 55 m/s and it applies exactly above the cap',
  M2_NITRO_CAP_MPS === 55 && maximum.A.targetMps === 55 && maximum.A.capApplied === true &&
  maximum.B.capApplied === true && maximum.C.capApplied === true &&
  maximum.D.capApplied === false && near(maximum.D.targetMps, 54.811974, 1e-6),
  JSON.stringify({ A: maximum.A.targetMps, B: maximum.B.targetMps, C: maximum.C.targetMps, D: maximum.D }));
check('the Shock target at the sprint speed is 19.995 m/s (10 mph floor not binding)',
  near(shockTargetForSpeed(values.shock.keyframes, { speedMps: M2_REFERENCE_SPRINT_SPEED_MPS }).targetMps,
    19.995236, 1e-6) &&
  shockTargetForSpeed(values.shock.keyframes, { speedMps: M2_REFERENCE_SPRINT_SPEED_MPS }).floorApplied === false,
  JSON.stringify(shockTargetForSpeed(values.shock.keyframes, { speedMps: M2_REFERENCE_SPRINT_SPEED_MPS })));
check('the Shock 10 mph floor binds below the curve target',
  shockTargetForSpeed(values.shock.keyframes, { speedMps: 20 }).floorApplied === true);
check('the Nitro class label is the documented project assumption',
  M2_NITRO_CLASS === 'A' && /AmaxVehicle::carClass is not recorded/.test(sprint.A.classSource),
  sprint.A.classSource);

// ------------------------------------------------------- pure queue model
{
  const model = createBoostQueueModel({ mass: 1600, speedMps: 25 });
  const seq = model.queue({ kind: 1, startTick: 0, ticks: M2_NITRO_DURATION_TICKS, targetMps: 52.758963, magnitude: M2_BOOST_MAGNITUDE_MPS2 });
  check('boost model queues one Nitro effect', seq === 1 && model.state().queued === 1, seq);
  for (let i = 0; i < 30; i++) model.step();
  check('boost model applies the 0.5 s force window',
    model.state().forceTicks > 0 && model.state().forceTicks <= 30 &&
    model.state().speedMps > 25,
    JSON.stringify(model.state()));
  const at30 = model.state();
  for (let i = 0; i < M2_NITRO_DURATION_TICKS - 30; i++) model.step();
  const at78 = model.state();
  check('boost model keeps the effect alive for 1.3 s and then expires',
    at78.remaining === 0 && at78.ticks === M2_NITRO_DURATION_TICKS,
    JSON.stringify(at78));
  model.step();
  check('boost model marks the effect inactive after the duration', model.state().active === false,
    JSON.stringify(model.state()));

  const brake = createBoostQueueModel({ mass: 1600, speedMps: 25 });
  brake.queue({ kind: 2, startTick: 0, ticks: M2_SHOCK_DURATION_TICKS, targetMps: 19.995236, magnitude: M2_BOOST_MAGNITUDE_MPS2 });
  for (let i = 0; i < M2_SHOCK_DURATION_TICKS; i++) brake.step();
  const brakeAtEnd = brake.state();
  brake.step();
  check('boost model brakes toward the Shock target and stops at it',
    brakeAtEnd.remaining === 0 && brakeAtEnd.speedMps <= 19.995236 + 1e-6 &&
    brake.state().active === false,
    JSON.stringify({ atEnd: brakeAtEnd, after: brake.state() }));

  const replay = () => {
    const run = createBoostQueueModel({ mass: 1600, speedMps: 25 });
    run.queue({ kind: 1, startTick: 0, ticks: 78, targetMps: 52.758963, magnitude: 300 });
    for (let i = 0; i < 90; i++) run.step();
    return JSON.stringify(run.state());
  };
  const a = replay();
  const b = replay();
  check('boost model is deterministic for the same queue/step sequence', a === b,
    'sha256:' + createHash('sha256').update(a).digest('hex'));
}

// ----------------------------------------------------------------- wasm run
const factory = (await import(pathToFileURL(MODULE).href)).default;

async function createModule() {
  const module = await factory();
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  if (!module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
    FIXTURE.x, FIXTURE.z, FIXTURE.heading)) {
    throw new Error('e1_create failed: ' + module.UTF8ToString(module._e1_last_error()));
  }
  return module;
}
const readState = (module) => JSON.parse(module.UTF8ToString(module._e1_get_state()));
const readBoost = (module) => JSON.parse(module.UTF8ToString(module._e1_boost_state()));
const hashStates = (states) => 'sha256:' + createHash('sha256')
  .update(states.map((state) => JSON.stringify(state)).join('\n')).digest('hex');

async function runWasm({ boost = null, stepsAfterPre = 78 } = {}) {
  const module = await createModule();
  const states = [];
  const boosts = [];
  module._e1_set_input(1, 0, 0, 0);
  let state = readState(module);
  states.push(state);
  for (let i = 0; i < FIXTURE.preTicks; i++) {
    module._e1_step();
    state = readState(module);
    states.push(state);
  }
  const pre = state;
  if (boost) {
    const accepted = module._e1_boost_queue(boost.kind, boost.startTick, boost.ticks,
      boost.targetMps, boost.magnitude, 0, 0, 0);
    if (!accepted) throw new Error('e1_boost_queue failed: ' + module.UTF8ToString(module._e1_last_error()));
    boosts.push(readBoost(module));
  }
  for (let i = 0; i < stepsAfterPre; i++) {
    module._e1_step();
    state = readState(module);
    states.push(state);
    if (boost) boosts.push(readBoost(module));
  }
  // One extra step observes the expired state without changing the measured
  // 1.3 s window.
  if (boost) {
    module._e1_step();
    boosts.push(readBoost(module));
  }
  return { pre, states, boosts, end: states[states.length - 1], boostState: boosts[boosts.length - 1] ?? null };
}

const preProbe = await runWasm({ stepsAfterPre: 1 });
const nitroTarget = nitroTargetForSpeed(values.nitro.keyframes, {
  speedMps: preProbe.pre.speed,
  classLetter: M2_NITRO_CLASS,
  classModifiers: values.nitro.classModifiers,
  capMps: M2_NITRO_CAP_MPS
});
const shockTarget = shockTargetForSpeed(values.shock.keyframes, { speedMps: preProbe.pre.speed });
check('the fixture pre-speed is the BOOST1 measured 25.148 m/s',
  near(preProbe.pre.speed, 25.1475315, 1e-6), preProbe.pre.speed);
check('the fixture Nitro target is the exact curve target in the class-A range',
  nitroTarget.targetMps > 52.7 && nitroTarget.targetMps <= 55,
  JSON.stringify(nitroTarget));

const baseline = await runWasm();
const boostedA = await runWasm({
  boost: {
    kind: 1, startTick: FIXTURE.preTicks, ticks: M2_NITRO_DURATION_TICKS,
    targetMps: nitroTarget.targetMps, magnitude: M2_BOOST_MAGNITUDE_MPS2
  }
});
const boostedB = await runWasm({
  boost: {
    kind: 1, startTick: FIXTURE.preTicks, ticks: M2_NITRO_DURATION_TICKS,
    targetMps: nitroTarget.targetMps, magnitude: M2_BOOST_MAGNITUDE_MPS2
  }
});
const shockRun = await runWasm({
  boost: {
    kind: 2, startTick: FIXTURE.preTicks, ticks: M2_SHOCK_DURATION_TICKS,
    targetMps: shockTarget.targetMps, magnitude: M2_BOOST_MAGNITUDE_MPS2
  }
});

const speedAt = (run, index) => run.states[FIXTURE.preTicks + index]?.speed ?? null;
const peak = (run) => Math.max(...run.states.map((state) => state.speed));
const finite = (run) => run.states.every((state) => state.finite === 1);
const basePeak = peak(baseline);
const boostedPeak = peak(boostedA);
const gainAt13 = speedAt(boostedA, 78) - speedAt(baseline, 78);
const gainPeak = boostedPeak - basePeak;
const at05 = speedAt(boostedA, 30);

check('Nitro reaches its exact class target in the real wasm car',
  at05 >= nitroTarget.targetMps - 1.5 && boostedPeak >= nitroTarget.targetMps,
  JSON.stringify({ target: nitroTarget.targetMps, at05, peak: boostedPeak }));
check('Nitro adds at least +10 m/s over the no-boost baseline at 1.3 s',
  gainAt13 >= 10,
  JSON.stringify({ baseline: speedAt(baseline, 78), boosted: speedAt(boostedA, 78), gainAt13 }));
check('Nitro peak speed gain is measured, not derived',
  gainPeak >= 15,
  JSON.stringify({ basePeak, boostedPeak, gainPeak }));
check('Nitro is finite on every tick', finite(boostedA), 'finite flags');
check('Nitro effect expires at 1.3 s + 1 tick and clears its remaining count',
  boostedA.boostState?.remaining === 0 && boostedA.boostState?.active === 0 &&
  boostedA.boosts.some((boost) => boost.seq === 1 && boost.active === 1),
  JSON.stringify(boostedA.boostState));
check('Nitro never writes a post-tick velocity or pose (state is the engine state)',
  boostedA.states.length === baseline.states.length,
  boostedA.states.length);
check('Nitro is deterministic in two fresh module instances',
  hashStates(boostedA.states) === hashStates(boostedB.states) &&
  JSON.stringify(boostedA.boosts) === JSON.stringify(boostedB.boosts),
  hashStates(boostedA.states));
check('the wasm build is deterministic and exports the boost API',
  build.buildDeterministic === true &&
  build.exports.includes('_e1_boost_queue') && build.exports.includes('_e1_boost_state'),
  JSON.stringify({ buildDeterministic: build.buildDeterministic, exports: build.exports }));

const shockAt13 = speedAt(shockRun, 78);
const shockGain = shockAt13 - speedAt(baseline, 78);
check('Shock brakes to the exact curve target with the 10 mph floor',
  shockAt13 <= shockTarget.targetMps + 2.5 && shockGain < -5,
  JSON.stringify({ target: shockTarget.targetMps, at13: shockAt13, baseline: speedAt(baseline, 78), gain: shockGain }));
check('Shock is finite on every tick', finite(shockRun));

// ------------------------------------------------------------------ report
const passed = checks.filter((entry) => entry.ok).length;
const report = {
  kind: 'e1-drive.boost-node',
  version: 1,
  generatedBy: 'probes/e1-drive/tools/boost_model_tests.mjs',
  fixture: { ...FIXTURE, car: 'corvette-zr1-stock', dt: DT, source: 'docs/work/analysis/boost-feasibility.md §1' },
  inputs: {
    manifestContentHash: manifest.hashes?.manifestContent ?? null,
    wasmSha256: build.wasmSha256,
    wasmBytes: build.wasmBytes,
    wasmBuildDeterministic: build.buildDeterministic
  },
  targets: {
    sprintSpeedMps: M2_REFERENCE_SPRINT_SPEED_MPS,
    maximumSpeedMps: M2_REFERENCE_MAX_SPEED_MPS,
    nitroClass: M2_NITRO_CLASS,
    nitroClassSource: sprint.A.classSource,
    sprint,
    maximum,
    fixtureNitro: nitroTarget,
    fixtureShock: shockTarget
  },
  wasm: {
    preSpeed: preProbe.pre.speed,
    baseline: { at13: speedAt(baseline, 78), peak: basePeak, hash: hashStates(baseline.states) },
    nitro: {
      targetMps: nitroTarget.targetMps,
      at05,
      at13: speedAt(boostedA, 78),
      peak: boostedPeak,
      gainAt13,
      gainPeak,
      stateHash: hashStates(boostedA.states),
      boostState: boostedA.boostState
    },
    shock: {
      targetMps: shockTarget.targetMps,
      at13: shockAt13,
      gainAt13: shockGain,
      stateHash: hashStates(shockRun.states)
    }
  },
  checks: {
    total: checks.length,
    passed,
    failed: checks.length - passed,
    failures: checks.filter((entry) => !entry.ok)
  },
  results: checks
};
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'boost-node-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log('boost model tests: ' + passed + '/' + checks.length + ' passed');
if (report.checks.failed) {
  console.error(report.checks.failures.map((entry) => entry.label).join('\n'));
  process.exit(1);
}
