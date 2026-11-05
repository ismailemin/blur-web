// E1 drive-slice verifier + packet producer (multi-car).
//
//   node probes/e1-drive/tools/verify_e1_drive.mjs [--car <slug|name>] [--list]
//
// Drives every car in the roster (or the one named by `--car`) with the same
// scripted drive, twice, each time in a **separate wasm module instance**, and
// checks for each car:
//   * the wasm module builds (build.json is read, not trusted: hashes are re-read)
//   * the field file is the roster's decoded record (SHA-256) and the engine
//     decodes exactly that car (`e1_info().car`)
//   * the fixed dt, the tick count and the scripted input schedule
//   * no NaN/Inf state, wheel contact during the drive
//   * the car actually moves on the collision mesh under the scripted input
//   * two independent runs produce the same per-tick state hash sequence
//   * the adapter turns the states into a schema-conformant render packet v1.1
//   * the packet names the car it describes and every per-tick matrix is rigid
//   * the packet hash and every per-tick hash match the committed definition
//     (probes/render-packet/tools/packet-format.mjs), which also proves the
//     browser-side SHA-256/canonical-JSON copy agrees with node:crypto
// and across cars:
//   * the cars are distinct (pairwise different tick-0 and sequence hashes)
//   * the T-007 single-car baseline still has its recorded state sequence hash
//
// Artifacts (never committed):
//   _work/e1-drive/run.json                     the evidence document (all cars)
//   _work/e1-drive/packet-<slug>.json            the validated packet per car
//   _work/e1-drive/packet-validation-<slug>.json validator output per car
//   _work/e1-drive/state-<slug>.json             per-tick states per car
//   _work/e1-drive/{packet.json,packet.validation.json,state_a.json}
//                                               aliases of the default car
//   _work/logs/e1-drive/verify.log

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { formatPacket, hashOf, packetHash, validatePacket } from '../../render-packet/tools/packet-format.mjs';
import { isRigid } from '../../render-packet/web/interpolate.js';
import { canonicalJson, hashOf as hashOfLocal } from '../web/packet-hash.js';
import { sha256Hex } from '../web/sha256.js';
import { createSession, resolveCarBody } from '../web/packet-adapter.js';
import { PHASES, SCRIPT_TICKS, TICK_HZ, phaseAt, scriptedInput } from '../web/drive-script.js';
import { TICK0_LIMITS } from './spawn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, '_work/e1-drive');
const LOGS = path.join(ROOT, '_work/logs/e1-drive');
const MODULE = path.join(OUT, 'module/e1_drive.mjs');
const BUILD = path.join(OUT, 'module/build.json');
const GEOMETRY = path.join(OUT, 'geometry.json');
const ROSTER = path.join(OUT, 'cars.json');
const LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics');

// The T-007/E1d single-car result. The Corvette's physics must not change when
// the slice grows a roster, so its state sequence hash is pinned here.
const T007_STATE_SEQUENCE_ANCHOR =
  'sha256:83f765902ce5c610889e8a27e9bfe747f86142bddea24ecb987b29be29008e1f';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const ONLY_CAR = option('--car', null);

const failures = [];
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(label + (detail ? ': ' + detail : ''));
};

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const wrapAngle = (value) => {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

/**
 * Rotation of a wheel node relative to the body, about the proven element-local
 * +X axis. The rest transform is translation-only, so R_body^T * R_wheel is
 * exactly Rx(angle) and the angle can be read from its second column.
 */
function wheelRelativeAngle(body, wheel) {
  const c1 = [body[4], body[5], body[6]];
  const c2 = [body[8], body[9], body[10]];
  const w1 = [wheel[4], wheel[5], wheel[6]];
  const cosine = c1[0] * w1[0] + c1[1] * w1[1] + c1[2] * w1[2];
  const sine = c2[0] * w1[0] + c2[1] * w1[1] + c2[2] * w1[2];
  return Math.atan2(sine, cosine);
}

if (!existsSync(MODULE) || !existsSync(BUILD)) {
  throw new Error('wasm module missing — run `node probes/e1-drive/tools/build_module.mjs`');
}
if (!existsSync(GEOMETRY)) {
  throw new Error('geometry missing — run `node probes/e1-drive/tools/build_geometry.mjs`');
}
if (!existsSync(ROSTER)) {
  throw new Error('car roster missing — run `python probes/e1-drive/tools/car_roster.py`');
}
if (!existsSync(LEVEL)) throw new Error('level missing: ' + LEVEL);

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
const roster = JSON.parse(readFileSync(ROSTER, 'utf8'));
const levelBytes = readFileSync(LEVEL);

if (ONLY_CAR === '--list' || args.includes('--list')) {
  for (const car of roster.roster.cars) {
    console.log(`${car.order} ${car.slug} ${car.name} record ${car.record.index}/${car.record.id} ${car.drivetrain}`);
  }
  process.exit(0);
}

const cars = ONLY_CAR
  ? roster.roster.cars.filter((car) => car.slug === ONLY_CAR || car.name === ONLY_CAR)
  : roster.roster.cars;
if (cars.length === 0) {
  throw new Error('unknown car ' + JSON.stringify(ONLY_CAR) + '; roster: ' +
                  roster.roster.cars.map((car) => car.slug).join(', '));
}
const defaultCar = roster.roster.cars.find((car) => car.default) ?? roster.roster.cars[0];

check('roster passes its decode gate', roster.status === 'PASS' &&
      roster.counts.selected === roster.roster.cars.length,
      `${roster.counts.gatePass}/${roster.counts.records} records pass, ${roster.counts.selected} selected`);
check('roster covers at least four real cars', roster.roster.cars.length >= 4,
      String(roster.roster.cars.length));

// ------------------------------------------------- per-car body-mesh gates
const bodies = geometry.carBodies ?? {};
const rosterSlugs = roster.roster.cars.map((car) => car.slug);
check('geometry carries one real body per roster car (v3)',
      geometry.version === 3 && rosterSlugs.every((slug) => bodies[slug]) &&
      Object.keys(bodies).length === rosterSlugs.length,
      `${Object.keys(bodies).length} bodies, geometry v${geometry.version}`);
check('every body names its own model, manifest and mesh',
      rosterSlugs.every((slug) => {
        const body = bodies[slug];
        return body && body.slug === slug && body.manifest.fallback !== true &&
          typeof body.manifest.sourceModelPakPath === 'string' &&
          /^sha256:[0-9a-f]{64}$/.test(body.manifest.sha256) &&
          /^sha256:[0-9a-f]{64}$/.test(body.manifest.meshValueHashes.positionsFloat32LESha256) &&
          body.manifest.kind === 'blur.car-part-manifest' && body.manifest.version === 1 &&
          body.wheelGroups.length === 4;
      }),
      rosterSlugs.map((slug) => slug + ':' +
        (bodies[slug]?.manifest?.sourceModelPakPath ?? 'MISSING')).join(', '));
check('no roster car uses the documented fallback body',
      geometry.fallbackBodyCount === 0 && Array.isArray(geometry.fallbackBodies) &&
      geometry.fallbackBodies.length === 0,
      JSON.stringify(geometry.fallbackBodies ?? null));
check('the five bodies are distinct real meshes',
      new Set(rosterSlugs.map((slug) => bodies[slug]?.manifest?.meshValueHashes?.positionsFloat32LESha256))
        .size === rosterSlugs.length &&
      new Set(rosterSlugs.map((slug) => bodies[slug]?.manifest?.sourceModelSha256)).size === rosterSlugs.length,
      rosterSlugs.map((slug) =>
        (bodies[slug]?.manifest?.meshValueHashes?.positionsFloat32LESha256 ?? 'none').slice(7, 19)).join(', '));
check('the mapping index is pinned and every car is mapped',
      /^sha256:[0-9a-f]{64}$/.test(geometry.source.cars?.indexSha256 ?? '') &&
      bodies[rosterSlugs[0]]?.manifest?.mapping?.includes('.model'),
      geometry.source.cars?.indexSha256);
check('every body draw is owned by a part or explicitly unclassified',
      rosterSlugs.every((slug) => {
        const body = bodies[slug];
        return body.carDraws.length === body.manifest.draws &&
          new Set(body.carDraws.map((draw) => draw.indexOffset + ':' + draw.indexCount)).size ===
            body.carDraws.length &&
          body.carDraws.every((draw) => typeof draw.partId === 'string' ||
            draw.partKind === 'unclassified') &&
          body.carDraws.every((draw) => typeof draw.nodeId === 'string' &&
            Array.isArray(draw.diagnosticColour) && draw.diagnosticColour.length === 3 &&
            draw.diagnosticColour.every(Number.isFinite));
      }),
      rosterSlugs.map((slug) => `${slug}:${bodies[slug]?.carDraws?.length}`).join(', '));
check('every body is split into one body node and spin/static wheel nodes covering every draw',
      rosterSlugs.every((slug) => {
        const body = bodies[slug];
        const ids = body.carNodes.map((node) => node.id);
        const spin = ids.filter((id) => id.endsWith('.spin')).length;
        const stat = ids.filter((id) => id.endsWith('.static')).length;
        return ids.filter((id) => id === 'e1.car.body').length === 1 &&
          spin === 4 && stat === 4 &&
          new Set(body.carNodes.flatMap((node) => node.drawIds)).size === body.carDraws.length;
      }),
      rosterSlugs.map((slug) => `${bodies[slug]?.carNodes?.length} nodes`).join(', '));

/** One full scripted run of one car in a fresh wasm module instance. */
async function runOnce(car, fieldBytes) {
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
  if (!created) {
    throw new Error(`e1_create failed for ${car.name}: ` + module.UTF8ToString(module._e1_last_error()));
  }
  const resetMs = Date.now() - t0;
  const info = JSON.parse(module.UTF8ToString(module._e1_info()));
  const ground = JSON.parse(module.UTF8ToString(module._e1_ground_probe(TICK0_LIMITS.x, TICK0_LIMITS.z)));

  const session = createSession(geometry, JSON.parse(module.UTF8ToString(module._e1_get_state())), {
    spawn: {
      x: TICK0_LIMITS.x,
      z: TICK0_LIMITS.z,
      headingRad: TICK0_LIMITS.heading,
      source: TICK0_LIMITS.source
    },
    car: {
      slug: car.slug,
      name: car.name,
      recordIndex: car.record.index,
      recordId: car.record.id,
      drivetrain: car.drivetrain,
      mass: car.values.mass,
      fieldsSha256: car.fields.sha256
    }
  });

  const states = [];
  const tableView = [];
  const state0 = JSON.parse(module.UTF8ToString(module._e1_get_state()));
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
    if (!module._e1_step()) {
      throw new Error(`e1_step failed for ${car.name} at tick ${tick}: ` +
                      module.UTF8ToString(module._e1_last_error()));
    }
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
  // reset and replay 30 ticks, compare with this run's first 30 states.
  module._e1_reset();
  const replay = [JSON.parse(module.UTF8ToString(module._e1_get_state()))];
  for (let tick = 1; tick <= 30; tick++) {
    const input = scriptedInput(tick);
    module._e1_set_input(input[0], input[1], input[2], input[3]);
    module._e1_step();
    replay.push(JSON.parse(module.UTF8ToString(module._e1_get_state())));
  }
  const replayMatches = replay.every((state, index) => hashOfLocal(state) === hashOfLocal(states[index]));

  return { info, ground, resetMs, simMs, states, tableView, packet, replayMatches };
}

const distance = (a, b) => Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1],
                                     a.position[2] - b.position[2]);
const aggregate = (hashes) => 'sha256:' + sha256(Buffer.from(hashes.join('\n'), 'utf8'));

const log = [];
const results = [];

mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });

for (const car of cars) {
  const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
  check(`${car.name}: field file is the roster's decoded record`,
        sha256(fieldBytes) === car.fields.sha256, sha256(fieldBytes));
  check(`${car.name}: field list has every field line the decoder emitted`,
        fieldBytes.toString('utf8').trimEnd().split(/\r?\n/).length === car.fieldLines,
        String(fieldBytes.toString('utf8').trimEnd().split(/\r?\n/).length));

  const runA = await runOnce(car, fieldBytes);
  const runB = await runOnce(car, fieldBytes);
  log.push(`${car.slug}: create ${runA.resetMs}+${runB.resetMs} ms, ${SCRIPT_TICKS} ticks ` +
           `${runA.simMs}+${runB.simMs} ms`);

  // -------------------------------------------------------------- per-car gates
  check(`${car.name}: ground probe hits the collision mesh at the spawn`,
        runA.ground.status === 'ok' && runA.ground.hit === 1, JSON.stringify(runA.ground));
  check(`${car.name}: module reports the decoded XT car`, runA.info.car === car.name, runA.info.car);
  check(`${car.name}: fixed step is 1/60 s`, Math.abs(runA.info.dt - 1 / TICK_HZ) < 1e-9, String(runA.info.dt));
  check(`${car.name}: settle phase ran before tick 0`, runA.info.warmupTicks === 180,
        String(runA.info.warmupTicks));
  check(`${car.name}: tick 0 has all four wheels on the ground`,
        runA.states[0].contacts.join('') === '1111', runA.states[0].contacts.join(''));
  check(`${car.name}: tick 0 is at rest`, Math.abs(runA.states[0].speed) < 0.05,
        String(runA.states[0].speed));

  const nanStates = runA.states.filter((state) => state.finite !== 1).length;
  check(`${car.name}: no NaN/Inf state in any tick`, nanStates === 0, String(nanStates));
  const contactTicks = runA.states.filter((state) => state.anyContact === 1).length;
  check(`${car.name}: wheel contact on every scripted tick`, contactTicks === SCRIPT_TICKS + 1,
        `${contactTicks} of ${SCRIPT_TICKS + 1}`);

  const travelled = distance(runA.states[0], runA.states[SCRIPT_TICKS]);
  const travelXZ = Math.hypot(runA.states[SCRIPT_TICKS].position[0] - runA.states[0].position[0],
                              runA.states[SCRIPT_TICKS].position[2] - runA.states[0].position[2]);
  check(`${car.name}: the car leaves the spawn under throttle`, travelled > 20,
        `${travelled.toFixed(2)} m`);
  const bestSpeed = Math.max(...runA.states.map((state) => state.speed));
  check(`${car.name}: the throttle phase reaches a real road speed`, bestSpeed > 10,
        `${bestSpeed.toFixed(3)} m/s`);
  check(`${car.name}: brake phase reduces speed`,
        runA.states[SCRIPT_TICKS].speed < runA.states[240].speed,
        `${runA.states[240].speed.toFixed(3)} -> ${runA.states[SCRIPT_TICKS].speed.toFixed(3)} m/s`);
  check(`${car.name}: one second of brake brings the car to a near stop`,
        runA.states[SCRIPT_TICKS].speed < 2.0, `${runA.states[SCRIPT_TICKS].speed.toFixed(3)} m/s`);

  const hashesA = runA.tableView.map((row) => row.stateHash);
  const hashesB = runB.tableView.map((row) => row.stateHash);
  check(`${car.name}: two independent module instances produce the same state hash sequence`,
        hashesA.length === hashesB.length && hashesA.every((hash, index) => hash === hashesB[index]),
        hashesA.find((hash, index) => hash !== hashesB[index]) ?? '');
  check(`${car.name}: every tick has a distinct state hash`,
        new Set(hashesA).size === hashesA.length,
        `${new Set(hashesA).size} distinct of ${hashesA.length}`);
  check(`${car.name}: reset + replay reproduces the first 30 ticks inside one instance`,
        runA.replayMatches === true);

  const stateSequenceHash = aggregate(hashesA);
  check(`${car.name}: run B state sequence hash equals run A`,
        aggregate(hashesB) === stateSequenceHash, stateSequenceHash);

  // ----------------------------------------------------------- per-car packet
  const packet = runA.packet;
  const body = resolveCarBody(geometry, car.slug);
  const expectedCarDraws = body.carDraws.length;
  const validation = validatePacket(packet);
  check(`${car.name}: packet conforms to the v1.1 contract`, validation.ok === true,
        validation.errors.slice(0, 6).join(' | '));
  check(`${car.name}: packet version is 1.1 with a timeline`,
        packet.version === 1.1 && Array.isArray(packet.updates), String(packet.version));
  check(`${car.name}: one packet tick per scripted tick plus the settled tick`,
        packet.updates.length === SCRIPT_TICKS + 1, String(packet.updates.length));
  check(`${car.name}: the packet has the expected draw count (22 level props + 1 collision surface + ${expectedCarDraws} car)`,
        packet.draws.length === 23 + expectedCarDraws &&
        packet.diagnostics.sequence.staticDrawCount === 23,
        String(packet.draws.length));
  check(`${car.name}: materials are diagnostic and labelled`,
        packet.diagnostics.materialsApplied === false &&
        packet.draws.every((draw) => typeof draw.materialReason === 'string' && draw.materialReason.length > 0));
  check(`${car.name}: the packet names the car it describes`,
        packet.diagnostics.extras.drive.car?.name === car.name &&
        packet.diagnostics.extras.drive.car?.recordId === car.record.id,
        JSON.stringify(packet.diagnostics.extras.drive.car?.name));

  // ------------------------------------------------------- part + wheel gates
  const BODY_NODE = 'e1.car.body';
  const spinNodeIds = packet.nodes.filter((node) => node.id.endsWith('.spin')).map((node) => node.id);
  const staticNodeIds = packet.nodes.filter((node) => node.id.endsWith('.static')).map((node) => node.id);
  check(`${car.name}: the packet draws the car's own body mesh`,
        packet.diagnostics.extras.drive.car?.bodyMesh === body.meshId &&
        packet.meshes.some((mesh) => mesh.id === body.meshId) &&
        packet.placedObjects[0]?.meshId === body.meshId,
        packet.diagnostics.extras.drive.car?.bodyMesh ?? 'missing');
  check(`${car.name}: the packet draws this car's own parts and draws (${body.carParts.length} / ${body.carDraws.length})`,
        packet.diagnostics.extras.parts?.partCount === body.carParts.length &&
        packet.diagnostics.extras.parts?.drawCount === body.carDraws.length &&
        packet.draws.filter((draw) => draw.meshId === body.meshId).length === body.carDraws.length,
        JSON.stringify(packet.diagnostics.extras.parts?.partCount));
  check(`${car.name}: one body node and its spin/static wheel nodes move every car draw exactly once`,
        packet.nodes.length === body.carNodes.length &&
        packet.nodes.filter((node) => node.id === BODY_NODE).length === 1 &&
        spinNodeIds.length === 4 && staticNodeIds.length === 4 &&
        new Set(packet.nodes.flatMap((node) => node.drawIds)).size === body.carDraws.length,
        `${packet.nodes.length} nodes, ${spinNodeIds.length} spin, ${staticNodeIds.length} static`);
  check(`${car.name}: every tick carries the body plus one matrix per wheel node`,
        packet.updates.every((update) => update.matrices.length === 1 + spinNodeIds.length + staticNodeIds.length &&
          update.matrices[0].nodeId === BODY_NODE),
        String(packet.updates[0]?.matrices.length));
  const bodyWorldAt = (tick) => packet.updates[tick].matrices[0].world;
  const nodeWorldAt = (tick, nodeId) => packet.updates[tick].matrices.find((entry) => entry.nodeId === nodeId)?.world;
  const spinNode = spinNodeIds[0];
  const spinAngles = packet.updates.map((update, tick) => wheelRelativeAngle(bodyWorldAt(tick), nodeWorldAt(tick, spinNode)));
  const spinDeltas = spinAngles.slice(1).map((angle, index) => Math.abs(wrapAngle(angle - spinAngles[index])));
  const spinAdvancingTicks = spinDeltas.filter((delta) => delta > 1e-3).length;
  check(`${car.name}: wheel spin angle advances from the physics wheel angular velocity`,
        spinAdvancingTicks > SCRIPT_TICKS * 0.6,
        `${spinAdvancingTicks} of ${SCRIPT_TICKS} tick steps > 1e-3 rad, max ${Math.max(...spinDeltas).toFixed(4)} rad`);
  check(`${car.name}: the spinning wheel matrix differs between the first and last tick`,
        nodeWorldAt(0, spinNode).some((value, index) => value !== nodeWorldAt(SCRIPT_TICKS, spinNode)[index]));
  const caliperAngles = packet.updates.map((update, tick) =>
    Math.abs(wheelRelativeAngle(bodyWorldAt(tick), nodeWorldAt(tick, staticNodeIds[0]))));
  check(`${car.name}: brake calipers stay static (no spin applied)`,
        Math.max(...caliperAngles) < 1e-4, `max |angle| ${Math.max(...caliperAngles).toExponential(2)} rad`);
  check(`${car.name}: every car draw carries a labelled diagnostic colour`,
        packet.draws.filter((draw) => draw.meshId === body.meshId)
          .every((draw) => Array.isArray(draw.diagnosticColour) && draw.diagnosticColour.length === 3 &&
            draw.diagnosticColour.every(Number.isFinite) && typeof draw.colourReason === 'string' &&
            draw.colourReason.includes('not a game material')));

  const nonRigid = packet.updates.flatMap((update) => update.matrices).filter((entry) => !isRigid(entry.world));
  check(`${car.name}: every per-tick matrix is rigid`, nonRigid.length === 0, String(nonRigid.length));

  const localHashMismatch = packet.updates.filter((update) => hashOfLocal({ ...update, hash: undefined }) !== update.hash);
  check(`${car.name}: browser-side canonical JSON/SHA-256 agrees with the committed hash definition (every tick)`,
        localHashMismatch.length === 0, localHashMismatch.slice(0, 2).map((update) => update.tick).join(','));
  check(`${car.name}: packet hash matches the committed definition`, packetHash(packet) === packet.hash,
        packet.hash);
  check(`${car.name}: run B builds the same packet hash`, runB.packet.hash === packet.hash,
        `${packet.hash.slice(0, 20)} vs ${runB.packet.hash.slice(0, 20)}`);
  check(`${car.name}: tick 0 camera is the reference camera`,
        canonicalJson(packet.updates[0].camera) === canonicalJson(packet.camera));

  const tickMismatch = packet.updates.filter((update, index) => update.tick !== runA.states[index].tick);
  check(`${car.name}: packet ticks equal state ticks`, tickMismatch.length === 0);

  const carMatrixAt = (tick) => packet.updates[tick].matrices[0].world;
  check(`${car.name}: car draw transform differs between tick 0 and the last tick`,
        carMatrixAt(0).some((value, index) => value !== carMatrixAt(SCRIPT_TICKS)[index]));

  // ------------------------------------------------------------- per-car files
  const packetPath = path.join(OUT, `packet-${car.slug}.json`);
  const validationPath = path.join(OUT, `packet-validation-${car.slug}.json`);
  const statePath = path.join(OUT, `state-${car.slug}.json`);
  writeFileSync(packetPath, formatPacket(packet), 'utf8');
  writeFileSync(validationPath, JSON.stringify(validation, null, 2) + '\n', 'utf8');
  writeFileSync(statePath, JSON.stringify({
    car: { slug: car.slug, name: car.name, record: car.record, drivetrain: car.drivetrain },
    spawn: TICK0_LIMITS,
    tickHz: TICK_HZ,
    script: PHASES,
    stateSequenceHash,
    ticks: runA.tableView
  }, null, 2) + '\n', 'utf8');

  results.push({
    slug: car.slug,
    name: car.name,
    order: car.order,
    default: car.slug === defaultCar.slug,
    record: car.record,
    drivetrain: car.drivetrain,
    layout: car.layout,
    why: car.why,
    fields: car.fields,
    values: car.values,
    engine: {
      car: runA.info.car,
      physicsParametersHandle: runA.info.physicsParametersHandle,
      groundY: runA.info.groundY,
      startY: runA.info.startY,
      dt: runA.info.dt,
      warmupTicks: runA.info.warmupTicks,
      sizeofCarDynamicsXt: runA.info.sizeofCarDynamicsXt
    },
    groundProbe: runA.ground,
    drive: {
      spawn: TICK0_LIMITS,
      tickHz: TICK_HZ,
      script: PHASES.map((phase) => ({ name: phase.name, ticks: phase.tickCount, input: phase.input })),
      ticks: SCRIPT_TICKS,
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
      bestSpeedMps: Number(bestSpeed.toFixed(3)),
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
      path: path.relative(ROOT, packetPath).split(path.sep).join('/'),
      validationPath: path.relative(ROOT, validationPath).split(path.sep).join('/'),
      statePath: path.relative(ROOT, statePath).split(path.sep).join('/'),
      bytes: readFileSync(packetPath).length,
      version: packet.version,
      hash: packet.hash,
      draws: packet.draws.length,
      nodes: packet.nodes.length,
      carParts: packet.diagnostics.extras.parts?.partCount ?? null,
      wheelNodes: packet.diagnostics.extras.wheels?.wheelNodes ?? null,
      vertices: packet.diagnostics.vertexTotal,
      triangles: packet.diagnostics.triangleTotal,
      updates: packet.updates.length,
      firstTickHash: packet.updates[0].hash,
      lastTickHash: packet.updates[packet.updates.length - 1].hash,
      midTickHash: packet.updates[150]?.hash ?? null,
      validationErrors: validation.errors.length
    },
    body: {
      meshId: body.meshId,
      model: body.manifest.sourceModel,
      modelPakPath: body.manifest.sourceModelPakPath,
      modelSha256: body.manifest.sourceModelSha256,
      fallback: body.manifest.fallback === true,
      manifest: body.manifest.path,
      manifestSha256: body.manifest.sha256,
      meshPositionsSha256: body.manifest.meshValueHashes.positionsFloat32LESha256,
      meshIndicesSha256: body.manifest.meshValueHashes.indicesUint32LESha256,
      vertices: body.mesh.vertexCount,
      triangles: body.mesh.indexCount / 3,
      parts: body.carParts.length,
      draws: body.carDraws.length,
      nodes: body.carNodes.length,
      wheelGroups: body.wheelGroups.length,
      provenDraws: body.manifest.provenDraws,
      unclassifiedDraws: body.manifest.unclassifiedDraws,
      wheelDraws: body.manifest.wheelDraws,
      ambiguousWheelDraws: body.manifest.ambiguousWheelDraws,
      tyreProofTier: body.manifest.tyreProofTier,
      mapping: body.manifest.mapping
    }
  });
}

// ------------------------------------------------------------- cross-car gates
const distinctSequences = new Set(results.map((entry) => entry.determinism.stateSequenceHash));
check('every car produces a distinct state sequence', distinctSequences.size === results.length,
      `${distinctSequences.size} distinct of ${results.length}`);
const distinctTick0 = new Set(results.map((entry) => entry.determinism.firstStateHash));
check('every car has a distinct settled (tick 0) state', distinctTick0.size === results.length,
      `${distinctTick0.size} distinct of ${results.length}`);
const distinctPackets = new Set(results.map((entry) => entry.packet.hash));
check('every car produces a distinct packet', distinctPackets.size === results.length,
      `${distinctPackets.size} distinct of ${results.length}`);
const distinctBodyMeshes = new Set(results.map((entry) => entry.body.meshPositionsSha256));
check('every car draws a distinct real body mesh', distinctBodyMeshes.size === results.length,
      `${distinctBodyMeshes.size} distinct of ${results.length}`);
const distinctBodyModels = new Set(results.map((entry) => entry.body.modelSha256));
check('every car draws its own source model', distinctBodyModels.size === results.length,
      `${distinctBodyModels.size} distinct of ${results.length}`);
check('no car falls back to the shared Corvette C3 body',
      results.every((entry) => entry.body.fallback !== true &&
        !/corvette_c3/i.test(entry.body.modelPakPath ?? '') &&
        entry.body.meshId === 'car.' + entry.slug + '.body'),
      results.map((entry) => entry.body.modelPakPath).join(', '));
check('the cars are actually different machines',
      results.length === 1 ||
      (new Set(results.map((entry) => entry.record.id)).size === results.length &&
       new Set(results.map((entry) => entry.drivetrain)).size > 1),
      results.map((entry) => `${entry.name}:${entry.drivetrain}`).join(', '));

const defaultResult = results.find((entry) => entry.default);
if (defaultResult) {
  check('the T-007 Corvette state sequence hash is unchanged (no regression)',
        defaultResult.determinism.stateSequenceHash === T007_STATE_SEQUENCE_ANCHOR,
        defaultResult.determinism.stateSequenceHash);
}

// Default-car aliases keep the single-car artifact paths this slice documented.
const defaultForAliases = defaultResult ?? results[0];
writeFileSync(path.join(OUT, 'packet.json'), readFileSync(path.join(ROOT, defaultForAliases.packet.path)));
writeFileSync(path.join(OUT, 'packet.validation.json'),
              readFileSync(path.join(ROOT, defaultForAliases.packet.validationPath)));
writeFileSync(path.join(OUT, 'state_a.json'), readFileSync(path.join(ROOT, defaultForAliases.packet.statePath)));
writeFileSync(path.join(OUT, 'Level.levelphysics'), levelBytes);
writeFileSync(path.join(OUT, 'car.fields'), readFileSync(path.join(ROOT, defaultForAliases.fields.path)));
writeFileSync(path.join(OUT, 'spawn.json'), JSON.stringify(TICK0_LIMITS, null, 2) + '\n', 'utf8');

const report = {
  purpose: 'E1 drive slice: wasm vehicle physics -> render packet v1.1 -> WebGPU consumer, several XT cars',
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
    version: geometry.version,
    levelDraws: geometry.levelDraws.length,
    levelVertices: geometry.meshes[0].vertexCount,
    levelTriangles: geometry.meshes[0].indexCount / 3,
    trackVertices: geometry.meshes[1]?.vertexCount ?? 0,
    trackTriangles: (geometry.meshes[1]?.indexCount ?? 0) / 3,
    bodies: roster.roster.cars.map((car) => {
      const body = resolveCarBody(geometry, car.slug);
      return {
        slug: body.slug,
        meshId: body.meshId,
        vertices: body.mesh.vertexCount,
        triangles: body.mesh.indexCount / 3,
        draws: body.carDraws.length,
        parts: body.carParts.length,
        nodes: body.carNodes.length,
        wheelGroups: body.wheelGroups.length,
        positionsSha256: body.manifest.meshValueHashes.positionsFloat32LESha256,
        manifestSha256: body.manifest.sha256,
        modelPakPath: body.manifest.sourceModelPakPath,
        sourceModelSha256: body.manifest.sourceModelSha256,
        fallback: body.manifest.fallback === true,
        mapping: body.manifest.mapping
      };
    }),
    cars: geometry.source.cars,
    source: geometry.source.packet,
    sourcePacketHash: geometry.source.packetHash,
    trackSource: geometry.source.track
  },
  roster: {
    path: path.relative(ROOT, ROSTER).split(path.sep).join('/'),
    source: roster.source,
    decoder: roster.decoder,
    gate: roster.gate,
    counts: roster.counts,
    cars: roster.roster.cars.map((car) => ({
      slug: car.slug, name: car.name, record: car.record, drivetrain: car.drivetrain,
      layout: car.layout, fields: car.fields, values: car.values
    }))
  },
  cars: results,
  defaultCar: defaultForAliases.slug,
  // Backward-compatible views of the default car (the single-car document shape).
  drive: defaultForAliases.drive,
  determinism: defaultForAliases.determinism,
  packet: defaultForAliases.packet,
  checks,
  failures
};

writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
writeFileSync(path.join(LOGS, 'verify.log'), log.join('\n') + '\n' +
  checks.map((entry) => (entry.ok ? 'PASS ' : 'FAIL ') + entry.label +
                        (entry.detail ? '  [' + entry.detail + ']' : '')).join('\n') + '\n', 'utf8');

console.log(JSON.stringify({
  status: report.status,
  wasm: `${report.module.wasmBytes} B ${report.module.wasmSha256.slice(0, 16)} (${report.module.objects} objects)`,
  roster: `${report.roster.counts.selected} cars of ${report.roster.counts.records} records`,
  cars: results.map((entry) => ({
    car: entry.name,
    slug: entry.slug,
    drivetrain: entry.drivetrain,
    travelledM: entry.drive.travelledM,
    speeds: {
      start: entry.drive.tick0.speed,
      throttleEnd: entry.drive.throttleEnd.speed,
      coastEnd: entry.drive.coastEnd.speed,
      end: entry.drive.end.speed
    },
    contacts: entry.drive.contactTicks,
    nanTicks: entry.drive.nanTicks,
    stateSequenceHash: entry.determinism.stateSequenceHash,
    packetHash: entry.packet.hash
  })),
  checks: `${checks.filter((entry) => entry.ok).length}/${checks.length}`,
  failures
}, null, 2));
if (failures.length) process.exitCode = 1;
