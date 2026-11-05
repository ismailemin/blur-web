// E1 drive slice — browser host.
//
// Pipeline per frame:
//
//   keyboard (or the tick-scripted drive)        <- input
//     -> FixedStepDriver (1/60, 4-tick cap, pause rule)
//     -> wasm e1_set_input / e1_step / e1_get_state     (engine owns the car)
//     -> packet-adapter appendState  -> packet v1.1 updates[] (camera + matrix)
//     -> PacketConsumer.renderFrame(cursor + alpha)     (WebGPU)
//
// The driver is a verbatim copy of the committed fixed-step module, which is a
// line-by-line port of the native scheduler probe; the packet consumer is the
// committed consumer with one added method (`syncTimeline`) because this page
// builds its timeline live instead of loading a finished one.
//
// URL parameters:
//   ?car=<slug>     roster car to drive (default: the roster's recorded default)
//   ?script=drive   tick-scripted input (2 s throttle, 2 s coast, 1 s brake)
//   ?hold=<tick>    stop stepping at that engine tick and hold it (screenshots)
//   ?manual=1       keyboard input even when script=drive is present
//   ?interpolate=0  render the last integer tick (default renders tick-1+alpha)

import { PacketConsumer } from './packet-consumer.js';
import { FixedStepDriver, FLAG } from './fixed-step.js';
import { createSession } from './packet-adapter.js';
import { hashOf } from './packet-hash.js';
import { carIdentity, carLabel, fieldsUrl, loadRoster, resolveCar } from './cars.js';
import { PHASES, SCRIPT_TICKS, TICK_HZ, phaseAt, scriptedInput } from './drive-script.js';

const params = new URLSearchParams(location.search);
const SCRIPTED = params.get('script') === 'drive' && params.get('manual') !== '1';
const HOLD = params.has('hold') ? Number(params.get('hold')) : null;
if (HOLD !== null && (!Number.isInteger(HOLD) || HOLD < 0)) throw new Error('hold must be a non-negative integer tick');
const INTERPOLATE = params.get('interpolate') !== '0';
const REQUESTED_CAR = params.get('car');
// Diagnostic camera override (screenshots only): ?camdist=&camheight= change the
// chase orbit radius/height without touching physics or any other packet field.
const CAMERA_OVERRIDE = {};
if (params.has('camdist')) CAMERA_OVERRIDE.distance = Number(params.get('camdist'));
if (params.has('camheight')) CAMERA_OVERRIDE.height = Number(params.get('camheight'));
if (params.has('camyaw')) CAMERA_OVERRIDE.yawOffset = Number(params.get('camyaw'));
for (const [key, value] of Object.entries(CAMERA_OVERRIDE)) {
  if (!Number.isFinite(value)) throw new Error('bad camera override ' + key + '=' + params.get(key));
  if (key !== 'yawOffset' && value <= 0) throw new Error('bad camera override ' + key + '=' + params.get(key));
}

const ENGINE_MODULE = '/_work/e1-drive/module/e1_drive.mjs';
const GEOMETRY_URL = '/_work/e1-drive/geometry.json';
const LEVEL_URL = '/_work/e1-drive/Level.levelphysics';
const SPAWN_URL = '/_work/e1-drive/spawn.json';

const canvas = document.getElementById('scene');
const driver = new FixedStepDriver();

const state = {
  consumer: 'idle',
  error: null,
  adapter: null,
  mode: SCRIPTED ? 'script:drive' : 'keyboard',
  hold: HOLD,
  holdReached: HOLD === null ? false : HOLD === 0,
  car: null,
  roster: null,
  bodyMesh: null,
  bodyManifest: null,
  engineTick: 0,
  displayTick: 0,
  tick0Hash: null,
  phase: 'settled',
  speed: 0,
  speedKph: 0,
  position: [0, 0, 0],
  contacts: '0000',
  suspension: [0, 0, 0, 0],
  wheelAngular: [0, 0, 0, 0],
  wheelAngles: { frontleft: 0, frontright: 0, backleft: 0, backright: 0 },
  parts: 0,
  carDraws: 0,
  packetNodes: 0,
  wheelNodes: 0,
  trackVisual: null,
  trackDraws: 0,
  trackTriangles: 0,
  collisionVisible: null,
  collisionFallbackTriangles: 0,
  collisionCoveredTriangles: 0,
  input: [0, 0, 0, 0],
  frames: 0,
  ticksExecuted: 0,
  cappedFrames: 0,
  pauseDrops: 0,
  zeroTickFrames: 0,
  geometryUploads: 0,
  geometryUploadBytes: 0,
  uniformWrites: 0,
  uniformBytes: 0,
  drawsIssued: 0,
  matrixChecksum: null,
  tickHash: null,
  movedScreen: null,
  camera: 'chase',
  packetHash: null,
  draws: 0,
  tickHashes: []
};

function publish() {
  document.documentElement.dataset.driveState = state.consumer;
  document.documentElement.dataset.holdReached = String(state.holdReached);
  window.e1DriveProbe = state;
  const rows = [
    ['mode', state.mode + (state.hold === null ? '' : ' · hold ' + state.hold + (state.holdReached ? ' reached' : ''))],
    ['car', state.car ? state.car.name + ' · ' + state.car.drivetrain + ' · ' + Math.round(state.car.mass) + ' kg · rec ' + state.car.recordIndex : '—'],
    ['tick', String(state.displayTick) + ' (engine ' + state.engineTick + ') · ' + state.phase],
    ['speed', state.speed.toFixed(2) + ' m/s · ' + state.speedKph.toFixed(0) + ' km/h'],
    ['position', state.position.map((value) => value.toFixed(2)).join(', ')],
    ['wheels', state.contacts.split('').map((on, index) => 'W' + (index + 1) + (on === '1' ? '●' : '○')).join(' ')],
    ['susp mm', state.suspension.map((value) => (value * 1000).toFixed(1)).join(' ')],
    ['input', 'thr ' + state.input[0].toFixed(2) + ' brk ' + state.input[1].toFixed(2) +
      ' str ' + state.input[2].toFixed(2) + ' hb ' + state.input[3].toFixed(2)],
    ['parts', state.parts + ' parts · ' + state.carDraws + ' draws · ' + state.packetNodes + ' nodes (' + state.wheelNodes + ' wheel)'],
    ['track', state.trackDraws + ' real draws · ' + state.trackTriangles + ' tri · no-draw ' +
      state.collisionFallbackTriangles + ' tri · slab ' +
      (state.collisionVisible === false ? 'hidden' : state.collisionVisible === true ? 'visible' : '—')],
    ['body', state.bodyMesh ?? '—'],
    ['wheel spin', Object.entries(state.wheelAngles).map(([corner, angle]) => corner + ' ' + angle.toFixed(2)).join(' ')],
    ['frames', String(state.frames) + ' · ticks ' + state.ticksExecuted],
    ['uploads', state.geometryUploads + ' geometry · ' + state.uniformWrites + ' uniform'],
    ['draws', state.draws + ' · ' + state.drawsIssued + ' issued'],
    ['packet', state.packetHash ? state.packetHash.slice(7, 23) + '…' : '—'],
    ['tick hash', state.tickHash ? state.tickHash.slice(7, 23) + '…' : '—'],
    ['checksum', state.matrixChecksum ?? '—'],
    ['gpu', state.adapter ?? '—']
  ];
  document.getElementById('hud').textContent = rows.map(([key, value]) => key.padEnd(10) + value).join('\n');
}

function fail(message) {
  state.consumer = 'error';
  state.error = message;
  const box = document.getElementById('error');
  box.hidden = false;
  box.textContent = message;
  publish();
}

const consumer = new PacketConsumer(canvas, (event) => {
  if (event.state === 'error') fail(event.message);
});

window.addEventListener('error', (event) => fail('page error: ' + event.message));
window.addEventListener('unhandledrejection', (event) => fail('unhandled rejection: ' + (event.reason?.message ?? String(event.reason))));

// ------------------------------------------------------------------ input

const keys = new Set();
window.addEventListener('keydown', (event) => {
  if (event.key === 'r' || event.key === 'R') { doReset(Math.round(performance.now() * 1000)); return; }
  keys.add(event.key.toLowerCase());
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(event.key.toLowerCase())) event.preventDefault();
});
window.addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());


function keyboardInput() {
  const throttle = keys.has('w') || keys.has('arrowup') ? 1 : 0;
  const brake = keys.has('s') || keys.has('arrowdown') ? 1 : 0;
  const steer = (keys.has('a') || keys.has('arrowleft') ? -1 : 0) + (keys.has('d') || keys.has('arrowright') ? 1 : 0);
  const handbrake = keys.has(' ') ? 1 : 0;
  return [throttle, brake, steer, handbrake];
}

// ------------------------------------------------------------------ engine

let module = null;
let engine = null;      // { info, readState, setInput, step, reset }
let session = null;
let geometry = null;
let spawn = null;
let car = null;

function readState() {
  return JSON.parse(module.UTF8ToString(module._e1_get_state()));
}

/** Fill the selector from the roster and keep it in sync with ?car=. */
function populateSelector(roster, selected) {
  const select = document.getElementById('car-select');
  if (!select) return;
  select.textContent = '';
  for (const entry of roster.roster.cars) {
    const option = document.createElement('option');
    option.value = entry.slug;
    option.textContent = carLabel(entry);
    option.selected = entry.slug === selected.slug;
    select.append(option);
  }
  select.addEventListener('change', () => {
    const next = new URLSearchParams(location.search);
    if (select.value === roster.roster.default) next.delete('car');
    else next.set('car', select.value);
    next.delete('hold');
    const query = next.toString();
    location.href = location.pathname + (query ? '?' + query : '');
  });
}

async function loadEngine() {
  const factory = (await import(ENGINE_MODULE)).default;
  module = await factory();
  const roster = await loadRoster();
  car = resolveCar(roster, REQUESTED_CAR);
  state.roster = roster;
  state.car = carIdentity(car);
  populateSelector(roster, car);

  const [geometryResponse, levelResponse, fieldsResponse, spawnResponse] = await Promise.all([
    fetch(GEOMETRY_URL, { cache: 'no-store' }),
    fetch(LEVEL_URL, { cache: 'no-store' }),
    fetch(fieldsUrl(car), { cache: 'no-store' }),
    fetch(SPAWN_URL, { cache: 'no-store' })
  ]);
  for (const [label, response] of [['geometry', geometryResponse], ['level', levelResponse],
                                    ['car fields (' + car.slug + ')', fieldsResponse], ['spawn', spawnResponse]]) {
    if (!response.ok) throw new Error(label + ' fetch failed: HTTP ' + response.status);
  }
  geometry = await geometryResponse.json();
  spawn = await spawnResponse.json();
  const level = new Uint8Array(await levelResponse.arrayBuffer());
  const fields = new Uint8Array(await fieldsResponse.arrayBuffer());

  const levelPtr = module._malloc(level.byteLength);
  const fieldsPtr = module._malloc(fields.byteLength + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(level, levelPtr);
  module.HEAPU8.set(fields, fieldsPtr);
  const ok = module._e1_create(levelPtr, level.byteLength, fieldsPtr, fields.byteLength,
                               spawn.x, spawn.z, spawn.heading);
  module._free(levelPtr);
  module._free(fieldsPtr);
  if (!ok) throw new Error('e1_create failed: ' + module.UTF8ToString(module._e1_last_error()));

  engine = {
    info: JSON.parse(module.UTF8ToString(module._e1_info())),
    setInput: (input) => module._e1_set_input(input[0], input[1], input[2], input[3]),
    step: () => {
      if (!module._e1_step()) throw new Error('e1_step failed: ' + module.UTF8ToString(module._e1_last_error()));
      return readState();
    },
    reset: () => {
      if (!module._e1_reset()) throw new Error('e1_reset failed: ' + module.UTF8ToString(module._e1_last_error()));
      return readState();
    }
  };
  state.engineInfo = engine.info;
  state.spawn = spawn;
  if (engine.info.car !== car.name) {
    throw new Error('engine decoded ' + JSON.stringify(engine.info.car) +
      ' but the roster asked for ' + JSON.stringify(car.name));
  }
}

/** Rebuild the world and restart the packet timeline from the settled tick. */
async function startTimeline(tick0, { reload = false } = {}) {
  session = createSession(geometry, tick0, {
    spawn: { ...spawn, source: spawn.source ?? 'probes/e1-drive/tools/spawn.mjs' },
    car: state.car,
    camera: Object.keys(CAMERA_OVERRIDE).length ? CAMERA_OVERRIDE : undefined
  });
  state.cameraOverride = Object.keys(CAMERA_OVERRIDE).length ? { ...CAMERA_OVERRIDE } : null;
  const partsInfo = session.packet.diagnostics.extras.parts;
  state.parts = partsInfo?.partCount ?? 0;
  state.carDraws = partsInfo?.drawCount ?? 0;
  state.packetNodes = session.packet.nodes.length;
  state.wheelNodes = session.packet.diagnostics.extras.wheels.wheelNodes.length;
  const trackInfo = session.packet.diagnostics.extras.track;
  state.trackVisual = trackInfo?.trackVisual ?? null;
  state.trackDraws = trackInfo?.drawCount ?? 0;
  state.trackTriangles = trackInfo?.triangleCount ?? 0;
  state.collisionFallbackTriangles = trackInfo?.coverage?.fallbackTriangles ?? 0;
  state.collisionCoveredTriangles = trackInfo?.coverage?.coveredTriangles ?? 0;
  state.collisionVisible = session.packet.diagnostics.extras.collisionSurface?.visible ?? null;
  state.bodyMesh = session.packet.diagnostics.extras.drive.car?.bodyMesh ?? null;
  state.bodyManifest = partsInfo?.manifest ?? null;
  state.wheelAngles = session.wheelSpin.angle;
  state.wheelAnglesByTick = session.wheelAnglesByTick;
  // Expose the live timeline so the capture tool can compare the exact update the
  // consumer rendered with the node producer's packet (no extra packet copy).
  state.updates = session.packet.updates;
  const update0 = session.appendState(tick0);
  state.tickHashes = [{ tick: 0, stateHash: hashOf(tick0), packetHash: update0.hash }];
  state.tick0Hash = update0.hash;
  state.tick0Update = update0;
  state.tick0State = tick0;
  // One more tick so the v1.1 consumer has a two-tick timeline to load.
  const input = SCRIPTED ? scriptedInput(1) : [0, 0, 0, 0];
  engine.setInput(input);
  const tick1 = engine.step();
  const update1 = session.appendState(tick1);
  state.tickHashes.push({ tick: 1, stateHash: hashOf(tick1), packetHash: update1.hash });
  state.engineTick = tick1.tick;
  session.finalise();
  state.packetHash = session.packet.hash;
  if (reload) await consumer.load(session.packet);
  state.draws = session.packet.draws.length;
  return tick1;
}

function applyState(snapshot) {
  state.engineTick = snapshot.tick;
  state.speed = snapshot.speed;
  state.speedKph = snapshot.speed * 3.6;
  state.position = snapshot.position;
  state.contacts = snapshot.contacts.join('');
  state.suspension = snapshot.wheels.map((wheel) => wheel.suspension);
  state.wheelAngular = snapshot.wheels.map((wheel) => wheel.angular);
  state.input = snapshot.input;
  state.phase = SCRIPTED ? phaseAt(snapshot.tick) : 'keyboard';
}

let holdReached = HOLD === null ? false : HOLD === 0;

async function doReset(nowUs) {
  try {
    const tick0 = engine.reset();
    const tick1 = await startTimeline(tick0, { reload: true });
    applyState(tick1);
    state.engineTick = tick1.tick;
    state.ticksExecuted = 0;
    holdReached = HOLD !== null && HOLD <= tick1.tick ? true : holdReached;
    driver.reset(nowUs);
    publish();
  } catch (error) {
    fail(error.message);
  }
}

const MAX_LIVE_TICKS = 36000; // ~10 minutes of live driving; a spike, not an endurance test

function frame(nowMs) {
  const nowUs = Math.round(nowMs * 1000);

  if (!holdReached && session.packet.updates.length < MAX_LIVE_TICKS) {
    const sample = driver.advanceTo(nowUs);
    if (sample.flags & FLAG.CAPPED) state.cappedFrames++;
    if (sample.flags & FLAG.PAUSED) state.pauseDrops++;
    if (sample.flags & FLAG.ZERO_TICK) state.zeroTickFrames++;
    for (let index = 0; index < sample.ticks; index++) {
      const nextTick = state.engineTick + 1;
      const input = SCRIPTED ? scriptedInput(nextTick) : keyboardInput();
      engine.setInput(input);
      const snapshot = engine.step();
      const update = session.appendState(snapshot);
      state.tickHashes.push({ tick: snapshot.tick, stateHash: hashOf(snapshot), packetHash: update.hash });
      state.ticksExecuted++;
      applyState(snapshot);
      if (HOLD !== null && state.engineTick >= HOLD) {
        holdReached = true;
        state.holdReached = true;
        break;
      }
      if (SCRIPTED && state.engineTick >= SCRIPT_TICKS) {
        holdReached = true;
        state.holdReached = true;
        break;
      }
    }
    if (!sample.ticks) applyState(session.lastState);
  }

  let cursor;
  if (holdReached) {
    // HOLD is the tick the capture asked for. `hold=0` is the settled state: the
    // consumer needs a two-tick timeline to load, so the engine is already one
    // tick ahead there, but the frame shown is still packet tick 0.
    cursor = HOLD !== null ? HOLD : state.engineTick;
  } else if (INTERPOLATE) cursor = Math.max(0, state.engineTick - 1 + driver.currentAlpha());
  else cursor = state.engineTick;
  state.displayTick = Math.floor(cursor);
  const anglesAtDisplay = state.wheelAnglesByTick?.[state.displayTick];
  if (anglesAtDisplay && anglesAtDisplay.tick === state.displayTick) state.wheelAngles = anglesAtDisplay.angles;

  consumer.syncTimeline();
  const rendered = consumer.renderFrame({ cursor });
  if (rendered) {
    state.frames = consumer.stats.renders;
    state.tickHash = rendered.frame.tickHash;
    state.matrixChecksum = consumer.stats.matrixChecksum;
    state.movedScreen = consumer.stats.movedScreen;
    state.geometryUploads = consumer.stats.geometryUploads;
    state.geometryUploadBytes = consumer.stats.geometryUploadBytes;
    state.uniformWrites = consumer.stats.uniformWrites;
    state.uniformBytes = consumer.stats.uniformBytes;
    state.drawsIssued = consumer.stats.drawsIssued;
    if (state.consumer !== 'error') state.consumer = 'running';
    publish();
  }
  requestAnimationFrame(frame);
}

async function main() {
  state.consumer = 'loading';
  publish();
  await loadEngine();
  state.adapter = consumer.adapterInfo
    ? [consumer.adapterInfo.vendor, consumer.adapterInfo.architecture, consumer.adapterInfo.device].filter(Boolean).join(' / ') || 'unnamed adapter'
    : 'unnamed adapter';
  state.draws = session ? session.packet.draws.length : 0;

  const tick1 = await startTimeline(await readState(), { reload: true });
  applyState(tick1);
  state.adapter = consumer.adapterInfo
    ? [consumer.adapterInfo.vendor, consumer.adapterInfo.architecture, consumer.adapterInfo.device].filter(Boolean).join(' / ') || 'unnamed adapter'
    : 'unnamed adapter';

  const canvasAspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  if (Math.abs(canvasAspect - session.packet.camera.aspect) > 0.01) {
    throw new Error('canvas aspect ' + canvasAspect.toFixed(4) + ' does not match the packet camera aspect ' +
                    session.packet.camera.aspect.toFixed(4));
  }
  if (HOLD !== null && HOLD > SCRIPT_TICKS && SCRIPTED) {
    throw new Error('hold tick ' + HOLD + ' is beyond the scripted sequence (' + SCRIPT_TICKS + ')');
  }

  state.consumer = 'running';
  publish();
  if (consumer.device) await consumer.device.queue.onSubmittedWorkDone();
  requestAnimationFrame(frame);
}

main().catch((error) => fail(error.message));
