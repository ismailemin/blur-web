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
import { buildOccluder } from '../web/camera-occlusion.js';
import { PHASES, SCRIPT_TICKS, TICK_HZ, phaseAt, scriptedInput } from '../web/drive-script.js';
import {
  CHECKPOINT_FRACTIONS, COLUMN_STEP, GATE_SAMPLE_STEP, LONG_COURSE_PATH, SHORT_COURSE_ID,
  deriveLongCourseLayout, deriveSprintLayout, layoutStartHeading, validateSprintLayout
} from '../web/sprint-layout.js';
import { SPRINT_EVENT, createSprintRules, coursePosition } from '../web/sprint-rules.js';
import { SPRINT_SCRIPT_TICKS, SPRINT_PACKET_SCRIPT, respawnScriptInput, sprintScriptInput } from '../web/sprint-script.js';
import { createBestTimes } from '../web/sprint-best.js';
import {
  createWasmResetEngineSet, createWasmTelemetryEngineSet, runTelemetrySeries, summariseTelemetryMetrics,
  TELEMETRY_MANOEUVRE, TELEMETRY_MANOEUVRE_ORDER, TELEMETRY_SPEC, tickAtSpeedKph
} from '../web/telemetry.js';
import { buildCorridorSurvey } from '../web/corridor-survey.js';
import { LIMIT_STATIONS, runLimitStation, stationPose, writeCorridorProbe } from './corridor_probe.mjs';
import { TICK0_LIMITS } from './spawn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, '_work/e1-drive');
const LOGS = path.join(ROOT, '_work/logs/e1-drive');
const MODULE = path.join(OUT, 'module/e1_drive.mjs');
const BUILD = path.join(OUT, 'module/build.json');
const GEOMETRY = path.join(OUT, 'geometry.json');
const TRACK_TEXTURE_MANIFEST = path.join(OUT, 'track-textures.json');
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
check('geometry carries one real body per roster car (v6)',
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
check('geometry carries the real track visual from committed direct draws (v6)',
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

// ------------------------------------------- per-car albedo textures + UV0
// P52 resolved every draw of the five roster cars to its committed material row
// and decoded the static `g_MeshTexture` images (224 of 491 draws). This pass
// binds those images to the real car meshes. The checks below fail if a texture,
// a UV0 stream or a runtime-only label is lost, or if a texture is attached to a
// draw whose UVs did not produce its recorded UV0 hash.
const CAR_TEXTURE_MANIFEST = path.join(OUT, 'car-textures.json');
const carTextureManifest = JSON.parse(readFileSync(CAR_TEXTURE_MANIFEST, 'utf8'));
const carTextureTotals = geometry.carTextures?.totals ?? {};
const CAR_DRAW_CLASSES = {
  staticAlbedoDraws: 224, runtimePaintDraws: 45, runtimeLightBlendDraws: 66, runtimeNoAlbedoDraws: 156
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

check('the car texture manifest is pinned, complete and carries the P52 totals',
      carTextureManifest.kind === 'e1-drive.car-textures' && carTextureManifest.version === 1 &&
      carTextureManifest.pins?.p52RosterIndex ===
        'sha256:77e73bfff8e324459d337f9ec1817f717e39aabfe0134433ca886c2a1774cd76' &&
      carTextureManifest.pins?.carPartsIndex === geometry.source.cars?.indexSha256 &&
      carTextureManifest.cars.length === rosterSlugs.length &&
      carTextureManifest.cars.every((car, index) => car.slug === rosterSlugs[index]) &&
      carTextureManifest.totals.draws === 491 && carTextureManifest.totals.textures === 40 &&
      carTextureManifest.totals.rgbaBytes === 18178048 &&
      geometry.carTextures?.manifestSha256 === 'sha256:' +
        sha256(readFileSync(CAR_TEXTURE_MANIFEST)),
      `${carTextureManifest.totals?.draws} draws / ${carTextureManifest.totals?.textures} textures`);

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
      carTextureTotals.uvBytes === 1257960 && carTextureTotals.uvValues === 314490,
      `${carTextureTotals.uvValues} UV values / ${carTextureTotals.uvBytes} B across 5 cars`);

check('224 car draws sample a P52 static albedo image; 267 stay labelled diagnostic',
      carDrawsAll.length === 491 && carTexturedDraws.length === 224 &&
      carDrawsAll.filter((draw) => draw.textureBinding?.status === 'runtimePaintLookup').length === 45 &&
      carDrawsAll.filter((draw) => draw.textureBinding?.status === 'runtimeLightBlend').length === 66 &&
      carDrawsAll.filter((draw) => draw.textureBinding?.status === 'runtimeShaderNoAlbedo').length === 156 &&
      carDrawsAll.every((draw) => ['boundStaticAlbedoImage', 'runtimePaintLookup', 'runtimeLightBlend',
        'runtimeShaderNoAlbedo'].includes(draw.textureBinding?.status)) &&
      carDrawsAll.filter((draw) => draw.textureId === null)
        .every((draw) => typeof draw.textureBinding?.reason === 'string' && draw.textureBinding.reason.length > 20),
      `${carTexturedDraws.length} textured / 45 paint / 66 light / 156 no-albedo`);

check('the 40 car textures are unique, per-car and traced to their P52 source',
      carTexturesAll.length === 40 && carTextureIds.size === 40 &&
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
              texture.drawCount > 0;
          });
      }),
      carBodies.map((body) => body.slug + ':' + body.textures.length).join(', '));

check('every embedded car RGBA payload re-hashes to the committed P52 image',
      carTexturesAll.reduce((sum, texture) => sum + texture.rgbaBytes, 0) === 18178048 &&
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
      carTexturedDraws.length === 224 && carTexturedDraws.every((draw) => {
        const body = carBodies.find((candidate) => candidate.carDraws.includes(draw));
        const record = body && carTextureManifest.cars
          .find((car) => car.slug === body.slug).draws[draw.source.drawIndex];
        if (!record || !body) return false;
        return record.textureId === draw.textureId &&
          record.uvHash === draw.textureBinding.uvHash &&
          '0x' + carDrawUvHash(body, draw) === draw.textureBinding.uvHash &&
          carTextureIds.has(draw.textureId);
      }),
      '224/224 UV0 value hashes recomputed from the mesh stream');

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
      '224/224 draws inside the exported UV0 bounds (constant-UV decal draws included)');

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
      geometry.carTextures?.uvConvention?.sampleV === '1 - uv0.v' &&
      /V-down/.test(geometry.carTextures.uvConvention.reason ?? '') &&
      carTexturedDraws.every((draw) => draw.uvFlipV === true &&
        draw.textureBinding?.uvConvention === 'sampled as (u, 1 - v)') &&
      carDrawsAll.filter((draw) => draw.textureId == null).every((draw) => draw.uvFlipV === false) &&
      trackDraws.every((draw) => draw.uvFlipV !== true) &&
      carTextureManifest.uvConvention?.evidence?.length === 3,
      `${carTexturedDraws.length} car draws sampled (u, 1-v), ${trackDraws.length} track draws unchanged`);

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
for (const file of [SPRINT_FILE, SPRINT_SHORT_FILE]) {
  if (!existsSync(file)) {
    throw new Error(path.basename(file) + ' missing — run `node probes/e1-drive/tools/build_sprint.mjs` first');
  }
}
const sprintFileBytes = readFileSync(SPRINT_FILE);
const sprintFile = JSON.parse(sprintFileBytes.toString('utf8'));
const sprintShortBytes = readFileSync(SPRINT_SHORT_FILE);
const sprintShortFile = JSON.parse(sprintShortBytes.toString('utf8'));
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

/** Replay a recorded input sequence without sprint rules: physics must not know. */
async function replaySprintInputs(car, fieldBytes, inputs, layout = derivedLayout) {
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  const module = await factory();
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const created = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                                    TICK0_LIMITS.x, TICK0_LIMITS.z, layoutStartHeading(layout, layoutSpawn));
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
  const factory = (await import(pathToFileURL(MODULE).href)).default;
  const module = await factory();
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const t0 = Date.now();
  const created = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                                    TICK0_LIMITS.x, TICK0_LIMITS.z, layoutStartHeading(layout, layoutSpawn));
  if (!created) throw new Error(`sprint e1_create failed for ${car.name}: ` + module.UTF8ToString(module._e1_last_error()));
  const createMs = Date.now() - t0;

  const rules = createSprintRules(layout);
  const state0 = JSON.parse(module.UTF8ToString(module._e1_get_state()));
  const session = createSession(geometry, state0, {
    spawn: { x: TICK0_LIMITS.x, z: TICK0_LIMITS.z, headingRad: layoutStartHeading(layout, layoutSpawn), source: TICK0_LIMITS.source },
    script: SPRINT_PACKET_SCRIPT,
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
  const rows = [{
    tick: 0, phase: rules.phase, elapsedTicks: rules.elapsedTicks, elapsedSeconds: rules.elapsedSeconds,
    speed: state0.speed, position: state0.position, progress: 0, stateHash: hashOfLocal(state0)
  }];
  const startMs = Date.now();
  let previous = state0;
  for (let tick = 1; tick <= SPRINT_SCRIPT_TICKS; tick++) {
    const input = sprintScriptInput(rules, previous);
    inputs.push(input);
    module._e1_set_input(input[0], input[1], input[2], input[3]);
    if (!module._e1_step()) throw new Error(`sprint e1_step failed for ${car.name} at tick ${tick}`);
    const state = JSON.parse(module.UTF8ToString(module._e1_get_state()));
    session.appendState(state);
    states.push(state);
    const tickEvents = rules.step(state);
    events.push(...tickEvents);
    const snapshot = rules.snapshot(state);
    rows.push({
      tick, phase: rules.phase, elapsedTicks: rules.elapsedTicks, elapsedSeconds: rules.elapsedSeconds,
      speed: state.speed, position: state.position, progress: snapshot.progress, stateHash: hashOfLocal(state)
    });
    previous = state;
    if (rules.phase === 'finished' && state.tick - rules.finishTick >= 120) break;
  }
  const simMs = Date.now() - startMs;
  const packet = session.finalise();
  return {
    module, rules, states, inputs, events, rows, packet, createMs, simMs,
    finish: events.find((event) => event.type === SPRINT_EVENT.FINISH) ?? null,
    checkpoints: events.filter((event) => event.type === SPRINT_EVENT.CHECKPOINT),
    go: events.find((event) => event.type === SPRINT_EVENT.GO) ?? null,
    respawns: events.filter((event) => event.type === SPRINT_EVENT.RESPAWN)
  };
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
  check(`${car.name}: the packet uploads the 136 track textures plus only this car's own images`,
        packet.textures.length === 136 + packetCarTextures.length &&
        packetTextureIds.size === packet.textures.length &&
        packet.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0) ===
          439360 + packetCarTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0) &&
        packet.carTexturePack?.manifestSha256 === geometry.carTextures.manifestSha256,
        `${packet.textures.length} textures / ` +
        `${packet.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0)} B`);
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
  // exception, no hit before the stored eye. This is the screenshot gate.
  const CAPTURE_TICKS = [0, 150, 240, 300];
  const captureRows = CAPTURE_TICKS.map((tick) => cameraRows.find((row) => row.tick === tick));
  check(`${car.name}: the four captured ticks are fully clear (no near-field exception)`,
        captureRows.every((row) => row && row.clear && !row.nearField),
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

// ------------------------------------------------------------- sprint runs
// Each roster car runs the deterministic sprint in its own fresh module. The
// rules observe the physics; the recorded input sequence is replayed into
// another fresh module with the rules switched off, and the two state hash
// sequences must be identical — that is the proof that the race rules did not
// change the simulation.
const sprintResults = [];
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

  const sprintValidation = validatePacket(run.packet);
  check(`${car.name}: the sprint produces a valid packet v1.1 timeline`,
        sprintValidation.ok === true && run.packet.updates.length === run.states.length,
        sprintValidation.errors.slice(0, 4).join(' | '));
  check(`${car.name}: the sprint packet carries the sprint script label and nine matrices per tick`,
        run.packet.diagnostics.extras.drive.script === SPRINT_PACKET_SCRIPT &&
        run.packet.updates.every((update) => update.matrices.length === 9),
        run.packet.diagnostics.extras.drive.script);

  const sprintRunPath = path.join(OUT, `sprint-${car.slug}.json`);
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
    runPath: path.relative(ROOT, shortRunPath).split(path.sep).join('/')
  });
}

// ------------------------------------------------------------- telemetry
// Three deterministic manoeuvres per car. Each manoeuvre runs in its own fresh
// wasm module instance (this build cannot rebuild one instance more than about
// three times), the whole series is run twice in two independent instance sets,
// and the recorded input sequence is replayed into a third set. The analysis
// only reads the state the engine reports.
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
                          TICK0_LIMITS.x, TICK0_LIMITS.z, layoutStartHeading(layout, layoutSpawn));
    if (!ok) throw new Error(`${car.name}: sprint ${restart ? 'restart' : 'create'} failed: ` +
                             module.UTF8ToString(module._e1_last_error()));
    const rules = createSprintRules(layout);
    const state0 = read();
    rules.prime(state0);
    const hashes = [hashOfLocal(state0)];
    const inputs = [];
    const events = [];
    let previous = state0;
    for (let tick = 1; tick <= SPRINT_SCRIPT_TICKS; tick++) {
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

// Every car's drive and sprint state sequence hash. The drive and 29 m sprint
// (`sprintShort`) anchors are the P36/P37 values: physics, cars, camera and
// telemetry did not move. `sprint310` is the new default 310 m timeline, so its
// state sequence is a new anchor (the course changed, not the physics).
//
// The `packet` anchor is the whole-packet hash, so it moves whenever the static
// packet body changes; P49 added the real UV0 and static albedo texture payloads
// (geometry v5) and P55 added the P52 per-car albedo textures + car UV0 stream
// (geometry v6), so these values are the P55 geometry. Physics did not move: the
// drive/sprint state sequence anchors below are still P36/P37.
const PHYSICS_ANCHORS = Object.freeze({
  'corvette-zr1-stock': {
    drive: 'sha256:83f765902ce5c610889e8a27e9bfe747f86142bddea24ecb987b29be29008e1f',
    packet: 'sha256:746853ba37601ce7879eb5f1cc7ce2e44cc6a7ad795f1dfc2c45d3b2f7fa57ff',
    sprint310: 'sha256:da7e14f16be2649f32902d18cc999cd39af09320d4e4b24ec40a37c086f9a553',
    sprintShort: 'sha256:fdd893bded1693d801ca1ff49cf40a35b095cf17a9359803408db6b2d2e62622'
  },
  'lotus-exige-cup260-stock': {
    drive: 'sha256:8d6cd4d456e5ddc47dc21d50f417134298cb366fd1c3a486b80d844e0dac66c2',
    packet: 'sha256:8b9ef8d0eae6cf48b82110c8ca6b17845e8796802da259c78534edf295a35ab0',
    sprint310: 'sha256:83f05df48244c000889b4d1adcc83afe34a98f5b65370de3d87419448a92367e',
    sprintShort: 'sha256:c9b1739765b65dedf9256ac634ff76fcf3aac8be6c1bac24c91b1b6dedb52dfc'
  },
  'dodge-challenger-stock': {
    drive: 'sha256:b1c63d209a55c974662d87a83f03568db4de981730ddf08dd409074a7220a7e2',
    packet: 'sha256:3b21364b00158226dabea4f43568f94a38c9b79d40295f42043e9153a32aeb16',
    sprint310: 'sha256:accf125a629dbf7f66e7dbed2d38990fb21c67ad26a65fbef288e3716ac8210a',
    sprintShort: 'sha256:438e2e1278c77b34139dae587e495e3b81745416f7d8ef0c83913d4c75e12684'
  },
  'ford-focusrs-stock': {
    drive: 'sha256:fb3909b6fdcc32e6a710a57ab092c0523641ee6c76e9c82cdcbb7bee02c9bdb6',
    packet: 'sha256:b92c105301ae00c37b01551cebe28412360ff30536953ecbbbe383e2e89ac9e7',
    sprint310: 'sha256:1094698d566bf3a6f335545ea37089113874c21d2f438a059d2c95e3d9f2063f',
    sprintShort: 'sha256:cc911ea325e524011cd773f84afd397b18e3bea7c1202dfe0b361f13332af937'
  },
  'audi-r8v10-stock': {
    drive: 'sha256:5b4ae49dc38fc8e9c2ff2f8292739f1e07b2945dbb3a9a02dae9993724fd4067',
    packet: 'sha256:fb23b0cc460acc6341b0a9bafdde6f293d7cb964b822360ebe2165bfbe701f01',
    sprint310: 'sha256:0b32413d797b23b0db957f2583ab221fe3e64388144d743b8d20e2b39f14b5ca',
    sprintShort: 'sha256:d52d4b8f69e4741b375aa13bb90a0b699128c9bdae80614e97df7facef444dea'
  }
});

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
  check(`${car.name}: braking from ${TELEMETRY_SPEC.brake.entrySpeedKph} km/h stops inside the measured strip`,
        brake.brakeTick === independentTicks['80'] && brake.stopped === true &&
        brake.entrySpeedKph >= TELEMETRY_SPEC.brake.entrySpeedKph - 0.5 &&
        brake.entrySpeedKph <= TELEMETRY_SPEC.brake.entrySpeedKph + 1.5 &&
        brake.distanceMetres > 5 && brake.distanceMetres < 40 &&
        brake.meanDecelMps2 > 4 && brake.meanDecelMps2 < 20 &&
        brake.peakDecelMps2 >= brake.meanDecelMps2 &&
        brake.contactTicks === brake.ticks && brake.nanTicks === 0,
        `${brake.entrySpeedKph} -> ${brake.stopSpeedMps} m/s in ${brake.brakingTimeSeconds} s / ` +
        `${brake.distanceMetres} m, mean ${brake.meanDecelMps2} peak ${brake.peakDecelMps2} m/s2`);
  const consistentReversals = lateral.reversals.every((entry) =>
    entry.lagTicks !== null && entry.lagTicks > 0 && entry.lagTicks <= 60);
  check(`${car.name}: the steering sweep measures peak lateral acceleration and a consistent yaw response`,
        lateral.peakLateralAbsG > 0.2 && lateral.peakLateralAbsG < 2.5 &&
        lateral.peakYawRateAbsDegPerSec > 5 && lateral.peakYawRateAbsDegPerSec < 90 &&
        lateral.yawSignPerSteerSign !== 0 &&
        lateral.steerReversals > 0 && lateral.yawSignChanges === lateral.steerReversals &&
        consistentReversals &&
        lateral.contactTicks === lateral.ticks && lateral.nanTicks === 0,
        `${lateral.peakLateralAbsG} g, ${lateral.peakYawRateAbsDegPerSec} deg/s, ` +
        `${lateral.yawSignChanges}/${lateral.steerReversals} reversals answered in ` +
        `${lateral.yawResponseTicks} ticks, ${lateral.contactTicks}/${lateral.ticks} contact`);
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

check('telemetry: every car produces a distinct state sequence in every manoeuvre',
      new Set(telemetryResults.map((entry) => TELEMETRY_MANOEUVRE_ORDER
        .map((manoeuvre) => entry.hashes[manoeuvre].aggregate).join('|'))).size === telemetryResults.length &&
      TELEMETRY_MANOEUVRE_ORDER.every((manoeuvre) =>
        new Set(telemetryResults.map((entry) => entry.hashes[manoeuvre].aggregate)).size === telemetryResults.length),
      telemetryResults.map((entry) => entry.slug).join(', '));
if (telemetryResults.some((entry) => entry.drivetrain === 'AWD') &&
    telemetryResults.some((entry) => entry.drivetrain === 'FWD')) {
  const awd = telemetryResults.find((entry) => entry.drivetrain === 'AWD');
  const fwd = telemetryResults.find((entry) => entry.drivetrain === 'FWD');
  check('telemetry: the AWD car is quickest to 100 km/h and the FWD car is slowest, as the drivetrain predicts',
        accelOrder[0] === awd.slug && accelOrder[accelOrder.length - 1] === fwd.slug,
        accelOrder.map((slug) => `${slug}:${telemetryBySlug.get(slug).metrics.accel.zeroToSpeedKph['100'].seconds}s`).join(', '));
}
check('telemetry: the 0-100 km/h order matches the XT torque-scale-to-mass order',
      rankDistance(accelOrder, torqueToMassOrder) <= 1,
      `measured ${accelOrder.join(' < ')} | torque/mass ${torqueToMassOrder.join(' < ')}`);
check('telemetry: the measured stopping order is within two places of the XT brake-to-mass order (a coarse plausibility gate)',
      rankDistance(brakeOrder, brakeToMassOrder) <= 2,
      `measured ${brakeOrder.map((slug) => `${slug}:${telemetryBySlug.get(slug).metrics.brake.distanceMetres}m`).join(', ')} | ` +
      `brake/mass ${brakeToMassOrder.join(' < ')}`);
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
        !/corvette_c3/i.test(entry.body.modelPakPath ?? '') &&
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
const audiResult = sprintResults.find((entry) => entry.drivetrain === 'AWD');
const fwdResult = sprintResults.find((entry) => entry.drivetrain === 'FWD');
if (audiResult && fwdResult) {
  check('the same sprint script separates the drivetrains (AWD fastest, FWD slowest)',
        audiResult.finish && fwdResult.finish &&
        sprintResults.every((entry) => entry === audiResult || !entry.finish ||
          entry.finish.timeSeconds > audiResult.finish.timeSeconds) &&
        sprintResults.every((entry) => entry === fwdResult || !entry.finish ||
          entry.finish.timeSeconds < fwdResult.finish.timeSeconds),
        sprintResults.map((entry) => `${entry.slug}:${entry.finish?.timeSeconds ?? 'DNF'}`).join(', '));
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
    restartCars: sprintRestartResults
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
      'is recorded rather than explained'
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
    }
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
