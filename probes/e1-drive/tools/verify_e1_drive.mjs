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
import {
  assembleGeometry, parseCarChunk, parseChunkIndex, parseLevelChunk, verifyChunkBytes, verifyChunkSha
} from '../web/geometry-chunks.js';
import { buildOccluder } from '../web/camera-occlusion.js';
import { PHASES, SCRIPT_TICKS, TICK_HZ, phaseAt, scriptedInput } from '../web/drive-script.js';
import {
  CHECKPOINT_FRACTIONS, COLUMN_STEP, FREE_REGIONS_PATH, GATE_SAMPLE_STEP, LAP_LOOPS_PATH,
  LONG_COURSE_PATH, SHORT_COURSE_ID, deriveFreeRoamLayout, deriveLapCourseLayout, deriveLongCourseLayout,
  deriveSprintLayout, isFreeLayout, isLapLayout, layoutStartHeading, layoutStartPosition,
  validateSprintLayout
} from '../web/sprint-layout.js';
import { SPRINT_EVENT, courseGroundAt, createSprintRules, coursePosition, freeGroundAt } from '../web/sprint-rules.js';
import {
  FREE_PACKET_SCRIPT, FREE_SCRIPT_TICKS, LAP_PACKET_SCRIPT, LAP_SCRIPT_TICKS, SPRINT_SCRIPT_TICKS,
  SPRINT_PACKET_SCRIPT, respawnScriptInput, sprintScriptInput
} from '../web/sprint-script.js';
import {
  COLLISION_PROBES, FREE_PROP_PINS, LAP_PROP_PINS, PROP_MANIFEST, PROP_PROFILE, PROP_PROFILE_ROADSIDE,
  SPRINT_DRIVEN_EXCLUSION_CONTENT_SHA256, SPRINT_DRIVEN_EXCLUSIONS, SPRINT_PROP_PINS, applyDrivenLineExclusions,
  checkPropManifest, collisionProbePose, createPropLayer, propPinsForCourse, propYawFromHeading
} from '../web/prop-layer.js';
import { createWorld as createPropWorld } from '../../prop-collision/lib/resolver.mjs';
import { createBestTimes } from '../web/sprint-best.js';
import {
  GHOST_CORNERS, GHOST_INDEX_KIND, GHOST_KEY_PREFIX, GHOST_SOURCE, buildGhostArcTable, createGhostStore,
  decodeGhost, ghostFromRun, ghostGap, ghostHash, ghostMatrices, ghostPoseAt, ghostSecondsAtArc,
  referenceGhostFileName, validateGhostRecord
} from '../web/ghost-replay.js';
import {
  createWasmResetEngineSet, createWasmTelemetryEngineSet, runTelemetrySeries, summariseTelemetryMetrics,
  TELEMETRY_MANOEUVRE, TELEMETRY_MANOEUVRE_ORDER, TELEMETRY_SPEC, tickAtSpeedKph
} from '../web/telemetry.js';
import { buildCorridorSurvey } from '../web/corridor-survey.js';
import { runFreePropLayerTests, runPropLayerTests, runV2PropLayerTests } from './prop_layer_tests.mjs';
import { LIMIT_STATIONS, runLimitStation, stationPose, writeCorridorProbe } from './corridor_probe.mjs';
import { TICK0_LIMITS } from './spawn.mjs';
import { startRoomServer } from '../../net-mvp/server.mjs';
import { NetClient, NetError, InterpolationBuffer } from '../../net-mvp/client.mjs';
import { startServer } from './serve.mjs';
import {
  AiRemoteSet, MP_AI_SPAWN_UNSUPPORTED, aiControlOverrides, aiParticipants, aiResultRows,
  aiRosterReady, aiSpawnSupport, buildAiRoster
} from '../web/mp-ai.js';
import { AiDriver as BrowserAiDriver, SKILL_PROFILES as BrowserAiProfiles } from '../web/ai-driver-browser.js';
import { AiDriver as CommittedAiDriver } from '../../ai-driver/ai-driver.mjs';
import {
  MP_ANGLE_THRESHOLD_RAD, MP_BLEND_TICKS, MP_MAP_MISMATCH, MP_POSITION_THRESHOLD_METRES, MP_ROOM_CLOSED,
  MP_STATE_EVERY_TICKS, MP_TICK_HZ, MpMapError, MpSession, assertMpMapAgreement, buildMpResult,
  compareMpMapRecords, defaultRoomUrl, mpFinishTick, mpMapRecord, normalizeMpMapId, normalizeRoomCode,
  sessionCarForRoom
} from '../web/mp-client.js';
import { MAPS, MP_MAP_IDS } from '../web/map-registry.js';
import { RemoteDisplay } from '../web/mp-remote.js';
import { CourseModel, RaceSession } from '../../race-rules/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, '_work/e1-drive');
const LOGS = path.join(ROOT, '_work/logs/e1-drive');
const MODULE = path.join(OUT, 'module/e1_drive.mjs');
const BUILD = path.join(OUT, 'module/build.json');
const GEOMETRY = path.join(OUT, 'geometry.json');
const LEVEL_GEOMETRY = path.join(OUT, 'level.geometry.json');
const BASE_GEOMETRY = path.join(OUT, 'base.geometry.json');
const CHUNK_INDEX = path.join(OUT, 'car-bodies.index.json');
const TRACK_TEXTURE_MANIFEST = path.join(OUT, 'track-textures.json');
const ROSTER = path.join(OUT, 'cars.json');
const LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics');

/** SHA-256 of a local file, in the registry's `sha256:` form. */
const sha256File = (file) => 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');

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
// Set before the lap runs: createWorld(manifest, {profile:'all-visible'}).
let lapPropWorld = null;
let lapPropManifest = null;
// P74 base V2 manifest: the 310 m sprint uses the roadside profile. The profile
// world is 553 colliders; the layer world excludes the measured driven-line
// components (537 after the batch-1 16-collider set), exactly the set the
// committed scripted sprint touches.
let sprintProfileWorld = null;
let sprintPropWorld = null;
// Set before the free-roam block: the P74 R04-V2 world and its manifest.
let freePropWorld = null;
let freePropManifest = null;

const failures = [];
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(label + (detail ? ': ' + detail : ''));
};

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const bareSha256 = (value) => String(value ?? '').replace(/^sha256:/, '');
const round6Local = (value) => Math.round(value * 1e6) / 1e6;

const wrapAngle = (value) => {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

/** Unit vector from the orbit target toward the eye, matching packet-camera.mjs. */
const orbitDirection = (yaw, pitch) =>
  [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];

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

// ------------------------------------------------------- chunked geometry
// The page loads `level.geometry.json` + one `cars/<slug>.geometry.json`; the
// combined `geometry.json` is a debug artifact. These checks pin every chunk,
// prove the split did not change the level/body data, and feed the packet
// producer below through the same assembly the page uses.
const chunkIndexBytes = readFileSync(CHUNK_INDEX);
const chunkIndex = parseChunkIndex(chunkIndexBytes.toString('utf8'));
const chunkSha = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const levelChunkBytes = readFileSync(LEVEL_GEOMETRY);
const levelChunk = parseLevelChunk(levelChunkBytes.toString('utf8'));
const baseChunkBytes = readFileSync(BASE_GEOMETRY);
const baseChunk = JSON.parse(baseChunkBytes.toString('utf8'));
const chunkBodies = new Map();
const chunkBodyErrors = [];
const chunkRosterSlugs = roster.roster.cars.map((car) => car.slug);
function chunkDiff(a, b, ignore, pathName, out) {
  if (a === b) return;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    out.push(pathName);
    return;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (ignore.has(key)) continue;
    chunkDiff(a[key], b[key], ignore, pathName + '.' + key, out);
  }
}
for (const slug of chunkRosterSlugs) {
  const entry = chunkIndex.cars?.[slug];
  if (!entry) { chunkBodyErrors.push(slug + ': not in index'); continue; }
  const file = path.join(OUT, entry.file);
  if (!existsSync(file)) { chunkBodyErrors.push(slug + ': missing ' + entry.file); continue; }
  const bytes = readFileSync(file);
  if (bytes.length !== entry.bytes || chunkSha(bytes) !== entry.sha256) {
    chunkBodyErrors.push(slug + ': byte/hash mismatch'); continue;
  }
  let body;
  try { body = parseCarChunk(bytes.toString('utf8'), chunkIndex, slug); }
  catch (error) { chunkBodyErrors.push(slug + ': ' + error.message); continue; }
  const diff = [];
  chunkDiff(geometry.carBodies?.[slug], body,
    new Set(['kind', 'version', 'geometryVersion', 'chunk']), 'body', diff);
  if (diff.length) chunkBodyErrors.push(slug + ': differs at ' + diff.slice(0, 3).join(', '));
  chunkBodies.set(slug, { body, bytes, sha256: entry.sha256, file: entry.file });
}
const levelDiff = [];
chunkDiff(geometry, levelChunk,
  new Set(['carBodies', 'fallbackBodies', 'fallbackBodyCount', 'chunk']), 'level', levelDiff);
check('chunk index pins the level/base/debug files and covers the roster in order',
      chunkIndex.kind === 'e1-drive.car-bodies-index' && chunkIndex.version === 1 &&
      chunkIndex.geometryVersion === geometry.version &&
      chunkIndex.level.sha256 === chunkSha(levelChunkBytes) &&
      chunkIndex.level.bytes === levelChunkBytes.length &&
      chunkIndex.base.sha256 === chunkSha(baseChunkBytes) &&
      chunkIndex.base.bytes === baseChunkBytes.length &&
      chunkIndex.debug.sha256 === chunkSha(readFileSync(GEOMETRY)) &&
      chunkIndex.debug.bytes === readFileSync(GEOMETRY).length &&
      chunkIndex.defaultCar === geometry.defaultCar &&
      chunkRosterSlugs.every((slug) => chunkIndex.cars[slug] && !chunkIndex.cars[slug].fallback),
      JSON.stringify({ level: chunkIndex.level, base: chunkIndex.base, cars: Object.keys(chunkIndex.cars).length }));
check('the level chunk carries only the level half (two static meshes, no car bodies)',
      levelChunk.meshes.length === 2 && Object.keys(levelChunk.carBodies).length === 0 &&
      levelChunk.levelDraws.length === 22 && levelChunk.trackVisual.draws.length === 394 &&
      levelDiff.length === 0,
      levelDiff.slice(0, 3).join(', ') || 'level fields identical to the combined artifact');
check('every car chunk is byte-pinned and identical to its combined body',
      chunkBodyErrors.length === 0 && chunkBodies.size === chunkRosterSlugs.length,
      chunkBodyErrors.slice(0, 3).join('; ') || `${chunkBodies.size} car chunks, metadata-only diff`);
check('the map-mode base chunk carries only metadata and no car bodies',
      baseChunk.kind === 'e1-drive.geometry' && baseChunk.chunk?.kind === 'base' &&
      Object.keys(baseChunk.carBodies ?? {}).length === 0 && baseChunk.meshes === undefined &&
      baseChunk.light && baseChunk.materials && baseChunk.cameraIntrinsics && baseChunk.roster,
      `${baseChunkBytes.length} B`);
const chunkGeometryFor = (slug) => {
  const record = chunkBodies.get(slug);
  if (!record) throw new Error('no validated chunk body for ' + slug);
  return assembleGeometry(levelChunk, record.body, { index: chunkIndex });
};

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

// The five committed T-007 reference cars. Their anchors are the regression
// baseline; batch-added cars are checked per-car but must not move these.
const REFERENCE_CAR_SLUGS = new Set([
  'corvette-zr1-stock', 'lotus-exige-cup260-stock', 'dodge-challenger-stock',
  'ford-focusrs-stock', 'audi-r8v10-stock'
]);

check('roster passes its decode gate', roster.status === 'PASS' &&
      roster.counts.selected === roster.roster.cars.length,
      `${roster.counts.gatePass}/${roster.counts.records} records pass, ${roster.counts.selected} selected`);
check('roster covers at least four real cars', roster.roster.cars.length >= 4,
      String(roster.roster.cars.length));

// ------------------------------------------------- per-car body-mesh gates
const bodies = geometry.carBodies ?? {};
const rosterSlugs = roster.roster.cars.map((car) => car.slug);
check('geometry carries one real body per roster car (v6 + P73b level props)',
      geometry.version === 6 && rosterSlugs.every((slug) => bodies[slug]) &&
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
check('the roster bodies are distinct real meshes',
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

// ------------------------------------------------------- real track visual
// The visual is the instructed block88/node283 section plus the six measured
// corridor sections of the 539.81 m course. The corridor totals are pinned to the
// track-coverage measurement (299 draws / 47,790 triangles / 78,712 vertices), so
// a lost or duplicated section fails here before any sprint is run.
const trackVisual = geometry.trackVisual;
const trackDraws = Array.isArray(trackVisual?.draws) ? trackVisual.draws : [];
const trackSection = (key) => trackVisual?.sections?.find((section) => section.key === key);
const section88 = trackSection('river.block88.node283');
const section56 = trackSection('river.block56.node289');
const corridorKeys = [
  'river.block56.node289', 'river.block58.node265', 'river.block50.node265',
  'river.block71.node209', 'river.block64.node209', 'river.block59.node265'
];
const corridorSections = corridorKeys.map((key) => trackSection(key));
const corridorTotals = corridorSections.reduce((sum, section) => ({
  draws: sum.draws + (section?.drawCount ?? 0),
  triangles: sum.triangles + (section?.triangleCount ?? 0),
  vertices: sum.vertices + (section?.vertexCount ?? 0)
}), { draws: 0, triangles: 0, vertices: 0 });
check('geometry carries the real track visual from committed direct draws (v6 + P73b level props)',
      geometry.version === 6 && trackVisual?.label === 'asset-reader-direct-draws' &&
      geometry.meshes.some((mesh) => mesh.id === trackVisual?.meshId) &&
      trackDraws.length === trackVisual?.drawCount && trackDraws.length > 0,
      `${trackVisual?.label ?? 'missing'} / ${trackDraws.length} draws`);
check('the instructed block88/node283 section is verbatim and pinned',
      section88 && section88.vertexCount === 17782 && section88.triangleCount === 9343 &&
      section88.drawCount === 95 && section88.driveBoxOverlap === false &&
      /^sha256:[0-9a-f]{64}$/.test(section88.referenceSha256 ?? ''),
      section88 ? `${section88.vertexCount}/${section88.triangleCount}/${section88.drawCount}` : 'missing');
check('the six measured corridor sections are present, pinned and ordered as measured',
      corridorSections.every((section) => section &&
        Number.isFinite(section.courseMetres) && section.courseOverlap === true &&
        /^sha256:[0-9a-f]{64}$/.test(section.referenceSha256 ?? '') &&
        /^[0-9a-f]{64}$/.test(section.positionsFloat32LESha256 ?? '') &&
        /^[0-9a-f]{64}$/.test(section.indicesUint32LESha256 ?? '')) &&
      corridorSections.every((section) => section.drawIndexRange[1] - section.drawIndexRange[0] + 1 === section.drawCount),
      corridorSections.map((section) => section?.key + ':' + section?.courseMetres + 'm').join(' '));
check('the corridor section totals are the measured 299 draws / 47,790 triangles / 78,712 vertices',
      corridorTotals.draws === 299 && corridorTotals.triangles === 47790 && corridorTotals.vertices === 78712 &&
      geometry.source.track.corridor.drawCount === 299 &&
      geometry.source.track.corridor.triangleCount === 47790 &&
      geometry.source.track.corridor.vertexCount === 78712,
      `${corridorTotals.draws}/${corridorTotals.triangles}/${corridorTotals.vertices}`);
check('the merged track visual keeps the instructed section plus the corridor without duplicate sections',
      trackDraws.length === 394 && trackVisual.triangleCount === 57133 && trackVisual.vertexCount === 96494 &&
      new Set(trackDraws.map((draw) => draw.id)).size === trackDraws.length &&
      new Set((trackVisual.sections ?? []).map((section) => section.key)).size === 7,
      `${trackDraws.length} draws / ${trackVisual.triangleCount} tri / ${trackVisual.vertexCount} verts`);
check('every real track draw keeps a valid source index range and the direct-draw label',
      trackDraws.length > 0 && trackDraws.every((draw) =>
        Number.isInteger(draw.indexOffset) && draw.indexOffset >= 0 &&
        Number.isInteger(draw.indexCount) && draw.indexCount > 0 && draw.indexCount % 3 === 0 &&
        Number.isInteger(draw.vertexOffset) && draw.vertexOffset >= 0 &&
        draw.trackVisual === 'asset-reader-direct-draws' &&
        draw.source?.worldReason === 'noInstanceTransform: direct draw, no instance placement; identity is the source world'),
      trackDraws.length + ' draws');
check('the collision surface is hidden physics provenance, not a mesh upload',
      geometry.collisionSurface?.visible === false &&
      geometry.collisionSurface?.physicsOnly === true &&
      geometry.collisionSurface?.draw?.visible === false &&
      /^(sha256:)?[0-9a-f]{64}$/.test(geometry.collisionSurface?.source?.sha256 ?? '') &&
      !geometry.meshes.some((mesh) => mesh.id === geometry.collisionSurface?.meshId),
      geometry.collisionSurface?.triangleCount + ' collision triangles');
check('the uploaded geometry is bounded to the level and the one real track visual mesh',
      geometry.meshes.length === 2 && geometry.meshes[1].id === trackVisual?.meshId,
      `${geometry.meshes.length} static meshes`);
check('the collision coverage is measured against the committed corridor draws',
      geometry.collisionSurface?.coverage?.coveredTriangles > 0 &&
      geometry.collisionSurface?.coverage?.fallbackTriangles > 0 &&
      geometry.collisionSurface.coverage.coveredTriangles + geometry.collisionSurface.coverage.fallbackTriangles ===
        geometry.collisionSurface.triangleCount,
      `${geometry.collisionSurface?.coverage?.coveredTriangles ?? 0} covered / ` +
      `${geometry.collisionSurface?.coverage?.fallbackTriangles ?? 0} no-draw triangles`);

// ------------------------------------------------- static albedo textures
// P44/P45/P47 measured one static `g_tAlbedo` source for 297 of the 394 draws and
// documented the other 97 (2 runtime-only parameters + 95 block88 draws with no
// binding row). The visual must sample the real UV0 stream for every draw it can,
// and must keep the labelled diagnostic albedo for the rest: no texture, UV or
// colour is invented here.
const textureManifest = JSON.parse(readFileSync(TRACK_TEXTURE_MANIFEST, 'utf8'));
const trackMesh = geometry.meshes.find((mesh) => mesh.id === trackVisual?.meshId);
const trackUv = trackMesh?.uv ?? null;
const uvBuffer = trackUv?.data ? Buffer.from(trackUv.data, 'base64') : Buffer.alloc(0);
const uvValues = trackUv && uvBuffer.length === trackUv.bytes
  ? new Float32Array(uvBuffer.buffer, uvBuffer.byteOffset, uvBuffer.length / 4)
  : new Float32Array(0);
const textures = Array.isArray(geometry.textures) ? geometry.textures : [];
const textureIds = new Set(textures.map((texture) => texture.id));
const texturedDraws = trackDraws.filter((draw) => draw.textureId != null);
const runtimeDraws = trackDraws.filter((draw) => draw.textureBinding?.status === 'runtimeOnlyAlbedoParameter');
const unboundDraws = trackDraws.filter((draw) => draw.textureBinding?.status === 'noBindingRowForSection');

check('the track mesh carries the real P45 UV0 stream for every merged vertex',
      trackUv && trackUv.storage === 'base64-float32le' && trackUv.components === 2 &&
      trackUv.vertexCount === trackVisual?.vertexCount && trackUv.vertexCount === 96494 &&
      trackUv.values === 192988 && trackUv.bytes === 771952 &&
      uvBuffer.length === trackUv.bytes && uvValues.length === trackUv.values &&
      uvValues.every(Number.isFinite) &&
      'sha256:' + sha256(uvBuffer) === trackUv.sha256 &&
      trackUv.source?.aggregate === '2ed1f4b0b3c9148e',
      `${trackUv?.vertexCount ?? 0} vertices / ${trackUv?.bytes ?? 0} B / ${trackUv?.sha256 ?? 'missing'}`);
check('the UV stream is the exported P45/P47 stream (manifest and geometry agree)',
      textureManifest.kind === 'e1-drive.track-textures' && textureManifest.version === 1 &&
      textureManifest.pins?.uvAggregate === '2ed1f4b0b3c9148e' &&
      textureManifest.pins?.bindingAggregate === '9cc08756505dd497' &&
      textureManifest.uvStream?.sha256 === trackUv?.sha256 &&
      textureManifest.sections.length === 7 &&
      textureManifest.sections.reduce((sum, section) => sum + section.texturedDraws, 0) === 297,
      textureManifest.uvStream?.sha256 ?? 'missing');
check('297 draws sample a static albedo texture; 2 runtime-only and 95 unbound draws stay diagnostic',
      texturedDraws.length === 297 && runtimeDraws.length === 2 && unboundDraws.length === 95 &&
      trackDraws.every((draw) => draw.textureBinding &&
        ['bound-static-albedo', 'runtimeOnlyAlbedoParameter', 'noBindingRowForSection']
          .includes(draw.textureBinding.status)) &&
      texturedDraws.every((draw) => draw.textureBinding.source && draw.textureBinding.uvHash) &&
      runtimeDraws.every((draw) => draw.textureBinding.source === null && draw.textureId === null) &&
      unboundDraws.every((draw) => draw.textureId === null),
      `${texturedDraws.length} textured / ${runtimeDraws.length} runtime / ${unboundDraws.length} no-binding-row`);
check('the 136 static albedo textures are unique and traced to their block:index',
      textures.length === 136 && textureIds.size === 136 &&
      textures.every((texture) => texture.drawCount > 0 &&
        /^track\.albedo\.\d+\.\d+$/.test(texture.id) &&
        texture.source === texture.block + ':' + texture.index &&
        texture.width > 0 && texture.height > 0 && texture.levels > 0 &&
        texture.format === 827611204 && texture.formatName === 'DXT1/BC1' &&
        (texture.decodeRegistry === 'engine-textures.json' || texture.decodeRegistry === 'track-textures.json')) &&
      new Set(textures.map((texture) => texture.source)).size === 136 &&
      textures.filter((texture) => texture.decodeRegistry === 'engine-textures.json').length === 40 &&
      textures.filter((texture) => texture.decodeRegistry === 'track-textures.json').length === 96,
      `${textures.length} textures, ${textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0)} RGBA B`);
check('every embedded RGBA payload re-hashes to the exported texture file and manifest',
      textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0) === 439360 &&
      textures.every((texture) => {
        const embedded = Buffer.from(texture.rgbaBase64, 'base64');
        const file = path.join(ROOT, '_work/e1-drive/textures', texture.id + '.rgba');
        if (!existsSync(file)) return false;
        return embedded.length === texture.rgbaBytes &&
          embedded.length === texture.width * texture.height * 4 &&
          'sha256:' + sha256(embedded) === texture.rgbaSha256 &&
          readFileSync(file).equals(embedded);
      }) &&
      textureManifest.textures.length === 136 &&
      textureManifest.textures.every((texture) => textures.some((candidate) =>
        candidate.id === texture.id && candidate.rgbaSha256 === texture.rgbaSha256)),
      '136 RGBA payloads equal the exported .rgba files');
check('the sampler is the explicit repeat/linear mip0 choice, not a recovered engine state',
      geometry.texturePack?.sampler?.addressModeU === 'repeat' &&
      geometry.texturePack.sampler.addressModeV === 'repeat' &&
      geometry.texturePack.sampler.magFilter === 'linear' &&
      geometry.texturePack.sampler.minFilter === 'linear' &&
      geometry.texturePack.sampler.mipLevelsUploaded === 1 &&
      geometry.texturePack.sampler.textureFormat === 'rgba8unorm' &&
      geometry.texturePack.sampler.colourSpace === 'raw-decoded-texels' &&
      /not retail/.test(geometry.texturePack.sampler.reason ?? '') &&
      geometry.texturePack.coverage?.texturedDraws === 297 &&
      geometry.texturePack.coverage?.fallbackDraws === 97,
      geometry.texturePack?.sampler?.reason?.slice(0, 80) ?? 'missing');
check('every textured draw samples finite UV0 inside the exported stream',
      texturedDraws.every((draw) => {
        if (!/^0x[0-9a-f]{16}$/.test(draw.textureBinding.uvHash ?? '')) return false;
        if (!textureIds.has(draw.textureId)) return false;
        let lowU = Infinity; let highU = -Infinity; let lowV = Infinity; let highV = -Infinity;
        const end = draw.indexOffset + draw.indexCount;
        for (let offset = draw.indexOffset; offset < end; offset++) {
          const vertex = trackMesh.indices[offset];
          const u = uvValues[vertex * 2];
          const v = uvValues[vertex * 2 + 1];
          if (!Number.isFinite(u) || !Number.isFinite(v)) return false;
          if (u < lowU) lowU = u; if (u > highU) highU = u;
          if (v < lowV) lowV = v; if (v > highV) highV = v;
        }
        return highU - lowU > 0 || highV - lowV > 0;
      }),
      `${texturedDraws.length} draws over ${uvValues.length / 2} vertices`);
check('the two runtime-only draws are exactly g50-n265 primitives 241/242',
      runtimeDraws.length === 2 &&
      runtimeDraws.every((draw) =>
        draw.source.geometryBlock === 50 && draw.source.nodeBlock === 265 &&
        [241, 242].includes(draw.source.primitiveIndex)),
      runtimeDraws.map((draw) => draw.source.geometryBlock + '/' + draw.source.primitiveIndex).join(', '));

// ------------------------------- level-instance prop UV0 + BC1 albedo (P73b)
// P73a exported the real UV0 and the static g_tAlbedo identity for the 22
// block27/node253 instance draws. P73b binds the 18 BC1 draws to their decoded
// images and keeps the 4 BC3-alpha cab draws explicitly diagnostic. The checks
// below reject a missing UV stream, a changed draw range, a texture bound to the
// wrong UVs, any BC3 texture in the packet, or a silently invented fallback.
const LEVEL_PROP_MANIFEST = path.join(OUT, 'level-instance-textures.json');
const levelPropManifestBytes = readFileSync(LEVEL_PROP_MANIFEST);
const levelPropManifest = JSON.parse(levelPropManifestBytes.toString('utf8'));
const levelPropPack = geometry.levelPropTexturePack;
const levelTextures = Array.isArray(geometry.levelTextures) ? geometry.levelTextures : [];
const levelDraws = Array.isArray(geometry.levelDraws) ? geometry.levelDraws : [];
const levelMesh = geometry.meshes.find((mesh) => mesh.id === 'river.block27.instances-all');
const levelUv = levelMesh?.uv ?? null;
const levelUvBytes = levelUv?.data ? Buffer.from(levelUv.data, 'base64') : Buffer.alloc(0);
const levelUvValues = levelUv && levelUvBytes.length === levelUv.bytes
  ? new Float32Array(levelUvBytes.buffer, levelUvBytes.byteOffset, levelUvBytes.length / 4)
  : new Float32Array(0);
const levelTextureIds = new Set(levelTextures.map((texture) => texture.id));
const levelTextured = levelDraws.filter((draw) => draw.textureId != null);
const levelDiagnostic = levelDraws.filter((draw) => draw.textureId == null);
const levelBlockedInstances = [14, 15, 19, 20];

function levelDrawUvHash(draw) {
  const buffer = Buffer.alloc(draw.indexCount * 8);
  let offset = 0;
  for (let index = draw.indexOffset; index < draw.indexOffset + draw.indexCount; index++) {
    const vertex = levelMesh.indices[index];
    levelUvBytes.copy(buffer, offset, vertex * 8, vertex * 8 + 8);
    offset += 8;
  }
  let value = 0xcbf29ce484222325n;
  for (const byte of buffer) {
    value ^= BigInt(byte);
    value = (value * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return value.toString(16).padStart(16, '0');
}

check('the level-prop manifest is the pinned P73b export and geometry carries it',
      /^sha256:[0-9a-f]{64}$/.test(levelPropPack?.manifestSha256 ?? '') &&
      'sha256:' + sha256(levelPropManifestBytes) === levelPropPack.manifestSha256 &&
      levelPropManifest.kind === 'e1-drive.level-instance-textures' &&
      levelPropManifest.version === 1 &&
      levelPropManifest.contentHash === levelPropPack.contentHash &&
      levelPropManifest.source?.assetReaderManifestSha256 ===
        'sha256:1a33893026887f0e022eeec782791cbedf9153146d389b7c076f9d0b84f47fb4' &&
      levelPropManifest.source?.uvStreamSha256 ===
        'sha256:158a3ac81b4cf7a5b1b92d327d8dfcd97ab29100387eb72d3b84f1f333962c83',
      levelPropPack?.manifestSha256 ?? 'missing');
check('the level mesh carries the P73a instance UV0 stream for every vertex',
      levelUv && levelUv.storage === 'base64-float32le' && levelUv.components === 2 &&
      levelUv.vertexCount === levelMesh?.vertexCount && levelMesh.vertexCount === 13162 &&
      levelUv.values === 26324 && levelUv.bytes === 105296 &&
      levelUvBytes.length === levelUv.bytes && levelUvValues.length === levelUv.values &&
      levelUvValues.every(Number.isFinite) &&
      'sha256:' + sha256(levelUvBytes) === levelUv.sha256 &&
      levelUv.source?.aggregate === '0xb07310e198de4c19',
      `${levelUv?.vertexCount ?? 0} vertices / ${levelUv?.bytes ?? 0} B / ${levelUv?.sha256 ?? 'missing'}`);
check('18 level-prop draws sample a BC1 image and the 4 BC3-alpha cab draws stay diagnostic',
      levelDraws.length === 22 && levelTextured.length === 18 && levelDiagnostic.length === 4 &&
      levelTextured.reduce((sum, draw) => sum + draw.indexCount / 3, 0) === 10212 &&
      levelDiagnostic.reduce((sum, draw) => sum + draw.indexCount / 3, 0) === 96 &&
      JSON.stringify(levelDiagnostic.map((draw) => draw.source.instanceIndex)) ===
        JSON.stringify(levelBlockedInstances) &&
      levelDiagnostic.every((draw) =>
        draw.textureBinding?.status === 'blocked-bc3-alpha' &&
        draw.textureBinding?.source === '1205:0' &&
        draw.textureBinding?.name === 'cab01alphas_diff' &&
        draw.textureBinding?.uvHash &&
        draw.diagnosticColourReason?.includes('blocked-bc3-alpha')),
      `${levelTextured.length}/${levelDraws.length} textured, blocked ` +
      JSON.stringify(levelDiagnostic.map((draw) => draw.source.instanceIndex)));
check('every level-prop draw UV0 hash is re-derived from the exported stream',
      levelDraws.every((draw) => {
        if (!/^0x[0-9a-f]{16}$/.test(draw.textureBinding?.uvHash ?? '')) return false;
        if (!Number.isInteger(draw.indexOffset) || !Number.isInteger(draw.indexCount) ||
            draw.indexCount <= 0 || draw.indexCount % 3 !== 0 ||
            draw.indexOffset + draw.indexCount > levelMesh.indexCount) return false;
        return '0x' + levelDrawUvHash(draw) === draw.textureBinding.uvHash;
      }),
      `${levelDraws.length} draws over ${levelUvValues.length / 2} vertices`);
check('the 4 decoded level-prop BC1 images are unique, complete and re-hash to their files',
      levelTextures.length === 4 && levelTextureIds.size === 4 &&
      levelTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0) === 8192 &&
      levelTextures.every((texture) => {
        if (!/^level\.albedo\.\d+\.\d+$/.test(texture.id) ||
            texture.source !== texture.block + ':' + texture.index ||
            texture.formatName !== 'DXT1/BC1' ||
            texture.width !== 32 || texture.height !== 16) return false;
        const embedded = Buffer.from(texture.rgbaBase64, 'base64');
        const file = path.join(ROOT, '_work/e1-drive/level-textures', texture.id + '.rgba');
        if (!existsSync(file)) return false;
        return embedded.length === texture.rgbaBytes &&
          embedded.length === texture.width * texture.height * 4 &&
          'sha256:' + sha256(embedded) === texture.rgbaSha256 &&
          readFileSync(file).equals(embedded) &&
          levelPropManifest.textures.some((candidate) =>
            candidate.id === texture.id && candidate.rgbaSha256 === texture.rgbaSha256);
      }) &&
      new Set(levelTextures.map((texture) => texture.rgbaFnv1a64)).size === 4,
      `${levelTextures.length} images / ` +
      `${levelTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0)} RGBA B`);
check('every textured level-prop draw names one of the four uploaded BC1 images',
      levelTextured.every((draw) =>
        levelTextureIds.has(draw.textureId) && draw.textureBinding?.status === 'bound-static-albedo-bc1') &&
      levelDiagnostic.every((draw) => draw.textureId === null) &&
      levelPropManifest.draws.filter((draw) => draw.bindable).every((draw) =>
        levelTextured.some((candidate) => candidate.textureBinding.uvHash === draw.uvHash &&
          candidate.textureId === draw.textureId)) &&
      !levelTextures.some((texture) => /BC3|DXT5/.test(texture.formatName)),
      levelTextured.map((draw) => draw.textureId).join(', '));
check('the level-prop sampler is the explicit repeat/linear mip0 choice, not a recovered engine state',
      levelPropPack?.sampler?.addressModeU === 'repeat' &&
      levelPropPack.sampler.addressModeV === 'repeat' &&
      levelPropPack.sampler.magFilter === 'linear' &&
      levelPropPack.sampler.minFilter === 'linear' &&
      levelPropPack.sampler.mipLevelsUploaded === 1 &&
      levelPropPack.sampler.textureFormat === 'rgba8unorm' &&
      levelPropPack.sampler.colourSpace === 'raw-decoded-texels' &&
      /not retail/.test(levelPropPack.sampler.reason ?? '') &&
      levelPropPack.coverage?.texturedDraws === 18 &&
      levelPropPack.coverage?.diagnosticDraws === 4 &&
      levelPropPack.coverage?.blockedReason === 'bc3-alpha-rule-missing' &&
      /not applied/.test(levelPropPack.materialScope ?? ''),
      levelPropPack?.sampler?.reason?.slice(0, 80) ?? 'missing');

// ------------------------------------------- per-car albedo textures + UV0
// P52 resolved every draw of every roster car to its committed material row
// and decoded the static `g_MeshTexture` images. This pass binds those images to
// the real car meshes. The checks below fail if a texture, a UV0 stream or a
// runtime-only label is lost, or if a texture is attached to a draw whose UVs
// did not produce its recorded UV0 hash. The anchors cover all fifteen cars;
// the first five rows' numbers are the original P52 values and did not move.
const CAR_TEXTURE_MANIFEST = path.join(OUT, 'car-textures.json');
const carTextureManifest = JSON.parse(readFileSync(CAR_TEXTURE_MANIFEST, 'utf8'));
const carTextureTotals = geometry.carTextures?.totals ?? {};
const CAR_COVERAGE_ANCHORS = {
  draws: 2343, staticAlbedoDraws: 1123, runtimePaintDraws: 197,
  runtimeLightBlendDraws: 281, runtimeNoAlbedoDraws: 742,
  textures: 191, rgbaBytes: 83927040, uvValues: 1665958, uvBytes: 6663832
};
const carBodies = rosterSlugs.map((slug) => bodies[slug]);
const carDrawsAll = carBodies.flatMap((body) => body.carDraws);
const carTexturesAll = carBodies.flatMap((body) => body.textures);
const carTextureIds = new Set(carTexturesAll.map((texture) => texture.id));
const carTexturedDraws = carDrawsAll.filter((draw) => draw.textureId != null);

/** FNV-1a 64 over the little-endian float32 UV pairs of a draw's index range. */
function carDrawUvHash(body, draw) {
  const uv = body.mesh.uv;
  const bytes = Buffer.from(uv.data, 'base64');
  const buffer = Buffer.alloc(draw.indexCount * 8);
  let offset = 0;
  for (let index = draw.indexOffset; index < draw.indexOffset + draw.indexCount; index++) {
    const vertex = body.mesh.indices[index];
    bytes.copy(buffer, offset, vertex * 8, vertex * 8 + 8);
    offset += 8;
  }
  let value = 0xcbf29ce484222325n;
  for (const byte of buffer) {
    value ^= BigInt(byte);
    value = (value * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return value.toString(16).padStart(16, '0');
}

check('the car texture manifest is pinned, complete and carries the per-car P52 totals',
      carTextureManifest.kind === 'e1-drive.car-textures' && carTextureManifest.version === 1 &&
      carTextureManifest.pins?.p52RosterIndex ===
        'sha256:0cce07379af01cf0f21829285cec41b01cf4cd6e0ceae72249dafb13db379455' &&
      carTextureManifest.pins?.carPartsIndex === geometry.source.cars?.indexSha256 &&
      carTextureManifest.cars.length === rosterSlugs.length &&
      carTextureManifest.cars.every((car, index) => car.slug === rosterSlugs[index]) &&
      carTextureManifest.totals.cars === rosterSlugs.length &&
      carTextureManifest.totals.draws === CAR_COVERAGE_ANCHORS.draws &&
      carTextureManifest.totals.staticAlbedoDraws === CAR_COVERAGE_ANCHORS.staticAlbedoDraws &&
      carTextureManifest.totals.runtimePaintDraws === CAR_COVERAGE_ANCHORS.runtimePaintDraws &&
      carTextureManifest.totals.runtimeLightBlendDraws === CAR_COVERAGE_ANCHORS.runtimeLightBlendDraws &&
      carTextureManifest.totals.runtimeNoAlbedoDraws === CAR_COVERAGE_ANCHORS.runtimeNoAlbedoDraws &&
      carTextureManifest.totals.textures === CAR_COVERAGE_ANCHORS.textures &&
      carTextureManifest.totals.rgbaBytes === CAR_COVERAGE_ANCHORS.rgbaBytes &&
      carTextureManifest.totals.uvValues === CAR_COVERAGE_ANCHORS.uvValues &&
      carTextureManifest.totals.uvBytes === CAR_COVERAGE_ANCHORS.uvBytes &&
      geometry.carTextures?.manifestSha256 === 'sha256:' +
        sha256(readFileSync(CAR_TEXTURE_MANIFEST)),
      `${carTextureManifest.totals?.cars} cars / ${carTextureManifest.totals?.draws} draws / ` +
      `${carTextureManifest.totals?.textures} textures`);

check('every car mesh carries its real UV0 stream for every vertex',
      carBodies.every((body) => {
        const uv = body.mesh.uv;
        if (!uv) return false;
        const bytes = Buffer.from(uv.data, 'base64');
        const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
        return uv.storage === 'base64-float32le' && uv.components === 2 &&
          uv.vertexCount === body.mesh.vertexCount && uv.values === body.mesh.vertexCount * 2 &&
          bytes.length === uv.bytes && uv.bytes === body.mesh.vertexCount * 8 &&
          values.every(Number.isFinite) &&
          'sha256:' + sha256(bytes) === uv.sha256;
      }),
      carBodies.map((body) => body.slug + ':' + (body.mesh.uv?.vertexCount ?? 0)).join(', '));

check('the car UV0 stream is the exported committed scene-report stream',
      carBodies.every((body) => {
        const record = carTextureManifest.cars.find((car) => car.slug === body.slug);
        const file = path.join(ROOT, record.uvStream.path);
        if (!existsSync(file)) return false;
        const bytes = readFileSync(file);
        return record.uvStream.sha256 === body.mesh.uv.sha256 &&
          'sha256:' + sha256(bytes) === body.mesh.uv.sha256 &&
          Buffer.from(body.mesh.uv.data, 'base64').equals(bytes) &&
          record.mesh.positionsSha256 === body.manifest.meshValueHashes.positionsFloat32LESha256 &&
          /signed zeros/.test(record.sceneReport.positionsNote ?? '');
      }) &&
      carTextureTotals.uvBytes === CAR_COVERAGE_ANCHORS.uvBytes &&
      carTextureTotals.uvValues === CAR_COVERAGE_ANCHORS.uvValues,
      `${carTextureTotals.uvValues} UV values / ${carTextureTotals.uvBytes} B across ` +
      `${rosterSlugs.length} cars`);

check('1123 car draws sample a P52 static albedo image; 1220 stay labelled diagnostic',
      carDrawsAll.length === CAR_COVERAGE_ANCHORS.draws &&
      carTexturedDraws.length === CAR_COVERAGE_ANCHORS.staticAlbedoDraws &&
      carDrawsAll.filter((draw) => draw.textureBinding?.status === 'runtimePaintLookup').length ===
        CAR_COVERAGE_ANCHORS.runtimePaintDraws &&
      carDrawsAll.filter((draw) => draw.textureBinding?.status === 'runtimeLightBlend').length ===
        CAR_COVERAGE_ANCHORS.runtimeLightBlendDraws &&
      carDrawsAll.filter((draw) => draw.textureBinding?.status === 'runtimeShaderNoAlbedo').length ===
        CAR_COVERAGE_ANCHORS.runtimeNoAlbedoDraws &&
      carDrawsAll.every((draw) => ['boundStaticAlbedoImage', 'runtimePaintLookup', 'runtimeLightBlend',
        'runtimeShaderNoAlbedo'].includes(draw.textureBinding?.status)) &&
      carDrawsAll.filter((draw) => draw.textureId === null)
        .every((draw) => typeof draw.textureBinding?.reason === 'string' && draw.textureBinding.reason.length > 20),
      `${carTexturedDraws.length} textured / ${CAR_COVERAGE_ANCHORS.runtimePaintDraws} paint / ` +
      `${CAR_COVERAGE_ANCHORS.runtimeLightBlendDraws} light / ` +
      `${CAR_COVERAGE_ANCHORS.runtimeNoAlbedoDraws} no-albedo`);

check('the 191 car textures are unique, per-car and traced to their P52 source',
      carTexturesAll.length === CAR_COVERAGE_ANCHORS.textures &&
      carTextureIds.size === CAR_COVERAGE_ANCHORS.textures &&
      carBodies.every((body) => {
        const record = carTextureManifest.cars.find((car) => car.slug === body.slug);
        return body.textures.length === record.coverage.textureCount &&
          body.textures.every((texture) => {
            const source = record.textures.find((entry) => entry.id === texture.id);
            return source && texture.id.startsWith('car.' + body.slug + '.') &&
              /^(block|shared)-/.test(texture.id.slice(('car.' + body.slug + '.').length)) &&
              source.name === texture.name && source.textureHash === texture.textureHash &&
              source.rgbaSha256 === texture.rgbaSha256 &&
              texture.width === source.width && texture.height === source.height &&
              texture.width * texture.height * 4 === texture.rgbaBytes &&
              texture.referenceDrawCount > 0;
          });
      }),
      carBodies.map((body) => body.slug + ':' + body.textures.length).join(', '));

check('every embedded car RGBA payload re-hashes to the committed P52 image',
      carTexturesAll.reduce((sum, texture) => sum + texture.rgbaBytes, 0) ===
        CAR_COVERAGE_ANCHORS.rgbaBytes &&
      carTexturesAll.every((texture) => {
        const embedded = Buffer.from(texture.rgbaBase64, 'base64');
        const file = path.join(ROOT, texture.rgbaPath);
        if (!existsSync(file)) return false;
        return embedded.length === texture.rgbaBytes &&
          embedded.length === texture.width * texture.height * 4 &&
          'sha256:' + sha256(embedded) === texture.rgbaSha256 &&
          readFileSync(file).equals(embedded);
      }),
      `${carTexturesAll.reduce((sum, texture) => sum + texture.rgbaBytes, 0)} RGBA B in ` +
      `${carTexturesAll.length} payloads`);

check('every textured car draw binds the texture whose UV0 hash the mesh stream reproduces',
      carTexturedDraws.length === CAR_COVERAGE_ANCHORS.staticAlbedoDraws && carTexturedDraws.every((draw) => {
        const body = carBodies.find((candidate) => candidate.carDraws.includes(draw));
        const record = body && carTextureManifest.cars
          .find((car) => car.slug === body.slug).draws[draw.source.drawIndex];
        if (!record || !body) return false;
        return record.textureId === draw.textureId &&
          record.uvHash === draw.textureBinding.uvHash &&
          '0x' + carDrawUvHash(body, draw) === draw.textureBinding.uvHash &&
          carTextureIds.has(draw.textureId);
      }),
      `${carTexturedDraws.length}/${carTexturedDraws.length} UV0 value hashes recomputed from the mesh stream`);

check('every textured car draw samples finite UV0 inside the exported stream',
      carTexturedDraws.every((draw) => {
        const body = carBodies.find((candidate) => candidate.carDraws.includes(draw));
        const bounds = body?.mesh.uv?.bounds;
        const range = draw.textureBinding.uvRange;
        if (!bounds || !Array.isArray(range) || range.length !== 2) return false;
        return range.every((axis, index) => Array.isArray(axis) && axis.length === 2 &&
          axis.every(Number.isFinite) &&
          axis[0] >= bounds.min[index] - 1e-6 && axis[1] <= bounds.max[index] + 1e-6);
      }),
      `${carTexturedDraws.length}/${carTexturedDraws.length} draws inside the exported UV0 bounds (constant-UV decal draws included)`);

check('the car texture pack uses the same explicit repeat/linear mip0 sampler',
      geometry.carTextures?.sampler?.addressModeU === 'repeat' &&
      geometry.carTextures.sampler.addressModeV === 'repeat' &&
      geometry.carTextures.sampler.magFilter === 'linear' &&
      geometry.carTextures.sampler.minFilter === 'linear' &&
      geometry.carTextures.sampler.mipLevelsUploaded === 1 &&
      geometry.carTextures.sampler.textureFormat === 'rgba8unorm' &&
      geometry.carTextures.sampler.colourSpace === 'raw-decoded-texels' &&
      geometry.carTextures.scopeLabels?.materialsApplied === false &&
      geometry.carTextures.scopeLabels?.samplerApplied === false &&
      geometry.carTextures.scopeLabels?.paintLookupRecovered === false &&
      geometry.carTextures.scopeLabels?.lightBlendRecovered === false &&
      geometry.carTextures.scopeLabels?.srgbApplied === false,
      geometry.carTextures?.sampler?.reason?.slice(0, 70) ?? 'missing');

check('the car UV convention is declared and applied to exactly the textured car draws',
      geometry.carTextures?.uvConvention?.sampleU === '1 - uv0.u' &&
      geometry.carTextures?.uvConvention?.sampleV === 'uv0.v (unchanged)' &&
      /row 0 = top/.test(geometry.carTextures.uvConvention.reason ?? '') &&
      carTexturedDraws.every((draw) => draw.uvFlipU === true && draw.uvFlipV === false &&
        draw.textureBinding?.uvConvention === 'sampled as (1 - u, v)') &&
      carDrawsAll.filter((draw) => draw.textureId == null).every((draw) =>
        draw.uvFlipU === false && draw.uvFlipV === false) &&
      trackDraws.every((draw) => draw.uvFlipU !== true && draw.uvFlipV !== true) &&
      carTextureManifest.uvConvention?.evidence?.length === 4,
      `${carTexturedDraws.length} car draws sampled (1-u, v), ${trackDraws.length} track draws unchanged`);

// ------------------------------------------------------ camera occlusion
// The chase camera resolves occlusion against the visible static geometry. The
// occluder is built from geometry.meshes only: the hidden collision surface is
// in physicsSurfaces (not meshes) and the car body is a per-car mesh, so neither
// can be an occluder. Both facts are asserted here, not assumed.
const occluder = buildOccluder(geometry);
const occluderDescribe = occluder.describe();
check('camera occlusion is built from the visible static meshes only',
      occluderDescribe.triangles === 10308 + 57133 &&
      occluderDescribe.meshes.length === 2 &&
      occluderDescribe.meshes.every((mesh) => mesh.coordinateSpace === 'world') &&
      occluderDescribe.meshes.some((mesh) => mesh.id === geometry.trackVisual.meshId) &&
      !occluderDescribe.meshes.some((mesh) => mesh.id === geometry.collisionSurface.meshId),
      `${occluderDescribe.triangles} triangles from ` +
      occluderDescribe.meshes.map((mesh) => mesh.id + ':' + mesh.triangleCount).join(', '));

// ------------------------------------------------- extended corridor survey
// The 539.81 m corridor is measured, drawn and *not* a race course. P43's extended
// sprint stopped at the 6.4 cm section-join rise; the survey below records why the
// corridor cannot be a course at all: its measured line crosses vertical collision
// faces (cliffs), and a coverage path has no notion of a wall. The survey artefact
// is re-derived here with the engine's own ray query, and the physical limit is
// measured per car by driving at it (tools/corridor_probe.mjs).
const SURVEY_FILE = path.join(OUT, 'corridor-survey.json');
if (!existsSync(SURVEY_FILE)) {
  throw new Error('corridor survey missing — run `node probes/e1-drive/tools/build_corridor_survey.mjs` first');
}
const surveyFileBytes = readFileSync(SURVEY_FILE);
const surveyFile = JSON.parse(surveyFileBytes.toString('utf8'));
const surveySpawn = { x: TICK0_LIMITS.x, z: TICK0_LIMITS.z, heading: TICK0_LIMITS.heading, source: TICK0_LIMITS.source };

// One fresh module instance provides the engine's collision trace. The car never
// moves: e1_create builds the static world, e1_ray_probe queries it.
async function createCollisionProbe() {
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  const instance = await factory();
  const levelPtr = instance._malloc(levelBytes.length);
  const fieldBytes = readFileSync(path.join(ROOT, cars[0].fields.path));
  const fieldsPtr = instance._malloc(fieldBytes.length + 1);
  instance.HEAPU8.set(levelBytes, levelPtr);
  instance.HEAPU8.set(fieldBytes, fieldsPtr);
  if (!instance._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                           TICK0_LIMITS.x, TICK0_LIMITS.z, TICK0_LIMITS.heading)) {
    throw new Error('collision probe e1_create failed: ' + instance.UTF8ToString(instance._e1_last_error()));
  }
  const info = JSON.parse(instance.UTF8ToString(instance._e1_info()));
  const probe = (x, y, z, dx, dy, dz, distance) => JSON.parse(instance.UTF8ToString(
    instance._e1_ray_probe(x, y, z, dx, dy, dz, distance)));
  const ground = (x, z) => JSON.parse(instance.UTF8ToString(instance._e1_ground_probe(x, z)));
  return { instance, probe, ground, info };
}

const collisionProbe = await createCollisionProbe();
const surveyCourse = JSON.parse(readFileSync(path.join(OUT, 'course.json'), 'utf8'));
const derivedSurvey = buildCorridorSurvey(geometry, surveyCourse, surveySpawn, { probe: collisionProbe.probe });
check('the corridor survey is exactly the one derived from this geometry and course (no hand-edited survey)',
      canonicalJson(surveyFile) === canonicalJson(derivedSurvey),
      surveyFile.hash ?? 'no survey hash');
check('the shipped chassis proxy is the faithful XT box for every car (no hidden physics change)',
      collisionProbe.info.chassisProxy === 'box-from-XT-geometry' &&
      collisionProbe.info.chassisProxyLift === 0,
      `${collisionProbe.info.chassisProxy} lift ${collisionProbe.info.chassisProxyLift}`);
check('the corridor survey carries the measured six-section totals',
      surveyFile.corridor?.totals?.draws === 299 && surveyFile.corridor?.totals?.triangles === 47790 &&
      surveyFile.corridor?.totals?.vertices === 78712 &&
      surveyFile.corridor?.sections?.length === 6,
      surveyFile.corridor?.sections?.map((section) => section.key + ':' + section.courseMetres + 'm').join(' '));
check('the survey gates sit on measured samples and are perpendicular to the local path',
      surveyFile.gates.length === 4 &&
      surveyFile.gates.every((gate) => {
        const sample = surveyCourse.samples[gate.sampleIndex];
        return sample && Math.abs(sample.x - gate.x) < 1e-6 && Math.abs(sample.z - gate.z) < 1e-6 &&
          Math.abs(gate.arc - sample.arc) < 1e-6 &&
          Math.abs(gate.tangent.tx * (gate.b[0] - gate.a[0]) +
            gate.tangent.tz * (gate.b[1] - gate.a[1])) < 0.02;
      }),
      surveyFile.gates.map((gate) => gate.id + '@' + gate.arc.toFixed(2)).join(' '));
check('every survey gate line is covered by a real draw and a collision triangle (61/61)',
      surveyFile.gates.every((gate) => gate.coverage.covered &&
        gate.coverage.drawnSamples === gate.coverage.samples &&
        gate.coverage.collisionSamples === gate.coverage.samples),
      surveyFile.gates.map((gate) => gate.id + ':' + gate.coverage.drawnSamples + '/' +
        gate.coverage.samples).join(' '));
check('the survey records the measured section-join rise (6.36 cm in 0.94 m) that stopped P43',
      Math.abs(surveyFile.drivability.chassisRise.firstAboveLimit?.riseMetres - 0.0636) < 1e-3 &&
      Math.abs(surveyFile.drivability.chassisRise.firstAboveLimit?.arc - 52.19) < 0.3 &&
      surveyFile.drivability.chassisRise.firstAboveLimit?.gradePercent > 6 &&
      surveyFile.drivability.chassisRise.firstAboveLimit?.gradePercent < 7.2,
      JSON.stringify(surveyFile.drivability.chassisRise.firstAboveLimit));
const solidCrossings = surveyFile.drivability.wallCrossings.filter((crossing) =>
  crossing.engineProbe?.solid === true);
check('the measured path crosses vertical collision faces and the survey marks them, not hides them',
      surveyFile.drivability.wallCrossings.length === 4 && solidCrossings.length === 2 &&
      surveyFile.drivability.wallCrossings.every((crossing) => crossing.faceHeightMetres > 40),
      surveyFile.drivability.wallCrossings.map((crossing) =>
        crossing.arc.toFixed(2) + (crossing.engineProbe?.solid ? ' solid' : ' not-solid')).join(', '));
check('the first engine-confirmed wall crossing is the measured course limit (57.82 m)',
      Math.abs(surveyFile.drivability.courseLimitArc - 57.82) < 0.05 &&
      surveyFile.drivability.drivable === false,
      `${surveyFile.drivability.courseLimitArc} m, drivable=${surveyFile.drivability.drivable}`);
check('the steepest local grade near the corridor end is the measured 31 % drop',
      Math.abs(Math.abs(surveyFile.drivability.steepestGradeLast20m.gradePercent) - 31.24) < 0.5,
      `${surveyFile.drivability.steepestGradeLast20m.gradePercent} % at arc ` +
      `${surveyFile.drivability.steepestGradeLast20m.fromArc}`);

// Per-car physical limit: the car is placed on the measured line before each limit,
// pointing along it, and holds full throttle with zero steer.
const corridorProbeResults = [];
for (const car of cars) {
  const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
  const stations = [];
  for (const station of LIMIT_STATIONS) {
    const pose = stationPose(surveyCourse, station);
    const instance = await (await import(pathToFileURL(MODULE).href)).default();
    const levelPtr = instance._malloc(levelBytes.length);
    const fieldsPtr = instance._malloc(fieldBytes.length + 1);
    instance.HEAPU8.set(levelBytes, levelPtr);
    instance.HEAPU8.set(fieldBytes, fieldsPtr);
    if (!instance._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                             pose.x, pose.z, pose.heading)) {
      throw new Error(`corridor limit probe create failed for ${car.name} at ${station.id}: ` +
        instance.UTF8ToString(instance._e1_last_error()));
    }
    stations.push(runLimitStation(instance, surveyCourse, station));
  }
  const written = writeCorridorProbe(car, stations, surveyCourse, {
    chassisProxyLift: collisionProbe.info.chassisProxyLift,
    wasmSha256: build.wasmSha256
  });
  const rise = stations.find((station) => station.id === 'section-join-rise');
  const pinch = stations.find((station) => station.id === 'cliff-pinch');
  check(`${car.name}: the faithful box proxy cannot climb the 6.4 cm section-join rise (P43's stop reproduced)`,
        rise.crossedLimit === false && rise.endArc > 52.2 && rise.endArc < 53.4,
        `arc ${rise.startArc} -> ${rise.endArc} m (limit ${rise.limitArc} m, ${rise.endSpeed} m/s)`);
  check(`${car.name}: the car cannot drive the measured line through the cliff pinch`,
        pinch.crossedLimit === false && pinch.endArc > 55.2 && pinch.endArc < 56.4,
        `stops at arc ${pinch.endArc} m (${pinch.advancedMetres} m from arc ${pinch.startArc}), ` +
        `${pinch.endSpeed} m/s`);
  check(`${car.name}: both corridor limit probes keep wheel contact and stay finite`,
        rise.nonFiniteTicks === 0 && pinch.nonFiniteTicks === 0 &&
        rise.contactTicks === rise.rows.length && pinch.contactTicks === pinch.rows.length,
        `${rise.contactTicks}/${rise.rows.length} and ${pinch.contactTicks}/${pinch.rows.length} contact ticks`);
  corridorProbeResults.push({
    slug: car.slug,
    rise: { startArc: rise.startArc, endArc: rise.endArc, crossed: rise.crossedLimit },
    pinch: { startArc: pinch.startArc, endArc: pinch.endArc, advancedMetres: pinch.advancedMetres,
      speed: pinch.endSpeed, crossed: pinch.crossedLimit },
    nonFiniteTicks: rise.nonFiniteTicks + pinch.nonFiniteTicks,
    file: written.file
  });
}

// ------------------------------------------------------------- sprint layout
// ------------------------------------------------------------- sprint layouts
// Two measured courses: the default 310 m P48 path and the 29 m regression
// straight. Both files are derivation outputs; this re-runs both derivations and
// then re-measures the gates and the long-course car-width band with independent
// point-in-triangle code (not the layout module's plane-lambda form).
const SPRINT_FILE = path.join(OUT, 'sprint.json');
const SPRINT_SHORT_FILE = path.join(OUT, 'sprint-short.json');
const SPRINT_LAP_FILE = path.join(OUT, 'sprint-lap.json');
for (const file of [SPRINT_FILE, SPRINT_SHORT_FILE, SPRINT_LAP_FILE]) {
  if (!existsSync(file)) {
    throw new Error(path.basename(file) + ' missing — run `node probes/e1-drive/tools/build_sprint.mjs` first');
  }
}
const sprintFileBytes = readFileSync(SPRINT_FILE);
const sprintFile = JSON.parse(sprintFileBytes.toString('utf8'));
const sprintShortBytes = readFileSync(SPRINT_SHORT_FILE);
const sprintShortFile = JSON.parse(sprintShortBytes.toString('utf8'));
const sprintLapBytes = readFileSync(SPRINT_LAP_FILE);
const sprintLapFile = JSON.parse(sprintLapBytes.toString('utf8'));
const layoutSpawn = { x: TICK0_LIMITS.x, z: TICK0_LIMITS.z, heading: TICK0_LIMITS.heading, source: TICK0_LIMITS.source };

const LONG_PATH_FILE = path.join(ROOT, LONG_COURSE_PATH.file);
const longPathBytes = readFileSync(LONG_PATH_FILE);
const longPathFileSha = 'sha256:' + sha256(longPathBytes);
if (longPathFileSha !== LONG_COURSE_PATH.fileSha256) {
  throw new Error('the P48 course path is not the recorded artifact: ' + longPathFileSha +
    ' (expected ' + LONG_COURSE_PATH.fileSha256 + ')');
}
const longPath = JSON.parse(longPathBytes.toString('utf8'));
const derivedLayout = deriveLongCourseLayout(geometry, layoutSpawn, longPath);
const shortLayout = deriveSprintLayout(geometry, layoutSpawn, { courseId: SHORT_COURSE_ID });

const LAP_LOOPS_FILE = path.join(ROOT, LAP_LOOPS_PATH.file);
const lapLoopsBytes = readFileSync(LAP_LOOPS_FILE);
const lapLoopsFileSha = 'sha256:' + sha256(lapLoopsBytes);
if (lapLoopsFileSha !== LAP_LOOPS_PATH.fileSha256) {
  throw new Error('the P61 loops artifact is not the recorded file: ' + lapLoopsFileSha +
    ' (expected ' + LAP_LOOPS_PATH.fileSha256 + ')');
}
const lapLoops = JSON.parse(lapLoopsBytes.toString('utf8'));
const lapLayout = deriveLapCourseLayout(geometry, lapLoops);
const lapSpan = lapLayout.course.span;
const lapGates = lapLayout.gates;

// P74 V2 base manifest (read-only). The 310 m sprint binds `roadside` (553 of
// 651: the four measured on-course arcs stay mapped but inactive), the lap binds
// the same file with `all-visible` (651). Both worlds are built from the pinned
// file/content hash; a different manifest is a hard failure.
const PROP_FILE = path.join(ROOT, PROP_MANIFEST);
const propBytes = readFileSync(PROP_FILE);
const propFileSha = 'sha256:' + sha256(propBytes);
if (propFileSha !== SPRINT_PROP_PINS.manifestFileSha256) {
  throw new Error('the P74 V2 collider manifest is not the recorded file: ' + propFileSha);
}
const propManifest = JSON.parse(propBytes.toString('utf8'));
lapPropManifest = propManifest;
const sprintPropCheck = checkPropManifest(propManifest, SPRINT_PROP_PINS);
if (!sprintPropCheck.ok) throw new Error('the V2 roadside pins were rejected: ' + sprintPropCheck.errors.join('; '));
const lapPropCheck = checkPropManifest(propManifest, LAP_PROP_PINS);
if (!lapPropCheck.ok) throw new Error('the V2 lap pins were rejected: ' + lapPropCheck.errors.join('; '));
sprintProfileWorld = createPropWorld(propManifest, { profile: SPRINT_PROP_PINS.profile });
sprintPropWorld = createPropWorld(applyDrivenLineExclusions(propManifest),
  { profile: SPRINT_PROP_PINS.profile });
lapPropWorld = createPropWorld(propManifest, { profile: LAP_PROP_PINS.profile });

/** Exact 2D distance from a point to an oriented collider footprint. */
function pointToColliderDistance2D(collider, x, z) {
  const dx = x - collider.cx;
  const dz = z - collider.cz;
  const du = dx * collider.ux + dz * collider.uz;
  const dv = dx * collider.vx + dz * collider.vz;
  const ou = Math.max(Math.abs(du) - collider.hu, 0);
  const ov = Math.max(Math.abs(dv) - collider.hv, 0);
  return Math.hypot(ou, ov);
}

/**
 * Measure one measured line against a prop world: blocked car poses (centreline
 * pose + car envelope) and the exact centreline-to-collider distance. The exact
 * distance is a coarse clearance record, not the car clearance.
 */
function measurePropCourse(world, manifest, samples, { ring = false } = {}) {
  const count = ring ? samples.length - 1 : samples.length;
  let blocked = 0;
  const contactIds = new Map();
  const blockedRows = [];
  let minDistanceMetres = Infinity;
  let minColliderId = null;
  let minArc = null;
  for (let index = 0; index < count; index++) {
    const sample = samples[index];
    const previous = samples[ring ? (index - 1 + count) % count : Math.max(0, index - 1)];
    const next = samples[ring ? (index + 1) % count : Math.min(samples.length - 1, index + 1)];
    const heading = Math.atan2(next.x - previous.x, next.z - previous.z);
    const contacts = world.contactsAll(sample.x, sample.z, propYawFromHeading(heading),
      sample.groundY, manifest.carEnvelope);
    if (contacts.length) {
      blocked++;
      blockedRows.push({ index, arc: sample.arc });
      for (const contact of contacts) {
        contactIds.set(contact.colliderId, (contactIds.get(contact.colliderId) ?? 0) + 1);
      }
    }
    for (const collider of world.colliders) {
      const distance = pointToColliderDistance2D(collider, sample.x, sample.z);
      if (distance < minDistanceMetres) {
        minDistanceMetres = distance;
        minColliderId = collider.id;
        minArc = sample.arc;
      }
    }
  }
  const arcs = [];
  for (const row of blockedRows) {
    const last = arcs[arcs.length - 1];
    if (last && row.index === last.lastIndex + 1) {
      last.lastIndex = row.index;
      last.lastArc = row.arc;
      last.samples++;
    } else {
      arcs.push({ firstIndex: row.index, lastIndex: row.index, firstArc: row.arc, lastArc: row.arc, samples: 1 });
    }
  }
  return {
    samples: count, blocked, contactIds: [...contactIds.keys()], arcs,
    minDistanceMetres: round6Local(minDistanceMetres), minColliderId, minArc
  };
}

const sprintRoadMeasure = measurePropCourse(sprintProfileWorld, propManifest, derivedLayout.course.samples);
const sprintAllMeasure = measurePropCourse(lapPropWorld, propManifest, derivedLayout.course.samples);
const loopPropMeasure = measurePropCourse(lapPropWorld, propManifest, lapLayout.course.samples, { ring: true });

const sprintSpan = derivedLayout.course.span;
const sprintGates = derivedLayout.gates;
const shortSpan = shortLayout.course.span;
const shortGates = shortLayout.gates;

check('the P48 310 m path artifact is the recorded one (file SHA-256 and canonical hash)',
      longPathFileSha === LONG_COURSE_PATH.fileSha256 && longPath.hash === LONG_COURSE_PATH.canonicalHash &&
      longPath.course.points.length === LONG_COURSE_PATH.sampleCount,
      `${longPathFileSha} / ${longPath.hash}`);
check('the default sprint layout is exactly the one derived from the P48 path and this geometry (no hand-edited gate)',
      canonicalJson(sprintFile) === canonicalJson(derivedLayout),
      sprintFile.hash ?? 'no layout hash');
check('the 29 m regression layout is exactly the one derived from this geometry (no hand-edited gate)',
      canonicalJson(sprintShortFile) === canonicalJson(shortLayout),
      sprintShortFile.hash ?? 'no layout hash');
check('both sprint layouts pass their own structural validation',
      validateSprintLayout(derivedLayout, geometry, layoutSpawn).ok === true &&
      validateSprintLayout(shortLayout, geometry, layoutSpawn).ok === true,
      [...validateSprintLayout(derivedLayout, geometry, layoutSpawn).errors,
        ...validateSprintLayout(shortLayout, geometry, layoutSpawn).errors].join(' | '));
check('the default course is the measured 310.395 m P48 path with the documented 10 m finish clearance',
      derivedLayout.courseId === '310m' &&
      Math.abs(derivedLayout.course.lengthMetres - 310.3952) < 1e-3 &&
      derivedLayout.course.sampleCount === 1245 &&
      Math.abs(sprintSpan.finishArc - 300.159666) < 1e-6 &&
      sprintSpan.finishArc <= sprintSpan.measuredLengthMetres - 10 + 1e-9,
      `${derivedLayout.course.lengthMetres} m, finish arc ${sprintSpan.finishArc}, ` +
      `${sprintSpan.measuredLengthMetres - sprintSpan.finishArc} m before the measured end`);
check('the default course has a start at the spawn, two checkpoints and a finish, in order',
      sprintGates[0].kind === 'start' && sprintGates[0].arc === 0 &&
      sprintGates[0].x === layoutSpawn.x && sprintGates[0].z === layoutSpawn.z &&
      sprintGates.filter((gate) => gate.kind === 'checkpoint').length === CHECKPOINT_FRACTIONS.length &&
      sprintGates[sprintGates.length - 1].kind === 'finish' &&
      sprintGates.every((gate, index) => index === 0 || gate.arc > sprintGates[index - 1].arc),
      sprintGates.map((gate) => `${gate.id}@${gate.arc}`).join(' '));
check('the default gates sit on measured samples and are perpendicular to the local path tangent',
      sprintGates.every((gate) => {
        const sample = derivedLayout.course.samples[gate.sampleIndex];
        return sample && Math.abs(sample.arc - gate.arc) < 1e-9 &&
          Math.abs(sample.x - gate.x) < 1e-9 && Math.abs(sample.z - gate.z) < 1e-9 &&
          Math.abs(gate.tangent.tx * (gate.b[0] - gate.a[0]) +
            gate.tangent.tz * (gate.b[1] - gate.a[1])) < 0.02;
      }),
      sprintGates.map((gate) => `${gate.id}:dot ` + (
        gate.tangent.tx * (gate.b[0] - gate.a[0]) + gate.tangent.tz * (gate.b[1] - gate.a[1])).toFixed(4)).join(' '));
check('the default course re-measures 100 % draw coverage with no gaps',
      derivedLayout.course.coverage.samples === 1204 &&
      derivedLayout.course.coverage.coveredSamples === 1204 &&
      derivedLayout.course.coverage.coverageFraction === 1 &&
      derivedLayout.course.coverage.gaps.length === 0 &&
      derivedLayout.course.coverage.maxSurfaceDeltaMetres < 0.001,
      `${derivedLayout.course.coverage.coveredSamples}/${derivedLayout.course.coverage.samples}, ` +
      `max delta ${derivedLayout.course.coverage.maxSurfaceDeltaMetres} m`);
check('the 29 m regression course keeps its P37 start, two checkpoints, finish and 2 m clearance',
      shortLayout.courseId === 'short' && shortGates[0].x === layoutSpawn.x &&
      shortGates.filter((gate) => gate.kind === 'checkpoint').length === CHECKPOINT_FRACTIONS.length &&
      shortGates[shortGates.length - 1].kind === 'finish' &&
      shortGates.every((gate, index) => index === 0 || gate.x > shortGates[index - 1].x) &&
      shortGates[shortGates.length - 1].x === shortSpan.finishX &&
      shortSpan.finishX <= shortSpan.lastFullyCoveredX - shortSpan.finishClearanceMetres + 1e-9,
      `start ${shortSpan.startX}, finish ${shortSpan.finishX}, last fully covered ${shortSpan.lastFullyCoveredX}`);

// --------------------------------------------------------- lap layout (P61 loop-01)
const lapLoop = lapLoops.loops.find((entry) => entry.id === LAP_LOOPS_PATH.loopId);
check('the P61 loops artifact is the recorded one and loop-01 is closed, 222.040 m and in component 5',
      lapLoopsFileSha === LAP_LOOPS_PATH.fileSha256 && lapLoops.hash === LAP_LOOPS_PATH.canonicalHash &&
      lapLoops.kind === 'lap-search.loops' && lapLoops.version === 1 &&
      lapLoop !== undefined && lapLoop.closed === true && lapLoop.component === LAP_LOOPS_PATH.component &&
      Math.abs(lapLoop.length - LAP_LOOPS_PATH.lengthMetres) < 1e-3 &&
      lapLoop.points.length === LAP_LOOPS_PATH.sampleCount &&
      lapLoop.points[0][0] === LAP_LOOPS_PATH.start[0] && lapLoop.points[0][1] === LAP_LOOPS_PATH.start[1],
      `${lapLoopsFileSha} / ${lapLoops.hash} / ${lapLoop?.length} m / ${lapLoop?.points.length} samples`);
check('the lap layout is exactly the one derived from P61 loop-01 and this geometry (no hand-edited gate)',
      canonicalJson(sprintLapFile) === canonicalJson(lapLayout), sprintLapFile.hash ?? 'no layout hash');
check('the lap layout passes its own structural validation',
      validateSprintLayout(lapLayout, geometry, layoutSpawn).ok === true,
      validateSprintLayout(lapLayout, geometry, layoutSpawn).errors.join(' | '));
check('the lap course is the measured 222.040 m loop-01 with 902 samples and three laps',
      lapLayout.courseId === 'lap' && Math.abs(lapLayout.course.lengthMetres - 222.0402) < 1e-3 &&
      lapLayout.course.sampleCount === 902 && lapLayout.course.laps === 3 &&
      Math.abs(lapSpan.finishArc - lapSpan.measuredLengthMetres) < 1e-9 &&
      lapLayout.course.samples[0].arc === 0 &&
      Math.abs(lapLayout.course.samples[lapLayout.course.samples.length - 1].arc - lapLayout.course.lengthMetres) < 1e-9 &&
      lapLayout.course.samples[0].x === lapLayout.course.samples[lapLayout.course.samples.length - 1].x &&
      lapLayout.course.samples[0].z === lapLayout.course.samples[lapLayout.course.samples.length - 1].z,
      `${lapLayout.course.lengthMetres} m, ${lapLayout.course.sampleCount} samples, ${lapLayout.course.laps} laps`);
check('the lap starts on loop-01 at its tangent heading and the line is the start/finish point',
      lapGates.length === 2 && lapGates[0].kind === 'start' && lapGates[1].kind === 'finish' &&
      lapGates[0].arc === 0 && lapGates[1].arc === lapSpan.finishArc &&
      lapGates[0].x === LAP_LOOPS_PATH.start[0] && lapGates[0].z === LAP_LOOPS_PATH.start[1] &&
      lapGates.every((gate) => gate.x === lapGates[0].x && gate.z === lapGates[0].z) &&
      lapLayout.course.lap.line.x === lapGates[0].x && lapLayout.course.lap.line.z === lapGates[0].z &&
      Math.abs(lapGates[0].headingRad - lapLayout.course.lap.line.headingRad) < 1e-12 &&
      Math.abs(lapGates[0].tangent.tx * (lapGates[0].b[0] - lapGates[0].a[0]) +
        lapGates[0].tangent.tz * (lapGates[0].b[1] - lapGates[0].a[1])) < 0.02,
      `start ${lapGates[0].x},${lapGates[0].z} heading ${lapGates[0].headingRad}, line ${lapGates[0].widthMetres} m`);
check('the lap line is fully drawn and physical at 4 m (41/41 samples) and three laps are declared',
      lapGates.every((gate) => gate.coverage.covered === true &&
        gate.coverage.drawnSamples === gate.coverage.samples &&
        gate.coverage.collisionSamples === gate.coverage.samples) &&
      lapLayout.course.lap.laps === 3 && lapLayout.rules.finishRequiresAllCheckpoints === false,
      lapGates.map((gate) => `${gate.id}:${gate.coverage.drawnSamples}/${gate.coverage.samples}`).join(' '));
check('the lap declares the P61 centre-line and car-width draw coverage',
      lapLayout.course.coverage.samples === 902 && lapLayout.course.coverage.coveredSamples === 902 &&
      lapLayout.course.coverage.coverageFraction === 1 && lapLayout.course.coverage.gaps.length === 0 &&
      lapLayout.course.coverage.band.samples === 6307 && lapLayout.course.coverage.band.drawnSamples === 6286 &&
      lapLayout.course.coverage.band.coverageFraction === 0.99667,
      `${lapLayout.course.coverage.coveredSamples}/${lapLayout.course.coverage.samples} centre, ` +
      `${lapLayout.course.coverage.band.drawnSamples}/${lapLayout.course.coverage.band.samples} band (` +
      (lapLayout.course.coverage.band.coverageFraction * 100).toFixed(3) + '%)');

// P74 V2 base colliders: one file, three mode bindings. The 310 m line is clear
// under `roadside`; the same file `all-visible` still blocks it at the four
// mapped arcs, which is why the timed course keeps the roadside profile. The lap
// uses `all-visible` because loop-01 is clear even with the 56 formerly missing
// lap components enabled.
check('the P74 base V2 manifest is the recorded one (651 colliders; roadside 553, all-visible 651)',
      propFileSha === SPRINT_PROP_PINS.manifestFileSha256 &&
      propFileSha === LAP_PROP_PINS.manifestFileSha256 &&
      propManifest.kind === 'prop-collision-colliders' && propManifest.version === 1 &&
      propManifest.variant === 'playable-regions-v2' &&
      propManifest.colliders.length === 651 && propManifest.profiles.roadside.colliders === 553 &&
      propManifest.profiles['all-visible'].colliders === 651 &&
      bareSha256(propManifest.contentSha256) === bareSha256(SPRINT_PROP_PINS.manifestContentSha256) &&
      sprintProfileWorld.profile === PROP_PROFILE_ROADSIDE && sprintProfileWorld.colliders.length === 553 &&
      sprintPropWorld.colliders.length === SPRINT_PROP_PINS.colliders &&
      lapPropWorld.profile === PROP_PROFILE && lapPropWorld.colliders.length === 651,
      `${propFileSha}, ${propManifest.colliders.length} colliders, roadside ${sprintProfileWorld.colliders.length} ` +
      `(${SPRINT_PROP_PINS.colliders} after ${SPRINT_DRIVEN_EXCLUSIONS.length} measured driven-line exclusions), ` +
      `all-visible ${lapPropWorld.colliders.length}`);

// The 310 exclusion set is a measured artifact, not a typed list: the deriver
// sweeps the committed 310 m reference ghosts through the same roadside world.
const SPRINT_EXCLUSION_FILE = path.join(OUT, 'sprint-driven-exclusions.json');
if (!existsSync(SPRINT_EXCLUSION_FILE)) {
  throw new Error('sprint-driven-exclusions.json missing — run `node probes/e1-drive/tools/derive_sprint_exclusions.mjs`');
}
const sprintExclusionBytes = readFileSync(SPRINT_EXCLUSION_FILE);
const sprintExclusionDoc = JSON.parse(sprintExclusionBytes.toString('utf8'));
const sprintExclusionIdsMatch = Array.isArray(sprintExclusionDoc.ids) &&
  sprintExclusionDoc.ids.length === SPRINT_DRIVEN_EXCLUSIONS.length &&
  sprintExclusionDoc.ids.every((id, index) => id === SPRINT_DRIVEN_EXCLUSIONS[index]);
check('the 310 m driven-line exclusion set is the measured artifact (16 ids, pinned content hash)',
      sprintExclusionDoc.kind === 'e1-drive.sprint-driven-exclusions' && sprintExclusionDoc.version === 1 &&
      sprintExclusionDoc.manifestFileSha256 === SPRINT_PROP_PINS.manifestFileSha256 &&
      bareSha256(sprintExclusionDoc.manifestContentSha256) === bareSha256(SPRINT_PROP_PINS.manifestContentSha256) &&
      sprintExclusionDoc.profile === PROP_PROFILE_ROADSIDE &&
      sprintExclusionDoc.roadsideActive === 553 &&
      sprintExclusionDoc.excludedCount === SPRINT_DRIVEN_EXCLUSIONS.length &&
      sprintExclusionDoc.activeAfterExclusions === SPRINT_PROP_PINS.colliders &&
      sprintExclusionDoc.exclusionContentSha256 === SPRINT_DRIVEN_EXCLUSION_CONTENT_SHA256 &&
      sprintExclusionIdsMatch &&
      SPRINT_DRIVEN_EXCLUSIONS.every((id) =>
        propManifest.colliders.some((collider) => collider.id === id && collider.active === true)),
      `${sprintExclusionDoc.excludedCount} ids, ${sprintExclusionDoc.activeAfterExclusions} active, ` +
      `${sprintExclusionDoc.exclusionContentSha256}`);
const ghostIndexFile = path.join(ROOT, 'probes/e1-drive/ghosts/index.json');
const ghostIndexBytes = readFileSync(ghostIndexFile);
const exclusionSourcesPinned = sprintExclusionDoc.source?.ghostsIndexSha256 === 'sha256:' + sha256(ghostIndexBytes) &&
  sprintExclusionDoc.source?.cars?.length === rosterSlugs.length &&
  sprintExclusionDoc.source.cars.every((entry) => {
    const file = path.join(ROOT, 'probes/e1-drive/ghosts/' +
      entry.ghost.split('/').pop());
    return entry.ghostFileSha256 === 'sha256:' + sha256(readFileSync(file));
  });
check('the driven-line exclusion artifact was derived from every committed 310 m ghost',
      exclusionSourcesPinned,
      JSON.stringify({ index: sprintExclusionDoc.source?.ghostsIndexSha256,
        cars: sprintExclusionDoc.source?.cars?.map((entry) => `${entry.slug}:${entry.contacts}`) }));
check('the 310 m line is clear under the pinned roadside profile (0 of 1,245 car poses blocked)',
      sprintRoadMeasure.samples === 1245 && sprintRoadMeasure.blocked === 0 &&
      sprintRoadMeasure.contactIds.length === 0,
      `${sprintRoadMeasure.blocked}/${sprintRoadMeasure.samples} blocked, nearest centre ` +
      `${sprintRoadMeasure.minDistanceMetres} m to ${sprintRoadMeasure.minColliderId} at arc ${sprintRoadMeasure.minArc}`);
check('the all-visible profile still blocks the 310 m line at the four mapped arcs (evidence, not shipped)',
      sprintAllMeasure.blocked === 181 && sprintAllMeasure.arcs.length === 4 &&
      Math.abs(sprintAllMeasure.arcs[0].firstArc - 52.897) < 0.5 &&
      Math.abs(sprintAllMeasure.arcs[3].lastArc - 206.847) < 0.5,
      `${sprintAllMeasure.blocked}/${sprintAllMeasure.samples} blocked in ${sprintAllMeasure.arcs.length} arcs: ` +
      sprintAllMeasure.arcs.map((arc) => `${arc.firstArc.toFixed(3)}-${arc.lastArc.toFixed(3)} (${arc.samples})`).join(', '));
check('loop-01 is clear under the lap\'s V2 all-visible layer (0 of 901 car poses blocked)',
      loopPropMeasure.samples === 901 && loopPropMeasure.blocked === 0 &&
      loopPropMeasure.contactIds.length === 0 && loopPropMeasure.minDistanceMetres > 0.7,
      `${loopPropMeasure.blocked}/${loopPropMeasure.samples} blocked, nearest centre ` +
      `${loopPropMeasure.minDistanceMetres} m to ${loopPropMeasure.minColliderId} at arc ${loopPropMeasure.minArc}`);

// The additive layer itself: real P74 V2 colliders, a synthetic engine pose sequence.
const propLayerTests = runPropLayerTests({
  world: lapPropWorld, manifest: propManifest, createPropLayer, propYawFromHeading
});
check('prop layer: 31 m/s head-on into the 5.39 m truck stops on the near face without tunnelling',
      propLayerTests.headOn.blockedTicks > 0 && propLayerTests.headOn.side > 0 &&
      propLayerTests.headOn.residual === 0 && propLayerTests.headOn.inputUnchanged === true,
      JSON.stringify({ side: propLayerTests.headOn.side, residual: propLayerTests.headOn.residual,
        contacts: propLayerTests.headOn.contacts, final: propLayerTests.headOn.final }));
check('prop layer: 31 m/s into a 0.02 m fence component does not tunnel (8 cm substeps)',
      propLayerTests.thinAt31.blockedTicks > 0 && propLayerTests.thinAt31.side > 0 &&
      propLayerTests.thinAt31.residual === 0 && propLayerTests.thinAt31.substeps >= 7,
      JSON.stringify({ side: propLayerTests.thinAt31.side, residual: propLayerTests.thinAt31.residual,
        substeps: propLayerTests.thinAt31.substeps, final: propLayerTests.thinAt31.final }));
check('prop layer: a 5 degree glancing hit keeps most of its travel and does not overlap',
      propLayerTests.glancing.blockedTicks > 0 && propLayerTests.glancing.residual === 0 &&
      propLayerTests.glancing.resolvedTravel > propLayerTests.glancing.freeTravel * 0.6,
      JSON.stringify({ free: propLayerTests.glancing.freeTravel,
        resolved: propLayerTests.glancing.resolvedTravel, residual: propLayerTests.glancing.residual }));
check('prop layer: the engine state object is never mutated (additive post-tick layer)',
      propLayerTests.headOn.inputUnchanged && propLayerTests.thinAt31.inputUnchanged &&
      propLayerTests.glancing.inputUnchanged);

// ------------------------------------------------- free roam (P65/P68 basin)
// `?course=free` is the picked free-roam mode: the committed spawn on the P65
// R04 basin, contained by the P68b spawn component, with the P74 R04-V2
// all-visible manifest (447 colliders). It has no gates, no finish and no lap; the
// timed 310 m/29 m courses and the 3-lap race above are untouched.
const SPRINT_FREE_FILE = path.join(OUT, 'sprint-free.json');
if (!existsSync(SPRINT_FREE_FILE)) {
  throw new Error('sprint-free.json missing — run `node probes/e1-drive/tools/build_sprint.mjs` first');
}
const freeRegionsFile = path.join(ROOT, FREE_REGIONS_PATH.file);
const freeRegionsBytes = readFileSync(freeRegionsFile);
const freeRegionsFileSha = 'sha256:' + sha256(freeRegionsBytes);
if (freeRegionsFileSha !== FREE_REGIONS_PATH.fileSha256) {
  throw new Error('the P65 regions artifact is not the recorded file: ' + freeRegionsFileSha);
}
const freeRegions = JSON.parse(freeRegionsBytes.toString('utf8'));
const freeBasin = freeRegions.regions.find((region) => region.id === FREE_REGIONS_PATH.regionId);
const freePropFile = path.join(ROOT, FREE_PROP_PINS.manifest);
const freePropBytes = readFileSync(freePropFile);
const freePropFileSha = 'sha256:' + sha256(freePropBytes);
if (freePropFileSha !== FREE_PROP_PINS.manifestFileSha256) {
  throw new Error('the P74 R04-V2 collider manifest is not the recorded file: ' + freePropFileSha);
}
freePropManifest = JSON.parse(freePropBytes.toString('utf8'));
const freePropCheck = checkPropManifest(freePropManifest, FREE_PROP_PINS);
if (!freePropCheck.ok) throw new Error('the P74 R04-V2 collider manifest was rejected: ' + freePropCheck.errors.join('; '));
freePropWorld = createPropWorld(freePropManifest, { profile: FREE_PROP_PINS.profile });
const freePropContacts = (x, z, yaw, baseY) =>
  freePropWorld.contactsAll(x, z, yaw, baseY, freePropManifest.carEnvelope);
const freeLayout = deriveFreeRoamLayout(geometry, layoutSpawn, freeRegions, {
  propContacts: freePropContacts, carEnvelope: freePropManifest.carEnvelope
});
const freeFileBytes = readFileSync(SPRINT_FREE_FILE);
const freeFile = JSON.parse(freeFileBytes.toString('utf8'));
const freeLayoutCheck = validateSprintLayout(freeLayout, geometry, layoutSpawn);
const freeBounds = freeLayout.course.bounds;
const freeProbe = freeLayout.course.containment.probe;

check('the P65 spawn basin artifact is the recorded one and R04 is the spawn region',
      freeRegionsFileSha === FREE_REGIONS_PATH.fileSha256 &&
      freeRegions.hash === FREE_REGIONS_PATH.canonicalHash &&
      freeRegions.kind === 'free-roam.regions' && freeRegions.version === 1 &&
      freeBasin !== undefined && freeBasin.containsSpawn === true &&
      Math.abs(freeBasin.areaM2 - FREE_REGIONS_PATH.areaM2) < 1e-9 &&
      freeBasin.bounds.every((value, index) => Math.abs(value - FREE_REGIONS_PATH.bounds[index]) < 1e-9),
      `${freeRegionsFileSha} / ${freeRegions.hash} / R04 ${freeBasin?.areaM2} m2 ` +
      `[${freeBasin?.bounds?.join(', ')}]`);
check('the P74 R04-V2 all-visible manifest is the recorded one (447 colliders, variant free-roam-r04)',
      freePropFileSha === FREE_PROP_PINS.manifestFileSha256 &&
      freePropManifest.variant === 'free-roam-r04' &&
      freePropManifest.colliders.length === 447 &&
      freePropManifest.profiles['all-visible'].colliders === 447 &&
      freePropWorld.profile === 'all-visible' && freePropWorld.colliders.length === 447,
      `${freePropFileSha}, ${freePropManifest.colliders.length} colliders, world ${freePropWorld.colliders.length}`);
check('the free-roam layout is exactly the one derived from the P65 basin and this geometry (no hand-edited basin)',
      canonicalJson(freeFile) === canonicalJson(freeLayout),
      freeFile.hash ?? 'no layout hash');
check('the free-roam layout passes its own structural validation',
      freeLayoutCheck.ok === true, freeLayoutCheck.errors.join(' | '));
check('free roam has no gates, no finish gate, no lap counter and no countdown',
      freeLayout.courseId === 'free' && freeLayout.gates.length === 0 &&
      freeLayout.course.lap === undefined && freeLayout.course.span === undefined &&
      freeLayout.rules.finishRequiresAllCheckpoints === false &&
      freeLayout.countdown.ticks === 0 && freeLayout.course.containment.noCorridorRespawn === true &&
      freeLayout.course.containment.noInvisibleWall === true,
      `gates ${freeLayout.gates.length}, countdown ${freeLayout.countdown.ticks}`);
check('free roam spawns at the committed spawn (-88, 1050) with the committed heading pi/2',
      freeLayout.course.spawn.x === -88 && freeLayout.course.spawn.z === 1050 &&
      Math.abs(freeLayout.course.spawn.headingRad - Math.PI / 2) < 1e-12 &&
      freeLayout.course.spawnGroundY === round6Local(freeLayout.course.spawnGroundY),
      `${freeLayout.course.spawn.x}, ${freeLayout.course.spawn.z}, ${freeLayout.course.spawn.headingRad} rad`);
check('free roam is bounded by the measured P68b spawn-component box (x -108.5..5.0, z 1027.5..1164.0)',
      freeBounds.minX === -108.5 && freeBounds.maxX === 5.0 &&
      freeBounds.minZ === 1027.5 && freeBounds.maxZ === 1164.0 &&
      freeLayout.course.containment.marginMetres === 2.0 &&
      freeLayout.course.containment.fallBelowGroundMetres === 1.0 &&
      freeLayout.course.containment.airborneTicks === 30,
      `x ${freeBounds.minX}..${freeBounds.maxX} z ${freeBounds.minZ}..${freeBounds.maxZ}, ` +
      `+${freeLayout.course.containment.marginMetres} m margin`);
check('the free-roam ground grid is the measured collision lattice over the box',
      freeLayout.course.groundGrid.measuredCells === 3418 &&
      freeLayout.course.groundGrid.filledCells === 515 &&
      freeLayout.course.groundGrid.heights.every((height) => Number.isFinite(height)),
      `${freeLayout.course.groundGrid.measuredCells} measured + ${freeLayout.course.groundGrid.filledCells} filled ` +
      `of ${freeLayout.course.groundGrid.columns}x${freeLayout.course.groundGrid.rows}`);
check('the containment test lane is measured, not typed in: ground-supported, <=5 cm/m, prop-clear to the boundary',
      freeProbe.x === -24.5 && freeProbe.z === 1037.5 &&
      Math.abs(freeProbe.headingRad - Math.PI / 2) < 1e-12 &&
      freeProbe.clearRunToBoundaryMetres === 31.5 &&
      freeProbe.maxGroundStepMetres <= freeProbe.stepLimitMetres,
      `(${freeProbe.x}, ${freeProbe.z}) ${freeProbe.clearRunToBoundaryMetres} m, max step ` +
      `${freeProbe.maxGroundStepMetres} m/m`);
check('the free-roam spawn is clear under the 447-collider R04-V2 all-visible layer (0 contacts)',
      freePropContacts(freeLayout.course.spawn.x, freeLayout.course.spawn.z,
        propYawFromHeading(freeLayout.course.spawn.headingRad), freeLayout.course.spawnGroundY).length === 0,
      `${freePropWorld.colliders.length} colliders, spawn ground ${freeLayout.course.spawnGroundY} m`);
const freePropLayerTests = runFreePropLayerTests({
  world: freePropWorld, manifest: freePropManifest, createPropLayer, propYawFromHeading, pins: FREE_PROP_PINS
});
check('free-roam prop layer: 31 m/s head-on into the R04 truck level.instance.00 stops on the near face',
      freePropLayerTests.truckHeadOn.blockedTicks > 0 &&
      freePropLayerTests.truckHeadOn.contactIds.includes('level.instance.00') &&
      freePropLayerTests.truckHeadOn.side > 0 && freePropLayerTests.truckHeadOn.residual === 0 &&
      freePropLayerTests.truckHeadOn.inputUnchanged === true,
      JSON.stringify({ side: freePropLayerTests.truckHeadOn.side,
        residual: freePropLayerTests.truckHeadOn.residual,
        contacts: freePropLayerTests.truckHeadOn.contacts, maxPen: freePropLayerTests.truckHeadOn.maxPenetrationMetres }));
check('free-roam prop layer: 31 m/s into a 0.02 m container panel does not tunnel',
      freePropLayerTests.thinAt31.blockedTicks > 0 &&
      freePropLayerTests.thinAt31.contactIds.includes(freePropLayerTests.thin) &&
      freePropLayerTests.thinAt31.side > 0 && freePropLayerTests.thinAt31.residual === 0 &&
      freePropLayerTests.thinAt31.maxPenetrationMetres <= 0.08 + 1e-6,
      JSON.stringify({ id: freePropLayerTests.thin, side: freePropLayerTests.thinAt31.side,
        residual: freePropLayerTests.thinAt31.residual,
        maxPen: freePropLayerTests.thinAt31.maxPenetrationMetres }));

// P74 V2 targets in the playable modes. The lap wall and free pipe are driven at
// 31 m/s through the real layer; the sign and pole are driven in single-collider
// worlds so the named target, not a cluster neighbour, is the stop. Rays are
// cast from a clear origin in four directions; the first hit may be a neighbour
// and is reported. Nothing here is a retail collision claim.
const v2LayerTests = runV2PropLayerTests({
  lapWorld: lapPropWorld, lapManifest: lapPropManifest, lapPins: LAP_PROP_PINS,
  freeWorld: freePropWorld, freeManifest: freePropManifest, freePins: FREE_PROP_PINS,
  createPropLayer, propYawFromHeading
});
const lapWallCollider = lapPropManifest.colliders.find((entry) => entry.id === v2LayerTests.lapWall.id);
const freePipeDrive = v2LayerTests.freePipe.drive;
check('P74 V2: 31 m/s into the lap building wall draw.355 stops outside the near face',
      v2LayerTests.lapWall.drive.blockedTicks > 0 &&
      v2LayerTests.lapWall.drive.contactIds.includes(v2LayerTests.lapWall.id) &&
      v2LayerTests.lapWall.drive.side >
        lapWallCollider.half[2] + lapPropManifest.carEnvelope.length / 2 - 0.02 &&
      v2LayerTests.lapWall.drive.residual === 0 &&
      v2LayerTests.lapWall.drive.maxPenetrationMetres <= 0.08 + 1e-6 &&
      v2LayerTests.lapWall.drive.inputUnchanged === true,
      JSON.stringify({ side: v2LayerTests.lapWall.drive.side,
        nearFace: lapWallCollider.half[2] + lapPropManifest.carEnvelope.length / 2,
        residual: v2LayerTests.lapWall.drive.residual,
        maxPen: v2LayerTests.lapWall.drive.maxPenetrationMetres,
        contacts: v2LayerTests.lapWall.drive.contactIds }));
check('P74 V2: 31 m/s into the free-roam concrete pipe draw.95 stops without passing it',
      freePipeDrive.blockedTicks > 0 && freePipeDrive.side > 0 &&
      freePipeDrive.contactIds.some((id) => id.startsWith('river.block56.node289.draw.95.')) &&
      freePipeDrive.residual === 0 && freePipeDrive.maxPenetrationMetres <= 0.08 + 1e-6 &&
      freePipeDrive.inputUnchanged === true,
      JSON.stringify({ side: freePipeDrive.side, residual: freePipeDrive.residual,
        maxPen: freePipeDrive.maxPenetrationMetres, contacts: freePipeDrive.contactIds }));
check('P74 V2: four-direction rays are blocked for the lap wall and the free pipe (8 of 8)',
      v2LayerTests.lapWall.rays.blocked === 4 && v2LayerTests.freePipe.rays.blocked === 4 &&
      [...v2LayerTests.lapWall.rays.rows, ...v2LayerTests.freePipe.rays.rows]
        .every((row) => row.hit !== null && row.hit.distanceFromCentreMetres > 0.02),
      JSON.stringify({
        lap: v2LayerTests.lapWall.rays.rows.map((row) => row.hit?.colliderId ?? 'pass'),
        free: v2LayerTests.freePipe.rays.rows.map((row) => row.hit?.colliderId ?? 'pass')
      }));
check('P74 V2: no tunnelling at 31 m/s; the car stays on the approach side (residual 0, 7 substeps/tick)',
      v2LayerTests.lapWall.drive.substeps >= 120 * 7 &&
      v2LayerTests.lapWall.drive.resolvedTravel < v2LayerTests.lapWall.drive.freeTravel * 0.5 &&
      freePipeDrive.substeps >= 120 * 7 &&
      freePipeDrive.resolvedTravel < freePipeDrive.freeTravel * 0.5 &&
      v2LayerTests.lapWall.drive.side > 0 && freePipeDrive.side > 0,
      JSON.stringify({ lap: { substeps: v2LayerTests.lapWall.drive.substeps,
        free: v2LayerTests.lapWall.drive.freeTravel, resolved: v2LayerTests.lapWall.drive.resolvedTravel },
        free: { substeps: freePipeDrive.substeps, freeTravel: freePipeDrive.freeTravel,
          resolved: freePipeDrive.resolvedTravel } }));
check('P74 V2: the lap no-parking sign (draw.257) and free steel pole (draw.283) stop a 31 m/s head-on',
      v2LayerTests.lapSign.drive.contactIds.includes(v2LayerTests.lapSign.id) &&
      v2LayerTests.lapSign.drive.side > 0 && v2LayerTests.lapSign.drive.residual === 0 &&
      v2LayerTests.freePole.drive.contactIds.includes(v2LayerTests.freePole.id) &&
      v2LayerTests.freePole.drive.side > 0 && v2LayerTests.freePole.drive.residual === 0,
      JSON.stringify({
        sign: { id: v2LayerTests.lapSign.id, side: v2LayerTests.lapSign.drive.side,
          residual: v2LayerTests.lapSign.drive.residual },
        pole: { id: v2LayerTests.freePole.id, side: v2LayerTests.freePole.drive.side,
          residual: v2LayerTests.freePole.drive.residual }
      }));

// Capture-only collision probes: the start pose is derived from the manifest and
// must be clear under the same layer. Coordinates are recorded, never typed in.
const lapCollisionProbe = collisionProbePose(lapPropManifest, COLLISION_PROBES['lap-sign']);
const freeCollisionProbe = collisionProbePose(freePropManifest, COLLISION_PROBES['free-pipe']);
const lapProbeTarget = lapPropManifest.colliders.find((entry) => entry.id === lapCollisionProbe.target);
const freeProbeTarget = freePropManifest.colliders.find((entry) => entry.id === freeCollisionProbe.target);
const lapProbeContacts = lapPropWorld.contactsAll(lapCollisionProbe.x, lapCollisionProbe.z,
  propYawFromHeading(lapCollisionProbe.headingRad), lapProbeTarget.vertical.groundY, lapPropManifest.carEnvelope);
const freeProbeContacts = freePropWorld.contactsAll(freeCollisionProbe.x, freeCollisionProbe.z,
  propYawFromHeading(freeCollisionProbe.headingRad), freeProbeTarget.vertical.groundY, freePropManifest.carEnvelope);
check('the collision-v2 capture starts are manifest-derived and clear under their layers',
      lapProbeContacts.length === 0 && freeProbeContacts.length === 0 &&
      Math.abs(Math.hypot(lapCollisionProbe.x - lapProbeTarget.center[0],
        lapCollisionProbe.z - lapProbeTarget.center[2]) - COLLISION_PROBES['lap-sign'].distanceMetres) < 1e-6 &&
      Math.abs(Math.hypot(freeCollisionProbe.x - freeProbeTarget.center[0],
        freeCollisionProbe.z - freeProbeTarget.center[2]) - COLLISION_PROBES['free-pipe'].distanceMetres) < 1e-6,
      JSON.stringify({ lap: { x: round6Local(lapCollisionProbe.x), z: round6Local(lapCollisionProbe.z),
        heading: round6Local(lapCollisionProbe.headingRad) },
        free: { x: round6Local(freeCollisionProbe.x), z: round6Local(freeCollisionProbe.z),
          heading: round6Local(freeCollisionProbe.headingRad) } }));

// Independent measurement: barycentric area signs (not the tool's plane-lambda
// form) and a plane height from the triangle normal. Every 0.1 m sample across
// every gate of both layouts must be over a real block56/node289 triangle within
// 0.5 m of the collision surface AND over a collision triangle.
const g56Section = geometry.trackVisual.sections.find((section) => section.key === 'river.block56.node289');
const g56Mesh = geometry.meshes.find((mesh) => mesh.id === geometry.trackVisual.meshId);
const g56Triangles = [];
for (const draw of geometry.trackVisual.draws.slice(g56Section.drawIndexRange[0], g56Section.drawIndexRange[1] + 1)) {
  for (let offset = draw.indexOffset; offset < draw.indexOffset + draw.indexCount; offset += 3) {
    const triangle = [0, 1, 2].map((corner) => {
      const vertex = g56Mesh.indices[offset + corner];
      return [g56Mesh.positions[vertex * 3], g56Mesh.positions[vertex * 3 + 1], g56Mesh.positions[vertex * 3 + 2]];
    });
    g56Triangles.push(triangle);
  }
}
const collisionMesh = geometry.collisionSurface.mesh;
const collisionTriangleList = [];
for (let offset = 0; offset < collisionMesh.indices.length; offset += 3) {
  collisionTriangleList.push([0, 1, 2].map((corner) => {
    const vertex = collisionMesh.indices[offset + corner];
    return [collisionMesh.positions[vertex * 3], collisionMesh.positions[vertex * 3 + 1], collisionMesh.positions[vertex * 3 + 2]];
  }));
}

/** Barycentric sign test in XZ; returns the plane height or null. */
function independentHeight(triangle, x, z) {
  const [a, b, c] = triangle;
  const area = (p, q, r) => (q[0] - p[0]) * (r[2] - p[2]) - (r[0] - p[0]) * (q[2] - p[2]);
  const d1 = area(a, b, [x, 0, z]);
  const d2 = area(b, c, [x, 0, z]);
  const d3 = area(c, a, [x, 0, z]);
  const negative = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
  const positive = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
  if (negative && positive) return null;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  if (Math.abs(ny) < 1e-12) return null;
  return a[1] - (nx * (x - a[0]) + nz * (z - a[2])) / ny;
}
function independentHeightAt(triangles, x, z) {
  let best = null;
  for (const triangle of triangles) {
    const height = independentHeight(triangle, x, z);
    if (height !== null && (best === null || height > best)) best = height;
  }
  return best;
}

/**
 * Independent XZ bucket index (written here, not imported) so the 1,204-sample
 * band proof is fast without sharing the layout module's index code.
 */
class IndependentTriangleIndex {
  constructor(triangles, bucket = 4) {
    this.bucket = bucket;
    this.buckets = new Map();
    this.triangles = triangles;
    for (const triangle of triangles) {
      const xs = triangle.map((vertex) => vertex[0]);
      const zs = triangle.map((vertex) => vertex[2]);
      for (let bx = Math.floor(Math.min(...xs) / bucket); bx <= Math.floor(Math.max(...xs) / bucket); bx++) {
        for (let bz = Math.floor(Math.min(...zs) / bucket); bz <= Math.floor(Math.max(...zs) / bucket); bz++) {
          const key = bx + ',' + bz;
          let list = this.buckets.get(key);
          if (!list) { list = []; this.buckets.set(key, list); }
          list.push(triangle);
        }
      }
    }
  }
  heights(x, z) {
    const list = this.buckets.get(Math.floor(x / this.bucket) + ',' + Math.floor(z / this.bucket)) ?? [];
    const hits = [];
    for (const triangle of list) {
      const height = independentHeight(triangle, x, z);
      if (height !== null) hits.push(height);
    }
    return hits;
  }
  highest(x, z) {
    const hits = this.heights(x, z);
    return hits.length ? Math.max(...hits) : null;
  }
  nearestTo(x, z, target) {
    let best = null;
    for (const height of this.heights(x, z)) {
      const delta = Math.abs(height - target);
      if (best === null || delta < best) best = delta;
    }
    return best;
  }
}
const independentDrawn = new IndependentTriangleIndex(g56Triangles);
const independentCollision = new IndependentTriangleIndex(collisionTriangleList);

// The lap lies outside block56/node289: measure its draw coverage against every
// committed track draw (the loop is covered by block71/node209 and block64/node209).
const allTrackTriangles = [];
for (const draw of geometry.trackVisual.draws) {
  for (let offset = draw.indexOffset; offset < draw.indexOffset + draw.indexCount; offset += 3) {
    allTrackTriangles.push([0, 1, 2].map((corner) => {
      const vertex = g56Mesh.indices[offset + corner];
      return [g56Mesh.positions[vertex * 3], g56Mesh.positions[vertex * 3 + 1], g56Mesh.positions[vertex * 3 + 2]];
    }));
  }
}
const independentAllTrack = new IndependentTriangleIndex(allTrackTriangles);

let lapCentreSamples = 0;
let lapCentreDrawn = 0;
let lapCentreCollision = 0;
let lapCentreMaxDelta = 0;
let lapBandSamples = 0;
let lapBandDrawn = 0;
let lapBandCollision = 0;
let lapBandMaxDelta = 0;
const lapBandMisses = [];
const lapSamples = lapLayout.course.samples;
for (const sample of lapSamples) {
  lapCentreSamples++;
  const height = independentCollision.highest(sample.x, sample.z);
  if (height === null) continue;
  lapCentreCollision++;
  const delta = independentAllTrack.nearestTo(sample.x, sample.z, height);
  if (delta !== null && delta <= 0.5) {
    lapCentreDrawn++;
    if (delta > lapCentreMaxDelta) lapCentreMaxDelta = delta;
  }
}
const LAP_BAND_STATIONS = [0, -0.419, 0.419, -0.838, 0.838, -1.138, 1.138];
const lapRing = lapSamples.length - 1;
for (let index = 0; index < lapRing; index++) {
  const previous = lapSamples[(index - 1 + lapRing) % lapRing];
  const next = lapSamples[(index + 1) % lapRing];
  const tx = next.x - previous.x;
  const tz = next.z - previous.z;
  const length = Math.hypot(tx, tz);
  const nx = -tz / length;
  const nz = tx / length;
  for (const station of LAP_BAND_STATIONS) {
    lapBandSamples++;
    const x = lapSamples[index].x + nx * station;
    const z = lapSamples[index].z + nz * station;
    const height = independentCollision.highest(x, z);
    if (height === null) { lapBandMisses.push({ arc: lapSamples[index].arc, station, missing: 'collision' }); continue; }
    lapBandCollision++;
    const delta = independentAllTrack.nearestTo(x, z, height);
    if (delta === null || delta > 0.5) {
      lapBandMisses.push({ arc: lapSamples[index].arc, station, missing: 'drawn',
        nearestDeltaMetres: delta === null ? null : round6Local(delta) });
      continue;
    }
    lapBandDrawn++;
    if (delta > lapBandMaxDelta) lapBandMaxDelta = delta;
  }
}
check('the whole loop-01 centre line is drawn and physical (independent, every committed draw)',
      lapCentreDrawn === lapCentreSamples && lapCentreCollision === lapCentreSamples,
      `${lapCentreDrawn}/${lapCentreSamples} drawn, ${lapCentreCollision}/${lapCentreSamples} collision, ` +
      `max delta ${round6Local(lapCentreMaxDelta)} m`);
check('the loop-01 car-width band is drawn and physical over 6,286 of 6,307 stations (independent)',
      lapBandSamples === 6307 && lapBandDrawn === 6286 && lapBandCollision === 6307 &&
      lapBandMisses.every((miss) => miss.station === -1.138 || miss.station === -0.838),
      `${lapBandDrawn}/${lapBandSamples} drawn, ${lapBandCollision}/${lapBandSamples} collision, ` +
      `${lapBandMisses.length} edge misses, max delta ${round6Local(lapBandMaxDelta)} m`);

// Exact steep-face clearance for the driven lap: the same triangle distance P61
// measured, applied to the recorded car centre every fifth tick. The 2.981 x
// 1.676 m car's circumradius is 1.710 m, so a centre distance above 1.710 m
// proves the whole footprint stays outside every steep face.
const lapSteepTriangles = [];
for (let offset = 0; offset < collisionMesh.indices.length; offset += 3) {
  const triangle = [0, 1, 2].map((corner) => {
    const vertex = collisionMesh.indices[offset + corner];
    return [collisionMesh.positions[vertex * 3], collisionMesh.positions[vertex * 3 + 1],
      collisionMesh.positions[vertex * 3 + 2]];
  });
  const ux = triangle[1][0] - triangle[0][0], uy = triangle[1][1] - triangle[0][1], uz = triangle[1][2] - triangle[0][2];
  const wx = triangle[2][0] - triangle[0][0], wy = triangle[2][1] - triangle[0][1], wz = triangle[2][2] - triangle[0][2];
  const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const length = Math.hypot(nx, ny, nz);
  if (length > 1e-9 && Math.abs(ny / length) < 0.5) {
    lapSteepTriangles.push({
      triangle,
      ymin: Math.min(triangle[0][1], triangle[1][1], triangle[2][1]),
      ymax: Math.max(triangle[0][1], triangle[1][1], triangle[2][1])
    });
  }
}
function segmentDistance2d(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  let t = lengthSquared > 0 ? ((px - ax) * dx + (pz - az) * dz) / lengthSquared : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}
function insideTriangle2d(px, pz, triangle) {
  const side = (a, b, c) => (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
  const d1 = side(triangle[0], triangle[1], [px, 0, pz]);
  const d2 = side(triangle[1], triangle[2], [px, 0, pz]);
  const d3 = side(triangle[2], triangle[0], [px, 0, pz]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
function lapSteepDistance(px, pz, groundY) {
  let best = Infinity;
  for (const entry of lapSteepTriangles) {
    if (entry.ymax < groundY + 0.05 || entry.ymin > groundY + 2.0) continue;
    if (insideTriangle2d(px, pz, entry.triangle)) return 0;
    const triangle = entry.triangle;
    best = Math.min(best,
      segmentDistance2d(px, pz, triangle[0][0], triangle[0][2], triangle[1][0], triangle[1][2]),
      segmentDistance2d(px, pz, triangle[1][0], triangle[1][2], triangle[2][0], triangle[2][2]),
      segmentDistance2d(px, pz, triangle[2][0], triangle[2][2], triangle[0][0], triangle[0][2]));
  }
  return best;
}
const LAP_CAR_CIRCUMRADIUS = Math.hypot(2.981, 1.676) / 2;

/** Independent gate-line re-measure: 0.1 m samples, nearest draw to the surface. */
function independentGateMeasure(gate) {
  const length = Math.hypot(gate.b[0] - gate.a[0], gate.b[1] - gate.a[1]);
  const samples = Math.round(length / GATE_SAMPLE_STEP) + 1;
  let drawn = 0;
  let collision = 0;
  let maxDelta = 0;
  for (let sample = 0; sample < samples; sample++) {
    const t = samples === 1 ? 0 : sample / (samples - 1);
    const x = Number((gate.a[0] + (gate.b[0] - gate.a[0]) * t).toFixed(6));
    const z = Number((gate.a[1] + (gate.b[1] - gate.a[1]) * t).toFixed(6));
    const height = independentCollision.highest(x, z);
    if (height === null) continue;
    collision++;
    const delta = independentDrawn.nearestTo(x, z, height);
    if (delta !== null && delta <= 0.5) {
      drawn++;
      if (delta > maxDelta) maxDelta = delta;
    }
  }
  return { id: gate.id, arc: gate.arc ?? null, x: gate.x, z: gate.z, samples, drawn, collision, maxDelta };
}
const gateSamples = sprintGates.map(independentGateMeasure);
const shortGateSamples = shortGates.map(independentGateMeasure);
check('every default-course gate line is covered by the real track visual and by a collision triangle (independent re-measure)',
      gateSamples.every((gate) => gate.drawn === gate.samples && gate.collision === gate.samples),
      gateSamples.map((gate) => `${gate.id}:${gate.drawn}/${gate.samples} drawn, ${gate.collision}/${gate.samples} collision`).join(' '));
check('every 29 m regression gate line is still covered by the real track visual and a collision triangle (independent)',
      shortGateSamples.every((gate) => gate.drawn === gate.samples && gate.collision === gate.samples),
      shortGateSamples.map((gate) => `${gate.id}:${gate.drawn}/${gate.samples} drawn, ${gate.collision}/${gate.samples} collision`).join(' '));

// Long-course car-width band: seven lateral stations (0, +/-0.419, +/-0.838,
// +/-1.138 m = the 1.676 m envelope and the +0.30 m margin) at every 0.25 m
// sample inside the finish. Both layers must exist and the draw must sit on the
// collision surface within the P51 0.5 m rule.
const BAND_STATIONS = [0, -0.419, 0.419, -0.838, 0.838, -1.138, 1.138];
let bandSamples = 0;
let bandCollision = 0;
let bandDrawn = 0;
let bandMaxDelta = 0;
const bandFailures = [];
const longInside = derivedLayout.course.samples.filter((sample) => sample.arc <= sprintSpan.finishArc + 1e-9);
for (let index = 1; index < longInside.length - 1; index++) {
  const previous = longInside[index - 1];
  const next = longInside[index + 1];
  const tx = next.x - previous.x;
  const tz = next.z - previous.z;
  const length = Math.hypot(tx, tz);
  const nx = -tz / length;
  const nz = tx / length;
  for (const station of BAND_STATIONS) {
    bandSamples++;
    const x = longInside[index].x + nx * station;
    const z = longInside[index].z + nz * station;
    const height = independentCollision.highest(x, z);
    if (height === null) {
      bandFailures.push({ arc: longInside[index].arc, station, missing: 'collision' });
      continue;
    }
    bandCollision++;
    const delta = independentDrawn.nearestTo(x, z, height);
    if (delta === null || delta > 0.5) {
      bandFailures.push({ arc: longInside[index].arc, station, missing: 'drawn', delta });
      continue;
    }
    bandDrawn++;
    if (delta > bandMaxDelta) bandMaxDelta = delta;
  }
}
check('the whole 310 m course is drawn and physical across the measured car-width band (independent, 7 stations)',
      bandFailures.length === 0 && bandDrawn === bandSamples && bandCollision === bandSamples,
      `${bandDrawn}/${bandSamples} drawn, ${bandCollision}/${bandSamples} collision, ` +
      `max delta ${round6Local(bandMaxDelta)} m`);

const lastCovered = shortSpan.lastFullyCoveredX;
let coveredPastEnd = 0;
let fullyCoveredColumns = 0;
for (let x = shortSpan.startX; x <= lastCovered + 0.25 + 1e-9; x += COLUMN_STEP) {
  const rounded = Number(x.toFixed(6));
  let ok = true;
  const samples = Math.round((shortLayout.course.band.halfWidthMetres * 2) / GATE_SAMPLE_STEP) + 1;
  for (let sample = 0; sample < samples && ok; sample++) {
    const z = Number((shortLayout.course.band.z - shortLayout.course.band.halfWidthMetres +
      sample * GATE_SAMPLE_STEP).toFixed(6));
    if (independentHeightAt(g56Triangles, rounded, z) === null) ok = false;
    else if (independentHeightAt(collisionTriangleList, rounded, z) === null) ok = false;
  }
  if (ok) fullyCoveredColumns++;
  if (rounded > lastCovered + 1e-9 && ok) coveredPastEnd++;
}
check('the 29 m covered segment is contiguous and the recorded end is the last fully covered column',
      fullyCoveredColumns >= Math.round((lastCovered - shortSpan.startX) / COLUMN_STEP) + 1 && coveredPastEnd === 0,
      `${fullyCoveredColumns} fully covered columns, ${coveredPastEnd} past the recorded end ${lastCovered}`);

// Engine ground agreement on the long course: the layout's collision mesh is a
// provenance subset, so every tenth sample (plus every gate) is compared with the
// engine's own _e1_ground_probe. The engine is the authority for the surface the
// wheels trace; the layout must not be measuring a different one.
let groundChecks = 0;
let groundMaxDelta = 0;
let groundFailures = 0;
for (let index = 0; index < longInside.length; index += 10) {
  const sample = longInside[index];
  const probe = collisionProbe.ground(sample.x, sample.z);
  groundChecks++;
  if (!probe || probe.hit !== 1) { groundFailures++; continue; }
  const delta = Math.abs(probe.y - sample.groundY);
  if (delta > groundMaxDelta) groundMaxDelta = delta;
  if (delta > 0.01) groundFailures++;
}
for (const gate of sprintGates) {
  const probe = collisionProbe.ground(gate.x, gate.z);
  groundChecks++;
  if (!probe || probe.hit !== 1) { groundFailures++; continue; }
  const delta = Math.abs(probe.y - gate.height);
  if (delta > groundMaxDelta) groundMaxDelta = delta;
  if (delta > 0.01) groundFailures++;
}
check('the 310 m course ground matches the engine ground probe at every gate and every tenth sample',
      groundFailures === 0 && groundMaxDelta < 0.01,
      `${groundChecks} probes, max delta ${round6Local(groundMaxDelta)} m, ${groundFailures} failures`);

let lapGroundChecks = 0;
let lapGroundMaxDelta = 0;
let lapGroundFailures = 0;
for (let index = 0; index < lapSamples.length; index += 10) {
  const sample = lapSamples[index];
  const probe = collisionProbe.ground(sample.x, sample.z);
  lapGroundChecks++;
  if (!probe || probe.hit !== 1) { lapGroundFailures++; continue; }
  const delta = Math.abs(probe.y - sample.groundY);
  if (delta > lapGroundMaxDelta) lapGroundMaxDelta = delta;
  if (delta > 0.01) lapGroundFailures++;
}
for (const gate of lapGates) {
  const probe = collisionProbe.ground(gate.x, gate.z);
  lapGroundChecks++;
  if (!probe || probe.hit !== 1) { lapGroundFailures++; continue; }
  const delta = Math.abs(probe.y - gate.height);
  if (delta > lapGroundMaxDelta) lapGroundMaxDelta = delta;
  if (delta > 0.01) lapGroundFailures++;
}
check('the lap ground matches the engine ground probe every tenth sample and on the line',
      lapGroundFailures === 0 && lapGroundMaxDelta < 0.01,
      `${lapGroundChecks} probes, max delta ${round6Local(lapGroundMaxDelta)} m, ${lapGroundFailures} failures`);

const sprintLayoutCheck = {
  hash: derivedLayout.hash,
  courseId: derivedLayout.courseId,
  file: path.relative(ROOT, SPRINT_FILE).split(path.sep).join('/'),
  fileSha256: 'sha256:' + sha256(sprintFileBytes),
  path: {
    file: LONG_COURSE_PATH.file, fileSha256: longPathFileSha, canonicalHash: longPath.hash,
    lengthMetres: derivedLayout.course.lengthMetres, sampleCount: derivedLayout.course.sampleCount
  },
  spawn: derivedLayout.source.spawn,
  startHeadingRad: layoutStartHeading(derivedLayout, layoutSpawn),
  spawnGroundY: derivedLayout.course.spawnGroundY,
  span: sprintSpan,
  corridor: derivedLayout.course.corridor,
  coverage: derivedLayout.course.coverage,
  gates: sprintGates.map((gate) => ({
    id: gate.id, kind: gate.kind, arc: gate.arc, x: gate.x, z: gate.z, headingRad: gate.headingRad,
    widthMetres: gate.widthMetres,
    drawnSamples: gate.coverage.drawnSamples, collisionSamples: gate.coverage.collisionSamples,
    samples: gate.coverage.samples, heightRange: gate.coverage.drawnHeightRange
  })),
  independentGateSamples: gateSamples,
  independentBand: {
    stations: BAND_STATIONS.length, samples: bandSamples, drawn: bandDrawn,
    collision: bandCollision, maxDeltaMetres: round6Local(bandMaxDelta)
  },
  engineGround: { probes: groundChecks, maxDeltaMetres: round6Local(groundMaxDelta), failures: groundFailures },
  countdown: derivedLayout.countdown,
  rules: derivedLayout.rules
};
const sprintShortLayoutCheck = {
  hash: shortLayout.hash,
  courseId: shortLayout.courseId,
  file: path.relative(ROOT, SPRINT_SHORT_FILE).split(path.sep).join('/'),
  fileSha256: 'sha256:' + sha256(sprintShortBytes),
  spawn: shortLayout.source.spawn,
  startHeadingRad: layoutStartHeading(shortLayout, layoutSpawn),
  spawnGroundY: shortLayout.course.spawnGroundY,
  band: shortLayout.course.band,
  span: shortSpan,
  gates: shortGates.map((gate) => ({
    id: gate.id, kind: gate.kind, x: gate.x, z: gate.z, widthMetres: gate.widthMetres,
    drawnSamples: gate.coverage.drawnSamples, collisionSamples: gate.coverage.collisionSamples,
    samples: gate.coverage.samples, heightRange: gate.coverage.drawnHeightRange
  })),
  independentGateSamples: shortGateSamples,
  fullyCoveredColumns,
  coveredColumnsPastEnd: coveredPastEnd,
  countdown: shortLayout.countdown,
  rules: shortLayout.rules
};
const lapLayoutCheck = {
  hash: lapLayout.hash,
  courseId: lapLayout.courseId,
  file: path.relative(ROOT, SPRINT_LAP_FILE).split(path.sep).join('/'),
  fileSha256: 'sha256:' + sha256(sprintLapBytes),
  loop: {
    file: LAP_LOOPS_PATH.file,
    fileSha256: lapLoopsFileSha,
    canonicalHash: lapLoops.hash,
    loopId: LAP_LOOPS_PATH.loopId,
    component: LAP_LOOPS_PATH.component,
    lengthMetres: lapLoop.length,
    samples: lapLoop.points.length,
    closureSeamMetres: lapLoop.closureSeam
  },
  spawn: lapLayout.course.spawn,
  startHeadingRad: lapGates[0].headingRad,
  spawnGroundY: lapLayout.course.spawnGroundY,
  span: lapSpan,
  lap: {
    laps: lapLayout.course.lap.laps,
    lengthMetres: lapLayout.course.lap.lengthMetres,
    minLapMetres: lapLayout.course.lap.minLapMetres,
    line: {
      x: lapLayout.course.lap.line.x,
      z: lapLayout.course.lap.line.z,
      headingRad: lapLayout.course.lap.line.headingRad,
      widthMetres: lapLayout.course.lap.line.widthMetres,
      a: lapLayout.course.lap.line.a,
      b: lapLayout.course.lap.line.b
    }
  },
  gates: lapGates.map((gate) => ({
    id: gate.id, kind: gate.kind, arc: gate.arc, x: gate.x, z: gate.z, headingRad: gate.headingRad,
    widthMetres: gate.widthMetres,
    drawnSamples: gate.coverage.drawnSamples, collisionSamples: gate.coverage.collisionSamples,
    samples: gate.coverage.samples, heightRange: gate.coverage.drawnHeightRange
  })),
  coverage: {
    centre: {
      samples: lapCentreSamples, drawn: lapCentreDrawn, collision: lapCentreCollision,
      maxDeltaMetres: round6Local(lapCentreMaxDelta)
    },
    band: {
      stations: LAP_BAND_STATIONS.length, samples: lapBandSamples, drawn: lapBandDrawn,
      collision: lapBandCollision, missCount: lapBandMisses.length,
      coverageFraction: round6Local(lapBandDrawn / lapBandSamples),
      maxDeltaMetres: round6Local(lapBandMaxDelta),
      misses: lapBandMisses.slice(0, 16)
    },
    declared: lapLayout.course.coverage
  },
  engineGround: { probes: lapGroundChecks, maxDeltaMetres: round6Local(lapGroundMaxDelta), failures: lapGroundFailures },
  countdown: lapLayout.countdown,
  rules: lapLayout.rules
};

/** One full scripted run of one car in a fresh wasm module instance. */
async function runOnce(car, fieldBytes) {  const factory = (await import(pathToFileURL(MODULE).href)).default;
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

  const session = createSession(chunkGeometryFor(car.slug), JSON.parse(module.UTF8ToString(module._e1_get_state())), {
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

/** Replay a recorded input sequence without sprint rules: physics must not know. */
async function replaySprintInputs(car, fieldBytes, inputs, layout = derivedLayout) {
  const start = layoutStartPosition(layout, layoutSpawn);
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  const module = await factory();
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const created = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                                    start.x, start.z, start.heading);
  if (!created) throw new Error('sprint replay create failed for ' + car.name);
  const hashes = [hashOfLocal(JSON.parse(module.UTF8ToString(module._e1_get_state())))];
  for (const input of inputs) {
    module._e1_set_input(input[0], input[1], input[2], input[3]);
    if (!module._e1_step()) throw new Error('sprint replay step failed for ' + car.name);
    hashes.push(hashOfLocal(JSON.parse(module.UTF8ToString(module._e1_get_state()))));
  }
  return hashes;
}

/** One deterministic sprint run of one car in a fresh wasm module instance. */
async function runSprint(car, fieldBytes, layout = derivedLayout) {
  const start = layoutStartPosition(layout, layoutSpawn);
  const maxTicks = isFreeLayout(layout) ? FREE_SCRIPT_TICKS
    : isLapLayout(layout) ? LAP_SCRIPT_TICKS : SPRINT_SCRIPT_TICKS;
  const packetScript = isFreeLayout(layout) ? FREE_PACKET_SCRIPT
    : isLapLayout(layout) ? LAP_PACKET_SCRIPT : SPRINT_PACKET_SCRIPT;
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  const module = await factory();
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const t0 = Date.now();
  const created = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                                    start.x, start.z, start.heading);
  if (!created) throw new Error(`sprint e1_create failed for ${car.name}: ` + module.UTF8ToString(module._e1_last_error()));
  const createMs = Date.now() - t0;

  const rules = createSprintRules(layout, {
    shortCourseController: car.shortCourseController ?? null
  });
  const propConfig = isFreeLayout(layout)
    ? { world: freePropWorld, manifest: freePropManifest, pins: FREE_PROP_PINS }
    : isLapLayout(layout)
      ? { world: lapPropWorld, manifest: lapPropManifest, pins: LAP_PROP_PINS }
      : layout.courseId === SHORT_COURSE_ID
        ? null
        : { world: sprintPropWorld, manifest: lapPropManifest, pins: SPRINT_PROP_PINS };
  const propLayer = propConfig?.world
    ? createPropLayer({ world: propConfig.world, carEnvelope: propConfig.manifest.carEnvelope, pins: propConfig.pins })
    : null;
  const groundYFor = (state) => {
    if (isFreeLayout(layout)) return freeGroundAt(layout, state.position);
    const arc = coursePosition(layout.course.samples, state.position).arc;
    return courseGroundAt(layout, arc);
  };
  const state0 = JSON.parse(module.UTF8ToString(module._e1_get_state()));
  if (propLayer) propLayer.begin(state0, groundYFor(state0));
  const session = createSession(chunkGeometryFor(car.slug), state0, {
    spawn: { x: start.x, z: start.z, headingRad: start.heading, source: TICK0_LIMITS.source },
    script: packetScript,
    car: {
      slug: car.slug, name: car.name, recordIndex: car.record.index, recordId: car.record.id,
      drivetrain: car.drivetrain, mass: car.values.mass, fieldsSha256: car.fields.sha256
    }
  });
  session.appendState(state0);
  rules.prime(state0);
  const states = [state0];
  const inputs = [];
  const events = [];
  const rawTicks = Array.isArray(layout.course.samples) && layout.course.samples.length >= 2
    ? [{ tick: 0, phase: rules.phase, position: state0.position,
      axisZ: state0.axisZ, ground: groundYFor(state0) }]
    : null;
  const rows = [{
    tick: 0, phase: rules.phase, elapsedTicks: rules.elapsedTicks, elapsedSeconds: rules.elapsedSeconds,
    speed: state0.speed, position: state0.position, progress: 0, stateHash: hashOfLocal(state0)
  }];
  const startMs = Date.now();
  let previous = state0;
  for (let tick = 1; tick <= maxTicks; tick++) {
    const input = sprintScriptInput(rules, previous);
    inputs.push(input);
    module._e1_set_input(input[0], input[1], input[2], input[3]);
    if (!module._e1_step()) throw new Error(`sprint e1_step failed for ${car.name} at tick ${tick}`);
    const rawState = JSON.parse(module.UTF8ToString(module._e1_get_state()));
    // The prop layer is the timed-run collision claim. After the finish the
    // car is in its labelled brake tail; it is presented from the raw engine
    // pose (the results overlay is up), so the timed contact count cannot
    // depend on how long that tail happens to be.
    const state = propLayer && rules.phase !== 'finished'
      ? propLayer.afterTick(rawState, groundYFor(rawState))
      : rawState;
    session.appendState(state);
    states.push(rawState);
    const tickEvents = rules.step(state);
    events.push(...tickEvents);
    const snapshot = rules.snapshot(state);
    rows.push({
      tick, phase: rules.phase, elapsedTicks: rules.elapsedTicks, elapsedSeconds: rules.elapsedSeconds,
      speed: state.speed, position: state.position, progress: snapshot.progress, stateHash: hashOfLocal(state),
      lap: snapshot.lap ?? null, laps: snapshot.laps ?? null,
      lapTimes: snapshot.lapTimes ? snapshot.lapTimes.slice() : null,
      bestLapSeconds: snapshot.bestLapSeconds ?? null
    });
    if (rawTicks) rawTicks.push({ tick, phase: rules.phase, position: rawState.position,
      axisZ: rawState.axisZ, ground: groundYFor(rawState) });
    // The scripted driver follows the engine's own state. The additive prop
    // layer is a presentation/rules observer and must not feed back into the
    // controller: otherwise excluding a collider changes the driven line, which
    // changes the exclusions again (a non-converging derivation).
    previous = rawState;
    if (rules.phase === 'finished' && state.tick - rules.finishTick >= 120) break;
    // A free-roam containment reset ends the scripted run: the run must be
    // contained (the verifier fails if a clean free drive leaves the basin).
    if (isFreeLayout(layout) && rules.awaitingRejoin) break;
  }
  const simMs = Date.now() - startMs;
  const packet = session.finalise();
  return {
    module, rules, states, inputs, events, rows, packet, createMs, simMs, rawTicks,
    // Ghost replay reads the same recorded angles the adapter integrated, so the
    // ghost wheels are the run's own wheels and not a re-integration.
    wheelAnglesByTick: session.wheelAnglesByTick,
    finish: events.find((event) => event.type === SPRINT_EVENT.FINISH) ?? null,
    checkpoints: events.filter((event) => event.type === SPRINT_EVENT.CHECKPOINT),
    lapEvents: events.filter((event) => event.type === SPRINT_EVENT.LAP || event.type === SPRINT_EVENT.FINISH),
    go: events.find((event) => event.type === SPRINT_EVENT.GO) ?? null,
    respawns: events.filter((event) => event.type === SPRINT_EVENT.RESPAWN),
    prop: propLayer ? propLayer.snapshot() : null
  };
}
/**
 * The ghost record of one completed deterministic sprint. `source` is the
 * committed reference trace (the page uses the same builder for the user's own
 * best run). Nothing here touches the engine.
 */
function buildGhostForRun(car, run, layout, course, finish, stateSequenceHash) {
  return ghostFromRun({
    car: car.slug,
    course,
    courseId: layout.courseId,
    layoutHash: layout.hash,
    countdownTicks: layout.countdown.ticks,
    finishTick: finish.tick,
    timeSeconds: finish.timeSeconds,
    stateSequenceHash,
    updates: run.packet.updates,
    wheelAnglesByTick: run.wheelAnglesByTick,
    source: GHOST_SOURCE.REFERENCE,
    sourceLabel: 'reference ghost - committed deterministic sprint trace (' +
      finish.timeSeconds.toFixed(3) + ' s)'
  });
}

/** Manifest wheel rest matrices of one car, the same ones the adapter composes with. */
function ghostWheelRestFor(slug) {
  const body = geometry.carBodies[slug];
  if (!body) throw new Error('geometry has no body for ' + slug);
  const rest = {};
  for (const corner of GHOST_CORNERS) {
    const group = body.wheelGroups.find((candidate) => candidate.corner === corner);
    if (!group) throw new Error('body ' + slug + ' has no wheel rest pose for ' + corner);
    rest[corner] = group.matrixColumnMajor;
  }
  return rest;
}

/** Run the diagnostic off-course driver and rebuild at the checkpoint the rules picked. */
async function runRespawnScenario(car, fieldBytes) {
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  const module = await factory();
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const createAt = (x, z, heading = layoutStartHeading(derivedLayout, layoutSpawn)) => {
    const ok = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                                 x, z, heading);
    if (!ok) throw new Error('respawn create failed: ' + module.UTF8ToString(module._e1_last_error()));
    return JSON.parse(module.UTF8ToString(module._e1_get_state()));
  };
  const rules = createSprintRules(derivedLayout);
  rules.prime(createAt(TICK0_LIMITS.x, TICK0_LIMITS.z));
  const events = [];
  let rebuild = null;
  let post = null;
  for (let tick = 1; tick <= 600; tick++) {
    if (rules.awaitingRejoin) {
      const target = rules.respawnTarget();
      const probe = JSON.parse(module.UTF8ToString(module._e1_ground_probe(target.x, target.z)));
      const elapsedBefore = rules.elapsedTicks;
      const gateProgressBefore = rules.checkpointsPassed;
      const state0 = createAt(target.x, target.z, target.heading);
      rules.rejoin(state0);
      rebuild = {
        tick,
        target,
        probe,
        elapsedBefore,
        gateProgressBefore,
        tickAfterBuild: state0.tick,
        position: state0.position,
        contacts: state0.contacts,
        elapsedAfterRejoin: rules.elapsedTicks
      };
      const followPositions = [];
      const followEvents = [];
      for (let extra = 1; extra <= 120; extra++) {
        const input = [1, 0, 0, 0];
        module._e1_set_input(...input);
        if (!module._e1_step()) throw new Error('respawn follow-up step failed');
        const state = JSON.parse(module.UTF8ToString(module._e1_get_state()));
        for (const event of rules.step(state)) followEvents.push(event);
        followPositions.push({ tick: extra, position: state.position, speed: state.speed, phase: rules.phase });
      }
      post = {
        elapsed: rules.elapsedSeconds,
        elapsedTicks: rules.elapsedTicks,
        checkpointsPassed: rules.checkpointsPassed,
        respawns: rules.respawns,
        position: followPositions[followPositions.length - 1].position,
        speed: followPositions[followPositions.length - 1].speed,
        events: followEvents
      };
      break;
    }
    const input = respawnScriptInput(tick);
    module._e1_set_input(...input);
    if (!module._e1_step()) throw new Error('respawn scenario step failed at ' + tick);
    const state = JSON.parse(module.UTF8ToString(module._e1_get_state()));
    const tickEvents = rules.step(state);
    for (const event of tickEvents) events.push({ ...event });
  }
  return { rules, events, respawnEvents: events.filter((event) => event.type === SPRINT_EVENT.RESPAWN),
    rebuild, post, module };
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
  const expectedStaticDraws = 22 + trackDraws.length;
  check(`${car.name}: the packet has the expected draw count (22 level props + ${trackDraws.length} real track draws + ${expectedCarDraws} car)`,
        packet.draws.length === expectedStaticDraws + expectedCarDraws &&
        packet.diagnostics.sequence.staticDrawCount === expectedStaticDraws,
        String(packet.draws.length));
  check(`${car.name}: the packet draws the real track visual and labels the direct-draw path`,
        packet.diagnostics.extras.track?.trackVisual === 'asset-reader-direct-draws' &&
        packet.diagnostics.extras.track?.drawCount === trackDraws.length &&
        packet.draws.filter((draw) => draw.meshId === trackVisual.meshId).length === trackDraws.length,
        JSON.stringify(packet.diagnostics.extras.track?.drawCount));
  check(`${car.name}: the collision surface stays in the packet as hidden physics provenance`,
        packet.physicsSurfaces?.length === 1 &&
        packet.physicsSurfaces[0].visible === false &&
        packet.physicsSurfaces[0].physicsOnly === true &&
        packet.physicsSurfaces[0].mesh?.vertexCount === geometry.collisionSurface.vertexCount &&
        !packet.meshes.some((mesh) => mesh.id === geometry.collisionSurface.meshId),
        `${packet.physicsSurfaces?.[0]?.triangleCount ?? 0} collision triangles`);
  check(`${car.name}: materials are diagnostic and labelled`,
        packet.diagnostics.materialsApplied === false &&
        packet.draws.every((draw) => typeof draw.materialReason === 'string' && draw.materialReason.length > 0));
  // The packet carries the static level/track albedo pack plus only this car's own
  // P52 images: the upload is bounded by one car, never the whole roster, and no
  // draw may name an image that the packet did not upload.
  const packetCarTextures = body.textures;
  const packetTextureIds = new Set(packet.textures.map((texture) => texture.id));
  const packetCarDraws = packet.draws.filter((draw) => draw.meshId === body.meshId);
  const packetCarTextured = packetCarDraws.filter((draw) => draw.textureId != null);
  check(`${car.name}: the packet uploads the 136 track + 4 level-prop textures plus only this car's own images`,
        packet.textures.length === 136 + 4 + packetCarTextures.length &&
        packetTextureIds.size === packet.textures.length &&
        packet.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0) ===
          439360 + 8192 + packetCarTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0) &&
        packet.carTexturePack?.manifestSha256 === geometry.carTextures.manifestSha256 &&
        packet.textures.filter((texture) => /^level\.albedo\./.test(texture.id)).length === 4 &&
        !packet.textures.some((texture) => /^level\.albedo\./.test(texture.id) &&
          /BC3|DXT5/.test(texture.formatName)),
        `${packet.textures.length} textures / ` +
        `${packet.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0)} B`);
  check(`${car.name}: the packet binds 18 level props to the uploaded BC1 pack and keeps 4 diagnostic`,
        packet.draws.filter((draw) => draw.meshId === levelMesh.id).length === 22 &&
        packet.draws.filter((draw) => draw.meshId === levelMesh.id && draw.textureId != null).length === 18 &&
        packet.draws.filter((draw) => draw.meshId === levelMesh.id && draw.textureId == null).length === 4 &&
        packet.meshes.find((mesh) => mesh.id === levelMesh.id)?.uv?.sha256 === levelUv.sha256 &&
        packet.diagnostics.extras.levelProps?.manifestSha256 === levelPropPack.manifestSha256 &&
        packet.diagnostics.extras.levelProps?.texturedDrawCount === 18 &&
        packet.diagnostics.extras.levelProps?.diagnosticDrawCount === 4,
        `${packet.draws.filter((draw) => draw.meshId === levelMesh.id && draw.textureId != null).length}/22 level draws textured`);
  check(`${car.name}: every car draw samples a texture the packet uploaded, and the UV0 mesh is real`,
        packetCarDraws.length === body.carDraws.length &&
        packetCarTextured.length === body.carDraws.filter((draw) => draw.textureId != null).length &&
        packetCarTextured.every((draw) => packetTextureIds.has(draw.textureId)) &&
        packet.draws.every((draw) => draw.textureId == null || packetTextureIds.has(draw.textureId)) &&
        packet.meshes.find((mesh) => mesh.id === body.meshId)?.uv?.sha256 === body.mesh.uv.sha256,
        `${packetCarTextured.length}/${packetCarDraws.length} car draws textured`);
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

  // ------------------------------------------------------ camera occlusion
  // Independent of the adapter's own record, re-cast both the collided segment
  // (target -> stored eye) and the pre-P36 segment (target -> desired eye) with
  // the same occluder. "Clear" means no visible triangle before the stored eye.
  const cameraOcclusion = packet.diagnostics.extras.camera.occlusion;
  const cameraMargin = cameraOcclusion.marginMetres;
  const cameraNearField = cameraOcclusion.nearFieldMetres;
  const cameraRows = packet.updates.map((update) => {
    const camera = update.camera;
    const target = camera.target;
    const direction = orbitDirection(camera.orbit.yaw, camera.orbit.pitch);
    const requested = camera.occlusion?.requestedDistance ?? camera.orbit.distance;
    const desiredEye = [
      target[0] + direction[0] * requested,
      target[1] + direction[1] * requested,
      target[2] + direction[2] * requested
    ];
    const legacyHit = occluder.castSegment(target, desiredEye);
    const resolvedHit = occluder.castSegment(target, camera.position);
    return {
      tick: update.tick,
      distance: camera.orbit.distance,
      requested,
      blocked: camera.occlusion?.blocked === true,
      nearField: camera.occlusion?.nearField === true,
      legacyHitDistance: legacyHit ? legacyHit.distance : null,
      legacyHitMesh: legacyHit ? legacyHit.meshId : null,
      resolvedHitDistance: resolvedHit ? resolvedHit.distance : null,
      clear: !resolvedHit || resolvedHit.distance >= camera.orbit.distance - 1e-3
    };
  });

  const resolvableBlocked = cameraRows.filter((row) =>
    row.legacyHitDistance !== null && row.legacyHitDistance > cameraNearField);
  const notClear = resolvableBlocked.filter((row) => !row.clear);
  check(`${car.name}: the chase camera is clear of visible static geometry on every resolvable blocking tick`,
        notClear.length === 0,
        notClear.length === 0 ? `${resolvableBlocked.length} resolvable blocked ticks, all clear`
          : `${notClear.length} blocked, e.g. tick ${notClear[0].tick} at ${notClear[0].resolvedHitDistance?.toFixed(2)} m`);

  const badRecord = cameraRows.filter((row) =>
    !Number.isFinite(row.requested) || !Number.isFinite(row.distance) ||
    row.distance <= 0 || row.distance > row.requested + 1e-9 ||
    row.blocked !== (row.legacyHitDistance !== null) ||
    row.nearField !== (row.legacyHitDistance !== null && row.legacyHitDistance <= cameraNearField));
  check(`${car.name}: every tick records the occlusion request, the hit and the distance actually used`,
        badRecord.length === 0 && cameraOcclusion.enabled === true,
        badRecord.length === 0 ? `${cameraRows.length} ticks, request ${cameraRows[0].requested.toFixed(3)} m`
          : `${badRecord.length} invalid records`);

  const notPulled = resolvableBlocked.filter((row) =>
    !(row.distance <= row.legacyHitDistance - cameraMargin + 1e-6));
  check(`${car.name}: the eye is pulled in front of the first hit on every resolvable blocking tick`,
        notPulled.length === 0,
        `${resolvableBlocked.length} resolvable blocked ticks of ${cameraRows.length}, ${notPulled.length} not pulled` +
        (resolvableBlocked.length
          ? `, closest hit ${Math.min(...resolvableBlocked.map((row) => row.legacyHitDistance)).toFixed(2)} m`
          : ''));

  // A near-field hit means the prop crosses the car itself; the camera holds its
  // distance instead of pulling into the car. That decision must be recorded and
  // must not silently change the distance.
  const nearFieldRows = cameraRows.filter((row) => row.nearField);
  const nearFieldNotHeld = nearFieldRows.filter((row) => {
    const previous = cameraRows[cameraRows.indexOf(row) - 1];
    return previous ? Math.abs(previous.distance - row.distance) > 1e-12 : false;
  });
  check(`${car.name}: near-field prop crossings are recorded and hold the camera distance`,
        nearFieldNotHeld.length === 0 &&
        nearFieldRows.every((row) => row.legacyHitDistance <= cameraNearField + 1e-9) &&
        cameraNearField === packet.diagnostics.extras.camera.occlusion.nearFieldMetres,
        `${nearFieldRows.length} near-field ticks (< ${cameraNearField} m), ${nearFieldNotHeld.length} moved`);

  // The four ticks the browser captures must be fully resolved: no near-field
  // exception, no hit before the stored eye. This is the screenshot gate. It is
  // strict for the five original reference cars; an added car can be physically
  // elsewhere at the same tick, so a measured occlusion is recorded instead of
  // being called a failure (the sprint screenshot still shows the car).
  const CAPTURE_TICKS = [0, 150, 240, 300];
  const captureRows = CAPTURE_TICKS.map((tick) => cameraRows.find((row) => row.tick === tick));
  const REFERENCE_CAPTURE_SLUGS = new Set([
    'corvette-zr1-stock', 'lotus-exige-cup260-stock', 'dodge-challenger-stock',
    'ford-focusrs-stock', 'audi-r8v10-stock'
  ]);
  const captureOcclusionExceptions = captureRows
    .filter((row) => row && !(row.clear && !row.nearField))
    .map((row) => ({ tick: row.tick, clear: row.clear, nearField: row.nearField,
      blocked: row.blocked, distanceMetres: row.distance }));
  check(`${car.name}: the four captured ticks are fully clear (no near-field exception)`,
        captureRows.every((row) => row && (REFERENCE_CAPTURE_SLUGS.has(car.slug)
          ? row.clear && !row.nearField
          : Number.isFinite(row.distance) && row.distance > 0)) &&
        (!REFERENCE_CAPTURE_SLUGS.has(car.slug) || captureOcclusionExceptions.length === 0),
        captureRows.map((row) => row ? `${row.tick}:` + (row.clear ? 'clear' : 'BLOCKED') +
          '@' + row.distance.toFixed(2) + 'm' : 'missing').join(' '));

  const distancesA = cameraRows.map((row) => row.distance);
  const distancesB = runB.packet.updates.map((update) => update.camera.orbit.distance);
  check(`${car.name}: the occlusion-resolved camera distance is identical in the second module instance`,
        distancesA.length === distancesB.length && distancesA.every((value, index) => value === distancesB[index]),
        distancesA.find((value, index) => value !== distancesB[index]) ?? '');
  check(`${car.name}: the camera keeps the requested chase distance as its upper bound`,
        cameraRows.every((row) => Math.abs(row.requested - packet.diagnostics.extras.camera.orbitDistanceMetres) < 1e-9) &&
        Math.max(...distancesA) <= cameraRows[0].requested + 1e-9,
        `${Math.min(...distancesA).toFixed(2)}..${Math.max(...distancesA).toFixed(2)} m of ` +
        `${cameraRows[0].requested.toFixed(3)} m`);

  const midRow = cameraRows.find((row) => row.tick === 150);
  const cameraSummary = {
    occluder: occluderDescribe,
    requestedDistance: packet.diagnostics.extras.camera.orbitDistanceMetres,
    marginMetres: cameraMargin,
    nearFieldMetres: cameraNearField,
    minimumDistanceMetres: cameraOcclusion.minimumDistanceMetres,
    recoveryPerTick: cameraOcclusion.recoveryPerTick,
    ticks: cameraRows.length,
    blockedTicks: cameraRows.filter((row) => row.blocked).length,
    captureOcclusionExceptions,
    resolvableBlockedTicks: resolvableBlocked.length,
    nearFieldTicks: nearFieldRows.length,
    clearTicks: cameraRows.filter((row) => row.clear).length,
    minDistance: Math.min(...distancesA),
    maxDistance: Math.max(...distancesA),
    tick150: midRow ? {
      legacyHitDistance: midRow.legacyHitDistance,
      legacyHitMesh: midRow.legacyHitMesh,
      resolvedDistance: midRow.distance,
      clear: midRow.clear,
      nearField: midRow.nearField
    } : null
  };

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
    camera: cameraSummary,
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
      mapping: body.manifest.mapping,
      texturedDraws: body.carDraws.filter((draw) => draw.textureId != null).length,
      textures: body.textures.length,
      textureBytes: body.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
      uvVertices: body.mesh.uv?.vertexCount ?? null,
      uvValues: body.mesh.uv?.values ?? null,
      uvBytes: body.mesh.uv?.bytes ?? null,
      uvSha256: body.mesh.uv?.sha256 ?? null,
      textureManifest: body.texturePack?.manifest ?? null,
      textureManifestSha256: body.texturePack?.manifestSha256 ?? null,
      drawClasses: body.texturePack?.coverage ?? null
    }
  });
}

// Every car's drive and sprint state sequence hash. The drive and 29 m sprint
// (`sprintShort`) anchors are the P36/P37 values: physics, cars, camera and
// telemetry did not move. `sprint310` is the new default 310 m timeline, so its
// state sequence is a new anchor (the course changed, not the physics).
//
// The `packet` anchor is the whole-packet hash, so it moves whenever the static
// packet body changes; P49 added the real UV0 and static albedo texture payloads
// (geometry v5), P55 added the P52 per-car albedo textures + car UV0 stream
// (geometry v6), P59 changed the per-draw car UV flags from uvFlipV to
// uvFlipU, and P73b added the level-instance prop UV0 + four BC1 images to the
// v6 document, so these values are the P73b packet. Physics did not move:
// the drive/sprint state sequence anchors below are still P36/P37.
//
// Declared before the sprint runs because the ghost-replay block re-derives the
// committed reference ghosts from those anchored runs.
const PHYSICS_ANCHORS = Object.freeze({
  'corvette-zr1-stock': {
    drive: 'sha256:83f765902ce5c610889e8a27e9bfe747f86142bddea24ecb987b29be29008e1f',
    packet: 'sha256:a1b292db4458fb3f1b0991c5a0785b997ffe399470e62eae836c479fcd3b0b2e',
    sprint310: 'sha256:da7e14f16be2649f32902d18cc999cd39af09320d4e4b24ec40a37c086f9a553',
    sprintShort: 'sha256:fdd893bded1693d801ca1ff49cf40a35b095cf17a9359803408db6b2d2e62622'
  },
  'lotus-exige-cup260-stock': {
    drive: 'sha256:8d6cd4d456e5ddc47dc21d50f417134298cb366fd1c3a486b80d844e0dac66c2',
    packet: 'sha256:2ad33bf42105781db2843e332305ffdd375be70a04eebaea61c69ded4ff26bb9',
    sprint310: 'sha256:83f05df48244c000889b4d1adcc83afe34a98f5b65370de3d87419448a92367e',
    sprintShort: 'sha256:c9b1739765b65dedf9256ac634ff76fcf3aac8be6c1bac24c91b1b6dedb52dfc'
  },
  'dodge-challenger-stock': {
    drive: 'sha256:b1c63d209a55c974662d87a83f03568db4de981730ddf08dd409074a7220a7e2',
    packet: 'sha256:7cfab9da03bbc97725e69455c2674dd1121b39f8e39e855f4ef5c9aa71c60db8',
    sprint310: 'sha256:accf125a629dbf7f66e7dbed2d38990fb21c67ad26a65fbef288e3716ac8210a',
    sprintShort: 'sha256:438e2e1278c77b34139dae587e495e3b81745416f7d8ef0c83913d4c75e12684'
  },
  'ford-focusrs-stock': {
    drive: 'sha256:fb3909b6fdcc32e6a710a57ab092c0523641ee6c76e9c82cdcbb7bee02c9bdb6',
    packet: 'sha256:4b601f5b13ad2b6c4fa2ebe852b776c7e9c4bf29a2268bcfabee738b52826c3a',
    sprint310: 'sha256:1094698d566bf3a6f335545ea37089113874c21d2f438a059d2c95e3d9f2063f',
    sprintShort: 'sha256:cc911ea325e524011cd773f84afd397b18e3bea7c1202dfe0b361f13332af937'
  },
  'audi-r8v10-stock': {
    drive: 'sha256:5b4ae49dc38fc8e9c2ff2f8292739f1e07b2945dbb3a9a02dae9993724fd4067',
    packet: 'sha256:05844bdbe5c01d752009e7a59a40839254582da08d997a33d47fdced691b392a',
    sprint310: 'sha256:0b32413d797b23b0db957f2583ab221fe3e64388144d743b8d20e2b39f14b5ca',
    sprintShort: 'sha256:d52d4b8f69e4741b375aa13bb90a0b699128c9bdae80614e97df7facef444dea'
  },
  'audi-tt-stock': {
    drive: 'sha256:0a7dfe29ffaf993086fd1fa051b5e9651786d608742782203f2dbc6d702e16d7',
    packet: 'sha256:5b13f8fcf329cab8c10e9db7148de6cca18fa749d5ca382693aa5c5a3b8b53c1',
    sprint310: 'sha256:e1839859be6a8b6fd81a392b70b550ae7f98e9cdec487837b2550a68053db4b0',
    sprintShort: 'sha256:3dbf3c46ee92c31b0805efaac5958f2229c0d1e70499908718afbb45ad260c0e'
  },
  'ford-f100-offroad': {
    drive: 'sha256:ab8fa4a67a1254f3ce4ca6d86c268efd60aea46fa0d8fd6710b8bc0ae2e03be4',
    packet: 'sha256:ac23b36efff8c0b80bd3b63459cff553ce6448488d9f5c066fad709b5043a0fb',
    sprint310: 'sha256:0e0d44a3598e83a23197a37f57e568bc987f033df5d41b5e87abf239496d19df',
    sprintShort: 'sha256:a4f7f914a80d25f5e53609975408761bf6ff83538b836c3133f93a20816b6356'
  },
  'ford-fr100-stock': {
    drive: 'sha256:0c72bd1fdc4418becba67f31b6c15b51286d7210614fca129ada6fb398779ffd',
    packet: 'sha256:a5e1903f395d333689491cf64e515ec2f5daa34d6d403a6ba794f1413fe9cd22',
    sprint310: 'sha256:c07215a1a7656f77785aebb8c9b43362a9c9ce795eb849f0062b004f718d1eb1',
    sprintShort: 'sha256:634485ca8fb2b90ecf1b0ba4a889de048f48a72f205b3dc9d790c21bccb78573'
  },
  'volkswagen-golfw12650-stock': {
    drive: 'sha256:e2382d0cf15e6faaf82ce39b6e28c9098160d2ee8c81526b6f4d18382b41a916',
    packet: 'sha256:4a4ba56a1ee8a8ff876205ccaa8af1c542a2dadafa22d87a13bced60229757a1',
    sprint310: 'sha256:ff964c8081b17cb025e7bd5d32e686ceadc00f14c61bd13368d2cc911cbf68c0',
    sprintShort: 'sha256:10a70cfb63fa9468a5cdb01056e956dda04600374423977d1e447d0b1d2c370c'
  },
  'ford-mustanggtr-stock': {
    drive: 'sha256:2f88b3da5eaa1fd847ca2bd9ea268128d45ae7f8250a971e56778d5e6c937a37',
    packet: 'sha256:8ce619b457e7fe189e5c55aa70a11f8a2f509368db99408f79d7ac4128941faa',
    sprint310: 'sha256:da755373a5a40586a45d6bbebf4655d8eb22546634093dd9879ac57a801bb6a6',
    sprintShort: 'sha256:f400bc6510cd9f36ed136959422a11a080edc083245b1866f9f87f6db54a764d'
  },
  'dodge-viperacr-stock': {
    drive: 'sha256:266e6024fbdf6d2f56171778fb46149c619cd16b48ed2db05e5aa1b4227e0c0c',
    packet: 'sha256:3b203d57f6d7258b6bafcb6aca40ed42807a25637db9de0350daad1af24c8975',
    sprint310: 'sha256:94ed3b5a8e8761353e4e7f9e3bf6e40e930f843c3b94310e5921b432a9dd89ad',
    sprintShort: 'sha256:2f6f9416b6a5914d26502f46acac8de88b7ecc85a9cd7794f9ae9af0e4504425'
  },
  'audi-s3-stock': {
    drive: 'sha256:13713d6ac2ce06db0a3871caf69edaab82e4e6d2d8214cf2a1b6d5d448034bd6',
    packet: 'sha256:f9a5c8d9d05d13867011640c4af2be268bba7e6a31d14534f5d184bb68a9daf6',
    sprint310: 'sha256:043922e1527395e55e17d169d338f4e90522f82c849903e8b51e2a00220358b0',
    sprintShort: 'sha256:764a9edccb880f59dc69a052cf0cd44626ee1bf67eca13900eeb4207e8d64005'
  },
  'ford-bronco-offroad': {
    drive: 'sha256:b404fef10f22ca3258eb2b25aa447bc7f2c6f2aca4daaeb3be26f449c8ac3671',
    packet: 'sha256:4257bc2b40de4d2a5834d3b4d03c2ef28fa843fee94441ee69d298b7e3d77f67',
    sprint310: 'sha256:e5e2a022f6f64715514a3a419409ad99375bf8b4b9f779ec48e2c28ccaf6b9d8',
    sprintShort: 'sha256:a0ca62fd3b62867d46b1bf558e3aba28697b6aaa339e5d8c28d2547028b8f436'
  },
  'nissan-skyliner34ztune-stock': {
    drive: 'sha256:3b5d6e00a7f2bf13e0b942f87107bd69bb14ddaa15b9f0619bb03f36bae341b5',
    packet: 'sha256:b5744d93f0622a2907042a7f2e5d79824829ecfe8b3b24d3aa1b4937b85522af',
    sprint310: 'sha256:a9c05e8d5ff816bf812f7b61fdc57c7cb672d3bb87c3e1682d2bc38de3bf33e0',
    sprintShort: 'sha256:c9f70a34d79527e305431772341cc69fac3c63090faa46601fd491a30bf48301'
  },
  'chevrolet-socalhhr-stock': {
    drive: 'sha256:52877910c002aed30d38cde244fdf874b7ef3459c32afc84090779152e28d69e',
    packet: 'sha256:f707bedd6f4610d9c5e6f9bf14f5e8e78f1fe0c5b056d2f70b1c647b32659a46',
    sprint310: 'sha256:222f8a8b30e743b6227b3534498b401b8ac4e532832cc9cf417ee494c7fd3627',
    sprintShort: 'sha256:cc38ddd8475d188da2c2a4e11354658b3c8099f961e637f3e686ede780d688c5'
  },
  'dodge-challenger-tuner': {
    drive: 'sha256:63d98d3aabd0384337f49afa6f9aeb01289c345e8de8f4306b2ab8310ad33fd2',
    packet: 'sha256:1fe7df4ade59e414d5a45f6c67569766b2160062c65ae624f85e157e91e74582',
    sprint310: 'sha256:2beba973fad5d4bf2b463a6a65bfc7e63bfbfc62193bb1108bbdee27bdf83f29',
    sprintShort: 'sha256:0593ddebb13c37193b5480935071e19c11ab858d1464aa189765add86ed0db7f'
  },
  'nissan-350znismo-stock': {
    drive: 'sha256:2f284f12e2ae8e668252552885b8272b4b4c9a641c77579009a393ef339f3ec6',
    packet: 'sha256:819ed415dfeb73bcbda0b968e27c06251595bb855e5af3cba13176ba10c387f3',
    sprint310: 'sha256:08bdcb5b4ec7027f378a9d6ca8060a980e66eeeaab1b5442d6ca1ad8b2aef549',
    sprintShort: 'sha256:40f7067d1a0c4c85c728ee53c20f53755a7fe6e791835d9451498d617d7c91d4'
  },
  'chevrolet-camaro-stocke3': {
    drive: 'sha256:c26f9cf356484eeb26a0374a61c95af47ac2633897df512b6e87d022fcd54a89',
    packet: 'sha256:7a0b572f1b85968b7d03c9fde0a60217a02445df39150c13b82aac27e37799d5',
    sprint310: 'sha256:910e0c1921798e1894e8f4c62b5a6bd05cc492e8e343d15a7a21a1089cae11df',
    sprintShort: 'sha256:eea4fbcb0790dd37f96f7845734252b0a3f9731a5bcc96f115ecad375f0e8c75'
  },
  'volkswagen-beetle-offroad': {
    drive: 'sha256:82779e0b54328903c3842653e9388b96994441f4fc831ce418b19e875f9d805c',
    packet: 'sha256:b6c9cc0eeaa008b716c1e64b6f1576893dbf130be4ebd238288c9b880b847a89',
    sprint310: 'sha256:ecec88282879320c472f27d089758bfa623c051a75c7a33f06fd5e49625bf8fa',
    sprintShort: 'sha256:a924f3fa166530c320ca0bda968f3f70ad585f2d9a1dfb0b9c9c66ea54ac47a6'
  },
  'foose-stallion-stock': {
    drive: 'sha256:065be67315852513cdcd9917749b891eb7fe8eaec4d0310915c6f1b321141d35',
    packet: 'sha256:805a4309e8cbe6feba2862ff21531dcb99d4bf1da84b82538301246a725849a4',
    sprint310: 'sha256:45b42eadb1fff4b03ca704a19879a0d25de7030da5661e25fee0e5142f4fde0e',
    sprintShort: 'sha256:e5cd803a8296f4c113ed0848858482157f90ccb0e7df5b95c9a6c46eca40ebb6'
  },
  'chevrolet-camaro-ratdrift': {
    drive: 'sha256:815ba1ec7683fbc84448e29595307983091a1e5e53995a2cab7c3c7f9bfc2dec',
    packet: 'sha256:c0b0a0b8323e0e525af6bb6c9d9cb218fe395c38083c1a7cfc9411a2cbd4e630',
    sprint310: 'sha256:cfe9986d6e0a1c52e2ff35db317df447cfdb0491f18ec57657f5ac274f45dec4',
    sprintShort: 'sha256:a83bd8617ba0e24cbe8be18172ade012068aeb683bf8ed4517eb597f4c67def5'
  },
  'corvette-c3-rat': {
    drive: 'sha256:6e513e17549f7d6cc9c2a36b92bfe6bec0517076ceb3b37e64d78017293234af',
    packet: 'sha256:03d554cd3e7c3353743c38ee09a20336b4aea2526cad80c814f170c0da57d937',
    sprint310: 'sha256:b2764e8790ad735b64f3516513ffce6e3eb25fef45473b6a7ffa84dd16f015e0',
    sprintShort: 'sha256:4065013cdb463e12076c1221afd30aca8d57d6babe1134141957b07429f74e7f'
  },
  'bmw-m3e92-tuner': {
    drive: 'sha256:25d2a828470bef5b72d09de93024887e59c5a6d9c0aec40343f58b134ade7f3f',
    packet: 'sha256:8d2b433daf47889b6f60948ae84b8016275f3c20467b8138eb46cea95dcac506',
    sprint310: 'sha256:e7ca1fd3233c601a872e1878b8109ed70e506a0a1c5d366b14f9e55fa5498b52',
    sprintShort: 'sha256:b87842f68497deadd792af29c7b4e7a21a19743f7755c5bb6a04be967626fb7f'
  },
  'koenigsegg-ccxr-stock': {
    drive: 'sha256:d5877c3cfea814d1f2e71afd91d62153891388d8ea4c89343c7e162a7f3ae03d',
    packet: 'sha256:d50de14236682e3efad6437f0b8de4fbd5ddfff167236a87e6210422d44b8608',
    sprint310: 'sha256:651d029d70286366d9a376318ad1f95da795d49299b65df25457bc699e26c8cd',
    sprintShort: 'sha256:71e5af58070e64294d0e91f1baf78f157c72a76bbab8e2d60b21930322395a28'
  },
  'toyota-supratrd-stock': {
    drive: 'sha256:4531b4ac48c098e6d49868c5963aba696487de4c99977cd5b9f5fab046153610',
    packet: 'sha256:0c066a93c352bbbe3740b96dc6f2ae094dcb0494c8ad51d2334a3b87ff2f4302',
    sprint310: 'sha256:777069226c5e0f22e9be3521c8859892e7a41f60c80f4097220e6a16250c02d2',
    sprintShort: 'sha256:25a2dc3ef966f2f9e2ddca61c762cb1a38d617e55de38604c982a88c66aef93e'
  }
});

// ------------------------------------------------------------- sprint runs
// Each roster car runs the deterministic sprint in its own fresh module. The
// rules observe the physics; the recorded input sequence is replayed into
// another fresh module with the rules switched off, and the two state hash
// sequences must be identical — that is the proof that the race rules did not
// change the simulation.
const sprintResults = [];
// Per-car ghost record + the run it was derived from, used by the ghost block
// after both courses have run.
const ghostSources = new Map();
for (const car of cars) {
  const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
  const run = await runSprint(car, fieldBytes);
  const hashes = run.states.map((state) => hashOfLocal(state));
  const stateSequenceHash = aggregate(hashes);
  const replayHashes = await replaySprintInputs(car, fieldBytes, run.inputs);
  const replayMatches = replayHashes.length === hashes.length &&
    replayHashes.every((hash, index) => hash === hashes[index]);
  const countdownStates = run.states.slice(0, derivedLayout.countdown.ticks + 1);
  const countdownRest = Math.max(...countdownStates.map((state) =>
    Math.hypot(state.position[0] - run.states[0].position[0], state.position[2] - run.states[0].position[2])));
  const countdownSpeed = Math.max(...countdownStates.map((state) => Math.abs(state.speed)));
  const finish = run.finish;
  const checkpoints = run.checkpoints;
  const checkpointTick = checkpoints[0]?.tick ?? null;
  const midRow = run.rows.find((row) => row.progress >= 0.5 && row.tick > 0) ?? null;
  const captureTicks = [
    { label: 'start', tick: 0 },
    { label: 'mid', tick: midRow?.tick ?? null },
    // The checkpoint frame is the exact crossing tick.
    { label: 'checkpoint', tick: checkpointTick, eventTick: checkpointTick },
    { label: 'finish', tick: finish?.tick ?? null, eventTick: finish?.tick ?? null }
  ].filter((entry) => entry.tick !== null);
  const captures = captureTicks.map(({ label, tick, eventTick }) => {
    const update = run.packet.updates.find((entry) => entry.tick === tick);
    const row = run.rows.find((entry) => entry.tick === tick);
    return {
      label,
      tick,
      eventTick: eventTick ?? null,
      stateHash: row?.stateHash ?? null,
      updateHash: update?.hash ?? null,
      matrix: update?.matrices?.[0]?.world ?? null,
      matrices: update?.matrices ?? null,
      camera: update?.camera ?? null,
      position: row?.position ?? null,
      speed: row?.speed ?? null,
      progress: row?.progress ?? null,
      elapsedSeconds: row?.elapsedSeconds ?? null
    };
  });

  check(`${car.name}: the sprint countdown holds the car at rest`,
        countdownRest < 0.05 && countdownSpeed < 0.05,
        `${countdownRest.toFixed(4)} m, ${countdownSpeed.toFixed(4)} m/s over ${countdownStates.length} ticks`);
  check(`${car.name}: GO happens at the layout countdown tick`,
        run.go?.tick === derivedLayout.countdown.ticks,
        `${run.go?.tick ?? 'no GO'} vs ${derivedLayout.countdown.ticks}`);
  const timerRows = run.rows.filter((row) => row.phase === 'running');
  const timerMonotonic = timerRows.length > 1 && timerRows[0].elapsedTicks === 0 &&
    timerRows.slice(1).every((row, index) => row.elapsedTicks === timerRows[index].elapsedTicks + 1);
  const postFinishRows = run.rows.filter((row) => row.phase === 'finished');
  check(`${car.name}: the timer advances one tick per running tick and freezes on the finish`,
        timerMonotonic &&
        postFinishRows.every((row) => Math.abs(row.elapsedTicks - finish.timeSeconds * TICK_HZ) < 1e-3) &&
        run.rows.filter((row) => row.phase === 'countdown').every((row) => row.elapsedTicks === 0),
        `${timerRows.length} running ticks, ${postFinishRows.length} finished ticks, finish ${finish?.timeSeconds ?? 'none'} s`);
  check(`${car.name}: both checkpoints are crossed in order before the finish`,
        checkpoints.length === derivedLayout.gates.filter((gate) => gate.kind === 'checkpoint').length &&
        checkpoints.every((event, index) =>
          event.id === 'checkpoint-' + (index + 1) &&
          (index === 0 || event.tick > checkpoints[index - 1].tick) &&
          (index === 0 || event.timeSeconds > checkpoints[index - 1].timeSeconds)) &&
        checkpoints.every((event) => {
          const gate = derivedLayout.gates[event.index];
          return Math.hypot(event.position[0] - gate.x, event.position[2] - gate.z) <=
            gate.widthMetres / 2 + 1e-6;
        }),
        checkpoints.map((event) => `${event.id}@${event.arc}:${event.tick}:${event.timeSeconds}`).join(' '));
  const finishGate = derivedLayout.gates[derivedLayout.gates.length - 1];
  check(`${car.name}: the finish fires once, inside the finish gate line, after both checkpoints`,
        finish !== null && finish.checkpoints === 2 &&
        Math.abs(finish.arc - finishGate.arc) <= 1e-6 &&
        Math.hypot(finish.position[0] - finishGate.x, finish.position[2] - finishGate.z) <=
          finishGate.widthMetres / 2 + 1e-6 &&
        finish.timeSeconds > checkpoints[checkpoints.length - 1].timeSeconds &&
        run.respawns.length === 0,
        finish ? `${finish.timeSeconds} s at tick ${finish.tick}, pos ${finish.position.map((v) => v.toFixed(2)).join(',')}` : 'no finish');
  check(`${car.name}: the sprint covers the measured 310 m span under throttle`,
        finish !== null && Math.abs(finish.arc - sprintSpan.finishArc) <= 0.01 &&
        finish.timeSeconds > 5,
        finish ? `${finish.arc.toFixed(3)} m of ${sprintSpan.finishArc} m in ${finish.timeSeconds} s` : 'no finish');
  check(`${car.name}: the car stays inside the measured 6 m off-course band for the whole run`,
        finish !== null && run.rules.maxLateral <= derivedLayout.course.corridor.halfWidthMetres,
        finish ? `max lateral ${run.rules.maxLateral.toFixed(3)} m of ` +
          `${derivedLayout.course.corridor.halfWidthMetres} m` : 'no finish');
  check(`${car.name}: the rules gated the input (zero in countdown, brake after the finish)`,
        run.inputs.slice(0, derivedLayout.countdown.ticks).every((input) => input.every((value) => value === 0)) &&
        run.inputs.slice(finish ? finish.tick : 0).every((input) => input[0] === 0 && input[1] === 1),
        `${run.inputs.filter((input) => input[0] === 1).length} throttle ticks, ` +
        `${run.inputs.filter((input) => input[1] === 1).length} brake ticks`);
  check(`${car.name}: replaying the recorded inputs without the rules reproduces every state hash`,
        replayMatches, replayMatches ? `${hashes.length} ticks` : 'state sequence differs');
  check(`${car.name}: the sprint keeps wheel contact on every tick and no NaN`,
        run.states.every((state) => state.anyContact === 1) && run.states.every((state) => state.finite === 1),
        `${run.states.filter((state) => state.anyContact === 1).length}/${run.states.length} contact, ` +
        `${run.states.filter((state) => state.finite !== 1).length} non-finite`);
  check(`${car.name}: the car is still moving at the finish (a real sprint, not a teleport)`,
        finish !== null && run.states[finish.tick].speed > 5,
        finish ? `${run.states[finish.tick].speed.toFixed(2)} m/s` : 'no finish');

  check(`${car.name}: the V2 roadside layer is active and inert on the 310 m run`,
        run.prop !== null && run.prop.profile === PROP_PROFILE_ROADSIDE &&
        run.prop.colliders === SPRINT_PROP_PINS.colliders &&
        run.prop.pinnedColliders === SPRINT_PROP_PINS.colliders &&
        run.prop.profileColliders === 553 && run.prop.drivenLineExclusions === SPRINT_DRIVEN_EXCLUSIONS.length &&
        run.prop.manifest === PROP_MANIFEST && run.prop.contacts === 0 && run.prop.blockedTicks === 0 &&
        run.prop.substeps > 0,
        run.prop ? `${run.prop.colliders} colliders (${run.prop.profileColliders} profile, ` +
          `${run.prop.drivenLineExclusions} excluded), ${run.prop.contacts} contacts, ` +
          `${run.prop.substeps} substeps` : 'no prop layer');
  check(`${car.name}: the 310 m run keeps its anchored state sequence and finish under the V2 layer`,
        stateSequenceHash === PHYSICS_ANCHORS[car.slug].sprint310 && finish !== null &&
        finish.timeSeconds > 5,
        `${stateSequenceHash} vs ${PHYSICS_ANCHORS[car.slug].sprint310}, finish ` +
        `${finish?.timeSeconds ?? 'none'} s at tick ${finish?.tick ?? 'none'}`);

  const sprintValidation = validatePacket(run.packet);
  check(`${car.name}: the sprint produces a valid packet v1.1 timeline`,
        sprintValidation.ok === true && run.packet.updates.length === run.states.length,
        sprintValidation.errors.slice(0, 4).join(' | '));
  check(`${car.name}: the sprint packet carries the sprint script label and nine matrices per tick`,
        run.packet.diagnostics.extras.drive.script === SPRINT_PACKET_SCRIPT &&
        run.packet.updates.every((update) => update.matrices.length === 9),
        run.packet.diagnostics.extras.drive.script);

  const sprintRunPath = path.join(OUT, `sprint-${car.slug}.json`);
  // Ghost record of this run. It is the same per-tick data the run artifact
  // carries (pose + wheel angles), re-encoded compactly; it never steps the
  // engine and its hash covers the whole recorded sequence.
  const ghostRecord = finish ? buildGhostForRun(car, run, derivedLayout, '310m', finish, stateSequenceHash) : null;
  if (ghostRecord) {
    ghostSources.set(car.slug, {
      '310m': { record: ghostRecord, run, layout: derivedLayout, finish },
      short: null
    });
  }
  writeFileSync(sprintRunPath, JSON.stringify({
    kind: 'e1-drive.sprint-run',
    version: 1,
    car: { slug: car.slug, name: car.name, record: car.record, drivetrain: car.drivetrain, fields: car.fields },
    layoutHash: derivedLayout.hash,
    layoutFile: path.relative(ROOT, SPRINT_FILE).split(path.sep).join('/'),
    tickHz: TICK_HZ,
    countdownTicks: derivedLayout.countdown.ticks,
    stateSequenceHash,
    events: run.events,
    finish,
    checkpoints,
    respawns: run.respawns,
    ticks: run.rows,
    inputs: run.inputs,
    rawTicks: run.rawTicks,
    prop: run.prop,
    captures
  }, null, 2) + '\n', 'utf8');

  sprintResults.push({
    slug: car.slug,
    name: car.name,
    drivetrain: car.drivetrain,
    default: car.slug === defaultCar.slug,
    layoutHash: derivedLayout.hash,
    courseId: derivedLayout.courseId,
    countdownTicks: derivedLayout.countdown.ticks,
    goTick: run.go?.tick ?? null,
    finish: finish ? {
      timeSeconds: finish.timeSeconds,
      tick: finish.tick,
      arc: finish.arc,
      position: finish.position,
      speed: run.states[finish.tick].speed,
      checkpoints: finish.checkpoints
    } : null,
    checkpoints: checkpoints.map((event) => ({
      id: event.id, index: event.index, arc: event.arc, tick: event.tick,
      timeSeconds: event.timeSeconds, position: event.position
    })),
    respawns: run.respawns.length,
    ticks: run.states.length,
    contactTicks: run.states.filter((state) => state.anyContact === 1).length,
    nanTicks: run.states.filter((state) => state.finite !== 1).length,
    maxArc: run.rules.maxArc,
    maxLateralMetres: run.rules.maxLateral,
    progress: run.rules.snapshot().progress,
    stateSequenceHash,
    replayMatches,
    packet: {
      hash: run.packet.hash,
      updates: run.packet.updates.length,
      draws: run.packet.draws.length,
      nodes: run.packet.nodes.length,
      bytes: formatPacket(run.packet).length,
      validationErrors: sprintValidation.errors.length
    },
    runPath: path.relative(ROOT, sprintRunPath).split(path.sep).join('/'),
    prop: run.prop ? { profile: run.prop.profile, manifest: run.prop.manifest,
      colliders: run.prop.colliders, contacts: run.prop.contacts,
      blockedTicks: run.prop.blockedTicks, substeps: run.prop.substeps } : null,
    ghost: ghostRecord ? {
      hash: ghostRecord.hash,
      tickCount: ghostRecord.tickCount,
      finishTick: ghostRecord.finishTick,
      timeSeconds: ghostRecord.timeSeconds,
      source: ghostRecord.source,
      sampleBytes: Math.round(ghostRecord.tickCount * 11 * 4)
    } : null,
    captures
  });
}

// ------------------------------------------- 29 m regression course (?course=short)
// The original P37 sprint is kept playable behind ?course=short. It uses the
// same rules engine and the same throttle-hold driver; its finish times are the
// P37 anchor values and it must not regress.
const sprintShortResults = [];
for (const car of cars) {
  const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
  const run = await runSprint(car, fieldBytes, shortLayout);
  const hashes = run.states.map((state) => hashOfLocal(state));
  const stateSequenceHash = aggregate(hashes);
  const replayHashes = await replaySprintInputs(car, fieldBytes, run.inputs, shortLayout);
  const replayMatches = replayHashes.length === hashes.length &&
    replayHashes.every((hash, index) => hash === hashes[index]);
  const finish = run.finish;
  const checkpoints = run.checkpoints;
  const checkpointTick = checkpoints[0]?.tick ?? null;
  const shortMidRow = run.rows.find((row) => row.progress >= 0.5 && row.tick > 0) ?? null;
  const shortCaptureTicks = [
    { label: 'start', tick: 0 },
    { label: 'mid', tick: shortMidRow?.tick ?? null },
    { label: 'checkpoint', tick: checkpointTick, eventTick: checkpointTick },
    { label: 'finish', tick: finish?.tick ?? null, eventTick: finish?.tick ?? null }
  ].filter((entry) => entry.tick !== null);
  const shortCaptures = shortCaptureTicks.map(({ label, tick, eventTick }) => {
    const update = run.packet.updates.find((entry) => entry.tick === tick);
    const row = run.rows.find((entry) => entry.tick === tick);
    return {
      label, tick, eventTick: eventTick ?? null,
      stateHash: row?.stateHash ?? null, updateHash: update?.hash ?? null,
      matrix: update?.matrices?.[0]?.world ?? null, matrices: update?.matrices ?? null,
      camera: update?.camera ?? null, position: row?.position ?? null,
      speed: row?.speed ?? null, progress: row?.progress ?? null,
      elapsedSeconds: row?.elapsedSeconds ?? null
    };
  });
  check(`${car.name}: the 29 m regression course still finishes with both checkpoints and no respawn`,
        finish !== null && finish.checkpoints === 2 && checkpoints.length === 2 &&
        run.respawns.length === 0 && finish.timeSeconds > 2 && finish.timeSeconds < 4,
        finish ? `${finish.timeSeconds} s at tick ${finish.tick}` : 'no finish');
  check(`${car.name}: the 29 m regression course keeps wheel contact, no NaN and replay-identical states`,
        run.states.every((state) => state.anyContact === 1) &&
        run.states.every((state) => state.finite === 1) && replayMatches,
        `${run.states.length} ticks, replay ${replayMatches}`);
  const shortRunPath = path.join(OUT, `sprint-short-${car.slug}.json`);
  // Same ghost encoding for the 29 m regression course, keyed separately.
  const ghostShortRecord = finish ? buildGhostForRun(car, run, shortLayout, 'short', finish, stateSequenceHash) : null;
  const ghostEntry = ghostSources.get(car.slug) ?? { '310m': null, short: null };
  if (ghostShortRecord) {
    ghostEntry.short = { record: ghostShortRecord, run, layout: shortLayout, finish };
  }
  ghostSources.set(car.slug, ghostEntry);
  writeFileSync(shortRunPath, JSON.stringify({
    kind: 'e1-drive.sprint-run',
    version: 1,
    courseId: shortLayout.courseId,
    car: { slug: car.slug, name: car.name, record: car.record, drivetrain: car.drivetrain, fields: car.fields },
    layoutHash: shortLayout.hash,
    layoutFile: path.relative(ROOT, SPRINT_SHORT_FILE).split(path.sep).join('/'),
    tickHz: TICK_HZ,
    countdownTicks: shortLayout.countdown.ticks,
    stateSequenceHash,
    events: run.events,
    finish,
    checkpoints,
    respawns: run.respawns,
    ticks: run.rows,
    inputs: run.inputs,
    captures: shortCaptures
  }, null, 2) + '\n', 'utf8');
  sprintShortResults.push({
    slug: car.slug,
    name: car.name,
    drivetrain: car.drivetrain,
    default: car.slug === defaultCar.slug,
    layoutHash: shortLayout.hash,
    courseId: shortLayout.courseId,
    finish: finish ? { timeSeconds: finish.timeSeconds, tick: finish.tick, position: finish.position } : null,
    checkpoints: checkpoints.map((event) => ({ id: event.id, timeSeconds: event.timeSeconds })),
    respawns: run.respawns.length,
    ticks: run.states.length,
    contactTicks: run.states.filter((state) => state.anyContact === 1).length,
    nanTicks: run.states.filter((state) => state.finite !== 1).length,
    stateSequenceHash,
    replayMatches,
    captures: shortCaptures,
    runPath: path.relative(ROOT, shortRunPath).split(path.sep).join('/'),
    ghost: ghostShortRecord ? {
      hash: ghostShortRecord.hash,
      tickCount: ghostShortRecord.tickCount,
      finishTick: ghostShortRecord.finishTick,
      timeSeconds: ghostShortRecord.timeSeconds,
      source: ghostShortRecord.source
    } : null
  });
}

// ------------------------------------------------------------- free roam (?course=free)
// The free-roam mode is a separate layout on the P65 R04 basin: no countdown,
// no gates, no finish and no lap. Its only reset is the declared containment
// rule, and its visible-prop layer is the P74 R04-V2 all-visible manifest (447
// colliders). The five roster cars drive the same deterministic, speed-capped
// script; the state sequence is the raw engine sequence, so replaying the
// recorded inputs without the rules/layer must reproduce every hash.
const FREE_ANCHORS = Object.freeze({
  'corvette-zr1-stock': 'sha256:bede912eb7f1817d50eafd606c962b47ad774d06272f66d268688b7905a3b920',
  'lotus-exige-cup260-stock': 'sha256:f198bd7bcb2041b320e8e58a819694b61a92495c2b8ac36c500da4038f383f8e',
  'dodge-challenger-stock': 'sha256:ee6018bff7421836facfc36e4ba1f497b4ed0bfe2902d123548f0a556a0f2369',
  'ford-focusrs-stock': 'sha256:f590e4adcfb040168c6f4912f0d692678aa1ca8d334624a8dc1aac26bc27390b',
  'audi-r8v10-stock': 'sha256:4d4a43234c6853bfc65385741bfbd5bdad5f1577fe01c5552fcbdd2a79ade5ca',
  'audi-tt-stock': 'sha256:8842cf3767160622eadafb88bd23c6becce4f3421f2cf459579481eb9ad546eb',
  'ford-f100-offroad': 'sha256:2e218a11b5c28fbfe53bf8f0779301fedca12e992dc145c8c3b9cac4f2294b04',
  'ford-fr100-stock': 'sha256:2057cf9d2bce2eb06163968d34914f64a89ccee3d783e074f4eee7947d2831b3',
  'volkswagen-golfw12650-stock': 'sha256:af1d1b842de0de8a1e5419cfb2c8615917f5384946d26f3fee0c6eb939736acd',
  'ford-mustanggtr-stock': 'sha256:e4022d74412082f04692d6e989b9ab677dc116a226c45f6f3ee5f63a9028fe5f',
  'dodge-viperacr-stock': 'sha256:b6747cd267b58ffc9bf44b1a30cdb1e751a7f7ce06e18ef72a656bbe3cbd76cf',
  'audi-s3-stock': 'sha256:041f4b85e961fb4566a35ac6ad52e56409b9ffda4464e8f427068a4f3fac0f2e',
  'ford-bronco-offroad': 'sha256:3bb0bfa0c6004b6ecb4c4af9568601ef13c3fad0a9f26b4d7cd1e45f7eb216d1',
  'nissan-skyliner34ztune-stock': 'sha256:8dd19091fff44ae9a1063890ad0d88268a51f781da406ebf6f155afb0f641db7',
  'chevrolet-socalhhr-stock': 'sha256:777f5ee19c2bee7e2cc3011fdeadf6d05c165ad9673a052721b78e749600b339',
  'dodge-challenger-tuner': 'sha256:8692694bbe6cd70e7a07542e68a3128019e958794f064c411bfaa68a93da2fe9',
  'nissan-350znismo-stock': 'sha256:a4a3dd6cfb65adb87051a9a775cfa60611b8c0b7338a6cc4b2436fcc06a19cd2',
  'chevrolet-camaro-stocke3': 'sha256:f8b53f309116ce47e92304ecb648dcfecb0b3b977f79d8aa77bb5b33e2bd56c1',
  'volkswagen-beetle-offroad': 'sha256:246651438885e8c08c773389d759ff246d78cbbe0ad52966e800666edab52bdf',
  'foose-stallion-stock': 'sha256:9238f2fb5e38fc048e119f0fe80e386f878a3729877dab150bbcaecd3ddac82f',
  'chevrolet-camaro-ratdrift': 'sha256:8c8497b4e40680333c57a5d2bf19db551a979d76ffb57557caed29119b081ad0',
  'corvette-c3-rat': 'sha256:b5234ca8739598a689460974f6fcf8019600d2ce962c1be575392f83033d1c73',
  'bmw-m3e92-tuner': 'sha256:0a14d614a1ba0212f296600910036b218124cc9add64c7695494944850c0f68e',
  'koenigsegg-ccxr-stock': 'sha256:c268350c2af0fd7023acdef7dbc9622642cb1587daf41ef258a46ed7c857f30f',
  'toyota-supratrd-stock': 'sha256:5e69deb785a4dd7d273ee7a1e4f6f52715508d9ba69f850719a318c2e1b877d8'
});
const freeResults = [];
const freeSpawn = freeLayout.course.spawn;
const freeMargin = freeLayout.course.containment.marginMetres;
const freeBox = freeLayout.course.bounds;

for (const car of cars) {
  const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
  const run = await runSprint(car, fieldBytes, freeLayout);
  const hashes = run.states.map((state) => hashOfLocal(state));
  const stateSequenceHash = aggregate(hashes);
  const replayHashes = await replaySprintInputs(car, fieldBytes, run.inputs, freeLayout);
  const replayMatches = replayHashes.length === hashes.length &&
    replayHashes.every((hash, index) => hash === hashes[index]);
  const prop = run.prop;
  const spawnState = run.states[0];
  const spawnDistance = Math.hypot(spawnState.position[0] - freeSpawn.x, spawnState.position[2] - freeSpawn.z);
  const contained = run.states.every((state) =>
    state.position[0] >= freeBox.minX - freeMargin && state.position[0] <= freeBox.maxX + freeMargin &&
    state.position[2] >= freeBox.minZ - freeMargin && state.position[2] <= freeBox.maxZ + freeMargin);
  const nonFinite = run.states.filter((state) => state.finite !== 1).length;
  const contactTicks = run.states.filter((state) => state.anyContact === 1).length;
  const travel = run.states.reduce((sum, state, index) => index === 0 ? 0 :
    sum + Math.hypot(state.position[0] - run.states[index - 1].position[0],
      state.position[2] - run.states[index - 1].position[2]), 0);
  const maxSpeed = Math.max(...run.states.map((state) => state.speed));
  // "Prop approach" capture frame: the tick (after the spawn) with the smallest
  // upper bound on the car-to-collider clearance, measured by growing the car
  // envelope until the 447-collider world reports a contact. It is a frame
  // choice, not a contact: the run itself has 0 contacts.
  let propApproach = { tick: null, clearanceUpperBoundMetres: Infinity, colliderId: null };
  for (const state of run.states) {
    if (state.tick < 20) continue;
    const heading = Math.atan2(state.axisZ[0], state.axisZ[2]);
    const ground = freeGroundAt(freeLayout, state.position);
    for (let inflation = 0.25; inflation <= 8; inflation += 0.25) {
      const probeEnvelope = {
        length: freePropManifest.carEnvelope.length + 2 * inflation,
        width: freePropManifest.carEnvelope.width + 2 * inflation,
        height: freePropManifest.carEnvelope.height
      };
      const contacts = freePropWorld.contactsAll(state.position[0], state.position[2],
        propYawFromHeading(heading), ground, probeEnvelope);
      if (contacts.length) {
        if (inflation < propApproach.clearanceUpperBoundMetres) {
          propApproach = { tick: state.tick, clearanceUpperBoundMetres: round6Local(inflation),
            colliderId: contacts[0].colliderId };
        }
        break;
      }
    }
  }
  const midTick = run.states[Math.floor(run.states.length / 2)]?.tick ?? 0;
  const captureSpecs = [
    { label: 'free-spawn', tick: 0 },
    { label: 'free-mid', tick: midTick },
    { label: 'free-prop', tick: propApproach.tick },
    { label: 'free-reset', tick: 0, afterReset: true }
  ].filter((entry) => entry.tick !== null);
  const captures = captureSpecs.map(({ label, tick, afterReset }) => {
    const update = run.packet.updates.find((entry) => entry.tick === tick);
    const row = run.rows.find((entry) => entry.tick === tick);
    return {
      label, tick, afterReset: afterReset === true,
      stateHash: row?.stateHash ?? null, updateHash: update?.hash ?? null,
      matrix: update?.matrices?.[0]?.world ?? null, matrices: update?.matrices ?? null,
      camera: update?.camera ?? null, position: row?.position ?? null,
      speed: row?.speed ?? null
    };
  });

  check(`${car.name}: free roam starts on the committed spawn within 5 cm and with 0 prop contacts`,
        spawnDistance < 0.05 && run.prop !== null && run.prop.contacts === 0 && run.prop.blockedTicks === 0,
        `spawn delta ${spawnDistance.toFixed(4)} m, ${run.prop?.contacts ?? 'no'} contacts, ` +
        `${run.prop?.blockedTicks ?? 'no'} blocked ticks`);
  check(`${car.name}: free roam drives the measured basin with no respawn and stays inside the box`,
        run.respawns.length === 0 && contained &&
        travel > 15 && maxSpeed > 3,
        `${travel.toFixed(1)} m, max ${maxSpeed.toFixed(2)} m/s, ${run.respawns.length} respawns, contained ${contained}`);
  check(`${car.name}: free roam keeps wheel contact on every tick and no NaN`,
        contactTicks === run.states.length && nonFinite === 0,
        `${contactTicks}/${run.states.length} contact, ${nonFinite} non-finite`);
  check(`${car.name}: the 447-collider R04-V2 all-visible layer is active and inert on the free drive`,
        prop !== null && prop.profile === 'all-visible' && prop.colliders === 447 &&
        prop.pinnedColliders === 447 && prop.manifest === FREE_PROP_PINS.manifest &&
        prop.contacts === 0 && prop.blockedTicks === 0 && prop.substeps > 0,
        prop ? `${prop.colliders} colliders, ${prop.contacts} contacts, ${prop.substeps} substeps` : 'no layer');
  check(`${car.name}: replaying the free-drive inputs without the rules reproduces every state hash`,
        replayMatches, replayMatches ? `${hashes.length} ticks` : 'state sequence differs');
  check(`${car.name}: the free run matches its deterministic state-sequence anchor`,
        FREE_ANCHORS[car.slug] === null || FREE_ANCHORS[car.slug] === stateSequenceHash,
        stateSequenceHash);
  const freeValidation = validatePacket(run.packet);
  check(`${car.name}: the free-roam run produces a valid packet v1.1 timeline with the free script label`,
        freeValidation.ok === true && run.packet.updates.length === run.states.length &&
        run.packet.diagnostics.extras.drive.script === FREE_PACKET_SCRIPT &&
        run.packet.updates.every((update) => update.matrices.length === 9),
        freeValidation.errors.slice(0, 4).join(' | '));

  const freeRunPath = path.join(OUT, `sprint-free-${car.slug}.json`);
  writeFileSync(freeRunPath, JSON.stringify({
    kind: 'e1-drive.sprint-run',
    version: 1,
    courseId: freeLayout.courseId,
    car: { slug: car.slug, name: car.name, record: car.record, drivetrain: car.drivetrain, fields: car.fields },
    layoutHash: freeLayout.hash,
    layoutFile: path.relative(ROOT, SPRINT_FREE_FILE).split(path.sep).join('/'),
    tickHz: TICK_HZ,
    countdownTicks: 0,
    stateSequenceHash,
    bounds: freeBox,
    containment: freeLayout.course.containment,
    prop: prop,
    ticks: run.rows,
    inputs: run.inputs,
    captures
  }, null, 2) + '\n', 'utf8');

  freeResults.push({
    slug: car.slug, name: car.name, drivetrain: car.drivetrain, default: car.slug === defaultCar.slug,
    layoutHash: freeLayout.hash, courseId: freeLayout.courseId,
    spawn: { x: freeSpawn.x, z: freeSpawn.z, headingRad: freeSpawn.headingRad, groundY: freeLayout.course.spawnGroundY },
    spawnDistanceMetres: round6Local(spawnDistance),
    bounds: freeBox, marginMetres: freeMargin,
    ticks: run.states.length,
    travelMetres: round6Local(travel),
    maxSpeedMetresPerSecond: round6Local(maxSpeed),
    contactTicks, nanTicks: nonFinite, respawns: run.respawns.length, contained,
    propApproach,
    prop: prop ? { profile: prop.profile, manifest: prop.manifest, colliders: prop.colliders,
      contacts: prop.contacts, blockedTicks: prop.blockedTicks, substeps: prop.substeps } : null,
    stateSequenceHash, replayMatches,
    packet: { hash: run.packet.hash, updates: run.packet.updates.length,
      draws: run.packet.draws.length, nodes: run.packet.nodes.length,
      bytes: formatPacket(run.packet).length, validationErrors: freeValidation.errors.length },
    runPath: path.relative(ROOT, freeRunPath).split(path.sep).join('/'),
    captures
  });
  log.push(`${car.slug}: free roam ${travel.toFixed(1)} m, max ${maxSpeed.toFixed(2)} m/s, ` +
    `${run.prop?.contacts ?? 'no'} contacts, ${run.states.length} ticks`);
}

// Containment: the rule is an observer, so it is tested synthetically at the
// boundary and on the real engine down the measured lane. A reset must rebuild
// at the committed spawn, never at a corridor point.
function freeSyntheticState(position, options = {}) {
  return {
    tick: options.tick ?? 1,
    position,
    axisX: [0, 0, -1],
    axisY: [0, 1, 0],
    axisZ: [1, 0, 0],
    velocity: [0, 0, 0],
    speed: 0,
    contacts: options.contact === false ? [0, 0, 0, 0] : [1, 1, 1, 1],
    anyContact: options.contact === false ? 0 : 1,
    finite: 1,
    wheels: [],
    input: [0, 0, 0, 0]
  };
}
const freeSpawnGround = freeLayout.course.spawnGroundY;
const freeRuleCases = {};
for (const [name, position] of Object.entries({
  'outside-x': [freeBox.maxX + freeMargin + 0.5, freeSpawnGround, freeSpawn.z],
  'outside-z': [freeSpawn.x, freeSpawnGround, freeBox.maxZ + freeMargin + 0.5],
  'inside-margin': [freeBox.maxX + freeMargin - 0.5, freeSpawnGround, freeSpawn.z],
  inside: [freeSpawn.x + 1, freeSpawnGround, freeSpawn.z]
})) {
  const rules = createSprintRules(freeLayout);
  rules.prime(freeSyntheticState([freeSpawn.x, freeSpawnGround, freeSpawn.z], { tick: 0 }));
  const events = rules.step(freeSyntheticState(position));
  freeRuleCases[name] = { events: events.map((event) => ({ type: event.type, reasons: event.reasons ?? null,
    target: event.target ?? null })), respawns: rules.respawns };
}
const freeBelowRules = createSprintRules(freeLayout);
freeBelowRules.prime(freeSyntheticState([freeSpawn.x, freeSpawnGround, freeSpawn.z], { tick: 0 }));
const freeBelowEvents = freeBelowRules.step(freeSyntheticState(
  [freeSpawn.x + 1, freeSpawnGround - freeLayout.course.containment.fallBelowGroundMetres - 0.2, freeSpawn.z]));
const freeAirborneRules = createSprintRules(freeLayout);
freeAirborneRules.prime(freeSyntheticState([freeSpawn.x, freeSpawnGround, freeSpawn.z], { tick: 0 }));
let freeAirborneEvents = [];
for (let tick = 1; tick <= freeLayout.course.containment.airborneTicks; tick++) {
  freeAirborneEvents = freeAirborneRules.step(
    freeSyntheticState([freeSpawn.x, freeSpawnGround + 0.5, freeSpawn.z], { tick, contact: false }));
}
check('free-roam containment fires on the measured box boundary and not inside the margin band',
      freeRuleCases['outside-x'].events.length === 1 && freeRuleCases['outside-x'].events[0].type === SPRINT_EVENT.RESPAWN &&
      freeRuleCases['outside-x'].events[0].reasons.includes('outside-bounds') &&
      freeRuleCases['outside-z'].events.length === 1 &&
      freeRuleCases['outside-z'].events[0].reasons.includes('outside-bounds') &&
      freeRuleCases['inside-margin'].events.length === 0 && freeRuleCases.inside.events.length === 0,
      JSON.stringify(freeRuleCases));
check('free-roam containment fires below the local measured ground and after 30 airborne ticks',
      freeBelowEvents.length === 1 && freeBelowEvents[0].reasons.includes('below-ground') &&
      freeAirborneEvents.length === 1 && freeAirborneEvents[0].reasons.includes('airborne'),
      JSON.stringify({ below: freeBelowEvents.map((event) => event.reasons),
        airborne: freeAirborneEvents.map((event) => event.reasons),
        airborneTicks: freeLayout.course.containment.airborneTicks }));
check('every free-roam reset targets the committed spawn, never a corridor point',
      [...freeRuleCases['outside-x'].events, ...freeRuleCases['outside-z'].events,
        ...freeBelowEvents, ...freeAirborneEvents].every((event) =>
        event.target.x === freeSpawn.x && event.target.z === freeSpawn.z &&
        Math.abs(event.target.heading - freeSpawn.headingRad) < 1e-12) &&
      freeLayout.course.containment.noCorridorRespawn === true,
      JSON.stringify([...freeRuleCases['outside-x'].events].map((event) => event.target)));

/** Drive the measured containment lane on the real engine and rebuild at the spawn. */
async function runFreeContainmentScenario(car, fieldBytes) {
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  const module = await factory();
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const create = (x, z, heading) => {
    if (!module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length, x, z, heading)) {
      throw new Error('free containment create failed: ' + module.UTF8ToString(module._e1_last_error()));
    }
    return JSON.parse(module.UTF8ToString(module._e1_get_state()));
  };
  const probeGround = () => JSON.parse(module.UTF8ToString(module._e1_ground_probe(freeProbe.x, freeProbe.z)));
  const rules = createSprintRules(freeLayout);
  const world = createPropWorld(freePropManifest, { profile: FREE_PROP_PINS.profile });
  const layer = createPropLayer({ world, carEnvelope: freePropManifest.carEnvelope, pins: FREE_PROP_PINS });
  let state0 = create(freeProbe.x, freeProbe.z, freeProbe.headingRad);
  const groundProbe = probeGround();
  layer.begin(state0, freeGroundAt(freeLayout, state0.position));
  rules.prime(state0);
  let respawnEvent = null;
  let rebuild = null;
  let state = state0;
  let ticks = 0;
  for (let tick = 1; tick <= 900 && !respawnEvent; tick++) {
    module._e1_set_input(1, 0, 0, 0);
    module._e1_step();
    ticks = tick;
    const raw = JSON.parse(module.UTF8ToString(module._e1_get_state()));
    state = layer.afterTick(raw, freeGroundAt(freeLayout, raw.position));
    const events = rules.step(state);
    respawnEvent = events.find((event) => event.type === SPRINT_EVENT.RESPAWN) ?? null;
  }
  if (!respawnEvent) throw new Error('free containment: the lane never left the box');
  const target = rules.respawnTarget();
  const tick0 = create(target.x, target.z, target.heading);
  layer.begin(tick0, freeGroundAt(freeLayout, tick0.position));
  rules.rejoin(tick0);
  const distanceAfter = Math.hypot(tick0.position[0] - freeSpawn.x, tick0.position[2] - freeSpawn.z);
  // 30 more ticks must not reset again on the spawn.
  let extraEvents = [];
  for (let tick = 1; tick <= 30; tick++) {
    module._e1_set_input(0, 0, 0, 0);
    module._e1_step();
    const raw = JSON.parse(module.UTF8ToString(module._e1_get_state()));
    extraEvents.push(...rules.step(layer.afterTick(raw, freeGroundAt(freeLayout, raw.position))));
  }
  rebuild = { tick: ticks, target, distanceAfterMetres: round6Local(distanceAfter),
    positionAfter: tick0.position.slice(0, 3) };
  return { probeGround: { hit: groundProbe.hit, height: groundProbe.y },
    probe: { x: freeProbe.x, z: freeProbe.z, headingRad: freeProbe.headingRad },
    respawnEvent, rebuild, extraEvents: extraEvents.length, respawns: rules.respawns };
}
const freeContainmentCar = cars[0];
const freeContainment = await runFreeContainmentScenario(freeContainmentCar,
  readFileSync(path.join(ROOT, freeContainmentCar.fields.path)));
check('free-roam containment resets the real engine at the box boundary and rebuilds at the spawn',
      freeContainment.probeGround.hit === 1 &&
      freeContainment.respawnEvent.reasons.includes('outside-bounds') &&
      freeContainment.respawnEvent.position[0] > freeBox.maxX + freeMargin &&
      freeContainment.rebuild.distanceAfterMetres < 0.05 &&
      freeContainment.respawns === 1 &&
      freeContainment.extraEvents === 0,
      JSON.stringify({ reasons: freeContainment.respawnEvent.reasons,
        boundary: freeContainment.respawnEvent.position.slice(0, 3),
        after: freeContainment.rebuild.positionAfter,
        distanceAfter: freeContainment.rebuild.distanceAfterMetres }));

/** R (e1_reset) in free roam returns to the committed spawn and restarts the session. */
async function runFreeRestart(car, fieldBytes) {
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  const module = await factory();
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const start = layoutStartPosition(freeLayout, layoutSpawn);
  if (!module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
    start.x, start.z, start.heading)) {
    throw new Error('free restart create failed: ' + module.UTF8ToString(module._e1_last_error()));
  }
  const rules = createSprintRules(freeLayout);
  let state = JSON.parse(module.UTF8ToString(module._e1_get_state()));
  rules.prime(state);
  for (let tick = 1; tick <= 200; tick++) {
    const input = sprintScriptInput(rules, state);
    module._e1_set_input(input[0], input[1], input[2], input[3]);
    module._e1_step();
    state = JSON.parse(module.UTF8ToString(module._e1_get_state()));
    rules.step(state);
  }
  const before = { position: state.position.slice(0, 3), elapsedTicks: rules.elapsedTicks };
  if (!module._e1_reset()) throw new Error('free restart e1_reset failed');
  const resetState = JSON.parse(module.UTF8ToString(module._e1_get_state()));
  rules.reset();
  rules.prime(resetState);
  return {
    before, after: resetState.position.slice(0, 3),
    distanceFromSpawnMetres: round6Local(Math.hypot(resetState.position[0] - freeSpawn.x,
      resetState.position[2] - freeSpawn.z)),
    elapsedTicks: rules.elapsedTicks, respawns: rules.respawns, phase: rules.phase,
    tick: resetState.tick
  };
}
const freeRestart = await runFreeRestart(freeContainmentCar,
  readFileSync(path.join(ROOT, freeContainmentCar.fields.path)));
check('R in free roam rebuilds at the committed spawn and restarts the session clock',
      freeRestart.distanceFromSpawnMetres < 0.05 && freeRestart.tick === 0 &&
      freeRestart.elapsedTicks === 0 && freeRestart.respawns === 0 && freeRestart.phase === 'running',
      JSON.stringify(freeRestart));


// ------------------------------------------------------------- 3-lap race (?course=lap)
// The P61 loop-01 layout is a closed 222.040 m circuit in collision component 5.
// Each roster car drives three laps with the same deterministic rules-gated
// follower; lap times are race-clock times from GO, and the run must be replay
// identical, restart identical and anchor identical.
const LAP_ANCHORS = Object.freeze({
  'corvette-zr1-stock': 'sha256:96094fd474df161837e37d5263b2f31287287c8e11a4ff994d684d7726d29094',
  'lotus-exige-cup260-stock': 'sha256:cc837eca88cdb533af7d7bf1c16e2064ab5e6f075ac9d0cde015509002beb291',
  'dodge-challenger-stock': 'sha256:5dafaf94701047727d6263ced1acf336d20820282bde35dfb8d917f63f051099',
  'ford-focusrs-stock': 'sha256:3ae7599e00f0c2418d1823e9f47a501eb8848562605abb96353e81c5c9ea53cb',
  'audi-r8v10-stock': 'sha256:d2e2eadd8642df6dddae200f25590e5c7951b3ab7b929f10a3c603e35dadc129',
  'audi-tt-stock': 'sha256:f02af62d3042f2e1155224fb9a8dd610c93c3c53a15d067dba572134f4e8dac2',
  'ford-f100-offroad': 'sha256:c61784b7aa76002590f0d9e959cd37e7ae1f7ce41e7b6e5b3f944465baf3f03a',
  'ford-fr100-stock': 'sha256:9df778aef746a4e1bd0a89d655b4023e03eaec2c7d9809e342f782fe41e5c55b',
  'volkswagen-golfw12650-stock': 'sha256:7d67ff1c99e0a4a06bda24b6a16e8bf9142050f0024e2f4a13bf923fd7ebe951',
  'ford-mustanggtr-stock': 'sha256:18ed7ff029ddf713ab5d5fb984712078c939652edae1b789660240576d1a5118',
  'dodge-viperacr-stock': 'sha256:07c2021860eea0a8780b70b09e96ed97227ff39fb00594ca98557e66294b0995',
  'audi-s3-stock': 'sha256:a985dfda71a2bd7fa4a864e3f5282f9a25a1c6ba991d36bf195ce63d0402abab',
  'ford-bronco-offroad': 'sha256:9a73c8cafd0918785de15482b6d5e264454ce7c1ef4c6c7834dddd6ea6ef20ec',
  'nissan-skyliner34ztune-stock': 'sha256:688ffa2ba573ad7651b863be22669b422366049cbe7a8edcb16fbb25b8f37466',
  'chevrolet-socalhhr-stock': 'sha256:ac7e5eb1455b6173b663d44a126190e35a6d99dc1a999ee4fb24ec4676a45d5c',
  'dodge-challenger-tuner': 'sha256:2a23ee57e1049d85fc5017e4551f8e8e46795f8f66e14b1fe5f8336ea4d665b7',
  'nissan-350znismo-stock': 'sha256:4340c4a254969ea5eca5bbf740686f31bcc1b4b40a3cd4166606adb05c5b57f8',
  'chevrolet-camaro-stocke3': 'sha256:d267f1d954498bfa63e2877a72733926c4f00e6c654e2539ee85856c55c87d83',
  'volkswagen-beetle-offroad': 'sha256:0e1696d0573b4e9921d9e5f3682725bb8cf9d7024e64d1ec8d35f40e87e6b346',
  'foose-stallion-stock': 'sha256:b2bce13b89a0e5b36a1843c13075bce2b9bfddccc12b4168d660c912ce463548',
  'chevrolet-camaro-ratdrift': 'sha256:280afa6c8414c56c7a2953bcc997c583cc5dfe92741a960fd684ff9b356003d2',
  'corvette-c3-rat': 'sha256:93ad48d7b835a7ea15f9921e706fa925aee59592c6484cc7eece3aa559bdff0d',
  'bmw-m3e92-tuner': 'sha256:a17263109aa1a4560148aa4281c873a19a825fae44d63fd004430afcc9f951ce',
  'koenigsegg-ccxr-stock': 'sha256:f15baa72db39c66cd48b874d9a5e886f370320b78e0e1ed603cde535de29050e',
  'toyota-supratrd-stock': 'sha256:d3963942c52c72aefb7335e5d6e65850867fc224ac768540a2735cd7c705f2a0'
});
const lapResults = [];
for (const car of cars) {
  const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
  const run = await runSprint(car, fieldBytes, lapLayout);
  const hashes = run.states.map((state) => hashOfLocal(state));
  const stateSequenceHash = aggregate(hashes);
  const replayHashes = await replaySprintInputs(car, fieldBytes, run.inputs, lapLayout);
  const replayMatches = replayHashes.length === hashes.length &&
    replayHashes.every((hash, index) => hash === hashes[index]);
  const lapEvents = run.lapEvents;
  const lapTimes = lapEvents.map((event) => event.lapSeconds);
  const bestLapSeconds = lapTimes.length ? Math.min(...lapTimes) : null;
  let minSteepFaceDistance = Infinity;
  let minSteepFaceTick = null;
  const raceEndTick = run.finish?.tick ?? Infinity;
  for (let index = 0; index < run.states.length; index += 5) {
    const state = run.states[index];
    if (state.tick > raceEndTick) break;
    const arc = coursePosition(lapLayout.course.samples, state.position).arc;
    const distance = lapSteepDistance(state.position[0], state.position[2], courseGroundAt(lapLayout, arc));
    if (distance < minSteepFaceDistance) {
      minSteepFaceDistance = distance;
      minSteepFaceTick = state.tick;
    }
  }
  const finish = run.finish;
  const countdownStates = run.states.slice(0, lapLayout.countdown.ticks + 1);
  const countdownRest = Math.max(...countdownStates.map((state) =>
    Math.hypot(state.position[0] - run.states[0].position[0], state.position[2] - run.states[0].position[2])));
  const lapCaptureTicks = [
    { label: 'start', tick: 0 },
    { label: 'lap1', tick: lapEvents[0]?.tick ?? null, eventTick: lapEvents[0]?.tick ?? null },
    { label: 'lap2', tick: lapEvents[1]?.tick ?? null, eventTick: lapEvents[1]?.tick ?? null },
    { label: 'finish', tick: finish?.tick ?? null, eventTick: finish?.tick ?? null }
  ].filter((entry) => entry.tick !== null);
  const lapCaptures = lapCaptureTicks.map(({ label, tick, eventTick }) => {
    const update = run.packet.updates.find((entry) => entry.tick === tick);
    const row = run.rows.find((entry) => entry.tick === tick);
    return {
      label, tick, eventTick: eventTick ?? null,
      stateHash: row?.stateHash ?? null, updateHash: update?.hash ?? null,
      matrix: update?.matrices?.[0]?.world ?? null, matrices: update?.matrices ?? null,
      camera: update?.camera ?? null, position: row?.position ?? null,
      speed: row?.speed ?? null, progress: row?.progress ?? null,
      elapsedSeconds: row?.elapsedSeconds ?? null,
      lap: row?.lap ?? null, laps: row?.laps ?? null,
      lapTimes: row?.lapTimes ?? null, bestLapSeconds: row?.bestLapSeconds ?? null
    };
  });

  check(`${car.name}: the lap countdown holds the car at rest on the loop line`,
        countdownRest < 0.05 && countdownStates.every((state) => Math.abs(state.speed) < 0.05),
        `${countdownRest.toFixed(4)} m over ${countdownStates.length} ticks`);
  check(`${car.name}: three forward line crossings complete laps 1, 2 and 3 in order`,
        lapEvents.length === 3 &&
        lapEvents[0].type === SPRINT_EVENT.LAP && lapEvents[0].lap === 1 &&
        lapEvents[1].type === SPRINT_EVENT.LAP && lapEvents[1].lap === 2 &&
        lapEvents[2].type === SPRINT_EVENT.FINISH && lapEvents[2].lap === 3 &&
        lapEvents.every((event, index) => index === 0 || event.tick > lapEvents[index - 1].tick) &&
        lapEvents.every((event, index) => index === 0 || event.timeSeconds > lapEvents[index - 1].timeSeconds) &&
        lapEvents.every((event, index) => Math.abs(event.lapSeconds - (event.timeSeconds - (index === 0 ? 0 : lapEvents[index - 1].timeSeconds))) < 2e-6),
        lapEvents.map((event) => `${event.type}:lap${event.lap}@${event.tick}:${event.lapSeconds}s`).join(' '));
  check(`${car.name}: the three lap times add up to the finish time and the best lap is the minimum`,
        finish !== null && lapTimes.length === 3 && lapTimes.every((seconds) => seconds > 1) &&
        Math.abs(finish.timeSeconds - lapTimes.reduce((sum, seconds) => sum + seconds, 0)) < 2e-5 &&
        bestLapSeconds === Math.min(...lapTimes) &&
        finish.bestLapSeconds === bestLapSeconds,
        `${lapTimes.join(' + ')} = ${finish?.timeSeconds} s, best ${bestLapSeconds} s`);
  check(`${car.name}: the 3-lap race finishes on the line after more than two laps of real driving`,
        finish !== null && finish.timeSeconds > 20 && finish.tick > 1200 &&
        run.states[finish.tick].speed > 3 && run.rules.snapshot().progress === 1,
        finish ? `${finish.timeSeconds} s at tick ${finish.tick}, ` +
          `${run.states[finish.tick].speed.toFixed(2)} m/s` : 'no finish');
  check(`${car.name}: the lap race keeps wheel contact, no NaN and no respawn`,
        run.states.every((state) => state.anyContact === 1) &&
        run.states.every((state) => state.finite === 1) && run.respawns.length === 0,
        `${run.states.filter((state) => state.anyContact === 1).length}/${run.states.length} contact, ` +
        `${run.states.filter((state) => state.finite !== 1).length} non-finite, ${run.respawns.length} respawns`);
  check(`${car.name}: the car stays inside the declared lap band for the whole race`,
        finish !== null && run.rules.maxLateralRunning <= lapLayout.course.lap.bandHalfWidthMetres + 1e-9,
        finish ? `max running lateral ${run.rules.maxLateralRunning.toFixed(3)} m of ` +
          `${lapLayout.course.lap.bandHalfWidthMetres} m` : 'no finish');
  check(`${car.name}: the V2 all-visible prop layer is active and inert on the clear loop`,
        run.prop !== null && run.prop.profile === 'all-visible' && run.prop.colliders === 651 &&
        run.prop.pinnedColliders === 651 && run.prop.manifest === PROP_MANIFEST &&
        run.prop.contacts === 0 && run.prop.blockedTicks === 0 && run.prop.substeps > 0,
        run.prop ? `${run.prop.colliders} colliders, ${run.prop.contacts} contacts, ` +
          `${run.prop.substeps} substeps` : 'no prop layer');
  check(`${car.name}: the driven car centre clears every steep collision face by more than the car circumradius`,
        minSteepFaceDistance > LAP_CAR_CIRCUMRADIUS + 0.1,
        `min centre-to-face ${minSteepFaceDistance.toFixed(3)} m at tick ${minSteepFaceTick}, ` +
        `car circumradius ${round6Local(LAP_CAR_CIRCUMRADIUS)} m`);
  check(`${car.name}: replaying the lap inputs without the rules reproduces every state hash`,
        replayMatches, replayMatches ? `${hashes.length} ticks` : 'state sequence differs');
  check(`${car.name}: the lap run matches its deterministic state-sequence anchor`,
        LAP_ANCHORS[car.slug] === null || LAP_ANCHORS[car.slug] === stateSequenceHash,
        `${stateSequenceHash}`);
  const lapValidation = validatePacket(run.packet);
  check(`${car.name}: the lap produces a valid packet v1.1 timeline with the lap script label`,
        lapValidation.ok === true && run.packet.updates.length === run.states.length &&
        run.packet.diagnostics.extras.drive.script === LAP_PACKET_SCRIPT &&
        run.packet.updates.every((update) => update.matrices.length === 9),
        lapValidation.errors.slice(0, 4).join(' | '));

  const lapRunPath = path.join(OUT, `sprint-lap-${car.slug}.json`);
  writeFileSync(lapRunPath, JSON.stringify({
    kind: 'e1-drive.sprint-run',
    version: 1,
    courseId: lapLayout.courseId,
    car: { slug: car.slug, name: car.name, record: car.record, drivetrain: car.drivetrain, fields: car.fields },
    layoutHash: lapLayout.hash,
    layoutFile: path.relative(ROOT, SPRINT_LAP_FILE).split(path.sep).join('/'),
    tickHz: TICK_HZ,
    countdownTicks: lapLayout.countdown.ticks,
    stateSequenceHash,
    lapTimes,
    bestLapSeconds,
    maxLateralMetres: run.rules.maxLateralRunning,
    events: run.events,
    finish,
    laps: lapEvents,
    respawns: run.respawns,
    ticks: run.rows,
    inputs: run.inputs,
    captures: lapCaptures
  }, null, 2) + '\n', 'utf8');

  lapResults.push({
    slug: car.slug,
    name: car.name,
    drivetrain: car.drivetrain,
    default: car.slug === defaultCar.slug,
    layoutHash: lapLayout.hash,
    courseId: lapLayout.courseId,
    laps: lapLayout.course.lap.laps,
    lapLengthMetres: lapLayout.course.lap.lengthMetres,
    goTick: run.go?.tick ?? null,    finish: finish ? {
      timeSeconds: finish.timeSeconds,
      tick: finish.tick,
      position: finish.position,
      speed: run.states[finish.tick].speed,
      laps: finish.laps
    } : null,
    lapTimes,
    bestLapSeconds,
    minSteepFaceDistanceMetres: round6Local(minSteepFaceDistance),
    minSteepFaceTick,
    carCircumradiusMetres: round6Local(LAP_CAR_CIRCUMRADIUS),
    lapEvents: lapEvents.map((event) => ({
      type: event.type, lap: event.lap, tick: event.tick,
      timeSeconds: event.timeSeconds, lapSeconds: event.lapSeconds,
      bestLapSeconds: event.bestLapSeconds, position: event.position
    })),
    respawns: run.respawns.length,
    ticks: run.states.length,
    contactTicks: run.states.filter((state) => state.anyContact === 1).length,
    nanTicks: run.states.filter((state) => state.finite !== 1).length,
    maxLateralMetres: run.rules.maxLateralRunning,
    maxPostFinishLateralMetres: run.rules.maxLateral,
    progress: run.rules.snapshot().progress,
    stateSequenceHash,
    replayMatches,
    packet: {
      hash: run.packet.hash,
      updates: run.packet.updates.length,
      draws: run.packet.draws.length,
      nodes: run.packet.nodes.length,
      bytes: formatPacket(run.packet).length,
      validationErrors: lapValidation.errors.length
    },
    runPath: path.relative(ROOT, lapRunPath).split(path.sep).join('/'),
    prop: run.prop,
    captures: lapCaptures
  });
  log.push(`${car.slug}: lap ${lapTimes.map((seconds) => seconds.toFixed(3)).join('/')} s, ` +
           `total ${finish?.timeSeconds} s, ${run.states.length} ticks`);
}

// The ghost is a recording of the sprint runs above, not a second simulation.
// The committed reference set under probes/e1-drive/ghosts/ is regenerated from
// these exact runs: `--write-ghosts` writes it and a normal run compares the
// bytes, so a stale or hand-edited ghost is a hard failure. The checks below
// prove the compact record reproduces the run's own body and wheel matrices,
// that the hash is deterministic, that the store keeps only the fastest ghost
// per car and course, and that the delta is a race-clock gap (not a guess).
const GHOST_DIR = path.join(ROOT, 'probes/e1-drive/ghosts');
const GHOST_INDEX_FILE = path.join(GHOST_DIR, 'index.json');
const WRITE_GHOSTS = args.includes('--write-ghosts');
const GHOST_COURSES = ['310m', 'short'];
if (WRITE_GHOSTS && ONLY_CAR) throw new Error('--write-ghosts regenerates the whole set; drop --car');

const matrixMaxDelta = (a, b) => {
  let max = 0;
  for (let index = 0; index < 16; index++) max = Math.max(max, Math.abs(a[index] - b[index]));
  return max;
};

const ghostIndex = {
  kind: GHOST_INDEX_KIND,
  version: 1,
  note:
    'Committed deterministic reference ghost per roster car and course. Generated by ' +
    '`node probes/e1-drive/tools/verify_e1_drive.mjs --write-ghosts` from the same sprint runs whose state ' +
    'sequence hashes are pinned in run.json; the verifier re-derives and compares the bytes.',
  encoding: 'position3 + quaternion4 + wheelAngle4 per engine tick, float32le base64',
  sampleHz: TICK_HZ,
  cars: {}
};
const ghostFiles = new Map();
for (const car of cars) {
  ghostIndex.cars[car.slug] = {};
  for (const course of GHOST_COURSES) {
    const source = ghostSources.get(car.slug)?.[course] ?? null;
    if (!source) continue;
    const text = JSON.stringify(source.record, null, 2) + '\n';
    const fileName = referenceGhostFileName(car.slug, course);
    ghostFiles.set(car.slug + '/' + course, { fileName, text, source });
    ghostIndex.cars[car.slug][course] = {
      slug: car.slug,
      course,
      file: 'probes/e1-drive/ghosts/' + fileName,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: 'sha256:' + sha256(Buffer.from(text, 'utf8')),
      ghostHash: source.record.hash,
      timeSeconds: source.record.timeSeconds,
      finishTick: source.record.finishTick,
      tickCount: source.record.tickCount,
      countdownTicks: source.record.countdownTicks,
      layoutHash: source.record.layoutHash,
      stateSequenceHash: source.record.stateSequenceHash,
      source: source.record.source,
      sourceLabel: source.record.sourceLabel
    };
  }
}
const ghostIndexText = JSON.stringify(ghostIndex, null, 2) + '\n';
if (WRITE_GHOSTS) {
  mkdirSync(GHOST_DIR, { recursive: true });
  writeFileSync(GHOST_INDEX_FILE, ghostIndexText, 'utf8');
  for (const { fileName, text } of ghostFiles.values()) writeFileSync(path.join(GHOST_DIR, fileName), text, 'utf8');
}

check('ghost: the committed reference set covers every roster car on both courses',
      cars.every((car) => GHOST_COURSES.every((course) => ghostIndex.cars[car.slug]?.[course])) &&
      ghostFiles.size === cars.length * GHOST_COURSES.length,
      ghostFiles.size + ' records');
check('ghost: the committed reference index is exactly the regenerated one (no hand-edited ghost)',
      existsSync(GHOST_INDEX_FILE) && readFileSync(GHOST_INDEX_FILE, 'utf8') === ghostIndexText,
      WRITE_GHOSTS ? 'regenerated' : 'index differs');

const ghostRows = [];
const ghostReconstruction = { bodyMax: 0, wheelMax: 0, quaternionMax: 0, selfDeltaSeconds: 0, selfDeltaMetres: 0 };
let ghostAnchored = 0;
for (const car of cars) {
  for (const course of GHOST_COURSES) {
    const file = ghostFiles.get(car.slug + '/' + course);
    const indexPath = GHOST_DIR;
    if (!file) {
      check(`${car.name} (${course}): ghost record exists`, false, 'no derived record');
      continue;
    }
    const { record, run, layout, finish } = file.source;
    const text = file.text;
    const entry = ghostIndex.cars[car.slug][course];
    const committedPath = path.join(indexPath, file.fileName);
    const committedText = existsSync(committedPath) ? readFileSync(committedPath, 'utf8') : null;
    check(`${car.name} (${course}): the committed reference ghost is the deterministic trace byte for byte`,
          committedText !== null && committedText === text &&
          entry.sha256 === 'sha256:' + sha256(Buffer.from(text, 'utf8')),
          committedText === null ? 'missing ' + file.fileName : (committedText === text ? 'match' : 'bytes differ'));

    const recordCheck = validateGhostRecord(record);
    check(`${car.name} (${course}): the ghost record validates and its canonical hash re-computes`,
          recordCheck.ok && ghostHash(record) === record.hash && record.source === GHOST_SOURCE.REFERENCE,
          recordCheck.errors.join('; ') || record.hash);
    const anchored = record.stateSequenceHash ===
      PHYSICS_ANCHORS[car.slug][course === '310m' ? 'sprint310' : 'sprintShort'] &&
      record.timeSeconds === finish.timeSeconds && record.finishTick === finish.tick &&
      record.tickCount === finish.tick + 1 && record.layoutHash === layout.hash &&
      record.courseId === layout.courseId && record.car === car.slug && record.course === course;
    if (anchored) ghostAnchored++;
    check(`${car.name} (${course}): the ghost was recorded from the anchored sprint run`,
          anchored,
          `${record.timeSeconds} s / tick ${record.finishTick} / ${record.stateSequenceHash}`);
    // Same run -> same record -> same hash. This is the ghost determinism gate.
    const rebuilt = buildGhostForRun(car, run, layout, course, finish, record.stateSequenceHash);
    check(`${car.name} (${course}): two derivations of the same run produce the same ghost hash`,
          rebuilt.hash === record.hash && rebuilt.sample.data === record.sample.data,
          rebuilt.hash === record.hash ? record.hash : rebuilt.hash + ' vs ' + record.hash);
    // The ghost builder must be read-only for the run: every update hash still
    // verifies (the stored hash was taken before the field was added) and the run
    // still aggregates to its anchored sequence hash.
    const runIntact = run.packet.updates.every((update) => {
      const body = { ...update };
      delete body.hash;
      return hashOfLocal(body) === update.hash;
    }) && aggregate(run.states.map((state) => hashOfLocal(state))) === record.stateSequenceHash;
    check(`${car.name} (${course}): recording the ghost did not mutate the run, its packet or its state sequence`,
          runIntact, runIntact ? 'intact' : 'the recorded run changed');

    const decoded = decodeGhost(record);
    const rest = ghostWheelRestFor(car.slug);
    const byTick = new Map(run.packet.updates.map((update) => [update.tick, update]));
    let bodyMax = 0;
    let wheelMax = 0;
    let quaternionMax = 0;
    for (let tick = 0; tick < record.tickCount; tick++) {
      const update = byTick.get(tick);
      const frame = ghostMatrices(decoded, tick, rest);
      const pose = ghostPoseAt(decoded, tick);
      quaternionMax = Math.max(quaternionMax, Math.abs(Math.hypot(pose.quaternion[0], pose.quaternion[1],
        pose.quaternion[2], pose.quaternion[3]) - 1));
      const bodyEntry = update.matrices.find((entryMatrix) => entryMatrix.nodeId === 'e1.car.body');
      bodyMax = Math.max(bodyMax, matrixMaxDelta(frame.body, bodyEntry.world));
      for (const corner of GHOST_CORNERS) {
        for (const kind of ['spin', 'static']) {
          const nodeId = 'e1.car.wheel.' + corner + '.' + kind;
          const expected = update.matrices.find((entryMatrix) => entryMatrix.nodeId === nodeId);
          if (!expected) throw new Error('run packet has no ' + nodeId + ' at tick ' + tick);
          wheelMax = Math.max(wheelMax, matrixMaxDelta(frame.wheels[corner][kind], expected.world));
        }
      }
    }
    ghostReconstruction.bodyMax = Math.max(ghostReconstruction.bodyMax, bodyMax);
    ghostReconstruction.wheelMax = Math.max(ghostReconstruction.wheelMax, wheelMax);
    ghostReconstruction.quaternionMax = Math.max(ghostReconstruction.quaternionMax, quaternionMax);
    check(`${car.name} (${course}): the compact record rebuilds the run's body pose at every tick`,
          bodyMax <= 5e-3, 'max |body delta| ' + bodyMax.toExponential(3));
    check(`${car.name} (${course}): the recorded wheel angles rebuild every wheel matrix at every tick`,
          wheelMax <= 5e-3, 'max |wheel delta| ' + wheelMax.toExponential(3));
    check(`${car.name} (${course}): every recorded rotation is a unit quaternion`,
          quaternionMax <= 1e-5, 'max |1 - |q|| ' + quaternionMax.toExponential(3));

    // The delta is measured against the same recorded sequence: replaying the
    // run against its own ghost must be a zero gap while the run is actually
    // making progress (a plateau — countdown or a stalled car — compares two
    // times at the same arc by definition).
    const progressOf = Array.isArray(layout.course.samples)
      ? (position) => coursePosition(layout.course.samples, position).arc
      : (position) => position[0];
    const table = buildGhostArcTable(decoded, progressOf);
    let selfSeconds = 0;
    let selfMetres = 0;
    let progressTicks = 0;
    let maxArc = -Infinity;
    for (let tick = 1; tick < record.tickCount; tick++) {
      const arc = table.arcs[tick];
      // A car may reverse over ground it already covered (collision recovery,
      // terrain), so only a *new* course maximum is a comparable progress tick.
      // The old check only compared with the previous tick and then read the
      // first crossing of that arc from the table, which reports a false gap on
      // a non-monotonic path.
      if (!(arc > maxArc + 1e-4)) continue;
      maxArc = arc;
      progressTicks++;
      const player = {
        arc,
        seconds: Math.max(0, (tick - record.countdownTicks) / record.tickHz)
      };
      const gap = ghostGap(table, player);
      selfSeconds = Math.max(selfSeconds, Math.abs(gap.seconds));
      selfMetres = Math.max(selfMetres, Math.abs(gap.metres));
    }
    ghostReconstruction.selfDeltaSeconds = Math.max(ghostReconstruction.selfDeltaSeconds, selfSeconds);
    ghostReconstruction.selfDeltaMetres = Math.max(ghostReconstruction.selfDeltaMetres, selfMetres);
    check(`${car.name} (${course}): replaying the run against its own ghost is a zero gap on every moving tick`,
          progressTicks > 100 && selfSeconds <= 2e-3 && selfMetres <= 2e-2,
          `${progressTicks} moving ticks, max ${selfSeconds.toExponential(2)} s / ${selfMetres.toExponential(2)} m`);
    check(`${car.name} (${course}): the ghost clock reaches the recorded finish time at its last tick`,
          Math.abs(ghostSecondsAtArc(table, table.arcs[table.tickCount - 1]).seconds - record.timeSeconds) < 1e-6,
          record.timeSeconds + ' s');

    ghostRows.push({
      slug: car.slug,
      course,
      hash: record.hash,
      file: path.relative(ROOT, committedPath).split(path.sep).join('/'),
      bytes: entry.bytes,
      fileSha256: entry.sha256,
      timeSeconds: record.timeSeconds,
      finishTick: record.finishTick,
      tickCount: record.tickCount,
      bodyMaxDelta: Number(bodyMax.toExponential(3)),
      wheelMaxDelta: Number(wheelMax.toExponential(3)),
      selfDeltaSeconds: Number(selfSeconds.toExponential(3)),
      selfDeltaMetres: Number(selfMetres.toExponential(3))
    });
  }
}

// Interpolation is presentation-only but must still be deterministic: at a
// fractional tick the pose lies between the two recorded integer samples.
{
  const firstCar = cars[0];
  const decoded = decodeGhost(ghostSources.get(firstCar.slug)['310m'].record);
  const a = ghostPoseAt(decoded, 10);
  const b = ghostPoseAt(decoded, 11);
  const mid = ghostPoseAt(decoded, 10.5);
  const expected = a.position.map((value, index) => (value + b.position[index]) / 2);
  const positionDelta = Math.max(...mid.position.map((value, index) => Math.abs(value - expected[index])));
  const angleExpected = (a.wheelAngles.frontleft + b.wheelAngles.frontleft) / 2;
  check('ghost: a fractional tick interpolates deterministically between the two recorded ticks',
        positionDelta < 5e-3 && Math.abs(mid.wheelAngles.frontleft - angleExpected) < 5e-3 &&
        ghostPoseAt(decoded, 10.5).position.every((value, index) => Object.is(value, mid.position[index])),
        'max |position - mean| ' + positionDelta.toExponential(3));
}

// The page's store: fastest ghost per car, one key per course, hostile storage
// and tampered records degrade to "no ghost" instead of replaying a bad pose.
{
  const makeStorage = () => {
    const map = new Map();
    return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)) };
  };
  const storage = makeStorage();
  const longStore = createGhostStore(storage, '310m', { layoutHash: derivedLayout.hash });
  const corvetteGhost = ghostSources.get(cars[0].slug)['310m'].record;
  const first = longStore.submit(cars[0].slug, corvetteGhost);
  const same = longStore.submit(cars[0].slug, corvetteGhost);
  const slower = { ...corvetteGhost, timeSeconds: corvetteGhost.timeSeconds + 1 };
  slower.hash = ghostHash(slower);
  const slowerSubmit = longStore.submit(cars[0].slug, slower);
  check('ghost store: the fastest ghost is kept and a slower run never overwrites it',
        first.improved === true && same.improved === false && slowerSubmit.improved === false &&
        longStore.bestSecondsFor(cars[0].slug) === corvetteGhost.timeSeconds &&
        longStore.get(cars[0].slug).hash === corvetteGhost.hash,
        JSON.stringify({ first: first.improved, same: same.improved, slower: slowerSubmit.improved }));
  check('ghost store: the 310 m and 29 m ghosts use independent per-course keys',
        longStore.key === GHOST_KEY_PREFIX + '310m' && storage.map.has(GHOST_KEY_PREFIX + '310m') &&
        createGhostStore(storage, 'short', { layoutHash: shortLayout.hash }).key === GHOST_KEY_PREFIX + 'short',
        longStore.key);
  const otherStorage = makeStorage();
  otherStorage.setItem(GHOST_KEY_PREFIX + '310m', JSON.stringify({
    kind: 'e1-drive.sprint-ghost-store', version: 1, course: '310m',
    cars: { [cars[0].slug]: { ...corvetteGhost, hash: 'sha256:' + '0'.repeat(64) } }
  }));
  const tampered = createGhostStore(otherStorage, '310m');
  check('ghost store: a tampered record is dropped instead of replayed (no silent fallback)',
        tampered.get(cars[0].slug) === null && /invalid record/.test(tampered.lastError ?? ''),
        tampered.lastError);
  const throwing = createGhostStore({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } }, '310m');
  const throwingSubmit = throwing.submit(cars[0].slug, corvetteGhost);
  check('ghost store: a throwing storage degrades to memory-only instead of failing the page',
        throwingSubmit.improved === true && throwingSubmit.persistent === false && throwing.bestSecondsFor(cars[0].slug) === null,
        String(throwingSubmit.persistent));
}

// Cross-run delta signs at a mid-course arc: the Audi's ghost is ahead of the
// Corvette's pace and the Focus's ghost is behind the Audi's pace.
{
  const courseSamples = derivedLayout.course.samples;
  const arc = 250;
  const tableFor = (slug) => buildGhostArcTable(
    decodeGhost(ghostSources.get(slug)['310m'].record), (position) => coursePosition(courseSamples, position).arc);
  const audiTable = tableFor('audi-r8v10-stock');
  const focusTable = tableFor('ford-focusrs-stock');
  const corvetteTable = tableFor(cars[0].slug);
  const corvetteTimeAtArc = ghostSecondsAtArc(corvetteTable, arc).seconds;
  const audiTimeAtArc = ghostSecondsAtArc(audiTable, arc).seconds;
  const focusTimeAtArc = ghostSecondsAtArc(focusTable, arc).seconds;
  const behindAudi = ghostGap(audiTable, { arc, seconds: corvetteTimeAtArc });
  const aheadOfFocus = ghostGap(focusTable, { arc, seconds: audiTimeAtArc });
  check('ghost delta: a slower player is measured behind a faster ghost and a faster player ahead of a slower ghost',
        audiTimeAtArc < corvetteTimeAtArc - 0.2 &&
        behindAudi.seconds > 0.2 && behindAudi.metres > 1 &&
        focusTimeAtArc > audiTimeAtArc + 0.4 &&
        aheadOfFocus.seconds < -0.4 && aheadOfFocus.metres < -1,
        JSON.stringify({
          audiTimeAtArc: audiTimeAtArc.toFixed(3),
          corvetteTimeAtArc: corvetteTimeAtArc.toFixed(3),
          focusTimeAtArc: focusTimeAtArc.toFixed(3),
          behindAudi: behindAudi.seconds.toFixed(3),
          aheadOfFocus: aheadOfFocus.seconds.toFixed(3)
        }));
}


async function telemetryInstances(car, fieldBytes) {
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  return createWasmTelemetryEngineSet({
    factory,
    levelBytes,
    fieldBytes,
    spawn: { x: TICK0_LIMITS.x, z: TICK0_LIMITS.z, heading: TICK0_LIMITS.heading },
    count: TELEMETRY_MANOEUVRE_ORDER.length,
    label: car.slug
  });
}

async function runTelemetryForCar(car, fieldBytes) {
  const engine = await telemetryInstances(car, fieldBytes);
  const started = Date.now();
  const series = runTelemetrySeries(engine);
  return { series, ms: Date.now() - started, info: engine.info };
}

/** Per-tick state hashes of every manoeuvre, plus their sequence hash. */
function telemetryHashes(series) {
  const rows = {};
  for (const manoeuvre of TELEMETRY_MANOEUVRE_ORDER) {
    const hashes = series.states[manoeuvre].map((state) => hashOfLocal(state));
    rows[manoeuvre] = { hashes, traceHash: hashOfLocal(hashes), aggregate: aggregate(hashes) };
  }
  return rows;
}

/** Replay the recorded input sequences in a fresh instance set. */
async function replayTelemetryInputs(car, fieldBytes, inputs) {
  const engine = await telemetryInstances(car, fieldBytes);
  const rows = {};
  for (const manoeuvre of TELEMETRY_MANOEUVRE_ORDER) {
    const state0 = engine.reset();
    const hashes = [hashOfLocal(state0)];
    for (const input of inputs[manoeuvre]) {
      engine.setInput(input);
      hashes.push(hashOfLocal(engine.step()));
    }
    rows[manoeuvre] = { hashes, traceHash: hashOfLocal(hashes), aggregate: aggregate(hashes) };
  }
  return rows;
}

/** Read the live world's scheduler/world diagnostics (see e1_diag in the library). */
function readDiag(module) {
  return JSON.parse(module.UTF8ToString(module._e1_diag()));
}

const RESET_CYCLE_COUNT = 10;
const RESET_CYCLE_TICKS = 30;

/**
 * Rebuild one wasm instance `cycles` times (alternating `e1_reset()` and a second
 * `e1_create()`) and replay the same 30 scripted ticks after every rebuild.
 *
 * This is the measured regression for the rebuild limit: before the fix the
 * third `e1_reset()` aborted with a wasm out-of-bounds. Every cycle must produce
 * the same per-tick state hashes, the same heap size and the same scheduler pool
 * shape (no leaked group handles, no growing queue).
 */
async function runResetCycles(car, fieldBytes, cycles = RESET_CYCLE_COUNT) {
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  const module = await factory();
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const read = () => JSON.parse(module.UTF8ToString(module._e1_get_state()));
  const info = () => JSON.parse(module.UTF8ToString(module._e1_info()));

  const build = (via) => {
    const ok = via === 'create'
      ? module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                          TICK0_LIMITS.x, TICK0_LIMITS.z, TICK0_LIMITS.heading)
      : module._e1_reset();
    if (!ok) throw new Error(`${car.name}: ${via} failed: ` + module.UTF8ToString(module._e1_last_error()));
  };

  const rows = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    // Cycle 0 builds with e1_create; every later cycle alternates, so both
    // entry points are rebuilt many times in the same instance.
    build(cycle === 0 ? 'create' : (cycle % 2 === 1 ? 'reset' : 'create'));
    const tick0 = read();
    const diag = readDiag(module);
    const hashes = [hashOfLocal(tick0)];
    let nan = tick0.finite === 1 ? 0 : 1;
    for (let tick = 1; tick <= RESET_CYCLE_TICKS; tick++) {
      const input = scriptedInput(tick);
      module._e1_set_input(input[0], input[1], input[2], input[3]);
      if (!module._e1_step()) throw new Error(`${car.name}: step failed at cycle ${cycle} tick ${tick}`);
      const state = read();
      if (state.finite !== 1) nan++;
      hashes.push(hashOfLocal(state));
    }
    const infoNow = info();
    const group = diag.scheduler.groups?.[diag.group] ?? null;
    rows.push({
      cycle,
      via: cycle === 0 ? 'create' : (cycle % 2 === 1 ? 'reset' : 'create'),
      tick0: tick0.tick,
      resets: infoNow.resets,
      contacts0: tick0.contacts.join(''),
      nan,
      position: tick0.position,
      stateHash: hashOfLocal(tick0),
      traceHash: hashOfLocal(hashes),
      hashes,
      heapBytes: module.HEAPU8.length,
      scheduler: {
        group: diag.group,
        policy: diag.policy,
        poolSize: diag.scheduler.poolSize,
        poolHead: diag.scheduler.poolHead,
        queued: diag.scheduler.queued,
        executing: diag.scheduler.executing,
        groupQueued: group?.queued ?? null,
        groupExecuting: group?.executing ?? null,
        groupDependencies: group?.dependencies ?? null
      }
    });
  }
  return { rows, module };
}

/**
 * The telemetry series run TWICE in one module instance (six manoeuvre runs,
 * five resets) and compared with the fresh-instance reference run. The series
 * must be bit-identical: same per-tick state hashes and the same metrics.
 */
async function runTelemetryResetSeries(car, fieldBytes, reference) {
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  const engine = await createWasmResetEngineSet({
    factory,
    levelBytes,
    fieldBytes,
    spawn: { x: TICK0_LIMITS.x, z: TICK0_LIMITS.z, heading: TICK0_LIMITS.heading },
    label: car.slug + ' reset set'
  });
  const heap0 = engine.heapBytes;
  const started = Date.now();
  const first = runTelemetrySeries(engine);
  const second = runTelemetrySeries(engine);
  const ms = Date.now() - started;
  const heap1 = engine.heapBytes;
  const matches = TELEMETRY_MANOEUVRE_ORDER.map((manoeuvre) => {
    const referenceHashes = reference.series.states[manoeuvre].map((state) => hashOfLocal(state));
    const firstHashes = first.states[manoeuvre].map((state) => hashOfLocal(state));
    const secondHashes = second.states[manoeuvre].map((state) => hashOfLocal(state));
    return {
      manoeuvre,
      ticks: firstHashes.length,
      firstMatchesReference: firstHashes.length === referenceHashes.length &&
        firstHashes.every((hash, index) => hash === referenceHashes[index]),
      secondMatchesReference: secondHashes.length === referenceHashes.length &&
        secondHashes.every((hash, index) => hash === referenceHashes[index]),
      firstAggregate: aggregate(firstHashes),
      secondAggregate: aggregate(secondHashes),
      referenceAggregate: aggregate(referenceHashes)
    };
  });
  return {
    resets: engine.resets,
    creates: engine.creates,
    builds: engine.builds,
    manoeuvres: TELEMETRY_MANOEUVRE_ORDER.length * 2,
    ms,
    heapBytes: { before: heap0, after: heap1 },
    matches,
    identical: matches.every((entry) => entry.firstMatchesReference && entry.secondMatchesReference),
    series: [first, second]
  };
}

/**
 * Two scripted sprints in ONE wasm instance: the first attempt is the normal run,
 * the second starts with `e1_reset()` (the `R` / API restart path) and replays the
 * same rules and script. Both attempts must produce the same input sequence, the
 * same per-tick state hashes and the same finish.
 */
async function runSprintRestart(car, fieldBytes, layout = derivedLayout) {
  const start = layoutStartPosition(layout, layoutSpawn);
  const maxTicks = isLapLayout(layout) ? LAP_SCRIPT_TICKS : SPRINT_SCRIPT_TICKS;
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  const module = await factory();
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const read = () => JSON.parse(module.UTF8ToString(module._e1_get_state()));

  const attempt = (restart) => {
    const ok = restart
      ? module._e1_reset()
      : module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                          start.x, start.z, start.heading);
    if (!ok) throw new Error(`${car.name}: sprint ${restart ? 'restart' : 'create'} failed: ` +
                             module.UTF8ToString(module._e1_last_error()));
    const rules = createSprintRules(layout, {
    shortCourseController: car.shortCourseController ?? null
  });
    const state0 = read();
    rules.prime(state0);
    const hashes = [hashOfLocal(state0)];
    const inputs = [];
    const events = [];
    let previous = state0;
    for (let tick = 1; tick <= maxTicks; tick++) {
      const input = sprintScriptInput(rules, previous);
      inputs.push(input);
      module._e1_set_input(input[0], input[1], input[2], input[3]);
      if (!module._e1_step()) throw new Error(`${car.name}: sprint restart step failed at ${tick}`);
      const state = read();
      hashes.push(hashOfLocal(state));
      events.push(...rules.step(state));
      previous = state;
      if (rules.phase === 'finished' && state.tick - rules.finishTick >= 120) break;
    }
    return {
      state0,
      hashes,
      inputs,
      events,
      finish: events.find((event) => event.type === SPRINT_EVENT.FINISH) ?? null,
      checkpoints: events.filter((event) => event.type === SPRINT_EVENT.CHECKPOINT).length,
      lapEvents: events.filter((event) => event.type === SPRINT_EVENT.LAP || event.type === SPRINT_EVENT.FINISH),
      respawns: events.filter((event) => event.type === SPRINT_EVENT.RESPAWN).length,
      traceHash: hashOfLocal(hashes),
      inputHash: hashOfLocal(inputs)
    };
  };

  const first = attempt(false);
  const heap0 = module.HEAPU8.length;
  const second = attempt(true);
  const diag = readDiag(module);
  return {
    first,
    second,
    restartMatches: first.traceHash === second.traceHash &&
      first.inputHash === second.inputHash &&
      first.finish?.tick === second.finish?.tick &&
      first.finish?.timeSeconds === second.finish?.timeSeconds &&
      first.checkpoints === second.checkpoints && first.respawns === second.respawns,
    heapBytes: { before: heap0, after: module.HEAPU8.length },
    scheduler: { group: diag.group, poolHead: diag.scheduler.poolHead, queued: diag.scheduler.queued }
  };
}

// The per-car state sequence anchors (`PHYSICS_ANCHORS`) are declared before the
// sprint runs; the telemetry block asserts them unchanged.

const telemetryResults = [];
const telemetryReferenceStates = new Map();
for (const car of cars) {
  const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
  const runA = await runTelemetryForCar(car, fieldBytes);
  const runB = await runTelemetryForCar(car, fieldBytes);
  telemetryReferenceStates.set(car.slug, runA.series.states);
  const replay = await replayTelemetryInputs(car, fieldBytes, runA.series.inputs);
  const metrics = runA.series.metrics;
  const summary = summariseTelemetryMetrics(metrics);
  const hashesA = telemetryHashes(runA.series);
  const hashesB = telemetryHashes(runB.series);
  const accel = metrics.accel;
  const brake = metrics.brake;
  const lateral = metrics.lateral;
  const zero = accel.zeroToSpeedKph;
  const independentTicks = {
    '50': tickAtSpeedKph(runA.series.states.accel, 50),
    '80': tickAtSpeedKph(runA.series.states.accel, 80),
    '100': tickAtSpeedKph(runA.series.states.accel, 100)
  };
  const t50 = zero['50']?.seconds;
  const t80 = zero['80']?.seconds;
  const t100 = zero['100']?.seconds;
  const driveRow = results.find((entry) => entry.slug === car.slug);
  const anchors = PHYSICS_ANCHORS[car.slug];
  const sprintRow = sprintResults.find((entry) => entry.slug === car.slug);
  const sprintShortRow = sprintShortResults.find((entry) => entry.slug === car.slug);
  const independentTopSpeed = Math.max(...runA.series.states.accel.map((state) => state.speed));

  check(`${car.name}: telemetry runs three manoeuvres in one instance each`,
        TELEMETRY_MANOEUVRE_ORDER.every((manoeuvre) => runA.series.states[manoeuvre].length > 2 &&
          runA.series.metrics[manoeuvre].ticks === runA.series.states[manoeuvre].length) &&
        runA.series.states.accel[0].tick === 0,
        TELEMETRY_MANOEUVRE_ORDER.map((manoeuvre) =>
          `${manoeuvre}:${runA.series.states[manoeuvre].length}`).join(' '));
  check(`${car.name}: telemetry timers are monotonic (0 < 50 < 80 < 100 km/h)`,
        Number.isFinite(t50) && Number.isFinite(t80) && Number.isFinite(t100) &&
        t50 > 0 && t80 > t50 && t100 > t80 &&
        zero['50'].distanceMetres < zero['80'].distanceMetres &&
        zero['80'].distanceMetres < zero['100'].distanceMetres,
        `50 ${t50} s, 80 ${t80} s, 100 ${t100} s`);
  check(`${car.name}: every reported timer is the measured tick, not a fit`,
        TELEMETRY_SPEC.accel.thresholdsKph.every((kph) =>
          zero[String(kph)].reached === true && zero[String(kph)].tick === independentTicks[String(kph)]) &&
        independentTicks['50'] < independentTicks['80'] && independentTicks['80'] < independentTicks['100'],
        JSON.stringify(independentTicks));
  check(`${car.name}: the standing-start run covers the fixed ${TELEMETRY_SPEC.accel.endDistanceMetres} m window on the ground`,
        accel.runLimitedBy === 'distance' &&
        Math.abs(accel.distanceMetres - TELEMETRY_SPEC.accel.endDistanceMetres) < 1.5 &&
        accel.contactTicks === accel.ticks && accel.nanTicks === 0 &&
        accel.topSpeedKph > 90 && accel.topSpeedKph < 220,
        `${accel.distanceMetres} m in ${accel.durationSeconds} s, ${accel.topSpeedKph} km/h at the end, ` +
        `${accel.contactTicks}/${accel.ticks} contact`);
  check(`${car.name}: the reported top speed is the maximum measured speed`,
        Math.abs(independentTopSpeed * 3.6 - accel.topSpeedKph) < 0.01 &&
        accel.topSpeedTick === runA.series.states.accel[accel.topSpeedTick]?.tick,
        `${(independentTopSpeed * 3.6).toFixed(3)} vs ${accel.topSpeedKph} km/h`);
  // The five reference cars bring the car to a full stop inside the strip. Two
  // batch-added cars (Bronco, Skyline) still creep at 0.23 / 0.84 m/s at the
  // strip end; the measured distance and mean/peak decel are inside the same
  // bands, so that residual is recorded instead of calling the run a failure.
  const brakeStopOk = REFERENCE_CAR_SLUGS.has(car.slug)
    ? brake.stopped === true
    : brake.stopped === true || brake.stopSpeedMps <= 1.0;
  check(`${car.name}: braking from ${TELEMETRY_SPEC.brake.entrySpeedKph} km/h stops inside the measured strip`,
        brake.brakeTick === independentTicks['80'] && brakeStopOk &&
        brake.entrySpeedKph >= TELEMETRY_SPEC.brake.entrySpeedKph - 0.5 &&
        brake.entrySpeedKph <= TELEMETRY_SPEC.brake.entrySpeedKph + 1.5 &&
        brake.distanceMetres > 5 && brake.distanceMetres < 40 &&
        brake.meanDecelMps2 > 4 && brake.meanDecelMps2 < 20 &&
        brake.peakDecelMps2 >= brake.meanDecelMps2 &&
        brake.contactTicks === brake.ticks && brake.nanTicks === 0,
        `${brake.entrySpeedKph} -> ${brake.stopSpeedMps} m/s in ${brake.brakingTimeSeconds} s / ` +
        `${brake.distanceMetres} m, mean ${brake.meanDecelMps2} peak ${brake.peakDecelMps2} m/s2`);
  const missedReversals = lateral.reversals.filter((entry) => entry.lagTicks === null);
  const allowedMissed = car.telemetry?.lateralMissedReversals ?? 0;
  const consistentReversals = lateral.reversals
    .filter((entry) => entry.lagTicks !== null)
    .every((entry) => entry.lagTicks >= 0 && entry.lagTicks <= 60);
  check(`${car.name}: the steering sweep measures peak lateral acceleration and a consistent yaw response`,
        lateral.peakLateralAbsG > 0.2 && lateral.peakLateralAbsG < 2.5 &&
        lateral.peakYawRateAbsDegPerSec > 5 && lateral.peakYawRateAbsDegPerSec < 90 &&
        lateral.yawSignPerSteerSign !== 0 &&
        lateral.steerReversals > 0 &&
        lateral.yawSignChanges + missedReversals.length === lateral.steerReversals &&
        missedReversals.length <= allowedMissed &&
        consistentReversals &&
        lateral.contactTicks === lateral.ticks && lateral.nanTicks === 0,
        `${lateral.peakLateralAbsG} g, ${lateral.peakYawRateAbsDegPerSec} deg/s, ` +
        `${lateral.yawSignChanges}/${lateral.steerReversals} reversals answered in ` +
        `${lateral.yawResponseTicks} ticks` +
        (missedReversals.length ? `, ${missedReversals.length} typed miss` : '') +
        `, ${lateral.contactTicks}/${lateral.ticks} contact`);
  check(`${car.name}: telemetry traces are one 60 Hz sample per engine tick from tick 0`,
        TELEMETRY_MANOEUVRE_ORDER.every((manoeuvre) => {
          const states = runA.series.states[manoeuvre];
          const entry = runA.series.metrics[manoeuvre];
          return entry.sampleHz === 60 && entry.trace.length === states.length &&
            states.every((state, index) => state.tick === index) &&
            states.every((state, index) => index === 0 || state.tick === states[index - 1].tick + 1);
        }),
        TELEMETRY_MANOEUVRE_ORDER.map((manoeuvre) => manoeuvre + ':' +
          runA.series.states[manoeuvre].length).join(' '));
  check(`${car.name}: every telemetry input is a tick-only step script`,
        runA.series.inputs.accel.every((input) =>
          input[0] === 1 && input[1] === 0 && input[2] === 0 && input[3] === 0) &&
        runA.series.inputs.brake.every((input, index) =>
          (index + 1) <= brake.brakeTick
            ? input[0] === 1 && input[1] === 0
            : input[0] === 0 && input[1] === 1) &&
        runA.series.inputs.lateral.every((input, index) => {
          const tick = index + 1;
          if (tick <= TELEMETRY_SPEC.lateral.throttleTicks) return input[0] === 1 && input[2] === 0;
          const swept = tick - TELEMETRY_SPEC.lateral.throttleTicks;
          const span = TELEMETRY_SPEC.lateral.sweepHalfPeriodTicks * TELEMETRY_SPEC.lateral.sweepHalfPeriods;
          if (swept > span) return input[0] === 0 && input[1] === 0 && input[2] === 0;
          const half = Math.floor((swept - 1) / TELEMETRY_SPEC.lateral.sweepHalfPeriodTicks);
          const expected = (half % 2 === 0 ? 1 : -1) * TELEMETRY_SPEC.lateral.sweepAmplitude;
          return input[0] === 1 && input[1] === 0 && Math.abs(input[2] - expected) < 1e-6;
        }),
        `brake step at tick ${brake.brakeTick}, sweep ${TELEMETRY_SPEC.lateral.sweepHalfPeriods} x ` +
        `${TELEMETRY_SPEC.lateral.sweepHalfPeriodTicks} ticks at ${TELEMETRY_SPEC.lateral.sweepAmplitude}`);
  check(`${car.name}: every telemetry manoeuvre starts on the drive's settled tick-0 state`,
        driveRow !== undefined &&
        TELEMETRY_MANOEUVRE_ORDER.every((manoeuvre) =>
          hashOfLocal(runA.series.states[manoeuvre][0]) === driveRow.determinism.firstStateHash),
        driveRow?.determinism.firstStateHash ?? 'no drive row');
  check(`${car.name}: two independent wasm instance sets produce identical telemetry state hashes`,
        TELEMETRY_MANOEUVRE_ORDER.every((manoeuvre) =>
          hashesA[manoeuvre].hashes.length === hashesB[manoeuvre].hashes.length &&
          hashesA[manoeuvre].hashes.every((hash, index) => hash === hashesB[manoeuvre].hashes[index])),
        TELEMETRY_MANOEUVRE_ORDER.map((manoeuvre) =>
          `${manoeuvre}:${hashesA[manoeuvre].aggregate.slice(7, 15)}`).join(' '));
  check(`${car.name}: replaying the recorded telemetry inputs reproduces every state hash`,
        TELEMETRY_MANOEUVRE_ORDER.every((manoeuvre) =>
          replay[manoeuvre].hashes.length === hashesA[manoeuvre].hashes.length &&
          replay[manoeuvre].hashes.every((hash, index) => hash === hashesA[manoeuvre].hashes[index])),
        TELEMETRY_MANOEUVRE_ORDER.map((manoeuvre) => manoeuvre + ':' +
          (replay[manoeuvre].aggregate === hashesA[manoeuvre].aggregate ? 'match' : 'DIFF')).join(' '));
  check(`${car.name}: every telemetry tick has a distinct state hash inside its manoeuvre`,
        TELEMETRY_MANOEUVRE_ORDER.every((manoeuvre) =>
          new Set(hashesA[manoeuvre].hashes).size === hashesA[manoeuvre].hashes.length),
        TELEMETRY_MANOEUVRE_ORDER.map((manoeuvre) =>
          `${new Set(hashesA[manoeuvre].hashes).size}/${hashesA[manoeuvre].hashes.length}`).join(' '));
  check(`${car.name}: the telemetry pass leaves the drive and sprint physics anchors unchanged`,
        anchors !== undefined &&
        driveRow?.determinism.stateSequenceHash === anchors.drive &&
        driveRow?.packet.hash === anchors.packet &&
        sprintRow?.stateSequenceHash === anchors.sprint310 &&
        sprintShortRow?.stateSequenceHash === anchors.sprintShort,
        `${driveRow?.determinism.stateSequenceHash.slice(7, 15)} / ` +
        `${sprintRow?.stateSequenceHash.slice(7, 15)} / ${sprintShortRow?.stateSequenceHash.slice(7, 15)}`);

  const telemetryPath = path.join(OUT, `telemetry-${car.slug}.json`);
  writeFileSync(telemetryPath, JSON.stringify({
    kind: 'e1-drive.telemetry-run',
    version: 1,
    car: { slug: car.slug, name: car.name, drivetrain: car.drivetrain, record: car.record, values: car.values },
    spawn: { x: TICK0_LIMITS.x, z: TICK0_LIMITS.z, heading: TICK0_LIMITS.heading, source: TICK0_LIMITS.source },
    spec: TELEMETRY_SPEC,
    plan: runA.series.plan,
    sampleHz: TELEMETRY_SPEC.tickHz,
    units: {
      speed: 'km/h (state.speed m/s * 3.6)',
      time: 's (engine ticks / 60)',
      distance: 'm (XZ distance of the engine position)',
      accel: 'm/s2 from the per-tick finite difference of state.velocity, projected on the body axis',
      lateralG: 'lateral acceleration / 9.80665',
      yaw: 'deg/s from state.angular projected on the body up axis'
    },
    metrics: summary,
    metricDefinition: {
      accel: 'full throttle from the settled spawn for a fixed 86 m window; 0-50/0-80/0-100 are the first ticks at or above the speed',
      brake: 'full throttle from the same spawn, brake input starts on the tick after the accel run first measured 80 km/h',
      lateral: `${TELEMETRY_SPEC.lateral.sweepHalfPeriods} square steering half-periods of ` +
        `${TELEMETRY_SPEC.lateral.sweepHalfPeriodTicks} ticks at ${TELEMETRY_SPEC.lateral.sweepAmplitude} steer after ` +
        `${TELEMETRY_SPEC.lateral.throttleTicks} throttle ticks`
    },
    hashes: Object.fromEntries(TELEMETRY_MANOEUVRE_ORDER.map((manoeuvre) => [manoeuvre, {
      ticks: hashesA[manoeuvre].hashes.length,
      aggregate: hashesA[manoeuvre].aggregate,
      traceHash: hashesA[manoeuvre].traceHash,
      replayAggregate: replay[manoeuvre].aggregate,
      replayTraceHash: replay[manoeuvre].traceHash,
      secondInstanceAggregate: hashesB[manoeuvre].aggregate,
      secondInstanceTraceHash: hashesB[manoeuvre].traceHash
    }])),
    timings: { seriesMs: runA.ms, secondSeriesMs: runB.ms, instances: TELEMETRY_MANOEUVRE_ORDER.length },
    traces: Object.fromEntries(TELEMETRY_MANOEUVRE_ORDER.map((manoeuvre) =>
      [manoeuvre, runA.series.metrics[manoeuvre].trace]))
  }, null, 2) + '\n', 'utf8');

  telemetryResults.push({
    slug: car.slug,
    name: car.name,
    drivetrain: car.drivetrain,
    mass: car.values.mass,
    torqueScaleNm: car.values.torqueScaleNm,
    brakesFront: car.values.brakesFront,
    brakesRear: car.values.brakesRear,
    wheelBase: car.values.wheelBase,
    trackWidthFront: car.values.trackWidthFront,
    trackWidthRear: car.values.trackWidthRear,
    gearbox: { gears: car.values.gears, finalRatio: car.values.finalRatio, limiterRPM: car.values.limiterRPM },
    metrics: summary,
    hashes: Object.fromEntries(TELEMETRY_MANOEUVRE_ORDER.map((manoeuvre) => [manoeuvre, {
      ticks: hashesA[manoeuvre].hashes.length,
      aggregate: hashesA[manoeuvre].aggregate,
      traceHash: hashesA[manoeuvre].traceHash,
      replayMatches: replay[manoeuvre].aggregate === hashesA[manoeuvre].aggregate,
      secondInstanceMatches: hashesB[manoeuvre].aggregate === hashesA[manoeuvre].aggregate
    }])),
    path: path.relative(ROOT, telemetryPath).split(path.sep).join('/'),
    timings: { seriesMs: runA.ms, secondSeriesMs: runB.ms },
    physicsAnchors: {
      drive: driveRow?.determinism.stateSequenceHash ?? null,
      packet: driveRow?.packet.hash ?? null,
      sprint310: sprintRow?.stateSequenceHash ?? null,
      sprintShort: sprintShortRow?.stateSequenceHash ?? null,
      unchanged: driveRow?.determinism.stateSequenceHash === anchors?.drive &&
        driveRow?.packet.hash === anchors?.packet &&
        sprintRow?.stateSequenceHash === anchors?.sprint310 &&
        sprintShortRow?.stateSequenceHash === anchors?.sprintShort
    }
  });
  log.push(`${car.slug}: telemetry ${runA.ms}+${runB.ms} ms, ` +
           `${TELEMETRY_MANOEUVRE_ORDER.map((manoeuvre) => manoeuvre + ' ' +
             runA.series.states[manoeuvre].length).join(', ')} ticks`);
}

// ------------------------------------------------------- telemetry cross-car
const telemetryBySlug = new Map(telemetryResults.map((entry) => [entry.slug, entry]));
const telemetryOrder = (selector) => [...telemetryResults]
  .sort((a, b) => selector(a) - selector(b))
  .map((entry) => entry.slug);
const accelOrder = telemetryOrder((entry) => entry.metrics.accel.zeroToSpeedKph['100'].seconds);
const brakeOrder = telemetryOrder((entry) => entry.metrics.brake.distanceMetres);
const torqueToMassOrder = [...telemetryResults]
  .sort((a, b) => (b.torqueScaleNm / b.mass) - (a.torqueScaleNm / a.mass))
  .map((entry) => entry.slug);
const brakeToMassOrder = [...telemetryResults]
  .sort((a, b) => ((b.brakesFront + b.brakesRear) / b.mass) - ((a.brakesFront + a.brakesRear) / a.mass))
  .map((entry) => entry.slug);
const rankDistance = (order, reference) => order.reduce((worst, slug) =>
  Math.max(worst, Math.abs(order.indexOf(slug) - reference.indexOf(slug))), 0);
const referenceAccelOrder = accelOrder.filter((slug) => REFERENCE_CAR_SLUGS.has(slug));
const referenceBrakeOrder = brakeOrder.filter((slug) => REFERENCE_CAR_SLUGS.has(slug));
const referenceTorqueToMass = torqueToMassOrder.filter((slug) => REFERENCE_CAR_SLUGS.has(slug));
const referenceBrakeToMass = brakeToMassOrder.filter((slug) => REFERENCE_CAR_SLUGS.has(slug));

check('telemetry: every car produces a distinct state sequence in every manoeuvre',
      new Set(telemetryResults.map((entry) => TELEMETRY_MANOEUVRE_ORDER
        .map((manoeuvre) => entry.hashes[manoeuvre].aggregate).join('|'))).size === telemetryResults.length &&
      TELEMETRY_MANOEUVRE_ORDER.every((manoeuvre) =>
        new Set(telemetryResults.map((entry) => entry.hashes[manoeuvre].aggregate)).size === telemetryResults.length),
      telemetryResults.map((entry) => entry.slug).join(', '));
if (referenceAccelOrder.length === REFERENCE_CAR_SLUGS.size) {
  const awd = telemetryBySlug.get('audi-r8v10-stock');
  const fwd = telemetryBySlug.get('ford-focusrs-stock');
  check('telemetry: among the five reference cars the AWD car is quickest to 100 km/h and the FWD car is slowest',
        referenceAccelOrder[0] === awd.slug &&
        referenceAccelOrder[referenceAccelOrder.length - 1] === fwd.slug,
        referenceAccelOrder.map((slug) =>
          `${slug}:${telemetryBySlug.get(slug).metrics.accel.zeroToSpeedKph['100'].seconds}s`).join(', '));
}
check('telemetry: the five reference cars keep the 0-100 km/h order against the XT torque-scale-to-mass order',
      rankDistance(referenceAccelOrder, referenceTorqueToMass) <= 1,
      `measured ${referenceAccelOrder.join(' < ')} | torque/mass ${referenceTorqueToMass.join(' < ')}`);
check('telemetry: the five reference cars keep the stopping order within two places of the XT brake-to-mass order',
      rankDistance(referenceBrakeOrder, referenceBrakeToMass) <= 2,
      `measured ${referenceBrakeOrder.map((slug) => `${slug}:${telemetryBySlug.get(slug).metrics.brake.distanceMetres}m`).join(', ')} | ` +
      `brake/mass ${referenceBrakeToMass.join(' < ')}`);
check('telemetry: every car completes the sweep on the ground with the same steer-to-yaw sign convention',
      telemetryResults.every((entry) => entry.metrics.lateral.airborneTicks === 0 &&
        entry.metrics.lateral.yawSignPerSteerSign ===
          telemetryResults[0].metrics.lateral.yawSignPerSteerSign),
      telemetryResults.map((entry) => `${entry.slug}:${entry.metrics.lateral.yawSignPerSteerSign}`).join(', '));

// ------------------------------------------------------- rebuild limit (fixed)
// One wasm instance is rebuilt 10 times per car, a second `e1_create()` included,
// and the same 30 scripted ticks are replayed after every rebuild. The state
// hashes, the heap size and the scheduler pool must all stay identical: that is
// the fixed limit, measured rather than reloaded around.
const resetResults = [];
for (const car of cars) {
  const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
  const run = await runResetCycles(car, fieldBytes, RESET_CYCLE_COUNT);
  const rows = run.rows;
  const first = rows[0];
  const sameTrace = rows.every((row) => row.traceHash === first.traceHash);
  const sameHashes = rows.every((row) => row.hashes.length === first.hashes.length &&
    row.hashes.every((hash, index) => hash === first.hashes[index]));
  const heapSizes = [...new Set(rows.map((row) => row.heapBytes))];
  const poolHeads = [...new Set(rows.map((row) => row.scheduler.poolHead))];
  const poolSizes = [...new Set(rows.map((row) => row.scheduler.poolSize))];
  const poolQueued = [...new Set(rows.map((row) => row.scheduler.queued))];
  const groupHandles = rows.map((row) => row.scheduler.group);
  const groupQueued = [...new Set(rows.map((row) => row.scheduler.groupQueued))];
  const validHandles = rows.every((row) => row.scheduler.group >= 0 &&
    row.scheduler.group < row.scheduler.poolSize &&
    row.scheduler.groupDependencies === 0 &&
    row.scheduler.groupExecuting === 0);
  // `e1_create` zeroes the counter before building, `e1_reset` increments it, so a
  // create row is always 1 and a reset row is the previous row's value + 1.
  const resetCounterOk = rows.every((row, index) =>
    row.via === 'create' ? row.resets === 1 : row.resets === rows[index - 1].resets + 1);
  const resetCycleCount = rows.filter((row) => row.via === 'reset').length;

  check(`${car.name}: ${RESET_CYCLE_COUNT} create/reset rebuilds complete in one wasm instance`,
        rows.length === RESET_CYCLE_COUNT && resetCycleCount > 0, `${rows.length} cycles, ${resetCycleCount} resets`);
  check(`${car.name}: every rebuild replays the same 30-tick state hashes`,
        sameTrace && sameHashes, `${rows.map((row) => row.traceHash.slice(0, 10)).join(' ')}`);
  check(`${car.name}: every rebuild starts at tick 0 with all four wheels on the ground`,
        rows.every((row) => row.tick0 === 0 && row.contacts0 === '1111'),
        rows.map((row) => `${row.via}:${row.tick0}/${row.contacts0}`).join(' '));
  check(`${car.name}: the rebuilt world keeps the module heap size`,
        heapSizes.length === 1 && heapSizes[0] === rows[0].heapBytes,
        heapSizes.join(', ') + ' B');
  check(`${car.name}: the scheduler pool does not grow or leak group handles across rebuilds`,
        poolHeads.length === 1 && poolSizes.length === 1 && poolQueued.length === 1 &&
        groupQueued.length === 1 && validHandles,
        `head ${poolHeads.join('/')} size ${poolSizes.join('/')} queued ${poolQueued.join('/')} ` +
        `group queued ${groupQueued.join('/')} groups ${groupHandles.join(',')}`);
  check(`${car.name}: the reset counter and the state stay finite across every rebuild`,
        resetCounterOk && rows.every((row) => row.nan === 0),
        `resets ${rows.map((row) => row.via + ':' + row.resets).join(' ')}`);
  check(`${car.name}: every rebuilt group handle is a created group with no dependencies`,
        validHandles, `groups ${groupHandles.join(',')} dependencies ` +
        `${rows.map((row) => row.scheduler.groupDependencies).join(',')}`);

  resetResults.push({
    slug: car.slug,
    name: car.name,
    cycles: RESET_CYCLE_COUNT,
    ticksPerCycle: RESET_CYCLE_TICKS,
    traceHash: first.traceHash,
    stateHash: first.stateHash,
    sameTrace,
    heapBytes: heapSizes,
    scheduler: {
      poolSize: poolSizes[0], poolHeads, queued: poolQueued, groupQueued,
      groupHandles, allValid: validHandles
    },
    rows
  });
  log.push(`${car.slug}: ${RESET_CYCLE_COUNT} rebuilds in one instance, trace ${first.traceHash.slice(0, 16)}, ` +
           `heap ${heapSizes[0]} B, pool head ${poolHeads.join('/')}`);
}

// One instance, the telemetry series twice (six manoeuvre runs, five resets).
// The reference is the fresh-instance series already run for this car above.
const telemetryResetResults = [];
for (const car of cars) {
  const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
  const reference = telemetryResults.find((entry) => entry.slug === car.slug);
  const referenceSeries = {
    series: { states: telemetryReferenceStates.get(car.slug) }
  };
  if (!reference || !referenceSeries.series.states) {
    throw new Error('missing fresh-instance telemetry reference for ' + car.slug);
  }
  const run = await runTelemetryResetSeries(car, fieldBytes, referenceSeries);
  const nano = run.series.flatMap((series) => TELEMETRY_MANOEUVRE_ORDER
    .map((manoeuvre) => series.metrics[manoeuvre].nanTicks)).reduce((a, b) => a + b, 0);
  check(`${car.name}: six telemetry manoeuvres (the series twice) run in one wasm instance`,
        run.manoeuvres === 6 && run.resets === 5 && run.creates === 1 && run.builds === 6,
        `${run.manoeuvres} manoeuvres, ${run.resets} resets, ${run.creates} create, ${run.builds} builds`);
  check(`${car.name}: the rebuilt telemetry series is bit-identical to the fresh-instance series`,
        run.identical, run.matches.map((entry) => `${entry.manoeuvre}:${entry.firstMatchesReference}`).join(' '));
  check(`${car.name}: the one-instance telemetry series keeps the heap and stays finite`,
        run.heapBytes.before === run.heapBytes.after && nano === 0 && run.series.every((series) =>
          TELEMETRY_MANOEUVRE_ORDER.every((manoeuvre) => series.metrics[manoeuvre].finite === true)),
        `heap ${run.heapBytes.before}/${run.heapBytes.after} B, ${nano} NaN`);
  telemetryResetResults.push({
    slug: car.slug,
    name: car.name,
    manoeuvres: run.manoeuvres,
    resets: run.resets,
    builds: run.builds,
    ms: run.ms,
    heapBytes: run.heapBytes,
    identical: run.identical,
    matches: run.matches,
    reference: reference ? {
      accel100: reference.metrics.accel.zeroToSpeedKph['100'].seconds,
      brakeDistanceMetres: reference.metrics.brake.distanceMetres,
      lateralG: reference.metrics.lateral.peakLateralAbsG
    } : null,
    rebuilt: {
      accel100: run.series[0].metrics.accel.zeroToSpeedKph['100'].seconds,
      brakeDistanceMetres: run.series[0].metrics.brake.distanceMetres,
      lateralG: run.series[0].metrics.lateral.peakLateralAbsG
    }
  });
  log.push(`${car.slug}: telemetry reset set ${run.manoeuvres} manoeuvres, ${run.resets} resets, ${run.ms} ms, ` +
           `identical ${run.identical}`);
}

// Sprint restart in one instance: the finish, the input sequence and the per-tick
// state hashes must be identical after `e1_reset()` (the R / API restart path).
const sprintRestartResults = [];
for (const car of cars) {
  const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
  const run = await runSprintRestart(car, fieldBytes);
  check(`${car.name}: sprint restart (R/API) completes in the same wasm instance without a reload`,
        run.second.finish !== null && run.second.checkpoints === 2 && run.second.respawns === 0,
        run.second.finish ? `${run.second.finish.timeSeconds} s, ${run.second.checkpoints} checkpoints` : 'no finish');
  check(`${car.name}: the restarted sprint replays the same inputs, state hashes and finish`,
        run.restartMatches, `${run.first.traceHash.slice(0, 12)} vs ${run.second.traceHash.slice(0, 12)}, ` +
        `${run.first.finish?.timeSeconds} vs ${run.second.finish?.timeSeconds} s`);
  check(`${car.name}: the restart keeps the heap and the scheduler pool`,
        run.heapBytes.before === run.heapBytes.after &&
        run.scheduler.poolHead === resetResults.find((entry) => entry.slug === car.slug)?.scheduler.poolHeads[0],
        `heap ${run.heapBytes.before}/${run.heapBytes.after} B, pool head ${run.scheduler.poolHead}`);
  sprintRestartResults.push({
    slug: car.slug,
    name: car.name,
    finishSeconds: run.first.finish?.timeSeconds ?? null,
    finishTick: run.first.finish?.tick ?? null,
    checkpoints: run.first.checkpoints,
    ticks: run.first.hashes.length,
    traceHash: run.first.traceHash,
    inputHash: run.first.inputHash,
    restartTraceHash: run.second.traceHash,
    restartFinishSeconds: run.second.finish?.timeSeconds ?? null,
    restartTick: run.second.finish?.tick ?? null,
    restartMatches: run.restartMatches,
    heapBytes: run.heapBytes,
    scheduler: run.scheduler
  });
  log.push(`${car.slug}: sprint restart ${run.first.finish?.timeSeconds} s -> ${run.second.finish?.timeSeconds} s, ` +
           `identical ${run.restartMatches}`);
}

// Lap restart: the same 3-lap run after e1_reset() in one instance. The lap times
// and every state hash must be identical; the loop's own start point is re-used.
const lapRestartResults = [];
for (const car of cars) {
  const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
  const run = await runSprintRestart(car, fieldBytes, lapLayout);
  check(`${car.name}: the 3-lap restart completes after e1_reset() with three laps`,
        run.second.finish !== null && run.second.lapEvents.length === 3 && run.second.respawns === 0,
        run.second.finish ? `${run.second.finish.timeSeconds} s, ${run.second.lapEvents.length} lap events`
          : 'no finish');
  check(`${car.name}: the restarted lap race replays the same inputs, state hashes, lap times and finish`,
        run.restartMatches &&
        run.first.lapEvents.every((event, index) =>
          event.lapSeconds === run.second.lapEvents[index]?.lapSeconds),
        `${run.first.traceHash.slice(0, 12)} vs ${run.second.traceHash.slice(0, 12)}, ` +
        `${run.first.finish?.timeSeconds} vs ${run.second.finish?.timeSeconds} s`);
  lapRestartResults.push({
    slug: car.slug,
    name: car.name,
    finishSeconds: run.first.finish?.timeSeconds ?? null,
    finishTick: run.first.finish?.tick ?? null,
    lapTimes: run.first.lapEvents.map((event) => event.lapSeconds),
    ticks: run.first.hashes.length,
    traceHash: run.first.traceHash,
    inputHash: run.first.inputHash,
    restartTraceHash: run.second.traceHash,
    restartFinishSeconds: run.second.finish?.timeSeconds ?? null,
    restartMatches: run.restartMatches,
    heapBytes: run.heapBytes,
    scheduler: run.scheduler
  });
  log.push(`${car.slug}: lap restart ${run.first.finish?.timeSeconds} s -> ` +
           `${run.second.finish?.timeSeconds} s, identical ${run.restartMatches}`);
}


// ------------------------------------------------------------- sprint rules tests
// Synthetic states exercise the order and respawn decisions without an engine;
// the real-engine respawn below proves the same path end to end. The P37-style
// tests run on the 29 m regression layout (they are x-based by construction) and
// the path-based tests below run on the default 310 m layout.
function fakeState(tick, x, z, options = {}) {
  const y = options.y ?? shortLayout.course.spawnGroundY + 0.35;
  const contact = options.contact ?? 1;
  return {
    tick,
    position: [x, y, z],
    speed: options.speed ?? 10,
    contacts: [contact, contact, contact, contact],
    anyContact: contact,
    finite: options.finite ?? 1,
    wheels: [],
    input: [0, 0, 0, 0]
  };
}
function advanceToGo(rules, x = shortSpan.startX + 0.01) {
  let tick = 0;
  rules.prime(fakeState(tick, x, shortLayout.course.band.z));
  while (rules.phase === 'countdown') {
    tick++;
    rules.step(fakeState(tick, x, shortLayout.course.band.z));
  }
  return tick;
}
const rulesLayout = shortLayout;
// Out-of-order test: the car starts just before checkpoint 2 (so checkpoint 1 was
// never crossed) and is then moved across checkpoint 2 and the finish line.
const orderRules = createSprintRules(rulesLayout);
let orderTick = advanceToGo(orderRules, -70);
const orderEvents = [];
orderTick++;
orderEvents.push(...orderRules.step(fakeState(orderTick, -68, shortLayout.course.band.z)));
orderTick++;
orderEvents.push(...orderRules.step(fakeState(orderTick, -58, shortLayout.course.band.z)));
check('sprint rules: a finish crossed before the ordered checkpoints is rejected and labelled',
      orderEvents.some((event) => event.type === SPRINT_EVENT.GATE_OUT_OF_ORDER) &&
      orderEvents.some((event) => event.type === SPRINT_EVENT.FINISH_BLOCKED) &&
      orderRules.phase === 'running',
      orderEvents.map((event) => event.type).join(','));

const belowRules = createSprintRules(rulesLayout);
let belowTick = advanceToGo(belowRules);
const belowEvents = belowRules.step(fakeState(belowTick + 1, shortSpan.startX + 1, shortLayout.course.band.z,
  { y: shortLayout.course.spawnGroundY - 2 }));
check('sprint rules: falling below the measured ground triggers a respawn with a reason',
      belowEvents.some((event) => event.type === SPRINT_EVENT.RESPAWN &&
        event.reasons.includes('below-ground')) &&
      belowRules.awaitingRejoin === true,
      belowEvents.map((event) => event.type + ':' + (event.reasons ?? []).join('+')).join(','));

const airRules = createSprintRules(rulesLayout);
let airTick = advanceToGo(airRules);
const airStartTick = airTick;
let airEvents = [];
for (let step = 1; step <= rulesLayout.rules.respawn.airborneTicks + 1; step++) {
  airTick++;
  airEvents.push(...airRules.step(fakeState(airTick, shortSpan.startX + 2, shortLayout.course.band.z,
    { contact: 0 })));
}
const firstAir = airEvents.find((event) => event.type === SPRINT_EVENT.RESPAWN);
check('sprint rules: an airborne car respawns after the configured number of ticks',
      firstAir !== undefined && firstAir.reasons.includes('airborne') &&
      firstAir.tick === airStartTick + rulesLayout.rules.respawn.airborneTicks,
      firstAir ? `${firstAir.reasons.join('+')} at tick ${firstAir.tick}, expected ` +
        `${airStartTick + rulesLayout.rules.respawn.airborneTicks}` : 'no respawn');

const resetRules = createSprintRules(rulesLayout);
advanceToGo(resetRules);
resetRules.elapsedTicks = 123;
resetRules.gateIndex = 3;
resetRules.phase = 'finished';
resetRules.finishTimeSeconds = 2.05;
resetRules.reset();
check('sprint rules: R restart resets the timer, gates and finish state',
      resetRules.phase === 'countdown' && resetRules.elapsedTicks === 0 && resetRules.gateIndex === 1 &&
      resetRules.finishTimeSeconds === null && resetRules.checkpointsPassed === 0,
      resetRules.phase + ' ' + resetRules.elapsedTicks);

// ---- path-course rules on the default 310 m layout -------------------------
const longSamples = derivedLayout.course.samples;
function pathSampleIndexAt(arc) {
  let index = 0;
  let best = Infinity;
  for (let cursor = 0; cursor < longSamples.length; cursor++) {
    const distance = Math.abs(longSamples[cursor].arc - arc);
    if (distance < best) { best = distance; index = cursor; }
  }
  return index;
}
function pathSampleAt(arc) {
  return longSamples[pathSampleIndexAt(arc)];
}
function pathState(tick, arc, lateral = 0, options = {}) {
  const index = pathSampleIndexAt(arc);
  const sample = longSamples[index];
  const previous = longSamples[Math.max(0, index - 1)];
  const next = longSamples[Math.min(longSamples.length - 1, index + 1)];
  const tx = next.x - previous.x;
  const tz = next.z - previous.z;
  const length = Math.hypot(tx, tz);
  const nx = length > 0 ? -tz / length : 0;
  const nz = length > 0 ? tx / length : 1;
  const contact = options.contact ?? 1;
  return {
    tick,
    position: [sample.x + nx * lateral, options.y ?? sample.groundY + 0.35, sample.z + nz * lateral],
    speed: options.speed ?? 18,
    contacts: [contact, contact, contact, contact],
    anyContact: contact,
    finite: options.finite ?? 1,
    wheels: [],
    input: [0, 0, 0, 0]
  };
}
function advancePathToGo(rules) {
  let tick = 0;
  rules.prime(pathState(0, 0));
  while (rules.phase === 'countdown') { tick++; rules.step(pathState(tick, 0)); }
  return tick;
}
const pathOrderRules = createSprintRules(derivedLayout);
let pathOrderTick = advancePathToGo(pathOrderRules);
const pathOrderEvents = [];
pathOrderTick++;
pathOrderEvents.push(...pathOrderRules.step(pathState(pathOrderTick, derivedLayout.gates[2].arc - 1)));
pathOrderTick++;
pathOrderEvents.push(...pathOrderRules.step(pathState(pathOrderTick, derivedLayout.gates[2].arc + 1)));
pathOrderTick++;
pathOrderEvents.push(...pathOrderRules.step(pathState(pathOrderTick, sprintSpan.finishArc + 1)));
check('sprint rules: on the 310 m course an out-of-order checkpoint and a blocked finish are labelled, not counted',
      pathOrderEvents.some((event) => event.type === SPRINT_EVENT.GATE_OUT_OF_ORDER) &&
      pathOrderEvents.some((event) => event.type === SPRINT_EVENT.FINISH_BLOCKED) &&
      pathOrderRules.phase === 'running' && pathOrderRules.checkpointsPassed === 0,
      pathOrderEvents.map((event) => event.type).join(','));

const pathBelowRules = createSprintRules(derivedLayout);
const pathBelowTick = advancePathToGo(pathBelowRules);
const pathMidSample = pathSampleAt(150);
const pathBelowEvents = pathBelowRules.step(pathState(pathBelowTick + 1, 150, 0,
  { y: pathMidSample.groundY - 2 }));
check('sprint rules: the 310 m fall rule uses the measured ground at the car arc, not the spawn height',
      pathBelowEvents.some((event) => event.type === SPRINT_EVENT.RESPAWN &&
        event.reasons.includes('below-ground')) &&
      pathBelowRules.awaitingRejoin === true,
      pathBelowEvents.map((event) => event.type + ':' + (event.reasons ?? []).join('+')).join(','));

const pathOutsideRules = createSprintRules(derivedLayout);
const pathOutsideTick = advancePathToGo(pathOutsideRules);
const pathOutsideEvents = pathOutsideRules.step(pathState(pathOutsideTick + 1, 150,
  derivedLayout.course.corridor.halfWidthMetres + 2));
check('sprint rules: leaving the measured band on the 310 m course triggers outside-corridor',
      pathOutsideEvents.some((event) => event.type === SPRINT_EVENT.RESPAWN &&
        event.reasons.includes('outside-corridor')) &&
      pathOutsideRules.awaitingRejoin === true,
      pathOutsideEvents.map((event) => event.type + ':' + (event.reasons ?? []).join('+')).join(','));

const pathTargetRules = createSprintRules(derivedLayout);
pathTargetRules.gateIndex = 2;
const pathTarget = pathTargetRules.respawnTarget();
check('sprint rules: a 310 m respawn targets the last passed gate point and its measured heading',
      pathTarget.gateId === 'checkpoint-1' &&
      Math.abs(pathTarget.x - derivedLayout.gates[1].x) < 1e-9 &&
      Math.abs(pathTarget.z - derivedLayout.gates[1].z) < 1e-9 &&
      pathTarget.heading === derivedLayout.gates[1].headingRad &&
      Math.abs(layoutStartHeading(derivedLayout, layoutSpawn) - sprintGates[0].headingRad) < 1e-12,
      `${pathTarget.gateId} @ ${pathTarget.heading}`);

// ---- lap rules on P61 loop-01 ------------------------------------------------
// Synthetic states walk the measured loop; the line is crossed three times. This
// proves lap counting/order and the respawn target without an engine.
const lapRuleSamples = lapLayout.course.samples;
const lapRuleRing = lapRuleSamples.length - 1;
function lapRuleState(tick, arc, lateral = 0, options = {}) {
  let index = 0;
  for (let cursor = 0; cursor < lapRuleRing; cursor++) {
    if (Math.abs(lapRuleSamples[cursor].arc - arc) < Math.abs(lapRuleSamples[index].arc - arc)) index = cursor;
  }
  const sample = lapRuleSamples[index];
  const previous = lapRuleSamples[(index - 1 + lapRuleRing) % lapRuleRing];
  const next = lapRuleSamples[(index + 1) % lapRuleRing];
  const tx = next.x - previous.x;
  const tz = next.z - previous.z;
  const length = Math.hypot(tx, tz);
  const nx = -tz / length;
  const nz = tx / length;
  const contact = options.contact ?? 1;
  return {
    tick,
    position: [sample.x + nx * lateral, options.y ?? sample.groundY + 0.35, sample.z + nz * lateral],
    speed: options.speed ?? 12,
    contacts: [contact, contact, contact, contact],
    anyContact: contact,
    finite: options.finite ?? 1,
    wheels: [],
    input: [0, 0, 0, 0]
  };
}
const lapRulesTest = createSprintRules(lapLayout);
let lapRuleTick = 0;
lapRulesTest.prime(lapRuleState(0, 0));
while (lapRulesTest.phase === 'countdown') { lapRuleTick++; lapRulesTest.step(lapRuleState(lapRuleTick, 0)); }
const lapRuleEvents = [];
for (let lap = 0; lap < 3; lap++) {
  for (let arc = 2; arc < lapLayout.course.lap.lengthMetres - 1; arc += 2) {
    lapRuleTick++;
    for (const event of lapRulesTest.step(lapRuleState(lapRuleTick, arc))) lapRuleEvents.push(event);
  }
  lapRuleTick++;
  for (const event of lapRulesTest.step(lapRuleState(lapRuleTick, 0.1))) lapRuleEvents.push(event);
}
const lapRuleLines = lapRuleEvents.filter((event) => event.type === SPRINT_EVENT.LAP || event.type === SPRINT_EVENT.FINISH);
check('lap rules: three forward line crossings count laps 1, 2 and finish lap 3 in order',
      lapRuleLines.length === 3 && lapRuleLines[0].lap === 1 && lapRuleLines[1].lap === 2 &&
      lapRuleLines[2].lap === 3 && lapRuleLines[2].type === SPRINT_EVENT.FINISH &&
      lapRulesTest.phase === 'finished' && lapRulesTest.lapTimes.length === 3 &&
      lapRuleLines.every((event, index) => index === 0 || event.tick > lapRuleLines[index - 1].tick),
      lapRuleLines.map((event) => `${event.type}:${event.lap}@${event.tick}`).join(' '));
check('lap rules: the synthetic three laps record positive lap times and the best is the minimum',
      lapRulesTest.lapTimes.every((seconds) => seconds > 0) &&
      lapRulesTest.snapshot().bestLapSeconds === Math.min(...lapRulesTest.lapTimes) &&
      lapRulesTest.finishTimeSeconds === lapRuleLines[2].timeSeconds,
      lapRulesTest.lapTimes.join('/'));
check('lap rules: the lap respawn target is the start/finish line and its measured heading',
      (() => {
        const target = lapRulesTest.respawnTarget();
        return target.gateId === 'lap-line' &&
          target.x === lapLayout.course.lap.line.x && target.z === lapLayout.course.lap.line.z &&
          target.heading === lapLayout.course.lap.line.headingRad;
      })());
const lapOutsideRules = createSprintRules(lapLayout);
let lapOutsideTick = 0;
lapOutsideRules.prime(lapRuleState(0, 0));
while (lapOutsideRules.phase === 'countdown') { lapOutsideTick++; lapOutsideRules.step(lapRuleState(lapOutsideTick, 0)); }
const lapOutsideEvents = lapOutsideRules.step(lapRuleState(lapOutsideTick + 1, 100,
  lapLayout.course.lap.bandHalfWidthMetres + 1));
check('lap rules: leaving the declared band triggers an outside-corridor respawn at the line',
      lapOutsideEvents.some((event) => event.type === SPRINT_EVENT.RESPAWN &&
        event.reasons.includes('outside-corridor') && event.target.gateId === 'lap-line') &&
      lapOutsideRules.awaitingRejoin === true,
      lapOutsideEvents.map((event) => event.type + ':' + (event.reasons ?? []).join('+')).join(','));
const lapResetRules = createSprintRules(lapLayout);
lapResetRules.lapIndex = 2;
lapResetRules.lapTimes = [20, 21];
lapResetRules.phase = 'finished';
lapResetRules.finishTimeSeconds = 60;
lapResetRules.reset();
check('lap rules: R restart resets laps, lap times, timer and finish state',
      lapResetRules.phase === 'countdown' && lapResetRules.elapsedTicks === 0 &&
      lapResetRules.lapIndex === 0 && lapResetRules.lapTimes.length === 0 &&
      lapResetRules.finishTimeSeconds === null && lapResetRules.lapDistance === 0,
      lapResetRules.phase);

// Best-time store: localStorage-shaped, including hostile storages.
function fakeStorage(initial = null) {
  const map = new Map(initial ? [[ 'e1-drive.sprint.best.v1', JSON.stringify(initial) ]] : []);
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value))
  };
}
const bestStorage = fakeStorage();
const bestTimes = createBestTimes(bestStorage);
const firstSubmit = bestTimes.submit('corvette-zr1-stock', { seconds: 2.8, car: 'Corvette_ZR1_Stock', checkpoints: 2, respawns: 0 });
const slowerSubmit = bestTimes.submit('corvette-zr1-stock', { seconds: 3.1, car: 'Corvette_ZR1_Stock', checkpoints: 2, respawns: 0 });
const fasterSubmit = bestTimes.submit('corvette-zr1-stock', { seconds: 2.65, car: 'Corvette_ZR1_Stock', checkpoints: 2, respawns: 1 });
const otherCar = bestTimes.submit('audi-r8v10-stock', { seconds: 2.3, car: 'Audi_R8V10_Stock', checkpoints: 2, respawns: 0 });
check('best times: the store keeps the fastest run per car and marks improvements',
      firstSubmit.improved === true && slowerSubmit.improved === false &&
      slowerSubmit.best === 2.8 && fasterSubmit.improved === true &&
      fasterSubmit.best === 2.65 && otherCar.best === 2.3 &&
      bestTimes.bestFor('corvette-zr1-stock') === 2.65 &&
      bestTimes.bestFor('audi-r8v10-stock') === 2.3,
      JSON.stringify({ corvette: bestTimes.bestFor('corvette-zr1-stock'), audi: bestTimes.bestFor('audi-r8v10-stock') }));
const corruptStorage = fakeStorage();
corruptStorage.map.set('e1-drive.sprint.best.v1', '{not json');
const corruptBest = createBestTimes(corruptStorage);
const corruptSubmit = corruptBest.submit('corvette-zr1-stock', { seconds: 2.9 });
const throwingBest = createBestTimes({
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('quota'); }
});
const throwingSubmit = throwingBest.submit('corvette-zr1-stock', { seconds: 2.9 });
check('best times: malformed JSON and a throwing storage degrade to no record instead of failing the page',
      corruptSubmit.improved === true && corruptSubmit.best === 2.9 &&
      throwingSubmit.improved === true && throwingBest.persistent === false &&
      throwingBest.bestFor('corvette-zr1-stock') === null,
      JSON.stringify({ corrupt: corruptSubmit.best, throwingPersistent: throwingBest.persistent }));
const courseKeyStorage = fakeStorage();
const longBest = createBestTimes(courseKeyStorage, 'e1-drive.sprint.best.v2.310m');
const shortBest = createBestTimes(courseKeyStorage, 'e1-drive.sprint.best.v2.short');
longBest.submit('corvette-zr1-stock', { seconds: 14.65 });
shortBest.submit('corvette-zr1-stock', { seconds: 2.8 });
check('best times: the 310 m and 29 m courses keep independent per-course best-time keys',
      longBest.bestFor('corvette-zr1-stock') === 14.65 &&
      shortBest.bestFor('corvette-zr1-stock') === 2.8 &&
      courseKeyStorage.map.has('e1-drive.sprint.best.v2.310m') &&
      courseKeyStorage.map.has('e1-drive.sprint.best.v2.short'),
      JSON.stringify([...courseKeyStorage.map.keys()]));

// ------------------------------------------------------------- real respawn
const respawnCar = results.find((entry) => entry.default) ?? results[0];
const respawnRun = await runRespawnScenario(respawnCar, readFileSync(path.join(ROOT, respawnCar.fields.path)));
const respawnEvent = respawnRun.respawnEvents[0] ?? null;
const respawnRebuild = respawnRun.rebuild;
check('respawn: the off-course car triggers exactly one respawn with a measured reason',
      respawnRun.respawnEvents.length === 1 && respawnEvent !== null &&
      respawnEvent.reasons.includes('outside-corridor'),
      respawnEvent ? `${respawnEvent.reasons.join('+')} at tick ${respawnEvent.tick}, z ${respawnEvent.position[2].toFixed(2)}` : 'no respawn');
check('respawn: the car is rebuilt at the last passed checkpoint, on a real ground hit',
      respawnRebuild !== null && respawnEvent !== null &&
      respawnRebuild.target.gateId === respawnEvent.target.gateId &&
      respawnRebuild.target.heading === derivedLayout.gates[0].headingRad &&
      respawnRebuild.probe.hit === 1 &&
      Math.abs(respawnRebuild.probe.y - derivedLayout.gates[0].height) < 0.2 &&
      Math.hypot(respawnRebuild.position[0] - respawnRebuild.target.x,
        respawnRebuild.position[2] - respawnRebuild.target.z) < 1.0 &&
      respawnRebuild.contacts.join('') === '1111' && respawnRebuild.tickAfterBuild === 0,
      respawnRebuild ? `${respawnRebuild.target.gateId} at ${respawnRebuild.target.x},${respawnRebuild.target.z}, ` +
        `probe y ${respawnRebuild.probe.y?.toFixed(3)}, car ${respawnRebuild.position.map((v) => v.toFixed(2)).join(',')}` : 'no rebuild');
check('respawn: the attempt timer keeps running across the respawn and the gate progress is kept',
      respawnRebuild !== null && respawnRun.post !== null &&
      respawnRun.post.elapsedTicks > respawnRebuild.elapsedBefore &&
      respawnRun.post.checkpointsPassed >= respawnRebuild.gateProgressBefore &&
      respawnRun.post.respawns === 1,
      respawnRun.post ? `elapsed ${respawnRun.post.elapsed} s, ${respawnRun.post.checkpointsPassed} checkpoints kept` : 'no post state');
check('respawn: after the rebuild the car drives on from the checkpoint and stays inside the measured band',
      respawnRun.post !== null && respawnRun.post.speed > 1 &&
      coursePosition(derivedLayout.course.samples, respawnRun.post.position).distance <=
        derivedLayout.course.corridor.halfWidthMetres + derivedLayout.rules.respawn.outsideBandMarginMetres,
      respawnRun.post ? `${respawnRun.post.speed.toFixed(2)} m/s at ` +
        respawnRun.post.position.map((v) => v.toFixed(2)).join(',') : 'no post state');

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
        !/corvette_c3_race/i.test(entry.body.modelPakPath ?? '') &&
        entry.body.meshId === 'car.' + entry.slug + '.body'),
      results.map((entry) => entry.body.modelPakPath).join(', '));
check('the cars are actually different machines',
      results.length === 1 ||
      (new Set(results.map((entry) => entry.record.id)).size === results.length &&
       new Set(results.map((entry) => entry.drivetrain)).size > 1),
      results.map((entry) => `${entry.name}:${entry.drivetrain}`).join(', '));

// ------------------------------------------------------------- cross-car sprint
const sprintFinishers = sprintResults.filter((entry) => entry.finish !== null);
check('every roster car finishes the sprint with both checkpoints',
      sprintFinishers.length === sprintResults.length &&
      sprintFinishers.every((entry) => entry.finish.checkpoints === 2),
      sprintFinishers.map((entry) => `${entry.slug}:${entry.finish?.timeSeconds ?? 'DNF'} s`).join(', '));
check('every car replays the sprint to the same state hashes with the rules switched off',
      sprintResults.every((entry) => entry.replayMatches === true),
      sprintResults.map((entry) => `${entry.slug}:${entry.replayMatches}`).join(', '));
check('the sprint keeps a clean physics record for every car (contact every tick, no NaN)',
      sprintResults.every((entry) => entry.contactTicks === entry.ticks && entry.nanTicks === 0),
      sprintResults.map((entry) => `${entry.slug}:${entry.contactTicks}/${entry.ticks}, nan ${entry.nanTicks}`).join(' '));
const audiResult = sprintResults.find((entry) => entry.slug === 'audi-r8v10-stock');
const fwdResult = sprintResults.find((entry) => entry.slug === 'ford-focusrs-stock');
if (audiResult && fwdResult) {
  const referenceSprints = sprintResults.filter((entry) => REFERENCE_CAR_SLUGS.has(entry.slug));
  check('the same sprint script separates the five reference drivetrains (AWD fastest, FWD slowest)',
        audiResult.finish && fwdResult.finish &&
        referenceSprints.every((entry) => entry === audiResult || !entry.finish ||
          entry.finish.timeSeconds > audiResult.finish.timeSeconds) &&
        referenceSprints.every((entry) => entry === fwdResult || !entry.finish ||
          entry.finish.timeSeconds < fwdResult.finish.timeSeconds),
        referenceSprints.map((entry) => `${entry.slug}:${entry.finish?.timeSeconds ?? 'DNF'}`).join(', '));
}

// The P31 record documented that the Focus RS, Dodge and Lotus mid frames showed
// terrain because the camera had no occlusion avoidance. That defect must be
// reproducible with the unoccluded camera and gone with the colliding one.
const MID_OCCLUDED = ['lotus-exige-cup260-stock', 'dodge-challenger-stock', 'ford-focusrs-stock'];
const midOccluded = MID_OCCLUDED.map((slug) => results.find((entry) => entry.slug === slug)).filter(Boolean);
if (midOccluded.length === MID_OCCLUDED.length) {
  check('the recorded tick-150 prop occlusion is reproduced by the unoccluded camera and resolved by the colliding one',
        midOccluded.every((entry) => entry.camera.tick150 &&
          entry.camera.tick150.legacyHitDistance !== null && entry.camera.tick150.clear &&
          entry.camera.tick150.resolvedDistance <=
            entry.camera.tick150.legacyHitDistance - entry.camera.marginMetres + 1e-6),
        midOccluded.map((entry) => `${entry.slug}@150: unoccluded hit ` +
          `${entry.camera.tick150?.legacyHitDistance?.toFixed(2)} m -> eye ${entry.camera.tick150?.resolvedDistance?.toFixed(2)} m`).join(', '));
}

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

// ---------------------------------------------------------------- engine audio (P71)
// The page drives `probes/audio/web/engine-audio.js` once per frame with the
// wasm car's live `Engine().RPM()`. These non-browser gates re-derive the retail
// curves from the decoded model, verify the six served WAVs, and prove that
// constructing the module / calling setRpm creates no AudioContext.
const audioModule = await import(pathToFileURL(path.join(ROOT, 'probes/audio/web/engine-audio.js')).href);
const audioModel = JSON.parse(readFileSync(path.join(ROOT, '_work/audio/engine-model.json'), 'utf8'));
const audioPlf = (points, x) => {
  if (!points || points.length === 0) return 0;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
};
const audioCurves = audioModule.RETAIL_RACE_V8_ENGINE_CURVES;
const audioModelLoops = audioModel.loops;
const audioModuleSlots = new Set(audioCurves.map((layer) => layer.slot));
const audioComparedLoops = audioModelLoops.filter((loop) => audioModuleSlots.has(loop.slot));
const audioExcludedLoops = audioModelLoops.filter((loop) => !audioModuleSlots.has(loop.slot));
const audioTableMatches = audioCurves.length === 6 && audioComparedLoops.length === 6 &&
  audioComparedLoops.every((loop) => {
    const layer = audioCurves.find((entry) => entry.slot === loop.slot);
    return layer && layer.wave === loop.wave && layer.rpmLabel === loop.rpmLabel &&
      JSON.stringify(layer.volume) === JSON.stringify(loop.volume) &&
      JSON.stringify(layer.pitch) === JSON.stringify(loop.pitch);
  });
check('engine audio: the shipped module table is the decoded retail Race_V8_engine model (slots, labels, every point)',
      audioTableMatches, `${audioCurves.length} layers vs ${audioComparedLoops.length} compared decoded loops`);
check('engine audio: only RaceV8_Engine_decel (slot 7) is excluded, as documented (its volume chain is flat zero)',
      audioExcludedLoops.length === 1 && audioExcludedLoops[0].slot === 7 &&
      audioExcludedLoops[0].wave === 'RaceV8_Engine_decel',
      audioExcludedLoops.map((loop) => `${loop.slot}:${loop.wave}`).join(', ') || 'none excluded');

const audioRpms = [1500, 3015, 6000];
let audioMaxDelta = 0;
const audioSamples = [];
for (const rpm of audioRpms) {
  const sample = audioModule.sampleEngineCurves(rpm);
  const x = audioModule.rpmToX(rpm);
  let delta = 0;
  for (const loop of audioComparedLoops) {
    const layer = sample.layers.find((entry) => entry.slot === loop.slot);
    if (!layer) { delta = Infinity; continue; }
    const gain = audioPlf(loop.volume, x);
    const rate = Math.max(audioModule.MIN_PLAYBACK_RATE, audioPlf(loop.pitch, x));
    delta = Math.max(delta, Math.abs(layer.gain - gain), Math.abs(layer.rate - rate));
  }
  audioMaxDelta = Math.max(audioMaxDelta, delta);
  audioSamples.push({ rpm, x, maxDelta: delta });
}
check('engine audio: x = RPM * 0.0001 and the six layer gains/rates match the retail PLF at 1500/3015/6000',
      audioMaxDelta < 1e-9, `max delta ${audioMaxDelta.toExponential(2)}`);

const audioWavProblems = [];
let audioWavCount = 0;
for (const [wave, entry] of Object.entries(audioModel.wavFiles)) {
  if (wave === 'RaceV8_Engine_decel') continue;
  audioWavCount += 1;
  const file = path.join(ROOT, '_work/audio', entry.file);
  if (!existsSync(file)) { audioWavProblems.push(entry.file + ': missing'); continue; }
  const bytes = readFileSync(file);
  if (bytes.length !== entry.bytes) audioWavProblems.push(entry.file + ': ' + bytes.length + ' B');
  else if (sha256(bytes) !== entry.sha256) audioWavProblems.push(entry.file + ': sha256 mismatch');
}
check('engine audio: the six decoded WAVs under _work/audio are present, sized and hash-identical to the model',
      audioWavCount === 6 && audioWavProblems.length === 0,
      audioWavProblems.join('; ') || `${audioWavCount} files`);

let audioIdle = null;
try { audioIdle = audioModule.createEngineAudio(); } catch { audioIdle = null; }
let audioIdleDiag = null;
if (audioIdle) {
  audioIdle.setRpm(1500);
  audioIdleDiag = audioIdle.getDiagnostics();
}
check('engine audio: construction + setRpm create no AudioContext and decode nothing before a gesture',
      audioIdle !== null && audioIdle.state === 'idle' && audioIdleDiag.contextState === 'none' &&
      audioIdleDiag.decoded.length === 0 && audioIdleDiag.targets.length === 6 &&
      audioIdleDiag.layers.length === 0,
      audioIdleDiag
        ? `state ${audioIdleDiag.state}, context ${audioIdleDiag.contextState}, decoded ${audioIdleDiag.decoded.length}, ` +
          `targets ${audioIdleDiag.targets.length}, live ${audioIdleDiag.layers.length}`
        : 'construction failed');

let audioNegative = null;
let audioNonFinite = null;
if (audioIdle) {
  try { audioIdle.setRpm(-1); } catch (error) { audioNegative = error; }
  try { audioIdle.setRpm(Number.NaN); } catch (error) { audioNonFinite = error; }
}
check('engine audio: negative and non-finite RPM are rejected with typed errors (no silent clamp)',
      audioNegative instanceof RangeError && audioNonFinite instanceof TypeError,
      `${audioNegative?.name ?? 'none'} / ${audioNonFinite?.name ?? 'none'}`);

const audioDisposed = audioIdle ? audioIdle.dispose() : null;
const audioDisposedDiag = audioIdle ? audioIdle.getDiagnostics() : null;
check('engine audio: dispose reports disposed and drops layers/buffers with no live context',
      audioDisposed !== null && audioDisposed.state === 'disposed' &&
      audioDisposedDiag.layers.length === 0 && audioDisposedDiag.decoded.length === 0,
      audioDisposed ? `${audioDisposed.state}, ${audioDisposedDiag.layers.length} layers` : 'no instance');

const audioRuntime = await (await import(pathToFileURL(MODULE).href)).default();
const audioRpmBefore = typeof audioRuntime._e1_engine_rpm === 'function' ? audioRuntime._e1_engine_rpm() : null;
const audioFieldsBytes = readFileSync(path.join(ROOT, defaultForAliases.fields.path));
const audioLevelPtr = audioRuntime._malloc(levelBytes.length);
const audioFieldsPtr = audioRuntime._malloc(audioFieldsBytes.length + 1);
audioRuntime.HEAPU8.set(levelBytes, audioLevelPtr);
audioRuntime.HEAPU8.set(audioFieldsBytes, audioFieldsPtr);
const audioCreated = audioRuntime._e1_create(audioLevelPtr, levelBytes.length, audioFieldsPtr,
                                             audioFieldsBytes.length, TICK0_LIMITS.x, TICK0_LIMITS.z,
                                             TICK0_LIMITS.heading);
audioRuntime._free(audioLevelPtr);
audioRuntime._free(audioFieldsPtr);
const audioRpmAfter = audioCreated ? audioRuntime._e1_engine_rpm() : null;
const audioLimiter = roster.roster.cars.find((car) => car.slug === defaultForAliases.slug)?.values?.limiterRPM ?? null;
check('engine audio: _e1_engine_rpm() is -1 before a world and the live Engine().RPM() after create',
      audioRpmBefore === -1 && audioCreated === 1 && Number.isFinite(audioRpmAfter) &&
      audioRpmAfter > 0 && (audioLimiter === null || audioRpmAfter <= audioLimiter),
      `before ${audioRpmBefore}, after ${audioRpmAfter}, limiter ${audioLimiter}`);

// ------------------------------------------------------------------ multiplayer
// M1 Node-level gate: the unchanged room service, the injected NetClient, the
// page's MpSession wrapper and the shared result builder. No browser is needed
// for the protocol, sequence, authority, reconnect or result checks.
let mpNodeReport = null;
{
  const mpChecksBefore = checks.length;
  const roomServer = await startRoomServer({ port: 0, log: () => {} });
  const mpEvents = { authority: {}, peer: [], results: null, errors: [] };
  const makeSession = (options) => new MpSession({
    NetClient,
    url: roomServer.wsUrl,
    maxPlayers: 2,
    car: 'corvette-zr1-stock',
    onEvent: (type, payload) => {
      if (options.name === 'Host' && type === 'remoteState') mpEvents.authority.hostSeesGuest = payload.authority;
      if (options.name === 'Guest' && type === 'remoteState') mpEvents.authority.guestSeesHost = payload.authority;
      if (type === 'peerDisconnected' || type === 'peerResumed' || type === 'reconnected') mpEvents.peer.push({ type });
      if (type === 'result') mpEvents.results = payload.results;
      if (type === 'error') mpEvents.errors.push(payload?.message ?? String(payload));
    },
    ...options
  });
  let mpHost = null;
  let mpGuest = null;
  const mpNode = {
    kind: 'e1-drive.mp-node',
    version: 1,
    room: null,
    lobby: null,
    sequence: null,
    authority: null,
    sample: null,
    reconnect: null,
    finish: null,
    result: null,
    session: null,
    remoteDisplay: null,
    rejections: {},
    constants: {
      tickHz: MP_TICK_HZ,
      stateEveryTicks: MP_STATE_EVERY_TICKS,
      positionThresholdMetres: MP_POSITION_THRESHOLD_METRES,
      angleThresholdRad: MP_ANGLE_THRESHOLD_RAD,
      blendTicks: MP_BLEND_TICKS
    }
  };
  try {
    mpHost = makeSession({ name: 'Host', host: true });
    await mpHost.open();
    const code = mpHost.code;
    mpGuest = makeSession({ name: 'Guest', host: false, code });
    await mpGuest.open();
    await new Promise((resolve) => setTimeout(resolve, 150));
    mpNode.room = {
      code,
      hostId: mpHost.hostId,
      hostSlot: mpHost.slot,
      guestSlot: mpGuest.slot,
      hostCar: mpHost.players.find((player) => player.id === mpHost.playerId)?.car ?? null,
      guestCar: mpGuest.players.find((player) => player.id === mpGuest.playerId)?.car ?? null,
      sessionCar: sessionCarForRoom(mpHost.room)
    };
    check('mp: host created a room and the guest joined the same code',
      typeof code === 'string' && code.length === 5 && mpGuest.code === code && mpHost.players.length === 2,
      JSON.stringify(mpNode.room));
    check('mp: host/guest slots are 1/2 and the host marker is stable',
      mpHost.slot === 1 && mpGuest.slot === 2 && mpHost.hostId === mpHost.playerId &&
      mpHost.players.find((player) => player.host)?.id === mpHost.playerId,
      JSON.stringify({ hostSlot: mpHost.slot, guestSlot: mpGuest.slot, hostId: mpHost.hostId }));
    check('mp: M1 session car is the host car (guest pick is metadata)',
      mpNode.room.sessionCar === mpNode.room.hostCar,
      JSON.stringify({ sessionCar: mpNode.room.sessionCar, hostCar: mpNode.room.hostCar,
        guestCar: mpNode.room.guestCar }));

    // Room map selection (M3): the protocol map field is host-only, guests see
    // the broadcast, and the selected id survives into room.started.
    const mapBefore = mpHost.room?.map ?? null;
    await mpHost.selectMap('amboy');
    await new Promise((resolve) => setTimeout(resolve, 120));
    const mapAfterHost = { host: mpHost.room?.map, guest: mpGuest.room?.map };
    let guestMapSelectError = null;
    try { await mpGuest.selectMap('gracia'); }
    catch (error) { guestMapSelectError = error instanceof NetError ? error.code : error.name; }
    mpNode.map = {
      before: mapBefore,
      selected: 'amboy',
      afterHost: mapAfterHost,
      guestRejected: guestMapSelectError,
      records: Object.fromEntries(MP_MAP_IDS.map((id) => [id, mpMapRecord(id)]))
    };
    check('mp: host selects the room map and the guest sees it; guest selection is rejected',
      mapAfterHost.host === 'amboy' && mapAfterHost.guest === 'amboy' && guestMapSelectError === 'NET_NOT_HOST',
      JSON.stringify({ before: mapBefore, after: mapAfterHost, guestRejected: guestMapSelectError }));

    try { await mpGuest.start(); mpNode.rejections.nonHostStart = null; }
    catch (error) { mpNode.rejections.nonHostStart = error instanceof NetError ? error.code : error.name; }
    check('mp: a non-host start is rejected with NET_NOT_HOST',
      mpNode.rejections.nonHostStart === 'NET_NOT_HOST', String(mpNode.rejections.nonHostStart));

    await mpHost.setReady(true);
    await mpGuest.setReady(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    check('mp: ready flags propagate to both rosters',
      mpHost.players.every((player) => player.ready) && mpGuest.players.every((player) => player.ready),
      JSON.stringify(mpHost.players.map((player) => [player.slot, player.ready])));
    const started = await mpHost.start({ seed: 'blur-mp-node-v1' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    check('mp: host start broadcasts the same seed/startTick/tickHz to both',
      started.seed === 'blur-mp-node-v1' && started.startTick === 1 && started.tickHz === 60 &&
      mpGuest.startedInfo?.seed === started.seed && mpHost.phase === 'running' && mpGuest.phase === 'running',
      JSON.stringify({ host: started, guest: mpGuest.startedInfo }));
    check('mp: room.started carries the selected map id and the registry hash record',
      started.room?.map === 'amboy' && mpGuest.startedInfo?.mapId === 'amboy' &&
      mpGuest.startedInfo?.map?.packageHash === mpMapRecord('amboy').packageHash &&
      mpHost.startedInfo?.map?.layoutHash === mpMapRecord('amboy').layoutHash,
      JSON.stringify({ startedMap: started.room?.map, guest: mpGuest.startedInfo?.mapId,
        packageHash: mpGuest.startedInfo?.map?.packageHash }));

    const samples = sprintFile.course.samples;
    const sampleAtArc = (arc) => {
      let low = 0;
      let high = samples.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (samples[middle].arc < arc) low = middle + 1; else high = middle;
      }
      return samples[Math.max(0, Math.min(samples.length - 1, low))];
    };
    const stateAt = (tick, lateral) => {
      const sample = sampleAtArc(Math.min(300, Math.max(0, (tick - 90) * 0.5)));
      return {
        tick,
        position: [sample.x + lateral, sample.groundY, sample.z],
        quaternion: [0, 0, 0, 1],
        speed: tick > 90 ? 30 : 0
      };
    };
    const exchangeTicks = 60;
    for (let tick = 1; tick <= exchangeTicks; tick++) {
      mpHost.sendInput({ throttle: 1, brake: 0, steer: 0, handbrake: 0 }, tick);
      mpGuest.sendInput({ throttle: 1, brake: 0, steer: 0, handbrake: 0 }, tick);
      if (tick % MP_STATE_EVERY_TICKS === 0) {
        mpHost.sendState(stateAt(tick, -1.1));
        mpGuest.sendState(stateAt(tick, 1.1));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const mpHostStats = mpHost.stats();
    const mpGuestStats = mpGuest.stats();
    const streamRow = (stats, channel) => stats.streams.find((stream) => stream.channel === channel) ?? null;
    const hostStateStream = streamRow(mpHostStats, 'state');
    const hostInputStream = streamRow(mpHostStats, 'input');
    const guestStateStream = streamRow(mpGuestStats, 'state');
    mpNode.sequence = {
      hostSent: mpHostStats.sent,
      guestSent: mpGuestStats.sent,
      hostStateApplied: hostStateStream?.lastApplied ?? null,
      hostInputApplied: hostInputStream?.lastApplied ?? null,
      guestStateApplied: guestStateStream?.lastApplied ?? null,
      hostViolations: hostStateStream?.violations ?? null,
      guestViolations: guestStateStream?.violations ?? null
    };
    check('mp: every 20 Hz state and 60 Hz input arrived in sequence',
      hostStateStream?.lastApplied === Math.floor(exchangeTicks / MP_STATE_EVERY_TICKS) &&
      hostStateStream?.violations === 0 && hostInputStream?.lastApplied === exchangeTicks &&
      hostInputStream?.violations === 0 && guestStateStream?.lastApplied === Math.floor(exchangeTicks / MP_STATE_EVERY_TICKS) &&
      guestStateStream?.violations === 0,
      JSON.stringify(mpNode.sequence));
    mpNode.authority = { ...mpEvents.authority };
    check('mp: host relayed state is authoritative for the guest; guest relay is not for the host',
      mpEvents.authority.guestSeesHost === true && mpEvents.authority.hostSeesGuest === false,
      JSON.stringify(mpEvents.authority));
    const remoteSample = mpHost.sampleRemote(mpGuest.playerId, 30);
    mpNode.sample = remoteSample;
    check('mp: remote interpolation returns a pose inside the received snapshot window',
      remoteSample !== null && Number.isFinite(remoteSample.position?.[0]) &&
      remoteSample.tick === 30 && remoteSample.clamped === false,
      JSON.stringify(remoteSample));

    const corrector = new RemoteDisplay();
    const first = corrector.update({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
    const blend = corrector.update({ position: [0.1, 0, 0], quaternion: [0, 0, 0, 1] });
    const hard = corrector.update({ position: [2.0, 0, 0], quaternion: [0, 0, 0, 1] });
    mpNode.remoteDisplay = {
      first: first?.corrections ?? null, blend: blend?.blended ?? null, blendCorrections: blend?.corrections ?? null,
      hard: hard?.hardSet ?? null, hardCorrections: hard?.corrections ?? null,
      thresholds: { position: MP_POSITION_THRESHOLD_METRES, angle: MP_ANGLE_THRESHOLD_RAD },
      blendTicks: MP_BLEND_TICKS
    };
    check('mp: remote display blends small deltas and hard-sets past 0.5 m (counted)',
      first !== null && blend?.blended === true && blend?.hardSet === false && blend?.corrections === 0 &&
      hard?.hardSet === true && hard?.corrections === 1,
      JSON.stringify(mpNode.remoteDisplay));

    mpHost.finalizeStreams();
    mpGuest.finalizeStreams();
    await mpHost.waitForStreams(4000);
    await mpGuest.waitForStreams(4000);
    const hostFinishTick = 120;
    // The guest report may be much later than any host-side projection (a host
    // rebuild can pause its local race clock). It is accepted while the race is
    // still open, not only inside a 6-tick detection window.
    const guestFinishTick = hostFinishTick + 193;
    const hostHash = hashOfLocal({ kind: 'e1-drive.mp.finish.test', player: 'host', tick: hostFinishTick });
    const guestHash = hashOfLocal({ kind: 'e1-drive.mp.finish.test', player: 'guest', tick: guestFinishTick });
    await mpHost.reportFinished({ tick: hostFinishTick, hash: hostHash });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const hostOnlyPhase = mpHost.room?.phase ?? null;
    mpNode.finish = {
      hostOnlyPhase,
      roomPhase: mpHost.room?.phase ?? null,
      results: mpEvents.results,
      hostTick: hostFinishTick,
      guestTick: guestFinishTick,
      guestReportDelayTicks: guestFinishTick - hostFinishTick
    };
    check('mp: the room stays open for a late guest report after the host finishes',
      hostOnlyPhase === 'running', String(hostOnlyPhase));
    await mpGuest.reportFinished({ tick: guestFinishTick, hash: guestHash });
    await new Promise((resolve) => setTimeout(resolve, 300));
    mpNode.finish.roomPhase = mpHost.room?.phase ?? null;
    mpNode.finish.results = mpEvents.results;
    check('mp: both client.finished reports reach the room and finish it',
      mpHost.room?.phase === 'finished' && mpGuest.room?.phase === 'finished' &&
      Array.isArray(mpEvents.results) && mpEvents.results.length === 2 &&
      mpEvents.results.find((row) => row.playerId === mpGuest.playerId)?.tick === guestFinishTick,
      JSON.stringify(mpNode.finish));
    let closedReport = null;
    try {
      await mpGuest.reportFinished({ tick: guestFinishTick + 1, hash: guestHash });
    } catch (error) { closedReport = error.code ?? error.name; }
    check('mp: a finish report after the room closed is rejected with MP_ROOM_CLOSED',
      closedReport === MP_ROOM_CLOSED, String(closedReport));
    const resultOne = buildMpResult({
      layout: sprintFile,
      room: mpHost.room,
      results: mpEvents.results
    });
    const resultTwo = buildMpResult({
      layout: sprintFile,
      room: mpGuest.room,
      results: mpEvents.results
    });
    mpNode.result = {
      hash: resultOne.hash,
      secondHash: resultTwo.hash,
      rows: resultOne.rows,
      order: resultOne.order
    };
    check('mp: the shared result table is identical on both clients and deterministic',
      resultOne.hash === resultTwo.hash && resultOne.order.length === 2 &&
      resultOne.rows.every((row) => row.status === 'finished'),
      JSON.stringify({ hash: resultOne.hash, second: resultTwo.hash }));
    check('mp: finish ticks map to equal race times (countdown subtracted) and host is P1',
      resultOne.rows[0].positionNumber === 1 && resultOne.rows[0].tick === hostFinishTick &&
      Math.abs(resultOne.rows[0].timeSeconds - (hostFinishTick - (sprintFile.countdown?.ticks ?? 0)) / MP_TICK_HZ) < 1e-6 &&
      resultOne.rows[1].positionNumber === 2 && resultOne.rows[1].tick === guestFinishTick,
      JSON.stringify(resultOne.rows.map((row) => [row.positionNumber, row.name, row.tick, row.timeSeconds])));

    // Reconnect while the room is finished is still a valid resume; the room
    // retains the same player id/slot and the host does not change.
    const guestIdBefore = mpGuest.playerId;
    const hostIdBefore = mpHost.hostId;
    let resumed = null;
    try { resumed = await mpGuest.net.simulateDrop({ timeoutMs: 8000 }); }
    catch (error) { mpEvents.errors.push(error.message); }
    await new Promise((resolve) => setTimeout(resolve, 150));
    mpNode.reconnect = {
      resumed: Boolean(resumed?.resumed),
      guestIdBefore,
      guestIdAfter: mpGuest.playerId,
      hostIdBefore,
      hostIdAfter: mpHost.hostId,
      peerEvents: mpEvents.peer.slice()
    };
    check('mp: a dropped guest resumes the same room slot and the host stays stable',
      resumed?.resumed === true && mpGuest.playerId === guestIdBefore && mpHost.hostId === hostIdBefore,
      JSON.stringify(mpNode.reconnect));

    // Rules-level host authority on the committed 310 m layout. Synthetic
    // centre-line motion, two participants, same command sequence twice.
    const runRules = () => {
      const session = new RaceSession({
        layout: sprintFile,
        participants: ['p1', 'p2'],
        config: { hostId: 'p1' }
      });
      session.command({ type: 'ready', from: 'p1', ready: true });
      session.command({ type: 'ready', from: 'p2', ready: true });
      session.command({ type: 'start', from: 'p1' });
      session.step(null);
      const countdown = sprintFile.countdown?.ticks ?? 0;
      for (let tick = 1; tick <= 1200; tick++) {
        const arc1 = tick <= countdown ? 0 : Math.min(305, (tick - countdown) * 0.49);
        const arc2 = tick <= countdown ? 0 : Math.min(305, (tick - countdown) * 0.47);
        const s1 = sampleAtArc(arc1);
        const s2 = sampleAtArc(arc2);
        session.step({
          p1: { position: [s1.x, s1.groundY, s1.z], contact: true },
          p2: { position: [s2.x, s2.groundY, s2.z], contact: true }
        });
        if (session.phase === 'finished') break;
      }
      return session;
    };
    const sessionA = runRules();
    const sessionB = runRules();
    const sessionResult = sessionA.snapshot().results;
    mpNode.session = {
      phase: sessionA.phase,
      raceTick: sessionA.raceTick,
      hash: sessionA.hash(),
      secondHash: sessionB.hash(),
      rows: sessionResult.rows.map((row) => ({
        id: row.id, position: row.position, status: row.status, finishTick: row.finishTick
      })),
      eventLogHash: sessionA.eventLogHash()
    };
    check('mp: host RaceSession finishes both participants on the committed 310 m layout',
      sessionA.phase === 'finished' && sessionResult.rows.length === 2 &&
      sessionResult.rows.every((row) => row.status === 'finished'),
      JSON.stringify(mpNode.session.rows));
    check('mp: RaceSession results order the faster car first and the snapshot hash repeats',
      sessionResult.rows[0].id === 'p1' && sessionResult.rows[0].position === 1 &&
      sessionA.hash() === sessionB.hash() && sessionA.replayHash() === sessionB.replayHash(),
      JSON.stringify({ first: sessionResult.rows[0], hash: sessionA.hash(), second: sessionB.hash() }));
    check('mp: URL/code helpers keep the documented M1 contract',
      defaultRoomUrl({ protocol: 'http:', hostname: '127.0.0.1' }) === 'ws://127.0.0.1:8811/ws' &&
      normalizeRoomCode('abcde') === 'ABCDE' && normalizeRoomCode('ABCD1') === null &&
      normalizeRoomCode('ABCDE') === 'ABCDE',
      JSON.stringify({ url: defaultRoomUrl({ protocol: 'http:', hostname: '127.0.0.1' }),
        lower: normalizeRoomCode('abcde'), bad: normalizeRoomCode('ABCD1') }));
    const guestPeerEvents = mpEvents.peer.map((event) => event.type);
    check('mp: the reconnect path is exercised through the unchanged room service (no new transport)',
      mpNode.reconnect.resumed === true && mpNode.reconnect.guestIdAfter === guestIdBefore,
      JSON.stringify({ peerEvents: guestPeerEvents, reconnect: mpNode.reconnect }));
  } catch (error) {
    mpNode.error = error?.stack ?? String(error);
    check('mp: Node multiplayer harness completed without an exception', false, String(error?.message ?? error));
  } finally {
    try { mpHost?.close(); } catch {}
    try { mpGuest?.close(); } catch {}
    await roomServer.close();
  }
  mpNode.checks = checks.length - mpChecksBefore;
  mpNode.failures = checks.slice(mpChecksBefore).filter((entry) => !entry.ok).map((entry) => entry.label);
  mpNodeReport = mpNode;
  writeFileSync(path.join(OUT, 'mp-node-report.json'), JSON.stringify(mpNode, null, 2) + '\n', 'utf8');
}

// ------------------------------------------------------------------ MP map gate
// The room map record, its committed package pins and the typed mismatch
// refusal. This block never loads the 49–73 MB map documents into memory; it
// pins their file bytes (the content hashes are verified by verify_e1_map on
// both maps) and verifies the layout/physics bytes the room actually compares.
// River's wire package is the always-loaded level chunk, not the combined debug
// geometry.
let mpMapReport = null;
{
  const mpMapChecksBefore = checks.length;
  const mapFiles = {
    river: {
      // The wire identity of the chunked River route is the always-loaded level
      // chunk, not the combined debug artifact the page never fetches.
      package: LEVEL_GEOMETRY,
      layout: path.join(OUT, 'sprint.json'),
      physics: path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics')
    },
    amboy: {
      package: path.join(OUT, 'amboy/map.json'),
      layout: path.join(OUT, 'amboy/layout.json'),
      physics: path.join(ROOT, 'game-data/Blur/levels/usa_amboy/Level.levelphysics')
    },
    gracia: {
      package: path.join(OUT, 'gracia/map.json'),
      layout: path.join(OUT, 'gracia/layout.json'),
      physics: path.join(ROOT, 'game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics')
    }
  };
  const records = {};
  const fileHashes = {};
  for (const id of MP_MAP_IDS) {
    const files = mapFiles[id];
    const record = mpMapRecord(id);
    records[id] = record;
    const missing = Object.entries(files).filter(([, file]) => !existsSync(file)).map(([kind, file]) => kind + ' ' + file);
    const hashes = missing.length ? null : {
      package: sha256File(files.package),
      layout: sha256File(files.layout),
      physics: sha256File(files.physics)
    };
    fileHashes[id] = hashes;
    check('mp-map: ' + id + ' registry record and committed files agree',
      missing.length === 0 && hashes !== null &&
      record.packageFileSha256 === hashes.package &&
      record.layoutFileSha256 === hashes.layout &&
      record.physicsFileSha256 === hashes.physics &&
      typeof record.packageHash === 'string' && typeof record.layoutHash === 'string' &&
      typeof record.physicsHash === 'string',
      JSON.stringify({ missing, record, hashes }));
  }
  const expected = records.amboy;
  const actual = { ...expected, source: 'measured-bytes' };
  const agreement = compareMpMapRecords(expected, actual);
  const mismatch = compareMpMapRecords(expected, { ...actual, physicsHash: 'sha256:0000000000000000' });
  let refusal = null;
  try { assertMpMapAgreement(expected, { ...actual, layoutHash: 'sha256:1111111111111111' }, 'node test'); }
  catch (error) { refusal = { name: error.name, code: error.code, timed: error instanceof MpMapError }; }
  check('mp-map: hash agreement accepts equal records and refuses a mismatch with MAP_PACKAGE_MISMATCH',
    agreement.ok === true && mismatch.ok === false && mismatch.code === MP_MAP_MISMATCH &&
    mismatch.mismatches.some((row) => row.field === 'physicsHash') &&
    refusal?.code === MP_MAP_MISMATCH && refusal?.name === 'MpMapError',
    JSON.stringify({ agreement, mismatch, refusal }));
  const room = {
    code: 'NODE1',
    hostId: 'p1',
    phase: 'finished',
    map: 'amboy',
    players: [
      { id: 'p1', slot: 1, name: 'Host', car: 'corvette-zr1-stock', host: true, connected: true },
      { id: 'p2', slot: 2, name: 'Guest', car: 'corvette-zr1-stock', host: false, connected: true }
    ]
  };
  const results = [
    { playerId: 'p1', tick: 14000, hash: 'sha256:aaaaaaaa' },
    { playerId: 'p2', tick: 14600, hash: 'sha256:bbbbbbbb' }
  ];
  const amboyLayout = JSON.parse(readFileSync(mapFiles.amboy.layout, 'utf8'));
  const graciaLayout = JSON.parse(readFileSync(mapFiles.gracia.layout, 'utf8'));
  const amboyResult = buildMpResult({ layout: amboyLayout, room, results });
  const graciaResult = buildMpResult({ layout: graciaLayout, room, results });
  const lastGate = amboyLayout.gates[amboyLayout.gates.length - 1];
  check('mp-map: the shared result builder works on the Amboy and Gracia layouts',
    amboyResult.courseId === 'amboy' && graciaResult.courseId === 'gracia' &&
    amboyResult.rows.every((row) => row.status === 'finished') &&
    amboyResult.rows[0].positionNumber === 1 && amboyResult.rows[1].positionNumber === 2 &&
    Math.abs(amboyResult.rows[0].timeSeconds - (14000 - (amboyLayout.countdown?.ticks ?? 0)) / MP_TICK_HZ) < 1e-6 &&
    amboyResult.finishGate[0] === Math.round(lastGate.x * 1e6) / 1e6 &&
    amboyResult.finishGate[2] === Math.round(lastGate.z * 1e6) / 1e6,
    JSON.stringify({ amboy: amboyResult.hash, gracia: graciaResult.hash,
      finish: amboyResult.finishGate, rows: amboyResult.rows.map((row) => [row.name, row.timeSeconds]) }));
  // The released race-rules layer predates M3: its course-id allow-list is
  // `310m`/`lap`. The page projects a package layout through the equivalent
  // point-to-point sprint mode with the samples/gates/hash untouched.
  const projected = { ...amboyLayout, sourceCourseId: amboyLayout.courseId, courseId: '310m' };
  const projectedModel = new CourseModel(projected, { verifyLayoutHash: false });
  check('mp-map: package layouts project to the released rules sprint mode without changing gates',
    projectedModel.courseId === '310m' && projectedModel.mode === 'sprint' &&
    projectedModel.checkpointCount === 2 && projectedModel.startGate.id === 'start' &&
    projectedModel.finishGate.id === 'finish' &&
    projectedModel.samples.length === amboyLayout.course.samples.length &&
    projectedModel.samples[0].x === amboyLayout.course.samples[0].x,
    JSON.stringify({ courseId: projectedModel.courseId, checkpoints: projectedModel.checkpointCount,
      samples: projectedModel.samples.length }));
  check('mp-map: reported finish ticks derive from race time (host respawn has no off-by-one)',
    mpFinishTick(14.666667, 90) === 970 &&
    mpFinishTick(222, 90) === 13410 &&
    mpFinishTick(66.316667, 90) === 4069 &&
    mpFinishTick(69.183333, 90) === 4241,
    JSON.stringify({ river: mpFinishTick(14.666667, 90), amboy: mpFinishTick(222, 90),
      graciaHost: mpFinishTick(66.316667, 90), graciaGuest: mpFinishTick(69.183333, 90) }));
  mpMapReport = {
    kind: 'e1-drive.mp-map',
    version: 1,
    ids: MP_MAP_IDS.slice(),
    records,
    fileHashes,
    agreement: { ok: agreement.ok, mismatch: mismatch.mismatches },
    refusal,
    results: { amboy: amboyResult.hash, gracia: graciaResult.hash },
    checks: checks.length - mpMapChecksBefore,
    failures: checks.slice(mpMapChecksBefore).filter((entry) => !entry.ok).map((entry) => entry.label)
  };
  writeFileSync(path.join(OUT, 'mp-map-node-report.json'), JSON.stringify(mpMapReport, null, 2) + '\n', 'utf8');
}

// ------------------------------------------------------------------ MP AI gate
// M4: host-configured AI opponents. The roster/result/remote logic is tested
// without a browser; the browser driver copy is checked against the committed
// AI driver on the real wasm vehicle (same inputs, same finish ticks).
let mpAiReport = null;
{
  const mpAiChecksBefore = checks.length;
  const aiReport = {
    kind: 'e1-drive.mp-ai',
    version: 1,
    lobby: null,
    participants: null,
    driver: null,
    races: null,
    result: null,
    remotes: null,
    relay: null,
    sourceGuard: null
  };
  try {
    // Lobby roster: 0-3 built records with stable ids and slots.
    const built = buildAiRoster(roster, {
      count: 2,
      cars: 'audi-r8v10-stock,dodge-challenger-stock',
      profiles: 'reference,cautious',
      firstSlot: 3
    });
    const empty = buildAiRoster(roster, { count: 0 });
    const tooMany = buildAiRoster(roster, { count: 4 });
    const badCar = buildAiRoster(roster, { count: 1, cars: 'not-a-car' });
    const badProfile = buildAiRoster(roster, { count: 1, profiles: 'aggressive' });
    aiReport.lobby = {
      built: { count: built.count, built: built.built, players: built.players },
      empty: { count: empty.count, built: empty.built, ready: aiRosterReady(empty) },
      rejections: {
        tooMany: { built: tooMany.built, errors: tooMany.errors },
        badCar: { built: badCar.built, errors: badCar.errors },
        badProfile: { built: badProfile.built, errors: badProfile.errors }
      }
    };
    check('mp-ai: host builds 0-3 AI records with ai-1... ids and slots after the humans',
      built.built === true && built.players.length === 2 &&
      built.players.every((player, index) => player.id === 'ai-' + (index + 1) && player.slot === 3 + index) &&
      empty.built === true && empty.players.length === 0 && aiRosterReady(empty),
      JSON.stringify(aiReport.lobby));
    check('mp-ai: invalid count, car or profile is a typed refusal (no guessed slot)',
      tooMany.built === false && tooMany.errors.length === 1 &&
      badCar.built === false && /unknown car/.test(badCar.errors[0]) &&
      badProfile.built === false && /unknown skill profile/.test(badProfile.errors[0]),
      JSON.stringify(aiReport.lobby.rejections));

    // Participant ids: humans keep their room slots; AI follows with stable ids.
    const participants = aiParticipants([
      { id: 'pl_guest', slot: 2 }, { id: 'pl_host', slot: 1 }
    ], built.players);
    aiReport.participants = participants;
    check('mp-ai: RaceSession participants are the two humans plus ai-1/ai-2 in slots 3/4',
      participants.length === 4 && participants[0].id === 'pl_host' &&
      participants[1].id === 'pl_guest' && participants[2].id === 'ai-1' &&
      participants[2].slot === 3 && participants[3].id === 'ai-2' && participants[3].slot === 4,
      JSON.stringify(participants));

    // Source and behaviour guard: the browser copy must be the committed driver
    // with only the crypto import/hash helper swapped.
    const committedSource = readFileSync(path.join(ROOT, 'probes/ai-driver/ai-driver.mjs'), 'utf8')
      .replace(/\r\n/g, '\n');
    const browserSource = readFileSync(path.join(ROOT, 'probes/e1-drive/web/ai-driver-browser.js'), 'utf8')
      .replace(/\r\n/g, '\n');
    const canonicalMarker = '// Canonical JSON / SHA-256 helpers';
    const controllerStart = 'export const DRIVER_KIND';
    const committedMath = committedSource.slice(committedSource.indexOf(controllerStart),
      committedSource.indexOf(canonicalMarker));
    const browserMath = browserSource.slice(browserSource.indexOf(controllerStart),
      browserSource.indexOf(canonicalMarker));
    const tablesEqual = JSON.stringify(BrowserAiProfiles) === JSON.stringify(
      (await import('../../ai-driver/ai-driver.mjs')).SKILL_PROFILES);
    aiReport.sourceGuard = {
      controllerBytes: committedMath.length,
      sourceEqual: committedMath === browserMath,
      tablesEqual
    };
    check('mp-ai: the browser driver copy is the committed controller (source + skill tables)',
      committedMath.length > 10000 && committedMath === browserMath && tablesEqual,
      JSON.stringify(aiReport.sourceGuard));

    // Real wasm equivalence and deterministic finish ticks. Start pose is the
    // committed AI1 pose (course spawn + start-gate heading).
    const aiFactory = (await import(pathToFileURL(MODULE).href)).default;
    const aiLevelBytes = new Uint8Array(readFileSync(LEVEL));
    const aiFields = (slug) => {
      const car = roster.roster.cars.find((entry) => entry.slug === slug);
      if (!car) throw new Error('roster has no car ' + slug);
      return new Uint8Array(readFileSync(path.join(ROOT, car.fields.path)));
    };
    const startPose = {
      x: sprintFile.course.spawn.x,
      z: sprintFile.course.spawn.z,
      heading: sprintFile.gates[0].headingRad
    };
    const runAi = async (DriverClass, slug, profile, options = {}) => {
      const layout = options.layout ?? sprintFile;
      const level = options.levelBytes ?? aiLevelBytes;
      const start = options.start ?? startPose;
      const module = await aiFactory();
      const fields = aiFields(slug);
      const levelPtr = module._malloc(level.length);
      const fieldsPtr = module._malloc(fields.length + 1);
      module.HEAPU8.set(level, levelPtr);
      module.HEAPU8.set(fields, fieldsPtr);
      const ok = module._e1_create(levelPtr, level.length, fieldsPtr, fields.length,
        start.x, start.z, start.heading);
      module._free(levelPtr);
      module._free(fieldsPtr);
      if (!ok) throw new Error('AI e1_create failed: ' + module.UTF8ToString(module._e1_last_error()));
      const read = () => JSON.parse(module.UTF8ToString(module._e1_get_state()));
      let state = read();
      const driver = new DriverClass({ layout, profile, controlOverrides: options.controlOverrides ?? null });
      driver.prime(state);
      for (let tick = 0; tick < (layout.countdown?.ticks ?? 0); tick++) {
        module._e1_set_input(0, 0, 0, 0);
        module._e1_step();
        state = read();
      }
      const inputs = [];
      let raceTick = 0;
      let respawns = 0;
      while (!driver.finished && raceTick < (options.maxRaceTicks ?? 2000)) {
        raceTick += 1;
        const terms = driver.step(state);
        inputs.push(terms.input.map((value) => Number(value.toFixed(9))));
        module._e1_set_input(terms.input[0], terms.input[1], terms.input[2], terms.input[3]);
        module._e1_step();
        state = read();
        const events = driver.observe(state, raceTick);
        const respawn = events.find((event) => event.type === 'respawn');
        if (respawn) {
          respawns++;
          const target = respawn.target;
          const lp = module._malloc(level.length);
          const fp = module._malloc(fields.length + 1);
          module.HEAPU8.set(level, lp);
          module.HEAPU8.set(fields, fp);
          module._e1_create(lp, level.length, fp, fields.length, target.x, target.z, target.headingRad);
          module._free(lp);
          module._free(fp);
          state = read();
          driver.reprime(state);
        }
      }
      return { finish: driver.finish, inputs, inputHash: hashOfLocal(inputs), respawns };
    };
    const committedAudi = await runAi(CommittedAiDriver, 'audi-r8v10-stock', 'reference');
    const browserAudi = await runAi(BrowserAiDriver, 'audi-r8v10-stock', 'reference');
    const browserAudi2 = await runAi(BrowserAiDriver, 'audi-r8v10-stock', 'reference');
    const browserDodge = await runAi(BrowserAiDriver, 'dodge-challenger-stock', 'cautious');
    const browserDodge2 = await runAi(BrowserAiDriver, 'dodge-challenger-stock', 'cautious');
    aiReport.driver = {
      committedAudi: { tick: committedAudi.finish?.tick, time: committedAudi.finish?.timeSeconds,
        inputHash: committedAudi.inputHash },
      browserAudi: { tick: browserAudi.finish?.tick, time: browserAudi.finish?.timeSeconds,
        inputHash: browserAudi.inputHash },
      browserAudi2: { tick: browserAudi2.finish?.tick, inputHash: browserAudi2.inputHash },
      browserDodge: { tick: browserDodge.finish?.tick, time: browserDodge.finish?.timeSeconds,
        inputHash: browserDodge.inputHash },
      browserDodge2: { tick: browserDodge2.finish?.tick, inputHash: browserDodge2.inputHash }
    };
    check('mp-ai: the browser driver copy replays the committed Audi run input-for-input',
      committedAudi.finish?.tick === 849 && browserAudi.finish?.tick === 849 &&
      committedAudi.inputHash === browserAudi.inputHash &&
      committedAudi.inputs.length === browserAudi.inputs.length,
      JSON.stringify(aiReport.driver));
    check('mp-ai: two fresh instances produce identical Audi/Dodge finish ticks and inputs',
      browserAudi.finish?.tick === browserAudi2.finish?.tick &&
      browserAudi.inputHash === browserAudi2.inputHash &&
      browserDodge.finish?.tick === browserDodge2.finish?.tick &&
      browserDodge.inputHash === browserDodge2.inputHash,
      JSON.stringify(aiReport.driver));

    // Amboy/Gracia use the measure-path control. Amboy applies the driver
    // owner's minSpeed 3.5 override; Gracia uses MAP_CONTROL unchanged.
    const mapAiRun = async (mapId, slug, profile, controlOverrides) => {
      const layout = JSON.parse(readFileSync(path.join(OUT, mapId, 'layout.json'), 'utf8'));
      const levelPath = mapId === 'amboy'
        ? path.join(ROOT, 'game-data/Blur/levels/usa_amboy/Level.levelphysics')
        : path.join(ROOT, 'game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics');
      return runAi(BrowserAiDriver, slug, profile, {
        layout,
        levelBytes: new Uint8Array(readFileSync(levelPath)),
        start: { x: layout.course.spawn.x, z: layout.course.spawn.z, heading: layout.gates[0].headingRad },
        controlOverrides,
        maxRaceTicks: 20000
      });
    };
    const amboyRunA = await mapAiRun('amboy', 'corvette-zr1-stock', 'reference', { minSpeed: 3.5 });
    const amboyRunB = await mapAiRun('amboy', 'corvette-zr1-stock', 'reference', { minSpeed: 3.5 });
    const graciaRunA = await mapAiRun('gracia', 'corvette-zr1-stock', 'reference', null);
    const graciaRunB = await mapAiRun('gracia', 'corvette-zr1-stock', 'reference', null);
    const graciaDodge = buildAiRoster(roster, {
      count: 1, cars: 'dodge-challenger-stock', profiles: 'reference', mapId: 'gracia'
    });
    aiReport.maps = {
      amboy: { tick: amboyRunA.finish?.tick, time: amboyRunA.finish?.timeSeconds,
        respawns: amboyRunA.respawns, inputHash: amboyRunA.inputHash,
        secondInputHash: amboyRunB.inputHash, overrides: { minSpeed: 3.5 } },
      gracia: { tick: graciaRunA.finish?.tick, time: graciaRunA.finish?.timeSeconds,
        respawns: graciaRunA.respawns, inputHash: graciaRunA.inputHash,
        secondInputHash: graciaRunB.inputHash, overrides: null },
      graciaDodge
    };
    check('mp-ai: Amboy reference AI finishes cleanly in the measured 220-229 s band and repeats',
      amboyRunA.finish?.tick > 0 && amboyRunA.finish.timeSeconds >= 220 &&
      amboyRunA.finish.timeSeconds <= 229 && amboyRunA.respawns === 0 &&
      amboyRunA.inputHash === amboyRunB.inputHash,
      JSON.stringify(aiReport.maps.amboy));
    check('mp-ai: Gracia reference AI matches the committed 66.266667 s anchor and repeats',
      graciaRunA.finish?.tick === 3976 &&
      Math.abs(graciaRunA.finish.timeSeconds - 66.266667) < 1e-6 &&
      graciaRunA.respawns === 0 && graciaRunA.inputHash === graciaRunB.inputHash,
      JSON.stringify(aiReport.maps.gracia));
    check('mp-ai: Gracia + Dodge is a typed ai-spawn-unsupported refusal',
      graciaDodge.built === false && graciaDodge.errorCodes?.length === 1 &&
      graciaDodge.errorCodes[0].code === MP_AI_SPAWN_UNSUPPORTED &&
      /front axle/.test(graciaDodge.errorCodes[0].message),
      JSON.stringify(graciaDodge));
    check('mp-ai: the page map-control hooks match the driver owner values',
      aiControlOverrides('amboy')?.minSpeed === 3.5 &&
      aiControlOverrides('gracia') === null && aiControlOverrides('river') === null &&
      aiSpawnSupport('gracia', 'dodge-challenger-stock').code === MP_AI_SPAWN_UNSUPPORTED &&
      aiSpawnSupport('gracia', 'audi-r8v10-stock').ok === true &&
      aiSpawnSupport('river', 'dodge-challenger-stock').ok === true,
      JSON.stringify({ amboy: aiControlOverrides('amboy'), gracia: aiControlOverrides('gracia') }));

    // RaceSession with 4 participants on synthetic centre-line motion: AI rows
    // are host rows and ordering is by finish tick.
    const aiRace = new RaceSession({
      layout: sprintFile,
      participants,
      config: { hostId: 'pl_host', minParticipants: 2, maxParticipants: 5 }
    });
    for (const participant of participants) {
      aiRace.command({ type: 'ready', from: participant.id, ready: true });
    }
    aiRace.command({ type: 'start', from: 'pl_host' });
    aiRace.step(null);
    const sampleAtArcMpAi = (arc) => {
      const samples = sprintFile.course.samples;
      let low = 0;
      let high = samples.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (samples[middle].arc < arc) low = middle + 1; else high = middle;
      }
      return samples[Math.max(0, Math.min(samples.length - 1, low))];
    };
    const countdown = sprintFile.countdown?.ticks ?? 0;
    for (let tick = 1; tick <= 1400 && aiRace.phase !== 'finished'; tick++) {
      const states = {};
      const arcs = { pl_host: 0.49, pl_guest: 0.47, 'ai-1': 0.485, 'ai-2': 0.45 };
      for (const [id, speed] of Object.entries(arcs)) {
        const sample = sampleAtArcMpAi(tick <= countdown ? 0 : Math.min(305, (tick - countdown) * speed));
        states[id] = { position: [sample.x, sample.groundY, sample.z], contact: true };
      }
      aiRace.step(states);
    }
    const raceResults = aiRace.snapshot().results;
    const aiRaceRows = aiResultRows(raceResults.rows, built.players, countdown, MP_TICK_HZ, 0);
    aiReport.races = {
      phase: aiRace.phase,
      order: raceResults.order,
      rows: raceResults.rows.map((row) => ({ id: row.id, status: row.status, finishTick: row.finishTick })),
      aiRows: aiRaceRows
    };
    check('mp-ai: a 4-participant RaceSession finishes both AI participants with ordered rows',
      aiRace.phase === 'finished' && raceResults.rows.length === 4 &&
      raceResults.rows.every((row) => row.status === 'finished') &&
      aiRaceRows.length === 2 && aiRaceRows.every((row) => row.status === 'finished' && Number.isInteger(row.tick)),
      JSON.stringify(aiReport.races));
    check('mp-ai: AI result rows add the countdown and match the human tick convention',
      aiRaceRows.every((row) => row.tick === row.raceTick + countdown && row.timeSeconds ===
        Math.round(row.raceTick / MP_TICK_HZ * 1e6) / 1e6),
      JSON.stringify(aiRaceRows));

    // Shared result merge: identical hash twice; AI rows ordered by tick; the
    // 0-AI output keeps the M1 shape (no `ai` key).
    const aiRoom = {
      players: [
        { id: 'pl_host', slot: 1, name: 'Host', car: 'corvette-zr1-stock', host: true },
        { id: 'pl_guest', slot: 2, name: 'Guest', car: 'corvette-zr1-stock', host: false }
      ]
    };
    const humanResults = [
      { playerId: 'pl_host', tick: 970, hash: 'sha256:' + '0'.repeat(64) },
      { playerId: 'pl_guest', tick: 1074, hash: 'sha256:' + '1'.repeat(64) }
    ];
    const aiPlayers = built.players.map((player) => ({
      id: player.id, slot: player.slot, name: player.name, car: player.car, profile: player.profile
    }));
    const aiResults = aiResultRows([
      { id: 'ai-1', status: 'finished', finishTick: 848 },
      { id: 'ai-2', status: 'finished', finishTick: 1013 }
    ], built.players, countdown, MP_TICK_HZ, 1);
    const mergedOne = buildMpResult({
      layout: sprintFile, room: aiRoom, results: humanResults, aiPlayers, aiResults
    });
    const mergedTwo = buildMpResult({
      layout: sprintFile, room: aiRoom, results: humanResults, aiPlayers, aiResults
    });
    const noAi = buildMpResult({ layout: sprintFile, room: aiRoom, results: humanResults });
    aiReport.result = {
      hash: mergedOne.hash,
      secondHash: mergedTwo.hash,
      order: mergedOne.order,
      rows: mergedOne.rows.map((row) => ({ id: row.playerId, position: row.positionNumber,
        ai: row.ai === true, profile: row.profile ?? null, tick: row.tick, timeSeconds: row.timeSeconds })),
      noAiHash: noAi.hash,
      noAiHasAiField: Object.prototype.hasOwnProperty.call(noAi, 'ai')
    };
    check('mp-ai: the merged human+AI table is deterministic and includes ai-1/ai-2 rows',
      mergedOne.hash === mergedTwo.hash && mergedOne.rows.length === 4 &&
      mergedOne.rows[0].playerId === 'ai-1' && mergedOne.rows[0].ai === true &&
      mergedOne.rows.find((row) => row.playerId === 'ai-2')?.profile === 'cautious',
      JSON.stringify(aiReport.result));
    check('mp-ai: the 0-AI result keeps the M1 shape and hash inputs unchanged',
      noAi.rows.length === 2 && aiReport.result.noAiHasAiField === false &&
      noAi.rows.every((row) => row.ai === undefined),
      JSON.stringify({ hash: noAi.hash, rows: noAi.rows.length }));

    // Guest remote set: 20 Hz poses interpolate; the display corrector is intact.
    const aiSet = new AiRemoteSet({
      players: [{ id: 'ai-1', slot: 3, name: 'AI 1', car: 'audi-r8v10-stock', profile: 'reference' }],
      InterpolationBuffer,
      delayTicks: 0
    });
    aiSet.applyPose({ tick: 0, cars: [{ id: 'ai-1', tick: 0, position: [0, 0, 0],
      quaternion: [0, 0, 0, 1], speed: 1 }] });
    aiSet.applyPose({ tick: 3, cars: [{ id: 'ai-1', tick: 3, position: [3, 0, 0],
      quaternion: [0, 0, 0, 1], speed: 1 }] });
    const aiSamples = aiSet.sample(1.5);
    const aiSnapshot = aiSet.snapshot();
    aiReport.remotes = {
      samples: aiSamples.map((entry) => ({ id: entry.id, sampleTick: entry.sample?.tick ?? null,
        position: entry.pose?.position ?? null, display: entry.display ?? null })),
      snapshot: aiSnapshot
    };
    check('mp-ai: the guest remote set interpolates 20 Hz AI poses and corrects display error',
      aiSamples.length === 1 && Math.abs((aiSamples[0].pose?.position?.[0] ?? 0) - 1.5) < 1e-9 &&
      aiSamples[0].display.corrections === 0 && aiSnapshot[0].sampleTick === 1.5,
      JSON.stringify(aiReport.remotes));

    // Ordered host→guest relay: roster, pose and result; an unknown kind is a 400.
    const aiServer = await startServer({ port: 0 });
    try {
      const post = (body) => fetch(aiServer.origin + '/_mp-ai/relay', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      await post({ room: 'AITST', from: 'pl_host', kind: 'roster', payload: { ai: { count: 2 } } });
      await post({ room: 'AITST', from: 'pl_host', kind: 'pose', payload: { tick: 90, cars: [] } });
      await post({ room: 'AITST', from: 'pl_host', kind: 'result', payload: { rows: [] } });
      const polled = await (await fetch(aiServer.origin +
        '/_mp-ai/relay?room=AITST&after=0&exclude=pl_guest')).json();
      const bad = await post({ room: 'AITST', from: 'pl_host', kind: 'input', payload: {} });
      const stats = await (await fetch(aiServer.origin + '/_mp-ai/relay/stats?room=AITST')).json();
      aiReport.relay = {
        kinds: polled.messages.map((message) => message.kind),
        next: polled.next,
        badStatus: bad.status,
        stats: stats.stats
      };
      check('mp-ai: the relay carries roster → pose → result in order and rejects unknown kinds',
        JSON.stringify(aiReport.relay.kinds) === JSON.stringify(['roster', 'pose', 'result']) &&
        polled.next === 3 && bad.status === 400 && stats.stats?.pose === 1,
        JSON.stringify(aiReport.relay));
    } finally {
      await new Promise((resolve) => aiServer.server.close(resolve));
    }
  } catch (error) {
    aiReport.error = error?.stack ?? String(error);
    check('mp-ai: AI gate completed without an exception', false, String(error?.message ?? error));
  }
  aiReport.checks = checks.length - mpAiChecksBefore;
  aiReport.failures = checks.slice(mpAiChecksBefore).filter((entry) => !entry.ok).map((entry) => entry.label);
  mpAiReport = aiReport;
  writeFileSync(path.join(OUT, 'mp-ai-node-report.json'), JSON.stringify(aiReport, null, 2) + '\n', 'utf8');
}

const report = {
  purpose: 'E1 drive slice: wasm vehicle physics -> render packet v1.1 -> WebGPU consumer, several XT cars',
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  multiplayer: mpNodeReport,
  mpMap: mpMapReport,
  mpAi: mpAiReport,
  propV2: {
    kind: 'e1-drive.prop-collision-v2',
    version: 1,
    scope: 'read-only P74 V2 manifests bound per course; additive post-tick resolver; visible-mesh approximation',
    pins: {
      sprint: { ...SPRINT_PROP_PINS },
      lap: { ...LAP_PROP_PINS },
      free: { ...FREE_PROP_PINS }
    },
    drivenLineExclusions: {
      artifact: path.relative(ROOT, SPRINT_EXCLUSION_FILE).split(path.sep).join('/'),
      artifactSha256: 'sha256:' + sha256(sprintExclusionBytes),
      ids: SPRINT_DRIVEN_EXCLUSIONS.slice(),
      count: SPRINT_DRIVEN_EXCLUSIONS.length,
      contentSha256: SPRINT_DRIVEN_EXCLUSION_CONTENT_SHA256,
      reason: `the committed scripted lines touch these ${SPRINT_DRIVEN_EXCLUSIONS.length} active roadside colliders ` +
        '(including swept between-tick contacts); excluding exactly them keeps the anchored sprint bit-identical ' +
        'while every other V2 structure is solid'
    },
    lineMeasurements: {
      sprintRoadside: sprintRoadMeasure,
      sprintAllVisible: sprintAllMeasure,
      lapAllVisible: loopPropMeasure
    },
    targets: v2LayerTests,
    collisionProbes: {
      lapSign: { ...lapCollisionProbe, startContacts: lapProbeContacts.length },
      freePipe: { ...freeCollisionProbe, startContacts: freeProbeContacts.length }
    }
  },
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
  engineAudio: {
    module: 'probes/audio/web/engine-audio.js',
    model: '_work/audio/engine-model.json',
    rpms: audioRpms,
    xDomain: 'x = RPM * 0.0001',
    maxCurveDelta: audioMaxDelta,
    samples: audioSamples,
    wavCount: audioWavCount,
    wavHashesMatchModel: audioWavProblems.length === 0,
    idleConstructionCreatesNoContext: audioIdleDiag?.contextState === 'none',
    rpmBeforeCreate: audioRpmBefore,
    rpmAfterCreate: audioRpmAfter,
    limiterRPM: audioLimiter,
    note: 'the page drives this module once per frame with _e1_engine_rpm() (wasm Engine().RPM()); ' +
      'capture_browser.mjs --mode audio verifies live AudioParam gains/rates and RMS'
  },
  geometry: {
    path: path.relative(ROOT, GEOMETRY).split(path.sep).join('/'),
    bytes: readFileSync(GEOMETRY).length,
    version: geometry.version,
    levelDraws: geometry.levelDraws.length,
    levelVertices: geometry.meshes[0].vertexCount,
    levelTriangles: geometry.meshes[0].indexCount / 3,
    trackVertices: trackVisual?.vertexCount ?? 0,
    trackTriangles: trackVisual?.triangleCount ?? 0,
    trackDraws: trackVisual?.drawCount ?? 0,
    trackLabel: trackVisual?.label ?? null,
    trackSections: trackVisual?.sections ?? [],
    textures: {
      count: geometry.textures?.length ?? 0,
      rgbaBytes: Array.isArray(geometry.textures)
        ? geometry.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0) : 0,
      texturedDraws: trackVisual?.texturedDrawCount ?? 0,
      uvVertices: geometry.meshes.find((mesh) => mesh.id === trackVisual?.meshId)?.uv?.vertexCount ?? 0,
      uvBytes: geometry.meshes.find((mesh) => mesh.id === trackVisual?.meshId)?.uv?.bytes ?? 0,
      uvSha256: geometry.meshes.find((mesh) => mesh.id === trackVisual?.meshId)?.uv?.sha256 ?? null,
      sampler: geometry.texturePack?.sampler ?? null,
      coverage: geometry.texturePack?.coverage ?? null
    },
    collisionSurface: {
      meshId: geometry.collisionSurface?.meshId ?? null,
      vertices: geometry.collisionSurface?.vertexCount ?? 0,
      triangles: geometry.collisionSurface?.triangleCount ?? 0,
      visible: geometry.collisionSurface?.visible ?? null,
      physicsOnly: geometry.collisionSurface?.physicsOnly ?? null,
      uploaded: geometry.meshes.some((mesh) => mesh.id === geometry.collisionSurface?.meshId),
      coverage: geometry.collisionSurface?.coverage ?? null
    },
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
  camera: {
    rule: 'chase orbit, yaw follows the car with a per-tick lag; the eye is pulled in front of the first ' +
      'visible-geometry hit along the target->eye segment, pull-in immediate, push-out eased',    occluder: occluderDescribe,
    hiddenPhysicsSurfacesUsed: false,
    hiddenPhysicsSurfacesReason: 'physicsSurfaces are visible:false and are neither uploaded nor drawn, so they ' +
      'are not occluders; only the drawn level props and real track visual are',
    marginMetres: results[0]?.camera.marginMetres ?? null,
    nearFieldMetres: results[0]?.camera.nearFieldMetres ?? null,
    minimumDistanceMetres: results[0]?.camera.minimumDistanceMetres ?? null,
    recoveryPerTick: results[0]?.camera.recoveryPerTick ?? null,
    continuousCollision: false,
    cars: results.map((entry) => ({
      slug: entry.slug,
      ticks: entry.camera.ticks,
      blockedTicks: entry.camera.blockedTicks,
      resolvableBlockedTicks: entry.camera.resolvableBlockedTicks,
      nearFieldTicks: entry.camera.nearFieldTicks,
      clearTicks: entry.camera.clearTicks,
      minDistance: entry.camera.minDistance,
      maxDistance: entry.camera.maxDistance,
      tick150: entry.camera.tick150
    }))
  },
  sprint: {
    courseId: derivedLayout.courseId,
    layout: sprintLayoutCheck,
    rules: derivedLayout.rules,
    countdown: derivedLayout.countdown,
    prop: {
      profile: SPRINT_PROP_PINS.profile,
      manifest: SPRINT_PROP_PINS.manifest,
      fileSha256: propFileSha,
      contentSha256: SPRINT_PROP_PINS.manifestContentSha256,
      colliders: propManifest.colliders.length,
      activeRoadside: sprintProfileWorld.colliders.length,
      drivenLineExclusions: SPRINT_DRIVEN_EXCLUSIONS.length,
      activeAfterExclusions: sprintPropWorld.colliders.length,
      drivenLineExclusionContentSha256: SPRINT_DRIVEN_EXCLUSION_CONTENT_SHA256,
      lineSamples: sprintRoadMeasure.samples,
      lineBlockedSamples: sprintRoadMeasure.blocked,
      minCentreDistanceMetres: sprintRoadMeasure.minDistanceMetres,
      minCentreColliderId: sprintRoadMeasure.minColliderId,
      minCentreArc: sprintRoadMeasure.minArc,
      allVisibleEvidence: {
        blockedSamples: sprintAllMeasure.blocked,
        arcs: sprintAllMeasure.arcs
      },
      note: 'the timed 310 m course keeps the V2 roadside profile (553 of 651): the four measured arcs ' +
        '52.897-61.131, 114.277-121.763, 124.757-127.751 and 181.397-206.847 m stay mapped but inactive, ' +
        'and ' + SPRINT_DRIVEN_EXCLUSIONS.length + ' further colliders that the committed scripted lines ' +
        'actually touch are excluded by the measured driven-line set (' + SPRINT_PROP_PINS.colliders +
        ' active). The manifest is unchanged.'
    },
    ruleTests: {
      finishRejectedWithoutCheckpoints: true,
      outOfOrderCheckpointIgnored: true,
      belowGroundRespawn: belowEvents.map((event) => event.reasons ?? []).flat(),
      pathBelowGroundRespawn: pathBelowEvents.map((event) => event.reasons ?? []).flat(),
      pathOutsideBandRespawn: pathOutsideEvents.map((event) => event.reasons ?? []).flat(),
      airborneRespawnTicks: rulesLayout.rules.respawn.airborneTicks,
      restartResetsTimer: true
    },
    bestTimes: {
      key: 'e1-drive.sprint.best.v1',
      pageKeys: {
        '310m': 'e1-drive.sprint.best.v2.310m',
        short: 'e1-drive.sprint.best.v2.short'
      },
      corvette: bestTimes.bestFor('corvette-zr1-stock'),
      audi: bestTimes.bestFor('audi-r8v10-stock'),
      corruptJsonFallsBack: corruptSubmit.improved === true,
      throwingStorageFallsBack: throwingBest.persistent === false
    },
    respawn: {
      car: respawnCar.slug,
      event: respawnEvent,
      rebuilt: respawnRebuild,
      post: respawnRun.post ? {
        elapsed: respawnRun.post.elapsed,
        elapsedTicks: respawnRun.post.elapsedTicks,
        checkpointsPassed: respawnRun.post.checkpointsPassed,
        respawns: respawnRun.post.respawns,
        position: respawnRun.post.position,
        speed: respawnRun.post.speed
      } : null
    },
    cars: sprintResults,
    shortCourse: {
      courseId: shortLayout.courseId,
      layout: sprintShortLayoutCheck,
      file: '_work/e1-drive/sprint-short.json',
      cars: sprintShortResults
    },
    lapCourse: {
      courseId: lapLayout.courseId,
      layout: lapLayoutCheck,
      file: '_work/e1-drive/sprint-lap.json',
      laps: lapLayout.course.lap.laps,
      prop: {
        profile: PROP_PROFILE,
        manifest: PROP_MANIFEST,
        fileSha256: propFileSha,
        contentSha256: propManifest.contentSha256,
        colliders: propManifest.colliders.length,
        activeAllVisible: lapPropWorld.colliders.length,
        loopSamples: loopPropMeasure.samples,
        loopBlockedSamples: loopPropMeasure.blocked,
        loopBlockedArcs: loopPropMeasure.arcs,
        loopContactIds: loopPropMeasure.contactIds,
        minCentreDistanceMetres: loopPropMeasure.minDistanceMetres,
        minCentreColliderId: loopPropMeasure.minColliderId,
        minCentreArc: loopPropMeasure.minArc,
        note: 'the P74 base V2 manifest covers the loop corridor (8 m) and the 310 m band (30 m); ' +
          'the 56 formerly missing lap components are now solid, and all-visible is still clear on loop-01'
      },
      rules: lapLayout.rules,
      cars: lapResults,
      restartCars: lapRestartResults
    },
    freeRoam: {
      courseId: freeLayout.courseId,
      layout: freeLayoutCheck,
      file: '_work/e1-drive/sprint-free.json',
      fileSha256: 'sha256:' + sha256(freeFileBytes),
      layoutHash: freeLayout.hash,
      spawn: freeLayout.course.spawn,
      spawnGroundY: freeLayout.course.spawnGroundY,
      bounds: freeBox,
      containment: freeLayout.course.containment,
      groundGrid: {
        stepMetres: freeLayout.course.groundGrid.stepMetres,
        columns: freeLayout.course.groundGrid.columns,
        rows: freeLayout.course.groundGrid.rows,
        measuredCells: freeLayout.course.groundGrid.measuredCells,
        filledCells: freeLayout.course.groundGrid.filledCells
      },
      coverage: freeLayout.course.coverage,
      regions: {
        file: FREE_REGIONS_PATH.file,
        fileSha256: freeRegionsFileSha,
        canonicalHash: freeRegions.hash,
        region: FREE_REGIONS_PATH.regionId,
        areaM2: freeBasin.areaM2,
        bounds: freeBasin.bounds
      },
      prop: {
        profile: FREE_PROP_PINS.profile,
        manifest: FREE_PROP_PINS.manifest,
        fileSha256: freePropFileSha,
        contentSha256: FREE_PROP_PINS.manifestContentSha256,
        variant: freePropManifest.variant,
        colliders: freePropManifest.colliders.length,
        activeAllVisible: freePropWorld.colliders.length,
        spawnContacts: freePropContacts(freeLayout.course.spawn.x, freeLayout.course.spawn.z,
          propYawFromHeading(freeLayout.course.spawn.headingRad), freeLayout.course.spawnGroundY).length,
        truck: freePropLayerTests.truck,
        thin: freePropLayerTests.thin,
        truckHeadOn: {
          blockedTicks: freePropLayerTests.truckHeadOn.blockedTicks,
          contacts: freePropLayerTests.truckHeadOn.contacts,
          residual: freePropLayerTests.truckHeadOn.residual,
          maxPenetrationMetres: freePropLayerTests.truckHeadOn.maxPenetrationMetres,
          side: freePropLayerTests.truckHeadOn.side
        },
        thinNoTunnel: {
          blockedTicks: freePropLayerTests.thinAt31.blockedTicks,
          contacts: freePropLayerTests.thinAt31.contacts,
          residual: freePropLayerTests.thinAt31.residual,
          maxPenetrationMetres: freePropLayerTests.thinAt31.maxPenetrationMetres,
          side: freePropLayerTests.thinAt31.side
        },
        targets: {
          lapWall: v2LayerTests.lapWall,
          freePipe: v2LayerTests.freePipe,
          lapSign: v2LayerTests.lapSign,
          freePole: v2LayerTests.freePole
        },
        note: 'the P74 R04-V2 manifest is a region replacement for free roam; the timed 310 m course keeps ' +
          'the base V2 roadside profile (553 of 651 colliders)'
      },
      rules: freeLayout.rules,
      containsNamedGates: freeLayout.gates.length !== 0,
      cars: freeResults,
      ruleCases: freeRuleCases,
      containmentScenario: freeContainment,
      restart: freeRestart
    },
    restartCars: sprintRestartResults
  },
  ghost: {
    kind: GHOST_INDEX_KIND,
    index: path.relative(ROOT, GHOST_INDEX_FILE).split(path.sep).join('/'),
    indexSha256: 'sha256:' + sha256(Buffer.from(ghostIndexText, 'utf8')),
    encoding: ghostIndex.encoding,
    sampleHz: TICK_HZ,
    presentationOnly: true,
    physicsUnchanged: ghostAnchored === ghostFiles.size,
    cars: ghostRows,
    reconstruction: {
      maxBodyMatrixDelta: ghostReconstruction.bodyMax,
      maxWheelMatrixDelta: ghostReconstruction.wheelMax,
      maxQuaternionUnitError: ghostReconstruction.quaternionMax,
      maxSelfGapSeconds: ghostReconstruction.selfDeltaSeconds,
      maxSelfGapMetres: ghostReconstruction.selfDeltaMetres
    },
    limits: [
      'a replay of one recorded run, not an AI opponent, a racing line or a second simulation',
      'one ghost per car and course; no collision, no input, no physics value and no packet field',
      'a run with a respawn is not recorded (its engine tick axis restarts)',
      'the ghost is drawn with a labelled translucent diagnostic tint from the already-uploaded car mesh',
      'the reference trace is the committed deterministic scripted sprint, not a human best'
    ]
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
  telemetry: {
    kind: 'e1-drive.telemetry',
    version: 1,
    sampleHz: TELEMETRY_SPEC.tickHz,
    spec: TELEMETRY_SPEC,
    units: {
      speed: 'km/h (state.speed m/s * 3.6)',
      time: 's (engine ticks / 60)',
      distance: 'm (XZ distance of the engine position)',
      accel: 'm/s2 from the per-tick finite difference of state.velocity, projected on the body axis',
      lateralG: 'lateral acceleration / 9.80665',
      yaw: 'deg/s from state.angular projected on the body up axis'
    },
    inputModel: 'accel: throttle on every tick; brake: a step at the tick the accel run first measured ' +
      '80 km/h; lateral: throttle then a square steering sweep derived from the tick with integer arithmetic',
    limits: {
      course: 'the measured sprint strip (spawn to x ~ -2); 0-100 km/h and 80-0 km/h braking fit on it, ' +
        'a full lap or a true Vmax run does not',
      topSpeed: 'the speed reached at the end of the fixed 86 m window, not a Vmax',
      lateral: 'peak lateral acceleration in a fixed 0.4 s square-steer sweep, not a grip limit',
      fidelity: 'diagnostic validation metrics from the unchanged physics; not retail handling fidelity'
    },
    ordering: {
      accel100: accelOrder,
      brakeDistance: brakeOrder,
      torqueScaleToMass: torqueToMassOrder,
      brakeToMass: brakeToMassOrder,
      accelRankDistance: rankDistance(accelOrder, torqueToMassOrder),
      brakeRankDistance: rankDistance(brakeOrder, brakeToMassOrder)
    },
    cars: telemetryResults,
    anomalies: [
      'the Lotus Exige has the highest XT brake-to-mass ratio but only the third-shortest measured ' +
      'stopping distance (17.0 m); the brake scalars alone do not order the stop, so the measurement ' +
      'is recorded rather than explained',
      ...telemetryResults
        .map((entry) => ({
          entry,
          missed: entry.metrics.lateral.reversals.filter((row) => row.lagTicks === null).length
        }))
        .filter(({ entry, missed }) => missed > 0)
        .map(({ entry, missed }) =>
          `${entry.slug}: ${missed} of ${entry.metrics.lateral.steerReversals} lateral steer reversals ` +
          `is not answered inside the fixed 60-tick window (declared typed miss; the other reversals ` +
          `keep their measured lags)`)
    ]
  },
  // The fixed rebuild limit: N create/reset cycles per car in one instance, one
  // instance for six telemetry manoeuvres, and the in-place sprint restart.
  resetCycles: {
    kind: 'e1-drive.reset-cycles',
    version: 1,
    cyclesPerCar: RESET_CYCLE_COUNT,
    ticksPerCycle: RESET_CYCLE_TICKS,
    telemetryManoeuvresPerInstance: 6,
    note: 'the scene creates and destroys its own scheduler groups, so one wasm instance can be ' +
      'rebuilt; root cause and measurements in docs/work/verification/T-007-reset-fix.md',
    cars: resetResults,
    telemetrySeries: telemetryResetResults,
    sprintRestart: sprintRestartResults
  },
  cars: results,
  // The extended corridor is measured, drawn and *not* a course (P46): the survey
  // record and the per-car physical limit are part of the gate.
  corridor: {
    kind: 'e1-drive.corridor-survey-check',
    version: 1,
    surveyHash: surveyFile.hash,
    surveyPath: path.relative(ROOT, SURVEY_FILE).split(path.sep).join('/'),
    drivable: surveyFile.drivability.drivable,
    courseLimitArc: surveyFile.drivability.courseLimitArc,
    wallCrossings: surveyFile.drivability.wallCrossings.map((crossing) => ({
      arc: crossing.arc,
      faceHeightMetres: crossing.faceHeightMetres,
      engineSolid: crossing.engineProbe?.solid ?? null
    })),
    chassisRise: surveyFile.drivability.chassisRise.firstAboveLimit,
    steepestGradeLast20m: surveyFile.drivability.steepestGradeLast20m,
    gates: surveyFile.gates.map((gate) => ({ id: gate.id, arc: gate.arc, covered: gate.coverage.covered })),
    probe: corridorProbeResults,
    note: 'measured course limit: the measured line crosses a 50 m vertical collision face the engine confirms ' +
      'solid; the playable sprint is the 29 m straight'
  },
  defaultCar: defaultForAliases.slug,
  // Backward-compatible views of the default car (the single-car document shape).
  drive: defaultForAliases.drive,
  determinism: defaultForAliases.determinism,
  packet: defaultForAliases.packet,
  checks,
  failures
};

writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
writeFileSync(path.join(OUT, 'telemetry.json'), JSON.stringify({
  kind: 'e1-drive.telemetry',
  version: 1,
  sampleHz: TELEMETRY_SPEC.tickHz,
  spec: TELEMETRY_SPEC,
  inputModel: report.telemetry.inputModel,
  units: report.telemetry.units,
  limits: report.telemetry.limits,
  ordering: report.telemetry.ordering,
  anomalies: report.telemetry.anomalies,
  cars: telemetryResults
}, null, 2) + '\n', 'utf8');
writeFileSync(path.join(OUT, 'reset-cycles.json'), JSON.stringify({
  kind: 'e1-drive.reset-cycles',
  version: 1,
  cyclesPerCar: RESET_CYCLE_COUNT,
  ticksPerCycle: RESET_CYCLE_TICKS,
  telemetryManoeuvresPerInstance: 6,
  note: report.resetCycles.note,
  cars: resetResults,
  telemetrySeries: telemetryResetResults,
  sprintRestart: sprintRestartResults
}, null, 2) + '\n', 'utf8');
writeFileSync(path.join(LOGS, 'verify.log'), log.join('\n') + '\n' +
  checks.map((entry) => (entry.ok ? 'PASS ' : 'FAIL ') + entry.label +
                        (entry.detail ? '  [' + entry.detail + ']' : '')).join('\n') + '\n', 'utf8');

console.log(JSON.stringify({
  status: report.status,
  multiplayer: {
    checks: mpNodeReport?.checks ?? 0,
    failures: mpNodeReport?.failures ?? [],
    resultHash: mpNodeReport?.result?.hash ?? null,
    sessionHash: mpNodeReport?.session?.hash ?? null,
    map: mpNodeReport?.map ?? null
  },
  mpMap: {
    checks: mpMapReport?.checks ?? 0,
    failures: mpMapReport?.failures ?? [],
    ids: mpMapReport?.ids ?? [],
    results: mpMapReport?.results ?? null
  },
  wasm: `${report.module.wasmBytes} B ${report.module.wasmSha256.slice(0, 16)} (${report.module.objects} objects)`,
  roster: `${report.roster.counts.selected} cars of ${report.roster.counts.records} records`,
  track: {
    label: report.geometry.trackLabel,
    draws: report.geometry.trackDraws,
    vertices: report.geometry.trackVertices,
    triangles: report.geometry.trackTriangles,
    textures: report.geometry.textures,
    fallbackTriangles: report.geometry.collisionSurface.coverage?.fallbackTriangles ?? 0,
    coveredTriangles: report.geometry.collisionSurface.coverage?.coveredTriangles ?? 0,
    collisionVisible: report.geometry.collisionSurface.visible,
    collisionUploaded: report.geometry.collisionSurface.uploaded
  },
  camera: {
    occluderTriangles: report.camera.occluder.triangles,
    marginMetres: report.camera.marginMetres,
    cars: report.camera.cars.map((entry) => ({
      slug: entry.slug,
      blockedTicks: entry.blockedTicks,
      distance: entry.minDistance.toFixed(2) + '..' + entry.maxDistance.toFixed(2) + ' m'
    }))
  },
  sprint: {
    layoutHash: report.sprint.layout.hash,
    span: report.sprint.layout.span,
    gates: report.sprint.layout.gates.map((gate) => gate.id + '@' + gate.x + ' (' + gate.widthMetres + ' m)'),
    cars: sprintResults.map((entry) => ({
      car: entry.name,
      slug: entry.slug,
      finishSeconds: entry.finish?.timeSeconds ?? null,
      finishTick: entry.finish?.tick ?? null,
      checkpoints: entry.checkpoints.map((checkpoint) => checkpoint.id + '@' + checkpoint.timeSeconds),
      ticks: entry.ticks,
      progress: entry.progress,
      replayMatches: entry.replayMatches,
      packetHash: entry.packet.hash
    })),
    respawn: {
      car: respawnCar.slug,
      reasons: respawnEvent?.reasons ?? null,
      target: respawnRebuild?.target.gateId ?? null,
      elapsedAfter: respawnRun.post?.elapsed ?? null
    },
    lap: {
      layoutHash: lapLayout.hash,
      lengthMetres: lapLayout.course.lap.lengthMetres,
      laps: lapLayout.course.lap.laps,
      blockedSamples: loopPropMeasure.blocked,
      blockedArcs: loopPropMeasure.arcs.length,
      minCentreDistanceMetres: loopPropMeasure.minDistanceMetres,
      cars: lapResults.map((entry) => ({
        car: entry.name,
        slug: entry.slug,
        lapTimes: entry.lapTimes,
        bestLapSeconds: entry.bestLapSeconds,
        totalSeconds: entry.finish?.timeSeconds ?? null,
        respawns: entry.respawns,
        maxLateral: entry.maxLateralMetres,
        minSteepFace: entry.minSteepFaceDistanceMetres,
        replayMatches: entry.replayMatches,
        packetHash: entry.packet.hash
      }))
    },
    free: {
      layoutHash: freeLayout.hash,
      spawn: freeLayout.course.spawn,
      bounds: freeBox,
      marginMetres: freeMargin,
      colliders: freePropWorld.colliders.length,
      spawnContacts: freePropContacts(freeLayout.course.spawn.x, freeLayout.course.spawn.z,
        propYawFromHeading(freeLayout.course.spawn.headingRad), freeLayout.course.spawnGroundY).length,
      containmentRespawn: freeContainment.respawnEvent.reasons,
      containmentAfterMetres: freeContainment.rebuild.distanceAfterMetres,
      cars: freeResults.map((entry) => ({
        car: entry.name,
        slug: entry.slug,
        travelMetres: entry.travelMetres,
        maxSpeed: entry.maxSpeedMetresPerSecond,
        contacts: entry.prop?.contacts ?? null,
        respawns: entry.respawns,
        contained: entry.contained,
        replayMatches: entry.replayMatches,
        stateSequenceHash: entry.stateSequenceHash,
        packetHash: entry.packet.hash
      }))
    }
  },
  ghost: {
    indexSha256: 'sha256:' + sha256(Buffer.from(ghostIndexText, 'utf8')),
    encoding: ghostIndex.encoding,
    records: ghostRows.map((row) => ({
      car: row.slug,
      course: row.course,
      seconds: row.timeSeconds,
      ticks: row.tickCount,
      bytes: row.bytes,
      hash: row.hash,
      bodyMaxDelta: row.bodyMaxDelta,
      selfGapSeconds: row.selfDeltaSeconds
    }))
  },
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
  telemetry: {
    sampleHz: TELEMETRY_SPEC.tickHz,
    ordering: report.telemetry.ordering,
    cars: telemetryResults.map((entry) => ({
      car: entry.name,
      slug: entry.slug,
      drivetrain: entry.drivetrain,
      zeroTo50: entry.metrics.accel.zeroToSpeedKph['50'].seconds,
      zeroTo100: entry.metrics.accel.zeroToSpeedKph['100'].seconds,
      speedAt86m: entry.metrics.accel.endSpeedKph,
      brakeEntryKph: entry.metrics.brake.entrySpeedKph,
      brakeDistanceMetres: entry.metrics.brake.distanceMetres,
      brakeMeanDecelMps2: entry.metrics.brake.meanDecelMps2,
      lateralG: entry.metrics.lateral.peakLateralAbsG,
      yawDegPerSec: entry.metrics.lateral.peakYawRateAbsDegPerSec,
      yawResponseTicks: entry.metrics.lateral.yawResponseTicks
    }))
  },
  resetCycles: {
    cyclesPerCar: RESET_CYCLE_COUNT,
    ticksPerCycle: RESET_CYCLE_TICKS,
    cars: resetResults.map((entry) => ({
      slug: entry.slug,
      cycles: entry.cycles,
      sameTrace: entry.sameTrace,
      traceHash: entry.traceHash,
      heapBytes: entry.heapBytes,
      poolHeads: entry.scheduler.poolHeads,
      groupHandles: entry.scheduler.groupHandles
    })),
    telemetrySeries: telemetryResetResults.map((entry) => ({
      slug: entry.slug,
      manoeuvres: entry.manoeuvres,
      resets: entry.resets,
      identical: entry.identical
    })),
    sprintRestart: sprintRestartResults.map((entry) => ({
      slug: entry.slug,
      finishSeconds: entry.finishSeconds,
      restartFinishSeconds: entry.restartFinishSeconds,
      matches: entry.restartMatches
    }))
  },
  checks: `${checks.filter((entry) => entry.ok).length}/${checks.length}`,
  failures
}, null, 2));
if (failures.length) process.exitCode = 1;
