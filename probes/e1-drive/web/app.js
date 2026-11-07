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
//   ?soak=1             deterministic soak session: repeats drive -> sprint ->
//                       telemetry segments, rebuilding the world between every
//                       segment, for `?soakSeconds=` simulated seconds (default
//                       300 = 5 min at 60 Hz). Records frame times, heap, scheduler
//                       pool, buffer counts and state/packet hashes. Driven by
//                       tools/soak_browser.mjs; see T-007-soak.md.
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
import { sha256Hex } from './sha256.js';
import { carIdentity, carLabel, fieldsUrl, loadRoster, resolveCar } from './cars.js';
import { PHASES, SCRIPT_TICKS, TICK_HZ, phaseAt, scriptedInput } from './drive-script.js';
import { isFreeLayout, layoutStartHeading, layoutStartPosition, validateSprintLayout } from './sprint-layout.js';
import { SPRINT_EVENT, courseGroundAt, coursePosition, createSprintRules, freeGroundAt } from './sprint-rules.js';
import { createBestTimes } from './sprint-best.js';
import {
  GHOST_CORNERS, GHOST_SOURCE, buildGhostArcTable, createGhostStore, decodeGhost, ghostFromRun,
  ghostGap, ghostMatrices, referenceGhostFileName, validateGhostRecord
} from './ghost-replay.js';
import {
  FREE_PACKET_SCRIPT, FREE_SCRIPT_TICKS, LAP_PACKET_SCRIPT, LAP_SCRIPT_TICKS, respawnScriptInput,
  sprintScriptInput, SPRINT_PACKET_SCRIPT
} from './sprint-script.js';
import {
  COLLISION_PROBES, PropManifestError, applyDrivenLineExclusions, checkPropManifest, collisionProbePose,
  createPropLayer, propPinsForCourse, propYawFromHeading
} from './prop-layer.js';
import {
  createWasmResetEngineSet, runTelemetrySeries, summariseTelemetryMetrics,
  TELEMETRY_MANOEUVRE_ORDER, TELEMETRY_PACKET_SCRIPT, TELEMETRY_SPEC
} from './telemetry.js';
// Committed, verified retail engine-audio module (P71). Served read-only from
// `probes/audio/web/` by tools/serve.mjs; it creates no AudioContext until a
// real gesture calls `ensureStarted()`.
import { createEngineAudio } from '/audio/engine-audio.js';
const params = new URLSearchParams(location.search);
const SCRIPT_PARAM = params.get('script');
const TELEMETRY = params.get('telemetry') === '1';
const SOAK = params.get('soak') === '1';
// `?survey=1`: the extended corridor is drawn (the merged real track visual) but is
// NOT a course. The banner states the measured limit; no race gate, timer or result
// changes. The survey artefact itself is `_work/e1-drive/corridor-survey.json` and
// the labelled page `_work/e1-drive/corridor-survey.html`.
const SURVEY = params.get('survey') === '1';
if (TELEMETRY) document.documentElement.dataset.telemetry = 'running';
if (SURVEY && (TELEMETRY || SOAK)) {
  throw new Error('?survey=1 is a track-visual label; drop telemetry/soak');
}
if (SCRIPT_PARAM && SCRIPT_PARAM !== 'drive' && SCRIPT_PARAM !== 'sprint') {
  throw new Error('unknown script ' + JSON.stringify(SCRIPT_PARAM) + ' (use drive or sprint)');
}
if (TELEMETRY && SCRIPT_PARAM) {
  throw new Error('?telemetry=1 is its own mode; drop the script parameter');
}
if (TELEMETRY && params.has('hold')) {
  throw new Error('?telemetry=1 holds its own presentation tick; drop the hold parameter');
}
if (SOAK && (TELEMETRY || SCRIPT_PARAM || params.has('hold') || params.has('sprintfall'))) {
  throw new Error('?soak=1 is its own deterministic session; drop telemetry/script/hold/sprintfall');
}
// Engine audio (P71): the verified `Race_V8_Engine` RPM layers. Default on, but
// silent until a real key/pointer gesture; `?audio=0` forces it off (headless
// captures and diagnostics) and is the only guaranteed-silent setting.
const AUDIO_PARAM = params.get('audio');
if (AUDIO_PARAM !== null && AUDIO_PARAM !== '0' && AUDIO_PARAM !== '1') {
  throw new Error('audio must be 0 or 1 (omit for on)');
}
const AUDIO_ENABLED = AUDIO_PARAM !== '0';
const SOAK_SECONDS = params.has('soakSeconds') ? Number(params.get('soakSeconds')) : 300;
const SOAK_TICKS_PER_FRAME = params.has('soakTicksPerFrame') ? Number(params.get('soakTicksPerFrame')) : 1;
if (SOAK) {
  if (!Number.isInteger(SOAK_SECONDS) || SOAK_SECONDS < 5 || SOAK_SECONDS > 3600) {
    throw new Error('soakSeconds must be an integer in [5, 3600]');
  }
  if (!Number.isInteger(SOAK_TICKS_PER_FRAME) || SOAK_TICKS_PER_FRAME < 1 || SOAK_TICKS_PER_FRAME > 8) {
    throw new Error('soakTicksPerFrame must be an integer in [1, 8]');
  }
}
const LEGACY_DRIVE = !TELEMETRY && !SOAK && SCRIPT_PARAM === 'drive' && params.get('manual') !== '1';
const SCRIPTED_SPRINT = !TELEMETRY && !SOAK && SCRIPT_PARAM === 'sprint';
const SPRINT_MODE = !TELEMETRY && !SOAK && !LEGACY_DRIVE;
const SPRINT_FALL = params.get('sprintfall') === '1';
if (SPRINT_FALL && !SCRIPTED_SPRINT) throw new Error('?sprintfall=1 needs ?script=sprint');
const HOLD = params.has('hold') ? Number(params.get('hold')) : null;
if (HOLD !== null && (!Number.isInteger(HOLD) || HOLD < 0)) throw new Error('hold must be a non-negative integer tick');
const INTERPOLATE = params.get('interpolate') !== '0';
const REQUESTED_CAR = params.get('car');
// Course selection: the default is the measured 310.395 m P48 course; `?course=short`
// loads the original 29 m straight regression course, `?course=lap` loads the
// P61 loop-01 three-lap layout and `?course=free` loads the P65/P68 free-roam
// basin. Each course has its own best-time namespace.
const COURSE_PARAM = params.get('course') ?? '310';
if (COURSE_PARAM !== '310' && COURSE_PARAM !== 'short' && COURSE_PARAM !== 'lap' && COURSE_PARAM !== 'free') {
  throw new Error('unknown course ' + JSON.stringify(COURSE_PARAM) + ' (use 310, short, lap or free)');
}
const COURSE_IS_SHORT = COURSE_PARAM === 'short';
const COURSE_IS_LAP = COURSE_PARAM === 'lap';
const COURSE_IS_FREE = COURSE_PARAM === 'free';
const COURSE_KEY = COURSE_IS_SHORT ? 'short' : COURSE_IS_LAP ? 'lap' : COURSE_IS_FREE ? 'free' : '310m';
// Capture-only collision probe (`?collisionprobe=lap-sign|free-pipe`). It starts
// the real engine at a manifest-derived pose in front of a P74 V2 target, applies
// throttle until the additive prop layer reports a contact and then brakes with
// the handbrake. It is a presentation/diagnostic mode (`--mode collision-v2`): no race rules, no
// finish, no timer; the engine and the prop layer are the same ones the game
// uses. The start pose and both target ids are read from the manifest at run
// time — no coordinate is typed in.
const COLLISION_PROBE_PARAM = params.get('collisionprobe');
if (COLLISION_PROBE_PARAM !== null && !(COLLISION_PROBE_PARAM in COLLISION_PROBES)) {
  throw new Error('unknown collisionprobe ' + JSON.stringify(COLLISION_PROBE_PARAM) +
    ' (use lap-sign or free-pipe)');
}
const COLLISION_PROBE = COLLISION_PROBE_PARAM !== null;
const COLLISION_PROBE_SPEC = COLLISION_PROBE ? COLLISION_PROBES[COLLISION_PROBE_PARAM] : null;
if (COLLISION_PROBE && COLLISION_PROBE_SPEC.course !== COURSE_PARAM) {
  throw new Error('collisionprobe ' + COLLISION_PROBE_PARAM + ' needs ?course=' + COLLISION_PROBE_SPEC.course);
}
if (COLLISION_PROBE && params.has('hold') === false) {
  throw new Error('collisionprobe needs ?hold=<tick> (the capture holds an integer tick)');
}
// Ghost / rival replay (P63): `G` toggles it, `?ghost=1` shows it from the start.
// The ghost is a *recording of one completed run* (your fastest clean run, or the
// committed deterministic reference trace), replayed through the same car mesh.
// `?ghostoffset=<ticks>` is a capture-only presentation offset: it shifts where
// the ghost is drawn so a headless frame can show it apart from the player car,
// and it changes nothing about the record, the timer, the packet or the physics.
const GHOST_REQUESTED = params.get('ghost') === '1';
const GHOST_OFFSET = params.has('ghostoffset') ? Number(params.get('ghostoffset')) : 0;
if (!Number.isInteger(GHOST_OFFSET) || Math.abs(GHOST_OFFSET) > 1800) {
  throw new Error('ghostoffset must be an integer in [-1800, 1800]');
}
const GHOST_INDEX_URL = '/ghosts/index.json';
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
const SPRINT_URL = COURSE_IS_SHORT ? '/_work/e1-drive/sprint-short.json'
  : COURSE_IS_LAP ? '/_work/e1-drive/sprint-lap.json'
    : COURSE_IS_FREE ? '/_work/e1-drive/sprint-free.json' : '/_work/e1-drive/sprint.json';
const PROP_RESOLVER_URL = '/prop-collision/lib/resolver.mjs';

/** Best-time storage key: one record per course, never mixed. */
const SPRINT_BEST_KEY = 'e1-drive.sprint.best.v2.' + COURSE_KEY;

const canvas = document.getElementById('scene');
const driver = new FixedStepDriver();

const state = {
  consumer: 'idle',
  error: null,
  adapter: null,
  mode: COLLISION_PROBE ? 'collision-probe'
    : LEGACY_DRIVE ? 'script:drive' : SCRIPTED_SPRINT ? (SPRINT_FALL ? 'script:sprint-fall' : 'script:sprint')
    : TELEMETRY ? 'telemetry' : SOAK ? 'soak' : 'keyboard-sprint',
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
  trackTexturedDraws: 0,
  trackTextures: 0,
  trackTextureBytes: 0,
  trackUvVertices: 0,
  levelPropDraws: 0,
  levelPropTexturedDraws: 0,
  levelPropDiagnosticDraws: 0,
  levelPropTextures: 0,
  levelPropTextureBytes: 0,
  levelPropUvVertices: 0,
  levelPropManifestSha256: null,
  levelPropContentHash: null,
  levelPropBlockedInstances: [],
  carTexturedDraws: 0,
  carTextures: 0,
  carTextureBytes: 0,
  carUvVertices: 0,
  carPaintDraws: 0,
  carLightDraws: 0,
  carNoAlbedoDraws: 0,
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
  textureUploads: 0,
  textureUploadBytes: 0,
  uvUploadBytes: 0,
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
  sprintCourseId: null,
  sprintEvents: [],
  sprintBest: null,
  sprintResult: null,
  sprintBanner: null,
  respawning: false,
  // Ghost / rival replay (`G`; null outside the sprint modes). The page never
  // auto-enables it, so existing captures and the legacy drive are unchanged.
  ghost: null,
  props: null,
  collisionProbe: null,
  // Number of in-place world rebuilds (R / sprint restart). Never a page reload.
  restarts: 0,
  // Telemetry (`?telemetry=1` only).
  telemetry: null,
  telemetryBusy: false,
  // Soak (`?soak=1` only): a deterministic segment schedule, frame-time ring and
  // heap/pool/upload checkpoints. The full report is published when it finishes.
  soak: null,
  soakReport: null,
  // Engine audio (P71): typed status plus the RPM/layer values the HUD shows.
  // Null until the module has been constructed or forced off.
  audio: null
};

/**
 * Live ghost state for the HUD and the capture probe. The delta is "what the
 * player still has to make up": positive seconds/metres = the player is behind
 * the ghost at the same arc / the ghost is ahead at the same race time.
 */
function ghostSummary() {
  if (!sprintRules) return null;
  const sprint = state.sprint;
  const enabled = ghostEnabled && ghost.record !== null;
  let delta = null;
  if (sprint && ghost.table) {
    const seconds = sprint.finished ? sprint.finishTimeSeconds : sprint.elapsedSeconds;
    const arc = COURSE_IS_SHORT ? sprint.maxX : sprint.arc;
    if (Number.isFinite(seconds) && Number.isFinite(arc)) delta = ghostGap(ghost.table, { arc, seconds });
  }
  return {
    available: ghost.record !== null,
    enabled,
    source: ghost.source,
    label: ghost.label,
    reason: ghost.reason,
    note: ghost.note,
    hash: ghost.record?.hash ?? null,
    layoutHash: ghost.record?.layoutHash ?? null,
    tickCount: ghost.record?.tickCount ?? null,
    finishTick: ghost.record?.finishTick ?? null,
    timeSeconds: ghost.record?.timeSeconds ?? null,
    stateSequenceHash: ghost.record?.stateSequenceHash ?? null,
    delta,
    offsetTicks: GHOST_OFFSET,
    playbackTick: ghostFrame ? ghostFrame.tick : null,
    bodyMatrix: ghostFrame ? ghostFrame.body : null,
    wheelMatrices: ghostFrame ? {
      frontleft: ghostFrame.wheels.frontleft.spin,
      frontright: ghostFrame.wheels.frontright.spin,
      backleft: ghostFrame.wheels.backleft.spin,
      backright: ghostFrame.wheels.backright.spin
    } : null,
    drawSlots: consumer.stats.ghostDraws,
    drawsIssued: consumer.stats.ghostDrawsIssued,
    frames: consumer.stats.ghostFrames
  };
}

function publish() {
  document.documentElement.dataset.driveState = state.consumer;
  document.documentElement.dataset.holdReached = String(state.holdReached);
  if (state.sprint) document.documentElement.dataset.sprint = state.sprint.phase;
  if (state.telemetry) document.documentElement.dataset.telemetry = state.telemetry.ready ? 'ready' : 'running';
  state.ghost = ghostSummary();
  if (state.collisionProbe) {
    state.collisionProbe.resolved = { x: state.position[0], z: state.position[2] };
  }
  window.e1DriveProbe = state;
  const rows = [
    ['mode', state.mode + (state.hold === null ? '' : ' · hold ' + state.hold + (state.holdReached ? ' reached' : ''))],
    ['car', state.car ? state.car.name + ' · ' + state.car.drivetrain + ' · ' + Math.round(state.car.mass) + ' kg · rec ' + state.car.recordIndex : '—'],
    ['audio', audioHudValue()]
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
    const course = sprint.course;
    if (COURSE_IS_FREE) {
      const free = sprint.free;
      rows.push(['course', 'FREE ROAM · R04 spawn basin ' +
        free.spawnComponentAreaM2.toFixed(1) + ' m² · no gates/finish/lap · ?course=free']);
      rows.push(['free', 'session ' + Number(timer).toFixed(3) + ' s · ' +
        (free.contained ? 'inside the basin' : 'OUTSIDE the basin') + ' · ' +
        free.distanceFromSpawnMetres.toFixed(1) + ' m from spawn' +
        (sprint.respawns ? ' · ' + sprint.respawns + ' reset' : '')]);
      rows.push(['contain', 'box x ' + course.bounds.minX.toFixed(1) + '…' + course.bounds.maxX.toFixed(1) +
        ' z ' + course.bounds.minZ.toFixed(1) + '…' + course.bounds.maxZ.toFixed(1) +
        ' · +' + course.marginMetres.toFixed(1) + ' m margin · ground ' + free.localGroundY.toFixed(2) +
        ' m · ' + free.groundGrid.measuredCells + '/' +
        (free.groundGrid.measuredCells + free.groundGrid.filledCells) + ' measured']);
      rows.push(['props', state.props
        ? 'all-visible · ' + state.props.colliders + ' colliders · ' +
          state.props.contacts + ' contacts · ' + state.props.blockedTicks + ' blocked ticks · ' +
          state.props.substeps + ' substeps'
        : 'all-visible · loading']);
    } else {
      rows.push(['course', COURSE_IS_LAP
        ? 'loop-01 P61 · 3 laps · ' + course.lengthMetres.toFixed(1) + ' m · ?course=lap'
        : COURSE_IS_SHORT
          ? '29 m straight (regression) · ' + course.lengthMetres.toFixed(1) + ' m · ?course=short'
          : '310 m P48 (default) · ' + (course.measuredLengthMetres ?? course.lengthMetres).toFixed(1) +
            ' m measured · finish ' + (course.finishArc ?? course.lengthMetres).toFixed(1) + ' m']);
      rows.push(['sprint', sprint.phase + ' · ' + Number(timer).toFixed(3) + ' s' +
        (sprint.finished ? ' · FINISHED' : '') +
        (COURSE_IS_LAP ? ' · lap ' + sprint.lap + '/' + sprint.laps : '') +
        (sprint.respawns ? ' · ' + sprint.respawns + ' respawn' : '')]);
      if (COURSE_IS_LAP) {
        rows.push(['laps', sprint.checkpointsPassed + '/' + sprint.totalCheckpoints + ' done · ' +
          'current ' + Number(sprint.currentLapSeconds).toFixed(3) + ' s · ' +
          'last ' + (sprint.lastLapSeconds === null ? '—' : sprint.lastLapSeconds.toFixed(3) + ' s') + ' · ' +
          'best ' + (sprint.bestLapSeconds === null ? '—' : sprint.bestLapSeconds.toFixed(3) + ' s') + ' · ' +
          Math.round(sprint.progress * 100) + '%']);
      } else {
        rows.push(['gates', sprint.checkpointsPassed + '/' + sprint.totalCheckpoints + ' cp · ' +
          (sprint.nextGate
            ? 'next ' + sprint.nextGate.id + ' in ' + Math.max(0, sprint.nextGate.distanceMetres).toFixed(1) + ' m'
            : 'finish crossed') +
          ' · ' + Math.round(sprint.progress * 100) + '%']);
      }
      rows.push(['best', state.sprintBest === null ? '—' :
        state.sprintBest.toFixed(3) + ' s' + (state.sprintResult?.improved ? ' (new)' : '')]);
      if (state.props) {
        rows.push(['props', state.props.profile + ' · ' + state.props.colliders + ' colliders' +
          (state.props.drivenLineExclusions
            ? ' · ' + state.props.drivenLineExclusions + ' measured driven-line exclusions'
            : '') + ' · ' +
          state.props.contacts + ' contacts · ' + state.props.blockedTicks + ' blocked ticks · ' +
          state.props.substeps + ' substeps']);
      }
    }
  }
  if (state.collisionProbe) {
    const probe = state.collisionProbe;
    rows.push(['probe', 'COLLISION PROBE · ' + probe.label + ' · target ' + probe.target +
      ' · start ' + probe.distanceMetres.toFixed(1) + ' m · tick ' + state.engineTick]);
    rows.push(['result', state.props
      ? (state.props.contacts > 0
        ? 'contact · ' + state.props.contacts + ' contacts · ' + state.props.blockedTicks +
          ' blocked ticks · resolved x ' + probe.resolved.x.toFixed(3) + ' z ' + probe.resolved.z.toFixed(3)
        : 'approach · 0 contacts · x ' + probe.resolved.x.toFixed(3) + ' z ' + probe.resolved.z.toFixed(3))
      : 'prop layer loading']);
    if (state.props) {
      rows.push(['props', state.props.profile + ' · ' + state.props.colliders + ' colliders · ' +
        state.props.substeps + ' substeps · ' + state.props.manifest]);
    }
  }
  if (state.ghost) {
    const ghostRow = state.ghost;
    if (!ghostRow.available) {
      rows.push(['ghost', 'none · ' + (ghostRow.reason ?? 'no record for this car and course')]);
    } else if (!ghostRow.enabled) {
      rows.push(['ghost', ghostRow.label + ' · G to show' +
        (ghostRow.offsetTicks ? ' · offset ' + ghostRow.offsetTicks + 't' : '')]);
    } else {
      const delta = ghostRow.delta;
      let gap = 'delta n/a';
      if (delta) {
        const level = Math.abs(delta.seconds) <= 0.0005 && Math.abs(delta.metres) <= 0.05;
        const seconds = level ? 0 : delta.seconds;
        gap = 'Δt ' + seconds.toFixed(3) + ' s · Δd ' + Math.abs(delta.metres).toFixed(1) + ' m ' +
          (level ? 'level' : seconds > 0 ? 'behind' : 'ahead');
      }
      rows.push(['ghost', (ghostRow.source === GHOST_SOURCE.BEST ? 'your best' : 'reference') +
        ' replay · ' + gap +
        (ghostRow.offsetTicks ? ' · offset ' + ghostRow.offsetTicks + 't (capture)' : '') + ' · G to hide']);
    }
  }
  if (state.soak) {
    const soak = state.soak;
    rows.push(['soak', soak.phase + ' · cycle ' + soak.cycle + ' · ' +
      soak.totalTicks + '/' + soak.targetTicks + ' ticks' +
      (soak.frames ? ' · ' + soak.frames + ' frames' : '') +
      (soak.status ? ' · ' + soak.status : '')]);
  }
  rows.push(
    ['tick', String(state.displayTick) + ' (engine ' + state.engineTick + ') · ' + state.phase],
    ['speed', state.speed.toFixed(2) + ' m/s · ' + state.speedKph.toFixed(0) + ' km/h'],
    ['position', state.position.map((value) => value.toFixed(2)).join(', ')],
    ['wheels', state.contacts.split('').map((on, index) => 'W' + (index + 1) + (on === '1' ? '●' : '○')).join(' ')],
    ['susp mm', state.suspension.map((value) => (value * 1000).toFixed(1)).join(' ')],
    ['input', 'thr ' + state.input[0].toFixed(2) + ' brk ' + state.input[1].toFixed(2) +
      ' str ' + state.input[2].toFixed(2) + ' hb ' + state.input[3].toFixed(2)],
    ['steer', (steerSign < 0 ? 'inverted' : 'normal') + ' (I) · ?invertSteer=' + (steerSign < 0 ? '1' : '0')],
    ['parts', state.parts + ' parts · ' + state.carDraws + ' draws · ' + state.packetNodes + ' nodes (' + state.wheelNodes + ' wheel)'],
    ['car tex', state.carTexturedDraws + ' textured (' + state.carTextures + ' tex, ' +
      state.carTextureBytes + ' B) · diag ' + (state.carPaintDraws + state.carLightDraws + state.carNoAlbedoDraws) +
      ' (paint ' + state.carPaintDraws + ', light ' + state.carLightDraws + ', no-albedo ' + state.carNoAlbedoDraws +
      ') · uv ' + state.carUvVertices],
    ['track', state.trackDraws + ' real draws · ' + state.trackTriangles + ' tri · ' +
      state.trackTexturedDraws + ' textured (' + state.trackTextures + ' tex, ' +
      state.trackTextureBytes + ' B) · no-draw ' +
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
  publishSurveyBanner();
  publishSprintOverlays();
}

/**
 * `?survey=1`: label the drawn extended corridor. This mode adds no gate, timer or
 * result and changes no packet field; it only states what was measured. The record
 * behind it is `_work/e1-drive/corridor-survey.json` and the labelled page
 * `_work/e1-drive/corridor-survey.html`.
 */
function publishSurveyBanner() {
  const banner = document.getElementById('survey-banner');
  if (!banner) return;
  if (!SURVEY) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.textContent = 'EXTENDED CORRIDOR SURVEY — the real 539.81 m River draw is in the scene; ' +
    'it is not a course: the measured line crosses a 50 m collision face at 57.82 m, ' +
    'the faithful chassis stops at 52.7-53.4 m. Playable sprint: the measured 310 m P48 course ' +
    '(default) or the 29 m straight (`?course=short`).';
}

/** Countdown, event banner and results panel, all driven by rules state. */
function publishSprintOverlays() {
  const ghostTag = document.getElementById('ghost-tag');
  if (ghostTag) {
    const visible = state.ghost?.enabled === true;
    ghostTag.hidden = !visible;
    ghostTag.textContent = visible
      ? 'GHOST · ' + (state.ghost.source === GHOST_SOURCE.BEST ? 'your best run' : 'reference trace') +
        ' · replay, no collision'
      : '';
  }
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
  const countdownLabel = COURSE_IS_FREE ? null : sprint.phase === 'countdown'
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
    if (COURSE_IS_LAP) {
      document.getElementById('results-best').textContent =
        'laps ' + (state.sprintResult.lapTimes ?? []).map((seconds) => seconds.toFixed(3)).join(' / ') +
        ' s · best lap ' + (state.sprintResult.bestLapSeconds ?? best ?? 0).toFixed(3) + ' s' +
        ' · respawns ' + state.sprintResult.respawns +
        (state.sprintResult.improved ? ' · new race best' : '');
    } else {
      document.getElementById('results-best').textContent =
        'checkpoints ' + state.sprintResult.checkpoints + '/' + sprint.totalCheckpoints +
        ' · respawns ' + state.sprintResult.respawns +
        ' · best ' + (best === null ? '—' : best.toFixed(3) + ' s') +
        (state.sprintResult.improved ? ' (new best)' : '');
    }
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
// User-facing steering convention. The user's physical test reported D/right
// turning the car left on screen, so the keyboard mapping is inverted by default;
// `?invertSteer=0` restores the raw mapping and `I` toggles at runtime. The
// scripted sprint controller never passes through this mapping.
let steerSign = params.get('invertSteer') === '0' ? 1 : -1;
window.addEventListener('keydown', (event) => {
  if ((event.key === 'm' || event.key === 'M') && !event.repeat) {
    // Engine-audio mute. Presentation only: it drives the module's master gain
    // and changes no physics, packet, timer or capture value.
    toggleAudioMute();
    return;
  }
  if (SOAK) return; // the soak plan owns the session; no keyboard/restart input
  if ((event.key === 'i' || event.key === 'I') && !event.repeat) {
    steerSign = -steerSign;
    state.steerSign = steerSign;
    publish();
    return;
  }
  if ((event.key === 'g' || event.key === 'G') && !event.repeat) {
    // Ghost replay toggle. It is presentation only: the record, the timer, the
    // packet, the physics and the keyboard steering mapping are untouched.
    if (ghost.record) {
      ghostEnabled = !ghostEnabled;
      updateGhostFrame();
      publish();
    }
    return;
  }
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

// Engine audio starts only from a real user gesture. These listeners never
// create a context on load and never fire in a headless capture (no gesture).
// Only the driving keys / mute start it: the capture-only R (restart) and G
// (ghost) synthetic keys must not create an AudioContext and log a browser
// autoplay warning, which is exactly what a console-clean capture forbids.
const AUDIO_GESTURE_KEYS = new Set([
  'w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'm'
]);
window.addEventListener('keydown', (event) => {
  if (typeof event.key === 'string' && AUDIO_GESTURE_KEYS.has(event.key.toLowerCase())) startEngineAudio();
});
window.addEventListener('pointerdown', startEngineAudio);
// Dispose the context (and its six sources) when the page is hidden/unloaded.
window.addEventListener('pagehide', () => {
  if (!engineAudio) return;
  engineAudio.dispose();
  publishAudioState({ state: 'disposed', contextState: 'closed', rpm: null, activeLayers: 0, layers: [] });
});


function keyboardInput() {
  const throttle = keys.has('w') || keys.has('arrowup') ? 1 : 0;
  const brake = keys.has('s') || keys.has('arrowdown') ? 1 : 0;
  const rawSteer = (keys.has('a') || keys.has('arrowleft') ? -1 : 0) + (keys.has('d') || keys.has('arrowright') ? 1 : 0);
  const steer = rawSteer * steerSign;
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
let soakLayout = null;
// Additive visible-prop layer (P74 V2): bound per course, resolved after the
// engine tick. `propWorld` is kept for the capture-start clearance check.
let propLayer = null;
let propWorld = null;
// Capture-only collision probe state: the manifest-derived start pose and the
// layout whose measured ground is the layer's vertical reference.
let collisionProbeStart = null;
let collisionProbeLayout = null;
// Ghost replay (P63): one record per car and course — the page's own fastest
// clean run if it has one, otherwise the committed deterministic reference trace.
let ghostStore = null;
let ghost = { record: null, decoded: null, table: null, source: 'none', label: null, reason: null, note: null };
let ghostEnabled = false;
let ghostWheelRest = null;
// Last ghost pose handed to the consumer: { tick, body, wheels }. Published for
// the capture probe so the browser pose can be compared with the committed record.
let ghostFrame = null;
// Cumulative in-place rebuilds of this page's single wasm instance in telemetry
// mode (one e1_create in loadEngine, then one e1_reset per manoeuvre and per R).
let telemetryResets = 0;

// ------------------------------------------------------------------ engine audio
// The verified module plays six decoded retail `Race_V8_Engine_*` loops and
// applies the exact `EngineNVolume`/`EngineNPitch` curves. The page supplies one
// number per frame: the wasm car's own `Engine().RPM()` (exposed as
// `_e1_engine_rpm()`), which is the documented `RPMInput` source. There is no
// synth and no fallback: if the WAVs or the AudioContext are unavailable, the
// page stays silent and the HUD states the typed reason.
let engineAudio = null;
let audioMuted = false;
let audioRpmOverride = null;

/** The live retail RPM value; null before a world exists (never a guess). */
function liveEngineRpm() {
  if (!module || typeof module._e1_engine_rpm !== 'function') return null;
  const rpm = module._e1_engine_rpm();
  return Number.isFinite(rpm) && rpm >= 0 ? rpm : null;
}

function publishAudioState(extra = {}) {
  const status = engineAudio ? engineAudio.status : null;
  state.audio = {
    enabled: AUDIO_ENABLED,
    state: !AUDIO_ENABLED ? 'off' : status ? status.state : 'unavailable',
    reason: !AUDIO_ENABLED ? 'forced-off' : status ? status.reason : 'not-created',
    detail: !AUDIO_ENABLED ? '?audio=0' : status ? status.detail : null,
    contextState: status ? status.contextState : 'none',
    muted: audioMuted,
    override: audioRpmOverride !== null,
    rpm: null,
    x: null,
    activeLayers: 0,
    layers: [],
    ...extra
  };
}

/** HUD row: state / RPM / layers / mute, or the typed unavailable reason. */
function audioHudValue() {
  if (!AUDIO_ENABLED) return 'off (?audio=0)';
  const audio = state.audio;
  if (!audio) return 'initialising';
  if (audio.state === 'unavailable') return 'audio unavailable: ' + audio.reason;
  if (audio.state === 'idle') return 'idle · drive key/click starts · M mute';
  if (audio.state === 'loading') return 'loading six layers · M mute';
  const layers = audio.activeLayers ?? 0;
  return audio.state + ' · ' + (Number.isFinite(audio.rpm) ? Math.round(audio.rpm) + ' rpm' : '— rpm') +
    ' · ' + layers + ' layer' + (layers === 1 ? '' : 's') +
    (audio.override ? ' · capture hold' : '') +
    (audio.muted ? ' · muted (M)' : ' · M mute');
}

/**
 * One `setRpm` per rendered frame, after the fixed-step read. The module smooths
 * gain/rate with `setTargetAtTime`; no source is restarted, no audio is created.
 */
function driveEngineAudio() {
  if (!engineAudio) return;
  // A gesture can arrive while the wasm module is still loading; wait for the
  // first world instead of reporting a missing RPM accessor.
  if (!module) return;
  const rpm = audioRpmOverride !== null ? audioRpmOverride : liveEngineRpm();
  if (rpm === null) {
    publishAudioState({
      state: 'unavailable', reason: 'rpm-unavailable',
      detail: 'wasm build does not expose _e1_engine_rpm()'
    });
    return;
  }
  let sample;
  try {
    sample = engineAudio.setRpm(rpm);
  } catch (error) {
    publishAudioState({ state: 'unavailable', reason: 'rpm-invalid', detail: error.message });
    return;
  }
  publishAudioState({
    rpm: sample.rpm,
    x: sample.x,
    activeLayers: sample.layers.filter((layer) => layer.gain > 0.0005).length,
    layers: sample.layers.map((layer) => ({
      slot: layer.slot, wave: layer.wave, gain: layer.gain, rate: layer.rate
    }))
  });
}

/** Gesture-only start. Never called from load, the frame loop or a timer. */
function startEngineAudio() {
  if (!AUDIO_ENABLED || !engineAudio) return;
  if (engineAudio.state === 'loading' || engineAudio.state === 'running' || engineAudio.state === 'disposed') return;
  engineAudio.ensureStarted().then((status) => {
    if (status.state === 'running') {
      engineAudio.setMuted(audioMuted);
      driveEngineAudio();
    } else {
      publishAudioState({ state: 'unavailable', reason: status.reason, detail: status.detail });
    }
    publish();
  }).catch(() => {
    publishAudioState({ state: 'unavailable', reason: 'start-failed', detail: 'ensureStarted threw' });
    publish();
  });
}

/** `M`: mute/unmute through the module's master gain. Works before start. */
function toggleAudioMute() {
  audioMuted = !audioMuted;
  if (engineAudio) audioMuted = engineAudio.setMuted(audioMuted);
  publishAudioState();
  publish();
}

/** Construct at load: synchronous, no AudioContext, no fetch. */
function initEngineAudio() {
  if (!AUDIO_ENABLED) { publishAudioState(); return; }
  try {
    engineAudio = createEngineAudio({ baseUrl: '/_work/audio/', initialRpm: 0, masterGain: 0.5 });
    engineAudio.onStatusChange((status) => {
      publishAudioState({ state: status.state, reason: status.reason, detail: status.detail });
      publish();
    });
    publishAudioState();
  } catch (error) {
    engineAudio = null;
    publishAudioState({ state: 'unavailable', reason: 'construct-failed', detail: error.message });
  }
}

initEngineAudio();
// Capture/diagnostic handle: the same instance, plus a presentation-only RPM
// hold so `--mode audio` can verify the retail curves without racing the loop.
window.e1DriveAudio = {
  get enabled() { return AUDIO_ENABLED; },
  get status() {
    return engineAudio ? engineAudio.status
      : { state: AUDIO_ENABLED ? 'unavailable' : 'off', reason: AUDIO_ENABLED ? 'not-created' : 'forced-off', detail: null, contextState: 'none' };
  },
  getDiagnostics() { return engineAudio ? engineAudio.getDiagnostics() : null; },
  setRpm(rpm) {
    audioRpmOverride = Math.max(0, Number(rpm));
    driveEngineAudio();
    publish();
    return this.getDiagnostics();
  },
  clearRpm() {
    audioRpmOverride = null;
    driveEngineAudio();
    publish();
    return this.getDiagnostics();
  },
  setMuted(value) {
    audioMuted = Boolean(value);
    if (engineAudio) audioMuted = engineAudio.setMuted(audioMuted);
    publishAudioState();
    publish();
    return audioMuted;
  }
};

function readState() {
  return JSON.parse(module.UTF8ToString(module._e1_get_state()));
}

// ------------------------------------------------------------------ ghost replay
// The ghost is a recording, not a simulation. These helpers only read the stored
// record and compose node matrices for the consumer to draw; they never call the
// engine and never touch a packet, a state or a physics value.

/** Course progress axis used by the ghost delta: measured arc or straight x. */
function ghostArcOf(position) {
  if (COURSE_IS_SHORT) return position[0];
  if (COURSE_IS_FREE) return position[0];
  return coursePosition(sprintRules.layout.course.samples, position).arc;
}
/** Select the active ghost record and build its playback + delta tables. */
function setGhostRecord(record, source, label, note = null) {
  const decoded = decodeGhost(record);
  ghost = {
    record,
    decoded,
    table: buildGhostArcTable(decoded, ghostArcOf),
    source,
    label: label ?? record.sourceLabel ?? null,
    reason: null,
    note
  };
}

/** The ghost's tick for the frame about to be drawn: the race clock, not the engine tick. */
function ghostPlaybackTick() {
  const sprint = state.sprint;
  if (!sprint || !ghost.decoded) return null;
  const countdownTicks = ghost.decoded.record.countdownTicks;
  const base = sprint.phase === 'countdown'
    ? countdownTicks - sprint.countdownTicks
    : countdownTicks + sprint.elapsedTicks;
  const alpha = INTERPOLATE && !holdReached ? driver.currentAlpha() : 0;
  const tick = base - 1 + alpha + GHOST_OFFSET;
  return Math.max(0, Math.min(ghost.decoded.tickCount - 1, tick));
}

/** Compose the ghost's nine node matrices and hand them to the consumer. */
function updateGhostFrame() {
  if (!sprintRules || !ghostEnabled || !ghost.decoded) {
    ghostFrame = null;
    consumer.setGhostFrame(null);
    return;
  }
  const tick = ghostPlaybackTick();
  if (tick === null) {
    ghostFrame = null;
    consumer.setGhostFrame(null);
    return;
  }
  const matrices = ghostMatrices(ghost.decoded, tick, ghostWheelRest);
  const nodeMatrices = new Map();
  nodeMatrices.set('e1.car.body', matrices.body);
  for (const corner of GHOST_CORNERS) {
    nodeMatrices.set('e1.car.wheel.' + corner + '.spin', matrices.wheels[corner].spin);
    nodeMatrices.set('e1.car.wheel.' + corner + '.static', matrices.wheels[corner].static);
  }
  consumer.setGhostFrame(nodeMatrices);
  ghostFrame = { tick, body: matrices.body, wheels: matrices.wheels };
}

/**
 * Load the ghost for this car and course: the stored best run first, then the
 * committed deterministic reference trace. A failure is reported in the HUD,
 * never thrown into the drive loop and never replaced by a guessed pose.
 */
async function loadGhost(storage) {
  ghost = { record: null, decoded: null, table: null, source: 'none', label: null, reason: null, note: null };
  ghostFrame = null;
  if (!SPRINT_MODE || !sprintRules) return;
  if (COURSE_IS_LAP) {
    // The ghost is a 310 m / 29 m replay aid; the lap arc resets every lap and no
    // committed lap reference exists, so the lap mode states the reason instead
    // of replaying a mismatched clock. `G` stays inert in this mode.
    ghost.reason = 'ghost replay is not available on the three-lap loop';
    return;
  }
  if (COURSE_IS_FREE) {
    // Free roam has no finish and no progress axis: a committed sprint trace is
    // not a reference for it, so `G` states the reason instead of replaying one.
    ghost.reason = 'ghost replay is not available in free-roam';
    return;
  }
  const body = geometry.carBodies[car.slug];
  if (!body) throw new Error('geometry has no body for ' + car.slug);
  ghostWheelRest = Object.fromEntries(body.wheelGroups.map((group) => [group.corner, group.matrixColumnMajor]));
  const course = COURSE_KEY;
  ghostStore = createGhostStore(storage, course, { layoutHash: sprintRules.layout.hash });
  const stored = ghostStore.get(car.slug);
  let note = null;
  if (stored) {
    if (stored.layoutHash && stored.layoutHash !== sprintRules.layout.hash) {
      note = 'the stored best ghost was recorded on another sprint layout and was not replayed';
    } else {
      try {
        setGhostRecord(stored, GHOST_SOURCE.BEST, 'your best run (' + stored.timeSeconds.toFixed(3) + ' s)');
        return;
      } catch (error) {
        note = 'the stored best ghost was rejected: ' + error.message;
      }
    }
  }
  try {
    const indexResponse = await fetch(GHOST_INDEX_URL, { cache: 'no-store' });
    if (!indexResponse.ok) throw new Error('reference ghost index unavailable (HTTP ' + indexResponse.status + ')');
    const index = await indexResponse.json();
    const entry = index?.cars?.[car.slug]?.[course];
    if (!entry) throw new Error('no committed reference ghost for ' + car.slug + ' on ' + course);
    const response = await fetch('/ghosts/' + referenceGhostFileName(car.slug, course), { cache: 'no-store' });
    if (!response.ok) throw new Error('reference ghost file unavailable (HTTP ' + response.status + ')');
    const text = await response.text();
    if (entry.sha256 && 'sha256:' + sha256Hex(text) !== entry.sha256) {
      throw new Error('reference ghost file does not match its committed SHA-256');
    }
    const record = JSON.parse(text);
    const checked = validateGhostRecord(record);
    if (!checked.ok) throw new Error('reference ghost rejected: ' + checked.errors.join('; '));
    if (entry.ghostHash && entry.ghostHash !== record.hash) {
      throw new Error('reference ghost hash differs from the committed index');
    }
    if (record.layoutHash !== sprintRules.layout.hash) {
      throw new Error('reference ghost was recorded on another sprint layout');
    }
    setGhostRecord(record, GHOST_SOURCE.REFERENCE,
      'reference ghost — committed deterministic sprint trace (' + record.timeSeconds.toFixed(3) + ' s)', note);
  } catch (error) {
    ghost.reason = error.message;
    ghost.note = note;
  }
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
    SPRINT_MODE || SOAK ? fetch(SPRINT_URL, { cache: 'no-store' }) : Promise.resolve(null)
  ]);
  for (const [label, response] of [['geometry', geometryResponse], ['level', levelResponse],
                                    ['car fields (' + car.slug + ')', fieldsResponse], ['spawn', spawnResponse]]) {
    if (!response.ok) throw new Error(label + ' fetch failed: HTTP ' + response.status);
  }
  geometry = await geometryResponse.json();
  spawn = await spawnResponse.json();
  levelBytes = new Uint8Array(await levelResponse.arrayBuffer());
  fieldBytes = new Uint8Array(await fieldsResponse.arrayBuffer());

  let tick0;
  if (SPRINT_MODE || SOAK) {
    if (!sprintResponse.ok) {
      throw new Error('sprint layout fetch failed: HTTP ' + sprintResponse.status +
        ' — run `node probes/e1-drive/tools/build_sprint.mjs` (or `node tools/verify_e1_drive.mjs` first)');
    }
    const layout = await sprintResponse.json();
    const checked = validateSprintLayout(layout, geometry, spawn);
    if (!checked.ok) throw new Error('sprint layout rejected: ' + checked.errors.join('; '));
    if (!COLLISION_PROBE) sprintRules = createSprintRules(layout);
    soakLayout = layout;
    state.sprintLayoutHash = layout.hash;
    state.sprintCourseId = layout.courseId ?? null;
    state.sprintLayout = {
      hash: layout.hash,
      courseId: layout.courseId ?? null,
      gates: layout.gates.map((gate) => ({
        id: gate.id, kind: gate.kind, index: gate.index,
        x: gate.x, z: gate.z, arc: gate.arc ?? null
      })),
      span: layout.course.span ?? null,
      bounds: layout.course.bounds ?? null,
      containment: layout.course.containment
        ? {
          marginMetres: layout.course.containment.marginMetres,
          fallBelowGroundMetres: layout.course.containment.fallBelowGroundMetres,
          airborneTicks: layout.course.containment.airborneTicks,
          spawnComponentAreaM2: layout.course.containment.spawnComponentAreaM2,
          extendedComponentAreaM2: layout.course.containment.extendedComponentAreaM2
        }
        : null,
      prop: layout.course.prop ?? null,
      band: layout.course.band ?? null,
      corridor: layout.course.corridor ?? null,
      coverage: layout.course.coverage ?? null,
      countdownTicks: layout.countdown.ticks,
      rules: layout.rules
    };
    // Visible-prop layer (P74 V2). The 310 m sprint binds the base V2 manifest
    // with the roadside profile (553 of 651 colliders: the four measured on-course
    // arcs stay excluded), the lap binds the same manifest all-visible (651) and
    // free roam binds the R04-V2 manifest all-visible (447). The engine remains
    // the physics authority; the layer only resolves the pose after the tick.
    // A changed file, profile or collider count throws a typed PropManifestError;
    // there is no fallback to an older manifest.
    const pins = SOAK ? null : propPinsForCourse(COURSE_PARAM);
    if (pins) {
      const [manifestResponse, resolver] = await Promise.all([
        fetch('/' + pins.manifest, { cache: 'no-store' }),
        import(PROP_RESOLVER_URL)
      ]);
      if (!manifestResponse.ok) {
        throw new PropManifestError('manifest-fetch',
          'prop manifest fetch failed: HTTP ' + manifestResponse.status + ' (' + pins.manifest + ')');
      }
      const text = await manifestResponse.text();
      if ('sha256:' + sha256Hex(text) !== pins.manifestFileSha256) {
        throw new PropManifestError('manifest-file-sha256',
          'prop manifest file does not match its pinned SHA-256 (' + pins.manifest + ')');
      }
      const manifest = JSON.parse(text);
      const pinCheck = checkPropManifest(manifest, pins);
      if (!pinCheck.ok) {
        throw new PropManifestError('manifest-pins',
          'prop manifest rejected: ' + pinCheck.errors.join('; '));
      }
      propWorld = resolver.createWorld(
        pins.profile === 'roadside' ? applyDrivenLineExclusions(manifest) : manifest,
        { profile: pins.profile });
      propLayer = createPropLayer({ world: propWorld, carEnvelope: manifest.carEnvelope, pins });
      state.props = propLayer.snapshot();
      if (COLLISION_PROBE) {
        collisionProbeLayout = layout;
        collisionProbeStart = collisionProbePose(manifest, COLLISION_PROBE_SPEC);
      }
    } else if (COLLISION_PROBE) {
      throw new PropManifestError('probe-pins-missing',
        'collisionprobe ' + COLLISION_PROBE_PARAM + ' needs a P74 V2 prop layer');
    }
    let storage = null;
    try { storage = window.localStorage; } catch { storage = null; }
    bestTimes = createBestTimes(storage, SPRINT_BEST_KEY);
    state.sprintBest = bestTimes.bestFor(car.slug);
    // Ghost / rival replay: the stored best run, or the committed deterministic
    // reference trace. `?ghost=1` shows it from the start; otherwise `G` toggles.
    await loadGhost(storage);
    ghostEnabled = GHOST_REQUESTED && ghost.record !== null;
    // The 310 m course starts on the measured tangent of its start gate; the
    // 29 m regression course keeps the committed drive spawn heading; the lap
    // starts on P61 loop-01's own point and tangent (component 5). The soak
    // schedule runs drive/telemetry segments whose node anchors were recorded
    // at the legacy spawn heading, so its shared world keeps that heading.
    const start = layoutStartPosition(layout, spawn);
    if (COLLISION_PROBE) {
      tick0 = createWorld(collisionProbeStart.x, collisionProbeStart.z, collisionProbeStart.headingRad);
      const startEnvelope = state.props?.carEnvelope;
      const startContacts = propWorld.contactsAll(tick0.position[0], tick0.position[2],
        propYawFromHeading(collisionProbeStart.headingRad), groundYForState(tick0), startEnvelope);
      if (startContacts.length) {
        throw new PropManifestError('probe-start-blocked',
          'collisionprobe start is inside ' + startContacts[0].colliderId + ' (' + collisionProbeStart.x + ', ' +
          collisionProbeStart.z + ')');
      }
      state.collisionProbe = {
        name: COLLISION_PROBE_PARAM,
        label: COLLISION_PROBE_SPEC.label,
        target: COLLISION_PROBE_SPEC.target,
        axis: COLLISION_PROBE_SPEC.axis,
        sign: COLLISION_PROBE_SPEC.sign,
        distanceMetres: COLLISION_PROBE_SPEC.distanceMetres,
        nearFaceMetres: collisionProbeStart.nearFaceMetres,
        targetCenter: collisionProbeStart.targetCenter,
        outward: collisionProbeStart.outward,
        start: { x: collisionProbeStart.x, z: collisionProbeStart.z,
          headingRad: collisionProbeStart.headingRad },
        resolved: { x: tick0.position[0], z: tick0.position[2] }
      };
    } else {
      tick0 = createWorld(start.x, start.z, SOAK ? spawn.heading : start.heading);
    }
  } else {
    tick0 = createWorld(spawn.x, spawn.z, spawn.heading);
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

/** Local measured ground under a state (the prop layer's vertical reference). */
function groundYForState(state) {
  const layout = collisionProbeLayout ?? sprintRules?.layout ?? null;
  if (!layout) return state.position[1] - 0.35;
  if (isFreeLayout(layout)) return freeGroundAt(layout, state.position);
  const arc = coursePosition(layout.course.samples, state.position).arc;
  return courseGroundAt(layout, arc);
}

/** The input the current mode and rules allow for the step that reaches `tick`. */
function currentInput(tick) {
  if (SOAK) return soakPhaseInput(tick);
  if (COLLISION_PROBE) {
    // Capture probe: full throttle until the additive layer reports the first
    // contact, then brake and handbrake. The input is a function of the run state
    // and tick only; the handbrake holds the stopped car on the measured slope.
    return (state.props?.contacts ?? 0) > 0 ? [0, 1, 0, 1] : [1, 0, 0, 0];
  }
  if (LEGACY_DRIVE) return scriptedInput(tick);
  if (SPRINT_FALL) {
    return sprintRules.respawns > 0 ? sprintRules.gateInput([1, 0, 0, 0]) : respawnScriptInput(tick);
  }
  if (SCRIPTED_SPRINT) return sprintScriptInput(sprintRules, session?.lastState ?? null);
  return sprintRules.gateInput(keyboardInput());
}

/** Record sprint events and persist a finish. Rules only; never touches physics. */
function handleSprintEvents(events) {
  for (const event of events) {
    state.sprintEvents.push(event);
    if (state.sprintEvents.length > 64) state.sprintEvents.shift();
    state.sprintBanner = {
      kind: event.type === SPRINT_EVENT.RESPAWN ? 'respawn' : event.type === SPRINT_EVENT.CHECKPOINT ? 'checkpoint'
        : event.type === SPRINT_EVENT.LAP ? 'lap' : 'other',
      text: event.type === SPRINT_EVENT.CHECKPOINT
        ? 'checkpoint ' + event.index + '/' + sprintRules.totalCheckpoints + ' · ' + event.timeSeconds.toFixed(3) + ' s'
        : event.type === SPRINT_EVENT.LAP
          ? 'lap ' + event.lap + '/' + event.laps + ' · ' + event.lapSeconds.toFixed(3) + ' s' +
            ' · best ' + event.bestLapSeconds.toFixed(3) + ' s'
          : event.type === SPRINT_EVENT.RESPAWN
            ? 'respawn · ' + event.reasons.join(', ') + ' · ' + event.timeSeconds.toFixed(3) + ' s'
            : event.type.toUpperCase(),
      untilTick: event.tick + 90
    };
    if (event.type === SPRINT_EVENT.FINISH) {
      const submitted = bestTimes.submit(car.slug, {
        seconds: event.timeSeconds,
        car: car.name,
        checkpoints: event.laps ?? event.checkpoints,
        respawns: sprintRules.respawns
      });
      state.sprintBest = submitted.best;
      state.sprintResult = {
        visible: true,
        timeSeconds: event.timeSeconds,
        position: event.position,
        checkpoints: event.laps ?? event.checkpoints,
        laps: event.laps ?? null,
        lapTimes: event.lapTimes ?? null,
        bestLapSeconds: event.bestLapSeconds ?? null,
        respawns: sprintRules.respawns,
        car: car.name,
        slug: car.slug,
        bestSeconds: submitted.best,
        previousBestSeconds: submitted.previous,
        improved: submitted.improved,
        persistent: submitted.persistent
      };
      recordGhostFinish(event);
    }
  }
}

/**
 * Store a finished clean run as this car's ghost for the next attempt. The record
 * is the run's own per-tick transform sequence (see web/ghost-replay.js) and its
 * hash is the canonical hash of that sequence; nothing here touches physics.
 */
function recordGhostFinish(event) {
  if (COURSE_IS_LAP) return;
  if (!ghostStore || !session || !car) return;
  if (sprintRules.respawns > 0 || event.checkpoints !== sprintRules.totalCheckpoints) {
    ghost.note = 'this run was not recorded as a ghost because it was not a clean run';
    return;
  }
  try {
    const hashes = state.tickHashes.filter((row) => row.tick <= event.tick).map((row) => row.stateHash);
    if (hashes.length !== event.tick + 1) {
      throw new Error('timeline has ' + hashes.length + ' ticks but the finish is at tick ' + event.tick);
    }
    const record = ghostFromRun({
      car: car.slug,
      course: ghostStore.course,
      courseId: state.sprintCourseId,
      layoutHash: state.sprintLayoutHash,
      countdownTicks: state.sprintLayout?.countdownTicks ?? 0,
      finishTick: event.tick,
      timeSeconds: event.timeSeconds,
      stateSequenceHash: 'sha256:' + sha256Hex(hashes.join('\n')),
      updates: session.packet.updates,
      wheelAnglesByTick: state.wheelAnglesByTick,
      source: GHOST_SOURCE.BEST,
      sourceLabel: 'your best run (' + event.timeSeconds.toFixed(3) + ' s)'
    });
    const submitted = ghostStore.submit(car.slug, record);
    if (submitted.stored) {
      setGhostRecord(record, GHOST_SOURCE.BEST, record.sourceLabel);
      ghost.note = null;
    } else {
      ghost.note = 'this run was slower than the stored ghost (' +
        (submitted.previousSeconds === null ? '—' : submitted.previousSeconds.toFixed(3) + ' s') + ')';
    }
  } catch (error) {
    ghost.note = 'this run could not be stored as a ghost: ' + error.message;
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
    driveEngineAudio();
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
async function startTimeline(tick0, {
  reload = false, rejoin = false,
  packetScript = SPRINT_MODE
    ? (COURSE_IS_LAP ? LAP_PACKET_SCRIPT : COURSE_IS_FREE ? FREE_PACKET_SCRIPT : SPRINT_PACKET_SCRIPT)
    : undefined
} = {}) {
  const start = collisionProbeStart
    ? { x: collisionProbeStart.x, z: collisionProbeStart.z, headingRad: collisionProbeStart.headingRad,
      source: 'P74 collision-v2 capture probe (manifest-derived pose)' }
    : sprintRules ? layoutStartPosition(sprintRules.layout, spawn) : spawn;
  session = createSession(geometry, tick0, {
    spawn: { x: start.x, z: start.z, headingRad: start.headingRad ?? start.heading,
      source: start.source ?? (sprintRules?.layout?.source?.spawnSource ?? spawn.source ?? 'probes/e1-drive/tools/spawn.mjs') },
    car: state.car,
    script: packetScript === null ? undefined : packetScript,
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
  state.trackTexturedDraws = trackInfo?.texturedDrawCount ?? 0;
  state.trackTextures = trackInfo?.textures?.count ?? 0;
  state.trackTextureBytes = trackInfo?.textures?.rgbaBytes ?? 0;
  state.trackUvVertices = trackInfo?.uv ? trackInfo.uv.values / trackInfo.uv.components : 0;
  const levelPropInfo = session.packet.diagnostics.extras.levelProps;
  state.levelPropDraws = levelPropInfo?.drawCount ?? 0;
  state.levelPropTexturedDraws = levelPropInfo?.texturedDrawCount ?? 0;
  state.levelPropDiagnosticDraws = levelPropInfo?.diagnosticDrawCount ?? 0;
  state.levelPropTextures = levelPropInfo?.textures ?? 0;
  state.levelPropTextureBytes = levelPropInfo?.textureBytes ?? 0;
  state.levelPropUvVertices = levelPropInfo?.uvVertices ?? 0;
  state.levelPropManifestSha256 = levelPropInfo?.manifestSha256 ?? null;
  state.levelPropContentHash = levelPropInfo?.contentHash ?? null;
  state.levelPropBlockedInstances = levelPropInfo?.blockedInstances ?? [];
  const textureInfo = session.packet.diagnostics.extras.textures;
  state.carTexturedDraws = partsInfo?.texturedDrawCount ?? 0;
  state.carTextures = textureInfo?.car?.count ?? 0;
  state.carTextureBytes = textureInfo?.car?.rgbaBytes ?? 0;
  state.carUvVertices = partsInfo?.uvVertices ?? 0;
  state.carPaintDraws = partsInfo?.drawClasses?.runtimePaintDraws ?? 0;
  state.carLightDraws = partsInfo?.drawClasses?.runtimeLightBlendDraws ?? 0;
  state.carNoAlbedoDraws = partsInfo?.drawClasses?.runtimeNoAlbedoDraws ?? 0;
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
  if (propLayer) {
    propLayer.begin(tick0, groundYForState(tick0));
    state.props = propLayer.snapshot();
  }
  if (sprintRules) {
    if (rejoin) sprintRules.rejoin(tick0);
    else sprintRules.prime(tick0);
  }
  // One more tick so the v1.1 consumer has a two-tick timeline to load.
  engine.setInput(currentInput(1));
  const rawTick1 = engine.step();
  const tick1 = propLayer ? propLayer.afterTick(rawTick1, groundYForState(rawTick1)) : rawTick1;
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
  state.phase = TELEMETRY ? 'telemetry'
    : SOAK ? (sprintRules ? sprintRules.phase : 'soak-drive')
      : LEGACY_DRIVE ? phaseAt(snapshot.tick) : COLLISION_PROBE ? 'collision-probe'
        : (sprintRules ? sprintRules.phase : 'keyboard');
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
  state.trackTexturedDraws = trackInfo?.texturedDrawCount ?? 0;
  state.trackTextures = trackInfo?.textures?.count ?? 0;
  state.trackTextureBytes = trackInfo?.textures?.rgbaBytes ?? 0;
  state.trackUvVertices = trackInfo?.uv ? trackInfo.uv.values / trackInfo.uv.components : 0;
  const levelPropInfo = session.packet.diagnostics.extras.levelProps;
  state.levelPropDraws = levelPropInfo?.drawCount ?? 0;
  state.levelPropTexturedDraws = levelPropInfo?.texturedDrawCount ?? 0;
  state.levelPropDiagnosticDraws = levelPropInfo?.diagnosticDrawCount ?? 0;
  state.levelPropTextures = levelPropInfo?.textures ?? 0;
  state.levelPropTextureBytes = levelPropInfo?.textureBytes ?? 0;
  state.levelPropUvVertices = levelPropInfo?.uvVertices ?? 0;
  state.levelPropManifestSha256 = levelPropInfo?.manifestSha256 ?? null;
  state.levelPropContentHash = levelPropInfo?.contentHash ?? null;
  state.levelPropBlockedInstances = levelPropInfo?.blockedInstances ?? [];
  const textureInfo = session.packet.diagnostics.extras.textures;
  state.carTexturedDraws = partsInfo?.texturedDrawCount ?? 0;
  state.carTextures = textureInfo?.car?.count ?? 0;
  state.carTextureBytes = textureInfo?.car?.rgbaBytes ?? 0;
  state.carUvVertices = partsInfo?.uvVertices ?? 0;
  state.carPaintDraws = partsInfo?.drawClasses?.runtimePaintDraws ?? 0;
  state.carLightDraws = partsInfo?.drawClasses?.runtimeLightBlendDraws ?? 0;
  state.carNoAlbedoDraws = partsInfo?.drawClasses?.runtimeNoAlbedoDraws ?? 0;
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

// ------------------------------------------------------------------ soak
// `?soak=1`: deterministic session endurance. Segments repeat
//
//   drive      300 scripted ticks (throttle / coast / brake)
//   sprint     countdown, both checkpoints, finish, 120-tick brake tail
//   telemetry  the three diagnostic manoeuvres run synchronously
//
// Each segment starts with `e1_reset()` (a full world rebuild) and builds a new
// packet timeline; the consumer reloads its three meshes (and now destroys the
// previous buffers). Ticks are always 1/60 s. The loop advances
// `?soakTicksPerFrame=` ticks per animation frame (default 1), so the tick
// sequence, every state hash, every packet hash and every telemetry metric are
// independent of wall-clock frame timing; only the frame-time measurements are
// likely to differ between two runs.

const SOAK_PHASE_ORDER = Object.freeze(['drive', 'sprint', 'telemetry']);
const SOAK_DRIVE_TICKS = SCRIPT_TICKS;
const SOAK_SPRINT_MAX_TICKS = 3600;
const SOAK_SPRINT_TAIL_TICKS = 120;
const SOAK_SAMPLE_TICKS = 60;   // one heap/pool/upload sample per simulated second

let soakPhase = 'idle';
let soakCycle = 0;
let soakTargetTicks = 0;
let soakTotalTicks = 0;
let soakTicksPerFrame = 1;
let soakLastTimestamp = null;
let soakFrameSamples = [];
let soakSamples = [];
let soakTransitions = [];
let soakCheckpoints = [];
let soakTelemetry = [];
let soakPhaseTicks = { drive: 0, sprint: 0, telemetry: 0 };
let soakPhaseSegments = { drive: 0, sprint: 0, telemetry: 0 };
let soakLastSampleTick = 0;
let soakNaN = 0;
let soakStartMs = 0;
let soakOpenPhase = null;
let soakDone = false;

/** Input the soak plan asks for on the step that reaches `tick`. */
function soakPhaseInput(tick) {
  if (soakPhase === 'drive') return scriptedInput(tick);
  if (soakPhase === 'sprint' && sprintRules) return sprintScriptInput(sprintRules, session?.lastState ?? null);
  return [0, 0, 0, 0];
}

function soakDiag() {
  const diag = JSON.parse(module.UTF8ToString(module._e1_diag()));
  const groups = Array.isArray(diag.scheduler?.groups) ? diag.scheduler.groups : [];
  const group = groups[diag.group] ?? null;
  return {
    group: diag.group,
    policy: diag.policy,
    poolSize: diag.scheduler?.poolSize ?? null,
    poolHead: diag.scheduler?.poolHead ?? null,
    queued: diag.scheduler?.queued ?? null,
    executing: diag.scheduler?.executing ?? null,
    groupQueued: group?.queued ?? null,
    groupExecuting: group?.executing ?? null,
    groupDependencies: group?.dependencies ?? null,
    wasmHeapBytes: module.HEAPU8.length
  };
}

function soakMemory(forceGc) {
  if (forceGc && typeof window.gc === 'function') {
    try { window.gc(); } catch { /* --expose-gc was not granted */ }
  }
  const memory = typeof performance !== 'undefined' ? performance.memory : null;
  return {
    usedJsHeapBytes: memory ? memory.usedJSHeapSize : null,
    totalJsHeapBytes: memory ? memory.totalJSHeapSize : null,
    jsLimitBytes: memory ? memory.jsHeapSizeLimit : null,
    gcAvailable: typeof window.gc === 'function'
  };
}

function soakBuffers() {
  const stats = consumer.stats;
  return {
    packetLoads: stats.packetLoads,
    buffersCreated: stats.buffersCreated,
    buffersDestroyed: stats.buffersDestroyed,
    buffersLive: stats.buffersCreated - stats.buffersDestroyed,
    texturesCreated: stats.texturesCreated,
    texturesDestroyed: stats.texturesDestroyed,
    texturesLive: stats.texturesCreated - stats.texturesDestroyed,
    geometryUploads: stats.geometryUploads,
    geometryUploadBytes: stats.geometryUploadBytes,
    uvUploadBytes: stats.uvUploadBytes,
    textureUploads: stats.texturesUploaded,
    textureUploadBytes: stats.textureUploadBytes,
    uniformWrites: stats.uniformWrites,
    drawsIssued: stats.drawsIssued,
    renders: stats.renders,
    drawsPerFrame: consumer.draws.length
  };
}

function soakProgress(status = null) {
  if (consumer.adapterInfo) {
    state.adapter = [consumer.adapterInfo.vendor, consumer.adapterInfo.architecture, consumer.adapterInfo.device]
      .filter(Boolean).join(' / ') || 'unnamed adapter';
  }
  state.soak = {
    phase: soakPhase,
    cycle: soakCycle,
    totalTicks: soakTotalTicks,
    targetTicks: soakTargetTicks,
    frames: consumer.stats.renders,
    ticksPerFrame: soakTicksPerFrame,
    segments: soakPhaseSegments.drive + soakPhaseSegments.sprint + soakPhaseSegments.telemetry,
    done: soakDone,
    status: status ?? state.soak?.status ?? null
  };
}

function soakSample() {
  soakSamples.push({
    tick: soakTotalTicks,
    phase: soakPhase,
    cycle: soakCycle,
    frames: consumer.stats.renders,
    ...soakDiag(),
    ...soakBuffers(),
    ...soakMemory(false)
  });
}

function soakCheckpoint(label, extra = {}) {
  const stateNow = session?.lastState ?? readState();
  const packet = session?.packet ?? null;
  const lastUpdate = packet?.updates?.[packet.updates.length - 1] ?? null;
  const row = {
    label,
    phase: soakPhase,
    cycle: soakCycle,
    totalTicks: soakTotalTicks,
    phaseTicks: soakPhaseTicks[soakPhase] ?? 0,
    engineTick: stateNow.tick,
    stateHash: hashOf(stateNow),
    finite: stateNow.finite,
    anyContact: stateNow.anyContact,
    speed: stateNow.speed,
    position: stateNow.position.slice(),
    packetTicks: packet?.updates?.length ?? null,
    lastUpdateHash: lastUpdate?.hash ?? null,
    ...soakDiag(),
    ...soakBuffers(),
    ...soakMemory(true),
    ...extra
  };
  soakCheckpoints.push(row);
  return row;
}

async function soakBeginPhase(name, tick0 = null) {
  soakPhase = name;
  soakPhaseSegments[name]++;
  soakLastTimestamp = null;
  soakOpenPhase = name;
  if (name === 'drive') {
    soakCycle++;
    state.sprint = null;
    state.sprintResult = null;
    state.sprintBanner = null;
    sprintRules = null;
    const world0 = tick0 ?? createWorld(spawn.x, spawn.z, spawn.heading);
    const tick1 = await startTimeline(world0, { reload: true, packetScript: null });
    applyState(tick1);
    soakPhaseTicks[name] += 1;
    soakTotalTicks += 1;
  } else if (name === 'sprint') {
    const world0 = createWorld(spawn.x, spawn.z, layoutStartHeading(soakLayout, spawn));
    sprintRules = createSprintRules(soakLayout);
    const tick1 = await startTimeline(world0, { reload: true, packetScript: SPRINT_PACKET_SCRIPT });
    applyState(tick1);
    soakPhaseTicks[name] += 1;
    soakTotalTicks += 1;
  } else if (name === 'telemetry') {
    // Synchronous by design: the series is three manoeuvres with an e1_reset
    // between each. Its duration is recorded as a mode-switch hitch, not hidden
    // inside a frame-time percentile.
    const started = performance.now();
    createWorld(spawn.x, spawn.z, spawn.heading);
    const series = runTelemetrySeries(engine);
    const syncMs = performance.now() - started;
    const manoeuvres = {};
    let ticks = 0;
    for (const manoeuvre of TELEMETRY_MANOEUVRE_ORDER) {
      const states = series.states[manoeuvre];
      const hashes = states.map((snapshot) => hashOf(snapshot));
      ticks += Math.max(0, states.length - 1);
      manoeuvres[manoeuvre] = {
        ticks: states.length,
        traceHash: hashOf(hashes),
        aggregate: 'sha256:' + sha256Hex(hashes.join('\n'))
      };
    }
    soakPhaseTicks[name] += ticks;
    soakTotalTicks += ticks;
    soakTelemetry.push({
      cycle: soakCycle,
      syncMs,
      plan: series.plan,
      metrics: summariseTelemetryMetrics(series.metrics),
      manoeuvres
    });
    session = null;
    sprintRules = null;
    const last = series.states.lateral[series.states.lateral.length - 1];
    state.engineTick = last.tick;
    state.displayTick = last.tick;
    applyState(last);
  }
  soakLastSampleTick = soakTotalTicks;
  soakSample();
  soakProgress();
  publish();
}

async function soakCompletePhase(name) {
  if (soakOpenPhase !== name) return null;
  let extra = {};
  const currentTick = session?.lastState?.tick ?? state.engineTick;
  const naturalComplete = name === 'drive' ? currentTick >= SOAK_DRIVE_TICKS
    : name === 'sprint'
      ? (sprintRules?.phase === 'finished' &&
          currentTick - sprintRules.finishTick >= SOAK_SPRINT_TAIL_TICKS) || currentTick >= SOAK_SPRINT_MAX_TICKS
      : true;
  extra.truncated = !naturalComplete;
  if (name === 'drive' || name === 'sprint') {
    if (session) {
      const packet = session.finalise();
      extra.packetHash = packet.hash;
      extra.packetTicks = packet.updates.length;
      extra.lastUpdateHash = packet.updates[packet.updates.length - 1]?.hash ?? null;
    }
    const hashes = state.tickHashes.map((row) => row.stateHash);
    extra.stateSequenceHash = 'sha256:' + sha256Hex(hashes.join('\n'));
    extra.stateTicks = hashes.length;
  }
  if (name === 'sprint' && sprintRules) {
    extra.finishSeconds = sprintRules.finishTimeSeconds;
    extra.finishTick = sprintRules.finishTick;
    extra.checkpointsPassed = sprintRules.checkpointsPassed;
    extra.respawns = sprintRules.respawns;
    extra.sprintPhase = sprintRules.phase;
  }
  if (name === 'telemetry' && soakTelemetry.length) {
    const last = soakTelemetry[soakTelemetry.length - 1];
    extra.telemetry = {
      syncMs: last.syncMs,
      manoeuvres: last.manoeuvres,
      metrics: last.metrics,
      plan: last.plan
    };
  }
  soakOpenPhase = null;
  return soakCheckpoint(name + '-complete', extra);
}

function soakStepTicks(count) {
  if (soakPhase === 'telemetry') return { ticks: 0, complete: true };
  let stepped = 0;
  while (stepped < count && soakTotalTicks < soakTargetTicks) {
    const nextTick = state.engineTick + 1;
    engine.setInput(currentInput(nextTick));
    const snapshot = engine.step();
    if (!session) throw new Error('soak: no live timeline for engine tick ' + snapshot.tick);
    const update = session.appendState(snapshot);
    state.tickHashes.push({ tick: snapshot.tick, stateHash: hashOf(snapshot), packetHash: update.hash });
    state.ticksExecuted++;
    soakTotalTicks++;
    soakPhaseTicks[soakPhase]++;
    stepped++;
    if (snapshot.finite !== 1) soakNaN++;
    if (sprintRules) {
      const events = sprintRules.step(snapshot);
      handleSprintEvents(events);
    }
    applyState(snapshot);
    driveEngineAudio();
    if (soakTotalTicks - soakLastSampleTick >= SOAK_SAMPLE_TICKS) {
      soakLastSampleTick = soakTotalTicks;
      soakSample();
    }
    if (soakPhase === 'drive' && snapshot.tick >= SOAK_DRIVE_TICKS) {
      return { ticks: stepped, complete: true };
    }
    if (soakPhase === 'sprint') {
      if (sprintRules?.phase === 'finished' &&
          snapshot.tick - sprintRules.finishTick >= SOAK_SPRINT_TAIL_TICKS) {
        return { ticks: stepped, complete: true };
      }
      if (snapshot.tick >= SOAK_SPRINT_MAX_TICKS) return { ticks: stepped, complete: true };
    }
  }
  return { ticks: stepped, complete: soakTotalTicks >= soakTargetTicks };
}

function soakPercentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function soakStats(values, digits = 3) {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const round = (value) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  return {
    count: numbers.length,
    min: round(numbers[0]),
    p50: round(soakPercentile(numbers, 0.5)),
    p95: round(soakPercentile(numbers, 0.95)),
    p99: round(soakPercentile(numbers, 0.99)),
    max: round(numbers[numbers.length - 1]),
    mean: round(mean)
  };
}

function soakSummariseReport(wallMs) {
  const frameValues = soakFrameSamples.filter((sample) => Number.isFinite(sample.frameMs));
  const steadyValues = frameValues.slice(30);
  const phaseFrameStats = {};
  for (const phase of SOAK_PHASE_ORDER) {
    const rows = frameValues.filter((sample) => sample.phase === phase);
    phaseFrameStats[phase] = rows.length ? {
      frameMs: soakStats(rows.map((sample) => sample.frameMs)),
      workMs: soakStats(rows.map((sample) => sample.workMs)),
      ticks: rows.reduce((sum, sample) => sum + sample.ticks, 0)
    } : null;
  }
  const frameMs = soakStats(frameValues.map((sample) => sample.frameMs));
  const workMs = soakStats(frameValues.map((sample) => sample.workMs));
  const longFrames = {
    over16_7: frameValues.filter((sample) => sample.frameMs > 16.7).length,
    over33_3: frameValues.filter((sample) => sample.frameMs > 33.3).length,
    over50: frameValues.filter((sample) => sample.frameMs > 50).length,
    over100: frameValues.filter((sample) => sample.frameMs > 100).length
  };

  const heapValues = [...new Set([...soakSamples, ...soakCheckpoints].map((row) => row.wasmHeapBytes)
    .filter((value) => Number.isFinite(value)))];
  const checkpointHeaps = soakCheckpoints.map((row) => row.usedJsHeapBytes).filter((value) => Number.isFinite(value));
  const checkpointHalf = Math.floor(checkpointHeaps.length / 2);
  const checkpointMean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  const earlyHeapMean = checkpointMean(checkpointHeaps.slice(0, checkpointHalf));
  const lateHeapMean = checkpointMean(checkpointHeaps.slice(checkpointHalf));
  const jsHeap = {
    gcAvailable: typeof window.gc === 'function',
    checkpointSamples: checkpointHeaps.length,
    first: checkpointHeaps.length ? checkpointHeaps[0] : null,
    last: checkpointHeaps.length ? checkpointHeaps[checkpointHeaps.length - 1] : null,
    min: checkpointHeaps.length ? Math.min(...checkpointHeaps) : null,
    max: checkpointHeaps.length ? Math.max(...checkpointHeaps) : null,
    earlyMeanBytes: earlyHeapMean === null ? null : Math.round(earlyHeapMean),
    lateMeanBytes: lateHeapMean === null ? null : Math.round(lateHeapMean),
    driftBytes: earlyHeapMean === null || lateHeapMean === null ? null : Math.round(lateHeapMean - earlyHeapMean),
    growthBytes: checkpointHeaps.length ? checkpointHeaps[checkpointHeaps.length - 1] - checkpointHeaps[0] : null,
    note: 'checkpoint values are after window.gc(); first-to-last can be negative (V8 released memory). ' +
      'driftBytes compares the second half of the run with the first half. rawSamples are uncollected samples.',
    rawSamples: soakStats([...soakSamples, ...soakCheckpoints].map((row) => row.usedJsHeapBytes), 0)
  };
  const poolHeads = [...new Set([...soakSamples, ...soakCheckpoints].map((row) => row.poolHead)
    .filter((value) => Number.isFinite(value)))];
  const poolSizes = [...new Set([...soakSamples, ...soakCheckpoints].map((row) => row.poolSize)
    .filter((value) => Number.isFinite(value)))];
  const queued = [...new Set([...soakSamples, ...soakCheckpoints].map((row) => row.queued)
    .filter((value) => Number.isFinite(value)))];
  const groups = [...new Set(soakCheckpoints.map((row) => row.group))];
  const groupDependencies = [...new Set(soakCheckpoints.map((row) => row.groupDependencies))];
  const groupQueued = [...new Set(soakCheckpoints.map((row) => row.groupQueued))];
  const poolValid = soakCheckpoints.every((row) => row.group >= 0 && row.group < row.poolSize &&
    row.groupDependencies === 0 && row.groupExecuting === 0);
  const bufferLive = [...new Set([...soakSamples, ...soakCheckpoints].map((row) => row.buffersLive))];
  const textureLive = [...new Set([...soakSamples, ...soakCheckpoints].map((row) => row.texturesLive))];
  const uploadsPerLoad = soakCheckpoints.map((row) => row.packetLoads > 0 ? row.geometryUploads / row.packetLoads : null)
    .filter((value) => Number.isFinite(value));
  const texturesPerLoad = soakCheckpoints.map((row) => row.packetLoads > 0 ? row.textureUploads / row.packetLoads : null)
    .filter((value) => Number.isFinite(value));
  const final = soakCheckpoints[soakCheckpoints.length - 1] ?? null;
  const stats = consumer.stats;

  const checks = [
    { label: 'simulated budget reached', ok: soakTotalTicks >= soakTargetTicks,
      detail: `${soakTotalTicks}/${soakTargetTicks} ticks` },
    { label: 'no NaN/Inf state in any soak tick', ok: soakNaN === 0, detail: `${soakNaN} non-finite ticks` },
    { label: 'wasm heap did not grow', ok: heapValues.length === 1,
      detail: heapValues.map((value) => value + ' B').join(', ') },
    { label: 'scheduler pool and group handles stayed fixed', ok: poolHeads.length === 1 && poolSizes.length === 1 &&
      queued.length === 1 && poolValid,
      detail: `head ${poolHeads.join('/')} size ${poolSizes.join('/')} queued ${queued.join('/')} groups ${groups.join(',')}` },
    { label: 'GPU packet buffers stayed bounded across every reload', ok: bufferLive.length === 1 &&
      final !== null && final.buffersLive === bufferLive[0],
      detail: `live ${bufferLive.join('/')}, created ${stats.buffersCreated}, destroyed ${stats.buffersDestroyed}` },
    { label: 'GPU textures stayed bounded across every reload (no texture leak)', ok: textureLive.length === 1 &&
      final !== null && final.texturesLive === textureLive[0] &&
      final.texturesLive === consumer.textureGroups.size &&
      texturesPerLoad.length > 0 && texturesPerLoad.every((value) => value === consumer.textureGroups.size),
      detail: `live ${textureLive.join('/')} of one packet (${consumer.textureGroups.size} textures), ` +
        `created ${stats.texturesCreated}, destroyed ${stats.texturesDestroyed}, ` +
        `uploaded per load ${texturesPerLoad.join('/')}` },
    { label: 'every timeline load uploaded exactly the three packet meshes', ok: uploadsPerLoad.every((value) => value === 3),
      detail: uploadsPerLoad.map((value) => value.toFixed(3)).join('/') },
    { label: 'one uniform write and one draw set per rendered frame', ok: stats.uniformWrites === stats.renders &&
      stats.drawsIssued === stats.renders * consumer.draws.length,
      detail: `${stats.uniformWrites}/${stats.renders} uniform, ${stats.drawsIssued} draws` },
    { label: 'every segment produced its deterministic checkpoint', ok:
      soakPhaseSegments.drive > 0 && soakPhaseSegments.sprint > 0 && soakPhaseSegments.telemetry > 0 &&
      soakCheckpoints.filter((row) => row.label === 'drive-complete').length === soakPhaseSegments.drive &&
      soakCheckpoints.filter((row) => row.label === 'sprint-complete').length === soakPhaseSegments.sprint &&
      soakCheckpoints.filter((row) => row.label === 'telemetry-complete').length === soakPhaseSegments.telemetry,
      detail: `${soakPhaseSegments.drive} drive / ${soakPhaseSegments.sprint} sprint / ${soakPhaseSegments.telemetry} telemetry segments` }
  ];
  const failures = checks.filter((check) => !check.ok).map((check) => check.label + ': ' + check.detail);
  return {
    kind: 'e1-drive.soak-session',
    version: 1,
    car: state.car,
    spawn,
    spec: {
      targetTicks: soakTargetTicks,
      seconds: soakTargetTicks / TICK_HZ,
      tickHz: TICK_HZ,
      ticksPerFrame: soakTicksPerFrame,
      phases: SOAK_PHASE_ORDER,
      driveTicks: SOAK_DRIVE_TICKS,
      sprintMaxTicks: SOAK_SPRINT_MAX_TICKS,
      sprintTailTicks: SOAK_SPRINT_TAIL_TICKS,
      sampleTicks: SOAK_SAMPLE_TICKS
    },
    status: failures.length ? 'FAIL' : 'PASS',
    failures,
    checks,
    wallMs: Number(wallMs.toFixed(1)),
    simulatedSeconds: Number((soakTotalTicks / TICK_HZ).toFixed(3)),
    totalTicks: soakTotalTicks,
    targetTicks: soakTargetTicks,
    cycles: soakCycle,
    segments: soakPhaseSegments,
    phaseTicks: soakPhaseTicks,
    frames: {
      rendered: stats.renders,
      counted: frameValues.length,
      skippedWarmup: frameValues.length - steadyValues.length,
      frameMs,
      steadyFrameMs: soakStats(steadyValues.map((sample) => sample.frameMs)),
      workMs,
      longFrames,
      byPhase: phaseFrameStats
    },
    memory: {
      wasmHeapBytes: heapValues,
      wasmHeapConstant: heapValues.length === 1,
      jsHeap,
      preciseMemoryInfo: typeof performance !== 'undefined' && !!performance.memory
    },
    scheduler: {
      poolHeads, poolSizes, queued, groups, groupDependencies, groupQueued,
      valid: poolValid
    },
    buffers: {
      packetLoads: stats.packetLoads,
      buffersCreated: stats.buffersCreated,
      buffersDestroyed: stats.buffersDestroyed,
      buffersLive: stats.buffersCreated - stats.buffersDestroyed,
      liveValues: bufferLive,
      texturesCreated: stats.texturesCreated,
      texturesDestroyed: stats.texturesDestroyed,
      texturesLive: stats.texturesCreated - stats.texturesDestroyed,
      textureLiveValues: textureLive,
      texturesPerPacket: consumer.textureGroups.size,
      geometryUploads: stats.geometryUploads,
      geometryUploadBytes: stats.geometryUploadBytes,
      uvUploadBytes: stats.uvUploadBytes,
      textureUploads: stats.texturesUploaded,
      textureUploadBytes: stats.textureUploadBytes,
      uploadsPerLoad: uploadsPerLoad[0] ?? null,
      uniformWrites: stats.uniformWrites,
      drawsIssued: stats.drawsIssued,
      drawsPerFrame: consumer.draws.length,
      renders: stats.renders
    },
    transitions: soakTransitions,
    checkpoints: soakCheckpoints,
    telemetry: soakTelemetry,
    samples: soakSamples
  };
}

async function soakFinalReport() {
  if (soakOpenPhase) await soakCompletePhase(soakOpenPhase);
  soakDone = true;
  const wallMs = performance.now() - soakStartMs;
  soakPhase = 'done';
  const report = soakSummariseReport(wallMs);
  state.soakReport = report;
  soakProgress(report.status);
  state.soak.done = true;
  state.soak.phase = 'done';
  state.soak.status = report.status;
  state.consumer = report.status === 'PASS' ? 'running' : 'error';
  document.documentElement.dataset.soak = report.status;
  publish();
}

function soakIdleFrame() {
  consumer.syncTimeline();
  consumer.renderFrame({ cursor: state.engineTick });
  requestAnimationFrame(soakIdleFrame);
}

async function runSoakMode(initialTick0) {
  soakTargetTicks = SOAK_SECONDS * TICK_HZ;
  soakTicksPerFrame = SOAK_TICKS_PER_FRAME;
  soakStartMs = performance.now();
  soakTotalTicks = 0;
  soakCycle = 0;
  soakDone = false;
  soakLastTimestamp = null;
  soakFrameSamples = [];
  soakSamples = [];
  soakTransitions = [];
  soakCheckpoints = [];
  soakTelemetry = [];
  soakPhaseTicks = { drive: 0, sprint: 0, telemetry: 0 };
  soakPhaseSegments = { drive: 0, sprint: 0, telemetry: 0 };
  soakNaN = 0;
  state.soakReport = null;
  state.consumer = 'loading';
  await soakBeginPhase('drive', initialTick0);
  let phase = 'drive';
  try {
    while (!soakDone) {
      if (phase === 'telemetry') {
        const started = performance.now();
        await soakCompletePhase('telemetry');
        if (soakTotalTicks >= soakTargetTicks) break;
        await soakBeginPhase('drive');
        soakTransitions.push({ from: 'telemetry', to: 'drive', atTick: soakTotalTicks,
          ms: Number((performance.now() - started).toFixed(1)) });
        phase = 'drive';
        continue;
      }
      if (soakTotalTicks >= soakTargetTicks) break;
      const now = await new Promise((resolve) => requestAnimationFrame(resolve));
      const frameStart = performance.now();
      const dt = soakLastTimestamp === null ? null : now - soakLastTimestamp;
      soakLastTimestamp = now;
      const stepped = soakStepTicks(soakTicksPerFrame);

      state.displayTick = state.engineTick;
      const anglesAtDisplay = state.wheelAnglesByTick?.[state.displayTick];
      if (anglesAtDisplay && anglesAtDisplay.tick === state.displayTick) state.wheelAngles = anglesAtDisplay.angles;
      const cameraAtDisplay = state.updates?.[state.displayTick]?.camera;
      if (cameraAtDisplay) {
        state.cameraDistance = cameraAtDisplay.orbit.distance;
        state.cameraOcclusion = cameraAtDisplay.occlusion ?? null;
      }
      consumer.syncTimeline();
      const rendered = consumer.renderFrame({ cursor: state.engineTick });
      if (rendered) {
        state.frames = consumer.stats.renders;
        state.tickHash = rendered.frame.tickHash;
        state.matrixChecksum = consumer.stats.matrixChecksum;
        state.geometryUploads = consumer.stats.geometryUploads;
        state.geometryUploadBytes = consumer.stats.geometryUploadBytes;
        state.textureUploads = consumer.stats.texturesUploaded;
        state.textureUploadBytes = consumer.stats.textureUploadBytes;
        state.uvUploadBytes = consumer.stats.uvUploadBytes;
        state.uniformWrites = consumer.stats.uniformWrites;
        state.drawsIssued = consumer.stats.drawsIssued;
        state.draws = consumer.draws.length;
        if (state.consumer !== 'error') state.consumer = 'running';
      }
      const workMs = performance.now() - frameStart;
      if (dt !== null && dt >= 0) {
        soakFrameSamples.push({ phase, frameMs: dt, workMs, ticks: stepped.ticks, tick: state.engineTick });
      }
      if (soakFrameSamples.length % 30 === 0) {
        soakProgress();
        publish();
      }

      if (stepped.complete && soakTotalTicks < soakTargetTicks) {
        const started = performance.now();
        await soakCompletePhase(phase);
        const next = SOAK_PHASE_ORDER[(SOAK_PHASE_ORDER.indexOf(phase) + 1) % SOAK_PHASE_ORDER.length];
        await soakBeginPhase(next);
        soakTransitions.push({ from: phase, to: next, atTick: soakTotalTicks,
          ms: Number((performance.now() - started).toFixed(1)) });
        phase = next;
      }
    }
    await soakFinalReport();
    requestAnimationFrame(soakIdleFrame);
  } catch (error) {
    state.soakReport = { kind: 'e1-drive.soak-session', version: 1, status: 'FAIL',
      failures: ['abort: ' + (error?.message ?? String(error))], error: String(error?.stack ?? error), checks: [] };
    state.soak = { ...(state.soak ?? {}), phase: 'failed', done: true, status: 'FAIL',
      totalTicks: soakTotalTicks, targetTicks: soakTargetTicks };
    document.documentElement.dataset.soak = 'FAIL';
    fail(error.message);
  }
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
    driveEngineAudio();
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
      const rawSnapshot = engine.step();
      const snapshot = propLayer ? propLayer.afterTick(rawSnapshot, groundYForState(rawSnapshot)) : rawSnapshot;
      const update = session.appendState(snapshot);
      state.tickHashes.push({ tick: snapshot.tick, stateHash: hashOf(snapshot), packetHash: update.hash });
      state.ticksExecuted++;
      if (propLayer) state.props = propLayer.snapshot();
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

  // One audio parameter update per rendered frame, from the RPM the simulation
  // actually used (held state included). Silent until the module was started.
  driveEngineAudio();

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

  updateGhostFrame();
  consumer.syncTimeline();
  const rendered = consumer.renderFrame({ cursor });
  if (rendered) {
    state.frames = consumer.stats.renders;
    state.tickHash = rendered.frame.tickHash;
    state.matrixChecksum = consumer.stats.matrixChecksum;
    state.movedScreen = consumer.stats.movedScreen;
    state.geometryUploads = consumer.stats.geometryUploads;
    state.geometryUploadBytes = consumer.stats.geometryUploadBytes;
    state.textureUploads = consumer.stats.texturesUploaded;
    state.textureUploadBytes = consumer.stats.textureUploadBytes;
    state.uvUploadBytes = consumer.stats.uvUploadBytes;
    state.uniformWrites = consumer.stats.uniformWrites;
    state.uniformBytes = consumer.stats.uniformBytes;
    state.drawsIssued = consumer.stats.drawsIssued;
    if (state.consumer !== 'error') state.consumer = 'running';
    publish();
  }
  requestAnimationFrame(frame);
}

function applyCanvasAspect() {
  if (!consumer || !consumer.cameraShape) return;
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  consumer.cameraShape.aspect = aspect;
  if (session && session.packet && session.packet.camera) session.packet.camera.aspect = aspect;
}
window.addEventListener('resize', applyCanvasAspect);

async function main() {
  state.consumer = 'loading';
  publish();
  const tick0 = await loadEngine();

  if (TELEMETRY) {
    await runTelemetryMode();
    state.adapter = consumer.adapterInfo
      ? [consumer.adapterInfo.vendor, consumer.adapterInfo.architecture, consumer.adapterInfo.device].filter(Boolean).join(' / ') || 'unnamed adapter'
      : 'unnamed adapter';
    applyCanvasAspect();
    state.consumer = 'running';
    publish();
    if (consumer.device) await consumer.device.queue.onSubmittedWorkDone();
    requestAnimationFrame(frame);
    return;
  }

  if (SOAK) {
    state.adapter = consumer.adapterInfo
      ? [consumer.adapterInfo.vendor, consumer.adapterInfo.architecture, consumer.adapterInfo.device].filter(Boolean).join(' / ') || 'unnamed adapter'
      : 'unnamed adapter';
    await runSoakMode(tick0);
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

  applyCanvasAspect();
  if (HOLD !== null && LEGACY_DRIVE && HOLD > SCRIPT_TICKS) {
    throw new Error('hold tick ' + HOLD + ' is beyond the scripted sequence (' + SCRIPT_TICKS + ')');
  }
  if (HOLD !== null && SCRIPTED_SPRINT && !COLLISION_PROBE && HOLD > (COURSE_IS_LAP ? LAP_SCRIPT_TICKS
    : COURSE_IS_FREE ? FREE_SCRIPT_TICKS : 3600)) {
    throw new Error('hold tick ' + HOLD + ' is beyond the scripted sprint (' +
      (COURSE_IS_LAP ? LAP_SCRIPT_TICKS : COURSE_IS_FREE ? FREE_SCRIPT_TICKS : 3600) + ')');
  }

  state.consumer = 'running';
  publish();
  if (consumer.device) await consumer.device.queue.onSubmittedWorkDone();
  requestAnimationFrame(frame);
}

main().catch((error) => fail(error.message));
