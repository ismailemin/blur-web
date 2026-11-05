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
  LONG_COURSE_PATH, SHORT_COURSE_ID, deriveLongCourseLayout, deriveSprintLayout
} from '../web/sprint-layout.js';
import { TICK0_LIMITS } from './spawn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORK = path.join(ROOT, '_work/e1-drive');
const GEOMETRY = path.join(WORK, 'geometry.json');
const SPAWN = path.join(WORK, 'spawn.json');
const COURSE_PATH = path.join(ROOT, LONG_COURSE_PATH.file);
const OUT = path.join(WORK, 'sprint.json');
const OUT_SHORT = path.join(WORK, 'sprint-short.json');

if (!existsSync(GEOMETRY)) {
  throw new Error('missing _work/e1-drive/geometry.json — run `node probes/e1-drive/tools/build_geometry.mjs` first');
}
if (!existsSync(COURSE_PATH)) {
  throw new Error('missing ' + LONG_COURSE_PATH.file + ' — the P48 measured course is required for the default sprint');
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

const layouts = [
  { file: OUT, layout: deriveLongCourseLayout(geometry, spawn, coursePath) },
  { file: OUT_SHORT, layout: deriveSprintLayout(geometry, spawn, { courseId: SHORT_COURSE_ID }) }
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
    coverage: layout.course.coverage
      ? {
        samples: layout.course.coverage.samples,
        coveredSamples: layout.course.coverage.coveredSamples,
        coverageFraction: layout.course.coverage.coverageFraction,
        gaps: layout.course.coverage.gaps.length
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
  layouts: summary
}, null, 2));
