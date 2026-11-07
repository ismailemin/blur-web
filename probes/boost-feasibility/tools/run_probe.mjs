// BOOST1 experiment driver.
//
// Runs every candidate on the real wasm car in a fresh module instance, twice,
// and records the measured speed/distance/contact/engine table, the per-tick
// state hashes, and the PWR1 Nitro/Shock references. Outputs:
//   _work/boost-feasibility/experiments.json   full per-run records
//   _work/boost-feasibility/report.json        compact tables + hashes
//   _work/logs/boost-feasibility/run.log        this driver's text log
//
// The module under test is the BOOST1 probe (shipped e1_drive_lib.cpp + hooks);
// no shared file is written.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MODULE = path.join(ROOT, '_work/boost-feasibility/module/boost_probe.mjs');
const OUT = path.join(ROOT, '_work/boost-feasibility');
const LOGS = path.join(ROOT, '_work/logs/boost-feasibility');
const LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics');
const FIELDS = path.join(ROOT, '_work/e1-drive/cars/corvette-zr1-stock.fields');
const POWERUPS = path.join(ROOT, '_work/powerups/powerups.json');

const SPAWN = { x: 281.2833, z: 1823.6890, heading: 0 }; // T-005d collision-oracle fixture ray-random-21
const DT = 1 / 60;
const TICK_HZ = 60;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const stateHash = (states) => 'sha256:' + sha256(states.map((s) => JSON.stringify(s)).join('\n'));
const hdist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

function readManifest() {
  const doc = JSON.parse(readFileSync(POWERUPS, 'utf8'));
  const entity = (label) => doc.entities.find((e) => e.pickupLabel === label);
  const nitrous = entity('Nitrous');
  const shock = entity('Shock');
  return {
    nitrous: {
      duration: nitrous.levels.Normal.balancing.Duration,
      delay: nitrous.levels.Normal.balancing.Delay,
      classModifiers: [
        nitrous.levels.Normal.balancing.ClassAModifier,
        nitrous.levels.Normal.balancing.ClassBModifier,
        nitrous.levels.Normal.balancing.ClassCModifier,
        nitrous.levels.Normal.balancing.ClassDModifier
      ],
      slowDownGraphValue: nitrous.levels.Normal.balancing.SlowDownGraphValue,
      keyframes: nitrous.levels.Normal.balancingGraph.keyframes.map((k) => ({
        t: k.Time, v: k.Value, in: k.InTangent, out: k.OutTangent
      }))
    },
    shock: {
      innerRadius: shock.levels.Normal.balancing.InnerRadius,
      outerRadius: shock.levels.Normal.balancing.OuterRadius,
      lifetime: shock.levels.Normal.balancing.Lifetime,
      damage: shock.levels.Normal.balancing.DamageInflicted,
      delay: shock.levels.Normal.balancing.Delay,
      keyframes: shock.levels.Normal.balancingGraph.keyframes.map((k) => ({
        t: k.Time, v: k.Value, in: k.InTangent, out: k.OutTangent
      }))
    }
  };
}

function rpmBand(keyframes, speedMph) {
  const t = Math.max(0, Math.min(1.3, speedMph / 200));
  let lo = keyframes[0], hi = keyframes[keyframes.length - 1];
  for (let i = 0; i < keyframes.length - 1; i++) {
    if (t >= keyframes[i].t && t <= keyframes[i + 1].t) { lo = keyframes[i]; hi = keyframes[i + 1]; break; }
  }
  return { t, lo, hi, valueLo: lo.v, valueHi: hi.v };
}

// Exact C_HermiteCurve::Evaluate. Source: misc_shared/Curve/HermiteCurve.h:150-200;
// RLDatabase.cpp:428-433 passes the serialized tangents through AddKeyFrame,
// which converts degrees to gradient with tan(deg*pi/180)/3 (HermiteCurve.h:77-82).
function evalHermite(keyframes, position) {
  let ka = 0;
  for (let i = 0; i < keyframes.length; i++) if (keyframes[i].t <= position) ka = i;
  if (ka >= keyframes.length - 1) return keyframes[keyframes.length - 1].v;
  const a = keyframes[ka], b = keyframes[ka + 1];
  const period = b.t - a.t;
  if (period <= 1e-6) return a.v;
  let u = (position - a.t) / period;
  u = Math.max(0, Math.min(1, u));
  const y1 = a.v, y4 = b.v;
  const y2 = y1 + (Math.tan((a.out * Math.PI) / 180) / 3) * period;
  const y3 = y4 - (Math.tan((b.in * Math.PI) / 180) / 3) * period;
  const u2 = u * u, u3 = u2 * u;
  const h1 = -u3 + 3 * u2 - 3 * u + 1;
  const h2 = 3 * u3 - 6 * u2 + 3 * u;
  const h3 = -3 * u3 + 3 * u2;
  const h4 = u3;
  return y1 * h1 + y2 * h2 + y3 * h3 + y4 * h4;
}

function classTargets(keyframes, speedMph, modifiers) {
  const t = speedMph / 200;
  const value = evalHermite(keyframes, t);
  const mph = value * 200;
  return {
    t,
    graphValue: value,
    mph,
    mps: mph * 0.44704,
    classes: modifiers.map((m) => ({
      modifier: m,
      mph: mph * m,
      mps: mph * m * 0.44704
    }))
  };
}

let factory = null;
let levelBytes = null;
let fieldBytes = null;

async function createModule() {
  if (!factory) factory = (await import(pathToFileURL(MODULE).href)).default;
  const module = await factory();
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const ok = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                               SPAWN.x, SPAWN.z, SPAWN.heading);
  if (!ok) throw new Error('e1_create failed: ' + module.UTF8ToString(module._e1_last_error()));
  return module;
}

const read = (m) => JSON.parse(m.UTF8ToString(m._e1_get_state()));
const readExtra = (m) => JSON.parse(m.UTF8ToString(m._b_extra()));

function step(m, throttle) {
  m._e1_set_input(throttle, 0, 0, 0);
  if (!m._b_step()) throw new Error('b_step failed: ' + m.UTF8ToString(m._e1_last_error()));
  return { state: read(m), extra: readExtra(m) };
}

/**
 * One run. `config`:
 *   id, mode, a, b, c, boostTicks, preTicks, postTicks, throttle
 * The returned record keeps every per-tick state in memory for the caller; the
 * caller writes the compact table and the full record.
 */
async function run(config) {
  const m = await createModule();
  const states = [];
  const extras = [];
  const preTicks = config.preTicks ?? 180;
  const boostTicks = config.boostTicks ?? 78;
  const postTicks = config.postTicks ?? 60;
  const throttle = config.throttle ?? 1;

  // settled tick 0
  let s = read(m);
  let e = readExtra(m);
  states.push(s); extras.push(e);
  const tick0 = s;

  for (let i = 0; i < preTicks; i++) {
    const r = step(m, throttle);
    s = r.state; e = r.extra;
    states.push(s); extras.push(e);
  }
  const pre = { state: s, extra: e };
  const prePosition = s.position;

  m._b_set_mode(config.mode ?? 0, config.a ?? 0, config.b ?? 0, config.c ?? 1, boostTicks);
  for (let i = 0; i < boostTicks; i++) {
    const r = step(m, throttle);
    s = r.state; e = r.extra;
    states.push(s); extras.push(e);
  }
  const boostEnd = { state: s, extra: e };

  m._b_set_mode(0, 0, 0, 1, 0); // disarm; reset torque multiplier
  for (let i = 0; i < postTicks; i++) {
    const r = step(m, throttle);
    s = r.state; e = r.extra;
    states.push(s); extras.push(e);
  }
  const end = { state: s, extra: e };

  const edge = states.findIndex((st, i) => i >= preTicks && st.anyContact === 0);
  const maxSpeed = Math.max(...states.map((st) => st.speed));
  const nanTicks = states.filter((st) => st.finite !== 1).length;
  const boostDistance = hdist(prePosition, boostEnd.state.position);
  const totalDistance = hdist(tick0.position, end.state.position);

  return {
    id: config.id,
    config,
    moduleSha256: null,
    tick0: { speed: tick0.speed, position: tick0.position },
    pre: { tick: pre.state.tick, speed: pre.state.speed, rpm: pre.extra.rpm, gear: pre.extra.gear,
           position: pre.state.position, contacts: pre.state.contacts },
    boostEnd: { tick: boostEnd.state.tick, speed: boostEnd.state.speed, rpm: boostEnd.extra.rpm,
                gear: boostEnd.extra.gear, position: boostEnd.state.position, contacts: boostEnd.state.contacts,
                forceN: boostEnd.extra.forceN, dv: boostEnd.extra.dv, stepM: boostEnd.extra.stepM },
    end: { tick: end.state.tick, speed: end.state.speed, rpm: end.extra.rpm, gear: end.extra.gear,
           position: end.state.position, contacts: end.state.contacts },
    gains: {
      preToBoostEnd: boostEnd.state.speed - pre.state.speed,
      preToEnd: end.state.speed - pre.state.speed,
      boostDistanceMetres: boostDistance,
      totalDistanceMetres: totalDistance
    },
    edgeTick: edge < 0 ? null : states[edge].tick,
    maxSpeed,
    nanTicks,
    hashes: {
      stateSequence: stateHash(states),
      stateAndExtraSequence: 'sha256:' + sha256(states.map((s, i) => JSON.stringify(s) + '|' + JSON.stringify(extras[i])).join('\n'))
    },
    states,
    extras
  };
}

function compact(record) {
  const preTicks = record.config.preTicks ?? 180;
  const states = record.states;
  const extras = record.extras;
  const at = (index) => (index >= 0 && index < states.length ? states[index] : null);
  const extraAt = (index) => (index >= 0 && index < extras.length ? extras[index] : null);
  const peak = states.reduce((best, s, i) => (s.speed > best.speed ? { speed: s.speed, tick: s.tick, index: i } : best),
                             { speed: -Infinity, tick: null, index: -1 });
  const wheelMean = (e) => (e ? e.wheelAngular.reduce((a, b) => a + b, 0) / 4 : null);
  const s2 = at(preTicks + 2);
  const e2 = extraAt(preTicks + 2);
  const s13 = at(preTicks + 78);
  const e13 = extraAt(preTicks + 78);
  return {
    id: record.id,
    mode: record.config.mode,
    a: record.config.a,
    b: record.config.b,
    throttle: record.config.throttle ?? 1,
    preTicks,
    boostTicks: record.config.boostTicks ?? 78,
    postTicks: record.config.postTicks ?? 60,
    preSpeed: record.pre.speed,
    speedAfterFirstBoostTick: at(preTicks + 1)?.speed ?? null,
    speedAfterSecondBoostTick: s2?.speed ?? null,
    boostEndSpeed: record.boostEnd.speed,
    speedAt13s: s13?.speed ?? null,
    endSpeed: record.end.speed,
    wheelMeanAfterSecondBoostTick: wheelMean(e2),
    wheelEquivalentSpeedAfterSecondBoostTick: wheelMean(e2) === null ? null : wheelMean(e2) * 0.356,
    peakSpeed: peak.speed,
    peakTick: peak.tick,
    speedGain: record.gains.preToBoostEnd,
    speedGainAt13s: s13 === null ? null : s13.speed - record.pre.speed,
    boostDistance: record.gains.boostDistanceMetres,
    maxSpeed: record.maxSpeed,
    edgeTick: record.edgeTick,
    nanTicks: record.nanTicks,
    stateSequence: record.hashes.stateSequence,
    preToEndGain: record.gains.preToEnd,
    preRpm: record.pre.rpm,
    rpmAfterSecondBoostTick: e2?.rpm ?? null,
    boostEndRpm: record.boostEnd.rpm,
    boostEndGear: record.boostEnd.gear,
    boostEndContacts: record.boostEnd.contacts,
    boostEndForceN: record.boostEnd.forceN,
    boostEndDv: record.boostEnd.dv,
    boostEndStepM: record.boostEnd.stepM
  };
}

mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });
levelBytes = readFileSync(LEVEL);
fieldBytes = readFileSync(FIELDS);

const manifest = readManifest();
const configs = [
  { id: 'baseline', mode: 0 },
  { id: 'input-partial-0.8', mode: 0, throttle: 0.8 },
  { id: 'torque-2.0', mode: 2, a: 2.0 },
  { id: 'torque-5.0', mode: 2, a: 5.0 },
  { id: 'force-target-45', mode: 1, a: 300, b: 45, c: 1, boostTicks: 30 },
  { id: 'force-target-50', mode: 1, a: 300, b: 50, c: 1, boostTicks: 30 },
  { id: 'force-target-55', mode: 1, a: 300, b: 55, c: 1, boostTicks: 30 },
  { id: 'postvel-0.9x30', mode: 3, a: 0.9, boostTicks: 30 },
  { id: 'postvel-27-once', mode: 3, a: 27, boostTicks: 1, postTicks: 120 },
  { id: 'postpose-0.5x30', mode: 4, a: 0.5, boostTicks: 30 },
  { id: 'shock-brake-45mph', mode: 5, a: 300, b: 20.1, c: 0, boostTicks: 30, postTicks: 120 },
  { id: 'shock-brake-45mph-78', mode: 5, a: 300, b: 20.1, c: 0, boostTicks: 78 },
  { id: 'shunt-impulse-forward-20k', mode: 6, a: 20000, c: 1, boostTicks: 1, postTicks: 120 },
  { id: 'shunt-impulse-lateral-10k', mode: 6, a: 10000, c: -1, boostTicks: 1, postTicks: 120 }
];

const records = [];
for (const config of configs) {
  const a = await run(config);
  const b = await run(config);
  records.push({
    ...a,
    repeatHash: b.hashes.stateSequence,
    deterministic: a.hashes.stateSequence === b.hashes.stateSequence,
    repeatStateAndExtraHash: b.hashes.stateAndExtraSequence
  });
  console.log(config.id, compact(a).preSpeed.toFixed(3), '->', compact(a).boostEndSpeed.toFixed(3),
              'gain', compact(a).speedGain.toFixed(3), 'det', a.hashes.stateSequence === b.hashes.stateSequence);
}

// Top-speed reference: full throttle for 300 ticks from the settled state.
const top = await run({ id: 'top-speed', mode: 0, preTicks: 0, boostTicks: 300, postTicks: 0 });
const topRecord = {
  id: 'top-speed',
  maxSpeed: top.maxSpeed,
  speedAt60: top.states[60].speed,
  speedAt120: top.states[120].speed,
  speedAt180: top.states[180].speed,
  speedAt240: top.states[240].speed,
  speedAt300: top.states[300].speed,
  edgeTick: top.states.find((s, i) => i > 0 && s.anyContact === 0)?.tick ?? null,
  nanTicks: top.nanTicks,
  stateSequence: top.hashes.stateSequence
};

// Nitro target bound at the measured sprint speed (24.73 m/s) and at the
// measured straight-line maximum (35.13 m/s). Linear keyframe brackets only:
// the exact RLHermite Evaluate is not recovered, so the bound is reported.
const sprintTopMps = 24.73;
const straightTopMps = 35.1341;
const nitroAtSprint = classTargets(manifest.nitrous.keyframes, sprintTopMps * 2.2369362920544, manifest.nitrous.classModifiers);
const nitroAtStraight = classTargets(manifest.nitrous.keyframes, straightTopMps * 2.2369362920544, manifest.nitrous.classModifiers);
const shockAtSprint = classTargets(manifest.shock.keyframes, sprintTopMps * 2.2369362920544, [1.0]);
const shockClampedMph = Math.min(shockAtSprint.mph, sprintTopMps * 2.2369362920544 - 10);

const report = {
  generatedBy: 'probes/boost-feasibility/tools/run_probe.mjs',
  module: '_work/boost-feasibility/module/boost_probe.wasm',
  spawn: SPAWN,
  car: 'Corvette_ZR1_Stock (record 37, id 1554942492)',
  dt: DT,
  tickHz: TICK_HZ,
  candidateTable: records.map(compact),
  determinism: records.map((r) => ({ id: r.id, stateSequence: r.hashes.stateSequence,
                                      repeatHash: r.repeatHash, deterministic: r.deterministic })),
  topSpeed: topRecord,
  manifest,
  nitroTarget: {
    sprintTopMps,
    sprintTopMph: sprintTopMps * 2.2369362920544,
    straightTopMps,
    straightTopMph: straightTopMps * 2.2369362920544,
    atSprintSpeed: nitroAtSprint,
    atStraightSpeed: nitroAtStraight,
    shockAtSprintSpeed: shockAtSprint,
    shockClampedMph,
    note: 'target speed = classModifier * C_HermiteCurve::Evaluate(speed_mph/200) * 200 mph; the curve is exact (HermiteCurve.h:150-200, tangents converted tan(deg*pi/180)/3 in HermiteCurve.h:77-82); only the car class modifier is not in the e1 roster'
  },
  limits: [
    'one car (Corvette ZR1), one straight fixture (T-005d ray-random-21), one measured build',
    'the probe is temporary harness code; it is not shipped and is not a retail-parity claim',
    'no wall/tunnel test: the fixture straight ends at a road edge, not a wall',
    'multiplayer authority is a design analysis, not a two-browser run'
  ]
};

writeFileSync(path.join(OUT, 'experiments.json'), JSON.stringify({ report, records }, null, 2) + '\n');
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
writeFileSync(path.join(LOGS, 'run.log'), [
  'BOOST1 feasibility run',
  'module ' + path.relative(ROOT, MODULE),
  'level sha256 ' + sha256(readFileSync(LEVEL)),
  'fields sha256 ' + sha256(readFileSync(FIELDS)),
  '',
  ...records.map((r) => JSON.stringify(compact(r))),
  '',
  'top-speed ' + JSON.stringify(topRecord),
  ''
].join('\n'), 'utf8');

console.log('\nTop speed', JSON.stringify(topRecord));
console.log('Nitro target bound at sprint speed', JSON.stringify(nitroAtSprint));
console.log('Nitro target bound at straight speed', JSON.stringify(nitroAtStraight));
console.log('\nwrote', path.join(OUT, 'report.json'));
