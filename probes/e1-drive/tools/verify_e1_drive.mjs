// E1 drive-slice verifier + packet producer.
//
//   node probes/e1-drive/tools/verify_e1_drive.mjs
//
// Runs the scripted drive twice, each time in a **separate wasm module instance**,
// and checks:
//   * the wasm module builds (build.json is read, not trusted: hashes are re-read)
//   * the fixed dt, the tick count and the scripted input schedule
//   * no NaN/Inf state, wheel contact during the drive
//   * the car actually moves on the collision mesh under the scripted input
//   * two independent runs produce the same per-tick state hash sequence
//   * the adapter turns the states into a schema-conformant render packet v1.1
//   * the packet hash and every per-tick hash match the committed definition
//     (probes/render-packet/tools/packet-format.mjs), which also proves the
//     browser-side SHA-256/canonical-JSON copy agrees with node:crypto
//   * every per-tick matrix is rigid and the camera agrees with its orbit params
//
// Artifacts (never committed):
//   _work/e1-drive/packet.json              the validated packet
//   _work/e1-drive/packet.validation.json    validator output
//   _work/e1-drive/run.json                  the evidence document
//   _work/e1-drive/state_a.json              per-tick states (run A)
//   _work/logs/e1-drive/verify.log

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { formatPacket, hashOf, packetHash, validatePacket } from '../../render-packet/tools/packet-format.mjs';
import { isRigid } from '../../render-packet/web/interpolate.js';
import { canonicalJson, hashOf as hashOfLocal } from '../web/packet-hash.js';
import { sha256Hex } from '../web/sha256.js';
import { createSession } from '../web/packet-adapter.js';
import { PHASES, SCRIPT_TICKS, TICK_HZ, phaseAt, scriptedInput } from '../web/drive-script.js';
import { TICK0_LIMITS } from './spawn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, '_work/e1-drive');
const LOGS = path.join(ROOT, '_work/logs/e1-drive');
const MODULE = path.join(OUT, 'module/e1_drive.mjs');
const BUILD = path.join(OUT, 'module/build.json');
const GEOMETRY = path.join(OUT, 'geometry.json');
const LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics');
const FIELDS = path.join(ROOT, '_work/engine-vehicle-spike/car.fields');

const failures = [];
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(label + (detail ? ': ' + detail : ''));
};

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

if (!existsSync(MODULE) || !existsSync(BUILD)) {
  throw new Error('wasm module missing — run `node probes/e1-drive/tools/build_module.mjs`');
}
if (!existsSync(GEOMETRY)) {
  throw new Error('geometry missing — run `node probes/e1-drive/tools/build_geometry.mjs`');
}
if (!existsSync(LEVEL)) throw new Error('level missing: ' + LEVEL);
if (!existsSync(FIELDS)) {
  throw new Error('car.fields missing — run `python engine/verify_vehicle.py --skip-build` once');
}

const build = JSON.parse(readFileSync(BUILD, 'utf8'));
const moduleWasm = path.join(OUT, 'module/e1_drive.wasm');
const t005Report = path.join(ROOT, '_work/logs/engine-vehicle-spike/verify-vehicle.json');
const t005Provenance = existsSync(t005Report) ? JSON.parse(readFileSync(t005Report, 'utf8')) : null;
check('wasm build is deterministic (two links)',
      build.buildDeterministic === true && sha256(readFileSync(moduleWasm)) === build.wasmSha256,
      build.wasmSha256);
check('wasm object count is the T-005d closure (185 + 1 harness)',
      build.objects === 186 && build.reusedObjects === 185 && build.ownObjects === 1,
      `${build.objects} objects`);

const geometry = JSON.parse(readFileSync(GEOMETRY, 'utf8'));
const levelBytes = readFileSync(LEVEL);
const fieldBytes = Buffer.from(readFileSync(FIELDS, 'utf8'), 'utf8');

/** One full scripted run in a fresh wasm module instance. */
async function runOnce(tag) {
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  const module = await factory();
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);

  const t0 = Date.now();
  const created = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                                    TICK0_LIMITS.x, TICK0_LIMITS.z, TICK0_LIMITS.heading);
  if (!created) throw new Error('e1_create failed: ' + module.UTF8ToString(module._e1_last_error()));
  const resetMs = Date.now() - t0;
  const info = JSON.parse(module.UTF8ToString(module._e1_info()));
  const ground = JSON.parse(module.UTF8ToString(module._e1_ground_probe(TICK0_LIMITS.x, TICK0_LIMITS.z)));

  const session = createSession(geometry, JSON.parse(module.UTF8ToString(module._e1_get_state())), {
    spawn: {
      x: TICK0_LIMITS.x,
      z: TICK0_LIMITS.z,
      headingRad: TICK0_LIMITS.heading,
      source: TICK0_LIMITS.source
    }
  });

  const states = [];
  const tableView = [];
  let state0 = JSON.parse(module.UTF8ToString(module._e1_get_state()));
  session.appendState(state0);
  states.push(state0);
  tableView.push({
    tick: 0,
    phase: 'settled',
    position: state0.position,
    speed: state0.speed,
    contacts: state0.contacts.join(''),
    stateHash: hashOfLocal(state0)
  });

  const startTime = Date.now();
  for (let tick = 1; tick <= SCRIPT_TICKS; tick++) {
    const input = scriptedInput(tick);
    module._e1_set_input(input[0], input[1], input[2], input[3]);
    if (!module._e1_step()) throw new Error('e1_step failed at tick ' + tick + ': ' + module.UTF8ToString(module._e1_last_error()));
    const state = JSON.parse(module.UTF8ToString(module._e1_get_state()));
    session.appendState(state);
    states.push(state);
    tableView.push({
      tick,
      phase: phaseAt(tick),
      position: state.position,
      speed: state.speed,
      contacts: state.contacts.join(''),
      stateHash: hashOfLocal(state)
    });
  }
  const simMs = Date.now() - startTime;
  const packet = session.finalise();

  // The same scripted run must be reproducible inside one module instance too:
  // reset and replay 30 ticks, compare with run A's first 30 states.
  module._e1_reset();
  const replay = [];
  replay.push(JSON.parse(module.UTF8ToString(module._e1_get_state())));
  for (let tick = 1; tick <= 30; tick++) {
    const input = scriptedInput(tick);
    module._e1_set_input(input[0], input[1], input[2], input[3]);
    module._e1_step();
    replay.push(JSON.parse(module.UTF8ToString(module._e1_get_state())));
  }
  const replayMatches = replay.every((state, index) => hashOfLocal(state) === hashOfLocal(states[index]));

  return { info, ground, resetMs, simMs, states, tableView, packet, replayMatches };
}

const log = [];
const runA = await runOnce('a');
const runB = await runOnce('b');
log.push(`run A: reset ${runA.resetMs} ms, ${SCRIPT_TICKS} ticks ${runA.simMs} ms`);
log.push(`run B: reset ${runB.resetMs} ms, ${SCRIPT_TICKS} ticks ${runB.simMs} ms`);

// ---------------------------------------------------------------- state gates
check('ground probe hits the collision mesh at the spawn',
      runA.ground.status === 'ok' && runA.ground.hit === 1,
      JSON.stringify(runA.ground));
check('module reports the decoded XT car', runA.info.car === 'Corvette_ZR1_Stock', runA.info.car);
check('fixed step is 1/60 s', Math.abs(runA.info.dt - 1 / TICK_HZ) < 1e-9, String(runA.info.dt));
check('settle phase ran before tick 0', runA.info.warmupTicks === 180, String(runA.info.warmupTicks));
check('tick 0 has all four wheels on the ground', runA.states[0].contacts.join('') === '1111', runA.states[0].contacts.join(''));
check('tick 0 is at rest', Math.abs(runA.states[0].speed) < 0.05, String(runA.states[0].speed));

const nanStates = runA.states.filter((state) => state.finite !== 1).length;
check('no NaN/Inf state in any tick', nanStates === 0, String(nanStates));
const contactTicks = runA.states.filter((state) => state.anyContact === 1).length;
check('wheel contact on every scripted tick', contactTicks === SCRIPT_TICKS + 1,
      `${contactTicks} of ${SCRIPT_TICKS + 1}`);

const distance = (a, b) => Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]);
const travelled = distance(runA.states[0], runA.states[SCRIPT_TICKS]);
const travelXZ = Math.hypot(runA.states[SCRIPT_TICKS].position[0] - runA.states[0].position[0],
                            runA.states[SCRIPT_TICKS].position[2] - runA.states[0].position[2]);
check('the car leaves the spawn under throttle', travelled > 20, `${travelled.toFixed(2)} m`);
check('the throttle phase reaches a real road speed',
      Math.max(...runA.states.map((state) => state.speed)) > 10,
      `${Math.max(...runA.states.map((state) => state.speed)).toFixed(3)} m/s`);
check('brake phase reduces speed', runA.states[SCRIPT_TICKS].speed < runA.states[240].speed,
      `${runA.states[240].speed.toFixed(3)} -> ${runA.states[SCRIPT_TICKS].speed.toFixed(3)} m/s`);
check('one second of brake brings the car to a near stop',
      runA.states[SCRIPT_TICKS].speed < 1.0, `${runA.states[SCRIPT_TICKS].speed.toFixed(3)} m/s`);

const hashesA = runA.tableView.map((row) => row.stateHash);
const hashesB = runB.tableView.map((row) => row.stateHash);
check('two independent module instances produce the same state hash sequence',
      hashesA.length === hashesB.length && hashesA.every((hash, index) => hash === hashesB[index]),
      hashesA.find((hash, index) => hash !== hashesB[index]) ?? '');
check('every tick has a distinct state hash', new Set(hashesA).size === hashesA.length,
      `${new Set(hashesA).size} distinct of ${hashesA.length}`);
check('reset + replay reproduces the first 30 ticks inside one instance', runA.replayMatches === true);

const aggregate = (hashes) => 'sha256:' + sha256(Buffer.from(hashes.join('\n'), 'utf8'));
const stateSequenceHash = aggregate(hashesA);
check('run B state sequence hash equals run A', aggregate(hashesB) === stateSequenceHash, stateSequenceHash);

// --------------------------------------------------------------- packet gates
const packet = runA.packet;
const validation = validatePacket(packet);
check('packet conforms to the v1.1 contract', validation.ok === true, validation.errors.slice(0, 6).join(' | '));
check('packet version is 1.1 with a timeline', packet.version === 1.1 && Array.isArray(packet.updates),
      String(packet.version));
check('one packet tick per scripted tick plus the settled tick',
      packet.updates.length === SCRIPT_TICKS + 1, String(packet.updates.length));
check('the packet has the expected draw count (22 level props + 1 collision surface + 80 car)',
      packet.draws.length === 103 && packet.diagnostics.sequence.staticDrawCount === 23, String(packet.draws.length));
check('materials are diagnostic and labelled', packet.diagnostics.materialsApplied === false &&
      packet.draws.every((draw) => typeof draw.materialReason === 'string' && draw.materialReason.length > 0));

const nonRigid = packet.updates.flatMap((update) => update.matrices).filter((entry) => !isRigid(entry.world));
check('every per-tick matrix is rigid', nonRigid.length === 0, String(nonRigid.length));

const localHashMismatch = packet.updates.filter((update) => hashOfLocal({ ...update, hash: undefined }) !== update.hash);
check('browser-side canonical JSON/SHA-256 agrees with the committed hash definition (every tick)',
      localHashMismatch.length === 0, localHashMismatch.slice(0, 2).map((update) => update.tick).join(','));
check('packet hash matches the committed definition', packetHash(packet) === packet.hash, packet.hash);
check('run B builds the same packet hash', runB.packet.hash === packet.hash,
      `${packet.hash.slice(0, 20)} vs ${runB.packet.hash.slice(0, 20)}`);
check('tick 0 camera is the reference camera',
      canonicalJson(packet.updates[0].camera) === canonicalJson(packet.camera));

// The state hash sequence and the packet hashes must be tied to the same ticks.
const tickHashMismatch = packet.updates.filter((update, index) => {
  const state = runA.states[index];
  return update.tick !== state.tick;
});
check('packet ticks equal state ticks', tickHashMismatch.length === 0);

const carMatrixAt = (tick) => packet.updates[tick].matrices[0].world;
const movedDraw = packet.draws.find((draw) => draw.id === 'corvette.body.primitive0');
check('car draw transforms differ between tick 0 and the last tick',
      carMatrixAt(0).some((value, index) => value !== carMatrixAt(SCRIPT_TICKS)[index]) &&
      movedDraw.world.length === 16);

mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });
// Web assets the page fetches (the served tree is probes/e1-drive/web + _work/e1-drive).
writeFileSync(path.join(OUT, 'Level.levelphysics'), levelBytes);
writeFileSync(path.join(OUT, 'car.fields'), fieldBytes);
writeFileSync(path.join(OUT, 'spawn.json'), JSON.stringify(TICK0_LIMITS, null, 2) + '\n', 'utf8');
writeFileSync(path.join(OUT, 'packet.json'), formatPacket(packet), 'utf8');
writeFileSync(path.join(OUT, 'packet.validation.json'), JSON.stringify(validation, null, 2) + '\n', 'utf8');
writeFileSync(path.join(OUT, 'state_a.json'), JSON.stringify({
  spawn: TICK0_LIMITS,
  tickHz: TICK_HZ,
  script: PHASES,
  stateSequenceHash,
  ticks: runA.tableView
}, null, 2) + '\n', 'utf8');

const packetBytes = readFileSync(path.join(OUT, 'packet.json')).length;
const report = {
  purpose: 'E1 drive slice: wasm vehicle physics -> render packet v1.1 -> WebGPU consumer',
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  module: {
    path: path.relative(ROOT, path.join(OUT, 'module/e1_drive.mjs')).split(path.sep).join('/'),
    wasmBytes: build.wasmBytes,
    wasmSha256: build.wasmSha256,
    objects: build.objects,
    ownSource: build.ownSource,
    ownSourceSha256: build.ownSourceSha256,
    reusedObjectsFrom: build.reusedObjectsFrom,
    reusedObjectsProvenance: t005Provenance ? {
      report: path.relative(ROOT, t005Report).split(path.sep).join('/'),
      status: t005Provenance.status,
      buildMode: t005Provenance.wasm?.buildMode,
      batchModuleBytes: t005Provenance.wasm?.bytes,
      batchModuleSha256: t005Provenance.wasm?.sha256,
      objects: t005Provenance.wasm?.objects
    } : null,
    exports: build.exports
  },
  geometry: {
    path: path.relative(ROOT, GEOMETRY).split(path.sep).join('/'),
    bytes: readFileSync(GEOMETRY).length,
    levelDraws: geometry.levelDraws.length,
    carDraws: geometry.carDraws.length,
    levelVertices: geometry.meshes[0].vertexCount,
    levelTriangles: geometry.meshes[0].indexCount / 3,
    trackVertices: geometry.meshes[2]?.vertexCount ?? 0,
    trackTriangles: (geometry.meshes[2]?.indexCount ?? 0) / 3,
    carVertices: geometry.meshes[1].vertexCount,
    carTriangles: geometry.meshes[1].indexCount / 3,
    source: geometry.source.packet,
    sourcePacketHash: geometry.source.packetHash,
    trackSource: geometry.source.track
  },
  drive: {
    spawn: TICK0_LIMITS,
    groundProbe: runA.ground,
    tickHz: TICK_HZ,
    script: PHASES.map((phase) => ({ name: phase.name, ticks: phase.tickCount, input: phase.input })),
    ticks: SCRIPT_TICKS,
    dt: 1 / TICK_HZ,
    groundY: runA.info.groundY,
    startY: runA.info.startY,
    tick0: {
      position: runA.states[0].position,
      speed: runA.states[0].speed,
      contacts: runA.states[0].contacts
    },
    throttleEnd: { tick: 120, position: runA.states[120].position, speed: runA.states[120].speed },
    coastEnd: { tick: 240, position: runA.states[240].position, speed: runA.states[240].speed },
    end: { tick: SCRIPT_TICKS, position: runA.states[SCRIPT_TICKS].position, speed: runA.states[SCRIPT_TICKS].speed },
    travelledM: Number(travelled.toFixed(3)),
    travelledXZM: Number(travelXZ.toFixed(3)),
    bestSpeedMps: Number(Math.max(...runA.states.map((state) => state.speed)).toFixed(3)),
    contactTicks,
    nanTicks: nanStates,
    resetMs: [runA.resetMs, runB.resetMs],
    scriptedTicksMs: [runA.simMs, runB.simMs]
  },
  determinism: {
    separateModuleInstances: true,
    identicalStateHashes: hashesA.every((hash, index) => hash === hashesB[index]),
    stateSequenceHash,
    stateSequenceHashB: aggregate(hashesB),
    packetHash: packet.hash,
    packetHashB: runB.packet.hash,
    firstStateHash: hashesA[0],
    lastStateHash: hashesA[hashesA.length - 1],
    resetReplayFirst30Ticks: runA.replayMatches
  },
  packet: {
    path: path.relative(ROOT, path.join(OUT, 'packet.json')).split(path.sep).join('/'),
    bytes: packetBytes,
    version: packet.version,
    hash: packet.hash,
    draws: packet.draws.length,
    vertices: packet.diagnostics.vertexTotal,
    triangles: packet.diagnostics.triangleTotal,
    updates: packet.updates.length,
    firstTickHash: packet.updates[0].hash,
    lastTickHash: packet.updates[packet.updates.length - 1].hash,
    validationErrors: validation.errors.length
  },
  checks,
  failures
};
writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
writeFileSync(path.join(LOGS, 'verify.log'), log.join('\n') + '\n' +
  checks.map((entry) => (entry.ok ? 'PASS ' : 'FAIL ') + entry.label + (entry.detail ? '  [' + entry.detail + ']' : '')).join('\n') + '\n', 'utf8');

console.log(JSON.stringify({
  status: report.status,
  wasm: `${report.module.wasmBytes} B ${report.module.wasmSha256.slice(0, 16)} (${report.module.objects} objects)`,
  spawn: report.drive.spawn,
  travelledM: report.drive.travelledM,
  speeds: {
    start: report.drive.tick0.speed,
    throttleEnd: report.drive.throttleEnd.speed,
    coastEnd: report.drive.coastEnd.speed,
    end: report.drive.end.speed
  },
  contacts: report.drive.contactTicks,
  nanTicks: report.drive.nanTicks,
  stateSequenceHash: report.determinism.stateSequenceHash,
  packetHash: report.packet.hash,
  packetBytes: report.packet.bytes,
  checks: `${checks.filter((entry) => entry.ok).length}/${checks.length}`,
  failures
}, null, 2));
if (failures.length) process.exitCode = 1;
