// Corridor survey for the E1 drive slice: the measured 539.81 m River corridor as
// a *survey*, not a race course.
//
// The corridor was measured by P41 (`docs/work/analysis/track-coverage.md`) as the
// longest stretch where a real committed draw sits within 0.5 m of the collision
// surface. That rule says nothing about whether a car can drive it: a 50 m vertical
// cliff face is both drawn and collided, so its cells count as "covered" and the
// measured path can run straight through the wall. This module measures exactly
// that, from the same committed artifacts:
//
//   * the four gates P43 placed on the line (start, two checkpoints, finish),
//     with their coverage re-measured across a 6 m gate line;
//   * every place where a measured path segment crosses a vertical collision face
//     (a cliff), with the face's height and normal;
//   * the first collision-surface rise the box chassis cannot climb (P43's 1 m
//     window rule) and the largest local grade near the end of the course;
//   * the three measured coverage gaps.
//
// The tool and the verifier both call this module; the page never does. Nothing
// here writes a physics value: the survey is derived geometry, and every artefact
// it writes is pinned by its canonical hash.

import { hashOf } from './packet-hash.js';
import { collisionTriangles } from './sprint-layout.js';

export const CORRIDOR_SURVEY_KIND = 'e1-drive.corridor-survey';
export const CORRIDOR_SURVEY_VERSION = 1;

/** The six measured corridor sections (docs/work/analysis/track-coverage.md §4.3). */
export const CORRIDOR_SECTION_KEYS = Object.freeze([
  'river.block56.node289',
  'river.block58.node265',
  'river.block50.node265',
  'river.block71.node209',
  'river.block64.node209',
  'river.block59.node265'
]);

/** Measured corridor totals of those six sections: draws / triangles / vertices. */
export const CORRIDOR_TOTALS = Object.freeze({ draws: 299, triangles: 47790, vertices: 78712 });

/** Gate geometry: 6 m wide, perpendicular to a 5 m path tangent, 2 m finish margin. */
export const GATE_HALF_WIDTH = 3.0;
export const GATE_SAMPLE_STEP = 0.1;
export const GATE_TANGENT_WINDOW_METRES = 5.0;
export const FINISH_CLEARANCE_METRES = 2.0;
export const CHECKPOINT_FRACTIONS = Object.freeze([1 / 3, 2 / 3]);
/** Surface proximity used by the corridor measurement (P41). */
export const SURFACE_TOLERANCE_METRES = 0.5;
/** A vertical face is a triangle whose normal is this close to horizontal. */
export const VERTICAL_NORMAL_Y = 0.2;
/** Only faces taller than this are treated as a cliff (a kerb is not a wall). */
export const MIN_WALL_HEIGHT_METRES = 0.5;
/** The box-chassis climb rule P43 measured: a rise above this in a 1 m window. */
export const CHASSIS_RISE_LIMIT_METRES = 0.05;
export const CHASSIS_RISE_WINDOW_METRES = 1.0;

const round6 = (value) => Math.round(value * 1e6) / 1e6;
const round = (value, decimals = 4) => {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
};

/** The six measured corridor sections from the merged track visual. */
export function corridorSections(geometry) {
  const track = geometry?.trackVisual;
  if (!track || track.label !== 'asset-reader-direct-draws') {
    throw new Error('geometry does not carry the real track visual; rebuild geometry.json');
  }
  const sections = (track.sections ?? []).filter((section) => section.courseOverlap === true);
  if (sections.length !== CORRIDOR_SECTION_KEYS.length) {
    throw new Error('expected ' + CORRIDOR_SECTION_KEYS.length + ' measured corridor sections, found ' +
      sections.length);
  }
  return sections;
}

/** Triangles of those sections, in source world space, from their draw ranges. */
export function corridorTriangles(geometry) {
  const track = geometry.trackVisual;
  const mesh = geometry.meshes?.find((entry) => entry.id === track.meshId);
  if (!mesh) throw new Error('the track visual mesh ' + track.meshId + ' is missing');
  const triangles = [];
  for (const section of corridorSections(geometry)) {
    const draws = track.draws.slice(section.drawIndexRange[0], section.drawIndexRange[1] + 1);
    let count = 0;
    for (const draw of draws) {
      for (let offset = draw.indexOffset; offset < draw.indexOffset + draw.indexCount; offset += 3) {
        const a = mesh.indices[offset];
        const b = mesh.indices[offset + 1];
        const c = mesh.indices[offset + 2];
        triangles.push([
          [mesh.positions[a * 3], mesh.positions[a * 3 + 1], mesh.positions[a * 3 + 2]],
          [mesh.positions[b * 3], mesh.positions[b * 3 + 1], mesh.positions[b * 3 + 2]],
          [mesh.positions[c * 3], mesh.positions[c * 3 + 1], mesh.positions[c * 3 + 2]]
        ]);
        count++;
      }
    }
    if (count !== section.triangleCount) {
      throw new Error(section.key + ' has ' + count + ' triangles, record says ' + section.triangleCount);
    }
  }
  return triangles;
}

/** Point-in-triangle test in XZ; returns the triangle's height at (x, z) or null. */
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

/** X-bucketed triangle index (deterministic: insertion order, no float keys). */
export class TriangleIndex {
  constructor(triangles, bucketSize = 2) {
    this.bucketSize = bucketSize;
    this.buckets = new Map();
    for (const triangle of triangles) {
      const xs = [triangle[0][0], triangle[1][0], triangle[2][0]];
      const first = Math.floor(Math.min(...xs) / bucketSize);
      const last = Math.floor(Math.max(...xs) / bucketSize);
      for (let bucket = first; bucket <= last; bucket++) {
        let list = this.buckets.get(bucket);
        if (!list) { list = []; this.buckets.set(bucket, list); }
        list.push(triangle);
      }
    }
  }

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

/** Unit tangent of the measured course at sample `index`, over a window. */
export function tangentAtSample(course, index, windowMetres = GATE_TANGENT_WINDOW_METRES) {
  const samples = course.samples;
  const half = Math.max(1, Math.round(windowMetres / course.sampleStepMetres));
  const before = samples[Math.max(0, index - half)];
  const after = samples[Math.min(samples.length - 1, index + half)];
  const tx = after.x - before.x;
  const tz = after.z - before.z;
  const length = Math.hypot(tx, tz);
  if (!(length > 1e-9)) throw new Error('course tangent at sample ' + index + ' is degenerate');
  return { tx: round6(tx / length), tz: round6(tz / length) };
}

/** Index of the measured sample nearest an arc length. */
export function sampleIndexAtArc(course, arc) {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < course.samples.length; index++) {
    const distance = Math.abs(course.samples[index].arc - arc);
    if (distance < bestDistance - 1e-12) { best = index; bestDistance = distance; }
  }
  return best;
}

/** Last measured sample at or before an arc length. */
export function sampleIndexAtOrBefore(course, arc) {
  let best = 0;
  for (let index = 1; index < course.samples.length; index++) {
    if (course.samples[index].arc <= arc + 1e-9) best = index;
  }
  return best;
}

/** Coverage of one gate line: every sample needs a draw on the collision surface. */
export function lineCoverage(a, b, drawn, collision) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const count = Math.round(length / GATE_SAMPLE_STEP) + 1;
  let drawnHits = 0;
  let collisionHits = 0;
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
    let best = null;
    for (const hit of drawn.at(x, z)) {
      const delta = Math.abs(hit.height - collisionHeight);
      if (best === null || delta < best.delta) best = { height: hit.height, delta };
    }
    if (best === null || best.delta > SURFACE_TOLERANCE_METRES) {
      missing.push({ x, z, missing: 'drawn' });
      continue;
    }
    drawnHits++;
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
    missing: missing.slice(0, 8)
  };
}

/** One gate: measured sample point, perpendicular 6 m line, re-measured coverage. */
export function surveyGate(kind, index, id, course, sampleIndex, drawn, collision) {
  const sample = course.samples[sampleIndex];
  if (!sample) throw new Error('gate ' + id + ' names a missing course sample ' + sampleIndex);
  const tangent = tangentAtSample(course, sampleIndex);
  const nx = -tangent.tz;
  const nz = tangent.tx;
  const a = [round6(sample.x - nx * GATE_HALF_WIDTH), round6(sample.z - nz * GATE_HALF_WIDTH)];
  const b = [round6(sample.x + nx * GATE_HALF_WIDTH), round6(sample.z + nz * GATE_HALF_WIDTH)];
  const coverage = lineCoverage(a, b, drawn, collision);
  return {
    id,
    kind,
    index,
    sampleIndex,
    arc: round6(sample.arc),
    x: round6(sample.x),
    z: round6(sample.z),
    height: sample.coll ?? null,
    headingRad: round6(Math.atan2(tangent.tx, tangent.tz)),
    tangent,
    widthMetres: round6(GATE_HALF_WIDTH * 2),
    a,
    b,
    coverage
  };
}

/** The four survey gates on the measured line. */
export function surveyGates(course, drawn, collision) {
  const finishArc = course.lengthMetres - FINISH_CLEARANCE_METRES;
  const finishIndex = sampleIndexAtOrBefore(course, finishArc);
  const finish = course.samples[finishIndex];
  const gates = [surveyGate('start', 0, 'start', course, 0, drawn, collision)];
  CHECKPOINT_FRACTIONS.forEach((fraction, offset) => {
    // Fractions of the measured corridor length, exactly as P43 placed them.
    const arc = course.lengthMetres * fraction;
    const index = sampleIndexAtArc(course, arc);
    gates.push(surveyGate('checkpoint', offset + 1, 'checkpoint-' + (offset + 1), course, index, drawn,
      collision));
  });
  gates.push(surveyGate('finish', gates.length, 'finish', course, finishIndex, drawn, collision));
  return { gates, finishArc: round6(finish.arc), finishIndex };
}

const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Triangle normal (unit) and its y component. */
function triangleNormal(triangle) {
  const edge1 = subtract(triangle[1], triangle[0]);
  const edge2 = subtract(triangle[2], triangle[0]);
  const normal = cross(edge1, edge2);
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(length > 1e-9)) return null;
  return { normal: normal.map((value) => value / length), length };
}

/** Vertical faces (|normal.y| <= 0.2) taller than the cliff threshold. */
export function verticalFaces(triangles) {
  const faces = [];
  for (const triangle of triangles) {
    const details = triangleNormal(triangle);
    if (details === null) continue;
    if (Math.abs(details.normal[1]) > VERTICAL_NORMAL_Y) continue;
    const ys = [triangle[0][1], triangle[1][1], triangle[2][1]];
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    if (yMax - yMin < MIN_WALL_HEIGHT_METRES) continue;
    faces.push({ triangle, yMin, yMax, normal: details.normal });
  }
  return faces;
}

/** Segment-triangle intersection (two-sided Moller-Trumbore); returns t or null. */
function segmentHitsTriangle(p0, p1, triangle) {
  const direction = subtract(p1, p0);
  const edge1 = subtract(triangle[1], triangle[0]);
  const edge2 = subtract(triangle[2], triangle[0]);
  const h = cross(direction, edge2);
  const det = dot(edge1, h);
  if (Math.abs(det) < 1e-9) return null;
  const inverse = 1 / det;
  const s = subtract(p0, triangle[0]);
  const u = inverse * dot(s, h);
  if (u < -1e-6 || u > 1 + 1e-6) return null;
  const q = cross(s, edge1);
  const v = inverse * dot(direction, q);
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;
  const t = inverse * dot(edge2, q);
  if (t < -1e-6 || t > 1 + 1e-6) return null;
  return t;
}

/**
 * Every measured path segment that crosses a vertical collision face above the
 * road. The segment is tested at three heights (0.2, 0.6 and 1.2 m above the
 * measured ground), so a face that starts above the wheels still counts.
 */
export function pathWallCrossings(course, faces, heightOffsets = [0.2, 0.6, 1.2]) {
  const crossings = [];
  for (let index = 0; index + 1 < course.samples.length; index++) {
    const a = course.samples[index];
    const b = course.samples[index + 1];
    let best = null;
    for (const face of faces) {
      if (face.yMax < a.coll + 0.05 || face.yMin > a.coll + 1.6) continue;
      for (const offset of heightOffsets) {
        const p0 = [a.x, a.coll + offset, a.z];
        const p1 = [b.x, b.coll + offset, b.z];
        const t = segmentHitsTriangle(p0, p1, face.triangle);
        if (t === null) continue;
        if (best === null || t < best.t) {
          const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
          best = {
            t,
            segmentIndex: index,
            direction: [round6((b.x - a.x) / length), 0, round6((b.z - a.z) / length)],
            arc: round6(a.arc + (b.arc - a.arc) * t),
            x: round6(a.x + (b.x - a.x) * t),
            z: round6(a.z + (b.z - a.z) * t),
            heightOffsetMetres: offset,
            faceHeightMetres: round6(face.yMax - face.yMin),
            faceNormal: face.normal.map(round6),
            faceY: [round6(face.yMin), round6(face.yMax)]
          };
        }
      }
    }
    if (best !== null) crossings.push(best);
  }
  // Collapse consecutive segments of one face crossing into a single record.
  const merged = [];
  for (const crossing of crossings) {
    const last = merged[merged.length - 1];
    if (last && crossing.arc - last.arc < 0.6 && Math.abs(crossing.faceNormal[0] - last.faceNormal[0]) < 1e-6 &&
        Math.abs(crossing.faceNormal[2] - last.faceNormal[2]) < 1e-6) {
      last.arcTo = crossing.arc;
      continue;
    }
    merged.push({ ...crossing, arcTo: crossing.arc });
  }
  return merged;
}

/**
 * The first collision-surface rise the box chassis cannot climb: the P43 rule, a
 * rise above 5 cm inside a 1 m window of measured samples.
 */
export function firstChassisRise(course, limit = CHASSIS_RISE_LIMIT_METRES,
                                 window = CHASSIS_RISE_WINDOW_METRES) {
  const samples = course.samples;
  let worst = { riseMetres: -Infinity };
  for (let index = 0; index < samples.length; index++) {
    const start = samples[index];
    if (typeof start.coll !== 'number') continue;
    let end = start;
    for (let next = index; next < samples.length && samples[next].arc - start.arc <= window + 1e-9; next++) {
      if (typeof samples[next].coll === 'number' && samples[next].coll > end.coll) end = samples[next];
    }
    const rise = end.coll - start.coll;
    if (rise > worst.riseMetres) {
      worst = {
        riseMetres: round6(rise),
        fromArc: round6(start.arc),
        toArc: round6(end.arc),
        from: [round6(start.x), round6(start.z)],
        to: [round6(end.x), round6(end.z)],
        windowMetres: round6(end.arc - start.arc),
        gradePercent: round6(rise / Math.max(1e-6, end.arc - start.arc) * 100)
      };
    }
  }
  const first = [];
  for (let index = 0; index < samples.length; index++) {
    const start = samples[index];
    if (typeof start.coll !== 'number') continue;
    let end = start;
    for (let next = index; next < samples.length && samples[next].arc - start.arc <= window + 1e-9; next++) {
      if (typeof samples[next].coll === 'number' && samples[next].coll > end.coll) end = samples[next];
    }
    if (end.coll - start.coll > limit) {
      first.push({
        arc: round6(start.arc),
        riseMetres: round6(end.coll - start.coll),
        windowMetres: round6(end.arc - start.arc),
        gradePercent: round6((end.coll - start.coll) / Math.max(1e-6, end.arc - start.arc) * 100),
        x: round6(start.x),
        z: round6(start.z)
      });
      break;
    }
  }
  return { worst, firstAboveLimit: first[0] ?? null, limitMetres: limit, windowMetres: window };
}

/** Largest local grade on the measured surface after `fromArc`. */
export function steepestGrade(course, fromArc = 0) {
  let worst = { gradePercent: 0 };
  const samples = course.samples;
  for (let index = 1; index < samples.length; index++) {
    const a = samples[index - 1];
    const b = samples[index];
    if (typeof a.coll !== 'number' || typeof b.coll !== 'number') continue;
    if (b.arc < fromArc) continue;
    const grade = (b.coll - a.coll) / Math.max(1e-6, b.arc - a.arc) * 100;
    if (Math.abs(grade) > Math.abs(worst.gradePercent)) {
      worst = {
        gradePercent: round6(grade),
        fromArc: round6(a.arc),
        toArc: round6(b.arc),
        from: [round6(a.x), round6(a.z)],
        to: [round6(b.x), round6(b.z)]
      };
    }
  }
  return worst;
}

/**
 * Confirm each geometric wall crossing with the engine's own collision trace.
 * `probe(x, y, z, dx, dy, dz, distance)` is the harness' ray query
 * (`e1_ray_probe`). From one, two and three metres before the crossing (on the
 * measured line) it casts rays aimed at the crossing point, plus a 12 degree fan on
 * each side, at three heights. A crossing is solid when a vertical face
 * (|normal.y| <= 0.2) is hit at any of those probes.
 */
export function confirmWallCrossings(course, crossings, probe, backOffs = [3, 2, 1]) {
  if (typeof probe !== 'function') {
    return crossings.map((crossing) => ({ ...crossing, engineProbe: null }));
  }
  const fan = [-0.21, 0, 0.21];
  return crossings.map((crossing) => {
    const hits = [];
    for (const backOff of backOffs) {
      const index = sampleIndexAtArc(course, Math.max(0, crossing.arc - backOff));
      const sample = course.samples[index];
      const dx = crossing.x - sample.x;
      const dz = crossing.z - sample.z;
      const length = Math.hypot(dx, dz);
      if (!(length > 1e-6)) continue;
      const base = Math.atan2(dx, dz);
      const distance = length + 2.5;
      for (const offset of [0.2, 0.6, 1.2]) {
        for (const angle of fan) {
          const heading = base + angle;
          const hit = probe(sample.x, sample.coll + offset, sample.z,
            Math.sin(heading), 0, Math.cos(heading), distance);
          if (hit.hit !== 1) continue;
          if (Math.abs(hit.normal[1]) > VERTICAL_NORMAL_Y) continue;
          if (hit.distance > distance) continue;
          hits.push({
            backOffMetres: backOff,
            fanDegrees: round(angle * 180 / Math.PI, 1),
            heightOffsetMetres: offset,
            distanceMetres: round6(hit.distance),
            totalDistanceMetres: round6(backOff + hit.distance),
            normalY: round6(hit.normal[1]),
            normal: hit.normal.map(round6)
          });
        }
      }
    }
    const nearest = hits.reduce((best, hit) => best === null || hit.totalDistanceMetres < best.totalDistanceMetres
      ? hit : best, null);
    return {
      ...crossing,
      engineProbe: {
        backOffsMetres: backOffs,
        fanDegrees: fan.map((angle) => round(angle * 180 / Math.PI, 1)),
        hits: hits.slice(0, 12),
        nearest,
        solid: hits.length > 0
      }
    };
  });
}

/**
 * Build the survey record. `course` is the pinned `course.json`; `geometry` is the
 * committed geometry with the merged track visual; `spawn` is the committed spawn.
 * `options.probe` is the engine ray query; when it is supplied the wall crossings
 * carry the engine's own confirmation and the course limit is the first solid one.
 */
export function buildCorridorSurvey(geometry, course, spawn, options = {}) {
  const sections = corridorSections(geometry);
  const totals = sections.reduce((sum, section) => ({
    draws: sum.draws + section.drawCount,
    triangles: sum.triangles + section.triangleCount,
    vertices: sum.vertices + section.vertexCount
  }), { draws: 0, triangles: 0, vertices: 0 });
  if (totals.draws !== CORRIDOR_TOTALS.draws || totals.triangles !== CORRIDOR_TOTALS.triangles ||
      totals.vertices !== CORRIDOR_TOTALS.vertices) {
    throw new Error('corridor section totals are not the measured ' + JSON.stringify(CORRIDOR_TOTALS));
  }

  const drawn = new TriangleIndex(corridorTriangles(geometry));
  const collision = new TriangleIndex(collisionTriangles(geometry));
  const faces = verticalFaces(collisionTriangles(geometry));
  const { gates, finishArc, finishIndex } = surveyGates(course, drawn, collision);
  const crossings = confirmWallCrossings(course, pathWallCrossings(course, faces), options.probe ?? null);
  const rise = firstChassisRise(course);
  const grade = steepestGrade(course, course.lengthMetres - 20);
  const firstSolid = crossings.find((crossing) => crossing.engineProbe?.solid === true) ?? null;

  const record = {
    kind: CORRIDOR_SURVEY_KIND,
    version: CORRIDOR_SURVEY_VERSION,
    source: {
      course: '_work/e1-drive/course.json',
      courseHash: course.hash ?? null,
      courseLengthMetres: round6(course.lengthMetres),
      geometry: '_work/e1-drive/geometry.json',
      geometryVersion: geometry.version,
      corridorMap: geometry.source?.track?.trackCoverageMap ?? null,
      corridorMapSha256: geometry.source?.track?.trackCoverageMapSha256 ?? null,
      spawn: { x: round6(spawn.x), z: round6(spawn.z), headingRad: round6(spawn.heading) },
      measurement: 'docs/work/analysis/track-coverage.md (P41): a cell is covered when a committed draw is ' +
        'within 0.5 m of the collision surface'
    },
    corridor: {
      name: 'measured 539.81 m River corridor',
      sections: sections.map((section) => ({
        key: section.key,
        courseMetres: section.courseMetres ?? null,
        drawCount: section.drawCount,
        triangleCount: section.triangleCount,
        vertexCount: section.vertexCount,
        reference: section.reference ?? null,
        referenceSha256: section.referenceSha256 ?? null,
        positionsSha256: section.positionsFloat32LESha256 ?? section.positionsSha256 ?? null,
        indicesSha256: section.indicesUint32LESha256 ?? section.indicesSha256 ?? null
      })),
      totals
    },
    gates,
    finish: {
      arc: finishArc,
      sampleIndex: finishIndex,
      clearanceMetres: round6(course.lengthMetres - finishArc),
      note: 'the finish is the last measured sample before the corridor end minus the clearance; it is a ' +
        'survey marker, not a reachable gate'
    },
    drivability: {
      drivable: false,
      reason: 'the measured path crosses vertical collision faces (cliffs). A face is both drawn and collided, ' +
        'so the coverage rule counts its cells as covered and the measured line can run through the wall. ' +
        'No car can drive through it.',
      courseLimitArc: firstSolid === null ? null : firstSolid.arc,
      courseLimitNote: firstSolid === null
        ? (options.probe ? 'no engine-confirmed solid wall crossing' : 'engine confirmation not run')
        : 'the first measured path segment that crosses a vertical collision face the engine confirms solid',
      solidCrossings: crossings.filter((crossing) => crossing.engineProbe?.solid === true).length,
      wallCrossings: crossings,
      verticalFaces: faces.length,
      chassisRise: rise,
      steepestGradeLast20m: grade,
      gaps: (course.gaps ?? []).map((gap) => ({
        lengthMetres: round6(gap.lengthMetres ?? gap.length ?? 0),
        start: gap.start ?? null,
        end: gap.end ?? null
      }))
    },
    limits: [
      'this is a survey of committed geometry, not a playable course: no race gate, timer or result is claimed',
      'the corridor crosses vertical collision faces; the first measured crossing is the course limit',
      'the box chassis cannot climb the measured section-join rise recorded in chassisRise.firstAboveLimit',
      'coverage (0.5 m draw-to-collision proximity) does not test width, slope, steps or walls'
    ]
  };
  record.hash = hashOf(record);
  return record;
}
