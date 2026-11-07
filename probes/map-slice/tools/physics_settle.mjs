// Physics proof for a map slice package.
//
// Loads the existing E1 wasm module (the same T-005d vehicle closure used by
// e1-drive), feeds it the level's Level.levelphysics bytes and the committed
// Corvette field record, places the car at the candidate spawn, and settles for
// 60 ticks with zero input. It records every tick's state hash, wheel contacts,
// finite flag, ground probes at the spawn and across a 1 m car-width band, and
// runs the whole settle twice to prove determinism.
//
// This does NOT integrate the map into e1-drive, render a frame, or claim a
// playable course.
//
// Usage:
//   node probes/map-slice/tools/physics_settle.mjs [--package _work/map-slice/amboy]

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashOf } from '../../e1-drive/web/packet-hash.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const packageArg = args.includes('--package') ? args[args.indexOf('--package') + 1] : '_work/map-slice/amboy';
const PACKAGE = path.resolve(ROOT, packageArg);
const SLICE = path.join(PACKAGE, 'slice.json');
const OUT = path.join(PACKAGE, 'physics-settle.json');

const BAND_OFFSETS_M = [-0.5, -0.25, 0.0, 0.25, 0.5];
const STATIONS_M = [0.0, 1.0, 2.0, 3.0, 4.0];
const SETTLE_TICKS = 60;

const sha256 = (data) => 'sha256:' + createHash('sha256').update(data).digest('hex');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function entrypoint(point, spawn) {
  const forward = [Math.sin(spawn.heading), Math.cos(spawn.heading)];
  const lateral = [Math.cos(spawn.heading), -Math.sin(spawn.heading)];
  return [
    spawn.x + forward[0] * point.station + lateral[0] * point.offset,
    spawn.z + forward[1] * point.station + lateral[1] * point.offset,
  ];
}

function runSettle(module, input) {
  const level = input.levelBytes;
  const fields = input.fieldBytes;
  const levelPtr = module._malloc(level.length);
  const fieldsPtr = module._malloc(fields.length);
  if (!levelPtr || !fieldsPtr) throw new Error('module malloc failed');
  module.HEAPU8.set(level, levelPtr);
  module.HEAPU8.set(fields, fieldsPtr);

  let created;
  try {
    created = module._e1_create(levelPtr, level.length, fieldsPtr, fields.length,
                                input.spawn.x, input.spawn.z, input.spawn.heading);
  } finally {
    module._free(levelPtr);
    module._free(fieldsPtr);
  }
  if (!created) {
    throw new Error('e1_create failed: ' + module.UTF8ToString(module._e1_last_error()));
  }

  const info = JSON.parse(module.UTF8ToString(module._e1_info()));
  if (info.status !== 'ok') throw new Error('e1_info status: ' + info.status);

  const band = [];
  for (const station of STATIONS_M) {
    for (const offset of BAND_OFFSETS_M) {
      const [x, z] = entrypoint({ station, offset }, input.spawn);
      const probe = JSON.parse(module.UTF8ToString(module._e1_ground_probe(x, z)));
      band.push({ stationM: station, offsetM: offset, x, z, probe });
    }
  }

  const ticks = [];
  for (let tick = 0; tick <= SETTLE_TICKS; ++tick) {
    if (tick > 0) {
      const stepped = module._e1_step();
      if (!stepped) throw new Error('e1_step failed at tick ' + tick + ': ' +
                                   module.UTF8ToString(module._e1_last_error()));
    }
    const state = JSON.parse(module.UTF8ToString(module._e1_get_state()));
    const contacts = (state.contacts ?? [0, 0, 0, 0]).map(Number);
    ticks.push({
      tick,
      stateHash: hashOf(state),
      position: state.position,
      speed: state.speed,
      contacts,
      wheelContacts: contacts.reduce((a, b) => a + b, 0),
      finite: state.finite === 1,
      anyContact: state.anyContact === 1,
      input: state.input,
    });
    if (tick === 0) ticks[0].state = state;
    if (tick === SETTLE_TICKS) ticks[ticks.length - 1].state = state;
  }

  const first = ticks[0];
  const last = ticks[ticks.length - 1];
  const center = band.find((row) => row.stationM === 0 && row.offsetM === 0);
  const hits = band.filter((row) => row.probe.hit === 1);
  const heights = hits.map((row) => row.probe.y);
  const centerGround = center.probe.y;
  const sequence = 'sha256:' + createHash('sha256')
    .update(ticks.map((row) => row.stateHash).join('\n'))
    .digest('hex');

  return {
    info,
    band,
    ticks,
    summary: {
      settleTicks: SETTLE_TICKS,
      zeroInput: ticks.slice(1).every((row) => row.input.every((v) => Number(v) === 0)),
      tick0StateHash: first.stateHash,
      tick60StateHash: last.stateHash,
      stateSequenceHash: sequence,
      allFinite: ticks.every((row) => row.finite),
      allAnyContact: ticks.every((row) => row.anyContact),
      contactTickCount: ticks.filter((row) => row.anyContact).length,
      minWheelContacts: Math.min(...ticks.map((row) => row.wheelContacts)),
      maxWheelContacts: Math.max(...ticks.map((row) => row.wheelContacts)),
      maxSpeedMps: Math.max(...ticks.map((row) => row.speed)),
      finalSpeedMps: last.speed,
      driftM: Math.hypot(last.position[0] - first.position[0],
                        last.position[2] - first.position[2]),
      verticalDeltaM: last.position[1] - first.position[1],
      rideHeightM: first.position[1] - info.groundY,
      firstPosition: first.position,
      lastPosition: last.position,
      groundY: info.groundY,
      startY: info.startY,
      warmupTicks: info.warmupTicks,
      chassisProxy: info.chassisProxy,
      chassisProxyLift: info.chassisProxyLift,
      bandHitCount: hits.length,
      bandExpectedHitCount: BAND_OFFSETS_M.length * STATIONS_M.length,
      bandAllHits: hits.length === BAND_OFFSETS_M.length * STATIONS_M.length,
      bandGroundY: centerGround,
      bandMinY: Math.min(...heights),
      bandMaxY: Math.max(...heights),
      bandHeightSpreadM: Math.max(...heights) - Math.min(...heights),
      bandMaxAbsDeviationM: Math.max(...heights.map((y) => Math.abs(y - centerGround))),
    },
  };
}

const slice = readJson(SLICE);
if (slice.schema !== 'blur.map-slice/1') throw new Error('unexpected slice schema');
const source = slice.source;
const levelPath = path.resolve(ROOT, source.levelPhysics.path);
const fieldsPath = path.resolve(ROOT, source.carFields.path);
const modulePath = path.resolve(ROOT, source.e1Module.path);
const buildPath = path.resolve(ROOT, source.e1Build.path);
const wasmPath = modulePath.replace(/\.mjs$/, '.wasm');

const levelBytes = readFileSync(levelPath);
const fieldBytes = readFileSync(fieldsPath);
const wasmBytes = readFileSync(wasmPath);
const build = readJson(buildPath);
if (build.wasmSha256 !== 'sha256:' && build.wasmSha256 !==
    createHash('sha256').update(wasmBytes).digest('hex')) {
  throw new Error('e1 module wasm hash does not match build.json');
}
if (sha256(levelBytes) !== 'sha256:' + source.levelPhysics.sha256) {
  throw new Error('level physics hash does not match slice.json');
}
if (sha256(fieldBytes) !== 'sha256:' + source.carFields.sha256) {
  throw new Error('car fields hash does not match slice.json');
}

const spawn = slice.layout.spawn;
const input = { levelBytes, fieldBytes, spawn };

const createModule = (await import('file://' + modulePath.replace(/\\/g, '/'))).default;
const moduleA = await createModule();
const runA = runSettle(moduleA, input);
const moduleB = await createModule();
const runB = runSettle(moduleB, input);

const perTickEqual = runA.ticks.every((row, index) =>
  row.stateHash === runB.ticks[index].stateHash);
const determinism = {
  twoIndependentModules: true,
  perTickEqual,
  sequenceA: runA.summary.stateSequenceHash,
  sequenceB: runB.summary.stateSequenceHash,
  sequenceEqual: runA.summary.stateSequenceHash === runB.summary.stateSequenceHash,
  identical: perTickEqual && runA.summary.stateSequenceHash === runB.summary.stateSequenceHash,
};

const doc = {
  schema: 'blur.map-slice.physics-settle/1',
  level: slice.level,
  module: {
    path: source.e1Module.path,
    sha256: source.e1Module.sha256,
    wasmPath: path.relative(ROOT, wasmPath).split(path.sep).join('/'),
    wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'),
    buildJsonSha256: source.e1Build.sha256,
    build: {
      objects: build.objects,
      reusedObjects: build.reusedObjects,
      ownObjects: build.ownObjects,
      ownSource: build.ownSource,
      ownSourceSha256: build.ownSourceSha256,
      chassisProxyLiftMetres: build.chassisProxyLiftMetres,
      buildDeterministic: build.buildDeterministic,
      exports: build.exports,
    },
  },
  inputs: {
    levelPhysics: {
      path: source.levelPhysics.path,
      bytes: levelBytes.length,
      sha256: source.levelPhysics.sha256,
    },
    carFields: {
      path: source.carFields.path,
      bytes: fieldBytes.length,
      sha256: source.carFields.sha256,
    },
    spawn,
  },
  create: {
    ok: true,
    info: runA.info,
  },
  groundProbes: runA.band,
  groundProbeSummary: runA.summary,
  ticks: runA.ticks,
  summary: runA.summary,
  determinism,
  scope: {
    playableClaim: false,
    rendererClaim: false,
    e1DriveIntegration: false,
    statement: '60-tick zero-input settle of the existing E1 wasm vehicle on '
             + 'usa_amboy/Level.levelphysics at the candidate spawn; no frame, '
             + 'lap, map integration or retail start-line claim',
  },
};

writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n', 'utf8');
console.log(JSON.stringify({
  output: path.relative(ROOT, OUT).split(path.sep).join('/'),
  sha256: sha256(readFileSync(OUT)),
  tick0StateHash: runA.summary.tick0StateHash,
  tick60StateHash: runA.summary.tick60StateHash,
  stateSequenceHash: runA.summary.stateSequenceHash,
  allFinite: runA.summary.allFinite,
  allAnyContact: runA.summary.allAnyContact,
  minWheelContacts: runA.summary.minWheelContacts,
  driftM: runA.summary.driftM,
  rideHeightM: runA.summary.rideHeightM,
  determinism,
}, null, 1));
