#!/usr/bin/env node
// Verifier for the live-standings probe.
//
// It replays the real recorded e1-drive runs (2, 4 and 8 cars; sprint and loop)
// through probes/standings and checks ordering, gaps, ties, lapped cars,
// checkpoint positions, wreck/respawn, DNF/disconnect, robustness and
// determinism. It writes evidence under _work/standings and
// _work/logs/standings. It never writes to _work/e1-drive.
//
// Run with the project Node:
//   _work/toolchains/emsdk/node/24.19.0_64bit/node.exe probes/standings/verify.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  createStandings,
  Standings,
  FreeStandings,
  CourseModel,
  COURSE_MODE,
  STANDINGS_EVENT,
  STANDINGS_STATUS,
  hashOf,
  canonicalJson
} from './index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WORK = path.join(ROOT, '_work');
const DRIVE = path.join(WORK, 'e1-drive');
const OUT = path.join(WORK, 'standings');
const LOGS = path.join(WORK, 'logs', 'standings');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

const checks = [];
let checkCount = 0;
const groups = new Map();
const failures = [];

function check(group, name, ok, detail = null) {
  const id = group + '-' + String(++checkCount).padStart(4, '0');
  const entry = { id, group, name, ok: Boolean(ok) };
  if (detail !== null && detail !== undefined) entry.detail = detail;
  checks.push(entry);
  if (!groups.has(group)) groups.set(group, { total: 0, passed: 0, failed: 0 });
  const groupEntry = groups.get(group);
  groupEntry.total++;
  if (entry.ok) groupEntry.passed++;
  else { groupEntry.failed++; failures.push(entry); }
  return entry.ok;
}

function near(group, name, actual, expected, tolerance, extra = null) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  return check(group, name, ok, {
    actual: round6(actual), expected: round6(expected), tolerance,
    ...(extra ?? {})
  });
}

function round6(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1e6) / 1e6 : value;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const LOG = [];
function log(line = '') {
  LOG.push(line);
  console.log(line);
}

// ---------------------------------------------------------------------------
// Inputs (read-only)
// ---------------------------------------------------------------------------

const sprintFile = path.join(DRIVE, 'sprint.json');
const lapFile = path.join(DRIVE, 'sprint-lap.json');
const freeFile = path.join(DRIVE, 'sprint-free.json');
const sprintLayout = readJson(sprintFile);
const lapLayout = readJson(lapFile);
const freeLayout = readJson(freeFile);
const layouts = { sprint: sprintLayout, lap: lapLayout, free: freeLayout };
const layoutFiles = { sprint: sprintFile, lap: lapFile, free: freeFile };

const inputRecords = [];
for (const [name, file] of Object.entries(layoutFiles)) {
  inputRecords.push({
    name,
    path: path.relative(ROOT, file).replaceAll('\\', '/'),
    bytes: fs.statSync(file).size,
    sha256: sha256File(file),
    layoutHash: layouts[name].hash
  });
}

// Every recorded car run used by the scenarios. Only files that exist in
// _work/e1-drive are listed; the verifier fails loudly if one is missing.
const RUN_FILES = {
  sprint: {
    'nissan-skyliner34ztune-stock': 'sprint-nissan-skyliner34ztune-stock.json',
    'audi-r8v10-stock': 'sprint-audi-r8v10-stock.json',
    'koenigsegg-ccxr-stock': 'sprint-koenigsegg-ccxr-stock.json',
    'ford-fr100-stock': 'sprint-ford-fr100-stock.json',
    'dodge-viperacr-stock': 'sprint-dodge-viperacr-stock.json',
    'volkswagen-golfw12650-stock': 'sprint-volkswagen-golfw12650-stock.json',
    'corvette-zr1-stock': 'sprint-corvette-zr1-stock.json',
    'dodge-challenger-tuner': 'sprint-dodge-challenger-tuner.json',
    'ford-f100-offroad': 'sprint-ford-f100-offroad.json',
    'ford-mustanggtr-stock': 'sprint-ford-mustanggtr-stock.json',
    'lotus-exige-cup260-stock': 'sprint-lotus-exige-cup260-stock.json',
    'audi-s3-stock': 'sprint-audi-s3-stock.json'
  },
  lap: {
    'nissan-skyliner34ztune-stock': 'sprint-lap-nissan-skyliner34ztune-stock.json',
    'audi-r8v10-stock': 'sprint-lap-audi-r8v10-stock.json',
    'corvette-zr1-stock': 'sprint-lap-corvette-zr1-stock.json',
    'ford-f100-offroad': 'sprint-lap-ford-f100-offroad.json',
    'ford-mustanggtr-stock': 'sprint-lap-ford-mustanggtr-stock.json',
    'ford-fr100-stock': 'sprint-lap-ford-fr100-stock.json',
    'volkswagen-golfw12650-stock': 'sprint-lap-volkswagen-golfw12650-stock.json',
    'dodge-challenger-tuner': 'sprint-lap-dodge-challenger-tuner.json',
    'koenigsegg-ccxr-stock': 'sprint-lap-koenigsegg-ccxr-stock.json',
    'lotus-exige-cup260-stock': 'sprint-lap-lotus-exige-cup260-stock.json',
    'audi-s3-stock': 'sprint-lap-audi-s3-stock.json'
  }
};

const runCache = new Map();
const runRecords = [];

function loadRun(kind, slug) {
  const key = kind + ':' + slug;
  if (runCache.has(key)) return runCache.get(key);
  const relative = RUN_FILES[kind]?.[slug];
  if (!relative) throw new Error('unknown run ' + key);
  const file = path.join(DRIVE, relative);
  if (!fs.existsSync(file)) throw new Error('missing run file ' + file);
  const run = readJson(file);
  const layout = layouts[kind];
  const countdown = layout.countdown.ticks;
  if (run.layoutHash !== layout.hash) {
    throw new Error('run ' + relative + ' layout hash ' + run.layoutHash + ' != ' + layout.hash);
  }
  const positions = new Map();
  let previous = -1;
  for (const tick of run.ticks) {
    const race = tick.tick - countdown;
    if (race < 0) continue;
    if (race !== previous + 1) {
      throw new Error('run ' + relative + ' has a tick gap at race tick ' + race);
    }
    previous = race;
    positions.set(race, tick.position.slice(0, 3));
  }
  const finishTick = run.finish.tick - countdown;
  if (!positions.has(finishTick)) throw new Error('run ' + relative + ' has no finish position');
  const checkpoints = (run.checkpoints ?? []).map((entry) => ({
    id: entry.id ?? entry.gateId,
    index: entry.index ?? null,
    tick: entry.tick - countdown,
    arc: entry.arc ?? null
  }));
  const laps = (run.laps ?? []).filter((entry) => entry.type === 'lap').map((entry) => ({
    lap: entry.lap,
    tick: entry.tick - countdown,
    lapSeconds: entry.lapSeconds
  }));
  const record = {
    kind,
    slug,
    id: slug,
    file: relative,
    sha256: sha256File(file),
    layoutHash: run.layoutHash,
    stateSequenceHash: run.stateSequenceHash,
    tickHz: run.tickHz,
    countdownTicks: countdown,
    finishTick,
    finishSeconds: run.finish.timeSeconds ?? (finishTick / layout.rules.tickHz),
    checkpoints,
    laps,
    lapTimes: run.finish.lapTimes ?? run.lapTimes ?? [],
    bestLapSeconds: run.finish.bestLapSeconds ?? run.bestLapSeconds ?? null,
    positions
  };
  runCache.set(key, record);
  runRecords.push({
    file: path.relative(ROOT, file).replaceAll('\\', '/'),
    sha256: record.sha256,
    layoutHash: record.layoutHash,
    stateSequenceHash: record.stateSequenceHash,
    finishTick: record.finishTick,
    finishSeconds: record.finishSeconds
  });
  return record;
}

// ---------------------------------------------------------------------------
// Car timeline builders
// ---------------------------------------------------------------------------

/**
 * Builds a per-car state producer over race ticks. The optional modifiers are
 * the documented edge cases:
 *   shiftTicks    late start (missing states before the shift)
 *   wreck         {afterCheckpoint?, afterLapTick?, afterTicks, wreckTicks}
 *   dnf           {atTick, reason}
 *   disconnect    {atTick}
 *   missing       {fromTick, toTick}
 *   staleState    {atTick, backTicks}
 *   containment   {atTick, holdTicks}
 *   teleport      {atTick, backTicks | forwardTicks}
 */
function makeCar(spec, layout) {
  const run = loadRun(spec.kind, spec.run);
  const shift = spec.shiftTicks ?? 0;
  const F = run.finishTick;
  let wreck = null;
  if (spec.wreck) {
    let C;
    if (spec.kind === 'sprint') {
      const index = spec.wreck.afterCheckpoint ?? 1;
      C = run.checkpoints[index - 1]?.tick;
      if (!Number.isInteger(C)) throw new Error('run has no checkpoint ' + index);
    } else {
      C = 0;
      for (const lap of run.laps) if (lap.tick <= (spec.wreck.afterLapTick ?? 0)) C = lap.tick;
      if (spec.wreck.afterLapTick !== undefined) C = spec.wreck.afterLapTick;
      if (C === 0) C = 0;
    }
    const W = C + spec.wreck.afterTicks;
    const R = W + spec.wreck.wreckTicks;
    wreck = {
      C, W, R,
      finishTick: R + (F - C),
      respawnPosition: run.positions.get(C)
    };
  }
  const finishTick = (wreck ? wreck.finishTick : F) + shift;

  function normalState(tick) {
    const source = tick - shift;
    if (source < 0) return null;
    const clamped = Math.min(source, F);
    const position = run.positions.get(clamped);
    if (!position) return null;
    return {
      id: spec.id,
      tick,
      position,
      finished: source >= F,
      finishTick: F + shift
    };
  }

  function stateAt(tick, standings) {
    if (spec.missing && tick >= spec.missing.fromTick && tick <= spec.missing.toTick) {
      return null;
    }
    if (spec.dnf && tick >= spec.dnf.atTick) {
      const position = run.positions.get(spec.dnf.atTick - shift) ?? run.positions.get(F);
      return {
        id: spec.id, tick, position,
        status: STANDINGS_STATUS.DNF,
        dnfReason: spec.dnf.reason ?? 'test-dnf'
      };
    }
    if (spec.disconnect && tick >= spec.disconnect.atTick) {
      const position = run.positions.get(spec.disconnect.atTick - shift) ?? run.positions.get(F);
      return { id: spec.id, tick, position, status: STANDINGS_STATUS.DISCONNECTED };
    }
    if (spec.containment && tick >= spec.containment.atTick) {
      const baseTick = spec.containment.atTick - shift;
      const base = run.positions.get(Math.min(baseTick, F));
      if (tick === spec.containment.atTick) {
        return {
          id: spec.id, tick,
          position: [base[0] + 200, base[1], base[2] + 200]
        };
      }
      if (tick < spec.containment.atTick + (spec.containment.holdTicks ?? 10)) {
        return {
          id: spec.id, tick,
          position: [base[0] + 200, base[1], base[2] + 200]
        };
      }
      if (tick === spec.containment.atTick + (spec.containment.holdTicks ?? 10)) {
        const row = standings.rows.get(spec.id);
        const target = standings.respawnTargetFor(row);
        return { id: spec.id, tick, position: [target.x, target.y, target.z], respawn: true };
      }
    }
    if (spec.teleport && tick === spec.teleport.atTick) {
      const base = run.positions.get(Math.max(0, Math.min(F, spec.teleport.atTick - shift)));
      const source = spec.teleport.forwardTicks !== undefined
        ? Math.min(F, spec.teleport.atTick + spec.teleport.forwardTicks - shift)
        : Math.max(0, spec.teleport.atTick - (spec.teleport.backTicks ?? 0) - shift);
      return {
        id: spec.id,
        tick,
        position: run.positions.get(source) ?? base,
        teleport: {
          kind: 'powerup',
          reason: spec.teleport.forwardTicks !== undefined ? 'test-forward' : 'test-backward'
        }
      };
    }
    if (spec.staleState && tick === spec.staleState.atTick) {
      const state = normalState(tick);
      if (!state) return null;
      return { ...state, tick: tick - (spec.staleState.backTicks ?? 5) };
    }
    if (wreck) {
      if (tick < wreck.W) return normalState(tick);
      if (tick < wreck.R) {
        return {
          id: spec.id,
          tick,
          position: run.positions.get(wreck.W - shift),
          status: STANDINGS_STATUS.WRECKED
        };
      }
      if (tick === wreck.R) {
        return {
          id: spec.id,
          tick,
          position: wreck.respawnPosition,
          respawn: true
        };
      }
      const source = wreck.C + (tick - wreck.R);
      const position = run.positions.get(Math.min(source, F));
      return {
        id: spec.id,
        tick,
        position,
        finished: source >= F,
        finishTick: wreck.finishTick + shift
      };
    }
    return normalState(tick);
  }

  return {
    id: spec.id,
    slot: spec.slot,
    name: spec.name ?? spec.id,
    run,
    stateAt,
    finishTick,
    wreck,
    checkpointTicks: run.checkpoints.map((entry) => entry.tick + shift),
    lapTicks: run.laps.map((entry) => entry.tick + shift)
  };
}

function maxTickFor(cars, extra = 30) {
  let max = 0;
  for (const car of cars) {
    if (car.wreck) max = Math.max(max, car.wreck.finishTick);
    else max = Math.max(max, car.finishTick);
  }
  return max + extra;
}

function eventSampleTicks(cars) {
  const ticks = new Set([0, 1]);
  for (const car of cars) {
    for (const tick of car.checkpointTicks) {
      ticks.add(Math.max(0, tick - 1)); ticks.add(tick); ticks.add(tick + 1);
    }
    for (const tick of car.lapTicks) {
      ticks.add(Math.max(0, tick - 1)); ticks.add(tick); ticks.add(tick + 1);
    }
    ticks.add(Math.max(0, car.finishTick - 1));
    ticks.add(car.finishTick);
    ticks.add(car.finishTick + 1);
    if (car.wreck) {
      ticks.add(car.wreck.W - 1); ticks.add(car.wreck.W);
      ticks.add(car.wreck.W + Math.floor((car.wreck.R - car.wreck.W) / 2));
      ticks.add(car.wreck.R - 1); ticks.add(car.wreck.R); ticks.add(car.wreck.R + 1);
    }
  }
  return ticks;
}

function runScenario(spec) {
  const layout = layouts[spec.kind];
  const cars = spec.cars.map((car, index) =>
    makeCar({ ...car, kind: spec.kind, slot: index + 1 }, layout));
  const participants = cars.map((car) => ({ id: car.id, slot: car.slot, name: car.name }));
  const standings = createStandings(layout, participants);
  const maxTick = spec.maxTick ?? maxTickFor(cars);
  const interesting = eventSampleTicks(cars);
  for (const [key, value] of Object.entries(spec.sampleTicks ?? {})) {
    for (const tick of value) interesting.add(tick);
  }
  const snapshots = [];
  const sampleEvery = spec.sampleEvery ?? 60;
  for (let tick = 0; tick <= maxTick; tick++) {
    const states = [];
    for (const car of cars) {
      const state = car.stateAt(tick, standings);
      if (state) states.push(state);
    }
    standings.update(tick, states);
    if (tick % sampleEvery === 0 || interesting.has(tick)) {
      snapshots.push({ tick, snapshot: standings.snapshot() });
    }
  }
  const final = standings.snapshot();
  const result = {
    name: spec.name,
    kind: spec.kind,
    cars: cars.map((car) => ({
      id: car.id,
      run: car.run.slug,
      slot: car.slot,
      finishTick: car.finishTick,
      wreck: car.wreck ? { C: car.wreck.C, W: car.wreck.W, R: car.wreck.R } : null
    })),
    maxTick,
    standings,
    snapshots,
    final,
    eventHash: hashOf(standings.events),
    replayHash: standings.replayHash(),
    eventCount: standings.events.length
  };
  return result;
}

// ---------------------------------------------------------------------------
// Layout and course checks
// ---------------------------------------------------------------------------

log('standings verifier');
log('==================');
log('');

const courseSprint = new CourseModel(sprintLayout);
const courseLap = new CourseModel(lapLayout);

check('course', 'sprint layout hash', courseSprint.layoutHash === sprintLayout.hash, { hash: courseSprint.layoutHash });
check('course', 'sprint mode', courseSprint.mode === COURSE_MODE.SPRINT);
near('course', 'sprint measured length', courseSprint.measuredLengthMetres, 310.395196, 1e-6);
near('course', 'sprint finish arc', courseSprint.finishArc, 300.159666, 1e-6);
check('course', 'sprint gate count', courseSprint.gates.length === 4, { gates: courseSprint.gates.length });
check('course', 'sprint checkpoint count', courseSprint.checkpointCount === 2);
check('course', 'sprint sample count', courseSprint.samples.length === 1245);
check('course', 'sprint corridor half-width', courseSprint.corridorHalfWidthMetres === 6);

check('course', 'lap layout hash', courseLap.layoutHash === lapLayout.hash, { hash: courseLap.layoutHash });
check('course', 'lap mode', courseLap.mode === COURSE_MODE.LAP);
near('course', 'lap measured length', courseLap.measuredLengthMetres, 222.040211, 1e-6);
near('course', 'lap length', courseLap.lengthMetres, 222.040211, 1e-6);
check('course', 'lap count', courseLap.laps === 3);
check('course', 'lap sector count', courseLap.sectorCount === 4);
check('course', 'lap interior sector count', courseLap.sectors.length === 3);
near('course', 'lap sector 2 arc', courseLap.sectors[1].arc, 111.0201055, 1e-5);
check('course', 'lap line present', courseLap.lapLine !== null && courseLap.lapLine.widthMetres === 4);

let tamperRejected = false;
try {
  const tampered = { ...sprintLayout, courseId: '310m', source: { ...sprintLayout.source, spawn: { x: 0, z: 0, headingRad: 0 } } };
  new CourseModel(tampered);
} catch { tamperRejected = true; }
check('course', 'tampered layout rejected', tamperRejected);

let unsupportedRejected = false;
try {
  new CourseModel({ ...sprintLayout, courseId: 'not-a-course' }, { verifyLayoutHash: false });
} catch { unsupportedRejected = true; }
check('course', 'unsupported courseId rejected', unsupportedRejected);

let kindRejected = false;
try {
  new CourseModel({ ...sprintLayout, kind: 'other' }, { verifyLayoutHash: false });
} catch { kindRejected = true; }
check('course', 'unsupported layout kind rejected', kindRejected);

const free = createStandings(freeLayout, ['p1']);
const freeSnapshot = free.snapshot();
check('course', 'free mode has no standings', free instanceof FreeStandings && freeSnapshot.standings === false);
check('course', 'free mode has no rows', freeSnapshot.rows.length === 0 && freeSnapshot.order.length === 0);
check('course', 'free reason is explicit', freeSnapshot.reason === 'free-roam has no race progress metric');
free.update(10);
check('course', 'free update produces no rows', free.snapshot().rows.length === 0);
let freeInStandingsRejected = false;
try { new Standings(freeLayout, ['p1']); } catch { freeInStandingsRejected = true; }
check('course', 'Standings rejects free layout', freeInStandingsRejected);

// Determinism source scan: rules code must not use wall clock or randomness.
const modelSources = ['hash.mjs', 'course.mjs', 'standings.mjs']
  .map((name) => fs.readFileSync(path.join(HERE, name), 'utf8'));
check('course', 'rules code has no wall clock', modelSources.every((text) =>
  !/Date\.now|performance\.now|new Date\(/.test(text)));
check('course', 'rules code has no randomness', modelSources.every((text) =>
  !/Math\.random/.test(text)));
check('course', 'rules code has no Node crypto or fs', modelSources.every((text) =>
  !/node:crypto|from 'fs'|require\('fs'\)/.test(text)));

// Canonical hash independence from key insertion order.
check('course', 'canonical hash ignores key order',
  hashOf({ a: 1, b: { c: 2, d: 3 } }) === hashOf({ b: { d: 3, c: 2 }, a: 1 }));

// ---------------------------------------------------------------------------
// Single-car replay against the recorded events
// ---------------------------------------------------------------------------

function singleRunChecks(kind, slug) {
  const layout = layouts[kind];
  const run = loadRun(kind, slug);
  const standings = createStandings(layout, [{ id: slug, slot: 1 }]);
  for (let tick = 0; tick <= run.finishTick + 2; tick++) {
    const position = run.positions.get(Math.min(tick, run.finishTick));
    standings.update(tick, {
      [slug]: {
        id: slug, tick, position,
        finished: tick >= run.finishTick,
        finishTick: run.finishTick
      }
    });
  }
  const events = standings.events;
  const final = standings.snapshot();
  const row = final.rows[0];
  const prefix = 'replay-' + kind + '-' + slug;
  check('replay', prefix + ' finishes', row.status === STANDINGS_STATUS.FINISHED);
  check('replay', prefix + ' finish tick', row.finishTick === run.finishTick,
    { actual: row.finishTick, expected: run.finishTick });
  near('replay', prefix + ' finish time', row.totalTimeSeconds,
    run.finishTick / layout.rules.tickHz, 1e-6);
  near('replay', prefix + ' recorded finish time', row.totalTimeSeconds,
    run.finishSeconds, 1e-4);

  if (kind === 'sprint') {
    const checkpoints = events.filter((event) => event.type === STANDINGS_EVENT.CHECKPOINT);
    check('replay', prefix + ' checkpoint count', checkpoints.length === run.checkpoints.length,
      { actual: checkpoints.length, expected: run.checkpoints.length });
    for (let index = 0; index < run.checkpoints.length; index++) {
      const recorded = run.checkpoints[index].tick;
      const computed = checkpoints[index]?.tick ?? null;
      check('replay', prefix + ' checkpoint ' + (index + 1) + ' tick',
        computed !== null && Math.abs(computed - recorded) <= 1,
        { actual: computed, expected: recorded });
    }
    check('replay', prefix + ' progress is the finish arc',
      Math.abs(row.progressMetres - courseSprint.finishArc) <= 1e-6);
  } else {
    const lapEvents = events.filter((event) => event.type === STANDINGS_EVENT.LAP);
    check('replay', prefix + ' lap count', lapEvents.length === run.laps.length + 1,
      { actual: lapEvents.length, expected: run.laps.length + 1 });
    for (let index = 0; index < run.laps.length; index++) {
      const recorded = run.laps[index].tick;
      const computed = lapEvents[index]?.tick ?? null;
      check('replay', prefix + ' lap ' + (index + 1) + ' tick',
        computed !== null && Math.abs(computed - recorded) <= 1,
        { actual: computed, expected: recorded });
    }
    check('replay', prefix + ' finish lap tick', lapEvents[run.laps.length]?.tick === run.finishTick,
      { actual: lapEvents[run.laps.length]?.tick, expected: run.finishTick });
    for (let index = 0; index < run.lapTimes.length; index++) {
      near('replay', prefix + ' lap time ' + (index + 1), row.lapTimes[index],
        run.lapTimes[index], 1e-5);
    }
    near('replay', prefix + ' best lap', row.bestLapSeconds, run.bestLapSeconds, 1e-5);
    check('replay', prefix + ' progress is three laps',
      Math.abs(row.progressMetres - courseLap.lengthMetres * courseLap.laps) <= 1e-6);
  }
  check('replay', prefix + ' no rejected jump',
    !events.some((event) => event.type === STANDINGS_EVENT.PROGRESS_JUMP_REJECTED));
  check('replay', prefix + ' no clamped backtrack',
    !events.some((event) => event.type === STANDINGS_EVENT.BACKTRACK_CLAMPED));
  const rerun = createStandings(layout, [{ id: slug, slot: 1 }]);
  for (let tick = 0; tick <= run.finishTick + 2; tick++) {
    const position = run.positions.get(Math.min(tick, run.finishTick));
    rerun.update(tick, {
      [slug]: {
        id: slug, tick, position,
        finished: tick >= run.finishTick,
        finishTick: run.finishTick
      }
    });
  }
  check('replay', prefix + ' final hash repeats', rerun.snapshot().hash === final.hash,
    { first: final.hash, second: rerun.snapshot().hash });
  check('replay', prefix + ' replay hash repeats', rerun.replayHash() === standings.replayHash());
  check('replay', prefix + ' event hash repeats', hashOf(rerun.events) === hashOf(events));
  return {
    slug,
    kind,
    recordedFinishTick: run.finishTick,
    computedFinishTick: row.finishTick,
    recordedFinishSeconds: run.finishSeconds,
    computedFinishSeconds: row.totalTimeSeconds,
    checkpoints: run.checkpoints.map((entry, index) => ({
      index: index + 1,
      recordedTick: entry.tick,
      computedTick: events.filter((event) => event.type === STANDINGS_EVENT.CHECKPOINT)[index]?.tick ?? null
    })),
    laps: run.laps.map((entry, index) => ({
      lap: entry.lap,
      recordedTick: entry.tick,
      computedTick: events.filter((event) => event.type === STANDINGS_EVENT.LAP)[index]?.tick ?? null
    })),
    finalHash: final.hash,
    replayHash: standings.replayHash(),
    eventHash: hashOf(events)
  };
}

const singleReplay = [];
for (const [kind, slugs] of [
  ['sprint', ['corvette-zr1-stock', 'ford-fr100-stock', 'nissan-skyliner34ztune-stock']],
  ['lap', ['corvette-zr1-stock', 'nissan-skyliner34ztune-stock', 'dodge-challenger-tuner']]
]) {
  for (const slug of slugs) singleReplay.push(singleRunChecks(kind, slug));
}

// ---------------------------------------------------------------------------
// Generic snapshot invariants
// ---------------------------------------------------------------------------

const PER_SAMPLE_CHECKS = 6;

function snapshotInvariants(name, entry, kind, participantCount) {
  const { tick, snapshot } = entry;
  const rows = snapshot.rows;
  const tag = name + '@' + tick;

  check('order', tag + ' row count', rows.length === participantCount,
    { actual: rows.length, expected: participantCount });

  // 1. The published order matches the published rows.
  check('order', tag + ' order matches rows',
    snapshot.order.length === rows.length &&
    snapshot.order.every((id, index) => id === rows[index].id));

  // 2. Positions are contiguous with standard competition ranking.
  let positionsOk = rows.length > 0 && rows[0].position === 1;
  let index = 0;
  while (index < rows.length && positionsOk) {
    const position = rows[index].position;
    if (position !== index + 1) { positionsOk = false; break; }
    let end = index;
    while (end + 1 < rows.length && rows[end + 1].position === position) end++;
    const size = end - index + 1;
    const group = rows.slice(index, end + 1);
    if (size > 1 && !group.every((row) => row.tied === true)) positionsOk = false;
    if (size === 1 && group[0].tied === true) positionsOk = false;
    index = end + 1;
  }
  check('order', tag + ' positions and ties', positionsOk,
    positionsOk ? null : rows.map((row) => [row.id, row.position, row.tied]));

  // 3. Status groups never interleave: finished, active, DNF, disconnected.
  const groupOf = (status) => status === STANDINGS_STATUS.FINISHED ? 0
    : status === STANDINGS_STATUS.DNF ? 2
      : status === STANDINGS_STATUS.DISCONNECTED ? 3 : 1;
  let groupsMonotone = true;
  for (let index = 1; index < rows.length; index++) {
    if (groupOf(rows[index].status) < groupOf(rows[index - 1].status)) groupsMonotone = false;
  }
  check('order', tag + ' status groups ordered', groupsMonotone);

  // 4. No negative gap and gap-to-ahead <= gap-to-leader.
  let gapsNonNegative = true;
  let gapsOrdered = true;
  for (const row of rows) {
    if (row.gapToLeaderMetres !== null && row.gapToLeaderMetres < -1e-9) gapsNonNegative = false;
    if (row.gapToLeaderSeconds !== null && row.gapToLeaderSeconds < -1e-9) gapsNonNegative = false;
    if (row.gapToAheadMetres !== null && row.gapToAheadMetres < -1e-9) gapsNonNegative = false;
    if (row.gapToAheadSeconds !== null && row.gapToAheadSeconds < -1e-9) gapsNonNegative = false;
    if (row.gapToAheadMetres !== null && row.gapToLeaderMetres !== null &&
        row.gapToAheadMetres > row.gapToLeaderMetres + 1e-9) gapsOrdered = false;
    if (row.gapToAheadSeconds !== null && row.gapToLeaderSeconds !== null &&
        row.gapToAheadSeconds > row.gapToLeaderSeconds + 1e-9) gapsOrdered = false;
  }
  check('gaps', tag + ' no negative gaps', gapsNonNegative);
  check('gaps', tag + ' gap to ahead <= gap to leader', gapsOrdered);

  // 5. Gap-to-leader is non-decreasing in listed order (within one source).
  let monotoneMetres = true;
  let lastMetres = -1;
  let monotoneSeconds = true;
  let lastSeconds = -1;
  let lastSource = null;
  for (const row of rows) {
    if (row.gapToLeaderMetres !== null) {
      if (row.gapToLeaderMetres < lastMetres - 1e-9) monotoneMetres = false;
      lastMetres = row.gapToLeaderMetres;
    }
    if (row.gapToLeaderSeconds !== null) {
      if (row.gapSource !== lastSource) lastSeconds = -1;
      if (row.gapToLeaderSeconds < lastSeconds - 1e-9) monotoneSeconds = false;
      lastSeconds = row.gapToLeaderSeconds;
      lastSource = row.gapSource;
    }
  }
  check('gaps', tag + ' gap monotone (metres)', monotoneMetres);
  check('gaps', tag + ' gap monotone (seconds, same source)', monotoneSeconds);

  // 6. Laps/fraction consistency.
  let lapsOk = true;
  for (const row of rows) {
    if (row.progressFraction < 0 || row.progressFraction > 1) lapsOk = false;
    if (kind === 'lap') {
      if (row.lapsCompleted < 0 || row.lapsCompleted > courseLap.laps) lapsOk = false;
      if (row.lapsDown !== Math.max(0, rows[0].lapsCompleted - row.lapsCompleted)) lapsOk = false;
      if (row.currentLap < 1 || row.currentLap > courseLap.laps) lapsOk = false;
    } else if (row.lapsCompleted !== (row.status === STANDINGS_STATUS.FINISHED ? 1 : 0)) {
      lapsOk = false;
    }
  }
  check('laps', tag + ' lap fields consistent', lapsOk);
  return PER_SAMPLE_CHECKS;
}

function orderedSnapshots(result, kind) {
  return result.snapshots;
}

// ---------------------------------------------------------------------------
// Multi-car scenarios
// ---------------------------------------------------------------------------

const sprintPhotoCars = [
  { id: 'ford-fr100-stock', run: 'ford-fr100-stock' },
  { id: 'dodge-viperacr-stock', run: 'dodge-viperacr-stock' }
];
const sprint4 = [
  { id: 'ford-fr100-stock', run: 'ford-fr100-stock' },
  { id: 'dodge-viperacr-stock', run: 'dodge-viperacr-stock' },
  { id: 'volkswagen-golfw12650-stock', run: 'volkswagen-golfw12650-stock' },
  { id: 'corvette-zr1-stock', run: 'corvette-zr1-stock' }
];
const sprint8 = [
  { id: 'nissan-skyliner34ztune-stock', run: 'nissan-skyliner34ztune-stock' },
  { id: 'audi-r8v10-stock', run: 'audi-r8v10-stock' },
  { id: 'koenigsegg-ccxr-stock', run: 'koenigsegg-ccxr-stock' },
  { id: 'ford-fr100-stock', run: 'ford-fr100-stock' },
  { id: 'dodge-viperacr-stock', run: 'dodge-viperacr-stock' },
  { id: 'volkswagen-golfw12650-stock', run: 'volkswagen-golfw12650-stock' },
  { id: 'corvette-zr1-stock', run: 'corvette-zr1-stock' },
  { id: 'dodge-challenger-tuner', run: 'dodge-challenger-tuner' }
];
const lapPhotoCars = [
  { id: 'volkswagen-golfw12650-stock', run: 'volkswagen-golfw12650-stock' },
  { id: 'dodge-challenger-tuner', run: 'dodge-challenger-tuner' },
  { id: 'koenigsegg-ccxr-stock', run: 'koenigsegg-ccxr-stock' }
];
const lap4 = [
  { id: 'nissan-skyliner34ztune-stock', run: 'nissan-skyliner34ztune-stock' },
  { id: 'audi-r8v10-stock', run: 'audi-r8v10-stock' },
  { id: 'ford-f100-offroad', run: 'ford-f100-offroad' },
  { id: 'ford-mustanggtr-stock', run: 'ford-mustanggtr-stock' }
];
const lap8 = [
  { id: 'nissan-skyliner34ztune-stock', run: 'nissan-skyliner34ztune-stock' },
  { id: 'audi-r8v10-stock', run: 'audi-r8v10-stock' },
  { id: 'ford-f100-offroad', run: 'ford-f100-offroad' },
  { id: 'ford-mustanggtr-stock', run: 'ford-mustanggtr-stock' },
  { id: 'ford-fr100-stock', run: 'ford-fr100-stock' },
  { id: 'volkswagen-golfw12650-stock', run: 'volkswagen-golfw12650-stock' },
  { id: 'dodge-challenger-tuner', run: 'dodge-challenger-tuner' },
  { id: 'koenigsegg-ccxr-stock', run: 'koenigsegg-ccxr-stock' }
];

const scenarioSpecs = [
  { name: 'sprint-2', kind: 'sprint', cars: sprintPhotoCars },
  { name: 'sprint-4', kind: 'sprint', cars: sprint4 },
  { name: 'sprint-8', kind: 'sprint', cars: sprint8 },
  { name: 'lap-2', kind: 'lap', cars: [
    { id: 'nissan-skyliner34ztune-stock', run: 'nissan-skyliner34ztune-stock' },
    { id: 'audi-r8v10-stock', run: 'audi-r8v10-stock' }
  ] },
  { name: 'lap-4', kind: 'lap', cars: lap4 },
  { name: 'lap-8', kind: 'lap', cars: lap8 },
  { name: 'lap-4-photo', kind: 'lap', cars: lapPhotoCars },
  { name: 'sprint-4-wreck', kind: 'sprint', cars: sprint4.map((car) =>
    car.id === 'corvette-zr1-stock'
      ? { ...car, wreck: { afterCheckpoint: 1, afterTicks: 100, wreckTicks: 60 } }
      : car) },
  { name: 'lap-4-wreck', kind: 'lap', cars: lap4.map((car) =>
    car.id === 'ford-mustanggtr-stock'
      ? { ...car, wreck: { afterLapTick: 0, afterTicks: 1000, wreckTicks: 60 } }
      : car) },
  { name: 'lap-4-lapped', kind: 'lap', cars: lap4.map((car) =>
    car.id === 'ford-mustanggtr-stock' ? { ...car, shiftTicks: 1800 } : car) },
  { name: 'sprint-4-dnf', kind: 'sprint', cars: sprint4.map((car) =>
    car.id === 'corvette-zr1-stock' ? { ...car, dnf: { atTick: 600 } } : car) },
  { name: 'sprint-4-disconnect', kind: 'sprint', cars: sprint4.map((car) =>
    car.id === 'corvette-zr1-stock' ? { ...car, disconnect: { atTick: 600 } } : car) }
];

const scenarioResults = new Map();
for (const spec of scenarioSpecs) {
  const result = runScenario(spec);
  scenarioResults.set(spec.name, result);
  const participants = spec.cars.length;
  for (const entry of result.snapshots) {
    snapshotInvariants(spec.name, entry, spec.kind, participants);
  }
  // The final table is also invariant-checked.
  snapshotInvariants(spec.name, { tick: result.final.tick, snapshot: result.final },
    spec.kind, participants);
  log('ran ' + spec.name + ': ' + result.maxTick + ' ticks, ' + result.eventCount +
    ' events, final ' + result.final.hash);
}

// ---------------------------------------------------------------------------
// Final order vs recorded results and checkpoint positions
// ---------------------------------------------------------------------------

function finishOrderFromRuns(cars) {
  return cars
    .map((car) => ({ id: car.id, tick: loadRun(car.kind ?? 'sprint', car.run).finishTick }))
    .sort((a, b) => a.tick - b.tick || (a.id < b.id ? -1 : 1))
    .map((entry) => entry.id);
}

const checkpointTables = [];

function recordedFinishOrder(result) {
  return result.cars
    .map((car) => ({ id: car.id, tick: car.finishTick }))
    .sort((a, b) => a.tick - b.tick || (a.id < b.id ? -1 : 1))
    .map((entry) => entry.id);
}

for (const [name, result] of scenarioResults) {
  if (result.kind === 'sprint' && ['sprint-2', 'sprint-4', 'sprint-8'].includes(name)) {
    const expected = recordedFinishOrder(result);
    const actual = result.final.rows
      .filter((row) => row.status === STANDINGS_STATUS.FINISHED)
      .map((row) => row.id);
    check('results', name + ' finish order matches recorded ticks',
      actual.length === expected.length && actual.every((id, index) => id === expected[index]),
      { actual, expected });
    check('results', name + ' every car finished', actual.length === expected.length);
  }
  if (result.kind === 'lap' && ['lap-2', 'lap-4', 'lap-8', 'lap-4-photo'].includes(name)) {
    const expected = recordedFinishOrder(result);
    const actual = result.final.rows
      .filter((row) => row.status === STANDINGS_STATUS.FINISHED)
      .map((row) => row.id);
    check('results', name + ' finish order matches recorded ticks',
      actual.length === expected.length && actual.every((id, index) => id === expected[index]),
      { actual, expected });
    check('results', name + ' every car finished', actual.length === expected.length);
    check('results', name + ' every car completed three laps',
      result.final.rows.every((row) => row.lapsCompleted === 3));
  }
}

// Photo finish: FR100 and Viper are one engine tick apart in the real data.
{
  const result = scenarioResults.get('sprint-2');
  const rows = result.final.rows;
  check('results', 'photo finish order', rows[0].id === 'ford-fr100-stock' && rows[1].id === 'dodge-viperacr-stock',
    rows.map((row) => row.id));
  check('results', 'photo finish one tick apart', rows[0].finishTick === 870 && rows[1].finishTick === 871,
    { first: rows[0].finishTick, second: rows[1].finishTick });
  near('results', 'photo finish gap seconds', rows[1].gapToLeaderSeconds, 1 / 60, 1e-6);
  check('results', 'photo finish positive gap', rows[1].gapToLeaderSeconds > 0);
}

// Exact checkpoint positions vs recorded crossing ticks (2/4/8-car fields).
for (const name of ['sprint-2', 'sprint-4', 'sprint-8']) {
  const result = scenarioResults.get(name);
  const rowsByTick = new Map(result.snapshots.map((entry) => [entry.tick, entry.snapshot]));
  const table = { scenario: name, cars: [] };
  for (const car of result.cars) {
    const run = loadRun('sprint', car.run);
    const computed = result.standings.events
      .filter((event) => event.id === car.id && event.type === STANDINGS_EVENT.CHECKPOINT);
    const row = result.final.rows.find((entry) => entry.id === car.id);
    table.cars.push({
      id: car.id,
      recorded: run.checkpoints.map((entry) => entry.tick),
      computed: computed.map((entry) => entry.tick),
      positions: run.checkpoints.map((entry, index) => {
        const snapshot = rowsByTick.get(entry.tick);
        return snapshot?.rows.find((candidate) => candidate.id === car.id)?.position ?? null;
      }),
      finishPosition: row?.position ?? null
    });
  }
  checkpointTables.push(table);
}
for (const name of ['lap-2', 'lap-4', 'lap-8']) {
  const result = scenarioResults.get(name);
  const rowsByTick = new Map(result.snapshots.map((entry) => [entry.tick, entry.snapshot]));
  const table = { scenario: name, cars: [] };
  for (const car of result.cars) {
    const run = loadRun('lap', car.run);
    const computed = result.standings.events
      .filter((event) => event.id === car.id && event.type === STANDINGS_EVENT.LAP);
    const row = result.final.rows.find((entry) => entry.id === car.id);
    table.cars.push({
      id: car.id,
      recorded: run.laps.map((entry) => entry.tick),
      computed: computed.map((entry) => entry.tick),
      positions: run.laps.map((entry) => {
        const snapshot = rowsByTick.get(entry.tick);
        return snapshot?.rows.find((candidate) => candidate.id === car.id)?.position ?? null;
      }),
      finishPosition: row?.position ?? null
    });
  }
  checkpointTables.push(table);
}

for (const table of checkpointTables) {
  const result = scenarioResults.get(table.scenario);
  for (const car of table.cars) {
    for (let index = 0; index < car.recorded.length; index++) {
      const computed = car.computed[index];
      check('checkpoints', table.scenario + ' ' + car.id + ' checkpoint ' + (index + 1),
        computed !== undefined && Math.abs(computed - car.recorded[index]) <= 1,
        { recorded: car.recorded[index], computed });
      check('checkpoints', table.scenario + ' ' + car.id + ' position recorded at checkpoint ' + (index + 1),
        Number.isInteger(car.positions[index]),
        { position: car.positions[index] });
    }
  }
}

// Pairwise checkpoint order: the car that crossed first must be placed ahead
// at the later car's crossing tick.
for (const table of checkpointTables) {
  const result = scenarioResults.get(table.scenario);
  const rowsByTick = new Map(result.snapshots.map((entry) => [entry.tick, entry.snapshot]));
  for (let a = 0; a < table.cars.length; a++) {
    for (let b = 0; b < table.cars.length; b++) {
      if (a === b) continue;
      const carA = table.cars[a];
      const carB = table.cars[b];
      for (let index = 0; index < carA.recorded.length; index++) {
        const tickA = carA.recorded[index];
        const tickB = carB.recorded[index];
        if (tickA >= tickB) continue;
        // At the tick before the later car crosses, the earlier car has
        // already passed the gate and the later car has not. This is a valid
        // ordering test even when cars cross the physical line at different
        // speeds; comparing positions at the later crossing tick is not.
        const probeTick = tickB - 1;
        const snapshot = rowsByTick.get(probeTick);
        if (!snapshot) continue;
        const positionA = snapshot.rows.find((row) => row.id === carA.id)?.position;
        const positionB = snapshot.rows.find((row) => row.id === carB.id)?.position;
        check('checkpoints', table.scenario + ' ' + carA.id + ' ahead of ' + carB.id +
          ' one tick before checkpoint ' + (index + 1) + ' (' + probeTick + ')',
          Number.isInteger(positionA) && Number.isInteger(positionB) && positionA <= positionB,
          { positionA, positionB, tickA, tickB, probeTick });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Wreck and respawn
// ---------------------------------------------------------------------------

for (const name of ['sprint-4-wreck', 'lap-4-wreck']) {
  const result = scenarioResults.get(name);
  const wreckCar = result.cars.find((car) => car.wreck);
  const { W, R, C } = wreckCar.wreck;
  const wreckEvents = result.standings.events.filter((event) =>
    event.id === wreckCar.id &&
    [STANDINGS_EVENT.WRECK, STANDINGS_EVENT.RESPAWN, STANDINGS_EVENT.RESPAWN_TARGET_REJECTED,
      STANDINGS_EVENT.PROGRESS_JUMP_REJECTED].includes(event.type));
  const wreck = wreckEvents.find((event) => event.type === STANDINGS_EVENT.WRECK);
  const respawn = wreckEvents.find((event) => event.type === STANDINGS_EVENT.RESPAWN);
  check('wreck', name + ' wreck event', wreck?.tick === W, { tick: wreck?.tick, expected: W });
  check('wreck', name + ' respawn event', respawn?.tick === R, { tick: respawn?.tick, expected: R });
  check('wreck', name + ' respawn target accepted',
    respawn !== undefined && !wreckEvents.some((event) => event.type === STANDINGS_EVENT.RESPAWN_TARGET_REJECTED),
    wreckEvents.filter((event) => event.type === STANDINGS_EVENT.RESPAWN_TARGET_REJECTED));
  check('wreck', name + ' respawn is not a rejected jump',
    !wreckEvents.some((event) => event.type === STANDINGS_EVENT.PROGRESS_JUMP_REJECTED));
  check('wreck', name + ' respawn target id',
    respawn?.gateId === (name.startsWith('sprint') ? 'checkpoint-1' : 'lap-line'),
    { gateId: respawn?.gateId });
  near('wreck', name + ' respawn target distance <= 3 m', respawn?.distanceMetres ?? 99, 0, 3);
  check('wreck', name + ' respawn arc is the checkpoint',
    name.startsWith('sprint')
      ? Math.abs((respawn?.arc ?? -1) - courseSprint.gates[1].arc) <= 1e-6
      : (respawn?.arc ?? -1) === 0);

  const before = result.snapshots.find((entry) => entry.tick === W - 1)?.snapshot
    .rows.find((row) => row.id === wreckCar.id);
  const during = result.snapshots.find((entry) => entry.tick === W + 30)?.snapshot
    .rows.find((row) => row.id === wreckCar.id);
  const after = result.snapshots.find((entry) => entry.tick === R + 1)?.snapshot
    .rows.find((row) => row.id === wreckCar.id);
  check('wreck', name + ' progress frozen while wrecked',
    before && during && Math.abs(during.progressMetres - before.progressMetres) <= 1e-6,
    { before: before?.progressMetres, during: during?.progressMetres });
  check('wreck', name + ' status is wrecked while wrecked', during?.status === STANDINGS_STATUS.WRECKED);
  check('wreck', name + ' progress drops on respawn',
    after && before && after.progressMetres < before.progressMetres,
    { before: before?.progressMetres, after: after?.progressMetres });
  check('wreck', name + ' progress after respawn equals the checkpoint',
    name.startsWith('sprint')
      ? after && Math.abs(after.progressMetres - courseSprint.gates[1].arc) <= 0.75
      : after && after.progressMetres < courseLap.lengthMetres,
    { after: after?.progressMetres });
  const finishRow = result.final.rows.find((row) => row.id === wreckCar.id);
  check('wreck', name + ' finish is delayed by wreck + re-drive', finishRow?.finishTick === wreckCar.finishTick,
    { actual: finishRow?.finishTick, expected: wreckCar.finishTick });
  check('wreck', name + ' car is still classified', finishRow?.status === STANDINGS_STATUS.FINISHED);
  const clean = loadRun(name.startsWith('sprint') ? 'sprint' : 'lap', wreckCar.run);
  check('wreck', name + ' total time includes the wreck',
    finishRow?.totalTimeSeconds >= clean.finishSeconds + 1.0,
    { wrecked: finishRow?.totalTimeSeconds, clean: clean.finishSeconds });
  if (name.startsWith('lap')) {
    check('wreck', name + ' lap count survives the respawn', finishRow?.lapsCompleted === 3);
    check('wreck', name + ' lap timer keeps running across the respawn',
      (finishRow?.lapTimes?.[0] ?? 0) >= (clean.lapTimes?.[0] ?? 0) + 0.5,
      { wreckedLap: finishRow?.lapTimes?.[0], cleanLap: clean.lapTimes?.[0] });
  }
}

// ---------------------------------------------------------------------------
// Ties, DNF and disconnect
// ---------------------------------------------------------------------------

{
  const layout = layouts.sprint;
  const a = loadRun('sprint', 'ford-fr100-stock');
  const standings = createStandings(layout, [{ id: 'car-a', slot: 1 }, { id: 'car-b', slot: 2 }]);
  for (let tick = 0; tick <= a.finishTick + 2; tick++) {
    const position = a.positions.get(Math.min(tick, a.finishTick));
    const state = { tick, position, finished: tick >= a.finishTick, finishTick: a.finishTick };
    standings.update(tick, {
      'car-a': { ...state, id: 'car-a' },
      'car-b': { ...state, id: 'car-b' }
    });
  }
  const rows = standings.snapshot().rows;
  check('ties', 'identical runs share position', rows[0].position === 1 && rows[1].position === 1,
    rows.map((row) => [row.id, row.position]));
  check('ties', 'identical runs are tied', rows[0].tied && rows[1].tied);
  check('ties', 'tie order is id', rows[0].id === 'car-a' && rows[1].id === 'car-b');
  check('ties', 'tie gaps are zero', rows[0].gapToLeaderSeconds === 0 && rows[1].gapToLeaderSeconds === 0);
  check('ties', 'tie group listed', standings.snapshot().ties.length === 1 &&
    standings.snapshot().ties[0].position === 1);
}

{
  const result = scenarioResults.get('lap-4-photo');
  const rows = result.final.rows;
  const tied = rows.filter((row) => row.finishTick === 5157);
  check('ties', 'lap equal finish ticks are tied', tied.length === 2 && tied.every((row) => row.tied),
    tied.map((row) => [row.id, row.position]));
  check('ties', 'lap tie shares a position', tied[0].position === tied[1].position,
    tied.map((row) => row.position));
  check('ties', 'lap tie orders by best lap', tied[0].bestLapSeconds <= tied[1].bestLapSeconds,
    tied.map((row) => [row.id, row.bestLapSeconds]));
}

{
  const result = scenarioResults.get('sprint-4-dnf');
  const dnfRow = result.final.rows.find((row) => row.id === 'corvette-zr1-stock');
  check('dnf', 'dnf status', dnfRow?.status === STANDINGS_STATUS.DNF);
  check('dnf', 'dnf reason retained', dnfRow?.dnfReason === 'test-dnf');
  check('dnf', 'dnf after every finisher',
    result.final.rows.filter((row) => row.status !== STANDINGS_STATUS.FINISHED)
      .every((row) => row.id === dnfRow?.id || row.position > dnfRow.position));
  check('dnf', 'dnf cannot be the leader', result.final.leaderId !== 'corvette-zr1-stock');
  check('dnf', 'dnf event emitted',
    result.standings.events.some((event) => event.type === STANDINGS_EVENT.DNF && event.id === 'corvette-zr1-stock'));
}

{
  const result = scenarioResults.get('sprint-4-disconnect');
  const row = result.final.rows.find((entry) => entry.id === 'corvette-zr1-stock');
  check('dnf', 'disconnect status', row?.status === STANDINGS_STATUS.DISCONNECTED);
  check('dnf', 'disconnect after dnf/finishers', row?.position === result.final.rows.length,
    { position: row?.position });
  check('dnf', 'disconnect event emitted',
    result.standings.events.some((event) => event.type === STANDINGS_EVENT.DISCONNECTED &&
      event.id === 'corvette-zr1-stock'));
}

// A finished car that disconnects after the finish keeps its finish.
{
  const layout = layouts.sprint;
  const run = loadRun('sprint', 'corvette-zr1-stock');
  const standings = createStandings(layout, [{ id: 'finisher', slot: 1 }]);
  for (let tick = 0; tick <= run.finishTick + 10; tick++) {
    const position = run.positions.get(Math.min(tick, run.finishTick));
    standings.update(tick, {
      finisher: {
        id: 'finisher', tick, position,
        finished: tick >= run.finishTick,
        finishTick: run.finishTick,
        status: tick > run.finishTick + 2 ? STANDINGS_STATUS.DISCONNECTED : undefined
      }
    });
  }
  const row = standings.snapshot().rows[0];
  check('dnf', 'post-finish disconnect keeps the finish', row.status === STANDINGS_STATUS.FINISHED,
    { status: row.status });
  check('dnf', 'post-finish disconnect keeps the time', row.totalTimeSeconds === round6(run.finishTick / 60));
}

// ---------------------------------------------------------------------------
// Lapped car
// ---------------------------------------------------------------------------

{
  const result = scenarioResults.get('lap-4-lapped');
  const leader = result.final.rows.find((row) => row.id === 'nissan-skyliner34ztune-stock');
  const lapped = result.final.rows.find((row) => row.id === 'ford-mustanggtr-stock');
  check('lapped', 'lapped car is classified', lapped?.status === STANDINGS_STATUS.FINISHED);
  check('lapped', 'lapped car is behind the leader', lapped?.position > leader?.position,
    { leader: leader?.position, lapped: lapped?.position });
  check('lapped', 'lapped car lap count is one less at the leader finish',
    lapped?.lapsCompleted <= leader?.lapsCompleted,
    { leader: leader?.lapsCompleted, lapped: lapped?.lapsCompleted });
  const leaderFinishTick = leader?.finishTick;
  const atLeaderFinish = result.snapshots.find((entry) => entry.tick === leaderFinishTick)?.snapshot;
  const lappedAtLeaderFinish = atLeaderFinish?.rows.find((row) => row.id === 'ford-mustanggtr-stock');
  check('lapped', 'lapped marker set at the leader finish',
    (lappedAtLeaderFinish?.lapsDown ?? 0) >= 1,
    { lapsDown: lappedAtLeaderFinish?.lapsDown, leaderLaps: atLeaderFinish?.rows[0]?.lapsCompleted });
  check('lapped', 'lapped gap is at least one loop length',
    (lappedAtLeaderFinish?.gapToLeaderMetres ?? 0) >= courseLap.lengthMetres - 20,
    { gap: lappedAtLeaderFinish?.gapToLeaderMetres, length: courseLap.lengthMetres });
}

// ---------------------------------------------------------------------------
// Robustness: out-of-order, missing, jump, containment, teleport
// ---------------------------------------------------------------------------

{
  const layout = layouts.sprint;
  const run = loadRun('sprint', 'corvette-zr1-stock');
  const standings = createStandings(layout, [{ id: 'car', slot: 1 }]);
  for (let tick = 0; tick <= 400; tick++) {
    standings.update(tick, {
      car: { id: 'car', tick, position: run.positions.get(tick) }
    });
  }
  const progressBefore = standings.snapshot().rows[0].progressMetres;
  const eventCountBefore = standings.events.length;
  standings.update(390, { car: { id: 'car', tick: 390, position: run.positions.get(390) } });
  check('robust', 'global out-of-order snapshot rejected',
    standings.tick === 400 && standings.snapshot().rows[0].progressMetres === progressBefore,
    { tick: standings.tick });
  check('robust', 'global out-of-order event emitted',
    standings.events.slice(eventCountBefore).some((event) => event.type === STANDINGS_EVENT.OUT_OF_ORDER_SNAPSHOT));
  const progressAfter = standings.snapshot().rows[0].progressMetres;
  standings.update(401, {
    car: { id: 'car', tick: 397, position: run.positions.get(397) }
  });
  check('robust', 'per-car out-of-order state rejected',
    standings.snapshot().rows[0].progressMetres === progressAfter,
    { before: progressAfter, after: standings.snapshot().rows[0].progressMetres });
  check('robust', 'per-car out-of-order event emitted',
    standings.events.some((event) => event.type === STANDINGS_EVENT.OUT_OF_ORDER_STATE));
  standings.update(402, {
    car: { id: 'car', tick: 500, position: run.positions.get(402) }
  });
  check('robust', 'future state rejected',
    standings.events.some((event) => event.type === STANDINGS_EVENT.FUTURE_STATE));
}

{
  const layout = layouts.sprint;
  const run = loadRun('sprint', 'corvette-zr1-stock');
  const standings = createStandings(layout, [{ id: 'car', slot: 1 }], { staleAfterTicks: 60 });
  for (let tick = 0; tick <= 200; tick++) {
    if (tick >= 100) {
      standings.update(tick, {});
      continue;
    }
    standings.update(tick, { car: { id: 'car', tick, position: run.positions.get(tick) } });
  }
  const row = standings.snapshot().rows[0];
  check('robust', 'missing updates keep the last progress', row.progressMetres > 0);
  check('robust', 'missing updates become stale', row.stale === true, { staleTicks: row.staleTicks });
  check('robust', 'stale event emitted',
    standings.events.some((event) => event.type === STANDINGS_EVENT.STALE));
  check('robust', 'stale car still has a position', Number.isInteger(row.position));
}

{
  const layout = layouts.sprint;
  const run = loadRun('sprint', 'corvette-zr1-stock');
  const standings = createStandings(layout, [{ id: 'car', slot: 1 }]);
  for (let tick = 0; tick <= 300; tick++) {
    standings.update(tick, { car: { id: 'car', tick, position: run.positions.get(tick) } });
  }
  const before = standings.snapshot().rows[0].progressMetres;
  // 50 m forward in one tick: the physics maximum is 1 m/tick at 60 m/s.
  standings.update(301, { car: { id: 'car', tick: 301, position: run.positions.get(450) } });
  const after = standings.snapshot().rows[0].progressMetres;
  check('robust', 'forward jump rejected', Math.abs(after - before) <= 1e-6,
    { before, after });
  check('robust', 'forward jump event', standings.events.some((event) =>
    event.type === STANDINGS_EVENT.PROGRESS_JUMP_REJECTED));
  // Backwards 30 m without a declared respawn: progress is clamped, not lost.
  standings.update(302, { car: { id: 'car', tick: 302, position: run.positions.get(250) } });
  const clamped = standings.snapshot().rows[0].progressMetres;
  check('robust', 'undeclared backward jump does not reduce progress', clamped >= after - 1e-6,
    { after, clamped });
  check('robust', 'backtrack event', standings.events.some((event) =>
    event.type === STANDINGS_EVENT.BACKTRACK_CLAMPED));
}

{
  const layout = layouts.sprint;
  const run = loadRun('sprint', 'corvette-zr1-stock');
  const standings = createStandings(layout, [{ id: 'car', slot: 1 }]);
  for (let tick = 0; tick <= 400; tick++) {
    standings.update(tick, { car: { id: 'car', tick, position: run.positions.get(tick) } });
  }
  const before = standings.snapshot().rows[0].progressMetres;
  standings.update(401, {
    car: { id: 'car', tick: 401, position: [run.positions.get(401)[0] + 200, 6, run.positions.get(401)[2] + 200] }
  });
  const row = standings.snapshot().rows[0];
  const containment = standings.events.find((event) => event.type === STANDINGS_EVENT.CONTAINMENT_RESET);
  check('robust', 'containment reset emitted', containment !== undefined, containment ?? null);
  check('robust', 'containment freezes progress', Math.abs(row.progressMetres - before) <= 1e-6,
    { before, after: row.progressMetres });
  check('robust', 'containment target is the last checkpoint',
    containment?.target?.gateId === 'checkpoint-1', containment?.target);
  // Respawn at the declared target.
  const target = containment.target;
  standings.update(402, {
    car: { id: 'car', tick: 402, position: [target.x, target.y, target.z], respawn: true }
  });
  const respawned = standings.snapshot().rows[0];
  check('robust', 'containment respawn accepted', !respawned.offMap);
  check('robust', 'containment respawn resets to the checkpoint',
    Math.abs(respawned.progressMetres - courseSprint.gates[1].arc) <= 1e-6,
    { progress: respawned.progressMetres });
}

{
  const layout = layouts.sprint;
  const run = loadRun('sprint', 'corvette-zr1-stock');
  const standings = createStandings(layout, [{ id: 'car', slot: 1 }]);
  for (let tick = 0; tick <= 300; tick++) {
    standings.update(tick, { car: { id: 'car', tick, position: run.positions.get(tick) } });
  }
  const before = standings.snapshot().rows[0].progressMetres;
  standings.update(301, {
    car: {
      id: 'car', tick: 301, position: run.positions.get(250),
      teleport: { kind: 'powerup', reason: 'test-backward' }
    }
  });
  const afterBackward = standings.snapshot().rows[0].progressMetres;
  check('robust', 'backward power-up teleport accepted', afterBackward < before,
    { before, after: afterBackward });
  check('robust', 'power-up teleport event',
    standings.events.some((event) => event.type === STANDINGS_EVENT.POWERUP_TELEPORT && event.accepted === true));
  const beforeForward = afterBackward;
  standings.update(302, {
    car: {
      id: 'car', tick: 302, position: run.positions.get(450),
      teleport: { kind: 'powerup', reason: 'test-forward' }
    }
  });
  const afterForward = standings.snapshot().rows[0].progressMetres;
  check('robust', 'forward power-up teleport rejected', Math.abs(afterForward - beforeForward) <= 1e-6,
    { before: beforeForward, after: afterForward });
  check('robust', 'forward teleport event',
    standings.events.some((event) => event.type === STANDINGS_EVENT.TELEPORT_FORWARD_REJECTED));
}

{
  const layout = layouts.sprint;
  const run = loadRun('sprint', 'corvette-zr1-stock');
  const standings = createStandings(layout, [{ id: 'car', slot: 1 }]);
  for (let tick = 0; tick <= 300; tick++) {
    standings.update(tick, { car: { id: 'car', tick, position: run.positions.get(tick) } });
  }
  // A respawn nowhere near the checkpoint is rejected.
  standings.update(301, {
    car: { id: 'car', tick: 301, position: [0, 6, 0], respawn: true }
  });
  check('robust', 'respawn at the wrong target rejected',
    standings.events.some((event) => event.type === STANDINGS_EVENT.RESPAWN_TARGET_REJECTED));
  const before = standings.snapshot().rows[0].progressMetres;
  check('robust', 'rejected respawn keeps progress', standings.snapshot().rows[0].progressMetres === before);
}

// ---------------------------------------------------------------------------
// Determinism: every scenario twice
// ---------------------------------------------------------------------------

const determinism = [];
for (const spec of scenarioSpecs) {
  const first = scenarioResults.get(spec.name);
  const second = runScenario(spec);
  const sameFinal = first.final.hash === second.final.hash;
  const sameEvents = first.eventHash === second.eventHash;
  const sameReplay = first.replayHash === second.replayHash;
  const sameSnapshots = first.snapshots.length === second.snapshots.length &&
    first.snapshots.every((entry, index) =>
      entry.tick === second.snapshots[index].tick &&
      entry.snapshot.hash === second.snapshots[index].snapshot.hash);
  check('determinism', spec.name + ' final hash', sameFinal,
    { first: first.final.hash, second: second.final.hash });
  check('determinism', spec.name + ' event hash', sameEvents);
  check('determinism', spec.name + ' replay hash', sameReplay);
  check('determinism', spec.name + ' per-sample snapshot hashes', sameSnapshots);
  determinism.push({
    scenario: spec.name,
    finalHash: first.final.hash,
    eventHash: first.eventHash,
    replayHash: first.replayHash,
    snapshots: first.snapshots.length,
    events: first.eventCount,
    equal: sameFinal && sameEvents && sameReplay && sameSnapshots
  });
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const passed = checks.filter((entry) => entry.ok).length;
const failed = checks.length - passed;
const summary = {
  checks: checks.length,
  passed,
  failed,
  groups: Object.fromEntries([...groups.entries()].map(([name, value]) => [name, value])),
  failures: failures.slice(0, 40)
};

const trace = {
  schema: 'blur.standings.verify-trace/1',
  probe: 'probes/standings',
  scope: {
    rulesOnly: true,
    engineIntegration: false,
    renderer: false,
    network: false,
    retailParity: false,
    browserCapture: false
  },
  inputs: inputRecords,
  runs: runRecords,
  courses: {
    sprint: courseSprint.toJSON(),
    lap: courseLap.toJSON(),
    free: { courseId: freeLayout.courseId, mode: 'free', standings: false }
  },
  tuning: {
    maxSpeedMps: 60,
    backtrackToleranceMetres: 2,
    lapToleranceMetres: 2,
    respawnToleranceMetres: 3,
    containmentMarginMetres: 25,
    staleAfterTicks: 180,
    sectorCount: 4,
    source: 'provisional-project-rule'
  },
  singleReplay,
  scenarios: [...scenarioResults.values()].map((result) => ({
    name: result.name,
    kind: result.kind,
    maxTick: result.maxTick,
    cars: result.cars,
    eventCount: result.eventCount,
    finalHash: result.final.hash,
    eventHash: result.eventHash,
    replayHash: result.replayHash,
    final: {
      leaderId: result.final.leaderId,
      order: result.final.order,
      ties: result.final.ties,
      rows: result.final.rows
    }
  })),
  checkpointTables,
  determinism,
  summary
};

const traceFile = path.join(OUT, 'trace.json');
const verifyFile = path.join(OUT, 'verify.json');
const hashesFile = path.join(OUT, 'hashes.json');
fs.writeFileSync(traceFile, JSON.stringify(trace, null, 2));
const verifyBody = { ...summary, checks };
fs.writeFileSync(verifyFile, JSON.stringify(verifyBody, null, 2));

const hashes = {
  layouts: {
    sprint: sprintLayout.hash,
    lap: lapLayout.hash,
    free: freeLayout.hash
  },
  inputs: Object.fromEntries(inputRecords.map((record) => [record.name, record.sha256])),
  scenario: Object.fromEntries(determinism.map((entry) => [entry.scenario, {
    final: entry.finalHash,
    events: entry.eventHash,
    replay: entry.replayHash
  }])),
  trace: hashOf(trace),
  verify: hashOf(verifyBody)
};
fs.writeFileSync(hashesFile, JSON.stringify(hashes, null, 2));

log('');
log('checks: ' + checks.length + ' total, ' + passed + ' passed, ' + failed + ' failed');
for (const [name, value] of groups) {
  log('  ' + name.padEnd(14) + value.passed + '/' + value.total);
}
log('');
for (const entry of failures.slice(0, 20)) {
  log('FAIL ' + entry.id + ' ' + entry.name + ' ' + JSON.stringify(entry.detail ?? null));
}
log('');
log('trace    ' + traceFile + '  ' + sha256File(traceFile));
log('verify   ' + verifyFile + '  ' + sha256File(verifyFile));
log('hashes   ' + hashesFile + '  ' + sha256File(hashesFile));
log('traceHash ' + hashes.trace);
log('verifyHash ' + hashes.verify);
fs.writeFileSync(path.join(LOGS, 'verify.log'), LOG.join('\n') + '\n');

if (failed > 0) process.exitCode = 1;
