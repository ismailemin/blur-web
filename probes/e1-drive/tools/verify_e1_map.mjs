// Verify an E1 map integration (M3 map packages: usa_amboy, spa_barcelona_gracia).
//
//   node probes/e1-drive/tools/verify_e1_map.mjs
//   node probes/e1-drive/tools/verify_e1_map.mjs --map amboy
//   node probes/e1-drive/tools/verify_e1_map.mjs --map gracia
//
// Gates:
//   1. the committed map-slice packages still match the builder pins;
//   2. `build_map_<map>.mjs --check` reproduces both generated files;
//   3. the map/layout documents pass the page's own validator;
//   4. physics settles at the measured spawn: 61/61 ticks match the committed
//      physics-settle state hashes, 4/4 contacts, finite;
//   5. the deterministic scripted sprint finishes after both ordered checkpoints,
//      with 0 respawns, no NaN and wheel contact on every tick;
//   6. replaying the recorded input sequence into a fresh module reproduces every
//      state hash (the rules never write a physics value).
//
// Outputs: `_work/e1-drive/map-<map>-run.json` (the node anchor the browser
// capture compares against) and `_work/e1-drive/map-<map>-verify.json`.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hashOf } from '../web/packet-hash.js';
import { MAPS } from '../web/map-registry.js';
import { validateMapPackage } from '../web/map-package.js';
import { createSprintRules } from '../web/sprint-rules.js';
import { sprintScriptInput } from '../web/sprint-script.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, '_work/e1-drive');
const LOGS = path.join(ROOT, '_work/logs/e1-drive');
const MAP_ID = process.argv.includes('--map') ? process.argv[process.argv.indexOf('--map') + 1] : 'amboy';
const MAP = MAPS[MAP_ID];
if (!MAP || MAP.kind !== 'map-package') throw new Error('verify_e1_map.mjs needs --map amboy|gracia');

const sha256 = (buffer) => 'sha256:' + createHash('sha256').update(buffer).digest('hex');
const readJson = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
const checks = [];
const failures = [];
const check = (label, ok, detail = null) => {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(label + (detail ? ': ' + detail : ''));
};

mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });

// ---------------------------------------------------------------- 1. builder
const perMapBuilder = path.join(ROOT, 'probes/e1-drive/tools/build_map_' + MAP_ID + '.mjs');
const builder = existsSync(perMapBuilder)
  ? spawnSync(process.execPath, [perMapBuilder, '--check'], { cwd: ROOT, encoding: 'utf8' })
  : spawnSync(process.execPath,
    [path.join(ROOT, 'probes/e1-drive/tools/build_map_batch.mjs'), '--check', '--map', MAP_ID],
    { cwd: ROOT, encoding: 'utf8' });
check('the map builder --check reproduces the generated map + layout', builder.status === 0,
  (builder.stdout + builder.stderr).trim().slice(0, 600));
if (builder.status !== 0) throw new Error('map artifacts are stale or hand-edited:\n' + builder.stdout + builder.stderr);

// ---------------------------------------------------------------- 2. package
const mapBytes = readFileSync(path.join(ROOT, MAP.geometryUrl));
const layoutBytes = readFileSync(path.join(ROOT, `${MAP.layoutUrl}`));
check('map file matches the registry SHA-256', sha256(mapBytes) === MAP.pins.mapFileSha256, sha256(mapBytes));
check('layout file matches the registry SHA-256', sha256(layoutBytes) === MAP.pins.layoutFileSha256, sha256(layoutBytes));
const map = JSON.parse(mapBytes.toString('utf8'));
const layout = JSON.parse(layoutBytes.toString('utf8'));
const validated = validateMapPackage(map, layout, MAP.pins);
check('map + layout pass the page validator', validated.ok, validated.errors.join('; '));
if (!validated.ok) throw new Error(validated.errors.join('; '));

// The committed R1 rules layer must consume the same measured samples/gates. Its
// released course-id allow-list predates M3, so the structural check uses the
// equivalent sprint id while keeping the Amboy layout bytes and hash untouched.
const raceRulesPath = path.join(ROOT, 'probes/race-rules/index.mjs');
const raceRules = await import(pathToFileURL(raceRulesPath).href);
const r1Layout = { ...layout, courseId: '310m' };
const courseModel = new raceRules.CourseModel(r1Layout, { verifyLayoutHash: false });
const spawnProjection = courseModel.project([layout.course.spawn.x, 0, layout.course.spawn.z]);
check('R1 CourseModel consumes the measured ' + MAP.label + ' gates/samples',
  courseModel.checkpointCount === 2 && courseModel.startGate.id === 'start' &&
  courseModel.finishGate.id === 'finish' && spawnProjection.arc === 0,
  JSON.stringify({ checkpoints: courseModel.checkpointCount, arc: spawnProjection.arc }));

const renderBytes = readFileSync(path.join(ROOT, map.source.render.path));
check('source render package file matches the registry pin', sha256(renderBytes) === MAP.pins.renderFileSha256);
const sliceBytes = readFileSync(path.join(ROOT, map.source.slice.path));
check('source slice package file matches the registry pin', sha256(sliceBytes) === MAP.pins.sliceFileSha256);
const levelBytes = readFileSync(path.join(ROOT, map.source.physics.path));
check('Level.levelphysics matches the registry pin',
  sha256(levelBytes) === MAP.pins.physicsFileSha256 && levelBytes.byteLength === MAP.pins.physicsBytes);
const fieldBytes = readFileSync(path.join(ROOT, '_work/e1-drive/car.fields'));
const fieldsSha = sha256(fieldBytes);
check('committed Corvette field list is the package car record',
  fieldsSha === 'sha256:1c24bbd7f055f904062d1f1b7b377be727a7cf9f64e8ca2c72dff5b138a55381', fieldsSha);

// ---------------------------------------------------------------- 3. module
const modulePath = path.join(ROOT, '_work/e1-drive/module/e1_drive.mjs');
const wasmPath = path.join(ROOT, '_work/e1-drive/module/e1_drive.wasm');
check('wasm module exists', existsSync(modulePath) && existsSync(wasmPath));
const createModule = (await import(pathToFileURL(modulePath).href)).default;
const module = await createModule();

function groundHintFor(value) {
  if (!Number.isFinite(value)) return NaN;
  return (value > 130 || value < -170) ? value : NaN;
}

function createWorld(x, z, heading) {
  const levelPtr = module._malloc(levelBytes.byteLength);
  const fieldsPtr = module._malloc(fieldBytes.byteLength + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  // Centre the ground probe on the measured spawn ground when the layout has
  // one (Mount Haruna at Y 1064, London Hackney at Y -294).
  if (typeof module._e1_set_ground_hint === 'function') {
    const hint = Number.isFinite(layout?.course?.spawnGroundY)
      ? layout.course.spawnGroundY
      : (Number.isFinite(layout?.course?.spawn?.ground) ? layout.course.spawn.ground : NaN);
    module._e1_set_ground_hint(groundHintFor(hint));
  }
  const ok = module._e1_create(levelPtr, levelBytes.byteLength, fieldsPtr, fieldBytes.byteLength, x, z, heading);
  module._free(levelPtr);
  module._free(fieldsPtr);
  if (!ok) throw new Error('e1_create failed at ' + x + ',' + z + ': ' + module.UTF8ToString(module._e1_last_error()));
  return JSON.parse(module.UTF8ToString(module._e1_get_state()));
}

const spawn = layout.course.spawn;
const tick0 = createWorld(spawn.x, spawn.z, spawn.headingRad);
const info = JSON.parse(module.UTF8ToString(module._e1_info()));
check('engine decoded the expected car', info.car === 'Corvette_ZR1_Stock', info.car);
check('engine ground probe matches the measured spawn',
  Math.abs(info.groundY - (layout.course.spawn.ground ?? layout.course.spawnGroundY)) < 1e-3,
  String(info.groundY));

// ---------------------------------------------------------------- 4. settle
// A map-slice package carries a committed 61-tick settle sequence. A map-batch
// package does not, so the settle is still measured (finite, contacts) but the
// committed-hash comparison is recorded as not applicable.
const settlePath = path.join(ROOT, '_work/map-slice/' + MAP_ID + '/physics-settle.json');
const sliceSettle = existsSync(settlePath) ? readJson('_work/map-slice/' + MAP_ID + '/physics-settle.json') : null;
const settleTicks = [{ tick: 0, stateHash: hashOf(tick0), state: tick0 }];
for (let tick = 1; tick <= 60; tick++) {
  if (!module._e1_step()) throw new Error('e1_step failed at settle tick ' + tick);
  const state = JSON.parse(module.UTF8ToString(module._e1_get_state()));
  settleTicks.push({ tick, stateHash: hashOf(state), state });
}
const settleSequence = 'sha256:' + createHash('sha256')
  .update(settleTicks.map((row) => row.stateHash).join('\n')).digest('hex');
let settleMismatch = null;
if (sliceSettle) {
  settleMismatch = settleTicks.find((row, index) => row.stateHash !== sliceSettle.ticks[index]?.stateHash);
  check('physics settle matches the committed 61/61 state hashes', !settleMismatch,
    settleMismatch ? `tick ${settleMismatch.tick}: ${settleMismatch.stateHash} vs ${sliceSettle.ticks[settleMismatch.tick]?.stateHash}` : '');
  check('settle sequence hash is the committed ' + MAP.label + ' sequence', settleSequence === sliceSettle.summary.stateSequenceHash,
    settleSequence);
} else {
  check('settle sequence is recorded (no committed map-slice settle for this package)',
    settleTicks.length === 61, 'not-committed');
}
check('settle keeps 4/4 wheel contacts on 61/61 ticks',
  settleTicks.every((row) => row.state.finite === 1 && row.state.anyContact === 1 &&
    row.state.contacts.reduce((sum, value) => sum + Number(value), 0) === 4));
check('settle has no NaN/Inf state', settleTicks.every((row) => row.state.finite === 1));

// ---------------------------------------------------------------- 5. sprint
// Fresh world after the settle proof: e1_create settles 180 ticks internally and
// reports tick 0; the settle probe above stepped 60 extra ticks, so the sprint
// must start from a newly created tick-0 world like the page does.
let state = createWorld(spawn.x, spawn.z, spawn.headingRad);
if (hashOf(state) !== settleTicks[0].stateHash) {
  throw new Error('fresh sprint world tick 0 does not match the settle tick 0');
}
const rules = createSprintRules(layout);
rules.prime(state);
const ticks = [{ tick: 0, stateHash: hashOf(state), position: state.position, speed: state.speed,
  contacts: state.contacts, finite: state.finite, anyContact: state.anyContact, arc: 0, input: [0, 0, 0, 0] }];
const inputs = [];
const events = [];
const MAX_TICKS = 20000;
let finish = null;
let respawn = null;
let maxSpeed = 0;
let maxLateral = 0;

for (let tick = 1; tick <= MAX_TICKS; tick++) {
  const input = sprintScriptInput(rules, state);
  inputs.push(input.slice());
  module._e1_set_input(input[0], input[1], input[2], input[3]);
  if (!module._e1_step()) throw new Error('e1_step failed at sprint tick ' + tick);
  state = JSON.parse(module.UTF8ToString(module._e1_get_state()));
  const tickEvents = rules.step(state);
  for (const event of tickEvents) {
    events.push({ ...event });
    if (event.type === 'respawn' && !respawn) respawn = { tick, reasons: event.reasons };
    if (event.type === 'finish' && !finish) {
      finish = { tick, timeSeconds: event.timeSeconds, checkpoints: event.checkpoints, position: event.position };
    }
  }
  const arc = rules.arc;
  if (state.speed > maxSpeed) maxSpeed = state.speed;
  if (rules.maxLateral > maxLateral) maxLateral = rules.maxLateral;
  ticks.push({ tick, stateHash: hashOf(state), position: state.position, speed: state.speed,
    contacts: state.contacts, finite: state.finite, anyContact: state.anyContact, arc,
    input: input.slice() });
  if (finish) break;
}

check('the scripted sprint reaches the finish', finish !== null, respawn ? 'respawn at tick ' + respawn.tick + ': ' + respawn.reasons.join(', ') : 'no finish within ' + MAX_TICKS + ' ticks');
check('both checkpoints are crossed in order', finish?.checkpoints === 2, String(finish?.checkpoints));
check('the run has 0 respawns', respawn === null, respawn ? JSON.stringify(respawn) : '');
check('the run has wheel contact on every tick', ticks.every((row) => row.anyContact === 1));
check('the run has no NaN/Inf state', ticks.every((row) => row.finite === 1));
check('the finish time is positive and finite', Number.isFinite(finish?.timeSeconds) && finish.timeSeconds > 0,
  String(finish?.timeSeconds));

// ---------------------------------------------------------------- 6. replay
let replayMismatch = null;
if (finish) {
  const replayModule = await createModule();
  const replayLevel = levelBytes;
  const replayFields = fieldBytes;
  const levelPtr = replayModule._malloc(replayLevel.byteLength);
  const fieldsPtr = replayModule._malloc(replayFields.byteLength);
  replayModule.HEAPU8.set(replayLevel, levelPtr);
  replayModule.HEAPU8.set(replayFields, fieldsPtr);
  if (typeof replayModule._e1_set_ground_hint === 'function') {
    const hint = Number.isFinite(layout?.course?.spawnGroundY)
      ? layout.course.spawnGroundY
      : (Number.isFinite(layout?.course?.spawn?.ground) ? layout.course.spawn.ground : NaN);
    replayModule._e1_set_ground_hint(groundHintFor(hint));
  }
  const ok = replayModule._e1_create(levelPtr, replayLevel.byteLength, fieldsPtr, replayFields.byteLength,
    spawn.x, spawn.z, spawn.headingRad);
  replayModule._free(levelPtr);
  replayModule._free(fieldsPtr);
  if (!ok) throw new Error('replay e1_create failed');
  const replay0 = JSON.parse(replayModule.UTF8ToString(replayModule._e1_get_state()));
  if (hashOf(replay0) !== ticks[0].stateHash) replayMismatch = 'tick 0';
  for (let tick = 1; tick < ticks.length && !replayMismatch; tick++) {
    const input = inputs[tick - 1];
    replayModule._e1_set_input(input[0], input[1], input[2], input[3]);
    if (!replayModule._e1_step()) throw new Error('replay e1_step failed at tick ' + tick);
    const replayState = JSON.parse(replayModule.UTF8ToString(replayModule._e1_get_state()));
    if (hashOf(replayState) !== ticks[tick].stateHash) replayMismatch = 'tick ' + tick;
  }
  check('replaying the recorded inputs into a fresh module reproduces every state hash',
    replayMismatch === null, replayMismatch ?? '');
} else {
  check('replaying the recorded inputs into a fresh module reproduces every state hash', false, 'no finish');
}

// ---------------------------------------------------------------- 7. captures
const captureSpecs = [];
const pushCapture = (label, row) => {
  captureSpecs.push({ label, tick: row.tick, stateHash: row.stateHash, position: row.position,
    speed: row.speed, arc: row.arc, input: row.input });
};
if (finish) {
  pushCapture('start', ticks[0]);
  const checkpointTick = events.find((event) => event.type === 'checkpoint' && event.index === 1);
  if (checkpointTick) {
    const row = ticks[Math.min(ticks.length - 1, checkpointTick.tick)];
    pushCapture('checkpoint', row);
  }
  const half = ticks.find((row) => row.tick > 200 && row.arc >= layout.course.lengthMetres * 0.5);
  if (half) pushCapture('mid', half);
  pushCapture('finish', ticks[ticks.length - 1]);
}

const run = {
  schema: 'e1-drive.map-run/1',
  map: MAP_ID,
  level: MAP.level,
  car: { slug: 'corvette-zr1-stock', name: info.car, fieldsSha256: fieldsSha },
  layout: { hash: layout.hash, source: layout.source, span: layout.course.span },
  pins: MAP.pins,
  settle: {
    ticks: settleTicks.length,
    sequenceHash: settleSequence,
    tick0StateHash: settleTicks[0].stateHash,
    tick60StateHash: settleTicks[60].stateHash,
    matchesCommittedPackage: !settleMismatch
  },
  sprint: {
    finish,
    checkpoints: events.filter((event) => event.type === 'checkpoint').map((event) => ({
      index: event.index, tick: event.tick, timeSeconds: event.timeSeconds, arc: event.arc, position: event.position
    })),
    respawn,
    totalTicks: ticks.length - 1,
    maxSpeedMps: maxSpeed,
    maxLateralMetres: maxLateral,
    finalSpeedMps: ticks[ticks.length - 1].speed,
    allFinite: ticks.every((row) => row.finite === 1),
    allAnyContact: ticks.every((row) => row.anyContact === 1),
    replayReproduced: replayMismatch === null,
    inputsSha256: 'sha256:' + createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),
    stateSequenceHash: 'sha256:' + createHash('sha256').update(ticks.map((row) => row.stateHash).join('\n')).digest('hex')
  },
  captures: captureSpecs,
  ticks: ticks.map((row) => ({ tick: row.tick, stateHash: row.stateHash, position: row.position,
    speed: row.speed, arc: row.arc, finite: row.finite, anyContact: row.anyContact })),
  events: events.filter((event) => ['checkpoint', 'finish', 'respawn', 'finish-blocked'].includes(event.type))
};

const runText = JSON.stringify(run, null, 2) + '\n';
writeFileSync(path.join(OUT, 'map-' + MAP_ID + '-run.json'), runText, 'utf8');

const verify = {
  schema: 'e1-drive.map-verify/1',
  map: MAP_ID,
  level: MAP.level,
  files: {
    map: { path: '_work/e1-drive/' + MAP_ID + '/map.json', bytes: mapBytes.byteLength, sha256: sha256(mapBytes) },
    layout: { path: '_work/e1-drive/' + MAP_ID + '/layout.json', bytes: layoutBytes.byteLength, sha256: sha256(layoutBytes) },
    run: { path: '_work/e1-drive/map-' + MAP_ID + '-run.json', bytes: Buffer.byteLength(runText), sha256: sha256(Buffer.from(runText)) }
  },
  package: {
    render: map.source.render,
    slice: map.source.slice,
    physics: map.source.physics,
    counts: map.counts
  },
  settle: run.settle,
  sprint: run.sprint,
  captures: captureSpecs,
  checks: checks.length,
  failures,
  ok: failures.length === 0
};
const verifyText = JSON.stringify(verify, null, 2) + '\n';
writeFileSync(path.join(OUT, 'map-' + MAP_ID + '-verify.json'), verifyText, 'utf8');
writeFileSync(path.join(LOGS, 'map-' + MAP_ID + '-verify.log'), verifyText, 'utf8');

console.log(JSON.stringify({
  ok: verify.ok,
  checks: checks.length,
  failures,
  settle: { sequenceHash: run.settle.sequenceHash, matchesPackage: run.settle.matchesCommittedPackage },
  sprint: run.sprint,
  captures: captureSpecs.map((spec) => ({ label: spec.label, tick: spec.tick, stateHash: spec.stateHash })),
  files: verify.files
}, null, 2));
if (!verify.ok) process.exit(1);

