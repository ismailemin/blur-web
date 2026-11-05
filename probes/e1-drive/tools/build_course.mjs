// Derive the E1 sprint course line from the measured track-coverage corridor.
//
//   node probes/e1-drive/tools/build_course.mjs
//
// Inputs (read-only, both pinned by the hashes recorded in
// docs/work/analysis/track-coverage.md):
//   _work/track-coverage/corridor.json        measured corridor + canonical hash
//   _work/track-coverage/course_samples.json  exact 0.25 m samples of the course
// Output:
//   _work/e1-drive/course.json                the course line: length, samples,
//                                             sections and the three measured gaps
//
// No coordinate is typed in. This tool does not smooth, round or re-route the
// measured path: it copies every 0.25 m sample and accumulates its arc length.
// The sprint layout (web/sprint-layout.js) places gates on that measured line and
// re-measures their coverage against the real draws and the collision surface.
//
// Usage: node probes/e1-drive/tools/build_course.mjs

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashOf } from '../web/packet-hash.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CORRIDOR = path.join(ROOT, '_work/track-coverage/corridor.json');
const SAMPLES = path.join(ROOT, '_work/track-coverage/course_samples.json');
const OUT = path.join(ROOT, '_work/e1-drive/course.json');

// Recorded in docs/work/analysis/track-coverage.md §7 (file hash) and §4/§9
// (course length, coverage, canonical corridor hash). A different artifact is a
// hard failure: this slice must not build a course from an unmeasured path.
const EXPECTED = {
  corridorFileSha256: 'sha256:096c0751aa89570312647683c64f5c4b210701a2652528bc945cf712e7814aff',
  corridorHash: 'sha256:10e197c119a5edc79d7c54d1f5f728c4f1e2a8006a3e76d08caf0e0c8a349d0c',
  samplesSha256: 'sha256:fe44e27bcdd8b4f9b2b7745ab6a964e512fe9b59472d29d2e50dda937dbb1f76',
  lengthMetres: 539.808,
  sampleStepMetres: 0.25,
  sampleCount: 2257
};

const sha256 = (buffer) => 'sha256:' + createHash('sha256').update(buffer).digest('hex');
const round6 = (value) => Math.round(value * 1e6) / 1e6;

if (!existsSync(CORRIDOR)) {
  throw new Error('missing _work/track-coverage/corridor.json — run ' +
    '`python probes/track-coverage/tools/build_corridor.py` first');
}
if (!existsSync(SAMPLES)) {
  throw new Error('missing _work/track-coverage/course_samples.json — run ' +
    '`python probes/track-coverage/tools/build_corridor.py` first');
}

const corridorBytes = readFileSync(CORRIDOR);
const corridorFileSha = sha256(corridorBytes);
if (corridorFileSha !== EXPECTED.corridorFileSha256) {
  throw new Error('corridor.json is not the recorded artifact: ' + corridorFileSha +
    ' (expected ' + EXPECTED.corridorFileSha256 + ')');
}
const corridor = JSON.parse(corridorBytes.toString('utf8'));
if (corridor.kind !== 'track-coverage.corridor' || corridor.version !== 1) {
  throw new Error('corridor.json kind/version is not track-coverage.corridor v1');
}
if (corridor.hash !== EXPECTED.corridorHash) {
  throw new Error('corridor.json canonical hash is not the recorded one: ' + corridor.hash);
}
const course = corridor.course;
if (course.lengthMetres !== EXPECTED.lengthMetres) {
  throw new Error('measured course length ' + course.lengthMetres + ' m is not ' + EXPECTED.lengthMetres + ' m');
}

const sampleBytes = readFileSync(SAMPLES);
const sampleFileSha = sha256(sampleBytes);
if (sampleFileSha !== EXPECTED.samplesSha256) {
  throw new Error('course_samples.json is not the recorded artifact: ' + sampleFileSha +
    ' (expected ' + EXPECTED.samplesSha256 + ')');
}
const sampleDoc = JSON.parse(sampleBytes.toString('utf8'));
if (sampleDoc.kind !== 'track-coverage.course-samples' || sampleDoc.version !== 1) {
  throw new Error('course_samples.json kind/version is not track-coverage.course-samples v1');
}
if (sampleDoc.corridorHash !== corridor.hash) {
  throw new Error('course_samples.json does not belong to this corridor (' + sampleDoc.corridorHash + ')');
}
if (sampleDoc.sampleStepMetres !== EXPECTED.sampleStepMetres) {
  throw new Error('course samples are not at ' + EXPECTED.sampleStepMetres + ' m');
}
const samples = sampleDoc.samples;
if (samples.length !== EXPECTED.sampleCount) {
  throw new Error('course has ' + samples.length + ' samples, expected ' + EXPECTED.sampleCount);
}

// The measured start and finish are the corridor's, not the builder's.
if (samples[0].x !== course.start[0] || samples[0].z !== course.start[1]) {
  throw new Error('first course sample is not the measured start ' + course.start.join(', '));
}
if (samples[samples.length - 1].x !== course.finish[0] || samples[samples.length - 1].z !== course.finish[1]) {
  throw new Error('last course sample is not the measured finish ' + course.finish.join(', '));
}

// Arc length accumulated from the measured samples (the staircase path is not
// smoothed: every point is a measured 0.25 m sample).
const points = [];
let arc = 0;
for (let index = 0; index < samples.length; index++) {
  const sample = samples[index];
  if (index > 0) {
    const previous = samples[index - 1];
    arc += Math.hypot(sample.x - previous.x, sample.z - previous.z);
  }
  if (index > 0 && !(arc > points[index - 1].arc)) {
    throw new Error('course sample ' + index + ' does not advance the arc length');
  }
  points.push({
    index,
    x: sample.x,
    z: sample.z,
    arc: round6(arc),
    section: sample.section,
    covered: sample.covered === true,
    coll: sample.coll,
    vis: sample.vis
  });
}
if (Math.abs(arc - course.lengthMetres) > 1e-3) {
  throw new Error('sample arc ' + arc + ' m differs from the measured length ' + course.lengthMetres + ' m');
}

const covered = points.filter((point) => point.covered).length;
if (covered !== course.coveredSamples) {
  throw new Error('covered sample count ' + covered + ' differs from the measured ' + course.coveredSamples);
}

const document = {
  kind: 'e1-drive.course',
  version: 1,
  source: {
    level: corridor.source.level,
    corridor: '_work/track-coverage/corridor.json',
    corridorSha256: corridorFileSha,
    corridorHash: corridor.hash,
    samples: '_work/track-coverage/course_samples.json',
    samplesSha256: sampleFileSha,
    levelPhysics: corridor.source.levelPhysics,
    levelPhysicsSha256: corridor.source.levelPhysicsSha256,
    visual: corridor.source.visual,
    visualSha256: corridor.source.visualSha256,
    reader: corridor.source.reader,
    instancesApplied: corridor.source.instancesApplied,
    rule:
      'the course line is the measured track-coverage path at its exact 0.25 m samples; no smoothing, rounding, ' +
      're-routing or invented point is applied, and the arc length is accumulated from the samples themselves'
  },
  name: course.name,
  lengthMetres: course.lengthMetres,
  start: { x: points[0].x, z: points[0].z, groundY: course.startHeight },
  finish: { x: points[points.length - 1].x, z: points[points.length - 1].z, groundY: course.finishHeight },
  sampleStepMetres: sampleDoc.sampleStepMetres,
  sampleCount: points.length,
  coveredSamples: covered,
  coverageFraction: course.coverageFraction,
  gapTotalMetres: course.gapTotalMetres,
  maxHeightStepMetres: course.maxHeightStep,
  gaps: course.gaps.map((gap) => ({
    lengthMetres: gap.lengthMetres,
    start: gap.start,
    end: gap.end
  })),
  sectionMetres: course.sectionMetres,
  sections: Object.keys(course.sectionMetres).sort(),
  width: {
    minMetres: course.width.minMetres,
    medianMetres: course.width.medianMetres,
    meanMetres: course.width.meanMetres,
    stations: course.width.stations,
    atLeast3m: course.width.atLeast3m,
    atLeast6m: course.width.atLeast6m,
    rows: course.width.rows.map((row) => {
      let nearest = points[0];
      let nearestDistance = Infinity;
      for (const point of points) {
        const distance = Math.hypot(point.x - row.x, point.z - row.z);
        if (distance < nearestDistance - 1e-12) { nearest = point; nearestDistance = distance; }
      }
      return { arc: nearest.arc, x: row.x, z: row.z, widthMetres: row.widthMetres };
    })
  },
  samples: points
};
document.hash = hashOf(document);

const text = JSON.stringify(document) + '\n';
writeFileSync(OUT, text, 'utf8');

console.log(JSON.stringify({
  output: path.relative(ROOT, OUT).split(path.sep).join('/'),
  bytes: Buffer.byteLength(text, 'utf8'),
  fileSha256: sha256(Buffer.from(text, 'utf8')),
  hash: document.hash,
  source: {
    corridorSha256: corridorFileSha,
    samplesSha256: sampleFileSha
  },
  lengthMetres: document.lengthMetres,
  sampleCount: document.sampleCount,
  coveredSamples: document.coveredSamples,
  coverageFraction: document.coverageFraction,
  gaps: document.gaps,
  sectionMetres: document.sectionMetres,
  width: {
    minMetres: document.width.minMetres,
    medianMetres: document.width.medianMetres,
    atLeast6m: document.width.atLeast6m,
    stations: document.width.stations
  }
}, null, 2));
