// E1 drive slice — browser host.
//
// Pipeline per frame:
//
//   keyboard / scripted input / sprint driver          <- input
//     -> FixedStepDriver (1/60, 4-tick cap, pause rule)
//     -> wasm e1_set_input / e1_step / e1_get_state      (engine owns the car)
//     -> sprint rules (countdown, gates, timer, respawn) (rules observe only)
//     -> packet-adapter appendState -> packet v1.1 updates[] (camera + matrix)
//     -> PacketConsumer.renderFrame(cursor + alpha)       (WebGPU)
//
// The driver is a verbatim copy of the committed fixed-step module, which is a
// line-by-line port of the native scheduler probe; the packet consumer is the
// committed consumer with one added method (`syncTimeline`) because this page
// builds its timeline live instead of loading a finished one.
//
// Modes:
//   /                   keyboard sprint: 3-2-1 countdown, timer, 2 checkpoints,
//                       finish, results + best time, R restart, respawn
//   ?script=sprint      the same sprint with the deterministic scripted driver
//                       (throttle while running, brake after the finish)
//   ?script=sprint&sprintfall=1
//                       diagnostic driver that leaves the gate corridor to
//                       exercise the respawn path on the real engine
//   ?script=drive       the original 300-tick drive (2 s throttle, 2 s coast,
//                       1 s brake) with no race rules, kept for the P23/P31/P36
//                       evidence and for `?hold=` captures
//   ?telemetry=1        three deterministic telemetry manoeuvres (standing start,
//                       80 km/h brake, steering sweep), metric table + 60 Hz
//                       traces in a panel; diagnostics only, physics unchanged
//
// URL parameters:
//   ?car=<slug>     roster car to drive (default: the roster's recorded default)
//   ?hold=<tick>    stop stepping at that engine tick and hold it (screenshots)
//   ?manual=1       keyboard input even when script=drive is present
//   ?interpolate=0  render the last integer tick (default renders tick-1+alpha)

import { PacketConsumer } from './packet-consumer.js';
import { FixedStepDriver, FLAG } from './fixed-step.js';
import { createSession } from './packet-adapter.js';
import { hashOf } from './packet-hash.js';
import { carIdentity, carLabel, fieldsUrl, loadRoster, resolveCar } from './cars.js';
import { PHASES, SCRIPT_TICKS, TICK_HZ, phaseAt, scriptedInput } from './drive-script.js';
import { validateSprintLayout } from './sprint-layout.js';
import { SPRINT_EVENT, createSprintRules } from './sprint-rules.js';
import { createBestTimes } from './sprint-best.js';
import { respawnScriptInput, sprintScriptInput, SPRINT_PACKET_SCRIPT } from './sprint-script.js';
import {
  createWasmResetEngineSet, runTelemetrySeries, summariseTelemetryMetrics,
  TELEMETRY_MANOEUVRE_ORDER, TELEMETRY_PACKET_SCRIPT, TELEMETRY_SPEC
} from './telemetry.js';
const params = new URLSearchParams(location.search);
const SCRIPT_PARAM = params.get('script');
const TELEMETRY = params.get('telemetry') === '1';
if (TELEMETRY) document.documentElement.dataset.telemetry = 'running';
if (SCRIPT_PARAM && SCRIPT_PARAM !== 'drive' && SCRIPT_PARAM !== 'sprint') {
  throw new Error('unknown script ' + JSON.stringify(SCRIPT_PARAM) + ' (use drive or sprint)');
}
if (TELEMETRY && SCRIPT_PARAM) {
  throw new Error('?telemetry=1 is its own mode; drop the script parameter');
}
if (TELEMETRY && params.has('hold')) {
  throw new Error('?telemetry=1 holds its own presentation tick; drop the hold parameter');
}
const LEGACY_DRIVE = !TELEMETRY && SCRIPT_PARAM === 'drive' && params.get('manual') !== '1';
const SCRIPTED_SPRINT = !TELEMETRY && SCRIPT_PARAM === 'sprint';
const SPRINT_MODE = !TELEMETRY && !LEGACY_DRIVE;
const SPRINT_FALL = params.get('sprintfall') === '1';
if (SPRINT_FALL && !SCRIPTED_SPRINT) throw new Error('?sprintfall=1 needs ?script=sprint');
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
const SPRINT_URL = '/_work/e1-drive/sprint.json';

const canvas = document.getElementById('scene');
const driver = new FixedStepDriver();

const state = {
  consumer: 'idle',
  error: null,
  adapter: null,
  mode: LEGACY_DRIVE ? 'script:drive' : SCRIPTED_SPRINT ? (SPRINT_FALL ? 'script:sprint-fall' : 'script:sprint')
    : TELEMETRY ? 'telemetry' : 'keyboard-sprint',
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
  cameraDistance: null,
  cameraOcclusion: null,
  packetHash: null,
  draws: 0,
  tickHashes: [],
  // Sprint (null in the legacy drive mode).
  sprint: null,
  sprintLayout: null,
  sprintLayoutHash: null,
  sprintEvents: [],
  sprintBest: null,
  sprintResult: null,
  sprintBanner: null,
  respawning: false,
  // Number of in-place world rebuilds (R / sprint restart). Never a page reload.
  restarts: 0,
  // Telemetry (`?telemetry=1` only).
  telemetry: null,
  telemetryBusy: false
};

function publish() {
  document.documentElement.dataset.driveState = state.consumer;
  document.documentElement.dataset.holdReached = String(state.holdReached);
  if (state.sprint) document.documentElement.dataset.sprint = state.sprint.phase;
  if (state.telemetry) document.documentElement.dataset.telemetry = state.telemetry.ready ? 'ready' : 'running';
  window.e1DriveProbe = state;
  const rows = [
    ['mode', state.mode + (state.hold === null ? '' : ' · hold ' + state.hold + (state.holdReached ? ' reached' : ''))],
    ['car', state.car ? state.car.name + ' · ' + state.car.drivetrain + ' · ' + Math.round(state.car.mass) + ' kg · rec ' + state.car.recordIndex : '—']
  ];
  if (state.telemetry?.ready) {
    const metrics = state.telemetry.metrics;
    const seconds = (value) => (Number.isFinite(value) ? value.toFixed(3) : '—');
    rows.push(['telemetry', '3 manoeuvres · ' + state.telemetry.sampleHz + ' Hz · presented at accel tick ' +
      state.telemetry.presentation.tick + ' (0–100 km/h)']);
    rows.push(['0–100', seconds(metrics.accel.zeroToSpeedKph['100'].seconds) + ' s · ' +
      metrics.accel.topSpeedKph.toFixed(1) + ' km/h at 86 m']);
    rows.push(['brake', metrics.brake.distanceMetres.toFixed(2) + ' m from ' +
      metrics.brake.entrySpeedKph.toFixed(1) + ' km/h · ' + metrics.brake.peakDecelG.toFixed(2) + ' g peak']);
    rows.push(['lateral', metrics.lateral.peakLateralAbsG.toFixed(2) + ' g · yaw ' +
      metrics.lateral.peakYawRateAbsDegPerSec.toFixed(1) + ' °/s · ' +
      metrics.lateral.yawResponseTicks.toFixed(1) + ' tick response']);
    rows.push(['inputs', 'tick-only step scripts · plan brake tick ' + state.telemetry.plan.brakeTick]);
  }
  if (state.sprint) {
    const sprint = state.sprint;
    const timer = sprint.finished ? sprint.finishTimeSeconds : sprint.elapsedSeconds;
    rows.push(['sprint', sprint.phase + ' · ' + Number(timer).toFixed(3) + ' s' +
      (sprint.finished ? ' · FINISHED' : '') + (sprint.respawns ? ' · ' + sprint.respawns + ' respawn' : '')]);
    rows.push(['gates', sprint.checkpointsPassed + '/' + sprint.totalCheckpoints + ' cp · ' +
      (sprint.nextGate
        ? 'next ' + sprint.nextGate.id + ' in ' + Math.max(0, sprint.nextGate.distanceMetres).toFixed(1) + ' m'
        : 'finish crossed') +
      ' · ' + Math.round(sprint.progress * 100) + '%']);
    rows.push(['best', state.sprintBest === null ? '—' :
      state.sprintBest.toFixed(3) + ' s' + (state.sprintResult?.improved ? ' (new)' : '')]);
  }
  rows.push(
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
    ['camera', state.cameraDistance === null ? '—' :
      state.cameraDistance.toFixed(2) + ' m / ' + (state.cameraOcclusion?.requestedDistance ?? 0).toFixed(2) +
      (state.cameraOcclusion?.blocked ? ' · pulled from ' + state.cameraOcclusion.hitDistance.toFixed(2) + ' m hit' : ' · clear')],
    ['wheel spin', Object.entries(state.wheelAngles).map(([corner, angle]) => corner + ' ' + angle.toFixed(2)).join(' ')],
    ['frames', String(state.frames) + ' · ticks ' + state.ticksExecuted],
    ['uploads', state.geometryUploads + ' geometry · ' + state.uniformWrites + ' uniform'],
    ['draws', state.draws + ' · ' + state.drawsIssued + ' issued'],
    ['packet', state.packetHash ? state.packetHash.slice(7, 23) + '…' : '—'],
    ['tick hash', state.tickHash ? state.tickHash.slice(7, 23) + '…' : '—'],
    ['checksum', state.matrixChecksum ?? '—'],
    ['gpu', state.adapter ?? '—']
  );
  document.getElementById('hud').textContent = rows.map(([key, value]) => key.padEnd(10) + value).join('\n');
  publishSprintOverlays();
}

/** Countdown, event banner and results panel, all driven by rules state. */
function publishSprintOverlays() {
  const countdown = document.getElementById('countdown');
  const banner = document.getElementById('event');
  const results = document.getElementById('results');
  if (!state.sprint) {
    countdown.hidden = true;
    banner.dataset.visible = '0';
    results.hidden = true;
    return;
  }
  const sprint = state.sprint;
  const countdownLabel = sprint.phase === 'countdown'
    ? sprint.countdownLabel
    : (sprint.phase === 'running' && sprint.elapsedTicks <= 30 ? 'GO' : null);
  countdown.textContent = countdownLabel ?? '';
  countdown.hidden = countdownLabel === null;

  const bannerVisible = state.sprintBanner && state.engineTick <= state.sprintBanner.untilTick;
  if (bannerVisible) {
    banner.textContent = state.sprintBanner.text;
    banner.dataset.kind = state.sprintBanner.kind;
    banner.dataset.visible = '1';
  } else {
    banner.dataset.visible = '0';
  }

  if (sprint.finished && state.sprintResult) {
    results.hidden = false;
    document.getElementById('results-time').textContent =
      state.sprintResult.timeSeconds.toFixed(3) + ' s  ·  ' + state.sprintResult.car;
    const best = state.sprintResult.bestSeconds;
    document.getElementById('results-best').textContent =
      'checkpoints ' + state.sprintResult.checkpoints + '/' + sprint.totalCheckpoints +
      ' · respawns ' + state.sprintResult.respawns +
      ' · best ' + (best === null ? '—' : best.toFixed(3) + ' s') +
      (state.sprintResult.improved ? ' (new best)' : '');
  } else {
    results.hidden = true;
  }
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
  if (event.key === 'r' || event.key === 'R') {
    // Both modes rebuild the world in place: the scene's scheduler groups are
    // created and destroyed with the scene, so one wasm instance can be rebuilt
    // any number of times (docs/work/verification/T-007-reset-fix.md).
    if (TELEMETRY) {
      if (!state.telemetryBusy) {
        state.telemetryBusy = true;
        runTelemetryMode()
          .then(() => { state.restarts += 1; publish(); })
          .catch((error) => fail(error.message))
          .finally(() => { state.telemetryBusy = false; });
      }
      return;
    }
    doReset(Math.round(performance.now() * 1000));
    return;
  }
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
let engineFactory = null;
let engine = null;      // { info, readState, setInput, step, reset }
let session = null;
let geometry = null;
let spawn = null;
let car = null;
let levelBytes = null;
let fieldBytes = null;
let sprintRules = null;
let bestTimes = null;
let pendingRespawn = null;
// Cumulative in-place rebuilds of this page's single wasm instance in telemetry
// mode (one e1_create in loadEngine, then one e1_reset per manoeuvre and per R).
let telemetryResets = 0;

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

/** One world at an arbitrary spawn point: the same call `e1_create` the page loads with. */
function createWorld(x, z, heading) {
  const levelPtr = module._malloc(levelBytes.byteLength);
  const fieldsPtr = module._malloc(fieldBytes.byteLength + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const ok = module._e1_create(levelPtr, levelBytes.byteLength, fieldsPtr, fieldBytes.byteLength, x, z, heading);
  module._free(levelPtr);
  module._free(fieldsPtr);
  if (!ok) throw new Error('e1_create failed at ' + x + ',' + z + ': ' + module.UTF8ToString(module._e1_last_error()));
  return readState();
}

async function loadEngine() {
  const factory = (await import(ENGINE_MODULE)).default;
  engineFactory = factory;
  module = await factory();
  const roster = await loadRoster();
  car = resolveCar(roster, REQUESTED_CAR);
  state.roster = roster;
  state.car = carIdentity(car);
  populateSelector(roster, car);

  const [geometryResponse, levelResponse, fieldsResponse, spawnResponse, sprintResponse] = await Promise.all([
    fetch(GEOMETRY_URL, { cache: 'no-store' }),
    fetch(LEVEL_URL, { cache: 'no-store' }),
    fetch(fieldsUrl(car), { cache: 'no-store' }),
    fetch(SPAWN_URL, { cache: 'no-store' }),
    SPRINT_MODE ? fetch(SPRINT_URL, { cache: 'no-store' }) : Promise.resolve(null)
  ]);
  for (const [label, response] of [['geometry', geometryResponse], ['level', levelResponse],
                                    ['car fields (' + car.slug + ')', fieldsResponse], ['spawn', spawnResponse]]) {
    if (!response.ok) throw new Error(label + ' fetch failed: HTTP ' + response.status);
  }
  geometry = await geometryResponse.json();
  spawn = await spawnResponse.json();
  levelBytes = new Uint8Array(await levelResponse.arrayBuffer());
  fieldBytes = new Uint8Array(await fieldsResponse.arrayBuffer());

  const tick0 = createWorld(spawn.x, spawn.z, spawn.heading);

  if (SPRINT_MODE) {
    if (!sprintResponse.ok) {
      throw new Error('sprint layout fetch failed: HTTP ' + sprintResponse.status +
        ' — run `node probes/e1-drive/tools/build_sprint.mjs` (or `node tools/verify_e1_drive.mjs` first)');
    }
    const layout = await sprintResponse.json();
    const checked = validateSprintLayout(layout, geometry, spawn);
    if (!checked.ok) throw new Error('sprint layout rejected: ' + checked.errors.join('; '));
    sprintRules = createSprintRules(layout);
    state.sprintLayoutHash = layout.hash;
    state.sprintLayout = {
      hash: layout.hash,
      gates: layout.gates.map((gate) => ({ id: gate.id, kind: gate.kind, index: gate.index, x: gate.x, z: gate.z })),
      span: layout.course.span,
      band: layout.course.band,
      countdownTicks: layout.countdown.ticks,
      rules: layout.rules
    };
    let storage = null;
    try { storage = window.localStorage; } catch { storage = null; }
    bestTimes = createBestTimes(storage);
    state.sprintBest = bestTimes.bestFor(car.slug);
  }

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
  return tick0;
}

/** The input the current mode and rules allow for the step that reaches `tick`. */
function currentInput(tick) {
  if (LEGACY_DRIVE) return scriptedInput(tick);
  if (SPRINT_FALL) {
    return sprintRules.respawns > 0 ? sprintRules.gateInput([1, 0, 0, 0]) : respawnScriptInput(tick);
  }
  if (SCRIPTED_SPRINT) return sprintScriptInput(sprintRules);
  return sprintRules.gateInput(keyboardInput());
}

/** Record sprint events and persist a finish. Rules only; never touches physics. */
function handleSprintEvents(events) {
  for (const event of events) {
    state.sprintEvents.push(event);
    if (state.sprintEvents.length > 64) state.sprintEvents.shift();
    state.sprintBanner = {
      kind: event.type === SPRINT_EVENT.RESPAWN ? 'respawn' : event.type === SPRINT_EVENT.CHECKPOINT ? 'checkpoint' : 'other',
      text: event.type === SPRINT_EVENT.CHECKPOINT
        ? 'checkpoint ' + event.index + '/' + sprintRules.totalCheckpoints + ' · ' + event.timeSeconds.toFixed(3) + ' s'
        : event.type === SPRINT_EVENT.RESPAWN
          ? 'respawn · ' + event.reasons.join(', ') + ' · ' + event.timeSeconds.toFixed(3) + ' s'
          : event.type.toUpperCase(),
      untilTick: event.tick + 90
    };
    if (event.type === SPRINT_EVENT.FINISH) {
      const submitted = bestTimes.submit(car.slug, {
        seconds: event.timeSeconds,
        car: car.name,
        checkpoints: event.checkpoints,
        respawns: sprintRules.respawns
      });
      state.sprintBest = submitted.best;
      state.sprintResult = {
        visible: true,
        timeSeconds: event.timeSeconds,
        position: event.position,
        checkpoints: event.checkpoints,
        respawns: sprintRules.respawns,
        car: car.name,
        slug: car.slug,
        bestSeconds: submitted.best,
        previousBestSeconds: submitted.previous,
        improved: submitted.improved,
        persistent: submitted.persistent
      };
    }
  }
}

/** Rebuild the world at a checkpoint and continue the same attempt. */
async function respawnAt(target, nowUs) {
  state.respawning = true;
  publish();
  try {
    const tick0 = createWorld(target.x, target.z, target.heading);
    const tick1 = await startTimeline(tick0, { reload: true, rejoin: true });
    applyState(tick1);
    holdReached = HOLD !== null && HOLD <= tick1.tick ? true : holdReached;
    state.ticksExecuted = 0;
    driver.reset(nowUs);
    publish();
  } catch (error) {
    state.respawning = false;
    fail(error.message);
    return;
  }
  state.respawning = false;
  requestAnimationFrame(frame);
}

/** Rebuild the world and restart the packet timeline from the settled tick. */
async function startTimeline(tick0, { reload = false, rejoin = false } = {}) {
  session = createSession(geometry, tick0, {
    spawn: { ...spawn, source: spawn.source ?? 'probes/e1-drive/tools/spawn.mjs' },
    car: state.car,
    script: SPRINT_MODE ? SPRINT_PACKET_SCRIPT : undefined,
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
  if (sprintRules) {
    if (rejoin) sprintRules.rejoin(tick0);
    else sprintRules.prime(tick0);
  }
  // One more tick so the v1.1 consumer has a two-tick timeline to load.
  engine.setInput(currentInput(1));
  const tick1 = engine.step();
  const update1 = session.appendState(tick1);
  state.tickHashes.push({ tick: 1, stateHash: hashOf(tick1), packetHash: update1.hash });
  state.engineTick = tick1.tick;
  if (sprintRules) handleSprintEvents(sprintRules.step(tick1));
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
  state.phase = TELEMETRY ? 'telemetry' : LEGACY_DRIVE ? phaseAt(snapshot.tick) : (sprintRules ? sprintRules.phase : 'keyboard');
  if (sprintRules) state.sprint = sprintRules.snapshot(snapshot);
}

let holdReached = HOLD === null ? false : HOLD === 0;

// ------------------------------------------------------------------ telemetry
// `?telemetry=1`: three deterministic manoeuvres, each in its own fresh wasm
// instance, measured from the engine state. The accel run becomes the rendered
// timeline (presented at the 0-100 km/h tick, on the drawn road); the metric
// table and the 60 Hz traces are the validation report.

/** Small labelled line chart; one polyline over the manoeuvre's own sample axis. */
function telemetryChart(rows, key, options = {}) {
  const width = 450;
  const height = 62;
  const padLeft = 40;
  const padRight = 6;
  const padTop = 8;
  const padBottom = 12;
  const values = rows.map((row) => row[key]);
  let lo = options.min !== undefined ? options.min : Math.min(...values);
  let hi = options.max !== undefined ? options.max : Math.max(...values);
  if (!(hi > lo)) hi = lo + 1;
  const span = hi - lo;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const xAt = (index) => padLeft + plotW * (index / Math.max(1, rows.length - 1));
  const yAt = (value) => padTop + plotH * (1 - (value - lo) / span);
  const points = rows.map((row, index) =>
    xAt(index).toFixed(1) + ',' + yAt(row[key]).toFixed(1)).join(' ');
  const duration = rows.length > 1 ? rows[rows.length - 1].timeSeconds : 0;
  const digits = options.digits ?? 1;
  return '<svg width="' + width + '" height="' + height + '" role="img" aria-label="' +
    (options.label ?? key) + '">' +
    '<rect x="' + padLeft + '" y="' + padTop + '" width="' + plotW + '" height="' + plotH +
      '" fill="none" stroke="rgba(111,195,232,0.22)"/>' +
    '<polyline fill="none" stroke="' + (options.colour ?? '#6fc3e8') + '" stroke-width="1.4" points="' +
      points + '"/>' +
    '<text x="2" y="' + (padTop + 8) + '" fill="#7d95a8" font-size="9">' + hi.toFixed(digits) + '</text>' +
    '<text x="2" y="' + (padTop + plotH) + '" fill="#7d95a8" font-size="9">' + lo.toFixed(digits) + '</text>' +
    '<text x="' + padLeft + '" y="' + (height - 2) + '" fill="#7d95a8" font-size="9">0 s</text>' +
    '<text x="' + (width - padRight) + '" y="' + (height - 2) +
      '" fill="#7d95a8" font-size="9" text-anchor="end">' + duration.toFixed(2) + ' s · ' +
      rows.length + ' samples</text>' +
    '</svg>';
}

/** Fill the telemetry panel from the measured metrics and traces. */
function renderTelemetryPanel() {
  const panel = document.getElementById('telemetry');
  if (!panel || !state.telemetry?.ready) return;
  const telemetry = state.telemetry;
  const metrics = telemetry.metrics;
  const accel = metrics.accel;
  const brake = metrics.brake;
  const lateral = metrics.lateral;
  const zero = accel.zeroToSpeedKph;
  const number = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—');
  const row = (key, value) => '<tr><td class="t-key">' + key + '</td><td class="t-value">' + value + '</td></tr>';
  panel.innerHTML =
    '<div class="t-head">telemetry · ' + state.car.name + ' · ' + state.car.drivetrain + ' · ' +
      Math.round(state.car.mass) + ' kg</div>' +
    '<div class="t-sub">' + telemetry.sampleHz + ' Hz · one sample per engine tick · measured from ' +
      'e1_get_state · input is a tick-only script · diagnostic, not retail fidelity</div>' +
    '<table>' +
    row('accel 86 m', '<span class="t-metric">0–50 ' + number(zero['50'].seconds, 3) + ' s</span> · ' +
      '0–80 ' + number(zero['80'].seconds, 3) + ' s · ' +
      '<span class="t-metric">0–100 ' + number(zero['100'].seconds, 3) + ' s</span>') +
    row('speed at 86 m', number(accel.endSpeedKph, 1) + ' km/h · ' + accel.nanTicks + ' NaN · ' +
      telemetry.instances + ' wasm instance · ' + telemetry.builds + ' world builds (' +
      telemetry.resets + ' e1_reset)') +
    row('brake from 80', 'entry ' + number(brake.entrySpeedKph, 2) + ' km/h → ' +
      number(brake.distanceMetres, 2) + ' m in ' + number(brake.brakingTimeSeconds, 3) + ' s') +
    row('deceleration', 'peak ' + number(brake.peakDecelMps2, 2) + ' m/s² (' + number(brake.peakDecelG, 2) +
      ' g) · mean ' + number(brake.meanDecelMps2, 2) + ' m/s²') +
    row('lateral sweep', 'peak ' + number(lateral.peakLateralAbsG, 2) + ' g at tick ' + lateral.peakLateralTick +
      ' · yaw ' + number(lateral.peakYawRateAbsDegPerSec, 1) + ' °/s') +
    row('yaw response', number(lateral.yawResponseTicks, 1) + ' ticks · ' + lateral.yawSignChanges + '/' +
      lateral.steerReversals + ' reversals · entry ' + number(lateral.entrySpeedKph, 1) + ' km/h') +
    row('contact a·b·l', accel.contactTicks + '/' + accel.ticks + ' · ' + brake.contactTicks + '/' +
      brake.ticks + ' · ' + lateral.contactTicks + '/' + lateral.ticks) +
    '</table>' +
    '<div class="t-chart"><div class="t-label">accel · speed km/h (0 → ' + number(accel.distanceMetres, 1) +
      ' m)</div>' + telemetryChart(telemetry.traces.accel, 'speedKph', { label: 'accel speed km/h', digits: 0 }) + '</div>' +
    '<div class="t-chart"><div class="t-label">brake · speed km/h (brake step at tick ' + brake.brakeTick +
      ')</div>' + telemetryChart(telemetry.traces.brake, 'speedKph', { label: 'brake speed km/h', digits: 0, colour: '#e8c46f' }) +
      '</div>' +
    '<div class="t-chart"><div class="t-label">lateral · g (square steer ±' + lateral.sweepAmplitude + ' every ' +
      lateral.sweepHalfPeriodTicks + ' ticks)</div>' +
      telemetryChart(telemetry.traces.lateral, 'lateralG', { label: 'lateral g', digits: 2, colour: '#8fe3b0' }) + '</div>' +
    '<div class="t-foot">plan derived from the accel run: brake tick ' + telemetry.plan.brakeTick +
      ' is the first measured 80 km/h tick · 5 cars · see docs/work/verification/T-007-telemetry.md</div>';
  panel.hidden = false;
}

/** Run the series and build the presented timeline from the accel run. */
async function runTelemetryMode() {
  // One wasm module instance, rebuilt with e1_reset between manoeuvres (and
  // again on every R). The page's own module is reused, so R never reloads.
  const engineSet = await createWasmResetEngineSet({
    factory: engineFactory,
    module,
    levelBytes,
    fieldBytes,
    spawn: { x: spawn.x, z: spawn.z, heading: spawn.heading },
    label: car.slug,
    prebuilt: true
  });
  const started = performance.now();
  const series = runTelemetrySeries(engineSet);
  const seriesMs = Math.round(performance.now() - started);
  telemetryResets += engineSet.resets;
  const metrics = series.metrics;
  const hashes = {};
  for (const manoeuvre of TELEMETRY_MANOEUVRE_ORDER) {
    const perTick = series.states[manoeuvre].map((state) => hashOf(state));
    hashes[manoeuvre] = { ticks: perTick.length, traceHash: hashOf(perTick) };
  }

  const accelStates = series.states.accel;
  const presentTick = metrics.accel.zeroToSpeedKph['100'].tick ?? accelStates.length - 1;
  const tick0 = accelStates[0];
  session = createSession(geometry, tick0, {
    spawn: { ...spawn, source: spawn.source ?? 'probes/e1-drive/tools/spawn.mjs' },
    car: state.car,
    script: TELEMETRY_PACKET_SCRIPT,
    camera: Object.keys(CAMERA_OVERRIDE).length ? CAMERA_OVERRIDE : undefined
  });
  const tickHashes = [];
  for (let index = 0; index < accelStates.length; index++) {
    const update = session.appendState(accelStates[index]);
    tickHashes.push({
      tick: accelStates[index].tick,
      stateHash: hashOf(accelStates[index]),
      packetHash: update?.hash ?? null
    });
  }
  session.finalise();

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
  state.updates = session.packet.updates;
  state.wheelAnglesByTick = session.wheelAnglesByTick;
  state.wheelAngles = session.wheelAnglesByTick?.[presentTick]?.angles ?? session.wheelSpin.angle;
  state.tickHashes = tickHashes;
  state.tick0Hash = tickHashes[0]?.packetHash ?? null;
  state.tick0State = tick0;
  state.tick0Update = session.packet.updates[0] ?? null;
  state.packetHash = session.packet.hash;
  state.tickHash = session.packet.updates[presentTick]?.hash ?? null;
  state.draws = session.packet.draws.length;
  state.telemetry = {
    ready: true,
    car: state.car,
    sampleHz: TELEMETRY_SPEC.tickHz,
    spec: TELEMETRY_SPEC,
    plan: series.plan,
    metrics: summariseTelemetryMetrics(metrics),
    traces: {
      accel: metrics.accel.trace,
      brake: metrics.brake.trace,
      lateral: metrics.lateral.trace
    },
    inputModel: 'accel: throttle on every tick; brake: a step at the tick the accel run first measured ' +
      '80 km/h; lateral: throttle then a square steering sweep derived from the tick',
    hashes,
    seriesMs,
    instances: 1,
    resets: telemetryResets,
    builds: telemetryResets + 1,
    heapBytes: engineSet.heapBytes,
    rebuildModel: 'one wasm module instance: e1_create once, e1_reset() before every manoeuvre and on R ' +
      '(docs/work/verification/T-007-reset-fix.md)',
    presentation: { manoeuvre: 'accel', tick: presentTick, reason: '0–100 km/h crossing, on the drawn road' },
    packetHash: session.packet.hash,
    ticks: Object.fromEntries(TELEMETRY_MANOEUVRE_ORDER.map((manoeuvre) =>
      [manoeuvre, series.states[manoeuvre].length]))
  };
  await consumer.load(session.packet);
  state.engineTick = presentTick;
  state.displayTick = presentTick;
  state.holdReached = true;
  holdReached = true;
  applyState(accelStates[presentTick]);
  renderTelemetryPanel();
  publish();
}

async function doReset(nowUs) {
  if (pendingRespawn) return;
  try {
    if (sprintRules) {
      sprintRules.reset();
      state.sprintResult = null;
      state.sprintBanner = null;
      state.sprintEvents.length = 0;
    }
    const tick0 = engine.reset();
    const tick1 = await startTimeline(tick0, { reload: true });
    applyState(tick1);
    state.engineTick = tick1.tick;
    state.ticksExecuted = 0;
    state.restarts += 1;
    holdReached = HOLD !== null && HOLD <= tick1.tick ? true : holdReached;
    driver.reset(nowUs);
    publish();
  } catch (error) {
    fail(error.message);
  }
}

const MAX_LIVE_TICKS = 36000; // ~10 minutes of live driving; a spike, not an endurance test
/** After the finish the rules brake; stop stepping once the car has settled. */
const FINISH_TAIL_TICKS = 120;

function frame(nowMs) {
  const nowUs = Math.round(nowMs * 1000);

  if (!state.respawning && !holdReached && session.packet.updates.length < MAX_LIVE_TICKS) {
    const sample = driver.advanceTo(nowUs);
    if (sample.flags & FLAG.CAPPED) state.cappedFrames++;
    if (sample.flags & FLAG.PAUSED) state.pauseDrops++;
    if (sample.flags & FLAG.ZERO_TICK) state.zeroTickFrames++;
    for (let index = 0; index < sample.ticks; index++) {
      const nextTick = state.engineTick + 1;
      engine.setInput(currentInput(nextTick));
      const snapshot = engine.step();
      const update = session.appendState(snapshot);
      state.tickHashes.push({ tick: snapshot.tick, stateHash: hashOf(snapshot), packetHash: update.hash });
      state.ticksExecuted++;
      if (sprintRules) {
        const events = sprintRules.step(snapshot);
        handleSprintEvents(events);
      }
      applyState(snapshot);
      if (sprintRules) {
        if (sprintRules.awaitingRejoin) {
          pendingRespawn = sprintRules.respawnTarget();
          break;
        }
        if (sprintRules.phase === 'finished' && snapshot.tick - sprintRules.finishTick >= FINISH_TAIL_TICKS) {
          holdReached = true;
          state.holdReached = true;
          break;
        }
      }
      if (HOLD !== null && state.engineTick >= HOLD) {
        holdReached = true;
        state.holdReached = true;
        break;
      }
      if (LEGACY_DRIVE && state.engineTick >= SCRIPT_TICKS) {
        holdReached = true;
        state.holdReached = true;
        break;
      }
    }
    if (!sample.ticks) applyState(session.lastState);
  }

  if (pendingRespawn) {
    const target = pendingRespawn;
    pendingRespawn = null;
    void respawnAt(target, nowUs);
    return;
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
  const cameraAtDisplay = state.updates?.[state.displayTick]?.camera;
  if (cameraAtDisplay) {
    state.cameraDistance = cameraAtDisplay.orbit.distance;
    state.cameraOcclusion = cameraAtDisplay.occlusion ?? null;
  }

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
  const tick0 = await loadEngine();

  if (TELEMETRY) {
    await runTelemetryMode();
    state.adapter = consumer.adapterInfo
      ? [consumer.adapterInfo.vendor, consumer.adapterInfo.architecture, consumer.adapterInfo.device].filter(Boolean).join(' / ') || 'unnamed adapter'
      : 'unnamed adapter';
    const telemetryAspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    if (Math.abs(telemetryAspect - session.packet.camera.aspect) > 0.01) {
      throw new Error('canvas aspect ' + telemetryAspect.toFixed(4) + ' does not match the packet camera aspect ' +
                      session.packet.camera.aspect.toFixed(4));
    }
    state.consumer = 'running';
    publish();
    if (consumer.device) await consumer.device.queue.onSubmittedWorkDone();
    requestAnimationFrame(frame);
    return;
  }

  state.adapter = consumer.adapterInfo
    ? [consumer.adapterInfo.vendor, consumer.adapterInfo.architecture, consumer.adapterInfo.device].filter(Boolean).join(' / ') || 'unnamed adapter'
    : 'unnamed adapter';
  state.draws = session ? session.packet.draws.length : 0;

  const tick1 = await startTimeline(tick0, { reload: true });
  applyState(tick1);
  state.adapter = consumer.adapterInfo
    ? [consumer.adapterInfo.vendor, consumer.adapterInfo.architecture, consumer.adapterInfo.device].filter(Boolean).join(' / ') || 'unnamed adapter'
    : 'unnamed adapter';

  const canvasAspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  if (Math.abs(canvasAspect - session.packet.camera.aspect) > 0.01) {
    throw new Error('canvas aspect ' + canvasAspect.toFixed(4) + ' does not match the packet camera aspect ' +
                    session.packet.camera.aspect.toFixed(4));
  }
  if (HOLD !== null && LEGACY_DRIVE && HOLD > SCRIPT_TICKS) {
    throw new Error('hold tick ' + HOLD + ' is beyond the scripted sequence (' + SCRIPT_TICKS + ')');
  }
  if (HOLD !== null && SCRIPTED_SPRINT && HOLD > 600) {
    throw new Error('hold tick ' + HOLD + ' is beyond the scripted sprint (600)');
  }

  state.consumer = 'running';
  publish();
  if (consumer.device) await consumer.device.queue.onSubmittedWorkDone();
  requestAnimationFrame(frame);
}

main().catch((error) => fail(error.message));
