// Sprint layouts for the E1 drive slice.
//
// Two courses are derived here from measured data, never from a typed-in gate
// coordinate:
//
//  * `310m` (the default course) follows the P48 collision-only drivable path
//    (`_work/drivable-path/path.json`, 310.395 m, 1,245 samples at 0.25 m). That
//    path is the longest engine-clean collision channel from the spawn; P51
//    measured 100 % draw coverage from section `river.block56.node289` at the
//    car-width band. Gates sit on measured samples, their lines are perpendicular
//    to the local 5 m tangent, and the finish is 10 m before the measured end so
//    the car can stop before the surface narrows to 2.0 m.
//  * `short` (the 29 m regression course) is the original straight sprint under
//    the spawn corridor: the spawn z +/- `bandHalfWidth`, covered columns along
//    +X, finish 2 m before the last fully covered column.
//
// Everything below is derived from `geometry.json`, the spawn and (for the long
// course) the pinned P48 path artifact, never typed in as a coordinate.
//
// This module is shared by tools/build_sprint.mjs (writes sprint.json and
// sprint-short.json), tools/verify_e1_drive.mjs (re-derives and compares) and
// the page (validates the file it loads against its own hash and the reported
// coverage).

import { hashOf } from './packet-hash.js';

export const SPRINT_LAYOUT_KIND = 'e1-drive.sprint';
export const SPRINT_LAYOUT_VERSION = 1;

/** Default course (the measured 310.395 m P48 path). */
export const LONG_COURSE_ID = '310m';
/** Regression course (the original 29 m straight). */
export const SHORT_COURSE_ID = 'short';

/**
 * P48 course artifact pins. The long layout may only be built from this exact
 * file: a different path.json is a hard failure, never a silently different course.
 */
export const LONG_COURSE_PATH = Object.freeze({
  file: '_work/drivable-path/path.json',
  fileSha256: 'sha256:81eac0ce413075de33e2b3c0e1c077412b35002420b199d9f05d2fdeef230e7f',
  canonicalHash: 'sha256:4b725b10e6619e7cc2f3ef0b0ea03f3a252660a8ffaad0ffe04cb96e0318605b',
  lengthMetres: 310.3952,
  sampleStepMetres: 0.25,
  sampleCount: 1245,
  start: Object.freeze([-88.0, 1050.0]),
  end: Object.freeze([103.5, 1292.5])
});

/** The long course finishes this far before the measured 310.395 m end. */
export const LONG_FINISH_CLEARANCE_METRES = 10.0;
/** Requested long-course gate half-width (6 m gate line). */
export const LONG_GATE_HALF_WIDTH = 3.0;
/**
 * Off-course respawn band for the long course. P48's exact verifier measured a
 * minimum distance to a steep collision face of 7.7836 m over the whole course,
 * so +/-6 m keeps the band inside that measured wall clearance (a car at the band
 * edge keeps 7.7836 - 6.0 - 1.138 = 0.6456 m to the nearest face).
 */
export const LONG_BAND_HALF_WIDTH_METRES = 6.0;
export const LONG_BAND_SOURCE = Object.freeze({
  minSteepFaceDistanceMetres: 7.7836,
  carHalfWidthMetres: 1.138,
  marginAtBandEdgeMetres: 0.6456,
  note: 'P48 verify.json wall-clearance check (min 7.7836 m at sample 1244); the band is a declared rule, not a measured lane'
});

/** Half-width of every short-course gate, measured from the spawn z. */
export const GATE_BAND_HALF_WIDTH = 3.0;
/** The finish is this far before the last fully covered column. */
export const FINISH_CLEARANCE_METRES = 2.0;
/** Gate x coordinates are snapped to this grid. */
export const GATE_X_GRID = 0.25;
/** Spacing of the coverage samples across a gate line. */
export const GATE_SAMPLE_STEP = 0.1;
/** Spacing of the measured course samples. */
export const SAMPLE_STEP_METRES = 0.25;
/** Tangent window: the gate line is perpendicular to the line over this span. */
export const GATE_TANGENT_WINDOW_METRES = 5.0;
/** Spacing of the covered-column scan along +X. */
export const COLUMN_STEP = 0.25;
/** Checkpoints along the measured span (2 of them: start + 2 CPs + finish). */
export const CHECKPOINT_FRACTIONS = Object.freeze([1 / 3, 2 / 3]);
/** Countdown: 1.5 s, three 0.5 s steps (3, 2, 1) at the fixed 60 Hz tick. */
export const COUNTDOWN_TICKS = 90;
export const COUNTDOWN_STEP_TICKS = 30;

const DRAWN_SECTION_KEY = 'river.block56.node289';

/** Map a key to a finite number of decimals, so hashes are stable across runs. */
const round6 = (value) => Math.round(value * 1e6) / 1e6;

/**
 * Triangles of one track-visual section, in source world space. Only the
 * drive-covering section is accepted: block88/node283 lies three kilometres away
 * and cannot cover a gate, and silently mixing it in would hide that.
 */
export function drawnTriangles(geometry) {
  const track = geometry?.trackVisual;
  if (!track || track.label !== 'asset-reader-direct-draws') {
    throw new Error('geometry does not carry the real track visual; rebuild geometry.json');
  }
  const section = track.sections?.find((entry) => entry.key === DRAWN_SECTION_KEY);
  if (!section) throw new Error('the drive-covering section ' + DRAWN_SECTION_KEY + ' is missing');
  const mesh = geometry.meshes?.find((entry) => entry.id === track.meshId);
  if (!mesh) throw new Error('the track visual mesh ' + track.meshId + ' is missing');
  const draws = track.draws.slice(section.drawIndexRange[0], section.drawIndexRange[1] + 1);
  const triangles = [];
  for (const draw of draws) {
    for (let offset = draw.indexOffset; offset < draw.indexOffset + draw.indexCount; offset += 3) {
      const a = mesh.indices[offset];
      const b = mesh.indices[offset + 1];
      const c = mesh.indices[offset + 2];
      const triangle = [
        [mesh.positions[a * 3], mesh.positions[a * 3 + 1], mesh.positions[a * 3 + 2]],
        [mesh.positions[b * 3], mesh.positions[b * 3 + 1], mesh.positions[b * 3 + 2]],
        [mesh.positions[c * 3], mesh.positions[c * 3 + 1], mesh.positions[c * 3 + 2]]
      ];
      triangles.push(triangle);
    }
  }
  if (triangles.length !== section.triangleCount) {
    throw new Error(DRAWN_SECTION_KEY + ' has ' + triangles.length + ' triangles, record says ' + section.triangleCount);
  }
  return { section, triangles };
}

/** Collision triangles (the surface the wheels trace) from the hidden surface. */
export function collisionTriangles(geometry) {
  const surface = geometry?.collisionSurface;
  if (!surface?.mesh) throw new Error('geometry has no hidden collision surface');
  const mesh = surface.mesh;
  const triangles = [];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset];
    const b = mesh.indices[offset + 1];
    const c = mesh.indices[offset + 2];
    triangles.push([
      [mesh.positions[a * 3], mesh.positions[a * 3 + 1], mesh.positions[a * 3 + 2]],
      [mesh.positions[b * 3], mesh.positions[b * 3 + 1], mesh.positions[b * 3 + 2]],
      [mesh.positions[c * 3], mesh.positions[c * 3 + 1], mesh.positions[c * 3 + 2]]
    ]);
  }
  return triangles;
}

/**
 * Point-in-triangle test in XZ; returns the triangle's height at (x, z) or null.
 * Uses the same plane form as build_geometry.mjs' coverage test so the two
 * measurements agree by construction.
 */
export function heightInTriangle(triangle, x, z) {
  const ax = triangle[0][0], ay = triangle[0][1], az = triangle[0][2];
  const bx = triangle[1][0], by = triangle[1][1], bz = triangle[1][2];
  const cx = triangle[2][0], cy = triangle[2][1], cz = triangle[2][2];
  const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(den) < 1e-12) return null;
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den;
  const l3 = 1 - l1 - l2;
  if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) return null;
  return l1 * ay + l2 * by + l3 * cy;
}

/**
 * X-bucketed triangle index. A gate scan would test 9,824 drawn triangles per
 * sample without it; the buckets keep the derivation fast enough to run in the
 * verifier and stay deterministic (insertion order, no hash of floats).
 */
export class TriangleIndex {
  constructor(triangles, bucketSize = 2) {
    this.bucketSize = bucketSize;
    this.buckets = new Map();
    this.triangles = triangles;
    for (const triangle of triangles) {
      const xs = triangle.map((vertex) => vertex[0]);
      const first = Math.floor(Math.min(...xs) / bucketSize);
      const last = Math.floor(Math.max(...xs) / bucketSize);
      for (let bucket = first; bucket <= last; bucket++) {
        let list = this.buckets.get(bucket);
        if (!list) { list = []; this.buckets.set(bucket, list); }
        list.push(triangle);
      }
    }
  }

  /** Highest triangle height at (x, z), or null when no triangle contains it. */
  heightAt(x, z) {
    const list = this.buckets.get(Math.floor(x / this.bucketSize));
    if (!list) return null;
    let best = null;
    for (const triangle of list) {
      const height = heightInTriangle(triangle, x, z);
      if (height !== null && (best === null || height > best)) best = height;
    }
    return best;
  }

  /** Every triangle containing (x, z), with its height. */
  at(x, z) {
    const list = this.buckets.get(Math.floor(x / this.bucketSize));
    if (!list) return [];
    const hits = [];
    for (const triangle of list) {
      const height = heightInTriangle(triangle, x, z);
      if (height !== null) hits.push({ triangle, height });
    }
    return hits;
  }
}

/** One column across the corridor: every sample must be drawn AND physical. */
export function columnCoverage(columnX, layout, drawn, collision) {
  const { z0, halfWidth } = layout;
  const count = Math.round((2 * halfWidth) / GATE_SAMPLE_STEP) + 1;
  let drawnHits = 0;
  let collisionHits = 0;
  let drawnMin = Infinity, drawnMax = -Infinity;
  let collisionMin = Infinity, collisionMax = -Infinity;
  const missing = [];
  for (let sample = 0; sample < count; sample++) {
    const z = round6(z0 - halfWidth + sample * GATE_SAMPLE_STEP);
    const drawnHeight = drawn.heightAt(columnX, z);
    const collisionHeight = collision.heightAt(columnX, z);
    if (drawnHeight === null) missing.push({ z, missing: 'drawn' });
    else { drawnHits++; drawnMin = Math.min(drawnMin, drawnHeight); drawnMax = Math.max(drawnMax, drawnHeight); }
    if (collisionHeight === null) missing.push({ z, missing: 'collision' });
    else { collisionHits++; collisionMin = Math.min(collisionMin, collisionHeight); collisionMax = Math.max(collisionMax, collisionHeight); }
  }
  return {
    x: round6(columnX),
    samples: count,
    drawnSamples: drawnHits,
    collisionSamples: collisionHits,
    covered: missing.length === 0,
    missing: missing.slice(0, 8),
    drawnHeightRange: drawnHits ? [round6(drawnMin), round6(drawnMax)] : null,
    collisionHeightRange: collisionHits ? [round6(collisionMin), round6(collisionMax)] : null
  };
}

/** Surface-proximity tolerance: a draw must be this close to the collision surface. */
export const SURFACE_TOLERANCE_METRES = 0.5;

/**
 * One gate line A->B on the measured course: every 0.1 m sample must have a real
 * draw triangle within `SURFACE_TOLERANCE_METRES` of the collision surface (P51's
 * track-coverage rule) and a collision triangle under it.
 */
export function lineCoverage(a, b, drawn, collision) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const count = Math.round(length / GATE_SAMPLE_STEP) + 1;
  let drawnHits = 0;
  let collisionHits = 0;
  let drawnMin = Infinity, drawnMax = -Infinity;
  let collisionMin = Infinity, collisionMax = -Infinity;
  let maxDelta = 0;
  const missing = [];
  for (let sample = 0; sample < count; sample++) {
    const t = count === 1 ? 0 : sample / (count - 1);
    const x = round6(a[0] + (b[0] - a[0]) * t);
    const z = round6(a[1] + (b[1] - a[1]) * t);
    const collisionHeight = collision.heightAt(x, z);
    if (collisionHeight === null) {
      missing.push({ x, z, missing: 'collision' });
      continue;
    }
    collisionHits++;
    collisionMin = Math.min(collisionMin, collisionHeight);
    collisionMax = Math.max(collisionMax, collisionHeight);
    // The nearest draw to the collision surface is the road; a bridge or prop
    // above the same point is not a substitute for it.
    let best = null;
    for (const hit of drawn.at(x, z)) {
      const delta = Math.abs(hit.height - collisionHeight);
      if (best === null || delta < best.delta) best = { height: hit.height, delta };
    }
    if (best === null || best.delta > SURFACE_TOLERANCE_METRES) {
      missing.push({ x, z, missing: 'drawn', collisionHeight: round6(collisionHeight),
        nearestDelta: best ? round6(best.delta) : null });
      continue;
    }
    drawnHits++;
    drawnMin = Math.min(drawnMin, best.height);
    drawnMax = Math.max(drawnMax, best.height);
    if (best.delta > maxDelta) maxDelta = best.delta;
  }
  return {
    lengthMetres: round6(length),
    samples: count,
    drawnSamples: drawnHits,
    collisionSamples: collisionHits,
    covered: missing.length === 0,
    toleranceMetres: SURFACE_TOLERANCE_METRES,
    maxSurfaceDeltaMetres: round6(maxDelta),
    missing: missing.slice(0, 8),
    drawnHeightRange: drawnHits ? [round6(drawnMin), round6(drawnMax)] : null,
    collisionHeightRange: collisionHits ? [round6(collisionMin), round6(collisionMax)] : null
  };
}

/** Index of the measured sample nearest an arc length (ties resolve to the lower index). */
export function sampleIndexAtArc(samples, arc) {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < samples.length; index++) {
    const distance = Math.abs(samples[index].arc - arc);
    if (distance < bestDistance - 1e-12) { best = index; bestDistance = distance; }
  }
  return best;
}

/** Index of the last measured sample at or before an arc length. */
export function sampleIndexAtOrBefore(samples, arc) {
  let best = 0;
  for (let index = 1; index < samples.length; index++) {
    if (samples[index].arc <= arc + 1e-9) best = index;
  }
  return best;
}

/** Unit tangent of the measured course at sample `index`, over a window. */
export function tangentAtSample(samples, index, windowMetres = GATE_TANGENT_WINDOW_METRES) {
  const half = Math.max(1, Math.round(windowMetres / 2 / SAMPLE_STEP_METRES));
  const before = samples[Math.max(0, index - half)];
  const after = samples[Math.min(samples.length - 1, index + half)];
  let tx = after.x - before.x;
  let tz = after.z - before.z;
  const length = Math.hypot(tx, tz);
  if (!(length > 1e-9)) throw new Error('course tangent at sample ' + index + ' is degenerate');
  tx /= length; tz /= length;
  return { tx: round6(tx), tz: round6(tz), windowMetres: round6(half * SAMPLE_STEP_METRES * 2) };
}

function snapStraightToGrid(x, grid) {
  return round6(Math.round(x / grid) * grid);
}

function snapDownToGrid(x, grid) {
  return round6(Math.floor(x / grid + 1e-9) * grid);
}

function gateRecord(kind, index, id, x, z0, halfWidth, drawn, collision) {
  const coverage = columnCoverage(x, { z0, halfWidth }, drawn, collision);
  return {
    id,
    kind,
    index,
    x: round6(x),
    z: round6(z0),
    a: [round6(x), round6(z0 - halfWidth)],
    b: [round6(x), round6(z0 + halfWidth)],
    widthMetres: round6(halfWidth * 2),
    coverage
  };
}

/** A gate is never narrower than this, so a car can always pass it. */
export const GATE_MIN_HALF_WIDTH = 2.0;

/**
 * Validate the P48 path artifact and build its 0.25 m arc table. The path is the
 * measured collision-only course; no point is smoothed, rounded (beyond 6 dp for
 * stable hashing) or re-routed here.
 */
export function longCourseSamples(pathDoc, expected = LONG_COURSE_PATH) {
  if (!pathDoc || pathDoc.kind !== 'drivable-path.course' || pathDoc.version !== 1) {
    throw new Error('the long course needs the measured drivable-path.course v1 artifact');
  }
  if (pathDoc.hash !== expected.canonicalHash) {
    throw new Error('the long-course path is not the recorded artifact: ' + pathDoc.hash +
      ' (expected ' + expected.canonicalHash + ')');
  }
  const course = pathDoc.course;
  if (!course || !Array.isArray(course.points) || course.points.length !== expected.sampleCount) {
    throw new Error('the long-course path needs ' + expected.sampleCount + ' samples');
  }
  if (Math.abs(course.length - expected.lengthMetres) > 1e-3) {
    throw new Error('the measured course length ' + course.length + ' m is not ' + expected.lengthMetres + ' m');
  }
  const first = course.points[0];
  const last = course.points[course.points.length - 1];
  if (first[0] !== expected.start[0] || first[1] !== expected.start[1]) {
    throw new Error('the long course does not start at the measured spawn ' + expected.start.join(', '));
  }
  if (last[0] !== expected.end[0] || last[1] !== expected.end[1]) {
    throw new Error('the long course does not end at the measured point ' + expected.end.join(', '));
  }
  const samples = [];
  let arc = 0;
  for (let index = 0; index < course.points.length; index++) {
    const point = course.points[index];
    if (index > 0) {
      arc += Math.hypot(point[0] - course.points[index - 1][0], point[1] - course.points[index - 1][1]);
    }
    if (index > 0 && !(arc > samples[index - 1].arc)) {
      throw new Error('long-course sample ' + index + ' does not advance the arc length');
    }
    samples.push({ index, arc: round6(arc), x: round6(point[0]), z: round6(point[1]) });
  }
  if (Math.abs(arc - expected.lengthMetres) > 1e-3) {
    throw new Error('long-course sample arc ' + arc + ' m differs from ' + expected.lengthMetres + ' m');
  }
  return samples;
}

/**
 * A gate on the measured long course: the point is a measured sample, the line
 * is perpendicular to the local tangent (the left normal), and the coverage is
 * measured at 0.1 m. A gate that is not covered at the requested width narrows
 * symmetrically and records the narrowed width; below the minimum it fails.
 */
function courseGateRecord(kind, index, id, samples, sampleIndex, drawn, collision, requestedHalfWidth) {
  const sample = samples[sampleIndex];
  if (!sample) throw new Error('gate ' + id + ' names a missing course sample ' + sampleIndex);
  const tangent = tangentAtSample(samples, sampleIndex);
  const nx = -tangent.tz;
  const nz = tangent.tx;
  let halfWidth = requestedHalfWidth;
  let coverage = null;
  let measuredHalfWidth = null;
  while (halfWidth >= GATE_MIN_HALF_WIDTH - 1e-9) {
    const a = [round6(sample.x - nx * halfWidth), round6(sample.z - nz * halfWidth)];
    const b = [round6(sample.x + nx * halfWidth), round6(sample.z + nz * halfWidth)];
    coverage = lineCoverage(a, b, drawn, collision);
    if (coverage.covered) { measuredHalfWidth = round6(halfWidth); break; }
    halfWidth = round6(halfWidth - 0.25);
  }
  if (measuredHalfWidth === null) {
    throw new Error('gate ' + id + ' at arc ' + sample.arc + ' is not covered even at ' +
      GATE_MIN_HALF_WIDTH + ' m half-width');
  }
  const a = [round6(sample.x - nx * measuredHalfWidth), round6(sample.z - nz * measuredHalfWidth)];
  const b = [round6(sample.x + nx * measuredHalfWidth), round6(sample.z + nz * measuredHalfWidth)];
  return {
    id,
    kind,
    index,
    sampleIndex,
    arc: round6(sample.arc),
    x: round6(sample.x),
    z: round6(sample.z),
    height: sample.groundY ?? null,
    // e1_create heading: engine local +Z is longitudinal, forward = (sin h, cos h).
    headingRad: round6(Math.atan2(tangent.tx, tangent.tz)),
    tangent,
    widthMetres: round6(measuredHalfWidth * 2),
    requestedWidthMetres: round6(requestedHalfWidth * 2),
    narrowed: measuredHalfWidth < requestedHalfWidth - 1e-9,
    a,
    b,
    coverage
  };
}

/**
 * Derive the default 310 m course layout from the P48 path. `pathDoc` is the
 * parsed `_work/drivable-path/path.json`; the caller pins its file SHA-256.
 */
export function deriveLongCourseLayout(geometry, spawn, pathDoc, options = {}) {
  const clearance = options.finishClearanceMetres ?? LONG_FINISH_CLEARANCE_METRES;
  const requestedHalfWidth = options.gateHalfWidthMetres ?? LONG_GATE_HALF_WIDTH;
  const fractions = options.checkpointFractions ?? CHECKPOINT_FRACTIONS;
  const bandHalfWidth = options.bandHalfWidthMetres ?? LONG_BAND_HALF_WIDTH_METRES;
  if (!(requestedHalfWidth >= GATE_MIN_HALF_WIDTH) || !(clearance >= 0) || !(bandHalfWidth > 0)) {
    throw new Error('long-course layout options are invalid');
  }
  if (!Array.isArray(fractions) || fractions.length !== 2) {
    throw new Error('the long course needs exactly two checkpoint fractions');
  }
  if (!spawn || !Number.isFinite(spawn.x) || !Number.isFinite(spawn.z) || !Number.isFinite(spawn.heading)) {
    throw new Error('sprint layout needs the finite committed spawn');
  }

  const samples = longCourseSamples(pathDoc);
  if (Math.abs(samples[0].x - spawn.x) > 1e-9 || Math.abs(samples[0].z - spawn.z) > 1e-9) {
    throw new Error('the measured long course does not start at the committed spawn');
  }

  const { section, triangles: drawnTrianglesList } = drawnTriangles(geometry);
  const collisionTrianglesList = collisionTriangles(geometry);
  const drawn = new TriangleIndex(drawnTrianglesList);
  const collision = new TriangleIndex(collisionTrianglesList);

  // Measured collision ground on every course sample. A missing triangle is a
  // hard failure: this course is only claimed where the collision mesh exists.
  for (const sample of samples) {
    const ground = collision.heightAt(sample.x, sample.z);
    if (ground === null) {
      throw new Error('no collision triangle under long-course sample ' + sample.index + ' at ' +
        sample.x + ',' + sample.z);
    }
    sample.groundY = round6(ground);
  }

  const length = samples[samples.length - 1].arc;
  const startArc = 0;
  const finishTarget = length - clearance;
  const finishIndex = sampleIndexAtOrBefore(samples, finishTarget);
  const finishArc = samples[finishIndex].arc;
  if (!(finishArc > startArc + 5) || !(finishArc <= finishTarget + 1e-9)) {
    throw new Error('long-course finish arc ' + finishArc + ' is not a valid clearance before ' + length);
  }

  const gateSampleIndexes = [0];
  for (const fraction of fractions) {
    const snapped = sampleIndexAtArc(samples, finishArc * fraction);
    if (!(samples[snapped].arc > samples[gateSampleIndexes[gateSampleIndexes.length - 1]].arc + 0.5) ||
        samples[snapped].arc > finishArc - 0.5) {
      throw new Error('checkpoint fraction ' + fraction + ' snapped out of order at ' + samples[snapped].arc);
    }
    gateSampleIndexes.push(snapped);
  }
  gateSampleIndexes.push(finishIndex);

  const gates = [
    courseGateRecord('start', 0, 'start', samples, gateSampleIndexes[0], drawn, collision, requestedHalfWidth),
    ...gateSampleIndexes.slice(1, -1).map((sampleIndex, index) =>
      courseGateRecord('checkpoint', index + 1, 'checkpoint-' + (index + 1), samples, sampleIndex, drawn,
        collision, requestedHalfWidth)),
    courseGateRecord('finish', gateSampleIndexes.length - 1, 'finish', samples,
      gateSampleIndexes[gateSampleIndexes.length - 1], drawn, collision, requestedHalfWidth)
  ];

  // Re-measured course coverage (start -> finish): a sample is covered when the
  // nearest draw is within the P51 tolerance of the collision surface.
  const inside = samples.filter((sample) => sample.arc <= finishArc + 1e-9);
  const coveredSamples = [];
  let maxSurfaceDelta = 0;
  for (const sample of inside) {
    let best = null;
    for (const hit of drawn.at(sample.x, sample.z)) {
      const delta = Math.abs(hit.height - sample.groundY);
      if (best === null || delta < best) best = delta;
    }
    if (best !== null && best <= SURFACE_TOLERANCE_METRES) {
      coveredSamples.push(sample.index);
      if (best > maxSurfaceDelta) maxSurfaceDelta = best;
    }
  }
  const coveredSet = new Set(coveredSamples);
  const gaps = [];
  let gapStart = null;
  for (const sample of inside) {
    if (!coveredSet.has(sample.index) && gapStart === null) gapStart = sample;
    if (coveredSet.has(sample.index) && gapStart !== null) {
      gaps.push({ startArc: gapStart.arc, endArc: sample.arc });
      gapStart = null;
    }
  }
  if (gapStart !== null) gaps.push({ startArc: gapStart.arc, endArc: finishArc });

  const spawnGroundY = samples[0].groundY;

  // Driver control reference: the measured path is already a visibility-pulled
  // taut line (P48), not a 1 m-grid staircase, so it is used unchanged. The block
  // is kept explicit so the controller has one input shape for both courses.
  const referencePoints = samples.map((sample) => ({
    arc: sample.arc, x: sample.x, z: sample.z, deviation: 0, bandMarginMetres: round6(bandHalfWidth - 1.138)
  }));

  const layout = {
    kind: SPRINT_LAYOUT_KIND,
    version: SPRINT_LAYOUT_VERSION,
    courseId: LONG_COURSE_ID,
    source: {
      geometry: '_work/e1-drive/geometry.json',
      geometryVersion: geometry.version,
      coursePath: LONG_COURSE_PATH.file,
      coursePathCanonicalHash: pathDoc.hash,
      coursePathFileSha256: LONG_COURSE_PATH.fileSha256,
      coursePathVerify: '_work/drivable-path/verify.json',
      coursePathVerifySha256: 'sha256:bfb047e97a8c62afe82c98fc4c5006a2a55fe863e47a21d9f031351b14f98337',
      drawnSection: section.key,
      drawnSectionReference: section.reference,
      drawnSectionReferenceSha256: section.referenceSha256,
      trackVisual: geometry.trackVisual.label,
      spawn: { x: spawn.x, z: spawn.z, headingRad: spawn.heading },
      spawnSource: spawn.source ?? null
    },
    course: {
      rule:
        'the default course follows the P48 collision-only drivable path (310.395 m, 1,245 samples at 0.25 m): ' +
        'every gate sits on a measured sample, its line is perpendicular to the local 5 m tangent, and the ' +
        'finish is ' + clearance + ' m before the measured end so the car can stop before the 2.0 m narrowing',
      name: 'usa_la_river P48 collision-clean course',
      spawn: { x: round6(spawn.x), z: round6(spawn.z), headingRad: spawn.heading },
      spawnGroundY: round6(spawnGroundY),
      start: { x: samples[0].x, z: samples[0].z, arc: 0, groundY: samples[0].groundY },
      finish: {
        x: samples[finishIndex].x, z: samples[finishIndex].z, arc: finishArc,
        groundY: samples[finishIndex].groundY
      },
      measuredEnd: {
        x: samples[samples.length - 1].x, z: samples[samples.length - 1].z,
        arc: length, groundY: samples[samples.length - 1].groundY
      },
      lengthMetres: length,
      finishArc,
      sampleStepMetres: LONG_COURSE_PATH.sampleStepMetres,
      sampleCount: samples.length,
      span: {
        startArc,
        finishArc,
        lengthMetres: round6(finishArc - startArc),
        measuredLengthMetres: length,
        finishClearanceMetres: round6(clearance),
        note:
          'arc lengths are measured along the P48 0.25 m samples; the finish is the last sample at or before ' +
          'measuredEnd - ' + clearance + ' m, and the checkpoints are the two requested fractions of the finish span'
      },
      corridor: {
        rule: 'off-course respawn band is a declared +/-' + bandHalfWidth + ' m around the measured centre line',
        halfWidthMetres: round6(bandHalfWidth),
        source: { ...LONG_BAND_SOURCE }
      },
      coverage: {
        samples: inside.length,
        coveredSamples: coveredSamples.length,
        coverageFraction: round6(coveredSamples.length / inside.length),
        toleranceMetres: SURFACE_TOLERANCE_METRES,
        maxSurfaceDeltaMetres: round6(maxSurfaceDelta),
        gaps,
        gapTotalMetres: round6(gaps.reduce((sum, gap) => sum + (gap.endArc - gap.startArc), 0)),
        rule: 'a sample is covered when the nearest real ' + section.key + ' draw is within ' +
          SURFACE_TOLERANCE_METRES + ' m of the collision surface (P51 track-coverage rule)'
      },
      samples: samples.map((sample) => ({
        arc: sample.arc,
        x: sample.x,
        z: sample.z,
        groundY: sample.groundY,
        covered: coveredSet.has(sample.index)
      })),
      sampling: {
        gateSampleStepMetres: GATE_SAMPLE_STEP,
        tangentWindowMetres: GATE_TANGENT_WINDOW_METRES,
        sampleStepMetres: SAMPLE_STEP_METRES
      },
      reference: {
        rule:
          'driver control reference: the measured P48 path itself (it is already a visibility-pulled taut line, ' +
          'not a staircase); it is a controller aid, not a new road, and the course, gates and progress stay on ' +
          'the measured samples',
        windowMetres: 0,
        carHalfWidthMetres: 1.138,
        maxDeviationMetres: 0,
        minBandMarginMetres: round6(bandHalfWidth - 1.138),
        points: referencePoints
      }
    },
    gates,
    countdown: {
      ticks: COUNTDOWN_TICKS,
      stepTicks: COUNTDOWN_STEP_TICKS,
      labels: ['3', '2', '1'],
      goLabel: 'GO',
      rule: 'input is held at zero until the countdown reaches GO; the timer starts at GO and the car is on the start line'
    },
    rules: {
      tickHz: 60,
      timer: 'elapsed engine ticks from GO at 1/60 s; it keeps running across a respawn and freezes on the finish',
      gateOrder: 'checkpoints count only in index order; a finish crossing is rejected until every checkpoint is passed',
      finishRequiresAllCheckpoints: true,
      progress: 'progress is the arc length of the nearest point on the measured course, clamped to the finish arc',
      respawn: {
        fallBelowGroundMetres: 1.0,
        airborneTicks: 30,
        outsideBandMarginMetres: 1.0,
        overshootMarginMetres: 2.0,
        target: 'the gate point of the last passed checkpoint (the start line before the first checkpoint)',
        rule: 'respawn when the chassis falls more than 1 m below the measured ground at its arc, stays ' +
          'airborne for 30 ticks, or leaves the measured band; the attempt timer keeps running and the last ' +
          'checkpoint is kept'
      },
      limits: [
        'this is one point-to-point sprint on the measured P48 310 m course, not a lap: the source component is a ' +
          'one-way band and the measured end narrows to 2.0 m',
        'gates are rules geometry only; no gate mesh is added to the render packet',
        'no opponents, no AI and no race audio'
      ]
    }
  };
  layout.hash = hashOf(layout);
  return layout;
}

/**
 * Derive the sprint layout. `spawn` is the committed spawn ({x, z, heading});
 * options exist for tests but the committed tool never overrides the corridor.
 */
export function deriveSprintLayout(geometry, spawn, options = {}) {
  const halfWidth = options.bandHalfWidthMetres ?? GATE_BAND_HALF_WIDTH;
  const clearance = options.finishClearanceMetres ?? FINISH_CLEARANCE_METRES;
  const grid = options.gateXGridMetres ?? GATE_X_GRID;
  const fractions = options.checkpointFractions ?? CHECKPOINT_FRACTIONS;
  if (!(halfWidth > 0) || !(clearance >= 0) || !(grid > 0)) {
    throw new Error('sprint layout options are invalid');
  }
  if (!Array.isArray(fractions) || fractions.length < 2 || fractions.length > 3 ||
      fractions.some((fraction) => !(fraction > 0 && fraction < 1))) {
    throw new Error('sprint layout needs two or three checkpoint fractions inside (0, 1)');
  }
  if (!spawn || !Number.isFinite(spawn.x) || !Number.isFinite(spawn.z) || !Number.isFinite(spawn.heading)) {
    throw new Error('sprint layout needs the finite committed spawn');
  }

  const { section, triangles: drawnTrianglesList } = drawnTriangles(geometry);
  const collisionTrianglesList = collisionTriangles(geometry);
  const drawn = new TriangleIndex(drawnTrianglesList);
  const collision = new TriangleIndex(collisionTrianglesList);

  const z0 = spawn.z;
  const startX = spawn.x;

  // Scan +X while the whole gate band is covered. A failure stops the scan: the
  // covered segment is contiguous from the spawn (measured; no gap is expected,
  // and a gap is reported rather than jumped over).
  const columns = [];
  let lastCoveredX = null;
  for (let step = 0; step <= 400; step++) {
    const x = snapStraightToGrid(startX + step * COLUMN_STEP, grid);
    const coverage = columnCoverage(x, { z0, halfWidth }, drawn, collision);
    if (!coverage.covered) {
      columns.push({ ...coverage, covered: false });
      break;
    }
    columns.push(coverage);
    lastCoveredX = x;
  }
  if (lastCoveredX === null) {
    throw new Error('no covered sprint column at the spawn ' + startX + ',' + z0);
  }
  const spanLength = lastCoveredX - startX;
  if (spanLength < 10) {
    throw new Error('covered sprint span is only ' + spanLength.toFixed(2) + ' m; no sprint can be laid out');
  }

  const finishX = snapDownToGrid(lastCoveredX - clearance, grid);
  if (!(finishX > startX + 5)) {
    throw new Error('finish ' + finishX + ' leaves less than 5 m of sprint');
  }

  const gateXs = [startX];
  for (const fraction of fractions) {
    const snapped = snapStraightToGrid(startX + (finishX - startX) * fraction, grid);
    if (!(snapped > gateXs[gateXs.length - 1] + 0.5) || snapped > finishX - 0.5) {
      throw new Error('checkpoint fraction ' + fraction + ' snapped out of order at ' + snapped);
    }
    gateXs.push(snapped);
  }
  gateXs.push(finishX);

  const gates = [
    gateRecord('start', 0, 'start', gateXs[0], z0, halfWidth, drawn, collision),
    ...gateXs.slice(1, -1).map((x, index) =>
      gateRecord('checkpoint', index + 1, 'checkpoint-' + (index + 1), x, z0, halfWidth, drawn, collision)),
    gateRecord('finish', gateXs.length - 1, 'finish', gateXs[gateXs.length - 1], z0, halfWidth, drawn, collision)
  ];
  for (const gate of gates) {
    if (!gate.coverage.covered) {
      throw new Error('gate ' + gate.id + ' at x=' + gate.x + ' is not fully covered');
    }
  }

  // Ground height for the fall rule: the highest collision triangle at the spawn
  // (the same surface the wheel probe hits). The engine's own probe is compared
  // against this by the verifier.
  const spawnGroundY = collision.heightAt(spawn.x, spawn.z);
  if (spawnGroundY === null) throw new Error('no collision triangle at the spawn');

  // Evidence columns every metre along the measured span (all covered).
  const measuredColumns = [];
  for (let x = startX; x <= finishX + 1e-9; x += 1) {
    const rounded = round6(x);
    const coverage = columns.find((column) => Math.abs(column.x - rounded) < 1e-9) ??
      columnCoverage(rounded, { z0, halfWidth }, drawn, collision);
    measuredColumns.push({
      x: rounded,
      covered: coverage.covered,
      drawnSamples: coverage.drawnSamples,
      collisionSamples: coverage.collisionSamples,
      drawnHeightRange: coverage.drawnHeightRange
    });
  }

  const layout = {
    kind: SPRINT_LAYOUT_KIND,
    version: SPRINT_LAYOUT_VERSION,
    courseId: options.courseId ?? SHORT_COURSE_ID,
    source: {
      geometry: '_work/e1-drive/geometry.json',
      geometryVersion: geometry.version,
      drawnSection: DRAWN_SECTION_KEY,
      drawnSectionReference: section.reference,
      drawnSectionReferenceSha256: section.referenceSha256,
      trackVisual: geometry.trackVisual.label,
      spawn: { x: spawn.x, z: spawn.z, headingRad: spawn.heading },
      spawnSource: spawn.source ?? null
    },
    course: {
      rule:
        'the sprint runs on the measured covered segment under the spawn corridor: a column is covered when every ' +
        GATE_SAMPLE_STEP + ' m sample across the gate band has both a real ' + DRAWN_SECTION_KEY +
        ' triangle over it and a collision triangle under it; the finish is the last covered column minus ' +
        clearance + ' m, and the checkpoints are the ' + fractions.length + ' requested fractions of that span',
      spawn: { x: round6(startX), z: round6(z0), headingRad: spawn.heading },
      spawnGroundY: round6(spawnGroundY),
      band: { z: round6(z0), halfWidthMetres: round6(halfWidth), gateWidthMetres: round6(halfWidth * 2) },
      span: {
        startX: round6(startX),
        finishX: round6(finishX),
        lengthMetres: round6(finishX - startX),
        lastFullyCoveredX: round6(lastCoveredX),
        finishClearanceMetres: round6(clearance),
        drawnGroundEndsNote:
          'the last fully covered column is where the committed real draw stops covering the gate band; the ' +
          'finish is placed before it so the car never has to cross a gate line that leaves the drawn road'
      },
      sampling: {
        columnStepMetres: COLUMN_STEP,
        gateSampleStepMetres: GATE_SAMPLE_STEP,
        gateXGridMetres: grid
      },
      columns: measuredColumns
    },
    gates,
    countdown: {
      ticks: COUNTDOWN_TICKS,
      stepTicks: COUNTDOWN_STEP_TICKS,
      labels: ['3', '2', '1'],
      goLabel: 'GO',
      rule: 'input is held at zero until the countdown reaches GO; the timer starts at GO and the car is on the start line'
    },
    rules: {
      tickHz: 60,
      timer: 'elapsed engine ticks from GO at 1/60 s; it keeps running across a respawn and freezes on the finish',
      gateOrder: 'checkpoints count only in index order; a finish crossing is rejected until every checkpoint is passed',
      finishRequiresAllCheckpoints: true,
      respawn: {
        fallBelowGroundMetres: 1.0,
        airborneTicks: 30,
        outsideBandMarginMetres: 1.0,
        overshootMarginMetres: 2.0,
        target: 'the last passed checkpoint gate (the start line before the first checkpoint)',
        rule: 'respawn when the chassis falls more than 1 m below the measured spawn ground, stays airborne for ' +
          '30 ticks, or leaves the gate corridor; the attempt timer keeps running and the last checkpoint is kept'
      },
      limits: [
        'this is one point-to-point sprint on the measured covered segment, not a lap: the real River draws do not cover a lap',
        'gates are rules geometry only; no gate mesh is added to the render packet',
        'no opponents, no AI and no race audio'
      ]
    }
  };
  layout.hash = hashOf(layout);
  return layout;
}

/**
 * Heading the car is created with on the start line. The 310 m course starts on
 * a measured tangent (the committed drive spawn heading pi/2 points across that
 * road); the 29 m regression course keeps the committed spawn heading. This is a
 * start-line convention, not a physics or spawn change.
 */
export function layoutStartHeading(layout, spawn) {
  if (Array.isArray(layout?.course?.samples) && layout.gates?.[0]?.headingRad !== undefined) {
    return layout.gates[0].headingRad;
  }
  return spawn.heading;
}

/**
 * Structural validation used by the page. The verifier additionally re-derives
 * the layout and proves it matches the file byte for byte.
 */
export function validateSprintLayout(layout, geometry, spawn) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!layout || layout.kind !== SPRINT_LAYOUT_KIND) fail('layout kind is not ' + SPRINT_LAYOUT_KIND);
  if (layout?.version !== SPRINT_LAYOUT_VERSION) fail('layout version is not ' + SPRINT_LAYOUT_VERSION);
  if (typeof layout?.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(layout.hash)) fail('layout hash is missing');
  else {
    const body = { ...layout };
    delete body.hash;
    if (hashOf(body) !== layout.hash) fail('layout hash does not match its content (hand-edited sprint.json?)');
  }
  if (geometry && layout?.source?.geometryVersion !== geometry.version) {
    fail('layout was built from geometry v' + layout?.source?.geometryVersion + ', loaded v' + geometry.version);
  }
  if (geometry && layout?.source?.trackVisual !== geometry.trackVisual?.label) {
    fail('layout track visual label does not match the loaded geometry');
  }
  if (spawn && layout?.source?.spawn) {
    for (const axis of ['x', 'z']) {
      if (Math.abs(layout.source.spawn[axis] - spawn[axis]) > 1e-9) {
        fail('layout spawn ' + axis + ' ' + layout.source.spawn[axis] + ' differs from the page spawn ' + spawn[axis]);
      }
    }
    if (Math.abs(layout.source.spawn.headingRad - spawn.heading) > 1e-12) {
      fail('layout spawn heading differs from the page spawn');
    }
  }
  const gates = layout?.gates;
  if (!Array.isArray(gates) || gates.length < 3 || gates.length > 5) {
    fail('layout needs a start, two or three checkpoints and a finish');
  } else {
    if (gates[0].kind !== 'start' || gates[gates.length - 1].kind !== 'finish') fail('layout gate order is not start..finish');
    const checkpoints = gates.filter((gate) => gate.kind === 'checkpoint');
    if (checkpoints.length < 2 || checkpoints.length > 3) fail('layout needs two or three checkpoints');
    const pathCourse = Array.isArray(layout?.course?.samples);
    for (let index = 0; index < gates.length; index++) {
      const gate = gates[index];
      if (gate.index !== index) fail('gate ' + gate.id + ' has index ' + gate.index + ', expected ' + index);
      if (!Number.isFinite(gate.x) || !Number.isFinite(gate.z) ||
          !Array.isArray(gate.a) || !Array.isArray(gate.b)) fail('gate ' + gate.id + ' is malformed');
      if (pathCourse) {
        if (!Number.isFinite(gate.arc) || !Number.isFinite(gate.headingRad)) fail('gate ' + gate.id + ' has no arc/heading');
        if (index > 0 && !(gate.arc > gates[index - 1].arc)) fail('gate ' + gate.id + ' is not ahead of the previous gate');
        if (index > 0) {
          const dot = gate.tangent.tx * (gate.b[0] - gate.a[0]) + gate.tangent.tz * (gate.b[1] - gate.a[1]);
          if (Math.abs(dot) > 0.02) fail('gate ' + gate.id + ' line is not perpendicular to the path tangent');
        }
        if (!(gate.widthMetres >= GATE_MIN_HALF_WIDTH * 2 - 1e-9)) fail('gate ' + gate.id + ' is narrower than the minimum');
      } else {
        if (index > 0 && !(gate.x > gates[index - 1].x)) fail('gate ' + gate.id + ' is not ahead of the previous gate');
      }
      if (gate.coverage?.covered !== true) fail('gate ' + gate.id + ' is not fully covered');
    }
    const span = layout?.course?.span;
    if (pathCourse) {
      if (!span || !(gates[0].arc === span.startArc) || !(gates[gates.length - 1].arc === span.finishArc)) {
        fail('gate arcs do not match the measured span');
      } else if (!(span.finishArc < span.measuredLengthMetres)) {
        fail('the finish is not before the measured course end');
      }
      if (!(layout?.course?.coverage?.coverageFraction >= 0.99)) fail('the measured course coverage is below 99 %');
    } else if (!span || !(gates[0].x === span.startX) || !(gates[gates.length - 1].x === span.finishX)) {
      fail('gate x positions do not match the measured span');
    } else if (!(span.finishX < span.lastFullyCoveredX)) {
      fail('the finish is not before the last fully covered column');
    }
  }
  return { ok: errors.length === 0, errors };
}
