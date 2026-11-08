// Replay probe self-test: format round-trip, quantisation bounds, seek,
// corruption/version rejection, determinism and size accounting.
//
// Run from the repository root:
//   node probes/replay/selftest.mjs
//
// The test uses only synthetic, deterministic snapshots in the same shape the
// multiplayer host emits. No engine, game data or e1-drive file is touched.
// It writes _work/replay/selftest.json and _work/logs/replay/selftest.log.

import fs from 'node:fs';
import path from 'node:path';
import {
  REPLAY_QUANT, REPLAY_VERSION, REPLAY_EVENT_TYPES, REPLAY_INDEX_BLOCK_SAMPLES,
  ReplayError, ReplayRecorder, ReplayPlayer, ReplayReader,
  base64ToBytes, bytesToBase64, decodeReplayBody, encodeReplayBody,
  loadReplay, measureReplayError, quantiseChannel, dequantiseValue,
  measureAbsoluteSampleBytes,
  replayHash, replayHashOf, replaySize, validateReplay, slerpQuaternion,
  normalizeQuaternion
} from './replay.mjs';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, '_work', 'replay');
const LOG_DIR = path.join(ROOT, '_work', 'logs', 'replay');
const SAMPLE_HZ = 20;
const ENGINE_HZ = 60;
const SAMPLE_SECONDS = 60;
const CAR_SLUGS = [
  'corvette-zr1-stock', 'lotus-exige-cup260', 'dodge-challenger-stock',
  'ford-focus-rs-stock', 'audi-r8v10-stock', 'mini-cooper-s-stock',
  'nissan-skyline-gt-r-stock', 'volkswagen-golf-gti-stock'
];

const checks = [];
let failures = 0;
let currentGroup = 'setup';

function check(name, condition, detail = null) {
  const ok = condition === true;
  checks.push({ group: currentGroup, name, ok, detail: ok ? null : detail });
  if (!ok) failures++;
  return ok;
}

function checkEqual(name, actual, expected) {
  return check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    { actual, expected }
  );
}

function checkNear(name, actual, limit, detail = null) {
  return check(
    name,
    typeof actual === 'number' && Number.isFinite(actual) && actual <= limit,
    { actual, limit, ...(detail ?? {}) }
  );
}

function expectThrow(name, fn, code) {
  try {
    fn();
    return check(name, false, { reason: 'did not throw' });
  } catch (error) {
    const match = error instanceof ReplayError && (code === undefined || error.code === code);
    return check(name, match, { code: error.code, message: error.message });
  }
}

function hasCode(result, code) {
  return result.errors.some((message) => message.startsWith(code + ':'));
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Deterministic synthetic race data
// ---------------------------------------------------------------------------

const HASHES = {
  build: replayHashOf({ build: 'blur-web-replay/test-build', engine: 'e1-drive', version: 1 }),
  map: replayHashOf({ map: 'usa_la_river', layout: '310m' }),
  layout: replayHashOf({ course: '310m', gates: 6, finishMetres: 310 }),
  physics: replayHashOf({ physics: 'e1-wasm-fixed-step', tickHz: ENGINE_HZ })
};

function makeParticipants(carCount) {
  return Array.from({ length: carCount }, (_, index) => ({
    id: 'pl_' + (index + 1),
    slot: index + 1,
    car: CAR_SLUGS[index % CAR_SLUGS.length],
    carHash: replayHashOf({ car: CAR_SLUGS[index % CAR_SLUGS.length], livery: index })
  }));
}

function makeDataset({ cars, seconds = SAMPLE_SECONDS, extended = false }) {
  const participants = makeParticipants(cars);
  const samplesPerSecond = SAMPLE_HZ;
  const tickStep = ENGINE_HZ / SAMPLE_HZ;
  const sampleCount = seconds * samplesPerSecond;
  const samples = [];
  for (let index = 0; index < sampleCount; index++) {
    const tick = index * tickStep;
    const time = tick / ENGINE_HZ;
    // A 1.5 s grid hold (the host's countdown) gives the RLE code a real
    // repeated-pose window; the rest of the run moves continuously.
    const motionTime = index < 90 ? 0 : time;
    const motionTick = index < 90 ? 0 : tick;
    const snapshotCars = participants.map((participant, carIndex) => {
      const phase = carIndex * 1.31 + 0.4;
      const lane = (carIndex - (cars - 1) / 2) * 2.2;
      const speed = index < 90 ? 0 : 16 + carIndex * 1.7 + 4.5 * Math.sin(motionTime * 0.83 + phase);
      const distance = 16 * motionTime + 1.8 * motionTime * motionTime / 10 +
        1.4 * Math.sin(motionTime * 0.57 + phase);
      const yaw = 0.12 * Math.sin(motionTime * 0.71 + phase);
      const position = [
        distance,
        0.015 * (1 + Math.sin(motionTime * 1.7 + phase)),
        lane + 0.35 * Math.sin(motionTime * 0.49 + phase)
      ];
      const quaternion = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
      const car = {
        id: participant.id,
        tick,
        position,
        quaternion,
        speed
      };
      if (extended) {
        car.velocity = [
          speed * Math.cos(yaw),
          0.08 * Math.cos(motionTime * 1.7 + phase),
          speed * Math.sin(yaw)
        ];
        car.wheel = [
          (motionTick * 0.17 + carIndex) % (Math.PI * 2),
          (motionTick * 0.17 + carIndex + 0.1) % (Math.PI * 2),
          (motionTick * 0.19 + carIndex) % (Math.PI * 2),
          (motionTick * 0.19 + carIndex + 0.1) % (Math.PI * 2)
        ];
        car.steer = 0.08 * Math.sin(motionTime * 0.71 + phase);
        car.health = 99.53 - (Math.floor(index / 37) % 3) * 10 - carIndex;
        car.shield = index % 160 < 60 ? 40.57 + carIndex * 5 : 0;
      }
      return car;
    });
    samples.push({ tick, cars: snapshotCars });
  }
  const lastTick = samples[samples.length - 1].tick;
  const events = [
    { tick: 90, type: 'pickup', participantId: participants[0].id, pickup: 'Shield', level: 'Normal' },
    { tick: 300, type: 'hit', participantId: participants[1 % participants.length].id, targetId: participants[0].id, damage: 15 },
    { tick: 540, type: 'wreck', participantId: participants[1 % participants.length].id, source: 'hit' },
    { tick: 600, type: 'respawn', participantId: participants[1 % participants.length].id },
    { tick: 900, type: 'pickup', participantId: participants[0].id, pickup: 'Nitrous', level: 'Normal' },
    { tick: 1500, type: 'lap', participantId: participants[0].id, lap: 1 },
    { tick: 2100, type: 'hit', participantId: participants[0].id, targetId: participants[1 % participants.length].id, damage: 10 },
    { tick: lastTick, type: 'finish', participantId: participants[0].id }
  ];
  const result = {
    winnerId: participants[0].id,
    map: 'usa_la_river',
    rows: participants.map((participant, index) => ({
      id: participant.id,
      position: index + 1,
      status: index === participants.length - 1 && participants.length > 2 ? 'dnf' : 'finished',
      finishTick: index === participants.length - 1 && participants.length > 2 ? null : lastTick - index * tickStep,
      timeSeconds: index === participants.length - 1 && participants.length > 2
        ? null
        : (lastTick - index * tickStep) / ENGINE_HZ
    }))
  };
  return {
    participants,
    samples,
    events,
    result,
    map: { id: 'usa_la_river', hash: HASHES.map },
    hashes: HASHES,
    expected: {
      version: REPLAY_VERSION,
      buildHash: HASHES.build,
      mapHash: HASHES.map,
      layoutHash: HASHES.layout,
      physicsHash: HASHES.physics,
      carHashes: Object.fromEntries(participants.map((participant) => [participant.id, participant.carHash]))
    }
  };
}

function record(dataset, options = {}) {
  const recorder = new ReplayRecorder({
    tickHz: SAMPLE_HZ,
    engineTickHz: ENGINE_HZ,
    map: dataset.map,
    hashes: dataset.hashes,
    participants: dataset.participants,
    createdAt: '2026-11-08T00:00:00.000Z',
    labels: {
      engineIntegration: false,
      retailReplayFormat: false,
      sampleSource: 'host-20Hz-snapshot',
      powerupsRecorded: 'events-only'
    },
    keepRaw: true
  });
  for (const snapshot of dataset.samples) recorder.capture(snapshot);
  for (const event of dataset.events) recorder.addEvent(event);
  recorder.setResult(dataset.result);
  const replay = recorder.build(options);
  return { recorder, replay };
}

function flipBase64(text) {
  const index = Math.floor(text.length / 2);
  const replacement = text[index] === 'A' ? 'B' : 'A';
  return text.slice(0, index) + replacement + text.slice(index + 1);
}

// ---------------------------------------------------------------------------
// 1. Quantisation bounds
// ---------------------------------------------------------------------------

currentGroup = 'quantisation';

const random = lcg(0x0b1a7);
const positionValues = Array.from({ length: 12 }, () => (random() * 2 - 1) * 500);
for (let index = 0; index < positionValues.length; index++) {
  const raw = positionValues[index];
  const quantised = quantiseChannel([raw, 0, 0], 'position')[0];
  const decoded = dequantiseValue(quantised, 'position');
  checkNear('position quantisation error ' + index, Math.abs(decoded - raw), REPLAY_QUANT.position.maxError);
}
for (let index = 0; index < 12; index++) {
  const raw = random() * 2 - 1;
  const quantised = quantiseChannel([raw, raw, raw, raw], 'quaternion')[0];
  const decoded = dequantiseValue(quantised, 'quaternion');
  checkNear('quaternion component error ' + index, Math.abs(decoded - raw), REPLAY_QUANT.quaternion.maxError);
}
for (const [channel, width, spread] of [
  ['speed', 1, 120], ['velocity', 3, 120], ['wheel', 4, 32],
  ['steer', 1, 1], ['health', 1, 200], ['shield', 1, 200]
]) {
  for (let index = 0; index < 8; index++) {
    const raw = Array.from({ length: width }, () => (random() * 2 - 1) * spread);
    const quantised = quantiseChannel(raw, channel);
    let worst = 0;
    for (let component = 0; component < width; component++) {
      worst = Math.max(worst, Math.abs(dequantiseValue(quantised[component], channel) - raw[component]));
    }
    checkNear(channel + ' quantisation error ' + index, worst, REPLAY_QUANT[channel].maxError);
  }
}

// Quaternion helpers round-trip through slerp without leaving the unit sphere.
const qa = normalizeQuaternion([0.1, 0.2, 0.3, 0.9]);
const qb = normalizeQuaternion([-0.2, 0.1, 0.05, 0.95]);
for (const t of [0, 0.25, 0.5, 0.75, 1]) {
  const q = slerpQuaternion(qa, qb, t);
  checkNear('slerp unit length at ' + t, Math.abs(Math.hypot(...q) - 1), 1e-12);
}

// ---------------------------------------------------------------------------
// 2. Build the recordings
// ---------------------------------------------------------------------------

currentGroup = 'build';

const datasets = {
  base2: makeDataset({ cars: 2, extended: false }),
  base4: makeDataset({ cars: 4, extended: false }),
  base8: makeDataset({ cars: 8, extended: false }),
  ext8: makeDataset({ cars: 8, extended: true })
};
const recordings = {};
for (const [key, dataset] of Object.entries(datasets)) {
  recordings[key] = record(dataset);
}

for (const [key, dataset] of Object.entries(datasets)) {
  const { replay } = recordings[key];
  const validated = validateReplay(replay, dataset.expected);
  check(key + ' validates against the build manifest', validated.ok, validated.errors);
  check(key + ' canonical hash re-computes', replayHash(replay) === replay.hash);
  check(key + ' hash is sha256 hex', /^sha256:[0-9a-f]{64}$/.test(replay.hash));
  check(key + ' header records build/map/layout/physics',
    replay.hashes.build === HASHES.build && replay.hashes.map === HASHES.map &&
    replay.hashes.layout === HASHES.layout && replay.hashes.physics === HASHES.physics);
  check(key + ' all car hashes are present',
    dataset.participants.every((participant) => replay.hashes.cars[participant.id] === participant.carHash));
  check(key + ' sample count matches the input', replay.sampleCount === dataset.samples.length);
  check(key + ' tick range matches the input',
    replay.firstTick === dataset.samples[0].tick &&
    replay.lastTick === dataset.samples[dataset.samples.length - 1].tick);
  check(key + ' participant count matches', replay.participants.length === dataset.participants.length);
  check(key + ' events are tick-sorted',
    replay.events.every((event, index) => index === 0 || event.tick >= replay.events[index - 1].tick));
  check(key + ' result rows match the input', JSON.stringify(replay.result) === JSON.stringify(dataset.result));
  check(key + ' scope labels are preserved',
    replay.labels.retailReplayFormat === false &&
    replay.labels.sampleSource === 'host-20Hz-snapshot');
}

// ---------------------------------------------------------------------------
// 3. Round-trip and measured error
// ---------------------------------------------------------------------------

currentGroup = 'round-trip';

const errorReport = {};
for (const [key, dataset] of Object.entries(datasets)) {
  const { replay } = recordings[key];
  const reader = new ReplayReader(replay);
  const measured = measureReplayError(dataset.samples, replay);
  errorReport[key] = measured;
  check(key + ' compares every raw car sample',
    measured.cars === dataset.samples.length * dataset.participants.length,
    { cars: measured.cars, expected: dataset.samples.length * dataset.participants.length });
  checkNear(key + ' position axis error vs raw', measured.positionAxisMax, REPLAY_QUANT.position.maxError + 1e-12);
  checkNear(key + ' position Euclidean error vs raw', measured.positionMax,
    Math.sqrt(3) * REPLAY_QUANT.position.maxError + 1e-12);
  checkNear(key + ' quaternion angular error vs raw', measured.quaternionAngleMax, 1e-4);
  checkNear(key + ' quaternion component error vs raw', measured.quaternionComponentMax, REPLAY_QUANT.quaternion.maxError + 1e-6);
  checkNear(key + ' speed error vs raw', measured.speedMax, REPLAY_QUANT.speed.maxError + 1e-12);
  if (dataset === datasets.ext8) {
    checkNear('extended velocity error vs raw', measured.velocityMax,
      Math.sqrt(3) * REPLAY_QUANT.velocity.maxError + 1e-12);
    checkNear('extended wheel error vs raw', measured.wheelMax, REPLAY_QUANT.wheel.maxError + 1e-12);
    checkNear('extended steer error vs raw', measured.steerMax, REPLAY_QUANT.steer.maxError + 1e-12);
    checkNear('extended health error vs raw', measured.healthMax, REPLAY_QUANT.health.maxError + 1e-12);
    checkNear('extended shield error vs raw', measured.shieldMax, REPLAY_QUANT.shield.maxError + 1e-12);
  }
  const firstId = dataset.participants[0].id;
  const decoded = reader.allSamples(firstId);
  checkEqual(key + ' decoded sample ticks equal the input ticks',
    decoded.map((car) => car.tick),
    dataset.samples.map((snapshot) => snapshot.tick));
  checkEqual(key + ' decoded result equals the input result',
    reader.replay.result, dataset.result);
  checkEqual(key + ' decoded events equal the input events',
    reader.replay.events, dataset.events);
  for (let index = 0; index < dataset.participants.length; index++) {
    const participant = dataset.participants[index];
    check(key + ' participant ' + participant.id + ' decodes every sample',
      reader.allSamples(participant.id).length === dataset.samples.length);
  }
  // Spot-check the exact tick/position of the first and last sample.
  const firstDecoded = decoded[0];
  const lastDecoded = decoded[decoded.length - 1];
  const firstRaw = dataset.samples[0].cars[0];
  const lastRaw = dataset.samples[dataset.samples.length - 1].cars[0];
  checkNear(key + ' first position x error', Math.abs(firstDecoded.position[0] - firstRaw.position[0]),
    REPLAY_QUANT.position.maxError + 1e-12);
  checkNear(key + ' last position x error', Math.abs(lastDecoded.position[0] - lastRaw.position[0]),
    REPLAY_QUANT.position.maxError + 1e-12);
}

// Round-trip equality of each event payload.
for (const [index, event] of datasets.base8.events.entries()) {
  const decoded = recordings.base8.replay.events[index];
  check('event ' + index + ' type round-trips', decoded.type === event.type);
  check('event ' + index + ' tick round-trips', decoded.tick === event.tick);
  check('event ' + index + ' participant round-trips', decoded.participantId === event.participantId);
}
check('every documented event type was exercised',
  REPLAY_EVENT_TYPES.every((type) => datasets.base8.events.some((event) => event.type === type)));

// ---------------------------------------------------------------------------
// 4. Seek correctness (index path vs full sequential decode)
// ---------------------------------------------------------------------------

currentGroup = 'seek';

const seekTargets = [0, 1, 31, 32, 33, 63, 64, 100, 599, 1000, 1199];
for (const [key, dataset] of Object.entries(datasets)) {
  const { replay } = recordings[key];
  const player = new ReplayPlayer(replay, dataset.expected);
  const reader = new ReplayReader(replay);
  const expectedByTick = new Map();
  for (const participant of dataset.participants) {
    for (const car of reader.allSamples(participant.id)) {
      if (!expectedByTick.has(car.tick)) expectedByTick.set(car.tick, new Map());
      expectedByTick.get(car.tick).set(car.id, car);
    }
  }
  for (const sampleIndex of seekTargets) {
    const tick = dataset.samples[Math.min(sampleIndex, dataset.samples.length - 1)].tick;
    const state = player.seek(tick);
    const expectedCars = expectedByTick.get(tick);
    let ok = Boolean(expectedCars) && state.cars.length === dataset.participants.length;
    if (ok) {
      for (const car of state.cars) {
        const expected = expectedCars.get(car.id);
        if (!expected ||
            JSON.stringify(car.position) !== JSON.stringify(expected.position) ||
            JSON.stringify(car.quaternionQuantised) !== JSON.stringify(expected.quaternionQuantised) ||
            car.speed !== expected.speed) {
          ok = false;
          break;
        }
      }
    }
    check(key + ' seek to sample ' + sampleIndex + ' equals sequential decode', ok,
      { tick, sampleTick: state.sampleTick });
    check(key + ' seek reports the landed sample tick', state.sampleTick === tick, state.sampleTick);
  }
  const first = player.seek(-999);
  check(key + ' seek clamps before the first tick', first.sampleTick === replay.firstTick, first.sampleTick);
  const last = player.seek(1e9);
  check(key + ' seek clamps after the last tick', last.sampleTick === replay.lastTick, last.sampleTick);
  const again = player.seek(seekTargets[5] * 3);
  const twice = player.seek(seekTargets[5] * 3);
  check(key + ' seek is idempotent',
    JSON.stringify(again.cars.map((car) => car.position)) ===
    JSON.stringify(twice.cars.map((car) => car.position)));
  check(key + ' seek returns every car', again.cars.length === dataset.participants.length);
  check(key + ' index block count is ceil(samples / block)',
    replay.participants.every((participant) =>
      decodeReplayBody(replay).participants.find((entry) => entry.id === participant.id).blocks.length ===
      Math.ceil(participant.sampleCount / REPLAY_INDEX_BLOCK_SAMPLES)));
  const decodedBody = decodeReplayBody(replay);
  check(key + ' first seek block starts at firstTick',
    decodedBody.participants.every((participant) => participant.blocks[0].tick === replay.firstTick));
  check(key + ' seek blocks are tick-ordered',
    decodedBody.participants.every((participant) =>
      participant.blocks.every((block, index) => index === 0 || block.tick > participant.blocks[index - 1].tick)));
  check(key + ' seek offsets stay inside the sample bytes',
    decodedBody.participants.every((participant) =>
      participant.blocks.every((block) => block.offset >= 0 && block.offset < participant.bytes.length)));
}

// Interpolation at a tick between two samples stays on the unit quaternion and
// inside the two raw positions.
const interpPlayer = new ReplayPlayer(recordings.base2.replay, datasets.base2.expected);
const interp = interpPlayer.sampleAt(4);
check('interpolated state returns every car', interp.cars.length === 2);
for (const car of interp.cars) {
  checkNear('interpolated quaternion unit length ' + car.id, Math.abs(Math.hypot(...car.quaternion) - 1), 1e-9);
}
const between = interpPlayer.sampleAt(1);
const nextSample = interpPlayer.sampleAt(3);
check('interpolation is monotone between samples',
  between.cars[0].position[0] >= Math.min(interpPlayer.seek(0).cars[0].position[0], nextSample.cars[0].position[0]) &&
  between.cars[0].position[0] <= Math.max(interpPlayer.seek(0).cars[0].position[0], nextSample.cars[0].position[0]));

// ---------------------------------------------------------------------------
// 5. Playback rate
// ---------------------------------------------------------------------------

currentGroup = 'playback';

{
  const player = new ReplayPlayer(recordings.base2.replay, datasets.base2.expected);
  check('default playback rate is 1', player.playbackRate === 1);
  checkNear('duration seconds is the race duration', player.durationSeconds, 60, { duration: player.durationSeconds });
  player.play();
  check('play sets playing', player.playing === true);
  player.advance(1);
  checkNear('advance at rate 1 moves one second of engine ticks',
    Math.abs(player.cursorTick - (player.firstTick + ENGINE_HZ)), 1e-9,
    { cursor: player.cursorTick });
  player.seek(player.firstTick);
  player.playbackRate = 2;
  player.advance(1);
  checkNear('advance at rate 2 moves two seconds',
    Math.abs(player.cursorTick - (player.firstTick + 2 * ENGINE_HZ)), 1e-9,
    { cursor: player.cursorTick });
  player.seek(player.firstTick);
  player.playbackRate = 0.5;
  player.advance(1);
  checkNear('advance at rate 0.5 moves half a second',
    Math.abs(player.cursorTick - (player.firstTick + 0.5 * ENGINE_HZ)), 1e-9,
    { cursor: player.cursorTick });
  expectThrow('playbackRate 0 is rejected', () => { player.playbackRate = 0; }, 'REPLAY_CONFIG');
  expectThrow('playbackRate above 8 is rejected', () => { player.playbackRate = 9; }, 'REPLAY_CONFIG');
  player.playbackRate = 1;
  player.pause();
  const pausedTick = player.cursorTick;
  player.advance(5);
  check('pause stops the clock', player.cursorTick === pausedTick);
  player.play();
  player.advance(5);
  check('play resumes the clock', player.cursorTick > pausedTick);
  player.seek(player.lastTick - 1);
  player.play();
  player.advance(10);
  check('advance clamps at the last tick', player.cursorTick === player.lastTick);
  check('advance marks the replay ended', player.ended === true && player.playing === false);
  check('seek past the end marks ended', player.seek(player.lastTick).sampleTick === player.lastTick && player.ended);
  const events = player.eventsBetween(500, 1000);
  check('eventsBetween filters by tick', events.length === 3 &&
    events.every((event) => event.tick >= 500 && event.tick <= 1000), events.map((event) => event.tick));
}

// ---------------------------------------------------------------------------
// 6. Validation and corruption rejection
// ---------------------------------------------------------------------------

currentGroup = 'validation';

{
  const { replay } = recordings.base2;
  const expected = datasets.base2.expected;
  const tamperedVersion = { ...replay, version: 2 };
  const versionCheck = validateReplay(tamperedVersion, expected);
  check('version mismatch is rejected', !versionCheck.ok && hasCode(versionCheck, 'REPLAY_VERSION_MISMATCH'));
  check('version mismatch also fails the canonical hash', hasCode(versionCheck, 'REPLAY_HASH_MISMATCH'));

  const tamperedBuild = {
    ...replay,
    hashes: { ...replay.hashes, build: replayHashOf({ build: 'other' }) }
  };
  const buildCheck = validateReplay(tamperedBuild, expected);
  check('build hash mismatch is rejected', !buildCheck.ok && hasCode(buildCheck, 'REPLAY_BUILD_MISMATCH'));

  const tamperedMap = {
    ...replay,
    hashes: { ...replay.hashes, map: replayHashOf({ map: 'other' }) }
  };
  const mapCheck = validateReplay(tamperedMap, expected);
  check('map hash mismatch is rejected', !mapCheck.ok && hasCode(mapCheck, 'REPLAY_MAP_MISMATCH'));

  const tamperedPhysics = {
    ...replay,
    hashes: { ...replay.hashes, physics: replayHashOf({ physics: 'other' }) }
  };
  const physicsCheck = validateReplay(tamperedPhysics, expected);
  check('physics hash mismatch is rejected', !physicsCheck.ok && hasCode(physicsCheck, 'REPLAY_PHYSICS_MISMATCH'));

  const tamperedCar = {
    ...replay,
    participants: replay.participants.map((participant, index) =>
      index === 0 ? { ...participant, carHash: replayHashOf({ car: 'other' }) } : participant)
  };
  const carCheck = validateReplay(tamperedCar, expected);
  check('car hash mismatch is rejected', !carCheck.ok && hasCode(carCheck, 'REPLAY_CAR_MISMATCH'));

  const inconsistent = {
    ...replay,
    hashes: {
      ...replay.hashes,
      cars: { ...replay.hashes.cars, [replay.participants[0].id]: replayHashOf({ car: 'inconsistent' }) }
    }
  };
  inconsistent.hash = replayHash(inconsistent);
  const inconsistentCheck = validateReplay(inconsistent);
  check('participant row vs hashes.cars disagreement is rejected (hash re-computed)',
    !inconsistentCheck.ok && hasCode(inconsistentCheck, 'REPLAY_CAR_MISMATCH'));

  const tamperedBody = { ...replay, body: flipBase64(replay.body) };
  const bodyCheck = validateReplay(tamperedBody, expected);
  check('tampered body byte is rejected', !bodyCheck.ok, bodyCheck.errors);

  const truncated = { ...replay, body: replay.body.slice(0, replay.body.length - 8) };
  const truncatedCheck = validateReplay(truncated, expected);
  check('truncated body is rejected', !truncatedCheck.ok &&
    (hasCode(truncatedCheck, 'REPLAY_BAD_BASE64') || hasCode(truncatedCheck, 'REPLAY_CORRUPT')), truncatedCheck.errors);

  const invalidBase64 = { ...replay, body: '!!!!' };
  const base64Check = validateReplay(invalidBase64, expected);
  check('invalid base64 is rejected', !base64Check.ok && hasCode(base64Check, 'REPLAY_BAD_BASE64'));

  const missingParticipants = { ...replay, participants: [] };
  const missingCheck = validateReplay(missingParticipants, expected);
  check('missing participants are rejected', !missingCheck.ok);

  const badEvents = {
    ...replay,
    events: [...replay.events, { tick: replay.lastTick + 1000, type: 'finish', participantId: replay.participants[0].id }]
  };
  const eventCheck = validateReplay(badEvents, expected);
  check('event outside the tick range is rejected', !eventCheck.ok && hasCode(eventCheck, 'REPLAY_EVENT'));

  const unknownEvent = {
    ...replay,
    events: [...replay.events, { tick: replay.firstTick, type: 'teleport' }]
  };
  check('unknown event type is rejected', hasCode(validateReplay(unknownEvent, expected), 'REPLAY_EVENT'));

  expectThrow('loadReplay throws REPLAY_REJECTED on a build mismatch',
    () => loadReplay(tamperedBuild, expected), 'REPLAY_REJECTED');

  expectThrow('capture rejects a non-monotonic tick', () => {
    const recorder = new ReplayRecorder({
      tickHz: SAMPLE_HZ, engineTickHz: ENGINE_HZ, participants: datasets.base2.participants,
      map: datasets.base2.map, hashes: HASHES
    });
    recorder.capture({ tick: 30, cars: datasets.base2.samples[10].cars });
    recorder.capture({ tick: 0, cars: datasets.base2.samples[0].cars });
  }, 'REPLAY_TICK_ORDER');

  expectThrow('capture rejects a missing participant', () => {
    const recorder = new ReplayRecorder({
      tickHz: SAMPLE_HZ, engineTickHz: ENGINE_HZ, participants: datasets.base2.participants,
      map: datasets.base2.map, hashes: HASHES
    });
    recorder.capture({ tick: 0, cars: [datasets.base2.samples[0].cars[0]] });
  }, 'REPLAY_PARTICIPANT');

  expectThrow('capture rejects a car whose tick disagrees with the snapshot', () => {
    const recorder = new ReplayRecorder({
      tickHz: SAMPLE_HZ, engineTickHz: ENGINE_HZ, participants: datasets.base2.participants,
      map: datasets.base2.map, hashes: HASHES
    });
    const cars = datasets.base2.samples[0].cars.map((car, index) =>
      index === 0 ? { ...car, tick: 3 } : car);
    recorder.capture({ tick: 0, cars });
  }, 'REPLAY_TICK_ORDER');

  expectThrow('capture rejects a non-finite position', () => {
    const recorder = new ReplayRecorder({
      tickHz: SAMPLE_HZ, engineTickHz: ENGINE_HZ, participants: datasets.base2.participants,
      map: datasets.base2.map, hashes: HASHES
    });
    const cars = datasets.base2.samples[0].cars.map((car, index) =>
      index === 0 ? { ...car, position: [NaN, 0, 0] } : car);
    recorder.capture({ tick: 0, cars });
  }, 'REPLAY_VALUE');

  expectThrow('recorder rejects a bad event type', () => {
    const recorder = new ReplayRecorder({
      tickHz: SAMPLE_HZ, engineTickHz: ENGINE_HZ, participants: datasets.base2.participants,
      map: datasets.base2.map, hashes: HASHES
    });
    recorder.addEvent({ tick: 0, type: 'teleport' });
  }, 'REPLAY_EVENT');

  expectThrow('recorder rejects a result row for an unknown participant', () => {
    const recorder = new ReplayRecorder({
      tickHz: SAMPLE_HZ, engineTickHz: ENGINE_HZ, participants: datasets.base2.participants,
      map: datasets.base2.map, hashes: HASHES
    });
    recorder.setResult({ rows: [{ id: 'pl_missing', position: 1 }] });
  }, 'REPLAY_RESULT');

  expectThrow('build rejects an event outside the recorded tick range', () => {
    const recorder = new ReplayRecorder({
      tickHz: SAMPLE_HZ, engineTickHz: ENGINE_HZ, participants: datasets.base2.participants,
      map: datasets.base2.map, hashes: HASHES
    });
    for (const snapshot of datasets.base2.samples.slice(0, 40)) recorder.capture(snapshot);
    recorder.addEvent({ tick: datasets.base2.samples[39].tick + 3, type: 'finish',
      participantId: datasets.base2.participants[0].id });
    recorder.setResult(datasets.base2.result);
    recorder.build();
  }, 'REPLAY_EVENT');

  expectThrow('recorder rejects a replay without a result', () => {
    const recorder = new ReplayRecorder({
      tickHz: SAMPLE_HZ, engineTickHz: ENGINE_HZ, participants: datasets.base2.participants,
      map: datasets.base2.map, hashes: HASHES
    });
    for (const snapshot of datasets.base2.samples.slice(0, 40)) recorder.capture(snapshot);
    recorder.build();
  }, 'REPLAY_CONFIG');
}

// ---------------------------------------------------------------------------
// 7. Determinism
// ---------------------------------------------------------------------------

currentGroup = 'determinism';

for (const [key, dataset] of Object.entries(datasets)) {
  const first = record(dataset).replay;
  const second = record(dataset).replay;
  check(key + ' two builds produce identical JSON', JSON.stringify(first) === JSON.stringify(second));
  check(key + ' two builds produce the same canonical hash', first.hash === second.hash);
  check(key + ' two builds produce the same body', first.body === second.body);
  const readerA = new ReplayReader(first);
  const readerB = new ReplayReader(second);
  const id = dataset.participants[0].id;
  checkEqual(key + ' two builds decode identically',
    readerA.allSamples(id).map((car) => [car.tick, car.position, car.quaternionQuantised, car.speed]),
    readerB.allSamples(id).map((car) => [car.tick, car.position, car.quaternionQuantised, car.speed]));
}

// RLE must be deterministic too: a second pass with the same options is equal.
{
  const a = record(datasets.base8, { rle: true }).replay;
  const b = record(datasets.base8, { rle: true }).replay;
  check('RLE encoding is deterministic', a.body === b.body && a.hash === b.hash);
  const noRle1 = record(datasets.base8, { rle: false }).replay;
  const noRle2 = record(datasets.base8, { rle: false }).replay;
  check('non-RLE encoding is deterministic', noRle1.body === noRle2.body && noRle1.hash === noRle2.hash);
}

// ---------------------------------------------------------------------------
// 8. Size accounting and bytes/minute
// ---------------------------------------------------------------------------

currentGroup = 'size';

function sizeRow(key, dataset, replay, rawSamples, recorder) {
  const size = replaySize(replay);
  const seconds = dataset.samples.length / SAMPLE_HZ;
  const perMinute = Math.round(size.jsonBytes * 60 / seconds);
  const rawBytes = Buffer.byteLength(JSON.stringify(rawSamples), 'utf8');
  const cars = dataset.participants.length;
  const participantSamples = dataset.participants.map((participant) =>
    recorder.quantisedSamples(participant.id));
  const participantChannels = replay.participants.map((participant) => participant.channels);
  const absoluteSampleBytes = measureAbsoluteSampleBytes(participantSamples, participantChannels);
  return {
    key,
    cars,
    channels: replay.participants[0].channels.join('+'),
    samples: replay.sampleCount,
    seconds,
    rawJsonBytes: rawBytes,
    rawJsonBytesPerMinute: Math.round(rawBytes * 60 / seconds),
    replayJsonBytes: size.jsonBytes,
    bytesPerMinute: perMinute,
    sampleBytes: size.sampleBytes,
    indexBytes: size.indexBytes,
    bodyBytes: size.bodyBytes,
    bodyBase64Bytes: size.bodyBase64Bytes,
    absoluteSampleBytes,
    deltaSavingPercent: Number((100 * (1 - size.sampleBytes / absoluteSampleBytes)).toFixed(1)),
    bytesPerCarPerMinute: Math.round(perMinute / cars),
    ratioToRaw: Number((size.jsonBytes / rawBytes).toFixed(3)),
    ghost20HzBytesPerMinute: 44 * SAMPLE_HZ * 60 * cars,
    ghost60HzBytesPerMinute: 44 * ENGINE_HZ * 60 * cars,
    ratioToGhost20Hz: Number((size.jsonBytes / (44 * SAMPLE_HZ * 60 * cars)).toFixed(3)),
    replayHash: replay.hash
  };
}

const sizes = [];
for (const key of ['base2', 'base4', 'base8', 'ext8']) {
  const { replay, recorder } = recordings[key];
  sizes.push(sizeRow(key, datasets[key], replay, datasets[key].samples, recorder));
}
const noRleRecording = record(datasets.base8, { rle: false });
sizes.push(sizeRow('base8-no-rle', datasets.base8, noRleRecording.replay,
  datasets.base8.samples, noRleRecording.recorder));
const noRle = noRleRecording.replay;

for (const row of sizes) {
  const { replay } = recordings[row.key] ?? {};
  const size = replay ? replaySize(replay) : null;
  check(row.key + ' size accounting adds up',
    row.sampleBytes + row.indexBytes === row.bodyBytes,
    { sampleBytes: row.sampleBytes, indexBytes: row.indexBytes, bodyBytes: row.bodyBytes });
  check(row.key + ' base64 body length matches the byte count',
    row.bodyBase64Bytes === Math.ceil(row.bodyBytes / 3) * 4,
    { bodyBase64Bytes: row.bodyBase64Bytes, bodyBytes: row.bodyBytes });
  if (size) {
    check(row.key + ' JSON size is at least the body', size.jsonBytes > size.bodyBase64Bytes);
  }
  check(row.key + ' header overhead is positive',
    row.replayJsonBytes - row.bodyBase64Bytes > 0);
}

check('RLE reduces the 8-car base replay', sizes.find((row) => row.key === 'base8').replayJsonBytes <
  sizes.find((row) => row.key === 'base8-no-rle').replayJsonBytes);
check('delta encoding reduces the 8-car sample bytes',
  sizes.find((row) => row.key === 'base8').sampleBytes <
  sizes.find((row) => row.key === 'base8').absoluteSampleBytes);
check('delta saving is measurable',
  sizes.find((row) => row.key === 'base8').deltaSavingPercent > 20,
  sizes.find((row) => row.key === 'base8').deltaSavingPercent);
check('8-car base replay is smaller than the 20 Hz ghost payload',
  sizes.find((row) => row.key === 'base8').bytesPerMinute <
  sizes.find((row) => row.key === 'base8').ghost20HzBytesPerMinute);
check('8-car base replay is far smaller than the 60 Hz ghost payload',
  sizes.find((row) => row.key === 'base8').bytesPerMinute <
  sizes.find((row) => row.key === 'base8').ghost60HzBytesPerMinute);
check('2-car base replay is smaller than raw JSON',
  sizes.find((row) => row.key === 'base2').replayJsonBytes <
  sizes.find((row) => row.key === 'base2').rawJsonBytes);
check('4-car base replay is smaller than raw JSON',
  sizes.find((row) => row.key === 'base4').replayJsonBytes <
  sizes.find((row) => row.key === 'base4').rawJsonBytes);
check('8-car base replay is smaller than raw JSON',
  sizes.find((row) => row.key === 'base8').replayJsonBytes <
  sizes.find((row) => row.key === 'base8').rawJsonBytes);
check('8-car extended replay is smaller than raw JSON',
  sizes.find((row) => row.key === 'ext8').replayJsonBytes <
  sizes.find((row) => row.key === 'ext8').rawJsonBytes);
check('8-car replay beats the ghost format even including all cars',
  sizes.find((row) => row.key === 'base8').bytesPerMinute < 44 * SAMPLE_HZ * 60 * 8);
check('no-RLE replay is still valid', validateReplay(noRle, datasets.base8.expected).ok);
check('no-RLE replay decodes to the same cars',
  JSON.stringify(new ReplayReader(noRle).stateAt(999, { interpolate: false }).cars.map((car) => car.position)) ===
  JSON.stringify(new ReplayReader(recordings.base8.replay).stateAt(999, { interpolate: false }).cars.map((car) => car.position)));

// The host page emits a single-car snapshot (`{tick,position,quaternion,speed}`)
// while the N-slot relay emits `{tick, cars:[...]}`. Both must record.
currentGroup = 'host-shape';
{
  const dataset = makeDataset({ cars: 1, extended: true });
  const recorder = new ReplayRecorder({
    tickHz: SAMPLE_HZ,
    engineTickHz: ENGINE_HZ,
    participants: dataset.participants,
    map: dataset.map,
    hashes: dataset.hashes,
    keepRaw: true
  });
  for (const snapshot of dataset.samples) {
    recorder.capture({ tick: snapshot.tick, ...snapshot.cars[0] });
  }
  recorder.setResult(dataset.result);
  const replay = recorder.build();
  const validated = validateReplay(replay, dataset.expected);
  check('single-car host snapshot records and validates', validated.ok, validated.errors);
  const decoded = new ReplayReader(replay).allSamples(dataset.participants[0].id);
  checkEqual('single-car host snapshot keeps every tick',
    decoded.map((car) => car.tick), dataset.samples.map((snapshot) => snapshot.tick));
  const measured = measureReplayError(dataset.samples, replay);
  checkNear('single-car host snapshot position error', measured.positionAxisMax,
    REPLAY_QUANT.position.maxError + 1e-12);
  check('single-car host snapshot result round-trips',
    JSON.stringify(replay.result) === JSON.stringify(dataset.result));
  check('single-car host snapshot is deterministic',
    recorder.build().hash === replay.hash);
}

// ---------------------------------------------------------------------------
// 9. Report
// ---------------------------------------------------------------------------

const errorBounds = {
  positionAxisMax: Math.max(...Object.values(errorReport).map((entry) => entry.positionAxisMax)),
  positionEuclideanMax: Math.max(...Object.values(errorReport).map((entry) => entry.positionMax)),
  quaternionAngleMax: Math.max(...Object.values(errorReport).map((entry) => entry.quaternionAngleMax)),
  quaternionComponentMax: Math.max(...Object.values(errorReport).map((entry) => entry.quaternionComponentMax)),
  speedMax: Math.max(...Object.values(errorReport).map((entry) => entry.speedMax)),
  velocityMax: Math.max(...Object.values(errorReport).map((entry) => entry.velocityMax)),
  wheelMax: Math.max(...Object.values(errorReport).map((entry) => entry.wheelMax)),
  steerMax: Math.max(...Object.values(errorReport).map((entry) => entry.steerMax)),
  healthMax: Math.max(...Object.values(errorReport).map((entry) => entry.healthMax)),
  shieldMax: Math.max(...Object.values(errorReport).map((entry) => entry.shieldMax))
};

const groups = {};
for (const entry of checks) {
  groups[entry.group] ??= { checks: 0, passed: 0 };
  groups[entry.group].checks++;
  if (entry.ok) groups[entry.group].passed++;
}

const report = {
  kind: 'blur.replay-selftest',
  version: 1,
  format: 'blur.race-replay/1',
  sampleHz: SAMPLE_HZ,
  engineHz: ENGINE_HZ,
  checks: checks.length,
  passed: checks.filter((entry) => entry.ok).length,
  failed: failures,
  ok: failures === 0,
  failures: checks.filter((entry) => !entry.ok),
  groups,
  hashes: Object.fromEntries(Object.entries(recordings).map(([key, entry]) => [key, entry.replay.hash])),
  errorBounds,
  perRecordingErrors: errorReport,
  sizes,
  limits: [
    'Synthetic 60 s race data; no engine, map or car asset is loaded.',
    'Quaternion components are quantised at 1/32767 and renormalised on decode; the angular bound is measured.',
    'Health and shield are held between samples (step), not interpolated.',
    'The replay is a recording, not an authority: it cannot prove a race was legal.'
  ]
};
report.suiteHash = replayHashOf({
  checks: report.checks,
  errorBounds: report.errorBounds,
  sizes: report.sizes,
  hashes: report.hashes
});

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
const reportPath = path.join(OUT_DIR, 'selftest.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

const lines = [
  'replay selftest',
  'checks ' + report.checks + ' passed ' + report.passed + ' failed ' + report.failed,
  'suiteHash ' + report.suiteHash,
  'position axis max ' + report.errorBounds.positionAxisMax.toExponential(3) + ' m',
  'quaternion angle max ' + report.errorBounds.quaternionAngleMax.toExponential(3) + ' rad',
  ...sizes.map((row) => [
    row.key.padEnd(12),
    String(row.cars).padStart(2) + ' cars',
    String(row.bytesPerMinute).padStart(8) + ' B/min',
    'raw ' + String(row.rawJsonBytesPerMinute).padStart(9),
    'ghost20 ' + String(row.ghost20HzBytesPerMinute).padStart(9),
    'ratio raw ' + row.ratioToRaw
  ].join('  '))
];
if (failures) {
  lines.push('FAILURES');
  for (const failure of report.failures) {
    lines.push(JSON.stringify(failure));
  }
}
const logText = lines.join('\n') + '\n';
fs.writeFileSync(path.join(LOG_DIR, 'selftest.log'), logText);
process.stdout.write(logText);
process.exitCode = failures === 0 ? 0 : 1;
