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
import { MAPS, MP_MAP_IDS, resolveMap } from './map-registry.js';
import { bytesSha256, mergeMapGeometry, textSha256, validateMapPackage } from './map-package.js';
import {
  CHUNK_ERROR, ChunkLoadError, assembleGeometry, parseBaseChunk, parseCarChunk, parseChunkIndex,
  parseLevelChunk, verifyChunkBytes, verifyChunkSha
} from './geometry-chunks.js';
import { createBestTimes } from './sprint-best.js';
import {
  GHOST_CORNERS, GHOST_SOURCE, buildGhostArcTable, createGhostStore, decodeGhost, ghostFromRun,
  ghostGap, ghostMatrices, quaternionFromAxes, referenceGhostFileName, validateGhostRecord
} from './ghost-replay.js';
import {
  FREE_PACKET_SCRIPT, FREE_SCRIPT_TICKS, LAP_PACKET_SCRIPT, LAP_SCRIPT_TICKS, respawnScriptInput,
  sprintScriptInput, SPRINT_PACKET_SCRIPT, SPRINT_CONTROL
} from './sprint-script.js';
import {
  MpSession, MP_ANGLE_THRESHOLD_RAD, MP_BLEND_TICKS, MP_INPUT_HZ, MP_MAP_MISMATCH, MP_MAX_PLAYERS,
  MP_POSITION_THRESHOLD_METRES, MP_REMOTE_DELAY_TICKS, MP_SCHEMA, MP_STATE_EVERY_TICKS, MP_TICK_HZ,
  MpMapError, assertMpMapAgreement, buildMpResult, compareMpMapRecords, defaultRoomUrl, mpFinishTick,
  mpMapRecord, normalizeMpMapId, normalizePlayerName, normalizeRoomCode, sessionCarForRoom
} from './mp-client.js';
import { RemoteDisplay, remoteNodeMatrixMap } from './mp-remote.js';
import {
  AiRemoteSet, MP_AI_MAX, MP_AI_POSE_EVERY_TICKS, MP_AI_PROFILE_IDS, MP_AI_RELAY_PATH,
  MP_AI_RELAY_POLL_MS, aiControlOverrides, aiLabel,
  aiParticipants, aiResultRows, aiRosterReady, aiSummary, buildAiRoster, isAiPlayerId
} from './mp-ai.js';
import { createAiDriver, SKILL_PROFILES as AI_SKILL_PROFILES } from './ai-driver-browser.js';
import {
  POWERUP_DEFERRED, POWERUP_PROJECTILE_TYPES, POWERUP_SCHEMA, POWERUP_SLICE_LABELS, POWERUP_SLICE_TYPES,
  applyPowerupBatch, createPowerupModel, createPowerupView, forwardFromQuaternion, powerupEventText,
  powerupViewSummary, shieldFor
} from './powerups.js';
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
// Map registry (M3): `?map=river` (default) keeps the exact M1 paths, layouts and
// pins. `?map=amboy` and `?map=gracia` load their committed map packages. An
// unknown id is a hard error; there is no silent fallback to River.
// The active map is mutable only for the online lobby: the host may switch
// River/Amboy/Gracia before the race starts and every client reloads the room's
// selected package. Solo pages never call `applyActiveMap`.
let MAP = resolveMap(params.get('map'));
let MAP_IS_AMBOY = MAP.id === 'amboy';
let MAP_IS_GRACIA = MAP.id === 'gracia';
let MAP_IS_PACKAGE = MAP.kind === 'map-package';
let MAP_PACKET_SCRIPT =
  'sprint: 3-2-1 countdown, pure-pursuit controller on the measured ' + MAP.level + ' ' +
  (MAP_IS_AMBOY ? '2,060.595' : MAP_IS_GRACIA ? '624.914' : '') +
  ' m path, brake after the finish (probes/e1-drive/web/sprint-script.js)';
// The map paths are up to ~2 km at a controlled 12 m/s; the verified Amboy
// scripted finish is tick 13,413. River's 3,600-tick bound stays exact.
let MAX_SPRINT_SCRIPT_TICKS = MAP_IS_PACKAGE ? 20000 : 3600;
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

// ---------------------------------------------------------------- multiplayer
// M1: `${origin}/?mp=1&host=1` creates a room; `?mp=1&room=CODE` joins it. The
// room service is the unchanged probes/net-mvp server; the page talks to it over
// WebSocket at `?mpServer=` or the documented default port 8811. Only the 310 m
// sprint is in scope for M1.
const MP = params.get('mp') === '1';
const MP_HOST = MP && params.get('host') === '1';
const MP_REQUESTED_CODE = params.get('room');
const MP_CODE = MP_REQUESTED_CODE === null ? null : normalizeRoomCode(MP_REQUESTED_CODE);
const MP_NAME = normalizePlayerName(params.get('name'), MP_HOST ? 'Host' : 'Guest');
const MP_URL = params.get('mpServer') || defaultRoomUrl(location);
const MP_PACE = params.has('mpPace') ? Number(params.get('mpPace')) : 1;
if (MP) {
  if (TELEMETRY || SOAK || SURVEY || COLLISION_PROBE) {
    throw new Error('?mp=1 is its own mode; drop telemetry/soak/survey/collisionprobe');
  }
  if (COURSE_PARAM !== '310') throw new Error('M1 multiplayer runs the measured 310 m sprint; drop ?course=' + COURSE_PARAM);
  if (params.has('hold')) throw new Error('multiplayer is a live room; drop ?hold=');
  if (SCRIPT_PARAM && SCRIPT_PARAM !== 'sprint') throw new Error('multiplayer supports ?script=sprint for the diagnostic drive only');
  if (MP_REQUESTED_CODE !== null && !MP_CODE) {
    throw new Error('room must be 5 characters from ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (got ' +
      JSON.stringify(MP_REQUESTED_CODE) + ')');
  }
  if (!MP_HOST && !MP_CODE) throw new Error('a multiplayer guest needs ?room=CODE (the host allocates it)');
  // The map is a room setting: only the host may propose it. A guest inherits
  // the room map and must not be able to override it through the URL.
  if (!MP_HOST && params.has('map')) {
    throw new Error('guests inherit the room map; drop ?map=' +
      JSON.stringify(params.get('map')) + ' (only the host selects it)');
  }
  if (!Number.isFinite(MP_PACE) || MP_PACE < 0.5 || MP_PACE > 1.2) {
    throw new Error('mpPace must be a number in [0.5, 1.2]');
  }
  if (!/^wss?:\/\//.test(MP_URL)) throw new Error('mpServer must be a ws:// or wss:// URL');
}
// M4 AI opponents: the host may add 0-3 host-simulated cars to the room. The
// roster is a lobby setting (count + per-AI car + skill profile); guests see it
// read-only and never simulate it. `?ai=` is the host URL form; the lobby
// controls and `window.__mp.setAi()` use the same validator.
const MP_AI_REQUEST = {
  count: MP_HOST && params.has('ai') ? Number(params.get('ai')) : 0,
  cars: MP_HOST ? (params.get('aiCars') ?? '') : '',
  profiles: MP_HOST ? (params.get('aiProfiles') ?? '') : ''
};
if (MP && !MP_HOST && (params.has('ai') || params.has('aiCars') || params.has('aiProfiles'))) {
  throw new Error('AI opponents are host-configured; a guest inherits them from the room');
}
if (MP && (!Number.isInteger(MP_AI_REQUEST.count) ||
    MP_AI_REQUEST.count < 0 || MP_AI_REQUEST.count > MP_AI_MAX)) {
  throw new Error('ai must be an integer in [0, ' + MP_AI_MAX + ']');
}
if (MP && MP_AI_REQUEST.profiles) {
  for (const profile of String(MP_AI_REQUEST.profiles).split(',').map((entry) => entry.trim()).filter(Boolean)) {
    if (!MP_AI_PROFILE_IDS.includes(profile)) {
      throw new Error('aiProfiles must use ' + MP_AI_PROFILE_IDS.join(', ') + ' (got ' + profile + ')');
    }
  }
}
// M2/PWR2 power-up slice. Default off; it is a multiplayer-only mode and the
// first slice integrates Mine/Shield/Repair only (see POWERUP_DEFERRED).
const POWERUPS = MP && params.get('powerups') === '1';
if (MP && params.has('powerups') && params.get('powerups') !== '0' && params.get('powerups') !== '1') {
  throw new Error('powerups must be 0 or 1');
}
if (!MP && params.get('powerups') === '1') {
  throw new Error('?powerups=1 is the online race slice; add ?mp=1&host=1 or ?mp=1&room=CODE');
}
// usa_amboy / spa_barcelona_gracia (M3 map packages) are point-to-point maps.
// They run solo through `?map=` and the online room through `map` selection.
// River-only modes and courses are rejected explicitly rather than silently
// loading a different map or course.
if (MAP_IS_PACKAGE) {
  if (!MAP.courses.includes(COURSE_PARAM)) {
    throw new Error('?map=' + MAP.id + ' runs the measured ' +
      (MAP_IS_AMBOY ? '2,060.595' : MAP_IS_GRACIA ? '624.914' : '') +
      ' m course; drop ?course=' + COURSE_PARAM);
  }
  if (POWERUPS && MAP.id !== 'river') {
    throw new Error('power-ups are River-only in this gate; ?map=' + MAP.id + ' has no placed pickups');
  }
  if (SCRIPT_PARAM === 'drive') throw new Error('?map=' + MAP.id + ' runs the sprint; drop ?script=drive');
  if (TELEMETRY || SOAK || SURVEY || COLLISION_PROBE) {
    throw new Error('?map=' + MAP.id + ' supports drive/sprint only; drop telemetry/soak/survey/collisionprobe');
  }
}
const POWERUP_MARKER_MESH = 'e1.powerup.marker';
const POWERUP_MARKER_SLOTS = 16;
const POWERUP_RING_MESH = 'e1.powerup.ring';
const POWERUP_RING_SLOTS = 4;
const POWERUP_RELAY_POLL_MS = 100;
const POWERUP_TICK_SECONDS = 1 / 60;
// The capture-only diagnostic pace scales the speed targets of the scripted
// Stanley controller. It changes only the input script (never physics or the
// engine); the normal page and every existing gate pass no override.
const MP_CONTROL = MP && MP_PACE !== 1
  ? Object.freeze({
    ...SPRINT_CONTROL,
    cruiseSpeed: SPRINT_CONTROL.cruiseSpeed * MP_PACE,
    minSpeed: SPRINT_CONTROL.minSpeed * MP_PACE,
    finishSpeed: SPRINT_CONTROL.finishSpeed * MP_PACE,
    // The map-package controller (`AMBOY_CONTROL`) is selected inside
    // `sprintScriptInput`; it reads this capture-only pace to scale its own
    // speed targets. River ignores it and keeps the scaled constants above.
    pace: MP_PACE
  })
  : null;
// Provisional race-rules starting grid (2.2 m spacing, two per row). M1 starts
// both cars on the measured start line in the same row; this is project-specific
// and labelled `provisional`, never a retail start-position table.
const MP_GRID_OPTIONS = Object.freeze({});

const ENGINE_MODULE = '/_work/e1-drive/module/e1_drive.mjs';
let GEOMETRY_URL = MAP.geometryUrl;
let LEVEL_GEOMETRY_URL = MAP.levelGeometryUrl ?? MAP.geometryUrl;
let CAR_INDEX_URL = MAP.carIndexUrl ?? null;
let BASE_GEOMETRY_URL = MAP.baseGeometryUrl ?? null;
let LEVEL_URL = MAP.physicsUrl;
let SPAWN_URL = MAP.spawnUrl;
let SPRINT_URL = MAP.layoutUrl ?? (COURSE_IS_SHORT ? '/_work/e1-drive/sprint-short.json'
  : COURSE_IS_LAP ? '/_work/e1-drive/sprint-lap.json'
    : COURSE_IS_FREE ? '/_work/e1-drive/sprint-free.json' : '/_work/e1-drive/sprint.json');
const PROP_RESOLVER_URL = '/prop-collision/lib/resolver.mjs';

/** Best-time storage key: one record per map/course, never mixed. */
let SPRINT_BEST_KEY = MAP.bestKey ?? ('e1-drive.sprint.best.v2.' + COURSE_KEY);

/**
 * Activate a map for the online lobby. Mutates only the map-derived load
 * constants; it never touches the room, the car or the rules. Solo pages keep
 * their `?map=` map for the whole page lifetime.
 */
function applyActiveMap(value) {
  const map = resolveMap(normalizeMpMapId(value) ?? 'river');
  MAP = map;
  MAP_IS_AMBOY = map.id === 'amboy';
  MAP_IS_GRACIA = map.id === 'gracia';
  MAP_IS_PACKAGE = map.kind === 'map-package';
  MAP_PACKET_SCRIPT =
    'sprint: 3-2-1 countdown, pure-pursuit controller on the measured ' + map.level + ' ' +
    (MAP_IS_AMBOY ? '2,060.595' : MAP_IS_GRACIA ? '624.914' : '') +
    ' m path, brake after the finish (probes/e1-drive/web/sprint-script.js)';
  MAX_SPRINT_SCRIPT_TICKS = MAP_IS_PACKAGE ? 20000 : 3600;
  GEOMETRY_URL = map.geometryUrl;
  LEVEL_GEOMETRY_URL = map.levelGeometryUrl ?? map.geometryUrl;
  CAR_INDEX_URL = map.carIndexUrl ?? null;
  BASE_GEOMETRY_URL = map.baseGeometryUrl ?? null;
  LEVEL_URL = map.physicsUrl;
  SPAWN_URL = map.spawnUrl;
  SPRINT_URL = map.layoutUrl ?? (COURSE_IS_SHORT ? '/_work/e1-drive/sprint-short.json'
    : COURSE_IS_LAP ? '/_work/e1-drive/sprint-lap.json'
      : COURSE_IS_FREE ? '/_work/e1-drive/sprint-free.json' : '/_work/e1-drive/sprint.json');
  SPRINT_BEST_KEY = map.bestKey ?? ('e1-drive.sprint.best.v2.' + COURSE_KEY);
  return map;
}

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
  map: null,
  mapCounts: null,
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
  audio: null,
  // M1 multiplayer (`?mp=1`): room/lobby, 20 Hz remote snapshot, display
  // correction counter, host rules/result. Null outside the MP mode.
  mp: MP ? {
    enabled: true,
    host: MP_HOST,
    name: MP_NAME,
    url: MP_URL,
    requestedCode: MP_CODE,
    requestedCodeMismatch: false,
    phase: 'connecting',
    status: 'connecting…',
    error: null,
    engineReady: false,
    room: null,
    you: null,
    players: [],
    ready: false,
    // Room map agreement (M3): the expected registry record, the measured
    // record, and the typed refusal if they differ. `mapReady` is the local
    // `map-ready` report; the wire carries it as the room ready flag.
    map: null,
    mapReady: false,
    mapError: null,
    mapLoad: null,
    started: false,
    grid: null,
    sessionCar: null,
    remote: {
      id: null, name: null, slot: null, car: null, carChunk: null, connected: null,
      latest: null, sample: null, display: null, input: null,
      distance: null, authority: false,
      corrections: 0, hardSets: 0, blends: 0, tick: null
    },
    result: null,
    resultSource: null,
    validation: null,
    hostSession: null,
    // M4 AI opponents (host-controlled). Null-ish outside `?mp=1`; the count is
    // 0 by default so every M1 capture/regression keeps its exact two-player
    // path. `players` is the host's built roster, `remotePlayers` the guest's
    // relay copy; `remotes` is the interpolated display state for the HUD.
    ai: MP ? {
      enabled: true,
      host: MP_HOST,
      count: MP_AI_REQUEST.count,
      cars: MP_AI_REQUEST.cars,
      profiles: MP_AI_REQUEST.profiles,
      max: MP_AI_MAX,
      mapId: MAP.id,
      players: [],
      remotePlayers: [],
      built: MP_AI_REQUEST.count === 0,
      ready: MP_AI_REQUEST.count === 0,
      errors: [],
      errorCodes: [],
      remotes: [],
      relay: null,
      relayError: null,
      relayCursor: 0,
      relayPolling: false,
      relayTimer: null,
      poseTick: null,
      poseCount: 0,
      result: null,
      resultHash: null,
      allTerminal: null,
      hostSim: null
    } : null,
    finishReported: false,
    finishTick: null,
    finishTimeSeconds: null,
    ping: null,
    sent: { state: 0, input: 0 },
    received: { state: 0, input: 0 },
    applied: { state: 0, input: 0 },
    sendFailures: 0,
    dropCount: 0,
    resumeCount: 0,
    inputHz: MP_INPUT_HZ,
    stateHz: MP_TICK_HZ / MP_STATE_EVERY_TICKS,
    remoteDelayTicks: MP_REMOTE_DELAY_TICKS,
    correctionThresholdMetres: MP_POSITION_THRESHOLD_METRES,
    correctionThresholdRad: MP_ANGLE_THRESHOLD_RAD,
    blendTicks: MP_BLEND_TICKS,
    remoteWheelSpin: 'static (the E1 state snapshot has no wheel angle)',
    sameCar: true,
    schema: MP_SCHEMA
  } : null,
  // M2/PWR2 power-up slice (`?mp=1&powerups=1`). Null unless explicitly enabled.
  powerups: POWERUPS ? {
    enabled: true,
    phase: 'loading',
    status: 'loading the PWR1 manifest…',
    schema: POWERUP_SCHEMA,
    manifestHash: null,
    types: POWERUP_SLICE_TYPES.slice(),
    deferred: { ...POWERUP_DEFERRED },
    placement: null,
    events: [],
    counts: {},
    lastEvents: [],
    notice: null,
    wrecked: false,
    remoteWrecked: false,
    snapshot: null,
    view: null,
    boost: null,
    boostEventSeqs: [],
    relay: null,
    relayError: null,
    host: MP_HOST
  } : null
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
  state.chunk = {
    indexSha256: chunkDocuments.indexSha256 ?? null,
    level: chunkDocuments.levelBytes
      ? {
          file: '_work/e1-drive/level.geometry.json',
          bytes: chunkDocuments.levelBytes,
          sha256: chunkDocuments.levelSha256 ?? null
        }
      : null,
    base: chunkDocuments.baseBytes
      ? {
          file: '_work/e1-drive/base.geometry.json',
          bytes: chunkDocuments.baseBytes,
          sha256: chunkDocuments.baseSha256 ?? null
        }
      : null,
    mapPackage: state.map?.bytes?.package ?? 0,
    car: state.map?.carChunk ?? null,
    switch: state.carSwitch ?? null,
    policy: chunkDocuments.index?.policy ?? null
  };
  if (state.collisionProbe) {
    state.collisionProbe.resolved = { x: state.position[0], z: state.position[2] };
  }
  window.e1DriveProbe = state;
  const rows = [
    ['mode', state.mode + (state.hold === null ? '' : ' · hold ' + state.hold + (state.holdReached ? ' reached' : ''))],
    ['car', state.car ? state.car.name + ' · ' + state.car.drivetrain + ' · ' + Math.round(state.car.mass) + ' kg · rec ' + state.car.recordIndex : '—'],
    ['chunk', (state.chunk?.level ?? state.chunk?.base)?.bytes
      ? ((state.chunk.level ? 'level ' : 'base ') + (((state.chunk.level ?? state.chunk.base).bytes) / 1048576).toFixed(1) +
        ' MB' + (state.chunk.mapPackage ? ' + map ' + (state.chunk.mapPackage / 1048576).toFixed(1) + ' MB' : '') +
        ' + car ' + ((state.chunk.car?.bytes ?? 0) / 1048576).toFixed(2) + ' MB' +
        (state.chunk.switch ? ' · switch ' + state.chunk.switch.status +
          (state.chunk.switch.loadMs !== null ? ' ' + state.chunk.switch.loadMs + ' ms' : '') : ''))
      : 'loading'],
    ['audio', audioHudValue()]
  ];
  if (MAP_IS_PACKAGE && state.map) {
    const counts = state.map.counts ?? {};
    rows.push(['map', (state.map.label ?? MAP.label).toUpperCase() + ' · ' + state.map.level + ' measured path ' +
      (state.sprintLayout?.span?.measuredLengthMetres ?? 0).toFixed(3) +
      ' m · ' + counts.draws + ' opaque draws / ' + counts.drawTriangles + ' tri · ' +
      counts.textures + ' tex / ' + (counts.textureBytes ?? 0) + ' B']);
    rows.push(['layers', 'skipped: ' + counts.decalDraws + ' additive decals + ' + counts.diagnosticDraws +
      ' diagnostic draws · ' + counts.blockedDraws + ' blocked total · ' + counts.collisionTriangles +
      ' collision tri (simple shapes excluded)']);
  }
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
      rows.push(['course', MAP_IS_PACKAGE
        ? (MAP_IS_AMBOY ? 'USA Amboy' : MAP_IS_GRACIA ? 'Barcelona Gracia' : MAP.label) +
          ' measured path · ' + (course.measuredLengthMetres ?? course.lengthMetres).toFixed(3) +
          ' m · ?map=' + MAP.id
        : COURSE_IS_LAP
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
  if (state.mp?.enabled) {
    const mp = state.mp;
    rows.push(['mp', 'M1 · room ' + (mp.room?.code ?? '—') + ' · ' + mp.phase +
      ' · ' + (mp.host ? 'host' : 'guest') + ' · slot ' + (mp.you?.slot ?? '—') +
      (mp.requestedCodeMismatch ? ' · requested ' + mp.requestedCode : '')]);
    rows.push(['mp net', 'ping ' + (mp.ping === null ? '—' : mp.ping.toFixed(1)) + ' ms · state seq ' +
      mp.sent.state + '/' + mp.applied.state + ' · input ' + mp.sent.input + '/' + mp.applied.input +
      ' · corrections ' + mp.remote.corrections + ' (' + mp.remote.hardSets + ' hard, ' +
      mp.remote.blends + ' blend)']);
    rows.push(['mp remote', mp.remote.name
      ? mp.remote.name + ' · tick ' + (mp.remote.tick ?? '—') +
        ' · Δ ' + (mp.remote.distance === null ? '—' : mp.remote.distance.toFixed(3) + ' m') +
        ' · ' + (mp.remote.connected === false ? 'DISCONNECTED' : 'connected') +
        ' · interpolated, no collision'
      : 'waiting for the other player']);
    if (mp.validation) {
      rows.push(['mp host', 'RaceSession ' + (mp.validation.sessionPhase ?? '—') +
        ' · guest ' + (mp.validation.guestStatus ?? '—') +
        ' · host finish ' + (mp.validation.hostFinishTick ?? '—') +
        ' · guest reported ' + (mp.validation.guestReportedTick ?? '—') +
        ' · projected Δ ' + (mp.validation.guestDetectionDeltaTicks ?? '—') +
        (mp.validation.guestReportAccepted ? ' · report accepted (open race)' : ' · report rejected')]);
    }
    if (mp.result) rows.push(['mp result', 'shared table ' + mp.result.hash.slice(7, 23) + '… · ' +
      mp.result.rows.map((row) => 'P' + row.positionNumber + ' ' + row.name +
        (row.timeSeconds === null ? ' DNF' : ' ' + row.timeSeconds.toFixed(3) + ' s')).join(' · ')]);
  }
  if (state.powerups?.enabled) {
    const hud = mpPowerupHudModel();
    const local = hud?.local ?? null;
    const item = local?.inventory?.[0] ?? null;
    rows.push(['powerups', 'Mine/Shield/Repair · ' + (state.powerups.phase ?? 'loading') +
      ' · health ' + (local ? local.health + '/' + local.maxHealth : '—') +
      ' · slot ' + (item ? item.type : 'empty') +
      ' · shield ' + (hud?.shield ? hud.shield.capacity + '/' + hud.shield.maxCapacity +
        ' ' + hud.shield.secondsLeft.toFixed(2) + ' s' : 'none') +
      (state.powerups.wrecked ? ' · WRECKED' : '') +
      (state.powerups.relayError ? ' · relay ' + state.powerups.relayError : '')]);
    rows.push(['pwr events', 'seq ' + ((state.powerups.lastEvents.at(-1)?.seq) ?? 0) +
      ' · ' + Object.entries(state.powerups.counts).map(([type, count]) => type + ' ' + count).join(' · ')]);
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
  publishMpOverlays();
  publishPowerupHud();
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
function publishSprintOverlays() {  const ghostTag = document.getElementById('ghost-tag');
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

  if (MP) {
    // The M1 result is the shared room table, rendered by publishMpOverlays().
    if (!state.mp?.result) results.hidden = true;
    return;
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

/**
 * M1 lobby, remote tag and shared result overlay. Presentation only: the room
 * service owns the roster/ready/start state and the host result is the shared
 * table built from `room.finished`.
 */
function publishMpOverlays() {
  const lobby = document.getElementById('mp-lobby');
  if (!lobby) return;
  document.documentElement.dataset.mp = state.mp?.enabled ? state.mp.phase : 'off';
  if (!state.mp?.enabled) {
    lobby.hidden = true;
    const tag = document.getElementById('remote-tag');
    if (tag) tag.hidden = true;
    const mpResults = document.getElementById('mp-results');
    if (mpResults) mpResults.hidden = true;
    return;
  }
  const mp = state.mp;
  const lobbyVisible = mp.phase === 'connecting' || mp.phase === 'loading' || mp.phase === 'lobby' ||
    mp.phase === 'starting' || mp.phase === 'error';
  lobby.hidden = !lobbyVisible;

  const setText = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  setText('mp-room-code', mp.room?.code ?? '—');
  setText('mp-name', mp.name + (mp.you ? ' · P' + mp.you.slot : ''));
  setText('mp-role', mp.host ? 'host (authoritative result)' : 'guest (sends input + 20 Hz state)');
  const phaseLabel = mp.phase === 'connecting' ? 'connecting to the room service…'
    : mp.phase === 'loading' ? 'loading the room map package…'
      : mp.phase === 'lobby' ? (mp.engineReady ? (mp.mapReady ? 'in the lobby · map verified' : 'verifying the room map…') : 'loading the engine…')
        : mp.phase === 'starting' ? 'race starting…'
          : mp.phase === 'reconnecting' ? 'RECONNECTING — the room keeps the slot for 30 s'
            : mp.phase === 'error' ? 'error'
              : mp.phase;
  setText('mp-connection', phaseLabel);
  setText('mp-lobby-status', mp.status ?? phaseLabel);
  setText('mp-map-status', mpMapStatusText());
  const mapSelect = document.getElementById('mp-map');
  if (mapSelect) {
    if (!mapSelect.options.length) {
      for (const id of MP_MAP_IDS) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = MAPS[id].label + ' · ' + MAPS[id].level;
        mapSelect.append(option);
      }
    }
    mapSelect.value = mp.map?.id ?? mp.room?.map ?? 'river';
    mapSelect.disabled = !mp.host || mp.phase !== 'lobby' || mp.started;
    mapSelect.title = mp.host
      ? 'host map selection (both clients verify the package before READY)'
      : 'the host selects the room map';
  }
  const roster = state.roster?.roster?.cars ?? [];
  const carSelect = document.getElementById('mp-car');
  if (carSelect && roster.length && carSelect.options.length !== roster.length) {
    carSelect.textContent = '';
    for (const entry of roster) {
      const option = document.createElement('option');
      option.value = entry.slug;
      option.textContent = carLabel(entry);
      carSelect.append(option);
    }
  }
  const selfRow = mp.room?.players?.find((player) => player.id === mp.you?.id);
  if (carSelect && selfRow) carSelect.value = selfRow.car;

  const list = document.getElementById('mp-players');
  if (list) {
    list.textContent = '';
    const players = [...(mp.room?.players ?? [])].sort((a, b) => a.slot - b.slot);
    for (const player of players) {
      const row = document.createElement('div');
      row.className = 'mp-player';
      const you = player.id === mp.you?.id ? ' (you)' : '';
      const host = player.host ? '<span class="mp-host">HOST</span>' : '';
      const ready = player.ready ? '<span class="mp-ready-on">READY</span>' : '<span class="mp-ready-off">not ready</span>';
      const down = player.connected === false ? '<span class="mp-down">DISCONNECTED</span>' : '';
      row.innerHTML = 'P' + player.slot + ' · ' + escapeHtml(player.name) + you + ' · ' +
        escapeHtml(player.car) + host + ready + down;
      list.append(row);
    }
  }

  const readyButton = document.getElementById('mp-ready');
  if (readyButton) {
    const ready = selfRow?.ready === true;
    readyButton.textContent = ready ? 'CANCEL READY' : 'READY';
    readyButton.disabled = mp.phase !== 'lobby' || !mp.engineReady || !mp.mapReady;
    readyButton.dataset.ready = ready ? '1' : '0';
  }
  // AI roster (M4): the host edits count + per-AI car/profile; the guest sees the
  // same records read-only. Labels are `AI · profile`.
  const ai = mp.ai;
  const aiCountSelect = document.getElementById('mp-ai-count');
  const aiList = document.getElementById('mp-ai-list');
  const aiRecords = ai?.host ? (ai.players ?? []) : (ai?.remotePlayers ?? []);
  if (aiCountSelect) {
    aiCountSelect.value = String(ai?.count ?? 0);
    aiCountSelect.disabled = !mp.host || mp.phase !== 'lobby' || mp.started;
  }
  if (aiList) {
    for (let index = 0; index < MP_AI_MAX; index++) {
      const row = document.getElementById('mp-ai-row-' + (index + 1));
      if (!row) continue;
      const record = aiRecords[index] ?? null;
      row.hidden = index >= (ai?.count ?? 0);
      const carSelect = document.getElementById('mp-ai-car-' + (index + 1));
      const profileSelect = document.getElementById('mp-ai-profile-' + (index + 1));
      const name = document.getElementById('mp-ai-name-' + (index + 1));
      if (carSelect && record) carSelect.value = record.car;
      if (profileSelect && record) profileSelect.value = record.profile;
      if (name) {
        name.textContent = record
          ? 'AI ' + (index + 1) + ' · ' + record.profile + (record.carName ? ' · ' + record.carName : '')
          : 'AI ' + (index + 1);
      }
      if (carSelect) carSelect.disabled = !mp.host || mp.phase !== 'lobby' || mp.started;
      if (profileSelect) profileSelect.disabled = !mp.host || mp.phase !== 'lobby' || mp.started;
    }
  }
  setText('mp-ai-status', ai && ai.count > 0
    ? (ai.errors?.length
      ? 'AI refused' + (ai.errorCodes?.length ? ' (' + ai.errorCodes.map((entry) => entry.code).join(',') + ')' : '') +
        ': ' + ai.errors.join('; ')
      : ai.relayError
        ? 'AI relay error: ' + ai.relayError
        : ai.count + ' AI · ' + (aiRosterReady(ai) ? 'records built · host simulates' : 'waiting for the host records'))
    : ai?.relayError ? 'AI relay error: ' + ai.relayError : 'AI off');
  const startButton = document.getElementById('mp-start');
  if (startButton) {
    const players = mp.room?.players ?? [];
    const connected = players.filter((player) => player.connected !== false);
    const aiCount = mp.ai?.count ?? 0;
    // A host + AI is a valid race: AI are not room players, so at least one
    // connected human plus enough participants (humans + AI) is required.
    const allReady = connected.length >= 1 && connected.length + aiCount >= 2 &&
      connected.every((player) => player.ready);
    startButton.hidden = !mp.host;
    startButton.disabled = !(mp.phase === 'lobby' && mp.engineReady && mp.mapReady && allReady &&
      aiRosterReady(mp.ai));
    startButton.dataset.enabled = startButton.disabled ? '0' : '1';
  }
  setText('mp-server-note', 'room service ' + mp.url + ' · ' +
    (mp.requestedCodeMismatch
      ? 'requested ' + mp.requestedCode + '; allocated ' + (mp.room?.code ?? '—') + ' (codes are not reservable)'
      : mp.host ? 'share ?mp=1&room=' + (mp.room?.code ?? 'CODE') + ' with the second player'
        : 'joined ' + (mp.room?.code ?? '—') + ' as guest'));

  const tag = document.getElementById('remote-tag');
  if (tag) {
    const visible = mp.remote.latest !== null && mp.phase !== 'connecting' && mp.phase !== 'lobby' && mp.phase !== 'error';
    // With AI in the room the multi-line `#mp-remotes` list labels every remote
    // car, including the human peer; the single M1 tag would overlap it.
    tag.hidden = !visible || (ai?.count ?? 0) > 0;
    tag.dataset.state = mp.remote.connected === false ? 'reconnecting' : 'connected';
    tag.textContent = visible
      ? 'REMOTE · ' + (mp.remote.name ?? 'other player') +
        (mp.remote.connected === false ? ' · RECONNECTING (labelled, no guessed pose)' : '') +
        ' · 20 Hz snapshot · no collision'
      : '';
  }
  const remotes = document.getElementById('mp-remotes');
  if (remotes) {
    const show = mp.phase === 'running' || mp.phase === 'finished' || mp.phase === 'finished-local';
    const lines = [];
    if (show && mp.remote.latest && (ai?.count ?? 0) > 0) {
      lines.push('REMOTE · ' + (mp.remote.name ?? 'other player') +
        (mp.remote.connected === false ? ' · RECONNECTING' : '') + ' · 20 Hz snapshot · no collision');
    }
    if (show && ai?.count > 0) {
      const entries = ai.remotes ?? [];
      if (entries.length) {
        for (const entry of entries) {
          lines.push((entry.label ?? aiLabel(entry)) + ' · ' + (entry.name ?? entry.id) +
            (entry.car ? ' · ' + entry.car : '') +
            (entry.latestTick === null ? ' · waiting for the 20 Hz pose' : ' · 20 Hz host relay · no collision'));
        }
      } else {
        for (const record of aiRecords) {
          lines.push((record.profile ? 'AI · ' + record.profile : aiLabel(record)) + ' · ' + record.name +
            ' · ' + (record.car ?? '') + ' · waiting for the host relay');
        }
      }
    }
    remotes.hidden = lines.length === 0;
    remotes.textContent = lines.join('\n');
  }

  const results = document.getElementById('results');
  const mpResults = document.getElementById('mp-results');
  if (results && mpResults) {
    if (mp.result) {
      results.hidden = false;
      const heading = results.querySelector('h2');
      if (heading) heading.textContent = 'RACE RESULT';
      const hint = results.querySelector('.hint');
      if (hint) hint.textContent = 'M1 room result — restart is not available in a room (M2)';
      const winner = mp.result.rows.find((row) => row.playerId === mp.result.winnerId) ?? mp.result.rows[0];
      document.getElementById('results-time').textContent = winner
        ? 'P' + winner.positionNumber + ' · ' + winner.name + ' · ' +
          (winner.timeSeconds === null ? 'DNF' : winner.timeSeconds.toFixed(3) + ' s')
        : '—';
      document.getElementById('results-best').textContent =
        'room ' + (mp.room?.code ?? '—') + ' · shared table ' + mp.result.hash.slice(7, 23) + '… · ' +
        'host ' + (mp.room?.players?.find((player) => player.host)?.name ?? '—');
      mpResults.hidden = false;
      mpResults.textContent = '';
      const head = document.createElement('div');
      head.className = 'mp-result-row mp-result-head';
      head.innerHTML = '<span>#</span><span>player</span><span>time</span>';
      mpResults.append(head);
      for (const row of mp.result.rows) {
        const line = document.createElement('div');
        line.className = 'mp-result-row';
        line.dataset.player = row.playerId;
        line.innerHTML = '<span class="mp-result-pos">' + row.positionNumber + '</span>' +
          '<span class="mp-result-name">' + escapeHtml(row.name) +
          (row.host ? ' <span class="mp-result-host">HOST</span>' : '') +
          (row.ai ? ' <span class="mp-result-ai">AI</span>' +
            (row.profile ? ' <span class="mp-result-profile">' + escapeHtml(row.profile) + '</span>' : '') : '') +
          '</span>' +
          '<span class="mp-result-time' + (row.status === 'dnf' ? ' mp-result-dnf' : '') + '">' +
          (row.status === 'dnf' ? 'DNF' : row.timeSeconds.toFixed(3) + ' s') + '</span>';
        mpResults.append(line);
      }
    } else {
      mpResults.hidden = true;
      if (mp.phase !== 'reconnecting') results.hidden = true;
    }
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
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
  if ((event.key === 'e' || event.key === 'E') && POWERUPS && MP && !event.repeat) {
    // Host-authoritative power-up use: the host applies it; the guest sends an
    // intent and never judges the effect locally.
    mpPowerupRequestUse();
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
  mpPowerupRelayStop();
  mpAiRelayStop();
  if (mpNet) { try { mpNet.close(); } catch {} }
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

// M2/PWR2 power-up state (host model, client view and the project-specific relay).
let powerupManifest = null;
let powerupProjectileManifest = null;
let powerupProjectileModel = null;
let powerupEngine = null;
let powerupModel = null;
let powerupView = null;
let powerupRelay = null;
let powerupBroadcastSeq = 0;
let powerupLastEventSeq = 0;
let powerupLastBroadcastAt = 0;
let powerupPendingBatch = null;
let powerupRelayTimer = null;
// Logical race tick = local engine tick + accumulated rebuild offset. A power-up
// wreck rebuilds the car (e1_create/e1_reset) and resets the engine tick; the
// offset keeps the 20 Hz snapshot and the M1 finish report monotonic.
let mpEngineTickOffset = 0;

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

// ------------------------------------------------------------------ multiplayer
// The M1 room client, the local slot/grid, the shared result builder and the
// one remote-car display slot. `mpRaceRules` holds the dynamically imported
// `probes/race-rules` module so a page without the route still loads the
// single-player modes unchanged.
let mpNet = null;
let mpRaceRules = null;
let mpRace = null;
let mpSessionCar = null;
let mpSlot = null;
let mpSettledTick0 = null;
let mpStarted = false;
let mpFrameStarted = false;
let mpLastState = null;
let mpLocalHistory = new Map();
let mpRemoteDisplay = null;
let mpRemotePlayerId = null;
let mpRemoteCar = null;
let mpRemoteCarPromise = null;
let mpRemoteCarSlug = null;
let mpResult = null;
let mpFinishHash = null;
let mpLastStatsAt = 0;
let mpRemoteFinished = null;
// M4 AI opponents: host simulation (one wasm instance per AI) and guest remote
// display set. `mpAiSim` is host-only; a guest never creates an AI engine.
let mpAiSim = null;
let mpAiRemoteSet = null;
let mpAiRelayState = null;
let mpAiResultPosted = false;
let mpAiFinishPending = null;
let mpInterpolationBuffer = null;
const MP_AI_TINT = Object.freeze([0.95, 0.66, 0.18]);
const mpAiFieldCache = new Map();
// Room map agreement: one serialized load per room map, so a host switch cannot
// interleave two wasm/world loads. `mpRequestedMapId` is the latest target.
let mpMapLoadState = null;
let mpRequestedMapId = null;

/** The record measured from the bytes this page actually loaded. */
function mpActualMapRecord() {
  if (!state.map) return null;
  return {
    id: MAP.id,
    label: MAP.label,
    level: MAP.level,
    packageHash: state.map.hash ?? null,
    layoutHash: state.sprintLayoutHash ?? state.map.layoutHash ?? null,
    physicsHash: state.map.physicsSha256 ?? null,
    packageFileSha256: state.map.packageFileSha256 ?? null,
    layoutFileSha256: state.map.layoutFileSha256 ?? null,
    physicsFileSha256: state.map.physicsSha256 ?? null,
    packageBytes: state.map.bytes?.package ?? null,
    layoutBytes: state.map.bytes?.layout ?? null,
    physicsBytes: state.map.bytes?.physics ?? null,
    loadMs: state.map.loadMs ?? null,
    source: 'measured-bytes'
  };
}

/** Compact map status string for the lobby overlay and the capture probe. */
function mpMapStatusText() {
  const map = state.mp?.map;
  if (!map) return 'map not loaded';
  const short = (hash) => (typeof hash === 'string' ? hash.slice(7, 19) + '…' : '—');
  if (map.status === 'loading') {
    return 'loading ' + map.id + ' · ' + (map.label ?? '') +
      (map.expectedBytes ? ' · ' + (map.expectedBytes / 1048576).toFixed(1) + ' MB' : '') + '…';
  }
  if (map.status === 'refused') {
    return 'REFUSED ' + (map.code ?? MP_MAP_MISMATCH) + ': ' + (map.error ?? 'map record mismatch');
  }
  return map.id + ' · verified · package ' + short(map.packageHash) +
    ' · layout ' + short(map.layoutHash) + ' · physics ' + short(map.physicsHash) +
    (Number.isFinite(map.loadMs) ? ' · ' + Math.round(map.loadMs) + ' ms' : '') +
    (map.bytes?.total ? ' · ' + (map.bytes.total / 1048576).toFixed(1) + ' MB loaded' : '');
}

/**
 * Load the room's selected map package, measure its hashes and compare them
 * with the committed registry record. `map-ready` is reported by the caller
 * (`state.mp.mapReady`), and only then may the page set the room ready flag.
 */
async function mpDoLoadRoomMap(id, { carSlug = null } = {}) {
  const expected = mpMapRecord(id);
  const expectedBytes = (expected.packageBytes ?? 0) + (expected.layoutBytes ?? 0) +
    (expected.physicsBytes ?? 0);
  state.mp.map = {
    ...expected,
    status: 'loading',
    expectedBytes,
    expected,
    actual: null,
    loadMs: null
  };
  state.mp.mapReady = false;
  state.mp.mapError = null;
  state.mp.engineReady = false;
  state.mp.phase = 'loading';
  state.mp.status = 'loading ' + expected.label + ' (' + (expectedBytes / 1048576).toFixed(1) + ' MB)…';
  publish();
  const startedAt = performance.now();
  try {
    applyActiveMap(id);
    if (POWERUPS && id !== 'river') {
      throw new MpMapError(MP_MAP_MISMATCH,
        'power-ups are River-only in this gate; ' + expected.label + ' has no placed pickups');
    }
    const tick0 = await loadEngine(carSlug ?? state.mp.sessionCar ?? REQUESTED_CAR ?? null);
    if (mpRequestedMapId !== id) return null;
    mpSettledTick0 = tick0;
    mpSessionCar = car.slug;
    state.mp.sessionCar = mpSessionCar;
    state.mp.engineReady = true;
    const actual = mpActualMapRecord();
    const check = compareMpMapRecords(expected, actual);
    const loadMs = performance.now() - startedAt;
    if (!check.ok) {
      const error = new MpMapError(MP_MAP_MISMATCH,
        'map package mismatch for ' + expected.label + ': ' +
        check.mismatches.map((row) => row.field + ' expected ' + row.expected + ', loaded ' + row.actual).join('; '),
        check);
      state.mp.map = { ...expected, ...actual, expected, actual, status: 'refused',
        code: MP_MAP_MISMATCH, error: error.message, mismatches: check.mismatches, loadMs };
      state.mp.mapError = { code: MP_MAP_MISMATCH, message: error.message, mismatches: check.mismatches };
      state.mp.mapReady = false;
      state.mp.phase = 'error';
      state.mp.status = 'map refused: ' + error.message;
      throw error;
    }
    state.mp.map = {
      ...expected,
      ...actual,
      expected,
      actual,
      status: 'ready',
      code: null,
      error: null,
      mismatches: [],
      loadMs,
      bytes: state.map.bytes ?? null,
      startedAt
    };
    state.mp.mapReady = true;
    state.mp.phase = 'lobby';
    state.mp.status = expected.label + ' map verified; press READY';
    return state.mp.map;
  } catch (error) {
    if (mpRequestedMapId === id && state.mp.map?.status !== 'refused') {
      state.mp.map = {
        ...(state.mp.map ?? expected),
        status: 'refused',
        code: error.code ?? MP_MAP_MISMATCH,
        error: error.message,
        loadMs: performance.now() - startedAt
      };
      state.mp.mapError = { code: error.code ?? MP_MAP_MISMATCH, message: error.message };
      state.mp.mapReady = false;
      state.mp.engineReady = false;
    }
    throw error;
  } finally {
    publish();
  }
}

/** Serialise room-map loads; a newer target queues behind the current load. */
function mpEnsureRoomMap(id, options = {}) {
  const target = normalizeMpMapId(id);
  if (!target) return Promise.reject(new MpMapError('MAP_UNKNOWN', 'room did not publish a map id'));
  mpRequestedMapId = target;
  const previous = mpMapLoadState?.promise ?? Promise.resolve();
  const promise = previous.catch(() => {}).then(() => {
    if (mpRequestedMapId !== target) return null;
    if (!options.force && state.mp.map?.status === 'ready' && state.mp.map.id === target) return state.mp.map;
    return mpDoLoadRoomMap(target, options);
  });
  mpMapLoadState = { id: target, promise };
  return promise.finally(() => {
    if (mpMapLoadState?.promise === promise) mpMapLoadState = null;
  });
}

/** After a room map switch, both clients must re-verify before they can ready. */
function mpMapChangedInLobby(roomMapId) {
  if (!state.mp || mpStarted || !roomMapId) return;
  const loadedId = state.mp.map?.id ?? null;
  if (loadedId === roomMapId && state.mp.map?.status === 'ready') return;
  if (loadedId === roomMapId && state.mp.map?.status === 'loading') return;
  if (loadedId === roomMapId && state.mp.map?.status === 'refused' &&
      state.mp.map?.code === MP_MAP_MISMATCH) return;
  if (state.mp.ready) {
    state.mp.ready = false;
    mpNet?.setReady(false).catch(() => {});
  }
  state.mp.mapReady = false;
  state.mp.status = 'room map changed to ' + roomMapId + '; reloading…';
  publish();
  mpEnsureRoomMap(roomMapId, { carSlug: state.mp.sessionCar ?? null }).catch((error) => {
    const code = error.code ?? MP_MAP_MISMATCH;
    state.mp.mapError = { code, message: error.message };
    state.mp.phase = 'error';
    state.mp.status = 'map refused (' + code + '): ' + error.message;
    publish();
  });
}

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
  // Switching a car is an in-place reload of the engine/session from the already
  // cached level and the selected car chunk. The page is not reloaded, and no
  // other car body is fetched or drawn.
  select.onchange = () => {
    switchCarInPlace(select.value).catch((error) => {
      state.carSwitch = { ...(state.carSwitch ?? {}), status: 'error', error: error.message,
        code: error.code ?? null };
      fail(error.message);
    });
  };
}

let carSwitchPromise = null;
/** Rebuild the engine/session for another roster car without reloading the page. */
async function switchCarInPlace(slug) {
  if (!slug || slug === car?.slug) return null;
  if (MP) {
    fail('the session car is fixed for an online room; reopen with ?car=' + slug);
    return null;
  }
  if (carSwitchPromise) return carSwitchPromise;
  const from = car.slug;
  const startedAt = performance.now();
  state.consumer = 'loading';
  state.carSwitch = { from, to: slug, status: 'loading', loadMs: null, error: null, code: null };
  publish();
  carSwitchPromise = (async () => {
    try {
      // Preflight the selected car chunk before touching the live engine/module:
      // a missing or mismatched chunk is a typed error and the current car keeps
      // running unchanged.
      const index = await loadChunkIndexDocument();
      const preflight = await loadCarChunkDocument(index, slug);
      state.carSwitch.carChunk = {
        slug: preflight.body.slug,
        file: preflight.file,
        bytes: preflight.bytes,
        sha256: preflight.sha256,
        cached: true
      };
      publish();
      const tick0 = await loadEngine(slug);
      holdReached = HOLD === null ? false : HOLD === 0;
      const tick1 = await startTimeline(tick0, { reload: true });
      applyState(tick1);
      state.ticksExecuted = 0;
      state.carSwitches = (state.carSwitches ?? 0) + 1;
      driver.reset(performance.now() * 1000);
      const next = new URLSearchParams(location.search);
      if (slug === state.roster.roster.default) next.delete('car');
      else next.set('car', slug);
      next.delete('hold');
      const query = next.toString();
      history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
      state.carSwitch = {
        from,
        to: slug,
        status: 'ready',
        loadMs: +(performance.now() - startedAt).toFixed(1),
        carChunk: state.map?.carChunk ?? null,
        error: null,
        code: null
      };
      state.consumer = 'running';
      publish();
      return tick1;
    } catch (error) {
      // A preflight failure happens before the live engine/module is touched, so
      // the current car is still running; keep reporting it as running and only
      // the typed switch record changes. A failure after the engine rebuild is a
      // page error.
      const liveCarKept = !state.carSwitch?.carChunk;
      state.carSwitch = {
        from,
        to: slug,
        status: 'error',
        loadMs: +(performance.now() - startedAt).toFixed(1),
        carChunk: null,
        error: error.message,
        code: error.code ?? null
      };
      state.consumer = liveCarKept ? 'running' : 'error';
      throw error;
    } finally {
      carSwitchPromise = null;
    }
  })();
  return carSwitchPromise;
}

/**
 * Race-rules projection of a committed layout. The released rules layer only
 * accepts `310m`/`lap`; a package layout is a point-to-point sprint, so it uses
 * the equivalent `310m` mode while keeping the original samples, gates and hash.
 * `verifyLayoutHash:false` is set at the call sites because the hash is the
 * original package layout hash, not a re-hash of the projected id.
 */
function mpRulesLayout(layout) {
  if (!layout) return layout;
  if (layout.courseId === '310m' || layout.courseId === 'lap') return layout;
  return { ...layout, sourceCourseId: layout.courseId, courseId: '310m' };
}

/** Measured start tangent, normalised; fall back to the first path segment. */
function mpGridTangent(layout) {
  const gate = layout?.gates?.[0];
  let tx = gate?.tangent?.tx;
  let tz = gate?.tangent?.tz;
  if (!Number.isFinite(tx) || !Number.isFinite(tz) || Math.hypot(tx, tz) < 1e-9) {
    const a = layout?.course?.samples?.[0];
    const b = layout?.course?.samples?.[1];
    if (a && b) {
      tx = b.x - a.x;
      tz = b.z - a.z;
    }
  }
  const length = Math.hypot(tx ?? 0, tz ?? 0);
  if (!(length > 0)) throw new Error('multiplayer grid has no measured start tangent');
  return { tx: tx / length, tz: tz / length };
}

/**
 * Longitudinal grid derived from the map's measured spawn and path tangent.
 * Slot 1 is one row ahead of the measured spawn; slot 2 is the spawn itself.
 * The measured start line and solo spawn are not moved. Offsets are candidate
 * rows; the real-engine probe below picks the first pair whose ground is valid.
 */
function mpAlongPathGrid(layout, offsetMetres) {
  const spawn = layout.course.spawn;
  const tangent = mpGridTangent(layout);
  const slot1Arc = offsetMetres;
  return [
    {
      slot: 1,
      x: Math.round((spawn.x + tangent.tx * offsetMetres) * 1e6) / 1e6,
      z: Math.round((spawn.z + tangent.tz * offsetMetres) * 1e6) / 1e6,
      y: courseGroundAt(layout, slot1Arc),
      headingRad: spawn.headingRad,
      offsetMetres,
      source: 'measured spawn + path tangent (longitudinal)'
    },
    {
      slot: 2,
      x: spawn.x,
      z: spawn.z,
      y: spawn.ground ?? courseGroundAt(layout, 0),
      headingRad: spawn.headingRad,
      offsetMetres: 0,
      source: 'measured spawn (longitudinal grid)'
    }
  ];
}

/**
 * Probe one slot with the real wasm engine and the sprint rules: create the
 * measured world at the pose, step through the countdown and 50 running ticks,
 * and reject an airborne/off-course respawn. The final race world is created
 * after this probe, so probing changes nothing at start.
 */
function mpProbeGridSlot(layout, slot) {
  const probeRules = createSprintRules(layout);
  let state0;
  try {
    state0 = createWorld(slot.x, slot.z, slot.headingRad);
  } catch (error) {
    return { slot: slot.slot, x: slot.x, z: slot.z, ok: false,
      reason: 'no-ground', error: error.message };
  }
  probeRules.prime(state0);
  let current = state0;
  for (let tick = 1; tick <= 140; tick++) {
    module._e1_set_input(0, 0, 0, 0);
    module._e1_step();
    current = readState();
    const events = probeRules.step(current);
    const respawn = events.find((event) => event.type === SPRINT_EVENT.RESPAWN);
    if (respawn) {
      return { slot: slot.slot, x: slot.x, z: slot.z, ok: false,
        reason: (respawn.reasons ?? ['respawn']).join(','), tick: current.tick,
        y: current.position[1] };
    }
    if (probeRules.awaitingRejoin) {
      return { slot: slot.slot, x: slot.x, z: slot.z, ok: false,
        reason: 'awaiting-rejoin', tick: current.tick, y: current.position[1] };
    }
  }
  return { slot: slot.slot, x: slot.x, z: slot.z, ok: true, tick: current.tick,
    y: current.position[1], contacts: current.contacts.join('') };
}

/**
 * Choose a grounded two-car grid. River/Amboy keep the released lateral grid
 * when both slots probe clean; a package map whose lateral slot is airborne
 * (Gracia slot 1) falls back to measured-spawn longitudinal slots. The choice
 * is deterministic on both pages and fails explicitly if no pair is grounded.
 */
function mpChooseMpGrid(layout) {
  const model = new mpRaceRules.CourseModel(mpRulesLayout(layout), { verifyLayoutHash: false });
  const lateral = model.startGrid(MP_MAX_PLAYERS, MP_GRID_OPTIONS);
  const candidates = [
    { source: 'race-rules provisional lateral grid', options: { ...MP_GRID_OPTIONS }, slots: lateral }
  ];
  for (const offset of [2.2, 1.1, 3.3, 4.4, 5.0]) {
    candidates.push({
      source: 'measured spawn + path tangent (longitudinal)',
      options: { longitudinalOffsetMetres: offset },
      slots: mpAlongPathGrid(layout, offset)
    });
  }
  const cache = new Map();
  const probe = (slot) => {
    const key = slot.slot + ':' + slot.x.toFixed(4) + ':' + slot.z.toFixed(4);
    if (!cache.has(key)) cache.set(key, mpProbeGridSlot(layout, slot));
    return cache.get(key);
  };
  const tried = [];
  for (const candidate of candidates) {
    const probes = candidate.slots.map(probe);
    const ok = probes.every((entry) => entry.ok);
    tried.push({ source: candidate.source, options: candidate.options, ok,
      slots: candidate.slots.map((slot) => ({ slot: slot.slot, x: slot.x, z: slot.z })),
      probes });
    if (ok) return { ...candidate, probes, tried };
  }
  throw new Error('multiplayer start grid has no grounded slot pair: ' +
    tried.map((row) => row.source + ' ' + row.probes.map((p) => p.reason ?? 'ok').join('/')).join('; '));
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

/** Verified chunk documents, cached for the page lifetime (no streaming pass). */
const chunkDocuments = {
  index: null,
  indexSha256: null,
  level: null,
  levelBytes: null,
  levelSha256: null,
  base: null,
  baseBytes: null,
  baseSha256: null,
  cars: new Map()
};

// Non-geometry load inputs are also immutable for a page lifetime (and for a
// car switch): keep the physics bytes, roster, per-car fields and layout text so
// switching a car fetches only its car chunk plus the fresh wasm instance.
const assetCache = {
  roster: null,
  physicsUrl: null,
  physicsBytes: null,
  fields: new Map(),
  spawn: new Map(),
  sprint: new Map(),
  packages: new Map(),
  sources: new Map()
};

function cachedResponse(bytes, text) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => {
      if (!bytes) throw new Error('cached response has no byte body');
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    text: async () => text,
    json: async () => JSON.parse(text)
  };
}

async function fetchChunkBytes(url, label, missingCode) {
  let response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch (error) {
    throw new ChunkLoadError(missingCode, label + ' fetch failed: ' + error.message, { url });
  }
  if (!response.ok) {
    throw new ChunkLoadError(missingCode, label + ' fetch failed: HTTP ' + response.status, { url, status: response.status });
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function loadChunkIndexDocument() {
  if (chunkDocuments.index) return chunkDocuments.index;
  if (!CAR_INDEX_URL) throw new ChunkLoadError(CHUNK_ERROR.INDEX_MISSING, 'this map has no chunk index URL');
  const bytes = await fetchChunkBytes(CAR_INDEX_URL, 'car-bodies.index.json', CHUNK_ERROR.INDEX_MISSING);
  const text = new TextDecoder().decode(bytes);
  const index = parseChunkIndex(text);
  chunkDocuments.index = index;
  chunkDocuments.indexSha256 = await bytesSha256(bytes);
  return index;
}

async function loadLevelChunkDocument(index) {
  if (chunkDocuments.level) return chunkDocuments.level;
  const bytes = await fetchChunkBytes(LEVEL_GEOMETRY_URL, 'level.geometry.json', CHUNK_ERROR.LEVEL_MISSING);
  verifyChunkBytes(bytes, index.level, 'level', {
    schema: CHUNK_ERROR.LEVEL_SCHEMA, bytes: CHUNK_ERROR.LEVEL_BYTES
  });
  chunkDocuments.levelSha256 = await verifyChunkSha(bytes, index.level, 'level', bytesSha256, {
    sha: CHUNK_ERROR.LEVEL_SHA
  });
  chunkDocuments.levelBytes = bytes.byteLength;
  chunkDocuments.level = parseLevelChunk(new TextDecoder().decode(bytes));
  return chunkDocuments.level;
}

async function loadBaseChunkDocument(index) {
  if (chunkDocuments.base) return chunkDocuments.base;
  if (!BASE_GEOMETRY_URL) throw new ChunkLoadError(CHUNK_ERROR.BASE_MISSING, 'this map has no base geometry URL');
  const bytes = await fetchChunkBytes(BASE_GEOMETRY_URL, 'base.geometry.json', CHUNK_ERROR.BASE_MISSING);
  verifyChunkBytes(bytes, index.base, 'base', {
    schema: CHUNK_ERROR.BASE_SCHEMA, bytes: CHUNK_ERROR.BASE_BYTES
  });
  chunkDocuments.baseSha256 = await verifyChunkSha(bytes, index.base, 'base', bytesSha256, {
    sha: CHUNK_ERROR.BASE_SHA
  });
  chunkDocuments.baseBytes = bytes.byteLength;
  chunkDocuments.base = parseBaseChunk(new TextDecoder().decode(bytes));
  return chunkDocuments.base;
}

async function loadCarChunkDocument(index, slug) {
  const entry = index.cars?.[slug];
  if (!entry) {
    throw new ChunkLoadError(CHUNK_ERROR.CAR_UNKNOWN,
      'car ' + JSON.stringify(slug) + ' is not in the chunk index; available: ' +
      Object.keys(index.cars ?? {}).join(', '));
  }
  const cached = chunkDocuments.cars.get(slug);
  if (cached && cached.sha256 === entry.sha256) return cached;
  const url = new URL(entry.file, new URL(CAR_INDEX_URL, location.href)).pathname;
  const bytes = await fetchChunkBytes(url, 'car chunk ' + slug, CHUNK_ERROR.CAR_MISSING);
  verifyChunkBytes(bytes, entry, 'car ' + slug, {
    schema: CHUNK_ERROR.CAR_SCHEMA, bytes: CHUNK_ERROR.CAR_BYTES
  });
  const sha256 = await verifyChunkSha(bytes, entry, 'car ' + slug, bytesSha256, {
    sha: CHUNK_ERROR.CAR_SHA
  });
  const body = parseCarChunk(new TextDecoder().decode(bytes), index, slug);
  const record = { body, bytes: bytes.byteLength, sha256, file: entry.file, url };
  chunkDocuments.cars.set(slug, record);
  return record;
}

async function loadEngine(carOverride = null) {
  const loadStartedAt = performance.now();
  const factory = (await import(ENGINE_MODULE)).default;
  engineFactory = factory;
  module = await factory();
  const roster = assetCache.roster ?? await loadRoster();
  assetCache.roster = roster;
  car = resolveCar(roster, carOverride ?? REQUESTED_CAR);
  state.roster = roster;
  state.car = carIdentity(car);
  populateSelector(roster, car);

  const index = await loadChunkIndexDocument();
  const carChunkPromise = loadCarChunkDocument(index, car.slug);
  const cachedPackage = MAP_IS_PACKAGE ? assetCache.packages.get(GEOMETRY_URL) ?? null : null;
  const packagePromise = MAP_IS_PACKAGE
    ? (cachedPackage ?? fetchChunkBytes(GEOMETRY_URL, MAP.label + ' map package', CHUNK_ERROR.LEVEL_MISSING))
    : loadLevelChunkDocument(index);
  const basePromise = MAP_IS_PACKAGE ? loadBaseChunkDocument(index) : Promise.resolve(null);

  const fieldsKey = fieldsUrl(car);
  const cachedLevel = assetCache.physicsUrl === LEVEL_URL ? assetCache.physicsBytes : null;
  const cachedFields = assetCache.fields.get(fieldsKey) ?? null;
  const cachedSpawn = SPAWN_URL ? assetCache.spawn.get(SPAWN_URL) ?? null : null;
  const cachedSprint = (SPRINT_MODE || SOAK) ? assetCache.sprint.get(SPRINT_URL) ?? null : null;

  const [packageValue, levelResponse, fieldsResponse, spawnResponse, sprintResponse, baseDocument] = await Promise.all([
    packagePromise,
    cachedLevel ? Promise.resolve(cachedResponse(cachedLevel)) : fetch(LEVEL_URL, { cache: 'no-store' }),
    cachedFields ? Promise.resolve(cachedResponse(cachedFields)) : fetch(fieldsKey, { cache: 'no-store' }),
    SPAWN_URL
      ? (cachedSpawn ? Promise.resolve(cachedResponse(cachedSpawn.bytes, cachedSpawn.text)) : fetch(SPAWN_URL, { cache: 'no-store' }))
      : Promise.resolve(null),
    (SPRINT_MODE || SOAK)
      ? (cachedSprint ? Promise.resolve(cachedResponse(cachedSprint.bytes, cachedSprint.text)) : fetch(SPRINT_URL, { cache: 'no-store' }))
      : Promise.resolve(null),
    basePromise
  ]);
  const responses = [['level', levelResponse], ['car fields (' + car.slug + ')', fieldsResponse]];
  if (spawnResponse) responses.push(['spawn', spawnResponse]);
  for (const [label, response] of responses) {
    if (!response.ok) throw new Error(label + ' fetch failed: HTTP ' + response.status);
  }
  // Map mode fetches the map package; the River path fetches the level chunk.
  // Both are pinned by their committed identity/index entry.
  if (MAP_IS_PACKAGE && !cachedPackage) assetCache.packages.set(GEOMETRY_URL, packageValue);
  const packageBytesLength = MAP_IS_PACKAGE ? packageValue.byteLength : chunkDocuments.levelBytes;
  const packageSha = MAP_IS_PACKAGE ? await bytesSha256(packageValue) : chunkDocuments.levelSha256;
  const packageText = MAP_IS_PACKAGE ? new TextDecoder().decode(packageValue) : null;
  levelBytes = cachedLevel ?? new Uint8Array(await levelResponse.arrayBuffer());
  fieldBytes = cachedFields ?? new Uint8Array(await fieldsResponse.arrayBuffer());
  if (!cachedLevel) {
    assetCache.physicsUrl = LEVEL_URL;
    assetCache.physicsBytes = levelBytes;
  }
  if (!cachedFields) assetCache.fields.set(fieldsKey, fieldBytes);
  const physicsSha = await bytesSha256(levelBytes);
  const carChunk = await carChunkPromise;
  const sprintTextValue = (SPRINT_MODE || SOAK)
    ? (cachedSprint?.text ?? await sprintResponse.text())
    : null;
  if ((SPRINT_MODE || SOAK) && !cachedSprint) {
    const bytes = new TextEncoder().encode(sprintTextValue);
    assetCache.sprint.set(SPRINT_URL, { bytes, text: sprintTextValue });
  }

  let geometryBytes = packageBytesLength;
  let baseGeometryBytes = MAP_IS_PACKAGE ? chunkDocuments.baseBytes : 0;

  let preloadedLayout = null;
  let layoutText = null;
  let sourceBytes = 0;
  if (MAP_IS_PACKAGE) {
    // Package pins for the map document, layout, source render/slice and the
    // Level.levelphysics bytes. A mismatch is a hard failure: no fallback map.
    const mapDocument = JSON.parse(packageText);
    if (!sprintResponse?.ok) {
      throw new Error(MAP.label + ' layout fetch failed: HTTP ' + (sprintResponse?.status ?? 'missing') +
        ' — run `node probes/e1-drive/tools/build_map_' + MAP.id + '.mjs`');
    }
    layoutText = sprintTextValue;
    const mapLayout = JSON.parse(layoutText);
    const packageCheck = validateMapPackage(mapDocument, mapLayout, MAP.pins);
    if (!packageCheck.ok) throw new Error(MAP.label + ' map package rejected: ' + packageCheck.errors.join('; '));
    if (textSha256(layoutText) !== MAP.pins.layoutFileSha256) {
      throw new Error(MAP.label + ' layout file does not match its pinned SHA-256');
    }
    if (physicsSha !== MAP.pins.physicsFileSha256) {
      throw new Error(MAP.level + ' Level.levelphysics does not match its pinned SHA-256 (' + physicsSha + ')');
    }
    // The map document names its source packages; fetch and hash them so the page
    // verifies the actual package bytes, not only the recorded identity. They are
    // cached by path: a car switch in the same map does not re-download them.
    const renderPath = mapDocument.source.render.path;
    const slicePath = mapDocument.source.slice.path;
    let renderBytes = assetCache.sources.get(renderPath) ?? null;
    let sliceBytes = assetCache.sources.get(slicePath) ?? null;
    if (!renderBytes || !sliceBytes) {
      const [renderSource, sliceSource] = await Promise.all([
        renderBytes ? Promise.resolve(null) : fetch('/' + renderPath, { cache: 'no-store' }),
        sliceBytes ? Promise.resolve(null) : fetch('/' + slicePath, { cache: 'no-store' })
      ]);
      if ((renderSource && !renderSource.ok) || (sliceSource && !sliceSource.ok)) {
        throw new Error('map-slice source package fetch failed: HTTP ' +
          (renderSource?.status ?? 200) + '/' + (sliceSource?.status ?? 200));
      }
      if (renderSource) renderBytes = new Uint8Array(await renderSource.arrayBuffer());
      if (sliceSource) sliceBytes = new Uint8Array(await sliceSource.arrayBuffer());
      assetCache.sources.set(renderPath, renderBytes);
      assetCache.sources.set(slicePath, sliceBytes);
    }
    sourceBytes = renderBytes.byteLength + sliceBytes.byteLength;
    const renderSha = await bytesSha256(renderBytes);
    const sliceSha = await bytesSha256(sliceBytes);
    if (renderSha !== MAP.pins.renderFileSha256) throw new Error('render.json does not match its pinned SHA-256');
    if (sliceSha !== MAP.pins.sliceFileSha256) throw new Error('slice.json does not match its pinned SHA-256');
    // The base document carries only materials/light/camera/roster; the map
    // package replaces the level half and the selected car chunk the vehicle.
    geometry = assembleGeometry(
      mergeMapGeometry(baseDocument, mapDocument, { id: MAP.id, label: MAP.label, level: MAP.level }),
      carChunk.body,
      { index });
    // The committed spawn artifact is River-specific; the map spawn is the
    // measured layout's first point and tangent.
    spawn = {
      x: mapLayout.course.spawn.x,
      z: mapLayout.course.spawn.z,
      heading: mapLayout.course.spawn.headingRad,
      source: mapLayout.source.spawnSource
    };
    preloadedLayout = mapLayout;
    state.map = {
      id: MAP.id,
      label: MAP.label,
      level: MAP.level,
      hash: mapDocument.hash,
      layoutHash: mapLayout.hash,
      packageFileSha256: packageSha,
      layoutFileSha256: textSha256(layoutText),
      physicsSha256: physicsSha,
      carChunk: {
        slug: carChunk.body.slug,
        file: carChunk.file,
        sha256: carChunk.sha256,
        bytes: carChunk.bytes
      },
      source: mapDocument.source,
      counts: mapDocument.counts,
      limits: mapDocument.mapRender.limits,
      bytes: {
        package: geometryBytes,
        baseGeometry: baseGeometryBytes,
        carChunk: carChunk.bytes,
        layout: layoutText.length,
        physics: levelBytes.byteLength,
        carFields: fieldBytes.byteLength,
        renderSource: sourceBytes,
        total: geometryBytes + baseGeometryBytes + carChunk.bytes + layoutText.length +
          levelBytes.byteLength + fieldBytes.byteLength + sourceBytes
      }
    };
  } else {
    geometry = assembleGeometry(packageValue, carChunk.body, { index });
    const spawnText = cachedSpawn?.text ?? await spawnResponse.text();
    spawn = JSON.parse(spawnText);
    if (!cachedSpawn) assetCache.spawn.set(SPAWN_URL, { text: spawnText });
    state.map = {
      id: MAP.id,
      label: MAP.label,
      level: MAP.level,
      hash: packageSha,
      packageFileSha256: packageSha,
      physicsSha256: physicsSha,
      carChunk: {
        slug: carChunk.body.slug,
        file: carChunk.file,
        sha256: carChunk.sha256,
        bytes: carChunk.bytes
      },
      bytes: {
        package: geometryBytes,
        baseGeometry: 0,
        carChunk: carChunk.bytes,
        layout: 0,
        physics: levelBytes.byteLength,
        carFields: fieldBytes.byteLength,
        renderSource: 0,
        total: geometryBytes + carChunk.bytes + levelBytes.byteLength + fieldBytes.byteLength
      }
    };
    state.map.layoutFileSha256 = null;
  }
  state.map.loadMs = performance.now() - loadStartedAt;

  let tick0;
  if (SPRINT_MODE || SOAK) {
    if (!sprintResponse.ok) {
      throw new Error('sprint layout fetch failed: HTTP ' + sprintResponse.status +
        ' — run `node probes/e1-drive/tools/build_sprint.mjs` (or `node tools/verify_e1_drive.mjs` first)');
    }
    const layout = preloadedLayout ?? await (async () => {
      layoutText = sprintTextValue;
      return JSON.parse(layoutText);
    })();
    if (state.map?.bytes && !state.map.bytes.layout && layoutText) {
      state.map.bytes.layout = layoutText.length;
      state.map.bytes.total += layoutText.length;
    }
    if (state.map && !state.map.layoutFileSha256 && layoutText) {
      state.map.layoutFileSha256 = textSha256(layoutText);
    }
    if (MAP_IS_PACKAGE) {
      // The map layout is validated above against the map package pins. Its
      // gates are measured path stations, so the River geometry re-derivation
      // (drawn/collision triangle coverage) does not apply.
    } else {
      const checked = validateSprintLayout(layout, geometry, spawn);
      if (!checked.ok) throw new Error('sprint layout rejected: ' + checked.errors.join('; '));
    }
    if (!COLLISION_PROBE) sprintRules = createSprintRules(layout, {
      shortCourseController: car?.shortCourseController ?? null
    });
    soakLayout = layout;
    state.sprintLayoutHash = layout.hash;
    state.sprintCourseId = layout.courseId ?? null;
    if (state.map) state.map.layoutHash = layout.hash;
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
    const pins = (SOAK || MAP_IS_PACKAGE) ? null : propPinsForCourse(COURSE_PARAM);
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
    state.sprintBest = MP ? null : bestTimes.bestFor(car.slug);
    if (MP) {
      // The one remote slot reuses the ghost draw path in M1, so the single-player
      // replay is explicitly off (no silent sharing of the slot). The same car's
      // wheel rest matrices are the remote car's rest matrices.
      ghost = { record: null, decoded: null, table: null, source: 'none', label: null,
        reason: 'multiplayer uses the single remote-car slot; ghost replay is off', note: null };
      ghostEnabled = false;
      const remoteBody = geometry.carBodies[car.slug];
      if (!remoteBody) throw new Error('geometry has no body for ' + car.slug);
      ghostWheelRest = Object.fromEntries(remoteBody.wheelGroups.map((group) =>
        [group.corner, group.matrixColumnMajor]));
    } else if (MAP_IS_PACKAGE) {
      // No committed map reference ghost exists; a River trace would be a
      // wrong pose on this map. The HUD states why instead of guessing one.
      ghost = { record: null, decoded: null, table: null, source: 'none', label: null,
        reason: 'no committed ' + MAP.level + ' reference ghost; River traces are not reusable on this map', note: null };
      ghostEnabled = false;
    } else {
      // Ghost / rival replay: the stored best run, or the committed deterministic
      // reference trace. `?ghost=1` shows it from the start; otherwise `G` toggles.
      await loadGhost(storage);
      ghostEnabled = GHOST_REQUESTED && ghost.record !== null;
    }
    // The 310 m course starts on the measured tangent of its start gate; the
    // 29 m regression course keeps the committed drive spawn heading; the lap
    // starts on P61 loop-01's own point and tangent (component 5). The soak
    // schedule runs drive/telemetry segments whose node anchors were recorded
    // at the legacy spawn heading, so its shared world keeps that heading.
    let start = layoutStartPosition(layout, spawn);
    if (MP && mpRaceRules) {
      // Provisional race-rules grid. River/Amboy keep the released lateral grid
      // when both slots probe clean; Gracia slot 1 is airborne on that lateral
      // pose, so the measured spawn/tangent longitudinal grid is used instead.
      // Each slot is probed with the real engine before the final race world is
      // created; the measured start line and solo spawn are not moved.
      const chosen = mpChooseMpGrid(layout);
      const grid = chosen.slots;
      const index = Math.max(0, Math.min(grid.length - 1, (mpSlot ?? 1) - 1));
      const slot = grid[index];
      start = { x: slot.x, z: slot.z, heading: slot.headingRad, headingRad: slot.headingRad,
        source: chosen.source };
      state.mp.grid = {
        slot: slot.slot,
        x: slot.x,
        z: slot.z,
        headingRad: slot.headingRad,
        source: chosen.source,
        options: chosen.options,
        slots: grid.map((entry) => ({ slot: entry.slot, x: entry.x, z: entry.z,
          y: entry.y ?? null, headingRad: entry.headingRad, offsetMetres: entry.offsetMetres ?? null,
          source: entry.source })),
        probes: chosen.probes,
        tried: chosen.tried.map((row) => ({ source: row.source, options: row.options, ok: row.ok,
          probes: row.probes }))
      };
    }
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
      tick0 = createWorld(start.x, start.z, SOAK ? spawn.heading : (start.heading ?? start.headingRad));
    }
  } else {
    tick0 = createWorld(spawn.x, spawn.z, spawn.heading);
  }

  engine = {
    info: JSON.parse(module.UTF8ToString(module._e1_info())),
    setInput: (input) => module._e1_set_input(input[0], input[1], input[2], input[3]),
    boostQueue: (kind, startTick, ticks, targetMps, magnitude, dx = 0, dy = 0, dz = 0) =>
      (typeof module._e1_boost_queue === 'function'
        ? module._e1_boost_queue(kind, startTick, ticks, targetMps, magnitude, dx, dy, dz)
        : 0),
    boostState: () => {
      if (typeof module._e1_boost_state !== 'function') return null;
      try { return JSON.parse(module.UTF8ToString(module._e1_boost_state())); } catch { return null; }
    },
    boostLastError: () => (typeof module._e1_last_error === 'function'
      ? module.UTF8ToString(module._e1_last_error()) : 'no e1 module'),
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
  if (!state.map) {
    state.map = { id: MAP.id, label: MAP.label, level: MAP.level };
  }
  state.mapCounts = state.map.counts ?? null;
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
  if (MP && POWERUPS && state.powerups?.wrecked) return [0, 1, 0, 0];
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
  if (SCRIPTED_SPRINT) return sprintScriptInput(sprintRules, session?.lastState ?? null, MP_CONTROL);
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
      // Single-player best times are not part of the M1 authority: the shared
      // result table is. Skipping the localStorage write also avoids the two
      // capture pages (same browser origin) overwriting each other's best.
      let submitted = { best: null, previous: null, improved: false, persistent: false };
      if (!MP && bestTimes) {
        submitted = bestTimes.submit(car.slug, {
          seconds: event.timeSeconds,
          car: car.name,
          checkpoints: event.laps ?? event.checkpoints,
          respawns: sprintRules.respawns
        });
      }
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
      if (MP) mpLocalFinish(event);
      else if (!MAP_IS_PACKAGE) recordGhostFinish(event);
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
    // M1/PWR2 logical race tick: the rebuild resets the engine tick, so carry
    // the elapsed local ticks in the offset used by the 20 Hz snapshot and the
    // finish report. The car rebuild itself is unchanged.
    if (MP) {
      mpEngineTickOffset += state.engineTick + 1;
      mpLocalHistory = new Map();
    }
    const tick0 = createWorld(target.x, target.z, target.heading);
    const tick1 = await startTimeline(tick0, { reload: true, rejoin: true });
    applyState(tick1);
    driveEngineAudio();
    holdReached = HOLD !== null && HOLD <= tick1.tick ? true : holdReached;
    state.ticksExecuted = 0;
    if (state.powerups) {
      state.powerups.wrecked = false;
      state.powerups.notice = 'respawned at the race-rules target';
    }
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
    ? (MAP_IS_PACKAGE ? MAP_PACKET_SCRIPT
      : COURSE_IS_LAP ? LAP_PACKET_SCRIPT : COURSE_IS_FREE ? FREE_PACKET_SCRIPT : SPRINT_PACKET_SCRIPT)
    : undefined
} = {}) {
  const start = collisionProbeStart
    ? { x: collisionProbeStart.x, z: collisionProbeStart.z, headingRad: collisionProbeStart.headingRad,
      source: 'P74 collision-v2 capture probe (manifest-derived pose)' }
    : MP && state.mp?.grid
      ? { x: state.mp.grid.x, z: state.mp.grid.z, headingRad: state.mp.grid.headingRad,
        source: 'race-rules provisional start grid' }
      : sprintRules ? layoutStartPosition(sprintRules.layout, spawn) : spawn;
  session = createSession(geometry, tick0, {
    spawn: { x: start.x, z: start.z, headingRad: start.headingRad ?? start.heading,
      source: start.source ?? (sprintRules?.layout?.source?.spawnSource ?? spawn.source ?? 'probes/e1-drive/tools/spawn.mjs') },
    car: state.car,
    script: packetScript === null ? undefined : packetScript,
    camera: Object.keys(CAMERA_OVERRIDE).length ? CAMERA_OVERRIDE : undefined
  });
  if (POWERUPS) attachPowerupMarkerGeometry(session.packet);
  if (MP) {
    // Reserve one ghost-pipeline slot per remote car (human peer + AI). The peer
    // may drive a different roster car, so the band is sized for the roster
    // maximum from the chunk index. With no AI this block still declares the
    // human slot; the single-player packet is untouched.
    const aiSlots = Math.max(0, Math.min(MP_AI_MAX,
      state.mp?.ai?.count ?? state.mp?.ai?.remotePlayers?.length ?? 0));
    session.packet.diagnostics = session.packet.diagnostics ?? {};
    session.packet.diagnostics.extras = session.packet.diagnostics.extras ?? {};
    session.packet.diagnostics.extras.remotes = {
      slots: 1 + aiSlots,
      drawSlots: geometry.chunk?.carDrawSlots ?? session.packet.diagnostics.extras.parts?.drawCount ?? 0,
      source: 'host-relayed poses; each peer draws its own car chunk; clients never simulate AI',
      aiSlots,
      perPlayerCar: true
    };
    state.mp.remotes = { ...session.packet.diagnostics.extras.remotes };
  }
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
    sprintRules = createSprintRules(soakLayout, {
      shortCourseController: car?.shortCourseController ?? null
    });
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

// ------------------------------------------------------------------ multiplayer
// M1 room flow. The host is the rules/result authority; both clients simulate
// their own car with the real wasm engine and send 20 Hz state (60 Hz inputs).
// The host feeds both cars into `RaceSession` for ordered checkpoints/finish
// validation. HUD numbers and the shared result table come from this block only.

/** E1-shaped network state from an engine snapshot. */
function mpNetworkState(snapshot) {
  return {
    tick: snapshot.tick + mpEngineTickOffset,
    position: [snapshot.position[0], snapshot.position[1], snapshot.position[2]],
    quaternion: quaternionFromAxes(snapshot.axisX, snapshot.axisY, snapshot.axisZ),
    speed: snapshot.speed,
    // The peer's car is part of the room roster (the committed net-mvp state
    // quantizer keeps only tick/position/quaternion/speed, so this additive field
    // is informational; the page reads the roster car for the chunk).
    car: car?.slug ?? null
  };
}

/** Keep a short local state history for the capture's remote-pose comparison. */
function mpRememberState(snapshot) {
  const tick = snapshot.tick + mpEngineTickOffset;
  mpLocalHistory.set(tick, {
    tick,
    position: [snapshot.position[0], snapshot.position[1], snapshot.position[2]],
    quaternion: quaternionFromAxes(snapshot.axisX, snapshot.axisY, snapshot.axisZ),
    speed: snapshot.speed
  });
  while (mpLocalHistory.size > 5000) mpLocalHistory.delete(mpLocalHistory.keys().next().value);
}

function mpHistoryAt(tick) {
  return mpLocalHistory.get(tick) ?? null;
}

/** Update HUD counters from the transport stats; throttled to 4 Hz. */
function mpUpdateStats(force = false) {
  if (!mpNet || !state.mp) return;
  const now = performance.now();
  if (!force && now - mpLastStatsAt < 250) return;
  mpLastStatsAt = now;
  const stats = mpNet.stats();
  state.mp.ping = stats.rtt.state.p50 ?? stats.rtt.control.p50 ?? null;
  state.mp.sent = { ...stats.sent };
  state.mp.received = { ...stats.received };
  let stateApplied = 0;
  let inputApplied = 0;
  for (const stream of stats.streams) {
    if (stream.channel === 'state') stateApplied += stream.lastApplied;
    else inputApplied += stream.lastApplied;
  }
  state.mp.applied = { state: stateApplied, input: inputApplied };
  const remote = stats.streams.find((stream) => stream.channel === 'state');
  if (remote) {
    const latest = mpNet.latestRemote(remote.from);
    if (latest) {
      state.mp.remote.latest = latest;
      state.mp.remote.tick = latest.tick;
      state.mp.remote.authority = latest.authority === true;
      state.mp.remote.seq = latest.seq;
    }
  }
  const remotePlayer = mpNet.remotePlayer();
  if (remotePlayer) {
    state.mp.remote.id = remotePlayer.id;
    state.mp.remote.name = remotePlayer.name;
    state.mp.remote.slot = remotePlayer.slot;
    state.mp.remote.car = remotePlayer.car;
    state.mp.remote.connected = remotePlayer.connected !== false;
    if (mpRemotePlayerId === null) mpRemotePlayerId = remotePlayer.id;
  }
}

// ------------------------------------------------------------------ AI opponents
// The host owns the AI roster and simulation. Each AI is a separate wasm module
// instance (the module has one global world), stepped by the committed AI
// driver at the same fixed 60 Hz tick as the human cars. The guest receives only
// the host's 20 Hz poses and final rows through `/_mp-ai/relay`; it never runs an
// AI engine.

function mpAiRelayReady() {
  return Boolean(mpAiRelayState && mpAiRelayState.room && mpAiRelayState.playerId);
}

function mpAiRelayPost(kind, payload) {
  if (!mpAiRelayReady()) return Promise.reject(new Error('AI relay is not ready'));
  return fetch(MP_AI_RELAY_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      room: mpAiRelayState.room,
      from: mpAiRelayState.playerId,
      kind,
      payload
    })
  }).then(async (response) => {
    if (!response.ok) throw new Error('AI relay HTTP ' + response.status + ': ' + (await response.text()).slice(0, 160));
    return response.json();
  });
}

function mpAiRelayStart(room, playerId) {
  if (!state.mp?.ai) return;
  mpAiRelayState = { room, playerId, cursor: 0, polling: false, host: MP_HOST };
  state.mp.ai.relay = { room, playerId, role: MP_HOST ? 'host' : 'guest',
    pollMs: MP_AI_RELAY_POLL_MS, endpoint: MP_AI_RELAY_PATH };
  if (MP_HOST) return;
  if (!state.mp.ai.relayTimer) {
    state.mp.ai.relayTimer = setInterval(() => { void mpAiRelayPoll(); }, MP_AI_RELAY_POLL_MS);
    void mpAiRelayPoll();
  }
}

function mpAiRelayStop() {
  if (state.mp?.ai?.relayTimer) clearInterval(state.mp.ai.relayTimer);
  if (state.mp?.ai) state.mp.ai.relayTimer = null;
}

async function mpAiRelayPoll() {
  if (!mpAiRelayState || mpAiRelayState.host || mpAiRelayState.polling) return;
  mpAiRelayState.polling = true;
  if (state.mp?.ai) state.mp.ai.relayPolling = true;
  try {
    const params = new URLSearchParams({
      room: mpAiRelayState.room,
      after: String(mpAiRelayState.cursor ?? 0),
      exclude: mpAiRelayState.playerId
    });
    const response = await fetch(MP_AI_RELAY_PATH + '?' + params.toString(), { cache: 'no-store' });
    if (!response.ok) throw new Error('AI relay HTTP ' + response.status);
    const data = await response.json();
    if (Number.isInteger(data.next) && data.next > mpAiRelayState.cursor) mpAiRelayState.cursor = data.next;
    if (state.mp?.ai) state.mp.ai.relayCursor = mpAiRelayState.cursor;
    for (const message of data.messages ?? []) {
      if (message.kind === 'roster') mpAiApplyRoster(message.payload);
      else if (message.kind === 'pose') mpAiApplyPoses(message.payload);
      else if (message.kind === 'result') mpAiApplyResult(message.payload);
    }
    if (state.mp?.ai) state.mp.ai.relayError = null;
  } catch (error) {
    if (state.mp?.ai) state.mp.ai.relayError = error.message;
  } finally {
    mpAiRelayState.polling = false;
    if (state.mp?.ai) state.mp.ai.relayPolling = false;
  }
}

/** Build the host's AI records from the committed roster. */
function mpBuildAiRecords() {
  if (!state.mp?.ai || !MP_HOST) return state.mp?.ai ?? null;
  const ai = state.mp.ai;
  const built = buildAiRoster(state.roster, {
    count: ai.count,
    cars: ai.cars,
    profiles: ai.profiles,
    firstSlot: 3,
    mapId: MAP.id
  });
  ai.mapId = MAP.id;
  ai.players = built.players;
  ai.built = built.built;
  ai.ready = aiRosterReady(built);
  ai.errors = built.errors;
  ai.errorCodes = built.errorCodes ?? [];
  if (!built.built) {
    ai.status = 'AI roster rejected: ' + built.errors.join('; ');
  }
  return ai;
}

/** Host-only lobby mutation; guests can read the roster but not change it. */
function mpSetAi(config = {}) {
  if (!state.mp?.ai) throw new Error('AI opponents are a multiplayer setting');
  if (!MP_HOST) throw new Error('only the host configures AI opponents');
  if (mpStarted) throw new Error('AI opponents are fixed when the race starts');
  const ai = state.mp.ai;
  if (config.count !== undefined) ai.count = Number(config.count);
  if (config.cars !== undefined) ai.cars = Array.isArray(config.cars) ? config.cars.join(',') : String(config.cars);
  if (config.profiles !== undefined) {
    ai.profiles = Array.isArray(config.profiles) ? config.profiles.join(',') : String(config.profiles);
  }
  mpBuildAiRecords();
  mpAiPublishRoster();
  publish();
  return aiSummary(ai);
}

function mpAiPublishRoster() {
  if (!MP_HOST || !state.mp?.ai || !mpAiRelayReady()) return Promise.resolve(null);
  const payload = { ai: aiSummary(state.mp.ai), tick: state.engineTick ?? 0 };
  return mpAiRelayPost('roster', payload).catch((error) => {
    if (state.mp.ai) state.mp.ai.relayError = error.message;
    return null;
  });
}

function mpAiApplyRoster(payload) {
  if (!state.mp?.ai || !payload?.ai) return;
  const incoming = payload.ai;
  const count = Number(incoming.count);
  if (!Number.isInteger(count) || count < 0 || count > MP_AI_MAX) return;
  const records = Array.isArray(incoming.records) ? incoming.records : [];
  if (records.length !== count) return;
  const ai = state.mp.ai;
  ai.count = count;
  ai.mapId = incoming.mapId ?? ai.mapId ?? null;
  ai.errorCodes = incoming.errorCodes ?? [];
  ai.errors = incoming.errors ?? [];
  ai.remotePlayers = records.map((record) => ({
    id: record.id,
    slot: record.slot,
    name: record.name,
    car: record.car,
    carName: record.carName ?? null,
    profile: record.profile,
    speedScale: record.speedScale ?? null,
    ai: true
  }));
  ai.players = ai.remotePlayers;
  ai.built = incoming.built === true;
  ai.ready = incoming.ready === true;
  if (mpStarted && state.mp.ai.count > 0) mpEnsureAiRemoteSet();
  publish();
}

function mpAiApplyPoses(payload) {
  if (!state.mp?.ai || !payload) return;
  if (mpStarted && !mpAiRemoteSet) mpEnsureAiRemoteSet();
  const applied = mpAiRemoteSet ? mpAiRemoteSet.applyPose(payload) : 0;
  if (state.mp.ai) {
    state.mp.ai.poseTick = payload.tick ?? null;
    state.mp.ai.poseCount += applied;
  }
}

function mpAiApplyResult(payload) {
  if (!state.mp?.ai || !payload || !Array.isArray(payload.rows)) return;
  state.mp.ai.result = payload;
  state.mp.ai.resultHash = payload.hash ?? null;
  if (Array.isArray(payload.players) && payload.players.length) {
    state.mp.ai.remotePlayers = payload.players.map((player) => ({ ...player, ai: true }));
  }
  mpTryApplyResult();
}

function mpEnsureAiRemoteSet() {
  if (!state.mp?.ai || !state.mp.ai.count) return;
  const players = state.mp.ai.remotePlayers.length
    ? state.mp.ai.remotePlayers : state.mp.ai.players;
  if (!players.length) return;
  const key = players.map((player) => player.id + ':' + player.car + ':' + player.profile).join('|');
  if (mpAiRemoteSet && mpAiRemoteSet.rosterKey === key) return;
  const InterpolationBuffer = mpInterpolationBuffer;
  if (!InterpolationBuffer) return;
  mpAiRemoteSet = new AiRemoteSet({
    players,
    InterpolationBuffer,
    delayTicks: MP_REMOTE_DELAY_TICKS
  });
  mpAiRemoteSet.rosterKey = key;
  state.mp.ai.remotes = mpAiRemoteSet.snapshot();
}

/** Fetch one AI car's decoded field bytes once per page. */
async function mpAiFieldsFor(car) {
  if (mpAiFieldCache.has(car.slug)) return mpAiFieldCache.get(car.slug);
  const response = await fetch(fieldsUrl(car), { cache: 'no-store' });
  if (!response.ok) throw new Error('AI car fields fetch failed for ' + car.slug + ': HTTP ' + response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  mpAiFieldCache.set(car.slug, bytes);
  return bytes;
}

function mpAiReadState(mod) {
  return JSON.parse(mod.UTF8ToString(mod._e1_get_state()));
}

function mpAiCreateWorld(mod, fields, slot) {
  const levelPtr = mod._malloc(levelBytes.byteLength);
  const fieldsPtr = mod._malloc(fields.byteLength + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('AI wasm malloc failed');
  mod.HEAPU8.set(levelBytes, levelPtr);
  mod.HEAPU8.set(fields, fieldsPtr);
  const ok = mod._e1_create(levelPtr, levelBytes.byteLength, fieldsPtr, fields.byteLength,
    slot.x, slot.z, slot.headingRad ?? slot.heading ?? 0);
  mod._free(levelPtr);
  mod._free(fieldsPtr);
  if (!ok) throw new Error('AI e1_create failed at ' + slot.x + ',' + slot.z + ': ' +
    mod.UTF8ToString(mod._e1_last_error()));
  return mpAiReadState(mod);
}

function mpAiPathSlot(layout, offset, slot) {
  const spawn = layout.course.spawn;
  const tangent = mpGridTangent(layout);
  return {
    slot,
    x: Math.round((spawn.x + tangent.tx * offset) * 1e6) / 1e6,
    z: Math.round((spawn.z + tangent.tz * offset) * 1e6) / 1e6,
    y: courseGroundAt(layout, Math.max(0, offset)),
    headingRad: spawn.headingRad,
    offsetMetres: offset,
    source: 'measured spawn + path tangent (AI longitudinal)'
  };
}

/** Spawn-row lateral candidate (Gracia: forward/right of spawn has no ground). */
function mpAiPathLateralSlot(layout, offset, lateral, slot) {
  const spawn = layout.course.spawn;
  const tangent = mpGridTangent(layout);
  const nx = tangent.tz;
  const nz = -tangent.tx;
  return {
    slot,
    x: Math.round((spawn.x + tangent.tx * offset + nx * lateral) * 1e6) / 1e6,
    z: Math.round((spawn.z + tangent.tz * offset + nz * lateral) * 1e6) / 1e6,
    y: courseGroundAt(layout, Math.max(0, offset)),
    headingRad: spawn.headingRad,
    offsetMetres: offset,
    lateralMetres: lateral,
    source: 'measured spawn row lateral (AI grid)'
  };
}

/** Candidate AI poses, deterministic: the race-rules row first, then measured path offsets. */
function mpAiGridCandidates(layout, aiIndex, count, occupied = []) {
  const candidates = [];
  const nearOccupied = (slot) => occupied.some((row) =>
    Math.hypot((row.x ?? 0) - slot.x, (row.z ?? 0) - slot.z) < 2.0);
  const base = state.mp?.grid;
  if (base?.source && !base.source.includes('longitudinal')) {
    try {
      const model = new mpRaceRules.CourseModel(mpRulesLayout(layout), { verifyLayoutHash: false });
      const slots = model.startGrid(Math.max(2, 2 + count), MP_GRID_OPTIONS);
      const slot = slots[2 + aiIndex];
      if (slot && !nearOccupied(slot)) candidates.push({ ...slot, source: 'race-rules provisional lateral grid' });
    } catch { /* fall through to the measured path offsets */ }
  }
  // Start-row lateral slots. Gracia's measured spawn is the path start: behind
  // it has no ground, and starting far ahead (>=4.4 m) badly degrades the path
  // controller. A 2-2.8 m lateral offset on the spawn row is grounded and keeps
  // the AI on the same start line without sharing a human pose.
  for (const [offset, lateral] of [[2.2, -2.8], [0, -2.8], [2.2, 2.8], [0, 2.8],
    [2.2, -2.0], [0, -2.0], [2.2, 2.0], [0, 2.0]]) {
    const candidate = mpAiPathLateralSlot(layout, offset, lateral, 3 + aiIndex);
    if (nearOccupied(candidate)) continue;
    if (!candidates.some((row) => Math.abs(row.x - candidate.x) < 1e-6 && Math.abs(row.z - candidate.z) < 1e-6)) {
      candidates.push(candidate);
    }
  }
  // Forward/behind longitudinal rows are the last resort.
  const offsets = [2.2, 4.4, 8.8, 0, -2.2, -4.4, 11.0, 13.2];
  for (const offset of offsets) {
    const candidate = mpAiPathSlot(layout, offset, 3 + aiIndex);
    if (nearOccupied(candidate)) continue;
    if (!candidates.some((row) => Math.abs(row.x - candidate.x) < 1e-6 && Math.abs(row.z - candidate.z) < 1e-6)) {
      candidates.push(candidate);
    }
  }
  if (!candidates.length) {
    const fallback = mpAiPathSlot(layout, 2.2, 3 + aiIndex);
    candidates.push(fallback);
  }
  return candidates;
}

/** Real-engine probe of one AI slot (140 ticks, zero input, sprint rules). */
function mpAiProbeSlot(mod, layout, slot) {
  const rules = createSprintRules(layout);
  let state0;
  try {
    if (!(slot.fields instanceof Uint8Array)) throw new Error('AI probe slot has no field bytes');
    state0 = mpAiCreateWorld(mod, slot.fields, slot);
  } catch (error) {
    return { ok: false, reason: 'no-ground', error: error.message, slot };
  }
  rules.prime(state0);
  let current = state0;
  for (let tick = 1; tick <= 140; tick++) {
    mod._e1_set_input(0, 0, 0, 0);
    if (!mod._e1_step()) return { ok: false, reason: 'step-failed', slot };
    current = mpAiReadState(mod);
    const events = rules.step(current);
    const respawn = events.find((event) => event.type === SPRINT_EVENT.RESPAWN);
    if (respawn) return { ok: false, reason: (respawn.reasons ?? ['respawn']).join(','),
      tick: current.tick, y: current.position[1], slot };
    if (rules.awaitingRejoin) return { ok: false, reason: 'awaiting-rejoin', tick: current.tick, slot };
  }
  return { ok: true, tick: current.tick, contacts: current.contacts.join(''), slot };
}

/**
 * Create one wasm instance per AI at a grounded start pose. The page's own
 * module is untouched; `engineFactory()` returns an independent instance with
 * its own global world. Called by the host only, after the room start.
 */
async function mpAiStartHost() {
  if (!MP_HOST || !state.mp?.ai) return;
  const ai = state.mp.ai;
  mpBuildAiRecords();
  if (!aiRosterReady(ai)) {
    throw new Error('AI start refused: ' + (ai.errors.join('; ') || 'AI roster is not built'));
  }
  if (ai.count === 0) {
    ai.hostSim = { count: 0, sims: [] };
    return;
  }
  mpEnsureAiRemoteSet();
  const sims = [];
  const diagnostics = [];
  const occupied = (state.mp.grid?.slots ?? []).map((slot) => ({ x: slot.x, z: slot.z }));
  for (let index = 0; index < ai.players.length; index++) {
    const player = ai.players[index];
    const carEntry = resolveCar(state.roster, player.car);
    const fields = await mpAiFieldsFor(carEntry);
    const mod = await engineFactory();
    const candidates = mpAiGridCandidates(sprintRules.layout, index, ai.players.length, occupied);
    let chosen = null;
    let probe = null;
    for (const candidate of candidates) {
      // The probe helper reads the field bytes from the temporary slot handle.
      probe = mpAiProbeSlot(mod, sprintRules.layout, { ...candidate, fields });
      diagnostics.push({ id: player.id, candidate, ok: probe.ok, reason: probe.reason ?? null });
      if (probe.ok) { chosen = candidate; break; }
    }
    if (!chosen) {
      throw new Error('AI ' + player.id + ' has no grounded start slot; tried ' +
        candidates.length + ' candidates (' + diagnostics.filter((row) => row.id === player.id)
          .map((row) => row.reason ?? 'ok').join('/') + ')');
    }
    occupied.push({ x: chosen.x, z: chosen.z });
    const state0 = mpAiCreateWorld(mod, fields, chosen);
    const driver = createAiDriver({
      layout: sprintRules.layout,
      profile: player.profile,
      controlOverrides: aiControlOverrides(MAP.id)
    });
    driver.prime(state0);
    sims.push({
      player,
      car: carEntry,
      module: mod,
      fields,
      driver,
      state: state0,
      startSlot: chosen,
      ticks: 0,
      raceTicks: 0,
      hashes: [],
      finished: false,
      dnf: false,
      dnfReason: null,
      finish: null,
      finishRaceTick: null,
      stopped: false,
      respawns: 0,
      observerRespawns: 0,
      events: []
    });
  }
  mpAiSim = {
    count: sims.length,
    sims,
    grid: diagnostics,
    startedTick: state.engineTick,
    maxRaceTicks: (MAP_IS_PACKAGE ? 20000 : 3600)
  };
  ai.hostSim = mpAiSimSummary();
  mpAiPublishRoster();
  return mpAiSim;
}

function mpAiSimSummary(includeHashes = false) {
  if (!mpAiSim) return null;
  return {
    count: mpAiSim.count,
    grid: mpAiSim.grid,
    maxRaceTicks: mpAiSim.maxRaceTicks,
    sims: mpAiSim.sims.map((sim) => ({
      id: sim.player.id,
      profile: sim.player.profile,
      car: sim.player.car,
      startSlot: sim.startSlot ? { x: sim.startSlot.x, z: sim.startSlot.z,
        headingRad: sim.startSlot.headingRad, source: sim.startSlot.source } : null,
      ticks: sim.ticks,
      finished: sim.finished,
      finishRaceTick: sim.finishRaceTick,
      finishTimeSeconds: sim.finish?.timeSeconds ?? null,
      dnf: sim.dnf,
      dnfReason: sim.dnfReason,
      respawns: sim.respawns,
      observerRespawns: sim.observerRespawns,
      stateHashCount: sim.hashes.length,
      stateSequenceHash: includeHashes && sim.hashes.length
        ? 'sha256:' + sha256Hex(sim.hashes.join('\n')) : null
    }))
  };
}

/** Give one AI the race tick's input and step its own module once. */
function mpAiAdvanceOne(sim, hostTick) {
  const countdownTicks = sprintRules?.layout?.countdown?.ticks ?? 0;
  const raceTick = hostTick - countdownTicks;
  let input = [0, 0, 0, 0];
  if (raceTick > 0) {
    if (sim.finished || sim.dnf) input = [0, 1, 0, 0];
    else input = sim.driver.step(sim.state).input;
  }
  sim.module._e1_set_input(input[0], input[1], input[2], input[3]);
  if (!sim.module._e1_step()) {
    sim.dnf = true;
    sim.dnfReason = 'e1_step failed: ' + sim.module.UTF8ToString(sim.module._e1_last_error());
    return;
  }
  const next = mpAiReadState(sim.module);
  sim.state = next;
  sim.ticks++;
  sim.hashes.push(hashOf(next));
  if (raceTick > 0) {
    sim.raceTicks = raceTick;
    if (!sim.finished && !sim.dnf) {
      const events = sim.driver.observe(next, raceTick);
      if (events.length) sim.events.push(...events.slice(-4));
      const finish = events.find((event) => event.type === 'finish');
      if (finish) {
        sim.finished = true;
        sim.finish = finish;
        sim.finishRaceTick = raceTick;
      }
      const respawn = events.find((event) => event.type === 'respawn');
      if (respawn) sim.observerRespawns++;
    }
    if (!sim.finished && raceTick > mpAiSim.maxRaceTicks) {
      sim.dnf = true;
      sim.dnfReason = 'ai-tick-cap:' + mpAiSim.maxRaceTicks;
    }
    if (sim.finished && raceTick - sim.finishRaceTick >= 120) sim.stopped = true;
  }
  if (!sim.stopped) {
    mpAiRemoteSet?.applyPose({
      tick: hostTick,
      cars: [{
        id: sim.player.id,
        tick: hostTick,
        position: next.position.slice(),
        quaternion: quaternionFromAxes(next.axisX, next.axisY, next.axisZ),
        speed: next.speed
      }]
    });
  }
}

/** Host: advance every AI by one host tick, then broadcast the 20 Hz poses. */
function mpAiStep(hostTick) {
  if (!MP_HOST || !mpAiSim) return;
  for (const sim of mpAiSim.sims) {
    if (sim.stopped) continue;
    mpAiAdvanceOne(sim, hostTick);
  }
  if (state.mp?.ai) {
    state.mp.ai.hostSim = mpAiSimSummary();
    state.mp.ai.remotes = mpAiRemoteSet ? mpAiRemoteSet.snapshot() : [];
  }
  if (hostTick % MP_AI_POSE_EVERY_TICKS === 0) mpAiBroadcastPoses(hostTick);
}

function mpAiBroadcastPoses(hostTick) {
  if (!MP_HOST || !mpAiSim || !mpAiRelayReady() || !state.mp?.ai?.count) return;
  const cars = mpAiSim.sims.filter((sim) => !sim.stopped).map((sim) => ({
    id: sim.player.id,
    tick: hostTick,
    position: sim.state.position.map((value) => Math.round(value * 1e6) / 1e6),
    quaternion: quaternionFromAxes(sim.state.axisX, sim.state.axisY, sim.state.axisZ)
      .map((value) => Math.round(value * 1e6) / 1e6),
    speed: Math.round(sim.state.speed * 1e6) / 1e6
  }));
  if (!cars.length) return;
  mpAiRelayPost('pose', { tick: hostTick, cars }).catch((error) => {
    if (state.mp.ai) state.mp.ai.relayError = error.message;
  });
}

/** Rebuild one AI at a RaceSession respawn target and rejoin its progress row. */
function mpAiRespawn(sim, target) {
  const slot = {
    x: target?.x ?? sim.startSlot.x,
    z: target?.z ?? sim.startSlot.z,
    headingRad: target?.headingRad ?? sim.startSlot.headingRad
  };
  sim.state = mpAiCreateWorld(sim.module, sim.fields, slot);
  sim.driver.reprime(sim.state);
  sim.respawns++;
  sim.stopped = false;
  sim.finished = false;
  sim.finishRaceTick = null;
  try {
    mpRace.progress.rejoin(sim.player.id, mpRulesState(sim.player.id, sim.state), mpRace.raceTick);
  } catch { /* the progress row owns the contract; a typed failure is surfaced below */ }
  mpAiRemoteSet?.reset(sim.player.id);
  if (state.mp?.ai) {
    state.mp.ai.hostSim = mpAiSimSummary();
    state.mp.ai.remotes = mpAiRemoteSet ? mpAiRemoteSet.snapshot() : [];
  }
  return sim;
}

function mpAiAllTerminal() {
  const ai = state.mp?.ai;
  if (!ai || ai.count === 0) return true;
  if (!mpRace) return false;
  const rows = mpRace.snapshot().results.rows;
  return ai.players.every((player) => {
    const row = rows.find((entry) => entry.id === player.id);
    return row && ['finished', 'dnf', 'disconnected', 'left'].includes(row.status);
  });
}

function mpAiResultPayload() {
  const ai = state.mp?.ai;
  if (!ai || ai.count === 0 || !mpRace) return null;
  const countdownTicks = sprintRules?.layout?.countdown?.ticks ?? 0;
  // The page's RaceSession consumes one zero-tick loading step before the
  // engine timeline starts, so its race tick is the engine race tick minus one
  // (the same -1 diagnostic the M1 guest validation records). AI rows use the
  // human convention: engine tick includes the committed countdown.
  const rows = aiResultRows(mpRace.snapshot().results.rows, ai.players, countdownTicks, MP_TICK_HZ, 1);
  const payload = {
    kind: 'e1-drive.mp.ai-result',
    version: 1,
    count: ai.count,
    countdownTicks,
    players: ai.players.map((player) => ({
      playerId: player.id, slot: player.slot, name: player.name, car: player.car,
      profile: player.profile
    })),
    rows,
    sim: mpAiSimSummary(true)
  };
  return { ...payload, hash: hashOf(payload) };
}

/** Host: post the final AI rows once all AI are finished or DNF. */
function mpAiPostResultIfTerminal() {
  if (!MP_HOST || !state.mp?.ai || !state.mp.ai.count || mpAiResultPosted) return false;
  if (!mpAiAllTerminal()) return false;
  const payload = mpAiResultPayload();
  if (!payload) return false;
  mpAiResultPosted = true;
  state.mp.ai.result = payload;
  state.mp.ai.resultHash = payload.hash;
  state.mp.ai.allTerminal = true;
  mpAiRelayPost('result', payload).catch((error) => {
    if (state.mp.ai) state.mp.ai.relayError = error.message;
  });
  return true;
}

/** Per-tick MP work after the local engine/rules step. */
function mpAfterLocalTick(snapshot) {
  if (!mpNet || !state.mp) return;
  mpLastState = snapshot;
  mpRememberState(snapshot);
  // Host: advance the AI instances before the authoritative rules consume their
  // post-step states, so AI checkpoints/finishes land on the same tick.
  if (MP_HOST) mpAiStep(snapshot.tick);
  if (MP_HOST) mpHostRulesStep(snapshot);
  if (POWERUPS) mpPowerupHostTick(snapshot);
  if (POWERUPS && state.powerups?.boost) {
    state.powerups.boost.wasm = engine?.boostState?.() ?? state.powerups.boost.wasm;
  }
  const phase = mpNet.phase;
  if (phase === 'running' && !state.mp.finishReported) {
    const input = {
      throttle: snapshot.input[0],
      brake: snapshot.input[1],
      steer: snapshot.input[2],
      handbrake: snapshot.input[3]
    };
    const logicalTick = snapshot.tick + mpEngineTickOffset;
    try {
      mpNet.sendInput(input, logicalTick);
      state.mp.sent.input++;
    } catch (error) {
      state.mp.sendFailures++;
      state.mp.lastError = error.message;
    }
    if (snapshot.tick % MP_STATE_EVERY_TICKS === 0) {
      try {
        mpNet.sendState(mpNetworkState(snapshot));
        state.mp.sent.state++;
      } catch (error) {
        state.mp.sendFailures++;
        state.mp.lastError = error.message;
      }
    }
  }
  mpUpdateStats(false);
}

/** Build the rules state the host feeds RaceSession for one participant. */
function mpRulesState(id, snapshotOrState) {
  if (!snapshotOrState) {
    const grid = state.mp.grid;
    return { id, position: grid ? [grid.x, 0, grid.z] : [0, 0, 0], contact: null };
  }
  return {
    id,
    position: snapshotOrState.position,
    velocity: snapshotOrState.velocity ?? null,
    contact: snapshotOrState.anyContact === undefined ? null : snapshotOrState.anyContact === 1
  };
}

/** Host: advance the authoritative RaceSession by one engine tick. */
function mpHostRulesStep(snapshot) {
  if (!MP_HOST || !mpRace || !mpNet) return;
  const guestId = mpRemotePlayerId ?? null;
  const guestLatest = guestId ? state.mp.remote.latest : null;
  const guestState = guestId
    ? mpRulesState(guestId, guestLatest?.state ?? state.mp.guestSpawnState ?? null)
    : null;
  const hostState = mpRulesState(mpNet.playerId, snapshot);
  const progressRow = guestId ? mpRace.progress.byId.get(guestId) : null;
  if (guestId && guestLatest && progressRow?.awaitingRejoin) {
    mpRace.progress.rejoin(guestId, guestState, mpRace.raceTick);
  }
  const states = {};
  states[mpNet.playerId] = hostState;
  if (guestId) states[guestId] = guestState;
  if (mpAiSim) {
    for (const sim of mpAiSim.sims) states[sim.player.id] = mpRulesState(sim.player.id, sim.state);
  }
  const events = mpRace.step(states);
  if (events.length) {
    state.mp.hostEvents = (state.mp.hostEvents ?? []).concat(events).slice(-64);
  }
  // AI respawns are owned by the authoritative rules; rebuild the host's AI
  // instance at the event target and rejoin the progress row before the next tick.
  for (const event of events) {
    if (event.type !== 'respawn' || !isAiPlayerId(event.participantId) || !mpAiSim) continue;
    const sim = mpAiSim.sims.find((entry) => entry.player.id === event.participantId);
    if (sim) mpAiRespawn(sim, event.target);
  }
  if (mpAiSim) {
    for (const sim of mpAiSim.sims) {
      if (sim.dnf && !sim.dnfPosted) {
        sim.dnfPosted = true;
        try {
          mpRace.command({ type: 'dnf', id: sim.player.id, reason: sim.dnfReason ?? 'ai-dnf',
            tick: mpRace.director.raceTick });
        } catch { /* typed rejection stays in the host event log */ }
      }
    }
    state.mp.ai.allTerminal = mpAiAllTerminal();
  }
  mpAiPostResultIfTerminal();
  if (mpAiFinishPending && mpAiAllTerminal()) mpFlushPendingFinish();
  if (state.mp.result && !state.mp.validation) mpComputeHostValidation();
  else if (state.mp.validation) mpRefreshHostValidation();
}

/**
 * Load the peer's car chunk once. A failure is recorded as a typed error and the
 * remote car is not drawn: never a silent different body.
 */
function mpRequestRemoteCar(slug) {
  if (!slug || slug === car?.slug) {
    mpRemoteCarSlug = slug ?? null;
    return null;
  }
  if (mpRemoteCar?.slug === slug && mpRemoteCar.status === 'ready') {
    mpRemoteCarSlug = slug;
    return mpRemoteCar;
  }
  if (mpRemoteCarPromise) return null;
  const startedAt = performance.now();
  mpRemoteCarSlug = slug;
  mpRemoteCar = { slug, status: 'loading', error: null, code: null, bytes: 0, sha256: null, loadMs: null };
  if (state.mp?.remote) {
    state.mp.remote.car = slug;
    state.mp.remote.carChunk = { slug, status: 'loading', error: null, code: null, bytes: 0,
      sha256: null, loadMs: null, source: 'remote snapshot car field' };
  }
  mpRemoteCarPromise = (async () => {
    try {
      const index = await loadChunkIndexDocument();
      const record = await loadCarChunkDocument(index, slug);
      const body = record.body;
      if (typeof consumer.ensureRemoteCar !== 'function') {
        throw new ChunkLoadError(CHUNK_ERROR.CAR_SCHEMA, 'the consumer cannot upload a second car body');
      }
      const handle = consumer.ensureRemoteCar(slug, body);
      const wheelRest = Object.fromEntries(body.wheelGroups.map((group) =>
        [group.corner, group.matrixColumnMajor]));
      mpRemoteCar = {
        slug,
        status: 'ready',
        body,
        handle,
        wheelRest,
        error: null,
        code: null,
        bytes: record.bytes,
        sha256: record.sha256,
        file: record.file,
        loadMs: +(performance.now() - startedAt).toFixed(1)
      };
      if (state.mp?.remote) state.mp.remote.carChunk = {
        slug, status: 'ready', error: null, code: null, file: record.file,
        bytes: record.bytes, sha256: record.sha256, loadMs: mpRemoteCar.loadMs,
        draws: handle.drawCount      };
      mpRemoteDisplay = null;
      return mpRemoteCar;
    } catch (error) {
      mpRemoteCar = {
        slug,
        status: 'error',
        body: null,
        handle: null,
        wheelRest: null,
        error: error.message,
        code: error.code ?? 'CHUNK_LOAD_FAILED',
        bytes: 0,
        sha256: null,
        loadMs: +(performance.now() - startedAt).toFixed(1)
      };
      if (state.mp?.remote) state.mp.remote.carChunk = {
        slug, status: 'error', error: error.message, code: error.code ?? 'CHUNK_LOAD_FAILED',
        file: null, bytes: 0, sha256: null, loadMs: mpRemoteCar.loadMs, draws: null
      };
      if (state.mp) state.mp.status = 'remote car chunk failed: ' + error.message;
      return mpRemoteCar;
    } finally {
      mpRemoteCarPromise = null;
    }
  })();
  return null;
}

/** Compose/refresh the remote display from the interpolation buffer(s). */
function mpUpdateRemoteFrame(renderTick) {
  if (!mpNet || !state.mp) { consumer.setGhostFrames([]); return; }
  const frames = [];
  // 1. The human peer (M1/M1.1): the net-mvp interpolation buffer + bounded
  //    corrector. The peer's own car chunk is loaded once when the snapshot's car
  //    differs from this page's car; until it is ready the remote car is not
  //    drawn (a missing/failed chunk is a typed error, never another body).
  if (mpRemotePlayerId && ghostWheelRest) {
    const latest = mpNet.latestRemote(mpRemotePlayerId);
    if (latest) {
      state.mp.remote.latest = latest;
      state.mp.remote.tick = latest.tick;
      state.mp.remote.authority = latest.authority === true;
      const remoteSlug = state.mp.remote.car ?? latest.car ?? latest.state?.car ?? car.slug;
      let remoteRest = ghostWheelRest;
      let remoteHandle = null;
      if (remoteSlug !== car.slug) {
        if (mpRemoteCarSlug !== remoteSlug) {
          mpRemoteDisplay = null;
          mpRequestRemoteCar(remoteSlug);
        }
        const entry = mpRemoteCar;
        if (entry?.slug === remoteSlug && entry.status === 'ready') {
          remoteRest = entry.wheelRest;
          remoteHandle = entry.handle;
        } else {
          remoteRest = null;
        }
      }
      if (remoteRest) {
        const sampleTick = Math.max(0, renderTick + mpEngineTickOffset - MP_REMOTE_DELAY_TICKS);
        const target = mpNet.sampleRemote(mpRemotePlayerId, sampleTick);
        if (target) {
          if (!mpRemoteDisplay) mpRemoteDisplay = new RemoteDisplay();
          const display = mpRemoteDisplay.update(target);
          if (display) {
            state.mp.remote.sample = {
              tick: target.tick,
              position: [target.position[0], target.position[1], target.position[2]],
              interpolated: target.interpolated === true,
              clamped: target.clamped === true,
              alpha: target.alpha ?? 0,
              from: target.from ?? null,
              to: target.to ?? null
            };
            state.mp.remote.display = { position: display.position.slice(), quaternion: display.quaternion.slice() };
            state.mp.remote.distance = display.errorMetres;
            state.mp.remote.corrections = display.corrections;
            state.mp.remote.hardSets = display.hardSets;
            state.mp.remote.blends = display.blends;
            const { map } = remoteNodeMatrixMap({ position: display.position, quaternion: display.quaternion }, remoteRest);
            frames.push({ nodeMatrices: map, tint: null, car: remoteHandle });
          }
        }
      }
    }
  }
  // 2. The host's AI cars (0-3): the guest samples only host-relayed poses; the
  //    host samples its own simulation through the same interpolation path.
  if (state.mp.ai?.count > 0) {
    if (!mpAiRemoteSet) mpEnsureAiRemoteSet();
    if (mpAiRemoteSet && ghostWheelRest) {
      const sampleTick = Math.max(0, renderTick + mpEngineTickOffset - MP_REMOTE_DELAY_TICKS);
      const entries = mpAiRemoteSet.sample(sampleTick);
      state.mp.ai.remotes = mpAiRemoteSet.snapshot();
      for (const entry of entries) {
        if (!entry.pose) continue;
        const { map } = remoteNodeMatrixMap(entry.pose, ghostWheelRest);
        frames.push({ nodeMatrices: map, tint: MP_AI_TINT });
      }
    }
  }
  if (!frames.length) {
    consumer.setGhostFrames([]);
    return;
  }
  consumer.setGhostFrames(frames);
}

/** Local finish: one canonical finish report; the shared table arrives later. */
function mpLocalFinish(event) {
  if (!mpNet || !state.mp || state.mp.finishReported) return;
  const countdownTicks = sprintRules?.layout?.countdown?.ticks ?? 0;
  // The shared table is a function of the race time, so derive the reported
  // tick from the authoritative local time. A respawn rebuild resets the wasm
  // tick; adding the raw rebuild offset can be off by one tick.
  const reported = mpFinishTick(event.timeSeconds, countdownTicks);
  const rawTick = event.tick + mpEngineTickOffset;
  const logicalTick = Number.isInteger(reported) && reported > countdownTicks ? reported : rawTick;
  state.mp.finishReported = true;
  state.mp.finishTick = logicalTick;
  state.mp.finishTickRaw = rawTick;
  state.mp.finishTimeSeconds = event.timeSeconds;
  const hashes = state.tickHashes.filter((row) => row.tick <= event.tick).map((row) => row.stateHash);
  const sequenceHash = 'sha256:' + sha256Hex(hashes.join('\n'));
  mpFinishHash = hashOf({
    kind: 'e1-drive.mp.finish',
    version: 1,
    courseId: state.sprintCourseId,
    layoutHash: state.sprintLayoutHash,
    finishTick: logicalTick,
    timeSeconds: event.timeSeconds,
    checkpoints: event.checkpoints ?? null,
    stateSequenceHash: sequenceHash,
    rebuildTickOffset: mpEngineTickOffset
  });
  try {
    const finalState = session?.lastState ?? mpLastState;
    if (finalState) {
      mpNet.sendState(mpNetworkState(finalState));
      state.mp.sent.state++;
    }
  } catch (error) {
    state.mp.sendFailures++;
  }
  state.mp.phase = 'finished-local';
  state.mp.status = 'finish reported; waiting for the shared result';
  if (MP_HOST && state.mp.ai?.count > 0 && !mpAiAllTerminal()) {
    // Hold the human report until the host's AI have finished or been marked
    // DNF, so the room closes only when the AI rows exist for both pages.
    mpAiFinishPending = { tick: logicalTick, hash: mpFinishHash };
    state.mp.status = 'finish recorded; waiting for the host AI to finish';
    publish();
    return;
  }
  mpNet.reportFinished({ tick: logicalTick, hash: mpFinishHash })
    .then(() => { state.mp.status = 'finish reported; waiting for the shared result'; publish(); })
    .catch((error) => { state.mp.lastError = error.message; state.mp.status = 'finish report failed: ' + error.message; publish(); });
  publish();
}

/** Report the human finish once the host AI are terminal (or capped DNF). */
function mpFlushPendingFinish() {
  if (!mpAiFinishPending || !mpNet) return;
  const pending = mpAiFinishPending;
  mpAiFinishPending = null;
  mpAiPostResultIfTerminal();
  mpNet.reportFinished(pending)
    .then(() => { if (state.mp) state.mp.status = 'finish reported; waiting for the shared result'; publish(); })
    .catch((error) => {
      if (state.mp) {
        state.mp.lastError = error.message;
        state.mp.status = 'finish report failed: ' + error.message;
      }
      publish();
    });
}

/** Shared result table from the room's finish broadcast (host and guest). */
function mpApplyResult(message) {
  if (!state.mp || !sprintRules) return;
  if (!Array.isArray(message.results)) return;
  // With AI in the room the host also broadcasts their rows. Both pages build
  // the same merged table from the same bytes; a guest waits for that message
  // instead of rendering a table without the AI participants.
  if (state.mp.ai?.count > 0 && !state.mp.ai.result) {
    state.mp.pendingResult = message;
    state.mp.status = 'room result received; waiting for the host AI result';
    publish();
    return;
  }
  mpBuildAndApplyResult(message);
}

function mpTryApplyResult() {
  const pending = state.mp?.pendingResult;
  if (!pending) return;
  if (state.mp.ai?.count > 0 && !state.mp.ai.result) return;
  state.mp.pendingResult = null;
  mpBuildAndApplyResult(pending);
}

function mpBuildAndApplyResult(message) {
  const room = message.room ?? mpNet?.room ?? null;
  if (!room) return;
  const ai = state.mp.ai;
  const aiPlayers = ai && ai.count > 0
    ? (ai.host ? ai.players : (ai.result?.players ?? ai.remotePlayers))
    : [];
  const aiResults = ai && ai.count > 0 ? (ai.result?.rows ?? []) : [];
  const table = buildMpResult({
    layout: sprintRules.layout,
    room,
    results: message.results,
    aiPlayers: aiPlayers.map((player) => ({
      id: player.id ?? player.playerId,
      slot: player.slot,
      name: player.name,
      car: player.car,
      profile: player.profile
    })),
    aiResults
  });
  mpResult = table;
  state.mp.result = table;
  state.mp.resultSource = 'room.finished + host AI result';
  state.mp.phase = 'finished';
  state.mp.status = 'shared result received';
  state.mp.players = [...room.players];
  if (MP_HOST) mpComputeHostValidation();
  mpUpdateStats(true);
  publish();
}

/**
 * Host validation record. It is recomputed while the host keeps ticking after
 * the room result so the guest's final state can still arrive (the relay and the
 * room finish broadcast are independent WebSocket messages).
 *
 * The guest's own finish report is the result row's tick/time. The host's
 * projected detection is a diagnostic: a host rebuild can pause the local race
 * clock, so the guest can be projected at a different tick. A report is accepted
 * while the race is open (the room has not broadcast its result); only a report
 * after the room closed is rejected by `MpSession.reportFinished`.
 */
function mpComputeHostValidation() {
  if (!MP_HOST || !mpRace || !state.mp || state.mp.validation) return;
  try {
    const snapshot = mpRace.snapshot();
    const hostRow = snapshot.results.rows.find((row) => row.id === mpNet.playerId);
    const guestRow = snapshot.results.rows.find((row) => row.id === mpRemotePlayerId);
    const reported = state.mp.remote.finish?.tick ?? null;
    const countdownTicks = sprintRules.layout.countdown?.ticks ?? 0;
    const reportedRace = reported === null ? null : reported - countdownTicks;
    const reportAccepted = Number.isInteger(reported) && reported > countdownTicks;
    // The guest report may arrive after the host has finished; it is still
    // accepted while the room is open. Do not require a 6-tick detection bound.
    if (!reportAccepted) return;
    state.mp.validation = {
      sessionPhase: snapshot.phase,
      sessionRaceTick: snapshot.raceTick,
      sessionHash: mpRace.hash(),
      hostFinishTick: hostRow?.finishTick ?? null,
      guestDetectedFinishTick: guestRow?.finishTick ?? null,
      guestStatus: guestRow?.status ?? null,
      guestReportedTick: reported,
      guestReportedRaceTick: reportedRace,
      guestDetectionDeltaTicks: guestRow?.finishTick !== null && guestRow?.finishTick !== undefined && reportedRace !== null
        ? guestRow.finishTick - reportedRace : null,
      guestReportAccepted: reportAccepted,
      guestValidated: reportAccepted &&
        (guestRow?.status === 'finished' || snapshot.phase === 'running' || snapshot.phase === 'finished'),
      acceptance: 'guest report accepted while the race is open; host projection delta is diagnostic'
    };
    state.mp.hostSession = {
      phase: snapshot.phase,
      raceTick: snapshot.raceTick,
      resultsHash: snapshot.results.hash,
      hash: state.mp.validation.sessionHash
    };
  } catch (error) {
    state.mp.lastError = 'host validation failed: ' + error.message;
  }
}

/** Refresh diagnostic host/guest detection after the result; never changes rows. */
function mpRefreshHostValidation() {
  if (!MP_HOST || !mpRace || !state.mp?.validation) return;
  try {
    const snapshot = mpRace.snapshot();
    const hostRow = snapshot.results.rows.find((row) => row.id === mpNet.playerId);
    const guestRow = snapshot.results.rows.find((row) => row.id === mpRemotePlayerId);
    const reported = state.mp.remote.finish?.tick ?? null;
    const countdownTicks = sprintRules.layout.countdown?.ticks ?? 0;
    const reportedRace = reported === null ? null : reported - countdownTicks;
    state.mp.validation.sessionRaceTick = snapshot.raceTick;
    state.mp.validation.latestSessionHash = mpRace.hash();
    if (hostRow?.finishTick !== null && hostRow?.finishTick !== undefined) {
      state.mp.validation.hostFinishTick = hostRow.finishTick;
    }
    state.mp.validation.guestDetectedFinishTick = guestRow?.finishTick ?? null;
    state.mp.validation.guestStatus = guestRow?.status ?? null;
    state.mp.validation.guestDetectionDeltaTicks =
      guestRow?.finishTick !== null && guestRow?.finishTick !== undefined && reportedRace !== null
        ? guestRow.finishTick - reportedRace : null;
  } catch (error) {
    state.mp.lastError = 'host validation refresh failed: ' + error.message;
  }
}

/** Normalised room-client events. */
function handleMpEvent(type, payload) {
  if (!state.mp) return;
  switch (type) {
    case 'welcome':
      state.mp.status = 'connected to the room service';
      break;
    case 'lobby': {
      const { room, you } = payload;
      state.mp.room = room;
      state.mp.you = you;
      state.mp.players = [...room.players];
      state.mp.requestedCodeMismatch = Boolean(mpNet?.requestedCodeMismatch);
      const self = room.players.find((player) => player.id === you?.id);
      state.mp.ready = self?.ready === true;
      const remote = room.players.find((player) => player.id !== you?.id);
      if (remote) {
        const wasConnected = state.mp.remote.connected;
        mpRemotePlayerId = remote.id;
        if (powerupView) powerupView.remoteId = remote.id;
        state.mp.remote.id = remote.id;
        state.mp.remote.name = remote.name;
        state.mp.remote.slot = remote.slot;
        state.mp.remote.car = remote.car;
        state.mp.remote.connected = remote.connected !== false;
        if (remote.connected === false) {
          state.mp.status = 'remote player disconnected; the room keeps the slot for 30 s';
        } else if (wasConnected === false) {
          state.mp.status = 'remote player resumed';
        }
      }
      if (!mpStarted) state.mp.phase = 'lobby';
      if (!state.mp.engineReady) state.mp.status = 'in the lobby; loading the engine…';
      else if (!state.mp.started) state.mp.status = state.mp.mapReady ? (state.mp.ready ? 'ready' : 'map verified; press READY') : 'verifying the room map…';
      // Re-publish the host AI roster on every roster change so a joining guest
      // sees the AI list immediately (and the empty list when AI is off).
      if (MP_HOST && mpAiRelayReady()) void mpAiPublishRoster();
      // Host map selection broadcasts a room update; every client reloads and
      // re-verifies the package before it may set READY. The initial load is
      // owned by startMultiplayer so it can use the room's session car.
      if (state.mp.map) mpMapChangedInLobby(normalizeMpMapId(room.map));
      // The AI roster depends on the room map (Gracia's Dodge spawn refusal and
      // the Amboy control floor), so rebuild it when the selected map changes.
      if (MP_HOST && state.mp.ai) {
        mpBuildAiRecords();
        if (mpAiRelayReady()) void mpAiPublishRoster();
      }
      publish();
      break;
    }
    case 'started':
      state.mp.started = true;
      state.mp.phase = 'starting';
      state.mp.status = 'countdown';
      publish();
      void beginMultiplayerRace();
      break;
    case 'remoteState': {
      if (!state.mp.remote.id) state.mp.remote.id = payload.from;
      state.mp.remote.latest = payload;
      state.mp.remote.tick = payload.tick;
      state.mp.remote.authority = payload.authority === true;
      state.mp.remote.connected = true;
      break;
    }
    case 'remoteInput':
      state.mp.remote.input = payload;
      break;
    case 'peerDisconnected':
      state.mp.remote.connected = false;
      state.mp.status = 'remote player disconnected; the room keeps the slot for 30 s';
      publish();
      break;
    case 'peerResumed':
      state.mp.remote.connected = true;
      state.mp.status = 'remote player resumed';
      publish();
      break;
    case 'peerFinished':
      state.mp.remote.finish = { tick: payload.tick, hash: payload.hash };
      mpRemoteFinished = payload;
      if (MP_HOST) mpComputeHostValidation();
      publish();
      break;
    case 'reconnecting':
      state.mp.phase = 'reconnecting';
      state.mp.dropCount++;
      state.mp.status = 'RECONNECTING — the room keeps this slot for 30 s';
      publish();
      break;
    case 'resumed':
      state.mp.resumeCount++;
      state.mp.phase = state.mp.result ? 'finished' : (state.mp.started ? 'running' : 'lobby');
      state.mp.status = 'resumed the same room slot';
      mpUpdateStats(true);
      publish();
      break;
    case 'result':
      mpApplyResult(payload);
      break;
    case 'error': {
      state.mp.lastError = payload?.message ?? String(payload);
      state.mp.sendFailures++;
      // A typed rejection is shown, not silent. Fatal lobby failures set the
      // error state; a transient send/stream error keeps the race running.
      if (state.mp.phase === 'connecting' || state.mp.phase === 'lobby') {
        state.mp.error = state.mp.lastError;
        state.mp.status = 'room error: ' + state.mp.lastError;
      }
      publish();
      break;
    }
    case 'closed':
      if (state.mp.phase !== 'finished') {
        state.mp.phase = 'error';
        state.mp.status = 'room connection closed';
        state.mp.error = 'room connection closed';
        publish();
      }
      break;
    default:
      break;
  }
}

/** Populate the host AI count/per-slot selects once the roster is known. */
function mpSetupAiLobbyControls() {
  const count = document.getElementById('mp-ai-count');
  if (count && !count.dataset.bound) {
    count.dataset.bound = '1';
    if (!count.options.length) {
      for (let value = 0; value <= MP_AI_MAX; value++) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = String(value);
        count.append(option);
      }
    }
    count.addEventListener('change', () => {
      if (!MP_HOST || mpStarted) return;
      const current = state.mp.ai?.players ?? [];
      const cars = current.map((player) => player.car);
      const profiles = current.map((player) => player.profile);
      mpSetAi({ count: Number(count.value), cars, profiles });
    });
  }
  const cars = state.roster?.roster?.cars ?? [];
  for (let index = 0; index < MP_AI_MAX; index++) {
    const carSelect = document.getElementById('mp-ai-car-' + (index + 1));
    if (carSelect && !carSelect.dataset.bound) {
      carSelect.dataset.bound = '1';
      carSelect.textContent = '';
      for (const entry of cars) {
        const option = document.createElement('option');
        option.value = entry.slug;
        option.textContent = carLabel(entry);
        carSelect.append(option);
      }
    }
    const profileSelect = document.getElementById('mp-ai-profile-' + (index + 1));
    if (profileSelect && !profileSelect.dataset.bound) {
      profileSelect.dataset.bound = '1';
      profileSelect.textContent = '';
      for (const id of MP_AI_PROFILE_IDS) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        profileSelect.append(option);
      }
    }
    const apply = () => {
      if (!MP_HOST || mpStarted || !state.mp?.ai) return;
      const records = state.mp.ai.players ?? [];
      const nextCars = records.map((player) => player.car);
      const nextProfiles = records.map((player) => player.profile);
      const car = document.getElementById('mp-ai-car-' + (index + 1))?.value;
      const profile = document.getElementById('mp-ai-profile-' + (index + 1))?.value;
      if (car) nextCars[index] = car;
      if (profile) nextProfiles[index] = profile;
      mpSetAi({ count: state.mp.ai.count, cars: nextCars, profiles: nextProfiles });
    };
    if (carSelect && !carSelect.dataset.changeBound) {
      carSelect.dataset.changeBound = '1';
      carSelect.addEventListener('change', apply);
    }
    if (profileSelect && !profileSelect.dataset.changeBound) {
      profileSelect.dataset.changeBound = '1';
      profileSelect.addEventListener('change', apply);
    }
  }
}

/** Bind the lobby controls once the room and engine are ready. */
function mpBindUi() {
  mpSetupAiLobbyControls();
  const ready = document.getElementById('mp-ready');
  if (ready && !ready.dataset.bound) {
    ready.dataset.bound = '1';
    ready.addEventListener('click', () => {
      if (!mpNet || state.mp.phase !== 'lobby') return;
      if (!state.mp.mapReady || !state.mp.engineReady) {
        state.mp.status = 'READY needs a verified room map (' + mpMapStatusText() + ')';
        publish();
        return;
      }
      const next = !(state.mp.ready === true);
      mpNet.setReady(next)
        .then(() => { state.mp.ready = next; publish(); })
        .catch((error) => { state.mp.lastError = error.message; state.mp.status = 'ready failed: ' + error.message; publish(); });
    });
  }
  const start = document.getElementById('mp-start');
  if (start && !start.dataset.bound) {
    start.dataset.bound = '1';
    start.addEventListener('click', () => { void mpStartRace(); });
  }
  const carSelect = document.getElementById('mp-car');
  if (carSelect && !carSelect.dataset.bound) {
    carSelect.dataset.bound = '1';
    carSelect.addEventListener('change', () => {
      if (!mpNet || state.mp.phase !== 'lobby') return;
      mpNet.selectCar(carSelect.value)
        .then(() => publish())
        .catch((error) => { state.mp.lastError = error.message; state.mp.status = 'car select failed: ' + error.message; publish(); });
    });
  }
  const mapSelect = document.getElementById('mp-map');
  if (mapSelect && !mapSelect.dataset.bound) {
    mapSelect.dataset.bound = '1';
    mapSelect.addEventListener('change', () => {
      if (!MP_HOST || !mpNet || state.mp.phase !== 'lobby' || state.mp.started) return;
      const previous = state.mp.map?.id ?? null;
      state.mp.status = 'selecting map ' + mapSelect.value + '…';
      publish();
      mpNet.selectMap(mapSelect.value)
        .then(() => { void previous; publish(); })
        .catch((error) => {
          state.mp.lastError = error.message;
          state.mp.status = 'map select failed: ' + error.message;
          if (previous) mapSelect.value = previous;
          publish();
        });
    });
  }
}

/** Host-only start; the room service still enforces host + all-ready. */
async function mpStartRace() {
  if (!MP_HOST || !mpNet) return;
  const players = mpNet.room?.players ?? [];
  const connected = players.filter((player) => player.connected !== false);
  const aiCount = state.mp.ai?.count ?? 0;
  const allReady = connected.length >= 1 && connected.length + aiCount >= 2 &&
    connected.every((player) => player.ready);
  if (mpNet.phase !== 'lobby' || !allReady) {
    state.mp.status = connected.length + aiCount < 2
      ? 'start needs a second player or at least one AI (host simulates the AI)'
      : 'start needs every connected player ready';
    publish();
    return;
  }
  if (!state.mp.mapReady || !state.mp.engineReady) {
    state.mp.status = 'start needs this page to verify the room map first';
    publish();
    return;
  }
  if (!aiRosterReady(state.mp.ai)) {
    const codes = (state.mp.ai?.errorCodes ?? []).map((entry) => entry.code).join(',');
    state.mp.status = 'start refused' + (codes ? ' (' + codes + ')' : '') + ': ' +
      (state.mp.ai?.errors?.join('; ') || 'invalid AI records');
    publish();
    return;
  }
  // Freeze the host AI roster in the lobby and make it visible to the guest
  // before the start broadcast.
  if (MP_HOST) await mpAiPublishRoster();
  const roomMapId = normalizeMpMapId(mpNet.room?.map);
  try {
    assertMpMapAgreement(mpMapRecord(roomMapId), mpActualMapRecord(), 'room start');
  } catch (error) {
    state.mp.mapReady = false;
    state.mp.map = { ...(state.mp.map ?? {}), status: 'refused', code: error.code ?? MP_MAP_MISMATCH,
      error: error.message, mismatches: error.detail?.mismatches ?? [] };
    state.mp.mapError = { code: error.code ?? MP_MAP_MISMATCH, message: error.message };
    state.mp.phase = 'error';
    state.mp.status = 'start refused (' + (error.code ?? MP_MAP_MISMATCH) + '): ' + error.message;
    publish();
    return;
  }
  state.mp.phase = 'starting';
  state.mp.status = 'starting…';
  publish();
  try {
    await mpNet.start({ solo: connected.length < 2 });
  } catch (error) {
    state.mp.phase = 'lobby';
    state.mp.status = 'start rejected: ' + error.message;
    state.mp.lastError = error.message;
    publish();
  }
}

/** Begin the local race on both pages when the room broadcasts `room.started`. */
async function beginMultiplayerRace() {
  if (mpStarted || !state.mp?.engineReady || !sprintRules) return;
  // The started room view is authoritative for the map id. Re-check the typed
  // record against the bytes this page loaded; a mismatch is a typed refusal and
  // the local race never starts (no silent River fallback).
  const startedMapId = normalizeMpMapId(
    mpNet?.startedInfo?.mapId ?? mpNet?.room?.map ?? state.mp.map?.id);
  let expected = mpNet?.startedInfo?.map ?? null;
  try {
    if (!expected) expected = mpMapRecord(startedMapId);
    assertMpMapAgreement(expected, mpActualMapRecord(), 'room.started map');
    if (startedMapId !== state.mp.map?.id || !state.mp.mapReady) {
      throw new MpMapError(MP_MAP_MISMATCH,
        'room started ' + startedMapId + ' but this page verified ' + (state.mp.map?.id ?? 'none'));
    }
  } catch (error) {
    state.mp.mapReady = false;
    state.mp.map = { ...(state.mp.map ?? {}), status: 'refused',
      code: error.code ?? MP_MAP_MISMATCH, error: error.message,
      mismatches: error.detail?.mismatches ?? [] };
    state.mp.mapError = { code: error.code ?? MP_MAP_MISMATCH, message: error.message };
    state.mp.phase = 'error';
    state.mp.status = 'start refused (' + (error.code ?? MP_MAP_MISMATCH) + '): ' + error.message;
    publish();
    return;
  }
  mpStarted = true;
  state.mp.phase = 'running';
  state.mp.status = 'countdown';
  try {
    if (MP_HOST) {
      const players = [...(mpNet?.room?.players ?? [])].sort((a, b) => a.slot - b.slot);
      const aiPlayers = state.mp.ai?.count > 0 ? state.mp.ai.players : [];
      const participants = aiParticipants(players, aiPlayers);
      mpRace = new mpRaceRules.RaceSession({
        layout: mpRulesLayout(sprintRules.layout),
        participants,
        config: { hostId: mpNet.playerId, minParticipants: 2, maxParticipants: 2 + MP_AI_MAX, verifyLayoutHash: false }
      });
      state.mp.hostRuleCourseId = sprintRules.layout?.courseId ?? null;
      state.mp.hostRuleMode = 'sprint (package layout projected to the released 310m allow-list)';
      for (const participant of participants) mpRace.command({ type: 'ready', from: participant.id, ready: true });
      mpRace.command({ type: 'start', from: mpNet.playerId });
      // Consume the zero-tick loading phase so the session countdown starts on
      // the same engine tick as the local SprintRules countdown.
      mpRace.step(null);
      const guest = players.find((player) => player.id !== mpNet.playerId);
      if (guest) {
        const grid = state.mp.grid?.slots ?? [];
        const slot = grid[Math.max(0, Math.min(grid.length - 1, guest.slot - 1))];
        if (!slot) throw new Error('multiplayer start grid has no slot for guest P' + guest.slot);
        state.mp.guestSpawnState = { position: [slot.x, slot.y ?? 0, slot.z], contact: null };
      }
      state.mp.hostSession = {
        created: true,
        participants: participants.map((row) => row.id),
        aiParticipants: aiPlayers.map((player) => player.id),
        config: { hostId: mpNet.playerId, countdownTicks: sprintRules.layout.countdown?.ticks ?? 0,
          maxParticipants: 2 + MP_AI_MAX }
      };
    }
    const tick1 = await startTimeline(mpSettledTick0, { reload: true });
    applyState(tick1);
    state.consumer = 'running';
    state.mp.status = 'running';
    if (MP_HOST && state.mp.ai?.count > 0) {
      await mpAiStartHost();
      // Align every AI instance with the host's tick 1 (its world was created at
      // tick 0; one zero-input step consumes the same tick).
      for (const sim of mpAiSim?.sims ?? []) {
        if (sim.ticks === 0) mpAiAdvanceOne(sim, tick1.tick);
      }
      state.mp.ai.hostSim = mpAiSimSummary();
      mpAiPublishRoster();
    } else if (!MP_HOST) {
      mpEnsureAiRemoteSet();
    }
    if (POWERUPS) {
      if (MP_HOST) mpPowerupHostStart();
      else if (state.powerups) {
        state.powerups.phase = 'running';
        state.powerups.status = 'client view running; host events arrive on the relay';
      }
    }
    publish();
    if (!mpFrameStarted) {
      mpFrameStarted = true;
      requestAnimationFrame(frame);
    }
  } catch (error) {
    mpFail('multiplayer start failed: ' + error.message);
  }
}

function mpFail(message) {
  if (state.mp) {
    state.mp.phase = 'error';
    state.mp.error = message;
    state.mp.status = 'error: ' + message;
  }
  fail(message);
}

// ------------------------------------------------------------- power-up slice
// M2/PWR2: host-authoritative Mine/Shield/Repair. The host owns the PWR1
// prototype world; clients send only use intents and render host events. The
// project-specific HTTP relay beside the unchanged room service is the control
// channel (the room service's only channels are input/state).

/** Inject the diagnostic marker mesh + a bounded marker draw slot count. */
function attachPowerupMarkerGeometry(packet) {
  if (!POWERUPS || !packet) return packet;
  const marker = {
    id: POWERUP_MARKER_MESH,
    storage: 'inline-json',
    label: 'diagnostic octahedron marker (presentation only)',
    vertexCount: 6,
    indexCount: 24,
    positions: [0, 1, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1, 0, -1, 0],
    indices: [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 5, 2, 1, 5, 3, 2, 5, 4, 3, 5, 1, 4]
  };
  if (!packet.meshes.some((mesh) => mesh.id === marker.id)) packet.meshes.push(marker);
  const ring = buildPowerupRingMesh();
  if (!packet.meshes.some((mesh) => mesh.id === ring.id)) packet.meshes.push(ring);
  packet.diagnostics = packet.diagnostics ?? {};
  packet.diagnostics.extras = packet.diagnostics.extras ?? {};
  packet.diagnostics.extras.powerups = {
    markerMeshId: marker.id,
    slots: POWERUP_MARKER_SLOTS,
    indexOffset: 0,
    indexCount: marker.indexCount,
    ringMeshId: ring.id,
    ringSlots: POWERUP_RING_SLOTS,
    ringIndexOffset: 0,
    ringIndexCount: ring.indexCount,
    label: 'diagnostic octahedron markers (pickup/mine/shield/weapon) + flat barge ring (presentation only)'
  };
  return packet;
}

/** Flat annulus in the XZ plane; scale = world radius, 0.1 m ring width. */
function buildPowerupRingMesh(segments = 32) {
  const inner = 0.9;
  const outer = 1.0;
  const positions = [];
  const indices = [];
  for (let index = 0; index < segments; index++) {
    const a = (index / segments) * Math.PI * 2;
    const b = ((index + 1) / segments) * Math.PI * 2;
    const points = [
      [Math.cos(a) * inner, 0, Math.sin(a) * inner],
      [Math.cos(a) * outer, 0, Math.sin(a) * outer],
      [Math.cos(b) * inner, 0, Math.sin(b) * inner],
      [Math.cos(b) * outer, 0, Math.sin(b) * outer]
    ];
    for (const point of points) positions.push(point[0], point[1], point[2]);
    const base = index * 4;
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  return {
    id: POWERUP_RING_MESH,
    storage: 'inline-json',
    label: 'diagnostic flat annulus for the Barge radius (presentation only)',
    vertexCount: positions.length / 3,
    indexCount: indices.length,
    positions,
    indices
  };
}

/** Load the PWR1 manifest and the committed rules prototype (read-only inputs). */
async function initPowerups() {
  if (!POWERUPS) return;
  state.powerups.phase = 'loading';
  state.powerups.status = 'loading the PWR1 manifest…';
  const response = await fetch('/_work/powerups/powerups.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('PWR1 manifest fetch failed: HTTP ' + response.status);
  powerupManifest = await response.json();
  if (!Array.isArray(powerupManifest.entities) || powerupManifest.entities.length !== 11) {
    throw new Error('PWR1 manifest does not carry the 11 PickupType entities');
  }
  const projectileResponse = await fetch('/_work/powerups/projectiles.json', { cache: 'no-store' });
  if (!projectileResponse.ok) throw new Error('PWR4 projectile manifest fetch failed: HTTP ' + projectileResponse.status);
  powerupProjectileManifest = await projectileResponse.json();
  if (powerupProjectileManifest.schema !== 'blur-powerups-projectiles/1') {
    throw new Error('PWR4 projectile manifest schema is not blur-powerups-projectiles/1');
  }
  powerupEngine = await import('/powerups/engine.js');
  if (typeof powerupEngine.createWorld !== 'function') {
    throw new Error('PWR1 rules prototype does not export createWorld');
  }
  powerupProjectileModel = await import('/powerups/projectiles.js');
  if (typeof powerupProjectileModel.createProjectileModel !== 'function') {
    throw new Error('PWR4 rules prototype does not export createProjectileModel');
  }
  state.powerups.manifestHash = powerupManifest.hashes?.manifestContent ?? null;
  state.powerups.projectileManifestHash = powerupProjectileManifest.hashes?.manifestContent ?? null;
  state.powerups.types = POWERUP_SLICE_TYPES.slice();
  state.powerups.deferred = { ...POWERUP_DEFERRED };
  state.powerups.phase = 'ready';
  state.powerups.status = 'PWR1 manifest and rules prototype loaded';
}

function mpPowerupRelayUrl() {
  return '/_powerups/relay';
}

function mpPowerupRelaySend(kind, payload) {
  if (!powerupRelay) return Promise.reject(new Error('power-up relay is not ready'));
  return fetch(mpPowerupRelayUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      room: powerupRelay.room,
      from: powerupRelay.playerId,
      kind,
      payload
    })
  }).then(async (response) => {
    if (!response.ok) {
      const text = await response.text();
      throw new Error('relay HTTP ' + response.status + ': ' + text.slice(0, 160));
    }
    return response.json();
  });
}

function mpPowerupRelayStart() {
  if (!POWERUPS || !powerupRelay || powerupRelayTimer) return;
  powerupRelayTimer = setInterval(() => { void mpPowerupRelayPoll(); }, POWERUP_RELAY_POLL_MS);
  void mpPowerupRelayPoll();
}

function mpPowerupRelayStop() {
  if (powerupRelayTimer) clearInterval(powerupRelayTimer);
  powerupRelayTimer = null;
}

async function mpPowerupRelayPoll() {
  if (!powerupRelay || powerupRelay.polling) return;
  powerupRelay.polling = true;
  try {
    const params = new URLSearchParams({
      room: powerupRelay.room,
      after: String(powerupRelay.cursor ?? 0),
      exclude: powerupRelay.playerId
    });
    const response = await fetch(mpPowerupRelayUrl() + '?' + params.toString(), { cache: 'no-store' });
    if (!response.ok) throw new Error('relay HTTP ' + response.status);
    const data = await response.json();
    if (Number.isInteger(data.next) && data.next > (powerupRelay.cursor ?? 0)) powerupRelay.cursor = data.next;
    for (const message of data.messages ?? []) {
      if (message.kind === 'intent' && MP_HOST) mpPowerupHandleIntent(message);
      else if (message.kind === 'event' && !MP_HOST) mpPowerupHandleBatch(message.payload);
    }
    if (state.powerups) state.powerups.relayError = null;
  } catch (error) {
    if (state.powerups) state.powerups.relayError = error.message;
  } finally {
    powerupRelay.polling = false;
  }
}

function mpPowerupRespawnTarget(playerId) {
  if (mpRace?.progress?.course) {
    const participant = mpRace.progress.byId.get(playerId);
    const gateIndex = Math.max(0, (participant?.gateIndex ?? 1) - 1);
    const target = mpRace.progress.course.respawnTargetForGate(gateIndex);
    return { ...target, source: 'race-rules-respawn-target' };
  }
  if (sprintRules) {
    const target = sprintRules.respawnTarget();
    return { ...target, y: state.position[1], source: 'sprint-rules-respawn-target' };
  }
  return null;
}

function mpPowerupClearRemote(playerId) {
  if (!playerId || playerId !== mpRemotePlayerId) return;
  try { mpNet?.net?._interp?.delete(playerId); } catch { /* the buffer is optional */ }
  mpRemoteDisplay = null;
  if (state.mp) {
    state.mp.remote.latest = null;
    state.mp.remote.sample = null;
    state.mp.remote.display = null;
    state.mp.remote.tick = null;
    state.mp.remote.distance = null;
  }
  consumer.setGhostFrame(null);
}

function mpQueueBoostFromEvent(event) {
  if (!engine || !state.powerups) return false;
  const localId = mpNet?.playerId ?? null;
  if (!localId) return false;
  const delay = Math.max(1, Number.isFinite(event.delayTicks) ? event.delayTicks : 4);
  const startTick = state.engineTick + delay - 1;
  let kind = 0;
  let targetMps = 0;
  let ticks = 1;
  let magnitude = 0;
  let direction = { x: 0, y: 0, z: 0 };
  let impulseLabel = null;
  if (event.type === 'nitro-activated') {
    if (event.targetPlayer !== localId) return false;
    kind = 1;
    targetMps = Number(event.targetMps);
    ticks = Number(event.ticks);
    magnitude = Number(event.magnitude);
  } else if (event.type === 'shock-activated') {
    const target = (event.targets ?? []).find((row) => row.targetPlayer === localId) ?? null;
    if (!target) return false;
    kind = 2;
    targetMps = Number(target.targetMps);
    ticks = Number(event.ticks);
    magnitude = Number(event.magnitude);
  } else if (event.type === 'shunt-hit') {
    if (event.targetId !== localId) return false;
    const impulse = event.impulse ?? null;
    if (!impulse || impulse.status !== 'provisional-impulse' || !Number.isFinite(impulse.impulseNs) ||
        !Number.isFinite(impulse.massKg) || impulse.massKg <= 0 || !impulse.direction) {
      state.powerups.notice = 'Shunt impulse typed ' + (impulse?.status ?? 'missing');
      return false;
    }
    kind = 3;
    targetMps = 0;
    ticks = 1;
    magnitude = impulse.impulseNs;
    direction = impulse.direction;
    impulseLabel = impulse;
  } else {
    return false;
  }
  if (kind !== 3 && (!(targetMps > 0) || !(ticks > 0) || !(magnitude > 0))) {
    state.powerups.notice = 'boost event rejected: missing target/ticks/magnitude';
    return false;
  }
  const accepted = engine.boostQueue(kind, startTick, Math.round(ticks), targetMps, magnitude,
    direction.x ?? 0, direction.y ?? 0, direction.z ?? 0);
  if (!accepted) {
    state.powerups.notice = 'boost queue rejected: ' + engine.boostLastError();
    return false;
  }
  const wasm = engine.boostState();
  state.powerups.boost = {
    type: event.type,
    eventSeq: event.seq ?? null,
    targetPlayer: localId,
    authorityStartTick: event.startTick ?? null,
    localStartTick: startTick,
    delayTicks: delay,
    kind,
    targetMps,
    ticks: Math.round(ticks),
    magnitude,
    source: event.source ?? null,
    targetSource: event.targetSource ?? null,
    classLetter: event.classLetter ?? null,
    impulse: impulseLabel,
    wasm
  };
  state.powerups.notice = event.type === 'nitro-activated'
    ? 'NITRO queued at tick ' + startTick + ' - target ' + targetMps.toFixed(2) + ' m/s'
    : event.type === 'shock-activated'
      ? 'SHOCK queued at tick ' + startTick + ' - target ' + targetMps.toFixed(2) + ' m/s'
      : 'SHUNT provisional impulse ' + (impulseLabel?.deltaV ?? '?') + ' m/s at tick ' + startTick;  return true;
}

function mpPowerupHandleEvents(events) {
  if (!state.powerups || !Array.isArray(events) || !events.length) return;
  const localId = mpNet?.playerId ?? null;
  for (const event of events) {
    state.powerups.lastEvents.push(event);
    if (state.powerups.lastEvents.length > 64) state.powerups.lastEvents.shift();
    state.powerups.counts[event.type] = (state.powerups.counts[event.type] ?? 0) + 1;
    if ((event.type === 'nitro-activated' || event.type === 'shock-activated' || event.type === 'shunt-hit') &&
        Number.isInteger(event.seq) && !state.powerups.boostEventSeqs.includes(event.seq)) {
      state.powerups.boostEventSeqs.push(event.seq);
      if (state.powerups.boostEventSeqs.length > 64) state.powerups.boostEventSeqs.shift();
      mpQueueBoostFromEvent(event);
    }
    if (event.type === 'wrecked') {
      if (event.targetId === localId) state.powerups.wrecked = true;
      else state.powerups.remoteWrecked = true;
    }
    if (event.type === 'respawn') {
      if (event.playerId === localId) {
        state.powerups.wrecked = false;
        state.powerups.notice = 'respawn at ' + (event.target?.gateId ?? 'last checkpoint');
        if (!pendingRespawn) {
          pendingRespawn = {
            x: event.target.x,
            z: event.target.z,
            heading: event.target.headingRad ?? event.target.heading ?? 0,
            gateId: event.target.gateId ?? null,
            gateIndex: event.target.gateIndex ?? null
          };
        }
      } else {
        state.powerups.remoteWrecked = false;
        mpPowerupClearRemote(event.playerId);
      }
    }
    if (event.type === 'use-rejected' || event.type === 'pickup-rejected') {
      state.powerups.notice = state.powerups.notice = (event.type === 'use-rejected' ? 'use rejected: ' : 'pickup rejected: ') + event.reason;
    }
  }
  if (MP_HOST && powerupModel) state.powerups.events = powerupModel.events.slice(-64);
  else state.powerups.events = state.powerups.events.concat(events).slice(-64);
  publishPowerupHud();
}

function mpPowerupHandleIntent(message) {
  if (!MP_HOST || !powerupModel) return;
  const payload = message.payload;
  if (!payload || payload.type !== 'use') return;
  const latest = state.mp?.remote.latest?.state ?? null;
  const speeds = {
    [mpNet.playerId]: state.speed,
    [message.from]: latest?.speed
  };
  const events = powerupModel.requestUse(message.from, {
    slot: payload.slot ?? 0,
    tick: state.engineTick + mpEngineTickOffset,
    speedMps: latest?.speed,
    speeds,
    speedSource: 'host-observed-20Hz'
  });
  if (events.length) mpPowerupHandleEvents(events);
  mpPowerupBroadcast(true);
}

function mpPowerupHandleBatch(batch) {
  if (!batch || !powerupView) return;
  if (Number.isInteger(batch.batchSeq) && batch.batchSeq <= powerupView.lastBatchSeq) return;
  const previousEventSeq = powerupView.lastEventSeq;
  applyPowerupBatch(powerupView, batch);
  state.powerups.view = powerupViewSummary(powerupView);
  const fresh = (batch.events ?? []).filter((event) =>
    Number.isInteger(event.seq) && event.seq > previousEventSeq);
  if (fresh.length) mpPowerupHandleEvents(fresh);
  publishPowerupHud();
}

function mpPowerupBroadcast(force = false) {
  if (!MP_HOST || !powerupModel || !powerupRelay || !state.powerups) return;
  if (powerupPendingBatch) {
    const retry = powerupPendingBatch;
    mpPowerupRelaySend('event', retry)
      .then(() => { if (powerupPendingBatch === retry) powerupPendingBatch = null; })
      .catch((error) => { state.powerups.relayError = error.message; });
    return;
  }
  const now = performance.now();
  if (!force && now - powerupLastBroadcastAt < 500) return;
  const events = powerupModel.events.slice(powerupLastEventSeq);
  const batch = {
    batchSeq: ++powerupBroadcastSeq,
    now: powerupModel.now,
    events,
    snapshot: powerupModel.snapshot()
  };
  powerupLastEventSeq = powerupModel.events.length;
  powerupLastBroadcastAt = now;
  powerupPendingBatch = batch;
  mpPowerupRelaySend('event', batch)
    .then(() => { if (powerupPendingBatch === batch) powerupPendingBatch = null; })
    .catch((error) => { state.powerups.relayError = error.message; });
}

function mpPowerupHostStart() {
  if (!MP_HOST || !state.powerups || !powerupManifest || !powerupEngine) return;
  if (powerupModel) return;
  powerupModel = createPowerupModel({
    manifest: powerupManifest,
    createWorld: powerupEngine.createWorld,
    projectileManifest: powerupProjectileManifest,
    createProjectileModel: powerupProjectileModel.createProjectileModel,
    authorityId: mpNet.playerId,
    maxHealth: 100,
    respawnDelaySeconds: 1.0,
    normalRespawnSeconds: null,
    inventoryCapacity: 1
  });
  const hostId = mpNet.playerId;
  const guestId = mpRemotePlayerId;
  const heading = state.mp?.grid?.headingRad ?? state.sprintLayout?.course?.spawn?.headingRad ?? 0;
  const hostForward = { x: Math.sin(heading), y: 0, z: Math.cos(heading) };
  const hostStart = state.mp?.grid
    ? { x: state.mp.grid.x, y: state.position[1], z: state.mp.grid.z }
    : { x: state.position[0], y: state.position[1], z: state.position[2] };
  const sessionMassKg = Number.isFinite(state.car?.mass) ? state.car.mass : null;
  powerupModel.addPlayer(hostId, {
    position: hostStart,
    forward: hostForward,
    speedMps: state.speed,
    massKg: sessionMassKg
  });
  if (guestId) {
    const guestStart = state.mp?.guestSpawnState?.position ?? hostStart;
    const guestForward = hostForward;
    powerupModel.addPlayer(guestId, {
      position: { x: guestStart[0] ?? guestStart.x, y: guestStart[1] ?? guestStart.y ?? 0, z: guestStart[2] ?? guestStart.z },
      forward: guestForward,
      speedMps: state.speed,
      massKg: sessionMassKg
    });
  }
  const spawned = powerupModel.spawnProvisionalPickups(sprintRules.layout);
  state.powerups.placement = powerupModel.placement;
  state.powerups.phase = 'running';
  state.powerups.status = 'host power-up world running';
  state.powerups.snapshot = powerupModel.snapshot();
  powerupLastEventSeq = 0;
  powerupBroadcastSeq = 0;
  mpPowerupHandleEvents(powerupModel.events.slice());
  mpPowerupBroadcast(true);
  return spawned;
}

function mpPowerupHostTick(snapshot) {
  if (!MP_HOST || !powerupModel || !state.powerups) return;
  const guestId = mpRemotePlayerId;
  const latest = state.mp?.remote.latest?.state ?? null;
  const guestSpawn = state.mp?.guestSpawnState?.position ?? null;
  const states = {};
  states[mpNet.playerId] = {
    position: snapshot.position,
    forward: { x: snapshot.axisZ[0], y: snapshot.axisZ[1], z: snapshot.axisZ[2] },
    speedMps: snapshot.speed
  };
  if (guestId) {
    states[guestId] = latest
      ? { position: latest.position, quaternion: latest.quaternion, speedMps: latest.speed }
      : { position: guestSpawn ?? snapshot.position, speedMps: 0 };
  }
  const events = powerupModel.tick(POWERUP_TICK_SECONDS, states, mpPowerupRespawnTarget);
  state.powerups.snapshot = powerupModel.snapshot();
  if (state.powerups.boost) state.powerups.boost.wasm = engine?.boostState?.() ?? state.powerups.boost.wasm;
  if (events.length) mpPowerupHandleEvents(events);
  mpPowerupBroadcast(false);
}

function mpPowerupRequestUse() {
  if (!POWERUPS || !state.mp) return;
  if (state.powerups?.wrecked) {
    state.powerups.notice = 'cannot use an item while wrecked';
    publishPowerupHud();
    return;
  }
  if (MP_HOST) {
    if (!powerupModel) return;
    const latest = state.mp?.remote.latest?.state ?? null;
    const speeds = {
      [mpNet.playerId]: state.speed,
      [mpRemotePlayerId]: latest?.speed
    };
    const events = powerupModel.requestUse(mpNet.playerId, {
      slot: 0,
      tick: state.engineTick + mpEngineTickOffset,
      speedMps: state.speed,
      speeds,
      speedSource: 'host-engine-state'
    });
    if (events.length) mpPowerupHandleEvents(events);
    mpPowerupBroadcast(true);
    return;
  }
  state.powerups.notice = 'use intent sent to the host';
  mpPowerupRelaySend('intent', { type: 'use', slot: 0 })
    .catch((error) => { state.powerups.relayError = error.message; });
  publishPowerupHud();
}

const POWERUP_MARKER_COLOURS = Object.freeze({
  Bomb: [1.0, 0.42, 0.08],
  Shield: [0.14, 0.76, 1.0],
  Repair: [0.2, 0.95, 0.35],
  Nitrous: [1.0, 0.85, 0.1],
  Shock: [0.75, 0.25, 1.0],
  Blindfire: [1.0, 0.55, 0.1],
  Shunt: [1.0, 0.2, 0.35],
  Barge: [0.95, 0.15, 0.15]
});

function mpPowerupMarkerList() {
  if (!POWERUPS) return null;
  const localId = mpNet?.playerId ?? null;
  const markers = [];
  const snapshot = MP_HOST ? state.powerups.snapshot : null;
  const pickups = MP_HOST
    ? (snapshot ? snapshot.pickups : [])
    : Object.values(state.powerups.view?.pickups ?? {});
  const mines = MP_HOST
    ? (snapshot ? snapshot.mines : [])
    : Object.values(state.powerups.view?.mines ?? {});
  const effects = MP_HOST
    ? (snapshot ? snapshot.effects : [])
    : Object.values(state.powerups.view?.effects ?? {});
  const projectileRows = MP_HOST
    ? (snapshot?.projectiles ?? [])
    : Object.values(state.powerups.view?.projectiles ?? {});
  const bargeRows = MP_HOST
    ? (snapshot?.barges ?? [])
    : Object.values(state.powerups.view?.barges ?? {});
  for (const pickup of pickups) {
    if (pickup.state && pickup.state !== 'active') continue;
    markers.push({
      kind: 'pickup',
      position: [pickup.position.x, (pickup.position.y ?? 0) + 0.9, pickup.position.z],
      scale: 0.85,
      colour: POWERUP_MARKER_COLOURS[pickup.type] ?? [0.9, 0.9, 0.2]
    });
  }
  for (const mine of mines) {
    markers.push({
      kind: 'mine',
      position: [mine.position.x, (mine.position.y ?? 0) + 0.45, mine.position.z],
      scale: mine.armed === false ? 0.45 : 0.65,
      colour: [1.0, 0.25, 0.05]
    });
  }
  for (const projectile of projectileRows) {
    const colour = POWERUP_MARKER_COLOURS[projectile.pickupType] ?? [1.0, 0.6, 0.1];
    markers.push({
      kind: 'projectile',
      shape: 'marker',
      position: [projectile.position.x, (projectile.position.y ?? 0), projectile.position.z],
      scale: projectile.pickupType === 'Shunt' ? 0.55 : 0.4,
      colour
    });
  }
  for (const barge of bargeRows) {
    markers.push({
      kind: 'barge',
      shape: 'ring',
      position: [barge.position.x, (barge.position.y ?? 0) + 0.06, barge.position.z],
      scale: barge.outerRadius ?? barge.radius ?? 7.5,
      colour: [0.95, 0.15, 0.15]
    });
  }
  const localPosition = state.position ? [...state.position] : null;
  const remotePosition = state.mp?.remote.display?.position
    ?? state.mp?.remote.latest?.state?.position
    ?? null;
  for (const effect of effects) {
    if (effect.kind !== 'shield' && effect.kind !== 'superShield' &&
        effect.kind !== 'nitro' && effect.kind !== 'shock') continue;
    const owner = effect.ownerId === localId ? localPosition : remotePosition;
    if (!owner) continue;
    markers.push({
      kind: effect.kind,
      position: [owner[0], owner[1] + 0.9, owner[2]],
      scale: effect.kind === 'shield' || effect.kind === 'superShield' ? 2.6 : 1.7,
      colour: effect.kind === 'shield' || effect.kind === 'superShield'
        ? [0.14, 0.76, 1.0]
        : (effect.kind === 'nitro' ? [1.0, 0.85, 0.1] : [0.75, 0.25, 1.0])
    });
  }
  const markerRows = markers.filter((marker) => marker.shape !== 'ring');
  const ringRows = markers.filter((marker) => marker.shape === 'ring');
  let dropped = 0;
  if (markerRows.length > POWERUP_MARKER_SLOTS) {
    dropped += markerRows.length - POWERUP_MARKER_SLOTS;
    markerRows.length = POWERUP_MARKER_SLOTS;
  }
  if (ringRows.length > POWERUP_RING_SLOTS) {
    dropped += ringRows.length - POWERUP_RING_SLOTS;
    ringRows.length = POWERUP_RING_SLOTS;
  }
  state.powerups.markerDropped = dropped;
  return [...markerRows, ...ringRows];
}

function mpPowerupHudModel() {
  if (!POWERUPS || !state.powerups) return null;
  const localId = mpNet?.playerId ?? null;
  const remoteId = mpRemotePlayerId;
  if (MP_HOST && state.powerups.snapshot) {
    const snapshot = state.powerups.snapshot;
    const local = snapshot.players.find((player) => player.id === localId) ?? null;
    const remote = snapshot.players.find((player) => player.id === remoteId) ?? null;
    const shield = snapshot.effects.find((effect) => effect.ownerId === localId &&
      (effect.kind === 'shield' || effect.kind === 'superShield')) ?? null;
    const boost = snapshot.effects.find((effect) => effect.ownerId === localId &&
      (effect.kind === 'nitro' || effect.kind === 'shock')) ?? null;
    return {
      source: 'host',
      now: snapshot.now,
      local,
      remote,
      shield: shield ? { ...shield, secondsLeft: Math.max(0, shield.expiresAt - snapshot.now) } : null,
      boost: boost ? { ...boost, secondsLeft: Math.max(0, boost.expiresAt - snapshot.now) } : null,
      pickups: snapshot.pickups,
      mines: snapshot.mines,
      effects: snapshot.effects,
      projectiles: snapshot.projectiles ?? [],
      barges: snapshot.barges ?? [],
      feed: state.powerups.lastEvents.slice(-8).map((event) => ({
        seq: event.seq, type: event.type, text: powerupEventText(event)
      })),
      counts: state.powerups.counts,
      placement: snapshot.placement,
      labels: snapshot.labels,
      relayError: state.powerups.relayError
    };
  }
  if (powerupView) {
    const summary = powerupViewSummary(powerupView);
    return { ...summary, source: 'client' };
  }
  return { source: 'client', now: 0, local: null, remote: null, shield: null, pickups: [], mines: [], effects: [], projectiles: [], barges: [], feed: [], counts: {}, placement: null, labels: null, relayError: state.powerups.relayError };
}

function publishPowerupHud() {
  const root = document.getElementById('powerup-hud');
  if (!root) return;
  if (!POWERUPS || !state.powerups) { root.hidden = true; return; }
  root.hidden = false;
  const hud = mpPowerupHudModel();
  const set = (id, text) => {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
  };
  const local = hud?.local ?? null;
  const item = local?.inventory?.[0] ?? null;
  const label = item ? (POWERUP_SLICE_LABELS[item.type] ?? item.type) : 'EMPTY';
  const boost = hud?.boost ?? null;
  const wasmBoost = engine?.boostState?.() ?? null;
  const icon = document.getElementById('powerup-slot-icon');
  if (icon) {
    icon.textContent = item ? label.slice(0, 1) : (boost ? (boost.kind === 'nitro' ? 'N' : 'S') : '·');
    icon.dataset.kind = item ? item.type.toLowerCase() : (boost ? boost.kind : 'empty');
  }
  set('powerup-slot-name', item ? label + ' · ' + item.type : (boost ? (boost.kind === 'nitro' ? 'NITRO' : 'SHOCK') + ' active' : 'empty slot'));
  set('powerup-slot-timer', boost
    ? (boost.kind === 'nitro' ? 'NITRO' : 'SHOCK') + ' · ' + boost.secondsLeft.toFixed(2) + ' s' +
      (Number.isFinite(boost.targetMps) ? ' · ' + Number(boost.targetMps).toFixed(2) + ' m/s' : '') +
      (wasmBoost ? ' · wasm ' + (wasmBoost.remaining ?? 0) + 't / ' + (wasmBoost.applied ?? 0) + 'f' : '')
    : (item ? 'E — use · host validates' : 'pick up a pickup on the measured course'));
  if (item && Number.isFinite(item.charges)) {
    const nameElement = document.getElementById('powerup-slot-name');
    if (nameElement) {
      nameElement.textContent = label + ' - ' + item.type + ' - ' + item.charges +
        '/' + (item.maxCharges ?? '?') + ' charges';
    }
  }
  const activeRows = [...(hud?.projectiles ?? []), ...(hud?.barges ?? [])];
  if (activeRows.length) {
    const timerElement = document.getElementById('powerup-slot-timer');
    if (timerElement) {
      timerElement.textContent = activeRows.map((row) => {
        const secondsLeft = Number.isFinite(row.secondsLeft)
          ? row.secondsLeft
          : Math.max(0, (row.lifetimeSeconds ?? 0) - (row.age ?? 0));
        return (row.pickupType ?? row.kind ?? 'effect') + ' ' + Number(secondsLeft).toFixed(2) + ' s';
      }).join(' / ');
    }
  }
  const health = local ? local.health : null;
  const maxHealth = local?.maxHealth ?? null;
  const percent = Number.isFinite(health) && Number.isFinite(maxHealth) && maxHealth > 0
    ? Math.max(0, Math.min(100, (health / maxHealth) * 100)) : 0;
  const bar = document.getElementById('powerup-health-bar');
  if (bar) bar.style.width = percent.toFixed(1) + '%';
  set('powerup-health-text', Number.isFinite(health) ? health.toFixed(0) + ' / ' + maxHealth + ' HP' : '—');
  const shield = hud?.shield ?? null;
  set('powerup-shield-text', shield
    ? shield.capacity + ' / ' + shield.maxCapacity + ' · ' + shield.secondsLeft.toFixed(2) + ' s'
    : 'no shield');
  const shieldBar = document.getElementById('powerup-shield-bar');
  if (shieldBar) {
    shieldBar.style.width = shield && shield.maxCapacity > 0
      ? Math.max(0, Math.min(100, (shield.capacity / shield.maxCapacity) * 100)).toFixed(1) + '%'
      : '0%';
  }
  const status = state.powerups.wrecked
    ? 'WRECKED — waiting for the host respawn event'
    : (boost
      ? (boost.kind === 'nitro' ? 'NITRO boosting' : 'SHOCK speed scrub') +
        ' · ' + boost.secondsLeft.toFixed(2) + ' s · seq ' + (state.powerups.boost?.eventSeq ?? '—')
      : (state.powerups.notice ?? 'ready · E uses the held item'));
  set('powerup-status', status);
  if (boost?.kind === 3) {
    set('powerup-slot-name', 'SHUNT - provisional impulse');
    set('powerup-status', 'SHUNT provisional impulse ' +
      (Number.isFinite(boost.impulse?.deltaV) ? Number(boost.impulse.deltaV).toFixed(2) : '?') +
      ' m/s - seq ' + (state.powerups.boost?.eventSeq ?? '-'));
  }
  const placement = hud?.placement ?? state.powerups.placement;
  set('powerup-note', 'provisional measured-arc placement · ' + POWERUP_SLICE_TYPES.join('/') +
    ' · host events seq ' + (hud?.counts ? (state.powerups.lastEvents.at(-1)?.seq ?? 0) : 0) +
    ' · Nitro target = exact PWR1 Hermite (class ' + (state.powerups.boost?.classLetter ?? 'A') + ', project class assumption)' +
    ' · diagnostic markers' + (placement?.mode ? ' · ' + placement.mode : '') +
    (hud?.relayError ? ' · relay: ' + hud.relayError : ''));
  const feed = (hud?.feed ?? []).slice(-6).map((entry) => '#' + entry.seq + ' ' + entry.text).join('\n');
  set('powerup-feed', feed || 'no power-up events yet');
  root.dataset.state = state.powerups.wrecked ? 'wrecked' : (boost ? 'boosting' : (item ? 'armed' : 'ready'));
}

/** Compact capture/debug projection (never used by the render path). */
function mpPowerupCapture() {
  if (!POWERUPS || !state.powerups) return null;
  const hud = mpPowerupHudModel();
  const element = (id) => document.getElementById(id);
  return {
    schema: POWERUP_SCHEMA,
    enabled: true,
    phase: state.powerups.phase,
    status: state.powerups.status,
    manifestHash: state.powerups.manifestHash,
    projectileManifestHash: state.powerups.projectileManifestHash ?? null,
    types: state.powerups.types,
    deferred: state.powerups.deferred,
    placement: hud?.placement ?? state.powerups.placement,
    boostModel: powerupModel?.boost ?? null,
    labels: hud?.labels ?? state.powerups.snapshot?.labels ?? null,
    eventCount: powerupModel ? powerupModel.events.length : (powerupView?.lastEventSeq ?? 0),
    lastEventSeq: powerupModel ? powerupModel.events.length : (powerupView?.lastEventSeq ?? 0),
    lastBatchSeq: powerupView?.lastBatchSeq ?? powerupBroadcastSeq,
    counts: hud?.counts ?? state.powerups.counts,
    feed: hud?.feed ?? [],
    local: hud?.local ?? null,
    remote: hud?.remote ?? null,
    shield: hud?.shield ?? null,
    boost: state.powerups.boost ?? null,
    engineBoost: engine?.boostState?.() ?? null,
    pickups: hud?.pickups ?? [],
    mines: hud?.mines ?? [],
    effects: hud?.effects ?? [],
    projectiles: hud?.projectiles ?? [],
    barges: hud?.barges ?? [],
    projectileModel: state.powerups.snapshot?.projectileModel ?? null,
    wrecked: state.powerups.wrecked,
    remoteWrecked: state.powerups.remoteWrecked,
    relay: state.powerups.relay,
    relayError: state.powerups.relayError,
    markerDropped: state.powerups.markerDropped ?? 0,
    hud: {
      hidden: element('powerup-hud')?.hidden ?? null,
      icon: element('powerup-slot-icon')?.textContent ?? null,
      name: element('powerup-slot-name')?.textContent ?? null,
      timer: element('powerup-slot-timer')?.textContent ?? null,
      health: element('powerup-health-text')?.textContent ?? null,
      shield: element('powerup-shield-text')?.textContent ?? null,
      status: element('powerup-status')?.textContent ?? null,
      note: element('powerup-note')?.textContent ?? null,
      feed: element('powerup-feed')?.textContent ?? null
    },
    markers: {
      slots: consumer?.stats?.powerupSlots ?? 0,
      markerSlots: consumer?.stats?.powerupMarkerSlots ?? 0,
      ringSlots: consumer?.stats?.powerupRingSlots ?? 0,
      drawsIssued: consumer?.stats?.powerupDrawsIssued ?? 0,
      ringDrawsIssued: consumer?.stats?.powerupRingDrawsIssued ?? 0,
      frames: consumer?.stats?.powerupFrames ?? 0,
      enabled: consumer?.stats?.powerupEnabled ?? false,
      dropped: consumer?.stats?.powerupDropped ?? 0
    },
    events: (powerupModel ? powerupModel.events.slice(-80) : state.powerups.lastEvents.slice(-80))
  };
}

function mpInstallPowerupDebugApi() {
  if (!POWERUPS) return;
  const hostEventWindow = (mutate) => {
    if (!MP_HOST || !powerupModel) throw new Error('power-up host mutation is host-only');
    const before = powerupModel.events.length;
    mutate();
    state.powerups.snapshot = powerupModel.snapshot();
    const events = powerupModel.events.slice(before);
    if (events.length) mpPowerupHandleEvents(events);
    mpPowerupBroadcast(true);
    return events;
  };
  window.__powerups = {
    enabled: true,
    state: () => mpPowerupCapture(),
    events: () => (powerupModel ? powerupModel.events.slice() : state.powerups.events.slice()),
    markers: () => mpPowerupMarkerList(),
    use: () => mpPowerupRequestUse(),
    grant: (type) => hostEventWindow(() => {
      powerupModel.clearInventory(mpNet.playerId);
      powerupModel.grantItem(mpNet.playerId, type);
    }),
    grantGuest: (type) => hostEventWindow(() => {
      if (!mpRemotePlayerId) throw new Error('no guest player');
      powerupModel.clearInventory(mpRemotePlayerId);
      powerupModel.grantItem(mpRemotePlayerId, type);
    }),
    clearGuest: () => hostEventWindow(() => {
      if (!mpRemotePlayerId) throw new Error('no guest player');
      powerupModel.clearInventory(mpRemotePlayerId);
    }),
    placeMineOnGuest: (ahead = 0) => hostEventWindow(() => {
      const latest = state.mp?.remote.latest?.state;
      if (!latest) throw new Error('no guest state yet');
      const forward = forwardFromQuaternion(latest.quaternion) ?? { x: 0, y: 0, z: 1 };
      const speed = Number.isFinite(latest.speed) ? latest.speed : 0;
      // `'arm'` places the mine where the guest will be when the recovered
      // MasterMinePrimeTimer (0.3 s) elapses, so the first outer-radius contact
      // is already inside the direct-hit radius. A number is an explicit offset.
      const distance = ahead === 'arm' ? Math.max(1.0, speed * 0.31) : (Number.isFinite(ahead) ? ahead : 0);
      powerupModel.placeMineForPlayer(mpNet.playerId, {
        x: latest.position[0] + forward.x * distance,
        y: latest.position[1],
        z: latest.position[2] + forward.z * distance
      });
    }),
    boostState: () => engine?.boostState?.() ?? null,
    nitroFor: (who = 'host') => hostEventWindow(() => {
      const id = who === 'guest' ? mpRemotePlayerId : mpNet.playerId;
      if (!id) throw new Error('no ' + who + ' player');
      const latest = state.mp?.remote.latest?.state ?? null;
      const speed = id === mpNet.playerId ? state.speed : latest?.speed;
      powerupModel.clearInventory(id);
      powerupModel.grantItem(id, 'Nitrous');
      powerupModel.requestUse(id, {
        slot: 0,
        tick: state.engineTick + mpEngineTickOffset,
        speedMps: speed,
        speeds: { [mpNet.playerId]: state.speed, [mpRemotePlayerId]: latest?.speed },
        speedSource: 'capture-current-state'
      });
    }),
    shockOnTarget: (attacker = 'host', target = 'guest') => hostEventWindow(() => {
      const attackerId = attacker === 'guest' ? mpRemotePlayerId : mpNet.playerId;
      const targetId = target === 'guest' ? mpRemotePlayerId : mpNet.playerId;
      if (!attackerId || !targetId) throw new Error('no attacker/target player');
      const latest = state.mp?.remote.latest?.state ?? null;
      const targetPosition = targetId === mpNet.playerId
        ? { x: state.position[0], y: state.position[1], z: state.position[2] }
        : (latest ? { x: latest.position[0], y: latest.position[1], z: latest.position[2] } : null);
      if (!targetPosition) throw new Error('no guest state yet');
      const attackerSpeed = attackerId === mpNet.playerId ? state.speed : latest?.speed;
      powerupModel.clearInventory(attackerId);
      powerupModel.grantItem(attackerId, 'Shock');
      powerupModel.requestUse(attackerId, {
        slot: 0,
        position: targetPosition,
        staged: true,
        tick: state.engineTick + mpEngineTickOffset,
        speedMps: attackerSpeed,
        speeds: { [mpNet.playerId]: state.speed, [mpRemotePlayerId]: latest?.speed },
        speedSource: 'capture-current-state'
      });
    }),
    stageWeapon: (attacker = 'host', target = 'guest', pickupType = 'Blindfire', miss = false) => {
      const attackerId = attacker === 'guest' ? mpRemotePlayerId : mpNet.playerId;
      const targetId = target === 'guest' ? mpRemotePlayerId : mpNet.playerId;
      if (!attackerId) throw new Error('no ' + attacker + ' player');
      if (!miss && !targetId) throw new Error('no ' + target + ' player');
      return hostEventWindow(() => powerupModel.stageWeapon({
        attackerId,
        targetId: miss ? null : targetId,
        pickupType,
        miss
      }));
    },
    broadcast: () => mpPowerupBroadcast(true)
  };
}

/** Compact probe for the headless capture; never used by the render path. */
function mpCaptureSnapshot() {
  if (!state.mp) return null;
  const mp = state.mp;
  const overlay = (id) => document.getElementById(id);
  const sprint = state.sprint;
  return {
    schema: mp.schema,
    phase: mp.phase,
    status: mp.status,
    error: mp.error,
    frameError: state.frameError ?? null,
    frameErrorStack: state.frameErrorStack ?? null,
    renderErrorStack: state.renderErrorStack ?? null,
    roomCode: mp.room?.code ?? null,
    requestedCode: mp.requestedCode,
    requestedCodeMismatch: mp.requestedCodeMismatch,
    host: mp.host,
    you: mp.you ? { id: mp.you.id, slot: mp.you.slot } : null,
    engineReady: mp.engineReady,
    started: mp.started,
    sessionCar: mp.sessionCar,
    mapId: mp.map?.id ?? null,
    mapReady: mp.mapReady === true,
    map: mp.map ? {
      id: mp.map.id,
      label: mp.map.label,
      level: mp.map.level,
      status: mp.map.status,
      code: mp.map.code ?? null,
      error: mp.map.error ?? null,
      packageHash: mp.map.packageHash ?? null,
      layoutHash: mp.map.layoutHash ?? null,
      physicsHash: mp.map.physicsHash ?? null,
      packageFileSha256: mp.map.packageFileSha256 ?? null,
      layoutFileSha256: mp.map.layoutFileSha256 ?? null,
      physicsFileSha256: mp.map.physicsFileSha256 ?? null,
      expected: mp.map.expected ?? null,
      actual: mp.map.actual ?? null,
      mismatches: mp.map.mismatches ?? [],
      loadMs: mp.map.loadMs ?? null,
      bytes: mp.map.bytes ?? null,
      expectedBytes: mp.map.expectedBytes ?? null
    } : null,
    mapError: mp.mapError ?? null,
    grid: mp.grid,
    players: (mp.room?.players ?? []).map((player) => ({
      id: player.id, slot: player.slot, name: player.name, car: player.car,
      ready: player.ready, connected: player.connected, host: player.host
    })),
    engineTick: state.engineTick,
    frames: state.frames,
    consumer: state.consumer,
    local: { tick: state.engineTick, position: state.position, speed: state.speed },
    sprint: sprint ? {
      phase: sprint.phase,
      elapsedSeconds: sprint.elapsedSeconds,
      finishTimeSeconds: sprint.finishTimeSeconds,
      finishTick: sprint.finishTick,
      finished: sprint.finished,
      checkpointsPassed: sprint.checkpointsPassed,
      respawns: sprint.respawns ?? 0,
      progress: sprint.progress,
      countdownLabel: sprint.countdownLabel
    } : null,
    hostEvents: (mp.hostEvents ?? []).slice(-24),
    sprintEvents: (state.sprintEvents ?? []).slice(-12),
    finishReported: mp.finishReported,
    finishTick: mp.finishTick,
    finishTickRaw: mp.finishTickRaw ?? null,
    finishHash: mpFinishHash,
    result: mp.result ? {
      hash: mp.result.hash,
      courseId: mp.result.courseId,
      order: mp.result.order,
      winnerId: mp.result.winnerId,
      rows: mp.result.rows
    } : null,
    validation: mp.validation,
    hostSession: mp.hostSession,
    powerups: mpPowerupCapture(),
    ai: {
      ...aiSummary(mp.ai),
      players: (mp.ai?.players ?? []).map((player) => ({ ...player })),
      remotePlayers: (mp.ai?.remotePlayers ?? []).map((player) => ({ ...player })),
      poseTick: mp.ai?.poseTick ?? null,
      poseCount: mp.ai?.poseCount ?? 0,
      allTerminal: mp.ai?.allTerminal ?? null,
      resultHash: mp.ai?.resultHash ?? null,
      result: mp.ai?.result ? {
        hash: mp.ai.result.hash,
        countdownTicks: mp.ai.result.countdownTicks,
        rows: mp.ai.result.rows,
        sim: mp.ai.result.sim ?? null
      } : null,
      remotes: mp.ai?.remotes ?? [],
      hostSim: mp.ai?.hostSim ?? null
    },
    remote: {
      id: mp.remote.id,
      name: mp.remote.name,
      slot: mp.remote.slot,
      car: mp.remote.car,
      carChunk: mp.remote.carChunk ? {
        slug: mp.remote.carChunk.slug,
        status: mp.remote.carChunk.status,
        code: mp.remote.carChunk.code ?? null,
        error: mp.remote.carChunk.error ?? null,
        file: mp.remote.carChunk.file ?? null,
        bytes: mp.remote.carChunk.bytes ?? 0,
        sha256: mp.remote.carChunk.sha256 ?? null,
        loadMs: mp.remote.carChunk.loadMs ?? null,
        draws: mp.remote.carChunk.draws ?? null
      } : null,
      connected: mp.remote.connected,
      latestTick: mp.remote.tick,
      seq: mp.remote.seq ?? null,
      authority: mp.remote.authority,
      corrections: mp.remote.corrections,
      hardSets: mp.remote.hardSets,
      blends: mp.remote.blends,
      distance: mp.remote.distance,
      sample: mp.remote.sample,
      sampleTick: mp.remote.sample?.tick ?? null,
      samplePosition: mp.remote.sample?.position ?? null,
      sampleFrom: mp.remote.sample?.from ?? null,
      sampleTo: mp.remote.sample?.to ?? null,
      latestPosition: mp.remote.latest?.state?.position ?? null,
      latestQuaternion: mp.remote.latest?.state?.quaternion ?? null,
      displayPosition: mp.remote.display?.position ?? null,
      displayQuaternion: mp.remote.display?.quaternion ?? null,
      finish: mp.remote.finish ?? null
    },
    sent: mp.sent,
    received: mp.received,
    applied: mp.applied,
    ping: mp.ping,
    sendFailures: mp.sendFailures,
    dropCount: mp.dropCount,
    resumeCount: mp.resumeCount,
    overlays: {
      lobbyHidden: overlay('mp-lobby')?.hidden ?? null,
      roomCodeText: overlay('mp-room-code')?.textContent ?? null,
      statusText: overlay('mp-lobby-status')?.textContent ?? null,
      readyText: overlay('mp-ready')?.textContent ?? null,
      readyDisabled: overlay('mp-ready')?.disabled ?? null,
      startHidden: overlay('mp-start')?.hidden ?? null,
      startDisabled: overlay('mp-start')?.disabled ?? null,
      remoteTagHidden: overlay('remote-tag')?.hidden ?? null,
      remoteTagText: overlay('remote-tag')?.textContent ?? null,
      remotesText: overlay('mp-remotes')?.textContent ?? null,
      aiCountText: overlay('mp-ai-count')?.value ?? null,
      aiCountDisabled: overlay('mp-ai-count')?.disabled ?? null,
      aiCar1Disabled: overlay('mp-ai-car-1')?.disabled ?? null,
      aiProfile1Disabled: overlay('mp-ai-profile-1')?.disabled ?? null,
      aiListText: overlay('mp-ai-list')?.textContent ?? null,
      resultsHidden: overlay('results')?.hidden ?? null,
      resultsTime: overlay('results-time')?.textContent ?? null,
      resultsBest: overlay('results-best')?.textContent ?? null,
      mpResultsHidden: overlay('mp-results')?.hidden ?? null,
      mpResultsText: overlay('mp-results')?.textContent ?? null
    }
  };
}

/** Capture/debug surface; the page never depends on it. */
function mpInstallDebugApi() {
  window.__mp = {
    session: () => mpNet,
    setReady: (ready) => {
      if (ready && !state.mp?.mapReady) {
        return Promise.reject(new MpMapError(MP_MAP_MISMATCH,
          'READY needs a verified room map (' + mpMapStatusText() + ')'));
      }
      return mpNet ? mpNet.setReady(Boolean(ready)) : Promise.reject(new Error('no room'));
    },
    selectMap: (map) => (MP_HOST && mpNet ? mpNet.selectMap(map) : Promise.reject(new Error('only the host selects the map'))),
    mapRecord: () => mpActualMapRecord(),
    mapExpected: (map) => mpMapRecord(map),
    verifyMap: (actual, expected) => compareMpMapRecords(expected ?? mpMapRecord(state.mp?.map?.id), actual ?? mpActualMapRecord()),
    start: () => mpStartRace(),
    setAi: (config = {}) => {
      try { return Promise.resolve(mpSetAi(config)); }
      catch (error) { return Promise.reject(error); }
    },
    ai: () => aiSummary(state.mp?.ai),
    aiSim: () => mpAiSimSummary(),
    drop: (options = {}) => (mpNet ? mpNet.net.simulateDrop(options) : Promise.reject(new Error('no room'))),
    snapshot: () => mpCaptureSnapshot(),
    stateAt: (tick) => mpHistoryAt(Number(tick)),
    result: () => mpResult,
    mpState: () => state.mp,
    powerups: () => mpPowerupCapture(),
    constants: {
      tickHz: MP_TICK_HZ,
      inputHz: MP_INPUT_HZ,
      stateHz: MP_TICK_HZ / MP_STATE_EVERY_TICKS,
      remoteDelayTicks: MP_REMOTE_DELAY_TICKS,
      positionThresholdMetres: MP_POSITION_THRESHOLD_METRES,
      angleThresholdRad: MP_ANGLE_THRESHOLD_RAD,
      blendTicks: MP_BLEND_TICKS,
      powerups: POWERUPS ? {
        types: POWERUP_SLICE_TYPES,
        markerSlots: POWERUP_MARKER_SLOTS,
        relayPollMs: POWERUP_RELAY_POLL_MS
      } : null,
      ai: {
        max: MP_AI_MAX,
        profiles: MP_AI_PROFILE_IDS,
        poseEveryTicks: MP_AI_POSE_EVERY_TICKS,
        relayPollMs: MP_AI_RELAY_POLL_MS,
        relayPath: MP_AI_RELAY_PATH,
        powerups: false
      }
    }
  };
}

/** Capture/debug surface for the chunked load path; the page never depends on it. */
window.__e1Chunks = {
  switchCar: (slug) => switchCarInPlace(slug),
  state: () => state.chunk ?? null,
  car: () => (car ? { slug: car.slug, name: car.name } : null),
  map: () => state.map ?? null,
  documents: () => ({
    index: chunkDocuments.index,
    levelBytes: chunkDocuments.levelBytes,
    levelSha256: chunkDocuments.levelSha256,
    baseBytes: chunkDocuments.baseBytes,
    baseSha256: chunkDocuments.baseSha256,
    cars: [...chunkDocuments.cars.entries()].map(([slug, record]) => ({
      slug, bytes: record.bytes, sha256: record.sha256, file: record.file
    }))
  }),
  remote: () => (mpRemoteCar ? {
    slug: mpRemoteCar.slug,
    status: mpRemoteCar.status,
    error: mpRemoteCar.error,
    code: mpRemoteCar.code,
    bytes: mpRemoteCar.bytes,
    sha256: mpRemoteCar.sha256,
    loadMs: mpRemoteCar.loadMs,
    draws: mpRemoteCar.handle?.drawCount ?? null
  } : null)
};

/** `?mp=1` entry point: connect/join, load the room map, show the lobby. */
async function startMultiplayer() {
  state.consumer = 'loading';
  state.mp.phase = 'connecting';
  state.mp.status = 'connecting to the room service…';
  publish();
  mpInstallDebugApi();
  try {
    const raceRules = await import('/race-rules/index.mjs');
    mpRaceRules = raceRules;
    mpSlot = MP_HOST ? 1 : 2;
    // Resolve the requested car from the roster without creating a world yet,
    // so the room is created with the exact session car slug.
    const roster = await loadRoster();
    const requestedCar = resolveCar(roster, REQUESTED_CAR ?? null);
    state.mp.sessionCar = requestedCar.slug;

    const netModule = await import('/net-mvp/client.mjs');
    mpInterpolationBuffer = netModule.InterpolationBuffer;
    mpNet = new MpSession({
      NetClient: netModule.NetClient,
      url: MP_URL,
      name: MP_NAME,
      host: MP_HOST,
      code: MP_CODE,
      car: requestedCar.slug,
      // Only the host proposes the map; the room's map field is authoritative
      // for both pages after the join.
      map: MP_HOST ? MAP.id : null,
      maxPlayers: MP_MAX_PLAYERS,
      onEvent: handleMpEvent
    });
    state.mp.phase = 'loading';
    state.mp.status = 'joining the room; the map package loads next…';
    publish();
    const joined = await mpNet.open();
    const roomMapId = normalizeMpMapId(joined.room.map);
    if (!roomMapId) throw new Error('the room did not publish a map id');
    const roomCar = sessionCarForRoom(joined.room, requestedCar.slug);
    // M1.1: each human loads its own roster car chunk; the room car is only the
    // fallback when a page did not ask for one. Physics, rules and the grid stay
    // independent, and the remote page draws the peer's chunk.
    state.mp.remoteCar = roomCar && roomCar !== requestedCar.slug
      ? { hostCar: roomCar, localCar: requestedCar.slug, note: 'per-player car chunks (M1.1)' }
      : null;
    if (joined.you.slot !== mpSlot) {
      throw new Error('the online room expects the host in slot 1 and the guest in slot 2; this page joined slot ' +
        joined.you.slot + (MP_HOST ? ' as host' : ' as guest'));
    }
    state.mp.room = joined.room;
    state.mp.you = joined.you;
    state.mp.players = [...joined.room.players];
    state.mp.requestedCodeMismatch = mpNet.requestedCodeMismatch;
    const remote = joined.room.players.find((player) => player.id !== joined.you.id);
    if (remote) {
      mpRemotePlayerId = remote.id;
      state.mp.remote.id = remote.id;
      state.mp.remote.name = remote.name;
      state.mp.remote.slot = remote.slot;
      state.mp.remote.car = remote.car;
      state.mp.remote.connected = remote.connected !== false;
    }
    // Load and verify the room's map before the lobby allows READY.
    await mpEnsureRoomMap(roomMapId, { carSlug: requestedCar.slug, force: true });
    // AI opponents: the host builds the records from the committed roster; the
    // guest receives the same read-only list through the ordered AI relay.
    mpAiRelayStart(joined.room.code, joined.you.id);
    if (MP_HOST) {
      mpBuildAiRecords();
      await mpAiPublishRoster();
    }
    if (POWERUPS) await initPowerups();
    state.mp.phase = 'lobby';
    state.mp.status = state.mp.mapReady
      ? 'engine loaded; map verified; press READY'
      : 'map not verified; READY is disabled';
    mpRemoteDisplay = null;
    mpLocalHistory = new Map();
    if (POWERUPS) {
      powerupRelay = {
        room: joined.room.code,
        playerId: joined.you.id,
        cursor: 0,
        polling: false
      };
      powerupView = createPowerupView({ localId: joined.you.id, remoteId: remote?.id ?? null });
      state.powerups.phase = 'lobby';
      state.powerups.status = 'power-up relay connected; the host creates the world at start';
      state.powerups.relay = {
        room: joined.room.code,
        playerId: joined.you.id,
        role: MP_HOST ? 'host' : 'guest',
        pollMs: POWERUP_RELAY_POLL_MS,
        endpoint: '/_powerups/relay'
      };
      mpPowerupRelayStart();
      mpInstallPowerupDebugApi();
    }
    state.consumer = 'lobby';
    mpBindUi();
    publish();
  } catch (error) {
    mpFail(error.message);
  }
}


async function doReset(nowUs) {
  if (MP) {
    if (state.mp) {
      state.mp.status = 'restart is not available in an M1 room (return to the lobby is M2)';
      publish();
    }
    return;
  }
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

function frameInner(nowMs) {
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
      if (MP) mpAfterLocalTick(snapshot);
      if (sprintRules) {
        if (sprintRules.awaitingRejoin) {
          pendingRespawn = sprintRules.respawnTarget();
          break;
        }
        if (sprintRules.phase === 'finished' && snapshot.tick - sprintRules.finishTick >= FINISH_TAIL_TICKS) {
          // In an M1/M3 room the host must keep its engine tick alive until the
          // guest's finish is validated and the shared result arrives; the guest
          // may hold once its own brake tail is done. Package maps are up to
          // 2,060 m, so a slower guest can finish tens of seconds later.
          const tail = snapshot.tick - sprintRules.finishTick;
          const hasAi = state.mp?.ai?.count > 0;
          const tailCap = hasAi ? (MAP_IS_PACKAGE ? 20000 : 4200)
            : (MAP_IS_PACKAGE ? 4800 : 600);
          const hostRulesRow = MP_HOST && mpRace ? mpRace.progress?.byId?.get(mpNet?.playerId) : null;
          const hostRulesFinished = hostRulesRow?.status === 'finished';
          const keepHostRunning = MP && MP_HOST &&
            ((!hostRulesFinished || state.mp?.validation?.guestValidated !== true ||
              (state.mp?.ai?.count > 0 && !mpAiAllTerminal())) && tail < tailCap);
          if (!keepHostRunning) {
            holdReached = true;
            state.holdReached = true;
          }
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

  try {
    if (MP) mpUpdateRemoteFrame(cursor); else updateGhostFrame();
  } catch (error) {
    state.renderError = error.message;
    state.consumer = 'error';
    if (state.mp) {
      state.mp.error = error.message;
      state.mp.status = 'render error: ' + error.message;
      state.renderErrorStack = error.stack ?? null;
    }
    publish();
    throw error;
  }
  if (MP && POWERUPS) consumer.setPowerupMarkers(mpPowerupMarkerList());
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

/** Outer guard: a step/render exception is recorded instead of silently stopping the loop. */
function frame(nowMs) {
  try {
    frameInner(nowMs);
  } catch (error) {
    state.frameError = error.message;
    state.frameErrorStack = error.stack ?? null;
    state.consumer = 'error';
    if (state.mp) {
      state.mp.error = 'frame: ' + error.message;
      state.mp.status = 'frame error: ' + error.message;
    }
    publish();
    throw error;
  }
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
  if (MP) {
    await startMultiplayer();
    return;
  }
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
    : COURSE_IS_FREE ? FREE_SCRIPT_TICKS : MAX_SPRINT_SCRIPT_TICKS)) {
    throw new Error('hold tick ' + HOLD + ' is beyond the scripted sprint (' +
      (COURSE_IS_LAP ? LAP_SCRIPT_TICKS : COURSE_IS_FREE ? FREE_SCRIPT_TICKS : MAX_SPRINT_SCRIPT_TICKS) + ')');
  }

  state.consumer = 'running';
  publish();
  if (consumer.device) await consumer.device.queue.onSubmittedWorkDone();
  requestAnimationFrame(frame);
}

main().catch((error) => fail(error.message));
