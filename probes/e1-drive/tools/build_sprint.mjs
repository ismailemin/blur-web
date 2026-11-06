// Build the E1 drive sprint layouts.
//
//   node probes/e1-drive/tools/build_sprint.mjs
//
// Inputs (read-only):
//   _work/e1-drive/geometry.json        real track visual + collision surface
//   _work/e1-drive/spawn.json           the committed spawn (written by the verifier)
//   _work/drivable-path/path.json       P48 measured 310.395 m collision-clean path
// Outputs:
//   _work/e1-drive/sprint.json          the default 310 m course: gates, coverage, rules
//   _work/e1-drive/sprint-short.json    the 29 m regression course (unchanged layout rule)
//
// Every coordinate is derived in web/sprint-layout.js from the geometry and the
// pinned P48 path; this tool only loads, derives and writes. The verifier
// re-derives both layouts and compares them with the files, so a hand-edited
// sprint.json is a hard failure.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FREE_REGIONS_PATH, LAP_LOOPS_PATH, LONG_COURSE_PATH, SHORT_COURSE_ID, deriveFreeRoamLayout,
  deriveLapCourseLayout, deriveLongCourseLayout, deriveSprintLayout
} from '../web/sprint-layout.js';
import { FREE_PROP_PINS, checkPropManifest } from '../web/prop-layer.js';
import { createWorld } from '../../prop-collision/lib/resolver.mjs';
import { TICK0_LIMITS } from './spawn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORK = path.join(ROOT, '_work/e1-drive');
const GEOMETRY = path.join(WORK, 'geometry.json');
const SPAWN = path.join(WORK, 'spawn.json');
const COURSE_PATH = path.join(ROOT, LONG_COURSE_PATH.file);
const LOOPS_PATH = path.join(ROOT, LAP_LOOPS_PATH.file);
const REGIONS_PATH = path.join(ROOT, FREE_REGIONS_PATH.file);
const FREE_PROP_PATH = path.join(ROOT, FREE_PROP_PINS.manifest);
const OUT = path.join(WORK, 'sprint.json');
const OUT_SHORT = path.join(WORK, 'sprint-short.json');
const OUT_LAP = path.join(WORK, 'sprint-lap.json');
const OUT_FREE = path.join(WORK, 'sprint-free.json');

if (!existsSync(GEOMETRY)) {
  throw new Error('missing _work/e1-drive/geometry.json — run `node probes/e1-drive/tools/build_geometry.mjs` first');
}
if (!existsSync(COURSE_PATH)) {
  throw new Error('missing ' + LONG_COURSE_PATH.file + ' — the P48 measured course is required for the default sprint');
}
if (!existsSync(LOOPS_PATH)) {
  throw new Error('missing ' + LAP_LOOPS_PATH.file + ' — the P61 loop-01 course is required for the lap layout');
}
if (!existsSync(REGIONS_PATH)) {
  throw new Error('missing ' + FREE_REGIONS_PATH.file + ' — the P65 spawn basin is required for free roam');
}
if (!existsSync(FREE_PROP_PATH)) {
  throw new Error('missing ' + FREE_PROP_PINS.manifest + ' — the P68b collider manifest is required for free roam');
}
const geometryBytes = readFileSync(GEOMETRY);
const geometry = JSON.parse(geometryBytes.toString('utf8'));
const spawn = existsSync(SPAWN)
  ? JSON.parse(readFileSync(SPAWN, 'utf8'))
  : { x: TICK0_LIMITS.x, z: TICK0_LIMITS.z, heading: TICK0_LIMITS.heading, source: TICK0_LIMITS.source };

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const coursePathBytes = readFileSync(COURSE_PATH);
const coursePathSha = 'sha256:' + sha256(coursePathBytes);
if (coursePathSha !== LONG_COURSE_PATH.fileSha256) {
  throw new Error('the P48 course path is not the recorded artifact: ' + coursePathSha +
    ' (expected ' + LONG_COURSE_PATH.fileSha256 + ')');
}
const coursePath = JSON.parse(coursePathBytes.toString('utf8'));

const loopsBytes = readFileSync(LOOPS_PATH);
const loopsFileSha = 'sha256:' + sha256(loopsBytes);
if (loopsFileSha !== LAP_LOOPS_PATH.fileSha256) {
  throw new Error('the P61 loops artifact is not the recorded file: ' + loopsFileSha +
    ' (expected ' + LAP_LOOPS_PATH.fileSha256 + ')');
}
const loopsDoc = JSON.parse(loopsBytes.toString('utf8'));

const regionsBytes = readFileSync(REGIONS_PATH);
const regionsFileSha = 'sha256:' + sha256(regionsBytes);
if (regionsFileSha !== FREE_REGIONS_PATH.fileSha256) {
  throw new Error('the P65 regions artifact is not the recorded file: ' + regionsFileSha +
    ' (expected ' + FREE_REGIONS_PATH.fileSha256 + ')');
}
const regionsDoc = JSON.parse(regionsBytes.toString('utf8'));

const freePropBytes = readFileSync(FREE_PROP_PATH);
const freePropFileSha = 'sha256:' + sha256(freePropBytes);
if (freePropFileSha !== FREE_PROP_PINS.manifestFileSha256) {
  throw new Error('the P68b collider manifest is not the recorded file: ' + freePropFileSha +
    ' (expected ' + FREE_PROP_PINS.manifestFileSha256 + ')');
}
const freePropManifest = JSON.parse(freePropBytes.toString('utf8'));
const freePropCheck = checkPropManifest(freePropManifest, FREE_PROP_PINS);
if (!freePropCheck.ok) {
  throw new Error('the P68b collider manifest was rejected: ' + freePropCheck.errors.join('; '));
}
const freePropWorld = createWorld(freePropManifest, { profile: FREE_PROP_PINS.profile });
const freePropContacts = (x, z, yaw, baseY) =>
  freePropWorld.contactsAll(x, z, yaw, baseY, freePropManifest.carEnvelope);

const layouts = [
  { file: OUT, layout: deriveLongCourseLayout(geometry, spawn, coursePath) },
  { file: OUT_SHORT, layout: deriveSprintLayout(geometry, spawn, { courseId: SHORT_COURSE_ID }) },
  { file: OUT_LAP, layout: deriveLapCourseLayout(geometry, loopsDoc) },
  {
    file: OUT_FREE,
    layout: deriveFreeRoamLayout(geometry, spawn, regionsDoc, {
      propContacts: freePropContacts, carEnvelope: freePropManifest.carEnvelope
    })
  }
];

const summary = [];
for (const { file, layout } of layouts) {
  const text = JSON.stringify(layout, null, 2) + '\n';
  writeFileSync(file, text, 'utf8');
  summary.push({
    output: path.relative(ROOT, file).split(path.sep).join('/'),
    courseId: layout.courseId,
    bytes: Buffer.byteLength(text, 'utf8'),
    fileSha256: 'sha256:' + sha256(Buffer.from(text, 'utf8')),
    layoutHash: layout.hash,
    span: layout.course.span,
    bounds: layout.course.bounds ?? null,
    containment: layout.course.containment ?? null,
    coverage: layout.course.coverage
      ? {
        samples: layout.course.coverage.samples,
        coveredSamples: layout.course.coverage.coveredSamples ?? layout.course.coverage.covered,
        coverageFraction: layout.course.coverage.coverageFraction ?? layout.course.coverage.fraction,
        gaps: layout.course.coverage.gaps?.length ?? 0
      }
      : null,
    gates: layout.gates.map((gate) => ({
      id: gate.id,
      kind: gate.kind,
      arc: gate.arc ?? null,
      x: gate.x,
      z: gate.z,
      widthMetres: gate.widthMetres,
      headingRad: gate.headingRad ?? null,
      drawnSamples: gate.coverage.drawnSamples + '/' + gate.coverage.samples,
      collisionSamples: gate.coverage.collisionSamples + '/' + gate.coverage.samples,
      maxSurfaceDeltaMetres: gate.coverage.maxSurfaceDeltaMetres ?? null
    }))
  });
}

console.log(JSON.stringify({
  geometry: { file: '_work/e1-drive/geometry.json', sha256: 'sha256:' + sha256(geometryBytes) },
  coursePath: { file: LONG_COURSE_PATH.file, sha256: coursePathSha, hash: coursePath.hash },
  loops: { file: LAP_LOOPS_PATH.file, sha256: loopsFileSha, hash: loopsDoc.hash, loopId: LAP_LOOPS_PATH.loopId },
  regions: { file: FREE_REGIONS_PATH.file, sha256: regionsFileSha, hash: regionsDoc.hash },
  freeProp: { file: FREE_PROP_PINS.manifest, sha256: freePropFileSha, contentSha256: freePropManifest.contentSha256 },
  layouts: summary
}, null, 2));
