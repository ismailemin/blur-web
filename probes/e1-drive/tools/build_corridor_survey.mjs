// Build the corridor survey artifact for the E1 drive slice.
//
//   node probes/e1-drive/tools/build_corridor_survey.mjs
//
// Inputs (read-only, both pinned by the verifier):
//   _work/e1-drive/course.json     the measured 539.81 m corridor (build_course.mjs)
//   _work/e1-drive/geometry.json   the merged real track visual + hidden collision surface
// Outputs (never committed):
//   _work/e1-drive/corridor-survey.json       the measured record, canonical hash
//   _work/e1-drive/corridor-survey.html       the same record as a labelled survey page
//
// The survey exists because the corridor is *not* a race course: its measured line
// crosses vertical collision faces. The tool only measures; the verifier re-derives
// the record and compares it byte for byte, so a hand-edited survey is a failure.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildCorridorSurvey } from '../web/corridor-survey.js';
import { TICK0_LIMITS } from './spawn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORK = path.join(ROOT, '_work/e1-drive');
const GEOMETRY = path.join(WORK, 'geometry.json');
const COURSE = path.join(WORK, 'course.json');
const MODULE = path.join(WORK, 'module/e1_drive.mjs');
const ROSTER = path.join(WORK, 'cars.json');
const LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics');
const OUT = path.join(WORK, 'corridor-survey.json');
const HTML = path.join(WORK, 'corridor-survey.html');

for (const [file, hint] of [[GEOMETRY, 'node probes/e1-drive/tools/build_geometry.mjs'],
  [COURSE, 'node probes/e1-drive/tools/build_course.mjs'],
  [MODULE, 'node probes/e1-drive/tools/build_module.mjs']]) {
  if (!existsSync(file)) throw new Error('missing ' + path.relative(ROOT, file) + ' - run `' + hint + '` first');
}

// The engine's own ray query confirms which geometric wall crossings are solid.
// The survey uses one fresh module instance and the roster's default car (any car
// builds the same static world; the car never moves).
const roster = JSON.parse(readFileSync(ROSTER, 'utf8'));
const defaultCar = roster.roster.cars.find((car) => car.default) ?? roster.roster.cars[0];
const fieldBytes = readFileSync(path.join(ROOT, defaultCar.fields.path));
const levelBytes = readFileSync(LEVEL);
const factory = (await import(pathToFileURL(MODULE).href)).default;
const module = await factory();
const levelPtr = module._malloc(levelBytes.length);
const fieldsPtr = module._malloc(fieldBytes.length + 1);
module.HEAPU8.set(levelBytes, levelPtr);
module.HEAPU8.set(fieldBytes, fieldsPtr);
if (!module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                       TICK0_LIMITS.x, TICK0_LIMITS.z, TICK0_LIMITS.heading)) {
  throw new Error('e1_create failed: ' + module.UTF8ToString(module._e1_last_error()));
}
const probe = (x, y, z, dx, dy, dz, distance) => JSON.parse(module.UTF8ToString(
  module._e1_ray_probe(x, y, z, dx, dy, dz, distance)));

const geometryBytes = readFileSync(GEOMETRY);
const geometry = JSON.parse(geometryBytes.toString('utf8'));
const courseBytes = readFileSync(COURSE);
const course = JSON.parse(courseBytes.toString('utf8'));
const spawn = existsSync(path.join(WORK, 'spawn.json'))
  ? JSON.parse(readFileSync(path.join(WORK, 'spawn.json'), 'utf8'))
  : { x: TICK0_LIMITS.x, z: TICK0_LIMITS.z, heading: TICK0_LIMITS.heading, source: TICK0_LIMITS.source };

const survey = buildCorridorSurvey(geometry, course, spawn, { probe });
const text = JSON.stringify(survey, null, 2) + '\n';
writeFileSync(OUT, text, 'utf8');

const escape = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const crossingRows = survey.drivability.wallCrossings.map((crossing) => `
      <tr><td>${crossing.arc.toFixed(2)}</td>
        <td>${crossing.x.toFixed(2)}, ${crossing.z.toFixed(2)}</td>
        <td>${crossing.faceHeightMetres.toFixed(1)}</td>
        <td>${crossing.faceNormal.map((value) => value.toFixed(3)).join(', ')}</td></tr>`).join('');

const gateRows = survey.gates.map((gate) => `
      <tr><td>${escape(gate.id)}</td><td>${gate.arc.toFixed(2)}</td>
        <td>${gate.x.toFixed(2)}, ${gate.z.toFixed(2)}</td>
        <td>${gate.coverage.drawnSamples}/${gate.coverage.samples}</td>
        <td>${gate.coverage.collisionSamples}/${gate.coverage.samples}</td>
        <td>${gate.coverage.covered ? 'covered' : 'NOT COVERED'}</td></tr>`).join('');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>E1 River corridor survey — measured, not a course</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 62rem; color: #1b1b1f; }
  h1 { font-size: 1.35rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #ddd; font-variant-numeric: tabular-nums; }
  th { background: #f4f4f6; }
  .flag { background: #fff4e5; border-left: 4px solid #d97706; padding: .75rem 1rem; }
  code { background: #f4f4f6; padding: 0 .25rem; }
</style>
</head>
<body>
<h1>E1 River corridor survey</h1>
<p class="flag"><strong>Survey only.</strong> This 539.81 m corridor is a coverage
measurement of committed draw geometry, not a playable course. The measured line
crosses vertical collision faces; the first engine-confirmed crossing is at
<strong>${survey.drivability.courseLimitArc === null ? 'n/a' : survey.drivability.courseLimitArc.toFixed(2) + ' m'}</strong>
(the table below also records the geometric crossings the engine does not collide
with). The playable sprint in the E1 drive slice is the 29 m straight on the same
spawn.</p>

<h2>Measured gates (survey markers)</h2>
<table>
  <thead><tr><th>gate</th><th>arc (m)</th><th>point</th><th>drawn</th><th>collision</th><th>status</th></tr></thead>
  <tbody>${gateRows}</tbody>
</table>

<h2>Path segments that cross a vertical collision face</h2>
<table>
  <thead><tr><th>arc (m)</th><th>point</th><th>face height (m)</th><th>normal</th></tr></thead>
  <tbody>${crossingRows}</tbody>
</table>

<h2>Chassis and surface limits</h2>
<table>
  <thead><tr><th>measurement</th><th>value</th></tr></thead>
  <tbody>
    <tr><td>first rise above ${survey.drivability.chassisRise.limitMetres} m in a ${survey.drivability.chassisRise.windowMetres} m window</td>
      <td>${survey.drivability.chassisRise.firstAboveLimit === null ? 'none' :
        survey.drivability.chassisRise.firstAboveLimit.riseMetres.toFixed(2) + ' m at arc ' +
        survey.drivability.chassisRise.firstAboveLimit.arc.toFixed(2) + ' m (' +
        survey.drivability.chassisRise.firstAboveLimit.gradePercent.toFixed(1) + ' %)'}</td></tr>
    <tr><td>steepest local grade in the last 20 m</td>
      <td>${survey.drivability.steepestGradeLast20m.gradePercent.toFixed(1)} % at arc
        ${survey.drivability.steepestGradeLast20m.fromArc.toFixed(1)} m</td></tr>
    <tr><td>vertical collision faces in the corridor provenance</td>
      <td>${survey.drivability.verticalFaces}</td></tr>
    <tr><td>measured coverage gaps</td>
      <td>${survey.drivability.gaps.length} (${survey.drivability.gaps.map((gap) => gap.lengthMetres.toFixed(2)).join(', ')} m)</td></tr>
  </tbody>
</table>

<h2>Provenance</h2>
<table>
  <thead><tr><th>field</th><th>value</th></tr></thead>
  <tbody>
    <tr><td>course</td><td><code>${escape(survey.source.course)}</code></td></tr>
    <tr><td>course hash</td><td><code>${escape(survey.source.courseHash ?? '')}</code></td></tr>
    <tr><td>corridor sections</td><td>${escape(survey.corridor.totals.draws)} draws /
      ${escape(survey.corridor.totals.triangles)} triangles / ${escape(survey.corridor.totals.vertices)} vertices</td></tr>
    <tr><td>survey hash</td><td><code>${escape(survey.hash)}</code></td></tr>
  </tbody>
</table>
<p>Generated by <code>probes/e1-drive/tools/build_corridor_survey.mjs</code>. Limits and the
root cause: <code>docs/work/verification/T-007-ledge-fix.md</code>.</p>
</body>
</html>
`;
writeFileSync(HTML, html, 'utf8');

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
console.log(JSON.stringify({
  output: path.relative(ROOT, OUT).split(path.sep).join('/'),
  bytes: Buffer.byteLength(text, 'utf8'),
  fileSha256: 'sha256:' + sha256(Buffer.from(text, 'utf8')),
  html: path.relative(ROOT, HTML).split(path.sep).join('/'),
  htmlSha256: 'sha256:' + sha256(Buffer.from(html, 'utf8')),
  surveyHash: survey.hash,
  geometrySha256: 'sha256:' + sha256(geometryBytes),
  courseHash: course.hash,
  gates: survey.gates.map((gate) => gate.id + '@' + gate.arc.toFixed(2) + 'm ' +
    (gate.coverage.covered ? 'covered' : 'NOT COVERED')),
  wallCrossings: survey.drivability.wallCrossings.map((crossing) =>
    crossing.arc.toFixed(2) + 'm/' + crossing.faceHeightMetres.toFixed(1) + 'm face'),
  courseLimitArc: survey.drivability.courseLimitArc,
  chassisRise: survey.drivability.chassisRise.firstAboveLimit,
  steepestGradeLast20m: survey.drivability.steepestGradeLast20m
}, null, 2));
